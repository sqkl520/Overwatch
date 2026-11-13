#!/usr/bin/env node
/**
 * probe-parser-divergence.mjs — 量化两份「transcript 读路径解析器」的分叉。
 *
 * ── 为什么需要这个探针 ────────────────────────────────────────────
 *
 * 闸门（`pre-write-gate.mjs` 的 `readTranscriptReads`）与重放器
 * （`observe-reality-check.mjs` 的 `gateReadPathsInText` / `gateReadsOf`）
 * 曾经是**两份独立实现**，注释里写「同构」——但同构是声称，不是保证。
 * 一旦闸门的读动词表改了（例如加 `ls`），重放不会跟着变，报告上的百分比
 * 就会变成一句无法复算的话。
 *
 * 本探针只做一件事：**对同一段文本，把两份解析器的结果逐条对比**。
 * 它给数字，不给判断。
 *
 * ── 口径：怎么做到「同一段文本」 ──────────────────────────────────
 *
 * 闸门的函数是 I/O 的（读文件尾部）；重放器 `tailGateReads` 也是。所以两种对照都做：
 *
 *   A. **同文本对照**（纯解析器）：把窗口文本写进临时文件，用 `bytes = 字节长度 + 1`
 *      调 `readTranscriptReads` —— 窗口装得下整段，解析的就是整段文本。再把这**同一段
 *      文本**交给重放器的 `readPathsInTranscriptText`。差异只可能来自解析逻辑。
 *
 *   B. **同文件对照**（端到端）：真实文件 + 真实窗口，两侧各自从盘上读。
 *      这一项能抓到「解析器等价、但窗口语义不等价」——首行该不该丢就是一例。
 *
 * 窗口：`[首写偏移 - 1MB, 首写偏移)`，与 `observe-reality-check.mjs` 的
 * `tailGateReads` 相同。
 *
 * 用法：
 *   node scripts/probe-parser-divergence.mjs            # 人类可读摘要
 *   node scripts/probe-parser-divergence.mjs --json     # 机器可读
 *   node scripts/probe-parser-divergence.mjs --root <dir> --limit 50 --details 20
 *
 * 退出码：0 两侧等价（差集为空）；1 存在分叉；2 没有可探会话。
 * 只读语料；唯一写入是系统临时目录里的一次性文件。
 */

import { mkdtempSync, writeFileSync, rmSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readTranscriptReads, pathKeyOf } from './pre-write-gate.mjs';
import {
  defaultRoot, listTranscripts, isSandbox, analyzeOne,
  gateReadPathsInText, gateReadsOf, tailGateReads,
} from './observe-reality-check.mjs';

const WINDOW = 1024 * 1024;

/** 把一段文本当成 transcript 文件喂给闸门，拿它的解析结果。 */
export function gatePathsOfText(text, tmpDir) {
  const body = String(text || '');
  const p = join(tmpDir, `probe-${process.hrtime.bigint()}.jsonl`);
  writeFileSync(p, body);
  try {
    // +1 字节：让闸门认为「窗口比文件大」，于是不丢首行、解析整段文本。
    const r = readTranscriptReads(p, { bytes: Buffer.byteLength(body, 'utf8') + 1 });
    return { paths: r.paths, truncatedFirst: r.truncatedFirst, unparsable: r.unparsable };
  } finally {
    try { rmSync(p, { force: true }); } catch { /* ignore */ }
  }
}

/** 取 [end-window, end) 的文本。与 `tailGateReads` 的切入点相同。 */
export function windowTextOf(path, endBytes, windowBytes = WINDOW) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const end = Math.min(size, Math.max(0, endBytes));
    const want = Math.max(0, Math.min(end, windowBytes));
    if (!want) return '';
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, end - want + got);
      if (n <= 0) break;
      got += n;
    }
    return (got === want ? buf : buf.subarray(0, got)).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 比较两侧结果。按 pathKeyOf 归一再比；原始值随差集带出，便于看形状。 */
export function diffOf(gatePaths, replayPaths) {
  const gk = new Map(); // key -> raw
  for (const p of gatePaths) gk.set(pathKeyOf(p), p);
  const rk = new Map();
  for (const p of replayPaths) rk.set(pathKeyOf(p), p);
  const gateOnly = [];
  const replayOnly = [];
  for (const [k, v] of gk) if (!rk.has(k)) gateOnly.push(v);
  for (const [k, v] of rk) if (!gk.has(k)) replayOnly.push(v);
  return {
    gateCount: gk.size,
    replayCount: rk.size,
    gateOnly,
    replayOnly,
    diverged: gk.size !== rk.size || gateOnly.length > 0 || replayOnly.length > 0,
  };
}

/** 对分歧会话，定位是**哪几条 tool_use** 造成差集（只跑分歧会话，成本可控）。 */
export function attributeDivergence(text, d, tmpDir) {
  if (!d.diverged) return [];
  const wantGate = new Set(d.gateOnly.map(pathKeyOf));
  const wantReplay = new Set(d.replayOnly.map(pathKeyOf));
  const out = [];
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let rec;
    try { rec = JSON.parse(s); } catch { continue; }
    const content = rec && rec.message && Array.isArray(rec.message.content) ? rec.message.content : null;
    if (!content) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      const name = String(b.name || '');
      const inp = b.input && typeof b.input === 'object' ? b.input : {};
      const g = gatePathsOfText(JSON.stringify(rec), tmpDir).paths;
      const r = gateReadsOf(name, inp);
      const dd = diffOf(g, r);
      if (dd.diverged || dd.gateOnly.some((x) => wantGate.has(pathKeyOf(x)))
        || dd.replayOnly.some((x) => wantReplay.has(pathKeyOf(x)))) {
        out.push({
          tool: name,
          command: typeof inp.command === 'string' ? inp.command.slice(0, 120) : String(inp.file_path || ''),
          gate: dd.diverged ? g : [],
          replay: r,
        });
        if (out.length >= 6) return out;
      }
    }
  }
  return out;
}

/** 合成用例：真实语料是有限样本，「等价」不能只靠它。
 *
 *  这几条专门覆盖**两份实现曾经真的不同**的地方（2026-11-14 实测确认）：
 *    ① 窗口比文件大时的首行 —— 闸门保留，旧重放器丢掉（少算）；
 *    ② `file_path` 只有空白 —— 闸门不计数，旧重放器数成一个路径；
 *    ③ 路径两端带空格 —— 闸门 trim，旧重放器不 trim。
 *  每条都同时报「同文本」与「同文件窗口」两种口径，后者能抓窗口语义。 */
export function syntheticCases(tmpDir) {
  const line = (name, input) => JSON.stringify({ message: { content: [{ type: 'tool_use', name, input }] } });
  const cases = [
    { id: 'first-line-within-window', recs: [line('Read', { file_path: '/repo/first.mjs' }), line('Read', { file_path: '/repo/second.mjs' })] },
    { id: 'blank-file-path', recs: [line('Read', { file_path: '   ' }), line('Read', { file_path: '/repo/real.mjs' })] },
    { id: 'padded-file-path', recs: [line('Read', { file_path: '  /repo/padded.mjs  ' })] },
    { id: 'known-option-value-bug', recs: [line('Bash', { command: 'head -n 20 a.mjs' }), line('Bash', { command: 'tail -c 512 x.log' })] },
    { id: 'blank-command', recs: [line('Bash', { command: '' }), line('Bash', { command: 'cat /repo/ok.mjs' })] },
  ];
  const out = [];
  for (const c of cases) {
    const text = c.recs.join('\n') + '\n';
    // A. 同文本
    const g = gatePathsOfText(text, tmpDir).paths;
    const r = gateReadPathsInText(text);
    // B. 同文件 + 真实窗口。这些小文件都远小于 1MB，所以窗口从文件头开始、
    //    首行完整 —— 这正是旧重放器丢掉一条完整记录的那种情形。
    const p = join(tmpDir, `syn-${c.id}.jsonl`);
    writeFileSync(p, text);
    const size = Buffer.byteLength(text);
    const gFile = readTranscriptReads(p, { bytes: size + 1 }).paths;
    const rFile = tailGateReads(p, size);
    try { rmSync(p, { force: true }); } catch { /* ignore */ }
    out.push({
      id: c.id,
      textSame: diffOf(g, r),
      fileSame: diffOf(gFile, rFile),
    });
  }
  return out;
}

/** 逐会话跑一遍。`limit` 限制会话数（语料可增长），`details` 限制样本数。 */
export function probe(root = defaultRoot(), { order = 'time', limit = 0, details = 10, threshold = 3 } = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ow-probe-'));
  const metas = listTranscripts(root);
  const sessions = [];
  let skipped = 0;
  try {
    for (const m of metas) {
      let a;
      try { a = analyzeOne(m, { order }); } catch { skipped++; continue; }
      if (isSandbox(a) || !a.firstWrite) continue;
      sessions.push(a);
    }
    const picked = limit > 0 ? sessions.slice(0, limit) : sessions;

    const rows = [];
    let diverged = 0;
    let fileDiverged = 0;
    let pathLevelGateOnly = 0;
    let pathLevelReplayOnly = 0;
    const examples = [];

    for (const s of picked) {
      // A. 同文本对照（只比解析器）
      const text = windowTextOf(s.path, s.firstWrite.off);
      const gate = gatePathsOfText(text, tmpDir);
      const replay = gateReadPathsInText(text);
      const d = diffOf(gate.paths, replay);
      if (d.diverged) {
        diverged++;
        pathLevelGateOnly += d.gateOnly.length;
        pathLevelReplayOnly += d.replayOnly.length;
        if (examples.length < details) {
          examples.push({
            kind: 'text', sessionId: s.sessionId.slice(0, 8), cwd: s.cwd,
            gateCount: d.gateCount, replayCount: d.replayCount,
            gateOnly: d.gateOnly.slice(0, 8), replayOnly: d.replayOnly.slice(0, 8),
            attribution: attributeDivergence(text, d, tmpDir),
          });
        }
      }
      // B. 同文件对照（连窗口语义一起比）：闸门用 1MB 尾部，重放器用 [首写-1MB, 首写)
      const p = join(tmpDir, `file-${s.sessionId.slice(0, 8)}.jsonl`);
      writeFileSync(p, text);
      const gFile = readTranscriptReads(p, { bytes: 1024 * 1024 }).paths;
      const rFile = tailGateReads(s.path, s.firstWrite.off);
      const fd = diffOf(gFile, rFile);
      try { rmSync(p, { force: true }); } catch { /* ignore */ }
      if (fd.diverged) {
        fileDiverged++;
        if (examples.length < details) {
          examples.push({
            kind: 'file', sessionId: s.sessionId.slice(0, 8), cwd: s.cwd,
            gateCount: fd.gateCount, replayCount: fd.replayCount,
            gateOnly: fd.gateOnly.slice(0, 8), replayOnly: fd.replayOnly.slice(0, 8),
          });
        }
      }

      rows.push({
        sessionId: s.sessionId.slice(0, 8), cwd: s.cwd, bytes: s.bytes,
        gateCount: d.gateCount, replayCount: d.replayCount, diverged: d.diverged,
        fileDiverged: fd.diverged,
        gateReadsWindow: s.readPathsWindow.length,
        gateDeny: d.gateCount < threshold, replayDeny: replay.length < threshold,
      });
    }

    const syn = syntheticCases(tmpDir);
    const synBad = syn.filter((x) => x.textSame.diverged || x.fileSame.diverged);

    return {
      root, order, threshold, windowBytes: WINDOW,
      totals: {
        transcripts: metas.length, withFirstWrite: sessions.length,
        probed: picked.length, skipped,
        diverged, divergedRate: picked.length ? diverged / picked.length : null,
        fileDiverged, fileDivergedRate: picked.length ? fileDiverged / picked.length : null,
        pathLevelGateOnly, pathLevelReplayOnly,
        denyVerdictFlips: rows.filter((r) => r.gateDeny !== r.replayDeny).length,
        synthetic: syn.length, syntheticDiverged: synBad.length,
      },
      synthetic: syn,
      examples,
      rows,
    };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function formatProbe(r) {
  const p = (x) => (x == null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
  const L = [];
  L.push(`写前闸 · 解析器分叉探针（窗口 ${r.windowBytes} 字节，首写口径=${r.order}，threshold=${r.threshold}）`);
  L.push(`根目录 ${r.root}`);
  L.push(`transcript ${r.totals.transcripts} · 有首写且非沙箱 ${r.totals.withFirstWrite} · 实探 ${r.totals.probed} · 跳过 ${r.totals.skipped}`);
  L.push('');
  L.push(`分叉会话（解析器口径，同文本）：${r.totals.diverged} / ${r.totals.probed} = ${p(r.totals.divergedRate)}`);
  L.push(`分叉会话（端到端口径，同文件+同窗口）：${r.totals.fileDiverged} / ${r.totals.probed} = ${p(r.totals.fileDivergedRate)}`);
  L.push(`差集规模：闸门多算 ${r.totals.pathLevelGateOnly} 条路径，闸门少算 ${r.totals.pathLevelReplayOnly} 条路径（跨全部会话累加）`);
  L.push(`判定翻转：${r.totals.denyVerdictFlips} 个会话的 would-deny 结论会因分叉而不同`);
  L.push(`合成用例（覆盖已知差异点）：${r.totals.syntheticDiverged} / ${r.totals.synthetic} 分叉`);
  for (const s of r.synthetic || []) {
    const mark = (s.textSame.diverged || s.fileSame.diverged) ? '✗' : '✓';
    L.push(`  ${mark} ${s.id}  同文本 gate ${s.textSame.gateCount}/replay ${s.textSame.replayCount}  同文件 gate ${s.fileSame.gateCount}/replay ${s.fileSame.replayCount}`);
    if (s.textSame.gateOnly.length) L.push(`      闸门多算 ${JSON.stringify(s.textSame.gateOnly.slice(0, 4))}  闸门少算 ${JSON.stringify(s.textSame.replayOnly.slice(0, 4))}`);
  }
  if (r.examples.length) {
    L.push('', '分叉样本：');
    for (const e of r.examples) {
      L.push(`  ${e.sessionId}  gate ${e.gateCount} / replay ${e.replayCount}  ${e.cwd || ''}`);
      if (e.gateOnly.length) L.push(`    闸门多算：${JSON.stringify(e.gateOnly.slice(0, 5))}`);
      if (e.replayOnly.length) L.push(`    闸门少算：${JSON.stringify(e.replayOnly.slice(0, 5))}`);
      for (const a of e.attribution) {
        L.push(`    · ${a.tool} ${JSON.stringify(a.command)} gate=${JSON.stringify(a.gate.slice(0, 4))} replay=${JSON.stringify(a.replay.slice(0, 4))}`);
      }
    }
  }
  return L.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const root = argOf('--root', defaultRoot());
  const r = probe(root, {
    order: argOf('--order', 'time'),
    limit: Number(argOf('--limit', '0')) || 0,
    details: Number(argOf('--details', '10')) || 10,
    threshold: Number(argOf('--threshold', '3')) || 3,
  });
  if (!r.totals.probed) {
    process.stderr.write(`没有可探的会话（根目录 ${root}）。\n`);
    return 2;
  }
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write(formatProbe(r) + '\n');
  return (r.totals.diverged === 0 && r.totals.fileDiverged === 0 && r.totals.syntheticDiverged === 0) ? 0 : 1;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')?.replace(/^\//, '')}`) {
  process.exit(main());
}
