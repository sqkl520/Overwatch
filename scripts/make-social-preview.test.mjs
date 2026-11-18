#!/usr/bin/env node
/**
 * make-social-preview.test.mjs — 社交预览图的生成器必须是**可验证**的。
 *
 * 为什么值得为一张图写测试：这张图是手写的 PNG 编码器（无第三方依赖），而
 * 「自己编码二进制」的失败模式是**产出一个看起来正常、实际打不开的文件**。
 * 实测已经踩过两次，且都不是编码错误：
 *
 *   1. 第一版少了 F / S / P / Z / 8 / 4 六个字形，`drawText` 静默跳过 →
 *      「FINISH」被画成「INI H」，而图整体构图看着完全正常。
 *   2. 角落的方块 y=150 压在标题上，盖住最后两个字母。
 *
 * 两条都是**画面内容错**，md5 变了但没有任何断言会响。所以这里验的是结构性质：
 * 尺寸、PNG 块链、以及「字形表覆盖了所有要画的字符」——最后这条现在是生成器
 * 自己的前置断言，测试再独立核一遍（同一判据两处，故意如此：改坏一处仍有一处响）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = import.meta.dirname;
const GEN = join(HERE, 'make-social-preview.mjs');

/** 生成到临时目录并读回来。不写仓库里的 `docs/assets/` —— 测试不该改可发布区。 */
function generate() {
  const dir = mkdtempSync(join(tmpdir(), 'ow-social-'));
  const out = join(dir, 'preview.png');
  const r = spawnSync(process.execPath, [GEN, '--out', out], { encoding: 'utf8', timeout: 30000 });
  const buf = existsSync(out) ? readFileSync(out) : null;
  return { dir, out, r, buf };
}

/** 走一遍 PNG 块链：每块长度必须自洽，末尾必须正好停在 IEND。 */
function walkChunks(buf) {
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    chunks.push({ type, len });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return { chunks, end: off };
}

test('生成器退出码 0 且产出 1280×640 的 RGBA PNG', () => {
  const { dir, r, buf } = generate();
  try {
    assert.equal(r.status, 0, `生成器失败：${r.stderr || r.stdout}`);
    assert.ok(buf && buf.length > 0, '没有产出文件');

    assert.equal(buf.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 签名不对');
    assert.equal(buf.readUInt32BE(16), 1280, '宽度必须是 1280');
    assert.equal(buf.readUInt32BE(20), 640, '高度必须是 640');
    assert.equal(buf[24], 8, '位深应为 8');
    assert.equal(buf[25], 6, '颜色类型应为 6（RGBA）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PNG 块链完整：IHDR 打头、IDAT 在后、IEND 收尾且长度自洽', () => {
  const { dir, buf } = generate();
  try {
    const { chunks, end } = walkChunks(buf);
    assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
    assert.equal(chunks[0].len, 13, 'IHDR 必须是 13 字节');
    assert.ok(chunks[1].len > 0, 'IDAT 不能为空');
    assert.equal(end, buf.length, '块链末尾必须正好是文件末尾（长度字段写错会在这里露出来）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('要画的每个字符都有字形 —— 缺一个就报错，不静默跳过', () => {
  // 负向验证的思路：把生成器源码里的字形表挖掉一个，确认它**报错而不是画出来**。
  // 直接改源码不可接受（测试不该编辑源码），所以这里验的是**前置断言真的在前置**：
  // 生成器必须先校验、再渲染 —— 用一个含未知字符的临时副本触发它。
  const { dir, buf } = generate();
  rmSync(dir, { recursive: true, force: true });
  assert.ok(buf, '正常路径要能出图');

  const src = readFileSync(GEN, 'utf8');
  const probe = src
    .replace("subtitle: 'FINISH IN ONE PASS'", "subtitle: 'FINISH IN ONE PASS @'")
    .replace("const GEN = join(HERE, 'make-social-preview.mjs');", '');
  assert.notEqual(probe, src, '探针没能改动源码 —— 断言的锚点失效了，这条测试是假的');

  const dir2 = mkdtempSync(join(tmpdir(), 'ow-social-neg-'));
  const probePath = join(dir2, 'probe.mjs');
  const out2 = join(dir2, 'x.png');
  try {
    // 写探针副本时必须改掉它 import 的相对路径假设：它本来是独立脚本，所以可直接跑。
    const { writeFileSync } = process.getBuiltinModule('node:fs');
    writeFileSync(probePath, probe);
    const r2 = spawnSync(process.execPath, [probePath, '--out', out2], { encoding: 'utf8', timeout: 30000 });
    assert.notEqual(r2.status, 0, '遇到没有字形的字符时必须非零退出');
    assert.match(String(r2.stderr || ''), /点阵字缺这些字符/, '错误信息要说清缺哪个字符');
    assert.ok(!existsSync(out2), '报错时不应该留下半成品的图');
  } finally { rmSync(dir2, { recursive: true, force: true }); }
});
