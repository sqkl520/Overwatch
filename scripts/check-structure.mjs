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

const ROOT = process.cwd();
const violations = [];
const warnings = [];

const fail = (file, msg) => violations.push({ file, msg });
const warn = (file, msg) => warnings.push({ file, msg });

// ── 规则定义 ──────────────────────────────────────────────────────────

/** 可发布区：出现本机盘符即为违规（ADR-0001 §发布区零盘符） */
const PUBLISHED_DIRS = ['docs', 'templates', 'rules', 'scripts', 'spec-adr'];
const PUBLISHED_FILES = ['README.md', 'CLAUDE.md', 'LICENSE', 'CONTRIBUTING.md'];

/** 私有区：允许出现本机路径，但必须被 .gitignore 排除 */
const PRIVATE_PATHS = ['tasks/runs', 'local', '.claude/settings.local.json', 'CLAUDE.local.md'];

/** 允许出现盘符的文件（本机私有、运行时产物） */
const PATH_EXEMPT = /^(scripts\/.*\.test\.mjs)$/;

const AGENT_REQUIRED_FIELDS = ['name', 'description'];
/** 这些角色的 tools 不得包含 Edit / Write */
const READONLY_ROLES = ['acceptor', 'probe', 'safety', 'review', 'redteam', 'critic'];
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

/** 解析 frontmatter：支持 YAML 多行块（| 与 >），否则多行 description 会被误判为空 */
function parseFrontmatter(fm) {
  const out = {};
  const lines = fm.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, inline] = m;
    if (inline === '|' || inline === '>' || inline === '|-') {
      const block = [];
      let j = i + 1;
      while (j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === '')) {
        block.push(lines[j].trim());
        j++;
      }
      out[key] = block.join(' ').trim();
      i = j - 1;
    } else {
      out[key] = inline.trim();
    }
  }
  return out;
}

function isGitignored(path) {
  const gi = join(ROOT, '.gitignore');
  if (!existsSync(gi)) return false;
  const lines = readFileSync(gi, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return lines.some((rule) => {
    const r = rule.replace(/^\//, '');
    return path === r || path.startsWith(r.replace(/\/$/, '') + '/') || path === r.replace(/\/$/, '');
  });
}

// ── 检查 1：可发布区零盘符 ────────────────────────────────────────────

function checkAbsolutePaths() {
  const WIN_PATH = /[A-Za-z]:[\\/](?:Users|Projects|Server|Java|maven|Nodejs|Git)[^\s)"'`]*/g;
  const targets = [];

  for (const d of PUBLISHED_DIRS) {
    if (!existsSync(join(ROOT, d))) continue;
    targets.push(...walk(join(ROOT, d)));
  }
  for (const f of PUBLISHED_FILES) {
    const p = join(ROOT, f);
    if (existsSync(p)) targets.push(p);
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
    const hits = text.match(WIN_PATH);
    if (hits) {
      // 文档里作为「反例」引用的本机路径是允许的，但必须是行内代码且带说明
      const meaningful = [...new Set(hits)].filter((h) => {
        const line = text.split('\n').find((l) => l.includes(h)) || '';
        return !(line.includes('反例') || line.includes('示例') || line.includes('例如') || line.includes('实测'));
      });
      for (const h of meaningful) {
        fail(r, `可发布区出现本机绝对路径：${h.slice(0, 60)}`);
      }
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
    const name = parsed.name || f.replace(/\.md$/, '');
    const isReadonly = READONLY_ROLES.some((r) => name.toLowerCase().includes(r));
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
  resetBlockCount: '["s", { env: {} }]',
  appendLog: '[{}, { OVERWATCH_STOP_VERIFY_LOG: "/nonexistent-dir-ow/x.jsonl" }]',
  bumpBlockCount: '["s", { env: { OVERWATCH_STOP_VERIFY_STATE: "/nonexistent-dir-ow/x.json" } }]',
  runHook: '[{ input: { session_id: "probe", last_assistant_message: "" }, env: {} }]',
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
  buildSample: '[{}]', appendSample: '[{}, { OVERWATCH_STOP_VERIFY_SAMPLES: "/nonexistent-dir-ow/s.jsonl" }]',
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
  // verify-claims.mjs：断言 vs 证据配对。全部是纯函数，参数取最小可构造输入。
  // 目的是让「导出但调用即炸」在结构门暴露，而不是等到对 1.5 GB 语料跑完才发现。
  detectClaims: '""', findEvidence: '[[], "test-count"]', classifyEvidence: '[{}]',
  splitSentences: '""', stripQuoted: '""', isNegated: '""', isInterrogative: '""',
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
  // tui-meta.mjs（2026-11-10）：有界读取与缓存。file 不存在时必须安全返回，不抛。
  projectsRoot: '[{}]', transcriptPathFor: '[{}, "/nonexistent"]',
  metaFromRecords: '[[]]', readTailRecords: '["/nonexistent"]',
  createMetaCache: '[{}]', lastSpeakerOf: '[[]]', pendingQuestionOf: '[[], {}]',
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
  bumpDenials: '["/nonexistent-dir-ow/pwg.json", "probe", { readOnly: true }]',
  cli: '[["status", "--cwd", "/nonexistent-ow-probe"], {}]',

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
};

/** 需要临时目录的导出，参数由探针注入 `_sandbox` */
const SANDBOX_ARGS = {
  loadState: '[_sandbox]', saveState: '[_sandbox, {}]',
  probeJobs: '[_sandbox]', probeMtime: '[_sandbox]',
  createLogger: '[_sandbox]', defaultStateDir: '{}', defaultNotifyDir: '{}',
  readLogHealth: '[_sandbox]', logHealthPath: '["/nonexistent"]',
  createObservationLog: '[_sandbox]', observationStats: '[_sandbox]',
  classifyCandidate: '[{}]', readTranscriptTail: '["/nonexistent"]',
  // pre-write-gate.mjs 的签名密钥生成（2026-11-14）。它会 real 写盘，所以只能进
  // SANDBOX_ARGS —— 探针把它指到结构门自己的临时目录，不碰任何真实项目。
  ensureGateSecret: '[_join(_sandbox, "pwg-secret")]',
};
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
    '    const src = PROBE_ARGS[k] !== undefined ? PROBE_ARGS[k] : SANDBOX_ARGS[k];',
    '    if (src === undefined) continue;',
    '    let a;',
    '    try { a = JSON.parse("[" + src + "]"); } catch { continue; }',
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
 *  这类正确链接被误报为断链，于是检查器只好退化成建议门。 */
function checkLinks() {
  const files = ['README.md', 'CLAUDE.md'].filter((f) => existsSync(join(ROOT, f)));
  const walkMd = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walkMd(p);
      else if (e.name.endsWith('.md')) files.push(p);
    }
  };
  walkMd(join(ROOT, 'docs'));

  for (const f of files) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const dir = dirname(f);
    for (const m of text.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
      if (!existsSync(resolve(dir, m[1]))) {
        fail(rel(f), `文档链接指向不存在的文件：${m[1]}`);
      }
    }
  }
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
    'signatureOf', 'normalizeBash', 'heartbeatThreshold', 'isPersistentChange', 'parseJsonl', 'SUBAGENT_READ_BYTES',
    'displayWidth', 'padDisplay', 'paint', 'badge', 'colorEnabled', 'stripAnsi',
    'sanitize', 'truncateToWidth', 'wrapToWidth', 'buildDraft', 'detailLines',
    'stripLongStrings', 'collectSubagentFiles', 'stateCounts', 'listRow',
    'columnHeaderLine', 'listHeaderLine', 'usage', 'fmtDur', 'fmtNovelty',
    'projectLabel', 'glyphOf', 'stateOf', 'reasonClass', 'dedupeKey',
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
    // validate-run.mjs 的 outputs 判据（2026-11-13）：每个子树必须声明「磁盘上会多出什么」。
    // checkOutputs 走 PROBE_ARGS 真实调用一次（登记在下面）；另外两个是它内部的纯判据，
    // 由 validate-run.test.mjs 的合法/非法两组用例覆盖，这里按数据登记。
    'SHAPES_REQUIRING_OUTPUTS', 'checkOutputs', 'outputPathError', 'outputPathKey',
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
    // tui-meta.mjs（2026-11-10）：标题 / 末条 assistant 的有界读取与 mtime 缓存。
    'META_TAIL_BYTES', 'projectsRoot', 'transcriptPathFor', 'metaFromRecords',
    'readTailRecords', 'createMetaCache', 'lastSpeakerOf', 'pendingQuestionOf',
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
    'statePathFor', 'bumpBlockCount', 'resetBlockCount', 'readBlockCount', 'runHook',
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
    // defaultClaimsScan 会 spawn verify-claims 子进程（实测 7.2s），不能塞进结构门；
    // 它有独立的 `--plain` 端到端覆盖（见 tui-redesign.test.mjs）。
    'defaultClaimsScan',
    // stop-signals.mjs 的常量与汇总扫描：scanAll 要读 186 个 transcript（1.4GB），
    // 同样不能塞进结构门；判据本身已逐条登记在 PROBE_ARGS 里。
    'TAIL_BYTES', 'HEAD_BYTES', 'LOOP_WINDOW', 'LOOP_REPEAT', 'CONTEXT_NEAR_FULL_RATIO',
    'scanAll', 'KINDS',
    // measure-execution-phase.mjs：run 会全量扫 1.8GB transcript（实测 37s），
    // 不能进结构门；它的正确性由 measure-execution-phase.test.mjs 的小目录端到端用例覆盖。
    // 三个常量是数据（工具白名单 / 文本截断长度 / 空闲切分参数），不是函数。
    'run', 'summarize', 'formatReport', 'WRITE_TOOLS', 'READ_TOOLS', 'SHELL_TOOLS',
    'TEXT_CAP', 'IDLE_GAP_MS',
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
  ];
  for (const k of COST_FNS) REGISTERED.add(k);

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
  ];
  for (const k of PRE_WRITE_GATE_FNS) REGISTERED.add(k);

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

  // probe-parser-divergence.mjs（2026-11-14 量化重放器与闸门的分叉）：纯函数进 PROBE_ARGS，
  // `probe` 要扫全量语料，与 measure-* 系列同处置 —— 由 probe-parser-divergence.test.mjs
  // 的小目录用例覆盖。
  const PROBE_DIVERGENCE_FNS = [
    'gatePathsOfText', 'windowTextOf', 'diffOf', 'attributeDivergence',
    'syntheticCases', 'probe', 'formatProbe', 'main',
  ];
  for (const k of PROBE_DIVERGENCE_FNS) REGISTERED.add(k);

  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && !CLI_SCRIPTS.has(f));
  if (!files.length) return;

  // 一次性拿到所有文件的导出名：每个文件一个 import()，但只起一个 node 进程。
  const mods = files.map((f) => JSON.stringify('file:///' + join(dir, f).split(String.fromCharCode(92)).join('/')));
  const script =
    'Promise.all([' + mods.join(',') + '].map((u) => import(u).then((m) => Object.keys(m)).catch(() => [])))' +
    '.then((all) => console.log(JSON.stringify(all)))';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) return;
  let all;
  try { all = JSON.parse(String(r.stdout || '[]')); } catch { return; }
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
      fail('.claude/agents/', `12 个角色定义里没有一个引用 --inbox —— 监控与调度脱节（DF-015）`);
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
checkLedger();
checkLauncherPlacement();
checkInboxWiring();
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
