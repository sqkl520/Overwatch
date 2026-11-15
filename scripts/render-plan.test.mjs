#!/usr/bin/env node
/**
 * render-plan.test.mjs — 「每轮开头一个 plan」的回归测试。
 *
 * 这些测试守的不是格式，是这条功能**唯一的用途**：让用户在一屏之内知道
 * 「这一轮要做哪几件事、现在到哪了、卡在哪、下一步是什么」。
 *
 * 六组：
 *   1. 5 子树的正常渲染 —— 每行都要有一个状态，且**行数不超过 20**
 *   2. 空状态必须诚实 —— 没有图就说「没有图」，不许渲染一份空壳假装有
 *   3. 失败子树必须显著 —— 记号 + 卡在哪 + 下一步，三样缺一不算显著
 *   4. `--json` 与默认输出**同源** —— JSON 里的 lines 就是人读的那个数组
 *   5. 行数上限 —— 子树很多时砍的是行数与细节，且必须**明说**砍了什么
 *   6. 负向：进度来源改错时这些测试必须红
 *
 * 第 6 组是整份文件里最重要的。渲染器自己不产生状态，它的全部价值来自
 * 「进度真的来自台账」。若有人把进度改成「写了 prompts.jsonl 就算完成」
 * 或「图里有 outputs 就算完成」，前五组仍然会全绿 —— 只有第 6 组会红。
 * 所以第 6 组的用例是**反向断言**：单独一条派发记录**不得**被判为完成。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  buildPlan, formatPlan, renderPlan, loadRun, findLatestRun, displayPath,
  MAX_LINES, ROW_WIDTH, PLAN_VERSION, VERIFIED_GLYPHS,
} from './render-plan.mjs';

// ── 夹具 ──────────────────────────────────────────────────────────────

const tmp = () => mkdtempSync(join(tmpdir(), 'ow-plan-'));

const ac = (id = 'AC1') => ({
  id, criterion: '渲染出这一行', evidence: 'scripts/render-plan.mjs:1', fail_if: '缺行',
});

const sub = (over = {}) => ({
  id: 'ST1', goal: '写渲染器', capability: 'executor', shape: 'artifact',
  token_budget_pct: 20, timeout_min: 8, parallel_with: [], depends_on: [],
  acceptance: [ac()], outputs: ['scripts/a.mjs'], why_this_layer: '独立可测',
  ...over,
});

const graph = (subs, over = {}) => ({
  run_id: 'r1', root_goal: '目标', constraints: [], subtrees: subs, ...over,
});

/** 注入的磁盘：`{ 'a.mjs': {size, sha256} }` → `probe(p) => {exists,...}`。
 *  形状必须与 `claim-ledger.probeDisk` 一致（`reconcile` 读 `disk.exists`）。 */
const probeOf = (files) => (p) => {
  const f = files[p];
  if (!f) return { exists: false };
  return {
    exists: true, size: f.size, mtimeMs: f.mtimeMs || 0,
    sha256: f.sha256 || null, hashTruncated: f.hashTruncated === true,
  };
};

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const at = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

const expectRow = (task, paths, minAgo = 10, timeoutMin = 8) => ({
  v: 1, ts: at(minAgo), kind: 'expect', run: 'r1', task, role: 'executor',
  paths, nonce: task.toLowerCase().padEnd(8, '0').slice(0, 8), timeoutMin,
});
const claimRow = (task, path, minAgo = 5, bytes = null, sha256 = null) => ({
  v: 1, ts: at(minAgo), kind: 'claim', run: 'r1', task, agent: null, path,
  source: 'self', ...(bytes == null ? {} : { bytes }), ...(sha256 ? { sha256 } : {}),
});
const consumeRow = (task, minAgo = 4) => ({
  v: 1, ts: at(minAgo), kind: 'consume', run: 'r1', task, path: null, by: 'main',
});
const promptRow = (task, minAgo = 9) => ({
  v: 1, ts: at(minAgo), kind: 'prompt', run: 'r1', task, role: 'executor',
  hash: 'a'.repeat(64), bytes: 1200, ok: true,
});

/** 一个「1 完成 / 1 失败 / 3 待跑」的 5 子树场景 —— 用户点名要看的那一种。 */
function scenarioFive() {
  const g = graph([
    sub({ id: 'ST1', goal: '写渲染器', outputs: ['scripts/a.mjs'] }),
    sub({ id: 'ST2', goal: '写测试', outputs: ['scripts/b.test.mjs'] }),
    sub({ id: 'ST3', goal: '写设计文档', outputs: ['docs/c.md'] }),
    sub({ id: 'ST4', goal: '锐评', capability: 'critic', shape: 'exploration', outputs: [] }),
    sub({ id: 'ST5', goal: '验收', capability: 'acceptor', shape: 'artifact', outputs: ['docs/d.md'] }),
  ]);
  const rows = [
    // ST1：完整三方对齐并认领 → DONE
    expectRow('ST1', ['scripts/a.mjs'], 40, 12),
    claimRow('ST1', 'scripts/a.mjs', 12, 10, 'h1'),
    consumeRow('ST1', 11),
    // ST2：自述说写了、磁盘没有 → MISSING → FAILED
    expectRow('ST2', ['scripts/b.test.mjs'], 38, 10),
    claimRow('ST2', 'scripts/b.test.mjs', 5, 200, 'h2'),
    // ST3/ST4/ST5：没有任何台账行 → PENDING
  ];
  const probe = probeOf({ 'scripts/a.mjs': { size: 10, sha256: 'h1' } });
  return { g, rows, probe };
}

// ── 组 1：5 子树的正常渲染 ────────────────────────────────────────────

test('5 子树：每行都有状态，完成/失败/待跑各就各位', () => {
  const { g, rows, probe } = scenarioFive();
  const plan = buildPlan({ graph: g, claimRows: rows, nowMs: NOW, probe, root: '/r' });
  assert.equal(plan.empty, false);
  assert.equal(plan.subtrees.length, 5);
  assert.equal(plan.totals.total, 5);
  assert.equal(plan.totals.done, 1);
  assert.equal(plan.totals.failed, 1);
  assert.equal(plan.totals.pending, 3);
  const byId = new Map(plan.subtrees.map((r) => [r.id, r]));
  assert.equal(byId.get('ST1').state, 'DONE');
  assert.equal(byId.get('ST2').state, 'FAILED');
  assert.equal(byId.get('ST3').state, 'PENDING');
  assert.equal(byId.get('ST4').state, 'PENDING');
  assert.equal(byId.get('ST5').state, 'PENDING');
  assert.equal(plan.ok, false);
});

test('5 子树的人读输出不超过 20 行（这是硬指标，不是建议）', () => {
  const { g, rows, probe } = scenarioFive();
  const plan = buildPlan({ graph: g, claimRows: rows, nowMs: NOW, probe, root: '/r' });
  const lines = formatPlan(plan);
  assert.ok(
    lines.length <= MAX_LINES,
    `渲染了 ${lines.length} 行，超过上限 ${MAX_LINES}：\n${lines.join('\n')}`,
  );
  // 5 个子树必须都在，一个都不能因为挤而消失
  for (const id of ['ST1', 'ST2', 'ST3', 'ST4', 'ST5']) {
    assert.ok(lines.some((l) => l.includes(id)), `输出里没有 ${id} 这一行`);
  }
});

test('摘要行给出「完成/总数」，不是只给一堆分类计数', () => {
  const { g, rows, probe } = scenarioFive();
  const lines = formatPlan(buildPlan({ graph: g, claimRows: rows, nowMs: NOW, probe, root: '/r' }));
  assert.ok(lines.some((l) => /进度 1\/5 完成/.test(l)), lines.join('\n'));
});

test('每行都带 goal 与 capability —— 用户要看到「在做什么」而不是一串 id', () => {
  const { g, rows, probe } = scenarioFive();
  const lines = formatPlan(buildPlan({ graph: g, claimRows: rows, nowMs: NOW, probe, root: '/r' }));
  const st2 = lines.find((l) => l.includes('ST2'));
  assert.match(st2, /写测试/);
  assert.match(st2, /exec/);
});

// ── 组 2：空状态必须诚实 ──────────────────────────────────────────────

test('没有 task-graph.json → 明说「还没规划」，不假装有一份空计划', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'r1'), { recursive: true });
    const loaded = loadRun({ runsDir: dir, run: 'r1' });
    assert.equal(loaded.graphError, 'no-graph');
    const plan = buildPlan({
      graph: loaded.graph, graphError: loaded.graphError, run: 'r1', nowMs: NOW, root: dir,
    });
    assert.equal(plan.empty, true);
    assert.equal(plan.subtrees.length, 0);
    assert.equal(plan.ok, false);
    const lines = formatPlan(plan);
    const text = lines.join('\n');
    assert.match(text, /任务图不存在/);
    assert.match(text, /还没规划/);
    // 不许出现任何「看起来像计划」的骨架
    assert.ok(!/进度 0\/0 完成/.test(text), '空计划被渲染成了 0/0 的假计划');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('run 目录不存在 / 任务图 JSON 读不懂 —— 三种空状态各说各的话', () => {
  const dir = tmp();
  try {
    const a = buildPlan({
      graphError: 'no-run-dir', run: 'x', path: join(dir, 'x', 'task-graph.json'), nowMs: NOW, root: dir,
    });
    const b = buildPlan({
      graphError: 'invalid-json', graphErrorMsg: 'Unexpected token }',
      run: 'x', path: join(dir, 'x', 'task-graph.json'), nowMs: NOW, root: dir,
    });
    const ta = formatPlan(a).join('\n');
    const tb = formatPlan(b).join('\n');
    assert.match(ta, /run 目录不存在/);
    assert.match(tb, /JSON 解析失败/);
    assert.match(tb, /Unexpected token/);
    // 三种成因的处置完全不同，文案不许合并成同一句
    assert.notEqual(ta, tb);
    assert.equal(a.empty, true);
    assert.equal(b.empty, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tasks/runs 下一个 run 都没有 → 空状态说「还没跑过一次规划」', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'empty-run'), { recursive: true });
    const pick = findLatestRun(dir);
    assert.equal(pick.run, null);
    const { plan, lines } = renderPlan({ runsDir: dir, root: dir, nowMs: NOW });
    assert.equal(plan.empty, true);
    assert.match(lines.join('\n'), /还没跑过一次规划/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('空的 subtrees 数组也不装作有计划', () => {
  const plan = buildPlan({
    graph: { run_id: 'r1', root_goal: 'g', constraints: [], subtrees: [] },
    nowMs: NOW, root: '/r', probe: probeOf({}),
  });
  assert.equal(plan.empty, true);
  assert.equal(plan.subtrees.length, 0);
});

// ── 组 3：失败子树必须显著 ────────────────────────────────────────────

test('失败行必须同时给出：记号、卡在哪、下一步 —— 缺一不算显著', () => {
  const { g, rows, probe } = scenarioFive();
  const plan = buildPlan({ graph: g, claimRows: rows, nowMs: NOW, probe, root: '/r' });
  const lines = formatPlan(plan);
  const i = lines.findIndex((l) => l.includes('ST2'));
  assert.ok(i >= 0);
  // 记号：× 而不是其它行用的 ○/√。选 `×`（U+00D7）而不是 `✗`(U+2717) 的理由是
  // 四款等宽字体里只有前者有 cmap 覆盖，且列表页已经把 `×` 用作 FAILED（同一个
  // 概念两个字形是缺陷）。见 tui-visual.md §3.1 与本文件的「记号不得同屏复用」两条。
  assert.match(lines[i], /×/);
  assert.equal(plan.subtrees.find((r) => r.id === 'ST2').mark, '×');
  // 卡在哪：必须点名那个没落地的文件
  const detail = lines.slice(i + 1, i + 3).join('\n');
  assert.match(detail, /卡在：/);
  assert.match(detail, /scripts\/b\.test\.mjs/);
  // 下一步：必须是一个动作，且不得是「重跑」
  assert.match(detail, /下一步：/);
  assert.match(detail, /退回该 Agent/);
  assert.ok(!/整轮重跑/.test(lines[i]), '失败行不该建议整轮重跑');
});

test('PARTIAL 的下一步是「只续做缺的」，不是整轮重跑', () => {
  const g = graph([sub({ id: 'ST1', outputs: ['a.mjs', 'b.mjs'], shape: 'artifact' })]);
  const rows = [
    expectRow('ST1', ['a.mjs', 'b.mjs']),
    claimRow('ST1', 'a.mjs', 5, 10, 'ha'),
  ];
  const plan = buildPlan({
    graph: g, claimRows: rows, nowMs: NOW, root: '/r',
    probe: probeOf({ 'a.mjs': { size: 10, sha256: 'ha' } }),
  });
  const r = plan.subtrees[0];
  assert.equal(r.state, 'STUCK');
  assert.match(r.note, /1\/2 落地/);
  assert.match(r.next_step, /只续做缺的/);
  assert.match(r.blocker, /b\.mjs/);
});

test('CONFLICT 的下一步是「停下人工裁决」，且点名争用方', () => {
  const g = graph([
    sub({ id: 'ST1', outputs: ['shared.md'] }),
    sub({ id: 'ST2', outputs: ['shared.md'] }),
  ]);
  const rows = [
    expectRow('ST1', ['shared.md']), expectRow('ST2', ['shared.md']),
    claimRow('ST1', 'shared.md', 5, 10, 'h'), claimRow('ST2', 'shared.md', 5, 10, 'h'),
  ];
  const plan = buildPlan({
    graph: g, claimRows: rows, nowMs: NOW, root: '/r',
    probe: probeOf({ 'shared.md': { size: 10, sha256: 'h' } }),
  });
  const r = plan.subtrees.find((x) => x.id === 'ST1');
  assert.equal(r.state, 'FAILED');
  assert.match(r.note, /争用/);
  assert.match(r.next_step, /人工裁决/);
  assert.match(r.blocker, /ST2/);
});

test('超时只标「超时」，措辞里明说静默不是失败判据', () => {
  const g = graph([sub({ id: 'ST1', timeout_min: 5, outputs: ['a.mjs'] })]);
  const rows = [expectRow('ST1', ['a.mjs'], 30, 5)];
  const plan = buildPlan({ graph: g, claimRows: rows, nowMs: NOW, root: '/r', probe: probeOf({}) });
  const r = plan.subtrees[0];
  assert.equal(r.state, 'OVERDUE');
  assert.equal(r.mark, '!');
  assert.match(r.next_step, /observe/);
  assert.match(r.next_step, /不要直接重跑/);
  // 状态名必须是 OVERDUE，不是 FAILED —— 这两个的处置不同
  assert.notEqual(r.state, 'FAILED');
});

test('声明 artifact 却没有 outputs → 规划缺陷，先于「待跑」', () => {
  const g = graph([sub({ id: 'ST1', shape: 'artifact', outputs: [] })]);
  const plan = buildPlan({ graph: g, rows: [], claimRows: [], nowMs: NOW, root: '/r', probe: probeOf({}) });
  const r = plan.subtrees[0];
  assert.equal(r.state, 'DEFECT');
  assert.match(r.blocker, /outputs/);
  assert.match(r.next_step, /validate-run/);
});

// ── 组 4：--json 与人读同源 ───────────────────────────────────────────

test('--json 的 lines 与默认输出逐行完全相同（不许两套逻辑）', () => {
  const { g, rows, probe } = scenarioFive();
  const plan = buildPlan({ graph: g, claimRows: rows, nowMs: NOW, probe, root: '/r' });
  const human = formatPlan(plan);
  // CLI 把 lines 塞进 JSON；这里模拟同一条路径：渲染函数只被调用一次
  const asJson = JSON.parse(JSON.stringify({ ...plan, lines: human }));
  assert.deepEqual(asJson.lines, human);
  assert.equal(asJson.v, PLAN_VERSION);
});

test('--json 结构完整：状态、记号、卡在哪、下一步一个都不缺', () => {
  const { g, rows, probe } = scenarioFive();
  const plan = buildPlan({ graph: g, claimRows: rows, nowMs: NOW, probe, root: '/r' });
  const need = ['id', 'goal', 'capability', 'shape', 'state', 'mark', 'label',
    'note', 'blocker', 'next_step', 'outputs', 'outputs_expected', 'outputs_landed',
    'consumed', 'elapsed_min', 'timeout_min', 'depends_on', 'verdict', 'items'];
  for (const r of plan.subtrees) {
    for (const k of need) {
      assert.ok(k in r, `${r.id} 缺字段 ${k}`);
    }
  }
  for (const k of ['total', 'done', 'failed', 'stuck', 'pending', 'running']) {
    assert.ok(k in plan.totals, `totals 缺 ${k}`);
  }
  assert.ok('ok' in plan && 'needs_attention' in plan && 'budget_pct' in plan);
});

test('机器可读的 subtrees 顺序与图一致（plan 的顺序本身有意义）', () => {
  const { g, rows, probe } = scenarioFive();
  const plan = buildPlan({ graph: g, claimRows: rows, nowMs: NOW, probe, root: '/r' });
  assert.deepEqual(plan.subtrees.map((r) => r.id), ['ST1', 'ST2', 'ST3', 'ST4', 'ST5']);
});

// ── 组 5：行数上限 ────────────────────────────────────────────────────

test('12 个子树全部超时仍然不超过 20 行，且明说砍掉了什么', () => {
  const subs = Array.from({ length: 12 }, (_, i) => sub({
    id: `ST${i + 1}`, goal: `任务 ${i + 1}`, outputs: [`f${i}.md`], timeout_min: 1,
  }));
  const rows = subs.map((s) => expectRow(s.id, s.outputs, 5, 1)); // 全部超时 → 每条都想带细节
  const plan = buildPlan({
    graph: graph(subs), claimRows: rows, nowMs: NOW, root: '/r', probe: probeOf({}),
  });
  const lines = formatPlan(plan);
  assert.ok(lines.length <= MAX_LINES, `渲染了 ${lines.length} 行：\n${lines.join('\n')}`);
  // 要么砍了行、要么砍了细节；无论哪种都必须在输出里说出来
  assert.ok(
    lines.some((l) => /还有 \d+ 个子树未显示/.test(l)) || lines.some((l) => /\d+ 个需处理项的细节被行数上限挤掉/.test(l)),
    '砍了内容却没告知，等于静默截断',
  );
});

test('25 个子树时行本身被砍，且「未显示」的条数被印出来', () => {
  const subs = Array.from({ length: 25 }, (_, i) => sub({
    id: `ST${i + 1}`, goal: `任务 ${i + 1}`, outputs: [`f${i}.md`],
  }));
  const plan = buildPlan({
    graph: graph(subs), claimRows: [], nowMs: NOW, root: '/r', probe: probeOf({}),
  });
  const lines = formatPlan(plan);
  assert.ok(lines.length <= MAX_LINES, `渲染了 ${lines.length} 行`);
  assert.ok(lines.some((l) => /还有 \d+ 个子树未显示（图里共 25 个）/.test(l)), lines.join('\n'));
});

test('台账坏行警告也计入 20 行上限，且 JSON 与人读仍一致', () => {
  const subs = Array.from({ length: 12 }, (_, i) => sub({
    id: `ST${i + 1}`, goal: `任务 ${i + 1}`, outputs: [`f${i}.md`], timeout_min: 1,
  }));
  const rows = subs.map((s) => expectRow(s.id, s.outputs, 5, 1));
  const bad = [{ line: 3, raw: '{broken' }, { line: 7, raw: 'also broken' }];
  const plan = buildPlan({
    graph: graph(subs), claimRows: rows, claimBadLines: bad,
    nowMs: NOW, root: '/r', probe: probeOf({}),
  });
  assert.equal(plan.notes.length, 1);
  const lines = formatPlan(plan);
  assert.ok(lines.length <= MAX_LINES, `渲染了 ${lines.length} 行（⚠ 行会撑破上限）`);
  assert.ok(lines.some((l) => /claims\.jsonl 有 2 行读不懂/.test(l)), '台账坏行没进人读输出');
  // 同源：CLI 打印的就是这个数组，没有第二次追加
  assert.deepEqual(JSON.parse(JSON.stringify({ ...plan, lines })).lines, lines);
});

test('单行宽度有上限，不会把「一屏」变成一堆折行', () => {
  const long = '很长的目标'.repeat(40);
  const g = graph([sub({ id: 'ST1', goal: long, outputs: ['a.mjs'] })]);
  const lines = formatPlan(buildPlan({
    graph: g, claimRows: [expectRow('ST1', ['a.mjs'])], nowMs: NOW, root: '/r', probe: probeOf({}),
  }));
  for (const l of lines) {
    // 中文字符按终端宽度 2 计；这里只要求不出现「几百字的超长行」
    assert.ok(l.length <= ROW_WIDTH, `一行 ${l.length} 字，超过 ${ROW_WIDTH}：${l.slice(0, 40)}…`);
  }
});

// ── 组 6：负向 —— 进度来源改错时测试必须红 ────────────────────────────
//
// 这一组是整份文件的重点。渲染器不产生状态，它的正确性完全取决于
// 「进度是不是真的从台账来的」。下面四条用例把四个最容易改错的来源逐个钉住。

test('负向：只写了 prompts.jsonl（派发记录）不得被判为完成', () => {
  const g = graph([sub({ id: 'ST1', outputs: ['a.mjs'] })]);
  // 只有派发记录，没有任何 expect/claim/consume，磁盘上也没有文件
  const plan = buildPlan({
    graph: g, promptRows: [promptRow('ST1')], claimRows: [], nowMs: NOW, root: '/r', probe: probeOf({}),
  });
  const r = plan.subtrees[0];
  assert.notEqual(r.state, 'DONE', '把「派发出去」当成了「活干完了」——这正是要治的病');
  assert.equal(r.state, 'OVERDUE'); // 派了 9 分钟、限时 8 分、零产出
  assert.equal(plan.totals.done, 0);
});

test('负向：图里有 outputs 且磁盘上有同名文件，不得自动判完成', () => {
  const g = graph([sub({ id: 'ST1', outputs: ['a.mjs'] })]);
  // 文件在，但台账里没有任何登记 —— 这是 UNREPORTED，不是 COMPLETE
  const plan = buildPlan({
    graph: g, claimRows: [], nowMs: NOW, root: '/r',
    probe: probeOf({ 'a.mjs': { size: 10, sha256: 'h' } }),
  });
  const r = plan.subtrees[0];
  assert.notEqual(r.state, 'DONE', '「文件在」不等于「这个子树干完了」');
  assert.equal(r.state, 'LANDED_UNCLAIMED');
  assert.match(r.next_step, /declare|认领/);
});

test('负向：checksum 对不上时不得判完成（自述说写了≠写的是这一份）', () => {
  const g = graph([sub({ id: 'ST1', outputs: ['a.mjs'] })]);
  const rows = [expectRow('ST1', ['a.mjs']), claimRow('ST1', 'a.mjs', 5, 10, 'old-hash')];
  const plan = buildPlan({
    graph: g, claimRows: rows, nowMs: NOW, root: '/r',
    probe: probeOf({ 'a.mjs': { size: 10, sha256: 'new-hash' } }),
  });
  const r = plan.subtrees[0];
  assert.equal(r.state, 'FAILED');
  assert.equal(r.verdict, 'DRIFTED');
  assert.match(r.blocker, /改过/);
});

test('负向：把「认领」当成必需 —— 产出完整但未 consume 时不得显示「已完成」', () => {
  const g = graph([sub({ id: 'ST1', outputs: ['a.mjs'] })]);
  const rows = [expectRow('ST1', ['a.mjs']), claimRow('ST1', 'a.mjs', 5, 10, 'h')];
  const plan = buildPlan({
    graph: g, claimRows: rows, nowMs: NOW, root: '/r',
    probe: probeOf({ 'a.mjs': { size: 10, sha256: 'h' } }),
  });
  const r = plan.subtrees[0];
  // 产出落地 + 认领 = 完成；只落地没认领时台账判 COMPLETE 但 consumed=false，
  // 渲染层必须给出「待认领」的提示，不能显示成「已落地并认领」。
  assert.equal(r.consumed, false);
  assert.match(r.note, /待认领/);
  assert.match(r.next_step, /consume/);
});

test('负向：台账顺序颠倒不影响结论（progress 不能靠「最后一行」猜）', () => {
  const g = graph([sub({ id: 'ST1', outputs: ['a.mjs'] })]);
  const forward = [
    expectRow('ST1', ['a.mjs'], 40), claimRow('ST1', 'a.mjs', 20, 10, 'h'), consumeRow('ST1', 10),
  ];
  const shuffled = [forward[2], forward[0], forward[1]];
  const probe = probeOf({ 'a.mjs': { size: 10, sha256: 'h' } });
  const a = buildPlan({ graph: g, claimRows: forward, nowMs: NOW, root: '/r', probe });
  const b = buildPlan({ graph: g, claimRows: shuffled, nowMs: NOW, root: '/r', probe });
  assert.equal(a.subtrees[0].state, 'DONE');
  assert.equal(b.subtrees[0].state, 'DONE', '台账行序影响了结论——进度来源接错了');
});

// ── CLI 端到端 ────────────────────────────────────────────────────────

test('CLI：--json 与默认输出同源，退出码反映「有没有要处理的」', () => {
  const dir = tmp();
  try {
    const runDir = join(dir, 'runs', 'r1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'task-graph.json'), JSON.stringify(
      graph([sub({ id: 'ST1', outputs: ['a.mjs'] })]), null, 2), 'utf8');
    // 这条测试**跑真子进程**，拿不到注入时钟 —— 其余测试都用固定 `NOW` 喂 `buildPlan`，
    // 但子进程里的 CLI 读的是真实挂钟。所以这里的登记时刻必须相对**真实现在**算，
    // 不能用模块里的 `at()`（它锚在固定的 `NOW = 2026-11-14T12:00:00Z` 上）：
    // 那会让这条测试随时间流逝必然从 OK 变成 OVERDUE，写出来当天就会红。
    const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(runDir, 'claims.jsonl'), JSON.stringify({
      ...expectRow('ST1', ['a.mjs'], 0, 8), ts: oneMinAgo,
    }) + '\n', 'utf8');
    mkdirSync(join(dir, 'a.mjs'), { recursive: true }); // 不是文件 → 判不出落地
    const bin = join(import.meta.dirname, 'render-plan.mjs');
    const human = spawnSync(process.execPath, [bin, '--runs-dir', join(dir, 'runs'), '--root', dir], {
      encoding: 'utf8', timeout: 30000,
    });
    const json = spawnSync(process.execPath, [bin, '--runs-dir', join(dir, 'runs'), '--root', dir, '--json'], {
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(json.status, 0, `status=${json.status} stderr=${json.stderr} stdout=${json.stdout.slice(0, 800)}`);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.empty, false);
    assert.equal(parsed.subtrees.length, 1);
    assert.deepEqual(parsed.lines, human.stdout.trimEnd().split('\n'));
    assert.ok(parsed.lines.length <= MAX_LINES);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI：没有图时退出码非零，且 stdout 不出现任何「计划骨架」', () => {
  const dir = tmp();
  try {
    const bin = join(import.meta.dirname, 'render-plan.mjs');
    const r = spawnSync(process.execPath, [bin, '--runs-dir', join(dir, 'runs'), '--root', dir], {
      encoding: 'utf8', timeout: 30000,
    });
    assert.notEqual(r.status, 0, '空状态却返回 0，等于说「一切正常」');
    assert.match(r.stdout, /无可渲染的计划/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('displayPath 不输出本机绝对路径', () => {
  // 用不存在的虚拟根，只验形态：命中仓库根就转相对，否则只留末两段
  const shown = displayPath('/repo-root/scripts/render-plan.mjs', '/repo-root');
  assert.equal(shown, 'scripts/render-plan.mjs');
  assert.ok(!/^[\\/]/.test(shown), '输出了绝对路径');
  // 仓库外的路径只留末两段，避免泄出本机目录结构
  const outside = displayPath('/var/folders/xx/yy/task-graph.json', '/repo-root');
  assert.equal(outside, 'yy/task-graph.json');
});

// ── 组 7：depends_on 参与判定（PENDING 拆三态）──────────────────────────
//
// 这一组守的是「被前置阻塞」这件事**在屏幕上可见**。修改前 `depends_on` 被写进
// `base` 对象之后全文再没有读过一次，于是「还没轮到」「没人管」「前置倒了」
// 三种处境在屏幕上完全同形 —— 都是 `○ 待跑`。而它们的处置没有一条相同：
// 前两者不用人动手，第三者必须先修前置。
//
// 每条都成对：**正向断言新状态，负向断言它不是 PENDING**。只断言前者的话，
// 把整段依赖逻辑删掉、让所有子树都落 `UPSTREAM_FAILED` 也能过。

/** 只造台账：某子树被派过且有终局结论。 */
const failedRow = (task, path, minAgo = 5) => claimRow(task, path, minAgo, 10, 'declared-hash');

/** A 失败、B 依赖 A 的图。`bOver` 用来改 B 的 on_dependency_failed。 */
function scenarioUpstream(bOver = {}) {
  const g = graph([
    sub({ id: 'A', goal: '写基础库', outputs: ['a.mjs'] }),
    sub({ id: 'B', goal: '在基础库上写上层', outputs: ['b.mjs'], depends_on: ['A'], ...bOver }),
  ]);
  // A：自述写了、磁盘上没有 → MISSING → FAILED（这是「前置真的倒了」的最硬形态）
  const rows = [expectRow('A', ['a.mjs']), failedRow('A', 'a.mjs')];
  return { g, rows, probe: probeOf({}) };
}

test('前置失败 → 下游是 UPSTREAM_FAILED，不是 PENDING（这是修改前最误导的一格）', () => {
  const { g, rows, probe } = scenarioUpstream();
  const plan = buildPlan({ graph: g, claimRows: rows, nowMs: NOW, probe, root: '/r' });
  const byId = new Map(plan.subtrees.map((r) => [r.id, r]));

  assert.equal(byId.get('A').state, 'FAILED', '前置本身必须是 FAILED（否则这一组测的不是这件事）');
  assert.equal(byId.get('B').state, 'UPSTREAM_FAILED');
  assert.notEqual(byId.get('B').state, 'PENDING', '前置倒了却显示「待跑」——等于让人去派一件派不出去的事');
  // 要人处理：进 needs_attention，且排在 FAILED 之后、STUCK 之前
  assert.deepEqual(plan.needs_attention, ['A', 'B']);
  // 卡在哪与下一步必须点名那个前置，否则「先处理 A」这句无从执行
  assert.match(byId.get('B').blocker, /A/);
  assert.match(byId.get('B').next_step, /A/);
  // 记号不能与 FAILED 相同：两者处置不同（一个是自己做砸了，一个是没拿到输入）
  assert.notEqual(byId.get('B').mark, byId.get('A').mark);
});

test('on_dependency_failed: "degrade" → 前置失败也不冻住（research 型子树的活路）', () => {
  const { g, rows, probe } = scenarioUpstream({ on_dependency_failed: 'degrade' });
  const plan = buildPlan({ graph: g, claimRows: rows, nowMs: NOW, probe, root: '/r' });
  const b = plan.subtrees.find((r) => r.id === 'B');
  assert.equal(b.state, 'PENDING', 'degrade 的含义就是「前置倒了我也能做我能做的」，它该被派');
  assert.notEqual(b.state, 'UPSTREAM_FAILED');
  assert.equal(b.on_dependency_failed, 'degrade');
  // 缺省必须是 block：没有这个字段时不许默默降级
  const plain = buildPlan({ graph: scenarioUpstream().g, claimRows: rows, nowMs: NOW, probe, root: '/r' });
  assert.equal(plain.subtrees.find((r) => r.id === 'B').on_dependency_failed, 'block');
});

test('前置还在跑 → 下游是 WAITING_ON，且**不进** ATTENTION（不用人处理）', () => {
  const g = graph([
    sub({ id: 'B', goal: '跑着的那个', outputs: ['b.mjs'] }),
    sub({ id: 'A', goal: '等它', outputs: ['a.mjs'], depends_on: ['B'] }),
  ]);
  // B 派过、未超时、还没结论 → RUNNING
  const rows = [expectRow('B', ['b.mjs'], 1, 30)];
  const plan = buildPlan({ graph: g, claimRows: rows, nowMs: NOW, probe: probeOf({}), root: '/r' });
  const byId = new Map(plan.subtrees.map((r) => [r.id, r]));
  assert.equal(byId.get('B').state, 'RUNNING');
  assert.equal(byId.get('A').state, 'WAITING_ON');
  assert.notEqual(byId.get('A').state, 'PENDING');
  // 不用人处理：这是本组的核心断言。它一旦进 needs_attention，「下一步：先处理 A」
  // 就会把一个只是在等的子树报成待办，人于是去派一件派不出去的事。
  assert.ok(!plan.needs_attention.includes('A'), `WAITING_ON 不该进 ATTENTION：${plan.needs_attention}`);
  assert.equal(plan.ok, true, '全屏只有「在跑 + 等前置」时不该判「有事要处理」');
  // 等谁必须写出来，否则用户不知道在等哪一件
  assert.match(byId.get('A').note, /B/);
});

test('前置还没派 → 下游是 WAITING_ON（链条要一路传下去，不是只看一跳）', () => {
  const g = graph([
    sub({ id: 'C', goal: '第三环', outputs: ['c.mjs'] }),
    sub({ id: 'B', goal: '第二环', outputs: ['b.mjs'], depends_on: ['C'] }),
    sub({ id: 'A', goal: '第一环', outputs: ['a.mjs'], depends_on: ['B'] }),
  ]);
  const plan = buildPlan({ graph: g, claimRows: [], nowMs: NOW, probe: probeOf({}), root: '/r' });
  const byId = new Map(plan.subtrees.map((r) => [r.id, r]));
  assert.equal(byId.get('C').state, 'PENDING', '链条起点才是真正轮到你派的那一件');
  assert.equal(byId.get('B').state, 'WAITING_ON');
  assert.equal(byId.get('A').state, 'WAITING_ON', '两跳以外的下游也必须等');
  // 三件在屏幕上必须**看得到区别**：一条链全显示「待跑」等于没做这次拆分。
  const lines = formatPlan(plan);
  for (const id of ['A', 'B', 'C']) {
    const row = lines.find((l) => l.includes(id));
    assert.ok(row, `${id} 没出现在输出里`);
  }
  assert.match(byId.get('B').note, /C/);
  assert.match(byId.get('A').note, /B/);
  // 且摘要必须把「在等」与「待跑」分开数 —— 合成一个数就回到修改前的同形问题
  const summary = lines.find((l) => /进度/.test(l));
  assert.match(summary, /2 等前置/, summary);
  assert.match(summary, /1 待跑/, summary);
});

test('前置全 DONE → 下游仍是 PENDING（deps 齐了就该派，这条别被上面的分支吃掉）', () => {
  const g = graph([
    sub({ id: 'A', goal: '已完成', outputs: ['a.mjs'] }),
    sub({ id: 'B', goal: '接着做', outputs: ['b.mjs'], depends_on: ['A'] }),
  ]);
  const rows = [expectRow('A', ['a.mjs']), claimRow('A', 'a.mjs', 5, 10, 'h'), consumeRow('A', 4)];
  const plan = buildPlan({
    graph: g, claimRows: rows, nowMs: NOW, root: '/r',
    probe: probeOf({ 'a.mjs': { size: 10, sha256: 'h' } }),
  });
  const byId = new Map(plan.subtrees.map((r) => [r.id, r]));
  assert.equal(byId.get('A').state, 'DONE');
  assert.equal(byId.get('B').state, 'PENDING', '前置都交付了还不派，就是把「等」当成了结果');
  // `PENDING` 不进 ATTENTION —— 这是本文件既有的退出码契约（1 = 失败/卡住/超时），
  // 也是 doctor 依赖它的地方。它要靠摘要里的「N 待跑」被人看见，不靠 needs_attention。
  assert.ok(!plan.needs_attention.includes('B'));
  assert.match(formatPlan(plan).find((l) => /进度/.test(l)), /1 待跑/);
});

test('依赖成环 → 环上每一条都判 DEFECT，没有任何一条永远 WAITING_ON', () => {
  // 这是「为什么必须有环检测」的直接证据：若把环当成普通的「等前置」，
  // A 等 B、B 等 A 会双双落在 WAITING_ON —— 不在 ATTENTION 里，屏幕上看起来
  // 一切正常，而实际上两件事永远不会有人做。
  const g = graph([
    sub({ id: 'A', goal: '甲', outputs: ['a.mjs'], depends_on: ['B'] }),
    sub({ id: 'B', goal: '乙', outputs: ['b.mjs'], depends_on: ['A'] }),
  ]);
  const plan = buildPlan({ graph: g, claimRows: [], nowMs: NOW, probe: probeOf({}), root: '/r' });
  const byId = new Map(plan.subtrees.map((r) => [r.id, r]));
  for (const id of ['A', 'B']) {
    assert.equal(byId.get(id).state, 'DEFECT', `${id} 在环上却判成 ${byId.get(id).state}`);
    assert.notEqual(byId.get(id).state, 'WAITING_ON');
    assert.ok(plan.needs_attention.includes(id), `${id} 在环上却不进 ATTENTION`);
  }
  assert.ok(plan.notes.some((n) => /成环/.test(n)), `成环必须在 notes 里说出来：${plan.notes}`);
  // 有环的 summary 也要能跑通（不能因为 state 不在表里就 undefined）
  const lines = formatPlan(plan);
  assert.ok(lines.length <= MAX_LINES, lines.join('\n'));
});

// ── 组 8：记号消歧（同屏唯一 + 只允许已验证字形）──────────────────────

test('每个记号都在 VERIFIED_GLYPHS 里有据可查（新加的字形不许蒙混过关）', () => {
  const { g, rows, probe } = scenarioFive();
  const plan = buildPlan({ graph: g, claimRows: rows, nowMs: NOW, probe, root: '/r' });
  for (const r of plan.subtrees) {
    assert.ok(VERIFIED_GLYPHS[r.mark],
      `${r.id} 用了未验证的字形 ${JSON.stringify(r.mark)}（${r.state}）—— `
      + '新增字形必须同时验 cmap 覆盖 / 真终端非豆腐 / 列宽 1（tui-visual.md §3.1）');
  }
});

test('同屏一个记号只能表示一个状态（跨屏复用允许，同屏复用禁止）', () => {
  // 造一张「所有状态都出现」的图，把屏幕上见得到的记号全部收集起来。
  // 同屏复用会让「这一行到底是失败还是超时」无解，而记号是色盲/管道下唯一的信息通道。
  const g = graph([
    sub({ id: 'DONE1', outputs: ['d.mjs'] }),
    sub({ id: 'FAIL1', outputs: ['f.mjs'] }),
    sub({ id: 'STUCK1', outputs: ['s1.mjs', 's2.mjs'] }),
    sub({ id: 'DEFECT1', shape: 'artifact', outputs: [] }),
    sub({ id: 'OVERDUE1', outputs: ['o.mjs'], timeout_min: 1 }),
    sub({ id: 'RUN1', outputs: ['r.mjs'], timeout_min: 600 }),
    sub({ id: 'PEND1', outputs: ['p.mjs'] }),
    sub({ id: 'WAIT1', outputs: ['w.mjs'], depends_on: ['RUN1'] }),
    sub({ id: 'UP1', outputs: ['u.mjs'], depends_on: ['FAIL1'] }),
    sub({ id: 'UNCL1', outputs: ['x.mjs'] }),
  ]);
  const rows = [
    expectRow('DONE1', ['d.mjs']), claimRow('DONE1', 'd.mjs', 5, 10, 'h'), consumeRow('DONE1', 4),
    expectRow('FAIL1', ['f.mjs']), claimRow('FAIL1', 'f.mjs', 5, 10, 'wrong-hash'),
    expectRow('STUCK1', ['s1.mjs', 's2.mjs']), claimRow('STUCK1', 's1.mjs', 5, 10, 'hs1'),
    expectRow('OVERDUE1', ['o.mjs'], 5, 1),
    expectRow('RUN1', ['r.mjs'], 1, 600),
  ];
  const plan = buildPlan({
    graph: g, claimRows: rows, nowMs: NOW, root: '/r',
    probe: probeOf({
      'd.mjs': { size: 10, sha256: 'h' }, 's1.mjs': { size: 10, sha256: 'hs1' },
      'x.mjs': { size: 1, sha256: 'orphan' },
    }),
  });
  // 十种状态都必须真的出现，否则这条测试只覆盖了一部分（会假绿）
  const want = ['DONE', 'FAILED', 'STUCK', 'DEFECT', 'OVERDUE', 'RUNNING', 'PENDING',
    'WAITING_ON', 'UPSTREAM_FAILED', 'LANDED_UNCLAIMED'];
  const got = new Set(plan.subtrees.map((r) => r.state));
  for (const s of want) assert.ok(got.has(s), `场景没造出 ${s}，这条断言覆盖不到它：${[...got]}`);

  const markToStates = new Map();
  for (const r of plan.subtrees) {
    const set = markToStates.get(r.mark) || new Set();
    set.add(r.state);
    markToStates.set(r.mark, set);
  }
  const clashes = [...markToStates].filter(([, s]) => s.size > 1);
  assert.deepEqual(clashes, [],
    `同一屏里一个记号表示了多个状态：${JSON.stringify(clashes.map(([m, s]) => [m, [...s]]))}`);

  // 屏幕上真的看得见的那几行也要满足同一条 —— 只看 JSON 不够，
  // 因为 `formatPlan` 里另有字面量（`↳`、`…`），那些也必须与状态记号不撞。
  const lines = formatPlan(plan);
  for (const r of plan.subtrees) {
    const row = lines.find((l) => l.includes(r.id));
    assert.ok(row !== undefined, `${r.id} 没有出现在人读输出里`);
    assert.ok(row.includes(r.mark), `${r.id} 的那一行没有用它的记号 ${r.mark}：${row}`);
  }
});

test('已实测为豆腐块/宽度的字形不得回到记号表（负向：退化即红）', () => {
  // 这四个是**有据可查的坏选择**，不是审美偏好：
  //   ◐ U+25D0  conhost 豆腐块，四款等宽字体 cmap 全缺（tui-visual.md §6）
  //   ✗ U+2717  cmap 四款全缺（同上实测），且与列表页的 FAILED(×) 是两个字形
  //   ▲ U+25B2  已归 STALLED，同屏复用会与「卡住」混淆
  //   ⚠ U+26A0  EAW=Ambiguous，带 VS16 时变 2 列会抖列，且 cmap 四款全缺
  const banned = ['◐', '✗', '✕', '▲', '⚠'];
  for (const [mark, meta] of Object.entries(VERIFIED_GLYPHS)) {
    assert.ok(!banned.includes(mark), `记号 ${mark}（${meta.cp}）是被实测推翻过的字形`);
  }
  const { g, rows, probe } = scenarioFive();
  const plan = buildPlan({ graph: g, claimRows: rows, nowMs: NOW, probe, root: '/r' });
  for (const r of plan.subtrees) {
    assert.ok(!banned.includes(r.mark), `${r.id} 用回了被推翻的字形 ${r.mark}`);
  }
});

