#!/usr/bin/env node
/**
 * measure-checklist-coverage.test.mjs — 覆盖率度量器的判据必须是可验的。
 *
 * 这个脚本的**唯一价值**是那个「不含沙箱」的数字。如果沙箱过滤坏了，
 * 它会安静地报出一个偏高的派发率，而那个数字看起来完全合理 ——
 * 没有任何东西会响。本仓有明确先例（`DF-031`：66 条探针被静默跳过，
 * 输出和通过一模一样）。
 *
 * 所以这里用**构造语料**验，不依赖本机真实数据（那会随机器而变，
 * 且测试不该读用户的 500 份 transcript）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, 'measure-checklist-coverage.mjs');

/** 造一份最小 transcript：一行 tool_use 记录即可。 */
const line = (name) => JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name }] },
});

/** 建一个假的项目目录树。`which` 决定每个 transcript 里放什么内容。 */
function fixture(projects) {
  const root = mkdtempSync(join(tmpdir(), 'ow-cov-'));
  for (const [proj, contents] of Object.entries(projects)) {
    const dir = join(root, proj);
    mkdirSync(dir, { recursive: true });
    contents.forEach((c, i) => writeFileSync(join(dir, `s${i}.jsonl`), c.join('\n')));
  }
  return root;
}

const run = (root, args = []) => {
  const r = spawnSync(process.execPath, [CLI, '--root', root, '--json', ...args], {
    encoding: 'utf8', timeout: 30000,
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

test('派发率与清单率按 transcript 计数，一个会话算一次', () => {
  const root = fixture({
    'real-proj': [
      [line('Agent'), line('Agent')],   // 两次 Agent 调用，但仍只算 1 份「有派发」
      [line('Bash')],                    // 无派发
      [line('Agent'), 'task-graph.json'], // 有派发 + 有清单
      [line('Bash')],
    ],
  });
  try {
    const { status, out } = run(root);
    assert.equal(status, 0);
    const j = JSON.parse(out);
    assert.equal(j.all.transcripts, 4);
    assert.equal(j.all.withAgentCall, 2, '按份数算，不按调用次数算');
    assert.equal(j.all.withTaskGraph, 1);
    assert.equal(j.all.agentRatePct, 50);
    assert.equal(j.all.graphRatePct, 25);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('沙箱目录必须被排除 —— 这是整个脚本存在意义的判据', () => {
  const root = fixture({
    // 名字里带 Temp 的由测试脚本创建，不参与「真实使用」口径
    'C--Users-ADMINI-1-AppData-Local-Temp-hook-e2e-proj': [[line('Agent')], [line('Agent')]],
    'C--Projects-Overwatch--tmp-analysis-proto-proj': [[line('Agent')]],
    // 真实项目
    'D--Projects-Real': [[line('Bash')]],
  });
  try {
    const { out } = run(root);
    const j = JSON.parse(out);

    assert.equal(j.all.transcripts, 4, '含沙箱口径要看到全部');
    assert.equal(j.sandbox.transcripts, 3, '沙箱口径要能单独数出来');
    assert.equal(j.real.transcripts, 1, '真实口径只剩 1 份');

    // 这一条是关键：如果沙箱没被排除，real 的派发率会变成 100%（3/3），
    // 而正确值是 0%（那 1 份真实 transcript 里没有 Agent 调用）。
    assert.equal(j.real.withAgentCall, 0);
    assert.equal(j.real.agentRatePct, 0);
    assert.equal(j.all.agentRatePct, 75, '含沙箱时 3/4 = 75%');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('`"name":"Agent"` 才算派发 —— 正文里提到 Agent 不算', () => {
  const root = fixture({
    'real-proj': [
      // 只在 assistant 文本里说「我打算调用 Agent」，没有 tool_use
      [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '我会调用 Agent 去并行做这件事' }] } })],
      [line('Agent')],
    ],
  });
  try {
    const { out } = run(root);
    const j = JSON.parse(out);
    // 若把「提到」也算上，这里会是 2。正确值是 1。
    assert.equal(j.all.withAgentCall, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('窗口按 mtime 过滤：太旧的文件不进统计', () => {
  const root = fixture({ 'real-proj': [[line('Agent')]] });
  try {
    // 30 天的窗口，但文件是刚写的 → 应当被计入
    const recent = JSON.parse(run(root, ['--days', '30']).out);
    assert.equal(recent.all.transcripts, 1);

    // --days 0 表示「今天之前都不算」；用未来光标把窗口压到 0 宽
    const empty = JSON.parse(run(root, ['--days', '-1']).out);
    assert.equal(empty.all.transcripts, 0, '负窗口应当什么都不算，而不是退回默认值');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('根目录不存在时退出码 2，不伪造一份全零报告', () => {
  const r = spawnSync(process.execPath, [CLI, '--root', join(tmpdir(), 'definitely-not-here-ow')], {
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal(r.status, 2, '读不到语料就必须说读不到，不能报 0');
  assert.match(String(r.stderr), /找不到 transcript 根/);
});
