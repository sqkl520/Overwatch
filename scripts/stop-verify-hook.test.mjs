#!/usr/bin/env node
/**
 * stop-verify-hook.test.mjs — Stop hook 验证闸的测试。
 *
 * 覆盖重点（按「拦错了会怎样」排序）：
 *   1. **默认必须不拦。** 这是对用户影响最大的一条：装上这个 hook 后会话结束不了，
 *      是灾难级故障。观测模式（默认）下任何一个决定都不能变成 block。
 *   2. **fail-open 的四条路。** 输入是垃圾 / transcript 读不到 / 判定抛异常 / 预算超时——
 *      每种都必须放行。用「把故障注入进去，看它还会不会拦」来验证，不是看代码。
 *   3. **证据不足才拦，读不到不拦。** `UNKNOWN` / `UNCHECKABLE` 不能被当成 `NO_EVIDENCE`。
 *      混淆这两者是这套系统最容易犯的谎。
 *   4. **reason 是可执行指令，不是分类名。** 断言它含原话、含**项目实际**的测试命令。
 *      硬编码 `npm test` 对 Maven 项目是错的，所以专门有一条 Maven 的用例。
 *   5. **边界**：后台任务在跑不拦；连续次数会升级；到自己的上限主动放行。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  decide, buildReason, modeOf, parseHookInput, resolveAssistantText,
  readBlockCount, bumpBlockCount, resetBlockCount, appendLog, logPathFor, statePathFor,
  runHook, loadSubagentRecords, BLOCKING_STATUS, MAX_BLOCKS, ESCALATE_AT, RESET_AFTER_MS,
  samplePathFor, sampleLogEnabled, toolSummaryOf, buildSample, appendSample,
  rawFamilyHits, SAMPLE_TEXT_LIMIT,
} from '../scripts/stop-verify-hook.mjs';

import {
  detectProjectCommands, pickNpmScripts, pickMaven, pickGradle, pickCargo, pickGo,
  pickPython, pickDotnet, commandHint, readCapped,
} from '../scripts/project-commands.mjs';

import { detectClaims, CLAIM_FAMILIES } from '../scripts/verify-claims.mjs';

// ── 合成 transcript ──────────────────────────────────────────────────
// 形状照抄真实 transcript：assistant 带 message.content[tool_use]，
// 随后的 user 带 message.content[tool_result]。下标即时间序。

let uid = 0;
const call = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${++uid}`, name, input }] } });
const resultFor = (useRec, content, isError = false) =>
  ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: useRec.message.content[0].id, content, is_error: isError }] } });
function bash(records, cmd, out, isError = false) {
  const c = call('Bash', { command: cmd });
  records.push(c, resultFor(c, out, isError));
  return records;
}
const edit = (records, path) => {
  const c = call('Edit', { file_path: path, old_string: 'a', new_string: 'b' });
  records.push(c, resultFor(c, 'ok'));
  return records;
};
const say = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

const CLAIM = '全部测试通过，336/336，可以结束了。';
const NODE_PROJ = { kind: 'node', test: 'npm run test', build: null, source: 'package.json' };
const MAVEN_PROJ = { kind: 'maven', test: 'mvn -q clean verify', build: 'mvn -q -DskipTests package', source: 'pom.xml' };

/** 一个「声称测试通过」的输入。 */
const inputOf = (extra = {}) => ({
  session_id: 'sess-test',
  hook_event_name: 'Stop',
  last_assistant_message: CLAIM,
  background_tasks: [],
  session_crons: [],
  cwd: '/x',
  ...extra,
});

// ── 1. 默认不拦：装上之后会话必须还能结束 ────────────────────────────

test('默认模式（未设环境变量）是 off，且 decide 的结论不会变成 block', () => {
  assert.equal(modeOf({}), 'off');
  assert.equal(modeOf({ OVERWATCH_STOP_VERIFY: '' }), 'off');
  assert.equal(modeOf({ OVERWATCH_STOP_VERIFY: 'no' }), 'off');
  assert.equal(modeOf({ OVERWATCH_STOP_VERIFY: 'block' }), 'block');
  assert.equal(modeOf({ OVERWATCH_STOP_VERIFY: '1' }), 'block');

  // decide 给出的是「判定」，不是「行为」。模式由调用方施加 —— 但 off 模式下
  // runHook 必须不返回任何东西。这里用真文件系统验证 runHook 的返回值。
  const d = decide({ input: inputOf(), records: [], project: NODE_PROJ, mode: 'off' });
  assert.equal(d.action, 'block', '判定本身说该拦');
});

test('runHook 在默认模式下只记账、不拦（这是最重要的一条负向测试）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-stophook-'));
  try {
    const env = { OVERWATCH_STOP_VERIFY_LOG: join(dir, 'log.jsonl'), OVERWATCH_STOP_VERIFY_STATE: join(dir, 'state.json') };
    const out = runHook({ input: inputOf({ cwd: dir }), env });
    assert.equal(out, null, '默认模式必须放行');
    const rows = readFileSync(env.OVERWATCH_STOP_VERIFY_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'block', '判定记录了「该拦」');
    assert.equal(rows[0].outcome, 'observed-only', '但没有真的拦');
    assert.ok(rows[0].blocking[0].quote.includes('336/336'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 2. 证据不足才拦 ──────────────────────────────────────────────────

test('无证据的测试断言 → block，且 reason 含原话与项目真实命令', () => {
  const d = decide({ input: inputOf(), records: [], project: NODE_PROJ, mode: 'block' });
  assert.equal(d.action, 'block');
  assert.deepEqual(d.blocking.map((b) => b.verdict.status), ['NO_EVIDENCE']);
  assert.ok(d.reason.includes('336/336'), 'reason 要引用它自己写的原话');
  assert.ok(d.reason.includes('npm run test'), 'reason 要用项目配置里的命令');
});

test('Maven 项目：reason 里必须是 mvn 命令，绝不能是 npm test', () => {
  const d = decide({ input: inputOf(), records: [], project: MAVEN_PROJ, mode: 'block' });
  assert.equal(d.action, 'block');
  assert.ok(d.reason.includes('mvn -q clean verify'), '要用 pom.xml 推出来的命令');
  assert.ok(!d.reason.includes('npm test'), '硬编码的 npm test 对 Maven 项目是错的');
  assert.ok(d.reason.includes('pom.xml'), '要说明依据，用户才能自己核对');
});

test('认不出项目类型时不编命令 —— 明说认不出', () => {
  const d = decide({ input: inputOf(), records: [], project: { kind: 'unknown', test: null, build: null, source: null }, mode: 'block' });
  assert.equal(d.action, 'block');
  assert.ok(d.reason.includes('认不出'), '要诚实说认不出');
  assert.ok(!d.reason.includes('npm'), '不能凭空出现 npm');
});

test('编辑之后跑过测试 → SUPPORTED，不拦', () => {
  const recs = [];
  edit(recs, 'src/a.mjs');
  bash(recs, 'npm test', '# tests 336\n# pass 336');
  const d = decide({ input: inputOf(), records: recs, project: NODE_PROJ, mode: 'block' });
  assert.equal(d.action, 'allow');
  assert.equal(d.allowReason, 'all-claims-supported');
});

test('测试成功在编辑之前 → STALE_ONLY，要拦', () => {
  const recs = [];
  bash(recs, 'npm test', '# tests 336\n# pass 336');
  edit(recs, 'src/a.mjs');
  const d = decide({ input: inputOf(), records: recs, project: NODE_PROJ, mode: 'block' });
  assert.equal(d.action, 'block');
  assert.deepEqual(d.blocking.map((b) => b.verdict.status), ['STALE_ONLY']);
});

test('没有完成性断言 → 不拦（不该因为「它没说完美」而拦）', () => {
  const d = decide({
    input: inputOf({ last_assistant_message: '我改了三个文件，接下来准备跑测试。' }),
    records: [], project: NODE_PROJ, mode: 'block',
  });
  assert.equal(d.action, 'allow');
  assert.equal(d.allowReason, 'no-checkable-claim');
});

test('UNKNOWN（后台执行，拿不到退出码）不能当成 NO_EVIDENCE 拦', () => {
  // 这是「我们没读到」与「它没做」的分界。判 UNKNOWN 的输入绝不能进拦。
  const recs = [];
  edit(recs, 'src/a.mjs');
  // 一个被转到后台的测试调用：既没成功也没失败
  const c = call('Bash', { command: 'npm test', run_in_background: true });
  recs.push(c, resultFor(c, 'Command running in background with ID: bg1'));
  const d = decide({ input: inputOf(), records: recs, project: NODE_PROJ, mode: 'block' });
  assert.equal(d.action, 'allow', 'UNKNOWN 必须放行 —— 读不到不等于没做');
  assert.ok(!BLOCKING_STATUS.includes('UNKNOWN'));
  assert.ok(!BLOCKING_STATUS.includes('UNCHECKABLE'));
});

test('BLOCKING_STATUS 恰好是三个确定性档位', () => {
  assert.deepEqual([...BLOCKING_STATUS], ['NO_EVIDENCE', 'STALE_ONLY', 'FAILED_ONLY']);
});

// ── 2b. 子 agent 旁证：实测中 14/15 个含断言的会话都有子 agent transcript ──
//
// 这一组是「不误拦」的关键。执行 Agent 把测试跑在子 agent 里、主会话只贴结论，
// 是这套工作流的常态。不查子 agent，闸门会对绝大多数真实会话误报「没证据」。

test('主 transcript 无证据、子 agent 里有 → 放行，理由是 evidence-only-in-subagents', () => {
  const subs = [];
  edit(subs, 'src/a.mjs');
  bash(subs, 'npm test', '# tests 336\n# pass 336');
  const d = decide({
    input: inputOf(), records: [say('工作完成')], project: NODE_PROJ, mode: 'block',
    subagentRecords: subs,
  });
  assert.equal(d.action, 'allow');
  assert.equal(d.allowReason, 'evidence-only-in-subagents');
  assert.deepEqual(d.seenInSubagents.map((s) => s.family), ['test-count']);
});

test('主与子都无证据 → 仍然拦（旁证不能救「真的没跑」）', () => {
  const d = decide({
    input: inputOf(), records: [], project: NODE_PROJ, mode: 'block',
    subagentRecords: [say('also nothing')],
  });
  assert.equal(d.action, 'block');
});

test('部分断言在子 agent 里有、部分没有 → 只拦缺的那部分，并说明哪些已放行', () => {
  // 主会话：只有「测试通过」这句；子 agent 里只有测试证据，没有构建证据。
  const subs = [];
  bash(subs, 'npm test', '# tests 10\n# pass 10');

  const d = decide({
    input: inputOf({ last_assistant_message: '测试全部通过，构建也成功了。' }),
    records: [], project: NODE_PROJ, mode: 'block',
    subagentRecords: subs,
  });
  assert.equal(d.action, 'block');
  assert.deepEqual(d.blocking.map((b) => b.claim.family), ['build'], '只拦没有旁证的那条');
  assert.ok(d.reason.includes('子 agent'), 'reason 要说明已放行的那条为什么放行');
  assert.ok(d.reason.includes('构建成功'), '要指名是哪一族在子 agent 里有旁证');
});

test('不给 subagentRecords 时行为不变（默认不读子 agent，性能优先）', () => {
  const d = decide({ input: inputOf(), records: [], project: NODE_PROJ, mode: 'block' });
  assert.equal(d.action, 'block');
  assert.equal(d.seenInSubagents, undefined);
});

test('loadSubagentRecords：没有 subagents 目录时返回空数组，不抛', () => {
  assert.deepEqual(loadSubagentRecords('/nonexistent/x.jsonl'), []);
  assert.deepEqual(loadSubagentRecords(''), []);
});

// ── 3. 边界：后台任务在跑就不拦 ──────────────────────────────────────

test('background_tasks 非空 → 放行，理由是「它在等后台任务」', () => {
  const d = decide({
    input: inputOf({ background_tasks: [{ id: 'b1', status: 'running' }] }),
    records: [], project: NODE_PROJ, mode: 'block',
  });
  assert.equal(d.action, 'allow');
  assert.equal(d.allowReason, 'background-tasks-running');
  assert.equal(d.backgroundTasks, 1);
});

test('session_crons 非空 → 同样放行', () => {
  const d = decide({ input: inputOf({ session_crons: [{ id: 'c1' }] }), records: [], project: NODE_PROJ, mode: 'block' });
  assert.equal(d.action, 'allow');
  assert.equal(d.allowReason, 'background-tasks-running');
});

// ── 4. reason 的语气随拦截次数升级 ──────────────────────────────────

test('第 1–3 次是普通提示，第 4 次起明说「宿主会强制放行」并给台阶', () => {
  const mk = (n) => buildReason({
    blocking: [{ claim: { family: 'test-count', quote: CLAIM }, verdict: { status: 'NO_EVIDENCE', reason: 'x' } }],
    project: NODE_PROJ, blockCount: n, mode: 'block',
  });

  for (let n = 0; n < ESCALATE_AT - 1; n++) {
    const r = mk(n);
    assert.ok(r.includes('第 ' + (n + 1) + ' 次拦截'));
    assert.ok(!r.includes('强制放行'), '前几次不该提强制放行');
  }
  const esc = mk(ESCALATE_AT - 1);
  assert.ok(esc.includes('强制放行'), '到阈值要如实告知上限的存在');
  assert.ok(esc.includes('明说你没跑'), '要给一条「说真话」的退路，否则模型只能编');
});

test('reason 有长度上限，不会撞宿主的 10,000 字符硬顶', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    claim: { family: 'test-count', quote: '断言 ' + i + ' '.repeat(120) },
    verdict: { status: 'NO_EVIDENCE', reason: 'r'.repeat(100) },
  }));
  const r = buildReason({ blocking: many, project: NODE_PROJ, blockCount: 0 });
  assert.ok(r.length <= 4000, '实际长度 ' + r.length);
});

// ── 5. fail-open：四条故障路径 ───────────────────────────────────────

test('输入不是 JSON → parseHookInput 返回 null（调用方据此放行）', () => {
  assert.equal(parseHookInput('not json'), null);
  assert.equal(parseHookInput(''), null);
  assert.equal(parseHookInput('[]'), null, '数组不是对象');
  assert.equal(parseHookInput('[1,2]'), null);
  assert.deepEqual(parseHookInput('{"a":1}'), { a: 1 });
});

test('transcript 读不到 → 没有可核对断言 → 放行，绝不拦', () => {
  const d = loadAndDecide('/nonexistent-transcript-path.jsonl');
  assert.equal(d.action, 'allow');
  assert.equal(d.allowReason, 'no-checkable-claim');
});

function loadAndDecide(path) {
  // 复制 runHook 的读盘行为，但只取 decide 的结论。
  const input = inputOf({ transcript_path: path });
  return decide({ input: { ...input, last_assistant_message: '' }, records: [], project: NODE_PROJ, mode: 'block' });
}

test('last_assistant_message 为空时退回 transcript 尾部；两路都空 → 放行', () => {
  const recs = [{ type: 'assistant', message: { content: [{ type: 'text', text: CLAIM }] } }];
  assert.equal(resolveAssistantText({}, recs), CLAIM);
  assert.equal(resolveAssistantText({ last_assistant_message: 'direct' }, recs), 'direct', 'hook 输入优先');
  assert.equal(resolveAssistantText({}, []), '');
});

test('判定抛异常 → runHook 返回 null 并记 hook-internal-error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-stophook-'));
  try {
    const env = { OVERWATCH_STOP_VERIFY: 'block', OVERWATCH_STOP_VERIFY_LOG: join(dir, 'log.jsonl'), OVERWATCH_STOP_VERIFY_STATE: join(dir, 'state.json') };
    // 传一个会让 detectClaims 炸的输入：last_assistant_message 是不可转字符串的对象。
    const evil = { session_id: 's', hook_event_name: 'Stop', transcript_path: join(dir, 'none.jsonl') };
    evil.last_assistant_message = { toString() { throw new Error('boom'); } };
    // decide 内部 String(...) 会抛，runHook 必须吞掉。
    let out;
    assert.doesNotThrow(() => { out = runHook({ input: evil, env }); });
    assert.equal(out, null, '判定炸了必须放行');
    const log = readFileSync(env.OVERWATCH_STOP_VERIFY_LOG, 'utf8');
    assert.ok(log.includes('hook-internal-error'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendLog 写不进去也不抛（记账失败不能影响判定）', () => {
  // 指向一个不可能创建的路径（把文件当目录）
  const dir = mkdtempSync(join(tmpdir(), 'ow-stophook-'));
  try {
    const bogus = join(dir, 'file.txt', 'log.jsonl');
    writeFileSync(join(dir, 'file.txt'), 'x');
    assert.doesNotThrow(() => appendLog({ a: 1 }, { OVERWATCH_STOP_VERIFY_LOG: bogus }));
    assert.equal(appendLog({ a: 1 }, { OVERWATCH_STOP_VERIFY_LOG: bogus }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 6. 拦截计数：升级与归零 ──────────────────────────────────────────

test('bumpBlockCount 递增，readBlockCount 读回同一个数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-stophook-'));
  try {
    const env = { OVERWATCH_STOP_VERIFY_STATE: join(dir, 'state.json') };
    assert.equal(readBlockCount('s1', { env }), 0);
    assert.equal(bumpBlockCount('s1', { env }), 0, '第一次返回「之前是 0」');
    assert.equal(readBlockCount('s1', { env }), 1);
    assert.equal(bumpBlockCount('s1', { env }), 1);
    assert.equal(readBlockCount('s1', { env }), 2);
    resetBlockCount('s1', { env });
    assert.equal(readBlockCount('s1', { env }), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('超过 RESET_AFTER_MS 没有新拦截 → 计数归零（泡杯咖啡回来不该看到「第 5 次」）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-stophook-'));
  try {
    const env = { OVERWATCH_STOP_VERIFY_STATE: join(dir, 'state.json') };
    const t0 = 1_000_000;
    bumpBlockCount('s1', { env, nowMs: t0 });
    assert.equal(readBlockCount('s1', { env, nowMs: t0 + 1000 }), 1);
    assert.equal(readBlockCount('s1', { env, nowMs: t0 + RESET_AFTER_MS + 1 }), 0);
    // 归零后重新计数从 0 起
    assert.equal(bumpBlockCount('s1', { env, nowMs: t0 + RESET_AFTER_MS + 2 }), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('到自己的 MAX_BLOCKS 后主动放行，不依赖宿主的强制放行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-stophook-'));
  try {
    const env = { OVERWATCH_STOP_VERIFY: 'block', OVERWATCH_STOP_VERIFY_LOG: join(dir, 'log.jsonl'), OVERWATCH_STOP_VERIFY_STATE: join(dir, 'state.json') };
    const input = inputOf({ cwd: dir });

    // 前面 MAX_BLOCKS 次都拦
    for (let i = 0; i < MAX_BLOCKS; i++) {
      const out = runHook({ input, env });
      assert.ok(out && out.decision === 'block', '第 ' + (i + 1) + ' 次应拦');
    }
    // 第 MAX_BLOCKS+1 次：我们主动放行
    const out = runHook({ input, env });
    assert.equal(out, null, '到上限必须放行');
    const rows = readFileSync(env.OVERWATCH_STOP_VERIFY_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows[rows.length - 1].outcome, 'allowed-cap');
    assert.equal(rows[rows.length - 1].blockCount, MAX_BLOCKS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('放行一次后计数清零 —— 下一次是新的一轮', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-stophook-'));
  try {
    const env = { OVERWATCH_STOP_VERIFY: 'block', OVERWATCH_STOP_VERIFY_LOG: join(dir, 'log.jsonl'), OVERWATCH_STOP_VERIFY_STATE: join(dir, 'state.json') };
    const bad = inputOf({ cwd: dir });
    const good = inputOf({ cwd: dir, last_assistant_message: '我改了文件，准备跑测试。' });
    runHook({ input: bad, env });
    assert.equal(readBlockCount('sess-test', { env }), 1);
    runHook({ input: good, env }); // 放行
    assert.equal(readBlockCount('sess-test', { env }), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 7. 观测记录：闸门是否有效的唯一数据来源 ──────────────────────────

test('每次判定都记一行，含断言原文 / 判定档位 / reason / 第几次 / 放行原因', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-stophook-'));
  try {
    const env = { OVERWATCH_STOP_VERIFY: 'block', OVERWATCH_STOP_VERIFY_LOG: join(dir, 'log.jsonl'), OVERWATCH_STOP_VERIFY_STATE: join(dir, 'state.json') };
    runHook({ input: inputOf({ cwd: dir }), env });
    const r = JSON.parse(readFileSync(env.OVERWATCH_STOP_VERIFY_LOG, 'utf8').trim());
    for (const k of ['at', 'sessionId', 'mode', 'action', 'blockCount', 'blocking', 'reason', 'outcome']) {
      assert.ok(k in r, '缺字段 ' + k);
    }
    assert.equal(r.sessionId, 'sess-test');
    assert.equal(r.blocking[0].family, 'test-count');
    assert.equal(r.blocking[0].status, 'NO_EVIDENCE');
    assert.equal(r.outcome, 'blocked');
    assert.ok(r.reason.length > 20);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('默认日志路径在 tasks/runs/stop-hook/ 下（gitignored），不污染可发布区', () => {
  const p = logPathFor({}, Date.UTC(2026, 10, 12, 3, 0, 0));
  assert.ok(p.includes(join('tasks', 'runs', 'stop-hook')), p);
  assert.ok(p.endsWith('2026-11-12.jsonl'), p);
  assert.ok(statePathFor({}).includes(join('tasks', 'runs', 'stop-hook')));
});

// ── 8. 项目命令探测 ─────────────────────────────────────────────────

test('Node：从 package.json 的 scripts 里读真实命令', () => {
  assert.deepEqual(pickNpmScripts('{"scripts":{"test":"node --test"}}'), { test: 'npm run test', build: null });
  assert.equal(pickNpmScripts('{"scripts":{"lint":"x"}}'), null, '没有 test 脚本就别猜 npm test');
  assert.equal(pickNpmScripts('not json'), null);
  assert.equal(pickNpmScripts('{}'), null);
});

test('Maven / Gradle / Cargo / Go / Python / .NET 各认一个', () => {
  assert.deepEqual(pickMaven('<project><artifactId>x</artifactId></project>'), { test: 'mvn -q clean verify', build: 'mvn -q -DskipTests package' });
  assert.equal(pickMaven('<html>'), null);
  assert.equal(pickMaven(''), null);

  assert.deepEqual(pickGradle('plugins { id "java" }'), { test: 'gradle test', build: 'gradle build' });
  assert.equal(pickGradle('hello'), null);

  assert.deepEqual(pickCargo('[package]\nname="x"'), { test: 'cargo test', build: 'cargo build' });
  assert.equal(pickCargo('[dependencies]'), null);

  assert.deepEqual(pickGo('module example.com/x\n'), { test: 'go test ./...', build: 'go build ./...' });
  assert.equal(pickGo('hello'), null);

  assert.deepEqual(pickPython({ pyproject: '[tool.pytest.ini_options]' }), { test: 'python -m pytest', build: null });
  assert.equal(pickPython({ pyproject: '[project]' }), null, '没有 pytest 就不猜 unittest');
  assert.equal(pickPython({}), null);

  assert.deepEqual(pickDotnet(true, false), { test: 'dotnet test', build: 'dotnet build' });
  assert.equal(pickDotnet(false, false), null);
});

test('detectProjectCommands 按仓库根的标志文件认类型（真实目录）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ow-proj-'));
  try {
    assert.equal(detectProjectCommands(root).kind, 'unknown');

    writeFileSync(join(root, 'pom.xml'), '<project><artifactId>x</artifactId></project>');
    const m = detectProjectCommands(root);
    assert.equal(m.kind, 'maven');
    assert.equal(m.test, 'mvn -q clean verify');

    // package.json 优先级更高（同名项目可能是前端 + 后端，只给一个主命令）
    writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
    assert.equal(detectProjectCommands(root).kind, 'node');

    // mvnw 存在时应改用包装器
    rmSync(join(root, 'package.json'));
    writeFileSync(join(root, 'mvnw'), '');
    assert.equal(detectProjectCommands(root).test, 'mvnw -q clean verify');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readCapped 只读前一段，不会把大文件整个读进内存', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-proj-'));
  try {
    const p = join(dir, 'big.json');
    writeFileSync(p, '{"a":1}' + 'x'.repeat(400_000));
    const got = readCapped(p, 1024);
    assert.equal(got.length, 1024);
    assert.ok(got.startsWith('{"a":1}'));
    assert.equal(readCapped(join(dir, 'nope'), 1024), null);
    assert.equal(readCapped(dir, 1024), null, '目录不是文件');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('commandHint 对 unknown 不编造命令', () => {
  assert.ok(commandHint({ kind: 'unknown', test: null }).includes('认不出'));
  assert.ok(commandHint({ kind: 'node', test: null, source: 'package.json' }).includes('没有可用的测试命令'));
  assert.ok(commandHint(NODE_PROJ).includes('npm run test'));
  assert.ok(commandHint(NODE_PROJ).includes('package.json'), '要给出依据');
});

// ── 10. Stop hook：P2 的「修好了」现在会被拦（2026-11-13）────────────
//
// 端到端复现实验 P2 组：模型没有 Bash 工具、改了 lib.js、最后说「修好了。」。
// 修之前：detectClaims 认不出 → allowReason = 'no-checkable-claim' → 拦截 0 次。
// 修之后：认出 vague-completion → NO_EVIDENCE → block。

const P2_TEXT = '修好了。三处 bug 都在 `lib.js`。';
const p2Input = (extra = {}) => inputOf({ last_assistant_message: P2_TEXT, ...extra });

test('P2 形态：改了代码、零验证、说“修好了” → 拦截', () => {
  const records = [];
  edit(records, 'lib.js');       // 有改动
  // 没有任何 Bash 调用 —— 与实验里 toolNames 只有 Read/Edit/Write 一致
  const d = decide({ input: p2Input(), records, project: NODE_PROJ, mode: 'block' });
  assert.equal(d.action, 'block', `P2 必须被拦，实际 allowReason=${d.allowReason}`);
  assert.deepEqual(d.claimFamilies, ['vague-completion']);
  assert.equal(d.blocking[0].verdict.status, 'NO_EVIDENCE');
});

test('修复前的行为是 allow:no-checkable-claim —— 这条就是漏洞本身', () => {
  // 负向守卫：把 vague-completion 摘掉后，P2 那句话在**其余九族**里一条都不命中，
  // 于是判定必然退回 allow:no-checkable-claim —— 正是修复前的原样。
  // 若哪天有人删了这一族，上面的测试会红、这条会绿。
  const claims = detectClaims(P2_TEXT);
  assert.deepEqual(claims.map((c) => c.family), ['vague-completion'], '开着时只有这一族命中');
  const otherFamilies = CLAIM_FAMILIES.filter((f) => f.id !== 'vague-completion');
  const hits = otherFamilies.filter((f) => f.re.test(P2_TEXT));
  assert.deepEqual(hits.map((f) => f.id), [],
    '去掉 vague-completion 后不该有任何族命中 P2 的原话 —— 这就是漏洞的成因');
});

test('零改动 + 零验证说“修好了” → UNCHECKABLE → 放行（误伤的兜底出口）', () => {
  const d = decide({ input: p2Input(), records: [], project: NODE_PROJ, mode: 'block' });
  assert.equal(d.claimFamilies.includes('vague-completion'), true, '认出来了');
  assert.equal(d.action, 'allow', '但没有改动也没有检查时判 UNCHECKABLE，放行');
});

test('P2 形态但有验证痕迹 → 放行（不能把真做完的会话也拦掉）', () => {
  const records = [];
  edit(records, 'lib.js');
  bash(records, 'npx eslint lib.js', '');
  const d = decide({ input: p2Input(), records, project: NODE_PROJ, mode: 'block' });
  assert.equal(d.action, 'allow');
  assert.equal(d.allowReason, 'all-claims-supported');
});

test('纯对话说“修好了”→ 放行（误伤防护：这条挡住“每次结束都拦”）', () => {
  // 用户只是问了个问题，AI 答完说「就这样，修好了」—— 一个字没改。
  const d = decide({
    input: inputOf({ last_assistant_message: '这个思路没问题。修好了的话就不用再动了。' }),
    records: [], project: NODE_PROJ, mode: 'block',
  });
  // 「修好了的话」是假设句，连断言都不该认。
  assert.equal(d.allowReason, 'no-checkable-claim');
});

test('拦 P2 时的 reason 必须说清「要跑一次任何形式的检查」，并点名只读观测不算', () => {
  const records = [];
  edit(records, 'lib.js');
  const d = decide({ input: p2Input(), records, project: NODE_PROJ, mode: 'block' });
  assert.equal(d.action, 'block');
  assert.ok(d.reason.includes('修好了'), '必须复述它自己的原话');
  assert.ok(/lint|测试|构建/.test(d.reason), `要给出可执行的下一步：${d.reason}`);
  assert.ok(d.reason.includes('git diff') || d.reason.includes('cat')
    || d.reason.includes('只读'), '必须明说只读观测不算验证，否则模型会拿 git diff 蒙混');
});

// ── 11. 放行样本记录（2026-11-13）──────────────────────────────────
//
// 背景：修好 vague-completion 后，实验里仍有 3 组（P4 / P5 / P6）被判
// no-checkable-claim 放行。它们的形态是 `已+动词` 后面接冒号。
// 主线程的判断是**先不要加规则**（6 个样本撑不起一条判据），改为记录。
//
// 这一组测试要守住三件事：
//   1. 记录**真的**被写进文件，且字段完整（不是只调了函数就算数）；
//   2. hadBash / hadTestRun 来自真实的 tool_use 遍历，不是从文本里猜；
//   3. 记录**不改变判定** —— 记完之后照样放行，且 --no-sample-log 能关掉。

const P4_TEXT = '项目里的 4 个 bug 都在 lib.js...已全部修好：';

/** 样本用一套独立环境变量，避免和判定日志互相覆盖。 */
const sampleEnvOf = (dir, extra = {}) => ({
  OVERWATCH_STOP_VERIFY_LOG: join(dir, 'log.jsonl'),
  OVERWATCH_STOP_VERIFY_STATE: join(dir, 'state.json'),
  OVERWATCH_STOP_VERIFY_SAMPLES: join(dir, 'samples.jsonl'),
  ...extra,
});

const readSamples = (p) => readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

test('no-checkable-claim 放行时写一条样本，字段完整', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-samples-'));
  try {
    const env = sampleEnvOf(dir);
    const out = runHook({ input: inputOf({ cwd: dir, last_assistant_message: P4_TEXT }), env });
    assert.equal(out, null, '判定仍然放行 —— 记录不许改变行为');

    const rows = readSamples(env.OVERWATCH_STOP_VERIFY_SAMPLES);
    assert.equal(rows.length, 1);
    const r = rows[0];
    for (const k of ['ts', 'sessionId', 'reason', 'lastMessage', 'hadBash', 'hadTestRun',
      'hadVerification', 'toolCallCount', 'assistantTurnCount', 'detectedFamilies',
      'rawFamilyHits', 'sampleVersion']) {
      assert.ok(k in r, '样本缺字段 ' + k);
    }
    assert.equal(r.reason, 'no-checkable-claim');
    assert.equal(r.sessionId, 'sess-test');
    assert.equal(r.lastMessage, P4_TEXT, 'P4 的原话必须原样留下来');
    assert.deepEqual(r.detectedFamilies, [], '判定侧确实一条都没认出 —— 这就是要收集的样本');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hadBash / hadTestRun 是真实统计：跑过 npm test 就为 true', () => {
  const records = [];
  edit(records, 'lib.js');
  bash(records, 'npm test', '# tests 10\n# pass 10');

  const s = toolSummaryOf(records);
  assert.equal(s.hadBash, true);
  assert.equal(s.hadTestRun, true);
  assert.equal(s.hadVerification, true);
  assert.equal(s.toolCallCount, 2, 'Edit + Bash 各一次');
  assert.deepEqual(s.toolNames.sort(), ['Bash', 'Edit']);
});

test('hadBash=true 但 hadTestRun=false：只读命令不算跑测试', () => {
  const records = [];
  bash(records, 'ls -la', 'a.txt');
  bash(records, 'git status --short', ' M a.txt');
  bash(records, 'cat lib.js', 'xxx');
  const s = toolSummaryOf(records);
  assert.equal(s.hadBash, true, '确实用过 shell');
  assert.equal(s.hadTestRun, false, '但只读观测不是测试');
  assert.equal(s.hadVerification, false, '也不是任何形式的检查');
});

test('编辑器-only 会话：hadBash=false，toolCallCount 按工具数算', () => {
  const records = [];
  edit(records, 'lib.js');
  edit(records, 'lib.js');
  const s = toolSummaryOf(records);
  assert.equal(s.hadBash, false);
  assert.equal(s.hadTestRun, false);
  assert.equal(s.toolCallCount, 2);
  assert.equal(s.shellCallCount, 0);
});

test('toolSummaryOf 对空 / 垃圾输入安全返回（不抛）', () => {
  for (const v of [[], null, undefined, [null, {}, { type: 'assistant' }]]) {
    const s = toolSummaryOf(v);
    assert.equal(s.hadBash, false);
    assert.equal(s.toolCallCount, 0);
  }
});

test('只记前 500 字，并且如实标记被截断', () => {
  const long = 'x'.repeat(1200);
  const s = buildSample({ text: long, sessionId: 's', decision: {}, records: [] });
  assert.equal(s.lastMessage.length, SAMPLE_TEXT_LIMIT);
  assert.equal(s.lastMessageLength, 1200);
  assert.equal(s.truncated, true);

  const short = buildSample({ text: '短', sessionId: 's', decision: {}, records: [] });
  assert.equal(short.truncated, false);
});

test('截断按字符不按字节 —— 中文不许被切出半个字', () => {
  const zh = '修好了'.repeat(300); // 900 个字符
  const s = buildSample({ text: zh, sessionId: 's', decision: {}, records: [] });
  assert.equal(s.lastMessage.length, SAMPLE_TEXT_LIMIT);
  assert.equal(s.lastMessage.slice(-1), '好', '末字必须完整');
});

test('rawFamilyHits 记录原始正则命中（不经过否决过滤），与 detectedFamilies 是两回事', () => {
  // 「没修好」会被否决，所以 detectClaims 不认；但族正则会命中。
  // 样本里区分这两者，才能把「被正确否决」与「真正漏检」分开。
  const s = buildSample({
    text: '没修好，还有两处没动。', sessionId: 's', decision: { claimFamilies: [] }, records: [],
  });
  assert.deepEqual(s.detectedFamilies, []);
  assert.ok(Array.isArray(s.rawFamilyHits), '字段必须在');
  assert.ok(rawFamilyHits('修好了。').includes('vague-completion'), '原始命中要能看见它');
  assert.deepEqual(rawFamilyHits(''), []);
});

test('无断言的普通回合也写样本（这正是要收集的分布）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-samples-'));
  try {
    const env = sampleEnvOf(dir);
    runHook({ input: inputOf({ cwd: dir, last_assistant_message: '我准备开始了。' }), env });
    const rows = readSamples(env.OVERWATCH_STOP_VERIFY_SAMPLES);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].detectedFamilies, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('OVERWATCH_STOP_VERIFY_SAMPLES=off 能关掉，但判定日志照写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-samples-'));
  try {
    const env = sampleEnvOf(dir, { OVERWATCH_STOP_VERIFY_SAMPLES: 'off' });
    assert.equal(sampleLogEnabled(env), false);
    runHook({ input: inputOf({ cwd: dir, last_assistant_message: P4_TEXT }), env });
    assert.equal(existsSync(join(dir, 'samples.jsonl')), false, '关掉时不该创建文件');
    // 关闭样本 ≠ 关闭观测
    assert.equal(existsSync(join(dir, 'log.jsonl')), true);

    assert.equal(sampleLogEnabled({}, ['node', 'x.mjs', '--no-sample-log']), false);
    assert.equal(sampleLogEnabled({}, ['node', 'x.mjs']), true, '默认开');
    assert.equal(sampleLogEnabled(undefined, []), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--no-sample-log 通过 runHook 的 sampleLog 参数生效（不改判定）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-samples-'));
  try {
    const env = sampleEnvOf(dir);
    const out = runHook({ input: inputOf({ cwd: dir, last_assistant_message: P4_TEXT }), env, sampleLog: false });
    assert.equal(out, null, '仍然放行');
    assert.equal(existsSync(join(dir, 'samples.jsonl')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('默认样本路径在 tasks/runs/ 下（gitignored），不污染可发布区', () => {
  const p = samplePathFor({});
  assert.ok(p.includes(join('tasks', 'runs')), p);
  assert.ok(p.endsWith('stop-hook-samples.jsonl'), p);
  assert.equal(samplePathFor({ OVERWATCH_STOP_VERIFY_SAMPLES: '/tmp/x.jsonl' }), '/tmp/x.jsonl');
});

test('appendSample 写不进去也不抛（记录失败不能影响放行）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-samples-'));
  try {
    const bogus = join(dir, 'file.txt', 's.jsonl');
    writeFileSync(join(dir, 'file.txt'), 'x');
    assert.doesNotThrow(() => appendSample({ a: 1 }, { OVERWATCH_STOP_VERIFY_SAMPLES: bogus }));
    assert.equal(appendSample({ a: 1 }, { OVERWATCH_STOP_VERIFY_SAMPLES: bogus }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('样本记录不改变拦截路径：该拦的照样拦，且不写样本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-samples-'));
  try {
    const env = sampleEnvOf(dir, { OVERWATCH_STOP_VERIFY: 'block' });
    const out = runHook({ input: inputOf({ cwd: dir }), env }); // CLAIM 是可核对断言
    assert.ok(out && out.decision === 'block', '有可核对断言且无证据 → 拦');
    assert.equal(existsSync(join(dir, 'samples.jsonl')), false, '拦住的不进放行样本');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('一条回合一条样本 —— 不去重、不丢字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-samples-'));
  try {
    const env = sampleEnvOf(dir);
    const input = inputOf({ cwd: dir, last_assistant_message: P4_TEXT });
    runHook({ input, env });
    runHook({ input, env });
    const rows = readSamples(env.OVERWATCH_STOP_VERIFY_SAMPLES);
    assert.equal(rows.length, 2, '两次回合结束 = 两条样本（这是分布数据，不是去重数据）');
    assert.equal(rows[0].lastMessage, rows[1].lastMessage);
    for (const r of rows) assert.equal(r.reason, 'no-checkable-claim');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
