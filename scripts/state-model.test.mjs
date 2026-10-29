#!/usr/bin/env node
/**
 * state-model.test.mjs — 四态判定的回归测试。
 *
 * 用 node --test 运行：node --test scripts/state-model.test.mjs
 * 零依赖，只用 node:test 与 node:assert。
 *
 * 这些测试锁住的是 docs/spec/state-model.md 里的判据。
 * 如果某条测试红了，先改规格再改代码——不要为了让测试变绿而放宽阈值。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBash,
  signatureOf,
  noveltyOf,
  isPersistentChange,
  heartbeatThreshold,
  judgeState,
} from './scan-sessions.mjs';

const MIN = 60_000;
const now = Date.now();
const callAt = (cmd, ts) => ({
  name: 'Bash',
  sig: signatureOf('Bash', { command: cmd }),
  persistent: isPersistentChange('Bash', { command: cmd }),
  ts,
});

// ── §3.3 Bash 归一化 ───────────────────────────────────────────────────

test('归一化：数字字面量不产生新签名', () => {
  assert.equal(
    normalizeBash('git log --oneline -20').digest,
    normalizeBash('git log --oneline -5').digest,
  );
});

test('归一化：绝对路径不产生新签名', () => {
  assert.equal(
    normalizeBash('node D:/a/b/script.mjs --x').digest,
    normalizeBash('node D:/c/d/script.mjs --x').digest,
  );
});

test('归一化：动词不同则签名不同', () => {
  assert.notEqual(normalizeBash('git status').digest, normalizeBash('npm test').digest);
});

// ── §3.4 持久化变更 ────────────────────────────────────────────────────

test('只读命令不算持久化变更', () => {
  for (const cmd of ['ls -la', 'git status', 'git diff', 'cat a.txt', 'grep x y', 'git log']) {
    assert.equal(isPersistentChange('Bash', { command: cmd }), false, cmd);
  }
});

test('写入命令算持久化变更', () => {
  for (const cmd of ['git commit -m x', 'npm install', 'mvn package', 'rm -rf x', 'mkdir d']) {
    assert.equal(isPersistentChange('Bash', { command: cmd }), true, cmd);
  }
});

test('输出重定向算持久化变更，但流重定向不算', () => {
  assert.equal(isPersistentChange('Bash', { command: 'echo hi > b.txt' }), true);
  assert.equal(isPersistentChange('Bash', { command: 'cmd 2>&1' }), false, '2>&1 不是写文件');
  assert.equal(isPersistentChange('Bash', { command: 'cmd >&2' }), false);
});

test('Write 与 Edit 一律算持久化变更', () => {
  assert.equal(isPersistentChange('Write', {}), true);
  assert.equal(isPersistentChange('Edit', {}), true);
  assert.equal(isPersistentChange('Read', {}), false);
});

// ── §3.5 novelty ───────────────────────────────────────────────────────

test('完全重复的调用 novelty 趋近 0', () => {
  const calls = Array.from({ length: 10 }, () => callAt('git status', now));
  assert.ok(noveltyOf(calls) < 0.2, `novelty=${noveltyOf(calls)}`);
});

test('完全不同的调用 novelty 为 1', () => {
  const cmds = ['ls', 'git status', 'npm run build', 'node a.mjs', 'cat x'];
  const calls = cmds.map((c) => callAt(c, now));
  assert.equal(noveltyOf(calls), 1);
});

test('空窗口返回 null 而不是 0', () => {
  assert.equal(noveltyOf([]), null, '空窗口不能伪造出一个分数');
});

test('单工具重复的 novelty 是 1/n，不是 0', () => {
  // 防御：如果有人把加权公式改成不含权重归一化，这条会红
  const calls = Array.from({ length: 4 }, () => callAt('git status', now));
  const n = noveltyOf(calls);
  assert.ok(Math.abs(n - 0.25) < 1e-9, `expected 0.25, got ${n}`);
});

// ── §4.2 自适应心跳阈值 ────────────────────────────────────────────────

test('样本不足时不返回阈值', () => {
  assert.equal(heartbeatThreshold([1000, 2000, 3000]), null);
});

test('阈值随会话自身分布自适应，且被夹在 [120s, 900s]', () => {
  const fast = Array.from({ length: 40 }, () => 10_000);           // 全 10s
  assert.equal(heartbeatThreshold(fast), 120_000, '下限 120s');

  const slow = Array.from({ length: 40 }, () => 3_000_000);        // 全 50min
  assert.equal(heartbeatThreshold(slow), 900_000, '上限 900s');
});

test('长间隔但未超过自适应阈值的会话不判 FAILED', () => {
  // 该会话历史上每隔 400s 才调用一次 → p95 约 400s → 180s 的间隔不该判死
  const t0 = now - 60 * MIN;
  const calls = [];
  for (let i = 0; i < 30; i++) calls.push(callAt('ls', t0 + i * 400_000));
  const gaps = [];
  for (let i = 1; i < calls.length; i++) gaps.push(calls[i].ts - calls[i - 1].ts);
  const v = judgeState({ calls, gapsMs: gaps });
  assert.notEqual(v.state, 'FAILED', `被误判为 FAILED：${v.reason}`);
});

// ── §2 状态互斥 ────────────────────────────────────────────────────────

test('纯探索（大量只读 Bash）判 EXPLORING，不判 PRODUCING', () => {
  // 这是原始设计稿的致命缺陷：ls/grep/git status 都是 Bash，会被判 PRODUCING
  const calls = [];
  for (let i = 0; i < 30; i++) {
    calls.push(callAt(`cat file${i}.txt`, now - (30 - i) * 1000));
  }
  const gaps = calls.slice(1).map((c, i) => c.ts - calls[i].ts);
  const v = judgeState({ calls, gapsMs: gaps });
  assert.equal(v.state, 'EXPLORING', `reason=${v.reason}`);
});

test('窗口内有 Write 判 PRODUCING', () => {
  const calls = [];
  for (let i = 0; i < 30; i++) calls.push(callAt(`cat f${i}.txt`, now - (30 - i) * 1000));
  calls.push({
    name: 'Write', sig: signatureOf('Write', { file_path: '/a' }),
    persistent: true, ts: now,
  });
  const gaps = calls.slice(1).map((c, i) => c.ts - calls[i].ts);
  const v = judgeState({ calls, gapsMs: gaps });
  assert.equal(v.state, 'PRODUCING');
});

test('连续重复读同一文件判 STALLED', () => {
  const calls = [];
  const sig = signatureOf('Read', { file_path: '/a.ts', offset: 0, limit: 100 });
  const start = now - 60_000;
  for (let i = 0; i < 80; i++) {
    calls.push({ name: 'Read', sig, persistent: false, ts: start + i * 500 });
  }
  const gaps = calls.slice(1).map((c, i) => c.ts - calls[i].ts);
  const v = judgeState({ calls, gapsMs: gaps });
  assert.equal(v.state, 'STALLED', `reason=${v.reason}`);
});

test('冷启动（不足一窗）只可能判 EXPLORING', () => {
  const calls = [callAt('ls', now), callAt('ls', now), callAt('ls', now)];
  const v = judgeState({ calls, gapsMs: [0, 0], sessionState: undefined });
  assert.equal(v.state, 'EXPLORING');
});

test('宿主明确报 failed 时判 FAILED，优先于其他分支', () => {
  const calls = [callAt('ls', now)];
  const v = judgeState({ calls, gapsMs: [], sessionState: 'failed' });
  assert.equal(v.state, 'FAILED');
  assert.equal(v.reason, 'host-reported-failed');
});

// ── 休眠与误判防御 ────────────────────────────────────────────────────

test('长时间无活动的会话判休眠，不判 FAILED', () => {
  // 实测反例：某会话空闲 72h，末次间隔 515s > p95 120s，被误判 FAILED
  const t0 = now - 80 * 3600_000;
  const calls = [];
  for (let i = 0; i < 30; i++) calls.push(callAt('ls', t0 + i * 400_000));
  const gaps = [];
  for (let i = 1; i < calls.length; i++) gaps.push(calls[i].ts - calls[i - 1].ts);
  const v = judgeState({ calls, gapsMs: gaps });
  assert.equal(v.state, 'EXPLORING');
  assert.equal(v.reason, 'dormant');
  assert.equal(v.liveness, 'stale');
});

test('归一化在病态输入上是线性的（防回溯爆炸回归）', () => {
  // 曾经的 bug：/(["'])(?:\\.|(?!\1).){40,}\1/ 在 ' + 连续反斜杠上 90 秒不返回
  const BS = String.fromCharCode(92);
  const pathological = [
    "'" + BS.repeat(400),
    "'" + (BS + "'").repeat(200),
    'cat "' + ('a' + BS).repeat(200),
    'grep -rn "' + 'x'.repeat(5000) + '" d/',
  ];
  for (const s of pathological) {
    const t = process.hrtime.bigint();
    normalizeBash(s);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 100, `归一化 ${s.length} 字符耗时 ${ms.toFixed(0)}ms，疑似回溯爆炸`);
  }
});

test('长字符串字面量被替换但不影响短参数', () => {
  assert.equal(
    normalizeBash('grep -rn "' + 'x'.repeat(100) + '" d/').digest,
    normalizeBash('grep -rn "' + 'y'.repeat(100) + '" d/').digest,
    '长字符串内容不同应归一到同一签名',
  );
  // 带引号的短参数必须保留：若 minLen 被误调成 1，这条会红
  assert.notEqual(
    normalizeBash('git log --grep "fix"').digest,
    normalizeBash('git log --grep "feat"').digest,
    '带引号的短参数不应被吞掉',
  );
  assert.notEqual(
    normalizeBash("node -e 'import a'").digest,
    normalizeBash("node -e 'import b'").digest,
    '单引号短参数同理',
  );
});

test('宿主权威失败信号不被休眠闸门降级', () => {
  // 验收 r2 发现的顺序倒置：休眠分支曾排在 host-failed 之前
  const t0 = now - 120 * 3600_000;                       // 2 小时前
  const calls = [];
  for (let i = 0; i < 30; i++) calls.push(callAt('ls', t0 + i * 400_000));
  const gaps = [];
  for (let i = 1; i < calls.length; i++) gaps.push(calls[i].ts - calls[i - 1].ts);
  const v = judgeState({ calls, gapsMs: gaps, sessionState: 'failed' });
  assert.equal(v.state, 'FAILED', '宿主说 failed 就是 failed，不管多久以前');
  assert.equal(v.reason, 'host-reported-failed');
});
