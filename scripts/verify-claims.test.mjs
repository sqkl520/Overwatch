#!/usr/bin/env node
/**
 * verify-claims.test.mjs — 「断言 vs 证据」检测器的测试。
 *
 * 覆盖重点（按踩坑代价排序）：
 *   1. **否定句不能变成断言**。最难、也最致命：「我没跑测试」若被识别成 test-count，
 *      检测器的结论会完全反过来 —— 它会把「诚实」标成「撒谎」。
 *   2. **截断必须判 UNKNOWN，不能判 NO_EVIDENCE**。没读到不等于不存在。
 *   3. 代码块 / 引用 / 行内代码里的断言不算（那是贴过来的日志，不是本会话的完成声明）。
 *   4. 四档各一例，用合成 transcript 走完整条链路（不只测正则）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  detectClaims, findEvidence, classifyEvidence, scanSession, summarizeClaims,
  splitSentences, stripQuoted, isNegated, isInterrogative, isSpeculative,
  lastAssistantText, buildEvidenceIndex, claimedCount, readBack, readTailRecords,
  listSessions, enoughForClaim, enoughForClaims, evidenceSufficient,
  CLAIM_FAMILIES, EVIDENCE_STATUS,
  DEFAULT_BACKTRACK_BYTES, BACKTRACK_STEPS, CLAIM_TAIL_BYTES,
  normalizeCommand, isTestCommand, isBuildCommand, isMutatingCommand, editKindOf,
  resultText, readSlice, parseLines, subagentFiles,
  SKIP_TESTS_RE, CODE_EXTS, DOC_EXTS, EDIT_TOOLS, SHELL_TOOLS, FAIL_OUTPUT_RE,
} from '../scripts/verify-claims.mjs';

const fams = (text) => detectClaims(text).map((c) => c.family);

// ── 合成 transcript ──────────────────────────────────────────────────
//
// 记录形状照抄真实 transcript：assistant 带 message.content[tool_use]，
// 随后的 user 带 message.content[tool_result]。下标就是时间序。

let uid = 0;
function say(text) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}
function call(name, input) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${++uid}`, name, input }] } };
}
function resultFor(useRec, content, isError = false) {
  const id = useRec.message.content[0].id;
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } };
}
/** 追加「一次工具调用 + 它的结果」到记录数组。 */
function tool(records, name, input, output, isError = false) {
  const c = call(name, input);
  records.push(c, resultFor(c, output, isError));
  return records;
}
const bash = (records, cmd, out, isError = false) => tool(records, 'Bash', { command: cmd }, out, isError);
const edit = (records, path) => tool(records, 'Edit', { file_path: path, old_string: 'a', new_string: 'b' }, 'ok');

const claim = (family, quote, checkable = true) => ({ family, quote, checkable, familyLabel: family, index: 0 });

// ── 1. 断言识别：每族正例 ────────────────────────────────────────────

test('test-count：中文 / 英文 / runner 输出三种形态都认', () => {
  assert.deepEqual(fams('336/336 测试通过'), ['test-count']);
  assert.deepEqual(fams('测试全部通过。'), ['test-count']);
  assert.deepEqual(fams('全部 42 个用例通过'), ['test-count']);
  assert.deepEqual(fams('All 42 tests passed.'), ['test-count']);
  assert.deepEqual(fams('pytest 42 passed in 1.2s'), ['test-count']);
  assert.deepEqual(fams('42 tests passed'), ['test-count']);
});

test('build：构建/编译成功（中英）', () => {
  assert.deepEqual(fams('构建成功，JAR 已生成。'), ['build']);
  assert.deepEqual(fams('编译通过，零警告。'), ['build']);
  assert.deepEqual(fams('BUILD SUCCESS'), ['build']);
  assert.deepEqual(fams('Build succeeded.'), ['build']);
});

test('file-count：N 个文件已同步（中英）', () => {
  assert.deepEqual(fams('26 个文件都已同步。'), ['file-count']);
  assert.deepEqual(fams('18 files changed'), ['file-count']);
});

test('artifact-hash：具体 hash / 指纹', () => {
  assert.deepEqual(fams('产物 sha256 3f9a1bc4d5e6f7089a1b2c3d4e5f60718293a4b5'), ['artifact-hash']);
  // 「commit <hash>」同时是 hash 断言和提交断言，两族都该命中 —— 它们是两条可分别核对的声明
  assert.deepEqual(fams('commit 3f9a1bc'), ['artifact-hash', 'commit']);
});

test('todos：待办清空（中英）', () => {
  assert.deepEqual(fams('没有待办项了。'), ['todos']);
  assert.deepEqual(fams('全部完成。'), ['todos']);
  assert.deepEqual(fams('No remaining todos.'), ['todos']);
});

test('commit：已提交（中英）', () => {
  assert.deepEqual(fams('已提交，SHA 是 9d665b0。'), ['artifact-hash', 'commit']);
  assert.deepEqual(fams('committed as 9d665b0'), ['commit']);
});

test('push-remote：已推到远端', () => {
  assert.deepEqual(fams('已推到远端，远端已同步。'), ['push-remote']);
  assert.deepEqual(fams('pushed to origin main'), ['push-remote']);
});

test('pr-ci：CI 通过', () => {
  assert.deepEqual(fams('CI 通过，所有 checks 都是绿的。'), ['pr-ci']);
  assert.deepEqual(fams('all 6 checks passed'), ['pr-ci']);
});

test('runtime-probe：服务已启动 / 端口在监听', () => {
  assert.deepEqual(fams('服务已启动，端口在监听。'), ['runtime-probe']);
  assert.deepEqual(fams('Server is listening on 3000.'), ['runtime-probe']);
});

// ── 2. 断言识别：反例 ────────────────────────────────────────────────

test('反例：否定句不是断言 —— 这是「把诚实标成撒谎」的那一类', () => {
  for (const s of [
    '我没有跑测试。',
    '我没跑测试，只是看了代码。',
    '尚未提交，等你确认。',
    '测试还没通过。',
    '还没有推到远端。',
    '没构建成功，先停下了。',
    'I did not run the tests.',
    'Tests were not run.',
    'Nothing was pushed to remote.',
  ]) {
    assert.deepEqual(fams(s), [], `不该认出断言：${s}`);
  }
});

test('反例：失败陈述不是完成断言', () => {
  for (const s of [
    'Tests failed: 3 failing.',
    '构建失败，报了 5 个错。',
    'CI 挂了，两个 job 失败。',
    'build failed with 12 errors',
  ]) {
    assert.deepEqual(fams(s), [], `不该认出断言：${s}`);
  }
});

test('反例：提问不是断言（问句不能当成已完成）', () => {
  assert.deepEqual(fams('要不要我再跑一次测试？'), []);
  assert.deepEqual(fams('需要我提交吗？'), []);
});

test('反例：假设 / 未来时态不是断言', () => {
  assert.deepEqual(fams('如果测试通过就告诉我'), []);
  assert.deepEqual(fams('If the build succeeds, I will push.'), []);
  assert.deepEqual(fams('待验证：构建成功与否'), []);
});

test('反例：代码块里的断言不算（那是贴过来的日志）', () => {
  assert.deepEqual(fams('```\n336/336 测试通过\n```'), []);
  assert.deepEqual(fams('```bash\nnpm test\n# 42 tests passed\n```'), []);
});

test('反例：引用块里的断言不算（那是复述别人的结论）', () => {
  assert.deepEqual(fams('> 336/336 测试通过'), []);
  assert.deepEqual(fams('> 构建成功\n\n以上是上一轮的报告。'), []);
});

test('反例：行内代码里的命令不是断言', () => {
  // 实测误报：「两种编译通过的实现」里反引号包着 `if(false)`
  assert.deepEqual(fams('两种 `编译通过` 的实现都能绕过这条断言。'), []);
  assert.deepEqual(fams('我跑的是 `npm test`，不是 `pytest`。'), []);
});

test('反例：N/M 对账不一定是测试（需要测试语汇护航）', () => {
  // 实测误报源：会话 356e31e9 的「18 条线索全部机械比对：18/18 通过，0 条编造」
  assert.deepEqual(fams('18 条线索全部机械比对：**18/18 通过，0 条编造**。'), []);
  assert.deepEqual(fams('6/6 quote 全部验证通过，0 FAIL。'), []);
  // 但带测试语汇的 ratio 仍要认出
  assert.deepEqual(fams('336/336 测试通过'), ['test-count']);
  assert.deepEqual(fams('340/340 单测全绿'), ['test-count']);
});

test('反例：空文本 / 纯工具调用文本不产生断言', () => {
  assert.deepEqual(detectClaims(''), []);
  assert.deepEqual(detectClaims(null), []);
  assert.deepEqual(detectClaims(undefined), []);
});

// ── 3. 基础函数 ──────────────────────────────────────────────────────

test('splitSentences：中文标点与换行都切', () => {
  const s = splitSentences('构建成功。测试通过！没 push\n还有一件事');
  assert.ok(s.length >= 4);
  assert.ok(s.every((x) => x.length > 0));
});

test('stripQuoted：剥掉代码块与引用，保留正文', () => {
  const r = stripQuoted('正文\n```\ncode\n```\n> quote');
  assert.match(r.text, /正文/);
  assert.doesNotMatch(r.text, /code/);
  assert.doesNotMatch(r.text, /quote/);
  assert.equal(r.strippedCode, 1);
});

test('isNegated / isInterrogative / isSpeculative 各司其职', () => {
  assert.equal(isNegated('我没跑测试'), true);
  assert.equal(isNegated('测试通过了'), false);
  assert.equal(isInterrogative('要不要我做？'), true);
  assert.equal(isInterrogative('做完了'), false);
  assert.equal(isSpeculative('如果构建成功'), true);
  assert.equal(isSpeculative('构建成功了'), false);
});

test('claimedCount：能从断言原话里数出数量', () => {
  assert.equal(claimedCount('336/336 测试通过'), 336);
  assert.equal(claimedCount('26 个文件都已同步'), 26);
  assert.equal(claimedCount('全部通过'), null);
});

test('CLAIM_FAMILIES：九个族齐全，且 todos 标为非可核对', () => {
  const ids = CLAIM_FAMILIES.map((f) => f.id);
  for (const id of ['test-count', 'build', 'file-count', 'artifact-hash', 'todos', 'commit', 'push-remote', 'pr-ci', 'runtime-probe']) {
    assert.ok(ids.includes(id), `缺族：${id}`);
  }
  assert.equal(CLAIM_FAMILIES.find((f) => f.id === 'todos').checkable, false);
});

// ── 4. 时间线：四档判定 ──────────────────────────────────────────────

test('SUPPORTED：最后一次编辑之后有成功测试', () => {
  const records = [];
  edit(records, 'src/a.js');
  bash(records, 'node --test', 'ℹ tests 42\nℹ pass 42\nℹ fail 0');
  const ev = findEvidence(records, claim('test-count', '42/42 测试通过'));
  assert.deepEqual(ev.successIndexes.length, 1);
  const v = classifyEvidence({ claim: claim('test-count', '42/42 测试通过'), evidence: ev });
  assert.equal(v.status, 'SUPPORTED');
});

test('STALE_ONLY：先跑过测试，之后又改了文件却没重跑', () => {
  const records = [];
  bash(records, 'node --test', 'ℹ tests 42\nℹ pass 42\nℹ fail 0');
  edit(records, 'src/a.js');
  const ev = findEvidence(records, claim('test-count', '42/42 测试通过'));
  const v = classifyEvidence({ claim: claim('test-count', '42/42 测试通过'), evidence: ev });
  assert.equal(v.status, 'STALE_ONLY');
  assert.match(v.reason, /最后一次编辑之前/);
});

test('FAILED_ONLY：只有失败的测试，没有一次通过', () => {
  const records = [];
  edit(records, 'src/a.js');
  bash(records, 'node --test', 'ℹ tests 42\nℹ pass 40\nℹ fail 2\n2 failing');
  const ev = findEvidence(records, claim('test-count', '42/42 测试通过'));
  assert.equal(ev.successIndexes.length, 0);
  const v = classifyEvidence({ claim: claim('test-count', '42/42 测试通过'), evidence: ev });
  assert.equal(v.status, 'FAILED_ONLY');
});

test('NO_EVIDENCE：整个文件范围内没有任何测试调用', () => {
  const records = [];
  edit(records, 'src/a.js');
  bash(records, 'ls -la', 'a.js\nb.js');
  const ev = findEvidence(records, claim('test-count', '336/336 测试通过'));
  const v = classifyEvidence({ claim: claim('test-count', '336/336 测试通过'), evidence: ev, truncated: false });
  assert.equal(v.status, 'NO_EVIDENCE');
  assert.match(v.reason, /整个文件范围内/);
});

test('截断时同样的空结果判 UNKNOWN，而不是 NO_EVIDENCE', () => {
  const records = [];
  bash(records, 'ls -la', 'a.js');
  const ev = findEvidence(records, claim('test-count', '336/336 测试通过'));
  const v = classifyEvidence({ claim: claim('test-count', '336/336 测试通过'), evidence: ev, truncated: true });
  assert.equal(v.status, 'UNKNOWN');
  assert.notEqual(v.status, 'NO_EVIDENCE');
});

test('截断时若已找到成功证据，仍判 SUPPORTED —— 因为窗口是文件后缀', () => {
  // 这是本检测器最关键的一条推理：成功证据落在这个窗口内，说明它之后的记录也在窗口内，
  // 「之后的编辑」不可能被漏掉。所以截断只影响「什么都没找到」这一种情况。
  const records = [];
  bash(records, 'go test ./...', 'ok  example.com/pkg  0.42s');
  const ev = findEvidence(records, claim('test-count', '全部测试通过'));
  const v = classifyEvidence({ claim: claim('test-count', '全部测试通过'), evidence: ev, truncated: true });
  assert.equal(v.status, 'SUPPORTED');
});

test('is_error 为 true 的调用算失败，不算成功', () => {
  const records = [];
  bash(records, 'npm test', 'npm ERR! missing script', true);
  const ev = findEvidence(records, claim('test-count', '测试通过'));
  assert.equal(ev.successIndexes.length, 0);
  assert.equal(classifyEvidence({ claim: claim('test-count', '测试通过'), evidence: ev }).status, 'FAILED_ONLY');
});

test('退出码 0 但输出含 FAILED 的运行器结果算失败', () => {
  // 很多 runner（maven / gradle）失败也退 0，只能看输出。
  const records = [];
  bash(records, 'mvn -q test', 'Tests run: 42, Failures: 3\nBUILD FAILURE');
  const ev = findEvidence(records, claim('test-count', '42 个测试全部通过'));
  assert.equal(ev.successIndexes.length, 0);
  assert.equal(classifyEvidence({ claim: claim('test-count', '42 个测试全部通过'), evidence: ev }).status, 'FAILED_ONLY');
});

test('成功输出里的「0 failing」不能把成功判成失败', () => {
  const records = [];
  bash(records, 'node --test', 'ℹ tests 42\nℹ pass 42\nℹ fail 0\n0 failing');
  const ev = findEvidence(records, claim('test-count', '42 测试通过'));
  assert.equal(ev.successIndexes.length, 1);
  assert.equal(classifyEvidence({ claim: claim('test-count', '42 测试通过'), evidence: ev }).status, 'SUPPORTED');
});

test('build 与 test-count 的证据互不串味', () => {
  const records = [];
  bash(records, 'npm run build', 'built in 1.2s');
  const testEv = findEvidence(records, claim('test-count', '测试通过'));
  assert.equal(testEv.successIndexes.length, 0, '构建成功不能被当成测试证据');
  const buildEv = findEvidence(records, claim('build', '构建成功'));
  assert.equal(buildEv.successIndexes.length, 1);
});

test('commit：git log / git status 里出现 commit 字样不算提交证据', () => {
  const records = [];
  bash(records, 'git log --oneline -5', '9d665b0 feat: x');
  const ev = findEvidence(records, claim('commit', '已提交'));
  assert.equal(ev.attempts.length, 0);
  assert.equal(classifyEvidence({ claim: claim('commit', '已提交'), evidence: ev, truncated: false }).status, 'NO_EVIDENCE');
});

test('commit：真提交输出才算成功证据', () => {
  const records = [];
  edit(records, 'src/a.js');
  bash(records, 'git commit -m "feat: x"', '[main 9d665b0] feat: x\n 1 file changed');
  const ev = findEvidence(records, claim('commit', '已提交'));
  assert.equal(ev.successIndexes.length, 1);
  assert.equal(classifyEvidence({ claim: claim('commit', '已提交'), evidence: ev }).status, 'SUPPORTED');
});

test('push-remote：包装过的 push（ws-git.cmd push）也认', () => {
  const records = [];
  bash(records, './ws-git.cmd push origin main', 'a32c7d9..d04bed1  main -> main');
  const ev = findEvidence(records, claim('push-remote', '已推到远端'));
  assert.equal(ev.successIndexes.length, 1);
});

test('push-remote：rejected 的 push 不算成功', () => {
  const records = [];
  bash(records, 'git push origin main', '! [rejected] main -> main (fetch first)');
  const ev = findEvidence(records, claim('push-remote', '已推到远端'));
  assert.equal(ev.successIndexes.length, 0);
});

test('file-count：实际写入文件数 >= 声称数才算支持', () => {
  const records = [];
  edit(records, 'a.js'); edit(records, 'b.js'); edit(records, 'c.js');
  const ok = findEvidence(records, claim('file-count', '3 个文件已同步'));
  assert.equal(classifyEvidence({ claim: claim('file-count', '3 个文件已同步'), evidence: ok }).status, 'SUPPORTED');
  const bad = findEvidence(records, claim('file-count', '26 个文件已改动'));
  assert.equal(classifyEvidence({ claim: claim('file-count', '26 个文件已改动'), evidence: bad }).status, 'FAILED_ONLY');
});

test('file-count：说的是「目录里有几个」而不是「我改了几个」时判 UNKNOWN', () => {
  // 实测误报：a495f754 的「这个目录 209 个文件」被当成「我改了 209 个」判成 FAILED_ONLY。
  const records = [];
  edit(records, 'a.js');
  const ev = findEvidence(records, claim('file-count', '目录下只剩 209 个文件，与远端同步'));
  const v = classifyEvidence({ claim: claim('file-count', '目录下只剩 209 个文件，与远端同步'), evidence: ev });
  assert.equal(v.status, 'UNKNOWN');
});

test('push-remote：commit message 里出现 push 不算 push 证据', () => {
  // 实测：84419879 的「已推送」曾因为 `git commit -m "…push…"` 拿到 3 次假成功。
  const records = [];
  bash(records, 'git commit -m "fix: 不要 push 到 main"', '[main abc1234] fix');
  const ev = findEvidence(records, claim('push-remote', '已推送'));
  assert.equal(ev.attempts.length, 0);
});

test('push-remote：静默的 git push -q 成功（无输出、退出码 0）也认', () => {
  const records = [];
  bash(records, 'cd x && git push -q origin main', '');
  const ev = findEvidence(records, claim('push-remote', '已推送'));
  assert.equal(ev.successIndexes.length, 1);
});

test('artifact-hash：hash 在工具输出里出现过才算支持', () => {
  const records = [];
  bash(records, 'sha256sum dist/app.jar', '3f9a1bc4d5e6f7089a1b2c3d4e5f60718293a4b5  dist/app.jar');
  const ev = findEvidence(records, claim('artifact-hash', 'sha256 3f9a1bc4d5e6f7089a1b2c3d4e5f60718293a4b5'));
  assert.ok(ev.detail.hits.length >= 1);
  assert.equal(classifyEvidence({ claim: claim('artifact-hash', 'sha256 3f9a1bc4d5e6f7089a1b2c3d4e5f60718293a4b5'), evidence: ev }).status, 'SUPPORTED');
});

test('UNCHECKABLE：todos 族不参与四档，单列', () => {
  const records = [];
  edit(records, 'a.js');
  const ev = findEvidence(records, claim('todos', '没有待办项了', false));
  const v = classifyEvidence({ claim: claim('todos', '没有待办项了', false), evidence: ev });
  assert.equal(v.status, 'UNCHECKABLE');
  assert.ok(EVIDENCE_STATUS.includes('UNCHECKABLE'));
});

// ── 5. 读取：有界回溯与截断 ──────────────────────────────────────────

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ow-vc-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function writeJsonl(path, records) {
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('readBack：小文件一次读完，不截断', () => {
  withTemp((dir) => {
    const p = join(dir, 's.jsonl');
    writeJsonl(p, [say('hi'), say('done')]);
    const r = readBack(p, { steps: [1024 * 1024], enough: enoughForClaim });
    assert.equal(r.truncated, false);
    assert.equal(r.records.length, 2);
  });
});

test('readBack：大文件用有限步长，触到上限就停并标 truncated', () => {
  withTemp((dir) => {
    const p = join(dir, 's.jsonl');
    // 造一个 ~3 MB 的文件，限制只读 1 MB
    const big = 'x'.repeat(2000);
    const recs = [];
    for (let i = 0; i < 1500; i++) recs.push(say(`${i} ${big}`));
    writeJsonl(p, recs);
    const r = readBack(p, { steps: [1024 * 1024], enough: () => false });
    assert.equal(r.truncated, true);
    assert.ok(r.records.length > 0);
    assert.ok(r.bytesRead <= 1024 * 1024 + 1);
  });
});

test('readBack：一旦 enough 命中就提前收手，不多读', () => {
  withTemp((dir) => {
    const p = join(dir, 's.jsonl');
    const recs = [];
    for (let i = 0; i < 800; i++) recs.push(say(`${i} ${'y'.repeat(1500)}`));
    bash(recs, 'node --test', 'ℹ pass 5\nℹ fail 0');
    for (let i = 0; i < 400; i++) recs.push(say(`${i} tail`));
    writeJsonl(p, recs);
    const r = readBack(p, { steps: [256 * 1024, 1024 * 1024, 4 * 1024 * 1024], enough: enoughForClaim });
    // 成功测试在尾部 400 条之前，1 MB 窗口应该已经能看到它
    assert.ok(r.bytesRead <= 256 * 1024 + 1024 * 1024);
  });
});

test('scanSession：截断 + 空证据 → UNKNOWN（端到端）', () => {
  withTemp((dir) => {
    const p = join(dir, 'abc.jsonl');
    const big = 'z'.repeat(1200);
    const recs = [];
    for (let i = 0; i < 2000; i++) recs.push(say(`${i} ${big}`));
    // 末尾是断言，但整段窗口里没有任何测试调用
    recs.push(say('336/336 测试通过，全部绿。'));
    writeJsonl(p, recs);
    const row = scanSession({ path: p, project: 'p', sessionId: 'abc', mtimeMs: Date.now(), size: 3e6 }, { backtrack: 256 * 1024 });
    assert.equal(row.truncated, true);
    assert.equal(row.results.length, 1);
    assert.equal(row.results[0].status, 'UNKNOWN');
  });
});

test('scanSession：无断言时不回溯（性能纪律）', () => {
  withTemp((dir) => {
    const p = join(dir, 'abc.jsonl');
    const recs = [];
    for (let i = 0; i < 100; i++) recs.push(say(`第 ${i} 条无所谓的话`));
    writeJsonl(p, recs);
    const row = scanSession({ path: p, project: 'p', sessionId: 'abc', mtimeMs: Date.now(), size: 1e5 }, { backtrack: 24 * 1024 * 1024 });
    assert.equal(row.backtracked, undefined);
    assert.equal(row.results.length, 0);
    assert.equal(row.bytesRead, CLAIM_TAIL_BYTES);
  });
});

test('lastAssistantText：取最后一条有文本的 assistant，跳过纯工具块', () => {
  const records = [say('第一句'), say('最后一句'), call('Read', { file_path: 'x' })];
  assert.equal(lastAssistantText(records), '最后一句');
  assert.equal(lastAssistantText([]), '');
});

test('buildEvidenceIndex：tool_result 用 tool_use_id 配回调用', () => {
  const records = [];
  bash(records, 'ls', 'a.js');
  const idx = buildEvidenceIndex(records);
  assert.equal(idx.shell.length, 1);
  assert.equal(idx.shell[0].cmd, 'ls');
  assert.equal(idx.records.length, records.length);
});

// ── 6. 汇总 ──────────────────────────────────────────────────────────

test('summarizeClaims：四档计数、会话级去重、NO_EVIDENCE 清单', () => {
  const rows = [
    { sessionId: 's1', project: 'p', sizeMB: 1, bytesRead: 100, truncated: false, results: [
      { claim: claim('test-count', 'q'), status: 'NO_EVIDENCE' },
    ] },
    { sessionId: 's2', project: 'p', sizeMB: 1, bytesRead: 100, truncated: false, results: [
      { claim: claim('build', 'q'), status: 'SUPPORTED' },
      { claim: claim('test-count', 'q'), status: 'SUPPORTED' },
    ] },
    { sessionId: 's3', project: 'p', sizeMB: 1, bytesRead: 100, truncated: true, results: [] },
  ];
  const s = summarizeClaims(rows);
  assert.equal(s.sessions, 3);
  assert.equal(s.sessionsWithClaims, 2);
  assert.equal(s.claims, 3);
  assert.equal(s.byStatus.SUPPORTED, 2);
  assert.equal(s.byStatus.NO_EVIDENCE, 1);
  assert.equal(s.truncatedSessions, 1);
  assert.equal(s.bytesRead, 300);
  assert.equal(s.noEvidence.length, 1);
  assert.equal(s.noEvidence[0].sessionId, 's1');
});

test('summarizeClaims：空输入不炸', () => {
  const s = summarizeClaims([]);
  assert.equal(s.sessions, 0);
  assert.equal(s.claims, 0);
  assert.deepEqual(s.noEvidence, []);
});

// ── 8. 命令归一化与语义过滤（实测踩出来的坑，全部留成回归） ────────

test('normalizeCommand：剥掉 heredoc 正文与 echo 实参', () => {
  const c = 'cd x && cat > run-tests.sh <<\'EOF\'\nnpm test\nEOF';
  assert.doesNotMatch(normalizeCommand(c), /npm test/);
  const e = 'echo "=== gradlew.bat 使用 ===" ; ls';
  assert.doesNotMatch(normalizeCommand(e), /gradlew\.bat/);
});

test('normalizeCommand：引号里的命令串要保留，引号里的路径压成 basename', () => {
  assert.match(normalizeCommand('powershell -Command "npm test"'), /npm test/);
  assert.match(normalizeCommand('"D:/maven/apache-maven-3.9.9/bin/mvn.cmd" clean verify'), /mvn\.cmd/);
  assert.doesNotMatch(normalizeCommand('"D:/maven/apache-maven-3.9.9/bin/mvn.cmd" clean verify'), /apache-maven/);
});

test('isTestCommand：maven 动词离可执行文件很远也认（本机真实形态）', () => {
  assert.equal(isTestCommand('export JAVA_HOME="/d/j" && "D:/maven/apache-maven-3.9.9/bin/mvn.cmd" -f "D:/a/b/pom.xml" clean verify'), true);
  assert.equal(isTestCommand('cd x && ./gradlew :FCL:testReleaseUnitTest --console=plain'), true);
  assert.equal(isTestCommand('cd x && node --test scripts/*.test.mjs'), true);
});

test('isTestCommand：-DskipTests 的构建不是测试证据', () => {
  assert.equal(isTestCommand('mvn clean package -DskipTests'), false);
  assert.equal(isTestCommand('mvn -Dmaven.test.skip=true package'), false);
  assert.equal(isTestCommand('mvn clean verify'), true);
});

test('isTestCommand：只在打印/搜索 test 字样的命令不算', () => {
  assert.equal(isTestCommand('echo "=== 我的 target_files ===" && git diff --name-only | grep -v "R29CopyDeferTest"'), false);
  assert.equal(isTestCommand('grep -n "selftest" prototypes/_build/check-docs.mjs'), false);
  assert.equal(isTestCommand('node selftest.js'), true);
});

test('isBuildCommand：资源编译也算构建', () => {
  assert.equal(isBuildCommand('cd x && timeout 600 ./gradlew :FCL:processDebugResources --offline'), true);
  assert.equal(isBuildCommand('mvn clean compile'), true);
  assert.equal(isBuildCommand('echo done'), false);
});

test('isMutatingCommand：只有真改工作区才算，搬运产物/写临时文件不算', () => {
  assert.equal(isMutatingCommand('sed -i s/a/b/ src/A.java'), true);
  assert.equal(isMutatingCommand('cd x && cp /tmp/pom.bak pom.xml'), true);
  assert.equal(isMutatingCommand('cd x && cat >> src/a.test.mjs << EOF\nx\nEOF'), true);
  assert.equal(isMutatingCommand('cd x && cp target/x.jar versions/'), false);
  assert.equal(isMutatingCommand('cd x && cp src/a.mjs /tmp/a.bak'), false);
  assert.equal(isMutatingCommand('cd x && cat > /tmp/msg.txt << EOF\nhi\nEOF'), false);
  assert.equal(isMutatingCommand('cd x && rm -rf .ci-artifacts'), false);
  assert.equal(isMutatingCommand('cd x && node --test'), false);
});

test('editKindOf：源码/文档分开，改文档不作废测试证据', () => {
  assert.equal(editKindOf('src/a.mjs'), 'code');
  assert.equal(editKindOf('pom.xml'), 'code');
  assert.equal(editKindOf('CHANGELOG.md'), 'doc');
  assert.equal(editKindOf('README-EN.md'), 'doc');
  assert.equal(editKindOf(''), 'unknown');
});

test('后台任务不算成功证据（本检测器自己不能说谎）', () => {
  const records = [];
  bash(records, 'node --test', 'Command running in background with ID: bilark1ou. Output is being written to: ...');
  const ev = findEvidence(records, claim('test-count', '全部通过'));
  assert.equal(ev.successIndexes.length, 0);
  assert.equal(ev.attempts.length, 1);
  // 后台执行既不是成功也不是失败：没有退出码。判 UNKNOWN 才诚实。
  const v = classifyEvidence({ claim: claim('test-count', '全部通过'), evidence: ev, truncated: false });
  assert.equal(v.status, 'UNKNOWN');
  assert.match(v.reason, /后台/);
  assert.notEqual(v.status, 'FAILED_ONLY');
  assert.notEqual(v.status, 'NO_EVIDENCE');
});

test('isMutatingCommand：产物归档不算源码改动（实测把 SUPPORTED 判成 STALE 的原因）', () => {
  assert.equal(isMutatingCommand('cd x && cp target/HilltopVillage.jar versions/'), false);
  assert.equal(isMutatingCommand('cd x && cp versions/*.jar backups/versions-2026/'), false);
  assert.equal(isMutatingCommand('cd x && cp src/main/java/A.java src/main/java/B.java'), true);
});

test('STALE_ONLY 不因「最后一步写了 CHANGELOG」而误判', () => {
  const records = [];
  edit(records, 'src/a.js');
  bash(records, 'node --test', 'ℹ pass 5\nℹ fail 0');
  edit(records, 'CHANGELOG.md');
  edit(records, 'README.md');
  const ev = findEvidence(records, claim('test-count', '5 测试通过'));
  assert.equal(classifyEvidence({ claim: claim('test-count', '5 测试通过'), evidence: ev }).status, 'SUPPORTED');
});

test('STALE_ONLY 仍会因「最后一步改了源码」而触发', () => {
  const records = [];
  bash(records, 'node --test', 'ℹ pass 5\nℹ fail 0');
  edit(records, 'src/a.js');
  const ev = findEvidence(records, claim('test-count', '5 测试通过'));
  assert.equal(classifyEvidence({ claim: claim('test-count', '5 测试通过'), evidence: ev }).status, 'STALE_ONLY');
});

test('shell 写文件也进时间线：sed -i 之后没重跑 → STALE_ONLY', () => {
  const records = [];
  bash(records, 'node --test', 'ℹ pass 5\nℹ fail 0');
  bash(records, 'sed -i s/a/b/ src/A.java', '');
  const ev = findEvidence(records, claim('test-count', '5 测试通过'));
  assert.equal(classifyEvidence({ claim: claim('test-count', '5 测试通过'), evidence: ev }).status, 'STALE_ONLY');
});

// ── 回归：shell 编辑的 kind 必须按「实际写入目标」判 ──────────────────
//
// 曾经的实现是 `/\.(?:[a-z0-9]+)\b/i.test(cmd) ? 'unknown' : 'code'`，两边都不给 'doc'，
// 而时间线把「非 doc」一律当源码 —— 于是任何被 isMutatingCommand 放行的 shell 写入
// 都会作废之前的测试证据。实测把两次真的 SUPPORTED 判成 STALE_ONLY：
//   bdf7a413：`cp versions/*.jar backups/…` 归档产物
//   9daa6a00：Edit 了 `.gitignore`（`gitignore` 不在扩展名表里 → unknown → 当源码）

test('回归：jar 归档（cp 到 backups/）不作废测试证据 → SUPPORTED', () => {
  const records = [];
  edit(records, 'src/main/java/A.java');
  bash(records, 'mvn clean test', 'Tests run: 94, Failures: 0\nBUILD SUCCESS');
  bash(records, 'cd "P/Hilltop Village" && mkdir -p backups/versions-2026 && cp "P/versions/"*.jar backups/versions-2026/ && sha256sum *.jar > SHA256SUMS.txt', '');
  const ev = findEvidence(records, claim('test-count', '94 个测试全绿'));
  const v = classifyEvidence({ claim: claim('test-count', '94 个测试全绿'), evidence: ev });
  assert.equal(v.status, 'SUPPORTED', v.reason);
});

test('回归：写 .gitignore 不作废测试证据 → SUPPORTED', () => {
  const records = [];
  edit(records, 'src/main/java/A.java');
  bash(records, 'mvn clean test', 'Tests run: 64, Failures: 0\nBUILD SUCCESS');
  edit(records, '.gitignore');
  const ev = findEvidence(records, claim('test-count', '69 个测试全绿'));
  const v = classifyEvidence({ claim: claim('test-count', '69 个测试全绿'), evidence: ev });
  assert.equal(v.status, 'SUPPORTED', v.reason);
});

test('回归：shell 写真正的源码仍然触发 STALE_ONLY（修复不能把判据放宽掉）', () => {
  const records = [];
  bash(records, 'node --test', 'ℹ pass 5\nℹ fail 0');
  bash(records, 'cd x && cp /tmp/A.bak src/main/java/A.java', '');
  const ev = findEvidence(records, claim('test-count', '5 测试通过'));
  const v = classifyEvidence({ claim: claim('test-count', '5 测试通过'), evidence: ev });
  assert.equal(v.status, 'STALE_ONLY', v.reason);
});

test('回归：shell 重定向写文档不作废测试证据 → SUPPORTED', () => {
  const records = [];
  bash(records, 'node --test', 'ℹ pass 5\nℹ fail 0');
  bash(records, 'cd x && cat > docs/REPORT.md << EOF\nok\nEOF', '');
  const ev = findEvidence(records, claim('test-count', '5 测试通过'));
  const v = classifyEvidence({ claim: claim('test-count', '5 测试通过'), evidence: ev });
  assert.equal(v.status, 'SUPPORTED', v.reason);
});

test('editKindOf：仓库配置点文件当文档，无扩展名仍当源码', () => {
  assert.equal(editKindOf('.gitignore'), 'doc');
  assert.equal(editKindOf('sub/dir/.gitignore'), 'doc');
  assert.equal(editKindOf('.gitattributes'), 'doc');
  assert.equal(editKindOf('.editorconfig'), 'doc');
  assert.equal(editKindOf('Makefile'), 'code');
  assert.equal(editKindOf('gradlew'), 'code');
});

// ── 回归：`N failures=0` 不是失败 ────────────────────────────────────
//
// 旧正则 `\b[1-9]\d*\s+(?:failing|failed|failures?|errors?)\b` 会把
// `tests=29 failures=0` 里的「29 failures」当成 29 个失败（实测 36b92630：
// 一次真的 BUILD SUCCESS 被记成了失败调用，成功证据里少了一条）。

test('回归：`tests=29 failures=0` 不是失败，`2 failing` 是', () => {
  assert.equal(FAIL_OUTPUT_RE.test('tests=29 failures=0 errors=0'), false);
  assert.equal(FAIL_OUTPUT_RE.test('BUILD=0 tests=29 failures=0'), false);
  assert.equal(FAIL_OUTPUT_RE.test('7 passed, 0 failed'), false);
  assert.equal(FAIL_OUTPUT_RE.test('requested: 42 failures: 0'), false);
  assert.equal(FAIL_OUTPUT_RE.test('2 failing'), true);
  assert.equal(FAIL_OUTPUT_RE.test('Tests run: 5, Failures: 3'), true);
  assert.equal(FAIL_OUTPUT_RE.test('12 failures'), true);
  assert.equal(FAIL_OUTPUT_RE.test('BUILD FAILURE'), true);
});

test('回归：`failures=0` 的输出被记成成功调用（不再产生假失败证据）', () => {
  const records = [];
  edit(records, 'src/A.java');
  bash(records, 'mvn -q clean package', 'BUILD=0 tests=29 failures=0 errors=0');
  const ev = findEvidence(records, claim('build', 'BUILD SUCCESS'));
  assert.equal(ev.failureIndexes.length, 0, '不应把 failures=0 记成失败');
  assert.equal(ev.successIndexes.length, 1);
});

test('enoughForClaim / enoughForClaims / evidenceSufficient 的口径', () => {
  const hit = [];
  bash(hit, 'node --test', 'ℹ pass 1\nℹ fail 0');
  assert.equal(enoughForClaim(hit), true);
  const miss = [];
  bash(miss, 'ls', 'a');
  assert.equal(enoughForClaim(miss), false);
  assert.equal(evidenceSufficient(buildEvidenceIndex(hit), claim('test-count', 'q')), true);
  assert.equal(evidenceSufficient(buildEvidenceIndex(hit), claim('build', 'q')), false);
  assert.equal(enoughForClaims(hit, [claim('test-count', 'q')]), true);
  assert.equal(enoughForClaims(hit, [claim('test-count', 'q'), claim('build', 'q')]), false);
});

test('resultText：字符串、block 数组、对象三种形态都能取文本', () => {
  assert.equal(resultText({ content: 'abc' }), 'abc');
  assert.equal(resultText({ content: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }] }), 'x\ny');
  assert.equal(resultText({ content: { text: 'z' } }), 'z');
  assert.equal(resultText(null), '');
});

test('readSlice / parseLines：坏行丢弃，不抛', () => {
  assert.deepEqual(readSlice('/nonexistent', 0, 10), { text: '', truncated: false, size: 0 });
  const recs = parseLines('{"a":1}\nnot json\n{"b":2}');
  assert.equal(recs.length, 2);
});

test('subagentFiles：不存在的会话返回空数组', () => {
  assert.deepEqual(subagentFiles({ path: '/nonexistent/x.jsonl' }), []);
});

test('常量：编辑工具与 shell 工具清单稳定，扩展名分类不重叠', () => {
  assert.ok(EDIT_TOOLS.includes('Edit') && EDIT_TOOLS.includes('Write'));
  assert.ok(SHELL_TOOLS.includes('Bash') && SHELL_TOOLS.includes('PowerShell'));
  for (const e of DOC_EXTS) assert.ok(!CODE_EXTS.includes(e), `${e} 同时被当成源码和文档`);
  assert.match('-DskipTests', SKIP_TESTS_RE);
});

// ── 7. 常量与默认值 ──────────────────────────────────────────────────
test('回溯步长单调递增且不超过默认上限', () => {
  assert.deepEqual([...BACKTRACK_STEPS], [...BACKTRACK_STEPS].sort((a, b) => a - b));
  assert.ok(BACKTRACK_STEPS.at(-1) <= DEFAULT_BACKTRACK_BYTES);
  assert.ok(DEFAULT_BACKTRACK_BYTES > CLAIM_TAIL_BYTES);
});

test('listSessions：不存在的根目录返回空数组；--days 按 mtime 过滤', () => {
  assert.deepEqual(listSessions('/nonexistent'), []);
  withTemp((dir) => {
    const proj = join(dir, 'proj');
    mkdirSync(proj, { recursive: true });
    writeJsonl(join(proj, 'fresh.jsonl'), [say('新')]);
    writeJsonl(join(proj, 'old.jsonl'), [say('旧')]);
    const old = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(join(proj, 'old.jsonl'), old, old);
    assert.equal(listSessions(dir).length, 2);
    assert.equal(listSessions(dir, { days: 3 }).length, 1);
    assert.equal(listSessions(dir, { days: 3 })[0].sessionId, 'fresh');
  });
});
