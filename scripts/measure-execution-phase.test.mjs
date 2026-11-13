#!/usr/bin/env node
/**
 * measure-execution-phase.test.mjs — 「执行期中断」测量器的回归测试。
 *
 * 造一个最小的 transcript 目录（两条人造会话 + 两条 fork 重放），
 * 逐条断言口径。**每条断言都对应报告 §1 里的一句口径说明**，
 * 所以口径变了测试就会红——这正是测试存在的理由。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normToolName, isWriteCall, isReadCall, optionLabels, questionsOf, classifyAnswer,
  createAccumulator, absorbRecord, finalizeSession, groupSessions, groupStats,
  oneShotRate, ranks, spearman, mulberry32, cliffsDelta, permutationTest,
  fnv1a, recordSignature, analyzeFile, run, summarize, formatReport,
} from './measure-execution-phase.mjs';

// ── 造记录的小工具 ──────────────────────────────────────────────────

let clock = 0;
let idSeq = 0;
const ts = () => {
  clock += 60_000; // 每条记录间隔 1 分钟，跨「一次坐下」的测试会自己调大
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + clock).toISOString();
};

const userText = (text, extra = {}) => ({
  type: 'user', timestamp: extra.timestamp ?? ts(),
  message: { role: 'user', content: text }, origin: { kind: 'human' }, ...extra,
});

const assistantTool = (name, input, extra = {}) => ({
  type: 'assistant', timestamp: extra.timestamp ?? ts(),
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: extra.id ?? `t${++idSeq}`, name, input }],
  },
  ...extra,
});

const askInput = (qs) => ({
  questions: qs.map((q) => ({
    question: q, header: 'H', multiSelect: false,
    options: [{ label: '选项甲', description: 'a' }, { label: '选项乙', description: 'b' }],
  })),
});

const answerRecord = (answers, qs, extra = {}) => ({
  type: 'user', timestamp: extra.timestamp ?? ts(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tA', content: 'ok' }] },
  toolUseResult: { questions: askInput(qs).questions, answers },
  ...extra,
});

/** 把记录数组跑成一个会话结果。 */
function session(records, meta = { path: '/x/a.jsonl', bytes: 1, mtimeMs: 0 }) {
  const acc = createAccumulator();
  for (const r of records) absorbRecord(acc, r);
  return finalizeSession(acc, meta);
}

// ── 工具名与调用分类 ────────────────────────────────────────────────

test('normToolName 归一化大小写并拒掉被污染的名字', () => {
  assert.equal(normToolName('Edit'), 'edit');
  assert.equal(normToolName('WRITE'), 'write');
  assert.equal(normToolName('Edit=file_path'), null);
  assert.equal(normToolName('Grep<|channel|>json'), null);
  assert.equal(normToolName(''), null);
  assert.equal(normToolName(null), null);
});

test('isWriteCall 认 Write/Edit/NotebookEdit，大小写不敏感', () => {
  assert.equal(isWriteCall('Write', {}), true);
  assert.equal(isWriteCall('edit', {}), true);
  assert.equal(isWriteCall('NotebookEdit', {}), true);
  assert.equal(isWriteCall('MultiEdit', {}), true);
  assert.equal(isWriteCall('Read', {}), false);
  assert.equal(isWriteCall('Bash', { command: 'ls -la' }), false);
});

test('isWriteCall 用 isMutatingCommand 判 Bash 写入，产物搬运不算', () => {
  assert.equal(isWriteCall('Bash', { command: 'echo hi > src/a.mjs' }), true);
  assert.equal(isWriteCall('Bash', { command: 'sed -i s/a/b/ scripts/x.mjs' }), true);
  assert.equal(isWriteCall('Bash', { command: 'cat > /tmp/x.txt <<EOF\nhi\nEOF' }), false);
  assert.equal(isWriteCall('Bash', { command: 'cp a.jar backups/' }), false);
  assert.equal(isWriteCall('Bash', {}), false);
});

test('isReadCall 只认读工具与只读 shell', () => {
  assert.equal(isReadCall('Read', {}), true);
  assert.equal(isReadCall('Glob', {}), true);
  assert.equal(isReadCall('grep', {}), true);
  assert.equal(isReadCall('Bash', { command: 'ls -la' }), true);
  assert.equal(isReadCall('Bash', { command: 'git log --oneline' }), true);
  assert.equal(isReadCall('Bash', { command: 'echo x > a.mjs' }), false);
  assert.equal(isReadCall('Write', {}), false);
  // WebFetch / WebSearch 是外部资料，不是项目状态
  assert.equal(isReadCall('WebFetch', {}), false);
  assert.equal(isReadCall('WebSearch', {}), false);
});

// ── 提问与作答 ──────────────────────────────────────────────────────

test('optionLabels 吃下对象与纯字符串两种形状', () => {
  assert.deepEqual(optionLabels([{ label: '甲' }, { label: '乙' }]), ['甲', '乙']);
  assert.deepEqual(optionLabels(['甲', '乙']), ['甲', '乙']);
  assert.deepEqual(optionLabels([null, 3, { label: '丙' }]), ['丙']);
  assert.deepEqual(optionLabels(undefined), []);
});

test('questionsOf 对坏入参返回空数组，不把会话打成「提问过」', () => {
  assert.deepEqual(questionsOf({ questions: 'nope' }), []);
  assert.deepEqual(questionsOf(null), []);
  assert.deepEqual(questionsOf({}), []);
  const ok = questionsOf(askInput(['问题一']));
  assert.equal(ok.length, 1);
  assert.equal(ok[0].question, '问题一');
  assert.deepEqual(ok[0].options, ['选项甲', '选项乙']);
  // 没有 question 文本的条目被丢掉
  assert.deepEqual(questionsOf({ questions: [{ header: 'x', options: [] }] }), []);
});

test('classifyAnswer 区分「选了选项」与「自由文本」', () => {
  const q = { options: ['甲', '乙'] };
  assert.deepEqual(classifyAnswer(q, '甲'), { option: 1, free: 0, chars: 1 });
  assert.deepEqual(classifyAnswer(q, '我自己写的'), { option: 0, free: 1, chars: 5 });
  // 多选：逐项判
  assert.deepEqual(classifyAnswer(q, ['甲', '自由']), { option: 1, free: 1, chars: 3 });
  assert.deepEqual(classifyAnswer(q, undefined), { option: 0, free: 0, chars: 0 });
});

// ── 边界：执行起点 ──────────────────────────────────────────────────

test('执行起点 = 第一次写操作；其前的人类发言不计入执行期中断', () => {
  const s = session([
    userText('任务书'),
    assistantTool('Read', { file_path: 'a' }),
    userText('补充一句'),
    assistantTool('Write', { file_path: 'a.md', content: 'x' }),
    userText('跑完了吗'),
  ]);
  assert.equal(s.hasWrite, true);
  assert.equal(s.humanMessages, 3);
  // 只有「跑完了吗」在执行起点之后
  assert.equal(s.execInterruptions, 1);
  assert.equal(s.preExecHumanMessages, 1);
});

test('没有写操作的会话没有执行起点，不参与分组', () => {
  const s = session([
    userText('看看这个'),
    assistantTool('Read', { file_path: 'a' }),
    userText('再说说'),
  ]);
  assert.equal(s.hasWrite, false);
  assert.equal(s.exec, null);
  assert.equal(s.execInterruptions, 0);
  assert.equal(s.execDurationMs, null);
  const g = groupSessions([s]);
  assert.equal(g.noExec.length, 1);
  assert.equal(g.A.length + g.B.length + g.C.length, 0);
});

test('会话第一条人类消息永远不算执行期中断', () => {
  // 极端构造：第一条人类消息就在写操作之后（宿主没有把任务书写成 user 记录）
  const s = session([
    assistantTool('Read', {}),
    assistantTool('Write', { file_path: 'a.md', content: 'x' }),
    userText('第一句'),
    userText('第二句'),
  ]);
  assert.equal(s.humanMessages, 2);
  assert.equal(s.execInterruptions, 1);
});

test('AskUserQuestion 的作答不计入主指标，但单独计数', () => {
  const s = session([
    userText('任务书'),
    assistantTool('AskUserQuestion', askInput(['做哪个']), { id: 'tA' }),
    answerRecord({ 做哪个: '选项甲' }, ['做哪个']),
    assistantTool('Write', { file_path: 'a.md', content: 'x' }),
    assistantTool('AskUserQuestion', askInput(['还改吗']), { id: 'tB' }),
    answerRecord({ 还改吗: '选项乙' }, ['还改吗']),
    userText('继续'),
  ]);
  assert.equal(s.asks, 2);
  assert.equal(s.execInterruptions, 1);     // 只有「继续」
  assert.equal(s.execAskAnswers, 1);        // 执行期的那次作答
  assert.equal(s.preExecAnswers, 1);
});

test('打断标记单独计数，不被当成人类发言', () => {
  const s = session([
    userText('任务书'),
    assistantTool('Write', { file_path: 'a.md', content: 'x' }),
    { type: 'user', timestamp: ts(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    userText('还是按原来的'),
  ]);
  assert.equal(s.execInterruptions, 1);
  assert.equal(s.execInterruptMarkers, 1);
});

test('宿主合成消息与 tool_result 不算人类发言', () => {
  const s = session([
    userText('任务书'),
    assistantTool('Write', { file_path: 'a.md', content: 'x' }),
    { type: 'user', timestamp: ts(), message: { role: 'user', content: '<task-notification>\n<status>completed</status>\n</task-notification>' } },
    { type: 'user', timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'user', timestamp: ts(), isMeta: true, message: { role: 'user', content: 'meta 注入' } },
  ]);
  assert.equal(s.humanMessages, 1);
  assert.equal(s.execInterruptions, 0);
});

test('origin.kind 不是 human 的记录被排除（如 peer / task-notification）', () => {
  const s = session([
    userText('任务书'),
    assistantTool('Write', { file_path: 'a.md', content: 'x' }),
    { type: 'user', timestamp: ts(), origin: { kind: 'peer' }, message: { role: 'user', content: '来自另一个会话' } },
  ]);
  assert.equal(s.execInterruptions, 0);
});

test('重复落盘的 tool_use（同一 id）只算一次', () => {
  const t = assistantTool('Write', { file_path: 'a.md', content: 'x' }, { id: 'dup' });
  const s = session([
    userText('任务书'),
    t,
    t,
    t,
    userText('一'),
  ]);
  assert.equal(s.writes, 1);
  assert.equal(s.execInterruptions, 1);
});

// ── 分组 ────────────────────────────────────────────────────────────

test('分组：第一次提问在执行起点之前 = A，之后 = B，没有提问 = C', () => {
  const A = session([
    userText('任务书'),
    assistantTool('AskUserQuestion', askInput(['选哪个']), { id: 'a1' }),
    answerRecord({ 选哪个: '选项甲' }, ['选哪个']),
    assistantTool('Write', { file_path: 'a.md', content: 'x' }),
  ]);
  const B = session([
    userText('任务书'),
    assistantTool('Write', { file_path: 'a.md', content: 'x' }),
    assistantTool('AskUserQuestion', askInput(['选哪个']), { id: 'b1' }),
    answerRecord({ 选哪个: '选项甲' }, ['选哪个']),
  ]);
  const C = session([
    userText('任务书'),
    assistantTool('Write', { file_path: 'a.md', content: 'x' }),
  ]);
  const g = groupSessions([A, B, C]);
  assert.equal(g.A.length, 1);
  assert.equal(g.B.length, 1);
  assert.equal(g.C.length, 1);
  assert.equal(A.firstAskBeforeExec, true);
  assert.equal(B.firstAskBeforeExec, false);
  assert.equal(C.asks, 0);
});

test('多次提问只看第一次的位置（A 组不会被后来的提问改判）', () => {
  const s = session([
    userText('任务书'),
    assistantTool('AskUserQuestion', askInput(['q1']), { id: 'a1' }),
    answerRecord({ q1: '选项甲' }, ['q1']),
    assistantTool('Write', { file_path: 'a.md', content: 'x' }),
    assistantTool('AskUserQuestion', askInput(['q2']), { id: 'a2' }),
    answerRecord({ q2: '选项乙' }, ['q2']),
  ]);
  assert.equal(s.firstAskBeforeExec, true);
  assert.equal(groupSessions([s]).A.length, 1);
});

test('入参校验失败的 AskUserQuestion 不算提问（不制造假 A 组）', () => {
  const s = session([
    userText('任务书'),
    assistantTool('AskUserQuestion', { questions: 'broken' }),
    assistantTool('Write', { file_path: 'a.md', content: 'x' }),
  ]);
  assert.equal(s.asks, 0);
  assert.equal(groupSessions([s]).C.length, 1);
});

// ── 统计函数 ────────────────────────────────────────────────────────

test('groupStats 空数组返回全 null 而不是 0', () => {
  const s = groupStats([]);
  assert.equal(s.n, 0);
  assert.equal(s.mean, null);
  assert.equal(s.median, null);
  assert.equal(s.sum, 0);
});

test('groupStats 忽略 null，但保留真实的 0', () => {
  const s = groupStats([0, null, 2, 4]);
  assert.equal(s.n, 3);
  assert.equal(s.mean, 2);
  assert.equal(s.min, 0);
});

test('oneShotRate 的分母是有执行起点的会话', () => {
  const z = { execInterruptions: 0 };
  const n = { execInterruptions: 2 };
  const r = oneShotRate([z, n, n, n]);
  assert.equal(r.n, 4);
  assert.equal(r.zero, 1);
  assert.equal(r.rate, 0.25);
  assert.equal(oneShotRate([]), null);
});

test('ranks 对并列值取平均秩', () => {
  assert.deepEqual(ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  assert.deepEqual(ranks([5]), [1]);
});

test('spearman 对完全单调的数据给 ±1，样本不足给 null', () => {
  assert.equal(spearman([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  assert.equal(spearman([1, 2, 3, 4], [8, 6, 4, 2]), -1);
  assert.equal(spearman([1, 2], [1, 2]), null);
  // 一列全等 → 无定义，返回 null 而不是 0
  assert.equal(spearman([1, 2, 3, 4], [5, 5, 5, 5]), null);
});

test('mulberry32 同种子同序列，不同种子不同序列', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const c = mulberry32(43);
  const va = [a(), a(), a()];
  const vb = [b(), b(), b()];
  const vc = [c(), c(), c()];
  assert.deepEqual(va, vb);
  assert.notDeepEqual(va, vc);
  for (const v of va) assert.ok(v >= 0 && v < 1);
});

test('cliffsDelta 的方向与端点', () => {
  // 3 vs 3，全大于 → 1；全小于 → -1
  assert.equal(cliffsDelta([4, 5, 6], [1, 2, 3]), 1);
  assert.equal(cliffsDelta([1, 2, 3], [4, 5, 6]), -1);
  assert.equal(cliffsDelta([2], [2]), 0);
  assert.equal(cliffsDelta([], [1]), null);
});

test('permutationTest 在两组完全分离时 p 很小，在两组相同时 p 大', () => {
  const sep = permutationTest([1, 1, 1, 1, 1], [9, 9, 9, 9, 9], 'mean', 500);
  const same = permutationTest([3, 3, 3, 3], [3, 3, 3, 3], 'mean', 500);
  assert.ok(sep.p < 0.05, `sep.p=${sep.p}`);
  assert.ok(same.p > 0.5, `same.p=${same.p}`);
  // 样本 <2 返回 null（不硬造 p 值）
  assert.equal(permutationTest([1], [2, 3], 'mean'), null);
});

test('permutationTest 的 p 值可复现（固定种子）', () => {
  const a = [1, 2, 3, 9, 12];
  const b = [4, 5, 6, 7, 8];
  assert.equal(permutationTest(a, b).p, permutationTest(a, b).p);
});

// ── 哈希与去重 ──────────────────────────────────────────────────────

test('fnv1a 确定且区分内容', () => {
  assert.equal(fnv1a(0x811c9dc5, 'a'), fnv1a(0x811c9dc5, 'a'));
  assert.notEqual(fnv1a(0x811c9dc5, 'a'), fnv1a(0x811c9dc5, 'b'));
});

test('recordSignature 丢掉时间戳与 uuid，只留内容', () => {
  const a = { type: 'user', timestamp: 't1', uuid: 'u1', message: { content: '同一句话' } };
  const b = { type: 'user', timestamp: 't2', uuid: 'u2', message: { content: '同一句话' } };
  assert.equal(recordSignature(a), recordSignature(b));
  const c = { type: 'user', timestamp: 't1', uuid: 'u1', message: { content: '另一句话' } };
  assert.notEqual(recordSignature(a), recordSignature(c));
});

test('finalizeSession 暴露内容哈希，供 fork 重放去重使用', () => {
  const s = session([userText('任务书'), assistantTool('Read', {})]);
  assert.equal(typeof s.contentHash, 'number');
  assert.ok(s.contentRecords > 0);
});

// ── 端到端：真实目录 ────────────────────────────────────────────────

test('run 在临时目录上跑通，并且把 fork 重放去重', () => {
  const root = mkdtempSync(join(tmpdir(), 'ow-execphase-'));
  try {
    const slug = join(root, 'proj');
    mkdirSync(slug, { recursive: true });

    // 会话一：开工前提问（A 组），执行期 1 次中断
    const s1 = [
      userText('任务书', { timestamp: '2026-01-01T00:00:00.000Z' }),
      assistantTool('AskUserQuestion', askInput(['选哪个']),
        { id: 'q1', timestamp: '2026-01-01T00:01:00.000Z' }),
      answerRecord({ 选哪个: '选项甲' }, ['选哪个'], { timestamp: '2026-01-01T00:02:00.000Z' }),
      assistantTool('Write', { file_path: 'a.md', content: 'x' }, { timestamp: '2026-01-01T00:03:00.000Z' }),
      userText('再改改', { timestamp: '2026-01-01T00:04:00.000Z' }),
    ].map((r) => ({ ...r, sessionId: 's1' }));

    // 会话二：同一段历史的重放（内容相同、时间戳不同）→ 必须被去重掉
    const s2 = s1.map((r) => ({
      ...r, sessionId: 's2',
      timestamp: new Date(Date.parse(r.timestamp) + 3600_000).toISOString(),
    }));

    // 会话三：从不提问（C 组），执行期零中断
    const s3 = [
      userText('任务书', { timestamp: '2026-01-02T00:00:00.000Z' }),
      assistantTool('Write', { file_path: 'b.md', content: 'y' }, { timestamp: '2026-01-02T00:01:00.000Z' }),
    ].map((r) => ({ ...r, sessionId: 's3' }));

    const write = (id, rows) => writeFileSync(
      join(slug, `${id}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
    write('s1', s1);
    write('s2', s2);
    write('s3', s3);

    const res = run({ root, days: 0 });
    assert.equal(res.meta.forkDuplicates, 1, '一条 fork 重放应被去掉');
    assert.equal(res.totals.sessions, 2);
    assert.equal(res.groups.A.n, 1);
    assert.equal(res.groups.C.n, 1);
    assert.equal(res.groups.B.n, 0);
    const a = res.perSession.find((x) => x.group === 'A');
    assert.equal(a.execInterruptions, 1);
    assert.equal(a.asks, 1);
    assert.equal(res.oneShot.A.zero, 0);
    assert.equal(res.oneShot.C.rate, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeFile 对不存在的文件抛错（由 run 捕获并跳过）', () => {
  assert.throws(() => analyzeFile(join(tmpdir(), 'ow-no-such-file-execphase.jsonl')));
});

test('summarize 的口径字段被完整输出，供报告引用', () => {
  const s = session([userText('任务书'), assistantTool('Write', { file_path: 'a.md', content: 'x' })]);
  const res = summarize([s], { root: '/x', days: 0 });
  for (const k of ['executionStart', 'executionInterruption', 'groups']) {
    assert.ok(res.definitions[k], `缺少口径说明 ${k}`);
  }
  assert.equal(typeof res.oldStyle.sum, 'number');
  assert.equal(typeof res.totals.execInterruptions, 'number');
  assert.ok(Array.isArray(res.thresholds));
  assert.ok(res.robust);
});

test('formatReport 在空语料上不抛，且不输出 0 冒充实测值', () => {
  const res = summarize([], { root: '/x', days: 0 });
  const out = formatReport(res);
  assert.match(out, /会话 0/);
  assert.match(out, /—/); // 没有样本时显示破折号
});

test('执行期时长按墙钟算，跨天会话如实反映', () => {
  const s = session([
    userText('任务书', { timestamp: '2026-01-01T00:00:00.000Z' }),
    assistantTool('Write', { file_path: 'a.md', content: 'x' }, { timestamp: '2026-01-03T00:00:00.000Z' }),
  ]);
  assert.equal(s.execDurationMs, 0); // 写操作就是最后一条记录
  const s2 = session([
    userText('任务书', { timestamp: '2026-01-01T00:00:00.000Z' }),
    assistantTool('Write', { file_path: 'a.md', content: 'x' }, { timestamp: '2026-01-01T01:00:00.000Z' }),
    userText('第二天', { timestamp: '2026-01-02T01:00:00.000Z' }),
  ]);
  assert.equal(s2.execDurationMs, 24 * 3600 * 1000);
  // 跨过 60 分钟空闲 → 第二次坐下里没有人类发言
  assert.equal(s2.execInterruptions, 1);
  assert.equal(s2.sittings, 2);
  assert.equal(s2.firstSittingInterruptions, 0);
});

test('firstSittingInterruptions 只在第一个坐下段内计数', () => {
  const s = session([
    userText('任务书', { timestamp: '2026-01-01T00:00:00.000Z' }),
    assistantTool('Write', { file_path: 'a.md', content: 'x' }, { timestamp: '2026-01-01T00:10:00.000Z' }),
    userText('第一段里说的', { timestamp: '2026-01-01T00:20:00.000Z' }),
    // 隔了 3 小时 → 断
    userText('回来再说', { timestamp: '2026-01-01T03:20:00.000Z' }),
  ]);
  assert.equal(s.execInterruptions, 2);
  assert.equal(s.firstSittingInterruptions, 1);
  assert.equal(s.sittings, 2);
});

test('interruptionsFromFirstTool 把边界挪到第一次工具调用', () => {
  const s = session([
    userText('任务书', { timestamp: '2026-01-01T00:00:00.000Z' }),
    assistantTool('Read', { file_path: 'a' }, { timestamp: '2026-01-01T00:01:00.000Z' }),
    userText('探索期说的话', { timestamp: '2026-01-01T00:02:00.000Z' }),
    assistantTool('Write', { file_path: 'a.md', content: 'x' }, { timestamp: '2026-01-01T00:03:00.000Z' }),
    userText('执行期说的话', { timestamp: '2026-01-01T00:04:00.000Z' }),
  ]);
  assert.equal(s.execInterruptions, 1);
  assert.equal(s.interruptionsFromFirstTool, 2);
});
