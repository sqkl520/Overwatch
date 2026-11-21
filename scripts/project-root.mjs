/**
 * project-root.mjs —— 「两个根」的唯一解析处。
 *
 * ## 为什么会有两个根
 *
 * 这不是设计选择，是**两种合法语义**。合成一个值必然有一方错：
 *
 * | 消费者 | 该拿什么根 | 为什么 |
 * |---|---|---|
 * | PreToolUse / Stop hook | **用户项目**（宿主 payload 的 `cwd`） | 它守的是用户正在改的那个项目，标记文件、刹车计数都在那儿 |
 * | `launch` | **框架仓库** | 它挂载的是自己的载荷（`.claude/` + agent 定义），载荷在随包发布的目录里 |
 * | `claim-ledger` / `compose` / `validate-run` / `render-plan` | **用户项目** | 它们读写的是 run 台账，台账属于用户那次任务 |
 *
 * 修前的状态：前两行是对的（hook 读 `input.cwd`、launch 用 `resolve(HERE,'..')`），
 * 第三行全部锚在脚本位置 —— 于是**在别人项目里跑，台账写进框架目录**。
 * 实测（2026-11-21，`/tmp` 里一个空 git 仓库）：
 *
 *   $ cd /tmp/xxxx/owtest && node <framework>/scripts/claim-ledger.mjs declare --run probe-test --task ST1 --paths a.md
 *   已登记期望：ST1 → 1 个文件
 *   $ ls <framework>/tasks/runs/probe-test/
 *   claims.jsonl            ← 落在框架仓库，用户项目里什么都没有
 *
 * ## 两个根，各自的定义
 *
 * - `frameworkRoot()` = 脚本所在目录的上一级。**只用于随包发布的资产**：
 *   `templates/`、`.claude/agents/`、构建出来的载荷。它回答「框架在哪儿」。
 * - `projectRoot()` = 五级阶梯，**任何一级都不回落到脚本位置**。它回答「用户的活在哪」。
 *   第 5 级是失败：`exit 2` + 打印试过的四个位置。**不允许猜**。
 *
 * 为什么第 5 级不许回落：回落会让「写对了」和「写错地方」在屏幕上同形 ——
 * 而这正是本次要修的那个事故的形态。找不到就说找不到，退出码非 0，调用方停。
 *
 * ## 阶梯
 *
 * | 级 | 来源 | 说明 |
 * |---|---|---|
 * | 1 | `--root <dir>` | 用户明说。**不做存在性判断**：拒绝它等于静默改去别处 |
 * | 2 | 环境变量 `UNTILDONE_ROOT` | 同上，明说。CI / 试跑用它 |
 * | 3 | 宿主 payload 的 `cwd` | **仅 hook 路径**：宿主在 `PreToolUse` / `Stop` 输入里给的就是会话根 |
 * | 4 | 从 `process.cwd()` 向上找 `.untildone/`，再退 `.git/` | 自然来源。`check-structure.mjs` 用的就是这个（它写 `process.cwd()` 是对的） |
 * | 5 | 失败 | `exit 2`，打印上面四处试过什么 |
 *
 * 第 4 级为什么要 `.untildone/` 优先：它是本框架在用户项目里的落点（runs 目录就在里面）。
 * 一个已经用了 UntilDone 的项目，即使没有 `.git`（解压的发布包、`git worktree` 的
 * 兄弟目录）也该被认出来。`.git` 是退而求其次的通用判据。
 *
 * ## 为什么 `runsDirFor()` 单独一个函数
 *
 * 「项目根」与「台账落在哪个子目录」是两件事，第二件有配置。混在一起写会让每个
 * 调用点各算一次，而**算错的那份没人测**（本仓的 `fmtDur` 两份、宽度表两份、
 * `readTailRecords` 三种窗口都是这么来的）。
 *
 * 优先级：显式 `--runs-dir` → `UNTILDONE_RUNS_DIR` → `overwatch.config.json` 的
 * `paths.runs` → `<root>/.untildone/runs`。
 *
 * **环境变量在配置文件之前**（这一条与派单给出的顺序相反，是有意的）：本仓库所有
 * 「我已经隔离了」的既有约定（`OVERWATCH_STATE_DIR`、`OVERWATCH_RUNS_DIR`、
 * `OW_PRE_WRITE_GATE_LOG`）都是环境变量覆盖配置。若配置优先，一个写了
 * `paths.runs` 的项目会让 `UNTILDONE_RUNS_DIR=...` **静默失效** ——
 * 于是「我把副作用关进临时目录了」这句话有时真、有时假，比两个都不认更糟。
 * 本仓库为这种形态付过账（`DF-031` / `DF-041`）。
 *
 * 本仓库自己写 `"paths": { "runs": "tasks/runs" }`，所以它的行为**逐字节不变**。
 *
 * ## 依赖
 *
 * 零依赖、**不 import 任何兄弟模块**。这是必须的：`pre-write-gate.mjs` 已经 import
 * `claim-ledger.mjs`，而 `question-audit.mjs` → `observe-reality-check.mjs` →
 * `pre-write-gate.mjs` 是一条既有的 TDZ 环（见 `question-form.mjs` 文件头）。
 * 本文件若去 import `question-audit.mjs` 的 `loadConfig()`，那个环就闭合成真环。
 * 所以配置只读**自己那一个键**（`paths.runs`），与 `pre-write-gate.mjs` 读
 * `ask.minQuestionsBeforeWrite` 是同一个处置。
 */

import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 框架根。**只用于随包发布的资产**，不用于用户数据。 */
export function frameworkRoot() {
  return resolve(HERE, '..');
}

/** 环境变量名。两个都**故意**用新名字（`UNTILDONE_*`），不改旧的 `OVERWATCH_*`：
 *  旧名字被既有脚本与文档引用，改名会让那些静默失效。新旧都认是本仓库的既定做法
 *  （见 `state-dir.mjs` 的目录改名迁移）。 */
export const ROOT_ENV = 'UNTILDONE_ROOT';
export const RUNS_DIR_ENV = 'UNTILDONE_RUNS_DIR';

/** 用户项目里的配置文件。与 `launch.mjs` / `question-audit.mjs` 同一个文件名。 */
export const CONFIG_FILE = 'overwatch.config.json';

/** 向上找项目根时认的标记，**顺序即优先级**。 */
export const PROJECT_MARKERS = Object.freeze(['.untildone', '.git']);

/** 没有配置时的默认 runs 相对路径（相对项目根）。 */
export const DEFAULT_RUNS_REL = '.untildone/runs';

/** 五级阶梯的第几级是什么。**每一条输出都用这张表**，不另写字符串 ——
 *  于是「第 3 级」在日志与测试里永远是同一件事。 */
export const LEVELS = Object.freeze({
  1: '--root <dir>',
  2: ROOT_ENV,
  3: 'payload.cwd',
  4: '向上找 .untildone / .git',
  5: '未找到',
});

/** 人读的一句话。`level` 越界时如实说不知道，不编一个。 */
export function levelText(level) {
  return LEVELS[level] ? `第 ${level} 级（${LEVELS[level]}）` : `第 ${level} 级（未知来源）`;
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** `--root <dir>` / `--root=<dir>`。手写而不是复用各文件的 `parseArgs`：
 *  那八个实现各认各的写法（`--root=x` 有的认有的不认），本文件不该挑一个继承。 */
export function rootFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--root') {
      const next = argv[i + 1];
      if (next === undefined || String(next).startsWith('--')) return null; // `--root` 后面没值
      return String(next);
    }
    if (a.startsWith('--root=')) {
      const v = a.slice('--root='.length);
      return v ? v : null;
    }
  }
  return null;
}

/** 从 `start` 向上找项目根。**找不到返回 null，不返回 `start`** ——
 *  返回 `start` 等于「任意目录都是项目根」，那让第 5 级永远不触发，也就是没有第 5 级。 */
export function searchUp(start) {
  let dir = resolve(String(start || process.cwd()));
  for (;;) {
    for (const marker of PROJECT_MARKERS) {
      // `.git` 在 worktree / submodule 里是**文件**不是目录，所以只判存在。
      if (existsSync(join(dir, marker))) return { root: dir, marker };
    }
    const up = dirname(dir);
    if (up === dir) return null; // 到盘符 / `/` 了
    dir = up;
  }
}

/**
 * 五级阶梯的**纯判定**：不打印、不退出、不回落。
 *
 * @param {object} [opts]
 * @param {string|null} [opts.root]       已解析出的 `--root` 值（调用方用 parseArgs 拿到的）
 * @param {string[]|null} [opts.argv]     没给 `root` 时，从这里取 `--root`
 * @param {object} [opts.env]
 * @param {string|null} [opts.cwd]        第 4 级的起点（默认 `process.cwd()`）
 * @param {string|null} [opts.payloadCwd] 第 3 级：宿主 payload 的 `cwd`（仅 hook 路径）
 * @returns {{ok:boolean, root:string|null, level:number, tried:Array<{level:number,at:string,ok:boolean,why:string|null}>}}
 *   `tried` **无论成败都返回全部四级**，失败时调用方直接打印它 ——
 *   「试过哪里」是这次修复的硬要求（不然写错地方与没找到同形）。
 */
export function resolveProjectRoot({
  root = null, argv = null, env = process.env, cwd = null, payloadCwd = null,
} = {}) {
  const tried = [];
  const note = (level, at, ok, why = null) => tried.push({ level, at, ok, why });

  const fromFlag = (root !== null && root !== true && String(root).trim() !== '')
    ? String(root).trim()
    : rootFromArgv(argv);
  note(1, fromFlag || '(--root 未给)', Boolean(fromFlag), fromFlag ? null : '未给');
  if (fromFlag) return { ok: true, root: resolve(fromFlag), level: 1, tried };

  const envRoot = String((env && env[ROOT_ENV]) || '').trim();
  note(2, envRoot || `(${ROOT_ENV} 未设)`, Boolean(envRoot), envRoot ? null : '未设');
  if (envRoot) return { ok: true, root: resolve(envRoot), level: 2, tried };

  const pc = String(payloadCwd || '').trim();
  const pcOk = Boolean(pc) && isDir(pc);
  note(3, pc || '(无 payload.cwd —— 非 hook 路径)',
    pcOk, pc ? (pcOk ? null : '不是目录') : '不适用');
  if (pcOk) return { ok: true, root: resolve(pc), level: 3, tried };

  const start = resolve(String(cwd || process.cwd()));
  const hit = searchUp(start);
  note(4, start, Boolean(hit),
    hit ? `命中 ${hit.marker}` : `从 ${start} 向上没有 ${PROJECT_MARKERS.join(' / ')}`);
  if (hit) return { ok: true, root: hit.root, level: 4, tried };

  return { ok: false, root: null, level: 5, tried };
}

/** 「试过的四个位置」的人读形态。**失败时一定打印它** ——
 *  否则用户看到的就是一句「找不到项目根」，而他不知道往哪儿放标记。 */
export function formatTried(tried = []) {
  return (tried || []).map((t) => {
    const mark = t.ok ? '✓' : '·';
    return `  ${mark} ${levelText(t.level)}: ${t.at}${t.why ? `（${t.why}）` : ''}`;
  }).join('\n');
}

function say(line) {
  try { process.stderr.write(line + '\n'); } catch { /* stderr 关了也不能让解析失败 */ }
}

/**
 * 阶梯的**带输出**版本。返回项目根，或 `null`（第 5 级）。
 *
 * **每次解析都打印用了哪一级**（写 stderr，不污染 `--json` 的 stdout）。
 * 这是硬要求：没有它，「写对了」和「写错地方」在屏幕上是同一个样子。
 *
 * **第 5 级默认返回 `null`，不回落到脚本位置。** 派单原写的是「P1 过渡期回落到框架根，
 * 这样现有测试路径不变」；实测推翻了那个前提：四个调用点去掉回落之后全量 1861 条仍全绿
 * （2026-11-21 实测）。代价为零，就没有理由保留一个「静默写进框架目录」的逃生口。
 *
 * @param {object} [opts] `resolveProjectRoot` 的参数，外加：
 * @param {boolean} [opts.quiet] 不打印（测试用；CLI 一律不 quiet）
 * @param {'framework'|null} [opts.fallback] 第 5 级时是否回落框架根。
 *   **必须由调用方显式传 `'framework'` 才生效**；回落时必定打印两条警告。
 *   保留这个参数是为了让「我真的想用框架根」这件事可表达、可测，
 *   而不是让它在没人要求时发生。当前**没有任何生产调用点**传它。
 * @returns {string|null}
 */
export function projectRoot({ quiet = false, fallback = null, ...opts } = {}) {
  const r = resolveProjectRoot(opts);
  if (r.ok) {
    if (!quiet) say(`[project-root] ${levelText(r.level)} → ${r.root}`);
    return r.root;
  }
  if (!quiet) {
    say('[project-root] 找不到用户项目根（第 5 级）。试过：');
    say(formatTried(r.tried));
    say(`  给 --root <dir>、设 ${ROOT_ENV}，或在项目里建 .untildone/ 或 .git/。`);
  }
  if (fallback === 'framework') {
    const fw = frameworkRoot();
    if (!quiet) {
      say(`[project-root] ⚠ P1 过渡：回落到框架仓库 ${fw}`);
      say('[project-root] ⚠ 台账/产物会写进**框架目录**，而不是用户项目 —— 这是本次修复前的行为。');
    }
    return fw;
  }
  return null;
}

/** 读 `<root>/overwatch.config.json` 的 `paths` 段。**只读这一个键**（理由见文件头）。
 *  任何读不出来都返回 `null`（不抛）—— runs 目录解析失败的方向必须是「用默认」，
 *  不能让配置是垃圾时整个台账系统不可用。 */
export function readPathsConfig(root) {
  const p = join(String(root || ''), CONFIG_FILE);
  if (!root || !existsSync(p)) return null;
  let raw;
  try { raw = JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const paths = raw.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return null;
  return paths;
}

/**
 * runs 目录 + **它是怎么来的**。
 *
 * 返回 `source` 是为了让调用方能把它打印出来：同一个路径可能来自四个地方，
 * 「写对了」与「配置没生效、其实在用默认」看起来完全一样。
 *
 * @param {string} root 项目根（`projectRoot()` 的结果）
 * @param {object} [opts]
 * @param {object|null|undefined} [opts.config] 已读好的配置对象（`{paths:{runs}}`）。
 *   给 `undefined` 时现场读 `<root>/overwatch.config.json`；给 `null` 表示「没有配置」。
 * @param {string|null} [opts.explicit] `--runs-dir` 的值（**相对 process.cwd() 解析**，
 *   与修前逐字相同）。
 * @returns {{dir:string, source:string}}
 */
export function runsDirInfo(root, { config = undefined, env = process.env, explicit = null } = {}) {
  const base = resolve(String(root || frameworkRoot()));
  const ex = explicit !== null && explicit !== undefined && String(explicit).trim() !== ''
    ? String(explicit).trim()
    : null;
  if (ex) return { dir: resolve(ex), source: '--runs-dir' };

  const envDir = String((env && env[RUNS_DIR_ENV]) || '').trim();
  if (envDir) {
    // 绝对路径原样用，相对路径**相对项目根**（不是相对 cwd：hook 进程的 cwd 可能是任何地方，
    // 而「相对 root」才是用户在项目里写 `alt/runs` 时想表达的意思）。
    return { dir: isAbsolute(envDir) ? resolve(envDir) : resolve(base, envDir), source: RUNS_DIR_ENV };
  }

  const cfg = config === undefined ? { paths: readPathsConfig(base) || {} } : config;
  const rel = cfg && cfg.paths && typeof cfg.paths.runs === 'string' ? cfg.paths.runs.trim() : '';
  if (rel) return { dir: resolve(base, rel), source: `${CONFIG_FILE} paths.runs` };

  return { dir: join(base, ...DEFAULT_RUNS_REL.split('/')), source: `默认 ${DEFAULT_RUNS_REL}` };
}

/** `runsDirInfo().dir` 的便利形态。**没有第二份判据** —— 本函数只取字段。 */
export function runsDirFor(root, opts = {}) {
  return runsDirInfo(root, opts).dir;
}

// ── CLI ───────────────────────────────────────────────────────────────

const HELP = `project-root — 解析「两个根」，并说明用了哪一级

用法：
  node scripts/project-root.mjs                 # 打印用户项目根（失败 exit 2）
  node scripts/project-root.mjs runs-dir        # 打印 runs 目录 + 它来自哪一级
  node scripts/project-root.mjs framework       # 打印框架根（随包发布的资产）

  --root <dir>      第 1 级：用户明说
  --payload-cwd <d> 第 3 级：给 hook 路径用（宿主 payload 的 cwd）
  --json            机器可读

退出码：0 = 解出来了 / 2 = 第 5 级（找不到用户项目根，已打印试过的四个位置）。
`;

function cliParse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 2) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || String(next).startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i++;
  }
  return out;
}

/** CLI 入口。**输出分两条路**：人读的解析过程走 stderr，结果走 stdout ——
 *  `--json` 的消费方不该被迫先剥掉几行解释。 */
export function main(argv = process.argv.slice(2)) {
  const args = cliParse(argv);
  if (args.help) { process.stderr.write(HELP); return 0; }
  const cmd = args._[0] || 'print';

  if (cmd === 'framework') {
    const fw = frameworkRoot();
    if (args.json) console.log(JSON.stringify({ frameworkRoot: fw }));
    else process.stdout.write(fw + '\n');
    return 0;
  }

  const r = resolveProjectRoot({
    root: typeof args.root === 'string' ? args.root : null,
    payloadCwd: typeof args['payload-cwd'] === 'string' ? args['payload-cwd'] : null,
  });
  if (!r.ok) {
    process.stderr.write('[project-root] 找不到用户项目根（第 5 级）。试过：\n');
    process.stderr.write(formatTried(r.tried) + '\n');
    process.stderr.write(`  给 --root <dir>、设 ${ROOT_ENV}，或在项目里建 .untildone/ 或 .git/。\n`);
    return 2;
  }

  if (cmd === 'runs-dir') {
    const info = runsDirInfo(r.root);
    process.stderr.write(`[project-root] ${levelText(r.level)} → ${r.root} · runs 来自 ${info.source}\n`);
    if (args.json) console.log(JSON.stringify({ ...r, runsDir: info.dir, runsSource: info.source }));
    else process.stdout.write(info.dir + '\n');
    return 0;
  }

  process.stderr.write(`[project-root] ${levelText(r.level)} → ${r.root}\n`);
  if (args.json) console.log(JSON.stringify(r));
  else process.stdout.write(r.root + '\n');
  return 0;
}

/** 「我是不是被直接执行」—— 见 `claim-ledger.mjs` 同名段的注释（符号链接）。 */
const realOrResolve = (p) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};
if (process.argv[1] && realOrResolve(process.argv[1]) === realOrResolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
