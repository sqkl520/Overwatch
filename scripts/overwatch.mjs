#!/usr/bin/env node
/**
 * overwatch.mjs — 这个应用的**唯一入口**。
 *
 * 为什么需要它（不是又一个脚本）：陌生人首次运行审计
 * （`docs/research/2026-11-14-stranger-first-run-audit.md`）实测了四个真卡点，
 * 其中三个的成因是同一个 —— **没有一个地方回答「我装对了没有」**：
 *
 *   1. 干净 clone 上不知道第一条命令该跑什么；
 *   2. 测试命令在 cmd.exe/PowerShell + Node 20 下报「文件找不到」，而没人告诉他自己的
 *      Node 够不够（真实下限：用工具 18.20.4，跑测试 20.16.0 —— 见
 *      `docs/research/2026-11-14-portability-audit.md` §1.1）；
 *   3. 首跑 TUI 第一屏是「✗ 监视未在跑 · 先修这个」，而这七个字在
 *      README / GUIDE / CAPABILITIES 里 0 命中。
 *
 * 所以本文件的产出不是「更多功能」，是**一句可核对的前提陈述**。
 *
 * ── 首屏的四条硬规则（每条都有对应测试，见 overwatch.test.mjs）─────────────
 *
 * 1. **PLAN 先行**：第一行说清查什么、几项、预算多少毫秒。不许先打结果再解释。
 * 2. **每项带耗时**：用户知道卡在哪一项。
 * 3. **每行只说「读到了什么」，不打印红绿灯**。理由：一个 ✓ 会让人以为「没问题」，
 *    而「读到了 Node v26.12.1」才是事实。判定留给用户，或留给最后一行的那一句结论。
 *    ⚠ 本规则约束的是**本文件自己写的行**；被复用的脚本（写前闸、install-watcher）
 *    输出的 ✓/✗ 在转发时就去掉，只留它说的词 —— 判定权仍归它，本文件不重算。
 * 4. **空状态与坏状态必须可分**：没有 transcript 根（这台机器还没用过 Claude Code）
 *    和「根在、但读不出」（权限/类型）是两件事。输出不同，退出码也不同（2 vs 3）。
 *
 * ── 为什么是「编排」而不是「重新实现」────────────────────────────────────
 *
 * 这些检查的逻辑已经散在既有脚本里，且**各有各的实测来历**：
 *   写前闸的 mode/brake/marker/secret → `scripts/pre-write-gate.mjs status`
 *   守护进程的安装与存活            → `scripts/install-watcher.mjs status`
 *   transcript 根的位置             → `scripts/tui-meta.mjs` 的 projectsRoot()
 *   通知通道可用性                  → `scripts/notify.mjs` 的 isNotificationAvailable()
 *   数据目录 / 自启目录             → `scripts/install-watcher.mjs` 的 stateDirFor()/startupDir()
 *
 * 本文件**只 import 与 spawn**，一份判据也不重写。理由见
 * `docs/research/2026-11-14-gate-widening-redteam.md` §4：同一个问题有第二份判据，
 * 两份必然漂移，而漂移的那份没人测。规矩：这里的每一行都必须是**转发来的原文**或
 * **一次 stat/readdir 的直接结果**，不得出现「我认为它算不算通过」。
 *
 * ── 耗时天花板 ──────────────────────────────────────────────────────────
 *
 * `doctor` 的预算是 **1000 ms**（本机基线：两次 spawn 并行约 400ms + 枚举 439 份
 * transcript 约 84ms）。它不该扫全量语料，只该检查前提条件 —— 一旦超预算，说明有人
 * 往里塞了扫描。所以预算是**硬约束**：到点还没跑完的项被如实标为「预算内未跑完」，
 * 而不是拖着让用户等（ADR-0002 诚实降级）。
 *
 * ── 退出码（每个码只有一个含义，文档与测试都对账）──────────────────────
 *
 *   0  前提都读到了
 *   1  本入口自己出了意外（bug，不是环境问题）
 *   2  transcript 根**不存在** —— 这台机器上还没有 Claude Code 的会话记录（「空」）
 *   3  transcript 根**在、但读不出** —— 权限或类型问题（「坏」）
 *   4  该子命令**未实现**，已打印等价的原生命令（有意为之：诚实的空壳，
 *      半成品的 wrapper 更坏 —— 它会假装实现了，然后和原命令悄悄分叉）
 *   5  用法错误（未知子命令 / 未知参数 / 参数缺值）
 *
 * 零 npm 依赖，只用 node: 内置模块。不写任何文件。
 */

import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { projectsRoot } from './tui-meta.mjs';
import { isNotificationAvailable } from './notify.mjs';
import { stateDirFor, startupDir } from './install-watcher.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/** 每个码只有一个含义。改这里等于改对外契约，必须同步 docs/spec/2026-11-14-entry-point.md。 */
const EXIT = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  ABSENT: 2,
  UNREADABLE: 3,
  ROUTED: 4,
  USAGE: 5,
});

/** doctor 的总预算。超了是设计错误，不是环境慢 —— 所以它是常量，不是环境变量。 */
const DEFAULT_BUDGET_MS = 1000;
/** 留给「打印 + 进程退出」的余量。真到点才收尾会连结果都印不全。 */
const PRINT_RESERVE_MS = 80;
/** transcript 枚举的分片上限：到点就停并如实标注「没数全」。 */
const ENUM_SLICE_MS = 400;

/** Node 下限。**不是 18**，逐版本实测见 portability-audit §1.1：
 *  18.20.4 能跑全部生产脚本；跑测试要 20.16.0（`process.getBuiltinModule`）。
 *  这里既报版本号也**直接探测那两个 API** —— 版本号是推断，API 在不在是事实。 */
const TOOL_MIN_VERSION = '18.20.4';
const TEST_MIN_VERSION = '20.16.0';

// ── 小工具 ────────────────────────────────────────────────────────────

const pad4 = (n) => String(Math.max(0, Math.round(n))).padStart(4, ' ');

/** 版本号比较。只比 major.minor.patch，够用且不引依赖。 */
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 转发外部脚本输出时去掉红绿灯与 markdown 强调。**只去字形，不改词** ——
 *  判定权留在写的那个脚本里，本文件不重算它说得对不对。 */
function stripGlyphs(s) {
  return String(s)
    .replace(/\*\*/g, '')
    .replace(/[✓✗⚠●○]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** 时长。与 TUI 的 fmtDur 同口径（秒 / 分 / 小时 / 天），但**没有负号分支**：
 *  审计里 `idle=-7s` 那个负数是 scan 的 nowMs 取样时机造成的，本文件不产生这种数字 ——
 *  时钟是可注入的（`--now`），算出来的差一定是「现在 - 过去」。 */
function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} 分钟`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小时`;
  return `${Math.round(h / 24)} 天`;
}

/** 目录计数。读不出就返回 null —— 这不是错误，是「没读到」，由调用方如实呈现。 */
function countEntries(dir, filter = null) {
  try {
    const names = readdirSync(dir);
    return filter ? names.filter(filter).length : names.length;
  } catch {
    return null;
  }
}

/** 一条 spawn 的封装。**不用 spawnSync**：两项状态检查要并行跑，
 *  串行时实测 150ms + 310ms = 460ms，并行 400ms —— 预算只有 1000ms。
 *
 *  到点必须**立刻结算**，不能「kill 之后等 close」：`install-watcher.mjs status`
 *  自己还会再 spawn 一个 `watch.mjs --health`，杀掉它不会杀掉孙进程，而管道要等
 *  孙进程退出才关 —— 于是「超时」变成了「超时之后再等一会儿」，实测墙钟 1145ms
 *  才回头（预算 1000ms）。这里超时即 finish，让上限成为真的上限。 */
function runNode(scriptRel, args, timeoutMs) {
  return new Promise((done) => {
    const started = Date.now();
    let out = '';
    let err = '';
    let finished = false;
    let timedOut = false;
    const finish = (payload) => {
      if (finished) return;
      finished = true;
      done({ ...payload, ms: Date.now() - started });
    };
    let child;
    try {
      child = spawn(process.execPath, [join(HERE, scriptRel), ...args], {
        cwd: REPO,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish({ ok: false, code: null, out: '', err: String(e && e.message), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      // **先结算，再 kill**：结算用的是已经读到的部分输出（如实转发），
      // 而 kill 只是别让子进程在后台继续吃 CPU。
      finish({ ok: false, code: null, out, err, timedOut: true });
      try { child.kill(); } catch { /* 已经退了 */ }
    }, Math.max(80, timeoutMs));
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, code: null, out, err: String(e && e.message), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, code, out, err, timedOut });
    });
  });
}

/** 写前闸的检查**在进程内调用它的 `cli()`**，而不是 spawn 一个新 node 把 `status` 跑一遍。
 *
 *  这是**复用同一份判据**，不是重写：被调的函数就是 `pre-write-gate.mjs` 自己导出的
 *  `cli(['status', '--cwd', REPO])`，输出也是它自己 `process.stdout.write` 出来的那几行 ——
 *  本文只负责把那段输出截获下来再去字形。判据一个字没抄。
 *
 *  为什么不 spawn：本机实测 spawn 一次要 210–350ms（`node -e 'console.log(0)'` 本身
 *  就是 210ms），而 `cli()` 本体只要 4ms。doctor 有两项要查，若都 spawn，那 900ms 里
 *  800ms 是「启动 Node」而不是「检查前提」—— 用户量的是后者有没有超预算。
 *
 *  `--cwd` 必须显式给：`cli()` 默认读 `process.cwd()`，而 doctor 的语义是「在**本仓库**里
 *  问闸门」。用户在别的目录敲 `node <repo>/scripts/overwatch.mjs` 时，不传 --cwd 就会去问
 *  那个目录的标记与密钥，与 spawn 版（cwd: REPO）结论不同 —— 同一份输出两个答案，
 *  正是本仓库最恨的那种缺陷。
 *
 *  取不到 `cli` 时退回 spawn：那是「这个模块的导出形状变了」，此时**必须**去跑原命令，
 *  因为本文件不许猜它现在怎么判。 */
async function checkGateInProcess(timeoutMs) {
  const started = Date.now();
  let mod;
  try {
    mod = await import('./pre-write-gate.mjs');
  } catch (e) {
    return { ok: false, code: null, out: '', err: String(e && e.message), timedOut: false, ms: Date.now() - started, via: 'import-failed' };
  }
  if (typeof mod.cli !== 'function') {
    const r = await runNode('pre-write-gate.mjs', ['status'], timeoutMs);
    return { ...r, via: 'spawn' };
  }
  // 截获它自己的 stdout。
  const realWrite = process.stdout.write;
  let buf = '';
  process.stdout.write = (chunk) => { buf += String(chunk); return true; };
  let code = 0;
  try {
    code = mod.cli(['status', '--cwd', REPO]);
  } catch (e) {
    process.stdout.write = realWrite;
    return { ok: false, code: null, out: buf, err: String((e && e.message) || e), timedOut: false, ms: Date.now() - started, via: 'in-process' };
  } finally {
    process.stdout.write = realWrite;
  }
  return { ok: code === 0, code, out: buf, err: '', timedOut: false, ms: Date.now() - started, via: 'in-process' };
}
function pickLabeled(text, label) {
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*([^\s:：][^:：]{0,24}?)\s{2,}(?:[:：]\s*)?(\S.*)$/)
      || line.match(/^\s*([^\s:：][^:：]{0,24}):\s*(\S.*)$/);
    if (m && m[1].trim() === label) return stripGlyphs(m[2]);
  }
  return null;
}

// ── 各项检查 ──────────────────────────────────────────────────────────
//
// 每一项返回 { id, label, facts, text }：
//   facts 是结构化的「读到的东西」（--json 用），text 是给人看的那一行（人类输出用）。
//   两者由同一份 facts 渲染，**不允许各写一套**（否则 --json 与人类输出会漂）。

/** Node 版本。版本号是推断，`import.meta.dirname` / `process.getBuiltinModule` 在不在是事实。 */
function checkNode() {
  const version = process.version.replace(/^v/, '');
  const hasDirname = typeof import.meta.dirname === 'string';
  const hasBuiltinModule = typeof process.getBuiltinModule === 'function';
  const toolOk = cmpVersion(version, TOOL_MIN_VERSION) >= 0;
  const testOk = cmpVersion(version, TEST_MIN_VERSION) >= 0;
  const facts = { version, toolMin: TOOL_MIN_VERSION, testMin: TEST_MIN_VERSION, toolOk, testOk, hasDirname, hasBuiltinModule };
  const text = [
    `v${version}`,
    `工具下限 ${TOOL_MIN_VERSION} ${toolOk ? '满足' : '不满足'}`,
    `测试下限 ${TEST_MIN_VERSION} ${testOk ? '满足' : '不满足'}`,
    `import.meta.dirname ${hasDirname ? '在' : '缺'}`,
    `process.getBuiltinModule ${hasBuiltinModule ? '在' : '缺'}`,
  ].join(' · ');
  return { id: 'node', label: 'node', facts, text };
}

/** transcript 根。**这里是「空 vs 坏」唯一的分叉点**，两个分支不许合并。
 *
 *  `deadline` 是本项可用的绝对时刻：枚举到点就停并如实标注「没数全」。
 *  预算必须同时约束**进程内**的检查，不能只约束子进程 —— 实测 6 个 doctor 并发时
 *  （`node --test` 跑全仓 30 个测试文件就是这个量级），枚举一项就能吃掉 400ms，
 *  两项子进程再各吃 300ms，墙钟就破了 1000ms。
 */
function checkTranscripts(root, nowMs, deadline) {
  let st = null;
  try {
    st = statSync(root);
  } catch (e) {
    const code = e && e.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // 「空」：这台机器上还没有 Claude Code 的会话记录。这不是错误，是一个事实，
      // 但**它必须和「读不出」分开** —— 前者去装 Claude Code，后者去查权限。
      return {
        id: 'transcripts',
        label: 'transcripts',
        kind: 'absent',
        facts: { root, kind: 'absent', errno: code || null },
        text: `根 ${root} 不存在 —— 这台机器上还没有 Claude Code 的会话记录`,
      };
    }
    return {
      id: 'transcripts',
      label: 'transcripts',
      kind: 'unreadable',
      facts: { root, kind: 'unreadable', errno: code || null, reason: String(e && e.message) },
      text: `根 ${root} 读不出 —— 路径在，但 stat 失败：${code || e.message}`,
    };
  }
  if (!st.isDirectory()) {
    return {
      id: 'transcripts',
      label: 'transcripts',
      kind: 'unreadable',
      facts: { root, kind: 'unreadable', errno: 'ENOTDIR', reason: '不是一个目录' },
      text: `根 ${root} 读不出 —— 路径在，但不是目录（ENOTDIR）`,
    };
  }
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return {
      id: 'transcripts',
      label: 'transcripts',
      kind: 'unreadable',
      facts: { root, kind: 'unreadable', errno: (e && e.code) || null, reason: String(e && e.message) },
      text: `根 ${root} 读不出 —— 目录在，但枚举失败：${(e && e.code) || e.message}（权限？）`,
    };
  }

  // 只数两层（<root>/<slug>/*.jsonl），与 scan-sessions 的布局假设一致。
  // 到点就停 —— 没数完的如实标注，不假装数全了。
  const sliceEnd = Math.min(Date.now() + ENUM_SLICE_MS, deadline);
  let projects = 0;
  let files = 0;
  let newestMs = 0;
  let complete = true;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    projects++;
    if (Date.now() > sliceEnd) { complete = false; break; }
    const dir = join(root, ent.name);
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      files++;
      try {
        const m = statSync(join(dir, name)).mtimeMs;
        if (m > newestMs) newestMs = m;
      } catch { /* 单个文件读不到不影响计数 */ }
    }
  }
  const ageMs = newestMs ? Math.max(0, nowMs - newestMs) : null;
  const facts = { root, kind: 'ok', projects, transcripts: files, newestAgeMs: ageMs, enumeratedFully: complete };
  const text = [
    root,
    `${projects} 个${complete ? '' : '（未完）'}项目`,
    `${files} 份 .jsonl${complete ? '' : '（下限）'}`,
    ageMs === null ? '没有可读的时间戳' : `最新一份 ${fmtAge(ageMs)}前`,
  ].join(' · ');
  return { id: 'transcripts', label: 'transcripts', kind: 'ok', facts, text };
}

/** 宿主的状态来源。这两处缺了会**静默**少掉 BLOCKED / FAILED / WAITING（审计 §4.1 第 3、4 项）。 */
function checkSources(env) {
  const claudeDir = (env && env.CLAUDE_CONFIG_DIR) || join(homedir(), '.claude');
  const jobsDir = join(claudeDir, 'jobs');
  const sessionsDir = join(claudeDir, 'sessions');
  const jobStates = countEntries(jobsDir, null);
  let jobStateFiles = null;
  if (jobStates !== null) {
    let n = 0;
    try {
      for (const name of readdirSync(jobsDir)) {
        if (existsSync(join(jobsDir, name, 'state.json'))) n++;
      }
      jobStateFiles = n;
    } catch { jobStateFiles = null; }
  }
  const sessionFiles = countEntries(sessionsDir, (f) => f.endsWith('.json'));
  const facts = { claudeDir, jobsDir: jobStates === null ? null : jobStates, jobStates: jobStateFiles, sessions: sessionFiles };
  const text = [
    `jobs ${jobStateFiles === null ? '没有' : `${jobStateFiles} 个 state.json`}`,
    `sessions ${sessionFiles === null ? '没有' : `${sessionFiles} 个 .json`}`,
    '这两处缺了不会报错：BLOCKED / FAILED / WAITING 会静默消失',
  ].join(' · ');
  return { id: 'sources', label: 'sources', facts, text };
}

/** 仓库自己的 `.claude/`。陌生人在干净 clone 上最想知道的其实是这一项的「本机设置未建」。 */
function checkRepoClaude() {
  const dir = join(REPO, '.claude');
  const agents = countEntries(join(dir, 'agents'), (f) => f.endsWith('.md'));
  const skills = countEntries(join(dir, 'skills'));
  const settingsLocal = existsSync(join(dir, 'settings.local.json'));
  const facts = { dir, agents: agents || 0, skills: skills || 0, settingsLocal };
  const text = [
    `agents ${agents === null ? '没有' : `${agents} 个`}`,
    `skills ${skills === null ? '没有' : `${skills} 个`}`,
    `settings.local.json ${settingsLocal ? '已建' : '未建（本机私有，.gitignore 已排除；缺它不影响任何命令）'}`,
  ].join(' · ');
  return { id: 'claude', label: 'claude/', facts, text };
}

/** 平台，以及它对「通知」和「开机自启」的实际影响。两者都不猜，由有实测的模块回答。 */
function checkPlatform(env) {
  const notify = isNotificationAvailable();
  const autostart = startupDir(env) !== null;
  const facts = { platform: process.platform, notify, autostart };
  const notifyText = process.platform === 'win32'
    ? (notify ? '桌面通知可用（Toast）' : '桌面通知不可用（缺 wscript/powershell）')
    : '桌面通知不可用（非 win32，退回写 runner.log）';
  const autostartText = autostart
    ? '开机自启有启动文件夹'
    : '开机自启无启动文件夹（install-watcher.mjs 会给 launchd / systemd 配置）';
  const text = `${process.platform} · ${notifyText} · ${autostartText}`;
  return { id: 'platform', label: 'platform', facts, text };
}

/** 写前闸。**判据全在 pre-write-gate.mjs 里**，这里只取它印出来的词。 */
function checkGate(result) {
  if (result.skipped) return { id: 'gate', label: 'gate', facts: { skipped: result.skipped }, text: result.skipped };
  const body = result.out || result.err || '';
  const fields = {
    mode: pickLabeled(body, 'mode'),
    brake: pickLabeled(body, 'brake'),
    marker: pickLabeled(body, 'marker state'),
    secret: pickLabeled(body, 'secret'),
  };
  const known = Object.values(fields).some((v) => v !== null);
  const facts = { source: 'scripts/pre-write-gate.mjs status', ...fields, raw: body.trim() };
  // 认不出（那个脚本改了标签）就原样转发 —— 宁可变长，不可编一个不存在的字段。
  const text = known
    ? Object.entries(fields).map(([k, v]) => `${k}=${v === null ? '未认出' : v}`).join(' · ')
    : stripGlyphs(body.split('\n').filter(Boolean).slice(0, 6).join(' · '));
  return { id: 'gate', label: 'gate', facts, text };
}

/** 后台监视的安装与存活。
 *
 *  **安装状态在进程内问**（`install-watcher.mjs` 的 `launcherPath()` / `shortcutPath()`），
 *  **存活判定必须 spawn `watch.mjs --health`**。不是懒，是**不能 import** ——
 *  见下面那段注释，这是本文件最危险的一处。
 *
 *  ⚠ **绝不要 `import('./watch.mjs')`。**
 *  `watch.mjs` 的「我是不是被当 CLI 跑的」判据是
 *  `/watch\.mjs$/.test(process.argv[1])` —— 而本文件叫 **over**watch.mjs，
 *  `overwatch.mjs` **以 `watch.mjs` 结尾**。于是从本文件 import 它时，
 *  它会认为自己是主模块并**当场启动守护进程**（实测：输出里出现
 *  `watch 启动 dir=… tick=15000ms`，然后进程永远不退，因为守护进程的定时器还活着）。
 *  这不是猜测，是本文件第一版踩到的：`doctor` 一跑就挂，挂的方式是「变成了 watch」。
 *  所以这里用 spawn，让 `argv[1]` 是 watch.mjs 自己的路径。
 *  （`install-watcher.mjs` 的判据是**解析后路径相等**，import 它安全；`pre-write-gate.mjs`
 *  判的是 `pre-write-gate\.mjs$`，也不匹配 `overwatch.mjs`，同样安全。）
 *
 *  另外 `loadState()` 在 state.json 损坏时会把它改名留证 —— 一个自检命令不该改现场，
 *  所以这里先自己确认文件可读，再让 `watch.mjs --health` 去判。 */
async function checkWatcherLive(env, timeoutMs, nowMs) {
  const started = Date.now();
  const facts = {
    source: 'watch.mjs --health + install-watcher.mjs launcherPath()/shortcutPath()',
    stateDir: stateDirFor(env),
    launcherPresent: null,
    shortcutPresent: null,
    verdict: null,
    layers: {},
    stateNote: null,
    raw: '',
  };

  let iw;
  try {
    iw = await import('./install-watcher.mjs');
  } catch (e) {
    return { ok: false, code: null, out: '', err: String(e && e.message), timedOut: false, ms: Date.now() - started, facts };
  }
  facts.launcherPresent = existsSync(iw.launcherPath(REPO));
  // `shortcutPath()` 在非 Windows 上返回 **null**（启动文件夹是 Windows 概念）。
  // `existsSync(null)` 在旧版 Node 上会抛，所以先判 null 再判存在。
  const shortcut = iw.shortcutPath(env);
  facts.shortcutPresent = shortcut ? existsSync(shortcut) : null;

  // 先自己确认状态文件读得出来 —— 只读地读，**不交给会改名的 loadState**。
  const stateFile = join(facts.stateDir, 'state.json');
  if (!existsSync(stateFile)) {
    facts.stateNote = '没有 state.json（从未运行过 watch.mjs）';
    return { ok: true, code: 0, out: '', err: '', timedOut: false, ms: Date.now() - started, facts };
  }
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') facts.stateNote = 'state.json 不是一个对象';
  } catch (e) {
    facts.stateNote = `state.json 读不出或不是合法 JSON（${(e && e.code) || 'parse error'}）—— 未改动它`;
    return { ok: true, code: 0, out: '', err: '', timedOut: false, ms: Date.now() - started, facts };
  }

  const r = await runNode('watch.mjs', ['--health'], timeoutMs);
  if (r.timedOut) {
    return { ...r, facts, timedOut: true, ms: Date.now() - started };
  }
  const body = r.out || r.err || '';
  facts.raw = body.trim();
  const verdictLine = body.split('\n').find((l) => /判定[:：]/.test(l));
  facts.verdict = verdictLine ? stripGlyphs(verdictLine.replace(/^.*判定[:：]/, '')).replace(/。$/, '') : null;
  for (const line of body.split('\n')) {
    const m = stripGlyphs(line).match(/^(jobs|probe)\s+上次\s+(\S+)/);
    if (m) facts.layers[m[1]] = m[2];
    const lg = stripGlyphs(line).match(/^log\s+(\S.*)$/);
    if (lg) facts.layers.log = lg[1].trim();
  }
  void nowMs; // --health 自己取时钟；这里保留参数是为了与 checkGateInProcess 同形
  return { ...r, facts, ms: Date.now() - started };
}

/** checkWatcher 的收尾：把 facts 渲成人话。
 *  人类输出与 `--json` 都从**同一个 facts** 生成，不许各写一套。 */
function checkWatcher(result, env) {
  if (result.skipped) return { id: 'watcher', label: 'watcher', facts: { skipped: result.skipped }, text: result.skipped };
  const f = result.facts || {};
  const facts = {
    source: f.source || 'scripts/install-watcher.mjs status',
    stateDir: f.stateDir || stateDirFor(env),
    launcherPresent: f.launcherPresent ?? null,
    shortcutPresent: f.shortcutPresent ?? null,
    verdict: f.verdict ?? null,
    layers: f.layers || {},
    stateNote: f.stateNote || null,
    raw: f.raw || String(result.out || result.err || '').trim(),
  };
  const yes = (v) => (v === null ? '未认出' : (v ? '在' : '没有'));
  // 「该平台没有这个概念」与「有这个概念但没建」必须分开说 —— 前者不是缺失，
  // 后者才是。合并成「未认出」会让 Linux 用户以为自己的启动项坏了。
  const shortcutText = facts.shortcutPresent === null
    ? '快捷方式 该平台没有启动文件夹（用 launchd / systemd）'
    : `快捷方式 ${yes(facts.shortcutPresent)}`;
  const range = Object.entries(facts.layers).map(([k, v]) => (k === 'log' ? `log ${v}` : `${k} 上次 ${v}前`)).join(' · ');
  const text = [
    `启动器 ${yes(facts.launcherPresent)}`,
    shortcutText,
    facts.stateNote ? `状态：${facts.stateNote}` : `health 说 ${facts.verdict === null ? '未认出' : facts.verdict}`,
    range || null,
    `数据目录 ${facts.stateDir}`,
  ].filter(Boolean).join(' · ');
  return { id: 'watcher', label: 'watcher', facts, text };
}

// ── plan（第一行的内容也是数据，不是硬编码的散文）──────────────────────

const PLAN = [
  { id: 'node', what: '运行时版本 + 两个 API 在不在' },
  { id: 'transcripts', what: '会话记录根目录在哪、多少份、最新一份多旧' },
  { id: 'sources', what: '宿主状态来源（jobs / sessions）在不在' },
  { id: 'claude', what: '仓库里的 .claude/（agents / skills / 本机设置）' },
  { id: 'gate', what: '写前闸的标记与密钥（由 pre-write-gate.mjs 报出）' },
  { id: 'watcher', what: '后台监视的安装与存活（由 install-watcher.mjs 报出）' },
  { id: 'platform', what: '平台，以及它对通知与开机自启的影响' },
];

/** 下一步该跑什么。这也是数据 —— README 缺「第二次用」是审计的原话。 */
const ADVICE = [
  { command: 'node scripts/overwatch.mjs scan', why: '看每个会话的状态（原命令 node scripts/scan-sessions.mjs --days 3）' },
  { command: 'node scripts/overwatch.mjs verify', why: '核对「AI 说它做完了」有没有证据（原命令 node scripts/verify-claims.mjs）' },
  { command: 'node scripts/overwatch.mjs tui', why: '面板：列表 → 详情 → 按 c 复制接力草稿（原命令 node scripts/oversight-tui.mjs）' },
];

// ── doctor 主体 ───────────────────────────────────────────────────────

/** 跑完全部七项，返回报告对象。人类输出与 --json **都从这一个对象渲染**。 */
async function runDoctor(opts) {
  const { env, nowMs, budgetMs } = opts;
  const started = Date.now();
  // 墙钟从**进程启动**算起，不是从这个函数算起。
  // 用户量的是 `time node scripts/overwatch.mjs`，里面含 Node 自己约 50ms 的启动；
  // 只报函数内的耗时会让「1000ms 上限」变成一句自欺的话。
  const bootMs = Math.max(0, Math.round(started - performance.timeOrigin));
  // 截止时刻也挂在 process start 上，而不是挂在本函数开始处。
  // 这不是洁癖：全量测试并发跑时本机实测 Node 启动被拖到 700–800ms，
  // 如果截止时刻从「import 全部完成之后」再算 920ms，doctor 会在启动已经很贵的
  // 情况下**再**花掉一整份预算 —— 实测 wallMs 1683ms。把两段成本算进同一个预算，
  // 剩下的时间才是真可用的。
  const deadline = performance.timeOrigin + budgetMs - PRINT_RESERVE_MS;
  const remaining = () => deadline - Date.now();

  const steps = [];
  /** 每步自己的耗时。**必须是真测的** —— 审计里 `idle=-7s` 那个负数的教训是
   *  「数字可能倒着走」，所以这里宁可印 0 也不编一个看起来合理的 3ms。 */
  const timed = (fn) => {
    const t = Date.now();
    const r = fn();
    r.ms = Date.now() - t;
    steps.push(r);
    return r;
  };

  // 前五项都是本进程内的 stat/readdir，加起来通常 < 100ms，不需要并行。
  timed(() => checkNode());
  const transcripts = timed(() => checkTranscripts(projectsRoot(env), nowMs, deadline));
  timed(() => checkSources(env));
  timed(() => checkRepoClaude());
  timed(() => checkPlatform(env));

  // 后两项各自的成本差一个数量级，所以**不并成一对**：
  //   gate    在进程内调 `cli(['status'])`，实测 4ms；
  //   watcher 必须 spawn（它内部还要再 spawn 一个 watch.mjs --health），实测 540–840ms。
  // 两项同时起会让 watcher 与一个 4ms 的活争同一份剩余预算，没有任何好处。
  const left = remaining();
  let gateResult;
  let watcherResult;
  if (left < 150) {
    const why = `预算内没时间跑（剩 ${Math.max(0, left)}ms / 预算 ${budgetMs}ms）—— 直接跑原命令`;
    gateResult = { skipped: why };
    watcherResult = { skipped: why };
  } else {
    // 先做便宜的（进程内 4ms），再用**剩下的**预算去问更贵的那项。
    // 顺序固定下来，慢机器上的行为才可预测。
    gateResult = await checkGateInProcess(left);
    const left2 = remaining();
    if (left2 < 80) {
      watcherResult = { skipped: `预算内没时间跑（剩 ${Math.max(0, left2)}ms / 预算 ${budgetMs}ms）—— 直接跑原命令` };
    } else {
      watcherResult = await checkWatcherLive(env, left2, nowMs);
    }
  }
  const gate = checkGate(gateResult);
  const watcher = checkWatcher(watcherResult, env);
  gate.ms = gateResult.skipped ? 0 : gateResult.ms;
  watcher.ms = watcherResult.skipped ? 0 : watcherResult.ms;
  // 按 PLAN 的顺序放回去：耗时要落在它自己那一项上。
  steps.splice(4, 0, gate);
  steps.splice(5, 0, watcher);

  const elapsedMs = Date.now() - started;
  const wallMs = bootMs + elapsedMs;

  const code = transcripts.kind === 'absent'
    ? EXIT.ABSENT
    : transcripts.kind === 'unreadable' ? EXIT.UNREADABLE : EXIT.OK;

  const summary = {
    code,
    kind: transcripts.kind,
    line: transcripts.kind === 'absent'
      ? `transcript 根不存在：${transcripts.facts.root} —— 先在这台机器上用一次 Claude Code，doctor 才有东西可查`
      : transcripts.kind === 'unreadable'
        ? `transcript 根读不出：${transcripts.facts.root}（${transcripts.facts.errno || '原因未知'}）—— 这是环境问题，不是「没有会话」`
        : `${transcripts.facts.projects} 个项目 / ${transcripts.facts.transcripts} 份 transcript —— 前提齐了，可以跑 scan`,
  };

  return {
    command: 'doctor',
    budgetMs,
    nowMs,
    plan: PLAN,
    steps,
    advice: code === EXIT.OK ? ADVICE : [],
    summary,
    /** 本进程内耗的毫秒数（不含 Node 启动）。 */
    workMs: elapsedMs,
    /** Node 启动耗时（`performance.timeOrigin` 到 main 开始）。 */
    bootMs,
    /** 用户用 `time` 量到的大致值：boot + work。这才是与 1000ms 上限对账的数。 */
    wallMs,
  };
}

function renderDoctor(report) {
  const lines = [];
  lines.push(`overwatch doctor · 查 ${report.plan.length} 项前提 · 预算 ${report.budgetMs}ms（只查前提，不扫语料）`);
  lines.push('');
  for (const p of report.plan) lines.push(`  ${p.id.padEnd(12)}${p.what}`);
  lines.push('');
  for (const s of report.steps) {
    lines.push(`[${pad4(s.ms)}ms] ${s.label.padEnd(12)}${s.text}`);
  }
  lines.push('');
  // 两个数一起报：workMs 说明「这工具自己花了多少」，wallMs 才是用户量得到的。
  // 只报前者会让人以为预算还有富余；只报后者会让人以为全是我们花的。
  // 第三个注记是「父进程（你的 shell / CI）拉起 node 本身的观察成本」——
  // 实测约 170–210ms（同机 `node -e 'console.log(0)'` 就是 210ms），它不在任何
  // 预算里，但用户 `time` 量到的墙钟含它。不写出来，doctor 报 850ms 而 `time`
  // 报 1020ms，就成了「这工具在骗我」。
  lines.push(`合计 ${report.wallMs}ms（本进程 ${report.workMs}ms + 启动 ${report.bootMs}ms）/ 预算 ${report.budgetMs}ms · ${report.summary.line}`);
  lines.push('      以上不含父进程拉起 node 自身的观察成本（本机实测约 170–210ms）。');
  if (report.advice.length) {
    lines.push('');
    lines.push('接着可以跑（本入口目前只路由，不代跑）：');
    for (const a of report.advice) lines.push(`  ${a.command.padEnd(38)}${a.why}`);
  }
  return lines.join('\n');
}

// ── 路由：未实现的子命令 ──────────────────────────────────────────────

/** 子命令 → 原生命令。`implemented: false` 是**有意的**：一个诚实的空壳比一个
 *  半成品 wrapper 好 —— 后者会和原命令悄悄分叉，而没人测那份分叉。 */
const ROUTES = {
  scan: {
    native: [
      'node scripts/scan-sessions.mjs --days 3',
      'node scripts/scan-sessions.mjs --json',
    ],
    why: 'scan 的参数没有任何转化，直接跑原命令即可（默认窗口 7 天，`--days` 可改）。',
  },
  verify: {
    native: [
      'node scripts/verify-claims.mjs',
      'node scripts/verify-claims.mjs --days 7',
      'node scripts/verify-claims.mjs --session <id前缀>',
    ],
    why: '注意 `--days` 在这里按**文件 mtime** 取窗口，scan 按 transcript 内部时间 —— 两个口径不同是有实测记录的，本入口不做统一。',
  },
  tui: {
    native: [
      'node scripts/oversight-tui.mjs',
      'node scripts/oversight-tui.mjs --plain',
    ],
    why: '非 TTY 下自动降级为纯文本快照；`--plain` 是显式要求它别进交互。',
  },
  watch: {
    native: [
      'node scripts/watch.mjs --inbox',
      'node scripts/watch.mjs --health',
      'node scripts/install-watcher.mjs install',
    ],
    why: '`--inbox` 只读通知历史，首跑必空 —— 那是历史为空，不是宿主没有 blocked 会话。',
  },
  plan: {
    // 渲染器由另一个 Agent 在做，可能还不存在 —— 不存在就直说「还没做」。
    native: ['node scripts/render-plan.mjs'],
    why: '计划渲染器还没做；它一旦存在，这里改成直接转发。',
    probe: 'scripts/render-plan.mjs',
  },
};

function renderRoute(name, extra) {
  const r = ROUTES[name];
  const lines = [];
  lines.push(`overwatch ${name} · 未实现（本入口目前只做路由，不代跑）`);
  lines.push('');
  if (r.probe && !existsSync(join(REPO, r.probe))) {
    lines.push(`这一项依赖的 ${r.probe} 还没有 —— 还没做，不是坏了。`);
    lines.push('');
  }
  lines.push('等价的原生命令（现在就可用）：');
  // 第一条会接上用户给的参数；**只在它自己不带同名参数时**才接，
  // 否则 `scan --days 1` 会印出 `--days 3 --days 1`（两个窗口，谁生效要读者猜）。
  const give = (cmd) => {
    if (!extra.length) return cmd;
    const given = new Set(extra.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]));
    if ([...given].some((f) => cmd.includes(`${f} `) || cmd.endsWith(f))) return cmd;
    return `${cmd} ${extra.join(' ')}`;
  };
  r.native.forEach((cmd, i) => lines.push(`  ${i === 0 ? give(cmd) : cmd}`));
  lines.push('');
  lines.push(`说明：${r.why}`);
  if (extra.length) {
    lines.push(`你给的参数 ${extra.join(' ')} 已接在上面的命令里 —— 但本入口**不会执行它**，请自己复制运行。`);
  }
  return lines.join('\n');
}

// ── --help：必须立刻退出，不做任何检查 ────────────────────────────────

const HELP = `用法：
  node scripts/overwatch.mjs              同 doctor
  node scripts/overwatch.mjs doctor       报告 7 项前提的事实（版本 / 会话记录 / 数据来源 /
                                          写前闸 / 后台监视 / 平台），<1000ms，不扫语料
  node scripts/overwatch.mjs <命令>       路由到原生命令（见下），只打印、不执行
  node scripts/overwatch.mjs --help       打印这份说明并立刻退出（不做任何检查）

路由命令（本入口未实现，只给等价的原生命令）：
  scan     扫全部会话 → node scripts/scan-sessions.mjs --days 3
  verify   核对完成声明 → node scripts/verify-claims.mjs
  tui      面板        → node scripts/oversight-tui.mjs
  watch    收件箱/健康 → node scripts/watch.mjs --inbox | --health
  plan     计划渲染    → node scripts/render-plan.mjs（还没做）

选项：
  --json               同一份数据的机器可读版（人类输出由它渲染，不是两套）
  --now <ISO>          注入参考时刻（复现「最新一份多旧」时用），默认当前时间
  --budget <ms>        doctor 的总预算，默认 ${DEFAULT_BUDGET_MS}
  --help, -h           这份说明，立刻退出

退出码：
  0  前提都读到了
  1  本入口自己出了意外
  2  transcript 根不存在（这台机器上还没有 Claude Code 的会话记录）
  3  transcript 根在、但读不出（权限 / 类型问题）
  4  该子命令未实现（已打印原生命令）
  5  用法错误

例子：
  node scripts/overwatch.mjs
  node scripts/overwatch.mjs --json
  node scripts/overwatch.mjs doctor --now 2026-11-14T00:00:00Z
  node scripts/overwatch.mjs scan --days 1`;

// ── CLI ───────────────────────────────────────────────────────────────

/** 解析参数。
 *
 *  本入口自己的四个选项（`--help` / `--json` / `--now` / `--budget`）**写在哪个位置都认**，
 *  因为 `doctor --json` 和 `--json doctor` 是同一句话，让人猜位置是没必要的细节。
 *  其余情况按位置分两段：
 *
 *   - 子命令**之前**出现的未知选项 → 报错退出（这是用户真的敲错了）；
 *   - 子命令**之后**的一切 → 原样收进 `rest`，**不解释** —— 它们是目标命令的参数
 *     （`scan --days 1` 里的 `--days` 是 scan-sessions 的，不是本入口的）。
 *
 *  为什么前半段必须严格：审计实测 `scan --bogus-flag` 静默照跑、`--days` 缺值静默
 *  回落 7 天，而「静默回落」是这类 CLI 最贵的缺陷 —— 用户以为自己改了窗口。
 *  为什么后半段必须宽松：路由器的职责是把参数**打印出来**，不是替目标命令校验它。 */
function parseArgs(argv) {
  const out = { command: null, json: false, nowMs: null, budgetMs: DEFAULT_BUDGET_MS, help: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    // 本入口自己的选项：位置无关。
    if (a === '--help' || a === '-h' || a === 'help') { out.help = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--now') {
      const v = argv[++i];
      if (v === undefined) return { error: '--now 需要一个 ISO 时间戳' };
      const t = Date.parse(v);
      if (!Number.isFinite(t)) return { error: `--now 不是一个能解析的时间：${v}` };
      out.nowMs = t;
      continue;
    }
    if (a === '--budget') {
      const v = argv[++i];
      if (v === undefined) return { error: '--budget 需要一个毫秒数' };
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return { error: `--budget 不是一个正数：${v}` };
      out.budgetMs = n;
      continue;
    }

    // 子命令之后的都是目标命令的参数，原样留着。
    if (out.command !== null) { out.rest.push(a); continue; }

    if (a.startsWith('-')) {
      return { error: `未知参数：${a}（本入口自己的选项只有 --help / --json / --now / --budget；子命令的参数请写在子命令后面）` };
    }
    out.command = a;
  }
  if (out.nowMs === null) out.nowMs = Date.now();
  return out;
}

function main(argv) {
  const parsed = parseArgs(argv);

  // --help 排在最前面：**任何情况下都不做检查**。本仓库吃过这个亏 ——
  // `scan-sessions.mjs --help` 会把 --help 当普通参数直接全量扫描（实测 43 秒）。
  if (!parsed.error && parsed.help) {
    process.stdout.write(HELP + '\n');
    return EXIT.OK;
  }
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${HELP}\n`);
    return EXIT.USAGE;
  }

  const cmd = parsed.command;

  if (cmd === null || cmd === 'doctor') {
    return runDoctor({ env: process.env, nowMs: parsed.nowMs, budgetMs: parsed.budgetMs }).then(
      (report) => {
        const text = parsed.json ? JSON.stringify(report, null, 2) : renderDoctor(report);
        process.stdout.write(text + '\n');
        return report.summary.code;
      },
      (e) => {
        process.stderr.write(`overwatch doctor 自己出了意外（这是 bug，不是环境问题）：${e && e.stack || e}\n`);
        return EXIT.INTERNAL;
      },
    );
  }

  if (Object.prototype.hasOwnProperty.call(ROUTES, cmd)) {
    const text = renderRoute(cmd, parsed.rest);
    // 一次写完。分成「正文 + 单独一次 '\n'」两次写会让 `cat -A` 看到一个空行 ——
    // 不是致命缺陷，但输出面的每个字节都该是有意的。
    process.stdout.write(parsed.json
      ? JSON.stringify({ command: cmd, implemented: false, ...ROUTES[cmd], argv: parsed.rest, text }, null, 2) + '\n'
      : text + '\n');
    return Promise.resolve(EXIT.ROUTED);
  }

  process.stderr.write(`未知子命令：${cmd}\n可用：doctor | scan | verify | tui | watch | plan | --help\n\n${HELP}\n`);
  return Promise.resolve(EXIT.USAGE);
}

// 只在被当 CLI 跑时执行。结构硬门会 import 每个非测试脚本 —— 顶层不许有副作用。
// 用「解析后的路径相等」而不是文件名正则：后者在同名副本（测试里的变异体）上会失灵，
// 而「变异体跑不起来」会让负向测试变成假的绿。
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  Promise.resolve(main(process.argv.slice(2))).then((code) => {
    process.exitCode = code;
  }, (e) => {
    process.stderr.write(`${(e && e.stack) || e}\n`);
    process.exitCode = EXIT.INTERNAL;
  });
}
