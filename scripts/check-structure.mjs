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
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.mjs') && !f.endsWith('.js')) continue;
    const p = join(dir, f);
    const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
    if (r.status !== 0) {
      const first = (r.stderr || '').split('\n').find((l) => l.includes('Error')) || '语法错误';
      fail(rel(p), `无法被 Node 解析：${first.trim().slice(0, 120)}`);
    }
  }
}

// ── 检查 8：脚本导出的模块必须能被 import ────────────────────────────

/** `node --check` 只查语法，查不到「调用了一个不存在的函数」。
 *  曾把 wrapToWidth 的循环变量改了一半，语法全绿、结构门全绿，
 *  但按 ? 打开帮助就抛 ReferenceError。这里实际 import 一次，
 *  并调用每个可导出的纯函数一遍——调得通才算过。 */
function checkImportable() {
  const dir = join(ROOT, 'scripts');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.mjs') || f.endsWith('.test.mjs')) continue;
    // CLI 脚本被 import 时会立刻执行副作用，且不导出函数——不参与此检查。
    // 它们能不能跑由 checkSyntax() 与各自的调用点保证。
    if (CLI_SCRIPTS.has(f)) continue;
    const p = join(dir, f);
    // 调用每一个导出函数，除非它已知有副作用（会起进程 / 写终端 / 改文件）。
    // 曾经用 /^(wrap|truncate|parse|build|...)/ 前缀过滤，只覆盖 9/23 个导出，
    // sanitize / detailLines / judgeState 全被跳过 —— 门看着能挡，实际挡不住。
    // 黑名单而非白名单：新加的纯函数默认会被探到，不需要记得去登记。
    const probe = `
      const SIDE_EFFECTS = new Set([
        'main', 'printPlain', 'copyToClipboard', 'run', 'exec', 'spawn',
        'recalibrate', 'writeFile', 'commit',
      ]);
      import(${JSON.stringify('file:///' + p.replace(/\\/g, '/'))})
        .then(async (m) => {
          const args = {
            parseArgs: [[]], parseKeys: ['j'], parseKeysWithRest: ['j'],
            judgeState: [{}], noveltyOf: [[]], signatureOf: ['Read', {}],
            normalizeBash: ['x'], heartbeatThreshold: [[]], isPersistentChange: ['Bash', {}],
            displayWidth: ['x'], padDisplay: ['x', 1], paint: ['x', 'red', false],
            badge: ['PRODUCING', false], colorEnabled: [{ isTTY: false }],
            stripAnsi: ['x'], sanitize: ['x'], truncateToWidth: ['x', 1],
            wrapToWidth: ['x', 1], buildDraft: [{}], detailLines: [{}, 80, false],
            stripLongStrings: ['x'], collectSubagentFiles: ['/nonexistent'],
            stateCounts: [[]], listRow: [{}, 80, false, false],
            columnHeaderLine: [80], listHeaderLine: [1, 80, []],
            usage: [], fmtDur: [1], fmtNovelty: [0.5], projectLabel: ['a-b'],
            glyphOf: [{}], stateOf: [{}],
          };
          for (const [k, v] of Object.entries(m)) {
            if (typeof v !== 'function' || SIDE_EFFECTS.has(k)) continue;
            const a = args[k] ?? [{}, 1, false];
            try {
              const r = v(...a);
              // async 导出必须等待，否则 rejection 逃逸成未处理拒绝，误判为门失败
              if (r && typeof r.then === 'function') await r.catch(() => {});
            } catch (e) {
              if (e instanceof ReferenceError) { console.error(k + ': ' + e.message); process.exit(1); }
            }
          }
        })
        .catch((e) => { console.error('import: ' + e.message); process.exit(1); });`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      timeout: 20000,
    });
    if (r.status !== 0) {
      const msg = ((r.stderr || '').trim().split('\n').find((l) => l.trim()) || '未知错误').slice(0, 140);
      fail(rel(p), `import 或调用导出函数时失败：${msg}`);
    }
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
checkLinks();

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
