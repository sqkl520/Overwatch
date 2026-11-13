#!/usr/bin/env node
/**
 * oversight-tui.test.mjs — TUI 的冒烟测试。
 *
 * 用 node --test 运行：node --test scripts/oversight-tui.test.mjs
 *
 * 存在的理由：`node --check` 只查语法，查不到「调用了一个不存在的函数」。
 * 曾把 wrapToWidth 里的 charWidth 改成 displayWidth 时只改了半处，
 * 语法检查全绿、9 条必跑命令全过，但按 ? 打开帮助就抛 ReferenceError。
 * 所以这里直接调用每个导出的渲染函数——调得通才算过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapToWidth, truncateToWidth, parseArgs, parseKeys, sanitize, buildDraft, draftHintOf, listRow, detailLines, pendingLines, viewOf } from './oversight-tui.mjs';
import { displayWidth } from './tui-theme.mjs';
import { titleOf } from './tui-layout.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── sanitize：外部来源字段必须净化 ────────────────────────────────────

test('sanitize 剥掉 OSC 52（写系统剪贴板）', () => {
  // transcript 与 jobs/*.json 里可能出现任意字节；只读渲染器不得被反向控制
  const evil = 'reason: \x1b]52;c;cHduZWQ=\x07 done';
  const out = sanitize(evil);
  assert.ok(!out.includes('\x1b'), '残留 ESC');
  assert.ok(!out.includes('\x07'), '残留 BEL');
  assert.equal(out, 'reason:  done');
});

test('sanitize 剥掉 CSI 与裸 ESC', () => {
  assert.equal(sanitize('a\x1b[2Jb'), 'ab');
  assert.equal(sanitize('a\x1bb'), 'ab');
});

test('sanitize 保留正常文本与中文', () => {
  assert.equal(sanitize('host-reported-blocked'), 'host-reported-blocked');
  assert.equal(sanitize('等待输入'), '等待输入');
  assert.equal(sanitize('a\nb'), 'a\nb', '换行应保留');
});

test('sanitize 把裸控制符替换成可见占位', () => {
  assert.equal(sanitize('a\x07b'), 'a·b');
});

test('truncateToWidth 只负责宽度，净化由调用方负责', () => {
  // 契约锁：若有人把净化内联进 truncateToWidth，这条会失败并提示契约已变。
  const raw = 'abcdef';
  assert.equal(truncateToWidth(raw, 40), 'abcdef', '短文本应原样返回');
  // 含 ANSI 时截断仍保留序列（因为宽度计算把它们算作 0 宽）
  const styled = '\x1b[31mred\x1b[0m';
  assert.ok(truncateToWidth(styled, 40).includes('\x1b['), 'ANSI 不应被 truncateToWidth 剥掉');
});


// ── wrapToWidth：所有含换行的面板都走它 ──────────────────────────────

test('wrapToWidth 处理中文，且不超宽', () => {
  const text = '这是一段很长的中文文本用来测试换行功能是否正常工作以及宽度计算是否正确';
  const lines = wrapToWidth(text, 20);
  assert.ok(lines.length > 1, '长文本应换行');
  for (const l of lines) {
    assert.ok(displayWidth(l) <= 20, `超宽 ${displayWidth(l)}: ${l}`);
  }
});

test('wrapToWidth 在空格处断英文，不劈开单词', () => {
  const src = 'this is a fairly long english sentence that should wrap';
  const words = new Set(src.split(/\s+/));
  const lines = wrapToWidth(src, 20);
  for (const l of lines) {
    assert.ok(displayWidth(l) <= 20, `超宽: ${l}`);
  }
  // 每个词必须完整出现在某一行里——若被劈开，就会有一个片段不在词表中
  for (const l of lines) {
    for (const piece of l.trim().split(/\s+/)) {
      assert.ok(words.has(piece), `疑似劈开单词: "${piece}" 来自行 "${l}"`);
    }
  }
});

test('wrapToWidth 保留原有换行符', () => {
  assert.deepEqual(wrapToWidth('a\nb', 20), ['a', 'b']);
  assert.deepEqual(wrapToWidth('', 20), ['']);
});

test('wrapToWidth 不因真实 needs 文本崩溃（曾经抛 ReferenceError）', () => {
  // 这条直接复现验收发现的崩溃路径
  const needs = 'API unavailable — retry · API Error: 503 No available channel '
    + 'for model global:deepseek under group default (request id: abc123). '
    + 'This is a server-side issue, usually temporary.';
  assert.doesNotThrow(() => wrapToWidth(needs, 80));
  const cn = '要我现在就把用户实测单交给你，还是你先看这四份测试报告？';
  assert.doesNotThrow(() => wrapToWidth(cn, 40));
  const help = '按 j/k 上下移动 · Enter 展开详情 · c 复制接力草稿 · q 退出';
  assert.doesNotThrow(() => wrapToWidth(help, 60));
});

test('wrapToWidth 宽度为 0 或负数时不死循环', () => {
  assert.doesNotThrow(() => wrapToWidth('abc', 0));
  assert.doesNotThrow(() => wrapToWidth('abc', -5));
});

// ── truncateToWidth ──────────────────────────────────────────────────

test('truncateToWidth 截断后不超宽，且带省略号', () => {
  const out = truncateToWidth('这是一段很长的中文文本', 10);
  assert.ok(displayWidth(out) <= 10, `超宽: ${displayWidth(out)}`);
  assert.ok(out.endsWith('…'));
});

test('truncateToWidth 短文本原样返回', () => {
  assert.equal(truncateToWidth('abc', 10), 'abc');
});

test('truncateToWidth max=0 返回空串', () => {
  assert.equal(truncateToWidth('abc', 0), '');
});

// ── 参数与按键解析 ───────────────────────────────────────────────────

test('parseArgs 默认 days=3、interval=8', () => {
  const a = parseArgs([]);
  assert.equal(a.days, 3);
  assert.equal(a.intervalSec, 8);
});

test('parseArgs 接受 --days 与 --interval', () => {
  const a = parseArgs(['--days', '30', '--interval', '15']);
  assert.equal(a.days, 30);
  assert.equal(a.intervalSec, 15);
});

test('parseKeys 识别 j/k/回车/q/?', () => {
  assert.deepEqual(parseKeys('j'), ['j']);
  assert.deepEqual(parseKeys('k'), ['k']);
  assert.deepEqual(parseKeys('\r'), ['enter']);
  assert.deepEqual(parseKeys('q'), ['q']);
  assert.deepEqual(parseKeys('?'), ['?']);
});

// ── 退出必须取消子进程 ────────────────────────────────────────────────

test('扫描未返回时按 q 能立即退出，并调用 cancel', async () => {
  const { PassThrough } = await import('node:stream');
  const stdin = new PassThrough();
  stdin.isTTY = true; stdin.setRawMode = () => {};
  const stdout = new PassThrough();
  stdout.columns = 100; stdout.rows = 30; stdout.isTTY = true;
  stdout.write = () => true;

  let cancelled = false;
  const slowScan = () => ({
    promise: new Promise(() => {}),          // 永不 resolve
    cancel: () => { cancelled = true; },
  });

  const { main } = await import('./oversight-tui.mjs');
  const t0 = Date.now();
  const done = main({ argv: [], stdout, stdin, env: {}, scan: slowScan });
  setTimeout(() => stdin.write('q'), 100);

  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('按 q 后 3 秒未退出')), 3000));
  await Promise.race([done, timeout]);

  assert.ok(Date.now() - t0 < 3000, `退出耗时 ${Date.now() - t0}ms`);
  assert.equal(cancelled, true, 'close() 没有调用扫描的 cancel');
});

// ── 端到端：main() 的非 TTY 分支 ──────────────────────────────────────
//
// 这两个是 r3 验收发现的阻断的根因：52 条测试没有一条覆盖 main() 的
// 非 TTY 分支，也没有一条端到端断言渲染输出不含 OSC。纯函数全绿掩盖了
// 契约变更（defaultScan 从 Promise 变成 { promise, cancel }）造成的回归。

/** 造一个符合 scan 契约的假 job。
 *
 *  **`live` 不是可选装饰，是新契约的一半。** `partitionRows` 的判据是
 *  「在跑 = 出现在宿主 live 里且有 transcript」，于是只给 `sessions` 的夹具会让
 *  一条 PRODUCING 会话掉进「已停」段——而「已停」默认压成一行计数，项目名根本不进屏。
 *  这正是 2026-11-13 那条红测的真因：不是显示逻辑坏了，是夹具还停在旧契约上。
 *  真实 `scan --json` 的 `live` 一定存在（实测 11 条），所以夹具必须给。
 */
function fakeJob(session, live = []) {
  return {
    promise: Promise.resolve({ data: { sessions: [session], live }, warning: null }),
    cancel: () => {},
  };
}

/** 宿主「此刻活着」的最小事实。缺了它，PRODUCING 会话只会进「已停」段。 */
const LIVE_BUSY = [{ sessionId: 's', status: 'busy' }];

const baseSession = {
  // **没有 cwd**：这是真实 scan 行的形状（实测 110/110 条 sessions 都没有 cwd，
  // cwd 只出现在 live 与 transcript meta 里）。项目名必须能从 project 兜底显示。
  project: 'p', sessionId: 's', state: 'PRODUCING',
  reason: 'r', needs: null, suggestedReply: null, jobDetail: null, hostState: null,
  calls: 10, novelty: 0.5, idleSec: 5, liveness: 'reconstructed',
  subagents: 0, subagentsTotal: 0, subagentsTruncated: 0, maxDepth: 0,
  hbThresholdSec: 120, lastGapSec: 5,
};

async function renderPlain(session, live = LIVE_BUSY) {
  const { PassThrough } = await import('node:stream');
  const out = new PassThrough();
  out.isTTY = false;
  let buf = '';
  out.write = (c) => { buf += String(c); return true; };
  const { main } = await import('./oversight-tui.mjs');
  await main({ argv: [], stdout: out, stdin: new PassThrough(), env: {}, scan: () => fakeJob(session, live) });
  return buf;
}

test('main() 非 TTY 分支能产出输出（曾因契约变更整段失效）', async () => {
  // 回归：defaultScan 改成 { promise, cancel } 后，main() 仍直接 await 了 job 对象，
  // data 恒为 undefined，| cat 与 --plain 全部输出「扫描失败：undefined」。
  const buf = await renderPlain({ ...baseSession });
  assert.ok(buf.length > 0, '非 TTY 分支没有任何输出');
  assert.ok(!buf.includes('扫描失败'), `非 TTY 分支报错：${buf.slice(0, 120)}`);
  // 项目名必须**真的进屏**。这条断言 2026-11-13 红过：夹具缺 live 条目，
  // 会话掉进「已停」段，而「已停」默认只画一行计数 —— 界面上确实没有项目名。
  assert.ok(buf.includes(' p '), `输出里没有项目名 p：\n${buf.slice(0, 400)}`);
});

test('main() 非 TTY 输出不含任何 ANSI 序列（含 OSC 52）', async () => {
  const E = String.fromCharCode(0x1b);
  const B = String.fromCharCode(0x07);
  const evil = E + ']52;c;eA==' + B;    // OSC 52：写系统剪贴板
  const session = {
    ...baseSession,
    project: 'p' + evil + 'x',
    sessionId: 's' + evil + 'x',
    reason: 'r' + evil,
    needs: 'n' + evil,
    suggestedReply: 'g' + evil,
    jobDetail: 'j' + evil,
    hostState: 'h' + evil,
  };
  const buf = await renderPlain(session, [{ sessionId: session.sessionId, status: 'busy' }]);
  assert.ok(!buf.includes(E), '输出里含 ESC');
  assert.ok(!buf.includes('52;c'), 'OSC 52 的正文残留（ESC 被剥但内容还在）');
  // **假绿的防线**：上面两条断言在「会话掉进折叠的已停段」时会自动成立——
  // 那一行根本不渲染 project / needs。必须证明它确实渲染了这些字段，
  // 否则这条测试只能说「没画的东西里没有 ESC」。
  // 注意用 `在跑 (`（段标题）而不是 `在跑`：判决行里也有「N 个会话在跑」。
  assert.ok(buf.includes('在跑 ('), `会话没进「在跑」段，OSC 断言是假绿：\n${buf.slice(0, 400)}`);
  assert.ok(buf.includes('px'), '项目名没进屏（净化可以删序列，但不能把正文一起删掉）');
});

test('main() 非 TTY：需动作段的 needs / 建议回复也必须净化', async () => {
  // 在跑段只画标题，needs 不出现；只测那一段就漏掉了「逐字 needs 上屏」这条路
  // （relay-protocol §5.1 要求逐字展示，也就在终端上原样执行）。
  const E = String.fromCharCode(0x1b);
  const B = String.fromCharCode(0x07);
  const evil = E + ']52;c;eA==' + B;
  const buf = await renderPlain(
    { ...baseSession, state: 'BLOCKED', needs: 'n' + evil + 'x', suggestedReply: 'g' + evil + 'x' },
    [{ sessionId: 's', status: 'blocked' }],
  );
  assert.ok(!buf.includes(E), '需动作段输出含 ESC');
  assert.ok(!buf.includes('52;c'), '需动作段输出残留 OSC 正文');
  assert.ok(buf.includes('需动作'), `会话没进需动作段，断言是假绿：\n${buf.slice(0, 400)}`);
  assert.ok(buf.includes('nx'), 'needs 没进屏');
  assert.ok(buf.includes('gx'), '建议回复没进屏');
});

test('buildDraft 净化 needs 与 suggestedReply', async () => {
  const E = String.fromCharCode(0x1b);
  const B = String.fromCharCode(0x07);
  const evil = E + ']52;c;eA==' + B;
  const d = buildDraft({ needs: 'n' + evil, suggestedReply: 's' + evil });
  assert.ok(!d.includes(E), '草稿含 ESC');
  assert.ok(!d.includes('52;c'), '草稿含 OSC 正文');
});

// ── 渲染函数直接测试（补 DF-014 的核心盲区）──────────────────────────
//
// 变异测试暴露过：把 sessionId 的 sanitize 去掉，20 条测试全绿——
// 因为 sessionId 只在详情页出现，而此前没有任何测试进入详情页。

test('detailLines 渲染全部字段，且不含任何 ESC 序列', async () => {
  const E = String.fromCharCode(0x1b);
  const B = String.fromCharCode(0x07);
  const evil = E + ']52;c;eA==' + B;
  const session = {
    project: 'proj' + evil,
    sessionId: 'sid' + evil,
    reason: 'r' + evil,
    needs: 'n' + evil,
    suggestedReply: 'g' + evil,
    jobDetail: 'j' + evil,
    hostState: 'h' + evil,
    state: 'BLOCKED', calls: 10, novelty: 0.5, noveltyAll: 0.5, idleSec: 5,
    liveness: 'reconstructed', subagents: 2, subagentsTotal: 7, subagentsTruncated: 5,
    maxDepth: 1, hbThresholdSec: 120, lastGapSec: 5, badLines: 0, tokens: 1000,
  };
  const { detailLines } = await import('./oversight-tui.mjs');
  const text = detailLines(session, 100, false).join('\n');
  assert.ok(!text.includes(E), 'detailLines 输出含 ESC');
  assert.ok(!text.includes('52;c'), 'detailLines 输出含 OSC 正文');
  // 净化不等于丢弃：可见部分必须还在
  assert.ok(text.includes('proj'), 'project 被整段丢弃');
  assert.ok(text.includes('sid'), 'sessionId 被整段丢弃');
});

test('detailLines 显示子 agent 完整比例', async () => {
  const { detailLines } = await import('./oversight-tui.mjs');
  const session = {
    ...baseSession, state: 'PRODUCING',
    subagents: 2, subagentsTotal: 7, subagentsTruncated: 5, maxDepth: 1,
  };
  const text = detailLines(session, 100, false).join('\n');
  assert.ok(/2\s*\/\s*7/.test(text), `未显示完整比例: ${text.slice(0, 200)}`);
});

test('detailLines 在 blocked 会话上显示 needs 与 suggestedReply', async () => {
  const { detailLines } = await import('./oversight-tui.mjs');
  const session = { ...baseSession, state: 'BLOCKED', needs: '要不要继续', suggestedReply: '继续' };
  const text = detailLines(session, 100, false).join('\n');
  assert.ok(text.includes('要不要继续'), 'needs 未显示');
  assert.ok(text.includes('继续'), 'suggestedReply 未显示');
});

// ── live 会话必须进列表（2026-11-01）────────────────────────────────

import { statusToState, liveToRow, mergeLiveSessions } from './oversight-tui.mjs';

test('statusToState：只认 WAITING / FAILED / BLOCKED，busy/idle 返回 null', () => {
  assert.equal(statusToState({ status: 'waiting' }), 'WAITING');
  assert.equal(statusToState({ status: 'failed' }), 'FAILED');
  assert.equal(statusToState({ status: 'blocked' }), 'BLOCKED');
  assert.equal(statusToState({ status: 'busy' }), null);
  assert.equal(statusToState({ status: 'idle' }), null);
  assert.equal(statusToState(null), null);
});

test('mergeLiveSessions：只在一半 live 里的 waiting 会话必须补进列表', () => {
  // 实测：一个 status:"waiting" 的会话在 scan 的人读输出里正确显示，
  // 但 TUI 里完全看不到——因为 TUI 只读 data.sessions，而它没有 transcript。
  // 正在等你这件事，恰恰常常发生在会话还没写多少 transcript 的时候。
  const data = {
    sessions: [{ sessionId: 'has-transcript', state: 'PRODUCING', project: 'a' }],
    live: [
      { sessionId: 'has-transcript', status: 'busy' },          // 已有，不重复补
      { sessionId: 'only-live', status: 'waiting', waitingFor: 'input needed', cwd: 'D:\P\demo' },
      { sessionId: 'just-idle', status: 'idle' },               // 不是需要处理的状态，不补
    ],
  };
  const out = mergeLiveSessions(data, Date.now());
  assert.equal(out.length, 2);
  const added = out.find((s) => s.sessionId === 'only-live');
  assert.ok(added, 'waiting 会话必须被补进来');
  assert.equal(added.state, 'WAITING');
  assert.equal(added.source, 'live');
  assert.equal(added.calls, null, '没有 transcript 时 calls 必须是 null，不是 0');
});

test('mergeLiveSessions：没有 live 数据时原样返回', () => {
  const data = { sessions: [{ sessionId: 'a', state: 'PRODUCING' }] };
  assert.equal(mergeLiveSessions(data).length, 1);
  assert.equal(mergeLiveSessions({}).length, 0);
});

test('liveToRow：路径里的控制字符被替换，不破坏终端渲染', () => {
  const row = liveToRow({
    sessionId: 's', status: 'waiting', waitingFor: 'input needed',
    cwd: 'D:Projects' + String.fromCharCode(9) + 'demo',   // 制表符，实测会破坏对齐
    statusUpdatedAt: Date.now(),
  });
  assert.ok(!/[\u0001-\u001f]/.test(row.project), `project 仍含控制字符：${JSON.stringify(row.project)}`);
});

test('viewOf：没有 cwd 时项目名照样显示，且五种外部文本全部净化', () => {
  // 这条守两件事，都是 2026-11-13 那条红测暴露出来的：
  //
  // 1. **没有 cwd 必须有兜底。** 实测 `scan --json --days 3` 的 110 条 sessions
  //    里 **110 条都没有 cwd**（cwd 只在 live 与 transcript meta 里）。若项目名
  //    依赖 cwd，真实数据里几乎每一行都会是空白。`viewOf` 的兜底链是
  //    meta.cwd → row.cwd → row.project，project 永远在。
  // 2. **列表页也要净化。** 详情页此前净化了 project / sessionId，列表页没有；
  //    两条展示路径又一次各修一半，实测 `--plain` 能把 OSC 52 放行到终端。
  const E = String.fromCharCode(0x1b);
  const B = String.fromCharCode(0x07);
  const evil = E + ']52;c;eA==' + B;

  const bare = viewOf({ project: 'proj-x', sessionId: 's', state: 'PRODUCING', idleSec: 5 }, null);
  assert.equal(bare.title, 'proj-x', '没有 cwd 时标题应回退到 project，而不是空');
  assert.equal(bare.path, '', 'project 是目录编码不是路径，不能当路径用');

  const dirty = viewOf({
    project: 'pr' + evil + 'oj', sessionId: 'si' + evil + 'd', state: 'BLOCKED', idleSec: 5,
    needs: 'ne' + evil + 'eds', suggestedReply: 're' + evil + 'ply',
    cwd: '/x/fo' + evil + 'o',
  }, { title: 'ti' + evil + 'tle', cwd: '/y/ba' + evil + 'r', lastAssistant: 'la' + evil + 'st', question: 'q' + evil });
  // 只断言**上屏字段**。`key` 是光标身份，必须保持原样以便与 `cursorKey` 逐字比较
  // （`sessionKey()` 两侧同源），它不进任何渲染路径 —— 见下面那条单独的断言。
  const shown = { ...dirty, key: undefined, row: undefined };
  for (const [k, v] of Object.entries(shown)) {
    if (typeof v !== 'string') continue;
    assert.ok(!v.includes(E), `viewOf().${k} 残留 ESC：${JSON.stringify(v)}`);
    assert.ok(!v.includes(B), `viewOf().${k} 残留 BEL：${JSON.stringify(v)}`);
  }
  for (const [k, v] of Object.entries(dirty.meta || {})) {
    assert.ok(!String(v).includes(E), `viewOf().meta.${k} 残留 ESC：${JSON.stringify(v)}`);
  }
  assert.ok(dirty.needs.includes('needs'), '净化不得把 needs 正文一起删掉');
  assert.ok(dirty.suggestedReply.includes('reply'), '净化不得把建议回复正文一起删掉');
  assert.ok(dirty.title.includes('title'), '净化不得把标题正文一起删掉');
  // title 永不为空，于是 `titleOf` 的 key 兜底分支在真实数据上不会触发。
  assert.ok(dirty.title.length > 0, 'title 不能为空，否则渲染层会退到 key');

  // 标题**整段**都是转义序列 → 净化后是空串 → 渲染层的 `titleOf` 会退到 `key` 兜底，
  // 而 key 是光标身份、故意不净化。这条钉住「净化后仍给非空标题」。
  const onlyEsc = viewOf({ project: evil, sessionId: 'si' + evil + 'd', state: 'PRODUCING', idleSec: 5 }, null);
  assert.ok(onlyEsc.title.length > 0, '标题被整段净化成空串，渲染层会退到未净化的 key');
  assert.ok(!onlyEsc.title.includes(E), `兜底标题残留 ESC：${JSON.stringify(onlyEsc.title)}`);
  const rendered = titleOf({ title: onlyEsc.title, path: onlyEsc.path, key: onlyEsc.key });
  assert.ok(!rendered.text.includes(E), `titleOf 渲染出的标题残留 ESC：${JSON.stringify(rendered.text)}`);
});

test('D1：Windows 路径必须按 `\\` 切分，项目名不能变成整条路径', () => {
  // 规划 §1.4 D1：旧实现 `base.split(/[\/]/)` 只切 `/`，于是 Windows 上的
  // `project` 变成完整路径。而最该被看见的那几类（WAITING/BLOCKED/FAILED 且无
  // transcript）恰好走这条路——它们从 live 补进来。
  const BS = String.fromCharCode(92);
  const win = `D:${BS}Server${BS}MCServers${BS}testharness`;
  const row = liveToRow({ sessionId: 's', status: 'waiting', cwd: win, statusUpdatedAt: Date.now() });
  assert.equal(row.project, 'testharness', `项目名应只是尾段，实际 ${JSON.stringify(row.project)}`);
  assert.equal(row.cwd, win, '原始 cwd 必须保留，否则同名目录无法去歧义');
  // POSIX 路径仍须正确
  assert.equal(liveToRow({ sessionId: 's', status: 'waiting', cwd: '/a/b/overwatch' }).project, 'overwatch');
});

test('D1 回归：live 行带原始 cwd，列表页才能显示 `…/尾两段` 而不是空', () => {
  const row = liveToRow({ sessionId: 's', status: 'blocked', cwd: 'C:/Users/me/src/app-x' });
  const v = viewOf(row, null);
  assert.ok(v.path.includes('app-x'), `路径列是空的：${JSON.stringify(v)}`);
});

test('mergeLiveSessions 与 App.sessions 必须同源——两条展示路径不能各写一份', () => {
  // 2026-11-01：先只改了 App.sessions()，纯文本路径仍读 data.sessions，
  // 于是同一个 waiting 会话在交互界面出现了、在 | head 输出里还是看不见。
  const src = readFileSync(join(import.meta.dirname, 'oversight-tui.mjs'), 'utf8');
  // 扣掉定义本身那一处
  const uses = (src.match(/mergeLiveSessions\(/g) || []).length - 1;
  assert.ok(uses >= 2, `App.sessions 与 printPlain 都必须调用它，实际只有 ${uses} 处`);
});

// ── 显示路径普查：每个视图都必须认得 WAITING（2026-11-01）──────

test('列表行：WAITING 有字形与标签，不是 UNKNOWN', () => {
  const out = listRow({ sessionId: 's', state: 'WAITING', project: 'p', calls: null, novelty: null, idleSec: 60 }, 120, false);
  assert.ok(out.includes('WAITING'), `列表行应显示 WAITING：${out}`);
  assert.ok(!out.includes('UNKNOWN'), `不得退化成 UNKNOWN：${out}`);
});

test('列表行：calls 未知时显示破折号，不是 0', () => {
  // calls=0 是在撒谎：可能是 0 次调用，也可能是没扫（没有 transcript）。
  const out = listRow({ sessionId: 's', state: 'WAITING', project: 'p', calls: null, novelty: null, idleSec: 60 }, 120, false);
  assert.ok(!/calls=\s*0/.test(out), `未知时不得显示 calls=0：${out}`);
  assert.ok(out.includes('—'), `应为破折号：${out}`);
});

test('详情页：liveness 与 hostState 有值时不得显示破折号', () => {
  // 2026-11-10：这两个字段按规划 §2.5 下沉到「高级区」（L6），首屏只放能改变动作的
  // 四块（状态 / 身份 / 最近说 / 证据）。按 i 展开后它们必须仍然**有值**，
  // 而不是退化成破折号 —— 下沉不等于丢失。
  const out = detailLines({
    sessionId: 's', state: 'WAITING', reason: 'waiting:input needed', project: 'p',
    liveness: 'live', hostState: 'waiting', calls: null, novelty: null, idleSec: 60,
  }, 100, false, { internals: true });
  const joined = out.join('\n');
  assert.ok(/liveness\s+live/.test(joined), `liveness 应有值：\n${joined}`);
  assert.ok(/hostState\s+waiting/.test(joined), `hostState 应有值：\n${joined}`);
});

test('详情页：超龄的会话必须说清「已超龄」与为什么没有建议回复', () => {
  // 不解释的话，用户会以为界面上少了东西——而这个缺陷的另一半正是「显示错了」。
  const now = Date.parse('2026-11-11T00:00:00Z');
  const s = {
    sessionId: 'hilltop', state: 'BLOCKED', project: 'Hilltop', idleSec: 33.1 * 86400,
    needs: '要我现在就把用户实测单交给你，还是你先看这四份测试报告？',
    suggestedReply: '把实测单发给我',
  };
  const out = detailLines(s, 100, false, { nowMs: now }).join('\n');
  assert.ok(out.includes('已超龄'), `详情页应说明超龄：\n${out}`);
  assert.ok(/33\.\d d|33\.1d/.test(out), `要说出超了多久：\n${out}`);
  assert.ok(/老化上限/.test(out), `要说出上限：\n${out}`);
  // 未超龄时不出现这段噪声
  const fresh = detailLines({ ...s, idleSec: 60 }, 100, false, { nowMs: now }).join('\n');
  assert.ok(!fresh.includes('已超龄'), `未超龄的不该有这段：\n${fresh}`);
});

test('详情页首屏不下沉字段：novelty / calls / liveness 只在按 i 之后出现', () => {
  // 规划 §2.5：L5 首屏只留能改变动作的四块。这三个字段没有一个能。
  const session = {
    sessionId: 's', state: 'PRODUCING', project: 'p', liveness: 'reconstructed',
    calls: 748, novelty: 0.92, noveltyAll: 0.94, idleSec: 60, hbThresholdSec: 900, lastGapSec: 12,
  };
  const first = detailLines(session, 100, false).join('\n');
  assert.ok(!/novelty/.test(first), `首屏不该出现 novelty：\n${first}`);
  assert.ok(!/calls/.test(first), `首屏不该出现 calls：\n${first}`);
  assert.ok(!/liveness/.test(first), `首屏不该出现 liveness：\n${first}`);
  const internals = detailLines(session, 100, false, { internals: true }).join('\n');
  assert.ok(/novelty/.test(internals) && /calls/.test(internals) && /liveness/.test(internals),
    `按 i 之后必须能看到内部量：\n${internals}`);
});

test('草稿只含可直接发送的正文，不含 needs 这类元注释', () => {
  // 2026-11-11 用户实测：按 c 复制到的是「把实测单发给我」+ 一段
  // 「（目标会话受阻，在等：…）」。第二段是**给人看的上下文**，粘进对话框
  // 就变成了一句奇怪的话。剪贴板里只能有能直接发出去的文字。
  //
  // 这条测试守的是新契约（旧契约是「needs 作为上下文附在后面」，那一版被用户否掉）。
  const w = buildDraft({ state: 'WAITING', needs: '选 A 还是 B', suggestedReply: 'A' });
  assert.equal(w, 'A', `草稿必须只有可发送的正文：${JSON.stringify(w)}`);
  // 没有 suggestedReply 时**不给草稿**：以前会把「（目标会话正在等待：…）」
  // 塞进剪贴板，那正是缺陷本身。
  assert.equal(buildDraft({ state: 'FAILED', needs: '构建报错', suggestedReply: null }), null);
  assert.equal(buildDraft({ state: 'BLOCKED', needs: '等授权', suggestedReply: null }), null);
  // needs 单独存在（连 suggestedReply 都没有）时也不给
  assert.equal(buildDraft({ needs: '选 A 还是 B' }), null);
  assert.equal(buildDraft({}), null);
  assert.equal(buildDraft(null), null);
});

test('草稿里绝不能出现「目标会话」这类旁白，也绝不能出现 needs 原文', () => {
  const needs = '要我现在就把用户实测单交给你，还是你先看这四份测试报告？';
  const d = buildDraft({ state: 'BLOCKED', needs, suggestedReply: '把实测单发给我' });
  assert.equal(d, '把实测单发给我');
  for (const bad of ['目标会话', '（', '）', '它在等', '受阻']) {
    assert.ok(!d.includes(bad), `草稿里出现了旁白片段 ${bad}：${JSON.stringify(d)}`);
  }
  assert.ok(!d.includes(needs), 'needs 原文进了剪贴板');
  // 草稿必须是单段：多段会被当成分两次发送
  assert.ok(!/\n/.test(d), `草稿不该有换行：${JSON.stringify(d)}`);
});

test('超龄的等待不给建议回复（陈年问句的 suggestedReply 是 33 天前猜的）', () => {
  const now = Date.parse('2026-11-11T00:00:00Z');
  const session = {
    state: 'BLOCKED',
    // 实测：7710fbdb 的 blocked 发生在 2026-10-08，距今 33.1 天
    idleSec: 33.1 * 86400,
    needs: '要我现在就把用户实测单交给你，还是你先看这四份测试报告？',
    suggestedReply: '把实测单发给我',
  };
  assert.equal(buildDraft(session, { nowMs: now }), null, '超龄的 suggestedReply 不该被复制出去');
  const hint = draftHintOf(session, { nowMs: now });
  assert.equal(hint.copyable, false);
  assert.ok(/没动|老化/.test(hint.reason), `必须说清为什么没有草稿：${hint.reason}`);
  // 同龄但未超龄的仍应正常给草稿（不能一刀切关掉）
  const fresh = { ...session, idleSec: 3600 };
  assert.equal(buildDraft(fresh, { nowMs: now }), '把实测单发给我');
  assert.equal(draftHintOf(fresh, { nowMs: now }).copyable, true);
});

test('draftHintOf 与 buildDraft 对「能不能复制」必须永远一致', () => {
  // 两者分家正是这次缺陷的根：界面说「c 复制回复」，按下去却复制到别的东西。
  const now = Date.parse('2026-11-11T00:00:00Z');
  const cases = [
    { state: 'BLOCKED', idleSec: 60, suggestedReply: 'A' },
    { state: 'BLOCKED', idleSec: 33 * 86400, suggestedReply: 'A' },
    { state: 'WAITING', idleSec: 2 * 86400, suggestedReply: 'B' },
    { state: 'FAILED', idleSec: 60, suggestedReply: null },
    { state: 'BLOCKED', idleSec: 60, needs: '只有 needs' },
  ];
  for (const c of cases) {
    const draft = buildDraft(c, { nowMs: now });
    const hint = draftHintOf(c, { nowMs: now });
    assert.equal(hint.copyable, draft !== null,
      `不一致：${JSON.stringify(c)} → draft=${JSON.stringify(draft)} hint=${JSON.stringify(hint)}`);
    if (draft !== null) assert.equal(hint.text, draft);
  }
});

test('帮助文本不得声称「本界面不计算任何状态」——它会从 live 补会话', () => {
  const src = readFileSync(join(import.meta.dirname, 'oversight-tui.mjs'), 'utf8');
  assert.ok(!src.includes('本界面不计算任何状态'),
    '帮助文本已过时：TUI 会从宿主实时状态补 WAITING/BLOCKED/FAILED');
  assert.ok(src.includes('宿主实时状态'), '帮助文本应说明这个补充');
});

test('详情页：liveness 必须净化——它来自外部数据，可含 ANSI', () => {
  // 上一条测试看不出差别（干净值过不过 sanitize 都一样）。
  // 这条用带 OSC 52 的值：不净化的话，只读渲染器能让终端改写剪贴板。
  const evil = 'live\x1b]52;c;cHduZWQ=\x07';
  const out = detailLines({ sessionId: 's', state: 'WAITING', project: 'p', liveness: evil, calls: null }, 100, false);
  const joined = out.join('\n');
  assert.ok(!joined.includes('\x1b'), 'liveness 残留 ESC');
  assert.ok(!joined.includes('\x07'), 'liveness 残留 BEL');
});

// ── 首次扫描的等待体验（2026-11-01）────────────────────────────────

test('pendingLines 显示真实等待秒数，不是写死的「约 10 秒」', () => {
  // 实测 33 个会话要 26 秒，而旧文案写「约 10 秒」——
  // 一个刚拿到仓库的人会等到以为卡死然后 Ctrl-C。
  const app = { now: () => 1_000_000, scanStartedAt: 1_000_000 - 26_000 };
  const out = pendingLines(app, 100).join('\n');
  assert.ok(out.includes('已等待 26s'), `应显示真实秒数：\n${out}`);
  assert.ok(!out.includes('约 10 秒'), '不得再写死旧数字');
});

test('pendingLines 明确说「不是卡死」，并给出不等它的办法', () => {
  const app = { now: () => 1_000_000, scanStartedAt: 1_000_000 - 5000 };
  const out = pendingLines(app, 100).join('\n');
  assert.ok(out.includes('不是卡死'), '要明确排除卡死的误解');
  assert.ok(out.includes('q'), '要告诉用户怎么退出');
  assert.ok(out.includes('scan-sessions.mjs'), '要给出一次性快照的退路');
});

test('pendingLines 不超过给定宽度', () => {
  const app = { now: () => 1_000_000, scanStartedAt: 1_000_000 - 5000 };
  for (const cols of [40, 60, 100]) {
    for (const l of pendingLines(app, cols)) {
      assert.ok(displayWidth(l) <= cols, `宽度 ${displayWidth(l)} 超过 ${cols}：${l}`);
    }
  }
});
