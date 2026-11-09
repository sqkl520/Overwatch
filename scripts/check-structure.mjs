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

/** 只作为 CLI 运行、不导出函数的脚本。它们被 import 会执行副作用。 */
const CLI_SCRIPTS = new Set(['check-structure.mjs', 'check-links.mjs']);

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

function checkEmptyDirs(dir = ROOT, depth = 0) {
  if (depth > 6 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (['.git', 'node_modules', '.gitkeep'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
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
  scanSession: '[{"path":"/nonexistent","project":"p","sessionId":"s","mtimeMs":0,"size":0}]',
};

/** 需要临时目录的导出，参数由探针注入 `_sandbox` */
const SANDBOX_ARGS = {
  loadState: '[_sandbox]', saveState: '[_sandbox, {}]',
  probeJobs: '[_sandbox]', probeMtime: '[_sandbox]',
  createLogger: '[_sandbox]', defaultStateDir: '{}', defaultNotifyDir: '{}',
  createObservationLog: '[_sandbox]', observationStats: '[_sandbox]',
  classifyCandidate: '[{}]', readTranscriptTail: '["/nonexistent"]',
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
    'statusToState', 'liveToRow', 'mergeLiveSessions', 'listRow', 'detailLines', 'pendingLines',
    'claimOwnership', 'readOwner', 'ownerPath', 'askedCandidates',
    'requestIdTime', 'lastTimelineStateTime', 'resolveJobEventTime', 'BLOCKED_MAX_AGE',
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
    // verify-claims.mjs 的常量与正则。都是数据，不是函数；函数已逐条登记在 PROBE_ARGS 里。
    'CLAIM_TAIL_BYTES', 'DEFAULT_BACKTRACK_BYTES', 'BACKTRACK_STEPS', 'EVIDENCE_STATUS',
    'EDIT_TOOLS', 'SHELL_TOOLS', 'CLAIM_FAMILIES', 'NEGATION_RE', 'INTERROGATIVE_RE',
    'SPECULATIVE_RE', 'FENCED_CODE_RE', 'BLOCKQUOTE_LINE_RE', 'TEST_CMD_RE', 'BUILD_CMD_RE',
    'COMMIT_CMD_RE', 'PUSH_CMD_RE', 'CI_CMD_RE', 'SYNC_CHECK_CMD_RE', 'RUNTIME_CMD_RE',
    'FAIL_OUTPUT_RE', 'COMMIT_OK_RE', 'PUSH_OK_RE', 'PUSH_REJECT_RE', 'SKIP_TESTS_RE',
    'GIT_READONLY_RE', 'BASH_MUTATION_RE', 'CODE_EXTS', 'DOC_EXTS', 'NON_SOURCE_FILES',
  ]);
  const INTENTIONALLY_PROBED_FREE = new Set([
    'main', 'printPlain', 'copyToClipboard', 'startWatch', 'runTick',
    'runScan', 'dispatchCandidates', 'sendNotification', 'isNotificationAvailable',
    'NOTIFY_STATES', '__internals',
    // 这两个要读真实 transcript 目录（1GB），不能塞进结构门；由 CLI 自测覆盖。
    'parseTranscript', 'listTranscripts', 'loadCorpus',
    // stop-signals.mjs 的常量与汇总扫描：scanAll 要读 186 个 transcript（1.4GB），
    // 同样不能塞进结构门；判据本身已逐条登记在 PROBE_ARGS 里。
    'TAIL_BYTES', 'HEAD_BYTES', 'LOOP_WINDOW', 'LOOP_REPEAT', 'CONTEXT_NEAR_FULL_RATIO',
    'scanAll', 'KINDS',
  ]);

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

// ── 运行 ──────────────────────────────────────────────────────────────

console.log('check-structure · 仓库结构硬门\n');

checkAbsolutePaths();
checkPrivatePaths();
checkGitignoreSanity();
checkAgents();
checkEmptyDirs();
checkCapabilityDisclosure();
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
