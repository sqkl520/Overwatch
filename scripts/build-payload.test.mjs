#!/usr/bin/env node
/**
 * build-payload.test.mjs — 「plugin 载荷与源同源」的回归测试。
 *
 * 这份测试守的不是文件生成，而是**ADR-0003 §5.2 那条代价**：
 *
 *   > 两份形态一旦漂移，漂移的那份没人测。
 *
 * 所以七组里最重要的一组是第 4 组（负向）。前几组都能在「有人把载荷改成手抄一份」
 * 之后照样全绿 —— 只有反向断言会红。具体地：
 *   - 改源 → 不重建，`--check` 必须红（只比 plugin.json 是看不出来的）
 *   - 改载荷文件的一个字节 → 必须红（哈希那一层）
 *   - 往载荷里手工塞一个文件 → 必须红（这就是第二真源的起点）
 *   - 手改清单去迁就漂移 → 必须红（清单自洽那一层）
 *
 * 全部用例**不 spawn `claude`**：命令行的可用性随机器/登录态变化，把它写进单测
 * 会让 `node --test` 变成依赖环境的测试。布局契约（agents 只认一层、skills 只认
 * 「目录 + SKILL.md」、plugin.json 四字段）已由 `docs/design/2026-11-14-payload-generation.md`
 * 的实测表固定下来，这里把它们写成断言，Claude 侧的真机确认在真跑一次生成时做。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  PAYLOAD_VERSION, MANIFEST_FILE, PLUGIN_NAME, DEFAULT_OUT,
  defaultOutDir, summarizeSources, payloadDigest, pluginManifest, pluginManifestBytes,
  planPayload, buildPayload, checkPayload, parseArgv, main, verifyPluginRoot,
} from './build-payload.mjs';

// ── 夹具 ──────────────────────────────────────────────────────────────

const tmp = () => mkdtempSync(join(tmpdir(), 'ow-payload-'));

const AGENT = (name, extra = '') => `---
name: ${name}
description: 测试用的角色定义，正文无所谓，只要 frontmatter 完整。
tools: Read
---
你是 ${name}。${extra}
`;

/** 造一棵最小源树：2 个 agent + 1 个 skill（skill 目录里带一个附件）。 */
function makeSource({ agents = ['oversight-alpha', 'oversight-beta'], skills = ['oversight'] } = {}) {
  const root = tmp();
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  for (const a of agents) writeFileSync(join(root, '.claude', 'agents', `${a}.md`), AGENT(a));
  for (const s of skills) {
    mkdirSync(join(root, '.claude', 'skills', s), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', s, 'SKILL.md'),
      `---\nname: ${s}\ndescription: 测试 skill。\n---\n\n# ${s}\n`);
    writeFileSync(join(root, '.claude', 'skills', s, 'notes.md'), `# ${s} 的附件\n`);
  }
  return root;
}

const cleanup = (dir) => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };

// ── 1. 源 → 清单 ──────────────────────────────────────────────────────

test('summarizeSources：agents 平铺进 agents/，skill 整目录进 skills/<名>/', () => {
  const root = makeSource();
  const { files, problems } = summarizeSources(root);
  assert.deepEqual(problems, []);
  assert.deepEqual(files.map((f) => f.path).sort(), [
    'agents/oversight-alpha.md',
    'agents/oversight-beta.md',
    'skills/oversight/SKILL.md',
    'skills/oversight/notes.md',
  ]);
  cleanup(root);
});

test('summarizeSources：agents 子目录必须报错（plugin 的 agents/ 只认一层）', () => {
  const root = makeSource();
  mkdirSync(join(root, '.claude', 'agents', 'nested'));
  writeFileSync(join(root, '.claude', 'agents', 'nested', 'deep.md'), AGENT('deep'));
  const { problems } = summarizeSources(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /是子目录/);
  cleanup(root);
});

test('summarizeSources：skills 下的平铺 .md 必须报错（不会被宿主识别成 skill）', () => {
  const root = makeSource();
  writeFileSync(join(root, '.claude', 'skills', 'flat.md'), '---\nname: flat\n---\n');
  const { problems } = summarizeSources(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /平铺文件/);
  cleanup(root);
});

test('summarizeSources：skill 目录缺 SKILL.md 必须报错，不许静默跳过', () => {
  const root = makeSource();
  mkdirSync(join(root, '.claude', 'skills', 'empty'));
  writeFileSync(join(root, '.claude', 'skills', 'empty', 'x.md'), 'x');
  const { problems } = summarizeSources(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /缺 SKILL\.md/);
  cleanup(root);
});

test('summarizeSources：源树为空时明确说「一个 agent 都没有」，不生成半份载荷', () => {
  const root = tmp();
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
  const { problems } = summarizeSources(root);
  assert.ok(problems.some((p) => p.includes('一个 agent 都没有')));
  assert.ok(problems.some((p) => p.includes('一个 skill 都没有')));
  cleanup(root);
});

// ── 2. 摘要与版本 ─────────────────────────────────────────────────────

test('payloadDigest：同一份内容 → 同一个摘要；改一个字节 → 摘要变', () => {
  const a = [{ source: '.claude/agents/a.md', sha256: 'aa' }, { source: '.claude/agents/b.md', sha256: 'bb' }];
  const b = [{ source: '.claude/agents/b.md', sha256: 'bb' }, { source: '.claude/agents/a.md', sha256: 'aa' }];
  assert.equal(payloadDigest(a), payloadDigest(b), '顺序不同必须同摘要（内部排序）');

  const c = [{ source: '.claude/agents/a.md', sha256: 'aa' }, { source: '.claude/agents/b.md', sha256: 'bc' }];
  assert.notEqual(payloadDigest(a), payloadDigest(c));
});

test('payloadDigest：空输入也要给一个确定值，不抛', () => {
  assert.equal(payloadDigest([]), payloadDigest([]));
  assert.equal(payloadDigest(null), payloadDigest([]));
  assert.match(payloadDigest([]), /^[0-9a-f]{64}$/);
});

test('pluginManifest：name 必填且固定；version 是合法 semver 的 build metadata 形态', () => {
  const m = pluginManifest('0123456789abcdef'.repeat(4));
  assert.equal(m.name, PLUGIN_NAME);
  assert.equal(m.version, '0.0.0+g0123456789ab');
  // 实测：`claude plugin validate --strict` 只强制 name，但缺 version/description/author
  // 会打警告，而 --strict 把警告当错误。所以四个字段一个都不能少。
  for (const k of ['name', 'version', 'description', 'author']) {
    assert.ok(m[k], `plugin.json 必须带 ${k}`);
  }
  // 版本号不得含 git 信息：那样每提交一次 --check 就红一次，红得没道理。
  assert.doesNotMatch(m.version, /5b26702|HEAD|dirty/);
  assert.deepEqual(Object.keys(m).sort(), ['author', 'description', 'name', 'version']);
});

test('pluginManifestBytes：确定性（LF、两空格、结尾换行）', () => {
  const s = pluginManifestBytes('f'.repeat(64));
  assert.ok(s.endsWith('}\n'));
  assert.ok(!s.includes('\r'));
  assert.equal(s, pluginManifestBytes('f'.repeat(64)));
});

test('planPayload：读不到源文件记进 problems，不抛异常', () => {
  const root = makeSource();
  const plan = planPayload({ root });
  assert.equal(plan.rows.length, 4);
  assert.deepEqual(plan.problems, []);
  // 删掉一个源文件后重算：不是抛，是把问题列出来
  rmSync(join(root, '.claude', 'agents', 'oversight-beta.md'));
  const after = planPayload({ root });
  assert.equal(after.rows.length, 3);
  assert.notEqual(after.digest, plan.digest);
  cleanup(root);
});

// ── 3. 生成 ───────────────────────────────────────────────────────────

test('buildPayload：产物含 plugin.json / agents / skills / 清单，且清单能对上源', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  const r = buildPayload({ root, out });
  assert.equal(r.ok, true, r.problems.join('; '));

  assert.ok(existsSync(join(out, '.claude-plugin', 'plugin.json')));
  assert.ok(existsSync(join(out, MANIFEST_FILE)));
  assert.deepEqual(r.written.sort(), [
    '.claude-plugin/plugin.json',
    'agents/oversight-alpha.md',
    'agents/oversight-beta.md',
    MANIFEST_FILE,
    'skills/oversight/SKILL.md',
    'skills/oversight/notes.md',
  ].sort());

  const manifest = JSON.parse(readFileSync(join(out, MANIFEST_FILE), 'utf8'));
  assert.equal(manifest.payloadVersion, PAYLOAD_VERSION);
  assert.equal(manifest.generator, 'scripts/build-payload.mjs');
  assert.equal(manifest.sourceDigest, r.digest);
  assert.ok(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
  cleanup(root);
});

test('buildPayload：先清空目标目录 —— 残留的旧 agent 不许留着', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  mkdirSync(join(out, 'agents'), { recursive: true });
  writeFileSync(join(out, 'agents', 'stale-agent.md'), AGENT('stale-agent'));

  buildPayload({ root, out });
  assert.equal(existsSync(join(out, 'agents', 'stale-agent.md')), false,
    '上一次生成留下的 agent 必须被清掉，否则它在 plugin list 里照样显示 loaded');
  cleanup(root);
});

test('buildPayload：同一份源连产两次，逐字节相同（可复现）', () => {
  const root = makeSource();
  const a = join(root, 'dist', 'a');
  const b = join(root, 'dist', 'b');
  buildPayload({ root, out: a });
  buildPayload({ root, out: b });
  for (const rel of ['payload-manifest.json', '.claude-plugin/plugin.json', 'agents/oversight-alpha.md']) {
    assert.equal(readFileSync(join(a, rel), 'utf8'), readFileSync(join(b, rel), 'utf8'), rel);
  }
  cleanup(root);
});

test('buildPayload：源树有问题时一件都不写（不许产出半份载荷）', () => {
  const root = makeSource();
  mkdirSync(join(root, '.claude', 'agents', 'nested'));
  writeFileSync(join(root, '.claude', 'agents', 'nested', 'deep.md'), AGENT('deep'));
  const out = join(root, DEFAULT_OUT);
  const r = buildPayload({ root, out });
  assert.equal(r.ok, false);
  assert.equal(existsSync(join(out, '.claude-plugin', 'plugin.json')), false);
  cleanup(root);
});

// ── 4. 负向：漂移必须被抓到（本文件最重要的一组）────────────────────────

test('负向：源改了但载荷没重建 → --check 红，并点名改了哪个文件', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  buildPayload({ root, out });
  assert.equal(checkPayload({ root, out }).ok, true);

  writeFileSync(join(root, '.claude', 'agents', 'oversight-alpha.md'), AGENT('oversight-alpha', '加了半个字。'));
  const r = checkPayload({ root, out });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('源变了但载荷没重建')), r.reasons.join('\n'));
  assert.ok(r.reasons.some((x) => x.includes('agents/oversight-alpha.md')), '必须点名是哪个文件漂了');
  cleanup(root);
});

test('负向：源删了一个 agent → --check 也必须红（只比 plugin.json 会漏）', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  buildPayload({ root, out });
  rmSync(join(root, '.claude', 'agents', 'oversight-beta.md'));
  const r = checkPayload({ root, out });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('oversight-beta.md')), r.reasons.join('\n'));
  cleanup(root);
});

test('负向：载荷里的一个字节被改 → 红（哈希那一层）', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  buildPayload({ root, out });
  const f = join(out, 'agents', 'oversight-alpha.md');
  const text = readFileSync(f, 'utf8');
  writeFileSync(f, text.replace('你是', '你是被改过的'));
  const r = checkPayload({ root, out });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('载荷文件被改过')), r.reasons.join('\n'));
  cleanup(root);
});

test('负向：往载荷里手工塞一个文件 → 红（这就是第二真源的开头）', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  buildPayload({ root, out });
  writeFileSync(join(out, 'agents', 'handwritten.md'), AGENT('handwritten'));
  const r = checkPayload({ root, out });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('清单外的文件') && x.includes('handwritten.md')), r.reasons.join('\n'));
  cleanup(root);
});

test('负向：手改清单的 sourceDigest 去迁就漂移 → 红（清单自洽那一层）', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  buildPayload({ root, out });
  const mf = join(out, MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(mf, 'utf8'));

  // 真把源改掉，再把 sourceDigest 改成新值 —— 这样「源 vs 清单」那条判据就被骗过去了。
  // 但 files 表还是旧的，所以「清单自己跟自己」那条必须把它抓住。
  writeFileSync(join(root, '.claude', 'agents', 'oversight-alpha.md'), AGENT('oversight-alpha', '漂移了'));
  manifest.sourceDigest = planPayload({ root }).digest;
  writeFileSync(mf, JSON.stringify(manifest, null, 2) + '\n');

  const r = checkPayload({ root, out });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('自相矛盾')), r.reasons.join('\n'));
  cleanup(root);
});

test('负向：连 files 表一起伪造 → 仍红（plugin.json 的版本号那一层）', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  buildPayload({ root, out });
  const mf = join(out, MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(mf, 'utf8'));

  // 把源、清单、载荷全部改成「一致的新状态」，一步不落 —— 这是对手能做到的最强伪造。
  writeFileSync(join(root, '.claude', 'agents', 'oversight-alpha.md'), AGENT('oversight-alpha', '漂移了'));
  const plan = planPayload({ root });
  manifest.sourceDigest = plan.digest;
  manifest.files = plan.rows.map((r) => ({ path: r.path, source: r.source, bytes: r.bytes, sha256: r.sha256 }));
  writeFileSync(mf, JSON.stringify(manifest, null, 2) + '\n');
  for (const r of plan.rows) writeFileSync(join(out, r.path), r.buf);

  // 此时前五条判据全过，只剩 plugin.json 里的版本号与内容脱钩。
  const r = checkPayload({ root, out });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('plugin.json 与当前源不符')), r.reasons.join('\n'));
  cleanup(root);
});

test('负向：plugin.json 的版本号被改回旧值 → 红', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  buildPayload({ root, out });
  const pj = join(out, '.claude-plugin', 'plugin.json');
  const obj = JSON.parse(readFileSync(pj, 'utf8'));
  obj.version = '0.0.0+g000000000000';
  writeFileSync(pj, JSON.stringify(obj, null, 2) + '\n');
  const r = checkPayload({ root, out });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('plugin.json 与当前源不符')), r.reasons.join('\n'));
  cleanup(root);
});

test('负向：plugin.json 带未登记字段 → 红（--strict 会把它判成错误）', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  buildPayload({ root, out });
  const pj = join(out, '.claude-plugin', 'plugin.json');
  const obj = JSON.parse(readFileSync(pj, 'utf8'));
  obj['x-overwatch'] = { note: '自证信息不许进 plugin.json' };
  writeFileSync(pj, JSON.stringify(obj, null, 2) + '\n');
  const r = checkPayload({ root, out });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('未登记字段')), r.reasons.join('\n'));
  cleanup(root);
});

test('负向：载荷目录不存在 → 红，且说的是「不存在」而不是「同源」', () => {
  const root = makeSource();
  const out = join(root, 'dist', 'never-built');
  const r = checkPayload({ root, out });
  assert.equal(r.ok, false);
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /不存在/);
  cleanup(root);
});

test('负向：载荷里缺一个文件 → 红', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  buildPayload({ root, out });
  rmSync(join(out, 'skills', 'oversight', 'notes.md'));
  const r = checkPayload({ root, out });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('载荷缺文件')), r.reasons.join('\n'));
  cleanup(root);
});

// ── 5. CLI 契约 ───────────────────────────────────────────────────────

test('parseArgv：--key value / --flag / 位置参数分得开', () => {
  assert.deepEqual(parseArgv(['--out', '/x', '--check']), { out: '/x', check: true });
  assert.deepEqual(parseArgv(['--out', '--check']), { out: true, check: true }, '--out 后面跟 --check 表示它没值');
  assert.deepEqual(parseArgv(['pos']), { _: ['pos'] });
  assert.deepEqual(parseArgv([]), {});
});

test('defaultOutDir：默认落在 dist/payload，且是可被 .gitignore 命中的位置', () => {
  const p = defaultOutDir('/repo');
  assert.ok(p.endsWith(join('dist', 'payload')) || p.endsWith('dist/payload'));
  assert.ok(p.startsWith('/repo') || p.includes('repo'));
});

function runCli(args, { root, out } = {}) {
  const base = [join(process.cwd(), 'scripts', 'build-payload.mjs')];
  if (root) base.push('--root', root);
  if (out) base.push('--out', out);
  const r = spawnSync(process.execPath, [...base, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('CLI：--print-dir 只打印路径，不写盘', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  const r = runCli(['--print-dir'], { root });
  assert.equal(r.code, 0);
  assert.ok(r.out.trim().length > 0);
  assert.equal(existsSync(out), false, '--print-dir 不许有副作用');
  cleanup(root);
});

test('CLI：生成后 --check 退 0，源变了退 1', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  assert.equal(runCli([], { root, out }).code, 0);
  assert.equal(runCli(['--check'], { root, out }).code, 0);

  writeFileSync(join(root, '.claude', 'agents', 'oversight-alpha.md'), AGENT('oversight-alpha', '漂移'));
  const bad = runCli(['--check'], { root, out });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /不同源/);

  assert.equal(runCli([], { root, out }).code, 0);
  assert.equal(runCli(['--check'], { root, out }).code, 0);
  cleanup(root);
});

test('CLI：--check --json 输出机器可读的 reasons', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  const r = runCli(['--check', '--json'], { root, out });
  assert.equal(r.code, 1);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.ok, false);
  assert.ok(Array.isArray(parsed.reasons) && parsed.reasons.length > 0);
  cleanup(root);
});

test('CLI：未知参数退 2（用法错误），不是 1（自身 bug）', () => {
  const root = makeSource();
  const r = runCli(['--nope'], { root });
  assert.equal(r.code, 2);
  assert.match(r.err, /未知参数/);
  cleanup(root);
});

test('CLI：main 直接调用与 spawn 的退出码一致', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  assert.equal(main(['--root', root, '--out', out]), 0);
  assert.equal(main(['--root', root, '--out', out, '--check']), 0);
  assert.equal(main(['--root', root, '--out', out, '--bogus']), 2);
  cleanup(root);
});

// ── 6. 布局契约（实测结论的回归）────────────────────────────────────────

test('布局契约：plugin.json 在 .claude-plugin/ 下，agents/ 与 skills/ 在 plugin 根', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  buildPayload({ root, out });
  const entries = readdirSync(out).sort();
  assert.ok(entries.includes('.claude-plugin'));
  assert.ok(entries.includes('agents'));
  assert.ok(entries.includes('skills'));
  // 反例：仓库根直接当 --plugin-dir 之所以不行，是因为那里只有 .claude/agents，
  // 没有根级 agents/。载荷必须**同时**有 .claude-plugin/plugin.json 与根级 agents/。
  assert.equal(existsSync(join(out, '.claude', 'agents')), false, '载荷里不该再套一层 .claude/');
  cleanup(root);
});

test('布局契约：skills 必须是「<名>/SKILL.md」，不是平铺 .md', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  buildPayload({ root, out });
  const skills = readdirSync(join(out, 'skills'), { withFileTypes: true });
  assert.ok(skills.length > 0);
  for (const s of skills) {
    assert.equal(s.isDirectory(), true, `skills/ 下出现平铺文件 ${s.name} —— 宿主的 skills 清单里不会有它`);
    assert.ok(existsSync(join(out, 'skills', s.name, 'SKILL.md')));
  }
  cleanup(root);
});

test('布局契约：agent 文件名与 frontmatter 的 name 都保留，且不被改写', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  buildPayload({ root, out });
  const src = readFileSync(join(root, '.claude', 'agents', 'oversight-alpha.md'), 'utf8');
  const dst = readFileSync(join(out, 'agents', 'oversight-alpha.md'), 'utf8');
  // 载荷是**复制**，不是重新拼装：一旦这里开始「生成」正文，就又多了第二个真源。
  assert.equal(dst, src);
  cleanup(root);
});

test('布局契约：载荷不声明 hooks（hooks 属于应用行为，由 --settings 挂，不走载荷）', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  buildPayload({ root, out });
  assert.equal(existsSync(join(out, 'hooks')), false,
    '载荷里放 hooks 会把「脚本 import 闭包」一起带进来，实测漏一个就等于静默失去介入能力');
  const pj = JSON.parse(readFileSync(join(out, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(pj.hooks, undefined);
  cleanup(root);
});

test('布局契约：载荷的 plugin.name 是 overwatch —— 宿主会给它的 agent 加 `overwatch:` 前缀', () => {
  const root = makeSource();
  const out = join(root, DEFAULT_OUT);
  buildPayload({ root, out });
  const pj = JSON.parse(readFileSync(join(out, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(pj.name, 'overwatch');
  // 实测：plugin 里的 agent 在 init 清单里叫 `overwatch:oversight-acceptor`，
  // 项目里的同名 agent 叫 `oversight-acceptor`。两者并列，不覆盖、不报错。
  // 所以本仓自用不会被自己的载荷干扰，`--agent oversight-acceptor` 仍命中项目那份。
  cleanup(root);
});

// ── 7. 与真实仓库对账 ─────────────────────────────────────────────────

test('真实源树：.claude/ 里有 12 个 agent + oversight skill，生成清单与之一致', () => {
  const repoRoot = process.cwd();
  const agentsDir = join(repoRoot, '.claude', 'agents');
  if (!existsSync(agentsDir)) return; // 解压后的发布包里没有 .claude/，跳过而不是假绿

  const { files, problems } = summarizeSources(repoRoot);
  assert.deepEqual(problems, [], '本仓的 .claude/ 布局必须能生成出载荷');

  const realAgents = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
  const payloadAgents = files.filter((f) => f.path.startsWith('agents/')).map((f) => f.path.slice('agents/'.length));
  assert.deepEqual(payloadAgents.sort(), realAgents.sort(), '载荷的 agent 清单必须与 .claude/agents 完全一致');

  // SKILL.md 必须在，且计数与源目录一致
  const skillDirs = readdirSync(join(repoRoot, '.claude', 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  const payloadSkills = [...new Set(files.filter((f) => f.path.startsWith('skills/'))
    .map((f) => f.path.split('/')[1]))];
  assert.deepEqual(payloadSkills.sort(), skillDirs.sort());
});

// ── 12. --verify-self：`.claude/` 本身是不是合法的 plugin 根 ─────────────
//
// 这条路取代了「生成」成为主路：`.claude/` 里放一个 `.claude-plugin/plugin.json`，
// 同一目录既是项目布局也是 plugin 根。零生成 → 零漂移。
// 它守的是**布局**：有人把 agents 挪进子目录、把 skill 平铺、往载荷里塞 hooks，
// 别的测试都不会红，但宿主会**静默加载不到**。

/** 造一个最小但合法的 plugin 根。 */
function mkRoot(dir, { agents = 1, skills = 1 } = {}) {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'probe', version: '0.0.1' }), 'utf8');
  if (agents) {
    mkdirSync(join(dir, 'agents'), { recursive: true });
    for (let i = 0; i < agents; i++) {
      writeFileSync(join(dir, 'agents', `a${i}.md`),
        `---\nname: a${i}\ndescription: probe\n---\nbody\n`, 'utf8');
    }
  }
  if (skills) {
    mkdirSync(join(dir, 'skills', 's0'), { recursive: true });
    writeFileSync(join(dir, 'skills', 's0', 'SKILL.md'), '---\nname: s0\n---\nbody\n', 'utf8');
  }
  return dir;
}

test('verifyPluginRoot：一个合法的最小 plugin 根通过', () => {
  const dir = tmp();
  try {
    mkRoot(dir);
    const r = verifyPluginRoot({ dir, root: dir });
    assert.equal(r.ok, true, r.reasons.join('\n'));
    assert.equal(r.agents, 1);
    assert.equal(r.skills, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verifyPluginRoot：负向——agent 放进子目录必须报（宿主只认一层）', () => {
  const dir = tmp();
  try {
    mkRoot(dir);
    mkdirSync(join(dir, 'agents', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'sub', 'deep.md'), '---\nname: deep\n---\n', 'utf8');
    const r = verifyPluginRoot({ dir, root: dir });
    assert.equal(r.ok, false, '子目录里的 agent 宿主不认，必须报出来');
    assert.ok(r.reasons.some((x) => /子目录/.test(x)), r.reasons.join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verifyPluginRoot：负向——skill 平铺（skills/x.md）必须报', () => {
  const dir = tmp();
  try {
    mkRoot(dir);
    writeFileSync(join(dir, 'skills', 'flat.md'), '---\nname: flat\n---\n', 'utf8');
    const r = verifyPluginRoot({ dir, root: dir });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => /平铺/.test(x)), r.reasons.join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verifyPluginRoot：负向——缺 plugin.json / 缺 name 必须报', () => {
  const a = tmp();
  const b = tmp();
  try {
    mkRoot(a);
    rmSync(join(a, '.claude-plugin', 'plugin.json'));
    assert.equal(verifyPluginRoot({ dir: a, root: a }).ok, false, '缺 manifest 必须报');

    mkRoot(b);
    writeFileSync(join(b, '.claude-plugin', 'plugin.json'), '{"version":"1"}', 'utf8');
    const rb = verifyPluginRoot({ dir: b, root: b });
    assert.equal(rb.ok, false, '缺 name 必须报');
    assert.ok(rb.reasons.some((x) => /name/.test(x)), rb.reasons.join('\n'));
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('verifyPluginRoot：负向——载荷里塞了 hooks 必须报（hook 会静默失效）', () => {
  const dir = tmp();
  try {
    mkRoot(dir);
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    writeFileSync(join(dir, 'hooks', 'hooks.json'), '{"hooks":{}}', 'utf8');
    const r = verifyPluginRoot({ dir, root: dir });
    assert.equal(r.ok, false, 'hooks 不许进载荷');
    assert.ok(r.reasons.some((x) => /hooks/.test(x)), r.reasons.join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verifyPluginRoot：负向——agent 缺 frontmatter 必须报', () => {
  const dir = tmp();
  try {
    mkRoot(dir);
    writeFileSync(join(dir, 'agents', 'nofm.md'), 'just body, no frontmatter\n', 'utf8');
    const r = verifyPluginRoot({ dir, root: dir });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => /frontmatter/.test(x)), r.reasons.join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI：--verify-self 在不合法的根上 exit 1，在合法的根上 exit 0', () => {
  const good = tmp();
  const bad = tmp();
  try {
    mkRoot(good);
    mkdirSync(join(bad, 'agents'), { recursive: true }); // 没有 .claude-plugin
    const bin = join(import.meta.dirname, 'build-payload.mjs');

    const g = spawnSync(process.execPath, [bin, '--verify-self', '--dir', good, '--root', good], { encoding: 'utf8' });
    assert.equal(g.status, 0, g.stderr || g.stdout);

    const b = spawnSync(process.execPath, [bin, '--verify-self', '--dir', bad, '--root', bad], { encoding: 'utf8' });
    assert.equal(b.status, 1, '不合法的根必须 exit 1');
    assert.match(b.stderr, /不是合法的 plugin 根/);
  } finally { rmSync(good, { recursive: true, force: true }); rmSync(bad, { recursive: true, force: true }); }
});
