#!/usr/bin/env node
/**
 * build-payload.mjs — 把仓内 `.claude/` 的**运行时载荷**（12 个 agent + 1 个 skill）
 * 生成成一份可分发的 **plugin 布局**目录，由应用用 `--plugin-dir` 挂给 `claude`。
 *
 * ── 为什么是「生成」而不是「维护两份」────────────────────────────────────
 *
 * ADR-0003 §5.2 已经写下这个两难：贡献者在本仓开 Claude Code 时，`.claude/agents/*.md`
 * 按**项目布局**自动加载；用户跑应用时，挂的是 {@link PLUGIN_NAME} 这个 plugin 的
 * **plugin 布局**。两种布局不是一回事（实测：把仓库根直接当 `--plugin-dir` 传进去，
 * `plugins = []`，agents 里没有 `oversight-*`）。于是只要两份都存在，**漂移的那份没人测**
 * —— 本仓已经吃过这个亏（同一个「已读」问题出现三份判据，两份漂移）。
 *
 * 所以本文件是**唯一让两份形态相等的机制**：plugin 载荷是**构建产物**，从不入库
 * （`.gitignore` 里有 `dist/`），每次都由这里的代码从 `.claude/` 生成。
 * 真源永远只有一份，就是 `.claude/` 里那几个 markdown。
 *
 * 反过来的两个方案都不选，理由都是实测的：
 *   - 以 plugin 布局为真源（把 agents 挪到根 `agents/`）：实测根目录的 `agents/`
 *     **不会**被当项目布局加载（`--print` 的 init 消息里 agents 列表没有它），
 *     那会直接弄坏本仓的自用体验 —— 而 ADR-0003 §6 的反悔信号 3 正是这个。
 *   - 软/硬链接：本机 `core.symlinks=false`，实测把一个软链接提交后 clone 出来
 *     变成 9 字节的普通文本文件（内容是链接目标），**静默失效**。跨平台不可靠。
 *
 * ── 布局是实测出来的，不是猜的 ──────────────────────────────────────────
 *
 * | 事实 | 证据 |
 * |---|---|
 * | `.claude-plugin/plugin.json` 只强制 `name`；`version`/`description`/`author` 缺了只警告，但 `--strict` 会红 | 逐个字段二分，`--strict` 退出码 0/1 |
 * | `agents/` 在 plugin 根，**只认一层**：`agents/sub/x.md` 不进清单 | `plugin details` 的 Agents 清单只列出根层那一个 |
 * | `skills/<名字>/SKILL.md`，也是一层；`skills/*.md` 平铺的那个**不被识别** | 三种摆法同测，只有目录形态进了 Skills 清单 |
 * | `hooks/hooks.json` 必须包在 `"hooks"` 里（和 `settings.json` 同一个字段形状），顶层直接写 `PreToolUse` 会**校验失败** | 两种写法各跑一次 `plugin validate` |
 * | plugin 里的 agent 与项目 `.claude/agents` **同名不冲突**：plugin 的自动加 `<plugin>:` 前缀 | 同名 agent 各回一句话，`--agent probe-agent` 命中项目那个，`--agent <plugin>:probe-agent` 命中 plugin 那个 |
 *
 * 本生成器只产出 **agents + skills** 两段。hooks 故意不在载荷里：
 *
 *   plugin 里的 hook 命令写 `${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs`（实测该变量在 plugin
 *   上下文里有值，在 `--settings` 上下文里是 `null`），这就要求载荷把**脚本及其 import
 *   闭包**一起带走。实测踩到过：只拷 `pre-write-gate.mjs`，它在 `claim-ledger.mjs` →
 *   `verify-claims.mjs` 那一跳断掉，hook 报 `ERR_MODULE_NOT_FOUND`，而 `claude` 退出码仍是 0
 *   —— 静默失去介入能力。hooks 属于**应用行为**，由应用在 spawn 时用 `--settings` 带上
 *   自己的绝对路径（同一条实测证明这条路能真拦住写入），不属于这份 markdown 载荷。
 *
 * ── 版本号为什么长这样 ──────────────────────────────────────────────────
 *
 * `0.0.0+g<sourceDigest 前 12 位>`。semver 的 build metadata 段，`plugin validate --strict`
 * 接受。**刻意不取 git commit**：那样每提交一次 `--check` 就红一次，而源码一个字节没变，
 * 红得没道理，久了就没人看。取内容摘要则满足「同一份源 ⇒ 同一份载荷 ⇒ 同一串版本」，
 * 构建可复现，`--check` 的判据也只剩「内容对不对」这一件事。
 *
 * 真正的产品版本号（ADR-0003 §4 的第一条缺口）是另一件事：等仓库有了 `VERSION` 或
 * `package.json`，`pluginManifest()` 应当优先读它，**而不是继续用内容摘要冒充版本**。
 * 本文件不伪造那一步。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *
 *   node scripts/build-payload.mjs                 # 生成到 dist/payload/（gitignored）
 *   node scripts/build-payload.mjs --out <dir>     # 生成到别处（发布包 / 测试）
 *   node scripts/build-payload.mjs --check         # 源变了但载荷没重建 → exit 1
 *   node scripts/build-payload.mjs --print-dir     # 只打印载荷路径，不写盘（给别的脚本消费）
 *   node scripts/build-payload.mjs --root <dir>    # 换一个源树（测试用）
 *
 * 退出码：0 = 生成成功 / 载荷与源同源；1 = 漂移（--check）或本文件自身出错；
 *         2 = 用法错误。
 *
 * 零 npm 依赖，只用 node: 内置模块。
 */

import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/** 载荷格式版本。改这个数字 = 改 `payload-manifest.json` 的形状，`--check` 会因此要求重建。 */
export const PAYLOAD_VERSION = 1;
export const GENERATOR = 'scripts/build-payload.mjs';
export const MANIFEST_FILE = 'payload-manifest.json';
export const PLUGIN_NAME = 'overwatch';
/** 默认产物目录：仓库内、被 .gitignore 排除。**绝不放进可发布区**（docs/ scripts/ …）。 */
export const DEFAULT_OUT = join('dist', 'payload');

export const AGENTS_REL = join('.claude', 'agents');
export const SKILLS_REL = join('.claude', 'skills');

const PLUGIN_DESCRIPTION =
  'OmniSight 运行时载荷：oversight-* 角色定义与 oversight 调度 skill。'
  + '由应用在起 claude 时用 --plugin-dir 挂载，不是给用户装进自己项目的插件。';

/** 载荷里的 plugin.json 允许出现哪些键。
 *
 *  `plugin validate --strict` 把**未知字段**当错误（实测 `x-overwatch` 一条就红），
 *  所以摘要、文件清单这些自证信息一律放在同级的 `payload-manifest.json` 里
 *  —— 宿主会忽略那个多余文件（实测载荷里带额外 json 仍 `✔ loaded`），
 *  但它们进不了 manifest。 */
const PLUGIN_KEYS = Object.freeze(['name', 'version', 'description', 'author']);

// ── 工具 ──────────────────────────────────────────────────────────────

const toPosix = (p) => p.split(sep).join('/');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function walkRel(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkRel(full, base, out);
    else out.push(toPosix(relative(base, full)));
  }
  return out.sort();
}

/** 默认产物目录（绝对路径）。`root` 可换，测试用。 */
export function defaultOutDir(root = REPO) {
  return resolve(String(root || REPO), DEFAULT_OUT);
}

// ── 源 → 载荷清单 ─────────────────────────────────────────────────────

/** 扫源树，算出「哪些源文件该出现在载荷的哪个位置」。
 *
 *  返回 `{ files, problems }`。**problems 非空就必须停**，不许生成半份载荷：
 *  一份少了两个 agent 的载荷在 `plugin list` 里照样 `Status: ✔ loaded`，
 *  静默少件是本文件要防的头号事故。
 *
 *  @param {string} root 源树根（默认本仓库根）
 */
export function summarizeSources(root = REPO) {
  const base = resolve(String(root || REPO));
  const files = [];
  const problems = [];

  // 1) agents：必须**平铺**。实测 `agents/sub/x.md` 不进 plugin 的 Agents 清单。
  const agentsDir = join(base, AGENTS_REL);
  if (!existsSync(agentsDir)) {
    problems.push(`${toPosix(AGENTS_REL)} 不存在 —— 载荷将没有任何 agent`);
  } else {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        problems.push(`${toPosix(join(AGENTS_REL, entry.name))} 是子目录 —— plugin 的 agents/ 只认一层，`
          + '子目录里的定义不会被加载，请让它平铺在 .claude/agents/ 下');
        continue;
      }
      if (!entry.name.endsWith('.md')) {
        problems.push(`${toPosix(join(AGENTS_REL, entry.name))} 不是 .md —— .claude/agents/ 里只该有角色定义`);
        continue;
      }
      files.push({
        path: `agents/${entry.name}`,
        source: toPosix(join(AGENTS_REL, entry.name)),
        abs: join(agentsDir, entry.name),
      });
    }
  }

  // 2) skills：每个**子目录**若含 SKILL.md，就是一个 skill；整个目录递归带走
  //    （skill 目录里的参考文件随它一起发布，但它们不会各自成为一个 skill）。
  const skillsDir = join(base, SKILLS_REL);
  if (!existsSync(skillsDir)) {
    problems.push(`${toPosix(SKILLS_REL)} 不存在 —— 载荷将没有任何 skill`);
  } else {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) {
        // 实测：`skills/*.md` 这种平铺写法**不被识别**为 skill。与其静默丢，不如报错。
        problems.push(`${toPosix(join(SKILLS_REL, entry.name))} 是平铺文件 —— plugin 的 skills/ 只认`
          + `「<目录>/SKILL.md」形态，平铺的 .md 不会被加载`);
        continue;
      }
      const skillDir = join(skillsDir, entry.name);
      if (!existsSync(join(skillDir, 'SKILL.md'))) {
        problems.push(`${toPosix(join(SKILLS_REL, entry.name))} 缺 SKILL.md —— 它不会成为一个 skill`);
        continue;
      }
      for (const relFile of walkRel(skillDir)) {
        files.push({
          path: toPosix(join('skills', entry.name, relFile)),
          source: toPosix(join(SKILLS_REL, entry.name, relFile)),
          abs: join(skillDir, relFile),
        });
      }
    }
  }

  if (!files.some((f) => f.path.startsWith('agents/'))) problems.push('载荷里一个 agent 都没有');
  if (!files.some((f) => f.path.startsWith('skills/'))) problems.push('载荷里一个 skill 都没有');

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, problems };
}

/** 由「源文件哈希表」算一个摘要。
 *
 *  摘要的输入只有 `<sha256>  <源相对路径>` 的排序拼接 —— 不含 mtime、不含绝对路径、
 *  不含 git 信息。所以同一份内容在任何机器、任何时间算出来的值都一样（构建可复现），
 *  而任何一处内容改动都会让它变。
 */
export function payloadDigest(fileRows = []) {
  const rows = (Array.isArray(fileRows) ? fileRows : [])
    .filter((f) => f && typeof f.source === 'string' && f.source)
    .map((f) => `${String(f.sha256 || '')}  ${f.source}\n`)
    .sort();
  return sha256(`overwatch-payload-v${PAYLOAD_VERSION}\n${rows.join('')}`);
}

/** 载荷里的 `.claude-plugin/plugin.json`（对象形态，确定性）。 */
export function pluginManifest(digest) {
  const d = String(digest || '');
  return {
    name: PLUGIN_NAME,
    version: `0.0.0+g${d.slice(0, 12) || 'unknown'}`,
    description: PLUGIN_DESCRIPTION,
    author: { name: PLUGIN_NAME },
  };
}

/** plugin.json 的字节形态。LF 换行、两空格缩进、结尾一个换行 —— 固定下来才能逐字节比对。 */
export function pluginManifestBytes(digest) {
  return `${JSON.stringify(pluginManifest(digest), null, 2)}\n`;
}

/** 把源树读成「载荷清单」：每个文件的最终字节 + 哈希。
 *  读不到源文件时把文件记进 `problems`，不抛。
 *
 *  @param {{root?: string}} [opts]
 */
export function planPayload(opts = {}) {
  const root = resolve(String((opts && opts.root) || REPO));
  const { files, problems } = summarizeSources(root);
  const rows = [];
  for (const f of files) {
    let buf;
    try {
      buf = readFileSync(f.abs);
    } catch (e) {
      problems.push(`读不了 ${f.source}：${e && e.message ? e.message : e}`);
      continue;
    }
    rows.push({ path: f.path, source: f.source, bytes: buf.length, sha256: sha256(buf), buf });
  }
  const digest = payloadDigest(rows);
  return { root, rows, problems, digest, pluginJson: pluginManifestBytes(digest) };
}

// ── 写 ────────────────────────────────────────────────────────────────

/** 验证一个目录**本身**就是合法的 plugin 根（`--verify-self`）。
 *
 *  为什么需要这条路：`.claude/` 可以同时是**项目布局**（cwd=repo 时宿主自动加载
 *  `agents/`、`skills/`）和 **plugin 根**（`--plugin-dir` 指过来），只要在它里面放一个
 *  `.claude-plugin/plugin.json`。于是**不需要生成任何东西**，也就不存在「生成物与源漂移」。
 *
 *  它测的是生成方案测不到的那件事：**布局**。`dist/payload` 的本机测试全部用 mkdtemp
 *  造 fixture、从不 spawn 宿主，所以「真能被加载」在 CI 里从未被验证。这条不 spawn
 *  （那要 4 秒且要登录态），只静态核对布局 —— 但它至少守住「有人把 agents/ 挪走了」
 *  这类会**静默失效**的改动。
 *
 *  判据（全部来自实测的 plugin 布局要求）：
 *    1. `<dir>/.claude-plugin/plugin.json` 存在、可解析、有 `name`
 *    2. `<dir>/agents/*.md` 至少一个，且**只认一层**（子目录不进清单）
 *    3. 每个 agent 文件有 frontmatter 与 `name:`
 *    4. `<dir>/skills/<名>/SKILL.md` 至少一个，且**不能平铺**（`skills/x.md` 不被识别）
 *    5. 目录里 `hooks/` 若非空 → 报错（载荷刻意不含 hooks，见 CHANGELOG）
 *
 *  @param {{root?: string, dir?: string}} [opts]
 */
export function verifyPluginRoot(opts = {}) {
  const root = resolve(String((opts && opts.root) || REPO));
  const dir = resolve(String((opts && opts.dir) || join(root, '.claude')));
  const reasons = [];
  const rel = (p) => toPosix(relative(root, p)) || p;

  const manifest = join(dir, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifest)) {
    reasons.push(`缺 ${rel(manifest)} —— 没有它这个目录只是项目布局，不能当 plugin 根`);
  } else {
    let m = null;
    try { m = JSON.parse(readFileSync(manifest, 'utf8')); } catch (e) { reasons.push(`${rel(manifest)} 不是合法 JSON：${e.message}`); }
    if (m && typeof m.name !== 'string') reasons.push(`${rel(manifest)} 缺 name —— 宿主要求这个名字来自报身份`);
  }

  const agentsDir = join(dir, 'agents');
  let agents = 0;
  if (!existsSync(agentsDir)) {
    reasons.push(`缺 ${rel(agentsDir)}/ —— plugin 布局要求 agents 在根下一层`);
  } else {
    for (const e of readdirSync(agentsDir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        reasons.push(`${rel(agentsDir)}/${e.name}/ 是子目录 —— 实测 plugin **只认一层**，子目录里的 agent 不进清单`);
        continue;
      }
      if (!e.name.endsWith('.md')) continue;
      agents++;
      const text = readFileSync(join(agentsDir, e.name), 'utf8');
      if (!/^---\n[\s\S]*?\n---/.test(text)) reasons.push(`${rel(agentsDir)}/${e.name} 没有 frontmatter —— 宿主认不出它的 name/description`);
      else if (!/^name:\s*\S/m.test(text.split('---')[1] || '')) reasons.push(`${rel(agentsDir)}/${e.name} 的 frontmatter 缺 name`);
    }
    if (agents === 0) reasons.push(`${rel(agentsDir)}/ 里没有 .md —— 这个 plugin 根是空的`);
  }

  const skillsDir = join(dir, 'skills');
  let skills = 0;
  if (!existsSync(skillsDir)) {
    reasons.push(`缺 ${rel(skillsDir)}/ —— plugin 布局要求 skills/<名>/SKILL.md`);
  } else {
    for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) {
        reasons.push(`${rel(skillsDir)}/${e.name} 是**平铺**文件 —— 实测 plugin 只认 \`skills/<名>/SKILL.md\`，平铺的不进清单`);
        continue;
      }
      if (!existsSync(join(skillsDir, e.name, 'SKILL.md'))) {
        reasons.push(`${rel(skillsDir)}/${e.name}/ 缺 SKILL.md`);
        continue;
      }
      skills++;
    }
    if (skills === 0) reasons.push(`${rel(skillsDir)}/ 里没有 skills/<名>/SKILL.md`);
  }

  const hooksDir = join(dir, 'hooks');
  if (existsSync(hooksDir)) {
    let n = 0;
    try { n = readdirSync(hooksDir).length; } catch { n = 1; }
    if (n > 0) reasons.push(`${rel(hooksDir)}/ 非空 —— 载荷刻意不含 hooks：hook 脚本的 import 闭包任何一跳断掉都报 ERR_MODULE_NOT_FOUND 而宿主退出码仍是 0（静默失去介入能力）。hooks 由应用用 --settings 挂`);
  }

  return {
    ok: reasons.length === 0, dir, agents, skills, reasons,
    note: '同一目录既是项目布局也是 plugin 根，无需生成',
  };
}

/** 生成载荷。**先清空目标目录再写**：残留的旧 agent 会让人以为它还在。
 *
 *  @param {{root?: string, out?: string}} [opts]
 */
export function buildPayload(opts = {}) {
  const root = resolve(String((opts && opts.root) || REPO));
  const out = resolve(String((opts && opts.out) || defaultOutDir(root)));
  const plan = planPayload({ root });

  if (plan.problems.length) {
    return { ok: false, out, digest: plan.digest, problems: plan.problems, written: [] };
  }

  try {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(join(out, '.claude-plugin'), { recursive: true });
  } catch (e) {
    return { ok: false, out, digest: plan.digest, problems: [`建目录失败：${e.message}`], written: [] };
  }

  const written = [];
  writeFileSync(join(out, '.claude-plugin', 'plugin.json'), plan.pluginJson);
  written.push('.claude-plugin/plugin.json');

  for (const row of plan.rows) {
    const dest = join(out, row.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, row.buf);
    written.push(row.path);
  }

  /** 自证文件：摘要 + 文件清单 + 生成器名。放在 plugin 根，**不进 plugin.json**
   *  （未知字段会被 `--strict` 判红）。 */
  const manifest = {
    payloadVersion: PAYLOAD_VERSION,
    generator: GENERATOR,
    plugin: pluginManifest(plan.digest),
    sourceDigest: plan.digest,
    files: plan.rows.map((r) => ({ path: r.path, source: r.source, bytes: r.bytes, sha256: r.sha256 })),
  };
  writeFileSync(join(out, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  written.push(MANIFEST_FILE);

  return { ok: true, out, digest: plan.digest, problems: [], written };
}

// ── 验 ────────────────────────────────────────────────────────────────

function readManifest(out) {
  const p = join(out, MANIFEST_FILE);
  if (!existsSync(p)) return { manifest: null, error: `${MANIFEST_FILE} 不存在 —— 这份载荷不是本生成器产的，或从没建过` };
  try {
    return { manifest: JSON.parse(readFileSync(p, 'utf8')), error: null };
  } catch (e) {
    return { manifest: null, error: `${MANIFEST_FILE} 不是合法 JSON：${e.message}` };
  }
}

/** 判「载荷与源是否同源」。**不写任何东西**。
 *
 *  判据分七条，逐条对应一类真实事故：
 *    1. 清单存在且可解析           —— 否则「同源」无从谈起
 *    2. 清单自洽（摘要 == 清单文件表）—— 防有人手改清单去迁就漂移
 *    3. 源现在的摘要 == 清单里的    —— 防「源变了但载荷没重建」（本文件的主要用途）
 *    4. 载荷里每个文件在、且哈希对  —— 防载荷被改 / 被截断
 *    5. 载荷里没有清单外的文件      —— 防有人手工往载荷里补东西（第二真源的起点）
 *    6. plugin.json 字节 == 重新算的 —— 防版本号与内容脱钩
 *    7. 源树自身没有布局问题        —— 防子目录 / 平铺 skill 这些「生成了但宿主不认」
 *
 *  @param {{root?: string, out?: string}} [opts]
 */
export function checkPayload(opts = {}) {
  const root = resolve(String((opts && opts.root) || REPO));
  const out = resolve(String((opts && opts.out) || defaultOutDir(root)));
  const reasons = [];

  if (!existsSync(out)) {
    return { ok: false, out, digest: null, reasons: [`载荷目录不存在：${toPosix(relative(root, out)) || out}`] };
  }

  const { manifest, error } = readManifest(out);
  if (!manifest) return { ok: false, out, digest: null, reasons: [error] };

  // 2. 清单自洽
  const declared = Array.isArray(manifest.files) ? manifest.files : [];
  const recomputedFromManifest = payloadDigest(declared);
  if (manifest.sourceDigest !== recomputedFromManifest) {
    reasons.push(`${MANIFEST_FILE} 自相矛盾：sourceDigest 写的是 ${String(manifest.sourceDigest).slice(0, 12)}…，`
      + `按它自己的 files 重算是 ${recomputedFromManifest.slice(0, 12)}… —— 清单被手改过`);
  }
  if (manifest.payloadVersion !== PAYLOAD_VERSION) {
    reasons.push(`载荷格式版本是 ${manifest.payloadVersion}，本生成器是 ${PAYLOAD_VERSION} —— 需要重建`);
  }
  if (manifest.generator !== GENERATOR) {
    reasons.push(`载荷由 "${manifest.generator}" 生成，不是 ${GENERATOR}`);
  }

  // 3. 源没变
  const plan = planPayload({ root });
  if (plan.problems.length) reasons.push(...plan.problems.map((p) => `源树有问题：${p}`));
  if (plan.digest !== manifest.sourceDigest) {
    const was = new Map(declared.map((f) => [f.path, f.sha256]));
    const now = new Map(plan.rows.map((f) => [f.path, f.sha256]));
    const changed = [];
    for (const [p, h] of now) {
      if (!was.has(p)) changed.push(`新增 ${p}`);
      else if (was.get(p) !== h) changed.push(`改动 ${p}`);
    }
    for (const p of was.keys()) if (!now.has(p)) changed.push(`删除 ${p}`);
    reasons.push(`源变了但载荷没重建（源摘要 ${plan.digest.slice(0, 12)}… ≠ 载荷 ${String(manifest.sourceDigest).slice(0, 12)}…）`
      + (changed.length ? `：${changed.join('、')}` : ''));
  }

  // 4. 载荷文件与清单一致
  for (const row of declared) {
    const p = join(out, String(row.path || ''));
    if (!existsSync(p)) {
      reasons.push(`载荷缺文件：${row.path}`);
      continue;
    }
    let buf;
    try { buf = readFileSync(p); } catch (e) {
      reasons.push(`读不了载荷文件 ${row.path}：${e.message}`);
      continue;
    }
    if (sha256(buf) !== row.sha256) reasons.push(`载荷文件被改过：${row.path}（内容与清单不符）`);
    if (buf.length !== row.bytes) reasons.push(`载荷文件长度变了：${row.path}`);
  }

  // 5. 没有清单外的文件
  const expected = new Set([...declared.map((r) => String(r.path)), MANIFEST_FILE, '.claude-plugin/plugin.json']);
  for (const rel of walkRel(out)) {
    if (!expected.has(rel)) reasons.push(`载荷里有清单外的文件：${rel} —— 手工补进载荷的东西不经过 --check，等于第二真源`);
  }

  // 6. plugin.json 与版本一致
  const pj = join(out, '.claude-plugin', 'plugin.json');
  if (!existsSync(pj)) {
    reasons.push('载荷缺 .claude-plugin/plugin.json —— 它不会被当成 plugin');
  } else {
    const actual = readFileSync(pj, 'utf8');
    if (actual !== pluginManifestBytes(plan.digest)) {
      reasons.push('.claude-plugin/plugin.json 与当前源不符（版本号或字段被改过）');
    }
    let obj = null;
    try { obj = JSON.parse(actual); } catch { /* 上面那条已经会红 */ }
    if (obj) {
      const extra = Object.keys(obj).filter((k) => !PLUGIN_KEYS.includes(k));
      if (extra.length) {
        reasons.push(`plugin.json 有未登记字段 ${extra.join(', ')} —— \`claude plugin validate --strict\` 会把未知字段判红`);
      }
      for (const k of PLUGIN_KEYS) if (!obj[k]) reasons.push(`plugin.json 缺 ${k}`);
    }
  }

  return { ok: reasons.length === 0, out, digest: plan.digest, reasons };
}

// ── CLI ───────────────────────────────────────────────────────────────

export const HELP = `build-payload · 从 .claude/ 生成可分发的 plugin 载荷

用法：
  node scripts/build-payload.mjs                生成到 dist/payload/（gitignored）
  node scripts/build-payload.mjs --out <dir>    生成到指定目录
  node scripts/build-payload.mjs --check        只校验，不同源则 exit 1
  node scripts/build-payload.mjs --print-dir    打印载荷绝对路径，不写盘
  node scripts/build-payload.mjs --root <dir>   换源树（测试用）
  node scripts/build-payload.mjs --json         --check 的结果按 JSON 输出

退出码：
  0  生成成功 / 载荷与源同源
  1  漂移（--check）或本文件自身失败
  2  用法错误（未知参数 / 参数缺值）

载荷里有什么（实测布局）：
  .claude-plugin/plugin.json   必填 name；version/description/author 缺了 --strict 会红
  agents/<名>.md               只认一层，子目录不会被加载
  skills/<名>/SKILL.md         只认「目录 + SKILL.md」，平铺的 .md 不会成为 skill
  payload-manifest.json        摘要与文件清单（宿主忽略；--check 靠它判同源）
`;

/** 解析 argv。故意不叫 `parseArgs` —— 结构硬门的探针表里同名函数会被按那份参数调用。 */
export function parseArgv(argv = []) {
  const out = {};
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (!a.startsWith('--')) { out._ = [...(out._ || []), a]; continue; }
    const key = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || String(next).startsWith('--')) { out[key] = true; continue; }
    out[key] = String(next);
    i++;
  }
  return out;
}

export function main(argv = []) {
  const args = parseArgv(argv);
  if (args.help || args.h) { console.log(HELP); return 0; }

  const root = resolve(String(args.root || REPO));
  const out = resolve(String(args.out || defaultOutDir(root)));

  if (args['print-dir']) { console.log(out); return 0; }

  // `--verify-self`：验证**`.claude/` 目录本身**就是一个合法的 plugin 根。
  //
  // 为什么现在有这条路：红队实测出一个比「生成」更好的形态 —— 把
  // `.claude-plugin/plugin.json` 直接放进 `.claude/` 里，同一个目录既是项目布局
  // （cwd=repo 时宿主自动加载 agents/skills）又是 plugin 根（`--plugin-dir` 指过来）。
  // 于是**不需要生成任何东西**，也就不存在「生成物与源漂移」。
  //
  // 那这条为什么还留着？因为它能测到生成方案测不到的那件事：**布局对不对**。
  // `dist/payload` 那条路的本机测试全部用 mkdtemp 造 fixture、从不 spawn 宿主，
  // 所以「载荷真的能被加载」在 CI 里从来没有被验证过。这条不 spawn（那要 4 秒且要登录态），
  // 只静态核对布局，但它至少守住「有人把 agents/ 挪走了」这类会静默失效的改动。
  if (args['verify-self']) {
    const r = verifyPluginRoot({ root, dir: resolve(String(args.dir || join(root, '.claude'))) });
    if (args.json) {
      console.log(JSON.stringify(r, null, 2));
    } else if (r.ok) {
      console.log(`✔ ${toPosix(relative(root, r.dir))} 是合法的 plugin 根 · ${r.agents} 个 agent · ${r.skills} 个 skill · ${r.note}`);
    } else {
      console.error(`✘ ${toPosix(relative(root, r.dir))} 不是合法的 plugin 根（${r.reasons.length} 条）：`);
      for (const one of r.reasons) console.error(`  ❯ ${one}`);
    }
    return r.ok ? 0 : 1;
  }

  if (args.check) {
    const r = checkPayload({ root, out });
    if (args.json) {
      console.log(JSON.stringify({ ok: r.ok, out: r.out, digest: r.digest, reasons: r.reasons }, null, 2));
    } else if (r.ok) {
      console.log(`✔ 载荷与源同源 · ${toPosix(relative(root, out)) || out} · ${String(r.digest).slice(0, 12)}…`);
    } else {
      console.error(`✘ 载荷与源不同源（${r.reasons.length} 条）：`);
      for (const one of r.reasons) console.error(`  ❯ ${one}`);
      console.error(`\n跑一次 node scripts/build-payload.mjs 重建。`);
    }
    return r.ok ? 0 : 1;
  }

  for (const k of Object.keys(args)) {
    if (k === '_' || ['out', 'root'].includes(k)) continue;
    console.error(`未知参数 --${k}\n\n${HELP}`);
    return 2;
  }

  const r = buildPayload({ root, out });
  if (!r.ok) {
    console.error(`✘ 没有生成载荷（${r.problems.length} 条问题）：`);
    for (const one of r.problems) console.error(`  ❯ ${one}`);
    return r.problems.some((p) => p.includes('读不了')) ? 1 : 2;
  }
  console.log(`✔ 生成 ${r.written.length} 个文件 → ${toPosix(relative(root, out)) || out} · ${String(r.digest).slice(0, 12)}…`);
  return 0;
}

/** 「我是不是被直接执行」——比的是**真实路径**。`resolve()` 只规范化路径、不解析符号
 *  链接，而 `fileURLToPath(import.meta.url)` 已经是真实路径；通过目录符号链接执行
 *  （`npm link` / `npm i -g .` / pnpm 的 store）时两边必然不等，程序会静默 exit 0、零输出。
 *  realpath 失败（路径不存在）退回 resolve：一次失败不能让正常执行也坏掉。 */
const realOrResolve = (p) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};
if (process.argv[1] && realOrResolve(process.argv[1]) === realOrResolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
