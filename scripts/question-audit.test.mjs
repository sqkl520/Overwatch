#!/usr/bin/env node
/**
 * question-audit.test.mjs — 提问形态审计与配置校验的回归测试。
 *
 * 这里守的每一条都对应一个**实测踩到过**的坑，不是设想的坑：
 *
 *   ① tool_use 重复行（全语料 33,090 行）——不去重就把「问了几次」算高 39%
 *   ② `input.questions` 是 JSON 字符串且解析失败（6 次）——当成 0 问是错的
 *   ③ 结构性探索（Glob/ls）算不算「读过项目」——漏了这一档会误判 PerfScope 那类会话
 *   ④ 子 agent 读的东西不在主 transcript 里——那时**判不了**，不许判成缺陷
 *   ⑤ fork 副本（182 份）——不合并就把同一个缺陷数 5 遍
 *   ⑥ 配置非法必须报错——本仓库吃过 `--days abc` 静默回落 7 天的亏
 *
 * 负向测试（判据被改坏就红）在每个 describe 块里都有，末尾单列。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  questionsOfAsk, normalizeText, scanSession, judgeReadFirst, judgeSession,
  summarize, validateConfig, loadConfig, defaultConfig, docTokenOverlap,
  nearDuplicateQuestions, formatReport, parseArgs, CONFIG_FILE, ASK_MODES,
  KNOWN_ROLES, AUTO_COMPLEX_FILES, AUTO_COMPLEX_TOOLCALLS,
  exitCodeFor, BLOCKING_CODES, ADVISORY_CODES,
} from './question-audit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'ow-qaudit-'));

// ── 构造 transcript 记录的小工具 ──────────────────────────────────────

let n = 0;
const use = (name, input, { id } = {}) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: id ?? `t${++n}`, name, input: input || {} }] },
});
const read = (path, opts) => use('Read', { file_path: path }, opts);
const glob = (pattern, opts) => use('Glob', { pattern }, opts);
const ask = (questions, opts) => use('AskUserQuestion', { questions }, opts);
const write = (path, opts) => use('Write', { file_path: path, content: 'x' }, opts);
const q = (text) => ({ question: text, header: 'h', multiSelect: false, options: [{ label: 'A' }] });

// ── ① tool_use 重复行 ─────────────────────────────────────────────────

test('scanSession 按 id 去重：同一 tool_use 的两行只算一次调用', () => {
  const s = scanSession([
    ask([q('要不要做？')], { id: 'dup' }),
    ask([q('要不要做？')], { id: 'dup' }),   // 宿主重写的第二行
  ]);
  assert.equal(s.askCalls, 1, '同一 id 只能算一次提问');
  assert.equal(s.toolCalls, 1, '调用次数也必须去重');
  assert.equal(s.duplicateCallLines, 1, '丢掉的行要计数，不许静默');
});

test('负向：去掉 id 去重会把提问次数算高——用两行同 id 的三次调用证明', () => {
  const recs = [ask([q('a1')], { id: 'x' }), ask([q('a1')], { id: 'x' }), ask([q('a2')], { id: 'y' })];
  assert.equal(scanSession(recs).askCalls, 2, '去重后是 2 次');
  // 若判据退化成「数行数」，这条会得到 3——所以它是负向保护。
  assert.notEqual(scanSession(recs).askCalls, 3);
});

// ── ② questions 的三种形态 ────────────────────────────────────────────

test('questionsOfAsk：数组形态取其长度', () => {
  const r = questionsOfAsk({ questions: [q('一'), q('二')] });
  assert.equal(r.form, 'array');
  assert.equal(r.unknown, false);
  assert.equal(r.questions.length, 2);
});

test('questionsOfAsk：JSON 字符串能解析时等价于数组形态', () => {
  const r = questionsOfAsk({ questions: JSON.stringify([q('一')]) });
  assert.equal(r.form, 'json-string');
  assert.equal(r.unknown, false);
  assert.equal(r.questions.length, 1);
});

test('questionsOfAsk：解析失败的字符串是「不知道」，不是 0 个问题', () => {
  const r = questionsOfAsk({ questions: '[{"question": "坏引号}]' });
  assert.equal(r.form, 'unparsable-string');
  assert.equal(r.unknown, true, '必须标成 unknown——当成 0 问会让 too-many-questions 永远不触发');
  assert.deepEqual(r.questions, []);
});

test('负向：unknown 的调用不参与 maxQuestions 判定', () => {
  const cfg = defaultConfig();
  const s = scanSession([ask('坏 JSON', { id: 'u' })]);
  assert.equal(s.questionsUnknownCalls, 1);
  const j = judgeSession(s, cfg);
  assert.ok(!j.violations.some((v) => v.code === 'too-many-questions'),
    '不知道问了几件，就不许判它超限');
});

test('questionsOfAsk：questions 字段缺席时标 unknown（不 pretend 成 0）', () => {
  const r = questionsOfAsk({});
  assert.equal(r.form, 'absent');
  assert.equal(r.unknown, true, '字段都没有，就是不知道问了几件');
  assert.deepEqual(r.questions, []);
});

// ── ③ 先读再问 ────────────────────────────────────────────────────────

test('judgeReadFirst：先 Read 后 Ask → read-first（两种口径都是）', () => {
  const s = scanSession([read('a.mjs'), ask([q('做吗？')])]);
  const v = judgeReadFirst(s);
  assert.equal(v.verdict.narrow, 'read-first');
  assert.equal(v.verdict.broad, 'read-first');
  assert.equal(v.verdict.effective, 'read-first');
});

test('judgeReadFirst：先 Ask 后 Read → 窄口径 ask-first', () => {
  const s = scanSession([ask([q('做吗？')]), read('a.mjs')]);
  const v = judgeReadFirst(s);
  assert.equal(v.verdict.narrow, 'ask-first');
  assert.equal(v.verdict.effective, 'ask-first');
});

test('judgeReadFirst：先 Glob 探索再 Ask → 宽口径 read-first、窄口径 no-read', () => {
  // 这是实测里 PerfScope 那类会话的形态：开场 Glob 项目目录，然后提问，一次都没 Read。
  const s = scanSession([glob('**/*.java'), ask([q('做吗？')])]);
  const v = judgeReadFirst(s);
  assert.equal(v.verdict.broad, 'read-first', 'Glob 是「了解项目文件夹状态」，宽口径必须认');
  assert.equal(v.verdict.narrow, 'no-read', '一个文件内容都没读，窄口径如实说 no-read');
  assert.equal(v.verdict.effective, 'read-first', '有效判据取对会话有利的那个');
});

test('负向：把结构性探索从宽口径里删掉，PerfScope 那类会被误判成缺陷', () => {
  const s = scanSession([glob('**/*'), ask([q('做吗？')])]);
  // 若判据退化成只看 anyRead，effective 会变 ask-first。
  assert.notEqual(judgeReadFirst(s).verdict.effective, 'ask-first');
});

test('judgeReadFirst：提问前有 Agent 派发且本地无读取证据 → unattributable（不判违规）', () => {
  const s = scanSession([
    use('Agent', { prompt: 'x' }), use('Agent', { prompt: 'y' }),
    ask([q('做吗？')]),
    read('a.mjs'),
  ]);
  const v = judgeReadFirst(s);
  assert.equal(v.verdict.effective, 'unattributable',
    '子 agent 读了什么不在主 transcript 里——「没读到」不等于「没有」');
  const j = judgeSession(s, defaultConfig());
  assert.ok(!j.violations.some((x) => x.code === 'read-first-violation'),
    'unattributable 不许计入违规');
});

test('负向：有 Agent 派发但本地已有读取证据时，不许拿它当挡箭牌', () => {
  const s = scanSession([read('a.mjs'), use('Agent', { prompt: 'x' }), ask([q('做吗？')])]);
  assert.equal(judgeReadFirst(s).verdict.effective, 'read-first',
    '先读过就是先读过，Agent 不能把已成立的事实改成「判不了」');
});

test('judgeReadFirst：没提问时是 no-ask，不是 read-first', () => {
  const s = scanSession([read('a.mjs')]);
  assert.equal(judgeReadFirst(s).verdict.effective, 'no-ask');
});

// ── ④ 判据可空性：副产品不许被当成读取 ────────────────────────────────

test('scanSession：只读过一次文件时，coveredRead 不成立（minReads=3）', () => {
  const s = scanSession([read('a.mjs'), read('a.mjs'), read('a.mjs')], { minReads: 3 });
  assert.equal(s.filesRead, 1, '同一个文件读三次仍是 1 个不同文件');
  assert.equal(s.firstRead.covered, -1, 'minReads 数的是不同文件');
});

test('scanSession：读过 3 个不同文件后 coveredRead 落在第 3 次', () => {
  const s = scanSession([read('a.mjs'), read('b.mjs'), read('c.mjs')], { minReads: 3 });
  assert.equal(s.filesRead, 3);
  assert.equal(s.firstRead.covered, 3);
});

test('negative：Read 之外的只读工具（Glob）不计入 filesRead', () => {
  const s = scanSession([glob('**/*.mjs')]);
  assert.equal(s.filesRead, 0, 'Glob 只算结构性探索，不算读过文件内容');
  assert.ok(s.firstRead.structural > 0, '但它必须记进 structural');
});

// ── ⑤ 配置校验：非法即报错 ────────────────────────────────────────────

const good = () => JSON.parse(JSON.stringify(defaultConfig()));

test('validateConfig：默认配置合法', () => {
  const r = validateConfig(good());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.config.ask.mode, 'always');
  assert.equal(r.config.ask.requireReadFirst, true);
});

test('validateConfig：默认是「问」，且 requireReadFirst 默认开', () => {
  const c = defaultConfig();
  assert.equal(c.ask.mode, 'always', '用户拍板：默认问，不问要显式关掉');
  assert.equal(c.ask.requireReadFirst, true);
  assert.equal(c.ask.maxQuestions, 5);
});

test('validateConfig：mode=never 合法（小众玩法），但必须同时关掉 requireReadFirst', () => {
  const c = good();
  c.ask.mode = 'never';
  c.ask.requireReadFirst = false;
  assert.equal(validateConfig(c).ok, true);
});

test('validateConfig 负向：mode=never 却 requireReadFirst=true → contradiction', () => {
  const c = good();
  c.ask.mode = 'never';
  c.ask.requireReadFirst = true;
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  assert.equal(r.config, null, '非法配置不许返回一份「凑合能用」的配置');
  assert.ok(r.errors.some((e) => e.code === 'contradiction'), JSON.stringify(r.errors));
});

test('validateConfig 负向：未知键必须报错（拼错的配置项不许静默忽略）', () => {
  const c = good();
  c.ask.requirReadFirst = false;   // 漏了一个 e
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'unknown-key' && e.path === 'ask.requirReadFirst'));
});

test('validateConfig 负向：顶层未知键与 agent 段未知键同样要报错', () => {
  const t = good(); t.asks = {};                     // 顶层拼错
  assert.ok(validateConfig(t).errors.some((e) => e.code === 'unknown-key' && e.path === 'asks'));
  const a = good(); a.agent.rosters = [];            // agent 段拼错
  assert.ok(validateConfig(a).errors.some((e) => e.code === 'unknown-key' && e.path === 'agent.rosters'));
});

test('validateConfig 负向：字符串数字必须报错，不做隐式转换', () => {
  const c = good();
  c.ask.maxQuestions = '5';
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'bad-range'));
});

test('validateConfig 负向：maxQuestions 越界与小数都拒绝', () => {
  for (const v of [0, -1, 21, 3.5, NaN, Infinity]) {
    const c = good();
    c.ask.maxQuestions = v;
    assert.equal(validateConfig(c).ok, false, `maxQuestions=${v} 应被拒绝`);
  }
});

test('validateConfig 负向：requireReadFirst 传字符串也拒绝', () => {
  const c = good();
  c.ask.requireReadFirst = 'yes';
  assert.equal(validateConfig(c).ok, false);
});

// `ask.minQuestionsBeforeWrite`（2026-11-19，写前闸的执行侧）。这三条守的是
// 「键白名单」与「执行侧取值范围」两处不会漂：`pre-write-gate.mjs` 的
// `MAX_MIN_QUESTIONS` 也是 20，两边任一改动都会在这些测试里红。
test('validateConfig：ask.minQuestionsBeforeWrite 缺省算 0（老配置不会突然变非法）', () => {
  const c = good();
  delete c.ask.minQuestionsBeforeWrite;
  const r = validateConfig(c);
  assert.equal(r.ok, true, `缺省不该报错：${JSON.stringify(r.errors)}`);
  assert.equal(r.config.ask.minQuestionsBeforeWrite, 0);
});

test('validateConfig：ask.minQuestionsBeforeWrite 接受 0..20 的整数', () => {
  for (const v of [0, 1, 3, 20]) {
    const c = good();
    c.ask.minQuestionsBeforeWrite = v;
    const r = validateConfig(c);
    assert.equal(r.ok, true, `${v} 应被接受：${JSON.stringify(r.errors)}`);
    assert.equal(r.config.ask.minQuestionsBeforeWrite, v);
  }
});

test('validateConfig 负向：ask.minQuestionsBeforeWrite 的越界 / 字符串 / 小数都拒绝', () => {
  for (const v of [-1, 21, '3', 2.5, null, true]) {
    const c = good();
    c.ask.minQuestionsBeforeWrite = v;
    const r = validateConfig(c);
    assert.equal(r.ok, false, `${JSON.stringify(v)} 应被拒绝`);
    assert.ok(r.errors.some((e) => e.code === 'bad-range' && e.path === 'ask.minQuestionsBeforeWrite'));
  }
});

test('负向：键白名单不会因为上面那三条放松 —— 拼错的 minQuestionsBeforeWrite 仍报 unknown-key', () => {
  const c = good();
  c.ask.minQuestionsBeforeWrites = 3;
  assert.ok(validateConfig(c).errors.some((e) => e.code === 'unknown-key' && e.path === 'ask.minQuestionsBeforeWrites'));
});

test('validateConfig 负向：未知角色名必须报错', () => {
  const c = good();
  c.agent.roster = ['oversight-executor', 'totally-made-up'];
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'unknown-role'));
});

test('validateConfig 负向：空 roster 与重复角色都拒绝', () => {
  const e = good(); e.agent.roster = [];
  assert.ok(validateConfig(e).errors.some((x) => x.code === 'bad-roster'));
  const d = good(); d.agent.roster = ['oversight-executor', 'oversight-executor'];
  assert.ok(validateConfig(d).errors.some((x) => x.code === 'duplicate-role'));
});

test('validateConfig 负向：缺 ask/agent 段要报错，不是补默认值', () => {
  const r = validateConfig({ version: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'missing-section' && e.path === 'ask'));
  assert.ok(r.errors.some((e) => e.code === 'missing-section' && e.path === 'agent'));
});

test('validateConfig 负向：version 必须是数字 1', () => {
  const c = good();
  c.version = '1';
  assert.equal(validateConfig(c).ok, false);
});

test('validateConfig 负向：根不是对象时报 bad-root', () => {
  for (const v of [null, [], 'x', 3]) {
    const r = validateConfig(v);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === 'bad-root'));
  }
});

// ── ⑥ loadConfig：文件不存在用默认，存在但坏了要报 ────────────────────

test('loadConfig：文件不存在 → 用内置默认（这是唯一允许的回落）', () => {
  const r = loadConfig(join(tmp(), 'nope.json'));
  assert.equal(r.found, false);
  assert.equal(r.config.ask.mode, 'always');
  assert.deepEqual(r.errors, []);
});

test('loadConfig 负向：JSON 坏了 → config 为 null，不回落', () => {
  const d = tmp();
  const p = join(d, 'bad.json');
  writeFileSync(p, '{ not json', 'utf8');
  const r = loadConfig(p);
  assert.equal(r.found, true);
  assert.equal(r.config, null);
  assert.ok(r.errors.some((e) => e.code === 'bad-json'));
  rmSync(d, { recursive: true, force: true });
});

test('loadConfig 负向：语义非法 → config 为 null，错误逐条列出', () => {
  const d = tmp();
  const p = join(d, 'c.json');
  writeFileSync(p, JSON.stringify({ version: 1, ask: { mode: 'sometimes' }, agent: { roster: [] } }), 'utf8');
  const r = loadConfig(p);
  assert.equal(r.config, null);
  assert.ok(r.errors.length >= 2, JSON.stringify(r.errors));
  rmSync(d, { recursive: true, force: true });
});

test('仓库根的 overwatch.config.json 必须存在且合法', () => {
  const r = loadConfig(join(REPO, CONFIG_FILE));
  assert.equal(r.found, true, `${CONFIG_FILE} 应当被提交（默认策略是被审计对象）`);
  assert.equal(r.config && r.config.ask.mode, 'always');
  assert.deepEqual(r.errors, []);
});

test('防漂的钉子：配置声明的 roles 集合 == 目录发现的集合', () => {
  // 这条钉子**换了钉的对象，防的还是同一件事**。
  //
  // 旧版钉的是「`KNOWN_ROLES` 字面量 vs 目录」。那个字面量已经不存在了（DF-044）：
  // `KNOWN_ROLES` 现在就是 `discoverRoles()` 的投影，拿它跟目录比对是拿同一份数据
  // 的两个视图互相比 —— 永远相等，什么都不防。
  //
  // 现在钉两端都**真的独立**：
  //   · 配置侧：`overwatch.config.json` 里手写的 `agent.roster`（人写的）
  //   · 目录侧：`.claude/agents/*.md` 实际存在哪些 .md（盘上的）
  // 语义仍然是「用户配了哪些岗位」必须真的存在。把它换成「注册表 vs 目录」会立刻退化。
  const dir = join(REPO, '.claude', 'agents');
  const onDisk = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort();

  const raw = JSON.parse(readFileSync(join(REPO, CONFIG_FILE), 'utf8'));
  const declared = [...(raw.agent && Array.isArray(raw.agent.roster) ? raw.agent.roster : [])].sort();
  assert.ok(declared.length, '配置里必须有 roster —— 空 roster 等于没有可派发的岗位');

  const missing = declared.filter((r) => !onDisk.includes(r));
  assert.deepEqual(missing, [],
    `配置声明了 ${missing.join(', ')}，而 .claude/agents/ 下没有这些 .md —— `
    + '启动时会「只挂启用的 N 个」然后挂出几个不存在的角色，用户只看到会话里少了人');

  // 反向也要钉：`KNOWN_ROLES` 是**给配置校验用的合法值全集**，它必须覆盖盘上全部角色，
  // 否则「新增一个角色」与「把它写进 roster」之间会隔着一道没有报错的门。
  const notKnown = onDisk.filter((f) => !KNOWN_ROLES.includes(f));
  assert.deepEqual(notKnown, [],
    `这些 .md 存在但不在 KNOWN_ROLES 里：${notKnown.join(', ')} —— 写进 roster 会被判 unknown-role`);
});

test('ASK_MODES 恰好是 always / never / auto 三个', () => {
  assert.deepEqual([...ASK_MODES], ['always', 'never', 'auto']);
});

// ── ⑦ judgeSession：三种 mode 的行为 ──────────────────────────────────

test('judgeSession mode=always：写了文件却零提问 → zero-ask', () => {
  const s = scanSession([write('a.mjs'), write('b.mjs')]);
  const j = judgeSession(s, defaultConfig());
  assert.ok(j.violations.some((v) => v.code === 'zero-ask'));
});

test('judgeSession mode=never：零提问不是缺陷（这就是「测模型质量」的玩法）', () => {
  const cfg = defaultConfig();
  cfg.ask.mode = 'never';
  cfg.ask.requireReadFirst = false;
  const s = scanSession([write('a.mjs')]);
  const j = judgeSession(s, cfg);
  assert.deepEqual(j.violations, []);
});

test('judgeSession mode=auto：简单会话免检，复杂会话照判', () => {
  const cfg = defaultConfig();
  cfg.ask.mode = 'auto';
  // 简单：写 1 个文件、9 次调用
  const simple = scanSession([
    write('a.mjs'), read('a.mjs'), read('b.mjs'), read('c.mjs'),
    use('Bash', { command: 'a' }), use('Bash', { command: 'b' }),
    use('Bash', { command: 'c' }), use('Bash', { command: 'd' }), use('Bash', { command: 'e' }),
  ]);
  assert.ok(simple.toolCalls < AUTO_COMPLEX_TOOLCALLS && simple.filesWritten < AUTO_COMPLEX_FILES);
  assert.deepEqual(judgeSession(simple, cfg).violations, [], '简单会话不判 zero-ask');

  // 复杂：写 ≥ AUTO_COMPLEX_FILES 个文件
  const recs = [];
  for (let i = 0; i < AUTO_COMPLEX_FILES; i++) recs.push(write(`f${i}.mjs`));
  const complex = scanSession(recs);
  assert.ok(judgeSession(complex, cfg).violations.some((v) => v.code === 'zero-ask'));
});

test('负向：mode=auto 的阈值常量被改小会让简单会话也报违规', () => {
  // 这条钉住「阈值是实测常量，不是随手写的」。若有人把阈值改成 0，
  // 下面这个本该免检的会话就会报 zero-ask。
  const cfg = defaultConfig();
  cfg.ask.mode = 'auto';
  const s = scanSession([write('a.mjs')]);
  assert.deepEqual(judgeSession(s, cfg).violations, []);
  assert.ok(AUTO_COMPLEX_FILES > 1);
});

test('judgeSession：maxQuestions 是每次调用的上限，不是整场总额', () => {
  const cfg = defaultConfig();          // maxQuestions = 5
  // 两次调用各问 3 个：总额 6 > 5，但每次都没超
  const s = scanSession([ask([q('1'), q('2'), q('3')]), ask([q('4'), q('5'), q('6')])]);
  assert.equal(s.questionsKnown, 6);
  const j = judgeSession(s, cfg);
  assert.ok(!j.violations.some((v) => v.code === 'too-many-questions'),
    '用户原话是「一次问清最多 5 个」——按整场总额判会误伤迭代提问');

  // 一次问 6 个才算超
  const over = scanSession([ask([q('1'), q('2'), q('3'), q('4'), q('5'), q('6')])]);
  assert.ok(judgeSession(over, cfg).violations.some((v) => v.code === 'too-many-questions'));
});

test('judgeSession：requireReadFirst=false 时不报 read-first-violation', () => {
  const cfg = defaultConfig();
  cfg.ask.requireReadFirst = false;
  const s = scanSession([ask([q('做吗？')]), read('a.mjs')]);
  assert.ok(!judgeSession(s, cfg).violations.some((v) => v.code === 'read-first-violation'));
  // 开着就必须报
  assert.ok(judgeSession(s, defaultConfig()).violations.some((v) => v.code === 'read-first-violation'));
});

// ── ⑧ 启发式必须自陈是启发式 ──────────────────────────────────────────

test('docTokenOverlap：文档里出现过的标识符会被数出来', () => {
  const docs = new Set(['claude.md', 'readme.md']);
  const r = docTokenOverlap('要不要改 README.md？', docs);
  assert.ok(r);
  assert.equal(r.ratio, 1);
});

test('docTokenOverlap：没有 ASCII 标识符的问题返回 null（不假装算过）', () => {
  assert.equal(docTokenOverlap('这个功能怎么做？', new Set(['x'])), null);
});

test('docTokenOverlap 负向：中文不做分词——两个中文问句不会被判成重叠', () => {
  // 若有人给它加中文二元组，这条会红。理由：中文二元组会把「怎么处理」和「怎么弄」
  // 判成高度重合，那种假阳性会让指标失去意义。
  const docs = new Set(['claude.md']);
  assert.equal(docTokenOverlap('这个怎么处理？', docs), null);
});

test('nearDuplicateQuestions：会话内近乎逐字重复能被找出来', () => {
  const pairs = nearDuplicateQuestions([
    '要不要现在就把推送做成一条命令？',
    '要不要现在就把推送做成一条命令呢？',
    '下一步做什么？',
  ]);
  assert.equal(pairs.length, 1, JSON.stringify(pairs));
  assert.ok(pairs[0].ratio >= 0.8);
});

test('nearDuplicateQuestions 负向：两个不相关的问题不构成重复', () => {
  assert.deepEqual(nearDuplicateQuestions(['要不要推送到 GitHub？', '测试为什么失败？']), []);
});

// ── ⑨ 汇总与报告 ──────────────────────────────────────────────────────

test('summarize：按 effective 判据分桶，且 narrow 单独计数', () => {
  const rows = [
    { session: scanSession([read('a.mjs'), ask([q('x')])]) },   // read-first
    { session: scanSession([ask([q('x')]), read('a.mjs')]) },   // ask-first
    { session: scanSession([read('a.mjs')]) },                  // no-ask
  ];
  const s = summarize(rows, defaultConfig());
  assert.equal(s.sessions, 3);
  assert.equal(s.withAsk, 2);
  assert.equal(s.verdicts['read-first'], 1);
  assert.equal(s.verdicts['ask-first'], 1);
  assert.equal(s.verdicts['no-ask'], 1);
  assert.equal(s.narrowVerdicts['read-first'], 1);
});

test('summarize 负向：空输入不崩，且分母为 0 时百分比不产生 NaN', () => {
  const s = summarize([], defaultConfig());
  assert.equal(s.sessions, 0);
  const txt = formatReport({ summary: { ...s, scannedFiles: 0, unreadableFiles: 0 } }, {});
  assert.ok(!/NaN/.test(txt), '分母为 0 时输出里不许出现 NaN');
});

test('formatReport：语料为空时明确说「给不出结论」，不说「一切正常」', () => {
  const s = summarize([], defaultConfig());
  const txt = formatReport({ summary: { ...s, scannedFiles: 0, unreadableFiles: 0 } }, {});
  assert.match(txt, /给不出结论/);
  assert.ok(!/未被违反/.test(txt), '没有数据就不许说「未被违反」');
});

test('formatReport：有违规时结论里必须出现那个数字', () => {
  const rows = [{ session: scanSession([ask([q('x')]), read('a.mjs')]) }];
  const s = summarize(rows, defaultConfig());
  const txt = formatReport({ summary: { ...s, scannedFiles: 1, unreadableFiles: 0 } }, { cfg: defaultConfig() });
  assert.match(txt, /1 个没读就问/);
});

test('formatReport：mode=never 时必须写明「零提问不是缺陷」', () => {
  const cfg = defaultConfig();
  cfg.ask.mode = 'never';
  cfg.ask.requireReadFirst = false;
  const s = summarize([{ session: scanSession([write('a.mjs')]) }], cfg);
  const txt = formatReport({ summary: { ...s, scannedFiles: 1, unreadableFiles: 0 } }, { cfg });
  assert.match(txt, /零提问不是缺陷/);
});

// ── ⑩ 命令行：非法参数不回落 ──────────────────────────────────────────

test('parseArgs：--days abc 记为错误，不回落默认值', () => {
  const a = parseArgs(['--days', 'abc']);
  assert.ok(a._err, '必须报错——本仓库吃过 `--days abc` 静默回落 7 天的亏');
  assert.equal(a.days, undefined);
});

test('parseArgs：正常参数被正确解析', () => {
  const a = parseArgs(['--days', '3', '--json', '--root', '/x']);
  assert.equal(a.days, 3);
  assert.equal(a.json, true);
  assert.equal(a.root, '/x');
  assert.equal(a._err, undefined);
});

test('parseArgs 负向：未知参数报错', () => {
  assert.ok(parseArgs(['--nonsense', '1'])._err);
});

test('parseArgs 负向：--days 缺值报错', () => {
  assert.ok(parseArgs(['--days'])._err);
});

// ── ⑪ 端到端：CLI 的退出码 ────────────────────────────────────────────

test('CLI：语料目录不存在 → 退出码 2（不返回空结果冒充「一切正常」）', () => {
    const code = cli(['--root', join(tmp(), 'definitely-not-here')]);
  assert.equal(code, 2);
});

test('CLI：配置非法 → 退出码 2（不回落默认值）', () => {
  const d = tmp();
  const p = join(d, 'bad.json');
  writeFileSync(p, JSON.stringify({ version: 1, ask: { mode: 'sometimes' }, agent: { roster: ['x'] } }), 'utf8');
    const code = cli(['--config', p, '--root', d]);
  assert.equal(code, 2);
  rmSync(d, { recursive: true, force: true });
});

test('CLI：干净语料 → 退出码 0', () => {
  const d = tmp();
  mkdirSync(join(d, 'proj'), { recursive: true });
  const rec = (blocks, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: blocks } });
  writeFileSync(join(d, 'proj', 's.jsonl'), [
    rec([{ type: 'tool_use', id: 'x1', name: 'Read', input: { file_path: 'a.mjs' } }], '2026-01-01T00:00:00Z'),
    rec([{ type: 'tool_use', id: 'x2', name: 'AskUserQuestion', input: { questions: [{ question: '做吗？' }] } }], '2026-01-01T00:01:00Z'),
  ].join('\n') + '\n', 'utf8');
    assert.equal(cli(['--root', d]), 0);
  rmSync(d, { recursive: true, force: true });
});

test('CLI：有 read-first 违规 → 退出码 1', () => {
  const d = tmp();
  mkdirSync(join(d, 'proj'), { recursive: true });
  const rec = (blocks, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: blocks } });
  writeFileSync(join(d, 'proj', 's.jsonl'), [
    rec([{ type: 'tool_use', id: 'y1', name: 'AskUserQuestion', input: { questions: [{ question: '做吗？' }] } }], '2026-01-01T00:00:00Z'),
    rec([{ type: 'tool_use', id: 'y2', name: 'Read', input: { file_path: 'a.mjs' } }], '2026-01-01T00:01:00Z'),
  ].join('\n') + '\n', 'utf8');
    assert.equal(cli(['--root', d]), 1);
  rmSync(d, { recursive: true, force: true });
});

test('CLI：只有 zero-ask → 退出码 0（描述不阻塞），--strict 才变 1', () => {
  const d = tmp();
  mkdirSync(join(d, 'proj'), { recursive: true });
  writeFileSync(join(d, 'proj', 's.jsonl'),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'a.mjs', content: 'x' } }] } }) + '\n',
    'utf8');
  assert.equal(cli(['--root', d]), 0,
    'zero-ask 是现状描述（本机 68% 的会话都这样），让它阻塞等于让这道门永远红');
  assert.equal(cli(['--root', d, '--strict']), 1, '--strict 时升级为阻塞');
  rmSync(d, { recursive: true, force: true });
});

test('exitCodeFor：只有阻塞码才返回 1', () => {
  assert.equal(exitCodeFor({}), 0);
  assert.equal(exitCodeFor({ 'zero-ask': 100 }), 0);
  assert.equal(exitCodeFor({ 'zero-ask': 100 }, { strict: true }), 1);
  assert.equal(exitCodeFor({ 'read-first-violation': 1 }), 1);
  assert.equal(exitCodeFor({ 'too-many-questions': 1 }), 1);
});

test('负向：zero-ask 不在阻塞集合里（若被挪进去这条会红）', () => {
  assert.ok(!BLOCKING_CODES.includes('zero-ask'),
    'zero-ask 是描述不是判据——理由见 CLAUDE.md「其余状态是描述，不是判据」');
  assert.ok(ADVISORY_CODES.includes('zero-ask'));
});

test('CLI：--json 输出可解析且带 summary 与 rows', () => {
  const d = tmp();
  mkdirSync(join(d, 'proj'), { recursive: true });
  writeFileSync(join(d, 'proj', 's.jsonl'),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'z1', name: 'Read', input: { file_path: 'a.mjs' } }] } }) + '\n',
    'utf8');
    const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try { cli(['--root', d, '--json']); } finally { console.log = orig; }
  const j = JSON.parse(logs.join('\n'));
  assert.ok(j.summary);
  assert.ok(Array.isArray(j.rows));
  assert.equal(j.config.found, true, '仓库根的配置应当被读到');
  rmSync(d, { recursive: true, force: true });
});

/** `cli` 在同一进程里跑到返回码就返回，不调 `process.exit`，所以测试可以直接调它。 */
import { cli } from './question-audit.mjs';

// ── ⑫ fork 去重（复用 observe-reality-check 的判据）───────────────────

test('scanCorpus：fork 副本会被合并，同一个缺陷不会数两遍', async () => {
  const { scanCorpus } = await import('./question-audit.mjs');
  const d = tmp();
  const mk = (name, toolIds) => {
    mkdirSync(join(d, 'proj'), { recursive: true });
    const rec = (b) => JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { content: b } });
    const lines = [];
    // 足够多的相同调用让 seq 前缀一致（dedupeForks 要求 minCommon 条）
    for (let i = 0; i < 40; i++) {
      lines.push(rec([{ type: 'tool_use', id: `${toolIds}-${i}`, name: 'Read', input: { file_path: `f${i}.mjs` } }]));
    }
    lines.push(rec([{ type: 'tool_use', id: `${toolIds}-ask`, name: 'AskUserQuestion', input: { questions: [{ question: '做吗？' }] } }]));
    writeFileSync(join(d, 'proj', `${name}.jsonl`), lines.join('\n') + '\n', 'utf8');
  };
  mk('a', 'same');
  mk('b', 'same');
  writeFileSync(join(d, 'proj', 'c.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-02T00:00:00Z', message: { content: [{ type: 'tool_use', id: 'other', name: 'Read', input: { file_path: 'z.mjs' } }] } }) + '\n',
    'utf8');
  const r = scanCorpus({ root: d, cfg: defaultConfig() });
  assert.equal(r.error, null);
  assert.ok(r.summary.forkCopiesMerged >= 1, '两份前缀相同的会话必须被合并成一份');
  rmSync(d, { recursive: true, force: true });
});

test('scanCorpus 负向：语料目录不存在返回 error，不是空 summary', async () => {
  const { scanCorpus } = await import('./question-audit.mjs');
  const r = scanCorpus({ root: join(tmp(), 'nope') });
  assert.ok(r.error && /不存在/.test(r.error));
  assert.equal(r.summary, null);
});

// ── ⑬ 归一化 ──────────────────────────────────────────────────────────

test('normalizeText：去标点去空白并小写', () => {
  assert.equal(normalizeText('  A b，C。'), 'abc');
  assert.equal(normalizeText(''), '');
});

test('负向总表：每条判据被削掉都会红', () => {
  // 这一条本身不做断言，它是一张清单，让读者能核对上面的负向覆盖是否齐全。
  const guards = [
    'id 去重', 'questions 字符串形态', 'unknown 不参与 maxQuestions',
    '结构性探索算宽口径', 'Agent 派发 → unattributable',
    'mode=never 合法', 'mode=never+requireReadFirst → contradiction',
    '未知键报错', '字符串数字报错', '未知角色报错',
    'maxQuestions 按次不按总额', '--days abc 报错', '语料缺失退出码 2',
  ];
  assert.equal(guards.length, 13);
});
