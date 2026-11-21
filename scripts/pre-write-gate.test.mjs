#!/usr/bin/env node
/**
 * pre-write-gate.test.mjs — 写前闸的测试。
 *
 * 覆盖重点（按「拦错了会怎样」排序）：
 *
 *   1. **默认必须不拦。** 没有显式设 `OW_PRE_WRITE_GATE=deny` 时，`decide()` 一次都不许
 *      返回 `deny`。这是对用户伤害最大的一条：装上之后写不了文件，是灾难级故障。
 *      这一条用**穷举输入**验证，不是看代码有没有写 `if`。
 *   2. **负向测试优先，且真的会变红。** 每条拦截用例旁边有一条「把开关关掉」的对照，
 *      并要求它在 `assert.throws` 里失败 —— 只跑一次绿灯不算。
 *   3. **三条硬约束逐条有测试**：
 *      ① 拦截只走 `permissionDecision:"deny"`，输出里不出现 exit code 语义；
 *      ② deny 必须带顶层 `continue:false`（`halt` 挡），`budget` 挡前 N 次不刹车；
 *      ③ shell 旁路必须被覆盖：`PowerShell` 的 `Set-Content` 与 `Bash` 的重定向
 *         都要被判成写，且 matcher 清单要含五个工具名。
 *   4. **状态是「验出来的」还是「自己说的」必须可分辨。** 标记里 `satisfied_by` 是
 *      `auto` 还是 `claim`，在 `decide` 的日志里可查 —— 这是本闸唯一的诚实性来源。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import { scanSession as auditScanSession } from '../scripts/question-audit.mjs';

import {
  decide, configOf, defaultConfig, writeIntentOf, powershellWriteScan, isGateOwnedPath,
  markerPathFor, denialPathFor, readMarker, writeMarker, markerValidity, reasonFor,
  readTranscriptReads, runHook, parseHookInput, appendLog, logPathFor, bumpDenials, cli,
  markerSigOf, readGateSecret, ensureGateSecret, secretPathFor,
  MARKER_REL, SECRET_REL, MODES, BRAKES, WRITE_TOOLS, SHELL_TOOLS, READ_TOOLS, EDIT_SIDE_TOOLS,
  readPathsOfToolUse, pathKeyOf,
  readTranscriptActivity, minQuestionsBeforeWriteOf, reasonForQuestions,
} from '../scripts/pre-write-gate.mjs';
import { ledgerRoot } from '../scripts/stop-verify-hook.mjs';

// ── 装置 ──────────────────────────────────────────────────────────────

/** 测试用的固定密钥。生产环境里它由 `ensureGateSecret()` 随机生成，测试里写死才可复算。 */
const TEST_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'.repeat(2);

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'ow-pwg-'));
}

/** 隔离用的 env：**四个落盘路径一起指到临时目录**。
 *
 *  为什么做成「只能整体给」的函数，而不是各处手写 `{ OW_PRE_WRITE_GATE_LOG: ... }`：
 *  这个 hook 有四个落点 —— 台账（`OW_PRE_WRITE_GATE_LOG`）、标记与密钥（跟着
 *  cwd 走，由 sandbox 目录兜住）、刹车计数（同上）、以及**去重认领文件**
 *  （`OVERWATCH_HOOK_DEDUPE_DIR` / `OVERWATCH_STATE_DIR`）。
 *  漏掉最后一个的后果是实测过的：`DF-029` 的修复刚接上时，全量测试把
 *  `tasks/runs/hook-dedupe/` 写进了仓库 —— 而同一个测试文件里断言的 `deny` 变成
 *  `passthrough`（第二次同 id 调用被当成重复）。一个常量漏写同时制造了
 *  「污染仓库」与「假红」两种症状。
 *
 *  同 `stop-verify-hook.test.mjs` 的 `envIn`：想隔离就一次给全。 */
const envIn = (dir, extra = {}) => ({
  OVERWATCH_HOOK_DEDUPE_DIR: join(dir, 'dedupe'),
  OW_PRE_WRITE_GATE_LOG: join(dir, 'log.jsonl'),
  ...extra,
});

/** 造一个 cwd + marker 的状态对象。`decide` 是纯函数，所以状态全由参数给。 */
function stateFor({ cwd = '/repo', marker = { exists: false, data: null }, reads = [], denials = 0, config = {}, secret = TEST_SECRET } = {}) {
  return {
    config: { ...defaultConfig(), ...config },
    cwd,
    markerPath: `${cwd}/${MARKER_REL}`,
    secretPath: `${cwd}/${SECRET_REL}`,
    secret,
    marker,
    reads: { paths: reads },
    denials,
  };
}

const INPUT = (over = {}) => ({
  session_id: 'sess-1',
  transcript_path: '/nonexistent-ow-transcript.jsonl',
  cwd: '/repo',
  prompt_id: 'prompt-1',
  permission_mode: 'acceptEdits',
  effort: { level: 'max' },
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: '/repo/src/a.mjs', content: 'x\n' },
  tool_use_id: 'toolu_1',
  ...over,
});

/** transcript 行。形状照抄实测契约：`message.content[tool_use]`。 */
const toolUseLine = (name, input) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${Math.random()}`, name, input }] } });

/** 一个「已读过项目」的标记状态。
 *
 *  `auto` 现在**必须带签名**（改动二），所以这个夹具也签 —— 否则它测的就不是
 *  「正常的已满足标记」，而是「伪造标记」，那已经是另一条测试了（见 §13）。 */
const doneMarker = (sid = 'sess-1', by = 'auto', secret = TEST_SECRET) => {
  const data = { version: 1, session_id: sid, satisfied_by: by, reads: 3, at: '2026-11-14T00:00:00.000Z' };
  if (by === 'auto') data.sig = markerSigOf(data, secret);
  return { exists: true, data };
};

// ── 1. 默认最保守 ────────────────────────────────────────────────────

test('默认配置是 observe，且只可能 passthrough/warn', () => {
  assert.equal(defaultConfig().mode, 'observe');
  assert.equal(defaultConfig().brake, 'halt');
  const st = stateFor();
  for (const tool of [...WRITE_TOOLS, ...SHELL_TOOLS, 'Read', 'Grep', 'Glob']) {
    const r = decide(INPUT({ tool_name: tool, tool_input: { file_path: '/repo/a.mjs', command: 'echo x > a.txt' } }), st);
    assert.notEqual(r.action, 'deny', `${tool} 在默认模式下被拒绝了 —— 这是灾难级故障`);
    assert.equal(r.output, null, `${tool} 在默认模式下输出了东西 —— passthrough 才是对的`);
  }
});

test('observe 模式把「本来会拒」记成 would-deny，且不输出', () => {
  const st = stateFor({ config: { mode: 'observe' } });
  const r = decide(INPUT(), st);
  assert.equal(r.action, 'passthrough');
  assert.equal(r.output, null);
  assert.equal(r.log.decision, 'would-deny');
  assert.match(r.log.reason, /写前闸/);
});

test('负向：把开关拨到 deny，同一个输入必须变成拒绝（否则前面那条测试是空的）', () => {
  const st = stateFor({ config: { mode: 'deny' } });
  const r = decide(INPUT(), st);
  assert.equal(r.action, 'deny');
});

// ── 2. 硬约束 ①：只有 permissionDecision 这一条拦法 ────────────────────

test('deny 的输出形状严格符合实测契约', () => {
  const st = stateFor({ config: { mode: 'deny' } });
  const r = decide(INPUT(), st);
  assert.equal(r.output.hookSpecificOutput.hookEventName, 'PreToolUse', 'hookEventName 必须逐字等于 PreToolUse，否则整条判 malformed');
  assert.equal(r.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(typeof r.output.hookSpecificOutput.permissionDecisionReason, 'string');
  assert.ok(r.output.hookSpecificOutput.permissionDecisionReason.length > 100, 'reason 必须是一段可执行指令，不能是一句话');
  // 不得出现在旧字段位置：顶层 decision 是 approve|block，用错会被宿主报错
  assert.equal(r.output.decision, undefined, '顶层 decision 是旧字段，不得使用');
  // 不得靠 exit code 表达拒绝
  assert.equal(r.output.exitCode, undefined);
  assert.equal(r.output.code, undefined);
});

test('负向：reason 里没有任何「exit 2」式的拦截承诺', () => {
  const st = stateFor({ config: { mode: 'deny' } });
  const reason = decide(INPUT(), st).output.hookSpecificOutput.permissionDecisionReason;
  assert.doesNotMatch(reason, /exit\s*2\s*(即可|拦|阻止)/);
});

// ── 3. 硬约束 ②：拒绝必须自带刹车 ────────────────────────────────────

test('brake=halt 时 deny 同时给顶层 continue:false 与 stopReason', () => {
  const r = decide(INPUT(), stateFor({ config: { mode: 'deny', brake: 'halt' } }));
  assert.equal(r.action, 'deny');
  assert.equal(r.output.continue, false, '拒绝循环宿主无上限（实测 69 次），不带 continue:false 会无限重试');
  assert.equal(typeof r.output.stopReason, 'string');
});

test('brake=budget 时前 N 次不刹车，第 N+1 次刹车', () => {
  const cfg = { mode: 'deny', brake: 'budget', denyBudget: 2 };
  for (const denials of [0, 1]) {
    const r = decide(INPUT(), stateFor({ config: cfg, denials }));
    assert.equal(r.action, 'deny');
    assert.equal(r.output.continue, undefined, `第 ${denials + 1} 次拒绝不该终止回合（要让模型先读文件）`);
  }
  const r2 = decide(INPUT(), stateFor({ config: cfg, denials: 2 }));
  assert.equal(r2.action, 'deny');
  assert.equal(r2.output.continue, false, '到预算上限必须刹车');
});

test('负向：把 brake 拨回 halt，budget 那条「前 N 次不刹车」必须不成立', () => {
  const r = decide(INPUT(), stateFor({ config: { mode: 'deny', brake: 'halt', denyBudget: 5 }, denials: 0 }));
  assert.equal(r.output.continue, false);
});

test('reason 在 halt 与非 halt 两档里说法不同（模型要知道回合会不会结束）', () => {
  const halt = decide(INPUT(), stateFor({ config: { mode: 'deny', brake: 'halt' } })).output
    .hookSpecificOutput.permissionDecisionReason;
  const soft = decide(INPUT(), stateFor({ config: { mode: 'deny', brake: 'budget', denyBudget: 3 }, denials: 0 })).output
    .hookSpecificOutput.permissionDecisionReason;
  assert.match(halt, /本回合已结束/);
  assert.doesNotMatch(soft, /本回合已结束/);
  // 2026-11-19（验收第 5 条）：halt 下**不许下「重试」这条指令**—— 回合都结束了，
  // 没有可重试的东西。判据是指令形式，不是「出现过『重试』二字」：
  // 「不刹车会无限重试」是在解释宿主行为，那是事实，不是让模型去做的事。
  assert.doesNotMatch(halt, /重试你刚才那次写|原样重试|问完怎么回到这次写/);
  assert.match(soft, /重试你刚才那次写|重试/, 'budget 档才该叫它重试');
  assert.notEqual(halt, soft);
});

// ── 4. 硬约束 ③：shell 旁路 ─────────────────────────────────────────

test('PowerShell 的 Set-Content 被判成写（G6 那个洞）', () => {
  const s = powershellWriteScan("Set-Content -Path gated.txt -Value 'via powershell'");
  assert.equal(s.isWrite, true);
  assert.deepEqual(s.paths, ['gated.txt']);
  const r = writeIntentOf('PowerShell', { command: "Set-Content -Path gated.txt -Value 'x'" }, '/repo');
  assert.equal(r.isWrite, true);
  assert.equal(r.via, 'powershell');
});

test('PowerShell 的各种落盘写法都被认出来', () => {
  const writes = [
    'Set-Content gated.txt hi',
    'sc out.txt hi',                                   // 别名，最容易漏
    '"hi" | Out-File -FilePath out.txt',
    'echo hi > redirect.txt',
    'echo hi >> append.txt',
    'Add-Content -Path log.txt -Value more',
    'New-Item -ItemType File -Path newf.txt',
    'Copy-Item a.txt b.txt',
  ];
  for (const cmd of writes) {
    assert.equal(writeIntentOf('PowerShell', { command: cmd }, '/repo').isWrite, true, `判漏了：${cmd}`);
  }
});

test('PowerShell 的只读命令不被当成写', () => {
  const reads = ['Get-Content a.txt', 'git log -n 5', 'echo hello', 'Write-Host hello', 'npm install', '2>&1 | Out-Null'];
  for (const cmd of reads) {
    assert.equal(writeIntentOf('PowerShell', { command: cmd }, '/repo').isWrite, false, `误判成写：${cmd}`);
  }
});

test('建目录不算写（与 Bash 侧 mkdir 的处置一致）', () => {
  const r = writeIntentOf('PowerShell', { command: 'New-Item -ItemType Directory -Path newdir' }, '/repo');
  assert.equal(r.isWrite, false);
  assert.equal(r.dirs, 1);
});

test('解析不出来的 PowerShell 片段计数但不当写', () => {
  const r = writeIntentOf('PowerShell', { command: 'Invoke-Expression "Set-Content x.txt y"' }, '/repo');
  assert.equal(r.isWrite, false);
  assert.equal(r.unresolved, 1, '「没看」必须和「没写」区分开');
});

test('Bash 的重定向 / heredoc / tee 被判成写', () => {
  for (const cmd of ['echo x > out.txt', 'cat > a.md <<E\nhi\nE', 'echo hi | tee t.txt']) {
    assert.equal(writeIntentOf('Bash', { command: cmd }, '/repo').isWrite, true, `判漏了：${cmd}`);
  }
});

test('Bash 的只读命令不被当成写', () => {
  for (const cmd of ['ls -la', 'git status', 'node scripts/x.mjs mark', 'cat a.txt']) {
    assert.equal(writeIntentOf('Bash', { command: cmd }, '/repo').isWrite, false, `误判成写：${cmd}`);
  }
});

test('Bash 的子 shell 旁路计数但放行（诚实边界，不是漏洞）', () => {
  const r = writeIntentOf('Bash', { command: 'sh -c "echo x > y.txt"' }, '/repo');
  assert.equal(r.isWrite, false);
  assert.ok(r.unresolved > 0);
});

test('Write / Edit / NotebookEdit 都从 tool_input 取到目标路径', () => {
  assert.deepEqual(writeIntentOf('Write', { file_path: '/a.txt', content: '' }, '/repo').paths, ['/a.txt']);
  assert.deepEqual(writeIntentOf('Edit', { file_path: '/b.txt', old_string: '', new_string: '' }, '/repo').paths, ['/b.txt']);
  assert.deepEqual(writeIntentOf('NotebookEdit', { notebook_path: '/c.ipynb' }, '/repo').paths, ['/c.ipynb']);
});

test('matcher 必须覆盖五个工具名（模板与常量要对得上）', () => {
  const names = [...WRITE_TOOLS, ...SHELL_TOOLS];
  for (const n of ['Write', 'Edit', 'NotebookEdit', 'Bash', 'PowerShell']) {
    assert.ok(names.includes(n), `matcher 缺 ${n} —— 只 matcher Write|Edit 会被 shell 绕过`);
  }
});

// ── 5. 边界 ──────────────────────────────────────────────────────────

test('没有 tool_input 时不判写、不拦', () => {
  const r = decide(INPUT({ tool_input: undefined }), stateFor({ config: { mode: 'deny' } }));
  assert.equal(r.action, 'passthrough');
  assert.equal(r.log.allowReason, 'not-a-write');
});

test('未知工具走 unknown-tool 而不是拒绝', () => {
  const r = decide(INPUT({ tool_name: 'SomeNewTool', tool_input: { file_path: '/x' } }), stateFor({ config: { mode: 'deny' } }));
  assert.equal(r.action, 'passthrough');
  assert.equal(r.log.allowReason, 'unknown-tool');
});

test('标记已存在则放行，且不写标记', () => {
  const st = stateFor({ config: { mode: 'deny' }, marker: doneMarker() });
  const r = decide(INPUT(), st);
  assert.equal(r.action, 'allow');
  assert.equal(r.output, null);
  assert.equal(r.markWrite, null);
  assert.equal(r.log.allowReason, 'marker-present');
  assert.equal(r.log.satisfiedBy, 'auto');
});

test('Bash 命令不含写操作则放行', () => {
  const st = stateFor({ config: { mode: 'deny' } });
  const r = decide(INPUT({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }), st);
  assert.equal(r.action, 'passthrough');
  assert.equal(r.log.allowReason, 'not-a-write');
});

test('不是 PreToolUse 的事件一律放行', () => {
  const r = decide(INPUT({ hook_event_name: 'PostToolUse' }), stateFor({ config: { mode: 'deny' } }));
  assert.equal(r.action, 'passthrough');
  assert.equal(r.log.allowReason, 'wrong-event');
});

test('输入不是对象时放行（fail-open）', () => {
  for (const bad of [null, undefined, [], 'x', 42]) {
    const r = decide(bad, stateFor({ config: { mode: 'deny' } }));
    assert.equal(r.action, 'passthrough');
  }
});

test('闸门自己的文件放行 —— 否则标记永远写不出来，闸门自锁', () => {
  const st = stateFor({ config: { mode: 'deny' } });
  for (const p of [`/repo/${MARKER_REL}`, '/repo/.claude/.ow-gate-denials.json']) {
    const r = decide(INPUT({ tool_input: { file_path: p, content: '{}' } }), st);
    assert.equal(r.action, 'passthrough', `${p} 被拦了，闸门会自锁`);
    assert.equal(r.log.allowReason, 'gate-own-file');
  }
});

test('但 .claude 下的普通文件照拦（只管自己的文件）', () => {
  const st = stateFor({ config: { mode: 'deny' } });
  for (const p of ['/repo/.claude/settings.json', '/repo/.claude/CLAUDE.md']) {
    assert.equal(decide(INPUT({ tool_input: { file_path: p, content: 'x' } }), st).action, 'deny', `${p} 不该被放行`);
  }
});

test('isGateOwnedPath 只认 .claude/.ow-*', () => {
  assert.equal(isGateOwnedPath('/repo/.claude/.ow-read-done', '/repo'), true);
  assert.equal(isGateOwnedPath('.claude/.ow-read-done', '/repo'), true);
  assert.equal(isGateOwnedPath('C:\\repo\\.claude\\.ow-read-done', 'C:\\repo'), true);
  assert.equal(isGateOwnedPath('/repo/.claude/settings.json', '/repo'), false);
  assert.equal(isGateOwnedPath('/repo/src/a.mjs', '/repo'), false);
  assert.equal(isGateOwnedPath('', '/repo'), false);
});

// ── 6. 标记的语义 ────────────────────────────────────────────────────

test('标记绑定 session：换会话即失效', () => {
  const st = stateFor({ config: { mode: 'deny' }, marker: doneMarker('other-session') });
  const r = decide(INPUT(), st);
  assert.equal(r.action, 'deny');
  assert.equal(r.log.marker, 'other-session');
});

test('负向：crossSession=true 时同一个「别的会话」标记被接受', () => {
  const st = stateFor({ config: { mode: 'deny', crossSession: true }, marker: doneMarker('other-session') });
  assert.equal(decide(INPUT(), st).action, 'allow');
});
test('坏 JSON 的标记不算数', () => {
  const dir = sandbox();
  try {
    const mp = markerPathFor(dir);
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(mp, '{not json');
    const m = readMarker(mp);
    assert.equal(m.exists, true);
    assert.equal(m.data, null);
    const v = markerValidity({ marker: m }, { session_id: 's' }, defaultConfig());
    assert.equal(v.valid, false);
    assert.equal(v.why, 'unparsable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeMarker / readMarker 往返，并记下 satisfied_by', () => {
  const dir = sandbox();
  try {
    const mp = markerPathFor(dir);
    const w = writeMarker(mp, { sessionId: 's9', satisfiedBy: 'claim', reads: 0, promptId: 'p' });
    assert.equal(w.satisfied_by, 'claim');
    const r = readMarker(mp);
    assert.equal(r.data.session_id, 's9');
    assert.equal(r.data.satisfied_by, 'claim');
    assert.equal(r.data.version, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeMarker 会自建目录', () => {
  const dir = sandbox();
  try {
    const mp = markerPathFor(join(dir, 'nested', 'proj'));
    assert.equal(existsSync(mp), false);
    writeMarker(mp, { sessionId: 's' });
    assert.equal(existsSync(mp), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('markerValidity 的五种 why 分得开', () => {
  const cfg = defaultConfig();
  // `doneMarker` 本身已是 {exists, data} 形状 —— 不要再包一层（这行注释是踩坑记录：
  // 包了一层之后 markerValidity 读到的是 `{exists, data:{exists, data:{…}}}`，
  // 于是 session_id 读成空、判定退化成 marker-without-session）
  //
  // `secret` 必须一起给：`auto` 标记要验签，没密钥就只能判 `auto-no-secret`
  // —— 那不是这条测试要测的东西。
  const st = (m) => ({ marker: m, secret: TEST_SECRET });
  assert.equal(markerValidity({ marker: { exists: false } }, { session_id: 'a' }, cfg).why, 'missing');
  assert.equal(markerValidity(st(doneMarker('a')), { session_id: 'a' }, cfg).why, 'same-session');
  assert.equal(markerValidity(st(doneMarker('b')), { session_id: 'a' }, cfg).why, 'other-session');
  assert.equal(markerValidity({ marker: { exists: true, data: { satisfied_by: 'auto' } } }, { session_id: 'a' }, cfg).why, 'marker-without-session');
  assert.equal(markerValidity(st(doneMarker('a')), { }, cfg).why, 'no-session-in-input');
});

test('没有 session_id 的标记一律无效 —— 否则它会在每个新会话里永久放行', () => {
  const cfg = defaultConfig();
  const noSid = { exists: true, data: { version: 1, satisfied_by: 'auto' } };
  assert.equal(markerValidity({ marker: noSid, secret: TEST_SECRET }, { session_id: 'any' }, cfg).valid, false);
  // 负向：crossSession 是显式开关，开了才放宽 —— 且只放宽 session 绑定，不放宽「没有 session」
  assert.equal(markerValidity({ marker: noSid, secret: TEST_SECRET }, { session_id: 'any' }, { ...cfg, crossSession: true }).valid, false);
  assert.equal(markerValidity({ marker: doneMarker('other'), secret: TEST_SECRET }, { session_id: 'any' }, { ...cfg, crossSession: true }).valid, true);
});

// ── 6b. 改动一：按首写工具拆成两条判据（2026-11-14）──────────────────
//
// 实测依据：`node scripts/resolution-gate-audit.mjs --only R8`
//   被拦 27 个会话里 Edit/MultiEdit 4 · Write 23；
//   被拦里「首写前读过同一文件」4 个（即这 4 个全都读过）。
// 所以 Edit 侧换锚点，Write 侧一行不动。

const EDIT_INPUT = (target = '/repo/src/a.mjs', over = {}) => INPUT({
  tool_name: 'Edit',
  tool_input: { file_path: target, old_string: 'a', new_string: 'b' },
  ...over,
});

test('Edit：读过目标文件本身 → 放行，allowReason 是 target-read', () => {
  const r = decide(EDIT_INPUT('/repo/src/a.mjs'),
    stateFor({ config: { mode: 'deny', minReads: 3 }, reads: ['/repo/src/a.mjs'] }));
  assert.equal(r.action, 'allow');
  assert.equal(r.log.allowReason, 'target-read');
  // 它不是「验出来的读过项目」，所以不能写标记 —— 否则后续 Write 会被一条更弱的证据放行。
  assert.equal(r.markWrite, null, 'target-read 只证明这一个文件读过，不证明读过项目');
  assert.equal(r.log.satisfiedBy, null);
});

test('负向：Edit 没读过目标、但读了别的 5 个文件 → 仍拦（证明不是把 Edit 侧整体放宽）', () => {
  const others = ['/repo/README.md', '/repo/src/x.mjs', '/repo/src/y.mjs', '/repo/src/z.mjs', '/repo/docs/GUIDE.md'];
  const r = decide(EDIT_INPUT('/repo/src/a.mjs'), stateFor({ config: { mode: 'deny', minReads: 3 }, reads: others }));
  assert.equal(r.action, 'deny', '读了 5 个无关文件也要拦 —— 「读过几个」不是 Edit 侧的证据');
  assert.equal(r.log.reads, 5, '读数照常记进日志，方便事后分桶');
});

test('负向：tighten 对照 —— 同一批「别的文件」对 Write 仍是放行（证明差异来自断据而非输入）', () => {
  const others = ['/repo/README.md', '/repo/src/x.mjs', '/repo/src/y.mjs', '/repo/src/z.mjs', '/repo/docs/GUIDE.md'];
  const r = decide(INPUT({ tool_input: { file_path: '/repo/out.txt', content: 'x' } }),
    stateFor({ config: { mode: 'deny', minReads: 3 }, reads: others }));
  assert.equal(r.action, 'allow', 'Write 侧的逻辑一行没动：读够 3 个就放行');
  assert.equal(r.log.allowReason, 'auto-satisfied-by-transcript');
});

test('负向：把 target-read 那一路拿掉，同一条输入必须变红（这条测试不是空的）', () => {
  // 用「目标读了但 Edit 换成 Write」构造：同一个 reads、同一个路径，Write 不享受 target-read
  const reads = ['/repo/src/a.mjs'];
  assert.equal(decide(EDIT_INPUT('/repo/src/a.mjs'), stateFor({ config: { mode: 'deny' }, reads })).action, 'allow');
  assert.equal(decide(INPUT({ tool_input: { file_path: '/repo/src/a.mjs', content: 'x' } }),
    stateFor({ config: { mode: 'deny' }, reads })).action, 'deny');
});

test('Write 侧行为逐字节不变：读过目标文件也不放行（只有阈值算数）', () => {
  const r = decide(INPUT({ tool_input: { file_path: '/repo/src/a.mjs', content: 'x' } }),
    stateFor({ config: { mode: 'deny', minReads: 3 }, reads: ['/repo/src/a.mjs'] }));
  assert.equal(r.action, 'deny', 'Write 新建文件没有「目标文件可读」这回事，不能套用 Edit 判据');
  assert.notEqual(r.log.allowReason, 'target-read');
});

test('MultiEdit / NotebookEdit 归到 Edit 侧（它们也是改已有文件）', () => {
  assert.deepEqual([...EDIT_SIDE_TOOLS].sort(), ['Edit', 'MultiEdit', 'NotebookEdit']);
  assert.ok(!EDIT_SIDE_TOOLS.includes('Write'), 'Write 绝不能在 Edit 侧');
  const cases = [
    ['MultiEdit', { file_path: '/repo/b.mjs', edits: [] }, '/repo/b.mjs'],
    ['NotebookEdit', { notebook_path: '/repo/c.ipynb', new_source: 'x' }, '/repo/c.ipynb'],
  ];
  for (const [tool, ti, target] of cases) {
    const r = decide(INPUT({ tool_name: tool, tool_input: ti }),
      stateFor({ config: { mode: 'deny', minReads: 3 }, reads: [target] }));
    assert.equal(r.action, 'allow', `${tool} 读了目标文件却没放行`);
    assert.equal(r.log.allowReason, 'target-read', `${tool} 的理由必须是可分辨的 target-read`);
  }
});

test('target-read 只在目标真读过时成立：读的是同名不同目录不算', () => {
  const r = decide(EDIT_INPUT('/repo/src/a.mjs'),
    stateFor({ config: { mode: 'deny', minReads: 3 }, reads: ['/repo/lib/a.mjs', '/repo/src/b.mjs'] }));
  assert.equal(r.action, 'deny');
});

test('pathKeyOf 归一化：Edit 的目标与实际读到的路径只靠它比对', { skip: process.platform !== 'win32' }, () => {
  // 现有 pathKeyOf：反斜杠→正斜杠、折叠重复、去尾斜杠、**win32 上小写**。
  // 所以大小写与分隔符差异在 Windows 上都折叠掉；但**不做** `resolve()` 这类路径消解。
  // 非 win32 上不折叠大小写（那是两个不同文件），见下一条。
  const win = decide(EDIT_INPUT('C:\\a\\b.mjs'),
    stateFor({ cwd: 'C:\\a', config: { mode: 'deny', minReads: 3 }, reads: ['c:/a/B.mjs'] }));
  assert.equal(win.action, 'allow', 'Windows 大小写/分隔符差异必须判成同一个文件');
  assert.equal(win.log.allowReason, 'target-read');
  // 相对路径 vs 绝对路径**不**折叠（pathKeyOf 不是 resolve）—— 这是当前行为，钉住它
  const rel = decide(EDIT_INPUT('src/a.mjs'),
    stateFor({ cwd: '/repo', config: { mode: 'deny', minReads: 3 }, reads: ['/repo/src/a.mjs'] }));
  assert.equal(rel.action, 'deny', 'pathKeyOf 不做绝对化 —— 若将来改了它，这条会红并提醒你审一遍');
});

test('pathKeyOf 在非 win32 上不折叠大小写：读过 a.mjs 不得放行 Edit A.mjs', { skip: process.platform === 'win32' }, () => {
  // 这是 `pathKeyOf` 加平台守卫的理由：Linux 的大小写敏感文件系统上，
  // 无条件 toLowerCase 会让「读过 a.mjs」授权改 A.mjs —— Edit 侧判据直接失效。
  const r = decide(EDIT_INPUT('/repo/a.mjs'),
    stateFor({ cwd: '/repo', config: { mode: 'deny', minReads: 3 }, reads: ['/repo/A.mjs'] }));
  assert.equal(r.action, 'deny', '大小写不同的另一个文件，不能算「读过目标」');
});

// ── 6b-2. `DF-027`：sed 读、相对路径绝对化 ──────────────────────────
//
// 两个叠加的缺陷，实测在 2026-11-18 的会话（`ea4ef562`）里造出唯一一条误判。
// 修法分两半，**判据含义不同**，所以测试也分两半：
//   · 绝对化是纯实现问题（`readPathsOfToolUse` 抽出的是命令里的原样字符串，
//     Edit 侧是 `tool_input.file_path` 绝对路径，`pathKeyOf` 只归一不消解）；
//   · `sed` 是判据问题 —— 同一个动词既能读也能写，所以**先有负向测试再动源码**。

test('DF-027a：`sed -n 1,30p f` 必须被记成读过（当前完全不记账）', () => {
  // 实测（修前）：`readPathsOfToolUse('Bash', {command:"sed -n '1,30p' docs/CHANGELOG.md"})`
  // 返回 `[]` —— 而这是长会话里读文件最常见的写法。
  // 断言按 `pathKeyOf` 比（win32 上绝对化会给 `/repo/x` 补盘符，字面量比会假红）。
  // 期望值走 `resolve` 而不是 `join`：那正是 `toAbsoluteReadPath` 用的函数，
  // 两边同口径，断言才是在测「有没有绝对化」而不是在测两个不同的拼路径函数。
  assert.deepEqual(
    readPathsOfToolUse('Bash', { command: "sed -n '1,30p' docs/CHANGELOG.md" }, undefined, '/repo').map(pathKeyOf),
    [pathKeyOf(resolve('/repo', 'docs', 'CHANGELOG.md'))],
  );
  // 裸 `sed 1,30p f`（不带 -n）同样是读：没人这样写，但它也不写盘。
  assert.deepEqual(
    readPathsOfToolUse('Bash', { command: 'sed 1,30p docs/a.md' }, undefined, '/repo').map(pathKeyOf),
    [pathKeyOf(resolve('/repo', 'docs', 'a.md'))],
  );
});

test('DF-027a 负向：`sed -i` / `--in-place` / `-i.bak` / `-ni` / `-Ei` 一律不算读过', () => {
  // **这一条是本轮的核心**：把 `sed` 直接塞进动词表会让下面每条都变成「读过的证据」，
  // 而它们都在改盘上的文件 —— 那是伪造证据，比现在的漏判更坏。
  const writes = [
    "sed -i 's/x/y/' f.md",
    "sed -i.bak 's/x/y/' f.md",
    "sed --in-place 's/x/y/' f.md",
    "sed --in-place=.bak 's/x/y/' f.md",
    "sed -ni '1,5p' f.md",            // 组合短选项：-n 是读、-i 才是写，但混在一起就是写
    "sed -Ei 's/x/y/' f.md",          // 带扩展正则的就地编辑
    "sed -e 's/a/b/' -i f.md",        // -i 出现在后面
    "sed 's/x/y/' f.md -i",           // -i 在路径之后（GNU 也认）
  ];
  for (const cmd of writes) {
    assert.deepEqual(
      readPathsOfToolUse('Bash', { command: cmd }, undefined, '/repo'), [],
      `就地编辑不得记成读过：${cmd}`,
    );
  }
});

test('DF-027a 负向：`-i` 只出现在引号里的脚本中（不是在改盘）仍算读', () => {
  // 反方向也要钉住，否则「见到 -i 就整条不算」会把 `sed -n '/-i/p' f` 误判成写。
  assert.deepEqual(
    readPathsOfToolUse('Bash', { command: "sed -n '/-i/p' docs/a.md" }, undefined, '/repo').map(pathKeyOf),
    [pathKeyOf(resolve('/repo', 'docs', 'a.md'))],
  );
});

test('DF-027a：脚本在选项值里（-e / -f / --expression）时，文件仍然取得对', () => {
  // 「第一个位置参数是脚本」不是永远成立的：有 `-e`/`-f` 时脚本在选项值里，
  // 第一个位置参数**就是**文件。只按「跳过第一个位置参数」写会在这里把文件漏掉。
  const cases = [
    "sed -e 's/a/b/' docs/a.md",
    'sed -f script.sed docs/a.md',
    "sed -ne '1,3p' docs/a.md",           // 组合短选项里的 e
    "sed -n -e 'p' docs/a.md",
    "sed --expression='s/a/b/' docs/a.md",
    "sed --expression 's/a/b/' docs/a.md",
  ];
  for (const cmd of cases) {
    assert.deepEqual(
      readPathsOfToolUse('Bash', { command: cmd }, undefined, '/repo').map(pathKeyOf),
      [pathKeyOf(resolve('/repo', 'docs', 'a.md'))],
      `脚本在选项值里时文件必须取对：${cmd}`,
    );
  }
});

test('DF-027b：相对路径读 + 绝对路径 Edit 必须匹配上（修前恒不命中）', () => {
  // 修前：`head -30 docs/CHANGELOG.md` 抽出 `docs/CHANGELOG.md`，
  // Edit 侧拿到 `D:\Projects\Overwatch\docs\CHANGELOG.md`，`pathKeyOf` 不消解 → 恒不等。
  const cwd = process.platform === 'win32' ? 'D:\\Projects\\Overwatch' : '/repo';
  const reads = readPathsOfToolUse('Bash', { command: 'head -30 docs/CHANGELOG.md' }, undefined, cwd);
  assert.equal(reads.length, 1);
  assert.ok(
    pathKeyOf(reads[0]) === pathKeyOf(join(cwd, 'docs', 'CHANGELOG.md')),
    `相对路径必须绝对化到会话 cwd：${reads[0]} vs ${join(cwd, 'docs', 'CHANGELOG.md')}`,
  );
  // 端到端：同一条 cwd 下，shell 读 → Edit 该文件必须放行，理由是 target-read。
  const r = decide(EDIT_INPUT(join(cwd, 'docs', 'CHANGELOG.md')),
    stateFor({ cwd, config: { mode: 'deny', minReads: 3 }, reads }));
  assert.equal(r.action, 'allow', '用 head/sed 读过目标文件，Edit 它不该被判「没读过」');
  assert.equal(r.log.allowReason, 'target-read');
});

test('DF-027b 负向：绝对化不会把「读过别的目录下同名文件」也算成读过目标', () => {
  const cwd = process.platform === 'win32' ? 'D:\\Projects\\Overwatch' : '/repo';
  const reads = readPathsOfToolUse('Bash', { command: 'cat lib/a.mjs' }, undefined, cwd);
  const r = decide(EDIT_INPUT(join(cwd, 'src', 'a.mjs')),
    stateFor({ cwd, config: { mode: 'deny', minReads: 3 }, reads }));
  assert.equal(r.action, 'deny', '绝对化只能对齐同一路径，不能把不同目录折到一起');
});

test('DF-027b 边界：不清楚 cwd 时不硬猜 —— 原样保留相对路径', () => {
  // 没有基准就没法绝对化，硬用 `process.cwd()` 会把「测试进程的工作目录」
  // 冒充成「会话目录」，那是把一个猜测变成证据。宁可退回修前的行为。
  assert.deepEqual(readPathsOfToolUse('Bash', { command: 'cat docs/a.md' }), ['docs/a.md']);
});

// ── 6c. 改动二：`satisfied_by:"auto"` 不可外部伪造 ──────────────────

test('伪造 {"satisfied_by":"auto"} 无签名字段 → 不放行', () => {
  const forged = { exists: true, data: { version: 1, session_id: 'sess-1', satisfied_by: 'auto', reads: 99 } };
  const r = decide(INPUT(), stateFor({ config: { mode: 'deny' }, marker: forged }));
  assert.equal(r.action, 'deny', '写一句 satisfied_by:auto 就放行 = 事后审计完全失效');
  assert.equal(r.log.marker, 'auto-unsigned');
});

test('伪造带假签名 → 不放行（且 why 与「没签名」分得开）', () => {
  const forged = {
    exists: true,
    data: { version: 1, session_id: 'sess-1', satisfied_by: 'auto', reads: 99, sig: 'f'.repeat(64) },
  };
  const r = decide(INPUT(), stateFor({ config: { mode: 'deny' }, marker: forged }));
  assert.equal(r.action, 'deny');
  assert.equal(r.log.marker, 'auto-bad-signature');
});

test('签名覆盖 reads：改了数字但不重签 → 不放行', () => {
  const real = doneMarker('sess-1', 'auto').data;
  const tampered = { exists: true, data: { ...real, reads: 999 } };
  assert.equal(decide(INPUT(), stateFor({ config: { mode: 'deny' }, marker: tampered })).action, 'deny');
  // 负向：不动它就能过 —— 否则上面那条是空的
  assert.equal(decide(INPUT(), stateFor({ config: { mode: 'deny' }, marker: { exists: true, data: real } })).action, 'allow');
});

test('签名与密钥绑定：换一个密钥即失效（secret 不是硬编码常量就能防住这种情况）', () => {
  const m = doneMarker('sess-1', 'auto', TEST_SECRET);
  assert.equal(decide(INPUT(), stateFor({ config: { mode: 'deny' }, marker: m, secret: TEST_SECRET })).action, 'allow');
  const other = 'f'.repeat(64);
  assert.equal(decide(INPUT(), stateFor({ config: { mode: 'deny' }, marker: m, secret: other })).action, 'deny');
});

test('缺密钥时 auto 判 auto-no-secret，而不是「永远放行」', () => {
  const m = doneMarker('sess-1', 'auto');
  // 显式构造 state：`stateFor` 的 `secret` 有默认值，传 undefined 会落回默认（那是装置陷阱）
  for (const secret of [null, '']) {
    const st = { ...stateFor({ config: { mode: 'deny' }, marker: m }), secret };
    const r = decide(INPUT(), st);
    assert.equal(r.action, 'deny', '没有密钥 ≠ 谁写的都算');
    assert.equal(r.log.marker, 'auto-no-secret');
  }
  const noKey = { ...stateFor({ config: { mode: 'deny' }, marker: m }) };
  delete noKey.secret;
  assert.equal(decide(INPUT(), noKey).log.marker, 'auto-no-secret', '压根没传 secret 也必须判无效');
});

test('claim 不需要签名（它本来就是自述）；未知 satisfied_by 一律无效', () => {
  const claim = { exists: true, data: { version: 1, session_id: 'sess-1', satisfied_by: 'claim', reads: 0 } };
  assert.equal(decide(INPUT(), stateFor({ config: { mode: 'deny' }, marker: claim })).log.marker, 'same-session');
  for (const by of ['auto2', 'verified', '', 42]) {
    const bad = { exists: true, data: { version: 1, session_id: 'sess-1', satisfied_by: by, reads: 9 } };
    const r = decide(INPUT(), stateFor({ config: { mode: 'deny' }, marker: bad }));
    assert.equal(r.action, 'deny', `satisfied_by=${JSON.stringify(by)} 不在允许集合里，必须不放行`);
    assert.equal(r.log.marker, 'unknown-satisfied-by');
  }
});

test('闸门自己写的标记 → 放行（完整签名往返，不靠测试夹具）', () => {
  const dir = sandbox();
  try {
    const mp = markerPathFor(dir);
    const w = writeMarker(mp, { sessionId: 'sess-1', satisfiedBy: 'auto', reads: 3, readsSample: ['/repo/a.mjs'] });
    assert.ok(w && w.sig, 'writeMarker 写 auto 时必须签名');
    assert.equal(w.verified_at, w.at, '要留一个只有闸门写得出的字段');
    const sec = readGateSecret(secretPathFor(dir));
    assert.ok(sec, '首次写 auto 标记必须生成密钥文件');
    const r = decide(INPUT({ cwd: dir }), stateFor({
      cwd: dir, config: { mode: 'deny' }, marker: readMarker(mp), secret: sec,
    }));
    assert.equal(r.action, 'allow');
    assert.equal(r.log.allowReason, 'marker-present');
    assert.equal(r.log.satisfiedBy, 'auto');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('密钥文件被删 → 旧 auto 标记失效（不是放行），重新判定走 transcript', () => {
  const dir = sandbox();
  try {
    const mp = markerPathFor(dir);
    writeMarker(mp, { sessionId: 'sess-1', satisfiedBy: 'auto', reads: 3 });
    const secPath = secretPathFor(dir);
    assert.ok(existsSync(secPath));
    rmSync(secPath);
    // 重读密钥：不存在 → null → auto 标记判无效
    assert.equal(readGateSecret(secPath), null);
    const r = decide(INPUT({ cwd: dir }), stateFor({
      cwd: dir, config: { mode: 'deny' }, marker: readMarker(mp), secret: readGateSecret(secPath),
    }));
    assert.equal(r.action, 'deny', '密钥没了，auto 签名就无从验证 → 必须失效');
    assert.equal(r.log.marker, 'auto-no-secret');
    // 下一次真需要签名时会重新生成 —— 新密钥让旧签名仍然对不上
    const fresh = ensureGateSecret(secPath);
    assert.ok(fresh && fresh !== '');
    const r2 = decide(INPUT({ cwd: dir }), stateFor({
      cwd: dir, config: { mode: 'deny' }, marker: readMarker(mp), secret: fresh,
    }));
    assert.equal(r2.action, 'deny', '重新生成的密钥不该让旧标记变得有效');
    assert.equal(r2.log.marker, 'auto-bad-signature');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('密钥文件不会被写成常量：两次生成的密钥不同，且不是源码里的任何字面量', () => {
  const a = sandbox();
  const b = sandbox();
  try {
    const sa = ensureGateSecret(secretPathFor(a));
    const sb = ensureGateSecret(secretPathFor(b));
    assert.match(sa, /^[0-9a-f]{32,128}$/);
    assert.notEqual(sa, sb, '每个目录各自生成 —— 硬编码常量会让读源码的人直接伪造');
    assert.equal(ensureGateSecret(secretPathFor(a)), sa, '已存在时必须复用，否则签名每次都不一样');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('闸门不放行对密钥文件的写（否则改密钥再伪造签名，等于没签）', () => {
  const r = decide(INPUT({ tool_input: { file_path: `/repo/${SECRET_REL}`, content: 'deadbeef' } }),
    stateFor({ config: { mode: 'deny' } }));
  assert.equal(r.log.allowReason, 'secret-tamper');
  // 负向：密钥文件不该混进 gate-own-file 那一片白名单
  assert.notEqual(r.log.allowReason, 'gate-own-file');
  // 但标记文件本身仍然要放行，否则闸门自锁
  assert.equal(decide(INPUT({ tool_input: { file_path: `/repo/${MARKER_REL}`, content: '{}' } }),
    stateFor({ config: { mode: 'deny' } })).log.allowReason, 'gate-own-file');
});

test('e2e：伪造标记文件（shell 一条命令）不再放行，闸门自己写的放行', () => {
  const dir = sandbox();
  try {
    const log = join(dir, 'log.jsonl');
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny' });
    // 第 1 步：一条 shell 重定向写一个「验出来的」标记
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(markerPathFor(dir), JSON.stringify({
      version: 1, session_id: 'sess-1', satisfied_by: 'auto', reads: 99, at: '2026-11-14T00:00:00.000Z',
    }));
    // 第 2 步：写入 → 必须被拦（这就是红队 §5-B 的完整路径）。
    // 下面两次 runHook 是**两次不同的工具调用**（真序列：先被拦、再重试），
    // 所以必须给不同 `tool_use_id` —— 同一个 id 会被去重层当成本次调用的第二次触发
    // （`DF-029`），那测的就不是「伪造标记放不放行」了。
    const forged = runHook(INPUT({ cwd: dir, tool_use_id: 'toolu_forged' }), { env });
    assert.equal(forged.action, 'deny', '伪造的 auto 标记不该放行');
    // why 是 auto-no-secret：此时还没有密钥文件，闸门连验签的密钥都没有。
    // 关键是**它没有放行** —— 「验不了」在本闸里永远不等于「验过了」。
    assert.match(forged.log.marker, /^auto-(no-secret|unsigned)$/);
    // 第 3 步：换成闸门自己写的标记 → 放行
    const w = writeMarker(markerPathFor(dir), { sessionId: 'sess-1', satisfiedBy: 'auto', reads: 3 });
    assert.ok(w && w.sig);
    const real = runHook(INPUT({ cwd: dir, tool_use_id: 'toolu_retry' }), { env });
    assert.equal(real.action, 'allow');
    assert.equal(real.log.allowReason, 'marker-present');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 7. (b) 主路：transcript 判定 ──────────────────────────────────────

test('transcript 里读够 minReads 个不同文件 → 自动放行并记 satisfied_by=auto', () => {
  const reads = ['/repo/README.md', '/repo/src/a.mjs', '/repo/src/b.mjs'];
  const r = decide(INPUT(), stateFor({ config: { mode: 'deny', minReads: 3 }, reads }));
  assert.equal(r.action, 'allow');
  assert.equal(r.markWrite.satisfiedBy, 'auto');
  assert.equal(r.log.allowReason, 'auto-satisfied-by-transcript');
});

test('读同一个文件多次只算一个', () => {
  const r = decide(INPUT(), stateFor({ config: { mode: 'deny', minReads: 3 }, reads: ['/repo/README.md'] }));
  assert.equal(r.action, 'deny');
  assert.equal(r.log.reads, 1);
});

test('负向：把 minReads 调高，同一批读取必须变成拒绝', () => {
  const reads = ['/repo/README.md', '/repo/src/a.mjs', '/repo/src/b.mjs'];
  assert.equal(decide(INPUT(), stateFor({ config: { mode: 'deny', minReads: 2 }, reads })).action, 'allow');
  assert.equal(decide(INPUT(), stateFor({ config: { mode: 'deny', minReads: 5 }, reads })).action, 'deny');
});

test('readTranscriptReads 从真实文件里数出不同路径（含截断首行）', () => {
  const dir = sandbox();
  try {
    const p = join(dir, 't.jsonl');
    const lines = [
      toolUseLine('Read', { file_path: '/repo/README.md' }),
      toolUseLine('Read', { file_path: '/repo/README.md' }),        // 重复
      toolUseLine('Read', { file_path: '/repo/src/a.mjs' }),
      toolUseLine('Bash', { command: 'cat /repo/src/b.mjs' }),
      toolUseLine('Grep', { pattern: 'x' }),                         // 不算读
      toolUseLine('Write', { file_path: '/repo/out.txt' }),          // 不算读
      '{broken json',
    ];
    writeFileSync(p, lines.join('\n') + '\n');
    const r = readTranscriptReads(p);
    assert.deepEqual(r.paths.sort(), ['/repo/README.md', '/repo/src/a.mjs', '/repo/src/b.mjs'].sort());
    assert.equal(r.unparsable, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readTranscriptReads 读不到文件时安全返回空', () => {
  const r = readTranscriptReads('/nonexistent-ow-transcript.jsonl');
  assert.deepEqual(r.paths, []);
  assert.equal(r.bytesRead, 0);
  assert.equal(readTranscriptReads('').paths.length, 0);
});

test('readTranscriptReads 的有界读只读尾部', () => {
  const dir = sandbox();
  try {
    const p = join(dir, 'big.jsonl');
    const filler = toolUseLine('Read', { file_path: '/repo/old.mjs' });
    // 前面塞一大堆，让目标行只出现在尾部
    writeFileSync(p, (filler + '\n').repeat(2000) + toolUseLine('Read', { file_path: '/repo/tail.mjs' }) + '\n');
    const full = readTranscriptReads(p, { bytes: 10 * 1024 * 1024 });
    assert.ok(full.paths.includes('/repo/old.mjs'));
    // 一条记录约 145 字节；取 200 字节的窗口 = 半条 + 完整最后一条，
    // 既证明「只读尾部」，又让窗口边界那一行被正确丢弃。
    const tail = readTranscriptReads(p, { bytes: 200 });
    assert.ok(tail.bytesRead <= 200);
    assert.ok(tail.paths.includes('/repo/tail.mjs'), '尾部那一行必须在');
    assert.ok(!tail.paths.includes('/repo/old.mjs'), '超出窗口的旧行不该被读到');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('READ_TOOLS 覆盖 Read 与 NotebookRead', () => {
  assert.deepEqual([...READ_TOOLS].sort(), ['NotebookRead', 'Read']);
});

// ── 8. config / env ─────────────────────────────────────────────────

test('configOf 只接受合法值，非法值回落到保守默认', () => {
  assert.equal(configOf({}).mode, 'observe');
  assert.equal(configOf({ OW_PRE_WRITE_GATE: 'deny' }).mode, 'deny');
  assert.equal(configOf({ OW_PRE_WRITE_GATE: 'DENY' }).mode, 'deny');
  assert.equal(configOf({ OW_PRE_WRITE_GATE: 'banana' }).mode, 'observe', '非法模式必须回落到 observe');
  assert.equal(configOf({ OW_PRE_WRITE_GATE: 'off' }).mode, 'observe');
  for (const m of MODES) assert.equal(configOf({ OW_PRE_WRITE_GATE: m }).mode, m);
});

test('configOf 的刹车与预算', () => {
  assert.equal(configOf({}).brake, 'halt');
  assert.equal(configOf({ OW_PRE_WRITE_GATE_BRAKE: 'budget' }).brake, 'budget');
  assert.equal(configOf({ OW_PRE_WRITE_GATE_BRAKE: 'banana' }).brake, 'halt');
  assert.equal(configOf({ OW_PRE_WRITE_GATE_DENY_BUDGET: '5' }).denyBudget, 5);
  assert.equal(configOf({ OW_PRE_WRITE_GATE_DENY_BUDGET: '-1' }).denyBudget, defaultConfig().denyBudget);
  assert.equal(configOf({ OW_PRE_WRITE_GATE_DENY_BUDGET: '999' }).denyBudget, defaultConfig().denyBudget);
  assert.equal(configOf({ OW_PRE_WRITE_GATE_MIN_READS: '0' }).minReads, 0);
  assert.equal(configOf({ OW_PRE_WRITE_GATE_CROSS_SESSION: '1' }).crossSession, true);
  assert.equal(configOf({ OW_PRE_WRITE_GATE_CROSS_SESSION: 'no' }).crossSession, false);
  for (const b of BRAKES) assert.ok(['halt', 'budget'].includes(b));
});

test('minReads=0 时标记照旧是唯一条件（不读 transcript 也能过）', () => {
  const r = decide(INPUT(), stateFor({ config: { mode: 'deny', minReads: 0 }, reads: [] }));
  assert.equal(r.action, 'deny', 'minReads=0 只是关掉自动放行，不是关掉闸门');
});

// ── 9. reason 是可执行指令链 ─────────────────────────────────────────

test('reason 含可复制的命令、含最小读取数、含 AskUserQuestion', () => {
  const r = reasonFor({
    cwd: '/repo', markerPath: '/repo/.claude/.ow-read-done',
    gateCommand: 'node "/repo/scripts/pre-write-gate.mjs" mark --session s1',
    minReads: 3, halt: true,
  });
  assert.match(r, /node "\/repo\/scripts\/pre-write-gate\.mjs" mark --session s1/);
  assert.match(r, /至少 1 个源码文件/);
  assert.match(r, /AskUserQuestion/);
  assert.match(r, /本回合已结束/);
});

test('reason 里的读取数随 minReads 变（文案与实际判据不能漂）', () => {
  const mk = (n) => reasonFor({ cwd: '/r', markerPath: '/r/m', gateCommand: 'g', minReads: n, halt: false });
  assert.match(mk(3), /至少 1 个源码文件/);
  assert.match(mk(6), /至少 4 个源码文件/);
  assert.match(mk(2), /至少 0 个源码文件/);
});

test('budget 档的 reason 会报第几次拒绝', () => {
  const r = reasonFor({ cwd: '/r', markerPath: '/r/m', gateCommand: 'g', minReads: 3, halt: false, denialCount: 1, maxDenials: 3 });
  assert.match(r, /第 2\/3 次/);
});

// ── 10. runHook：副作用集中在这里 ───────────────────────────────────

test('runHook 在 observe 模式下什么都不写、不输出', () => {
  const dir = sandbox();
  try {
    const log = join(dir, 'log.jsonl');
    const out = runHook(INPUT({ cwd: dir }), { env: envIn(dir) });
    assert.equal(out.action, 'passthrough');
    assert.equal(out.output, null);
    assert.equal(existsSync(markerPathFor(dir)), false, '观测模式不得写标记');
    assert.equal(existsSync(log), true, '观测模式必须记账 —— 否则这条闸是否有效没人知道');
    const rec = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]);
    assert.equal(rec.decision, 'would-deny');
    assert.equal(rec.sessionId, 'sess-1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runHook 在 deny 模式下拦 + 记账 + 推计数器', () => {
  const dir = sandbox();
  try {
    const log = join(dir, 'log.jsonl');
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny' });
    const out = runHook(INPUT({ cwd: dir }), { env });
    assert.equal(out.action, 'deny');
    assert.equal(out.output.continue, false);
    assert.equal(existsSync(markerPathFor(dir)), false);
    assert.equal(bumpDenials(denialPathFor(dir), 'prompt-1', { readOnly: true }), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runHook 读到足够 transcript 时自己写标记（satisfied_by=auto）', () => {
  const dir = sandbox();
  try {
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, [
      toolUseLine('Read', { file_path: join(dir, 'README.md') }),
      toolUseLine('Read', { file_path: join(dir, 'src/a.mjs') }),
      toolUseLine('Read', { file_path: join(dir, 'src/b.mjs') }),
    ].join('\n') + '\n');
    const out = runHook(INPUT({ cwd: dir, transcript_path: tp }), {
      env: envIn(dir, { OW_PRE_WRITE_GATE: 'deny' }),
    });
    assert.equal(out.action, 'allow');
    const m = readMarker(markerPathFor(dir));
    assert.equal(m.data.satisfied_by, 'auto');
    assert.equal(m.data.session_id, 'sess-1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runHook 的计数器只在 budget 档参与刹车，不参与判定', () => {
  const dir = sandbox();
  try {
    const log = join(dir, 'log.jsonl');
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny', OW_PRE_WRITE_GATE_BRAKE: 'budget', OW_PRE_WRITE_GATE_DENY_BUDGET: '1' });
    // 两次不同的工具调用（同一回合内连写两个文件）—— `tool_use_id` 必须不同，
    // 否则去重层会把它当成「同一次调用的第二次触发」而直接放行（`DF-029`）。
    const a = runHook(INPUT({ cwd: dir, tool_use_id: 'toolu_a' }), { env });
    assert.equal(a.action, 'deny');
    assert.equal(a.output.continue, undefined);
    const b = runHook(INPUT({ cwd: dir, tool_use_id: 'toolu_b' }), { env });
    assert.equal(b.action, 'deny');
    assert.equal(b.output.continue, false, '第二次触到预算，刹车');
    // 两次都拒绝：计数只影响刹车，不影响「拦不拦」
    const recs = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(recs.filter((r) => r.decision === 'deny').length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runHook 的失败面：transcript 读不到也只是「没读到」，不是崩', () => {
  // 传一个 transcript_path 指向目录，让读盘抛 —— 必须仍然是 passthrough/deny 而不是异常逃逸
  const dir = sandbox();
  try {
    const out = runHook(INPUT({ cwd: dir, transcript_path: dir }), {
      env: envIn(dir),
    });
    assert.equal(out.action, 'passthrough');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bumpDenials 按 prompt_id 分区，换回合归零', () => {
  const dir = sandbox();
  try {
    const p = join(dir, 'd.json');
    assert.equal(bumpDenials(p, 'p1', { readOnly: true }), 0);
    assert.equal(bumpDenials(p, 'p1'), 1);
    assert.equal(bumpDenials(p, 'p1'), 2);
    assert.equal(bumpDenials(p, 'p1', { readOnly: true }), 2);
    assert.equal(bumpDenials(p, 'p2', { readOnly: true }), 0, '换 prompt_id 必须归零');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendLog / logPathFor 的路径与覆盖', () => {
  const dir = sandbox();
  try {
    const custom = join(dir, 'x.jsonl');
    assert.equal(logPathFor({ OW_PRE_WRITE_GATE_LOG: custom }), custom);
    const dflt = logPathFor({}, Date.parse('2026-11-14T12:00:00Z'));
    assert.match(dflt, /pre-write-gate[\\/]2026-11-14\.jsonl$/);
    // 2026-11-21：默认落点从 `REPO_ROOT/tasks/runs/`（脚本位置）改成宿主机状态目录。
    // 闸门被挂进的是**用户项目**，锚在脚本位置等于每判一次写就往框架仓库追加一行。
    // 这条断言是那次修复的判据本身：路径里不许出现框架仓库的 `tasks/runs/`。
    assert.doesNotMatch(dflt.replace(/\\/g, '/'), /\/Projects\/Overwatch\/tasks\/runs\//,
      `闸门记账不许落进框架仓库：${dflt}`);
    // 与 stop hook 那三处**同根**：分布在两个状态目录里会让「清一次就干净」变成假的
    assert.equal(dirname(dirname(dflt)), ledgerRoot({}), '闸门记账与 hook 台账必须同一个状态根');
    // STATE_DIR 仍然优先（本仓统一的隔离约定）
    const iso = join(dir, 'iso');
    assert.equal(logPathFor({ OVERWATCH_STATE_DIR: iso }, Date.parse('2026-11-14T12:00:00Z')),
      join(iso, 'pre-write-gate', '2026-11-14.jsonl'));
    assert.equal(appendLog({ a: 1 }, { OW_PRE_WRITE_GATE_LOG: custom }), true);
    assert.equal(appendLog({ a: 2 }, { OW_PRE_WRITE_GATE_LOG: custom }), true);
    assert.equal(readFileSync(custom, 'utf8').trim().split('\n').length, 2);
    // 写不进去时返回 false，不抛
    assert.equal(appendLog({ a: 3 }, { OW_PRE_WRITE_GATE_LOG: join(dir, 'nope', '\u0000', 'x') }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseHookInput 拒绝数组与垃圾，接受对象', () => {
  assert.equal(parseHookInput(''), null);
  assert.equal(parseHookInput('[]'), null);
  assert.equal(parseHookInput('"x"'), null);
  assert.equal(parseHookInput('{bad'), null);
  assert.deepEqual(parseHookInput('{"a":1}'), { a: 1 });
});

// ── 10.5 `ask.minQuestionsBeforeWrite`：第一次写之前先问够 N 个问题 ──────────
//
// 用户原话（判据来源）：「提前问主要服务的是长时间工作这个目的。一旦开头提示词给的
// 模糊，做出来的东西不是用户想要的就是白费力气了。做成配置项 …… 走错方向的风险
// 由用户承担。」所以：默认 0 = 完全不启用；N>0 才判；只判「第一次写」。
//
// 这组测试的排序同样是「拦错了会怎样」：
//   1. `0` 时**完全不参与**（连 transcript 都不许读一次）；
//   2. 数的是**去重后的问题**，同一个问题问三遍只算一个；
//   3. 已经写过的会话不再判（写到一半才拦会打断正在进行的活）；
//   4. 读不到 transcript / 形态不可读 / 配置是垃圾 → 一律放行。

/** 造一份 `readTranscriptActivity` 形状的对象。`questions` 是**去重后**的文本数组。 */
const activityOf = ({ questions = [], askCalls = null, priorWriteCalls = 0, reads = [], unknownAskCalls = 0 } = {}) => ({
  reads,
  askCalls: askCalls === null ? questions.length : askCalls,
  questions,
  distinctQuestions: questions.length,
  unknownAskCalls,
  priorWriteCalls,
});

/** 带 activity 的 state。
 *
 *  `act` 省略 / `undefined` = **没有这条数据**（`getActivity()` 返回空，fail-open 那条路）。
 *  `over.config.minQuestionsBeforeWrite` 默认给 3 —— 这样每条用例只写**与它无关**的那部分，
 *  不会有「忘了设 need 所以判据根本没跑」这种假绿。需要别的值时显式覆盖。 */
function stateWithActivity(act, over = {}) {
  const st = stateFor({ ...over, config: { minQuestionsBeforeWrite: 3, ...(over.config || {}) } });
  if (act !== undefined) st.activity = act;
  return st;
}

test('minQuestionsBeforeWrite=0：这条判据完全不参与（连 transcript 都不读）', () => {
  // 「逐字节相同」的判据不是看代码里有没有 `if`，而是：
  // ① 0 时 `getActivity` **一次都不许被调用**（用一个抛异常的函数验）；
  // ② 判决/输出/日志与「根本没有这个 state 字段」逐字相同。
  //
  // 比较时**剔掉 `at`**：它是 `new Date().toISOString()`，两次调用跨毫秒就会不等 ——
  // 那是时钟，不是行为。剔掉之后剩下的每个字段都必须逐字相同。
  const strip = (o) => {
    if (!o || typeof o !== 'object') return o;
    const { at, ...rest } = o;
    return rest;
  };
  const st0 = stateFor({ config: { mode: 'deny' } });
  const st0WithBomb = {
    ...st0,
    getActivity: () => { throw new Error('0 时说这条判据读了 transcript —— 默认值破坏了现有用户'); },
  };
  const a = decide(INPUT(), st0);
  const b = decide(INPUT(), st0WithBomb);
  assert.deepEqual(strip(b.log), strip(a.log),
    'minQuestionsBeforeWrite=0 时，判决与日志必须与改动前逐字相同');
  assert.deepEqual(b.action, a.action);
  assert.deepEqual(b.output, a.output);
  assert.equal(a.log.questions, undefined, '0 时不许往日志里写这条判据的字段');
  assert.equal(a.log.minQuestions, undefined);
  assert.equal(a.log.denyBy, undefined);
  // 极端输入（写过/没写过/读过/没读过）也不许因为这条判据改变任何东西
  for (const cfg of [{ mode: 'deny' }, { mode: 'observe' }, { mode: 'warn' }]) {
    for (const reads of [[], ['/repo/a.mjs', '/repo/b.mjs', '/repo/c.mjs']]) {
      const c = decide(INPUT(), stateFor({ config: cfg, reads }));
      assert.equal(c.action, a2action(cfg.mode, reads), `${cfg.mode}/${reads.length} 的判决顺序被改了`);
    }
  }
});

/** 上面那条循环要一个独立期望值，否则它就是「拿自己验自己」。
 *  `deny` 模式：读够 minReads 才放行；`observe` 只记账；`warn` 提醒但不拦。 */
function a2action(mode, reads) {
  if (reads.length >= defaultConfig().minReads) return 'allow';
  return mode === 'deny' ? 'deny' : mode === 'warn' ? 'warn' : 'passthrough';
}

test('minQuestionsBeforeWrite=3 且一个都没问 → deny，reason 含「还差 3 个」', () => {
  // `brake="budget"`：这一档下回合还活着，文案才该说「重试」。
  // `halt` 档的文案另有测试（`halt 与 budget 的文案必须不同`），两者不再混着断言。
  const st = stateWithActivity(activityOf({ questions: [] }), { config: { mode: 'deny', brake: 'budget', denyBudget: 5 } });
  const r = decide(INPUT(), st);
  assert.equal(r.action, 'deny');
  const reason = r.output.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /还差 3 个/, `reason 必须说清还差几个：${reason.slice(0, 120)}`);
  assert.match(reason, /重试/, 'budget 档 reason 必须告诉模型问完怎么回到这次写');
  assert.match(reason, /AskUserQuestion/);
  assert.equal(r.log.denyBy, 'questions');
  // halt 档：同一份 activity 必须 deny，但文案里**不许**出现「重试」。
  const h = decide(INPUT(), stateWithActivity(activityOf({ questions: [] }), { config: { mode: 'deny', brake: 'halt' } }));
  assert.equal(h.action, 'deny');
  const hr = h.output.hookSpecificOutput.permissionDecisionReason;
  assert.doesNotMatch(hr, /重试你刚才那次写|原样重试/, `halt 下回合已结束，不许叫它重试：${hr.slice(-200)}`);
  assert.match(hr, /本回合已结束/);
  assert.match(hr, /重新发一句话|下一条消息/, 'halt 下要告诉用户下一步是什么');
});

test('minQuestionsBeforeWrite=3 且问了 3 个不同的问题 → allow', () => {
  // 读侧判据**照常满足**（读了 3 个文件）：这样这条测试证明的是「新判据放行了」，
  // 而不是「读侧判据碰巧也不拦」。两条判据都要过，allow 才算数。
  const st = stateWithActivity(
    activityOf({ questions: ['改哪个文件？', '用 A 还是 B？', '验收用哪条命令？'] }),
    { config: { mode: 'deny' }, reads: ['/repo/README.md', '/repo/src/a.mjs', '/repo/src/b.mjs'] },
  );
  const r = decide(INPUT(), st);
  assert.equal(r.action, 'allow', '问够了就必须放行 —— 这条判据不能顺手把读侧判据也收紧');
  assert.equal(r.log.allowReason, 'auto-satisfied-by-transcript');
  assert.equal(r.log.questions, 3);
});

test('minQuestionsBeforeWrite=3 且问了 3 次但同一个问题重复问 → 只算 1 个，仍然 deny', () => {
  const st = stateWithActivity(activityOf({ questions: ['改哪个文件？'] }), {
    config: { mode: 'deny' },
    reads: ['/repo/README.md', '/repo/src/a.mjs', '/repo/src/b.mjs'],
  });
  const r = decide(INPUT(), st);
  assert.equal(r.action, 'deny', '读侧已满足，仍被拦 —— 说明拦它的是这条判据');
  assert.match(r.output.hookSpecificOutput.permissionDecisionReason, /还差 2 个/);
  assert.equal(r.log.questions, 1, '去重后只有 1 个');
  assert.equal(r.log.denyBy, 'questions');
});

test('第二次写（transcript 里已经有过写）→ 这条判据不再介入', () => {
  const st = stateWithActivity(
    activityOf({ questions: [], priorWriteCalls: 1 }),
    { config: { mode: 'deny' }, reads: ['/repo/README.md', '/repo/src/a.mjs', '/repo/src/b.mjs'] },
  );
  const r = decide(INPUT(), st);
  assert.equal(r.action, 'allow', '写到一半才拦会打断正在进行的活');
  assert.equal(r.log.allowReason, 'auto-satisfied-by-transcript');
  assert.equal(r.log.priorWrites, 1);
  // 负向：把 priorWriteCalls 归零，同一份输入必须变成 deny —— 否则上一条测试是空的
  const first = decide(INPUT(), stateWithActivity(activityOf({ questions: [] }), {
    config: { mode: 'deny' }, reads: ['/repo/README.md', '/repo/src/a.mjs', '/repo/src/b.mjs'],
  }));
  assert.equal(first.action, 'deny');
  assert.equal(first.log.denyBy, 'questions');
});

test('transcript 读不到 → 这条判据不拦（判决与未启用它时逐字相同）', () => {
  // 「放行」在这一条上只能是「不因它而拦」：读侧判据照旧生效。
  // 所以判据是**两次判决相等**，不是「一定是 allow」。
  const off = decide(INPUT(), stateFor({ config: { mode: 'deny' } }));
  const on = decide(INPUT(), stateWithActivity(undefined, { config: { mode: 'deny' } }));
  assert.equal(on.action, off.action);
  assert.equal(
    on.output && on.output.hookSpecificOutput.permissionDecisionReason,
    off.output && off.output.hookSpecificOutput.permissionDecisionReason,
    '读不到 transcript 时必须走原来那条 reason，不许换成「去问问题」',
  );
  assert.equal(on.log.questions, 'unavailable');
  // 显式给一个「读不出来」的 activity（磁盘上有文件但读不到）走同一条路
  const unreadable = decide(INPUT(), stateWithActivity({ ...activityOf({}), unreadable: true },
    { config: { mode: 'deny' } }));
  assert.equal(unreadable.action, off.action);
  assert.equal(unreadable.log.questions, 'unavailable');
});

test('PAUSE 文件存在 → 放行（叫停优先于这条新判据，也优先于读侧判据）', () => {
  const st = stateWithActivity(activityOf({ questions: [] }), { config: { mode: 'deny' } });
  st.paused = true;
  const r = decide(INPUT(), st);
  assert.equal(r.action, 'passthrough', '叫停路径必须能越过任何分支');
  assert.equal(r.output, null);
  assert.equal(r.log.allowReason, 'user-paused');
});

test('负向：PAUSE 不影响 minQuestionsBeforeWrite=0 的既有行为（默认关闭的判据不许顺带改别人）', () => {
  // 「叫停路径」是这次**新增**的接线（改动前本闸不认 PAUSE 文件）。
  // 如果它放在 `decide()` 最前面，现有用户（`minQuestionsBeforeWrite: 0`）
  // 在 PAUSE 文件存在时的行为就会变 —— 那是默认值在改已发布的行为，方向再宽松也不行。
  for (const mode of ['deny', 'observe', 'warn']) {
    for (const reads of [[], ['/repo/a.mjs', '/repo/b.mjs', '/repo/c.mjs']]) {
      const plain = decide(INPUT(), stateFor({ config: { mode }, reads }));
      const paused = decide(INPUT(), { ...stateFor({ config: { mode }, reads }), paused: true });
      assert.equal(paused.action, plain.action, `${mode}/${reads.length}：PAUSE 不许改变 minQuestions=0 的判决`);
      assert.notEqual(plain.log.allowReason, 'user-paused');
    }
  }
  // 反过来：一旦开了这条判据，PAUSE 就必须生效 —— 否则上一条测试只是「PAUSE 整个没接线」
  const on = decide(INPUT(), { ...stateWithActivity(activityOf({ questions: [] })), paused: true });
  assert.equal(on.log.allowReason, 'user-paused');
});

test('负向：同一份 activity，把 minQuestionsBeforeWrite 拨回 0 必须放行（证明这条测试不是空的）', () => {
  const act = activityOf({ questions: [] });
  const reads = ['/repo/README.md', '/repo/src/a.mjs', '/repo/src/b.mjs'];
  const on = decide(INPUT(), stateWithActivity(act, { config: { mode: 'deny' }, reads }));
  assert.equal(on.action, 'deny');
  assert.equal(on.log.denyBy, 'questions');
  const off = decide(INPUT(), stateWithActivity(act, { config: { mode: 'deny', minQuestionsBeforeWrite: 0 }, reads }));
  assert.equal(off.action, 'allow');
});

test('形态不可读的提问（questions 是坏 JSON）不参与判定 —— 不知道就不许判', () => {
  const st = stateWithActivity(activityOf({ questions: [], askCalls: 1, unknownAskCalls: 1 }), {
    config: { mode: 'deny' },
    reads: ['/repo/README.md', '/repo/src/a.mjs', '/repo/src/b.mjs'],
  });
  const r = decide(INPUT(), st);
  assert.equal(r.action, 'allow', '解析失败 ≠ 没问，把它当 0 会拦一个按规矩做了的会话');
  assert.equal(r.log.questions, 'unknown-form');
  assert.equal(r.log.questionsUnknown, 1);
  // 负向：同一份输入里只要有一个**可读**的问题（不足 3 个），就必须再一次被拦 ——
  // 否则「unknown 放行」可能只是「这条判据整个不工作了」。
  const mixed = decide(INPUT(), stateWithActivity(
    activityOf({ questions: ['改哪个文件？'], askCalls: 2, unknownAskCalls: 1 }),
    { config: { mode: 'deny' }, reads: ['/repo/README.md', '/repo/src/a.mjs', '/repo/src/b.mjs'] },
  ));
  assert.equal(mixed.action, 'deny');
  assert.match(mixed.output.hookSpecificOutput.permissionDecisionReason, /还差 2 个/);
});

test('需要问题数由配置决定，reason 里的数字跟着变（文案与判据不能漂）', () => {
  for (const [need, have, miss] of [[3, 0, 3], [5, 2, 3], [1, 0, 1]]) {
    const st = stateWithActivity(activityOf({ questions: Array.from({ length: have }, (_, i) => `q${i}`) }),
      { config: { mode: 'deny', minQuestionsBeforeWrite: need } });
    const r = decide(INPUT(), st);
    assert.equal(r.action, 'deny');
    assert.match(r.output.hookSpecificOutput.permissionDecisionReason, new RegExp(`还差 ${miss} 个`));
  }
});

test('这条判据同样受刹车约束：halt 给 continue:false，budget 前 N 次不刹车', () => {
  const act = activityOf({ questions: [] });
  const haltOut = decide(INPUT(), stateWithActivity(act, { config: { mode: 'deny', minQuestionsBeforeWrite: 3, brake: 'halt' } }));
  assert.equal(haltOut.action, 'deny');
  assert.equal(haltOut.output.continue, false);
  assert.match(String(haltOut.output.stopReason), /问/);
  const soft = decide(INPUT(), stateWithActivity(act,
    { config: { mode: 'deny', minQuestionsBeforeWrite: 3, brake: 'budget', denyBudget: 2 }, denials: 0 }));
  assert.equal(soft.action, 'deny');
  assert.equal(soft.output.continue, undefined);
});

test('observe / warn 两档对这条判据同样不拦，且 warn 的 additionalContext 是可执行指令', () => {
  const act = activityOf({ questions: [] });
  const obs = decide(INPUT(), stateWithActivity(act, { config: { mode: 'observe', minQuestionsBeforeWrite: 3 } }));
  assert.equal(obs.action, 'passthrough');
  assert.equal(obs.log.decision, 'would-deny');
  assert.match(obs.log.reason, /还差 3 个/);
  const warn = decide(INPUT(), stateWithActivity(act, { config: { mode: 'warn', minQuestionsBeforeWrite: 3 } }));
  assert.equal(warn.action, 'warn');
  assert.match(warn.output.hookSpecificOutput.additionalContext, /还差 3 个/);
});

// ── 10.6 transcript 里真的数出「问了几个」──────────────────────────────

test('readTranscriptActivity：按 tool_use id 去重、同一问题只算一个、ExitPlanMode 算一个', () => {
  const dir = sandbox();
  try {
    const p = join(dir, 't.jsonl');
    const line = (id, name, input) => JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] },
    });
    // 写调用的 `tool_result`：`priorWriteCalls` 现在只数**真落盘**的写（见 §两次修正）。
    const result = (id, isError = false) => JSON.stringify({
      type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] },
    });
    writeFileSync(p, [
      line('a1', 'AskUserQuestion', { questions: [{ question: '改哪个文件？' }] }),
      line('a1', 'AskUserQuestion', { questions: [{ question: '改哪个文件？' }] }), // 宿主重写的重复行
      line('a2', 'AskUserQuestion', { questions: [{ question: '改哪个文件？' }] }), // 同一个问题再问一次
      line('a3', 'AskUserQuestion', { questions: [{ question: '用 A 还是 B？' }, { question: '验收用哪条命令？' }] }),
      line('e1', 'ExitPlanMode', { plan: 'x' }),
      line('w1', 'Write', { file_path: join(dir, 'out.txt') }),
      result('w1'),                                                              // 真写成了
      line('w2', 'Write', { file_path: join(dir, 'denied.txt') }),
      result('w2', true),                                                        // 被拒，文件没写
      line('w3', 'Write', { file_path: join(dir, 'pending.txt') }),              // 本次调用：还没 result
      line('r1', 'Read', { file_path: join(dir, 'README.md') }),
    ].join('\n') + '\n');
    const act = readTranscriptActivity(p, { cwd: dir });
    assert.equal(act.askCalls, 4, '按 id 去重后是 4 次调用（a1/a2/a3/e1）');
    assert.equal(act.unknownAskCalls, 0);
    // `questions` 是**去重后的问题原文**（同一个问题换个标点仍算同一个，
    // 因为比较用的是 `normalizeText()` 之后的键）。
    assert.equal(act.questions.length, 4, `去重后 4 个问题，实际：${JSON.stringify(act.questions)}`);
    assert.equal(act.questions.filter((q) => q === '改哪个文件？').length, 1,
      '同一个问题问两遍只能留下一条，否则「重复问」会把门槛刷过去');
    assert.ok(act.questions.includes('ExitPlanMode'), 'ExitPlanMode 也算一次提问（与 question-audit 同口径）');
    assert.equal(act.distinctQuestions, 4);
    // ── `priorWriteCalls` 的三态（2026-11-19，验收第 1 条）────────────────
    // w1 写成 → 算；w2 被拒（is_error）→ 不算；w3 本次调用（无 result）→ 不算。
    assert.equal(act.priorWriteCalls, 1,
      '只有真落盘的写算「之前写过」：本次调用（无 result）与被拒的写（is_error）都不算');
    assert.deepEqual(act.reads, [join(dir, 'README.md')]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readTranscriptActivity 读不到文件 → 空结构、不抛（fail-open 的底座）', () => {
  const act = readTranscriptActivity('/nonexistent-ow-transcript.jsonl');
  assert.deepEqual(act.reads, []);
  assert.equal(act.distinctQuestions, 0);
  assert.equal(act.priorWriteCalls, 0);
  assert.equal(act.bytesRead, 0);
});

test('runHook：env 覆盖 minQuestionsBeforeWrite（OW_ASK_MIN_QUESTIONS）真生效', () => {
  const dir = sandbox();
  try {
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, [
      toolUseLine('Read', { file_path: join(dir, 'README.md') }),
      toolUseLine('Read', { file_path: join(dir, 'src/a.mjs') }),
      toolUseLine('Read', { file_path: join(dir, 'src/b.mjs') }),
    ].join('\n') + '\n');
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny', OW_ASK_MIN_QUESTIONS: '3' });
    const out = runHook(INPUT({ cwd: dir, transcript_path: tp }), { env });
    assert.equal(out.action, 'deny', '读过 3 个文件但一个问题没问 → 必须拦');
    assert.match(out.output.hookSpecificOutput.permissionDecisionReason, /还差 3 个/);
    assert.equal(existsSync(markerPathFor(dir)), false, '被拒的写不许留下标记');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runHook：问够了就照旧写标记放行（auto，签名可验）', () => {
  const dir = sandbox();
  try {
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, [
      toolUseLine('Read', { file_path: join(dir, 'README.md') }),
      toolUseLine('Read', { file_path: join(dir, 'src/a.mjs') }),
      toolUseLine('Read', { file_path: join(dir, 'src/b.mjs') }),
      toolUseLine('AskUserQuestion', { questions: [{ question: 'Q1' }, { question: 'Q2' }, { question: 'Q3' }] }),
    ].join('\n') + '\n');
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny', OW_ASK_MIN_QUESTIONS: '3' });
    const out = runHook(INPUT({ cwd: dir, transcript_path: tp }), { env });
    assert.equal(out.action, 'allow');
    assert.equal(readMarker(markerPathFor(dir)).data.satisfied_by, 'auto');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runHook：PAUSE 文件存在时这条判据也不拦', () => {
  const dir = sandbox();
  try {
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, toolUseLine('Read', { file_path: join(dir, 'README.md') }) + '\n');
    const pause = join(dir, 'gate.PAUSE');
    writeFileSync(pause, '');
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny', OW_ASK_MIN_QUESTIONS: '3', OVERWATCH_STOP_VERIFY_PAUSE: pause });
    const out = runHook(INPUT({ cwd: dir, transcript_path: tp }), { env });
    assert.equal(out.action, 'passthrough');
    assert.equal(out.log.allowReason, 'user-paused');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('minQuestionsBeforeWriteOf：env > overwatch.config.json > 0，垃圾一律回落到 0', () => {
  const dir = sandbox();
  try {
    const cfgFile = join(dir, 'overwatch.config.json');
    writeFileSync(cfgFile, JSON.stringify({ version: 1, ask: { mode: 'always', minQuestionsBeforeWrite: 4 } }));
    assert.equal(minQuestionsBeforeWriteOf({}, { configFile: cfgFile }), 4);
    assert.equal(minQuestionsBeforeWriteOf({ OW_ASK_MIN_QUESTIONS: '2' }, { configFile: cfgFile }), 2,
      'env 覆盖文件');
    assert.equal(minQuestionsBeforeWriteOf({ OW_ASK_MIN_QUESTIONS: 'abc' }, { configFile: cfgFile }), 4,
      '非法 env 不许把配置整体关掉');
    writeFileSync(cfgFile, '{ 坏 json');
    assert.equal(minQuestionsBeforeWriteOf({}, { configFile: cfgFile }), 0, '配置是垃圾 → 0（放行）');
    writeFileSync(cfgFile, JSON.stringify({ version: 1, ask: { minQuestionsBeforeWrite: -3 } }));
    assert.equal(minQuestionsBeforeWriteOf({}, { configFile: cfgFile }), 0);
    assert.equal(minQuestionsBeforeWriteOf({}, { configFile: join(dir, 'nope.json') }), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reasonForQuestions：说的是可判定的条件，不是「请多提问」', () => {
  const r = reasonForQuestions({ cwd: '/repo', need: 3, have: 1, halt: false });
  assert.match(r, /还差 2 个/);
  assert.match(r, /同一个问题重复问只算 1 个/);
  assert.match(r, /改哪些文件|范围/);
  assert.match(r, /重试/);
  assert.doesNotMatch(r, /请多提问|多问问用户/);
  // 2026-11-19（验收第 5 条）：那条「明说理由然后重试」是**永远失败**的指令，
  // 必须消失。它不是「写了不好看」，是让模型照做一次就白跑一轮。
  assert.doesNotMatch(r, /明说理由/);
  // 「事后可审计」必须指向一个真落地物：现在台账里有 `reason` 原文字段。
  assert.match(r, /审计/);
  assert.doesNotMatch(r, /在 reason 里留下这一条/, 'reason 原文进台账才是落地物，不是留在 reason 里');
});

test('e2e：OW_ASK_MIN_QUESTIONS=2 时 hook 真的输出 deny，且 continue:false', () => {
  const dir = sandbox();
  try {
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, [
      toolUseLine('Read', { file_path: join(dir, 'README.md') }),
      toolUseLine('Read', { file_path: join(dir, 'src/a.mjs') }),
      toolUseLine('Read', { file_path: join(dir, 'src/b.mjs') }),
    ].join('\n') + '\n');
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny', OW_ASK_MIN_QUESTIONS: '2' });
    const r = runHookProcess(INPUT({ cwd: dir, transcript_path: tp, tool_use_id: 'toolu_q' }), env);
    assert.equal(r.status, 0, `hook 必须永远 exit 0：${r.stderr}`);
    const o = JSON.parse(r.stdout);
    assert.equal(o.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(o.continue, false);
    assert.match(o.hookSpecificOutput.permissionDecisionReason, /还差 2 个/);
    // 同一份输入再跑一次（模拟「问完重试」前的那次重复触发）不该有两行台账
    const rows = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].denyBy, 'questions');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 11. 端到端：真的 spawn 那个 hook ─────────────────────────────────

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'pre-write-gate.mjs');

/** 真正把 hook 当子进程跑：stdin 进 JSON，收 stdout。 */
function runHookProcess(input, env = {}, extraArgs = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

test('e2e：hook 在默认模式下退出 0 且不输出', () => {
  const dir = sandbox();
  try {
    const r = runHookProcess(INPUT({ cwd: dir }), envIn(dir));
    assert.equal(r.status, 0, `hook 崩溃了：${r.stderr}`);
    assert.equal(r.stdout, '', 'passthrough 时 stdout 必须为空 —— 输出 allow 会参与多 hook 合并');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('e2e：hook 在 deny 模式下输出合法 JSON 且带 continue:false', () => {
  const dir = sandbox();
  try {
    const r = runHookProcess(INPUT({ cwd: dir }), envIn(dir, { OW_PRE_WRITE_GATE: 'deny' }));
    assert.equal(r.status, 0, `hook 必须永远 exit 0（exit 2 不拦截，实测 D3）：${r.stderr}`);
    const o = JSON.parse(r.stdout);
    assert.equal(o.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(o.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(o.continue, false);
    assert.equal(existsSync(markerPathFor(dir)), false, '被拒的写不该留下任何东西');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('e2e：垃圾输入 → exit 0、无输出（fail-open）', () => {
  const dir = sandbox();
  try {
    const r = runHookProcess('not json at all', envIn(dir, { OW_PRE_WRITE_GATE: 'deny' }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('e2e：标记存在时 hook 完全静默', () => {
  const dir = sandbox();
  try {
    writeMarker(markerPathFor(dir), { sessionId: 'sess-1', satisfiedBy: 'auto', reads: 3 });
    const r = runHookProcess(INPUT({ cwd: dir }), envIn(dir, { OW_PRE_WRITE_GATE: 'deny' }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('e2e：mark 子命令写出标记，之后 hook 放行（完整闭环）', () => {
  const dir = sandbox();
  try {
    const log = join(dir, 'log.jsonl');
    // 1) 先拦
    const before = runHookProcess(INPUT({ cwd: dir }), envIn(dir, { OW_PRE_WRITE_GATE: 'deny' }));
    assert.equal(JSON.parse(before.stdout).hookSpecificOutput.permissionDecision, 'deny');
    // 2) 照 reason 跑 mark
    const marked = runHookProcess('', envIn(dir), ['mark', '--session', 'sess-1', '--cwd', dir]);
    assert.equal(marked.status, 0, marked.stderr);
    assert.equal(existsSync(markerPathFor(dir)), true);
    assert.match(marked.stdout, /标记已写入/);
    // 3) 再写，放行
    const after = runHookProcess(INPUT({ cwd: dir }), envIn(dir, { OW_PRE_WRITE_GATE: 'deny' }));
    assert.equal(after.stdout, '', '标记存在后必须静默放行');
    // 4) 标记里记的是「自己说的」，不是「验出来的」
    assert.equal(readMarker(markerPathFor(dir)).data.satisfied_by, 'claim');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('e2e：status 子命令读得懂现状', () => {
  const dir = sandbox();
  try {
    const a = runHookProcess('', {}, ['status', '--cwd', dir]);
    assert.equal(a.status, 0);
    assert.match(a.stdout, /marker state: absent/);
    // 这一行是「配置项有没有执行侧」的唯一可见处：写了 3 却看到 0，就是配置没接上。
    assert.match(a.stdout, /minQuestions: 0（这条判据不启用）/);
    writeMarker(markerPathFor(dir), { sessionId: 's1', satisfiedBy: 'claim' });
    const b = runHookProcess('', {}, ['status', '--cwd', dir]);
    assert.match(b.stdout, /marker state: exists/);
    assert.match(b.stdout, /claim/);
    // env 覆盖也要在这里看得出来
    const c = runHookProcess('', { OW_ASK_MIN_QUESTIONS: '4' }, ['status', '--cwd', dir]);
    assert.match(c.stdout, /minQuestions: 4（第一次写之前必须先问够这么多个不同问题）/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('e2e：cli 未知子命令返回 2', () => {
  assert.equal(cli(['nope'], {}), 2);
});

// ── 12. 硬约束的回归护栏 ─────────────────────────────────────────────

test('源码里不存在以 exit code 表达拒绝的路径', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  // 只允许 exit(0) / exit(cli(...)) / exit(2)（未知子命令的用法错误，不是拦截）
  const exits = [...src.matchAll(/process\.exit\(([^)]*)\)/g)].map((m) => m[1].trim());
  for (const e of exits) {
    assert.ok(e === '0' || e === '2' || e.startsWith('cli('), `出现了意外的 exit(${e}) —— exit 2 在 PreToolUse 上不拦截`);
  }
});

test('模板里的 matcher 覆盖五个工具名，且引用了本脚本', () => {
  const tpl = JSON.parse(readFileSync(join(dirname(SCRIPT), '..', 'templates', 'pre-write-gate.settings.json'), 'utf8'));
  const hooks = tpl.hooks.PreToolUse;
  assert.ok(Array.isArray(hooks) && hooks.length >= 1);
  const matcher = hooks[0].matcher;
  for (const n of ['Write', 'Edit', 'NotebookEdit', 'Bash', 'PowerShell']) {
    assert.ok(matcher.split('|').includes(n), `模板 matcher 缺 ${n}`);
  }
  const hook = hooks[0].hooks[0];
  assert.match(hook.command, /pre-write-gate\.mjs/);
  assert.equal(hook.shell, 'powershell', 'Windows 上不写 shell 会让 exit 语义被 fallback 改写');
  assert.ok(Number(hook.timeout) >= 5, 'timeout 低于 5 秒会被宿主静默 kill');
});

test('模板默认不带 OW_PRE_WRITE_GATE=deny（默认必须是最保守的）', () => {
  const tpl = JSON.parse(readFileSync(join(dirname(SCRIPT), '..', 'templates', 'pre-write-gate.settings.json'), 'utf8'));
  const env = JSON.stringify(tpl.env || {});
  assert.doesNotMatch(env, /OW_PRE_WRITE_GATE"\s*:\s*"deny"/, '模板里预置 deny 等于默认就拦');
});

// ── 13. `DF-029`：同一次工具调用被触发两次时，只判一次、只记一行 ──────────
//
// 场景是真实存在的：`.claude/settings.local.json` 注册了本 hook，`overwatch launch`
// 又用 `--settings` 注入同名一条，宿主的实测行为是**叠加**。于是同一次工具调用
// 会起两个本进程，两者 stdin 逐字相同（实测见 `docs/research/` 的 PreToolUse 契约）。
//
// 这几条测试的判据是**可观测的量**：台账行数、刹车计数、标记文件的 mtime。
// 不看代码里有没有 `if`。

test('DF-029：同一 tool_use_id 被触发两次 → 台账 1 行、刹车计数 1、第二次静默', () => {
  const dir = sandbox();
  try {
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny' });
    const input = INPUT({ cwd: dir, tool_use_id: 'toolu_once' });

    const first = runHook(input, { env });
    assert.equal(first.action, 'deny', '第一次必须真的判定并拦');
    assert.equal(first.duplicate, undefined, '第一次不是重复');

    const second = runHook(input, { env });
    assert.equal(second.action, 'passthrough', '第二次必须静默放行');
    assert.equal(second.output, null, '第二次不许往 stdout 写任何东西（会参与多 hook 合并）');
    assert.equal(second.duplicate, true, '必须能被识别为重复');
    assert.equal(second.log, null, '第二次不许记账');

    // 台账：1 行（修复前是 2 行）
    const rows = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1, '台账行数就是统计的分母，翻倍会让比例全错');

    // 刹车计数：1（修复前是 2 —— 一次真实拒绝被记成两次，denyBudget 提前用光）
    assert.equal(bumpDenials(denialPathFor(dir), 'prompt-1', { readOnly: true }), 1,
      '刹车计数翻倍会让 denyBudget 提前用完');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-029 的负向：不同的 tool_use_id 必须各自判定（去重不许吞掉真调用）', () => {
  const dir = sandbox();
  try {
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny' });
    // 同一回合内连写两个文件 = 两次真调用，tool_use_id 不同
    const a = runHook(INPUT({ cwd: dir, tool_use_id: 'toolu_1', tool_input: { file_path: join(dir, 'a.txt'), content: 'x' } }), { env });
    const b = runHook(INPUT({ cwd: dir, tool_use_id: 'toolu_2', tool_input: { file_path: join(dir, 'b.txt'), content: 'x' } }), { env });
    assert.equal(a.action, 'deny');
    assert.equal(b.action, 'deny', '第二次真调用不许被当成重复而放行');
    const rows = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n');
    assert.equal(rows.length, 2, '两次真调用必须两行台账');
    assert.equal(bumpDenials(denialPathFor(dir), 'prompt-1', { readOnly: true }), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-029：重复触发不会重写标记文件（否则 mtime 会跳，Auto 标记的 at 也会变）', () => {
  const dir = sandbox();
  try {
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny' });
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, [
      toolUseLine('Read', { file_path: join(dir, 'README.md') }),
      toolUseLine('Read', { file_path: join(dir, 'src/a.mjs') }),
      toolUseLine('Read', { file_path: join(dir, 'src/b.mjs') }),
    ].join('\n') + '\n');
    const input = INPUT({ cwd: dir, transcript_path: tp, tool_use_id: 'toolu_mark' });

    const t0 = 1_700_000_000_000;
    assert.equal(runHook(input, { env, nowMs: t0 }).action, 'allow');
    const m1 = readFileSync(markerPathFor(dir), 'utf8');

    // 第二次（同 id，晚 500ms）：必须完全不碰盘
    const second = runHook(input, { env, nowMs: t0 + 500 });
    assert.equal(second.action, 'passthrough');
    assert.equal(second.markWrite, null, '重复触发不许再写一次标记');
    assert.equal(readFileSync(markerPathFor(dir), 'utf8'), m1, '标记内容逐字不变');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-029：缺 tool_use_id 时放弃去重、照常判定（不拿半个键去猜）', () => {
  const dir = sandbox();
  try {
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny' });
    const input = INPUT({ cwd: dir, tool_use_id: undefined });
    const a = runHook(input, { env });
    const b = runHook(input, { env });
    assert.equal(a.action, 'deny');
    assert.equal(b.action, 'deny', '没有 tool_use_id 就不许去重');
    assert.equal(readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-029：重复触发真的省掉了判定（transcript 只被读一次）', () => {
  // 判据不是计时（那在 CI 上不稳），而是**可观测的副作用次数**：
  // 让 transcript 指向一个目录（读必失败），两次调用后检查只有一份认领文件、
  // 且第二次返回的是 passthrough 而不是「按读不到处理」的 passthrough。
  const dir = sandbox();
  try {
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny' });
    const input = INPUT({ cwd: dir, transcript_path: dir, tool_use_id: 'toolu_two_pass' });
    const a = runHook(input, { env });
    const b = runHook(input, { env });
    assert.equal(a.log.decision, 'deny', '第一次走完整判定');
    assert.equal(b.duplicate, true);
    assert.equal(b.log, null);
    // 跳过记录单独一个文件，不进台账
    const skipped = join(dir, 'dedupe', 'pre-write-gate', 'skipped.jsonl');
    assert.equal(existsSync(skipped), true, '跳过必须留痕，否则无法判断去重有没有真的触发');
    assert.equal(readFileSync(skipped, 'utf8').trim().split('\n').length, 1);
    assert.equal(readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').length, 1,
      '跳过记录**不许**混进台账');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-029：端到端 —— 同一个 stdin 喂两个进程，只有一行台账', () => {
  const dir = sandbox();
  try {
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny' });
    const input = INPUT({ cwd: dir, tool_use_id: 'toolu_e2e' });
    const a = runHookProcess(input, env);
    const b = runHookProcess(input, env);
    assert.equal(JSON.parse(a.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(b.stdout, '', '第二个进程必须完全静默（否则宿主会看到两条 deny）');
    const rows = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n');
    assert.equal(rows.length, 1, `两个进程必须只记一行，实测 ${rows.length}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 11. 2026-11-19 验收判 FAIL 的六条：每条先红后绿的负向对照 ────────────
//
// 这一段是 `DF-038` 的回归网。六条缺陷里有五条的共同形状是
// **「看起来验过了，实际没验到」**（`DF-031` 的同一类）：测试注入了真实宿主里
// 不存在的状态，于是判据「通过」了但一次都没执行。
// 所以这里的用例一律**从 transcript 文件出发**，不用 `activityOf()` 造数据 ——
// 夹具本身曾经就是那个 bug。

/** 造一份「读够 N 个文件」的 transcript 行序列。 */
const readLines = (dir, n = 3) => Array.from({ length: n }, (_, i) =>
  toolUseLine('Read', { file_path: join(dir, `f${i}.mjs`) }));
const writeUse = (id, dir, name = 'out.txt') =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: join(dir, name), content: 'x' } }] } });
const toolResult = (id, isError = false) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } });

test('DF-038 第 1 条（甲）：本次调用自身的 tool_use 在 transcript 里，不算「之前写过」', () => {
  // 真宿主实测形态（2026-11-19，mock 模型 + 真 claude.exe）：
  // hook 触发时本次 Write 的 tool_use **已经落盘**，还没有 tool_result。
  const dir = sandbox();
  try {
    const tp = join(dir, 't.jsonl');
    writeFileSync(tp, [...readLines(dir), writeUse('tu_self', dir)].join('\n') + '\n');
    const act = readTranscriptActivity(tp, { cwd: dir });
    assert.equal(act.priorWriteCalls, 0,
      '没有 tool_result 的写是本次调用，不是「之前」——数成 1 会让判据永远不执行');
    // 端到端：这条 transcript 必须被拦，拦它的是 questions 判据。
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny', OW_ASK_MIN_QUESTIONS: '3' });
    const out = runHook(INPUT({ cwd: dir, transcript_path: tp, tool_use_id: 'tu_self' }), { env });
    assert.equal(out.action, 'deny', `读过 3 个文件、0 提问、本次写尚未执行 → 必须拦。实际 ${JSON.stringify(out.log)}`);
    assert.equal(out.log.denyBy, 'questions', '不是被读侧判据拦的 —— 那会把两条判据混为一谈');
    // 负向：给它补上 tool_result（= 真写成了），同一份输入必须放行。
    writeFileSync(tp, [...readLines(dir), writeUse('tu_done', dir), toolResult('tu_done')].join('\n') + '\n');
    const after = runHook(INPUT({ cwd: dir, transcript_path: tp, tool_use_id: 'tu_next' }), { env });
    assert.equal(after.action, 'allow', '真写成过的写 → 判据不再介入（写到一半才拦会打断活）');
    assert.equal(after.log.questions, 0, '放行原因是 priorWrites，不是「问够了」');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-038 第 1 条（乙）：被闸门拒掉的写（is_error）不算「之前写过」', () => {
  // 「拒 → 重试」是这条判据唯一的工作方式。若被拒的那次写算成「写成过」，
  // 判据就被自己的拒绝动作解除了 —— 第一次拦住、第二次放行。
  const dir = sandbox();
  try {
    const tp = join(dir, 't.jsonl');
    writeFileSync(tp, [
      ...readLines(dir),
      writeUse('tu_denied', dir), toolResult('tu_denied', true),   // 被拒，文件从未落盘
      writeUse('tu_retry', dir),                                   // 模型重试（本次调用）
    ].join('\n') + '\n');
    const act = readTranscriptActivity(tp, { cwd: dir });
    assert.equal(act.priorWriteCalls, 0, 'is_error:true 的写 = 没写成，不许当「之前写过」');
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny', OW_ASK_MIN_QUESTIONS: '3' });
    const out = runHook(INPUT({ cwd: dir, transcript_path: tp, tool_use_id: 'tu_retry' }), { env });
    assert.equal(out.action, 'deny', '重试必须照样被拦 —— 否则「拒一次就解锁」');
    assert.equal(out.log.denyBy, 'questions');
    // 负向：同样的位置，把 is_error 改成 false（真写成过）→ 必须放行。
    writeFileSync(tp, [
      ...readLines(dir),
      writeUse('tu_denied', dir), toolResult('tu_denied', false),
      writeUse('tu_retry2', dir),
    ].join('\n') + '\n');
    const ok = runHook(INPUT({ cwd: dir, transcript_path: tp, tool_use_id: 'tu_retry2' }), { env });
    assert.equal(ok.action, 'allow', '写成了 → 判据不再介入。这条负向证明上一条不是「永远 deny」');
    // 老格式没有 is_error 字段：按成功算（方向宽松，与全文件 fail-open 一致）
    writeFileSync(tp, [
      ...readLines(dir),
      writeUse('tu_old', dir),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_old' }] } }),
      writeUse('tu_retry3', dir),
    ].join('\n') + '\n');
    assert.equal(readTranscriptActivity(tp, { cwd: dir }).priorWriteCalls, 1, '缺 is_error 按成功算');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-038 第 4 条：提问落在尾部 1MB 之外时长会话不得永久锁死', () => {
  // 本机实测：172 个 >1MB 会话里 49 个的提问全部在尾部 1MB 之外（最大 102.9MB）。
  // 那种会话 `have < need` 恒成立，halt 下每次拒都结束回合 —— 用户没有出路。
  const dir = sandbox();
  try {
    const tp = join(dir, 't.jsonl');
    const asks = [
      toolUseLine('AskUserQuestion', { questions: [{ question: 'Q1' }, { question: 'Q2' }, { question: 'Q3' }] }),
    ];
    // 填足够多的无关行，把提问推到尾部 1MB 之外。每行约 120 字节 → ~12000 行 ≈ 1.4MB
    const filler = Array.from({ length: 12000 }, () =>
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'x'.repeat(80) }] } }));
    writeFileSync(tp, [...asks, ...filler].join('\n') + '\n');
    const size = statSync(tp).size;
    assert.ok(size > 1024 * 1024, `夹具必须真的跨过 1MB 窗口（实测 ${size} 字节）`);

    // 单块：提问滑出窗口 → 读不到（这是缺陷的形态）
    const oneChunk = readTranscriptActivity(tp, { cwd: dir, need: 0 });
    assert.equal(oneChunk.distinctQuestions, 0, '前提：一带窗口确实读不到');
    // 回扫：`need>0` 才会回扫 → 必须数到 3 个
    const scanned = readTranscriptActivity(tp, { cwd: dir, need: 3 });
    assert.equal(scanned.distinctQuestions, 3, `回扫必须找到窗口外的问题，实际 ${scanned.distinctQuestions}`);
    assert.equal(scanned.truncated, false, '全文都扫到了 → 不算截断');
    assert.ok(scanned.chunks > 1, '确实分了多块读');

    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny', OW_ASK_MIN_QUESTIONS: '3' });
    const out = runHook(INPUT({ cwd: dir, transcript_path: tp }), { env });
    // 这条测试只关心**提问判据**有没有被永久锁死，读侧判据是另一回事：
    // 所以断言「不是被 questions 拦的」，而不是「一定是 allow」——
    // 夹具里没有读取记录，读侧判据照旧生效（那是对的）。
    assert.notEqual(out.log.denyBy, 'questions',
      `提问已满足，不许再以 questions 为由拒绝。实际日志：${JSON.stringify(out.log).slice(0, 300)}`);
    assert.equal(out.log.questions, 3, '回扫出来的问题数必须进日志');
    // 负向：把回扫上限压到 4KB（= 改前只有一块窗口的行为），同一条 transcript
    // 必须**扫不到**提问。它这时不是去拦，而是 `truncated` → 放行并留痕 ——
    // 「没读到」永远不许变成「没问过」。这条证明上面那个 `questions: 3`
    // 确实来自回扫，而不是判据根本没工作。
    const noScan = runHook(INPUT({ cwd: dir, transcript_path: tp, tool_use_id: 'tu_noscan' }), {
      env: envIn(dir, {
        OW_PRE_WRITE_GATE: 'deny', OW_ASK_MIN_QUESTIONS: '3',
        OW_PRE_WRITE_GATE_TRANSCRIPT_BYTES: '4096', OW_PRE_WRITE_GATE_TRANSCRIPT_SCAN_BYTES: '4096',
      }),
    });
    assert.equal(typeof noScan.log.questions, 'string', `扫不到时不报数字，报状态：${noScan.log.questions}`);
    assert.match(String(noScan.log.questions), /^truncated-after-\d+-chunks$/,
      '上限之内读不到 → 报 truncated，不报一个假的 0');
    assert.equal(noScan.log.denyBy, undefined, 'truncated 时不许以 questions 为由拒绝');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-038 第 4 条（负向）：回扫到上限仍不够 → 必须放行，不许拿「没读到」当「没问过」', () => {
  const dir = sandbox();
  try {
    const tp = join(dir, 't.jsonl');
    const filler = Array.from({ length: 12000 }, () =>
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'x'.repeat(80) }] } }));
    // 提问在**最开头**，而回扫上限被设得很小 → 扫不到
    writeFileSync(tp, [
      toolUseLine('AskUserQuestion', { questions: [{ question: 'Q1' }] }),
      ...filler,
    ].join('\n') + '\n');
    const act = readTranscriptActivity(tp, { cwd: dir, need: 3, maxScanBytes: 64 * 1024 });
    assert.equal(act.distinctQuestions, 0, '前提：上限之内确实读不到');
    assert.equal(act.truncated, true, '还有没扫到的内容 → 必须报 truncated');
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny', OW_ASK_MIN_QUESTIONS: '3', OW_PRE_WRITE_GATE_TRANSCRIPT_SCAN_BYTES: '65536' });
    const out = runHook(INPUT({ cwd: dir, transcript_path: tp }), { env });
    assert.notEqual(out.log.denyBy, 'questions', 'truncated 时放行 —— 不知道就不许判');
    assert.equal(out.log.scanTruncated, true, '放行必须留痕：这不是正常放行，是被迫放行');
    // 负向：把上限放到够大，同一份输入必须**能读到**那个问题（证明上面是「上限」而非「实现读不到」）
    const enough = readTranscriptActivity(tp, { cwd: dir, need: 3, maxScanBytes: 8 * 1024 * 1024 });
    assert.equal(enough.distinctQuestions, 1);
    assert.equal(enough.truncated, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-038 第 6 条：子 agent（有 agent_id）不参与提问判据', () => {
  // `.claude/agents/oversight-executor.md` / `oversight-repair.md` 的工具白名单
  // 里**没有** AskUserQuestion。被拒后它物理上做不到 reason 要求的事，
  // 而 brake=halt 直接结束回合 —— 子 agent 的工作永远不会完成。
  const dir = sandbox();
  try {
    const tp = join(dir, 't.jsonl');
    writeFileSync(tp, [...readLines(dir)].join('\n') + '\n');
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny', OW_ASK_MIN_QUESTIONS: '3' });
    // 主线程：必须拦
    const main = runHook(INPUT({ cwd: dir, transcript_path: tp, tool_use_id: 'tu_main' }), { env });
    assert.equal(main.action, 'deny', '前提：主线程同一份输入必须被拦');
    // 负向：agent_id 为空串**不算**子 agent（宿主不给这个字段时是 undefined，
    // 但要防「给了空值」被当成豁免令）。这一条必须排在子 agent 那条**之前**：
    // 子 agent 那次会因读侧判据满足而写标记，之后同一会话就都是 marker-present 了。
    const empty = runHook(INPUT({ cwd: dir, transcript_path: tp, tool_use_id: 'tu_empty', agent_id: '' }), { env });
    assert.equal(empty.action, 'deny', '空 agent_id 不是子 agent');
    assert.equal(empty.log.denyBy, 'questions');
    // 子 agent：放行（同一份 transcript、同一份配置，只有 agent_id 不同）
    const sub = runHook(INPUT({ cwd: dir, transcript_path: tp, tool_use_id: 'tu_sub', agent_id: 'a51d9b20e2a5aa243', agent_type: 'general-purpose' }), { env });
    assert.notEqual(sub.action, 'deny', '子 agent 不许被这条判据硬锁');
    assert.equal(sub.log.questions, 'subagent-exempt', '放行原因必须写进日志，不能静默放行');
    assert.equal(sub.log.agentId, 'a51d9b20e2a5aa243', '日志要能指到是哪个子 agent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-038 第 7 条：块边界不得静默丢整行（文件 1MB+小数、问题在开头）', () => {
  // 第二轮验收判 FAIL 的致命缺陷：`readTranscriptActivity()` 只对每块**首行**做
  // `shift()`。块起点不落在行首时，被切开的那一行同时是上一块的末行 —— 两半各自
  // `JSON.parse` 失败、整条记录消失，`truncated` 还报 `false`。
  //
  // 端到端复现形态：文件**略大于** 1 MB（1 MB + 98 字节），三个问题都在文件开头。
  // 尾块正好覆盖整个文件，于是 `atFileStart` 为真、不 `shift()`，而块首那 98 字节
  // 是 `AskUserQuestion` 行的**后半截**（它前面没有换行）→ 头块切在行中间。
  // 改前：`q=0 / truncated=false / unparsable=2` → 端到端**误拦**。
  const dir = sandbox();
  try {
    const tp = join(dir, 't.jsonl');
    const ask = toolUseLine('AskUserQuestion', {
      questions: [{ question: 'Q1：改哪个文件？' }, { question: 'Q2：用什么验收？' }, { question: 'Q3：不碰哪些？' }],
    });
    const MB = 1024 * 1024;
    // 填充行做**短**（~15 字节）：粒度够细才能把「超出 1MB 的那几个字节」精确
    // 压在 (0, ask 行长度) 里 —— 那才是头块切在行中间的形态。
    const filler = (i) => '{"i":' + i + '}';
    const body = [];
    let n = 0;
    const push = (l) => { body.push(l); n += Buffer.byteLength(l) + 1; };
    push(ask);
    for (let i = 0; n < MB + Math.floor(Buffer.byteLength(ask) / 2); i++) push(filler(i));
    writeFileSync(tp, body.join('\n') + '\n');
    const size = statSync(tp).size;
    assert.ok(size > MB && size - MB < Buffer.byteLength(ask),
      `夹具必须让头块切在 ask 行中间（size=${size}，1MB=${MB}，ask 行 ${Buffer.byteLength(ask)} 字节）`);

    const act = readTranscriptActivity(tp, { cwd: dir, need: 3 });
    assert.equal(act.chunks, 2, '确实跨了两块');
    assert.equal(act.distinctQuestions, 3,
      `块边界切开的那一行必须被拼回来完整解析一次，实际数到 ${act.distinctQuestions} 个（unparsable=${act.unparsable}）`);
    assert.equal(act.unparsable, 0, `块边界对齐到行首后，正常行不该有一行 parse 失败（实际 ${act.unparsable}）`);
    assert.equal(act.truncated, false, '全文都读到了 → 不是截断');

    // 端到端：改前这里是 deny（误拦）。问题在最开头、真值 3 ≥ need 3 → 必须**不**以 questions 为由拒绝。
    const env = envIn(dir, { OW_PRE_WRITE_GATE: 'deny', OW_ASK_MIN_QUESTIONS: '3' });
    const out = runHook(INPUT({ cwd: dir, transcript_path: tp, tool_use_id: 'tu_split' }), { env });
    assert.notEqual(out.log.denyBy, 'questions',
      `问题真值 3 ≥ 3，不许以 questions 为由拒绝。实际日志：${JSON.stringify(out.log).slice(0, 300)}`);
    assert.equal(out.log.questions, 3, '数到的问题数必须进日志（不是 truncated 之后的被迫放行）');
    assert.equal(out.log.scanTruncated, undefined, '这不是被迫放行');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-038 第 7 条（负向）：把块首那半行丢掉不补 → 同一份夹具必须变红', () => {
  // 负向验证「上面那条不是空断言」：把边界对齐拆掉（退化成旧的「只 shift() 首行」），
  // 同一份夹具必须数不到那三个问题。这里不复用实现，而是**直接算出两种读数**：
  // 按旧口径手工切块、数 `unparsable`，证明被切开的那一行确实解析失败。
  const dir = sandbox();
  try {
    const tp = join(dir, 't.jsonl');
    const ask = toolUseLine('AskUserQuestion', { questions: [{ question: 'A1' }, { question: 'A2' }, { question: 'A3' }] });
    const MB = 1024 * 1024;
    const filler = (i) => JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'y'.repeat(80) + i }] } });
    const parts = [ask];
    let n = Buffer.byteLength(ask) + 1;
    for (let i = 0; n < MB + 40; i++) { const l = filler(i); parts.push(l); n += Buffer.byteLength(l) + 1; }
    const text = parts.join('\n') + '\n';
    writeFileSync(tp, text);
    const size = Buffer.byteLength(text);

    // 旧口径：头块 = [0, size-1MB)，末块 = 完整文件。两块各自 `JSON.parse` 各自的半行。
    const headPart = text.slice(0, size - MB);          // 头半段（含 ask 行的左半截）
    const tailPart = text.slice(size - MB);             // 被切开的行的右半段起头
    let oldBad = 0;
    for (const l of headPart.split('\n')) { const s = l.trim(); if (!s) continue; try { JSON.parse(s); } catch { oldBad++; } }
    assert.ok(!tailPart.startsWith('\n'), '前提：边界确实切在一行中间（右半段不是以换行开头）');
    assert.ok(oldBad >= 1, `旧口径下被切开的那一行必须 parse 失败（实际 ${oldBad}）——这条负向才成立`);
    // 新实现必须把它拼回来。
    const act = readTranscriptActivity(tp, { cwd: dir, need: 3 });
    assert.equal(act.distinctQuestions, 3, '新实现必须数到 3');
    assert.equal(act.unparsable, 0, '新实现不该有任何 parse 失败');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-038 第 8 条：`need` 满足即停（早停不是死代码）', () => {
  // 第二轮验收的第 2 个致命缺陷：`out.distinctQuestions` 只在循环外赋值，
  // 循环内读到的永远是初值 0 → 早停永不成立、每次扫满 `maxScanBytes`。
  // 文档「`need` 满足即停，常见情况只付 1MB」在改前是假的。
  const dir = sandbox();
  try {
    const tp = join(dir, 't.jsonl');
    const MB = 1024 * 1024;
    const parts = [toolUseLine('AskUserQuestion', {
      questions: [{ question: 'B1' }, { question: 'B2' }, { question: 'B3' }],
    })];
    let n = Buffer.byteLength(parts[0]) + 1;
    // 造一个 4 MB 的文件。问题在**文件末尾**（尾块就能满足 need=3）→ 必须一块就停。
    for (let i = 0; n < 4 * MB; i++) {
      const l = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'z'.repeat(80) + i }] } });
      parts.push(l); n += Buffer.byteLength(l) + 1;
    }
    parts.push(toolUseLine('AskUserQuestion', {
      questions: [{ question: 'B1' }, { question: 'B2' }, { question: 'B3' }],
    }));
    writeFileSync(tp, parts.join('\n') + '\n');
    const size = statSync(tp).size;
    assert.ok(size > 4 * MB, `夹具必须明显大于窗口（${size}）`);

    const act = readTranscriptActivity(tp, { cwd: dir, need: 3 });
    assert.equal(act.distinctQuestions, 3);
    assert.equal(act.chunks, 1, `尾块就够 3 个 → 必须只读一块，实际读了 ${act.chunks} 块`);
    assert.ok(act.bytesRead <= MB, `早停生效 → 只付 1MB，实际读了 ${act.bytesRead} 字节`);
    assert.equal(act.truncated, false,
      '够数是「判据所需的已确定」，不是「被迫放行」——否则修好早停会把闸门变成永不拒绝');

    // 负向：need 大于真值时必须继续回扫（否则「早停」会把「没扫完」当成「够了」）。
    const more = readTranscriptActivity(tp, { cwd: dir, need: 99 });
    assert.ok(more.chunks > 1, `need 没满足必须继续扫，实际只读了 ${more.chunks} 块`);
    assert.equal(more.truncated, false, '一直扫到文件头 → 不算截断');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-038 第 7 条兜底：有一行 parse 失败 → 必须报 truncated（不许静默丢数据）', () => {
  // 第二轮 FAIL 的根本不是「解析失败」本身，而是**失败之后还报读完了**。
  // 任何一块出现 `unparsable > 0`，`truncated` 必须为 `true`，下游据此放行。
  const dir = sandbox();
  try {
    const tp = join(dir, 't.jsonl');
    const ask = toolUseLine('AskUserQuestion', { questions: [{ question: 'C1' }] });
    // 中间插一行坏 JSON：这不是块边界的问题，是文件本身有坏行 —— 同样必须留痕。
    writeFileSync(tp, [ask, '{"broken":', toolUseLine('Read', { file_path: join(dir, 'a.mjs') })].join('\n') + '\n');
    const act = readTranscriptActivity(tp, { cwd: dir, need: 0 });
    assert.equal(act.unparsable, 1, '前提：确实有一行读不懂');
    assert.equal(act.truncated, true, '读不懂 → 必须报 truncated，不能报「读完了、没问题」');
    // 负向：把坏行拿掉，同一份夹具必须回到 truncated:false（否则这个信号就永远为真，等于没有）。
    writeFileSync(tp, [ask, toolUseLine('Read', { file_path: join(dir, 'a.mjs') })].join('\n') + '\n');
    const clean = readTranscriptActivity(tp, { cwd: dir, need: 0 });
    assert.equal(clean.unparsable, 0);
    assert.equal(clean.truncated, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-038 第 9 条：`tool_use` 与它的 `tool_result` 跨块时，`priorWriteCalls` 不得少算', () => {
  // 分块逻辑的第三个静默丢数据点（与块边界丢整行同源：各块独立解析）。
  // `ingestActivity()` 原来在**每块内**新建 `results` Map —— `tool_use` 与它的
  // `tool_result` 是两行，块边界落在两者之间时，那块永远看不到另一半，
  // `priorWriteCalls` 少算。实测（唯一 id、块 300 字节）：单块 20 笔，分块只剩 8 笔。
  const dir = sandbox();
  try {
    const tp = join(dir, 't.jsonl');
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(writeUse('tu_w' + i, dir, `f${i}.txt`));
      lines.push(toolResult('tu_w' + i));
      lines.push(toolUseLine('Read', { file_path: join(dir, `r${i}.mjs`) }));
    }
    writeFileSync(tp, lines.join('\n') + '\n');
    const size = statSync(tp).size;

    const base = readTranscriptActivity(tp, { cwd: dir, bytes: size + 10 });
    assert.equal(base.priorWriteCalls, 20, `前提：单块读得出 20 笔（实际 ${base.priorWriteCalls}）`);

    // 小到 200 字节的块：必然把很多 tool_use / tool_result 对切开。
    const chunked = readTranscriptActivity(tp, { cwd: dir, bytes: 200, need: 1e9, maxScanBytes: size + 10 });
    assert.ok(chunked.chunks > 10, `前提：确实切了很多块（${chunked.chunks}）`);
    assert.equal(chunked.priorWriteCalls, base.priorWriteCalls,
      `跨块读必须与单块逐字一致：单块 ${base.priorWriteCalls}，分块 ${chunked.priorWriteCalls}`);
    assert.deepEqual(chunked.reads.slice().sort(), base.reads.slice().sort(), 'reads 也必须一致');
    assert.equal(chunked.lines, base.lines, '解析到的行数也必须一致');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-038 第 10 条：`priorWriteCalls` 不得依赖扫描方向（写调用与 result 隔着重复副本行）', () => {
  // 第三个顺序依赖：`priorWriteCalls` 原来是**边扫边加**，而回扫是**从尾向前**、
  // `seenIds` 去重又是「先到先占」。这种布局会让那笔写永远不被计：
  //   从左到右：[写 tool_use] [填充] [它的 result] [重复副本 tool_use]
  //   从右向左 ：先看到重复副本 → 占住 seenIds；再看到 result（进 results）；
  //              最后才看到真正的 tool_use → 被当成重复跳过 → 不加。
  // 真实语料就这样丢了 1 笔（5.93 MB 会话：单块 86 / 分块 85，差的那笔在 4.92 MB）。
  //
  // 夹具参数是搜出来的（`pads=1 / chunk=400`）：块必须小到把「写调用」和
  // 「result + 重复副本」切开，又大到不至于把 result 与副本也切开。
  const dir = sandbox();
  try {
    const tp = join(dir, 't.jsonl');
    const w = writeUse('tu_w', dir, 'out.txt');
    const pad = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'p'.repeat(200) }] } });
    writeFileSync(tp, [w, pad, toolResult('tu_w'), w].join('\n') + '\n');
    const size = statSync(tp).size;

    const base = readTranscriptActivity(tp, { cwd: dir, bytes: size + 10 });
    assert.equal(base.priorWriteCalls, 1, `真值：这一笔写成了（实际 ${base.priorWriteCalls}）`);

    const chunked = readTranscriptActivity(tp, { cwd: dir, bytes: 125, need: 1e9, maxScanBytes: size + 10 });
    assert.ok(chunked.chunks >= 3, `前提：三样东西确实落在不同块（${chunked.chunks} 块）`);
    assert.equal(chunked.priorWriteCalls, 1,
      `分块必须与单块逐字一致：单块 1，分块 ${chunked.priorWriteCalls}`
      + '（若为 0，说明结算又退回成「边扫边加」，依赖了从尾向前的扫描顺序）');
    assert.equal(chunked.lines, base.lines, '解析到的行数也必须一致');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-038 第 5 条：拒绝文案的三种自相矛盾都不能再出现', () => {
  const dir = sandbox();
  try {
    const tp = join(dir, 't.jsonl');
    writeFileSync(tp, readLines(dir).join('\n') + '\n');
    const base = { cwd: dir, transcript_path: tp };
    const envHalt = envIn(dir, { OW_PRE_WRITE_GATE: 'deny', OW_ASK_MIN_QUESTIONS: '3' });
    const haltOut = runHook(INPUT(base), { env: envHalt });
    const haltReason = haltOut.output.hookSpecificOutput.permissionDecisionReason;
    // ① 「重试」与「本回合已结束」不许同时是**指令**
    assert.match(haltReason, /本回合已结束/);
    assert.doesNotMatch(haltReason, /重试你刚才那次写|原样重试/);
    // ② 「明说理由然后重试」这条永远失败的指令必须消失
    assert.doesNotMatch(haltReason, /明说理由/);
    // ③ 「事后可审计」必须有落地物：日志里有 reason 原文，不只是长度
    assert.equal(typeof haltOut.log.reason, 'string', 'reason 原文必须进台账（审计说法的落地物）');
    assert.equal(haltOut.log.reason, haltReason, '台账里那份必须是真发出去的那份');
    assert.equal(haltOut.log.reasonLen, haltReason.length, '长度字段保留（旧消费者还在读）');
    // budget 档：文案必须不同，且那时才该说「重试」
    const soft = runHook(INPUT({ ...base, tool_use_id: 'toolu_soft' }), {
      env: envIn(dir, { OW_PRE_WRITE_GATE: 'deny', OW_ASK_MIN_QUESTIONS: '3', OW_PRE_WRITE_GATE_BRAKE: 'budget', OW_PRE_WRITE_GATE_DENY_BUDGET: '5' }),
    });
    const softReason = soft.output.hookSpecificOutput.permissionDecisionReason;
    assert.equal(soft.output.continue, undefined, 'budget 档不许给 continue:false');
    assert.match(softReason, /重试你刚才那次写/);
    assert.doesNotMatch(softReason, /本回合已结束/);
    assert.notEqual(softReason, haltReason, '两种刹车下文案必须不同');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-038 第 2/3 条：闸门与 question-audit 的提问口径一致（同文本同数字）', () => {
  // 缺陷是「两处都自称同一口径，数字不同」。判据不是「注释怎么写」，
  // 而是**拿同一份 transcript 分别喂两个实现，看数字对不对得上**。
  const dir = sandbox();
  try {
    const tp = join(dir, 't.jsonl');
    writeFileSync(tp, [
      toolUseLine('AskUserQuestion', { questions: [{ question: '改哪个文件？' }] }),
      toolUseLine('AskUserQuestion', { questions: [{ question: '改哪个文件？' }] }),   // 同一问题再问
      toolUseLine('AskUserQuestion', { questions: [{ question: '用 A 还是 B？' }, { question: '验收用哪条命令？' }] }),
      toolUseLine('ExitPlanMode', { plan: 'x' }),
    ].join('\n') + '\n');
    const gate = readTranscriptActivity(tp, { cwd: dir });
    const audit = auditScanSession(readFileSync(tp, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));

    // 提问调用次数：两处必须相等
    assert.equal(gate.askCalls, audit.askCalls, `askCalls 不一致：闸门 ${gate.askCalls} / 审计 ${audit.askCalls}`);
    // 去重后的问题个数：两处必须相等
    assert.equal(gate.distinctQuestions, audit.distinctQuestions,
      `distinctQuestions 不一致：闸门 ${gate.distinctQuestions} / 审计 ${audit.distinctQuestions}`);
    assert.equal(gate.distinctQuestions, 4, '3 个不同文本 + ExitPlanMode');
    // `questionsKnown` 是**另一件事**（总问题数，重复也各记一次）：3+2 = 5
    // 它不是「同一口径」的对方，而是另一个有名字的指标 —— 这正是第 3 条的修法。
    assert.equal(audit.questionsKnown, 5, 'questionsKnown 数的是总问题数，不是去重后的');
    assert.notEqual(audit.questionsKnown, audit.distinctQuestions, '两个字段必须真的不同（否则第 3 条只是改名）');
    // ExitPlanMode 在两处都必须算（第 2 条）
    assert.ok(gate.questions.includes('ExitPlanMode'));
    assert.ok(audit.asks.some((a) => a.form === 'exit-plan-mode'), '审计侧也必须认得 ExitPlanMode');
    // `firstAsk` 是**第一次**提问的位置（第 1 次调用，AskUserQuestion），
    // 而 ExitPlanMode 是第 4 次 —— 两处都按去重后的调用序号算。
    assert.equal(audit.firstAsk, 1, 'firstAsk 是第一次提问的调用序号');
    assert.equal(audit.asks.find((a) => a.form === 'exit-plan-mode').at, 4,
      'ExitPlanMode 也进了 asks 序列（否则「只有计划批准」的会话会被判成从不提问）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DF-038 第 2/3 条（负向）：旧口径（只认 AskUserQuestion、按总数算）必须与新口径不同', () => {
  // 证明上面那条测试不是空的：如果 transcript 里只有 ExitPlanMode，
  // 「只认 AskUserQuestion」会数 0，新口径数 1。
  const dir = sandbox();
  try {
    const tp = join(dir, 't.jsonl');
    writeFileSync(tp, toolUseLine('ExitPlanMode', { plan: 'x' }) + '\n');
    const gate = readTranscriptActivity(tp, { cwd: dir });
    assert.equal(gate.distinctQuestions, 1, '新口径：计划批准算一次提问');
    // 旧口径的判据（只认 AskUserQuestion）在这份文件上是 0 —— 两个口径真的不同，
    // 所以统一这件事是有内容的，不是改个注释。
    const audit = auditScanSession(readFileSync(tp, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    assert.equal(audit.askCalls, 1, '审计侧现在也认计划批准（旧口径会给 0）');
    assert.equal(audit.questionsKnown, 1, '计划批准计 1 个问题');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
