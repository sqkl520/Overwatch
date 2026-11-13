#!/usr/bin/env node
/**
 * gen-width-table.mjs — 从 Unicode 官方数据生成终端显示宽度表。
 *
 * 为什么存在：`tui-theme.mjs` 的宽度表曾经是**手抄的 20 段**，而 Unicode
 * `EastAsianWidth.txt` 里 East_Asian_Width 为 W/F 的有 **298 段**。实测
 * `⚓ ⚪ 🟡 🟢 🟣 ✅ ⚡ ⌚` 全部被量成 1 列（实际 2 列），错误率 8/10。
 * 手抄一张 298 段的表既不可能保证不漏，也没法证明它和 Unicode 版本对应。
 *
 * 所以：数据文件进仓库（`scripts/data/*.txt`，原样下载），本脚本把它们编译成
 * `scripts/width-table.mjs`。**生成的表不许手改**——`tui-theme.test.mjs` 直接
 * 读原始 UCD 文件逐码点比对，手改任何一个区间都会变红。
 *
 * 零依赖，只用 node: 内置。
 *
 * 用法：
 *   node scripts/gen-width-table.mjs                 # 重新生成 scripts/width-table.mjs
 *   node scripts/gen-width-table.mjs --check         # 只校验（表与数据一致则 exit 0）
 *   node scripts/gen-width-table.mjs --stats         # 打印统计
 *
 * 数据来源（Unicode 18.0.0）：
 *   EastAsianWidth.txt  https://www.unicode.org/Public/UCD/latest/ucd/EastAsianWidth.txt
 *   emoji-data.txt      https://www.unicode.org/Public/UCD/latest/ucd/emoji/emoji-data.txt
 *
 * 许可：Unicode 数据文件按 Unicode Terms of Use 分发，见
 *   https://www.unicode.org/terms_of_use.html
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(HERE, 'data');
export const OUT_PATH = join(HERE, 'width-table.mjs');

/**
 * 解析 UCD 风格的 `区间 ; 属性` 文本。
 *
 * 格式（两个文件一致）：`#` 之后是注释；每行两个字段，第一段可以是
 * `XXXX` 或 `XXXX..YYYY`（十六进制），第二段是属性值。
 *
 * @param {string} text
 * @returns {Array<{lo:number, hi:number, prop:string}>}
 */
export function parseUcdRanges(text) {
  const out = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const fields = line.split(';').map((f) => f.trim());
    if (fields.length < 2) continue;
    const [range, prop] = fields;
    let lo, hi;
    if (range.includes('..')) {
      const [a, b] = range.split('..');
      lo = parseInt(a, 16);
      hi = parseInt(b, 16);
    } else {
      lo = hi = parseInt(range, 16);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    out.push({ lo, hi, prop });
  }
  return out;
}

/** East_Asian_Width 为 W / F 的码点区间。未列出的码点默认 N（窄）。 */
export function parseEastAsianWidth(text) {
  return parseUcdRanges(text)
    .filter((r) => r.prop === 'W' || r.prop === 'F')
    .map(({ lo, hi }) => [lo, hi]);
}

/** Emoji_Presentation=Yes 的码点区间（默认按 emoji 呈现、占 2 列）。 */
export function parseEmojiPresentation(text) {
  return parseUcdRanges(text)
    .filter((r) => r.prop === 'Emoji_Presentation')
    .map(({ lo, hi }) => [lo, hi]);
}

/**
 * 合并相邻/重叠区间并排序。
 *
 * EastAsianWidth.txt 里 `231A..231B` 这种是单段，但也有相邻的独立段；
 * 合并后表的段数会变少，查表更快，且不影响语义。
 *
 * @param {Array<[number, number]>} ranges
 * @returns {Array<[number, number]>}
 */
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) {
      if (hi > last[1]) last[1] = hi;
    } else {
      out.push([lo, hi]);
    }
  }
  return out;
}

/** 区间覆盖的码点总数（用于统计与自检）。 */
export function countCovered(ranges) {
  let n = 0;
  for (const [lo, hi] of ranges) n += hi - lo + 1;
  return n;
}

const hex = (n) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;

/** 把区间表渲染成一行一段、每行 4 段的紧凑 JS 字面量。 */
function renderRanges(name, ranges) {
  const lines = [];
  for (let i = 0; i < ranges.length; i += 4) {
    const chunk = ranges.slice(i, i + 4).map(([lo, hi]) => `[${hex(lo)}, ${hex(hi)}]`);
    lines.push('  ' + chunk.join(', ') + (i + 4 < ranges.length ? ',' : ''));
  }
  return `export const ${name} = [\n${lines.join('\n')}\n];\n`;
}

/** 从两个数据文件的文本生成模块源码（纯函数，便于测试）。 */
export function renderModule({ eawText, emojiText }) {
  const wide = mergeRanges(parseEastAsianWidth(eawText));
  const emoji = mergeRanges(parseEmojiPresentation(emojiText));
  return [
    '// 本文件由 scripts/gen-width-table.mjs 生成，**不要手改**。',
    '// 手改会被 tui-theme.test.mjs 直接对照 Unicode 原始数据揪出来。',
    '//',
    '// 数据来源（Unicode 18.0.0）：',
    '//   scripts/data/EastAsianWidth.txt  —— East_Asian_Width = W / F',
    '//   scripts/data/emoji-data.txt      —— Emoji_Presentation = Yes',
    '// 许可：https://www.unicode.org/terms_of_use.html',
    '',
    `// East_Asian_Width ∈ {W, F}：终端占 2 列。共 ${wide.length} 段、${countCovered(wide)} 个码点。`,
    renderRanges('EAW_WIDE', wide),
    `// Emoji_Presentation=Yes：默认 emoji 呈现，占 2 列。共 ${emoji.length} 段、${countCovered(emoji)} 个码点。`,
    '// 它覆盖 EAW 未标为 W/F 的 emoji（区域指示符 U+1F1E6..U+1F1FF 就是典型）。',
    renderRanges('EMOJI_PRESENTATION', emoji),
  ].join('\n');
}

export function readData(dir = DATA_DIR) {
  return {
    eawText: readFileSync(join(dir, 'EastAsianWidth.txt'), 'utf8'),
    emojiText: readFileSync(join(dir, 'emoji-data.txt'), 'utf8'),
  };
}

/** 统计信息，供 --stats 与测试自检使用。 */
export function tableStats({ eawText, emojiText }) {
  const wide = mergeRanges(parseEastAsianWidth(eawText));
  const emoji = mergeRanges(parseEmojiPresentation(emojiText));
  const eaWide = parseEastAsianWidth(eawText);
  const ep = parseEmojiPresentation(emojiText);
  return {
    eawRanges: eaWide.length,
    eawMergedRanges: wide.length,
    eawCodePoints: countCovered(wide),
    emojiRanges: ep.length,
    emojiMergedRanges: emoji.length,
    emojiCodePoints: countCovered(emoji),
    // Emoji_Presentation 里 EAW 非 W/F 的那部分才是「补表」真正新增的覆盖
    emojiOnlyCodePoints: countEmojiOnly(wide, emoji),
  };
}

function countEmojiOnly(wide, emoji) {
  let n = 0;
  for (const [lo, hi] of emoji) {
    for (let cp = lo; cp <= hi; cp++) {
      if (!wide.some(([a, b]) => cp >= a && cp <= b)) n++;
    }
  }
  return n;
}

function main(argv) {
  const flags = new Set(argv);
  let data;
  try {
    data = readData();
  } catch (e) {
    console.error(`读不了 Unicode 数据文件：${e.message}`);
    process.exitCode = 2;
    return;
  }

  if (flags.has('--stats')) {
    console.log(JSON.stringify(tableStats(data), null, 2));
    return;
  }

  const source = renderModule(data);
  if (flags.has('--check')) {
    let current = '';
    try { current = readFileSync(OUT_PATH, 'utf8'); } catch { /* 不存在即不一致 */ }
    const same = current === source;
    console.log(same
      ? '✓ width-table.mjs 与 scripts/data 下的 Unicode 数据一致'
      : '✗ width-table.mjs 与 Unicode 数据不一致——请运行 node scripts/gen-width-table.mjs');
    process.exitCode = same ? 0 : 1;
    return;
  }

  writeFileSync(OUT_PATH, source, 'utf8');
  const s = tableStats(data);
  console.log(`✓ 已生成 ${OUT_PATH}`);
  console.log(`  EAW W/F：${s.eawRanges} 段（合并后 ${s.eawMergedRanges} 段，${s.eawCodePoints} 个码点）`);
  console.log(`  Emoji_Presentation：${s.emojiRanges} 段（合并后 ${s.emojiMergedRanges} 段，${s.emojiCodePoints} 个码点）`);
  console.log(`  其中 EAW 未覆盖、由 emoji 表补上的码点：${s.emojiOnlyCodePoints}`);
}

const isDirect = process.argv[1] && /gen-width-table\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isDirect) main(process.argv.slice(2));
