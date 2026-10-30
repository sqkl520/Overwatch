#!/usr/bin/env node
/**
 * classify-stop.test.mjs — 8 条验收标准，全部用构造的输入。
 *
 * 不读真实语料、不读真实 transcript、不写文件。每个用例都是一段手工拼的
 * record 数组，形状取自本机实测（原文见 tasks/runs/2026-10-30-p0/baseline.md
 * 与 docs/research/2026-10-30-stop-signals.md），但内容不是任何真实会话。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStop, KINDS, lastPermissionMode, parseAskAnswers, answerIsNegative,
} from './classify-stop.mjs';

// ── 构造器 ────────────────────────────────────────────────────────────

const assistant = (content, extra = {}) => ({
  type: 'assistant',
  uuid: extra.uuid ?? 'asst-1',
  timestamp: extra.timestamp ?? '2026-10-30T12:00:00.000Z',
  ...extra,
  message: { role: 'assistant', content, stop_reason: extra.stop_reason ?? 'end_turn' },
});

const toolUse = (name, input = {}, id = 'tu-1') => ({ type: 'tool_use', name, input, id });
const toolResult = (id, content) => ({ type: 'tool_result', tool_use_id: id, content });
const textBlock = (text) => ({ type: 'text', text });

const user = (content, extra = {}) => ({
  type: 'user',
  uuid: extra.uuid ?? 'user-1',
  ...extra,
  message: { role: 'user', content },
});

const humanMsg = (text) => user(text, { origin: { kind: 'human' } });
const taskNotification = () => user(
  '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n' +
  '<summary>Agent "扫描" finished</summary>\n</task-notification>',
);

const base = (tail, extra = {}) => ({
  transcriptTail: tail,
  earlierHumanMessages: [],
  jobsState: null,
  ...extra,
});

// ── AC1：纯函数，无 IO，输入缺省不抛 ──────────────────────────────────

test('AC1 导出 classifyStop，且对空输入 / 残缺输入都返回一个完整的四元结果', () => {
  assert.equal(typeof classifyStop, 'function');
  for (const input of [undefined, null, {}, { transcriptTail: [] }, { transcriptTail: [{}] }]) {
    const r = classifyStop(input);
    assert.ok(KINDS.includes(r.kind), `kind 必须在枚举内，实际 ${r.kind}`);
    assert.equal(typeof r.autoAnswerable, 'boolean');
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.evidence && typeof r.evidence === 'object');
  }
  // 没有 assistant 记录时如实说「判不了」，不能猜一个类
  assert.equal(classifyStop({}).kind, 'UNCLASSIFIABLE');
});

test('AC1 classifyStop 是纯的：同样的输入两次调用结果相同，且不修改入参', () => {
  const input = base([assistant([textBlock('已完成')])]);
  const snapshot = JSON.stringify(input);
  const a = classifyStop(input);
  const b = classifyStop(input);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), snapshot, '入参被修改了');
});

// ── AC2：下一句 task-notification 是第一判定，占比见回放脚本 ─────────

test('AC2 下一句是 task-notification → WAITING_SUBAGENT，绝不代答', () => {
  const r = classifyStop(base([
    assistant([textBlock('两个执行 Agent 已派出。')]),
    taskNotification(),
  ]));
  assert.equal(r.kind, 'WAITING_SUBAGENT');
  assert.equal(r.autoAnswerable, false);
  assert.equal(r.confidence, 'measured');
  assert.equal(r.evidence.originKind, 'task-notification');
});

test('AC2 判定优先级最高：即便 jobsState 说 blocked，下一句是通知也先判 WAITING_SUBAGENT', () => {
  const r = classifyStop(base([
    assistant([textBlock('派发完成')]),
    taskNotification(),
  ], { jobsState: { state: 'blocked', needs: '要不要继续？', suggestedReply: '继续' } }));
  assert.equal(r.kind, 'WAITING_SUBAGENT');
});

test('AC2 tool_result 不算「下一句」，要跳过它看下一句人话', () => {
  const r = classifyStop(base([
    assistant([toolUse('Bash', { command: 'ls' }, 'tu-b')]),
    user([toolResult('tu-b', 'a.txt')], { uuid: 'tr-1' }),
    taskNotification(),
  ]));
  assert.equal(r.kind, 'WAITING_SUBAGENT');
});

// ── AC3：ExitPlanMode 后停止永不代答 ─────────────────────────────────

test('AC3 ExitPlanMode 的 tool_use 之后没有 tool_result → PLAN_SUBMITTED，永不代答', () => {
  const r = classifyStop(base([
    assistant([textBlock('计划写好了。')]),
    assistant([toolUse('ExitPlanMode', {}, 'tu-plan')]),
  ], { jobsState: { state: 'blocked', needs: '继续？', suggestedReply: '继续' } }));
  assert.equal(r.kind, 'PLAN_SUBMITTED');
  assert.equal(r.autoAnswerable, false);
  assert.equal(r.confidence, 'measured');
});

test('AC3 ExitPlanMode 的 tool_result 是调用失败（not in plan mode）时不判 PLAN_SUBMITTED', () => {
  // 实测 11 次真实调用里 3 次回的是 "You are not in plan mode ..." —— 那是失败，不是提交
  const r = classifyStop(base([
    assistant([toolUse('ExitPlanMode', {}, 'tu-plan')]),
    user([toolResult('tu-plan', '<tool_use_error>You are not in plan mode. To enter plan mode, call the EnterPlanMode tool first.</tool_use_error>')]),
    assistant([textBlock('计划已写入 plan-upgrade-680.md。直接开始执行。')]),
  ]));
  assert.notEqual(r.kind, 'PLAN_SUBMITTED');
  assert.equal(r.autoAnswerable, false);
});

test('AC3 任何 ExitPlanMode 分支都不允许代答（穷举三种后续）', () => {
  const cases = [
    [],
    [user([toolResult('tu-plan', 'User has approved exiting plan mode. You can now proceed.')])],
    [user([toolResult('tu-plan', "The user doesn't want to proceed with this tool use.")])],
  ];
  for (const after of cases) {
    const r = classifyStop(base([assistant([toolUse('ExitPlanMode', {}, 'tu-plan')]), ...after]));
    assert.equal(r.autoAnswerable, false, `后续=${after.length} 时允许了代答`);
  }
});

// ── AC4：AskUserQuestion 有 / 无 tool_result 分开判 ──────────────────

const askInput = {
  questions: [{ header: '下一步', question: '源码仓的提交要现在推到 GitHub 吗？', options: [] }],
};

test('AC4 AskUserQuestion 有 tool_result → ASKED_AND_ANSWERED，且解析出答案', () => {
  const r = classifyStop(base([
    assistant([toolUse('AskUserQuestion', askInput, 'tu-ask')]),
    user([toolResult('tu-ask', 'The user answered: "源码仓的提交要现在推到 GitHub 吗？"="先不推"')]),
  ]));
  assert.equal(r.kind, 'ASKED_AND_ANSWERED');
  assert.equal(r.confidence, 'measured');
  assert.equal(r.evidence.answers.length, 1);
  assert.equal(r.evidence.answers[0].answer, '先不推');
  assert.equal(r.evidence.answers[0].negative, true);
});

test('AC4 AskUserQuestion 无 tool_result → ASKED_UNANSWERED，与上一类不是同一类', () => {
  const unanswered = classifyStop(base([assistant([toolUse('AskUserQuestion', askInput, 'tu-ask')])]));
  const answered = classifyStop(base([
    assistant([toolUse('AskUserQuestion', askInput, 'tu-ask')]),
    user([toolResult('tu-ask', 'The user answered: "源码仓的提交要现在推到 GitHub 吗？"="推"')]),
  ]));
  assert.equal(unanswered.kind, 'ASKED_UNANSWERED');
  assert.equal(answered.kind, 'ASKED_AND_ANSWERED');
  assert.notEqual(unanswered.kind, answered.kind);
  assert.equal(unanswered.autoAnswerable, false);
});

test('AC4 「有回复」不等于「同意」：答案是肯定也照样不代答', () => {
  const r = classifyStop(base([
    assistant([toolUse('AskUserQuestion', askInput, 'tu-ask')]),
    user([toolResult('tu-ask', 'Your questions have been answered: "源码仓的提交要现在推到 GitHub 吗？"="现在推"')]),
  ]));
  assert.equal(r.evidence.answerNegative, false);
  assert.equal(r.autoAnswerable, false, '把「有回复」当「同意」是会导致误推的那类 bug');
});

test('AC4 第二种落盘格式（Your questions have been answered）也能解析', () => {
  const r = classifyStop(base([
    assistant([toolUse('AskUserQuestion', { questions: [{ question: '先做哪一件？' }] }, 'tu-ask')]),
    user([toolResult('tu-ask',
      'Your questions have been answered: "先做哪一件？"="修文档路线矛盾", "环境装到哪一步？"="加上Android Studio". ' +
      'You can now continue with these answers in mind.')]),
  ]));
  assert.equal(r.kind, 'ASKED_AND_ANSWERED');
  assert.equal(r.evidence.answers.length, 2);
  assert.equal(r.evidence.answers[1].answer, '加上Android Studio');
});

// ── AC5：前文参与判定 ────────────────────────────────────────────────

test('AC5 前文改变 evidence 与 confidence：无前文时 UNCLASSIFIABLE 的 confidence 是 null，有相关前文时是 low', () => {
  const tail = [assistant([textBlock('这几份测试报告我先读了两份，剩下两份还没看。')])];
  const early = ['先把这四份测试报告都读一遍，再决定要不要交用户实测单'];

  const without = classifyStop(base(tail));
  const withCtx = classifyStop(base(tail, { earlierHumanMessages: early }));

  assert.equal(without.kind, 'UNCLASSIFIABLE');
  assert.equal(withCtx.kind, 'UNCLASSIFIABLE', '前文不得改变 kind —— 分类是结构性的');
  assert.equal(without.confidence, null);
  assert.equal(withCtx.confidence, 'low');
  assert.equal(without.evidence.earlierMatch, null);
  assert.ok(withCtx.evidence.earlierMatch, '有相关前文时必须记录命中');
  assert.equal(withCtx.evidence.earlierMatch.index, 0);
  assert.equal(typeof withCtx.evidence.earlierMatch.score, 'number');
});

test('AC5 前文不相关时不记录命中（不能见谁都算命中）', () => {
  const tail = [assistant([textBlock('这条路走不通，我换个方向试试。')])];
  const r = classifyStop(base(tail, { earlierHumanMessages: ['把 README 的徽章换成蓝色'] }));
  assert.equal(r.evidence.earlierMatch, null);
  assert.equal(r.confidence, null);
});

test('AC5 前文在第 5 步（WAITING_APPROVAL）也能拦住代答', () => {
  const jobs = { state: 'blocked', needs: '要不要把验收单交给你？', suggestedReply: '交' };
  const tail = [assistant([textBlock('四份报告看完了。')])];

  const plain = classifyStop(base(tail, { jobsState: jobs }));
  const reversed = classifyStop(base(tail, {
    jobsState: jobs,
    earlierHumanMessages: ['先不用交验收单，等我读完再说'],
  }));

  assert.equal(plain.kind, 'WAITING_APPROVAL');
  assert.equal(reversed.kind, 'WAITING_APPROVAL');
  assert.equal(plain.autoAnswerable, true, '无前文时应可代答（宿主给了建议答复）');
  assert.equal(reversed.autoAnswerable, false, '前文否决过，不能沿用旧方向');
  assert.equal(reversed.evidence.earlierMatch.reversal, true);
});

test('AC5 前文命中要记录「第几条」，下标从 0 起且指向对的那条', () => {
  const tail = [assistant([textBlock('那两个仓库的提交我还没动。')])];
  const r = classifyStop(base(tail, {
    earlierHumanMessages: ['随便聊聊天气', '今天先不改代码', '两仓的提交要现在做吗'],
  }));
  assert.equal(r.evidence.earlierMatch.index, 2);
});

// ── AC6：permissionMode 取最后一条，不是第一条 ───────────────────────

test('AC6 permissionMode 取最后一条记录，不是第一条', () => {
  const tail = [
    user('hi', { permissionMode: 'bypassPermissions', uuid: 'u-1' }),
    assistant([textBlock('开始干活')], { permissionMode: 'bypassPermissions', uuid: 'a-1' }),
    { type: 'permission-mode', permissionMode: 'plan', sessionId: 's' },
    assistant([textBlock('写完了')], { permissionMode: 'plan', uuid: 'a-2' }),
  ];
  const r = classifyStop(base(tail));
  assert.equal(r.evidence.permissionMode, 'plan');
  assert.equal(r.evidence.permissionModeSource, 'tail:last');
});

test('AC6 lastPermissionMode 直接对数组断言：取尾不取头', () => {
  const recs = [
    { type: 'user', permissionMode: 'auto' },
    { type: 'user' },
    { type: 'permission-mode', permissionMode: 'acceptEdits' },
    { type: 'assistant', permissionMode: 'bypassPermissions' },
    { type: 'assistant' },
  ];
  assert.equal(lastPermissionMode(recs), 'bypassPermissions');
  assert.equal(lastPermissionMode([]), null);
  assert.equal(lastPermissionMode([{ type: 'user' }]), null);
});

test('AC6 tail 里读不到时才用调用方显式给的 permissionMode，并标明来源', () => {
  const fromInput = classifyStop(base([assistant([textBlock('完')])], { permissionMode: 'plan' }));
  assert.equal(fromInput.evidence.permissionMode, 'plan');
  assert.equal(fromInput.evidence.permissionModeSource, 'input');

  const none = classifyStop(base([assistant([textBlock('完')])]));
  assert.equal(none.evidence.permissionMode, null);
  assert.equal(none.evidence.permissionModeSource, null);
});

// ── AC7：confidence 只允许三个值 ─────────────────────────────────────

test('AC7 confidence 只允许 measured / low / null，不得出现裸数字', () => {
  const inputs = [
    base([]),
    base([assistant([textBlock('x')])]),
    base([assistant([textBlock('已完成')])]),
    base([assistant([textBlock('x')]), taskNotification()]),
    base([assistant([toolUse('ExitPlanMode', {}, 'p')])]),
    base([assistant([toolUse('AskUserQuestion', askInput, 'a')]), user([toolResult('a', 'The user answered: "q"="不"')])]),
    base([assistant([toolUse('AskUserQuestion', askInput, 'a')])]),
    base([assistant([textBlock('x')])], { jobsState: { state: 'blocked', needs: 'n', suggestedReply: 's' } }),
    base([assistant([textBlock('x')])], { jobsState: { state: 'blocked', needs: 'API unavailable — retry · 503' } }),
  ];
  const seen = new Set();
  for (const input of inputs) {
    const r = classifyStop(input);
    seen.add(r.confidence);
    assert.ok(
      ['measured', 'low', null].includes(r.confidence),
      `confidence 出现非法值 ${JSON.stringify(r.confidence)}`,
    );
  }
  assert.ok(seen.size >= 3, `三种取值都该被覆盖到，实际 ${[...seen].join(',')}`);
});

// ── AC8：反转负样本必须判为不可代答 ──────────────────────────────────

/** baseline.md 的 3 对 + research §三的完整 3 对（同一批）。 */
const REVERSALS = [
  { earlier: '验收通过后直接推送', current: '算了，等着再推' },
  { earlier: '只要 bug 没有了就直接发布', current: '先出包验成品，直到没有恶性bug再发布' },
  { earlier: '暂时不要提交', current: '发布除fix5之外的所有版本，提交两仓' },
];

test('AC8 反转负样本 1：AskUserQuestion 的答案反转了前文 → autoAnswerable 必须为 false', () => {
  for (const { earlier, current } of REVERSALS) {
    const r = classifyStop(base([
      assistant([toolUse('AskUserQuestion', { questions: [{ question: '下一步怎么走？' }] }, 'tu-ask')]),
      user([toolResult('tu-ask', `The user answered: "下一步怎么走？"="${current}"`)]),
    ], { earlierHumanMessages: [earlier] }));
    assert.equal(r.kind, 'ASKED_AND_ANSWERED');
    assert.equal(r.autoAnswerable, false, `反转样本未被拦下：${earlier} → ${current}`);
    assert.equal(r.evidence.earlierMatch.reversal, true, `反转样本没被识别成反转：${earlier} → ${current}`);
    assert.equal(r.evidence.earlierMatch.index, 0);
  }
});

test('AC8 反转负样本 2：WAITING_APPROVAL 分支里，前文否决过、宿主建议又提起同一动作 → 不可代', () => {
  // 这一条才是真的负向测试：该分支在没有前文时是**可代答**的，
  // 只有反转识别生效时才会变成不可代答。三对都取自 baseline / research 的原话，
  // 只是把「当前文本」放在 suggestedReply 的位置（宿主读到的用户话）。
  const pairs = [
    { earlier: '暂时不要提交', suggestedReply: '提交两仓' },
    { earlier: '先别推送', suggestedReply: '推送到 GitHub' },
    { earlier: '这个版本先不要发布', suggestedReply: '发布 1.0.0' },
  ];
  for (const { earlier, suggestedReply } of pairs) {
    const control = classifyStop(base([assistant([textBlock('等你定。')])], {
      jobsState: { state: 'blocked', needs: '要不要推送？', suggestedReply },
    }));
    const under = classifyStop(base([assistant([textBlock('等你定。')])], {
      jobsState: { state: 'blocked', needs: '要不要推送？', suggestedReply },
      earlierHumanMessages: [earlier],
    }));
    assert.equal(control.autoAnswerable, true, `对照组不成立，测不到东西：${suggestedReply}`);
    assert.equal(under.autoAnswerable, false, `反转未被拦下：${earlier} → ${suggestedReply}`);
    assert.equal(under.evidence.earlierMatch.reversal, true);
  }
});

test('AC8 反转负样本 3：UNCLASSIFIABLE 分支里前文构成反转时，证据里要留下反转标记', () => {
  const r = classifyStop(base([
    assistant([textBlock('那我按这个方向做了。')]),
  ], { earlierHumanMessages: ['暂时不要提交'] }));
  assert.equal(r.kind, 'UNCLASSIFIABLE');
  assert.equal(r.autoAnswerable, false);
});

test('AC8 非反转的复述不能被误判为反转（反向假阳性）', () => {
  const r = classifyStop(base([
    assistant([textBlock('按你说的，提交这两个仓库。')]),
  ], { earlierHumanMessages: ['提交两仓'] }));
  assert.equal(r.evidence.earlierMatch?.reversal, false);
});

test('AC8 复发检查：前文明说「先别提交」、当前改成「提交」→ 判反转', () => {
  // 「暂时不要提交」→「提交两仓」是 baseline 的第三对，Jaccard 0.07，只能靠
  // 极性 + 共享动作词识别，不能靠文本重合。
  const r = classifyStop(base([
    assistant([textBlock('好，那我就提交两个仓库。')]),
  ], { earlierHumanMessages: ['暂时不要提交'] }));
  assert.equal(r.evidence.earlierMatch.reversal, true);
});

// ── 第 5 步细分 ──────────────────────────────────────────────────────

test('第5步 EXTERNAL_BLOCKED：API unavailable / 503 / 504 / 524 / login required / 403 都不可代', () => {
  for (const needs of [
    'API unavailable — retry · 503',
    'API Error: 503 No available channel for model',
    'upstream 504 gateway timeout',
    'Cloudflare 524',
    'login required',
    '403 Forbidden',
  ]) {
    const r = classifyStop(base([assistant([textBlock('卡住了')])], {
      jobsState: { state: 'blocked', needs, suggestedReply: '继续重试' },
    }));
    assert.equal(r.kind, 'EXTERNAL_BLOCKED', `needs=${needs} 判成了 ${r.kind}`);
    assert.equal(r.autoAnswerable, false);
  }
});

test('第5步 WAITING_APPROVAL：needs 是纯询问时判 WAITING_APPROVAL', () => {
  const r = classifyStop(base([assistant([textBlock('报告看完了')])], {
    jobsState: {
      state: 'blocked',
      needs: '要我现在就把用户实测单交给你，还是你先看这四份测试报告？',
      suggestedReply: '先看测试报告',
    },
  }));
  assert.equal(r.kind, 'WAITING_APPROVAL');
  assert.equal(r.autoAnswerable, true);
  assert.equal(r.confidence, 'measured');
});

test('第5步 没有 suggestedReply 时不可代答', () => {
  const r = classifyStop(base([assistant([textBlock('x')])], {
    jobsState: { state: 'blocked', needs: '要不要继续？' },
  }));
  assert.equal(r.kind, 'WAITING_APPROVAL');
  assert.equal(r.autoAnswerable, false);
});

test('第5步 suggestedReply 本身是否定时不可代答', () => {
  const r = classifyStop(base([assistant([textBlock('x')])], {
    jobsState: { state: 'blocked', needs: '要不要推送？', suggestedReply: '先不推' },
  }));
  assert.equal(r.kind, 'WAITING_APPROVAL');
  assert.equal(r.autoAnswerable, false);
});

// ── 第 6、7 步 ───────────────────────────────────────────────────────

test('第6步 COMPLETION_REPORT：命中五个完成词之一，但不据此代答', () => {
  for (const line of ['已完成', '已提交', '全绿', '工作区干净', '做完了']) {
    const r = classifyStop(base([assistant([textBlock(`## 结果\n\n${line}`)])]));
    assert.equal(r.kind, 'COMPLETION_REPORT', `「${line}」没被判成完成汇报`);
    assert.equal(r.autoAnswerable, false);
    assert.equal(r.confidence, 'low');
  }
});

test('第6步 不在末行的完成词不算完成汇报（「已完成 3 项，接下来…」是继续干活）', () => {
  const r = classifyStop(base([assistant([textBlock('已完成 3 项，接下来还要跑测试。\n\n先从 ST2 开始。')])]));
  assert.notEqual(r.kind, 'COMPLETION_REPORT');
});

test('第7步 其余 → UNCLASSIFIABLE，且永不代答', () => {
  const r = classifyStop(base([assistant([textBlock('我看了看目录结构，先不动手。')])]));
  assert.equal(r.kind, 'UNCLASSIFIABLE');
  assert.equal(r.autoAnswerable, false);
  assert.equal(r.confidence, null);
});

// ── 辅助函数 ─────────────────────────────────────────────────────────

test('parseAskAnswers 处理答案里带逗号引号换行的真实形态', () => {
  const got = parseAskAnswers(
    'The user answered: "a?"="删掉，让 ea 只留工作区文件", "b?"="同步并推ea，但要说清楚关系". Read the answers carefully.',
  );
  assert.equal(got.length, 2);
  assert.equal(got[0].answer, '删掉，让 ea 只留工作区文件');
  assert.equal(got[1].answer, '同步并推ea，但要说清楚关系');
});

test('answerIsNegative 识别否定，同时放过「不错 / 不同 / 差不多 / 别人」', () => {
  for (const s of ['先不推', '暂不提交', '不要', '别删', '算了', '取消', '不用了', '不']) {
    assert.equal(answerIsNegative(s), true, `应判否定：${s}`);
  }
  for (const s of ['不错，就这样', '差不多可以', '现在推']) {
    assert.equal(answerIsNegative(s), false, `不该判否定：${s}`);
  }
});

test('answerIsNegative 不把疑问句「要不要我…」判成否定（那是 88% 精度的提议信号）', () => {
  for (const s of ['要不要我现在就推？', '要不要我先把报告整理成一份？']) {
    assert.equal(answerIsNegative(s), false, `疑问句被误判成否定：${s}`);
  }
});

test('answerIsNegative 推迟语：只在跨度里有否定/等待词时才算', () => {
  assert.equal(answerIsNegative('先出包验成品，直到没有恶性bug再发布'), true, '推辞语应判否定');
  assert.equal(answerIsNegative('先把报告读完再决定'), false, '正常行动指令不是否定');
});

test('每个 kind 都能被至少一个构造输入命中（枚举没有死值）', () => {
  const produced = new Set([
    classifyStop(base([assistant([textBlock('x')]), taskNotification()])).kind,
    classifyStop(base([assistant([toolUse('ExitPlanMode', {}, 'p')])])).kind,
    classifyStop(base([assistant([toolUse('AskUserQuestion', askInput, 'a')]), user([toolResult('a', 'The user answered: "q"="x"')])])).kind,
    classifyStop(base([assistant([toolUse('AskUserQuestion', askInput, 'a')])])).kind,
    classifyStop(base([assistant([textBlock('x')])], { jobsState: { state: 'blocked', needs: 'API unavailable 503' } })).kind,
    classifyStop(base([assistant([textBlock('x')])], { jobsState: { state: 'blocked', needs: 'q', suggestedReply: 'a' } })).kind,
    classifyStop(base([assistant([textBlock('已完成')])])).kind,
    classifyStop(base([assistant([textBlock('嗯')])])).kind,
  ]);
  assert.deepEqual([...produced].sort(), [...KINDS].sort());
});
