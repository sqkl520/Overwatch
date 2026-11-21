#!/usr/bin/env node
/**
 * roles.mjs — 「有哪些角色」的唯一实现。
 *
 * 为什么需要它：同一个角色在本仓库曾经有三个名字空间 —— 目录里的 `oversight-acceptor.md`、
 * 配置 roster 里的 `oversight-acceptor`、任务图里的 `capability: "acceptor"`。
 * 于是 `compose --role oversight-acceptor` 拼出了 `oversight-oversight-acceptor.md` 并报
 * 「没有这个角色的定义」（实测，见 `tasks/dev-findings.md` DF-044）。
 *
 * 在这之前，加一个角色要改 9 个地方（目录 + 6 份脚本里的字面量清单 + 配置 + SKILL.md +
 * planner 的角色表）。九份清单必然漂：它们没有一份是「从别的来源派生」的，
 * 改八份漏一份，屏幕上和八份对过的那份一模一样，而漏掉的那处只在某个分支上才响。
 *
 * 现在只有两个落点：
 *   1. `.claude/agents/<角色>.md` 的 frontmatter（身份、工具、只读、显示名、禁止上下文）
 *   2. 本文件的读取规则
 *
 * ── id 怎么来 ────────────────────────────────────────────────────────
 *
 *   frontmatter 写 `id:` 就用它；否则**去掉前缀**（默认 `oversight-`）。
 *   现有 12 份 `.md` 有 `name: oversight-acceptor` 无 `id:`，去前缀正好得到 `acceptor`，
 *   与任务图里的 `capability` 逐字相同 —— 那是「三个名字空间」收敛成一个键的支点。
 *
 *   为什么要前缀而不是写死 `name.slice(9)`：本库会被别处当模板用，那边的角色可能叫
 *   `my-review-helper`。前缀是**参数**（`agentPrefix`），不是常量假设；
 *   而 `my-review-helper` 前缀不匹配时，id 就是它自己 —— 不会因为名字里含 `review`
 *   就被当成某个已知角色的别名。
 *
 * ── 只读为什么读 frontmatter 而不是按名字子串匹配 ─────────────────────
 *
 *   原实现（`check-structure.mjs:285`）是
 *   `READONLY_ROLES.some((r) => name.toLowerCase().includes(r))`。
 *   子串匹配的失效方式不是「漏检」，是**误检且说不清**：用户建一个
 *   `my-review-helper`，因为名字含 `review` 被强制只读，报错只说「只读角色 X 拥有写工具」，
 *   而 X 的正文里从没写过它是只读角色。申明改成数据：`readonly: true`。
 *
 * 零依赖，只读盘。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 角色定义目录的默认落点（仓库根下的 `.claude/agents`）。 */
export const AGENTS_DIR = resolve(HERE, '..', '.claude', 'agents');

/** 目录名 → id 的默认前缀。改它只影响「没写 `id:` 的那些 .md 怎么取名」。 */
export const DEFAULT_AGENT_PREFIX = 'oversight-';

/** 每个角色**不该拿到**的上下文。键是 id（`acceptor`，不是 `oversight-acceptor`）。
 *
 *  为什么这张表在注册表里而不是 compose 里：它是角色的属性（「验收看不得分数」是
 *  acceptor 这个岗位的定义），不是拼装器的属性。留在 compose，下一个消费角色的脚本
 *  就得再抄一份，而两份必然漂 —— 与整张清单被抄成九份是同一个病。
 *
 *  角色也可以在 frontmatter 写 `forbiddenContext: a, b` 覆盖它。
 *  覆盖而非合并：合并会让「删掉一项」变得不可表达。 */
export const FORBIDDEN_CONTEXT = Object.freeze({
  review: ['self_assessment', 'execution_log', 'weak_points'],
  acceptor: ['self_assessment', 'execution_log', 'weak_points', 'review_score'],
  redteam: ['self_assessment', 'weak_points'],
  critic: ['executor_output', 'review_score'],
  probe: ['reasoning_text'],
  safety: ['relay_rationale'],
});

/** 解析 frontmatter：支持 YAML 多行块（`|` / `>` / `|-`），否则多行 description 会被误判为空。
 *
 *  这是本仓库**唯一**一份 frontmatter 解析实现。原先 `compose-agent-prompt.mjs` 与
 *  `check-structure.mjs` 各有一份拷贝，两份对多行块的处理一致只是碰巧；
 *  而「角色有没有声明只读」现在两边都要读，一个解析差异就会让硬门放行、compose 拦下。
 *
 *  两种入参都收：**整份文件**（含 `---` 围栏）或**围栏内的正文**。
 *  这不是宽容，是让调用方不必知道「上一版是谁实现的」—— 硬门历来传的是正文，
 *  compose 历来传的是整份，任何一边改传法都不该让解析静默返回空对象。
 *
 *  @returns {Record<string,string>|null} 没有 frontmatter 时返回 null（不是空对象：
 *   空对象会让调用方误以为「解析成功、字段恰好都没写」）
 */
export function parseFrontmatter(text) {
  const src = String(text || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  // 传给我们的就是围栏内的正文（硬门的历史调用方式）：没有围栏时按整段当正文。
  const body = m ? m[1] : (/^[A-Za-z_][\w-]*\s*:/.test(src) ? src : null);
  if (body == null) return null;
  const out = {};
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, inline] = kv;
    if (inline === '|' || inline === '>' || inline === '|-') {
      const block = [];
      let j = i + 1;
      while (j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === '')) { block.push(lines[j].trim()); j++; }
      out[key] = block.join(' ').trim();
      i = j - 1;
    } else {
      out[key] = inline.trim();
    }
  }
  return out;
}

/** YAML 里的真值。**只认明确的几种写法**：`readonly: no` 不能被当成 true，
 *  而拼错的 `readonly: ture` 也不能静默变成「是」—— 那会让角色意外获得写权限或
 *  意外被禁，两种都说不清。认不出时按 false 处理，并由 `check-structure.mjs` 报警。 */
export function truthyFlag(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'on' || s === '1';
}

/** 一条角色定义 → 「它是只读的吗」。
 *
 *  判据只有 frontmatter 里的 `readonly`。**没有**名字猜测、没有子串匹配、
 *  没有内置白名单 —— 这三样都会让「为什么它被当成只读」不可回答。 */
export function readonlyOf(frontmatter) {
  return truthyFlag(frontmatter && frontmatter.readonly);
}

/** 从 `name` 去前缀得 id。前缀不匹配时原样返回（别人的角色不必叫 oversight-*）。 */
export function idFromName(name, agentPrefix = DEFAULT_AGENT_PREFIX) {
  const n = String(name || '').trim();
  const p = String(agentPrefix || '');
  if (p && n.toLowerCase().startsWith(p.toLowerCase()) && n.length > p.length) return n.slice(p.length);
  return n;
}

/**
 * 扫一个角色目录，产出注册表。
 *
 * @param {string} [agentsDir] 默认仓库根的 `.claude/agents`
 * @param {{agentPrefix?: string}} [opts]
 * @returns {Array<{id:string, file:string, tools:string[], readonly:boolean,
 *                  forbiddenContext:string[], display:string, name:string}>}
 *   `file` 是绝对路径（读它用）；提示词里要打印**相对路径**，由调用方相对仓库根算，
 *   绝不把本机路径写进任何会被发出去的东西。
 *   目录不存在时返回 `[]` —— 空注册表让下游「一个角色都不合法」，
 *   比静默给一份内置清单安全（后者会让「目录丢了」看起来一切正常）。
 */
export function discoverRoles(agentsDir = AGENTS_DIR, { agentPrefix = DEFAULT_AGENT_PREFIX } = {}) {
  const dir = String(agentsDir || '');
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const file = join(dir, f);
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(text) || {};
    const name = String(fm.name || basename(f, '.md')).trim();
    const id = String(fm.id || idFromName(name, agentPrefix)).trim();
    if (!id) continue;
    const tools = String(fm.tools || '').split(',').map((s) => s.trim()).filter(Boolean);
    const forbiddenContext = fm.forbiddenContext !== undefined
      ? String(fm.forbiddenContext).split(',').map((s) => s.trim()).filter(Boolean)
      : [...(FORBIDDEN_CONTEXT[id] || [])];
    out.push({
      id,
      file,
      tools,
      readonly: readonlyOf(fm),
      forbiddenContext,
      display: String(fm.display || '').trim() || id,
      name,
    });
  }
  // 同 id 两份文件不是「后一份覆盖前一份」，是仓库本身坏了：下游按 id 查表会静默取其一。
  // 报在结构门（check-structure.mjs 用 discoverRoles），这里只保证顺序稳定。
  return out;
}

/**
 * 把一个用户写的名字解析成一条角色定义。**先全名，后加前缀。**
 *
 * 于是 `--role acceptor` 与 `--role oversight-acceptor` 都可用 —— 三个名字空间
 * （文件名 / 配置 / 任务图）里的任何一种写法都不必再被记住。
 *
 * @returns {object|null} 找不到返回 null（调用方必须报错，不能回落成「随便挑一个」）
 */
export function resolveRole(roles, name, { agentPrefix = DEFAULT_AGENT_PREFIX } = {}) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return null;
  const list = Array.isArray(roles) ? roles : [];
  // 1) 全名（frontmatter 的 name）
  const byName = list.find((r) => r.name === n);
  if (byName) return byName;
  // 2) id（任务图里的 capability）
  const byId = list.find((r) => r.id === n);
  if (byId) return byId;
  // 3) 加了前缀再试一次：`acceptor` 对不上 id 时，可能是别人的角色目录里 name 不带前缀
  const prefixed = `${agentPrefix || ''}${n}`;
  return list.find((r) => r.name === prefixed) || null;
}

/** 注册表的按名索引，`registry[role].file` 这种用法要的就是它。
 *  键同时含 id 与全名（指向同一条记录）—— 只有一个键的话，调用方又得自己猜是哪一种。 */
export function roleIndex(roles) {
  const idx = {};
  for (const r of Array.isArray(roles) ? roles : []) {
    idx[r.id] = r;
    idx[r.name] = r;
  }
  return idx;
}

/** 显示名：frontmatter 的 `display`，缺省就是 id。
 *
 *  缺省回落 id 而不是内置一张中文表：那张表是第二个必须手工同步的地方，
 *  而它漂了不会有任何东西变红。要中文名，在角色的 frontmatter 写一行 `display:`。 */
export function labelOf(roles, capability) {
  const c = String(capability == null ? '' : capability);
  if (!c) return '—';
  const hit = (Array.isArray(roles) ? roles : []).find((r) => r.id === c || r.name === c);
  return hit ? hit.display : c;
}

/** 某个 id 的**全名**（配置前缀 + id），查不到就原样返回。
 *
 *  用途：给用户看的文案要点名「派哪个角色」，而那个名字不该在文案里写死 ——
 *  换个 `agentPrefix` 之后，写死的 `oversight-planner` 就是一句指向不存在角色的建议。 */
export function nameOf(roles, id, { agentPrefix = DEFAULT_AGENT_PREFIX } = {}) {
  const hit = (Array.isArray(roles) ? roles : []).find((r) => r.id === id || r.name === id);
  return hit ? hit.name : `${agentPrefix || ''}${id}`;
}

let _default = null;

/** 从仓库根读 `agent.agentPrefix`。**读不出就用默认值**，不抛。
 *
 *  为什么容忍而不是严格校验：这里不是配置校验的入口（那是 `question-audit.mjs` 的
 *  `validateConfig()`，它会把非法值报成错误）。角色注册表只负责「按它取名」，
 *  一份坏配置不该让 `import` 这个模块就炸 —— 结构门要在配置坏掉时**照样能报出别的错**。
 */
export function agentPrefixFrom(root) {
  try {
    const p = join(String(root || resolve(HERE, '..')), 'overwatch.config.json');
    if (!existsSync(p)) return DEFAULT_AGENT_PREFIX;
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    const v = cfg && cfg.agent && cfg.agent.agentPrefix;
    return typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_AGENT_PREFIX;
  } catch { return DEFAULT_AGENT_PREFIX; }
}

/** 仓库自带注册表（懒加载一次）。
 *
 *  懒加载的理由不是性能：模块顶层读盘会让 `import` 一个纯判据也要磁盘就绪，
 *  而结构门会在**几个不同 cwd** 下 import 这些脚本。 */
export function defaultRoles() {
  if (_default == null) _default = discoverRoles(AGENTS_DIR, { agentPrefix: agentPrefixFrom(resolve(HERE, '..')) });
  return _default;
}

/** 仓库根（注册表默认扫的 `.claude/agents` 的上一级）。
 *  导出它是为了让调用方能算「相对仓库根」的路径 —— 提示词里绝不打印绝对路径。 */
export const REPO_ROOT = resolve(HERE, '..');
