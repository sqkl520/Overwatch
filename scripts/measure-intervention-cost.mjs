#!/usr/bin/env node
/**
 * measure-intervention-cost.mjs — 「执行期中断的**代价**」测量器。
 *
 * 为什么另写一个，而不改 measure-execution-phase.mjs：
 *   那个脚本的主指标是执行期中断的**次数**。本次要回答的是「同样是中断，
 *   代价是否相同」，需要在同一次中断上再加一层「这次中断是不是要求返工」。
 *   两套口径必须能同时存在、能互相换算，所以独立成器。**不改旧脚本一行逻辑。**
 *
 * ── 被测量的假设（用户原话）────────────────────────────────────────────
 *
 *     有提问的中断：「这里按 A 还是 B」        ← 一句话解决
 *     没提问的中断：「你完全理解错了，重做」   ← 代价是一次返工
 *
 *   用户的核心主张是「需求传不准导致返工」，所以要测的是**代价**，不是次数。
 *
 * ── 口径（全部可复算；报告 §1 逐条复述）─────────────────────────────────
 *
 *   分组 A/B/C、执行起点、执行期、人类发言判据 **全部沿用**
 *   `measure-execution-phase.mjs`：
 *     - 直接 import 它导出的判据（`isWriteCall` / `normToolName` / `planGroups` 的同一套规则）；
 *     - 直接调用它的 `run()` 拿到官方去重后的会话集、分组、执行期工具数。
 *   本脚本只在**同一份会话集上**追加代价指标，不重新定义分组。
 *
 *   执行期中断  = 执行起点之后、除会话首条人类消息之外的人类发言条数（同旧脚本）。
 *   执行期工具  = 执行起点之后的全部 tool_use（同旧脚本，是体量分母）。
 *
 * ── 「代价」怎么定：主指标是返工需求率，不是工具痕迹 ────────────────────
 *
 *   本脚本把四个候选代价信号**全部算出来**，并用「随机切点对照」检验每一个是否
 *   真的能区分「中断」与「非中断」的切点。实测结论（报告 §3）：
 *
 *     候选                         实测                       能否当主指标
 *     (a) 文件重叠度（重做范围）    真实中断点比随机切点**更低**   不能（方向反了）
 *     (b) 中断后 AI 首轮输出长度    238 vs 253 字符，无差         不能
 *     (c) 自撤销事件（工具痕迹）    中断后 2.76% vs 前 2.37%      只能当辅助
 *     (d) 用户消息里的返工语义      n=20 次（全语料）             能，但 n 极小
 *
 *   因此 **主指标 = 返工需求率**：
 *
 *     返工需求 = 执行期人类发言里，含「否定/撤销/重做」语义的那几条。
 *     返工需求率 = 返工需求数 / 执行期中断数。
 *
 *   选它的理由：**它是唯一在语义上就等于「返工」的信号**，不依赖「某个工具痕迹
 *   与返工相关」这个未经验证的假设。代价是召回率低——用户也可能用「再看看」这种
 *   不带否定词的句子表达不满，本脚本数不到。宁可低估，不猜。
 *
 *   **返工需求率天然对体量免疫**（分子分母都是中断级），所以它是控制体量后的
 *   首选比较；体量相关的那一面另行用「每 100 次执行期工具」给。
 *
 * ── 去重：两层，第二层是本次新增 ────────────────────────────────────────
 *
 *   第一层：沿用 `measure-execution-phase.run()`（同 sessionId + 整份内容哈希）。
 *   第二层（本次新增）：**恢复分支快照**。实测存在这样的簇——同一段对话被写成
 *   多个 sessionId，前缀逐条相同（含时间戳），长度不同（短的是一路恢复出来的
 *   早期快照）。第一层抓不到它们（内容长度不同 → 内容哈希不同）。
 *   判据：`firstTs` 且首条人类消息相同（候选集），且归一化记录序列的
 *   **公共前缀 ≥ 较短者的 98% 且 ≥ 30 条**。同簇只保留最长的一份。
 *
 *   ⚠️ 这一层会**改变分组人数**（A 14 → 7）。报告 §2 给出前后对照，
 *   并说明为什么旧的 A=14 里有 7 个是同一段对话的副本。
 *
 * 用法：
 *   node scripts/measure-intervention-cost.mjs            # 全量
 *   node scripts/measure-intervention-cost.mjs --days 7
 *   node scripts/measure-intervention-cost.mjs --json
 *   node scripts/measure-intervention-cost.mjs --no-resume-dedup   # 关掉第二层去重
 *   node scripts/measure-intervention-cost.mjs --root <dir>
 *
 * 退出码：0 = 正常；2 = 找不到 transcript 根目录。
 *
 * 只读：不写任何文件，不碰 git。
 */

import { existsSync, statSync } from 'node:fs';

import {
  eachLine, humanTurnText, isInterrupt, classifyHumanMessage,
  percentile, defaultRoot,
} from './measure-interventions.mjs';
import {
  normToolName, isWriteCall,
  groupStats, permutationTest, cliffsDelta, spearman, spearmanPartial,
  fnv1a, mulberry32,
  run as phaseRun,
} from './measure-execution-phase.mjs';

// ── 常量（数据，不是函数）─────────────────────────────────────────────

/** 主指标的判据：**复用** `classifyHumanMessage` 的 `correction` 档。
 *  它与 measure-interventions.mjs 的 `CORRECTION` 正则同一实现，不另写一份。 */
export const PRIMARY_TIER = 'correction';

/** 第二档（敏感性用）：用户要求重做/表示不满，但没被 `correction` 命中。
 *  刻意**不并入主指标**：这一档里混进了「补充需求」和「贴日志」，
 *  精度明显更低（实测 5 条里 1 条是真重做）。只用于证明主指标不因口径太窄而反向。 */
export const REWORK_EXT_RE = new RegExp([
  '重来', '返工', '重新生成', '推翻', '没理解', '还是没理解', '理解不了',
  '不符合', '不满意', '白做', '白干', '你再看看', '做反', '推倒',
].join('|'));

/** 判定「自撤销」时，片段最短长度。太短的 old_string（`}`、`return`）会大量误配。 */
export const MIN_FRAGMENT_LEN = 12;

/** 恢复分支判据：公共前缀占较短者的比例下限。 */
export const RESUME_PREFIX_RATIO = 0.98;

/** 恢复分支判据：公共前缀的绝对条数下限。少了它，两个只共享开头的会话会被并掉。 */
export const RESUME_MIN_COMMON = 30;

/** 单条人类消息参与语义判定的长度上限（同 measure-interventions 的 MAX_CLASSIFY_LEN 口径）。 */
export const TEXT_CAP = 600;

// ── 纯函数：路径与文本 ───────────────────────────────────────────────

/** 路径归一化：反斜杠转正斜杠、小写。跨工具比较同一文件必须先归一。 */
export function normPath(p) {
  if (typeof p !== 'string' || !p) return '';
  return p.split(String.fromCharCode(92)).join('/').toLowerCase();
}

/**
 * 一条执行期人类发言是不是「返工需求」。
 *
 * @param {string} text
 * @param {'primary'|'extended'} tier primary = 主指标；extended = 敏感性
 * @returns {boolean}
 */
export function isReworkDemand(text, tier = 'primary') {
  const t = String(text ?? '').trim();
  if (!t || t.length > TEXT_CAP) return false;
  if (classifyHumanMessage(t) === PRIMARY_TIER) return true;
  if (tier === 'extended') return REWORK_EXT_RE.test(t);
  return false;
}

// ── 纯函数：自撤销事件 ───────────────────────────────────────────────

/**
 * 从一串写操作里抽出「自撤销」事件。
 *
 * 两类，都要求 AI 撤销的是**自己在本会话里做过的东西**：
 *   overwrite — 一次 `Write` 覆盖了本会话此前已经 `Write` 过的同一路径。
 *   revert    — 一次 `Edit` 的 `new_string` 恢复了本会话此前某次 `Edit` 的
 *               `old_string` 删掉的文本（即「改回去」）。
 *
 * 为什么这两类：它们不依赖语义猜测，且在工具数据里是**可判定**的。
 * 但它们**不是**主指标——实测它们在真实中断点后并没有比中断前更高（报告 §3.3）。
 *
 * Bash 写入没有可靠的路径（本脚本只从 `Write`/`Edit` 的入参取路径），
 * 所以这批写操作不参与撤销判定；覆盖率在报告里如实给出。
 *
 * @param {Array<{name:string, path:string, old:string|null, nw:string|null}>} writes 按发生顺序
 * @returns {Array<{index:number, kind:'overwrite'|'revert', path:string}>}
 */
export function undoEvents(writes) {
  const seenPath = new Set();
  const removed = new Map(); // path -> Set<string>
  const out = [];
  const list = Array.isArray(writes) ? writes : [];
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    const path = normPath(w?.path);
    if (!path) continue;
    if (w.name === 'write') {
      if (seenPath.has(path)) out.push({ index: i, kind: 'overwrite', path });
      else seenPath.add(path);
      continue;
    }
    if (w.name !== 'edit') continue;
    const nw = typeof w.nw === 'string' ? w.nw.trim() : '';
    if (nw.length >= MIN_FRAGMENT_LEN) {
      const rem = removed.get(path);
      if (rem) {
        for (const frag of rem) {
          if (frag.includes(nw)) { out.push({ index: i, kind: 'revert', path }); break; }
        }
      }
    }
    const old = typeof w.old === 'string' ? w.old.trim() : '';
    if (old.length >= MIN_FRAGMENT_LEN) {
      if (!removed.has(path)) removed.set(path, new Set());
      removed.get(path).add(old);
    }
  }
  return out;
}

// ── 纯函数：恢复分支去重 ─────────────────────────────────────────────

/** 两段签名序列的公共前缀长度。 */
export function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * 把「恢复分支快照」并成一簇。
 *
 * 候选集是**同 firstTs 且首条人类消息相同**的会话——这个约束把比较量从
 * 399² 降到几十对，同时不会漏掉恢复分支（它们必然共享开头）。
 * 判据见 RESUME_PREFIX_RATIO / RESUME_MIN_COMMON。
 *
 * 为什么不能用「整份内容哈希」：恢复分支的长度不同，哈希必然不同。
 * 为什么不能用「只比公共前缀」：会过度合并——同一项目同样的开场白之后
 * 各干各的。所以两个条件都要：前缀够长**且**占较短者的比例够高。
 *
 * @param {Array<{sessionId:string, firstTs:string|null, firstHuman:string, seq:Uint32Array, bytes:number}>} items
 * @returns {{keep:string[], mergedAway:number, clusters:Array<{ids:string[], kept:string}>}}
 */
export function dedupeResumeForks(items, opts = {}) {
  const ratio = opts.ratio ?? RESUME_PREFIX_RATIO;
  const minCommon = opts.minCommon ?? RESUME_MIN_COMMON;
  const list = Array.isArray(items) ? items : [];
  const cand = new Map();
  for (const it of list) {
    const k = `${it.firstTs ?? ''}\u0001${(it.firstHuman ?? '').slice(0, 120)}`;
    if (!cand.has(k)) cand.set(k, []);
    cand.get(k).push(it);
  }
  const parent = new Map();
  for (const it of list) parent.set(it.sessionId, it.sessionId);
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  for (const arr of cand.values()) {
    if (arr.length < 2) continue;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i];
        const b = arr[j];
        const short = Math.min(a.seq.length, b.seq.length);
        if (short < minCommon) continue;
        const c = commonPrefixLen(a.seq, b.seq);
        if (c < minCommon) continue;
        if (c / short < ratio) continue;
        const ra = find(a.sessionId);
        const rb = find(b.sessionId);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }
  const comps = new Map();
  for (const it of list) {
    const r = find(it.sessionId);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(it);
  }
  const keep = [];
  const clusters = [];
  let mergedAway = 0;
  for (const arr of comps.values()) {
    const best = [...arr].sort(
      (x, y) => y.seq.length - x.seq.length || (y.bytes ?? 0) - (x.bytes ?? 0),
    )[0];
    keep.push(best.sessionId);
    mergedAway += arr.length - 1;
    if (arr.length > 1) clusters.push({ ids: arr.map((x) => x.sessionId), kept: best.sessionId });
  }
  return { keep, mergedAway, clusters };
}

// ── 抽取：一次读完一个 transcript 里本脚本需要的东西 ──────────────────

/** 预过滤：只有这两类记录会影响任何判定。 */
const RELEVANT = ['"type":"assistant"', '"type":"user"'];

/** 一条记录 → 归一化签名（用于恢复分支比较）。**丢掉所有每条都不同的字段。** */
export function recordSignature(o) {
  const c = o?.message?.content;
  let body = '';
  if (typeof c === 'string') body = c;
  else if (Array.isArray(c)) {
    body = c.map((b) => {
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text') return `t:${b.text ?? ''}`;
      if (b.type === 'thinking') return 'k';
      if (b.type === 'tool_use') return `u:${b.name ?? ''}:${JSON.stringify(b.input ?? {})}`;
      if (b.type === 'tool_result') return 'r';
      return b.type ?? '';
    }).join('|');
  }
  return `${o?.type ?? ''}|${body}`;
}

/**
 * 读一个 transcript，产出「按发生顺序」的写操作与人类发言。
 *
 * 索引 `i` 是本脚本自己的单调计数器：每条 tool_use（按 id 去重）、每条 user 记录
 * 各占一个。人类发言与写操作因此可以按 `i` 直接比较先后。
 *
 * @param {string} path
 */
export function readSessionDetail(path) {
  const writes = [];   // {i, name, path, old, nw}
  const humans = [];   // {i, text}
  const asks = [];     // i
  const seq = [];      // 归一化签名（每条有效记录一个）
  const seenToolIds = new Set();
  let i = 0;
  let firstTs = null;
  let lastTs = null;

  eachLine(path, (line) => {
    if (!line) return;
    let hit = false;
    for (const k of RELEVANT) if (line.includes(k)) { hit = true; break; }
    if (!hit) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    if (o.timestamp) {
      if (!firstTs) firstTs = o.timestamp;
      lastTs = o.timestamp;
    }
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
        if (name === 'askuserquestion') asks.push(idx);
        if (isWriteCall(b.name, b.input)) {
          writes.push({
            i: idx,
            name,
            path: normPath(b.input?.file_path || b.input?.path || b.input?.notebook_path || ''),
            old: typeof b.input?.old_string === 'string' ? b.input.old_string : null,
            nw: typeof b.input?.new_string === 'string' ? b.input.new_string : null,
          });
        }
      }
      return;
    }

    if (o.type !== 'user') return;
    const idx = i++;
    if (isInterrupt(o)) return;
    const tur = o.toolUseResult;
    if (tur && tur.answers && typeof tur.answers === 'object') return;
    const t = humanTurnText(o);
    if (t == null) return;
    humans.push({ i: idx, text: t });
  });

  const st = statSync(path);
  return {
    path, firstTs, lastTs, bytes: st.size,
    writes, humans, asks,
    seq: Uint32Array.from(seq),
    records: seq.length,
  };
}

/**
 * 一个会话 → 代价指标。
 *
 * 执行起点 = 第一次写操作（同 measure-execution-phase：`isWriteCall`）。
 * 执行期中断 = 执行起点之后、除会话首条人类消息之外的人类发言。
 *
 * @param {ReturnType<typeof readSessionDetail>} d
 * @param {{group?:string, sessionId?:string}} meta
 */
export function sessionCost(d, meta = {}) {
  const humans = d.humans;
  const firstHuman = humans[0] ?? null;
  const exec = d.writes[0] ?? null;
  const execIdx = exec ? exec.i : null;

  const execHumans = exec
    ? humans.filter((h) => h.i > execIdx && (!firstHuman || h.i !== firstHuman.i))
    : [];
  const execWrites = exec ? d.writes.filter((w) => w.i > execIdx) : [];
  const preWrites = exec ? d.writes.filter((w) => w.i <= execIdx) : d.writes;

  let primary = 0;
  let extended = 0;
  let nudges = 0;
  let normal = 0;
  for (const h of execHumans) {
    const k = classifyHumanMessage(h.text);
    if (k === PRIMARY_TIER) primary++;
    else if (k === 'nudge') nudges++;
    else normal++;
    if (isReworkDemand(h.text, 'extended')) extended++;
  }

  const undos = undoEvents(preWrites);
  const allUndos = undoEvents(d.writes);

  // 首次提问是否早于执行起点（A/B/C 的自算结果，用于与官方分组对账）
  const firstAsk = d.asks.length ? d.asks[0] : null;
  const groupFromDetail = !exec ? 'none'
    : (firstAsk == null ? 'C' : (firstAsk < execIdx ? 'A' : 'B'));

  return {
    sessionId: meta.sessionId ?? null,
    path: d.path,
    bytes: d.bytes,
    firstTs: d.firstTs,
    firstHuman: firstHuman ? firstHuman.text.trim().slice(0, 200) : '',
    hasExec: Boolean(exec),
    groupFromDetail,
    /** 执行期工具总数由调用方用官方 `execTools` 覆盖；这里先给写操作数占位。 */
    execTools: execWrites.length,
    interruptions: execHumans.length,
    corrections: execHumans.filter((h) => classifyHumanMessage(h.text) === 'correction').length,
    nudges,
    normal,
    reworkPrimary: primary,
    reworkExtended: extended,
    undoTotal: allUndos.length,
    undoBeforeExec: undos.length,
    undoOverwrite: allUndos.filter((u) => u.kind === 'overwrite').length,
    undoRevert: allUndos.filter((u) => u.kind === 'revert').length,
    seq: d.seq,
  };
}

// ── 可选：真实中断点 vs 随机切点（验证代价信号是否真的「测到代价」）────────

/**
 * 对每个执行期中断点，取它之后与之前各 K 个写操作，比较自撤销率。
 *
 * 这是本脚本**唯一**用来判「这个信号能不能当主指标」的检验。若中断后并不比中断前高，
 * 该信号就没有测到「中断造成的返工」，只能当辅助。
 *
 * @param {ReturnType<typeof readSessionDetail>} d
 * @param {{K?:number}} opts
 */
export function undoAroundInterruptions(d, opts = {}) {
  const K = opts.K ?? 10;
  const humans = d.humans;
  const firstHuman = humans[0] ?? null;
  const exec = d.writes[0];
  if (!exec) return { after: 0, before: 0, afterWrites: 0, beforeWrites: 0, n: 0 };
  const flags = new Set(undoEvents(d.writes).map((u) => u.index));
  const writes = d.writes;
  const execHumans = humans.filter((h) => h.i > exec.i && (!firstHuman || h.i !== firstHuman.i));
  let after = 0; let before = 0; let afterWrites = 0; let beforeWrites = 0; let n = 0;
  for (const h of execHumans) {
    let ai = -1;
    for (let j = 0; j < writes.length; j++) if (writes[j].i > h.i) { ai = j; break; }
    if (ai <= 0) continue;
    const a = writes.slice(ai, ai + K);
    const b = writes.slice(Math.max(0, ai - K), ai);
    if (!a.length || !b.length) continue;
    n++;
    after += a.filter((w, k) => flags.has(ai + k)).length;
    before += b.filter((w, k) => flags.has(Math.max(0, ai - K) + k)).length;
    afterWrites += a.length;
    beforeWrites += b.length;
  }
  return { after, before, afterWrites, beforeWrites, n };
}

/**
 * 「重做范围」信号的有效性检验：中断点之后的写操作里，有多大比例落在
 * **中断点之前就已经写过的文件**上。
 *
 * 候选 (b) 的直觉是「高重叠 = 返工」。**实测这个直觉是错的**：
 * 真实中断点后的重叠率**低于**同长度随机窗口（报告 §3.2）。原因很朴素——
 * 用户停下来说话时，AI 通常正在一个文件上连续工作；中断后它继续改的还是那个文件，
 * 而随机窗口横跨整个会话，覆盖面更大。「重叠」测的是「工作连续性」，不是「返工」。
 *
 * 这个函数存在的唯一目的是让那条否定结论**可复算**，不参与主指标。
 *
 * @param {ReturnType<typeof readSessionDetail>} d
 * @param {{K?:number}} opts K = 中断点之后取多少个写操作
 */
export function redoShareAfterInterruptions(d, opts = {}) {
  const K = opts.K ?? 10;
  const humans = d.humans;
  const firstHuman = humans[0] ?? null;
  const exec = d.writes[0];
  if (!exec) return { hits: 0, total: 0, windows: 0 };
  const execHumans = humans.filter((h) => h.i > exec.i && (!firstHuman || h.i !== firstHuman.i));
  let hits = 0;
  let total = 0;
  let windows = 0;
  for (const h of execHumans) {
    const before = new Set();
    for (const w of d.writes) {
      if (w.i >= h.i) break;
      if (w.path) before.add(w.path);
    }
    const after = d.writes.filter((w) => w.i > h.i).slice(0, K);
    if (!before.size || !after.length) continue;
    windows++;
    for (const w of after) {
      total++;
      if (w.path && before.has(w.path)) hits++;
    }
  }
  return { hits, total, windows };
}

/**
 * 「重做范围」的**对照**：在同一个会话里取同长度的随机窗口（不跨越人类发言），
 * 算同样的重叠率。用来判上面那个率是高还是低——没有对照就没有意义。
 *
 * 确定性：用固定种子（与 permutationTest 同一族），同一份输入必得同一个数。
 *
 * @param {ReturnType<typeof readSessionDetail>} d
 * @param {{K?:number, rnd:() => number, trials?:number}} opts
 */
export function redoShareRandomWindows(d, opts = {}) {
  const K = opts.K ?? 10;
  const rnd = opts.rnd ?? (() => 0.5);
  const trials = opts.trials ?? 1;
  const writes = d.writes;
  const exec = writes[0];
  if (!exec || writes.length < K + 2) return { hits: 0, total: 0, windows: 0 };
  const humanIdx = new Set(d.humans.map((h) => h.i));
  let hits = 0;
  let total = 0;
  let windows = 0;
  for (let t = 0; t < trials; t++) {
    // 随机取一个「之后还有 K 个写操作」的起点
    const lo = 1;
    const hi = writes.length - K;
    if (hi < lo) continue;
    const j = lo + Math.floor(rnd() * (hi - lo + 1));
    const cut = writes[j].i;
    // 窗口内有人类发言就不算「纯 AI 窗口」，跳过
    let crossed = false;
    for (let k = j; k < j + K; k++) if (humanIdx.has(writes[k].i)) { crossed = true; break; }
    if (crossed) continue;
    const before = new Set();
    for (let k = 0; k < j; k++) if (writes[k].path) before.add(writes[k].path);
    const after = writes.slice(j, j + K);
    if (!before.size || !after.length) continue;
    windows++;
    for (const w of after) {
      total++;
      if (w.path && before.has(w.path)) hits++;
    }
  }
  return { hits, total, windows };
}

// ── 统计 ─────────────────────────────────────────────────────────────

/** 一组会话里某个计数的「每 100 次执行期工具」密度。 */
export function density(rows, field, per = 100) {
  const tools = rows.reduce((s, r) => s + (r.execTools || 0), 0);
  const num = rows.reduce((s, r) => s + (r[field] || 0), 0);
  return tools > 0 ? (num / tools) * per : null;
}

/** 聚合一行（组级）。 */
export function groupRow(rows) {
  const tools = rows.reduce((s, r) => s + r.execTools, 0);
  const ints = rows.reduce((s, r) => s + r.interruptions, 0);
  const prim = rows.reduce((s, r) => s + r.reworkPrimary, 0);
  const ext = rows.reduce((s, r) => s + r.reworkExtended, 0);
  const undo = rows.reduce((s, r) => s + r.undoTotal, 0);
  return {
    n: rows.length,
    execTools: tools,
    interruptions: ints,
    /** 中断的构成：纠正 / 催促 / 其它。**报告 §4 的核心：**中断绝大多数不是纠正。 */
    corrections: rows.reduce((s, r) => s + (r.corrections || 0), 0),
    nudges: rows.reduce((s, r) => s + (r.nudges || 0), 0),
    normal: rows.reduce((s, r) => s + (r.normal || 0), 0),
    reworkPrimary: prim,
    reworkExtended: ext,
    undoTotal: undo,
    /** 主指标：返工需求率 = 返工需求 / 中断。中断级，天然免疫体量。 */
    primaryRate: ints > 0 ? prim / ints : null,
    extendedRate: ints > 0 ? ext / ints : null,
    /** 每 100 次执行期工具的返工需求密度。 */
    primaryPer100: tools > 0 ? (prim / tools) * 100 : null,
    undoPer100: tools > 0 ? (undo / tools) * 100 : null,
    /** 每会话中位数（避免被单个大会话拉走）。 */
    primaryPerSession: groupStats(rows.map((r) => r.reworkPrimary)),
    undoPerSession: groupStats(rows.map((r) => r.undoTotal)),
    sessionsWithAnyRework: rows.filter((r) => r.reworkPrimary > 0).length,
    sessionsWithAnyUndo: rows.filter((r) => r.undoTotal > 0).length,
  };
}

/** 按执行期工具数分层：每层里比 A/B/C 的返工需求率。 */
export function stratified(rows) {
  const sizes = rows.map((r) => r.execTools).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sizes.length) return [];
  const cut = (p) => percentile(sizes, p);
  const q1 = cut(0.25); const q2 = cut(0.5); const q3 = cut(0.75);
  const bands = [
    { label: `工具 ≤ ${Math.round(q1)}`, test: (r) => r.execTools <= q1 },
    { label: `${Math.round(q1)} < 工具 ≤ ${Math.round(q2)}`, test: (r) => r.execTools > q1 && r.execTools <= q2 },
    { label: `${Math.round(q2)} < 工具 ≤ ${Math.round(q3)}`, test: (r) => r.execTools > q2 && r.execTools <= q3 },
    { label: `工具 > ${Math.round(q3)}`, test: (r) => r.execTools > q3 },
  ];
  return bands.map(({ label, test }) => {
    const row = { label };
    for (const g of ['A', 'B', 'C']) {
      const sub = rows.filter((r) => r.group === g && test(r));
      row[g] = groupRow(sub);
    }
    return row;
  });
}

/**
 * 1:1 体量匹配：对 A 组每个会话，配一个执行期工具数最接近的 B 组会话。
 * 容差用比值的自然对数；超过容差的配对丢弃并计数。
 */
export function matchedPairs(aRows, bRows, maxLogDist = 0.7) {
  const used = new Set();
  const pairs = [];
  for (const a of [...aRows].sort((x, y) => y.execTools - x.execTools)) {
    let best = null; let bd = Infinity;
    for (const b of bRows) {
      if (used.has(b)) continue;
      const d = Math.abs(Math.log((b.execTools + 1) / (a.execTools + 1)));
      if (d < bd) { bd = d; best = b; }
    }
    if (!best || bd > maxLogDist) continue;
    used.add(best);
    pairs.push({
      aId: a.sessionId, bId: best.sessionId,
      aTools: a.execTools, bTools: best.execTools,
      aRate: a.interruptions ? a.reworkPrimary / a.interruptions : null,
      bRate: best.interruptions ? best.reworkPrimary / best.interruptions : null,
      aRework: a.reworkPrimary, bRework: best.reworkPrimary,
      logDist: Math.round(bd * 1000) / 1000,
    });
  }
  const aWins = pairs.filter((p) => p.aRework < p.bRework).length;
  const bWins = pairs.filter((p) => p.aRework > p.bRework).length;
  return {
    n: pairs.length, maxLogDist, aWins, bWins, ties: pairs.length - aWins - bWins,
    meanA: pairs.length ? pairs.reduce((s, p) => s + p.aRework, 0) / pairs.length : null,
    meanB: pairs.length ? pairs.reduce((s, p) => s + p.bRework, 0) / pairs.length : null,
    pairs,
  };
}

/**
 * 把已配对的 A/B 行汇总成完整结果。所有数字都从这里出，CLI 只负责打印。
 *
 * @param {Array} rows 每会话的代价行（必须含 group / execTools / interruptions / reworkPrimary）
 * @param {object} meta
 */
export function summarize(rows, meta = {}) {
  const byGroup = { A: [], B: [], C: [] };
  for (const r of rows) if (byGroup[r.group]) byGroup[r.group].push(r);
  const groups = { A: groupRow(byGroup.A), B: groupRow(byGroup.B), C: groupRow(byGroup.C) };

  const rates = (arr) => arr
    .filter((r) => r.interruptions > 0)
    .map((r) => r.reworkPrimary / r.interruptions);
  const dens = (arr) => arr
    .filter((r) => r.execTools > 0)
    .map((r) => (r.reworkPrimary / r.execTools) * 100);

  const tests = {
    primaryRateMean: permutationTest(rates(byGroup.A), rates(byGroup.B), 'mean'),
    primaryRateMedian: permutationTest(rates(byGroup.A), rates(byGroup.B), 'median'),
    primaryRateCliffs: cliffsDelta(rates(byGroup.A), rates(byGroup.B)),
    densityMedian: permutationTest(dens(byGroup.A), dens(byGroup.B), 'median'),
    densityCliffs: cliffsDelta(dens(byGroup.A), dens(byGroup.B)),
    undoDensityMedian: permutationTest(
      byGroup.A.map((r) => (r.execTools ? (r.undoTotal / r.execTools) * 100 : null)).filter(Number.isFinite),
      byGroup.B.map((r) => (r.execTools ? (r.undoTotal / r.execTools) * 100 : null)).filter(Number.isFinite),
      'median',
    ),
  };

  const all = [...byGroup.A, ...byGroup.B, ...byGroup.C];

  /** 体量相关：中断数与返工需求数各自被体量解释多少。**这是结论的承重墙。** */
  const sizeCorr = {
    corrToolsInterruptions: spearman(all.map((r) => r.execTools), all.map((r) => r.interruptions)),
    corrToolsRework: spearman(all.map((r) => r.execTools), all.map((r) => r.reworkPrimary)),
    corrToolsUndo: spearman(all.map((r) => r.execTools), all.map((r) => r.undoTotal)),
    /** 控制体量后，中断数与返工需求数还剩多少相关。 */
    partialInterruptionsRework: spearmanPartial(
      all.map((r) => r.interruptions), all.map((r) => r.reworkPrimary), all.map((r) => r.execTools),
    ),
  };

  return {
    meta,
    definitions: {
      primary: '返工需求率 = 执行期含否定/撤销/重做语义的人类发言数 ÷ 执行期中断数',
      density: '每 100 次执行期工具调用的返工需求数',
      undo: '自撤销 = Write 覆盖本会话已写过的同一路径，或 Edit 恢复本会话此前删掉的文本',
      groups: { A: '第一次提问早于执行起点', B: '第一次提问晚于执行起点', C: '全程无提问' },
    },
    groups,
    tests,
    sizeCorr,
    strata: stratified(all),
    matched: matchedPairs(byGroup.A, byGroup.B),
    /** 汇总数字。`run()` 会覆盖它（追加去重/信号有效性这类只有全流程才知道的字段），
     *  但 `summarize()` 单独被调用时也必须自洽——测试与外部复用都从这里取数。 */
    totals: {
      comparable: all.filter((r) => r.group !== 'none').length,
      interruptions: all.reduce((s, r) => s + (r.interruptions || 0), 0),
      reworkPrimary: all.reduce((s, r) => s + (r.reworkPrimary || 0), 0),
      reworkExtended: all.reduce((s, r) => s + (r.reworkExtended || 0), 0),
      undos: all.reduce((s, r) => s + (r.undoTotal || 0), 0),
    },
    rows,
  };
}

// ── 扫描与 CLI ───────────────────────────────────────────────────────

/**
 * 全流程：官方分组 → 读明细 → 恢复分支去重 → 代价统计。
 *
 * @param {{root?:string, days?:number, resumeDedup?:boolean, nowMs?:number}} opts
 */
export function run(opts = {}) {
  const root = opts.root ?? defaultRoot();
  const days = opts.days ?? 0;
  const resumeDedup = opts.resumeDedup !== false;

  // 第一层去重 + 官方分组，全部来自 measure-execution-phase.mjs。
  const base = phaseRun({ root, days, nowMs: opts.nowMs });
  const baseByPath = new Map(base.perSession.map((s) => [normPath(s.path), s]));

  // 读明细（只读官方保留下来的那些文件）。**每份只读一次**，结果留着给
  // 「中断点前后」的信号有效性检验复用 —— 重读一遍 1.9 GB 要多花 40 秒。
  const details = [];
  const detailBySession = new Map();
  for (const s of base.perSession) {
    let d;
    try { d = readSessionDetail(s.path); } catch { continue; }
    const cost = sessionCost(d, { sessionId: s.sessionId });
    cost.seq = d.seq;
    // 官方口径的执行期工具数（本脚本不算工具总数，只算写操作）
    cost.execTools = s.execTools;
    // 官方分组（本脚本自算的 groupFromDetail 用于对账）
    cost.group = s.group;
    cost.official = {
      group: s.group,
      execTools: s.execTools,
      interruptions: s.execInterruptions,
    };
    details.push(cost);
    detailBySession.set(s.sessionId, d);
  }

  // 分组对账：自算分组与官方分组必须完全一致，否则口径已经漂了。
  const mismatches = details.filter((r) => r.hasExec && r.groupFromDetail !== r.official.group);
  // 中断数对账：官方计的是人类发言条数，本脚本同一判据。
  const intMismatch = details.filter((r) => r.hasExec && r.interruptions !== r.official.interruptions);

  let kept = details;
  let resumeMerged = 0;
  let resumeClusters = [];
  let before = null;
  if (resumeDedup) {
    const g0 = { A: 0, B: 0, C: 0, none: 0 };
    for (const r of details) g0[r.group] = (g0[r.group] ?? 0) + 1;
    before = g0;
    const { keep, mergedAway, clusters } = dedupeResumeForks(details, {
      ratio: opts.ratio, minCommon: opts.minCommon,
    });
    const keepSet = new Set(keep);
    resumeMerged = mergedAway;
    resumeClusters = clusters;
    kept = details.filter((r) => keepSet.has(r.sessionId));
  }

  // 中断点前后的自撤销率（信号有效性检验，逐会话累加）。复用上一步的明细，不重读文件。
  let afterUndo = 0; let beforeUndo = 0; let afterWrites = 0; let beforeWrites = 0; let windows = 0;
  let redoHits = 0; let redoTotal = 0; let redoWindows = 0;
  let rndHits = 0; let rndTotal = 0; let rndWindows = 0;
  const rnd = mulberry32(20261114);
  for (const r of kept) {
    const d = detailBySession.get(r.sessionId);
    if (!d) continue;
    const v = undoAroundInterruptions(d);
    afterUndo += v.after; beforeUndo += v.before;
    afterWrites += v.afterWrites; beforeWrites += v.beforeWrites;
    windows += v.n;
    const rd = redoShareAfterInterruptions(d);
    redoHits += rd.hits; redoTotal += rd.total; redoWindows += rd.windows;
    // 随机对照：每个会话抽 20 个同长度窗口
    const rr = redoShareRandomWindows(d, { rnd, trials: 20 });
    rndHits += rr.hits; rndTotal += rr.total; rndWindows += rr.windows;
  }

  // 只保留有执行起点且至少被中断过一次的会话参与对比（与旧脚本同口径：
  // 无执行起点的单列，不进 A/B/C）。
  const comparable = kept.filter((r) => r.hasExec);

  const res = summarize(comparable, {
    root, days,
    files: base.totals.files,
    // 第一层去重（旧脚本）与第二层（本脚本）分开报，别混成一个数字
    phaseDuplicateSessions: base.meta.duplicateSessions,
    phaseForkDuplicates: base.meta.forkDuplicates,
    resumeMerged,
    groupsBefore: before,
    groupsAfter: (() => {
      const g = { A: 0, B: 0, C: 0, none: 0 };
      for (const r of kept) g[r.group] = (g[r.group] ?? 0) + 1;
      return g;
    })(),
    groupMismatches: mismatches.map((r) => ({ sessionId: r.sessionId, detail: r.groupFromDetail, official: r.official.group })),
    interruptionMismatches: intMismatch.map((r) => ({ sessionId: r.sessionId, detail: r.interruptions, official: r.official.interruptions })),
    resumeClusters,
    detailsCount: details.length,
  });

  res.signalValidity = {
    windows,
    afterUndo, beforeUndo, afterWrites, beforeWrites,
    afterRate: afterWrites ? afterUndo / afterWrites : null,
    beforeRate: beforeWrites ? beforeUndo / beforeWrites : null,
    redo: {
      hits: redoHits, total: redoTotal, windows: redoWindows,
      rate: redoTotal ? redoHits / redoTotal : null,
      randomRate: rndTotal ? rndHits / rndTotal : null,
      randomWindows: rndWindows,
    },
  };
  res.totals = {
    comparable: comparable.length,
    interruptions: comparable.reduce((s, r) => s + r.interruptions, 0),
    reworkPrimary: comparable.reduce((s, r) => s + r.reworkPrimary, 0),
    reworkExtended: comparable.reduce((s, r) => s + r.reworkExtended, 0),
    undos: comparable.reduce((s, r) => s + r.undoTotal, 0),
  };
  return res;
}

const L = (s = '') => process.stdout.write(`${s}\n`);
const f1 = (x) => (x == null || !Number.isFinite(x) ? '—' : (Math.round(x * 10) / 10).toString());
const f3 = (x) => (x == null || !Number.isFinite(x) ? '—' : (Math.round(x * 1000) / 1000).toString());
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(2)}%`);

/** 人读报告。所有数字来自 summarize 的结果对象，不在这一层重算。 */
export function formatReport(res) {
  const out = [];
  const g = res.groups;
  out.push('');
  out.push('执行期中断的代价 · 返工需求率');
  out.push('='.repeat(72));
  out.push(`根目录 ${res.meta.root}　窗口 ${res.meta.days > 0 ? `${res.meta.days} 天` : '全量'}　文件 ${res.meta.files}`);
  out.push('');
  out.push('── 口径 ────────────────────────────────────────────────────────────');
  out.push('分组 / 执行起点 / 执行期 / 人类发言判据 = measure-execution-phase.mjs 同一实现');
  out.push('主指标  返工需求率 = 执行期含否定/撤销/重做语义的人类发言 ÷ 执行期中断');
  out.push('辅助    每 100 次执行期工具的返工需求数；自撤销事件密度');
  out.push('');
  out.push('── 去重 ────────────────────────────────────────────────────────────');
  out.push(`第一层（既有）：同 sessionId 丢弃 ${res.meta.phaseDuplicateSessions ?? '—'}，fork 重放丢弃 ${res.meta.phaseForkDuplicates ?? '—'}`);
  out.push(`第二层（本次新增）：恢复分支快照合并 ${res.meta.resumeMerged ?? 0} 份，涉及 ${res.meta.resumeClusters?.length ?? 0} 簇`);
  const gb = res.meta.groupsBefore; const ga = res.meta.groupsAfter;
  if (gb && ga) {
    out.push(`  分组变化：A ${gb.A} → ${ga.A}　B ${gb.B} → ${ga.B}　C ${gb.C} → ${ga.C}　none ${gb.none} → ${ga.none}`);
  }
  out.push(`口径对账：分组不一致 ${res.meta.groupMismatches?.length ?? '—'} 个，`
    + `中断数不一致 ${res.meta.interruptionMismatches?.length ?? '—'} 个`);
  out.push('');
  out.push('── 主指标：返工需求率 ──────────────────────────────────────────────');
  out.push('  组         n   中断数  返工需求  返工需求率   每100工具   每会话 median   有返工的会话');
  for (const [k, label] of [['A', 'A 开工前问'], ['B', 'B 开工后问'], ['C', 'C 从不问']]) {
    const b = g[k];
    out.push(`  ${label.padEnd(10)}${String(b.n).padStart(4)}${String(b.interruptions).padStart(8)}`
      + `${String(b.reworkPrimary).padStart(10)}${pct(b.primaryRate).padStart(11)}`
      + `${f3(b.primaryPer100).padStart(11)}${f1(b.primaryPerSession?.median).padStart(15)}`
      + `${String(b.sessionsWithAnyRework).padStart(13)}/${b.n}`);
  }
  out.push('');
  out.push('── 中断的构成（这是「次数」为什么不能代表「代价」的直接理由）─────────');
  out.push('  组        中断数   纠正   催促   其它   纠正占比');
  for (const [k, label] of [['A', 'A 开工前问'], ['B', 'B 开工后问'], ['C', 'C 从不问']]) {
    const b = g[k];
    out.push(`  ${label.padEnd(10)}${String(b.interruptions).padStart(6)}${String(b.corrections).padStart(7)}`
      + `${String(b.nudges).padStart(7)}${String(b.normal).padStart(7)}`
      + `${pct(b.interruptions ? b.corrections / b.interruptions : null).padStart(11)}`);
  }
  out.push('');
  out.push('A vs B 检验（置换 5000 次，确定性种子）：');
  const t = res.tests;
  const fmt = (name, r) => (r ? `  ${name.padEnd(18)} 观测差 ${f3(r.observed)}　双侧 p = ${r.p.toFixed(4)}` : `  ${name.padEnd(18)} 样本不足，未检验`);
  out.push(fmt('返工需求率 均值', t.primaryRateMean));
  out.push(fmt('返工需求率 中位数', t.primaryRateMedian));
  out.push(`  Cliff's delta = ${f3(t.primaryRateCliffs)}　（>0 表示 A 的代价更大）`);
  out.push(fmt('每100工具返工 中位数', t.densityMedian));
  out.push(`  Cliff's delta（密度）= ${f3(t.densityCliffs)}`);
  out.push('');
  out.push('── 辅助：自撤销事件 ────────────────────────────────────────────────');
  out.push('  组        自撤销数  覆盖(+1)  改回(+1)   每100工具  有撤销的会话');
  for (const [k, label] of [['A', 'A 开工前问'], ['B', 'B 开工后问'], ['C', 'C 从不问']]) {
    const b = g[k];
    const ov = res.rows.filter((r) => r.group === k).reduce((s, r) => s + r.undoOverwrite, 0);
    const rv = res.rows.filter((r) => r.group === k).reduce((s, r) => s + r.undoRevert, 0);
    out.push(`  ${label.padEnd(10)}${String(b.undoTotal).padStart(8)}${String(ov).padStart(10)}${String(rv).padStart(10)}`
      + `${f3(b.undoPer100).padStart(11)}${String(b.sessionsWithAnyUndo).padStart(13)}/${b.n}`);
  }
  const v = res.signalValidity;
  if (v) {
    out.push(`  信号有效性（中断点前 K=${10} 个写 vs 之后）：之后 ${pct(v.afterRate)}（${v.afterUndo}/${v.afterWrites}）`
      + `　之前 ${pct(v.beforeRate)}（${v.beforeUndo}/${v.beforeWrites}）`
      + `　比值 ${f3(v.afterRate && v.beforeRate ? v.afterRate / v.beforeRate : null)}`);
    if (v.redo) {
      out.push(`  被否决的候选「重做范围」：中断后 10 个写操作里，落在中断前已写过文件上的占 `
        + `${pct(v.redo.rate)}（${v.redo.hits}/${v.redo.total}，${v.redo.windows} 个窗口）；`
        + `同长度随机窗口（不跨人类发言）是 ${pct(v.redo.randomRate)}（${v.redo.randomWindows} 个窗口）。`
        + '**中断点低于随机切点** → 它测的是工作连续性，不是返工，不作为指标。');
    }
  }
  out.push('');
  out.push('── 控制体量 ────────────────────────────────────────────────────────');
  out.push('按执行期工具数四分位分层（返工需求率 / n）：');
  for (const s of res.strata) {
    out.push(`  ${s.label.padEnd(24)} A ${pct(s.A.primaryRate).padStart(7)} (${s.A.n})`
      + ` ｜ B ${pct(s.B.primaryRate).padStart(7)} (${s.B.n}) ｜ C ${pct(s.C.primaryRate).padStart(7)} (${s.C.n})`);
  }
  const mp = res.matched;
  out.push('');
  out.push(`体量 1:1 匹配（容差 log 比 ≤ ${mp.maxLogDist}）：配对 ${mp.n} 对`);
  out.push(`  A 返工更少 ${mp.aWins}　B 返工更少 ${mp.bWins}　打平 ${mp.ties}　A mean ${f1(mp.meanA)}　B mean ${f1(mp.meanB)}`);
  for (const p of mp.pairs) {
    out.push(`  A ${String(p.aId).slice(0, 8)} 工具 ${String(p.aTools).padStart(5)} 返工 ${p.aRework}`
      + ` ｜ B ${String(p.bId).slice(0, 8)} 工具 ${String(p.bTools).padStart(5)} 返工 ${p.bRework}`);
  }
  out.push('');
  out.push('体量相关（全部可比会话）：');
  const sc = res.sizeCorr;
  out.push(`  Spearman(工具数, 中断数) = ${f3(sc.corrToolsInterruptions)}`);
  out.push(`  Spearman(工具数, 返工需求) = ${f3(sc.corrToolsRework)}`);
  out.push(`  Spearman(工具数, 自撤销)   = ${f3(sc.corrToolsUndo)}`);
  out.push(`  控制体量后 中断数 vs 返工需求的偏相关 = ${f3(sc.partialInterruptionsRework)}`);
  out.push('');
  out.push('── 语料 ────────────────────────────────────────────────────────────');
  const tt = res.totals ?? {};
  out.push(`可比会话 ${tt.comparable ?? 0}　执行期中断 ${tt.interruptions ?? 0}`
    + `　返工需求 ${tt.reworkPrimary ?? 0}（扩展档 ${tt.reworkExtended ?? 0}）　自撤销 ${tt.undos ?? 0}`);
  out.push('');
  return out.join('\n');
}

function parseArgs(argv) {
  const out = { days: 0, json: false, root: defaultRoot(), resumeDedup: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
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
  && process.argv[1].split(String.fromCharCode(92)).join('/').endsWith('measure-intervention-cost.mjs');

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
    // seq 是 Uint32Array，JSON 里换成长度，避免输出几十 MB
    const rows = res.rows.map((r) => ({ ...r, seq: undefined, seqLen: r.seq?.length ?? 0 }));
    process.stdout.write(`${JSON.stringify({ ...res, rows }, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(res));
    process.stdout.write(`耗时 ${elapsed.toFixed(0)} ms\n`);
  }
}
