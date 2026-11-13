#!/usr/bin/env node
/**
 * validate-run.test.mjs — 派发契约的回归测试。
 *
 * 这些测试守的是 CLAUDE.md 的硬约束，不是格式洁癖：
 *   2. 复杂任务至少 5 个独立 Agent，含锐评 / 验收 / 修复
 *   4. 验收标准必须预先声明
 *   6. 每层须写明「为什么需要这一层」
 *   8. 必须声明产出形态与预算
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

import {
  validateGraph, validateFile, CAPABILITIES, SHAPES,
  REQUIRED_FOR_COMPLEX, MIN_SUBTREES, SHAPES_REQUIRING_OUTPUTS,
  outputPathError, outputPathKey,
} from './validate-run.mjs';

const ac = (id = 'AC1') => ({ id, criterion: 'scan --json 输出含 state 字段', evidence: 'src/a.mjs:12', fail_if: '缺字段' });

const sub = (over = {}) => ({
  id: 'ST1', goal: '实现扫描', capability: 'executor', shape: 'artifact',
  token_budget_pct: 40, timeout_min: 8, parallel_with: [], depends_on: [],
  acceptance: [ac()], outputs: ['scripts/scan-sessions.mjs'], why_this_layer: '需要真实语料验证',
  ...over,
});

const graph = (subs, over = {}) => ({
  run_id: 'r1', root_goal: '目标', constraints: [], subtrees: subs, ...over,
});

test('合法的单任务图通过', () => {
  const r = validateGraph(graph([sub()]));
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('缺 token_budget_pct / parallel_with / depends_on 直接报错（真实 run 就漏了这些）', () => {
  const s = sub();
  delete s.token_budget_pct;
  delete s.parallel_with;
  delete s.depends_on;
  const r = validateGraph(graph([s]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('token_budget_pct')));
  assert.ok(r.errors.some((e) => e.includes('parallel_with')));
  assert.ok(r.errors.some((e) => e.includes('depends_on')));
});

test('capability / shape 必须是枚举内的值', () => {
  assert.equal(validateGraph(graph([sub({ capability: '写代码的' })])).ok, false);
  assert.equal(validateGraph(graph([sub({ shape: '随便' })])).ok, false);
  for (const c of CAPABILITIES) {
    const r = validateGraph(graph([sub({ capability: c })]));
    assert.equal(r.ok, true, `${c} 应合法：${r.errors.join(',')}`);
  }
  for (const s of SHAPES) {
    const r = validateGraph(graph([sub({ shape: s })]));
    assert.equal(r.ok, true, `${s} 应合法：${r.errors.join(',')}`);
  }
});

test('验收标准不能为空——CLAUDE.md 硬约束 4', () => {
  const r = validateGraph(graph([sub({ acceptance: [] })]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('acceptance')));
});

test('不可判定的验收标准被拒——「不可判定的条目等于没有」', () => {
  for (const vague of ['可选', '视情况而定', '尽量做好', '适当优化']) {
    const s = sub({ acceptance: [{ id: 'AC1', criterion: vague, evidence: 'a.mjs:1', fail_if: 'x' }] });
    const r = validateGraph(graph([s]));
    assert.equal(r.ok, false, `"${vague}" 应被拒`);
  }
});

test('why_this_layer 必须写——CLAUDE.md 硬约束 6', () => {
  const s = sub();
  delete s.why_this_layer;
  const r = validateGraph(graph([s]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('why_this_layer')));
});

test('复杂任务（显式声明 requireComplex）必须含 review / acceptor / repair', () => {
  const subs = ['executor', 'research', 'critic', 'executor', 'executor']
    .map((cap, i) => sub({ id: `ST${i}`, capability: cap }));
  assert.equal(subs.length, MIN_SUBTREES);
  const r = validateGraph(graph(subs), { requireComplex: true });
  assert.equal(r.ok, false, '缺三个必需角色时应报错');
  for (const need of REQUIRED_FOR_COMPLEX) {
    assert.ok(r.errors.some((e) => e.includes(need)), `应指出缺 ${need}`);
  }
});

test('复杂任务补齐必需角色后通过', () => {
  const subs = ['executor', 'research', 'critic', 'review', 'acceptor', 'repair']
    .map((cap, i) => sub({ id: `ST${i}`, capability: cap }));
  const r = validateGraph(graph(subs));
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('重复 id 与悬空引用被拒', () => {
  assert.equal(validateGraph(graph([sub({ id: 'A' }), sub({ id: 'A' })])).ok, false);
  const r = validateGraph(graph([sub({ depends_on: ['GHOST'] })]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('GHOST')));
});

test('引用自己也被拒', () => {
  const r = validateGraph(graph([sub({ id: 'A', depends_on: ['A'] })]));
  assert.equal(r.ok, false);
});

test('validateFile：坏 JSON 与不存在的文件都返回错误而不是抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-vr-'));
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    assert.equal(validateFile(bad).ok, false);
    assert.equal(validateFile(join(dir, 'nope.json')).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validateFile：合法文件通过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-vr-'));
  try {
    const p = join(dir, 'task-graph.json');
    writeFileSync(p, JSON.stringify(graph([sub()])), 'utf8');
    const r = validateFile(p);
    assert.equal(r.ok, true, r.errors.join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── outputs：收活时对账的期望来源（设计 §7.1）─────────────────────────
//
// 这一组守的不是格式。`outputs` 是 `claim-ledger verify` 判 COMPLETE/PARTIAL/EMPTY
// 的唯一期望来源。它少一条，那个文件就永远不会被对账——**agent 产出了但主线程
// 没意识到**这件事就发生在那里。所以每条非法形态都要能挡住。

test('outputs 是必填：缺失直接报错（选填就等于允许不声明期望）', () => {
  const s = sub();
  delete s.outputs;
  const r = validateGraph(graph([s]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('outputs')), r.errors.join('\n'));
});

test('outputs 必须是非空数组以外的合法数组形态', () => {
  for (const bad of ['scripts/a.mjs', { a: 1 }, 42, null]) {
    const r = validateGraph(graph([sub({ outputs: bad })]));
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应被拒`);
    assert.ok(r.errors.some((e) => e.includes('outputs')), r.errors.join('\n'));
  }
});

test('outputs 元素必须是相对路径：绝对路径、盘符、UNC、正斜杠根都被拒', () => {
  const bads = [
    'C:\\repo\\a.md',
    'C:/repo/a.md',
    'D:\\Projects\\Overwatch\\scripts\\a.mjs',
    '/etc/passwd',
    '\\\\server\\share\\a.md',
    // Windows 的「驱动器相对」形态：不以分隔符开头，但仍然是绝对路径
    'C:a.md',
  ];
  for (const b of bads) {
    assert.ok(outputPathError(b), `${b} 应判为绝对路径`);
    const r = validateGraph(graph([sub({ outputs: [b] })]));
    assert.equal(r.ok, false, `${b} 应被拒`);
    assert.ok(r.errors.some((e) => e.includes('outputs')), `${b}: ${r.errors.join('\n')}`);
  }
});

test('outputs 不能含 ..（会指到任务范围之外）', () => {
  for (const b of ['../a.md', 'docs/../../a.md', 'docs\\..\\..\\a.md', 'a/..']) {
    assert.ok(outputPathError(b), `${b} 应被拒`);
    assert.equal(validateGraph(graph([sub({ outputs: [b] })])).ok, false, b);
  }
});

test('outputs 不接受空串、纯空白、尾部分隔符（都是「看着有其实没指对文件」）', () => {
  for (const b of ['', '   ', 'docs/', 'docs\\']) {
    assert.ok(outputPathError(b), `${JSON.stringify(b)} 应被拒`);
    assert.equal(validateGraph(graph([sub({ outputs: [b] })])).ok, false, b);
  }
});

test('合法的相对路径：正斜杠、反斜杠、点开头的隐藏文件、文件名里含点', () => {
  const goods = [
    'scripts/scan-sessions.mjs',
    'scripts\\scan-sessions.mjs',
    'docs/.gitkeep',
    'docs/v0.2.0-notes.md',
    'a/b/c/d.md',
  ];
  for (const g of goods) {
    assert.equal(outputPathError(g), null, `${g} 应合法：${outputPathError(g)}`);
    const r = validateGraph(graph([sub({ outputs: [g] })]));
    assert.equal(r.ok, true, `${g}: ${r.errors.join('\n')}`);
  }
});

test('shape 为 artifact 时 outputs 不得为空（否则必填被空数组绕过）', () => {
  assert.ok(SHAPES_REQUIRING_OUTPUTS.includes('artifact'));
  const r = validateGraph(graph([sub({ shape: 'artifact', outputs: [] })]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('outputs')), r.errors.join('\n'));
});

test('shape 为 exploration 时 outputs 允许为空（它按定义不承诺文件）', () => {
  const r = validateGraph(graph([sub({ shape: 'exploration', outputs: [] })]));
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('artifact + exploration 之外的 hybrid 也允许空 outputs', () => {
  const r = validateGraph(graph([sub({ shape: 'hybrid', outputs: [] })]));
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('两个子树声明同一个文件 → 提示（不判 error：真正判定留给 claim-ledger 的 CONFLICT）', () => {
  const subs = [
    sub({ id: 'ST1', outputs: ['docs/shared.md'] }),
    sub({ id: 'ST2', outputs: ['docs\\shared.md'] }), // 反斜杠是同一个文件
  ];
  const r = validateGraph(graph(subs));
  assert.equal(r.ok, true, '静态图层面的重复只是规划嫌疑，不阻塞');
  assert.ok(r.warnings.some((w) => w.includes('outputs') && w.includes('同一个文件')), r.warnings.join('\n'));
});

test('outputPathKey 把正反斜杠与大小写归一成同一个键（Windows 大小写不敏感）', () => {
  assert.equal(outputPathKey('docs/A.md'), outputPathKey('docs\\a.md'));
  assert.notEqual(outputPathKey('docs/a.md'), outputPathKey('scripts/a.md'));
});

test('负向：把 outputs 校验摘掉（checkOutputs 的结果被丢弃），非法输入必须变合格', async () => {
  // 真实的回退验证：把 validateGraph 里「取 checkOutputs 结果」这一步换成空结果，
  // 写进临时模块再跑。这正是「把校验注释掉」的最小形态。
  // 「改坏了测试必须红」这句话只有真的做一次回退才算数——否则这条测试证明的
  // 只是「现在恰好通过」，而不是「它在守着这段代码」。
  const src = readFileSync(join(import.meta.dirname, 'validate-run.mjs'), 'utf8');
  const find = 'const ores = checkOutputs(st);';
  assert.equal(src.split(find).length - 1, 1, '源码片段应当唯一');
  const mutated = src.replace(find, 'const ores = { errors: [], warnings: [], okPaths: [] }; // 回退：校验被摘掉');
  assert.doesNotMatch(mutated, /const ores = checkOutputs\(st\)/);

  const dir = mkdtempSync(join(tmpdir(), 'ow-vr-neg-'));
  try {
    const target = join(dir, 'validate-run-mutated.mjs');
    writeFileSync(target, mutated, 'utf8');
    const mod = await import(pathToFileURL(target).href);

    const noOut = graph([sub()]);
    delete noOut.subtrees[0].outputs;
    assert.equal(mod.validateGraph(graph([sub({ outputs: ['../a.md'] })])).ok, true,
      '校验摘掉后，含 .. 的路径必须能通过——说明「非法路径」那条测试守的是这段代码');
    assert.equal(mod.validateGraph(noOut).ok, true,
      '校验摘掉后，缺失 outputs 必须能通过——说明「必填」是这段代码给的');
    assert.equal(mod.validateGraph(graph([sub({ shape: 'artifact', outputs: [] })])).ok, true,
      '校验摘掉后，artifact + 空数组必须能通过——说明「artifact 非空」是这段代码给的');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
