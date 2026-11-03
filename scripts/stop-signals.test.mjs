#!/usr/bin/env node
/**
 * stop-signals.test.mjs — 覆盖 stop-signals.mjs 的每条判据。
 *
 * 测试的重点不是「判得准」，而是**判得稳定**：这些判据的产物会被写进报告，
 * 报告里的数字要能被别人用同一份代码复算出来。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toolFingerprint, detectLoop, endsWithoutToolUse, errorOf, hasRecentError,
  contextPressure, originalGoalFrom, isHumanMessage, humanMessages,
  questionAnswered, lastTextIsQuestion, classifySession, summarize,
  parseRecords, KINDS, LOOP_REPEAT, LOOP_WINDOW,
} from './stop-signals.mjs';

// usage 和 content 一样挂在 message 里（真实日志结构）；error 挂在记录顶层。
const assistant = (blocks, extra = {}) => {
  const { usage, ...rest } = extra;
  return { type: 'assistant', message: { role: 'assistant', content: blocks, ...(usage ? { usage } : {}) }, ...rest };
};
const text = (t) => ({ type: 'text', text: t });
const toolUse = (name, input, id = 't1') => ({ type: 'tool_use', name, input, id });
const user = (content, origin) => ({ type: 'user', message: { role: 'user', content }, ...(origin ? { origin } : {}) });
const human = (t) => user(t, { kind: 'human' });

// ── 指纹与死循环 ──────────────────────────────────────────────────

test('toolFingerprint 对参数键顺序不敏感', () => {
  assert.equal(toolFingerprint('Read', { a: 1, b: 2 }), toolFingerprint('Read', { b: 2, a: 1 }));
});

test('toolFingerprint 对不同工具同名参数给出不同指纹', () => {
  assert.notEqual(toolFingerprint('Read', { p: 1 }), toolFingerprint('Write', { p: 1 }));
});

test('detectLoop：同一次调用重复 repeat 次即命中', () => {
  const recs = [];
  for (let i = 0; i < LOOP_REPEAT; i++) recs.push(assistant([toolUse('Bash', { command: 'npm test' }, `id${i}`)]));
  const r = detectLoop(recs);
  assert.equal(r.hit, true);
  assert.equal(r.value.name, 'Bash');
  assert.equal(r.value.repeats, LOOP_REPEAT);
});

test('detectLoop：参数不同即不命中（这是判据的全部精度所在）', () => {
  const recs = [
    assistant([toolUse('Bash', { command: 'npm test' })]),
    assistant([toolUse('Bash', { command: 'npm run lint' })]),
    assistant([toolUse('Bash', { command: 'npm build' })]),
  ];
  assert.equal(detectLoop(recs).hit, false);
});

test('detectLoop：只在窗口内计数，早于窗口的重复不算', () => {
  const recs = [];
  for (let i = 0; i < LOOP_REPEAT; i++) recs.push(assistant([toolUse('Read', { f: 1 }, `a${i}`)]));
  for (let i = 0; i < LOOP_WINDOW; i++) recs.push(assistant([toolUse('Grep', { q: i }, `b${i}`)]));
  assert.equal(detectLoop(recs).hit, false);
});

// ── 真的停下来了 ──────────────────────────────────────────────────

test('endsWithoutToolUse：末尾有 tool_use 视为还在干活', () => {
  const r = endsWithoutToolUse([assistant([text('我先看看'), toolUse('Bash', {})])]);
  assert.equal(r.hit, false);
  assert.equal(r.evidence, 'pending-tool-use');
});

test('endsWithoutToolUse：只有文字、没有 tool_use 视为停下', () => {
  const r = endsWithoutToolUse([assistant([text('做完了')])]);
  assert.equal(r.hit, true);
  assert.equal(r.value.hasText, true);
});

test('endsWithoutToolUse：没有 assistant 记录时不抛异常', () => {
  assert.equal(endsWithoutToolUse([]).hit, false);
  assert.equal(endsWithoutToolUse(null).hit, false);
});

// ── 错误 ──────────────────────────────────────────────────────────

test('errorOf：识别字符串错误（authentication_failed）', () => {
  const rec = { type: 'assistant', error: 'authentication_failed', timestamp: 'x' };
  assert.equal(errorOf(rec).text, 'authentication_failed');
});

test('errorOf：识别对象错误（网关 5xx）', () => {
  const rec = { type: 'assistant', error: { message: '524 upstream' } };
  assert.match(errorOf(rec).text, /524/);
});

test('errorOf：普通记录返回 null', () => {
  assert.equal(errorOf({ type: 'assistant', message: {} }), null);
  assert.equal(errorOf({ type: 'user' }), null);
  assert.equal(errorOf(null), null);
});

test('hasRecentError：只认字段，不认正文里的「错误」二字', () => {
  const recs = [assistant([text('这里有一个错误需要说明')])];
  assert.equal(hasRecentError(recs).hit, false);
  assert.equal(hasRecentError([{ type: 'assistant', error: 'server_error' }]).hit, true);
});

test('hasRecentError：错误在窗口之外不算', () => {
  const recs = [{ type: 'assistant', error: 'boom' }];
  for (let i = 0; i < 25; i++) recs.push(assistant([text('ok')]));
  assert.equal(hasRecentError(recs, 20).hit, false);
});

// ── 上下文 ────────────────────────────────────────────────────────

test('contextPressure：没有 compact 边界时只报水位，不判「接近」', () => {
  const recs = [assistant([text('x')], { usage: { input_tokens: 500000 } })];
  const r = contextPressure(recs);
  assert.equal(r.hit, false);
  assert.equal(r.value.watermark, 500000);
  assert.equal(r.value.ratio, null);
});

test('contextPressure：有边界时算比例，超过阈值才命中', () => {
  const recs = [
    assistant([text('x')], { usage: { input_tokens: 900, cache_read_input_tokens: 100 } }),
    { type: 'system', compactMetadata: { preTokens: 1000 } },
  ];
  const r = contextPressure(recs);
  assert.equal(r.value.ratio, 1);
  assert.equal(r.hit, true);
});

// ── 真人消息与原始目标 ────────────────────────────────────────────

test('isHumanMessage：只认 origin.kind === human', () => {
  assert.equal(isHumanMessage(human('你好')), true);
  // tool_result 也是 user 记录，不能算真人
  assert.equal(isHumanMessage(user([{ type: 'tool_result', tool_use_id: 'x' }])), false);
  assert.equal(isHumanMessage(user('注入文本', { kind: 'task-notification' })), false);
});

test('originalGoalFrom：取第一条真人消息', () => {
  const recs = [user('系统注入'), human('把测试跑绿'), human('再顺便修 lint')];
  const r = originalGoalFrom(recs);
  assert.equal(r.hit, true);
  assert.equal(r.value.text, '把测试跑绿');
});

test('originalGoalFrom：没有真人消息时 hit=false', () => {
  assert.equal(originalGoalFrom([user('x')]).hit, false);
});

test('originalGoalFrom：头部无真人消息时退回 queue-operation', () => {
  const recs = [
    { type: 'file-history-snapshot', snapshot: {} },
    { type: 'queue-operation', operation: 'enqueue', content: '整理所有信息提交到 GitHub' },
  ];
  const r = originalGoalFrom(recs);
  assert.equal(r.hit, true);
  assert.equal(r.value.source, 'queue-operation');
});

test('originalGoalFrom：不退回到 task-notification（系统通知不是目标）', () => {
  const recs = [{ type: 'queue-operation', operation: 'enqueue', content: '<task-notification><task-id>x</task-id>' }];
  assert.equal(originalGoalFrom(recs).hit, false);
});

test('humanMessages：数组型 content 只取 text 块', () => {
  const recs = [user([text('第一段'), { type: 'image', source: {} }, text('第二段')], { kind: 'human' })];
  assert.equal(humanMessages(recs)[0].text, '第一段\n第二段');
});

// ── 结构化提问 ────────────────────────────────────────────────────

test('questionAnswered：AskUserQuestion 无 tool_result = 待回答', () => {
  const recs = [assistant([toolUse('AskUserQuestion', { q: '?' }, 'ask1')])];
  const r = questionAnswered(recs);
  assert.equal(r.hit, true);
  assert.equal(r.value.name, 'AskUserQuestion');
});

test('questionAnswered：按 tool_use_id 配对，不靠文本', () => {
  const recs = [
    assistant([toolUse('AskUserQuestion', { q: '?' }, 'ask1')]),
    user([{ type: 'tool_result', tool_use_id: 'ask1', content: 'The user answered: "q"="a"' }]),
  ];
  assert.equal(questionAnswered(recs).hit, false);
});

// ── 文本问句（已知低精度）─────────────────────────────────────────

test('lastTextIsQuestion：问号结尾命中', () => {
  assert.equal(lastTextIsQuestion([assistant([text('要继续吗？')])]).hit, true);
});

test('lastTextIsQuestion：实测里「在等你」最常见的不带问号形态不命中', () => {
  // 这是真实语料原句（D--Projects-dsh-fcl-android-launcher）
  const s = '等哪一轮你验过点头，那一轮的包摘掉后缀就是正式 0.1.6。我等你反馈开 fix2。';
  assert.equal(lastTextIsQuestion([assistant([text(s)])]).hit, false);
});

// ── 综合 ──────────────────────────────────────────────────────────

test('classifySession：还在干活优先于一切', () => {
  const v = classifySession({ tailRecords: [assistant([toolUse('Bash', {})])], headRecords: [] });
  assert.equal(v.kind, 'NOT_STOPPED');
});

test('classifySession：错误停机优先于问句', () => {
  const v = classifySession({
    tailRecords: [assistant([text('要重试吗？')], { error: 'server_error' })],
    headRecords: [],
  });
  assert.equal(v.kind, 'ERROR_STOP');
});

test('classifySession：结构化提问优先于「还在干活」', () => {
  // AskUserQuestion 的暂停点带着未执行的 tool_use，若按「有 tool_use 就在干活」
  // 先判，真正在等人回答的会话会被全部算成在干活。
  const v = classifySession({
    tailRecords: [assistant([text('你选哪个？'), toolUse('AskUserQuestion', {}, 'a1')])],
    headRecords: [],
  });
  assert.equal(v.kind, 'WAITING_ANSWER');
});

test('classifySession：什么都没问即 STOPPED_SILENT，且标 measured', () => {
  const v = classifySession({ tailRecords: [assistant([text('全部测试通过，代码已提交。')])], headRecords: [] });
  assert.equal(v.kind, 'STOPPED_SILENT');
  assert.equal(v.confidence, 'measured');
});

test('classifySession：原始目标可取时 goalOk=true', () => {
  const v = classifySession({
    tailRecords: [assistant([text('完事了')])],
    headRecords: [human('把 CI 跑绿')],
  });
  assert.equal(v.goalOk, true);
});

test('classifySession：死循环看前文，不只看本轮', () => {
  const history = [];
  for (let i = 0; i < LOOP_REPEAT; i++) history.push(assistant([toolUse('Bash', { command: 'same' }, `x${i}`)]));
  const tail = [assistant([text('似乎卡住了')])];
  const v = classifySession({ tailRecords: tail, historyRecords: history, headRecords: [] });
  assert.equal(v.kind, 'LOOP_SUSPECT');
});

test('classifySession：输入为空不抛异常', () => {
  const v = classifySession({});
  assert.equal(typeof v.kind, 'string');
  assert.ok(KINDS.includes(v.kind));
});

// ── 汇总与解析 ────────────────────────────────────────────────────

test('summarize：结构性占比的分母是停下来的会话', () => {
  const rows = [
    { kind: 'NOT_STOPPED', goalOk: true },
    { kind: 'ERROR_STOP', goalOk: true },
    { kind: 'STOPPED_SILENT', goalOk: false },
    { kind: 'QUESTION_TEXT', goalOk: false },
  ];
  const s = summarize(rows);
  assert.equal(s.total, 4);
  assert.equal(s.stopped, 3);
  assert.equal(s.notStopped, 1);
  assert.equal(s.deterministicCause, 1);
  assert.equal(s.structuralShare, Number((1 / 3).toFixed(4)));
  assert.equal(s.goalRecoverable, 2);
});

test('parseRecords：坏行被丢弃，不影响其余记录', () => {
  const recs = parseRecords('{"type":"a"}\nnot json\n{"type":"b"}\n');
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map((r) => r.type), ['a', 'b']);
});
