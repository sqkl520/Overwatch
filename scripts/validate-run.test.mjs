#!/usr/bin/env node
/**
 * validate-run.test.mjs — 派发契约的回归测试。
 *
 * 这些测试守的是 CLAUDE.md 的硬约束，不是格式洁癖：
 *   2. 复杂任务至少 5 个独立 Agent，含锐评 / 验收 / 修复
 *   4. 验收标准必须预先声明
 *   6. 每层须写明「为什么需要这一层」
 *   8. 必须声明产出形态与预算
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  validateGraph, validateFile, CAPABILITIES, SHAPES,
  REQUIRED_FOR_COMPLEX, MIN_SUBTREES, SHAPES_REQUIRING_OUTPUTS,
  outputPathError, outputPathKey, checkDependencyCycles, ON_DEP_FAILED,
  complexityOpts,
} from './validate-run.mjs';

const ac = (id = 'AC1') => ({ id, criterion: 'scan --json 输出含 state 字段', evidence: 'src/a.mjs:12', fail_if: '缺字段' });

/** 把一份变异后的源码写进临时目录，**并把它的兄弟 import 改写成绝对 file URL**。
 *
 *  为什么需要这一步（2026-11-21）：`validate-run.mjs` 从「零兄弟依赖」变成了
 *  `import { projectRoot, runsDirInfo } from './project-root.mjs'`（「两个根」拆分）。
 *  变异体落在临时目录里，那条相对 import 就指向一个不存在的文件，
 *  于是三条负向测试全部变成 `ERR_MODULE_NOT_FOUND`，不再是「判据失效」。
 *
 *  那样最坏的地方不是红，而是**红在一个与被测行为无关的原因上** ——
 *  它看起来仍然像「回退后测试失败了」，实际上根本没有跑到判据。
 *  所以这里把 `./x.mjs` 一律改写成真实脚本目录下的绝对路径，让变异体与原件
 *  共享同一份兄弟模块，只有被替换的那一行不同。 */
function writeMutant(dir, src, name = 'validate-run-mutated.mjs') {
  const scriptsDir = import.meta.dirname.replace(/\\/g, '/');
  const asUrl = `file:///${scriptsDir.replace(/^\/+/, '')}`;
  const rebased = src.replace(/(from\s+['"])\.\/([^'"]+)(['"])/g, (m, a, rel, c) => `${a}${asUrl}/${rel}${c}`);
  const target = join(dir, name);
  writeFileSync(target, rebased, 'utf8');
  return target;
}
const sub = (over = {}) => ({
  id: 'ST1', goal: '实现扫描', capability: 'executor', shape: 'artifact',
  token_budget_pct: 40, timeout_min: 8, parallel_with: [], depends_on: [],
  acceptance: [ac()], outputs: ['scripts/scan-sessions.mjs'], why_this_layer: '需要真实语料验证',
  ...over,
});

const graph = (subs, over = {}) => ({
  run_id: 'r1', root_goal: '目标', constraints: [], subtrees: subs, ...over,
});

test('合法的单任务图通过', () => {
  const r = validateGraph(graph([sub()]));
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('缺 token_budget_pct / parallel_with / depends_on 直接报错（真实 run 就漏了这些）', () => {
  const s = sub();
  delete s.token_budget_pct;
  delete s.parallel_with;
  delete s.depends_on;
  const r = validateGraph(graph([s]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('token_budget_pct')));
  assert.ok(r.errors.some((e) => e.includes('parallel_with')));
  assert.ok(r.errors.some((e) => e.includes('depends_on')));
});

test('capability / shape 必须是枚举内的值', () => {
  assert.equal(validateGraph(graph([sub({ capability: '写代码的' })])).ok, false);
  assert.equal(validateGraph(graph([sub({ shape: '随便' })])).ok, false);
  for (const c of CAPABILITIES) {
    const r = validateGraph(graph([sub({ capability: c })]));
    assert.equal(r.ok, true, `${c} 应合法：${r.errors.join(',')}`);
  }
  for (const s of SHAPES) {
    const r = validateGraph(graph([sub({ shape: s })]));
    assert.equal(r.ok, true, `${s} 应合法：${r.errors.join(',')}`);
  }
});

test('验收标准不能为空——CLAUDE.md 硬约束 4', () => {
  const r = validateGraph(graph([sub({ acceptance: [] })]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('acceptance')));
});

test('不可判定的验收标准被拒——「不可判定的条目等于没有」', () => {
  for (const vague of ['可选', '视情况而定', '尽量做好', '适当优化']) {
    const s = sub({ acceptance: [{ id: 'AC1', criterion: vague, evidence: 'a.mjs:1', fail_if: 'x' }] });
    const r = validateGraph(graph([s]));
    assert.equal(r.ok, false, `"${vague}" 应被拒`);
  }
});

test('why_this_layer 必须写——CLAUDE.md 硬约束 6', () => {
  const s = sub();
  delete s.why_this_layer;
  const r = validateGraph(graph([s]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('why_this_layer')));
});

test('复杂任务（显式声明 requireComplex）必须含 review / acceptor / repair', () => {
  const subs = ['executor', 'research', 'critic', 'executor', 'executor']
    .map((cap, i) => sub({ id: `ST${i}`, capability: cap }));
  assert.equal(subs.length, MIN_SUBTREES);
  const r = validateGraph(graph(subs), { requireComplex: true });
  assert.equal(r.ok, false, '缺三个必需角色时应报错');
  for (const need of REQUIRED_FOR_COMPLEX) {
    assert.ok(r.errors.some((e) => e.includes(need)), `应指出缺 ${need}`);
  }
});

test('复杂任务补齐必需角色后通过', () => {
  const subs = ['executor', 'research', 'critic', 'review', 'acceptor', 'repair']
    .map((cap, i) => sub({ id: `ST${i}`, capability: cap }));
  const r = validateGraph(graph(subs));
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('重复 id 与悬空引用被拒', () => {
  assert.equal(validateGraph(graph([sub({ id: 'A' }), sub({ id: 'A' })])).ok, false);
  const r = validateGraph(graph([sub({ depends_on: ['GHOST'] })]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('GHOST')));
});

test('引用自己也被拒', () => {
  const r = validateGraph(graph([sub({ id: 'A', depends_on: ['A'] })]));
  assert.equal(r.ok, false);
});

test('validateFile：坏 JSON 与不存在的文件都返回错误而不是抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-vr-'));
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    assert.equal(validateFile(bad).ok, false);
    assert.equal(validateFile(join(dir, 'nope.json')).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validateFile：合法文件通过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-vr-'));
  try {
    const p = join(dir, 'task-graph.json');
    writeFileSync(p, JSON.stringify(graph([sub()])), 'utf8');
    const r = validateFile(p);
    assert.equal(r.ok, true, r.errors.join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── outputs：收活时对账的期望来源（设计 §7.1）─────────────────────────
//
// 这一组守的不是格式。`outputs` 是 `claim-ledger verify` 判 COMPLETE/PARTIAL/EMPTY
// 的唯一期望来源。它少一条，那个文件就永远不会被对账——**agent 产出了但主线程
// 没意识到**这件事就发生在那里。所以每条非法形态都要能挡住。

test('outputs 是必填：缺失直接报错（选填就等于允许不声明期望）', () => {
  const s = sub();
  delete s.outputs;
  const r = validateGraph(graph([s]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('outputs')), r.errors.join('\n'));
});

test('outputs 必须是非空数组以外的合法数组形态', () => {
  for (const bad of ['scripts/a.mjs', { a: 1 }, 42, null]) {
    const r = validateGraph(graph([sub({ outputs: bad })]));
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应被拒`);
    assert.ok(r.errors.some((e) => e.includes('outputs')), r.errors.join('\n'));
  }
});

test('outputs 元素必须是相对路径：绝对路径、盘符、UNC、正斜杠根都被拒', () => {
  const bads = [
    'C:\\repo\\a.md',
    'C:/repo/a.md',
    'D:\\Projects\\Overwatch\\scripts\\a.mjs',
    '/etc/passwd',
    '\\\\server\\share\\a.md',
    // Windows 的「驱动器相对」形态：不以分隔符开头，但仍然是绝对路径
    'C:a.md',
  ];
  for (const b of bads) {
    assert.ok(outputPathError(b), `${b} 应判为绝对路径`);
    const r = validateGraph(graph([sub({ outputs: [b] })]));
    assert.equal(r.ok, false, `${b} 应被拒`);
    assert.ok(r.errors.some((e) => e.includes('outputs')), `${b}: ${r.errors.join('\n')}`);
  }
});

test('outputs 不能含 ..（会指到任务范围之外）', () => {
  for (const b of ['../a.md', 'docs/../../a.md', 'docs\\..\\..\\a.md', 'a/..']) {
    assert.ok(outputPathError(b), `${b} 应被拒`);
    assert.equal(validateGraph(graph([sub({ outputs: [b] })])).ok, false, b);
  }
});

test('outputs 不接受空串、纯空白、尾部分隔符（都是「看着有其实没指对文件」）', () => {
  for (const b of ['', '   ', 'docs/', 'docs\\']) {
    assert.ok(outputPathError(b), `${JSON.stringify(b)} 应被拒`);
    assert.equal(validateGraph(graph([sub({ outputs: [b] })])).ok, false, b);
  }
});

test('合法的相对路径：正斜杠、反斜杠、点开头的隐藏文件、文件名里含点', () => {
  const goods = [
    'scripts/scan-sessions.mjs',
    'scripts\\scan-sessions.mjs',
    'docs/.gitkeep',
    'docs/v0.2.0-notes.md',
    'a/b/c/d.md',
  ];
  for (const g of goods) {
    assert.equal(outputPathError(g), null, `${g} 应合法：${outputPathError(g)}`);
    const r = validateGraph(graph([sub({ outputs: [g] })]));
    assert.equal(r.ok, true, `${g}: ${r.errors.join('\n')}`);
  }
});

test('shape 为 artifact 时 outputs 不得为空（否则必填被空数组绕过）', () => {
  assert.ok(SHAPES_REQUIRING_OUTPUTS.includes('artifact'));
  const r = validateGraph(graph([sub({ shape: 'artifact', outputs: [] })]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('outputs')), r.errors.join('\n'));
});

test('shape 为 exploration 时 outputs 允许为空（它按定义不承诺文件）', () => {
  const r = validateGraph(graph([sub({ shape: 'exploration', outputs: [] })]));
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('artifact + exploration 之外的 hybrid 也允许空 outputs', () => {
  const r = validateGraph(graph([sub({ shape: 'hybrid', outputs: [] })]));
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('两个子树声明同一个文件 → 提示（不判 error：真正判定留给 claim-ledger 的 CONFLICT）', () => {
  const subs = [
    sub({ id: 'ST1', outputs: ['docs/shared.md'] }),
    sub({ id: 'ST2', outputs: ['docs\\shared.md'] }), // 反斜杠是同一个文件
  ];
  const r = validateGraph(graph(subs));
  assert.equal(r.ok, true, '静态图层面的重复只是规划嫌疑，不阻塞');
  assert.ok(r.warnings.some((w) => w.includes('outputs') && w.includes('同一个文件')), r.warnings.join('\n'));
});

test('outputPathKey 把正反斜杠与大小写归一成同一个键（Windows 大小写不敏感）', () => {
  assert.equal(outputPathKey('docs/A.md'), outputPathKey('docs\\a.md'));
  assert.notEqual(outputPathKey('docs/a.md'), outputPathKey('scripts/a.md'));
});

test('负向：把 outputs 校验摘掉（checkOutputs 的结果被丢弃），非法输入必须变合格', async () => {
  // 真实的回退验证：把 validateGraph 里「取 checkOutputs 结果」这一步换成空结果，
  // 写进临时模块再跑。这正是「把校验注释掉」的最小形态。
  // 「改坏了测试必须红」这句话只有真的做一次回退才算数——否则这条测试证明的
  // 只是「现在恰好通过」，而不是「它在守着这段代码」。
  const src = readFileSync(join(import.meta.dirname, 'validate-run.mjs'), 'utf8');
  const find = 'const ores = checkOutputs(st);';
  assert.equal(src.split(find).length - 1, 1, '源码片段应当唯一');
  const mutated = src.replace(find, 'const ores = { errors: [], warnings: [], okPaths: [] }; // 回退：校验被摘掉');
  assert.doesNotMatch(mutated, /const ores = checkOutputs\(st\)/);

  const dir = mkdtempSync(join(tmpdir(), 'ow-vr-neg-'));
  try {
    const target = writeMutant(dir, mutated);
    const mod = await import(pathToFileURL(target).href);

    const noOut = graph([sub()]);
    delete noOut.subtrees[0].outputs;
    assert.equal(mod.validateGraph(graph([sub({ outputs: ['../a.md'] })])).ok, true,
      '校验摘掉后，含 .. 的路径必须能通过——说明「非法路径」那条测试守的是这段代码');
    assert.equal(mod.validateGraph(noOut).ok, true,
      '校验摘掉后，缺失 outputs 必须能通过——说明「必填」是这段代码给的');
    assert.equal(mod.validateGraph(graph([sub({ shape: 'artifact', outputs: [] })])).ok, true,
      '校验摘掉后，artifact + 空数组必须能通过——说明「artifact 非空」是这段代码给的');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 依赖成环：checkDependencyCycles 的返回值 ────────────────────────────
// 环检测与 render-plan.test.mjs 里那条「环上每条都判 DEFECT」是两件事：
// 那条守的是 stateOf 的降级行为，这里守的是**图进入系统时就被判死**这条判据。
// 两者都有才完整——只守渲染器等于允许环被带进系统。

/** 三色 DFS 的返回语义：成环节点 id，按图序、去重。 */
const cyc = (subs) => checkDependencyCycles(subs);

test('无环图 → 环检测返回空数组（无环不能误报，否则合法图全被拦）', () => {
  assert.deepEqual(cyc([]), []);
  assert.deepEqual(cyc([{ id: 'A', depends_on: [] }]), []);
  // 链 A→B→C：有依赖但不成环
  assert.deepEqual(cyc([
    { id: 'A', depends_on: ['B'] },
    { id: 'B', depends_on: ['C'] },
    { id: 'C', depends_on: [] },
  ]), []);
  // 菱形 A→B, A→C, B→D, C→D：分叉再汇合，不是环
  assert.deepEqual(cyc([
    { id: 'A', depends_on: ['B', 'C'] },
    { id: 'B', depends_on: ['D'] },
    { id: 'C', depends_on: ['D'] },
    { id: 'D', depends_on: [] },
  ]), []);
});

test('二元环 A→B→A → 两个都在返回里', () => {
  const r = cyc([
    { id: 'A', depends_on: ['B'] },
    { id: 'B', depends_on: ['A'] },
  ]);
  assert.deepEqual(r, ['A', 'B']);
});

test('三元环 A→B→C→A → 三个都在', () => {
  const r = cyc([
    { id: 'A', depends_on: ['B'] },
    { id: 'B', depends_on: ['C'] },
    { id: 'C', depends_on: ['A'] },
  ]);
  assert.deepEqual(r, ['A', 'B', 'C']);
});

test('自环 A→A → 返回 [A]', () => {
  // 自环在 validateGraph 里已被「不得引用自己」拦下，但环检测本身不能漏掉它：
  // 它是「最小值环」，任何一个自环都是不可收敛的。
  assert.deepEqual(cyc([{ id: 'A', depends_on: ['A'] }]), ['A']);
});

test('环外的节点不被卷进来（只报真正成环的那些）', () => {
  const r = cyc([
    { id: 'A', depends_on: ['B'] },
    { id: 'B', depends_on: ['A'] },
    { id: 'C', depends_on: ['A'] }, // C 依赖环上节点，但自己不在环上
    { id: 'D', depends_on: [] },
  ]);
  assert.deepEqual(r, ['A', 'B']);
  assert.ok(!r.includes('C'), 'C 只是依赖环上节点，自己不在环里');
  assert.ok(!r.includes('D'));
});

test('返回顺序按图序稳定，不随遍历顺序漂移', () => {
  // 同一次图的错误列表若顺序漂移，diff 会变成噪音，人就不看了。
  const subs = [
    { id: 'X', depends_on: [] },
    { id: 'A', depends_on: ['B'] },
    { id: 'B', depends_on: ['A'] },
  ];
  assert.deepEqual(cyc(subs), ['A', 'B']);
  assert.deepEqual(cyc([...subs]), ['A', 'B']);
});

test('坏输入不抛：非数组、缺 id、depends_on 非数组都安全跳过', () => {
  assert.deepEqual(cyc(null), []);
  assert.deepEqual(cyc(undefined), []);
  assert.deepEqual(cyc('不是数组'), []);
  assert.deepEqual(cyc([null, { goal: '没有 id' }, { id: 'A', depends_on: 'oops' }]), []);
  // 引用不存在的 id 不构成环（悬空引用由 validateGraph 另外逐条报）
  assert.deepEqual(cyc([{ id: 'A', depends_on: ['不存在'] }]), []);
});

test('有环时 validateGraph 必须报错（这才是环检测真正的作用）', () => {
  const g = graph([
    sub({ id: 'A', goal: '甲', outputs: ['a.mjs'], depends_on: ['B'] }),
    sub({ id: 'B', goal: '乙', outputs: ['b.mjs'], depends_on: ['A'] }),
  ]);
  const r = validateGraph(g);
  assert.equal(r.ok, false, '成环的图必须整体判不合格');
  const hit = r.errors.filter((e) => e.includes('成环'));
  assert.equal(hit.length, 1, `成环应当只报一条（不重复刷屏）：${r.errors.join('\n')}`);
  assert.ok(hit[0].includes('A') && hit[0].includes('B'), `错误信息要点出环上节点：${hit[0]}`);
});

test('三元环同样让 validateGraph 判不合格', () => {
  const r = validateGraph(graph([
    sub({ id: 'A', outputs: ['a.mjs'], depends_on: ['B'] }),
    sub({ id: 'B', outputs: ['b.mjs'], depends_on: ['C'] }),
    sub({ id: 'C', outputs: ['c.mjs'], depends_on: ['A'] }),
  ]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('成环')), r.errors.join('\n'));
});

test('无环的多依赖图不被成环判据误伤', () => {
  const r = validateGraph(graph([
    sub({ id: 'A', outputs: ['a.mjs'], depends_on: ['B', 'C'] }),
    sub({ id: 'B', outputs: ['b.mjs'], depends_on: ['D'] }),
    sub({ id: 'C', outputs: ['c.mjs'], depends_on: ['D'] }),
    sub({ id: 'D', outputs: ['d.mjs'], depends_on: [] }),
  ]));
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.ok(!r.errors.some((e) => e.includes('成环')), r.errors.join('\n'));
});

test('负向：把环检测调用摘掉，成环的图必须变合格', async () => {
  // 与 outputs 那条负向测试同样的做法：真的做一次回退，证明这条测试守的是那段代码，
  // 而不是「现在恰好通过」。只删调用点、不动 checkDependencyCycles 本体——
  // 那正是一个人不小心把防御删掉时的形态。
  const src = readFileSync(join(import.meta.dirname, 'validate-run.mjs'), 'utf8');
  const find = 'const cyclic = checkDependencyCycles(graph.subtrees);';
  assert.equal(src.split(find).length - 1, 1, '源码片段应当唯一');
  const mutated = src.replace(find, 'const cyclic = []; // 回退：环检测被摘掉');
  assert.doesNotMatch(mutated, /const cyclic = checkDependencyCycles\(graph\.subtrees\)/);

  const dir = mkdtempSync(join(tmpdir(), 'ow-vr-cycle-neg-'));
  try {
    const target = writeMutant(dir, mutated);
    const mod = await import(pathToFileURL(target).href);

    const cyclicGraph = graph([
      sub({ id: 'A', outputs: ['a.mjs'], depends_on: ['B'] }),
      sub({ id: 'B', outputs: ['b.mjs'], depends_on: ['A'] }),
    ]);
    assert.equal(validateGraph(cyclicGraph).ok, false, '原版必须拦下成环图');
    assert.equal(mod.validateGraph(cyclicGraph).ok, true,
      '摘掉调用后，成环图必须能通过——说明「成环被拒」是这段代码给的');
    assert.ok(!mod.validateGraph(cyclicGraph).errors.some((e) => e.includes('成环')),
      '摘掉调用后不该再有成环错误');
    // 环检测本体还在：证明变异只摘了调用点，不是把函数改坏
    assert.deepEqual(mod.checkDependencyCycles([{ id: 'A', depends_on: ['A'] }]), ['A']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 复杂度声明走 CLI（DF-042 缺陷 A）────────────────────────────────────
//
// 这一组守的**不是**复杂度判据本身（上面已有），而是一件更基础的事：
// **命令行入口有没有把 requireComplex 传下去。**
//
// 2026-11-21 审计实测：`main()` 里是 `targets.map((t) => validateFile(t))`，
// opts 被丢掉，于是 `requireComplex` 恒为默认 false——硬约束 2 的三条角色检查
// 在命令行上**一次都没执行过**，唯一触发它的是本文件里手动传参的那条用例。
// 输出照样是一行 ✓。所以这里的测试必须**真的 spawn 一次 CLI**：
// 只测 `validateGraph(g, { requireComplex: true })` 的话，把 CLI 改回去它照样绿，
// 而那正是这个缺陷的形状。

const CLI = join(import.meta.dirname, 'validate-run.mjs');
const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

/** 造一份「5 个子树但缺锐评/验收/修复」的图，落盘后返回路径。 */
function writeGraph(dir, subs, name = 'task-graph.json') {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(graph(subs)), 'utf8');
  return p;
}

test('CLI：--complex 真的把检查跑起来了（缺陷 A 的回归）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-vr-cli-'));
  try {
    // 5 个 executor，缺三个必需角色
    const subs = Array.from({ length: MIN_SUBTREES }, (_, i) =>
      sub({ id: `ST${i}`, capability: 'executor', outputs: [`out${i}.md`] }));
    const p = writeGraph(dir, subs);

    const r = runCli(['--complex', p]);
    assert.equal(r.status, 1, `--complex 应当 exit 1：${r.stdout}${r.stderr}`);
    for (const need of REQUIRED_FOR_COMPLEX) {
      assert.match(r.stdout, new RegExp(need), `--complex 的输出里应点名缺 ${need}：${r.stdout}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI 对照组：不加 --complex 时同一份图通过——否则上面那条只是在测「CLI 永远失败」', () => {
  // 没有这一条，把 CLI 改成恒 exit 1 也能让上面那条变绿，而整条链什么都没验。
  const dir = mkdtempSync(join(tmpdir(), 'ow-vr-cli-'));
  try {
    const subs = Array.from({ length: MIN_SUBTREES }, (_, i) =>
      sub({ id: `ST${i}`, capability: 'executor', outputs: [`out${i}.md`] }));
    const p = writeGraph(dir, subs);
    const r = runCli([p]);
    assert.equal(r.status, 0, `不加声明时应当通过：${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /缺少 review/, '没声明复杂时不该跑那三条角色检查');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI：--complex 补齐角色后通过（证明拒绝的是「缺角色」，不是「复杂」本身）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-vr-cli-'));
  try {
    const caps = ['executor', 'research', 'critic', 'review', 'acceptor', 'repair'];
    const subs = caps.map((c, i) => sub({ id: `ST${i}`, capability: c, outputs: [`out${i}.md`] }));
    const p = writeGraph(dir, subs);
    const r = runCli(['--complex', p]);
    assert.equal(r.status, 0, `补齐角色后应通过：${r.stdout}${r.stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI：声明 --complex 但子任务不足 5 个 → 判 error（硬约束 2 的两半都要执行）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-vr-cli-'));
  try {
    const subs = [
      sub({ id: 'ST1', capability: 'review', outputs: ['a.md'] }),
      sub({ id: 'ST2', capability: 'acceptor', outputs: ['b.md'] }),
      sub({ id: 'ST3', capability: 'repair', outputs: ['c.md'] }),
    ];
    const p = writeGraph(dir, subs);
    const r = runCli(['--complex', p]);
    assert.equal(r.status, 1, `不足 5 个应判不合格：${r.stdout}`);
    assert.match(r.stdout, /至少 5 个独立 Agent/, r.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI：--simple 与 --complex 同时给 → exit 2，不静默挑一个', () => {
  // 静默挑一个的两个方向都是错的：挑 complex 把简单任务全判死，挑 simple 静默关掉硬约束。
  const dir = mkdtempSync(join(tmpdir(), 'ow-vr-cli-'));
  try {
    const p = writeGraph(dir, [sub()]);
    const r = runCli(['--complex', '--simple', p]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr + r.stdout, /只能给一个/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI：两种声明互斥地映射到 requireComplex 的 true / false', () => {
  assert.deepEqual(complexityOpts(['--complex', 'g.json']), { opts: { requireComplex: true }, problem: null });
  assert.deepEqual(complexityOpts(['--simple', 'g.json']), { opts: { requireComplex: false }, problem: null });
  assert.deepEqual(complexityOpts(['g.json']), { opts: {}, problem: null });
  assert.ok(complexityOpts(['--complex', '--simple']).problem);
});

test('「没声明」必须出现在输出里，不能与「检查过并放行」同形', () => {
  // 这是整个缺陷的病根：不检查与通过长得一样。三态里的第三态必须可观测。
  const dir = mkdtempSync(join(tmpdir(), 'ow-vr-cli-'));
  try {
    const p = writeGraph(dir, [sub()]);
    const r = runCli([p]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /未声明/, `输出里必须写明没检查：${r.stdout}`);
    assert.match(r.stdout, /硬约束 2 没有执行/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validateGraph 返回 declared_complexity，区分「检查过放行」与「没检查」', () => {
  const g = graph([sub()]);
  assert.equal(validateGraph(g).declared_complexity, 'undeclared');
  assert.equal(validateGraph(g, { requireComplex: true }).declared_complexity, 'complex');
  assert.equal(validateGraph(g, { requireComplex: false }).declared_complexity, 'simple');
});

test('--simple 但图看起来复杂 → 警告（自相矛盾的声明要被指出）', () => {
  const subs = Array.from({ length: MIN_SUBTREES }, (_, i) =>
    sub({ id: `ST${i}`, capability: 'executor', outputs: [`o${i}.md`] }));
  const r = validateGraph(graph(subs), { requireComplex: false });
  assert.equal(r.ok, true, '声明是人的判断，不阻塞');
  assert.ok(r.warnings.some((w) => w.includes('看起来是复杂任务')), r.warnings.join('\n'));
});

test('负向：把 CLI 改回「不传 opts」，--complex 必须立刻失效（证明这些测试守的是这一行）', async () => {
  // 与 outputs / 环检测两条负向测试同一种做法：真的做一次回退。
  // 回退的形态取缺陷原来的样子——`validateFile(t)`，opts 被丢掉。
  const src = readFileSync(join(import.meta.dirname, 'validate-run.mjs'), 'utf8');
  const find = 'results = targets.map((t) => validateFile(t, opts));';
  assert.equal(src.split(find).length - 1, 1, '源码片段应当唯一');
  const mutated = src.replace(find, 'results = targets.map((t) => validateFile(t)); // 回退：opts 被丢掉');

  const dir = mkdtempSync(join(tmpdir(), 'ow-vr-cli-neg-'));
  try {
    const target = writeMutant(dir, mutated);
    const subs = Array.from({ length: MIN_SUBTREES }, (_, i) =>
      sub({ id: `ST${i}`, capability: 'executor', outputs: [`o${i}.md`] }));
    const g = writeGraph(dir, subs);
    const r = spawnSync(process.execPath, [target, '--complex', g], { encoding: 'utf8' });
    assert.equal(r.status, 0,
      `回退后 --complex 必须失效（exit 0）——说明「CLI 传 opts」是唯一让它生效的那一行：${r.stdout}`);
    assert.doesNotMatch(r.stdout, /缺少 review/, r.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
