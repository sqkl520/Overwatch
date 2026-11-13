#!/usr/bin/env node
/**
 * probe-evidence-sources.mjs — 「闸门还能从哪些地方拿到读过项目的证据」的取证探针。
 *
 * 只读，不改任何文件，不碰 git。零 npm 依赖，`node scripts/probe-evidence-sources.mjs` 直接跑。
 *
 * ── 它回答什么 ────────────────────────────────────────────────────
 * `pre-write-gate.mjs` 目前的证据只有一条：主 transcript 尾部 1 MB 里的 `Read` 工具调用。
 * `observe-reality-check.mjs` 已实测：真实项目 136 个有写会话里，阈值 3 会拦 27 个，
 * 其中 24 个（88.9%）其实读过项目。本探针逐个候选扩宽判据给出**可复算的语料事实**：
 *
 *   A. 子 agent transcript 在哪、怎么认、能配上多少（两套 id 命名空间）
 *   B. 续接会话的两种判据（文本形态 vs `isCompactSummary`）是否等价
 *   C. 结构性探索（ls/find/git/Glob/Grep）能给出什么强度的证据
 *   D. 闸门在 PreToolUse 时刻能看到的字段与落盘状态
 *
 * ── 它不回答什么 ──────────────────────────────────────────────────
 * 本探针**不从语料推结论**「应该扩宽」。它只输出计数与样本；
 * 「扩宽值不值」是另一件事，见 `docs/research/2026-11-14-widened-evidence-sources.md` §5。
 *
 * ── 语料卫生 ──────────────────────────────────────────────────────
 * `~/.claude/projects/` 下还会混进本仓自己跑测试留下的沙箱会话
 * （`AppData\Local\Temp\*`、`.tmp-analysis/*`、本探针的 `ow-a1-*`）。
 * `--exclude-sandbox` 默认开，把它们剔出统计，否则数字会被自己的实验污染。
 *
 * 用法：
 *   node scripts/probe-evidence-sources.mjs                # 全部四节
 *   node scripts/probe-evidence-sources.mjs --json         # 机器可读
 *   node scripts/probe-evidence-sources.mjs --section A    # 只跑一节（A/B/C/D）
 *   node scripts/probe-evidence-sources.mjs --root <dir>   # 换语料根
 *   node scripts/probe-evidence-sources.mjs --no-exclude-sandbox
 *   node scripts/probe-evidence-sources.mjs --samples 5    # 每类样本条数上限
 *
 * 退出码：0 正常；2 找不到 transcript 根目录。
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

export const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** 默认语料根：宿主写 transcript 的地方。 */
export function defaultRoot() {
  return join(homedir(), '.claude', 'projects');
}

/** 本仓自己的实验沙箱。混进真实项目统计会把误拦率凭空抬高。
 *
 *  判据**刻意与 `observe-reality-check.mjs` 的 `isSandbox()` 同源**，这样本探针的
 *  分母能与它报的「真实项目 232 / 有写 136」直接对话；不额外收窄，否则两边数字
 *  对不上却看不出是口径不同。
 *
 *  注意 slug 与 cwd **两边都要看**：transcript 的落盘路径把 cwd 编码成 slug
 *  （`C--Users-Administrator-AppData-Local-Temp-foo`），里面没有 `/Temp/` 这个片段，
 *  只测路径会漏掉全部沙箱会话。 */
export const SANDBOX_RE = /[\\/]Temp[\\/]|\.tmp-analysis/i;
export const SANDBOX_SLUG_RE = /^[A-Za-z]--Users-Administrator-AppData-Local-Temp|Overwatch--tmp-analysis/i;

export function isSandbox(cwd, slug) {
  return SANDBOX_RE.test(String(cwd || '')) || SANDBOX_SLUG_RE.test(String(slug || ''));
}

/** 从 transcript 文本里取会话 cwd。只看**前 64 KB**：cwd 在第一条带它的记录上，
 *  全文件扫是纯浪费；取不到就返回空串，由 slug 兜底。 */
export function cwdOf(text) {
  let found = '';
  eachRecord(String(text || '').slice(0, 64 * 1024), (rec) => {
    if (found) return;
    if (typeof rec?.cwd === 'string' && rec.cwd) found = rec.cwd;
  });
  return found;
}

/** 闸门认的读：`Read`/`NotebookRead` 与 shell 的整份读动词（与 pre-write-gate.mjs 同源）。 */
export const GATE_READ_VERBS = Object.freeze(['cat', 'head', 'tail', 'type', 'get-content', 'gc', 'more']);

/** 结构性探索：看过目录结构 / 搜索过 / 看过版本历史。闸门不认。 */
export const STRUCT_VERBS = Object.freeze(['ls', 'dir', 'find', 'grep', 'rg', 'fd', 'tree', 'stat', 'du', 'git', 'file']);

/** 宿主写的续接摘要前缀（observe-reality-check.mjs 的 CONTINUATION_RE 同源）。 */
export const CONTINUATION_RE = /^This session is being continued from a previous conversation|^This session is a continuation|^<summary>|^Conversation summary|^以下是压缩/i;

// ── 语料发现 ─────────────────────────────────────────────────────────

/** 主 transcript：`<root>/<slug>/<sessionId>.jsonl`。`subagents/` 目录不计入。 */
export function listMainTranscripts(root = defaultRoot()) {
  const out = [];
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files;
    try { files = readdirSync(join(root, d.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(root, d.name, f);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (!st.isFile()) continue;
      out.push({ slug: d.name, sessionId: f.slice(0, -6), path: p, bytes: st.size });
    }
  }
  return out;
}

/** 会话目录下的子 agent 文件。返回 `{dir, bodies[], metas[]}`；目录不存在时 `dir=null`。 */
export function subagentDirOf(mainPath) {
  const dir = join(String(mainPath).replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(dir)) return { dir: null, bodies: [], metas: [] };
  let ents = [];
  try { ents = readdirSync(dir); } catch { return { dir: null, bodies: [], metas: [] }; }
  return {
    dir,
    bodies: ents.filter((e) => e.endsWith('.jsonl')).map((e) => join(dir, e)),
    metas: ents.filter((e) => e.endsWith('.meta.json')).map((e) => join(dir, e)),
  };
}

/** 有界读尾部。闸门自己就是这么读的，探针用同一口径才比得了。 */
export function readTail(path, bytes) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const want = Math.max(0, Math.min(size, bytes));
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, size - want + got);
      if (n <= 0) break;
      got += n;
    }
    let text = buf.subarray(0, got).toString('utf8');
    if (got >= want) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 逐行解析，回调给出 `(record, byteOffset)`。坏行跳过。 */
export function eachRecord(text, onRecord, { baseOffset = 0 } = {}) {
  let off = baseOffset;
  for (const line of String(text || '').split('\n')) {
    const start = off;
    off += Buffer.byteLength(line, 'utf8') + 1;
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    onRecord(rec, start);
  }
}

/** 从一批记录里抽 `tool_use` 块。 */
export function toolUsesOf(records) {
  const out = [];
  for (const r of records) {
    const c = r?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b && b.type === 'tool_use') out.push({ name: String(b.name || ''), id: b.id ? String(b.id) : null, input: b.input && typeof b.input === 'object' ? b.input : {} });
    }
  }
  return out;
}

/** 闸门判据认的读路径（与 `readTranscriptReads` 的内部循环同构）。 */
export function gateReadPaths(text) {
  const seen = new Set();
  const out = [];
  eachRecord(text, (rec) => {
    for (const tu of toolUsesOf([rec])) {
      const paths = gateReadsFromToolUse(tu.name, tu.input);
      for (const p of paths) {
        const k = pathKey(p);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(p);
      }
    }
  });
  return out;
}

export function gateReadsFromToolUse(name, input) {
  const out = [];
  if (name === 'Read' || name === 'NotebookRead') {
    const v = input?.file_path || input?.notebook_path || input?.path;
    if (v) out.push(String(v));
    return out;
  }
  if (name !== 'Bash' && name !== 'PowerShell') return out;
  const cmd = typeof input?.command === 'string' ? input.command : '';
  if (!cmd) return out;
  for (const seg of cmd.split(/[;|&\n]/)) {
    const t = seg.trim().split(/\s+/);
    let i = 0;
    while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++;
    const verb = basename(String(t[i] || '')).replace(/\.exe$/i, '').toLowerCase();
    if (!GATE_READ_VERBS.includes(verb)) continue;
    for (const a of t.slice(i + 1)) {
      if (/^-/.test(a)) continue;
      out.push(/^["']|["']$/.test(a) ? a.replace(/^["']|["']$/g, '') : a);
      break;
    }
  }
  return out;
}

export function pathKey(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

// ── A：子 agent transcript ───────────────────────────────────────────

/** `toolUseId` 的命名空间。两套并存，判据不能假设只有一套。 */
export function idNamespace(id) {
  const s = String(id || '');
  if (!s) return 'empty';
  if (s.startsWith('toolu_bdrk')) return 'toolu_bdrk';
  if (s.startsWith('toolu_')) return 'toolu_anthropic';
  if (s.startsWith('chatcmpl')) return 'chatcmpl';
  if (s.startsWith('tooluse_')) return 'tooluse_';
  if (/^call_\d\d_/.test(s)) return 'call_NN';
  if (/^call_/.test(s)) return 'call_other';
  return 'other';
}

/** 会话目录里 Agent 调用的 tool_use id 集合（主线程那一侧）。 */
export function agentToolUseIds(mainText) {
  const ids = new Set();
  eachRecord(mainText, (rec) => {
    for (const tu of toolUsesOf([rec])) {
      if (tu.name.toLowerCase() !== 'agent' || !tu.id) continue;
      ids.add(tu.id);
    }
  });
  return ids;
}

/** 主 transcript 里 `toolUseResult.agentId` 的集合（**另一套**命名空间：agent id，不是 tool_use id）。 */
export function agentIdsFromResults(mainText) {
  const ids = new Set();
  eachRecord(mainText, (rec) => {
    const v = rec?.toolUseResult?.agentId;
    if (v) ids.add(String(v));
  });
  return ids;
}

/** A 节：子 agent 目录、meta、两套 id 的配对率。 */
export function sectionA(root = defaultRoot(), opts = {}) {
  const { excludeSandbox = true, samples = 3 } = opts;
  const out = {
    mainTranscripts: 0, sessionsWithSubDir: 0,
    subBodies: 0, subMetas: 0,
    metaToolUseIdMatched: 0, metaToolUseIdUnmatched: 0,
    metaNamespace: {}, metaUnmatchedNamespace: {},
    bodyAgentIdMatched: 0, bodyAgentIdUnmatched: 0,
    agentToolUseCalls: 0, toolUseResultWithAgentId: 0,
    agentResultSessions: 0,
    examples: [], unmatchedExamples: [],
  };
  for (const m of listMainTranscripts(root)) {
    const text = readFileSync(m.path, 'utf8');
    if (excludeSandbox && isSandbox(cwdOf(text), m.slug)) continue;
    out.mainTranscripts++;
    const tuIds = agentToolUseIds(text);
    const aIds = agentIdsFromResults(text);
    out.agentToolUseCalls += tuIds.size;
    out.toolUseResultWithAgentId += aIds.size;
    if (aIds.size) out.agentResultSessions++;
    const sd = subagentDirOf(m.path);
    if (!sd.dir) continue;
    out.sessionsWithSubDir++;
    const bodyIds = new Set(sd.bodies.map((p) => basename(p).replace(/^agent-/, '').replace(/\.jsonl$/, '')));
    for (const p of sd.bodies) {
      out.subBodies++;
      const id = basename(p).replace(/^agent-/, '').replace(/\.jsonl$/, '');
      if (aIds.has(id)) out.bodyAgentIdMatched++;
      else {
        out.bodyAgentIdUnmatched++;
        if (out.unmatchedExamples.length < samples) {
          out.unmatchedExamples.push({ sessionId: m.sessionId.slice(0, 8), agentId: id.slice(0, 8), reason: 'agentId not in this transcript' });
        }
      }
    }
    for (const p of sd.metas) {
      out.subMetas++;
      let meta = null;
      try { meta = JSON.parse(readFileSync(p, 'utf8')); } catch { /* ignore */ }
      const tid = String(meta?.toolUseId ?? '');
      const ns = idNamespace(tid);
      out.metaNamespace[ns] = (out.metaNamespace[ns] || 0) + 1;
      if (tid && tuIds.has(tid)) {
        out.metaToolUseIdMatched++;
        if (out.examples.length < samples) {
          out.examples.push({
            sessionId: m.sessionId.slice(0, 8),
            agentFile: basename(p).slice(0, 18),
            namespace: ns,
            agentType: meta?.agentType ?? null,
            spawnDepth: meta?.spawnDepth ?? null,
          });
        }
      } else {
        out.metaToolUseIdUnmatched++;
        out.metaUnmatchedNamespace[ns] = (out.metaUnmatchedNamespace[ns] || 0) + 1;
      }
    }
    if (bodyIds.size === 0) { /* 空目录：B2 归因会退化成「无法证实也无法证伪」 */ }
  }
  out.metaMatchRate = out.subMetas ? +(out.metaToolUseIdMatched / out.subMetas * 100).toFixed(2) : null;
  out.bodyMatchRate = out.subBodies ? +(out.bodyAgentIdMatched / out.subBodies * 100).toFixed(2) : null;
  return out;
}

// ── B：续接会话 ─────────────────────────────────────────────────────

/** B 节：两种续接判据在每份主 transcript 上是否给出同一答案。 */
export function sectionB(root = defaultRoot(), opts = {}) {
  const { excludeSandbox = true, samples = 5 } = opts;
  const out = {
    mainTranscripts: 0,
    textContinuation: 0, flagContinuation: 0, both: 0, onlyText: 0, onlyFlag: 0, neither: 0,
    anyCompactFlag: 0,
    firstHumanSummaryOffset: { min: null, p50: null, max: null, over1MB: 0 },
    uniqueFirstHumanKeys: {},
    samples: [],
  };
  const offsets = [];
  for (const m of listMainTranscripts(root)) {
    const text = readFileSync(m.path, 'utf8');
    if (excludeSandbox && isSandbox(cwdOf(text), m.slug)) continue;
    out.mainTranscripts++;
    let firstHuman = null;
    let firstHumanFlag = null;
    let anyFlag = false;
    let off = 0;
    for (const line of text.split('\n')) {
      const start = off;
      off += Buffer.byteLength(line, 'utf8') + 1;
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.isCompactSummary) anyFlag = true;
      if (firstHuman !== null) continue;
      if (rec.type !== 'user') continue;
      const c = rec?.message?.content;
      const isToolResult = Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
      const t = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('') : '');
      if (isToolResult || !t.trim()) continue;
      firstHuman = t.trim();
      firstHumanFlag = Boolean(rec.isCompactSummary);
      for (const k of Object.keys(rec)) out.uniqueFirstHumanKeys[k] = (out.uniqueFirstHumanKeys[k] || 0) + 1;
      if (firstHumanFlag) offsets.push(start);
    }
    if (anyFlag) out.anyCompactFlag++;
    const byText = firstHuman ? CONTINUATION_RE.test(firstHuman) : false;
    const byFlag = firstHumanFlag === true;
    if (byText) out.textContinuation++;
    if (byFlag) out.flagContinuation++;
    if (byText && byFlag) out.both++;
    else if (byText && !byFlag) {
      out.onlyText++;
      if (out.samples.length < samples) out.samples.push({ sessionId: m.sessionId.slice(0, 8), why: 'text-only', head: String(firstHuman || '').slice(0, 80) });
    } else if (!byText && byFlag) {
      out.onlyFlag++;
      if (out.samples.length < samples) out.samples.push({ sessionId: m.sessionId.slice(0, 8), why: 'flag-only', head: String(firstHuman || '').slice(0, 80) });
    } else out.neither++;
  }
  const s = offsets.slice().sort((a, b) => a - b);
  if (s.length) {
    out.firstHumanSummaryOffset = {
      min: s[0], p50: s[Math.floor(s.length / 2)], max: s[s.length - 1],
      over1MB: s.filter((x) => x > 1024 * 1024).length,
    };
  }
  return out;
}

// ── C：结构性探索 ───────────────────────────────────────────────────

/** C 节：被拦会话里，主线程做了哪些结构性探索；以及 Glob/Grep 结果里有没有命中数。 */
export function sectionC(root = defaultRoot(), opts = {}) {
  const { excludeSandbox = true, samples = 8 } = opts;
  const out = {
    mainTranscripts: 0,
    bashStructCommands: 0, globCalls: 0, grepCalls: 0,
    toolsWithHitCount: { Glob: 0, Grep: 0 },
    toolResultsWithHitCount: { Glob: 0, Grep: 0 },
    verbHistogram: {},
    samples: { commands: [], hitCountTexts: [] },
  };
  for (const m of listMainTranscripts(root)) {
    const text = readFileSync(m.path, 'utf8');
    if (excludeSandbox && isSandbox(cwdOf(text), m.slug)) continue;
    out.mainTranscripts++;
    const nameById = new Map();
    eachRecord(text, (rec) => {
      for (const tu of toolUsesOf([rec])) {
        if (tu.id) nameById.set(tu.id, tu.name);
        if (tu.name === 'Glob') out.globCalls++;
        if (tu.name === 'Grep') out.grepCalls++;
        if (tu.name !== 'Bash' && tu.name !== 'PowerShell') continue;
        const cmd = typeof tu.input?.command === 'string' ? tu.input.command : '';
        if (!cmd) continue;
        for (const seg of cmd.split(/[;|&\n]/)) {
          const t = seg.trim().split(/\s+/);
          let i = 0;
          while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++;
          const verb = basename(String(t[i] || '')).replace(/\.exe$/i, '').toLowerCase();
          if (!STRUCT_VERBS.includes(verb)) continue;
          out.bashStructCommands++;
          out.verbHistogram[verb] = (out.verbHistogram[verb] || 0) + 1;
          if (out.samples.commands.length < samples) out.samples.commands.push(seg.trim().slice(0, 120));
        }
      }
      // tool_result 侧：Glob/Grep 的结果里有没有「Found N files/matches」
      const c = rec?.message?.content;
      if (!Array.isArray(c)) return;
      for (const b of c) {
        if (!b || b.type !== 'tool_result') continue;
        const nm = nameById.get(b.tool_use_id);
        if (nm !== 'Glob' && nm !== 'Grep') continue;
        const s = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        const mm = s.match(/^Found (\d+)\s+(files?|matches?)/);
        if (mm) {
          out.toolResultsWithHitCount[nm]++;
          if (out.samples.hitCountTexts.length < samples) out.samples.hitCountTexts.push(s.slice(0, 90));
        }
        out.toolsWithHitCount[nm]++;
      }
    });
  }
  return out;
}

// ── D：闸门运行时能拿到什么 ─────────────────────────────────────────

/** D 节：只报告「闸门实现里能读到什么」，不跑宿主。
 *
 *  hook 的 stdin 字段是宿主持久化在 hook-log 里的观测结果（见报告 §4）；
 *  这里能自证的是两件事：闸门读的是哪份 transcript，以及在 PreToolUse 时刻
 *  子 agent 的 transcript 是否已经落盘。后者用「文件 mtime 早于主 transcript 的
 *  最后一个 Read 事件」这种可复算的代理判据给不出，故本节点到为止，只做静态核对。 */
export function sectionD(root = defaultRoot(), opts = {}) {
  const { excludeSandbox = true } = opts;
  const out = {
    mainTranscripts: 0,
    subDirsPresent: 0,
    avgSubBodyMB: null,
    maxSubBodyMB: 0,
    totalSubMB: 0,
    // 主 transcript 里是否出现过子 agent 的 tool_use id（= 子 agent 的活动被镜像上来）
    sessionsWithMirroredToolUseId: 0,
    mainThreadToolUse: 0,
    mainThreadReadToolUse: 0,
  };
  const sizes = [];
  for (const m of listMainTranscripts(root)) {
    const text = readFileSync(m.path, 'utf8');
    if (excludeSandbox && isSandbox(cwdOf(text), m.slug)) continue;
    out.mainTranscripts++;
    const mainIds = new Set();
    eachRecord(text, (rec) => {
      if (rec?.isSidechain) return;
      for (const tu of toolUsesOf([rec])) {
        out.mainThreadToolUse++;
        if (tu.name === 'Read') out.mainThreadReadToolUse++;
        if (tu.id) mainIds.add(tu.id);
      }
    });
    const sd = subagentDirOf(m.path);
    if (!sd.dir) continue;
    out.subDirsPresent++;
    let mb = 0;
    for (const p of sd.bodies) {
      let sz = 0;
      try { sz = statSync(p).size; } catch { /* ignore */ }
      sizes.push(sz / 1048576);
      mb += sz / 1048576;
      // 该子 agent 里有没有 tool_use id 同时出现在主 transcript
      const t = readTail(p, 2 * 1024 * 1024);
      eachRecord(t, (rec) => {
        for (const tu of toolUsesOf([rec])) {
          if (tu.id && mainIds.has(tu.id)) out.sessionsWithMirroredToolUseId += 1;
        }
      });
    }
    out.totalSubMB += mb;
    out.maxSubBodyMB = Math.max(out.maxSubBodyMB, mb);
  }
  sizes.sort((a, b) => a - b);
  out.avgSubBodyMB = sizes.length ? +(sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(2) : null;
  out.totalSubMB = +out.totalSubMB.toFixed(1);
  out.maxSubBodyMB = +out.maxSubBodyMB.toFixed(1);
  // 镜像计数是「id 命中次数」，不是会话数；改名以免误读。
  out.mirroredToolUseIdHits = out.sessionsWithMirroredToolUseId;
  delete out.sessionsWithMirroredToolUseId;
  return out;
}

// ── 输出 ─────────────────────────────────────────────────────────────

export function format(r) {
  const L = [];
  const p = (x) => (x == null ? 'n/a' : `${x}%`);
  L.push(`语料根 ${r.root}`);
  if (r.A) {
    const a = r.A;
    L.push('', '── A：子 agent transcript ──');
    L.push(`  主 transcript ${a.mainTranscripts} · 其中带 subagents/ 目录 ${a.sessionsWithSubDir}`);
    L.push(`  子 agent 正文 ${a.subBodies} · meta ${a.subMetas}`);
    L.push(`  meta.toolUseId 能配上主 transcript 的 Agent tool_use id：${a.metaToolUseIdMatched}（${p(a.metaMatchRate)}），配不上 ${a.metaToolUseIdUnmatched}`);
    L.push(`  meta.toolUseId 命名空间分布：${JSON.stringify(a.metaNamespace)}`);
    L.push(`  配不上的那些的命名空间：${JSON.stringify(a.metaUnmatchedNamespace)}`);
    L.push(`  子 agent 文件名能对上 toolUseResult.agentId：${a.bodyAgentIdMatched}（${p(a.bodyMatchRate)}），对不上 ${a.bodyAgentIdUnmatched}`);
    L.push(`  主 transcript 里 Agent 调用 ${a.agentToolUseCalls} 次 · 带 toolUseResult.agentId 的 ${a.toolUseResultWithAgentId} 条（跨 ${a.agentResultSessions} 个会话）`);
    for (const e of a.examples) L.push(`    样例 ${JSON.stringify(e)}`);
  }
  if (r.B) {
    const b = r.B;
    L.push('', '── B：续接会话 ──');
    L.push(`  主 transcript ${b.mainTranscripts}`);
    L.push(`  文本判据命中 ${b.textContinuation} · isCompactSummary 判据命中 ${b.flagContinuation}`);
    L.push(`  两者一致 ${b.both} · 仅文本 ${b.onlyText} · 仅标志位 ${b.onlyFlag} · 都不是 ${b.neither}`);
    L.push(`  任何时候出现过 isCompactSummary 的会话 ${b.anyCompactFlag}（含压缩后继续的，不一定是首条）`);
    L.push(`  续接首条人类消息的字节偏移：${JSON.stringify(b.firstHumanSummaryOffset)}`);
    L.push(`  首条人类消息上出现过的字段：${JSON.stringify(b.uniqueFirstHumanKeys)}`);
    for (const s of b.samples) L.push(`    分歧样例 ${JSON.stringify(s)}`);
  }
  if (r.C) {
    const c = r.C;
    L.push('', '── C：结构性探索 ──');
    L.push(`  主 transcript ${c.mainTranscripts} · Glob 调用 ${c.globCalls} · Grep 调用 ${c.grepCalls} · shell 结构动词 ${c.bashStructCommands}`);
    L.push(`  动词分布：${JSON.stringify(c.verbHistogram)}`);
    L.push(`  Glob/Grep 结果里带「Found N files/matches」的：${JSON.stringify(c.toolResultsWithHitCount)}`);
    for (const s of c.samples.commands) L.push(`    命令样例 ${JSON.stringify(s)}`);
    for (const s of c.samples.hitCountTexts) L.push(`    命中数样例 ${JSON.stringify(s)}`);
  }
  if (r.D) {
    const d = r.D;
    L.push('', '── D：闸门运行时 ──');
    L.push(`  主 transcript ${d.mainTranscripts} · 带 subagents/ 的 ${d.subDirsPresent}`);
    L.push(`  主线程 tool_use ${d.mainThreadToolUse} 次，其中 Read ${d.mainThreadReadToolUse} 次`);
    L.push(`  子 agent 正文合计 ${d.totalSubMB} MB · 单会话最大 ${d.maxSubBodyMB} MB · 单文件均值 ${d.avgSubBodyMB} MB`);
    L.push(`  子 agent 的 tool_use id 在主 transcript 里出现的次数 ${d.mirroredToolUseIdHits}`);
  }
  return L.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const root = argOf('--root', defaultRoot());
  if (!existsSync(root)) {
    process.stderr.write(`找不到 transcript 根目录：${root}\n`);
    return 2;
  }
  const opts = {
    excludeSandbox: !argv.includes('--no-exclude-sandbox'),
    samples: Number(argOf('--samples', '3')) || 3,
  };
  const only = String(argOf('--section', '')).toUpperCase();
  const r = { root, opts };
  if (!only || only === 'A') r.A = sectionA(root, opts);
  if (!only || only === 'B') r.B = sectionB(root, opts);
  if (!only || only === 'C') r.C = sectionC(root, opts);
  if (!only || only === 'D') r.D = sectionD(root, opts);
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write(format(r) + '\n');
  return 0;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')?.replace(/^\//, '')}`) {
  process.exit(main());
}
