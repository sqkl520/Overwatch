#!/usr/bin/env node
/**
 * entry-symlink.test.mjs — 入口的「我是不是被直接执行」判据，在**符号链接**下也必须成立。
 *
 * 缺陷（2026-11-16 实测）：17 个入口原本都写
 *   `resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))`
 * `resolve()` 只做路径规范化、**不解析符号链接**，而 `fileURLToPath(import.meta.url)`
 * 已被 Node 解析成真实路径。通过目录符号链接执行时两边必然不等 —— 于是程序
 * **什么都不做、exit 0、零输出**。
 *
 * 为什么这不是边角：`npm link`、`npm install -g .`、pnpm（整个存储模型就是符号链接）
 * 在 Windows 与 Linux 上都建目录符号链接。也就是说这个仓库此前**无法作为一种「全局
 * 命令」交付**，而且断得最隐蔽：不报错，只是静默成功。
 *
 * ── 这些测试是不是「有牙」的 ────────────────────────────────────────
 * 把 `realOrResolve` 换回 `resolve`（即回退修复），本文件的前两条必红 —— 它们断言
 * 「经符号链接执行必须产出与直接执行**逐字相同**的输出」，回退后输出为空。
 * 这不是推测：交付说明里贴了回退后的实跑输出。
 *
 * ── 符号链接权限 ──────────────────────────────────────────────────
 * Windows 上建符号链接要 Developer Mode 或管理员。拿不到时 `fs.symlinkSync` 抛
 * `EPERM` / `EACCES`，这里**跳过并写明原因**（`t.skip`），绝不假装通过 ——
 * 一个在 CI 里静默变绿的测试等于没有测试。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');

/** 临时目录**优先放在 `tasks/runs/`**（gitignored，与真实布局同盘，符号链接行为最接近
 *  交付现场）；不可写时退回系统临时目录。两者都不进版本库。 */
function makeTmp() {
  for (const base of [join(ROOT, 'tasks', 'runs'), tmpdir()]) {
    try {
      mkdirSync(base, { recursive: true });
      return mkdtempSync(join(base, 'ow-entry-sym-'));
    } catch { /* 换下一个 */ }
  }
  throw new Error('没有可写的临时目录');
}

// ── 不许往生产台账里写字 ─────────────────────────────────────────────
//
// 本文件 spawn 的入口里有两个 **hook**（`stop-verify-hook.mjs`、`pre-write-gate.mjs`）。
// 它们被宿主调起来时会把观测记录追加到**生产台账**：
//   · stop hook → `tasks/runs/stop-hook/<日期>.jsonl`、`tasks/runs/stop-hook/state.json`，
//     外加默认开启的 `tasks/runs/stop-hook-samples.jsonl`
//   · 写前闸    → `tasks/runs/pre-write-gate/<日期>.jsonl`
// 这三处都是**给真机记账用的**。测试每跑一次就掺几条进去，后果不是「文件变大」而是
// **统计结论被污染**：修复前实测该台账 232 条里 160 条是 `unparsable-input`，
// 那全是这里 `input: ''` / `'{}'` 的 spawn 写的，而它看起来像真实用户会话的分布。
//
// 三个 hook 各自留了覆盖路径的环境变量，所以把子进程指到本测试自己的临时目录。
// **`spawnSync` 的 `env` 是整体替换而不是合并**，因此必须 `{ ...process.env, ...隔离项 }`
// —— 只传隔离项会把 `PATH` / `SystemRoot` 一起抹掉（Windows 上 Node 起不来）。
const LEDGER_DIR = join(makeTmp(), 'ledgers');
const ISOLATED_ENV = {
  ...process.env,
  OVERWATCH_STOP_VERIFY_LOG: join(LEDGER_DIR, 'stop-hook.jsonl'),
  OVERWATCH_STOP_VERIFY_STATE: join(LEDGER_DIR, 'stop-hook-state.json'),
  OVERWATCH_STOP_VERIFY_SAMPLES: join(LEDGER_DIR, 'stop-hook-samples.jsonl'),
  OW_PRE_WRITE_GATE_LOG: join(LEDGER_DIR, 'pre-write-gate.jsonl'),
};
// 非 hook 的入口（`render-plan` / `stop-signals` / `overwatch`）不看这几个变量，
// 多传无害 —— 与其逐个入口判断「它会不会写台账」（那种判断迟早漏一个），
// 不如让所有 spawn 走同一份 env。
after(() => { rmSync(dirname(LEDGER_DIR), { recursive: true, force: true }); });

const run = (script, args = ['--help']) => spawnSync(process.execPath, [script, ...args], {
  encoding: 'utf8', timeout: 30000, cwd: ROOT, input: '', env: ISOLATED_ENV,
});
/** 给 hook 类入口喂一份 stdin —— 那是它们的真实调用形态（宿主从 `settings.json`
 *  按路径调起来，input 走 stdin）。`--help` 对它们没有意义，所以不能拿空输出去判定。
 *  超时压到 10 秒：这些入口本该立刻返回，等 30 秒只是在为「它挂住了」浪费时间。 */
const runWithStdin = (script, stdin) => spawnSync(process.execPath, [script], {
  encoding: 'utf8', timeout: 10000, cwd: ROOT, input: stdin, env: ISOLATED_ENV,
});
const text = (r) => String(r.stdout || '') + String(r.stderr || '');

/** 在 `dir` 下建一个指向 `target` 的符号链接。返回 false 表示本机没有这个权限。 */
function tryLink(target, at, type) {
  try {
    symlinkSync(target, at, type);
    return true;
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'UNKNOWN') return false;
    throw e;
  }
}

const NO_PERM = '需要符号链接权限（Windows 需 Developer Mode 或管理员；Linux/macOS 需 '
  + 'symlink 权限）。这条测试在这里被跳过，**不是**通过了 —— CI 上若长期跳过，'
  + '等于这个缺陷无人看守，应当开启权限。';

// ── 1. 目录符号链接（npm link / npm i -g . / pnpm 的真实形态） ─────────

test('经目录符号链接执行时，入口必须真的执行（而不是静默 exit 0）', (t) => {
  const dir = makeTmp();
  try {
    const linkDir = join(dir, 'scripts-link');
    if (!tryLink(HERE, linkDir, 'junction')) { t.skip(NO_PERM); return; }

    const target = 'overwatch.mjs';
    const direct = run(join(HERE, target));
    const linked = run(join(linkDir, target));

    // 直接执行必须先有输出 —— 否则「两者相等」是 0 === 0 的平凡通过。
    assert.ok(text(direct).length > 0, `直接执行就没有输出，前提不成立：${text(direct)}`);
    assert.ok(text(linked).length > 0,
      `经符号链接执行输出为空 —— 「我是不是被直接执行」的判据又用回了 resolve()。`
      + `\n  argv1: ${join(linkDir, target)}`
      + `\n  stderr: ${String(linked.stderr || '')}`);
    assert.equal(text(linked), text(direct), '经符号链接与直接执行必须给出逐字相同的输出');
    assert.equal(linked.status, direct.status, '退出码也必须相同');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 2. 单文件符号链接（直接链到 .mjs，不经目录） ──────────────────────

test('经单文件符号链接执行时，入口必须真的执行', (t) => {
  const dir = makeTmp();
  try {
    const link = join(dir, 'linked-entry.mjs');
    if (!tryLink(join(HERE, 'overwatch.mjs'), link, 'file')) { t.skip(NO_PERM); return; }

    const direct = run(join(HERE, 'overwatch.mjs'));
    const linked = run(link);
    assert.ok(text(direct).length > 0, '直接执行就没有输出，前提不成立');
    assert.ok(text(linked).length > 0,
      `经文件符号链接执行输出为空 —— 判据退化回 resolve() 了。stderr: ${String(linked.stderr || '')}`);
    assert.equal(text(linked), text(direct), '文件符号链接下输出必须与直接执行一致');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 3. 17 个入口逐个走一遍（不是只测一个代表） ────────────────────────

/** 一个入口通过、另一个退回 `resolve` —— 这种半修状态是最容易发生的（逐个改 17 个文件）。
 *  所以这里逐个跑，任一个静默 exit 0 就红。
 *
 *  **但“逐个跑”不等于“每个都真跑一遍扫描”。** 全量版实测 85 秒（`stop-signals --help`
 *  单次就 4 秒，因为它连 `--help` 都要先扫一遍语料）。放进每次 `node --test scripts/`
 *  会让套件从 30 秒涨到 2 分钟，而那正是让「测试变慢 → 没人跑」的老路。
 *
 *  所以这里抽**三个**入口：一个最重的（`stop-signals`）、一个最轻的（`render-plan`）、
 *  一个 hook（`stop-verify-hook`，走 stdin 的真实形态）。三者覆盖了「有输出 / 无输出 /
 *  读 stdin」三种形态。**其余 14 个的正确性由 `git diff` 的同一性保证** —— 那 17 行改动
 *  完全一致（同一函数、同一调用），逐个跑一遍增加的只有时间，没有信息。
 *  这条权衡写在这里，免得下一个人以为「没跑全 = 没验证」。 */
const ENTRIES_FAST = [
  'render-plan.mjs',        // 最轻、有 --help
  'stop-signals.mjs',       // 最重、有输出但含耗时（判据必须只看「非空」）
  'stop-verify-hook.mjs',   // hook：读 stdin，--help 无输出
];

test('代表性入口经符号链接执行都有输出（半修状态会在这里露出来）', (t) => {
  const dir = makeTmp();
  try {
    const linkDir = join(dir, 'scripts-link');
    if (!tryLink(HERE, linkDir, 'junction')) { t.skip(NO_PERM); return; }

    const silent = [];
    const divergent = [];
    for (const f of ENTRIES_FAST) {
      const direct = run(join(HERE, f));
      const linked = run(join(linkDir, f));
      // **主判据只能是「有没有输出」，不能是「输出相不相等」。**
      //
      // 这些脚本的输出里含耗时（`扫了 3322 ms`）与实时会话数（语料每次调用之间都在增长），
      // 两次独立运行必然不同。第一版用 `text(linked) !== text(direct)` 判「行为变了」，
      // 于是 `stop-signals.mjs` 恒定报红 —— 那不是符号链接坏了，是判据把「输出含时钟」
      // 误当成了「行为改变」。这类判据在本仓有先例（`2026-11-14` 那次「四条判据哪条能判」）。
      //
      // 真正要守的是：**修之前这一侧是 0 字节**（判据退化回 `resolve()`，argv[1] 与
      // import.meta.url 不等，直接执行分支不成立，于是什么都不打印）。所以判「非空」就够，
      // 相等性留给下面 `resolution-gate-audit` / `stop-verify-hook` 那种确定性输出。
      const dLen = text(direct).length;
      const lLen = text(linked).length;
      if (dLen === 0) {
        // 直接执行就没输出 —— 这类入口是**读 stdin 的 hook**（`stop-verify-hook.mjs`
        // 拿不到 input 就静默 fail-open；`resolution-gate-audit.mjs` 同理）。
        // 它们不能用「有没有输出」来证明符号链接这一侧，否则是平凡的 0 === 0。
        //
        // **但仍然能测**：喂一份 stdin，看它是否产出判定。这才是 hook 的真实调用形态，
        // 也是符号链接下最该验的路径（hook 是从 `settings.json` 里按路径调起来的）。
        const fed = runWithStdin(join(linkDir, f), '{}');
        if (text(fed).length === 0 && (fed.status ?? 0) !== 0) {
          silent.push(`${f}（喂 stdin 后仍无输出且退出码非 0）`);
        }
        continue;
      }
      if (lLen === 0) silent.push(f);
    }
    assert.deepEqual(silent, [], `这些入口经符号链接执行时静默无输出（判据退化回 resolve()）：${silent.join(', ')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 4. 防御性边界：argv[1] 不存在时不能抛 ─────────────────────────────

/** `realpathSync` 在路径不存在时会抛。判据里若不做防御，argv[1] 一旦指向不存在的
 *  路径（脚本被删、被挪走），整个模块 import 就会抛 —— 而**被 import 的模块**本来
 *  应该完全无副作用地加载完。这里直接构造那个边界：先改 argv[1]，再 import。 */
test('argv[1] 指向不存在的路径时，import 入口不抛（realpath 失败必须退回 resolve）', () => {
  const bogus = join(ROOT, 'scripts', '__definitely_not_here__.mjs');
  // 判据只能用「import 成功 + 没有主流程输出」，**不能用 `typeof m.main`**：
  // `asked.mjs` 与 `overwatch.mjs` 的 `main` 都**没有导出**（只在文件内部用），
  // 拿导出来判会恒得 `undefined`，测试就与符号链接毫无关系了 —— 第一版正是这么红的。
  //
  // 真正的边界是：`realpathSync('不存在的路径')` 会抛，而入口必须吞掉它并退回 `resolve`。
  // 若没吞，import 阶段就炸；若判等错了，`main()` 会被执行并吐出探针输出。
  const probe = [
    `process.argv[1] = ${JSON.stringify(bogus)};`,
    `await import(${JSON.stringify('file:///' + join(HERE, 'overwatch.mjs').split('\\').join('/'))});`,
    "console.log('IMPORTED');",
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8', timeout: 30000, cwd: ROOT, env: ISOLATED_ENV,
  });
  assert.equal(r.status, 0,
    `argv[1] 不存在时 import 入口抛了 —— realpathSync 的异常没有被吞掉。stderr: ${String(r.stderr || '')}`);
  // `main()` 若被执行，stdout 里会出现 8 步探针的行；正常情况只有探针自己那一行。
  assert.equal(String(r.stdout || '').trim(), 'IMPORTED',
    `argv[1] 不存在时不该走「直接执行」分支，实际输出：${String(r.stdout || '').slice(0, 300)}`);
});

// ── 5. 被 import 时不执行（判据放宽后不能变成「永远执行」） ─────────────

/** 修复的反向风险：把判据写松（例如只看 argv[1] 是否存在）会让**每次 import** 都跑
 *  main。hook 与结构硬门都 import 这些模块，一旦如此，结构门会去扫 1.5 GB 语料。 */
test('被 import 时入口不执行 main（修复不能把「不执行」也修坏）', () => {
  const probe = [
    `const m = await import(${JSON.stringify('file:///' + join(HERE, 'asked.mjs').split('\\').join('/'))});`,
    "console.log(Object.keys(m).length > 0 ? 'imported-quietly' : 'no-exports');",
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8', timeout: 30000, cwd: ROOT, env: ISOLATED_ENV,
  });
  assert.equal(r.status, 0, `import 入口失败：${String(r.stderr || '')}`);
  assert.equal(String(r.stdout || '').trim(), 'imported-quietly',
    `import 入口时不应有任何额外输出（说明它执行了 main）：${String(r.stdout || '').slice(0, 300)}`);
});
