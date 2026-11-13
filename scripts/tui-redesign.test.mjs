#!/usr/bin/env node
/**
 * tui-redesign.test.mjs — 新 TUI 主屏的验收测试（端到端 + 规格锁）。
 *
 * 与 `tui-layout.test.mjs` 的分工：那个文件测**纯函数**（每一行的宽度、每一档的
 * 撤块顺序）；本文件测**整条链路**——`App.buildListFrame()` 与 `--plain` 的真实输出，
 * 以及规格里那几条「不能靠读代码看出来」的约束。
 *
 * 对应规格：`docs/design/2026-11-05-tui-redesign-plan.md` §2.4 / §2.6 / §九·二。
 *
 * 用法：node --test scripts/tui-redesign.test.mjs
 * 负向：node scripts/verify-tui-negatives.mjs（把下面每条锁的能力关掉，必须变红）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { BINARY, displayWidth } from './tui-theme.mjs';
import { App, printPlain, buildSections, claimsTally, askedCountOf, viewOf, main } from './oversight-tui.mjs';
import { checklistRows, resolveLayout } from './tui-layout.mjs';

const HERE = import.meta.dirname;
const SRC = readFileSync(join(HERE, 'oversight-tui.mjs'), 'utf8');

// ── 测试夹具 ──────────────────────────────────────────────────────────

const BS = String.fromCharCode(92);

/** 一个最小可渲染的 scan --json 结构。三段各有内容，覆盖四种状态。 */
export function sampleData() {
  const now = Date.now();
  return {
    generatedAt: new Date(now - 8000).toISOString(),
    days: 3,
    stats: {
      transcriptsSeen: 241, transcriptsInWindow: 24, transcriptsOutsideWindow: 216,
      transcriptsUnknownTime: 1, jobsSeen: 10, jobsAdded: 2, liveSeen: 10,
    },
    live: [
      { sessionId: 'run-1', status: 'busy' },
      { sessionId: 'run-2', status: 'busy' },
    ],
    sessions: [
      {
        project: 'D--Server-MCServers-Server-plugin-Hilltop-Village', sessionId: 'act-1',
        state: 'BLOCKED', idleSec: 13320, calls: null, hasTranscript: false,
        needs: '要我现在就把用户实测单交给你，还是你先看这四份测试报告？',
        suggestedReply: '把实测单发给我', source: 'job',
      },
      {
        project: 'D--Projects-Overwatch', sessionId: 'run-1', state: 'PRODUCING',
        idleSec: 8, calls: 748, hasTranscript: true, subagents: 0, subagentsTotal: 51, maxDepth: 1,
        // reason 故意带上：AC4 断言它不得出现在主屏。没有这个字段，
        // 「把 reason 拼回列表行」这个回退就测不出来（负向验证 v7）。
        reason: 'persistent-change-in-window',
      },
      {
        project: 'D--Server-MCServers-Server-plugin-PerfScope', sessionId: 'run-2', state: 'PRODUCING',
        idleSec: 6, calls: 120, hasTranscript: true, reason: 'persistent-change-in-window',
      },
      {
        project: 'D--Projects-shapez', sessionId: 'stop-1', state: 'EXPLORING',
        idleSec: 2 * 86400, calls: 30, hasTranscript: true, reason: 'dormant',
      },
      {
        project: 'D--Projects-shapez', sessionId: 'stop-2', state: 'EXPLORING',
        idleSec: 28, calls: 30, hasTranscript: true,
      },
    ],
  };
}

export function makeApp({ cols = 76, rows = 30, data = sampleData(), health = null, inbox = [], claims = null } = {}) {
  const stdout = {
    columns: cols, rows, isTTY: true, write: () => true, on: () => {}, removeListener: () => {},
  };
  const stdin = {
    isTTY: true, setRawMode: () => {}, setEncoding: () => {}, resume: () => {},
    pause: () => {}, on: () => {}, removeListener: () => {},
  };
  const app = new App({ stdout, stdin, env: {}, days: 3, intervalSec: 8, scan: () => {}, useColor: false });
  app.render = () => {};
  app.data = data;
  app.lastSuccessAt = Date.now() - 8000;
  app.health = health;
  app.inbox = inbox;
  app.claims = claims ?? { results: [] };
  return app;
}

// ── AC1：判决行 ───────────────────────────────────────────────────────

test('AC1 主屏第 1 行回答「几件在等你」，且这个数在最前', () => {
  const app = makeApp();
  const frame = app.buildListFrame();
  assert.ok(/^\s*1 件在等你/.test(frame[0]), `第 1 行不是判决：${JSON.stringify(frame[0])}`);
  // 顺序即优先级：不能先写「5 个会话」
  assert.ok(frame[0].indexOf('件在等你') < frame[0].indexOf('会话在跑'), frame[0]);
});

test('AC1 判决行的三个数都由数据算出来，没有一个写死', () => {
  const app = makeApp();
  const before = app.buildListFrame()[0];
  // 把在跑/已停各删一条，判决行必须跟着变
  app.data = {
    ...sampleData(),
    sessions: sampleData().sessions.filter((s) => s.sessionId !== 'run-2' && s.sessionId !== 'stop-1'),
  };
  app._sections = null;
  app._sectionsKey = undefined;
  const after = app.buildListFrame()[0];
  assert.notEqual(before, after, '判决行没有随数据变化');
});

// ── AC2：整屏宽度 ─────────────────────────────────────────────────────

test('AC2 真实数据在 76 / 60 / 44 列下渲染，每行都 ≤ cols', () => {
  for (const cols of [76, 60, 44, 30]) {
    const app = makeApp({ cols, rows: 30 });
    const frame = app.buildListFrame();
    for (const l of frame) {
      assert.ok(displayWidth(l) <= cols, `${cols} 列下超宽 ${displayWidth(l)}：${l}`);
    }
  }
});

test('AC2 整屏行数恒等于终端高度（不滚屏、不留尾）', () => {
  for (const rows of [40, 30, 24, 12]) {
    const app = makeApp({ cols: 76, rows });
    assert.equal(app.buildListFrame().length, rows, `rows=${rows} 时行数不对`);
  }
});

test('AC2 状态行永远在最后一行，且它不是键位提示', () => {
  const app = makeApp({ cols: 76, rows: 30 });
  const frame = app.buildListFrame();
  const last = frame[frame.length - 1];
  assert.ok(!/Enter 详情|j\/k 移动/.test(last), `状态行被键位提示占了：${last}`);
  assert.ok(/扫描|监视|尚未/.test(last), `状态行没有健康度信息：${last}`);
});

// ── AC4：字段不得回流 ─────────────────────────────────────────────────

test('AC4 主屏不得出现 reason / novelty / liveness / calls（规划 §2.5 判死）', () => {
  const app = makeApp({ cols: 200, rows: 30 });
  const text = app.buildListFrame().join('\n');
  for (const field of ['reason', 'novelty', 'liveness', 'calls=', 'dormant', 'persistent-change-in-window']) {
    assert.ok(!text.includes(field), `主屏出现了被判死的字段「${field}」：\n${text.slice(0, 400)}`);
  }
});

test('AC4 六态名只在详情页出现，列表页只说「在跑 / 已停」', () => {
  const app = makeApp({ cols: 200, rows: 30 });
  const text = app.buildListFrame().join('\n');
  for (const st of ['PRODUCING', 'EXPLORING', 'STALLED']) {
    assert.ok(!text.includes(st), `列表页出现了六态名「${st}」`);
  }
});

// ── §2.6：空状态三要素 ────────────────────────────────────────────────

test('§2.6 空状态必须交代：检查了哪几项 / 数据多新 / 监视是否在跑', () => {
  const app = makeApp({
    data: { generatedAt: new Date().toISOString(), days: 3, live: [], sessions: [], stats: { transcriptsSeen: 0, transcriptsInWindow: 0, transcriptsOutsideWindow: 0, transcriptsUnknownTime: 0, jobsSeen: 0 } },
    health: { healthy: true, layers: [{ name: 'jobs', ageMs: 30000 }, { name: 'probe', ageMs: 60000 }] },
  });
  const text = app.buildListFrame().join('\n');
  // 2026-11-11：**不再有「检查了什么」表头**。三要素改为：
  //   项数（`4 项检查都清白`）+ 数据新鲜度（L0 右侧）+ 监视在跑（收尾句里逐字说）
  assert.ok(/4 项检查都清白/.test(text), `缺检查项数/结论：\n${text.slice(0, 600)}`);
  assert.ok(/s前|m前/.test(text), '缺数据新鲜度');
  assert.ok(/监视在跑/.test(text), '缺监视状态（健康时也必须说出来，不能被计数吞掉）');
  // 空状态的三要素仍然齐全，只是换了形态：覆盖度由 emptyLines 给。
  assert.ok(/检查了 0 个 transcript/.test(text), '缺扫描覆盖度');
});

test('§2.6 空状态不得使用断言词', () => {
  const app = makeApp({
    data: { generatedAt: new Date().toISOString(), days: 3, live: [], sessions: [], stats: { transcriptsSeen: 0, transcriptsInWindow: 0, transcriptsOutsideWindow: 0, transcriptsUnknownTime: 0, jobsSeen: 0 } },
    health: { healthy: true, layers: [] },
  });
  const text = app.buildListFrame().join('\n');
  assert.ok(!/无异常|一切正常|已全面检查/.test(text), text);
});

test('§2.6 四态互相区分：首扫中 / 确实没事 / 监视没跑 / 扫描失败', () => {
  const empty = { generatedAt: new Date().toISOString(), days: 3, live: [], sessions: [], stats: { transcriptsSeen: 0, transcriptsInWindow: 0, transcriptsOutsideWindow: 0, transcriptsUnknownTime: 0, jobsSeen: 0 } };
  const okHealth = { healthy: true, layers: [{ name: 'jobs', ageMs: 30000 }] };
  const badHealth = { healthy: false, reasons: ['jobs：已 8.2 小时 未运行'], layers: [{ name: 'jobs', ageMs: 8.2 * 3600e3 }] };

  const pending = makeApp({ data: null, health: null });
  pending.warning = null;
  const pendingText = pending.buildListFrame().join('\n');

  const fine = makeApp({ data: empty, health: okHealth });
  const fineText = fine.buildListFrame().join('\n');

  const noWatch = makeApp({ data: empty, health: badHealth });
  const noWatchText = noWatch.buildListFrame().join('\n');

  const failed = makeApp({ data: null, health: null });
  failed.warning = '扫描超时（>180s）';
  const failedText = failed.buildListFrame().join('\n');

  const texts = [pendingText, fineText, noWatchText, failedText];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      assert.notEqual(texts[i], texts[j], `第 ${i} 态与第 ${j} 态显示了同一段话`);
    }
  }
  assert.ok(/首次扫描进行中/.test(pendingText), pendingText.slice(0, 300));
  assert.ok(/扫描失败/.test(failedText), failedText.slice(0, 300));
  assert.ok(/监视未在运行/.test(noWatchText), '监视没跑时必须进第一屏');
  assert.ok(/install-watcher/.test(noWatchText), '必须给出「先修什么」的可执行命令');
});

test('§2.6 监视没跑时，告警不替换会话列表（两者都是事实）', () => {
  const app = makeApp({ health: { healthy: false, reasons: ['jobs 停了'], layers: [{ name: 'jobs', ageMs: 8e6 }] } });
  const text = app.buildListFrame().join('\n');
  assert.ok(/后台监视未在运行/.test(text), '缺告警');
  assert.ok(/在跑 \(2\)/.test(text), '告警把会话列表挤掉了');
});

// ── §九·二：三条裁决 ──────────────────────────────────────────────────

test('裁决 R1：「已停」默认压成一行，按 h 才展开', () => {
  const app = makeApp({ cols: 76, rows: 40 });
  const folded = app.buildListFrame().join('\n');
  assert.ok(/已停 \(2\)/.test(folded), folded.slice(0, 600));
  assert.ok(/h 展开/.test(folded), '必须告诉用户怎么展开');
  assert.ok(!/stop-1/.test(folded), '默认不该逐条列出已停会话');

  app.onKey('h');
  const open = app.buildListFrame().join('\n');
  assert.ok(app.stoppedExpanded, 'h 没切换展开状态');
  assert.ok(/已停 \(2\)/.test(open), '展开后段标题仍在');
});

test('裁决 R2：四道数据源一条不砍，但**只有有事的项才占行**', () => {
  // 四行仍然来自 checklistRows（一行不砍）；变化的是**呈现**：
  // 没有发现的行不占屏，全部为零时压成一句，绝不留空。
  const rows = checklistRows({ inboxCount: 1, askedCount: 0, claims: { hard: 0, soft: 0 }, health: { healthy: true, layers: [{ name: 'jobs', ageMs: 30000 }] } });
  assert.equal(rows.length, 4, '四道数据源必须齐');
  assert.deepEqual(rows.map((r) => r.label), ['等你回应', '问了没答', '声明对不上', '后台监视']);

  const app = makeApp({ cols: 100, rows: 30, health: { healthy: true, layers: [{ name: 'jobs', ageMs: 30000 }] } });
  const text = app.buildListFrame().join('\n');
  // 三项没有发现在这块里不占行（但会被数进收尾句）；有事的那一项仍在
  assert.ok(!/没有会话问了没答/.test(text), `零值行不该占屏：\n${text.slice(0, 600)}`);
  // 全绿时压成一句，且**不能是空白**
  const quiet = makeApp({ cols: 100, rows: 30, data: { generatedAt: new Date().toISOString(), days: 3, live: [], sessions: [], stats: { transcriptsSeen: 0, transcriptsInWindow: 0, transcriptsOutsideWindow: 0, transcriptsUnknownTime: 0, jobsSeen: 0 } }, health: { healthy: true, layers: [{ name: 'jobs', ageMs: 30000 }] } }).buildListFrame().join('\n');
  assert.ok(/4 项检查都清白/.test(quiet), `全部为零时必须有一句判决，不能空白：\n${quiet.slice(0, 600)}`);
});

test('裁决 R3：证据计数常驻，完整内容按 d', () => {
  const app = makeApp({ cols: 100, rows: 30, claims: { results: [
    { status: 'FAILED_ONLY', claim: { quote: '推送完成' } },
    { status: 'STALE_ONLY', claim: { quote: '测试全绿' } },
  ] } });
  const text = app.buildListFrame().join('\n');
  // 100 列下检查表的备注列被压缩，`d 看证据` 可能被截。它必须在**某处**常驻 ——
  // 角落是「计数进了首屏」，而不是「特定文案出现在特定列」。
  assert.ok(/1 条/.test(text), `硬矛盾计数没进首屏：\n${text.slice(0, 600)}`);
  const wide = makeApp({ cols: 76, rows: 30, claims: { results: [
    { status: 'FAILED_ONLY', claim: { quote: '推送完成' } },
  ] } }).buildListFrame().join('\n');
  assert.ok(/d 看证据/.test(wide), `76 列下必须告诉用户按什么键看证据：\n${wide.slice(0, 600)}`);
  // 完整证据不进首屏
  assert.ok(!/推送完成/.test(text), '证据原文不该常驻列表页');
});

// ── P6：不提供假按钮 ──────────────────────────────────────────────────

test('P6 需动作行：有 suggestedReply 才写 c，否则写 Enter 看原文', () => {
  const app = makeApp({ cols: 100, rows: 30 });
  const text = app.buildListFrame().join('\n');
  assert.ok(/c 复制回复/.test(text), '有草稿的行必须提供 c');
  // 造一条只有 needs、没有建议回复的
  const data = sampleData();
  data.sessions[0] = { ...data.sessions[0], suggestedReply: null };
  const app2 = makeApp({ cols: 100, rows: 30, data });
  const text2 = app2.buildListFrame().join('\n');
  assert.ok(/Enter 看原文/.test(text2), '没有草稿时不得提供 c');
});

test('P6 需动作段逐字显示 needs，不摘要', () => {
  const app = makeApp({ cols: 120, rows: 30 });
  const text = app.buildListFrame().join('\n');
  assert.ok(text.includes('要我现在就把用户实测单交给你'), `needs 被摘要了：\n${text.slice(0, 800)}`);
});

// ── 颜色：只有需动作段上色 ────────────────────────────────────────────

test('视觉：无色降级表四字形互不相同，且都是 1 列', () => {
  const glyphs = Object.values(BINARY).map((b) => b.glyphPlain);
  assert.equal(new Set(glyphs).size, glyphs.length, `无色字形重复：${glyphs.join(' ')}`);
  for (const g of glyphs) assert.equal(displayWidth(g), 1, `字形 ${g} 不是 1 列`);
  // 彩色下统一 •（颜色承载语义）
  const colored = new Set(Object.values(BINARY).map((b) => b.glyphColor));
  assert.equal(colored.size, 1, `彩色下应统一成一个字形，实际 ${[...colored].join(' ')}`);
});

test('视觉：blocked 用蓝色不用红色（被挡住不是坏了）', () => {
  assert.equal(BINARY.blocked.color, 'blue', `blocked 的颜色是 ${BINARY.blocked.color}`);
  assert.equal(BINARY.failed.color, 'red');
});

// ── --plain 端到端 ────────────────────────────────────────────────────

test('--plain 端到端：有判决行、检查表、逐字 needs，且无 ANSI', async () => {
  const out = new PassThrough();
  out.isTTY = false;
  let buf = '';
  out.write = (c) => { buf += String(c); return true; };
  await main({
    argv: [],
    stdout: out,
    stdin: new PassThrough(),
    env: {},
    scan: () => ({ promise: Promise.resolve({ data: sampleData(), warning: null }), cancel: () => {} }),
    claimsScan: () => ({ promise: Promise.resolve({ results: [] }), cancel: () => {} }),
  });
  assert.ok(/件在等你/.test(buf), buf.slice(0, 300));
  // 2026-11-11：不再有「检查了什么」表头。自证句保留，且必须带上「数据多新」——
  // 那是纯文本路径唯一能表达「扫描跑过、数据新鲜」的地方。
  assert.ok(/项检查都清白|其余 \d+ 项没有发现/.test(buf), buf.slice(0, 400));
  assert.ok(/数据 .*前|数据时间未知/.test(buf), `--plain 缺数据新鲜度：\n${buf.slice(0, 400)}`);
  assert.ok(buf.includes('要我现在就把用户实测单交给你'), 'needs 未逐字出现');
  assert.equal(buf.includes('\x1b'), false, '纯文本输出含 ESC');
  assert.ok(/已停 \(2\)/.test(buf), '已停在纯文本里也该是一行计数');
});

test('--plain 端到端：扫描失败时走错误分支而不是打印空屏', async () => {
  const out = new PassThrough();
  out.isTTY = false;
  let buf = '';
  out.write = (c) => { buf += String(c); return true; };
  const origWrite = process.stderr.write;
  let err = '';
  process.stderr.write = (c) => { err += String(c); return true; };
  try {
    await main({
      argv: [],
      stdout: out,
      stdin: new PassThrough(),
      env: {},
      scan: () => ({ promise: Promise.resolve({ data: null, warning: '扫描超时' }), cancel: () => {} }),
      claimsScan: () => ({ promise: Promise.resolve({ error: 'x' }), cancel: () => {} }),
    });
  } finally {
    process.stderr.write = origWrite;
    process.exitCode = 0;
  }
  assert.ok(/扫描失败/.test(err), `stderr 没说清失败：${err}`);
  assert.equal(buf, '', '失败时不该输出半截快照');
});

// ── 取数与分段 ────────────────────────────────────────────────────────

test('buildSections：三段互斥且合计等于总行数', () => {
  const s = buildSections({ data: sampleData(), nowMs: Date.now() });
  const total = s.action.length + s.running.length + s.stopped.length;
  assert.equal(total, s.all.length, '有行被漏掉或重复计入');
  assert.equal(s.action.length, 1);
  assert.equal(s.running.length, 2);
  assert.equal(s.stopped.length, 2);
});

// ── 需动作的老化（2026-11-11：33 天前的问句曾被判成需动作）─────────────

test('buildSections：超龄的需动作事实降级进已停，且 stale 列表能拿到', () => {
  const now = Date.parse('2026-11-11T00:00:00Z');
  const data = {
    sessions: [
      // 实测形态：job 7710fbdb，blocked 发生在 2026-10-08，33.1 天前
      {
        sessionId: 'hilltop', name: 'Hilltop Village优化', state: 'BLOCKED',
        idleSec: 33.1 * 86400, hasTranscript: false, source: 'job',
        needs: '要我现在就把用户实测单交给你，还是你先看这四份测试报告？',
        suggestedReply: '把实测单发给我',
      },
      { sessionId: 'fresh', name: '在等的', state: 'WAITING', idleSec: 600, hasTranscript: false },
    ],
    live: [],
  };
  const s = buildSections({ data, nowMs: now });
  assert.deepEqual(s.action.map((v) => v.key), ['fresh'], '超龄的问句仍在需动作区');
  const d = s.stopped.find((v) => v.key === 'hilltop');
  assert.ok(d, '超龄的会话从界面上消失了（用户要求所有都显示）');
  assert.equal(d.stale, true, '降级进已停的必须带 stale，否则与普通历史无法区分');
  assert.deepEqual(s.stale.map((v) => v.key), ['hilltop']);
  // 三段合计仍等于总行数：降级不是丢弃
  assert.equal(s.action.length + s.running.length + s.stopped.length, s.all.length);
});

test('超龄会话按 c 不给草稿（draftHintOf 与 buildDraft 同源）', async () => {
  const { buildDraft, draftHintOf } = await import('./oversight-tui.mjs');
  const now = Date.parse('2026-11-11T00:00:00Z');
  const hilltop = {
    state: 'BLOCKED', idleSec: 33.1 * 86400,
    needs: '要我现在就把用户实测单交给你，还是你先看这四份测试报告？',
    suggestedReply: '把实测单发给我',
  };
  assert.equal(buildDraft(hilltop, { nowMs: now }), null);
  assert.equal(draftHintOf(hilltop, { nowMs: now }).copyable, false);
});

test('claimsTally：硬与存疑分开计，不合成一个数', () => {
  const t = claimsTally([
    { status: 'FAILED_ONLY' }, { status: 'NO_EVIDENCE' },
    { status: 'STALE_ONLY' }, { status: 'UNKNOWN' }, { status: 'SUPPORTED' },
  ]);
  assert.equal(t.hard, 2);
  assert.equal(t.soft, 2);
  assert.equal(t.total, 5);
});
test('askedCountOf：「问了没答」由 transcript 侧独立判定，不靠收件箱', () => {
  // 裁决 R2 的理由：四行必须是四道独立数据源。收件箱为 0 时这一行仍可能非 0。
  const sections = {
    action: [],
    running: [{ key: 'x', meta: { question: '要我删掉旧的吗？' } }],
  };
  assert.equal(askedCountOf(sections), 1);
});

test('viewOf：标题缺失时回退到路径尾段，并标出 fallback', () => {
  const v = viewOf({ sessionId: 's', project: 'D--Projects-Overwatch', state: 'PRODUCING', cwd: 'C:/Projects/Overwatch' });
  assert.equal(v.titleFallback, true, '没有 custom-title 时必须标成回退');
  assert.equal(v.title, 'Overwatch');
  const v2 = viewOf({ sessionId: 's', state: 'PRODUCING' }, { title: '真标题', cwd: 'C:/x/y' });
  assert.equal(v2.title, '真标题');
  assert.equal(v2.titleFallback, false);
});

// ── 源码级契约（外部可见的行为无法覆盖的部分）────────────────────────

test('源码契约：主屏不再使用 INVERSE 反显表示选中', () => {
  // 规划 §1.2 + 三通道原则：反显把「颜色」和「焦点位置」绑在同一个像素上。
  // 选中现在用 `❯`（形状）+ 绿色文字，严重度仍由状态字形与颜色承担。
  assert.ok(!/\\x1b\[7m/.test(SRC), '仍存在反显转义序列');
  assert.ok(!/INVERSE\s*\+/.test(SRC), '仍在用 INVERSE 拼接');
  // reason 列从主屏删除，但详情页的高级区（L6）仍保留它 —— 那是规格允许的：
  // §2.5 把 reason 标为「删除」，指的是**列表页**不能出现（AC4 已单独断言）。
  assert.ok(!/listRow\([^)]*reason/.test(SRC), '列表行仍在画 reason');
});

test('源码契约：布局数学的单一真源在 tui-layout.mjs', () => {
  // oversight-tui 可以保留 deprecated 的 fitWidth/listRow（兼容导出），
  // 但主屏渲染路径必须经 composeListScreen —— 否则两个实现会漂移。
  assert.ok(/composeListScreen/.test(SRC), '主屏没有走 composeListScreen');
  assert.ok(/from '\.\/tui-layout\.mjs'/.test(SRC), '没有从 tui-layout 导入布局函数');
});
