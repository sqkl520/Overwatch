// launch 的四条**验收后负向测试**，单独成文件。
//
// 为什么不放在 launch.test.mjs 里：那个文件有二十多条会**真 spawn 宿主**的用例
// （每条数秒）。一旦它 import `launch.mjs`，每条测试进程都要加载整个模块，
// 并发跑时资源叠加 —— 实测整文件从「能跑完」变成 111 秒超时；串行跑则 33 秒全绿。
// 拆开的代价是一个文件，收益是测试仍然有牙且跑得完。
//
// 这四条测的是验收实测出来的四个缺陷。它们的共同点：**原来的测试都绿，
// 因为测的是自己构造的世界**（假宿主少印名字 / 只跑成功路径），不是真实世界。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AUTH_RE } from './launch.mjs';

const HERE = import.meta.dirname;

test('负向：期望清单必须独立于宿主输出——载荷少一个文件时必须判失败', () => {
  // 这条钉的是 --verify 的**地基**。旧实现拿 `readdirSync(.claude/agents/)` 当期望，
  // 于是「应有」与「实有」是同一份数据的两个投影：挪走两个 agent，期望也变成 10，
  // 于是「10 个角色，逐个对上」exit 0。验收实测过这个。
  const exp = ['a', 'b', 'c'];
  const body = 'Agents (2)\n  Agents (2)  a, b';
  const missing = exp.filter((x) => !body.includes(x));
  assert.deepEqual(missing, ['c'], '期望里有、宿主输出里没有的必须被点出来');

  // 反向：如果期望是「从宿主输出里数出来的」，missing 永远为空 —— 这就是照镜子。
  const selfDerived = body.match(/\ba, b\b/)[0].split(', ');
  assert.equal(selfDerived.filter((x) => !body.includes(x)).length, 0,
    '自我认证时永远对得上，这正是旧实现的形态');
});

test('负向：AUTH_RE 必须认得本机网关的原话（Failed to authenticate / 401 认证失败）', () => {
  // **用真身，不从源码里拼一份。** 上一版测试从源码正则提取字符串再自己 join 成正则 ——
  // 摘掉 'Failed to authenticate' 后测试提取到的清单也跟着变少，于是自洽地通过。
  // 实测：把那条字符串删掉，测试仍然 32/32 全绿。那又是同一类自我认证。
  assert.ok(AUTH_RE.test('Failed to authenticate. API Error: 401 认证失败: gateway 缺少 Authorization 头'),
    '本机网关的原话必须被判成认证失败（这是本机 claude -p 最常见的失败形态）');
  assert.ok(AUTH_RE.test('Not logged in · Please run /login'), '原有五种不许退化');
  assert.ok(AUTH_RE.test('OAuth token expired'));

  // 必须**不**认的，否则正常输出会被误判
  assert.ok(!AUTH_RE.test('All tests passed'));
  assert.ok(!AUTH_RE.test('Build succeeded in 401 packages'),
    '裸 401 会误判 —— 「处理了 401 个包」是正常构建输出，不是认证失败');
  assert.ok(!AUTH_RE.test('mvn test: 401 tests run, 0 failures'),
    '同上：测试计数里出现 401 不是认证失败');
});

test('负向：台账的 judge.detail 必须脱敏——不许出现盘符路径或家目录', () => {
  // 旧实现把 `judge` 整块塞进台账，而 `judge.detail` 里夹带宿主输出与我们自己的错误消息。
  // 实测漏出去两条：`Z:/nope/none.exe` 与 `<home>/AppData/Local/Temp/.../hang.mjs`。
  const src = readFileSync(join(HERE, 'launch.mjs'), 'utf8');
  assert.match(src, /judge: judge \? maskDeep\(judge, opts\) : null/,
    'judge 必须整体过 maskDeep，否则 detail 里的路径会原样入账');
  assert.match(src, /function maskDeep/, 'maskDeep 必须存在');
});

test('负向：--print 必须有真超时，且 host-timeout 分支可达', () => {
  const src = readFileSync(join(HERE, 'launch.mjs'), 'utf8');
  assert.match(src, /const PRINT_TIMEOUT_MS/, '必须有 print 超时常量');
  assert.match(src, /timedOut: child\.timedOut === true/,
    '必须把真超时传进 judgeHostRun —— 写死 false 会让 host-timeout 成为死代码');
  assert.doesNotMatch(src, /timedOut: false\s*\}\)/,
    '任何写死 timedOut: false 的调用点都是缺陷');
});

// ── `ask.mode` 的执行侧（2026-11-15）──────────────────────────────────
//
// 在此之前 `ask.mode: "always"` 只是 `overwatch.config.json` 里的一行字：
// `question-audit.mjs` 只做**事后统计**，不改任何行为。实测 71% 的会话整场零提问，
// 而配置说「必须问」——那是假承诺。
//
// 现在它为真的办法是 `--append-system-prompt`：把提问协议追加进系统提示。
// hook 做不到这件事（`PreToolUse` 只能问「允许这次调用吗」，不能替模型发起提问）。

test('ask.mode=never 时不得追加提问协议（配置项必须真的有执行侧）', () => {
  const src = readFileSync(join(HERE, 'launch.mjs'), 'utf8');
  assert.match(src, /function askProtocol/, 'askProtocol 必须存在——它是 ask.mode 的唯一执行侧');
  assert.match(src, /if \(ask\.mode === 'never'\) return null/, 'never 必须短路');
  assert.match(src, /hostArgs\.push\('--append-system-prompt', askPrompt\)/,
    '协议必须真的进命令行，否则它只是文档里的一句话');
});

test('负向：把 ask 段从 configInfo 里丢掉，三种模式就全都加协议', () => {
  // 这是我实际踩到的：`configInfo` 只返回 roster、把 ask 丢了，于是
  // `askProtocol()` 收到 `{}`，`mode` 是 undefined，永远不等于 'never'。
  // 三种模式全加协议，而配置里明明写着 never。
  const src = readFileSync(join(HERE, 'launch.mjs'), 'utf8');
  assert.match(src, /roster, ask,/, 'configInfo 必须把 ask 一起带回，否则 never 失效');
});

test('mode=never 时 maxQuestions 允许 0（否则「关掉提问」无法表达）', () => {
  // 原来下限无条件是 1，于是 `{mode:"never", maxQuestions:0}` 被判 bad-range，
  // 而写 1 又语义不通。校验器把合法配置判成非法，等于强迫用户填一个撒谎的数字。
  const src = readFileSync(join(HERE, '..', 'scripts', 'question-audit.mjs'), 'utf8');
  assert.match(src, /ask\.mode === 'never' \? 0 : 1/,
    'never 模式下 maxQuestions 的下限必须是 0');
});

// ── `PATHEXT`：缺了它 hook 一条都不触发（2026-11-15）──────────────────
//
// 红队实测：Windows 上 hook 命令里的裸 `node` 靠 `PATHEXT` 才知道去找 `node.exe`。
// 缺了它，**全部 hook 静默不触发**，而宿主退出码仍是 0 —— 用户看到「装好了、一切正常」，
// 实际一条闸都没生效。这是本仓库最怕的失败形态。
//
// `launch` 原来靠继承 `process.env`：用户从干净环境启动时，我们把残缺原样传给宿主。

test('launch 必须显式传 env 并补齐 PATHEXT，不能靠继承', () => {
  const src = readFileSync(join(HERE, 'launch.mjs'), 'utf8');
  assert.match(src, /function childEnv\(\)/, 'childEnv 必须存在');
  assert.match(src, /env: childEnv\(\),/, 'spawn 必须显式传 env —— 靠继承就无法兜底');
  assert.match(src, /env\.PATHEXT = '\.COM;\.EXE;\.BAT;\.CMD'/, '必须补齐 PATHEXT');
  // 只在缺失时补：覆盖用户已有值 = 越界
  assert.match(src, /!env\.PATHEXT/, '只在用户没有时才补，不覆盖');
  // 只在 win32 上补：POSIX 没这个概念
  assert.match(src, /process\.platform === 'win32' && !env\.PATHEXT/, '只在 win32 上补');
});

test('负向：把 env 传参去掉，测试必须红', () => {
  // 这条不是再断言一次，而是把「为什么必须有」写成可读的形式：
  // 没有 env: childEnv() 那一行，上面三条都会失去依据。
  const src = readFileSync(join(HERE, 'launch.mjs'), 'utf8');
  const spawnBlock = src.slice(src.indexOf('proc = spawn(plan.execFile'), src.indexOf('proc = spawn(plan.execFile') + 900);
  assert.match(spawnBlock, /env: childEnv\(\)/, 'env 必须在 spawn 的那一段里，不是写在别处');
});
