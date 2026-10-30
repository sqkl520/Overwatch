#!/usr/bin/env node
/**
 * watch.mjs — 三层轮询守护：文件系统探针 + 去重 + 限额 + 通知。
 *
 * 三层（成本来自实测，见 baseline.md 与 hosted-mode.md §4.3）：
 *
 *   L-fast  1 分钟   ~/.claude/jobs/＊/state.json         约 12ms   只抓 failed/blocked 的跃迁
 *   L-mid   5 分钟   ~/.claude/projects/＊/＊.jsonl 的 mtime 约 50ms   纯 stat，不解析
 *   L-full  30 分钟  scan-sessions.mjs 全量               约 20s     接受
 *
 * **绝大多数轮次只走 L-fast**。绝不在每轮做全量扫描（AC3），
 * 也绝不用 `claude agents --json`（实测 3.0–5.4s，且会复活已死的后台会话）。
 *
 * 去重是**边沿触发**：键 = SHA-256(sessionId|state|reason) 前 16 位，
 * 同一键只在首次出现时通知。reason 变了算新事件（novelty→hb_gap 说明卡的原因变了）。
 * 三层共享同一份 state.json —— 否则 L-fast 报过的 blocked 会被 L-full 再报一次。
 *
 * 状态与日志只写 %LOCALAPPDATA%\Overwatch\，**永不写仓库**（AC1）。
 * 零依赖，只用 node: 内置模块。
 */

import {
  existsSync, readdirSync, statSync, readFileSync, writeFileSync,
  mkdirSync, renameSync, rmSync, appendFileSync, openSync, readSync, closeSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { classifyStop } from './classify-stop.mjs';

// ── 常量 ──────────────────────────────────────────────────────────────

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const JOBS_INTERVAL = 1 * MINUTE;
const PROBE_INTERVAL = 5 * MINUTE;
const FULL_INTERVAL = 30 * MINUTE;

/** 限额（AC6） */
const PER_SESSION_MAX_24H = 2;
const GLOBAL_MAX_24H = 8;
const GLOBAL_MIN_GAP = 10 * MINUTE;

const LOG_MAX_BYTES = 1024 * 1024;

/** 只对「最近还有活动」的会话告警。一周前就停了的会话不是新闻，
 *  首轮跑起来会把它们全当新边沿，一次刷屏 20 条。 */
const ACTIVE_WINDOW = 24 * HOUR;

/** 需要通知的终态。STALLED 是主产品信号（不再产出），P0 只看这三类。 */
export const NOTIFY_STATES = ['FAILED', 'BLOCKED', 'STALLED'];

const SCAN_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'scan-sessions.mjs');

// ── 路径 ──────────────────────────────────────────────────────────────

/** 状态目录。测试与自检通过 OVERWATCH_STATE_DIR 改道，绝不碰真实 LOCALAPPDATA。 */
export function defaultStateDir(env = process.env) {
  if (env.OVERWATCH_STATE_DIR) return env.OVERWATCH_STATE_DIR;
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'Overwatch');
  }
  const xdg = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(xdg, 'overwatch');
}

const statePath = (dir) => join(dir, 'state.json');
const logPath = (dir) => join(dir, 'watch.log');

/**
 * 是「看起来像路径」的字符串吗。
 * 存在的意义：check-structure 的 import 门会拿 `{}` / `1` 把每个导出函数都调一遍，
 * 而 existsSync(undefined) 在 Node 26 会报 DEP0187。这里显式挡住非法输入，
 * 返回「没有」而不是靠 existsSync 的宽容。
 */
function asPath(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function claudeRoot(env, override) {
  if (override) return override;
  return join((env && env.CLAUDE_CONFIG_DIR) || join(homedir(), '.claude'));
}

// ── 日志 ──────────────────────────────────────────────────────────────

/**
 * 单文件 1MB 上限，超出轮转到 watch.log.1（覆盖旧的 .1，只留一份）。
 * 行格式：2026-10-30T21:00:00Z [INFO] probe=48ms changed=0 skipped=1
 */
export function createLogger(dir, { maxBytes = LOG_MAX_BYTES, mirror = null } = {}) {
  const target = asPath(dir);
  if (!target) {
    // 没有目录只能走 mirror（stdout）。不静默丢日志，也不在 cwd 里建目录。
    return {
      path: null,
      info: (m) => { if (mirror) mirror(`${new Date().toISOString()} [INFO] ${m}`); },
      warn: (m) => { if (mirror) mirror(`${new Date().toISOString()} [WARN] ${m}`); },
      error: (m) => { if (mirror) mirror(`${new Date().toISOString()} [ERROR] ${m}`); },
    };
  }
  mkdirSync(target, { recursive: true });
  const file = logPath(target);
  const rotated = file + '.1';

  const rotateIfNeeded = (incoming) => {
    let size = 0;
    try { size = statSync(file).size; } catch { return; }
    if (size + incoming > maxBytes) {
      try { rmSync(rotated, { force: true }); } catch { /* ignore */ }
      try { renameSync(file, rotated); } catch { /* ignore */ }
    }
  };

  const write = (level, message) => {
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const line = `${stamp} [${level}] ${message}`;
    const buf = Buffer.from(line + '\n', 'utf8');
    rotateIfNeeded(buf.length);
    try {
      appendFileSync(file, buf);
    } catch (e) {
      // 日志写不了不能让守护进程死掉；但必须让调用方看见
      if (mirror) mirror(`${line}  [log-write-failed: ${e.message}]`);
      return;
    }
    if (mirror) mirror(line);
  };

  return {
    path: file,
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
  };
}

// ── 状态文件 ──────────────────────────────────────────────────────────

export function emptyState() {
  return {
    version: 1,
    lastJobsScanAt: null,
    lastProbeAt: null,
    lastFullScanAt: null,
    notified: {},
    budget: { day: null, sent: 0, sentLog: [], perSession: {} },
    muteUntil: null,
  };
}

/** 校验并补齐缺字段。返回 { state, corrupt }。坏文件不静默吞——改名留证后从空状态起步。 */
export function loadState(dir, { logger = null } = {}) {
  const target = asPath(dir);
  if (!target) throw new TypeError('loadState: dir 必须是字符串路径');
  const p = statePath(target);
  if (!existsSync(p)) return { state: emptyState(), corrupt: false };
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error(`读取状态文件失败：${p}：${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const bad = `${p}.corrupt-${ts}`;
    renameSync(p, bad);
    if (logger) logger.error(`state.json 解析失败，已改名留证：${bad}（${e.message}）`);
    return { state: emptyState(), corrupt: true };
  }
  const base = emptyState();
  const state = {
    ...base,
    ...parsed,
    notified: parsed && typeof parsed.notified === 'object' && parsed.notified ? parsed.notified : {},
    budget: { ...base.budget, ...(parsed.budget || {}) },
  };
  if (!Array.isArray(state.budget.sentLog)) state.budget.sentLog = [];
  if (typeof state.budget.perSession !== 'object' || !state.budget.perSession) state.budget.perSession = {};
  return { state, corrupt: false };
}

/** tmp + rename 原子替换。写到一半崩掉不会留下半截 JSON。 */
export function saveState(dir, state) {
  const target = asPath(dir);
  if (!target) throw new TypeError('saveState: dir 必须是字符串路径');
  mkdirSync(target, { recursive: true });
  const p = statePath(target);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(tmp, p);
}

// ── 去重 ──────────────────────────────────────────────────────────────

/** `reason` 剥掉数字与括号内容，只留类别前缀。
 *  `novelty=0.18,0.15,0.12` 与 `novelty=0.17,0.14,0.11` 必须归为同一个 `novelty`。
 *  曾直接用完整 reason 做键 —— 而 novelty 每轮都变，同一会话每轮都是新键，
 *  去重形同虚设，退化成限流。见 docs/design/hosted-mode.md §4.2。 */
export function reasonClass(reason) {
  const s = String(reason ?? '');
  // 取等号/括号之前的前缀；没有则取前 24 字符
  const m = s.match(/^([a-zA-Z_][\w-]*)/);
  return (m ? m[1] : s.slice(0, 24)) || 'unknown';
}

/** AC2：`sessionId | state | reasonClass | evidenceFingerprint` 的 SHA-256 前 16 位。
 *  - `reasonClass` 剥掉会漂移的数字
 *  - `evidenceFingerprint` 是最后一条 assistant 记录 uuid 的短哈希，让「卡在别处」能被区分 */
export function dedupeKey(sessionId, state, reason, evidenceFingerprint = '') {
  return createHash('sha256')
    .update(`${sessionId}|${state}|${reasonClass(reason)}|${evidenceFingerprint}`)
    .digest('hex')
    .slice(0, 16);
}

// ── 限额 ──────────────────────────────────────────────────────────────

function within(list, nowMs, windowMs) {
  return list.filter((iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && nowMs - t < windowMs && t <= nowMs + MINUTE;
  });
}

/**
 * 现在能不能发。返回 { ok, why }。
 * 不能发不等于丢弃——调用方把边沿留在 state 里（notifyCount 仍为 0），
 * 下一轮预算松开时会补发。这就是「全局 10 分钟内 ≤1 条」的突发合并。
 */
export function canNotify(state, sessionId, nowMs) {
  if (state.muteUntil) {
    const until = Date.parse(state.muteUntil);
    if (Number.isFinite(until) && nowMs < until) return { ok: false, why: 'muted' };
  }
  const sentLog = within(state.budget.sentLog || [], nowMs, DAY);
  if (sentLog.length >= GLOBAL_MAX_24H) return { ok: false, why: 'global-24h' };

  const mine = within((state.budget.perSession || {})[sessionId] || [], nowMs, DAY);
  if (mine.length >= PER_SESSION_MAX_24H) return { ok: false, why: 'per-session-24h' };

  if (sentLog.length) {
    const last = Math.max(...sentLog.map((iso) => Date.parse(iso)));
    if (nowMs - last < GLOBAL_MIN_GAP) return { ok: false, why: 'global-10min' };
  }
  return { ok: true, why: null };
}

export function recordSent(state, sessionId, nowMs = Date.now()) {
  const iso = new Date(nowMs).toISOString();
  state.budget = state.budget || { day: null, sent: 0, sentLog: [], perSession: {} };
  state.budget.sentLog = [...within(state.budget.sentLog || [], nowMs, DAY), iso];
  const per = state.budget.perSession || {};
  per[sessionId] = [...within(per[sessionId] || [], nowMs, DAY), iso];
  state.budget.perSession = per;
  // 顺带把「今天的计数」维护成文档里的形状
  state.budget.day = iso.slice(0, 10);
  state.budget.sent = state.budget.sentLog.filter((s) => s.startsWith(String(state.budget.day))).length;
  return state;
}

// ── L-fast：jobs ──────────────────────────────────────────────────────

/**
 * 读 ~/.claude/jobs/＊/state.json（实测 12ms）。
 * 只回答「宿主自己说它 failed/blocked 了吗」，不做推断。
 *
 * 绝不调 `claude agents --json`：3.0–5.4 秒，而且会把已死的后台会话复活。
 */
export function probeJobs(jobsRoot) {
  const started = process.hrtime.bigint();
  const found = [];
  let scanned = 0;
  let skipped = 0;
  const target = asPath(jobsRoot);
  if (!target || !existsSync(target)) {
    return { found, scanned, skipped, elapsedMs: 0 };
  }
  let dirs;
  try {
    dirs = readdirSync(target);
  } catch (e) {
    throw new Error(`读取 jobs 目录失败：${target}：${e.message}`);
  }
  for (const name of dirs) {
    const p = join(target, name, 'state.json');
    let job;
    try {
      job = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      skipped++; // 目录不存在 / 半截文件：正常现象，不是失败
      continue;
    }
    scanned++;
    if (job.state !== 'failed' && job.state !== 'blocked') { skipped++; continue; }
    const sessionId = job.sessionId || job.resumeSessionId || name;
    const updated = Date.parse(job.updatedAt || job.lastTerminalAt || job.createdAt || '');
    if (!Number.isFinite(updated) || Date.now() - updated > ACTIVE_WINDOW) { skipped++; continue; }
    found.push({
      sessionId,
      state: job.state === 'failed' ? 'FAILED' : 'BLOCKED',
      reason: job.state === 'failed' ? 'host-reported-failed' : 'host-reported-blocked',
      project: job.cwd ? job.cwd.split(/[\\/]/).pop() : null,
      detail: job.detail || null,
      needs: job.needs || null,
      updatedAt: job.updatedAt || null,
      source: 'jobs',
    });
  }
  return {
    found,
    scanned,
    skipped,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
  };
}

// ── L-mid：mtime 探针 ────────────────────────────────────────────────

/**
 * 顶层 ＊.jsonl 的 mtime，**不递归子目录**（实测递归会从 50ms 涨到约 1s）。
 * 只用来回答「哪个项目有新活动」，然后只对那个项目跑增量扫描。
 */
export function probeMtime(projectsRoot) {
  const started = process.hrtime.bigint();
  const now = Date.now();
  const result = { projects: [], changed: [], elapsedMs: 0, skipped: 0 };
  const target = asPath(projectsRoot);
  if (!target || !existsSync(target)) return { ...result, elapsedMs: 0 };

  let dirs;
  try {
    dirs = readdirSync(target);
  } catch (e) {
    throw new Error(`读取 projects 目录失败：${target}：${e.message}`);
  }
  for (const project of dirs) {
    if (project === 'memory') continue;
    const p = join(target, project);
    let entries;
    try {
      const st = statSync(p);
      if (!st.isDirectory()) continue;
      entries = readdirSync(p);
    } catch { result.skipped++; continue; }

    let maxMtimeMs = 0;
    let fileCount = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      try {
        const st = statSync(join(p, entry));
        fileCount++;
        if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
      } catch { result.skipped++; }
    }
    if (fileCount === 0) continue;
    result.projects.push({ project, fileCount, maxMtimeMs });
  }
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  return { ...result, elapsedMs: elapsed };
}

/** 与上次探针比对，返回有新活动的项目名 */
export function diffProbe(previous, current) {
  const prev = previous || {};
  return current.projects
    .filter((p) => {
      const before = prev[p.project];
      return typeof before !== 'number' || p.maxMtimeMs > before;
    })
    .map((p) => p.project);
}

export function foldProbe(previous, current) {
  const out = { ...(previous || {}) };
  for (const p of current.projects) out[p.project] = p.maxMtimeMs;
  return out;
}

// ── L-full / 增量：调 scan-sessions.mjs ──────────────────────────────

/**
 * 跑一次扫描。`project` 为 null 时是全量（约 20s），否则单项目（约 1.5–2s）。
 * scan-sessions 在有 FAILED 时 exit 1 —— 那是正常输出，不是失败。
 */
export function runScan({ project = null, days = 3, timeoutMs = 180_000, nodePath = process.execPath } = {}) {
  const started = process.hrtime.bigint();
  const args = [SCAN_SCRIPT, '--days', String(days || 3), '--json'];
  if (typeof project === 'string' && project) args.push('--project', project);

  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error(`扫描超时（${timeoutMs}ms）：${project || '全量'}`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法启动扫描：${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        reject(new Error(`扫描输出不是 JSON（exit=${code}）：${(err || out).trim().slice(0, 200)}`));
        return;
      }
      resolve({
        sessions: parsed.sessions || [],
        generatedAt: parsed.generatedAt || null,
        elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
        exitCode: code,
      });
    });
  });
}

/** 把扫描结果转成通知候选。只看「最近还有活动」的会话，见 ACTIVE_WINDOW。 */
export function candidatesFromScan(sessions, { nowMs = Date.now(), states = NOTIFY_STATES } = {}) {
  const out = [];
  for (const s of sessions || []) {
    if (!states.includes(s.state)) continue;
    const activity = Date.parse(s.lastActivity || '');
    if (Number.isFinite(activity) && nowMs - activity > ACTIVE_WINDOW) continue;
    out.push({
      sessionId: s.sessionId,
      state: s.state,
      reason: s.reason || 'unknown',
      project: s.project,
      needs: s.needs || null,
      idleSec: s.idleSec,
      lastActivity: s.lastActivity,
      // 证据指纹：会话静止时 lastActivity 稳定；真的「卡在别处」时它会变。
      // 不用 idleSec——那是每轮都在走的，会让去重失效。
      evidenceFingerprint: String(s.lastActivity || '').replace(/\D/g, '').slice(-10),
      source: 'scan',
    });
  }
  return out;
}

// ── 通知投递 ──────────────────────────────────────────────────────────

function describe(c) {
  const where = c.project ? `${c.project}` : (c.sessionId || '').slice(0, 8);
  const bits = [where, c.reason];
  if (c.idleSec != null) bits.push(`idle=${Math.round(c.idleSec / 60)}m`);
  if (c.needs) bits.push(`等：${String(c.needs).slice(0, 80)}`);
  return bits.filter(Boolean).join(' · ');
}

/**
 * 把候选送出去。返回 { sent, suppressed, failed }。
 *
 * AC5：notifier 抛错时动作退回「仅记录」——写 ERROR 日志、把边沿标成已处理
 * （`delivery: 'failed'`），**不自动重试**。不重试是有意的：发不出去的通知
 * 重发只会消耗信任（hosted-mode.md §4.5 第 3 条）。
 */
export async function dispatchCandidates(candidates, {
  state, logger, notifier, nowMs = Date.now(), dryRun = false,
} = {}) {
  const summary = { sent: [], suppressed: [], failed: [], already: 0, errors: [] };

  for (const c of candidates) {
    const key = dedupeKey(c.sessionId, c.state, c.reason, c.evidenceFingerprint);
    const entry = state.notified[key];

    // 边沿已经处理过 → 永不再发。
    // `delivery: 'failed'` 也算「处理过」：发送失败退回仅记录，**不重试**。
    // 若这里放行，下一轮会把同一条再试一次，就是 AC5 禁止的静默重试。
    if (entry && (entry.notifyCount > 0 || entry.delivery === 'failed')) {
      summary.already++;
      continue;
    }

    if (!entry) {
      state.notified[key] = {
        sessionId: c.sessionId,
        state: c.state,
        reason: c.reason,
        firstSeenAt: new Date(nowMs).toISOString(),
        lastNotifiedAt: null,
        notifyCount: 0,
        ackAt: null,
        source: c.source,
      };
    }
    const rec = state.notified[key];

    const gate = canNotify(state, c.sessionId, nowMs);
    if (!gate.ok) {
      rec.suppressedBy = gate.why;
      summary.suppressed.push({ key, sessionId: c.sessionId, why: gate.why });
      continue;
    }

    if (dryRun) {
      summary.sent.push({ key, sessionId: c.sessionId, dryRun: true });
      continue;
    }

    try {
      await notifier({
        title: `${c.state} · ${c.project || (c.sessionId || '').slice(0, 8)}`,
        body: describe(c),
        tag: rec.state.toLowerCase(),
      });
      rec.notifyCount = 1; // 边沿触发：计到 1 就够了，再涨没有意义
      rec.lastNotifiedAt = new Date(nowMs).toISOString();
      delete rec.suppressedBy;
      rec.delivery = 'submitted';
      recordSent(state, c.sessionId, nowMs);
      summary.sent.push({ key, sessionId: c.sessionId });
      if (logger) logger.info(`notified ${c.state} ${c.project || ''} key=${key} session=${c.sessionId}`);
    } catch (e) {
      // 不吞：日志 ERROR + 汇总里可见 + 标成已处理（不重试）
      rec.delivery = 'failed';
      rec.lastError = e.message;
      summary.failed.push({ key, sessionId: c.sessionId, error: e.message });
      summary.errors.push(e);
      if (logger) logger.error(`notify-failed key=${key} session=${c.sessionId}: ${e.message}`);
    }
  }
  return summary;
}

// ── 一次轮询 ──────────────────────────────────────────────────────────

/**
 * 跑一次「到期的层」。返回本次汇总，可被测试直接断言。
 *
 * 顺序上先 L-fast 再 L-mid 再 L-full：便宜的层先跑，贵的层只在到期时才付钱。
 */
export async function runTick({
  dir,
  claudeDir = null,
  nowMs = Date.now(),
  notifier = null,
  logger = null,
  env = process.env,
  dryRun = false,
  forceFull = false,
  scan = runScan,
} = {}) {
  const stateDir = dir || defaultStateDir(env);
  const log = logger || createLogger(stateDir);
  const root = claudeRoot(env, claudeDir);
  mkdirSync(stateDir, { recursive: true });

  const { state, corrupt } = loadState(stateDir, { logger: log });
  const summary = { ran: [], sent: [], suppressed: [], failed: [], already: 0, corrupt, timings: {} };

  const notify = notifier || (async () => { throw new Error('未注入 notifier'); });
  const due = (iso, interval) => {
    if (!iso) return true;
    const t = Date.parse(iso);
    return !Number.isFinite(t) || nowMs - t >= interval;
  };

  let candidates = [];
  let eligible = [];

  // ── L-fast ──
  if (due(state.lastJobsScanAt, JOBS_INTERVAL) || forceFull) {
    const jobs = probeJobs(join(root, 'jobs'));
    summary.ran.push('jobs');
    summary.timings.jobsMs = Math.round(jobs.elapsedMs);
    candidates = candidates.concat(jobs.found);
    state.lastJobsScanAt = new Date(nowMs).toISOString();
  }

  // ── L-mid ──
  if (due(state.lastProbeAt, PROBE_INTERVAL) || forceFull) {
    const probe = probeMtime(join(root, 'projects'));
    summary.ran.push('probe');
    summary.timings.probeMs = Math.round(probe.elapsedMs);
    const firstProbe = !state.probe;
    const changed = diffProbe(state.probe, probe);
    state.probe = foldProbe(state.probe, probe);
    state.lastProbeAt = new Date(nowMs).toISOString();
    summary.changedProjects = changed;

    // 全量也到期时，增量就是纯浪费——全量本来就把所有项目扫一遍。
    // 首次运行（没有探针基线）尤其明显：21 个项目全被判为「变化」，
    // 跑 5 次增量再跑全量，白烧约 10 秒。首轮只建立基线，不扫。
    const fullAlsoDue = forceFull || due(state.lastFullScanAt, FULL_INTERVAL);
    if (firstProbe) {
      log.info(`probe 基线已建立：${probe.projects.length} 个项目（首轮不跑增量，交给全量）`);
    } else if (fullAlsoDue) {
      log.info(`probe changed=${changed.length} 但全量同轮到期，跳过增量`);
    } else {
      // 只对变化的项目跑增量：约 1.5–2s，不是 20s
      for (const project of changed.slice(0, 5)) {
        try {
          const r = await scan({ project, days: 3 });
          candidates = candidates.concat(candidatesFromScan(r.sessions, { nowMs }));
          summary.timings.incrementalMs = Math.round(r.elapsedMs);
          summary.ran.push(`scan:${project}`);
        } catch (e) {
          summary.errors = [...(summary.errors || []), e];
          log.error(`scan-failed project=${project}: ${e.message}`);
        }
      }
    }
  }

  // ── L-full ──
  if (forceFull || due(state.lastFullScanAt, FULL_INTERVAL)) {
    const hasScanned = summary.ran.some((r) => r.startsWith('scan:'));
    // 增量已经把变化的项目扫过了；全量仍按 30 分钟节奏补一次盲区
    try {
      const r = await scan({ project: null, days: 3 });
      candidates = candidates.concat(candidatesFromScan(r.sessions, { nowMs }));
      summary.timings.fullMs = Math.round(r.elapsedMs);
      summary.ran.push('full');
      state.lastFullScanAt = new Date(nowMs).toISOString();
      // L-full 未完成时不清空上一次结果：这里失败就保留旧值
    } catch (e) {
      summary.errors = [...(summary.errors || []), e];
      log.error(`full-scan-failed: ${e.message}`);
      void hasScanned;
    }
  }

  // 去重：同一 session 同一时刻可能被两层各报一次，按 key 收敛
  const seen = new Set();
  for (const c of candidates) {
    const k = dedupeKey(c.sessionId, c.state, c.reason, c.evidenceFingerprint);
    if (seen.has(k)) continue;
    seen.add(k);
    eligible.push(c);
  }

  const dispatched = await dispatchCandidates(eligible, {
    state, logger: log, notifier: notify, nowMs, dryRun,
  });
  summary.sent = dispatched.sent;
  summary.suppressed = dispatched.suppressed;
  summary.failed = dispatched.failed;
  summary.already = dispatched.already;
  if (dispatched.errors.length) summary.errors = [...(summary.errors || []), ...dispatched.errors];

  saveState(stateDir, state);

  const parts = [];
  for (const layer of summary.ran) parts.push(layer);
  if (summary.timings.jobsMs != null) parts.push(`jobs=${summary.timings.jobsMs}ms`);
  if (summary.timings.probeMs != null) parts.push(`probe=${summary.timings.probeMs}ms`);
  if (summary.timings.fullMs != null) parts.push(`full=${summary.timings.fullMs}ms`);
  parts.push(`candidates=${eligible.length}`);
  parts.push(`sent=${summary.sent.length}`);
  parts.push(`suppressed=${summary.suppressed.length}`);
  parts.push(`already=${summary.already}`);
  if (summary.failed.length) parts.push(`failed=${summary.failed.length}`);
  log.info(`tick ${parts.join(' ')}`);

  return summary;
}

// ── 常驻循环 ──────────────────────────────────────────────────────────

/**
 * 常驻：每 TICK 检查一次「哪些层到期」。默认 15 秒醒一次——
 * 醒来只做一次 Date.now() 比较，不碰文件系统。
 */
export async function startWatch({
  dir = null,
  claudeDir = null,
  notifier = null,
  logger = null,
  env = process.env,
  tickMs = 15_000,
  signal = null,
  dryRun = false,
} = {}) {
  const stateDir = dir || defaultStateDir(env);
  // 非数字 tickMs 会让 setTimeout 立刻循环、把 CPU 打满。
  // check-structure 的 import 门会拿 (undefined) 调本函数，所以必须挡住。
  const interval = Number.isFinite(tickMs) && tickMs >= 1000 ? tickMs : 15_000;
  const log = logger || createLogger(stateDir, { mirror: (l) => process.stdout.write(l + '\n') });
  log.info(`watch 启动 dir=${stateDir} tick=${interval}ms`);
  let stop = false;
  const stopper = () => { stop = true; };
  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', stopper, { once: true });
  }

  while (!stop) {
    try {
      await runTick({ dir: stateDir, claudeDir, notifier, logger: log, env, dryRun });
    } catch (e) {
      // 单轮失败不该杀死守护进程，但必须留 ERROR
      log.error(`tick-failed: ${e.message}`);
    }
    if (stop) break;
    await new Promise((r) => setTimeout(r, interval));
  }
  log.info('watch 退出');
}

// ── CLI ───────────────────────────────────────────────────────────────

async function main(argv) {
  const flags = new Set(argv);
  if (flags.has('--help') || flags.has('-h')) {
    console.log('用法：node scripts/watch.mjs            # 常驻');
    console.log('      node scripts/watch.mjs --once     # 只跑一轮（到期层）');
    console.log('      node scripts/watch.mjs --full     # 强制全量跑一轮');
    console.log('      node scripts/watch.mjs --dry-run  # 只算不发');
    console.log(`状态目录：${defaultStateDir()}`);
    return;
  }
  const dryRun = flags.has('--dry-run');
  const forceFull = flags.has('--full');

  let notifier;
  try {
    const mod = await import('./notify.mjs');
    if (!mod.isNotificationAvailable()) throw new Error('通知通道不可用（需要 Windows + wscript + powershell）');
    notifier = mod.sendNotification;
  } catch (e) {
    console.error(`通知不可用，本次仅记录：${e.message}`);
    // AC5 的失败路径：退回「仅记录」，而不是假装通知成功
    notifier = async () => { throw new Error(`通知不可用：${e.message}`); };
  }

  if (flags.has('--once') || forceFull) {
    const s = await runTick({
      notifier,
      logger: createLogger(defaultStateDir(), { mirror: (l) => console.log(l) }),
      dryRun,
      forceFull,
    });
    if (s.errors && s.errors.length) process.exitCode = 1;
    return;
  }

  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  process.on('SIGTERM', () => ac.abort());
  await startWatch({ notifier, signal: ac.signal, dryRun });
}

const isDirect = process.argv[1] && /watch\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isDirect) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}

// 供测试与自检使用
export const __internals = { JOBS_INTERVAL, PROBE_INTERVAL, FULL_INTERVAL, PER_SESSION_MAX_24H, GLOBAL_MAX_24H, GLOBAL_MIN_GAP, LOG_MAX_BYTES, ACTIVE_WINDOW };
