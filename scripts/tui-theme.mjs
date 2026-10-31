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

/** 命名颜色 → SGR 前景码。只列终端普遍支持的 8 色 + 灰。 */
const SGR = {
  red: 31,
  green: 32,
  yellow: 33,
  magenta: 35,
  cyan: 36,
  gray: 90,
  dim: 2,
};

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
    meaning: '宿主报 failed，或心跳间隔超自适应阈值且 60s 内无新记录、连续 3 次不可解析、预算耗尽且零增益。唯一允许全量重跑的状态。',
  },
  STALLED: {
    glyph: '▲',
    color: 'magenta',
    label: 'STALLED',
    meaning: '连续 3 窗 novelty < 0.2，窗口内无持久化变更，且派生树无任一节点有增益。走 L2 探针 → L3 收窄 → L4 重新拆解。',
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
 * ANSI 着色。enabled=false 时原样返回（不产生任何 ESC 字节）。
 * 未知颜色名视为编程错误，但不抛异常：原样返回，让缺陷以「没颜色」暴露，
 * 而不是让整个 TUI 崩掉。
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
  if (!code) return s;
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

/** 组合符、变体选择符、零宽控制符。 */
const ZERO_WIDTH = [
  [0x0300, 0x036f], // 组合附加符
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff], // 组合用符号（含 keycap U+20E3）
  [0xfe00, 0xfe0f], // 变体选择符
  [0xfe20, 0xfe2f],
  [0xe0100, 0xe01ef],
];

/** East Asian Width = W / F 的区间，以及 emoji 呈现区。 */
const WIDE = [
  [0x1100, 0x115f], // Hangul Jamo 初声
  [0x2e80, 0x303e], // CJK 部首、康熙部首、CJK 符号与标点（含 U+3000）
  [0x3041, 0x33ff], // 假名、注音、CJK 兼容
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区
  [0xa000, 0xa4cf], // 彝文
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3], // Hangul 音节
  [0xf900, 0xfaff], // CJK 兼容汉字
  [0xfe10, 0xfe19], // 竖排形式
  [0xfe30, 0xfe6f], // CJK 兼容形式
  [0xff00, 0xff60], // 全角 ASCII 与全角标点
  [0xffe0, 0xffe6], // 全角符号
  [0x1f1e6, 0x1f1ff], // 区域指示符（国旗）
  [0x1f300, 0x1f64f], // 杂项符号与象形
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], // CJK 扩展 B 及以后
  [0x30000, 0x3fffd],
];

const inRanges = (cp, ranges) => {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
};

const isZeroWidth = (cp) => {
  if (cp === 0) return true;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return true; // C0 / C1 控制字符
  if (cp === 0x00ad) return true; // 软连字符
  if (cp === 0x200b || cp === 0x200c || cp === 0x200e || cp === 0x200f) return true;
  if (cp === 0x2060 || cp === 0xfeff) return true;
  return inRanges(cp, ZERO_WIDTH);
};

const isWide = (cp) => inRanges(cp, WIDE);
const isRegionalIndicator = (cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff;

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
 * 把字符串切成「显示单元」：一个单元是最小的不可分割可见片段
 * （一个宽字符、一个 ASCII 字符、或一个 emoji 簇）。
 * 组合符 / ZWJ 序列 / 区域指示符对 / 变体选择符都并入所属单元。
 *
 * displayWidth 与 padDisplay 共用这个函数，保证「量出来的宽度」
 * 和「截断时切在哪里」永远一致。
 */
function measure(str) {
  const units = [];
  let cur = null;
  let prevZWJ = false;
  let lastWasRI = false;

  const flush = () => {
    if (cur) {
      units.push(cur);
      cur = null;
    }
  };

  for (const token of splitAnsi(str)) {
    if (token.ansi) {
      flush();
      units.push({ ansi: true, text: token.text });
      continue;
    }
    for (const ch of token.text) {
      const cp = ch.codePointAt(0);

      // ZWJ：下一个码点并入同一簇
      if (cp === 0x200d) {
        prevZWJ = true;
        cur = cur || { text: '', width: 0 };
        cur.text += ch;
        continue;
      }

      // VS16：把前面的 1 宽字符提升为 emoji 呈现（1 → 2）
      if (cp === 0xfe0f) {
        cur = cur || { text: '', width: 0 };
        cur.text += ch;
        if (cur.width === 1) cur.width = 2;
        continue;
      }

      // VS15（文本呈现）及其他零宽字符：并入当前单元
      if (cp === 0xfe0e || isZeroWidth(cp)) {
        cur = cur || { text: '', width: 0 };
        cur.text += ch;
        continue;
      }

      let w = isWide(cp) ? 2 : 1;
      if (prevZWJ) w = 0; // 已并入前一个 emoji
      prevZWJ = false;

      if (isRegionalIndicator(cp)) {
        if (lastWasRI) {
          w = 0; // 国旗对只算一次
          lastWasRI = false;
        } else {
          lastWasRI = true;
        }
      } else {
        lastWasRI = false;
      }

      if (w === 0) {
        cur = cur || { text: '', width: 0 };
        cur.text += ch;
        continue;
      }

      flush();
      cur = { text: ch, width: w };
    }
  }
  flush();
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
  for (const unit of measure(String(str ?? ''))) {
    if (!unit.ansi) width += unit.width;
  }
  return width;
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
  const visible = units.reduce((n, u) => n + (u.ansi ? 0 : u.width), 0);
  if (visible === target) return s;
  if (visible < target) return s + ' '.repeat(target - visible);

  // 截断：留 1 列给省略号
  const limit = target - 1;
  let used = 0;
  let sawAnsi = false;
  let out = '';
  for (const unit of units) {
    if (unit.ansi) {
      out += unit.text;
      sawAnsi = true;
      continue;
    }
    if (used + unit.width > limit) break;
    out += unit.text;
    used += unit.width;
  }
  out += '…';
  if (sawAnsi) out += RESET;
  return out + ' '.repeat(Math.max(0, target - used - 1));
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
