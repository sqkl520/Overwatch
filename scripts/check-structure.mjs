#!/usr/bin/env node
/**
 * check-structure.mjs — 仓库结构硬门。
 *
 * 把「本机私有 vs 可发布」的约定变成可执行的检查，而不是靠自觉。
 * 零依赖。CI 里作为硬门运行：失败即 exit 1。
 *
 * 用法：node scripts/check-structure.mjs
 * 退出码：0 = 全部通过；1 = 有违规。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, extname, dirname, resolve } from 'node:path';

import { publishedPathViolations, findKnownIdentifiers } from './published-paths.mjs';
import { scanLinks, KIND_TEXT } from './link-check.mjs';
import { discoverRoles, parseFrontmatter, readonlyOf } from './roles.mjs';

const ROOT = process.cwd();
const violations = [];
const warnings = [];

const fail = (file, msg) => violations.push({ file, msg });
const warn = (file, msg) => warnings.push({ file, msg });

// ── 规则定义 ──────────────────────────────────────────────────────────

/** 可发布区：出现本机盘符即为违规（ADR-0001 §发布区零盘符） */
const PUBLISHED_DIRS = ['docs', 'templates', 'rules', 'scripts', 'spec-adr'];
/** 根级文件同属可发布区。
 *
 *  `SECURITY.md` 曾不在这里 —— 它是**最该被扫的那一份**：安全披露文档天然会把
 *  攻击面写成具体路径（「`scripts/x.mjs` 的这一段会被注入」），一旦抄进本机绝对路径，
 *  泄漏的既是身份也是可打击点。审计指出它不在扫描范围内（`DF-039`）。
 *
 *  修法不是「把 SECURITY.md 加进这个数组」，而是**根级 `.md` 一律自动纳入**：
 *  手写清单的失效方式是结构性的 —— 下一次有人加一份根级文档，它照样不在名单里，
 *  而门照样绿。这与 `checkTestCount()` 拒写死数字、选择数源码是同一个理由。
 *  这个数组只留「非 `.md` 但必须扫」的例外。 */
const PUBLISHED_FILES_EXTRA = ['LICENSE'];
/** 根级目录不扫（产物 / 依赖 / 私有台账），其余根级文件按扩展名决定。 */
const ROOT_SCAN_SKIP = new Set(['node_modules', 'dist', 'tasks', 'local', '.git']);

/** 私有区：允许出现本机路径，但必须被 .gitignore 排除 */
const PRIVATE_PATHS = ['tasks/runs', 'local', '.claude/settings.local.json', 'CLAUDE.local.md'];

/** 允许出现盘符的文件（本机私有、运行时产物） */
const PATH_EXEMPT = /^(scripts\/.*\.test\.mjs)$/;

const AGENT_REQUIRED_FIELDS = ['name', 'description'];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash'];

// ── 工具函数 ──────────────────────────────────────────────────────────

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

/** 只作为 CLI 运行、不导出函数的脚本。它们被 import 会执行副作用。
 *
 *  `verify-bugfix-negatives.mjs` 会**改写源码再还原**（负向验证），必须只当 CLI 用，
 *  绝不能被结构门自动 import 并调用。`gen-width-table.mjs` 不在此列：它的解析/渲染
 *  函数是纯的，测试直接 import 它们做对照，所以下面照常登记。 */
const CLI_SCRIPTS = new Set(['check-structure.mjs', 'check-links.mjs', 'verify-bugfix-negatives.mjs', 'verify-tui-negatives.mjs', 'verify-claim-fix-negatives.mjs']);

/** 解析 frontmatter 的**唯一实现**已搬到 `scripts/roles.mjs`（2026-11-21，DF-044）。
 *
 *  为什么是搬走而不是在两边各留一份：本文件原先有一份拷贝，`compose-agent-prompt.mjs`
 *  另有一份。两份对多行块的处理一致只是当时的巧合；而「角色有没有声明只读」现在
 *  两边都要读 —— 一个解析差异就会让硬门放行、compose 拦下，同一份文件两个结论。
 */

function isGitignored(path) {
  const gi = join(ROOT, '.gitignore');
  if (!existsSync(gi)) return false;
  const lines = readFileSync(gi, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return lines.some((rule) => {
    const r = rule.replace(/^\//, '');
    return path === r || path.startsWith(r.replace(/\/$/, '') + '/') || path === r.replace(/\/$/, '');
  });
}

/** 「这个根级文件会不会随仓库发出去」——即 git 眼里的可发布集。
 *
 *  不用 `isGitignored()` 判：那个函数只做精确/前缀匹配，不展开 glob，而 `.gitignore`
 *  里恰恰全是 glob（`.tmp-*`、`dist/`、`*.log`）。实测漏判：根目录下一个 `.tmp-qa.json`
 *  （另一个会话的草稿）被判成「可发布」，硬门于是报了一条跟产品毫无关系的违规。
 *
 *  可发布区的定义本来就是「会随仓库发出去的内容」，那就让 git 回答：
 *  已跟踪的 + 未跟踪但未被忽略的。干净 clone 上这两种恰好等于仓库里的全部文件。
 *  不是 git 仓库（解压后的发布包）时返回 null，调用方退化为「按扩展名扫全部」。 */
function gitPublishableRootFiles() {
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout || '') : null;
  };
  const tracked = run(['ls-files', '-z']);
  if (tracked === null) return null;
  const untracked = run(['ls-files', '--others', '--exclude-standard', '-z']) || '';
  const out = new Set();
  for (const rec of (tracked + untracked).split('\0')) {
    if (!rec) continue;
    const name = rec.replace(/\\/g, '/');
    if (name.includes('/')) continue;          // 只看根级
    out.add(name);
  }
  return out;
}

// ── 检查 1：可发布区零盘符 ────────────────────────────────────────────

/** 判据本体在 `scripts/published-paths.mjs`（纯函数，有单测）。
 *  这里只负责「扫哪些文件、怎么报」。
 *
 *  **为什么把正则搬出去**：原先它写在这个文件里，而 `check-structure.mjs` 一被 import
 *  就跑完全部门禁并 `process.exit()`，于是它**一条测试都写不了**。结果是一个只认 7 个
 *  固定前缀（`Users|Projects|Server|Java|maven|Nodejs|Git`）的正则在这里活了很久，
 *  凡是不在这 7 个前缀下的本机路径全部漏过，硬门照绿（`DF-039`）。
 *  判据搬出去之后，「正则漏了某个形态」会直接红在测试上。
 *  具体漏过的字面量写在 `published-paths.test.mjs`（测试文件被 `PATH_EXEMPT` 豁免）。
 */
function checkAbsolutePaths() {
  const targets = [];

  for (const d of PUBLISHED_DIRS) {
    if (!existsSync(join(ROOT, d))) continue;
    targets.push(...walk(join(ROOT, d)));
  }
  // 根级文件：会随仓库发出去的那些，全部自动纳入（含 SECURITY.md / README-EN.md）。
  //
  // **判「会不会发出去」用 git，不用手写清单、也不用 `isGitignored()`**：
  //  - 手写清单的失效方式是结构性的（加一份根级文档，它就不在名单里，门照样绿）——
  //    与 `checkTestCount()` 拒写死数字是同一个理由；
  //  - `isGitignored()` 不展开 glob，实测把一个 `.tmp-qa.json` 草稿判成「可发布」，
  //    硬门于是报了一条跟产品毫无关系的违规。
  const publishable = gitPublishableRootFiles();
  const rootFiles = publishable
    ? [...publishable]
    : readdirSync(ROOT).filter((f) => !ROOT_SCAN_SKIP.has(f) && !isGitignored(f));
  for (const f of [...PUBLISHED_FILES_EXTRA, ...rootFiles]) {
    const p = join(ROOT, f);
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    if (!['.md', '.mjs', '.js', '.json', '.yml', '.yaml', '.txt'].includes(extname(f))) continue;
    targets.push(p);
  }
  if (existsSync(join(ROOT, '.claude', 'agents'))) {
    targets.push(...walk(join(ROOT, '.claude', 'agents')));
  }

  for (const file of targets) {
    const r = rel(file);
    if (PATH_EXEMPT.test(r)) continue;
    if (!['.md', '.mjs', '.js', '.json', '.yml', '.yaml', '.txt'].includes(extname(file))) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    // 逐个报「行号 + 路径」，不再报「第几次出现」。旧版的 `text.split('\n').find(l => l.includes(h))`
    // 取的是**第一个含该子串的行**，于是同一个路径在文件里出现十次时，九次的真实位置丢失。
    for (const v of publishedPathViolations(text)) {
      fail(r, `第 ${v.line} 行出现本机绝对路径：${v.path.slice(0, 90)}`
        + '（改成 `<repo>` / `D:\\…` 这类占位符，或放进 tasks/ 私有区）');
    }
    // 第二个判据：**没有盘符前缀**的本机标识符。上面那条正则认的是「盘符 + 分隔符」，
    // 而 TUI 的路径副行只印目录尾段 —— 真实中文项目名可以整串裸奔在文档里。
    // 这里**故意不回报原文**：回报等于把泄漏重复一遍到硬门输出与 CI 日志里。
    for (const v of findKnownIdentifiers(text)) {
      fail(r, `第 ${v.line} 行出现已知的本机标识符（无盘符前缀，故路径判据抓不到）。`
        + '改成同形态假名，或在截图旁声明项目名已脱敏');
    }
  }

  // 台账（`tasks/`）单列：**只跑标识符判据，不跑路径判据。**
  //
  // 为什么不跑路径判据：台账里存的是**脱敏后的对照夹具**（盘符 + 假目录名、
  // 假 SDK 安装根、假应用安装位），它们是「改成了什么」的证据，不是本机事实。
  // 对它们报违规只会逼人把证据也删掉。
  //
  // 为什么标识符判据必须覆盖台账：台账在可发布区（CLAUDE.md 目录归属表标「是」），
  // 且**被 git 跟踪**。上一轮的判断（「`tasks/` 不在扫描范围，所以留原文没事」）只对了一半：
  // 范围外只是「门不管」，而门不管的文件照样随公开仓库发出去 —— 那正是把泄漏从一份文件
  // 搬到另一份。这一条由 `DF-039` 第二轮的实事故钉住。
  for (const f of ['tasks/dev-findings.md', 'tasks/accepted-deviations.md']) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    for (const v of findKnownIdentifiers(text)) {
      fail(f, `第 ${v.line} 行出现已知的本机标识符。台账也随仓库发布 ——`
        + '把原文写进台账 = 把泄漏搬到隔壁文件');
    }
  }
}

// ── 检查 2：私有区必须被 .gitignore 排除 ──────────────────────────────

function checkPrivatePaths() {
  for (const p of PRIVATE_PATHS) {
    const full = join(ROOT, p);
    if (!existsSync(full)) continue;
    if (!isGitignored(p)) {
      fail(p, `私有路径未在 .gitignore 中排除，可能被误提交`);
    }
  }
}

// ── 检查 3：.gitignore 不得排除产品本体 ───────────────────────────────

function checkGitignoreSanity() {
  const gi = join(ROOT, '.gitignore');
  if (!existsSync(gi)) { fail('.gitignore', '缺失'); return; }
  const text = readFileSync(gi, 'utf8');
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  // 参考项目的 .gitignore 忽略 .claude/ rules/ tasks/ —— 对本仓库是致命的
  const fatal = ['.claude', 'rules', 'docs', 'templates', 'scripts', 'tasks'];
  for (const dir of fatal) {
    const offending = lines.find((l) => {
      const r = l.replace(/^\//, '').replace(/\/$/, '');
      return r === dir || r === dir + '/**' || r === dir + '/*';
    });
    if (offending) {
      fail('.gitignore', `排除了产品本体目录 "${dir}"（规则：${offending}）——git add -A 会静默什么都不加`);
    }
  }

  if (!lines.some((l) => l.includes('tasks/runs'))) {
    fail('.gitignore', '未排除 tasks/runs/（运行台账可能含会话 ID）');
  }
}

// ── 检查 4：agent frontmatter ─────────────────────────────────────────

function checkAgents() {
  const dir = join(ROOT, '.claude', 'agents');
  if (!existsSync(dir)) { warn('.claude/agents', '目录不存在（本轮允许，Phase B 之后必须有）'); return; }

  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  if (!files.length) fail('.claude/agents', '目录存在但没有任何 agent 定义');

  for (const f of files) {
    const p = join(dir, f);
    const text = readFileSync(p, 'utf8');
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) { fail(rel(p), '缺少 YAML frontmatter'); continue; }

    const fm = m[1];
    const parsed = parseFrontmatter(fm);
    for (const field of AGENT_REQUIRED_FIELDS) {
      if (!parsed[field]) {
        fail(rel(p), `frontmatter 缺少必填字段 "${field}"`);
      }
    }

    // 只读角色的工具白名单不得含写工具。
    // 例外：Write 允许存在（只读角色需要写报告），但必须在正文里声明只能写报告路径。
    //
    // **判据是 frontmatter 的 `readonly: true`，不是名字。** 原实现是
    // `READONLY_ROLES.some((r) => name.toLowerCase().includes(r))` —— 子串匹配。
    // 它的失效方式不是漏检，是**误检且说不清**：用户建一个 `my-review-helper`，
    // 因为名字含 `review` 被当成只读角色，报错说「只读角色 my-review-helper 拥有写工具」，
    // 而这个角色的正文里从没写过它是只读的 —— 用户拿到一句话，不知道改哪里。
    // 申明改成数据之后，「为什么它被当成只读」永远只有一个答案：那份 .md 里写了 readonly: true。
    //
    // 代价（如实记下）：没写 `readonly:` 的文件不再被检查。所以缺这一行本身要报错 ——
    // 否则「忘了写」的失效方式是**静默放行**，比误检更坏。12 份现有定义已全部补齐。
    const name = parsed.name || f.replace(/\.md$/, '');
    if (parsed.readonly === undefined || parsed.readonly === '') {
      fail(rel(p), 'frontmatter 缺少必填字段 "readonly"（true = 该角色不得修改交付物）。'
        + '写不出这一行就说明没人想过这个角色该不该有写权限');
    }
    const isReadonly = readonlyOf(parsed);
    if (isReadonly && parsed.tools) {
      const tools = parsed.tools.split(',').map((t) => t.trim());
      const bad = tools.filter((t) => WRITE_TOOLS.includes(t));
      if (bad.length) {
        const declaresReportOnly = /只允许写|只能写|只写报告|报告路径|不得修改/.test(text);
        if (!declaresReportOnly) {
          fail(rel(p), `只读角色 "${name}" 拥有写工具：${bad.join(', ')}，但正文未声明只能写报告`);
        } else if (bad.includes('Edit') || bad.includes('Bash')) {
          fail(rel(p), `只读角色 "${name}" 不得拥有 Edit/Bash（Write 仅限写报告，且须靠外壳检查兜住）：${bad.join(', ')}`);
        }
      }
    }

    // 描述不能为空（支持多行块）
    if ((parsed.description || '').length < 10) {
      fail(rel(p), 'description 过短，主线程无法据此路由');
    }
  }
}

// ── 检查 5：无空目录 ──────────────────────────────────────────────────

/** 只检查「会被提交的」目录。
 *
 *  gitignore 里的目录根本进不了仓库，对它报「clone 后会消失」是没有意义的：
 *  它 clone 后本来就不存在，不是消失。真实误报：`.tmp-analysis/` 下某个第三方
 *  仓库的 `vendor/<pkg>` 是空的，硬门直接判红，而那一整棵树都在 `.gitignore` 里。
 *
 *  跳过整棵被忽略的子树（而不是只跳过报错的那一层）—— 既省掉数千个文件的遍历，
 *  也让「临时目录里有什么」不再影响结构门。 */
function checkEmptyDirs(dir = ROOT, depth = 0) {
  if (depth > 6 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (['.git', 'node_modules', '.gitkeep'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (depth > 0 && isGitignored(rel(full))) continue;
    const children = readdirSync(full);
    if (children.length === 0) {
      fail(rel(full), '空目录不会被 git 跟踪，clone 后会消失——要么放文件，要么别建');
    } else {
      checkEmptyDirs(full, depth + 1);
    }
  }
}

// ── 检查 6：README 能力边界声明 ───────────────────────────────────────

function checkCapabilityDisclosure() {
  const readme = join(ROOT, 'README.md');
  if (!existsSync(readme)) { warn('README.md', '尚不存在'); return; }
  const text = readFileSync(readme, 'utf8');
  if (!/不能自动接力|无法自动接力|manual/.test(text)) {
    fail('README.md', '缺少能力边界声明（必须写明本库不能自动接力，见 ADR-0002 §4）');
  }
}

// ── 检查 6.5：文档里的测试数必须与实测一致 ────────────────────────────

/** 回归测试数曾同时存在四个值：README 508 / CLAUDE 192 / GUIDE·CI 81 / 设计稿 588，
 *  实测 793。四份文件四个值，而 CI 里那个 81 停在一年前的量级。
 *
 *  这不是笔误，是**同类缺陷的结构性复发**：只要数字是手写的，下一次加测试又会漂。
 *  所以这里不写死任何一个数字，而是**数源码**（`^\s*test(` 的条数）再与文档比对。
 *  文档里写错了硬门直接红 —— 那种红是好事：它把「改文档」变成一次必做的动作。
 *
 *  为什么数源码而不是跑 `node --test`：硬门要能在一秒内跑完，且不能因为某条测试
 *  真的挂了就报「数字不对」。测试是不是全绿由 CI 的 Tests 那一步负责，两件事分开。 */
function checkTestCount() {
  const dir = join(ROOT, 'scripts');
  if (!existsSync(dir)) return;
  let actual = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.test.mjs'))) {
    let text = '';
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    actual += (text.match(/^\s*test\(/gm) || []).length;
  }
  if (!actual) return;

  // 每份文档里「N 条回归测试」这一句的取数位置。只查**声明基线**的那一处，
  // 不查历史条目（CHANGELOG 与 research 里的旧数字是事实记录，不该被改）。
  const sites = [
    ['README.md', /（(\d+)\s*条回归测试/],
    ['CLAUDE.md', /全量回归测试（(\d+)\s*条/],
    ['docs/GUIDE.md', /(\d+)\s*项全绿/],
    ['.github/workflows/validate.yml', /全部回归测试（(\d+)\s*条/],
  ];
  for (const [file, re] of sites) {
    const p = join(ROOT, file);
    if (!existsSync(p)) continue;
    let text = '';
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    const m = text.match(re);
    if (!m) {
      fail(file, `找不到回归测试数声明（应形如「${actual} 条」）—— 删掉声明等于没人再核它`);
      continue;
    }
    const claimed = Number(m[1]);
    if (claimed !== actual) {
      fail(file, `回归测试数写的是 ${claimed}，源码实测 ${actual}。改成 ${actual}，`
        + '或先确认新加的测试真的被注册了');
    }
  }
}

// ── 检查 7：脚本必须能被 Node 解析 ────────────────────────────────────
/** 硬门不覆盖「脚本能不能跑」是一个真实漏洞：
 *  曾把 `const WINDOW = ;` 写进 scan-sessions.mjs，整个文件不可解析，
 *  但 check-structure 照样返回「全部通过」。语法检查必须进硬门。 */
function checkSyntax() {
  const dir = join(ROOT, 'scripts');
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') || f.endsWith('.js'));
  if (!files.length) return;

  // `node --check` 一次可以接多个文件，一个进程查完（实测 6 个文件 1.5s，
  // 而逐个 spawn 要 9s）。
  // 曾试过在单进程里用 vm / new Function 复刻 --check，但 ESM 的 import/export
  // 需要先剥壳，剥壳本身引入了三次转义 bug —— 不如把这件事交还给 node 自己。
  const r = spawnSync(process.execPath, ['--check', ...files.map((f) => join(dir, f))], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (r.status !== 0) {
    const lines = (r.stderr || '').split('\n');
    const fileLine = lines.find((l) => l.includes('scripts')) || '';
    const errLine = lines.find((l) => l.includes('Error')) || '语法错误';
    fail(fileLine.trim() || 'scripts/', `无法被 Node 解析：${errLine.trim().slice(0, 140)}`);
  }
}

// ── 检查 8：脚本导出的模块必须能被 import ────────────────────────────

/** 登记过的纯函数 → 调用参数（JSON 片段）。
 *  只调用这里列出的导出。没登记 = 不调用，由 checkUnregisteredExports 列成提示。
 *
 *  演进史：前缀白名单（覆盖 9/23）→ 黑名单（新函数默认被调）→ 本版参数白名单。
 *  黑名单的问题是 watch.mjs 的 startWatch 是常驻循环，被 {} 调中后门要等满 20s 超时，
 *  而且真把 state.json 写进了用户的 %LOCALAPPDATA%。每加一个副作用函数就要补一次
 *  黑名单，忘一次门就卡死。现在反过来：没登记就不调，登记这个动作本身就是一次审阅。 */
const PROBE_ARGS = {
  parseArgs: '[]', parseKeys: '"j"', parseKeysWithRest: '"j"',
  judgeState: '{}', noveltyOf: '[]', signatureOf: '["Read", {}]',
  // 2026-11-16 delta 接到 scan 行上：两个都是纯函数。
  // `deltaFieldOf` 空输入返回 null；`tailWindowOf` 空输入返回 { tail: [], truncated: false }。
  // 探针只喂最小可构造输入，正确性由 state-model.test.mjs 的五条负向用例守。
  deltaFieldOf: '[{}]', tailWindowOf: '[{}, 1]',
  normalizeBash: '"x"', heartbeatThreshold: '[]', isPersistentChange: '["Bash", {}]',
  displayWidth: '"x"', padDisplay: '["x", 1]', paint: '["x", "red", false]',
  badge: '["PRODUCING", false]', colorEnabled: '[{ isTTY: false }]',
  stripAnsi: '"x"', sanitize: '"x"', truncateToWidth: '["x", 1]',
  wrapToWidth: '["x", 1]', buildDraft: '[{}]', detailLines: '[{}, 80, false]',
  stripLongStrings: '"x"', collectSubagentFiles: '["/nonexistent"]',
  stateCounts: '[[]]', listRow: '[{}, 80, false, false]',
  columnHeaderLine: '[80]', listHeaderLine: '[1, 80, []]',
  usage: '[]', fmtDur: '[1]', fmtNovelty: '[0.5]', projectLabel: '["a-b"]',
  glyphOf: '[{}]', stateOf: '[{}]',
  reasonClass: '["novelty=0.1"]', dedupeKey: '["a", "STALLED", "novelty=0.1", "x"]',
  // DF-024：跨 state 的会话级收敛。纯函数，给两条同会话不同 state 的候选即可。
  convergeBySession: '[[{ sessionId: "s", state: "ASKED", reason: "x" }, { sessionId: "s", state: "WAITING", reason: "y" }]]',
  // measure-interventions.mjs（2026-11-11 人工介入基线）：全部纯函数，参数取最小可构造输入。
  // eachLine / analyzeTranscript / formatReport 读盘，用不存在的路径——空文件返回 0 行，
  // 不存在的路径在 analyzeTranscript 里会抛，外面 checkImportable 会吞掉（它只关心 ReferenceError）。
  userText: '[{}]', humanTurnText: '[{}]', isInterrupt: '[{}]', assistantStop: '[{}]',
  askedUser: '[{}]', isAskAnswer: '[{}]', classifyHumanMessage: '"继续"',
  avoidabilityOf: '[{ type: "nudge", text: "继续", afterStop: "end_turn" }]',
  percentile: '[[1, 2, 3], 0.5]',
  eachLine: '["/nonexistent-ow-probe", (l) => l]',
  analyzeTranscript: '["/nonexistent-ow-probe"]',
  formatReport: '[{ days: 1, root: "/x", summary: { totals: { sessions: 0, humanTurns: 0, assistantStops: 0, interventions: 0, byType: {}, byAvoidability: {} }, distribution: { all: {}, active: {} }, rates: {}, sessionsWithIntervention: 0, perSession: [] } }]',
  defaultRoot: '[]',
  // project-commands.mjs / stop-verify-hook.mjs（2026-11-12 Stop hook 验证闸）。
  // 参数一律取最小可构造输入：不存在的路径 / 空对象 / 空串。目的是让「导出但调用即炸」
  // 在结构门就暴露 —— 这比等到 hook 在真实会话里崩掉再发现便宜得多。
  // 记账函数（appendLog / bumpBlockCount / …）在这里只会走到「读完发现没东西就返回」，
  // 不会写进用户的 %LOCALAPPDATA%：它们各自的 env 覆盖参数取不到真实路径。
  readCapped: '["/nonexistent-ow-probe", 64]',
  pickNpmScripts: '""', pickMaven: '""', pickGradle: '""', pickCargo: '""', pickGo: '""',
  pickPython: '[{}]', pickDotnet: '[false, false]',
  detectProjectCommands: '["/nonexistent-ow-probe"]', commandHint: '[{}]',
  modeOf: '[{}]', parseHookInput: '""', resolveAssistantText: '[{}, []]',
  decide: '[{ input: {}, records: [] }]', buildReason: '[{}]',
  logPathFor: '[{}]', statePathFor: '[{}]', readBlockCount: '["s", { env: {} }]',
  // 2026-11-16 用户叫停三层：全部纯读，无副作用。
  // 2026-11-21 `DF-041`：路径从「一个」变成「一族」（新旧状态目录都认），
  // 探针三种都登记 —— `pausePathsFor` 空 env 必须返回**非空**数组（返回空 = 闸关不掉），
  // 这一条由 `stop-verify-hook.test.mjs` 的 `DF-041` 用例守。
  pausePathFor: '[{}]', pausePathsFor: '[{}]', pausedPathOf: '[{}]',
  isPaused: '[{}]', lastBlockAt: '["s", { env: {} }]',
  PAUSE_FILE_NAME: '[]',
  userIntervenedSince: '["s", { records: [], env: {} }]',
  readTotalBlocks: '["s", { env: {} }]',
  // 2026-11-18 `DF-029`：Stop 的去重键构造。纯函数，空输入必须返回 null 而不是抛
  // （`claimKeyOf` 缺段即放弃去重，见 hook-dedupe.mjs 文件头 §失效方向）。
  stopTurnKeyOf: '[{}]',
  resetBlockCount: '["s", { env: {} }]',
  appendLog: '[{}, { OVERWATCH_STOP_VERIFY_LOG: _sandbox + "/x.jsonl" }]',
  bumpBlockCount: '["s", { env: { OVERWATCH_STOP_VERIFY_STATE: _sandbox + "/x.json" } }]',
  // `env: {}` 会**覆盖**探针进程里已设好的 `OVERWATCH_STATE_DIR`，于是 `runHook`
  // 真的往生产台账写一行 `unparsable-input`。不传 env 才走 process.env（已含沙箱路径）。
  runHook: '[{ input: { session_id: "probe", last_assistant_message: "" } }]',
  // readStdin 要一个 stream。给一个「已 EOF」的最小替身：setEncoding/on 是空操作，
  // readableEnded 为 true 让它在第一拍就 resolve 空串 —— 不会挂住结构门，也不需要
  // 在 ESM 探针脚本里 import('node:stream')。
  readStdin: '[{ setEncoding() {}, on() {}, readableEnded: true }, 64]',
  loadRecords: '["/nonexistent-ow-probe", {}]',
  loadSubagentRecords: '["/nonexistent-ow-probe"]',
  // 放行样本记录（2026-11-13）。样本层是**纯记账**，探针只要证明它不抛：
  // 空 records / 空文本 / 不可写路径都必须安全返回。sampleLogEnabled 读命令行，
  // 给空 argv 走默认「开」。
  SAMPLE_TEXT_LIMIT: '[]', samplePathFor: '[{}]', sampleLogEnabled: '[{}, []]',
  toolSummaryOf: '[[]]', rawFamilyHits: '""',
  buildSample: '[{}]', appendSample: '[{}, { OVERWATCH_STOP_VERIFY_SAMPLES: _sandbox + "/s.jsonl" }]',
  // analyze-hook-samples.mjs（2026-11-13）：放行样本的分布分析。全部只读，探针取最小输入。
  // 读盘的两个用不存在的路径 —— 返回空样本是它的正常路径，正好验「空文件不报错」。
  COLON_COMPLETION_RE: '[]', COMPLETION_ANY_RE: '[]',
  completionShapeOf: '""', clusterOf: '[{}]', suspectOf: '[{}]', strongSuspectOf: '[{}]',
  formatReport: '[{}, {}]', topSuspects: '[{}, 0]', defaultSamplesPath: '[{}]',
  parseSampleLines: '""', loadSamples: '["/nonexistent-ow-samples.jsonl"]',
  statLine: '["x", 0, ""]',
  emptyState: '[]', recordSent: '[{}, "sid", 0]',
  diffProbe: '[{}, {}]', foldProbe: '[{}, {}]',
  canNotify: '[{}, "sid", 0]', candidatesFromScan: '[[]]',
  escapeXml: '"x"', sanitizeTag: '"x"', recalibrateWeights: '[{}]',
  textOf: '[{}]', buildPayloadXml: '["t", "b", "g"]',
  lastPermissionMode: '[]', parseAskAnswers: '""', relevanceOf: '["a", ["b"]]',
  answerIsNegative: '""', findEarlierMatch: '["a", ["b"]]', classifyStop: '[{}]',
  findStopPoint: '[[]]', formatStats: '[{}]',
  // classify-stop.mjs / watch.mjs：未闭合等待型 tool_use 的锚点（2026-11-09 去重修复）。
  // 两者都是纯的：空记录返回 []、不存在的路径返回 null。
  openWaitingToolUseIds: '[[]]', waitingAnchor: '["/nonexistent", "sid", null, 0]',
  // asked.mjs 的现状对账（2026-11-02）。参数取最小可构造输入：
  // 空记录 / 缺失路径 / 空白时间戳，只要能跑通就算登记完成。
  // 这些函数都是纯的（readRecords/readHostSessions 读路径失败时返回 null/[]，不抛）。
  inspectRecords: '[[], {}]', readRecords: '["/nonexistent"]',
  lastCwd: '[[]]', readHostSessions: '["/nonexistent"]',
  continuedAfterQuestion: '[[], "2026-11-01T23:31:45.824Z"]',
  humanSpokeElsewhere: '[[], "2026-11-01T23:31:45.824Z"]',
  assessAsked: '[{}]',  unclassifiableMinIdleSec: '[]', tooRecentToNotify: '["UNCLASSIFIABLE", 60, 300]',
  // watch.mjs：BLOCKED 事件时刻解析（2026-11-02 假阳性修复）。
  // 参数取最小可构造输入：空串 / 不存在的路径 / 空对象都必须安全返回，不抛。
  requestIdTime: '[""]', lastTimelineStateTime: '["/nonexistent", "blocked"]',
  resolveJobEventTime: '[{}, "/nonexistent"]',
  // replay-observe.mjs：回放脚本的纯函数。参数取最小可构造输入，
  // 目的是让「导出但调用即炸」（ReferenceError）在结构门就暴露。
  nextTick: '[0, 0]', callsUpTo: '[[0, 1], 0]', gapsOf: '[[]]',
  capText: '"x"', compactRecord: '[{}]', isToolResultOnly: '[{}]',
  originKindOf: '[{}]', pct: '[1, 2]', buildSessionStops: '[[]]',
  sliceStops: '[[], []]', stateAt: '[{ ts: [], calls: [] }, 0]',
  observeStop: '[{ ts: [], calls: [] }, { t0: 0, after: [] }, 0]',
  corpusSummary: '[[]]', runDelayModel: '[[], {}]', runPollModel: '[[], {}]',
  rewatchSuppressed: '[[], {}]', renderStats: '[[]]',
  // stop-signals.mjs：判据全部是纯函数，参数取最小可构造输入。
  // 目的同上——让「导出但调用即炸」在结构门就暴露，而不是等到报告写完才发现。
  readSlice: '["/nonexistent", 0, 8]', parseRecords: '""',
  readTail: '["/nonexistent"]', readHead: '["/nonexistent"]',
  endsWithoutToolUse: '[[]]', errorOf: '[{}]', hasRecentError: '[[]]',
  toolFingerprint: '["Read", {}]', toolCallSequence: '[[]]', detectLoop: '[[]]',
  contextPressure: '[[]]', isHumanMessage: '[{}]', humanMessages: '[[]]',
  originalGoalFrom: '[[]]', questionAnswered: '[[]]', lastTextIsQuestion: '[[]]',
  classifySession: '[{}]', summarize: '[[]]', listTranscripts: '["/nonexistent"]',
  // state-dir.mjs（2026-11-17 改名迁移）：状态目录的唯一解析处。
  // `resolveStateDir` 只做路径判断 + 一次 `existsSync`，不写盘；空 env 必须安全返回。
  resolveStateDir: '[{}, {}]', stateRoot: '[{}]',
  // 两个目录名常量是字符串，不是函数 —— 见 INTENTIONALLY_PROBED_FREE。
  // stop-delta.mjs（2026-11-16 交还 delta）：判据层全是纯函数，探针取最小可构造输入。
  // 空记录 / 空文本 / 空数组都必须安全返回 —— 一个没有内容的会话不该让报告崩掉。
  computeDelta: '[{}]', summarizeDelta: '[[]]', deltaSlotsOf: '""',
  // 2026-11-16 异常认识与真人判据下沉（打破导入环）。全部纯函数。
  isHumanMessage: '[{}]', errorOf: '[{}]', lastErrorIndex: '[[]]',
  changeSetOf: '[[], {}]', lastHumanIndex: '[[]]',
  // verify-claims.mjs：断言 vs 证据配对。全部是纯函数，参数取最小可构造输入。
  // 目的是让「导出但调用即炸」在结构门暴露，而不是等到对 1.5 GB 语料跑完才发现。
  detectClaims: '""', findEvidence: '[[], "test-count"]', classifyEvidence: '[{}]',
  splitSentences: '""', stripQuoted: '""', isNegated: '""', isInterrogative: '""',
  // 原话还原（2026-11-14）：切句带位置 + 不切断行内代码的截断。两者都是纯函数。
  splitSentenceSpans: '""', truncateQuote: '["x", []]', quoteRangeOf: '["x", {}, []]',
  isSpeculative: '""', lastAssistantText: '[[]]', buildEvidenceIndex: '[[]]',
  claimedCount: '""', readBack: '["/nonexistent"]', readTailRecords: '["/nonexistent"]',
  listSessions: '["/nonexistent"]', enoughForClaim: '[[]]', enoughForClaims: '[[], []]',
  evidenceSufficient: '[{}, {}]', normalizeCommand: '""', isTestCommand: '""',
  isBuildCommand: '""', isMutatingCommand: '""', editKindOf: '""', resultText: '[{}]',
  parseLines: '""', subagentFiles: '[{}]', summarizeClaims: '[[]]',
  // 三个断言识别缺陷的修复（2026-11-13）：假设/间接疑问判据 + 中文族名。
  // 探针取最小输入 —— 空字符串、空匹配，要求「不抛且给出人话」。
  matchesOf: '[/x/, ""]', clauseAt: '["", 0]', isHypotheticalMatch: '["", null]',
  familyName: '""', activityName: '""',
  scanSession: '[{"path":"/nonexistent","project":"p","sessionId":"s","mtimeMs":0,"size":0}]',
  // verify-claims.mjs 的产品化层（2026-11-05）：CLI 参数、输出渲染、时间线。
  // 这一层的职责只是「把已经判好的结论说成人话」，**不许改判**；
  // 探针照样逐条实际调用，让「导出了但调用即炸」在结构门就暴露。
  timeOf: '[[], 0]', attemptTimes: '[[], []]', evidenceTimeline: '[{}, []]',
  fmtClock: '""', verdictIcon: '""', evidenceSentence: '[{}]', adviceFor: '[{}]',
  // 「该重跑什么」的溯源链（2026-11-13）。probe 用空对象：没有 claim / evidence 时
  // 必须走到「认不出」那一档而不是抛异常 —— 这正是它对坏输入的唯一要求。
  recoveryCommandFor: '[{}]', actualCommandFor: '[{}, "test-count"]', shortenCommand: '["", null]',
  // 「笼统完成声明」的验证判据（2026-11-13）。和 isTestCommand / isBuildCommand 同一层：
  // 给一条命令，答「它算不算做过一次检查」。冒烟输入取一条只读命令，必须返回 false。
  isVerificationCommand: '"ls -la"',
  // compose-agent-prompt.mjs（2026-11-14 提示词分层拼装）：判定层全部纯函数，
  // 参数取最小可构造输入。读盘的几个用不存在的路径 / 空数组——「什么都没有」
  // 是它们的正常分支，正好顺带验一遍空而不炸。main 以外的副作用只有 appendFileSync，
  // 而它只在 CLI 的 compose 分支里被调用，结构门不会走到。
  parseFrontmatter: '""', roleTools: '""',
  // roles.mjs（2026-11-21，DF-044）：角色注册表。判定层全是纯函数，
  // 探针参数取最小可构造输入；读盘的三个（`discoverRoles` / `agentPrefixFrom` /
  // `defaultRoles`）用不存在的路径 —— 「目录不在」是它们的正常分支，
  // 正好顺带验一遍「空注册表不炸」。
  discoverRoles: '["/nonexistent-ow-agents"]',
  agentPrefixFrom: '["/nonexistent-ow-root"]',
  // 按根求值的注册表（2026-11-21）：`null` = 「只认框架」，不需要任何项目在盘上；
  // 这也是它最该验的分支（框架兜底），项目分支由 roles.test.mjs 端到端覆盖。
  rolesFor: '[null]', capabilitiesFor: '[null]', rolesDirFor: '"/nonexistent-ow-root"',
  sourceText: '[{ source: "framework", dir: "/nonexistent-ow-agents", roles: [] }]',
  idFromName: '"x"', truthyFlag: '""', readonlyOf: '[{}]',
  resolveRole: '[[]]', roleIndex: '[[]]', labelOf: '[[]]', nameOf: '[[]]',
  extractCommands: '""', classifyRequirement: '""', requiredTools: '[[]]',
  stopConditionProblem: '""',
  checkPromptSpec: '[{}]',
  fillDispatchTemplate: '["", {}]', composePrompt: '[{}]',
  deriveInjected: '[{ root: "/nonexistent-ow-probe" }]',
  normalizeForHash: '""', promptHash: '""', makePromptRow: '[{ run: "r", task: "t", hash: "h", bytes: 0 }]',
  firstUserText: '[[]]',
  verifyPrompts: '[{ rows: [], sessionPath: "/nonexistent-ow-probe" }]',
  renderSessionBlock: '[{}]', attemptTime: '[{}, 0]', renderMarkdown: '[[]]',
  exitCodeFor: '[{}]', renderSummary: '[{}]', renderDetail: '[{}, { claim: {} }]',
  parseArgs: '[[]]', resolveSession: '["/nonexistent", "abc"]', flattenResults: '[[]]',
  // project-root.mjs（2026-11-21，「两个根」拆分）：判定层全部纯函数。
  // 探针参数一律**喂空 env + 不可达 cwd**，于是它们走到第 5 级 ——
  // 「找不到就返回 null」是它们的正常分支，正好顺带验一遍不抛、不回落脚本位置。
  // `frameworkRoot` 只读 `import.meta.url`，零参数调用即可。
  // `levelText` 喂一个越界层级，验它「如实说未知」而不是编一个来源。
  frameworkRoot: '[]',
  resolveProjectRoot: '[{ env: {}, cwd: "/nonexistent-ow-probe" }]',
  projectRoot: '[{ quiet: true, env: {}, cwd: "/nonexistent-ow-probe" }]',
  rootFromArgv: '[[]]', searchUp: '["/nonexistent-ow-probe"]',
  levelText: '[99]', formatTried: '[[{ level: 1, at: "/x", ok: false, why: "未给" }]]',
  readPathsConfig: '["/nonexistent-ow-probe"]',
  runsDirInfo: '["/nonexistent-ow-probe", { config: null, env: {} }]',
  runsDirFor: '["/nonexistent-ow-probe", { config: null, env: {} }]',
  // stop-verify-hook.mjs 的 `ledgerRoot` 是 `resolveStateDir` 的别名（同一份判据，不是第二个）。
  // 空 env 必须安全返回一个**非空**路径 —— 返回空串会让 join 塌成相对路径。
  ledgerRoot: '[{}]',
  // measure-execution-phase.mjs（2026-11-14 执行期中断测量）：全部纯函数。
  // 参数一律取最小可构造输入（空对象 / 空串 / 空数组），让「导出但调用即炸」
  // 在结构门暴露。analyzeFile 用不存在的路径——它会抛，由 checkImportable 吞掉
  // （它只关心 ReferenceError）。run / formatReport 的完整正确性由
  // measure-execution-phase.test.mjs 的小目录用例覆盖。
  normToolName: '""', isWriteCall: '["Bash", { command: "ls" }]', isReadCall: '["Bash", { command: "ls" }]',
  optionLabels: '[[]]', questionsOf: '[{}]', classifyAnswer: '[{ options: [] }, ""]',
  createAccumulator: '[]', absorbRecord: '[{}, {}]',
  finalizeSession: '[{}, { path: "/x", bytes: 0, mtimeMs: 0 }]',
  groupSessions: '[[]]', groupStats: '[[]]', oneShotRate: '[[]]',
  ranks: '[[]]', spearman: '[[], []]', cliffsDelta: '[[], []]',
  spearmanPartial: '[[], [], []]', matchedPairs: '[[], []]',
  mulberry32: '[1]', permutationTest: '[[], []]',
  fnv1a: '[1, "x"]', recordSignature: '[{}]', analyzeFile: '["/nonexistent-ow-probe"]',
  // measure-intervention-cost.mjs（2026-11-14 中断代价测量）：全部纯函数。
  // 参数一律取最小可构造输入（空串 / 空数组 / 空对象），让「导出但调用即炸」
  // 在结构门暴露。readSessionDetail 用不存在的路径——它会抛，由 checkImportable
  // 吞掉（它只关心 ReferenceError）。run / formatReport 的完整正确性由
  // measure-intervention-cost.test.mjs 的小目录用例覆盖。
  normPath: '"x"', isReworkDemand: '""', undoEvents: '[[]]',
  commonPrefixLen: '[[], []]', dedupeResumeForks: '[[]]',
  readSessionDetail: '["/nonexistent-ow-probe"]', sessionCost: '[{ writes: [], humans: [], asks: [], seq: [], path: "/x", bytes: 0 }]',
  undoAroundInterruptions: '[{ writes: [], humans: [] }]', density: '[[], "x"]',
  groupRow: '[[]]', stratified: '[[]]',
  // measure-ask-vs-tell.mjs（2026-11-14 主指标重定义）：全部纯函数，参数取最小可构造输入。
  // readAskTimeline / cwdOf 读盘，用不存在的路径——readAskTimeline 会抛，由
  // checkImportable 吞掉（它只关心 ReferenceError）；cwdOf 自己 catch 后返回空串。
  // run / formatReport 要全量扫 2.1 GB，登记在 INTENTIONALLY_PROBED_FREE。
  isAskCall: '"AskUserQuestion"', classifyExecHuman: '"继续"', isCostly: '"继续"',
  readAskTimeline: '["/nonexistent-ow-probe"]',
  sessionRow: '[{ writes: [], humans: [], asks: [], seq: [], path: "/x", bytes: 0 }, { execTools: 0 }]',
  countOf: '[[], ["correction"]]', perSessionDensity: '[[]]', cleanRate: '[[]]',
  densityDiffTest: '[[], []]', cleanDiffTest: '[[], []]',
  matchedOnWork: '[[], []]', stratifyByWork: '[[]]',
  // tui-theme.mjs 的宽度算法（2026-11-05 宽度表修复）：Unicode 官方数据 + grapheme 聚类。
  // 参数取最小可构造输入，让「导出了但调用即炸」在结构门就暴露。
  codePointWidth: '"a"', truncateDisplay: '["x", 5]', hasColor: '"red"',
  segmenterAvailable: '[]', unknownColors: '[]', resetUnknownColors: '[]',
  setColorWarn: '[null]',
  // scan-sessions.mjs 的三源合并（2026-11-05）：--days 判据改为 transcript 内部时间。
  lastActivityOf: '[[]]', jobStateToState: '"blocked"', jobToRow: '[{}, 0]',
  mergeJobRows: '[[], [], 0]', windowLabel: '[3]',
  // 跨层去重的两个纯函数：空参数必须安全返回，不抛。
  scanCrossLayerFingerprint: '[{}]', hostFieldsOf: '[null]',
  // gen-width-table.mjs：从 scripts/data 下的 Unicode 原始数据生成宽度表。
  // 纯函数，参数取空输入即可跑通（readData 读的是仓库内已提交的数据文件）。
  parseUcdRanges: '""', parseEastAsianWidth: '""', parseEmojiPresentation: '""',
  mergeRanges: '[[]]', countCovered: '[[]]', renderModule: '[{}]',
  tableStats: '[{}]', readData: '[]',
  // tui-layout.mjs（2026-11-10 TUI 重做）：布局数学。参数取最小可构造输入，
  // 目的是让「导出了但调用即炸」在结构门就暴露 —— 这正是这次重构的主要收益之一。
  fmtSpan: '[1]', fmtAgeMs: '[1]', fmtScanAge: '[1]',
  truncateWithDisclosure: '["abc", 10]', alignRight: '["a", 3]',
  layoutRow: '[[], 10]', joinWithin: '[["a"], 10]',
  windowOf: '[{ count: 0, cursor: 0, area: 1 }]',
  resolveLayout: '[{ cols: 80, rows: 24 }]', layoutStages: '[]',
  binaryOf: '[{}]', partitionRows: '[{}]', verdictParts: '[{}]',
  // tui-layout.mjs（2026-11-11 需动作老化）：阈值两侧的纯函数。
  // 参数取最小可构造输入：空对象 / null 时钟都必须安全返回，不抛。
  ageLimitOf: '[{}]', ageSecOf: '[{}, null]', staleOf: '[{}]',
  stoppedSummary: '[[]]', sectionTitle: '["x", 0]',
  checklistRows: '[{}]', footerParts: '[{}]', actionCell: '[{}]', nearText: '[{}]',
  titleOf: '[{}]', shortPath: '""', runningColumns: '[80, {}]',
  runningRowOf: '[{}, { cols: 80 }]', actionRowOf: '[{}, { cols: 80 }]',
  sectionHeaderLine: '["x", 0, 80, ""]', checklistLine: '[{}, { cols: 80 }]',
  verdictLine: '[[], 80, ""]',
  // tui-layout.mjs（2026-11-11 检查表去表头）：句子 / 收尾句 / 零值压行。
  checklistSentence: '[{}]', checklistSummaryLine: '[4]',
  checklistLines: '[[], { cols: 80 }]', isQuietRow: '[{}]',
  footerLine: '[[], 80]', composeListScreen: '[{ cols: 80, rows: 24 }]',
  // tui-layout.mjs（2026-11-15 分节窗口）：三个新导出。
  //
  // `composeListFrame` 的探针参数**必须带 action/running**：空三段时走不到分节循环，
  // 于是「函数体里引用了未声明的变量」这类缺陷会被判成通过 —— 2026-11-15 的
  // `windows is not defined` 正是这样漏过去的（35 条测试红，结构门却是绿的）。
  // 探针要有牙，就得让它走到有分支的那条路上。
  sectionWindow: '[{ count: 3, area: 2 }]',
  sectionHiddenLine: '[{ label: "x", before: 1, after: 2, total: 5, cols: 80 }]',
  composeListFrame: '[{ cols: 80, rows: 24, action: [{}], running: [{}] }]',
  // tui-meta.mjs（2026-11-10）：有界读取与缓存。file 不存在时必须安全返回，不抛。
  projectsRoot: '[{}]', transcriptPathFor: '[{}, "/nonexistent"]',
  metaFromRecords: '[[]]', readTailRecords: '["/nonexistent"]',
  createMetaCache: '[{}]', lastSpeakerOf: '[[]]', pendingQuestionOf: '[[], {}]',
  askedVerdictOf: '[{}, {}]',
  // oversight-tui.mjs（2026-11-10）：三段视图与证据档位。
  viewOf: '[{}, null]', actionViewOf: '[{}]', buildSections: '[{}]',
  askedCountOf: '[{}]', waitingCountOf: '[{}]', claimsTally: '[[]]',
  scanAgeText: '[0, 0]',
  // tui-theme.mjs 的二值状态（2026-11-10）。
  binaryMark: '["running", false]', binaryColor: '["running"]',
  // claim-ledger.mjs（2026-11-13）：产出对账。判定层全部纯函数，参数取最小可构造输入。
  // 读盘的三个（readLedger / probeDisk / sha256File）一律给不存在的路径 —— 返回「没有」
  // 正是它们的正常空分支。appendRows 传空数组，它在建目录之前就返回 0，
  // 不会往仓库里写任何东西。
  makeNonce: '[]', findNonce: '["", []]',
  observedWrites: '[[]]', compareClaim: '[{}, {}]', foldRows: '[[]]',
  // Bash 写入识别（2026-11-13）：三个都是纯函数。探针给「一条判得出的命令 + 一个字面量 cwd」，
  // 目的是让「导出了但调用即炸」在结构门就暴露；判得对不对由 claim-ledger.test.mjs 守着。
  // 不用空字符串当探针：那会走「立即返回空数组」的分支，等于什么都没调。
  bashWrites: '["echo x > out.txt", "/repo"]',
  bashWriteScan: '["echo x > out.txt", "/repo"]',
  observedWriteScan: '[[], { cwd: "/repo" }]',
  reconcile: '[{ rows: [] }]', readLedger: '["/nonexistent-ow-ledger.jsonl"]',
  appendRows: '["/nonexistent-ow-dir/claims.jsonl", []]',
  ledgerPath: '["/x", "r"]', pathKey: '["a", "/x"]', resolvePath: '["a", "/x"]',
  // validate-run.mjs 的 outputs 判据（2026-11-13）。checkOutputs 用一份合法图调用，
  // 另外两个用合法输入调用——非法分支由 validate-run.test.mjs 覆盖（这里只保证
  // 「导出的函数真的能被调起来」）。合法/非法两条路径都覆盖，才不会出现
  // 「把校验改成恒真，结构门却照样绿」。
  checkOutputs: '[{ shape: "artifact", outputs: ["docs/a.md"] }]',
  outputPathError: '"docs/a.md"', outputPathKey: '"docs/a.md"',
  // 复杂度声明解析：三种输入覆盖三条分支（complex / simple / 未声明）。
  // 「两个都给」的冲突分支由 `--complex --simple` 的 CLI 用例覆盖 —— 探针只求
  // 「导出的函数真能被调起来」，不求在这里覆盖全部分支。
  complexityOpts: '[["--complex"]]',
  makeExpect: '[{ run: "r", task: "T", paths: ["a"] }]',
  makeClaim: '[{ run: "r", task: "T", path: "a" }]',
  makeObserve: '[{ run: "r", task: "T", path: "a" }]',
  makeConsume: '[{ run: "r", task: "T" }]',
  probeDisk: '["/nonexistent-ow-probe"]', sha256File: '["/nonexistent-ow-probe"]',
  subagentTranscriptsOf: '["/nonexistent-ow-probe"]',
  collectSubagentTranscripts: '["/nonexistent-ow-probe"]',
  readHeadText: '["/nonexistent-ow-probe", 8]', nonceOwners: '[[]]',
  // pre-write-gate.mjs（2026-11-14 写前闸）。判定层是纯函数，参数一律取最小可构造输入：
  // 空对象 / 空串 / 不存在的路径。带副作用的三个（writeMarker / appendLog /
  // bumpDenials）的 env 与路径都指向临时区 —— 探针不会写进任何真实项目。
  // 目的是让「导出了但调用即炸」在结构门暴露，而不是等到 hook 在真实会话里崩掉。
  //
  // 与 stop-verify-hook.mjs **重名**的六个导出（decide / runHook / parseHookInput /
  // readStdin / logPathFor / appendLog）不在这里重复登记：`PROBE_ARGS` 是一张扁平表，
  // 按名字命中所有模块，所以上面那份停在那里的探针参数同样会把本文件的同名导出调一次。
  // 本文件的签名对那几个探针都兼容（空对象 → passthrough，不写盘）。
  configOf: '[{}]', defaultConfig: '[]', markerPathFor: '["/nonexistent-ow-probe"]',
  denialPathFor: '["/nonexistent-ow-probe"]', pathKeyOf: '""',
  isGateOwnedPath: '["/nonexistent-ow-probe/.claude/.ow-read-done", "/nonexistent-ow-probe"]',
  powershellWriteScan: '"Get-Content a.txt"',
  writeIntentOf: '["Read", {}, "/nonexistent-ow-probe"]',
  readTranscriptReads: '["/nonexistent-ow-probe"]',
  // 2026-11-14 从 readTranscriptReads 抽出的纯解析层，重放器与闸门共用：
  // 提取纯函数让「同构」从声称变成保证，见 probe-parser-divergence.mjs。
  readPathsOfToolUse: '["Read", { file_path: "/nonexistent-ow-probe" }]',
  readPathsInTranscriptText: '""',
  readMarker: '["/nonexistent-ow-probe"]',
  writeMarker: '["/nonexistent-ow-probe/.claude/.ow-read-done", { sessionId: "probe" }]',
  markerValidity: '[{ marker: { exists: false }, secret: null }, { session_id: "probe" }]',
  // 2026-11-14 改动二：auto 标记的 HMAC 签名。密钥路径指向不存在的目录 —— 那是
  // 「还没有密钥」的正常分支，正好把 readGateSecret 返回 null 那条路也验一遍。
  markerSigOf: '[{ version: 1, session_id: "probe", at: "x", reads: 3 }, "k"]',
  verifyMarkerSig: '[{ version: 1, session_id: "probe", at: "x", reads: 3 }, null]',
  secretPathFor: '["/nonexistent-ow-probe"]',
  readGateSecret: '["/nonexistent-ow-probe/.claude/.ow-gate-secret"]',
  reasonFor: '[{ cwd: "/x", markerPath: "/x/m", gateCommand: "g", minReads: 3, halt: false }]',
  bumpDenials: '[_sandbox + "/pwg.json", "probe", { readOnly: true }]',
  cli: '[["status", "--cwd", "/nonexistent-ow-probe"], {}]',
  // 2026-11-19 `ask.minQuestionsBeforeWrite`（第一次写之前先问够 N 个问题）：
  // 判定层是纯函数，探针取最小可构造输入。`readTranscriptActivity` 给不存在的路径
  // —— 那是「读不到」的正常分支（`unreadable:true`），正好把 fail-open 那条也验一遍。
  // `minQuestionsBeforeWriteOf` 给一个不存在的配置文件：回落 0 是它的正常路径，
  // 而且**不能**让它去读仓库根的 `overwatch.config.json`（那是真配置）。
  readTranscriptActivity: '["/nonexistent-ow-probe"]',
  minQuestionsBeforeWriteOf: '[{}, { configFile: "/nonexistent-ow-probe.json" }]',
  reasonForQuestions: '[{ cwd: "/x", need: 3, have: 1, halt: false }]',
  MAX_MIN_QUESTIONS: '[]',
  // 2026-11-19（`DF-038` 修复）：口径的唯一实现 + 回扫上限常量。
  // `isAskToolName` 是**纯函数**，探针给三种名字（认的、不认的、空串），
  // 把两个分支都走一遍 —— 只给一个已认的值等于没验「不认」这一支。
  isAskToolName: '["AskUserQuestion"]',
  DEFAULT_MAX_SCAN_BYTES: '[]',

  // published-paths.mjs（`DF-039`）：判据是纯函数，探针取最小可构造输入。
  // 给一个**不含任何路径**的短串：「没有命中」是它们的正常分支，正好顺带验一遍；
  // 正确性（能不能抓到 / 会不会误放行）由 published-paths.test.mjs 逐条钉。
  normalizePathHit: '"x"',
  pathKeyOf: '"x"',
  isPlaceholderPath: '["D:\\\\x"]',
  findAbsolutePaths: '"no paths here"',
  publishedPathViolations: '"line one\\nline two"',
  // 2026-11-21 第二轮：已知本机标识符判据。探针给一个**不含任何中文**的串 ——
  // 「没有命中」是它的正常分支；命中路径由 published-paths.test.mjs 用假名字钉。
  knownIdentifierKeyOf: '"probe"',
  findKnownIdentifiers: '"no identifiers here"',

  // link-check.mjs（`DF-040`：文档相对链接的唯一判据）。
  // 纯函数给最小可构造输入：一段不含任何链接的文本必须安全返回空结果。
  // 读盘的三个（markdownFiles / publishableFiles / scanLinks）**不能进探针**：
  // 它们会 spawn git、并遍历整仓 170 份 .md —— 那正是「把跑一遍放进硬门」的灾难
  // （同 checkDocCommands 上方的理由）。它们的正确性由 link-check.test.mjs
  // 的临时目录端到端用例覆盖，`scanLinks` 也在那里用小目录真的跑一遍。
  stripCode: '"```\\nx\\n```"', slugifyAnchor: '"🚀 30 秒上手"',
  anchorsOf: '"# x"', isExternalLink: '"https://x"', linkOccurrences: '"no links"',
  describeBroken: '[{ file: "a.md", link: "b.md", line: 1, kind: "MISSING" }]',
  checkFileLinks: '[{ root: "/nonexistent-ow-probe", file: "a.md", text: "no links" }]',

  // observe-reality-check.mjs（2026-11-14 写前闸的真实语料重放）：
  // 判定函数全是纯的，探针取最小可构造输入。读盘的几个用不存在的路径 ——
  // 那正是「什么都没有」的正常路径，顺带把空分支也验一遍。
  // `defaultRoot` / `listTranscripts` / `fnv1a` / `recordSignature` / `distOf` 这些
  // 名字在别的模块已有同形探针（探针按名字命中**所有**模块），不重复登记。
  // 全量扫描（buildReport / main）要读 2GB 语料，登记在 INTENTIONALLY_PROBED_FREE。
  isSandbox: '[{}]', eachLineOffset: '["/nonexistent-ow-probe", () => {}]',
  verbsOf: '""',
  gateReadsOf: '["Read", {}]', broadReadsOf: '["Read", {}]',
  gateReadPathsInText: '""', tailGateReads: '["/nonexistent-ow-probe", 0]',
  structuralKind: '[{}]',
  verdict: '[{ firstWrite: { name: "Write", input: {} }, cwd: "/x" }]',
  GATE_READ_VERBS: '[]', STRUCT_VERBS: '[]', CONTENT_VERBS: '[]', STRUCT_TOOLS: '[]',

  // measure-gate-ceiling.mjs（2026-11-14 写前闸改宽上限）：判定层纯函数全部可调，
  // 探针取最小可构造输入；读盘的几个用不存在的路径（那是「什么都没有」的正常分支）。
  // 与 observe-reality-check.mjs 重名的导出（isSandbox / eachLineOffset / gateReadsOf
  // / tailGateReads / gateReadPathsInText / defaultRoot / listTranscripts / dedupeForks
  // / analyzeOne / agentToolIdsBefore / subagentReadsByToolId / looseSubagentReads
  // / isContinuation / CONTINUATION_RE / ATTRIBUTION_CLASSES / attribute）不重复登记 ——
  // PROBE_ARGS 按名字命中所有模块，上面那份探针会同样调用它们。
  gateReadsFixedOf: '["Bash", { command: "head -n 20 a.mjs" }]',
  // question-audit.mjs（2026-11-14 提问形态审计）：判定层全是纯函数，逐个实际调用。
  // 参数取最小可构造输入：空对象 / 空数组 / 空串 —— 都要安全返回，不抛。
  questionsOfAsk: '[{}]', normalizeText: '""', judgeReadFirst: '[{}]',
  judgeSession: '[{}, { ask: { mode: "always", maxQuestions: 5, requireReadFirst: true } }]',
  summarize: '[[], {}]', docTokenOverlap: '["x", []]',
  nearDuplicateQuestions: '[[]]', scanSession: '[[]]', validateConfig: '[{}]',
  loadConfig: '["/nonexistent-ow-probe.json"]',
  formatReport: '[{ summary: { sessions: 0, verdicts: {}, narrowVerdicts: {}, violCounts: {}, violations: 0 } }]',
  parseArgs: '[[]]',
  readWindowText: '["/nonexistent-ow-probe", 0]',
  windowReadPaths: '["/nonexistent-ow-probe", 0]',
  subagentPathSet: '[{ path: "/nonexistent-ow-probe/x.jsonl" }, []]',
  looseSubagentPathSet: '[{ path: "/nonexistent-ow-probe/x.jsonl" }]',
  upstreamOf: '[{}, []]',
  toolCallCount: '["/nonexistent-ow-probe"]',
  evidenceOf: '[{ path: "/nonexistent-ow-probe/x.jsonl", firstWrite: null }, [], { denied: false }]',
  variantSets: '[{ gateWin: new Set(), fixWin: new Set(), struct: new Set(), subStrict: new Set(), subLoose: new Set(), up: { set: new Set(), unique: false } }]',
  contentReads: '[{ gateWin: new Set(), fixWin: new Set(), subStrict: new Set(), subLoose: new Set(), up: { set: new Set() } }]',
  alignWithBaseline: '[{ threshold: 3, real: { withWrite: 0, zeroRead: 0, variants: {}, attribution: {} }, sandbox: { withWrite: 0, variants: {} }, rows: { real: [] } }]',
  parserEquivalence: '[[]]',
  byToolCalls: '[{ threshold: 3, rows: { real: [] } }]',
  byDate: '[{ threshold: 3, rows: { real: [] } }]',
  dropLargestProject: '[{ threshold: 3, rows: { real: [] } }]',
  BASE_THRESHOLD: '[]',

  // build-payload.mjs（2026-11-14 plugin 载荷生成）：判定层全部纯函数，探针取最小输入。
  // 读盘的两个（summarizeSources / planPayload）给不存在的路径 —— 「什么都没有」是它们的
  // 正常分支，正好把空分支也验一遍。checkPayload 同理（载荷目录不存在时直接返回一条原因）。
  // 会**写盘**的 buildPayload 不在这里：它拿到不存在的 root 会先攒 problems 并在写之前返回，
  // 但这个「先返回」是一条将来可能被改掉的实现细节，不该被结构门当作安全保证 —— 所以
  // 它和 main 一起登记在 INTENTIONALLY_PROBED_FREE，正确性由 build-payload.test.mjs 覆盖。
  // 函数名刻意不叫 parseArgs：探针表是按名字命中所有模块的扁平表，重名会被另一份参数调用。
  defaultOutDir: '["/nonexistent-ow-probe"]',
  summarizeSources: '["/nonexistent-ow-probe"]',
  payloadDigest: '[[{"source": ".claude/agents/a.md", "sha256": "bb"}]]',
  pluginManifest: '"a"', pluginManifestBytes: '"a"',
  planPayload: '[{"root": "/nonexistent-ow-probe"}]',
  checkPayload: '[{"root": "/nonexistent-ow-probe"}]',
  parseArgv: '[]',
};

/** 需要临时目录的导出，参数由探针注入 `_sandbox` */
const SANDBOX_ARGS = {
  loadState: '[_sandbox]', saveState: '[_sandbox, {}]',
  probeJobs: '[_sandbox]', probeMtime: '[_sandbox]',
  createLogger: '[_sandbox]', defaultStateDir: '{}', defaultNotifyDir: '{}',
  readLogHealth: '[_sandbox]', logHealthPath: '["/nonexistent"]',
  // DF-028：`procWitnessPath` 是纯路径拼接；`readProcWitness` 读不存在的目录 → null。
  // `judgeProcess(null)` 走 unverified 分支，**刻意不 spawn powershell**：
  // 结构门要一秒内跑完，不该为一条冷路径付 360ms，更不该对真实 PID 发信号。
  // `writeProcWitness` 写到沙箱（`_sandbox` 由探针注入），不碰真实数据目录。
  procWitnessPath: '["/nonexistent"]', readProcWitness: '["/nonexistent"]',
  processStartedAt: '[]', judgeProcess: '[null]',
  writeProcWitness: '[_sandbox]',
  createObservationLog: '[_sandbox]', observationStats: '[_sandbox]',
  classifyCandidate: '[{}]', readTranscriptTail: '["/nonexistent"]',
  // pre-write-gate.mjs 的签名密钥生成（2026-11-14）。它会 real 写盘，所以只能进
  // SANDBOX_ARGS —— 探针把它指到结构门自己的临时目录，不碰任何真实项目。
  ensureGateSecret: '[_join(_sandbox, "pwg-secret")]',

  // hook-dedupe.mjs（2026-11-18，`DF-029` 的幂等层）。三条都会写盘，所以一律进
  // SANDBOX_ARGS 并且路径由 `_sandbox` 拼 —— 它们**本身就是「写一个文件」这件事**，
  // 不给路径就没法验「调用即炸」。
  //   · claimOnce     认领一次事件（O_EXCL 创建）；空键走「放弃去重」分支，不写盘
  //   · recordSkipped 追加一行跳过记录
  //   · sweepIfCrowded 清理过期认领文件；目录不存在时安全返回
  // 另外两个纯路径拼接（claimPathFor / claimDirFor）与一个纯解析（claimKeyOf）也在这里，
  // 它们只需要最小可构造输入。
  claimDirFor: '[_sandbox, "probe"]',
  claimPathFor: '[_sandbox, "probe", "k"]',
  claimKeyOf: '["probe", ["a"]]',
  dedupeRoot: '[{}]',
  claimOnce: '[{ hookId: "probe", key: "k", env: { OVERWATCH_HOOK_DEDUPE_DIR: _sandbox } }]',
  recordSkipped: '[{ hookId: "probe", key: "k", env: { OVERWATCH_HOOK_DEDUPE_DIR: _sandbox } }]',
  sweepIfCrowded: '[_sandbox]',

  // make-social-preview.mjs 的渲染层（2026-11-18）：把顶层副作用收进 main() 之后
  // 才可被调用。`renderPng` 只产字节、不写盘 —— 正好用来验「点了就炸」。
  renderPng: '[]',
};

/** 同名但**签名不同**的导出：不参加强制调用。
 *
 *  `PROBE_ARGS` 是一张**扁平**表，按名字命中所有模块。而 `stop-verify-hook.mjs` 与
 *  `pre-write-gate.mjs` 里这几个名字一样、签名不一样：
 *
 *    stop-verify-hook : runHook({ input, env })          —— 一个对象
 *    pre-write-gate   : runHook(input, { env, nowMs })   —— 两个位置参数
 *
 *  拿 stop hook 那份参数去打 `pre-write-gate.runHook`，它读不到 `cwd`，
 *  回落到 `process.cwd()`（= 仓库根），然后**真的往生产台账写一行**。
 *  2026-11-18 实测：这正是每次跑结构门 `pre-write-gate/<日期>.jsonl` +2 行的原因，
 *  而且只在 `DF-031` 把 66 条静默跳过的探针打开之后才暴露 ——
 *  这个泄漏一直被「根本没验证」掩盖着。
 *
 *  宁可少覆盖几个，也不要用 A 的形状去调 B：那样得到的「通过」是假的。 */
const CROSS_MODULE_SKIP = Object.freeze([
  'runHook', 'decide', 'logPathFor', 'appendLog', 'readStdin', 'parseHookInput',
]);

/** `node --check` 只查语法，查不到「调用了一个不存在的函数」。
 *  曾把 wrapToWidth 的循环变量改了一半，语法全绿、结构门全绿，
 *  但按 ? 打开帮助就抛 ReferenceError。
 *
 *  性能：曾对每个文件起一个 node 进程（8 文件 × 1.5s ≈ 12s）。现在一个进程跑完，
 *  单文件失败不影响其他文件。 */
function checkImportable() {
  const dir = join(ROOT, 'scripts');
  if (!existsSync(dir)) return;

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && !CLI_SCRIPTS.has(f));
  if (!files.length) return;

  const base = 'file:///' + dir.split('\\').join('/');
  const script = [
    'import { mkdtempSync, rmSync } from "node:fs";',
    'import { join as _join } from "node:path";',
    'import { tmpdir } from "node:os";',
    'const _sandbox = mkdtempSync(_join(tmpdir(), "ow-gate-"));',
    'process.env.OVERWATCH_STATE_DIR = _sandbox;',
    'process.on("exit", () => { try { rmSync(_sandbox, { recursive: true, force: true }); } catch {} });',
    `const PROBE_ARGS = ${JSON.stringify(PROBE_ARGS)};`,
    `const SANDBOX_ARGS = ${JSON.stringify(SANDBOX_ARGS)};`,
    `const FILES = ${JSON.stringify(files)};`,
    `const DIR = ${JSON.stringify(base)};`,
    `const CROSS_MODULE_SKIP = ${JSON.stringify([...CROSS_MODULE_SKIP])};`,
    'const SKIP = new Set(CROSS_MODULE_SKIP);',
    'const failures = [];',
    '// 并行 import：串行时每个 import 只花几十毫秒，但整轮仍受进程启动主导；',
    '// 并行后 6 个模块合计 78ms，而不是 6 × 1.5s。',
    'const MODS = await Promise.all(FILES.map((f) =>',
    '  import(DIR + "/" + f).then((m) => [f, m]).catch((e) => [f, null, e.message])));',
    'for (const [f, m, err] of MODS) {',
    '  if (!m) { failures.push([f, "import: " + err]); continue; }',
    '  let m2 = m;',
    '  for (const [k, v] of Object.entries(m2)) {',
    '    if (typeof v !== "function") continue;',
    '    if (SKIP.has(k)) continue;',
    '    const src = PROBE_ARGS[k] !== undefined ? PROBE_ARGS[k] : SANDBOX_ARGS[k];',
    '    if (src === undefined) continue;',
    '    let a;',
    // 探针参数按 **JS 表达式**求值，而不是要求写成 JSON。
    //
    // 2026-11-18 实测（`DF-031`）：这里原本是 `JSON.parse("[" + src + "]")`，
    // 而 `PROBE_ARGS` 里大量条目的值是 JS 对象字面量（`{ env: {} }`、
    // `[{ isTTY: false }]`、`[{ summary: {...} }]`）—— 它们不是合法 JSON，
    // 于是 **458 条里 66 条被静默跳过**。被跳过的恰好是 `appendLog` / `runHook` /
    // `decide` / `resetBlockCount` / `bumpBlockCount` / `reconcile` 这些
    // **有副作用、最该被验**的导出：结构门对它们一个字都没验证，
    // 却在别处声称「导出了但调用即炸会在这里暴露」。
    //
    // 静默跳过在这里格外危险：它的表现和「这条探针通过了」完全一样。
    //
    // 为什么是求值而不是把这 66 条改写成 JSON：
    //   · 逐条改是**改数据**，下一个加探针的人还会写成 JS 字面量，同一个坑再踩一次；
    //   · 求值是**改机制**，`{ env: {} }` 这种写法从此就是对的。
    //   安全前提：探针在子进程里跑，且 `OVERWATCH_STATE_DIR` 已在本脚本开头指到临时目录
    //   （见 `process.env.OVERWATCH_STATE_DIR = _sandbox`），两个 hook 都认它 ——
    //   所以「真的调用一次 `runHook`」不会写进生产台账。
    // 注意必须是**直接** eval（`eval(...)`）而不是间接的 `(0, eval)(...)`：
    // 间接求值在 ESM 里跑在全局作用域，看不到本模块的 `_sandbox` / `_join`，
    // 而 `SANDBOX_ARGS` 里正是用这两个变量拼路径。实测：写成 `(0, eval)` 时
    // `ensureGateSecret` / `createLogger` 等 5 条会报 `_join is not defined` ——
    // 报错比静默跳过好，但它们本来能过。
    '    try { a = eval("[" + src + "]"); } catch (e) {',
    '      failures.push([f, k + ": 探针参数求值失败（" + e.message + "）：" + src.slice(0, 80)]);',
    '      continue;',
    '    }',
    // 把每个对象实参上的 `env` 强制指进沙箱。
    //
    // 探针表里有 `{ env: {} }`、`{ env: { OVERWATCH_STOP_VERIFY_LOG: ... } }` 这类写法，
    // 它们**覆盖**了进程级 `OVERWATCH_STATE_DIR`，于是「调一次 appendLog 看它炸不炸」
    // 会真的往生产台账写一行。实测：`pre-write-gate.appendLog` 与 `stop-verify-hook.appendLog`
    // 同名，探针按名字命中两个模块，前者不认 `OVERWATCH_STOP_VERIFY_LOG`，
    // 于是回落到仓库默认路径 —— 每跑一次结构门就多一行 `sid=undefined`。
    //
    // 修在**机制层**而不是逐条改数据：新增探针不需要记得这件事，
    // 想往沙箱外写也写不出去。
    '    for (const arg of a) {',
    '      if (!arg || typeof arg !== "object" || Array.isArray(arg)) continue;',
    '      if (!("env" in arg)) continue;',
    '      arg.env = { ...(arg.env || {}), OVERWATCH_STATE_DIR: _sandbox };',
    '    }',
    '    try {',
    '      const r = v(...a);',
    '      if (r && typeof r.then === "function") await r.catch(() => {});',
    '    } catch (e) {',
    '      if (e instanceof ReferenceError) { failures.push([f, k + ": " + e.message]); break; }',
    '    }',
    '  }',
    '}',
    'if (failures.length) { console.error(JSON.stringify(failures)); process.exit(1); }',
  ].join('\n');

  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 45000,
  });
  if (r.status !== 0) {
    let detail = '';
    try {
      const list = JSON.parse(String(r.stderr || '').trim().split('\n').pop());
      detail = list.map(([f, msg]) => `${f} → ${msg}`).join('; ');
    } catch {
      detail = (String(r.stderr || '').trim().split('\n').find((l) => l.trim()) || '未知错误');
    }
    fail('scripts/', `import 或调用导出函数时失败：${detail.slice(0, 220)}`);
  }
}

// ── 检查 9：文档相对链接 ──────────────────────────────────────────────

/** 相对链接必须按其所在目录解析。曾用仓库根当基准，导致 `../adr/x.md`
 *  这类正确链接被误报为断链，于是检查器只好退化成建议门。
 *
 *  **判据本体搬到 `scripts/link-check.mjs`**（`DF-040`）。原先这里和
 *  `check-links.mjs` 是**两份实现、同一份手写文件清单**：
 *
 *      const files = ['README.md', 'CLAUDE.md'] ... walkMd(join(ROOT, 'docs'))
 *
 *  于是根级 `CONTRIBUTING.md` / `CONTRIBUTING-EN.md` / `SECURITY.md` / `SECURITY-EN.md`
 *  一份都不在范围内，两边都报「0 断链」。手写清单的失效方式是结构性的 ——
 *  与 `checkAbsolutePaths()` 判「会不会发出去」弃用手写清单是同一个理由。
 *
 *  现在两边共用一份判据、一份范围（问 git），并且判据有单测
 *  （`link-check.test.mjs`）。这里只负责把结果转成 `fail()`。 */
function checkLinks() {
  const { broken } = scanLinks({ root: ROOT });
  for (const b of broken) fail(b.file, `第 ${b.line} 行${KIND_TEXT[b.kind] || '链接有问题'}：${b.link}`);
}

/** 参数白名单的代价：新加的纯函数若忘了登记，就不会被探到。
 *  这里把它变成可见的提示，而不是静默跳过——不阻塞（有些导出本来就是有副作用的），
 *  但每次都会列出来，提醒去登记或确认它不需要登记。 */
function checkUnregisteredExports() {
  const dir = join(ROOT, 'scripts');
  if (!existsSync(dir)) return;
  const REGISTERED = new Set([
    'parseArgs', 'parseKeys', 'parseKeysWithRest', 'judgeState', 'noveltyOf',
    // stop-signals.mjs（判据与汇总）
    'readSlice', 'parseRecords', 'readTail', 'readHead', 'endsWithoutToolUse',
    'errorOf', 'hasRecentError', 'toolFingerprint', 'toolCallSequence', 'detectLoop',
    'contextPressure', 'isHumanMessage', 'humanMessages', 'originalGoalFrom',
    'questionAnswered', 'lastTextIsQuestion', 'classifySession', 'summarize',
    // stop-delta.mjs（2026-11-16）：交还 delta 的正交轴。四个函数已进 PROBE_ARGS 实际调用；
    // 两个冻结表是数据，不是函数。
    'computeDelta', 'summarizeDelta', 'deltaSlotsOf', 'changeSetOf', 'lastHumanIndex',
    'resolveStateDir', 'stateRoot',
    // project-root.mjs（2026-11-21）的常量与两个环境变量名：不是函数，checkArgs 调不动。
    // 行为由 project-root.test.mjs 的 27 条用例守。
    'LEVELS', 'PROJECT_MARKERS', 'DEFAULT_RUNS_REL', 'ROOT_ENV', 'RUNS_DIR_ENV',
    'isHumanMessage', 'errorOf', 'lastErrorIndex',
    'DELTA_VERDICTS', 'SLOT_STATES',
    'signatureOf', 'normalizeBash', 'heartbeatThreshold', 'isPersistentChange', 'parseJsonl', 'SUBAGENT_READ_BYTES',
    'deltaFieldOf', 'tailWindowOf',
    'displayWidth', 'padDisplay', 'paint', 'badge', 'colorEnabled', 'stripAnsi',
    'sanitize', 'truncateToWidth', 'wrapToWidth', 'buildDraft', 'detailLines',
    'stripLongStrings', 'collectSubagentFiles', 'stateCounts', 'listRow',
    'columnHeaderLine', 'listHeaderLine', 'usage', 'fmtDur', 'fmtNovelty',
    'projectLabel', 'glyphOf', 'stateOf', 'reasonClass', 'dedupeKey', 'convergeBySession',
    'emptyState', 'loadState', 'saveState', 'recordSent', 'probeJobs', 'pruneNotified', 'NOTIFIED_TTL_HOURS',
    'probeMtime', 'diffProbe', 'foldProbe', 'canNotify', 'candidatesFromScan',
    'createLogger', 'defaultStateDir', 'escapeXml', 'sanitizeTag', 'textOf',
    'buildPayloadXml', 'defaultNotifyDir', 'lastPermissionMode',
    'parseAskAnswers', 'relevanceOf', 'answerIsNegative',
    'findEarlierMatch', 'classifyStop', 'notifyTitle',
    'findStopPoint', 'readTranscriptTail', 'classifyCandidate',
    'createObservationLog', 'observationStats', 'formatStats', 'readObservationRows', 'readObservationRows', 'NOTIFY_KINDS', 'OBS_MAX_BYTES',
    'unclassifiableMinIdleSec', 'tooRecentToNotify', 'UNCLASSIFIABLE_MIN_IDLE_SEC', 'IDLE_BUCKETS',
    'traceability', 'readJobStates', 'probeWaiting', 'readLiveSessionStates',
    'buildInbox', 'formatInbox', 'healthCheck', 'formatHealth', 'HEALTH_PERIODS',
  // watch.mjs 的日志健康旁挂文件（2026-11-12）。readLogHealth 已进 PROBE_ARGS
  // （用 `_sandbox` 真的调一次）；logHealthPath 是纯路径拼接，也进 PROBE_ARGS；
  // LOG_HEALTH_FILE 是数据（文件名常量），不是函数。
  'readLogHealth', 'logHealthPath', 'LOG_HEALTH_FILE',
  // watch.mjs 的进程见证（DF-028，2026-11-18）：「进程死了」与「进程卡住了」可区分。
  // `judgeProcess` 进 PROBE_ARGS 但不传见证 → 走 unverified 分支，**不 spawn powershell**
  // （否则每跑一次结构门多 360ms，且这条冷路径的代价不该由硬门承担）。
  // `PROC_TOLERANCE_MS` 是数字，不是函数 —— checkArgs 调不动它。
  'procWitnessPath', 'writeProcWitness', 'readProcWitness', 'processStartedAt',
  'judgeProcess', 'PROC_TOLERANCE_MS',
    'statusToState', 'liveToRow', 'mergeLiveSessions', 'listRow', 'detailLines', 'pendingLines',
    'claimOwnership', 'readOwner', 'ownerPath', 'askedCandidates',
    'requestIdTime', 'lastTimelineStateTime', 'resolveJobEventTime', 'BLOCKED_MAX_AGE',
  // job-event-time.mjs（2026-11-10 抽出）：跨层去重的地基。
  // 三个函数已进 PROBE_ARGS 实际调用；常量是数据，不是函数。
  'TIMELINE_TAIL_BYTES',
  // scan-sessions.mjs（2026-11-10 跨层去重）：宿主字段摊平与 job 指纹的唯一实现。
  'scanCrossLayerFingerprint', 'hostFieldsOf',
    // asked.mjs
    'lastAssistantText', 'endsWithQuestion', 'classifyQuestion',
    'inspectTranscript', 'scanAll', 'formatResult', 'GREETING', 'DEFAULT_MIN_HOURS',
    'questionKey', 'sessionIdOf', 'loadHistory', 'saveHistory', 'mergeHistory',
    'historyStats', 'historyPath', 'formatHistory', 'BACKLOG_HOURS', 'MAX_QUESTION_HOURS',
    // asked.mjs 的现状对账（2026-11-02）。这些都会被 PROBE_ARGS 实际调用，
    // 所以「调用一个不存在的函数」在这道门就会暴露。
    'inspectRecords', 'readRecords', 'lastCwd', 'readHostSessions',
    'continuedAfterQuestion', 'humanSpokeElsewhere', 'assessAsked',
    'ASKED_FRESHNESS', 'ASKED_MAX_SILENCE_HOURS',
    // classify-stop.mjs / watch.mjs 的等待锚点（2026-11-09）。两个都已进 PROBE_ARGS 实际调用。
    'WAITING_TOOL_NAMES', 'openWaitingToolUseIds', 'waitingAnchor',
    // probe-relay.mjs
    'listSessions', 'readPeerToken', 'canConnect', 'buildFrame', 'sendFrame', 'interpretReply',
    // validate-run.mjs
    'validateGraph', 'validateFile', 'CAPABILITIES', 'SHAPES', 'REQUIRED_FOR_COMPLEX', 'MIN_SUBTREES',
    // validate-run.mjs 的复杂度声明解析（DF-042，2026-11-21）：CLI 的
    // `--complex` / `--simple` → `requireComplex`。**这就是缺陷 A 的修复点**——
    // 在它存在之前 CLI 从不传 opts，硬约束 2 的三条检查在命令行上永不执行。
    // 已进 PROBE_ARGS 实际调用（覆盖「两个都给」那条冲突分支）。
    'complexityOpts',
    // validate-run.mjs 的 outputs 判据（2026-11-13）：每个子树必须声明「磁盘上会多出什么」。
    // checkOutputs 走 PROBE_ARGS 真实调用一次（登记在下面）；另外两个是它内部的纯判据，
    // 由 validate-run.test.mjs 的合法/非法两组用例覆盖，这里按数据登记。
    'SHAPES_REQUIRING_OUTPUTS', 'checkOutputs', 'outputPathError', 'outputPathKey',
    // validate-run.mjs 的依赖图判据（2026-11-15）：环检测 + 前置失败开关。
    // `checkDependencyCycles` 有两条真调用（合法链 / 环），见 validate-run.test.mjs；
    // `ON_DEP_FAILED` 是枚举数据，按数据登记。
    'checkDependencyCycles', 'ON_DEP_FAILED',
    // install-watcher.mjs
    'launcherPath', 'templatePath', 'stateDirFor', 'startupDir', 'shortcutPath',
    'renderLauncher', 'needsRegenerate', 'createShortcut', 'autostartAdvice', 'witnessPath', 'writeWitness', 'readWitness', 'checkStateIntegrity', 'HOST_FACT_STATES',
    'recalibrateWeights', 'NOTIFY_STATES', '__internals', 'STATES', 'DAY', 'HOUR', 'MINUTE', 'App', 'KINDS',
    // replay-observe.mjs
    'nextTick', 'callsUpTo', 'gapsOf', 'capText', 'compactRecord', 'isToolResultOnly',
    'originKindOf', 'pct', 'buildSessionStops', 'sliceStops', 'stateAt', 'observeStop',
    'corpusSummary', 'runDelayModel', 'runPollModel', 'rewatchSuppressed', 'renderStats',
    'POLL_INTERVAL_MS', 'DEFAULT_MIN_IDLE_SWEEP', 'DEFAULT_DELAYS_SEC',
    // verify-claims.mjs：断言 vs 证据配对（2026-11-03）。纯函数逐个进了 PROBE_ARGS。
    'detectClaims', 'findEvidence', 'classifyEvidence', 'splitSentences', 'stripQuoted',
    // verify-claims.mjs 原话还原（2026-11-14）：都已进 PROBE_ARGS 实际调用。
    'splitSentenceSpans', 'truncateQuote', 'quoteRangeOf',
    'isNegated', 'isInterrogative', 'isSpeculative', 'lastAssistantText', 'buildEvidenceIndex',
    'claimedCount', 'readBack', 'readTailRecords', 'listSessions', 'enoughForClaim',
    'enoughForClaims', 'evidenceSufficient', 'normalizeCommand', 'isTestCommand',
    'isBuildCommand', 'isMutatingCommand', 'editKindOf', 'resultText', 'parseLines',
    'subagentFiles', 'summarizeClaims', 'scanSession',
    // verify-claims.mjs 的产品化层（2026-11-05）。函数已进 PROBE_ARGS 实际调用。
    'timeOf', 'attemptTimes', 'evidenceTimeline', 'fmtClock', 'verdictIcon',
    'evidenceSentence', 'adviceFor', 'renderSessionBlock', 'attemptTime',
    'recoveryCommandFor', 'actualCommandFor', 'shortenCommand',
    'renderMarkdown', 'exitCodeFor', 'renderSummary', 'renderDetail',
    'resolveSession', 'flattenResults',
    // verify-claims.mjs 的常量与正则。都是数据，不是函数；函数已逐条登记在 PROBE_ARGS 里。
    'CLAIM_TAIL_BYTES', 'DEFAULT_BACKTRACK_BYTES', 'BACKTRACK_STEPS', 'EVIDENCE_STATUS',
    'EDIT_TOOLS', 'SHELL_TOOLS', 'CLAIM_FAMILIES', 'NEGATION_RE', 'INTERROGATIVE_RE',
    'SPECULATIVE_RE', 'FENCED_CODE_RE', 'BLOCKQUOTE_LINE_RE', 'TEST_CMD_RE', 'BUILD_CMD_RE',
    'COMMIT_CMD_RE', 'PUSH_CMD_RE', 'CI_CMD_RE', 'SYNC_CHECK_CMD_RE', 'RUNTIME_CMD_RE',
    'FAIL_OUTPUT_RE', 'COMMIT_OK_RE', 'PUSH_OK_RE', 'PUSH_REJECT_RE', 'SKIP_TESTS_RE',
    'GIT_READONLY_RE', 'BASH_MUTATION_RE', 'CODE_EXTS', 'DOC_EXTS', 'NON_SOURCE_FILES',
    // 笼统完成声明族（2026-11-13）：一条正则 + 一条否决条件 + 一条验证命令判据。
    'COMPLETION_RE', 'COMPLETION_VETO_RE', 'VERIFY_CMD_RE',
    // 三个断言识别缺陷的修复（2026-11-13）：假设/间接疑问判据 + 中文族名。
    // 函数进 PROBE_ARGS 实际调用；正则与冻结表是数据。
    'matchesOf', 'clauseAt', 'isHypotheticalMatch', 'familyName', 'activityName',
    'HYPOTHETICAL_LEAD_RE', 'HYPOTHETICAL_MARK_RE', 'HYPOTHETICAL_BRIDGE_RE',
    'INVERSION_QUESTION_RE', 'FAMILY_NAMES', 'ACTIVITY_NAMES',
    // 三个断言识别缺陷的修复（2026-11-13）：假设/间接疑问判据 + 中文族名表。
    // 都是数据（正则 / 冻结表），函数已逐条登记在 PROBE_ARGS 里。
    'HYPOTHETICAL_LEAD_RE', 'HYPOTHETICAL_MARK_RE', 'HYPOTHETICAL_BRIDGE_RE',
    'INVERSION_QUESTION_RE', 'FAMILY_NAMES', 'ACTIVITY_NAMES',
    // verify-claims.mjs 产品化层的常量与帮助文本。
    'HELP_TEXT', 'ALERT_STATUS',
    // tui-theme.mjs 的宽度算法（2026-11-05）。宽度表来自 Unicode 官方数据，
    // 由 gen-width-table.mjs 生成；这些导出保证「表与算法」都有探针。
    'truncateDisplay', 'codePointWidth', 'hasColor', 'segmenterAvailable',
    'unknownColors', 'resetUnknownColors', 'setColorWarn',
    // scan-sessions.mjs 的三源合并（2026-11-05）：--days 改用 transcript 内部时间，
    // 并从 jobs/*/state.json 补入没有 transcript 的会话。
    'lastActivityOf', 'jobStateToState', 'jobToRow', 'mergeJobRows', 'windowLabel',
    // gen-width-table.mjs：从 scripts/data 下的 Unicode 原始数据生成宽度表。
    'parseUcdRanges', 'parseEastAsianWidth', 'parseEmojiPresentation',
    'mergeRanges', 'countCovered', 'renderModule', 'tableStats', 'readData',
    'DATA_DIR', 'OUT_PATH',
    // oversight-tui.mjs（2026-11-05）：光标身份、来源标签、空列表的诚实文案。
    'sessionKey', 'sourceLabel', 'emptyLines',
    // tui-layout.mjs（2026-11-10 TUI 重做）：列表页的布局数学，全部是纯函数。
    // 抽出它们的目的就是「可单测」，所以每一条都必须进 PROBE_ARGS 被真实调用一次。
    'TIERS', 'NEVER_DROP', 'fmtSpan', 'fmtAgeMs', 'fmtScanAge', 'truncateWithDisclosure',
    'alignRight', 'layoutRow', 'joinWithin', 'windowOf', 'resolveLayout', 'layoutStages',
    'ACTION_STATES', 'binaryOf', 'partitionRows', 'verdictParts', 'stoppedSummary',
    'sectionTitle', 'checklistRows', 'footerParts', 'actionCell', 'nearText', 'titleOf',
    'shortPath', 'runningColumns', 'runningRowOf', 'actionRowOf', 'sectionHeaderLine',
    'checklistLine', 'checklistSentence', 'checklistSummaryLine', 'checklistLines', 'isQuietRow',
    'verdictLine', 'footerLine', 'composeListScreen',
    // tui-layout.mjs（2026-11-15 分节窗口）：滚动时「需动作段不被切」的那一组。
    'sectionWindow', 'sectionHiddenLine', 'composeListFrame',
    // tui-meta.mjs（2026-11-10）：标题 / 末条 assistant 的有界读取与 mtime 缓存。
    'META_TAIL_BYTES', 'projectsRoot', 'transcriptPathFor', 'metaFromRecords',
    'readTailRecords', 'createMetaCache', 'lastSpeakerOf', 'pendingQuestionOf',
    // 2026-11-16：「问了没答」的判定与  同源（四道门），纯函数。
    'askedVerdictOf',
    // oversight-tui.mjs（2026-11-10 TUI 重做）：分段视图与证据档位。
    'viewOf', 'actionViewOf', 'buildSections', 'askedCountOf', 'waitingCountOf',
    'claimsTally', 'scanAgeText', 'defaultClaimsScan',
    // 2026-11-11：草稿可复制性说明（剪贴板里只能有能直接发出去的文字）。
    'buildDraft', 'draftHintOf',
    'ACTION_MAX_AGE_SEC', 'ageLimitOf', 'ageSecOf', 'staleOf',
    // width-table.mjs：由 gen-width-table.mjs 生成的纯数据表（不是函数，无需探针）。
    'EAW_WIDE', 'EMOJI_PRESENTATION',
    // tui-theme.mjs 的二值状态表（2026-11-10）：彩色下统一 `•`，无色下换形状。
    'BINARY', 'binaryMark', 'binaryColor',
    // measure-interventions.mjs（2026-11-11）：人工介入测量。判据全部是纯函数，
    // 参数取最小可构造输入；读盘的两个（eachLine / analyzeTranscript）用不存在的路径。
    'MAX_CLASSIFY_LEN', 'CORRECTION_MAX_LEN', 'INTERRUPT_RE', 'AVOIDABILITY',
    'userText', 'humanTurnText', 'isInterrupt', 'assistantStop', 'askedUser',
    'isAskAnswer', 'classifyHumanMessage', 'avoidabilityOf', 'percentile',
    'eachLine', 'analyzeTranscript', 'formatReport', 'defaultRoot',
    // project-commands.mjs（2026-11-12 Stop hook 验证闸）：项目类型探测。
    // 纯函数逐个进 PROBE_ARGS；detectProjectCommands 读的是「一个不存在的目录」，
    // 返回 unknown —— 这是它的正常路径，正好把「认不出」分支也验一遍。
    'MAX_READ_BYTES', 'readCapped', 'pickNpmScripts', 'pickMaven', 'pickGradle',
    'pickCargo', 'pickGo', 'pickPython', 'pickDotnet', 'detectProjectCommands', 'commandHint',
    // stop-verify-hook.mjs（2026-11-12）：Stop hook 验证闸。判定层（decide / buildReason /
    // resolveAssistantText / modeOf / parseHookInput）是纯的，参数取最小可构造输入；
    // 记账层（appendLog / bumpBlockCount / readBlockCount / resetBlockCount / logPathFor /
    // statePathFor）在有副作用前就返回，不会写进用户的 %LOCALAPPDATA%。
    'BLOCKING_STATUS', 'DEFAULT_BACKTRACK_MB', 'DEFAULT_BUDGET_MS', 'ESCALATE_AT',
    'MAX_BLOCKS', 'RESET_AFTER_MS', 'modeOf', 'parseHookInput', 'readStdin',
    'resolveAssistantText', 'decide', 'buildReason', 'logPathFor', 'appendLog',
    'statePathFor', 'bumpBlockCount', 'resetBlockCount', 'readBlockCount', 'readTotalBlocks', 'runHook',
    'pausePathFor', 'pausePathsFor', 'pausedPathOf', 'PAUSE_FILE_NAME',
    'isPaused', 'lastBlockAt', 'userIntervenedSince',
    // 2026-11-18 `DF-029`：Stop 的去重键构造（纯函数，输入进、字符串出）。
    'stopTurnKeyOf',
    'loadRecords', 'loadSubagentRecords', 'SUBAGENT_TAIL_BYTES',
    // stop-verify-hook.mjs 的放行样本记录（2026-11-13）。纯记账层：写入失败一律
    // 吞掉，所以探针只需要证明「给了最小输入也不抛」。分析命令的导出同批登记。
    'SAMPLE_TEXT_LIMIT', 'samplePathFor', 'sampleLogEnabled', 'toolSummaryOf',
    'rawFamilyHits', 'buildSample', 'appendSample',
    // analyze-hook-samples.mjs（2026-11-13）：放行样本的分布分析。全程只读，
    // 空输入必须能跑 —— 一个空样本文件不该让分析命令报错。
    'COLON_COMPLETION_RE', 'COMPLETION_ANY_RE', 'completionShapeOf', 'clusterOf',
    'suspectOf', 'strongSuspectOf', 'summarize', 'formatReport', 'topSuspects',
    'defaultSamplesPath', 'parseSampleLines', 'loadSamples', 'statLine',
    // verify-claims.mjs 的「做过检查没有」判据（2026-11-13），已进 PROBE_ARGS。
    'isVerificationCommand',
    // claim-ledger.mjs（2026-11-13）：产出对账。判定层全是纯函数，参数取最小可构造输入；
    // 读盘的三个（readLedger / probeDisk / sha256File）用不存在的路径——那正是它们
    // 的「什么都没有」正常路径，正好把空分支也验一遍。appendRows 传空 rows，
    // 它在建目录之前就返回 0，不会写进仓库。
    'makeNonce', 'findNonce', 'observedWrites', 'compareClaim', 'foldRows',
    'bashWrites', 'bashWriteScan', 'observedWriteScan',
    'reconcile', 'readLedger', 'appendRows', 'ledgerPath', 'pathKey', 'resolvePath',
    'makeExpect', 'makeClaim', 'makeObserve', 'makeConsume',
    'probeDisk', 'sha256File', 'subagentTranscriptsOf', 'collectSubagentTranscripts',
    'readHeadText', 'nonceOwners',
    // 常量与枚举：都是数据，不是函数。
    'LEDGER_VERSION', 'LEDGER_FILE', 'HASH_MAX_BYTES', 'SUBAGENT_HEAD_BYTES',
    'OBSERVE_TAIL_BYTES', 'WRITE_TOOLS', 'ITEM_STATUS', 'TASK_VERDICT', 'FAILING_VERDICTS',
    // compose-agent-prompt.mjs（2026-11-14）：提示词分层拼装。
    // 判定层全是纯函数，逐个进 PROBE_ARGS 实际调用；读盘的四个用不存在的路径
    // （那正是它们「什么都没有」的正常路径，顺带把空分支验一遍）。
    'promptHash', 'readPromptLedger', 'subagentFiles', 'readHeadRecords',
    // 数据：四层声明、义务三分类、必填元素清单 —— 不是函数，无需探针。
    'LAYERS', 'OBLIGATION_KINDS', 'REQUIRED_ELEMENTS', 'REQUIRED_PLACEHOLDERS',
    'FORBIDDEN_CONTEXT',
    // probe-evidence-sources.mjs（2026-11-14 扩宽判据的取证探针）：全部导出都是
    // 「读语料并汇总」，没有一个是能拿空参数安全调用的纯判据 —— sectionA/B/C/D
    // 都要遍历 400+ 份 transcript（其中 sectionD 还要读子 agent 正文，全量 6 GB）。
    // 让它进 checkImportable 会让结构门本身跑上几分钟，所以整体登记为免探针；
    // 正确性由报告 §7 的复算命令与 `--section X` 的单项运行保证。
    'SANDBOX_RE', 'SANDBOX_SLUG_RE', 'GATE_READ_VERBS', 'STRUCT_VERBS', 'CONTINUATION_RE',
    'defaultRoot', 'isSandbox', 'cwdOf', 'listMainTranscripts', 'subagentDirOf',
    'readTail', 'eachRecord', 'toolUsesOf', 'gateReadPaths', 'gateReadsFromToolUse',
    'pathKey', 'idNamespace', 'agentToolUseIds', 'agentIdsFromResults',
    'sectionA', 'sectionB', 'sectionC', 'sectionD', 'format', 'main',
  ]);
  const INTENTIONALLY_PROBED_FREE = new Set([
    'main', 'printPlain', 'copyToClipboard', 'startWatch', 'runTick',
    'runScan', 'dispatchCandidates', 'sendNotification', 'isNotificationAvailable',
    'NOTIFY_STATES', '__internals',
    // 这两个要读真实 transcript 目录（1GB），不能塞进结构门；由 CLI 自测覆盖。
    'parseTranscript', 'listTranscripts', 'loadCorpus',
    // measure-interventions.mjs：run 会全量扫 1.7GB transcript（实测 24s），不能进结构门；
    // 它的正确性由 measure-interventions.test.mjs 里的小目录用例覆盖。
    'run', 'COUNT_PER_STOP', 'INTERRUPT_MARKER',
    // 2026-11-16：正则与字符串常量，不是可调用函数 —— checkArgs 调不动它们。
    // 由 `stop-delta.test.mjs` 的「打断标记两种变体」「宿主合成前缀」两条用例覆盖。
    'SYNTHETIC_PREFIX', 'CONTINUATION', 'INTERRUPT_RE',
    // defaultClaimsScan 会 spawn verify-claims 子进程（实测 7.2s），不能塞进结构门；
    // 它有独立的 `--plain` 端到端覆盖（见 tui-redesign.test.mjs）。
    'defaultClaimsScan',
    // stop-signals.mjs 的常量与汇总扫描：scanAll 要读 186 个 transcript（1.4GB），
    // 同样不能塞进结构门；判据本身已逐条登记在 PROBE_ARGS 里。
    'TAIL_BYTES', 'HEAD_BYTES', 'LOOP_WINDOW', 'LOOP_REPEAT', 'CONTEXT_NEAR_FULL_RATIO',
    'scanAll', 'KINDS',
    // 2026-11-17 改名迁移：两个常量是**字符串映射**，不是可调用函数 —— checkArgs 调不动。
    // `resolveStateDir` 的行为由 watch/asked/notify/install-watcher 四份测试共同覆盖。
    'STATE_DIR_NAME', 'LEGACY_DIR_NAME',
    // measure-execution-phase.mjs：run 会全量扫 1.8GB transcript（实测 37s），
    // 不能进结构门；它的正确性由 measure-execution-phase.test.mjs 的小目录端到端用例覆盖。
    // 三个常量是数据（工具白名单 / 文本截断长度 / 空闲切分参数），不是函数。
    'run', 'summarize', 'formatReport', 'WRITE_TOOLS', 'READ_TOOLS', 'SHELL_TOOLS',
    'TEXT_CAP', 'IDLE_GAP_MS',
    // measure-ask-vs-tell.mjs：run 要全量扫 2.1 GB transcript（实测 72s），
    // 不能进结构门；正确性由 measure-ask-vs-tell.test.mjs 的小目录用例覆盖。
    // 这里只登记与上面重名的两个（summarize / formatReport 已在本表里）。
    // 它的其它常量已进注册表，不重复列。
    // build-payload.mjs：buildPayload 会 rmSync + writeFileSync（真写盘），不能进结构门；
    // 正确性由 build-payload.test.mjs 的生成 / 可复现 / 先清空 / 源坏一件不写 四条用例覆盖。
    'buildPayload',
  ]);
  // measure-execution-phase.mjs 的纯函数：全部已进 PROBE_ARGS 实际调用，
  // 这里显式登记，免得被上面的「未登记导出」提示刷屏。
  const EXEC_PHASE_FNS = [
    'normToolName', 'isWriteCall', 'isReadCall', 'optionLabels', 'questionsOf',
    'classifyAnswer', 'createAccumulator', 'absorbRecord', 'finalizeSession',
    'groupSessions', 'groupStats', 'oneShotRate', 'ranks', 'spearman', 'cliffsDelta',
    'mulberry32', 'permutationTest', 'fnv1a', 'recordSignature', 'analyzeFile',
    'spearmanPartial', 'matchedPairs',
  ];
  for (const k of EXEC_PHASE_FNS) REGISTERED.add(k);

  // measure-intervention-cost.mjs（2026-11-14 中断代价测量）：全部纯函数。
  // 探针参数取最小可构造输入（空串 / 空数组 / 空对象），要求「不抛」。
  // run / summarize / formatReport 要全量扫 1.9 GB，登记在 INTENTIONALLY_PROBED_FREE。
  const COST_FNS = [
    'normPath', 'isReworkDemand', 'undoEvents', 'commonPrefixLen', 'dedupeResumeForks',
    'readSessionDetail', 'sessionCost', 'undoAroundInterruptions', 'density',
    'groupRow', 'stratified', 'summarize', 'PRIMARY_TIER', 'REWORK_EXT_RE',
    'MIN_FRAGMENT_LEN', 'RESUME_PREFIX_RATIO', 'RESUME_MIN_COMMON',
    // 2026-11-14 加：返工需求率的两个随机窗口对照（审计期间新增，当时漏登记）。
    'redoShareAfterInterruptions', 'redoShareRandomWindows',
  ];
  for (const k of COST_FNS) REGISTERED.add(k);

  // measure-ask-vs-tell.mjs（2026-11-14 主指标重定义）：纯函数已全部进 PROBE_ARGS；
  // run / formatReport 要全量扫 2.1 GB，登记在 INTENTIONALLY_PROBED_FREE；
  // 常量与正则/冻结表是数据，不是函数。
  const ASK_VS_TELL_FNS = [
    'isAskCall', 'classifyExecHuman', 'isCostly', 'cwdOf', 'readAskTimeline',
    'sessionRow', 'density', 'countOf', 'perSessionDensity', 'cleanRate', 'groupRow',
    'densityDiffTest', 'cleanDiffTest', 'matchedOnWork', 'stratifyByWork',
    'summarize', 'formatReport',
    'ASK_TOOLS', 'COST_TIER', 'SECONDARY_TIERS', 'PER', 'MATCH_LOG_TOLERANCE',
    'PERM_ITERS', 'PERM_SEED', 'SANDBOX_RE', 'SANDBOX_SLUG_RE', 'TIER_FIELD',
    // isSandbox 与 observe-reality-check.mjs 里的同名导出重名：PROBE_ARGS 是按名字
    // 命中的扁平表，两个同名函数收到的参数完全不同（那边是 session 对象）。
    // 这里单独登记，不参加强制调用，避免用一个模块的形状去调另一个模块的函数。
    'isSandbox',
  ];
  for (const k of ASK_VS_TELL_FNS) REGISTERED.add(k);

  // pre-write-gate.mjs（2026-11-14 写前闸）：函数全部已进 PROBE_ARGS 实际调用，
  // 这里显式登记，免得被「未登记导出」提示刷屏。同名的六个导出
  // （decide / runHook / parseHookInput / readStdin / logPathFor / appendLog）
  // 也一并登记 —— 它们与 stop-verify-hook.mjs 重名，但探针是按名字命中所有模块的，
  // 所以上面那份停在那里的参数同样会把本文件的同名导出调一次。
  const PRE_WRITE_GATE_FNS = [
    'configOf', 'defaultConfig', 'markerPathFor', 'denialPathFor', 'pathKeyOf',
    'isGateOwnedPath', 'powershellWriteScan', 'writeIntentOf', 'readTranscriptReads',
    'readPathsOfToolUse', 'readPathsInTranscriptText', 'GATE_SHELL_READ_VERBS',
    'readMarker', 'writeMarker', 'markerValidity', 'reasonFor', 'bumpDenials', 'cli',
    // 2026-11-14 改动二：签名与密钥。ensureGateSecret 有写副作用，登记在 SANDBOX_ARGS。
    'markerSigOf', 'verifyMarkerSig', 'readGateSecret', 'ensureGateSecret', 'secretPathFor',
    'SECRET_REL', 'EDIT_SIDE_TOOLS',
    'decide', 'runHook', 'parseHookInput', 'readStdin', 'logPathFor', 'appendLog',
    'MARKER_REL', 'DENIAL_REL', 'MODES', 'BRAKES', 'DEFAULT_BUDGET_MS',
    'WRITE_TOOLS', 'SHELL_TOOLS', 'READ_TOOLS',
    // 2026-11-19 `ask.minQuestionsBeforeWrite`。三个函数已进 PROBE_ARGS 实际调用，
    // 这里显式登记免得被「未登记导出」刷屏。
    'readTranscriptActivity', 'minQuestionsBeforeWriteOf', 'reasonForQuestions', 'MAX_MIN_QUESTIONS',
    // 2026-11-19（`DF-038` 修复）：提问口径的唯一实现与回扫上限。两者都已进 PROBE_ARGS。
    'isAskToolName', 'DEFAULT_MAX_SCAN_BYTES',
  ];
  for (const k of PRE_WRITE_GATE_FNS) REGISTERED.add(k);

  // hook-dedupe.mjs（2026-11-18，`DF-029` 的幂等层）：三条会写盘的进 SANDBOX_ARGS
  // 真实调用一次（路径由 `_sandbox` 拼），其余是纯函数/常量。
  // 这一节必须存在：2026-11-18 之前 `checkUnregisteredExports` 自己因为
  // 「某个脚本 import 即打印 → JSON.parse 失败 → 静默 return」而**从来没跑过**，
  // 所以「未登记」这件事谁都看不见（见 `checkUnregisteredExports` 上方注释）。
  const HOOK_DEDUPE_FNS = [
    'claimKeyOf', 'claimPathFor', 'claimDirFor', 'dedupeRoot',
    'claimOnce', 'recordSkipped', 'sweepIfCrowded',
    'CLAIM_TTL_MS', 'SWEEP_AT', 'SKIPPED_FILE', 'DEDUPE_DIR_NAME',
  ];
  for (const k of HOOK_DEDUPE_FNS) REGISTERED.add(k);

  // make-social-preview.mjs（2026-11-18）：`renderPng` 已进 PROBE_ARGS 实际调用；
  // `main` 是 CLI 入口（写盘），由 make-social-preview.test.mjs 覆盖。
  for (const k of ['renderPng', 'main']) REGISTERED.add(k);

  // ── 同名但签名不同的导出：必须按模块分开探针 ─────────────────────────
  //
  // `PROBE_ARGS` 是一张**扁平**表，按名字命中所有模块。而这两个文件里
  // `runHook` / `decide` / `logPathFor` / `appendLog` / `readStdin` /
  // `parseHookInput` 同名但**签名不同**：
  //
  //   stop-verify-hook : runHook({ input, env })          —— 一个对象
  //   pre-write-gate   : runHook(input, { env, nowMs })   —— 两个位置参数
  //
  // 于是 stop hook 那份参数 `[{ input: {session_id:"probe",...} }]` 打到
  // `pre-write-gate.runHook` 上时，`input` 变成了 `{input:{...}}` ——
  // 它读不到 `cwd`，回落到 `process.cwd()`（= 仓库根），然后**真的往
  // 生产台账写一行** `sid=undefined / unparsable-input`。
  //
  // 2026-11-18 实测：这就是每次跑结构门 `pre-write-gate/<日期>.jsonl` +2 行的原因。
  // 只在探针全开时才出现（`DF-031` 把 66 条静默跳过的探针打开之后才暴露）——
  // 也就是说这个泄漏**一直被「不验证」掩盖着**。
  //
  // 修法：这几个名字**跳过强制调用**，由各自的专属探针验（见 `SANDBOX_ARGS`）。
  // 宁可少覆盖几个，也不要用 A 的形状去调 B —— 那产生的结论是假的。
  for (const k of CROSS_MODULE_SKIP) REGISTERED.add(k);

  // 2026-11-14 审计期间新加的三个探针脚本。它们是**一次性测量工具**，
  // 导出的是测量装置本身（读真实语料、算统计），不是被生产代码调用的纯函数。
  // 逐条登记避免刷屏；正确性由各自的报告里给出的复算命令覆盖。
  const AUDIT_PROBE_FNS = [
    // redteam-gate-evidence.mjs —— 读结果质量统计
    'readOutcomes', 'evidenceQuality', 'report',
    // redteam-gate-widening.mjs —— 逐会话消融与跨项目污染
    'gateReadsFixed', 'readPathsInText', 'tailText', 'evidenceSets',
    'isRealPathEvidence', 'subagentSet', 'predecessorCandidates', 'build',
    // probe-evidence-sources.mjs —— 证据来源四段探针
    'gateReadsFromToolUse', 'idNamespace', 'listMainTranscripts', 'subagentDirOf',
    'toolUsesOf', 'sectionA', 'sectionB', 'sectionC', 'sectionD',
  ];
  for (const k of AUDIT_PROBE_FNS) REGISTERED.add(k);

  // render-plan.mjs（2026-11-14 每轮开头一屏 plan）：渲染器的全部导出。
  // 它读 `tasks/runs/` 下的台账，测试用合成 graph + 注入 probe 覆盖（28 条），
  // 所以不塞进结构门的探针表；常量是数据（版本号 / 行数上限 / 行宽）。
  const RENDER_PLAN_FNS = [
    'PLAN_VERSION', 'MAX_LINES', 'ROW_WIDTH', 'VERIFIED_GLYPHS', 'ON_DEP_FAILED_MODES',
    'displayPath', 'findLatestRun', 'loadRun', 'formatPlan', 'buildPlan', 'renderPlan',
  ];
  for (const k of RENDER_PLAN_FNS) REGISTERED.add(k);

  // launch.mjs（2026-11-14 应用起宿主）：验收后补的三个导出。
  //   AUTH_RE / expectedAgents / maskDeep —— 它们**就是被测试直接 import 的**
  //   （2026-11-14 那条「负向测试没有牙」的教训：从源码正则提取被测物 = 自证，
  //   必须 import 真身，所以它们必须是导出）。
  const LAUNCH_FNS = ['AUTH_RE', 'expectedAgents', 'maskDeep', 'payloadInfo', 'verifyPluginRoot'];
  for (const k of LAUNCH_FNS) REGISTERED.add(k);

  // build-payload.mjs（2026-11-14 plugin 载荷生成）：纯函数已进 PROBE_ARGS 实际调用，
  // 这里显式登记，免得被「未登记导出」提示刷屏。
  // buildPayload 会**写盘**（rmSync + writeFileSync），main 是 CLI 入口 —— 两个都进
  // INTENTIONALLY_PROBED_FREE，由 build-payload.test.mjs 的 11 条生成/负向用例覆盖。
  // 常量是数据（目录名 / 文件名 / 版本号 / 帮助文本），不是函数。
  const BUILD_PAYLOAD_FNS = [
    'PAYLOAD_VERSION', 'GENERATOR', 'MANIFEST_FILE', 'PLUGIN_NAME', 'DEFAULT_OUT',
    'AGENTS_REL', 'SKILLS_REL', 'HELP',
    'defaultOutDir', 'summarizeSources', 'payloadDigest', 'pluginManifest',
    'pluginManifestBytes', 'planPayload', 'checkPayload', 'parseArgv',
  ];
  for (const k of BUILD_PAYLOAD_FNS) REGISTERED.add(k);

  // observe-reality-check.mjs（2026-11-14 写前闸的真实语料重放）：纯函数已进 PROBE_ARGS，
  // 这里显式登记免得被「未登记导出」提示刷屏。buildReport / main 要扫 2GB 语料，
  // 与 measure-* 系列同处置 —— 由测试里的小目录端到端用例覆盖。
  const OBSERVE_REALITY_FNS = [
    'listTranscripts', 'isSandbox', 'eachLineOffset', 'recordSignature', 'verbsOf',
    'analyzeOne', 'gateReadsOf', 'broadReadsOf', 'tailGateReads', 'gateReadPathsInText',
    'dedupeForks', 'distOf', 'structuralKind', 'verdict', 'main', 'buildReport',
    'GATE_READ_VERBS', 'STRUCT_VERBS', 'CONTENT_VERBS', 'STRUCT_TOOLS', 'HERE',
    'CONTINUATION_RE', 'ATTRIBUTION_CLASSES',
    'isContinuation', 'agentToolIdsBefore', 'subagentReadsByToolId', 'looseSubagentReads', 'attribute',
  ];
  for (const k of OBSERVE_REALITY_FNS) REGISTERED.add(k);

  // published-paths.mjs（`DF-039`：「可发布区零盘符」判据的唯一实现）。
  // 四个函数已进 PROBE_ARGS 实际调用（探针取一个不含任何路径的短串：必须安全返回
  // 空数组 / 原样字符串，不抛）。三个正则/表常量是**数据**，不是函数。
  // 2026-11-21 第二轮加了「无盘符前缀的本机标识符」判据（散列黑名单）：
  // `knownIdentifierKeyOf` / `findKnownIdentifiers` 进 PROBE_ARGS 实际调用，
  // `KNOWN_LOCAL_IDENTIFIERS` 是数据（而且**故意不可读回**，见该常量上方注释）。
  const PUBLISHED_PATHS_FNS = [
    'WIN_ABS_RE', 'POSIX_ABS_RE', 'PLACEHOLDER_LITERALS',
    'normalizePathHit', 'pathKeyOf', 'isPlaceholderPath',
    'findAbsolutePaths', 'publishedPathViolations',
    'KNOWN_LOCAL_IDENTIFIERS', 'knownIdentifierKeyOf', 'findKnownIdentifiers',
  ];
  for (const k of PUBLISHED_PATHS_FNS) REGISTERED.add(k);

  // link-check.mjs（`DF-040`：文档相对链接的唯一判据）。
  // 六条纯函数已进 PROBE_ARGS 实际调用；`markdownFiles` / `publishableFiles` /
  // `scanLinks` 要 spawn git 并遍历全仓（170 份 .md），**不能**进硬门 ——
  // 它们的正确性由 link-check.test.mjs 在临时目录里真的跑一遍覆盖。
  // `KIND_TEXT` 是数据（一张文案表），不是函数。
  const LINK_CHECK_FNS = [
    'KIND_TEXT',
    'stripCode', 'slugifyAnchor', 'anchorsOf', 'isExternalLink', 'linkOccurrences',
    'describeBroken', 'checkFileLinks', 'markdownFiles', 'publishableFiles', 'scanLinks',
  ];
  for (const k of LINK_CHECK_FNS) REGISTERED.add(k);

  // roles.mjs（2026-11-21，DF-044）：角色注册表 —— 「有哪些角色」的唯一实现。
  // 纯函数与读盘函数都进了 PROBE_ARGS 实际调用；这里显式登记以免被「未登记导出」刷屏。
  // `defaultRoles` 不参加探针：它按模块顶层标志缓存，探一次之后结构门再 import
  // 拿到的就是那份缓存 —— 用缓存去证明「它能跑」是自证。它由 roles.test.mjs 的
  // 「12 份 id 逐字相同」那条用例真实调用（那条必须拿到真注册表）。
  // 三个路径常量是数据，不是函数。
  const ROLES_FNS = [
    'AGENTS_DIR', 'DEFAULT_AGENT_PREFIX', 'REPO_ROOT',
    'defaultRoles', 'discoverRoles', 'parseFrontmatter', 'truthyFlag', 'readonlyOf',
    'idFromName', 'resolveRole', 'roleIndex', 'labelOf', 'nameOf', 'agentPrefixFrom', 'FORBIDDEN_CONTEXT',
    // 2026-11-21（D2 验证）：按根求值的四个。`rolesFor` / `capabilitiesFor` 各进
    // PROBE_ARGS 真调一次（`rolesFor` 喂 null = 「只认框架」，`capabilitiesFor` 同）；
    // `rolesDirFor` 是纯路径拼接；`sourceText` 吃一份最小的注册表对象。
    // 它们的存在理由见 `roles.mjs` 的 `rolesFor`：常量在模块加载时求值 = 只认框架角色。
    'rolesFor', 'capabilitiesFor', 'rolesDirFor', 'sourceText',
  ];
  for (const k of ROLES_FNS) REGISTERED.add(k);

  // compose-agent-prompt.mjs（2026-11-14 提示词分层拼装）：判定层纯函数已进 PROBE_ARGS
  // 实际调用，这里显式登记免得被「未登记导出」刷屏。main 是 CLI 入口，
  // 由 compose-agent-prompt.test.mjs 的端到端用例覆盖。
  const COMPOSE_PROMPT_FNS = [
    'PROMPT_LEDGER_VERSION', 'PROMPT_LEDGER_FILE',
    'parseFrontmatter', 'roleTools', 'extractCommands', 'classifyRequirement', 'requiredTools',
    'stopConditionProblem', 'checkPromptSpec', 'deriveInjected', 'fillDispatchTemplate',
    'composePrompt', 'normalizeForHash', 'promptHash', 'makePromptRow', 'readPromptLedger',
    'firstUserText', 'readHeadRecords', 'subagentFiles', 'verifyPrompts', 'main',
    'LAYERS', 'OBLIGATION_KINDS', 'REQUIRED_ELEMENTS', 'REQUIRED_PLACEHOLDERS', 'FORBIDDEN_CONTEXT',
  ];
  for (const k of COMPOSE_PROMPT_FNS) REGISTERED.add(k);

  // measure-gate-ceiling.mjs：纯函数已进 PROBE_ARGS 实际调用，这里显式登记免得被
  // 「未登记导出」刷屏。measure / main 要全量扫 2GB 语料（实测 120s），与 measure-*
  // 系列同处置 —— 由 measure-gate-ceiling.test.mjs 的小目录端到端用例覆盖。
  const GATE_CEILING_FNS = [
    'gateReadsFixedOf', 'readWindowText', 'windowReadPaths', 'subagentPathSet',
    'looseSubagentPathSet', 'upstreamOf', 'toolCallCount', 'evidenceOf', 'variantSets',
    'contentReads', 'alignWithBaseline', 'parserEquivalence', 'byToolCalls', 'byDate',
    'dropLargestProject', 'measure', 'main', 'BASE_THRESHOLD', 'BASELINE_SNAPSHOT',
  ];
  for (const k of GATE_CEILING_FNS) REGISTERED.add(k);

  // question-audit.mjs（2026-11-14 提问形态审计）：判据层纯函数已进 PROBE_ARGS 实际调用，
  // 这里显式登记免得被「未登记导出」刷屏。scanCorpus / cli 要读全量语料（实测 22s），
  // 与 measure-* 系列同处置 —— 由 question-audit.test.mjs 的小目录端到端用例覆盖。
  const QUESTION_AUDIT_FNS = [
    'CONFIG_FILE', 'ASK_MODES', 'AUTO_COMPLEX_FILES', 'AUTO_COMPLEX_TOOLCALLS', 'KNOWN_ROLES',
    'questionsOfAsk', 'normalizeText', 'judgeReadFirst', 'judgeSession', 'summarize',
    'docTokenOverlap', 'nearDuplicateQuestions', 'scanSession', 'validateConfig', 'loadConfig',
    'formatReport', 'parseArgs', 'defaultConfig', 'exitCodeFor',
    'BLOCKING_CODES', 'ADVISORY_CODES',
    'scanCorpus', 'cli',
  ];
  for (const k of QUESTION_AUDIT_FNS) REGISTERED.add(k);

  // question-form.mjs（2026-11-19 从 question-audit 搬出的两个判据）：两个纯函数，
  // 参数已进 PROBE_ARGS（`questionsOfAsk` / `normalizeText` 本来就是那张表里的名字，
  // 探针按名字命中所有模块，所以搬过来之后它们的探针自动生效）。
  // 搬家的原因（避免 `pre-write-gate → question-audit → observe-reality-check → pre-write-gate`
  // 的 TDZ 环）见该文件头。这里显式登记，免得被「未登记导出」刷屏。
  for (const k of ['questionsOfAsk', 'normalizeText']) REGISTERED.add(k);

  // probe-parser-divergence.mjs（2026-11-14 量化重放器与闸门的分叉）：纯函数进 PROBE_ARGS，
  // `probe` 要扫全量语料，与 measure-* 系列同处置 —— 由 probe-parser-divergence.test.mjs
  // 的小目录用例覆盖。
  const PROBE_DIVERGENCE_FNS = [
    'gatePathsOfText', 'windowTextOf', 'diffOf', 'attributeDivergence',
    'syntheticCases', 'probe', 'formatProbe', 'main',
  ];
  for (const k of PROBE_DIVERGENCE_FNS) REGISTERED.add(k);

  // project-root.mjs（2026-11-21，「两个根」拆分）：判定层全部纯函数，已进 PROBE_ARGS
  // 实际调用（喂空 env + 不可达 cwd，走到第 5 级 —— 「找不到就返回 null」是正常分支）。
  // 两个常量是数据（`LEVELS` / `PROJECT_MARKERS`），checkArgs 调不动，一并登记。
  // 正确性由 `project-root.test.mjs` 的 27 条用例覆盖，其中两条是端到端（真起子进程）。
  const PROJECT_ROOT_FNS = [
    'frameworkRoot', 'resolveProjectRoot', 'projectRoot', 'rootFromArgv', 'searchUp',
    'levelText', 'formatTried', 'readPathsConfig', 'runsDirInfo', 'runsDirFor', 'main',
    'LEVELS', 'PROJECT_MARKERS', 'DEFAULT_RUNS_REL', 'ROOT_ENV', 'RUNS_DIR_ENV',
  ];
  for (const k of PROJECT_ROOT_FNS) REGISTERED.add(k);

  // stop-verify-hook.mjs 的 `ledgerRoot`：`resolveStateDir` 的别名（同一份判据，不是第二个），
  // 已进 PROBE_ARGS 用空 env 真调一次。行为由 stop-verify-hook.test.mjs 的三条默认路径断言守。
  REGISTERED.add('ledgerRoot');

  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && !CLI_SCRIPTS.has(f));
  if (!files.length) return;

  // 一次性拿到所有文件的导出名：每个文件一个 import()，但只起一个 node 进程。
  const mods = files.map((f) => JSON.stringify('file:///' + join(dir, f).split(String.fromCharCode(92)).join('/')));
  const script =
    'Promise.all([' + mods.join(',') + '].map((u) => import(u).then((m) => Object.keys(m)).catch(() => [])))' +
    '.then((all) => console.log(JSON.stringify(all)))';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) {
    // **不许静默 return。** 2026-11-18 实测：`import()` 一个「模块顶层就执行并打印」的脚本
    // （当时是 `make-social-preview.mjs`，后来是 `measure-checklist-coverage.mjs`）会把
    // 中文打到这个子进程的 stdout 上，于是下面那句 `JSON.parse` 必然失败，
    // 原来的 `catch { return; }` 就把**整项检查**放弃了 —— 而它的输出与
    // 「全部导出都登记过」逐字相同。这正是 `DF-031` 那个缺陷的同一种形态：
    // 静默跳过看起来和通过一样。
    //
    // 现在的处置分两层：
    //   · 子进程非 0 退出 → **fail**（import 都炸了，这一项根本没有结论）；
    //   · 解析不出 JSON   → **fail** 并指名是哪个文件污染了 stdout（可修的那种）。
    fail('scripts/', `导出清单扫描的子进程以 ${r.status} 退出：${String(r.stderr || '').trim().split('\n')[0] || '无输出'}`);
    return;
  }
  let all;
  try {
    all = JSON.parse(String(r.stdout || '[]'));
  } catch {
    // 指名道姓：拿不到导出清单时，最可能的原因是某个模块 import 即执行。
    // 逐个 import 太慢（那是 40 个进程），所以只报现象 + 定位办法。
    fail('scripts/', '导出清单不是合法 JSON —— 说明某个非测试脚本在**模块顶层**就往 stdout 打印了'
      + '（import 即执行）。这类脚本必须加「我是不是被直接执行」的入口守卫，'
      + '否则每次跑本门都会把它们真的执行一遍（副作用 + 输出污染）。'
      + ` 实测 stdout 前 80 字：${JSON.stringify(String(r.stdout || '').slice(0, 80))}`);
    return;
  }
  all.forEach((exportsList, i) => {
    for (const k of exportsList) {
      if (REGISTERED.has(k) || INTENTIONALLY_PROBED_FREE.has(k) || k === 'default') continue;
      warn(rel(join(dir, files[i])), `导出 "${k}" 未登记 —— 它不会被 checkImportable 调用。若是纯函数，请加进参数表；若有副作用，请加进 INTENTIONALLY_PROBED_FREE`);
    }
  });
}

/** CHANGELOG 硬规则：docs/CHANGELOG.md 自己规定「任何代码/配置/文档的更改都必须记入」，
 *  但在 2026-10-31 之前**没有任何门检查它** —— 实测有 18+ 个提交没有条目。
 *  规则没人执行就不叫规则，叫愿望。
 *
 *  检查方式：找出「最后一个被 CHANGELOG 引用过的 commit」到 HEAD 之间的全部提交，
 *  若有提交改动了源码/规格却没在 CHANGELOG 里留下 hash，即为违规。
 *
 *  为什么用 hash 而不用日期或行数：hash 是唯一无歧义的锚点，且本文件已经要求
 *  「每条必须写出处——commit hash」。要求写 hash，就该能验证 hash 在不在。
 *
 *  豁免：纯 CHANGELOG 自身的提交、以及 docs/runs 下的运行台账。 */
function checkChangelog() {
  const f = join(ROOT, 'docs', 'CHANGELOG.md');
  if (!existsSync(f)) return;
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { return; }

  const git = (args) => {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout || '') : null;
  };

  const log = git(['log', '--format=%h%x09%s', '-60']);
  if (log === null) return; // 不是 git 仓库（如解压后的发布包），跳过

  // CHANGELOG 里出现过的 7-40 位 hex 都当作「已记录」
  const recorded = new Set([...text.matchAll(/\b([0-9a-f]{7,40})\b/g)].map((m) => m[1]));
  const isRecorded = (h) => {
    for (const r of recorded) if (h.startsWith(r) || r.startsWith(h)) return true;
    return false;
  };

  const commits = log.trim().split('\n').filter(Boolean).map((l) => {
    const [h, subject] = l.split('\t');
    return { h, subject: subject || '' };
  });

  // 一个提交不可能在自己的内容里写自己的 hash —— 这是结构性的，不是疏漏。
  //
  // 第一版用「豁免 HEAD」处理（SKIP_HEAD = 1），结果是：每提交一次，上一个提交就
  // 变成新的违规项，修它又要再提交一次，再产生新的违规项。**无限后退**，
  // 而且每次 commit 之后 `check-structure` 都红。这正是它真跑起来时暴露的。
  //
  // 现在的规则有两条，合起来才闭环：
  //   1. **边界**：只检查「最近一次修改本文件的提交」之后的提交。
  //      历史欠账不追溯（追也追不动），但新的改动跑不掉。
  //   2. **自文档豁免**：改动了 `docs/CHANGELOG.md` 本身的提交视为已记录。
  //      它写的条目就是记录，再要求它引用自己的 hash 是把记账当成了目的。
  //
  // 剩下的：既没动 CHANGELOG、又改了源码/规格、又没被任何 hash 引用 —— 那才是真欠账。
  const SOURCE_RE = /^(scripts\/|\.claude\/|docs\/|templates\/|rules\/|README\.md|CLAUDE\.md)/;
  const SKIP_RE = /^(tasks\/runs\/)/;

  let boundary = -1;
  for (let i = 0; i < commits.length; i++) {
    const files = git(['show', '--name-only', '--format=', commits[i].h]);
    if (files && files.trim().split('\n').includes('docs/CHANGELOG.md')) { boundary = i; break; }
  }
  if (boundary <= 0) return; // 最近一次提交就改了 CHANGELOG，或找不到边界：没有可检查范围

  const missing = [];
  for (let i = 0; i < boundary; i++) {
    const { h, subject } = commits[i];
    const files = git(['show', '--name-only', '--format=', h]);
    if (files === null) continue;
    const touched = files.trim().split('\n').filter(Boolean)
      .filter((p) => SOURCE_RE.test(p) && !SKIP_RE.test(p));
    if (!touched.length) continue;
    missing.push(`${h} ${subject.slice(0, 50)}`);
  }

  if (missing.length) {
    fail('docs/CHANGELOG.md',
      `${missing.length} 个提交改动了源码/规格但没有 CHANGELOG 条目（本文件自己规定的硬规则）：\n      ` +
      missing.slice(0, 8).join('\n      ') +
      (missing.length > 8 ? `\n      …还有 ${missing.length - 8} 个` : ''));
  }
}

/** 闸门门禁：把 Stop hook 的默认值改成 `block`，必须同时具备用户叫停路径。
 *
 *  **为什么这条必须是硬门而不是注释**：一个默认开启的强拦如果不给出叫停路径，
 *  就是把用户锁在自己的会话里。真实事故（issue #108493）：用户说
 *  「stop everything, you are done」之后，会话又起了子 agent 和一次外部 run 并截图。
 *
 *  设计（`docs/` 里「停要带 delta」§4）要求三层：
 *    L1 文件闸   `isPaused()` + `pausePathFor()` —— 与上下文无关的一层
 *    L2 用户发话 `userIntervenedSince()` —— 用户已经说话了（事故里正是这种）
 *    L3 预算耗尽 `allowed-budget-exhausted` —— 闸门用完配额这件事必须可见
 *
 *  检查只在 `modeOf()` 的默认返回变成 `'block'` 时生效，所以现在是**空转**的 ——
 *  那是对的：门禁的价值在于「有人想开门时它拦得住」，不在于现在报什么。
 *  硬门里已经有同类先例（`checkLauncherPlacement` / `checkInboxWiring`）。 */
function checkStopHookKillSwitch() {
  const file = join(ROOT, 'scripts', 'stop-verify-hook.mjs');
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { return; }

  // 取 `modeOf()` 的函数体，判它的默认分支返回什么。
  const m = src.match(/export function modeOf\([\s\S]*?\n\}/);
  if (!m) return;
  const body = m[0];
  // `return 'block'` 出现在默认路径上（而不是只在某个 if 分支里）就算「默认开」。
  // 判据刻意保守：只在**找不到任何 `return 'off'`** 时才认为默认是 block。
  const defaultsToBlock = !/return\s+'off'/.test(body) && /return\s+'block'/.test(body);
  if (!defaultsToBlock) return;

  // **判据必须是「可调用」，不是「字符串出现过」。**
  // 第一版只查 `src.includes('userIntervenedSince')`，于是把 `export function` 改名成
  // `function` 之后门禁照样通过 —— 实现还在文件里，只是再也调不到。这正是本仓反复
  // 批判的那类判据（「看见 ≠ 判红」）。
  //
  // 现在查两种形态：`export function X(` / `export const X =`（可被外部调用），
  // 以及 `runHook` 里真的有对应分支（`isPaused(env)` / `userIntervenedSince(` 的调用点）。
  const hasExport = (name) => new RegExp(
    `export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(|export\\s+const\\s+${name}\\s*=`,
  ).test(src);
  // 调用点判据不能拿 `src.includes('X(')` —— 它会被**函数定义那一行本身**命中
  // （`export function X(` 里也有 `X(`）。第一版正是这么漏掉的：把 `runHook` 里的
  // 调用删干净，门禁照样通过。所以逐行看，且跳过声明行。
  const hasCall = (name) => src.split('\n').some((line) => {
    if (!line.includes(`${name}(`)) return false;
    if (/^\s*(export\s+)?(async\s+)?function\s+/.test(line)) return false; // 定义行
    if (/^\s*export\s+const\s+/.test(line)) return false;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return false;                    // 注释行
    return true;
  });

  const required = [
    { name: 'isPaused', call: 'isPaused', label: 'L1 文件闸（`isPaused()` 且真被调用）' },
    { name: 'pausePathFor', call: 'pausePathFor', label: 'L1 闸门文件路径（可调用）' },
    // `DF-041`：叫停路径必须是一**族**而不是一个。判据是「有可调用的导出 + 有调用点」——
    // 退回硬编码单个路径的形态会让 `pausePathsFor` 连同旧目录的兼容一起消失，
    // 而那正是「闸关不掉」的成因。
    { name: 'pausePathsFor', call: 'pausePathsFor', label: 'L1 叫停路径族（`pausePathsFor()` 且真被调用）' },
    { name: 'pausedPathOf', call: 'pausedPathOf', label: 'L1 命中路径（`pausedPathOf()` 且真被调用 —— 可观测性）' },
    { name: 'userIntervenedSince', call: 'userIntervenedSince', label: 'L2 用户发话（`userIntervenedSince()` 且真被调用）' },
  ];
  const missing = [];
  for (const r of required) {
    if (!hasExport(r.name)) { missing.push(`${r.label} —— 没有可调用的导出`); continue; }
    if (!hasCall(r.call)) missing.push(`${r.label} —— 导出了但没有调用点`);
  }
  // 两个 outcome 标记与预算耗尽标记：它们是**可见性**，只需要出现。
  for (const [needle, label] of [
    ['allowed-user-paused', 'L1 的 outcome 标记'],
    ['allowed-user-intervened', 'L2 的 outcome 标记'],
    ['allowed-budget-exhausted', 'L3 预算耗尽可见'],
  ]) {
    if (!src.includes(needle)) missing.push(label);
  }
  if (missing.length) {
    fail('scripts/stop-verify-hook.mjs',
      `modeOf() 默认返回 'block'（闸门默认开启），但缺少用户叫停路径：\n      `
      + missing.join('\n      ')
      + '\n      一个默认开启的强拦不给叫停路径 = 把用户锁在会话里。见本函数上方注释。');
  }
}

/** 台账格式门：两本台账是「不自行修」这条纪律的载体。
 *  纪律靠格式维持，格式坏了纪律就悄悄消失 —— 例如把所有条目都标成 [fixed]，
 *  台账看起来干净，实际是「没人往里面加」。2026-10-31 实测：14 条里 14 条 fixed，
 *  一个开放项都没有，而同一时期明确发现了 5 个未修问题。
 *
 *  这里不检查「应该有多少 open」（那是判断，不是事实），只检查**格式合法性**：
 *  状态必须在枚举内、每个条目必须有发现位置、ledger 不能全是 fixed 而文件里还有 open 字样。 */
function checkLedger() {
  const ENUM = new Set(['open', 'triaged', 'scheduled', 'fixed', 'wontfix']);

  const df = join(ROOT, 'tasks', 'dev-findings.md');
  if (existsSync(df)) {
    let text;
    try { text = readFileSync(df, 'utf8'); } catch { text = ''; }
    // 标题里的状态必须与正文 `**状态**：xxx` 一致。
    // 2026-10-31 实测：DF-020 标题写 [open]、正文写 fixed，两个地方对不上，
    // 而台账是「还有多少债」的唯一来源。不一致的台账比没有台账更坏。
    for (const b of text.split(/^### /m).slice(1)) {
      const head = b.match(/^(DF-\d{3}) \[([a-z]+)\]/);
      if (!head) continue;
      const body = b.match(/\*\*状态\*\*[：:]\s*([a-z]+)/);
      if (!body) continue;
      if (body[1] !== head[2]) {
        fail('tasks/dev-findings.md', `${head[1]} 标题写 [${head[2]}]，正文写 ${body[1]} —— 状态不一致`);
      }
    }

    const entries = [...text.matchAll(/^### (DF-\d{3}) \[([a-z]+)\]/gm)];
    const real = entries.filter(([, , st]) => ENUM.has(st));
    const bad = entries.filter(([, , st]) => !ENUM.has(st));
    for (const [, id, st] of bad) {
      fail('tasks/dev-findings.md', `${id} 的状态 "${st}" 不在枚举内（${[...ENUM].join(' / ')}）`);
    }
    if (!real.length) {
      warn('tasks/dev-findings.md', '没有识别到任何 DF-xxx 条目 —— 台账可能是空的，或格式变了');
    } else {
      const open = real.filter(([, , st]) => st === 'open' || st === 'triaged' || st === 'scheduled').length;
      // 只提示，不阻塞：全 fixed 可能是真的都修完了。但值得每次看见，因为更常见的是没人往里加。
      if (open === 0) {
        warn('tasks/dev-findings.md', `${real.length} 条全部已收口，0 个开放项 —— 确认这是事实，而不是没人登记`);
      }
    }
  }

  const ad = join(ROOT, 'tasks', 'accepted-deviations.md');
  if (existsSync(ad)) {
    let text;
    try { text = readFileSync(ad, 'utf8'); } catch { text = ''; }
    // 每条已知偏差必须写明「为什么不修」，否则它只是一条待办
    const blocks = text.split(/^### /m).slice(1);
    for (const b of blocks) {
      const id = (b.match(/^([\w-]+)/) || [])[1] || '(无编号)';
      if (!/为什么|理由|代价/.test(b)) {
        fail('tasks/accepted-deviations.md', `${id} 没有写明不修的理由 —— 没写理由的偏差就是一条待办`);
      }
    }
  }
}

/** DF-022：启动器绝不能落在数据目录里。
 *
 *  那是真实发生过的事故：start-watch.vbs 住在 %LOCALAPPDATA%\Overwatch\ 里，
 *  而那个目录正是它要保护的。一次整目录删除把启动器和数据一起删掉，
 *  监控系统就此起不来——数据能重新积累，起不来则永远没有积累的机会。
 *
 *  这里把位置关系变成可执行的检查，而不是靠安装文档里的一句话。 */
function checkLauncherPlacement() {
  const installDir = join(ROOT, 'scripts', 'install');
  const tpl = join(installDir, 'start-watch.vbs.template');
  const out = join(installDir, 'start-watch.vbs');
  if (!existsSync(tpl)) {
    fail('scripts/install/start-watch.vbs.template', '缺少启动器模板——安装器将无物可渲染');
    return;
  }
  let raw;
  try { raw = readFileSync(tpl, 'utf8'); } catch (e) {
    fail('scripts/install/start-watch.vbs.template', `读不了模板：${e.message}`);
    return;
  }
  for (const ph of ['__REPO__', '__STATE_DIR__']) {
    if (!raw.includes(ph)) {
      fail('scripts/install/start-watch.vbs.template', `模板缺少占位符 ${ph}`);
    }
  }
  // 模板必须纯 ASCII：VBScript 按 ANSI 读，非 ASCII 会截断字符串字面量
  const bad = [...new Set([...raw].filter((ch) => ch.charCodeAt(0) > 127))];
  if (bad.length) {
    fail('scripts/install/start-watch.vbs.template',
      `模板含非 ASCII 字符 ${JSON.stringify(bad.join(''))}——VBScript 会误读并截断字符串`);
  }
  // 若产物已生成，它必须在仓库内（即不在数据目录）
  if (existsSync(out)) {
    const rel = relative(ROOT, out);
    if (rel.startsWith('..')) {
      fail(rel, '启动器产物落在仓库外——它必须与数据目录分离');
    }
  }
}

/** DF-015：监控与调度必须保持连通。
 *
 *  两半曾经彻底断开：`watch.mjs` 后台发现 WAITING 并发通知，而 12 个 agent 定义里
 *  零个引用它，SKILL.md 也只调 `scan-sessions.mjs`。主线程永远不知道后台看见过什么，
 *  两边各自重扫，既慢又不一致。
 *
 *  修法是「一份数据两个消费者」：watch 把发现写进 `state.notified`，
 *  调度侧用 `--inbox` 读同一份。这条检查保证**接口不会再次悄悄断掉**——
 *  文档写了但没人调用，和没写是一样的。 */
function checkInboxWiring() {
  const skill = join(ROOT, '.claude', 'skills', 'oversight', 'SKILL.md');
  if (existsSync(skill)) {
    let t = '';
    try { t = readFileSync(skill, 'utf8'); } catch { /* ignore */ }
    if (!t.includes('asked.mjs')) {
      fail('.claude/skills/oversight/SKILL.md',
        '调度入口没有引用 asked.mjs —— 宿主不报的「问了没答」会话会被完全漏掉');
    }
    if (!t.includes('validate-run.mjs')) {
      fail('.claude/skills/oversight/SKILL.md',
        '规划阶段没有引用 validate-run.mjs —— planner 的产物没人校验（硬约束 4/8）');
    }
    if (!t.includes('--health')) {
      fail('.claude/skills/oversight/SKILL.md',
        '调度入口没有引用 `watch.mjs --health` —— 无法区分「进程死了」和「进程卡住了」（DF-023）');
    }
    if (!t.includes('--inbox')) {
      fail('.claude/skills/oversight/SKILL.md',
        '调度入口没有引用 `watch.mjs --inbox` —— 后台发现又接不上了（DF-015）');
    }
  }
  // 至少一个 agent 必须知道收件箱存在，否则派出去的 agent 会各自重扫。
  const agentDir = join(ROOT, '.claude', 'agents');
  if (existsSync(agentDir)) {
    const files = readdirSync(agentDir).filter((f) => f.endsWith('.md'));
    const refs = files.filter((f) => {
      try { return readFileSync(join(agentDir, f), 'utf8').includes('--inbox'); } catch { return false; }
    });
    if (files.length && !refs.length) {
      // 数字**不写死**：`12 个角色定义` 是收敛前的快照，加一个角色它就变成假话，
      // 而它是**报错文案里**的一句 —— 假话报错比不报还糟（读者会去数，然后不再相信这个门）。
      // 实际个数从刚数出来的 `files` 取。
      fail('.claude/agents/', `${files.length} 个角色定义里没有一个引用 --inbox —— 监控与调度脱节（DF-015）`);
    }
  }
  // 脚本侧必须真的实现了这个命令
  const w = join(ROOT, 'scripts', 'watch.mjs');
  if (existsSync(w)) {
    let t = '';
    try { t = readFileSync(w, 'utf8'); } catch { /* ignore */ }
    if (!t.includes("flags.has('--health')")) {
      fail('scripts/watch.mjs', '脚本没有实现 --health，但文档在引用它');
    }
    if (!t.includes("flags.has('--inbox')")) {
      fail('scripts/watch.mjs', '脚本没有实现 --inbox，但文档在引用它');
    }
  }
}

/** DF-042：SKILL.md 必须引用 `compose-agent-prompt`。
 *
 *  与 `checkInboxWiring()` 同一个模式，理由也相同：`compose-agent-prompt.mjs` 的
 *  `FORBIDDEN_CONTEXT`（锐评不得拿到执行者的自我评价）与 `REQUIRED_ELEMENTS`
 *  都写好了、也测过了，但 2026-11-21 实测它在 `.claude/` / `templates/` / `docs/`
 *  里**零引用**，且 CLI 两处硬传 `context: {}`——于是那条检查在真实调用中恒真。
 *  「定义里写得再对，没人调用等于不存在」（DF-015 的原话）。
 *
 *  守三件事，缺一件这条链就是断的：
 *    1. `.claude/skills/oversight/SKILL.md` 的 Phase B 提到 `compose-agent-prompt`
 *    2. 它提到 `--context-from`（否则「补充上下文」这条路又缩回「谁都不许给」）
 *    3. 脚本侧真的实现了这个参数（文档承诺不能跑在代码前面）
 *
 *  **不检查 `--gate` / `--stop`**：那两个在 SKILL.md 里是示例的一部分，
 *  而 Gate 判断「有没有写进示例」对「参数存不存在」没有增量信息——
 *  `checkCapabilities()` 已经在守「文档里的参数必须被脚本支持」。 */
function checkPromptWiring() {
  const skill = join(ROOT, '.claude', 'skills', 'oversight', 'SKILL.md');
  if (existsSync(skill)) {
    let t = '';
    try { t = readFileSync(skill, 'utf8'); } catch { /* ignore */ }
    if (!t.includes('compose-agent-prompt')) {
      fail('.claude/skills/oversight/SKILL.md',
        '派发阶段没有引用 compose-agent-prompt.mjs —— 提示词又回到手填，'
        + 'FORBIDDEN_CONTEXT 与 REQUIRED_ELEMENTS 两项检查在真实调用中永不生效（DF-042）');
    }
    if (!t.includes('--context-from')) {
      fail('.claude/skills/oversight/SKILL.md',
        '没有引用 --context-from —— 「给某个角色补材料」只剩 CLI 私下的路，'
        + '而 FORBIDDEN_CONTEXT 只有这一条入口会被喂到（DF-042）');
    }
  }
  // 文档承诺必须落在代码上：SKILL.md 说支持，脚本事得真有
  const c = join(ROOT, 'scripts', 'compose-agent-prompt.mjs');
  if (existsSync(c)) {
    let t = '';
    try { t = readFileSync(c, 'utf8'); } catch { /* ignore */ }
    if (!t.includes("args['context-from']")) {
      fail('scripts/compose-agent-prompt.mjs',
        'SKILL.md 在教人用 --context-from，但脚本没有实现它');
    }
  }
}

/** DF-016：设计文档必须标明「未实现」，且索引必须覆盖每一份。
 *
 *  970 行设计文档描述的能力一行代码都没有，而在此之前**没有任何入口指向它们**——
 *  读者只知道仓库里有这个目录，不知道里面是什么。
 *
 *  这里守住三件事：
 *    1. design/README.md 存在（索引本身不能没有）
 *    2. design/ 下每一份 .md 都在索引里被提到（新增文档不能绕过索引）
 *    3. 索引里必须出现「未实现」字样（不能哪天被悄悄改成「部分实现」）
 */
function checkDesignIndex() {
  const dir = join(ROOT, 'docs', 'design');
  if (!existsSync(dir)) return;
  const index = join(dir, 'README.md');
  if (!existsSync(index)) {
    fail('docs/design/README.md', '缺少设计存档索引——读者会以为这些文档描述的是已实现能力');
    return;
  }
  let idx = '';
  try { idx = readFileSync(index, 'utf8'); } catch { /* ignore */ }
  if (!/未实现/.test(idx)) {
    fail('docs/design/README.md', '索引必须明确写出这些文档描述的能力「未实现」');
  }
  const docs = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  for (const f of docs) {
    if (!idx.includes(f)) {
      fail('docs/design/README.md', `${f} 没有被索引提到——新增设计文档必须登记状态`);
    }
  }
  // 入口必须指向索引：否则还是没人会点进去
  for (const entry of ['README.md', 'CLAUDE.md']) {
    const p = join(ROOT, entry);
    if (!existsSync(p)) continue;
    let t = '';
    try { t = readFileSync(p, 'utf8'); } catch { /* ignore */ }
    if (!t.includes('docs/design/README.md')) {
      fail(entry, '没有指向 docs/design/README.md —— 读者找不到设计文档的状态说明');
    }
  }
}

/** 定义了但从不派发的 agent = 死代码。
 *
 *  2026-11-01 实测：`oversight-probe` 的角色定义存在、触发条件还专门改过，
 *  但 SKILL.md **从不派它**——它的触发条件永远不会生效。
 *  定义里写得再对，没人调用就等于不存在。
 *
 *  检查：agents/ 下每个角色，至少要在 SKILL.md 里被提到一次。
 *  豁免：明确标注「由其他 agent 派生」的角色（目前没有，但留出口）。 */
function checkAgentReachability() {
  const agentDir = join(ROOT, '.claude', 'agents');
  const skill = join(ROOT, '.claude', 'skills', 'oversight', 'SKILL.md');
  if (!existsSync(agentDir) || !existsSync(skill)) return;
  let sk = '';
  try { sk = readFileSync(skill, 'utf8'); } catch { return; }
  const files = readdirSync(agentDir).filter((f) => f.endsWith('.md'));
  const orphans = [];
  for (const f of files) {
    const name = f.replace(/\.md$/, '');
    let body = '';
    try { body = readFileSync(join(agentDir, f), 'utf8'); } catch { continue; }
    // 允许角色自己在 frontmatter 里声明「不由 SKILL 直接派发」
    if (/dispatched-by:\s*other/.test(body)) continue;
    if (!sk.includes(name)) orphans.push(name);
  }
  if (orphans.length) {
    fail('.claude/skills/oversight/SKILL.md',
      `这些角色定义了却从不被派发：${orphans.join(', ')} —— 定义里写得再对，没人调用等于不存在`);
  }
}

// ── 检查 11：文档引用的路径必须存在 ────────────────────────────────────

/** 「被文档引用的文件不存在」是同一类缺陷的反复复发：`dispatch-contract.md` 让所有
 *  Agent 去读 `templates/baseline.md`，而那个文件从来没被创建过；设计稿里更是列了
 *  一堆 `scripts/org.mjs` 这样的文件名，读者无法分辨「计划中的」和「已有的」。
 *
 *  只查**活文档**（README / CLAUDE / GUIDE / 现行 spec / adr / 两份索引）。历史报告与
 *  CHANGELOG 是事实记录，里面的旧路径不该被改写，也不该被这道门拦。
 *
 *  计划中的路径必须**在同一行**标 `待建` / `未实现` / `不实现` 之类。
 *  这个豁免不是后门：它逼作者在写下路径的当场就说清「这东西还不存在」，
 *  而不是让读者自己去 `ls` 验证。 */
const LIVING_DOCS = [
  'README.md',
  'CLAUDE.md',
  'docs/README.md',
  'docs/GUIDE.md',
  'docs/CAPABILITIES.md',
  'docs/design/README.md',
  'docs/research/README.md',
  'docs/spec/state-model.md',
  'docs/spec/dispatch-contract.md',
  'docs/spec/evidence-discipline.md',
  'docs/spec/relay-protocol.md',
  'docs/spec/output-format.md',
  'docs/spec/tui-visual.md',
  'docs/adr/0001-config-only.md',
  'docs/adr/0002-honest-degradation.md',
];

/** 允许出现「尚不存在」路径的行标记。命中即跳过。 */
const PLANNED_MARK = /待建|未实现|不实现|实现时|计划新增|零行实现|尚未创建/;

/** `scripts/x.mjs` / `templates/x.md` / `.claude/...` 这类仓库相对路径。 */
const DOC_PATH_RE = /(?:^|[\s`(+'"|])((?:scripts|templates|tasks|\.claude|docs)\/[A-Za-z0-9_./-]+\.(?:mjs|md|json|ps1|vbs|template|yml))/g;

function checkDocReferences() {
  for (const relPath of LIVING_DOCS) {
    const p = join(ROOT, relPath);
    if (!existsSync(p)) continue;
    let text = '';
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      if (PLANNED_MARK.test(line)) return;
      for (const m of line.matchAll(DOC_PATH_RE)) {
        const target = m[1];
        // 模板占位符与省略号是示意，不是路径
        if (/[*<>]|\.\.\.|NNN|xxx|YYYY/.test(target)) continue;
        // 本机私有路径被 gitignore，**在干净 clone 上必然不存在**。
        // 文档里提到它们是在说「这个文件不在仓里」，不是在引用一个该存在的文件。
        // 不加这条豁免，硬门就只有「作者本机」一个环境是绿的 —— 实测干净 clone
        // 上必红 3 条，CI 从首次提交起连续失败 9 次而无人察觉。
        if (PRIVATE_PATHS.some((pp) => target === pp || target.startsWith(pp + '/'))) continue;
        if (!existsSync(join(ROOT, target))) {
          fail(relPath, `第 ${i + 1} 行引用的文件不存在：${target}`
            + '（若是有意保留的计划，请在该行标注「待建」/「未实现」）');
        }
      }
    });
  }
}

// ── 检查 12：文档里写的命令必须真的能跑 ────────────────────────────────

/** `node scripts/xxx.mjs --flag` 里的脚本可能存在、但 `--flag` 不存在。
 *  这种错误比死链更坏：读者会把它当命令敲，然后得到「未知参数」。
 *
 *  这里只做两件零成本的事：脚本文件存在、每个 `--flag` 在该脚本源码里出现过。
 *  **不执行命令**——`scan-sessions.mjs --help` 会真的开扫（实测 78 秒），
 *  `verify-bugfix-negatives.mjs` 会改写源码。把「跑一遍」放进硬门是灾难。 */
function checkDocCommands() {
  for (const relPath of LIVING_DOCS) {
    const p = join(ROOT, relPath);
    if (!existsSync(p)) continue;
    let text = '';
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      if (PLANNED_MARK.test(line)) return;
      for (const m of line.matchAll(/node\s+(scripts\/[A-Za-z0-9_.-]+\.mjs)([^\n`|)]*)/g)) {
        const script = m[1];
        if (!existsSync(join(ROOT, script))) {
          fail(relPath, `第 ${i + 1} 行命令引用了不存在的脚本：${script}`);
          continue;
        }
        let src = '';
        try { src = readFileSync(join(ROOT, script), 'utf8'); } catch { continue; }
        for (const f of new Set([...m[2].matchAll(/(--[a-z][a-z0-9-]*)/g)].map((x) => x[1]))) {
          if (!src.includes(f)) {
            fail(relPath, `第 ${i + 1} 行用了 ${script} 不支持的参数 ${f}`);
          }
        }
      }
    });
  }
}

// ── 检查 13：文档写死的常量值必须与源码一致 ────────────────────────────

/** 这是 `checkTestCount()` 的同类推广：数字只要靠手写就会漂。
 *
 *  只查**显式对照**形态 `` `MAX_SUBAGENTS = 100` ``——那种写法是在断言
 *  「这个常量等于这个值」，一旦源码改了它就是一句假话。精确、零误报。
 *
 *  **不查散文里的数字**（「上限 100」）：那种句子要判断它指的是哪个常量，
 *  语义歧义导致的误报会让人把整道门关掉，得不偿失。 */
function checkDocConstants() {
  const consts = new Map();
  const dir = join(ROOT, 'scripts');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs') && !x.endsWith('.test.mjs'))) {
    let t = '';
    try { t = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const m of t.matchAll(/^const ([A-Z][A-Z0-9_]{2,}) = (\d[\d_]*)(?:;|\s*\/\/|\s*$)/gm)) {
      consts.set(m[1], { value: Number(m[2].replace(/_/g, '')), file: f });
    }
  }
  if (!consts.size) return;

  for (const relPath of LIVING_DOCS) {
    const p = join(ROOT, relPath);
    if (!existsSync(p)) continue;
    let text = '';
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/`([A-Z][A-Z0-9_]{2,}) = (\d[\d_]*)`/g)) {
        const c = consts.get(m[1]);
        if (!c) continue;
        const claimed = Number(m[2].replace(/_/g, ''));
        if (claimed !== c.value) {
          fail(relPath, `第 ${i + 1} 行写 ${m[1]} = ${claimed}，`
            + `而 scripts/${c.file} 里是 ${c.value}`);
        }
      }
    });
  }
}

// ── 检查 14：研究索引必须覆盖每一份报告 ────────────────────────────────

/** 与 `checkDesignIndex()` 同形，理由也一样：62 份研究报告里只要有几份没进索引，
 *  它们就等于不存在——没人会逐份点开一个没有目录的文件夹。
 *
 *  另外强制索引保留**状态标记**（有效 / 部分失效 / 已推翻 / 未验证）。
 *  一份没有状态的研究报告不是结论，是原材料；索引若退化成纯文件列表，
 *  「已推翻的结论仍被引用」这件事就会重新发生。 */
function checkResearchIndex() {
  const dir = join(ROOT, 'docs', 'research');
  if (!existsSync(dir)) return;
  const index = join(dir, 'README.md');
  if (!existsSync(index)) {
    fail('docs/research/README.md', '缺少研究索引——读者无法分辨哪些结论已被推翻');
    return;
  }
  let idx = '';
  try { idx = readFileSync(index, 'utf8'); } catch { /* ignore */ }
  for (const marker of ['有效', '已推翻', '未验证']) {
    if (!idx.includes(marker)) {
      fail('docs/research/README.md', `索引缺少状态标记「${marker}」——没有状态的研究报告等于没有结论`);
    }
  }
  const docs = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  const missing = docs.filter((f) => !idx.includes(f));
  if (missing.length) {
    fail('docs/research/README.md', `这些报告没有登记（新增报告必须写明状态与依据）：${missing.join(', ')}`);
  }
}

// ── 检查 15：能力清单里的每条命令必须可执行 ────────────────────────────

/** README 说「能做什么」是靠人相信的。`docs/CAPABILITIES.md` 把每条能力绑到
 *  **一条可运行的命令**上，这道门只保证那些命令的脚本与参数真实存在。
 *
 *  它不能证明「命令输出能支持这句声称」——那需要人读。但它能挡住最坏的一种：
 *  某条能力对应的脚本已经被删/改名，而 README 还在承诺。
 *
 *  同时要求 README 指向这份清单。理由同 design 索引：没有入口的清单等于没有。 */
function checkCapabilities() {
  const doc = join(ROOT, 'docs', 'CAPABILITIES.md');
  if (!existsSync(doc)) {
    fail('docs/CAPABILITIES.md', '缺少能力清单——README 的能力声称将无法被核对');
    return;
  }
  let text = '';
  try { text = readFileSync(doc, 'utf8'); } catch { return; }

  let rows = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cmd = line.match(/`(node scripts\/[A-Za-z0-9_.-]+\.mjs[^`]*)`/);
    if (!cmd) continue;
    rows++;
    const m = cmd[1].match(/node\s+(scripts\/[A-Za-z0-9_.-]+\.mjs)([^\n`|)]*)/);
    if (!m) continue;
    if (!existsSync(join(ROOT, m[1]))) {
      fail('docs/CAPABILITIES.md', `能力清单引用了不存在的脚本：${m[1]}`);
      continue;
    }
    let src = '';
    try { src = readFileSync(join(ROOT, m[1]), 'utf8'); } catch { continue; }
    for (const f of new Set([...m[2].matchAll(/(--[a-z][a-z0-9-]*)/g)].map((x) => x[1]))) {
      if (!src.includes(f)) fail('docs/CAPABILITIES.md', `${m[1]} 不支持参数 ${f}`);
    }
  }
  if (!rows) {
    fail('docs/CAPABILITIES.md', '能力清单里没有任何「能力 → 命令」行，这份文件退化成了一篇文章');
  }

  // 入口必须可达
  const readme = join(ROOT, 'README.md');
  if (existsSync(readme)) {
    let r = '';
    try { r = readFileSync(readme, 'utf8'); } catch { /* ignore */ }
    if (!r.includes('docs/CAPABILITIES.md')) {
      fail('README.md', '没有指向 docs/CAPABILITIES.md —— 读者无法核对「能做什么」');
    }
  }
}

// ── 运行 ──────────────────────────────────────────────────────────────

console.log('check-structure · 仓库结构硬门\n');

checkAbsolutePaths();
checkPrivatePaths();
checkGitignoreSanity();
checkAgents();
checkEmptyDirs();
checkCapabilityDisclosure();
checkTestCount();
checkSyntax();
checkImportable();
checkUnregisteredExports();
checkLinks();
checkChangelog();
checkStopHookKillSwitch();
checkLedger();
checkLauncherPlacement();
checkInboxWiring();
checkPromptWiring();
checkDesignIndex();
checkAgentReachability();
checkDocReferences();
checkDocCommands();
checkDocConstants();
checkResearchIndex();
checkCapabilities();

if (violations.length) {
  console.log(`✗ ${violations.length} 项违规：\n`);
  for (const v of violations) console.log(`  [${v.file}] ${v.msg}`);
} else {
  console.log('✓ 结构检查全部通过');
}

if (warnings.length) {
  console.log(`\n⚠ ${warnings.length} 项提示（不阻塞）：`);
  for (const w of warnings) console.log(`  [${w.file}] ${w.msg}`);
}

process.exit(violations.length ? 1 : 0);
