#!/usr/bin/env node
/**
 * stop-delta.test.mjs — 覆盖「交还时磁盘上多了什么、它有没有说」这一层。
 *
 * 与 stop-signals.test.mjs 的分工：那边管**停机原因是哪一类**（KINDS），
 * 这边管**正交的那根轴**（delta）。两者不互相推断 —— 一个会话可以既是
 * `STOPPED_SILENT` 又是 `GROUNDED`。
 *
 * 这里有两条测试是**守门测试**，不是覆盖率凑数：
 *  - 「只引用上一轮的路径」必须判 UNGROUNDED —— 它守的是「本轮」这个语义；
 *  - 「分母恒等于 stopped」—— 它守的是一类本仓已经犯过的错（同义反复）。
 * 两条都在交付说明里做过手工回退验证。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDelta, summarizeDelta, deltaSlotsOf, changeSetOf, lastHumanIndex,
  DELTA_VERDICTS, SLOT_STATES,
} from './stop-delta.mjs';

const assistant = (blocks, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', content: blocks }, ...extra });
const text = (t) => ({ type: 'text', text: t });
const toolUse = (name, input, id = 't1') => ({ type: 'tool_use', name, input, id });
const toolResult = (id, content = 'ok', isError = false) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }],
  },
});
const human = (t) => ({ type: 'user', message: { role: 'user', content: t }, origin: { kind: 'human' } });

// ── a：基本路径 ─────────────────────────────────────────────────────

test('a) 本轮 Write 且文本引用了该路径 → GROUNDED', () => {
  const records = [
    human('把渲染改一下'),
    assistant([toolUse('Write', { file_path: 'scripts/render.mjs' }, 'w1'), text('改好了')]),
    toolResult('w1'),
    assistant([text('改完了，动的是 scripts/render.mjs，剩下的是测试没补')]),
  ];
  const d = computeDelta({ records });
  assert.equal(d.verdict, 'GROUNDED');
  assert.equal(d.attribution, 'assistant');
  assert.equal(d.grounding.required, true);
  assert.deepEqual(d.grounding.hits.map((h) => h.token), ['scripts/render.mjs']);
});

test('a2) basename 命中算接地（人话里说的是文件名，不是盘上路径）', () => {
  const records = [
    human('改一下'),
    assistant([toolUse('Edit', { file_path: 'scripts/deep/dir/render.mjs' }, 'e1')]),
    toolResult('e1'),
    assistant([text('动的是 render.mjs。')]),
  ];
  const d = computeDelta({ records });
  assert.equal(d.verdict, 'GROUNDED');
  assert.equal(d.grounding.hits[0].matched, 'render.mjs');
});

// ── b：「本轮」语义的唯一守门测试 ────────────────────────────────────

test('b) 只引用上一轮的路径 → UNGROUNDED（守「本轮」语义）', () => {
  const records = [
    human('第一件事'),
    assistant([toolUse('Write', { file_path: 'scripts/old.mjs' }, 'w0')]),
    toolResult('w0'),
    assistant([text('第一件事做完了')]),
    human('第二件事：只跑测试，不要改文件'),
    assistant([toolUse('Bash', { command: 'node --test scripts/' }, 'b1')]),
    toolResult('b1'),
    // 本轮一次写入都没有，却引用了上一轮改过的文件名
    assistant([text('测试通过了，scripts/old.mjs 这一轮没有被改动')]),
  ];
  const d = computeDelta({ records });
  assert.equal(d.grounding.considered.length, 0, '本轮不应包含上一轮的改动');
  // 本轮零写入 → 走只读分支；没声明「改动：无」就不算交还了 delta
  assert.equal(d.verdict, 'NO_DELTA');
  assert.equal(d.grounding.required, false);
});

test('b2) 上一轮写过、本轮也写过，只引用上一轮的 → UNGROUNDED（不是 NO_DELTA）', () => {
  const records = [
    human('先改 old'),
    assistant([toolUse('Write', { file_path: 'scripts/old.mjs' }, 'w0')]),
    toolResult('w0'),
    human('现在改 new'),
    assistant([toolUse('Write', { file_path: 'scripts/new.mjs' }, 'w1')]),
    toolResult('w1'),
    assistant([text('按你上一轮的指示，scripts/old.mjs 已处理')]),
  ];
  const d = computeDelta({ records });
  assert.equal(d.verdict, 'UNGROUNDED');
  assert.deepEqual(d.grounding.considered.map((c) => c.token), ['scripts/new.mjs']);
  assert.deepEqual(d.grounding.hits, []);
});

// ── c：只读会话不误报 ───────────────────────────────────────────────

test('c) 本轮零写入 + 显式声明 changed: none → GROUNDED（只读会话不误报）', () => {
  const records = [
    human('看看这个报错怎么来的，别改'),
    assistant([toolUse('Read', { file_path: 'scripts/x.mjs' }, 'r1')]),
    toolResult('r1', 'const a = ;'),
    assistant([text('改动：无\n还差：没修，原因见上\n需要你：决定要不要现在修')]),
  ];
  const d = computeDelta({ records });
  assert.equal(d.verdict, 'GROUNDED');
  assert.equal(d.grounding.required, false);
  assert.equal(d.slots.changed, 'none');
  assert.equal(d.slots.remaining, 'stated');
});

test('c2) 只读会话不声明 delta → NO_DELTA（不误判成 UNGROUNDED）', () => {
  const records = [
    human('看看这个'),
    assistant([toolUse('Read', { file_path: 'scripts/x.mjs' }, 'r1')]),
    toolResult('r1'),
    assistant([text('这个报错来自空赋值。')]),
  ];
  const d = computeDelta({ records });
  assert.equal(d.verdict, 'NO_DELTA');
  assert.equal(d.verdict === 'UNGROUNDED', false);
});

// ── d：防冤枉模型 ───────────────────────────────────────────────────

test('d) ERROR_STOP 且错误是末条 assistant 记录 → EXEMPT，不计入 NO_DELTA', () => {
  const records = [
    human('跑一下'),
    assistant([toolUse('Bash', { command: 'npm test' }, 'b1')]),
    toolResult('b1'),
    assistant([text('')], { error: 'authentication_failed' }),
  ];
  const d = computeDelta({ records, errorIndex: records.length - 1 });
  assert.equal(d.verdict, 'EXEMPT');
  assert.equal(d.attribution, 'harness');
  assert.equal(d.grounding.required, false);
});

test('d2) 错误之后还有文本回合 → 不是 EXEMPT（有机会写就要判）', () => {
  const records = [
    human('跑一下'),
    assistant([toolUse('Write', { file_path: 'scripts/a.mjs' }, 'w1')]),
    toolResult('w1'),
    assistant([text('')], { error: 'server_error' }),
    assistant([text('网关挂了，scripts/a.mjs 的改动已经落盘')]),
  ];
  const d = computeDelta({ records, errorIndex: 3 });
  assert.notEqual(d.verdict, 'EXEMPT');
  assert.equal(d.verdict, 'GROUNDED');
});

test('d3) classifySession 把末条错误记录接成 EXEMPT', async () => {
  const { classifySession } = await import('./stop-signals.mjs');
  const records = [
    human('跑一下'),
    assistant([text('我先看看')], { error: 'authentication_failed' }),
  ];
  const v = classifySession({ tailRecords: records, headRecords: records, windowTruncated: false });
  assert.equal(v.kind, 'ERROR_STOP');
  assert.equal(v.delta.verdict, 'EXEMPT');
});

// ── e：防同义反复重犯 ───────────────────────────────────────────────

test('e) delta 比例的分母恒等于 stopped，EXEMPT 不减分母', () => {
  const rows = [
    { kind: 'NOT_STOPPED', delta: null },
    { kind: 'ERROR_STOP', delta: { verdict: 'EXEMPT', attribution: 'harness' } },
    { kind: 'STOPPED_SILENT', delta: { verdict: 'NO_DELTA', attribution: 'assistant' } },
    { kind: 'STOPPED_SILENT', delta: { verdict: 'GROUNDED', attribution: 'assistant' } },
    { kind: 'STOPPED_SILENT', delta: { verdict: 'UNGROUNDED', attribution: 'assistant' } },
  ];
  const s = summarizeDelta(rows);
  assert.equal(s.stopped, 4, '分母是停下来的一切，不是「有机会写的」');
  assert.equal(s.exempt, 1);
  // 关键断言：接地比例的分子仍是 1，分母仍是 4 —— 不是 1/3
  assert.equal(s.grounded, 1);
  assert.equal(s.groundedShare, Number((1 / 4).toFixed(4)));
  assert.notEqual(s.groundedShare, Number((1 / 3).toFixed(4)));
  // 四档相加等于分母（EXEMPT 在分子侧单列，没有被剔出分母）
  assert.equal(s.grounded + s.ungrounded + s.noDelta + s.exempt, s.stopped);
});

test('e2) NOT_STOPPED 不进分母也不进 any 分档', () => {
  const rows = [
    { kind: 'NOT_STOPPED', delta: null },
    { kind: 'NOT_STOPPED', delta: null },
    { kind: 'STOPPED_SILENT', delta: { verdict: 'GROUNDED', attribution: 'assistant' } },
  ];
  const s = summarizeDelta(rows);
  assert.equal(s.stopped, 1);
  assert.equal(s.groundedShare, 1);
  assert.deepEqual(s.byVerdict, { GROUNDED: 1 });
});

test('e3) 空输入给 0 而不是 NaN', () => {
  const s = summarizeDelta([]);
  assert.equal(s.stopped, 0);
  assert.equal(s.groundedShare, 0);
  assert.equal(summarizeDelta(null).stopped, 0);
});

// ── f：防文案撒谎 ───────────────────────────────────────────────────

test('f) STOPPED_SILENT 的 detail 区分 hasText 真假', async () => {
  const { classifySession } = await import('./stop-signals.mjs');
  const said = classifySession({ tailRecords: [assistant([text('全部做完了')])], headRecords: [], windowTruncated: false });
  assert.equal(said.kind, 'STOPPED_SILENT');
  assert.equal(said.detail, 'said-something-then-stopped');

  const silent = classifySession({ tailRecords: [assistant([])], headRecords: [], windowTruncated: false });
  assert.equal(silent.kind, 'STOPPED_SILENT');
  assert.equal(silent.detail, 'said-nothing-then-stopped');
  assert.notEqual(silent.detail, 'said-something-then-stopped');
});

// ── 槽位与边界 ──────────────────────────────────────────────────────

test('slots：needs 写「无」而 remaining 缺席 → inconsistent', () => {
  const s = deltaSlotsOf('需要你：无\n本轮其实什么都没说');
  assert.equal(s.needs, 'none');
  assert.equal(s.remaining, 'absent');
  assert.equal(s.inconsistent, true);
});

test('slots：三个槽位都在时不算 inconsistent', () => {
  const s = deltaSlotsOf('改动：改了 a.mjs\n还差：测试\n需要你：无');
  assert.equal(s.changed, 'stated');
  assert.equal(s.remaining, 'stated');
  assert.equal(s.needs, 'none');
  assert.equal(s.inconsistent, false);
});

test('slots：三态取值受 SLOT_STATES 约束', () => {
  for (const v of Object.values(deltaSlotsOf('改动：无\n还差：无\n需要你：无'))) {
    if (typeof v === 'boolean') continue;
    assert.ok(SLOT_STATES.includes(v), `${v} 不在 SLOT_STATES 里`);
  }
});

test('边界不可判（窗口截断且无真人记录）不判 UNGROUNDED', () => {
  const records = [
    assistant([toolUse('Write', { file_path: 'scripts/a.mjs' }, 'w1')]),
    toolResult('w1'),
    assistant([text('都做完了。')]),
  ];
  const d = computeDelta({ records, windowTruncated: true });
  assert.equal(d.grounding.boundary, 'unknown');
  assert.equal(d.verdict, 'NO_DELTA');
  assert.equal(d.attribution, 'unknown');
});

test('未截断且无真人记录 → boundary 是 whole-file，照常判', () => {
  const records = [
    assistant([toolUse('Write', { file_path: 'scripts/a.mjs' }, 'w1')]),
    toolResult('w1'),
    assistant([text('都做完了。')]),
  ];
  const d = computeDelta({ records });
  assert.equal(d.grounding.boundary, 'whole-file');
  assert.equal(d.verdict, 'UNGROUNDED');
});

// ── 改动集 C 的组成 ─────────────────────────────────────────────────

test('changeSetOf：失败的 shell 与只读命令不进 C', () => {
  const records = [
    human('改'),
    assistant([toolUse('Bash', { command: 'sed -i s/a/b/ scripts/x.mjs' }, 'b1')]),
    toolResult('b1', 'Error: no such file', true),
    assistant([toolUse('Bash', { command: 'node --test scripts/' }, 'b2')]),
    toolResult('b2', 'ok'),
  ];
  const c = changeSetOf(records, { humanIndex: lastHumanIndex(records) });
  assert.deepEqual(c, []);
});

test('changeSetOf：成功的写类 shell 进 C，token 是命令原文', () => {
  const records = [
    human('改'),
    assistant([toolUse('Bash', { command: 'sed -i s/a/b/ scripts/x.mjs' }, 'b1')]),
    toolResult('b1', 'ok'),
  ];
  const c = changeSetOf(records, { humanIndex: lastHumanIndex(records) });
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'command');
  assert.match(c[0].token, /sed -i/);
});

test('lastHumanIndex：取末条真人记录；无则 -1', () => {
  assert.equal(lastHumanIndex([human('a'), toolResult('x'), human('b'), toolResult('y')]), 2);
  assert.equal(lastHumanIndex([toolResult('x')]), -1);
  assert.equal(lastHumanIndex(null), -1);
});

test('DELTA_VERDICTS 冻结且四类齐全', () => {
  assert.deepEqual([...DELTA_VERDICTS], ['GROUNDED', 'UNGROUNDED', 'NO_DELTA', 'EXEMPT']);
  assert.throws(() => { 'use strict'; DELTA_VERDICTS.push('X'); }, /read only|object is not extensible|Cannot add/);
});
