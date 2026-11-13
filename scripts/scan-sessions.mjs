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
import { resolveJobEventTime } from './job-event-time.mjs';

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
  // 用数组 + join 而不是 `out += ch`。
  //
  // 2026-11-01 实测：真实语料里 52,309 条 Bash 命令，最慢的一条 **11.3ms 处理 207 字符**——
  // 那不是正则回溯，是**字符串拼接的 O(n²)**：V8 里每次 += 都可能重新分配。
  // 改成数组累加后同一批命令总耗时从 5894ms 降到 ~3100ms。
  const parts = [];
  let i = 0;
  let plain = '';          // 连续的非引号字符攒起来一次性 push
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch !== '"' && ch !== "'") { plain += ch; i++; continue; }
    if (plain) { parts.push(plain); plain = ''; }
    // 找闭合引号（跳过转义）
    let j = i + 1;
    let closed = false;
    while (j < n) {
      if (s[j] === '\\') { j += 2; continue; }
      if (s[j] === ch) { closed = true; break; }
      j++;
    }
    if (!closed) { parts.push(ch); i++; continue; }   // 未闭合：保留引号继续扫描
    const body = s.slice(i + 1, j);
    parts.push(body.length >= minLen ? `${ch}<str>${ch}` : s.slice(i, j + 1));
    i = j + 1;
  }
  if (plain) parts.push(plain);
  return parts.join('');
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
export function judgeState({ sessionState, waitingFor, calls, gapsMs, now: nowMs }) {
  const now = nowMs ?? Date.now();
  const threshold = heartbeatThreshold(gapsMs);
  const lastCall = calls.length ? calls[calls.length - 1] : null;
  const idleMs = lastCall ? now - lastCall.ts : Infinity;

  // 0. 宿主权威失败信号优先于一切推断
  if (sessionState === 'failed') return { state: 'FAILED', reason: 'host-reported-failed' };

  // 0.5 宿主报 blocked：在等输入（权限确认 / API 恢复 / sandbox），不是失败也不是探索。
  //     必须单独成态：按 EXPLORING 处理会让用户以为它还在干活。
  if (sessionState === 'blocked') return { state: 'BLOCKED', reason: 'host-reported-blocked' };

  // 0.6 宿主报 waiting：**它此刻正在等用户**。这是宿主自己判定的，不是推断。
  //
  //     2026-10-31 逆向 claude.exe 2.1.270 得到判定函数：
  //       if (queuedElicitation) return "input needed";
  //       if (topDialogWaitingFor !== undefined) return topDialogWaitingFor;
  //       if (pendingWorkerRequest) return "worker request";
  //       if (pendingSandboxRequest) return "sandbox request";
  //       if (isShowingLocalJSXCommand && !isResponseStreaming && !delegatedActive) return "dialog open";
  //
  //     在发现这条之前，一个 `waiting / input needed` 的会话会被下面第 1 步判成
  //     `EXPLORING / dormant`——**它 23 天前就该等用户了，而系统说它在睡觉**。
  //     必须排在 dormant 之前：dormant 是「没在做事」，waiting 是「在等你」，
  //     后者信息量更大且可行动，不能被前者盖掉。
  if (sessionState === 'waiting') {
    return {
      state: 'WAITING',
      reason: waitingFor ? `waiting:${waitingFor}` : 'host-reported-waiting',
    };
  }

  // 1. 休眠：长时间无活动，既不是探索也不是失败，只是结束了。
  //    必须排在 host-failed 之后——宿主明确报过 failed 的，不该被时间冲淡。
  if (lastCall && idleMs > DORMANT_MS) {
    return {
      state: 'EXPLORING',
      reason: 'dormant',
      liveness: 'stale',
    };
  }

  // 2. FAILED —— **只信宿主明确报错，不从间隔推断**
  //
  // 这里原本有一条推断：末次间隔超过自适应 p95 且停够 60 秒 → 判 FAILED。
  // 2026-10-31 全语料实测后删掉了。**注意：第一次测量的说法是错的**——
  // 「大间隔之后 3390 次里 3390 次恢复」是同义反复：相邻两次调用的间隔 600 秒，
  // 定义上就意味着第二次调用发生了，100% 必然成立，测的是自己的定义。
  //
  // 正确的问法是「大间隔之后还有没有工具调用」：实测 6308 次大间隔里有 5977 次
  // （94.8%）之后仍有 tool_use。**大间隔之后 95% 的会话还活着。**
  // 真实通知样本 3/3 也是误报（一条通知后 49 秒就恢复）。
  //
  // 原因是语义错误：大间隔只说明「它歇了一会儿」——可能在等 API、跑长命令、
  // 或用户走开了。它不说明进程死了，而 FAILED 的语义是「该重跑了」。
  //
  // 现在是：大间隔的会话仍落 EXPLORING（可能是 dormant），只有宿主
  // jobs.state === 'failed' 才判 FAILED（见上面的第 0 步）。
  // 详见 docs/research/2026-10-31-rollback-executed.md。

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
/** 解析 jsonl。`maxBytes` 控制只读尾部多少字节。
 *
 *  **为什么需要参数而不是写死 4MB**：主 transcript 和子 agent 的需求差一个数量级。
 *  实测本机语料：主 transcript 1.2GB，子 agent 文件 **5.2GB / 3518 个**，
 *  而每个会话最多展开 100 个子文件——最坏情况每会话读 **400MB**。
 *  但子 agent 只需要最近 MAX_CALLS_PER_SESSION 条调用参与判定，
 *  读 4MB 尾部是浪费。给它 512KB 就够，实测覆盖远超 400 条记录。
 */
export function parseJsonl(path, maxBytes = MAX_READ_BYTES) {
  const empty = { records: [], badLines: 0 };
  if (!existsSync(path)) return empty;
  let raw;
  try {
    const size = statSync(path).size;
    if (size > maxBytes) {
      // 真正从尾部按偏移读，而不是先整读再切片：实测单文件可达 59MB
      const buf = Buffer.allocUnsafe(maxBytes);
      const fd = openSync(path, 'r');
      try {
        readSync(fd, buf, 0, maxBytes, size - maxBytes);
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

/**
 * 从 transcript 记录里取「最后一条真实活动的时间戳」。
 *
 * **这是 --days 窗口的唯一判据，不再用文件 mtime。**
 *
 * 为什么不能信 mtime：宿主会往 transcript 尾部追加不含 timestamp 的小记录
 * （`last-prompt` / `custom-title` / `mode` / `cost-state` / `atis-latch` …），
 * 每一次都刷新文件 mtime，但**会话本身一步都没走**。实测（2026-11-05，241 个
 * transcript）：
 *
 *   241 个文件里 **122 个**的 |mtime − 最后一条带时间戳的记录| > 24h；
 *   最大偏差 194.7h(mtime) vs 1637.9h(内部时间) —— **相差 8.4 倍**；
 *   另一个会话 idle=548.7h 而 mtime=4.9h，**相差 112 倍**。
 *
 * 后果不只是「列表里多几条」：一个闲置 23 天的会话因为一次 `mode` 写入而显得
 * 「最近有活动」，于是它的 idle 被算成 5 小时，而它其实已经等了三周。
 *
 * 规则：
 *   1. 从尾部往前找第一条**带 timestamp 字段**的记录，用它。
 *   2. 没有 timestamp 的记录（title / mode / cost-state…）一律跳过——
 *      它们不是活动，只是元数据。
 *   3. 全文件都没有 timestamp（实测 1/241，386 字节的空壳）→ 返回 null，
 *      由调用方标注 `lastActivity: null`，不假装知道。
 *
 * 注意 **不是**取最后一条工具调用：用户提问、助手回答同样是活动。
 * 实测「最后记录 vs 最后工具调用」超过 24h 的只有 3/241，所以这两者几乎等价，
 * 但 lastActivity 的语义应该是「这个会话最后一次有人说话」。
 *
 * @param {Array<object>} records
 * @returns {number|null} epoch ms
 */
export function lastActivityOf(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (!rec || typeof rec !== 'object') continue;
    const raw = rec.timestamp;
    if (typeof raw !== 'string') continue;
    const ts = Date.parse(raw);
    if (Number.isFinite(ts)) return ts;
  }
  return null;
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
  // 会话内部的活动时间：来自 transcript 记录自身的 timestamp，与文件 mtime 无关。
  // 子 agent 的调用也算活动，所以与 allCalls 一起取最大值（见下方 lastActivity）。
  const mainLast = lastActivityOf(mainParsed.records);
  let badLines = mainParsed.badLines;

  // 子 agent：每个独立 transcript，.meta.json 回指父会话。
  // 递归收集以覆盖 subagents/workflows/wf_*/ 这一层（实测占总 transcript 的 37%）。
  const children = [];
  const candidates = collectSubagentFiles(subDir);
  candidates.sort((a, b) => b.mtime - a.mtime);
  const truncated = Math.max(0, candidates.length - MAX_SUBAGENTS);
  for (const cand of candidates.slice(0, MAX_SUBAGENTS)) {
    const agentId = cand.name.replace(/\.jsonl$/, '');
    // 子文件只读尾部 512KB：它只需要最近 MAX_CALLS_PER_SESSION 条调用参与判定。
    // 实测能覆盖远超 400 条记录，而读取量从 4MB 降到 512KB（每会话最多 100 个子文件）。
    const parsed = parseJsonl(cand.path, SUBAGENT_READ_BYTES);
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

  // 会话最后活动时刻 = max(主 transcript 的最后一条记录, 任一子 agent 的最后一次调用)。
  // 子 agent 在跑而主线程暂时没有新记录时，这个会话仍然「在动」——只取主记录会
  // 把它算成静止。反过来，主记录里的提问/回答也是活动，不能只看工具调用。
  let lastActivity = mainLast;
  for (const c of allCalls) {
    if (c.ts > (lastActivity ?? 0)) lastActivity = c.ts;
  }

  return {
    mainPath,
    mainCalls,
    children,
    allCalls,
    gaps: gapsOf(allCalls),
    badLines,
    lastActivity,
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
/** 子 agent 文件只读尾部这么多字节。它们只贡献最近 MAX_CALLS_PER_SESSION 条调用，
 *  读 4MB 是浪费——实测 3518 个子文件共 5.2GB，最坏情况每会话要读 400MB。 */
export const SUBAGENT_READ_BYTES = 512 * 1024;

function findTranscriptRoot() {
  const root = join(homedir(), '.claude', 'projects');
  return existsSync(root) ? root : null;
}

/** 从 ~/.claude/sessions/*.json 读活跃会话（宿主已落盘的权威状态）。
 *
 *  **这里有三个状态，不是两个。** 2026-10-31 逆向 claude.exe 2.1.270 后确认：
 *
 *    var wS = { running: "busy", requires_action: "waiting", idle: "idle" };
 *
 *  `waiting` 是宿主明确判定「正在等用户」的实时状态，由 bVo() 逐个判断产生：
 *
 *    if (appState.queuedElicitation)        return "input needed";
 *    if (appState.topDialogWaitingFor !== undefined) return topDialogWaitingFor;  // "dialog open" / "goal proposal"
 *    if (appState.pendingWorkerRequest)     return "worker request";
 *    if (appState.pendingSandboxRequest)    return "sandbox request";
 *    if (isShowingLocalJSXCommand && !isResponseStreaming && !delegatedActive) return "dialog open";
 *
 *  **本函数此前只读 busy / idle，把 `waiting` 整个漏掉了**，注释还断言「只有 busy/idle」。
 *  实测后果：2026-10-31 有一个会话 `status:"waiting"`, `waitingFor:"input needed"`，
 *  而被 `judgeState` 判成 `EXPLORING / dormant`（「它只是睡了」）。
 *  它当时就在等用户，而系统说它在睡觉。
 *
 *  这是**宿主事实**，不是推断：不需要看 transcript、不需要算 novelty、不需要分类器。
 *  它只在等待发生的那一刻为真，用户一回应就变回 busy/idle —— 正是通知该用的信号。 */
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
        status: o.status,              // busy / waiting / idle
        // state 让 live 与 sessions 两个数组**形状一致**：调用方可以只读一个字段。
        // 2026-11-01 实测：一个 waiting 会话只在 live 里、不在 sessions 里，
        // 而 --json 没有任何字段提示「该读哪个数组」——只读 sessions 的调用方会静默漏掉它。
        state: o.status === 'waiting' ? 'WAITING'
          : o.status === 'failed' ? 'FAILED'
            : o.status === 'blocked' ? 'BLOCKED'
              : o.status === 'busy' ? 'PRODUCING' : 'EXPLORING',
        waitingFor: typeof o.waitingFor === 'string' ? o.waitingFor : null,
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
      // linkScanPath 里的 transcript id 与 state.json 的 sessionId **可能不同**：
      // 实测 a9fa4c62（job.sessionId）对应的 transcript 是 af6779f8。两者都要留，
      // 否则「同一个会话」在 jobs 与 transcript 两个源里看起来是两条。
      const linkMatch = (o.linkScanPath || '').match(/([0-9a-f-]{36})\.jsonl$/);
      const transcriptId = linkMatch ? linkMatch[1] : null;
      // project 目录名从 linkScanPath 反推（…/projects/<dir>/<id>.jsonl），
      // 这样没有 transcript 的 job 也能在列表里显示成可读的项目名。
      const projMatch = (o.linkScanPath || '').replace(/\\/g, '/').match(/\/projects\/([^/]+)\//);
      out.push({
        jobId,
        state: o.state ?? null,          // done / failed / blocked / running / stopped
        detail: o.detail ?? null,
        tempo: o.tempo ?? null,
        linkScanPath: o.linkScanPath ?? null,
        sessionId: o.sessionId ?? null,
        transcriptId,
        // 这个 job 的目录：`resolveJobEventTime` 要读同目录下的 `timeline.jsonl`。
        // 不传它就只能退化到 firstTerminalAt，与 probeJobs 的结果可能不一致。
        jobDir: join(dir, jobId),
        project: projMatch ? projMatch[1] : null,
        // 会话的显示名（bg job 的 -n / --name）。没有 transcript 时这是唯一的可读标识。
        name: typeof o.name === 'string' ? o.name : null,
        cwd: typeof o.cwd === 'string' ? o.cwd : null,
        updatedAt: o.updatedAt ?? null,
        // 宿主写的「首次进入终态」。`resolveJobEventTime` 在 timeline 与
        // request-id 都缺席时用它兜底——没有它，同一件事在 scan 层会被判成
        // 「没有事件时刻」，而 probeJobs 层却算得出来，两路指纹又分叉。
        firstTerminalAt: o.firstTerminalAt ?? null,
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

/**
 * 宿主 job 的 state → 四态。
 *
 * 只映射**需要人处理**的三类：blocked / failed / running。
 * `done` / `stopped` 不补进列表——它们没有可行动信息，补进来只是噪音，
 * 而且会把「全部会话」撑成上百条历史作业。这条边界和 TUI 里
 * `statusToState` 对 sessions/*.json 的处理一致。
 *
 * @param {string|null} jobState
 * @returns {string|null}
 */
export function jobStateToState(jobState) {
  if (jobState === 'blocked') return 'BLOCKED';
  if (jobState === 'failed') return 'FAILED';
  if (jobState === 'running') return 'PRODUCING';
  return null;
}

/**
 * 把「宿主实时状态」摊平成扫描行上的三个字段。
 *
 * 为什么单独成函数：这些字段**不是给人看的**，是 `watch.mjs` 算去重键的原料。
 * 少一个，scan 侧就只能退回 `lastActivity`，而 sessions 侧退到
 * `host:<statusUpdatedAt>` —— 同一次等待两个键，隔十几分钟发两条。
 * 生产 `state.json` 实测两对这种重复（`f932d1d4` / `a80c452d`）。
 * 单独成函数才能被测试直接钉住「字段有没有丢」，而不是等到线上重发才发现。
 *
 * @param {{ status?: string, waitingFor?: string, statusUpdatedAt?: number }|null} live
 * @returns {{ waitingFor: string|null, statusUpdatedAt: number|null }}
 */
export function hostFieldsOf(live) {
  const waitingFor = typeof live?.waitingFor === 'string' ? live.waitingFor : null;
  const at = Number(live?.statusUpdatedAt);
  return { waitingFor, statusUpdatedAt: Number.isFinite(at) && at > 0 ? at : null };
}

/**
 * 从一条宿主 job 记录算出**跨层去重指纹**。返回 `{ fingerprint, anchorSource }` 或 null。
 *
 * 这是「jobs 源」与「scan 源」共用的**唯一**一处实现：`jobToRow`（只有 job 的行）
 * 与主循环里「有 transcript 的 FAILED/BLOCKED 行」都调它。
 * 只要两条路径都调它，`probeJobs` 与 `candidatesFromScan` 对同一次失败就必然同键——
 * 这是跨层去重的全部要求。
 *
 * 拿不到事件时刻时返回 null，**不退回 `updatedAt`**：那是文件重写时刻，
 * 宿主任意一次元数据写入都会把它推到当下（实测差 27.8 天），
 * 用它做键等于给同一件事每次都换一个新键。调用方按 fail-closed 处理。
 *
 * @param {{ hostState: string|undefined, job: object|null }} args
 * @returns {{ fingerprint: string, anchorSource: string }|null}
 */
export function scanCrossLayerFingerprint({ hostState, job }) {
  if (hostState !== 'failed' && hostState !== 'blocked') return null;
  if (!job || !job.jobDir) return null;
  const ev = resolveJobEventTime(job, job.jobDir);
  if (!Number.isFinite(ev.atMs)) return null;
  return { fingerprint: `job:${new Date(ev.atMs).toISOString()}`, anchorSource: `jobs-${ev.source}` };
}

/**
 * 把一个只有宿主 job 记录、没有 transcript 的会话转成列表行。
 *
 * 没有 transcript 就没有 calls / novelty / 心跳 —— 这些字段显式给 null，
 * **不要假装是 0**。calls=0 会被读成「这个会话一次工具都没调用」，
 * 而真相是「我们手里根本没有它的调用记录」。
 *
 * @param {object} job  readJobs() 的一项
 * @param {number} nowMs
 * @returns {object}
 */
export function jobToRow(job, nowMs = Date.now()) {
  const updated = Number.isFinite(Date.parse(job?.updatedAt || '')) ? Date.parse(job.updatedAt) : null;
  const hostState = job?.state ?? null;
  // ── 事件时刻：与 watch.mjs 的 `probeJobs` 走**同一个**解析器 ──
  //
  // 这是跨层去重的关键。以前这里给它 `lastActivity: updated`（文件重写时刻），
  // 而 `probeJobs` 用 timeline / request-id / firstTerminalAt 算事件时刻 ——
  // 同一次失败在 jobs 层与 scan 层得到两个指纹，中间隔过 10 分钟限额就发两条。
  // `updatedAt` 是元数据时间，宿主任意一次重写都会把它推到当下（实测差 27.8 天），
  // 拿它当事件时刻本来也是错的（见 job-event-time.mjs 头注释）。
  const cross = scanCrossLayerFingerprint({ hostState, job });
  return {
    project: job?.project ?? null,
    sessionId: job?.sessionId ?? null,
    hostSessionId: job?.sessionId ?? null,
    transcriptId: job?.transcriptId ?? null,
    // 名字是 bg job 的唯一可读标识（没有 transcript 时 project 也可能为空）
    name: job?.name ?? null,
    lastActivity: updated === null ? null : new Date(updated).toISOString(),
    idleSec: updated === null ? null : Math.round((nowMs - updated) / 1000),
    // 事件时刻与它派生的去重指纹。取不到就留 null，由调用方 fail-closed
    // （`candidatesFromScan` 会退回到 lastActivity，且 anchorSource 会说出来）。
    eventAt: cross ? cross.fingerprint.slice(4) : null,
    eventSource: cross ? cross.anchorSource.replace(/^jobs-/, '') : null,
    eventWhy: cross ? null : 'no-event-time',
    evidenceFingerprint: cross ? cross.fingerprint : null,
    anchorSource: cross ? cross.anchorSource : null,
    calls: null,
    hasTranscript: false,
    subagents: 0,
    subagentsTotal: 0,
    subagentsTruncated: 0,
    subagentsComplete: true,
    maxDepth: 0,
    novelty: null,
    noveltyAll: null,
    hbThresholdSec: null,
    lastGapSec: null,
    state: jobStateToState(hostState),
    reason: hostState === 'blocked' ? 'host-reported-blocked' : `host-reported-${hostState}`,
    liveness: 'host-job',
    hostState,
    jobDetail: job?.detail ?? null,
    tokens: job?.tokens ?? null,
    needs: job?.needs ?? null,
    suggestedReply: job?.suggestedReply ?? null,
    badLines: 0,
    source: 'job',
    lastCallAt: null,
  };
}

/**
 * 把宿主 job 合并进 transcript 结果集。**原地追加，返回追加的条数。**
 *
 * 去重键要处理「同一会话在不同源里 id 不同」这一实测事实：
 *   job a9fa4c62… 的 linkScanPath 指向 transcript af6779f8…，两者是同一个会话。
 * 所以一条 transcript 行同时登记 sessionId / hostSessionId / transcriptId 三个身份，
 * 一个 job 也同时登记自己的 sessionId 与 transcriptId（别名）。任一命中即视为已覆盖。
 *
 * `done` / `stopped` 的 job 不补：它们没有可行动信息，补进来只是噪音。
 *
 * @param {Array<object>} rows  transcript 结果（原地修改）
 * @param {Array<object>} jobs  readJobs() 的输出
 * @param {number} nowMs
 * @returns {number} 追加的条数
 */
export function mergeJobRows(rows, jobs, nowMs = Date.now()) {
  const covered = new Set();
  for (const r of rows) {
    for (const key of [r?.sessionId, r?.hostSessionId, r?.transcriptId]) {
      if (key) covered.add(key);
    }
  }
  let added = 0;
  for (const job of jobs || []) {
    if (!job || !job.sessionId) continue;
    if (covered.has(job.sessionId)) continue;
    if (job.transcriptId && covered.has(job.transcriptId)) continue;
    if (!jobStateToState(job.state)) continue;
    const row = jobToRow(job, nowMs);
    rows.push(row);
    covered.add(job.sessionId);
    if (job.transcriptId) covered.add(job.transcriptId);
    added++;
  }
  return added;
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
  // `--now <ISO>`：**注入时钟**。默认取真实当前时间，行为与以前完全一致。
  //
  // 为什么需要它：扫描输出里的 `idleSec` / `--days` 窗口 / `mergeJobRows` 全部从
  // 「现在」导出。纯命令行看不出问题，但 `runTick` 把 `nowMs` 一路传进来时，
  // 如果 CLU 子进程自己取挂钟，同一轮里两段时间基准就会打架。
  // 更直接的理由是测试：一个「结果随挂钟走动」的扫描器没法被固定时钟复现。
  const nowMs = (() => {
    const i = argv.indexOf('--now');
    if (i >= 0) {
      const t = Date.parse(argv[i + 1] || '');
      if (Number.isFinite(t)) return t;
    }
    return Date.now();
  })();
  const json = args.has('--json');
  const recalibrate = args.has('--recalibrate');
  const projectFilter = (() => {
    const i = argv.indexOf('--project');
    return i >= 0 ? argv[i + 1] : null;
  })();
  const days = (() => {
    const i = argv.indexOf('--days');
    // `--days 0` 与 `--all` 都表示「不限窗口，全部会话」。
    // 为什么需要：用户明确要求「所有会话都要显示」。窗口本身是有用的
    // （全量扫描随语料线性变慢），但**不能有任何会话是「因为没加参数就永远看不见」**。
    if (args.has('--all')) return 0;
    if (i < 0) return 7;
    const n = Number(argv[i + 1]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 7;
  })();
  const unbounded = days === 0;

  const root = findTranscriptRoot();
  if (!root) {
    console.error('无法定位 transcript 根目录：' + join(homedir(), '.claude', 'projects'));
    process.exit(2);
  }

  const cutoff = unbounded ? -Infinity : nowMs - days * 86_400_000;
  const results = [];
  const toolCounts = {};
  const jobs = readJobs();
  const jobBySession = new Map(jobs.filter((j) => j.sessionId).map((j) => [j.sessionId, j]));
  // jobs 里有会话「别名」问题：实测 a9fa4c62 的 state.json 里 sessionId 是 a9fa4c62…，
  // 而 linkScanPath 指向的 transcript 是 af6779f8… —— 同一个会话在两个源里 id 不同。
  // 两条边都建索引，按任一 id 都能找到同一个 job。
  const jobByAlias = new Map();
  for (const j of jobs) {
    if (!j) continue;
    if (j.sessionId) jobByAlias.set(j.sessionId, j);
    if (j.transcriptId) jobByAlias.set(j.transcriptId, j);
  }
  // 宿主的实时状态（含 waiting）按 sessionId 索引，供判定使用。
  // 注意：sessions/*.json 里只有**当前还活着**的会话，历史会话查不到 —— 这是优势不是缺陷：
  // waiting 只在等待发生的那一刻为真，不会像 jobs 的 failed 那样留着陈旧值。
  const liveBySession = new Map(readLiveSessions().filter((s) => s.sessionId).map((s) => [s.sessionId, s]));
  /** 已由 transcript 覆盖的会话 id（含 job 别名）——由 mergeJobRows 自己重建，
   *  这里不再维护第二份集合。 */
  /** 内部活动时间不可知的会话（transcript 全文件无 timestamp）——只统计，不猜 */
  let unknownActivity = 0;
  /** 看到过多少个 transcript 文件（窗口内外都算）。用来说明「检查了什么」。 */
  let transcriptsSeen = 0;

  for (const projectDir of readdirSync(root)) {
    const projectPath = join(root, projectDir);
    if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) continue;
    if (projectDir === 'memory') continue;
    if (projectFilter && !projectDir.toLowerCase().includes(projectFilter.toLowerCase())) continue;

    for (const entry of readdirSync(projectPath)) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.replace(/\.jsonl$/, '');
      const filePath = join(projectPath, entry);
      transcriptsSeen++;

      // ── --days 窗口：按 transcript 内部时间，不按文件 mtime ──────────
      //
      // 旧实现 `if (mtime < cutoff) continue`。实测 mtime 会因宿主写入
      // 不含 timestamp 的元数据记录（last-prompt / custom-title / mode /
      // cost-state …）而被刷新：241 个文件里 122 个的 mtime 与「最后一条真实
      // 活动的记录」相差超过 24 小时，最大相差 8.4 倍（mtime 194.7h vs 内部 1637.9h）。
      // **文件被碰过 ≠ 会话在跑。**
      const scanned = scanSessionDir(join(projectPath, sessionId));
      if (!scanned) continue;

      const lastActivity = scanned.lastActivity;
      if (lastActivity === null) {
        // 整份 transcript 没有一条带时间戳的记录：无法判断它在不在窗口内。
        // 不静默丢弃（那会让「监控看不见」和「它不在窗口内」变成一个样子），
        // 计入 unknownActivity 并在输出里显式说明。
        unknownActivity++;
        continue;
      }
      // 没有任何工具调用也**不是**丢弃的理由：一个会话可能刚开、只在对话。
      // 旧实现 `if (!scanned.allCalls.length) continue` 让它彻底消失。
      // 判定（judgeState）对空 calls 有自己的分支（cold-start），不需要这里预先筛掉。
      if (lastActivity < cutoff) continue;

      if (recalibrate) {
        for (const c of scanned.allCalls) toolCounts[c.name] = (toolCounts[c.name] || 0) + 1;
      }

      // 宿主权威状态：jobs 里的 failed/blocked 与 sessions 里的 waiting
      // 都必须传进去，否则那些分支永远是死的。
      // 用别名索引查：job 的 sessionId 与 transcript 文件名可能不同。
      const job = jobByAlias.get(sessionId);
      const live = liveBySession.get(sessionId);
      const hostState = job?.state === 'failed' ? 'failed'
        : job?.state === 'blocked' ? 'blocked'
          : live?.status === 'waiting' ? 'waiting'
            : undefined;

      const verdict = judgeState({
        sessionState: hostState,
        waitingFor: live?.waitingFor ?? null,
        calls: scanned.allCalls,
        gapsMs: scanned.gaps,
        now: nowMs,
      });

      const lastCall = scanned.allCalls.length ? scanned.allCalls[scanned.allCalls.length - 1] : null;
      const threshold = heartbeatThreshold(scanned.gaps);
      const recent = scanned.allCalls.slice(-WINDOW);

      // ── 跨层指纹：与 watch.mjs 的 `probeJobs` 同源 ──
      //
      // 只有 FAILED / BLOCKED 在这里给指纹：它们的唯一真相是宿主 job 记录，
      // 而 `job-event-time.mjs` 的两个调用方（`probeJobs` 与这里）必须逐字同算法。
      //
      // **WAITING 故意不给**。它的最优锚点是 transcript 里未闭合的
      // `tool_use_id`（`waitingAnchor`），那需要 projectsRoot 与尾部读取，
      // 全部在 `watch.mjs` 的候选层。若这里抢着给一个 `host:<statusUpdatedAt>`，
      // `candidatesFromScan` 会优先采用它、不再去算 wait 锚点 ——
      // 于是 sessions 侧 `wait:call_X`、scan 侧 `host:<ts>`，**跨层又分叉了**。
      // 这正是「统一」最容易做成「局部统一」的地方：两处都能算出指纹，
      // 就必须指定唯一一处负责，另一处只提供原料（这里供 `statusUpdatedAt`）。
      const crossLayer = scanCrossLayerFingerprint({ hostState, job });
      const hostFields = hostFieldsOf(live);

      results.push({
        project: projectDir,
        sessionId,
        // 会话 id 与 transcript 文件名不同时，把宿主 job 的 id 也带上，
        // 否则「同一个会话」在不同数据源里看起来是两条。
        hostSessionId: job?.sessionId ?? null,
        transcriptId: job?.transcriptId ?? null,
        // lastActivity / idleSec 用**内部活动时间**，与 --days 窗口同一个基准。
        lastActivity: new Date(lastActivity).toISOString(),
        idleSec: Math.round((nowMs - lastActivity) / 1000),
        calls: scanned.allCalls.length,
        // 零调用会话必须标出来：calls=0 与「没扫到」在界面上是两件事。
        hasTranscript: true,
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
        // ── 宿主实时字段：**去重键需要它，缺了就必然跨层不同键** ──
        //
        // `candidatesFromScan` 与 `probeWaiting` 对同一次等待必须算出同一个键。
        // 取不到 transcript 锚点时，两边都退化成 `host:<statusUpdatedAt>`——
        // 而 `statusUpdatedAt` 只有 `sessions/*.json` 里有。以前这里不带它，
        // 于是 scan 侧退化到 `lastActivity`（会话最后一次活动时刻），
        // sessions 侧退化到 `host:<statusUpdatedAt>`（状态最后一次变化时刻），
        // **同一次等待两个键 → 两条通知**。生产 `state.json` 实测有两对
        // （f932d1d4 / a80c452d），见 docs/research/2026-11-05-dedup-test-failure.md §5。
        waitingFor: hostFields.waitingFor,
        statusUpdatedAt: hostFields.statusUpdatedAt,
        // 跨层指纹（见上方 crossLayer 的计算）。null 表示这一行没有更强的锚点，
        // 由 `candidatesFromScan` 回退到 `activity:<lastActivity>` —— 那是**已知残留**，
        // 但 anchorSource 会把它说出来，不再假装统一。
        evidenceFingerprint: crossLayer ? crossLayer.fingerprint : null,
        anchorSource: crossLayer ? crossLayer.anchorSource : null,
        liveness: verdict.liveness ?? (threshold ? 'reconstructed' : 'insufficient-sample'),
        hostState: hostState ?? null,
        jobDetail: job?.detail ?? null,
        tokens: job?.tokens ?? null,
        needs: job?.needs ?? null,
        suggestedReply: job?.suggestedReply ?? null,
        badLines: scanned.badLines,
        source: 'transcript',
        lastCallAt: lastCall ? new Date(lastCall.ts).toISOString() : null,
      });
    }
  }

  // ── 第二个来源：宿主 job（~/.claude/jobs/*/state.json）───────────────
  //
  // 有些会话**完全没有 transcript**：实测 7710fbdb（blocked，等 32 天）在全盘
  // 找不到任何 .jsonl，任何 --days 都扫不到它。它的全部事实只在 jobs 里。
  // 行的全集如果只来自 transcript，这类会话就永远不可见——而它们恰恰是
  // 「需要人处理」的那一批。
  //
  // 合并逻辑抽在 mergeJobRows（纯函数）里，因为它必须能被测试：
  // 「id 在不同源里不同」这件事没法靠肉眼确认。
  mergeJobRows(results, jobs, nowMs);

  // idleSec 可能是 null（job 没有 updatedAt）。null 排在最后，不参与比较。
  results.sort((a, b) => (b.idleSec ?? -1) - (a.idleSec ?? -1));
  const live = readLiveSessions();
  // 扫描覆盖度：让调用方能区分「确实没有会话」和「有文件但一条都没认出来」。
  // 一个监控工具把「我没有数据」和「一切正常」显示成同一个词，用户就永远无法信任它。
  const stats = {
    generatedAt: new Date().toISOString(),
    days,
    transcriptsSeen: transcriptsSeen,
    transcriptsInWindow: results.filter((r) => r.source === 'transcript').length,
    transcriptsOutsideWindow: transcriptsSeen - results.filter((r) => r.source === 'transcript').length - unknownActivity,
    transcriptsUnknownTime: unknownActivity,
    jobsSeen: jobs.length,
    jobsAdded: results.filter((r) => r.source === 'job').length,
    liveSeen: live.length,
  };

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
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), days, live, stats, sessions: results }, null, 2));
  } else {
    printHuman(results, live, days, stats);
  }

  const failed = results.filter((r) => r.state === 'FAILED').length;
  process.exit(failed ? 1 : 0);
}

function fmtDur(sec) {
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.round(sec / 60) + 'm';
  return (sec / 3600).toFixed(1) + 'h';
}

/** 描述扫描窗口。`0` 表示不限窗口（--all），不能印成「最近 0 天」——那会被读成「没有窗口」。 */
export function windowLabel(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n === 0) return '全部';
  return `最近 ${n} 天`;
}

function printHuman(results, live, days, stats = {}) {
  const noun = (s) => String(s ?? '').replace(/^[A-Z]--/, '').replace(/-/g, '/');
  console.log(`OmniSight 会话扫描 · ${windowLabel(days)} · ${results.length} 个会话`);
  // 把「检查了什么、数据多新」摆在第一屏。一个监控工具说「0 个会话」时，
  // 用户必须能分辨这是「真的没有」还是「扫了但没认出来」。
  if (Number.isFinite(stats.transcriptsSeen)) {
    const inWin = stats.transcriptsInWindow ?? 0;
    const outWin = stats.transcriptsOutsideWindow ?? 0;
    const unk = stats.transcriptsUnknownTime ?? 0;
    const parts = [`transcript ${stats.transcriptsSeen} 个：窗口内 ${inWin}`];
    if (outWin > 0) parts.push(`窗口外 ${outWin}`);
    if (unk > 0) parts.push(`时间未知 ${unk}`);
    if (stats.jobsSeen) parts.push(`job ${stats.jobsSeen} 个（补入 ${stats.jobsAdded ?? 0}）`);
    console.log(parts.join(' · '));
  }
  // 「时间未知」不是细节：那意味着这些文件里一条带时间戳的记录都没有，
  // 我们无法判断它在不在窗口内。说成「窗口外」会撒谎。
  if (stats.transcriptsUnknownTime > 0) {
    console.log(`⚠ ${stats.transcriptsUnknownTime} 个 transcript 内部没有任何时间戳，无法判定是否在窗口内，未计入`);
  }
  console.log(`liveness: reconstructed（事后重建，非实时上报）`);
  console.log('');

  if (live.length) {
    console.log(`宿主注册的活跃会话 ${live.length} 个：`);
    for (const s of live) {
      const msg = s.canMessage ? '可投递(带来源标注)' : '不可投递';
      // waiting 会话把「在等什么」直接摆在行尾。这是宿主给的实时信号，
      // 也是这份列表里唯一**需要用户立刻行动**的信息，不能藏在详情页里。
      const wait = s.status === 'waiting'
        ? `  ← 正在等你${s.waitingFor ? `（${s.waitingFor}）` : ''}`
        : '';
      console.log(`  ${s.status.padEnd(7)} ${String(s.name || s.sessionId).slice(0, 32).padEnd(34)} ${msg}${wait}`);
    }
    console.log('');
  }

  const order = ['WAITING', 'BLOCKED', 'FAILED', 'STALLED', 'PRODUCING', 'EXPLORING'];
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
