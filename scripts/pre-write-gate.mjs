#!/usr/bin/env node
/**
 * pre-write-gate.mjs — PreToolUse 写前闸：**第一次写文件之前，先证明你读过这个项目**。
 *
 * 宿主在每次工具调用**之前**同步调用本脚本，把 `{session_id, transcript_path, cwd,
 * prompt_id, permission_mode, effort, hook_event_name, tool_name, tool_input, tool_use_id}`
 * 以 JSON 从 stdin 喂进来。脚本若判「这是本次会话的第一次写、且没有任何读过项目的证据」，
 * 就返回 `permissionDecision:"deny"`，reason 里放一条**可执行**的指令链，喂回给模型。
 *
 * 契约与实测依据：`docs/research/2026-11-14-pretooluse-desktop-verification.md`（20 组，
 * 真 `claude.exe 2.1.308`）。原型与实测：`docs/research/2026-11-14-pre-write-gate-prototype.md`。
 *
 * ── 三条实测硬约束，逐条怎么防 ─────────────────────────────────────
 *
 * ① **`exit 2` 不拦截**（D3：hook 触发 1 次、文件照样落盘；B4 的「拦住了」是 Git Bash
 *    缺失的 fallback 假象）。本脚本**只有一种拦截表达**：标准输出上的
 *    `hookSpecificOutput.permissionDecision:"deny"`。任何 `process.exitCode=2` 的写法都不存在
 *    —— 本文件所有退出路径都是 `exit 0`，包括崩溃路径（崩溃 = 放行，见 §fail-open）。
 *
 * ② **拒绝循环宿主无上限**（G3：连拒 69 次仍在跑）。所以每次 deny 都带刹车：
 *    默认 `brake="halt"` → deny 同时给顶层 `continue:false`，一轮即停（G4 实测）。
 *    代价是**终止整个回合**，也就放弃了「让模型被拒后先去读文件」。
 *    要后者就换 `brake="budget"`：前 N 次 deny 不给 `continue:false`（模型可以继续读），
 *    N 次之后照样刹车。计数器**只用来刹车，不用来判定** —— 判定永远查磁盘状态，
 *    所以「重试绕过」这条路不通（E1 证明计数器判定可以被一次重试直接绕过）。
 *
 * ③ **只 matcher `Write|Edit` 会被 shell 绕过**（G6：`PowerShell` 的 `Set-Content`
 *    照常落盘）。所以本脚本自己解析两类 shell 工具：
 *      · `Bash` → 复用 `claim-ledger.mjs` 的 `bashWriteScan`（重定向 / heredoc / tee / cp / mv）
 *      · `PowerShell` → 本文件的 `powershellWriteScan`（Set-Content / Out-File / 重定向 / …）
 *    模板 `templates/pre-write-gate.settings.json` 里的 matcher 覆盖五个工具名。
 *    解析不出来的（`sh -c`、`xargs`、`Invoke-Expression`）**计数但放行**，见 §诚实边界。
 *
 * ── 状态：查磁盘，不数次数 ────────────────────────────────────────
 *
 * 标记文件 `<cwd>/.claude/.ow-read-done`，内容是 JSON：
 *   `{version, session_id, at, satisfied_by, reads, prompt_id, [verified_at, reads_sample, sig]}`
 *
 * 谁创建它——**两条路都开，主路是 (b)**：
 *
 *   (b) **`satisfied_by:"auto"`（默认走这条）**：hook 读 transcript 尾部，数本会话已经
 *       `Read` 过几个不同的文件；够了就**自己**写标记并放行。不依赖 AI 听话，也不依赖
 *       它知道本闸存在——一个本来就会先读项目的 agent 根本感觉不到闸门。
 *   (a) **`satisfied_by:"claim"`（逃生口）**：AI 被拒后按 reason 跑
 *       `node <repo>/scripts/pre-write-gate.mjs mark`。它**没有**读过任何东西，这是自述。
 *
 * 为什么两条都留：只看 (a) 是荣誉制（AI 不读也能举手）；只看 (b) 则有硬边界——读发生在
 * 本会话之外（`/resume` 前的旧会话、子 agent、读屏工具），transcript 里就查不到，闸门会
 * 永远拦一个其实读过项目的会话。所以 (b) 是判定主路，(a) 是记账透明的逃生口：
 * 标记里 `satisfied_by` 把「验出来的」和「自己说的」分开，事后可审计。
 * `decide()` 只会返回 `markWrite`，真正写盘在 `runHook()`——纯函数不碰盘，才测得了。
 *
 * ── 两条判据（2026-11-14 按首写工具拆开）────────────────────────────
 *
 *   · `Edit` / `MultiEdit` / `NotebookEdit`（改**已有**文件）：判「**读过这个文件本身**」。
 *     实测（`resolution-gate-audit.mjs` R8）：真实项目里 18/18 个 Edit-first 会话都在改之前
 *     读过目标文件，而「读过 ≥3 个不同文件」这条仍误拦其中 4 个。反例：被拦的 4 个
 *     **全都**读过自己的目标文件 —— 误伤是纯损失。
 *   · `Write` 与 shell 写入（`Bash` / `PowerShell`）：**行为不变**，仍数「读过 ≥minReads 个
 *     不同文件」。理由是定义性的：新建文件没有「目标文件」可读，实测被拦的 27 个里 23 个
 *     是 `Write`。拿 Edit 的判据去管它，等于把闸门整个拆掉。
 *
 * 目标锚定放行**不写标记**：它只证明「这一个文件读过」，不证明「读过这个项目」。
 * 所以后续的 `Write` 仍按阈值判 —— 这条比原来的行为更严，不是更松。
 *
 * ── 签名：`satisfied_by:"auto"` 必须带 HMAC ────────────────────────
 *
 * `auto` 的含义是「闸门自己从 transcript 里验出来的」，那它就**不能**是任何进程写一句话
 * 就能冒充的。做法：`writeMarker()` 写 `auto` 时，用
 * `.claude/.ow-gate-secret`（首次运行生成，32 字节 hex）对
 * `session_id + at + reads + verified_at + reads_sample` 做 HMAC-SHA256，写进 `sig`；
 * `markerValidity()` 重算比对（`timingSafeEqual`）。`claim` 不需要签名 —— 它本来就是自述，
 * 签了反而会让人误以为它是验出来的。
 *
 * 边界（写死在代码里，不是猜的）：
 *   · **secret 文件被删** → 下次运行重新生成 → 旧 `auto` 标记的签名验不过 → **失效**（不是放行），
 *     闸门退回「查 transcript」那条路重新判一次。
 *   · **secret 读不到 / 建不出来**（目录只读）→ `auto` 标记一律判 `auto-no-secret` 无效。
 *     这不会变成「永远拦」：同一个目录里标记文件也写不进去，那种情况下闸门本来就没有主路，
 *     只剩 `claim` 逃生口（与引入签名之前完全一致）。**没有做 fail-open 降级** ——
 *     「没有密钥」永远不等于「谁写的都算」。
 *   · 密钥文件本身不许被写：命中 `.claude/.ow-gate-secret` 的写单独判 `secret-tamper`，
 *     不跟 `gate-own-file` 一起放行 —— 否则改密钥再伪造签名，等于没签。

 *
 * ── 模式（默认最保守）─────────────────────────────────────────────
 *
 *   `OW_PRE_WRITE_GATE=observe`（**默认**）  只往 `tasks/runs/pre-write-gate/<日期>.jsonl`
 *                                          记账，stdout 什么都不输出 = 放行。
 *   `OW_PRE_WRITE_GATE=warn`                 放行 + `additionalContext` 提醒（实测只注入
 *                                          一次、不引发循环），不拦。
 *   `OW_PRE_WRITE_GATE=deny`                 真的拦。
 *
 * ── fail-open ────────────────────────────────────────────────────
 *
 * 输入解析不了、transcript 读不到、我们自己的代码抛了——一律放行并记账。理由同
 * `stop-verify-hook.mjs`：闸门故障不该让用户写不了文件。
 *
 * ── 用法 ─────────────────────────────────────────────────────────
 *
 *   # hook 入口（宿主调用，stdin 进 stdout 出）
 *   node scripts/pre-write-gate.mjs
 *   # 手动举手（reason 里让模型跑的那条）
 *   node scripts/pre-write-gate.mjs mark [--session <id>] [--reads <n>] [--cwd <dir>]
 *   # 看当前状态（调试用）
 *   node scripts/pre-write-gate.mjs status [--cwd <dir>]
 */

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bashWriteScan } from './claim-ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** 标记文件相对**会话 cwd** 的路径。跟着项目走，不跟着仓库走。 */
export const MARKER_REL = '.claude/.ow-read-done';

/** 拒绝计数（刹车用）相对 cwd 的路径。只影响 `brake="budget"`。 */
export const DENIAL_REL = '.claude/.ow-gate-denials.json';

/** 签名密钥相对 cwd 的路径。**每次会话首次生成**，只在本机、只在 `.claude/` 下。
 *  它是 `auto` 标记不可伪造的唯一依据：读得到源码不等于读得到密钥（密钥不上仓）。 */
export const SECRET_REL = '.claude/.ow-gate-secret';

/** 触发闸门的工具名。注意 shell 类要**解析命令**才知道是不是写，见 `writeIntentOf`。 */
export const WRITE_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** 改**已有**文件的工具。判据是「读过这个文件本身」，见文件头 §两条判据。
 *  `Write` 不在这里 —— 新建文件没有目标文件可读，对它用这条判据等于把闸门拆掉。 */
export const EDIT_SIDE_TOOLS = Object.freeze(['Edit', 'MultiEdit', 'NotebookEdit']);

export const SHELL_TOOLS = Object.freeze(['Bash', 'PowerShell']);

/** 三种模式。`observe` 是默认——不显式开启就绝不干预。 */
export const MODES = Object.freeze(['observe', 'warn', 'deny']);

/** 两种刹车。`halt` 是默认，因为它严格符合「拒绝必须带 continue:false」。 */
export const BRAKES = Object.freeze(['halt', 'budget']);

/** transcript 里算「读过」的工具名。`Read` 之外加 Notebook 读。 */
export const READ_TOOLS = Object.freeze(['Read', 'NotebookRead']);

/** shell 里算「读过文件」的动词。刻意窄：`grep`/`ls` 不算读过内容。
 *
 *  `readVerbs` 参数**只为让重放器能验证「动词表是判据的唯一来源」**而存在：
 *  生产调用从不传它，传了就等于改判据。`observe-reality-check.test.mjs` 用
 *  「注入 `ls`」证明重放器跟着动 —— 重放器若自己写一份动词表，那条测试会红。 */
const SHELL_READ_VERBS = Object.freeze(['cat', 'head', 'tail', 'type', 'get-content', 'gc', 'more']);

/** 导出只读引用：重放器用它验证「动词表是判据的唯一来源」。
 *  它是**数据**，不是判据入口 —— 想让重放器用别的动词表，走 `readVerbs` 参数。 */
export const GATE_SHELL_READ_VERBS = SHELL_READ_VERBS;

/** 默认配置。全部可用环境变量覆盖，测试靠传 `env` 对象注入。 */
export function defaultConfig() {
  return {
    mode: 'observe',
    brake: 'halt',
    /** `brake="budget"` 时，同一个 (session, prompt) 内前几次 deny 不刹车。 */
    denyBudget: 2,
    /** 算「读过项目」的最少**不同**文件数。reason 文案按这个数生成，两处不会漂。 */
    minReads: 3,
    /** 读 transcript 尾部多少字节。判定只花一次有界读，不扫全文件。 */
    transcriptBytes: 1024 * 1024,
    /** 跨会话承认标记。默认否：新会话 = 没读过这个项目的新 AI。 */
    crossSession: false,
  };
}

/** 从 env 读配置。非法值一律回落到默认（保守方向）。 */
export function configOf(env = {}) {
  const cfg = defaultConfig();
  const mode = String(env.OW_PRE_WRITE_GATE || '').trim().toLowerCase();
  if (MODES.includes(mode)) cfg.mode = mode;

  const brake = String(env.OW_PRE_WRITE_GATE_BRAKE || '').trim().toLowerCase();
  if (BRAKES.includes(brake)) cfg.brake = brake;

  const num = (k, lo, hi) => {
    const raw = String(env[k] ?? '').trim();
    // 缺省与空串必须回落到默认，**不能**当 0。这个坑真的踩到了：
    // `Number('')` 是 0，于是只设了 `OW_PRE_WRITE_GATE=deny` 时 minReads 变成 0，
    // 「自动满足」那条主路被静默关掉，闸门退化成纯荣誉制。测试里有一条专门守这个。
    if (!raw) return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= lo && v <= hi ? Math.floor(v) : null;
  };
  const db = num('OW_PRE_WRITE_GATE_DENY_BUDGET', 0, 20);
  if (db !== null) cfg.denyBudget = db;
  const mr = num('OW_PRE_WRITE_GATE_MIN_READS', 0, 50);
  if (mr !== null) cfg.minReads = mr;
  const tb = num('OW_PRE_WRITE_GATE_TRANSCRIPT_BYTES', 4096, 64 * 1024 * 1024);
  if (tb !== null) cfg.transcriptBytes = tb;

  const cs = String(env.OW_PRE_WRITE_GATE_CROSS_SESSION || '').trim().toLowerCase();
  cfg.crossSession = ['1', 'true', 'on', 'yes'].includes(cs);
  return cfg;
}

/** 标记文件绝对路径。`cwd` 是会话根（宿主实测：就是会话根，不是文件所在目录）。 */
export function markerPathFor(cwd) {
  return join(String(cwd || process.cwd()), ...MARKER_REL.split('/'));
}

export function denialPathFor(cwd) {
  return join(String(cwd || process.cwd()), ...DENIAL_REL.split('/'));
}

/** 密钥文件绝对路径。跟着会话 cwd 走，理由同 `markerPathFor`。 */
export function secretPathFor(cwd) {
  return join(String(cwd || process.cwd()), ...SECRET_REL.split('/'));
}

// ── 写操作的识别 ──────────────────────────────────────────────────────

/** 归一化路径用于比较。Windows 下大小写不敏感，所以一律小写 + 正斜杠。
 *
 *  **大小写折叠必须按平台分**：Linux 的 `a.mjs` 与 `A.mjs` 是两个文件。
 *  无条件小写会把它俩折成同一个 key，于是「读过 `a.mjs`」会放行 `Edit A.mjs` ——
 *  Edit 侧那条「读过目标文件本身」的判据（18/18 实测）在 Linux 上直接失效。
 *  同仓 `claim-ledger.mjs` 的 `pathKey()` 本来就有这个守卫，两处口径必须一致。 */
export function pathKeyOf(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** 这个路径是不是**闸门自己的**文件（标记 / 刹车计数 / 闸门日志）。
 *
 *  必须放行，否则 AI 永远写不出标记，闸门自锁。范围刻意收到 `.claude/.ow-*`：
 *  `.claude/CLAUDE.md`、`.claude/settings.json` 这些**不是**我们的，照拦。 */
export function isGateOwnedPath(p, cwd) {
  const k = pathKeyOf(p);
  const base = pathKeyOf(cwd);
  if (!k) return false;
  if (base && k.startsWith(base + '/')) {
    const rel = k.slice(base.length + 1);
    if (rel.startsWith('.claude/.ow-')) return true;
  }
  return /\/\.claude\/\.ow-[^/]+$/.test(k) || /^\.claude\/\.ow-/.test(k);
}

/** 取 `Write`/`Edit`/`NotebookEdit` 的目标路径。 */
function fileTargetsOf(toolName, ti) {
  if (!ti || typeof ti !== 'object') return [];
  const raw = [ti.file_path, ti.notebook_path, ti.path, ti.target_file];
  return raw.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
}

/** PowerShell 里会落盘的命令。含官方别名（`sc` 就是 `Set-Content`，最容易漏）。 */
const PS_WRITE_VERBS = Object.freeze([
  'set-content', 'add-content', 'clear-content', 'out-file', 'tee-object',
  'new-item', 'set-item', 'copy-item', 'move-item', 'rename-item',
  'export-csv', 'export-clixml', 'set-clipboard',
  // 别名
  'sc', 'ac', 'clc', 'ni', 'si', 'cpi', 'copy', 'mi', 'move', 'rni', 'ren',
  'epcsv', 'epxml',
]);

/** 会「再跑一条看不见的命令」的动词：解析不出来，必须计数。 */
const PS_OPAQUE_VERBS = Object.freeze([
  'invoke-expression', 'iex', 'invoke-command', 'icm', 'start-process', 'saps',
  'start-job', 'sajb', 'invoke-item', 'ii', '&', 'call',
]);

/** 取 `-Path`/`-FilePath`/… 的值，否则取第一个位置参数。`null` = 判不出。
 *
 *  `-Value` 是**内容**不是路径，绝不能被当成目标 —— 否则 `Set-Content -Value 'x'`
 *  会把内容字符串当成文件名。这类「参数名近义」的坑在 PowerShell 比 Bash 多得多。 */
function psTargets(argv) {
  const pathFlags = /^-(path|filepath|literalpath|destination|target|outfile|pspath)$/i;
  const valueFlags = new Set([
    '-value', '-encoding', '-itemtype', '-force', '-name', '-inputobject',
    '-append', '-nonewline', '-width', '-delimiter', '-confirm', '-whatif', '-asbytestream',
    '-filter', '-include', '-exclude', '-recurse',
  ]);
  const out = [];
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^-/.test(a)) {
      if (pathFlags.test(a) && i + 1 < argv.length) { out.push(argv[i + 1]); i++; continue; }
      if (valueFlags.has(a.toLowerCase()) && i + 1 < argv.length) { i++; continue; }
      continue;
    }
    positional.push(a);
  }
  const picked = out.length ? out : positional.slice(0, 1);
  return picked.length ? picked : null;
}

/** PowerShell 命令是不是写文件。返回 `{isWrite, paths, dirs, unresolved}`。
 *
 *  这一支是 G6 那条实测洞的补丁：`Set-Content -Path gated.txt -Value 'x'` 在只 matcher
 *  `Write|Edit` 的闸门下照常落盘。 */
export function powershellWriteScan(cmd) {
  const scan = { isWrite: false, paths: [], dirs: 0, unresolved: 0 };
  const text = typeof cmd === 'string' ? cmd : '';
  if (!text.trim()) return scan;

  // `[IO.File]::WriteAllText(...)` / `[System.IO.File]::AppendAllText(...)`
  if (/\[(?:System\.)?IO\.File\]::(?:Write|Append)\w+/i.test(text)) {
    scan.isWrite = true;
    scan.unresolved++;
  }

  // 按语句分隔符切。PowerShell 的 `;` 与换行都是分隔符，`|` 是管道（左侧可能是写）。
  const segments = text.split(/[;\n]/).flatMap((s) => s.split(/\|(?!\|)/));
  for (const segRaw of segments) {
    const seg = segRaw.trim();
    if (!seg) continue;

    // 重定向：`>`, `>>`, `1>`, `2>`, `*>`, `2>&1` 不是写文件
    const redir = /(?:^|\s)(?:\*|\d)?>{1,2}(?:&(?:\d+|-))?\s*([^\s;|]+)/g;
    for (const m of seg.matchAll(redir)) {
      const target = m[1];
      if (m[0].includes('&') && /^&?(?:\d+|-)$/.test(target)) continue;
      if (!target || /^&/.test(target)) continue;
      scan.isWrite = true;
      scan.paths.push(target.replace(/^["']|["']$/g, ''));
    }

    // 命令词：跳过 `$x = ` 这类赋值前缀
    const tokens = seg.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && (/^[$@(]/.test(tokens[i]) || tokens[i].includes('='))) i++;
    if (i >= tokens.length) continue;
    const verb = tokens[i].replace(/^["']|["']$/g, '').toLowerCase();
    const argv = tokens.slice(i + 1).map((t) => t.replace(/^["']|["']$/g, ''));

    if (PS_OPAQUE_VERBS.includes(verb)) { scan.unresolved++; continue; }
    if (!PS_WRITE_VERBS.includes(verb)) continue;

    // 建目录不是写文件内容（和 Bash 侧 `mkdir` 的处置一致）
    const itemType = argv.findIndex((a) => /^-itemtype$/i.test(a));
    const isDir = (itemType >= 0 && /^(directory|dir|container)$/i.test(argv[itemType + 1] || ''))
      || ['mkdir', 'md', 'new-item'].includes(verb) && /-itemtype\s+(directory|dir)/i.test(seg);
    if (isDir) { scan.dirs++; continue; }

    const targets = psTargets(argv);
    if (!targets) { scan.unresolved++; continue; }
    scan.isWrite = true;
    for (const t of targets) scan.paths.push(t);
  }
  return scan;
}

/** 一次工具调用是不是「写文件」。
 *
 *  返回 `{isWrite, via, paths, dirs, unresolved}`。`unresolved>0` 表示命令里有我们解析不出来的
 *  片段（`sh -c`、`xargs`、`iex`）——**计数但不当写**，见文件头 §诚实边界。 */
export function writeIntentOf(toolName, toolInput, cwd) {
  const name = String(toolName || '');
  const res = { isWrite: false, via: 'none', paths: [], dirs: 0, unresolved: 0 };
  if (!name) return res;

  if (WRITE_TOOLS.includes(name)) {
    const paths = fileTargetsOf(name, toolInput);
    res.isWrite = paths.length > 0;
    res.via = 'file-tool';
    res.paths = paths;
    return res;
  }

  if (SHELL_TOOLS.includes(name)) {
    const cmd = toolInput && typeof toolInput === 'object'
      ? (toolInput.command ?? toolInput.script ?? toolInput.CommandLine ?? '')
      : '';
    if (typeof cmd !== 'string' || !cmd.trim()) return res;
    res.via = name === 'PowerShell' ? 'powershell' : 'bash';
    if (name === 'PowerShell') {
      const s = powershellWriteScan(cmd);
      res.isWrite = s.isWrite;
      res.paths = s.paths;
      res.dirs = s.dirs;
      res.unresolved = s.unresolved;
      return res;
    }
    // Bash 侧复用已过测试的实现（`claim-ledger.mjs` 的 tokenizer）。
    // cwd 不可知时相对路径判不出，`bashWriteScan` 会记 unresolved —— 保守方向。
    let s;
    try {
      s = bashWriteScan(cmd, cwd || null);
    } catch {
      res.unresolved++;
      return res;
    }
    res.isWrite = s.writes.length > 0;
    res.paths = s.writes.map((w) => w.path);
    res.dirs = s.dirs;
    res.unresolved = s.unresolved + (s.abortedForCwd || s.abortedSubshell ? 1 : 0);
    return res;
  }

  return res; // 未知工具：不判写，放行（由 checkUnregistered / 日志暴露）
}

// ── transcript：数「读过什么」 ────────────────────────────────────────

/** 一次工具调用读到了哪些文件路径。**纯函数**：不读盘、不看状态。
 *
 *  这是「什么叫读过项目」的**唯一实现**。`readTranscriptReads()`（闸门）与
 *  `observe-reality-check.mjs` 的重放器都调它 —— 重放器曾经自己写了一份，
 *  于是闸门改动词表后重放不会跟着变，报告上的百分比就成了不可复算的话。
 *  分叉规模见 `scripts/probe-parser-divergence.mjs`。
 *
 *  已知缺陷（本轮**不修**，修它会改变闸门行为）：带独立值的选项把值当成路径 ——
 *  `head -n 20 a.mjs` 取到 `20`。方向是多算（更宽松）。这个缺陷被
 *  `observe-reality-check.test.mjs` 钉在测试里，将来修它会红。 */
export function readPathsOfToolUse(name, input, readVerbs = SHELL_READ_VERBS) {
  const out = [];
  const n = String(name || '');
  const inp = input && typeof input === 'object' ? input : {};
  // 与闸门原实现（内联的 `add()`）逐字一致：trim 后为空即不计数。
  // 这一条不是美化 —— 空白路径曾被重放器数成一个文件，是实测确认的分叉点之一。
  const add = (raw) => {
    const v = String(raw ?? '').trim();
    if (v) out.push(v);
  };
  if (READ_TOOLS.includes(n)) {
    add(inp.file_path || inp.notebook_path || inp.path);
    return out;
  }
  if (n !== 'Bash' && n !== 'PowerShell') return out;
  const cmd = typeof inp.command === 'string' ? inp.command : '';
  if (!cmd) return out;
  // 只认「整份读」的动词，避免把 `grep`/`ls`/`Get-ChildItem` 当成读过内容
  for (const seg of cmd.split(/[;|&\n]/)) {
    const t = seg.trim().split(/\s+/);
    let i = 0;
    while (i < t.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i]))) i++;
    const verb = basename(String(t[i] || '')).replace(/\.exe$/i, '').toLowerCase();
    if (!readVerbs.includes(verb)) continue;
    for (const a of t.slice(i + 1)) {
      if (/^-/.test(a)) continue;
      add(/^["']|["']$/.test(a) ? a.replace(/^["']|["']$/g, '') : a);
      break;
    }
  }
  return out;
}

/** 从 transcript 文本里数「读过哪些不同文件」。**纯函数**：文本进、数组出。
 *
 *  与 `readTranscriptReads` 的关系：后者负责「读文件尾部」，把文本交给本函数。
 *  两者分开是为了让重放器能用**同一段文本**、**同一个判据**，而不是复制一份循环。 */
export function readPathsInTranscriptText(text, readVerbs = SHELL_READ_VERBS) {
  const seen = new Set();
  const paths = [];
  let lines = 0;
  let unparsable = 0;
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    lines++;
    let rec;
    try { rec = JSON.parse(s); } catch { unparsable++; continue; }
    const content = rec && rec.message && Array.isArray(rec.message.content) ? rec.message.content : null;
    if (!content) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      for (const raw of readPathsOfToolUse(b.name, b.input, readVerbs)) {
        const k = pathKeyOf(raw);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        paths.push(raw);
      }
    }
  }
  return { paths, lines, unparsable };
}

/** 从 transcript 尾部数「本会话读过哪些不同文件」。**只读，不写**。
 *
 *  `transcript_path` 是宿主给的绝对路径，实测可读。读尾部而不是全文件：判定在每一次
 *  PreToolUse 上都要跑，全量扫 1.5 GB 语料是不可接受的延迟。尾部 1MB 足够覆盖一个
 *  「刚读完项目、马上要写」的会话。
 *
 *  返回 `{paths, bytesRead, lines, truncatedFirst, unparsable}`。 */
export function readTranscriptReads(transcriptPath, { bytes = 1024 * 1024, readVerbs = SHELL_READ_VERBS } = {}) {
  const out = { paths: [], bytesRead: 0, lines: 0, truncatedFirst: false, unparsable: 0 };
  const p = String(transcriptPath || '');
  if (!p) return out;
  let buf;
  try {
    const r = readTailBytes(p, bytes);
    if (!r) return out;
    buf = r.buf;
    out.bytesRead = r.bytesRead;
  } catch {
    return out;
  }
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  // 从中间切进去时第一行必然是半条，丢掉 —— 否则会多出一个 unparsable
  if (out.bytesRead >= bytes && lines.length > 1) { lines.shift(); out.truncatedFirst = true; }

  const parsed = readPathsInTranscriptText(lines.join('\n'), readVerbs);
  out.paths = parsed.paths;
  out.lines = parsed.lines;
  out.unparsable = parsed.unparsable;
  return out;
}

/** 有界从尾��读。返回 `{buf, bytesRead}` 或 null。
 *
 *  用 fd + `readSync` 而不是 `readFileSync` 再截：开源节流——一个 1.5 GB transcript
 *  读进来再切，等于每小时把整个语料搬进内存若干次，而判定只需要尾部。
 *  单独抽出来也是为了让它可被单测打桩（读不到就返回 null）。 */
function readTailBytes(p, bytes) {
  let fd = null;
  try {
    fd = openSync(p, 'r');
    const size = fstatSync(fd).size;
    const want = Math.max(0, Math.min(size, Number(bytes) || 0));
    if (!want) return { buf: Buffer.alloc(0), bytesRead: 0 };
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, size - want + got);
      if (n <= 0) break;
      got += n;
    }
    return { buf: got === want ? buf : buf.subarray(0, got), bytesRead: got };
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// ── 标记文件 ─────────────────────────────────────────────────────────

/** 密钥长度（字节）。32 字节 = 256 位，用 `randomBytes` 生成，不依赖任何常量。 */
const SECRET_BYTES = 32;

/** 标记路径 → 会话 cwd。`<cwd>/.claude/.ow-read-done` 上两级就是 cwd。 */
function cwdOfMarker(markerPath) {
  const p = String(markerPath || '');
  return p ? dirname(dirname(p)) : '';
}

/** 读密钥。**只读，不生成** —— 校验路径不该有副作用。
 *  密钥必须是 `[0-9a-f]` 长串：坏内容（被写成一句玩笑、被截断）一律当没有。 */
export function readGateSecret(secretPath) {
  const p = String(secretPath || '');
  if (!p || !existsSync(p)) return null;
  try {
    const s = readFileSync(p, 'utf8').trim();
    return /^[0-9a-f]{32,128}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** 读密钥，没有就生成。**这是唯一会创建密钥的地方**，只在真要写 `auto` 标记时调用。
 *
 *  并发：两个会话同时首次运行会各写一份，后写的赢；所以写完**重读一次**，
 *  以盘上那份为准 —— 否则签名用的密钥和下次校验用的不是同一份，标记会立刻失效。 */
export function ensureGateSecret(secretPath) {
  const existing = readGateSecret(secretPath);
  if (existing) return existing;
  const p = String(secretPath || '');
  if (!p) return null;
  try {
    mkdirSync(dirname(p), { recursive: true });
    const s = randomBytes(SECRET_BYTES).toString('hex');
    writeFileSync(p, s + '\n', { mode: 0o600 });
    return readGateSecret(p) || s;
  } catch {
    return null;
  }
}

/** 签名字符串。字段顺序写死在一处 —— 两处各写一份就是分叉的起点。
 *
 *  签的字段**包含** `reads` / `reads_sample` / `verified_at`：改任何一个都会让签名失效，
 *  所以「写一个 `{"satisfied_by":"auto","reads":99}` 进去」不再等于「验过了 99 个」。 */
export function markerSigOf(data, secret) {
  const d = data && typeof data === 'object' ? data : {};
  const sample = Array.isArray(d.reads_sample) ? d.reads_sample.join('\n') : String(d.reads_sample || '');
  const parts = [
    Number(d.version) || 0,
    String(d.session_id || ''),
    String(d.at || ''),
    Number(d.reads) || 0,
    String(d.verified_at || ''),
    sample,
    String(d.prompt_id || ''),
  ];
  return createHmac('sha256', String(secret)).update(parts.join('\u0000')).digest('hex');
}

/** 校验签名。`secret` 为空（密钥文件不存在 / 读不出）时**一律 false** ——
 *  这条是刻意的：宁可让 `auto` 标记失效退回「查 transcript」，也不要让「没有密钥」
 *  变成「谁写的都算」。 */
export function verifyMarkerSig(data, secret) {
  const sec = typeof secret === 'string' ? secret : '';
  if (!sec) return false;
  const sig = data && typeof data.sig === 'string' ? data.sig : '';
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const want = markerSigOf(data, sec);
  try {
    return timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

/** 读标记。返回 `{exists, data, error}`。坏 JSON 视为「存在但不合法」，由 `markerValidity` 判。 */
export function readMarker(markerPath) {
  const p = String(markerPath || '');
  if (!p || !existsSync(p)) return { exists: false, data: null, error: null };
  try {
    const raw = readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { exists: true, data: null, error: 'not-an-object' };
    }
    return { exists: true, data, error: null };
  } catch (e) {
    return { exists: true, data: null, error: String((e && e.message) || e).slice(0, 120) };
  }
}

/** 写标记。`satisfied_by` 把「验出来的」和「自述的」分开，这是事后审计的唯一依据。
 *
 *  `satisfied_by:"auto"` 必然带签名；**签不出来就不写**（返回 null），
 *  因为一个验不过的 `auto` 标记比没有标记更糟：它会让盘上看起来「已满足」。
 *  `claim` 不签 —— 它本来就是自述，签了反而会让人误读成「验出来的」。 */
export function writeMarker(markerPath, {
  sessionId = '', satisfiedBy = 'claim', reads = 0, promptId = '', readsSample = null,
  nowMs = Date.now(), secret = null,
} = {}) {
  const p = String(markerPath || '');
  if (!p) return null;
  const auto = satisfiedBy === 'auto';
  let sec = null;
  if (auto) {
    sec = String(secret || '') || ensureGateSecret(secretPathFor(cwdOfMarker(p)));
    if (!sec) return null;
  }
  const at = new Date(nowMs).toISOString();
  const data = {
    version: 1,
    session_id: String(sessionId || ''),
    at,
    satisfied_by: satisfiedBy,
    reads: Number(reads) || 0,
    prompt_id: String(promptId || ''),
  };
  if (auto) {
    data.verified_at = at;
    if (Array.isArray(readsSample) && readsSample.length) data.reads_sample = readsSample.slice(0, 5);
    data.sig = markerSigOf(data, sec);
  }
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
    return data;
  } catch {
    return null;
  }
}

/** 标记算不算数。
 *
 *  默认**绑定 session**：标记是「这个 AI 读过这个项目」的断言，换一个会话就是一个没读过
 *  项目的新 AI。`crossSession=true` 时放宽成「这个目录曾经有人读过」。
 *  `satisfied_by` 原样带出来，`deny`/`allow` 的日志里都留着。
 *
 *  **标记里没有 session_id 时判无效**，这一条是刻意选的严格方向。曾经的写法是「没写
 *  session 就当作通配」，那会在盘上留一个永久有效的标记：本会话建过一次，之后**每一个**
 *  新会话都被静默放行 —— 闸门从此形同不存在，而且日志里看起来一切正常。宁可让一条
 *  没有 session 的标记失效（AI 会照 reason 重跑一次带 `--session` 的命令），
 *  也不要留一个悄悄失效的闸门。
 *
 *  **`satisfied_by:"auto"` 必须带合法签名**（见 `verifyMarkerSig`）。密钥由调用方通过
 *  `state.secret` 传入 —— `decide()` 保持纯函数，不自己读盘。`claim` 不需要签名。 */
export function markerValidity(state, input, cfg = defaultConfig()) {
  const m = state && state.marker ? state.marker : { exists: false, data: null };
  if (!m.exists) return { valid: false, why: 'missing', by: null, data: null };
  const d = m.data;
  if (!d) return { valid: false, why: 'unparsable', by: null, data: null };
  const by = typeof d.satisfied_by === 'string' ? d.satisfied_by : 'unknown';
  const sid = String((input && input.session_id) || '');
  const msid = String(d.session_id || '');
  if (!msid) return { valid: false, why: 'marker-without-session', by, data: d };
  // 会话先判：换会话是更严重的问题，不该被「签名对了」盖过去。
  if (cfg.crossSession) return finish(markerSigCheck(state, d, by));
  if (!sid) return { valid: false, why: 'no-session-in-input', by, data: d };
  if (msid !== sid) return { valid: false, why: 'other-session', by, data: d };
  return finish(markerSigCheck(state, d, by));

  /** `satisfied_by` 只认两个值；`auto` 还要过签名。 */
  function markerSigCheck(st, data, kind) {
    if (kind !== 'auto' && kind !== 'claim') {
      return { valid: false, why: 'unknown-satisfied-by', by: kind, data };
    }
    if (kind === 'claim') return { valid: true, why: 'same-session', by: kind, data };
    const sec = st && typeof st.secret === 'string' ? st.secret : null;
    if (!sec) return { valid: false, why: 'auto-no-secret', by: kind, data };
    if (!verifyMarkerSig(data, sec)) {
      return { valid: false, why: data && data.sig ? 'auto-bad-signature' : 'auto-unsigned', by: kind, data };
    }
    return { valid: true, why: 'same-session', by: kind, data };
  }
  function finish(v) {
    if (v.valid && cfg.crossSession) return { valid: true, why: 'cross-session-allowed', by: v.by, data: v.data };
    return v;
  }
}


// ── reason：必须是可执行的指令链，不能是「请先了解项目」 ────────────────

/** 生成 reason。**唯一要求**：模型读完这一段就知道下一条命令该敲什么。
 *
 *  实测依据：reason 原文会作为 `is_error` 的 `tool_result` 内容回到模型（B1/D4）。
 *  所以它是一段 prompt，不是一条错误消息。 */
export function reasonFor({ cwd, markerPath, gateCommand, minReads, halt, denialCount, maxDenials }) {
  const c = String(cwd || '.');
  const need = Number(minReads) || 3;
  const lines = [
    `[overwatch] 写前闸：你还没读过这个项目，所以这次写入被拒绝。`,
    ``,
    `在写任何文件之前，按顺序做完这三步：`,
    `1. 读 ${c}/CLAUDE.md（若不存在则跳过）、${c}/README.md，`,
    `   以及至少 ${Math.max(0, need - 2)} 个源码文件（用 Read，不要用 Bash cat）。这算「读过项目」。`,
    `2. 若有你还不确定的点，用 AskUserQuestion 一次问清（最多 5 个）；没有就跳过这步。`,
    `3. 创建标记，然后原样重试你刚才那次写：`,
    `   ${gateCommand}`,
    ``,
    `标记一旦存在，本会话后续的写不会再被拦。`,
    `注意：不要绕过闸门（用 shell 重定向、Set-Content、或者直接写标记文件都不算读过）。`,
    `标记里记着它是「验出来的」（satisfied_by:"auto"，必须有闸门自己签的 sig）还是`,
    `「自己说的」（"claim"，一条自述）—— 两者事后都查得到；手写的 "auto" 标记会被拒。`,
  ];
  if (halt) {
    lines.push(
      ``,
      `本次拒绝同时结束了本回合（reason: 宿主对 PreToolUse 拒绝**没有次数上限**，不刹车会无限重试）。`,
      `下一步：先用 Read 读上面的文件，再运行第 3 步的命令，然后重试写入。`,
    );
  } else if (denialCount > 0) {
    lines.push(``, `这是本回合第 ${denialCount + 1}/${maxDenials} 次拒绝；到上限后本回合会被强制结束。`);
  }
  return lines.join('\n');
}

// ── 判定（纯函数）────────────────────────────────────────────────────

/** 判定一次 PreToolUse。**纯函数**：不读盘、不写盘、不读环境变量。
 *
 *  返回 `{action, output, markWrite, log}`：
 *    · `action`     `passthrough` | `allow` | `warn` | `deny`
 *    · `output`     要写到 stdout 的 JSON 对象；`passthrough` 时为 `null`（什么都不输出）
 *    · `markWrite`  `{satisfiedBy, reads, promptId}` 或 `null`；由 `runHook` 落盘
 *    · `log`        一行记账，永远是对象
 *
 *  ## 为什么 action 不直接叫 `deny`/`allow`
 *  「不输出」与「输出 allow」在宿主上不等价：前者是「本 hook 不参与」，后者会参与
 *  `deny>ask>allow` 的合并（实测二进制逻辑）。多个 hook 并存时，静默才是对的。 */
export function decide(input, state = {}) {
  const cfg = state.config || defaultConfig();
  const log = { at: new Date().toISOString(), mode: cfg.mode, brake: cfg.brake };
  const passthrough = (reason, extra = {}) => ({
    action: 'passthrough', output: null, markWrite: null,
    log: { ...log, decision: 'passthrough', allowReason: reason, ...extra },
  });

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return passthrough('unparsable-input');
  }
  if (input.hook_event_name && input.hook_event_name !== 'PreToolUse') {
    return passthrough('wrong-event', { event: String(input.hook_event_name) });
  }

  const tool = String(input.tool_name || '');
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : null;
  const cwd = String(input.cwd || state.cwd || process.cwd());
  const markerPath = state.markerPath || markerPathFor(cwd);
  const intent = writeIntentOf(tool, ti, cwd);
  const secretPath = state.secretPath || secretPathFor(cwd);

  log.tool = tool;
  log.via = intent.via;
  log.unresolved = intent.unresolved;

  if (!intent.isWrite) {
    // 未知工具 / 只读命令 / 建目录 —— 不参与。「unknown-tool」单独留名，
    // 因为 matcher 与宿主工具名漂移时会从这里看出来。
    const why = intent.via === 'none' ? 'unknown-tool'
      : (intent.dirs > 0 && !intent.paths.length ? 'dir-only' : 'not-a-write');
    return passthrough(why, { dirs: intent.dirs });
  }
  log.paths = intent.paths.slice(0, 5);

  // 密钥文件本身**不**走 `gate-own-file`：那是「闸门自己的文件，否则自锁」白名单，
  // 而密钥一旦可写，签名就等于不存在。改密钥 = 改判据，必须报出来。
  if (intent.paths.length && intent.paths.every((p) => pathKeyOf(p) === pathKeyOf(secretPath))) {
    return passthrough('secret-tamper', { secretPath });
  }

  // 闸门自己的文件必须放行，否则标记永远写不出来（自锁）。
  if (intent.paths.length && intent.paths.every((p) => isGateOwnedPath(p, cwd))) {
    return passthrough('gate-own-file');
  }

  const mv = markerValidity(state, input, cfg);
  log.marker = mv.why;
  log.markerPath = markerPath;

  if (mv.valid) {
    return {
      action: 'allow', output: null, markWrite: null,
      log: { ...log, decision: 'allow', allowReason: 'marker-present', satisfiedBy: mv.by },
    };
  }

  // (b) 主路：transcript 里已经读过够多的文件 → 自己写标记并放行。
  // 注意「够多」不是「尝试过」：数的是**不同文件路径**，读同一个文件 50 次也只算 1 个。
  //
  // `state.reads` 可以是数组（测试注入），也可以是函数（`runHook` 注入，**惰性**读盘）。
  // 惰性的理由：标记在盘上时根本不需要 transcript；只有正要拒绝时才值得花那次读。
  const reads = typeof state.getReads === 'function'
    ? (state.getReads() || [])
    : (Array.isArray(state.reads && state.reads.paths) ? state.reads.paths : []);
  log.reads = reads.length;

  // ── 判据一（Edit 侧）：改**已有**文件时，判据换成「读过这个文件本身」。 ──────────
  //
  // 实测（`node scripts/resolution-gate-audit.mjs --only R8`）：真实项目 18/18 个 Edit-first
  // 会话都在改之前读过目标文件，而「读过 ≥3 个不同文件」仍误拦其中 4 个 —— 这 4 个**全都**
  // 读过自己的目标。误伤是纯损失，所以换锚点。
  //
  // 本机复算（`observe-reality-check.mjs` 的 analyzeOne，435 份 transcript）：
  //   真实 Edit-first 18 个：targetRead 18 · reads≥3 且**没**读目标 0 个
  //   沙箱 Edit-first  8 个：targetRead  7 · reads≥3 且**没**读目标 0 个
  // 也就是说「读过几个」在 Edit 侧**一次都没单独起过作用** —— 两种读法在现有语料上等价，
  // 而换锚点后 4 个误伤归零。代价是把「读了 3 个无关文件就改一个没读过的文件」也拦下，
  // 这一条与宿主自己的 Edit 门一致（它同样对「改一个没读过的既有文件」报错），是**更严**、不是更松。
  //
  // 安全兜底：任何通过的 `Write` 都会落标记（`auto` 或 `claim`），所以「先写新文件、再 Edit 它」
  // 走的是 `marker-present`，不会掉进这一支。
  //
  // **不写标记**：它只证明「这一个文件读过」，不证明「读过这个项目」。
  const editSide = EDIT_SIDE_TOOLS.includes(tool);
  const targetKeys = editSide ? new Set(reads.map(pathKeyOf).filter(Boolean)) : null;
  const hitTarget = targetKeys
    ? intent.paths.map(pathKeyOf).filter((k) => k && targetKeys.has(k))
    : [];
  if (hitTarget.length) {
    return {
      action: 'allow', output: null, markWrite: null,
      log: {
        ...log, decision: 'allow', allowReason: 'target-read',
        satisfiedBy: null, target: hitTarget[0],
      },
    };
  }

  // 判据二（Write / shell 侧）：行为**一行未改** —— 仍是「读过 ≥minReads 个不同文件」。
  // `editSide` 显式排除它，否则「读了 5 个无关文件」会被这条放行，Edit 侧就等于没改。
  if (!editSide && cfg.minReads > 0 && reads.length >= cfg.minReads) {
    return {
      action: 'allow',
      output: null,
      markWrite: { satisfiedBy: 'auto', reads: reads.length, promptId: String(input.prompt_id || ''), readsSample: reads.slice(0, 5) },
      log: {
        ...log, decision: 'allow', allowReason: 'auto-satisfied-by-transcript',
        satisfiedBy: 'auto', readSample: reads.slice(0, 5),
      },
    };
  }

  const common = {
    cwd, markerPath,
    minReads: cfg.minReads,
    denialCount: Number(state.denials) || 0,
    maxDenials: Number(state.denyBudget) || 0,
  };
  const gateCommand = state.gateCommand
    || `node ${join(REPO_ROOT, 'scripts', 'pre-write-gate.mjs')} mark --session ${String(input.session_id || '<session_id>')}`;

  if (cfg.mode === 'observe') {
    return {
      action: 'passthrough', output: null, markWrite: null,
      log: { ...log, decision: 'would-deny', allowReason: 'observe-mode', reason: reasonFor({ ...common, gateCommand, halt: false }) },
    };
  }

  if (cfg.mode === 'warn') {
    // 实测：PreToolUse 的 additionalContext 只注入一次，不引发循环（G2）。
    // 所以「提醒但不拦」这一档有宿主行为支撑，不是我们编的。
    return {
      action: 'warn',
      output: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: reasonFor({ ...common, gateCommand, halt: false }),
        },
      },
      markWrite: null,
      log: { ...log, decision: 'warn', allowReason: 'warn-mode' },
    };
  }

  // deny。刹车策略决定要不要 continue:false（硬约束 ②）。
  const halt = cfg.brake === 'halt' || (Number(state.denials) || 0) >= (Number(cfg.denyBudget) || 0);
  const reason = reasonFor({ ...common, gateCommand, halt });
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  if (halt) {
    // 顶层 continue:false —— G4 实测「一轮即停」。
    output.continue = false;
    output.stopReason = '[overwatch] pre-write gate: 未读项目就写文件，已拒绝并结束本回合。';
  }
  return {
    action: 'deny', output, markWrite: null,
    log: { ...log, decision: 'deny', halted: halt, satisfiedBy: null, reasonLen: reason.length },
  };
}

// ── 记账 ────────────────────────────────────────────────────────────

/** 记账文件路径。
 *
 *  优先级：`OW_PRE_WRITE_GATE_LOG`（显式覆盖，测试与试跑用它）→
 *  `OVERWATCH_STATE_DIR`（本仓脚本统一的临时区变量，硬门的探针会设它 ——
 *  否则「调用一次 export 看它炸不炸」就会真的往仓库里写一行日志）→
 *  仓库默认的 `tasks/runs/pre-write-gate/<日期>.jsonl`。
 *
 *  最后一条是这台机器上的**本机会话**记账，`tasks/runs/` 本来就是 gitignored，
 *  里面允许出现会话 ID。 */
export function logPathFor(env = {}, nowMs = Date.now()) {
  const override = String(env.OW_PRE_WRITE_GATE_LOG || '').trim();
  if (override) return override;
  const d = new Date(nowMs).toISOString().slice(0, 10);
  const stateDir = String(env.OVERWATCH_STATE_DIR || '').trim();
  if (stateDir) return join(stateDir, 'pre-write-gate', `${d}.jsonl`);
  return join(REPO_ROOT, 'tasks', 'runs', 'pre-write-gate', `${d}.jsonl`);
}

export function appendLog(record, env = {}, nowMs = Date.now()) {
  const p = logPathFor(env, nowMs);
  try {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(record) + '\n');
    return true;
  } catch {
    return false;
  }
}

/** 读 / 推进「本回合已拒绝几次」的计数器。**只用于刹车**，绝不参与判定。 */
export function bumpDenials(path, promptId, { readOnly = false } = {}) {
  const key = String(promptId || '');
  let state = { prompt_id: key, n: 0 };
  try {
    if (existsSync(path)) {
      const cur = JSON.parse(readFileSync(path, 'utf8'));
      if (cur && cur.prompt_id === key) state = { prompt_id: key, n: Number(cur.n) || 0 };
    }
  } catch { /* 坏文件按 0 起算 */ }
  if (readOnly) return state.n;
  const next = { prompt_id: key, n: state.n + 1 };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next) + '\n');
  } catch { /* 记不上就退回 halt 语义由调用方处理 */ }
  return next.n;
}

// ── 组装：读盘 → decide → 写盘 ───────────────────────────────────────

/** 把一次 PreToolUse 从「输入对象」跑到「stdout 对象」。
 *
 *  副作用集中在这里：读标记、读 transcript、写标记、记账。`decide` 保持纯，
 *  所以判定逻辑可以被单测穷举。 */
export function runHook(input, { env = {}, nowMs = Date.now(), cwd: cwdOverride = null } = {}) {
  const cfg = configOf(env);
  const cwd = String((input && input.cwd) || cwdOverride || process.cwd());
  const markerPath = markerPathFor(cwd);
  const denialPath = denialPathFor(cwd);
  const secretPath = secretPathFor(cwd);
  const promptId = String((input && input.prompt_id) || '');

  // transcript 惰性读：标记在盘上就直接放行，那次读不该发生。
  let cached = null;
  const getReads = () => {
    if (cached === null) {
      cached = (input && input.transcript_path)
        ? readTranscriptReads(input.transcript_path, { bytes: cfg.transcriptBytes }).paths
        : [];
    }
    return cached;
  };

  // 密钥**只读不生成**：校验一次判定的路径不该在盘上留东西。生成只发生在
  // `writeMarker({satisfiedBy:"auto"})` 里 —— 那才是真需要签名的时刻。
  // 副作用集中在这里、`ensureGateSecret` 只在写标记里调用，所以这两个读盘动作
  // 都归 `runHook`，`decide()` 依旧是纯函数。
  const state = {
    config: cfg,
    cwd,
    markerPath,
    secretPath,
    marker: readMarker(markerPath),
    secret: readGateSecret(secretPath),
    getReads,
    denials: bumpDenials(denialPath, promptId, { readOnly: true }),
    gateCommand: gateCommandFor(input),
  };

  const out = decide(input, state);

  // 落盘只在判定之后 —— `decide` 保持纯，副作用全部收在这里。
  if (out.markWrite) {
    writeMarker(markerPath, {
      sessionId: String((input && input.session_id) || ''),
      satisfiedBy: out.markWrite.satisfiedBy,
      reads: out.markWrite.reads,
      promptId: out.markWrite.promptId,
      readsSample: out.markWrite.readsSample || null,
      secret: state.secret,
      nowMs,
    });
  }
  if (out.action === 'deny') bumpDenials(denialPath, promptId);
  if (out.log && typeof out.log === 'object') out.log.sessionId = String((input && input.session_id) || '');
  appendLog(out.log, env, nowMs);
  return out;
}

/** reason 里要模型「原样敲」的那条命令。抽出来只为可测。 */
function gateCommandFor(input) {
  const sid = String((input && input.session_id) || '');
  const script = join(REPO_ROOT, 'scripts', 'pre-write-gate.mjs').replace(/\\/g, '/');
  return `node "${script}" mark${sid ? ` --session ${sid}` : ''}`;
}

/** 读 stdin 全部内容。宿主可能不关管道，所以外层还要有时间闸（见 `main`）。 */
export function readStdin(stream, limitBytes = 4 * 1024 * 1024) {
  return new Promise((res) => {
    let buf = '';
    let done = false;
    const finish = () => { if (!done) { done = true; res(buf); } };
    stream.setEncoding('utf8');
    stream.on('data', (c) => {
      buf += c;
      if (buf.length > limitBytes) finish();
    });
    stream.on('end', finish);
    stream.on('error', finish);
    if (stream.readableEnded) finish();
  });
}

/** 安全解析 hook 输入。解析失败返回 `null` → 调用方 fail-open。 */
export function parseHookInput(text) {
  try {
    const o = JSON.parse(String(text || ''));
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    return o;
  } catch {
    return null;
  }
}

/** 预算（毫秒）。闸门挡在每一次写之前，慢就是直接的体感伤害。
 *  超预算 = 放行 + 记账 —— 用户的「写」比我们的判定重要。 */
export const DEFAULT_BUDGET_MS = 5000;

/** CLI：`mark` / `status`。 */
export function cli(argv = [], env = process.env, nowMs = Date.now()) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const cmd = String(args[0] || '');
  const flag = (name, dflt = '') => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
  };
  const cwd = String(flag('--cwd', env.OW_PRE_WRITE_GATE_CWD || process.cwd()));
  const markerPath = markerPathFor(cwd);

  if (cmd === 'mark') {
    const data = writeMarker(markerPath, {
      sessionId: String(flag('--session', env.CLAUDE_CODE_SESSION_ID || '')),
      satisfiedBy: 'claim',
      reads: Number(flag('--reads', '0')),
      promptId: String(flag('--prompt-id', '')),
      nowMs,
    });
    if (!data) { process.stderr.write(`无法写入标记：${markerPath}\n`); return 1; }
    process.stdout.write(`标记已写入：${markerPath}\n${JSON.stringify(data)}\n`);
    return 0;
  }

  if (cmd === 'status') {
    const m = readMarker(markerPath);
    const cfg = configOf(env);
    const sec = readGateSecret(secretPathFor(cwd));
    const sig = m.exists && m.data && m.data.satisfied_by === 'auto'
      ? (verifyMarkerSig(m.data, sec) ? 'valid' : 'INVALID（缺签名或密钥不符 —— 这条 auto 不算数）')
      : '—';
    const lines = [
      `mode        : ${cfg.mode}`,
      `brake       : ${cfg.brake}${cfg.brake === 'budget' ? `（前 ${cfg.denyBudget} 次不刹车）` : ''}`,
      `minReads    : ${cfg.minReads}`,
      `cwd         : ${cwd}`,
      `marker      : ${markerPath}`,
      `marker state: ${m.exists ? (m.error ? `exists-but-broken (${m.error})` : `exists ${JSON.stringify(m.data)}`) : 'absent'}`,
      `secret      : ${sec ? 'present' : 'absent'}（${secretPathFor(cwd)}）`,
      `marker sig  : ${sig}`,
    ];
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }

  process.stderr.write(
    '用法：node scripts/pre-write-gate.mjs [mark|status] [--session <id>] [--reads <n>] [--cwd <dir>]\n'
    + '无子命令 = hook 入口（stdin 进，stdout 出）。\n',
  );
  return 2;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length) {
    process.exit(cli(argv));
    return;
  }
  const env = process.env;

  let raw = '';
  const guard = new Promise((r) => setTimeout(() => r('__TIMEOUT__'), DEFAULT_BUDGET_MS));
  try {
    raw = await Promise.race([readStdin(process.stdin), guard]);
  } catch {
    raw = '';
  }
  if (raw === '__TIMEOUT__') {
    appendLog({ at: new Date().toISOString(), decision: 'passthrough', allowReason: 'hook-budget-exceeded' }, env);
    return;
  }

  const input = parseHookInput(raw);
  if (!input) {
    // fail-open：输入坏了不是「该拦」的理由。
    appendLog({ at: new Date().toISOString(), decision: 'passthrough', allowReason: 'unparsable-input', bytes: String(raw || '').length }, env);
    return;
  }

  let out;
  try {
    out = runHook(input, { env });
  } catch (e) {
    appendLog({
      at: new Date().toISOString(), decision: 'passthrough',
      allowReason: 'hook-internal-error', error: String((e && e.message) || e).slice(0, 200),
    }, env);
    return;
  }
  if (out && out.output) process.stdout.write(JSON.stringify(out.output) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then(() => process.exit(0)).catch(() => process.exit(0));
}
