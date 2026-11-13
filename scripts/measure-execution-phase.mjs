#!/usr/bin/env node
/**
 * measure-execution-phase.mjs — 「执行期中断次数」的测量器。
 *
 * 为什么另写一个，而不是改 measure-interventions.mjs：
 *   那个脚本的口径是「人工介入总数」，**把提问算作成本**（AskUserQuestion 的作答
 *   被计入 Q 类介入）。按产品侧的模型，提问是开工前的投资，不是执行期的成本。
 *   两套口径必须能同时存在、能互相换算，所以这里独立成器，不覆盖旧数字。
 *
 * 被测量的模型（用户原话，不可自行改口径）：
 *
 *     用户说一句话
 *         ↓
 *     ① AI 先读项目状态（文件夹、环境、已有代码）
 *         ↓
 *     ② 基于实际情况提问（准 + 泛）
 *         ↓
 *     ③ 用户一次答完
 *         ↓
 *     ④ AI 一口气做完，中途零介入   ← 这一段的中断次数，就是本脚本的主指标
 *
 * 三个边界定义（全部可复算，报告 §1 逐条复述）：
 *
 *   **执行起点** = 第一次「写操作」的 tool_use 时间戳。写操作 =
 *     - `Write` / `Edit` / `NotebookEdit`（任意大小写）；
 *     - 被判为改写工作区文件的 Bash / pwsh / PowerShell 命令
 *       （复用 `verify-claims.mjs` 的 `isMutatingCommand`：重定向 / heredoc / tee /
 *        sed -i / perl -i / git apply / cp / mv，且目标不是 `/tmp` 之类临时区）。
 *     没有写操作的会话 **没有执行起点**，单列一桶，不参与 A/B/C 对比。
 *
 *   **执行期** = 执行起点 → 文件最后一条记录的时间戳。墙钟时长，不是「活跃时长」。
 *
 *   **执行期中断** = 执行起点之后、**除去会话第一条人类消息**之外的人类发言条数。
 *     - 人类发言判据复用 `measure-interventions.mjs` 的 `humanTurnText`
 *       （`origin.kind !== 'human'` 排除、合成前缀排除、isMeta 排除、tool_result 排除）。
 *     - `[Request interrupted by user]` 两类变体单独计（它不是人类发的字，是宿主写的标记）。
 *     - **AskUserQuestion 的作答不计入主指标**（它是 tool_result，不是用户发的消息），
 *       但单独输出 `execAskAnswers`，并给出「并入后」的严格口径总数。理由：
 *       用户的模型明确说提问是投资；把它计进成本会让主指标回到旧口径。
 *
 * 分组（这是本脚本要回答的核心问题）：
 *   A 开工前提问：有 AskUserQuestion，且**第一次**提问发生在执行起点之前；
 *   B 开工后提问：有 AskUserQuestion，但第一次提问在执行起点之后；
 *   C 从不提问  ：全程没有 AskUserQuestion。
 *
 * 用法：
 *   node scripts/measure-execution-phase.mjs                 # 全量（--days 0）
 *   node scripts/measure-execution-phase.mjs --days 7
 *   node scripts/measure-execution-phase.mjs --json
 *   node scripts/measure-execution-phase.mjs --root <dir>
 *
 * 退出码：0 = 正常；2 = 找不到 transcript 根目录。
 *
 * 只读：不写任何文件，不碰 git。子 agent transcript 不计入（那里没有「用户发言」）。
 */

import { statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  eachLine, humanTurnText, isInterrupt, classifyHumanMessage,
  percentile, listTranscripts, defaultRoot,
} from './measure-interventions.mjs';
import { isMutatingCommand } from './verify-claims.mjs';

// ── 常量（数据，不是函数）─────────────────────────────────────────────

/** 写操作工具。大小写都出现过（`Edit` / `edit` / `write` 共 15k 次），统一小写比较。 */
export const WRITE_TOOLS = new Set(['write', 'edit', 'notebookedit', 'multiedit']);

/** 「读项目状态」的工具。**不含 WebFetch / WebSearch**：那是外部资料，不是项目状态。 */
export const READ_TOOLS = new Set([
  'read', 'read_image', 'read_image_file', 'notebookread', 'glob', 'grep', 'ls', 'list_dir',
]);

/** 需要解析 `input.command` 的 shell 工具。 */
export const SHELL_TOOLS = new Set(['bash', 'pwsh', 'powershell', 'shell', 'terminal']);

/** 人类消息文本的截断长度。只要够判「纠正/催促」，不需要全文。 */
export const TEXT_CAP = 2000;

/**
 * 「一次坐下」的空闲上限。**这是次级指标的关键参数**，不是主指标。
 *
 * 用户的模型是「用户一次答完 → AI 一口气做完」。而语料里的「会话」不是这个单位：
 * 同一个 transcript 可以跨好几天，用户第二天回来说的「继续」在物理上是新任务，
 * 不是「打断」。用**相邻记录间隔**切「坐下」：超过这个间隔，判定中间人不在。
 *
 * 取 60 分钟的实测理由：本机 AI 侧单个工具调用的正常耗时在秒到分钟级，
 * 唯一会超过 30 分钟的是长构建/长测试，而那种情况前后各有一条记录，
 * 60 分钟能把它们与「人离开了」区分开。这只是次级指标，主指标不受此参数影响。
 */
export const IDLE_GAP_MS = 60 * 60 * 1000;

// ── 纯函数：工具名与记录抽取 ─────────────────────────────────────────

/** 工具名归一化。`Edit=file_path` 这类被污染的名字不是真工具，返回 null。 */
export function normToolName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim().toLowerCase();
  if (!n || /[<>=|]/.test(n)) return null;
  return n;
}

/** 这条记录里的 tool_use 是不是「写操作」。
 *  shell 的判据交给 `isMutatingCommand`，它只认「目标带源码/文档扩展名」的写入，
 *  好处是不会把 `cp *.jar backups/` 这类产物归档算成开工。 */
export function isWriteCall(name, input) {
  const n = normToolName(name);
  if (!n) return false;
  if (WRITE_TOOLS.has(n)) return true;
  if (!SHELL_TOOLS.has(n)) return false;
  const cmd = input?.command ?? input?.script ?? input?.cmd;
  if (typeof cmd !== 'string' || !cmd) return false;
  return isMutatingCommand(cmd);
}

/** 是不是「读项目状态」的一次调用。只读 shell 命令也算（ls / cat / git log …）。 */
export function isReadCall(name, input) {
  const n = normToolName(name);
  if (!n) return false;
  if (READ_TOOLS.has(n)) return true;
  if (!SHELL_TOOLS.has(n)) return false;
  const cmd = input?.command ?? input?.script ?? input?.cmd;
  if (typeof cmd !== 'string' || !cmd) return false;
  // 只读 = 不改工作区。写操作已由 isWriteCall 先拦掉，这里剩下的都按读算。
  return !isMutatingCommand(cmd);
}

/**
 * 一条问题的选项 → label 字符串数组。
 *
 * 两个来源的 options 形状不同，必须都吃下：
 *   - assistant 的 `tool_use.input.questions`：`options: [{ label, description }]`
 *   - user 的 `toolUseResult.questions`：同形状（原样回显）
 *   - 部分宿主版本会把选项写成纯字符串（`options: ["a", "b"]`）
 * 只认字符串或带 label 的对象，其余（null / 数字）丢掉——它们不会是用户能选的答案。
 */
export function optionLabels(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => (typeof o === 'string' ? o : (typeof o?.label === 'string' ? o.label : '')))
    .filter(Boolean);
}

/**
 * AskUserQuestion 的入参 → 结构化问题列表。
 * 入参坏了（`questions` 不是数组）返回空数组：这类记录在语料里真实存在
 * （入参校验失败 6 次），不能让它把整个会话打成「提问过」。
 */
export function questionsOf(input) {
  const qs = input?.questions;
  if (!Array.isArray(qs)) return [];
  return qs.map((q) => ({
    question: typeof q?.question === 'string' ? q.question : '',
    header: typeof q?.header === 'string' ? q.header : '',
    multiSelect: q?.multiSelect === true,
    options: optionLabels(q?.options),
  })).filter((q) => q.question);
}

/**
 * 一次作答里某个答案是不是「选了选项」。
 *
 * 判据：答案字符串等于该问题某个选项的 label。否则算自由文本
 * （宿主会在选项外自动提供 `Other`，用户在那里打字）。
 * 多选时答案是数组，逐项判，返回计数。
 *
 * @param {{options:string[]}} q
 * @param {string|string[]} value
 * @returns {{option:number, free:number, chars:number}}
 */
export function classifyAnswer(q, value) {
  const vals = Array.isArray(value) ? value : [value];
  const labels = new Set(q?.options ?? []);
  let option = 0;
  let free = 0;
  let chars = 0;
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v);
    chars += s.length;
    if (labels.has(s)) option++;
    else free++;
  }
  return { option, free, chars };
}

// ── 累加器：把一条条记录喂进来 ───────────────────────────────────────

/** 新建一个会话累加器。字段全部在 `finalizeSession` 里被消费。 */
export function createAccumulator() {
  return {
    idx: 0,
    sessionId: null,
    firstTs: null,
    lastTs: null,
    /** 每个 idx 的时间戳（毫秒）。用来切「一次坐下」——见 IDLE_GAP_MS。 */
    ts: [],
    /** 执行起点之前全部记录内容的滚动哈希（FNV-1a 32 位）。
     *
     *  为什么需要它：语料里有 **fork 重放**——同一个会话被复制成多个 sessionId，
     *  历史逐条相同、时间戳到毫秒。实测一簇 3 份全被判进了 A 组，
     *  等于把一个会话数了三遍。按 sessionId 去重抓不到它们（id 不同）。
     *  注意：**前缀哈希单独用会过度合并**（同一项目同样的初始化流程 + 同一条首写
     *  命令会产生相同前缀，但之后各干各的），所以它只作为「整份内容哈希」的辅助。 */
    prefixHash: 0x811c9dc5,
    /** 看到第一次写操作那一刻的前缀哈希。 */
    prefixHashAtExec: null,
    /** **整份文件**的归一化内容哈希。
     *
     *  归一化 = 丢掉 uuid / parentUuid / sessionId / promptId 这些每条都不同的字段，
     *  只留 (timestamp, type, 工具名序列, 文本前缀)。真正被复制过的会话在这上面
     *  完全相同；只是「前缀相同、后面分叉」的会话在这上面不同。 */
    contentHash: 0x811c9dc5,
    /** 归一化内容的记录条数，用于给哈希加一重保险。 */
    contentRecords: 0,
    humanMessages: [],   // {idx, ts, text}
    interrupts: [],      // {idx, ts}
    answers: [],         // {idx, ts, toolUseId, values, questions, annotations}
    asks: [],            // {idx, ts, id, questions}
    writes: [],          // {idx, ts, name}
    reads: [],           // idx
    tools: [],           // idx（用于「执行期用了多少次工具」）
    seenToolIds: new Set(),
    seenMsgIds: new Set(),
  };
}

/** FNV-1a 32 位，喂一段字符串。返回新的哈希值。 */
export function fnv1a(h, s) {
  let x = h >>> 0;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    x ^= str.charCodeAt(i);
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return x >>> 0;
}

/**
 * 一条记录 → 归一化签名。**丢掉每条都不同的字段，也丢掉时间戳。**
 *
 * 为什么连时间戳都要丢：实测 fork 重放的两个文件内容逐条相同，但**每条记录的
 * 时间戳被整体平移了几分钟**（43d776bf 与 bb3d01f7：252 条记录里 8 条不同，
 * 全部是同一条内容的 timestamp 不同）。带时间戳的哈希永远抓不到它们。
 *
 * 代价：两条真正独立、但内容完全一样的历史会被合并。本语料里这样的对子
 * 全部是探针靶场（同一个脚本跑 N 遍），它们本来就不该各自算一个会话。
 */
export function recordSignature(o) {
  const c = o?.message?.content;
  let body = '';
  if (typeof c === 'string') body = c;
  else if (Array.isArray(c)) {
    body = c.map((b) => {
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text') return `t:${b.text ?? ''}`;
      if (b.type === 'thinking') return `k:${String(b.thinking ?? '').slice(0, 200)}`;
      if (b.type === 'tool_use') return `u:${b.name ?? ''}:${JSON.stringify(b.input ?? {}).slice(0, 400)}`;
      if (b.type === 'tool_result') return 'r';
      return b.type ?? '';
    }).join('|');
  } else if (o?.attachment) body = `att:${o.attachment.type ?? ''}`;
  const extras = o?.toolUseResult?.answers ? `ans:${JSON.stringify(o.toolUseResult.answers)}` : '';
  return [o?.type ?? '', body, extras].join('\u0001');
}

/** 记一条 idx 的时间戳。`ts` 数组与 idx 一一对应（缺值为 null）。 */
function stamp(acc, idx, ts) {
  const v = Date.parse(String(ts ?? ''));
  acc.ts[idx] = Number.isFinite(v) ? v : null;
}

/**
 * 吸收一条已解析的 transcript 记录。
 *
 * 顺序很重要，全部照抄 `measure-interventions.mjs` 的实测结论：
 *   打断标记 → 答问 → 人类发言。反过来会把 `[Request interrupted by user]`
 *   当成一句人话，或把 AskUserQuestion 的 tool_result 当成用户插话。
 *
 * @param {ReturnType<typeof createAccumulator>} acc
 * @param {object} o 一条 JSONL 记录
 */
export function absorbRecord(acc, o) {
  if (!o || typeof o !== 'object') return;
  if (o.sessionId) acc.sessionId = o.sessionId;
  if (o.timestamp) {
    if (!acc.firstTs) acc.firstTs = o.timestamp;
    acc.lastTs = o.timestamp;
  }
  // 前缀哈希：在「还没遇到执行起点」时，把每条记录的 (timestamp, type, 内容签名) 喂进去。
  // 执行起点一旦出现就冻结——那之后的分叉才是真正的分叉，不是 fork 重放。
  // 整份内容哈希则一路喂到底，用于识别整体重复的落盘。
  {
    const sig = recordSignature(o);
    if (acc.prefixHashAtExec == null) acc.prefixHash = fnv1a(acc.prefixHash, sig);
    acc.contentHash = fnv1a(acc.contentHash, sig);
    acc.contentRecords++;
  }

  if (o.type === 'assistant') {
    const blocks = o.message?.content;
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (!b || b.type !== 'tool_use') continue;
      const id = typeof b.id === 'string' ? b.id : null;
      // 同一次响应的分片会重复落盘（全量实测 123,636 个 tool_use block 里
      // 5,675 个是重复 id，内容逐字节相同）。不去重会抬高所有计数。
      if (id) {
        if (acc.seenToolIds.has(id)) continue;
        acc.seenToolIds.add(id);
      }
      const idx = acc.idx++;
      acc.tools.push(idx);
      stamp(acc, idx, o.timestamp);
      const name = normToolName(b.name);
      if (!name) continue;
      const write = isWriteCall(b.name, b.input);
      if (write) {
        if (acc.prefixHashAtExec == null) acc.prefixHashAtExec = acc.prefixHash;
        acc.writes.push({ idx, ts: o.timestamp ?? null, name });
      } else if (name === 'askuserquestion') {
        const qs = questionsOf(b.input);
        if (qs.length) acc.asks.push({ idx, ts: o.timestamp ?? null, id, questions: qs });
      } else if (isReadCall(b.name, b.input)) {
        acc.reads.push(idx);
      }
    }
    return;
  }

  if (o.type !== 'user') return;

  const idx = acc.idx++;
  stamp(acc, idx, o.timestamp);
  if (isInterrupt(o)) {
    acc.interrupts.push({ idx, ts: o.timestamp ?? null });
    return;
  }

  const tur = o.toolUseResult;
  if (tur && tur.answers && typeof tur.answers === 'object') {
    acc.answers.push({
      idx,
      ts: o.timestamp ?? null,
      toolUseId: Array.isArray(o.message?.content)
        ? (o.message.content.find((b) => b?.type === 'tool_result')?.tool_use_id ?? null)
        : null,
      values: tur.answers,
      questions: Array.isArray(tur.questions) ? tur.questions : null,
      annotations: tur.annotations && typeof tur.annotations === 'object' ? tur.annotations : null,
    });
    return;
  }

  const txt = humanTurnText(o);
  if (txt == null) return;
  acc.humanMessages.push({ idx, ts: o.timestamp ?? null, text: txt.slice(0, TEXT_CAP) });
}

// ── 会话级派生 ───────────────────────────────────────────────────────

const ms = (t) => {
  const v = Date.parse(String(t ?? ''));
  return Number.isFinite(v) ? v : null;
};

/**
 * 把累加器结算成一个会话的测量结果。
 *
 * @param {ReturnType<typeof createAccumulator>} acc
 * @param {{path:string, bytes:number, mtimeMs:number}} meta
 */
export function finalizeSession(acc, meta) {
  const firstHuman = acc.humanMessages[0] ?? null;
  const exec = acc.writes[0] ?? null;
  const firstAsk = acc.asks[0] ?? null;

  /** 执行期里的人类消息：下标严格大于执行起点，且不是会话第一条人类消息。 */
  const execHumans = exec
    ? acc.humanMessages.filter((m) => m.idx > exec.idx && (!firstHuman || m.idx !== firstHuman.idx))
    : [];
  const execAnswers = exec ? acc.answers.filter((a) => a.idx > exec.idx) : [];
  const execInterrupts = exec ? acc.interrupts.filter((x) => x.idx > exec.idx) : [];
  const execTools = exec ? acc.tools.filter((t) => t > exec.idx) : [];

  /** 执行期人类消息的分型（纠正 / 催促 / 其它）。判据与旧脚本同一实现。 */
  let corrections = 0;
  let nudges = 0;
  let normal = 0;
  for (const m of execHumans) {
    const k = classifyHumanMessage(m.text);
    if (k === 'correction') corrections++;
    else if (k === 'nudge') nudges++;
    else normal++;
  }

  /**
   * 「一次坐下」：从执行起点往前走，遇到第一个超过 IDLE_GAP_MS 的记录间隔就断。
   * 断点之后的人类发言不算「这一次的打断」——那时人已经离开过了，
   * 回来接着说是新的一段，不是上一段被打断。
   *
   * 为什么主指标不用它：主指标的定义是「执行期中断」，与用户模型同口径、可机械复算。
   * 这个指标引入了「多久算离开」这个参数，所以只作为稳健性检查输出，
   * 不替换主指标。两者结论不一致时，报告里要同时写出来。
   */
  let sittingBreakIdx = null;
  if (exec) {
    let prev = exec.ts == null ? null : Date.parse(exec.ts);
    for (let i = exec.idx + 1; i < acc.idx; i++) {
      const cur = acc.ts[i];
      if (cur == null) continue;
      if (prev != null && cur - prev > IDLE_GAP_MS) { sittingBreakIdx = i; break; }
      prev = cur;
    }
  }
  const firstSittingHumans = exec
    ? execHumans.filter((m) => sittingBreakIdx == null || m.idx < sittingBreakIdx)
    : [];
  /** 整个执行期被空闲切成了几段。1 = 一次坐下干完。 */
  let sittings = null;
  if (exec) {
    sittings = 1;
    let prev = exec.ts == null ? null : Date.parse(exec.ts);
    for (let i = exec.idx + 1; i < acc.idx; i++) {
      const cur = acc.ts[i];
      if (cur == null) continue;
      if (prev != null && cur - prev > IDLE_GAP_MS) sittings++;
      prev = cur;
    }
  }

  const startMs = exec ? ms(exec.ts) : null;
  const endMs = ms(acc.lastTs);
  const execDurationMs = startMs != null && endMs != null && endMs >= startMs ? endMs - startMs : null;

  /** 第一次提问之前读了多少项目状态。只有问过才有意义。 */
  const readsBeforeAsk = firstAsk ? acc.reads.filter((r) => r < firstAsk.idx).length : null;
  const readsBeforeExec = exec ? acc.reads.filter((r) => r < exec.idx).length : null;
  const toolsBeforeExec = exec ? acc.tools.filter((t) => t < exec.idx).length : acc.tools.length;

  /** 作答质量：把每次 answer 的每个答案按「选项 / 自由文本」拆开。 */
  let answerValues = 0;
  let answerOptions = 0;
  let answerFree = 0;
  let answerChars = 0;
  for (const a of acc.answers) {
    // `toolUseResult.questions` 是原样回显的入参，options 仍是 `[{label}]`。
    // 必须过 `optionLabels` 才能与 `answers` 里的字符串对上，否则每个答案
    // 都会被判成自由文本（这是本脚本第一版犯过的错）。
    const qs = a.questions
      ? a.questions.map((q) => ({
        question: typeof q?.question === 'string' ? q.question : '',
        options: optionLabels(q?.options),
      }))
      : (acc.asks.find((x) => x.id === a.toolUseId)?.questions ?? []);
    for (const [text, value] of Object.entries(a.values)) {
      const q = qs.find((x) => x.question === text) ?? { options: [] };
      const r = classifyAnswer(q, value);
      answerValues += r.option + r.free;
      answerOptions += r.option;
      answerFree += r.free;
      answerChars += r.chars;
    }
  }

  /** 第一次工具调用（任何工具）的 idx。用于边界敏感性检验：
   *  若把「读项目状态」也算进执行期，数字会怎样。用户的模型把读状态放在 ①，
   *  即工作之前，所以主指标不用它；但它必须被算出来，否则「边界选得巧」无法被排除。 */
  const firstToolIdx = acc.tools.length ? acc.tools[0] : null;
  const fromFirstTool = firstToolIdx == null ? [] : acc.humanMessages.filter(
    (m) => m.idx > firstToolIdx && (!firstHuman || m.idx !== firstHuman.idx),
  );

  return {
    path: meta.path,
    sessionId: acc.sessionId,
    bytes: meta.bytes,
    mtimeMs: meta.mtimeMs,
    /** 执行起点之前的内容哈希；只作为诊断输出，不用于去重（会过度合并）。 */
    prefixHash: acc.prefixHashAtExec ?? acc.prefixHash,
    /** 整份文件的归一化内容哈希 + 记录数。fork 重放识别用这两个。 */
    contentHash: acc.contentHash,
    contentRecords: acc.contentRecords,
    firstTs: acc.firstTs,
    lastTs: acc.lastTs,
    // 边界
    exec: exec ? { idx: exec.idx, ts: exec.ts, name: exec.name } : null,
    hasWrite: Boolean(exec),
    firstAskBeforeExec: Boolean(firstAsk && exec && firstAsk.idx < exec.idx),
    firstAskTs: firstAsk?.ts ?? null,
    // 计数
    humanMessages: acc.humanMessages.length,
    interrupts: acc.interrupts.length,
    asks: acc.asks.length,
    askQuestions: acc.asks.reduce((n, a) => n + a.questions.length, 0),
    answers: acc.answers.length,
    toolCalls: acc.tools.length,
    writes: acc.writes.length,
    // 主指标
    execInterruptions: execHumans.length,
    /** 敏感性检验：把边界挪到「第一次工具调用」（含只读探索）。 */
    interruptionsFromFirstTool: fromFirstTool.length,
    /** 次级：第一次坐下（执行起点 → 第一次 >60min 空闲）里的人类发言数。 */
    firstSittingInterruptions: firstSittingHumans.length,
    /** 执行期被空闲切成了几段。 */
    sittings,
    execAskAnswers: execAnswers.length,
    execInterruptMarkers: execInterrupts.length,
    execTools: execTools.length,
    execDurationMs,
    execCorrections: corrections,
    execNudges: nudges,
    execNormal: normal,
    // 次级指标
    readsBeforeAsk,
    readsBeforeExec,
    toolsBeforeExec,
    answerValues,
    answerOptions,
    answerFree,
    answerChars,
    preExecHumanMessages: exec
      ? acc.humanMessages.filter((m) => m.idx < exec.idx && (!firstHuman || m.idx !== firstHuman.idx)).length
      : Math.max(0, acc.humanMessages.length - 1),
    preExecAnswers: exec ? acc.answers.filter((a) => a.idx < exec.idx).length : acc.answers.length,
  };
}

// ── 分组与统计（纯函数）──────────────────────────────────────────────

/**
 * A / B / C 分组。
 *   A 开工前提问：有提问，且第一次提问早于执行起点；
 *   B 开工后提问：有提问，但第一次提问晚于执行起点；
 *   C 从不提问；
 *   none         没有执行起点（全程没写文件）——不参与 A/B/C 对比。
 *
 * @param {Array<ReturnType<typeof finalizeSession>>} sessions
 */
export function groupSessions(sessions) {
  const A = [];
  const B = [];
  const C = [];
  const noExec = [];
  for (const s of sessions) {
    if (!s.hasWrite) { noExec.push(s); continue; }
    if (!s.asks) C.push(s);
    else if (s.firstAskBeforeExec) A.push(s);
    else B.push(s);
  }
  return { A, B, C, noExec };
}

/** 一组数的描述统计。空数组返回全 null（不返回 0，0 会被当成实测值）。 */
export function groupStats(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return { n: 0, mean: null, median: null, p90: null, min: null, max: null, sum: 0 };
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    n: v.length,
    mean: sum / v.length,
    median: percentile(v, 0.5),
    p90: percentile(v, 0.9),
    min: Math.min(...v),
    max: Math.max(...v),
    sum,
  };
}

/** 一次性完成率：执行期中断为 0 的会话占比。分母是「有执行起点」的会话。 */
export function oneShotRate(sessions) {
  if (!sessions.length) return null;
  const zero = sessions.filter((s) => s.execInterruptions === 0).length;
  return { n: sessions.length, zero, rate: zero / sessions.length };
}

/** 秩（平均秩处理并列）。 */
export function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

/** Spearman 秩相关。n < 3 或某一列全等时返回 null（不硬造 0）。 */
export function spearman(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 3) return null;
  const a = ranks(pairs.map((p) => p[0]));
  const b = ranks(pairs.map((p) => p[1]));
  return pearsonOf(a, b);
}

/** 两列秩的 Pearson 相关。内部工具，`spearman` 与 `spearmanPartial` 共用。 */
function pearsonOf(a, b) {
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  if (!da || !db) return null;
  return num / Math.sqrt(da * db);
}

/**
 * 偏 Spearman 相关：控制第三列之后 x 与 y 的相关。
 *
 * 为什么必须有它：本语料里 `corr(执行期工具数, 执行期中断数) = 0.95`。
 * 任何「A 组中断更少」的结论，如果不扣掉任务体量，就只是「A 组的活更小」。
 * 公式用一阶偏相关：r_xy.z = (r_xy − r_xz·r_yz) / sqrt((1−r_xz²)(1−r_yz²))。
 * 三列都先取秩，所以输入可以是任意量纲。
 */
export function spearmanPartial(xs, ys, zs) {
  const rows = xs.map((x, i) => [x, ys[i], zs[i]])
    .filter(([x, y, z]) => Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z));
  if (rows.length < 4) return null;
  const a = ranks(rows.map((r) => r[0]));
  const b = ranks(rows.map((r) => r[1]));
  const c = ranks(rows.map((r) => r[2]));
  const rxy = pearsonOf(a, b);
  const rxz = pearsonOf(a, c);
  const ryz = pearsonOf(b, c);
  if (rxy == null || rxz == null || ryz == null) return null;
  const den = Math.sqrt((1 - rxz ** 2) * (1 - ryz ** 2));
  if (!den) return null;
  return (rxy - rxz * ryz) / den;
}

/** 确定性 PRNG（mulberry32）。置换检验必须可复现，所以不用 Math.random。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cliff's delta：非参数效应量，[-1, 1]。>0 表示 a 的值整体更大。 */
export function cliffsDelta(a, b) {
  if (!a.length || !b.length) return null;
  let gt = 0; let lt = 0;
  for (const x of a) {
    for (const y of b) {
      if (x > y) gt++;
      else if (x < y) lt++;
    }
  }
  return (gt - lt) / (a.length * b.length);
}

/**
 * 置换检验：a 与 b 的均值（或中位数）差是否可能由分组随机造成。
 * 返回双侧 p 值。**样本 < 8 时 p 值本身也不可信**，报告里必须同时写 n。
 *
 * @param {number[]} a
 * @param {number[]} b
 * @param {'mean'|'median'} stat
 * @param {number} iters
 * @param {number} seed
 */
export function permutationTest(a, b, stat = 'mean', iters = 5000, seed = 20261114) {
  if (a.length < 2 || b.length < 2) return null;
  const f = stat === 'median'
    ? (v) => percentile(v, 0.5)
    : (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const obs = Math.abs(f(a) - f(b));
  const pool = [...a, ...b];
  const rnd = mulberry32(seed);
  let hits = 0;
  const nA = a.length;
  for (let i = 0; i < iters; i++) {
    // Fisher-Yates 部分洗牌：只需要前 nA 个位置
    const p = [...pool];
    for (let j = 0; j < nA; j++) {
      const k = j + Math.floor(rnd() * (p.length - j));
      const t = p[j]; p[j] = p[k]; p[k] = t;
    }
    const d = Math.abs(f(p.slice(0, nA)) - f(p.slice(nA)));
    if (d >= obs - 1e-12) hits++;
  }
  return { observed: obs, p: (hits + 1) / (iters + 1), iters, stat };
}

/**
 * 按任务体量做 1:1 匹配对照：对 A 组每个会话，找执行期工具数最接近的 B 组会话。
 *
 * 为什么需要它：分层只能控制到「四分位桶」这种粗粒度，而 A/B 的体量分布严重不重叠
 * （A 的 p50 = 167，B 的 p50 = 1103）。匹配对照是**对体量最敏感**的那种比较——
 * 每一对的两边活差不多大，中断数还差多少。
 *
 * `maxLogDist` 是匹配容差（工具数比值的自然对数）。超过它的配对丢弃，
 * 因为那时「差不多大」已经不成立。丢弃数如实返回，不隐藏。
 *
 * @param {Array} aSessions
 * @param {Array} bSessions
 * @param {number} maxLogDist
 */
export function matchedPairs(aSessions, bSessions, maxLogDist = 0.7) {
  const used = new Set();
  const pairs = [];
  // 按 A 的体量从大到小配对：大任务的分歧点更能代表真实产品用法
  const sorted = [...aSessions].sort((x, y) => y.execTools - x.execTools);
  for (const a of sorted) {
    let best = null;
    let bd = Infinity;
    for (const b of bSessions) {
      if (used.has(b)) continue;
      const d = Math.abs(Math.log((b.execTools + 1) / (a.execTools + 1)));
      if (d < bd) { bd = d; best = b; }
    }
    if (!best || bd > maxLogDist) continue;
    used.add(best);
    pairs.push({
      aId: a.sessionId, bId: best.sessionId,
      aTools: a.execTools, bTools: best.execTools,
      aInterruptions: a.execInterruptions, bInterruptions: best.execInterruptions,
      aFirstSitting: a.firstSittingInterruptions, bFirstSitting: best.firstSittingInterruptions,
      logDist: Math.round(bd * 1000) / 1000,
    });
  }
  const aWins = pairs.filter((p) => p.aInterruptions < p.bInterruptions).length;
  const bWins = pairs.filter((p) => p.aInterruptions > p.bInterruptions).length;
  const ties = pairs.length - aWins - bWins;
  return {
    n: pairs.length,
    maxLogDist,
    aWins, bWins, ties,
    meanA: pairs.length ? pairs.reduce((s, p) => s + p.aInterruptions, 0) / pairs.length : null,
    meanB: pairs.length ? pairs.reduce((s, p) => s + p.bInterruptions, 0) / pairs.length : null,
    meanAFirstSitting: pairs.length
      ? pairs.reduce((s, p) => s + p.aFirstSitting, 0) / pairs.length : null,
    meanBFirstSitting: pairs.length
      ? pairs.reduce((s, p) => s + p.bFirstSitting, 0) / pairs.length : null,
    pairs,
  };
}

/** 一项指标 × 一组的可读行。`field` 指定取哪个计数（主指标 / 第一次坐下）。 */
function bucket(sessions, field = 'execInterruptions') {
  const counts = sessions.map((s) => s[field]);
  const durs = sessions.map((s) => (s.execDurationMs == null ? null : s.execDurationMs / 60000));
  const stats = groupStats(counts);
  const hours = sessions.reduce((s, x) => s + (x.execDurationMs ?? 0), 0) / 3.6e6;
  return {
    n: sessions.length,
    mean: stats.mean,
    median: stats.median,
    p90: stats.p90,
    max: stats.max,
    sum: stats.sum,
    zero: sessions.filter((s) => s[field] === 0).length,
    zeroRate: sessions.length ? sessions.filter((s) => s[field] === 0).length / sessions.length : null,
    durationMin: groupStats(durs),
    totalHours: hours,
    perHour: hours > 0 ? stats.sum / hours : null,
    corrections: sessions.reduce((s, x) => s + x.execCorrections, 0),
    nudges: sessions.reduce((s, x) => s + x.execNudges, 0),
    interruptMarkers: sessions.reduce((s, x) => s + x.execInterruptMarkers, 0),
    askAnswers: sessions.reduce((s, x) => s + x.execAskAnswers, 0),
    asks: sessions.reduce((s, x) => s + x.asks, 0),
    execTools: groupStats(sessions.map((s) => s.execTools)),
  };
}

/** `bucket` 的别名，只为调用处读起来清楚：对非主指标字段分组时用。 */
const bucket2 = bucket;

/**
 * 把会话集合汇总成完整结果。**所有数字都从这里出**，CLI 只负责打印。
 *
 * @param {Array<ReturnType<typeof finalizeSession>>} sessions
 * @param {{root:string, days:number, elapsedMs:number, duplicateSessions:number, files:number}} meta
 */
export function summarize(sessions, meta = {}) {
  const withHuman = sessions.filter((s) => s.humanMessages > 0);
  const g = groupSessions(withHuman);
  const groups = {
    A: bucket(g.A),
    B: bucket(g.B),
    C: bucket(g.C),
    none: bucket(g.noExec.map((s) => ({ ...s, execInterruptions: 0 }))),
  };

  const num = (a) => a.map((s) => s.execInterruptions);
  const tests = {
    A_vs_B_mean: permutationTest(num(g.A), num(g.B), 'mean'),
    A_vs_B_median: permutationTest(num(g.A), num(g.B), 'median'),
    A_vs_C_mean: permutationTest(num(g.A), num(g.C), 'mean'),
    A_vs_B_cliffs: cliffsDelta(num(g.A), num(g.B)),
    A_vs_C_cliffs: cliffsDelta(num(g.A), num(g.C)),
  };

  /**
   * 混淆因素：任务体量。**这一节是全部结论能否成立的关键。**
   *
   * 语料里 A 组（开工前提问）的会话本身就比 B 组短（执行期工具 p50 141 vs 1060），
   * 所以「A 的原始中断数更少」有一大半是「活更小」。这里用两种方式摊平：
   *   1. 四分位分层：按 A∪B∪C 的执行期工具数切四段，段内比 A/B/C；
   *   2. 最小工具数门槛：只留执行期工具 ≥ N 的会话。
   * 两种都做了，才能判断「提前问」的效应是不是真的存在。
   */
  const allExec = [...g.A, ...g.B, ...g.C];
  const sizes = allExec.map((s) => s.execTools).filter(Number.isFinite);
  const q1 = percentile(sizes, 0.25);
  const q2 = percentile(sizes, 0.5);
  const q3 = percentile(sizes, 0.75);
  const strata = [
    { label: `工具 ≤ ${Math.round(q1)}`, test: (s) => s.execTools <= q1 },
    { label: `${Math.round(q1)} < 工具 ≤ ${Math.round(q2)}`, test: (s) => s.execTools > q1 && s.execTools <= q2 },
    { label: `${Math.round(q2)} < 工具 ≤ ${Math.round(q3)}`, test: (s) => s.execTools > q2 && s.execTools <= q3 },
    { label: `工具 > ${Math.round(q3)}`, test: (s) => s.execTools > q3 },
  ].map(({ label, test }) => {
    const row = { label };
    for (const k of ['A', 'B', 'C']) {
      const sub = g[k].filter(test);
      const st = groupStats(num(sub));
      const fs = groupStats(sub.map((s) => s.firstSittingInterruptions));
      row[k] = {
        n: sub.length,
        mean: st.mean,
        median: st.median,
        zeroRate: sub.length ? sub.filter((s) => s.execInterruptions === 0).length / sub.length : null,
        firstSittingMean: fs.mean,
        firstSittingZeroRate: sub.length
          ? sub.filter((s) => s.firstSittingInterruptions === 0).length / sub.length : null,
      };
    }
    return row;
  });

  /** 最小工具数门槛：留在表里的会话「至少干了这么多活」。 */
  const thresholds = [0, 50, 100, 200, 400].map((min) => {
    const rows = {};
    for (const k of ['A', 'B', 'C']) {
      const sub = g[k].filter((s) => s.execTools >= min);
      const st = groupStats(num(sub));
      const fs = groupStats(sub.map((s) => s.firstSittingInterruptions));
      rows[k] = {
        n: sub.length,
        mean: st.mean,
        median: st.median,
        firstSittingMean: fs.mean,
        firstSittingMedian: fs.median,
      };
    }
    return { minTools: min, ...rows };
  });

  /**
   * 稳健性诊断。**主指标是「一个执行期被打断几次」，而执行期的长度在语料里
   * 从 2 分钟到 250 小时都有**（同一会话可以跨好几天，用户第二天回来接着干）。
   * 不把体量差异摊开，A < B 就可能只是「A 的会话本来就短」。
   * 这里给三种摊平方式：
   *   1. 每 100 次执行期工具调用摊一次；
   *   2. 小时摊一次；
   *   3. 只保留执行期 ≤ 24 小时（单次坐下干完）的会话。
   * 以及一个「读状态 + 提问」的严格子集 A′（提问前至少读过 3 次项目状态），
   * 那才是用户模型里的完整链条；A 里很多会话是「零探索直接问」。
   */
  const per100 = (arr) => groupStats(arr.map(
    (s) => (s.execTools > 0 ? (s.execInterruptions / s.execTools) * 100 : null),
  ));
  const short = (arr) => arr.filter((s) => s.execDurationMs != null && s.execDurationMs <= 864e5);
  const Apre = g.A.filter((s) => (s.readsBeforeAsk ?? 0) >= 3);
  const robust = {
    per100Tools: {
      A: per100(g.A), B: per100(g.B), C: per100(g.C),
      test: permutationTest(
        g.A.map((s) => (s.execTools > 0 ? (s.execInterruptions / s.execTools) * 100 : null)).filter(Number.isFinite),
        g.B.map((s) => (s.execTools > 0 ? (s.execInterruptions / s.execTools) * 100 : null)).filter(Number.isFinite),
        'median',
      ),
    },
    perHour: {
      A: groupStats(g.A.map((s) => (s.execDurationMs > 0 ? s.execInterruptions / (s.execDurationMs / 3.6e6) : null))),
      B: groupStats(g.B.map((s) => (s.execDurationMs > 0 ? s.execInterruptions / (s.execDurationMs / 3.6e6) : null))),
      C: groupStats(g.C.map((s) => (s.execDurationMs > 0 ? s.execInterruptions / (s.execDurationMs / 3.6e6) : null))),
    },
    singleSitting: {
      label: '执行期 ≤ 24 小时',
      A: bucket(short(g.A)),
      B: bucket(short(g.B)),
      C: bucket(short(g.C)),
      test: permutationTest(num(short(g.A)), num(short(g.B)), 'mean'),
    },
    /**
     * 主指标的最强稳健性检查：只看**第一次坐下**（执行起点 → 第一次 >60min 空闲）。
     * 它把跨天会话摊平成「这一次坐下来干的时候被打断过几次」，与用户模型里的
     * 「用户一次答完 → AI 一口气做完」同单位。参数 IDLE_GAP_MS 是次级指标参数，
     * 主指标不受它影响。
     */
    firstSitting: {
      label: '第一次坐下（>60min 空闲即断）',
      A: bucket2(g.A, 'firstSittingInterruptions'),
      B: bucket2(g.B, 'firstSittingInterruptions'),
      C: bucket2(g.C, 'firstSittingInterruptions'),
      test: permutationTest(
        g.A.map((s) => s.firstSittingInterruptions),
        g.B.map((s) => s.firstSittingInterruptions),
        'mean',
      ),
      testMedian: permutationTest(
        g.A.map((s) => s.firstSittingInterruptions),
        g.B.map((s) => s.firstSittingInterruptions),
        'median',
      ),
      cliffs: cliffsDelta(
        g.A.map((s) => s.firstSittingInterruptions),
        g.B.map((s) => s.firstSittingInterruptions),
      ),
    },
    /** 执行期被切成了几段。1 = 一次坐下，>1 = 中间离开过。 */
    sittings: {
      A: groupStats(g.A.map((s) => s.sittings)),
      B: groupStats(g.B.map((s) => s.sittings)),
      C: groupStats(g.C.map((s) => s.sittings)),
    },
    /** 体量匹配的 1:1 对照。这是对「提前问是不是更少被打断」最敏感的比较。 */
    matched: matchedPairs(g.A, g.B),
    /**
     * 边界敏感性：把「执行起点」从「第一次写操作」挪到「第一次工具调用（含只读）」。
     * 若提前问的效应在这条边界上消失，说明主指标的结果依赖于边界的挑选。
     * 用户的模型把「读项目状态」明确定在工作之前（① 在 ② 之前），所以主指标用写操作；
     * 这条只是用来证明主指标的结论不是边界造出来的。
     */
    boundaryAtFirstTool: {
      label: '边界 = 第一次工具调用（含只读）',
      A: bucket2(g.A, 'interruptionsFromFirstTool'),
      B: bucket2(g.B, 'interruptionsFromFirstTool'),
      C: bucket2(g.C, 'interruptionsFromFirstTool'),
      test: permutationTest(
        g.A.map((s) => s.interruptionsFromFirstTool),
        g.B.map((s) => s.interruptionsFromFirstTool),
        'mean',
      ),
      cliffs: cliffsDelta(
        g.A.map((s) => s.interruptionsFromFirstTool),
        g.B.map((s) => s.interruptionsFromFirstTool),
      ),
    },
    /**
     * 严格口径：执行期的人类发言 + 执行期的提问作答 + 执行期的打断标记。
     * 这是「把提问也算成成本」的旧口径与用户口径之间的中间态 —— 若连它都下降，
     * 结论就不依赖「提问不算成本」这个前提。
     */
    strict: {
      label: '执行期人类发言 + 作答 + 打断标记',
      A: groupStats(g.A.map((s) => s.execInterruptions + s.execAskAnswers + s.execInterruptMarkers)),
      B: groupStats(g.B.map((s) => s.execInterruptions + s.execAskAnswers + s.execInterruptMarkers)),
      C: groupStats(g.C.map((s) => s.execInterruptions + s.execAskAnswers + s.execInterruptMarkers)),
      test: permutationTest(
        g.A.map((s) => s.execInterruptions + s.execAskAnswers + s.execInterruptMarkers),
        g.B.map((s) => s.execInterruptions + s.execAskAnswers + s.execInterruptMarkers),
        'mean',
      ),
    },
    readThenAsk: {
      label: 'A′ 提问前读过 ≥3 次项目状态',
      n: Apre.length,
      stats: bucket(Apre),
      ids: Apre.map((s) => s.sessionId),
    },
    /** 执行期长度的分布：说明「次数」为什么不等于「体验」。 */
    duration: {
      A: groupStats(g.A.map((s) => (s.execDurationMs == null ? null : s.execDurationMs / 3.6e6))),
      B: groupStats(g.B.map((s) => (s.execDurationMs == null ? null : s.execDurationMs / 3.6e6))),
      C: groupStats(g.C.map((s) => (s.execDurationMs == null ? null : s.execDurationMs / 3.6e6))),
      unit: '小时',
    },
    /** 每次打断之间的间隔（执行期中断数 / 执行期时长），反过来说明「多久被打断一次」。 */
    gapMinutes: {
      A: groupStats(g.A.map((s) => (s.execInterruptions > 0 && s.execDurationMs > 0
        ? s.execDurationMs / s.execInterruptions / 60000 : null))),
      B: groupStats(g.B.map((s) => (s.execInterruptions > 0 && s.execDurationMs > 0
        ? s.execDurationMs / s.execInterruptions / 60000 : null))),
      C: groupStats(g.C.map((s) => (s.execInterruptions > 0 && s.execDurationMs > 0
        ? s.execDurationMs / s.execInterruptions / 60000 : null))),
    },
  };

  /** 次级指标 1：提问前读了多少项目状态（只对有提问的会话有意义）。 */
  const asking = [...g.A, ...g.B];
  const readsBeforeAsk = asking.map((s) => s.readsBeforeAsk);
  const readStats = {
    all: groupStats(readsBeforeAsk),
    A: groupStats(g.A.map((s) => s.readsBeforeAsk)),
    B: groupStats(g.B.map((s) => s.readsBeforeAsk)),
    corrWithExecInterruptions: spearman(readsBeforeAsk, num(asking)),
    /** 读状态与任务体量的相关。**这是判「读得多」到底是好还是大**的关键：
     *  若它与执行期工具数同样高，说明「读得多」只是「活更大」的另一种说法。 */
    corrWithExecTools: spearman(readsBeforeAsk, asking.map((s) => s.execTools)),
    /** 控制任务体量之后，读状态与中断还剩多少相关。 */
    partialCorr: spearmanPartial(readsBeforeAsk, num(asking), asking.map((s) => s.execTools)),
  };

  /**
   * 全语料上的体量-中断关系。**这是全部对比的天花板**：
   * 若 corr(工具数, 中断数) 接近 1，那么任何 A/B/C 的差异都首先是体量差异。
   */
  const execAll = [...g.A, ...g.B, ...g.C];
  const sizeCorr = {
    corrToolsInterruptions: spearman(execAll.map((s) => s.execTools), num(execAll)),
    corrDurationInterruptions: spearman(
      execAll.map((s) => s.execDurationMs), num(execAll),
    ),
    corrAsksInterruptions: spearman(execAll.map((s) => s.asks), num(execAll)),
  };
  /** 提问质量代理：自由文本作答占比、回答长度。 */
  const answered = sessions.filter((s) => s.answerValues > 0);
  const freeRatio = answered.map((s) => (s.answerValues ? s.answerFree / s.answerValues : null));
  const quality = {
    sessionsWithAnswers: answered.length,
    answerValues: answered.reduce((n, s) => n + s.answerValues, 0),
    answerOptions: answered.reduce((n, s) => n + s.answerOptions, 0),
    answerFree: answered.reduce((n, s) => n + s.answerFree, 0),
    freeRatio: (() => {
      const v = answered.reduce((n, s) => n + s.answerValues, 0);
      return v ? answered.reduce((n, s) => n + s.answerFree, 0) / v : null;
    })(),
    perSessionFreeRatio: groupStats(freeRatio),
    answerChars: groupStats(answered.map((s) => (s.answerValues ? s.answerChars / s.answerValues : null))),
    corrReadsVsFreeRatio: spearman(readsBeforeAsk, asking.map((s) => (s.answerValues ? s.answerFree / s.answerValues : null))),
    freeRatioA: (() => {
      const v = g.A.reduce((n, s) => n + s.answerValues, 0);
      return v ? g.A.reduce((n, s) => n + s.answerFree, 0) / v : null;
    })(),
    freeRatioB: (() => {
      const v = g.B.reduce((n, s) => n + s.answerValues, 0);
      return v ? g.B.reduce((n, s) => n + s.answerFree, 0) / v : null;
    })(),
  };

  /** 两套口径在同一语料上的并排数字（回应「提问算成本」那条质疑）。 */
  const totals = {
    files: meta.files ?? sessions.length,
    sessions: sessions.length,
    humanSessions: withHuman.length,
    bytes: sessions.reduce((n, s) => n + (s.bytes || 0), 0),
    humanMessages: sessions.reduce((n, s) => n + s.humanMessages, 0),
    asks: sessions.reduce((n, s) => n + s.asks, 0),
    askQuestions: sessions.reduce((n, s) => n + s.askQuestions, 0),
    answers: sessions.reduce((n, s) => n + s.answers, 0),
    writes: sessions.reduce((n, s) => n + s.writes, 0),
    execSessions: withHuman.filter((s) => s.hasWrite).length,
    noExecSessions: withHuman.filter((s) => !s.hasWrite).length,
    execInterruptions: withHuman.reduce((n, s) => n + s.execInterruptions, 0),
    execAskAnswers: withHuman.reduce((n, s) => n + s.execAskAnswers, 0),
    execInterruptMarkers: withHuman.reduce((n, s) => n + s.execInterruptMarkers, 0),
    preExecHumanMessages: withHuman.reduce((n, s) => n + s.preExecHumanMessages, 0),
    preExecAnswers: withHuman.reduce((n, s) => n + s.preExecAnswers, 0),
  };
  // 旧口径：除会话首条以外的全部人类发言 + 全部作答。这正是 measure-interventions.mjs
  // 的介入池子（它还含插话/纠正/催促的分型，但总数是这两类之和减去「正常对话」后的部分；
  // 这里只给同语料上的可比总数，不冒充那个脚本的分型）。
  const oldStyle = {
    nonFirstHumanMessages: sessions.reduce(
      (n, s) => n + Math.max(0, s.humanMessages - (s.humanMessages > 0 ? 1 : 0)), 0,
    ),
    answers: totals.answers,
    sum: 0,
  };
  oldStyle.sum = oldStyle.nonFirstHumanMessages + oldStyle.answers;

  const perSession = withHuman.map((s) => ({
    sessionId: s.sessionId,
    path: s.path,
    group: !s.hasWrite ? 'none' : !s.asks ? 'C' : s.firstAskBeforeExec ? 'A' : 'B',
    execTs: s.exec?.ts ?? null,
    execName: s.exec?.name ?? null,
    execInterruptions: s.execInterruptions,
    firstSittingInterruptions: s.firstSittingInterruptions,
    interruptionsFromFirstTool: s.interruptionsFromFirstTool,
    sittings: s.sittings,
    strictInterruptions: s.execInterruptions + s.execAskAnswers + s.execInterruptMarkers,
    execAskAnswers: s.execAskAnswers,
    execTools: s.execTools,
    execDurationMs: s.execDurationMs,
    humanMessages: s.humanMessages,
    asks: s.asks,
    askQuestions: s.askQuestions,
    readsBeforeAsk: s.readsBeforeAsk,
    answerValues: s.answerValues,
    answerFree: s.answerFree,
    corrections: s.execCorrections,
    nudges: s.execNudges,
    interruptMarkers: s.execInterruptMarkers,
  }));

  return {
    meta: {
      root: meta.root ?? null,
      days: meta.days ?? 0,
      elapsedMs: meta.elapsedMs ?? null,
      duplicateSessions: meta.duplicateSessions ?? 0,
      forkDuplicates: meta.forkDuplicates ?? 0,
    },
    definitions: {
      executionStart: '第一次 Write/Edit/NotebookEdit，或第一次被 isMutatingCommand 判为改写工作区文件的 Bash/pwsh/PowerShell。',
      executionInterruption: '执行起点之后、除会话第一条人类消息之外的人类发言条数；AskUserQuestion 的作答不计入（单独输出）。',
      groups: {
        A: '有 AskUserQuestion，且第一次提问早于执行起点',
        B: '有 AskUserQuestion，但第一次提问晚于执行起点',
        C: '全程没有 AskUserQuestion',
        none: '没有写操作（无执行起点），不参与 A/B/C 对比',
      },
    },
    totals,
    oldStyle,
    groups,
    tests,
    strata,
    thresholds,
    robust,
    readStats,
    sizeCorr,
    quality,
    oneShot: {
      all: oneShotRate(withHuman.filter((s) => s.hasWrite)),
      A: oneShotRate(g.A),
      B: oneShotRate(g.B),
      C: oneShotRate(g.C),
    },
    perSession,
  };
}

// ── 扫描与 CLI ───────────────────────────────────────────────────────

/** 预过滤：只有这三类记录会影响判定，其余不解析。 */
const RELEVANT = ['"type":"assistant"', '"type":"user"'];

/**
 * 分析一个 transcript 文件。
 * @param {string} path
 */
export function analyzeFile(path) {
  const acc = createAccumulator();
  eachLine(path, (line) => {
    if (!line) return;
    let hit = false;
    for (const k of RELEVANT) if (line.includes(k)) { hit = true; break; }
    if (!hit) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    absorbRecord(acc, o);
  });
  const st = statSync(path);
  return finalizeSession(acc, { path, bytes: st.size, mtimeMs: st.mtimeMs });
}

/** CLI 主流程：列文件 → 逐份分析 → 按 sessionId 去重 → 汇总。 */
export function run({ root = defaultRoot(), days = 0, nowMs = Date.now() } = {}) {
  const sinceMs = days > 0 ? nowMs - days * 86400e3 : 0;
  const files = listTranscripts(root).filter((f) => days <= 0 || f.mtimeMs >= sinceMs);
  const analyzed = [];
  for (const f of files) {
    let r;
    try { r = analyzeFile(f.path); } catch { continue; }
    if (r.humanMessages === 0) continue;
    analyzed.push(r);
  }

  // 同一 sessionId 可能有多份落盘（宿主早期快照）。保留人类发言最多的一份，
  // 相同则取字节更大者——与 measure-interventions.mjs 同一条去重规则。
  const byId = new Map();
  for (const r of analyzed) {
    const key = r.sessionId ?? r.path;
    const prev = byId.get(key);
    if (!prev) { byId.set(key, r); continue; }
    const better = r.humanMessages > prev.humanMessages
      || (r.humanMessages === prev.humanMessages && r.bytes > prev.bytes);
    if (better) byId.set(key, r);
  }
  const bySession = [...byId.values()];

  // 第二道去重：**fork 重放 / 重复落盘**。
  //
  // 同一段历史被复制成多个 sessionId（或同一 sessionId 存了两份）时，整份归一化内容
  // 完全相同。实测这类簇最大一簇 12 份，其中一簇 3 份全被判进 A 组 —— 等于把一个
  // 会话数了三遍。只用「执行起点之前的内容哈希」会**过度合并**：同一项目同样的
  // 初始化流程 + 同一条首写命令会产生相同前缀，但之后各干各的（实测某簇里两份
  // 人类发言 6 vs 28、执行期工具 119 vs 108，是两段真实工作，不是重放）。
  //
  // 因此键 = 整份内容哈希 + 记录数。两份都相同才算同一条历史。
  // 保留「执行期更长」的那一份，相同则取字节更大的。
  const byPrefix = new Map();
  for (const r of bySession) {
    const key = `c:${r.contentHash}:${r.contentRecords}`;
    const prev = byPrefix.get(key);
    if (!prev) { byPrefix.set(key, r); continue; }
    const better = (r.execDurationMs ?? 0) > (prev.execDurationMs ?? 0)
      || ((r.execDurationMs ?? 0) === (prev.execDurationMs ?? 0) && r.bytes > prev.bytes);
    if (better) byPrefix.set(key, r);
  }
  const kept = [...byPrefix.values()];
  return summarize(kept, {
    root,
    days,
    duplicateSessions: analyzed.length - kept.length,
    forkDuplicates: bySession.length - kept.length,
    files: files.length,
  });
}

const L = (s = '') => process.stdout.write(`${s}\n`);
const f1 = (x) => (x == null || !Number.isFinite(x) ? '—' : (Math.round(x * 10) / 10).toString());
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);

/** 人读报告。所有数字来自 summarize 的结果对象，不在这一层重算。 */
export function formatReport(res) {
  const { totals: t, groups: g, tests, strata, thresholds, robust, readStats, sizeCorr, quality, oneShot, oldStyle } = res;
  const out = [];
  out.push('');
  out.push('执行期中断次数 · 口径与分组对比');
  out.push('='.repeat(70));
  out.push(`根目录 ${res.meta.root}　窗口 ${res.meta.days > 0 ? `${res.meta.days} 天` : '全量'}`
    + `　文件 ${t.files}　去重丢弃 ${res.meta.duplicateSessions}（其中 fork 重放 ${res.meta.forkDuplicates}）`);
  out.push('');
  out.push('── 口径 ──────────────────────────────────────────────────────────────');
  out.push('执行起点 = 第一次 Write/Edit/NotebookEdit，或第一次改写工作区文件的 Bash（isMutatingCommand）');
  out.push('执行期中断 = 执行起点之后、除会话首条人类消息之外的人类发言；提问作答不计入（单独列）');
  out.push('A 开工前提问 / B 开工后提问 / C 从不提问 / none 无写操作');
  out.push('');
  out.push('── 语料 ──────────────────────────────────────────────────────────────');
  out.push(`会话 ${t.sessions}（有人类发言 ${t.humanSessions}，其中写过文件 ${t.execSessions}、纯只读 ${t.noExecSessions}）`);
  out.push(`人类发言 ${t.humanMessages}　提问 ${t.asks} 次 / ${t.askQuestions} 题　作答 ${t.answers} 次　写操作 ${t.writes} 次`);
  out.push('');
  out.push('── 主指标：执行期中断次数 ────────────────────────────────────────────');
  const head = ['组', 'n', 'mean', 'median', 'p90', 'max', '零中断率', '时长median(min)', '每小时间断'];
  out.push(`  ${head[0].padEnd(6)}${head[1].padStart(5)}${head[2].padStart(8)}${head[3].padStart(8)}`
    + `${head[4].padStart(7)}${head[5].padStart(6)}${head[6].padStart(10)}${head[7].padStart(16)}${head[8].padStart(12)}`);
  for (const [k, label] of [['A', 'A 开工前'], ['B', 'B 开工后'], ['C', 'C 从不问']]) {
    const b = g[k];
    out.push(`  ${label.padEnd(8)}${String(b.n).padStart(5)}${f1(b.mean).padStart(8)}${f1(b.median).padStart(8)}`
      + `${f1(b.p90).padStart(7)}${String(b.max ?? '—').padStart(6)}${pct(b.zeroRate).padStart(10)}`
      + `${f1(b.durationMin.median).padStart(16)}${f1(b.perHour).padStart(12)}`);
  }
  out.push(`  （无写操作的会话 ${g.none.n} 个，不计入上表）`);
  out.push('');
  out.push('执行期中断的构成（全组求和）：');
  for (const [k, label] of [['A', 'A 开工前'], ['B', 'B 开工后'], ['C', 'C 从不问']]) {
    const b = g[k];
    out.push(`  ${label.padEnd(8)} 纠正 ${String(b.corrections).padStart(4)}　催促 ${String(b.nudges).padStart(4)}`
      + `　打断标记 ${String(b.interruptMarkers).padStart(3)}　执行期作答 ${String(b.askAnswers).padStart(3)}`
      + `　执行期工具 p50 ${f1(b.execTools.median)}`);
  }
  out.push('');
  out.push('A vs B 置换检验（5000 次，确定性种子）：');
  const fmtTest = (name, r) => (r
    ? `  ${name.padEnd(14)} 观测差 ${f1(r.observed)}　双侧 p = ${r.p.toFixed(4)}`
    : `  ${name.padEnd(14)} 样本不足，未检验`);
  out.push(fmtTest('均值差', tests.A_vs_B_mean));
  out.push(fmtTest('中位数差', tests.A_vs_B_median));
  out.push(fmtTest('A vs C 均值', tests.A_vs_C_mean));
  out.push(`  Cliff's delta：A vs B ${tests.A_vs_B_cliffs == null ? '—' : tests.A_vs_B_cliffs.toFixed(3)}`
    + `　A vs C ${tests.A_vs_C_cliffs == null ? '—' : tests.A_vs_C_cliffs.toFixed(3)}`);
  out.push('');
  out.push('按执行期工具数分层（控制任务体量这个混淆因素）：');
  for (const s of strata) {
    out.push(`  ${s.label.padEnd(22)}`
      + ` A n=${String(s.A.n).padStart(2)} mean ${f1(s.A.mean)} med ${f1(s.A.median)} 首坐0中断 ${pct(s.A.firstSittingZeroRate)}`
      + ` ｜ B n=${String(s.B.n).padStart(2)} mean ${f1(s.B.mean)} med ${f1(s.B.median)} 首坐0中断 ${pct(s.B.firstSittingZeroRate)}`
      + ` ｜ C n=${String(s.C.n).padStart(2)} mean ${f1(s.C.mean)} med ${f1(s.C.median)}`);
  }
  out.push('');
  out.push('最小工具数门槛（留在表里的会话至少干了这么多活）：');
  out.push('  门槛      A n  A mean  A 首坐mean  ｜   B n  B mean  B 首坐mean  ｜   C n  C mean');
  for (const r of thresholds) {
    out.push(`  ≥${String(r.minTools).padEnd(5)}`
      + `${String(r.A.n).padStart(5)}${f1(r.A.mean).padStart(8)}${f1(r.A.firstSittingMean).padStart(12)}`
      + `  ｜${String(r.B.n).padStart(5)}${f1(r.B.mean).padStart(8)}${f1(r.B.firstSittingMean).padStart(12)}`
      + `  ｜${String(r.C.n).padStart(5)}${f1(r.C.mean).padStart(8)}`);
  }
  out.push('');
  out.push('── 稳健性：把「执行期有多长」摊开 ────────────────────────────────────');
  out.push(`执行期时长（小时）：A median ${f1(robust.duration.A.median)}　B median ${f1(robust.duration.B.median)}`
    + `　C median ${f1(robust.duration.C.median)}　（p90 A ${f1(robust.duration.A.p90)} / B ${f1(robust.duration.B.p90)}）`);
  out.push(`每 100 次执行期工具调用的中断：A median ${f1(robust.per100Tools.A.median)}`
    + `　B median ${f1(robust.per100Tools.B.median)}　C median ${f1(robust.per100Tools.C.median)}`
    + `　（A vs B 中位数置换检验 p = ${robust.per100Tools.test ? robust.per100Tools.test.p.toFixed(4) : '—'}）`);
  out.push(`每小时间断：A median ${f1(robust.perHour.A.median)}　B median ${f1(robust.perHour.B.median)}`
    + `　C median ${f1(robust.perHour.C.median)}`);
  out.push(`平均多久被打断一次（分钟）：A ${f1(robust.gapMinutes.A.median)}　B ${f1(robust.gapMinutes.B.median)}`
    + `　C ${f1(robust.gapMinutes.C.median)}`);
  out.push(`只看单次坐下干完（执行期 ≤ 24h）：A n=${robust.singleSitting.A.n} mean ${f1(robust.singleSitting.A.mean)}`
    + `　B n=${robust.singleSitting.B.n} mean ${f1(robust.singleSitting.B.mean)}`
    + `　C n=${robust.singleSitting.C.n} mean ${f1(robust.singleSitting.C.mean)}`
    + `　（A vs B p = ${robust.singleSitting.test ? robust.singleSitting.test.p.toFixed(4) : '—'}）`);
  out.push(`A′ 读状态后再问（提问前读 ≥3 次，n=${robust.readThenAsk.n}）：`
    + `mean ${f1(robust.readThenAsk.stats.mean)}　median ${f1(robust.readThenAsk.stats.median)}`
    + `　零中断 ${pct(robust.readThenAsk.stats.zeroRate)}`);
  out.push('');
  out.push('── 第一次坐下（执行起点 → 第一次 >60min 空闲）───────────────────────');
  out.push(`执行期被切成几段：A median ${f1(robust.sittings.A.median)}　B median ${f1(robust.sittings.B.median)}`
    + `　C median ${f1(robust.sittings.C.median)}（1 = 一次坐下干完）`);
  for (const [k, label] of [['A', 'A 开工前'], ['B', 'B 开工后'], ['C', 'C 从不问']]) {
    const b = robust.firstSitting[k];
    out.push(`  ${label.padEnd(8)} n=${String(b.n).padStart(3)}　mean ${f1(b.mean)}　median ${f1(b.median)}`
      + `　p90 ${f1(b.p90)}　零中断 ${pct(b.zeroRate)}`);
  }
  out.push(`  A vs B（第一次坐下）：均值 p = ${robust.firstSitting.test ? robust.firstSitting.test.p.toFixed(4) : '—'}`
    + `　中位数 p = ${robust.firstSitting.testMedian ? robust.firstSitting.testMedian.p.toFixed(4) : '—'}`
    + `　Cliff's delta = ${robust.firstSitting.cliffs == null ? '—' : robust.firstSitting.cliffs.toFixed(3)}`);
  out.push('');
  out.push('── 两条敏感性检验 ────────────────────────────────────────────────────');
  const bt = robust.boundaryAtFirstTool;
  out.push(`边界挪到「第一次工具调用」：A n=${bt.A.n} mean ${f1(bt.A.mean)} med ${f1(bt.A.median)}`
    + ` ｜ B n=${bt.B.n} mean ${f1(bt.B.mean)} med ${f1(bt.B.median)}`
    + ` ｜ p = ${bt.test ? bt.test.p.toFixed(4) : '—'}　delta ${bt.cliffs == null ? '—' : bt.cliffs.toFixed(3)}`);
  const st = robust.strict;
  out.push(`严格口径（发言+作答+打断）：A n=${st.A.n} mean ${f1(st.A.mean)} med ${f1(st.A.median)}`
    + ` ｜ B n=${st.B.n} mean ${f1(st.B.mean)} med ${f1(st.B.median)}`
    + ` ｜ p = ${st.test ? st.test.p.toFixed(4) : '—'}`);
  out.push('');
  out.push('── 体量匹配对照（1:1，容差 log 比 ≤ 0.7）─────────────────────────────');
  const mp = robust.matched;
  out.push(`配对 ${mp.n} 对：A 胜 ${mp.aWins}　B 胜 ${mp.bWins}　平 ${mp.ties}`
    + `　A mean ${f1(mp.meanA)}　B mean ${f1(mp.meanB)}`
    + `　A 首坐 mean ${f1(mp.meanAFirstSitting)}／B 首坐 mean ${f1(mp.meanBFirstSitting)}`);
  for (const p of mp.pairs) {
    out.push(`  A ${p.aId.slice(0, 8)} 工具 ${String(p.aTools).padStart(5)} 中断 ${String(p.aInterruptions).padStart(3)}`
      + ` ｜ B ${p.bId.slice(0, 8)} 工具 ${String(p.bTools).padStart(5)} 中断 ${String(p.bInterruptions).padStart(3)}`);
  }
  out.push('');
  out.push('── 次级指标 ──────────────────────────────────────────────────────────');
  out.push(`一次性完成率（执行期零中断）：全部 ${pct(oneShot.all?.rate)} (${oneShot.all?.zero}/${oneShot.all?.n})`
    + `　A ${pct(oneShot.A?.rate)} (${oneShot.A?.zero}/${oneShot.A?.n})`
    + `　B ${pct(oneShot.B?.rate)} (${oneShot.B?.zero}/${oneShot.B?.n})`
    + `　C ${pct(oneShot.C?.rate)} (${oneShot.C?.zero}/${oneShot.C?.n})`);
  out.push(`第一次提问前读项目状态：全体 median ${f1(readStats.all.median)}（n=${readStats.all.n}）`
    + `　A median ${f1(readStats.A.median)}　B median ${f1(readStats.B.median)}`);
  out.push(`  Spearman(提问前读数, 执行期中断) = ${readStats.corrWithExecInterruptions == null ? '—' : readStats.corrWithExecInterruptions.toFixed(3)}`);
  out.push(`  Spearman(提问前读数, 执行期工具数) = ${readStats.corrWithExecTools == null ? '—' : readStats.corrWithExecTools.toFixed(3)}`
    + `　控制体量后的偏相关 = ${readStats.partialCorr == null ? '—' : readStats.partialCorr.toFixed(3)}`);
  out.push(`全语料体量-中断相关：工具数 ${sizeCorr.corrToolsInterruptions == null ? '—' : sizeCorr.corrToolsInterruptions.toFixed(3)}`
    + `　时长 ${sizeCorr.corrDurationInterruptions == null ? '—' : sizeCorr.corrDurationInterruptions.toFixed(3)}`
    + `　提问数 ${sizeCorr.corrAsksInterruptions == null ? '—' : sizeCorr.corrAsksInterruptions.toFixed(3)}`);
  out.push(`作答质量：${quality.answerValues} 个答案里自由文本 ${quality.answerFree}（${pct(quality.freeRatio)}）；`
    + `平均答案长度 ${f1(quality.answerChars.mean)} 字符`);
  out.push(`  自由文本占比 A ${pct(quality.freeRatioA)}　B ${pct(quality.freeRatioB)}`
    + `　Spearman(提问前读数, 自由文本占比) = ${quality.corrReadsVsFreeRatio == null ? '—' : quality.corrReadsVsFreeRatio.toFixed(3)}`);
  out.push('');
  out.push('── 两套口径并排（同一语料）──────────────────────────────────────────');
  out.push(`旧口径（提问算成本）：非首条人类发言 ${oldStyle.nonFirstHumanMessages} + 作答 ${oldStyle.answers}`
    + ` = ${oldStyle.sum}`);
  out.push(`新口径（提问是投资）：执行期人类发言 ${t.execInterruptions}（执行期作答 ${t.execAskAnswers} 另计，`
    + `打断标记 ${t.execInterruptMarkers} 另计）`);
  out.push(`执行前：人类发言 ${t.preExecHumanMessages}、作答 ${t.preExecAnswers} —— 新口径下这部分成本为 0`);
  out.push('');
  return out.join('\n');
}

function parseArgs(argv) {
  const out = { days: 0, json: false, root: defaultRoot() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a.startsWith('--days=')) out.days = Number(a.slice(7));
    else if (a === '--root') out.root = argv[++i];
    else if (a.startsWith('--root=')) out.root = a.slice(7);
  }
  if (!Number.isFinite(out.days)) out.days = 0;
  return out;
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('measure-execution-phase.mjs');

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.root)) {
    process.stderr.write(`找不到 transcript 根目录：${opts.root}\n`);
    process.exit(2);
  }
  const t0 = process.hrtime.bigint();
  const res = run(opts);
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
  res.meta.elapsedMs = Math.round(elapsed);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(res));
    process.stdout.write(`耗时 ${elapsed.toFixed(0)} ms\n`);
  }
}
