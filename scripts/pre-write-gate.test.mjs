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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  decide, configOf, defaultConfig, writeIntentOf, powershellWriteScan, isGateOwnedPath,
  markerPathFor, denialPathFor, readMarker, writeMarker, markerValidity, reasonFor,
  readTranscriptReads, runHook, parseHookInput, appendLog, logPathFor, bumpDenials, cli,
  markerSigOf, readGateSecret, ensureGateSecret, secretPathFor,
  MARKER_REL, SECRET_REL, MODES, BRAKES, WRITE_TOOLS, SHELL_TOOLS, READ_TOOLS, EDIT_SIDE_TOOLS,
  readPathsOfToolUse, pathKeyOf,
} from '../scripts/pre-write-gate.mjs';

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
  assert.match(halt, /结束了本回合/);
  assert.doesNotMatch(soft, /结束了本回合/);
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
  assert.match(r, /结束了本回合/);
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

// ── 11. 端到端：真的 spawn 那个 hook ─────────────────────────────────

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
    writeMarker(markerPathFor(dir), { sessionId: 's1', satisfiedBy: 'claim' });
    const b = runHookProcess('', {}, ['status', '--cwd', dir]);
    assert.match(b.stdout, /marker state: exists/);
    assert.match(b.stdout, /claim/);
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
