#!/usr/bin/env node
/**
 * measure-interventions.test.mjs — 「人工介入」测量器的回归测试。
 *
 * 这个脚本的全部价值在于**数字可信**。所以测试守的不是「能不能跑」，
 * 而是这几件事：
 *   - 宿主注入的合成记录不能被算成人说的话（否则介入数虚高 3 倍）
 *   - 同一条 API 响应的多个 block 记录不能被重复计数（否则交还次数虚高 3 倍）
 *   - 用户正常追问不能被算成介入（否则「介入数」只是「对话轮数」的同义词）
 *   - 分位数在边界上不能返回 NaN（否则报告里的 p90 会是空白）
 *
 * 每个断言都对应一条实测反例，见 docs/research/2026-11-11-intervention-baseline.md。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  eachLine, userText, humanTurnText, isInterrupt, assistantStop, askedUser,
  isAskAnswer, classifyHumanMessage, analyzeTranscript, summarize, percentile,
  listTranscripts, run, avoidabilityOf, INTERRUPT_MARKER,
} from './measure-interventions.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ow-mi-'));

const write = (dir, name, records) => {
  // name 可含一层子目录（如 'p/full'），listTranscripts 只看两层
  const sub = name.includes('/') ? join(dir, name.split('/')[0]) : dir;
  const base = name.includes('/') ? name.split('/')[1] : name;
  mkdirSync(sub, { recursive: true });
  const p = join(sub, `${base}.jsonl`);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p;
};

const TS = '2026-11-10T10:00:00.000Z';
const TS2 = '2026-11-10T10:05:00.000Z';

const user = (text, extra = {}) => ({
  type: 'user', timestamp: TS,
  message: { role: 'user', content: text },
  ...extra,
});
const userBlocks = (blocks, extra = {}) => ({
  type: 'user', timestamp: TS,
  message: { role: 'user', content: blocks },
  ...extra,
});
/** assistant 响应。id 相同的多条记录模拟宿主按 block 拆分落盘。 */
const assistant = (blocks, stop = null, extra = {}) => ({
  type: 'assistant', timestamp: TS,
  message: { id: extra.id ?? 'msg-1', role: 'assistant', content: blocks, stop_reason: stop },
  ...extra,
});

// ── 逐行读取 ────────────────────────────────────────────────────────

test('eachLine 逐行回调，跨块边界的中文不会被切碎', () => {
  const dir = tmp();
  try {
    // 构造超过 1MB 的内容，强制跨块
    const long = '中'.repeat(400000);
    const recs = [user(long), user('继续')];
    const p = write(dir, 's', recs);
    const lines = [];
    eachLine(p, (l) => { if (l) lines.push(l); });
    assert.equal(lines.length, 2);
    const a = JSON.parse(lines[0]);
    assert.equal(a.message.content.length, 400000);
    assert.equal(JSON.parse(lines[1]).message.content, '继续');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('eachLine 不把整个文件读进内存：空文件不炸、无尾换行也能出最后一行', () => {
  const dir = tmp();
  try {
    const p = join(dir, 'a.jsonl');
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, '', 'utf8');
    const none = [];
    eachLine(p, (l) => none.push(l));
    assert.deepEqual(none, []);

    writeFileSync(p, '{"a":1}', 'utf8');   // 无换行结尾
    const got = [];
    eachLine(p, (l) => got.push(l));
    assert.deepEqual(got, ['{"a":1}']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 单条记录判定 ────────────────────────────────────────────────────

test('userText：tool_result 记录返回 null（工具回执不是人说的话）', () => {
  assert.equal(userText(userBlocks([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }])), null);
  assert.equal(userText({ type: 'user', message: { content: 'hi' } }), 'hi');
  assert.equal(userText({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }), 'hi');
});

test('humanTurnText：宿主合成的系统消息不算人类发言', () => {
  // 实测 7129 条 task-notification + 423 条命令回显，不排除会让介入数虚高数倍
  assert.equal(humanTurnText(user('<task-notification>\n<task-id>a</task-id>\n</task-notification>')), null);
  assert.equal(humanTurnText(user('<command-name>/model</command-name>')), null);
  assert.equal(humanTurnText(user('<local-command-stdout>Set model</local-command-stdout>')), null);
  assert.equal(humanTurnText(user('<system-reminder>note</system-reminder>')), null);
  assert.equal(humanTurnText(user('  <ide_opened_file>a.ts</ide_opened_file>')), null);
});

test('humanTurnText：origin.kind 非 human 的一律排除（peer / task-notification）', () => {
  assert.equal(humanTurnText(user('另一个会话发来的消息', { origin: { kind: 'peer' } })), null);
  assert.equal(humanTurnText(user('<task/>', { origin: { kind: 'task-notification' } })), null);
  // 老版本不写 origin，人类消息必须仍能识别（实测 380 条这种情况）
  assert.equal(humanTurnText(user('继续')), '继续');
  assert.equal(humanTurnText(user('你好', { origin: { kind: 'human' } })), '你好');
});

test('humanTurnText：isMeta 与上下文压缩续接提示不算人类发言', () => {
  assert.equal(humanTurnText(user('Continue from where you left off.', { isMeta: true })), null);
  assert.equal(humanTurnText(user(
    'This session is being continued from a previous conversation that ran out of context. 摘要…',
  )), null);
});

test('humanTurnText：空文本与纯图片不算人类发言', () => {
  assert.equal(humanTurnText(user('   ')), null);
  assert.equal(humanTurnText(userBlocks([{ type: 'image', source: {} }])), null);
  assert.equal(humanTurnText({ type: 'assistant', message: { content: 'x' } }), null);
});

test('isInterrupt：只认打断标记', () => {
  assert.equal(isInterrupt(userBlocks([{ type: 'text', text: INTERRUPT_MARKER }])), true);
  assert.equal(isInterrupt(user('继续')), false);
  // 打断标记不是 tool_result，必须能被单独认出来
  assert.equal(userText(userBlocks([{ type: 'text', text: INTERRUPT_MARKER }])), INTERRUPT_MARKER);
});

test('isInterrupt：两种变体都要认（实测 195 + 20 次）', () => {
  // 只匹配 `[Request interrupted by user]` 会让这 20 次漏进「插话」类
  assert.equal(isInterrupt(userBlocks([
    { type: 'text', text: '[Request interrupted by user for tool use]' },
  ])), true);
});

test('assistantStop / askedUser：取 stop_reason 与 AskUserQuestion 调用', () => {
  assert.equal(assistantStop(assistant([{ type: 'text', text: 'done' }], 'end_turn')), 'end_turn');
  assert.equal(assistantStop({ type: 'user' }), null);
  assert.equal(askedUser(assistant([{ type: 'tool_use', name: 'AskUserQuestion' }], 'tool_use')), true);
  assert.equal(askedUser(assistant([{ type: 'tool_use', name: 'Bash' }], 'tool_use')), false);
});

test('isAskAnswer：只认成功回答，tool_use_error 不算', () => {
  const mk = (txt) => userBlocks([{
    type: 'tool_result', tool_use_id: 'x', content: txt,
  }]);
  assert.equal(isAskAnswer(mk('Your questions have been answered: "选哪个？"="A"')), true);
  assert.equal(isAskAnswer(mk('The user answered: "选哪个？"="B"')), true);
  assert.equal(isAskAnswer(mk(
    '<tool_use_error>InputValidationError: AskUserQuestion failed</tool_use_error>',
  )), false);
  assert.equal(isAskAnswer(user('普通回复')), false);
});

// ── 分类 ────────────────────────────────────────────────────────────

test('classifyHumanMessage：只有推进语义的算催促', () => {
  for (const t of ['继续', '继续！', '接着做', '然后呢', 'continue', 'go on', 'Continue.']) {
    assert.equal(classifyHumanMessage(t), 'nudge', t);
  }
});

test('classifyHumanMessage：含纠正语义的算纠正', () => {
  for (const t of ['不对，删掉那个', '不是这样，改回来', '你搞错了', '改回原来的版本', '重新做']) {
    assert.equal(classifyHumanMessage(t), 'correction', t);
  }
});

test('classifyHumanMessage：带新信息的追问不算介入（否则介入数=对话数）', () => {
  // 超过 NUDGE_MAX_LEN 的「继续…」视为带了新需求
  const long = '继续但先跑一遍测试，然后把 D:\\Projects 那个仓库的 CHANGELOG 也补上，缺 0.1.5 和 0.1.6';
  assert.equal(classifyHumanMessage(long), 'normal');
  for (const t of ['再加一个测试', '这个函数在哪', '帮我看看 D:\\Projects 那个仓库']) {
    assert.equal(classifyHumanMessage(t), 'normal', t);
  }
});

test('classifyHumanMessage：短催促仍算催促（含「继续，并且…」这类）', () => {
  // 实测「继续并且检查agent状态」仍是在推 AI 走，只是顺带交代小事
  assert.equal(classifyHumanMessage('继续，并且检查agent状态'), 'nudge');
  assert.equal(classifyHumanMessage('继续做其他的'), 'nudge');
  // 纯重试是环境故障的一种，归类到 nudge 由 avoidability 判 P3
  assert.equal(classifyHumanMessage('Try again'), 'nudge');
});

test('classifyHumanMessage：长文档不参与纠正判定', () => {
  // 实测反例：9361 字符的规格文档在第 1706 字符处含「退回 Planning Agent」，
  // 被误判成「用户纠正 AI」——那些词描述的是文档内容
  const doc = '# 规格\n\n' + 'x'.repeat(1700) + '退回 Planning Agent。' + 'y'.repeat(800);
  assert.equal(classifyHumanMessage(doc), 'normal');
});

// ── 会话级聚合 ──────────────────────────────────────────────────────

test('analyzeTranscript：正常追问不计入介入，分母正确', () => {
  const dir = tmp();
  try {
    const p = write(dir, 's', [
      user('帮我看看这个项目'),
      assistant([{ type: 'text', text: '好的' }], 'end_turn'),
      user('再加一个测试'),
      assistant([{ type: 'text', text: '加好了' }], 'end_turn', { id: 'msg-2' }),
    ]);
    const r = analyzeTranscript(p);
    assert.equal(r.humanTurns, 2);
    assert.equal(r.assistantStops, 2);
    assert.equal(r.counts.normal, 2);
    assert.equal(r.counts.interrupt + r.counts.nudge + r.counts.correction, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('analyzeTranscript：同一 message.id 的多个 block 记录只算一次交还', () => {
  const dir = tmp();
  try {
    // 实测：8318 条 assistant 记录只对应 2663 个 id，raw end_turn 是去重后的 3 倍
    const p = write(dir, 's', [
      user('干活'),
      assistant([{ type: 'thinking', thinking: '...' }], null),
      assistant([{ type: 'text', text: '做完了' }], null),
      assistant([{ type: 'text', text: '做完了' }], 'end_turn'),
      user('好'),
    ]);
    const r = analyzeTranscript(p);
    assert.equal(r.assistantStops, 1, '三次分片只能算一次 end_turn');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('analyzeTranscript：停止原因只在后段出现时仍必须计入', () => {
  const dir = tmp();
  try {
    // 反例：中间夹了 queue-operation，前段 stop_reason 为 null，后段才是 end_turn
    const p = write(dir, 's', [
      user('干活'),
      assistant([{ type: 'thinking', thinking: '...' }], null),
      { type: 'queue-operation', operation: 'enqueue', timestamp: TS, content: 'x' },
      assistant([{ type: 'text', text: '完毕' }], 'end_turn'),
    ]);
    const r = analyzeTranscript(p);
    assert.equal(r.assistantStops, 1, '后段的 end_turn 不能被去重逻辑吃掉');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('analyzeTranscript：AI 在干活时用户插话 → interject，不算 normal', () => {
  const dir = tmp();
  try {
    const p = write(dir, 's', [
      user('开始干活'),
      assistant([{ type: 'tool_use', name: 'Bash' }], 'tool_use'),
      user('等一下，先别删那个文件'),
      assistant([{ type: 'text', text: '好的' }], 'end_turn'),
    ]);
    const r = analyzeTranscript(p);
    // 开场那句是第一轮，没有「前一次停止」，算 normal；第二句在 AI 干活时发出，算 interject
    assert.equal(r.counts.interject, 1);
    assert.equal(r.counts.normal, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('analyzeTranscript：答问与打断各自单独成类，不与人类文本重复计', () => {
  const dir = tmp();
  try {
    const p = write(dir, 's', [
      assistant([{ type: 'tool_use', name: 'AskUserQuestion' }], 'tool_use'),
      userBlocks([{ type: 'tool_result', tool_use_id: 'q', content: 'Your questions have been answered: "?"="A"' }]),
      assistant([{ type: 'text', text: '好的' }], 'end_turn'),
      userBlocks([{ type: 'text', text: INTERRUPT_MARKER }]),
      user('我去倒杯水'),
    ]);
    const r = analyzeTranscript(p);
    assert.equal(r.counts.answer, 1);
    assert.equal(r.counts.interrupt, 1);
    // 答问的 tool_result 与打断标记都不是人类发言；「我去倒杯水」才是
    assert.equal(r.humanTurns, 1, '只有那条真的人类文本计入分母');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('analyzeTranscript：会话第一条人类发言是开新活，永远不算介入', () => {
  const dir = tmp();
  try {
    // 反例：一份含「不对」字样的开场任务书曾被判成 correction
    const p = write(dir, 's', [
      user('做一个工具，不对的地方随时打断我'),
      assistant([{ type: 'text', text: '好的' }], 'end_turn'),
    ]);
    const r = analyzeTranscript(p);
    assert.equal(r.counts.correction, 0);
    assert.equal(r.counts.normal, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('analyzeTranscript：两种打断变体都归 interrupt，不漏进 interject', () => {
  const dir = tmp();
  try {
    const p = write(dir, 's', [
      user('干活'),
      assistant([{ type: 'tool_use', name: 'Bash' }], 'tool_use'),
      userBlocks([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
    ]);
    const r = analyzeTranscript(p);
    assert.equal(r.counts.interrupt, 1);
    assert.equal(r.counts.interject, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('analyzeTranscript：--days 窗口只影响事件计数，不影响分母可见性', () => {
  const dir = tmp();
  try {
    const old = '2026-01-01T00:00:00.000Z';
    const p = write(dir, 's', [
      user('老消息', { timestamp: old }),
      assistant([{ type: 'text', text: '嗯' }], 'end_turn', { timestamp: old }),
      user('新消息', { timestamp: TS2 }),
      assistant([{ type: 'text', text: '嗯' }], 'end_turn', { id: 'msg-2', timestamp: TS2 }),
    ]);
    const r = analyzeTranscript(p, Date.parse('2026-06-01T00:00:00.000Z'));
    assert.equal(r.humanTurns, 2, '分母算全量');
    assert.equal(r.counts.normal, 1, '事件只算窗口内');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 可避免性分级 ────────────────────────────────────────────────────

test('avoidabilityOf：AI 反问后用户答「继续」归 Q，不算浪费', () => {
  const e = { type: 'nudge', text: '继续', afterStop: 'end_turn', proseQuestion: true };
  assert.equal(avoidabilityOf(e), 'Q', '有问有答，机制正常，只是格式该用结构化提问');
});

test('avoidabilityOf：AI 直接做完就停、用户还得推 → P1（完成标准没定）', () => {
  const e = { type: 'nudge', text: '继续', afterStop: 'end_turn', proseQuestion: false };
  assert.equal(avoidabilityOf(e), 'P1');
});

test('avoidabilityOf：API 故障后说继续归 P3，不是节奏问题', () => {
  assert.equal(avoidabilityOf({ type: 'nudge', text: '继续', afterStop: 'stop_sequence' }), 'P3');
  assert.equal(avoidabilityOf({ type: 'nudge', text: 'Try again', afterStop: 'end_turn' }), 'P3');
});

test('avoidabilityOf：打断后没再说话 → P4 误触/主动停手', () => {
  assert.equal(avoidabilityOf({ type: 'interrupt', text: INTERRUPT_MARKER }), 'P4');
  assert.equal(avoidabilityOf(
    { type: 'interrupt', text: INTERRUPT_MARKER, nextHumanText: '继续吧' },
  ), 'P4', '停手看了看再放行，也不是信息缺口');
});

test('avoidabilityOf：打断后描述现象 → P2，说新前提 → P1', () => {
  assert.equal(avoidabilityOf(
    { type: 'interrupt', text: INTERRUPT_MARKER, nextHumanText: '界面上那个按钮点了没反应' },
  ), 'P2');
  assert.equal(avoidabilityOf(
    { type: 'interrupt', text: INTERRUPT_MARKER, nextHumanText: '改成用 paper 而不是 spigot' },
  ), 'P1');
});

// ── 汇总 ────────────────────────────────────────────────────────────

test('percentile：边界不返回 NaN，单元素与空数组都正确', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([3], 0.9), 3);
  assert.equal(percentile([1, 2, 3], 0.5), 2);
  assert.equal(percentile([0, 0, 0, 0], 0.9), 0);
  assert.equal(percentile([1, 2, 3, 4], 1), 4);
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
});

test('summarize：介入总数不含 normal，比率分母各自正确', () => {
  const dir = tmp();
  try {
    const p1 = write(dir, 'a', [
      user('干活'),
      assistant([{ type: 'text', text: '完' }], 'end_turn'),
      user('继续'),
    ]);
    const p2 = write(dir, 'b', [
      user('新活'),
      assistant([{ type: 'text', text: '完' }], 'end_turn'),
      user('再加点'),
    ]);
    const s = summarize([analyzeTranscript(p1), analyzeTranscript(p2)]);
    assert.equal(s.totals.sessions, 2);
    assert.equal(s.totals.interventions, 1, '只有「继续」是介入');
    assert.equal(s.totals.byType.nudge, 1);
    assert.equal(s.totals.byType.normal, 3, '两个会话各有一个开场请求，p1 另有「再加点」');
    assert.equal(s.totals.humanTurns, 4);
    assert.equal(s.totals.assistantStops, 2);
    assert.equal(s.rates.perHumanTurn, 0.25);
    assert.equal(s.rates.perAssistantStop, 0.5);
    assert.equal(s.sessionsWithIntervention, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listTranscripts：只取两层，subagents 子目录不参与（否则分母虚高 20 倍）', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'proj'), { recursive: true });
    writeFileSync(join(dir, 'proj', 'main.jsonl'), '{}\n', 'utf8');
    mkdirSync(join(dir, 'proj', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'proj', 'subagents', 'agent-1.jsonl'), '{}\n', 'utf8');
    const got = listTranscripts(dir);
    assert.equal(got.length, 1);
    assert.ok(got[0].path.endsWith('main.jsonl'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listTranscripts：不存在的根返回空数组而不是抛错', () => {
  assert.deepEqual(listTranscripts(join(tmpdir(), 'ow-does-not-exist-xyz')), []);
});

test('run：同一 sessionId 的多份落盘只算一个会话（保留最完整的那份）', () => {
  const dir = tmp();
  try {
    const mk = (sid, turns) => {
      const recs = [user('开场')];
      for (let i = 0; i < turns; i++) {
        recs.push(assistant([{ type: 'text', text: 'x' }], 'end_turn', { id: `m${i}` }));
        recs.push(user('继续'));
      }
      return recs.map((r) => ({ ...r, sessionId: sid }));
    };
    write(dir, 'p/full', mk('sess-1', 3));
    write(dir, 'p/partial', mk('sess-1', 1));
    const res = run({ root: dir, days: 0 });
    assert.equal(res.summary.totals.sessions, 1, '同一 sessionId 不能算两个会话');
    assert.equal(res.duplicateSessions, 1);
    // 保留发言更多的那份
    assert.equal(res.summary.totals.humanTurns, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
