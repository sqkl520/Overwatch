#!/usr/bin/env node
/**
 * claim-ledger.test.mjs — 产出对账的回归测试。
 *
 * 这些测试守的不是格式，是五个**必须能区分的场景**（派单里逐条点名的那五个）：
 *   1. 产出了文件但没报告 → UNREPORTED（靠 observe/磁盘，不靠自述）
 *   2. 报告了但文件不存在 → MISSING
 *   3. 产出了一半就死了 → PARTIAL（不是 EMPTY，也不是 COMPLETE）
 *   4. 两个 agent 写同一个文件 → CONFLICT（先于一切，因为「两个都成功」最坏）
 *   5. 主线程崩溃后重启 → adopt 能列出未认领的产出
 *
 * 另加两条纪律测试：
 *   - 静默时长**不得**被当成失败（state-model §2.0.1）
 *   - 空台账**不得**被当成「全部完成」
 *
 * 全部用注入的 `probe` 与临时目录，不读真实 transcript、不写仓库以外的路径。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  makeExpect, makeClaim, makeObserve, makeConsume, reconcile, foldRows,
  formatReport, ledgerPath, readLedger, appendRows, makeNonce, findNonce,
  observedWrites, compareClaim, probeDisk, sha256File, subagentTranscriptsOf,
  collectSubagentTranscripts, readHeadText, TASK_VERDICT, FAILING_VERDICTS,
  ITEM_STATUS, WRITE_TOOLS, pathKey, resolvePath, nonceOwners, LEDGER_FILE,
  bashWrites, bashWriteScan, observedWriteScan,
} from './claim-ledger.mjs';

// ── 夹具 ──────────────────────────────────────────────────────────────

const tmp = () => mkdtempSync(join(tmpdir(), 'ow-claim-'));

/** 每个测试自己构造磁盘状态：`{ 'a.md': {size, mtimeMs, sha256} }`。
 *  注入 probe 的意义：测试不该依赖真实文件系统的 mtime 精度（Windows 上尤其粗糙）。 */
const probeOf = (files) => (p) => {
  const f = files[p];
  if (!f) return { exists: false };
  return { exists: true, size: f.size, mtimeMs: f.mtimeMs || 0, sha256: f.sha256 || null, hashTruncated: f.hashTruncated === true };
};

const at = (iso) => Date.parse(iso);

// ── 场景 1：产出了文件但没报告 ────────────────────────────────────────

test('产出了文件但没人自述 → UNREPORTED（不判 COMPLETE，也不判 EMPTY）', () => {
  const rows = [makeExpect({ run: 'r', task: 'ST1', paths: ['a.md'] })];
  const r = reconcile({ rows, probe: probeOf({ 'a.md': { size: 10, sha256: 'abc' } }) });
  assert.equal(r.tasks[0].verdict, 'UNREPORTED');
  assert.equal(r.tasks[0].items[0].status, 'UNREPORTED');
  assert.equal(r.summary.ok, false);
  assert.ok(FAILING_VERDICTS.includes('UNREPORTED'));
});

test('transcript 有 Write 痕迹但文件不在 → ABSENT 且理由指向失败调用', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['a.md'] }),
    makeObserve({ run: 'r', task: 'ST1', path: 'a.md', failed: true, evidence: 'agent-x.jsonl#7' }),
  ];
  const r = reconcile({ rows, probe: probeOf({}) });
  assert.equal(r.tasks[0].items[0].status, 'ABSENT');
  assert.match(r.tasks[0].items[0].why, /报了错/);
  assert.equal(r.tasks[0].verdict, 'EMPTY');
});

// ── 场景 2：报告了但文件不存在 ────────────────────────────────────────

test('自述说写了、磁盘没有 → MISSING（不是 UNREPORTED）', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['a.md'] }),
    makeClaim({ run: 'r', task: 'ST1', path: 'a.md', disk: { exists: true, size: 10, mtimeMs: 1, sha256: 'abc' } }),
  ];
  const r = reconcile({ rows, probe: probeOf({}) });
  assert.equal(r.tasks[0].items[0].status, 'MISSING');
  assert.equal(r.tasks[0].verdict, 'MISSING');
});

test('自述之后文件被改过 → DRIFTED，理由点明时间方向', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['a.md'] }),
    makeClaim({ run: 'r', task: 'ST1', path: 'a.md', disk: { exists: true, size: 10, mtimeMs: 1, sha256: 'aaa' } }),
  ];
  const r = reconcile({ rows, probe: probeOf({ 'a.md': { size: 10, sha256: 'bbb' } }) });
  assert.equal(r.tasks[0].items[0].status, 'DRIFTED');
  assert.match(r.tasks[0].items[0].why, /自述之后被改过/);
});

test('hash 一致且未截断 → OK 且任务 COMPLETE', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['a.md'] }),
    makeClaim({ run: 'r', task: 'ST1', path: 'a.md', disk: { exists: true, size: 10, mtimeMs: 1, sha256: 'aaa' } }),
  ];
  const r = reconcile({ rows, probe: probeOf({ 'a.md': { size: 10, sha256: 'aaa' } }) });
  assert.equal(r.tasks[0].items[0].status, 'OK');
  assert.equal(r.tasks[0].verdict, 'COMPLETE');
});

test('任一侧 hash 截断 → OK_WEAK，不许升级成 OK', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['a.md'] }),
    makeClaim({ run: 'r', task: 'ST1', path: 'a.md', disk: { exists: true, size: 10, sha256: 'aaa', hashTruncated: true } }),
  ];
  const r = reconcile({ rows, probe: probeOf({ 'a.md': { size: 10, sha256: 'aaa' } }) });
  assert.equal(r.tasks[0].items[0].status, 'OK_WEAK');
});

test('自述没带 hash → 只比字节数，且标为弱证据', () => {
  const cmp = compareClaim({ bytes: 10 }, { exists: true, size: 10, sha256: 'x' });
  assert.equal(cmp.ok, true);
  assert.equal(cmp.weak, true);
  const bad = compareClaim({ bytes: 11 }, { exists: true, size: 10, sha256: 'x' });
  assert.equal(bad.ok, false);
});

// ── 场景 3：产出一半就死了 ────────────────────────────────────────────

test('一半落地一半没落地 → PARTIAL（不是 EMPTY）', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['a.md', 'b.md'] }),
    makeClaim({ run: 'r', task: 'ST1', path: 'a.md', disk: { exists: true, size: 1, mtimeMs: 1, sha256: 'aaa' } }),
  ];
  const r = reconcile({ rows, probe: probeOf({ 'a.md': { size: 1, sha256: 'aaa' } }) });
  assert.equal(r.tasks[0].verdict, 'PARTIAL');
  const st = Object.fromEntries(r.tasks[0].items.map((i) => [i.path, i.status]));
  assert.equal(st['a.md'], 'OK');
  assert.equal(st['b.md'], 'ABSENT');
});

test('一个都没落地、也没人自述 → EMPTY（与 PARTIAL 必须分开）', () => {
  const rows = [makeExpect({ run: 'r', task: 'ST1', paths: ['a.md', 'b.md'] })];
  const r = reconcile({ rows, probe: probeOf({}) });
  assert.equal(r.tasks[0].verdict, 'EMPTY');
});

test('全部落地但有一个 MISSING → PARTIAL 之上取 MISSING', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['a.md', 'b.md'] }),
    makeClaim({ run: 'r', task: 'ST1', path: 'a.md', disk: { exists: true, size: 1, mtimeMs: 1, sha256: 'aa' } }),
    makeClaim({ run: 'r', task: 'ST1', path: 'b.md', disk: { exists: true, size: 1, mtimeMs: 1, sha256: 'bb' } }),
  ];
  const r = reconcile({ rows, probe: probeOf({ 'a.md': { size: 1, sha256: 'aa' } }) });
  assert.equal(r.tasks[0].verdict, 'PARTIAL', '一个 OK 一个 MISSING 是部分完成');
});

// ── 场景 4：两个 agent 写同一个文件 ──────────────────────────────────

test('两个任务声明同一路径 → CONFLICT，且先于 COMPLETE 判定', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['shared.md'] }),
    makeExpect({ run: 'r', task: 'ST2', paths: ['shared.md'] }),
    makeClaim({ run: 'r', task: 'ST1', path: 'shared.md', disk: { exists: true, size: 1, mtimeMs: 1, sha256: 'aa' } }),
    makeClaim({ run: 'r', task: 'ST2', path: 'shared.md', disk: { exists: true, size: 1, mtimeMs: 1, sha256: 'aa' } }),
  ];
  const r = reconcile({ rows, probe: probeOf({ 'shared.md': { size: 1, sha256: 'aa' } }) });
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0].tasks, ['ST1', 'ST2']);
  assert.equal(r.tasks.every((t) => t.verdict === 'CONFLICT'), true);
  assert.match(formatReport(r), /撞车/);
});

test('只被一个任务「自述」、另一个只「声明」也算冲突', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['x.md'] }),
    makeExpect({ run: 'r', task: 'ST2', paths: ['y.md'] }),
    makeClaim({ run: 'r', task: 'ST2', path: 'x.md', disk: { exists: true, size: 1, mtimeMs: 1, sha256: 'a' } }),
  ];
  const r = reconcile({ rows, probe: probeOf({ 'x.md': { size: 1, sha256: 'a' } }) });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.tasks.find((t) => t.task === 'ST1').verdict, 'CONFLICT');
});

// ── 场景 5：主线程崩溃后重启 ──────────────────────────────────────────

test('认领状态：无 consume → consumed=false，有 consume → true', () => {
  const base = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['a.md'] }),
    makeClaim({ run: 'r', task: 'ST1', path: 'a.md', disk: { exists: true, size: 1, mtimeMs: 1, sha256: 'a' } }),
  ];
  const p = probeOf({ 'a.md': { size: 1, sha256: 'a' } });
  const before = reconcile({ rows: base, probe: p });
  assert.equal(before.tasks[0].consumed, false);
  assert.equal(before.summary.unclaimed, 1);
  assert.equal(before.summary.ok, false, '产出完整但未认领，不能算通过');

  const after = reconcile({ rows: [...base, makeConsume({ run: 'r', task: 'ST1' })], probe: p });
  assert.equal(after.tasks[0].consumed, true);
  assert.equal(after.summary.ok, true);
});

test('按单路径认领只覆盖一个路径', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['a.md', 'b.md'] }),
    makeConsume({ run: 'r', task: 'ST1', path: 'a.md' }),
  ];
  const r = reconcile({ rows, probe: probeOf({}) });
  assert.equal(r.tasks[0].consumed, false);
});

// ── 纪律：静默不是失败 ────────────────────────────────────────────────

test('静默不构成失败判据，只标 quiet', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['a.md'], timeoutMin: 8 }),
    makeClaim({ run: 'r', task: 'ST1', path: 'a.md', disk: { exists: true, size: 1, mtimeMs: at('2026-01-01T00:00:00Z'), sha256: 'a' } }),
    makeConsume({ run: 'r', task: 'ST1' }),
  ];
  // claim 行会带 ts（appendRows 才加；这里手工造行没有 ts，所以用磁盘 mtime 当末次证据）
  const rowsWithTs = rows.map((x) => (x.kind === 'claim' ? { ...x, ts: '2026-01-01T00:00:00.000Z' } : x));
  const r = reconcile({
    rows: rowsWithTs,
    probe: () => ({ exists: true, size: 1, mtimeMs: at('2026-01-01T00:00:00Z'), sha256: 'a' }),
    nowMs: at('2026-01-01T05:00:00Z'),
  });
  const t = r.tasks[0];
  assert.equal(t.quiet, true);
  assert.equal(t.silentMin, 300);
  assert.equal(t.verdict, 'COMPLETE', '静默 5 小时但产出在、已认领 → 仍然是 COMPLETE');
  assert.equal(r.summary.ok, true);
});

test('没有任何产出痕迹时 silentMin 为 null，不编一个数字', () => {
  const rows = [makeExpect({ run: 'r', task: 'ST1', paths: ['a.md'] })];
  const r = reconcile({ rows, probe: probeOf({}) });
  assert.equal(r.tasks[0].silentMin, null);
  assert.match(formatReport(r), /无任何产出痕迹/);
});

// ── 纪律：空台账不等于通过 ────────────────────────────────────────────

test('台账为空 → summary.ok=false，且报告明说「没登记过期望」', () => {
  const r = reconcile({ rows: [] });
  assert.equal(r.summary.total, 0);
  assert.equal(r.summary.ok, false);
  assert.match(formatReport(r), /不是「全部完成」/);
});

test('声明了任务但没声明路径 → NO-EXPECTATION（规划缺陷）', () => {
  const rows = [makeExpect({ run: 'r', task: 'ST1', paths: [] })];
  const r = reconcile({ rows, probe: probeOf({}) });
  assert.equal(r.tasks[0].verdict, 'NO-EXPECTATION');
  assert.ok(FAILING_VERDICTS.includes('NO-EXPECTATION'));
});

// ── 期望之外 / 多任务隔离 ────────────────────────────────────────────

test('transcript 里写了期望外的路径 → extras（信息项，不改判定）', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['a.md'] }),
    makeClaim({ run: 'r', task: 'ST1', path: 'a.md', disk: { exists: true, size: 1, mtimeMs: 1, sha256: 'a' } }),
    makeConsume({ run: 'r', task: 'ST1' }),
    makeObserve({ run: 'r', task: 'ST1', path: 'side-effect.log' }),
  ];
  const r = reconcile({ rows, probe: probeOf({ 'a.md': { size: 1, sha256: 'a' } }) });
  assert.equal(r.tasks[0].verdict, 'COMPLETE');
  assert.equal(r.extras.length, 1);
  assert.equal(r.extras[0].path, 'side-effect.log');
});

test('两个任务各自的产出互不干扰', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['a.md'] }),
    makeExpect({ run: 'r', task: 'ST2', paths: ['b.md'] }),
    makeClaim({ run: 'r', task: 'ST1', path: 'a.md', disk: { exists: true, size: 1, mtimeMs: 1, sha256: 'a' } }),
    makeClaim({ run: 'r', task: 'ST2', path: 'b.md', disk: { exists: true, size: 1, mtimeMs: 1, sha256: 'b' } }),
  ];
  const r = reconcile({ rows, probe: probeOf({ 'a.md': { size: 1, sha256: 'a' }, 'b.md': { size: 1, sha256: 'b' } }) });
  assert.equal(r.tasks.length, 2);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.tasks.every((t) => t.verdict === 'COMPLETE'), true);
});

// ── nonce 归属 ────────────────────────────────────────────────────────

test('findNonce 有边界，不许前缀命中', () => {
  assert.equal(findNonce('nonce: abcd1234', ['abcd1234']), 'abcd1234');
  assert.equal(findNonce('nonce: abcd12345', ['abcd1234']), null, 'abcd1234 不应命中 abcd12345 的前缀');
  assert.equal(findNonce('x abcd1234 y', ['ffff', 'abcd1234']), 'abcd1234');
  assert.equal(findNonce('', ['abcd1234']), null);
});

test('makeNonce 恒为 8 位十六进制', () => {
  for (let i = 0; i < 20; i++) assert.match(makeNonce(), /^[0-9a-f]{8}$/);
  assert.equal(makeNonce(() => 0), '00000000');
  assert.equal(makeNonce(() => 0.9999), 'ffffffff');
});

// ── transcript 抽取 ──────────────────────────────────────────────────

const rec = (type, blocks) => ({ type, message: { content: blocks } });
const toolUse = (name, input, id) => ({ type: 'tool_use', name, input, id });
const toolResult = (id, isError = false) => ({ type: 'tool_result', tool_use_id: id, is_error: isError, content: '' });

test('observedWrites 只认写工具，并且读成对的 tool_result 判失败', () => {
  const records = [
    rec('assistant', [toolUse('Write', { file_path: 'a.md' }, 't1')]),
    rec('user', [toolResult('t1')]),
    rec('assistant', [toolUse('Edit', { file_path: 'b.md' }, 't2')]),
    rec('user', [toolResult('t2', true)]),
    rec('assistant', [toolUse('Read', { file_path: 'c.md' }, 't3')]),
    rec('assistant', [toolUse('Bash', { command: 'echo x > d.md' }, 't4')]),
  ];
  const got = observedWrites(records);
  assert.deepEqual(got.map((g) => g.path), ['a.md', 'b.md']);
  assert.equal(got[0].failed, false);
  assert.equal(got[1].failed, true, '失败的 Edit 不构成产出');
  assert.deepEqual([...WRITE_TOOLS], ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
});

test('observedWrites 在没有 cwd 时不猜 Bash 相对路径（宁可漏）', () => {
  const records = [
    rec('assistant', [toolUse('Bash', { command: 'cp a b && echo z > c.txt 2>&1' }, 't1')]),
  ];
  // 没有 cwd 就没有基准目录 —— 两个相对路径都判不出，返回空。
  assert.deepEqual(observedWrites(records), []);
  assert.deepEqual(observedWrites(records, { bash: false }), []);
  // 同一个命令带上 cwd 就能判：`b`（cp 目标）与 `c.txt`（重定向目标）；`2>&1` 不是文件。
  const got = observedWrites(records, { cwd: '/repo' });
  assert.deepEqual(norm(got.map((g) => g.path)), [pathKey('/repo/b'), pathKey('/repo/c.txt')]);
});

test('observedWrites 的 Bash 通道可以用 bash:false 关掉，回到纯写工具行为', () => {
  const records = [
    rec('assistant', [toolUse('Bash', { command: 'echo x > /repo/a.txt' }, 't1')]),
    rec('assistant', [toolUse('Write', { file_path: '/repo/b.md' }, 't2')]),
  ];
  const off = observedWrites(records, { bash: false });
  // 写工具的路径按原样保存（不被解析），Bash 的则是解析后的绝对路径 —— 两者形态不同是有意的。
  assert.deepEqual(off.map((g) => g.path), ['/repo/b.md']);
  const on = observedWrites(records, { cwd: '/repo' });
  assert.deepEqual(norm(on.map((g) => g.path)), [pathKey('/repo/a.txt'), pathKey('/repo/b.md')]);
  assert.deepEqual(on.map((g) => g.source).sort(), ['bash', 'write-tool']);
});

test('observedWrites 容忍空输入与坏记录', () => {
  assert.deepEqual(observedWrites([]), []);
  assert.deepEqual(observedWrites([null, {}, { type: 'assistant' }, { type: 'assistant', message: {} }]), []);
});

// ── Bash 写入识别：只在路径可确定时 ────────────────────────────────────
//
// 这一组守的是一条**方向性**约束：宁可漏，不可误判。
// 理由写在源码里，这里用测试把它固定住 —— 误判的代价是让人不再相信整个工具，
// 而漏检的代价只是「这一条没看见」，后者在报告里是可数的。

/** 归一化到「同一平台的同一文件」：`bashWrites` 返回的是绝对路径，
 *  测试用同一套 `resolve` 算期望，避免手写 `\` 与 `/` 的差异。 */
const norm = (arr) => arr.map((p) => pathKey(p)).sort();
const at2 = (cwd, rel) => [pathKey(rel, cwd)]; // 期望值

const CWD = '/repo';

test('bashWrites 正例：重定向 / heredoc / cp / cd 前缀 / fd 重定向', () => {
  assert.deepEqual(norm(bashWrites('echo hello > out.txt', CWD)), at2(CWD, 'out.txt'));
  assert.deepEqual(
    norm(bashWrites("cat > report.md <<'EOF'\n# title\nthis line has > and EOF-ish text\nEOF", CWD)),
    at2(CWD, 'report.md'),
  );
  // cp 的目标是产出；源不是
  assert.deepEqual(norm(bashWrites('cp src/a.txt dst/b.txt', CWD)), at2(CWD, 'dst/b.txt'));
  // cd 之后相对路径以 cd 的目标为基准
  assert.deepEqual(norm(bashWrites('cd sub && echo x > y.txt', CWD)), at2(CWD, 'sub/y.txt'));
  // `2>` 是 stderr 重定向，目标照样是产出
  assert.deepEqual(norm(bashWrites('cmd 2> err.log', CWD)), at2(CWD, 'err.log'));
  // 追加与 &> 同属写入
  assert.deepEqual(norm(bashWrites('echo a >> out.txt', CWD)), at2(CWD, 'out.txt'));
  assert.deepEqual(norm(bashWrites('cmd &> both.log', CWD)), at2(CWD, 'both.log'));
  // tee / mv
  assert.deepEqual(norm(bashWrites('echo x | tee logs/app.log', CWD)), at2(CWD, 'logs/app.log'));
  assert.deepEqual(norm(bashWrites('mv old.txt new.txt', CWD)), at2(CWD, 'new.txt'));
});

test('bashWrites 反例：变量 / 只读 / 临时位置 / 动态 cd / find -exec 一律返回空', () => {
  for (const cmd of [
    'echo x > $OUT',
    'echo x > "${DIR}/y.txt"',
    'cat file.txt',                       // 只读
    'ls -la',                             // 只读
    'ls -la > /dev/null',                 // 写的是黑洞，不是产出
    'cd $DIR && echo x > y.txt',          // cd 动态 → 整条放弃
    'cd $(mktemp -d) && echo x > y.txt',  // 同上
    "find . -name '*.txt' -exec rm {} \\;",
    'find . -name "*.txt" -exec sed -i s/a/b/ {} \\;',
    'echo x > *.log',                     // 通配
    'echo x > ~/notes.md',                // 需要展开
    'cat > /tmp/probe.java <<EOF\nclass A{}\nEOF', // 临时位置：判得出，但那是探针
    'echo hi 2>&1',                       // fd 复制，不是文件
    'sh -c "echo x > y.txt"',             // 命令在字符串里
    'xargs cp -t out < list.txt',         // 目标目录动态
    'cp a b c d',                         // 多源：目标是文件还是目录判不出
    'cp src dst/',                        // 目标以 / 结尾，真名取决于源
    'cp -t dst a b',                      // -t 把 dir 当目标，文件名判不出
    '',
    '   ',
  ]) {
    assert.deepEqual(bashWrites(cmd, CWD), [], `不该识别出产出：${JSON.stringify(cmd)}`);
  }
});

test('bashWrites 在没有任何 cwd 时只认绝对路径（相对路径一律放弃）', () => {
  assert.deepEqual(bashWrites('echo x > y.txt', null), []);
  assert.deepEqual(bashWrites('echo x > y.txt', ''), []);
  assert.deepEqual(norm(bashWrites('echo x > /abs/out.txt', null)), [pathKey('/abs/out.txt')]);
});

test('bashWrites 的 cd 链：任一步不可知就整条放弃，不返回「前半截」', () => {
  // 第一步 cd 可判、第二步 cd 是变量 → 前后两个相对路径都不可信
  assert.deepEqual(bashWrites('cd /a && echo x > y.txt && cd $B && echo z > w.txt', CWD), []);
  // 每一步都可判 → 各自按当时的目录解析
  const got = norm(bashWrites('cd /a && echo x > y.txt && cd /b && echo z > w.txt', CWD));
  assert.deepEqual(got, norm(['/a/y.txt', '/b/w.txt']));
  // pushd/popd 的目录栈我们不跟踪 → 放弃
  assert.deepEqual(bashWrites('pushd /a && echo x > y.txt', CWD), []);
});

test('bashWrites 不被引号里的 > 骗到（那是最典型的误判形态）', () => {
  assert.deepEqual(bashWrites('echo "a > b"', CWD), []);
  assert.deepEqual(bashWrites("grep 'x > y' f.txt", CWD), []);
  assert.deepEqual(norm(bashWrites('echo "hi" > "quoted space.txt"', CWD)), at2(CWD, 'quoted space.txt'));
});

test('bashWriteScan 把「判不出」逐类计数（没看必须和没写分开）', () => {
  const s = bashWriteScan('echo x > $OUT; ls > /dev/null; mkdir -p a/b; sed -i s/x/y/ f.txt; echo ok > good.txt', CWD);
  assert.deepEqual(norm(s.writes.map((w) => w.path)), at2(CWD, 'good.txt'));
  assert.equal(s.unresolved, 1, '变量路径计一条');
  assert.equal(s.temp, 1, '/dev/null 计一条临时位置');
  assert.equal(s.dirs, 1, 'mkdir 计一条（目录不是文件）');
  assert.equal(s.inPlaceEdits, 1, 'sed -i 计一条（原地改写，不是新产出）');
});

test('bashWriteScan 对空输入与坏输入不抛', () => {
  for (const v of ['', '   ', null, undefined, 42, {}]) {
    const s = bashWriteScan(v, CWD);
    assert.deepEqual(s.writes, []);
  }
});

test('bashWrites 对同一条命令里的重复目标去重', () => {
  const got = bashWrites('echo a > out.txt >> out.txt', CWD);
  assert.equal(got.length, 1);
});

test('bashWrites 是纯函数：不读盘、不依赖进程 cwd', () => {
  // 同一个 (cmd, cwd) 调两次结果必须逐字相同；换一个不存在的目录也一样不抛。
  const a = bashWrites('cd sub && echo x > y.txt', CWD);
  const b = bashWrites('cd sub && echo x > y.txt', CWD);
  assert.deepEqual(a, b);
  assert.deepEqual(norm(bashWrites('echo x > y.txt', '/definitely/not/here')),
    norm(at2('/definitely/not/here', 'y.txt')));
});

/** 负向测试：把 Bash 通道关掉，正例必须消失。这条测试的价值不在断言本身，
 *  而在「关掉开关时行为确实变了」——否则整组正例可能在测一条从不生效的路径。 */
test('负向：bash:false 时 observedWriteScan 一条 Bash 痕迹都不给', () => {
  const records = [
    rec('assistant', [toolUse('Bash', { command: 'echo x > a.txt' }, 't1')]),
    rec('assistant', [toolUse('Write', { file_path: 'b.md' }, 't2')]),
  ];
  const withBash = observedWriteScan(records, { cwd: CWD, bash: true });
  const without = observedWriteScan(records, { cwd: CWD, bash: false });
  assert.equal(withBash.writes.filter((w) => w.source === 'bash').length, 1);
  assert.equal(without.writes.filter((w) => w.source === 'bash').length, 0);
  assert.equal(without.writes.length, 1, '写工具那条必须还在——关 Bash 不该关掉整个观察');
});

test('Bash 通道读成对 tool_result：失败的 Bash 写入不算产出', () => {
  const records = [
    { type: 'assistant', cwd: CWD, message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'echo x > bad.txt' } }] } },
    rec('user', [toolResult('b1', true)]),
  ];
  const got = observedWrites(records, { cwd: CWD });
  assert.equal(got.length, 1);
  assert.equal(got[0].failed, true, '失败的 Bash 调用留下的路径必须标 failed');
  assert.equal(got[0].source, 'bash');
});

test('Bash 通道优先用每条记录自带的 cwd（比外部传入更接近事实）', () => {
  const records = [
    { type: 'assistant', cwd: '/inner/project', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'echo x > out.txt' } }] } },
  ];
  const got = observedWrites(records, { cwd: '/outer' });
  assert.deepEqual(norm(got.map((g) => g.path)), at2('/inner/project', 'out.txt'));
});

// ── 文件系统：台账与目录 ──────────────────────────────────────────────

test('台账 append/read 往返；坏行被计数但不让整体失败', () => {
  const d = tmp();
  try {
    const f = ledgerPath(d, 'r1');
    assert.match(f, /claims\.jsonl$/);
    appendRows(f, [makeExpect({ run: 'r1', task: 'ST1', paths: ['a.md'] })], { nowMs: 0 });
    appendRows(f, [makeClaim({ run: 'r1', task: 'ST1', path: 'a.md' })], { nowMs: 1 });
    const { rows, badLines, exists } = readLedger(f);
    assert.equal(exists, true);
    assert.equal(rows.length, 2);
    assert.equal(badLines.length, 0);
    assert.ok(rows.every((r) => r.v === 1 && typeof r.ts === 'string'));

    writeFileSync(f, readFileSync(f, 'utf8') + 'not json\n{"no_kind":1}\n', 'utf8');
    const r2 = readLedger(f);
    assert.equal(r2.rows.length, 2, '坏行不进 rows');
    assert.equal(r2.badLines.length, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('空/无台账没有副作用，也不假装存在', () => {
  const d = tmp();
  try {
    const r = readLedger(join(d, 'nope', 'claims.jsonl'));
    assert.equal(r.exists, false);
    assert.equal(r.rows.length, 0);
    assert.equal(appendRows(join(d, 'nope', 'claims.jsonl'), []), 0);
    assert.equal(existsSync(join(d, 'nope')), false, '空 rows 不该建目录');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('probeDisk 对真实文件给出 size/hash，对不存在给 exists:false', () => {
  const d = tmp();
  try {
    const f = join(d, 'a.txt');
    writeFileSync(f, 'hello', 'utf8');
    const p = probeDisk(f);
    assert.equal(p.exists, true);
    assert.equal(p.size, 5);
    assert.match(p.sha256, /^[0-9a-f]{64}$/);
    assert.equal(p.hashTruncated, false);
    assert.deepEqual(probeDisk(join(d, 'missing.txt')), { exists: false });
    assert.equal(probeDisk(d).exists, false, '目录不算产出文件');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('probeDisk 对同一内容给出同一 hash（可复算）', () => {
  const d = tmp();
  try {
    writeFileSync(join(d, 'a'), 'same', 'utf8');
    writeFileSync(join(d, 'b'), 'same', 'utf8');
    assert.equal(probeDisk(join(d, 'a')).sha256, probeDisk(join(d, 'b')).sha256);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('subagentTranscriptsOf 能找到嵌套的 agent-*.jsonl', () => {
  const d = tmp();
  try {
    const sess = join(d, 'sess');
    mkdirSync(join(sess, 'subagents', 'workflows', 'wf_1'), { recursive: true });
    writeFileSync(join(sess, 'subagents', 'agent-a.jsonl'), '{}', 'utf8');
    writeFileSync(join(sess, 'subagents', 'workflows', 'wf_1', 'agent-b.jsonl'), '{}', 'utf8');
    writeFileSync(join(sess, 'subagents', 'notes.txt'), 'x', 'utf8');
    const got = subagentTranscriptsOf(sess).map((p) => p.replace(/\\/g, '/'));
    assert.equal(got.length, 2);
    assert.ok(got.some((p) => p.endsWith('agent-a.jsonl')));
    assert.ok(got.some((p) => p.endsWith('wf_1/agent-b.jsonl')));
    // 也接受主 transcript 路径
    assert.equal(subagentTranscriptsOf(join(sess, 'sess.jsonl')).length, 2);
    // 不存在的会话目录返回空数组，不抛
    assert.deepEqual(subagentTranscriptsOf(join(d, 'nope')), []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('collectSubagentTranscripts 对不存在目录返回空数组', () => {
  assert.deepEqual(collectSubagentTranscripts(join(tmpdir(), 'ow-definitely-missing-dir')), []);
});

test('readHeadText 只读开头，不把大文件读进来', () => {
  const d = tmp();
  try {
    const f = join(d, 'big.jsonl');
    writeFileSync(f, 'HEAD' + 'x'.repeat(100000), 'utf8');
    const head = readHeadText(f, 16);
    assert.equal(head.length, 16);
    assert.ok(head.startsWith('HEAD'));
    assert.equal(readHeadText(join(d, 'nope'), 16), '');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── foldRows 合并语义 ────────────────────────────────────────────────

test('同一路径的自述取最后一条（重写两次以最后为准）', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['a.md'] }),
    { ...makeClaim({ run: 'r', task: 'ST1', path: 'a.md', disk: { exists: true, size: 1, sha256: 'old' } }), ts: '2026-01-01T00:00:00Z' },
    { ...makeClaim({ run: 'r', task: 'ST1', path: 'a.md', disk: { exists: true, size: 1, sha256: 'new' } }), ts: '2026-01-01T01:00:00Z' },
  ];
  const { claimsByTask } = foldRows(rows);
  const k = pathKey('a.md');
  assert.equal(claimsByTask.get('ST1').get(k).sha256, 'new');
});

test('多条 expect 合并路径而不覆盖 role/nonce', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', role: 'executor', paths: ['a.md'], nonce: 'aaa' }),
    makeExpect({ run: 'r', task: 'ST1', paths: ['b.md'] }),
  ];
  const { tasks } = foldRows(rows);
  const e = tasks.get('ST1');
  assert.deepEqual(e.paths, ['a.md', 'b.md']);
  assert.equal(e.role, 'executor');
  assert.equal(e.nonce, 'aaa');
});

test('缺 task 的行被忽略，不产生幽灵任务', () => {
  const { tasks } = foldRows([{ kind: 'expect', paths: ['a'] }, { kind: 'claim', path: 'a' }]);
  assert.equal(tasks.size, 0);
});

// ── 路径归一化（子 agent 与主线程给的形态不同）──────────────────────

test('同一文件的三种写法必须归一化成同一个键', () => {
  const base = '/repo';
  const keys = ['work/a.md', './work/a.md', '/repo/work/a.md'].map((p) => pathKey(p, base));
  assert.equal(new Set(keys).size, 1);
});

test('相对路径按 base 展开，绝对路径不被 base 改写', () => {
  const base = resolvePath('repo');
  assert.equal(pathKey('a.md', base), pathKey('a.md', join(base, '.')));
  assert.equal(pathKey('a.md', base), pathKey(join(base, 'a.md')));
  // 绝对路径：base 不生效
  const abs = resolvePath('elsewhere/a.md');
  assert.equal(pathKey(abs, resolvePath('other')), pathKey(abs));
  assert.notEqual(pathKey(abs, base), pathKey('elsewhere/a.md', base));
});

test('相对路径的期望与绝对路径的自述能对上（真实子 agent 的形态差异）', () => {
  const base = resolvePath('repo');
  const abs = join(base, 'work', 'a.md');
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['work/a.md'] }),
    makeClaim({ run: 'r', task: 'ST1', path: abs, disk: { exists: true, size: 5, mtimeMs: 1, sha256: 'aa' } }),
  ];
  const r = reconcile({
    rows, base,
    probe: (p) => (pathKey(p, base) === pathKey(abs, base)
      ? { exists: true, size: 5, sha256: 'aa' } : { exists: false }),
  });
  assert.equal(r.tasks[0].verdict, 'COMPLETE');
  assert.equal(r.extras.length, 0, '不该把同一个文件既算期望内又算额外产出');
});


test('反斜杠与正斜杠写法视为同一文件', () => {
  assert.equal(pathKey('a/b.md', '/repo'), pathKey('a\\b.md', '/repo'));
});

test('路径归一化不改变报告里打印的原样路径', () => {
  const rows = [makeExpect({ run: 'r', task: 'ST1', paths: ['./work/a.md'] })];
  const r = reconcile({ rows, base: '/repo', probe: () => ({ exists: false }) });
  assert.equal(r.tasks[0].items[0].path, './work/a.md');
});

test('真正不同的两个文件不会被归一化成冲突', () => {
  const base = '/repo';
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['a/x.md'] }),
    makeExpect({ run: 'r', task: 'ST2', paths: ['b/x.md'] }),
  ];
  const r = reconcile({ rows, base, probe: () => ({ exists: false }) });
  assert.equal(r.conflicts.length, 0);
});

// ── nonce 唯一性 ──────────────────────────────────────────────────────

test('nonceOwners 报出重复的 nonce（归属会静默错位，必须显式）', () => {
  const got = nonceOwners([
    { task: 'ST1', nonce: 'aaaaaaaa' },
    { task: 'ST2', nonce: 'aaaaaaaa' },
    { task: 'ST3', nonce: 'bbbbbbbb' },
    { task: 'ST4', nonce: null },
  ]);
  assert.deepEqual(got.duplicates, ['aaaaaaaa']);
  assert.equal(got.map.get('bbbbbbbb'), 'ST3');
  assert.equal(got.map.size, 2, '没有 nonce 的任务不进归属表');
});

test('nonceOwners 对空输入返回空表', () => {
  const got = nonceOwners([]);
  assert.equal(got.map.size, 0);
  assert.deepEqual(got.duplicates, []);
  assert.deepEqual(nonceOwners(null).duplicates, []);
});

// ── 枚举自检 ─────────────────────────────────────────────────────────

test('ITEM_STATUS 与 TASK_VERDICT 都是冻结枚举且无重复', () => {
  for (const list of [ITEM_STATUS, TASK_VERDICT, FAILING_VERDICTS]) {
    assert.ok(Object.isFrozen(list));
    assert.equal(new Set(list).size, list.length);
  }
  assert.ok(FAILING_VERDICTS.every((v) => TASK_VERDICT.includes(v)));
  assert.ok(!FAILING_VERDICTS.includes('COMPLETE'));
  assert.equal(new Set(TASK_VERDICT).size, TASK_VERDICT.length);
});

test('formatReport 对每个结论都有标记，不会渲染出 undefined', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['a.md'] }),
    makeExpect({ run: 'r', task: 'ST2', paths: ['b.md'] }),
    makeExpect({ run: 'r', task: 'ST3', paths: [] }),
  ];
  const text = formatReport(reconcile({ rows, probe: probeOf({}) }));
  assert.doesNotMatch(text, /undefined/);
  assert.doesNotMatch(text, /\[object/);
});

test('--json 输出里的所有字段都可 JSON 序列化（无循环引用）', () => {
  const rows = [
    makeExpect({ run: 'r', task: 'ST1', paths: ['a.md'] }),
    makeClaim({ run: 'r', task: 'ST1', path: 'a.md', disk: { exists: true, size: 1, mtimeMs: 1, sha256: 'a' } }),
  ];
  const r = reconcile({ rows, probe: probeOf({ 'a.md': { size: 1, sha256: 'a' } }) });
  const s = JSON.stringify(r);
  assert.equal(JSON.parse(s).tasks.length, 1);
});

// ── 端到端：接进派发链路后这条链必须真的跑通 ──────────────────────────
//
// 上面测的是判定层（`reconcile` 这类的纯函数）。这一组走**真 CLI**：
// `declare` → `claim` → `verify` → `consume` → `adopt`，用的就是 SKILL.md §4.5
// 里写的那几条命令。理由很直接——设计 §7 要求「接进派发链路」，而接法是一串命令行。
// 纯函数全绿但 CLI 参数名写错（`--paths` 写成 `--path`），接法就是假的。
//
// 用 `--runs-dir` 指向临时目录、`--root` 指向临时仓库根，不碰真实 `tasks/runs/`。

test('端到端 CLI：declare → claim → verify → consume → adopt（SKILL.md §4.5 的那条链）', () => {
  const { spawnSync } = process.getBuiltinModule('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'ow-claim-e2e-'));
  const runs = join(dir, 'runs');
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const cli = (args) => spawnSync(process.execPath, [join(import.meta.dirname, 'claim-ledger.mjs'), ...args], {
    encoding: 'utf8', timeout: 30000,
  });

  try {
    // 两个产出文件：一个会被 claim，一个不会（靠磁盘判 UNREPORTED → 不该变 COMPLETE）
    writeFileSync(join(repo, 'a.md'), 'aaa', 'utf8');
    writeFileSync(join(repo, 'b.md'), 'bbb', 'utf8');

    const common = ['--run', 'e2e', '--runs-dir', runs, '--root', repo];

    // 1) declare：打印 nonce
    const d = cli(['declare', ...common, '--task', 'ST1', '--paths', 'a.md,b.md', '--role', 'executor']);
    assert.equal(d.status, 0, d.stderr);
    const nonce = (String(d.stdout).match(/nonce:\s*([0-9a-f]{8})/) || [])[1];
    assert.ok(nonce, `declare 没打印 nonce：${d.stdout}`);
    assert.match(String(d.stdout), /拼进派发 prompt/, 'declare 没提示把 nonce 拼进 prompt');

    // 2) 未 claim、未 consume 时：verify 必须 exit 1（且不能是「全部通过」）
    const v0 = cli(['verify', ...common]);
    assert.equal(v0.status, 1, '刚 declare 完就通过，说明对账没看磁盘');
    assert.doesNotMatch(String(v0.stdout), /对账通过/);
    assert.match(String(v0.stdout), /UNREPORTED|未认领/, '文件在但没人自述时，必须说清是哪一种缺陷');

    // 3) claim 一个
    const c = cli(['claim', ...common, '--task', 'ST1', '--path', 'a.md']);
    assert.equal(c.status, 0, c.stderr);

    // 4) 只 claim 一个 → 仍是部分落地，不能判 COMPLETE
    const v1 = cli(['verify', ...common]);
    assert.equal(v1.status, 1, '两个期望只落地一个不能算通过');
    assert.doesNotMatch(String(v1.stdout), /✓ ST1 · COMPLETE/);

    // 5) claim 第二个 → 完整但仍未认领 → 还是 exit 1（「产出在」≠「主线程知道了」）
    assert.equal(cli(['claim', ...common, '--task', 'ST1', '--path', 'b.md']).status, 0);
    const v2 = cli(['verify', ...common]);
    assert.equal(v2.status, 1, '产出完整但未认领，summary.ok 必须是 false');
    assert.match(String(v2.stdout), /未认领/);

    // 6) consume 之后才 exit 0
    assert.equal(cli(['consume', ...common, '--task', 'ST1']).status, 0);
    const v3 = cli(['verify', ...common]);
    assert.equal(v3.status, 0, `认领后才该通过：${v3.stdout}`);
    assert.match(String(v3.stdout), /对账通过/);

    // 7) adopt：已认领 → 无待办
    const a0 = cli(['adopt', ...common]);
    assert.equal(a0.status, 0, a0.stderr);
    assert.match(String(a0.stdout), /没有待认领/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('端到端 CLI：verify 对空台账 exit 1 并明说「不是全部完成」（空 ≠ 通过）', () => {
  const { spawnSync } = process.getBuiltinModule('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'ow-claim-empty-'));
  try {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, 'claim-ledger.mjs'),
      'verify', '--run', 'nope', '--runs-dir', join(dir, 'runs')], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 1, '空台账必须 exit 1');
    assert.match(String(r.stderr), /从没登记过期望/, '必须说明这不是「全部完成」');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('端到端 CLI：declare 的 nonce 写进头部 → observe 只归属那一片 transcript', () => {
  // 这条守的是整个机制的**地基**：nonce 在派发 prompt 里，而派发 prompt 是子 agent
  // transcript 的第一条 user 消息，observe 只读头部 64 KiB。若这条不成立，
  // 「不执行也不会漏」就是一句空话——没有归属，痕迹再多也记不到任务名下。
  //
  // 本机实测支持这个假设：127/127 份子 agent transcript 的正文与父会话里 Agent
  // 工具调用的 prompt 字段逐字节相同（2026-11-13）。这条测试用夹具把它固定下来：
  // 两份 transcript，只有头部含 nonce 的那份应被归属，另一份一条都不许写。
  const { spawnSync } = process.getBuiltinModule('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'ow-claim-nonce-'));
  const runs = join(dir, 'runs');
  const sess = join(dir, 'sess');
  mkdirSync(join(sess, 'subagents'), { recursive: true });
  const writeJsonl = (name, head, recs) => writeFileSync(
    join(sess, 'subagents', name),
    [JSON.stringify({ type: 'user', message: { role: 'user', content: head } }),
      ...recs.map((r) => JSON.stringify(r))].join('\n') + '\n', 'utf8',
  );
  const call = (p, id) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: p } }] } });
  const result = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false }] } });
  const cli = (a) => spawnSync(process.execPath, [join(import.meta.dirname, 'claim-ledger.mjs'), ...a], { encoding: 'utf8', timeout: 30000 });

  try {
    writeFileSync(join(dir, 'out1.md'), 'hello', 'utf8');
    const mine = join(dir, 'out1.md');
    const theirs = join(dir, 'out2.md');
    writeJsonl('agent-aaa.jsonl', '派发：任务 ST1 nonce: deadbeef', [call(mine, 't1'), result('t1')]);
    writeJsonl('agent-bbb.jsonl', '派发：另一个任务（无 nonce）', [call(theirs, 't1'), result('t1')]);

    const common = ['--run', 'obs', '--runs-dir', runs, '--root', dir];
    assert.equal(cli(['declare', ...common, '--task', 'ST1', '--paths', 'out1.md', '--nonce', 'deadbeef']).status, 0);

    const o = cli(['observe', ...common, '--session', sess]);
    assert.equal(o.status, 0, o.stderr);
    assert.match(String(o.stdout), /来自 1\/2 份子 agent transcript/,
      '只有含 nonce 的那份该被归属；扫到两份就说明归属没按 nonce 做');

    // 台账里只许有 ST1 的痕迹，且指向 out1.md
    const rows = readLedger(join(runs, 'obs', LEDGER_FILE)).rows.filter((r) => r.kind === 'observe');
    assert.equal(rows.length, 1, `应当只有一条痕迹，实际 ${rows.length}`);
    assert.equal(rows[0].task, 'ST1');
    assert.match(rows[0].path, /out1\.md$/);
    assert.ok(!rows.some((r) => /out2\.md$/.test(r.path)), '不带 nonce 的那份不许被归属进来');

    // 场景一：文件在、痕迹有、没人自述 → UNREPORTED（不是 COMPLETE，也不是 EMPTY）
    const v = cli(['verify', ...common]);
    assert.equal(v.status, 1);
    assert.match(String(v.stdout), /UNREPORTED/);
    assert.match(String(v.stdout), /agent-aaa\.jsonl/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
