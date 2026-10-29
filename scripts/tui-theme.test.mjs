#!/usr/bin/env node
/**
 * tui-theme.test.mjs — TUI 视觉语言的回归测试。
 *
 * 用 node --test 运行：node --test scripts/tui-theme.test.mjs
 *
 * 锁住的是 docs/spec/tui-visual.md 的约定。如果某条红了，
 * 先确认是代码错了还是规格该改——不要为了变绿而放宽断言。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { STATES, displayWidth, padDisplay, paint, colorEnabled } from './tui-theme.mjs';

// ── 字形与颜色的单一真源 ──────────────────────────────────────────────

test('五个状态都有字形、颜色、标签', () => {
  for (const [name, s] of Object.entries(STATES)) {
    assert.ok(s.glyph, `${name} 缺字形`);
    assert.ok(s.color, `${name} 缺颜色`);
    assert.ok(s.label, `${name} 缺标签`);
    assert.ok(s.meaning, `${name} 缺含义说明`);
  }
});

test('字形必须互不相同（灰度下靠形状区分）', () => {
  const glyphs = Object.values(STATES).map((s) => s.glyph);
  assert.equal(new Set(glyphs).size, glyphs.length, `字形重复：${glyphs.join(' ')}`);
});

test('字形显示宽度必须是 1 列（否则列表会错位）', () => {
  for (const [name, s] of Object.entries(STATES)) {
    assert.equal(displayWidth(s.glyph), 1, `${name} 的字形 ${s.glyph} 宽度不是 1`);
  }
});

test('不得使用在 conhost 等宽字体中缺失的码位', () => {
  // ✕ U+2715 与 ◐ U+25D0 在 Consolas / Lucida Console / Cascadia 系列里都没有覆盖，
  // 实测渲染成方块。这两个曾被误用为 FAILED 与 STALLED 的字形。
  const BAD = new Set(['✕', '◐']);
  for (const [name, s] of Object.entries(STATES)) {
    assert.ok(!BAD.has(s.glyph), `${name} 使用了已知缺字的码位 ${s.glyph}`);
  }
});

// ── 颜色开关 ──────────────────────────────────────────────────────────

test('非 TTY 关闭颜色', () => {
  assert.equal(colorEnabled({ isTTY: false }), false);
});

test('TERM=dumb 关闭颜色', () => {
  const prev = process.env.TERM;
  process.env.TERM = 'dumb';
  try {
    assert.equal(colorEnabled({ isTTY: true }), false);
  } finally {
    if (prev === undefined) delete process.env.TERM; else process.env.TERM = prev;
  }
});

test('关闭颜色时 paint 原样返回，不注入 ESC', () => {
  const out = paint('hello', 'red', false);
  assert.equal(out, 'hello');
  assert.ok(!out.includes('\x1b'));
});

// ── 显示宽度 ──────────────────────────────────────────────────────────

test('显示宽度：ASCII / CJK / 混排 / 空串 / 全角 / emoji', () => {
  const cases = [
    ['abc', 3],
    ['中文', 4],
    ['中a文b', 6],
    ['', 0],
    ['（全角）', 8],
    ['🎉', 2],
  ];
  for (const [s, want] of cases) {
    assert.equal(displayWidth(s), want, JSON.stringify(s));
  }
});

test('padDisplay 补到目标宽度，且不超出', () => {
  for (const width of [0, 5, 10, 20]) {
    const padded = padDisplay('中文abc', width);
    assert.ok(displayWidth(padded) <= width + 1, `width=${width} 时溢出`);
  }
});
