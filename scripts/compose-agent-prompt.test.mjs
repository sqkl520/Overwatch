#!/usr/bin/env node
/**
 * compose-agent-prompt.test.mjs — 分层拼装的回归测试。
 *
 * 守的是「提示词本身可对账」这条，以及几件**已经被实测打脸过**的事：
 *
 *   1. 验收标准要跑命令，而验收角色的工具里没有 `Bash`
 *      ⇒ 一份没有这种检查的 compose，会把那个矛盾原样发出去，
 *        而子 agent 唯一能给出的诚实结论是「不通过」。
 *   2. `templates/dispatch.md` 的 `<nonce>` 没人填
 *      ⇒ 归属失败是**静默**的（observe 只是「扫到 0 份能归属」，不报错）。
 *   3. 停机条件是唯一被实测证明能提高完成率的干预
 *      ⇒ 它必须被强制存在，且必须可判定（只有形容词的等于没有）。
 *
 * 每条检查都配一个**回退断言**：把关键条件反过来，判据必须变假。
 * 只断言「现在通过」的测试挡不住下次重构把它删掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  parseFrontmatter, roleTools, extractCommands, classifyRequirement, requiredTools,
  stopConditionProblem, checkPromptSpec, deriveInjected, fillDispatchTemplate,
  composePrompt, normalizeForHash, promptHash, makePromptRow, readPromptLedger,
  firstUserText, readHeadRecords, verifyPrompts, makeNonce,
  FORBIDDEN_CONTEXT, REQUIRED_ELEMENTS, REQUIRED_PLACEHOLDERS, OBLIGATION_KINDS, LAYERS,
} from './compose-agent-prompt.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const ac = (over = {}) => ({
  id: 'AC1', criterion: 'src/a.mjs:12 有 fail_if 判断', evidence: 'src/a.mjs:12', fail_if: '无该判断',
  ...over,
});

const OK = {
  role: 'executor',
  task: '实现扫描器并把结果写到文件，跑通回归测试',
  acceptance: [ac()],
  shape: 'artifact',
  outputs: ['scripts/x.mjs'],
  stopCondition: '跑 node --test scripts/*.test.mjs，15 分钟内返回',
  nonce: 'a1b2c3d4',
};

/** 真实角色定义：这些断言必须对着真人写的文件跑，不能对着测试自己造的样本跑。 */
const ACCEPTOR_TEXT = read('.claude/agents/oversight-acceptor.md');
const EXECUTOR_TEXT = read('.claude/agents/oversight-executor.md');

// ── 角色工具集 ────────────────────────────────────────────────────────

test('frontmatter 解析出 tools；acceptor 确实没有 Bash（这是那个矛盾的物理事实）', () => {
  const r = roleTools(ACCEPTOR_TEXT);
  assert.deepEqual(r.tools, ['Read', 'Grep', 'Glob', 'Write']);
  assert.equal(r.inheritAll, false);
  assert.ok(!r.tools.includes('Bash'), 'acceptor 一旦有了 Bash，本文件的主要理由就消失了');
  assert.ok(!r.tools.includes('Edit'));
});

test('executor 有 Bash（对照组：否则上面的断言可能只是因为谁都没有 Bash）', () => {
  const r = roleTools(EXECUTOR_TEXT);
  assert.ok(r.tools.includes('Bash'));
  assert.ok(r.tools.includes('Write'));
});

test('tools 整行缺失 ⇒ inheritAll，不能当成「什么都不能干」', () => {
  // 宿主语义：省略 tools = 继承全部工具。把它当空数组会让 compose 误判为「无权限」，
  // 而当全开会让它误判为「都有权限」。两者都错，所以必须单独标出来。
  const r = roleTools('---\nname: x\ndescription: 一个够长的描述\n---\n\n正文');
  assert.equal(r.inheritAll, true);
  assert.deepEqual(r.tools, []);
});

test('没有 frontmatter 时标 missingFrontmatter，而不是静默返回空工具集', () => {
  const r = roleTools('只有正文，没有 frontmatter');
  assert.equal(r.missingFrontmatter, true);
});

test('parseFrontmatter 能读多行块（description: |）', () => {
  const fm = parseFrontmatter('---\nname: a\ndescription: |\n  第一行\n  第二行\n---\n');
  assert.equal(fm.name, 'a');
  assert.match(fm.description, /第一行/);
});

// ── 判定项分类 ────────────────────────────────────────────────────────

test('反引号里的命令被认出来，且尾部散文被切掉', () => {
  // 不切的话，同一条命令在 AC 与 --gate 里是两个字符串，
  // 「注入是否覆盖了这条 AC」永远判否 —— 所有注入都会失效。
  assert.deepEqual(extractCommands('`node scripts/check-structure.mjs` → 必须全绿'), ['node scripts/check-structure.mjs']);
  assert.deepEqual(extractCommands('node scripts/check-structure.mjs 全绿'), ['node scripts/check-structure.mjs']);
  assert.deepEqual(extractCommands('跑 `npm run build -- --no-cache`，30 分钟内'), ['npm run build -- --no-cache']);
});

test('命令动词表覆盖本项目与常见生态（mvn 不是 npm）', () => {
  assert.deepEqual(classifyRequirement('`mvn -q clean verify` 通过').commands, ['mvn -q clean verify']);
  assert.deepEqual(classifyRequirement('`gradlew test`').commands, ['gradlew test']);
  assert.deepEqual(classifyRequirement('`pytest -q`').commands, ['pytest -q']);
  // 保留字不是命令：不能让每一句话都被判成 command 类
  assert.equal(classifyRequirement('接口未暴露到公网').kind, 'decision');
});

test('判定项三分类：命令 > 文件 > 纯判断，顺序不能反', () => {
  // 一条同时提到命令和文件的 AC，**难点是跑命令**。
  // 按文件算会让「acceptor 跑不了命令」这条矛盾被静默放过。
  const both = classifyRequirement('跑 `node scripts/x.mjs`，核对 src/a.mjs:12 的输出');
  assert.equal(both.kind, 'command');
  assert.equal(classifyRequirement('docs/design/x.md 含「未实现」字样').kind, 'file');
  assert.deepEqual(classifyRequirement('docs/design/x.md 含「未实现」').files, ['docs/design/x.md']);
  assert.equal(classifyRequirement('接口是否暴露到公网').kind, 'decision');
});

test('requiredTools 取并集：一条要跑命令，整个角色就得能跑命令', () => {
  const need = requiredTools([
    ac({ id: 'AC1', criterion: 'docs/a.md 有该节' }),
    ac({ id: 'AC2', criterion: '`node scripts/g.mjs` 全绿' }),
  ]);
  assert.deepEqual(need.sort(), ['Bash', 'Read']);
  assert.deepEqual(requiredTools([ac({ criterion: '纯判断：是否越权' })]), []);
});

test('每个分类都有明确的工具需求声明（新增一类必须同时声明需求）', () => {
  for (const k of OBLIGATION_KINDS) {
    assert.ok(Array.isArray(k.needs), `${k.id} 缺 needs`);
    assert.ok(k.id && k.label && k.note, `${k.id} 缺说明字段`);
  }
});

// ── 停机条件 ──────────────────────────────────────────────────────────

test('停机条件必须有可数界限（命令 / 数字配额 / 时间上限）', () => {
  assert.equal(stopConditionProblem('只跑一条 grep，5 分钟返回'), null);
  assert.equal(stopConditionProblem('跑 `node scripts/x.mjs` 然后返回'), null);
  assert.equal(stopConditionProblem('≤ 18 行输出'), null);
});

test('只有形容词的停机条件判不可判定——它永远满足不了，也永远不算违约', () => {
  assert.match(stopConditionProblem('尽可能全面'), /不可判定/);
  assert.match(stopConditionProblem('深入分析，彻底排查'), /不可判定/);
  assert.match(stopConditionProblem(''), /缺失/);
});

test('既无数字也无恰当形容词的句子也要被判掉（不能因为不命中黑名单就放行）', () => {
  assert.match(stopConditionProblem('读完然后告诉我结果'), /不可判定/);
});

// ── 核心检查 ──────────────────────────────────────────────────────────

test('完整规格通过，且每条检查都给出「凭什么说它满足」', () => {
  const r = checkPromptSpec({ ...OK, roleText: EXECUTOR_TEXT, injected: [{ command: 'node --test scripts/*.test.mjs' }] });
  assert.equal(r.ok, true, r.errors.join('\n'));
  // 通过时 detail 不能是失败文案（那会让「全绿」的输出读起来像在报错）
  for (const c of r.checks) {
    if (c.ok) assert.ok(c.detail && !/缺|过短|必须|失败/.test(c.detail), `${c.id} 的通过文案像在报错：${c.detail}`);
  }
  assert.equal(r.checks.length, REQUIRED_ELEMENTS.length);
  assert.deepEqual(r.checks.map((c) => c.id), REQUIRED_ELEMENTS.map((e) => e.id));
});

test('回退：缺 acceptance 必须拒绝（硬约束 4）', () => {
  const r = checkPromptSpec({ ...OK, acceptance: [], roleText: EXECUTOR_TEXT });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /acceptance.*为空/.test(e)));
});

test('回退：AC 缺 fail_if 必须拒绝——没有否决条件的标准等于没有', () => {
  const noFail = ac();
  delete noFail.fail_if;
  const r = checkPromptSpec({ ...OK, acceptance: [noFail], roleText: EXECUTOR_TEXT });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /缺 fail_if/.test(e)));
});

test('回退：artifact 配空 outputs 必须拒绝（否则收活对账判 NO-EXPECTATION）', () => {
  const r = checkPromptSpec({ ...OK, outputs: [], roleText: EXECUTOR_TEXT });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /outputs/.test(e)));
  // 对照：exploration 允许空
  const ok = checkPromptSpec({ ...OK, shape: 'exploration', outputs: [], roleText: EXECUTOR_TEXT });
  assert.equal(ok.ok, true, ok.errors.join('\n'));
});

test('回退：缺停机条件必须拒绝', () => {
  const r = checkPromptSpec({ ...OK, stopCondition: '', roleText: EXECUTOR_TEXT });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /stop_condition/.test(e)));
});

test('回退：nonce 格式不对必须拒绝（错误 nonce 的后果是静默的）', () => {
  for (const bad of ['', 'xyz', 'a1b2c3', 'a1b2c3d4e5']) {
    const r = checkPromptSpec({ ...OK, nonce: bad, roleText: EXECUTOR_TEXT });
    assert.equal(r.ok, false, `nonce=${JSON.stringify(bad)} 应被拒`);
  }
});

test('回退：任务书为空必须拒绝', () => {
  const r = checkPromptSpec({ ...OK, task: '', roleText: EXECUTOR_TEXT });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /task/.test(e)));
});

// ── 今晚那条矛盾的正面判据 ────────────────────────────────────────────

test('要害：acceptor + 命令类 AC + 无注入 ⇒ 拒绝，并给出两条出路', () => {
  const cmdAc = [ac({ id: 'AC1', criterion: '`node scripts/check-structure.mjs` 全绿', evidence: '命令输出', fail_if: 'exit != 0' })];
  const r = checkPromptSpec({ ...OK, role: 'acceptor', acceptance: cmdAc, roleText: ACCEPTOR_TEXT });
  assert.equal(r.ok, false, '这正是今晚的 bug：发出去之后 acceptor 只能判「不通过」');
  const err = r.errors.join('\n');
  assert.match(err, /tool_compat/);
  assert.match(err, /node scripts\/check-structure\.mjs/);
  // 两条出路都必须在错误里写出来，否则读者只知道「不行」，不知道「怎么办」
  assert.match(err, /换成有该工具的角色/);
  assert.match(err, /注入证据/);
});

test('要害：同一条 AC，注入输出之后通过——acceptor 保持只读，验收变成可 Read 核对', () => {
  const cmdAc = [ac({ id: 'AC1', criterion: '`node scripts/check-structure.mjs` 全绿', evidence: '命令输出', fail_if: 'exit != 0' })];
  const r = checkPromptSpec({
    ...OK, role: 'acceptor', acceptance: cmdAc, roleText: ACCEPTOR_TEXT,
    injected: [{ command: 'node scripts/check-structure.mjs' }],
  });
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.ok(r.checks.find((c) => c.id === 'tool_compat').ok);
});

test('注入只覆盖它声明的那条命令——不能一条注入放行所有命令类 AC', () => {
  const two = [
    ac({ id: 'AC1', criterion: '`node scripts/check-structure.mjs` 全绿', evidence: '命令输出', fail_if: 'x' }),
    ac({ id: 'AC2', criterion: '`node --test scripts/*.test.mjs` 全绿', evidence: '命令输出', fail_if: 'y' }),
  ];
  const r = checkPromptSpec({
    ...OK, role: 'acceptor', acceptance: two, roleText: ACCEPTOR_TEXT,
    injected: [{ command: 'node scripts/check-structure.mjs' }],
  });
  assert.equal(r.ok, false);
  const err = r.errors.join('\n');
  assert.ok(err.includes('AC2'), `未注入的那条要点名报出来：${err}`);
  assert.ok(!err.includes('AC1:'), `已注入的那条不该再报：${err}`);
});

test('工具相容性对「继承全部工具」的角色判不确定——沉默放行比判错更坏', () => {
  const cmdAc = [ac({ id: 'AC1', criterion: '`node scripts/x.mjs`', evidence: 'c', fail_if: 'f' })];
  const r = checkPromptSpec({ ...OK, acceptance: cmdAc, roleText: '---\nname: x\ndescription: 够长的描述文字\n---\n' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /继承全部工具/);
});

// ── 独立性 ────────────────────────────────────────────────────────────

test('独立性：给 review 注入执行者的自我评价必须拒绝（契约 §3：靠不提供，不靠请勿读）', () => {
  const r = checkPromptSpec({ ...OK, role: 'review', roleText: EXECUTOR_TEXT, context: { self_assessment: '我做了 90%' } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /independence/);
});

test('独立性：acceptor 也不能拿到锐评分数（否则就成一个人的左右手）', () => {
  const r = checkPromptSpec({ ...OK, role: 'acceptor', roleText: ACCEPTOR_TEXT, context: { review_score: 8 } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /review_score/);
});

test('独立性：没有禁止项的角色不受影响（对照组）', () => {
  assert.equal(FORBIDDEN_CONTEXT.executor, undefined);
  assert.deepEqual(FORBIDDEN_CONTEXT.review.includes('self_assessment'), true);
});

// ── L1 模板填充 ───────────────────────────────────────────────────────

test('L1：真实 dispatch.md 的具名占位符全部被填掉', () => {
  const tpl = read('templates/dispatch.md');
  // 先确认模板里真的还有这些占位符 —— 否则这个测试在模板改名后会静默通过
  const present = REQUIRED_PLACEHOLDERS.filter((p) => tpl.includes(p));
  assert.ok(present.length >= 2, `模板里找不到具名占位符，测试失去对象：${present.join(',')}`);
  const r = fillDispatchTemplate(tpl, { run: 'r1', task: 'ST1', nonce: 'a1b2c3d4', paths: ['a.md'] });
  assert.deepEqual(r.missing, []);
  assert.ok(!r.text.includes('<nonce>'));
  assert.ok(r.text.includes('a1b2c3d4'));
  assert.ok(r.text.includes('ST1'));
});

test('L1：nonce 缺失时报告 missing，不能静默留下 <nonce>', () => {
  // 留下的后果是 observe 归属失败，而失败是静默的 —— 跑一遍"看起来正常"。
  const r = fillDispatchTemplate(read('templates/dispatch.md'), { run: 'r1', task: 'ST1', paths: [] });
  assert.ok(r.missing.includes('<nonce>'), `应报出未填的 nonce：${r.missing.join(',')}`);
  assert.ok(r.text.includes('<nonce>'));
});

// ── 拼装 ──────────────────────────────────────────────────────────────

test('拼装顺序 = L0 指针 → L1 协议 → L2 现写 → L3 注入', () => {
  const { markdown } = composePrompt({
    role: 'acceptor', task: '判定四项标准', acceptance: [ac()], shape: 'artifact',
    outputs: ['a.md'], stopCondition: '10 分钟内', nonce: 'a1b2c3d4',
    dispatchTemplate: 'L1正文占位', injectedFacts: [{ label: 'X', value: 'Y', source: 'Z' }],
    taskId: 'ST1',
  });
  const i0 = markdown.indexOf('## 0. 身份');
  const i1 = markdown.indexOf('## 1. 派发公共协议');
  const i2 = markdown.indexOf('## 2. 本次任务');
  const i3 = markdown.indexOf('## 3. 本项目事实');
  assert.ok(i0 >= 0 && i1 > i0 && i2 > i1 && i3 > i2, `顺序不对：${[i0, i1, i2, i3].join(',')}`);
  assert.ok(markdown.includes('L1正文占位'), 'L1 必须逐字内联');
});

test('拼装：L0 只放指针不复制正文（角色定义的唯一真源留在 .claude/agents）', () => {
  const { markdown } = composePrompt({ role: 'acceptor', task: '判定', acceptance: [ac()], shape: 'artifact', outputs: ['a'], stopCondition: '10 分钟', nonce: 'a1b2c3d4' });
  assert.match(markdown, /oversight-acceptor\.md/);
  // 角色正文里的原句不该被复制进来
  assert.ok(!markdown.includes('你是验收 Agent。你只判定，不改稿'), '角色正文被复制进了提示词，两份真源会漂');
});

test('拼装：命令类 AC 在 L3 有注入时写成「读输出核对」，否则写成「需跑」', () => {
  const cmdAc = [ac({ id: 'AC1', criterion: '`node scripts/g.mjs` 全绿', evidence: 'e', fail_if: 'f' })];
  const withInj = composePrompt({
    role: 'acceptor', task: '判定', acceptance: cmdAc, shape: 'artifact', outputs: ['a'],
    stopCondition: '10 分钟', nonce: 'a1b2c3d4',
    injectedFacts: [{ label: '硬门结果（已由主线程跑过）', value: '`node scripts/g.mjs` → exit 0', source: 'x' }],
  }).markdown;
  assert.match(withInj, /已在 L3 注入输出/);
  const noInj = composePrompt({
    role: 'executor', task: '判定', acceptance: cmdAc, shape: 'artifact', outputs: ['a'],
    stopCondition: '10 分钟', nonce: 'a1b2c3d4', injectedFacts: [],
  }).markdown;
  assert.match(noInj, /需跑/);
});

test('拼装：提示词里不得出现具名占位符（发出去就是错的）', () => {
  const { markdown } = composePrompt({
    role: 'executor', task: '做一件事', acceptance: [ac()], shape: 'artifact',
    outputs: ['x.mjs'], stopCondition: '10 分钟', nonce: 'a1b2c3d4',
    dispatchTemplate: fillDispatchTemplate(read('templates/dispatch.md'), {
      run: 'r1', task: 'ST1', nonce: 'a1b2c3d4', paths: ['x.mjs'],
    }).text,
  });
  for (const p of REQUIRED_PLACEHOLDERS) assert.ok(!markdown.includes(p), `残留 ${p}`);
});

// ── hash 与对账 ───────────────────────────────────────────────────────

test('hash 归一化只做无损变换：CRLF 与首尾空白不影响，内容改动必须影响', () => {
  assert.equal(promptHash('a\r\nb\n'), promptHash('a\nb'));
  assert.equal(promptHash('  x  '), promptHash('x'));
  // 空行差异**必须**改变 hash：否则台账证明不了「发出去的是这一份」
  assert.notEqual(promptHash('a\n\nb'), promptHash('a\nb'));
  assert.notEqual(normalizeForHash('a\n\nb'), normalizeForHash('a\nb'));
});

test('台账 append-only，坏行计数但不丢已读的行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-prompt-'));
  try {
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'prompts.jsonl');
    writeFileSync(f, JSON.stringify(makePromptRow({ run: 'r', task: 'S1', role: 'executor', hash: 'h1', bytes: 10 })) + '\n');
    writeFileSync(f, 'not json\n', { flag: 'a' });
    writeFileSync(f, JSON.stringify({ kind: 'other' }) + '\n', { flag: 'a' });
    writeFileSync(f, JSON.stringify(makePromptRow({ run: 'r', task: 'S2', role: 'review', hash: 'h2', bytes: 20 })) + '\n', { flag: 'a' });
    const { rows, badLines } = readPromptLedger(f);
    assert.equal(rows.length, 2);
    assert.equal(badLines.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('makePromptRow：任一检查不过 ⇒ ok:false（台账要能回答「这份当时合不合格」）', () => {
  assert.equal(makePromptRow({ run: 'r', task: 'S', role: 'x', hash: 'h', bytes: 1, checks: [{ ok: true }] }).ok, true);
  assert.equal(makePromptRow({ run: 'r', task: 'S', role: 'x', hash: 'h', bytes: 1, checks: [{ ok: false }] }).ok, false);
});

test('firstUserText 跳过非 user 记录，并支持字符串与块两种 content 形态', () => {
  assert.equal(firstUserText([{ type: 'assistant', message: { content: 'x' } }, { type: 'user', message: { content: 'hello' } }]), 'hello');
  assert.equal(firstUserText([{ type: 'user', message: { content: [{ type: 'text', text: 'blk' }] } }]), 'blk');
  assert.equal(firstUserText([]), null);
});

test('readHeadRecords 丢掉被截断的最后一行（半行不能变成一条假记录）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-prompt-'));
  try {
    const f = join(dir, 'a.jsonl');
    const good = JSON.stringify({ type: 'user', message: { content: 'x' } });
    writeFileSync(f, good + '\n' + '{"type":"user","mess');  // 末尾是半行
    const { records, truncated } = readHeadRecords(f);
    assert.equal(truncated, true);
    assert.equal(records.length, 1);
    assert.equal(records[0].message.content, 'x');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verifyPrompts：hash 一致 ⇒ match:true；找不到 transcript ⇒ match:null，不是通过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-prompt-'));
  try {
    const sub = join(dir, 'subagents');
    mkdirSync(sub, { recursive: true });
    const prompt = '你是执行 Agent，任务 ST1';
    writeFileSync(join(sub, 'agent-a.jsonl'),
      JSON.stringify({ type: 'user', message: { content: prompt } }) + '\n');
    const rows = [makePromptRow({ run: 'r', task: 'ST1', role: 'executor', hash: promptHash(prompt), bytes: 1 })];

    const hit = verifyPrompts({ rows, sessionPath: dir });
    assert.equal(hit.results[0].match, true);
    assert.equal(hit.ok, true);

    // 台账记的是另一份 ⇒ 有人在中间改过 prompt
    const miss = verifyPrompts({
      rows: [makePromptRow({ run: 'r', task: 'ST1', role: 'executor', hash: promptHash('别的内容'), bytes: 1 })],
      sessionPath: dir,
    });
    assert.equal(miss.results[0].match, false, 'transcript 里有 ST1 但内容不同 ⇒ 必须是 false（不是 null）');
    assert.equal(miss.ok, false);

    // 完全找不到 ⇒ null。这条最重要：「看不到」不能长得像「通过」
    const none = verifyPrompts({ rows, sessionPath: join(dir, 'nope') });
    assert.equal(none.results[0].match, null);
    assert.equal(none.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('makeNonce 产出 8 位十六进制（与 claim-ledger 同形，两份台账才能对齐）', () => {
  for (let i = 0; i < 50; i++) {
    const n = makeNonce();
    assert.match(n, /^[0-9a-f]{8}$/);
  }
});

// ── L3 注入 ───────────────────────────────────────────────────────────

test('L3 注入派生：项目命令、outputs、nonce 都在，且每条都有出处', () => {
  const { facts } = deriveInjected({
    root: ROOT, outputs: ['docs/a.md'], nonce: 'a1b2c3d4',
    injected: [{ command: 'node scripts/x.mjs', path: 'g.txt', exitCode: 0 }],
    priorFailure: '上一轮漏了 fail_if',
  });
  for (const f of facts) {
    assert.ok(f.label && f.value && f.source, `事实缺字段：${JSON.stringify(f)}`);
  }
  const labels = facts.map((f) => f.label);
  assert.ok(labels.some((l) => l.includes('构建/测试命令')));
  assert.ok(labels.some((l) => l.includes('nonce')));
  assert.ok(labels.some((l) => l.includes('上次失败模式')));
});

test('L3 注入：认不出项目类型时如实说「我没认出来」，不编一条命令', () => {
  // 编错的命令比不给更糟：子 agent 会照着跑，然后得到 ENOENT 并合理地怀疑整个闸门。
  const { facts } = deriveInjected({ root: join(ROOT, 'docs'), outputs: [], nonce: null });
  const cmd = facts.find((f) => f.label.includes('构建/测试命令'));
  assert.match(cmd.value, /未识别出/);
  assert.match(cmd.value, /不是「没有测试」/);
});

test('L3 注入：--gate 文件不存在时必须报错（不能声明了注入却没落地）', () => {
  const r = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'compose-agent-prompt.mjs'), 'compose',
    '--run', 'r', '--task', 'ST1', '--graph', join(ROOT, 'tasks', 'runs', 'nope.json'),
    '--role', 'acceptor', '--gate', 'node scripts/x.mjs=/nonexistent/g.txt',
  ], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /task-graph|输出文件不存在/);
});

// ── CLI 端到端 ────────────────────────────────────────────────────────

/** 造一个临时任务图。角色定义仍读仓库里的真实文件（那才是被验证的对象）。
 *
 *  任务图放在 `tasks/runs/r1/` 下 —— 提示词台账与它同目录，这是真实布局。
 *  放在根目录也能跑，但那样测的就不是「会不会写到 run 目录」了。 */
function makeGraph(dir, over = {}) {
  const runDir = join(dir, 'tasks', 'runs', 'r1');
  mkdirSync(runDir, { recursive: true });
  const g = {
    run_id: 'r1', root_goal: '验证', constraints: [],
    subtrees: [{
      id: 'ST1', goal: '对交付物逐项判定，按预声明标准给出通过或不通过与证据引用',
      capability: 'acceptor', shape: 'artifact', token_budget_pct: 20, timeout_min: 25,
      parallel_with: [], depends_on: [],
      acceptance: [
        { id: 'AC1', criterion: '`node scripts/check-structure.mjs` 全绿', evidence: '命令输出', fail_if: 'exit != 0' },
      ],
      outputs: ['tasks/runs/r1/verdict.md'],
      why_this_layer: '验收必须由不写稿的一方做',
      ...over,
    }],
  };
  const p = join(runDir, 'task-graph.json');
  writeFileSync(p, JSON.stringify(g));
  return p;
}

const CLI = join(ROOT, 'scripts', 'compose-agent-prompt.mjs');
const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('CLI：检查不过 → exit 1，且不落文件、不记台账（拒绝派发是真的拒绝）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-cli-'));
  try {
    const graph = makeGraph(dir);
    const out = join(dir, 'p.md');
    const r = runCli(['compose', '--run', 'r1', '--task', 'ST1', '--graph', graph, '--role', 'acceptor',
      '--stop', '每项 AC 必带 file:line，25 分钟内返回', '--out', out]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /拒绝派发/);
    assert.equal(existsSync(out), false, '检查不过还落了文件 —— 这正是要防的「发出去但主线程不知道」');
    assert.equal(existsSync(join(dir, 'tasks', 'runs', 'r1', 'prompts.jsonl')), false, '检查不过不该记台账');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI：注入硬门输出后通过，落文件并记台账，且打印配套的 declare 命令', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-cli-'));
  try {
    const graph = makeGraph(dir);
    const gate = join(dir, 'gate.txt');
    writeFileSync(gate, '结构检查全部通过\n');
    const out = join(dir, 'p.md');
    const r = runCli(['compose', '--run', 'r1', '--task', 'ST1', '--graph', graph, '--role', 'acceptor',
      '--stop', '每项 AC 必带 file:line，25 分钟内返回',
      '--gate', `node scripts/check-structure.mjs=${gate}`, '--gate-exit', '0', '--out', out]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(out));

    const ledger = join(dir, 'tasks', 'runs', 'r1', 'prompts.jsonl');
    const { rows } = readPromptLedger(ledger);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task, 'ST1');
    assert.equal(rows[0].role, 'acceptor');
    assert.equal(rows[0].ok, true);
    // 落盘的字节必须就是台账里那个 hash
    assert.equal(rows[0].hash, promptHash(readFileSync(out, 'utf8')), '台账 hash 与落盘内容不一致');

    // 配套命令必须与 prompt 里的 nonce 一致 —— 两份台账靠它对上
    const m = /--nonce ([0-9a-f]{8})/.exec(r.stdout);
    assert.ok(m, `没打印配套的 declare 命令：${r.stdout}`);
    assert.ok(readFileSync(out, 'utf8').includes(m[1]), 'declare 命令里的 nonce 与提示词里的不是同一个');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI：没有这个角色时不发明岗位（exit 2）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-cli-'));
  try {
    const graph = makeGraph(dir);
    const r = runCli(['compose', '--run', 'r1', '--task', 'ST1', '--graph', graph, '--role', 'nosuchrole',
      '--stop', '10 分钟内返回']);
    assert.equal(r.status, 2);
    assert.match(r.stderr + r.stdout, /compose 不发明岗位/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI：没有任何一项检查不过时，同一份输入必须通过——否则上面的拒绝测试可能只是在测「CLI 永远失败」', () => {
  // 这条是「拒绝派发」的对照组。没有它，把 `ok` 硬写成 false 也能让上面那条变绿，
  // 而整条链其实什么都没检查。实测：把 ok 改成恒 true，只有上面那条会红；
  // 再加这一条，恒 false 也会被抓住。
  const dir = mkdtempSync(join(tmpdir(), 'ow-cli-'));
  try {
    const graph = makeGraph(dir);
    const gate = join(dir, 'gate.txt');
    writeFileSync(gate, 'ok\n');
    const r = runCli(['compose', '--run', 'r1', '--task', 'ST1', '--graph', graph, '--role', 'acceptor',
      '--stop', '每项 AC 必带 file:line，25 分钟内返回',
      '--gate', `node scripts/check-structure.mjs=${gate}`, '--gate-exit', '0', '--dry-run']);
    assert.equal(r.status, 0, `本该通过却失败：${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /✓ 通过/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI verify：没有台账时报「从没记过」，不是「全部对得上」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-cli-'));
  try {
    mkdirSync(join(dir, 'tasks', 'runs', 'r1'), { recursive: true });
    const r = runCli(['verify', '--run', 'r1', '--session', dir, '--root', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /从没记过/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 文档与规格的一致性 ────────────────────────────────────────────────

test('四层声明完整：L0–L3 各有作者与规则（分层不能只剩一张图）', () => {
  assert.deepEqual(LAYERS.map((l) => l.id), ['L0', 'L1', 'L2', 'L3']);
  for (const l of LAYERS) {
    assert.ok(l.name && l.author && l.source && l.rule, `${l.id} 声明不全`);
  }
  // L0 必须是「人写的、冻结」，L3 必须是「机器派生」—— 这两条的归属一改，分层就没意义了
  assert.match(LAYERS[0].author, /人/);
  assert.match(LAYERS[3].author, /机器/);
});

test('设计文档存在并说明分层（否则这份代码没有可读的动机说明）', () => {
  const p = join(ROOT, 'docs', 'design', '2026-11-14-main-thread-authored-prompts.md');
  assert.ok(existsSync(p), '缺少设计报告');
  const t = readFileSync(p, 'utf8');
  for (const k of ['L0', 'L1', 'L2', 'L3', '停机条件']) {
    assert.ok(t.includes(k), `设计报告缺 ${k}`);
  }
});
