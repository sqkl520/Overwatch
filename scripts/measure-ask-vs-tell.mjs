#!/usr/bin/env node
/**
 * measure-ask-vs-tell.mjs — 「提问算不算成本」的**重定义后**主指标测量器。
 *
 * ── 为什么另写一个，而不是改既有脚本 ────────────────────────────────────
 *
 *   被取代的两个口径都已是公开数字的来源，改它们等于让既有报告里的数字
 *   无法再复算：
 *     `measure-execution-phase.mjs`  → 主指标是「执行期中断**次数**」（A 14.4 / B 30.5）
 *     `measure-intervention-cost.mjs` → 主指标是「返工需求率」（A 1.20% / B 0.99%）
 *   两者都**把「用户后来又说了话」当成本**，与「提问是投资」的价值选择冲突。
 *   本脚本只做一件事：把「成本」重新定义成**只数用户对 AI 的纠正**，
 *   再在同一份语料上把 A/B/C 三组重算一遍，并**同时**算旧口径，
 *   让「哪条结论被推翻、哪条仍成立」可以用同一批数字直接对照。
 *   **不改旧脚本一行逻辑**，只 import 它们的判据（与既有两个脚本同一做法）。
 *
 * ── 旧口径错在哪（可复算，报告 §2 逐条给数）───────────────────────────
 *
 *   ① `measure-interventions.mjs` 的 `summarize()`（第 572 行）
 *        iv = interrupt + answer + interject + correction + nudge
 *      **`answer` 是 AskUserQuestion 的作答**（`avoidabilityOf` 第 297 行把它判成 Q）。
 *      于是「AI 问得越准，介入总数越高」——「828 → 859」那条推导就是从这里来的。
 *   ② `measure-execution-phase.mjs` 的 `execInterruptions`（第 382–383 行定义、
 *      第 503 行输出）**已经**不数作答（作答是 tool_result，不是人类发言），
 *      但它把执行期**每一条**人类发言都算成本——包括「再扫一下 D 盘」这种新需求。
 *      由此得出的「一次性完成率」= 执行期零发言（`oneShotRate`，第 574 行），
 *      实测是全语料 28/28 个「零中断」会话执行期工具全部 ≤ 11：
 *      **它测的是「活小到不需要再说话」，不是「做对了」。**
 *   ③ 两个口径都看不见 `ExitPlanMode`（计划批准）。它既不在 `WRITE_TOOLS`，
 *      也不是 `askuserquestion`，于是「用计划批准求过一次确认」的会话被记成「从不提问」。
 *
 * ── 新主指标（一句话 + 逐项可判定）────────────────────────────────────
 *
 *     执行期纠正密度 = 执行期里「用户纠正 AI」的人类发言条数 ÷ 执行期实际工作量 × 100
 *
 *   分子（成本）——**只有这一档算成本**：
 *     - 位于执行期内的人类发言（执行期 = 第一次写操作之后，见 `isWriteCall`）；
 *     - `classifyHumanMessage(text) === 'correction'`（复用，不另写正则）；
 *     - **排除**会话首条人类消息（那是开工指令，不是介入）；
 *     - **排除** `[Request interrupted by user]` 标记（宿主写的字，不是人打的）；
 *     - **排除** 任何 AskUserQuestion / ExitPlanMode 的作答（它是 tool_result；
 *       实测全语料 472 份里「紧跟在提问/批准之后的人类发言」= 0 条，不靠假设靠计数）。
 *   不计入成本（这是本指标与旧口径的分界线）：
 *     - 一切`normal`档发言：新需求、补前提、报告现象、问进展——用户主动开口，不是纠错；
 *     - 开工前的一切对话，含提问与作答；
 *     - 用户回答问题所花的时间（transcript 里没有这个字段，因此本指标不含"时间成本"，
 *       也不假装含。见报告 §6 边界）。
 *   分母（体量）——**扣掉提问本身**：
 *     执行期 tool_use 总数 − 执行期 AskUserQuestion 次数。
 *     提问不是工作；把它留在分母里会让「问得多」的会话分母虚高、密度被稀释，
 *     那等于偷偷奖励多问。扣掉之后分母才是「实际干的活」。
 *   辅助主指标（与上面同源，只是把连续量换成二值量）：
 *     **无纠正完成率** = 执行期纠正为 0 的会话占比。
 *     它是对旧「一次性完成率」的最小改动：分子从「任何发言」换成「纠正」。
 *     它天然免疫体量（每会话一票），代价是丢掉「纠正了几次」的信息。
 *   二档（声明为敏感性，不是主指标）：`correction + nudge`。
 *     「催促」是用户被迫推 AI 往前走，但它也可以是用户自己的节奏选择，
 *     所以它**不进主指标**，只用来证明主指标不因口径太窄而反向。
 *
 * ── 与旧口径的关系（同一批行同时算三个口径，报告 §4 并排）─────────────
 *
 *     旧① 介入总数（提问算成本）   → 只在报告里引用 `measure-interventions` 的数，
 *                                    本脚本不重算（它按"全部人类发言+作答"计，与本脚本
 *                                    的分母不同源，硬换会制造假对照）。
 *     旧② 执行期中断次数 / 一次性完成率 → 本脚本**逐会话重算**，与官方 `run()` 对账。
 *     新  执行期纠正密度 / 无纠正完成率 → 本脚本主指标。
 *
 * ── 去重：两层，全部沿用，不新增第三层 ────────────────────────────────
 *
 *   第一层：直接调 `measure-execution-phase.run()`（同 sessionId + 整份内容哈希）——
 *           官方分组与官方执行期工具数都从它取，不自己重算。
 *   第二层：直接调 `measure-intervention-cost.dedupeResumeForks()`（恢复分支快照）。
 *   沙箱：本仓自己 e2e 测试留下的会话（cwd/slug 落在 Temp 或 .tmp-analysis），
 *         默认**保留**（与既有报告同口径，便于逐数对照），`--real-only` 剔掉后另给一版。
 *         两版的数字都打印，不许只给好看的那一版。
 *
 * 用法：
 *   node scripts/measure-ask-vs-tell.mjs                    # 全量
 *   node scripts/measure-ask-vs-tell.mjs --json
 *   node scripts/measure-ask-vs-tell.mjs --days 7
 *   node scripts/measure-ask-vs-tell.mjs --real-only        # 剔掉本仓测试沙箱会话
 *   node scripts/measure-ask-vs-tell.mjs --no-resume-dedup
 *   node scripts/measure-ask-vs-tell.mjs --root <dir>
 *
 * 退出码：0 = 正常；2 = 找不到 transcript 根目录。
 *
 * 只读：不写任何文件，不碰 git。
 */

import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { dirname, basename } from 'node:path';

import {
  eachLine, humanTurnText, isInterrupt, classifyHumanMessage, percentile,
  defaultRoot,
} from './measure-interventions.mjs';
import {
  normToolName, isWriteCall, fnv1a,
  permutationTest, cliffsDelta, mulberry32,
  run as phaseRun,
} from './measure-execution-phase.mjs';
import { dedupeResumeForks, recordSignature } from './measure-intervention-cost.mjs';

// ── 常量（数据，不是函数）─────────────────────────────────────────────

/** 算作「提问」的工具。`exitplanmode` 是计划批准——它同样让用户先看一眼再开工，
 *  但**旧口径两个脚本都不认它**，见文件头 §旧口径③。 */
export const ASK_TOOLS = new Set(['askuserquestion', 'exitplanmode']);

/** 算作成本的人类发言档位。只有这一档。 */
export const COST_TIER = 'correction';

/** 二档（敏感性）：纠正 + 催促。刻意不进主指标。 */
export const SECONDARY_TIERS = Object.freeze(['correction', 'nudge']);

/** 密度口径的放大倍数：每 100 次执行期工具调用。 */
export const PER = 100;

/** 体量匹配容差（工具数比值的自然对数），与既有脚本同一取值。 */
export const MATCH_LOG_TOLERANCE = 0.7;

/** 置换检验次数与种子：与既有报告同一族，保证同一份输入必得同一个 p。 */
export const PERM_ITERS = 5000;
export const PERM_SEED = 20261114;

/** 本仓自己跑实验产生的沙箱会话判据。**刻意与 `observe-reality-check.isSandbox()`
 *  同源**（Temp / .tmp-analysis；slug 与 cwd 两边都看），这样本脚本的分母
 *  能与那份报告的「真实项目」直接对话。 */
export const SANDBOX_RE = /[\\/]Temp[\\/]|\.tmp-analysis/i;
export const SANDBOX_SLUG_RE = /^[A-Za-z]--Users-Administrator-AppData-Local-Temp|Overwatch--tmp-analysis/i;

/** 预过滤：只有这两类记录会影响任何判定。 */
const RELEVANT = ['"type":"assistant"', '"type":"user"'];

// ── 纯函数：判据 ─────────────────────────────────────────────────────

/** 一次工具调用是不是「提问」。`askuserquestion` 与 `exitplanmode` 都算。 */
export function isAskCall(name) {
  const n = normToolName(name);
  return n ? ASK_TOOLS.has(n) : false;
}

/**
 * 一条执行期人类发言在**新口径**下算什么。
 *
 * 返回档位而不是布尔：报告需要把「新需求」「催促」「纠正」分开打印，
 * 才能让读者自己看出「成本」这个桶里到底装了什么。
 *
 * @param {string} text
 * @returns {'correction'|'nudge'|'feedback'} feedback = 新需求 / 补前提 / 报告现象 / 问进展
 */
export function classifyExecHuman(text) {
  const k = classifyHumanMessage(text);
  // `classifyHumanMessage` 只返回 correction / nudge / normal 三档。
  // 这里把 normal 改名成 feedback，避免与「正常对话不算介入」的旧表述混淆。
  return k === 'normal' ? 'feedback' : k;
}

/** 这套判据下，一条发言是否计入主指标成本。 */
export function isCostly(text) {
  return classifyExecHuman(text) === COST_TIER;
}

/** 沙箱判据。`cwd` 与 `slug` 两边都要看：落盘路径把 cwd 编码成 slug，
 *  里面没有 `/Temp/` 片段，只测一边会漏掉全部沙箱会话。 */
export function isSandbox(cwd, slug) {
  return SANDBOX_RE.test(String(cwd || '')) || SANDBOX_SLUG_RE.test(String(slug || ''));
}

/** 从 transcript 前 64 KB 里取 cwd。取不到返回空串，由 slug 兜底。 */
export function cwdOf(path) {
  const head = headBytes(path, 64 * 1024);
  const i = head.indexOf('"cwd"');
  if (i < 0) return '';
  const start = head.indexOf('"', head.indexOf(':', i) + 1);
  if (start < 0) return '';
  let out = '';
  for (let j = start + 1; j < head.length; j++) {
    const ch = head[j];
    if (ch === '\\') { out += head[j + 1] ?? ''; j++; continue; }
    if (ch === '"') break;
    out += ch;
  }
  return out;
}

/** 读文件开头 n 字节并按 utf8 解出（截断处的半个字符不影响参数匹配）。 */
function headBytes(path, n) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(n);
    const got = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd != null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// ── 抽取：一个 transcript → 本指标需要的全部时间线 ────────────────────

/**
 * 读一个 transcript，产出按发生顺序排列的写操作、人类发言、提问、计划批准。
 *
 * 为什么不复用 `measure-intervention-cost.readSessionDetail`：它只把
 * `askuserquestion` 记进 `asks`，**看不见 `exitplanmode`**（文件头 §旧口径③）。
 * 本脚本必须能分别数这两个，才能做「把计划批准也算作提问」的分组敏感性检验。
 * 其余判据（写操作、人类发言、打断标记）**完全复用**同一批 import。
 *
 * `i` 是本脚本自己的单调计数器：每条 tool_use（按 id 去重）、每条 user 记录各占一个，
 * 人类发言与写操作因此可以按 `i` 直接比较先后。
 *
 * @param {string} path
 */
export function readAskTimeline(path) {
  const writes = [];   // {i, name}
  const humans = [];   // {i, text}
  const asks = [];     // {i, name}
  const seq = [];      // 归一化记录签名（恢复分支去重要用，判据与既有实现同一函数）
  const seenToolIds = new Set();
  let i = 0;
  let firstTs = null;
  /**
   * 「紧跟在一次提问/批准之后的人类发言」条数。
   *
   * 这是「提问不是成本」的**前提条件**，必须实测而不是假设：
   * 若某人回答提问时是**打了一段字**（而不是点选项），那条记录就会是普通人类发言，
   * 本脚本会把它当成本数进去。所以这里记下它的条数**以及其中被判为纠正的条数**：
   * 只要后者为 0，这个口径在分子上就不受污染（分母是工具数，不受影响）。
   */
  let humanAfterAsk = 0;
  let humanAfterAskCorrections = 0;
  let pendingAsk = false;

  eachLine(path, (line) => {
    if (!line) return;
    let hit = false;
    for (const k of RELEVANT) if (line.includes(k)) { hit = true; break; }
    if (!hit) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    if (o.timestamp && !firstTs) firstTs = o.timestamp;
    seq.push(fnv1a(0x811c9dc5, recordSignature(o)));

    if (o.type === 'assistant') {
      const cs = o.message?.content;
      if (!Array.isArray(cs)) return;
      for (const b of cs) {
        if (!b || b.type !== 'tool_use') continue;
        const id = typeof b.id === 'string' ? b.id : null;
        if (id) {
          if (seenToolIds.has(id)) continue;
          seenToolIds.add(id);
        }
        const idx = i++;
        const name = normToolName(b.name);
        if (!name) continue;
        if (isAskCall(b.name)) { asks.push({ i: idx, name }); pendingAsk = true; }
        if (isWriteCall(b.name, b.input)) writes.push({ i: idx, name });
      }
      return;
    }

    if (o.type !== 'user') return;
    const idx = i++;
    if (isInterrupt(o)) return;                       // 宿主写的标记，不是人打的字
    const tur = o.toolUseResult;
    if (tur && tur.answers && typeof tur.answers === 'object') { pendingAsk = false; return; }  // 提问作答（点选项）
    const t = humanTurnText(o);
    if (t == null) return;
    // 只有「上一次提问之后的**第一条**人类发言」才算「作答是打字」。
    // 用 pendingAsk 而不是「之后任意一条」：否则一个提问之后隔了三十轮的
    // 新需求也会被算进来，那个数会大得毫无意义（实测差 148 vs 0）。
    if (pendingAsk) {
      humanAfterAsk++;
      if (classifyHumanMessage(t) === COST_TIER) humanAfterAskCorrections++;
    }
    pendingAsk = false;
    humans.push({ i: idx, text: t });
  });

  let bytes = 0;
  try { bytes = statSync(path).size; } catch { /* ignore */ }
  return {
    path, bytes, firstTs, writes, humans, asks,
    seq: Uint32Array.from(seq), humanAfterAsk, humanAfterAskCorrections,
  };
}

/**
 * 一个会话 → 一行测量结果（新旧口径都在这一行里）。
 *
 * 执行起点 = 第一次写操作（与 `measure-execution-phase.isWriteCall` 同一判据）。
 * 执行期   = 执行起点之后的全部记录。
 *
 * @param {ReturnType<typeof readAskTimeline>} d
 * @param {{sessionId?:string, execTools?:number, slug?:string}} meta
 *   `execTools` 传官方 `run()` 的执行期工具数；缺省时用本脚本自算值。
 */
export function sessionRow(d, meta = {}) {
  const firstHuman = d.humans[0] ?? null;
  const exec = d.writes[0] ?? null;
  const execIdx = exec ? exec.i : null;

  const execHumans = exec
    ? d.humans.filter((h) => h.i > execIdx && (!firstHuman || h.i !== firstHuman.i))
    : [];
  const execAsks = exec ? d.asks.filter((a) => a.i > execIdx) : [];
  const execAskUser = execAsks.filter((a) => a.name === 'askuserquestion').length;
  const execPlanApprovals = execAsks.filter((a) => a.name === 'exitplanmode').length;

  const tiers = { correction: 0, nudge: 0, feedback: 0 };
  for (const h of execHumans) tiers[classifyExecHuman(h.text)]++;

  // 本脚本自算的执行期工具数：全部 tool_use 减去写操作与提问之后仍要算上它们，
  // 所以直接用 counters——tool_use 总数由 `i` 无法反推（user 记录也占位），
  // 因此这里让调用方注入官方 execTools（与旧脚本同一做法），只在对账时自算。
  const execTools = Number.isFinite(meta.execTools) ? meta.execTools : null;

  const firstAsk = d.asks[0] ?? null;
  // 本脚本的分组**把 ExitPlanMode 也算作提问**；官方 `run()` 只认 AskUserQuestion。
  // 两者不一致的会话会被 `run()` 列进 groupMismatches —— 那正是「旧口径看不见计划批准」
  // 的可复算证据，不许把它抹平成一致。
  const groupFromDetail = !exec ? 'none'
    : (firstAsk == null ? 'C' : (firstAsk.i < execIdx ? 'A' : 'B'));

  return {
    sessionId: meta.sessionId ?? null,
    path: d.path,
    bytes: d.bytes,
    /** 恢复分支去重需要的三个键：firstTs / 首条人类消息 / 归一化签名序列。 */
    firstTs: d.firstTs ?? null,
    firstHuman: firstHuman ? firstHuman.text.trim().slice(0, 200) : '',
    seq: d.seq,
    hasExec: Boolean(exec),
    execTools,
    execAskUser,
    execPlanApprovals,
    execAsks: execAsks.length,
    /** 全程（含开工前）的提问数，含计划批准。用于「提问到底发生了几次」。 */
    asksTotal: d.asks.length,
    /** 「答问是打字而非点选项」的条数。见 readAskTimeline。 */
    humanAfterAsk: d.humanAfterAsk ?? 0,
    /** 上述条数里被判为「纠正」的条数。**只有它为 0，新分子才不受这个泄漏污染。** */
    humanAfterAskCorrections: d.humanAfterAskCorrections ?? 0,
    /** 分母候选之一：扣掉提问本身的实际工作量。 */
    execWork: execTools == null ? null : Math.max(0, execTools - execAsks.length),
    interruptions: execHumans.length,
    corrections: tiers.correction,
    nudges: tiers.nudge,
    feedback: tiers.feedback,
    groupFromDetail,
    firstAskIsPlan: firstAsk ? firstAsk.name === 'exitplanmode' : false,
  };
}

// ── 统计 ─────────────────────────────────────────────────────────────

/** 档位 → 行上的字段名。**只有这两档是「用户对 AI 的否定」，其它一律不算成本。** */
export const TIER_FIELD = Object.freeze({ correction: 'corrections', nudge: 'nudges' });

/**
 * 一组会话在指定档位上的总条数。
 *
 * @param {Array} rows
 * @param {string[]} tiers 只接受 correction / nudge
 */
export function countOf(rows, tiers) {
  const ts = Array.isArray(tiers) ? tiers : [tiers];
  let n = 0;
  for (const t of ts) {
    const f = TIER_FIELD[t];
    if (!f) continue;
    n += rows.reduce((s, r) => s + (r[f] || 0), 0);
  }
  return n;
}

/**
 * 一组会话的「纠正密度」= Σ指定档位条数 ÷ Σ工作量 × 100。
 *
 * **为什么分子分母都用总和而不是「每会话先算率再平均」**：后者会让
 * 只有一个工具调用、却恰好被纠正过一次的会话拿到 100% 的极端值，
 * 而那种会话在语料里占比不低（执行期工具 ≤ 11 的会话有几十个）。
 * 总和口径下，小会话的权重自然小——这与「成本是用户花掉的总注意力」一致。
 *
 * @param {Array} rows
 * @param {string[]} tiers
 */
export function density(rows, tiers = [COST_TIER]) {
  const work = rows.reduce((s, r) => s + (r.execWork || 0), 0);
  const num = countOf(rows, tiers);
  return { work, count: num, per100: work > 0 ? (num / work) * PER : null };
}

/** 每会话密度序列（配 Cliff's delta 与中位数检验用）。工作量 0 的会话无定义，剔除。 */
export function perSessionDensity(rows, tiers = [COST_TIER]) {
  return rows
    .filter((r) => (r.execWork || 0) > 0)
    .map((r) => (countOf([r], tiers) / r.execWork) * PER);
}

/** 无纠正完成率：执行期纠正为 0 的会话占比。分母 = 有执行起点的会话。 */
export function cleanRate(rows) {
  if (!rows.length) return null;
  const clean = rows.filter((r) => r.corrections === 0).length;
  return { n: rows.length, clean, rate: clean / rows.length };
}

/** 把行按 group 聚合。 */
export function groupRow(rows) {
  const d1 = density(rows, [COST_TIER]);
  const d2 = density(rows, SECONDARY_TIERS);
  const ints = rows.reduce((s, r) => s + r.interruptions, 0);
  return {
    n: rows.length,
    work: d1.work,
    interruptions: ints,
    corrections: countOf(rows, ['correction']),
    nudges: countOf(rows, ['nudge']),
    feedback: rows.reduce((s, r) => s + r.feedback, 0),
    execAsks: rows.reduce((s, r) => s + r.execAsks, 0),
    /** 新主指标。 */
    per100: d1.per100,
    /** 敏感性二档。 */
    per100WithNudge: d2.per100,
    /** 旧口径①：纠正 ÷ 中断（= 既有 cost 报告的「返工需求率」）。 */
    oldCorrectionRate: ints > 0 ? d1.count / ints : null,
    /** 旧口径②：一次性完成率 = 执行期零发言。 */
    oldOneShot: rows.length ? rows.filter((r) => r.interruptions === 0).length / rows.length : null,
    /** 新口径的二值版。 */
    clean: cleanRate(rows),
    /** 每会话密度分布（体量敏感口径的稳健性检查）。 */
    perSession: (() => {
      const v = perSessionDensity(rows);
      if (!v.length) return { n: 0, mean: null, median: null, p90: null };
      return {
        n: v.length,
        mean: v.reduce((a, b) => a + b, 0) / v.length,
        median: percentile(v, 0.5),
        p90: percentile(v, 0.9),
      };
    })(),
  };
}

/**
 * 「两个总和之比」的置换检验。
 *
 * 为什么不直接用 `permutationTest(perSessionDensity)`：主指标是**总和之比**，
 * 不是「每会话率的平均」。对后者做置换检验，检验的是另一个统计量。
 * 这里洗牌组标签、每次都重算 `Σnum/Σwork` 的差，观测统计量与检验统计量因此同源。
 *
 * @param {Array} a
 * @param {Array} b
 * @param {{iters?:number, seed?:number, tiers?:string[]}} opts
 */
export function densityDiffTest(a, b, opts = {}) {
  const iters = opts.iters ?? PERM_ITERS;
  const seed = opts.seed ?? PERM_SEED;
  const tiers = opts.tiers ?? [COST_TIER];
  if (a.length < 2 || b.length < 2) return null;
  const per100 = (rows) => density(rows, tiers).per100;
  const obs = (per100(a) ?? 0) - (per100(b) ?? 0);
  const pool = [...a, ...b];
  const rnd = mulberry32(seed);
  let hits = 0;
  for (let t = 0; t < iters; t++) {
    const p = pool.slice();
    for (let j = 0; j < a.length; j++) {
      const k = j + Math.floor(rnd() * (p.length - j));
      const tmp = p[j]; p[j] = p[k]; p[k] = tmp;
    }
    const d = (per100(p.slice(0, a.length)) ?? 0) - (per100(p.slice(a.length)) ?? 0);
    if (Math.abs(d) >= Math.abs(obs) - 1e-12) hits++;
  }
  return { observed: obs, p: (hits + 1) / (iters + 1), iters, stat: 'sumRatioDiff' };
}

/** 无纠正完成率的置换检验（二值，按会话一票）。 */
export function cleanDiffTest(a, b, opts = {}) {
  const clean = (rows) => rows.map((r) => (r.corrections === 0 ? 1 : 0));
  return permutationTest(clean(a), clean(b), 'mean', opts.iters ?? PERM_ITERS, opts.seed ?? PERM_SEED);
}

/**
 * 按工作量 1:1 匹配：对 A 组每个会话，配一个工作量最接近的 B 组会话。
 * 容差用比值的自然对数；超过容差的配对丢弃并计数（丢弃数如实返回）。
 */
export function matchedOnWork(aRows, bRows, maxLogDist = MATCH_LOG_TOLERANCE) {
  const used = new Set();
  const pairs = [];
  for (const a of [...aRows].sort((x, y) => (y.execWork ?? 0) - (x.execWork ?? 0))) {
    let best = null;
    let bd = Infinity;
    for (const b of bRows) {
      if (used.has(b)) continue;
      const d = Math.abs(Math.log(((b.execWork ?? 0) + 1) / ((a.execWork ?? 0) + 1)));
      if (d < bd) { bd = d; best = b; }
    }
    if (!best || bd > maxLogDist) continue;
    used.add(best);
    pairs.push({ a, b: best, logDist: Math.round(bd * 1000) / 1000 });
  }
  const aFewer = pairs.filter((p) => p.a.corrections < p.b.corrections).length;
  const bFewer = pairs.filter((p) => p.a.corrections > p.b.corrections).length;
  return { n: pairs.length, maxLogDist, aFewer, bFewer, ties: pairs.length - aFewer - bFewer, pairs };
}

/** 按工作量四分位分层，每层里比三组的纠正密度与无纠正率。 */
export function stratifyByWork(rows) {
  const sizes = rows.map((r) => r.execWork ?? 0).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sizes.length) return [];
  const q1 = percentile(sizes, 0.25);
  const q2 = percentile(sizes, 0.5);
  const q3 = percentile(sizes, 0.75);
  const bands = [
    { label: `工作量 ≤ ${Math.round(q1)}`, test: (r) => (r.execWork ?? 0) <= q1 },
    { label: `${Math.round(q1)} < 工作量 ≤ ${Math.round(q2)}`, test: (r) => (r.execWork ?? 0) > q1 && (r.execWork ?? 0) <= q2 },
    { label: `${Math.round(q2)} < 工作量 ≤ ${Math.round(q3)}`, test: (r) => (r.execWork ?? 0) > q2 && (r.execWork ?? 0) <= q3 },
    { label: `工作量 > ${Math.round(q3)}`, test: (r) => (r.execWork ?? 0) > q3 },
  ];
  return bands.map(({ label, test }) => {
    const row = { label };
    for (const g of ['A', 'B', 'C']) row[g] = groupRow(rows.filter((r) => r.group === g && test(r)));
    return row;
  });
}

/**
 * 把全部行汇总成结果对象。CLI 只负责打印，不在这里重算。
 *
 * @param {Array} rows group === 'A'|'B'|'C'|'none'
 * @param {object} meta
 */
export function summarize(rows, meta = {}) {
  const by = { A: [], B: [], C: [], none: [] };
  for (const r of rows) if (by[r.group]) by[r.group].push(r);

  const groups = {
    A: groupRow(by.A), B: groupRow(by.B), C: groupRow(by.C), none: groupRow(by.none),
  };

  const tests = {
    /** 新主指标：总和之比。 */
    newDensityAB: densityDiffTest(by.A, by.B),
    newDensityAC: densityDiffTest(by.A, by.C),
    newDensityBC: densityDiffTest(by.B, by.C),
    /** 新主指标的二值版。 */
    cleanAB: cleanDiffTest(by.A, by.B),
    cleanAC: cleanDiffTest(by.A, by.C),
    cleanBC: cleanDiffTest(by.B, by.C),
    /** 每会话密度的均值/中位数（与既有报告同形的稳健性检查）。 */
    perSessionABMean: permutationTest(perSessionDensity(by.A), perSessionDensity(by.B), 'mean'),
    perSessionABMedian: permutationTest(perSessionDensity(by.A), perSessionDensity(by.B), 'median'),
    perSessionCliffs: cliffsDelta(perSessionDensity(by.A), perSessionDensity(by.B)),
    /** 二档敏感性：纠正+催促。 */
    withNudgeAB: densityDiffTest(by.A, by.B, { tiers: ['correction', 'nudge'] }),
    withNudgeAC: densityDiffTest(by.A, by.C, { tiers: ['correction', 'nudge'] }),
  };

  const comparable = [...by.A, ...by.B, ...by.C];

  return {
    meta,
    definitions: {
      primary: '执行期纠正密度 = 执行期「纠正」类人类发言 ÷ (执行期工具调用数 − 执行期提问次数) × 100',
      clean: '无纠正完成率 = 执行期纠正为 0 的会话 ÷ 有执行起点的会话',
      secondary: '二档敏感性 = (纠正 + 催促) 同一分母',
      groups: {
        A: '第一次提问早于执行起点',
        B: '第一次提问晚于执行起点',
        C: '全程无提问',
        none: '没有执行起点（全程没写文件），不参与对比',
      },
      notCost: ['开工前的全部对话', '提问与作答', '新需求 / 补前提 / 报告现象 / 问进展', '催促（见二档）'],
    },
    groups,
    tests,
    strata: stratifyByWork(comparable),
    matched: matchedOnWork(by.A, by.B),
    matchedAC: matchedOnWork(by.A, by.C),
    /** 工作量门槛敏感性：C 组里有大量「活小到不可能被纠正」的会话，
     *  不设门槛的纯净率对比会把它们算成 A 的劣势。门槛抬高后看方向是否还在。 */
    thresholds: [0, 50, 200, 400].map((minWork) => ({
      minWork,
      groups: {
        A: groupRow(by.A.filter((r) => (r.execWork ?? 0) >= minWork)),
        B: groupRow(by.B.filter((r) => (r.execWork ?? 0) >= minWork)),
        C: groupRow(by.C.filter((r) => (r.execWork ?? 0) >= minWork)),
      },
    })),
    totals: {
      comparable: comparable.length,
      work: comparable.reduce((s, r) => s + (r.execWork || 0), 0),
      interruptions: comparable.reduce((s, r) => s + r.interruptions, 0),
      corrections: countOf(comparable, ['correction']),
      nudges: countOf(comparable, ['nudge']),
      feedback: comparable.reduce((s, r) => s + r.feedback, 0),
    },
    rows,
  };
}

// ── 扫描与 CLI ───────────────────────────────────────────────────────

/**
 * 全流程：官方分组与官方执行期工具数 → 读时间线 → 恢复分支去重 → 三个口径同时算。
 *
 * @param {{root?:string, days?:number, resumeDedup?:boolean, realOnly?:boolean, nowMs?:number}} opts
 */
export function run(opts = {}) {
  const root = opts.root ?? defaultRoot();
  const days = opts.days ?? 0;
  const resumeDedup = opts.resumeDedup !== false;

  // 第一层去重 + 官方分组：全部来自 measure-execution-phase.run()，不自算。
  const base = phaseRun({ root, days, nowMs: opts.nowMs });

  const rows = [];
  for (const s of base.perSession) {
    let d;
    try { d = readAskTimeline(s.path); } catch { continue; }
    const slug = basename(dirname(s.path));
    const cwd = cwdOf(s.path);
    const row = sessionRow(d, { sessionId: s.sessionId, execTools: s.execTools });
    row.group = s.group;
    row.official = {
      group: s.group,
      execTools: s.execTools,
      interruptions: s.execInterruptions,
    };
    row.sandbox = isSandbox(cwd, slug);
    /** 「只有计划批准、没有 AskUserQuestion」——旧口径把它记成「从不提问」。 */
    row.planOnlyAsk = row.group === 'C' && d.asks.length > 0
      && d.asks.every((a) => a.name === 'exitplanmode');
    rows.push(row);
  }

  // 对账：自算分组与实际必须一致，否则口径已经漂了。
  const groupMismatches = rows.filter((r) => r.hasExec && r.groupFromDetail !== r.official.group)
    .map((r) => ({ sessionId: r.sessionId, detail: r.groupFromDetail, official: r.official.group }));
  const interruptionMismatches = rows.filter((r) => r.hasExec && r.interruptions !== r.official.interruptions)
    .map((r) => ({ sessionId: r.sessionId, detail: r.interruptions, official: r.official.interruptions }));

  // 第二层去重：恢复分支快照。判据与阈值全部来自既有实现，不新增第三层。
  let kept = rows;
  let resumeMerged = 0;
  let resumeClusters = [];
  if (resumeDedup) {
    const { keep, mergedAway, clusters } = dedupeResumeForks(rows, {});
    resumeMerged = mergedAway;
    resumeClusters = clusters;
    const keepSet = new Set(keep);
    kept = rows.filter((r) => keepSet.has(r.sessionId));
  }

  const withExec = kept.filter((r) => r.hasExec);
  const sandboxRows = withExec.filter((r) => r.sandbox);
  const scoped = opts.realOnly ? withExec.filter((r) => !r.sandbox) : withExec;

  // 沙箱污染的具体形状：它们落在哪个组、贡献了多少「零发言」。
  // 这不是可选的诊断——它直接决定旧口径的「一次性完成率」能不能被引用。
  const zeroInts = withExec.filter((r) => r.interruptions === 0);
  const sandboxByGroup = { A: 0, B: 0, C: 0 };
  for (const r of sandboxRows) if (sandboxByGroup[r.group] !== undefined) sandboxByGroup[r.group]++;
  const firstSandbox = sandboxRows.find((r) => r.firstHuman)?.firstHuman ?? '';

  const res = summarize(scoped, {
    files: base.totals.files,
    bytes: base.totals.bytes,
    days,
    duplicateSessions: base.meta.duplicateSessions,
    forkDuplicates: base.meta.forkDuplicates,
    resumeMerged,
    resumeClusters: resumeClusters.length,
    sessions: base.totals.sessions,
    sessionsAfterDedup: kept.length,
    execSessions: withExec.length,
    comparable: scoped.filter((r) => r.group !== 'none').length,
    sandboxSessions: sandboxRows.length,
    realOnly: Boolean(opts.realOnly),
    planOnlyAskSessions: rows.filter((r) => r.planOnlyAsk).length,
    groupMismatches,
    interruptionMismatches,
    asksAll: base.totals.asks,
    asksWithPlan: rows.reduce((s, r) => s + r.asksTotal, 0),
    planApprovals: rows.reduce((s, r) => s + r.execPlanApprovals, 0),
    execAskAnswers: base.totals.execAskAnswers,
    interruptMarkers: base.totals.execInterruptMarkers,
    /** 「作答是打了一段字」的条数。见 readAskTimeline。 */
    humanAfterAsk: rows.reduce((s, r) => s + r.humanAfterAsk, 0),
    humanAfterAskCorrections: rows.reduce((s, r) => s + r.humanAfterAskCorrections, 0),
    sandboxBreakdown: {
      total: sandboxRows.length,
      byGroup: sandboxByGroup,
      interruptions: sandboxRows.reduce((s, r) => s + r.interruptions, 0),
      corrections: sandboxRows.reduce((s, r) => s + r.corrections, 0),
      sampleFirstHuman: firstSandbox.slice(0, 90),
      zeroTotal: zeroInts.length,
      zeroSandbox: zeroInts.filter((r) => r.sandbox).length,
      zeroShare: `执行期零发言的 ${zeroInts.length} 个会话里 ${zeroInts.filter((r) => r.sandbox).length} 个是沙箱`
        + `（${pct(zeroInts.length ? zeroInts.filter((r) => r.sandbox).length / zeroInts.length : null, 1)}）`,
    },
  });
  return res;
}

// ── 人读报告 ─────────────────────────────────────────────────────────

const L = (s = '') => process.stdout.write(`${s}\n`);
const f1 = (x) => (x == null || !Number.isFinite(x) ? '—' : (Math.round(x * 10) / 10).toString());
const f2 = (x) => (x == null || !Number.isFinite(x) ? '—' : (Math.round(x * 100) / 100).toString());
const f3 = (x) => (x == null || !Number.isFinite(x) ? '—' : (Math.round(x * 1000) / 1000).toString());
const pct = (x, d = 2) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const pfmt = (r) => (r ? `p = ${r.p.toFixed(4)}` : '样本不足，未检验');

/** 人读报告。所有数字来自 `run()` 的结果对象，不在这一层重算。 */
export function formatReport(res) {
  const out = [];
  const g = res.groups;
  out.push('');
  out.push('提问算不算成本 · 主指标重定义后的 A/B/C 重算');
  out.push('='.repeat(76));
  out.push(`窗口 ${res.meta.days > 0 ? `${res.meta.days} 天` : '全量'}`
    + `　文件 ${res.meta.files}　${(res.meta.bytes / 1e9).toFixed(2)} GB`
    + `　沙箱会话 ${res.meta.realOnly ? '已剔除' : `含 ${res.meta.sandboxSessions}`}`);
  out.push('');
  out.push('── 语料快照（引用数字时必须连同这一块一起引）──────────────────────────');
  out.push(`落盘 ${res.meta.files} 份 → 同 sessionId 去重 −${res.meta.duplicateSessions}`
    + ` → fork 重放 −${res.meta.forkDuplicates} = ${res.meta.sessions} 个会话`);
  out.push(`恢复分支快照去重 −${res.meta.resumeMerged}（${res.meta.resumeClusters} 簇）→ ${res.meta.sessionsAfterDedup} 个会话`);
  out.push(`有执行起点 ${res.meta.execSessions}（其中本仓测试沙箱 ${res.meta.sandboxSessions}）`
    + `　本次统计 ${res.meta.comparable} 个`);
  out.push(`提问 ${res.meta.asksWithPlan} 次（AskUserQuestion ${res.meta.asksAll}）`
    + `　ExitPlanMode 批准 ${res.meta.planApprovals} 次`
    + `　执行期作答 ${res.meta.execAskAnswers}　打断标记 ${res.meta.interruptMarkers}`);
  out.push(`其中「只有计划批准、没有 AskUserQuestion」被记成 C 的会话：${res.meta.planOnlyAskSessions} 个`
    + '（旧口径把批准当不存在——这是分组的一处已知污染）');
  out.push(`「作答是打了一段字」的条数：${res.meta.humanAfterAsk}`
    + `，其中被判为「纠正」的 ${res.meta.humanAfterAskCorrections} 条`
    + (res.meta.humanAfterAskCorrections === 0
      ? '（= 0：这个泄漏不会抬高新分子，口径成立）'
      : '（> 0：新分子被作答污染，必须先从分子里剔除）'));
  out.push(`口径对账：分组不一致 ${res.meta.groupMismatches.length} 个`
    + `　中断数不一致 ${res.meta.interruptionMismatches.length} 个`);
  out.push('');
  out.push('── 新主指标：执行期纠正密度（每 100 次实际工作量）────────────────────');
  out.push('  组           n     工作量   纠正  新密度   二档(+)   无纠正会话     旧:纠正/中断   旧:一次性');
  for (const [k, label] of [['A', 'A 开工前问'], ['B', 'B 开工后问'], ['C', 'C 从不问']]) {
    const b = g[k];
    out.push(`  ${label.padEnd(11)}${String(b.n).padStart(3)}${String(b.work).padStart(9)}`
      + `${String(b.corrections).padStart(7)}${f3(b.per100).padStart(9)}${f3(b.per100WithNudge).padStart(10)}`
      + `${`${b.clean?.clean ?? 0}/${b.n}=${pct(b.clean?.rate, 1)}`.padStart(19)}`
      + `${pct(b.oldCorrectionRate).padStart(15)}${pct(b.oldOneShot, 1).padStart(11)}`);
  }
  out.push('');
  out.push('  成本桶的构成（新口径只把 correction 计入分子）：');
  out.push('  组          纠正   催促   其它（新需求/补前提/报告现象）   纠正占全部发言');
  for (const [k, label] of [['A', 'A 开工前问'], ['B', 'B 开工后问'], ['C', 'C 从不问']]) {
    const b = g[k];
    const all = b.corrections + b.nudges + b.feedback;
    out.push(`  ${label.padEnd(11)}${String(b.corrections).padStart(5)}${String(b.nudges).padStart(7)}`
      + `${String(b.feedback).padStart(34)}${pct(all ? b.corrections / all : null, 1).padStart(20)}`);
  }
  out.push('');
  out.push('── 检验（置换 5000 次，确定性种子）───────────────────────────────────');
  const t = res.tests;
  out.push(`  A vs B 纠正密度差（总和之比）   观测 ${f3(t.newDensityAB?.observed)}　${pfmt(t.newDensityAB)}`);
  out.push(`  A vs C 纠正密度差（总和之比）   观测 ${f3(t.newDensityAC?.observed)}　${pfmt(t.newDensityAC)}`);
  out.push(`  B vs C 纠正密度差（总和之比）   观测 ${f3(t.newDensityBC?.observed)}　${pfmt(t.newDensityBC)}`);
  out.push(`  A vs B 无纠正完成率差           观测 ${f3(t.cleanAB?.observed)}　${pfmt(t.cleanAB)}`);
  out.push(`  A vs C 无纠正完成率差           观测 ${f3(t.cleanAC?.observed)}　${pfmt(t.cleanAC)}`);
  out.push(`  B vs C 无纠正完成率差           观测 ${f3(t.cleanBC?.observed)}　${pfmt(t.cleanBC)}`);
  out.push(`  每会话密度 均值差 ${f3(t.perSessionABMean?.observed)}　${pfmt(t.perSessionABMean)}`
    + `　中位数差 ${f3(t.perSessionABMedian?.observed)}　${pfmt(t.perSessionABMedian)}`);
  out.push(`  Cliff's delta（每会话密度，A vs B）= ${f3(t.perSessionCliffs)}　（>0 表示 A 的密度更大）`);
  out.push(`  二档（纠正+催促）A vs B ${f3(t.withNudgeAB?.observed)}　${pfmt(t.withNudgeAB)}`
    + `　A vs C ${f3(t.withNudgeAC?.observed)}　${pfmt(t.withNudgeAC)}`);
  out.push('');
  out.push('── 控制体量：按工作量四分位分层 ─────────────────────────────────────');
  out.push('  层                          A: 密度(n) / 无纠正        B                        C');
  for (const s of res.strata) {
    const cell = (b) => `${f3(b.per100)}(n=${b.n}) ${b.clean?.clean ?? 0}/${b.n}`;
    out.push(`  ${s.label.padEnd(28)}${cell(s.A).padEnd(26)}${cell(s.B).padEnd(26)}${cell(s.C)}`);
  }
  const mp = res.matched;
  out.push('');
  out.push(`  体量 1:1 匹配（容差 log 比 ≤ ${mp.maxLogDist}）：配对 ${mp.n} 对`
    + `　A 纠正更少 ${mp.aFewer}　B 更少 ${mp.bFewer}　打平 ${mp.ties}`);
  for (const p of mp.pairs) {
    out.push(`    A ${String(p.a.sessionId).slice(0, 8)} 工作量 ${String(p.a.execWork).padStart(5)} 纠正 ${p.a.corrections}`
      + ` ｜ B ${String(p.b.sessionId).slice(0, 8)} 工作量 ${String(p.b.execWork).padStart(5)} 纠正 ${p.b.corrections}`);
  }
  const mc = res.matchedAC;
  out.push(`  体量 1:1 匹配 A vs C：配对 ${mc.n} 对`
    + `　A 纠正更少 ${mc.aFewer}　C 更少 ${mc.bFewer}　打平 ${mc.ties}`);
  for (const p of mc.pairs) {
    out.push(`    A ${String(p.a.sessionId).slice(0, 8)} 工作量 ${String(p.a.execWork).padStart(5)} 纠正 ${p.a.corrections}`
      + ` ｜ C ${String(p.b.sessionId).slice(0, 8)} 工作量 ${String(p.b.execWork).padStart(5)} 纠正 ${p.b.corrections}`);
  }
  out.push('');
  out.push('── 工作量门槛敏感性（C 组有大量「活小到不可能被纠正」的会话）──────────');
  out.push('  门槛         A: 密度(n) / 无纠正          B                        C');
  for (const t of res.thresholds) {
    const cell = (b) => `${f3(b.per100)}(n=${b.n}) ${b.clean?.clean ?? 0}/${b.n}`;
    out.push(`  ≥${String(t.minWork).padEnd(10)}${cell(t.groups.A).padEnd(28)}${cell(t.groups.B).padEnd(26)}${cell(t.groups.C)}`);
  }
  out.push('');
  out.push('── 分子有多稀疏（这个指标能支持什么、不能支持什么）───────────────────');
  const tt = res.totals;
  out.push(`  可比会话 ${tt.comparable}　工作量 ${tt.work}　执行期发言 ${tt.interruptions}`
    + `　纠正 ${tt.corrections}（${pct(tt.interruptions ? tt.corrections / tt.interruptions : null, 2)}）`
    + `　催促 ${tt.nudges}　其它 ${tt.feedback}`);
  out.push('');
  out.push('── 沙箱污染（必须与上面任何一个数字一起读）────────────────────────────');
  const sb = res.meta.sandboxBreakdown;
  out.push(`本仓自己的 e2e 测试会话 ${sb.total} 个（占全部有执行起点会话的 ${pct(sb.total / (res.meta.execSessions || 1), 1)}），`
    + `其中 C 组 ${sb.byGroup.C} / B 组 ${sb.byGroup.B} / A 组 ${sb.byGroup.A}`);
  out.push(`它们的「提示词」就是「写个文件然后停」（样本：${JSON.stringify(sb.sampleFirstHuman)}），`
    + `执行期发言 ${sb.interruptions} 条、纠正 ${sb.corrections} 条。`);
  out.push(`**${sb.zeroShare}**（${pct(sb.zeroTotal ? sb.zeroSandbox / sb.zeroTotal : null, 1)}）。`
    + '旧口径的「一次性完成率 C 组 68.1%」几乎全部由它们贡献 —— 那不是「做对了」，是「没活可干」。');
  out.push('');
  return out.join('\n');
}

function parseArgs(argv) {
  const out = { days: 0, json: false, root: defaultRoot(), resumeDedup: true, realOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--real-only') out.realOnly = true;
    else if (a === '--no-resume-dedup') out.resumeDedup = false;
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a.startsWith('--days=')) out.days = Number(a.slice(7));
    else if (a === '--root') out.root = argv[++i];
    else if (a.startsWith('--root=')) out.root = a.slice(7);
  }
  if (!Number.isFinite(out.days)) out.days = 0;
  return out;
}

const isMain = process.argv[1]
  && process.argv[1].split(String.fromCharCode(92)).join('/').endsWith('measure-ask-vs-tell.mjs');

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
    const rows = res.rows.map((r) => ({ ...r, path: undefined }));
    process.stdout.write(`${JSON.stringify({ ...res, rows }, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(res));
    process.stdout.write(`耗时 ${elapsed.toFixed(0)} ms\n`);
  }
}
