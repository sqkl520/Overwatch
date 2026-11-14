#!/usr/bin/env node
/**
 * measure-gate-ceiling.test.mjs — `measure-gate-ceiling.mjs` 的回归测试。
 *
 * 重点守四类东西，每一类都配一条负向理由：
 *   ① **解析修复的方向**：`head -n 20` 修好以后，`20` 必须消失。修错方向（例如改成
 *      取最后一个 token）会让闸门悄悄变宽，而数字看起来仍然"合理"。
 *   ② **自检不能是恒真**：`parserEquivalence([])` 必须返回失败。空集合上的「全部一致」
 *      是本报告要识别的缺陷本身，不能让它自己犯。
 *   ③ **扩宽必须是并集、且不产生凭空路径**：子 agent / 上游的证据必须来自真实读过的
 *      路径集合，不能靠 `length` 拼出 `sub-strict-0` 这种假 key。
 *   ④ **基线对齐会红**：把一个期望值改错，`alignWithBaseline` 必须判不通过。
 *
 * 端到端用例在临时目录里造语料，不碰真实 transcript。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  gateReadsFixedOf, readWindowText, windowReadPaths, subagentPathSet, looseSubagentPathSet,
  upstreamOf, variantSets, contentReads, evidenceOf, toolCallCount,
  alignWithBaseline, parserEquivalence, byToolCalls, byDate, dropLargestProject, BASELINE_SNAPSHOT,
  measure, BASE_THRESHOLD,
} from './measure-gate-ceiling.mjs';
import { gateReadsOf, tailGateReads, analyzeOne } from './observe-reality-check.mjs';
import { pathKeyOf } from './pre-write-gate.mjs';

// ── ① 解析修复的方向 ──────────────────────────────────────────────────

test('gateReadsFixedOf: head -n 20 a.mjs 不再把 20 当文件', () => {
  const raw = gateReadsOf('Bash', { command: 'head -n 20 src/a.mjs' });
  // 原实现的缺陷就在这儿：它取到的是 `20`
  assert.deepEqual(raw, ['20'], '原实现取到 20（缺陷现状，本测试钉住它）');
  assert.deepEqual(gateReadsFixedOf('Bash', { command: 'head -n 20 src/a.mjs' }), ['src/a.mjs']);
});

test('gateReadsFixedOf: tail -c 512 x.log 不再把 512 当文件', () => {
  assert.deepEqual(gateReadsOf('Bash', { command: 'tail -c 512 x.log' }), ['512']);
  assert.deepEqual(gateReadsFixedOf('Bash', { command: 'tail -c 512 x.log' }), ['x.log']);
});

test('gateReadsFixedOf: 粘连写法 -n20 / -c512 / --lines=20 都被跳过', () => {
  assert.deepEqual(gateReadsFixedOf('Bash', { command: 'head -n20 a.mjs' }), ['a.mjs']);
  assert.deepEqual(gateReadsFixedOf('Bash', { command: 'head --lines=20 a.mjs' }), ['a.mjs']);
  assert.deepEqual(gateReadsFixedOf('Bash', { command: 'tail -512 a.log' }), ['a.log']);
});

test('gateReadsFixedOf: 不带值的开关不吞掉路径（cat -n / cat -A）', () => {
  // `cat -n` 的 `-n` 是显示行号，不要值；若照搬 head 的规则会把 a.mjs 吞掉
  assert.deepEqual(gateReadsFixedOf('Bash', { command: 'cat -n a.mjs' }), ['a.mjs']);
  assert.deepEqual(gateReadsFixedOf('Bash', { command: 'cat -A a.mjs' }), ['a.mjs']);
  // 对照：同样是 `-n`，在 head 上要值 → 20 必须被跳过、a.mjs 保留
  assert.deepEqual(gateReadsFixedOf('Bash', { command: 'head -n 20 a.mjs' }), ['a.mjs']);
});

test('gateReadsFixedOf: 非 shell 工具原样返回（Read 不受影响）', () => {
  assert.deepEqual(gateReadsFixedOf('Read', { file_path: '/x/y.mjs' }), ['/x/y.mjs']);
});

test('gateReadsFixedOf: 普通 cat 多文件仍然全部保留', () => {
  assert.deepEqual(gateReadsFixedOf('Bash', { command: 'cat a.txt; cat b.txt' }), ['a.txt', 'b.txt']);
});

test('gateReadsFixedOf: 修复只把「假的数字路径」换成真实路径，不凭空造路径', () => {
  // 原始解析取第一个非 `-` token，于是 `head -n 20 a.mjs` 拿到 `20`、
  // `tail -c 512 x.log` 拿到 `512` —— 这些是**假路径**。
  // 修复后出现的每个路径，必须要么原始解析里也有，要么是它在命令里|
  // 确实作为文件出现的那个 token。这里用「不得是纯数字」这条更硬的判据。
  const cmds = ['head -n 20 a.mjs', 'tail -c 512 x.log', 'cat -A f', 'head -n 5 a.mjs b.mjs'];
  for (const c of cmds) {
    for (const p of gateReadsFixedOf('Bash', { command: c })) {
      assert.ok(!/^\d+$/.test(p), `修复后仍出现纯数字路径：${p}（命令 ${c}）`);
      assert.ok(c.includes(p), `修复引入了命令里不存在的路径：${p}（命令 ${c}）`);
    }
  }
  // 反向：修复必须真的把假路径拿掉
  assert.ok(!gateReadsFixedOf('Bash', { command: 'head -n 20 a.mjs' }).includes('20'));
  assert.ok(!gateReadsFixedOf('Bash', { command: 'tail -c 512 x.log' }).includes('512'));
});

// ── ② 自检不能是恒真 ──────────────────────────────────────────────────

test('parserEquivalence: 空集合必须判失败（不是恒真通过）', () => {
  const r = parserEquivalence([]);
  assert.equal(r.checked, 0);
  assert.equal(r.ok, false, '空集合上的「全部一致」是恒真，必须判失败');
});

test('parserEquivalence: 没有 firstWrite 的会话不算「检查过」', () => {
  const r = parserEquivalence([{ sessionId: 'abc', firstWrite: null, readPathsWindow: [] }]);
  assert.equal(r.checked, 0);
  assert.equal(r.ok, false);
});

test('parserEquivalence: 与 tailGateReads 同口径时通过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-equiv-'));
  try {
    const p = join(dir, 's.jsonl');
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a.mjs' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat b.mjs' } }] } },
    ];
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const size = Buffer.byteLength(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const fake = {
      sessionId: 'deadbeef-0000',
      path: p,
      firstWrite: { off: size },
      readPathsWindow: tailGateReads(p, size),
    };
    const r = parserEquivalence([fake]);
    assert.equal(r.checked, 1);
    assert.equal(r.ok, true, JSON.stringify(r.bad));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── ③ 扩宽是并集，不造路径 ────────────────────────────────────────────

test('variantSets: 基线就是 gate 窗口集合本身', () => {
  const ev = {
    gateWin: new Set(['a']), gateCum: new Set(['a']), fixWin: new Set(['a']),
    struct: new Set(), target: '', subStrict: new Set(), subLoose: new Set(),
    up: { set: new Set(), unique: false },
  };
  assert.deepEqual([...variantSets(ev).baseline], ['a']);
});

test('variantSets: +C 是 gate ∪ struct，不是替换', () => {
  const ev = {
    gateWin: new Set(['a']), gateCum: new Set(['a']), fixWin: new Set(['a']),
    struct: new Set(['s1', 's2']), target: '', subStrict: new Set(), subLoose: new Set(),
    up: { set: new Set(), unique: false },
  };
  const v = variantSets(ev);
  assert.deepEqual([...v.C].sort(), ['a', 's1', 's2']);
});

test('variantSets: +A-unique 在无唯一前序时不贡献任何路径', () => {
  const ev = {
    gateWin: new Set(['a']), gateCum: new Set(['a']), fixWin: new Set(['a']),
    struct: new Set(), target: '', subStrict: new Set(), subLoose: new Set(),
    up: { set: new Set(['up1', 'up2']), unique: false },
  };
  assert.deepEqual([...variantSets(ev)['A-unique']], ['a'], '不唯一 → 不能算归属');
  assert.deepEqual([...variantSets(ev)['A-greedy']].sort(), ['a', 'up1', 'up2']);
});

test('variantSets: 全开是所有来源的并集', () => {
  const ev = {
    gateWin: new Set(['a']), gateCum: new Set(['a']), fixWin: new Set(['a', 'd']),
    struct: new Set(['s']), target: '', subStrict: new Set(['b']), subLoose: new Set(['b2']),
    up: { set: new Set(['u']), unique: false },
  };
  assert.deepEqual([...variantSets(ev).all].sort(), ['a', 'b', 'b2', 'd', 's', 'u']);
});

test('contentReads: 不含结构性探索（这正是「读完文件」与「看过目录」的分界）', () => {
  const ev = {
    gateWin: new Set(['a']), gateCum: new Set(['a']), fixWin: new Set(['a']),
    struct: new Set(['only-struct']), target: '', subStrict: new Set(), subLoose: new Set(),
    up: { set: new Set(), unique: false },
  };
  const c = contentReads(ev);
  assert.equal(c.has('only-struct'), false);
  assert.equal(c.has('a'), true);
});

test('subagentPathSet: 没有 subagents 目录时返回空集合', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-sub-'));
  try {
    const p = join(dir, 's.jsonl');
    writeFileSync(p, '');
    assert.equal(subagentPathSet({ path: p }, new Set(['x'])).size, 0);
    assert.equal(looseSubagentPathSet({ path: p }).size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('subagentPathSet: 严格档只认 meta.toolUseId 命中的子 agent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-sub2-'));
  try {
    const p = join(dir, 's.jsonl');
    writeFileSync(p, '');
    const sub = join(dir, 's', 'subagents');
    mkdirSync(sub, { recursive: true });
    const rec = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/sub/a.mjs' } }] } };
    writeFileSync(join(sub, 'agent-1.jsonl'), JSON.stringify(rec) + '\n');
    writeFileSync(join(sub, 'agent-1.meta.json'), JSON.stringify({ toolUseId: 'toolu_hit' }));
    writeFileSync(join(sub, 'agent-2.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/sub/b.mjs' } }] } }) + '\n');
    writeFileSync(join(sub, 'agent-2.meta.json'), JSON.stringify({ toolUseId: 'toolu_miss' }));
    const strict = subagentPathSet({ path: p }, new Set(['toolu_hit']));
    assert.deepEqual([...strict], [pathKeyOf('/sub/a.mjs')]);
    const loose = looseSubagentPathSet({ path: p });
    assert.equal(loose.size, 2, '宽松档两个都算');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── ④ 基线对齐会红 ────────────────────────────────────────────────────

test('alignWithBaseline: 与参考实现逐项比，不符时 ok=false 并指出哪一项', () => {
  const rep = {
    threshold: 3,
    real: {
      withWrite: 136, zeroRead: 13, variants: { baseline: 27 },
      attribution: {
        'A-continuation': 5, 'B-subagent': 5, 'B2-subagent-unattributed': 8,
        'C-broad-explore': 6, 'D-no-evidence': 3,
      },
    },
    sandbox: { withWrite: 67, variants: { baseline: 50 } },
    rows: { real: [] },
  };
  const reference = {
    real: {
      withWrite: 136, deny: 27, gate: { zero: 13 }, denyCumulative: 0, denyBroad: 0,
      attribution: {
        'A-continuation': 5, 'B-subagent': 5, 'B2-subagent-unattributed': 8,
        'C-broad-explore': 6, 'D-no-evidence': 3,
      },
    },
    sandbox: { withWrite: 67, deny: 50 },
  };
  const good = alignWithBaseline(rep, { reference });
  const byName = Object.fromEntries(good.checks.map((c) => [c.name, c]));
  assert.equal(byName['真实项目 would-deny（基线）'].ok, true);
  assert.equal(byName['沙箱 would-deny（基线）'].ok, true);
  assert.equal(byName['归因 B2-subagent-unattributed'].ok, true);
  assert.equal(good.ok, true, JSON.stringify(good.hardFails));

  const badRef = JSON.parse(JSON.stringify(reference));
  badRef.real.deny = 26;
  const bad = alignWithBaseline(rep, { reference: badRef });
  assert.equal(bad.ok, false);
  assert.equal(bad.checks.find((c) => c.name === '真实项目 would-deny（基线）').ok, false);
});

test('alignWithBaseline: 快照漂移只报告，不判失败', () => {
  const rep = {
    threshold: 3,
    real: { withWrite: 136, zeroRead: 13, variants: { baseline: 27 }, attribution: {} },
    sandbox: { withWrite: 67, variants: { baseline: 50 } },
    rows: { real: [] },
  };
  const reference = {
    real: { withWrite: 136, deny: 27, gate: { zero: 13 }, denyCumulative: 0, denyBroad: 0, attribution: {} },
    sandbox: { withWrite: 67, deny: 50 },
  };
  // 快照写的是 66/49，实测 67/50 —— 只应产生 drift 记录，不应判失败
  const r = alignWithBaseline(rep, { reference, snapshot: BASELINE_SNAPSHOT });
  assert.equal(r.ok, true, '语料生长不是复现错误');
  const changed = r.drift.filter((d) => d.changed).map((d) => d.name);
  assert.ok(changed.includes('沙箱有写会话'), JSON.stringify(r.drift));
  assert.ok(changed.includes('沙箱 would-deny'));
});

test('alignWithBaseline: 没有参考实现时不许判通过（不能空转）', () => {
  const rep = { threshold: 3, real: { withWrite: 0 }, sandbox: {}, rows: { real: [] } };
  const r = alignWithBaseline(rep, { reference: null });
  assert.equal(r.ok, false, '没有比对对象时的「通过」是恒真');
  assert.equal(r.checks.length, 0);
});

test('alignWithBaseline: skip 时把结论标成跳过，不是通过', () => {
  const rep = {
    threshold: 3,
    real: { withWrite: 1, zeroRead: 1, variants: { baseline: 1 }, attribution: {} },
    sandbox: { withWrite: 1, variants: { baseline: 1 } },
    rows: { real: [] },
  };
  const reference = { real: { withWrite: 1, deny: 1, gate: { zero: 1 } }, sandbox: { withWrite: 1, deny: 1 } };
  const r = alignWithBaseline(rep, { reference, skip: true });
  assert.equal(r.skipped, true);
  assert.equal(r.ok, false);
  assert.ok(r.checks.every((c) => c.ok === null), '跳过的项不能标成通过');
});

// ── 上游归属（+A）────────────────────────────────────────────────────

test('upstreamOf: 非续接会话不产生候选', () => {
  const s = { sessionId: 'a', firstHuman: 'please fix the bug', cwd: 'C:/x', firstTs: '2026-11-01T00:00:00Z' };
  const r = upstreamOf(s, [s]);
  assert.equal(r.candidates, 0);
  assert.equal(r.basis, 'none');
});

test('upstreamOf: 唯一前序被标成 unique，多候选标成 greedy', () => {
  const mk = (id, lastTs, firstTs) => ({
    sessionId: id, firstHuman: 'This session is being continued from a previous conversation',
    cwd: 'C:/proj', firstTs, lastTs, records: 5,
    readPathsGate: [`/read/by/${id}.mjs`],
  });
  const cur = mk('cur', '2026-11-02T00:00:00Z', '2026-11-02T01:00:00Z');
  const one = mk('prev', '2026-11-02T00:30:00Z', '2026-11-01T00:00:00Z');
  const u1 = upstreamOf(cur, [cur, one]);
  assert.equal(u1.candidates, 1);
  assert.equal(u1.unique, true);
  assert.equal(u1.reads, 1);

  const two = mk('prev2', '2026-11-02T00:20:00Z', '2026-11-01T02:00:00Z');
  const u2 = upstreamOf(cur, [cur, one, two]);
  assert.equal(u2.candidates, 2);
  assert.equal(u2.unique, false);
  assert.equal(u2.basis, 'greedy');
  assert.equal(u2.reads, 2);
});

test('upstreamOf: 不同 cwd 的会话不算前序', () => {
  const cur = {
    sessionId: 'cur', firstHuman: 'This session is being continued from a previous conversation',
    cwd: 'C:/proj-a', firstTs: '2026-11-02T01:00:00Z', lastTs: '2026-11-02T02:00:00Z', records: 5,
    readPathsGate: [],
  };
  const other = {
    sessionId: 'other', firstHuman: 'x', cwd: 'C:/proj-b',
    firstTs: '2026-11-01T00:00:00Z', lastTs: '2026-11-02T00:30:00Z', records: 5,
    readPathsGate: ['/x.mjs'],
  };
  assert.equal(upstreamOf(cur, [cur, other]).candidates, 0);
});

// ── 分桶 / 稳健性 ────────────────────────────────────────────────────

/** 造一个「全变体都齐」的 sets 对象。`byToolCalls` / `byDate` / `dropLargestProject`
 *  会遍历**每一个**变体名，夹具若只给 `baseline` 会在其它变体上取到 undefined。 */
const VARIANT_NAMES = ['baseline', 'D', 'C', 'B', 'B2', 'A-unique', 'A-greedy', 'all'];
function allSets(passing) {
  const s = {};
  for (const n of VARIANT_NAMES) s[n] = new Set(passing ? ['a', 'b', 'c'] : []);
  return s;
}

test('byToolCalls: 桶边界是 <50 / 50-200 / >200', () => {
  const mk = (toolCalls, deny) => ({ toolCalls, sessionId: String(toolCalls), sets: allSets(!deny) });
  const rep = {
    threshold: 3,
    rows: { real: [mk(49, true), mk(50, true), mk(200, false), mk(201, false)] },
  };
  const out = byToolCalls(rep);
  assert.equal(out['<50'].sessions, 1);
  assert.equal(out['50-200'].sessions, 2);
  assert.equal(out['>200'].sessions, 1);
  assert.equal(out['<50'].deny.baseline, 1);
  assert.equal(out['50-200'].deny.baseline, 1);
  assert.equal(out['>200'].deny.baseline, 0);
});

test('byDate: 按 2026-10-01 分界', () => {
  const rep = {
    threshold: 3,
    rows: {
      real: [
        { firstTs: '2026-09-30T23:59:00Z', sets: allSets(false), sessionId: 'a' },
        { firstTs: '2026-10-01T00:00:01Z', sets: allSets(false), sessionId: 'b' },
      ],
    },
  };
  const out = byDate(rep);
  assert.equal(out.before.sessions, 1);
  assert.equal(out.after.sessions, 1);
  assert.equal(out.before.deny.baseline, 1, '空集合 < 阈值 → 被拦');
});

test('dropLargestProject: 去掉的是会话数最多的那个 slug', () => {
  const rows = [
    { slug: 'big', sets: allSets(false), sessionId: 'a' },
    { slug: 'big', sets: allSets(false), sessionId: 'b' },
    { slug: 'small', sets: allSets(true), sessionId: 'c' },
  ];
  const out = dropLargestProject({ threshold: 3, rows: { real: rows } });
  assert.equal(out.dropped, 'big');
  assert.equal(out.sessions, 1, '只剩 1 个会话');
  assert.equal(out.deny.baseline, 0, '留下的那个读够了，不再被拦');
});

test('toolCallCount: 只数 tool_use 块', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-tc-'));
  try {
    const p = join(dir, 's.jsonl');
    const recs = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'text', text: 'hi' }] } },
      { type: 'user', message: { content: 'x' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
    ];
    writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    assert.equal(toolCallCount(p), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 端到端：造语料，核对「改宽后放行」的方向 ──────────────────────────

/** 造一份 transcript。`readPaths` 在首写之前，`writePath` 是首写的目标。
 *
 *  `cwd` **必须显式是「不像沙箱」的路径**：夹具落在 `os.tmpdir()` 下，而 Windows 的
 *  tmpdir 含 `Temp`，`isSandbox()` 会把它分进沙箱桶。本仓的分桶规则是**路径含
 *  `Temp\` 或 `.tmp-analysis`**（与 `observe-reality-check.mjs` 同源），所以夹具自己
 *  必须避开这两个串，否则「真实项目」那条断言测的根本不是真实项目桶。 */
function mkTranscript(dir, slug, name, { readPaths = [], writePath = 'out.txt', cwd = null, ts = '2026-11-01T00:00:00Z' } = {}) {
  const d = join(dir, slug);
  mkdirSync(d, { recursive: true });
  const p = join(d, `${name}.jsonl`);
  const recs = [];
  let t = Date.parse(ts);
  const push = (o) => { recs.push({ cwd: cwd || '/proj/' + slug, timestamp: new Date(t).toISOString(), ...o }); t += 1000; };
  push({ type: 'user', message: { content: 'do the task' } });
  for (const rp of readPaths) {
    push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: rp } }] } });
  }
  push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: writePath, content: 'x' } }] } });
  writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

test('端到端: 读 0 个就写的真实会话被拦，读够 3 个的放行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-e2e-'));
  try {
    mkTranscript(dir, 'real-project', 'a', { readPaths: [], writePath: 'D:/real/a.txt' });
    mkTranscript(dir, 'real-project', 'b', { readPaths: ['D:/real/1.mjs', 'D:/real/2.mjs', 'D:/real/3.mjs'], writePath: 'D:/real/b.txt' });
    // 沙箱判据是「路径里含 `Temp/` 这一段」（判据在 `isSandbox`，与真实语料同源）。
    // 夹具必须造出**真实沙箱的形状**：真实路径是 `.../Temp/<子目录>/...`，
    // 而 `join(dir,'sandbox','Temp')` 恰好以 Temp 结尾，不含尾随分隔符 →
    // 正则在 POSIX 上匹配不到 → 被算进「真实项目」桶 → 断言 3 !== 2。
    mkTranscript(dir, 'sandbox', 'c', { readPaths: [], writePath: 'probe.txt', cwd: join(dir, 'sandbox', 'Temp', 'proj') });
    const rep = measure(dir, { threshold: 3 });
    assert.equal(rep.real.withWrite, 2);
    assert.equal(rep.real.variants.baseline, 1, '只有读 0 个的那个被拦');
    assert.equal(rep.sandbox.withWrite, 1);
    assert.equal(rep.sandbox.variants.baseline, 1, '沙箱那个必然被拦');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('端到端: 结构性探索开不开，决定「只 ls 过」的会话是否放行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-e2e2-'));
  try {
    const d = join(dir, 'realproj');
    mkdirSync(d, { recursive: true });
    const p = join(d, 'x.jsonl');
    const recs = [
      { type: 'user', message: { content: 'go' } },
      { type: 'assistant', cwd: '/proj/explore', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] } },
      { type: 'assistant', cwd: '/proj/explore', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'grep -r foo .' } }] } },
      { type: 'assistant', cwd: '/proj/explore', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git log --oneline' } }] } },
      { type: 'assistant', cwd: '/proj/explore', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/proj/explore/o.txt', content: 'x' } }] } },
    ];
    writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const rep = measure(dir, { threshold: 3 });
    assert.equal(rep.real.withWrite, 1);
    assert.equal(rep.real.variants.baseline, 1, '基线：结构性探索不算读过');
    assert.equal(rep.real.variants.C, 0, '+C：三次结构性探索够了');
    // 但这三个会话没有读过任何文件内容 —— 必须被标进 structOnly
    assert.deepEqual(rep.real.structOnly.C, [rep.rows.real[0].sessionId.slice(0, 8)]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('端到端: 沙箱桶在 +C/+B/+A 下拦截数不变（阴性对照不被架空）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-e2e3-'));
  try {
    // `listTranscripts()` 要求 `<root>/<slug>/<sessionId>.jsonl` 正好两层，
    // 所以 transcript 放 `dir/sbx/`，而 **cwd 才带 Temp 段**（分桶看的是 cwd 与 slug）。
    const slugDir = join(dir, 'sbx');
    mkdirSync(slugDir, { recursive: true });
    const sandboxCwd = join(dir, 'sbx', 'Temp', 'proj');
    const p = join(slugDir, 's.jsonl');
    const recs = [
      { type: 'user', message: { content: 'Write a file named probe.txt containing hello. Then stop.' } },
      { type: 'assistant', cwd: sandboxCwd, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'assistant', cwd: sandboxCwd, message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: join(sandboxCwd, 'probe.txt'), content: 'hello' } }] } },
    ];
    writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const rep = measure(dir, { threshold: 3 });
    assert.equal(rep.sandbox.withWrite, 1, '沙箱桶里应有 1 个有写会话');
    assert.equal(rep.real.withWrite, 0, '不该有真实项目会话');
    assert.equal(rep.sandbox.variants.baseline, 1);
    assert.equal(rep.sandbox.variants.C, 1, '一次 ls 不够，沙箱仍被拦');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('measure: 默认阈值是 3', () => {
  assert.equal(BASE_THRESHOLD, 3);
});

test('measure: 替代方案 3 用「读过目标文件本身」放行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-e2e4-'));
  try {
    const d = join(dir, 'proj');
    mkdirSync(d, { recursive: true });
    const target = join(d, 'target.txt');
    const p = join(d, 't.jsonl');
    const recs = [
      { type: 'user', message: { content: 'edit it' } },
      { type: 'assistant', cwd: '/proj/edit', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/proj/edit/target.txt' } }] } },
      { type: 'assistant', cwd: '/proj/edit', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/proj/edit/target.txt', old_string: 'a', new_string: 'b' } }] } },
    ];
    writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const rep = measure(dir, { threshold: 3 });
    assert.equal(rep.real.withWrite, 1);
    assert.equal(rep.real.variants.baseline, 1, '只读 1 个 → 基线拦');
    assert.equal(rep.real.target.wouldDeny, 0, '读过目标本身 → 替代 3 放行');
    assert.equal(rep.real.target.targetReadSessions, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('windowReadPaths: 窗口内的读算进来，窗口外的读不算', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-win-'));
  try {
    const p = join(dir, 'w.jsonl');
    const filler = JSON.stringify({ type: 'user', message: { content: 'go' } });
    const early = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/early.mjs' } }] } });
    const late = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/late.mjs' } }] } });
    writeFileSync(p, [filler, early, late].join('\n') + '\n');
    const cutoff = Buffer.byteLength([filler, early].join('\n') + '\n');
    // 窗口覆盖 filler+early：`early.mjs` 必须出现，晚于首写的 `late.mjs` 不能出现。
    //
    // 注：`readWindowText()` 与 `tailGateReads()` 同法 —— 只要窗口够到文件头，
    // 它会把**首行**当成「从中间切进去的半条」丢掉（filler 因此被丢弃，无副作用）。
    // 这是刻意继承的既有口径，不是本脚本自创；`parserEquivalence()` 在 202 个
    // 真实会话上验证过两者逐条一致。
    const got = windowReadPaths(p, cutoff, { fixed: false, windowBytes: cutoff });
    assert.deepEqual(got, ['/early.mjs']);
    // 窗口只覆盖最后几个字节 → 取不到任何完整读
    assert.deepEqual(windowReadPaths(p, cutoff, { fixed: false, windowBytes: 10 }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readWindowText: 窗口为 0 时返回空串', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-win2-'));
  try {
    const p = join(dir, 'w.jsonl');
    writeFileSync(p, '{"type":"user"}\n');
    assert.equal(readWindowText(p, 0), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('evidenceOf: 未被拦的会话不读子 agent 与上游（省 IO）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-ev-'));
  try {
    const p = mkTranscript(dir, 'proj', 'e', { readPaths: ['/a', '/b', '/c'], writePath: join(dir, 'proj', 'o.txt') });
    const s = analyzeOne({ slug: 'proj', sessionId: 'e', path: p, bytes: 1, mtimeMs: 1 }, { order: 'file' });
    const ev = evidenceOf(s, [s], { denied: false });
    assert.equal(ev.up.candidates, 0);
    assert.equal(ev.subStrict.size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
