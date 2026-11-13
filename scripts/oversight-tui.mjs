#!/usr/bin/env node
/**
 * oversight-tui.mjs — OmniSight 的终端界面。
 *
 * 只做渲染：不判定状态、不计算 novelty、不修改任何文件。
 * 所有状态与数字都来自 `scan-sessions.mjs --json` 的原样输出。
 *
 * **默认屏回答的是「有没有事」，不是「有哪些会话」**（规划 §2.1）。
 * 版面层次（`docs/design/2026-11-05-tui-redesign-plan.md` §2.3）：
 *
 *   L0  判决行     ← 永远是第 1 行。「N 件在等你」在最前
 *   L1  检查表     ← 「没」凭什么成立：四道独立数据源
 *   L2  需动作区   ← 0..N 行，空则不画；两行一条（身份 + 逐字 needs）
 *   L3  在跑区     ← 只有活着且有 transcript 的会话
 *   L4  已停区     ← 一行计数，按 h 展开
 *   L5  详情（Enter）
 *   L6  高级与证据（d 证据 / i 内部量）
 *
 * 用法：
 *   node scripts/oversight-tui.mjs                 # 交互界面，最近 3 天，8 秒轮询
 *   node scripts/oversight-tui.mjs --days 1        # 缩短扫描窗口
 *   node scripts/oversight-tui.mjs --interval 15   # 调整轮询间隔（秒）
 *   node scripts/oversight-tui.mjs | cat           # 非 TTY：纯文本快照后退出
 *
 * 按键：j/k 或 ↑/↓ 移动，Enter 详情，Esc 返回，c 复制草稿，r 刷新，
 *       h 展开/收起已停，d 证据，i 内部量，? 帮助，q 退出。
 *
 * 零 npm 依赖，只用 node: 内置模块。只读。
 */

import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STATES, displayWidth, padDisplay, paint, stripAnsi, truncateDisplay } from './tui-theme.mjs';
import {
  ACTION_MAX_AGE_SEC, ACTION_STATES, actionCell, ageSecOf, binaryOf, checklistLines, checklistRows,
  composeListScreen, footerParts, fmtAgeMs, fmtScanAge, fmtSpan, layoutStages, nearText,
  partitionRows, resolveLayout, sectionTitle, staleOf, stoppedSummary,
  titleOf, verdictParts, windowOf, shortPath, truncateWithDisclosure, runningRowOf,
} from './tui-layout.mjs';
import { createMetaCache, metaFromRecords, projectsRoot, readTailRecords, transcriptPathFor } from './tui-meta.mjs';
import { buildInbox, defaultStateDir, healthCheck, loadState } from './watch.mjs';
import { renderSessionBlock, summarizeClaims, flattenResults } from './verify-claims.mjs';

// ── 常量 ──────────────────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCAN_PATH = join(SCRIPT_DIR, 'scan-sessions.mjs');

/** 终端展示顺序：异常态在前。与 scan-sessions.mjs 的人类输出保持一致。 */
// 顺序必须覆盖 tui-theme.STATES 的全部键，否则新状态会显示成 UNKNOWN。
// 2026-11-01：WAITING 加进 tui-theme 之后这里没跟上，一个正在等用户的会话
// 在 TUI 里显示成 UNKNOWN —— 比不显示更糟，因为它看起来像数据坏了。
// 现在直接从 STATES 派生，两边不可能再分叉。
const STATE_ORDER = Object.keys(STATES);

// 字形与颜色是单一真源，来自 tui-theme.mjs。
// 本文件曾自带一份 GLYPHS 表，与 tui-theme 不一致：BLOCKED 用了 ▲（规范里是 STALLED 的），
// FAILED 用了 ✕、STALLED 用了 ◐ —— 后两个在 conhost/PowerShell 的等宽字体里渲染成方块。
const GLYPHS = Object.fromEntries(
  Object.entries(STATES).map(([k, v]) => [k, v.glyph]),
);
const UNKNOWN_GLYPH = '?';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
// 反显（SGR 7）已删除：它把「颜色」和「焦点位置」绑在同一个像素上，
// 与 tui-visual.md 的三通道原则冲突。选中现在用 `❯`（形状）+ 绿色文字（第二通道），
// 严重度仍由状态字形与颜色承担 —— 两条通道不重叠。

const DEFAULT_DAYS = 3;
const DEFAULT_INTERVAL_SEC = 8;
const SCAN_TIMEOUT_MS = 180_000;
const NOTICE_MS = 4000;

const HINT_LIST = 'j/k 移动 · Enter 详情 · c 复制草稿 · r 刷新 · q 退出 · ? 帮助';
const HINT_DETAIL = 'Esc 返回 · c 复制草稿 · q 退出';
const HINT_DRAFT = '按任意键关闭';

// ── 显示宽度（CJK）────────────────────────────────────────────────────
//
// 宽度计算与字形定义统一由 tui-theme.mjs 提供，本文件不再自带一份。
// 曾有两份实现（本文件 + tui-theme），字形表已经漂移过一次：
// BLOCKED 显示成 ▲、FAILED 用 ✕ —— 而 ✕/◐ 在 conhost 下是方块。

/** 去掉所有 ANSI 转义序列，用于宽度测量与净化。单一真源在 tui-theme.mjs。 */
function stripSgr(s) {
  return stripAnsi(s);
}

/** 净化外部来源的文本（project / reason / needs / suggestedReply / jobDetail）。
 *
 *  这些字段来自 transcript 与 ~/.claude/jobs，不是可信输入。曾实测一段
 *  `\x1b]52;c;<base64>\x07`（OSC 52，写系统剪贴板）被 truncateToWidth 原样放行——
 *  只读渲染器被目录名或 session 内容反向改了剪贴板。
 *  这里把所有非 SGR 的 ESC 序列直接删除，并把裸控制字符替换成可见占位。
 */
export function sanitize(s) {
  return stripAnsi(s)                               // CSI / OSC / 其他 ANSI 序列
    .replace(/\x1b/g, '')                           // 残留的裸 ESC
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '·'); // C0 控制符（保留 \n \t）
}

/**
 * 按显示宽度截断，SGR 序列不占宽、也不会被从中间切断。
 * 截断时给省略号留 1 列；max=0 返回空串。
 *
 * **实现在 tui-theme.mjs（truncateDisplay），这里只转发。**
 * 2026-11-05 修：旧实现每追加一个字符就 `displayWidth(out + cp)` 重算整个前缀，
 * 一行的代价是 O(n²)——实测 6400 字 **321ms/call**，而它每条列表行的 reason 列
 * 都要调一次。改成按 grapheme 簇累加后同一个输入 0.4ms。
 * 之所以搬到 tui-theme：宽度规则（Unicode 表 + 聚类）只能有一份，
 * 有两份就会像 2026-11-01 那样，界面宽度和 tui-theme 的宽度各自漂移。
 *
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
export function truncateToWidth(str, max) {
  return truncateDisplay(str, max);
}

/** 截断并补空格到固定显示宽度。SGR 序列保留，宽度按可见字符计。 */
function fitWidth(str, width) {
  const s = String(str ?? '');
  const cut = displayWidth(s) > width ? truncateToWidth(s, width) : s;
  return cut + ' '.repeat(Math.max(0, width - displayWidth(cut)));
}

/** 纯文本行补齐到终端宽度（不含截断：行内容应已按宽度构造）。 */
function fitLine(str, width) {
  const w = displayWidth(str);
  return w >= width ? str : str + ' '.repeat(width - w);
}

/** 按显示宽度换行；保留原有换行符。 */
export function wrapToWidth(text, width) {
  const max = Math.max(1, width);
  const out = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    if (!paragraph) { out.push(''); continue; }
    let line = '';
    let w = 0;
    for (const cp of paragraph) {
      const cw = displayWidth(cp);
      if (w + cw > max) {
        // 优先在最后一个空格处断行，避免把英文单词劈开
        const sp = line.lastIndexOf(' ');
        if (sp > 0) {
          out.push(line.slice(0, sp));
          line = line.slice(sp + 1);
          w = displayWidth(line);
        } else {
          out.push(line);
          line = '';
          w = 0;
        }
      }
      line += cp;
      w += cw;
    }
    out.push(line);
  }
  return out;
}

// ── 格式化 ────────────────────────────────────────────────────────────

/** 把 `D--Projects-Overwatch` 这类目录名还原成 `Projects/Overwatch`。 */
function projectLabel(project) {
  return String(project ?? '')
    .replace(/^[A-Za-z]--/, '')
    .replace(/-/g, '/');
}

function fmtDur(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s)) return 'n/a';
  if (s < 0) return '0s';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function fmtAgo(ms) {
  if (!Number.isFinite(ms)) return '尚未刷新';
  const sec = Math.max(0, Math.round(ms / 1000));
  return `${sec}s 前`;
}

function fmtNovelty(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : 'n/a';
}

/** 数据来源的人话标签。三种来源的「可信度来源」不同，界面必须能说清。 */
export function sourceLabel(source) {
  if (source === 'transcript') return 'transcript 重建';
  if (source === 'job') return '宿主 job（无 transcript）';
  if (source === 'live') return '宿主实时状态';
  return source ?? '—';
}

function stateOf(session) {
  return STATE_ORDER.includes(session?.state) ? session.state : 'UNKNOWN';
}

function glyphOf(session) {
  return GLYPHS[session?.state] ?? UNKNOWN_GLYPH;
}

/** 汇总状态计数，按展示顺序，仅列非零项。 */
function stateCounts(sessions) {
  const counts = new Map();
  for (const s of sessions) {
    const st = s.state;
    if (!STATE_ORDER.includes(st)) continue;
    counts.set(st, (counts.get(st) ?? 0) + 1);
  }
  return STATE_ORDER.filter((st) => counts.has(st)).map((st) => `${st}=${counts.get(st)}`).join(' ');
}

/**
 * 组装接力草稿。**返回的内容就是会被粘进对话框的东西，必须能直接发出去。**
 *
 * 2026-11-11 用户实测：按 `c` 复制到的是
 *
 *     把实测单发给我
 *
 *     （目标会话受阻，在等：要我现在就把用户实测单交给你，还是你先看这四份测试报告？）
 *
 * 两个后果：
 *
 *  (a) **第二段是元注释，粘进去等于发了一句奇怪的话。** 用户按 `c` 是为了拿到
 *      「可以发出去的文字」，不是拿到一份带旁白的报告。`needs` 是**给人看的上下文**，
 *      它属于屏幕，不属于剪贴板。现在 `needs` 不再进草稿，只进 `--plain`/详情页。
 *  (b) **陈旧的 `suggestedReply` 不该被当成可发的内容。** 那个会话 33 天没动过，
 *      「把实测单发给我」只是宿主 33 天前猜的一句。复制它出去没有任何意义。
 *      所以超龄的等待直接不给草稿（返回 null），由界面提示「该会话已超龄」。
 *
 * 现在的行为（可逐条验收）：
 *   - 有 `suggestedReply` 且未超龄 → 返回**它的原文**，一行，不加任何前后缀；
 *   - 超龄（`staleOf().stale`）→ 返回 `null`（不给假按钮，见规划 P6）；
 *   - 只有 `needs` 没有 `suggestedReply` → 返回 `null`。这一条是**故意改的**：
 *     以前它会把 `（目标会话正在等待：…）` 塞进剪贴板，那正是缺陷本身。
 *     没有 suggestedReply 时正确动作是「人去自己写」，不是「复制一句旁白」。
 *
 * 出口统一净化：草稿会被复制进剪贴板并显示在终端，控制字符不能流出去。
 *
 * @param {object} session
 * @param {{nowMs?:number}} [opts] 老化判断用的注入时钟（不传则只看行上的 idleSec）
 * @returns {string|null} 可直接发送的文本；没有可用内容时返回 null
 */
export function buildDraft(session, opts = {}) {
  const reply = typeof session?.suggestedReply === 'string' ? sanitize(session.suggestedReply).trim() : '';
  if (!reply) return null;
  // 超龄的等待：宿主 33 天前猜的回复不该被当成本刻的建议。
  // 用注入的 nowMs，不读挂钟 —— staleOf 的契约见 tui-layout.mjs。
  const nowMs = Number.isFinite(opts?.nowMs) ? opts.nowMs : null;
  if (staleOf(session, nowMs).stale) return null;
  return reply;
}

/**
 * 草稿的**可复制性**说明。给界面用，不进剪贴板。
 *
 * 返回值是给人看的一句话，例如「按 c 复制：把实测单发给我」或
 * 「该会话已 33.2 天没动，不再给建议回复（按 Enter 看原文）」。抽成函数是为了让
 * 「界面上写了什么」与「剪贴板里是什么」被同一处决定——它们分家正是这次缺陷的根。
 *
 * @param {object} session
 * @param {{nowMs?:number}} [opts]
 * @returns {{copyable:boolean, text:string, reason:string}}
 */
export function draftHintOf(session, opts = {}) {
  const nowMs = Number.isFinite(opts?.nowMs) ? opts.nowMs : null;
  const reply = typeof session?.suggestedReply === 'string' ? sanitize(session.suggestedReply).trim() : '';
  if (!reply) {
    return { copyable: false, text: '', reason: '宿主没给建议回复，需要自己写' };
  }
  const age = staleOf(session, nowMs);
  if (age.stale) {
    const d = Number.isFinite(age.ageSec) ? `已 ${fmtSpan(age.ageSec)} 没动` : '已超出老化上限';
    return { copyable: false, text: '', reason: `${d}，不再给建议回复` };
  }
  return { copyable: true, text: reply, reason: '' };
}

// ── 扫描（唯一的子进程调用）──────────────────────────────────────────

/**
 * 证据扫描：跑 `verify-claims.mjs --json`，返回扁平化的断言数组。
 *
 * **它是子进程，不是进程内调用。** 进程内 import 只要 7ms，但 `scanSession`
 * 要读 1 MB 尾部 × N 个会话并做有界回溯，实测 7.2 秒——放进 8 秒轮询会把整个
 * 刷新周期吃满（规划 §七）。子进程让它可以被杀掉（用户按 q 不必等它跑完），
 * 也让 TUI 的内存不被 verify-claims 的中间态污染。
 *
 * 返回 `{ promise }`，与 `defaultScan` 同形；调用方可以用 `.cancel()` 放弃。
 */
export function defaultClaimsScan({ days = 3, exec = execFile } = {}) {
  let child = null;
  let cancelled = false;
  const promise = new Promise((resolve) => {
    child = exec(
      process.execPath,
      [join(SCRIPT_DIR, 'verify-claims.mjs'), '--json', '--days', String(days)],
      { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (cancelled) { resolve({ error: 'cancelled' }); return; }
        let parsed = null;
        try { parsed = JSON.parse(String(stdout ?? '')); } catch { /* 下面统一报错 */ }
        if (!parsed || !Array.isArray(parsed.rows)) {
          resolve({ error: err ? (err.killed ? '超时' : String(err.message || err)) : '输出不是合法 JSON' });
          return;
        }
        resolve({ results: flattenResults(parsed.rows).map((x) => ({ ...x.r, sessionId: x.row.sessionId, project: x.row.project })) });
      },
    );
  });
  const cancel = () => {
    cancelled = true;
    if (child && child.kill) { try { child.kill(); } catch { /* 已退出 */ } }
  };
  return { promise, cancel };
}

/**
 * 调用 scan-sessions.mjs --json。
 * 注意：scan 在存在 FAILED 会话时 exit 1，但 stdout 仍是完整 JSON，不能当失败。
 *
 * 返回 { promise, cancel }：cancel() 会 kill 子进程。
 * 没有这个的话，按 q 之后进程要等扫描跑完（--days 30 实测约 87 秒）才真正退出，
 * 期间终端已恢复但用户以为卡死。实测曾出现 11.5 秒空窗。
 */
function defaultScan({ days, exec = execFile }) {
  let child = null;
  let cancelled = false;
  const promise = new Promise((resolve) => {
    child = exec(
      process.execPath,
      [SCAN_PATH, '--json', '--days', String(days)],
      { encoding: 'utf8', timeout: SCAN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (cancelled) { resolve({ data: null, warning: null, cancelled: true }); return; }
        let data = null;
        try {
          const parsed = JSON.parse(String(stdout ?? ''));
          if (parsed && Array.isArray(parsed.sessions)) data = parsed;
        } catch { /* 下面统一报错 */ }

        if (data) {
          resolve({ data, warning: null });
          return;
        }
        const reason = err
          ? (err.killed ? `扫描超时（>${Math.round(SCAN_TIMEOUT_MS / 1000)}s）` : `扫描失败：${err.message}`)
          : '扫描输出不是合法 JSON';
        const extra = String(stderr ?? '').trim().split('\n').filter(Boolean)[0];
        resolve({ data: null, warning: extra ? `${reason}（${extra.slice(0, 80)}）` : reason });
      },
    );
  });
  const cancel = () => {
    cancelled = true;
    if (child && child.kill) {
      try { child.kill(); } catch { /* 已退出 */ }
    }
  };
  return { promise, cancel };
}

// ── 剪贴板 ────────────────────────────────────────────────────────────

/**
 * Windows 上 `clip.exe` 只有在其控制台代码页为 UTF-8 时才保真；系统是 936(GBK) 时
 * 中文会变成 `?`（实测 `甲` → E9 90 A2 3F）。尝试过的替代里只有一条在同机实测
 * 中文 / ASCII / 换行 / 1200 字长文本上全部逐字节相等：
 *   把 UTF-16LE 字节喂给 PowerShell，先设 `InputEncoding=Unicode` 再 Set-Clipboard。
 * 因此 win32 走这条；macOS 用 pbcopy；其余用 xclip。
 */
function clipboardCommand(platform) {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::InputEncoding=[Text.Encoding]::Unicode; '
        + '$t=[Console]::In.ReadToEnd(); Set-Clipboard -Value $t',
      ],
    };
  }
  if (platform === 'darwin') return { file: 'pbcopy', args: [] };
  return { file: 'xclip', args: ['-selection', 'clipboard'] };
}

function clipboardPayload(text, platform) {
  const s = String(text).replace(/\r?\n/g, '\r\n');
  return platform === 'win32' ? Buffer.from(s, 'utf16le') : Buffer.from(s, 'utf8');
}

/** 把文本写进系统剪贴板。成功 true，任何失败 false。 */
export function copyToClipboard(text, platform = process.platform) {
  return new Promise((resolve) => {
    const { file, args } = clipboardCommand(platform);
    let child;
    try {
      child = spawn(file, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
    child.stdin.on('error', () => {});
    try { child.stdin.end(clipboardPayload(text, platform)); } catch { done(false); }
  });
}

// ── 按键解析 ──────────────────────────────────────────────────────────

/**
 * 把一次 data chunk 拆成按键记号。
 * 终端可能把 `\x1b[D` 拆成两个 chunk，因此末尾不完整序列会作为 `rest` 返回，
 * 由调用方缓存并在下一个 chunk（或短暂超时后）继续解析。
 */
export function parseKeysWithRest(chunk) {
  const keys = [];
  const s = String(chunk);
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\x1b') {
      const rest = s.slice(i);
      if (rest.length === 1) return { keys, rest };          // 可能是 Esc，也可能是序列开头
      if (s[i + 1] === '[') {
        const m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest);
        if (!m) {
          if (/^\x1b\[[0-9;]*$/.test(rest)) return { keys, rest }; // 序列尚未收完
          i += 1;                                             // 非法序列：当 Esc 处理
          keys.push('escape');
          continue;
        }
        const code = m[2];
        const num = m[1];
        if (code === 'A') keys.push('up');
        else if (code === 'B') keys.push('down');
        else if (code === 'C') keys.push('right');
        else if (code === 'D') keys.push('left');
        else if (code === '~' && num === '5') keys.push('pgup');
        else if (code === '~' && num === '6') keys.push('pgdown');
        else if (code === '~' && num === '1') keys.push('home');
        else if (code === '~' && num === '4') keys.push('end');
        i += m[0].length;
        continue;
      }
      if (s[i + 1] === 'O') {
        if (rest.length < 3) return { keys, rest };
        const code = s[i + 2];
        if (code === 'A') keys.push('up');
        else if (code === 'B') keys.push('down');
        else if (code === 'C') keys.push('right');
        else if (code === 'D') keys.push('left');
        i += 3;
        continue;
      }
      keys.push('escape');
      i += 1;
      continue;
    }
    if (ch === '\x03') { keys.push('ctrl-c'); i += 1; continue; }
    if (ch === '\r' || ch === '\n') { keys.push('enter'); i += 1; continue; }
    if (ch === '\x7f' || ch === '\b') { keys.push('backspace'); i += 1; continue; }
    if (ch === '\t') { keys.push('tab'); i += 1; continue; }
    keys.push(ch);
    i += 1;
  }
  return { keys, rest: '' };
}

/** 无状态便捷版：不完整的末尾序列当作 Esc。 */
export function parseKeys(chunk) {
  const { keys, rest } = parseKeysWithRest(chunk);
  if (rest) keys.push('escape');
  return keys;
}

// ── 行渲染 ────────────────────────────────────────────────────────────

const COL_STATE = 11;
const COL_PROJECT = 24;
const COL_CALLS = 11;
const COL_NOV = 8;
const COL_IDLE = 11;

/** 状态列：字形 + 文字。宽度固定，着色在外层加。 */
function stateColumn(session) {
  return `${glyphOf(session)} ${stateOf(session).padEnd(9)}`;
}

/**
 * 列表行（**兼容旧 API，不是主屏的渲染路径**）。
 *
 * @deprecated 主屏走 `tui-layout.mjs` 的 `composeListScreen`。保留它是因为
 *   `listRow` 是已登记导出，外部调用与旧测试仍在用；它现在只画「状态 + 项目 +
 *   三个内部量」，字段选择与主屏无关 —— **不要把新字段加到这里**。
 *   主屏的字段矩阵在 `viewOf()`，那里拿不到的字段就画不到屏幕上（规划 §2.5）。
 */
export function listRow(session, cols, selected) {
  const marker = selected ? '> ' : '  ';
  const showCalls = cols >= 44;
  const showNov = cols >= 56;
  const showIdle = cols >= 66;
  const showReason = cols >= 78;

  let line = marker + fitWidth(stateColumn(session), COL_STATE) + ' '
    + fitWidth(projectLabel(sanitize(session.project)), COL_PROJECT);
  // calls 为 null 表示「不是扫描出来的」——这类会话没有 transcript。
  // 显示成 calls=0 是在撒谎（它可能是 0 次调用，也可能是没扫）。
  if (showCalls) {
    const v = session.calls == null ? '—' : String(session.calls).padStart(5);
    line += ' ' + fitWidth(`calls=${v}`, COL_CALLS);
  }
  if (showNov) line += ' ' + fitWidth(`nov=${fmtNovelty(session.novelty)}`, COL_NOV);
  if (showIdle) line += ' ' + fitWidth(`idle=${fmtDur(session.idleSec)}`, COL_IDLE);

  if (showReason) {
    const rest = cols - displayWidth(line) - 1;
    if (rest > 4) line += ' ' + truncateToWidth(sanitize(session.reason ?? ''), rest);
  }
  // 极端窄终端：至少保证不折行
  return truncateToWidth(line, cols);
}

/** 列表头。liveness 必须来自当前数据，不能写死——
 *  实测 19 条会话里 17 条是 stale，写死 reconstructed 等于替数据撒谎。 */
function listHeaderLine(days, cols, sessions = []) {
  const tally = {};
  for (const s of sessions) {
    if (s.liveness) tally[s.liveness] = (tally[s.liveness] || 0) + 1;
  }
  const parts = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`);
  const live = parts.length ? parts.join(' ') : 'unknown';
  // 窗口必须说清楚。`--all`（days=0）不能印成「最近 0 天」。
  const w = Number(days) === 0 ? '全部' : `最近 ${days} 天`;
  const title = `OmniSight · 会话列表 · ${w} · liveness ${live}`;
  return truncateToWidth(title, cols);
}

function columnHeaderLine(cols) {
  let line = '  ' + fitWidth('状态', COL_STATE) + ' ' + fitWidth('项目', COL_PROJECT);
  if (cols >= 44) line += ' ' + fitWidth('calls', COL_CALLS);
  if (cols >= 56) line += ' ' + fitWidth('novelty', COL_NOV);
  if (cols >= 66) line += ' ' + fitWidth('idle', COL_IDLE);
  if (cols >= 78) line += ' ' + 'reason';
  return truncateToWidth(line, cols);
}

/** 窗口标签。`--all`（days=0）不能印成「最近 0 天」。 */
function windowLabelOf(days) {
  return Number(days) === 0 ? '全部' : `最近 ${days} 天`;
}

/**
 * 一条扫描行 → 列表页需要的最小视图对象。**纯函数**。
 *
 * 这是「字段 → 屏幕矩阵」（规划 §2.5）的落地处：矩阵里标 `—` 的字段一律不出现在
 * 这个对象里，于是渲染层**拿不到**它们，也就无法误把它们画到 L0–L3。
 *   removed : reason
 *   L6 only : novelty / noveltyAll / calls / liveness / hbThresholdSec / lastGapSec / tokens
 *
 * @param {object} row      scan --json 的一行（或 liveToRow 补出来的行）
 * @param {object} [meta]   tui-meta 的读取结果（标题 / 末条 assistant / 未答问句）
 */
export function viewOf(row, meta = null) {
  const kind = binaryOf(row);
  // 身份优先级：transcript 的 cwd（最准）> 扫描行自带的 cwd > 项目目录名。
  // **绝不从目录编码反推路径**（`D--Projects-Overwatch` 反推会在项目名带连字符时
  // 画出不存在的层级 —— 见 dsh-TUI 分析 §2.4 末）。
  const where = (meta && meta.cwd) || row?.cwd || row?.project || '';
  const t = titleOf({ title: (meta && meta.title) ?? row?.name ?? null, path: where, key: sessionKey(row) });
  // **净化只做在这里，不做在渲染层。** 列表页与纯文本页都从本函数取 view，
  // 于是它是唯一必经之路；此前 title / path / needs / suggestedReply 全部原样放行，
  // 而它们来自 transcript 与宿主文件（不可信）。实测把 OSC 52 塞进 project
  // 后，`--plain` 与交互屏都能让只读渲染器改写系统剪贴板——详情页净化了，
  // 列表页没有，两条展示路径又一次各修一半。
  return {
    key: sessionKey(row),
    kind,
    // 标题的「可信度」必须能被看见：fallback=true 时渲染层会把它画暗（P4 + Claude TUI 逆向 §3.4）
    // `|| '(无标识)'`：标题若**整段**都是转义序列，净化后会变成空串，而渲染层
    // （`titleOf`）见空标题会退到 `key` 兜底 —— `key` 是光标身份、故意不净化，
    // 于是那一条会绕过本函数。给一个非空标题就把这条兜底路径堵死。
    title: sanitize(t.text) || '(无标识)',
    titleFallback: t.fallback,
    // 存**完整**来源字符串；渲染时再 `shortPath()`。存短路会让详情页拿不到完整 cwd。
    // **只有真正含分隔符的才算路径**；否则那是宿主 job 的目录编码（`D--Projects-X`），
    // 反推成路径会画出不存在的层级（dsh-TUI 分析 §2.4 末），所以不当路径用。
    path: /[\\/]/.test(where) ? sanitize(where) : '',
    idleSec: row?.idleSec ?? null,
    // 这两段是**逐字**上屏的（relay-protocol §5.1），也就在终端上原样执行 —— 必须净化。
    needs: row?.needs == null ? null : sanitize(row.needs),
    suggestedReply: row?.suggestedReply == null ? null : sanitize(row.suggestedReply),
    meta: meta ? { lastAssistant: sanitize(meta.lastAssistant ?? ''), question: sanitize(meta.question ?? '') } : null,
    row,
  };
}

/**
 * 把 scan + live + inbox 组装成三段视图。**这是列表页唯一的取数入口**，
 * 交互屏与纯文本快照都必须走它（两条展示路径各写一份曾经漂移过，见 DF-012/DF-017）。
 *
 * @param {object} p
 * @param {object} p.data      scan --json
 * @param {Array}  [p.inbox]   buildInbox 的结果（已与宿主现状对账）
 * @param {Function} [p.metaOf] (row) => meta；无则视为读不到
 * @param {number} [p.nowMs]
 */
export function buildSections({ data, inbox = [], metaOf = null, nowMs = Date.now() } = {}) {
  const rows = mergeLiveSessions(data, nowMs);
  // 收件箱里可能有扫描行里没有的会话（只在 jobs/*/state.json 里）。补成一条最小行，
  // 否则「它在等你」只出现在收件箱里、而主屏看不见 —— 正是 D6 的形态。
  const resolve = (it) => (it && it.sessionId ? liveToRow({
    sessionId: it.sessionId,
    status: it.state === 'WAITING' ? 'waiting' : it.state === 'FAILED' ? 'failed' : 'blocked',
    waitingFor: typeof it.reason === 'string' && it.reason.startsWith('waiting:') ? it.reason.slice(8) : null,
    cwd: it.project || '',
    statusUpdatedAt: Number.isFinite(it.idleSec) ? nowMs - it.idleSec * 1000 : nowMs,
    needs: it.needs,
    suggestedReply: it.suggestedReply,
  }, nowMs) : null);
  const parted = partitionRows({ sessions: rows, live: data?.live ?? [], inbox, resolve, nowMs });
  const toView = (r) => viewOf(r, metaOf ? metaOf(r) : null);
  // 降级进「已停」的超龄事实带上 `stale` —— 渲染层据此换措辞，
  // 而不是让用户以为那是一条普通历史会话。
  const stoppedView = (r) => {
    const v = toView(r);
    return r && r.stale
      ? { ...v, stale: true, staleAgeSec: r.staleAgeSec ?? null, staleLimitSec: r.staleLimitSec ?? null }
      : v;
  };
  return {
    all: rows,
    action: parted.action.map((r) => actionViewOf(toView(r))),
    running: parted.running.map(toView),
    stopped: parted.stopped.map(stoppedView),
    stale: (parted.stale || []).map(stoppedView),
  };
}

/** 需动作段的一行。kind 一定是「需要人处理」的那三类之一。 */
export function actionViewOf(view) {
  const k = view.kind;
  return { ...view, kind: (k === 'waiting' || k === 'blocked' || k === 'failed') ? k : 'waiting' };
}

/** 「问了没答」计数：末条 assistant 是问句、且之后没人说话的那些。 */
export function askedCountOf(sections) {
  const pool = [...(sections?.action || []), ...(sections?.running || [])];
  return pool.filter((v) => v?.meta && v.meta.question).length;
}

/** 「等你回应」计数：需动作段的行数。 */
export function waitingCountOf(sections) {
  return (sections?.action || []).length;
}

/**
 * verify-claims 的档位计数。
 *
 * **硬 / 存疑必须分开。** 合成一个数字会让「1 条硬矛盾 + 5 条存疑」看起来和
 * 「6 条硬矛盾」一样，而用户要采取的动作完全不同：
 *   hard = FAILED_ONLY + NO_EVIDENCE（断言与证据直接冲突）
 *   soft = STALE_ONLY + UNKNOWN（证据存在但过期，或我们没读到）
 *
 * @param {Array} results flattenResults() 的输出，或直接的 results 数组
 */
export function claimsTally(results) {
  const out = { hard: 0, soft: 0, total: 0 };
  for (const r of results || []) {
    const st = r && r.r ? r.r.status : (r && r.status);
    if (!st) continue;
    out.total++;
    if (st === 'FAILED_ONLY' || st === 'NO_EVIDENCE') out.hard++;
    else if (st === 'STALE_ONLY' || st === 'UNKNOWN') out.soft++;
  }
  return out;
}

/** 扫描新鲜度的右对齐文案。 */
export function scanAgeText(lastSuccessAt, nowMs) {
  if (!lastSuccessAt) return '尚未扫描';
  return fmtScanAge(nowMs - lastSuccessAt);
}

/** 首次扫描的等待提示。
 *
 *  2026-11-01 实测：本机 33 个会话、26 秒。**一个刚拿到仓库的人第一次打开 TUI，
 *  看到的是 26 秒的空白 + 一行「刷新中…」**，没有任何提示会等这么久——
 *  大部分人会以为卡死，然后 Ctrl-C。
 *
 *  这里在首次扫描期间显示一台机器上**实测过的**预期，而不是让屏幕呆着不动。
 *  数字会随语料增长而变，所以同时给出「已等待」计时，让人自己判断是不是异常。 */
export function pendingLines(app, cols) {
  const waited = app.scanStartedAt ? app.now() - app.scanStartedAt : 0;
  const secs = Math.round(waited / 1000);
  const lines = [
    '',
    `  首次扫描进行中… 已等待 ${secs}s`,
    '',
    '  扫描全部 transcript 需要时间（本机 33 个会话约 26s，语料越多越久）。',
    '  这不是卡死——状态行每秒更新一次，`q` 可随时退出。',
    '',
    '  不想等的话，用一次性快照：',
    '    node scripts/scan-sessions.mjs --days 3',
  ];
  return lines.map((l) => truncateToWidth(l, cols));
}

/**
 * 一条会话都没有时，主屏该说什么。
 *
 * **这是一条「诚实」要求，不是一个 UI 偏好。**
 * 旧实现在这里印「（当前窗口内没有会话）」，而状态行把它压成
 * `0 会话 · 无异常`——「真的没有会话」和「扫到 2 个但一个都没认出来」
 * 显示成同一个词。一个监控工具把「我没有数据」和「一切正常」说成一样，
 * 用户就永远无法信任它。
 *
 * **四种空/坏态必须互相区分**（规划 §2.6 末尾那张表）：
 *   首扫中            → `pendingLines`（已做好，本函数不负责）
 *   扫完，确实没事    → 本函数第一支：检查表 + 数据多新 + 监视在不在跑
 *   扫完，但什么都没认出来 → 本函数第二支：显式说「全落空」
 *   扫描失败          → 本函数第三支（`warning`）
 *
 * 并且：**不得使用「无异常」「一切正常」这类断言词。** 断言要能被推翻，
 * 措辞就必须能被推翻。
 *
 * @param {object} app 需要 data / lastSuccessAt / days / now() / warning()
 * @param {number} cols
 * @returns {string[]}
 */
export function emptyLines(app, cols) {
  const stats = app?.data?.stats ?? null;
  const seen = Number.isFinite(stats?.transcriptsSeen) ? stats.transcriptsSeen : null;
  const fresh = app?.lastSuccessAt ? `数据来自 ${fmtSpan((app.now() - app.lastSuccessAt) / 1000)}前` : '数据时间未知';
  const window = windowLabelOf(app?.days ?? 3);
  const lines = [];

  // 第三支：扫描失败。保留原因，不假装知道。
  if (app?.warning && !app?.data) {
    lines.push(`⚠ 扫描失败：${app.warning}`);
    lines.push(`  ${window} · ${fresh}`);
    return lines.map((l) => truncateToWidth(l, cols));
  }

  if (seen === null) {
    // 扫描完成但没带 stats：不能假装「一切正常」，只能说不知道。
    lines.push('（扫描完成，但没有覆盖度统计 —— 无法确认是「没有会话」还是「扫描没看清」）');
    lines.push(`  ${window} · ${fresh}`);
    return lines.map((l) => truncateToWidth(l, cols));
  }

  const inWin = stats.transcriptsInWindow ?? 0;
  const outWin = stats.transcriptsOutsideWindow ?? 0;
  const unk = stats.transcriptsUnknownTime ?? 0;
  const jobs = stats.jobsSeen ?? 0;

  if (seen === 0 && jobs === 0) {
    // 真空：确实一个 transcript 都没看到。这是唯一可以称「没有需要你处理的会话」的情况，
    // 而且**后面必须紧跟检查表**（由 composeListScreen 的 L1 提供）。
    // 措辞遵守规划 §2.6：只陈述可核对的事实，不下判词（不写「无异常」「一切正常」）。
    lines.push('没有需要你处理的会话：扫描确认过，一个 transcript 都没有');
  } else {
    // 扫到了东西但行数为 0 —— 监控没认出来，这是「坏了」，不是「没事」。
    lines.push(`⚠ 一个会话都没识别出来 —— 检查过 ${seen} 个 transcript、${jobs} 个 job，全部落空`);
    if (outWin > 0) lines.push(`  ${outWin} 个在窗口外（${window}）`);
    if (unk > 0) lines.push(`  ${unk} 个内部没有时间戳，无法判定`);
  }
  // 「没事」要能自证：检查了什么、数据多新。
  lines.push(`  检查了 ${seen} 个 transcript · ${jobs} 个 job · ${window} · ${fresh}`);
  return lines.map((l) => truncateToWidth(l, cols));
}

/**
 * 状态行（整屏最后一行）：**健康度，不是键位提示**（规划 §2.4 第 3 条）。
 *
 * 键位在 `?` 里。这一行的位置留给「你还该知道的一件事」——这里是监视是否在跑，
 * 它比任何一行会话都更该被看见（D3：空收件箱有两种成因，界面原来不区分）。
 */
function statusLine(app, cols) {
  const sessions = app.sessions();
  const counts = stateCounts(sessions);
  const refresh = app.refreshing
    ? '刷新中…'
    : (app.lastSuccessAt ? `刷新于 ${fmtAgo(app.now() - app.lastSuccessAt)}` : '尚未刷新');
  const parts = [`${sessions.length} 会话`];
  // **不能用「计数为空就显示『无异常』」这种写法。**
  // 那会把「0 个会话」和「2 个会话但一个都没认出来」压成同一个词。
  // 0 个会话时由「覆盖度」说话（见 emptyLines）；有会话但状态全不认识时，
  // 必须显式说「状态未识别」，不能反过来说「无异常」。
  if (counts) {
    parts.push(counts);
  } else if (sessions.length > 0) {
    parts.push('状态全部未识别');
  } else {
    const stats = app.data?.stats;
    parts.push(stats ? `扫描到 ${stats.transcriptsSeen ?? '?'} 个 transcript` : '无数据');
  }
  parts.push(refresh, `每 ${app.intervalSec}s 轮询`);
  let text = `[${parts.join(' · ')}]`;
  if (app.warning) text += ` ⚠ ${app.warning}`;
  if (app.notice) text += ` · ${app.notice}`;
  // 「窗口外还有 N 个」必须说出来。否则用户看到 26 行就以为「只有 26 个会话」，
  // 而实际上有 241 个 —— 这正是 Bug 4「有些会话永远看不见」的另一种形态：
  // 它们不在窗口内，而界面从没说过窗口存在。
  const outWin = Number(app.data?.stats?.transcriptsOutsideWindow);
  if (Number.isFinite(outWin) && outWin > 0) {
    text += ` · 另有 ${outWin} 个在窗口外（--all 查看全部）`;
  }
  return truncateToWidth(text, cols);
}

/**
 * 详情页（L5 首屏 + L6 高级区）。
 *
 * **首屏只放能改变动作的四块**：状态 / 身份 / 最近说 / 证据（规划 §2.4-C）。
 * `novelty` / `calls` / `liveness` / `hbThresholdSec` / `lastGapSec` / `tokens` 全部
 * 下沉到 `showInternals=true`（按 `i` 才出现）。理由：它们没有一个能改变用户下一步。
 *
 * 51 个子 agent 压成一行计数。**不逐条列出** —— 旧实现列 51 行「◇ 子 agent #N」，
 * 而每行都标注「该节点状态未暴露」，也就是 51 行全是「我不知道」（规划 §1.3）。
 *
 * @param {object} session
 * @param {number} cols
 * @param {boolean} useColor
 * @param {{internals?: boolean, claims?: Array, meta?: object, nowMs?: number}} [opts]
 *   `nowMs` 是老化判断的注入时钟（不传则只看行上的 idleSec）。
 */
export function detailLines(session, cols, useColor, opts = {}) {
  const st = stateOf(session);
  const c = (code, s) => (useColor ? code + s + RESET : s);
  // 标签列宽 12：`noveltyAll`（10 列）也要留出至少 1 格间隙，否则会画成 `noveltyAlln/a`。
  const label = (name) => name + ' '.repeat(Math.max(0, 12 - displayWidth(name)));
  const kv = (name, value) => truncateToWidth(`  ${label(name)}${value ?? '—'}`, cols);
  const labelLine = (name) => (useColor ? c(BOLD, name) : name);

  const out = [];
  // ── L5 首屏 ──
  const bin = binaryOf(session);
  const kindText = bin === 'running' ? '● 在跑' : bin === 'stopped' ? '○ 已停'
    : bin === 'waiting' ? '! 在等你' : bin === 'blocked' ? '! 受阻' : '× 失败';
  const when = Number.isFinite(session.idleSec) ? `${fmtSpan(session.idleSec)}前` : '未知';
  out.push(kv('状态', `${kindText} · 最后动静 ${when}`));

  const t = titleOf({ title: opts.meta?.title ?? session.name ?? null, path: opts.meta?.cwd || session.cwd || null, key: sessionKey(session) });
  // 身份的三个成分全部要净化：cwd / project / sessionId 都来自外部数据（transcript / 宿主文件），
  // 任一个含 OSC 52 就能让只读渲染器改写系统剪贴板。
  const whereRaw = sanitize(opts.meta?.cwd || session.cwd || '');
  // 只有真路径才 `shortPath()`。宿主 job 只有目录编码（`D--Projects-X`），
  // 那不是路径 —— 画成 `…/Projects/X` 会造出不存在的层级。
  const where = /[\\/]/.test(whereRaw) ? shortPath(whereRaw) : '';
  // 没有 cwd 时退到扫描行自带的 project（它要么是编码目录名，要么是宿主写下的名字），
  // **原样显示、不做任何路径还原**。它是「我们只知道这么多」的诚实形态。
  const dirLabel = where || sanitize(String(session.project || '')).slice(0, 40);
  const idPart = sanitize(String(session.sessionId || '')).slice(0, 8);
  // 标题本身就是从同一段字符串回退来的时候，不要把它印两遍（`X · X · id`）。
  const head = sanitize(t.text);
  const parts = [head];
  if (dirLabel && dirLabel !== head) parts.push(dirLabel);
  if (idPart && idPart !== head) parts.push(idPart);
  out.push(kv('身份', parts.join(' · ')));

  const last = opts.meta?.lastAssistant || '';
  if (last) {
    const body = truncateWithDisclosure(sanitize(last).replace(/\s+/g, ' '), Math.max(10, cols - 11)).text;
    out.push(kv('最近说', `「${body}」`));
  } else if (session.hasTranscript === false) {
    out.push(kv('最近说', '（该会话没有落盘 transcript —— 宿主还没写出内容）'));
  }

  // 证据：常驻「N 条 · d 看证据」，完整内容按 d 展开（裁决 R3）
  const claims = Array.isArray(opts.claims) ? opts.claims : [];
  if (claims.length) {
    const t2 = claimsTally(claims);
    const tier = t2.hard > 0 ? '有硬矛盾' : t2.soft > 0 ? '存疑' : '有证据支持';
    out.push(kv('证据', `${claims.length} 条完成声明 · ${tier}`));
    const first = claims.find((r) => (r.status || r.r?.status) === 'FAILED_ONLY' || (r.status || r.r?.status) === 'NO_EVIDENCE')
      || claims[0];
    const res = first.r || first;
    const quote = res?.claim?.quote ? sanitize(String(res.claim.quote)).replace(/\s+/g, ' ') : '';
    if (quote) out.push(kv('', `「${truncateWithDisclosure(quote, Math.max(10, cols - 12)).text}」`));
    out.push(truncateToWidth(`  ${' '.repeat(10)}d 看完整证据链`, cols));
  } else if (opts.claimsKnown) {
    out.push(kv('证据', '没有可核对的完成声明'));
  }

  // 老化说明：详情页必须说清「为什么它没出现在需动作区」和「为什么按 c 没东西」。
  // 不说的话，用户会以为界面上少了东西（而这个缺陷的另一半正是「显示错了」）。
  const age = staleOf(session, Number.isFinite(opts.nowMs) ? opts.nowMs : null);
  if (age.stale) {
    const limit = fmtSpan(age.limitSec);
    out.push('');
    out.push(labelLine('已超龄'));
    for (const l of wrapToWidth(
      `已 ${fmtSpan(age.ageSec)} 没有动静，超过 ${limit} 的老化上限，因此不再进「需动作」，`
      + `也不提供建议回复（那是很久之前猜的）。按 Enter 仍可看原文。`,
      Math.max(10, cols - 2))) out.push('  ' + l);
  }

  if (session.needs) {
    out.push('');
    out.push(labelLine('它在等'));
    for (const l of wrapToWidth(sanitize(session.needs), Math.max(10, cols - 2))) out.push('  ' + l);
  }
  if (session.suggestedReply) {
    out.push('');
    out.push(labelLine('宿主建议回复（逐字，不要改写）'));
    for (const l of wrapToWidth(sanitize(session.suggestedReply), Math.max(10, cols - 2))) out.push('  ' + l);
  }

  // ── L6 高级区：按 i 才展开 ──
  const total = session.subagentsTotal ?? session.subagents ?? 0;
  const shown = session.subagents ?? 0;
  out.push('');
  if (!opts.internals) {
    // 一行计数。**不逐条画**：51 行「我不知道」占了 51 行，而结论是零信息。
    const ratio = total ? `${shown}/${total}` : '0';
    out.push(truncateToWidth(`  派生 ${ratio} 个${total && !shown ? '（状态 scan 拿不到）' : ''}    `
      + `按 i 显示内部量`, cols));
  } else {
    if (session.source) out.push(kv('来源', sanitize(sourceLabel(session.source))));
    if (session.hasTranscript === false) out.push(kv('transcript', '（无 —— 该会话没有落盘 transcript）'));
    if (session.hostSessionId && session.hostSessionId !== session.sessionId) out.push(kv('宿主 id', sanitize(session.hostSessionId)));
    if (session.transcriptId && session.transcriptId !== session.sessionId) out.push(kv('transcriptId', sanitize(session.transcriptId)));
    out.push(kv('state', `${glyphOf(session)} ${st}`));
    out.push(kv('reason', sanitize(session.reason)));
    out.push(kv('liveness', sanitize(session.liveness ?? '—')));
    out.push(kv('hostState', sanitize(session.hostState ?? '—')));
    if (session.jobDetail) out.push(kv('jobDetail', sanitize(session.jobDetail)));
    out.push(kv('calls', session.calls));
    out.push(kv('novelty', fmtNovelty(session.novelty)));
    out.push(kv('noveltyAll', fmtNovelty(session.noveltyAll)));
    out.push(kv('lastActivity', session.lastActivity));
    if (session.hbThresholdSec !== null && session.hbThresholdSec !== undefined) {
      out.push(kv('心跳', `末次 ${session.lastGapSec ?? 'n/a'}s / 阈值 ${session.hbThresholdSec}s`));
    }
    if (session.tokens !== null && session.tokens !== undefined) out.push(kv('tokens', String(session.tokens)));
    if (session.badLines > 0) out.push(kv('badLines', String(session.badLines)));
    out.push(truncateToWidth(`  派生 ${shown}/${total} · 层深 ${session.maxDepth ?? 0} · 节点状态 scan 未暴露`, cols));
    if (shown > 0) {
      // 展开时**可数披露**：只画前 3 个，剩下的说清楚有多少
      const head = Math.min(3, shown);
      for (let i = 1; i <= head; i++) out.push(truncateToWidth(`  │ ◇ 子 agent #${i}`, cols));
      if (shown > head) out.push(truncateToWidth(`  │ … 另 ${shown - head} 个未展开（共 ${shown}）`, cols));
    }
  }
  return out;
}

function helpPanel(cols, rows, useColor) {
  const width = Math.max(30, Math.min(cols - 4, 84));
  const inner = width - 4;
  const c = (code, s) => (useColor ? code + s + RESET : s);
  const wide = inner >= 52;
  const raw = [
    ['t', 'OmniSight · 帮助'],
    ['', ''],
    ['h', '键位'],
    ['k', '  j / ↓  下一行        k / ↑  上一行'],
    ['k', '  Enter  查看详情      Esc    返回'],
    ['k', '  c      复制接力草稿  r      立即刷新'],
    ['k', '  h      展开/收起已停  d      看证据'],
    ['k', '  i      显示内部量    ?      帮助'],
    ['k', '  g / G  首行 / 末行    q      退出'],
    ['', ''],
    ['h', '这一屏回答什么'],
    ['k', '  第 1 行是判决：「几件在等你」，不是「几个会话」。'],
    ['k', '  检查表四行是四道独立数据源——少一行，「没事」就少一个佐证：'],
    ['k', '    等你回应  ← 宿主事实态 × 收件箱（watch 的历史通知表）'],
    ['k', '    问了没答  ← transcript 末条是问句，且之后没人说话'],
    ['k', '    声明对不上 ← verify-claims 的断言与证据比对'],
    ['k', '    后台监视  ← watch 的 healthCheck：它没在跑，「空」就不可信'],
    ['', ''],
    ['h', '列表页只说两个词'],
    ['k', '  在跑 / 已停。六态是判定细节，不驱动任何动作——'],
    ['k', '  PRODUCING 与 EXPLORING 的处置都是「不干预」。'],
    ['k', '  需要你处理的只有三类：在等你 / 受阻 / 失败，它们全在「需动作」段。'],
    ['', ''],
    ['f', '按任意键关闭'],
  ];

  const innerLines = [];
  for (const [kind, text] of raw) {
    let source = text;
    if (!wide) {
      // 窄终端：把双列表格拆成单列，避免在列中间折行
      if (kind === 'k' && /^\s{2}\S.*\s{2}\S/.test(text) && !/^\s{2}[▲✕◐●○]/.test(text)) {
        const parts = text.trim().split(/\s{2,}/);
        for (const p of parts) innerLines.push('  ' + p);
        continue;
      }
    }
    const wrapped = wrapToWidth(source, inner);
    for (let i = 0; i < wrapped.length; i++) {
      let line = wrapped[i];
      if (kind === 't' && i === 0) line = c(BOLD, line);
      if (kind === 'h' && i === 0) line = c(BOLD, line);
      if (kind === 'f' && i === 0) line = c(DIM, line);
      innerLines.push(line);
    }
  }

  const panelWidth = width;
  const panelHeight = Math.max(4, Math.min(rows - 2, innerLines.length + 2));
  const capacity = panelHeight - 2;
  let visible = innerLines;
  if (innerLines.length > capacity) {
    // 高度不够时保留首部上下文与末尾的关闭提示
    visible = innerLines.slice(0, Math.max(0, capacity - 1)).concat(innerLines[innerLines.length - 1]);
  }
  const lines = [topBorder('帮助', panelWidth)];
  for (const l of visible) {
    lines.push('│ ' + fitWidth(l, inner) + ' │');
  }
  lines.push(bottomBorder(panelWidth));
  const pad = ' '.repeat(Math.max(0, Math.floor((cols - panelWidth) / 2)));
  return lines.map((l) => pad + l);
}

/** 画边框时必须按显示宽度补横线，不能按字符数。 */
function borderLine(left, title, right, width) {
  const fixed = displayWidth(left) + displayWidth(title) + displayWidth(right);
  const fill = '─'.repeat(Math.max(0, width - fixed));
  return left + title + fill + right;
}

function topBorder(title, width) {
  return borderLine('┌─', ` ${title} `, '┐', width);
}

function bottomBorder(width) {
  return borderLine('└', '', '┘', width);
}

// ── 应用 ──────────────────────────────────────────────────────────────

/** 把一条 live 会话（sessions/*.json，无 transcript）转成列表行。
 *
 *  只用于 WAITING / BLOCKED / FAILED —— 这三种状态不依赖 transcript 就能说清
 *  「它在等你」/「它受阻」/「它失败了」，而且是唯一需要人立刻行动的三类。
 *  其余状态没有 transcript 就没有信息（calls / novelty 全空），补进来只是噪音。 */
export function statusToState(live) {
  if (!live) return null;
  if (live.status === 'waiting') return 'WAITING';
  if (live.status === 'failed') return 'FAILED';
  if (live.status === 'blocked') return 'BLOCKED';
  return null;
}

export function liveToRow(live, nowMs = Date.now()) {
  const st = statusToState(live);
  const updated = Number(live.statusUpdatedAt ?? 0);
  const idleSec = Number.isFinite(updated) && updated > 0 ? Math.round((nowMs - updated) / 1000) : null;
  // 路径来自宿主文件，可能含控制字符（实测一个手写的 cwd 里反斜杠+t 被写成了制表符）。
  // 控制字符进终端会破坏渲染，替换成空格而不是删除——保持列对齐。
  const CTRL = new RegExp('[' + String.fromCharCode(1) + '-' + String.fromCharCode(31) + ']', 'g');
  const base = live.cwd ? String(live.cwd) : (live.name || '');
  // **D1：只切 `/` 不切 `\` 会让 Windows 上的项目名变成整条路径。**
  // 实测 `D:\\…\\testharness` → project 为完整路径（最该被看见的那几类
  // WAITING/BLOCKED/FAILED 恰好走这条路）。两个分隔符都要切。
  const where = base.split(/[\\/]/).filter(Boolean).pop().replace(CTRL, ' ') || null;
  return {
    project: where || null,
    sessionId: live.sessionId,
    // **保存原始 cwd**：列表页要显示 `…/尾两段`，详情页要显示完整路径。
    // 只有 basename 的话，同名目录（实测 5 行同名）就无法去歧义（规划 P4）。
    cwd: live.cwd ? String(live.cwd) : null,
    name: live.name ?? null,
    // 没有 transcript 就没有这些数字 —— 显式给 null，不要假装是 0。
    lastActivity: Number.isFinite(updated) && updated > 0 ? new Date(updated).toISOString() : null,
    idleSec,
    calls: null,
    subagents: null,
    subagentsTotal: null,
    subagentsTruncated: false,
    subagentsComplete: true,
    maxDepth: 0,
    novelty: null,
    noveltyAll: null,
    hbThresholdSec: null,
    lastGapSec: null,
    state: st,
    reason: live.status === 'waiting'
      ? (live.waitingFor ? `waiting:${live.waitingFor}` : 'host-reported-waiting')
      : `host-reported-${live.status}`,
    liveness: 'live',
    hostState: live.status,
    jobDetail: null,
    tokens: null,
    needs: live.needs ?? null,
    suggestedReply: live.suggestedReply ?? null,
    // 标记来源：列表里能看出「这条是从宿主实时状态补的，不是扫描出来的」
    source: 'live',
    // 没有 transcript 就没有调用记录：显式 false，让详情页能说清为什么 calls 是 null
    hasTranscript: false,
  };
}

/**
 * 会话的稳定身份。
 *
 * 为什么不能只用 sessionId：同一个会话在不同数据源里的 id 可能不同
 * （实测 job a9fa4c62 的 transcript 是 af6779f8）。光标要跟着「同一个会话」走，
 * 就得让这条 row 拿到一个不随数据源变化的键。
 *
 * 优先级：sessionId > hostSessionId > transcriptId > project。
 * 退化到最后一项是必要的：一条连 id 都没有的 row 也必须能被选中。
 *
 * @param {object} session
 * @returns {string|null}
 */
export function sessionKey(session) {
  if (!session) return null;
  for (const k of ['sessionId', 'hostSessionId', 'transcriptId']) {
    if (session[k]) return String(session[k]);
  }
  return session.project ? String(session.project) : null;
}

/** 一条 row 在去重时需要认的全部身份。合并多源时任一命中即视为同一条。 */
function rowIdentities(session) {
  const out = new Set();
  if (!session) return out;
  for (const k of ['sessionId', 'hostSessionId', 'transcriptId']) {
    if (session[k]) out.add(String(session[k]));
  }
  return out;
}

/** 合并「扫描出的会话」与「只有 live 没有 transcript 的会话」。
 *
 *  **两条展示路径（交互 App 与纯文本快照）必须用同一个函数。**
 *  2026-11-01：我先只改了 `App.sessions()`，纯文本路径仍然直接读 `data.sessions`，
 *  于是同一个 waiting 会话在交互界面出现了、在 `| head` 输出里还是看不见。
 *  这是我第三次在「改了契约却漏掉另一个调用点」上栽跟头（前两次见 DF-012、DF-017）。
 *  所以这次把它抽出来，两边都只能调它。
 *
 *  **2026-11-05 修：去重不能只比 sessionId。** 宿主 job 的 sessionId 与它指向的
 *  transcript 文件名可以不同（a9fa4c62 vs af6779f8），只比 sessionId 会让同一个
 *  会话以两条身份各出现一次。现在按 sessionId / hostSessionId / transcriptId
 *  三个身份求并集。 */
export function mergeLiveSessions(data, nowMs = Date.now()) {
  const scanned = data?.sessions ?? [];
  const live = data?.live ?? [];
  // **正在等你这件事，恰恰常常发生在会话还没写多少 transcript 的时候。**
  // 主界面看不见它，等于这个功能的主入口是瞎的。
  const have = new Set();
  for (const s of scanned) for (const id of rowIdentities(s)) have.add(id);
  const extra = [];
  for (const l of live) {
    if (!l || !l.sessionId) continue;
    if (have.has(l.sessionId)) continue;
    if (!statusToState(l)) continue;   // 只补 WAITING / BLOCKED / FAILED
    extra.push(liveToRow(l, nowMs));
    have.add(l.sessionId);
  }
  return extra.length ? [...scanned, ...extra] : scanned;
}

export class App {
  constructor({ stdout, stdin, env, days, intervalSec, scan, useColor, claimsScanner = null }) {
    this.stdout = stdout;
    this.stdin = stdin;
    this.env = env;
    this.days = days;
    this.intervalSec = intervalSec;
    this.scan = scan;
    this.useColor = useColor;
    /** 证据扫描器（`verify-claims` 的进程内等价物）。null = 不算证据，检查表显示「—」。 */
    this.claimsScanner = claimsScanner;

    this.data = null;
    this.warning = null;
    this.refreshing = false;
    this.lastSuccessAt = null;
    /** 收件箱：watch 的 state.notified × 当前宿主现状的交集。null = 读不到（不猜）。 */
    this.inbox = [];
    /** healthCheck 结果。null = 读不到状态文件。**空状态的可信度取决于它**。 */
    this.health = null;
    /** verify-claims 的结果缓存。null = 还没算。见 refreshClaims。 */
    this.claims = null;
    /** 已停段是否展开（`h`）。裁决 R1：默认折叠成一行计数。 */
    this.stoppedExpanded = false;
    /** 详情页是否显示内部量（`i`）。裁决：novelty / calls / liveness 下沉到这里。 */
    this.showInternals = false;
    this.metaCache = createMetaCache();
    this.projectsDir = projectsRoot(env && env);
    this._sections = null;
    this._sectionsKey = undefined;
    // 光标身份：sessionId（不是下标）。见 selectPos 的注释。
    this.selectedId = null;
    // 兜底位置：光标指向的会话消失时用它，避免跳回顶部
    this.selectedPos = 0;
    this.listOffset = 0;
    this.mode = 'list';
    this.prevMode = 'list';
    this.detailScroll = 0;
    this.draft = null;
    this.draftInfo = '';
    this.notice = '';
    this.noticeUntil = 0;
    this.closed = false;
    this._tick = null;
    this._next = null;
    this.scanStartedAt = null;
    this._onData = null;
    this._onResize = null;
    this._resolve = null;
    this._pending = '';
    this._escTimer = null;
    this.done = new Promise((r) => { this._resolve = r; });
  }

  now() { return Date.now(); }

  sessions() { return mergeLiveSessions(this.data, this.now()); }

  /**
   * 主屏的行序（扁平）：需动作 → 在跑 → 已停（展开时）。
   *
   * **两个调用方（渲染与光标）必须用同一个序。** 旧实现把「渲染顺序」和
   * 「光标下标所指数组」分开算，于是排序一变就错位 —— 那是 Bug3 的一半。
   */
  sortedSessions() {
    return this.flatList().map((v) => this.rowOfView(v)).filter(Boolean);
  }

  /** 一条行对象的身份键。视图对象用 `key`，原始扫描行用 `sessionKey()`。 */
  keyOf(item) {
    if (!item) return null;
    if (typeof item.key === 'string') return item.key;
    return sessionKey(item);
  }

  /**
   * 光标当前停在**哪个会话**（按身份查），以及它此刻在列表里的下标。
   *
   * **为什么不能把下标当光标：排序在每次刷新时都会变。**
   * 旧实现把 `this.selected` 当数组下标。列表按 state 再按 idle 降序排，
   * 而 idle 每轮都在涨、state 也会翻转，所以**同一下标指向的会话会变**。
   * 2026-11-05 实测（8 秒轮询）：光标停在第 0 行，一次刷新后排序从 [b,a] 变 [a,b]，
   * 此时按 `c` 复制到的就是另一个会话的接力草稿——**复制错人的话**。
   *
   * 现在光标存的是 sessionKey（见 sessionKey），渲染时按 ID 反查位置。
   * 找不到（会话从数据里消失）时钳到合法范围，而不是回到 0——回到 0 会让
   * 用户以为自己按错了键。
   */
  selectPos(sessions = this.sortedSessions()) {
    if (!sessions.length) { this.listOffset = 0; return 0; }
    if (this.selectedId !== null) {
      const idx = sessions.findIndex((s) => this.keyOf(s) === this.selectedId);
      if (idx >= 0) return idx;
      // 会话已经不在数据里了。**不能沿用原下标**——那个位置上现在是另一个人，
      // 按 c 就会复制到别人的草稿，正是这个 bug 本身。
      // 也不能跳回顶部（用户会以为自己按错了键）。
      //
      // 做法：钳到末尾，并**立刻把身份重新锚定到那一行**。
      // 「高亮行」和「复制对象」必须永远是同一个人，这是唯一的硬要求；
      // 锚定之后下一次移动/复制都在新身份上继续，不会带着旧 ID 漂移。
      const clamped = Math.min(Math.max(0, this.selectedPos ?? 0), sessions.length - 1);
      this.selectedPos = clamped;
      this.selectedId = this.keyOf(sessions[clamped]) ?? null;
      return clamped;
    }
    const clamped = Math.min(Math.max(0, this.selectedPos ?? 0), sessions.length - 1);
    return clamped;
  }

  /** 把光标移到某个下标（内部实现，调用方只管「第几行」）。 */
  setPos(pos, sessions = this.sortedSessions()) {
    if (!sessions.length) { this.selectedId = null; this.selectedPos = 0; return; }
    const p = Math.min(Math.max(0, pos), sessions.length - 1);
    this.selectedPos = p;
    this.selectedId = this.keyOf(sessions[p]) ?? null;
  }

  /** 光标当前所在的会话（按 ID 反查）。没有任何会话时为 null。
   *
   *  @param {Array} [list] 扁平行序。不传则用 `flatList()`。
   *    **必须与渲染用的是同一个序**，否则「高亮的那一行」与「会被操作的那一行」会错位
   *    （这正是 Bug3 的形态）。
   */
  currentSession(list = this.flatList()) {
    if (!list || !list.length) return null;
    return this.rowOfView(list[this.selectPos(list)]) ?? null;
  }

  /** 兼容旧调用点与测试：外部读到的「第几行」。写它等于移动光标。 */
  get selected() {
    return this.selectPos();
  }

  set selected(pos) {
    this.setPos(Number(pos) || 0);
  }

  width() {
    return Math.max(30, this.stdout.columns || 100);
  }

  height() {
    return Math.max(8, this.stdout.rows || 30);
  }

  start() {
    this.stdout.write('\x1b[?1049h\x1b[?25l');
    if (this.stdin.isTTY && typeof this.stdin.setRawMode === 'function') {
      try { this.stdin.setRawMode(true); } catch { /* 部分环境不支持 */ }
    }
    this.stdin.setEncoding('utf8');
    this.stdin.resume();

    this._onData = (chunk) => this.onChunk(chunk);
    this.stdin.on('data', this._onData);
    this._onResize = () => this.render();
    if (typeof this.stdout.on === 'function') this.stdout.on('resize', this._onResize);

    this._tick = setInterval(() => {
      if (this.closed) return;
      if (this.notice && this.now() > this.noticeUntil) this.notice = '';
      this.render();
    }, 1000);

    this.render();
    this.refresh();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._tick) clearInterval(this._tick);
    if (this._next) clearTimeout(this._next);
    if (this._escTimer) clearTimeout(this._escTimer);
    // 杀掉还在跑的扫描子进程：否则终端已恢复，进程却要等扫描结束才退出
    if (this._cancelScan) { try { this._cancelScan(); } catch { /* 已结束 */ } }
    if (this._onData) this.stdin.removeListener('data', this._onData);
    if (this._onResize && typeof this.stdout.removeListener === 'function') {
      this.stdout.removeListener('resize', this._onResize);
    }
    try {
      if (this.stdin.isTTY && typeof this.stdin.setRawMode === 'function') this.stdin.setRawMode(false);
      this.stdin.pause();
    } catch { /* 退出路径不抛错 */ }
    this.stdout.write('\x1b[?25h\x1b[?1049l');
    this._resolve();
  }

  scheduleNext() {
    if (this.closed) return;
    if (this._next) clearTimeout(this._next);
    this._next = setTimeout(() => this.refresh(), this.intervalSec * 1000);
  }

  async refresh() {
    if (this.closed || this.refreshing) return;
    if (this._next) { clearTimeout(this._next); this._next = null; }
    this.refreshing = true;
    if (!this.scanStartedAt) this.scanStartedAt = this.now();
    this.render();

    // 宿主侧的两个便宜读取（~12ms）：收件箱与监视健康度。
    // **它们和 scan 并行**，不占扫描的 26 秒。
    this.readHostFacts();

    const job = this.scan({ days: this.days });
    this._cancelScan = job.cancel ?? null;
    const { data, warning, cancelled } = await job.promise;
    this._cancelScan = null;
    if (this.closed || cancelled) return;
    this.refreshing = false;
    if (data) {
      this.data = data;
      this.lastSuccessAt = this.now();
      this.warning = null;
      this._sections = null;
      this._sectionsKey = undefined;
      // 刷新后行序可能变了，但光标按 ID 跟着原会话走；新数据第一次到达时
      // 把光标钉到第一行（否则首次刷新后光标是「空」的）。
      const list = this.flatList();
      if (this.selectedId === null && list.length) this.setPos(0, list);
      else this.selectPos(list);
    } else {
      this.warning = warning || '扫描失败';
    }
    this.scheduleNext();
    this.render();
    // 证据不在轮询里算：实测 7.2s，放进去会把 8 秒间隔吃满（规划 §七）。
    // 每 60 秒最多算一次，且失败不覆盖上一次的结论。
    this.refreshClaims();
  }

  /**
   * 读宿主侧两个便宜的事实：收件箱 + 监视健康度。
   *
   * **两个都必须"读不到就说读不到"**（`null`），不能退化成「空」/「健康」：
   *   - 收件箱读不到 → 不补任何行，但检查表的「等你回应」仍由 scan 的宿主事实态兜底；
   *   - 健康度读不到 → 检查表「后台监视」打 `?`，不写 ✓。
   * 这正是 §2.6 第三种状态（扫完但监视没跑）与第一种（扫完确实没事）的分界。
   */
  readHostFacts(env = process.env) {
    try {
      const dir = defaultStateDir(env);
      const { state } = loadState(dir, { nowMs: this.now() });
      this.health = healthCheck(state, { nowMs: this.now() });
      this.inbox = buildInbox(state, {
        nowMs: this.now(),
        live: this.data?.live ?? [],
      });
    } catch {
      // 状态目录不存在 / 读不动：不猜。
      this.health = null;
      this.inbox = [];
    }
  }

  /** verify-claims 的结果（低频：≥60s）。失败时保留上一次结论并标 `error`。 */
  async refreshClaims({ minIntervalMs = 60_000, force = false } = {}) {
    if (!this.claimsScanner) return;
    const now = this.now();
    if (!force && this._claimsAt && now - this._claimsAt < minIntervalMs) return;
    if (this._claimsPending) return;
    this._claimsPending = true;
    this._claimsAt = now;
    try {
      // claimsScanner 返回 { promise }（与 defaultScan 同形），也可以直接返回 Promise。
      const jobOrPromise = this.claimsScanner({ days: this.days });
      const res = jobOrPromise && typeof jobOrPromise.then === 'function'
        ? await jobOrPromise
        : await (jobOrPromise && jobOrPromise.promise);
      if (this.closed) return;
      if (res && Array.isArray(res.results)) this.claims = { results: res.results, at: now };
      else if (res && res.error) this.claims = { error: res.error, at: now };
    } catch (e) {
      if (this.closed) return;
      this.claims = { error: String(e && e.message || e), at: now };
    } finally {
      this._claimsPending = false;
      this.render();
    }
  }

  showNotice(text) {
    this.notice = text;
    this.noticeUntil = this.now() + NOTICE_MS;
    this.render();
  }

  onChunk(chunk) {
    const { keys, rest } = parseKeysWithRest(this._pending + chunk);
    this._pending = rest;
    if (this._escTimer) { clearTimeout(this._escTimer); this._escTimer = null; }
    if (rest) {
      // 单独的 Esc 与序列开头无法区分：等一小段时间再决定
      this._escTimer = setTimeout(() => {
        this._escTimer = null;
        if (this._pending) { this._pending = ''; this.onKey('escape'); }
      }, 60);
    }
    for (const key of keys) {
      if (this.closed) return;
      this.onKey(key);
    }
  }

  onKey(key) {
    if (key === 'ctrl-c') { this.close(); return; }

    // 覆盖式面板（帮助 / 草稿 / 证据）：q 退出，其余任意键关闭面板回到原视图
    if (this.mode === 'help' || this.mode === 'draft' || this.mode === 'evidence') {
      if (key === 'q') { this.close(); return; }
      this.mode = this.prevMode === 'detail' ? 'detail' : 'list';
      this.detailInternal = false;
      this.render();
      return;
    }

    if (this.mode === 'list') {
      if (key === 'q') { this.close(); return; }
      if (key === '?') { this.prevMode = 'list'; this.mode = 'help'; this.render(); return; }
      if (key === 'j' || key === 'down') { this.move(1); return; }
      if (key === 'k' || key === 'up') { this.move(-1); return; }
      if (key === 'g' || key === 'home') { this.setPos(0); this.render(); return; }
      if (key === 'G' || key === 'end') { this.setPos(this.flatList().length - 1); this.render(); return; }
      if (key === 'enter') { this.openDetail(); return; }
      if (key === 'h') { this.stoppedExpanded = !this.stoppedExpanded; this._sections = null; this.render(); return; }
      if (key === 'd') { this.openEvidence(); return; }
      if (key === 'r') { this.refresh(); this.refreshClaims({ force: true }); return; }
      if (key === 'c') { this.copyDraft(); return; }
      return;
    }

    if (this.mode === 'detail') {
      if (key === 'q') { this.close(); return; }
      if (key === 'escape') { this.mode = 'list'; this.detailScroll = 0; this.showInternals = false; this.render(); return; }
      if (key === '?') { this.prevMode = 'detail'; this.mode = 'help'; this.render(); return; }
      if (key === 'i') { this.showInternals = !this.showInternals; this.render(); return; }
      if (key === 'd') { this.openEvidence(); return; }
      if (key === 'j' || key === 'down') { this.detailScroll += 1; this.render(); return; }
      if (key === 'k' || key === 'up') { this.detailScroll = Math.max(0, this.detailScroll - 1); this.render(); return; }
      if (key === 'pgdown') { this.detailScroll += 10; this.render(); return; }
      if (key === 'pgup') { this.detailScroll = Math.max(0, this.detailScroll - 10); this.render(); return; }
      if (key === 'r') { this.refresh(); return; }
      if (key === 'c') { this.copyDraft(); return; }
    }
  }

  move(delta) {
    const list = this.flatList();
    if (!list.length) return;
    // 按 ID 反查当前位置，再移动——下标不能跨刷新复用（见 selectPos）
    this.setPos(this.selectPos(list) + delta, list);
    this.render();
  }

  openDetail() {
    if (!this.flatList().length) return;
    this.mode = 'detail';
    this.detailScroll = 0;
    this.showInternals = false;
    this.render();
  }

  /** 证据面板（`d`）。裁决 R3：完整内容按需展开，复用 verify-claims 的渲染。 */
  openEvidence() {
    const sessions = this.claims?.results;
    if (!sessions || !sessions.length) {
      this.showNotice(this.claims?.error
        ? `证据还没算出来：${this.claims.error}`
        : '证据还在算（verify-claims 约 7 秒），稍后再按 d');
      return;
    }
    this.prevMode = this.mode === 'detail' ? 'detail' : 'list';
    this.mode = 'evidence';
    this.evidenceScroll = 0;
    this.render();
  }

  async copyDraft() {
    const session = this.currentSession();
    if (!session) return;
    // 时钟注入：老化判断必须与这一帧的其他时间计算用同一个 now，
    // 不能在 buildDraft 里再读一次挂钟（那会让「界面说没超龄、复制说超龄」）。
    const nowMs = this.now();
    const hint = draftHintOf(session, { nowMs });
    const draft = buildDraft(session, { nowMs });
    if (!draft) {
      // 说清**为什么**没有草稿。以前一律说「没有 needs / suggestedReply」，
      // 而超龄是另一个原因，混在一起会让人以为数据缺失。
      this.showNotice(hint.reason ? `无草稿可复制：${hint.reason}` : '该会话没有 needs / suggestedReply，无草稿可复制');
      return;
    }
    const ok = await copyToClipboard(draft, this.env.platform ?? process.platform);
    if (this.closed) return;
    if (ok) {
      this.showNotice('已复制到剪贴板');
    } else {
      this.draft = draft;
      this.draftInfo = '复制失败，请手动选择';
      this.prevMode = this.mode;
      this.mode = 'draft';
      this.render();
    }
  }

  render() {
    if (this.closed) return;
    const lines = this.buildFrame();
    const width = this.width();
    const height = this.height();
    const out = [];
    for (let i = 0; i < height; i++) out.push(fitLine(lines[i] ?? '', width));
    this.stdout.write('\x1b[H' + out.join('\x1b[K\r\n') + '\x1b[K\x1b[J');
  }

  buildFrame() {
    if (this.mode === 'help') return helpPanel(this.width(), this.height(), this.useColor);
    if (this.mode === 'draft') return this.buildDraftPanel();
    if (this.mode === 'evidence') return this.buildEvidenceFrame();
    if (this.mode === 'detail') return this.buildDetailFrame();
    return this.buildListFrame();
  }

  /**
   * 主屏（列表页）。**整屏由 `tui-layout.mjs` 的 `composeListScreen` 组装**，
   * 本方法只负责取数：三种空/坏态与四段内容的边界都在这里决定。
   *
   * 排序 = 段顺序（需动作 → 在跑 → 已停），段内各自按「等得最久 / 最近有动静」。
   * 光标按身份跨段移动，所以这里先拼出一条**扁平的行序**再算窗口。
   */
  buildListFrame() {
    const cols = this.width();
    const rows = this.height();
    const layout = resolveLayout({ cols, rows });
    const sections = this.sections();
    const flat = this.flatList(sections);
    const cursor = this.selectPos(flat);
    const win = windowOf({ count: flat.length, cursor, area: Math.max(1, rows - 10), offset: this.listOffset });
    this.listOffset = win.offset;

    let body = null;
    if (!this.data) {
      body = this.warning
        ? [truncateToWidth(`⚠ 扫描失败：${this.warning}`, cols)]
        : pendingLines(this, cols);
    } else if (!flat.length) {
      body = emptyLines(this, cols);
    }

    // 四态之一：**扫完但监视没跑** → 「修监视」进第一屏（§2.6 表格第三行）。
    // 它作为判决行之后的独立提示行出现，**不替换**会话列表 ——
    // 把列表藏起来等于用「修监视」掩盖了「有会话在跑」这个同样真实的事实。
    const healthBad = this.health && this.health.healthy === false;
    const alert = healthBad && this.data
      ? [
        truncateToWidth(' ⚠ 后台监视未在运行 —— 「0 件在等你」这件事不可信', cols),
        truncateToWidth('   先修：node scripts/install-watcher.mjs install', cols),
      ]
      : null;

    const claims = this.claimsInfo();
    const checklist = checklistRows({
      inboxCount: sections.action.length,
      askedCount: askedCountOf(sections),
      claims,
      health: this.health,
      wide: layout.showCheckSource !== false,
    });

    const windowOfSection = (arr, shared) => {
      const from = Math.max(0, shared.offset);
      return arr.slice(from, Math.min(arr.length, shared.end));
    };

    const lines = composeListScreen({
      cols,
      rows,
      layout,
      verdict: verdictParts({
        actionCount: sections.action.length,
        runningCount: sections.running.length,
        stoppedCount: sections.stopped.length,
      }),
      scanAge: this.refreshing && !this.lastSuccessAt ? '首次扫描中…' : scanAgeText(this.lastSuccessAt, this.now()),
      checklist,
      action: body ? [] : windowOfSection(sections.action, win),
      running: body ? [] : windowOfSection(sections.running, win),
      stopped: body ? [] : sections.stopped,
      stoppedExpanded: this.stoppedExpanded,
      footer: this.footerLineParts(),
      cursorKey: sessionKey(this.currentSession(flat)),
      useColor: this.useColor,
      // 老化判断的时钟。整帧只取一次 now，与 sections() 用的是同一个值，
      // 否则会出现「这一帧说还年轻、下一帧说超龄」的抖动。
      nowMs: this.now(),
      body,
      alert,
    });
    return lines;
  }

  /** 主屏最后一行：健康度，不是键位提示。 */
  footerLineParts() {
    const c = this.claimsInfo();
    const parts = footerParts({
      hard: c.hard || 0,
      soft: c.soft || 0,
      scanAgeMs: this.lastSuccessAt ? this.now() - this.lastSuccessAt : null,
      health: this.health,
      refreshing: this.refreshing,
    });
    if (this.notice) parts.push(this.notice);
    if (this.warning) parts.push(`⚠ ${this.warning}`);
    const outWin = Number(this.data?.stats?.transcriptsOutsideWindow);
    if (Number.isFinite(outWin) && outWin > 0) parts.push(`另有 ${outWin} 个在窗口外（--all）`);
    if (this.data) parts.push(windowLabelOf(this.days));
    parts.push('? 帮助');
    return parts;
  }

  /** 证据档位。三种非绿状态必须互相区分（算着 / 算失败 / 有结果）。 */
  claimsInfo() {
    if (!this.claims) return { pending: true };
    if (this.claims.error) return { error: true };
    return claimsTally(this.claims.results);
  }

  /** 扁平行序：需动作 → 在跑 → 已停（只在展开时）。光标在**这个序**里移动。 */
  flatList(sections = this.sections()) {
    const s = sections || { action: [], running: [], stopped: [] };
    return [...s.action, ...s.running, ...(this.stoppedExpanded ? s.stopped : [])];
  }

  /** 三段视图。**带缓存**：一帧里被调用多次，每次都读 26 条 transcript 会把 8 秒轮询吃满。 */
  sections() {
    const key = this.data;
    if (this._sectionsKey === key && this._sections) return this._sections;
    const sections = buildSections({
      data: this.data,
      inbox: this.inbox,
      metaOf: (r) => this.metaFor(r),
      nowMs: this.now(),
    });
    this._sectionsKey = key;
    this._sections = sections;
    return sections;
  }

  /** 一条扫描行的标题 / 末条 assistant。读不到就返回 null，不猜。 */
  metaFor(row) {
    if (!row) return null;
    const file = transcriptPathFor(row, this.projectsDir);
    if (!file) return null;
    const mtimeMs = Number.isFinite(Date.parse(row.lastActivity || '')) ? Date.parse(row.lastActivity) : null;
    return this.metaCache.get(file, { mtimeMs });
  }

  /** 视图对象 → 原始扫描行。详情页 / 草稿 / 证据都按行取数。 */
  rowOfView(view) {
    return view && view.row ? view.row : null;
  }

  buildDetailFrame() {
    const cols = this.width();
    const rows = this.height();
    const list = this.flatList();
    const idx = list.length ? this.selectPos(list) : -1;
    const view = idx >= 0 ? list[idx] : null;
    const session = this.rowOfView(view);
    if (!session) { this.mode = 'list'; return this.buildListFrame(); }

    const claims = this.claims?.results
      ? this.claims.results.filter((r) => {
        const sid = r.sessionId || r.r?.sessionId;
        return sid && (sid === session.sessionId || sid === session.hostSessionId || sid === session.transcriptId);
      }).flatMap((r) => (r.results || (r.r ? [r.r] : [])))
      : [];
    const content = detailLines(session, cols, this.useColor, {
      internals: this.showInternals,
      claims,
      claimsKnown: Boolean(this.claims),
      meta: view && view.meta ? { ...view.meta, title: view.title, cwd: view.path } : null,
      nowMs: this.now(),
    });
    const body = [];
    for (const l of content) body.push(l);
    const area = Math.max(1, rows - 2);
    const maxScroll = Math.max(0, body.length - area);
    this.detailScroll = Math.min(Math.max(0, this.detailScroll), maxScroll);

    const lines = [];
    const pos = `${idx + 1}/${list.length}`;
    const right = `${pos}${maxScroll > 0 ? `  ${this.detailScroll + 1}/${body.length}` : ''}  Esc 返回`;
    // 标题：**用 titleOf 取 .text**。直接把对象拼进模板串会得到 `[object Object]`。
    const headTitle = titleOf({ title: view?.title, path: view?.path }).text;
    let head = truncateToWidth(headTitle, Math.max(10, cols - displayWidth(right) - 1));
    const pad = Math.max(1, cols - displayWidth(head) - displayWidth(right));
    let headLine = head + ' '.repeat(pad) + right;
    if (this.useColor) headLine = BOLD + stripSgr(headLine) + RESET;
    lines.push(headLine);

    for (let i = 0; i < area; i++) lines.push(truncateToWidth(body[this.detailScroll + i] ?? '', cols));
    const hint = this.showInternals
      ? 'i 收起内部量 · d 证据 · c 复制草稿 · j/k 滚动 · Esc 返回'
      : 'i 显示内部量 · d 证据 · c 复制草稿 · j/k 滚动 · Esc 返回';
    lines.push(truncateToWidth(hint, cols));
    // 头部 + 正文 + 提示 = rows + 1 行；裁掉多余的一行，保证不滚屏
    return lines.slice(0, rows);
  }

  /**
   * 证据面板（`d`，裁决 R3）。**复用 verify-claims 的渲染**，不另写一份：
   * 它已经把「断言原文 + 判据 + 补救建议」说清楚了，重写只会分叉。
   */
  buildEvidenceFrame() {
    const cols = this.width();
    const rows = this.height();
    const results = this.claims?.results || [];
    const blocks = [];
    for (const row of results) {
      const text = renderSessionBlock(row, { verbose: false });
      if (text) blocks.push(...text.split('\n'));
    }
    const tally = claimsTally(results);
    const head = `证据 · ${tally.total} 条断言 · 硬矛盾 ${tally.hard} · 存疑 ${tally.soft} · Esc 返回`;
    const lines = [this.useColor ? BOLD + head + RESET : head];
    if (!blocks.length) {
      lines.push('');
      lines.push(' 没有需要看的断言：要么全部有证据支持，要么这些会话里没认出可核对的完成声明。');
    } else {
      lines.push(...blocks);
    }
    const area = Math.max(1, rows - 2);
    const maxScroll = Math.max(0, lines.length - area);
    this.evidenceScroll = Math.min(Math.max(0, this.evidenceScroll || 0), maxScroll);
    const out = [lines[0]];
    for (let i = 0; i < area; i++) out.push(truncateToWidth(lines[1 + this.evidenceScroll + i] ?? '', cols));
    out.push(truncateToWidth(`${maxScroll > 0 ? 'j/k 滚动 · ' : ''}按任意键返回`, cols));
    return out.slice(0, rows);
  }

  buildDraftPanel() {
    const cols = this.width();
    const rows = this.height();
    const width = Math.max(30, Math.min(cols - 4, 78));
    const inner = width - 4;
    const c = (code, s) => (this.useColor ? code + s + RESET : s);
    const innerLines = [];
    innerLines.push(c(BOLD, truncateToWidth(this.draftInfo || '复制失败，请手动选择', inner)));
    innerLines.push('');
    for (const l of wrapToWidth(this.draft ?? '', inner)) innerLines.push(truncateToWidth(l, inner));
    innerLines.push('');
    innerLines.push(c(DIM, HINT_DRAFT));

    const visible = innerLines.slice(0, Math.max(1, rows - 4));
    const top = '┌─ 接力草稿 ' + '─'.repeat(Math.max(0, width - 14)) + '┐';
    const bottom = '└' + '─'.repeat(Math.max(0, width - 2)) + '┘';
    const lines = [truncateToWidth(top, width)];
    for (const l of visible) lines.push('│ ' + fitWidth(l, inner) + ' │');
    lines.push(truncateToWidth(bottom, width));
    const pad = ' '.repeat(Math.max(0, Math.floor((cols - width) / 2)));
    return lines.map((l) => pad + l);
  }
}

// ── 参数 ──────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { days: DEFAULT_DAYS, intervalSec: DEFAULT_INTERVAL_SEC, plain: false, help: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') {
      // 不限窗口：用户明确要求过「所有会话都要显示」。
      out.all = true;
      out.days = 0;
    } else if (a === '--days' || a.startsWith('--days=')) {
      const v = a.includes('=') ? a.split('=')[1] : argv[++i];
      const n = Number(v);
      // 0 是合法值（等于 --all）。旧实现 `n > 0` 会把 0 静默忽略，退回默认 3 天。
      if (Number.isFinite(n) && n >= 0) { out.days = Math.min(365, Math.floor(n)); out.all = out.days === 0; }
    } else if (a === '--interval' || a.startsWith('--interval=')) {
      const v = a.includes('=') ? a.split('=')[1] : argv[++i];
      const n = Number(v);
      if (Number.isFinite(n) && n >= 1) out.intervalSec = Math.min(3600, Math.floor(n));
    } else if (a === '--plain') {
      out.plain = true;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

function usage() {
  return [
    'OmniSight TUI — 只读渲染器',
    '',
    '用法：node scripts/oversight-tui.mjs [--days N | --all] [--interval S] [--plain]',
    '',
    '  --days N       扫描窗口，默认 3 天（--days 30 实测约 87 秒，随语料增长）',
    '  --all          不限窗口，显示所有会话（等于 --days 0；语料多时更慢）',
    '  --interval S   轮询间隔秒数，默认 8',
    '  --plain        即使 TTY 也输出纯文本快照',
    '',
    '非 TTY（管道/重定向）自动输出纯文本快照后退出，不输出 ANSI。',
    '窗口按 transcript 内部的活动时间判定，不按文件 mtime——宿主会往尾部追加',
    '不含时间戳的元数据记录（title / mode / cost-state），文件被碰过不代表会话在跑。',
    '',
    '会话行来自三个来源的并集，缺一个就会有会话永远看不见：',
    '  1. transcript 重建（scan-sessions.mjs --json 的 sessions）',
    '  2. 宿主实时状态（同上的 live，~/.claude/sessions/*.json）',
    '  3. 宿主 job（~/.claude/jobs/*/state.json）—— 有些 blocked 会话完全没有 transcript',
  ].join('\n');
}

// ── 非 TTY 纯文本 ─────────────────────────────────────────────────────

/** 纯文本快照。sink 可注入，便于测试；默认写 process.stdout。 */
/**
 * 纯文本快照（非 TTY / `--plain`）。**必须与交互屏走同一套取数与同一套分段。**
 *
 * 2026-11-01 的教训（DF-012 / DF-017）：两条展示路径各写一份排序，于是同一个
 * waiting 会话在交互界面出现了、在 `| head` 输出里看不见。这次两条路径都调
 * `buildSections()`，差别只在「宽度固定 200、不做光标、不折行」。
 *
 * 宽度 200 而不是终端宽度：非 TTY 输出会被 `head` / `grep` / 日志文件消费，
 * 折行会把一行的语义劈成两行，反而更难 grep。
 */
export function printPlain(data, days, sink = process.stdout, opts = {}) {
  const cols = Math.max(80, Number(opts.cols) || 200);
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const metaOf = typeof opts.metaOf === 'function' ? opts.metaOf : null;
  const sections = buildSections({ data, inbox: opts.inbox || [], metaOf, nowMs });
  const out = [];

  // L0 判决行：**「N 件在等你」在最前**，不是「N 个会话」。
  out.push(verdictParts({
    actionCount: sections.action.length,
    runningCount: sections.running.length,
    stoppedCount: sections.stopped.length,
  }).join(' · '));
  // 「数据多新」与交互屏一样挂在判决行下面那一行（交互屏是 L0 右侧的 `8s前扫描`）。
  // 优先用调用方给的 lastSuccessAt；纯文本路径常拿不到，就退回 scan 自报的 generatedAt——
  // 缺了它就区分不出「没事」和「扫描没跑」，那是本仓库已经修过两次的老问题。
  const generatedAt = Date.parse(String(data?.generatedAt || ''));
  const freshAt = Number.isFinite(opts.lastSuccessAt) ? opts.lastSuccessAt : (Number.isFinite(generatedAt) ? generatedAt : null);
  const fresh = freshAt === null ? '数据时间未知' : `数据 ${fmtAgeMs(nowMs - freshAt)}`;
  out.push(`纯文本快照（交互界面需在终端运行） · 窗口 ${windowLabelOf(days)} · ${fresh}`);

  // L1 检查区：四道独立数据源。纯文本路径也要有，否则「空」在这里不可信。
  // **不再画表头、不再逐项列 0 值**（逆向 `2026-11-11-claude-status-block-reverse.md` §3.2）：
  // 只列有事的那几项，每项是「标签 + 一句断言」；四项都清白时只留一句
  // `✓ 4 项检查都清白 · 监视在跑`。
  const checklist = checklistRows({
    inboxCount: sections.action.length,
    askedCount: askedCountOf(sections),
    claims: opts.claims || { pending: true },
    health: opts.health ?? null,
    wide: true,
  });
  out.push('');
  // inbox 的计数已经是第 1 行的第一位，这里不重复；health 用整句说（含「未更新多久」）。
  const check = checklistLines(checklist, { cols, useColor: false, skipKinds: ['inbox'] });
  for (const l of check.lines) out.push(l);
  if (check.quiet) {
    // 「检查了什么」被删掉之后，**数据源清单**是它的正确替代（逆向 §3.3 第 7 条）：
    // 那是一个清单，不是表头——去掉也不会迷路，留着能回答「凭什么说清白」。
    // 新鲜度已经在上一行，这里不重复（重复两遍「数据 8s前」正是「突兀」的来源之一）。
    out.push(' 依据：inbox · asked · verify-claims · health');
  }

  // L2 需动作：**逐字 needs**，不摘要（relay-protocol §5.1）。
  // **注意：needs 出现在屏幕上是对的，出现在剪贴板里是错的**（见 buildDraft）。
  // 展示与复制是两条路，规格要求逐字展示，而用户要求能直接发出去的复制内容。
  if (sections.action.length) {
    out.push('');
    out.push(sectionTitle('需动作', sections.action.length));
    for (const v of sections.action) {
      out.push(` ${padDisplay(v.title, 50)} ${fmtSpan(v.idleSec).padStart(6)}  ${actionCell(v, { nowMs })}`);
      const needs = String(v.needs || '').replace(/\s+/g, ' ').trim();
      if (needs) out.push(`    它在等：${needs}`);
      if (v.suggestedReply) out.push(`    建议回复（逐字）：${v.suggestedReply}`);
    }
  }

  // L3 在跑：一句话摘要截到固定宽度。**不截 needs 那种逐字内容**（那在 L2）。
  if (sections.running.length) {
    out.push('');
    out.push(sectionTitle('在跑', sections.running.length));
    for (const v of sections.running) {
      const near = nearText(v.meta) || '—';
      out.push(` ${padDisplay(v.title, 40)} ${fmtSpan(v.idleSec).padStart(6)}  ${truncateToWidth(near, 72)}`);
    }
  }

  // L4 已停：一行计数（裁决 R1），**不展开** —— 非交互输出展开 17 行只是噪声。
  // 超龄降级来的那些在计数后面单独说一句：它们是「曾经在等你」，不是普通历史。
  if (sections.stopped.length) {
    out.push('');
    out.push(stoppedSummary(sections.stopped));
    for (const v of sections.stale || []) {
      const limit = Number.isFinite(v.staleLimitSec) ? ` > ${fmtSpan(v.staleLimitSec)} 上限` : '';
      out.push(`   · 超龄降级：${v.title}（${fmtSpan(v.idleSec)}${limit}）`);
    }
  }

  // 空/坏态：四种必须互相区分（§2.6）。
  if (!sections.all.length) {
    out.push('');
    for (const l of emptyLines({ data, days, lastSuccessAt: nowMs, now: () => nowMs }, cols)) out.push(l);
  }

  out.push('');
  out.push(`汇总（六态，仅供核对，不驱动动作）：${stateCounts(sections.all) || (sections.all.length ? '状态全部未识别' : '无会话')}`);
  if (opts.health === undefined) out.push('监视状态未知（纯文本路径没有读 state.json）');
  else if (opts.health === null) out.push('监视状态未知（读不到 state.json）');
  else if (!opts.health.healthy) out.push(`监视未在跑：${(opts.health.reasons || []).join('；')}`);
  out.push('提示：j/k 移动 · Enter 详情 · c 复制草稿 · h 展开已停 · d 证据 · i 内部量 · r 刷新 · ? 帮助 · q 退出（交互模式需 TTY）');
  sink.write(out.join('\n') + '\n');
}

// ── 入口 ──────────────────────────────────────────────────────────────

/**
 * 启动。依赖可注入，便于在无 pty 的 Windows Git Bash 下做 TTY 冒烟测试。
 * 返回的 Promise 在用户按 q / Ctrl-C 时 resolve。
 */
export async function main({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stdin = process.stdin,
  env = process.env,
  scan = defaultScan,
  claimsScan = defaultClaimsScan,
} = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(usage() + '\n');
    return;
  }

  const tty = Boolean(stdout.isTTY) && !opts.plain;
  if (!tty) {
    // defaultScan 返回 { promise, cancel }，不是 Promise。
    // 这里曾经直接 await 了 job 对象，导致 data 恒为 undefined，
    // | cat 与 --plain 全部输出「扫描失败：undefined」。见 DF-012。
    const job = scan({ days: opts.days });
    // 证据与扫描**并行**：实测 scan 50s / verify-claims 7.2s，串行毫无必要。
    // 纯文本路径必须算它 —— 否则检查表里「声明对不上」那一行只能写「正在算证据」，
    // 而这是一次性快照，没有「稍后再看」这回事。
    const claimsJob = opts.noClaims ? null : claimsScan({ days: opts.days });
    const { data, warning } = await job.promise;
    if (!data) {
      process.stderr.write(`扫描失败：${warning}\n`);
      process.exitCode = 1;
      return;
    }
    // 纯文本路径也读宿主事实：**不读就没法区分「真的没事」和「监视挂了」**。
    const plainOpts = { cols: 200, nowMs: Date.now() };
    try {
      const dir = defaultStateDir(env && env);
      const { state } = loadState(dir, { nowMs: plainOpts.nowMs });
      plainOpts.health = healthCheck(state, { nowMs: plainOpts.nowMs });
      plainOpts.inbox = buildInbox(state, { nowMs: plainOpts.nowMs, live: data.live || [] });
    } catch {
      plainOpts.health = null;
      plainOpts.inbox = [];
    }
    if (claimsJob) {
      const res = await claimsJob.promise;
      plainOpts.claims = Array.isArray(res?.results) ? claimsTally(res.results) : (res?.error ? { error: true } : { pending: true });
    }
    // 标题 / 末条 assistant：与交互路径同一份缓存（单次运行，冷缓存）。
    const cache = createMetaCache();
    const dir = projectsRoot(env && env);
    plainOpts.metaOf = (row) => {
      const file = transcriptPathFor(row, dir);
      if (!file) return null;
      const mt = Number.isFinite(Date.parse(row.lastActivity || '')) ? Date.parse(row.lastActivity) : null;
      return cache.get(file, { mtimeMs: mt });
    };
    printPlain(data, opts.days, stdout, plainOpts);
    return;
  }

  const useColor = !env.NO_COLOR && env.TERM !== 'dumb';
  const app = new App({
    stdout,
    stdin,
    env,
    days: opts.days,
    intervalSec: opts.intervalSec,
    scan,
    useColor,
    claimsScanner: claimsScan,
  });
  app.start();
  try {
    await app.done;
  } finally {
    // 保险：未走 close() 的异常路径也恢复终端
    if (!app.closed) app.close();
  }
}

// 仅在直接执行时启动（便于测试 import）
const isDirect = process.argv[1] && /oversight-tui\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isDirect) {
  main().catch((err) => {
    process.stderr.write(`TUI 启动失败：${err?.stack || err}\n`);
    process.exitCode = 1;
  });
}
