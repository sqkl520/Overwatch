#!/usr/bin/env node
/**
 * probe-parser-divergence.test.mjs — 守「重放器与闸门是同一个解析器」这条不变量。
 *
 * 这个探针存在的理由本身就是一个缺陷：闸门与重放器曾是两份独立实现，
 * 闸门改宽后重放不会跟着变，于是「改宽后降到 4%」这种数无法复算。
 *
 * 所以测试分两层：
 *   ① `diffOf` 等纯函数的正确性（差集形状、归一化）；
 *   ② 探针在小目录上跑出 0 分叉 —— 真说了「等价」才算数。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  diffOf, gatePathsOfText, syntheticCases, probe, formatProbe,
} from './probe-parser-divergence.mjs';

const line = (name, input) => JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now()).toISOString(), message: { content: [{ type: 'tool_use', name, input }] } });

const writeTranscript = (dir, slug, id, recs) => {
  mkdirSync(join(dir, slug), { recursive: true });
  const p = join(dir, slug, `${id}.jsonl`);
  writeFileSync(p, recs.join('\n') + '\n');
  return p;
};

const box = () => {
  const d = mkdtempSync(join(tmpdir(), 'ow-div-'));
  return { dir: d, clean: () => rmSync(d, { recursive: true, force: true }) };
};

// ── ① diffOf ──────────────────────────────────────────────────────────

test('diffOf 认出两侧等价，且按 pathKeyOf 归一（大小写/斜杠不算分歧）', { skip: process.platform !== 'win32' }, () => {
  // 大小写折叠**只在 win32 发生**（见 `pre-write-gate.mjs` 的 `pathKeyOf`）。
  // Linux 上 `A.mjs` 与 `a.mjs` 是两个文件，折叠会把它们混成一个 —— 所以这条
  // 「归一」断言是 Windows 语义，非 win32 上不成立，也不该成立。
  const d = diffOf(['C:\\A\\B.mjs'], ['c:/a/b.mjs']);
  assert.equal(d.diverged, false);
  assert.equal(d.gateCount, 1);
  assert.equal(d.replayCount, 1);
});

test('diffOf 在非 win32 上不折叠大小写——那是两个不同文件', { skip: process.platform === 'win32' }, () => {
  const d = diffOf(['/a/B.mjs'], ['/a/b.mjs']);
  assert.equal(d.diverged, true, 'Linux 上大小写不同 = 不同文件，必须报分歧');
});

test('diffOf 分别报出两侧独有项，不把差集混成一个数', () => {
  const d = diffOf(['/a', '/b'], ['/b', '/c']);
  assert.equal(d.diverged, true);
  assert.deepEqual(d.gateOnly, ['/a']);
  assert.deepEqual(d.replayOnly, ['/c']);
});

test('diffOf 在计数相同但集合不同时仍判为分叉', () => {
  const d = diffOf(['/a', '/b'], ['/a', '/z']);
  assert.equal(d.gateCount, d.replayCount);
  assert.equal(d.diverged, true, '只看长度会漏掉这一类');
});

// ── ② 合成用例：已知差异点必须被真正比较到 ────────────────────────────

test('syntheticCases 覆盖已知差异点，且每条都走两种口径', () => {
  const b = box();
  try {
    const cases = syntheticCases(b.dir);
    assert.ok(cases.length >= 5);
    for (const c of cases) {
      assert.equal(typeof c.textSame.diverged, 'boolean', `${c.id} 缺同文本口径`);
      assert.equal(typeof c.fileSame.diverged, 'boolean', `${c.id} 缺同文件口径`);
    }
    const ids = cases.map((c) => c.id);
    assert.ok(ids.includes('first-line-within-window'), '首行该不该丢是最贵的一处差异');
    assert.ok(ids.includes('known-option-value-bug'), '已知缺陷必须被探针覆盖');
  } finally { b.clean(); }
});

test('gatePathsOfText 把整段文本交给闸门，不因窗口丢首行', () => {
  const b = box();
  try {
    const text = line('Read', { file_path: '/repo/first.mjs' }) + '\n' + line('Read', { file_path: '/repo/second.mjs' }) + '\n';
    const r = gatePathsOfText(text, b.dir);
    assert.deepEqual(r.paths, ['/repo/first.mjs', '/repo/second.mjs']);
    assert.equal(r.truncatedFirst, false);
  } finally { b.clean(); }
});

// ── ③ 端到端：小目录上必须报 0 分叉 ───────────────────────────────────

test('probe 在小语料上报 0 分叉 —— 「等价」必须由跑出来支撑', () => {
  const b = box();
  try {
    writeTranscript(b.dir, 'D--Projects-A', 's1', [
      line('Read', { file_path: '/a/a.mjs' }),
      line('Bash', { command: 'cat /a/b.md' }),
      line('Bash', { command: 'head -n 20 /a/c.mjs' }),
      line('Write', { file_path: '/a/out.txt' }),
    ]);
    const r = probe(b.dir, { order: 'time' });
    assert.equal(r.totals.probed, 1, '必须真的探到一个会话');
    assert.equal(r.totals.diverged, 0, `解析器口径不应分叉：${JSON.stringify(r.examples)}`);
    assert.equal(r.totals.fileDiverged, 0, `端到端口径不应分叉：${JSON.stringify(r.examples)}`);
    assert.equal(r.totals.syntheticDiverged, 0, '合成用例不应分叉');
  } finally { b.clean(); }
});

test('probe 跳过没有写的会话与沙箱会话', () => {
  const b = box();
  try {
    writeTranscript(b.dir, 'D--Projects-A', 'nowrite', [line('Read', { file_path: '/a/a.mjs' })]);
    writeTranscript(b.dir, 'C--Users-Administrator-AppData-Local-Temp-x', 'sandbox', [
      line('Write', { file_path: '/t/out.txt' }),
    ]);
    const r = probe(b.dir, { order: 'time' });
    assert.equal(r.totals.withFirstWrite, 0);
    assert.equal(r.totals.diverged, 0);
  } finally { b.clean(); }
});

test('formatProbe 把三项分叉率都写出来，不只报一个数', () => {
  const r = {
    root: '/x', order: 'time', threshold: 3, windowBytes: 1024 * 1024,
    totals: {
      transcripts: 1, withFirstWrite: 1, probed: 1, skipped: 0,
      diverged: 0, divergedRate: 0, fileDiverged: 0, fileDivergedRate: 0,
      pathLevelGateOnly: 0, pathLevelReplayOnly: 0, denyVerdictFlips: 0,
      synthetic: 5, syntheticDiverged: 0,
    },
    synthetic: [], examples: [], rows: [],
  };
  const s = formatProbe(r);
  assert.ok(s.includes('解析器口径'));
  assert.ok(s.includes('端到端口径'));
  assert.ok(s.includes('合成用例'));
});
