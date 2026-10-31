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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  validateGraph, validateFile, CAPABILITIES, SHAPES,
  REQUIRED_FOR_COMPLEX, MIN_SUBTREES,
} from './validate-run.mjs';

const ac = (id = 'AC1') => ({ id, criterion: 'scan --json 输出含 state 字段', evidence: 'src/a.mjs:12', fail_if: '缺字段' });

const sub = (over = {}) => ({
  id: 'ST1', goal: '实现扫描', capability: 'executor', shape: 'artifact',
  token_budget_pct: 40, timeout_min: 8, parallel_with: [], depends_on: [],
  acceptance: [ac()], why_this_layer: '需要真实语料验证',
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
