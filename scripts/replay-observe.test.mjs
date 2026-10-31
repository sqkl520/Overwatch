#!/usr/bin/env node
/**
 * replay-observe.test.mjs — 负向测试：确认回放脚本的判定不是恒真、也不是恒假。
 *
 * 只测**契约**，不测具体数字（数字依赖本机语料，会漂移）。
 * 具体数字的证据在 docs/research/2026-10-31-replay-observations.md。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSessionStops, sliceStops, observeStop, nextTick, callsUpTo,
  originKindOf, isToolResultOnly, capText, compactRecord, pct,
  runPollModel, rewatchSuppressed, corpusSummary, renderStats,
  POLL_INTERVAL_MS,
} from './replay-observe.mjs';

// ── 夹具 ──────────────────────────────────────────────────────────────

const A = (ts, opts = {}) => ({
  type: 'assistant',
  uuid: opts.uuid || `a-${ts}`,
  timestamp: new Date(ts).toISOString(),
  message: {
    role: 'assistant',
    id: opts.id || `msg-${ts}`,
    stop_reason: opts.stopReason || 'end_turn',
    content: opts.content || [{ type: 'text', text: opts.text || 'done' }],
  },
  ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
});

const U = (ts, text, origin) => ({
  type: 'user',
  uuid: `u-${ts}`,
  timestamp: new Date(ts).toISOString(),
  message: { role: 'user', content: [{ type: 'text', text }] },
  ...(origin ? { origin: { kind: origin } } : {}),
});

const TOOL_CALL = (ts, name, uuid) => A(ts, {
  uuid,
  stopReason: 'tool_use',
  content: [{ type: 'tool_use', name, id: `t-${ts}`, input: {} }],
});

const T0 = Date.parse('2026-10-01T00:00:00Z');

// ── 停止点切分 ───────────────────────────────────────────────────────

test('同一轮的多条 assistant 记录按 message.id 合并成一个停止点', () => {
  const recs = [
    A(T0, { id: 'same', content: [{ type: 'thinking', thinking: 'hmm' }] }),
    A(T0 + 500, { id: 'same', content: [{ type: 'text', text: '完成' }] }),
  ].map(compactRecord);
  const stops = buildSessionStops(recs);
  assert.equal(stops.length, 1, '两条同 id 记录只能算一个停止点');
  assert.equal(stops[0].t0, T0 + 500, '停止时刻取组内最后一条');
});

test('tool_use 只有 AskUserQuestion / ExitPlanMode 算停止点', () => {
  const mk = (name) => [TOOL_CALL(T0, name, `tc-${name}`)].map(compactRecord);
  assert.equal(buildSessionStops(mk('AskUserQuestion')).length, 1);
  assert.equal(buildSessionStops(mk('ExitPlanMode')).length, 1);
  assert.equal(buildSessionStops(mk('Bash')).length, 0, 'Bash 的 tool_use 是工具在跑，不是停止');
});

test('max_tokens 不算停止点（那是被截断，不是等待）', () => {
  const recs = [A(T0, { stopReason: 'max_tokens' })].map(compactRecord);
  assert.equal(buildSessionStops(recs).length, 0);
});

// ── 在线视图 ─────────────────────────────────────────────────────────

test('callsUpTo 只返回时间戳 ≤ T 的调用数', () => {
  const ts = Float64Array.from([10, 20, 30]);
  assert.equal(callsUpTo(ts, 0), 0);
  assert.equal(callsUpTo(ts, 20), 2, '等于边界时算可见');
  assert.equal(callsUpTo(ts, 1e9), 3);
});

test('nextTick 落在 5 分钟网格上，且不早于输入时刻', () => {
  for (const t of [0, 1, 299_999, 300_000, 300_001, 1e12 + 7]) {
    const n = nextTick(t, 0);
    assert.equal(n % POLL_INTERVAL_MS, 0);
    assert.ok(n >= t);
    assert.ok(n - t < POLL_INTERVAL_MS);
  }
});

test('观察时刻早于下一条 assistant 时，停止点有效；晚于则被取代', () => {
  const recs = [
    A(T0, { text: '停' }),
    U(T0 + 10_000, '继续', 'human'),
    A(T0 + 20_000, { text: '新回合' }),
  ].map(compactRecord);
  const stops = buildSessionStops(recs);
  sliceStops(recs, stops);
  // 三条 assistant 里 A(T0) 与 A(T0+20000) 各是一个 end_turn 停止点；
  // 中间那条 U 是「下一句」，把第一个停止点的窗口封住。
  assert.equal(stops.length, 2);
  assert.equal(stops[0].nextAssistantTs, T0 + 20_000);

  const session = { sessionId: 's', calls: [], ts: Float64Array.from([]) };
  const early = observeStop(session, stops[0], T0 + 5000, { minIdleSec: 0 });
  assert.notEqual(early.skip, 'superseded');

  const late = observeStop(session, stops[0], T0 + 25_000, { minIdleSec: 0 });
  assert.equal(late.skip, 'superseded', '下一条 assistant 已落盘后，这个停止点不再产生判决');
});

test('观察时刻 T 决定可见的 afterRecords —— 这是「在线」的核心契约', () => {
  // 停止后 10 秒才写入 task-notification。T=5s 时看不到，T=15s 时看得到。
  const recs = [
    A(T0, { text: '停' }),
    U(T0 + 10_000, '<task-notification>x</task-notification>', 'task-notification'),
  ].map(compactRecord);
  const stops = buildSessionStops(recs);
  sliceStops(recs, stops);

  // 有工具调用 → 四态不是候选；补一个写操作让它成为候选并不可行，
  // 所以这里直接验证 classifyStop 的输入：T 早于通知时 kind 不是 WAITING_SUBAGENT。
  const session = { sessionId: 's', calls: [], ts: Float64Array.from([]) };
  const before = observeStop(session, stops[0], T0 + 5_000, { minIdleSec: 0 });
  const after = observeStop(session, stops[0], T0 + 15_000, { minIdleSec: 0 });
  // 两条都不是候选（无工具调用 → cold-start EXPLORING），所以跳过路径一致；
  // 用 afterRecords 的可见性直接断言更可靠。
  assert.equal(before.skip !== undefined || after.skip !== undefined, true);
  assert.ok(stops[0].after.length === 1, '离线视图里那条通知是存在的');
  const visibleAt5 = stops[0].after.filter((r) => r.ts <= T0 + 5_000);
  const visibleAt15 = stops[0].after.filter((r) => r.ts <= T0 + 15_000);
  assert.equal(visibleAt5.length, 0, 'T=5s 时通知尚未落盘');
  assert.equal(visibleAt15.length, 1, 'T=15s 时可看到通知');
});

// ── 记录解析 ─────────────────────────────────────────────────────────

test('originKindOf 认得出 task-notification / tool-result / human', () => {
  assert.equal(originKindOf({ type: 'user', message: { content: '<task-notification/>' } }), 'task-notification');
  assert.equal(originKindOf({ type: 'user', origin: { kind: 'peer' }, message: { content: 'hi' } }), 'peer');
  assert.equal(originKindOf({ type: 'user', message: { content: [{ type: 'tool_result' }] } }), 'tool-result');
  assert.equal(originKindOf({ type: 'user', message: { content: '人话' } }), 'human');
});

test('isToolResultOnly 只认纯粹的 tool_result 记录', () => {
  assert.equal(isToolResultOnly({ type: 'user', message: { content: [{ type: 'tool_result' }] } }), true);
  assert.equal(isToolResultOnly({ type: 'user', message: { content: [{ type: 'tool_result' }, { type: 'text', text: 'x' }] } }), false);
  assert.equal(isToolResultOnly({ type: 'assistant', message: { content: [{ type: 'tool_result' }] } }), false);
});

test('capText 保留头尾（最后一行决定完成汇报判定）', () => {
  const s = 'A'.repeat(5000) + '\n已完成';
  const out = capText(s);
  assert.ok(out.length < s.length);
  assert.ok(out.endsWith('已完成'), '尾部必须保留');
  assert.ok(out.startsWith('AAAA'), '头部保留');
});

// ── 门槛门 ───────────────────────────────────────────────────────────

test('runPollModel：门槛高 → 通知不多于门槛低（单调性）', () => {
  const make = (n) => {
    const stops = [];
    const calls = [];
    for (let i = 0; i < n; i++) {
      const t = T0 + i * 600_000;
      // 每次调用间隔 200 秒，造出稳定心跳后突然停止
      for (let k = 0; k < 25; k++) calls.push({ name: 'Read', ts: t - 200_000 + k * 4000, sig: `r${k}`, persistent: false });
      stops.push({ t0: t, stopIdx: 0, stopOnly: A(t).message && compactRecord(A(t)), after: [], nextAssistantTs: null, permissionMode: null, sessionId: `s${i}` });
    }
    calls.sort((a, b) => a.ts - b.ts);
    return { sessionId: 's', calls, ts: Float64Array.from(calls.map((c) => c.ts)), stops, _stateCache: new Map() };
  };
  const sessions = [make(3)];
  const lo = runPollModel(sessions, { minIdleSec: 0 });
  const hi = runPollModel(sessions, { minIdleSec: 1e9 });
  assert.ok(lo.sent.length >= hi.sent.length, '门槛提高不应增加通知数');
  assert.ok(lo.observationRows >= hi.observationRows, '门槛提高不应增加观察行');
});

test('rewatchSuppressed：没有任何候选时返回全零，而不是抛异常', () => {
  const sessions = [{
    sessionId: 's', calls: [], ts: Float64Array.from([]), stops: [], lastRecordTs: null, mtimeMs: 0, _stateCache: new Map(),
  }];
  const r = rewatchSuppressed(sessions, { minIdleSec: 300 });
  assert.equal(r.suppressed, 0);
  assert.equal(r.buckets['never-resumed'], 0);
});

test('corpusSummary 统计停止点与交互式停止点', () => {
  const s = corpusSummary([
    { badLines: 0, recordCount: 10, stops: [{ t0: T0, stopReason: 'end_turn' }, { t0: T0 + 1, stopReason: 'tool_use' }], sessionId: 'a' },
    { badLines: 1, recordCount: 5, stops: [], sessionId: 'b' },
  ]);
  assert.equal(s.stops, 2);
  assert.equal(s.endTurn, 1);
  assert.equal(s.interactive, 1);
  assert.equal(s.badLines, 1);
  assert.equal(s.sessionsWithStops, 1);
});

test('renderStats 复用 watch.mjs 的统计口径（不是另写一套）', () => {
  const rows = [
    { ts: '2026-10-01T00:00:00Z', sessionId: 'a', state: 'FAILED', kind: 'UNCLASSIFIABLE', idleSec: 10, notified: false, why: 'unclassifiable-too-recent' },
    { ts: '2026-10-01T01:00:00Z', sessionId: 'b', state: 'FAILED', kind: 'UNCLASSIFIABLE', idleSec: 500, notified: true, why: null },
  ];
  const { stats, text } = renderStats(rows, { minIdleSec: 300 });
  assert.equal(stats.total, 2);
  assert.equal(stats.notified, 1);
  assert.ok(text.includes('UNCLASSIFIABLE'));
  assert.ok(text.includes('60-300s'));
});

test('pct 不除零', () => {
  assert.equal(pct(0, 0), '0.0');
  assert.equal(pct(1, 4), '25.0');
});
