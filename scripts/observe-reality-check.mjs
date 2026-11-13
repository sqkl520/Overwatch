#!/usr/bin/env node
/**
 * observe-reality-check.mjs — 「observe 模式到底能回答什么」的实测器。
 *
 * ── 它回答什么 ────────────────────────────────────────────────────
 * 用 400+ 个真实会话的 transcript 重放 `pre-write-gate.mjs` 的判定，给出：
 *   1. 每个会话**第一次写文件之前**读过几个不同文件（p50 / p90 / 读 0 个的比例）；
 *   2. 阈值 3 会让多少个会话的第一次写被判 would-deny；
 *   3. 被拦的会话长什么样（结构事实 + 人工抽样）。
 *
 * ── 它不回答什么 ──────────────────────────────────────────────────
 * 「真实模型被拦后会不会照 reason 去做」。那需要真模型被真拦住，本机做不到
 * （`claude -p` 撞认证闸，见 probe-log.txt）。observe 模式本身也测不到 ——
 * 它不拦，模型就不会遇到障碍，所谓「反应」根本不会发生。
 *
 * ── 三个口径，缺一个都会自相矛盾 ──────────────────────────────────
 *
 * A. **gate**：闸门真实实现口径。`readTranscriptReads()` 只读 transcript **尾部
 *    1 MB**，且只认 `Read`/`NotebookRead` 与 shell 的 cat/head/tail/type/gc/more。
 *    判定发生在首次写那一刻，所以窗口是 `[首写偏移 - 1MB, 首写偏移]`。
 *    这一列是**闸门真的会看到的东西**，也应当是报告的头部数字。
 *
 * B. **cumulative**：同一判据，但从文件开头累积（不受 1MB 窗口限制）。
 *    它回答「这个会话到底读过什么」，用于衡量窗口截断损失了多少证据。
 *
 * C. **broad**：把判据放宽到「结构性探索」—— ls / find / grep / Glob / Grep /
 *    git log|status|diff|show 也算。它回答「AI 是不是其实已经看过项目，只是
 *    看的方式闸门不认」。这一列是**闸门判据是否合理**的直接证据。
 *
 * ── 语料卫生：必须先清洗，否则数字是假的 ──────────────────────────
 *
 * ① **本仓自己的测试沙箱**（`AppData\Local\Temp\*`、`.tmp-analysis/*`）混在内。
 *    那些会话的 prompt 就是「写个文件然后停」，必然触发闸门，而且触发得对。
 *    混进来会让误伤率凭空抬高。主结论只报「真实项目」桶。
 *
 * ② **时间戳乱序 / resume 回放**。实测 224 个有写会话**全部**存在时间戳倒退，
 *    148 个有 >60s 的倒退，116 个有 >1h 的倒退。若按**文件顺序**取「第一次写」，
 *    拿到的可能是历史回放里早就完成的写，不是本次会话真实的首次写。
 *    所以本脚本按**真实时间戳**排序取首写（`--order time`，默认），
 *    并同时给出文件顺序口径（`--order file`）作为敏感性对照。
 *
 * ③ **fork 副本**。同一段对话写成多个 sessionId（恢复/压缩）。判据同
 *    `measure-intervention-cost.mjs`：按会话首条记录签名分桶，组内比公共前缀
 *    占较短者的比例 ≥ 0.98 且 ≥ 30 条。
 *
 * 用法：
 *   node scripts/observe-reality-check.mjs                  # 全量，时间顺序口径
 *   node scripts/observe-reality-check.mjs --threshold 5
 *   node scripts/observe-reality-check.mjs --json
 *   node scripts/observe-reality-check.mjs --samples        # 打印被拦会话样本
 *   node scripts/observe-reality-check.mjs --root <dir>
 *
 * 退出码：0 正常；2 找不到 transcript 根目录。
 * 只读：不写任何文件，不碰 git。
 */

import { readdirSync, statSync, openSync, readSync, fstatSync, closeSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { decide, defaultConfig, writeIntentOf, readPathsInTranscriptText, readPathsOfToolUse, pathKeyOf, GATE_SHELL_READ_VERBS } from './pre-write-gate.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));

/** 闸门认的「读内容」shell 动词。**从闸门本体派生**，不在这里另写一份字面量 ——
 *  曾经的复制品是分叉的源头（见 `scripts/probe-parser-divergence.mjs`）。
 *  这个名字保留是因为报告与其它测量脚本按它取口径。 */
export const GATE_READ_VERBS = GATE_SHELL_READ_VERBS;

/** 结构性探索：看过目录结构 / 搜索过 / 看过版本历史。**闸门不认**。 */
export const STRUCT_VERBS = Object.freeze(['ls', 'dir', 'find', 'grep', 'rg', 'fd', 'tree', 'stat', 'du', 'git', 'file']);

/** 读内容的其它 shell 动词。闸门也不认，但确实是读了内容。 */
export const CONTENT_VERBS = Object.freeze(['awk', 'sed', 'wc', 'strings', 'xxd', 'od', 'jq', 'python', 'python3', 'perl', 'nl', 'rev']);

/** 结构性探索工具（非 shell）。 */
export const STRUCT_TOOLS = Object.freeze(['Glob', 'Grep', 'LS', 'List', 'list_dir']);

// ── 语料发现与清洗 ────────────────────────────────────────────────────

export function defaultRoot() { return join(homedir(), '.claude', 'projects'); }

/** 主 transcript：`<root>/<slug>/<sessionId>.jsonl` 两层。subagents/ 不计入。 */
export function listTranscripts(root = defaultRoot()) {
  const out = [];
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    let files;
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(dir, f);
      let st;
      try { st = statSync(p); } catch { continue; }
      out.push({ slug: d.name, sessionId: f.slice(0, -6), path: p, bytes: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/** 本仓自己跑实验产生的沙箱会话。它们的 prompt 就是「写文件然后停」，必须与真实项目分开。 */
export function isSandbox(session) {
  const c = String(session.cwd || '');
  const slug = String(session.slug || '');
  return /[\\/]Temp[\\/]/i.test(c) || /\.tmp-analysis/i.test(c)
    || /^C--Users-Administrator-AppData-Local-Temp/.test(slug)
    || /Overwatch--tmp-analysis/.test(slug)
    || /^C--Users-Administrator-AppData-Local-Temp/.test(c);
}

/** 带精确字节偏移的逐行读。`eachLine` 给的是块边界，做不了窗口计算。
 *
 *  文件打不开时**静默返回**（一条行都不回放）而不是抛：调用方 `analyzeOne` 是
 *  批量扫语料的，一个坏文件不该让整趟统计挂掉。这也是闸门本体 `readTailBytes`
 *  的同一条取向 —— 读不到等于什么都没读到，不是「崩溃」。 */
export function eachLineOffset(path, onLine) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
  } catch {
    return;
  }
  const size = fstatSync(fd).size;
  const CHUNK = 1 << 20;
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = 0; let lineStart = 0; let carry = Buffer.alloc(0);
  try {
    while (pos < size) {
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      const chunk = Buffer.concat([carry, buf.subarray(0, n)]);
      let from = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, from);
        if (nl < 0) break;
        onLine(chunk.subarray(from, nl).toString('utf8'), lineStart);
        lineStart += (nl - from) + 1;
        from = nl + 1;
      }
      carry = chunk.subarray(from);
      pos += n;
    }
    if (carry.length) onLine(carry.toString('utf8'), lineStart);
  } finally {
    closeSync(fd);
  }
}

/** 32 位 FNV-1a。只用于「两份 transcript 是不是同一段对话」的指纹。 */
export function fnv1a(seed, s) {
  let h = (seed || 0x811c9dc5) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** 归一化记录签名。只取 message.content，不含 uuid/时间戳 —— 回放副本这两项会变。 */
export function recordSignature(o) {
  const c = o?.message?.content;
  let body = '';
  if (typeof c === 'string') body = c;
  else if (Array.isArray(c)) {
    body = c.map((b) => {
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text') return `t:${b.text ?? ''}`;
      if (b.type === 'thinking') return 'k';
      if (b.type === 'tool_use') return `u:${b.name ?? ''}:${JSON.stringify(b.input ?? {})}`;
      if (b.type === 'tool_result') return 'r';
      return b.type ?? '';
    }).join('|');
  }
  return `${o?.type ?? ''}|${body}`;
}

// ── 单会话分析 ────────────────────────────────────────────────────────

/** shell 命令 → 动词序列（只取每段首词，够判「这条在干什么」）。 */
export function verbsOf(cmd) {
  const out = [];
  for (const seg of String(cmd || '').split(/[;|&\n]/)) {
    const t = seg.trim().split(/\s+/);
    let i = 0;
    while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++;
    const v = String(t[i] || '').replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();
    if (v) out.push(v);
  }
  return out;
}

/**
 * 分析一个 transcript。
 *
 * `order='time'`（默认）按真实时间戳取首写；`order='file'` 按文件顺序取。
 * 前者是**真的第一次写**，后者是「磁盘上第一次出现写」，两者在有 resume 回放的
 * 会话里不同（实测 108/224 个不同）。
 */
export function analyzeOne(meta, { order = 'file' } = {}) {
  const events = [];          // {off, ts, tsOk, kind:'write'|'read', ...}
  const seq = [];
  const info = {
    slug: meta.slug, sessionId: meta.sessionId, path: meta.path,
    bytes: meta.bytes, mtimeMs: meta.mtimeMs,
    cwd: null, firstTs: null, lastTs: null,
    firstHuman: null, firstHumanTs: null,
    readsTimeline: [],        // 读取事件（gate / broad 两档），带 off 与 ts
    writes: [],               // 所有写事件 {ts, tsOk, off, name, input, via, paths}
    agentEvents: [],          // Agent 工具调用事件（判「首写前派过子 agent」）
    outOfOrder: 0, tsRecords: 0, records: 0,
  };

  let prevTs = null;
  let humanSeen = 0;

  eachLineOffset(meta.path, (line, off) => {
    if (!line) return;
    info.records++;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    seq.push(fnv1a(0x811c9dc5, recordSignature(o)));
    const ts = Date.parse(o.timestamp || '');
    const tsOk = Number.isFinite(ts);
    if (tsOk) {
      info.tsRecords++;
      if (prevTs !== null && ts < prevTs) info.outOfOrder++;
      prevTs = ts;
      if (!info.firstTs) info.firstTs = o.timestamp;
      info.lastTs = o.timestamp;
    }
    if (!info.cwd && o.cwd) info.cwd = o.cwd;

    if (o.type === 'assistant') {
      const blocks = Array.isArray(o.message?.content) ? o.message.content : [];
      for (const b of blocks) {
        if (!b || b.type !== 'tool_use') continue;
        const name = String(b.name || '');
        const inp = b.input && typeof b.input === 'object' ? b.input : {};
        if (String(name).toLowerCase() === 'agent') info.agentEvents.push({ off, ts, tsOk });
        const intent = writeIntentOf(name, inp, info.cwd || '');
        if (intent.isWrite) {
          info.writes.push({ off, ts, tsOk, tsRaw: o.timestamp ?? null, name, input: inp, via: intent.via, paths: intent.paths });
          continue;
        }
        // 读取证据：闸门口径 + 宽口径
        const gate = gateReadsOf(name, inp);
        const broad = gate.length ? gate : broadReadsOf(name, inp);
        for (const p of gate) info.readsTimeline.push({ off, ts, tsOk, path: p, tier: 'gate' });
        for (const p of broad) info.readsTimeline.push({ off, ts, tsOk, path: p, tier: 'broad' });
      }
      return;
    }
    if (o.type !== 'user') return;
    info.readsTimeline.push(...[]); // tool_result 里不含新路径，跳过
    if (!info.firstHuman) {
      const c = o.message?.content;
      const isToolResult = Array.isArray(c) && c.some((b) => b?.type === 'tool_result');
      const txt = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n') : '');
      if (!isToolResult && txt && txt.trim() && !/^\[Request interrupted/.test(txt.trim()) && !o.isMeta) {
        humanSeen++;
        info.firstHuman = txt.slice(0, 500);
        info.firstHumanTs = o.timestamp ?? null;
      }
    }
  });

  info.seq = seq;
  info.humanTurnCount = humanSeen;
  return finalize(info, order);
}

/** 闸门判据：把一次工具调用交给闸门的真实现。
 *
 *  **没有第二份实现。** 曾经这里有一份与闸门「同构」的复制（`GATE_READ_VERBS` +
 *  自己的循环），2026-11-14 用 `scripts/probe-parser-divergence.mjs` 量化后
 *  确认那是两份独立代码，已合并到 `pre-write-gate.mjs` 的
 *  `readPathsOfToolUse()`。`readVerbs` 参数只为让测试能证明「动词表是唯一来源」，
 *  生产调用从不传它。 */
export function gateReadsOf(name, inp, readVerbs) {
  return readVerbs === undefined
    ? readPathsOfToolUse(name, inp)
    : readPathsOfToolUse(name, inp, readVerbs);
}

/** 宽口径：结构性探索 + 其它读内容动词。返回**证据条目**（调用或路径）。
 *
 *  刻意**不按动词去重**：`ls` 跑 5 次与跑 1 次是不同强度的探索证据，
 *  按动词去重会把前者压成 1（第一版就这样，导致宽口径严重低估）。
 *  路径类的去重交给调用方（按 pathKeyOf 归一）。 */
export function broadReadsOf(name, inp) {
  const out = [];
  if (STRUCT_TOOLS.includes(name)) {
    const v = inp?.path || inp?.file_path || '';
    if (v) out.push(String(v));
    if (inp?.pattern) out.push(`glob:${inp.pattern}`);
    // Glob/Grep 没给 path 时也要计一条：它确实做了一次结构性探索。
    if (!v && !inp?.pattern) out.push(`tool:${name}`);
    return out;
  }
  if (name !== 'Bash' && name !== 'PowerShell') return out;
  const cmd = typeof inp?.command === 'string' ? inp.command : '';
  if (!cmd) return out;
  for (const seg of cmd.split(/[;|&\n]/)) {
    const t = seg.trim().split(/\s+/);
    let i = 0;
    while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++;
    const verb = String(t[i] || '').replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();
    if (!STRUCT_VERBS.includes(verb) && !CONTENT_VERBS.includes(verb)) continue;
    // 带上命令行指纹：同一动词在不同命令上是不同次探索。
    out.push(`cmd:${verb}:${fnv1a(0x811c9dc5, seg.slice(0, 120)).toString(36)}`);
  }
  return out;
}

/** 取首写、并算出三个口径的读取数。 */
function finalize(info, order) {
  const ordered = info.writes
    .filter((w) => w.tsOk)
    .sort((a, b) => (a.ts - b.ts) || (a.off - b.off));
  const byFile = info.writes.slice().sort((a, b) => a.off - b.off);
  const first = order === 'file' ? (byFile[0] || null) : (ordered[0] || byFile[0] || null);

  const res = {
    slug: info.slug, sessionId: info.sessionId, path: info.path,
    bytes: info.bytes, mtimeMs: info.mtimeMs, cwd: info.cwd,
    firstHuman: info.firstHuman, firstHumanTs: info.firstHumanTs,
    firstTs: info.firstTs, lastTs: info.lastTs,
    records: info.records, outOfOrder: info.outOfOrder, tsRecords: info.tsRecords,
    writeCount: info.writes.length,
    // 「首写前派过子 agent」必须按同一个截止点算，不能用整场会话的计数。
    agentCalls: first ? info.agentEvents.filter((ev) => (order === 'file'
      ? ev.off < first.off
      : (ev.tsOk && Number.isFinite(first.ts) ? ev.ts < first.ts : ev.off < first.off))).length : 0,
    seq: info.seq,
    firstWrite: first ? {
      name: first.name, input: first.input, via: first.via,
      path: first.paths[0] || '', paths: first.paths, ts: first.tsRaw, off: first.off,
    } : null,
  };
  if (!first) {
    res.gateReads = 0; res.gateReadsCumulative = 0; res.broadReads = 0;
    res.readPathsGate = []; res.readPathsBroad = [];
    return res;
  }

  // 截止 = 首写的时间戳（时间口径）或字节偏移（文件口径）。
  const cutoffTs = first.ts;
  const cutoffOff = first.off;
  const before = (ev) => (order === 'file'
    ? ev.off < cutoffOff
    : (ev.tsOk && Number.isFinite(cutoffTs) ? ev.ts < cutoffTs : ev.off < cutoffOff));

  // gate 按**不同路径**去重（与闸门实现一致：读同一文件 50 次只算 1 个）。
  // broad 保留**每一次探索动作**：`ls` × 5 是 5 条证据，压成 1 会低估探索强度。
  const gateSet = new Set(); const broadList = [];
  for (const ev of info.readsTimeline) {
    if (!before(ev)) continue;
    const k = pathKeyOf(ev.path);
    if (!k) continue;
    if (ev.tier === 'gate') { gateSet.add(k); continue; }
    broadList.push(k);
  }
  res.readPathsGate = [...gateSet];
  res.readPathsBroad = [...new Set([...gateSet, ...broadList])];
  res.gateReadsCumulative = gateSet.size;
  res.broadReads = new Set(broadList).size;
  res.broadActions = broadList.length;

  // 闸门真实口径：只看首写时刻的 1 MB 尾巴。
  // 计数与 decide() 复算**共用这一份数组**，否则「我会拦 N 个」和「真 decide() 说 M 个」
  // 会对不上 —— 第一版就是这样错的（27 vs 26），而且日志里看不出来。
  res.readPathsWindow = tailGateReads(info.path, cutoffOff);
  res.gateReads = res.readPathsWindow.length;
  return res;
}

/** 取 transcript 在 [endBytes-window, endBytes) 内、闸门判据能认的读路径。
 *
 *  **窗口语义与闸门逐字一致**（这一点曾经是错的）：
 *  闸门 `readTranscriptReads` 只在「真的被截断」（读满窗口且文件比窗口大）时丢首行，
 *  因为只有那时首行才是半条。文件比窗口小时首行是完整记录，必须保留。
 *  曾经的写法只判 `got >= want`（读满窗口就丢），于是「文件正好比窗口小」时
 *  也会丢掉一条完整记录 —— 那是**少算**，方向偏保守但数字是错的。
 *  锚点：`pre-write-gate.mjs` 的 `readTranscriptReads()`。 */
export function tailGateReads(path, endBytes, windowBytes = 1024 * 1024, readVerbs) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const end = Math.min(size, Math.max(0, endBytes));
    const want = Math.max(0, Math.min(end, windowBytes));
    if (!want) return [];
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, end - want + got);
      if (n <= 0) break;
      got += n;
    }
    let text = (got === want ? buf : buf.subarray(0, got)).toString('utf8');
    // 闸门的判据是 `bytesRead >= bytes`（窗口字节数）→ 丢首行，见
    // `readTranscriptReads()`。这里 `got` 对 `windowBytes` 就是同一个比较：
    // 读满窗口 = 从中间切进去 = 首行是半条。读不满 = 从文件头开始 = 首行完整。
    if (got >= windowBytes && text.includes('\n')) {
      text = text.slice(text.indexOf('\n') + 1);
    }
    return gateReadPathsInText(text, readVerbs);
  } catch {
    return [];
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 给定一段 transcript 文本，按**闸门的判据**抽路径。返回路径数组。
 *
 *  过去这里是「与 readTranscriptReads 同构」的复制品；同构是声称，不是保证。
 *  现在直接调闸门的 `readPathsInTranscriptText()` —— 闸门改动词表，这里跟着变。 */
export function gateReadPathsInText(text, readVerbs) {
  return readPathsInTranscriptText(text, readVerbs).paths;
}

// ── 去重与统计 ────────────────────────────────────────────────────────

/** fork 去重：同首条签名分桶，组内公共前缀 / 较短者 ≥ 0.98 且 ≥ 30 条即合并。 */
export function dedupeForks(sessions, { ratio = 0.98, minCommon = 30 } = {}) {
  const byFirst = new Map();
  for (const s of sessions) {
    const k = String(s.seq?.[0] ?? s.sessionId);
    if (!byFirst.has(k)) byFirst.set(k, []);
    byFirst.get(k).push(s);
  }
  const parent = new Map();
  for (const s of sessions) parent.set(s.sessionId, s.sessionId);
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  for (const arr of byFirst.values()) {
    if (arr.length < 2) continue;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i]; const b = arr[j];
        const short = Math.min(a.seq.length, b.seq.length);
        if (short < minCommon) continue;
        let c = 0;
        while (c < short && a.seq[c] === b.seq[c]) c++;
        if (c < minCommon || c / short < ratio) continue;
        const ra = find(a.sessionId); const rb = find(b.sessionId);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }
  const comps = new Map();
  for (const s of sessions) {
    const r = find(s.sessionId);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(s);
  }
  const kept = [];
  for (const arr of comps.values()) {
    arr.sort((a, b) => (b.records - a.records) || (a.mtimeMs - b.mtimeMs));
    kept.push(arr[0]);
  }
  return { kept, merged: sessions.length - kept.length };
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx); const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function distOf(values) {
  const c = [...values].sort((a, b) => a - b);
  if (!c.length) return { n: 0 };
  return {
    n: c.length, zero: c.filter((x) => x === 0).length,
    lt3: c.filter((x) => x < 3).length, lt5: c.filter((x) => x < 5).length,
    p10: pct(c, 0.1), p50: pct(c, 0.5), p90: pct(c, 0.9),
    mean: c.reduce((a, b) => a + b, 0) / c.length, max: c[c.length - 1],
  };
}

/** 结构事实。不做语义判断（「这是不是简单任务」留给人工抽样，见报告 §3）。 */
export function structuralKind(s) {
  const p = String(s.firstWrite?.path || '');
  const cwd = String(s.cwd || '');
  const isWrite = s.firstWrite?.name === 'Write';
  const ext = (p.match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase() || 'none';
  const grp = ['md', 'markdown'].includes(ext) ? 'doc'
    : ['json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'env', 'properties', 'xml'].includes(ext) ? 'config'
      : ['txt', 'csv', 'log', 'snap'].includes(ext) ? 'data'
        : ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'cc', 'cpp', 'h', 'cs', 'rb', 'php', 'sh', 'ps1', 'lua', 'kt'].includes(ext) ? 'code'
          : 'other';
  const outside = cwd ? !pathKeyOf(p).startsWith(pathKeyOf(cwd) + '/') : null;
  return [
    isWrite ? 'new' : 'edit', grp,
    outside === null ? 'cwd?' : (outside ? 'outside-cwd' : 'in-cwd'),
    s.writeCount <= 1 ? 'one-shot' : 'multi-write',
    s.agentCalls > 0 ? 'agent-first' : 'no-agent',
  ].join('/');
}

/** 用真 decide() 复算这个会话的首次写，确认重放口径与实现不漂。 */
export function verdict(s, { minReads = 3, readsField = 'readPathsWindow' } = {}) {
  const cfg = { ...defaultConfig(), mode: 'observe', minReads };
  const state = {
    config: cfg,
    cwd: s.cwd || HERE,
    marker: { exists: false, data: null, error: null },
    reads: { paths: s[readsField] || [] },
  };
  const out = decide({
    hook_event_name: 'PreToolUse',
    session_id: `replay-${s.sessionId}`,
    cwd: s.cwd || HERE,
    tool_name: s.firstWrite.name,
    tool_input: s.firstWrite.input,
    transcript_path: s.path,
  }, state);
  return { decision: out.log.decision, allowReason: out.log.allowReason, reads: out.log.reads };
}

// ── 被拦会话的归因（第 3 条指标）──────────────────────────────────────

/** 宿主写的续接摘要前缀。**读取发生在上一段会话里，闸门结构性地看不到。** */
export const CONTINUATION_RE = /^This session is being continued from a previous conversation|^This session is a continuation|^<summary>|^Conversation summary|^以下是压缩/i;

export function isContinuation(session) {
  return CONTINUATION_RE.test(String(session.firstHuman || '').trim());
}

/**
 * 主 transcript 里「首写之前」出现过的 Agent tool_use id。
 * 用**字节偏移**判先后，不用时间戳 —— 实测 224/224 个有写会话都有时间戳倒退。
 */
export function agentToolIdsBefore(session) {
  const cutoff = session.firstWrite?.off ?? Number.POSITIVE_INFINITY;
  const ids = new Set();
  eachLineOffset(session.path, (line, off) => {
    if (!line || off >= cutoff) return;
    let o; try { o = JSON.parse(line); } catch { return; }
    if (o.type !== 'assistant') return;
    for (const b of o.message?.content ?? []) {
      if (b?.type === 'tool_use' && String(b.name || '').toLowerCase() === 'agent' && b.id) ids.add(String(b.id));
    }
  });
  return ids;
}

/** 严格归因：子 agent 的 `meta.toolUseId` 必须命中首写前的 Agent 调用。 */
export function subagentReadsByToolId(session, allowedIds) {
  const dir = join(session.path.replace(/\.jsonl$/, ''), 'subagents');
  const out = { files: 0, matched: 0, reads: 0 };
  if (!existsSync(dir)) return out;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  out.files = entries.filter((f) => f.endsWith('.jsonl')).length;
  const seen = new Set();
  for (const e of entries) {
    if (!e.endsWith('.meta.json')) continue;
    let meta = null;
    try { meta = JSON.parse(readFileSync(join(dir, e), 'utf8')); } catch { continue; }
    const tid = String(meta?.toolUseId || '');
    if (!tid || !allowedIds.has(tid)) continue;
    out.matched++;
    const body = join(dir, e.replace(/\.meta\.json$/, '.jsonl'));
    if (!existsSync(body)) continue;
    eachLineOffset(body, (line) => {
      if (!line) return;
      let o; try { o = JSON.parse(line); } catch { return; }
      const c = o?.message?.content;
      if (!Array.isArray(c)) return;
      for (const b of c) {
        if (!b || b.type !== 'tool_use') continue;
        for (const x of gateReadsOf(String(b.name || ''), b.input || {})) {
          const k = pathKeyOf(x); if (k) seen.add(k);
        }
      }
    });
  }
  out.reads = seen.size;
  return out;
}

/**
 * 宽松归因（B2）：该会话 subagents/ 下**所有**子 agent 读过的文件数。
 *
 * 为什么需要它：2026-10 及更早的会话里，`meta.toolUseId` 与主 transcript 的
 * `tool_use.id` 命名空间不同（`toolu_bdrk_…` vs `call_…`），**一条都配不上**。
 * 实测 3613 个 meta 里能配上 3419（94.6%），但失配集中在被拦集合上。
 * 这一档不声称「都发生在首写之前」（子 agent 时间戳与主线程不同钟），
 * 所以归因强度弱于 B，单独命名、单独计数。
 */
export function looseSubagentReads(session) {
  const dir = join(session.path.replace(/\.jsonl$/, ''), 'subagents');
  const out = { files: 0, reads: 0 };
  if (!existsSync(dir)) return out;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  const seen = new Set();
  for (const e of entries) {
    if (!e.endsWith('.jsonl')) continue;
    out.files++;
    eachLineOffset(join(dir, e), (line) => {
      if (!line) return;
      let o; try { o = JSON.parse(line); } catch { return; }
      const c = o?.message?.content;
      if (!Array.isArray(c)) return;
      for (const b of c) {
        if (!b || b.type !== 'tool_use') continue;
        for (const x of gateReadsOf(String(b.name || ''), b.input || {})) {
          const k = pathKeyOf(x); if (k) seen.add(k);
        }
      }
    });
  }
  out.reads = seen.size;
  return out;
}

/**
 * 把「会被拦」的会话归因成互斥五类。判据全部可复核，不做语义猜测。
 *
 *   A-continuation           续接摘要开头 → 读在上一段会话
 *   B-subagent               严格配对成功且子 agent 读 ≥3
 *   B2-subagent-unattributed 配不上但确有 Agent 调用且子 agent 目录里读 ≥3
 *   C-broad-explore          未读够但做过 ≥3 次结构性探索（ls/find/grep/Glob/git）
 *   D-no-evidence            以上都不是
 */
export function attribute(session, { threshold = 3 } = {}) {
  if (isContinuation(session)) return { cls: 'A-continuation', strict: null, loose: null };
  const ids = agentToolIdsBefore(session);
  const strict = subagentReadsByToolId(session, ids);
  if (strict.matched > 0 && strict.reads >= threshold) return { cls: 'B-subagent', strict, loose: null };
  if (strict.matched === 0 && session.agentCalls > 0) {
    const loose = looseSubagentReads(session);
    if (loose.reads >= threshold) return { cls: 'B2-subagent-unattributed', strict, loose };
  }
  if (session.broadReads >= threshold) return { cls: 'C-broad-explore', strict, loose: null };
  return { cls: 'D-no-evidence', strict, loose: null };
}

export const ATTRIBUTION_CLASSES = Object.freeze([
  'A-continuation', 'B-subagent', 'B2-subagent-unattributed', 'C-broad-explore', 'D-no-evidence',
]);

// ── 报告 ──────────────────────────────────────────────────────────────

export function buildReport(root = defaultRoot(), { threshold = 3, order = 'file' } = {}) {
  const metas = listTranscripts(root);
  const parsed = [];
  let skipped = 0;
  for (const m of metas) {
    try { parsed.push(analyzeOne(m, { order })); } catch { skipped++; }
  }
  const { kept, merged } = dedupeForks(parsed);
  const real = kept.filter((s) => !isSandbox(s));
  const sandbox = kept.filter((s) => isSandbox(s));

  const bucket = (list) => {
    const withWrite = list.filter((s) => s.firstWrite);
    const deny = withWrite.filter((s) => s.gateReads < threshold);
    const denyCum = withWrite.filter((s) => s.gateReadsCumulative < threshold);
    const denyBroad = withWrite.filter((s) => s.broadReads < threshold);
    const v = withWrite.map((s) => verdict(s, { minReads: threshold }));
    const kinds = new Map(); const kindsZero = new Map();
    for (const s of deny) { const k = structuralKind(s); kinds.set(k, (kinds.get(k) || 0) + 1); }
    for (const s of deny.filter((x) => x.gateReads === 0)) { const k = structuralKind(s); kindsZero.set(k, (kindsZero.get(k) || 0) + 1); }
    // 归因：拦下它的那一刻，它到底有没有读过项目。
    const attr = new Map();
    const denied = deny.map((s) => {
      const a = attribute(s, { threshold });
      attr.set(a.cls, (attr.get(a.cls) || 0) + 1);
      return {
        sessionId: s.sessionId, cwd: s.cwd, gateReads: s.gateReads,
        cumulative: s.gateReadsCumulative, broad: s.broadReads,
        write: s.firstWrite.name, target: s.firstWrite.path, writes: s.writeCount,
        agentCalls: s.agentCalls, ts: s.firstWrite.ts, kind: structuralKind(s),
        attribution: a.cls,
        subReads: a.strict ? a.strict.reads : (a.loose ? a.loose.reads : 0),
        subMatched: a.strict ? a.strict.matched : 0,
        human: (s.firstHuman || '').slice(0, 220),
      };
    });
    const attribution = {};
    for (const k of ATTRIBUTION_CLASSES) attribution[k] = attr.get(k) || 0;
    return {
      sessions: list.length, withWrite: withWrite.length, noWrite: list.length - withWrite.length,
      gate: distOf(withWrite.map((s) => s.gateReads)),
      cumulative: distOf(withWrite.map((s) => s.gateReadsCumulative)),
      broad: distOf(withWrite.map((s) => s.broadReads)),
      broadActions: distOf(withWrite.map((s) => s.broadActions)),
      deny: deny.length, denyRate: withWrite.length ? deny.length / withWrite.length : null,
      denyCumulative: denyCum.length, denyBroad: denyBroad.length,
      decideDeny: v.filter((x) => x.decision === 'would-deny').length,
      decideAllow: v.filter((x) => x.decision === 'allow').length,
      decidetargetRead: v.filter((x) => x.allowReason === 'target-read').length,
      agentFirst: withWrite.filter((s) => s.agentCalls > 0).length,
      agentFirstDenied: deny.filter((s) => s.agentCalls > 0).length,
      attribution,
      kinds: Object.fromEntries([...kinds].sort((a, b) => b[1] - a[1])),
      kindsZero: Object.fromEntries([...kindsZero].sort((a, b) => b[1] - a[1])),
      denied,
    };
  };

  return {
    threshold, order, root,
    totals: { transcripts: metas.length, parsed: parsed.length, skipped, afterDedupe: kept.length, forksMerged: merged },
    real: bucket(real), sandbox: bucket(sandbox),
  };
}

export function formatReport(r) {
  const f = (x, d = 1) => (x == null ? 'n/a' : Number(x).toFixed(d).replace(/\.0$/, ''));
  const p = (x) => (x == null ? 'n/a' : `${f(100 * x)}%`);
  const L = [];
  const head = (t) => { L.push('', `── ${t} ──`); };

  L.push(`写前闸 · 真实语料重放（threshold=${r.threshold}，首写口径=${r.order === 'time' ? '时间戳' : '文件顺序'}）`);
  L.push(`根目录 ${r.root}`);
  L.push(`transcript ${r.totals.transcripts} · 成功解析 ${r.totals.parsed} · 跳过 ${r.totals.skipped} · fork 去重后 ${r.totals.afterDedupe}（合并 ${r.totals.forksMerged}）`);

  for (const [key, label] of [['real', '真实项目'], ['sandbox', '测试沙箱/探针（对照）']]) {
    const b = r[key];
    L.push('', `══════ ${label} ══════`);
    L.push(`会话 ${b.sessions}（有写 ${b.withWrite} / 无写 ${b.noWrite}）`);
    if (!b.withWrite) continue;

    head('指标 1：首次写之前读了几个不同文件');
    L.push(`  gate 口径（闸门真实实现，1MB 尾窗口）  p10 ${f(b.gate.p10)}  p50 ${f(b.gate.p50)}  p90 ${f(b.gate.p90)}  mean ${f(b.gate.mean)}  max ${b.gate.max}`);
    L.push(`    读 0 个 ${b.gate.zero}（${p(b.gate.zero / b.withWrite)}）   读 <3 个 ${b.gate.lt3}（${p(b.gate.lt3 / b.withWrite)}）   读 <5 个 ${b.gate.lt5}`);
    L.push(`  cumulative 口径（同判据，不看窗口）    p10 ${f(b.cumulative.p10)}  p50 ${f(b.cumulative.p50)}  p90 ${f(b.cumulative.p90)}  mean ${f(b.cumulative.mean)}`);
    L.push(`  broad 口径（+ls/find/grep/Glob/git）   p10 ${f(b.broad.p10)}  p50 ${f(b.broad.p50)}  p90 ${f(b.broad.p90)}  mean ${f(b.broad.mean)}`);
    L.push(`    读 <3 个（宽口径）${b.broad.lt3}（${p(b.broad.lt3 / b.withWrite)}）`);

    head('指标 2：阈值会拦多少');
    L.push(`  gate 口径        would-deny ${b.deny} / ${b.withWrite} = ${p(b.denyRate)}`);
    // `would-deny` 数的是「文件数 < 阈值」；`decide()` 数的是**真闸门**的判决。
    // 2026-11-14 P1 之后两者**有意不再相等**：Edit 侧改判「读过目标文件本身」，
    // 有 4 个会话满足了新判据却在旧计数下仍算「读得少」。所以这里不做相等断言，
    // 而是把差额单独打出来 —— 混为一个数会让「判据换了」和「重放写错了」长得一样。
    const gap = b.deny - b.decideDeny;
    L.push(`  真 decide() 复算 deny ${b.decideDeny} / allow ${b.decideAllow}`);
    L.push(`  差额 ${gap}${gap ? `（target-read 在全量 ${b.withWrite} 个会话里放行了 ${b.decidetargetRead} 个。差额本身不逐条等于它 —— Edit 侧换判据后，deny 与 decide 已不是同一个量）` : '（两口径一致）'}`);
    L.push(`  cumulative 口径  would-deny ${b.denyCumulative}（比 gate 少 ${b.deny - b.denyCumulative}，窗口截断的代价）`);
    L.push(`  broad 口径       would-deny ${b.denyBroad}（比 gate 少 ${b.deny - b.denyBroad}，判据收窄的代价）`);

    head('指标 3：被拦会话归因 —— 拦下它时它到底读过没有');
    for (const k of ATTRIBUTION_CLASSES) {
      const n = b.attribution[k] || 0;
      if (!n) continue;
      L.push(`  ${String(n).padStart(4)}  ${k.padEnd(26)} ${p(n / b.deny)}`);
    }
    const explainable = b.deny - (b.attribution['D-no-evidence'] || 0);
    L.push(`  ${'—'.repeat(4)}  「有读取证据但不是闸门认的方式」共 ${explainable} / ${b.deny}（${p(explainable / b.deny)}）`);
    L.push('  各类的含义见脚本头 §归因；D 类才是「闸门拦得对」');
    L.push('  —— 其中 gateReads=0 的结构事实：');
    for (const [k, v] of Object.entries(b.kindsZero)) L.push(`  ${String(v).padStart(4)}  ${k}`);

    head('读发生在子 agent 里（闸门结构性看不见）');
    L.push(`  首写前派过 Agent 的会话 ${b.agentFirst} / ${b.withWrite}（其中被拦 ${b.agentFirstDenied}）`);
  }
  return L.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const root = argOf('--root', defaultRoot());
  if (!existsSync(root)) {
    process.stderr.write(`找不到 transcript 根目录：${root}\n`);
    return 2;
  }
  const r = buildReport(root, {
    threshold: Number(argOf('--threshold', '3')),
    order: argOf('--order', 'file'),
  });
  if (argv.includes('--json')) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); return 0; }
  if (argv.includes('--samples')) {
    for (const [key, label] of [['real', '真实项目'], ['sandbox', '沙箱']]) {
      process.stdout.write(`\n=== ${label} 被拦样本（gateReads / cumulative / broad）===\n`);
      for (const s of r[key].denied) {
        process.stdout.write(`${String(s.gateReads).padStart(2)}/${String(s.cumulative).padStart(2)}/${String(s.broad).padStart(2)}  ${s.write.padEnd(10)} ${(s.target || '').slice(-46).padEnd(46)} w=${String(s.writes).padStart(3)} a=${String(s.agentCalls).padStart(3)}  ${s.kind}\n      ${(s.human || '').replace(/\s+/g, ' ').slice(0, 130)}\n`);
      }
    }
    return 0;
  }
  process.stdout.write(formatReport(r) + '\n');
  return 0;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')?.replace(/^\//, '')}`) {
  process.exit(main());
}
