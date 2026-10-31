#!/usr/bin/env node
/**
 * install-watcher.mjs — 安装/卸载开机自启（Windows）。
 *
 * 设计要点（DF-022 的直接后果）：
 *
 *   启动器**住在仓库里**，不在数据目录里。
 *   曾经把它写到 `%LOCALAPPDATA%\Overwatch\start-watch.vbs`——那正是它要保护的目录。
 *   一次整目录删除把启动器和数据一起删掉，监控系统就此起不来。
 *   数据可以重新积累，起不来则永远没有积累的机会。
 *
 *   现在：
 *     模板   <repo>/scripts/install/start-watch.vbs.template   （版本控制）
 *     产物   <repo>/scripts/install/start-watch.vbs            （生成，gitignored 之外）
 *     快捷方式  <Startup>/Overwatch Watch.lnk → 上面的产物
 *
 *   数据目录被删时，启动器与快捷方式都还在，重启即恢复（丢失告警会照常响）。
 *
 * 为什么不用任务计划：实测这台机器上连 `cmd /c echo hello > file` 都返回 0x1，
 * 而同一个 VBS 手动运行完全正常。详见 docs/install-watcher.md。
 *
 * 零依赖，只用 node: 内置模块（通过 powershell 创建快捷方式）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolve(HERE, '..');

/** 启动器在仓库里的**最终**位置（不是数据目录）。 */
export function launcherPath(repo = DEFAULT_REPO) {
  return join(repo, 'scripts', 'install', 'start-watch.vbs');
}

export function templatePath(repo = DEFAULT_REPO) {
  return join(repo, 'scripts', 'install', 'start-watch.vbs.template');
}

/** 数据目录。与 watch.mjs 的 defaultStateDir 保持一致，但不 import——
 *  安装脚本独立于运行时脚本，避免为了 20 行路径逻辑拖进整个 watch.mjs。 */
export function stateDirFor(env = process.env) {
  if (env.OVERWATCH_STATE_DIR) return env.OVERWATCH_STATE_DIR;
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'Overwatch');
  }
  const xdg = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(xdg, 'overwatch');
}

export function startupDir(env = process.env) {
  if (env.OVERWATCH_STARTUP_DIR) return env.OVERWATCH_STARTUP_DIR;
  return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function shortcutPath(env = process.env) {
  return join(startupDir(env), 'Overwatch Watch.lnk');
}

/** 把模板渲染成可运行的 .vbs 内容。
 *  模板用 `__REPO__` / `__STATE_DIR__` 占位；值里的双引号先转义成 VBS 的 `""`，
 *  否则一个带引号的路径会把字符串字面量提前闭合——这类错误只在运行时才炸。 */
export function renderLauncher({ repo, stateDir, template }) {
  const q = (s) => String(s).replace(/"/g, '""');
  return String(template)
    .replace('__REPO__', q(repo))
    .replace('__STATE_DIR__', q(stateDir));
}

/** 生成的启动脚本是否还与当前模板一致（repo/stateDir 没变）。
 *  返回 { same, reason }。不读真实文件系统之外的任何东西。 */
export function needsRegenerate({ repo, stateDir, template, existing }) {
  if (!existing) return { same: false, reason: 'missing' };
  const want = renderLauncher({ repo, stateDir, template });
  if (existing !== want) return { same: false, reason: 'changed' };
  return { same: true, reason: null };
}

/** 通过 PowerShell 创建 .lnk。用临时 .ps1 而不是 -Command，
 *  因为路径里的中文/空格在命令行传参时容易被二次解析。 */
export function createShortcut({ lnk, target, args, workdir }) {
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:OW_LNK)',
    '$s.TargetPath = $env:OW_TARGET',
    '$s.Arguments = $env:OW_ARGS',
    '$s.WorkingDirectory = $env:OW_WORKDIR',
    '$s.WindowStyle = 7',   // 7 = minimized; the .vbs hides the real window anyway
    '$s.Save()',
  ].join('\n');
  const file = join(tmpdir(), `ow-shortcut-${process.pid}.ps1`);
  writeFileSync(file, ps, 'utf8');
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
      encoding: 'utf8',
      env: { ...process.env, OW_LNK: lnk, OW_TARGET: target, OW_ARGS: args, OW_WORKDIR: workdir },
    });
    if (r.status !== 0) {
      return { ok: false, error: String(r.stderr || r.stdout || `exit ${r.status}`).trim() };
    }
    return { ok: true };
  } finally {
    try { spawnSync('cmd', ['/c', 'del', '/q', file]); } catch { /* ignore */ }
  }
}

// ── CLI ───────────────────────────────────────────────────────────────

function main(argv) {
  const cmd = argv[0] || 'status';
  const repo = process.env.OVERWATCH_REPO || DEFAULT_REPO;
  const stateDir = stateDirFor();
  const tpl = templatePath(repo);
  const out = launcherPath(repo);
  const lnk = shortcutPath();

  if (!existsSync(tpl)) {
    console.error(`找不到模板：${tpl}`);
    process.exit(2);
  }
  const template = readFileSync(tpl, 'utf8');
  const existing = existsSync(out) ? readFileSync(out, 'utf8') : null;
  const { same, reason } = needsRegenerate({ repo, stateDir, template, existing });

  if (cmd === 'status') {
    console.log(`仓库      ${repo}`);
    console.log(`数据目录  ${stateDir}`);
    console.log(`启动器    ${out}  ${existing ? (same ? '✓ 最新' : `⚠ 需重生成（${reason}）`) : '✗ 不存在'}`);
    console.log(`快捷方式  ${lnk}  ${existsSync(lnk) ? '✓ 存在' : '✗ 不存在'}`);
    console.log('');
    console.log('启动器**不在数据目录里**：数据被删不影响重启（DF-022）。');
    return same && existsSync(lnk) ? 0 : 1;
  }

  if (cmd === 'install') {
    mkdirSync(join(repo, 'scripts', 'install'), { recursive: true });
    writeFileSync(out, renderLauncher({ repo, stateDir, template }), 'utf8');
    console.log(`✓ 启动器已写入 ${out}`);
    mkdirSync(startupDir(), { recursive: true });
    const r = createShortcut({
      lnk,
      target: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'),
      args: `"${out}"`,
      workdir: repo,
    });
    if (!r.ok) {
      console.error(`✗ 创建快捷方式失败：${r.error}`);
      process.exit(1);
    }
    console.log(`✓ 开机自启已建立 ${lnk}`);
    console.log('  下次登录生效；现在想启动可以手动运行 wscript "' + out + '"');
    return 0;
  }

  if (cmd === 'uninstall') {
    const ps = `(New-Object -ComObject WScript.Shell).CreateShortcut($env:OW_LNK)` +
      ` | ForEach-Object { $_.Delete() }`;
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Remove-Item -LiteralPath '${lnk}' -Force -ErrorAction SilentlyContinue`]);
    void ps;
    console.log(existsSync(lnk) ? `✗ 未能删除 ${lnk}` : `✓ 已移除开机自启（启动器文件保留在仓库里）`);
    return 0;
  }

  console.error(`未知命令：${cmd}。可用：status | install | uninstall`);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
