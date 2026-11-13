#!/usr/bin/env node
/**
 * measure-gate-ceiling.mjs — 「把写前闸改宽，最多能降到多少」的实测器。
 *
 * ── 它回答什么 ────────────────────────────────────────────────────
 * `observe-reality-check.mjs` 已测出：阈值 3 在 136 个真实有写会话上 would-deny 27 个。
 * 本脚本回答**下一个问题**：把这 27 个当成「误拦」，逐个打开候选扩宽，各自能消掉几个，
 * 全开之后还剩几个，以及**每个扩宽是不是把闸门削到恒真**（阴性对照桶：66 个沙箱会话）。
 *
 * ── 单因素消融，不是一个一个猜 ────────────────────────────────────
 * 每个扩宽**单独**打开、其余关闭，才能看出谁真的有用。叠加着测会让后开的那个
 * 吃掉前一个的功劳（或反过来），数字无法归因。
 *
 *   +D  修 `head -n 20` 解析缺陷（`20` 不再算读过的文件）
 *   +C  结构性探索（ls / find / grep / Glob / git log）也算读过
 *   +B  子 agent 的读，严格按 `meta.toolUseId` 配对
 *   +B2 子 agent 的读，不配对（旧格式配不上时的宽松档）
 *   +A  续接会话上游读（上一段 transcript 里读过的文件）
 *
 * ── 语料与清洗完全沿用 observe-reality-check.mjs ──────────────────
 * `analyzeOne()` / `dedupeForks()` / `isSandbox()` 全部直接复用，不自创第二套口径。
 * 沙箱判定就是路径含 `Temp\` 或 `.tmp-analysis`，与本仓既有测量同源。
 *
 * ── 数字口径自检（脚本里是硬断言，跑的时候会打印）────────────────
 * 基线必须逐项等于 `observe-reality-check.mjs`：
 *   真实项目 would-deny 27 / 有写 136 · 读 0 个 13 / 136 · 沙箱被拦 49 / 66
 * 另外两条自检保证「我的复现不是一个碰巧凑出 27 的另一个判据」：
 *   · 本文件的窗口解析器（不修缺陷）与 `tailGateReads()` 逐会话完全相同
 *   · 子 agent 路径集合的大小与 `subagentReadsByToolId().reads` 相同
 * 任何一条不成立 → exit 1，并在输出里标 FAIL。**对不上是我的复现错了，不是基线错了。**
 *
 * ── 诚实边界（先写在这里，免得下游误引）──────────────────────────
 * ① `+A` **没有可靠的归属依据**。实测 69 个续接会话里，`compactSummary.parentUuid`
 *    能唯一解析到同目录兄弟 transcript 的只有 12 个，54 个解析到多个、3 个解析不到；
 *    且压缩前的 tool_use 记录**一条都不在本文件里**（63/63 个有写续接会话实测
 *    `preCompact = 0`）—— transcript 在压缩点被重写，历史不在盘上。
 *    所以 +A 的两个数分开给：`upstream-unique`（唯一前序，可称归属）与
 *    `upstream-greedy`（多个候选取并集，**归属不成立，只作上界**）。
 * ② 所有「改宽后放行」的会话，都额外标注它到底读没读过**文件内容**：
 *    只有结构性探索指纹、没有任何内容读的，单独计数（"structural-only"）。
 *    这正是「削弱到恒真」的形态。
 * ③ 「被架空」的唯一硬指标是**沙箱桶拦截数掉到 0**。沙箱会话的 prompt 就是
 *    「写个文件然后停」，任何让它们全部放行的扩宽都已经不再检查任何东西。
 *
 * 用法：
 *   node scripts/measure-gate-ceiling.mjs            # 全表
 *   node scripts/measure-gate-ceiling.mjs --json
 *   node scripts/measure-gate-ceiling.mjs --root <dir>
 *   node scripts/measure-gate-ceiling.mjs --limit 100   # 只取前 N 份 transcript（调试用，会破基线断言）
 *
 * 退出码：0 = 全部断言通过；1 = 基线对不上；2 = 找不到 transcript 根目录。
 * 只读：不写任何文件，不碰 git。
 */

import { readdirSync, readFileSync, openSync, readSync, closeSync, fstatSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  analyzeOne, listTranscripts, dedupeForks, isSandbox, defaultRoot,
  gateReadsOf, tailGateReads, gateReadPathsInText, eachLineOffset,
  agentToolIdsBefore, subagentReadsByToolId, looseSubagentReads,
  isContinuation, CONTINUATION_RE, ATTRIBUTION_CLASSES, attribute,
} from './observe-reality-check.mjs';
import { pathKeyOf } from './pre-write-gate.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));

/** 闸门默认阈值。改它属于「替代方案 1/2」，不属于扩宽判据。 */
export const BASE_THRESHOLD = 3;

/** 「后面跟一个值」的选项，**按动词分**。这个区分是必需的，不是小心过度：
 *
 *  · `head -n 20 a.mjs` / `tail -c 512 x.log` —— `-n`/`-c` 要值，不跳过就会把 `20`/`512`
 *    当成读过的文件（这正是要修的缺陷）；
 *  · `cat -n a.mjs` —— `-n` 是「显示行号」，**不要值**。若照搬 head 的规则，`a.mjs`
 *    会被当成 `-n` 的值吞掉，等于把一次真读抹掉（方向变严，同样错）。
 *
 *  只列实测会用到的：`-n`/`-c`/`--lines`/`--bytes` 属于 head/tail；其余动词一律不认取值选项。 */
const VALUE_FLAGS_BY_VERB = Object.freeze({
  head: /^-(?:n|c)$/i,
  tail: /^-(?:n|c)$/i,
});
const LONG_VALUE_FLAG = /^--(?:lines|bytes)$/i;

/** 写工具名（与 `pre-write-gate.mjs` 的 `WRITE_TOOLS` 同源，这里只需要这三个）。 */
const WRITE_NAMES = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/** 沙箱/真实分桶沿用既有口径。这里再导出一份是为了让调用方不必知道细节。 */
export { isSandbox };

// ── 窗口读取：与 tailGateReads 同构，但解析器可换 ─────────────────────

/** 取 `[endBytes-windowBytes, endBytes)` 的文本。首行若被切断则丢掉。
 *
 *  与 `observe-reality-check.tailGateReads()` 逐字节同法 —— 这是为了能用同一个窗口
 *  比较「修缺陷前 / 后」两种解析器，否则两个数会因为窗口口径不同而不可比。
 *
 *  注意丢首行的条件：只在**读满窗口**时丢（＝从文件中段切进去，首行是半条）。
 *  文件比窗口小时首行是完整记录，必须保留 —— `tailGateReads()` 的锚点也是这个条件，
 *  两边若不一致，`parserEquivalence` 会红（这里曾复制过旧的无条件丢弃，已同步）。 */
export function readWindowText(path, endBytes, windowBytes = 1024 * 1024) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const end = Math.min(size, Math.max(0, Number(endBytes) || 0));
    const want = Math.max(0, Math.min(end, windowBytes));
    if (!want) return '';
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, end - want + got);
      if (n <= 0) break;
      got += n;
    }
    let text = (got === want ? buf : buf.subarray(0, got)).toString('utf8');
    if (got >= windowBytes && text.includes('\n')) {
      text = text.slice(text.indexOf('\n') + 1);
    }
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * 修复后的 shell 读动词解析（+D）。
 *
 * 原实现（`gateReadsOf`）从动词后面第一个不以 `-` 开头的 token 取路径，于是
 * `head -n 20 a.mjs` 取到 `20`、`tail -c 512 x.log` 取到 `512`。方向是**多算**
 * （凭空多出一个"读过的文件"）→ 更宽松 → 更少拦截。修掉它会让闸门**变严**，
 * 这一点必须如实报告，不能当"改进"混进"扩宽"里。
 *
 * 修复规则：选项若自带值（`-n 20`）则连值一起跳过；`-n20` / `-20` 这类粘连写法整段跳过。
 */
export function gateReadsFixedOf(name, inp) {
  const raw = gateReadsOf(name, inp);
  if (name !== 'Bash' && name !== 'PowerShell') return raw;
  const cmd = typeof inp?.command === 'string' ? inp.command : '';
  if (!cmd) return raw;
  const out = [];
  for (const seg of cmd.split(/[;|&\n]/)) {
    const t = seg.trim().split(/\s+/);
    let i = 0;
    while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++;
    const verb = String(t[i] || '').replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();
    if (!['cat', 'head', 'tail', 'type', 'get-content', 'gc', 'more'].includes(verb)) continue;
    const shortValueFlag = VALUE_FLAGS_BY_VERB[verb] || null;
    for (let j = i + 1; j < t.length; j++) {
      const a = t[j];
      // 粘连写法：`-n20`、`-c512`、`-20`（只在 head/tail 上成立）
      if (shortValueFlag) {
        if (/^-(?:n|c)\d+$/i.test(a) || /^-\d+$/.test(a)) continue;
        if (shortValueFlag.test(a)) { j++; continue; }
      }
      if (LONG_VALUE_FLAG.test(a)) { j++; continue; }        // `--lines 20`
      if (/^--?[A-Za-z][\w-]*=/.test(a)) continue;           // `--lines=20`
      if (/^-/.test(a)) continue;                            // 其它开关
      out.push(/^["']|["']$/.test(a) ? a.replace(/^["']|["']$/g, '') : a);
      break;
    }
  }
  return out;
}

/** 用一个可换的解析器取窗口内的读路径（去重后返回原始路径字符串数组）。 */
export function windowReadPaths(path, endBytes, { fixed = false, windowBytes = 1024 * 1024 } = {}) {
  const text = readWindowText(path, endBytes, windowBytes);
  if (!text) return [];
  const seen = new Set();
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let rec;
    try { rec = JSON.parse(s); } catch { continue; }
    const content = rec && rec.message && Array.isArray(rec.message.content) ? rec.message.content : null;
    if (!content) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      const nm = String(b.name || '');
      const input = b.input || {};
      const got = fixed ? gateReadsFixedOf(nm, input) : gateReadsOf(nm, input);
      for (const p of got) {
        const k = pathKeyOf(p);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(p);
      }
    }
  }
  return out;
}

// ── 子 agent 的读：返回**真实路径集合**，不是计数 ──────────────────────

/** 严格归因：`meta.toolUseId` 必须命中首写前的 Agent 调用。返回路径键集合。 */
export function subagentPathSet(session, allowedIds) {
  const out = new Set();
  const dir = join(session.path.replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(dir)) return out;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (!e.endsWith('.meta.json')) continue;
    let meta = null;
    try { meta = JSON.parse(readFileSync(join(dir, e), 'utf8')); } catch { continue; }
    const tid = String(meta?.toolUseId || '');
    if (!tid || !allowedIds.has(tid)) continue;
    const body = join(dir, e.replace(/\.meta\.json$/, '.jsonl'));
    if (!existsSync(body)) continue;
    collectGateKeysInto(body, out);
  }
  return out;
}

/** 宽松归因：该会话 `subagents/` 下**所有**子 agent 读过的路径。 */
export function looseSubagentPathSet(session) {
  const out = new Set();
  const dir = join(session.path.replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(dir)) return out;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (!e.endsWith('.jsonl')) continue;
    collectGateKeysInto(join(dir, e), out);
  }
  return out;
}

function collectGateKeysInto(path, set) {
  eachLineOffset(path, (line) => {
    if (!line) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    const c = o?.message?.content;
    if (!Array.isArray(c)) return;
    for (const b of c) {
      if (!b || b.type !== 'tool_use') continue;
      for (const x of gateReadsOf(String(b.name || ''), b.input || {})) {
        const k = pathKeyOf(x);
        if (k) set.add(k);
      }
    }
  });
}

// ── 续接会话的上游读（+A）─────────────────────────────────────────────

/**
 * 找一个续接会话可能的**前序 transcript**。
 *
 * 判据只有两条，都可复核：同 cwd、前序的 `lastTs` 不晚于本会话的 `firstTs`。
 * 刻意**不用** uuid 指针作为唯一依据，因为实测它大面积不可用（12 唯一 / 54 多义 / 3 无）。
 * 排除「同一段对话的副本」：`firstTs` 与记录数都相同视为 fork 快照。
 *
 * 返回 `{candidates, chosen, reads, unique, basis}`：
 *   · `unique=true`  → 只有一个候选，可以声称归属
 *   · `unique=false` → 多个候选，`reads` 取并集（**上界，不是归属**）
 */
export function upstreamOf(session, allSessions, { nearest = 3 } = {}) {
  const empty = { candidates: 0, chosen: [], reads: 0, unique: false, basis: 'none' };
  if (!isContinuation(session)) return empty;
  const ts = session.firstTs ? Date.parse(session.firstTs) : NaN;
  if (!Number.isFinite(ts)) return empty;
  const cands = allSessions.filter((q) => q !== session
    && q.sessionId !== session.sessionId
    && q.cwd && session.cwd && q.cwd === session.cwd
    && q.lastTs && Date.parse(q.lastTs) <= ts
    && !(q.firstTs === session.firstTs && q.records === session.records));
  if (!cands.length) return empty;
  cands.sort((a, b) => Date.parse(b.lastTs) - Date.parse(a.lastTs));
  const picked = cands.slice(0, nearest);
  const set = new Set();
  for (const q of picked) for (const k of q.readPathsGate || []) set.add(k);
  return {
    candidates: cands.length,
    chosen: picked.map((q) => q.sessionId.slice(0, 8)),
    reads: set.size,
    unique: cands.length === 1,
    basis: cands.length === 1 ? 'unique' : 'greedy',
    set,
  };
}

// ── 单会话的全部证据（只算一次）───────────────────────────────────────

/** 统计该会话的工具调用总数（分桶用）。整文件扫描，只对「有写」的会话调用。 */
export function toolCallCount(path) {
  let n = 0;
  eachLineOffset(path, (line) => {
    if (!line) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    if (o.type !== 'assistant') return;
    for (const b of o.message?.content ?? []) if (b && b.type === 'tool_use') n++;
  });
  return n;
}

/** 把一个会话的各类证据算出来。`denied` 为 false 时不读子 agent / 前序（省 IO，且用不上）。 */
export function evidenceOf(session, allSessions, { denied = true } = {}) {
  const cutoff = session.firstWrite?.off ?? Number.POSITIVE_INFINITY;
  const gateWin = new Set((session.readPathsWindow || []).map(pathKeyOf).filter(Boolean));
  const gateCum = new Set((session.readPathsGate || []).map(pathKeyOf).filter(Boolean));
  const fixWin = new Set(windowReadPaths(session.path, cutoff, { fixed: true }).map(pathKeyOf).filter(Boolean));
  // 结构性探索 = 宽口径集合 减去 闸门集合（宽口径里本来就含闸门那一档）
  const struct = new Set();
  for (const p of session.readPathsBroad || []) {
    const k = pathKeyOf(p);
    if (k && !gateCum.has(k)) struct.add(k);
  }
  const target = pathKeyOf(session.firstWrite?.paths?.[0] || '');

  let subStrict = new Set();
  let subLoose = new Set();
  let up = { candidates: 0, chosen: [], reads: 0, unique: false, basis: 'none', set: new Set() };
  if (denied) {
    if (session.agentCalls > 0) {
      const ids = agentToolIdsBefore(session);
      subStrict = subagentPathSet(session, ids);
      if (!subStrict.size) subLoose = looseSubagentPathSet(session);
    }
    up = upstreamOf(session, allSessions);
  }
  return { gateWin, gateCum, fixWin, struct, target, subStrict, subLoose, up };
}

const union = (...sets) => {
  const out = new Set();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
};

/**
 * 各变体的证据集合。返回 `{name -> Set}`。
 *
 * `all` 用修好解析器的 gate（+D 必须一起开，否则 `head -n 20` 的假路径会混进来）。
 */
export function variantSets(ev) {
  return {
    // 基线：闸门真实口径
    baseline: ev.gateWin,
    // 单因素扩宽
    D: ev.fixWin,
    C: union(ev.gateWin, ev.struct),
    B: union(ev.gateWin, ev.subStrict),
    B2: union(ev.gateWin, ev.subLoose),
    'A-unique': union(ev.gateWin, ev.up.unique ? (ev.up.set || new Set()) : new Set()),
    'A-greedy': union(ev.gateWin, ev.up.set || new Set()),
    // 全开
    all: union(ev.fixWin, ev.struct, ev.subStrict, ev.subLoose, ev.up.set || new Set()),
  };
}

/** 该会话在任何「内容读」来源下读到过东西没有（用于识别 structural-only 放行）。 */
export function contentReads(ev) {
  return union(ev.gateWin, ev.fixWin, ev.subStrict, ev.subLoose, ev.up.set || new Set());
}

// ── 汇总 ──────────────────────────────────────────────────────────────

const PASS_PAIRS = [
  ['baseline', '闸门原样'],
  ['D', '+D 解析修复'],
  ['C', '+C 结构性探索'],
  ['B', '+B 子 agent（严格）'],
  ['B2', '+B2 子 agent（宽松）'],
  ['A-unique', '+A 续接上游（唯一前序）'],
  ['A-greedy', '+A 续接上游（多候选并集，上界）'],
  ['all', '全开'],
];

/**
 * 跑全量。
 *
 * `thresholds` 是**同一判据**下的常数扫描（替代方案 1/2）；`target` 是另一条判据
 * （替代方案 3：读过目标文件本身即放行）。
 */
export function measure(root = defaultRoot(), { threshold = BASE_THRESHOLD, limit = 0 } = {}) {
  let metas = listTranscripts(root);
  if (limit > 0) metas = metas.slice(0, limit);
  const parsed = [];
  let skipped = 0;
  for (const m of metas) {
    try { parsed.push(analyzeOne(m, { order: 'file' })); } catch { skipped++; }
  }
  const { kept, merged } = dedupeForks(parsed);
  const real = kept.filter((s) => !isSandbox(s));
  const sandbox = kept.filter((s) => isSandbox(s));

  // 只对「有写」的会话算工具调用数（分桶用）。
  const toolCalls = new Map();
  for (const s of kept) if (s.firstWrite) toolCalls.set(s.sessionId, toolCallCount(s.path));

  const analyze = (list) => {
    const withWrite = list.filter((s) => s.firstWrite);
    const deniedBase = withWrite.filter((s) => s.gateReads < threshold);
    const deniedIds = new Set(deniedBase.map((s) => s.sessionId));
    const rows = withWrite.map((s) => {
      const ev = evidenceOf(s, kept, { denied: deniedIds.has(s.sessionId) });
      const sets = variantSets(ev);
      const content = contentReads(ev);
      const attr = deniedIds.has(s.sessionId) ? attribute(s, { threshold }) : null;
      return {
        sessionId: s.sessionId,
        slug: s.slug,
        firstTs: s.firstTs,
        toolCalls: toolCalls.get(s.sessionId) || 0,
        gate: ev.gateWin.size,
        cumulative: s.gateReadsCumulative,
        broad: s.broadReads,
        target: ev.target,
        attr: attr ? attr.cls : null,
        agentCalls: s.agentCalls,
        upCands: ev.up.candidates,
        upChosen: ev.up.chosen,
        upUnique: ev.up.unique,
        upBasis: ev.up.basis,
        sets,
        contentSize: content.size,
        structOnly: sets.baseline.size === 0 && content.size === 0 && ev.struct.size > 0,
        targetRead: ev.target ? ev.gateWin.has(ev.target) : false,
        targetReadAny: ev.target ? content.has(ev.target) : false,
      };
    });
    return { withWrite, deniedBase, rows };
  };

  const realA = analyze(real);
  const sandA = analyze(sandbox);

  return {
    threshold,
    root,
    // 供 `parserEquivalence()` 逐会话比对窗口解析器；下划线前缀表示「内部用，不进 JSON」。
    _kept: kept,
    totals: {
      transcripts: metas.length, parsed: parsed.length, skipped,
      afterDedupe: kept.length, forksMerged: merged,
    },
    real: summarize(realA, threshold),
    sandbox: summarize(sandA, threshold),
    rows: { real: realA.rows, sandbox: sandA.rows },
  };
}

/** 把一行行证据汇总成表：每个变体的 would-deny、放行新增、结构性放行、沙箱拦截。 */
function summarize(bucket, threshold) {
  const { withWrite, rows } = bucket;
  const counts = {};
  const flipped = {};
  const structOnly = {};
  for (const [name] of PASS_PAIRS) {
    counts[name] = rows.filter((r) => r.sets[name].size < threshold).length;
    flipped[name] = rows
      .filter((r) => r.sets.baseline.size < threshold && r.sets[name].size >= threshold)
      .map((r) => r.sessionId.slice(0, 8));
    structOnly[name] = rows
      .filter((r) => r.sets.baseline.size < threshold && r.sets[name].size >= threshold && r.contentSize === 0)
      .map((r) => r.sessionId.slice(0, 8));
  }

  // 替代方案 1/2：同一判据换阈值
  const thr = {};
  for (const t of [0, 1, 2, 3, 5]) {
    thr[t] = rows.filter((r) => r.sets.baseline.size < t).length;
  }

  // 替代方案 3：读过目标文件本身即放行（否则仍按原阈值）
  const targetPass = rows.filter((r) => r.targetRead || r.sets.baseline.size >= threshold).length;
  const targetWouldDeny = rows.length - targetPass;
  const targetReadSessions = rows.filter((r) => r.targetRead).length;

  return {
    sessions: rows.length,
    withWrite: withWrite.length,
    baselineDeny: rows.filter((r) => r.sets.baseline.size < threshold).length,
    zeroRead: rows.filter((r) => r.gate === 0).length,
    variants: counts,
    flipped,
    structOnly,
    thresholds: thr,
    target: {
      wouldDeny: targetWouldDeny,
      allow: targetPass,
      targetReadSessions,
      // 目标文件只在 cumulative/子 agent/上游 里读过、原窗口里没有的
      targetReadOutsideWindow: rows.filter((r) => !r.targetRead && r.targetReadAny).length,
    },
    attribution: (() => {
      const m = {};
      for (const k of ATTRIBUTION_CLASSES) m[k] = 0;
      for (const r of rows) if (r.attr) m[r.attr] = (m[r.attr] || 0) + 1;
      return m;
    })(),
    agentFirst: rows.filter((r) => r.agentCalls > 0).length,
  };
}

// ── 基线自检 ──────────────────────────────────────────────────────────

/**
 * §6 要求的口径对齐。
 *
 * **不能拿写死的常数当基准** —— 语料是活着的：实测在写这份脚本的两小时内，
 * 沙箱会话从 66 长到 67（本机新跑了一次 e2e），写死的 66/49 会当场变红，
 * 而红的原因不是复现错了，是语料长了。那种「断言」只会训练人忽略红灯。
 *
 * 所以对齐分两层：
 *  ① **主断言**：与 `observe-reality-check.mjs` 的 `buildReport()` 在**同一次运行**
 *     里比。这是真正的「我的复现 vs 参考实现」，语料怎么长都成立。
 *  ② **快照漂移**：把任务书给的基线（27/136、13/136、49/66）单列，只**报告**
 *     不判定 —— 若主断言全绿而快照不符，结论是「语料变了」，不是「复现错了」。
 */
export function alignWithBaseline(rep, { reference = null, snapshot = null, skip = false } = {}) {
  const checks = [];
  const add = (name, expected, actual, note = '', hard = true) => {
    checks.push({ name, expected, actual, ok: expected === actual, note, hard });
  };

  if (reference) {
    const r = reference.real || {};
    const s = reference.sandbox || {};
    add('真实项目有写会话', r.withWrite, rep.real.withWrite, 'vs buildReport()');
    add('真实项目 would-deny（基线）', r.deny, rep.real.variants.baseline, '阈值 3，gate 窗口');
    add('真实项目 读 0 个', r.gate ? r.gate.zero : null, rep.real.zeroRead, 'vs buildReport()');
    add('沙箱有写会话', s.withWrite, rep.sandbox.withWrite, 'vs buildReport()');
    add('沙箱 would-deny（基线）', s.deny, rep.sandbox.variants.baseline, '阴性对照');
    for (const k of ATTRIBUTION_CLASSES) {
      add(`归因 ${k}`, (r.attribution || {})[k] || 0, rep.real.attribution[k] || 0, '五类互斥');
    }
    add('真实项目 cumulative would-deny', r.denyCumulative,
      rep.rows.real.filter((x) => x.cumulative < rep.threshold).length, '同判据不看窗口');
    add('真实项目 broad would-deny', r.denyBroad,
      rep.rows.real.filter((x) => x.broad < rep.threshold).length, '宽口径');
  }

  // ② 快照：只报告，不判定
  const drift = [];
  if (snapshot) {
    const pairs = [
      ['真实项目有写会话', snapshot.realWithWrite, rep.real.withWrite],
      ['真实项目 would-deny', snapshot.realDeny, rep.real.variants.baseline],
      ['真实项目 读 0 个', snapshot.realZero, rep.real.zeroRead],
      ['沙箱有写会话', snapshot.sandboxWithWrite, rep.sandbox.withWrite],
      ['沙箱 would-deny', snapshot.sandboxDeny, rep.sandbox.variants.baseline],
    ];
    for (const [name, was, now] of pairs) drift.push({ name, was, now, changed: was !== now });
  }

  const hardFails = checks.filter((c) => c.hard && !c.ok);
  const result = { checks, drift, hardFails: hardFails.length, ok: checks.length > 0 && hardFails.length === 0 };
  // `--limit` 只取语料子集，对齐必然对不上。标成 skipped 而不是 fail，
  // 否则「用 limit 调试」会被误读成「复现错了」。
  if (skip) return { ...result, skipped: true, ok: false, checks: checks.map((c) => ({ ...c, ok: null })) };
  return result;
}

/** 任务书给的基线快照（2026-11-14 那次测量）。只用于报告漂移，不用于判定。 */
export const BASELINE_SNAPSHOT = Object.freeze({
  realWithWrite: 136, realDeny: 27, realZero: 13, sandboxWithWrite: 66, sandboxDeny: 49,
  attrib: {
    'A-continuation': 5, 'B-subagent': 5, 'B2-subagent-unattributed': 8,
    'C-broad-explore': 6, 'D-no-evidence': 3,
  },
  cumulativeDeny: 26, broadDeny: 15,
});

/** 第二层自检：我的窗口解析器必须与 `tailGateReads()` 逐会话一致（不涉及语料统计）。
 *
 *  `checked === 0` 视为失败，不是通过 —— 空集合上的「全部一致」是恒真，
 *  这正是本报告要识别的那种「被架空的检查」。 */
export function parserEquivalence(sessions) {
  let checked = 0;
  const bad = [];
  for (const s of sessions) {
    if (!s.firstWrite) continue;
    const a = new Set((s.readPathsWindow || []).map(pathKeyOf));
    const b = new Set(windowReadPaths(s.path, s.firstWrite.off, { fixed: false }).map(pathKeyOf));
    const same = a.size === b.size && [...a].every((k) => b.has(k));
    if (!same) bad.push({ sessionId: s.sessionId.slice(0, 8), a: a.size, b: b.size });
    checked++;
  }
  return { checked, bad, ok: checked > 0 && bad.length === 0 };
}

// ── 稳健性 ────────────────────────────────────────────────────────────

/** 按工具调用总数分桶，看每个变体在各桶的 would-deny。 */
export function byToolCalls(rep, edges = [50, 200]) {
  const bucketOf = (n) => (n < edges[0] ? `<${edges[0]}` : n <= edges[1] ? `${edges[0]}-${edges[1]}` : `>${edges[1]}`);
  const names = PASS_PAIRS.map(([n]) => n);
  const out = {};
  for (const r of rep.rows.real) {
    const b = bucketOf(r.toolCalls);
    if (!out[b]) {
      out[b] = { sessions: 0, deny: Object.fromEntries(names.map((n) => [n, 0])) };
    }
    out[b].sessions++;
    for (const n of names) if (r.sets[n].size < rep.threshold) out[b].deny[n]++;
  }
  return out;
}

/** 按会话日期分两段（2026-10-01 之前 / 之后）。 */
export function byDate(rep, cut = '2026-10-01T00:00:00.000Z') {
  const cutTs = Date.parse(cut);
  const names = PASS_PAIRS.map(([n]) => n);
  const out = { before: { sessions: 0, deny: {} }, after: { sessions: 0, deny: {} } };
  for (const k of names) { out.before.deny[k] = 0; out.after.deny[k] = 0; }
  for (const r of rep.rows.real) {
    const ts = r.firstTs ? Date.parse(r.firstTs) : NaN;
    const side = Number.isFinite(ts) && ts < cutTs ? 'before' : 'after';
    out[side].sessions++;
    for (const n of names) if (r.sets[n].size < rep.threshold) out[side].deny[n]++;
  }
  return out;
}

/** 去掉会话数最多的那个项目后重算。 */
export function dropLargestProject(rep) {
  const bySlug = new Map();
  for (const r of rep.rows.real) {
    const k = r.slug || '?';
    bySlug.set(k, (bySlug.get(k) || 0) + 1);
  }
  let top = null;
  for (const [k, v] of bySlug) if (!top || v > top.n) top = { slug: k, n: v };
  if (!top) return { dropped: null, sessions: 0, deny: {} };
  const kept = rep.rows.real.filter((r) => r.slug !== top.slug);
  const names = PASS_PAIRS.map(([n]) => n);
  const deny = {};
  for (const n of names) deny[n] = kept.filter((r) => r.sets[n].size < rep.threshold).length;
  return { dropped: top.slug, droppedSessions: top.n, sessions: kept.length, deny };
}

// ── 输出 ──────────────────────────────────────────────────────────────

/** 把本机路径折叠成 `~`，保证可发布区不出现盘符。 */
function redact(p) {
  const home = homedir();
  return String(p || '').split(home).join('~');
}

export function formatReport(rep, align, equiv) {
  const L = [];
  const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : 'n/a');
  const head = (t) => { L.push('', `── ${t} ──`); };

  L.push(`写前闸改宽上限 · 真实语料实测（threshold=${rep.threshold}）`);
  L.push(`根目录 ${redact(rep.root)}`);
  L.push(`transcript ${rep.totals.transcripts} · 解析 ${rep.totals.parsed} · 跳过 ${rep.totals.skipped} · fork 去重后 ${rep.totals.afterDedupe}（合并 ${rep.totals.forksMerged}）`);

  head('§6 数字口径自检（对不上说明本脚本复现错了）');
  if (align.skipped) L.push('  —— 用 --limit 跑了语料子集 / 参考实现未跑，基线断言跳过');
  L.push('  ① 主断言：与 observe-reality-check.mjs 的 buildReport() 在同一次运行里逐项比');
  for (const c of align.checks) {
    const mark = c.ok === null ? 'skip' : (c.ok ? '✓   ' : '✗FAIL');
    L.push(`  ${mark}  ${c.name.padEnd(34)} 参考 ${String(c.expected).padStart(4)}  实测 ${String(c.actual).padStart(4)}   ${c.note}`);
  }
  if (align.drift && align.drift.length) {
    L.push('  ② 快照漂移（任务书给的 2026-11-14 基线；只报告，不判定 —— 语料会生长）：');
    const changed = align.drift.filter((d) => d.changed);
    if (!changed.length) L.push('      无漂移');
    for (const d of changed) L.push(`      ${d.name.padEnd(24)} 当时 ${String(d.was).padStart(3)} → 现在 ${String(d.now).padStart(3)}`);
  }
  if (align.corpusDrift) L.push('  ③ 语料在采集期间增长，已重扫至两侧份数一致后才采信');
  L.push(`  解析器等价性（本文件不修缺陷 vs tailGateReads）：检查 ${equiv.checked} 个会话，不一致 ${equiv.bad.length} 个 ${equiv.ok ? '✓' : '✗FAIL'}`);
  for (const b of equiv.bad.slice(0, 5)) L.push(`      ${b.sessionId}  本文件 ${b.a} / 基线 ${b.b}`);

  head('§1/§2 单因素消融与全开（真实项目，沙箱作阴性对照）');
  L.push(`  ${'变体'.padEnd(28)} ${'would-deny'.padStart(11)}  ${'占比'.padStart(6)}  ${'沙箱'.padStart(5)}  ${'结构性放行'.padStart(10)}  被架空`);
  for (const [name, label] of PASS_PAIRS) {
    const d = rep.real.variants[name];
    const s = rep.sandbox.variants[name];
    const so = rep.real.structOnly[name].length;
    const voided = s === 0 ? '**是**' : '否';
    L.push(`  ${label.padEnd(28)} ${String(d).padStart(6)} / ${String(rep.real.withWrite).padEnd(4)} ${pct(d, rep.real.withWrite).padStart(7)}  ${String(s).padStart(3)} / ${String(rep.sandbox.withWrite).padEnd(2)}  ${String(so).padStart(8)}  ${voided}`);
  }

  head('§2 全开后被拦的会话，逐个说明');
  const still = rep.rows.real.filter((r) => r.sets.all.size < rep.threshold);
  if (!still.length) L.push('  （无）');
  for (const r of still) {
    L.push(`  ${r.sessionId.slice(0, 8)}  ${(r.attr || '?').padEnd(26)} gate=${r.gate} cum=${r.cumulative} broad=${r.broad} agent=${r.agentCalls} upstream=${r.upCands}`);
  }

  head('§1 每个扩宽消掉了哪些会话（前 8 位）');
  for (const [name, label] of PASS_PAIRS.slice(1)) {
    const f = rep.real.flipped[name];
    L.push(`  ${label.padEnd(28)} 消掉 ${String(f.length).padStart(2)}: ${f.slice(0, 8).join(' ') || '—'}`);
  }

  head('§3 替代方案（同一装置）');
  L.push(`  阈值扫描（同一判据，真实 / 沙箱）：`);
  for (const [t, n] of Object.entries(rep.real.thresholds)) {
    const s = rep.sandbox.thresholds[t];
    L.push(`      阈值 ${String(t).padStart(2)}  → 真实 ${String(n).padStart(3)} / ${rep.real.withWrite} (${pct(n, rep.real.withWrite)})   沙箱 ${String(s).padStart(2)} / ${rep.sandbox.withWrite}${s === 0 ? '  **架空**' : ''}`);
  }
  L.push(`  替代 3「读过目标文件本身即放行」：${rep.real.target.allow} 放行 / ${rep.real.target.wouldDeny} 仍拦（真实）`);
  L.push(`      其中首写前读过目标文件本身的会话：${rep.real.target.targetReadSessions} / ${rep.real.withWrite}`);
  L.push(`      目标只在累计/子agent/上游读到、窗口里没有的：${rep.real.target.targetReadOutsideWindow}`);
  L.push(`      沙箱：${rep.sandbox.target.wouldDeny} 仍拦 / ${rep.sandbox.withWrite}${rep.sandbox.target.wouldDeny === 0 ? '  **架空**' : ''}`);

  head('§5 稳健性');
  const bucket = byToolCalls(rep);
  L.push(`  按工具调用总数分桶（真实项目）：`);
  for (const [b, v] of Object.entries(bucket)) {
    L.push(`      ${b.padEnd(9)} n=${String(v.sessions).padStart(3)}  基线 ${String(v.deny.baseline).padStart(2)}  全开 ${String(v.deny.all).padStart(2)}  +C ${String(v.deny.C).padStart(2)}  +B ${String(v.deny.B).padStart(2)}  +B2 ${String(v.deny.B2).padStart(2)}  +A(g) ${String(v.deny['A-greedy']).padStart(2)}`);
  }
  const date = byDate(rep);
  L.push(`  按会话日期（2026-10-01 分界）：`);
  for (const side of ['before', 'after']) {
    const v = date[side];
    L.push(`      ${side.padEnd(7)} n=${String(v.sessions).padStart(3)}  基线 ${String(v.deny.baseline).padStart(2)}  全开 ${String(v.deny.all).padStart(2)}  +C ${String(v.deny.C).padStart(2)}  +B ${String(v.deny.B).padStart(2)}  +B2 ${String(v.deny.B2).padStart(2)}`);
  }
  const drop = dropLargestProject(rep);
  L.push(`  去掉最大项目「${drop.dropped}」（${drop.droppedSessions} 个会话）：剩 ${drop.sessions} 个，基线 ${drop.deny.baseline}，全开 ${drop.deny.all}`);

  head('§2 全开 vs 不装：差别量化');
  const allDeny = rep.real.variants.all;
  const noEvidence = rep.rows.real.filter((r) => r.sets.all.size < rep.threshold && r.contentSize === 0).length;
  L.push(`  全开后真实项目仍拦 ${allDeny} / ${rep.real.withWrite}；其中"没读过任何文件内容"的 ${noEvidence} 个。`);
  L.push(`  沙箱拦截 ${rep.sandbox.variants.all} / ${rep.sandbox.withWrite}。`);

  return L.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const root = argOf('--root', defaultRoot());
  if (!existsSync(root)) {
    process.stderr.write(`找不到 transcript 根目录：${redact(root)}\n`);
    return 2;
  }
  const limit = Number(argOf('--limit', '0')) || 0;
  const threshold = Number(argOf('--threshold', String(BASE_THRESHOLD))) || BASE_THRESHOLD;

  const t0 = Date.now();
  // 语料是**活目录**：并发跑测试会往里写新 transcript。实测在一次运行的两分钟内
  // 沙箱会话从 67 长到 68，于是「我先扫、参考后扫」会各看到不同份数，比对必然假红。
  // 所以配对采集：两边都扫到**同一份数**才采信；最多重试 3 次（实测 1 次即收敛）。
  let rep = null;
  let reference = null;
  let corpusDrift = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    rep = measure(root, { threshold, limit });
    if (limit > 0) break;
    try {
      const { buildReport } = await import('./observe-reality-check.mjs');
      reference = buildReport(root, { threshold, order: 'file' });
    } catch (e) {
      process.stderr.write(`参考实现调用失败：${String((e && e.message) || e).slice(0, 160)}\n`);
      reference = null;
      break;
    }
    if (reference.totals.transcripts === rep.totals.transcripts) break;
    corpusDrift = true;
    reference = null;   // 这一轮不作数，重来
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const align = alignWithBaseline(rep, { reference, snapshot: BASELINE_SNAPSHOT, skip: limit > 0 || !reference });
  if (corpusDrift && reference) align.corpusDrift = true;
  const equiv = parserEquivalence(rep._kept || []);

  if (argv.includes('--json')) {
    const out = {
      threshold, elapsedSec: Number(elapsed),
      totals: rep.totals,
      real: rep.real, sandbox: rep.sandbox,
      robustness: {
        byToolCalls: byToolCalls(rep),
        byDate: byDate(rep),
        dropLargestProject: dropLargestProject(rep),
      },
      align: {
        ok: align.ok,
        skipped: !!align.skipped,
        hardFails: align.hardFails,
        checks: align.checks,
        snapshotDrift: align.drift,
        parserEquivalence: { checked: equiv.checked, bad: equiv.bad, ok: equiv.ok },
      },
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return align.ok && equiv.ok ? 0 : 1;
  }

  process.stdout.write(formatReport(rep, align, equiv) + '\n');
  process.stdout.write(`\n耗时 ${elapsed}s\n`);
  if (!align.ok || !equiv.ok) {
    process.stdout.write('\n✗ 基线自检未通过 —— 本脚本的复现与 observe-reality-check.mjs 不一致，上面的数字不可用。\n');
    return 1;
  }
  return 0;
}

if (process.argv[1] && String(process.argv[1]).endsWith('measure-gate-ceiling.mjs')) {
  // `main` 是 async（要对参考实现做一次动态 import），必须等它落定再定退出码。
  main().then((code) => process.exit(code)).catch(() => process.exit(1));
}
