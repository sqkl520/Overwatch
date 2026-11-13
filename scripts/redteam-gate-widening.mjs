#!/usr/bin/env node
/**
 * redteam-gate-widening.mjs — 红队量化：闸门「改宽」后，原来的 27 个被拦会话还剩几个拦。
 *
 * 只读。复用 `observe-reality-check.mjs` 的 `analyzeOne()` / `attribute()` / `gateReadsOf()`
 * / `broadReadsOf()` 与 `pre-write-gate.mjs` 的 `pathKeyOf()`。不碰那两个文件。
 *
 * ── 四个「改宽」维度，逐条可开关 ────────────────────────────────────
 *
 *   D  解析缺陷修复：`head -n 20 a.mjs` 里的 `20` 不再算文件（少算 = 变严）
 *   C  结构性探索：`ls`/`find`/`git log`/`Glob`/`Grep` 也算读过
 *   B  子 agent 的读：主线程看不到的 `Read` 也算
 *   A  续接会话：上一段会话读过的东西也算
 *
 * 每个维度单独给数，也给出「全开」的数 —— 因为「全开」才是这次改宽的目标形态。
 *
 * 用法：
 *   node scripts/redteam-gate-widening.mjs            # 表格
 *   node scripts/redteam-gate-widening.mjs --json
 *   node scripts/redteam-gate-widening.mjs --threshold 3
 */

import { readdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeOne, attribute, listTranscripts, dedupeForks, isSandbox, defaultRoot,
  gateReadsOf, broadReadsOf, tailGateReads, agentToolIdsBefore,
  subagentReadsByToolId, looseSubagentReads, isContinuation, eachLineOffset,
} from './observe-reality-check.mjs';
import { pathKeyOf } from './pre-write-gate.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));

/** `head -n 20 a.mjs` → 修复后只取 `a.mjs`。这正是 observe-reality-check 的已知缺陷。 */
export function gateReadsFixed(name, inp) {
  const raw = gateReadsOf(name, inp);
  if (name !== 'Bash' && name !== 'PowerShell') return raw;
  const cmd = typeof inp?.command === 'string' ? inp.command : '';
  if (!cmd) return raw;
  const out = [];
  const VERBS = ['cat', 'head', 'tail', 'type', 'get-content', 'gc', 'more'];
  // 带独立值的选项：`-n 20`、`-c 512`、`--lines 20`
  const takesValue = /^-(?:n|c|lines|bytes|tail|max-count|m)$/i;
  for (const seg of cmd.split(/[;|&\n]/)) {
    const t = seg.trim().split(/\s+/);
    let i = 0;
    while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++;
    const verb = String(t[i] || '').replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();
    if (!VERBS.includes(verb)) continue;
    for (let j = i + 1; j < t.length; j++) {
      const a = t[j];
      if (takesValue.test(a)) { j++; continue; }
      if (/^-/.test(a)) continue;
      out.push(/^["']|["']$/.test(a) ? a.replace(/^["']|["']$/g, '') : a);
      break;
    }
  }
  return out;
}

/** 在给定的 transcript 文本里数「读过哪些不同路径」。`fixed=true` 用修好的解析。 */
export function readPathsInText(text, { fixed = false, struct = false } = {}) {
  const seen = new Set();
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let rec; try { rec = JSON.parse(s); } catch { continue; }
    if (!rec || rec.type !== 'assistant') continue;
    for (const b of rec.message?.content ?? []) {
      if (!b || b.type !== 'tool_use') continue;
      const nm = String(b.name || '');
      const inp = b.input && typeof b.input === 'object' ? b.input : {};
      const list = struct
        ? [...gateReadsFixed(nm, inp), ...broadReadsOf(nm, inp)]
        : (fixed ? gateReadsFixed(nm, inp) : gateReadsOf(nm, inp));
      for (const p of list) { const k = pathKeyOf(p); if (k) seen.add(k); }
    }
  }
  return seen;
}

/** 取 [end-window, end) 的文本，丢掉首行半条（与闸门 readTailBytes 同构）。 */
export function tailText(path, endBytes, windowBytes = 1024 * 1024) {
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
    let text = (got === want ? buf : buf.subarray(0, got)).toString('utf8');
    // 只有从文件中间切进去时才丢首行半条。窗口覆盖到文件头时首行是完整的。
    if (end - want > 0 && got >= want) { const nl = text.indexOf('\n'); text = nl >= 0 ? text.slice(nl + 1) : ''; }
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 收集首写之前的证据。窗口口径 = 闸门真实行为（1 MB 尾巴），累积口径 = 整个文件。
 *
 *  `winStruct` / `cumStruct` 是「文件路径 + 动作指纹」的并集 —— 与
 *  `observe-reality-check.mjs` 的 `readPathsBroad` 同义。动作指纹（`cmd:ls:xxxx`）
 *  不是文件，这一点是 §1 伪证据的关键，所以**同时**给出只有真路径的 `*PathsOnly`。 */
export function evidenceSets(session, { windowBytes = 1024 * 1024 } = {}) {
  const cutoff = session.firstWrite?.off ?? Number.POSITIVE_INFINITY;
  const winGate = new Set((session.readPathsWindow || []).map(pathKeyOf));
  const tail = tailText(session.path, cutoff, windowBytes);
  const winFix = readPathsInText(tail, { fixed: true });
  const winStruct = readPathsInText(tail, { fixed: true, struct: true });
  const winPathsOnly = new Set([...winFix, ...pathOnlyInText(tail)]);

  const cumGate = new Set(); const cumFix = new Set(); const cumStruct = new Set();
  const cumPathsOnly = new Set();
  eachLineOffset(session.path, (line, off) => {
    if (!line || off >= cutoff) return;
    let o; try { o = JSON.parse(line); } catch { return; }
    if (o.type !== 'assistant') return;
    for (const b of o.message?.content ?? []) {
      if (!b || b.type !== 'tool_use') continue;
      const nm = String(b.name || '');
      const inp = b.input && typeof b.input === 'object' ? b.input : {};
      for (const p of gateReadsOf(nm, inp)) { const k = pathKeyOf(p); if (k) cumGate.add(k); }
      for (const p of gateReadsFixed(nm, inp)) { const k = pathKeyOf(p); if (k) cumFix.add(k); }
      const broad = broadReadsOf(nm, inp);
      for (const p of [...gateReadsFixed(nm, inp), ...broad]) { const k = pathKeyOf(p); if (k) cumStruct.add(k); }
      for (const p of broad) if (isRealPathEvidence(p)) { const k = pathKeyOf(p); if (k) cumPathsOnly.add(k); }
    }
  });
  return { winGate, winFix, winStruct, winPathsOnly, cumGate, cumFix, cumStruct, cumPathsOnly };
}

/** `cmd:ls:xxxx` / `tool:Grep` / `glob:**` 不是文件路径。只有带分隔符或以点开头的才算。 */
export function isRealPathEvidence(p) {
  const s = String(p || '');
  if (!s) return false;
  if (/^(?:cmd|tool|glob):/i.test(s)) return false;
  return /[\\/]|^\.|\.\w{1,8}$/.test(s);
}

function pathOnlyInText(text) {
  const out = new Set();
  for (const line of String(text || '').split('\n')) {
    const s = line.trim(); if (!s) continue;
    let rec; try { rec = JSON.parse(s); } catch { continue; }
    if (!rec || rec.type !== 'assistant') continue;
    for (const b of rec.message?.content ?? []) {
      if (!b || b.type !== 'tool_use') continue;
      for (const p of broadReadsOf(String(b.name || ''), b.input || {})) {
        if (isRealPathEvidence(p)) { const k = pathKeyOf(p); if (k) out.add(k); }
      }
    }
  }
  return out;
}

/** 子 agent 读过的不同路径数。严格配对优先，否则用宽松口径（二者不可相加）。 */
export function subagentSet(session) {
  const ids = agentToolIdsBefore(session);
  const strict = subagentReadsByToolId(session, ids);
  if (strict.matched > 0) return { count: strict.reads, strict, loose: null, basis: 'strict' };
  const loose = looseSubagentReads(session);
  return { count: loose.reads, strict, loose, basis: loose.reads ? 'loose' : 'none' };
}

/** 前序会话的候选。返回 `{candidates, ambiguous, chosen, reads}`。
 *
 *  判据：本文件里 `isCompactSummary` 记录的 `parentUuid` 出现在**同项目目录**的哪些兄弟
 *  transcript 里。0 个 = 找不到，>1 个 = 有歧义。 */
export function predecessorCandidates(session) {
  const dir = dirname(session.path);
  let parentUuid = null;
  eachLineOffset(session.path, (line) => {
    if (parentUuid) return;
    let o; try { o = JSON.parse(line); } catch { return; }
    if (o && o.isCompactSummary && o.parentUuid) parentUuid = String(o.parentUuid);
  });
  if (!parentUuid) return { candidates: [], ambiguous: false, chosen: null, reads: 0, parentUuid: null };
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && join(dir, f) !== session.path); } catch { return { candidates: [], ambiguous: false, chosen: null, reads: 0, parentUuid }; }
  const hits = [];
  for (const f of files) {
    let text = '';
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    if (text.includes(parentUuid)) hits.push(join(dir, f));
  }
  // 选「读到最多不同文件」的那个（对闸门最有利的假设）
  let best = null;
  for (const p of hits) {
    const n = countGateReadsInFile(p);
    if (!best || n > best.n) best = { path: p, n };
  }
  return { candidates: hits, ambiguous: hits.length > 1, chosen: best ? best.path : null, reads: best ? best.n : 0, parentUuid };
}

function countGateReadsInFile(p) {
  const seen = new Set();
  eachLineOffset(p, (line) => {
    let o; try { o = JSON.parse(line); } catch { return; }
    if (o.type !== 'assistant') return;
    for (const b of o.message?.content ?? []) {
      if (!b || b.type !== 'tool_use') continue;
      for (const x of gateReadsOf(String(b.name || ''), b.input || {})) {
        const k = pathKeyOf(x); if (k) seen.add(k);
      }
    }
  });
  return seen.size;
}

// ── 主流程 ────────────────────────────────────────────────────────────

export function build(root = defaultRoot(), { threshold = 3 } = {}) {
  const metas = listTranscripts(root);
  const parsed = [];
  for (const m of metas) { try { parsed.push(analyzeOne(m, { order: 'file' })); } catch { /* skip */ } }
  const { kept } = dedupeForks(parsed);
  const real = kept.filter((s) => !isSandbox(s));
  const withWrite = real.filter((s) => s.firstWrite);
  const denied = withWrite.filter((s) => s.gateReads < threshold);

  const rows = denied.map((s) => {
    const base = attribute(s, { threshold });
    const sets = evidenceSets(s);
    const sub = subagentSet(s);
    const pred = predecessorCandidates(s);

    // 闸门真实口径 = 1 MB 尾巴。改宽后仍然只读尾巴，所以统一用窗口口径比较。
    const gateN = sets.winGate.size;
    const dN = sets.winFix.size;
    const cN = sets.winStruct.size;          // 路径 + 动作指纹（最宽）
    const cPathsN = sets.winPathsOnly.size;  // 只算真路径（严格）
    const bN = cN + sub.count;
    const aN = bN + pred.reads;

    const pass = (n) => n >= threshold;
    return {
      sessionId: s.sessionId,
      cwd: s.cwd,
      cls: base.cls,
      target: s.firstWrite?.path || '',
      write: s.firstWrite?.name || '',
      writes: s.writeCount,
      gate: gateN,
      cumGate: sets.cumGate.size,
      d: dN,
      c: cN,
      cPaths: cPathsN,
      b: bN,
      a: aN,
      subReads: sub.count,
      subBasis: sub.basis,
      predReads: pred.reads,
      predCandidates: pred.candidates.length,
      predAmbiguous: pred.ambiguous,
      pass_D: pass(dN),
      pass_C: pass(cN),
      pass_CStrict: pass(cPathsN),
      pass_B: pass(bN),
      pass_A: pass(aN),
    };
  });

  const count = (k) => rows.filter((r) => r[k]).length;
  return {
    threshold,
    corpus: { transcripts: metas.length, afterDedupe: kept.length, realWithWrite: withWrite.length, deniedBaseline: denied.length },
    stillDenied: {
      D_parseFixOnly: denied.length - count('pass_D'),
      C_structExplore: denied.length - count('pass_C'),
      B_subagent: denied.length - count('pass_B'),
      A_continuation: denied.length - count('pass_A'),
    },
    rows: rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
  };
}

function table(report) {
  const L = [];
  const pad = (s, n) => String(s).padEnd(n);
  L.push(`语料：${report.corpus.transcripts} 份 transcript → 去重 ${report.corpus.afterDedupe} → 真实项目有写 ${report.corpus.realWithWrite}`);
  L.push(`阈值 = ${report.threshold}；基线被拦 ${report.corpus.deniedBaseline} 个`);
  L.push('');
  L.push(`${pad('会话(前8)', 10)} ${pad('归因类', 26)} ${pad('gate', 5)} ${pad('+D', 4)} ${pad('+C', 4)} ${pad('+B', 4)} ${pad('+A', 4)}  改宽后`);
  L.push('-'.repeat(96));
  for (const r of report.rows) {
    const verdict = r.pass_A ? '放行' : r.pass_B ? '放行(缺A)' : r.pass_C ? '放行(缺B)' : r.pass_D ? '放行(缺C)' : '仍然拦';
    L.push(`${pad(r.sessionId.slice(0, 8), 10)} ${pad(r.cls, 26)} ${pad(r.gate, 5)} ${pad(r.d, 4)} ${pad(r.c, 4)} ${pad(r.b, 4)} ${pad(r.a, 4)}  ${verdict}`);
  }
  L.push('-'.repeat(96));
  const s = report.stillDenied;
  L.push(`仅修解析缺陷：剩 ${s.D_parseFixOnly}`);
  L.push(`+ 结构性探索：剩 ${s.C_structExplore}`);
  L.push(`+ 子 agent   ：剩 ${s.B_subagent}`);
  L.push(`+ 续接会话   ：剩 ${s.A_continuation}   ← 全开`);
  return L.join('\n');
}

if (process.argv[1] && join(process.argv[1]).endsWith('redteam-gate-widening.mjs')) {
  const argv = process.argv.slice(2);
  const thr = argv.includes('--threshold') ? Number(argv[argv.indexOf('--threshold') + 1]) : 3;
  const rootArg = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : defaultRoot();
  const rep = build(rootArg, { threshold: Number.isFinite(thr) ? thr : 3 });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(rep, null, 2) + '\n');
  else process.stdout.write(table(rep) + '\n');
}
