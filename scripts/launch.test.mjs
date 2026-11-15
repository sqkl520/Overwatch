#!/usr/bin/env node
/**
 * launch.test.mjs — `overwatch launch` 的测试。
 *
 * 用 node --test 运行：node --test scripts/launch.test.mjs
 *
 * ── 这个文件钉的是什么 ────────────────────────────────────────────────
 *
 * 1. **`--dry-run` 真的什么都不做**（不起子进程、不写文件），且打印出来的命令行
 *    里有 `--plugin-dir <repo>/.claude`。这是唯一一个「不登录也能核到底」的锚点。
 * 2. **认证失败 → exit 6**，且 stderr 上有可操作的提示（三行能直接敲的命令）。
 * 3. **静默失败（exit 0 + 空输出）→ exit 7**。这是本仓库已经吃过两次亏的形态：
 *    宿主能 exit 0 而实际什么都没做，任何把退出码当结论的调用方都会看错。
 * 4. **`is_error:true` + `subtype:"success"` + exit 0 → 失败**。宿主原话就长这样。
 * 5. **roster 不能只挂一部分** —— 钉住「整目录挂载 + 明确告知」这个现状，
 *    哪天有人真做了筛选，这条会红，届时必须同时改 `launch.mjs` 的注释与 spec。
 *
 * ── 为什么用假宿主而不是真的 `claude` ────────────────────────────────
 *
 * 这台机器上 `claude -p` 未登录时返回 1（本机实测），但**CI 与别人的机器不一定是 1**；
 * 而「网关配方下 exit 0 且输出为空」那种形态，我不能靠环境变量在自己机器上复现 ——
 * 它取决于上游网关的口味。所以判据必须由**参数固定的假宿主**驱动：
 * `--host-bin <一个 .mjs>` 是 `launch.mjs` 的公开选项，假宿主走的就是真宿主同一条路。
 *
 * 假宿主是**现场生成**的（`writeFileSync` 到临时目录），不进仓：
 * 它是测试夹具，不是产品的一部分。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, 'overwatch.mjs');
const REPO = resolve(HERE, '..');
const PAYLOAD_DIR = join(REPO, '.claude');

/** 起一次入口。`timeout` 必须给：不带 timeout 时子进程挂住会让 `status` 变 null、
 *  `stdout` 变空，测试只会看到「首行不对」而看不到「挂住了」。 */
function run(args, { env = {}, cwd = REPO, timeout = 60000 } = {}) {
  const r = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd, encoding: 'utf8', timeout, env: { ...process.env, ...env },
  });
  const out = String(r.stdout || '');
  const err = String(r.stderr || '');
  if (r.error || r.signal) {
    throw new Error(`入口超时或被信号终止（signal=${r.signal} error=${r.error && r.error.message}）`
      + ` args=${JSON.stringify(args)} outLen=${out.length} err=${err.slice(0, 400)}`);
  }
  return { code: r.status, out, err };
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ow-launch-'));
  try {
    return fn(dir);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 偶尔占用 */ }
  }
}

/** 假宿主的剧本。每个剧本对应一条**实测过的**宿主形态，不是编的：
 *
 *  | 剧本 | 模拟什么 | 出处 |
 *  |---|---|---|
 *  | notlogged | 未登录跑 -p，文本输出 | 本机实测：`Not logged in · Please run /login`，exit 1 |
 *  | liar | 未登录跑 -p，JSON 输出 | 本机实测：subtype=success + is_error=true + exit 1 |
 *  | liar-zero | 同上但 exit 0，且**不含**认证字样 | 只能靠 is_error 认出来的那种 |
 *  | silent | exit 0 但什么都不打印 | 本机实测过的网关配方形态 |
 *  | ok | 正常跑完 | 对照组：证明上面几条不是「总是失败」 |
 *  | noauth | 不认识 `auth` 子命令 | 防「把 inconclusive 断成没登录」 |
 *  | plugin / plugin-partial | 打印 plugin details 的清单 | --verify 的对照 |
 *
 *  写法说明：这份脚本要被**写到磁盘再执行**，所以它自己是一个完整程序。
 *  这里用 `String.raw` 让 `\n` 保持两个字符（落到文件里就是 `'\n'` 这个转义），
 *  而不是在模板字符串里被展开成真换行 —— 后者会把脚本拆成半截。
 */
const FAKE_HOST = String.raw`#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const mode = process.env.FAKE_MODE || 'notlogged';
const argv = process.argv.slice(2);
const log = process.env.FAKE_SPAWN_LOG || '';
const touch = (tag) => { try { if (log) writeFileSync(log, tag + '\n', { flag: 'a' }); } catch {} };
if (argv[0] === 'auth') {
  touch('auth');
  if (mode === 'noauth') { process.stderr.write("error: unknown command 'auth'\n"); process.exit(1); }
  if (mode === 'loggedin') { process.stdout.write('{"loggedIn":true,"authMethod":"api_key"}\n'); process.exit(0); }
  process.stdout.write('{"loggedIn":false,"authMethod":"none"}\n');
  process.exit(1);
}
touch('run');
if (mode === 'notlogged') { process.stdout.write('Not logged in · Please run /login\n'); process.exit(1); }
if (mode === 'liar') {
  process.stdout.write('{"subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}\n');
  process.exit(0);
}
if (mode === 'liar-zero') {
  process.stdout.write('{"subtype":"success","is_error":true,"result":"boom"}\n');
  process.exit(0);
}
if (mode === 'silent') { process.exit(0); }
if (mode === 'ok') { process.stdout.write('hello\n'); process.exit(0); }
if (mode === 'plugin') {
  const names = String(process.env.FAKE_AGENTS || '').split(',').filter(Boolean);
  process.stdout.write('Agents (' + names.length + ') ' + names.join(', ') + '\n');
  process.exit(0);
}
if (mode === 'plugin-partial') { process.stdout.write('Agents (1) oversight-planner\n'); process.exit(0); }
process.exit(3);
`;

function fakeHost(dir) {
  const p = join(dir, 'fake-claude.mjs');
  writeFileSync(p, FAKE_HOST);
  return p;
}

/** 12 个角色的名字，从真实载荷里读 —— 不在测试里抄第二份清单。
 *  抄一份的后果是「有人加了第 13 个角色，测试还在断言 12」，而那正是它该红的时候。 */
function realAgents() {
  return readdirSync(join(PAYLOAD_DIR, 'agents'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

/** 每次真跑都要隔离台账目录，否则会往真实的 `tasks/runs/launch/` 写。 */
function isolatedRuns(dir) { return join(dir, 'runs'); }

/** 从人类输出里取「要执行的命令行」那一行（去掉缩进）。
 *  取不到就返回 null —— 调用方据此报「输出里没有那一段」，而不是拿整份输出瞎匹配。 */
function commandLineOf(out) {
  const lines = String(out || '').split('\n');
  const i = lines.findIndex((l) => /要执行的命令行|执行的命令行/.test(l));
  if (i < 0) return null;
  const next = lines[i + 1] || '';
  return next.trim() || null;
}

// ── 1. --dry-run 什么都不做 ──────────────────────────────────────────

test('--dry-run 不起任何子进程（判据：假宿主的 spawn 日志不存在）', () => {
  withTmp((dir) => {
    const host = fakeHost(dir);
    const spawnLog = join(dir, 'spawned.txt');
    const runs = isolatedRuns(dir);
    const r = run(['launch', '--dry-run', '--host-bin', host], {
      env: { FAKE_SPAWN_LOG: spawnLog, OVERWATCH_RUNS_DIR: runs },
    });
    assert.equal(r.code, 0, `--dry-run 应 exit 0：${r.code}\n${r.err}`);
    // 假宿主**有**写日志的代码，只是没被跑到。若 launch 暗中起了它，这个文件就在。
    assert.equal(existsSync(spawnLog), false,
      `--dry-run 起了子进程（${spawnLog} 存在）—— 它承诺「不执行任何东西」`);
  });
});

test('--dry-run 不写任何文件（台账目录与 settings 都必须是空的）', () => {
  withTmp((dir) => {
    const runs = isolatedRuns(dir);
    const r = run(['launch', '--dry-run'], { env: { OVERWATCH_RUNS_DIR: runs } });
    assert.equal(r.code, 0, `--dry-run 应 exit 0：${r.code}\n${r.err}`);
    assert.ok(!existsSync(runs) || readdirSync(runs).length === 0,
      `--dry-run 写了文件：${existsSync(runs) ? readdirSync(runs).join(',') : ''}`);
  });
});

test('--dry-run 打印的命令行含 --plugin-dir（逐字可复制，指向实际会挂的那个目录）', () => {
  withTmp((dir) => {
    const r = run(['launch', '--dry-run'], { env: { OVERWATCH_RUNS_DIR: isolatedRuns(dir) } });
    assert.equal(r.code, 0, r.err);
    // 只在**命令行那一段**里找：散文里也会出现「--plugin-dir 的单位是目录」，
    // 拿整份输出匹配会把那句说明当成命令行（本测试第一版就踩了这个）。
    const cmd = commandLineOf(r.out);
    assert.ok(cmd, `输出里必须有「要执行的命令行」那一段：\n${r.out}`);
    const m = cmd.match(/--plugin-dir\s+'?([^'\s]+)'?/);
    assert.ok(m, `命令行里必须有 --plugin-dir：${cmd}`);
    // 归一化分隔符再比 —— Windows 上打印的是反斜杠，那是同一个路径。
    const got = m[1].split('\\').join('/');
    // **指向「实际会挂的那个目录」，不一定是 `.claude/`。**
    // 2026-11-15 起 roster 会筛：有启用清单时挂的是 `dist/roster/` 分身。
    // 这条测试的意图是「打印的命令行逐字可复制」—— 所以它该断言的是
    // 「指向一个真实存在、且与输出里载荷那行一致的目录」，不是钉死某个路径名。
    const underRepo = got.startsWith(REPO.split('\\').join('/'));
    assert.ok(underRepo, `--plugin-dir 应指向本仓库内的目录，实际 ${m[1]}`);
    assert.ok(got.endsWith('/.claude') || got.endsWith('/dist/roster'),
      `--plugin-dir 应是 .claude/ 或按 roster 生成的分身，实际 ${m[1]}`);
    // 同时钉住「它自己说了这是要执行的、本次没执行」。
    assert.match(r.out, /没有执行任何东西|本次没有执行/, '必须说清本次没执行');
  });
});

test('--dry-run 的输出让人一眼看出挂上了什么（12 个角色名逐个出现）', () => {
  withTmp((dir) => {
    const r = run(['launch', '--dry-run'], { env: { OVERWATCH_RUNS_DIR: isolatedRuns(dir) } });
    assert.equal(r.code, 0, r.err);
    for (const a of realAgents()) {
      assert.ok(r.out.includes(a), `--dry-run 没列出角色 ${a}：\n${r.out}`);
    }
    // 两条 hook 必须点名 —— 「挂上了什么」不包括一句「挂了些 hooks」。
    assert.match(r.out, /pre-write-gate/, '要点名 PreToolUse 那条 hook');
    assert.match(r.out, /stop-verify-hook/, '要点名 Stop 那条 hook');
    assert.match(r.out, /observe/, '要说清两条 hook 默认是观测模式（不拦东西）');
  });
});

test('--dry-run --json 给出同一份事实的机器可读版', () => {
  withTmp((dir) => {
    const r = run(['launch', '--dry-run', '--json'], { env: { OVERWATCH_RUNS_DIR: isolatedRuns(dir) } });
    assert.equal(r.code, 0, r.err);
    let d;
    assert.doesNotThrow(() => { d = JSON.parse(r.out); }, `--json 必须是合法 JSON：\n${r.out}`);
    assert.equal(d.dryRun, true);
    assert.equal(d.executed, false, 'dry-run 必须自报 executed:false');
    assert.ok(d.argv.includes('--plugin-dir'), `argv 里要有 --plugin-dir：${d.argv}`);
    assert.equal(d.payload.agents.length, realAgents().length, '角色数必须与载荷一致');
    // 「整目录挂载、roster 只影响调度」这件事也必须是**数据**，不是只写在散文里。
    assert.equal(d.roster.applied, false);
    assert.match(d.roster.note, /整目录挂载/);
  });
});

test('--no-payload 关掉载荷（不传 --plugin-dir），--no-hooks 关掉 hooks（不传 --settings）', () => {
  withTmp((dir) => {
    // ⚠ 判据只查**命令行那一段**：散文里会解释「--no-payload 就是不加 --plugin-dir」，
    // 拿整份输出匹配会让这条测试永远红（第一版就踩了）。
    const cmdOf = (out) => {
      const c = commandLineOf(out);
      assert.ok(c, `输出里没有命令行段：\n${out}`);
      return c;
    };
    const runs = isolatedRuns(dir);

    const both = run(['launch', '--dry-run', '--no-payload', '--no-hooks'], { env: { OVERWATCH_RUNS_DIR: runs } });
    assert.equal(both.code, 0, both.err);
    const bothCmd = cmdOf(both.out);
    assert.ok(!bothCmd.includes('--plugin-dir'), `--no-payload 的命令行不该有 --plugin-dir：${bothCmd}`);
    assert.ok(!bothCmd.includes('--settings'), `--no-hooks 的命令行不该有 --settings：${bothCmd}`);
    // 底线：仍然要有可执行的命令行 —— 否则「关掉一切」变成了「什么都不做还不说」。
    assert.match(bothCmd, /claude/, '仍然要给出宿主命令行');

    const payloadOnly = cmdOf(run(['launch', '--dry-run', '--no-hooks'], { env: { OVERWATCH_RUNS_DIR: runs } }).out);
    assert.ok(payloadOnly.includes('--plugin-dir'), '--no-hooks 不该连带关掉载荷');

    const hooksOnly = cmdOf(run(['launch', '--dry-run', '--no-payload'], { env: { OVERWATCH_RUNS_DIR: runs } }).out);
    assert.ok(hooksOnly.includes('--settings'), '--no-payload 不该连带关掉 hooks');
  });
});

// ── 2. roster：只能整目录挂，且必须说出来 ────────────────────────────

test('roster 现在真的筛：只挂启用的角色（2026-11-15 起）', () => {
  // 这条测试**改了断言的方向**。它原来钉的是「roster 只影响调度、不影响挂载」——
  // 那时那是真的：`--plugin-dir` 只能挂整个目录，roster 只被读来算谁没启用。
  // 现在运行时现场生成一份只含启用角色的分身（`dist/roster/`，gitignore、每次重建），
  // 所以旧断言**变成了假的**，测试必须跟着改 —— 留着它就是在钉一个已经不存在的行为。
  withTmp((dir) => {
    const r = run(['launch', '--dry-run'], { env: { OVERWATCH_RUNS_DIR: isolatedRuns(dir) } });
    assert.equal(r.code, 0, r.err);
    const agents = realAgents();
    const roster = JSON.parse(readFileSync(join(REPO, 'overwatch.config.json'), 'utf8')).agent.roster;
    const disabled = agents.filter((a) => !roster.includes(a));
    assert.ok(disabled.length > 0, '本测试的前提：配置里的 roster 确实比全量少');

    const cmd = commandLineOf(r.out);
    assert.ok(cmd, `输出里没有命令行段：\n${r.out}`);
    const hits = [...cmd.matchAll(/--plugin-dir/g)];
    assert.equal(hits.length, 1, `命令行里应只有一个 --plugin-dir：${cmd}`);
    assert.ok(cmd.includes(join(REPO, 'dist', 'roster')) || cmd.includes('dist/roster'),
      `--plugin-dir 应指向按 roster 生成的分身目录：${cmd}`);
    assert.ok(!cmd.includes(PAYLOAD_DIR), `不应该再挂整目录：${cmd}`);

    // 输出必须点名「挂了哪几个、没挂哪几个」—— 用户要能一眼看出这个会话里谁不在
    assert.match(r.out, /只挂启用的 \d+ 个/, '必须说清只挂了启用的角色');
    assert.match(r.out, /不会出现在这个会话里/, '没启用的必须明说「不会出现」');
    for (const a of disabled) {
      assert.ok(r.out.includes(a), `没被启用的角色 ${a} 也要点名列出：\n${r.out}`);
    }
    // 分身不是第二份真源，这件事必须写在输出里，否则下一个人会以为要手工同步
    assert.match(r.out, /每次启动重建|不是第二份真源/, '要说明分身是运行时生成、不维护第二份');
  });
});

test('roster 为空 / 筛空 / 全启用时都不筛（挂整目录）', () => {
  // 「什么都不配」必须是「全都启用」，不是「一个都不挂」。
  // 筛空了则多半是配置写错了名字 —— 真的挂一个空目录会让用户以为角色全消失。
  const src = readFileSync(join(HERE, 'launch.mjs'), 'utf8');
  assert.match(src, /if \(!names\.length\) return null;\s*\/\/ 没配 = 全挂/,
    '空 roster 必须退回整目录');
  assert.match(src, /if \(!enabled\.length\) return null;\s*\/\/ 筛空了/,
    '筛空必须退回整目录，不许真的挂空');
  assert.match(src, /if \(!skipped\.length\) return null;\s*\/\/ 全启用/,
    '全启用时不必筛');
});

test('roster 缺失/坏掉时不影响挂载，但如实说', () => {
  withTmp((dir) => {
    // 把仓库根的配置换掉做不到（不许改现场），所以这条只钉「配置不在时」的分支：
    // 用一个不含 overwatch.config.json 的 root 不现实（root 固定是本仓库）。
    // 因此改为钉「配置存在时 roster 一定被读出来」+「错的时候会说错」。
    const r = run(['launch', '--dry-run', '--json'], { env: { OVERWATCH_RUNS_DIR: isolatedRuns(dir) } });
    const d = JSON.parse(r.out);
    assert.ok(Array.isArray(d.roster.configured), 'roster 必须是数组');
    assert.ok(d.roster.configured.length > 0, '本仓库的 overwatch.config.json 应给出非空 roster');
    assert.equal(d.payload.mounted, true, 'roster 有问题也不该连带关掉载荷');
  });
});

test('--settings 的内容只写 hooks 一个键（不碰权限 / 模型 / env）', () => {
  withTmp((dir) => {
    const host = fakeHost(dir);
    const runs = isolatedRuns(dir);
    // `--dry-run` 不写盘，所以要看 settings 的内容必须让它真落一次。
    // 宿主是真跑得起来的假宿主，且不用 --no-hooks（那会连 settings 都不写）。
    run(['launch', '--print', '--host-bin', host, '--skip-auth-check'], { env: { FAKE_MODE: 'ok', OVERWATCH_RUNS_DIR: runs } });
    const file = readdirSync(join(runs, 'launch')).find((f) => f.startsWith('settings-'));
    assert.ok(file, '真跑时必须落一份 settings');
    const s = JSON.parse(readFileSync(join(runs, 'launch', file), 'utf8'));

    // ⚠ 这是本文件最重要的一条「不做坏事」断言。
    // 实测（红队报告 2026-11-14-launch-redteam.md）：`--settings` 的**标量键会覆盖**
    // 用户项目设置（`permissions.defaultMode` / `model` 都被顶掉过）。只写 hooks
    // 就不会碰到它们；哪天有人往里加了 `permissions` 或 `model`，这条必须红。
    assert.deepEqual(Object.keys(s), ['hooks'],
      `--settings 里只应有 hooks，实际有：${Object.keys(s).join(', ')}`);
    // 事件也要钉住：两条 hook 各在它该在的事件上。
    assert.deepEqual(Object.keys(s.hooks).sort(), ['PreToolUse', 'Stop']);
    // PreToolUse 不带 matcher 就等于收不到任何工具调用 —— 那样闸门是「装上了但从不触发」，
    // 正是这个仓库最恨的静默失效形态。
    assert.match(s.hooks.PreToolUse[0].matcher || '', /Write/,
      'PreToolUse 必须有 matcher，否则一次也不会触发');
    assert.ok(!('matcher' in s.hooks.Stop[0]), 'Stop 不该有 matcher（它没有工具维度）');
    // 命令里必须是**绝对路径**：`${CLAUDE_PROJECT_DIR}` 在 hook 进程里指的是用户当前项目。
    const cmd = s.hooks.PreToolUse[0].hooks[0].command;
    assert.ok(cmd.includes(join(REPO, 'scripts', 'pre-write-gate.mjs')),
      `hook 命令里应是绝对路径：${cmd}`);
    assert.ok(!cmd.includes('CLAUDE_PROJECT_DIR'), `不许用 \$CLAUDE_PROJECT_DIR：${cmd}`);

    // 文件名是内容寻址：同一份内容只落一个文件。跑第二次不该多出一个。
    run(['launch', '--print', '--host-bin', host, '--skip-auth-check'], { env: { FAKE_MODE: 'ok', OVERWATCH_RUNS_DIR: runs } });
    const files = readdirSync(join(runs, 'launch')).filter((f) => f.startsWith('settings-'));
    assert.equal(files.length, 1, `同一份内容应只落一个文件，实际 ${files.join(',')}`);
    assert.match(files[0], /^settings-[0-9a-f]{8}\.json$/, `文件名应是内容摘要：${files[0]}`);
  });
});

// ── 3. 认证失败：exit 6 且提示可操作 ─────────────────────────────────

test('认证失败：预检就拦（不 print 也不交互都不该起会话）→ exit 6，stderr 可操作', () => {
  withTmp((dir) => {
    const host = fakeHost(dir);
    const spawnLog = join(dir, 'spawned.txt');
    // 不给 --print，但非 TTY 下要显式 --interactive 才不撞用法错误。
    // 这条要测的正是**交互式的预检**，所以给 --interactive。
    const r = run(['launch', '--interactive', '--host-bin', host], {
      env: { FAKE_MODE: 'notlogged', FAKE_SPAWN_LOG: spawnLog, OVERWATCH_RUNS_DIR: isolatedRuns(dir) },
    });
    assert.equal(r.code, 6, `未认证必须 exit 6（不是 0，也不是 1）：${r.code}\n${r.out}\n${r.err}`);
    assert.ok(!r.out.includes('--plugin-dir'), '预检拦住时连命令行都不该执行');

    // 「可操作」的判据不是「有字」，而是**有能直接敲的命令**。
    assert.match(r.err, /claude auth login/, '必须给出登录命令');
    assert.match(r.err, /ANTHROPIC_API_KEY/, '必须给出 API key 这条路');
    assert.match(r.err, /auth status --json/, '必须给出自检命令');
    // 还要说清「为什么不信宿主的判断」—— 否则下一个人会把它改回「看 subtype」。
    assert.match(r.err, /is_error|subtype/, '必须写出宿主失败语义不自洽这件事');
  });
});

test('认证失败（宿主有 auth 子命令）时，会话一次都没起', () => {
  withTmp((dir) => {
    const host = fakeHost(dir);
    // 假宿主对 `auth` 与「真跑」分别写日志。预检拦住的形态下，日志里不该出现真跑。
    const spawnLog = join(dir, 'spawned.txt');
    const r = run(['launch', '--interactive', '--host-bin', host], {
      env: { FAKE_MODE: 'notlogged', FAKE_SPAWN_LOG: spawnLog, OVERWATCH_RUNS_DIR: isolatedRuns(dir) },
    });
    assert.equal(r.code, 6, r.err);
    // 预检本身会碰一次宿主（auth status），所以日志**会**存在 —— 这条钉的是
    // 「拦住之后没有第二次调用」，靠台账里 judge.kind 来判（见下一条）。
    const ledger = readdirSync(join(isolatedRuns(dir), 'launch')).find((f) => f.endsWith('.jsonl'));
    assert.ok(ledger, '预检失败也要记账（否则「会话没起来」这件事没人知道）');
    const row = JSON.parse(readFileSync(join(isolatedRuns(dir), 'launch', ledger), 'utf8').trim().split('\n').pop());
    assert.equal(row.exitCode, 6);
    assert.equal(row.judge.kind, 'auth-preflight');
    assert.match(row.note, /会话没有起来/, '台账必须写清「没有起来」，不是「跑了但失败」');
  });
});

test('auth 子命令不存在（宿主不认识它）≠ 没登录：不判死，继续跑', () => {
  withTmp((dir) => {
    const host = fakeHost(dir);
    // 交互式才有认证预检 —— print 模式不预检（它自己就能判），所以这条必须走 --interactive。
    const r = run(['launch', '--interactive', '--host-bin', host], {
      env: { FAKE_MODE: 'noauth', OVERWATCH_RUNS_DIR: isolatedRuns(dir) },
    });
    // 假宿主对不认识的命令 exit 1；但它**说不认识**（不是 loggedIn:false），
    // 所以不能断成「没登录」（exit 6）。它继续跑，真跑（mode=noauth）落 exit 3 → 我们报 7。
    assert.notEqual(r.code, 6, `「不认识 auth 子命令」不该被断成「没登录」：${r.code}\n${r.err}`);
    assert.match(r.err, /没有结论/, '必须说出预检没结论这件事');
    assert.match(r.err, /auth/, '要说清是哪条命令没结论');
  });
});

// ── 4. 静默失败：exit 0 + 空输出 → 失败 ──────────────────────────────

test('★ 静默失败（exit 0 + stdout/stderr 都空）必须被判失败：exit 7', () => {
  withTmp((dir) => {
    const host = fakeHost(dir);
    const r = run(['launch', '--print', '--host-bin', host, '--skip-auth-check', '--no-hooks'], {
      env: { FAKE_MODE: 'silent', OVERWATCH_RUNS_DIR: isolatedRuns(dir) },
    });
    assert.equal(r.code, 7, `exit 0 但什么都没输出必须判失败（exit 7），实际 ${r.code}\n${r.out}\n${r.err}`);
    // 而且必须**解释**这个判定：它看起来明明像成功。
    assert.match(r.err, /exit 0 但什么都没输出|静默失败/, '必须点名这是静默失败');
    assert.match(r.err, /不是成功/, '必须明确否掉「成功」这个结论');

    const ledger = readdirSync(join(isolatedRuns(dir), 'launch')).find((f) => f.endsWith('.jsonl'));
    const row = JSON.parse(readFileSync(join(isolatedRuns(dir), 'launch', ledger), 'utf8').trim().split('\n').pop());
    assert.equal(row.judge.kind, 'silent-empty');
    assert.equal(row.judge.failed, true);
    // **台账记的是判定，不是宿主退出码。** 这是这条存在的理由：
    // 只看 exitCode 的人会以为 0 = 成功。
    assert.equal(row.exitCode, 7, '台账里的 exitCode 必须是本命令纠正过的 7，不是宿主的 0');
  });
});

test('★ is_error:true + subtype:"success" + exit 0 → 仍判失败（含无认证字号的那种）', () => {
  withTmp((dir) => {
    const host = fakeHost(dir);
    const r = run(['launch', '--print', '--host-bin', host, '--skip-auth-check', '--no-hooks'], {
      env: { FAKE_MODE: 'liar-zero', OVERWATCH_RUNS_DIR: isolatedRuns(dir) },
    });
    assert.equal(r.code, 7, `is_error:true 即使 subtype=success、exit 0 也必须判失败：${r.code}\n${r.out}\n${r.err}`);
    const ledger = readdirSync(join(isolatedRuns(dir), 'launch')).find((f) => f.endsWith('.jsonl'));
    const row = JSON.parse(readFileSync(join(isolatedRuns(dir), 'launch', ledger), 'utf8').trim().split('\n').pop());
    assert.equal(row.judge.kind, 'is-error-true');
    assert.match(row.judge.detail, /is_error/, '台账要写清判据是 is_error');
  });
});

test('宿主原形（is_error:true + 认证字样 + exit 1）被判为认证失败：exit 6', () => {
  withTmp((dir) => {
    const host = fakeHost(dir);
    const r = run(['launch', '--print', '--host-bin', host, '--skip-auth-check', '--no-hooks'], {
      env: { FAKE_MODE: 'liar', OVERWATCH_RUNS_DIR: isolatedRuns(dir) },
    });
    // 三种毛病同时存在，用户的下一步动作只有一个（去登录）—— 所以归到 6，不拆成三种码。
    assert.equal(r.code, 6, `认证字样优先于 exit 码：${r.code}\n${r.err}`);
    assert.match(r.err, /claude auth login/);
  });
});

test('文本形态的未登录（exit 1、非 JSON）也判 6，且不要求客户端解析 JSON', () => {
  withTmp((dir) => {
    const host = fakeHost(dir);
    const r = run(['launch', '--print', '--host-bin', host, '--skip-auth-check', '--no-hooks'], {
      env: { FAKE_MODE: 'notlogged', OVERWATCH_RUNS_DIR: isolatedRuns(dir) },
    });
    assert.equal(r.code, 6, `文本形态的未登录应判 6：${r.code}\n${r.err}`);
  });
});

test('对照组：正常输出 + exit 0 → exit 0（证明上面几条不是「总是失败」）', () => {
  withTmp((dir) => {
    const host = fakeHost(dir);
    const r = run(['launch', '--print', '--host-bin', host, '--skip-auth-check', '--no-hooks'], {
      env: { FAKE_MODE: 'ok', OVERWATCH_RUNS_DIR: isolatedRuns(dir) },
    });
    assert.equal(r.code, 0, `正常应 exit 0：${r.code}\n${r.out}\n${r.err}`);
    assert.match(r.out, /hello/, '宿主的输出必须原样转发给用户');
    const ledger = readdirSync(join(isolatedRuns(dir), 'launch')).find((f) => f.endsWith('.jsonl'));
    const row = JSON.parse(readFileSync(join(isolatedRuns(dir), 'launch', ledger), 'utf8').trim().split('\n').pop());
    assert.equal(row.judge.failed, false);
    assert.equal(row.judge.kind, 'ok');
  });
});

test('仓内没有覆盖长行：每次真跑都记一行台账，且台账不含本机绝对路径与会话 ID', () => {
  withTmp((dir) => {
    const host = fakeHost(dir);
    const runs = isolatedRuns(dir);
    run(['launch', '--print', '--host-bin', host, '--skip-auth-check', '--no-hooks'], {
      env: { FAKE_MODE: 'ok', OVERWATCH_RUNS_DIR: runs },
    });
    const ledgerFile = readdirSync(join(runs, 'launch')).find((f) => f.endsWith('.jsonl'));
    assert.ok(ledgerFile, '必须记账');
    assert.match(ledgerFile, /^\d{4}-\d{2}-\d{2}\.jsonl$/, `日期文件名：${ledgerFile}`);
    const text = readFileSync(join(runs, 'launch', ledgerFile), 'utf8');

    // ① 不记本机绝对路径：仓库根 / 家目录 / 盘符前缀都要被遮。
    assert.ok(!text.includes(REPO), `台账里出现了仓库绝对路径：${text.slice(0, 300)}`);
    assert.ok(!/[A-Za-z]:[\\/]/.test(text.replace(/[A-Za-z]:[\\/](?:node\.exe)/g, '')), `台账里出现了盘符路径：${text.slice(0, 300)}`);
    // ② 不记完整会话 ID（UUID 形态）。本命令拿不到，也不该有人塞进来。
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text), '台账里出现了 UUID');
    // ③ 必须记下「挂了哪些 hooks」与「宿主 argv」与「是否被判为失败」。
    const row = JSON.parse(text.trim().split('\n').pop());
    assert.ok(Array.isArray(row.hostArgv) && row.hostArgv.length >= 1, '要有宿主 argv');
    assert.equal(typeof row.exitCode, 'number');
    assert.equal(typeof row.judge.failed, 'boolean', 'judge.failed 必须是一个布尔 —— 「是否被判为失败」是台账的核心字段');
    assert.ok('hooks' in row, '要记挂了哪些 hooks');
    assert.ok('payload' in row, '要记载荷摘要');
    assert.ok('at' in row && 'ms' in row, '要记时间与耗时');
  });
});

// ── 5. --verify：不需要认证也不需要推理 ──────────────────────────────

test('--verify 逐个核对「该挂的角色」都在宿主印的清单里 → exit 0', () => {
  withTmp((dir) => {
    const host = fakeHost(dir);
    // **期望是「按 roster 筛过的」，不是全量 12 个。** 2026-11-15 起 roster 真的筛，
    // 所以「该挂的」= 配置启用的那几个。假宿主只要印出这几个就能对上；
    // 印全量反而会因为「多出来的」被判失败（那条判据防的是手工往载荷里塞东西）。
    const roster = JSON.parse(readFileSync(join(REPO, 'overwatch.config.json'), 'utf8')).agent.roster;
    const r = run(['launch', '--verify', '--host-bin', host, '--no-hooks'], {
      env: { FAKE_MODE: 'plugin', FAKE_AGENTS: roster.join(','), OVERWATCH_RUNS_DIR: isolatedRuns(dir) },
    });
    assert.equal(r.code, 0, `载荷齐全应 exit 0：${r.code}\n${r.out}\n${r.err}`);
    assert.match(r.out, /载荷挂对了/, '要说清结论');
    assert.match(r.out, /不需要推理与认证/, '要说清它为什么能在没登录的机器上跑');
  });
});

test('--verify 发现少挂角色 → exit 7（并且点名少了谁）', () => {
  withTmp((dir) => {
    const host = fakeHost(dir);
    const r = run(['launch', '--verify', '--host-bin', host, '--no-hooks'], {
      env: { FAKE_MODE: 'plugin-partial', OVERWATCH_RUNS_DIR: isolatedRuns(dir) },
    });
    assert.equal(r.code, 7, `少挂角色必须判失败，实际 ${r.code}\n${r.out}\n${r.err}`);
    assert.match(r.out, /缺/, '必须说缺了什么');
    // 点名到具体角色，不是「少了几个」——后者无法行动。
    const missing = realAgents().filter((a) => a !== 'oversight-planner');
    assert.ok(missing.some((a) => r.out.includes(a)), `应点名缺失的角色：\n${r.out}`);
  });
});

test('--verify 不跑 auth 预检（它本来就不需要认证）', () => {
  withTmp((dir) => {
    const host = fakeHost(dir);
    // FAKE_MODE 是 notlogged：如果 --verify 先跑了 auth 预检，它会被拦成 exit 6。
    const r = run(['launch', '--verify', '--host-bin', host, '--no-hooks'], {
      env: { FAKE_MODE: 'notlogged', OVERWATCH_RUNS_DIR: isolatedRuns(dir) },
    });
    // 假宿主在 notlogged 下对 plugin 请求也只会印 Not logged in，
    // 于是 verify 判「没挂全」→ exit 7。关键是**不能是 6**。
    assert.notEqual(r.code, 6, `--verify 不该被认证预检拦住：${r.code}\n${r.err}`);
  });
});

// ── 6. 用法与非 TTY ──────────────────────────────────────────────────

test('非 TTY 且没说要怎么跑 → exit 5，并列出四个可选路（不静默切成 --print）', () => {
  withTmp((dir) => {
    // spawnSync 的 stdio 是 pipe，所以 stdout 不是 TTY —— 这正是要测的环境。
    const r = run(['launch', '--host-bin', fakeHost(dir)], { env: { OVERWATCH_RUNS_DIR: isolatedRuns(dir) } });
    assert.equal(r.code, 5, `非 TTY 下默认交互式应报用法错误，实际 ${r.code}\n${r.out}\n${r.err}`);
    assert.match(r.err, /不是终端/, '必须说清原因是「这里不是终端」');
    for (const opt of ['--dry-run', '--print', '--verify', '--interactive']) {
      assert.ok(r.err.includes(opt), `必须列出可选路 ${opt}：\n${r.err}`);
    }
    // 不许它自己改主意：给了一个明确的选择时不该再拦。
    const ok = run(['launch', '--print', '--host-bin', fakeHost(dir), '--skip-auth-check', '--no-hooks', '--dry-run'],
      { env: { OVERWATCH_RUNS_DIR: isolatedRuns(dir) } });
    assert.equal(ok.code, 0, '--dry-run 在非 TTY 下必须可用');
  });
});

test('--help 立刻退出：不探测宿主、不读配置、不看 TTY', () => {
  withTmp((dir) => {
    const spawnLog = join(dir, 'spawned.txt');
    // --host-bin 指到一个**不存在**的路径：若 help 顺手探了宿主，输出里会出现「不存在」。
    const r = run(['launch', '--help', '--host-bin', join(dir, 'nope-nope')], {
      env: { FAKE_SPAWN_LOG: spawnLog, OVERWATCH_RUNS_DIR: isolatedRuns(dir) },
    });
    assert.equal(r.code, 0, `launch --help 应 exit 0：${r.code}\n${r.err}`);
    assert.match(r.out, /overwatch launch/, '要打印 launch 自己的说明');
    assert.match(r.out, /--dry-run/, '说明里要有 --dry-run');
    assert.ok(!/不存在/.test(r.out), `--help 不该探测宿主：\n${r.out}`);
    assert.equal(existsSync(spawnLog), false, '--help 起了子进程');
  });
});

test('launch 的未知参数 exit 5（不静默忽略）', () => {
  withTmp((dir) => {
    const r = run(['launch', '--bogus-flag', '--dry-run'], { env: { OVERWATCH_RUNS_DIR: isolatedRuns(dir) } });
    assert.equal(r.code, 5, `未知参数应 exit 5，实际 ${r.code}\n${r.err}`);
    assert.match(r.err, /不认识的参数：--bogus-flag/);
  });
});

test('-- 之后的一切原样交给宿主（本命令不猜它是不是宿主的参数）', () => {
  withTmp((dir) => {
    const r = run(['launch', '--dry-run', '--no-payload', '--no-hooks', '--', '--model', 'opus', '--verbose'], {
      env: { OVERWATCH_RUNS_DIR: isolatedRuns(dir) },
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /--model opus --verbose/, `-- 之后的参数必须逐字出现在命令行里：\n${r.out}`);
  });
});

test('入口的帮助里提到 launch（否则没人知道它存在）', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /launch/, '入口 --help 必须提到 launch');
  // 但 `launch --help` 给的是 launch 自己的说明，不是这份总说明。
  assert.ok(!/^overwatch launch · 起一个挂了载荷的宿主会话/m.test(r.out), '入口 --help 不该是 launch 的说明');
});

// ── 7. 负向：证明上面的判定真的能红 ──────────────────────────────────
//
// 与 overwatch.test.mjs 的负向段同形：把 launch.mjs 的源码做文本替换，**真的跑起来**。
// ⚠ 每一段都要先断言「变异体跑了」（输出非空）—— 一个不跑的负向测试比没有更坏。

/** 把 launch.mjs 复制到临时目录并改写，相对 import 全部换成绝对 file:// URL。 */
function mutateLaunch(dir, replacements) {
  const out = join(dir, 'launch.variant.mjs');
  let text = readFileSync(join(HERE, 'launch.mjs'), 'utf8');
  for (const [from, to] of replacements) {
    assert.ok(text.includes(from), `变异目标不在源码里，替换不会生效：${from.slice(0, 70)}`);
    text = text.split(from).join(to);
  }
  for (const rel of ['build-payload.mjs', 'question-audit.mjs']) {
    text = text.split(`from './${rel}'`).join(`from 'file:///${join(HERE, rel).split('\\').join('/')}'`);
    text = text.split(`import('./${rel}')`).join(`import('file:///${join(HERE, rel).split('\\').join('/')}')`);
  }
  writeFileSync(out, text);
  return out;
}

test('负向：把「静默失败」那一支删掉之后，exit 0 + 空输出会被当成成功 —— 证明正向断言有牙', () => {
  withTmp((dir) => {
    const host = fakeHost(dir);
    const runs = isolatedRuns(dir);
    // 只删「空输出 → 失败」那一条判据，别的一字不动。
    const variant = mutateLaunch(dir, [[
      "  if (stdout.trim() === '' && stderr.trim() === '') {",
      "  if (false) {",
    ]]);
    const r = spawnSync(process.execPath, [variant, '--print', '--host-bin', host, '--skip-auth-check', '--no-hooks'], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_MODE: 'silent', OVERWATCH_RUNS_DIR: runs },
    });
    const err = String(r.stderr || '');
    // 「变异体跑了」的判据**不能是输出非空**：这一支退化之后本来就什么都不打印。
    // 用它留下的台账来判 —— 台账在，说明它真跑完了；台账里 judge.kind 说明它怎么判的。
    const ledgerDir = join(runs, 'launch');
    assert.ok(existsSync(ledgerDir), `变异体必须真的跑起来（没有台账说明它没跑）\n${err}`);
    const row = JSON.parse(readFileSync(join(ledgerDir, readdirSync(ledgerDir).find((f) => f.endsWith('.jsonl'))), 'utf8')
      .trim().split('\n').pop());

    // 退化后的行为：exit 0 + 空输出被当成成功。
    assert.equal(r.status, 0, `退化后静默失败拿到了 0：实际 ${r.status}\n${err}`);
    assert.equal(row.judge.kind, 'ok', `退化后判成了 ${row.judge.kind}`);
    assert.equal(row.judge.failed, false);
    // 也就是说：正向那条 `code === 7` 与 `match(/静默失败/)` 在此变异体上必然红。
    assert.ok(!/静默失败/.test(err), '变异体不该再报静默失败');
  });
});

test('负向：把「is_error」判据删掉之后，subtype:success + is_error:true 会被当成成功', () => {
  withTmp((dir) => {
    const host = fakeHost(dir);
    const runs = isolatedRuns(dir);
    const variant = mutateLaunch(dir, [[
      'if (jsonIsError(stdout) === true) {',
      'if (false) {',
    ]]);
    const r = spawnSync(process.execPath, [variant, '--print', '--host-bin', host, '--skip-auth-check', '--no-hooks'], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_MODE: 'liar-zero', OVERWATCH_RUNS_DIR: runs },
    });
    const err = String(r.stderr || '');
    const out = String(r.stdout || '');
    assert.ok(out.length > 0 || err.length > 0, `变异体必须真的跑起来\n${err}`);
    assert.equal(r.status, 0, `退化后 is_error:true 拿到了 0：实际 ${r.status}\n${err}`);
  });
});

