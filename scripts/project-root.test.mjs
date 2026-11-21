#!/usr/bin/env node
/**
 * project-root.test.mjs —— 「两个根」的回归测试。
 *
 * 守的东西按重要性排：
 *
 *   1. **五级阶梯每一级都真的能解**，且每个用例的**来源层级**被断言（只断言路径不够：
 *      同一个路径可能由第 1 级或第 4 级给出，那两件事的后果完全不同）。
 *   2. **第 5 级真的会失败**，且失败输出里**点名试过的四个位置**。回落成框架根
 *      会让「找不到」变成「写进框架目录」，而屏幕上看起来正常 —— 那是本次要修的形态。
 *   3. **无配置不崩**：`overwatch.config.json` 不存在 / 是垃圾 / `paths.runs` 类型不对
 *      都必须回落到默认，而不是抛或返回 `undefined`。
 *   4. **从 `%TEMP%` 跑的真实 CLI 不写本仓库**：这是事故的复现形态本身。
 *
 * 第 4 条是端到端，其余是纯函数。端到端那条必须真起子进程 ——
 * 因为缺陷就在「脚本被谁在什么 cwd 下调用」，进程内调用测不到 cwd。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, realpathSync, readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  frameworkRoot, projectRoot, resolveProjectRoot, runsDirFor, runsDirInfo,
  searchUp, rootFromArgv, readPathsConfig, levelText, formatTried, LEVELS,
  PROJECT_MARKERS, DEFAULT_RUNS_REL, ROOT_ENV, RUNS_DIR_ENV,
} from './project-root.mjs';

const CLI = join(import.meta.dirname, 'project-root.mjs');

/** 临时目录。`deep` 用来造「没有标记的子目录」——第 4 级必须从它向上找。 */
const tmp = (name = 'ow-proot-') => mkdtempSync(join(tmpdir(), name));

/** 建一个「看起来像用户项目」的目录：有 `.git/` 或 `.untildone/`。 */
function makeProject({ git = false, untildone = false } = {}) {
  const dir = tmp();
  if (git) mkdirSync(join(dir, '.git'), { recursive: true });
  if (untildone) mkdirSync(join(dir, '.untildone'), { recursive: true });
  return dir;
}

/** 空 env：**必须显式给**，否则测试会继承跑测试的那个进程的 `UNTILDONE_ROOT`，
 *  于是结果取决于外部环境 —— 这正是本仓库反复踩的「测试自己就不确定」。 */
const NOENV = Object.freeze({});

// ── 第 1 级：--root ───────────────────────────────────────────────────

test('第 1 级：--root 优先于其它四级，且不做存在性判断（不存在也照用）', () => {
  const d = makeProject({ git: true });
  const ghost = join(d, 'does-not-exist-yet');
  try {
    const r = resolveProjectRoot({
      root: ghost, env: { [ROOT_ENV]: d }, cwd: d, payloadCwd: d,
    });
    assert.equal(r.ok, true);
    assert.equal(r.level, 1);
    assert.equal(r.root, resolve(ghost), '--root 必须照用：拒绝它等于静默改去别处');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('第 1 级：--root 支持 `=` 形式与稀疏形式；缺值时不认它（回落到下一级）', () => {
  const d = makeProject({ git: true });
  try {
    assert.equal(rootFromArgv(['--root', d]), d);
    assert.equal(rootFromArgv([`--root=${d}`]), d);
    assert.equal(rootFromArgv(['--root']), null, '--root 后面没值不许当成一个空路径');
    assert.equal(rootFromArgv(['--root', '--json']), null, '--root 后面跟着另一个开关也是缺值');
    assert.equal(rootFromArgv([]), null);
    assert.equal(rootFromArgv(null), null, '非数组输入必须安全返回 null');

    const r = resolveProjectRoot({ argv: ['--root', d], env: NOENV, cwd: tmpdir() });
    assert.equal(r.level, 1);
    assert.equal(r.root, resolve(d));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── 第 2 级：环境变量 ─────────────────────────────────────────────────

test('第 2 级：UNTILDONE_ROOT 在没有 --root 时生效，优先于 cwd 向上找', () => {
  const proj = makeProject({ git: true });
  const elsewhere = tmp();
  try {
    const r = resolveProjectRoot({ env: { [ROOT_ENV]: proj }, cwd: elsewhere });
    assert.equal(r.ok, true);
    assert.equal(r.level, 2, '有环境变量时必须走第 2 级，不能被第 4 级抢先');
    assert.equal(r.root, resolve(proj));
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('第 2 级：空白串不等于设置（`FOO= node ...` 不该改落点）', () => {
  const proj = makeProject({ git: true });
  try {
    const r = resolveProjectRoot({ env: { [ROOT_ENV]: '   ' }, cwd: proj });
    assert.equal(r.level, 4, `空白串必须回落到第 4 级，实际走了 ${levelText(r.level)}`);
    assert.equal(r.root, resolve(proj));
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

// ── 第 3 级：宿主 payload 的 cwd ──────────────────────────────────────

test('第 3 级：payload.cwd 只在 hook 路径生效，且必须是**真实存在的目录**', () => {
  const proj = makeProject({ git: true });
  const loose = tmp(); // 没有 .git / .untildone
  try {
    const r = resolveProjectRoot({ env: NOENV, cwd: tmpdir(), payloadCwd: loose });
    assert.equal(r.ok, true);
    assert.equal(r.level, 3);
    assert.equal(r.root, resolve(loose), '宿主说会话根在哪就是哪，不要求它带标记');

    // 不存在的 payload.cwd 不许被当成项目根 —— 那会让台账写进一个不存在的地方
    const bad = resolveProjectRoot({ env: NOENV, cwd: proj, payloadCwd: join(loose, 'nope') });
    assert.equal(bad.level, 4, '不存在的 payload.cwd 必须跳过，交给第 4 级');
    assert.equal(bad.root, resolve(proj));
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(loose, { recursive: true, force: true });
  }
});

// ── 第 4 级：向上找标记 ───────────────────────────────────────────────

test('第 4 级：从深子目录向上找到 .git，返回的是那个祖先而不是起点', () => {
  const proj = makeProject({ git: true });
  const deep = join(proj, 'a', 'b', 'c');
  mkdirSync(deep, { recursive: true });
  try {
    const r = resolveProjectRoot({ env: NOENV, cwd: deep });
    assert.equal(r.ok, true);
    assert.equal(r.level, 4);
    assert.equal(r.root, resolve(proj), '必须返回项目根，不是 cwd —— 否则 run 台账会到处长');
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test('第 4 级：.untildone/ 优先于 .git/（同一个目录里两个都有时）', () => {
  const proj = makeProject({ git: true, untildone: true });
  const deep = join(proj, 'x', 'y');
  mkdirSync(deep, { recursive: true });
  try {
    const hit = searchUp(deep);
    assert.equal(hit.root, resolve(proj));
    assert.equal(hit.marker, '.untildone', `.untildone 是 UntilDone 自己的落点，必须优先（实际命中 ${hit.marker}）`);
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test('第 4 级：嵌套项目取**最近**的那个标记，不越过它继续往上找', () => {
  const outer = makeProject({ git: true });
  const inner = join(outer, 'vendor', 'inner');
  mkdirSync(join(inner, '.untildone'), { recursive: true });
  try {
    const hit = searchUp(join(inner, 'src'));
    assert.equal(hit.root, resolve(inner), '最近的标记才是「这个项目」，越过它会让 inner 的台账写进 outer');
  } finally { rmSync(outer, { recursive: true, force: true }); }
});

test('第 4 级：`.git` 是**文件**（worktree / submodule）也算项目根', () => {
  const proj = tmp();
  try {
    writeFileSync(join(proj, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n', 'utf8');
    const hit = searchUp(proj);
    assert.equal(hit && hit.marker, '.git');
    assert.equal(hit.root, resolve(proj));
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

// ── 第 5 级：失败 ─────────────────────────────────────────────────────

test('第 5 级：找不到时 ok=false、root=null，**不回落框架根**，且 tried 含全部四级', () => {
  const isolated = tmp();
  try {
    // tmp() 底下没有 .git / .untildone；但测试机的 %TEMP% 上层也未必没有，
    // 所以再套一层并且不用 searchUp 之外的判据 —— 直接断言「root 要么 null，
    // 要么不等于框架根」更稳：本仓库的祖先目录里一定有 .git。
    const r = resolveProjectRoot({ env: NOENV, cwd: isolated });
    if (r.ok) {
      // 机器环境让它找到了某个祖先（例如 %TEMP% 建在一个 git 仓库里）。
      // 那么唯一要守的是：**结果不许是框架根**（否则模板没变，缺陷还在）。
      assert.notEqual(r.root.toLowerCase(), frameworkRoot().toLowerCase(),
        `不应把框架仓库当成用户项目（实际 ${r.root}，第 ${r.level} 级）`);
    } else {
      assert.equal(r.level, 5);
      assert.equal(r.root, null);
      const levels = r.tried.map((t) => t.level);
      assert.deepEqual(levels, [1, 2, 3, 4], '失败时必须记录试过的四级（顺序即优先级）');
      const text = formatTried(r.tried);
      for (const lv of [1, 2, 3, 4]) {
        assert.match(text, new RegExp(`第 ${lv} 级`), `失败输出里缺少第 ${lv} 级：${text}`);
      }
    }
  } finally { rmSync(isolated, { recursive: true, force: true }); }
});

test('第 5 级：projectRoot() 默认返回 null（不是框架根），且**从不**静默回落', () => {
  const isolated = tmp();
  try {
    // 用 quiet 关掉 stderr 噪音；判据本身与 quiet 无关。
    const got = projectRoot({ quiet: true, env: NOENV, cwd: isolated });
    if (got !== null) {
      assert.notEqual(got.toLowerCase(), frameworkRoot().toLowerCase(),
        'projectRoot() 不许在找不到时回落到框架根 —— 那正是本次修复前的 bug');
    } else {
      assert.equal(got, null);
    }
  } finally { rmSync(isolated, { recursive: true, force: true }); }
});

test('第 5 级：只有显式传 fallback:"framework" 才回落 —— 默认永不回落', () => {
  const isolated = tmp();
  try {
    const got = projectRoot({ quiet: true, fallback: 'framework', env: NOENV, cwd: isolated });
    // 只有在第 5 级时才回落；若这台机器的 %TEMP% 上层有 .git，走的就不是第 5 级。
    const r = resolveProjectRoot({ env: NOENV, cwd: isolated });
    if (r.ok) assert.equal(got, r.root, '没走到第 5 级就不该回落');
    else assert.equal(got, frameworkRoot(), '走到第 5 级时显式 fallback 必须真的生效（否则它就是个假参数）');
  } finally { rmSync(isolated, { recursive: true, force: true }); }
});

test('四个生产调用点都**不**传 fallback —— 过渡期回落已被实测推翻并移除', () => {
  // 派单原写「第 5 级临时回落脚本位置，这样现有测试路径不变」。2026-11-21 实测：
  // 去掉回落之后全量 1861 条仍全绿，也就是说没有任何既有测试依赖它。
  // 代价为零时保留它是错的 —— 它让「找不到项目根」退化成「往框架目录写台账」，
  // 而那正是本次要修的形态。这条测试钉住那个决定，防止有人以「稳妥」为名加回去。
  const files = ['claim-ledger.mjs', 'compose-agent-prompt.mjs', 'render-plan.mjs', 'validate-run.mjs'];
  for (const f of files) {
    const src = readFileSync(join(import.meta.dirname, f), 'utf8');
    // 只看实际调用（去掉注释行），注释里提到这个参数是正当的
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, /fallback:\s*'framework'/,
      `${f} 的生产代码不该传 fallback:'framework' —— 那会让第 5 级静默写进框架目录`);
  }
});

// ── runs 目录 ─────────────────────────────────────────────────────────

test('runsDirFor：无配置 → <root>/.untildone/runs', () => {
  const root = resolve(tmpdir(), 'ow-fake-root');
  const info = runsDirInfo(root, { config: null, env: NOENV });
  assert.equal(info.dir, join(root, '.untildone', 'runs'));
  assert.match(info.source, /默认/);
});

test('runsDirFor：配置 paths.runs 生效，且 source 点名配置（不然「生效了没有」看不出来）', () => {
  const root = resolve(tmpdir(), 'ow-fake-root');
  const info = runsDirInfo(root, { config: { paths: { runs: 'tasks/runs' } }, env: NOENV });
  assert.equal(info.dir, join(root, 'tasks', 'runs'));
  assert.match(info.source, /paths\.runs/);
});

test('runsDirFor：UNTILDONE_RUNS_DIR 压过配置（隔离变量必须永远有效）', () => {
  const root = resolve(tmpdir(), 'ow-fake-root');
  const info = runsDirInfo(root, {
    config: { paths: { runs: 'tasks/runs' } },
    env: { [RUNS_DIR_ENV]: '/tmp/isolated-runs' },
  });
  assert.equal(info.dir, resolve('/tmp/isolated-runs'));
  assert.equal(info.source, RUNS_DIR_ENV);
});

test('runsDirFor：环境变量**相对 root** 解析，绝对路径原样用', () => {
  const root = resolve(tmpdir(), 'ow-fake-root');
  const rel = runsDirInfo(root, { config: null, env: { [RUNS_DIR_ENV]: 'alt/runs' } });
  assert.equal(rel.dir, join(root, 'alt', 'runs'));
  const abs = runsDirInfo(root, { config: null, env: { [RUNS_DIR_ENV]: resolve(tmpdir(), 'abs-runs') } });
  assert.equal(abs.dir, resolve(tmpdir(), 'abs-runs'));
});

test('runsDirFor：--runs-dir 压过环境变量与配置（CLI 明说优先）', () => {
  const root = resolve(tmpdir(), 'ow-fake-root');
  const info = runsDirInfo(root, {
    explicit: '/tmp/explicit-runs',
    config: { paths: { runs: 'tasks/runs' } },
    env: { [RUNS_DIR_ENV]: '/tmp/isolated-runs' },
  });
  assert.equal(info.dir, resolve('/tmp/explicit-runs'));
  assert.equal(info.source, '--runs-dir');
});

test('runsDirFor：无配置不崩——配置读不出来时用默认，不返回 undefined', () => {
  const root = tmp();
  try {
    // 文件不存在
    assert.equal(readPathsConfig(root), null);
    assert.equal(runsDirFor(root, { env: NOENV }), join(root, '.untildone', 'runs'));

    // 文件是垃圾 JSON
    writeFileSync(join(root, 'overwatch.config.json'), '{ not json', 'utf8');
    assert.equal(readPathsConfig(root), null);
    assert.equal(runsDirFor(root, { env: NOENV }), join(root, '.untildone', 'runs'));

    // paths.runs 类型不对
    writeFileSync(join(root, 'overwatch.config.json'), JSON.stringify({ paths: { runs: 42 } }), 'utf8');
    assert.equal(runsDirFor(root, { env: NOENV }), join(root, '.untildone', 'runs'));

    // paths 是数组
    writeFileSync(join(root, 'overwatch.config.json'), JSON.stringify({ paths: ['x'] }), 'utf8');
    assert.equal(runsDirFor(root, { env: NOENV }), join(root, '.untildone', 'runs'));

    // 正常配置
    writeFileSync(join(root, 'overwatch.config.json'), JSON.stringify({ paths: { runs: 'tasks/runs' } }), 'utf8');
    assert.equal(runsDirFor(root, { env: NOENV }), join(root, 'tasks', 'runs'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runsDirFor：root 为空时用框架根（不产生 undefined / 相对路径）', () => {
  const d = runsDirFor(null, { config: null, env: NOENV });
  assert.ok(existsSync(d) || d.length > 0);
  assert.equal(d, join(frameworkRoot(), '.untildone', 'runs'));
});

// ── 常量与格式 ────────────────────────────────────────────────────────

test('levelText 对每一级都给出人话；越界时如实说「未知来源」，不编', () => {
  for (const lv of [1, 2, 3, 4, 5]) {
    assert.match(levelText(lv), new RegExp(`第 ${lv} 级`));
    assert.ok(LEVELS[lv], `第 ${lv} 级必须有来源说明`);
  }
  assert.match(levelText(99), /未知来源/);
});

test('PROJECT_MARKERS 的顺序就是优先级：.untildone 在 .git 之前', () => {
  assert.deepEqual([...PROJECT_MARKERS], ['.untildone', '.git']);
  assert.equal(DEFAULT_RUNS_REL, '.untildone/runs');
});

// ── 端到端 CLI：从 %TEMP% 跑，必须不写本仓库 ──────────────────────────

const runCli = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', timeout: 30000, ...opts,
});

/** 跑一次前/后，本仓库 `tasks/runs/` 的目录清单。**用清单的差集判定**,不是靠「应该不会写」。 */
function runsSnapshot() {
  const d = join(frameworkRoot(), 'tasks', 'runs');
  if (!existsSync(d)) return [];
  try { return readdirSync(d).sort(); } catch { return []; }
}

test('端到端：从 %TEMP% 的项目里跑 CLI → 用的就是那个项目，且本仓库零增量', () => {
  const proj = makeProject({ git: true });
  const before = runsSnapshot();
  try {
    const r = runCli(['runs-dir'], { cwd: proj, env: { ...process.env, [ROOT_ENV]: '' } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), join(proj, '.untildone', 'runs'),
      `runs 目录必须落在用户项目里，实际：${r.stdout.trim()}`);
    assert.match(r.stderr, /第 \d 级/, '必须打印用了哪一级 —— 不然「写对了」与「写错地方」同形');
    assert.deepEqual(runsSnapshot(), before, '从用户项目跑不许在框架仓库里新增任何东西');
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test('端到端：claim-ledger 在无根目录里 exit 2，且**框架仓零新增**（事故的正向判据）', () => {
  // 这是本次缺陷最完整的那条回归：修前它在无根目录里 exit 0 并把台账写进框架仓库。
  // 现在必须 exit 2、stdout 无台账、框架仓 `tasks/runs/` 零新增。
  const isolated = tmp();
  const before = runsSnapshot();
  try {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, 'claim-ledger.mjs'), 'declare',
      '--run', 'probe-no-root', '--task', 'ST1', '--paths', 'a.md'], {
      cwd: isolated,
      // 清掉隔离变量：否则本机会话的 UNTILDONE_ROOT 会让它走第 2 级
      env: { ...process.env, [ROOT_ENV]: '', PATH: process.env.PATH },
      encoding: 'utf8', timeout: 30000,
    });
    if (r.status === 0) {
      // 这台机器的 %TEMP% 上层有 .git/.untildone，于是走了第 4 级 —— 那不是失败。
      // 唯一要守的仍然是：不许写进框架仓库。
      assert.deepEqual(runsSnapshot(), before,
        `从 ${isolated} 跑却往框架仓写入了东西：${rstdout(r)}`);
      return;
    }
    assert.equal(r.status, 2, `第 5 级必须 exit 2：${rstdout(r)}`);
    assert.match(r.stderr, /第 5 级/);
    assert.match(r.stderr, /不猜、不回落/, '必须明说没有回落，而不是让用户以为它用了别的位置');
    assert.equal(existsSync(join(isolated, '.untildone')), false, '失败时不该在用户目录里留半成品');
    assert.deepEqual(runsSnapshot(), before, `失败路径也不许写框架仓：${rstdout(r)}`);
  } finally { rmSync(isolated, { recursive: true, force: true }); }
});

const rstdout = (r) => `\nstatus=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`;

test('端到端：%TEMP% 里没有标记时 exit 2，且 stderr 点名试过的四级', () => {
  // 找一个**保证**没有 .git 祖先的起点很难（%TEMP% 可能在任意位置），
  // 所以这里用一个 `--root` 都解不开的形态来验第 5 级的输出：把 cwd 指到一个
  // 空目录，并显式清掉两个环境变量。若这台机器的祖先里有 .git，则跳过 —— 但
  // 那条「不回落框架根」的判据仍会跑（见上一个用例）。
  const isolated = tmp();
  try {
    const r = runCli([], {
      cwd: isolated,
      env: { ...process.env, [ROOT_ENV]: '', PATH: process.env.PATH },
    });
    if (r.status === 2) {
      assert.match(r.stderr, /第 5 级/);
      for (const lv of [1, 2, 3, 4]) {
        assert.match(r.stderr, new RegExp(`第 ${lv} 级`), `失败输出缺少第 ${lv} 级：${r.stderr}`);
      }
      assert.equal(r.stdout.trim(), '', '失败时 stdout 不该有「结果」');
    } else {
      assert.equal(r.status, 0);
      assert.notEqual(r.stdout.trim().toLowerCase(), frameworkRoot().toLowerCase());
    }
  } finally { rmSync(isolated, { recursive: true, force: true }); }
});

test('端到端：--root 与 --json 的可组合性（第 1 级优先，且 json 里 level=1）', () => {
  const d = makeProject({ untildone: true });
  try {
    const r = runCli(['--root', d, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.level, 1);
    assert.equal(j.root, resolve(d));
    assert.equal(j.ok, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('端到端：framework 子命令返回框架根，与 frameworkRoot() 一致', () => {
  const r = runCli(['framework']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), frameworkRoot());
});

test('project-root.mjs 不导出 `resolve`（那会让 import 拿到 node:path 的同名函数）', async () => {
  // 模块里确实 import 了 `resolve`，若有人把它再 export 出去，调用方
  // `import { resolve } from './project-root.mjs'` 会拿到路径函数而不是根解析函数 ——
  // 静默且难查。这条哨兵比读注释可靠。
  const mod = await import('./project-root.mjs');
  assert.equal(mod.resolve, undefined, 'resolve 是 node:path 的私有 import，不该成为本模块的导出');
});

// ── 负向：把 projectRoot 退回 frameworkRoot，上面那条端到端必须红 ──────

test('负向验证：把 projectRoot() 退回 frameworkRoot()，端到端用例必须变红', async () => {
  const { readFileSync } = await import('node:fs');
  const srcPath = join(import.meta.dirname, 'project-root.mjs');
  const src = readFileSync(srcPath, 'utf8');

  // 回退形态取缺陷的原始样子：解析结果直接换成框架根。
  // 只改 `projectRoot()` 的返回，不动 `resolveProjectRoot()` —— 这样 CLI
  // （走 resolveProjectRoot）会红，而纯函数用例照常绿，红色指向的正是那一行。
  const find = 'export function projectRoot({ quiet = false, fallback = null, ...opts } = {}) {\n  const r = resolveProjectRoot(opts);';
  assert.equal(src.split(find).length - 1, 1, '源码片段应当唯一（找不到就说明 projectRoot 被改写过，这条负向测试要跟着改）');
  const mutated = src.replace(find,
    'export function projectRoot({ quiet = false, fallback = null, ...opts } = {}) {\n  if (true) return frameworkRoot(); // 回退：退回脚本位置（本次要修的那个 bug）\n  const r = resolveProjectRoot(opts);');

  const dir = mkdtempSync(join(tmpdir(), 'ow-proot-neg-'));
  const proj = makeProject({ git: true });
  try {
    const target = join(dir, 'project-root-mutated.mjs');
    writeFileSync(target, mutated, 'utf8');
    // 一次性把两件事打出来：回退后的 `projectRoot()` 拿到了什么，以及**那份副本自己的**
    // `frameworkRoot()` 是什么。不能拿真仓库的 `frameworkRoot()` 去比 ——
    // 副本的脚本位置是临时目录，所以它的框架根就是临时目录的上一级，那才是缺陷形态。
    const script = `import { projectRoot, frameworkRoot } from ${JSON.stringify('file:///' + target.replace(/\\/g, '/'))};`
      + `console.log(JSON.stringify({ got: projectRoot({ quiet: true, env: {}, cwd: ${JSON.stringify(proj)} }), fw: frameworkRoot() }));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const norm = (p) => {
      try { return realpathSync(resolve(p)).toLowerCase(); } catch { return resolve(p).toLowerCase(); }
    };
    assert.equal(norm(out.got), norm(out.fw),
      '回退后必须返回脚本位置（框架根）—— 若这里没变，说明上面的回退没生效，负向验证是假的');
    assert.notEqual(norm(out.got), norm(proj),
      '这条断言就是本次修复的判据：从用户项目跑却返回框架根，即事故本身');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});
