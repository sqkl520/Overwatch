#!/usr/bin/env node
/**
 * tui-layout.test.mjs — 布局数学的单元测试。
 *
 * 存在的理由：这是本次重构的主要收益。旧实现的宽度、列宽、降级、视口全写在
 * `buildFrame()` 里，**无法单测**——「76 列下这一行有多宽」只能靠人眼看
 * （`docs/research/2026-11-05-dsh-tui-analysis.md` §6 第一条）。
 *
 * 三条断言轴，覆盖规格里每个可验收的点：
 *   1. **宽度**：草案 A 的每一行 ≤ 78 列（规划 §2.4 的验收要求），三档终端下整屏不越界；
 *   2. **结构**：判决行永远是第 1 行；空段不画；需动作段永不撤；状态行永远是最后一行；
 *   3. **披露**：截断必须带「丢了多少」，不得静默。
 *
 * 用法：node --test scripts/tui-layout.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { displayWidth } from './tui-theme.mjs';
import { BLOCKED_MAX_AGE } from './watch.mjs';
import {
  ACTION_MAX_AGE_SEC, ACTION_STATES, NEVER_DROP, TIERS, ageLimitOf, staleOf,
  alignRight, binaryOf, checklistLines, checklistRows, checklistSentence, checklistSummaryLine,
  composeListScreen, footerParts, fmtAgeMs, fmtScanAge,
  fmtSpan, isQuietRow, joinWithin, layoutRow, layoutStages, nearText, partitionRows, resolveLayout,
  runningColumns, runningRowOf, sectionTitle, shortPath, stoppedSummary, titleOf,
  truncateWithDisclosure, verdictParts, windowOf, actionCell, actionRowOf, checklistLine,
} from './tui-layout.mjs';

// ── 1. 草案 A 的宽度（规划 §2.4 的验收要求）───────────────────────────

/** 草案 A 的逐行文本，**照抄 `docs/design/2026-11-05-tui-redesign-plan.md` §2.4**
 *  （2026-11-11 修订版：删掉「检查了什么 / 结论」表头，零值行不再占行——
 *  见 `docs/research/2026-11-11-claude-status-block-reverse.md` §3 与
 *  `docs/research/2026-11-11-tui-checklist-redesign.md`）。
 *  它不经过渲染函数 —— 如果草稿本身超宽，那是规格错了，测试必须报出来。 */
const SKETCH_A = [
  ' 0 件在等你 · 12 个会话在跑 · 17 个已停              8 秒前扫描',
  '',
  ' 声明对不上  ✗ 1 条完成声明无证据支持 · d 看证据',
  ' 后台监视    ✗ 监视未在跑（jobs 8.2h / probe 8.3h 未更新） · 先修这个',
  '',
  ' 在跑 (12)                                    最后动静   近',
  ' ❯ OmniSight                  Overwatch         8s    改 TUI 规格',
  '   PerfScope 多 agent 工作流    MCServers        6s    跑 mvn test',
  '   shapez                     rea/shapez        17s    ...',
  '   ...                                          12 条，j/k 移动',
  ' 已停 (17)  28 秒–22.8 天前 · h 展开 · 大部分是历史',
  '',
  ' 1 条声明对不上 · 数据来自 8s 前的扫描 · 监视未在跑      ? 帮助',
];

test('草案 A：每一行的显示宽度 ≤ 78（CJK 按 2 列算）', () => {
  for (const line of SKETCH_A) {
    const w = displayWidth(line);
    assert.ok(w <= 78, `草案超宽 ${w} 列: "${line}"`);
  }
});

test('草案 A：最长的那一行不超过设计基准 76 列', () => {
  // §2.4 声称「实测最宽 72 列」。这里不锁 72（文案会变），但必须 ≤ 76，
  // 否则 80 列终端留 2 列页边距就装不下。
  const widest = Math.max(...SKETCH_A.map((l) => displayWidth(l)));
  assert.ok(widest <= 76, `草案最宽 ${widest} 列，超过 76`);
});

// ── 2. 时间格式 ────────────────────────────────────────────────────────

test('fmtSpan 的每一档边界都对，且不产生小数秒', () => {
  assert.equal(fmtSpan(0), '0s');
  assert.equal(fmtSpan(8), '8s');
  assert.equal(fmtSpan(59.6), '1m');       // 四舍五入到分钟，不是「60s」
  assert.equal(fmtSpan(3600), '1.0h');
  assert.equal(fmtSpan(86400), '1.0d');
  assert.equal(fmtSpan(22.8 * 86400), '22.8d');
  assert.equal(fmtSpan(-5), '0s', '负数必须钳到 0，不能画成 -5s');
  assert.equal(fmtSpan(NaN), 'n/a');
  assert.equal(fmtSpan(null), 'n/a', 'null 不能被 Number(null)=0 变成 0s');
});

test('fmtScanAge / fmtAgeMs：新鲜度必须说得出单位', () => {
  assert.equal(fmtScanAge(8000), '8s前扫描');
  assert.equal(fmtScanAge(null), '扫描时刻未知');
  assert.equal(fmtAgeMs(120000), '2m前');
});

// ── 3. 溢出可数披露 ────────────────────────────────────────────────────

test('truncateWithDisclosure：不超宽时原样返回，omitted=0', () => {
  const r = truncateWithDisclosure('abc', 10);
  assert.equal(r.text, 'abc');
  assert.equal(r.omitted, 0);
  assert.equal(r.truncated, false);
});

test('truncateWithDisclosure：超宽时必须说出丢了多少列，且总宽 ≤ 上限', () => {
  const r = truncateWithDisclosure('这是一段很长的中文文本用来测试截断', 20);
  assert.equal(r.truncated, true);
  assert.ok(r.omitted > 0, 'omitted 必须是正数');
  assert.ok(displayWidth(r.text) <= 20, `超宽 ${displayWidth(r.text)}：${r.text}`);
  assert.ok(/… \(\+\d+ 列\)$/.test(r.text), `必须带可数披露：${r.text}`);
});

test('truncateWithDisclosure：披露的数字与真实丢弃量一致', () => {
  // 「丢了多少」不能瞎写。整串宽度 - 实际保留正文的宽度 = omitted。
  const text = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const r = truncateWithDisclosure(text, 20);
  const body = r.text.replace(/… \(\+\d+ 列\)$/, '');
  assert.equal(r.omitted, displayWidth(text) - displayWidth(body),
    `omitted=${r.omitted} 与实际丢弃量不符：${r.text}`);
});

test('truncateWithDisclosure：width<=0 时不崩、不返回原文', () => {
  const r = truncateWithDisclosure('abc', 0);
  assert.equal(r.text, '');
  assert.equal(r.truncated, true);
  assert.equal(truncateWithDisclosure('', 0).truncated, false);
});

// ── 4. 行布局 ──────────────────────────────────────────────────────────

test('alignRight 右对齐到精确宽度', () => {
  assert.equal(alignRight('8s', 6), '    8s');
  assert.equal(alignRight('abcdef', 4), 'abc…');
  // CJK：按显示宽度对齐，不按字符数
  assert.equal(displayWidth(alignRight('中文', 8)), 8);
});

test('layoutRow：总宽精确等于目标（有 flex 时由它吸收差额）', () => {
  const cells = [
    { text: '❯ ', width: 2 },
    { text: 'title', flex: true },
    { text: '8s', width: 6, align: 'right' },
  ];
  const line = layoutRow(cells, 40);
  assert.equal(displayWidth(line), 40);
  assert.ok(line.startsWith('❯ title'));
  assert.ok(line.endsWith('    8s'));
});

test('layoutRow：空内容不放宽列 —— 列恒定，否则整屏会随数据抖动', () => {
  // 空字符串的固定宽度单元格仍占位。这是 dsh-TUI 的硬纪律（状态格恒 2 列）。
  const withEmpty = layoutRow([{ text: '', width: 2 }, { text: 'x', width: 5 }], 20);
  const withContent = layoutRow([{ text: 'ab', width: 2 }, { text: 'x', width: 5 }], 20);
  assert.equal(withEmpty.indexOf('x'), withContent.indexOf('x'),
    '空单元格改变了后续列的位置');
});

test('layoutRow：极端窄宽度不抛错且不超宽', () => {
  for (const w of [1, 2, 5, 8]) {
    assert.doesNotThrow(() => layoutRow([{ text: 'abc', width: 2 }, { text: 'd', flex: true }], w));
    assert.ok(displayWidth(layoutRow([{ text: 'abc', width: 2 }, { text: 'd', flex: true }], w)) <= w);
  }
});

test('joinWithin：装不下时按尾部丢项，不切成半个词', () => {
  const parts = ['0 件在等你', '12 个会话在跑', '17 个已停'];
  const full = joinWithin(parts, 200);
  assert.ok(full.includes('已停'), full);
  const narrow = joinWithin(parts, 20);
  assert.ok(displayWidth(narrow) <= 20, narrow);
  assert.ok(narrow.startsWith('0 件在等你'), '第一项永不被丢（它是判决）');
});

// ── 5. 视口 ────────────────────────────────────────────────────────────

test('windowOf：光标始终落在窗口内', () => {
  for (const cursor of [0, 3, 9, 19]) {
    const w = windowOf({ count: 20, cursor, area: 5 });
    assert.ok(cursor >= w.offset && cursor < w.end, `光标 ${cursor} 不在 [${w.offset},${w.end})`);
  }
});

test('windowOf：窗口不越出数据两端', () => {
  assert.deepEqual(windowOf({ count: 3, cursor: 2, area: 10 }), { offset: 0, end: 3 });
  const w = windowOf({ count: 20, cursor: 19, area: 5 });
  assert.equal(w.end, 20);
  assert.equal(w.offset, 15);
});

test('windowOf：光标看不见时才滚动最小距离，不跳回顶部', () => {
  // 光标在窗口内 → offset 不变
  assert.equal(windowOf({ count: 20, cursor: 4, area: 5, offset: 2 }).offset, 2);
  // 光标越出下界 → 刚好把它放进来
  assert.equal(windowOf({ count: 20, cursor: 8, area: 5, offset: 2 }).offset, 4);
  // 光标越出上界 → 滚到光标处
  assert.equal(windowOf({ count: 20, cursor: 0, area: 5, offset: 9 }).offset, 0);
});

test('windowOf：空数据与零行高不崩', () => {
  assert.deepEqual(windowOf({ count: 0, cursor: 0, area: 5 }), { offset: 0, end: 0 });
  assert.doesNotThrow(() => windowOf({ count: 5, cursor: 0, area: 0 }));
});

// ── 6. 降级阶梯 ────────────────────────────────────────────────────────

test('降级阶梯：顺序是显式声明的，且列宽阈单调不增', () => {
  const stages = layoutStages();
  assert.ok(stages.length >= 4);
  for (let i = 1; i < stages.length; i++) {
    assert.ok(stages[i].minCols <= stages[i - 1].minCols,
      `第 ${i} 档的列宽阈比上一档还高：${stages[i].minCols} > ${stages[i - 1].minCols}`);
    assert.ok(stages[i].minRows <= stages[i - 1].minRows, `第 ${i} 档的行高阈比上一档还高`);
  }
});

test('降级阶梯：76 列拿最全档，越窄撤得越多', () => {
  const wide = resolveLayout({ cols: 76, rows: 30 });
  const mid = resolveLayout({ cols: 60, rows: 24 });
  const tiny = resolveLayout({ cols: 44, rows: 20 });
  assert.equal(wide.tier, 'wide');
  assert.equal(wide.showNear, true);
  assert.equal(wide.showStopped, true);
  assert.equal(mid.showNear, false, '60 列必须先撤「近」列');
  assert.equal(tiny.showStopped, false, '44 列撤「已停」段');
  assert.equal(tiny.showCheckSource, false, '44 列撤检查表的来源列');
});

test('降级阶梯：永不撤除的三样在每一档都成立', () => {
  // 判决行 / 需动作段 / 动作列 —— 撤了它们等于把界面变成只读报表。
  assert.deepEqual([...NEVER_DROP], ['verdict', 'action', 'actionColumn']);
  for (const [cols, rows] of [[76, 30], [44, 20], [30, 12], [20, 8]]) {
    const layout = resolveLayout({ cols, rows });
    assert.ok(layout, `${cols}×${rows} 没有可用档位`);
    // 档位对象里没有「藏判决行」的开关 —— 结构上就不可能撤掉
    assert.equal(layout.hideVerdict, undefined);
    assert.equal(layout.hideAction, undefined);
  }
});

test('降级阶梯：极窄极矮也返回一个档位，不返回 undefined', () => {
  const l = resolveLayout({ cols: 1, rows: 1 });
  assert.ok(l && l.id, JSON.stringify(l));
  assert.equal(resolveLayout({}).id, 'full', '默认 80×24 应落在最全档');
});

// ── 7. 二值化与分区 ────────────────────────────────────────────────────

test('binaryOf：六态降到二值，只有三态算「需动作」', () => {
  assert.equal(binaryOf({ state: 'WAITING' }), 'waiting');
  assert.equal(binaryOf({ state: 'BLOCKED' }), 'blocked');
  assert.equal(binaryOf({ state: 'FAILED' }), 'failed');
  for (const st of ['PRODUCING', 'EXPLORING', 'STALLED']) {
    assert.equal(binaryOf({ state: st }), 'running', `${st} 应算「在跑」`);
  }
  assert.equal(binaryOf(null), 'stopped');
  assert.equal(binaryOf({ state: 'UNKNOWN' }), 'stopped', '不认识的态不得算成需动作');
});

test('ACTION_STATES 只含三个宿主事实态', () => {
  assert.deepEqual([...ACTION_STATES], ['WAITING', 'BLOCKED', 'FAILED']);
});

test('partitionRows：三段互斥，需动作优先', () => {
  const sessions = [
    { sessionId: 'a', state: 'BLOCKED', hasTranscript: false },
    { sessionId: 'b', state: 'PRODUCING', hasTranscript: true },
    { sessionId: 'c', state: 'EXPLORING', hasTranscript: true },
  ];
  const live = [{ sessionId: 'b', status: 'busy' }, { sessionId: 'a', status: 'blocked' }];
  const p = partitionRows({ sessions, live });
  assert.deepEqual(p.action.map((r) => r.sessionId), ['a']);
  assert.deepEqual(p.running.map((r) => r.sessionId), ['b']);
  assert.deepEqual(p.stopped.map((r) => r.sessionId), ['c'],
    '活着但不在 live 里的会话属于「已停」');
});

test('partitionRows：活着但没有 transcript 的不进「在跑」段', () => {
  // 它在跑，但没有任何「最近说」可显示，放进 L3 只是占位。
  const p = partitionRows({
    sessions: [{ sessionId: 'x', state: 'PRODUCING', hasTranscript: false }],
    live: [{ sessionId: 'x', status: 'busy' }],
  });
  assert.equal(p.running.length, 0);
  assert.equal(p.stopped.length, 1);
});

test('partitionRows：收件箱里说「在等你」但扫描行没有的会话要补进需动作段', () => {
  // D6 的形态：某个会话只在 jobs/*/state.json 里。
  const p = partitionRows({
    sessions: [],
    live: [],
    inbox: [{ sessionId: 'ghost', state: 'BLOCKED', needs: '等你' }],
    resolve: (it) => ({ sessionId: it.sessionId, state: it.state, idleSec: 60, needs: it.needs }),
  });
  assert.equal(p.action.length, 1);
  assert.equal(p.action[0].sessionId, 'ghost');
});

test('partitionRows：需动作段按等得最久排前，在跑段按最近有动静排前', () => {
  const p = partitionRows({
    sessions: [
      { sessionId: 'new', state: 'WAITING', idleSec: 60 },
      { sessionId: 'old', state: 'BLOCKED', idleSec: 9999 },
      { sessionId: 'r1', state: 'PRODUCING', hasTranscript: true, idleSec: 300 },
      { sessionId: 'r2', state: 'PRODUCING', hasTranscript: true, idleSec: 2 },
    ],
    live: [{ sessionId: 'r1', status: 'busy' }, { sessionId: 'r2', status: 'busy' }],
  });
  assert.deepEqual(p.action.map((r) => r.sessionId), ['old', 'new']);
  assert.deepEqual(p.running.map((r) => r.sessionId), ['r2', 'r1']);
});

// ── 7b. 需动作的老化上限（2026-11-11 用户实测：33 天前的问句被判成需动作）──
//
// 缺陷形态（用户原话）：「都是我很久很久都没有搞过的对话了，它发了个问句就
// 判定成需动作这很不合理」。根因是 WAITING 没有老化上限——BLOCKED 有
// BLOCKED_MAX_AGE，WAITING 什么都没有。
//
// 三条约束同时成立才算修好：
//   1. 超龄的不进「需动作」（否则仍是误报）；
//   2. 超龄的**不丢弃**（用户要求「所有都要显示」），降级进「已停」并带 stale 标记；
//   3. 判据用注入时钟，不读挂钟。

const DAY_SEC = 86400;
/** 锚点远离阈值，不贴着边界测。33 天是实测真实值（job 7710fbdb）。 */
const ANCHOR_NOW = Date.parse('2026-11-11T00:00:00Z');

test('ACTION_MAX_AGE_SEC：WAITING 有上限，且每个需动作态都有', () => {
  for (const st of ACTION_STATES) {
    const v = ACTION_MAX_AGE_SEC[st];
    assert.ok(Number.isFinite(v) && v > 0, `${st} 没有老化上限`);
  }
  // WAITING 的 24h 来自实测回复延迟分布（p99 = 17.59h，99.5% 在 24h 内）
  assert.equal(ACTION_MAX_AGE_SEC.WAITING, 24 * 3600);
});

test('ACTION_MAX_AGE_SEC.BLOCKED 必须与 watch 的 BLOCKED_MAX_AGE 同一条线', () => {
  // 通知门和展示门对同一件事不能用两把尺：否则「不通知你，但列表里天天排第一」。
  assert.equal(ACTION_MAX_AGE_SEC.BLOCKED * 1000, BLOCKED_MAX_AGE,
    '展示侧的老化上限与通知侧不一致');
});

test('staleOf：注入时钟，不读挂钟', () => {
  // 同一个会话在两个不同 nowMs 下必须得到不同结论——如果它偷偷用 Date.now()，
  // 两次调用会给出同一个答案，这条测试就红。
  const s = { state: 'WAITING', idleSec: 2 * DAY_SEC };
  assert.equal(staleOf(s, ANCHOR_NOW).stale, true, '2 天 > 24h，应判超龄');
  assert.equal(staleOf(s, ANCHOR_NOW + 10 * 365 * DAY_SEC * 1000).stale, true);
  // 只有 statusUpdatedAt 时用注入的 nowMs 现算
  const noIdle = { state: 'WAITING', statusUpdatedAt: ANCHOR_NOW - 2 * DAY_SEC * 1000 };
  assert.equal(staleOf(noIdle, ANCHOR_NOW).stale, true, '没有 idleSec 时应按 statusUpdatedAt 算');
  assert.equal(staleOf(noIdle, ANCHOR_NOW - 1.9 * DAY_SEC * 1000).stale, false);
  // 拿不到任何时刻 → fail-open（不凭猜藏起一条真实等待）
  assert.equal(staleOf({ state: 'WAITING' }, ANCHOR_NOW).stale, false);
  // 系统时钟挪动不会改变结论的输入：没有 idleSec 也不给 nowMs 就永远算不出年龄
  assert.equal(staleOf({ state: 'WAITING' }).ageSec, null);
});

test('staleOf：阈值两侧的行为（30 天前的 WAITING 必须超龄）', () => {
  const waiting = { state: 'WAITING', idleSec: 30 * DAY_SEC };
  assert.equal(staleOf(waiting, ANCHOR_NOW).stale, true);
  assert.equal(staleOf({ ...waiting, idleSec: 3600 }, ANCHOR_NOW).stale, false);
  // BLOCKED 是 7 天：6 天不超龄、8 天超龄
  assert.equal(staleOf({ state: 'BLOCKED', idleSec: 6 * DAY_SEC }, ANCHOR_NOW).stale, false);
  assert.equal(staleOf({ state: 'BLOCKED', idleSec: 8 * DAY_SEC }, ANCHOR_NOW).stale, true);
  // 不是需动作态就没有上限（不参与老化判断）
  assert.equal(ageLimitOf({ state: 'PRODUCING' }), null);
  assert.equal(staleOf({ state: 'PRODUCING', idleSec: 999 * DAY_SEC }, ANCHOR_NOW).stale, false);
});

test('partitionRows：超龄的需动作事实降级进「已停」，不丢弃、不进需动作', () => {
  const stale = {
    sessionId: 'hilltop', state: 'BLOCKED', name: 'Hilltop Village优化',
    idleSec: 33.1 * DAY_SEC,
    needs: '要我现在就把用户实测单交给你，还是你先看这四份测试报告？',
    suggestedReply: '把实测单发给我',
  };
  const fresh = { sessionId: 'live-one', state: 'WAITING', idleSec: 600 };
  const p = partitionRows({ sessions: [stale, fresh], live: [], nowMs: ANCHOR_NOW });

  assert.deepEqual(p.action.map((r) => r.sessionId), ['live-one'],
    '超龄的 33 天前问句不该进「需动作」');
  // **不丢弃**：用户要求所有会话都显示
  assert.ok(p.stopped.some((r) => r.sessionId === 'hilltop'), '超龄的会话消失了');
  const d = p.stopped.find((r) => r.sessionId === 'hilltop');
  assert.equal(d.stale, true, '降级进已停的必须带 stale 标记，否则与普通历史无法区分');
  assert.ok(d.staleAgeSec > d.staleLimitSec, '必须记下年龄与上限，供界面说明');
  assert.deepEqual(p.stale.map((r) => r.sessionId), ['hilltop'], 'stale 列表要能被调用方拿到');
  // 原对象不被就地修改（纯函数）
  assert.equal(stale.stale, undefined, 'partitionRows 就地改了入参');
});

test('partitionRows：收件箱来源的超龄事实也要降级，不能绕过老化', () => {
  // 老化判据必须与来源无关：只在收件箱里出现的会话同样是「另一个入口」，
  // 漏掉它等于老化只对一半数据生效。
  const p = partitionRows({
    sessions: [],
    live: [],
    inbox: [{ sessionId: 'ghost', state: 'WAITING', idleSec: 30 * DAY_SEC }],
    resolve: (it) => ({ sessionId: it.sessionId, state: it.state, idleSec: it.idleSec }),
    nowMs: ANCHOR_NOW,
  });
  assert.equal(p.action.length, 0, '收件箱来源绕过了老化');
  assert.equal(p.stopped.length, 1);
  assert.equal(p.stopped[0].stale, true);
});

test('stoppedSummary：降级来的条目要能被数出来', () => {
  const stopped = [
    { idleSec: 3600 },
    { idleSec: 33 * DAY_SEC, stale: true },
    { idleSec: 30 * DAY_SEC, stale: true },
  ];
  const s = stoppedSummary(stopped);
  assert.ok(/其中 2 条超龄/.test(s), `超龄条目必须能数出来：${s}`);
  assert.ok(s.includes('33.0d'), s);
  // 没有超龄条目时不出现这句噪声
  assert.ok(!/超龄/.test(stoppedSummary([{ idleSec: 3600 }])));
});

test('actionCell：超龄的不画「c 复制回复」（按了没反应等于假按钮）', () => {
  const stale = { state: 'BLOCKED', idleSec: 33 * DAY_SEC, suggestedReply: '把实测单发给我' };
  assert.equal(actionCell(stale, { nowMs: ANCHOR_NOW }), 'Enter 看原文');
  const fresh = { state: 'BLOCKED', idleSec: 60, suggestedReply: '继续' };
  assert.equal(actionCell(fresh, { nowMs: ANCHOR_NOW }), 'c 复制回复');
});

// ── 8. 文案 ────────────────────────────────────────────────────────────

test('verdictParts：「N 件在等你」必须排第一', () => {
  const parts = verdictParts({ actionCount: 2, runningCount: 12, stoppedCount: 17 });
  assert.ok(parts[0].startsWith('2 件在等你'), parts[0]);
  assert.ok(parts[1].includes('12 个会话在跑'));
  assert.ok(parts[2].includes('17 个已停'));
  // 顺序即优先级：主问题在最前（规划 P2）
  assert.equal(parts.length, 3);
});

test('verdictParts：负数/非法计数被钳到 0，不画出 「-1 件」', () => {
  const parts = verdictParts({ actionCount: -1, runningCount: NaN, stoppedCount: null });
  for (const p of parts) assert.ok(!/-|NaN|undefined/.test(p), p);
});

test('stoppedSummary：一行里必须有范围与展开方式', () => {
  const stopped = [{ idleSec: 28 }, { idleSec: 22.8 * 86400 }];
  const s = stoppedSummary(stopped);
  assert.ok(/已停 \(2\)/.test(s), s);
  assert.ok(s.includes('28s'), s);
  assert.ok(s.includes('22.8d'), s);
  assert.ok(s.includes('h 展开'), '必须告诉用户怎么展开');
  assert.equal(stoppedSummary([]), '已停 (0)');
});

test('sectionTitle：计数永远由数据算出来', () => {
  assert.equal(sectionTitle('在跑', 12), '在跑 (12)');
  assert.equal(sectionTitle('需动作', 0), '需动作 (0)');
});

test('actionCell：没有草稿就不给 c（不提供假按钮）', () => {
  assert.equal(actionCell({ suggestedReply: '继续' }), 'c 复制回复');
  assert.equal(actionCell({ needs: '选 A 还是 B' }), 'Enter 看原文');
  assert.equal(actionCell({}), 'Enter 看原文');
});

test('nearText：空白折叠成单空格，空值返回空串', () => {
  assert.equal(nearText({ lastAssistant: 'a\n\n  b\tc' }), 'a b c');
  assert.equal(nearText({}), '');
  assert.equal(nearText(null), '');
});

test('titleOf：没有真标题时回退到路径尾段，且标记 fallback', () => {
  const withTitle = titleOf({ title: '真标题', path: '/a/b' });
  assert.deepEqual(withTitle, { text: '真标题', fallback: false });
  const fallback = titleOf({ title: null, path: 'C:/x/y/Overwatch' });
  assert.equal(fallback.text, 'Overwatch');
  assert.equal(fallback.fallback, true, '回退值必须能被标出来（渲染层会画暗）');
});

test('shortPath：末两段，带 `…/` 说明前面被省了', () => {
  assert.equal(shortPath('C:/Projects/Overwatch'), '…/Projects/Overwatch');
  assert.equal(shortPath('C:/x'), 'x');
  // 盘符不是有辨识度的一段，不该占一格
  assert.equal(shortPath('C:/C盘清理路径'), 'C盘清理路径');
  assert.equal(shortPath(''), '');
});

// ── 9. 检查表（裁决 R2：四行全留）───────────────────────────────────

test('checklistRows：恒 4 行，一行不砍', () => {
  const rows = checklistRows({ inboxCount: 0, askedCount: 0, claims: { hard: 0, soft: 0 }, health: { healthy: true, layers: [] } });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.label), ['等你回应', '问了没答', '声明对不上', '后台监视']);
});

test('checklistRows：每行都写来源（否则「空」是全绿还是漏检无法区分）', () => {
  const rows = checklistRows({ inboxCount: 0, askedCount: 0, claims: { hard: 0, soft: 0 }, health: { healthy: true, layers: [] } });
  for (const r of rows) assert.ok(r.source && r.source.length > 0, `${r.label} 缺来源`);
});

test('checklistRows：宽档保留来源，窄档撤掉来源但保留结论', () => {
  const wide = checklistRows({ inboxCount: 3, askedCount: 1, claims: { hard: 0 }, health: null, wide: true });
  const narrow = checklistRows({ inboxCount: 3, askedCount: 1, claims: { hard: 0 }, health: null, wide: false });
  assert.ok(wide[0].source.length > 0);
  assert.equal(narrow[0].source, '');
  assert.equal(narrow[0].verdict, wide[0].verdict, '撤来源列不得改写结论');
});

test('checklistRows：空状态不得出现断言词（「无异常」「一切正常」）', () => {
  // 规划 §2.6：断言要能被推翻，措辞就必须能被推翻。
  const rows = checklistRows({ inboxCount: 0, askedCount: 0, claims: { hard: 0, soft: 0 }, health: { healthy: true, layers: [{ name: 'jobs', ageMs: 60000 }] } });
  const text = rows.map((r) => `${r.label}${r.source}${r.verdict}${r.note}`).join('|');
  assert.ok(!/无异常|一切正常|已全面检查/.test(text), text);
});

test('checklistRows：证据三态互相区分（算着 / 算失败 / 有结果）', () => {
  const pending = checklistRows({ claims: { pending: true }, health: null });
  const failed = checklistRows({ claims: { error: true }, health: null });
  const hard = checklistRows({ claims: { hard: 2, soft: 5 }, health: null });
  assert.notEqual(pending[2].verdict, failed[2].verdict, '「正在算」不能和「算失败」显示成一样');
  assert.notEqual(failed[2].verdict, hard[2].verdict, '「算失败」不能显示成 0 条');
  assert.ok(hard[2].verdict.includes('2'), hard[2].verdict);
  assert.ok(hard[2].note.includes('5 存疑'), `硬/存疑必须分开说：${hard[2].note}`);
});

test('checklistRows：监视在跑与没在跑必须打不同的标记', () => {
  const ok = checklistRows({ claims: { hard: 0 }, health: { healthy: true, layers: [{ name: 'jobs', ageMs: 30000 }] } });
  const bad = checklistRows({ claims: { hard: 0 }, health: { healthy: false, layers: [{ name: 'jobs', ageMs: 8.2 * 3600e3 }] } });
  assert.equal(ok[3].tone, 'ok');
  assert.equal(bad[3].tone, 'bad');
  assert.ok(bad[3].verdict.includes('✗'));
  assert.ok(/先修这个/.test(bad[3].note), bad[3].note);
  // 读不到状态文件既不是 ✓ 也不是 ✗
  const unknown = checklistRows({ claims: { hard: 0 }, health: null });
  assert.equal(unknown[3].tone, 'bad');
  assert.ok(unknown[3].verdict === '?', unknown[3].verdict);
});

// ── 9b. 呈现：没有表头，没有零值行（2026-11-11 逆向 + 重做）─────────────
//
// 这三条守的是 `docs/research/2026-11-11-claude-status-block-reverse.md` 的
// 三条硬结论：① 从不给元表头 ② 零值不占行 ③ 首屏是判决句。
// 负向验证 v20/v21/v22 会把改法逐个放回去，这里必须变红。

test('呈现：不再有「检查了什么 / 结论」这类元表头', () => {
  // 负向 v20：把 checklistHeaderLine 加回 composeListScreen，这条必须红。
  const lines = composeListScreen({
    cols: 76, rows: 30, useColor: false, verdict: SAMPLE.verdict, scanAge: SAMPLE.scanAge,
    checklist: SAMPLE.checklist, action: [], running: [], stopped: [], footer: [],
  });
  const text = lines.join('\n');
  assert.ok(!/检查了什么/.test(text), `元表头回来了：\n${text}`);
  // 「结论」二字可以出现在正文里（「没有…结论」），但不得作为右对齐的列名独占一行
  for (const l of lines) {
    assert.ok(!/^\s*检查了什么\s+结论\s*$/.test(l), `表头行回来了：${JSON.stringify(l)}`);
  }
});

test('呈现：零值的检查项不占行，但被数进收尾句（不是静默丢弃）', () => {
  // 负向 v21：让 checklistLines 照旧逐行输出（含 tone==='ok' 的行），这条必须红。
  const rows = checklistRows({
    inboxCount: 0, askedCount: 0, claims: { hard: 1, soft: 0 },
    health: { healthy: true, layers: [{ name: 'jobs', ageMs: 30000 }] },
  });
  const res = checklistLines(rows, { cols: 76, useColor: false });
  const text = res.lines.join('\n');
  assert.ok(!/没有会话问了没答/.test(text), `零值行不该占屏：\n${text}`);
  assert.ok(!/没有会话在等你/.test(text), `inbox 零值也不该占屏：\n${text}`);
  assert.ok(/1 条完成声明无证据支持/.test(text), `有事的那项必须画出来：\n${text}`);
  // 「压掉」必须能被数出来：2 项没发现在上面，收尾句说的是「其余 2 项」
  assert.ok(/其余 2 项没有发现/.test(text), `压掉的项必须被数出来：\n${text}`);
  assert.equal(res.quiet, false, '这一批有问题，quiet 不能是 true');
  assert.ok(res.hidden >= 2, `hidden 要能反映被压掉的项数：${res.hidden}`);
});

test('呈现：四项全零时压成一句判决，**绝不能是空白**', () => {
  const rows = checklistRows({
    inboxCount: 0, askedCount: 0, claims: { hard: 0, soft: 0 },
    health: { healthy: true, layers: [{ name: 'jobs', ageMs: 30000 }] },
  });
  const res = checklistLines(rows, { cols: 76, useColor: false });
  assert.equal(res.quiet, true);
  assert.equal(res.lines.length, 1, `全绿时应当只有一句，实际 ${res.lines.length} 行`);
  assert.ok(/4 项检查都清白/.test(res.lines[0]), res.lines[0]);
  // 「监视在跑」必须逐字出现：健康时它是最容易被计数吞掉的那一项
  assert.ok(/监视在跑/.test(res.lines[0]), `监视存活必须逐字说出来：${res.lines[0]}`);
  // 任何宽度下都不能变成空串
  for (const cols of [100, 76, 60, 44, 30, 20]) {
    const r = checklistLines(rows, { cols, useColor: false });
    assert.ok(r.lines.length === 1 && r.lines[0].trim().length > 0, `${cols} 列下全绿态变成了空白`);
    assert.ok(displayWidth(r.lines[0]) <= cols, `${cols} 列下超宽 ${displayWidth(r.lines[0])}`);
  }
});

test('呈现：checklistSentence 的零值分支是「没有…」而不是「0 个」', () => {
  const rows = checklistRows({ inboxCount: 0, askedCount: 0, claims: { hard: 0, soft: 0 }, health: { healthy: true, layers: [] } });
  const sent = rows.map((r) => checklistSentence(r));
  for (const s of sent) assert.ok(!/0 个|0 条|→/.test(s), `零值用了占位计数：${s}`);
  assert.ok(sent[0].includes('没有会话在等你'), sent[0]);
  assert.ok(sent[1].includes('没有会话问了没答'), sent[1]);
  assert.ok(sent[2].includes('没有完成声明对不上'), sent[2]);
});

test('呈现：checklistLine 的每行宽度 ≤ cols（含 CJK 与截断披露）', () => {
  const rows = checklistRows({
    inboxCount: 12, askedCount: 7, claims: { hard: 3, soft: 11 },
    health: { healthy: false, layers: [{ name: 'jobs', ageMs: 1.1 * 86400e3 }, { name: 'probe', ageMs: 1.1 * 86400e3 }] },
  });
  for (const cols of [100, 76, 60, 44, 30, 20, 12]) {
    for (const r of rows) {
      const line = checklistLine(r, { cols, layout: resolveLayout({ cols, rows: 30 }), useColor: false });
      assert.ok(displayWidth(line) <= cols, `${cols} 列下超宽 ${displayWidth(line)}：${line}`);
      assert.ok(line.trim().length > 0 || cols < 6, `${cols} 列下画出了空行`);
    }
  }
});

test('呈现：失败项必带一条出路（照抄 claude doctor 的 `Fix:`）', () => {
  const bad = checklistRows({
    inboxCount: 0, askedCount: 0, claims: { hard: 2, soft: 0 },
    health: { healthy: false, layers: [{ name: 'jobs', ageMs: 1.1 * 86400e3 }] },
  });
  const claimsLine = checklistLine(bad[2], { cols: 120, useColor: false });
  const healthLine = checklistLine(bad[3], { cols: 120, useColor: false });
  assert.ok(/d 看证据/.test(claimsLine), `硬矛盾缺键位出路：${claimsLine}`);
  assert.ok(/先修这个/.test(healthLine), `监视未跑缺修法：${healthLine}`);
});

test('呈现：isQuietRow 只把「查了、没发现」算静默，未知/算着不算', () => {
  const rows = checklistRows({ inboxCount: 0, askedCount: 0, claims: { pending: true }, health: null });
  assert.equal(isQuietRow(rows[0]), true);
  assert.equal(isQuietRow(rows[2]), false, '「证据还在算」不能被当成没发现问题');
  assert.equal(isQuietRow(rows[3]), false, '「读不到 state.json」不能被当成没发现问题');
});

// ── 10. 状态行（最后一行是健康度，不是键位）───────────────────────────

test('footerParts：带声明计数 / 数据新鲜度 / 监视状态', () => {
  const p = footerParts({ hard: 1, scanAgeMs: 8000, health: { healthy: false } });
  const s = p.join(' · ');
  assert.ok(s.includes('1 条声明对不上'), s);
  assert.ok(s.includes('8s前'), s);
  assert.ok(s.includes('监视未在跑'), s);
});

test('footerParts：没有硬矛盾时不写「0 条」，改说存疑或省略', () => {
  const p = footerParts({ hard: 0, soft: 3, scanAgeMs: 8000, health: { healthy: true } });
  assert.ok(!/0 条/.test(p.join(' ')), p.join(' '));
  assert.ok(p.join(' ').includes('3 条声明存疑'), p.join(' '));
});

test('footerParts：监视状态未知时不能沉默', () => {
  const p = footerParts({ hard: 0, scanAgeMs: 1000, health: null });
  assert.ok(p.join(' ').includes('监视状态未知'), p.join(' '));
});

// ── 11. 行列渲染 ──────────────────────────────────────────────────────

test('runningColumns：所有列加起来正好等于可用宽度', () => {
  for (const cols of [100, 76, 60]) {
    const w = runningColumns(cols, { showNear: true });
    const used = w.mark + (w.path ? w.path + 1 : 0) + w.idle + 1 + w.near;
    assert.ok(used <= cols, `${cols} 列下固定列合计 ${used} 超宽`);
    assert.ok(w.title >= 8, '标题至少 8 列');
  }
});

test('runningRowOf：任何宽度下都不超宽（含 CJK 标题）', () => {
  const view = {
    key: 'k', kind: 'running', title: '多智能体审计框架项目调研', path: 'C:/Projects/many-agents_multi/prompt',
    idleSec: 29, meta: { lastAssistant: '这是一段很长很长的中文摘要，用来测试截断是否安全可靠以及是否会越界' },
  };
  for (const cols of [100, 76, 60, 44, 30, 20]) {
    const line = runningRowOf(view, { cols, layout: resolveLayout({ cols, rows: 30 }), selected: false, useColor: false });
    assert.ok(displayWidth(line) <= cols, `${cols} 列下超宽 ${displayWidth(line)}：${line}`);
  }
});

test('runningRowOf：选中时用 ❯，未选中时同宽的空白（列恒定）', () => {
  const view = { key: 'k', kind: 'running', title: 'x', idleSec: 1 };
  const layout = resolveLayout({ cols: 76, rows: 30 });
  const on = runningRowOf(view, { cols: 76, layout, selected: true, useColor: false });
  const off = runningRowOf(view, { cols: 76, layout, selected: false, useColor: false });
  assert.ok(on.startsWith('❯'), on);
  assert.equal(displayWidth(on), displayWidth(off), '选中与否不能改变行宽');
});

test('actionRowOf：两行结构（身份+怎么回 / 逐字 needs）', () => {
  const view = {
    key: 'k', kind: 'blocked', title: 'Hilltop', idleSec: 13320,
    needs: '要我现在就把用户实测单交给你，还是你先看这四份测试报告？',
    suggestedReply: '把实测单发给我',
  };
  const lines = actionRowOf(view, { cols: 76, layout: resolveLayout({ cols: 76, rows: 30 }), selected: true, useColor: false });
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('c 复制回复'), lines[0]);
  assert.ok(lines[0].includes('3.7h'), lines[0]);
  assert.ok(lines[1].includes('要我现在就把'), `needs 必须逐字出现：${lines[1]}`);
  for (const l of lines) assert.ok(displayWidth(l) <= 76, `${displayWidth(l)}: ${l}`);
});

test('actionRowOf：极矮档压成一行，但动作列仍在（永不撤）', () => {
  const view = { key: 'k', kind: 'blocked', title: 'X', idleSec: 60, needs: '等你回复', suggestedReply: '好' };
  // 极矮（rows=6 → minimal 档）才压成一行；30×8 仍有两行空间，不该提前撤。
  const minimal = resolveLayout({ cols: 30, rows: 6 });
  assert.equal(minimal.actionTwoLine, false, `30×6 应落到 minimal 档，实际 ${minimal.id}`);
  const lines = actionRowOf(view, { cols: 30, layout: minimal, selected: false, useColor: false });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('复制'), `动作列被撤了：${lines[0]}`);
  for (const l of lines) assert.ok(displayWidth(l) <= 30, `${displayWidth(l)}: ${l}`);
});

// ── 12. 整屏组装 ──────────────────────────────────────────────────────

const SAMPLE = {
  verdict: ['2 件在等你', '11 个会话在跑', '19 个已停'],
  scanAge: '8s前扫描',
  // 检查项现在带 `kind` / `data`（句子由 checklistSentence 产出，不再有四列）。
  // 这里直接用 checklistRows 造，避免手写字面量与真实形态漂移。
  checklist: checklistRows({
    inboxCount: 2, askedCount: 0, claims: { hard: 2, soft: 6 },
    health: { healthy: false, layers: [{ name: 'jobs', ageMs: 8.2 * 3600e3 }, { name: 'probe', ageMs: 8.3 * 3600e3 }] },
  }),
  action: [{
    key: 'a1', kind: 'blocked', title: 'Hilltop Village 优化', idleSec: 13320,
    needs: '要我现在就把用户实测单交给你，还是你先看这四份测试报告？', suggestedReply: '把实测单发给我',
  }],
  running: [
    { key: 'r1', kind: 'running', title: 'OmniSight', path: 'C:/Projects/Overwatch', idleSec: 8, meta: { lastAssistant: '改 TUI 规格' } },
    { key: 'r2', kind: 'running', title: 'PerfScope 多 agent 工作流', path: 'C:/Server/MCServers/PerfScope', idleSec: 6, meta: { lastAssistant: '跑 mvn test' } },
  ],
  stopped: Array.from({ length: 17 }, (_, i) => ({ key: `s${i}`, kind: 'stopped', title: `历史 ${i}`, idleSec: 28 + i * 86400 })),
  footer: ['1 条声明对不上', '数据来自8s前的扫描', '监视未在跑', '? 帮助'],
};

test('composeListScreen：任何尺寸下都不超宽、行数精确等于 rows', () => {
  for (const [cols, rows] of [[120, 40], [76, 30], [60, 24], [44, 20], [30, 12], [20, 8]]) {
    const lines = composeListScreen({ cols, rows, useColor: false, ...SAMPLE });
    assert.equal(lines.length, rows, `${cols}×${rows} 行数不对`);
    for (const l of lines) {
      assert.ok(displayWidth(l) <= cols, `${cols}×${rows} 超宽 ${displayWidth(l)}：${l}`);
    }
  }
});

test('composeListScreen：第 1 行永远是判决，「N 件在等你」在最前', () => {
  for (const [cols, rows] of [[76, 30], [30, 12]]) {
    const lines = composeListScreen({ cols, rows, useColor: false, ...SAMPLE });
    assert.ok(/^\s*2 件在等你/.test(lines[0]), `第 1 行不是判决：${lines[0]}`);
  }
});

test('composeListScreen：最后一行是健康度（状态行），且不在第 1 行', () => {
  const lines = composeListScreen({ cols: 76, rows: 30, useColor: false, ...SAMPLE });
  assert.ok(lines[lines.length - 1].includes('监视未在跑'), lines[lines.length - 1]);
  assert.ok(!/j\/k|Enter 详情/.test(lines[lines.length - 1]), '键位提示不得占用状态行');
});

test('composeListScreen：空段不画（0 行的段标题是噪声）', () => {
  const lines = composeListScreen({ cols: 76, rows: 30, useColor: false, ...SAMPLE, action: [], stopped: [] });
  const text = lines.join('\n');
  assert.ok(!/需动作 \(0\)/.test(text), text);
  assert.ok(!/已停 \(0\)/.test(text), text);
  assert.ok(/在跑 \(2\)/.test(text), '非空段仍要画');
});

test('composeListScreen：需动作段在跑段之前（段序即优先级）', () => {
  const lines = composeListScreen({ cols: 76, rows: 30, useColor: false, ...SAMPLE });
  const ai = lines.findIndex((l) => l.includes('需动作'));
  const ri = lines.findIndex((l) => l.includes('在跑 ('));
  assert.ok(ai > 0 && ri > 0 && ai < ri, `段序错了：需动作@${ai} 在跑@${ri}`);
});

test('composeListScreen：已停段默认压成一行，展开后才逐条画', () => {
  const folded = composeListScreen({ cols: 76, rows: 30, useColor: false, ...SAMPLE, stoppedExpanded: false }).join('\n');
  assert.ok(/已停 \(17\)/.test(folded), folded);
  assert.ok(!/历史 3/.test(folded), '默认不该逐条列出历史会话');
  const open = composeListScreen({ cols: 76, rows: 40, useColor: false, ...SAMPLE, stoppedExpanded: true }).join('\n');
  assert.ok(/历史 3/.test(open), '展开后必须能看到它们');
});

test('composeListScreen：窄档撤掉已停段，但判决行仍在', () => {
  const lines = composeListScreen({ cols: 44, rows: 20, useColor: false, ...SAMPLE, stoppedExpanded: true });
  const text = lines.join('\n');
  assert.ok(!/已停 \(17\)/.test(text), '44 列不该再画已停段');
  assert.ok(/2 件在等你/.test(lines[0]));
});

test('composeListScreen：告警（监视没跑）紧贴判决行，且不替换会话列表', () => {
  const alert = [' ⚠ 后台监视未在运行', '   先修：install'];
  const lines = composeListScreen({ cols: 76, rows: 30, useColor: false, ...SAMPLE, alert });
  assert.ok(lines[1].includes('后台监视未在运行'), lines[1]);
  const text = lines.join('\n');
  assert.ok(/在跑 \(2\)/.test(text), '有告警时仍要显示会话列表');
  assert.ok(/Hilltop/.test(text), '有告警时需动作段仍要在');
});

test('composeListScreen：body 替代三段内容（首扫/空/失败四态）', () => {
  const lines = composeListScreen({
    cols: 76, rows: 30, useColor: false, ...SAMPLE,
    body: ['  首次扫描进行中… 已等待 3s', '  这不是卡死'],
  });
  const text = lines.join('\n');
  assert.ok(text.includes('首次扫描进行中'), text);
  assert.ok(!/在跑 \(2\)/.test(text), 'body 模式下不该再画会话列表');
  assert.ok(/2 件在等你/.test(lines[0]), '即使 body 模式，判决行仍在第 1 行');
});

test('composeListScreen：光标所在行有 ❯，且只有一处', () => {
  const lines = composeListScreen({ cols: 76, rows: 30, useColor: false, ...SAMPLE, cursorKey: 'r2' });
  const marks = lines.filter((l) => l.includes('❯'));
  assert.equal(marks.length, 1, `屏幕上出现了 ${marks.length} 个光标`);
  assert.ok(marks[0].includes('PerfScope'), marks[0]);
});

test('composeListScreen：body 里的超宽行也被裁剪（首扫/空/失败文案不得撑破版面）', () => {
  // 负向验证 v10 守这一条：把 composeListScreen 末尾的裁剪去掉，这里必须变红。
  const longLine = '⚠ 扫描超时（>180s）'.padEnd(200, 'x');
  for (const cols of [76, 44]) {
    const lines = composeListScreen({
      cols, rows: 30, useColor: false, ...SAMPLE, body: [longLine],
    });
    for (const l of lines) {
      assert.ok(displayWidth(l) <= cols, `${cols} 列下 body 行超宽 ${displayWidth(l)}：${l}`);
    }
  }
});

test('composeListScreen：着色不改变宽度（SGR 计 0 列）', () => {
  const plain = composeListScreen({ cols: 76, rows: 30, useColor: false, ...SAMPLE });
  const colored = composeListScreen({ cols: 76, rows: 30, useColor: true, ...SAMPLE });
  assert.equal(plain.length, colored.length);
  for (let i = 0; i < plain.length; i++) {
    assert.equal(displayWidth(colored[i]), displayWidth(plain[i]),
      `第 ${i} 行着色后宽度变了：${JSON.stringify(colored[i])}`);
  }
});
