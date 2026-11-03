#!/usr/bin/env node
/**
 * stop-signals.mjs — 停机原因的**确定性**判据集合，以及它对真实语料的覆盖率。
 *
 * 目的只有一个：回答「不依赖 AI，用确定性规则能判到什么程度」。
 * 所以本文件的设计原则与 classify-stop.mjs 不同：
 *
 *   classify-stop.mjs 追求「判得准」，判不了就 UNCLASSIFIABLE（宁缺勿滥）。
 *   本文件追求「判得出」，因为要测的是**上限**——确定性信号最多能覆盖多少。
 *   两者互补：本文件给出「能判的那部分」，剩下的差额才是 AI 真正要补的。
 *
 * 判据全部是结构性的（记录类型、字段、工具名、哈希），**没有一条读自然语言语义**。
 * 唯一的文本匹配是「问句结尾」与「错误关键词」，且都在函数注释里写明它只是代理信号。
 *
 * 每个判据返回 { hit: boolean, value: any, evidence: string }，没有 `null` 语义含糊：
 * 判不了就是 hit:false 并在 evidence 里说明为什么判不了。
 *
 * 用法：
 *   node scripts/stop-signals.mjs                 # 扫描全部会话，打印命中统计
 *   node scripts/stop-signals.mjs --json          # 机器可读
 *   node scripts/stop-signals.mjs --project <slug>
 *   node scripts/stop-signals.mjs --limit 50      # 只扫最新的 50 个（按 mtime）
 *   node scripts/stop-signals.mjs --samples 3     # 「判不了」的样本各打印几条，用来看差额
 *
 * 零依赖。
 */

import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync, readFileSync as rf } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { endsWithQuestion } from './asked.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 尾部读取上限。和 watch.mjs 的 TAIL_READ_BYTES 同量级：一次读盘几十毫秒。 */
export const TAIL_BYTES = 512 * 1024;
/** 头部读取上限。用来取「人类原始目标」——通常在第一条真人消息里。 */
export const HEAD_BYTES = 512 * 1024;

/** 死循环判据的默认窗口与阈值。 */
export const LOOP_WINDOW = 8;
export const LOOP_REPEAT = 3;

/** 上下文接近上限的阈值（与 compact_boundary 的 preTokens 对照）。 */
export const CONTEXT_NEAR_FULL_RATIO = 0.85;

// ── 基础读取 ────────────────────────────────────────────────────────

/** 按偏移读一段。不整读文件——语料里最大的单个 transcript 有 116MB。 */
export function readSlice(path, offset, length) {
  let size;
  try { size = statSync(path).size; } catch { return { text: '', truncated: false }; }
  const n = Math.max(0, Math.min(length, size - offset));
  if (n <= 0) return { text: '', truncated: false };
  const buf = Buffer.allocUnsafe(n);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, n, offset); } finally { closeSync(fd); }
  return { text: buf.toString('utf8'), truncated: n < size };
}

/** 解析 JSONL 文本。坏行丢弃——一条坏行不该让整个会话判不了。 */
export function parseRecords(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 截断或坏行 */ }
  }
  return out;
}

/** 读尾部记录。被截断的首行必然不完整，先丢掉。 */
export function readTail(path, maxBytes = TAIL_BYTES) {
  let size;
  try { size = statSync(path).size; } catch { return { records: [], truncated: false }; }
  const offset = Math.max(0, size - maxBytes);
  const { text, truncated } = readSlice(path, offset, maxBytes);
  const body = truncated ? text.slice(text.indexOf('\n') + 1) : text;
  return { records: parseRecords(body), truncated };
}

/** 读头部记录。被截断的末行同理丢掉。 */
export function readHead(path, maxBytes = HEAD_BYTES) {
  let size;
  try { size = statSync(path).size; } catch { return { records: [], truncated: false }; }
  const { text, truncated } = readSlice(path, 0, maxBytes);
  const body = truncated ? text.slice(0, text.lastIndexOf('\n')) : text;
  return { records: parseRecords(body), truncated };
}

// ── 判据 1：真的停下来了 ────────────────────────────────────────────

/**
 * 最后一条 assistant 记录已经说完、且没有留下未执行的 tool_use。
 *
 * 为什么不是「最后一条是 assistant」：同一轮会产生 thinking / text 多条 assistant
 * 记录，最后一条是 text 并不等于停下来。真正的判据是**末尾没有 tool_use**。
 *
 * 注意 `stop_reason: 'tool_use'` 的两种含义：AskUserQuestion / ExitPlanMode 也会
 * 用它，但那种情况末尾**确实有** tool_use 块——按内容判，不按 stop_reason 判。
 */
export function endsWithoutToolUse(records) {
  const arr = Array.isArray(records) ? records : [];
  let lastAssistant = -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] && arr[i].type === 'assistant') { lastAssistant = i; break; }
  }
  if (lastAssistant < 0) return { hit: false, value: null, evidence: 'no-assistant-record' };
  const rec = arr[lastAssistant];
  const blocks = Array.isArray(rec.message && rec.message.content) ? rec.message.content : [];
  const toolUses = blocks.filter((b) => b && b.type === 'tool_use');
  if (toolUses.length > 0) {
    return { hit: false, value: toolUses.map((b) => b.name), evidence: 'pending-tool-use' };
  }
  const hasText = blocks.some((b) => b && b.type === 'text' && String(b.text || '').trim());
  return {
    hit: true,
    value: { hasText, stopReason: (rec.message && rec.message.stop_reason) || null },
    evidence: hasText ? 'assistant-text-no-tool' : 'assistant-silent-no-tool',
  };
}

// ── 判据 2：失败停机 ────────────────────────────────────────────────

/** 错误记录的识别。实测语料里的形态见 2026-11-02-deterministic-signals.md 第四节：
 *  `isApiErrorMessage: true` + `error: "authentication_failed"`，
 *  或 `error: { message: "524 {\"error\":{\"type\":\"bad_response_status_code\"...}" }`。 */
export function errorOf(rec) {
  if (!rec || rec.type !== 'assistant') return null;
  const err = rec.error ?? (rec.isApiErrorMessage ? rec.message && rec.message.content : null);
  if (err === null || err === undefined || err === false) return null;
  const text = typeof err === 'string' ? err : JSON.stringify(err);
  if (!text || text === 'null' || text === 'false') return null;
  return { text: text.slice(0, 200), at: rec.timestamp || null };
}

/**
 * 末尾 N 条记录里是否出现 API/工具错误。只看 assistant 记录上的 error 字段，
 * 不看正文里的「错误」二字——那是叙述，不是事实。
 */
export function hasRecentError(records, window = 20) {
  const arr = Array.isArray(records) ? records : [];
  const tail = arr.slice(-window);
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = errorOf(tail[i]);
    if (e) return { hit: true, value: e, evidence: 'assistant-error-field' };
  }
  return { hit: false, value: null, evidence: 'no-error-field-in-window' };
}

// ── 判据 3：死循环 ──────────────────────────────────────────────────

/** 工具调用指纹：工具名 + 参数的稳定序列化。参数里 key 顺序不影响指纹。 */
export function toolFingerprint(name, input) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = norm(v[k]);
      return o;
    }
    return v;
  };
  let s;
  try { s = JSON.stringify(norm(input ?? null)); } catch { s = String(input); }
  return `${name}:${s}`;
}

/** 取出记录里全部 tool_use 的指纹，按出现顺序。 */
export function toolCallSequence(records) {
  const seq = [];
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || rec.type !== 'assistant') continue;
    const blocks = Array.isArray(rec.message && rec.message.content) ? rec.message.content : [];
    for (const b of blocks) {
      if (b && b.type === 'tool_use') seq.push({ fp: toolFingerprint(b.name, b.input), name: b.name, at: rec.timestamp || null });
    }
  }
  return seq;
}

/**
 * 同一次工具调用 + 同一份参数在最近 window 次调用里出现 >= repeat 次。
 *
 * 为什么这个是确定性的：不需要理解参数含义，只需要「完全相同」。
 * 实测反例：同一条 `npm test` 连跑 3 次是合法的调试；所以判据命中 ≠ 卡死，
 * 只是**需要人看的可疑信号**。这一点写在报告里，不在代码里装作能分辨。
 */
export function detectLoop(records, { window = LOOP_WINDOW, repeat = LOOP_REPEAT } = {}) {
  const seq = toolCallSequence(records).slice(-window);
  const counts = new Map();
  for (const c of seq) counts.set(c.fp, (counts.get(c.fp) || 0) + 1);
  for (const [fp, n] of counts) {
    if (n >= repeat) {
      const name = (seq.find((c) => c.fp === fp) || {}).name || '?';
      return {
        hit: true,
        value: { name, repeats: n, window: seq.length, fingerprint: fp.slice(0, 120) },
        evidence: 'identical-tool-call-repeated',
      };
    }
  }
  return { hit: false, value: null, evidence: `max-repeat-below-${repeat}` };
}

// ── 判据 4：上下文接近上限 ──────────────────────────────────────────

/**
 * 最后一次请求的 input_tokens 是否接近已观测到的 compact 阈值。
 *
 * 诚实的限制：**没有上限值可以读**。transcript 里没有 context window 大小字段。
 * 所以本判据只能给两件事：
 *   1. compact_boundary 的 compactMetadata.preTokens —— 这是实测过的触发点；
 *   2. 尾部的最大 input+cache 计数 —— 当前水位。
 * 只有同时拿到两者才能算比例；否则只能报「水位」而不能判「接近」。
 */
export function contextPressure(records) {
  const arr = Array.isArray(records) ? records : [];
  let watermark = 0;
  let lastAt = null;
  for (const rec of arr) {
    if (!rec || rec.type !== 'assistant') continue;
    const u = rec.message && rec.message.usage;
    if (!u) continue;
    const total = Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0);
    if (total > watermark) { watermark = total; lastAt = rec.timestamp || null; }
  }
  let compactThreshold = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i] && arr[i].compactMetadata;
    if (m && Number.isFinite(Number(m.preTokens))) { compactThreshold = Number(m.preTokens); break; }
  }
  if (compactThreshold && watermark) {
    const ratio = watermark / compactThreshold;
    return {
      hit: ratio >= CONTEXT_NEAR_FULL_RATIO,
      value: { watermark, compactThreshold, ratio: Number(ratio.toFixed(3)), lastAt },
      evidence: 'ratio-to-observed-compact-threshold',
    };
  }
  return {
    hit: false,
    value: { watermark, compactThreshold, ratio: null, lastAt },
    evidence: compactThreshold ? 'no-usage' : 'no-compact-boundary-observed',
  };
}

// ── 判据 5：人类原始目标 ────────────────────────────────────────────

/** 真人消息的判据：origin.kind === 'human'。不用正则匹配 "user"，那会把
 *  tool_result（也是 user 记录）算进去。 */
export function isHumanMessage(rec) {
  return Boolean(rec && rec.type === 'user' && rec.origin && rec.origin.kind === 'human');
}

/** 会话里的全部真人消息，按时间顺序。 */
export function humanMessages(records) {
  return (Array.isArray(records) ? records : []).filter(isHumanMessage).map((r) => ({
    text: textOfUserRecord(r),
    at: r.timestamp || null,
  }));
}

function textOfUserRecord(rec) {
  const c = rec && rec.message && rec.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  return '';
}

/**
 * 头部第一条真人消息 = 原始目标。这是**唯一**能确定「用户到底要什么」的来源，
 * 而且是确定性的：不需要理解它，只需要取出它。
 * 判据的边界在「取出」之后：判断「这个目标做完了没有」需要语义理解。
 *
 * 兜底：`queue-operation`（operation=enqueue）也带着人类输入的原文。
 * 实测 30 个「头部无真人消息」的会话里，多数前 512KB 被 file-history-snapshot 占满，
 * 真人消息落在截断之外——但 queue-operation 仍在头部。这是同一份输入的两个落点。
 * 它同时也会承载 task-notification，所以必须过滤掉，否则会把系统通知当目标。
 */
export function originalGoalFrom(headRecords) {
  const humans = humanMessages(headRecords);
  if (humans.length) {
    const first = humans[0];
    return {
      hit: true,
      value: { text: first.text, at: first.at, chars: first.text.length, source: 'human-record' },
      evidence: 'first-human-record-in-head',
    };
  }
  const queued = (Array.isArray(headRecords) ? headRecords : [])
    .filter((r) => r && r.type === 'queue-operation' && r.operation === 'enqueue' && typeof r.content === 'string')
    .map((r) => ({ text: r.content, at: r.timestamp || null }))
    .filter((q) => q.text.trim() && !/^\s*<task-notification>/.test(q.text));
  if (queued.length) {
    return {
      hit: true,
      value: { text: queued[0].text, at: queued[0].at, chars: queued[0].text.length, source: 'queue-operation' },
      evidence: 'enqueue-content-in-head',
    };
  }
  return { hit: false, value: null, evidence: 'no-human-message-in-head' };
}

// ── 判据 6：用户是否已经回答过最后那个问题 ──────────────────────────

/**
 * AskUserQuestion / ExitPlanMode 之后有没有 tool_result。
 * 用 tool_use_id 精确配对——文本搜索会把工具说明里的示例也算进去。
 */
export function questionAnswered(records) {
  const arr = Array.isArray(records) ? records : [];
  const answered = new Set();
  for (const rec of arr) {
    if (!rec || rec.type !== 'user') continue;
    const c = rec.message && rec.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) if (b && b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id);
  }
  for (let i = arr.length - 1; i >= 0; i--) {
    const rec = arr[i];
    if (!rec || rec.type !== 'assistant') continue;
    const c = rec.message && rec.message.content;
    if (!Array.isArray(c)) continue;
    const ask = c.find((b) => b && b.type === 'tool_use' && (b.name === 'AskUserQuestion' || b.name === 'ExitPlanMode'));
    if (!ask) continue;
    return answered.has(ask.id)
      ? { hit: false, value: { name: ask.name, id: ask.id }, evidence: 'answered' }
      : { hit: true, value: { name: ask.name, id: ask.id }, evidence: 'structured-question-unanswered' };
  }
  return { hit: false, value: null, evidence: 'no-structured-question' };
}

// ── 判据 7：最后一句是问句（文本代理，已知会漏）────────────────────

/** 复用 asked.mjs 的 endsWithQuestion，避免两套问句规则分叉。 */
export function lastTextIsQuestion(records) {
  const arr = Array.isArray(records) ? records : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const rec = arr[i];
    if (!rec || rec.type !== 'assistant') continue;
    const c = rec.message && rec.message.content;
    if (!Array.isArray(c)) continue;
    const text = c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('').trim();
    if (!text) continue;
    return { hit: endsWithQuestion(text), value: text.slice(-160), evidence: 'text-last-line' };
  }
  return { hit: false, value: null, evidence: 'no-assistant-text' };
}

// ── 综合：一个会话一个结论 ──────────────────────────────────────────

/**
 * 把全部判据套到一个会话上，给出**一个**停机原因。
 *
 * 判定顺序是设计决策（依据 [hosted §2.2] 地面真值 → 结构性事实 → 文本）：
 *   1. 还在干活（末尾有 tool_use）→ NOT_STOPPED，不进统计
 *   2. 失败停机（有 error 字段）→ ERROR_STOP      —— 结构性，最硬
 *   3. 结构化提问未答 → WAITING_ANSWER            —— 结构性
 *   4. 上下文触顶（compact 刚发生）→ CONTEXT_RESET —— 结构性
 *   5. 死循环 → LOOP_SUSPECT                      —— 结构性
 *   6. 文本问句 → QUESTION_TEXT                   —— 文本代理
 *   7. 其余 → STOPPED_SILENT（说完了，没在问任何东西）
 *
 * 第 7 类不是「判不了」，它本身就是**最大的一类**，而且结论明确：
 * AI 没有在等任何东西。真正判不了的是「它说的『做完了』是不是真的」——
 * 这属于 COMPLETION 语义，代码里单独标出来，不计入 1–6。
 */
export function classifySession({ tailRecords, headRecords = [], historyRecords = null, nowMs = Date.now() } = {}) {
  const tail = Array.isArray(tailRecords) ? tailRecords : [];
  // 死循环必须看**前文**，不能只看本轮的记录：一次轮次里通常只有 1–3 次工具调用，
  // 窗口永远凑不够 repeat。实测这个 bug 让轮次级 LOOP_SUSPECT 从 50 掉到 0。
  const history = Array.isArray(historyRecords) ? historyRecords : tail;
  const stop = endsWithoutToolUse(tail);
  const signals = {
    stopped: stop,
    error: hasRecentError(tail),
    loop: detectLoop(history),
    context: contextPressure(tail),
    question: questionAnswered(tail),
    // 「对话还在等你」的文本代理。**判据本身精度很低**，原因见报告第五节：
    // 实测 115 例「确实在等你」的话里，100% 不以问号结尾。
    // 这一判据只保留作为对照，不作为停机的首选分类依据。
    textQuestion: lastTextIsQuestion(tail),
    goal: originalGoalFrom(headRecords),
  };
  const goalOk = signals.goal.hit;

  // 先判「结构化提问未答」再判「还在干活」：AskUserQuestion / ExitPlanMode 的
  // 停止点**确实带着一个未执行的 tool_use**（见 classify-stop.mjs 文件头）。按
  // 「有 tool_use 就是在干活」先判，会把真正在等人回答的会话全部算成在干活。
  // 实测这个顺序错误让 WAITING_ANSWER 从应有的数量掉到 0。
  if (signals.question.hit) {
    return { kind: 'WAITING_ANSWER', confidence: 'measured', signals, goalOk, detail: signals.question.value.name };
  }
  if (!stop.hit) {
    return { kind: 'NOT_STOPPED', confidence: 'measured', signals, goalOk, detail: stop.evidence };
  }
  if (signals.error.hit) {
    return { kind: 'ERROR_STOP', confidence: 'measured', signals, goalOk, detail: signals.error.value.text };
  }
  // compact 边界出现在尾部 = 刚压缩过；此时「停下」多半是压缩后的重启点
  const cm = tail.filter((r) => r && r.type === 'system' && r.compactMetadata).length;
  if (cm > 0) {
    return { kind: 'CONTEXT_RESET', confidence: 'measured', signals, goalOk, detail: `compact_boundary x${cm}` };
  }
  if (signals.loop.hit) {
    return { kind: 'LOOP_SUSPECT', confidence: 'measured', signals, goalOk, detail: `${signals.loop.value.name} x${signals.loop.value.repeats}` };
  }
  if (signals.textQuestion.hit) {
    return { kind: 'QUESTION_TEXT', confidence: 'low', signals, goalOk, detail: signals.textQuestion.value };
  }
  return { kind: 'STOPPED_SILENT', confidence: 'measured', signals, goalOk, detail: 'said-something-then-stopped' };
}

export const KINDS = Object.freeze([
  'NOT_STOPPED', 'ERROR_STOP', 'WAITING_ANSWER', 'CONTEXT_RESET',
  'LOOP_SUSPECT', 'QUESTION_TEXT', 'STOPPED_SILENT',
]);

// ── CLI：对全部会话跑一遍 ───────────────────────────────────────────

export function listTranscripts(projectsRoot) {
  const out = [];
  let dirs;
  try { dirs = readdirSync(projectsRoot); } catch { return out; }
  for (const d of dirs) {
    const dp = join(projectsRoot, d);
    let st;
    try { st = statSync(dp); } catch { continue; }
    if (!st.isDirectory()) continue;
    let entries;
    try { entries = readdirSync(dp); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue;
      const p = join(dp, e);
      let fs2;
      try { fs2 = statSync(p); } catch { continue; }
      out.push({ path: p, project: d, sessionId: e.slice(0, -6), mtimeMs: fs2.mtimeMs, size: fs2.size });
    }
  }
  return out;
}

export function scanAll({ projectsRoot = join(homedir(), '.claude', 'projects'), limit = 0, nowMs = Date.now() } = {}) {
  let files = listTranscripts(projectsRoot).sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (limit > 0) files = files.slice(0, limit);
  const rows = [];
  for (const f of files) {
    const tail = readTail(f.path);
    const head = f.size > TAIL_BYTES ? readHead(f.path) : { records: [] };
    // 小文件头尾重叠：头就是全部，不必再读一次
    const headRecords = head.records.length ? head.records : tail.records;
    const verdict = classifySession({ tailRecords: tail.records, headRecords, nowMs });
    rows.push({
      sessionId: f.sessionId,
      project: f.project,
      sizeMB: Number((f.size / 1e6).toFixed(1)),
      idleMin: Math.round((nowMs - f.mtimeMs) / 60000),
      tailTruncated: tail.truncated,
      ...verdict,
    });
  }
  return { files: files.length, rows };
}

export function summarize(rows) {
  const byKind = {};
  for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  const stopped = rows.filter((r) => r.kind !== 'NOT_STOPPED');
  const deterministic = stopped.filter((r) => r.kind !== 'QUESTION_TEXT' && r.kind !== 'STOPPED_SILENT');
  const withGoal = rows.filter((r) => r.goalOk).length;
  return {
    total: rows.length,
    notStopped: rows.length - stopped.length,
    stopped: stopped.length,
    byKind,
    // 确定性判据给出**具体原因**的占比（分母是停下来的会话）
    deterministicCause: deterministic.length,
    // 结构性事实（非文本代理）能给出结论的占比
    structuralShare: stopped.length ? Number((deterministic.length / stopped.length).toFixed(4)) : 0,
    goalRecoverable: withGoal,
    goalShare: rows.length ? Number((withGoal / rows.length).toFixed(4)) : 0,
  };
}

function pct(n, d) { return d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a'; }

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 0 : 0;
  const projIdx = args.indexOf('--project');
  const project = projIdx >= 0 ? args[projIdx + 1] : null;
  const samplesIdx = args.indexOf('--samples');
  const samples = samplesIdx >= 0 ? Number(args[samplesIdx + 1]) || 0 : 0;
  const rootIdx = args.indexOf('--root');
  const root = rootIdx >= 0 ? args[rootIdx + 1] : join(homedir(), '.claude', 'projects');

  const t0 = Date.now();
  let { files, rows } = scanAll({ projectsRoot: root, limit });
  if (project) rows = rows.filter((r) => r.project === project);
  const elapsed = Date.now() - t0;
  const s = summarize(rows);

  if (json) {
    process.stdout.write(JSON.stringify({ files, elapsedMs: elapsed, summary: s, rows }, null, 2) + '\n');
    return 0;
  }

  console.log(`会话数 ${s.total}（共 ${files} 个 transcript，扫了 ${elapsed} ms）`);
  console.log(`还在干活（末尾有未执行 tool_use）：${s.notStopped}`);
  console.log(`停下来：${s.stopped}`);
  console.log('');
  console.log('停机原因分布：');
  for (const k of KINDS) {
    if (!s.byKind[k]) continue;
    const n = s.byKind[k];
    console.log(`  ${k.padEnd(16)} ${String(n).padStart(4)}  ${pct(n, s.stopped).padStart(6)}`);
  }
  console.log('');
  console.log(`结构性判据给出具体原因：${s.deterministicCause} / ${s.stopped} = ${pct(s.deterministicCause, s.stopped)}`);
  console.log(`原始目标可从日志取出：${s.goalRecoverable} / ${s.total} = ${pct(s.goalRecoverable, s.total)}`);

  if (samples > 0) {
    console.log('');
    console.log(`── STOPPED_SILENT 样本（最多 ${samples} 条）——`);
    for (const r of rows.filter((x) => x.kind === 'STOPPED_SILENT').slice(0, samples)) {
      console.log(`  [${r.project}] ${r.idleMin}min idle  goal=${JSON.stringify((r.signals.goal.value || {}).text || '').slice(0, 120)}`);
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv));
}

void ROOT;
