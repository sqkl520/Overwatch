#!/usr/bin/env node
/**
 * notify.mjs — Windows Toast 通知，隐藏启动、失败必抛。
 *
 * 为什么长这样（都是实测，不要「优化」回常见写法）：
 *
 * 1. **不能用 `powershell.exe -WindowStyle Hidden`**。实测它隐藏不了窗口：
 *    会闪一个控制台黑框并抢全屏焦点，比不通知更差（hosted-mode.md §4.5 第 4 条）。
 *    正确做法是 `wscript.exe` 起一个 VBS，由 VBS 用 `sh.Run(cmd, 0, None)` 拉起 PowerShell——
 *    wscript 是 GUI 子系统进程，本身就没有控制台；`0` 把子进程窗口也藏掉。
 *
 * 2. **PowerShell 冷启动 3.3–4.2 秒**。所以每 1 分钟轮询绝不能用它；只有真正要发通知时
 *    才付这笔钱（限额 ≤8 条/天 ⇒ 每天约 40 秒）。轮询路径见 watch.mjs，纯 node。
 *
 * 3. **wscript 不返回子进程退出码**（bWait=False 时立刻退出）。为了在 AC5 下
 *    「发送失败必须抛出」而不是「假装成功」，PowerShell 把结果写进 result.json，
 *    node 侧轮询读它。超时也抛。
 *
 * 4. **PS 5.1 按 ANSI 读无 BOM 的 UTF-8 脚本**（实测：中文标题导致 LoadXml 抛
 *    0xC00CE56D）。这里的 ps1 保持纯 ASCII，正文走独立的 UTF-8 载荷文件并由
 *    ReadAllText(UTF8) 读入；写 ps1 时仍加 BOM 作双保险。
 *
 * 零依赖，只用 node: 内置模块。
 */

import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, writeFileSync, readFileSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const APP_ID = 'Overwatch.Notifier';
const APP_NAME = 'Overwatch';
const TAG_MAX = 16;
/** PowerShell 冷启动 3.3–4.2s，留足余量 */
const TIMEOUT_MS = 25_000;
const POLL_MS = 50;

// ── 路径 ──────────────────────────────────────────────────────────────

/** 通知工作目录。与 watch.mjs 同源规则：绝不写仓库。 */
export function defaultNotifyDir(env = process.env) {
  const explicit = env.OVERWATCH_STATE_DIR;
  if (explicit) return join(explicit, 'notify');
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'Overwatch', 'notify');
  }
  const xdg = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(xdg, 'overwatch', 'notify');
}

const winDir = () => process.env.SystemRoot || 'C:\\Windows';
const wscriptPath = () => join(winDir(), 'System32', 'wscript.exe');
const powershellPath = () => join(winDir(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/**
 * 自检：只回答「这条通道的先决条件在不在」（平台、wscript、powershell）。
 * **不回答「用户看没看到」**——Toast 无法确认送达，见 hosted-mode.md §4.5。
 * 不发通知、不起进程，可以安全地在任何地方调用。
 */
export function isNotificationAvailable() {
  if (process.platform !== 'win32') return false;
  return existsSync(wscriptPath()) && existsSync(powershellPath());
}

// ── 脚本与载荷 ────────────────────────────────────────────────────────

/** PowerShell 侧脚本。纯 ASCII，加 BOM 双保险（见文件头第 4 条）。 */
const PS_TEMPLATE = `param(
  [Parameter(Mandatory=$true)][string]$ResultPath,
  [Parameter(Mandatory=$true)][string]$PayloadPath,
  [string]$Tag = ''
)
$ErrorActionPreference = 'Stop'
$result = @{ ok = $false; error = $null; appId = '${APP_ID}' }
try {
  # AppUserModelID 注册：HKCU，无需管理员。幂等，每次跑都走一遍比单独判存在更省事。
  $key = 'HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\${APP_ID}'
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -Path $key -Name 'DisplayName' -Value '${APP_NAME}' -PropertyType String -Force | Out-Null

  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml([System.IO.File]::ReadAllText($PayloadPath, [System.Text.Encoding]::UTF8))
  $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
  if ($Tag -ne '') { $toast.Tag = $Tag }
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show($toast)
  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
} finally {
  $json = $result | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($ResultPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}
`;

/** 启动器。路径一律走参数，不嵌进 VBS 字符串——省掉转义地狱，也不会僵死。 */
const VBS_TEMPLATE = `' Overwatch toast launcher — 由 notify.mjs 生成。
' 关键在第三个参数 0：子进程窗口隐藏；wscript 自身无控制台，所以全程不闪窗。
Dim sh, cmd, i
Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & WScript.Arguments(0) & """"
For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next
sh.Run cmd, 0, False
`;

export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 不接受这些控制字符，留着会让整条通知发不出去
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** Toast 的 Tag 只允许短 ASCII，超出会被 WinRT 拒绝 */
export function sanitizeTag(tag) {
  const s = String(tag ?? '').replace(/[^A-Za-z0-9_.-]/g, '');
  return s.slice(0, TAG_MAX);
}

/** 生成载荷 XML。title/body 都过转义——它们来自会话内容，不能信。 */
export function buildPayloadXml({ title, body }) {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<toast><visual><binding template="ToastGeneric">'
    + `<text>${escapeXml(title)}</text>`
    + `<text>${escapeXml(body)}</text>`
    + '</binding></visual></toast>';
}

function ensureScripts(dir) {
  mkdirSync(dir, { recursive: true });
  const ps = join(dir, 'toast.ps1');
  const vbs = join(dir, 'launch.vbs');
  // BOM：PS 5.1 在非 UTF-8 代码页下按 ANSI 解释无 BOM 脚本（实测踩过）
  const psBody = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(PS_TEMPLATE, 'utf8')]);
  try {
    const cur = readFileSync(ps);
    if (!cur.equals(psBody)) writeFileSync(ps, psBody);
  } catch { writeFileSync(ps, psBody); }
  try {
    const cur = readFileSync(vbs, 'utf8');
    if (cur !== VBS_TEMPLATE) writeFileSync(vbs, VBS_TEMPLATE, 'utf8');
  } catch { writeFileSync(vbs, VBS_TEMPLATE, 'utf8'); }
  return { ps, vbs };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 主入口 ────────────────────────────────────────────────────────────

/**
 * 发一条 Toast。桌面通知的「送达」不可验证，这里只保证「提交给系统」或「抛错」。
 *
 * @param {{title:string, body?:string, tag?:string, dir?:string, timeoutMs?:number}} opts
 * @returns {Promise<{submitted:true, appId:string, tookMs:number}>}
 * @throws 先决条件不满足 / PowerShell 报错 / 超时 —— 一律抛，绝不静默吞（AC5）
 */
export async function sendNotification(opts = {}) {
  const { title, body = '', tag = '', dir, timeoutMs = TIMEOUT_MS } = opts ?? {};

  if (typeof title !== 'string' || title.trim() === '') {
    throw new TypeError('sendNotification: title 必须是非空字符串');
  }
  if (!isNotificationAvailable()) {
    throw new Error('sendNotification: 当前平台不支持（需要 Windows + wscript.exe + powershell.exe）');
  }

  const workDir = dir || defaultNotifyDir();
  const { ps, vbs } = ensureScripts(workDir);

  const id = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const payloadPath = join(workDir, `payload-${id}.xml`);
  const resultPath = join(workDir, `result-${id}.json`);

  writeFileSync(payloadPath, buildPayloadXml({ title, body }), 'utf8');
  try { rmSync(resultPath, { force: true }); } catch { /* 不存在才是常态 */ }

  const started = Date.now();
  const args = ['//nologo', vbs, ps, resultPath, payloadPath];
  const safeTag = sanitizeTag(tag);
  if (safeTag) args.push(safeTag);

  const child = spawn(wscriptPath(), args, {
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // wscript 立刻退出（bWait=False），退出码拿不到 → 盯结果文件
  let result = null;
  while (Date.now() - started < timeoutMs) {
    if (existsSync(resultPath)) {
      try {
        result = JSON.parse(readFileSync(resultPath, 'utf8'));
      } catch {
        result = null; // 正在写，下一轮再读
      }
      if (result) break;
    }
    await sleep(POLL_MS);
  }

  try { rmSync(resultPath, { force: true }); } catch { /* ignore */ }
  try { rmSync(payloadPath, { force: true }); } catch { /* ignore */ }

  if (!result) {
    throw new Error(`sendNotification: ${timeoutMs}ms 内未拿到 PowerShell 回执（toast.ps1 可能启动失败）`);
  }
  if (!result.ok) {
    throw new Error(`sendNotification: PowerShell 拒绝发送：${result.error || '未知错误'}`);
  }
  return { submitted: true, appId: APP_ID, tookMs: Date.now() - started };
}

// ── CLI ───────────────────────────────────────────────────────────────

function main(argv) {
  const flags = new Set(argv);
  if (flags.has('--self-test')) {
    if (!isNotificationAvailable()) {
      console.error('通知不可用：需要 Windows + wscript.exe + powershell.exe');
      process.exit(2);
    }
    const dir = defaultNotifyDir();
    sendNotification({
      title: 'Overwatch P0 自检',
      body: 'wscript 隐藏启动 · 这条通知代表通道可用',
      tag: 'selftest',
      dir,
    }).then((r) => {
      console.log(`已提交给系统（${r.tookMs}ms）。注意：这只证明系统接受了它，不证明用户看到了。`);
      console.log(`工作目录：${dir}`);
    }).catch((e) => {
      console.error('发送失败：' + e.message);
      process.exit(1);
    });
    return;
  }
  const i = argv.indexOf('--title');
  if (i >= 0 && argv[i + 1]) {
    const j = argv.indexOf('--body');
    sendNotification({
      title: argv[i + 1],
      body: j >= 0 ? argv[j + 1] : '',
      tag: 'cli',
    }).then(() => console.log('ok')).catch((e) => { console.error(e.message); process.exit(1); });
    return;
  }
  console.log('用法：node scripts/notify.mjs --self-test');
  console.log('      node scripts/notify.mjs --title "标题" --body "正文"');
  console.log('作为模块：import { sendNotification, isNotificationAvailable } from "./notify.mjs"');
}

const isDirect = process.argv[1] && /notify\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isDirect) main(process.argv.slice(2));
