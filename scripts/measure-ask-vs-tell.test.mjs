#!/usr/bin/env node
/**
 * measure-ask-vs-tell.test.mjs — 「提问不算成本」新主指标的回归测试。
 *
 * 每条断言对应报告 §1 / §3 的一句口径。全部用最小合成输入，**不读真实 transcript**：
 * 真实语料持续变化，测试只锁口径，不锁数字。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isAskCall, classifyExecHuman, isCostly, isSandbox, cwdOf,
  readAskTimeline, sessionRow,
  density, countOf, perSessionDensity, cleanRate, groupRow,
  densityDiffTest, cleanDiffTest, matchedOnWork, stratifyByWork, summarize, formatReport,
  ASK_TOOLS, COST_TIER, SECONDARY_TIERS, PER, MATCH_LOG_TOLERANCE,
} from './measure-ask-vs-tell.mjs';

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
const write = (path, id) => toolUse('Write', { file_path: path, content: 'x' }, id);
const read = (path, id) => toolUse('Read', { file_path: path }, id);
const ask = (id) => toolUse('AskUserQuestion', { questions: [{ question: 'q?', header: 'H', options: [{ label: 'a' }] }] }, id);
const plan = (id) => toolUse('ExitPlanMode', { plan: 'p' }, id);
const answer = (id) => ({
  type: 'user', timestamp: ts(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id ?? 'tA', content: 'ok' }] },
  toolUseResult: { questions: [{ question: 'q?', options: [{ label: 'a' }] }], answers: { 'q?': 'a' } },
});

/** 写一个临时 transcript 并读回来。 */
function timelineOf(records) {
  const dir = mkdtempSync(join(tmpdir(), 'ow-avt-'));
  const p = join(dir, 's.jsonl');
  try {
    writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return readAskTimeline(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 直接造一行（跳过读盘），只测统计层。 */
const row = (o = {}) => ({
  sessionId: 's', hasExec: true, execTools: 100, execAskUser: 0, execPlanApprovals: 0,
  execAsks: 0, execWork: 100, interruptions: 0, corrections: 0, nudges: 0, feedback: 0,
  group: 'C', sandbox: false, ...o,
});

// ── 判据：什么算「提问」 ────────────────────────────────────────────

test('isAskCall 认 AskUserQuestion 与 ExitPlanMode，大小写无关', () => {
  assert.equal(isAskCall('AskUserQuestion'), true);
  assert.equal(isAskCall('askuserquestion'), true);
  assert.equal(isAskCall('ExitPlanMode'), true);
  assert.equal(isAskCall('exitplanmode'), true);
});

test('isAskCall 不把普通工具当提问', () => {
  for (const n of ['Read', 'Write', 'Edit', 'Bash', 'Grep', null, '', 'Edit=file_path']) {
    assert.equal(isAskCall(n), false, String(n));
  }
});

test('ASK_TOOLS 恰好两个，新增时必须改这份测试', () => {
  assert.deepEqual([...ASK_TOOLS].sort(), ['askuserquestion', 'exitplanmode']);
});

// ── 判据：什么算成本 ────────────────────────────────────────────────

test('classifyExecHuman 把「纠正」单独分出来', () => {
  for (const t of ['不对', '你改错了', '撤销这次改动', '重做', '理解错了', '改回原来的']) {
    assert.equal(classifyExecHuman(t), 'correction', t);
  }
});

test('classifyExecHuman 把「催促」单独分出来，不并进纠正', () => {
  for (const t of ['继续', '接着做', 'go on']) {
    assert.equal(classifyExecHuman(t), 'nudge', t);
  }
});

test('classifyExecHuman 把新需求 / 补前提 / 报告现象算 feedback，不是成本', () => {
  for (const t of [
    '再扫描一下D盘', '加一个按钮', '按你建议来', '先做第 1 件', '做验证',
    '把 session-586b0fbc 导入桌面版', '我觉得应该先设计一下前端',
  ]) {
    assert.equal(classifyExecHuman(t), 'feedback', t);
  }
});

test('isCostly 只对纠正返回真', () => {
  assert.equal(isCostly('你搞错了'), true);
  assert.equal(isCostly('继续'), false);
  assert.equal(isCostly('再扫一下 D 盘'), false);
});

test('COST_TIER 是 correction，二档是 correction+nudge', () => {
  assert.equal(COST_TIER, 'correction');
  assert.deepEqual([...SECONDARY_TIERS], ['correction', 'nudge']);
});

test('长文档不被判成纠正（贴日志不算用户否定 AI）', () => {
  const doc = `${'x'.repeat(900)} 这里描述的是「撤销」这个功能`;
  assert.equal(classifyExecHuman(doc), 'feedback');
});

// ── 沙箱判据 ────────────────────────────────────────────────────────

test('isSandbox 命中 Temp 与 .tmp-analysis', () => {
  assert.equal(isSandbox('C:\\Users\\u\\AppData\\Local\\Temp\\x', ''), true);
  assert.equal(isSandbox('/mnt/temp/x', ''), true);           // 大小写无关
  assert.equal(isSandbox('D:\\p\\.tmp-analysis\\x', ''), true);
  assert.equal(isSandbox('', 'C--Users-Administrator-AppData-Local-Temp-foo'), true);
  assert.equal(isSandbox('', 'Overwatch--tmp-analysis'), true);
});

test('isSandbox 的已知缺口：POSIX 的 /tmp 不在判据内（与既有实现同源，见报告 §6）', () => {
  // 这条**不是在断言正确**，是把一处已知局限钉住：本仓语料全在 Windows，
  // 既有 `observe-reality-check.isSandbox()` 只认带 `Temp` 的路径。改了它，
  // 本脚本的「真实项目」分母就无法与那两份报告对话。发现这个缺口后要用它改口径。
  assert.equal(isSandbox('/tmp/ow-cost-abc', 'tmp-ow-cost-abc'), false);
});

test('isSandbox 不把真实项目目录当沙箱', () => {
  assert.equal(isSandbox('D:\\Projects\\Overwatch', 'D--Projects-Overwatch'), false);
  assert.equal(isSandbox('/home/u/code', 'home-u-code'), false);
});

test('cwdOf 对不存在的文件返回空串，不抛', () => {
  assert.equal(cwdOf('/nonexistent-ow-probe-avt'), '');
});

// ── 时间线：执行期边界 ──────────────────────────────────────────────

test('readAskTimeline 分别记下 asked 与 plan，不合并成一个桶', () => {
  const d = timelineOf([human('开始'), ask('a1'), answer('a1'), plan('p1'), write('/x.mjs', 'w1')]);
  assert.equal(d.asks.length, 2);
  assert.deepEqual(d.asks.map((a) => a.name), ['askuserquestion', 'exitplanmode']);
});

test('读盘时数出「作答是打了一段字」的条数，以及其中被判为纠正的条数', () => {
  // 点了选项 → 有 toolUseResult.answers，不算人类发言，也不进泄漏计数
  const ok = timelineOf([human('开始'), ask('a1'), answer('a1'), write('/a.mjs')]);
  assert.equal(ok.humanAfterAsk, 0);
  // 没点选项、直接在下一轮打了字 → 算一条泄漏；若那句话是纠正，要能数出来
  const leak = timelineOf([human('开始'), ask('a1'), human('搞错了，重做'), write('/a.mjs')]);
  assert.equal(leak.humanAfterAsk, 1);
  assert.equal(leak.humanAfterAskCorrections, 1);
});

test('泄漏计数只看「提问后的第一条人类发言」，不看之后隔了多轮的那条', () => {
  const d = timelineOf([
    human('开始'), ask('a1'), answer('a1'), write('/a.mjs'), human('再加一个按钮'),
  ]);
  assert.equal(d.humanAfterAsk, 0);
});

test('readAskTimeline 不把提问作答记成人类发言', () => {
  const d = timelineOf([human('开始'), ask('a1'), answer('a1')]);
  assert.equal(d.humans.length, 1);
  assert.equal(d.humans[0].text, '开始');
});

test('readAskTimeline 不把 [Request interrupted by user] 记成人类发言', () => {
  const d = timelineOf([human('开始'), human('[Request interrupted by user]')]);
  assert.equal(d.humans.length, 1);
});

test('readAskTimeline 丢掉重复 id 的 tool_use', () => {
  const d = timelineOf([human('开始'), write('/a.mjs', 'same'), write('/a.mjs', 'same')]);
  assert.equal(d.writes.length, 1);
});

// ── 每会话行：分母扣掉提问 ──────────────────────────────────────────

test('execWork = 官方执行期工具数 − 执行期提问数', () => {
  const d = timelineOf([
    human('开始'), ask('q1'), answer('q1'), write('/a.mjs', 'w1'), ask('q2'), answer('q2'),
  ]);
  const r = sessionRow(d, { sessionId: 's', execTools: 10 });
  assert.equal(r.execAsks, 1);          // q1 在执行起点之前，不算执行期
  assert.equal(r.execWork, 9);
});

test('execWork 不会为负', () => {
  const d = timelineOf([human('开始'), ask('q1'), answer('q1'), write('/a.mjs', 'w1'), ask('q2')]);
  const r = sessionRow(d, { sessionId: 's', execTools: 0 });
  assert.equal(r.execWork, 0);
});

test('开工前提问 → A 组；开工后提问 → B 组；无提问 → C 组', () => {
  const a = sessionRow(timelineOf([human('开始'), ask('q1'), answer('q1'), write('/a.mjs')]), { sessionId: 'a', execTools: 5 });
  const b = sessionRow(timelineOf([human('开始'), write('/a.mjs'), ask('q1'), answer('q1')]), { sessionId: 'b', execTools: 5 });
  const c = sessionRow(timelineOf([human('开始'), write('/a.mjs')]), { sessionId: 'c', execTools: 5 });
  assert.equal(a.groupFromDetail, 'A');
  assert.equal(b.groupFromDetail, 'B');
  assert.equal(c.groupFromDetail, 'C');
});

test('没有写操作 → 无执行起点，不参与 A/B/C', () => {
  const r = sessionRow(timelineOf([human('开始'), read('/a.mjs')]), { sessionId: 's', execTools: 3 });
  assert.equal(r.hasExec, false);
  assert.equal(r.groupFromDetail, 'none');
});

test('ExitPlanMode 单独也能决定分组（旧口径看不见它）', () => {
  const r = sessionRow(timelineOf([human('开始'), plan('p1'), write('/a.mjs')]), { sessionId: 's', execTools: 5 });
  assert.equal(r.groupFromDetail, 'A');
  assert.equal(r.firstAskIsPlan, true);
});

test('会话首条人类消息不算执行期成本，哪怕它在执行起点之后', () => {
  // 先有写操作、后才有第一条人类消息：它仍是「开工指令」，不是纠正
  const r = sessionRow(timelineOf([write('/a.mjs'), human('不对，全错了')]), { sessionId: 's', execTools: 5 });
  assert.equal(r.interruptions, 0);
  assert.equal(r.corrections, 0);
});

test('执行期纠正被计入，执行期新需求不被计入', () => {
  const r = sessionRow(timelineOf([
    human('开始'), write('/a.mjs'), human('你搞错了，重做'), human('再扫一下 D 盘'),
  ]), { sessionId: 's', execTools: 8 });
  assert.equal(r.corrections, 1);
  assert.equal(r.feedback, 1);
  assert.equal(r.nudges, 0);
});

test('执行期催促进 nudges，不进 corrections', () => {
  const r = sessionRow(timelineOf([human('开始'), write('/a.mjs'), human('继续')]), { sessionId: 's', execTools: 8 });
  assert.equal(r.corrections, 0);
  assert.equal(r.nudges, 1);
});

test('恢复分支去重要用的三个键都在行上', () => {
  const d = timelineOf([human('开始'), write('/a.mjs')]);
  const r = sessionRow(d, { sessionId: 's', execTools: 1 });
  assert.equal(typeof r.firstHuman, 'string');
  assert.ok(r.seq instanceof Uint32Array);
  assert.equal(r.seq.length, d.seq.length);
});

// ── 统计：总和之比 ──────────────────────────────────────────────────

test('density 是 Σ分子 / Σ分母，不是每会话率的平均', () => {
  const rows = [
    row({ execWork: 1, corrections: 1 }),      // 每会话率 100%
    row({ execWork: 999, corrections: 0 }),    // 每会话率 0%
  ];
  const d = density(rows);
  assert.equal(d.count, 1);
  assert.equal(d.work, 1000);
  assert.ok(Math.abs(d.per100 - 0.1) < 1e-9); // 1/1000*100
});

test('密度分母为 0 时返回 null，不返回 0 或 Infinity', () => {
  assert.equal(density([row({ execWork: 0, corrections: 0 })]).per100, null);
  assert.equal(density([]).per100, null);
});

test('countOf 只数指定档位', () => {
  const rows = [row({ corrections: 3, nudges: 5, feedback: 7 })];
  assert.equal(countOf(rows, ['correction']), 3);
  assert.equal(countOf(rows, ['nudge']), 5);
  assert.equal(countOf(rows, SECONDARY_TIERS), 8);
});

test('perSessionDensity 剔除工作量为 0 的会话', () => {
  const v = perSessionDensity([row({ execWork: 0 }), row({ execWork: 50, corrections: 1 })]);
  assert.equal(v.length, 1);
  assert.ok(Math.abs(v[0] - 2) < 1e-9);
});

test('cleanRate 把「零纠正」算成干净，零发言不算（与旧一次性完成率的分界）', () => {
  const rows = [
    row({ interruptions: 3, corrections: 0 }),   // 说过 3 次话，但没纠正 → 新口径干净
    row({ interruptions: 0, corrections: 0 }),   // 一句话没说 → 也干净
    row({ interruptions: 2, corrections: 1 }),   // 纠正过一次 → 不干净
  ];
  const c = cleanRate(rows);
  assert.equal(c.n, 3);
  assert.equal(c.clean, 2);
});

test('groupRow 同时给三个口径：新密度 / 旧纠正率 / 旧一次性', () => {
  const g = groupRow([
    row({ execWork: 100, corrections: 1, interruptions: 4 }),
    row({ execWork: 100, corrections: 0, interruptions: 0 }),
  ]);
  assert.ok(Math.abs(g.per100 - 0.5) < 1e-9);        // 1/200*100
  assert.ok(Math.abs(g.oldCorrectionRate - 0.25) < 1e-9); // 1/4
  assert.ok(Math.abs(g.oldOneShot - 0.5) < 1e-9);    // 1/2
});

test('groupRow 的空组不产出 NaN', () => {
  const g = groupRow([]);
  assert.equal(g.n, 0);
  assert.equal(g.per100, null);
  assert.equal(g.clean, null);
  assert.equal(g.oldCorrectionRate, null);
  assert.equal(g.oldOneShot, null);
});

// ── 检验 ────────────────────────────────────────────────────────────

test('densityDiffTest 对样本不足返回 null，不伪造 p 值', () => {
  assert.equal(densityDiffTest([row()], [row(), row()]), null);
});

test('densityDiffTest 在同分布的输入上 p 大、在同向差异上 p 小', () => {
  const same = Array.from({ length: 12 }, () => row({ execWork: 100 }));
  assert.ok(densityDiffTest(same, same.slice()).p > 0.9);

  const clean = Array.from({ length: 12 }, () => row({ execWork: 100, corrections: 0 }));
  const dirty = Array.from({ length: 12 }, () => row({ execWork: 100, corrections: 5 }));
  const r = densityDiffTest(clean, dirty);
  assert.ok(r.observed < 0);
  assert.ok(r.p < 0.01);
});

test('densityDiffTest 确定性：同一输入两次同 p', () => {
  const a = Array.from({ length: 8 }, (_, i) => row({ execWork: 50, corrections: i % 3 }));
  const b = Array.from({ length: 8 }, (_, i) => row({ execWork: 50, corrections: (i + 1) % 3 }));
  assert.equal(densityDiffTest(a, b).p, densityDiffTest(a, b).p);
});

test('cleanDiffTest 只比较「有没有纠正」这一位', () => {
  const a = [row({ corrections: 0 }), row({ corrections: 0 })];
  const b = [row({ corrections: 9 }), row({ corrections: 9 })];
  const r = cleanDiffTest(a, b);
  assert.equal(r.observed, 1);
});

test('matchedOnWork 按工作量配对，超出容差的配对丢弃', () => {
  const a = [row({ sessionId: 'a1', execWork: 1000 })];
  const b = [row({ sessionId: 'b1', execWork: 1000 }), row({ sessionId: 'b2', execWork: 3 })];
  const m = matchedOnWork(a, b);
  assert.equal(m.n, 1);
  assert.equal(m.pairs[0].b.sessionId, 'b1');
});

test('matchedOnWork 记住 0 胜 0 负全打平的情形', () => {
  const a = [row({ sessionId: 'a1', execWork: 500, corrections: 0 })];
  const b = [row({ sessionId: 'b1', execWork: 500, corrections: 0 })];
  const m = matchedOnWork(a, b);
  assert.equal(m.aFewer, 0);
  assert.equal(m.bFewer, 0);
  assert.equal(m.ties, 1);
});

test('MATCH_LOG_TOLERANCE 与既有脚本同一取值', () => {
  assert.equal(MATCH_LOG_TOLERANCE, 0.7);
});

test('stratifyByWork 覆盖全部可比会话（每层人数之和 = 总数）', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row({ execWork: i * 10, group: ['A', 'B', 'C'][i % 3] }));
  const s = stratifyByWork(rows);
  const sum = s.reduce((n, b) => n + b.A.n + b.B.n + b.C.n, 0);
  assert.equal(sum, rows.length);
});

test('stratifyByWork 空输入返回空数组', () => {
  assert.deepEqual(stratifyByWork([]), []);
});

test('PER 是每 100 次工具调用', () => {
  assert.equal(PER, 100);
});

// ── 汇总与报告 ──────────────────────────────────────────────────────

test('summarize 把 none 单列，不进 A/B/C 对比的 totals', () => {
  const rows = [
    row({ group: 'A', execWork: 100, corrections: 1 }),
    row({ group: 'B', execWork: 100, corrections: 0 }),
    row({ group: 'C', execWork: 100, corrections: 0 }),
    row({ group: 'none', hasExec: false, execWork: 0, corrections: 99 }),
  ];
  const res = summarize(rows, {});
  assert.equal(res.totals.comparable, 3);
  assert.equal(res.totals.corrections, 1);
  assert.equal(res.groups.none.n, 1);
});

test('summarize 的定义串里写明「提问不计入成本」', () => {
  const res = summarize([], {});
  assert.ok(res.definitions.primary.includes('纠正'));
  assert.ok(res.definitions.notCost.some((s) => s.includes('提问')));
});

test('summarize 的阈值表从 0 起，且每组 n 单调不增', () => {
  const rows = [
    row({ group: 'A', execWork: 0 }), row({ group: 'A', execWork: 100 }),
    row({ group: 'A', execWork: 500 }), row({ group: 'A', execWork: 900 }),
  ];
  const res = summarize(rows, {});
  assert.equal(res.thresholds[0].minWork, 0);
  const ns = res.thresholds.map((t) => t.groups.A.n);
  for (let i = 1; i < ns.length; i++) assert.ok(ns[i] <= ns[i - 1], `${ns}`);
});

test('formatReport 打印全部三组与两种口径，不隐藏任一栏', () => {
  const rows = [
    row({ group: 'A', execWork: 100, corrections: 1, interruptions: 2 }),
    row({ group: 'B', execWork: 200, corrections: 1, interruptions: 3 }),
    row({ group: 'C', execWork: 300, corrections: 0, interruptions: 1 }),
  ];
  const text = formatReport(summarize(rows, {
    files: 1, bytes: 1, days: 0, duplicateSessions: 0, forkDuplicates: 0, resumeMerged: 0,
    resumeClusters: 0, sessions: 3, sessionsAfterDedup: 3, execSessions: 3, sandboxSessions: 0,
    comparable: 3, realOnly: false, planOnlyAskSessions: 0, groupMismatches: [], interruptionMismatches: [],
    asksAll: 0, asksWithPlan: 0, planApprovals: 0, execAskAnswers: 0, interruptMarkers: 0, humanAfterAsk: 0, humanAfterAskCorrections: 0,
    sandboxBreakdown: {
      total: 0, byGroup: { A: 0, B: 0, C: 0 }, interruptions: 0, corrections: 0,
      sampleFirstHuman: '', zeroTotal: 0, zeroSandbox: 0, zeroShare: '执行期零发言的 0 个会话里 0 个是沙箱',
    },
  }));
  for (const s of ['A 开工前问', 'B 开工后问', 'C 从不问', '新主指标', '旧:一次性', '语料快照', '沙箱污染']) {
    assert.ok(text.includes(s), s);
  }
});
