#!/usr/bin/env node
/**
 * scan-sessions.mjs — OmniSight 的「眼睛」。
 *
 * 本脚本是产品第一性原理的唯一承载体：从宿主已落盘的事实中，
 * 重建「哪些会话在跑、跑到哪、有没有卡住」，而不是靠 Agent 自述。
 *
 * 零依赖，只用 Node 内置模块。只读，不写任何文件。
 *
 * 用法：
 *   node scripts/scan-sessions.mjs                    # 全部项目，最近 7 天
 *   node scripts/scan-sessions.mjs --days 2           # 最近 2 天
 *   node scripts/scan-sessions.mjs --project Overwatch # 只扫某个项目
 *   node scripts/scan-sessions.mjs --json             # 机器可读输出
 *   node scripts/scan-sessions.mjs --recalibrate      # 重算 novelty 权重
 *
 * 退出码：0 = 正常；1 = 发现 FAILED 会话；2 = 无法定位 transcript 根目录。
 */

import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// ── 常量（与 docs/spec/state-model.md 一一对应）────────────────────────

const WINDOW = 20;
const STRIDE = 5;
const STALL_THRESHOLD = 0.2;
const STALL_WINDOWS = 3;
const MIN_SAMPLES = 20;
const HB_FLOOR_MS = 120_000;
const HB_CEIL_MS = 900_000;
const HB_CONFIRM_MS = 60_000;

/** 默认权重取自本机 2021 个 transcript 的实测占比，见 state-model.md §3.5。
 *  语料会漂移：`--recalibrate` 可重算（实测三天窗口给出 Bash 0.75，与本值 0.62 差异明显）。 */
const DEFAULT_WEIGHTS = {
  Bash: 0.62, Read: 0.15, Edit: 0.10, Grep: 0.06,
  Write: 0.03, Agent: 0.02, Glob: 0.02,
};

/** 写入类动词：命中即视为产生持久化变更（state-model.md §3.4） */
const WRITE_VERBS = [
  /^tee\b/, /^cp\b/, /^mv\b/, /^rm\b/, /^mkdir\b/, /^touch\b/, /^install\b/,
  /^git (commit|add|merge|rebase|checkout|reset|stash)\b/,
  /^(npm|pnpm|yarn) (install|ci|add)\b/,
  /^pip install\b/,
  /^mvn (package|install|deploy)\b/,
  /^(gradle|gradlew|cargo|go) (build|install)\b/,
  /^claude plugin (install|uninstall)\b/,
];

/** 输出重定向也算持久化变更：echo hi > f、cmd >> f、cmd 2>&1 > f。
 *  故意排除 `2>&1`、`>&2` 这类只重定向到其他流的写法。 */
const REDIRECT_WRITE = /(?<![0-9&])>>?\s*(?!&[0-9])[^\s|;&]/;

/** 读起来像写、实际不是，必须显式排除 */
const READ_LOOKALIKES = /^git (status|log|diff|show|branch|remote|config --get)\b/;

// ── 工具函数 ──────────────────────────────────────────────────────────

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** 用线性扫描剥离引号内的长字符串字面量。
 *
 *  不用正则：`/(["'])(?:\\.|(?!\1).){40,}\1/` 在 `'` + 连续反斜杠这类输入上
 *  会指数回溯（实测 60 个反斜杠 90 秒不返回）。这里改为手写状态机，O(n)。
 */
function stripLongStrings(s, minLen = 40) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch !== '"' && ch !== "'") { out += ch; i++; continue; }
    // 找到对应的闭合引号（跳过转义字符）
    let j = i + 1;
    let closed = false;
    while (j < n) {
      if (s[j] === '\\') { j += 2; continue; }
      if (s[j] === ch) { closed = true; break; }
      j++;
    }
    if (!closed) { out += ch; i++; continue; }        // 未闭合：原样保留引号，继续扫描
    const body = s.slice(i + 1, j);
    out += body.length >= minLen ? `${ch}<str>${ch}` : s.slice(i, j + 1);
    i = j + 1;
  }
  return out;
}

/** Bash 签名归一化：剥离路径、数字、长字符串，避免 novelty 恒为 1（§3.3） */
export function normalizeBash(cmd) {
  if (!cmd) return { verb: '', digest: sha('') };
  let s = String(cmd).trim();
  const verb = (s.split(/\s+/)[0] || '').replace(/^[&|;]+/, '');
  s = stripLongStrings(s);                                 // 长字符串字面量（线性）
  s = s
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, '<path>')          // Windows 绝对路径
    .replace(/(^|\s)\/(?:[\w.-]+\/)+[\w.-]*/g, ' <path>')  // POSIX 绝对路径
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*/g, '<ts>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')                    // 数字（放在时间戳之后）
    .replace(/\s+/g, ' ');
  return { verb, digest: sha(s) };
}

/** 每个工具产生一个签名（§3.2） */
export function signatureOf(name, input) {
  const i = input || {};
  switch (name) {
    case 'Read':  return `read|${i.file_path}|${i.offset ?? ''}|${i.limit ?? ''}`;
    case 'Edit':  return `edit|${i.file_path}|${sha(i.old_string || '')}`;
    case 'Write': return `write|${i.file_path}|${sha(i.content || '')}`;
    case 'Grep':  return `grep|${i.pattern}|${i.path ?? ''}|${i.glob ?? ''}`;
    case 'Glob':  return `glob|${i.pattern}`;
    case 'Agent': return `agent|${i.subagent_type ?? i.description ?? ''}`;
    case 'Bash': {
      const { verb, digest } = normalizeBash(i.command);
      return `bash|${verb}|${digest}`;
    }
    default:      return `${name}|${sha(JSON.stringify(i))}`;
  }
}

/** 是否产生持久化变更（§3.4） */
export function isPersistentChange(name, input) {
  if (name === 'Write' || name === 'Edit') return true;
  if (name !== 'Bash') return false;
  const cmd = String(input?.command || '').trim();
  if (!cmd || READ_LOOKALIKES.test(cmd)) return false;
  return WRITE_VERBS.some((re) => re.test(cmd)) || REDIRECT_WRITE.test(cmd);
}

/** 归一化加权 novelty（§3.5） */
export function noveltyOf(calls, weights = DEFAULT_WEIGHTS) {
  if (!calls.length) return null;
  const byTool = new Map();
  for (const c of calls) {
    if (!byTool.has(c.name)) byTool.set(c.name, []);
    byTool.get(c.name).push(c.sig);
  }
  let num = 0, den = 0;
  for (const [name, sigs] of byTool) {
    const w = weights[name] ?? 0.02;
    const unique = new Set(sigs).size;
    num += w * (unique / sigs.length);
    den += w;
  }
  return den === 0 ? null : num / den;
}

/** 会话自适应心跳阈值（§4.2） */
export function heartbeatThreshold(gapsMs) {
  if (gapsMs.length < MIN_SAMPLES) return null;
  const sorted = [...gapsMs].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return Math.max(HB_FLOOR_MS, Math.min(HB_CEIL_MS, p95));
}

/** 判定 FAILED 要求会话仍在「活跃窗口」内。超过这个时长的会话是休眠，不是失败。
 *  实测反例：某会话空闲 72 小时后末次间隔 515s > p95 120s，被误判 FAILED。 */
const DORMANT_MS = 60 * 60 * 1000;

/** 四态判定，有序互斥，首个命中即返回（§2） */
export function judgeState({ sessionState, calls, gapsMs, now: nowMs }) {
  const now = nowMs ?? Date.now();
  const threshold = heartbeatThreshold(gapsMs);
  const lastCall = calls.length ? calls[calls.length - 1] : null;
  const idleMs = lastCall ? now - lastCall.ts : Infinity;

  // 0. 宿主权威失败信号优先于一切推断
  if (sessionState === 'failed') return { state: 'FAILED', reason: 'host-reported-failed' };

  // 0.5 宿主报 blocked：在等输入（权限确认 / API 恢复 / sandbox），不是失败也不是探索。
  //     必须单独成态：按 EXPLORING 处理会让用户以为它还在干活。
  if (sessionState === 'blocked') return { state: 'BLOCKED', reason: 'host-reported-blocked' };

  // 1. 休眠：长时间无活动，既不是探索也不是失败，只是结束了。
  //    必须排在 host-failed 之后——宿主明确报过 failed 的，不该被时间冲淡。
  if (lastCall && idleMs > DORMANT_MS) {
    return {
      state: 'EXPLORING',
      reason: 'dormant',
      liveness: 'stale',
    };
  }

  // 2. FAILED（推断）
  if (calls.length > 0 && gapsMs.length > 0) {
    const lastGap = gapsMs[gapsMs.length - 1];
    if (threshold && lastGap > threshold && idleMs > threshold + HB_CONFIRM_MS) {
      return { state: 'FAILED', reason: `hb_gap=${Math.round(lastGap / 1000)}s > p95=${Math.round(threshold / 1000)}s` };
    }
  }

  // 2. STALLED —— 需要连续 3 个滑窗都低于阈值
  const windows = [];
  for (let end = calls.length; end - WINDOW >= 0; end -= STRIDE) {
    const slice = calls.slice(end - WINDOW, end);
    const n = noveltyOf(slice);
    if (n !== null) windows.push(n);
    if (windows.length >= STALL_WINDOWS) break;
  }
  if (windows.length >= STALL_WINDOWS && windows.every((n) => n < STALL_THRESHOLD)) {
    const hasWrite = calls.slice(-WINDOW).some((c) => c.persistent);
    if (!hasWrite) return { state: 'STALLED', reason: `novelty=${windows.map((n) => n.toFixed(2)).join(',')}` };
  }

  // 3. PRODUCING
  if (calls.slice(-WINDOW).some((c) => c.persistent)) {
    return { state: 'PRODUCING', reason: 'persistent-change-in-window' };
  }

  // 4. EXPLORING（含冷启动）
  const cold = calls.length < WINDOW;
  return {
    state: 'EXPLORING',
    reason: cold ? 'cold-start' : 'read-only',
    liveness: threshold ? 'reconstructed' : 'insufficient-sample',
  };
}

// ── transcript 解析 ───────────────────────────────────────────────────

/** 从一条 jsonl 记录里抽出 tool_use 调用。
 *  返回 { calls, badLines } —— badLines 是解析失败的行数，
 *  不能挂在数组属性上（会被 slice()/展开丢掉的），见 tasks/dev-findings.md DF-005。
 */
function extractCalls(records) {
  const calls = [];
  for (const rec of records) {
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      calls.push({
        name: block.name,
        input: block.input || {},
        sig: signatureOf(block.name, block.input),
        persistent: isPersistentChange(block.name, block.input),
        ts: Date.parse(rec.timestamp) || 0,
      });
    }
  }
  return calls;
}

/** 解析 jsonl。返回 { records, badLines } —— 坏行数必须随数据一起传递，
 *  不能挂在数组属性上（tailRecords 的 slice 会把它丢掉）。见 DF-005。 */
function parseJsonl(path) {
  const empty = { records: [], badLines: 0 };
  if (!existsSync(path)) return empty;
  let raw;
  try {
    const size = statSync(path).size;
    if (size > MAX_READ_BYTES) {
      // 真正从尾部按偏移读，而不是先整读再切片：实测单文件可达 59MB
      const buf = Buffer.allocUnsafe(MAX_READ_BYTES);
      const fd = openSync(path, 'r');
      try {
        readSync(fd, buf, 0, MAX_READ_BYTES, size - MAX_READ_BYTES);
      } finally {
        closeSync(fd);
      }
      raw = buf.toString('utf8');
      const firstNl = raw.indexOf('\n');
      if (firstNl >= 0) raw = raw.slice(firstNl + 1); // 丢弃可能被截断的首行
    } else {
      raw = readFileSync(path, 'utf8');
    }
  } catch { return empty; }
  const records = [];
  let badLines = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { badLines++; }
  }
  return { records, badLines };
}

/** 只保留末尾 n 条记录，避免为判定一个窗口而解析整个会话 */
function tailRecords(records, n) {
  return records.length > n ? records.slice(-n) : records;
}

/** 递归收集子 agent transcript：直接子文件 + subagents/workflows 下的嵌套。
 *  实测 3220 个 jsonl 中有 1190 个在 workflows/<wf-id>/ 里，只扫直接子文件会漏掉 37%。 */
function collectSubagentFiles(subDir) {
  const out = [];
  if (!existsSync(subDir)) return out;
  for (const f of readdirSync(subDir, { withFileTypes: true })) {
    const full = join(subDir, f.name);
    if (f.isDirectory()) {
      out.push(...collectSubagentFiles(full));
    } else if (f.name.endsWith('.jsonl')) {
      let mtime = 0;
      try { mtime = statSync(full).mtimeMs; } catch { /* 忽略不可读 */ }
      out.push({ path: full, name: f.name, mtime });
    }
  }
  return out;
}

function gapsOf(calls) {
  const gaps = [];
  for (let i = 1; i < calls.length; i++) {
    const d = calls[i].ts - calls[i - 1].ts;
    if (d >= 0) gaps.push(d);
  }
  return gaps;
}

/** 汇总一个会话目录（含其所有子 agent） */
function scanSessionDir(dir) {
  const subDir = join(dir, 'subagents');
  const files = [join(dir + '.jsonl'), join(dir, basename(dir) + '.jsonl')];
  const mainPath = files.find((p) => existsSync(p));
  if (!mainPath) return null;

  const mainParsed = parseJsonl(mainPath);
  const mainRecs = tailRecords(mainParsed.records, MAX_CALLS_PER_SESSION * 3);
  const mainCalls = extractCalls(mainRecs);
  let badLines = mainParsed.badLines;

  // 子 agent：每个独立 transcript，.meta.json 回指父会话。
  // 递归收集以覆盖 subagents/workflows/wf_*/ 这一层（实测占总 transcript 的 37%）。
  const children = [];
  const candidates = collectSubagentFiles(subDir);
  candidates.sort((a, b) => b.mtime - a.mtime);
  const truncated = Math.max(0, candidates.length - MAX_SUBAGENTS);
  for (const cand of candidates.slice(0, MAX_SUBAGENTS)) {
    const agentId = cand.name.replace(/\.jsonl$/, '');
    const parsed = parseJsonl(cand.path);
    badLines += parsed.badLines;
    const metaPath = cand.path.replace(/\.jsonl$/, '.meta.json');
    let meta = {};
    try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { /* 无 meta 不致命 */ }
    children.push({
      agentId,
      agentType: meta.agentType ?? null,
      spawnDepth: meta.spawnDepth ?? null,
      parentToolUseId: meta.toolUseId ?? null,
      calls: extractCalls(tailRecords(parsed.records, MAX_CALLS_PER_SESSION)),
    });
  }

  const allCalls = [...mainCalls];
  for (const c of children) allCalls.push(...c.calls);
  allCalls.sort((a, b) => a.ts - b.ts);

  return {
    mainPath,
    mainCalls,
    children,
    allCalls,
    gaps: gapsOf(allCalls),
    badLines,
    subagentTotal: candidates.length,
    subagentTruncated: truncated,
  };
}

// ── 主流程 ────────────────────────────────────────────────────────────

/** 超过此大小的 transcript 只读尾部：实测单文件可达 197MB */
const MAX_READ_BYTES = 4 * 1024 * 1024;

/** 单个会话最多读多少次调用。四态判定只看最近一个窗口，读全量是浪费。
 *  实测最坏的会话有 199 个子 agent transcript，全量解析要 4 秒；限流后 <100ms。 */
const MAX_CALLS_PER_SESSION = 400;

/** 单个会话最多展开多少个子 agent（按 mtime 取最近）。
 *
 *  不是随手定的数。2026-10-30 在 12 个最坏会话（子 agent 数 518/272/199/188/
 *  169/128/119/108/98/89/80/75）上实测的覆盖率与全量扫描耗时：
 *
 *    cap= 30  23.7%  11.6s      cap=100  72.8%  19.4s
 *    cap= 50  39.4%  16.1s      cap=200  92.7%  24.7s
 *    cap=500  99.7%  41.9s      cap=∞   100.0%  39.6s（12 会话单独计）
 *
 *  四态判定只需要「任一节点有增益 → 整棵树 EXPLORING」，窄采样已足够发现增益；
 *  覆盖率低损害的是**详情页画不全**，不是判定错误。
 *  本机 69 个有子 agent 的会话里，61 个在 100 以内，只有 8 个超过——取 100
 *  只让少数巨无霸变慢。超过时由 subagentsTruncated 显式暴露，不静默。
 */
const MAX_SUBAGENTS = 100;

function findTranscriptRoot() {
  const root = join(homedir(), '.claude', 'projects');
  return existsSync(root) ? root : null;
}

/** 从 ~/.claude/sessions/*.json 读活跃会话（宿主已落盘的权威状态） */
function readLiveSessions() {
  const dir = join(homedir(), '.claude', 'sessions');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const o = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      out.push({
        pid: o.pid,
        sessionId: o.sessionId,
        name: o.name,
        cwd: o.cwd,
        status: o.status,              // busy / idle
        statusUpdatedAt: o.statusUpdatedAt,
        kind: o.kind,
        entrypoint: o.entrypoint,
        canMessage: Boolean(o.messagingSocketPath),
        peerFeatures: o.peerFeatures || [],
      });
    } catch { /* 跳过坏文件 */ }
  }
  return out;
}

/** 读 ~/.claude/jobs/<job-id>/state.json —— 这是唯一带 failed / blocked 的数据源。
 *
 *  三个数据源互不一致（实测）：
 *    jobs/           12 条：done=9 failed=1 blocked=2   ← 唯一有 failed/blocked
 *    claude agents   10 条：blocked=2，其余 state 为空
 *    sessions/        8 条：只有 busy/idle
 *  只读 sessions/ 会让 failed 与 blocked 完全不可见。见 DF-006。
 */
function readJobs() {
  const dir = join(homedir(), '.claude', 'jobs');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const jobId of readdirSync(dir)) {
    const p = join(dir, jobId, 'state.json');
    if (!existsSync(p)) continue;
    try {
      const o = JSON.parse(readFileSync(p, 'utf8'));
      out.push({
        jobId,
        state: o.state ?? null,          // done / failed / blocked / running
        detail: o.detail ?? null,
        tempo: o.tempo ?? null,
        linkScanPath: o.linkScanPath ?? null,
        sessionId: (o.linkScanPath || '').match(/([0-9a-f-]{36})\.jsonl$/)?.[1] ?? null,
        updatedAt: o.updatedAt ?? null,
        // 宿主持有真实 token 计数（不是估算）。ADR-0001 曾断言「预算只能 est:」，
        // 对后台作业这条不成立——实测有 3,475,667 这样的绝对值。
        tokens: typeof o.tokens === 'number' ? o.tokens : null,
        // blocked 会话直接给出「在等什么」与「建议怎么回」，接力草稿不必凭空生成
        needs: typeof o.needs === 'string' ? o.needs : null,
        suggestedReply: typeof o.suggestedReply === 'string' ? o.suggestedReply : null,
      });
    } catch { /* 跳过坏文件 */ }
  }
  return out;
}

/** 统计本机真实的工具分布，用于重估 novelty 权重（§3.5）。
 *  换机器或语料特征变化后跑一次，把输出写回 DEFAULT_WEIGHTS。 */
export function recalibrateWeights(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return null;
  // 只保留 7 个已知工具；其余归入「其它」，按 0.02 的兜底权重处理
  const known = Object.keys(DEFAULT_WEIGHTS);
  const out = {};
  let assigned = 0;
  for (const k of known) {
    const v = counts[k] ?? 0;
    out[k] = v / total;
    assigned += v;
  }
  const other = (total - assigned) / total;
  return { weights: out, otherPct: other * 100, total, samples: Object.keys(counts).length };
}

function main(argv) {
  const args = new Set(argv);
  const json = args.has('--json');
  const recalibrate = args.has('--recalibrate');
  const projectFilter = (() => {
    const i = argv.indexOf('--project');
    return i >= 0 ? argv[i + 1] : null;
  })();
  const days = (() => {
    const i = argv.indexOf('--days');
    return i >= 0 ? Number(argv[i + 1]) || 7 : 7;
  })();

  const root = findTranscriptRoot();
  if (!root) {
    console.error('无法定位 transcript 根目录：' + join(homedir(), '.claude', 'projects'));
    process.exit(2);
  }

  const cutoff = Date.now() - days * 86_400_000;
  const results = [];
  const toolCounts = {};
  const jobs = readJobs();
  const jobBySession = new Map(jobs.filter((j) => j.sessionId).map((j) => [j.sessionId, j]));

  for (const projectDir of readdirSync(root)) {
    const projectPath = join(root, projectDir);
    if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) continue;
    if (projectDir === 'memory') continue;
    if (projectFilter && !projectDir.toLowerCase().includes(projectFilter.toLowerCase())) continue;

    for (const entry of readdirSync(projectPath)) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.replace(/\.jsonl$/, '');
      const filePath = join(projectPath, entry);
      let mtime;
      try { mtime = statSync(filePath).mtimeMs; } catch { continue; }
      if (mtime < cutoff) continue;

      const scanned = scanSessionDir(join(projectPath, sessionId));
      if (!scanned || !scanned.allCalls.length) continue;
      if (recalibrate) {
        for (const c of scanned.allCalls) toolCounts[c.name] = (toolCounts[c.name] || 0) + 1;
      }

      // 宿主权威状态：jobs 里的 failed/blocked 必须传进去，否则那个分支永远是死的
      const job = jobBySession.get(sessionId);
      const hostState = job?.state === 'failed' ? 'failed'
        : job?.state === 'blocked' ? 'blocked'
          : undefined;

      const verdict = judgeState({
        sessionState: hostState,
        calls: scanned.allCalls,
        gapsMs: scanned.gaps,
      });

      const lastCall = scanned.allCalls[scanned.allCalls.length - 1];
      const lastIso = new Date(lastCall.ts).toISOString();
      const threshold = heartbeatThreshold(scanned.gaps);
      const recent = scanned.allCalls.slice(-WINDOW);

      results.push({
        project: projectDir,
        sessionId,
        lastActivity: lastIso,
        idleSec: Math.round((Date.now() - lastCall.ts) / 1000),
        calls: scanned.allCalls.length,
        subagents: scanned.children.length,
        subagentsTotal: scanned.subagentTotal,
        subagentsTruncated: scanned.subagentTruncated,
        // 判定用的是采样还是全量：为 false 时 maxDepth / novelty 只反映被展开的那部分
        subagentsComplete: scanned.subagentTruncated === 0,
        maxDepth: scanned.children.reduce((m, c) => Math.max(m, c.spawnDepth ?? 1), scanned.children.length ? 1 : 0),
        novelty: noveltyOf(recent),
        noveltyAll: noveltyOf(scanned.allCalls),
        hbThresholdSec: threshold ? Math.round(threshold / 1000) : null,
        lastGapSec: scanned.gaps.length ? Math.round(scanned.gaps[scanned.gaps.length - 1] / 1000) : null,
        state: verdict.state,
        reason: verdict.reason,
        liveness: verdict.liveness ?? (threshold ? 'reconstructed' : 'insufficient-sample'),
        hostState: hostState ?? null,
        jobDetail: job?.detail ?? null,
        tokens: job?.tokens ?? null,
        needs: job?.needs ?? null,
        suggestedReply: job?.suggestedReply ?? null,
        badLines: scanned.badLines,
      });
    }
  }

  results.sort((a, b) => b.idleSec - a.idleSec);
  const live = readLiveSessions();

  if (recalibrate) {
    const r = recalibrateWeights(toolCounts);
    if (!r) { console.error('没有可统计的调用，无法重算。'); process.exit(2); }
    if (json) {
      console.log(JSON.stringify({ recalibratedAt: new Date().toISOString(), days, ...r }, null, 2));
    } else {
      console.log(`novelty 权重重估 · 最近 ${days} 天 · ${r.total.toLocaleString()} 次调用\n`);
      console.log('把下面这段写回 scripts/scan-sessions.mjs 的 DEFAULT_WEIGHTS：\n');
      console.log('const DEFAULT_WEIGHTS = {');
      const entries = Object.entries(r.weights);
      for (let i = 0; i < entries.length; i += 2) {
        const pair = entries.slice(i, i + 2).map(([k, v]) => `${k}: ${v.toFixed(2)}`);
        console.log('  ' + pair.join(', ') + (i + 2 < entries.length ? ',' : ''));
      }
      console.log('};\n');
      console.log(`未列入的表外工具占 ${r.otherPct.toFixed(1)}%（按 0.02 兜底权重处理）`);
      if (r.otherPct > 15) {
        console.log('⚠ 表外工具占比偏高，建议把它们加进 DEFAULT_WEIGHTS 再重估一次。');
      }
    }
    process.exit(0);
  }

  if (json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), days, live, sessions: results }, null, 2));
  } else {
    printHuman(results, live, days);
  }

  const failed = results.filter((r) => r.state === 'FAILED').length;
  process.exit(failed ? 1 : 0);
}

function fmtDur(sec) {
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.round(sec / 60) + 'm';
  return (sec / 3600).toFixed(1) + 'h';
}

function printHuman(results, live, days) {
  const noun = (s) => s.replace(/^[A-Z]--/, '').replace(/-/g, '/');
  console.log(`OmniSight 会话扫描 · 最近 ${days} 天 · ${results.length} 个有活动的会话`);
  console.log(`liveness: reconstructed（事后重建，非实时上报）`);
  console.log('');

  if (live.length) {
    console.log(`宿主注册的活跃会话 ${live.length} 个：`);
    for (const s of live) {
      const msg = s.canMessage ? '可投递(带来源标注)' : '不可投递';
      console.log(`  ${s.status.padEnd(5)} ${String(s.name || s.sessionId).slice(0, 32).padEnd(34)} ${msg}`);
    }
    console.log('');
  }

  const order = ['BLOCKED', 'FAILED', 'STALLED', 'PRODUCING', 'EXPLORING'];
  const sorted = [...results].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || b.idleSec - a.idleSec);
  for (const r of sorted) {
    const nov = r.novelty === null ? 'null' : r.novelty.toFixed(2);
    const hb = r.hbThresholdSec ? `${r.lastGapSec}s/${r.hbThresholdSec}s` : 'n/a';
    // 子 agent 被截断时明确标出，不许把不完整的树画成完整的
    const sub = r.subagentsTruncated > 0
      ? `${r.subagents}/${r.subagentsTotal}~`
      : String(r.subagents);
    const bad = r.badLines > 0 ? ` BAD=${r.badLines}` : '';
    const tok = r.tokens ? ` tok=${(r.tokens / 1000).toFixed(0)}k` : '';
    console.log(
      `[${r.state.padEnd(9)}] ${noun(r.project).slice(0, 24).padEnd(26)} ` +
      `calls=${String(r.calls).padStart(5)} sub=${sub.padStart(7)} ` +
      `depth=${r.maxDepth} novelty=${nov.padEnd(4)} hb=${hb.padEnd(11)} idle=${fmtDur(r.idleSec).padEnd(5)} ` +
      `${r.reason}${tok}${bad}`
    );
    // blocked 会话宿主已给出「在等什么」，直接显示，不让用户去翻
    if (r.needs) {
      console.log(`            等待输入：${r.needs.slice(0, 100)}`);
      if (r.suggestedReply) console.log(`            建议回复：${r.suggestedReply.slice(0, 80)}`);
    }
  }

  const counts = {};
  for (const r of results) counts[r.state] = (counts[r.state] || 0) + 1;
  console.log('');
  console.log('汇总：' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('');
  console.log('提示：本脚本只观察，不干预。状态不可由 Agent 自述覆盖，见 docs/spec/state-model.md §2.2。');
}

// 仅在直接执行时运行 main（便于测试 import）
const isDirect = process.argv[1] && /scan-sessions\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isDirect) main(process.argv.slice(2));
