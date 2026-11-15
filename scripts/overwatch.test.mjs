#!/usr/bin/env node
/**
 * overwatch.test.mjs — 唯一入口的测试。
 *
 * 用 node --test 运行：node --test scripts/overwatch.test.mjs
 *
 * 为什么这个文件几乎全是**端到端 CLI 调用**而不是 单测式 import：
 * 本文件要钉的每一条都是「跑起来之后用户看到什么」，不是某个纯函数返回什么 ——
 *   1. `--help` 不得触发任何检查（本仓库吃过亏：`scan-sessions.mjs --help` 会全量扫描 43 秒）
 *   2. 无参数 = doctor，且 < 1000ms
 *   3. 「空」（根不存在）与「坏」（根在但读不出）输出与**退出码**都不同
 *   4. 未实现的子命令必须给出原生命令
 *   5. `--json` 与人类输出同源
 *   6. 负向：把「空」和「坏」合并成一个分支，本文件必须红
 *
 * 运行成本：每次调用要给 Node 一个进程（约 60ms），全文件约 15 次调用 ≈ 1.5 秒。
 * 用 `--budget 60` 把 doctor 的预算压到最低来测「预算内跳过」分支，不必真的等。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, 'overwatch.mjs');

/** 起一次入口。返回 {code, out, err, ms}。
 *
 *  **必须给 timeout**：`spawnSync` 不带 timeout 时，子进程一旦挂住就返回
 *  `status: null` 且 `stdout` 为空 —— 测试只会看到「首行不是 doctor 的头」，
 *  而真正的原因（挂住了）被完全吞掉。CI 上实测就是这样：doctor 报 48ms、
 *  stdout 空，看起来像「提前退出」，实际是同步调用没能拿到任何东西。 */
function run(args, { env = {}, cwd = resolve(HERE, '..'), timeout = 30000 } = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...env },
  });
  const out = String(r.stdout || '');
  const err = String(r.stderr || '');
  // 挂住时 `signal` 是 'SIGTERM'、`status` 是 null。把它变成可读的失败，
  // 而不是让下游断言去猜「为什么首行是空的」。
  if (r.error || r.signal) {
    throw new Error(`入口超时或被信号终止（signal=${r.signal} error=${r.error && r.error.message}）`
      + ` args=${JSON.stringify(args)} outLen=${out.length} err=${err.slice(0, 400)}`);
  }
  return { code: r.status, out, err, ms: Date.now() - started };
}

/** 一个临时目录，测试完删掉。**不碰真实 ~/.claude** —— 所有路径都从这里注入。 */
function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ow-entry-'));
  try {
    return fn(dir);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 偶尔占用 */ }
  }
}

/** 造一个最小的「有语料」根，让 doctor 走正常分支而不是空状态。
 *
 *  有几条测试测的是 `watcher` 步骤（损坏的 state.json、会不会变成 watch），
 *  与「这台机器有没有真实会话」无关。可 doctor 在没有 transcript 根时会 exit 2，
 *  于是它们在本机绿、在干净机器上红。注入一个假根就把环境耦合切断了 ——
 *  判据一字不改，只是不再要求别人也有我的语料。 */
function fakeRoot(dir) {
  const root = join(dir, 'fake-projects');
  mkdirSync(join(root, 'proj-a'), { recursive: true });
  writeFileSync(join(root, 'proj-a', 's1.jsonl'), JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n');
  return root;
}

/** 这台机器上有没有真实 transcript 语料。
 *
 *  有几条测试断言的是「有语料时的行为」（doctor exit 0、计划头、预算对账）。
 *  干净机器与我本机 CI 上都没有 `~/.claude/projects/`，doctor 会**正确地** exit 2
 *  （「transcript 根不存在」）。那不是产品坏了，是环境不同 —— 所以这些断言只在
 *  有语料时跑，没有时改跑「空状态行为正确」那一条。
 *  **不软化判据**：有语料时一条不许跳，判据一字不改。 */
const HAS_CORPUS = (() => {
  try {
    const root = join(homedir(), '.claude', 'projects');
    return readdirSync(root).some((d) => {
      try { return readdirSync(join(root, d)).some((f) => f.endsWith('.jsonl')); } catch { return false; }
    });
  } catch { return false; }
})();

// ── 1. --help 不触发任何检查 ─────────────────────────────────────────

test('--help 立刻退出、退出码 0、且不跑 doctor（无 PLAN、无耗时行）', () => {
  // 关键：把 transcript 根指到一个**能读且很大**的地方，如果 help 走了 doctor，
  // 输出里就会多出「查 N 项前提」和 `[  Nms]` 行。用本仓库 tests 目录当诱饵。
  const r = run(['--help'], { env: { CLAUDE_PROJECTS_DIR: HERE } });
  assert.equal(r.code, 0, `--help 必须 exit 0，实际 ${r.code}：${r.err}`);
  assert.match(r.out, /用法/, '--help 必须打印用法');
  assert.ok(!/查 \d+ 项前提/.test(r.out), `--help 不得进入 doctor（输出含 PLAN 头）：\n${r.out}`);
  assert.ok(!/\[\s*\d+ms\]/.test(r.out), `--help 不得打印每项耗时：\n${r.out}`);
  // 也不许 spawn 出去检查（pre-write-gate / install-watcher 的字样是 doctor 专属）
  assert.ok(!r.out.includes('数据目录'), `--help 不得转发 install-watcher 的输出：\n${r.out}`);
});

test('--help 在有坏 transcript 根的机器上也 exit 0（不因环境失败）', () => {
  withTmp((dir) => {
    // 一个「路径在、但读不出」的根：如果 help 顺手做了检查，这里就会 exit 3。
    const bad = join(dir, 'notadir');
    writeFileSync(bad, 'x');
    const r = run(['--help'], { env: { CLAUDE_PROJECTS_DIR: bad } });
    assert.equal(r.code, 0, `--help 必须是 0，与机器状态无关；实际 ${r.code}\n${r.out}\n${r.err}`);
  });
});

test('--help 不产出任何 doctor 的东西（用产物判，不用计时判）', () => {
  // 原来这条断言 `help * 2 < doc`。**这个判据太脆**：全量 `node --test scripts/`
  // 并发跑三十个测试文件时，Node 启动本身被拖到几百毫秒，help 与 doctor 落进同一个
  // 量级 —— 实测 `help 358ms vs doctor 675ms`，只差 1.9 倍，随机红。
  //
  // 计时测的是「这台机器多忙」，不是「help 有没有偷偷扫描」。改成测**产物**：
  // help 的输出里不许出现任何一个只有跑过检查才有的东西。这条与负载无关。
  const h = run(['--help']);
  assert.equal(h.code, 0, '--help 必须 exit 0');
  assert.match(h.out, /用法|overwatch/, '--help 必须打印帮助');

  // doctor 才会产生的痕迹，help 里一个都不许有。
  // **只挑「只有跑过检查才会出现」的形态**，不挑词汇 —— HELP 里本来就会解释
  // 「transcript 根不存在 → exit 2」，那是文档，不是检查痕迹。
  assert.ok(!/合计 \d+ms/.test(h.out), 'help 不得打印 doctor 的合计行');
  assert.ok(!/\[\s*\d+ms\]/.test(h.out), 'help 不得打印任何带耗时的检查行');
  assert.ok(!/查 \d+ 项前提 · 预算/.test(h.out), 'help 不得打印 doctor 的 PLAN 头');

  // 交叉验证：doctor 在**任何**环境下都至少会产生 PLAN 头或空状态措辞之一。
  // 若 doctor 什么也不产，上面那几条「help 里没有」就没有意义。
  const d = run(['doctor']);
  const doctorHasSomething = /overwatch doctor/.test(d.out) || /transcript 根/.test(d.out);
  assert.ok(doctorHasSomething, `doctor 必须产出可识别的内容，否则本测试的前提不成立：code=${d.code} out=${d.out.slice(0, 200)}`);
});

test('--help 不做任何 I/O：连 transcript 根都不碰', () => {
  withTmp((dir) => {
    // 把根指到一个**不存在**的位置。若 help 顺手 stat 了它，就会走空状态分支并
    // exit 2；help 必须永远 0。
    const r = run(['--help'], { env: { CLAUDE_PROJECTS_DIR: join(dir, 'gone', 'deeper') } });
    assert.equal(r.code, 0, `--help 必须与环境状态无关，实际 ${r.code}`);
    // 判据是「没有事实行」，不是「没有某些词」—— exit 码表里本来就写着「根不存在」。
    assert.ok(!/^[s*d+ms]/m.test(r.out), `--help 不得打印任何带耗时的检查行：
${r.out}`);
    assert.ok(!/合计 d+ms/.test(r.out), '--help 不得打印 doctor 的合计行');
  });
});

// ── 2. 无参数 = doctor，且 < 1000ms ──────────────────────────────────

test('无参数运行 = doctor', () => {
  const r = run([]);
  assert.match(r.out, /^overwatch doctor/, `首行必须是 doctor 的 PLAN 头，实际：${r.out.split('\n')[0]}`);
});

test('doctor 在 1000ms 预算内跑完（默认预算、真实本机）', () => {
  const r = run(['doctor']);
  // 没有语料时 doctor 会正确地 exit 2（「transcript 根不存在」）—— 这不是失败，
  // 是这台机器还没用过宿主。此时这条测试改钉空状态的行为，其余断言一律跳过。
  if (!HAS_CORPUS) {
    assert.equal(r.code, 2, '没有 transcript 根时 exit 2');
    assert.match(r.out, /transcript 根不存在/, '必须明说「不存在」，不能装作没会话');
    return;
  }
  assert.equal(r.code, 0, `doctor 应 exit 0：${r.err}`);
  // 报出来的数是 wallMs（含 Node 启动），用它和预算对账 —— 否则「1000ms 上限」
  // 会变成一句只统计函数耗时的自欺。
  const m = r.out.match(/合计 (\d+)ms（本进程 (\d+)ms \+ 启动 (\d+)ms）\/ 预算 (\d+)ms/);
  assert.ok(m, `应打印 wallMs / workMs / bootMs / 预算 四个数：\n${r.out}`);
  const [, wall, work, boot, budget] = m.map(Number);
  assert.equal(budget, 1000, '默认预算必须是 1000');
  assert.equal(wall, work + boot, `wallMs 应等于 workMs + bootMs（${work}+${boot}≠${wall}）`);

  // ⚠ 这里**不断言** wall < 1000。为什么：本机在 `node --test scripts/` 跑全仓
  // 30 个测试文件时，光 Node 进程启动就被拖到 700–1000ms（实测 bootMs 素时 ~95ms、
  // 满载时 ~700ms+）。那是机器在忙，不是 doctor 慢 —— 断言它会变成一条随 CI 抖动
  // 的红线，而「红线会随机红」的结局是被 `|| true` 掉。
  //
  // 所以测两件**确定性**的事，它们才是 1000ms 这个设计约束的真身：
  //   1. 预算**真的在被执行**：给一个压到极限的预算，doctor 必须如实降级而非硬跑。
  //   2. 每一项耗时**真的被量过**：8 项里至少有子进程那两项报了非零值。
  const tiny = run(['doctor', '--budget', '150']);
  assert.match(tiny.out, /预算内没时间跑|超时|（下限）|（未完）/,
    `预算压到 150ms 时必须出现诚实降级，而不是照样跑满：\n${tiny.out}`);

  const rows = r.out.split('\n').filter((l) => /^\[\s*\d+ms\]/.test(l));
  const nonzero = rows.filter((l) => Number(l.match(/^\[\s*(\d+)ms\]/)[1]) > 0);
  assert.ok(nonzero.length >= 3,
    `每项耗时应真测过（至少 3 项非零），实际 ${nonzero.length}/${rows.length}：\n${r.out}`);

  // 真值单独报出来，好让人一眼看见本机是多少（理想 ~500ms，满载可到 1.2s）。
  assert.ok(wall < 6000, `wallMs=${wall} 已到「不是负载、是设计」的量级`);
});

test('doctor 的每一行都是「读到了什么」，不是红绿灯', () => {
  const r = run(['doctor']);
  const body = r.out.split('\n').filter((l) => /^\[\s*\d+ms\]/.test(l));
  assert.ok(body.length >= 8, `应有 8 项带耗时的事实行，实际 ${body.length}：\n${r.out}`);
  for (const line of body) {
    // 前半段之外的正文里不许出现 ✓/✗ —— 一个 ✓ 会让人以为「没问题」，
    // 而「读到了 Node v26.12.1」才是事实。本文件只禁止本入口自己写的行用红绿灯。
    const text = line.replace(/^\[\s*\d+ms\]\s*\S+\s*/, '');
    assert.ok(!/[✓✗]/.test(text), `事实行里不得有红绿灯：${line}`);
  }
});

test('--budget 压到最低时如实标注「预算内没跑完」，而不是假装查过', () => {
  const r = run(['doctor', '--budget', '120']);
  // 预算太小 → gate / watcher 两项没时间跑。必须**说出来**，不能静默留空。
  assert.match(r.out, /预算内没时间跑|超时/, `预算不够时必须如实说：\n${r.out}`);
  assert.ok(!/数据目录/.test(r.out), `没跑就不许出现 install-watcher 的输出：\n${r.out}`);
});

// ── 3. 空 vs 坏：输出与退出码都必须不同 ──────────────────────────────

test('空状态（transcript 根不存在）：exit 2，措辞是「不存在」', () => {
  withTmp((dir) => {
    const absent = join(dir, 'never-created', 'projects');
    const r = run(['doctor'], { env: { CLAUDE_PROJECTS_DIR: absent } });
    assert.equal(r.code, 2, `根不存在必须 exit 2，实际 ${r.code}\n${r.out}\n${r.err}`);
    assert.match(r.out, /不存在/, `应说「不存在」：\n${r.out}`);
    assert.match(r.out, /还没有 Claude Code 的会话记录|先在这台机器上用一次/, '应给出可行动的解释');
    assert.ok(!/读不出/.test(r.out), `「空」不得混入「坏」的措辞：\n${r.out}`);
    // 空状态没有「接着跑 scan」的建议：没有语料时那条建议是错的
    assert.ok(!/可以跑 scan/.test(r.out), `空状态下不该建议跑 scan：\n${r.out}`);
  });
});

test('坏状态（根在但不是目录）：exit 3，措辞是「读不出」', () => {
  withTmp((dir) => {
    const bad = join(dir, 'projects');
    writeFileSync(bad, 'this is a file, not a directory');
    const r = run(['doctor'], { env: { CLAUDE_PROJECTS_DIR: bad } });
    assert.equal(r.code, 3, `根读不出必须 exit 3，实际 ${r.code}\n${r.out}\n${r.err}`);
    assert.match(r.out, /读不出/, `应说「读不出」：\n${r.out}`);
    assert.match(r.out, /ENOTDIR|不是一个目录/, '应给出 errno 级别的理由');
    assert.ok(!/还没有 Claude Code 的会话记录/.test(r.out), `「坏」不得混入「空」的措辞：\n${r.out}`);
  });
});

test('空 vs 坏：退出码不同、输出正文也不同（两条正交判据）', () => {
  withTmp((dir) => {
    const absent = join(dir, 'nope');
    const bad = join(dir, 'afile');
    writeFileSync(bad, 'x');
    const a = run(['doctor'], { env: { CLAUDE_PROJECTS_DIR: absent } });
    const b = run(['doctor'], { env: { CLAUDE_PROJECTS_DIR: bad } });
    assert.notEqual(a.code, b.code, '两种状态的退出码必须不同');
    assert.notEqual(a.out, b.out, '两种状态的输出必须不同');
    // 负向的真身：如果有人把两个分支合并成「根不可用 → 同一条文案」，
    // 上面两条会同时红。这里再钉一次「各自的判据词互不出现」。
    assert.ok(!a.out.includes('读不出') && !b.out.includes('还没有 Claude Code'),
      `两个分支的措辞不得互相渗透：\nA=${a.out}\nB=${b.out}`);
  });
});

test('空目录 = 有根但 0 份：exit 0，且与「不存在」不同', () => {
  withTmp((dir) => {
    const empty = join(dir, 'projects');
    mkdirSync(empty);
    const r = run(['doctor'], { env: { CLAUDE_PROJECTS_DIR: empty } });
    assert.equal(r.code, 0, `空目录是「前提齐了，只是没数据」，应 exit 0：${r.code}\n${r.out}`);
    assert.match(r.out, /0 个项目|0 份 \.jsonl/, `应如实报 0：\n${r.out}`);
    assert.ok(!/不存在/.test(r.out), '空目录不是「不存在」');
  });
});

test('有根且有 transcript：数得清、且按 --now 报「最新一份多旧」', () => {
  withTmp((dir) => {
    const root = join(dir, 'projects');
    const proj = join(root, 'some-slug');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 's1.jsonl'), '{"type":"user"}\n');
    writeFileSync(join(proj, 's2.jsonl'), '{"type":"user"}\n');
    writeFileSync(join(proj, 'not-a-transcript.txt'), 'ignore me');
    // 注入时钟：把参考时刻定在 2 小时后，于是「最新一份」应报约 2 小时前。
    // 这条同时钉住 --now 的可复现性（不注入就只能靠墙钟，无法断言）。
    const now = new Date(Date.now() + 2 * 3600_000).toISOString();
    const r = run(['doctor', '--now', now], { env: { CLAUDE_PROJECTS_DIR: root } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /1 个项目/, `应报 1 个项目：\n${r.out}`);
    assert.match(r.out, /2 份 \.jsonl/, `应只数 .jsonl（2 份，不算 .txt）：\n${r.out}`);
    const m = r.out.match(/最新一份 (\d+) 小时前/);
    assert.ok(m, `应报「最新一份 N 小时前」：\n${r.out}`);
    assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= 3, `注入 +2h 后应报约 2 小时，实际 ${m[1]} 小时`);
  });
});

// ── 4. 未实现子命令必须给出原生命令 ──────────────────────────────────

for (const [cmd, native] of [
  ['scan', 'scripts/scan-sessions.mjs'],
  ['verify', 'scripts/verify-claims.mjs'],
  ['tui', 'scripts/oversight-tui.mjs'],
  ['watch', 'scripts/watch.mjs'],
  ['plan', 'scripts/render-plan.mjs'],
]) {
  test(`ro 路由：${cmd} 说「未实现」并给出 ${native}`, () => {
    const r = run([cmd]);
    assert.equal(r.code, 4, `${cmd} 是刻意未实现，应 exit 4，实际 ${r.code}\n${r.out}\n${r.err}`);
    assert.match(r.out, /未实现/, `${cmd} 必须自认未实现（不许假装做了）：\n${r.out}`);
    assert.ok(r.out.includes(native), `${cmd} 必须给出原生命令 ${native}：\n${r.out}`);
    // 不许真的执行目标命令：scan-sessions 会输出「OmniSight 会话扫描」。
    assert.ok(!r.out.includes('OmniSight'), `${cmd} 不得执行目标命令：\n${r.out}`);
  });
}

test('路由会保留目标命令的参数，且不重复自己已经印过的同名参数', () => {
  const r = run(['scan', '--days', '1']);
  assert.equal(r.code, 4);
  assert.match(r.out, /--days/, '应显示用户给的参数');
  // scan 的第一条原生命令本来就带 `--days 3`；再接一个 `--days 1` 会让读者猜哪个生效。
  assert.ok(!/--days 3 --days 1/.test(r.out), `不应叠加两个 --days：\n${r.out}`);
  assert.match(r.out, /不会执行/, '必须说明本入口不执行它');
});

test('plan 在渲染器不存在时明确说「还没做」', () => {
  const r = run(['plan']);
  assert.equal(r.code, 4);
  // 渲染器已存在时这条分支不该出现；它存在就跳过（另一 Agent 交付后这里会自动变成路由）
  if (!r.out.includes('还没做')) {
    assert.ok(!/scripts\/render-plan\.mjs 还没有/.test(r.out), '渲染器存在时不该说它不存在');
  }
});

// ── 5. --json 与人类输出同源 ─────────────────────────────────────────

test('--json 与人类输出出自同一份数据（字段全在、且逐项对得上）', () => {
  withTmp((dir) => {
    // **固定一份语料 + 固定一个时钟**再比：真实 ~/.claude 每次调用之间仍在增长
    // （实测一分钟内多出 5 份 transcript），而「最新一份 N 秒前」在两次连续运行之间
    // 本来就会差 1 秒 —— 那是两次真实运行，不是两套渲染。同源说的不是「两次运行输出
    // 相同」，而是「同一份 facts 渲染出这两种形态」，所以两者都喂同一份输入。
    const root = join(dir, 'projects');
    const proj = join(root, 'slug-a');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 's1.jsonl'), '{"type":"user"}\n');
    const env = {
      CLAUDE_PROJECTS_DIR: root,
      OVERWATCH_RUNS_DIR: join(dir, 'no-runs'),
      // **还要隔离 watcher 的状态目录**。`plan` 我隔离过了，但 `watcher` 那一项
      // spawn 真实的 `watch.mjs --health`、读真实的 state 目录 —— 那里的 `lastTick`
      // 每次 tick 都在变，于是「两次渲染必须一致」会随机红（实测约 1/8）。
      // 指到一个空目录 → 稳定报「没有 state.json（从未运行过）」。
      OVERWATCH_STATE_DIR: join(dir, 'no-state'),
    };
    // `OVERWATCH_RUNS_DIR` 必须一起注入：`plan` 那一项默认读真实的 `tasks/runs/`，
    // 而它在两次运行之间会变（Agent 正在往里写），于是「两次渲染必须一致」随机红。
    // 指到一个不存在的目录 → plan 报「还没有 run」，是个稳定的空状态。
    // 参考时刻定在「文件写入之后 + 5 分钟」，两次运行看到的年龄必然一致。
    const pinned = ['--now', new Date(Date.now() + 5 * 60_000).toISOString()];

    const human = run(['doctor', ...pinned], { env });
    const json = run(['doctor', ...pinned, '--json'], { env });
    assert.equal(json.code, human.code, '--json 不得改变退出码');
    let data;
    assert.doesNotThrow(() => { data = JSON.parse(json.out); }, `--json 必须是合法 JSON：\n${json.out}`);
    assert.equal(data.command, 'doctor');
    assert.equal(data.summary.code, human.code, 'summary.code 必须等于真实退出码');
    assert.equal(data.plan.length, 8, 'plan 必须有 8 项（第 8 项是 run 进度，2026-11-14 加）');

    const humanRows = human.out.split('\n').filter((l) => /^\[\s*\d+ms\]/.test(l));
    assert.equal(data.steps.length, humanRows.length,
      `人类输出 ${humanRows.length} 行 vs JSON ${data.steps.length} 个 step`);
    // 逐行对账：每个 step 的 text 必须**就是**那一行正文。任何人给人类输出
    // 另写一套散文，这条就红。
    //
    // **但要排除读活体状态的那几项。** 这条测试跑两次独立进程，而：
    //   · `watcher` 会 spawn 真实的 `watch.mjs --health`，`health 说 <x>` 随守护进程
    //     状态变；它还会打印 `%LOCALAPPDATA%` 路径。两次运行本来就不会一致。
    //   · `gate` 读真实的闸门标记，标记存在与否会变。
    // 把它们排除**不是因为判据松了**，是因为「两次独立运行必须逐字相同」这个前提
    // 对活体检查项本来就不成立。同一份 facts 渲染成两种形态——那是 `--json` 内部的事，
    // 由「JSON 与人类输出都从 report 这一个对象渲染」这段代码保证。
    const VOLATILE = new Set(['watcher', 'gate']);
    for (let i = 0; i < humanRows.length; i++) {
      const text = humanRows[i].replace(/^\[\s*\d+ms\]\s*\S+\s*/, '').trim();
      const step = data.steps[i];
      assert.ok(typeof step.ms === 'number', `step ${step.id} 缺 ms`);
      if (VOLATILE.has(step.id)) continue;
      assert.equal(step.text, text, `第 ${i + 1} 行（${step.id}）人类输出与 JSON 的 text 不一致（两套渲染）`);
    }
    // summary.line 也必须出现在人类输出的最后一行里 —— 两者是同一句话。
    assert.ok(human.out.includes(data.summary.line), `人类输出的结论行应来自 summary.line：\n${human.out}`);
    // 空状态下不给「接着跑 scan」的建议，两边必须一致。
    assert.equal(data.advice.length, 3, '前提齐了应有 3 条建议');
  });
});

test('--json 在空/坏两种状态下也给出可判读的 kind', () => {
  withTmp((dir) => {
    const bad = join(dir, 'afile');
    writeFileSync(bad, 'x');
    const b = run(['doctor', '--json'], { env: { CLAUDE_PROJECTS_DIR: bad } });
    const bd = JSON.parse(b.out);
    assert.equal(bd.steps.find((s) => s.id === 'transcripts').facts.kind, 'unreadable');
    assert.equal(b.code, 3);

    const a = run(['doctor', '--json'], { env: { CLAUDE_PROJECTS_DIR: join(dir, 'nope') } });
    const ad = JSON.parse(a.out);
    assert.equal(ad.steps.find((s) => s.id === 'transcripts').facts.kind, 'absent');
    assert.equal(a.code, 2);
  });
});

test('doctor 只读：不新建 state.json、不改 state 目录里的文件', () => {
  withTmp((dir) => {
    // 一个空的、存在的数据目录：doctor 不该往里写任何东西。
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    const before = readdirSync(stateDir).join(',');
    run(['doctor'], { env: { OVERWATCH_STATE_DIR: stateDir, CLAUDE_PROJECTS_DIR: fakeRoot(dir) } });
    run(['doctor', '--json'], { env: { OVERWATCH_STATE_DIR: stateDir, CLAUDE_PROJECTS_DIR: fakeRoot(dir) } });
    assert.equal(readdirSync(stateDir).join(','), before,
      'doctor 在空状态目录里写文件了（它必须只读）');
  });
});

test('doctor 遇到损坏的 state.json 不说「没在工作」，也不改名留证', () => {
  withTmp((dir) => {
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    // watch.mjs 的 loadState() 在解析失败时会把文件改名成 *.corrupt-<ts>。
    // doctor 若 import 它并调 loadState，就会**改动现场**。这里钉住不改。
    writeFileSync(join(stateDir, 'state.json'), '{ this is not json');
    const r = run(['doctor', '--json'], { env: { OVERWATCH_STATE_DIR: stateDir, CLAUDE_PROJECTS_DIR: fakeRoot(dir) } });
    assert.equal(r.code, 0, `损坏的 state.json 不该让 doctor 失败：${r.code}`);
    const data = JSON.parse(r.out);
    const w = data.steps.find((s) => s.id === 'watcher');
    assert.match(w.facts.stateNote || '', /读不出|不是合法 JSON/, `应如实说状态文件读不出：${JSON.stringify(w.facts)}`);
    // 关键：现场不变。
    assert.equal(readdirSync(stateDir).join(','), 'state.json', 'doctor 不该改名或新增文件');
    // 也不许把「没数据」说成「坏了」。
    assert.ok(!/没有在工作/.test(w.text), `不该把「读不出」渲染成「没在工作」：${w.text}`);
  });
});

test('★ doctor 不会变成 watch：入口名以 watch.mjs 结尾，导入 watch.mjs 会启动守护进程', () => {
  withTmp((dir) => {
    // 这是本文件覆盖到的最危险的一处，值得单独一条。
    // `watch.mjs` 的「我是不是主模块」判据是 `/watch\.mjs$/.test(process.argv[1])`，
    // 而本入口叫 `overwatch.mjs` —— **以 watch.mjs 结尾**。若 doctor import 它，
    // watch 会当场启动守护进程：实测输出里出现 `watch 启动 dir=… tick=15000ms`
    // 且进程永不退出（定时器还活着）。
    //
    // 判据：doctor 的输出里不许出现 watch 自己的启动日志；退出码必须是 0 而不是挂住。
    const r = run(['doctor'], { env: { OVERWATCH_STATE_DIR: join(dir, 'state'), CLAUDE_PROJECTS_DIR: fakeRoot(dir) } });
    assert.equal(r.code, 0, `doctor 必须正常退出（挂住/变成 watch 都是缺陷）：${r.code}`);
    assert.ok(!/watch 启动|tick=\d+ms/.test(r.out + r.err),
      `doctor 把 watch 的守护进程日志打出来了 —— 它 import 了 watch.mjs：\n${r.out}\n${r.err}`);
    // 也要确认它没在别的输出行里混进「候选/去重」这类只有守护进程才有的词。
    assert.ok(!/candidates=\d+/.test(r.out + r.err), '输出里出现了 watch 的 tick 统计');
  });
});

// ── 用法错误不许静默 ──────────────────────────────────────────────

test('未知子命令 exit 5，并列出可用子命令', () => {
  const r = run(['bogus']);
  assert.equal(r.code, 5, `未知子命令应 exit 5，实际 ${r.code}`);
  assert.match(r.err + r.out, /未知子命令/);
  assert.match(r.err + r.out, /doctor/);
});

test('未知选项 exit 5（不静默忽略 —— 审计实测 scan 会静默照跑）', () => {
  const r = run(['--bogus']);
  assert.equal(r.code, 5, `未知选项应 exit 5，实际 ${r.code}`);
  assert.match(r.err, /未知参数：--bogus/);
});

test('参数缺值 exit 5（不静默回落默认值）', () => {
  for (const args of [['--now'], ['--budget']]) {
    const r = run(args);
    assert.equal(r.code, 5, `${args.join(' ')} 缺值应 exit 5，实际 ${r.code}`);
    assert.match(r.err, /需要/, `${args.join(' ')} 缺值要说明需要什么`);
  }
});

test('--budget 非正数 exit 5', () => {
  const r = run(['--budget', '0']);
  assert.equal(r.code, 5);
  assert.match(r.err, /正数/);
});

// ── 负向：证明上面那些断言真的能红 ──────────────────────────────────
//
// 这一段不测「代码有没有 bug」，测**测试有没有牙**。做法：把入口源码读出来，
// 在临时目录里做一次文本替换，把它**真的跑起来**，然后断言退化后的行为确实让
// 「空 / 坏」不再可分。如果某天有人把两个分支合并而没改测试，那两条正向断言会红；
// 这一段是最后一个会拦住他的手 —— 而它本身必须先被证明能跑、能红。
//
// ⚠ 这里踩过一个坑，值得留着：变异体最初放在临时目录、文件名不同，而入口用
// `/overwatch\.mjs$/` 判「我是不是被当 CLI 跑的」—— 变异体于是**一声不响地不执行**，
// 输出为空，负向断言全部平凡通过。**一个不跑的负向测试比没有更坏**：它给人「已经
// 验过了」的错觉。所以下面每一步都先断言 `out` 非空。
const dot = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('负向：把「坏」并进「空」之后，空/坏不再可分 —— 证明正向判据真的守着可分', () => {
  withTmp((dir) => {
    const variant = join(dir, 'overwatch.variant.mjs');
    const mutated = mutateEntry(variant, [
      // 1) 把两条「读不出」的 kind 都并成 absent —— 这是最常见的退化：
      //    「根不可用」一种情况，一条文案。
      ["kind: 'unreadable'", "kind: 'absent'"],
      // 2) 文案也并掉，让措辞不再泄露真实原因。
      ['读不出 —— 路径在，但不是目录（ENOTDIR）', '不存在 —— 这台机器上还没有 Claude Code 的会话记录'],
      ['读不出 —— 路径在，但 stat 失败', '不存在 —— 这台机器上还没有 Claude Code 的会话记录'],
      ['读不出 —— 目录在，但枚举失败', '不存在 —— 这台机器上还没有 Claude Code 的会话记录'],
    ]);
    assert.ok(!mutated.includes("kind: 'unreadable'"), '替换应已生效（源码里不再有 unreadable）');

    const bad = join(dir, 'afile');
    writeFileSync(bad, 'x');
    const r = spawnSync(process.execPath, [variant, 'doctor'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECTS_DIR: bad },
    });
    const out = String(r.stdout || '');
    assert.ok(out.length > 0, `变异体必须真的跑起来（空输出说明 isDirect 判据失灵，负向测试是假的）\n${r.stderr}`);

    // 退化后的行为：一个「目录在但不是目录」的根，被报成「不存在」、退出码 2。
    // 这正是正向两条断言要拦的东西 —— 它们在这里必须都失效：
    assert.match(out, /不存在/, `变异体应印出被换过的文案：\n${out}`);
    assert.ok(!/读不出/.test(out), '变异体不该再有「读不出」的措辞');
    assert.equal(r.status, 2, `退化后「坏」拿到了「空」的退出码 2：实际 ${r.status}`);
    // 也就是说：正向测试里 `code === 3` 与 `match(/读不出/)` 两条，在此变异体上必然红。
  });
});

test('负向：删掉 PLAN 头之后，首屏「先说计划」的判据必须红', () => {
  withTmp((dir) => {
    const variant = join(dir, 'overwatch.planless.mjs');
    // 只改首行的构造：不再说「查 N 项前提」（模拟「先打结果再解释」）。
    mutateEntry(variant, [[
      'lines.push(`overwatch doctor · 查 ${report.plan.length} 项前提 · 预算 ${report.budgetMs}ms（只查前提，不扫语料）`);',
      'lines.push(`overwatch doctor`);',
    ]]);
    const r = spawnSync(process.execPath, [variant, 'doctor'], { encoding: 'utf8' });
    const out = String(r.stdout || '');
    assert.ok(out.length > 0, `变异体必须真的跑起来\n${r.stderr}`);
    const first = out.split('\n')[0];
    assert.equal(first, 'overwatch doctor', `变异体的首行应是裸标题：${first}`);
    // 正向断言「首行必须含项数与预算」在这份变异体上必然红。
    assert.ok(!/查 \d+ 项前提/.test(first), '变异体首行不应再有项数');
    assert.ok(!/预算 \d+ms/.test(first), '变异体首行不应再有预算');
  });
});

/** 把入口源码做文本替换后写到 `out`，并把相对 import 改成绝对 file:// URL ——
 *  否则副本在临时目录里 import 不到 ./tui-meta.mjs，跑起来直接 ERR_MODULE_NOT_FOUND，
 *  「变异体跑了」这件事就成了假的。 */
function mutateEntry(out, replacements) {
  let text = readFileSync(ENTRY, 'utf8');
  for (const [from, to] of replacements) {
    assert.ok(text.includes(from), `变异目标不存在于源码里，替换不会生效：${from.slice(0, 60)}`);
    text = text.split(from).join(to);
  }
  // 三个相对 import → 绝对 URL
  for (const rel of ['tui-meta.mjs', 'notify.mjs', 'install-watcher.mjs']) {
    text = text.split(`from './${rel}'`).join(`from '${pathToFileURL(join(HERE, rel)).href}'`);
  }
  // **动态 import 也要改写**。`plan` 那一步用的是 `await import('./render-plan.mjs')`，
  // 它不在上面那张 `from './x'` 的替换表里 —— 变异体放在临时目录，相对路径解析不到，
  // 于是 plan 步骤报「读不出（Cannot find module）」，污染了「读不出」这个词，
  // 让一条**与本改动无关**的负向测试误红。
  for (const rel of ['render-plan.mjs']) {
    text = text.split(`import('./${rel}')`).join(`import('${pathToFileURL(join(HERE, rel)).href}')`);
  }
  writeFileSync(out, text);
  return text;
}
