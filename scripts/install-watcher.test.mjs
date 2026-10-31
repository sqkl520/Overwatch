#!/usr/bin/env node
/**
 * install-watcher.test.mjs — 安装器与启动器渲染的回归测试。
 *
 * 这里测的核心不是「安装能不能成功」，而是 DF-022 那条约束：
 * **启动器绝不能落在数据目录里**。一个会随数据一起被删的启动器，
 * 等于没有启动器。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

import {
  launcherPath, templatePath, stateDirFor, startupDir, shortcutPath, autostartAdvice,
  renderLauncher, needsRegenerate,
} from './install-watcher.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ow-install-'));

test('启动器在仓库里，不在数据目录里（DF-022 的核心约束）', () => {
  const repo = join('C:', 'repo');
  const stateDir = join('C:', 'Users', 'x', 'AppData', 'Local', 'Overwatch');
  const out = launcherPath(repo);
  assert.ok(out.startsWith(resolve(repo)), `启动器应在仓库内：${out}`);
  assert.ok(!out.startsWith(resolve(stateDir)), `启动器不得位于数据目录：${out}`);
});

test('renderLauncher 替换两个占位符，且不再残留 __ 标记', () => {
  const out = renderLauncher({
    repo: 'D:\\Projects\\Overwatch',
    stateDir: 'C:\\Users\\x\\AppData\\Local\\Overwatch',
    template: 'repo = "__REPO__"\nstateDir = "__STATE_DIR__"\n',
  });
  assert.ok(out.includes('D:\\Projects\\Overwatch'));
  assert.ok(out.includes('C:\\Users\\x\\AppData\\Local\\Overwatch'));
  assert.ok(!out.includes('__REPO__'));
  assert.ok(!out.includes('__STATE_DIR__'));
});

test('renderLauncher 转义双引号——否则带引号的路径会提前闭合字符串字面量', () => {
  const out = renderLauncher({
    repo: 'D:\\odd "quoted" path',
    stateDir: 'C:\\state',
    template: 'repo = "__REPO__"\n',
  });
  // VBS 里双引号写成两个
  assert.ok(out.includes('D:\\odd ""quoted"" path'), `未转义：${out}`);
});

test('needsRegenerate：文件缺失 / 内容变化 / 一致 三种情况', () => {
  const args = { repo: 'D:\\r', stateDir: 'C:\\s', template: 'a="__REPO__"\nb="__STATE_DIR__"\n' };
  assert.equal(needsRegenerate({ ...args, existing: null }).same, false);
  assert.equal(needsRegenerate({ ...args, existing: null }).reason, 'missing');

  const good = renderLauncher(args);
  assert.equal(needsRegenerate({ ...args, existing: good }).same, true);

  const stale = renderLauncher({ ...args, stateDir: 'C:\\other' });
  const r = needsRegenerate({ ...args, existing: stale });
  assert.equal(r.same, false);
  assert.equal(r.reason, 'changed');
});

test('stateDirFor 与 watch.mjs 的 defaultStateDir 对同一个 env 给出同一结果', async () => {
  const { defaultStateDir } = await import('./watch.mjs');
  for (const env of [
    { LOCALAPPDATA: 'C:\\L' },
    { OVERWATCH_STATE_DIR: 'D:\\custom' },
  ]) {
    // defaultStateDir 在 win32 下用 LOCALAPPDATA；安装器同样。
    if (process.platform === 'win32' || env.OVERWATCH_STATE_DIR) {
      assert.equal(stateDirFor(env), defaultStateDir(env),
        `不一致：${JSON.stringify(env)}`);
    }
  }
});

test('shortcutPath 在启动文件夹里，且不在数据目录里', () => {
  const env = { APPDATA: 'C:\\Roaming', LOCALAPPDATA: 'C:\\Local' };
  const lnk = shortcutPath(env);
  assert.ok(lnk.includes('Startup'), `快捷方式应在启动文件夹：${lnk}`);
  assert.ok(!lnk.startsWith(join('C:\\Local', 'Overwatch')), `快捷方式不得在数据目录：${lnk}`);
});

test('模板是纯 ASCII——VBScript 按 ANSI 读，非 ASCII 会截断字符串字面量', () => {
  const tpl = readFileSync(templatePath(resolve(import.meta.dirname, '..')), 'utf8');
  const bad = [...tpl].filter((ch) => ch.charCodeAt(0) > 127);
  assert.deepEqual(bad, [], `模板含非 ASCII 字符：${[...new Set(bad)].join('')}`);
});

test('模板含两个占位符，否则渲染出来是半成品', () => {
  const tpl = readFileSync(templatePath(resolve(import.meta.dirname, '..')), 'utf8');
  assert.ok(tpl.includes('__REPO__'));
  assert.ok(tpl.includes('__STATE_DIR__'));
});

test('渲染后的脚本可被 cscript 解析（语法检查，不执行）', { skip: process.platform !== 'win32' }, () => {
  const dir = tmp();
  try {
    const { spawnSync } = process.getBuiltinModule('node:child_process');
    const tpl = readFileSync(templatePath(resolve(import.meta.dirname, '..')), 'utf8');
    // 指向一个不存在的仓库：脚本会在 FolderExists 处退出 3，但**必须先能解析**。
    const vbs = join(dir, 't.vbs');
    writeFileSync(vbs, renderLauncher({ repo: join(dir, 'nope'), stateDir: join(dir, 'state'), template: tpl }), 'utf8');
    const r = spawnSync('cscript', ['//nologo', vbs], { encoding: 'utf8', timeout: 15000 });
    const out = String(r.stdout || '') + String(r.stderr || '');
    assert.ok(!/语法|Syntax|expected|未结束/.test(out), `VBS 语法错误：${out}`);
    assert.equal(r.status, 3, `仓库不存在时应退出 3，实际 ${r.status}：${out}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('安装器清掉数据目录里的旧启动器——否则它是回到旧布局的静默陷阱', async () => {
  // 这条不是洁癖：旧副本能跑，但跑起来就回到了「启动器和数据住在一起」的布局，
  // 而且不会有任何提示。DF-022 的修复不能留一个后门。
  const src = readFileSync(join(import.meta.dirname, 'install-watcher.mjs'), 'utf8');
  assert.ok(src.includes("join(stateDir, 'start-watch.vbs')"),
    '安装器必须处理数据目录里的旧副本');
  assert.ok(src.includes('rmSync(legacy'), '必须真的删除，而不是只警告');
});

test('startupDir 在非 Windows 返回 null——不能拼出不存在的路径', () => {
  // 早期版本无条件拼 %APPDATA%\Microsoft\Windows\...，在别的平台上会静默建出垃圾目录。
  if (process.platform !== 'win32') {
    assert.equal(startupDir({ APPDATA: '/x' }), null);
  }
  // 显式覆盖优先于平台判断
  assert.equal(startupDir({ OVERWATCH_STARTUP_DIR: '/custom/startup' }), '/custom/startup');
});

test('autostartAdvice 给出可执行的替代做法，不是占位符', async () => {
  const { autostartAdvice } = await import('./install-watcher.mjs');
  const mac = autostartAdvice('darwin');
  assert.ok(mac.includes('launchctl') && mac.includes('launchd'), 'macOS 应给 launchd 做法');
  const linux = autostartAdvice('linux');
  assert.ok(linux.includes('systemctl') && linux.includes('.service'), 'Linux 应给 systemd 做法');
  assert.ok(linux.includes('--inbox'), '应给出不配守护进程时的退路');
});
