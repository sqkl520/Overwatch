#!/usr/bin/env node
/**
 * tui-theme.mjs — Overwatch TUI 的四态视觉语言。
 *
 * 设计约束（见 docs/spec/tui-visual.md）：
 *   1. 三通道：字形 + 颜色 + 文字标签。任何一条通道失效，另外两条仍能区分状态。
 *   2. 零依赖，只用 node: 内置。纯函数，无 I/O、无全局状态。
 *   3. 颜色是「装饰」，不是「信息」。关闭颜色后信息量不减少。
 *
 * 这里只做渲染，不判定状态。状态只来自 scan-sessions.mjs --json（ADR-0001）。
 *
 * 用法：
 *   import { STATES, badge, paint, displayWidth, padDisplay, colorEnabled } from './tui-theme.mjs';
 *   const on = colorEnabled(process.stdout);
 *   console.log(padDisplay(badge('FAILED', on), 12) + ' ' + row.project);
 */

const RESET = '\x1b[0m';

/**
 * 命名颜色 → SGR 前景码。
 *
 * **这张表漏一项，界面上就有一段没有颜色，而且没有任何报错。**
 * 2026-11-05 实测：`badge('WAITING', true)` 返回 0 个 ESC 字节——因为这里没有
 * `brightYellow`，`paint()` 拿到 undefined 就静默原样返回。而 WAITING 恰恰是
 * 「此刻正在等你」的状态，是最该亮的那一个。
 *
 * 所以同时做了两件事：补齐 8 色 + 8 亮色 + 灰/暗，并让 `paint()` 遇到未定义的
 * 名字**报警而不是沉默**（见 reportUnknownColor）。一个静默降级的着色器，
 * 会让「表漏项」这类缺陷永远只是「界面好像有点不对」。
 */
const SGR = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,          // brightBlack；保留旧名，已有调用点用 gray
  brightBlack: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96,
  brightWhite: 97,
  dim: 2,            // SGR 2，不是颜色而是亮度属性；paint 只负责套码
  bold: 1,
};

/** 供测试与调用方确认「某个色名有没有定义」。未定义即 SGR 表漏项。 */
export function hasColor(colorName) {
  return Object.hasOwn(SGR, colorName);
}

/**
 * 每个状态的三通道表示。
 *
 * 注意：判定链（state-model.md §2）里，WAITING 与 BLOCKED 都是宿主事实而非推断，
 * 优先级最高也最需要人处理，所以排在前面。两者的区别：
 *   WAITING —— 会话活着，此刻正在等你（可要求子 agent、开对话框、等审批）
 *   BLOCKED —— 宿主报告会话受阻，需要人回复或明确放弃
 */
export const STATES = {
  WAITING: {
    glyph: '!',
    color: 'brightYellow',
    label: 'WAITING',
    meaning: '宿主报告会话此刻正在等用户（waitingFor: input needed / dialog open / worker request / sandbox request / goal proposal）。这是实时信号，用户一回应就消失。',
  },
  BLOCKED: {
    glyph: '?',
    color: 'yellow',
    label: 'BLOCKED',
    meaning: '宿主报告会话正等待输入（needs / suggestedReply）。这是宿主事实，不是判定结论；需要人回复或明确放弃。',
  },
  FAILED: {
    glyph: '×',
    color: 'red',
    label: 'FAILED',
    meaning: '**仅**宿主 jobs 里 state === "failed"。心跳推断已于 2026-10-31 删除，不从间隔推、不从预算推。唯一允许全量重跑的状态。',
  },
  STALLED: {
    glyph: '▲',
    color: 'magenta',
    label: 'STALLED',
    meaning: '连续 3 窗 novelty < 0.2，且最近一窗无持久化变更。judgeState 不接收派生树，增益靠合并时间线体现。走 L2 探针 → L3 收窄 → L4 重新拆解。',
  },
  PRODUCING: {
    glyph: '●',
    color: 'green',
    label: 'PRODUCING',
    meaning: '窗口内存在持久化变更（成功的 Write/Edit，或命中写入类动词表的 Bash）。不干预，等验收。',
  },
  EXPLORING: {
    glyph: '○',
    color: 'cyan',
    label: 'EXPLORING',
    meaning: '只读探索、novelty 达标、冷启动样本不足或已休眠。不干预，且严禁重跑。',
  },
};

/**
 * 列表页的二值状态表 —— **与六态表是两套东西，不要合并。**
 *
 * 六态（上面的 `STATES`）回答「scan 判成了什么」，列表页回答「要不要我管」。
 * 规划 §2.5 的规则是「L0/L2 出现的字段必须能改变动作」，而 PRODUCING 与 EXPLORING
 * 的处置都是「不干预」（`docs/spec/tui-visual.md` §2 处置列自己写的）——把它们
 * 并排展示，用户读到的是「29 条都要关注」，而实际上 0 条要关注。
 *
 * **彩色下四类共用一个字形 `•`，靠颜色区分；无色下换成互不相同的字形。**
 * 这是从 Claude Code CLI 逆向里抄来的单一设计（`docs/research/2026-11-05-claude-tui-reverse.md` §4.2）：
 * 颜色被剥夺时，状态信息不能跟着消失，必须换一个维度重新编码。
 * `•`（U+2022）、`!`、`◦`（U+25E6）、`×` 全部是 EAW=A/N，实测显示宽度 1 列，
 * 且在 conhost 的等宽字体里有覆盖（`docs/spec/tui-visual.md` §3.1 的三处终端实测）。
 *
 * 为什么 waiting 与 blocked 用不同颜色：语义不同。
 *   waiting —— 会话活着、正在等你（brightYellow，最该亮）
 *   blocked —— 被挡住（blue，**不是 red**）。「被挡住」不是「坏了」，
 *              给它红色会让用户以为它崩了，而它其实只是在等人授权。
 */
export const BINARY = {
  running: { glyphPlain: '•', glyphColor: '•', color: 'green', label: '在跑' },
  waiting: { glyphPlain: '!', glyphColor: '•', color: 'brightYellow', label: '等你回应' },
  blocked: { glyphPlain: '?', glyphColor: '•', color: 'blue', label: '受阻' },
  failed: { glyphPlain: '×', glyphColor: '•', color: 'red', label: '失败' },
  stopped: { glyphPlain: '◦', glyphColor: '•', color: 'gray', label: '已停' },
};

/**
 * 二值状态的显示字形。
 *
 * @param {keyof typeof BINARY} kind
 * @param {boolean} [useColor=true] 有颜色时统一 `•`（颜色承载语义）；无色时按形状分化
 * @returns {string}
 */
export function binaryMark(kind, useColor = true) {
  const meta = BINARY[kind];
  if (!meta) return '?';
  return useColor ? meta.glyphColor : meta.glyphPlain;
}

/** 二值状态的色名。未定义时返回 null（调用方不该着色），不是静默返回 undefined。 */
export function binaryColor(kind) {
  const meta = BINARY[kind];
  return meta ? meta.color : null;
}

/**
 * 记录到的未定义色名。`paint()` 不抛异常（一个字符打不上色不该让整个 TUI 崩掉），
 * 但每一次都会进这个集合，并由 `unknownColors()` 暴露出来供测试与自检断言。
 * 「静默降级」和「降级但留下证据」是两件不同的事。
 */
const UNKNOWN_COLORS = new Set();

/** 未定义色名的告警钩子。默认写 stderr 一次，测试可替换。 */
let colorWarn = (name) => {
  process.stderr.write(`tui-theme: 未定义的色名 "${name}" —— SGR 表漏项，该文本不会被着色\n`);
};

/** 供测试替换/恢复告警钩子，避免测试输出被 stderr 噪音污染。 */
export function setColorWarn(fn) {
  const prev = colorWarn;
  colorWarn = typeof fn === 'function' ? fn : () => {};
  return prev;
}

/** 已出现过的未定义色名（排序后返回，便于断言）。 */
export function unknownColors() {
  return [...UNKNOWN_COLORS].sort();
}

/** 清空记录，仅供测试。 */
export function resetUnknownColors() {
  UNKNOWN_COLORS.clear();
}

/**
 * ANSI 着色。enabled=false 时原样返回（不产生任何 ESC 字节）。
 *
 * 未知颜色名**不静默降级**：仍原样返回文本（不让 TUI 崩），但会记录并告警一次。
 * 这个区别是有代价换来的——旧实现直接 `if (!code) return s`，于是 SGR 表缺了
 * `brightYellow` 时，WAITING 徽章整整一年都没有颜色，而没有任何人会发现。
 *
 * @param {string} text
 * @param {keyof typeof SGR} colorName
 * @param {boolean} [enabled=true]
 * @returns {string}
 */
export function paint(text, colorName, enabled = true) {
  const s = String(text);
  if (!enabled) return s;
  const code = SGR[colorName];
  if (code === undefined) {
    if (!UNKNOWN_COLORS.has(colorName)) {
      UNKNOWN_COLORS.add(colorName);
      try { colorWarn(colorName); } catch { /* 告警失败不影响渲染 */ }
    }
    return s;
  }
  return `\x1b[${code}m${s}${RESET}`;
}

/**
 * 四态徽章：字形 + 空格 + 标签，整体着色。
 * 未知状态不静默映射到五态之一，而是显示 `… UNKNOWN(<原值>)`，
 * 让契约漂移在屏幕上可见。
 *
 * @param {string} state
 * @param {boolean} [enabled=true]
 * @returns {string}
 */
export function badge(state, enabled = true) {
  const meta = Object.hasOwn(STATES, state) ? STATES[state] : null;
  if (!meta) return paint(`… UNKNOWN(${String(state)})`, 'gray', enabled);
  return paint(`${meta.glyph} ${meta.label}`, meta.color, enabled);
}

// ── 宽度计算 ─────────────────────────────────────────────────────────
//
// 三条事实决定了这里的实现，都是实测换来的：
//
// 1. **宽度表必须是 Unicode 官方的全量数据。** 旧实现手抄了 20 段 W/F，
//    而 Unicode 18.0 里有 298 段。实测 10 个代表性字符错了 8 个：
//      ⚓ ⚪ 🟡 🟢 🟣 ✅ ⚡ ⌚  →  全部量成 1 列（实际 2 列）
//    现在表由 scripts/gen-width-table.mjs 从 scripts/data/*.txt（官方原文件）
//    生成；测试直接读原始数据逐码点比对，手改表会被揪出来。
//
// 2. **必须做 grapheme 聚类。** 旧实现按码点遍历，`👍🏻` 被量成 4 列
//    （👍=2 + 肤色修饰符=1? 实际是 2+2），`👨‍👩‍👧` 靠手写的 ZWJ 补丁才勉强对。
//    现在用 Node 内置 Intl.Segmenter，与终端/编辑器的切分一致。
//
// 3. **簇宽度取簇内最大，不是求和。** 这正是 ZWJ 序列、国旗对、肤色修饰符的
//    共同性质：它们占的是一格宽，不是积木相加。取最大值让三类情况用同一条规则。

import { EAW_WIDE, EMOJI_PRESENTATION } from './width-table.mjs';

/**
 * 合并 EAW-W/F 与 Emoji_Presentation 成一张「占 2 列」的查表区间。
 *
 * 为什么要并表：`Emoji_Presentation=Yes` 里有 26 个码点不在 EAW-W/F 内
 * （区域指示符 U+1F1E6..U+1F1FF 是典型——国旗的两个字母）。只查 EAW 会漏掉它们。
 */
function mergeWide() {
  const all = [...EAW_WIDE, ...EMOJI_PRESENTATION].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [lo, hi] of all) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) { if (hi > last[1]) last[1] = hi; }
    else out.push([lo, hi]);
  }
  return out;
}
const WIDE_RANGES = mergeWide();

/** 二分查找：码点是否落在「占 2 列」区间内。O(log n)，n≈130。 */
function isWideCp(cp) {
  let lo = 0;
  let hi = WIDE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = WIDE_RANGES[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * 零宽判定。用 Unicode 属性转义（V8 内置，仍是零依赖），不再手抄列表——
 * 旧实现只有 16 段组合符区间，漏掉了大部分 Mn/Me/Cf。
 *
 * 覆盖：组合符（Mn/Me）、格式符（Cf，含 ZWJ/ZWSP/BOM/软连字符）、
 * C0/C1 控制符、行/段分隔符（Zl/Zp）、代理项（Cs）。
 */
const ZERO_RE = /[\p{Mn}\p{Me}\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Cs}]/u;

function isZeroWidthCp(cp) {
  if (cp === 0) return true;
  return ZERO_RE.test(String.fromCodePoint(cp));
}

const VS16 = 0xFE0F;
const VS15 = 0xFE0E;

/**
 * 一个 grapheme 簇的显示宽度。
 *
 * 规则（按优先级）：
 *   - 簇内没有任何可见码点 → 0（孤立组合符、单独的 ZWJ 等）
 *   - 否则取簇内码点的**最大**宽度：2 若任一码点 EAW-W/F 或 Emoji_Presentation
 *   - 含 VS16（emoji 呈现）→ 至少 2。`♥️` = U+2665 U+FE0F 就是靠这条从 1 提到 2
 *   - `×` `▲` `●` `○` `…` 这类都在窄区，保持 1（界面上的状态字形依赖这一点）
 *
 * **组合符一律不贡献宽度，即使它的 EAW 是 W。** 实测反例：U+302A..302D
 * （CJK 组合用声调符号）在 EastAsianWidth.txt 里被标成 W，但它是 Mn——
 * 它叠在前一个字上，不单独占格。只看 EAW 会把 `中̄` 量成 4 列。
 */
function clusterWidth(cluster) {
  let w = 0;
  let sawVisible = false;
  let sawVs16 = false;
  for (const ch of cluster) {
    const cp = ch.codePointAt(0);
    if (cp === VS16) { sawVs16 = true; continue; }
    if (cp === VS15) continue;
    if (isZeroWidthCp(cp)) continue;
    sawVisible = true;
    const cw = isWideCp(cp) ? 2 : 1;
    if (cw > w) w = cw;
  }
  if (!sawVisible) return 0;
  if (sawVs16 && w < 2) w = 2;
  return w;
}

/** 供调用方与测试直接问「这个码点占几列」，避免再写第二份宽度规则。 */
export function codePointWidth(ch) {
  const s = String(ch ?? '');
  if (!s) return 0;
  return clusterWidth(s);
}

/** 匹配 CSI（含 SGR）与 OSC 序列，用于从可见宽度中剔除控制码。 */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** 供调用方净化和量宽共用。必须单一真源：曾因 TUI 自己写了一份更窄的
 *  CSI-only 正则，导致 OSC 52 序列穿透到终端。 */
export function stripAnsi(str) {
  return String(str ?? '').replace(ANSI_RE, '');
}

/** 把字符串切成 ANSI 段与文本段。 */
function splitAnsi(str) {
  const out = [];
  let last = 0;
  for (const m of str.matchAll(ANSI_RE)) {
    if (m.index > last) out.push({ ansi: false, text: str.slice(last, m.index) });
    out.push({ ansi: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < str.length) out.push({ ansi: false, text: str.slice(last) });
  return out;
}

/**
 * grapheme 切分器。Node 18+ 内置；缺失时退回「按码点」——
 * 行为会退化（修饰符不聚合），但不会崩，且 `segmenterAvailable()` 让调用方
 * 能知道自己在退化版本上。
 */
const SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/** 是否具备真正的 grapheme 聚类能力（缺 Portion 时会退化为按码点）。 */
export function segmenterAvailable() {
  return SEGMENTER !== null;
}

/** 把一段纯文本切成簇并用 clusterWidth 量好。 */
function textUnits(text) {
  const units = [];
  if (!text) return units;
  if (SEGMENTER) {
    for (const { segment } of SEGMENTER.segment(text)) {
      units.push({ ansi: false, text: segment, width: clusterWidth(segment) });
    }
    return units;
  }
  for (const ch of text) units.push({ ansi: false, text: ch, width: clusterWidth(ch) });
  return units;
}

/**
 * 把字符串切成「显示单元」：一个单元是最小的不可分割可见片段
 * （一个 grapheme 簇、或一段 ANSI 控制码）。
 *
 * displayWidth / padDisplay / truncateDisplay 共用这个函数，保证「量出来的宽度」
 * 和「截断时切在哪里」永远一致。
 */
function measure(str) {
  const units = [];
  for (const token of splitAnsi(str)) {
    if (token.ansi) units.push({ ansi: true, text: token.text, width: 0 });
    else for (const u of textUnits(token.text)) units.push(u);
  }
  return units;
}

/**
 * 终端显示宽度（列数）。ANSI 控制码计 0，CJK / 全角 / emoji 计 2。
 * 制表符等 C0 控制字符计 0 —— 表格单元格里不应出现它们。
 *
 * @param {string} str
 * @returns {number}
 */
export function displayWidth(str) {
  let width = 0;
  for (const unit of measure(String(str ?? ''))) width += unit.width;
  return width;
}

/**
 * 按显示宽度截断，超宽时截到 width-1 列并补一个 `…`。
 *
 * **为什么单独导出**：它必须与 displayWidth 共用同一份聚类结果。旧实现散在
 * oversight-tui.mjs 里，每追加一个字符就重算整个前缀（`displayWidth(out + cp)`），
 * 一行的代价是 O(n²)：实测 6400 字 **321ms/call**。现在按簇累加，O(n)。
 *
 * 语义（与旧 truncateToWidth 保持一致，避免调用点行为漂移）：
 *   - width <= 0 → ''
 *   - 不超宽 → 原样返回（含 ANSI，不做任何改写）
 *   - width === 1 → '…'
 *   - 截断后若出现过 ANSI，补 RESET 防颜色漏到下一行
 *   - 不切开宽字符：边界只剩 1 列时宁可留空
 *
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
export function truncateDisplay(str, width) {
  const max = Math.floor(Number(width));
  if (!Number.isFinite(max) || max <= 0) return '';
  const s = String(str ?? '');
  const units = measure(s);
  let total = 0;
  for (const u of units) total += u.width;
  if (total <= max) return s;
  if (max === 1) return '…';

  const limit = max - 1;          // 留 1 列给省略号
  let used = 0;
  let sawAnsi = false;
  let out = '';
  for (const unit of units) {
    if (unit.ansi) { out += unit.text; sawAnsi = true; continue; }
    if (used + unit.width > limit) break;
    out += unit.text;
    used += unit.width;
  }
  return out + '…' + (sawAnsi ? RESET : '');
}

/**
 * 按显示宽度截断并补空格到目标宽度。
 *
 * - 超宽时截到 width-1 列并补一个 `…`，明确表示「这里被切过」；
 * - 不切开宽字符：边界只剩 1 列时宁可留空格；
 * - ANSI 安全：控制码原样保留，截断后补 RESET 防止颜色漏到下一行；
 * - 不截断时直接补空格，原字符串（含颜色）不动。
 *
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
export function padDisplay(str, width) {
  const target = Math.max(0, Math.floor(Number(width)));
  const s = String(str ?? '');
  if (!Number.isFinite(target) || target === 0) return '';

  const units = measure(s);
  let visible = 0;
  for (const u of units) visible += u.width;
  if (visible === target) return s;
  if (visible < target) return s + ' '.repeat(target - visible);

  const body = truncateDisplay(s, target);
  const used = displayWidth(body);
  return body + ' '.repeat(Math.max(0, target - used));
}

/**
 * 是否应该启用颜色。三个关闭条件，任一命中即关闭：
 *   1. 流不是 TTY（管道、重定向、CI）；
 *   2. NO_COLOR 存在且非空（no-color.org 约定，空串不算设置）；
 *   3. TERM=dumb（无颜色能力的终端）。
 *
 * @param {{isTTY?: boolean}} [stream]
 * @returns {boolean}
 */
export function colorEnabled(stream = process.stdout) {
  if (!stream || stream.isTTY !== true) return false;
  const { NO_COLOR, TERM } = process.env;
  if (NO_COLOR !== undefined && NO_COLOR !== '') return false;
  if (TERM === 'dumb') return false;
  return true;
}
