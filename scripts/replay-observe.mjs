#!/usr/bin/env node
/**
 * replay-observe.mjs — 用历史语料模拟 P0 观察期。
 *
 * 观察器上线后候选恒为 0（当前 23 个会话全是 EXPLORING/PRODUCING），等三天也攒不到
 * 一条 observations.jsonl。本脚本把历史停止点当作「在线观察到的那一刻」重放，
 * 走完整的判定链，产出与 observations.jsonl 同格式的记录。
 *
 * ── 什么是「在线」───────────────────────────────────────────────────
 *
 * 在线与离线唯一的区别是**能看到什么**：在线只看得到观察时刻之前已落盘的记录。
 * 所以回放的关键不是「把 afterRecords 置空」，而是**显式构造观察时刻 T**：
 *
 *   可见记录 = 文件顺序里时间戳 ≤ T 的前缀
 *
 * 用文件顺序（append order）而不是全量时间排序：真实 transcript 是追加写的，
 * 观察者只能看到前缀。实测 382561 行里有 15119 行是重复 uuid（会话回卷/压缩后重放），
 * 若按时间戳全局排序，会把「当时还没写下的记录」提前放进视野——正是要避免的错误。
 *
 * 这一点直接决定了 idleSec 怎么取：**idleSec 不是参数，是 T 的因变量**。
 * 给定 T，idleSec = T − 最后一次工具调用的时间戳（与 scan-sessions 的算法一致），
 * 而「能看到哪些记录」也由 T 决定。任何把 idleSec 当独立旋钮的模拟都会自相矛盾：
 * 设 idleSec=300 同时让 afterRecords 为空，等价于「停了 5 分钟但下一条记录还没写」，
 * 这在在线世界里是自洽的，在离线世界里是删数据。
 *
 * 所以本脚本不扫 idleSec，而是扫**观察时刻**：
 *   --model delay  停止后 d 秒观察一次（d = 60/120/300/600/1800）
 *   --model poll   按真实的 5 分钟扫描节奏观察，直到会话恢复或超过 24h
 *
 * ── 三个模型（结论不能混用）──────────────────────────────────────────
 *
 *   A. delay  单次观察。回答「门槛取多少」。不是生产行为。
 *   B. poll   按 5 分钟节奏轮询 + 生产的去重/限额。回答「实际会发多少条」。
 *   C. watch  在**首次扫描**时被 unclassifiable-too-recent 挡下的停止点，
 *             回头核对之后真实发生了什么。回答 doc §六 的缺口：抑制正确率。
 *
 *   A 与 B 在本语料上给出不同量级，原因写在模型 B 的注释里，不是 bug。
 *
 * ── 关于「候选」的一层反直觉结论 ────────────────────────────────────
 *
 * 回放显示：**绝大多数停止点根本进不了候选**，不是因为分类器，而是因为四态判定。
 * 一个会话停止后，只要最后一窗（20 次调用）里有写操作，就判 PRODUCING；
 * 停了超过 1 小时则判 EXPLORING(dormant)。两者都不在 NOTIFY_STATES 里。
 * 这是产品行为，不是回放假设——judgeState 就是这么写的。
 *
 * ── 零依赖，只读 transcript ─────────────────────────────────────────
 *
 * 唯一写入是解析缓存（系统临时目录）与 --emit 的模拟观察日志，都在仓库外。
 *
 * 用法：
 *   node scripts/replay-observe.mjs                       # 三个模型都跑
 *   node scripts/replay-observe.mjs --model poll --min-idle 60,300,600
 *   node scripts/replay-observe.mjs --cache off           # 不写解析缓存
 *   node scripts/replay-observe.mjs --emit                # 把模拟日志写到临时目录并打印路径
 */

import { readdirSync, statSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { classifyStop } from './classify-stop.mjs';
import { judgeState, signatureOf, isPersistentChange } from './scan-sessions.mjs';
import {
  NOTIFY_STATES, NOTIFY_KINDS, emptyState, dedupeKey, canNotify, recordSent,
  observationStats, formatStats, UNCLASSIFIABLE_MIN_IDLE_SEC,
} from './watch.mjs';

// ── 常量 ──────────────────────────────────────────────────────────────

/** 生产里的扫描节奏：L-mid 探针 5 分钟、L-full 30 分钟。候选实际由 5 分钟那层产生。 */
export const POLL_INTERVAL_MS = 5 * 60_000;

/** 观察期文档 §三的门槛扫描点。60/120/300/600/1800 覆盖「调低 / 默认 / 调高」三档。 */
export const DEFAULT_MIN_IDLE_SWEEP = Object.freeze([60, 120, 300, 600, 1800]);

/** 单次观察模型 A 的观察延迟：与门槛扫描同值，便于横向对比。 */
export const DEFAULT_DELAYS_SEC = Object.freeze([60, 120, 300, 600, 1800]);

/** 回访上限。超过 24h 仍无新记录，归入「语料结束仍未恢复」，不再往下追。 */
const REWATCH_MAX_MS = 24 * 3600_000;

/** 生产 scan-sessions 的窗口常量：判定只看最近 400 次调用（MAX_CALLS_PER_SESSION）、
 *  最近 20 次算 novelty（WINDOW）。回放必须同口径，否则回放里的状态分布不是线上状态分布。 */
const MAX_CALLS_PER_SESSION = 400;
const SCAN_WINDOW = 20;

/** 文本块截断长度。分类器只读停止文本的**最后一个非空行**（完成汇报）与文本重合度，
 *  留头留尾各 2000 字符足够；中间截断不影响 verdict。只作用于缓存副本。 */
const TEXT_KEEP = 2000;

/** 缓存格式版本。改结构必须 +1，否则旧缓存会被当成新格式读。 */
const CACHE_VERSION = 1;

const MAX_CACHE_FILES = 400;

// ── 记录解析 ──────────────────────────────────────────────────────────

/** 纯 tool_result 的 user 记录：工具回执，不是「下一句人话」。
 *  与 classify-stop.mjs 的 isToolResultOnly 同义；不 import 是因为那份没有导出。 */
export function isToolResultOnly(rec) {
  if (!rec || rec.type !== 'user') return false;
  const c = rec.message && rec.message.content;
  if (!Array.isArray(c) || !c.length) return false;
  return c.every((b) => b && b.type === 'tool_result');
}

/** 一条 user 记录的来源。与 classify-stop.mjs 的 originKindOf 逐条对齐。
 *  重写而不是 import：那份是内部函数。规则若漂移，两边要一起改。 */
export function originKindOf(rec) {
  const k = rec && rec.origin && typeof rec.origin.kind === 'string' ? rec.origin.kind : null;
  if (k) return k;
  if (isToolResultOnly(rec)) return 'tool-result';
  const c = rec && rec.message ? rec.message.content : null;
  const t = typeof c === 'string' ? c
    : Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n') : '';
  if (/<\s*task-notification\b/.test(t)) return 'task-notification';
  if (/<\s*cross-session-message\b/.test(t)) return 'peer';
  if (/^\s*<\s*[a-z][a-z0-9-]*>/.test(t)) return 'system-injected';
  return 'human';
}

const tsOf = (rec) => {
  const t = Date.parse(rec && rec.timestamp);
  return Number.isFinite(t) ? t : null;
};

/** 文本截断：留头留尾。「最后一行」在尾部，完成汇报判定依赖它。 */
export function capText(s) {
  const t = typeof s === 'string' ? s : '';
  if (t.length <= TEXT_KEEP * 2) return t;
  return `${t.slice(0, TEXT_KEEP)}\n…[${t.length - TEXT_KEEP * 2} chars elided]…\n${t.slice(-TEXT_KEEP)}`;
}

function compactContent(c) {
  if (typeof c === 'string') return [{ type: 'text', text: capText(c) }];
  if (!Array.isArray(c)) return [];
  const out = [];
  for (const b of c) {
    if (!b || typeof b !== 'object') continue;
    const o = { type: b.type };
    if (typeof b.text === 'string') o.text = capText(b.text);
    if (typeof b.name === 'string') o.name = b.name;
    if (typeof b.id === 'string') o.id = b.id;
    if (b.input && typeof b.input === 'object') o.input = b.input;
    if (b.type === 'tool_result') {
      const rc = b.content;
      if (typeof rc === 'string') o.content = capText(rc);
      else if (Array.isArray(rc)) {
        o.content = rc.filter((x) => x && typeof x === 'object')
          .map((x) => ({ type: x.type, text: capText(x.text || '') }));
      }
      if (typeof b.tool_use_id === 'string') o.tool_use_id = b.tool_use_id;
    }
    out.push(o);
  }
  return out;
}

/** 只留判定用得到的字段。原始记录单条可达数十 KB（tool_result 里带整个文件），
 *  全量进缓存会让 1GB 语料变成更大的缓存，而判定只用得到这几个键。 */
export function compactRecord(rec) {
  const o = {
    type: rec.type,
    uuid: typeof rec.uuid === 'string' ? rec.uuid : null,
    ts: tsOf(rec),
    timestamp: typeof rec.timestamp === 'string' ? rec.timestamp : null,
  };
  if (typeof rec.permissionMode === 'string' && rec.permissionMode) o.permissionMode = rec.permissionMode;
  if (rec.origin && typeof rec.origin.kind === 'string') o.origin = { kind: rec.origin.kind };
  if (rec.message && typeof rec.message === 'object') {
    const m = rec.message;
    o.message = { role: m.role, stop_reason: m.stop_reason ?? null, id: m.id ?? null, content: compactContent(m.content) };
  }
  return o;
}

/** 抽 tool_use 调用。签名与「是否持久化」预先算好：judgeState 只需要这三项。 */
function callsOf(records) {
  const calls = [];
  for (const rec of records) {
    if (!rec || rec.type !== 'assistant') continue;
    const c = rec.message && rec.message.content;
    if (!Array.isArray(c)) continue;
    const ts = tsOf(rec);
    if (ts == null) continue;
    for (const b of c) {
      if (!b || b.type !== 'tool_use') continue;
      const input = b.input || {};
      calls.push({ name: b.name, ts, sig: signatureOf(b.name, input), persistent: isPersistentChange(b.name, input) });
    }
  }
  calls.sort((a, b) => a.ts - b.ts);
  return calls;
}

// ── 停止点 ────────────────────────────────────────────────────────────

/** 哪些 stop_reason 算「停止点」。
 *
 *  - end_turn / stop_sequence：这一轮真的结束了，等下一句。
 *  - tool_use：绝大多数是工具在跑（实测 124k 条），不算停；但 AskUserQuestion 与
 *    ExitPlanMode 的停止点落在这里（classify-stop.mjs 文件头警告过），漏掉会让
 *    ASKED_* / PLAN_SUBMITTED 永远不出现。
 *  - max_tokens / model_context_window_exceeded（98 条）：被截断，不是停止，排除。 */
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

function lastToolName(rec) {
  const c = rec && rec.message && rec.message.content;
  if (!Array.isArray(c)) return null;
  let name = null;
  for (const b of c) if (b && b.type === 'tool_use') name = b.name;
  return name;
}

function firstText(rec) {
  const c = rec && rec.message && rec.message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  for (const b of c) if (b && typeof b.text === 'string' && b.text.trim()) return b.text;
  return '';
}

/**
 * 把会话切成停止点。
 *
 * 同一轮产生多条 assistant 记录（apiBlockIndex 0=thinking / 1=text），**每条都带
 * end_turn**。按 message.id 合并成组，取组内最后一条作为停止点，否则停止点数虚增
 * 约 1.5 倍（实测 end_turn 记录 6053 条 → 停止点 4000+ 个）。
 *
 * 返回的停止点带**下标**而不是记录副本；由 sliceStops 在解析结束时切成最小切片。
 * 这样中间态不需要为每个停止点复制前文，缓存也不会因为「同一段记录被 4609 个停止点
 * 各存一遍」而膨胀（实测：副本版 439MB，下标版 235MB，最小切片版见报告）。
 */
export function buildSessionStops(compactRecords) {
  const records = compactRecords;
  const groups = [];
  let cur = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r || r.type !== 'assistant') continue;
    const id = (r.message && r.message.id) || r.uuid || `idx:${i}`;
    const sr = (r.message && r.message.stop_reason) || null;
    if (cur && cur.id === id) {
      cur.last = i;
      if (sr) cur.stopReason = sr;
    } else {
      cur = { id, first: i, last: i, stopReason: sr };
      groups.push(cur);
    }
  }

  const stops = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const tool = lastToolName(records[g.last]);
    const isStop = g.stopReason === 'end_turn' || g.stopReason === 'stop_sequence'
      || (g.stopReason === 'tool_use' && INTERACTIVE_TOOLS.has(tool));
    if (!isStop) continue;
    const t0 = records[g.last] && records[g.last].ts;
    if (t0 == null) continue;

    // 下一条 assistant 出现时，最后一条 assistant 就不再是这个停止点了；
    // 之后的扫描看到的是新停止点，不是这一个。
    const nextAssistantIdx = gi + 1 < groups.length ? groups[gi + 1].first : -1;

    // 停止点之后到下一个 assistant 之前的记录下标。这是「在线可能的下一句」的全集；
    // 某一时刻 T 具体能看到多少由 ts ≤ T 过滤。
    const afterIdx = [];
    for (let j = g.last + 1; j < records.length; j++) {
      const r = records[j];
      if (!r) continue;
      if (r.type === 'assistant') break;
      if (r.ts != null) afterIdx.push(j);
    }

    // 地面真值（**只在离线可用**）：停止点之后第一句人话 / 新回合。
    // 报告里凡是引用它的数字都必须标「离线推断」。
    let nextConv = null;
    for (const j of afterIdx) {
      const r = records[j];
      if (r.type !== 'user' || isToolResultOnly(r)) continue;
      nextConv = { ts: r.ts, kind: originKindOf(r), text: firstText(r).slice(0, 80) };
      break;
    }
    if (!nextConv && nextAssistantIdx >= 0) nextConv = { ts: records[nextAssistantIdx].ts, kind: 'assistant', text: '' };

    // 分类器只用 history 做一件事：取**最后一条**带 permissionMode 的记录 [S§2.1]。
    // 所以不必存 50 条，只需在这个窗口里解出那一个值。production 传的是原文尾部，
    // 这里传一条合成记录 {permissionMode}，classifyStop 的 lastPermissionMode 读它，
    // evidence.permissionModeSource 仍是 'tail:last'——结果等价，代价从 50 条降到 1 个字符串。
    let permMode = null;
    for (let j = g.last; j >= Math.max(0, g.last - 49); j--) {
      const r = records[j];
      if (r && typeof r.permissionMode === 'string' && r.permissionMode) { permMode = r.permissionMode; break; }
    }

    stops.push({
      t0,
      stopIdx: g.last,
      stopReason: g.stopReason,
      lastTool: tool,
      afterIdx,
      nextAssistantIdx,
      // 记住下一条 assistant 的时间戳，判定 supersede 时不必再回查记录
      nextAssistantTs: nextAssistantIdx >= 0 ? records[nextAssistantIdx].ts : null,
      nextConv,
      permissionMode: permMode,
    });
  }
  return stops;
}

/** 从完整会话里把**停止点判定所需的最小切片**取出来。
 *
 *  只保留 stopRecord 与 afterRecords——这两样是 classifyStop 的全部输入。会话里其余
 *  记录（思考、tool_result 正文、系统注入）对判定无用；停止点之间的间隔由 calls
 *  的时间戳刻画。
 *
 *  这样缓存里的体积与「停止点数」成正比，而不是与「会话记录数」成正比。 */
export function sliceStops(records, stops) {
  for (const stop of stops) {
    stop.stopOnly = records[stop.stopIdx];
    stop.after = stop.afterIdx.map((j) => records[j]);
    delete stop.afterIdx;
    delete stop.stopIdx;
  }
  return stops;
}

// ── 语料装载 ──────────────────────────────────────────────────────────

export function parseTranscript(path) {
  const out = { records: [], calls: [], badLines: 0 };
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.records.push(JSON.parse(line)); } catch { out.badLines++; }
  }
  out.calls = callsOf(out.records);
  return out;
}

export function listTranscripts(root) {
  const out = [];
  if (!root || !existsSync(root)) return out;
  for (const project of readdirSync(root)) {
    if (project === 'memory') continue;
    const dir = join(root, project);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(dir, f);
      try {
        const s = statSync(path);
        out.push({ project, sessionId: f.slice(0, -6), path, size: s.size, mtimeMs: s.mtimeMs });
      } catch { /* 读不到就跳过，不假装它在 */ }
    }
  }
  return out;
}

function cacheKey(entry) {
  return createHash('sha1')
    .update(`v${CACHE_VERSION}|${entry.path}|${entry.size}|${entry.mtimeMs}`)
    .digest('hex').slice(0, 20);
}

/** 解析缓存。158 个会话全量解析约 27–40 秒（1.04GB），每次跑门槛扫描都付一次不值得。
 *  缓存的是**派生结果**，且记录是会话级共享的一份（停止点只存下标）：早先的实现给每个
 *  停止点各存一份前文副本，4608 × 50 条 → 322 个文件 439MB；改成共享后见文档里的实测。 */
function loadDerived(entry, { cacheDir = null } = {}) {
  const key = cacheKey(entry);
  const file = cacheDir ? join(cacheDir, `${key}.json`) : null;
  if (file && existsSync(file)) {
    try {
      const o = JSON.parse(readFileSync(file, 'utf8'));
      if (o && o.version === CACHE_VERSION && o.sessionId === entry.sessionId) return { ...o, cached: true };
    } catch { /* 缓存坏了就重算，不致命 */ }
  }
  const parsed = parseTranscript(entry.path);
  let lastRecordTs = null;
  for (let i = parsed.records.length - 1; i >= 0; i--) {
    const t = tsOf(parsed.records[i]);
    if (t != null) { lastRecordTs = t; break; }
  }
  const records = parsed.records.map(compactRecord);
  const derived = {
    version: CACHE_VERSION,
    sessionId: entry.sessionId,
    project: entry.project,
    path: entry.path,
    mtimeMs: entry.mtimeMs,
    badLines: parsed.badLines,
    recordCount: parsed.records.length,
    lastRecordTs,
    calls: parsed.calls,
    stops: sliceStops(records, buildSessionStops(records)),
  };
  if (file) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(file, JSON.stringify(derived), 'utf8');
    } catch { /* 缓存写不了只影响速度 */ }
  }
  return { ...derived, cached: false };
}

function pruneCache(cacheDir) {
  try {
    const files = readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
    if (files.length <= MAX_CACHE_FILES) return 0;
    const withTime = files.map((f) => ({ f, m: statSync(join(cacheDir, f)).mtimeMs }))
      .sort((a, b) => a.m - b.m);
    const drop = withTime.slice(0, files.length - MAX_CACHE_FILES);
    for (const d of drop) rmSync(join(cacheDir, d.file || d.f), { force: true });
    return drop.length;
  } catch { return 0; }
}

export function loadCorpus(root, { cacheDir = null } = {}) {
  const list = listTranscripts(root);
  return list.map((e) => {
    const d = loadDerived(e, { cacheDir });
    for (const stop of d.stops) stop.sessionId = d.sessionId;
    // 用 typed array 存时间戳，二分都便宜。
    d.ts = Float64Array.from(d.calls.map((c) => c.ts));
    // 记忆化容器：状态与分类结果只依赖观察时刻 T，与门槛无关。
    // 5 档门槛 × 5 个相位跑同一批 (session,T)，不共享就会把 stateAt/classifyStop
    // 重复算 5 次（实测 stateAt 约 107µs，重复部分是 50 秒级）。
    d._stateCache = new Map();
    return d;
  });
}

// ── 在线视图 ──────────────────────────────────────────────────────────

/** 观察时刻 T 能看到多少次调用。二分到最后一个 ts ≤ T 的位置。 */
export function callsUpTo(ts, t) {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function gapsOf(calls) {
  const gaps = [];
  for (let i = 1; i < calls.length; i++) {
    const d = calls[i].ts - calls[i - 1].ts;
    if (d >= 0) gaps.push(d);
  }
  return gaps;
}

/** 在时刻 T 重放一次四态判定。
 *
 *  **必须与 scan-sessions 同口径**：那边只读 transcript 尾部 4MB，再用
 *  `tailRecords(records, MAX_CALLS_PER_SESSION*3)` 截到 400 次调用；这里同样只取
 *  最近 400 次。不截会让「回放里的状态分布」优于「线上状态分布」，结论偏乐观。
 *
 *  一个不建模的差异：线上 allCalls 里还并入了子 agent 的调用（本机 3179 个
 *  subagent transcript、4.6GB，unread 的 71 个会话有子 agent）。回放只用主 transcript，
 *  因此回放里的 novelty 偏低、gaps 偏大，STALLED/FAILED 会比线上更容易出现。
 *  这个方向已知且写在报告 §六 里。 */
export function stateAt(session, t) {
  const cache = session._stateCache;
  if (cache) {
    const hit = cache.get(t);
    if (hit) return hit;
  }
  const n = callsUpTo(session.ts, t);
  const from = Math.max(0, n - MAX_CALLS_PER_SESSION);
  const calls = session.calls.slice(from, n);
  const verdict = judgeState({ calls, gapsMs: gapsOf(calls), now: t });
  const lastActivity = n > 0 ? session.ts[n - 1] : null;
  const result = { ...verdict, lastActivity, visibleCalls: n };
  if (cache) {
    // 有界：一次运行只会问同一会话的有限个时刻；超限时清空而不是无界增长。
    if (cache.size >= 20_000) cache.clear();
    cache.set(t, result);
  }
  return result;
}

/** 候选记录的行需要 fingerprint：生产用 lastActivity 的数字后缀，会话不动时保持恒定。
 *  这里照抄，去重/限额才有意义。 */
function fingerprintOf(lastActivity) {
  if (!Number.isFinite(lastActivity)) return '';
  return String(new Date(lastActivity).toISOString()).replace(/\D/g, '').slice(-10);
}

/**
 * 在时刻 T 判定一个停止点。返回 { skip } 或 { row, ... }。
 *
 * 三种 skip 的含义完全不同，必须分开记：
 *   superseded    T 时下一条 assistant 已落盘 → 最后一条 assistant 已不是这个停止点
 *                 （production 的 findStopPoint 会定位到新那个），这个停止点不会产生判决
 *   not-candidate 四态判定不是 FAILED/BLOCKED/STALLED → scan 不会把它上报为候选
 *   （kind 抑制 / 门槛抑制**不是** skip，是带 why 的观察行——生产也这么记）
 */
export function observeStop(session, stop, t, { minIdleSec = UNCLASSIFIABLE_MIN_IDLE_SEC, jobsState = null } = {}) {
  if (stop.nextAssistantTs != null && t >= stop.nextAssistantTs) return { skip: 'superseded' };

  const state = stateAt(session, t);
  const idleSec = state.lastActivity == null ? null : Math.max(0, Math.round((t - state.lastActivity) / 1000));

  if (!NOTIFY_STATES.includes(state.state)) {
    return { skip: 'not-candidate', state: state.state, reason: state.reason, idleSec };
  }

  // 在线可见的「下一句」只有已经落盘的那部分。after 里的记录时间戳可能晚于 T
  // （例如 T 之后 200ms 才写入的 system 记录），必须按 ts ≤ T 过滤，不能整段给出去。
  const visibleAfter = stop.after.filter((r) => r.ts != null && r.ts <= t);

  // history 只需要最后一条 permissionMode：classifyStop 的 lastPermissionMode 取的就是它。
  // 传一条合成记录与传 50 条原文等价（后者只有这一条字段被读到），代价低一个量级。
  const history = stop.permissionMode ? [{ type: 'meta', permissionMode: stop.permissionMode }] : [];

  const verdict = classifyStop({
    stopRecord: stop.stopOnly,
    afterRecords: visibleAfter,
    history,
    jobsState,
  });

  const kind = verdict.kind;
  let why = null;
  if (!NOTIFY_KINDS.includes(kind)) why = `${String(kind).toLowerCase().replace(/_/g, '-')}-suppressed`;
  else if (kind === 'UNCLASSIFIABLE' && Number.isFinite(idleSec) && minIdleSec > 0 && idleSec < minIdleSec) {
    why = 'unclassifiable-too-recent';
  }

  return {
    row: {
      ts: new Date(t).toISOString(),
      sessionId: session.sessionId,
      state: state.state,
      idleSec,
      kind,
      autoAnswerable: verdict.autoAnswerable === true,
      reason: verdict.reason || '',
      confidence: verdict.confidence ?? null,
      notified: why == null,
      why,
      classify: 'ok',
      stopId: (verdict.evidence && verdict.evidence.stopUuid) || null,
      fingerprint: fingerprintOf(state.lastActivity),
      // 以下两个字段不在 observations.jsonl 里，只为回放可追溯
      _stopTs: new Date(stop.t0).toISOString(),
      _scanReason: state.reason,
    },
    kind,
    idleSec,
    state: state.state,
    lastActivity: state.lastActivity,
    fingerprint: fingerprintOf(state.lastActivity),
    scanReason: state.reason,
  };
}

/** 生产不会在停止瞬间醒来：下一个 5 分钟扫描时刻。phase 用来做相位敏感性——真实
 *  进程的相是任意的，单相位结果可能只是「正好卡在边界」。 */
export function nextTick(t, phaseMs = 0) {
  return phaseMs + Math.ceil((t - phaseMs) / POLL_INTERVAL_MS) * POLL_INTERVAL_MS;
}

// ── 模型 A：单次观察 + 门槛扫描 ───────────────────────────────────────

function emptyTally() {
  return {
    stops: 0, superseded: 0, notCandidate: 0, candidates: 0, notified: 0,
    kinds: Object.create(null), states: Object.create(null),
    suppressedByWhy: Object.create(null), gateSuppressed: 0,
  };
}

/** 对全部停止点按固定延迟 d 各观察一次。 */
export function runDelayModel(sessions, { delays = DEFAULT_DELAYS_SEC, minIdleSec = UNCLASSIFIABLE_MIN_IDLE_SEC } = {}) {
  const out = {};
  for (const d of delays) {
    const tally = emptyTally();
    const rows = [];
    for (const s of sessions) {
      for (const stop of s.stops) {
        tally.stops++;
        const r = observeStop(s, stop, stop.t0 + d * 1000, { minIdleSec });
        if (r.skip === 'superseded') { tally.superseded++; continue; }
        if (r.skip) { tally.notCandidate++; continue; }
        tally.candidates++;
        tally.kinds[r.kind] = (tally.kinds[r.kind] || 0) + 1;
        tally.states[r.state] = (tally.states[r.state] || 0) + 1;
        if (r.row.why) tally.suppressedByWhy[r.row.why] = (tally.suppressedByWhy[r.row.why] || 0) + 1;
        if (r.row.why === 'unclassifiable-too-recent') tally.gateSuppressed++;
        if (r.row.notified) tally.notified++;
        rows.push(r.row);
      }
    }
    out[d] = { tally, rows };
  }
  return out;
}

// ── 模型 B：按 5 分钟扫描节奏轮询 ─────────────────────────────────────

/**
 * 生产行为的回放。
 *
 * 每个停止点只在它**仍是最后一条 assistant** 的窗口内被观察（[t0, 下一条 assistant)）：
 * 之后扫描看到的是下一个停止点，不是这一个。窗口内按 5 分钟网格取样，每次判定都重新
 * 算四态、重新分类——因为 idleSec 在涨，分类结果也会变（例如补上的 tool_result 让
 * ASKED_UNANSWERED 变成 ASKED_ANSWERED）。
 *
 * **为什么必须按扫描节奏**：观察者不会在停止后恰好 300 秒醒来。第一次扫描的 idleSec
 * 落在 [0, 300)，所以门槛只要 ≤300，第一次扫描必然抑制、第二次放行——60 与 300
 * 的生产行为完全相同。按「停止后固定 300 秒」建模会把这个事实抹掉，看起来像
 * 「门槛 60 和 300 都有意义」。
 */
export function runPollModel(sessions, {
  minIdleSec = UNCLASSIFIABLE_MIN_IDLE_SEC,
  phaseMs = 0,
  maxMs = REWATCH_MAX_MS,
} = {}) {
  // ── 第一遍：按事件时间收集「哪次扫描判了什么」
  // 每个事件记录它来自哪个停止点，因为去重键里的 state/reason/fingerprint 都由那个
  // 停止点当时的在线视图决定。观察日志去重与生产 createObservationLog 同键：
  // sessionId|state|kind|fingerprint|why —— 否则每 5 分钟就是一行，正是被显式防住的坑。
  const events = [];
  const rowSeen = new Set();
  let ticks = 0;
  let stopsSeenOnce = 0;

  for (const s of sessions) {
    for (const stop of s.stops) {
      const end = Math.min(stop.nextAssistantTs ?? Infinity, stop.t0 + maxMs);
      let sawCandidate = false;
      for (let t = nextTick(stop.t0, phaseMs); t < end; t += POLL_INTERVAL_MS) {
        ticks++;
        const r = observeStop(s, stop, t, { minIdleSec });
        if (r.skip === 'superseded') break;
        if (r.skip) continue;             // 非候选：这轮什么都不写，等下一轮
        sawCandidate = true;
        events.push({ t, stop, r });
        // 不 break：通知之后生产仍会每轮扫到它，写出 already-notified 的行。
        // 提前跳出会把「已通知但还在停」的重复观察从统计里抹掉。
      }
      if (sawCandidate) stopsSeenOnce++;
    }
  }
  events.sort((a, b) => a.t - b.t || (a.stop.t0 - b.stop.t0));

  // ── 第二遍：去重 + 限额，直接调生产实现
  //
  // 行数口径与生产一致：生产对**每一个候选**都写一行观察记录，再由
  // createObservationLog 按 `sessionId|state|kind|fingerprint|why` 去重（进程级）。
  // 所以这里也每轮写一行，只是 why 不同：
  //   why=null                      发出去的那一次
  //   why=already-notified          边沿已处理过
  //   why=budget-<gate>             撞限额
  //   why=unclassifiable-too-recent 被门槛挡下
  //   why=<kind>-suppressed         该 kind 不该通知
  // 只写「新停止点」的第一行会系统性高估通知率——那正是生产文档 §六·3 提到的
  // 「同一次停止可能留两行」的镜像错误。
  const state = emptyState();
  const sent = [];
  const suppressed = [];
  const suppressedStops = new Set();
  const already = [];
  const rows = [];
  for (const e of events) {
    const { stop, r, t } = e;
    const sessionId = stop.sessionId;
    const key = dedupeKey(sessionId, r.state, r.scanReason, r.fingerprint);
    const prior = state.notified[key];

    if (!r.row.notified) {
      // kind 抑制 / 门槛抑制：不占去重表。生产每轮都会重写同一行，键相同，
      // 但进程内的 createObservationLog 会按 why 去重 —— 所以这里也按同一键收敛。
      const rk = `${sessionId}|${r.row.state}|${r.kind}|${r.fingerprint}|${r.row.why}`;
      if (!rowSeen.has(rk)) { rowSeen.add(rk); rows.push(r.row); }
      continue;
    }

    // 边沿已处理过 → 永不再发（与 dispatchCandidates 同语义）
    if (prior && (prior.notifyCount > 0 || prior.delivery === 'failed')) {
      already.push({ t, key });
      rows.push({ ...r.row, notified: false, why: 'already-notified' });
      continue;
    }
    const gate = canNotify(state, sessionId, t);
    const entry = prior || {
      sessionId, state: r.state, reason: r.scanReason, kind: r.kind,
      firstSeenAt: new Date(t).toISOString(), lastNotifiedAt: null, notifyCount: 0, ackAt: null, source: 'scan',
    };
    if (!gate.ok) {
      entry.suppressedBy = gate.why;
      state.notified[key] = entry;
      // 抑制按**停止点**计而不是按轮次计：同一停止点每轮都撞额度，按轮次算会
      // 把「1 个卡住的会话」写成「20 次抑制」，读者会以为有 20 个信号被吞。
      if (!suppressedStops.has(stop)) {
        suppressedStops.add(stop);
        suppressed.push({ t, why: gate.why, key, kind: r.kind, stopTs: new Date(stop.t0).toISOString() });
      }
      rows.push({ ...r.row, notified: false, why: `budget-${gate.why}` });
      continue;
    }
    entry.notifyCount = 1;
    entry.lastNotifiedAt = new Date(t).toISOString();
    entry.kind = r.kind;
    entry.delivery = 'submitted';
    delete entry.suppressedBy;
    state.notified[key] = entry;
    recordSent(state, sessionId, t);
    sent.push({ t, sessionId, kind: r.kind, state: r.state, key, idleSec: r.idleSec, stopTs: new Date(stop.t0).toISOString() });
    rows.push({ ...r.row, notified: true, why: null });
  }
  return { ticks, stopsSeenOnce, observationRows: rows.length, sent, suppressed, already, rows };
}

// ── 模型 C：抑制正确率（doc §六 的缺口）───────────────────────────────

/**
 * 对在**首次扫描**被判 `unclassifiable-too-recent` 的停止点，回头核对之后真实发生了什么。
 *
 * 为什么用首次扫描而不是「停止后 300 秒」：门槛的作用点就是首次扫描。按 300 秒观察
 * 时 idleSec 必然 ≥300，永远不会被这道门挡下——那样「抑制正确率」的分母是 0，
 * 这不是结论，是建模错误。
 *
 * 分桶对应不同结论：
 *   resumed-next-tick    抑制后下一次扫描（≤5 分钟）就看到新记录 → 抑制正确，且几乎没耽误
 *   resumed-within-1h    一小时内恢复 → 抑制正确，但用户可能想知道它停了这么久
 *   resumed-after-1h     「休眠」而非卡住；抑制仍正确
 *   never-resumed        语料结束都没再动 → **可能**该通知
 *
 * 「用户关了会话」与「一直卡着」在 transcript 里不可分：两者都表现为没有新记录。
 * 唯一代理指标是 mtime：文件在最后一条记录之后还被写过，说明进程后来动过它。
 * 这只是代理，不是真值，报告里必须这么写。
 */
export function rewatchSuppressed(sessions, { minIdleSec = UNCLASSIFIABLE_MIN_IDLE_SEC, phaseMs = 0 } = {}) {
  const buckets = {
    // 以**抑制发生的那一刻**为基准，不是停止点：抑制已经发生在 t，问的是「之后多久恢复」。
    // 用停止点当基准会把「抑制前已经空了很久」算进恢复时间，结论会偏向「抑制错了」。
    'resumed-next-tick': 0,      // 下一次扫描（≤5min）就发现新记录 → 抑制正确，且几乎没耽误
    'resumed-within-1h': 0,      // 一小时内恢复 → 抑制正确
    'resumed-after-1h': 0,       // 休眠 / 隔天继续 → 抑制正确（不是卡住）
    'never-resumed': 0,          // 语料结束都没再动 → 可能该通知
  };
  const never = [];
  const samples = [];
  let suppressed = 0;
  let maxDelaySec = 0;

  for (const s of sessions) {
    for (const stop of s.stops) {
      // 找到**第一次**被门槛挡下的那个扫描时刻：门槛的作用点就是它。
      let t = null;
      let r = null;
      for (let tt = nextTick(stop.t0, phaseMs); tt < Math.min(stop.nextAssistantTs ?? Infinity, stop.t0 + REWATCH_MAX_MS); tt += POLL_INTERVAL_MS) {
        const v = observeStop(s, stop, tt, { minIdleSec });
        if (v.skip === 'superseded') break;
        if (v.skip) continue;
        if (v.row.why !== 'unclassifiable-too-recent') break;   // 已经越过门槛，不是抑制样本
        t = tt; r = v;
        break;
      }
      if (!r) continue;
      suppressed++;

      const resumeTs = stop.nextConv ? stop.nextConv.ts : null;
      const afterSuppressSec = resumeTs == null ? Infinity : (resumeTs - t) / 1000;
      let bucket;
      if (afterSuppressSec === Infinity) bucket = 'never-resumed';
      else if (afterSuppressSec <= POLL_INTERVAL_MS / 1000) bucket = 'resumed-next-tick';
      else if (afterSuppressSec <= 3600) bucket = 'resumed-within-1h';
      else bucket = 'resumed-after-1h';
      buckets[bucket]++;

      // 「可能真卡住」的两条代理，都只在离线可得：
      //   ① 语料之后再没有新记录（never-resumed），且
      //   ② 该 transcript 的 mtime 明显晚于最后一条记录（说明进程之后还活着，
      //      只是没写新记录 —— 更像「卡住/被遗弃」而不是「用户正常关掉」）。
      // 二者都不是真值，只能当作下界/上界区间来读。
      if (bucket === 'never-resumed') {
        never.push({
          sessionId: s.sessionId,
          stopTs: new Date(stop.t0).toISOString(),
          suppressedAt: new Date(t).toISOString(),
          fileTouchedLater: s.lastRecordTs != null && s.mtimeMs - s.lastRecordTs > 60_000,
          sessionIdleAtCorpusEndSec: s.lastRecordTs != null ? Math.round((s.lastRecordTs - stop.t0) / 1000) : null,
          state: r.state,
        });
      }
      if (samples.length < 500) {
        samples.push({
          sessionId: s.sessionId,
          stopTs: new Date(stop.t0).toISOString(),
          suppressAtTs: new Date(t).toISOString(),
          idleAtSuppressSec: r.idleSec,
          resumeAfterSuppressSec: Number.isFinite(afterSuppressSec) ? Math.round(afterSuppressSec) : null,
          bucket, state: r.state,
          nextKind: stop.nextConv ? stop.nextConv.kind : null,
        });
      }
      if (Number.isFinite(afterSuppressSec)) maxDelaySec = Math.max(maxDelaySec, afterSuppressSec);
    }
  }
  return { suppressed, buckets, never, samples, maxDelaySec };
}

// ── 汇总 ──────────────────────────────────────────────────────────────

/** 语料统计。在线可得的是「停止点个数 / 分类结论」；离线才可知的是
 *  「下一句是什么 / 之后多久恢复」——报告里必须标出来。 */
export function corpusSummary(sessions) {
  let stops = 0;
  let interactive = 0;
  let endTurn = 0;
  let badLines = 0;
  let records = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;
  const withStops = new Set();
  let multiStopSessions = 0;
  for (const s of sessions) {
    badLines += s.badLines || 0;
    records += s.recordCount || 0;
    if (s.stops.length > 1) multiStopSessions++;
    for (const st of s.stops) {
      stops++;
      if (st.stopReason === 'tool_use') interactive++; else endTurn++;
      withStops.add(s.sessionId);
      minTs = Math.min(minTs, st.t0);
      maxTs = Math.max(maxTs, st.t0);
    }
  }
  return {
    transcripts: sessions.length,
    sessionsWithStops: withStops.size,
    multiStopSessions,
    stops, endTurn, interactive,
    records, badLines,
    first: Number.isFinite(minTs) ? new Date(minTs).toISOString() : null,
    last: Number.isFinite(maxTs) ? new Date(maxTs).toISOString() : null,
  };
}

/** 把观察行写成 `--stats` 的格式：直接复用 watch.mjs 的 observationStats/formatStats。
 *  另写一套统计口径的结果是两份数字互相矛盾，且差异永远不会被发现。 */
export function renderStats(rows, { minIdleSec = UNCLASSIFIABLE_MIN_IDLE_SEC } = {}) {
  const work = join(tmpdir(), `ow-replay-stats-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'observations.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const stats = observationStats(work);
  const text = formatStats(stats, { minIdleSec });
  rmSync(work, { recursive: true, force: true });
  return { stats, text };
}

export function pct(n, d) {
  return d ? ((n / d) * 100).toFixed(1) : '0.0';
}

function topKinds(kinds, n = 6) {
  const total = Object.values(kinds).reduce((a, b) => a + b, 0);
  return Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `${k} ${v}(${pct(v, total)}%)`).join(' / ');
}

/** 一个停止点平均被扫描几次：观察日志的行数除以候选停止点数。不是必需的指标，
 *  但能解释为什么通知率的分母不是停止点数。 */
function emitRows(rows) {
  const dir = join(tmpdir(), 'overwatch-replay');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'observations.jsonl');
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

// ── CLI ───────────────────────────────────────────────────────────────

function parseList(s, fallback) {
  if (!s) return fallback;
  const v = String(s).split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x >= 0);
  return v.length ? v : fallback;
}

function defaultProjectsRoot() {
  return join(homedir(), '.claude', 'projects');
}

async function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const val = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
  };
  if (flags.has('--help') || flags.has('-h')) {
    console.log('用法：node scripts/replay-observe.mjs [--model delay|poll|all] [--min-idle 60,120,300]');
    console.log('      [--delays 60,300,600] [--root <projects 目录>] [--cache off] [--json] [--emit]');
    console.log('模型：delay=停止后固定延迟观察一次；poll=按 5 分钟扫描节奏轮询；all=两者都跑（默认）');
    return;
  }

  const model = val('--model', 'all');
  const root = val('--root', defaultProjectsRoot());
  const sweep = parseList(val('--min-idle', ''), [...DEFAULT_MIN_IDLE_SWEEP]);
  const delays = parseList(val('--delays', ''), [...DEFAULT_DELAYS_SEC]);
  const useCache = val('--cache', 'on') !== 'off';
  const json = flags.has('--json');
  const cacheDir = useCache ? join(tmpdir(), 'overwatch-replay-cache') : null;

  const t0 = Date.now();
  const sessions = loadCorpus(root, { cacheDir });
  const pruned = cacheDir ? pruneCache(cacheDir) : 0;
  const loadMs = Date.now() - t0;
  const corpus = corpusSummary(sessions);
  const hits = sessions.filter((s) => s.cached).length;

  const out = { corpus, loadMs, cache: { hits, misses: sessions.length - hits, pruned } };

  // ── 模型 A ──
  if (model === 'delay' || model === 'all') {
    const run = runDelayModel(sessions, { delays, minIdleSec: UNCLASSIFIABLE_MIN_IDLE_SEC });
    out.delay = {};
    for (const d of delays) {
      const { tally, rows } = run[d];
      out.delay[d] = {
        ...tally,
        notifyRatePct: Number(pct(tally.notified, tally.candidates)),
        candidateRatePct: Number(pct(tally.candidates, tally.stops)),
        rows,
      };
    }
    const pick = delays.includes(UNCLASSIFIABLE_MIN_IDLE_SEC) ? UNCLASSIFIABLE_MIN_IDLE_SEC : delays[0];
    out.statsLike = renderStats(run[pick].rows, { minIdleSec: UNCLASSIFIABLE_MIN_IDLE_SEC });
    out.statsLikeDelay = pick;
  }

  // ── 模型 B + C：每个门槛 ──
  if (model === 'poll' || model === 'all') {
    out.poll = {};
    out.rewatch = {};
    for (const tau of sweep) {
      const phases = [0, 60_000, 120_000, 180_000, 240_000];
      const runs = phases.map((phaseMs) => runPollModel(sessions, { minIdleSec: tau, phaseMs }));
      const counts = runs.map((r) => r.sent.length);
      // 每日计数只取主相位（phase 0）。跨相位求和是错的：5 个相位是同一段历史的
      // 5 种模拟，相加等于把同一天的通知数乘 5，单日上限会假性爆表。
      const byDay = new Map();
      for (const s of runs[0].sent) {
        const day = new Date(s.t).toISOString().slice(0, 10);
        byDay.set(day, (byDay.get(day) || 0) + 1);
      }
      const main = runs[0];
      out.poll[tau] = {
        sent: main.sent.length,
        sentMin: Math.min(...counts),
        sentMax: Math.max(...counts),
        alreadyNotified: main.already.length,
        budgetSuppressed: main.suppressed.length,
        budgetWhy: main.suppressed.reduce((m, x) => { m[x.why] = (m[x.why] || 0) + 1; return m; }, {}),
        observationRows: main.observationRows,
        ticks: main.ticks,
        stopsSeenOnce: main.stopsSeenOnce,
        kinds: main.sent.reduce((m, x) => { m[x.kind] = (m[x.kind] || 0) + 1; return m; }, {}),
        perDay: {
          days: byDay.size,
          max: byDay.size ? Math.max(...byDay.values()) : 0,
          over5: [...byDay.values()].filter((n) => n > 5).length,
          over10: [...byDay.values()].filter((n) => n > 10).length,
        },
        sentList: main.sent,
        rows: main.rows,
      };
      out.rewatch[tau] = rewatchSuppressed(sessions, { minIdleSec: tau });
    }
  }

  out.elapsedMs = Date.now() - t0;

  if (json) {
    const clone = JSON.parse(JSON.stringify(out));
    if (clone.delay) for (const k of Object.keys(clone.delay)) delete clone.delay[k].rows;
    if (clone.poll) for (const k of Object.keys(clone.poll)) { delete clone.poll[k].rows; delete clone.poll[k].sentList; }
    if (clone.rewatch) for (const k of Object.keys(clone.rewatch)) delete clone.rewatch[k].samples;
    console.log(JSON.stringify(clone, null, 1));
    return;
  }

  console.log(`语料：${corpus.transcripts} 个 transcript（${corpus.sessionsWithStops} 个含停止点），` +
    `${corpus.records} 条记录，坏行 ${corpus.badLines}`);
  console.log(`停止点：${corpus.stops}（end_turn/stop_sequence ${corpus.endTurn}，交互式工具 ${corpus.interactive}）  ` +
    `${corpus.first?.slice(0, 10)} ~ ${corpus.last?.slice(0, 10)}`);
  console.log(`装载：${loadMs}ms（缓存命中 ${hits}/${sessions.length}，清理 ${pruned}）`);

  if (out.delay) {
    console.log('\n模型 A · 停止后固定延迟观察一次（回答「门槛取多少」）');
    console.log(' 延迟 | 停止点 | 已被取代 | 非候选 | 候选 | 通知 | 通知率 | 门槛抑制');
    for (const d of delays) {
      const t = out.delay[d];
      console.log(` ${String(d).padStart(4)}s | ${String(t.stops).padStart(5)} | ${String(t.superseded).padStart(6)} | ${String(t.notCandidate).padStart(5)} | ` +
        `${String(t.candidates).padStart(4)} | ${String(t.notified).padStart(4)} | ${String(t.notifyRatePct).padStart(5)}% | ${t.gateSuppressed}`);
    }
    console.log(`\n— 观察期分布（同 --stats，取 ${out.statsLikeDelay}s 档）—`);
    console.log(out.statsLike.text);
  }

  if (out.poll) {
    console.log('\n模型 B · 按 5 分钟扫描节奏轮询（生产行为；跨 5 个相位的范围）');
    console.log(' 门槛 | 发出 | 跨相位 | 观察行 | 候选停止点 | 扫描次数 | 已通知跳过 | 预算抑制 | 覆盖天 | 单日最高 | >5 天 | >10 天');
    for (const tau of sweep) {
      const p = out.poll[tau];
      console.log(` ${String(tau).padStart(4)}s | ${String(p.sent).padStart(4)} | ${String(p.sentMin).padStart(2)}–${String(p.sentMax).padEnd(3)} | ` +
        `${String(p.observationRows).padStart(6)} | ${String(p.stopsSeenOnce).padStart(10)} | ${String(p.ticks).padStart(8)} | ` +
        `${String(p.alreadyNotified).padStart(8)} | ${String(p.budgetSuppressed).padStart(6)} | ` +
        `${String(p.perDay.days).padStart(6)} | ${String(p.perDay.max).padStart(6)} | ${p.perDay.over5} | ${p.perDay.over10}`);
    }
    const tau0 = sweep.includes(UNCLASSIFIABLE_MIN_IDLE_SEC) ? UNCLASSIFIABLE_MIN_IDLE_SEC : sweep[0];
    console.log(` 门槛 ${tau0}s 的通知 kind：${topKinds(out.poll[tau0].kinds) || '（无）'}`);
  }

  if (out.rewatch) {
    console.log('\n模型 C · 首次扫描被判 unclassifiable-too-recent 之后，真实发生了什么');
    console.log('（以「抑制发生的那一刻」为基准；恢复 = 出现下一句人话或新回合）');
    console.log(' 门槛 | 抑制数 | 下一轮就恢复 | ≤1h 恢复 | >1h 恢复 | 从未恢复 | 可能真卡住');
    for (const tau of sweep) {
      const r = out.rewatch[tau];
      // 「可能真卡住」= 从未恢复 且 文件在最后一条记录之后还被写过。
      // 这是代理指标，不是真值：用户正常关掉会话也会没有新记录。
      const maybeStuck = r.never.filter((x) => x.fileTouchedLater).length;
      console.log(` ${String(tau).padStart(4)}s | ${String(r.suppressed).padStart(5)} | ${String(r.buckets['resumed-next-tick']).padStart(12)} | ` +
        `${String(r.buckets['resumed-within-1h']).padStart(8)} | ${String(r.buckets['resumed-after-1h']).padStart(8)} | ` +
        `${String(r.buckets['never-resumed']).padStart(6)} | ${maybeStuck}`);
    }
  }

  if (flags.has('--emit')) {
    const base = out.poll ? out.poll[sweep.includes(UNCLASSIFIABLE_MIN_IDLE_SEC) ? UNCLASSIFIABLE_MIN_IDLE_SEC : sweep[0]].rows
      : out.delay[delays[0]].rows;
    console.log(`\n模拟观察日志：${emitRows(base)}（${base.length} 行）`);
  }

  console.log(`\n耗时 ${out.elapsedMs}ms`);
}

const isDirect = process.argv[1] && /replay-observe\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isDirect) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}

export const __internals = {
  POLL_INTERVAL_MS, TEXT_KEEP, CACHE_VERSION, MAX_CALLS_PER_SESSION, SCAN_WINDOW,
  callsUpTo, gapsOf, capText, compactRecord, firstText, fingerprintOf,
};
