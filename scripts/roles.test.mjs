// 角色注册表（`scripts/roles.mjs`）的回归测试。
//
// 这一份守的是「同一件事只写一次」那件事本身 —— 所以它刻意用**真身**：
// 真的扫 `.claude/agents/`，真的跑 `compose-agent-prompt.mjs` 与 `check-structure.mjs`
// 的子进程。从源码正则里提取清单再自己拼一份 = 自证，本仓栽过好几次（DF-039/DF-040/DF-042）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  discoverRoles, resolveRole, roleIndex, labelOf, parseFrontmatter, readonlyOf,
  idFromName, truthyFlag, agentPrefixFrom, AGENTS_DIR, DEFAULT_AGENT_PREFIX,
  rolesFor, capabilitiesFor, rolesDirFor, sourceText,
} from './roles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const AGENTS = join(REPO, '.claude', 'agents');

const tmp = () => mkdtempSync(join(tmpdir(), 'ow-roles-'));

/** 造一份角色定义。**故意不给 `id:`** —— 那是现有 12 份的形态，
 *  也是「去前缀得 id」这条规则唯一会被真正走到的分支。 */
const agentMd = ({ name, tools = 'Read, Grep', readonly = true, display = '', extra = '' }) => [
  '---',
  `name: ${name}`,
  'description: 测试用的角色定义，正文无所谓，只要 frontmatter 完整。',
  `tools: ${tools}`,
  ...(readonly === null ? [] : [`readonly: ${readonly}`]),
  ...(display ? [`display: ${display}`] : []),
  ...(extra ? [extra] : []),
  '---',
  '',
  '正文。',
  '',
].join('\n');

// ── 1. id 集合逐字不变（任务硬要求 3）───────────────────────────────

/** 2026-11-21 收敛前的 12 个 id，**从当时那三份字面量清单抄下来的**。
 *  这不是「再抄一份第二真源」：它是**历史快照**，作用与 CHANGELOG 里的旧数字相同 ——
 *  证明这次重构没顺手改名。真源是目录，这里钉的是「目录解析出来的结果没变」。 */
const IDS_AT_CONVERGENCE = [
  'acceptor', 'critic', 'executor', 'planner', 'probe', 'redteam',
  'relay', 'repair', 'research', 'resolution', 'review', 'safety',
];

test('12 份现有角色文件的 id 集合与收敛前逐字相同', () => {
  const roles = discoverRoles(AGENTS);
  const byName = new Map(roles.map((r) => [r.name, r]));

  // 判据是**每一个历史 id 都还在、且拼写没变**，而不是「总数必须恰好 12」。
  // 差别很重要：钉总数会让「加一个角色」必须改这个测试文件，
  // 而这条快照要守的是「重构没顺手改名/删角色」——新增不该被它拦。
  const missing = IDS_AT_CONVERGENCE.filter((id) => !byName.has(DEFAULT_AGENT_PREFIX + id));
  assert.deepEqual(missing, [],
    `这些角色在收敛前存在，现在没了或改名了：${missing.join(', ')}。`
    + '若是有意删/改名，改这份快照并在 CHANGELOG 写明；若没打算动，说明前缀规则或 frontmatter 被改坏了');

  // 逐字：id 必须是「全名去前缀」的结果，也不许被 frontmatter 的 id: 悄悄改写。
  // （`id:` 优先是给复用者准备的逃生口；本仓这 12 份不该用它。）
  for (const id of IDS_AT_CONVERGENCE) {
    const r = byName.get(DEFAULT_AGENT_PREFIX + id);
    assert.equal(r.id, id, `${r.name} 的 id 变成了 ${r.id}`);
    assert.equal(r.name, DEFAULT_AGENT_PREFIX + r.id, `${r.name} 与它的 id ${r.id} 不一致`);
  }
});

test('全名与 id 是同一批角色，且 id 恰好等于全名去掉 agentPrefix', () => {
  const roles = discoverRoles(AGENTS);
  for (const r of roles) {
    assert.equal(r.name, DEFAULT_AGENT_PREFIX + r.id, `${r.name} 去前缀应当是 ${r.id}`);
    assert.ok(r.file.endsWith(`${r.name}.md`), `file 应指向 ${r.name}.md，实际 ${r.file}`);
    assert.ok(r.file.startsWith(AGENTS), 'file 必须是绝对路径（调用方要直接读它）');
  }
});

test('id 取值规则：frontmatter 写了 id 就用它，没写才去前缀', () => {
  const d = tmp();
  try {
    mkdirSync(join(d, 'agents'));
    writeFileSync(join(d, 'agents', 'oversight-alpha.md'), agentMd({ name: 'oversight-alpha' }));
    writeFileSync(join(d, 'agents', 'oversight-beta.md'),
      agentMd({ name: 'oversight-beta', extra: 'id: explicit-beta' }));
    // 别人的角色目录：名字不带 oversight-，去前缀不成立，id 就是它自己
    writeFileSync(join(d, 'agents', 'my-review-helper.md'), agentMd({ name: 'my-review-helper', readonly: false }));
    const ids = discoverRoles(join(d, 'agents')).map((r) => r.id).sort();
    assert.deepEqual(ids, ['alpha', 'explicit-beta', 'my-review-helper']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('idFromName：前缀是参数，不是写死的假设', () => {
  assert.equal(idFromName('oversight-planner'), 'planner');
  assert.equal(idFromName('oversight-planner', 'oversight-'), 'planner');
  assert.equal(idFromName('ow-planner', 'ow-'), 'planner');
  // 前缀不匹配时原样返回，**绝不去猜**（猜的后果是 my-review-helper 被当成 review 的别名）
  assert.equal(idFromName('my-review-helper', 'oversight-'), 'my-review-helper');
  // 名字恰好等于前缀：不能返回空串（id 为空会让下游按空键查到别人）
  assert.equal(idFromName('oversight-', 'oversight-'), 'oversight-');
});

test('agentPrefixFrom：读配置，读不出就回落默认值而不是抛', () => {
  const d = tmp();
  try {
    writeFileSync(join(d, 'overwatch.config.json'), JSON.stringify({ agent: { roster: ['x'], agentPrefix: 'ow-' } }));
    assert.equal(agentPrefixFrom(d), 'ow-');
    // 没有配置文件
    assert.equal(agentPrefixFrom(join(d, 'nope')), DEFAULT_AGENT_PREFIX);
    // 坏 JSON：注册表不负责校验配置（那是 validateConfig 的事），这里必须不炸
    writeFileSync(join(d, 'overwatch.config.json'), '{ not json');
    assert.equal(agentPrefixFrom(d), DEFAULT_AGENT_PREFIX);
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub', 'overwatch.config.json'), '{ not json');
    assert.equal(agentPrefixFrom(join(d, 'sub')), DEFAULT_AGENT_PREFIX);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('目录不存在 → 返回空注册表（不是内置清单）', () => {
  // 内置清单的失效方式：目录被删了，一切看起来正常。空表让下游立刻报「一个角色都不合法」。
  assert.deepEqual(discoverRoles(join(REPO, '.claude', 'agents-nonexistent')), []);
  assert.deepEqual(discoverRoles(''), []);
});

// ── 2. 严格放宽：两种名字都能用（任务硬要求 2）──────────────────────

test('resolveRole：全名与 id 都解析到同一条记录', () => {
  const roles = discoverRoles(AGENTS);
  const a = resolveRole(roles, 'acceptor');
  const b = resolveRole(roles, 'oversight-acceptor');
  assert.ok(a && b, '两种写法都必须解析得到');
  assert.equal(a.file, b.file, '同一个角色解析到两份文件 = 三个名字空间没收敛');
  assert.equal(a.id, 'acceptor');

  // 真的找不到时必须返回 null —— 回落成「随便挑一个」会让 compose 发错岗位的提示词
  assert.equal(resolveRole(roles, 'nosuchrole'), null);
  assert.equal(resolveRole(roles, ''), null);
  assert.equal(resolveRole(roles, null), null);
});

test('resolveRole：前缀重试那一支真的存在（name 不带前缀的角色也能按短名调用）', () => {
  const roles = [{ id: 'alpha', name: 'ow-alpha', file: '/x/ow-alpha.md', tools: [], readonly: false, forbiddenContext: [], display: 'alpha' }];
  assert.equal(resolveRole(roles, 'alpha').name, 'ow-alpha', 'id 与 name 都不同时，靠加前缀再试一次');
  assert.equal(resolveRole(roles, 'alpha', { agentPrefix: 'ow-' }).name, 'ow-alpha');
});

test('CLI 端到端：--role acceptor 与 --role oversight-acceptor 都能过角色解析', () => {
  const d = tmp();
  try {
    const runDir = join(d, 'tasks', 'runs', 'r1');
    mkdirSync(runDir, { recursive: true });
    const graph = join(runDir, 'task-graph.json');
    writeFileSync(graph, JSON.stringify({
      run_id: 'r1', root_goal: 'g', constraints: [],
      subtrees: [{
        id: 'ST1', goal: '对交付物逐项判定，按预声明标准给出通过或不通过与证据引用',
        capability: 'acceptor', shape: 'artifact', token_budget_pct: 20, timeout_min: 10,
        parallel_with: [], depends_on: [],
        acceptance: [{ id: 'AC1', criterion: 'a.md:1 有东西', evidence: 'a.md:1', fail_if: '没有' }],
        outputs: ['a.md'], why_this_layer: 'w',
      }],
    }));
    const cli = join(REPO, 'scripts', 'compose-agent-prompt.mjs');
    const base = ['compose', '--run', 'r1', '--task', 'ST1', '--graph', graph,
      '--stop', '每项 AC 必带 file:line，10 分钟内返回'];
    const short = spawnSync(process.execPath, [cli, ...base, '--role', 'acceptor', '--dry-run'], { encoding: 'utf8' });
    const full = spawnSync(process.execPath, [cli, ...base, '--role', 'oversight-acceptor', '--dry-run'], { encoding: 'utf8' });

    // 两条都必须**走到角色解析之后**：判据是输出里出现「角色 <名字>」这句检查行，
    // 而不是「exit 0」—— 检查不过也会 exit 1，用退出码判会把两者混为一谈。
    assert.match(short.stdout + short.stderr, /角色 acceptor/, `短名没解析到：\n${short.stdout}${short.stderr}`);
    assert.match(full.stdout + full.stderr, /角色 oversight-acceptor/, `全名没解析到：\n${full.stdout}${full.stderr}`);
    // 复现那条原始报错：拼出 oversight-oversight- 的路径不能再次出现
    assert.ok(!/oversight-oversight-/.test(full.stdout + full.stderr),
      `全名仍然被二次拼前缀：\n${full.stdout}${full.stderr}`);
    assert.ok(!/没有这个角色的定义/.test(full.stdout + full.stderr),
      `全名仍然被报成「不存在」：\n${full.stdout}${full.stderr}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── 3. 暗雷：只读不再靠名字子串匹配（任务硬要求 4）────────────────

test('readonly 读 frontmatter：my-review-helper 不因名字含 review 被强制只读', () => {
  const d = tmp();
  try {
    const agents = join(d, '.claude', 'agents');
    mkdirSync(agents, { recursive: true });
    // 名字里带 review，但显式写了 readonly: false，且有写工具。
    // 旧实现（READONLY_ROLES.some(r => name.includes(r))）会把它当成只读角色，
    // 于是「拥有写工具」这条与本文件毫无关系的告警会落在它头上，而它自己说的是 false。
    writeFileSync(join(agents, 'my-review-helper.md'),
      agentMd({ name: 'my-review-helper', tools: 'Read, Write, Edit, Bash', readonly: false }));

    const roles = discoverRoles(agents);
    assert.equal(roles.length, 1);
    assert.equal(roles[0].readonly, false,
      '名字含 review 就被判只读 —— 这就是那条子串匹配的暗雷');

    // 硬门必须对它放行。**跑真身**（子进程 + 临时 cwd），不复制判据。
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'check-structure.mjs')], {
      cwd: d, encoding: 'utf8',
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(!/my-review-helper/.test(out),
      `硬门对 my-review-helper 报了违规（它自己声明 readonly: false）：\n${out}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('只读角色的工具越界仍然被拦（改判据之后检查没有变松）', () => {
  const d = tmp();
  try {
    const agents = join(d, '.claude', 'agents');
    mkdirSync(agents, { recursive: true });
    // readonly: true + Edit/Bash，且正文没有任何「只能写报告」的申明 —— 必须红。
    writeFileSync(join(agents, 'oversight-strict.md'),
      agentMd({ name: 'oversight-strict', tools: 'Read, Edit, Bash', readonly: true }));
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'check-structure.mjs')], {
      cwd: d, encoding: 'utf8',
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.status, 0, `应当有违规，实际 exit ${r.status}：\n${out}`);
    assert.match(out, /只得拥有 Edit\/Bash|不得拥有 Edit\/Bash|只读角色/,
      `没报「只读角色拥有写工具」：\n${out}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('缺 readonly 行本身要报错——否则「忘了写」的失效方式是静默放行', () => {
  const d = tmp();
  try {
    const agents = join(d, '.claude', 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'oversight-forgot.md'), agentMd({ name: 'oversight-forgot', readonly: null }));
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'check-structure.mjs')], {
      cwd: d, encoding: 'utf8',
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.status, 0, `缺 readonly 应当报错：\n${out}`);
    assert.match(out, /缺少必填字段 "readonly"/, `报的不是「缺 readonly」：\n${out}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('现有 12 份定义全部写明了 readonly（不是靠默认值）', () => {
  for (const r of discoverRoles(AGENTS)) {
    const fm = parseFrontmatter(readFileSync(r.file, 'utf8'));
    assert.ok(fm && fm.readonly !== undefined && fm.readonly !== '',
      `${r.name} 没写 readonly —— 那就没人想过这个角色该不该有写权限`);
    assert.ok(['true', 'false'].includes(String(fm.readonly).trim()), `${r.name} 的 readonly 是 "${fm.readonly}"`);
    assert.equal(readonlyOf(fm), String(fm.readonly).trim() === 'true');
  }
});

test('truthyFlag 只认明确写法：`readonly: ture` 不许静默变成 true', () => {
  for (const t of ['true', 'TRUE', 'yes', 'on', '1', ' true ']) assert.equal(truthyFlag(t), true, t);
  for (const f of ['false', 'no', 'off', '0', '', null, undefined, 'ture', 'flase', 'maybe']) {
    assert.equal(truthyFlag(f), false, String(f));
  }
});

// ── 4. 其余投影：显示名 / 索引 / 禁止上下文 ─────────────────────────

test('labelOf：取 frontmatter 的 display，缺省回落 id（不内置中文表）', () => {
  const roles = [
    { id: 'acceptor', name: 'oversight-acceptor', display: '验收' },
    { id: 'mystery', name: 'oversight-mystery', display: '' },
  ];
  // display 为空串时 discoverRoles 已经回落成 id；这里再兜一层，防止调用方手造的记录
  assert.equal(labelOf(roles, 'acceptor'), '验收');
  assert.equal(labelOf(roles, 'oversight-acceptor'), '验收', '全名也要能查到标签');
  assert.equal(labelOf(roles, 'mystery'), '');
  // 表里没有的 capability：原样返回，**不是** '—'（'—' 会让「谁能干这事」看起来像「没人」）
  assert.equal(labelOf(roles, 'unknown-cap'), 'unknown-cap');
  assert.equal(labelOf(roles, ''), '—');
});

test('roleIndex 同时按 id 与全名建键，且指向同一条记录', () => {
  const idx = roleIndex(discoverRoles(AGENTS));
  assert.equal(idx.acceptor, idx['oversight-acceptor']);
  assert.equal(idx.acceptor.id, 'acceptor');
});

test('每个角色都有 forbiddenContext 数组（缺省是空数组，不是 undefined）', () => {
  for (const r of discoverRoles(AGENTS)) {
    assert.ok(Array.isArray(r.forbiddenContext), `${r.name} 的 forbiddenContext 不是数组`);
  }
  const idx = roleIndex(discoverRoles(AGENTS));
  // 关键的三条：锚定的失效方式是静默的，所以清单本身要被钉住
  assert.ok(idx.acceptor.forbiddenContext.includes('review_score'), '验收不得拿到锐评分数');
  assert.ok(idx.review.forbiddenContext.includes('self_assessment'), '锐评不得拿到执行者自评');
  assert.deepEqual(idx.executor.forbiddenContext, [], '执行者没有额外禁止项');
});

test('parseFrontmatter 两种入参都收（整份文件 / 围栏内正文）', () => {
  const whole = '---\nname: a\ntools: Read\n---\n正文';
  assert.deepEqual(parseFrontmatter(whole).name, 'a');
  // 硬门的历史调用方式：先自己剥掉围栏，再把正文传进来
  assert.deepEqual(parseFrontmatter('name: a\ntools: Read').name, 'a');
  // 两者对同一份文件必须给出同一个结论
  assert.deepEqual(parseFrontmatter(whole), parseFrontmatter('name: a\ntools: Read'));
  // 真的没有 frontmatter：null（不是空对象 —— 空对象会伪装成「字段都没写」）
  assert.equal(parseFrontmatter('只有正文，没有 frontmatter'), null);
  assert.equal(parseFrontmatter(''), null);
});

test('parseFrontmatter 支持多行块（否则多行 description 会被误判为空）', () => {
  const fm = parseFrontmatter('---\nname: a\ndescription: |\n  第一行\n  第二行\ntools: Read\n---\n');
  assert.equal(fm.description, '第一行 第二行');
  assert.equal(fm.tools, 'Read');
});

// ── 5. 按根求值：项目角色必须被看见（2026-11-21，D2 验证的根因）─────────
//
// 这一组的每一条都在守同一件事：**「有哪些角色」不是常量，是按根求值的结果。**
// 修前 `validate-run.mjs` 是 `export const CAPABILITIES = discoverRoles()`，
// 模块加载时执行 → 永远读框架自己的目录。实测（`%TEMP%` 下一个只有 qa/reviewer 的项目）：
//   capability: "qa"       → exit 1「不在合法取值内」
//   capability: "executor" → exit 0（项目里根本没这个角色）
// 后半句比修前更糟。所以下面**既钉「项目角色被看见」，也钉「项目里不存在的被拒」**。

/** 造一个「真项目」：`.claude/agents/` + 可选配置。`git init` 只为了让
 *  `projectRoot()` 的阶梯在子进程里也能认出它（端到端用例需要）。 */
function makeProject({ agents = {}, config = null } = {}) {
  const d = tmp();
  const dir = join(d, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  for (const [file, spec] of Object.entries(agents)) {
    writeFileSync(join(dir, `${file}.md`), agentMd(spec));
  }
  if (config) writeFileSync(join(d, 'overwatch.config.json'), JSON.stringify(config));
  return d;
}

test('rolesFor：项目有角色目录 → 只认项目，不并入框架', () => {
  const d = makeProject({ agents: { qa: { name: 'qa', display: '质量' } } });
  try {
    const set = rolesFor(d);
    assert.equal(set.source, 'project');
    assert.deepEqual(set.roles.map((r) => r.id), ['qa'],
      '项目里的角色表被并入了框架的 12 个 —— 那样「项目里不存在的 capability」会照样合法');
    assert.equal(set.dir, join(d, '.claude', 'agents'), 'dir 必须是项目的绝对路径（调用方要直接读它）');
    assert.equal(set.roles[0].display, '质量');
    assert.equal(capabilitiesFor(d).join(','), 'qa');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rolesFor：项目没有角色目录 → 框架兜底，并如实标 source', () => {
  const d = tmp(); // 空目录，没有 .claude/agents
  try {
    const set = rolesFor(d);
    assert.equal(set.source, 'framework');
    assert.ok(set.roles.length >= 12, `框架兜底应当拿到全部角色，实际 ${set.roles.length}`);
    assert.equal(set.dir, AGENTS_DIR);
    // `null` = 只认框架，不需要任何项目在盘上
    assert.equal(rolesFor(null).source, 'framework');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rolesFor：空目录也算「没有」—— 空注册表会让下游「一个角色都不合法」', () => {
  const d = makeProject({ agents: {} }); // 目录在，但一份 .md 都没有
  try {
    assert.equal(rolesFor(d).source, 'framework', '空目录不该被当成「这个项目没有角色」，那等于全拒');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rolesFor：前缀取**项目自己的配置**，不是框架的 oversight-', () => {
  const d = makeProject({
    agents: { 'ow-qa': { name: 'ow-qa', display: '质量' } },
    config: { agent: { agentPrefix: 'ow-' } },
  });
  try {
    const set = rolesFor(d);
    assert.equal(set.agentPrefix, 'ow-');
    assert.deepEqual(set.roles.map((r) => r.id), ['qa'],
      '项目配了 ow- 前缀却没生效 —— 这是缺陷 3：compose --role qa 会报「现有角色：ow-qa」');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('sourceText：必须说清「这份注册表来自哪」', () => {
  const d = makeProject({ agents: { qa: { name: 'qa' } } });
  try {
    const proj = sourceText(rolesFor(d), d);
    assert.match(proj, /项目角色目录/);
    assert.match(proj, /1 个/);
    assert.ok(!proj.includes(d), `打印了绝对路径（含本机目录）：${proj}`);
    const fw = sourceText(rolesFor(null));
    assert.match(fw, /框架角色目录/);
    assert.match(fw, /用户项目里没有/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rolesDirFor：纯路径拼接，空根返回 null（不拼出相对路径）', () => {
  assert.equal(rolesDirFor('/p'), join('/p', '.claude', 'agents'));
  assert.equal(rolesDirFor(''), null);
  assert.equal(rolesDirFor(null), null);
});

test('端到端：validate-run 在别人的项目里按**项目的**角色表判', () => {
  // 这一条是 D2 场景的最小复现，必须跑真子进程 —— 缺陷的形态就是
  // 「模块加载时求值」，在任何进程内调用里都看不出来（import 发生在 --root 之前）。
  const d = makeProject({ agents: { qa: { name: 'qa' }, reviewer: { name: 'reviewer' } } });
  try {
    // .git 让 projectRoot 的阶梯第 4 级认得出它
    spawnSync('git', ['init', '-q', '.'], { cwd: d, encoding: 'utf8' });
    const g = (cap) => join(d, `g-${cap}.json`);
    const mk = (cap) => {
      writeFileSync(g(cap), JSON.stringify({
        run_id: 'r1', root_goal: '目标', constraints: [],
        subtrees: [{
          id: 'ST1', goal: '做点事', capability: cap, shape: 'artifact',
          token_budget_pct: 20, timeout_min: 10, parallel_with: [], depends_on: [],
          acceptance: [{ id: 'AC1', criterion: 'a.md:1 有东西', evidence: 'a.md:1', fail_if: '没有' }],
          outputs: ['a.md'], why_this_layer: 'w',
        }],
      }), 'utf8');
      return g(cap);
    };

    const cli = join(REPO, 'scripts', 'validate-run.mjs');
    const run = (cap) => spawnSync(process.execPath, [cli, '--simple', mk(cap)], { encoding: 'utf8' });

    const ok = run('qa');
    assert.equal(ok.status, 0, `项目里真有 qa，却判非法（缺陷 1 的原形）：\n${ok.stdout}${ok.stderr}`);
    assert.match(ok.stderr, /角色表 → 项目角色目录/, `没有打印角色表来源：\n${ok.stderr}`);

    // **反向**：项目里不存在的角色必须被拒。修前这一条 exit 0（框架有 executor），
    // 于是「校验通过」不再意味着「这个角色在项目里存在」—— 比不校验更糟。
    const bad = run('executor');
    assert.equal(bad.status, 1, `项目里没有 executor，却放行了：\n${bad.stdout}${bad.stderr}`);
    assert.match(bad.stdout, /executor" 不在合法取值内（qa \/ reviewer）/, bad.stdout);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('端到端：compose 用项目的角色 + 项目的 agentPrefix，模板仍走框架', () => {
  // 三个缺陷一次性验完：角色根（2）、前缀（3）、模板根（2 的后半）。
  // 修前：不给 --root → 读框架角色 → 「没有这个角色的定义」；
  //       给 --root . → 角色对了，但项目里没有 templates/dispatch.md → L1 exit 1。
  const d = makeProject({
    agents: { 'ow-qa': { name: 'ow-qa', display: '质量', tools: 'Read, Write, Bash', readonly: false } },
    config: { agent: { agentPrefix: 'ow-' } },
  });
  try {
    spawnSync('git', ['init', '-q', '.'], { cwd: d, encoding: 'utf8' });
    const runDir = join(d, '.untildone', 'runs', 'r1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'task-graph.json'), JSON.stringify({
      run_id: 'r1', root_goal: '目标', constraints: [],
      subtrees: [{
        id: 'ST1', goal: '对交付物逐项判定，按预声明标准给出通过或不通过与证据引用',
        capability: 'qa', shape: 'artifact', token_budget_pct: 20, timeout_min: 10,
        parallel_with: [], depends_on: [],
        acceptance: [{ id: 'AC1', criterion: '`node scripts/x.mjs` 全绿', evidence: '命令输出', fail_if: 'exit!=0' }],
        outputs: ['a.md'], why_this_layer: 'w',
      }],
    }), 'utf8');

    const cli = join(REPO, 'scripts', 'compose-agent-prompt.mjs');
    const r = spawnSync(process.execPath, [cli, 'compose', '--run', 'r1', '--task', 'ST1',
      '--role', 'qa', '--stop', '10 分钟内返回', '--dry-run'], { cwd: d, encoding: 'utf8' });
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(!/没有这个角色的定义/.test(out), `项目里的 qa 仍然解析不到：\n${out}`);
    assert.match(out, /前缀 "ow-"/, `没有用项目的 agentPrefix：\n${out}`);
    // L1 模板来自框架：项目里没有 templates/，但不应因此报错
    assert.ok(!/L1: 读不到 templates\/dispatch\.md/.test(out),
      `模板仍然走项目根（缺陷 2 的后半）：\n${out}`);
    assert.equal(r.status, 0, out);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
