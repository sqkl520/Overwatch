#!/usr/bin/env node
/**
 * observe-reality-check.test.mjs — 「写前闸在真实语料上会怎么判」的回归测试。
 *
 * 造一个最小 transcript 目录（人造会话 + 一条沙箱会话 + 一条 fork 副本），
 * 逐条断言口径。**每条断言对应报告里的一句口径说明**，口径变了测试就会红。
 *
 * 重点守四件事：
 *   ① gate 口径的窗口是「首写那一刻往前 1MB」，不是整个文件；
 *   ② 沙箱会话必须与真实项目分开统计 —— 混在一起会把误伤率抬高；
 *   ③ fork 副本只算一次；
 *   ④ 计数的证据与 decide() 复算的证据**必须是同一份数组**（曾经就漂过一次）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listTranscripts, isSandbox, analyzeOne, dedupeForks, distOf, structuralKind,
  gateReadsOf, broadReadsOf, gateReadPathsInText, tailGateReads, GATE_READ_VERBS,  buildReport, verdict, eachLineOffset, verbsOf, fnv1a, defaultRoot,
  attribute, isContinuation, agentToolIdsBefore, subagentReadsByToolId, looseSubagentReads, ATTRIBUTION_CLASSES,
} from './observe-reality-check.mjs';
import { decide, defaultConfig, readTranscriptReads, readPathsInTranscriptText, GATE_SHELL_READ_VERBS } from './pre-write-gate.mjs';

// ── 造记录 ────────────────────────────────────────────────────────────

let clock = 0;
const ts = () => {
  clock += 1000;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + clock).toISOString();
};

const user = (text, extra = {}) => ({
  type: 'user', timestamp: ts(), message: { role: 'user', content: text }, origin: { kind: 'human' }, ...extra,
});

const read = (path, extra = {}) => ({
  type: 'assistant', timestamp: ts(), cwd: extra.cwd,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${clock}`, name: 'Read', input: { file_path: path } }] },
});

const bash = (command, extra = {}) => ({
  type: 'assistant', timestamp: ts(), cwd: extra.cwd,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${clock}`, name: 'Bash', input: { command } }] },
});

const write = (path, extra = {}) => ({
  type: 'assistant', timestamp: ts(), cwd: extra.cwd,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${clock}`, name: 'Write', input: { file_path: path, content: '' } }] },
});

const agent = (desc, extra = {}) => ({
  type: 'assistant', timestamp: ts(), cwd: extra.cwd,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${clock}`, name: 'Agent', input: { description: desc } }] },
});

function writeTranscript(dir, slug, sessionId, records) {
  mkdirSync(join(dir, slug), { recursive: true });
  const p = join(dir, slug, `${sessionId}.jsonl`);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function sandbox() {
  const d = mkdtempSync(join(tmpdir(), 'ow-orc-'));
  return { dir: d, clean: () => rmSync(d, { recursive: true, force: true }) };
}

// ── ① gate 判据 ──────────────────────────────────────────────────────

test('gateReadsOf 只认 Read/NotebookRead 与整份读的 shell 动词', () => {
  assert.deepEqual(gateReadsOf('Read', { file_path: 'a.mjs' }), ['a.mjs']);
  assert.deepEqual(gateReadsOf('NotebookRead', { notebook_path: 'n.ipynb' }), ['n.ipynb']);
  assert.deepEqual(gateReadsOf('Bash', { command: 'cat a.mjs' }), ['a.mjs']);
  assert.deepEqual(gateReadsOf('Bash', { command: 'head -100 a.mjs' }), ['a.mjs']);
  // 这几个**不**算读过内容 —— 判据刻意窄，见报告 §1.3。
  assert.deepEqual(gateReadsOf('Bash', { command: 'ls' }), []);
  assert.deepEqual(gateReadsOf('Bash', { command: 'grep foo a.mjs' }), []);
  assert.deepEqual(gateReadsOf('Bash', { command: 'git log --oneline' }), []);
  assert.deepEqual(gateReadsOf('Glob', { pattern: '**/*.mjs' }), []);
  assert.deepEqual(gateReadsOf('Grep', { pattern: 'foo' }), []);
});

test('gateReadsOf 跳过 shell 的选项参数，取第一个位置参数', () => {
  assert.deepEqual(gateReadsOf('Bash', { command: 'cat -n a.mjs' }), ['a.mjs']);
  assert.deepEqual(gateReadsOf('Bash', { command: 'head -100 a.mjs' }), ['a.mjs']);
  // 已知缺陷（本轮发现，未修）：带独立值的选项 `-n 20` / `-c 512` 会把值当成路径。
  // 方向是**多算**（更宽松），实测只影响 1/136 个真实会话，见报告 §5.2。
  // 这里把现状钉住：将来修了这条，测试会红，提醒同步改报告。
  assert.deepEqual(gateReadsOf('Bash', { command: 'head -n 20 a.mjs' }), ['20']);
  assert.deepEqual(gateReadsOf('Bash', { command: 'tail -c 512 a.mjs' }), ['512']);
});

test('broadReadsOf 把结构性探索算进来，且不按动词去重', () => {
  assert.ok(broadReadsOf('Bash', { command: 'ls -la' }).length > 0);
  assert.ok(broadReadsOf('Bash', { command: 'find . -name "*.md"' }).length > 0);
  assert.ok(broadReadsOf('Bash', { command: 'git log --oneline' }).length > 0);
  assert.ok(broadReadsOf('Glob', { pattern: '**/*.mjs' }).length > 0);
  // 同一个动词在不同命令上是不同次探索 —— 压成 1 会低估探索强度。
  const a = broadReadsOf('Bash', { command: 'ls src' });
  const b = broadReadsOf('Bash', { command: 'ls docs' });
  assert.notDeepEqual(a, b);
});

test('verbsOf 从每段首词取动词，跳过赋值前缀与路径', () => {
  assert.deepEqual(verbsOf('cd /x && ls -la'), ['cd', 'ls']);
  assert.deepEqual(verbsOf('FOO=1 cat a.txt'), ['cat']);
  assert.deepEqual(verbsOf('/usr/bin/head -n 5 a'), ['head']);
  assert.deepEqual(verbsOf(''), []);
});

// ── ② 首写定位与窗口 ──────────────────────────────────────────────────

test('analyzeOne 取首写之前的读取证据，首写之后的不算', () => {
  const box = sandbox();
  try {
    writeTranscript(box.dir, 'proj', 's1', [
      user('读一下项目'),
      read('/p/a.mjs'), read('/p/b.mjs'),
      write('/p/out.txt'),
      read('/p/c.mjs'), read('/p/d.mjs'), write('/p/out2.txt'),
    ]);
    const meta = listTranscripts(box.dir)[0];
    const s = analyzeOne(meta);
    assert.equal(s.gateReadsCumulative, 2, '首写前只有 2 个文件');
    assert.equal(s.gateReads, 2, '文件很短，1MB 窗口装得下');
    assert.equal(s.writeCount, 2);
    assert.equal(s.firstWrite.name, 'Write');
  } finally { box.clean(); }
});

test('gate 口径只数窗口内的读 —— 早期读滑出 1MB 就数不到', () => {
  const box = sandbox();
  try {
    const filler = 'x'.repeat(2000);
    const recs = [user('任务')];
    for (let i = 0; i < 5; i++) recs.push(read(`/p/early${i}.mjs`));
    // 塞 1.2MB 的噪声，把早期读推出窗口
    for (let i = 0; i < 700; i++) recs.push({ type: 'attachment', timestamp: ts(), attachment: { blob: filler } });
    recs.push(read('/p/late.mjs'));
    recs.push(write('/p/out.txt'));
    writeTranscript(box.dir, 'proj', 's1', recs);
    const s = analyzeOne(listTranscripts(box.dir)[0]);
    assert.equal(s.gateReadsCumulative, 6, '累积口径能看到全部 6 个');
    assert.ok(s.gateReads < 6, `窗口口径应当少一些，实际 ${s.gateReads}`);
    assert.ok(s.gateReads >= 1, '晚读的那个在窗口内');
  } finally { box.clean(); }
});

test('tailGateReads 与闸门的 readTranscriptReads 在同一切口上给同一组路径', () => {
  const box = sandbox();
  try {
    const recs = [user('任务')];
    for (let i = 0; i < 6; i++) recs.push(read(`/p/f${i}.mjs`));
    recs.push(write('/p/out.txt'));
    const p = writeTranscript(box.dir, 'proj', 's1', recs);
    const size = statSync(p).size;

    // ① 同文本：把整份文件交给闸门的纯解析函数与重放器，路径数组必须逐条相同。
    const text = readFileSync(p, 'utf8');
    assert.deepEqual(
      gateReadPathsInText(text),
      readPathsInTranscriptText(text).paths,
      '重放器必须调闸门的实现，而不是自己写一份',
    );
    assert.equal(gateReadPathsInText(text).length, 6);

    // ② 同文件 + 同窗口：窗口从文件头开始（文件远小于 1MB），首行是完整记录。
    //    闸门只在「读满窗口」时丢首行，这里两边都必须保留全部 6 条。
    //    旧重放器无条件下丢首行 → 这条会红（实测曾经差 1 条）。
    const mine = tailGateReads(p, size);
    const theirs = readTranscriptReads(p, { bytes: size + 1 }).paths;
    assert.deepEqual(mine, theirs, '窗口语义必须与闸门一致（首行该不该丢）');
    assert.equal(mine.length, 6);
  } finally { box.clean(); }
});

test('重放器不得留第二份解析实现：等价文本上逐条相同（含 wash 差异点）', () => {
  const line = (name, input) => JSON.stringify({ message: { content: [{ type: 'tool_use', name, input }] } });
  // 这份样本刻意包含**两份实现曾经真的会给出不同答案**的输入：
  // 空白 file_path（闸门不计数、复制品数成一个）、两端带空格的路径（闸门 trim）。
  // 一个「自己写一份」的重放器会在这里露馅，哪怕它对普通 Read 看起来一致。
  const text = [
    line('Read', { file_path: '/p/normal.mjs' }),
    line('Read', { file_path: '   ' }),
    line('Read', { file_path: '  /p/padded.mjs  ' }),
    line('NotebookRead', { notebook_path: '/p/n.ipynb' }),
    line('Bash', { command: 'cat /p/a.mjs; head -n 20 /p/b.mjs' }),
    line('Bash', { command: 'ls src' }),          // 不在动词表里
    line('Glob', { pattern: '**/*.mjs' }),
    '{broken',
  ].join('\n') + '\n';

  const fromGate = readPathsInTranscriptText(text).paths;
  assert.deepEqual(gateReadPathsInText(text), fromGate);
  assert.deepEqual(fromGate, ['/p/normal.mjs', '/p/padded.mjs', '/p/n.ipynb', '/p/a.mjs', '20']);
  // 空白路径一条都不该产生；带空格的必须 trim 过。
  assert.ok(!fromGate.some((x) => !x.trim()), '空白路径不得计数');
  assert.ok(!fromGate.some((x) => x !== x.trim()), '路径必须 trim');

  // 动词表必须是**派生**的同一个对象，不是抄一份字面量。
  assert.equal(GATE_READ_VERBS, GATE_SHELL_READ_VERBS, 'GATE_READ_VERBS 必须从闸门派生');
});

test('transcript 解析器是唯一实现：闸门动词表加 ls，重放器立刻跟着变', () => {
  const line = (name, input) => JSON.stringify({ message: { content: [{ type: 'tool_use', name, input }] } });
  const text = [
    line('Bash', { command: 'ls src' }),
    line('Read', { file_path: '/p/a.mjs' }),
  ].join('\n') + '\n';

  // 现行动词表：ls 不算读过内容 —— 两侧都只认那一个 Read。
  assert.deepEqual(gateReadsOf('Bash', { command: 'ls src' }), []);
  assert.deepEqual(gateReadPathsInText(text), ['/p/a.mjs']);

  // 负向验证：手工把 ls 加进动词表（参数注入，不改源码）。
  const widened = [...GATE_READ_VERBS, 'ls'];
  assert.deepEqual(gateReadsOf('Bash', { command: 'ls src' }, widened), ['src']);
  // 重放器必须跟着变。它若自己留一份动词表，这里会红 —— 这就是这条测试的用途。
  assert.deepEqual(gateReadPathsInText(text, widened), ['src', '/p/a.mjs']);
  assert.deepEqual(
    readPathsInTranscriptText(text, widened).paths,
    gateReadPathsInText(text, widened),
    '两侧必须是同一个实现的两种入口',
  );
});

test('已知解析缺陷钉住：带独立值的选项把值当路径（本轮不修）', () => {
  // 这是闸门**现行**行为，方向是多算（更宽松）。将来修它会红，提醒同步改报告。
  assert.deepEqual(gateReadsOf('Bash', { command: 'head -n 20 a.mjs' }), ['20']);
  assert.deepEqual(gateReadsOf('Bash', { command: 'tail -c 512 a.mjs' }), ['512']);
  // 重放器必须**带同一个缺陷** —— 否则它测的不是闸门。
  const line = (cmd) => JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }] } });
  assert.deepEqual(gateReadPathsInText(line('head -n 20 a.mjs')), ['20']);
  assert.deepEqual(gateReadPathsInText(line('tail -c 512 a.mjs')), ['512']);
});

test('eachLineOffset 打不开文件时静默返回，不抛', () => {
  let n = 0;
  assert.doesNotThrow(() => eachLineOffset('/nonexistent-ow-probe', () => n++));
  assert.equal(n, 0);
});

// ── ③ 沙箱分桶 ────────────────────────────────────────────────────────

test('isSandbox 认出本仓自己的测试沙箱，不误判真实项目', () => {
  assert.equal(isSandbox({ cwd: 'C:\\Users\\x\\AppData\\Local\\Temp\\ptu-lab\\proj', slug: 'C--Users-Administrator-AppData-Local-Temp-ptu-lab-proj' }), true);
  assert.equal(isSandbox({ cwd: 'D:\\Projects\\Overwatch\\.tmp-analysis\\pretooluse-proto\\proj', slug: 'x' }), true);
  assert.equal(isSandbox({ cwd: 'D:\\Projects\\Overwatch', slug: 'D--Projects-Overwatch' }), false);
  assert.equal(isSandbox({ cwd: 'D:\\Server\\MCServers\\Server plugin\\Hilltop Village', slug: 'd--Server-MCServers-Server-plugin-Hilltop-Village' }), false);
});

// ── ④ fork 去重 ───────────────────────────────────────────────────────

test('dedupeForks 把前缀逐条相同的副本合成一个', () => {
  const base = [];
  for (let i = 0; i < 40; i++) base.push({ type: 'x', message: { content: `c${i}` } });
  const a = { sessionId: 'a', seq: base.map((o) => fnv1a(0, JSON.stringify(o))), records: 40, mtimeMs: 2 };
  const b = { sessionId: 'b', seq: [...a.seq, fnv1a(0, 'more')], records: 41, mtimeMs: 1 };
  const c = { sessionId: 'c', seq: [fnv1a(0, 'other')], records: 1, mtimeMs: 3 };
  const { kept, merged } = dedupeForks([a, b, c]);
  assert.equal(merged, 1);
  assert.equal(kept.length, 2);
  assert.ok(kept.some((s) => s.sessionId === 'b'), '保留记录数最多的那份');
  assert.ok(kept.some((s) => s.sessionId === 'c'));
});

test('dedupeForks 不合并前缀只相同一小段的两个会话', () => {
  const mk = (id, seed, n) => ({
    sessionId: id,
    seq: Array.from({ length: n }, (_, i) => fnv1a(seed, String(i))),
    records: n, mtimeMs: 1,
  });
  const { merged } = dedupeForks([mk('a', 1, 40), mk('b', 2, 40)]);
  assert.equal(merged, 0);
});

// ── ⑤ 统计与报告 ──────────────────────────────────────────────────────

test('distOf 给出分布，空输入不炸', () => {
  assert.equal(distOf([]).n, 0);
  const d = distOf([0, 1, 2, 3, 10]);
  assert.equal(d.n, 5);
  assert.equal(d.zero, 1);
  assert.equal(d.lt3, 3);
  assert.equal(d.max, 10);
  assert.equal(d.p50, 2);
});

test('structuralKind 只用结构事实，不猜语义', () => {
  const k = structuralKind({
    cwd: '/p', writeCount: 3, agentCalls: 1,
    firstWrite: { name: 'Write', path: '/p/docs/a.md' },
  });
  assert.equal(k, 'new/doc/in-cwd/multi-write/agent-first');
  const k2 = structuralKind({
    cwd: '/p', writeCount: 1, agentCalls: 0,
    firstWrite: { name: 'Write', path: '/elsewhere/a.txt' },
  });
  assert.equal(k2, 'new/data/outside-cwd/one-shot/no-agent');
});

test('verdict 与「gateReads 阈值判断」必须给出同一结论（同一份证据）', () => {
  const mk = (paths) => ({
    sessionId: 's', cwd: '/p', path: '/p/none.jsonl',
    firstWrite: { name: 'Write', input: { file_path: '/p/a' } },
    readPathsWindow: paths,
  });
  // 2 个读 → 不足 3 → 两个口径都说拦
  const low = mk(['/p/a', '/p/b']);
  assert.equal(verdict(low, { minReads: 3 }).decision, 'would-deny');
  assert.ok(low.readPathsWindow.length < 3);
  // 3 个读 → 两个口径都说放
  const ok = mk(['/p/a', '/p/b', '/p/c']);
  assert.equal(verdict(ok, { minReads: 3 }).decision, 'allow');
  assert.ok(ok.readPathsWindow.length >= 3);
});

test('verdict 走的是真 decide()：observe 模式只记账不输出', () => {
  const cfg = { ...defaultConfig(), mode: 'observe', minReads: 3 };
  const out = decide({
    hook_event_name: 'PreToolUse', session_id: 's', cwd: '/p',
    tool_name: 'Write', tool_input: { file_path: '/p/a' },
  }, { config: cfg, cwd: '/p', marker: { exists: false }, reads: { paths: [] } });
  assert.equal(out.action, 'passthrough');
  assert.equal(out.log.decision, 'would-deny');
  assert.equal(out.output, null, 'observe 不输出任何东西 = 放行');
});

// ── ⑥ 端到端 ──────────────────────────────────────────────────────────

test('buildReport 端到端：真实项目与沙箱分开报，且 decide 复算与计数一致', () => {
  const box = sandbox();
  try {
    // 真实项目：读了 3 个 → 不该拦
    writeTranscript(box.dir, 'D--Projects-Real', 'r1', [
      user('干活'), read('/r/a.mjs'), read('/r/b.mjs'), read('/r/c.mjs'), write('/r/out.txt'),
    ]);
    // 真实项目：读了 0 个 → 该拦
    writeTranscript(box.dir, 'D--Projects-Real', 'r2', [user('直接写'), write('/r/out2.txt')]);
    // 沙箱：读 0 个 → 该拦（但单列一桶）
    mkdirSync(join(box.dir, 'C--Users-Administrator-AppData-Local-Temp-probe'), { recursive: true });
    writeFileSync(join(box.dir, 'C--Users-Administrator-AppData-Local-Temp-probe', 'z1.jsonl'),
      [user('Write a file'), write('/tmp/out.txt')].map((r) => JSON.stringify(r)).join('\n') + '\n');

    const r = buildReport(box.dir, { threshold: 3 });
    assert.equal(r.totals.transcripts, 3);
    assert.equal(r.real.withWrite, 2);
    assert.equal(r.sandbox.withWrite, 1);
    assert.equal(r.real.deny, 1, '真实项目里 1 个被拦');
    assert.equal(r.sandbox.deny, 1, '沙箱 1 个被拦，但不能算进真实项目');
    // 核心不变量：计数与真 decide() 复算一致 —— **仅在首写全属 Write 侧时成立**。
    // Edit 侧自 2026-11-14 起判「读过目标文件本身」，与「读过几个不同文件」是不同的量。
    assert.equal(r.real.deny, r.real.decideDeny);
    assert.equal(r.sandbox.deny, r.sandbox.decideDeny);
    assert.equal(r.real.decidetargetRead + r.sandbox.decidetargetRead, 0, '本用例没有 Edit 侧首写');
  } finally { box.clean(); }
});

test('listTranscripts 只取 <root>/<slug>/<id>.jsonl 两层，不扫 subagents', () => {
  const box = sandbox();
  try {
    const p = writeTranscript(box.dir, 'proj', 's1', [user('x')]);
    const sub = join(box.dir, 'proj', 's1', 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'a.jsonl'), JSON.stringify(user('inner')) + '\n');
    const list = listTranscripts(box.dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].path, p);
  } finally { box.clean(); }
});

test('defaultRoot 指向 ~/.claude/projects', () => {
  assert.ok(defaultRoot().replace(/\\/g, '/').endsWith('.claude/projects'));
});

// ── ⑦ 归因（第 3 条指标）──────────────────────────────────────────────

test('isContinuation 认出宿主的续接摘要，不误判人类发言', () => {
  assert.equal(isContinuation({ firstHuman: 'This session is being continued from a previous conversation that ran out' }), true);
  assert.equal(isContinuation({ firstHuman: 'Conversation summary: blah' }), true);
  assert.equal(isContinuation({ firstHuman: '帮我修一下这个 bug' }), false);
  assert.equal(isContinuation({ firstHuman: '' }), false);
  assert.equal(isContinuation({}), false);
});

test('attribute 把续接会话归到 A，哪怕主 transcript 里读过 0 个', () => {
  const s = {
    firstHuman: 'This session is being continued from a previous conversation',
    path: '/nonexistent-ow-probe.jsonl', agentCalls: 0, broadReads: 0, firstWrite: { off: 0 },
  };
  assert.equal(attribute(s).cls, 'A-continuation');
});

test('attribute 优先 A 于其它类：续接 + 派过 agent 也算 A', () => {
  const s = {
    firstHuman: 'This session is being continued from a previous conversation',
    path: '/nonexistent-ow-probe.jsonl', agentCalls: 5, broadReads: 99, firstWrite: { off: 0 },
  };
  assert.equal(attribute(s).cls, 'A-continuation');
});

test('attribute 在没有任何证据时给 D，不硬凑一个「有读」的类', () => {
  const s = {
    firstHuman: '干个活', path: '/nonexistent-ow-probe.jsonl',
    agentCalls: 0, broadReads: 0, firstWrite: { off: 0 },
  };
  assert.equal(attribute(s).cls, 'D-no-evidence');
});

test('attribute 把「做过结构性探索」归到 C', () => {
  const s = {
    firstHuman: '干个活', path: '/nonexistent-ow-probe.jsonl',
    agentCalls: 0, broadReads: 5, firstWrite: { off: 0 },
  };
  assert.equal(attribute(s).cls, 'C-broad-explore');
});

test('subagentReadsByToolId 在子 agent 目录不存在时返回 0，不抛', () => {
  const r = subagentReadsByToolId({ path: '/nonexistent-ow-probe.jsonl' }, new Set());
  assert.deepEqual(r, { files: 0, matched: 0, reads: 0 });
});

test('agentToolIdsBefore 只取首写之前的 Agent 调用 id', () => {
  const box = sandbox();
  try {
    const recs = [
      user('干活'),
      agent('先查一遍'),
      write('/p/out.txt'),
      agent('写完再查'),
    ];
    const p = writeTranscript(box.dir, 'proj', 's1', recs);
    const s = analyzeOne(listTranscripts(box.dir)[0]);
    const ids = agentToolIdsBefore(s);
    assert.equal(ids.size, 1, '首写之后那次 Agent 不算');
    // 首写的字节偏移确实落在两个 Agent 之间
    assert.ok(s.firstWrite.off > 0 && s.firstWrite.off < statSync(p).size);
  } finally { box.clean(); }
});

test('buildReport 的 attribution 五类计数之和等于被拦数', () => {
  const box = sandbox();
  try {
    writeTranscript(box.dir, 'D--Projects-A', 'a1', [
      user('This session is being continued from a previous conversation'), write('/a/out.md'),
    ]);
    writeTranscript(box.dir, 'D--Projects-A', 'a2', [user('直接写'), write('/a/out2.md')]);
    writeTranscript(box.dir, 'D--Projects-A', 'a3', [
      user('探索了下'), bash('ls -la'), bash('find . -name x'), bash('git log'), write('/a/out3.md'),
    ]);
    const r = buildReport(box.dir, { threshold: 3 });
    const sum = Object.values(r.real.attribution).reduce((a, b) => a + b, 0);
    assert.equal(sum, r.real.deny);
    assert.equal(r.real.attribution['A-continuation'], 1);
    assert.equal(r.real.attribution['C-broad-explore'], 1);
    assert.equal(r.real.attribution['D-no-evidence'], 1);
  } finally { box.clean(); }
});
