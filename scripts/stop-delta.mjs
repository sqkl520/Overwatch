#!/usr/bin/env node
/**
 * stop-delta.mjs — 会话停下时，「磁盘上到底多了什么」能不能被机械核对。
 *
 * 这里约束的是**记录**，不是行为。本文件不做拦截，只做记账：
 * 给每次交还算一个可逐条复算的 delta 判定，比例进停机报告。
 *
 * ## 更正：此处原先写着一组无法复现的数字（`DF-034`，2026-11-18）
 *
 * 原文写「实测 21 个文件、50 次真实 block，只有 1 次后面跟着工具调用」，
 * 用它论证「钩子改变不了模型要不要停」。**三路复核都对不上**：
 *
 *   · 台账：`tasks/runs/stop-hook/*.jsonl` 共 327 条，`outcome:"blocked"` **只有 1 条**，
 *     且来自 `hook-e2e` 沙箱 —— 真实主会话的拦截次数是 **0**。
 *   · transcript（6467 份非沙箱）：`【第 N 次拦截】` 出现 70 次，其中 **59 次在子 agent 文件里**
 *     （那是父会话传下去的 reason 或子 agent 复述，不是 Stop 事件）。
 *   · `docs/research/` 与 `tasks/` 全文：没有任何文件记录过这次测量。
 *
 * 所以那组数字**在这台机器上没有任何数据支撑**。删掉，不留。
 *
 * 为什么这比一个普通笔误严重：它被用来论证**「不要拦」**这个产品决定。
 * 一个无法复现的数字，如果恰好支持你原本想做的事，最容易不被检查。
 *
 * 现在（2026-11-18）Stop 闸已改成 `block` 模式（commit `859d144`），真实的拦截会带
 * `outcome:"blocked"` 落进台账。**那才是唯一可信的来源。** 攒到 20+ 次真实 blocked 之后，
 * 再用当时的数据回答「有多少次后面跟着验证调用」，把结论写进 `DF-034`。
 * 在那之前，这个问题**没有答案** —— 不要用任何一方的数字填空。
 *
 * ## 定义
 *
 *   令 H = transcript 中最后一条 isHumanMessage 记录的索引
 *   令 C = { 本轮（index > H）写入类工具调用触及的路径 }
 *         ∪ { 本轮发生的、isMutatingCommand 为真的 shell 命令 }
 *   令 M = 末条 assistant 文本
 *   grounding = |{ c ∈ C : c 以字符串形式出现在 M 中 }|
 *
 * 「以字符串形式出现」按 **路径全名或 basename** 计。为什么不用全路径：实测 772 条
 * 停机里，全路径命中 12 条、basename 命中 112 条 —— 人话里说的是文件名，不是盘上路径。
 * 只认全路径会把 100 条真实接地判成没接地，那是一个自己造出来的指标。
 * 反过来的代价见下面第 2 条「判不了」。
 *
 * ## 三条「判不了」（写在这里，不要在后来的某次改动里悄悄当成能判）
 *
 * 1. **健全性**：「还差什么」是不是**真的**还差那些 —— 判不了。本文件只判它说没说。
 * 2. **完备性**：「还差什么」是不是**全** —— 判不了。这和「测试预言机不可判定」是
 *    同构的问题：要判完备，必须先知道全部应做项，而那个清单本身没有可信来源。
 *    basename 命中同理：同名不同目录的文件会被算成同一次接地。
 * 3. **「我做完了」是否成立** —— 判不了。`verify-claims` 能核对的是「文本断言 vs 记录
 *    里的调用」，核对不了「调用是否达成了目标」。
 *
 * 所以 `GROUNDED` 的语义是「**它引用了本轮真实发生过的改动**」，
 * **不是**「它说的是真的」。任何把这个判定读成「完成度」的用法都是误读。
 *
 * ## 为什么 delta 不进拦截面
 *
 * 接地要求可被「做一次无效编辑、然后引用那个文件名」满足。用一个已知可被满足的条件
 * 去锁用户的门，只会把闸门变成一道仪式。所以：只记账、只计数、只显示。
 * `NO_DELTA` **不在** `stop-verify-hook.mjs` 的 `BLOCKING_STATUS` 里。
 *
 * 零依赖。
 */

import { buildEvidenceIndex, isMutatingCommand, lastAssistantText } from './verify-claims.mjs';
// **不 import `stop-signals.mjs`。** 那两个纯谓词下沉到本文件（见下方 `isHumanMessage` /
// `errorOf`），由 `stop-signals` 反过来 re-export。
//
// 为什么必须打破这个环：此前是 `stop-signals → stop-delta → stop-signals`。它能跑，
// 只因为两边都在**调用时**用对方的**函数声明**（hoisted）。一旦任一侧改成
// `const f = ...`、或在模块顶层用到对方的值，就是 TDZ 报错 —— 而且报错点在启动期，
// 不是某条路径上。
//
// 现在 `scan-sessions.mjs` 要 import 本文件（把 delta 接到行上），那条环就会被拉进
// TUI 的数据通路。所以现在打破，而不是等它炸。
//
// 从 `measure-interventions.mjs` 复用「真人发言」的三个判据分量 —— 那边的实现是实测
// 出来的（380 条真实人类消息没有 origin；中断标记两种变体 195/20 次），重写一份必然
// 漂移。
import {
  userText, SYNTHETIC_PREFIX, CONTINUATION, INTERRUPT_RE,
} from './measure-interventions.mjs';

/** 真人消息的判据。
 *
 *  **`origin.kind` 不能作为必要条件。** 这一条本仓早就知道，`measure-interventions.mjs`
 *  的 `humanTurnText()` 注释里逐字写着：「2.1.270 之前的版本不写这个字段，实测 380 条
 *  真实人类消息没有 origin」。而这里此前用了 `origin.kind === 'human'` 当**唯一**判据，
 *  于是在真实语料上「本轮」边界大面积失效。
 *
 *  2026-11-16 全库实测（874 个含用户文本的 transcript）：
 *
 *      两者都有的文件         : 223
 *      只有 userType=external : 651   ← 旧判据完全漏掉
 *      只有 origin.kind=human : 0     ← 从不单独出现
 *      两者都没有             : 3
 *
 *  即 `origin.kind === 'human'` 是 `userType === 'external'` 的**真子集**。漏掉的后果
 *  不是少报：`lastHumanIndex` 返回 -1 → `boundary = 'whole-file'` → **整个文件的改动集
 *  被当成「本轮」**，于是「本轮」这个守门条件在 87% 的 GROUNDED 上是空转的。
 *
 *  现在的判据与 `measure-interventions.mjs` 同源，三道门：
 *    1. 有可见文本（tool_result / image-only 不算）
 *    2. 不是宿主合成的（`SYNTHETIC_PREFIX`）
 *    3. 不是中断标记 / 压缩续接提示
 *
 *  第 1、2 条与第 3 条的中断标记**直接复用**那边的实现，不在这里重写一份——
 *  两份判据必然漂移，这个仓库为这件事付过多次账。
 *
 *  **不用正则匹配 "user"** —— `tool_result` 也是 `user` 记录，那样会把工具结果
 *  当成用户发话。这个坑在 L2 叫停路径里也踩过一次（会话会自己解锁自己）。 */
export function isHumanMessage(rec) {
  if (!rec || rec.type !== 'user') return false;
  // 有 `origin` 且不是 human 的（task-notification / peer / tool）必须排除。
  // **但不能要求它存在** —— 见上方注释。
  if (rec.origin && rec.origin.kind !== 'human') return false;
  // `isMeta` 是宿主写的上下文，不是人打的。
  if (rec.isMeta) return false;
  const t = userText(rec);
  if (t == null) return false;
  const trimmed = t.trim();
  if (!trimmed) return false;
  // 宿主合成的前缀（system-reminder / command-* / local-command-* …）
  if (SYNTHETIC_PREFIX.test(trimmed)) return false;
  // 压缩续接提示
  if (trimmed.startsWith(CONTINUATION)) return false;
  // 打断标记。**两种变体，实测都出现**（195 次 / 20 次）；只匹配前者会让后者漏进来，
  // 而漏进来比漏掉更糟 —— 它会被当成「本轮起点」，于是整份文件被当作本轮。
  if (INTERRUPT_RE.test(trimmed)) return false;
  // **必须由宿主明确标记为「外部输入」。** 两个标记任取其一：
  //   `origin.kind === 'human'`（老版本 / 部分启动方式）
  //   `userType === 'external'`（`promptSource: sdk` 的记录只有这个）
  // 2026-11-16 全库实测：159,065 条 user 记录里，**没有一条**两个标记都缺。
  // 所以「两个都没有」不是「老记录」，是「不是人类发言」—— 拒绝，而不是放行。
  // 这个判据比「三道门全都过就放行」更严，但它有实测支撑，而那个宽松版本只是猜测。
  if (rec.origin && rec.origin.kind === 'human') return true;
  if (rec.userType === 'external') return true;
  return false;
}

/** 错误记录的形状。`index` 是给 `computeDelta` 用的：它要判「错误记录之后有没有回合
 *  可写」，只有时间戳不够 —— 同一毫秒内的多条记录无法排序，而下标就是时间。 */
export function errorOf(rec, index = null) {
  if (!rec || rec.type !== 'assistant') return null;
  const err = rec.error ?? (rec.isApiErrorMessage ? rec.message && rec.message.content : null);
  if (err === null || err === undefined || err === false) return null;
  const text = typeof err === 'string' ? err : JSON.stringify(err);
  if (!text || text === 'null' || text === 'false') return null;
  return { text: text.slice(0, 200), at: rec.timestamp || null, index };
}

/** 最后一条错误记录的下标。没有就是 -1。
 *
 *  `scan-sessions` 自己也需要它（喂 `computeDelta` 的 `errorIndex`）。**不要在 scan 里
 *  再写一份错误识别** —— 两份判据必然漂移，这个仓库为这件事付过多次账。
 *
 *  与 `stop-signals` 的 `hasRecentError` 区别：那个带「只近 20 条」的窗口语义
 *  （它问的是「最近有没有出错」），这个问的是「错误在哪」—— 口径不同，所以不合并。 */
export function lastErrorIndex(records) {
  const arr = Array.isArray(records) ? records : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (errorOf(arr[i], i)) return i;
  }
  return -1;
}

/** delta 判定。四类，`EXEMPT` 与 `NO_DELTA` 必须分开：
 *  - EXEMPT   = 没机会写（错误记录是末条 assistant 记录，模型没有回合可写）
 *  - NO_DELTA = 有机会写，但交还时磁盘上没多出可核对的东西
 * 把「没机会」混进「没写」，比例就变成了假指标。 */
export const DELTA_VERDICTS = Object.freeze(['GROUNDED', 'UNGROUNDED', 'NO_DELTA', 'EXEMPT']);

/** `slots` 每个槽位的三态。`absent` = 文本里根本没有这一项，不是「写了无」。 */
export const SLOT_STATES = Object.freeze(['absent', 'none', 'stated']);

const SLOT_MARKS = {
  changed: /(?:改动|变更|修改|动了哪些|changed?|changes?)/i,
  remaining: /(?:还差|剩余|未完成|没做完|待办|todo|remaining|left)/i,
  needs: /(?:需要你|需要你决定|需要你确认|需要你做的|需要你做|等你|needs?\s+you|your\s+call)/i,
};

/** 「说了个无」。只认紧跟在标记后面的那一段，避免把「无改动」和「有不少改动」混掉。 */
const NONE_MARK = /(?:^|[：:\s（(])(?:无|没有|暂无|none|nothing|n\/a|无改动)(?:\s|$|[，。,.；;）)])/i;

/** 末条真人记录的索引；没有则 -1。 */
export function lastHumanIndex(records) {
  const arr = Array.isArray(records) ? records : [];
  for (let i = arr.length - 1; i >= 0; i--) if (isHumanMessage(arr[i])) return i;
  return -1;
}

/** 文本里的四个槽位说了没有。**只判「说了/没说」，不判真假**（见文件头第 1、2 条）。
 *
 *  `inconsistent` 只有一条纯结构判据：`needs` 说「无」而 `remaining` 根本没出现 ——
 *  「不需要你做什么」和「还差什么」两句话同时缺席时，这一段就不是交还 delta 而是闲聊。 */
export function deltaSlotsOf(text) {
  const t = String(text || '');
  const stateOf = (key) => {
    const m = t.match(SLOT_MARKS[key]);
    if (!m) return 'absent';
    // 看标记所在那一行（到行尾），「无」必须和标记在同一行才算说了无。
    const from = m.index;
    const lineEnd = t.indexOf('\n', from);
    const line = t.slice(from, lineEnd < 0 ? t.length : lineEnd);
    return NONE_MARK.test(line.slice(m[0].length)) ? 'none' : 'stated';
  };
  const slots = { changed: stateOf('changed'), remaining: stateOf('remaining'), needs: stateOf('needs') };
  slots.inconsistent = slots.needs === 'none' && slots.remaining === 'absent';
  return slots;
}

/** 本轮改动集 C。每条给出一个「可被文本引用的字符串」：
 *  文件类用路径，shell 类用命令原文（改到哪个文件常常判不出来，但命令本身可以被引用）。
 *
 *  shell 只算 `ok` 的：失败或丢到后台的命令没有改动工作区，把它算成一次改动
 *  等于替模型记了一笔没发生的事。 */
export function changeSetOf(records, { humanIndex = -1 } = {}) {
  const arr = Array.isArray(records) ? records : [];
  const idx = buildEvidenceIndex(arr);
  const out = [];
  const seen = new Set();
  for (const e of idx.edits) {
    if (e.index <= humanIndex) continue;
    // **失败的写入不算改动。** `ok === false` 是 tool_result 上的 `is_error`；
    // `ok === null` 是「发起过但没看到结果」（被中断 / 被 hook 拦 / 会话结束）。
    // 两种都不算 —— 前者磁盘上没多东西，后者我们不知道，而「不知道」不能当作「有」。
    // 这与 shell 侧一致：那里早就用 `if (!c.ok ...) continue` 过滤了。
    if (e.ok !== true) continue;
    if (e.via === 'shell' || !e.path) continue;
    const token = e.path;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push({ token, kind: 'path', name: e.name, index: e.index });
  }
  for (const c of idx.shell) {
    if (c.index <= humanIndex) continue;
    if (!c.ok || !isMutatingCommand(c.cmd)) continue;
    const token = String(c.cmd || '').trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push({ token, kind: 'command', name: c.name, index: c.index });
  }
  return out;
}

/** 一个改动项是否被文本引用。全路径或 basename 命中都算（理由见文件头）。 */
function referencedBy(token, kind, text) {
  if (!token) return null;
  if (kind === 'command') return text.includes(token) ? token : null;
  if (text.includes(token)) return token;
  const base = token.split(/[\\/]/).pop();
  if (base && base !== token && text.includes(base)) return base;
  return null;
}

/** 错误记录之后还有没有纯文本 assistant 记录。没有 = 模型没有回合可写。 */
function hasTextAfter(records, index) {
  const arr = Array.isArray(records) ? records : [];
  for (let i = index + 1; i < arr.length; i++) {
    const rec = arr[i];
    if (!rec || rec.type !== 'assistant') continue;
    const blocks = Array.isArray(rec.message && rec.message.content) ? rec.message.content : [];
    if (blocks.some((b) => b && b.type === 'text' && String(b.text || '').trim())) return true;
  }
  return false;
}

/**
 * 对一次交还算 delta。
 *
 * `windowTruncated` 是**调用方**才有的知识（读的是文件尾巴还是整个文件），所以必须显式给。
 * 它决定「窗口里没有真人记录」该怎么读：
 *   - 未截断：整份文件就是本轮的上下文范围，H = -1 成立，C 照常算；
 *   - 已截断：边界不可判 —— 窗口里可能横跨了不止一轮。此时**只允许下有利于不指控的结论**。
 *
 * @param {{records?: Array, windowTruncated?: boolean, errorIndex?: number|null}} opts
 * @returns {{verdict: string, attribution: string, slots: object, grounding: object}}
 */
export function computeDelta({ records = [], windowTruncated = false, errorIndex = null } = {}) {
  const arr = Array.isArray(records) ? records : [];
  const text = lastAssistantText(arr);
  const slots = deltaSlotsOf(text);

  // EXEMPT：模型没有回合可写。这一条必须排在一切之前 —— 它判的是「没机会」，不是「没写」。
  if (errorIndex !== null && errorIndex !== undefined && errorIndex >= 0 && !hasTextAfter(arr, errorIndex)) {
    return {
      verdict: 'EXEMPT',
      attribution: 'harness',
      slots,
      grounding: { required: false, hits: [], considered: [], boundary: 'error-stop' },
    };
  }

  const H = lastHumanIndex(arr);
  const boundary = H >= 0 ? 'human' : (windowTruncated ? 'unknown' : 'whole-file');
  const considered = changeSetOf(arr, { humanIndex: H });
  const hits = [];
  for (const c of considered) {
    const hit = referencedBy(c.token, c.kind, text);
    if (hit) hits.push({ token: c.token, kind: c.kind, matched: hit });
  }

  if (!considered.length) {
    // 只读分支：本轮没写任何东西，不要求接地。声明了「改动：无」才算交还了 delta。
    return {
      verdict: slots.changed === 'none' ? 'GROUNDED' : 'NO_DELTA',
      attribution: 'assistant',
      slots,
      grounding: { required: false, hits: [], considered, boundary },
    };
  }

  if (hits.length) {
    return {
      verdict: 'GROUNDED',
      attribution: 'assistant',
      slots,
      grounding: { required: true, hits, considered, boundary },
    };
  }

  // 边界不可判 + 一条都没引用：不能指控「写了却没接地」——这一轮到底有没有写都不知道。
  // 落在 NO_DELTA（「没写」）一侧，attribution 标 unknown，由汇总单列，不进 UNGROUNDED。
  if (boundary === 'unknown') {
    return {
      verdict: 'NO_DELTA',
      attribution: 'unknown',
      slots,
      grounding: { required: true, hits: [], considered, boundary },
    };
  }

  return {
    verdict: 'UNGROUNDED',
    attribution: 'assistant',
    slots,
    grounding: { required: true, hits: [], considered, boundary },
  };
}

/**
 * 汇总 delta 分档。
 *
 * **分母规则写死**：任何 delta 比例的分母恒等于 `stopped`。`EXEMPT` 只作为分子侧的
 * 减项单列，**不进分母**。
 *
 * 这条不是洁癖，是防本仓犯过的一个错：`docs/research/README.md:28` 记着 `STOPPED_SILENT`
 * 里曾算出「在等人做决定 115/115 = 100%」，被红队指出是同义反复（先按问号分走，再在
 * 剩下的里数问号）。同样的形态会在「先剔掉 EXEMPT 再算比例」时重犯：剔完剩下的样本
 * 全是「有机会写」的，比例立刻变得好看，而它衡量的是我们已经替它筛过的那个子集。
 * 所以这里只输出分母为 `stopped` 的比例；「在有机会写的里面占比」不作为头条，
 * 需要的人可以自己用两个数算，算出来时它带着自己的前提。
 */
export function summarizeDelta(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const stopped = all.filter((r) => r && r.kind !== 'NOT_STOPPED');
  const byVerdict = {};
  const byAttribution = {};
  const noDeltaByAttribution = {};
  for (const r of stopped) {
    const d = r.delta;
    if (!d) continue;
    byVerdict[d.verdict] = (byVerdict[d.verdict] || 0) + 1;
    byAttribution[d.attribution] = (byAttribution[d.attribution] || 0) + 1;
    if (d.verdict === 'NO_DELTA') {
      const k = d.attribution || 'unknown';
      noDeltaByAttribution[k] = (noDeltaByAttribution[k] || 0) + 1;
    }
  }
  const n = (k) => byVerdict[k] || 0;
  const share = (x) => (stopped.length ? Number((x / stopped.length).toFixed(4)) : 0);
  return {
    stopped: stopped.length,
    byVerdict,
    byAttribution,
    // 头条：交还时带了接地 delta 的比例。分母恒等于 stopped。
    grounded: n('GROUNDED'),
    groundedShare: share(n('GROUNDED')),
    ungrounded: n('UNGROUNDED'),
    ungroundedShare: share(n('UNGROUNDED')),
    noDelta: n('NO_DELTA'),
    noDeltaShare: share(n('NO_DELTA')),
    // 边界不可判、被归到 NO_DELTA 一侧的那些。它们**不**是「确实没写」。
    noDeltaByAttribution,
    // 分子侧减项：分母不变，单列。
    exempt: n('EXEMPT'),
    exemptShare: share(n('EXEMPT')),
  };
}
