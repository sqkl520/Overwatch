#!/usr/bin/env node
/**
 * app-router.test.mjs — App 键位路由的测试（补 DF-014）。
 *
 * 用 node --test 运行：node --test scripts/app-router.test.mjs
 *
 * 为什么需要这个文件：TUI 验收 r3 的两个阻断都出在 App 层，
 * 而当时 52 条测试只覆盖纯函数，一条也没进过详情页或帮助面板。
 * 这里直接构造 App、喂按键、断言状态迁移，不启动真实终端。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { App } from './oversight-tui.mjs';

// ── 构造一个不触发真实 I/O 的 App ─────────────────────────────────────

function makeApp(sessions = []) {
  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.isTTY = true;
  stdout.write = () => true;              // 吞掉渲染，只测状态机

  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};

  let scanCalls = 0;
  const scan = () => {
    scanCalls++;
    return {
      promise: Promise.resolve({
        data: { sessions, live: [], generatedAt: new Date().toISOString() },
        warning: null,
      }),
      cancel: () => {},
    };
  };

  const app = new App({ stdout, stdin, env: {}, days: 3, intervalSec: 8, scan, useColor: false });
  return { app, stdout, stdin, getScanCalls: () => scanCalls };
}

const SESSIONS = [
  { project: 'a', sessionId: 's1', state: 'BLOCKED', reason: 'host-reported-blocked',
    calls: 10, novelty: 0.5, idleSec: 100, liveness: 'reconstructed',
    needs: '要不要继续', suggestedReply: '继续', subagents: 0, subagentsTotal: 0,
    subagentsTruncated: 0, maxDepth: 0, hbThresholdSec: 120, lastGapSec: 5, badLines: 0 },
  { project: 'b', sessionId: 's2', state: 'FAILED', reason: 'host-reported-failed',
    calls: 20, novelty: 0.3, idleSec: 200, liveness: 'reconstructed',
    needs: null, suggestedReply: null, subagents: 1, subagentsTotal: 3,
    subagentsTruncated: 2, maxDepth: 1, hbThresholdSec: 120, lastGapSec: 9, badLines: 0 },
  { project: 'c', sessionId: 's3', state: 'PRODUCING', reason: 'persistent-change-in-window',
    calls: 30, novelty: 0.9, idleSec: 5, liveness: 'reconstructed',
    needs: null, suggestedReply: null, subagents: 0, subagentsTotal: 0,
    subagentsTruncated: 0, maxDepth: 0, hbThresholdSec: 120, lastGapSec: 5, badLines: 0 },
];

/** 喂完数据，让 App 进入可交互状态 */
async function ready(sessions = SESSIONS) {
  const ctx = makeApp(sessions);
  ctx.app.data = { sessions, live: [] };
  ctx.app.render = () => {};              // 渲染不是本文件的测试对象
  return ctx;
}

// ── 列表视图 ──────────────────────────────────────────────────────────

test('列表：j 下移、k 上移，边界不越界', async () => {
  const { app } = await ready();
  assert.equal(app.selected, 0);
  app.onKey('j');
  assert.equal(app.selected, 1);
  app.onKey('j');
  assert.equal(app.selected, 2);
  app.onKey('j');
  assert.equal(app.selected, 2, '到底后不应继续增加');
  app.onKey('k');
  assert.equal(app.selected, 1);
  app.onKey('k');
  app.onKey('k');
  assert.equal(app.selected, 0, '到顶后不应变负');
});

test('列表：方向键与 j/k 等价', async () => {
  const { app } = await ready();
  app.onKey('down');
  assert.equal(app.selected, 1);
  app.onKey('up');
  assert.equal(app.selected, 0);
});

test('列表：g 跳首、G 跳尾', async () => {
  const { app } = await ready();
  app.onKey('G');
  assert.equal(app.selected, 2, 'G 应跳到最后一个');
  app.onKey('g');
  assert.equal(app.selected, 0, 'g 应跳到第一个');
});

test('列表：空数据时按键不崩', async () => {
  const { app } = await ready([]);
  assert.doesNotThrow(() => {
    app.onKey('j');
    app.onKey('k');
    app.onKey('G');
    app.onKey('g');
    app.onKey('enter');
  });
  assert.equal(app.mode, 'list', '空列表按 Enter 不应进详情');
});

test('列表：Enter 进入详情', async () => {
  const { app } = await ready();
  app.onKey('enter');
  assert.equal(app.mode, 'detail');
  assert.equal(app.detailScroll, 0);
});

test('列表：? 打开帮助，记录来源', async () => {
  const { app } = await ready();
  app.onKey('?');
  assert.equal(app.mode, 'help');
  assert.equal(app.prevMode, 'list');
});

test('列表：q 关闭', async () => {
  const { app } = await ready();
  app.onKey('q');
  assert.equal(app.closed, true);
});

test('列表：ctrl-c 关闭', async () => {
  const { app } = await ready();
  app.onKey('ctrl-c');
  assert.equal(app.closed, true);
});

test('列表：r 触发刷新', async () => {
  const { app, getScanCalls } = await ready();
  app.refresh = () => { app._refreshed = (app._refreshed ?? 0) + 1; };
  app.onKey('r');
  assert.equal(app._refreshed, 1);
});

test('列表：无 needs 时 c 不崩', async () => {
  const { app } = await ready([SESSIONS[2]]);
  app.showNotice = () => {};
  assert.doesNotThrow(() => app.onKey('c'));
});

// ── 详情视图 ──────────────────────────────────────────────────────────

test('详情：Esc 返回列表并重置滚动', async () => {
  const { app } = await ready();
  app.onKey('enter');
  app.detailScroll = 5;
  app.onKey('escape');
  assert.equal(app.mode, 'list');
  assert.equal(app.detailScroll, 0, '返回时应重置滚动位置');
});

test('详情：j/k 滚动，k 不为负', async () => {
  const { app } = await ready();
  app.onKey('enter');
  app.onKey('j');
  app.onKey('j');
  assert.equal(app.detailScroll, 2);
  app.onKey('k');
  assert.equal(app.detailScroll, 1);
  app.onKey('k');
  app.onKey('k');
  assert.equal(app.detailScroll, 0, '滚动不应变负');
});

test('详情：pgdown/pgup 一次滚 10 行', async () => {
  const { app } = await ready();
  app.onKey('enter');
  app.onKey('pgdown');
  assert.equal(app.detailScroll, 10);
  app.onKey('pgup');
  assert.equal(app.detailScroll, 0);
});

test('详情：? 打开帮助，关闭后回到详情而不是列表', async () => {
  const { app } = await ready();
  app.onKey('enter');
  app.onKey('?');
  assert.equal(app.mode, 'help');
  assert.equal(app.prevMode, 'detail');
  app.onKey('x');                        // 任意键关闭
  assert.equal(app.mode, 'detail', '从详情打开的帮助，关闭后应回详情');
});

test('详情：q 关闭整个程序', async () => {
  const { app } = await ready();
  app.onKey('enter');
  app.onKey('q');
  assert.equal(app.closed, true);
});

test('详情：无 needs 的会话按 c 不崩', async () => {
  const { app } = await ready([SESSIONS[2]]);
  app.onKey('enter');
  app.showNotice = () => {};
  assert.doesNotThrow(() => app.onKey('c'));
});

// ── 覆盖式面板 ────────────────────────────────────────────────────────

test('帮助面板：任意键关闭并回到来源视图', async () => {
  const { app } = await ready();
  app.onKey('?');
  assert.equal(app.mode, 'help');
  app.onKey('x');
  assert.equal(app.mode, 'list');
});

test('帮助面板：q 是退出程序，不是关闭面板', async () => {
  const { app } = await ready();
  app.onKey('?');
  app.onKey('q');
  assert.equal(app.closed, true, '覆盖式面板里的 q 应退出程序');
});

// ── 渲染不崩 ──────────────────────────────────────────────────────────

test('三种视图的渲染函数都不抛异常', async () => {
  const { app } = await ready();
  const realRender = App.prototype.render;
  assert.doesNotThrow(() => realRender.call(Object.assign(Object.create(app), { mode: 'list' })));
});

test('渲染在窄终端下不崩', async () => {
  const { app, stdout } = await ready();
  stdout.columns = 20;
  stdout.rows = 10;
  const realRender = App.prototype.render;
  assert.doesNotThrow(() => realRender.call(Object.assign(Object.create(app), { mode: 'list' })));
});
