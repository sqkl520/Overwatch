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
    // 时刻必须落在「静默窗口内」（默认 8 小时）——这条测试只关心
    // 「跳过 subagents + 按新旧排序」，静默时长由它自己的测试守。
    writeTranscript(join(dir, 'proj-a'), 'old', [assistant('要不要先做 A？', now - 6 * HOUR)]);
    writeTranscript(join(dir, 'proj-b'), 'new', [assistant('要不要先做 B？', now - 5 * HOUR)]);
    // subagents 必须被跳过：那是子 agent，不是人的会话
    writeTranscript(join(dir, 'proj-a', 'subagents'), 'sub', [assistant('要我做吗？', now - 2 * HOUR)]);
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

// ── 现状对账：问句之后还值不值得提醒（2026-11-02 误报）─────────────
//
// 本次 bug 的核心：`d48b776b` 的问句是真的（2026-11-01T23:31:45.824Z），
// 但问完那一秒会话就 idle 了，之后静默 10.5 小时。时间门（1h/24h）全拦不住它。
// 下面每条测试对应一个具体判据，且都写成「把判据拆掉就会变红」的形式。

import {
  assessAsked, continuedAfterQuestion, humanSpokeElsewhere,
  readHostSessions, lastCwd, ASKED_FRESHNESS, ASKED_MAX_SILENCE_HOURS,
} from './asked.mjs';

const H = 3600e3;
const iso = (ms) => new Date(ms).toISOString();

/** 一条真人消息记录（宿主写的 origin.kind，不是靠正则猜文本）。 */
const human = (text, ts) => ({
  type: 'user', timestamp: iso(ts), origin: { kind: 'human' },
  message: { role: 'user', content: text },
});
/** 纯 tool_result 的 user 记录——**不是人话**。 */
const toolResult = (ts) => ({
  type: 'user', timestamp: iso(ts),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
});
/** 宿主在停止点后 0.1 秒写的簿记记录——不是会话继续。 */
const stopHook = (ts) => ({ type: 'system', subtype: 'stop_hook_summary', timestamp: iso(ts) });

test('【本次 bug 核心】问句后 10.5 小时无任何记录 + 会话 idle → 不产生 ASKED', () => {
  // 真实数字：d48b776b 的问句在 2026-11-01T23:31:45.824Z，
  // 宿主 statusUpdatedAt 是 23:31:46.007Z（晚 183ms），之后静默 10.5 小时。
  const qTs = Date.parse('2026-11-01T23:31:45.824Z');
  const now = qTs + 10.5 * H;
  // 真实形态：问完之后只有一条宿主的 stop_hook_summary，再没有别的记录。
  const records = [
    { type: 'assistant', timestamp: iso(qTs), message: { content: [{ type: 'text', text: '要我提交吗？' }] } },
    stopHook(qTs + 96),
  ];
  const continued = continuedAfterQuestion(records, iso(qTs));
  assert.equal(continued, null, '宿主簿记不算会话继续——这是本条的关键前提');

  const v = assessAsked({
    questionTs: iso(qTs), continued,
    host: { status: 'idle', statusUpdatedAt: qTs + 183 }, hostStatus: 'idle',
    siblingHit: null, nowMs: now,
  });
  assert.equal(v.keep, false, `10.5 小时静默不该提醒，实际 keep=${v.keep} why=${v.why}`);
  assert.equal(v.why, 'silent-too-long', '拦下它的是静默时长——宿主与兄弟会话当时都帮不上忙');
});

test('【本次 bug 核心·跨会话】同 cwd 另一会话在问句之后有人说话 → 不产生 ASKED', () => {
  const now = Date.now();
  const qTs = now - 10.5 * H;
  const siblings = [{
    sessionId: '36b92630',
    humans: [{ at: iso(qTs + 7 * 60e3), text: '你不需要提交，只需要将自己的工作全部做完' }],
  }];
  const hit = humanSpokeElsewhere(siblings, iso(qTs));
  assert.ok(hit && hit.sessionId === '36b92630', '应命中同 cwd 的另一个会话');
  const v = assessAsked({
    questionTs: iso(qTs), continued: null,
    host: { status: 'idle', statusUpdatedAt: qTs + 183 }, hostStatus: 'idle',
    siblingHit: hit, nowMs: now,
  });
  assert.equal(v.keep, false, '人已经在别处回应了，这边不该再催');
  // 这条也被静默门槛拦下了（10.5h > 8h）。跨会话判据要单独验证，
  // 所以在下面用「静默仍在窗口内」的场景再测一次。
  assert.ok(['answered-elsewhere', 'silent-too-long'].includes(v.why), v.why);
});

test('跨会话判据单独成立：静默在窗口内，但别处已有人说话 → 不产生', () => {
  // 把静默压到 8 小时以内，让「静默门槛」不生效，只剩跨会话这一条能拦。
  const now = Date.now();
  const qTs = now - 2 * H;
  const hit = humanSpokeElsewhere(
    [{ sessionId: '36b92630', humans: [{ at: iso(qTs + 7 * 60e3), text: '你不需要提交' }] }],
    iso(qTs),
  );
  assert.ok(hit, '兄弟会话里 7 分钟后有人说话');
  const v = assessAsked({
    questionTs: iso(qTs), continued: null,
    host: { status: 'idle', statusUpdatedAt: qTs + 183 }, hostStatus: 'idle',
    siblingHit: hit, nowMs: now,
  });
  assert.equal(v.keep, false);
  assert.equal(v.why, 'answered-elsewhere', '这条必须由跨会话判据拦，而不是静默门槛');
});

test('问句后 1 分钟、会话还在跑（宿主 busy）→ 不产生（刚问完由 minHours 管）', () => {
  const now = Date.now();
  const qTs = now - 60e3;
  const v = assessAsked({
    questionTs: iso(qTs), continued: null,
    host: { status: 'busy', statusUpdatedAt: now - 1000 }, hostStatus: 'busy', nowMs: now,
  });
  assert.equal(v.keep, false);
  assert.equal(v.why, 'host-not-idle');
});

test('问句后 1 分钟、宿主 idle 且就在问句之后置的 → 产生（这才是真在等）', () => {
  const now = Date.now();
  const qTs = now - 60e3;
  const v = assessAsked({
    questionTs: iso(qTs), continued: null,
    host: { status: 'idle', statusUpdatedAt: qTs + 183 }, hostStatus: 'idle', nowMs: now,
  });
  assert.equal(v.keep, true, `刚问完就 idle 地等着，正是要报的形态：why=${v.why}`);
  assert.equal(v.why, 'still-waiting');
});

test('问句之后会话自己继续过（有新 tool_use）→ 不产生 ASKED', () => {
  const now = Date.now();
  const qTs = now - 2 * H;
  const records = [
    { type: 'assistant', timestamp: iso(qTs), message: { content: [{ type: 'text', text: '要我做吗？' }] } },
    { type: 'assistant', timestamp: iso(qTs + 60e3), message: { content: [{ type: 'tool_use', name: 'Bash', id: 't1' }] } },
    toolResult(qTs + 61e3),
  ];
  const c = continuedAfterQuestion(records, iso(qTs));
  assert.ok(c, '问句之后有 assistant 记录，应判为「继续了」');
  const v = assessAsked({ questionTs: iso(qTs), continued: c, host: { status: 'idle', statusUpdatedAt: qTs + 100 }, hostStatus: 'idle', nowMs: now });
  assert.equal(v.keep, false);
  assert.equal(v.why, 'continued', '自己继续了就不该催——它没在等人');
});

test('同 cwd 的人说话在问句**之前** → 不算回应，仍要提醒', () => {
  const now = Date.now();
  const qTs = now - 4 * H;
  const siblings = [{ sessionId: 'sib', humans: [{ at: iso(qTs - 60e3), text: '先做 A' }] }];
  assert.equal(humanSpokeElsewhere(siblings, iso(qTs)), null, '问句之前的话不能证明这句被回应了');
  const v = assessAsked({ questionTs: iso(qTs), continued: null, host: { status: 'idle', statusUpdatedAt: qTs + 100 }, hostStatus: 'idle', siblingHit: null, nowMs: now });
  assert.equal(v.keep, true);
  assert.equal(v.why, 'still-waiting');
});

test('tool_result 不算「人话」——否则每一轮工具回执都会被当成人类回答', () => {
  // 这两件事必须分开：
  //   - 问句之后有 tool_result → 会话**自己继续**了（判据 1，应拦）
  //   - tool_result 里没有 origin.kind === 'human' → 它不是人在说话（判据 3，不该当回应）
  // 合成一条 user 记录时最容易搞混，因为它 type 也是 'user'。
  const qTs = Date.now();
  const recs = [toolResult(qTs + 60e3)];
  const continued = continuedAfterQuestion(recs, iso(qTs));
  assert.ok(continued, '有 tool_result 说明会话继续了');
  assert.equal(continued.type, 'user');

  // 但把同一批记录当成人话证据时，它必须不命中：
  // 这里走的是 humanSpokeElsewhere 的输入形状（已提取的 humans 列表）。
  const humans = recs
    .filter((x) => x.type === 'user' && x.origin && x.origin.kind === 'human');
  assert.equal(humans.length, 0, 'tool_result 没有 origin.kind，不算人话');
  assert.equal(humanSpokeElsewhere([{ sessionId: 's', humans: [] }], iso(qTs)), null);
});

test('宿主那条 0.1 秒后的 stop_hook_summary 不算「会话继续」', () => {
  // 实测 d48b776b 第 20523 行就是这个形态：问句 +96ms 的 system 记录。
  // 若把它当「继续」，本次要修的误报反而一条都报不出来。
  const qTs = Date.now();
  const records = [stopHook(qTs + 96)];
  assert.equal(continuedAfterQuestion(records, iso(qTs)), null);
});

test('读不到宿主状态 → 不因此拦截（采集缺失不是证据）', () => {
  const now = Date.now();
  const qTs = now - 2 * H;
  const v = assessAsked({ questionTs: iso(qTs), continued: null, host: null, hostStatus: null, nowMs: now });
  assert.equal(v.keep, true, '读不到 host 不能变成「永远不提醒」');
  assert.equal(v.why, 'host-unknown');
});

test('宿主 idle 的时间戳早于问句 → 那次 idle 与这个问句无关', () => {
  const now = Date.now();
  const qTs = now - 2 * H;
  const v = assessAsked({
    questionTs: iso(qTs), continued: null,
    host: { status: 'idle', statusUpdatedAt: qTs - 3 * H }, hostStatus: 'idle', nowMs: now,
  });
  assert.equal(v.keep, false);
  assert.equal(v.why, 'host-idle-before-question');
});

test('continuedAfterQuestion：问句时刻不可解析时返回 null（不知道 ≠ 没继续）', () => {
  assert.equal(continuedAfterQuestion([], ''), null);
  assert.equal(continuedAfterQuestion([], 'not-a-date'), null);
});

test('lastCwd 取最后一条带 cwd 的记录——会话中途会 chdir', () => {
  const recs = [{ cwd: 'D:/a' }, { cwd: 'D:/a/b' }, { type: 'assistant' }];
  assert.equal(lastCwd(recs), 'D:/a/b');
  assert.equal(lastCwd([]), null);
});

test('readHostSessions：读 sessions/*.json，缺字段不崩', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, '1.json'), JSON.stringify({ sessionId: 's1', status: 'idle', statusUpdatedAt: 1793575906007, cwd: 'D:/x' }));
    writeFileSync(join(dir, '2.json'), JSON.stringify({ nope: true }));
    writeFileSync(join(dir, '3.json'), '{ 半截');
    const out = readHostSessions(dir);
    assert.equal(out.length, 1, `应只认有效的那条：${JSON.stringify(out)}`);
    assert.equal(out[0].status, 'idle');
    assert.equal(out[0].statusUpdatedAt, 1793575906007);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readHostSessions：目录不存在返回空数组，不抛', () => {
  assert.deepEqual(readHostSessions('/nonexistent/xyz'), []);
});

test('scanAll：跨会话索引覆盖**全部**会话，不只是候选', () => {
  // 这条守的是结构：误报里说话的那个会话（36b92630）当时自己已经继续了，
  // 所以它根本不是候选。只索引候选会让这条证据正好被漏掉。
  const dir = tmp();
  try {
    const now = Date.now();
    const qTs = now - 2 * H;
    // 候选：问句结尾，停着不动
    writeTranscript(join(dir, 'proj'), 'asker', [
      { type: 'assistant', timestamp: iso(qTs), cwd: 'D:/same',
        message: { content: [{ type: 'text', text: '要我提交吗？' }] } },
    ]);
    // 非候选：不以问句结尾（自己继续干活了），但里面有真人回话
    writeTranscript(join(dir, 'proj'), 'sibling', [
      { type: 'user', timestamp: iso(qTs + 60e3), cwd: 'D:/same', origin: { kind: 'human' },
        message: { role: 'user', content: '你不需要提交，只需要将自己的工作全部做完' } },
      { type: 'assistant', timestamp: iso(qTs + 120e3), cwd: 'D:/same',
        message: { content: [{ type: 'text', text: '好的，继续。' }] } },
    ]);
    const r = scanAll({ projectsRoot: dir, nowMs: now, minHours: 1 });
    assert.equal(r.found.length, 0, `同项目已有人回应，不该再报：${JSON.stringify(r.found.map((x) => x.project))}`);
    assert.equal(r.skipped.answeredElsewhere, 1, `应记在 answeredElsewhere：${JSON.stringify(r.skipped)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanAll：不同 cwd 的会话不算跨会话证据', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    const qTs = now - 2 * H;
    writeTranscript(join(dir, 'proj'), 'asker', [
      { type: 'assistant', timestamp: iso(qTs), cwd: 'D:/one',
        message: { content: [{ type: 'text', text: '要我提交吗？' }] } },
    ]);
    writeTranscript(join(dir, 'proj'), 'other', [
      { type: 'user', timestamp: iso(qTs + 60e3), cwd: 'D:/two', origin: { kind: 'human' },
        message: { role: 'user', content: '无关项目的另一句话' } },
    ]);
    const r = scanAll({ projectsRoot: dir, nowMs: now, minHours: 1 });
    assert.equal(r.found.length, 1, '不同 cwd 的人说话不能替这个会话作答');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanAll：问句后自己继续了 → 不报，且记在 continued', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    const qTs = now - 2 * H;
    writeTranscript(join(dir, 'proj'), 'asker', [
      { type: 'assistant', timestamp: iso(qTs), cwd: 'D:/x',
        message: { content: [{ type: 'text', text: '要我提交吗？' }] } },
      { type: 'assistant', timestamp: iso(qTs + 30e3), cwd: 'D:/x',
        message: { content: [{ type: 'tool_use', name: 'Bash', id: 'b1' }] } },
    ]);
    const r = scanAll({ projectsRoot: dir, nowMs: now, minHours: 1 });
    assert.equal(r.found.length, 0);
    assert.equal(r.skipped.continued, 1, JSON.stringify(r.skipped));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanAll：有 sessionsRoot 且宿主说 busy → 不报', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    const qTs = now - 2 * H;
    writeTranscript(join(dir, 'proj'), 'asker', [
      { type: 'assistant', timestamp: iso(qTs), cwd: 'D:/x',
        message: { content: [{ type: 'text', text: '要我提交吗？' }] } },
    ]);
    const sdir = join(dir, 'sessions');
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, '1.json'), JSON.stringify({ sessionId: 'asker', status: 'busy', statusUpdatedAt: now - 1000 }));
    const r = scanAll({ projectsRoot: join(dir, 'proj'), sessionsRoot: sdir, nowMs: now, minHours: 1 });
    assert.equal(r.found.length, 0, '宿主说 busy 就是不报');
    assert.equal(r.skipped.hostNotIdle, 1, JSON.stringify(r.skipped));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanAll：有 sessionsRoot 且宿主说 idle（问句之后置的）→ 仍要报', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    const qTs = now - 2 * H;
    writeTranscript(join(dir, 'proj'), 'asker', [
      { type: 'assistant', timestamp: iso(qTs), cwd: 'D:/x',
        message: { content: [{ type: 'text', text: '要我提交吗？' }] } },
    ]);
    const sdir = join(dir, 'sessions');
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, '1.json'), JSON.stringify({ sessionId: 'asker', status: 'idle', statusUpdatedAt: qTs + 183 }));
    const r = scanAll({ projectsRoot: join(dir, 'proj'), sessionsRoot: sdir, nowMs: now, minHours: 1 });
    assert.equal(r.found.length, 1, `这个会话确实还停在原地等人：${JSON.stringify(r.skipped)}`);
    assert.equal(r.found[0].freshness, 'still-waiting');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanAll：不给 sessionsRoot 时不做宿主对账——老调用方行为不变', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    writeTranscript(join(dir, 'proj'), 'asker', [
      { type: 'assistant', timestamp: iso(now - 2 * H), cwd: 'D:/x',
        message: { content: [{ type: 'text', text: '要我提交吗？' }] } },
    ]);
    const r = scanAll({ projectsRoot: dir, nowMs: now, minHours: 1 });
    assert.equal(r.found.length, 1);
    assert.equal(r.found[0].freshness, 'host-unknown');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanAll：跨会话证据与目录遍历顺序无关（两遍扫描）', () => {
  // 单遍扫描时，能否拿到证据取决于谁先被遍历到——这是实测抓到的 bug：
  // 先写 asker 再写 sibling → 不拦；把两个文件名反过来 → 就拦了。
  // 判据不该依赖文件名的字典序。
  const now = Date.now();
  const qTs = now - 2 * H;
  const mk = (dir, askerName, siblingName) => {
    writeTranscript(join(dir, 'proj'), askerName, [
      { type: 'assistant', timestamp: iso(qTs), cwd: 'D:/same',
        message: { content: [{ type: 'text', text: '要我提交吗？' }] } },
    ]);
    writeTranscript(join(dir, 'proj'), siblingName, [
      { type: 'user', timestamp: iso(qTs + 60e3), cwd: 'D:/same', origin: { kind: 'human' },
        message: { role: 'user', content: '不用提交，继续做完' } },
      { type: 'assistant', timestamp: iso(qTs + 120e3), cwd: 'D:/same',
        message: { content: [{ type: 'text', text: '好。' }] } },
    ]);
  };
  for (const [a, b] of [['aaa', 'zzz'], ['zzz', 'aaa']]) {
    const dir = tmp();
    try {
      mk(dir, a, b);
      const r = scanAll({ projectsRoot: dir, nowMs: now, minHours: 1 });
      assert.equal(r.skipped.answeredElsewhere, 1, `${a} 在前 / ${b} 在后时应命中跨会话证据，实际 ${JSON.stringify(r.skipped)}`);
      assert.equal(r.found.length, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('scanAll：结果里不带原始 records——不能为了拿一条问题扛着整份 transcript', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    writeTranscript(join(dir, 'proj'), 'asker', [
      { type: 'assistant', timestamp: iso(now - 2 * H), cwd: 'D:/x',
        message: { content: [{ type: 'text', text: '要我提交吗？' }] } },
    ]);
    const r = scanAll({ projectsRoot: dir, nowMs: now, minHours: 1 });
    assert.equal(r.found[0].records, undefined, 'records 必须剥掉：单份可达 117 MB');
    assert.ok(r.found[0].sessionId, '但要带上 sessionId');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ASKED_FRESHNESS 的宽限是 5 分钟——够盖住一次慢写，又不足以掩盖「昨天就停着了」', () => {
  assert.equal(ASKED_FRESHNESS.hostGraceMs, 5 * 60e3);
});

test('ASKED_MAX_SILENCE_HOURS 是 8——实测 93% 的问句后恢复都在 8 小时内', () => {
  // 241 个 transcript / 411 个问句结尾的 turn：≤1h 77%、≤2h 86%、≤4h 89%、≤8h 93%、
  // ≤12h 95%、≤24h 100%。取 8h 是「93% 该恢复的都恢复了」那条线。
  assert.equal(ASKED_MAX_SILENCE_HOURS, 8);
  // 而本次误报的问句静默了 10.5 小时——门槛必须低于它，否则等于没修。
  assert.ok(10.5 > ASKED_MAX_SILENCE_HOURS, '本次 bug 的 10.5 小时必须越过门槛');
});

test('静默门槛：7.9 小时不拦，8.1 小时拦', () => {
  const qTs = Date.now() - 7.9 * H;
  const justUnder = assessAsked({
    questionTs: iso(qTs), continued: null,
    host: { status: 'idle', statusUpdatedAt: qTs + 183 }, hostStatus: 'idle', nowMs: Date.now(),
  });
  assert.equal(justUnder.keep, true, '窗口内仍要报');

  const qTs2 = Date.now() - 8.1 * H;
  const justOver = assessAsked({
    questionTs: iso(qTs2), continued: null,
    host: { status: 'idle', statusUpdatedAt: qTs2 + 183 }, hostStatus: 'idle', nowMs: Date.now(),
  });
  assert.equal(justOver.keep, false);
  assert.equal(justOver.why, 'silent-too-long');
});

test('静默门槛不依赖宿主与跨会话——两者都缺时它单独也能拦', () => {
  // 这条守的是判定**顺序**：把 silent 检查放到 host/continued 之后，
  // 一条「宿主读不到 + 没有兄弟会话」的会话就会绕过它。
  const qTs = Date.now() - 10 * H;
  const v = assessAsked({ questionTs: iso(qTs), continued: null, host: null, hostStatus: null, siblingHit: null, nowMs: Date.now() });
  assert.equal(v.keep, false, '宿主未知不是放行 10 小时静默的理由');
  assert.equal(v.why, 'silent-too-long');
});

test('scanAll：静默超过窗口的问题进 skipped.silentTooLong，不再出现在 found', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    writeTranscript(join(dir, 'proj'), 'sleepy', [
      { type: 'assistant', timestamp: iso(now - 10.5 * H), cwd: 'D:/x',
        message: { content: [{ type: 'text', text: '要我提交吗？' }] } },
    ]);
    const r = scanAll({ projectsRoot: dir, nowMs: now, minHours: 1 });
    assert.equal(r.found.length, 0, '10.5 小时静默不该出现在结果里');
    assert.equal(r.skipped.silentTooLong, 1, JSON.stringify(r.skipped));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('formatResult：静默跳过要说清，不能只报个数字', () => {
  const out = formatResult({
    found: [], scanned: 9,
    skipped: { greeting: 0, tooRecent: 0, tooOld: 0, silentTooLong: 2 },
  });
  assert.ok(out.includes('问后静默过久 2'), out);
});

test('formatResult：新的跳过原因都要说清，不能只报个数字', () => {
  const out = formatResult({
    found: [], scanned: 9,
    skipped: { greeting: 0, tooRecent: 0, tooOld: 0, continued: 2, answeredElsewhere: 1, hostNotIdle: 3 },
  });
  assert.ok(out.includes('自己继续了 2'), out);
  assert.ok(out.includes('别的会话里已被回应 1'), out);
  assert.ok(out.includes('宿主说已不在等 3'), out);
});
