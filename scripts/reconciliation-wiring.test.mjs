#!/usr/bin/env node
/**
 * reconciliation-wiring.test.mjs — 产出对账**接进派发链路**的回归测试。
 *
 * `claim-ledger.test.mjs` 测的是判定层（四方对账算得对不对）。这一份测的是另一件事：
 * **有没有人调用它**。两者必须分开——工具再准，SKILL.md 不调它，它就完全不存在
 * （DF-015 的原话：定义里写得再对，没人调用等于不存在）。
 *
 * 守的四条，对应设计 `docs/design/2026-11-13-output-reconciliation.md` §7：
 *   7.1 `task-graph.json` 有 `outputs`（在 `validate-run.test.mjs` 里测）
 *   7.2 派发模板带 nonce 段与「不执行也不会漏」的说明
 *   7.3 executor / repair 的角色定义是四元组，含「我产出的文件」
 *   7.4 SKILL.md 在验收前有一道 `verify`，且 `PARTIAL`/`MISSING`/`CONFLICT` 不进验收
 *
 * 每条都配一个**回退断言**：把关键行删掉，判据必须变假。只断言「现在有」的测试，
 * 挡不住「下次重构时被顺手删掉」——那正是这些文档行最容易遭遇的命运。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const DISPATCH = 'templates/dispatch.md';
const SKILL = '.claude/skills/oversight/SKILL.md';
const EXECUTOR = '.claude/agents/oversight-executor.md';
const REPAIR = '.claude/agents/oversight-repair.md';

/** 从 SKILL.md 里取出 Phase E 之前的那一段。用来断言「对账在验收之前」，
 *  而不是只断言「文件里某处有 verify」——后者在命令被挪到验收之后时仍然通过。 */
function beforePhaseE(text) {
  const i = text.indexOf('## 5. Phase E');
  assert.ok(i > 0, 'SKILL.md 的 Phase E 标题变了：找不到参照点');
  return text.slice(0, i);
}

// ── 7.2 派发模板 ───────────────────────────────────────────────────────

test('7.2 派发模板含「产出登记」节，并给出 claim 命令的完整形态', () => {
  const t = read(DISPATCH);
  assert.match(t, /## 产出登记（必须做）/, '缺少产出登记节');
  assert.match(t, /node scripts\/claim-ledger\.mjs claim --run <run-id> --task <task-id> --path/,
    '缺少 claim 命令；子 agent 没有它可抄，就只会看到一句「请登记」');
});

test('7.2 派发模板写明 nonce 必须保留在第一条消息里（归属机制的地基）', () => {
  const t = read(DISPATCH);
  assert.match(t, /nonce/, '模板里没有 nonce');
  assert.match(t, /第一条消息/, '没有说明 nonce 要在第一条消息里——observe 只读 transcript 头部 64 KiB');
});

test('7.2 模板明写「不执行也不会漏」并解释原因（否则会退化成又一条自述通道）', () => {
  const t = read(DISPATCH);
  assert.match(t, /\*\*不执行也不会漏\*\*/, '缺少这句——没有它，claim 就从加分项变成了准入项');
  assert.match(t, /transcript/, '没有指出漏不掉的依据是 transcript 痕迹');
  assert.match(t, /加分项.*不是.*准入项|不是\*\*准入项\*\*/, '没有说明 claim 是可选的自述，不是准入条件');
});

test('7.2 模板含四元组第四节，且写明「写错路径比不写更糟」', () => {
  const t = read(DISPATCH);
  assert.match(t, /## 我产出的文件/, '缺少「我产出的文件」节');
  assert.match(t, /- <路径> —— <字节数>/, '格式与设计 §7.3 不一致');
  assert.match(t, /写错路径比不写更糟/, '缺少这条纪律');
  assert.match(t, /不是给你自我评价用的，是给主线程对账用的/, '没有说明这一节的用途');
});

test('回退断言：删掉「不执行也不会漏」那句，上面的判据必须变假', () => {
  // 真的删一次。只断言「现在有这条」的测试挡不住下次重构顺手删掉它。
  const mutated = read(DISPATCH).replace(/\*\*不执行也不会漏\*\*/g, '**请务必执行**');
  assert.doesNotMatch(mutated, /\*\*不执行也不会漏\*\*/);
  assert.throws(() => assert.match(mutated, /\*\*不执行也不会漏\*\*/));
});

// ── 7.3 角色定义 ──────────────────────────────────────────────────────

/** 只断言「现在有」的测试挡不住下次重构顺手删掉；每条都要能被一次真实的删除打红。 */
function assertQuartet(rel) {
  const t = read(rel);
  assert.match(t, /## 我产出的文件/, `${rel} 缺少「我产出的文件」节`);
  assert.match(t, /- <路径> —— <字节数>/, `${rel} 的格式与设计 §7.3 不一致`);
  assert.match(t, /不是给你自我评价用的/, `${rel} 没有说明这一节不是自我评价`);
  assert.match(t, /写错路径比不写更糟/, `${rel} 没有写「写错路径比不写更糟」`);
}

/** 角色定义里写了 `node scripts/claim-ledger.mjs claim ...`，而 tools 白名单没有 Bash，
 *  那条命令就是一句跑不起来的指示——子 agent 会「看到了但做不到」，然后什么都不说。
 *  这种失败在返回文本里是看不见的。 */
function assertHasBash(rel) {
  const t = read(rel);
  const fm = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(fm, `${rel} 缺少 frontmatter`);
  const tools = (fm[1].match(/^tools:\s*(.+)$/m) || [, ''])[1];
  assert.match(tools, /\bBash\b/, `${rel} 的 tools 没有 Bash：${tools}`);
}

test('7.3 executor：输出节是四元组，含「我产出的文件」与对账用途说明', () => {
  assertQuartet(EXECUTOR);
});

test('7.3 executor：tools 里有 Bash（否则 claim 命令根本跑不了）', () => {
  assertHasBash(EXECUTOR);
});

test('7.3 repair：输出节是四元组，含「我产出的文件」与对账用途说明', () => {
  assertQuartet(REPAIR);
});

test('7.3 repair：tools 里有 Bash（否则 claim 命令根本跑不了）', () => {
  assertHasBash(REPAIR);
});

test('7.3 两个角色都写了「claim 是加分项不是准入项」（与模板一致）', () => {
  for (const rel of [EXECUTOR, REPAIR]) {
    const t = read(rel);
    assert.match(t, /加分项/, `${rel} 没有说明 claim 是可选项`);
    assert.match(t, /claim-ledger\.mjs claim --run/, `${rel} 没有给出可抄的命令`);
  }
});

test('回退断言：把 executor 的「我产出的文件」节删掉，判据必须变假', () => {
  const mutated = read(EXECUTOR).replace(/## 我产出的文件/g, '## 备注');
  assert.doesNotMatch(mutated, /## 我产出的文件/);
  assert.throws(() => assert.match(mutated, /## 我产出的文件/));
});

// ── 7.4 验收前对账 ────────────────────────────────────────────────────

test('7.4 SKILL.md 在 Phase E **之前**有 claim-ledger verify（不是随便哪一处）', () => {
  const pre = beforePhaseE(read(SKILL));
  assert.match(pre, /node scripts\/claim-ledger\.mjs verify --run <run-id>/,
    '验收之前没有对账命令——验收一个不完整的交付物等于给虚假的通过盖章');
  assert.match(pre, /verify --run <run-id> \|\| exit 1/, '没有写成硬门（`|| exit 1`）');
});

test('7.4 SKILL.md 明写 PARTIAL / MISSING / CONFLICT 不进入验收', () => {
  const pre = beforePhaseE(read(SKILL));
  for (const v of ['PARTIAL', 'MISSING', 'CONFLICT']) {
    assert.ok(pre.includes(v), `Phase E 之前没有提到 ${v} —— 那三种结论必须挡住验收`);
  }
  assert.match(pre, /不进入验收/, '没有说这些结论不进验收');
});

test('7.4 SKILL.md 给出「为什么」：验收不完整或身份不明的交付物 = 盖章', () => {
  const pre = beforePhaseE(read(SKILL));
  assert.match(pre, /盖章/, '缺少理由。只有规则没有理由的流程会被下一个维护者当成仪式删掉');
});

test('7.4 SKILL.md 要求 declare 的 --paths 取自 task-graph 的 outputs，不许现编', () => {
  const pre = beforePhaseE(read(SKILL));
  assert.match(pre, /declare/, 'Phase E 之前没有 declare');
  assert.match(pre, /subtrees\[\]\.outputs|`outputs`/, '没有把期望绑到 task-graph 的 outputs 上——现编的期望等于事后编造验收标准');
  assert.match(pre, /nonce/, '没有说明 nonce 要拼进派发 prompt');
});

test('7.4 SKILL.md 要求逐任务 consume（「产出在」与「主线程知道了」是两件事）', () => {
  const pre = beforePhaseE(read(SKILL));
  assert.match(pre, /consume/, '没有 consume 这一步——verify 的退出码 0 要求已认领');
});

test('负向：把那行 verify 注释掉，7.4 的判据必须变红', () => {
  // 任务书要求的那条回退：「把对账命令注释掉，对应测试必须变红」。真的做一遍。
  const original = read(SKILL);
  const commented = original.replace(
    /^(node scripts\/claim-ledger\.mjs verify --run <run-id> \|\| exit 1)$/m,
    '# $1   // 已注释掉',
  );
  assert.notEqual(commented, original, '找不到那行命令，无法做回退');
  const pre = beforePhaseE(commented);
  assert.doesNotMatch(pre, /^node scripts\/claim-ledger\.mjs verify --run <run-id> \|\| exit 1$/m,
    '注释掉之后判据仍然通过——说明这条测试没有守住那行命令');
});

// ── 接线不是单向的：phase B 必须把 nonce 送进 prompt ─────────────────

test('Phase B 说明要先把 declare 的 nonce 拼进 prompt（否则 observe 归属不到任务）', () => {
  const t = read(SKILL);
  const b = t.slice(t.indexOf('## 3. Phase B'), t.indexOf('## 4. Phase C'));
  assert.ok(b.length > 0, '找不到 Phase B 段落');
  assert.match(b, /declare/, 'Phase B 没有派发前登记期望');
  assert.match(b, /nonce/, 'Phase B 没有把 nonce 写进 prompt —— 那 §4.5 的 observe 会一份都归属不上');
});
