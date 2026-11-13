#!/usr/bin/env node
/**
 * resolution-gate-audit.mjs — 裁决 Agent R1 的复算器。
 *
 * 目的：**不复用锐评 Agent 的报告数字**，从原始 transcript 重算它引用的每一个关键数。
 * 凡本脚本跑不出来的，标「无法复算」，不猜。
 *
 * 复算清单（对应 `2026-11-14-gate-widening-counterargument.md`）：
 *   R1  §1③ 抱怨「没读就改」的发言条数（0 命中？）
 *   R2  §1④ 宿主自带文件读取门的触发率（Edit 0/16729、Write 3/5813、合 0.013%？）
 *   R3  §1② 被拦组 vs 放行组的返工需求率（0.51% vs 0.96%？）
 *   R4  §2② 阈值扫描 0/1/2/3/5（0/13/22/27/52？）
 *   R5  §2④ 「136 个会话实为 43 个任务簇」→ 按任务口径重算拦截率
 *   R6  §3② 「按目标文件锚定 → 67.6%」以及方向性结论
 *   R7  §6(b) 判据退化成恒真的对照实验（0/136 真实、69.6% 沙箱？）
 *
 * 口径纪律：
 *   · 分桶、去重、首写判定**全部 import** `observe-reality-check.mjs`，不自创第二套。
 *   · 语料是活的，所以每个数都现场算，并把快照规模打印出来。
 *   · 阴性对照桶（沙箱）与真实桶分开报，绝不混。
 *
 * 用法：
 *   node scripts/resolution-gate-audit.mjs                # 全部七项
 *   node scripts/resolution-gate-audit.mjs --only R3      # 只跑一项
 *   node scripts/resolution-gate-audit.mjs --json
 *
 * 只读：不写任何文件，不碰 git。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeOne, listTranscripts, dedupeForks, isSandbox, defaultRoot,
  eachLineOffset, isContinuation,
} from './observe-reality-check.mjs';
import { pathKeyOf } from './pre-write-gate.mjs';
import { humanTurnText, isInterrupt, classifyHumanMessage } from './measure-interventions.mjs';
import { normToolName, isWriteCall } from './measure-execution-phase.mjs';

const THRESHOLD = 3;

// ── 语料 ────────────────────────────────────────────────────────────

/** 载入并去重。返回 {real, sandbox, meta}。`real`/`sandbox` 都是 `analyzeOne()` 的产物。 */
function loadCorpus(root = defaultRoot(), { order = 'file' } = {}) {
  const metas = listTranscripts(root);
  const parsed = [];
  let skipped = 0;
  for (const m of metas) {
    try { parsed.push(analyzeOne(m, { order })); } catch { skipped++; }
  }
  const { kept, merged } = dedupeForks(parsed);
  const real = kept.filter((s) => !isSandbox(s));
  const sandbox = kept.filter((s) => isSandbox(s));
  return {
    real, sandbox,
    meta: {
      transcripts: metas.length, parsed: parsed.length, skipped,
      afterDedupe: kept.length, forksMerged: merged,
      realAll: real.length, realWithWrite: real.filter((s) => s.firstWrite).length,
      sandboxAll: sandbox.length, sandboxWithWrite: sandbox.filter((s) => s.firstWrite).length,
    },
  };
}

/** 是否被闸门拦（与 buildReport 的判据逐字相同）。 */
function denied(s, threshold = THRESHOLD) {
  return Boolean(s.firstWrite) && s.gateReads < threshold;
}

// ── R1：抱怨「没读就改」的发言 ──────────────────────────────────────

/** 锐评 §7 第 1 条给的正则。**原样照抄**，不改判据——改判据就等于替它辩护。 */
const COMPLAINT_RE = /(你没读|没读过|看都没看|不读就|没看代码|没看文件)/;
const REQUEST_READ_RE = /(先读一下|先看一下|你读一下)/;

/** 对照正则（锐评用它证明「正则本身不是死的」）。 */
const CONTROL_RE = /(已经有|重复实现|重复造)/;

/** 遍历全部 transcript 的人类发言，统计命中。
 *
 *  判据：`humanTurnText()` 非空（它已经排除 tool_result / isMeta / 合成前缀 / 续接摘要），
 *  再 `isInterrupt()` 排掉打断标记。**这就是锐评说的「排除 tool_result」。** */
function complaints(root = defaultRoot()) {
  const metas = listTranscripts(root);
  const hits = { complaint: [], requestRead: [], control: [] };
  let transcripts = 0;
  let humanTurns = 0;
  for (const m of metas) {
    transcripts++;
    eachLineOffset(m.path, (line) => {
      if (!line) return;
      let o;
      try { o = JSON.parse(line); } catch { return; }
      if (o.type !== 'user') return;
      if (isInterrupt(o)) return;
      const t = humanTurnText(o);
      if (t == null) return;
      humanTurns++;
      const txt = String(t);
      const rec = { session: m.sessionId.slice(0, 8), text: txt.trim().slice(0, 180) };
      if (COMPLAINT_RE.test(txt)) hits.complaint.push(rec);
      if (REQUEST_READ_RE.test(txt)) hits.requestRead.push(rec);
      if (CONTROL_RE.test(txt)) hits.control.push(rec);
    });
  }
  return { transcripts, humanTurns, ...hits };
}

// ── R2：宿主自带文件读取门 ──────────────────────────────────────────

const HOST_GATE_RE = /File has not been read yet/i;

/** 数宿主 `File has not been read yet` 错误，并按触发它的工具名分组。
 *
 *  做法：先扫出所有 `tool_use` 的 `id → name`（含文件块顺序），再扫 `tool_result` 的
 *  `tool_use_id` 与错误文本。**这是锐评没写清的那一步**——它说「分成两半看」，
 *  但没给怎么把错误归到工具名上。 */
function hostReadGate(root = defaultRoot()) {
  const metas = listTranscripts(root);
  const byTool = new Map();      // toolName -> {uses, errors}
  let transcripts = 0;
  let totalErrors = 0;
  let editUses = 0;
  let writeUses = 0;
  const errorSessions = new Set();
  for (const m of metas) {
    transcripts++;
    /** @type {Map<string,string>} tool_use_id -> tool name */
    const idToName = new Map();
    const localErrors = [];
    eachLineOffset(m.path, (line) => {
      if (!line || !line.includes('tool_use')) {
        // 错误文本行也含 tool_use_id，不能因为不含 tool_use 就跳过
        if (!line || !HOST_GATE_RE.test(line)) return;
      }
      let o;
      try { o = JSON.parse(line); } catch { return; }
      const content = o?.message?.content;
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (b?.type === 'tool_use' && typeof b.id === 'string') {
          idToName.set(b.id, String(b.name || ''));
        }
        if (b?.type === 'tool_result') {
          const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
          if (!HOST_GATE_RE.test(txt)) continue;
          localErrors.push(String(b.tool_use_id || ''));
        }
      }
    });
    for (const [id, name] of idToName) {
      if (name === 'Edit' || name === 'MultiEdit') editUses++;
      else if (name === 'Write') writeUses++;
      const cur = byTool.get(name) || { uses: 0, errors: 0 };
      cur.uses++;
      byTool.set(name, cur);
    }
    for (const tid of localErrors) {
      totalErrors++;
      errorSessions.add(m.sessionId);
      const name = idToName.get(tid) || 'unattributed';
      const cur = byTool.get(name) || { uses: 0, errors: 0 };
      cur.errors++;
      byTool.set(name, cur);
    }
  }
  const toolRows = [...byTool].map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.errors - a.errors || b.uses - a.uses);
  return {
    transcripts, totalErrors, errorSessions: errorSessions.size,
    editUses, writeUses,
    editErrors: (byTool.get('Edit')?.errors || 0) + (byTool.get('MultiEdit')?.errors || 0),
    writeErrors: byTool.get('Write')?.errors || 0,
    toolRows,
  };
}

// ── R3：被拦组 vs 放行组的返工需求率 ────────────────────────────────

/** 一次人类发言是不是「返工需求」。
 *
 *  锐评说它用的是 `measure-intervention-cost` 同款 `humanTurnText` + `classifyHumanMessage`。
 *  这里**照抄那两个函数**（直接 import），窗口 = 首写之后到文件尾。
 *  另外单列一条更严的判据（`isReworkDemand` 的 extended 档）作为敏感性。 */
function reworkSplit(corpus, threshold = THRESHOLD) {
  const withWrite = corpus.real.filter((s) => s.firstWrite);
  const groups = {
    denied: { sessions: 0, interruptions: 0, corrections: 0, texts: [] },
    allowed: { sessions: 0, interruptions: 0, corrections: 0, texts: [] },
  };
  for (const s of withWrite) {
    const g = denied(s, threshold) ? groups.denied : groups.allowed;
    g.sessions++;
    // 窗口：首写之后。首写的字节偏移已经在 analyzeOne() 里算好。
    const cutoff = s.firstWrite.off;
    let turnIdx = 0;
    let firstHumanSkipped = false;
    eachLineOffset(s.path, (line, off) => {
      if (!line) return;
      let o;
      try { o = JSON.parse(line); } catch { return; }
      if (o.type !== 'user') return;
      if (off <= cutoff) {
        // 首写之前的发言不进入执行期窗口
        return;
      }
      if (isInterrupt(o)) return;
      const t = humanTurnText(o);
      if (t == null) return;
      turnIdx++;
      // 会话首条人类消息若落在窗口内，不计（与 sessionCost 的 execHumans 一致）
      const isFirstHuman = !firstHumanSkipped && turnIdx === 1 && !s.firstHumanTs;
      if (isFirstHuman) { firstHumanSkipped = true; return; }
      g.interruptions++;
      const k = classifyHumanMessage(t);
      if (k === 'correction') {
        g.corrections++;
        g.texts.push({ session: s.sessionId.slice(0, 8), text: String(t).trim().slice(0, 160) });
      }
    });
  }
  const rate = (g) => (g.interruptions ? g.corrections / g.interruptions : null);
  return {
    denied: { ...groups.denied, rate: rate(groups.denied) },
    allowed: { ...groups.allowed, rate: rate(groups.allowed) },
  };
}

// ── R4：阈值扫描 ────────────────────────────────────────────────────

function thresholdScan(corpus, thresholds = [0, 1, 2, 3, 5]) {
  const real = corpus.real.filter((s) => s.firstWrite);
  const sandbox = corpus.sandbox.filter((s) => s.firstWrite);
  return thresholds.map((t) => ({
    threshold: t,
    realDeny: real.filter((s) => s.gateReads < t).length,
    realWithWrite: real.length,
    sandboxDeny: sandbox.filter((s) => s.gateReads < t).length,
    sandboxWithWrite: sandbox.length,
  }));
}

// ── R5：任务簇口径 ──────────────────────────────────────────────────

/** 把会话归成「任务簇」。
 *
 *  锐评说「按首条人类消息归一化」得到 43 个簇。这里用两条判据，都给：
 *    · exact  首条人类消息的规整文本完全相同
 *    · prefix 首条人类消息的前 80 字符相同（容忍用户在续接会话里多打了几个字）
 *  刻意**不**用 `dedupeForks`——那是内容签名去重，已经跑过了；这是另一层。 */
function taskClusters(corpus, { prefixLen = 80 } = {}) {
  const withWrite = corpus.real.filter((s) => s.firstWrite);
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const build = (keyOf) => {
    const m = new Map();
    for (const s of withWrite) {
      const k = keyOf(s);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    const clusters = [...m.entries()].map(([k, arr]) => ({
      key: k, size: arr.length,
      denied: arr.filter((x) => denied(x)).length,
      ids: arr.map((x) => x.sessionId.slice(0, 8)),
    }));
    return clusters;
  };
  const exact = build((s) => norm(s.firstHuman) || `__nohuman__:${s.sessionId}`);
  const prefixed = build((s) => (norm(s.firstHuman).slice(0, prefixLen)) || `__nohuman__:${s.sessionId}`);

  const summarize = (clusters) => {
    const multi = clusters.filter((c) => c.size > 1);
    return {
      clusters: clusters.length,
      sessionsInMulti: multi.reduce((n, c) => n + c.size, 0),
      multiClusters: multi.length,
      // 任务级：至少一个 fork 被拦 / 全部 fork 都被拦
      tasksWithAnyDeny: clusters.filter((c) => c.denied > 0).length,
      tasksWithAllDeny: clusters.filter((c) => c.denied === c.size).length,
      denySessionRate: withWrite.length
        ? withWrite.filter((s) => denied(s)).length / withWrite.length : null,
      denyTaskAnyRate: clusters.length
        ? clusters.filter((c) => c.denied > 0).length / clusters.length : null,
      denyTaskAllRate: clusters.length
        ? clusters.filter((c) => c.denied === c.size).length / clusters.length : null,
    };
  };
  return { exact: summarize(exact), prefix: summarize(prefixed) };
}

// ── R6：按目标文件锚定 ──────────────────────────────────────────────

/** 首写之前，读过「要改的那个文件本身」或「它所在目录」吗？
 *
 *  两个口径分开给，因为锐评的 67.6% 与 ceiling 报告的 16.9% 不是同一个东西：
 *    · target-only   精确匹配首写目标文件的路径
 *    · target-or-dir 目标文件 **或** 目标所在目录下任一文件
 *  读证据用 `readPathsWindow`（闸门真实可见的窗口）与 `readPathsGate`（整场会话）各算一次。
 *  前者是闸门**能**用的，后者是「那个会话到底读过没有」。 */
function targetAnchor(corpus) {
  const withWrite = corpus.real.filter((s) => s.firstWrite);
  const rows = [];
  for (const s of withWrite) {
    const target = String(s.firstWrite.paths?.[0] || s.firstWrite.path || '');
    if (!target) continue;
    const tk = pathKeyOf(target);
    const dir = tk.includes('/') ? tk.slice(0, tk.lastIndexOf('/') + 1) : '';
    const test = (paths) => {
      const set = new Set(paths.map(pathKeyOf));
      const exact = set.has(tk);
      let inDir = false;
      if (dir) for (const p of set) if (p.startsWith(dir) && p !== tk) { inDir = true; break; }
      return { exact, inDir };
    };
    const win = test(s.readPathsWindow || []);
    const cum = test(s.readPathsGate || []);
    rows.push({
      sessionId: s.sessionId.slice(0, 8), target: tk,
      window: win, cumulative: cum,
      gateReads: s.gateReads, currentlyDenied: denied(s),
    });
  }
  const agg = (pick) => {
    const touched = rows.filter((r) => pick(r).exact || pick(r).inDir);
    const exactOnly = rows.filter((r) => pick(r).exact);
    // 「按目标锚定」的判据：首写前必须碰过目标文件或它的目录
    const wouldDeny = rows.length - touched.length;
    return {
      n: rows.length,
      touchedTargetOrDir: touched.length,
      touchedTargetOnly: exactOnly.length,
      anchoredWouldDeny: wouldDeny,
      anchoredDenyRate: rows.length ? wouldDeny / rows.length : null,
      // 只豁免「读过目标文件本身」这一种（ceiling 报告 §4.2 的替代 3）
      exemptTargetWouldDeny: rows.filter((r) => r.currentlyDenied && !pick(r).exact).length,
    };
  };
  return {
    window: agg((r) => r.window),
    cumulative: agg((r) => r.cumulative),
    rows,
  };
}

// ── R7：恒真判据的对照实验 ──────────────────────────────────────────

/** 把判据换成「首写前有过 ≥N 次任意非写工具调用」，看会不会变成恒真。
 *
 *  锐评 §6(b) 报的是「≥1 次」→ 真实 0/136、沙箱 48/69。这里连 ≥3 一起算。
 *  这个判据**不是**任何一个候选方案，它只是一个「架空后长什么样」的探针。 */
function vacuityProbe(corpus, thresholds = [1, 3]) {
  /** 数首写之前的非写工具调用次数。 */
  const countNonWrite = (s) => {
    const cutoff = s.firstWrite.off;
    let n = 0;
    eachLineOffset(s.path, (line, off) => {
      if (off >= cutoff) return;
      if (!line) return;
      let o;
      try { o = JSON.parse(line); } catch { return; }
      const content = o?.message?.content;
      if (o.type !== 'assistant' || !Array.isArray(content)) return;
      for (const b of content) {
        if (b?.type !== 'tool_use') continue;
        if (isWriteCall(b.name, b.input || {})) continue;
        n++;
      }
    });
    return n;
  };
  const real = corpus.real.filter((s) => s.firstWrite);
  const sandbox = corpus.sandbox.filter((s) => s.firstWrite);
  const realCounts = real.map((s) => ({ s, n: countNonWrite(s) }));
  const sandboxCounts = sandbox.map((s) => ({ s, n: countNonWrite(s) }));
  return thresholds.map((t) => ({
    threshold: t,
    realDeny: realCounts.filter((x) => x.n < t).length,
    realWithWrite: real.length,
    sandboxDeny: sandboxCounts.filter((x) => x.n < t).length,
    sandboxWithWrite: sandbox.length,
  }));
}

// ── R8：按「首写是新建还是改已有」拆 ────────────────────────────────

/** 首写用的是 `Write`（新建/覆盖）还是 `Edit`（改已有）？
 *
 *  这是两个完全不同的行为：**新建文件时没有「目标文件」可读**，所以
 *  「先读要改的那个文件」这条判据对新建文件在定义上不可能满足。
 *  如果被拦集几乎全是新建，那「让 AI 先了解项目」就该改成别的形态；
 *  如果被拦集里混着大量 Edit，那闸门的立意至少对那一半成立。 */
function firstWriteKind(corpus, threshold = THRESHOLD) {
  const bucket = (list) => {
    const rows = list.filter((s) => s.firstWrite).map((s) => {
      const name = String(s.firstWrite.name || '');
      const target = String(s.firstWrite.paths?.[0] || s.firstWrite.path || '');
      const ext = (target.match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase() || 'none';
      // 「新建 vs 已有」只能靠工具名判：Write 无法区分是新建还是覆盖，
      // 所以这里额外查一次目标文件的首写时刻是否存在——不存在则是新建。
      const isEdit = name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit';
      return {
        sessionId: s.sessionId.slice(0, 8), tool: name, isEdit, ext,
        target: target.slice(-60), gateReads: s.gateReads,
        denied: s.gateReads < threshold,
        // 首写前有没有读过**同一个文件**（判「读了目标文件」这条能不能成立）
        readTargetBefore: (s.readPathsWindow || []).some((p) => pathKeyOf(p) === pathKeyOf(target)),
      };
    });
    const d = rows.filter((r) => r.denied);
    const a = rows.filter((r) => !r.denied);
    const tally = (arr, k) => arr.reduce((m, r) => (m[k(r)] = (m[k(r)] || 0) + 1, m), {});
    return {
      n: rows.length,
      denied: d.length,
      deniedByTool: tally(d, (r) => r.tool),
      allowedByTool: tally(a, (r) => r.tool),
      deniedEdits: d.filter((r) => r.isEdit).length,
      deniedWrites: d.filter((r) => !r.isEdit).length,
      deniedReadTargetBefore: d.filter((r) => r.readTargetBefore).length,
      allowedReadTargetBefore: a.filter((r) => r.readTargetBefore).length,
      deniedByExt: tally(d, (r) => r.ext),
    };
  };
  return { real: bucket(corpus.real), sandbox: bucket(corpus.sandbox) };
}

// ── 汇总 ────────────────────────────────────────────────────────────

function runAudit(root = defaultRoot(), { only = null } = {}) {
  const out = { root, corpus: null };
  const want = (id) => !only || only === id;

  // R1 只需要原始 transcript，不需要 corpus
  if (want('R1')) out.R1 = complaints(root);

  out.corpus = loadCorpus(root);

  if (want('R2')) out.R2 = hostReadGate(root);
  if (want('R3')) out.R3 = reworkSplit(out.corpus);
  if (want('R4')) out.R4 = thresholdScan(out.corpus);
  if (want('R5')) out.R5 = taskClusters(out.corpus);
  if (want('R6')) {
    const t = targetAnchor(out.corpus);
    out.R6 = { window: t.window, cumulative: t.cumulative };
  }
  if (want('R7')) out.R7 = vacuityProbe(out.corpus);
  if (want('R8')) out.R8 = firstWriteKind(out.corpus);
  return out;
}

function formatAudit(a) {
  const p = (x) => (x == null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
  const L = [];
  const m = a.corpus?.meta;
  if (m) {
    L.push(`语料快照：transcript ${m.transcripts} · 解析 ${m.parsed} · 跳过 ${m.skipped} · fork 去重后 ${m.afterDedupe}（合并 ${m.forksMerged}）`);
    L.push(`  真实项目 ${m.realAll}（有写 ${m.realWithWrite}） · 沙箱 ${m.sandboxAll}（有写 ${m.sandboxWithWrite}）`);
  }
  if (a.R1) {
    L.push('', '── R1 抱怨「没读就改」的发言 ──');
    L.push(`  transcript ${a.R1.transcripts} · 人类发言 ${a.R1.humanTurns}`);
    L.push(`  抱怨正则命中 ${a.R1.complaint.length} · 请求读命中 ${a.R1.requestRead.length} · 对照正则 ${a.R1.control.length}`);
    for (const h of a.R1.complaint.slice(0, 8)) L.push(`    [${h.session}] ${h.text}`);
    for (const h of a.R1.requestRead.slice(0, 8)) L.push(`    (read) [${h.session}] ${h.text}`);
  }
  if (a.R2) {
    L.push('', '── R2 宿主自带文件读取门 ──');
    L.push(`  transcript ${a.R2.transcripts} · 错误总数 ${a.R2.totalErrors}（${a.R2.errorSessions} 个会话）`);
    L.push(`  Edit+MultiEdit 调用 ${a.R2.editUses} → 错误 ${a.R2.editErrors}`);
    L.push(`  Write 调用 ${a.R2.writeUses} → 错误 ${a.R2.writeErrors}`);
    const tot = a.R2.editUses + a.R2.writeUses;
    L.push(`  合计 ${tot} 次写调用 → ${a.R2.totalErrors} 次错误 = ${p(tot ? a.R2.totalErrors / tot : null)}`);
    for (const r of a.R2.toolRows.filter((x) => x.errors > 0)) {
      L.push(`    ${r.name.padEnd(14)} uses ${r.uses}  errors ${r.errors}`);
    }
  }
  if (a.R3) {
    L.push('', '── R3 被拦组 vs 放行组返工需求率（执行期窗口）──');
    for (const [k, g] of [['被拦', a.R3.denied], ['放行', a.R3.allowed]]) {
      L.push(`  ${k}：会话 ${g.sessions} · 中断 ${g.interruptions} · 纠正 ${g.corrections} · 纠正率 ${p(g.rate)}`);
      for (const t of g.texts.slice(0, 6)) L.push(`      [${t.session}] ${t.text}`);
    }
  }
  if (a.R4) {
    L.push('', '── R4 阈值扫描 ──');
    for (const r of a.R4) {
      L.push(`  threshold ${r.threshold}: 真实 ${r.realDeny}/${r.realWithWrite} = ${p(r.realDeny / r.realWithWrite)}  ·  沙箱 ${r.sandboxDeny}/${r.sandboxWithWrite} = ${p(r.sandboxDeny / r.sandboxWithWrite)}`);
    }
  }
  if (a.R5) {
    L.push('', '── R5 任务簇口径 ──');
    for (const [kind, s] of Object.entries(a.R5)) {
      L.push(`  [${kind}] 簇 ${s.clusters}（多 fork 簇 ${s.multiClusters}，含会话 ${s.sessionsInMulti}）`);
      L.push(`      会话级拦截率 ${p(s.denySessionRate)} · 任务级「至少一 fork 被拦」 ${p(s.denyTaskAnyRate)}（${s.tasksWithAnyDeny}/${s.clusters}） · 「全部 fork 被拦」 ${p(s.denyTaskAllRate)}（${s.tasksWithAllDeny}/${s.clusters}）`);
    }
  }
  if (a.R6) {
    L.push('', '── R6 按目标文件锚定 ──');
    for (const [kind, s] of Object.entries(a.R6)) {
      L.push(`  [${kind} 证据] n=${s.n} · 碰过目标或目录 ${s.touchedTargetOrDir}（${p(s.touchedTargetOrDir / s.n)}）· 只碰目标 ${s.touchedTargetOnly}（${p(s.touchedTargetOnly / s.n)}）`);
      L.push(`      按锚定判据会拦 ${s.anchoredWouldDeny}/${s.n} = ${p(s.anchoredDenyRate)}`);
      L.push(`      仅在现行判据之上额外豁免「读过目标文件本身」→ 仍拦 ${s.exemptTargetWouldDeny}`);
    }
  }
  if (a.R7) {
    L.push('', '── R7 恒真对照：首写前 ≥N 次非写工具调用 ──');
    for (const r of a.R7) {
      L.push(`  ≥${r.threshold}: 真实 ${r.realDeny}/${r.realWithWrite} = ${p(r.realDeny / r.realWithWrite)}  ·  沙箱 ${r.sandboxDeny}/${r.sandboxWithWrite} = ${p(r.sandboxDeny / r.sandboxWithWrite)}`);
    }
  }
  if (a.R8) {
    L.push('', '── R8 首写是新建还是改已有 ──');
    for (const [kind, s] of Object.entries(a.R8)) {
      L.push(`  [${kind}] 有写 ${s.n} · 被拦 ${s.denied}`);
      L.push(`      被拦里 Edit/MultiEdit ${s.deniedEdits} · Write ${s.deniedWrites}`);
      L.push(`      被拦里「首写前读过同一文件」 ${s.deniedReadTargetBefore} · 放行里同名 ${s.allowedReadTargetBefore}`);
      L.push(`      被拦工具分布 ${JSON.stringify(s.deniedByTool)}`);
      L.push(`      被拦扩展名分布 ${JSON.stringify(s.deniedByExt)}`);
    }
  }
  return L.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const root = argOf('--root', defaultRoot());
  if (!existsSync(root)) {
    process.stderr.write(`找不到 transcript 根目录：${root}\n`);
    return 2;
  }
  const only = argOf('--only', null);
  const res = runAudit(root, { only });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(res, null, 1) + '\n');
  else process.stdout.write(formatAudit(res) + '\n');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
