#!/usr/bin/env node
/**
 * asked.test.mjs — 「未回答的问题」信号的回归测试。
 *
 * 这个信号的判据全部来自实测分布，测试守的是那些区分：
 *   - 只有末尾是问句才算（正文中间的是修辞）
 *   - 开场客套必须排除（实测 18 个里有 7 个是「今天想做什么呢喵？」）
 *   - 刚问完的不能催（人可能正在看）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  lastAssistantText, endsWithQuestion, classifyQuestion,
  inspectTranscript, scanAll, formatResult, GREETING, DEFAULT_MIN_HOURS,
} from './asked.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ow-asked-'));
const HOUR = 3600e3;

const writeTranscript = (dir, name, records) => {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p;
};

const assistant = (text, ts) => ({
  type: 'assistant', timestamp: new Date(ts).toISOString(),
  message: { content: [{ type: 'text', text }] },
});

test('lastAssistantText 取最后一条有文字的 assistant，跳过工具调用', () => {
  const recs = [
    assistant('第一句', 1000),
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
    assistant('最后一句', 2000),
    { type: 'user', message: { content: '人说的话' } },
  ];
  const r = lastAssistantText(recs);
  assert.equal(r.text, '最后一句');
});

test('endsWithQuestion 只看末尾——正文中间的问号是修辞', () => {
  assert.equal(endsWithQuestion('要我做这个吗？'), true);
  assert.equal(endsWithQuestion('这是什么？反正做完了。'), false, '中间的问号不算');
  assert.equal(endsWithQuestion('已完成，工作区干净'), false);
  assert.equal(endsWithQuestion(''), false);
});

test('classifyQuestion：开场客套被单独识别', () => {
  // 实测 18 个问句结尾的会话里 7 个是这类，永远不会有人回
  for (const g of ['今天想做点什么呢喵？', '想从哪里开始呢？', '有什么需要帮忙的尽管说']) {
    assert.equal(classifyQuestion(g), 'greeting', `应判为客套：${g}`);
  }
});

test('classifyQuestion：带具体选项或动作的才是待决策', () => {
  assert.equal(classifyQuestion('Q3 — 你更想先看到哪个？\n- (a) 真跑一次\n- (b) 直接做宏'), 'decision');
  assert.equal(classifyQuestion('要我把新 JAR 发你测吗？'), 'decision');
  assert.equal(classifyQuestion('要我把它加进 .gitignore 吗？'), 'decision');
});

test('inspectTranscript：问句 + 够久 → 报出来', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    // 真实的待决策问句：问号在结尾。原文里那句「大约 400 行」是问句之前的说明。
    const p = writeTranscript(dir, 'a', [assistant('这个我没做过，大约 400 行。要不要我做这个？', now - 5 * HOUR)]);
    const r = inspectTranscript(p, { nowMs: now, minHours: 1 });
    assert.ok(r && !r.skipped);
    assert.equal(r.kind, 'decision');
    assert.equal(r.hours, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inspectTranscript：刚问完的跳过——人可能正在看', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    const p = writeTranscript(dir, 'b', [assistant('要我做这个吗？', now - 10 * 60e3)]);
    const r = inspectTranscript(p, { nowMs: now, minHours: 1 });
    assert.equal(r.skipped, 'too-recent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inspectTranscript：开场客套跳过', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    const p = writeTranscript(dir, 'c', [assistant('今天想做点什么呢喵？', now - 100 * HOUR)]);
    const r = inspectTranscript(p, { nowMs: now, minHours: 1 });
    assert.equal(r.skipped, 'greeting');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inspectTranscript：不以问句结尾的不报', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    const p = writeTranscript(dir, 'd', [assistant('已完成，工作区干净。', now - 100 * HOUR)]);
    assert.equal(inspectTranscript(p, { nowMs: now, minHours: 1 }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanAll：跳过 subagents 目录，按新旧排序', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    // 50 小时会被上限排除（实测 244 小时的 English 误报就是这么来的），
    // 这条测试只关心「跳过 subagents + 按新旧排序」，所以用窗口内的时长。
    writeTranscript(join(dir, 'proj-a'), 'old', [assistant('要不要先做 A？', now - 20 * HOUR)]);
    writeTranscript(join(dir, 'proj-b'), 'new', [assistant('要不要先做 B？', now - 5 * HOUR)]);
    // subagents 必须被跳过：那是子 agent，不是人的会话
    writeTranscript(join(dir, 'proj-a', 'subagents'), 'sub', [assistant('要我做吗？', now - 99 * HOUR)]);
    const r = scanAll({ projectsRoot: dir, nowMs: now, minHours: 1 });
    assert.equal(r.found.length, 2, `不应扫到 subagents：${r.found.map((x) => x.filePath)}`);
    assert.ok(r.found[0].hours < r.found[1].hours, '最近的排前面');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('formatResult：空结果说明排除了多少，不是光说「没有」', () => {
  const out = formatResult({ found: [], scanned: 10, skipped: { greeting: 3, tooRecent: 2 } });
  assert.ok(out.includes('没有待回答'));
  assert.ok(out.includes('3'), '应报出排除了多少客套');
});

test('formatResult：有结果时按会话列出，带等待时长', () => {
  const out = formatResult({
    found: [{ project: 'demo', hours: 10, kind: 'decision', question: '要做吗？' }],
    scanned: 5, skipped: { greeting: 0, tooRecent: 0 },
  });
  assert.ok(out.includes('demo'));
  assert.ok(out.includes('10 小时前'));
  assert.ok(out.includes('待决策'));
});

test('DEFAULT_MIN_HOURS 是 1——刚问完不该催', () => {
  assert.equal(DEFAULT_MIN_HOURS, 1);
});

test('GREETING 不误伤真问题', () => {
  // 客套模式里有「需要我做什么」，别把它套到「需要我删掉旧包吗」上
  assert.equal(GREETING.test('需要我把旧三个删掉腾空间吗？'), false);
});

// ── 历史：哪些被回答了、平均多久（2026-11-01）──────────────────────

import {
  questionKey, sessionIdOf, loadHistory, saveHistory,
  mergeHistory, historyStats, historyPath, formatHistory,
} from './asked.mjs';

const entry = (over = {}) => ({
  sessionId: 's1', project: 'p', question: 'q?', kind: 'decision',
  firstSeenAt: new Date(Date.now() - 3600e3).toISOString(),
  lastSeenAt: new Date().toISOString(), seenCount: 1, answeredAt: null, answerLatencyHours: null,
  ...over,
});

test('questionKey 稳定：同一问题同一 key，不同问题不同 key', () => {
  assert.equal(questionKey('s1', 'q?'), questionKey('s1', 'q?'));
  assert.notEqual(questionKey('s1', 'q?'), questionKey('s1', 'other?'));
  assert.notEqual(questionKey('s1', 'q?'), questionKey('s2', 'q?'));
});

test('sessionIdOf 从文件路径取 uuid', () => {
  assert.equal(sessionIdOf("C:\\projects\\x\\abc-123.jsonl"), "abc-123");
  assert.equal(sessionIdOf('/home/u/.claude/projects/p/def-456.jsonl'), 'def-456');
});

test('mergeHistory：新发现记 firstSeenAt', () => {
  const now = Date.now();
  const hist = { version: 1, entries: {} };
  const m = mergeHistory(hist, [{ filePath: '/p/a.jsonl', project: 'p', kind: 'decision', question: 'q?' }],
    { nowMs: now, stillAsking: new Map([['a', true]]) });
  assert.equal(m.added, 1);
  const e = Object.values(hist.entries)[0];
  assert.equal(e.firstSeenAt, new Date(now).toISOString());
  assert.equal(e.answeredAt, null);
});

test('mergeHistory：会话不再以问句结尾 → 判已回答并记延迟', () => {
  const now = Date.now();
  const first = new Date(now - 5 * 3600e3).toISOString();
  const hist = { version: 1, entries: { k1: entry({ sessionId: 'a', firstSeenAt: first }) } };
  const m = mergeHistory(hist, [], { nowMs: now, stillAsking: new Map([['a', false]]) });
  assert.equal(m.answered, 1);
  assert.equal(hist.entries.k1.answerLatencyHours, 5);
});

test('mergeHistory：被门槛过滤 ≠ 已回答（实测 bug）', () => {
  // 第一版用「这次没扫到」判已回答，于是 --hours 9999 一跑，
  // 5 条全被判成已回答、延迟算出 0 小时。
  const now = Date.now();
  const hist = { version: 1, entries: { k1: entry({ sessionId: 'a' }) } };
  const m = mergeHistory(hist, [], { nowMs: now, stillAsking: new Map([['a', true]]) });
  assert.equal(m.answered, 0, '仍在问的不算已回答');
  assert.equal(hist.entries.k1.answeredAt, null);
});

test('mergeHistory：没有 stillAsking 时保守处理，不做回答判定', () => {
  const hist = { version: 1, entries: { k1: entry({ sessionId: 'a' }) } };
  const m = mergeHistory(hist, [], { nowMs: Date.now() });
  assert.equal(m.answered, 0, '不知道状态就不猜');
});

test('mergeHistory：已回答的问题又出现 → 撤销回答状态', () => {
  const now = Date.now();
  // key 必须和 mergeHistory 算出的一致：sessionId 来自文件路径，question 来自候选
  const k = questionKey('a', 'q?');
  const hist = { version: 1, entries: { [k]: entry({
    sessionId: 'a', question: 'q?', answeredAt: new Date(now - 1000).toISOString(), answerLatencyHours: 2,
  }) } };
  mergeHistory(hist, [{ filePath: '/p/a.jsonl', project: 'p', kind: 'decision', question: 'q?' }],
    { nowMs: now, stillAsking: new Map([['a', true]]) });
  assert.equal(hist.entries[k].answeredAt, null, '同文本重问说明上次不是真回答');
});

test('historyStats：算出延迟分位与超 24h 未答', () => {
  const now = Date.now();
  const hist = { version: 1, entries: {
    a: entry({ firstSeenAt: new Date(now - 2 * 3600e3).toISOString(), answeredAt: new Date(now).toISOString(), answerLatencyHours: 2 }),
    b: entry({ firstSeenAt: new Date(now - 10 * 3600e3).toISOString(), answeredAt: new Date(now).toISOString(), answerLatencyHours: 10 }),
    c: entry({ firstSeenAt: new Date(now - 48 * 3600e3).toISOString() }),
  } };
  const st = historyStats(hist, { nowMs: now });
  assert.equal(st.total, 3);
  assert.equal(st.answered, 2);
  assert.equal(st.pending, 1);
  assert.equal(st.stalePending, 1, '超过 24h 未答的应单列');
  assert.ok(st.latency.p50 >= 2 && st.latency.p50 <= 10);
});

test('historyStats：空历史不崩', () => {
  const st = historyStats({ entries: {} });
  assert.equal(st.total, 0);
  assert.equal(st.latency, null);
});

test('loadHistory：坏文件与缺失都返回空历史，不抛', () => {
  assert.deepEqual(loadHistory('/nonexistent/x.json').entries, {});
});

test('saveHistory 与 loadHistory 往返一致', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'h.json');
    const hist = { version: 1, entries: { k: entry() } };
    saveHistory(f, hist);
    assert.deepEqual(loadHistory(f).entries.k.sessionId, 's1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('historyPath 不在仓库里', () => {
  const p = historyPath({ LOCALAPPDATA: 'C:\Local', OVERWATCH_STATE_DIR: '' });
  assert.ok(!p.includes('Projects'), `历史不能写在仓库：${p}`);
});

test('formatHistory：空历史说明会自动记录', () => {
  const out = formatHistory({ total: 0 });
  assert.ok(out.includes('空'));
  assert.ok(out.includes('自动记录'), '要说明不用额外操作');
});

test('mergeHistory：这次仍扫到的问题绝不能被判已回答', () => {
  // 去掉 `seen.has(key)` 守卫的话，一条还在问的问题会被判成已回答——
  // 因为 stillAsking 是 Map<'a', true>，但循环里没排除已见到的 key。
  const now = Date.now();
  const k = questionKey('a', 'q?');
  const hist = { version: 1, entries: { [k]: entry({ sessionId: 'a', question: 'q?' }) } };
  const m = mergeHistory(hist, [{ filePath: '/p/a.jsonl', project: 'p', kind: 'decision', question: 'q?' }],
    { nowMs: now, stillAsking: new Map([['a', true]]) });
  assert.equal(m.answered, 0);
  assert.equal(hist.entries[k].answeredAt, null, '仍在问的不能判已回答');
});

test('mergeHistory：会话消失（transcript 被删）不当成已回答', () => {
  // === false 而不是 !get(...)：Map 里查不到表示「不知道」，不是「答完了」。
  // 否则删掉一个 transcript 会凭空产生一条「已回答」记录，污染延迟统计。
  const now = Date.now();
  const k = questionKey('gone', 'q?');
  const hist = { version: 1, entries: { [k]: entry({ sessionId: 'gone', question: 'q?' }) } };
  const m = mergeHistory(hist, [], { nowMs: now, stillAsking: new Map() }); // 空 Map：查不到
  assert.equal(m.answered, 0, '不知道状态就不能判已回答');
  assert.equal(hist.entries[k].answeredAt, null);
});

// ── 历史积压：老问题不该拉低「待回答」（2026-11-01）─────────────────

import { BACKLOG_HOURS } from './asked.mjs';

test('BACKLOG_HOURS 是 24——实测回复 p90 是 14.7h、99% 在 24h 内', () => {
  assert.equal(BACKLOG_HOURS, 24);
});

test('mergeHistory：首次见到就已超 24h 的问题标为积压，不计入待回答', () => {
  // 实测：首轮扫描收进 5 条，最早 21 天前。它们所在的会话早就不动了。
  const now = Date.now();
  const hist = { version: 1, entries: {} };
  const m = mergeHistory(hist, [
    { filePath: '/p/old.jsonl', project: 'old', kind: 'decision', question: '老问题？', hours: 200 },
    { filePath: '/p/new.jsonl', project: 'new', kind: 'decision', question: '新问题？', hours: 2 },
  ], { nowMs: now, stillAsking: new Map([['old', true], ['new', true]]) });
  assert.equal(m.backlog, 1, '200 小时前的应判积压');
  assert.equal(m.added, 2);
  const st = historyStats(hist, { nowMs: now });
  assert.equal(st.backlog, 1);
  assert.equal(st.pending, 1, '只有新的那条算待回答');
});

test('mergeHistory：积压条目不参与回答判定', () => {
  // 积压会话永远不会回复。「没再扫到」是常态，不是「被回答了」。
  const now = Date.now();
  const k = questionKey('old', '老问题？');
  const hist = { version: 1, entries: { [k]: entry({
    sessionId: 'old', question: '老问题？', backlog: true,
  }) } };
  const m = mergeHistory(hist, [], { nowMs: now, stillAsking: new Map([['old', false]]) });
  assert.equal(m.answered, 0, '积压条目不该被判已回答');
  assert.equal(hist.entries[k].answeredAt, null);
});

test('formatHistory：积压单独说明，且数字引用常量不写死', () => {
  const out = formatHistory({ total: 4, backlog: 4, backlogHours: 24, answered: 0, pending: 0 });
  assert.ok(out.includes('历史积压'));
  assert.ok(out.includes('24 小时'), '应引用常量');
  assert.ok(out.includes('不会有回复'));
});

test('historyStats：空历史时 backlogHours 也有值', () => {
  assert.equal(historyStats({ entries: {} }).backlogHours, BACKLOG_HOURS);
});

// ── 上限：太老的问题不该通知（2026-11-01 实收误报）──────────────────

import { MAX_QUESTION_HOURS } from './asked.mjs';

test('MAX_QUESTION_HOURS 是 24——与实测回复分布一致', () => {
  assert.equal(MAX_QUESTION_HOURS, 24);
});

test('inspectTranscript：超过 24 小时的问题跳过，标 too-old', () => {
  // 2026-11-01 实收一条「Let's learn English! 问了没答」，而那个会话文件
  // 244 小时（10 天）没动过。通知一个 10 天前的问句是谎报：
  // 它所在的会话早就结束了，你根本没机会回答。
  const dir = tmp();
  try {
    const now = Date.now();
    const f = writeTranscript(dir, 'old', [assistant('要我做这个吗？', now - 244 * HOUR)]);
    const r = inspectTranscript(f, { nowMs: now, minHours: 1 });
    assert.equal(r.skipped, 'too-old', `244 小时前的问题应跳过，实际：${JSON.stringify(r)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inspectTranscript：边界内（22 小时）仍要报', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    const f = writeTranscript(dir, 'fresh', [assistant('要我做这个吗？', now - 22 * HOUR)]);
    const r = inspectTranscript(f, { nowMs: now, minHours: 1 });
    assert.ok(r && !r.skipped, '22 小时前仍在窗口内');
    assert.equal(r.kind, 'decision');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanAll：tooOld 单独计数，不与其它跳过混在一起', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    writeTranscript(join(dir, 'p1'), 'old1', [assistant('要我做 A 吗？', now - 100 * HOUR)]);
    writeTranscript(join(dir, 'p2'), 'old2', [assistant('要我做 B 吗？', now - 200 * HOUR)]);
    writeTranscript(join(dir, 'p3'), 'fresh', [assistant('要我做 C 吗？', now - 2 * HOUR)]);
    writeTranscript(join(dir, 'p4'), 'greet', [assistant('今天想做点什么呢？', now - 2 * HOUR)]);
    const r = scanAll({ projectsRoot: dir, nowMs: now, minHours: 1 });
    assert.equal(r.found.length, 1, '只有 2 小时那条该报');
    assert.equal(r.skipped.tooOld, 2);
    assert.equal(r.skipped.greeting, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('formatResult：空结果说明「超过 24 小时」而不是含糊带过', () => {
  const out = formatResult({ found: [], scanned: 10, skipped: { greeting: 1, tooRecent: 0, tooOld: 4 } });
  assert.ok(out.includes('超过 24 小时'), `应说明超时排除：\n${out}`);
  assert.ok(out.includes('会话多半已结束'), '要解释为什么不再提醒');
});
