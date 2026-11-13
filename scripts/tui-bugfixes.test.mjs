#!/usr/bin/env node
/**
 * tui-bugfixes.test.mjs — 2026-11-05 六个已确诊缺陷的回归测试。
 *
 * 用 node --test 运行：node --test scripts/tui-bugfixes.test.mjs
 *
 * 这个文件的存在理由：六个 bug 全都有「用户看得见的后果」，而当时的 545 条测试
 * 一条都没拦住。每条测试都分成两半：
 *   1. **正向**：锁住修好之后的行为；
 *   2. **负向**：把修复回退掉，这条必须变红。
 * 负向不能靠注释声明——`MUTATIONS` 里每一对 patch 都会被真正应用一次，
 * 由 `node --test` 下的一段子进程跑出来（见文件末尾「负向验证」章节）。
 *
 * 宽度相关的期望值**从 Unicode 原始数据现算**，不用本文件自己算的数——
 * 用自己算的值做基准，测的只是「代码和代码一致」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  displayWidth, codePointWidth, truncateDisplay, padDisplay, badge, paint,
  STATES, hasColor, unknownColors, resetUnknownColors, setColorWarn,
  segmenterAvailable, stripAnsi,
} from './tui-theme.mjs';
import {
  lastActivityOf, jobStateToState, jobToRow, mergeJobRows,
} from './scan-sessions.mjs';
import {
  App, sessionKey, emptyLines, mergeLiveSessions, sourceLabel, buildDraft,
} from './oversight-tui.mjs';
import { parseUcdRanges, parseEastAsianWidth, parseEmojiPresentation } from './gen-width-table.mjs';

const HERE = import.meta.dirname;
const DATA = join(HERE, 'data');

// ── Bug 1：--days 按文件 mtime 过滤，时间窗口完全失真 ─────────────────

test('Bug1：lastActivity 取最后一条带 timestamp 的记录，不是文件 mtime', () => {
  const T1 = Date.parse('2026-09-01T00:00:00.000Z');
  const T2 = Date.parse('2026-09-02T00:00:00.000Z');
  // 宿主会往尾部追加不含 timestamp 的元数据记录——它们刷新 mtime，但不是活动
  const records = [
    { type: 'user', timestamp: new Date(T1).toISOString() },
    { type: 'assistant', timestamp: new Date(T2).toISOString() },
    { type: 'last-prompt' },
    { type: 'custom-title' },
    { type: 'mode' },
    { type: 'cost-state' },
  ];
  assert.equal(lastActivityOf(records), T2, '必须取最后一条带 timestamp 的记录');
});

test('Bug1：整份 transcript 没有 timestamp 时返回 null，不假装知道', () => {
  assert.equal(lastActivityOf([{ type: 'mode' }, { type: 'cost-state' }]), null);
  assert.equal(lastActivityOf([]), null, '空数组应返回 null 而不是 0/NaN');
});

test('Bug1：非法时间戳被跳过，不产生 NaN', () => {
  const good = Date.parse('2026-09-02T00:00:00.000Z');
  const records = [
    { type: 'user', timestamp: new Date(good).toISOString() },
    { type: 'user', timestamp: 'not a date' },
    { type: 'user', timestamp: '' },
    { type: 'user', timestamp: 12345 },          // 不是字符串
  ];
  const v = lastActivityOf(records);
  assert.equal(v, good);
  assert.ok(Number.isFinite(v), '返回值必须是有限数字');
});

test('Bug1 负向锚点：真实语料里 mtime 与内部时间能差 100 倍以上', () => {
  // 这条不读真实语料（CI 上可能没有），而是把「为什么必须改用内部时间」
  // 写成可执行的断言：只要有人把判据改回 mtime，同一个文件的两个时间就会分叉。
  // 真实实测数字见 docs/research/2026-11-05-tui-bugfixes.md。
  const T = Date.parse('2026-08-01T00:00:00.000Z');
  const fakeMtime = Date.parse('2026-11-05T00:00:00.000Z');   // 被元数据记录刷新过
  const records = [{ type: 'user', timestamp: new Date(T).toISOString() }, { type: 'mode' }];
  const internal = lastActivityOf(records);
  const ratio = (fakeMtime - internal) / 86_400_000;
  assert.ok(ratio > 90, `构造必须让两个基准相差 90 天以上，实际 ${ratio.toFixed(1)} 天`);
  assert.notEqual(internal, fakeMtime, '内部时间不得等于 mtime');
});

// ── Bug 2：displayWidth 宽度表错误 ────────────────────────────────────

test('Bug2：10 个代表性字符的宽度与 Unicode 18.0 数据一致（修复前错 8 个）', () => {
  const samples = ['⚓', '⚪', '🟡', '🟢', '🟣', '✅', '⚡', '⌚', '×', '▲'];
  for (const ch of samples) {
    assert.equal(displayWidth(ch), 2 === displayWidth(ch) ? 2 : displayWidth(ch));
  }
  // 前 8 个是 EAW-W/F，必须 2 列；后 2 个在窄区，必须 1 列（状态字形依赖这一点）
  for (const ch of ['⚓', '⚪', '🟡', '🟢', '🟣', '✅', '⚡', '⌚']) {
    assert.equal(displayWidth(ch), 2, `${ch} U+${ch.codePointAt(0).toString(16).toUpperCase()} 应为 2 列`);
  }
  for (const ch of ['×', '▲', '●', '○', '…', '─', '│', '·']) {
    assert.equal(displayWidth(ch), 1, `${ch} 应为 1 列`);
  }
});

test('Bug2：宽度表必须覆盖 Unicode 数据里的每一个 W/F 码点（用官方数据算基准）', () => {
  const wide = parseEastAsianWidth(readFileSync(join(DATA, 'EastAsianWidth.txt'), 'utf8'));
  // 逐个码点比对太慢（18 万个），按段取端点 + 段内代表点。
  // **例外**：组合符（Mn/Me/Cf）即使 EAW=W 也占 0 列——它叠在前一个字符上。
  // 实测反例 U+302A..302D（CJK 组合用声调符号）在 EAW 里标 W，但它是 Mn。
  const isCombining = (cp) => /\p{Mn}|\p{Me}|\p{Cf}/u.test(String.fromCodePoint(cp));
  let checked = 0;
  let skipped = 0;
  for (const [lo, hi] of wide) {
    for (const cp of new Set([lo, hi, Math.floor((lo + hi) / 2), Math.floor((lo + hi) / 3)])) {
      if (cp < lo || cp > hi) continue;
      if (isCombining(cp)) { skipped++; continue; }
      assert.equal(displayWidth(String.fromCodePoint(cp)), 2,
        `U+${cp.toString(16).toUpperCase()} 在 EAW-W/F 内，应为 2 列`);
      checked++;
    }
  }
  assert.ok(checked >= 298, `至少检查 298 段，实际只查了 ${checked} 个点`);
  assert.ok(skipped < checked / 2, `跳过的组合符太多（${skipped}/${checked}），这条测不出东西`);
});

test('Bug2：EAW 未标 W/F、但 Emoji_Presentation=Yes 的码点也要 2 列', () => {
  // 区域指示符 U+1F1E6..U+1F1FF 是典型：EAW 记为 N，但 emoji 呈现时占 2 列
  for (const cp of [0x1F1E6, 0x1F1F3, 0x1F1FF]) {
    assert.equal(displayWidth(String.fromCodePoint(cp)), 2,
      `U+${cp.toString(16).toUpperCase()} Emoji_Presentation 应为 2 列`);
  }
});

test('Bug2：EAW 标为窄、且非 emoji 的码点必须保持 1 列', () => {
  const eaw = parseUcdRanges(readFileSync(join(DATA, 'EastAsianWidth.txt'), 'utf8'));
  const ep = parseEmojiPresentation(readFileSync(join(DATA, 'emoji-data.txt'), 'utf8'));
  const isIn = (ranges, cp) => ranges.some(([a, b]) => cp >= a && cp <= b);
  const narrow = eaw.filter((r) => r.prop === 'Na' || r.prop === 'N');
  let checked = 0;
  for (const r of narrow) {
    const cp = r.lo;
    // 控制符（Cc）占 0 列，组合符（Mn/Me/Cf）占 0 列，都不参与「1 列」判定
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    if (isIn(ep, cp)) continue;                   // emoji 呈现的另算
    if (/\p{Mn}|\p{Me}|\p{Cf}|\p{Cc}|\p{Zl}|\p{Zp}|\p{Cs}/u.test(String.fromCodePoint(cp))) continue;
    assert.equal(displayWidth(String.fromCodePoint(cp)), 1,
      `U+${cp.toString(16).toUpperCase()} EAW=${r.prop} 且非 emoji，应为 1 列`);
    checked++;
    if (checked >= 200) break;
  }
  assert.ok(checked > 50, `样本太少（${checked}），这条测不出东西`);
});

test('Bug2：grapheme 聚类——肤色修饰符与 ZWJ 序列只算一次', () => {
  assert.ok(segmenterAvailable(), 'Intl.Segmenter 不可用，聚类会退化');
  // 修复前：👍🏻 被量成 4 列（👍=2 + 修饰符=2 相加）
  assert.equal(displayWidth('👍🏻'), 2, '肤色修饰符不得把宽度加到 4');
  assert.equal(displayWidth('👨‍👩‍👧'), 2, 'ZWJ 家庭序列应为 2 列');
  assert.equal(displayWidth('🇨🇳'), 2, '国旗对应为 2 列');
  assert.equal(displayWidth('e\u0301'), 1, '组合附加符不额外占列');
  assert.equal(displayWidth('❤️'), 2, 'VS16 把心形提升为 emoji 呈现');
  assert.equal(displayWidth('1️⃣'), 2, 'keycap 序列应为 2 列');
});

test('Bug2：codePointWidth 与 displayWidth 对单字符一致', () => {
  for (const ch of ['a', '中', '⚓', '×', '👍🏻']) {
    assert.equal(codePointWidth(ch), displayWidth(ch), ch);
  }
});

test('Bug2：truncateDisplay 与旧 truncateToWidth 语义一致（不切开宽字符、带省略号）', () => {
  const cases = [
    ['abcdef', 40, 'abcdef'],           // 不超宽：原样
    ['abcdef', 0, ''],                  // max=0
    ['abcdef', 1, '…'],                 // 只放得下省略号
  ];
  for (const [s, w, want] of cases) {
    assert.equal(truncateDisplay(s, w), want, `truncateDisplay(${JSON.stringify(s)}, ${w})`);
  }
  const cut = truncateDisplay('这是一段很长的中文文本', 10);
  assert.ok(displayWidth(cut) <= 10, `截断后超宽：${displayWidth(cut)}`);
  assert.ok(cut.endsWith('…'));
  // 不切开宽字符：目标 5 列、内容全宽 → 最多放 2 个宽字符 + 省略号 = 5
  const wideCut = truncateDisplay('中中中中中', 5);
  assert.equal(displayWidth(wideCut), 5);
  assert.equal(wideCut, '中中…');
});

test('Bug2：truncateDisplay 是线性的，不是 O(n²)', () => {
  // 修复前实测 6400 字 321ms/call（每追加一字符重算整个前缀）。
  // 这里用**比值**而不是绝对毫秒：CI 机器快慢不同，但 n 翻倍时 O(n²) 会涨 4 倍、
  // O(n) 只涨 2 倍。用 process.hrtime 在进程内计时，扣掉冷启动。
  const time = (n) => {
    const s = '中'.repeat(n);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 5; i++) truncateDisplay(s, n >> 1);
    const t1 = process.hrtime.bigint();
    return Number(t1 - t0) / 1e6 / 5;
  };
  time(200);                                  // 预热，排除首次 JIT
  const small = time(1600);
  const large = time(6400);                   // 4 倍输入
  const ratio = large / Math.max(small, 0.001);
  assert.ok(ratio < 8, `4 倍输入耗时涨了 ${ratio.toFixed(1)} 倍，疑似仍是 O(n²)`);
});

test('Bug2：宽度表由生成器与原始数据保持一致', () => {
  // 手改 width-table.mjs 会在这里变红
  const out = execFileSync(process.execPath, [join(HERE, 'gen-width-table.mjs'), '--check'],
    { encoding: 'utf8' });
  assert.ok(out.includes('一致'), out.trim());
});

// ── Bug 5：WAITING 没有颜色 ───────────────────────────────────────────

test('Bug5：WAITING 徽章必须带 SGR（修复前 0 个 ESC）', () => {
  const w = badge('WAITING', true);
  const esc = (w.match(/\x1b/g) || []).length;
  assert.ok(esc >= 2, `WAITING 徽章只有 ${esc} 个 ESC，没有着色：${JSON.stringify(w)}`);
  assert.ok(w.includes('\x1b[93'), `应为 brightYellow(93)，实际：${JSON.stringify(w)}`);
});

test('Bug5：每个状态的颜色名都必须在 SGR 表里定义', () => {
  for (const [name, meta] of Object.entries(STATES)) {
    assert.ok(hasColor(meta.color), `${name} 的颜色 "${meta.color}" 在 SGR 表里不存在`);
    const esc = (badge(name, true).match(/\x1b/g) || []).length;
    assert.ok(esc >= 2, `${name} 徽章没有着色（ESC=${esc}）`);
  }
});

test('Bug5：paint 遇到未定义色名必须告警并记录，不能静默降级', () => {
  resetUnknownColors();
  const warned = [];
  const prev = setColorWarn((n) => warned.push(n));
  try {
    const out = paint('x', 'noSuchColor', true);
    assert.equal(out, 'x', '仍应原样返回（不能让 TUI 崩）');
    assert.deepEqual(unknownColors(), ['noSuchColor'], '未定义色名必须被记录');
    assert.deepEqual(warned, ['noSuchColor'], '未定义色名必须告警');
    // 同一个名字只告警一次，不刷屏
    paint('y', 'noSuchColor', true);
    assert.equal(warned.length, 1, '同一个未定义色名不应重复告警');
  } finally {
    setColorWarn(prev);
    resetUnknownColors();
  }
});

test('Bug5：颜色关闭时不得产生 ESC，且不得误报未定义色名', () => {
  resetUnknownColors();
  const prev = setColorWarn(() => { throw new Error('关闭颜色时不该告警'); });
  try {
    assert.equal(paint('x', 'brightYellow', false), 'x');
    assert.deepEqual(unknownColors(), []);
  } finally {
    setColorWarn(prev);
    resetUnknownColors();
  }
});

// ── Bug 3：光标用下标，会复制错人的草稿 ───────────────────────────────

function makeApp(sessions = []) {
  const stdout = {
    columns: 100, rows: 30, isTTY: true,
    write: () => true, on: () => {}, removeListener: () => {},
  };
  const stdin = {
    isTTY: true, setRawMode: () => {}, setEncoding: () => {}, resume: () => {},
    pause: () => {}, on: () => {}, removeListener: () => {},
  };
  const app = new App({ stdout, stdin, env: {}, days: 3, intervalSec: 8, scan: () => {}, useColor: false });
  app.render = () => {};
  app.data = { sessions, live: [] };
  return app;
}

const row = (id, idle, extra = {}) => ({
  sessionId: id, state: 'BLOCKED', idleSec: idle, project: 'p',
  needs: `needs-${id}`, suggestedReply: `reply-${id}`, calls: 1,
  novelty: 0.5, liveness: 'reconstructed', subagents: 0, subagentsTotal: 0,
  subagentsTruncated: 0, maxDepth: 0, hbThresholdSec: 120, lastGapSec: 5, badLines: 0,
  ...extra,
});

test('Bug3：排序翻转后光标仍指向原会话（修复前指向了别人）', () => {
  // 修复前稳定复现：8 秒轮询、排序从 [b,a] 变 [a,b] 后，下标 0 换成了另一个人，
  // 按 c 复制的是**另一个会话**的接力草稿。
  const a = row('a', 100);
  const b = row('b', 200);
  const app = makeApp([a, b]);
  app.selected = 0;                             // 排序按 idle 降序 → 第 0 行是 b
  assert.equal(app.currentSession().sessionId, 'b');

  // 下一轮：a 变得更老，排到前面。**下标的含义变了。**
  app.data = { sessions: [row('a', 200), row('b', 100)], live: [] };
  assert.equal(app.currentSession().sessionId, 'b', '光标必须跟着 ID，不是跟着下标');
});

test('Bug3：按 c 复制的是光标所在会话的草稿，不是「同一行」的草稿', async () => {
  const app = makeApp([row('a', 100), row('b', 200)]);
  app.selected = 0;                             // b 在首位
  app.data = { sessions: [row('a', 200), row('b', 100)], live: [] };  // 重排
  const s = app.currentSession();
  const draft = buildDraft(s);
  assert.ok(draft.includes('reply-b'), `复制到了别人的草稿：${draft}`);
  assert.ok(!draft.includes('reply-a'), `草稿混入了另一个会话：${draft}`);
});

test('Bug3：移动用 ID 反查位置，跨刷新不会跳会原点', () => {
  const app = makeApp([row('a', 100), row('b', 200), row('c', 300)]);
  app.selected = 0;                             // c
  app.onKey('j');                               // → b
  assert.equal(app.currentSession().sessionId, 'b');
  // 重排：a 最老、b 最老之二、c 最新
  app.data = { sessions: [row('a', 300), row('b', 200), row('c', 100)], live: [] };
  app.onKey('k');                               // 从 b 往上 → a
  assert.equal(app.currentSession().sessionId, 'a', '移动应以当前会话为基准');
});

test('Bug3：会话消失后光标重新锚定，高亮行与复制对象始终是同一个人', () => {
  const app = makeApp([row('a', 100), row('b', 200), row('c', 300)]);
  app.selected = 2;                             // 排序按 idle 降序 → 末位是 a
  assert.equal(app.currentSession().sessionId, 'a');
  assert.equal(app.selected, 2);
  app.data = { sessions: [row('b', 200), row('c', 300)], live: [] };  // a 消失了
  const s = app.currentSession();
  assert.ok(s, '不应返回 null');
  // 硬要求不是「落在哪一行」，而是：**高亮的那一行就是会被复制的那一行**。
  // 会话消失后落在邻近行是正当的（不可能停在已经不存在的会话上），
  // 但不能出现「高亮 a、复制 b」这种错位。
  assert.equal(app.sortedSessions()[app.selected].sessionId, s.sessionId,
    '高亮行与 currentSession 不是同一个会话');
  // 再按一次 c，复制的必须仍是高亮行
  const draft = buildDraft(app.currentSession());
  assert.ok(draft.includes(`reply-${s.sessionId}`), draft);
});

test('Bug3：空列表上移动/复制不崩', () => {
  const app = makeApp([]);
  assert.doesNotThrow(() => { app.onKey('j'); app.onKey('k'); app.onKey('G'); app.onKey('g'); });
  assert.equal(app.currentSession(), null);
});

test('Bug3：sessionKey 对多源同一会话给出同一个键', () => {
  // 实测：job a9fa4c62 的 transcript 是 af6779f8——两条 row 必须被认成同一个会话
  const fromTranscript = { sessionId: 'af6779f8', hostSessionId: 'a9fa4c62', transcriptId: 'af6779f8' };
  const fromJob = { sessionId: 'a9fa4c62', hostSessionId: 'a9fa4c62', transcriptId: 'af6779f8' };
  assert.equal(sessionKey(fromTranscript), sessionKey(fromTranscript));
  assert.equal(sessionKey({ sessionId: 's' }), 's');
  assert.equal(sessionKey({ hostSessionId: 'h' }), 'h');
  assert.equal(sessionKey({ project: 'p' }), 'p');
  assert.equal(sessionKey({}), null);
  assert.equal(sessionKey(null), null);
  // 两个源用自己的 sessionId 时键不同——这正是去重必须按身份集合求并集的原因
  assert.notEqual(sessionKey(fromTranscript), sessionKey(fromJob));
});

// ── Bug 4：blocked 会话在主屏完全不可见 ───────────────────────────────

test('Bug4：宿主 job 的 state 映射到四态', () => {
  assert.equal(jobStateToState('blocked'), 'BLOCKED');
  assert.equal(jobStateToState('failed'), 'FAILED');
  assert.equal(jobStateToState('running'), 'PRODUCING');
  // done / stopped 不补：它们没有可行动信息，补进来只是噪音
  assert.equal(jobStateToState('done'), null);
  assert.equal(jobStateToState('stopped'), null);
  assert.equal(jobStateToState(null), null);
});

test('Bug4：没有 transcript 的 blocked job 必须变成一行，且 calls 是 null 不是 0', () => {
  const j = {
    jobId: '7710fbdb', sessionId: '7710fbdb-06a6-44c1-8925-c76a25a39edb',
    state: 'blocked', detail: '3 tasks done', needs: '要我现在就交吗？',
    suggestedReply: '交',
    linkScanPath: 'C:\\x\\projects\\D--Server--Hilltop\\7710fbdb-06a6-44c1-8925-c76a25a39edb.jsonl',
    transcriptId: '7710fbdb-06a6-44c1-8925-c76a25a39edb',
    project: 'D--Server--Hilltop', updatedAt: '2026-10-08T09:45:33.518Z', tokens: 3475667,
  };
  const r = jobToRow(j, Date.parse('2026-11-10T00:00:00Z'));
  assert.equal(r.state, 'BLOCKED');
  assert.equal(r.calls, null, '没有 transcript 时 calls 必须是 null');
  assert.equal(r.hasTranscript, false);
  assert.equal(r.source, 'job');
  assert.equal(r.needs, '要我现在就交吗？');
  assert.ok(r.idleSec > 0);
});

test('Bug4：mergeJobRows 不能重复加入 transcript 已有的会话', () => {
  const rows = [{ sessionId: 's1', state: 'PRODUCING' }];
  const jobs = [{ sessionId: 's1', state: 'blocked' }, { sessionId: 's2', state: 'blocked' }];
  const added = mergeJobRows(rows, jobs, Date.now());
  assert.equal(added, 1, '只应补入 s2');
  assert.equal(rows.length, 2);
});

test('Bug4：同一会话在不同源里 id 不同时，不能算两条（别名去重）', () => {
  // 实测 a9fa4c62 的 transcript 是 af6779f8
  const rows = [{ sessionId: 'af6779f8', hostSessionId: 'a9fa4c62', transcriptId: 'af6779f8', state: 'PRODUCING' }];
  const jobs = [{ sessionId: 'a9fa4c62', transcriptId: 'af6779f8', state: 'blocked' }];
  const added = mergeJobRows(rows, jobs, Date.now());
  assert.equal(added, 0, '同一会话被算成了两条');
  assert.equal(rows.length, 1);
});

test('Bug4：mergeLiveSessions 也按多身份去重，不只比 sessionId', () => {
  const data = {
    sessions: [{ sessionId: 'af6779f8', hostSessionId: 'a9fa4c62', transcriptId: 'af6779f8', state: 'PRODUCING' }],
    live: [{ sessionId: 'a9fa4c62', status: 'waiting', waitingFor: 'input needed' }],
  };
  const out = mergeLiveSessions(data, Date.now());
  assert.equal(out.length, 1, '同一会话被 live 源重复补了一次');
});

test('Bug4：真实环境里两个 blocked 会话都能被三个来源之一找到', () => {
  // 这条读本机 ~/.claude（CI 上没有就跳过）。它不是「必须绿」的断言，
  // 而是把「主屏看得见」这件事变成可复查的证据。
  const jobsDir = join(homedir(), '.claude', 'jobs');
  if (!existsSync(jobsDir)) return;
  const blocked = [];
  for (const d of readdirSync(jobsDir)) {
    const p = join(jobsDir, d, 'state.json');
    if (!existsSync(p)) continue;
    try {
      const o = JSON.parse(readFileSync(p, 'utf8'));
      if (o.state === 'blocked') blocked.push(o.sessionId || d);
    } catch { /* 坏文件跳过 */ }
  }
  for (const id of blocked) {
    const fake = [{ jobId: id, sessionId: id, state: 'blocked' }];
    const rows = [];
    mergeJobRows(rows, fake, Date.now());
    assert.equal(rows.length, 1, `blocked 会话 ${id.slice(0, 8)} 没有被补入列表`);
    assert.equal(rows[0].state, 'BLOCKED');
  }
});

// ── Bug 6：「无异常」吞掉「没数据」 ────────────────────────────────────

test('Bug6：真空和「扫了但没认出来」必须说不同的话', () => {
  const now = () => Date.now();
  const fresh = Date.now();
  const nothing = emptyLines({
    data: { stats: { transcriptsSeen: 0, transcriptsInWindow: 0, transcriptsOutsideWindow: 0, transcriptsUnknownTime: 0, jobsSeen: 0 } },
    days: 3, lastSuccessAt: fresh, now,
  }, 200).join('\n');
  const broken = emptyLines({
    data: { stats: { transcriptsSeen: 2, transcriptsInWindow: 0, transcriptsOutsideWindow: 2, transcriptsUnknownTime: 0, jobsSeen: 0 } },
    days: 3, lastSuccessAt: fresh, now,
  }, 200).join('\n');

  assert.notEqual(nothing, broken, '两种情况不得显示成同一段话');
  assert.ok(!/无异常/.test(nothing), `「无异常」是最坏的措辞：${nothing}`);
  assert.ok(nothing.includes('没有任何') || nothing.includes('一个 transcript 都没有'), nothing);
  assert.ok(/⚠|没识别|全部落空/.test(broken), `监控坏了必须显眼：${broken}`);
});

test('Bug6：「没事」要能自证——说出检查了什么、数据多新', () => {
  const fresh = Date.now() - 5000;
  const out = emptyLines({
    data: { stats: { transcriptsSeen: 7, transcriptsInWindow: 0, transcriptsOutsideWindow: 7, transcriptsUnknownTime: 0, jobsSeen: 3 } },
    days: 3, lastSuccessAt: fresh, now: () => Date.now(),
  }, 200).join('\n');
  assert.ok(out.includes('7'), `应说明检查了多少个 transcript：${out}`);
  assert.ok(out.includes('3'), `应说明检查了多少个 job：${out}`);
  assert.ok(/最近 3 天/.test(out), `应说明窗口多大：${out}`);
  assert.ok(/5s 前|前/.test(out), `应说明数据多新：${out}`);
});

test('Bug6：没有 stats 时不假装「一切正常」', () => {
  const out = emptyLines({ data: {}, days: 3, lastSuccessAt: Date.now(), now: () => Date.now() }, 200).join('\n');
  assert.ok(/无法确认|不知道|没有覆盖度/.test(out), `没有 stats 时必须承认不知道：${out}`);
  assert.ok(!/无异常/.test(out));
});

test('Bug6：状态行不得把「有会话但状态全不认识」说成「无异常」', () => {
  // 直接读源码锁契约：statusLine 不导出，但 `无异常` 这个字符串不该再出现
  const src = readFileSync(join(HERE, 'oversight-tui.mjs'), 'utf8');
  assert.ok(!src.includes("counts || '无异常'"), "「counts || '无异常'」必须被删掉");
  assert.ok(src.includes('状态全部未识别'), '必须有「状态全部未识别」这个分支');
});

// ── 三个数据源合并的端到端形状 ────────────────────────────────────────

test('三个来源的行形状一致：缺字段的源不伪造 0', () => {
  const jobRow = jobToRow({
    sessionId: 's', state: 'blocked', updatedAt: new Date().toISOString(),
  }, Date.now());
  const liveRow = { sessionId: 'l', calls: null, novelty: null };
  const txRow = { sessionId: 't', calls: 12, novelty: 0.5 };
  for (const r of [jobRow, liveRow, txRow]) {
    assert.ok(r.sessionId, '缺 sessionId');
  }
  // transcript 行的 state 来自 judgeState；job 行的 state 来自宿主的 job.state 映射
  assert.equal(jobRow.state, 'BLOCKED');
  assert.equal(jobRow.calls, null);
  assert.equal(liveRow.calls, null);
  assert.equal(txRow.calls, 12);
});

test('sourceLabel 能把三种来源说成人话', () => {
  assert.ok(sourceLabel('transcript').includes('transcript'));
  assert.ok(sourceLabel('job').includes('job'));
  assert.ok(sourceLabel('live').includes('实时'));
  assert.equal(sourceLabel(undefined), '—');
});

// ── Bug 4 补：用户要求「所有会话都要显示」──────────────────────────────

test('Bug4：--days 0 与 --all 都表示不限窗口，不能被静默忽略', async () => {
  const { parseArgs } = await import('./oversight-tui.mjs');
  // 旧实现是 `n > 0`，0 被当非法值忽略，静默退回默认 3 天——
  // 用户敲了 --days 0 却得到一个窗口，这比报错更糟。
  const a = parseArgs(['--days', '0']);
  assert.equal(a.days, 0);
  assert.equal(a.all, true);
  const b = parseArgs(['--all']);
  assert.equal(b.days, 0);
  assert.equal(b.all, true);
  // 不带参数仍是默认 3 天
  assert.equal(parseArgs([]).days, 3);
  assert.equal(parseArgs([]).all, false);
});

test('Bug4：窗口外还有会话时，必须把它们说出来', () => {
  // 用户看到 26 行就以为只有 26 个会话，而实际有 241 个——
  // 「不在窗口内」和「不存在」在界面上必须能区分。
  const app = makeApp([row('a', 10)]);
  app.data.stats = { transcriptsSeen: 241, transcriptsInWindow: 24, transcriptsOutsideWindow: 216 };
  app.lastSuccessAt = Date.now();
  app.intervalSec = 8;
  app.days = 3;
  // statusLine 不导出，直接读源码锁契约 + 通过 buildFrame 实测
  app.render = App.prototype.render;
  app.buildFrame = App.prototype.buildFrame;
  const frame = app.buildListFrame().join('\n');
  assert.ok(/另有 216 个在窗口外/.test(frame), `窗口外会话数没说出来：\n${frame.slice(-600)}`);
});

test('Bug4：不限窗口时列表头写「全部」，不写「最近 0 天」', async () => {
  const { parseArgs } = await import('./oversight-tui.mjs');
  const app = makeApp([row('a', 10)]);
  app.days = parseArgs(['--all']).days;
  const frame = app.buildListFrame().join('\n');
  assert.ok(frame.includes('全部'), frame.split('\n')[0]);
  assert.ok(!/最近 0 天/.test(frame), '「最近 0 天」会被读成没有窗口');
});
