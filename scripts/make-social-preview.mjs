#!/usr/bin/env node
/**
 * make-social-preview.mjs — 生一张 1280×640 的仓库社交预览图。
 *
 * 为什么自己画：GitHub 的 social preview **没有 API**，只能人工在
 * Settings → General → Social preview 上传。而「仓库有预览图」是公开仓库的硬约束之一
 * （见 CLAUDE.md 的公开仓库条目），所以至少要让手边有一张尺寸正确的图。
 *
 * 为什么不用 canvas / sharp：本仓库**零 npm 依赖**是发布卖点，为一张图破例不值得。
 * PNG 的最小可写形态是「无压缩 deflate 块 + zlib」，Node 自带的 `zlib` 就够 ——
 * 下面 60 行是完整的 PNG 编码器，不依赖任何第三方库。
 *
 * 画的是纯色底 + 4×6 的点阵字。点阵字的理由同样是不引依赖：系统字体不可移植，
 * 而这张图的全部文字只有十来个字符，手写点阵比嵌一个字体文件诚实得多。
 *
 * 用法：node scripts/make-social-preview.mjs [--out <path>]
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const WIDTH = 1280;
const HEIGHT = 640;

// ── 颜色 ────────────────────────────────────────────────────────────

const BG_TOP = [13, 17, 28];
const BG_BOTTOM = [24, 32, 51];
const ACCENT = [56, 189, 248];
const TEXT = [237, 242, 247];
const MUTED = [148, 163, 184];

// ── 5×7 点阵字（只做这张图用得到的字符）────────────────────────────
//
// 每个字符 7 行、每行 5 位；1 画点、0 空。小写统一按大写画 —— 这张图上不放正文。

const GLYPHS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
};

/** 所有要画上去的字符串。集中在一处，才能**在画之前**核对字形是否齐全 ——
 *  第一版是边画边跳过缺失字形，结果「FINISH」被画成「INI H」而图看起来完全正常。
 *  静默降级的图形比报错的图形危险得多。 */
const STRINGS = {
  title: 'UNTILDONE',
  subtitle: 'FINISH IN ONE PASS',
  footA: 'ZERO DEPENDENCIES',
  footB: 'NODE 18.20.4',
};

function assertGlyphsCovered() {
  const missing = new Set();
  for (const s of Object.values(STRINGS)) {
    for (const ch of String(s).toUpperCase()) {
      if (!GLYPHS[ch]) missing.add(ch);
    }
  }
  if (missing.size) {
    throw new Error(`点阵字缺这些字符：${[...missing].map((c) => JSON.stringify(c)).join(', ')}`
      + ' —— 补进 GLYPHS 再画，不要静默跳过');
  }
}

/** 把字符串画到画布上。scale 是一个「点」占几个像素。 */
function drawText(px, text, x0, y0, scale, color) {
  let cx = x0;
  for (const ch of String(text).toUpperCase()) {
    const g = GLYPHS[ch];
    if (!g) { cx += scale * 6; continue; }
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (g[row][col] !== '1') continue;
        const px0 = cx + col * scale;
        const py0 = y0 + row * scale;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = px0 + dx;
            const y = py0 + dy;
            if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue;
            const i = (y * WIDTH + x) * 4;
            px[i] = color[0]; px[i + 1] = color[1]; px[i + 2] = color[2]; px[i + 3] = 255;
          }
        }
      }
    }
    cx += scale * 6;
  }
  return cx;
}

function fillRect(px, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) {
    if (y < 0 || y >= HEIGHT) continue;
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || x >= WIDTH) continue;
      const i = (y * WIDTH + x) * 4;
      px[i] = color[0]; px[i + 1] = color[1]; px[i + 2] = color[2]; px[i + 3] = 255;
    }
  }
}

// ── PNG 编码（最小实现，无第三方依赖）──────────────────────────────

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

function encodePng(px) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  // 每行前面加一个 filter 字节（0 = None）。不加这个字节的任何 PNG 都会解码失败。
  const stride = WIDTH * 4;
  const raw = Buffer.alloc((stride + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 画 ──────────────────────────────────────────────────────────────

function render() {
  const px = Buffer.alloc(WIDTH * HEIGHT * 4);

  // 竖向渐变底
  for (let y = 0; y < HEIGHT; y++) {
    const t = y / (HEIGHT - 1);
    const c = [
      Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
      Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
      Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t),
    ];
    fillRect(px, 0, y, WIDTH, 1, c);
  }

  // 左侧强调竖条
  fillRect(px, 0, 0, 10, HEIGHT, ACCENT);

  // 主标题 UNTILDONE，scale 18 → 每个字符 108px 宽、9 字符 ≈ 972px
  const titleBottom = drawTitle(px);

  // 标题下的强调下划线
  fillRect(px, 88, titleBottom + 26, 596, 6, ACCENT);

  // 一句话副标题
  const subBottom = drawText(px, STRINGS.subtitle, 88, titleBottom + 76, 6, ACCENT);

  // 底部说明
  drawText(px, STRINGS.footA, 88, HEIGHT - 118, 4, MUTED);
  drawText(px, STRINGS.footB, 88 + 6 * (STRINGS.footA.length + 1) * 4, HEIGHT - 118, 4, MUTED);

  // 右上角三道闸的示意：三个方块，代表「问清 / 拆解 / 核对」。
  // y=96 必须高于主标题的顶边（176），否则它会压在字上 —— 第一版放在 150，
  // 正好盖住标题最后两个字母，而图整体看起来仍然「像张图」。
  for (let i = 0; i < 3; i++) {
    fillRect(px, WIDTH - 250 + i * 58, 96, 42, 42, i === 2 ? ACCENT : MUTED);
  }

  void subBottom;
  return px;
}

/** 画主标题，返回它的底边 y，供下面排版用。拆出来只为让「标题多高」只有一处定义。 */
function drawTitle(px) {
  const scale = 18;
  drawText(px, STRINGS.title, 88, 176, scale, TEXT);
  return 176 + 7 * scale;
}

const outPath = (() => {
  const i = process.argv.indexOf('--out');
  const rel = i > 0 && process.argv[i + 1] ? process.argv[i + 1] : join('dist', 'social-preview.png');
  return resolve(rel);
})();

mkdirSync(dirname(outPath), { recursive: true });
assertGlyphsCovered();
const png = encodePng(render());
writeFileSync(outPath, png);
console.log(`已生成 ${WIDTH}×${HEIGHT} · ${png.length} 字节`);
console.log(outPath);
