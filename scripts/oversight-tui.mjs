#!/usr/bin/env node
/**
 * oversight-tui.mjs — OmniSight 的终端界面。
 *
 * 只做渲染：不判定状态、不计算 novelty、不修改任何文件。
 * 所有状态与数字都来自 `scan-sessions.mjs --json` 的原样输出。
 *
 * 用法：
 *   node scripts/oversight-tui.mjs                 # 交互界面，最近 3 天，8 秒轮询
 *   node scripts/oversight-tui.mjs --days 1        # 缩短扫描窗口
 *   node scripts/oversight-tui.mjs --interval 15   # 调整轮询间隔（秒）
 *   node scripts/oversight-tui.mjs | cat           # 非 TTY：纯文本快照后退出
 *
 * 按键：j/k 或 ↑/↓ 移动，Enter 详情，Esc 返回，c 复制草稿，r 刷新，? 帮助，q 退出。
 *
 * 零 npm 依赖，只用 node: 内置模块。只读。
 */

import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STATES, displayWidth, paint, stripAnsi } from './tui-theme.mjs';

// ── 常量 ──────────────────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCAN_PATH = join(SCRIPT_DIR, 'scan-sessions.mjs');

/** 终端展示顺序：异常态在前。与 scan-sessions.mjs 的人类输出保持一致。 */
const STATE_ORDER = ['BLOCKED', 'FAILED', 'STALLED', 'PRODUCING', 'EXPLORING'];

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
const INVERSE = '\x1b[7m';

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
 * 宽度计算走 tui-theme 的 displayWidth，不再自带 charWidth。
 */
export function truncateToWidth(str, max) {
  const s = String(str ?? '');
  if (max <= 0) return '';
  if (displayWidth(s) <= max) return s;
  if (max === 1) return '…';
  let out = '';
  let styled = false;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(s.slice(i));
      if (m) { out += m[0]; styled = true; i += m[0].length; continue; }
    }
    // 按码点切，避免拆断代理对；宽度由 displayWidth 统一计算
    const cp = String.fromCodePoint(s.codePointAt(i));
    if (displayWidth(out + cp) > max - 1) break;
    out += cp;
    i += cp.length;
  }
  return out + '…' + (styled ? RESET : '');
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

/** 组装接力草稿：suggestedReply 在前，needs 作为上下文。
 *  出口统一净化：草稿会被复制进剪贴板并显示在终端，控制字符不能流出去。 */
export function buildDraft(session) {
  const reply = typeof session?.suggestedReply === 'string' ? session.suggestedReply.trim() : '';
  const needs = typeof session?.needs === 'string' ? session.needs.trim() : '';
  if (!reply && !needs) return null;
  const parts = [];
  if (reply) parts.push(sanitize(reply));
  if (needs) parts.push(`（目标会话正在等待：${sanitize(needs)}）`);
  return parts.join('\n\n');
}

// ── 扫描（唯一的子进程调用）──────────────────────────────────────────

/**
 * 调用 scan-sessions.mjs --json。
 * 注意：scan 在存在 FAILED 会话时 exit 1，但 stdout 仍是完整 JSON，不能当失败。
 *
 * 返回 { promise, cancel }：cancel() 会 kill 子进程。
 * 没有这个的话，按 q 之后进程要等扫描跑完（--days 30 时约 110 秒）才真正退出，
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
 * 列表行。返回不含 SGR 的纯文本（方便按宽度补齐），着色由上层负责。
 * cols < 72 时逐级舍弃末尾字段，保证不折行。
 */
function listRow(session, cols, selected) {
  const marker = selected ? '> ' : '  ';
  const showCalls = cols >= 44;
  const showNov = cols >= 56;
  const showIdle = cols >= 66;
  const showReason = cols >= 78;

  let line = marker + fitWidth(stateColumn(session), COL_STATE) + ' '
    + fitWidth(projectLabel(sanitize(session.project)), COL_PROJECT);
  if (showCalls) line += ' ' + fitWidth(`calls=${String(session.calls ?? 0).padStart(5)}`, COL_CALLS);
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
  const title = `OmniSight · 会话列表 · 最近 ${days} 天 · liveness ${live}`;
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

/** 状态行（列表底部第二行）。 */
function statusLine(app, cols) {
  const sessions = app.sessions();
  const counts = stateCounts(sessions);
  const refresh = app.refreshing
    ? '刷新中…'
    : (app.lastSuccessAt ? `刷新于 ${fmtAgo(app.now() - app.lastSuccessAt)}` : '尚未刷新');
  const parts = [
    `${sessions.length} 会话`,
    counts || '无异常',
    refresh,
    `每 ${app.intervalSec}s 轮询`,
  ];
  let text = `[${parts.join(' · ')}]`;
  if (app.warning) text += ` ⚠ ${app.warning}`;
  if (app.notice) text += ` · ${app.notice}`;
  return truncateToWidth(text, cols);
}

function detailLines(session, cols, useColor) {
  const st = stateOf(session);
  const c = (code, s) => (useColor ? code + s + RESET : s);
  const label = (name) => name + ' '.repeat(Math.max(0, 13 - displayWidth(name)));
  const kv = (name, value) => truncateToWidth(`  ${label(name)}${value ?? '—'}`, cols);

  const out = [];
  out.push(kv('项目', projectLabel(sanitize(session.project))));
  out.push(kv('目录', sanitize(session.project)));
  out.push(kv('sessionId', sanitize(session.sessionId)));
  out.push(kv('state', `${glyphOf(session)} ${st}`));
  out.push(kv('reason', sanitize(session.reason)));
  out.push(kv('liveness', session.liveness));
  out.push(kv('hostState', sanitize(session.hostState ?? '—')));
  if (session.jobDetail) out.push(kv('jobDetail', sanitize(session.jobDetail)));
  out.push(kv('calls', session.calls));
  out.push(kv('novelty', fmtNovelty(session.novelty)));
  out.push(kv('noveltyAll', fmtNovelty(session.noveltyAll)));
  out.push(kv('idle', fmtDur(session.idleSec)));
  out.push(kv('lastActivity', session.lastActivity));
  if (session.hbThresholdSec !== null && session.hbThresholdSec !== undefined) {
    out.push(kv('心跳', `末次 ${session.lastGapSec ?? 'n/a'}s / 阈值 ${session.hbThresholdSec}s`));
  }
  if (session.tokens !== null && session.tokens !== undefined) {
    out.push(kv('tokens', String(session.tokens)));
  }
  if (session.badLines > 0) out.push(kv('badLines', String(session.badLines)));
  out.push('');

  // 派生树
  const total = session.subagentsTotal ?? session.subagents ?? 0;
  const shown = session.subagents ?? 0;
  const truncated = session.subagentsTruncated ?? Math.max(0, total - shown);
  const ratio = truncated > 0 ? `${shown}/${total}（已截断）` : `${shown}/${total}`;
  out.push(truncateToWidth(`派生树 · 层深 ${session.maxDepth ?? 0} · 子 agent ${ratio}`, cols));
  out.push(truncateToWidth('  （节点字形 ◇ 表示该节点状态未由 scan --json 暴露）', cols));
  if (!shown) {
    out.push('  │ （无派生 agent）');
  } else {
    for (let i = 1; i <= shown; i++) {
      out.push(truncateToWidth(`  │ ◇ 子 agent #${i}`, cols));
    }
    if (truncated > 0) {
      out.push(truncateToWidth(`  │ … 另 ${truncated} 个未展开 · 完整比例 ${shown}/${total}`, cols));
    }
  }

  // 等待输入
  if (session.needs) {
    out.push('');
    out.push(useColor ? `${BOLD}等待输入${RESET}` : '等待输入');
    for (const l of wrapToWidth(sanitize(session.needs), Math.max(10, cols - 2))) out.push('  ' + l);
  }
  if (session.suggestedReply) {
    out.push('');
    out.push(useColor ? `${BOLD}建议回复${RESET}` : '建议回复');
    for (const l of wrapToWidth(sanitize(session.suggestedReply), Math.max(10, cols - 2))) out.push('  ' + l);
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
    ['h', '快捷键'],
    ['k', '  j / ↓  下一行        k / ↑  上一行'],
    ['k', '  Enter  查看详情      Esc    返回列表'],
    ['k', '  c      复制接力草稿  r      立即刷新'],
    ['k', '  ?      帮助          q      退出'],
    ['', ''],
    ['h', '四态含义'],
    ['k', `  ${GLYPHS.BLOCKED} BLOCKED      宿主报 blocked，在等输入（权限 / API / 沙箱）`],
    ['k', `  ${GLYPHS.FAILED} FAILED       宿主报 failed，或心跳超阈且 60s 无新记录`],
    ['k', `  ${GLYPHS.STALLED} STALLED      连续 3 窗 novelty < 0.2 且无持久化变更`],
    ['k', `  ${GLYPHS.PRODUCING} PRODUCING    窗口内存在持久化变更（Write/Edit/写入类 Bash）`],
    ['k', `  ${GLYPHS.EXPLORING} EXPLORING    其余情况（只读探索 / 冷启动 / 休眠）`],
    ['', ''],
    ['k', '判定全部来自 scan-sessions.mjs，本界面不计算状态。'],
    ['k', 'BLOCKED / FAILED 排在最前，同状态按 idle 降序。'],
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

class App {
  constructor({ stdout, stdin, env, days, intervalSec, scan, useColor }) {
    this.stdout = stdout;
    this.stdin = stdin;
    this.env = env;
    this.days = days;
    this.intervalSec = intervalSec;
    this.scan = scan;
    this.useColor = useColor;

    this.data = null;
    this.warning = null;
    this.refreshing = false;
    this.lastSuccessAt = null;
    this.selected = 0;
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
    this._onData = null;
    this._onResize = null;
    this._resolve = null;
    this._pending = '';
    this._escTimer = null;
    this.done = new Promise((r) => { this._resolve = r; });
  }

  now() { return Date.now(); }

  sessions() {
    return this.data?.sessions ?? [];
  }

  sortedSessions() {
    // 排序只依赖 scan 给出的 state / idleSec；不重算任何状态
    return [...this.sessions()].sort((a, b) => {
      const ai = STATE_ORDER.indexOf(a.state);
      const bi = STATE_ORDER.indexOf(b.state);
      const ar = ai < 0 ? STATE_ORDER.length : ai;
      const br = bi < 0 ? STATE_ORDER.length : bi;
      return ar - br || (b.idleSec ?? 0) - (a.idleSec ?? 0);
    });
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
    this.render();

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
      const sessions = this.sortedSessions();
      if (this.selected >= sessions.length) this.selected = Math.max(0, sessions.length - 1);
    } else {
      this.warning = warning || '扫描失败';
    }
    this.scheduleNext();
    this.render();
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

    // 覆盖式面板（帮助 / 草稿）：q 退出，其余任意键关闭面板回到原视图
    if (this.mode === 'help' || this.mode === 'draft') {
      if (key === 'q') { this.close(); return; }
      this.mode = this.prevMode === 'detail' ? 'detail' : 'list';
      this.render();
      return;
    }

    if (this.mode === 'list') {
      if (key === 'q') { this.close(); return; }
      if (key === '?' ) { this.prevMode = 'list'; this.mode = 'help'; this.render(); return; }
      if (key === 'j' || key === 'down') { this.move(1); return; }
      if (key === 'k' || key === 'up') { this.move(-1); return; }
      if (key === 'g' || key === 'home') { this.selected = 0; this.render(); return; }
      if (key === 'G' || key === 'end') { this.selected = Math.max(0, this.sortedSessions().length - 1); this.render(); return; }
      if (key === 'enter') { this.openDetail(); return; }
      if (key === 'r') { this.refresh(); return; }
      if (key === 'c') { this.copyDraft(); return; }
      return;
    }

    if (this.mode === 'detail') {
      if (key === 'q') { this.close(); return; }
      if (key === 'escape') { this.mode = 'list'; this.detailScroll = 0; this.render(); return; }
      if (key === '?') { this.prevMode = 'detail'; this.mode = 'help'; this.render(); return; }
      if (key === 'j' || key === 'down') { this.detailScroll += 1; this.render(); return; }
      if (key === 'k' || key === 'up') { this.detailScroll = Math.max(0, this.detailScroll - 1); this.render(); return; }
      if (key === 'pgdown') { this.detailScroll += 10; this.render(); return; }
      if (key === 'pgup') { this.detailScroll = Math.max(0, this.detailScroll - 10); this.render(); return; }
      if (key === 'r') { this.refresh(); return; }
      if (key === 'c') { this.copyDraft(); return; }
    }
  }

  move(delta) {
    const n = this.sortedSessions().length;
    if (!n) return;
    this.selected = Math.min(n - 1, Math.max(0, this.selected + delta));
    this.render();
  }

  openDetail() {
    if (!this.sortedSessions().length) return;
    this.mode = 'detail';
    this.detailScroll = 0;
    this.render();
  }

  currentSession() {
    const sessions = this.sortedSessions();
    return sessions[Math.min(this.selected, Math.max(0, sessions.length - 1))] ?? null;
  }

  async copyDraft() {
    const session = this.currentSession();
    if (!session) return;
    const draft = buildDraft(session);
    if (!draft) {
      this.showNotice('该会话没有 needs / suggestedReply，无草稿可复制');
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
    if (this.mode === 'detail') return this.buildDetailFrame();
    return this.buildListFrame();
  }

  buildListFrame() {
    const cols = this.width();
    const rows = this.height();
    const sessions = this.sortedSessions();
    const lines = [];
    lines.push(listHeaderLine(this.days, cols, sessions));
    lines.push(columnHeaderLine(cols));

    const area = Math.max(1, rows - 4);
    if (this.selected >= sessions.length) this.selected = Math.max(0, sessions.length - 1);
    if (this.selected < this.listOffset) this.listOffset = this.selected;
    if (this.selected >= this.listOffset + area) this.listOffset = this.selected - area + 1;
    const maxOffset = Math.max(0, sessions.length - area);
    this.listOffset = Math.min(Math.max(0, this.listOffset), maxOffset);

    if (!sessions.length) {
      const msg = this.data
        ? '（当前窗口内没有会话）'
        : (this.warning ? `扫描失败：${this.warning}` : '正在扫描…（首次扫描约 10 秒）');
      lines.push(truncateToWidth(msg, cols));
      for (let i = 1; i < area; i++) lines.push('');
    } else {
      for (let i = 0; i < area; i++) {
        const idx = this.listOffset + i;
        if (idx >= sessions.length) { lines.push(''); continue; }
        const session = sessions[idx];
        const selected = idx === this.selected;
        let row = listRow(session, cols, selected);
        if (this.useColor) {
          if (selected) row = INVERSE + stripSgr(row) + RESET;
          else {
            const st = stateOf(session);
            const colorName = STATES[st]?.color;
            const stateText = `${glyphOf(session)} ${st.padEnd(9)}`;
            // 只着色状态段，宽度不受 SGR 影响
            if (colorName) row = row.replace(stateText, paint(stateText, colorName, true));
          }
        }
        lines.push(row);
      }
    }

    lines.push(truncateToWidth(HINT_LIST, cols));
    lines.push(statusLine(this, cols));
    return lines;
  }

  buildDetailFrame() {
    const cols = this.width();
    const rows = this.height();
    const session = this.currentSession();
    if (!session) { this.mode = 'list'; return this.buildListFrame(); }

    const content = detailLines(session, cols, this.useColor);
    const area = Math.max(1, rows - 2);
    const maxScroll = Math.max(0, content.length - area);
    this.detailScroll = Math.min(Math.max(0, this.detailScroll), maxScroll);

    const lines = [];
    let head = `OmniSight · 详情 · ${projectLabel(sanitize(session.project))}`;
    const scrollInfo = maxScroll > 0 ? `  ${this.detailScroll + 1}/${content.length}` : '';
    head = truncateToWidth(head, Math.max(10, cols - displayWidth(scrollInfo))) + scrollInfo;
    if (this.useColor) head = BOLD + stripSgr(head) + RESET;
    lines.push(head);

    for (let i = 0; i < area; i++) {
      lines.push(content[this.detailScroll + i] ?? '');
    }
    lines.push(truncateToWidth(`${HINT_DETAIL} · j/k 滚动`, cols));
    return lines;
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
  const out = { days: DEFAULT_DAYS, intervalSec: DEFAULT_INTERVAL_SEC, plain: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days' || a.startsWith('--days=')) {
      const v = a.includes('=') ? a.split('=')[1] : argv[++i];
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out.days = Math.min(365, Math.floor(n));
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
    '用法：node scripts/oversight-tui.mjs [--days N] [--interval S] [--plain]',
    '',
    '  --days N       扫描窗口，默认 3 天（30 天约需 110 秒）',
    '  --interval S   轮询间隔秒数，默认 8',
    '  --plain        即使 TTY 也输出纯文本快照',
    '',
    '非 TTY（管道/重定向）自动输出纯文本快照后退出，不输出 ANSI。',
    '状态判定全部来自 scan-sessions.mjs --json；本界面不计算任何状态。',
  ].join('\n');
}

// ── 非 TTY 纯文本 ─────────────────────────────────────────────────────

/** 纯文本快照。sink 可注入，便于测试；默认写 process.stdout。 */
export function printPlain(data, days, sink = process.stdout) {
  const sessions = [...(data.sessions ?? [])].sort((a, b) => {
    const ai = STATE_ORDER.indexOf(a.state);
    const bi = STATE_ORDER.indexOf(b.state);
    const ar = ai < 0 ? STATE_ORDER.length : ai;
    const br = bi < 0 ? STATE_ORDER.length : bi;
    return ar - br || (b.idleSec ?? 0) - (a.idleSec ?? 0);
  });
  const cols = 200;
  const out = [];
  out.push(listHeaderLine(days, cols, sessions));
  out.push(`纯文本快照（交互界面需在终端运行）`);
  out.push(columnHeaderLine(cols));
  for (const s of sessions) out.push(listRow(s, cols, false, false));

  for (const s of sessions) {
    if (!s.needs && !s.suggestedReply) continue;
    out.push('');
    out.push(`[${s.state}] ${projectLabel(sanitize(s.project))}  ${sanitize(s.sessionId)}`);
    if (s.needs) out.push(`  等待输入：${sanitize(s.needs)}`);
    if (s.suggestedReply) out.push(`  建议回复：${sanitize(s.suggestedReply)}`);
  }

  out.push('');
  out.push(`汇总：${stateCounts(sessions) || '无会话'}`);
  out.push(`提示：${HINT_LIST}（交互模式需 TTY）`);
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
    const { data, warning } = await job.promise;
    if (!data) {
      process.stderr.write(`扫描失败：${warning}\n`);
      process.exitCode = 1;
      return;
    }
    printPlain(data, opts.days, stdout);
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
