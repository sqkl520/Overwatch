#!/usr/bin/env node
/**
 * classify-stop.mjs — 「这个停止属于哪一类」。
 *
 * 纯函数。不读文件、不做 IO、不碰 process。所有输入由调用方传入，
 * 因而可以在没有真实终端、没有真实语料的情况下逐条回放与断言。
 *
 * 依据（按可信度排序，不按写作顺序）：
 *   [R§3.1] 68.3%/68.7% 的 end_turn 下一句是 task-notification —— 宿主自己会唤醒，
 *           OmniSight 插进去只会制造重复派发。这是第一个判定，也是唯一的大头。
 *   [S§2.1] permissionMode 在 154/154 个 transcript 里都能读到，但只落在 1.7% 的记录上，
 *           且会话可中途切换 —— 必须取**最后一条**，不能取第一条。
 *   [S§3]   AskUserQuestion 的回答结构化落盘为 `The user answered: "问"="答"`。
 *   [S§5.1] 「用户回复了」≠「用户授权了」。实测 `"要现在推到 GitHub 吗？"="先不推"`。
 *           所以答案必须解析内容，识别否定。
 *   [S§4][S§5.1] ExitPlanMode 后无后续 = 等批准计划，永不代答。
 *   [V§5.2a] 分类器必须读会话前文。前文只影响 confidence / autoAnswerable，
 *           不改 kind —— 分类是结构性的。
 *   [research §三] 字符重合度与「方向是否改变」正交：反转样本 Jaccard 0.00–0.08。
 *           所以前文的作用只做**刹车**，不做油门。
 *   [hosted §2.2] 判定顺序本身是设计决策：地面真值 → 宿主实时状态 → 结构性事实 → 文本。
 *
 * confidence 的取值含义（本文件定义，不含任何数字）：
 *   'measured' —— 判据是结构化信号，且该信号的精度在 research 里有实测
 *                 （origin.kind / tool_use 名称 / tool_result / 宿主 jobs.state）。
 *   'low'      —— 判据是文本正则或前文相关性；research 实测这类信号精度 45%–88%，
 *                 不足以为单条判定背书。
 *   null       —— 没有任何信号，或信号存在但不足以支撑分类。
 *   禁止填估算百分比：外观像遥测而实际编造的数字比没有更坏（hosted §2.3）。
 *
 * 用法：
 *   import { classifyStop } from './classify-stop.mjs';
 *
 *   // 推荐：停止点显式传入，调用方无法传错
 *   const r = classifyStop({ stopRecord, afterRecords, history });
 *
 * 输入（全部可选，缺省一律降级为 UNCLASSIFIABLE，绝不抛异常）：
 *   stopRecord        {...}       **推荐**。要判定哪一次停止，就传那一条 assistant 记录。
 *   afterRecords      [...]       停止点之后的记录（到下一个 assistant 之前）。
 *                                 「下一句」= 其中第一条非 tool_result 的 user 记录。
 *   history           [...]       会话开头到停止点（含）的记录，用于取 permissionMode。
 *                                 不给时退回 [stopRecord]。
 *   ── 以下是兼容路径，新代码不要用 ──
 *   transcriptTail    [...]       旧契约：停止点 = 其中最后一条 assistant。
 *                                 **实测同一批语料，tail 怎么切会给出 22.9% / 10.3% / 68.1%
 *                                 三个结果**（见 docs/research/2026-10-30-stop-signals.md §十）。
 *                                 只在无法拿到显式停止点时使用；evidence.stopSource 会标 'tail-scan'。
 *   earlierHumanMessages  [...]   会话中更早的真人消息文本
 *   jobsState             {...}   { state, needs, suggestedReply } | null
 *   permissionMode        ...     可选兜底；history / tail 里读不到时才用
 *
 * 【调用方注意】实测一个停止点有两类 stop_reason，不要只挑 end_turn：
 *   - `end_turn`（5918 条 assistant 记录，按轮去重后 3968 个停止点）
 *   - `tool_use`（124559 条）—— AskUserQuestion 与 ExitPlanMode 的停止点都在这一类里。
 *     只回放 end_turn 会一个 ASKED_* / PLAN_SUBMITTED 都看不到。
 *   另一条陷阱：同一轮会产生多条 assistant 记录（apiBlockIndex 0=thinking / 1=text），
 *   **每条都带 stop_reason:'end_turn'**，直接数记录会把停止点虚增约 1.5 倍。
 */

export const KINDS = Object.freeze([
  'WAITING_SUBAGENT',
  'WAITING_APPROVAL',
  'ASKED_AND_ANSWERED',
  'ASKED_UNANSWERED',
  'PLAN_SUBMITTED',
  'EXTERNAL_BLOCKED',
  'COMPLETION_REPORT',
  'UNCLASSIFIABLE',
]);

// ── 文本判据（只允许用在第 5、6 步，见任务约束 2）────────────────────

/** 完成汇报的措辞。baseline 给的五个词，原样使用。
 *  只在**最后一行**上匹配：正文中间出现「已提交」是叙述，「已完成 3 项，接下来…」
 *  是继续干活，都不是完成汇报。 */
const COMPLETION_RE = /已完成|已提交|全绿|工作区干净|做完了/;

/** 外部阻塞：查网关，不催重试 [hosted B8]。
 *  任务给了 API unavailable / 503 / 504 / 524 / login required / 403；
 *  401 与 403 同属认证族，一并归入（只会让更多停止落到「不可代」，方向安全）。 */
const EXTERNAL_RE = /API[\s_-]?unavailable|login required|\b50[34]\b|\b524\b|\b40[13]\b|rate[\s-]?limit/i;

/** 否定 / 撤回 / 推迟。用于两处：解析 AskUserQuestion 的答案；识别反转负样本。
 *
 *  三条排除都是实测踩出来的，不是洁癖：
 *   - `(?<!要)不要` 排除疑问句「要不要我…」——它是 research 里精度 88% 的**提议**信号，
 *     不是否定；不带这个排除，任何以「要不要」开头的问句都会被当成否决。
 *   - `^不(?!错|同|少)` 排除「不错，就这样」「跟上一版不同」这类肯定句。
 *   - `先…再` 只在跨度里出现否定/等待词时才算推迟，否则「先把报告读完再决定」这种
 *     正常行动指令会被误判成撤回——它和「先出包验成品，直到没有恶性bug再发布」是两回事。 */
const RETRACTION_RE = new RegExp([
  '先不', '暂不', '暂时不', '(?<!要)不要', '不用了?', '不必', '不需要',
  '别(?!人)', '取消', '撤回', '算了', '不推', '不提交', '不发布', '不删', '不做', '不动', '不装',
  '不再', '^不(?!错|同|少)', '不了',
  '先[^。；\\n]{0,30}?(?:不|没|别|暂|等)[^。；\\n]{0,30}?再',
].join('|'));

/** 明确的推进意图。与 RETRACTION_RE 对撞时才算反转，避免把「直接发布」误读成否定。 */
const POSITIVE_INTENT_RE = /直接(推|发|提交|删|部署|合|做)|马上|立刻|现在就|不用等|照做|继续(推|发|做)/;

/** 语气转软 / 改主意。前文明说「直接…」，当前却出现这些词，就算方向变了。
 *  「好，」放在开头才算：句中的「好像」「好在」是别的东西。 */
const HEDGE_RE = /^\s*(?:好|行|嗯|哦|那)?\s*[，,]|算了|再说|等等|等等看|回头|改天|先这样|不急/;

/** 动作词表。反转判定要求两侧提到同一族动作词，否则「不要熬夜」会和「提交代码」误配。
 *  只影响反转识别，不影响 kind —— 加词只会让刹车变多，方向是安全的。 */
const ACTION_VERBS = [
  '推送', 'push', '发布', 'release', '提交', 'commit', '删除', '删掉', '回滚', 'revert',
  '部署', 'deploy', '合并', 'merge', '测试', '安装', '覆盖', '改文档', '验收',
];

// ── 记录解析 ──────────────────────────────────────────────────────────

/** 取一条记录的 content 块数组。字符串 content 归一成 text 块，便于统一处理。 */
function contentBlocks(rec) {
  if (!rec || typeof rec !== 'object') return [];
  const c = rec.message && rec.message.content;
  if (Array.isArray(c)) return c.filter((b) => b && typeof b === 'object');
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  if (typeof rec.content === 'string') return [{ type: 'text', text: rec.content }];
  return [];
}

function textOfContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((x) => (typeof x === 'string' ? x : (x && typeof x.text === 'string' ? x.text : ''))).join('\n');
  }
  return '';
}

/** 记录的可读文本。tool_result 的 content 可能是字符串或块数组，两种都展开。 */
export function textOf(rec) {
  if (typeof rec === 'string') return rec;
  if (!rec || typeof rec !== 'object') return '';
  const c = rec.message && rec.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (typeof b === 'string') return b;
        if (!b || typeof b !== 'object') return '';
        if (typeof b.text === 'string') return b.text;
        if (b.type === 'tool_result') return textOfContent(b.content);
        return '';
      })
      .join('\n');
  }
  if (typeof rec.content === 'string') return rec.content;
  return '';
}

/** 纯 tool_result 的 user 记录：它是工具的回执，不是「下一句人话」。 */
function isToolResultOnly(rec) {
  if (!rec || rec.type !== 'user') return false;
  const blocks = contentBlocks(rec);
  return blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
}

/** 停止点之后的第一句「人话」：跳过 tool_result、attachment、system 等非对话记录。 */
function firstUtteranceAfter(after) {
  for (const rec of after) {
    if (!rec || rec.type !== 'user') continue;
    if (isToolResultOnly(rec)) continue;
    return rec;
  }
  return null;
}

/** 一条 user 记录的来源。origin.kind 是宿主分类（精度 100%），文本标签是它缺席时的兜底。
 *
 *  实测（本机 154 个 transcript）：origin.kind 只覆盖 4.5% 的 user 记录，
 *  其余靠包装标签区分（61.1% 的 user 记录不是真人 [S§9.3]）。 */
function originKindOf(rec) {
  const k = rec && rec.origin && typeof rec.origin.kind === 'string' ? rec.origin.kind : null;
  if (k) return k;
  if (isToolResultOnly(rec)) return 'tool-result';
  const t = textOf(rec);
  if (/<\s*task-notification\b/.test(t)) return 'task-notification';
  if (/<\s*cross-session-message\b/.test(t)) return 'peer';
  // 其余系统注入：local-command-caveat / ide_opened_file / no-visible-output /
  // command-name / local-command-stdout / user-prompt-submit-hook 等
  if (/^\s*<\s*[a-z][a-z0-9-]*>/.test(t)) return 'system-injected';
  return 'human';
}

/** 在 stop 之后的记录里找某个 tool_use 的 tool_result。 */
function findToolResult(after, toolUseId) {
  for (const rec of after) {
    const blocks = contentBlocks(rec);
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue;
      if (!toolUseId || b.tool_use_id === toolUseId) return b;
    }
  }
  return null;
}

/** 「等待型」工具：调用它们等于会话明确停下来等人。
 *
 *  为什么是这两个而不是「任何未闭合的 tool_use」：实测一次 `permission prompt` 的等待里
 *  悬空的多半是会话自己写的 `Bash(sleep 840)` —— 那是它在等自己派的活儿，不是在等人
 *  （`docs/research/2026-11-04-host-status-reliability.md` §3.2：66 个 permission prompt
 *  事件里 46 个卡在 sleep 上，0 个有真的待批工具）。拿它当锚点会把「自己在等」注册成等待。 */
export const WAITING_TOOL_NAMES = Object.freeze(['AskUserQuestion', 'ExitPlanMode']);

/** transcript 里**还没闭合**的等待型 `tool_use_id`，按出现顺序返回。
 *
 *  这是「一次等待」的天然锚点（去重键的一半，见 `watch.mjs` 的 `dedupeKey` 调用点）：
 *  AskUserQuestion / ExitPlanMode 各代表一次明确的「我停下来等你」，收到对应
 *  `tool_result` 就是这次等待结束，**下一次等待必然是一个新 id**。
 *  对比之下 `statusUpdatedAt` 是「状态最后一次变化」，waiting 期间只写一次、
 *  还可能被宿主无规律重写（实测 33 / 54 分钟各一次），既不能区分第几次等待，也不稳定。
 *
 *  实测（`docs/research/2026-11-04-dedup-key-analysis.md` §4.4）：同一个 id 在 3 个不同
 *  transcript 文件里逐字相同；同一 `tool_use` 会以两行出现（一行带 timestamp、一行
 *  `timestamp: undefined`，重写留下的），两行的 id 相同 —— 所以按 id 去重，不按行数。
 *
 *  `tool_result` 可能在 tail 之前就被截掉了（`readTranscriptTail` 只读尾部 1MB）。
 *  找不到闭合时**不猜测**：返回的 id 照常作为锚点，它仍然唯一标识这次等待。 */
export function openWaitingToolUseIds(records) {
  const arr = Array.isArray(records) ? records : [];
  const seen = new Set();
  const order = [];
  const closed = new Set();
  for (const rec of arr) {
    for (const b of contentBlocks(rec)) {
      if (b.type === 'tool_result') {
        if (typeof b.tool_use_id === 'string') closed.add(b.tool_use_id);
        continue;
      }
      if (b.type !== 'tool_use') continue;
      if (!WAITING_TOOL_NAMES.includes(b.name)) continue;
      if (typeof b.id !== 'string' || !b.id) continue;
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      order.push(b.id);
    }
  }
  return order.filter((id) => !closed.has(id));
}

/** 取**最后一条**带 permissionMode 的记录 [S§2.1]。
 *  取第一条会把「中途切到 plan 模式」的会话读成它启动时的模式，是本任务 AC6 明确禁止的错误。 */
export function lastPermissionMode(records) {
  const arr = Array.isArray(records) ? records : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const r = arr[i];
    if (r && typeof r.permissionMode === 'string' && r.permissionMode) return r.permissionMode;
  }
  return null;
}

// ── AskUserQuestion 的答案解析 ────────────────────────────────────────

/** 是否否定。只认词形，不认裸「不」。
 *  实测样本 `"要现在推到 GitHub 吗？"="先不推"` —— 这类答案被当成「同意」会误推 [S§3.1]。 */
export function answerIsNegative(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return false;
  return RETRACTION_RE.test(s);
}

/** 解析 `The user answered: "问"="答", "问2"="答2"` 与
 *  `Your questions have been answered: "问"="答"` 两种落盘格式 [S§3]。
 *
 *  不用 `.*` 贪婪匹配：答案里会带逗号、引号、换行（实测有整段说明）。
 *  `(?:[^"\\]|\\.)*` 的两个分支首字符不相交，不会指数回溯。 */
export function parseAskAnswers(text) {
  const s = typeof text === 'string' ? text : '';
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const question = m[1].trim();
    const answer = m[2].trim();
    if (!question) continue;          // `selected preview:` 之后的残片，不是问答对
    out.push({ question, answer, negative: answerIsNegative(answer) });
  }
  return out;
}

// ── 会话前文（AC5 / AC8）──────────────────────────────────────────────

/** 去标点后的字符二元组集合。中文没有空格分词，二元组是最便宜的近似。 */
function bigrams(s) {
  const t = String(s || '')
    .toLowerCase()
    .replace(/[\s，。、；：！？,.;:!?"'“”‘’（）()[\]{}<>《》〈〉—\-_/\\|~`·…]+/g, '');
  const set = new Set();
  if (t.length === 1) set.add(t);
  for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2));
  return set;
}

/** 文本相关性：字符二元组的重合系数（overlap / containment），不是 Jaccard。
 *
 *  为什么不用 Jaccard（research §9.2 用的是它）：早期真人消息通常很长（一条消息里
 *  三四件事），当前停止的文本很短。Jaccard 会被长度差惩罚——实测同一对文本，
 *  Jaccard 0.108 / 重合系数 0.222，阈值无论怎么设都分不开「相关」与「不相关」。
 *  重合系数 = |A∩B| / min(|A|,|B|)，测的是「短的那句是否被长的那句覆盖」，
 *  正是这里要问的问题。
 *
 *  【它只用于给 confidence 一个可复算的依据，不用于判断方向是否改变】——
 *  research §三 已证明字符重合与「方向是否改变」正交（反转样本 0.00–0.08）。
 *  反转判定走 isReversal()，与这个分数无关。 */
export function relevanceOf(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.min(A.size, B.size);
}

function polarityOf(text) {
  const s = String(text || '');
  if (RETRACTION_RE.test(s)) return -1;
  if (POSITIVE_INTENT_RE.test(s)) return 1;
  return 0;
}

function sharedVerbs(a, b) {
  const sa = String(a || '').toLowerCase();
  const sb = String(b || '').toLowerCase();
  return ACTION_VERBS.filter((v) => sa.includes(v.toLowerCase()) && sb.includes(v.toLowerCase()));
}

/** 两句话是否构成「前文说 A、后续说非 A」。
 *
 *  判据是**极性与动作词**，不是文本重合：用户推翻自己时几乎必然换词
 *  （research §三的六对样本 Jaccard 0.00–0.08），重合度抓不到。
 *
 *  三条规则，方向全部是「加刹车」：
 *    1. 前文明确否决、当前提到同一族动作词 → 反转。这是 AC8 的主力规则。
 *    2. 两侧都有明确极性且相反 → 反转。
 *    3. 前文明说「直接/马上/现在就…」、当前却转了语气（「算了」「好，」）→ 反转。
 *       规则 3 覆盖「验收通过后直接推送 → 算了，等着再推」这类：两侧都没有共享动作词，
 *       但「前文是明确推进、当前变成含糊/推迟」本身就是方向变了。
 *
 *  **不设「当前否决 + 前文推进」这一支**：它会把「前文说直接发布 → 现在说先别发」
 *  判成反转，而那是完全正确的信息，在 WAITING_APPROVAL 里属于多余的刹车。
 *  真正要拦的场景（前文说 A、后续说非 A）由上面三条覆盖。 */
function isReversal(current, earlier, verbs) {
  const b = polarityOf(earlier);
  if (b < 0 && verbs.length > 0) return true;              // 规则 1
  const a = polarityOf(current);
  if (a !== 0 && b !== 0) return a !== b;                  // 规则 2
  if (b > 0 && HEDGE_RE.test(String(current || ''))) return true; // 规则 3
  return false;
}

/** 在当前文本里找最相关的早期真人消息。
 *
 *  返回 { index, score, reversal, verbs }；index 是 `earlierHumanMessages` 的下标（从 0 起），
 *  -1 表示没有可用前文。
 *
 *  反转优先于相关性，但**反转不要求文本重合**——这是 research §三 的直接推论：
 *  「暂时不要提交」→「提交两仓」的 Jaccard 是 0.07，靠重合永远抓不到。
 *  因此反转只要求：前文有否决极性、当前提到同一族动作词。
 *  相关性（Jaccard ≥ 0.25）只用于非反转场景的置信度提升，不参与 kind 判定。 */
export function findEarlierMatch(current, earlierHumanMessages) {
  const list = Array.isArray(earlierHumanMessages)
    ? earlierHumanMessages.filter((s) => typeof s === 'string' && s.trim())
    : [];
  const cur = typeof current === 'string' ? current : '';
  let bestRev = null;
  let bestRel = { index: -1, score: 0, reversal: false, verbs: [] };

  for (let i = 0; i < list.length; i++) {
    const ear = list[i];
    const score = relevanceOf(cur, ear);
    const verbs = sharedVerbs(cur, ear);
    if (isReversal(cur, ear, verbs)) {
      // 反转命中不按 score 挑：反转场景里 score 本来就接近 0，按它排序等于随机。
      // 取最早的一条，保证同一输入的结果可复算。
      if (!bestRev) bestRev = { index: i, score, reversal: true, verbs };
    } else if (score > bestRel.score) {
      bestRel = { index: i, score, reversal: false, verbs };
    }
  }
  if (bestRev) return bestRev;
  // 相关性阈值 0.20：由本文件的测试夹具标定，不是实测精度。设计上要它同时满足
  // 「长前文 + 短当前文本仍算相关」与「换话题不算相关」，实测两组落在 0.22 与 0.00，
  // 取 0.20 留一点余量。它只决定 evidence 里记不记一笔、confidence 是 low 还是 null，
  // 不参与 kind，也不参与 autoAnswerable —— 所以调错这个数不会造成误代答。
  return bestRel.score >= 0.2 ? bestRel : { index: -1, score: bestRel.score, reversal: false, verbs: bestRel.verbs };
}

// ── 主函数 ────────────────────────────────────────────────────────────

function verdict(kind, autoAnswerable, reason, confidence, evidence) {
  return { kind, autoAnswerable, reason, confidence, evidence };
}

/**
 * 判定一个停止点属于哪一类。有序互斥，首个命中即返回。
 *
 * 每一步的判据与来源写在分支上方。顺序照抄任务书，依据是信号可靠性递减：
 * 地面真值（下一句）→ 结构性事实（最后一条 tool_use）→ 宿主实时状态（jobs）
 * → 文本（最不可靠，排最后）。
 */
export function classifyStop(input) {
  const args = input && typeof input === 'object' ? input : {};

  // ── 契约：{ stopRecord, afterRecords, history } ──────────────────
  //
  // 旧契约是「传一个 transcriptTail，自己找最后一条 assistant 当停止点」。
  // 实测同一个分类器、同一批语料，只因 tail 构造方式不同就得到三个结果：
  //   slice(i, i+6)    -> 22.94%  （截断了「下一句」）
  //   slice(i, i+40)   -> 10.27%  （锚定到最后一个 assistant，不是当前停止点）
  //   [stop, ...after] -> 67.95%  （正确）
  // 第二个失败模式代码里没有任何警告，是隐式契约的典型陷阱。
  // 现在把停止点显式传进来，调用方无法传错。
  const explicitStop = args.stopRecord && typeof args.stopRecord === 'object' ? args.stopRecord : null;

  // 兼容旧调用：没给 stopRecord 时才回落到「tail 里最后一条 assistant」。
  // 这条路径保留是为了不打断已有测试，但会在 evidence 里标出来，便于发现误用。
  let tail = [];
  if (explicitStop) {
    tail = [explicitStop];
  } else {
    tail = Array.isArray(args.transcriptTail) ? args.transcriptTail.filter((r) => r && typeof r === 'object') : [];
  }

  const after = explicitStop
    ? (Array.isArray(args.afterRecords) ? args.afterRecords.filter((r) => r && typeof r === 'object') : [])
    : null;   // null = 需要从 tail 里切

  // history = 从会话开头到停止点（含）的记录，用于取 permissionMode。
  // 不给时退回 tail / [stopRecord]。
  const history = Array.isArray(args.history) ? args.history
    : (explicitStop ? [explicitStop] : tail);

  const earlier = Array.isArray(args.earlierHumanMessages) ? args.earlierHumanMessages : [];
  const jobs = args.jobsState && typeof args.jobsState === 'object' ? args.jobsState : null;

  const evidence = {
    stopUuid: null,
    // 'explicit' = 调用方传了 stopRecord（推荐）；'tail-scan' = 回落路径，可能锚错
    stopSource: explicitStop ? 'explicit' : 'tail-scan',
    stopReason: null,
    lastToolUse: null,
    originKind: null,
    permissionMode: null,
    permissionModeSource: null,
    earlierMatch: null,
    jobsState: jobs && typeof jobs.state === 'string' ? jobs.state : null,
    jobsNeeds: jobs && typeof jobs.needs === 'string' ? jobs.needs : null,
  };

  // 定位停止点。显式给了 stopRecord 就直接用；否则回落到 tail 里最后一条 assistant。
  let stopIdx = -1;
  if (explicitStop) {
    stopIdx = 0;
  } else {
    for (let i = tail.length - 1; i >= 0; i--) {
      if (tail[i].type === 'assistant') { stopIdx = i; break; }
    }
  }
  if (stopIdx < 0) {
    return verdict('UNCLASSIFIABLE', false, '输入里没有 assistant 记录，定位不到停止点', null, evidence);
  }

  const stop = tail[stopIdx];
  const afterRecords = after ?? tail.slice(stopIdx + 1);
  const blocks = contentBlocks(stop);
  const stopText = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n').trim();
  const toolUses = blocks.filter((b) => b.type === 'tool_use');
  const lastTool = toolUses.length ? toolUses[toolUses.length - 1] : null;

  evidence.stopUuid = typeof stop.uuid === 'string' ? stop.uuid : null;
  evidence.stopReason = (stop.message && stop.message.stop_reason) || null;
  evidence.lastToolUse = lastTool && typeof lastTool.name === 'string' ? lastTool.name : null;

  // AC6：取最后一条，而不是第一条。tail 里没有时才回落到调用方显式给的值。
  const pmFromTail = lastPermissionMode(history);
  evidence.permissionMode = pmFromTail ?? (typeof args.permissionMode === 'string' ? args.permissionMode : null);
  evidence.permissionModeSource = pmFromTail ? 'tail:last' : (evidence.permissionMode ? 'input' : null);

  // ── 第 1 步：下一句是 task-notification → WAITING_SUBAGENT ──
  // [R§3.1] 68.3%–68.7% 的 end_turn 后面跟着宿主的子 Agent 完成通知。
  // 这类停止宿主自己会唤醒，OmniSight 插进去 = 重复派发。绝不代答。
  const nextUtterance = firstUtteranceAfter(afterRecords);
  const nextKind = nextUtterance ? originKindOf(nextUtterance) : null;
  evidence.originKind = nextKind;
  if (nextKind === 'task-notification') {
    return verdict(
      'WAITING_SUBAGENT', false,
      '下一句是子 Agent 完成通知，宿主会自己唤醒，代答只会制造重复派发',
      'measured', evidence,
    );
  }

  // ── 第 2 步：最后一条是 ExitPlanMode 的 tool_use 且无后续 tool_result → PLAN_SUBMITTED ──
  // [S§4][S§5.1] 计划批准是产品方向决策，属硬边界，永不代答。
  // 有 tool_result 时不判本类：实测 11 次真实调用全部带结果（批准 / 拒绝 / 报错），
  // 其中「You are not in plan mode」是**调用失败**，不是提交，必须落到后续步骤。
  if (lastTool && lastTool.name === 'ExitPlanMode') {
    const planResult = findToolResult(afterRecords, lastTool.id);
    if (!planResult) {
      evidence.planResult = 'absent';
      return verdict(
        'PLAN_SUBMITTED', false,
        'ExitPlanMode 已调用且无 tool_result：计划待批准，属产品方向决策，永不代答',
        'measured', evidence,
      );
    }
    const prText = textOfContent(planResult.content);
    evidence.planResult = /not in plan mode/i.test(prText) ? 'failed-not-in-plan-mode' : 'answered';
  }

  // ── 第 3、4 步：AskUserQuestion 有 / 无 tool_result ──
  // [S§3][S§3.2] 66 次调用里只有 33 次拿到回答 —— 「问了」和「答了」必须分开判。
  if (lastTool && lastTool.name === 'AskUserQuestion') {
    const answerBlock = findToolResult(afterRecords, lastTool.id);
    const questions = (lastTool.input && Array.isArray(lastTool.input.questions))
      ? lastTool.input.questions.map((q) => (q && typeof q.question === 'string' ? q.question : '')).filter(Boolean)
      : [];
    const questionText = questions.join(' ');

    if (answerBlock) {
      const answerText = textOfContent(answerBlock.content);
      const answers = parseAskAnswers(answerText);
      // 解析不出问答对时（格式漂移），退化为对整段做否定检测 —— 宁可多判否定。
      const negative = answers.length ? answers.some((a) => a.negative) : answerIsNegative(answerText);
      evidence.answers = answers;
      evidence.answerNegative = negative;

      // 前文匹配要把**答案**也算进去：用户推翻自己时，反转写在答案里，
      // 不是写在 AI 的问题里（问题往往还是旧方向的原话）。
      const ctx = findEarlierMatch(`${questionText} ${answerText}`, earlier);
      if (ctx.index >= 0) {
        evidence.earlierMatch = { index: ctx.index, score: Number(ctx.score.toFixed(3)), reversal: ctx.reversal };
      }

      // autoAnswerable 恒为 false，两个独立理由：
      // 1. 答案已经由宿主交付，OmniSight 再投递等于替用户把话再说一遍；
      // 2. 「有回复」不能当「同意」[S§5.1] —— 实测 `"要推到 GitHub 吗？"="先不推"`。
      const reason = negative
        ? `用户答复是否定（${answers.filter((a) => a.negative).map((a) => a.answer).join('；').slice(0, 40)}），不能当作授权`
        : '用户已作答，原始答复由宿主交付，不能把「有回复」当「授权」再投一次';
      return verdict('ASKED_AND_ANSWERED', false, reason, 'measured', evidence);
    }

    const ctx = findEarlierMatch(questionText, earlier);
    if (ctx.index >= 0) {
      evidence.earlierMatch = { index: ctx.index, score: Number(ctx.score.toFixed(3)), reversal: ctx.reversal };
    }
    // [S§五·4] 只有「程序性问题」可代，但没有任何可复算的判据把程序性/方向性分开
    // （文本信号实测 88% / 75% / 58%，不足以为单条背书），所以一律不代。
    return verdict(
      'ASKED_UNANSWERED', false,
      ctx.index >= 0
        ? `问了但没答；问题与会话早前第 ${ctx.index + 1} 条真人消息相关，但相关性不能替代用户的回答`
        : 'AskUserQuestion 已调用且无 tool_result：问了但没答，方向性问题不可代',
      'measured', evidence,
    );
  }

  // ── 第 5 步：jobs.state === 'blocked' → 按 needs 细分 ──
  // [hosted B8] 「等 API 恢复 / 503」不是可催的重试，正确动作是查网关或换模型。
  // 这一支是唯一一类 autoAnswerable 可能为 true 的停止：宿自己给了 suggestedReply。
  if (jobs && jobs.state === 'blocked') {
    const needs = typeof jobs.needs === 'string' ? jobs.needs : '';
    if (EXTERNAL_RE.test(needs)) {
      return verdict(
        'EXTERNAL_BLOCKED', false,
        '宿主报 blocked 且 needs 指向外部故障（API/网关/认证）：正确动作是查网关，不是催它重试',
        'measured', evidence,
      );
    }

    const suggested = typeof jobs.suggestedReply === 'string' ? jobs.suggestedReply.trim() : '';
    const ctx = findEarlierMatch(`${needs} ${suggested}`, earlier);
    if (ctx.index >= 0) {
      evidence.earlierMatch = { index: ctx.index, score: Number(ctx.score.toFixed(3)), reversal: ctx.reversal };
    }

    // 三个否决条件，任一命中即不可代：
    //   ① 没有宿主给的建议答复 —— 凭空生成就是替用户决策；
    //   ② 建议答复本身是否定 —— 把否定当授权是最危险的一类误判 [S§5.1]；
    //   ③ 与会话前文构成反转 —— 用户明确推翻过，不能沿用旧方向 [research §三]。
    let auto = true;
    let why = '';
    if (!suggested) { auto = false; why = '宿主没有给出建议答复，凭空生成等于替用户决策'; }
    else if (answerIsNegative(suggested)) { auto = false; why = '宿主给的答复本身是否定，不能当授权'; }
    else if (ctx.reversal) { auto = false; why = `与第 ${ctx.index + 1} 条早期真人消息构成反转，不能沿用旧方向`; }

    return verdict(
      'WAITING_APPROVAL', auto,
      auto
        ? '宿主报 blocked，等待的是人工批准，且宿主已给出建议答复'
        : `宿主报 blocked：${why}`,
      'measured', evidence,
    );
  }

  // ── 第 6 步：完成汇报 ──
  // 文本判据放这里：它只决定标签，不决定是否代答（本类一律不可代）。
  // 只看**最后一行** —— 「已完成 3 项，接下来…」不是完成汇报，是继续干活。
  // 判据从「末行」放宽到「末行若为纯标题/分隔符，则回退到最后一个非标题行」，
  // 因为真实的完成汇报经常以 markdown 标题结尾。这个放宽只影响标签，不影响是否代答。
  const lines = stopText.split('\n').map((s) => s.trim()).filter(Boolean);
  const isDecor = (s) => /^[#>*\-_`|]+$/.test(s) || /^\|?[\s:|-]+\|?$/.test(s);
  let lineIdx = lines.length - 1;
  while (lineIdx > 0 && (isDecor(lines[lineIdx]) || lines[lineIdx].length < 2)) lineIdx--;
  const lastLine = lines.length ? lines[lineIdx] : '';
  const completionHit = COMPLETION_RE.test(lastLine) ? lastLine : null;
  if (completionHit) {
    evidence.completionSignal = completionHit.slice(0, 60);
    // research §六：「完成」与「停滞」不可分，291 个完成型停止后面 55% 是新任务。
    // 所以只报告，不代答。
    return verdict('COMPLETION_REPORT', false, '最后一轮是完成汇报；完成与停滞不可分，不据此代答', 'low', evidence);
  }

  // ── 第 7 步：其余 ──
  // 前文在这一步只影响 confidence（null → low）与 autoAnswerable（恒 false），不改 kind。
  const ctx = findEarlierMatch(`${stopText} ${lastLine}`, earlier);
  if (ctx.index >= 0) {
    evidence.earlierMatch = { index: ctx.index, score: Number(ctx.score.toFixed(3)), reversal: ctx.reversal };
  }
  if (nextKind && nextKind !== 'human') evidence.nextUtteranceKind = nextKind;

  const confidence = ctx.index >= 0 ? 'low' : null;
  const reason = ctx.index >= 0
    ? `无结构化停止信号；文本与会话早前第 ${ctx.index + 1} 条真人消息相关，但相关性推不出停止类别`
    : '没有任何结构化停止信号，也没有可用前文';
  return verdict('UNCLASSIFIABLE', false, reason, confidence, evidence);
}
