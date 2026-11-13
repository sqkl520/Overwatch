#!/usr/bin/env node
/**
 * measure-intervention-cost.test.mjs — 「执行期中断的代价」测量器的回归测试。
 *
 * 每条断言对应报告 §1 的一句口径。造最小的合成输入，不读真实 transcript——
 * 真实语料会持续变化，测试必须只锁口径，不锁数字。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normPath, isReworkDemand, undoEvents, commonPrefixLen, dedupeResumeForks,
  recordSignature, readSessionDetail, sessionCost, undoAroundInterruptions,
  redoShareAfterInterruptions, redoShareRandomWindows,
  density, groupRow, stratified, matchedPairs, summarize, formatReport,
  PRIMARY_TIER, MIN_FRAGMENT_LEN, RESUME_PREFIX_RATIO, RESUME_MIN_COMMON, TEXT_CAP,
} from './measure-intervention-cost.mjs';

// ── 造记录 ──────────────────────────────────────────────────────────

let clock = 0;
const ts = () => {
  clock += 60_000;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + clock).toISOString();
};

const human = (text) => ({ type: 'user', timestamp: ts(), message: { role: 'user', content: text }, origin: { kind: 'human' } });
const toolUse = (name, input, id) => ({
  type: 'assistant', timestamp: ts(),
  message: { role: 'assistant', content: [{ type: 'tool_use', id: id ?? `t${clock}`, name, input }] },
});
const write = (path, content, id) => toolUse('Write', { file_path: path, content: content ?? 'x' }, id);
const edit = (path, old_, nw, id) => toolUse('Edit', { file_path: path, old_string: old_, new_string: nw }, id);
const ask = (id) => toolUse('AskUserQuestion', { questions: [{ question: 'q?', header: 'H', options: [{ label: 'a' }] }] }, id);
const answer = () => ({
  type: 'user', timestamp: ts(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tA', content: 'ok' }] },
  toolUseResult: { questions: [{ question: 'q?', options: [{ label: 'a' }] }], answers: { 'q?': 'a' } },
});

/** 写一个临时 transcript 并读回来。 */
function detailOf(records) {
  const dir = mkdtempSync(join(tmpdir(), 'ow-cost-'));
  const p = join(dir, 's.jsonl');
  try {
    writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return readSessionDetail(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 路径归一 ────────────────────────────────────────────────────────

test('normPath 反斜杠转正斜杠并小写', () => {
  assert.equal(normPath('D:\\A\\B.MD'), 'd:/a/b.md');
  assert.equal(normPath('/a/b'), '/a/b');
});

test('normPath 对空值返回空串，不返回 undefined', () => {
  assert.equal(normPath(null), '');
  assert.equal(normPath(''), '');
  assert.equal(normPath(undefined), '');
});

// ── 主指标：返工需求 ────────────────────────────────────────────────

test('isReworkDemand 命中纠正类语义', () => {
  for (const t of ['不对', '不是这样', '你改错了', '改回原来的', '撤销这次改动', '重做', '理解错了']) {
    assert.equal(isReworkDemand(t), true, t);
  }
});

test('isReworkDemand 不把普通需求当返工', () => {
  for (const t of ['继续', '加一个按钮', '再扫描一下D盘', '做验证']) {
    assert.equal(isReworkDemand(t), false, t);
  }
});

test('isReworkDemand 长文档一律不判定（贴日志不是反馈）', () => {
  const long = `${'x'.repeat(TEXT_CAP)}不对`;
  assert.equal(isReworkDemand(long), false);
});

test('extended 档比 primary 档宽，只用于敏感性', () => {
  const t = '这个我不满意，返工一下';
  assert.equal(isReworkDemand(t), false);
  assert.equal(isReworkDemand(t, 'extended'), true);
});

test('PRIMARY_TIER 复用旧脚本的 correction 档，不另写正则', () => {
  assert.equal(PRIMARY_TIER, 'correction');
});

// ── 自撤销事件 ──────────────────────────────────────────────────────

test('undoEvents 认「覆盖本会话已写过的同一路径」', () => {
  const ev = undoEvents([
    { name: 'write', path: 'a.md' },
    { name: 'write', path: 'b.md' },
    { name: 'write', path: 'a.md' },
  ]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'overwrite');
  assert.equal(ev[0].index, 2);
});

test('undoEvents 认「Edit 恢复了此前删掉的文本」', () => {
  const frag = 'const x = 1; // a long enough fragment';
  const ev = undoEvents([
    { name: 'edit', path: 'a.md', old: frag, nw: 'replacement line' },
    { name: 'edit', path: 'a.md', old: 'replacement line', nw: frag },
  ]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'revert');
});

test('undoEvents 短片段不参与判定（避免 } / return 误配）', () => {
  const short = 'x'.repeat(MIN_FRAGMENT_LEN - 1);
  const ev = undoEvents([
    { name: 'edit', path: 'a.md', old: short, nw: 'zzz' },
    { name: 'edit', path: 'a.md', old: 'zzz', nw: short },
  ]);
  assert.equal(ev.length, 0);
});

test('undoEvents 没有路径的写操作被跳过（Bash 写入无法定位文件）', () => {
  const ev = undoEvents([
    { name: 'write', path: '' },
    { name: 'write', path: '' },
  ]);
  assert.equal(ev.length, 0);
});

test('undoEvents 不同文件之间不互相算撤销', () => {
  const frag = 'a long enough fragment here';
  const ev = undoEvents([
    { name: 'edit', path: 'a.md', old: frag, nw: 'z' },
    { name: 'edit', path: 'b.md', old: 'z', nw: frag },
  ]);
  assert.equal(ev.length, 0);
});

// ── 恢复分支去重 ────────────────────────────────────────────────────

test('commonPrefixLen 返回公共前缀条数', () => {
  assert.equal(commonPrefixLen([1, 2, 3], [1, 2, 9]), 2);
  assert.equal(commonPrefixLen([1, 2], [1, 2]), 2);
  assert.equal(commonPrefixLen([], [1]), 0);
});

test('dedupeResumeForks 把「前者是后者前缀」的两份并成一簇，保留长的', () => {
  const long = Array.from({ length: 100 }, (_, i) => i);
  const short = long.slice(0, 60);
  const items = [
    { sessionId: 'short', firstTs: 'T', firstHuman: 'same', seq: Uint32Array.from(short), bytes: 10 },
    { sessionId: 'long', firstTs: 'T', firstHuman: 'same', seq: Uint32Array.from(long), bytes: 20 },
  ];
  const r = dedupeResumeForks(items);
  assert.equal(r.mergedAway, 1);
  assert.deepEqual(r.keep, ['long']);
});

test('dedupeResumeForks 不并两段「开头相同但后面各自很长」的真实工作', () => {
  const head = Array.from({ length: 40 }, (_, i) => i);
  const a = [...head, ...Array.from({ length: 200 }, (_, i) => 1000 + i)];
  const b = [...head, ...Array.from({ length: 200 }, (_, i) => 9000 + i)];
  const items = [
    { sessionId: 'a', firstTs: 'T', firstHuman: 'same', seq: Uint32Array.from(a), bytes: 10 },
    { sessionId: 'b', firstTs: 'T', firstHuman: 'same', seq: Uint32Array.from(b), bytes: 20 },
  ];
  // 公共前缀 40 条，但只占较短者(240) 的 16.7% < 98% → 不并
  const r = dedupeResumeForks(items);
  assert.equal(r.mergedAway, 0);
  assert.equal(r.keep.length, 2);
});

test('dedupeResumeForks 前缀太短不并（MIN_COMMON 门槛）', () => {
  const head = Array.from({ length: RESUME_MIN_COMMON - 1 }, (_, i) => i);
  const items = [
    { sessionId: 'a', firstTs: 'T', firstHuman: 'x', seq: Uint32Array.from(head), bytes: 1 },
    { sessionId: 'b', firstTs: 'T', firstHuman: 'x', seq: Uint32Array.from(head), bytes: 2 },
  ];
  assert.equal(dedupeResumeForks(items).mergedAway, 0);
});

test('dedupeResumeForks 不跨 firstTs 合并（不同时间开的会话不是恢复分支）', () => {
  const seq = Array.from({ length: 100 }, (_, i) => i);
  const items = [
    { sessionId: 'a', firstTs: 'T1', firstHuman: 'x', seq: Uint32Array.from(seq), bytes: 1 },
    { sessionId: 'b', firstTs: 'T2', firstHuman: 'x', seq: Uint32Array.from(seq), bytes: 2 },
  ];
  assert.equal(dedupeResumeForks(items).mergedAway, 0);
});

test('dedupeResumeForks 三份前缀链并成一簇，只留一份', () => {
  const full = Array.from({ length: 120 }, (_, i) => i);
  const items = [
    { sessionId: 'a', firstTs: 'T', firstHuman: 'x', seq: Uint32Array.from(full.slice(0, 100)), bytes: 1 },
    { sessionId: 'b', firstTs: 'T', firstHuman: 'x', seq: Uint32Array.from(full.slice(0, 110)), bytes: 2 },
    { sessionId: 'c', firstTs: 'T', firstHuman: 'x', seq: Uint32Array.from(full), bytes: 3 },
  ];
  const r = dedupeResumeForks(items);
  assert.equal(r.mergedAway, 2);
  assert.deepEqual(r.keep, ['c']);
});

test('RESUME_PREFIX_RATIO 是 0.98、MIN_COMMON 是 30（口径冻结）', () => {
  assert.equal(RESUME_PREFIX_RATIO, 0.98);
  assert.equal(RESUME_MIN_COMMON, 30);
});

// ── 记录签名 ────────────────────────────────────────────────────────

test('recordSignature 丢掉每条都不同的字段，只留类型与内容', () => {
  const a = recordSignature({ type: 'user', uuid: 'u1', parentUuid: 'p1', sessionId: 's1', timestamp: 'T1', message: { content: 'hi' } });
  const b = recordSignature({ type: 'user', uuid: 'u2', parentUuid: 'p2', sessionId: 's2', timestamp: 'T2', message: { content: 'hi' } });
  assert.equal(a, b);
});

test('recordSignature 对不同的工具入参给出不同签名', () => {
  const a = recordSignature({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'a' } }] } });
  const b = recordSignature({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'b' } }] } });
  assert.notEqual(a, b);
});

// ── 会话级：执行起点与中断 ──────────────────────────────────────────

test('sessionCost：执行期中断不含会话首条人类消息', () => {
  const d = detailOf([
    human('开始'), write('a.md'), write('b.md'),
  ]);
  const c = sessionCost(d);
  assert.equal(c.interruptions, 0);
});

test('sessionCost：执行起点之前的提问判 A，之后判 B，无提问判 C', () => {
  const A = sessionCost(detailOf([human('开始'), ask('q1'), answer(), write('a.md')]));
  assert.equal(A.groupFromDetail, 'A');
  const B = sessionCost(detailOf([human('开始'), write('a.md'), ask('q1'), answer()]));
  assert.equal(B.groupFromDetail, 'B');
  const C = sessionCost(detailOf([human('开始'), write('a.md')]));
  assert.equal(C.groupFromDetail, 'C');
});

test('sessionCost：没有写操作时 hasExec=false，不进 A/B/C', () => {
  const c = sessionCost(detailOf([human('开始'), toolUse('Read', { file_path: 'a' })]));
  assert.equal(c.hasExec, false);
  assert.equal(c.groupFromDetail, 'none');
});

test('sessionCost：执行期里的纠正被计入 reworkPrimary 与构成', () => {
  const c = sessionCost(detailOf([
    human('开始'), write('a.md'), human('你改错了，改回'), write('b.md'), human('继续'),
  ]));
  assert.equal(c.interruptions, 2);
  assert.equal(c.reworkPrimary, 1);
  assert.equal(c.nudges, 1);
  assert.equal(c.corrections, 1);
});

test('sessionCost：执行期中断数量等于人类发言条数（催促也算中断，但不算返工）', () => {
  const c = sessionCost(detailOf([
    human('开始'), write('a.md'), human('继续'), human('继续'), human('继续'),
  ]));
  assert.equal(c.interruptions, 3);
  assert.equal(c.reworkPrimary, 0);
  assert.equal(c.nudges, 3);
});

test('sessionCost：提问作答不算人类发言（它是 tool_result）', () => {
  const c = sessionCost(detailOf([human('开始'), write('a.md'), ask('q1'), answer()]));
  assert.equal(c.interruptions, 0);
});

// ── 信号有效性检验 ──────────────────────────────────────────────────

test('undoAroundInterruptions 数出中断前后各 K 个写操作的撤销数', () => {
  const d = detailOf([
    human('开始'),
    write('a.md'),            // exec start（index 0）
    write('b.md'),            // index 1
    human('重做吧'),           // 中断点
    write('a.md'),            // index 2：覆盖 a.md → 撤销
    write('c.md'),            // index 3
  ]);
  const v = undoAroundInterruptions(d, { K: 5 });
  assert.equal(v.n, 1);
  // 中断后：a.md（撤销）、c.md → 2 个写操作、1 个撤销
  assert.equal(v.afterWrites, 2);
  assert.equal(v.after, 1);
  // 中断前：a.md、b.md → 2 个写操作、0 个撤销
  assert.equal(v.beforeWrites, 2);
  assert.equal(v.before, 0);
});

test('undoAroundInterruptions 在没有写操作时安全返回 0', () => {
  const v = undoAroundInterruptions({ writes: [], humans: [{ i: 0, text: 'x' }] });
  assert.equal(v.n, 0);
  assert.equal(v.after, 0);
  assert.equal(v.before, 0);
});

test('redoShareAfterInterruptions 数出「中断后的写落在中断前写过的文件上」的比例', () => {
  const d = detailOf([
    human('开始'),
    write('a.md'),          // exec start
    write('b.md'),
    human('重做吧'),
    write('a.md'),          // 落在中断前写过的 a.md
    write('b.md'),          // 落在中断前写过的 b.md
    write('c.md'),          // 新文件
  ]);
  const r = redoShareAfterInterruptions(d, { K: 10 });
  assert.equal(r.windows, 1);
  assert.equal(r.total, 3);
  assert.equal(r.hits, 2);
});

test('redoShareRandomWindows 是确定性的（同一随机源给同一结果）', () => {
  const d = detailOf([
    human('开始'), write('a.md'), write('b.md'), human('继续'),
    write('a.md'), write('b.md'), write('c.md'), write('d.md'),
  ]);
  let s = 1;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  let t = 1;
  const rnd2 = () => { t = (t * 16807) % 2147483647; return t / 2147483647; };
  const r1 = redoShareRandomWindows(d, { K: 2, rnd, trials: 10 });
  const r2 = redoShareRandomWindows(d, { K: 2, rnd: rnd2, trials: 10 });
  assert.deepEqual(r1, r2);
});

test('redoShareRandomWindows 跳过跨人类发言的窗口', () => {
  const d = detailOf([
    human('开始'), write('a.md'), human('插话'), write('b.md'), write('c.md'),
  ]);
  const r = redoShareRandomWindows(d, { K: 3, rnd: () => 0, trials: 5 });
  // 任何 K=3 的窗口都会跨过那条人类发言，所以样本为 0
  assert.equal(r.windows, 0);
  assert.equal(r.total, 0);
});

// ── 统计 ────────────────────────────────────────────────────────────

test('density 按执行期工具数摊平，不依赖会话数', () => {
  const rows = [{ execTools: 100, reworkPrimary: 1 }, { execTools: 300, reworkPrimary: 3 }];
  assert.equal(density(rows, 'reworkPrimary'), 1);
});

test('density 在工具数为 0 时返回 null，不返回 0', () => {
  assert.equal(density([{ execTools: 0, reworkPrimary: 0 }], 'reworkPrimary'), null);
});

test('groupRow 的主指标是中断级比率（分子分母都是中断级）', () => {
  const r = groupRow([
    { execTools: 1000, interruptions: 10, reworkPrimary: 2, reworkExtended: 3, undoTotal: 5, corrections: 2, nudges: 5, normal: 3 },
    { execTools: 3000, interruptions: 30, reworkPrimary: 1, reworkExtended: 1, undoTotal: 1, corrections: 1, nudges: 10, normal: 19 },
  ]);
  assert.equal(r.interruptions, 40);
  assert.equal(r.reworkPrimary, 3);
  assert.equal(r.primaryRate, 3 / 40);
  assert.equal(r.primaryPer100, (3 / 4000) * 100);
  assert.equal(r.corrections, 3);
  assert.equal(r.nudges, 15);
});

test('groupRow 在零中断时主指标为 null，不编造 0', () => {
  const r = groupRow([{ execTools: 10, interruptions: 0, reworkPrimary: 0, reworkExtended: 0, undoTotal: 0 }]);
  assert.equal(r.primaryRate, null);
});

test('stratified 按四分位切四层，每层给出各组', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push({ group: i % 3 === 0 ? 'A' : 'B', execTools: i * 10, interruptions: 1, reworkPrimary: 0, reworkExtended: 0, undoTotal: 0 });
  }
  const s = stratified(rows);
  assert.equal(s.length, 4);
  for (const band of s) for (const g of ['A', 'B', 'C']) assert.ok(band[g]);
});

test('matchedPairs 按体量配对，超容差的丢弃并计数', () => {
  const a = [{ sessionId: 'a1', execTools: 100, interruptions: 2, reworkPrimary: 1 }];
  const b = [{ sessionId: 'b1', execTools: 110, interruptions: 2, reworkPrimary: 0 }];
  const r = matchedPairs(a, b);
  assert.equal(r.n, 1);
  assert.equal(r.aWins, 0);
  assert.equal(r.bWins, 1);
});

test('matchedPairs 体量差超过容差时不成对', () => {
  const a = [{ sessionId: 'a1', execTools: 10, interruptions: 1, reworkPrimary: 0 }];
  const b = [{ sessionId: 'b1', execTools: 100000, interruptions: 1, reworkPrimary: 0 }];
  const r = matchedPairs(a, b);
  assert.equal(r.n, 0);
});

// ── 汇总 ────────────────────────────────────────────────────────────

test('summarize 的三组行与 totals 自洽', () => {
  const rows = [
    { sessionId: 'a', group: 'A', execTools: 100, interruptions: 10, reworkPrimary: 1, reworkExtended: 2, undoTotal: 3, corrections: 1, nudges: 5, normal: 4 },
    { sessionId: 'b', group: 'B', execTools: 900, interruptions: 30, reworkPrimary: 3, reworkExtended: 4, undoTotal: 9, corrections: 3, nudges: 20, normal: 7 },
    { sessionId: 'c', group: 'C', execTools: 50, interruptions: 2, reworkPrimary: 0, reworkExtended: 0, undoTotal: 1, corrections: 0, nudges: 1, normal: 1 },
  ];
  const res = summarize(rows, {});
  assert.equal(res.groups.A.n, 1);
  assert.equal(res.groups.B.reworkPrimary, 3);
  assert.equal(res.totals.interruptions, 42);
  assert.equal(res.totals.reworkPrimary, 4);
  assert.equal(res.totals.undos, 13);
});

test('summarize 在控制体量后给出偏相关（不隐藏体量混淆）', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({
      sessionId: `s${i}`, group: i < 4 ? 'A' : 'B',
      execTools: 100 + i * 50, interruptions: 2 + i,
      reworkPrimary: i % 3, reworkExtended: i % 3, undoTotal: i,
    });
  }
  const res = summarize(rows, {});
  assert.ok('partialInterruptionsRework' in res.sizeCorr);
  assert.ok('corrToolsInterruptions' in res.sizeCorr);
});

test('formatReport 在空数据上不抛，并写明口径', () => {
  const res = summarize([], { root: '/x', days: 0, files: 0 });
  const text = formatReport(res);
  assert.match(text, /口径/);
  assert.match(text, /返工需求率/);
});

test('formatReport 打印去重两层与分组变化', () => {
  const res = summarize([], {
    root: '/x', days: 0, files: 10,
    phaseDuplicateSessions: 3, phaseForkDuplicates: 5,
    resumeMerged: 7, resumeClusters: [{ ids: ['a', 'b'], kept: 'a' }],
    groupsBefore: { A: 14, B: 38, C: 130, none: 120 },
    groupsAfter: { A: 7, B: 34, C: 82, none: 119 },
    groupMismatches: [], interruptionMismatches: [],
  });
  const text = formatReport(res);
  assert.match(text, /第一层/);
  assert.match(text, /第二层/);
  assert.match(text, /A 14 → 7/);
});
