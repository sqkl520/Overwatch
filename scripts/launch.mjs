#!/usr/bin/env node
/**
 * launch.mjs — 起一个**挂了载荷的宿主会话**（`node scripts/overwatch.mjs launch`）。
 *
 * 为什么需要它：`overwatch.mjs` 的其余子命令**只路由不代跑**（`scan` / `verify` / `tui`
 * 的参数口径互相冲突，替用户选一个口径不会有第二份判据来测）。`launch` 是唯一例外，
 * 因为「把 `.claude/` 载荷和 hooks 挂到一次会话上」没有任何原生命令可路由 ——
 * `--plugin-dir`、`--settings`、`-p` 的组合要现构造，而构造错了宿主**不会报错**。
 *
 * ── 本文件存在的真正理由：宿主的失败语义不自洽（本机实测）──────────────
 *
 * | 场景 | 宿主输出 | 宿主退出码 |
 * |---|---|---|
 * | 未登录跑 `-p` | `{"subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}` | **1** |
 * | 网关配方下的另一次 | 什么也不打印 | **0** |
 *
 * 第一行是「名字叫 success，实际是错误」；第二行是「退出码 0，实际什么都没做」。
 * 直接把宿主退出码当成结论，会让「会话根本没起来」在上层看起来像成功 ——
 * 本仓库已经因为这个形态吃过两次亏。所以本文件做三件事：
 *
 *   1. **起会话之前先看认证**（`claude auth status --json`）。交互式会话的输出直接写终端，
 *      本命令读不到它，事后无从判定 —— 预检是这种情况下**唯一**能判的东西。
 *   2. **拿到输出就自己判**（{@link judgeHostRun}）：退出码、`is_error:true`、
 *      以及「exit 0 但什么都没说」三种形态分别有自己的结论，不转发宿主的判断。
 *   3. **判不出来就说判不出来**（交互会话的 `judge.kind = 'handover'`），
 *      不把「把终端交给了用户」说成「会话成功了」。
 *
 * ── 启动形态：哪个能用，是怎么测出来的（不是猜的）──────────────────────
 *
 * | 形态 | 载荷挂得上吗 | 要认证吗 | 本命令用它吗 |
 * |---|---|---|---|
 * | 交互式（无 `-p`） | **挂得上**。`--debug` 日志里 `Loaded 12 agents from plugin overwatch default directory`，且 cwd 在仓库**之外**（排除项目布局自动加载的干扰） | 要（起会话时） | **是，默认** |
 * | `-p` / `--print` | 挂得上（`--output-format stream-json` 的 init 事件里 `plugins:[overwatch]`） | 要 | 是（`--print`） |
 * | `--bg` / `--background` | 挂得上 | 要 | **不**：它 exit 0 的意思是「已放到后台」，不是「跑成功了」，与本文件的判定纪律冲突 |
 * | `claude --plugin-dir <dir> plugin details <name>` | 挂得上（Agents 清单 12 个） | **不要** | 是（`--verify`）：这是**只挂载荷、不起推理**的形态 |
 * | `claude --help` | 不加载 | 不要 | 不：它不证明载荷挂对了 |
 *
 * 所以「验证载荷挂对了」这一步**不需要登录也不需要一次推理** —— `--verify` 走的就是
 * 那条路。这一点很重要：本机（以及任何没登录的机器）唯一能真跑的 launch 子形态就是它。
 *
 * ── roster：为什么只挂一部分做不到（如实说，不假装做了）─────────────────
 *
 * `--plugin-dir` 的单位是**目录**。没有「只挂这个目录里的前三个 agent」的开关。
 *
 * 另外两条路也实测过了，都不行：
 *   · `--agents <json>` 是**加法不是减法**。实测把 `{"oversight-planner":{…}}` 传进去，
 *     init 事件里 `oversight-planner`（裸名）+ `overwatch:oversight-*` 12 个**全都在** ——
 *     它是「再加一个」，不是「只要这些」。所以它顶不掉 roster 之外的那 9 个。
 *   · 把目录**复制**一份筛过的再挂**可行**（`plugin details` 会报 `Agents (3)`），
 *     但那会产生**第二份载荷**：它与 `.claude/` 漂移，而且
 *     `.claude/skills/oversight/SKILL.md` 里引用了全部 12 个角色 —— 筛掉一个，
 *     skill 就会派发到一个不存在的角色。本仓库的头号事故就是「同一个东西两份，
 *     漂移的那份没人测」。
 *
 * 所以：`agent.roster` 只影响**调度**（谁该被派发），不影响**挂载**（谁可见）。
 * 本命令整目录挂载，并在 `--dry-run`、人类输出、台账三处**都写明这件事**。
 * 另外，`agent.roster` 目前**没有一行代码在执行**（只有 `question-audit.mjs` 校验它的形状）
 * —— 这一点也写进 spec，免得读者以为它是生效的。
 *
 * 零 npm 依赖，只用 node: 内置模块。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, basename, isAbsolute, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { verifyPluginRoot } from './build-payload.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/** launch 自己的退出码。0 / 1 / 5 与入口的 0 / 1 / 5 同义，6 / 7 是 launch 专有。
 *  **每个码只有一个含义**，改这里等于改对外契约，必须同步 docs/spec/2026-11-14-launch.md。 */
const EXIT = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  USAGE: 5,
  AUTH: 6,
  HOST: 7,
});

const HOST_DEFAULT = 'claude';
const CONFIG_FILE = 'overwatch.config.json';
/** 认证预检的上限。本机实测 `auth status --json` 1.9 秒（冷启动），给足 20 秒；
 *  超时不算「已登录」，算「预检没结论」—— 两者必须分开。 */
const AUTH_TIMEOUT_MS = 20000;
/** `--verify` 要宿主加载整个 plugin，本机实测 ~4 秒。 */
const VERIFY_TIMEOUT_MS = 60000;
/** `--print` 的上限。宿主的 print 模式可能永久挂住，而 `judgeHostRun` 早就写好了
 *  `timedOut` 分支、只是**从来没有人传过它**（唯一调用点写死 `false`，那条分支不可达）。 */
const PRINT_TIMEOUT_MS = Number(process.env.OVERWATCH_PRINT_TIMEOUT_MS) || 15 * 60 * 1000;

/** 期望的 agent 清单的**兜底常量**（只在 git 不可用时用，见 `expectedAgents()`）。
 *
 *  它必须与 `.claude/agents/` 里已跟踪的 12 份角色定义一致。
 *  **改角色定义时忘了改这里，`--verify` 会红** —— 那是提醒，不是噪音：
 *  期望清单是验证的地基，地基变了就该有人看一眼。
 */
const AGENTS_EXPECTED = Object.freeze([
  'oversight-acceptor', 'oversight-critic', 'oversight-executor', 'oversight-planner',
  'oversight-probe', 'oversight-redteam', 'oversight-relay', 'oversight-repair',
  'oversight-research', 'oversight-resolution', 'oversight-review', 'oversight-safety',
]);

/** 两条随仓库发布的 hook。它们**默认都是观测模式**（不设环境变量时只记账、不拦），
 *  所以默认挂上是安全的；`--no-hooks` 或下面的环境变量可以关掉。
 *
 *  为什么开关是环境变量而不是 `overwatch.config.json` 的一个键：
 *  那份配置的顶层键白名单由 `question-audit.mjs` 的 `validateConfig()` 守（且是硬校验，
 *  未知键直接报错），改它要动那个脚本与它的 69 条测试。本文件不越界，如实写在 help 里。 */
const HOOKS = Object.freeze([
  {
    id: 'pre-write-gate',
    script: 'scripts/pre-write-gate.mjs',
    event: 'PreToolUse',
    matcher: 'Write|Edit|NotebookEdit|Bash|PowerShell',
    timeout: 10,
    envOff: 'OVERWATCH_LAUNCH_HOOKS',
    what: '写前闸：第一次写文件前先证明读过项目（默认 observe：只记账、只放行）',
  },
  {
    id: 'stop-verify-hook',
    script: 'scripts/stop-verify-hook.mjs',
    event: 'Stop',
    matcher: null,
    timeout: 60,
    envOff: 'OVERWATCH_LAUNCH_HOOKS',
    what: 'Stop 验证闸：回合结束时核对「说做完了」有没有证据（默认 observe：只记账）',
  },
]);

const HELP = `overwatch launch · 起一个挂了载荷的宿主会话

用法：
  node scripts/overwatch.mjs launch [选项] [-- <额外传给宿主的参数>]

默认启动**交互式**会话（用户要在里面干活），挂上：
  · --plugin-dir <repo>/.claude     12 个 oversight-* 角色 + oversight skill
  · --settings <只读的 settings>    写前闸与 Stop 验证闸（默认 observe，不拦东西）

选项：
  --dry-run            只打印将执行的命令行（逐字、可复制），**不起任何子进程、不写任何文件**
  --print              非交互（对应宿主的 -p）：拿得到输出，于是能自己判定成败
  --interactive        显式要求交互式（默认即是）。非 TTY 时必须显式给，否则本命令拒绝
  --verify             只验载荷：跑宿主一个**不需要推理也不需要认证**的子命令，
                       逐个核对 12 个角色都进了清单
  --no-hooks           不挂 hooks（也就不传 --settings）
  --no-payload         不挂载荷（也就不传 --plugin-dir）
  --host-bin <path>    宿主可执行文件（默认 ${HOST_DEFAULT}，由 PATH 解析）
  --cwd <dir>          会话工作目录（默认当前目录）
  --skip-auth-check    跳过启动前的认证预检（不推荐：交互式会话没有第二个判据）
  --json               同一份数据的机器可读版

退出码：
  0  会话正常结束 / 预检通过且未判定失败 / 载荷验证通过
  1  本文件自己出了意外（bug，不是环境问题）
  5  用法错误（未知参数、参数缺值、非 TTY 下没给 --interactive/--print/--dry-run）
  6  宿主没有被认证 —— 会话没起来，已给出可操作的修复命令
  7  宿主失败：退出码非 0 / is_error:true / **exit 0 但什么都没输出**（静默失败）/ 超时 / 验证不通过

关于 roster：
  \`overwatch.config.json\` 的 agent.roster 只影响**调度**，不影响**挂载**。
  --plugin-dir 的单位是目录，没有「只挂一部分」的开关，本命令整目录挂载（12 个全可见）。

关掉 hooks（两条都默认 observe，不拦任何东西）：
  OVERWATCH_LAUNCH_HOOKS=off node scripts/overwatch.mjs launch
  或加 --no-hooks

台账：tasks/runs/launch/<日期>.jsonl（gitignored）。只记摘要与退出码，不记会话 ID，不记本机绝对路径。`;

// ── 小工具 ────────────────────────────────────────────────────────────

/** 显示用的引用。只处理两件真会发生的事：路径里有空格、JSON 里有引号。
 *  用单引号包住、内部的 `'` 按 POSIX 写法转义 —— 这份输出是给人复制到 shell 的，
 *  不是给程序解析的；台账记的是 argv 数组，不记这一行字符串。 */
function quoteArg(a) {
  const s = String(a);
  if (!/[\s"'`$&|;<>()*?{}\\]/.test(s)) return s;
  return `'${s.split("'").join(`'\\''`)}'`;
}

function cmdLine(bin, argv) {
  return [bin, ...argv].map(quoteArg).join(' ');
}

/** 宿主可执行文件：给了路径就只 stat，没给就扫 PATH。
 *  **只用 stat，不 spawn** —— `--dry-run` 承诺不起任何子进程，这条是它的一部分。
 *
 *  一个例外值得写下来：`--host-bin` 指向 `.mjs` / `.js` 时，Windows 上**不能**直接
 *  spawn（实测 `spawn EFTYPE`：那个扩展名没有可执行关联）。测试与「假宿主」都要走这条路，
 *  所以这里判定「这是不是一个 JS 脚本」，是的话用 `process.execPath` 当前缀。
 *  这不是给测试开后门：一个 `.mjs` 真的不能当可执行文件用，说它能跑才是骗人。 */
function resolveHost(bin) {
  const name = String(bin || HOST_DEFAULT);
  const jsPrefix = /\.(?:mjs|cjs|js)$/i.test(name) ? [process.execPath] : [];
  if (isAbsolute(name) || name.includes(sep) || name.includes('/')) {
    return existsSync(name)
      ? { path: name, how: '给定路径', prefix: jsPrefix }
      : { path: null, how: '给定路径不存在', prefix: jsPrefix };
  }
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of exts) {
      const p = join(d, name + ext.toLowerCase());
      try { if (statSync(p).isFile()) return { path: p, how: 'PATH 上找到', prefix: [] }; } catch { /* 继续找 */ }
    }
  }
  return { path: null, how: 'PATH 上没找到', prefix: [] };
}

/** 台账与人类输出里的路径必须去本机绝对前缀。
 *  规则只有三条，写下来是为了可判定：仓库根 → `<repo>`，家目录 → `<home>`，
 *  其余盘符绝对路径 → `<abs>/<最后一段>`。 */
function maskPath(p, { root = REPO } = {}) {
  let s = String(p == null ? '' : p);
  if (!s) return s;
  const home = homedir();
  const pairs = [[root, '<repo>'], [home, '<home>'], [tmpdir(), '<tmp>']]
    .filter(([a]) => a && a.length > 2)
    // 长的先换，否则 `<repo>` 落在 `<home>` 里面时会被截成半截
    .sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of pairs) {
    for (const variant of new Set([from, from.split('\\').join('/'), from.split('/').join('\\')])) {
      if (variant && s.includes(variant)) s = s.split(variant).join(to);
    }
  }
  s = s.replace(/[A-Za-z]:[\\/][^\s"'`]*/g, (m) => `<abs>/${basename(m)}`);
  // 遮完统一用 `/`：遮罩后的字符串是**给人读的**，`<repo>\.claude` 与 `<repo>/.claude`
  // 混在一起只会让人以为路径有两份。真路径不进台账，所以这里可以只考虑可读性。
  return s.split('\\').join('/');
}

function maskArgv(argv, opts) {
  return (Array.isArray(argv) ? argv : []).map((a) => maskPath(a, opts));
}

/** 深遮一个任意结构里的字符串。**给 `judge` 这种「整块塞进来」的对象用。 */
function maskDeep(v, opts) {
  if (typeof v === 'string') return maskPath(v, opts);
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, opts));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = maskDeep(x, opts);
    return out;
  }
  return v;
}

/** 载荷摘要。**判据来自 `build-payload.mjs` 的 `verifyPluginRoot()`**，不另写一份
 *  「布局对不对」的实现 —— 同一个问题有两份判据，两份必然漂移。
 */
function payloadInfo(root) {
  const dir = join(root, '.claude');
  let verdict = null;
  try {
    verdict = verifyPluginRoot({ root, dir });
  } catch (e) {
    return { dir, ok: false, agents: [], expected: [], skills: 0, name: null, reasons: [`校验抛错：${(e && e.message) || e}`] };
  }
  let name = null;
  try {
    const m = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (m && typeof m.name === 'string') name = m.name;
  } catch { /* 缺 manifest 的情况 verifyPluginRoot 已经报过了 */ }
  const agents = [];
  try {
    for (const f of readdirSync(join(dir, 'agents'))) {
      if (f.endsWith('.md')) agents.push(f.replace(/\.md$/, ''));
    }
  } catch { /* 同上 */ }
  agents.sort();
  return {
    dir, ok: verdict.ok, agents, expected: expectedAgents(root), skills: verdict.skills, name, reasons: verdict.reasons,
  };
}

/** **期望的 agent 清单，取自一个独立于「宿主当前输出」的来源。**
 *
 *  为什么必须独立：`--verify` 原来的做法是拿 `readdirSync(.claude/agents/)` 当期望，
 *  再去宿主输出里找这些名字。**期望与实有是同一份数据的两个投影** —— 挪走两个 agent，
 *  期望也跟着变成 10，于是「10 个角色，逐个对上」exit 0。那不是验证，是照镜子。
 *  验收实测：挪走 2 个仍然报「挂对了」。
 *
 *  现在的来源分级（**逐级降级，每级都写明来源，不假装**）：
 *    1. `git ls-files .claude/agents/*.md` —— **已跟踪的文件**，独立于磁盘当前状态。
 *       挪走一个未提交的文件，这份清单不变，差异立刻暴露。这是主路。
 *    2. git 不可用（发布包 / 没有 .git）时，退到 `AGENTS_EXPECTED` 常量。
 *    3. 两者都拿不到 → 返回 `null`，调用方必须**判为不可验证**（exit 非 0），
 *       绝不允许「没有期望」被当成「全都对上了」。
 *
 *  @returns {string[]|null} null = 没有独立来源，无法验证
 */
function expectedAgents(root) {
  // 1) git 跟踪的文件 —— 最硬的来源
  try {
    const r = spawnSync('git', ['ls-files', '--', '.claude/agents'], {
      cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    if (r.status === 0 && typeof r.stdout === 'string') {
      const list = r.stdout.split('\n')
        .map((l) => l.trim())
        .filter((l) => l.endsWith('.md'))
        .map((l) => basename(l, '.md'));
      if (list.length) return [...new Set(list)].sort();
    }
  } catch { /* 没有 git，走下一级 */ }

  // 2) 常量兜底。**只在没有 git 时用**，且它必须与仓库里的 12 份角色定义一致 ——
  //    改角色定义时忘了改这里，`--verify` 会红，那是提醒，不是噪音。
  if (AGENTS_EXPECTED.length) return [...AGENTS_EXPECTED].sort();

  // 3) 什么都没有 —— 如实说「无法验证」，不许当成通过
  return null;
}

/** 读 `overwatch.config.json` 的 roster。
 *  **用 `question-audit.mjs` 的 `loadConfig()`**（它已经带着完整的键白名单与取值范围校验），
 *  本文件不另写一份配置校验。读不出时返回空 roster + 一条原因，不假装配置是对的。 */
async function configInfo(root) {
  const file = join(root, CONFIG_FILE);
  try {
    const mod = await import('./question-audit.mjs');
    const r = mod.loadConfig(file);
    const roster = (r.config && r.config.agent && Array.isArray(r.config.agent.roster))
      ? r.config.agent.roster.slice()
      : [];
    return {
      file, found: r.found, roster,
      errors: (r.errors || []).map((e) => `${e.path}: ${e.msg}`),
    };
  } catch (e) {
    return { file, found: existsSync(file), roster: [], errors: [`读不了 ${CONFIG_FILE}：${(e && e.message) || e}`] };
  }
}

/** 从 roster 算出**没被启用**的角色。用途只有一个：把「挂载 ≠ 调度」说清楚时给出具体名字。 */
function rosterGap(roster, agents) {
  const on = new Set(roster || []);
  return {
    enabled: (agents || []).filter((a) => on.has(a)),
    disabled: (agents || []).filter((a) => !on.has(a)),
  };
}

/** 拼 `--settings` 的内容。两条 hook 各按模板的注册方式写进 settings，
 *  命令里带**绝对路径**（`${CLAUDE_PROJECT_DIR}` 在 hook 进程里指的是用户当前项目，
 *  不是本仓库 —— 模板里那段注释是实测结论，这里照它的做法）。 */
function buildHooksSettings({ root, platform }) {
  const shell = platform === 'win32' ? 'powershell' : null;
  const hooks = {};
  for (const h of HOOKS) {
    const command = `node "${join(root, h.script)}"`;
    const entry = { type: 'command', command, ...(shell ? { shell } : {}), timeout: h.timeout };
    const group = h.matcher ? { matcher: h.matcher, hooks: [entry] } : { hooks: [entry] };
    (hooks[h.event] = hooks[h.event] || []).push(group);
  }
  return { hooks };
}

/** `tasks/runs/` 的根。**认 `OVERWATCH_RUNS_DIR`** —— 那条环境变量已经是本仓库
 *  隔离运行台账的既有约定（`overwatch.mjs` 的 `plan` 那一项就读它）。测试靠它把
 *  台账与 settings 写进临时目录，而不是写进真实的 `tasks/runs/`。 */
function runsRoot(root) {
  const override = String(process.env.OVERWATCH_RUNS_DIR || '').trim();
  if (override) return resolve(override);
  return join(root, 'tasks', 'runs');
}

/** settings 的落盘路径：**内容寻址**。同一份内容永远同一个文件，
 *  不同内容（`--no-hooks` / 换平台 / 换仓库根）落在不同文件，互相不覆盖。
 *  这样既不增长文件数，也没有「后一次启动把前一次正在跑的 settings 改了」的竞态。 */
function settingsPathFor(root, json) {
  const digest = createHash('sha256').update(json).digest('hex').slice(0, 8);
  return join(runsRoot(root), 'launch', `settings-${digest}.json`);
}

// ── 判定：宿主说了什么，和它**实际**怎么了 ────────────────────────────

/** 从 `-p --output-format json` 的输出里取 `is_error`。取不到返回 null（不是 false）。 */
function jsonIsError(text) {
  const body = String(text || '').trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return null;
  try {
    const d = JSON.parse(body);
    if (d && typeof d === 'object' && typeof d.is_error === 'boolean') return d.is_error;
  } catch { /* 不是 JSON：退回文本判据 */ }
  return null;
}

/** 认证相关的字样。**只收实测出现过、且不会误伤的**：
 *  本机宿主原话是 `Not logged in · Please run /login`；
 *  `--output-format stream-json` 的 assistant 消息带 `"error":"authentication_failed"`。 */
// **认证字样的清单必须盖住实测见到的每一种写法。** 原来只有五种，而本机网关返回的原话
// 是 `Failed to authenticate. API Error: 401 认证失败: ...` —— 一个都不命中，于是
// 认证失败被判成 exit 0、`judge.failed:false`，台账里记成「成功」。
// 这不是理论缺口：那条文本是本机 `claude -p` 最常见的失败形态。
const AUTH_RE = new RegExp([
  'Not logged in',
  'Please run \\/login',
  'authentication_failed',
  'Invalid API key',
  'OAuth token (?:has )?expired',
  // ↓ 2026-11-14 补：本机网关 / 第三方 provider 的写法
  'Failed to authenticate',
  '认证失败',
  '缺少 Authorization',
  // `401` 必须带 HTTP 语境。裸数字会误判 —— 实测 `Build succeeded in 401 packages`
  // 会被当成认证失败，而那是完全正常的构建输出。
  '\\b401\\s*(?:Unauthorized|认证)|(?:API|HTTP|status|Error)[^\\n]{0,8}\\b401\\b',
  'unauthorized',
  'invalid_api_key',
].join('|'), 'i');

/** 判一次 `-p` 运行。
 *
 *  三种形态各有结论，**判据的顺序是刻意的**：
 *   1. 认证字样先判 —— 宿主会**同时**给「exit 1」和「is_error:true 但 subtype success」，
 *      而用户的下一步动作是同一个（去登录），不该被报成两种错。
 *   2. `is_error:true` 次之 —— 即使退出码是 0。这是「名字叫 success，实际是错误」那一形态。
 *   3. 非 0 退出码。
 *   4. **exit 0 且 stdout/stderr 都空** —— 静默失败。宿主在本机第二种网关配方下真的这样过：
 *      退出码 0、输出为空，上层看起来像成功。本仓库已经因为这一形态吃过两次亏。
 */
function judgeHostRun({ code, out, err, timedOut }) {
  const stdout = String(out || '');
  const stderr = String(err || '');
  const text = `${stdout}\n${stderr}`;
  if (timedOut) {
    return { failed: true, kind: 'host-timeout', detail: '宿主在超时内没有退出（不是「成功」，也不是「失败」—— 是没结论）' };
  }
  if (AUTH_RE.test(text)) {
    return { failed: true, kind: 'auth', detail: '输出里有未认证的字样（宿主的失败语义不自洽，本命令按认证失败处理）' };
  }
  if (jsonIsError(stdout) === true) {
    return { failed: true, kind: 'is-error-true', detail: 'result 里 is_error:true —— 即使 subtype 写的是 success、退出码是 0' };
  }
  if (code !== 0) {
    return { failed: true, kind: 'host-exit', detail: `宿主退出码 ${code}` };
  }
  if (stdout.trim() === '' && stderr.trim() === '') {
    return { failed: true, kind: 'silent-empty', detail: '宿主 exit 0 但 stdout 与 stderr 都为空 —— 静默失败，不是成功' };
  }
  return { failed: false, kind: 'ok', detail: '退出码 0 且有输出' };
}

/** 认证失败时印什么。要求是「明确的、可操作的」：**三条具体命令 + 一条自检**。
 *
 *  `hostCmd` 是「怎么调这个宿主」的**逐字前缀**（默认就是 `claude`；`--host-bin` 指到
 *  `.mjs` 时是 `node <路径>`）。不用它而写死 `claude`，会让人按提示去查**另一个**
 *  程序的登录状态 —— 那是最坏的一种「可操作提示」：它指向错误的入口。
 *
 *  `before` 区分两种时机，因为「怎么发现的」这句话必须是真的：
 *    true   预检就拦住了，**一次会话都没起**（交互式的唯一路径）
 *    false  会话真起了，宿主自己说的（print / 交互式加 --skip-auth-check 时）
 */
function renderAuthError({ hostCmd, source, before }) {
  return [
    before
      ? '宿主没有被认证 —— 会话没有起来（本命令在起会话之前就拦住了，没有把「没登录」当成一次运行）。'
      : '宿主没有被认证 —— 宿主自己说了这句话，本命令按认证失败处理（退出码 6，不是「跑了但没输出」）。',
    '',
    `怎么发现的：${source}`,
    '',
    '为什么本命令不转发宿主的判断（本机实测，2026-11-14）：',
    '  未登录时 `claude -p` 返回 {"subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}，',
    '  退出码 1；另有一次网关配方下 **exit 0 且输出完全为空**。',
    '  「subtype: success」与「is_error: true」同时成立，任何把 subtype 当结论的调用方都会看错。',
    '',
    '请做其中一件，然后重跑本命令：',
    '  claude auth login                              # 交互式登录（推荐）',
    '  export ANTHROPIC_API_KEY=...                    # 或给一个 API key（PowerShell: $env:ANTHROPIC_API_KEY="..."）',
    '  export ANTHROPIC_AUTH_TOKEN=...                 # 或用宿主认的 token',
    '',
    '确认好了再跑：',
    `  ${hostCmd} auth status --json${' '.repeat(Math.max(1, 48 - hostCmd.length - 20))}# 看到 "loggedIn": true 即可`,
    '',
    '要让本命令跳过预检：加 --skip-auth-check。不推荐 —— 交互式会话的输出直接写终端，',
    '本命令读不到它，预检是这种情况下唯一的判据（见 docs/spec/2026-11-14-launch.md）。',
  ].join('\n');
}

// ── 参数 ──────────────────────────────────────────────────────────────

function parseLaunchArgs(argv) {
  const out = {
    dryRun: false, print: false, interactive: false, verify: false,
    noHooks: false, noPayload: false, skipAuthCheck: false, json: false,
    hostBin: HOST_DEFAULT, cwd: null, prompt: null, extra: [], help: false,
  };
  const src = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < src.length; i++) {
    const a = src[i];
    // `--` 之后一律原样给宿主：`--foo` 是不是宿主的参数，本命令不猜。
    if (a === '--') { out.extra = src.slice(i + 1); break; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--help' || a === '-h' || a === 'help') { out.help = true; continue; }
    if (a === '--print' || a === '-p') { out.print = true; continue; }
    if (a === '--interactive') { out.interactive = true; continue; }
    if (a === '--verify') { out.verify = true; continue; }
    if (a === '--no-hooks') { out.noHooks = true; continue; }
    if (a === '--no-payload') { out.noPayload = true; continue; }
    if (a === '--skip-auth-check') { out.skipAuthCheck = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--host-bin' || a === '--cwd') {
      const v = src[++i];
      if (v === undefined) return { error: `${a} 需要一个值` };
      if (a === '--host-bin') out.hostBin = v; else out.cwd = v;
      continue;
    }
    if (a.startsWith('-')) return { error: `launch 不认识的参数：${a}` };
    // 位置参数 = 给宿主的 prompt。只收一个：两个 prompt 该合成什么，本命令不猜。
    if (out.prompt !== null) return { error: `只接受一个 prompt，多出来的是：${a}` };
    out.prompt = a;
  }
  // 帮助请求优先于「这几个选项互相冲突」：`launch --help --verify --no-payload`
  // 是在问参数表，不是在发起一次自相矛盾的运行。
  if (out.help) return out;
  if (out.print && out.verify) return { error: '--print 与 --verify 是两种不同的运行，不能同时给' };
  if (out.verify && out.noPayload) return { error: '--verify 验的就是载荷，不能同时给 --no-payload' };
  return out;
}

// ── 构造「将要执行的命令行」 ──────────────────────────────────────────

async function planLaunch(opts) {
  const root = REPO;
  const cwd = resolve(opts.cwd || process.cwd());
  const payload = opts.noPayload
    ? { dir: join(root, '.claude'), ok: true, agents: [], skills: 0, name: null, reasons: [], skipped: '--no-payload' }
    : payloadInfo(root);
  const config = await configInfo(root);

  const hooksOff = opts.noHooks || String(process.env.OVERWATCH_LAUNCH_HOOKS || '').toLowerCase() === 'off';
  const hooksSettings = hooksOff ? null : buildHooksSettings({ root, platform: process.platform });
  const settingsJson = hooksSettings ? JSON.stringify(hooksSettings, null, 2) : null;
  const settingsPath = settingsJson ? settingsPathFor(root, settingsJson) : null;

  const hostArgs = [];
  if (!opts.noPayload) hostArgs.push('--plugin-dir', payload.dir);
  if (settingsPath) hostArgs.push('--settings', settingsPath);

  const mode = opts.verify ? 'verify' : (opts.print ? 'print' : 'interactive');
  if (mode === 'print') hostArgs.push('-p');
  if (mode === 'print' && opts.prompt !== null) hostArgs.push(opts.prompt);
  if (mode === 'verify') {
    hostArgs.push('plugin', 'details', String(payload.name || 'overwatch'));
  }
  hostArgs.push(...opts.extra);

  const gap = rosterGap(config.roster, payload.agents);
  const host = resolveHost(opts.hostBin);

  // 真正要 spawn 的东西。**.mjs/.js 宿主不能直接 spawn**（Windows 上 `spawn EFTYPE`），
  // 所以那种情况下 bin 是 node、脚本路径进 args。显示的**就是**这一对，
  // 不给用户看一个我们其实没执行的命令行 —— 那会让 `--dry-run` 变成装饰品。
  const execFile = host.prefix.length ? host.prefix[0] : opts.hostBin;
  const execArgs = host.prefix.length ? [opts.hostBin, ...hostArgs] : hostArgs;

  return {
    root, cwd, mode, hostBin: opts.hostBin, host, hostArgs, execFile, execArgs,
    payload, config, hooksOff, hooksSettings, settingsJson, settingsPath,
    roster: config.roster, rosterGap: gap,
    skipAuthCheck: Boolean(opts.skipAuthCheck),
    dryRun: Boolean(opts.dryRun),
    prompt: opts.prompt,
  };
}

// ── 人类输出 ──────────────────────────────────────────────────────────

function renderPlan(p) {
  const lines = [];
  const modeText = p.mode === 'verify'
    ? 'verify（只验载荷：宿主的一个不需要推理也不需要认证的子命令）'
    : p.mode === 'print'
      ? 'print（宿主 -p：拿得到输出，本命令能自己判定成败）'
      : 'interactive（无 -p：直接进 TUI，输出写终端）';

  lines.push('overwatch launch · 这个会话会被挂上什么');
  lines.push('');
  lines.push(`  形态       ${modeText}`);
  lines.push(`  宿主       ${p.hostBin}${p.host.path ? `（${p.host.how}：${p.host.path}）` : `（${p.host.how} —— 真跑时会失败，--dry-run 不探测进程）`}`);
  lines.push(`  工作目录   ${p.cwd}`);

  if (p.payload.skipped) {
    lines.push('  载荷       不挂（--no-payload）：没有 --plugin-dir，12 个角色都不可见');
  } else {
    lines.push(`  载荷       ${p.payload.dir} · ${p.payload.agents.length} 个 agent · ${p.payload.skills} 个 skill · 名字 ${p.payload.name || '未认出'}`);
    lines.push(`             ${p.payload.agents.join(', ') || '（没有 .md）'}`);
    if (!p.payload.ok) {
      lines.push('             ⚠ 布局有硬问题，宿主会静默少挂：');
      for (const r of p.payload.reasons) lines.push(`               - ${r}`);
    }
  }

  if (p.config.found) {
    lines.push(`  roster     ${p.config.roster.join(', ') || '（空）'} —— 来自 ${basename(p.config.file)}`);
    if (p.payload.skipped) {
      lines.push('             这部分只影响调度，不影响挂载；本次没挂载荷，所以谁都不在。');
    } else if (p.rosterGap.disabled.length) {
      lines.push(`             ⚠ **只影响调度，不影响挂载**：--plugin-dir 的单位是目录，没有「只挂一部分」的开关。`);
      lines.push(`               本次整目录挂载，${p.payload.agents.length} 个角色全部可见；没被 roster 启用的 ${p.rosterGap.disabled.length} 个是：`);
      lines.push(`               ${p.rosterGap.disabled.join(', ')}`);
      lines.push('               （筛一份目录出来挂是可行的，但那会变成第二份载荷、与 .claude/ 漂移，');
      lines.push('                 且 skill 里引用了全部角色，筛掉一个就会派发到不存在的角色。所以本命令不做。）');
    }
    for (const e of p.config.errors) lines.push(`             ⚠ 配置有错：${e}`);
  } else {
    lines.push('  roster     没有 overwatch.config.json —— 不知道要启用哪些角色（不影响挂载）');
  }

  if (p.hooksOff) {
    lines.push('  hooks      不挂（--no-hooks 或 OVERWATCH_LAUNCH_HOOKS=off）：没有 --settings');
  } else {
    lines.push('  hooks      2 条，默认都是 observe（只记账、不拦任何东西）：');
    for (const h of HOOKS) {
      lines.push(`               · ${h.id}（${h.event}${h.matcher ? `：${h.matcher}` : ''}）→ ${h.script}`);
      lines.push(`                 ${h.what}`);
    }
    lines.push(`  settings   ${p.settingsPath}`);
    lines.push('             （内容寻址：同一份内容永远同一个文件名；真跑时才写，--dry-run 不写）');
    // 实测：`--settings` 的 hooks 与项目自己的 hooks 是**叠加**的（同一次会话里
    // 两边的 SessionStart 都触发了）。所以这两条是**额外的**，不是替换。
    // 这也是本文件只写 `hooks` 这一个键的原因：`--settings` 的标量键会**覆盖**
    // 项目设置（实测 `permissions.defaultMode` 与 `model` 都会被顶掉），
    // 只写 hooks 就不会碰到用户的权限与模型。
    lines.push('             这两条是**额外**挂上的：项目自己的 hooks 照旧生效（实测两边都会触发）。');
    lines.push('             settings 里只写了 hooks 这一个键 —— 别的键（权限、模型）会覆盖你的项目设置。');
  }

  lines.push(`  台账       ${join(runsRoot(p.root), '<日期>.jsonl')}（gitignored：只记摘要、退出码、判定，不记会话 ID）`);
  if (!p.skipAuthCheck && p.mode !== 'verify') {
    lines.push(`  认证预检   起会话前跑 ${p.hostBin} auth status --json（--dry-run 不跑）`);
  } else if (p.mode === 'verify') {
    lines.push('  认证预检   不需要：--verify 走的是不推理的子命令');
  } else {
    lines.push('  认证预检   已关闭（--skip-auth-check）');
  }

  lines.push('');
  lines.push(p.dryRun ? '要执行的命令行（逐字，可直接复制粘贴；本次没有执行任何东西）：' : '执行的命令行：');
  lines.push(`  ${cmdLine(p.execFile, p.execArgs)}`);
  if (p.mode === 'interactive') {
    lines.push('');
    lines.push('交互式会话结束后，本命令只能报宿主的退出码 —— 它读不到终端上的输出，');
    lines.push('所以台账里那一行会写 judge.kind="handover"（交出去了），而不是「成功」。');
  }
  if (p.settingsJson) {
    lines.push('');
    lines.push(`--settings 会写进 ${basename(p.settingsPath)} 的内容（真跑时写入，这里只用来看）：`);
    for (const l of p.settingsJson.split('\n')) lines.push(`  ${l}`);
  }
  return lines.join('\n');
}

// ── 台账 ──────────────────────────────────────────────────────────────

function ledgerPathFor(root, nowMs) {
  const d = new Date(nowMs);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return join(runsRoot(root), 'launch', `${ymd}.jsonl`);
}

/** 记一行台账。**不记会话 ID**（本文件根本拿不到，也不去要），
 *  **不记本机绝对路径**（`maskPath` 把仓库根/家目录/盘符前缀换掉）。 */
function appendLedger(root, entry, nowMs) {
  const file = ledgerPathFor(root, nowMs);
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
    return file;
  } catch {
    return null;
  }
}

function ledgerEntry(p, { exitCode, judge, startedMs, nowMs, note }) {
  const opts = { root: p.root };
  return {
    at: new Date(nowMs).toISOString(),
    ms: Math.max(0, nowMs - startedMs),
    mode: p.mode,
    // 三个都遮：`--host-bin` 给的可能是绝对路径，`execFile` 在 `.mjs` 宿主时是
    // `process.execPath`（另一条盘符路径）。第一版只遮了 hostResolved，于是
    // `hostBin` 与 `hostArgv[0]` 各漏了一条 —— 是测试里那条「台账不含盘符路径」抓到的。
    hostBin: maskPath(p.hostBin, opts),
    hostResolved: p.host.path ? maskPath(p.host.path, opts) : null,
    hostArgv: [maskPath(p.execFile, opts), ...maskArgv(p.execArgs, opts)],
    cwd: maskPath(p.cwd, opts),
    payload: p.payload.skipped
      ? { mounted: false, skipped: p.payload.skipped }
      : {
        mounted: true,
        dir: maskPath(p.payload.dir, opts),
        name: p.payload.name,
        agents: p.payload.agents.length,
        skills: p.payload.skills,
        layoutOk: p.payload.ok,
      },
    // **整目录挂载这件事必须进台账**：不然事后看台账会以为 roster 生效了。
    roster: {
      configured: p.roster,
      applied: false,
      note: p.payload.skipped
        ? '本次没挂载荷'
        : `--plugin-dir 只认目录，整目录挂载 ${p.payload.agents.length} 个角色；roster 只影响调度`,
    },
    hooks: p.hooksOff
      ? { mounted: false }
      : { mounted: true, ids: HOOKS.map((h) => h.id), settings: maskPath(p.settingsPath, opts) },
    exitCode,
    // **`judge` 必须整体过一遍 `maskPath`。** 它的 `detail` 里会原样夹带宿主输出与
    // 我们自己的错误消息 —— 实测漏出去两条：`Z:/nope/none.exe`（`--host-bin` 不存在的
    // 情形）与 `<home>/AppData/Local/Temp/acc-r/hang.mjs`（超时那条）。
    // 上面每个字段都逐个遮过，唯独 `judge` 是整块塞进来的，于是它成了唯一的缺口。
    judge: judge ? maskDeep(judge, opts) : null,
    note: note ? maskPath(note, opts) : null,
  };
}

// ── 运行 ──────────────────────────────────────────────────────────────

/** 认证预检。**只用 `auth status --json` 一个判据**，不重写「什么算登录」。
 *
 *  三态，不许合并 —— 尤其「预检没结论」不许被当成「没登录」：
 *
 *    ok           退出码 0 且 `loggedIn === true`
 *    blocked      JSON 可读且 `loggedIn === false`（本机实测未登录时退出码 1，**同时**给
 *                 这份 JSON —— 所以这个分支不依赖退出码，退出码只是第二个旁证）
 *    inconclusive 跑不起来 / 输出不是可读 JSON —— 这可能是「这个宿主没有 auth 子命令」，
 *                 断成「没登录」就是编了一个它没说过的结论。继续跑，但要说出来。
 *
 *  ⚠ 为什么「退出码非 0 且读不出 JSON」不能算 blocked：本机的宿主支持 `auth status`，
 *  但任何被 `--host-bin` 指过来的包装器/旧版本可能根本没有这个子命令。那种情况下
 *  「退出码 1」说的是「不认识的命令」，不是「没登录」。 */
function authPreflight(hostBin, timeoutMs = AUTH_TIMEOUT_MS, prefix = []) {
  const r = spawnSync(prefix.length ? prefix[0] : hostBin, [...(prefix.length ? [hostBin] : []), 'auth', 'status', '--json'], {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
  });
  if (r.error) {
    return { state: 'inconclusive', why: `跑不起来：${r.error.code || r.error.message}` };
  }
  let d = null;
  try { d = JSON.parse(String(r.stdout || '').trim()); } catch { /* 下面按 inconclusive 处理 */ }
  const loggedIn = d && typeof d.loggedIn === 'boolean' ? d.loggedIn : null;
  if (loggedIn === true && r.status === 0) {
    return { state: 'ok', why: `auth status: loggedIn=true（${d.authMethod || '未知方式'}）` };
  }
  if (loggedIn === false) {
    return { state: 'blocked', why: `auth status: loggedIn=false（退出码 ${String(r.status)}）` };
  }
  if (r.status === 0) {
    return { state: 'inconclusive', why: 'auth status 的输出里没有 loggedIn 这个布尔字段' };
  }
  return { state: 'inconclusive', why: `auth status 退出码 ${String(r.status)} 且输出不是可读 JSON —— 这个宿主可能没有 auth 子命令` };
}

function writeJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

/** `--verify`：拿宿主一个**不需要推理也不需要认证**的子命令核对载荷挂对了没有。
 *  判据是「每个角色名都出现在宿主自己印的清单里」——宿主的清单，不是我们的文件列表。 */
function runVerify(p) {
  // 布局有硬问题就先说，不必等宿主证明一遍。理由：宿主会说「缺了 X」（症状），
  // 而 `verifyPluginRoot()` 会说「`agents/sub/` 是子目录，它不进清单」（原因）。
  // 用户要的是原因。判据仍只有一份 —— 就是 `verifyPluginRoot()` 的那份。
  if (!p.payload.skipped && !p.payload.ok) {
    const text = [
      `载荷布局有 ${p.payload.reasons.length} 个硬问题 —— 宿主会静默少挂，先修这些：`,
      ...p.payload.reasons.map((r) => `  - ${r}`),
    ].join('\n');
    return { ok: false, text, code: EXIT.HOST, judge: { failed: true, kind: 'payload-layout', detail: text }, raw: '' };
  }
  const r = spawnSync(p.execFile, p.execArgs, {
    cwd: p.cwd, encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS, windowsHide: true,
  });
  const out = String(r.stdout || '');
  const err = String(r.stderr || '');
  const body = `${out}\n${err}`;

  // **期望清单必须独立于宿主输出。** `expected` 来自 git 跟踪的文件（或兜底常量），
  // 而 `body` 是宿主说的。拿磁盘上「现在有几个」当期望是照镜子 ——
  // 挪走两个 agent 期望也跟着少两个，于是「10 个，逐个对上」exit 0。
  const expected = p.payload.expected;
  const spawnFailed = Boolean(r.error);

  // **没有独立期望 = 无法验证**，不是通过。这一支比「缺名字」更重要：
  // 一个拿不到真源的验证器说「通过了」，比它说「我不知道」坏得多。
  if (!spawnFailed && !Array.isArray(expected)) {
    const text = '无法验证：拿不到独立的期望清单（git 不可用，且兜底常量为空）—— 这是「不知道」，不是「通过」';
    return { ok: false, text, code: EXIT.HOST, judge: { failed: true, kind: 'verify-no-expectation', detail: text }, raw: body };
  }

  // 宿主实际报了几个（解析它自己的计数行），与期望数对比 —— 这是第二道正交判据。
  // 名字对得上但数量不对，说明宿主在别处多挂了东西。
  const declared = (() => {
    const m = body.match(/Agents\s*\((\d+)\)/i);
    return m ? Number(m[1]) : null;
  })();

  const missing = (expected || []).filter((a) => !body.includes(a));
  const extra = p.payload.agents.filter((a) => expected && !expected.includes(a));
  const ok = !spawnFailed
    && r.status === 0
    && Array.isArray(expected) && expected.length > 0
    && missing.length === 0
    && extra.length === 0
    && (declared === null || declared === expected.length);

  const text = spawnFailed
    ? `宿主跑不起来（${r.error.code || r.error.message}）：${p.hostBin}`
    : ok
      ? `载荷挂对了：宿主列出 ${declared === null ? expected.length : declared} 个角色，与 git 跟踪的 ${expected.length} 个逐个对上（不需要推理与认证）`
      : [
        `载荷没挂全（宿主退出码 ${String(r.status)}）`,
        missing.length ? `宿主清单里缺：${missing.join(', ')}` : null,
        extra.length ? `磁盘上有但 git 里没有（多出来的不会进发布包）：${extra.join(', ')}` : null,
        declared !== null && Array.isArray(expected) && declared !== expected.length
          ? `宿主报 ${declared} 个，期望 ${expected.length} 个` : null,
        r.status !== 0 && body.trim() ? `宿主说：${body.trim().split('\n')[0].slice(0, 200)}` : null,
      ].filter(Boolean).join(' · ');
  return { ok, text, code: ok ? EXIT.OK : EXIT.HOST, judge: { failed: !ok, kind: ok ? 'verified' : 'verify-failed', detail: text }, raw: body };
}

async function launchMain(argv, { json = false, nowMs = Date.now() } = {}) {
  const startedMs = Date.now();
  const opts = parseLaunchArgs(argv);
  if (opts.error) {
    process.stderr.write(`${opts.error}\n\n${HELP}\n`);
    return EXIT.USAGE;
  }

  // `launch --help` 立刻退出：不探测宿主、不读配置、不看 TTY。
  // 与入口的 `--help` 同一条纪律 —— 帮助的失败模式不是「打印得不好」，
  // 而是「顺手做了检查」然后因环境而失败。
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return EXIT.OK;
  }

  const wantJson = json || opts.json;

  // 非 TTY 且没说要怎么跑：宿主在非 TTY 下会**静默**切成 --print（实测：报
  // 「Input must be provided either through stdin or as a prompt argument when using --print」）。
  // 一次「我以为在起交互式会话」变成「它在等 stdin」，是本命令必须提前说清的事。
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!opts.dryRun && !opts.verify && !opts.print && !opts.interactive && !tty) {
    process.stderr.write(
      'launch 默认起交互式会话，但这里的 stdout/stdin 不是终端。\n'
      + '宿主在非 TTY 下不会报错 —— 它会静默切成 --print 然后等 stdin（实测），\n'
      + '那就不是「用户在里面干活的会话」了。请显式挑一个：\n'
      + '  --dry-run     只打印命令行（本环境可用，且不起任何子进程）\n'
      + '  --print       非交互（-p），拿得到输出，本命令能判定成败\n'
      + '  --verify      只验载荷（不需要认证、不需要推理）\n'
      + '  --interactive 确实要在终端里跑（本环境不是终端，真跑会失败）\n',
    );
    return EXIT.USAGE;
  }

  let plan;
  try {
    plan = await planLaunch(opts);
  } catch (e) {
    process.stderr.write(`overwatch launch 自己出了意外（这是 bug，不是环境问题）：${(e && e.stack) || e}\n`);
    return EXIT.INTERNAL;
  }

  // ── dry-run：什么都不做，只打印 ──
  if (opts.dryRun) {
    if (wantJson) {
      writeJson({
        command: 'launch', dryRun: true, executed: false,
        mode: plan.mode, hostBin: plan.hostBin, argv: [plan.execFile, ...plan.execArgs],
        payload: { dir: plan.payload.dir, mounted: !plan.payload.skipped, agents: plan.payload.agents, skills: plan.payload.skills, name: plan.payload.name, layoutOk: plan.payload.ok, reasons: plan.payload.reasons },
        roster: { configured: plan.roster, applied: false, note: '--plugin-dir 只认目录：整目录挂载，roster 只影响调度' },
        hooks: plan.hooksOff ? { mounted: false } : { mounted: true, ids: HOOKS.map((h) => h.id), settings: plan.settingsPath },
        ledger: join(runsRoot(plan.root), '<日期>.jsonl'),
        text: renderPlan(plan),
      });
    } else {
      process.stdout.write(`${renderPlan(plan)}\n`);
    }
    return EXIT.OK;
  }

  // settings 落盘。只有真跑才写 —— --dry-run 的承诺里有一条是「不写任何文件」。
  if (plan.settingsPath && !existsSync(plan.settingsPath)) {
    try {
      mkdirSync(dirname(plan.settingsPath), { recursive: true });
      appendFileSync(plan.settingsPath, `${plan.settingsJson}\n`);
    } catch (e) {
      process.stderr.write(`写不了 hooks 的 settings 文件：${(e && e.message) || e}\n（要关掉 hooks 请加 --no-hooks）\n`);
      return EXIT.INTERNAL;
    }
  }

  // ── verify：不需要认证，先判载荷 ──
  if (plan.mode === 'verify') {
    const v = runVerify(plan);
    if (!wantJson) process.stdout.write(`${v.text}\n`);
    const file = appendLedger(plan.root, ledgerEntry(plan, { exitCode: v.code, judge: v.judge, startedMs, nowMs }), nowMs);
    if (wantJson) writeJson({ command: 'launch', mode: 'verify', ok: v.ok, text: v.text, argv: [plan.execFile, ...plan.execArgs], ledger: file ? maskPath(file, { root: plan.root }) : null });
    return v.code;
  }

  // ── 交互式：预检是唯一判据 ──
  if (plan.mode === 'interactive' && !plan.skipAuthCheck) {
    const pre = authPreflight(plan.hostBin, AUTH_TIMEOUT_MS, plan.host.prefix || []);
    if (pre.state === 'blocked') {
      process.stderr.write(`${renderAuthError({ hostCmd: cmdLine(plan.execFile, []), source: pre.why, before: true })}\n`);
      appendLedger(plan.root, ledgerEntry(plan, {
        exitCode: EXIT.AUTH, startedMs, nowMs,
        judge: { failed: true, kind: 'auth-preflight', detail: pre.why },
        note: '会话没有起来：预检就已经拦住了',
      }), nowMs);
      if (wantJson) writeJson({ command: 'launch', mode: 'interactive', started: false, exitCode: EXIT.AUTH, judge: { failed: true, kind: 'auth-preflight', detail: pre.why } });
      return EXIT.AUTH;
    }
    if (pre.state === 'inconclusive') {
      process.stderr.write(`认证预检没有结论（${pre.why}）—— 继续，但下面的失败将无法归因到认证。\n`);
    }
  }

  // ── 真起宿主 ──
  //
  // `--print` 时**边收边转发**，不是攒到最后再印：一个要跑两分钟的非交互会话，
  // 攒着意味着用户两分钟看不到任何东西（分不清「在跑」和「挂住了」）。
  // 攒的副本只用于判定 —— 输出是宿主的话，判定是我们的事。
  const child = await new Promise((done) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; done(v); } };
    let proc;
    try {
      proc = spawn(plan.execFile, plan.execArgs, {
        cwd: plan.cwd,
        // 交互式必须把终端**直接**交出去：任何 pipe 都会让宿主以为自己在非交互模式。
        // print 模式下 stdin 仍是 inherit —— `echo hi | overwatch launch --print`
        // 是合法用法（宿主会从 stdin 读 prompt）。
        stdio: plan.mode === 'print' ? ['inherit', 'pipe', 'pipe'] : 'inherit',
        windowsHide: false,
      });
    } catch (e) {
      finish({ code: null, out: '', err: String((e && e.message) || e), spawnError: true });
      return;
    }
    let out = '';
    let err = '';
    if (proc.stdout) proc.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    if (proc.stderr) proc.stderr.on('data', (d) => { err += d; process.stderr.write(d); });
    proc.on('error', (e) => finish({ code: null, out, err, spawnError: true, spawnReason: e && e.code }));
    proc.on('close', (code, signal) => finish({ code, out, err, signal }));

    // **`--print` 必须有超时。** 原来 `judgeHostRun` 的 `timedOut` 参数唯一调用点写死
    // 了 `false`，于是 `host-timeout` 那条分支永远不可达 —— 宿主挂住时本命令会一起挂着，
    // 实测要靠外层工具才停得下来。用户看到的是一动不动，分不清「在跑」和「死了」。
    // 交互式**不加**超时：那是用户自己在里面干活，挂多久是他的事。
    if (plan.mode === 'print') {
      const killer = setTimeout(() => {
        if (settled) return;
        // Windows 上 `kill()` 只杀直接子进程，孙进程会留在那里继续烧 token。
        // `taskkill /T` 杀整棵树。
        try {
          if (process.platform === 'win32') {
            spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          } else {
            try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
          }
        } catch { /* 杀不掉也别让本命令崩 —— 下面的 finish 已经能交代清楚 */ }
        finish({ code: null, out, err, timedOut: true, signal: 'TIMEOUT' });
      }, PRINT_TIMEOUT_MS);
      killer.unref?.();
      proc.on('close', () => clearTimeout(killer));
    }
  });

  // 交互式的输出已经进了终端（stdio: inherit），这里没有东西可转发；
  // print 模式的输出上面已经边收边转发了。所以这一段只处理剩下的空行分隔。
  if (plan.mode !== 'print' && child.err) process.stderr.write(child.err);

  let judge;
  let code;
  if (child.spawnError) {
    judge = { failed: true, kind: 'spawn-failed', detail: `宿主起不来：${child.spawnReason || child.err}` };
    code = EXIT.HOST;
  } else if (plan.mode === 'print') {
    judge = judgeHostRun({ code: child.code, out: child.out, err: child.err, timedOut: child.timedOut === true });
    code = !judge.failed ? EXIT.OK : (judge.kind === 'auth' ? EXIT.AUTH : EXIT.HOST);
  } else {
    // 交互式：输出直接进了终端，本命令读不到。**不把「交出去了」说成「成功了」。**
    judge = { failed: false, kind: 'handover', detail: `宿主退出码 ${String(child.code)} —— 交互式会话的内容本命令读不到，不判定成败` };
    code = child.code === 0 ? EXIT.OK : EXIT.HOST;
  }

  if (child.spawnError) {
    process.stderr.write(`宿主跑不起来：${plan.hostBin}（${child.spawnReason || '未知原因'}）\n`
      + '请确认宿主已安装，或用 --host-bin 指定路径。\n');
  }
  if (judge.kind === 'auth') {
    process.stderr.write(`\n${renderAuthError({ hostCmd: cmdLine(plan.execFile, []), source: '宿主自己说的（输出里有未认证字样）', before: false })}\n`);
  } else if (judge.kind === 'silent-empty') {
    process.stderr.write(
      '\n宿主 exit 0 但什么都没输出 —— 本命令判它**失败**（exit 7），不是成功。\n'
      + '这不是洁癖：本机实测过「网关配方下 exit 0 且输出完全为空」，上层看起来像跑完了，实际没有任何结论。\n'
      + '可以先自己跑一次同一条命令，看它到底在说什么；认证状态也可能是原因（claude auth status --json）。\n',
    );
  } else if (judge.failed) {
    process.stderr.write(`\n宿主失败（${judge.kind}）：${judge.detail}\n`);
  }

  const file = appendLedger(plan.root, ledgerEntry(plan, { exitCode: code, judge, startedMs, nowMs }), nowMs);
  if (wantJson) {
    writeJson({
      command: 'launch', mode: plan.mode, exitCode: code, judge,
      argv: [plan.execFile, ...plan.execArgs],
      ledger: file ? maskPath(file, { root: plan.root }) : null,
    });
  } else if (plan.mode === 'interactive') {
    process.stdout.write(`[overwatch launch] 会话结束 · 宿主退出码 ${String(child.code)} · 本命令不判定交互会话的成败（judge.kind=${judge.kind}）\n`);
  }
  return code;
}

// ── CLI（只在被直接跑时执行；结构硬门会 import 本文件，顶层不许有副作用）──
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  launchMain(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`${(e && e.stack) || e}\n`);
    process.exitCode = EXIT.INTERNAL;
  });
}

/** 唯一的导出。名字叫 `main` 是**有意的**：结构硬门的「未登记导出」提示把 `main`
 *  当已知的 CLI 入口（它在 INTENTIONALLY_PROBED_FREE 里），所以本文件不会因为
 *  「多了一个导出」而给硬门添提示。`overwatch.mjs` 用 `import { main as launchMain }`。 */
export { launchMain as main, AUTH_RE, expectedAgents, maskDeep };
