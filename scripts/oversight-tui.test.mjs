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
import { wrapToWidth, truncateToWidth, parseArgs, parseKeys, sanitize, buildDraft } from './oversight-tui.mjs';
import { displayWidth } from './tui-theme.mjs';

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

/** 造一个符合 scan 契约的假 job */
function fakeJob(session) {
  return {
    promise: Promise.resolve({ data: { sessions: [session] }, warning: null }),
    cancel: () => {},
  };
}

const baseSession = {
  project: 'p', sessionId: 's', state: 'PRODUCING',
  reason: 'r', needs: null, suggestedReply: null, jobDetail: null, hostState: null,
  calls: 10, novelty: 0.5, idleSec: 5, liveness: 'reconstructed',
  subagents: 0, subagentsTotal: 0, subagentsTruncated: 0, maxDepth: 0,
  hbThresholdSec: 120, lastGapSec: 5,
};

async function renderPlain(session) {
  const { PassThrough } = await import('node:stream');
  const out = new PassThrough();
  out.isTTY = false;
  let buf = '';
  out.write = (c) => { buf += String(c); return true; };
  const { main } = await import('./oversight-tui.mjs');
  await main({ argv: [], stdout: out, stdin: new PassThrough(), env: {}, scan: () => fakeJob(session) });
  return buf;
}

test('main() 非 TTY 分支能产出输出（曾因契约变更整段失效）', async () => {
  // 回归：defaultScan 改成 { promise, cancel } 后，main() 仍直接 await 了 job 对象，
  // data 恒为 undefined，| cat 与 --plain 全部输出「扫描失败：undefined」。
  const buf = await renderPlain({ ...baseSession });
  assert.ok(buf.length > 0, '非 TTY 分支没有任何输出');
  assert.ok(!buf.includes('扫描失败'), `非 TTY 分支报错：${buf.slice(0, 120)}`);
  assert.ok(buf.includes('p'), '输出里没有项目名');
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
  const buf = await renderPlain(session);
  assert.ok(!buf.includes(E), '输出里含 ESC');
  assert.ok(!buf.includes('52;c'), 'OSC 52 的正文残留（ESC 被剥但内容还在）');
});

test('buildDraft 净化 needs 与 suggestedReply', async () => {
  const E = String.fromCharCode(0x1b);
  const B = String.fromCharCode(0x07);
  const evil = E + ']52;c;eA==' + B;
  const d = buildDraft({ needs: 'n' + evil, suggestedReply: 's' + evil });
  assert.ok(!d.includes(E), '草稿含 ESC');
  assert.ok(!d.includes('52;c'), '草稿含 OSC 正文');
});
