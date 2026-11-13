#!/usr/bin/env node
/**
 * tui-layout.mjs — 列表页的布局数学。**全部是纯函数：无 I/O、无时钟、无全局状态。**
 *
 * 存在的理由（`docs/research/2026-11-05-dsh-tui-analysis.md` §6 第一条）：
 * 旧实现的宽度、截断、列宽、降级全写在 `oversight-tui.mjs` 的 `buildFrame()` 里，
 * 于是「76 列下这一行有多宽」只能靠人眼看，**无法单测**。把布局抽出来以后，
 * 每一条降级阶梯、每一次截断、每一个视口都有断言。
 *
 * 设计规格：`docs/design/2026-11-05-tui-redesign-plan.md` §2.4（屏幕草图）、
 * §2.5（字段矩阵）、§2.6（空状态）、§九·二（裁决结论）。
 *
 * 三条硬纪律（抄自 dsh-TUI，零依赖可搬）：
 *   1. **固定列宽 + 空着也占位**：状态格/光标格恒定 2 列，列不会因为某行没内容而出现或消失；
 *   2. **三通道不重叠**：选中用 `❯` + 绿色文字，严重度用状态字形 + 颜色，两者不共用视觉通道；
 *   3. **溢出可数披露**：截断时写 `… (+18 字)`，而不是静默切掉。
 *
 * 本文件不判定状态。二值化（在跑 / 已停）只是分类，的事实都来自 scan --json。
 */

import { binaryColor, displayWidth, padDisplay, paint, stripAnsi, truncateDisplay } from './tui-theme.mjs';

// ── 尺寸档位 ──────────────────────────────────────────────────────────

/** 设计基准 76 列（80 列终端留 2 列页边距）。各档的边界是**可验收的常量**，不是散落的 if。 */
export const TIERS = Object.freeze({
  wide: 76,
  narrow: 60,
  tiny: 44,
});

/** 一屏里永不撤除的三样（规划 §2.4-D）。测试直接引用这个常量。 */
export const NEVER_DROP = Object.freeze(['verdict', 'action', 'actionColumn']);

// ── 时间格式 ──────────────────────────────────────────────────────────

/**
 * 时长（秒）→ 人话。列表页只用这一个函数，避免「8s」和「8 秒」两种写法并存。
 *
 * 边界取 60 / 3600 / 86400，与旧 fmtDur 一致（旧测试锁过它的语义），
 * 但新增了 `≥ 1 天` 时不带小数点的分支：22.8d 比 22.80d 好读。
 */
export function fmtSpan(sec) {
  const s = Number(sec);
  // `Number(null) === 0` —— 必须显式挡住，否则「没有 idleSec」会被画成 `0s`（那是撒谎）。
  if (sec === null || sec === undefined) return 'n/a';
  if (!Number.isFinite(s)) return 'n/a';
  if (s < 0) return '0s';
  // 四舍五入后再判档：59.6s 不能画成 `60s`（该升成 `1m`）。
  // 每档都先取整，再检查是否跨档 —— 否则会出现 `60s` / `60m` / `24.0h` 这种边界噪声。
  if (s < 60) {
    const r = Math.round(s);
    if (r < 60) return `${r}s`;
    return '1m';
  }
  if (s < 3600) {
    const r = Math.round(s / 60);
    if (r < 60) return `${r}m`;
    return '1.0h';
  }
  if (s < 86400) {
    const h = Number((s / 3600).toFixed(1));
    if (h < 24) return `${h.toFixed(1)}h`;
    return '1.0d';
  }
  return `${(s / 86400).toFixed(1)}d`;
}

/** 毫秒 → 「8 秒前」这类相对时间。用于扫描新鲜度。 */
export function fmtAgeMs(ms) {
  if (!Number.isFinite(ms)) return '未知';
  return `${fmtSpan(Math.max(0, ms) / 1000)}前`;
}

/** 扫描新鲜度：「8 秒前扫描」。**空状态必须携带它**（规划 §2.6 第二要素）。 */
export function fmtScanAge(ms) {
  if (!Number.isFinite(ms)) return '扫描时刻未知';
  return `${fmtAgeMs(ms)}扫描`;
}

// ── 溢出可数披露 ──────────────────────────────────────────────────────

/**
 * 按显示宽度截断，并把「丢掉多少」写回来。
 *
 * 为什么不是 `truncateDisplay` 就够：静默截断会让读者把删节误读成完整。
 * Claude Code 的纪律是 `… (+141 chars NOT SHOWN)`（逆向报告 §3.5），
 * 我们的中文版是 `… (+18 字)`。
 *
 * @param {string} text
 * @param {number} width 可用列数
 * @returns {{text: string, omitted: number, truncated: boolean}}
 *          omitted 是**被丢弃的显示列数**，不是字符数（CJK 一个字两列）。
 */
export function truncateWithDisclosure(text, width) {
  const s = String(text ?? '');
  const max = Math.floor(Number(width));
  if (!Number.isFinite(max) || max <= 0) return { text: '', omitted: displayWidth(s), truncated: s.length > 0 };
  const total = displayWidth(s);
  if (total <= max) return { text: s, omitted: 0, truncated: false };
  // 尾巴本身要占地方：先算它有多宽，再决定正文留多少
  const omittedGuess = total - max + 1;
  const tail = `… (+${omittedGuess} 列)`;
  const tailWidth = displayWidth(tail);
  const budget = Math.max(1, max - tailWidth);
  const head = truncateDisplay(s, budget);
  // truncateDisplay 自己在 budget 内会补一个 `…`；这里不要两个省略号
  const body = head.endsWith('…') ? head.slice(0, -1) : head;
  const used = displayWidth(body);
  const omitted = Math.max(1, total - used);
  return { text: `${body}… (+${omitted} 列)`, omitted, truncated: true };
}

/** 右对齐到固定宽度（不足补空格，超出截断）。 */
export function alignRight(text, width) {
  const w = Math.max(0, Math.floor(Number(width)));
  const s = String(text ?? '');
  const used = displayWidth(s);
  if (used === w) return s;
  if (used < w) return ' '.repeat(w - used) + s;
  return padDisplay(s, w);
}

// ── 列布局 ────────────────────────────────────────────────────────────

/**
 * 把若干单元格排成一行，宽度**精确等于** width（或在不截断单元格的前提下 ≤ width）。
 *
 * cell = { text, width?, flex?, align?: 'left'|'right', min? }
 *   - 有 `flex: true` 的单元格吸收剩余宽度（最多一个；多个时最后一个生效）
 *   - 固定宽度单元格先扣掉，再算 flex
 *   - 任何单元格都不因内容为空而消失 —— **列必须恒定**，否则整屏会随数据抖动
 *
 * @param {Array<{text?: string, width?: number, flex?: boolean, align?: string, min?: number}>} cells
 * @param {number} width
 * @returns {string}
 */
export function layoutRow(cells, width) {
  const total = Math.max(0, Math.floor(Number(width)));
  const list = Array.isArray(cells) ? cells.filter(Boolean) : [];
  if (!list.length) return '';
  const flexIdx = list.map((c, i) => (c.flex ? i : -1)).filter((i) => i >= 0).pop();
  const fixed = list.reduce((n, c, i) => (i === flexIdx ? n : n + Math.max(0, Math.floor(Number(c.width) || 0))), 0);

  let out = '';
  let used = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const w = i === flexIdx
      ? Math.max(Math.floor(Number(c.min) || 0), total - fixed)
      : Math.max(0, Math.floor(Number(c.width) || 0));
    if (w <= 0) continue;
    const text = String(c.text ?? '');
    out += c.align === 'right' ? alignRight(text, w) : padDisplay(text, w);
    used += w;
  }
  return displayWidth(out) > total ? truncateDisplay(out, total) : out;
}

/** 每隔一段插分隔符（` · `）并整体卡在 width 内，超出时**按优先级从尾部丢项**。 */
export function joinWithin(parts, width, sep = ' · ') {
  const total = Math.max(0, Math.floor(Number(width)));
  const kept = [];
  for (const p of parts) {
    const s = String(p ?? '');
    if (!s) continue;
    const candidate = kept.length ? kept.join(sep) + sep + s : s;
    if (displayWidth(candidate) <= total) { kept.push(s); continue; }
    // 装不下：如果是第一项，截断它；否则丢弃这一项及其后的全部
    if (!kept.length) return truncateDisplay(s, total);
    break;
  }
  return kept.join(sep);
}

// ── 视口 ──────────────────────────────────────────────────────────────

/**
 * 窗口化：给定总数、光标位置、可视行数与当前偏移，返回合法偏移。
 *
 * 纯函数版（旧实现把 `listOffset` 写成实例状态，`buildListFrame` 里边算边改，
 * 于是「第几行可见」无法单测）。
 *
 * 规则：光标始终在窗口内；窗口不越出数据两端；光标看不见时才滚动最小距离。
 *
 * @param {{count:number, cursor:number, area:number, offset?:number}} p
 * @returns {{offset:number, end:number}}
 */
export function windowOf({ count, cursor, area, offset = 0 }) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const a = Math.max(1, Math.floor(Number(area) || 1));
  const cur = Math.min(Math.max(0, Math.floor(Number(cursor) || 0)), Math.max(0, n - 1));
  let off = Math.max(0, Math.floor(Number(offset) || 0));
  if (n <= a) return { offset: 0, end: n };
  if (cur < off) off = cur;
  if (cur >= off + a) off = cur - a + 1;
  off = Math.min(off, n - a);
  off = Math.max(0, off);
  return { offset: off, end: Math.min(n, off + a) };
}

// ── 降级阶梯 ──────────────────────────────────────────────────────────

/**
 * 纵向+横向降级阶梯。**顺序是显式声明的，不是按宽度逐个砍尾部**（旧 `listRow` 的做法）。
 *
 * 从最全到最省，第一档装得下的赢。撤除顺序（规划 §2.4-D）：
 *   ① 「近」列（一句话摘要）—— 最可省
 *   ② 「已停」段标题与计数 —— 折叠进判决行
 *   ③ 检查项句子里「凭什么这么判」的括注（`showCheckSource`）—— 只留断言本身
 *   ④ 路径副行 —— 只留标题
 *   ⑤ 「等了多久」—— 但需动作段整段永不撤
 *   ⑥ 只留：判决行 + 需动作段 + 状态行
 *
 * **永不撤除**：判决行、需动作段、动作列（`c` / `Enter`，见 NEVER_DROP）。
 */
const STAGES = [
  {
    id: 'full',
    minCols: TIERS.wide, minRows: 18,
    showNear: true, showPath: true, showIdle: true, showStopped: true,
    showCheckSource: true, showChecklist: true, showBlank: true, actionTwoLine: true,
  },
  {
    // ① 撤「近」列：一句话摘要最先让位，因为它是辅助信息（不改变动作）
    id: 'no-near',
    minCols: TIERS.narrow, minRows: 16,
    showNear: false, showPath: true, showIdle: true, showStopped: true,
    showCheckSource: true, showChecklist: true, showBlank: true, actionTwoLine: true,
  },
  {
    // ② 撤「已停」段 + ③ 撤检查表来源列（计数已折叠进判决行）
    id: 'no-stopped-no-source',
    minCols: TIERS.tiny, minRows: 12,
    showNear: false, showPath: true, showIdle: true, showStopped: false,
    showCheckSource: false, showChecklist: true, showBlank: false, actionTwoLine: true,
  },
  {
    // ④ 撤路径副行 + ⑤ 撤「等了多久」：动作列保留
    id: 'title-only',
    minCols: 0, minRows: 8,
    showNear: false, showPath: false, showIdle: false, showStopped: false,
    showCheckSource: false, showChecklist: false, showBlank: false, actionTwoLine: true,
  },
  {
    // ⑥ 极矮：动作段压成一行（逐字 needs 仍在详情页里），判决行与动作恒在
    id: 'minimal',
    minCols: 0, minRows: 0,
    showNear: false, showPath: false, showIdle: false, showStopped: false,
    showCheckSource: false, showChecklist: false, showBlank: false, actionTwoLine: false,
  },
];

/**
 * 选出当前终端尺寸对应的布局档。
 * @param {{cols:number, rows:number}} p
 * @returns {typeof STAGES[number] & {cols:number, rows:number, tier:string}}
 */
export function resolveLayout({ cols, rows } = {}) {
  const c = Math.max(1, Math.floor(Number(cols) || 80));
  const r = Math.max(1, Math.floor(Number(rows) || 24));
  const stage = STAGES.find((s) => c >= s.minCols && r >= s.minRows) ?? STAGES[STAGES.length - 1];
  const tier = c >= TIERS.wide ? 'wide' : c >= TIERS.narrow ? 'narrow' : c >= TIERS.tiny ? 'tiny' : 'micro';
  return { ...stage, cols: c, rows: r, tier };
}

/** 供测试枚举阶梯（顺序即撤除顺序）。 */
export function layoutStages() {
  return STAGES.map((s) => ({ ...s }));
}

// ── 二值化与三段分区 ──────────────────────────────────────────────────

/** 需要人处理的宿主事实态。**只信这三个**，其余一律不是「在等你」。 */
export const ACTION_STATES = Object.freeze(['WAITING', 'BLOCKED', 'FAILED']);

/**
 * 「需动作」里各类事实的**老化上限**（秒）。超过就不再进需动作区，降级进「已停」。
 *
 * 为什么必须有这张表：宿主把 WAITING / BLOCKED / FAILED 永久留在它的状态文件里，
 * 于是**一个 33 天前问的问题，今天仍然会被画成「需动作」**。用户的原话是
 * 「都是我很久很久都没有搞过的对话了，它发了个问句就判定成需动作这很不合理」。
 * 这不是渲染问题，是分区判据缺了一条时间维度。
 *
 * 三个数字各有出处，没有一个是拍的：
 *
 *  - `WAITING: 24h` —— 本机 247 个 transcript 实测（2026-11-11）：
 *    457 条以问号结尾的 assistant 消息里，443 条能配对到「之后第一条真人消息」。
 *    回答延迟 p50 = 0.27h、p90 = 10.93h、p95 = 15.23h、**p99 = 17.59h**、max 28.6h，
 *    **99.5% 在 24 小时内**。24h 是 p99 的 1.4 倍，且与仓库里已有的
 *    `asked.mjs: MAX_QUESTION_HOURS = 24`、`ASKED_MAX_SILENCE_HOURS` 同一个口径
 *    （那两个也是从回复延迟分布标定的）。剩下的 11 条**永远不会有人回**——
 *    它们正是需要老化的那批。
 *  - `BLOCKED: 7d` —— 直接沿用 `watch.mjs: BLOCKED_MAX_AGE`（2026-11-02 用户划的线：
 *    「一个 3 天前就卡住、进程还在的后台作业仍值得看一眼；一个 27 天前的 503 不值得」）。
 *    **不在这里重新发明一个数**：通知门和展示门对同一件事必须用同一条线，
 *    否则会出现「不通知你，但列表里天天排在第一位」。两边相等由测试钉住
 *    （`tui-layout.test.mjs` 断言本常量 × 1000 === `BLOCKED_MAX_AGE`）。
 *  - `FAILED: 7d` —— **没有独立实测**，镜像 BLOCKED。两者都是宿主写下的终态事实、
 *    都永久留在状态文件里，没有任何理由让其中一个活得更久。这是本表唯一一条推定值，
 *    写在这里而不是藏起来。
 */
export const ACTION_MAX_AGE_SEC = Object.freeze({
  WAITING: 24 * 3600,
  BLOCKED: 7 * 86400,
  FAILED: 7 * 86400,
});

/** 某状态的等待上限（秒）。不是需动作态、或上限未知时返回 null。 */
export function ageLimitOf(session) {
  const v = ACTION_MAX_AGE_SEC[session && session.state];
  return Number.isFinite(v) ? v : null;
}

/**
 * 这条需动作事实**是否已经老到不该再占用「需动作」**。
 *
 * 时钟是**注入的**：优先用行上已经算好的 `idleSec`（它由调用链一路从
 * `buildSections({nowMs})` / `liveToRow(live, nowMs)` / `jobToRow(job, nowMs)` 传下来），
 * 其次才用 `(nowMs - statusUpdatedAt)` 现算。本函数**自己不读挂钟**——
 * 这个仓库刚因为硬编码 `Date.now()` 修过 bug，老化判据不能再犯一次。
 *
 * 拿不到任何时刻时返回 `stale: false`（fail-open）：**看不见的年龄不等于年轻**，
 * 但也不该凭猜把一条真实等待藏起来。宁可多显示一条，不可少显示一条。
 *
 * @param {object} session
 * @param {number|null} [nowMs] 只有行上没有 idleSec 时才需要
 * @returns {{stale:boolean, ageSec:number|null, limitSec:number|null}}
 */
export function staleOf(session, nowMs = null) {
  const limitSec = ageLimitOf(session);
  const ageSec = ageSecOf(session, nowMs);
  if (limitSec === null || ageSec === null) return { stale: false, ageSec, limitSec };
  return { stale: ageSec > limitSec, ageSec, limitSec };
}

/** 行已经等了多久（秒）。取不到返回 null。**不读挂钟**，见 `staleOf`。 */
export function ageSecOf(session, nowMs = null) {
  const idle = session && session.idleSec;
  if (Number.isFinite(idle)) return Math.max(0, Number(idle));
  const at = Number(session && session.statusUpdatedAt);
  if (Number.isFinite(at) && at > 0 && Number.isFinite(nowMs)) {
    return Math.max(0, Math.round((Number(nowMs) - at) / 1000));
  }
  return null;
}

/**
 * 六态 → 二值。
 * @returns {'waiting'|'blocked'|'failed'|'running'|'stopped'}
 */
export function binaryOf(session) {
  const st = session && session.state;
  if (st === 'WAITING') return 'waiting';
  if (st === 'BLOCKED') return 'blocked';
  if (st === 'FAILED') return 'failed';
  if (st === 'PRODUCING' || st === 'EXPLORING' || st === 'STALLED') return 'running';
  return 'stopped';
}

/** 一条 row 在去重时认的全部身份。与 oversight-tui 的 rowIdentities 同源语义。 */
function identitiesOf(row) {
  const out = new Set();
  for (const k of ['sessionId', 'hostSessionId', 'transcriptId']) {
    if (row && row[k]) out.add(String(row[k]));
  }
  return out;
}

/**
 * 三段分区：需动作 / 在跑 / 已停。
 *
 * 判据（可逐条验收）：
 *   - **需动作**：宿主事实态（WAITING/BLOCKED/FAILED），或收件箱里有它，
 *     **且没有超过 `ACTION_MAX_AGE_SEC` 里那一档的老化上限**。
 *     收件箱（`buildInbox`）是「历史通知 × 当前宿主状态」的交集，比单看 state 多一层佐证。
 *   - **在跑**：出现在宿主 `live` 里（宿主说它此刻活着）**且有 transcript**。
 *     没有 transcript 的活着会话没有「最近说」可显示，放进来只是占位。
 *   - **已停**：其余。它们被收进窗口是因为 transcript 文件被动过，不代表会话在跑。
 *
 * **超龄的需动作事实不丢弃，降级进「已停」并带上 `stale: true`。**
 * 用户要求「所有都要显示」，所以既不能把它留在需动作（那是误报），也不能删掉
 * （那是漏报）。降级是唯一同时满足两者的做法，而且「已停」段本来就压成一行计数、
 * 按 `h` 展开——它正好是「历史」该待的地方。
 *
 * 重叠时归**需动作**（优先级最高）——「已停」与「需动作」不可能同时成立，
 * 但「在跑」与「需动作」会（一个 busy 的会话也可能刚报 blocked）。
 *
 * @param {{sessions?:Array, live?:Array, inbox?:Array, resolve?:Function, nowMs?:number}} p
 *   `nowMs` 只用于给「只有 `statusUpdatedAt` 没有 `idleSec`」的行算年龄；
 *   传 null 时那些行按「年龄未知、不算陈旧」处理（fail-open）。
 * @returns {{action:Array, running:Array, stopped:Array, stale:Array}}
 *   `stale` 是 `stopped` 里因超龄而降级的那些，供调用方区分措辞。
 */
export function partitionRows({ sessions = [], live = [], inbox = [], resolve = null, nowMs = null } = {}) {
  const liveIds = new Set();
  for (const l of live) for (const id of identitiesOf(l)) liveIds.add(id);
  const inboxIds = new Set();
  for (const it of inbox) {
    if (it && it.sessionId) inboxIds.add(String(it.sessionId));
    if (it && it.key) inboxIds.add(String(it.key));
  }

  const action = [];
  const running = [];
  const stopped = [];
  const aged = [];
  const seen = new Set();

  for (const row of sessions || []) {
    if (!row) continue;
    const ids = identitiesOf(row);
    const inInbox = [...ids].some((id) => inboxIds.has(id));
    const isAction = ACTION_STATES.includes(row.state) || inInbox;
    const alive = [...ids].some((id) => liveIds.has(id));
    if (isAction) {
      const age = staleOf(row, nowMs);
      if (age.stale) {
        const downgraded = { ...row, stale: true, staleAgeSec: age.ageSec, staleLimitSec: age.limitSec };
        aged.push(downgraded);
        stopped.push(downgraded);
        continue;
      }
      action.push(row);
      continue;
    }
    if (alive && row.hasTranscript !== false) { running.push(row); continue; }
    stopped.push(row);
  }

  // 收件箱里出现、但扫描行里没有的会话（例如 job 仅在 state.json 里）也要补进需动作段。
  // 没有这一条，「某个会话在等你」可能只出现在收件箱里而主屏看不见 —— 正是 D6 的形态。
  for (const it of inbox) {
    const sid = it && it.sessionId ? String(it.sessionId) : null;
    if (!sid || seen.has(sid)) continue;
    if ([...action].some((r) => identitiesOf(r).has(sid))) continue;
    // 已在 stopped 里的（含刚被判超龄降级的）不再补一次
    if ([...stopped].some((r) => identitiesOf(r).has(sid))) continue;
    if (!it?.state || !ACTION_STATES.includes(it.state)) continue;
    const row = resolve ? resolve(it) : null;
    if (!row) continue;
    const age = staleOf(row, nowMs);
    if (age.stale) {
      const downgraded = { ...row, stale: true, staleAgeSec: age.ageSec, staleLimitSec: age.limitSec };
      aged.push(downgraded);
      stopped.push(downgraded);
      seen.add(sid);
      continue;
    }
    action.push(row);
    seen.add(sid);
  }

  return {
    action: sortAction(action),
    running: sortByRecent(running),
    stopped: sortByRecent(stopped),
    stale: sortByRecent(aged),
  };
}

/** 需动作段：等得最久的排最前（那是用户最可能已经忘了的那一条）。 */
function sortAction(rows) {
  return [...rows].sort((a, b) => (b.idleSec ?? -1) - (a.idleSec ?? -1));
}

/** 在跑 / 已停：最近有动静的排前面。 */
function sortByRecent(rows) {
  return [...rows].sort((a, b) => (a.idleSec ?? Number.MAX_SAFE_INTEGER) - (b.idleSec ?? Number.MAX_SAFE_INTEGER));
}

// ── 文案 ──────────────────────────────────────────────────────────────

/** 判决行：「N 件在等你」必须在最前（规划 P2），不是「N 个会话」。 */
export function verdictParts({ actionCount = 0, runningCount = 0, stoppedCount = 0 } = {}) {
  const n = Math.max(0, actionCount | 0);
  return [
    `${n} 件在等你`,
    `${Math.max(0, runningCount | 0)} 个会话在跑`,
    `${Math.max(0, stoppedCount | 0)} 个已停`,
  ];
}

/** 「已停」段压成一行：范围 + 怎么展开。 */
export function stoppedSummary(stopped) {
  const n = Array.isArray(stopped) ? stopped.length : 0;
  if (!n) return '已停 (0)';
  const secs = stopped.map((s) => Number(s.idleSec)).filter((v) => Number.isFinite(v));
  if (!secs.length) return `已停 (${n}) · h 展开`;
  const lo = Math.min(...secs);
  const hi = Math.max(...secs);
  // 「其中 N 条是超龄降级的」必须说出来：否则用户看到「已停」里的 Hilltop
  // 会以为是普通历史会话，而它其实是「曾经在等你、但你早就不该回了」的那一类。
  const aged = Array.isArray(stopped) ? stopped.filter((s) => s && s.stale).length : 0;
  const agedBit = aged ? ` · 其中 ${aged} 条超龄` : '';
  return `已停 (${n})  ${fmtSpan(lo)}–${fmtSpan(hi)}前${agedBit} · h 展开`;
}

/** 段标题：`在跑 (9)` / `需动作 (2)`。计数永远由数据算出来，不写死。 */
export function sectionTitle(label, count) {
  return `${label} (${Math.max(0, count | 0)})`;
}

/**
 * 检查表四行（裁决 R2：四道数据源一条不砍，但**呈现**不再是一张表**）。
 *
 * 四行不是四个功能，是**四道独立数据源**：少任何一行，「没事」就少一个佐证。
 * 本函数只管**数据**（恒 4 行，`tone === 'ok'` 表示这一项没有发现）；
 * 「哪几行进屏、进屏时长什么样」由 `checklistLines()` 决定 ——
 * 没有发现的行不占屏（见 `docs/research/2026-11-11-claude-status-block-reverse.md` §3.2）。
 *
 * 每行额外带 `kind` 与 `data`，句子由 `checklistSentence()` 统一产出。
 *
 * @param {object} p
 * @param {number} p.inboxCount   等你回应（宿主事实 × 收件箱）
 * @param {number} p.askedCount   问了没答（transcript 末条是问句且之后没人说话）
 * @param {object} p.claims       {hard, soft, pending, error} —— verify-claims 档位计数
 * @param {object} p.health       healthCheck 的返回值，或 null（读不到状态文件）
 * @param {boolean} p.wide        是否在句子里带上「凭什么这么判」的细节
 * @returns {Array<{kind:string, data:object, label:string, source:string, verdict:string, note:string, tone:string}>}
 */
export function checklistRows({ inboxCount = 0, askedCount = 0, claims = null, health = null, wide = true } = {}) {
  const inbox = Math.max(0, inboxCount | 0);
  const asked = Math.max(0, askedCount | 0);
  const rows = [];
  rows.push({
    kind: 'inbox',
    data: { n: inbox },
    label: '等你回应',
    source: 'WAITING/BLOCKED/FAILED',
    verdict: `${inbox} 个`,
    note: '',
    tone: inbox > 0 ? 'warn' : 'ok',
  });
  rows.push({
    kind: 'asked',
    data: { n: asked },
    label: '问了没答',
    source: 'transcript 末条是问句',
    verdict: `${asked} 个`,
    note: '',
    tone: asked > 0 ? 'warn' : 'ok',
  });

  // 声明对不上：**计数必须真的由数据算出来**。三种非绿状态各不相同：
  //   pending —— 证据还在算（verify-claims 7.2s，不能进 8 秒轮询）
  //   error   —— 算失败了，不能显示 0
  //   hard    —— FAILED_ONLY / NO_EVIDENCE（硬矛盾）
  //   soft    —— STALE_ONLY / UNKNOWN（存疑，必须说出来但不与硬的混为一谈）
  const c = claims || {};
  let verdict = '—';
  let note = '';
  let tone = 'muted';
  let claimData;
  if (c.pending) { verdict = '…'; note = '正在算证据'; tone = 'muted'; claimData = { pending: true }; }
  else if (c.error) { verdict = '?'; note = '算证据失败'; tone = 'bad'; claimData = { error: true }; }
  else if (typeof c.hard === 'number') {
    verdict = `${c.hard} 条`;
    tone = c.hard > 0 ? 'bad' : (c.soft > 0 ? 'muted' : 'ok');
    const bits = [];
    if (c.soft > 0) bits.push(`${c.soft} 存疑`);
    bits.push('d 看证据');
    note = bits.join(' · ');
    claimData = { hard: c.hard, soft: Math.max(0, c.soft | 0) };
  } else {
    claimData = { unknown: true };
  }
  rows.push({
    kind: 'claims',
    data: claimData,
    label: '声明对不上',
    source: '完成声明无证据支持',
    verdict,
    note,
    tone,
  });

  // 后台监视：**「空」能不能信，取决于这一行**（规划 §2.6 第三要素）。
  let hVerdict = '?';
  let hSource = '读不到 state.json';
  let hNote = '先装监视';
  let hTone = 'bad';
  let healthData = { unknown: true };
  if (health) {
    const parts = (health.layers || []).map((l) => {
      const age = l.ageMs == null ? '从未' : fmtSpan(l.ageMs / 1000);
      return `${l.name} ${age}`;
    });
    if (health.healthy) {
      hVerdict = '✓';
      hSource = `${parts.join(' / ')} 前运行`;
      hNote = '';
      hTone = 'ok';
      healthData = { healthy: true, parts };
    } else {
      hVerdict = '✗';
      hSource = `${parts.join(' / ')} 未运行`;
      hNote = '先修这个';
      hTone = 'bad';
      // 未运行那几层单独留一份：句子要写「jobs 1.1d 未更新」，不是「jobs 1.1d」。
      const stale = (health.layers || [])
        .filter((l) => l && l.ageMs != null && Number.isFinite(Number(l.ageMs)))
        .map((l) => `${l.name} ${fmtSpan(l.ageMs / 1000)}`);
      healthData = { healthy: false, parts, stale };
    }
  }
  rows.push({
    kind: 'health', data: healthData, label: '后台监视', source: hSource, verdict: hVerdict, note: hNote, tone: hTone,
  });

  return rows.map((r) => (wide ? r : { ...r, source: '' }));
}

/** 某个检查项的 `healthData` 里，「未更新多久」那一段。没有层信息时给 null。 */
function staleBitOf(data) {
  const bits = Array.isArray(data && data.stale) ? data.stale : [];
  return bits.length ? bits.join(' / ') : null;
}

/**
 * 一项检查的**一句断言**（Claude Code 的双版本 label 写法，逆向 §1.2）。
 *
 * 无发现时说一句短的自然语言，**不写 `→ 0 个`**——`No installation issues found.`
 * 的等价物是 `没有会话问了没答`，不是表里的一格。
 *
 * 返回值刻意不含颜色：调用方决定怎么染（`tone` 在行上）。
 *
 * @param {object} row checklistRows 的一行
 * @param {{wide?: boolean}} [o]
 * @returns {string}
 */
export function checklistSentence(row, { wide = true } = {}) {
  const d = (row && row.data) || {};
  switch (row && row.kind) {
    case 'inbox':
      return d.n > 0
        ? `${d.n} 件在等你${wide ? '（WAITING/BLOCKED/FAILED）' : ''}`
        : '没有会话在等你';
    case 'asked':
      return d.n > 0
        ? `${d.n} 个会话问了没答${wide ? '（transcript 末条是问句，之后没人回）' : ''}`
        : '没有会话问了没答';
    case 'claims': {
      if (d.pending) return '完成声明正在对证据…';
      if (d.error) return '算证据失败，按 d 重试';
      if (d.unknown) return '还没对过证据，按 d 看';
      // 0 条的项**不说「0 条」**：`→ 0 条` 是表格的一格，读者要先读懂表头才能解码。
      if (!d.hard && !d.soft) return '没有完成声明对不上';
      const bits = [];
      if (d.hard > 0) bits.push(`${d.hard} 条完成声明无证据支持`);
      if (d.soft > 0) bits.push(`${d.soft} 条存疑`);
      bits.push('d 看证据');
      return bits.join(' · ');
    }
    case 'health': {
      if (d.unknown) return '后台监视状态读不到（state.json）· 先装监视';
      if (d.healthy) {
        const parts = Array.isArray(d.parts) ? d.parts : [];
        return parts.length ? `监视在跑（${parts.join(' / ')} 前）` : '监视在跑';
      }
      const stale = staleBitOf(d);
      return `${stale ? `监视未在跑（${stale} 未更新）` : '监视未在跑'} · 先修这个`;
    }
    default:
      // 未知 kind：宁可原样说出结论，也不静默吞掉一行。
      return String((row && row.verdict) || '').trim();
  }
}

/** 这一项是否**没有发现**（可以不上屏）。`tone === 'ok'` 是「查了，没发现」。 */
export function isQuietRow(row) {
  return Boolean(row) && row.tone === 'ok';
}

/**
 * 检查区的收尾行：**没有发现时的一句话**，不逐项列举。
 *
 * 这是 `claude doctor` 的 `No installation issues found.` 的直接移植
 * （逆向报告 §3.4：无发现 = 一句短的自然语言，不是一行全绿的表）。
 *
 * 两种形态：
 *   - 全部没有发现 → `✓ 4 项检查都清白 · 监视在跑`（判决）
 *   - 有异常、但也有查过没事的项 → `✓ 其余 2 项没有发现`（自证；异常行在上面）
 *
 * **为什么不并进 L0**：L0 已经是一句判决（`N 件在等你 · …`），把「4 项检查都清白」
 * 接在后面会把两种不同的事实（会话计数 / 证据覆盖）塞进同一句，且窄档下必然被
 * `joinWithin` 从尾部丢掉——那是**静默丢掉自证**。放在检查区里，它在任何宽度下都在，
 * 且只在「有话说」时出现：正常态是「一句判决 + 一句自证」，异常态是「一句判决 +
 * 几行具体问题 + 一句其余清白」，任何一态都不会有两句判决。
 *
 * @param {number} count 检查项数（收尾行说的是这一批里有几项）
 * @param {{cols?:number, useColor?:boolean, extra?:Array<string>, rest?:boolean}} [o]
 *        `extra` 是调用方要补进这句话的事实（`--plain` 补「数据 8s前」）；
 *        `rest` 为 true 时说的话是「其余 N 项没有发现」，否则是「N 项检查都清白」
 * @returns {string}
 */
export function checklistSummaryLine(count, { cols = 80, useColor = true, extra = [], rest = false } = {}) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const bits = [rest ? `✓ 其余 ${n} 项没有发现` : `✓ ${n} 项检查都清白`];
  for (const e of Array.isArray(extra) ? extra : []) {
    const s = String(e ?? '').trim();
    if (s) bits.push(s);
  }
  const line = ` ${truncateDisplay(bits.join(' · '), Math.max(1, cols - 1))}`;
  return useColor ? paint(line, 'green', true) : line;
}

/**
 * 检查区要上屏的行：**没有发现的不占行**（逆向 §1.2 `if(i===""||i==="none")continue`）。
 *
 * 返回 `{lines, hidden, quiet}`：
 *   - `lines`  已渲染的字符串行（含颜色）；
 *   - `hidden` 被压掉的**无发现**项数——它是「压掉」与「没查」的区分依据；
 *   - `quiet`  是否所有项都没有发现，即本函数给出的是一句收尾判决而非逐项行。
 *
 * 三种情形，一个都不能变成「空白」：
 *   1. **全部没有发现** → 一句 `✓ 4 项检查都清白 · 监视在跑`（`claude doctor` 的
 *      `No installation issues found.` 的等价物）。空白会让「全清白」与「没查」同形。
 *   2. **有异常** → 只画有事的那几行；若同时还有没发现的项，末尾补一句
 *      `✓ 其余 2 项没有发现`——把「压掉」变成「数过」，不是删掉。
 *   3. **异常项已由别的通道说过**（`skipKinds`）→ 不重复。此时 `quiet` 仍是 false：
 *      这一批**有**问题，只是不在这块里说。搞反了就会把「监视未跑」说成「都清白」，
 *      那是本仓库最不能犯的错。
 *
 * @param {Array} rows checklistRows 的输出
 * @param {{cols:number, layout?:object, useColor?:boolean, skipKinds?:string[], extra?:Array<string>}} o
 *        `skipKinds` 是「已经在别处说过了」的项。默认跳过 `inbox`：它的数字就是 L0
 *        的第一位，下面还有整段需动作原文——再画一行是同一件事的第三遍。
 *        调用方有告警行时还应跳过 `health`（告警已给出原因与修复命令）。
 *        `extra` 追加到收尾句（`--plain` 用它补「数据 8s前」）。
 * @returns {{lines: string[], hidden: number, quiet: boolean}}
 */
export function checklistLines(rows, { cols, layout = null, useColor = true, skipKinds = ['inbox'], extra = [] } = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const skip = new Set(Array.isArray(skipKinds) ? skipKinds : []);
  const wide = !layout || layout.showCheckSource !== false;
  const problems = list.filter((r) => !isQuietRow(r));
  const quietRows = list.filter((r) => isQuietRow(r));

  if (!problems.length) {
    const health = list.find((r) => r.kind === 'health');
    const alive = health && health.data && health.data.healthy ? '监视在跑' : '';
    const suffix = alive ? [alive, ...(Array.isArray(extra) ? extra : [])] : extra;
    return { lines: [checklistSummaryLine(list.length, { cols, useColor, extra: suffix })], hidden: list.length, quiet: true };
  }

  const lines = problems
    .filter((r) => !skip.has(r.kind))
    .map((r) => checklistLine(r, { cols, layout, useColor, wide }));
  // 压掉的零值项要能被数出来：`✓ 其余 2 项没有发现` 比沉默诚实。
  const rest = quietRows.filter((r) => !skip.has(r.kind));
  if (rest.length) lines.push(checklistSummaryLine(rest.length, { cols, useColor, extra, rest: true }));
  return { lines, hidden: rest.length, quiet: false };
}

/**
 * 状态行（最后一行）：**健康度，不是键位提示**（规划 §2.4 第 3 条）。
 * 键位在 `?` 里。
 */
export function footerParts({ hard = 0, soft = 0, scanAgeMs = null, health = null, refreshing = false } = {}) {
  const parts = [];
  if (hard > 0) parts.push(`${hard} 条声明对不上`);
  else if (soft > 0) parts.push(`${soft} 条声明存疑`);
  parts.push(scanAgeMs == null ? '尚未扫描' : `数据来自${fmtAgeMs(scanAgeMs)}的扫描`);
  if (refreshing) parts.push('刷新中…');
  if (health === null) parts.push('监视状态未知');
  else if (!health.healthy) parts.push('监视未在跑');
  return parts;
}

/** 需动作行的动作列：**没有可复制的草稿就不给 `c`**（规划 P6：不提供假按钮）。
 *
 *  2026-11-11：判据从「有没有 suggestedReply」收紧成「按 c 到底会不会得到东西」。
 *  超龄的事实按 `c` 现在什么都不给（见 `oversight-tui.buildDraft`），
 *  所以这里也不能再画 `c 复制回复` —— 那是按了没反应的假按钮。
 *  传了 `nowMs` 就顺带算一次老化；不传只按「有没有 suggestedReply」判。 */
export function actionCell(view, { nowMs = null } = {}) {
  if (!view) return '';
  if (!view.suggestedReply) return 'Enter 看原文';
  if (staleOf(view, nowMs).stale) return 'Enter 看原文';
  return 'c 复制回复';
}

/** 在跑行的「近」列文案。**必须能看出它来自哪**——它是 transcript 末条文本，不是状态判定。 */
export function nearText(meta) {
  const text = meta && typeof meta.lastAssistant === 'string' ? meta.lastAssistant.trim() : '';
  if (!text) return '';
  return text.replace(/\s+/g, ' ');
}

// ── 会话行 ────────────────────────────────────────────────────────────
//
// 三个段的行结构不同，这是有意的：
//   L2 需动作 —— **两行**：身份 + 等了多久 + 怎么回（上），它在等什么（逐字，下）。
//                 逐字是 relay-protocol.md §5.1 的硬要求，界面不得代为概括。
//   L3 在跑   —— 一行：标题 / 路径 / 最后动静 / 近。
//   L4 已停   —— 默认不画；展开时同 L3 的单行形态，但不出「近」列（历史会话没有意义）。

/** 光标列恒定 2 列，空着也占位（否则选中与否会让整屏标题左右抖 1 格）。 */
const MARK_W = 2;

/**
 * 会话标题。**有真标题就用真标题**；没有时回退到路径尾段，并标记 `fallback`
 * 让调用方决定要不要画得暗一点（「这条会话的名字有多可信」应当是可见的）。
 */
export function titleOf(view) {
  const t = view && typeof view.title === 'string' ? view.title.trim() : '';
  if (t) return { text: t, fallback: false };
  const p = view && typeof view.path === 'string' ? view.path.trim() : '';
  if (p) return { text: p.split(/[\\/]/).filter(Boolean).pop() || p, fallback: true };
  const id = view && view.key ? String(view.key) : '';
  return { text: id ? id.slice(0, 8) : '(无标识)', fallback: true };
}

/** 路径副行：只保留末两段，**带 `…/` 前缀**说明前面被省了。
 *  中截断而不是尾截断：尾部（项目名）才是有辨识度的部分（Claude TUI 逆向 §3.4）。 */
export function shortPath(full) {
  const parts = String(full ?? '').split(/[\\/]/).filter(Boolean);
  if (!parts.length) return '';
  // 盘符（`C:`）不是有辨识度的一段：`C:\C盘清理路径` 只该显示末段，
  // 写成 `…/C:/C盘清理路径` 会让人以为多了一层目录。
  const real = parts.filter((p) => !/^[A-Za-z]:$/.test(p));
  if (!real.length) return parts[parts.length - 1];
  if (real.length === 1) return real[0];
  return `…/${real[real.length - 2]}/${real[real.length - 1]}`;
}

/**
 * 在跑行的列宽。**导出是为了让测试能断言「76 列下 title 拿 27 列」这类事实**，
 * 而不是把数字散在渲染里。
 */
export function runningColumns(cols, layout) {
  const c = Math.max(1, Math.floor(Number(cols) || 1));
  const showNear = !layout || layout.showNear !== false;
  const near = showNear ? Math.min(26, Math.max(12, Math.floor(c * 0.3))) : 0;
  const idle = 6;
  const path = c >= TIERS.narrow ? 18 : 0;
  const fixed = MARK_W + (path ? path + 1 : 0) + idle + (near ? 1 + near : 0);
  const title = Math.max(8, c - fixed);
  return { mark: MARK_W, title, path, idle, near };
}

/** L3/L4 的单行会话行。返回**已含颜色**的字符串（宽度由 displayWidth 量，SGR 计 0）。 */
export function runningRowOf(view, { cols, layout, selected, useColor, showNear = true, showPath = true } = {}) {
  const c = Math.max(1, Math.floor(Number(cols) || 1));
  const wantPath = showPath && (!layout || layout.showPath !== false) && c >= TIERS.narrow;
  const wantNear = showNear && (!layout || layout.showNear !== false);
  // 列宽由 runningColumns 单点决定：两处各算一遍必然对不齐（旧实现就是这么歪的）
  const w = runningColumns(c, { showNear: wantNear });
  const pathW = wantPath ? w.path : 0;
  const nearW = wantNear ? w.near : 0;

  const marker = selected ? mark('❯', 'green', useColor) : ' '.repeat(w.mark);
  const t = titleOf(view);
  // 列宽的唯一算法：**标题吃剩下的全部**。先算出所有固定列的合计，
  // 再让标题吸收差额 —— 反过来（先定标题宽再凑固定列）必然差 1~2 列。
  const gapBeforeIdle = 1;
  const trail = (pathW ? pathW + 1 : 0) + gapBeforeIdle + w.idle + (nearW ? 1 + nearW : 0);
  const titleW = Math.max(8, c - w.mark - trail);
  const title = truncateWithDisclosure(t.text, titleW).text;
  const titleText = t.fallback && useColor ? paint(title, 'gray', true) : title;
  const cells = [
    { text: marker, width: w.mark },
    { text: padDisplay(titleText, titleW), width: titleW },
  ];
  if (pathW) cells.push({ text: ' ' + padDisplay(shortPath(view && view.path), pathW), width: pathW + 1 });
  cells.push({ text: ' '.repeat(gapBeforeIdle), width: gapBeforeIdle });
  cells.push({ text: fmtSpan(view && view.idleSec), width: w.idle, align: 'right' });
  if (nearW) {
    const near = truncateDisplay(nearText(view && view.meta) || '—', nearW);
    cells.push({ text: ' ' + padDisplay(near, nearW), width: 1 + nearW });
  }
  const line = layoutRow(cells, c);
  // 状态只在**有语义**时上色：需动作上色、在跑是绿色、已停不上色。
  const kind = (view && view.kind) || 'running';
  if (useColor && selected) return paint(stripAnsiOf(line), 'green', true);
  if (useColor && kind !== 'stopped' && kind !== 'running') {
    const color = binaryColor(kind);
    if (color) return paint(stripAnsiOf(line), color, true);
  }
  return line;
}

/** L2 需动作行：两行。第一行身份 + 等了多久 + 怎么回，第二行逐字 needs。 */
export function actionRowOf(view, { cols, layout, selected, useColor, nowMs = null } = {}) {
  const lines = [];
  const waitW = layout && layout.showIdle === false ? 0 : 8;
  const act = actionCell(view, { nowMs });
  const actW = act ? Math.min(14, displayWidth(act)) : 0;
  const marker = selected ? mark('❯', 'brightYellow', useColor) : ' '.repeat(MARK_W);
  const titleBudget = Math.max(8, cols - MARK_W - (waitW ? waitW + 1 : 0) - (actW ? actW + 1 : 0));
  const t = titleOf(view);
  const titleLine = truncateWithDisclosure(t.text, titleBudget);
  const cells = [{ text: marker, width: MARK_W }, { text: padDisplay(titleLine.text, titleBudget), width: titleBudget }];
  if (waitW) cells.push({ text: fmtSpan(view && view.idleSec), width: waitW, align: 'right' });
  if (actW) cells.push({ text: ' ' + act, width: 1 + actW });
  let head = layoutRow(cells, cols);
  if (useColor) head = paint(stripAnsiOf(head), selected ? 'brightYellow' : binaryColor(view && view.kind) || 'yellow', true);
  lines.push(head);

  const needs = String((view && view.needs) || '').replace(/\s+/g, ' ').trim();
  if (layout && layout.actionTwoLine !== false && needs) {
    const indent = MARK_W + 1;
    const body = truncateWithDisclosure(needs, Math.max(8, cols - indent));
    lines.push(' '.repeat(indent) + (useColor ? paint(body.text, 'gray', true) : body.text));
  }
  return lines;
}

/** 段标题行：` 在跑 (9)` 左，列名右。 */
export function sectionHeaderLine(label, count, cols, rightText, useColor = true) {
  const left = ` ${sectionTitle(label, count)}`;
  const right = rightText ? truncateDisplay(rightText, Math.max(0, cols - displayWidth(left) - 2)) : '';
  const pad = Math.max(1, cols - displayWidth(left) - displayWidth(right));
  const line = left + ' '.repeat(pad) + right;
  return useColor ? paint(stripAnsiOf(line), 'bold', true) : line;
}

/**
 * 检查项一行：**标签 + 一句断言**，没有表头，没有右对齐的「结论」列。
 *
 * 为什么不再是四列（标签 / 来源 / 结论 / 备注）：四列结构本身就是一张表，
 * 而表必须配表头，于是「表头突兀 → 加说明 → 更突兀」成了死循环。
 * Claude Code 的 `/status` 只有 2 列、`claude doctor` 只有 1 列
 * （`docs/research/2026-11-11-claude-status-block-reverse.md` §3.2）。
 *
 * 失败项**必须带一条出路**（`先修这个` / `d 看证据`）：它是 `claude doctor` 的
 * `- <issue>` + `  Fix: <fix>` 的等价物，不能只报数字。
 *
 * 严重度同时用**字形 + 颜色**两个通道（`tui-visual.md` §1：颜色是装饰，不是信息载体）：
 * `✗` 硬失败 / `·` 需要注意 / `…` 还在算或不知道。
 *
 * @param {object} row checklistRows 的一行
 * @param {{cols:number, layout?:object, useColor?:boolean, wide?:boolean}} o
 */
export function checklistLine(row, { cols, layout, useColor = true, wide } = {}) {
  const c = Math.max(1, Math.floor(Number(cols) || 1));
  const headWide = wide === undefined ? (!layout || layout.showCheckSource !== false) : wide;
  // 字形恒定 1 列：有没有颜色都分得开（灰度终端、管道、日志）
  const mark = row.tone === 'bad' ? '✗' : row.tone === 'ok' ? '✓' : row.tone === 'warn' ? '·' : '…';
  const labelW = c >= 44 ? 12 : 10;
  const head = ` ${padDisplay(row.label, labelW)} ${mark} `;
  const budget = c - displayWidth(head);
  const paintTone = (line) => {
    if (!useColor) return line;
    const tone = row.tone === 'bad' ? 'red' : row.tone === 'warn' ? 'yellow' : row.tone === 'ok' ? 'green' : null;
    return tone ? paint(stripAnsiOf(line), tone, true) : line;
  };
  // 太窄时**只留标签与字形**：60 列以下写不下「断言 + 溢出披露」两样，
  // 硬塞会让一行变成 `… (+53…`——既不告诉读者发生了什么，也不告诉他丢了多少。
  // 细节在 `d` 里，这里保留「哪一项有事、有多严重」就够。
  if (budget < 14) return paintTone(truncateDisplay(` ${row.label} ${mark}`, c).replace(/\s+$/, ''));
  // 括注（「凭什么这么判」）在窄档先撤，与 STAGES 的 showCheckSource 同一条纪律。
  const body = truncateWithDisclosure(checklistSentence(row, { wide: headWide && c >= 60 }), budget);
  let line = head + body.text;
  if (displayWidth(line) > c) line = truncateDisplay(line, c);
  return paintTone(line);
}

/** 判决行（L0）：**第一行永远是判决，不是计数**。右对齐扫描新鲜度。 */
export function verdictLine(parts, cols, scanAgeText, useColor = true) {
  const right = scanAgeText ? truncateDisplay(scanAgeText, Math.max(0, cols - 4)) : '';
  const leftBudget = Math.max(10, cols - (right ? displayWidth(right) + 2 : 0));
  const left = joinWithin(parts, leftBudget);
  const pad = Math.max(1, cols - displayWidth(left) - displayWidth(right));
  const line = left + ' '.repeat(pad) + right;
  return useColor ? paint(stripAnsiOf(line), 'bold', true) : line;
}

/** 状态行（最后一行）：健康度。**不放键位提示** —— 键位在 `?` 里。 */
export function footerLine(parts, cols, useColor = true) {
  return useColor ? paint(stripAnsiOf(joinWithin(parts, cols)), 'dim', true) : joinWithin(parts, cols);
}

// ── 整屏组装 ──────────────────────────────────────────────────────────

/**
 * 组装列表页的整屏。
 *
 * **这是本次重构的主要收益**：整屏每一行都由它产出，于是「76 列下没有一行超宽」
 * 「判决行永远是第 1 行」「空段不画」「需动作段永不撤」全都能被断言。
 *
 * @param {object} p
 * @param {number} p.cols
 * @param {number} p.rows
 * @param {Array<string>} p.verdict        判决行片段（来自 verdictParts）
 * @param {string} p.scanAge               右对齐的扫描新鲜度
 * @param {Array} p.checklist              来自 checklistRows
 * @param {Array} p.action                 需动作行（view 形态）
 * @param {Array} p.running                在跑行
 * @param {Array} p.stopped                已停行（仅在展开时进屏）
 * @param {boolean} p.stoppedExpanded
 * @param {Array<string>} p.footer
 * @param {string|null} p.cursorKey        光标所在行的 key
 * @param {boolean} p.useColor
 * @param {number|null} [p.nowMs]          老化判断用的注入时钟（只影响动作列画不画 `c`）
 * @param {object} p.layout                resolveLayout 的结果（不传则按 cols/rows 现算）
 * @param {Array<string>|null} p.body      替代三段会话区的正文（首扫/空/失败四种态）
 * @param {Array<string>|null} p.alert     判决行之后的告警行（监视没在跑时要进第一屏）
 * @returns {string[]} 恰好 rows 行，每行显示宽度 ≤ cols
 */
export function composeListScreen(p) {
  const cols = Math.max(1, Math.floor(Number(p.cols) || 80));
  const rows = Math.max(1, Math.floor(Number(p.rows) || 24));
  const layout = p.layout || resolveLayout({ cols, rows });
  const useColor = p.useColor === true;
  const out = [];
  const push = (line) => { if (out.length < rows - 1) out.push(line); };

  // L0 判决行 —— **永远是第 1 行**
  out.push(verdictLine(p.verdict || [], cols, p.scanAge || '', useColor));

  // 告警（监视没在跑）：紧贴判决行之后。它改变「0 件在等你」的可信度，
  // 所以优先级高于检查表，但**不替换**任何一段内容。
  if (Array.isArray(p.alert) && p.alert.length) {
    for (const l of p.alert) push(l);
    if (layout.showBlank) push('');
  } else if (layout.showBlank) {
    out.push('');
  }

  // L1 检查表 —— 「有没有事」凭什么成立。**没有发现的行不占屏**（逆向 §3.2）：
  // 四行里三行都是 `0 个` 时，那张表读起来像「一张没填完的表」，而不是「一份声明」。
  // 这里只把**有事的那几行**画成「标签 + 一句断言」；全绿时只剩一句
  // `✓ 4 项检查都清白`——**绝不能变成空白**（那时「没查」与「全清白」同形）。
  //
  // 已经由别的通道说过的项不再重复：
  //   - inbox：L0 第一位就是「N 件在等你」，下面还有整段需动作原文；
  //   - health：有告警行时，那条告警已经给了原因与修复命令。
  if (layout.showChecklist !== false && Array.isArray(p.checklist) && p.checklist.length) {
    const skipKinds = ['inbox'];
    if (Array.isArray(p.alert) && p.alert.length) skipKinds.push('health');
    const shown = checklistLines(p.checklist, { cols, layout, useColor, skipKinds }).lines;
    if (shown.length) {
      for (const l of shown) push(l);
      if (layout.showBlank) out.push('');
    }
  }

  const cursorKey = p.cursorKey ?? null;

  // 正文区：四种空/等待态优先于三段列表
  if (Array.isArray(p.body) && p.body.length) {
    for (const l of p.body) push(l);
  } else {
    // L2 需动作 —— 空则不画（画一个 0 行标题就是噪声）
    if (Array.isArray(p.action) && p.action.length) {
      const right = layout.showIdle === false ? '怎么回' : '等了      怎么回';
      push(sectionHeaderLine('需动作', p.action.length, cols, right, useColor));
      for (const v of p.action) {
        for (const l of actionRowOf(v, { cols, layout, selected: v.key === cursorKey, useColor, nowMs: p.nowMs ?? null })) push(l);
      }
      if (layout.showBlank) push('');
    }

    // L3 在跑
    if (Array.isArray(p.running) && p.running.length) {
      const right = layout.showNear === false ? '最后动静' : '最后动静     近';
      push(sectionHeaderLine('在跑', p.running.length, cols, right, useColor));
      for (const v of p.running) {
        push(runningRowOf(v, { cols, layout, selected: v.key === cursorKey, useColor }));
      }
    }

    // L4 已停 —— 折叠成一行；按 h 展开成列表
    if (Array.isArray(p.stopped) && p.stopped.length && layout.showStopped !== false) {
      if (p.stoppedExpanded) {
        push(sectionHeaderLine('已停', p.stopped.length, cols, '最后动静', useColor));
        for (const v of p.stopped) {
          // 超龄降级来的条目标上「超龄」。没有这个后缀，它展开后与普通历史会话
          // 长得一模一样，而这两类的含义完全不同（一个是「曾等你，别回了」，
          // 一个是「从没等过你」）。
          const shown = v && v.stale ? { ...v, title: `${v.title} · 超龄` } : v;
          push(runningRowOf({ ...shown, kind: 'stopped' }, { cols, layout, selected: v.key === cursorKey, useColor, showNear: false }));
        }
      } else {
        push(' ' + truncateDisplay(stoppedSummary(p.stopped) + ' · 大部分是历史', cols - 1));
      }
    }
  }

  // 尾部：空白槽 + 状态行。**永久占位**：通知到达时版面不移动。
  // 状态行必须是**最后一行**（rows-1）：它承载健康度，滚出屏幕等于没写。
  while (out.length < rows - 1) out.push('');
  out.push(footerLine(p.footer || [], cols, useColor));

  // 严格裁剪/补齐到 rows 行
  const fixed = out.slice(0, rows);
  while (fixed.length < rows) fixed.push('');
  return fixed.map((l) => (displayWidth(l) > cols ? truncateDisplay(l, cols) : l));
}

// ── 内部小工具 ────────────────────────────────────────────────────────

/** 着色辅助。所有正文都经 paint() 走，绝不直接拼 SGR（否则 NO_COLOR 会漏）。 */
function mark(glyph, color, useColor) {
  return useColor ? paint(glyph, color, true) : glyph;
}

/** 着色前先剥掉已有 SGR：否则「整行上色」会与行内的单元格颜色嵌套，
 *  某些终端上前景色会互相覆盖，也会让 displayWidth 之外的对齐变得不可预期。 */
function stripAnsiOf(s) {
  return stripAnsi(s);
}
