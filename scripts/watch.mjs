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
 *
 * 通知门（v2）：state → 停止分类 kind → **UNCLASSIFIABLE 的 5 分钟时间门槛** → 去重 → 限额。
 * 时间门槛针对的是"刚停下"这一类噪音：在线路径 87.7% 的停止判为 UNCLASSIFIABLE。
 *
 * ⚠ 2026-10-31 更正：本文件曾写"94% 在 5 分钟内继续"，那个数字是错的。
 * 它统计的是"停止后的下一条记录"，其中 3479/4577 是宿主 0.1 秒后写入的
 * stop_hook_summary，不是人继续了。只看真人接话，60 秒内继续的比例是 3.6%，
 * p50 是 3.1 小时。见 docs/research/2026-10-31-replay-observations.md §五。
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

/** state.json 替换失败时的重试次数（Windows rename 非原子，见 saveState）。 */
const STATE_RENAME_RETRIES = 4;

/** 只对「最近还有活动」的会话告警。一周前就停了的会话不是新闻，
 *  首轮跑起来会把它们全当新边沿，一次刷屏 20 条。 */
const ACTIVE_WINDOW = 24 * HOUR;

/** 需要通知的终态。
 *
 *  **只有宿主明确报的两种。** 删掉 STALLED 和推断来的 FAILED 是 2026-10-31 的决定，
 *  依据是两条实测：
 *
 *  - `STALLED` 从未触发过。129 个会话里 novelty 最小值 0.60，而判 STALLED 要求
 *    连续三窗 < 0.2。它是配置里的一条死规则。
 *  - 间隔推断的 FAILED 误报。大间隔之后 94.8% 的会话还有 tool_use；
 *    且 3697 次 `sleep N` 里 3470 次 ≥30 秒 —— 「心跳断裂」测到的主要是宿主在故意等待。
 *
 *  锐评的原话：「通知只能由宿主事实触发」。剩下的判定能力等于
 *  `claude agents --json` 的 busy/idle/blocked 加一次 Write 检测 —— 这是诚实的边界。
 */
export const NOTIFY_STATES = ['WAITING', 'FAILED', 'BLOCKED'];

const SCAN_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'scan-sessions.mjs');
/** 本仓库根目录。用于归属检查：判断是否被另一个克隆共用数据目录。 */
const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// ── 路径 ──────────────────────────────────────────────────────────────

/** 状态目录。测试与自检通过 OVERWATCH_STATE_DIR 改道，绝不碰真实 LOCALAPPDATA。 */
/** 见证文件（witness）：**故意放在状态目录外面**。
 *
 *  为什么需要它：状态目录不存在时无从判断是「第一次运行」还是「数据丢了」——
 *  `mkdirSync(recursive)` 会静默重建，于是两者表现完全一样。
 *  2026-10-31 实测：`%LOCALAPPDATA%\Overwatch\` 整个目录消失，5,348 行生产日志、
 *  状态、观察记录一起没了，而 watcher 照常运行、照常重建目录。**没有任何告警。**
 *
 *  见证文件记录「上一次成功保存状态的时间与路径」。目录被删后它仍在，
 *  于是下一次启动能区分：
 *    witness 存在 + state.json 不存在 → **数据丢失**，大声告警
 *    两者都不存在                     → 真正的首次运行，正常静默
 *
 *  它自己也会丢（同一块盘、同一次清理），所以这不是备份，只是**一次诚实性检查**。
 *  真正的持久化是另一个问题，见 DF-021。 */
export function witnessPath(stateDir) {
  // 兄弟文件而不是「往上一级」：<Local>/Overwatch → <Local>/Overwatch.witness.json
  //
  // 早先写成 dirname(dirname(stateDir))，对 `<Local>/Overwatch` 恰好得出 `<Local>`，
  // 但对**任意目录**（比如测试用的临时目录）会塌到公共父目录上，
  // 于是不同 stateDir 共用同一个见证文件、互相污染——测试当场抓到：
  // 上一个用例留下的见证让下一个用例误报「数据丢失」，多发一条通知。
  // 兄弟文件的语义对所有目录形状都成立：删掉目录，文件还在。
  const d = String(stateDir).replace(/[\\/]+$/, '');
  return `${d}.witness.json`;
}

export function readWitness(stateDir) {
  const p = witnessPath(stateDir);
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

export function writeWitness(stateDir, { nowMs = Date.now(), version = 1 } = {}) {
  const p = witnessPath(stateDir);
  try {
    const prev = readWitness(stateDir) || {};
    writeFileSync(p, JSON.stringify({
      version,
      // dir 是绝对路径，只写在本机文件里，不进仓库、不写日志原文
      dir: String(stateDir),
      firstSeenAt: prev.firstSeenAt || new Date(nowMs).toISOString(),
      lastSavedAt: new Date(nowMs).toISOString(),
      saves: Number(prev.saves || 0) + 1,
    }, null, 2) + '\n', 'utf8');
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, path: p, error: e.message };
  }
}

/** 启动时的完整性检查。返回 { lost, witness, stateExists }。
 *
 *  **lost = true 表示「见证说这里曾经有数据，但数据不见了」。**
 *
 *  注意这里刻意**不**阻止守护进程运行：监控坏了的第一反应不该是「干脆不监控」。
 *  调用方负责大声告警；想要硬失败的人用 --strict。 */
export function checkStateIntegrity(stateDir, { nowMs = Date.now() } = {}) {
  const stateExists = existsSync(statePath(String(stateDir)));
  const witness = readWitness(stateDir);
  if (!witness) return { lost: false, firstRun: true, witness: null, stateExists, previousSaves: 0 };
  const previousSaves = Number(witness.saves || 0);
  const lost = !stateExists && previousSaves > 0;
  return {
    lost,
    firstRun: false,
    witness,
    stateExists,
    previousSaves,
    lastSavedAt: witness.lastSavedAt || null,
  };
}

/** 数据目录的归属标记：记录是哪个仓库在用它。
 *
 *  为什么需要：`defaultStateDir()` 是个固定路径，**完全不看仓库位置**。
 *  这在正常情况是对的（换目录、换版本都不丢数据），但同一台机器上有两份克隆时，
 *  它们会共用同一个 `state.json`、抢同一个 `rename`、发重复通知，
 *  而**没有任何地方会提示这件事**。
 *
 *  2026-11-01 实测：把仓库复制到临时目录跑，`--health` 报的是原仓库进程的数据，
 *  看起来一切正常。
 *
 *  这里不改变路径（那会让「换了目录数据就丢」），只让冲突可见。 */
export function ownerPath(stateDir) {
  return join(String(stateDir).replace(/[\/]+$/, ''), 'owner.json');
}

export function readOwner(stateDir) {
  try {
    const j = JSON.parse(readFileSync(ownerPath(stateDir), 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

/** 声明/校验归属。返回 { owner, previous, conflict }。
 *  conflict = 记录里的仓库路径与当前不同 → 两份克隆在共用一个数据目录。 */
export function claimOwnership(stateDir, repoPath, { nowMs = Date.now() } = {}) {
  const prev = readOwner(stateDir);
  const me = String(repoPath || '').replace(/[\/]+$/, '');
  const conflict = Boolean(prev && prev.repo && me && prev.repo !== me);
  const record = {
    repo: me,
    firstSeenAt: conflict ? (prev.firstSeenAt || new Date(nowMs).toISOString()) : (prev?.firstSeenAt || new Date(nowMs).toISOString()),
    lastSeenAt: new Date(nowMs).toISOString(),
    // 冲突时保留上一个仓库，让人能看到是谁在抢
    alsoUsedBy: conflict ? [...new Set([...(prev.alsoUsedBy || []), prev.repo])].filter(Boolean) : (prev?.alsoUsedBy || []),
  };
  try {
    mkdirSync(String(stateDir), { recursive: true });
    writeFileSync(ownerPath(stateDir), JSON.stringify(record, null, 2) + '\n', 'utf8');
  } catch { /* 写不了也继续跑，这只是元数据 */ }
  return { owner: record, previous: prev, conflict };
}

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
      // 归档而不是覆盖 watch.log.1。实测日志约 511 KB/天、上限 1 MiB，
      // 所以「只留一份」意味着**每两天永久丢掉更早的全部日志**。
      // 那是排查「昨晚到底发生了什么」时唯一的东西。
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archived = join(target, `watch.${stamp}.log`);
      try { renameSync(file, archived); } catch {
        // 归档失败时退回旧行为，至少不让日志无限增长
        try { rmSync(rotated, { force: true }); } catch { /* ignore */ }
        try { renameSync(file, rotated); } catch { /* ignore */ }
      }
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

  // 已通知条目会永久占据去重表。会话被清理后（Claude Code 会删临时 transcript），
  // 条目就再也不会被匹配到，只会让 state.json 一路膨胀。
  // 实测：跑了一晚攒下 10 条，其中一半指向已经不存在的会话。
  // 按 firstSeenAt 的年龄清理，只保留还在 24h 去重窗口内的。
  const pruned = pruneNotified(state.notified, Date.now());
  if (pruned.removed && logger) {
    logger.info(`state 清理：移除 ${pruned.removed} 条超过 ${NOTIFIED_TTL_HOURS}h 的已通知条目`);
  }

  return { state, corrupt: false };
}

/** 已通知条目保留多久。与限额窗口同为 24h：
 *  超过这个年龄的条目既不会再被去重命中（会话早就过去了），
 *  也不该继续占内存。 */
export const NOTIFIED_TTL_HOURS = 24;

/** 原地删除过期的已通知条目，返回移除数。
 *  年龄从 firstSeenAt 算；时间不可解析的也删掉——那说明条目本身是坏的。 */
export function pruneNotified(notified, nowMs = Date.now()) {
  if (!notified || typeof notified !== 'object') return { removed: 0 };
  const cutoff = nowMs - NOTIFIED_TTL_HOURS * 3600_000;
  let removed = 0;
  for (const [k, v] of Object.entries(notified)) {
    const t = Date.parse(v && v.firstSeenAt);
    if (!Number.isFinite(t) || t < cutoff) {
      delete notified[k];
      removed++;
    }
  }
  return { removed };
}

/** tmp + rename 原子替换。写到一半崩掉不会留下半截 JSON。
 *
 *  Windows 上 rename 不是原子的：目标文件被另一个进程打开时抛 EPERM。
 *  实测过两个实例（一个真身、一个 --dry-run）同时跑，真身每几小时就
 *  tick-failed 一次。现在重试几次，仍失败则抛出一条能读懂的错误——
 *  调用方看到的是「另一个实例在写」，不是一句裸的 EPERM。 */
export function saveState(dir, state) {
  const target = asPath(dir);
  if (!target) throw new TypeError('saveState: dir 必须是字符串路径');
  mkdirSync(target, { recursive: true });
  const p = statePath(target);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, p);
      return;
    } catch (e) {
      const transient = e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES');
      if (!transient || attempt >= STATE_RENAME_RETRIES) {
        try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
        if (transient) {
          const err = new Error(
            `state.json 被另一个进程占用（重试 ${attempt} 次仍失败）。` +
            '很可能有第二个 watcher 实例在跑——用 `--dry-run` 也会抢锁。'
          );
          err.cause = e;
          throw err;
        }
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1));
    }
  }
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
/** 读 ~/.claude/sessions/*.json —— 宿主的**实时**会话状态，含 waiting。
 *
 *  为什么单独一个探针而不是并进 probeJobs：两个数据源的更新节奏完全不同。
 *  jobs/*.json 只在这台机器跑过后台作业时出现（实测 25.6 天里 3 次 failed/blocked），
 *  而 sessions/*.json 每个活着的交互会话都有一份，status 随一次对话实时翻转。
 *  把前者放进 1 分钟轮询是对的（它稀疏但关键），后者同样便宜（纯读小 JSON）。
 *
 *  waiting 与 jobs 的 failed/blocked 有本质区别：
 *    failed/blocked —— 过去发生的事实，会留着
 *    waiting        —— 此刻为真，用户一回话就消失
 *  后者才是「叫醒用户」真正需要的信号。
 *
 *  逆向来源：claude.exe 2.1.270，wS = { running:"busy", requires_action:"waiting", idle:"idle" }
 *  与 bVo() 的五个判定分支。见 scan-sessions.mjs 的 readLiveSessions 注释。 */
/** 读全部会话状态（不限 waiting），供可追溯性检查使用。
 *
 *  `probeWaiting` 只返回 waiting 的（它是通知源），但 `--trace` 需要看到**所有**
 *  会话的 status，才能判断某条 WAITING 通知对应的会话当时是不是真的在等。
 *  两者共用同一份文件格式，但目的不同，不要合并。 */
export function readLiveSessionStates(claudeDir = null) {
  const root = join(String(claudeDir || join(homedir(), '.claude')), 'sessions');
  const out = [];
  let files;
  try { files = readdirSync(root); } catch { return out; }
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    let s;
    try { s = JSON.parse(readFileSync(join(root, name), 'utf8')); } catch { continue; }
    if (!s.sessionId) continue;
    out.push({
      sessionId: s.sessionId,
      status: s.status || null,
      waitingFor: typeof s.waitingFor === 'string' ? s.waitingFor : null,
      statusUpdatedAt: s.statusUpdatedAt ?? null,
    });
  }
  return out;
}

export function probeWaiting(sessionsRoot, { nowMs = Date.now() } = {}) {
  const started = process.hrtime.bigint();
  const found = [];
  let scanned = 0;
  let skipped = 0;
  const target = asPath(sessionsRoot);
  if (!target || !existsSync(target)) return { found, scanned, skipped, elapsedMs: 0 };
  let files;
  try { files = readdirSync(target); } catch (e) {
    throw new Error(`读取 sessions 目录失败：${target}：${e.message}`);
  }
  for (const name of files) {
    if (!name.endsWith('.json')) { skipped++; continue; }
    let s;
    try { s = JSON.parse(readFileSync(join(target, name), 'utf8')); } catch { skipped++; continue; }
    if (!s.sessionId) { skipped++; continue; }
    scanned++;
    if (s.status !== 'waiting') { skipped++; continue; }
    const updated = Number(s.statusUpdatedAt ?? s.updatedAt ?? 0);
    if (!Number.isFinite(updated) || updated <= 0) { skipped++; continue; }
    // 和其他状态用同一个活跃窗口：一个 20 天前就 waiting 的记录不是新闻
    if (nowMs - updated > ACTIVE_WINDOW) { skipped++; continue; }
    found.push({
      sessionId: s.sessionId,
      state: 'WAITING',
      reason: s.waitingFor ? `waiting:${s.waitingFor}` : 'host-reported-waiting',
      waitingFor: s.waitingFor || null,
      project: s.cwd ? s.cwd.split(/[\\/]/).pop() : (s.name || null),
      detail: s.waitingFor || null,
      needs: typeof s.needs === 'string' ? s.needs : null,
      suggestedReply: null,
      updatedAt: new Date(updated).toISOString(),
      idleSec: Math.round((nowMs - updated) / 1000),
      source: 'sessions',
    });
  }
  return {
    found,
    scanned,
    skipped,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
  };
}

export function probeJobs(jobsRoot, { nowMs = Date.now() } = {}) {
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
    if (!Number.isFinite(updated) || nowMs - updated > ACTIVE_WINDOW) { skipped++; continue; }
    found.push({
      sessionId,
      state: job.state === 'failed' ? 'FAILED' : 'BLOCKED',
      reason: job.state === 'failed' ? 'host-reported-failed' : 'host-reported-blocked',
      project: job.cwd ? job.cwd.split(/[\\/]/).pop() : null,
      detail: job.detail || null,
      needs: job.needs || null,
      suggestedReply: job.suggestedReply || null,
      updatedAt: job.updatedAt || null,
      // 时间门槛需要「停/失败了多久」。jobs 的权威时间戳是 updatedAt，
      // 上面已经保证它可解析且在活跃窗口内，所以这里一定拿得到。
      idleSec: Math.round((nowMs - updated) / 1000),
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
      // scan 一般会直接给 idleSec；缺了就从 lastActivity 反推，别让时间门槛因为
      // 上游少一个字段而静默失效。
      idleSec: Number.isFinite(s.idleSec)
        ? s.idleSec
        : (Number.isFinite(activity) ? Math.round((nowMs - activity) / 1000) : null),
      lastActivity: s.lastActivity,
      // 证据指纹：会话静止时 lastActivity 稳定；真的「卡在别处」时它会变。
      // 不用 idleSec——那是每轮都在走的，会让去重失效。
      evidenceFingerprint: String(s.lastActivity || '').replace(/\D/g, '').slice(-10),
      suggestedReply: s.suggestedReply || null,
      source: 'scan',
    });
  }
  return out;
}

// ── 停止分类（P0 观察）────────────────────────────────────────────────
//
// `scan-sessions --json` 只给聚合字段，没有 transcript 尾部，构造不出 stopRecord。
// 所以分类这一步在 watch.mjs 里自己做：只读候选会话的**文件尾部**，不读全量
// （实测单文件可达 59MB），并对同一 mtime 复用上次判定。
//
// 只在「有候选」时付这笔钱。候选通常是 0 个，常见路径开销为 0。

/** 会发通知的 kind。其余一律抑制——理由见下表，不是可调参数：
 *
 *   WAITING_SUBAGENT    否  68% 的停止属于这一类，宿主自己会唤醒（R§3.1）
 *   EXTERNAL_BLOCKED    是  卡在外部条件，用户需要知道（不设时间门槛：jobs 是确定信号）
 *   WAITING_APPROVAL    是  等用户批准（不设时间门槛）
 *   ASKED_UNANSWERED    是  问了没答（不设时间门槛）
 *   PLAN_SUBMITTED      是  计划等批准（不设时间门槛：plan 模式本来就要人批）
 *   COMPLETION_REPORT   否  做完了不需要催（完成与停滞不可分，但不必通知）
 *   ASKED_AND_ANSWERED  否  已经在对话里答过了
 *   UNCLASSIFIABLE      是  保守：判不了就当需要注意 —— **但先过 5 分钟时间门槛**，
 *                            否则 87.7% 的在线停止会把它变成刷屏源（见 UNCLASSIFIABLE_MIN_IDLE_SEC）
 */
export const NOTIFY_KINDS = Object.freeze([
  'EXTERNAL_BLOCKED', 'WAITING_APPROVAL', 'ASKED_UNANSWERED', 'PLAN_SUBMITTED', 'UNCLASSIFIABLE',
]);

/** 由宿主直接写下、不经过 transcript 推断的状态。
 *
 *  这三者对「分类门 / 时间门」免疫，理由相同：它们不是「这次停止是问句还是结束」的猜测，
 *  而是宿主自己的结论。拿分类器再判一遍，只会把确定信号降级成不确定的。
 *  ——实测：WAITING 候选会被 classifyCandidate 判成 UNCLASSIFIABLE + classify:error
 *  （sessions/ 里没有对应停止点），然后撞上 5 分钟时间门被抑制。 */
export const HOST_FACT_STATES = Object.freeze(['WAITING', 'FAILED', 'BLOCKED']);

/** `UNCLASSIFIABLE` 的最短观察期，秒。默认 5 分钟。
 *
 *  为什么需要：在线路径下 87.7% 的停止判为 UNCLASSIFIABLE，而它是「保守放行」的。
 *  实测 162300 个「停止 → 下一条记录」样本：p50=1s、p75=6s、p90=102s、p95=395s，
 *  但那个数字测的是"下一条记录"，不是"下一句人话"——其中 95% 是宿主 0.1 秒后写的
 *  stop_hook_summary。只看真人接话：<60s 3.6%、<300s 9.5%、p50 3.1 小时。
 *
 *  更关键的是：实测候选的 idleSec 中位数是 1052 秒，300 秒门槛碰不到绝大多数样本。
 *  把门槛从 60 调到 300，通知量几乎不变。这个门槛目前是"空门"，留着是因为
 *  它挡的是理论上的边界情况，不是实际噪音。见 docs/research/2026-10-31-replay-observations.md。
 *  停得久仍不动才是信号——这不需要预测未来，只需要观察过去。
 *  详见 docs/research/2026-10-31-online-classification.md §6 第 3 条。
 *
 *  **只作用于 UNCLASSIFIABLE**：其余 kind 要么本来就抑制，要么本身就是确定信号
 *  （jobs 的 blocked、结构化工具调用），拿时间再筛一遍只会漏报。
 *
 *  覆盖：环境变量 OVERWATCH_UNCLASSIFIABLE_MIN_IDLE（秒，非负整数）。 */
export const UNCLASSIFIABLE_MIN_IDLE_SEC = 300;

/** 读取门槛，坏值退回默认而不是让守护进程炸掉。
 *  `0` 是合法值（等价于关掉门槛），所以不能用 `||` 判空。 */
export function unclassifiableMinIdleSec(env = process.env) {
  const raw = env && env.OVERWATCH_UNCLASSIFIABLE_MIN_IDLE;
  if (raw == null || String(raw).trim() === '') return UNCLASSIFIABLE_MIN_IDLE_SEC;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : UNCLASSIFIABLE_MIN_IDLE_SEC;
}

/** 时间门槛的判定。**只在 kind === 'UNCLASSIFIABLE' 时生效**。
 *
 *  idleSec 未知（null / 非数字）时不抑制——上游数据缺失不能变成「永远不通知」，
 *  那会把一次采集缺陷伪装成一次正常的保守行为。 */
export function tooRecentToNotify(kind, idleSec, minIdleSec = UNCLASSIFIABLE_MIN_IDLE_SEC) {
  if (kind !== 'UNCLASSIFIABLE') return false;
  if (!Number.isFinite(idleSec)) return false;
  if (!Number.isFinite(minIdleSec) || minIdleSec <= 0) return false;
  return idleSec < minIdleSec;
}

/** 只读尾部 1MB。一个停止点及其后的记录远小于这个量；
 *  permissionMode 按要求只扫停止点附近的窗口，不追到会话开头。 */
const TAIL_READ_BYTES = 1024 * 1024;

/** 观察日志单文件 5MB，超出轮转到 observations.jsonl.1（只留一份）。 */
export const OBS_MAX_BYTES = 5 * 1024 * 1024;

/** 判定缓存：path → { mtimeMs, size, verdict }。mtime 未变就复用。
 *  上限 512 条，超出丢最旧的——缓存只是省一次读盘，丢了不影响正确性。 */
const classifyCache = new Map();
const CACHE_MAX = 512;

/** sessionId → transcript 路径的索引，只在直接路径不存在时才建，60 秒内复用。
 *  为什么需要：jobs 里的 `project` 是 cwd 的 basename（如 `demo`），
 *  而 transcript 目录名是编码后的绝对路径（如 `D--Projects-Overwatch`），两者对不上。 */
let transcriptIndex = { root: null, at: 0, map: new Map() };

function rememberVerdict(cache, key, entry) {
  const store = cache instanceof Map ? cache : classifyCache;
  if (store.size >= CACHE_MAX) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, entry);
}

/**
 * 读 JSONL 文件尾部。返回 { records, truncated }。
 * 与 scan-sessions.mjs 同样按偏移读，不先整读再切片——那是 59MB 的浪费。
 * 被截断的首行直接丢弃（解析它只会得到一个必然失败的行）。
 */
export function readTranscriptTail(path, maxBytes = TAIL_READ_BYTES) {
  const target = asPath(path);
  if (!target) return { records: [], truncated: false };
  let raw;
  let truncated = false;
  try {
    const size = statSync(target).size;
    const n = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : TAIL_READ_BYTES;
    if (size > n) {
      const buf = Buffer.allocUnsafe(n);
      const fd = openSync(target, 'r');
      try { readSync(fd, buf, 0, n, size - n); } finally { closeSync(fd); }
      raw = buf.toString('utf8');
      const firstNl = raw.indexOf('\n');
      if (firstNl >= 0) raw = raw.slice(firstNl + 1);
      truncated = true;
    } else {
      raw = readFileSync(target, 'utf8');
    }
  } catch {
    return { records: [], truncated: false };
  }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* 坏行不影响其余记录 */ }
  }
  return { records, truncated };
}

/**
 * 定位停止点：**最后一条 assistant 记录**，并切出它之后的记录与前文窗口。
 *
 * 为什么不是「最后一条 stop_reason === 'end_turn'」：AskUserQuestion 与
 * ExitPlanMode 的停止点 stop_reason 是 `tool_use`（classify-stop.mjs 文件头已警告）。
 * 只挑 end_turn 会让 PLAN_SUBMITTED / ASKED_UNANSWERED 这两类通知永远不可能出现，
 * 而那正是本任务要接上的信号。按 message.id 去重是另一回事：同一轮会产生多条
 * assistant 记录（thinking 分片 / text 分片），它们共享同一个 id，取最后一条即可。
 *
 * 返回 { stopRecord, afterRecords, history, stopReason }；没有 assistant 时返回 null。
 */
export function findStopPoint(records) {
  const arr = Array.isArray(records) ? records : [];
  let stopIdx = -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] && arr[i].type === 'assistant') { stopIdx = i; break; }
  }
  if (stopIdx < 0) return null;
  const stopRecord = arr[stopIdx];
  return {
    stopRecord,
    afterRecords: arr.slice(stopIdx + 1),
    history: arr.slice(0, stopIdx + 1),
    stopReason: (stopRecord.message && stopRecord.message.stop_reason) || null,
  };
}

/** 解析 `~/.claude/projects/<project>/<sessionId>.jsonl`。
 *  先试候选自带的 project 名（scan 给的是真实目录名）；不成立时走索引。 */
function resolveTranscriptPath(projectsRoot, sessionId, projectHint, nowMs) {
  const root = asPath(projectsRoot);
  if (!root || !sessionId) return null;
  if (typeof projectHint === 'string' && projectHint) {
    const direct = join(root, projectHint, `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
  }
  if (transcriptIndex.root !== root || nowMs - transcriptIndex.at > 60_000) {
    const map = new Map();
    try {
      for (const project of readdirSync(root)) {
        if (project === 'memory') continue;
        let entries;
        try { entries = readdirSync(join(root, project)); } catch { continue; }
        for (const e of entries) {
          if (e.endsWith('.jsonl')) map.set(e.slice(0, -6), join(root, project, e));
        }
      }
    } catch { /* 目录不可读：退回「没有 transcript」，由调用方记 error */ }
    transcriptIndex = { root, at: nowMs, map };
  }
  return transcriptIndex.map.get(sessionId) || null;
}

/** 抑制原因。只描述「为什么没有发」，`why` 在派发阶段会被实际结果覆盖
 *  （sent / dry-run / already-notified / budget-* / notify-failed）。 */
function suppressionWhy(kind) {
  if (NOTIFY_KINDS.includes(kind)) return 'notifyable';
  return `${String(kind).toLowerCase().replace(/_/g, '-')}-suppressed`;
}

/**
 * 对一个候选做停止分类，返回可直接写进观察日志的记录。
 *
 * 失败/异常路径明确退回按 state 判断（保持接入前的行为），并标 classify:'error'——
 * 绝不静默：分类器判不了不等于「不用管」，也不等于「可以当作没发生」。
 */
export function classifyCandidate(candidate, {
  projectsRoot = null, nowMs = Date.now(), logger = null, cache = classifyCache,
} = {}) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const base = {
    ts: new Date(nowMs).toISOString(),
    sessionId: c.sessionId || null,
    state: c.state || null,
    // 当时停了多久。P1 要靠它回答「门槛设 300 秒合不合适」：
    // 被抑制的那批里后来有多少真的卡住了，只能靠这个字段回头核对。
    idleSec: Number.isFinite(c.idleSec) ? c.idleSec : null,
    kind: 'UNCLASSIFIABLE',
    autoAnswerable: false,
    reason: '',
    confidence: null,
    notified: false,
    why: '',
    classify: 'ok',
    stopId: null,
  };

  let verdict;
  try {
    const path = resolveTranscriptPath(projectsRoot, c.sessionId, c.project, nowMs);
    if (!path) {
      return { ...base, classify: 'error', reason: '找不到该会话的 transcript（jobs 里的后台作业可能没有）', why: 'classify-error' };
    }
    let mtimeMs = 0;
    let size = 0;
    try { const st = statSync(path); mtimeMs = st.mtimeMs; size = st.size; } catch { /* 下面按读不到处理 */ }

    const cached = cache.get(path);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size && mtimeMs > 0) {
      verdict = cached.verdict;
    } else {
      const { records, truncated } = readTranscriptTail(path);
      const stop = findStopPoint(records);
      const jobs = c.state === 'BLOCKED'
        ? { state: 'blocked', needs: c.needs || '', suggestedReply: c.suggestedReply || null }
        : null;
      verdict = stop
        ? classifyStop({ stopRecord: stop.stopRecord, afterRecords: stop.afterRecords, history: stop.history, jobsState: jobs })
        : { kind: 'UNCLASSIFIABLE', noStop: true, autoAnswerable: false, reason: `transcript 尾部（${TAIL_READ_BYTES} 字节）内没有 assistant 记录，定位不到停止点`, confidence: null, evidence: {} };
      verdict.evidence = { ...(verdict.evidence || {}), tailTruncated: truncated };
      if (mtimeMs > 0) rememberVerdict(cache, path, { mtimeMs, size, verdict });
    }
  } catch (e) {
    if (logger) logger.error(`classify-failed session=${c.sessionId}: ${e.message}`);
    return { ...base, classify: 'error', reason: `分类异常：${e.message}`, why: 'classify-error' };
  }

  // 「定位不到停止点」不是判定结论，是输入不完整 —— 标成 error，别混进分类分布里
  const classify = verdict.noStop ? 'error' : 'ok';
  return {
    ...base,
    kind: verdict.kind,
    autoAnswerable: verdict.autoAnswerable === true,
    reason: verdict.reason || '',
    confidence: verdict.confidence ?? null,
    stopId: (verdict.evidence && verdict.evidence.stopUuid) || null,
    classify,
    why: classify === 'error' ? 'classify-error' : suppressionWhy(verdict.kind),
  };
}

/**
 *  观察日志：追加写，不覆盖；单文件 5MB 轮转。
 * 这是 P1 的数据来源，所以**每一条判定都要记**，包括被抑制的——
 * 只记发出去的那几条，就永远看不到分类分布。
 *
 * 去重：同一个停止事件（sessionId|state|kind|fingerprint|why）在**同一进程生命周期内**
 * 只写一行。扫描每 5 分钟就会再报一次同一个停滞会话。重启后最多再写一行，
 * 这个方向的误差有界，比重复 288 行好。
 */
/** 观察日志去重集：file → Set(key)。必须是**进程级**的——
 *  createObservationLog 每轮 tick 都会新建，若把 Set 放在闭包里，
 *  同一个停滞会话每 5 分钟就会再写一行，一天 288 行，把分布压向「停得久的」。 */
const observationSeen = new Map();

export function createObservationLog(dir, { maxBytes = OBS_MAX_BYTES } = {}) {
  const target = asPath(dir);
  if (!target) {
    return { path: null, append: () => {} };
  }
  mkdirSync(target, { recursive: true });
  const file = join(target, 'observations.jsonl');
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : OBS_MAX_BYTES;
  if (!observationSeen.has(file)) observationSeen.set(file, new Set());
  const seen = observationSeen.get(file);

  return {
    path: file,
    append(rows) {
      const list = (Array.isArray(rows) ? rows : [rows]).filter((r) => {
        if (!r || typeof r !== 'object') return false;
        const k = `${r.sessionId}|${r.state}|${r.kind}|${r.fingerprint || ''}|${r.why}`;
        if (seen.has(k)) return false;
        if (seen.size >= 10_000) seen.clear();   // 有界：只是为了少写重复行
        seen.add(k);
        return true;
      });
      if (!list.length) return;
      const buf = Buffer.from(list.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      // 只在上限之外才轮转；比上限还大的一条也要写下去，不能静默丢
      try {
        let size = 0;
        try { size = statSync(file).size; } catch { size = 0; }
        if (size > 0 && size + buf.length > limit) {
          // 归档而不是覆盖。旧实现是「轮转到 .1，只留一份」——最早的证据会被永久删掉，
          // 而观察期的全部价值来自积累。现在每次轮转另存一个带时间戳的文件，
          // **从不删除**。存档多了由人决定怎么处理，不由程序替你决定。
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const archived = join(target, `observations.${stamp}.jsonl`);
          try { renameSync(file, archived); } catch { /* 归档失败就别动原文件，继续写 */ }
        }
        appendFileSync(file, buf);
      } catch { /* 写不了观察日志不能让守护进程死掉；由调用方的日志记 WARN */ }
    },
  };
}

export function readObservationRows(dir) {
  const target = asPath(dir);
  const out = [];
  if (!target) return out;
  // 归档名形如 observations.2026-10-31T16-00-00-000Z.jsonl，按名排序即时间序。
  // 一并读入：--stats 必须看到全部历史，否则「攒够样本再判定」永远攒不够。
  let names = [];
  try { names = readdirSync(target); } catch { /* 目录不存在 */ }
  const archived = names
    .filter((n) => /^observations..+.jsonl$/.test(n))
    .sort();
  for (const name of [...archived, 'observations.jsonl']) {
    let raw;
    try { raw = readFileSync(join(target, name), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 半截行：写轮转时的正常残片 */ }
    }
  }
  return out;
}

/** UNCLASSIFIABLE 的时间分桶。边界与「停止 → 下一条记录」的实测分位对齐：
 *  修正后（只看真人接话）：<60s 3.6%、<300s 9.5%、<900s 15.4%，p50 3.1 小时。
 *  看这张表就是为了回答「门槛该不该往前/往后挪」。 */
export const IDLE_BUCKETS = Object.freeze([
  { label: '<60s', min: 0, max: 60 },
  { label: '60-300s', min: 60, max: 300 },
  { label: '300-900s', min: 300, max: 900 },
  { label: '>900s', min: 900, max: Infinity },
]);

/** `--stats`：读观察日志，输出分类分布、通知/抑制比、按 state 的交叉表。 */
export function observationStats(dir) {
  const rows = readObservationRows(dir);
  const res = {
    total: rows.length,
    firstTs: null,
    lastTs: null,
    kinds: [],
    notified: 0,
    suppressed: 0,
    byState: [],
    byState: [],
    unclassifiableIdle: null,
    // classify 的取值分布（'ok' / 'error'）。用于识别「旧策略时期的行」：
    // 宿主事实候选现在不调用分类器，所以新行不会再有 classify=error。
    byClass: {},
  };
  if (!rows.length) return res;

  const kindCount = new Map();
  const stateCount = new Map();
  const cross = new Map();
  const idleBuckets = new Map();
  let unk = 0;
  let unkNoIdle = 0;
  for (const r of rows) {
    const kind = typeof r.kind === 'string' ? r.kind : 'UNKNOWN';
    const cls = typeof r.classify === 'string' ? r.classify : 'none';
    res.byClass[cls] = (res.byClass[cls] || 0) + 1;
    kindCount.set(kind, (kindCount.get(kind) || 0) + 1);
    const state = typeof r.state === 'string' ? r.state : 'UNKNOWN';
    stateCount.set(state, (stateCount.get(state) || 0) + 1);
    if (!cross.has(state)) cross.set(state, new Map());
    const m = cross.get(state);
    m.set(kind, (m.get(kind) || 0) + 1);
    if (r.notified === true) res.notified++;
    else res.suppressed++;
    if (kind === 'UNCLASSIFIABLE') {
      unk++;
      const idle = Number(r.idleSec);
      if (Number.isFinite(idle)) {
        const b = IDLE_BUCKETS.find((x) => idle >= x.min && idle < x.max) || IDLE_BUCKETS[IDLE_BUCKETS.length - 1];
        const cur = idleBuckets.get(b.label) || { n: 0, notified: 0 };
        cur.n++;
        if (r.notified === true) cur.notified++;
        idleBuckets.set(b.label, cur);
      } else {
        unkNoIdle++;
      }
    }
    const ts = typeof r.ts === 'string' ? r.ts : null;
    if (ts) {
      if (!res.firstTs || ts < res.firstTs) res.firstTs = ts;
      if (!res.lastTs || ts > res.lastTs) res.lastTs = ts;
    }
  }
  if (unk > 0) {
    res.unclassifiableIdle = {
      total: unk,
      withoutIdleSec: unkNoIdle,
      buckets: IDLE_BUCKETS.map((b) => ({ label: b.label, ...(idleBuckets.get(b.label) || { n: 0, notified: 0 }) })),
    };
  }
  res.kinds = [...kindCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => ({ kind, n, pct: (n / rows.length) * 100 }));
  res.byState = [...stateCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([state, n]) => ({
      state,
      n,
      kinds: [...cross.get(state).entries()].sort((a, b) => b[1] - a[1]).slice(0, 4),
    }));
  return res;
}

/** 把一个桶的通知情况写成一句话。分布表的价值在于「门槛是否合适」，
 *  所以每个桶要说清楚实际结果，而不是假定「门槛以上一定发了」——
 *  预算/去重也会挡，混在一起才是真实情况。 */
function bucketNote(b, n) {
  if (!n) return '';
  if (b.notified === 0) return '（全部抑制）';
  if (b.notified === n) return '（全部通知）';
  return `（通知 ${b.notified} / 抑制 ${n - b.notified}）`;
}

/** 把 observationStats 的结果排版成 CLI 文本。 */
export function formatStats(stats, { minIdleSec = UNCLASSIFIABLE_MIN_IDLE_SEC } = {}) {
  const s = stats || { total: 0 };
  if (!s.total) return '观察样本：0 条（还没有 observations.jsonl）';
  const day = (iso) => (iso ? String(iso).slice(0, 10) : '?');
  const lines = [`观察样本：${s.total} 条（${day(s.firstTs)} ~ ${day(s.lastTs)}）`, '分类分布：'];
  const pad = 20;
  for (const k of s.kinds) {
    lines.push(`  ${k.kind.padEnd(pad)} ${String(k.n).padStart(5)}  ${k.pct.toFixed(1)}%`);
  }
  lines.push(`通知：发了 ${s.notified} 条，抑制 ${s.suppressed} 条`);
  // 样本里若含「按当前策略不会再产生」的行，必须说出来。
  //
  // 2026-10-31：宿主事实候选改为不调用分类器后，`classify:error` + `UNCLASSIFIABLE`
  // 这类行再也不会产生。但旧行还留在日志里，`--stats` 会照样把它们算进分布，
  // 于是「分类分布」看起来像当前行为，实际是一段已经结束的历史。
  // 分布图本身没错，错的是**没标注它跨了两个不同的策略时期**。
  const stale = s.byClass ? (s.byClass.error || 0) : 0;
  if (stale) {
    lines.push(`  ⚠ 其中 ${stale} 条 classify=error 是旧策略时期的（宿主事实候选现在不调用分类器），`);
    lines.push('    它们不会再产生，但会稀释上面各行的比例。要干净分布请看时间靠后的部分。');
  }


  // 时间维度：直接回答「门槛该不该调」。
  // 若 <300s 桶里出现「通知」，说明门槛没有生效（例如 UNCLASSIFIABLE 之外的原因漏进来）。
  if (s.unclassifiableIdle) {
    const u = s.unclassifiableIdle;
    lines.push(`UNCLASSIFIABLE 按 idle 分布（门槛 ${minIdleSec}s，共 ${u.total} 条）：`);
    for (const b of u.buckets) {
      const pct = ((b.n / u.total) * 100).toFixed(1);
      lines.push(`  ${b.label.padEnd(9)} ${String(b.n).padStart(5)}  ${pct.padStart(5)}%  ${bucketNote(b, b.n)}`.trimEnd());
    }
    if (u.withoutIdleSec) lines.push(`  （另有 ${u.withoutIdleSec} 条缺 idleSec，无法分桶）`);
  }

  lines.push('按 state 交叉：');
  for (const row of s.byState) {
    lines.push(`  ${row.state} → ${row.kinds.map(([k, n]) => `${k} ${n}`).join(' / ')}`);
  }
  return lines.join('\n');
}

// ── 通知投递 ──────────────────────────────────────────────────────────

/** 通知标题。**必须让不确定性和确定性一眼可分。**
 *
 *  回放实测：66 条通知里 64 条是 UNCLASSIFIABLE（97%）。而原来的标题是
 *  `${state} · 项目名`，完全没有体现分类结果 —— 用户看到 "STALLED · foo"
 *  会以为是确认卡住了，实际是「我判不出来」。这是把不确定性包装成确定性，
 *  违反 docs/spec/output-format.md §2.1「不允许估算出一个看起来精确的数」。
 *
 *  Windows toast 默认只显示标题，body 要展开才看得到 —— 所以分类结果必须在标题里。
 */
export function notifyTitle(c) {
  const where = c.project || (c.sessionId || '').slice(0, 8);

  // 宿主事实优先于分类结果。分类器对 WAITING 候选返回 UNCLASSIFIABLE
  // （sessions/ 里没有对应停止点），如果先看 kind，标题会变成
  // 「疑似停滞（判不出类型）」——**把一个确定的等待说成猜测**。
  // 端到端跑真实候选时就是这么暴露的。
  if (c.state === 'WAITING') {
    const what = String(c.reason || '').replace(/^waiting:/, '');
    return what && what !== c.reason
      ? `✋ ${where} · 正在等你（${what}）`
      : `✋ ${where} · 正在等你`;
  }
  if (c.state === 'BLOCKED') return `⏸ ${where} · 受阻`;
  if (c.state === 'FAILED') return `✖ ${where} · 宿主报失败`;

  const kind = c.kind || null;
  if (kind === 'UNCLASSIFIABLE') {
    // 明确告诉用户这是「不确定」，而不是「确认卡住」
    return `？ ${where} · 疑似停滞（判不出类型）`;
  }
  if (kind === 'EXTERNAL_BLOCKED') return `⏸ ${where} · 外部阻塞`;
  if (kind === 'WAITING_APPROVAL') return `⏸ ${where} · 等你批准`;
  if (kind === 'ASKED_UNANSWERED') return `？ ${where} · 问了没答`;
  if (kind === 'PLAN_SUBMITTED') return `📋 ${where} · 计划待批`;
  // 没有分类结果时退回 state，但标注「未分类」
  return `${c.state} · ${where}（未分类）`;
}

function describe(c) {
  const where = c.project ? `${c.project}` : (c.sessionId || '').slice(0, 8);
  const bits = [where, c.reason];
  if (c.kind) bits.push(c.kind);
  if (c.idleSec != null) bits.push(`idle=${Math.round(c.idleSec / 60)}m`);
  if (c.needs) bits.push(`等：${String(c.needs).slice(0, 80)}`);
  return bits.filter(Boolean).join(' · ');
}

/** 落进观察日志的 `why`：分类失败永远标 classify-error，
 *  不能让后面的预算/去重原因把它盖掉——那是要排查的异常，不是一次正常抑制。 */
function outcomeWhy(obs, fallback) {
  return obs && obs.classify === 'error' ? 'classify-error' : fallback;
}

/**
 * 把候选送出去。返回 { sent, suppressed, failed, observations }。
 *
 * AC5：notifier 抛错时动作退回「仅记录」——写 ERROR 日志、把边沿标成已处理
 * （`delivery: 'failed'`），**不自动重试**。不重试是有意的：发不出去的通知
 * 重发只会消耗信任（hosted-mode.md §4.5 第 3 条）。
 *
 * P0 的过滤器在这里：分类不通过的候选**不发**，但仍进 `suppressed` 与观察日志。
 * 「抑制」不是丢弃——不写下来就永远看不到分类分布，P1 也就没有数据。
 */
export async function dispatchCandidates(candidates, {
  state, logger, notifier, nowMs = Date.now(), dryRun = false,
  classify = null, observations = null,
  env = process.env, unclassifiableMinIdle = null,
} = {}) {
  const summary = { sent: [], suppressed: [], failed: [], already: 0, errors: [], observations: [] };
  const baseState = state || emptyState();
  state = baseState;
  const minIdle = unclassifiableMinIdle == null ? unclassifiableMinIdleSec(env) : unclassifiableMinIdle;

  for (const candidate of candidates) {
    const c = { ...candidate };

    // ── 停止分类 ──
    // 宿主事实状态**不调用分类器**。
    //
    // 理由不是「分类器不准」，而是**它对这类候选在结构上不可能有效**：
    // classifyStop 需要 transcript 里的一个停止点，而 WAITING 来自 sessions/*.json，
    // 那些会话可能根本没有可读的 transcript 尾部。实测对一个真实 WAITING 候选调用它，
    // 100% 返回 kind=UNCLASSIFIABLE + classify=error。
    //
    // 调用的代价不是零：它每轮都去读 transcript 尾部，产出却是一行
    // 「找不到该会话的 transcript」写进观察日志，把真实信号淹掉。
    // 2026-10-31 实测观察日志 6 条里 5 条是这种噪音，唯一有信息量的 1 条
    // （ASKED_UNANSWERED）也不影响通知——因为宿主事实本来就跳过分类门。
    //
    // 分类能力保留：将来若重新引入基于 transcript 的推断状态，它立刻重新有用。
    const hostFact = HOST_FACT_STATES.includes(c.state);
    let obs = null;
    if (hostFact) {
      // 宿主事实**不走分类器**（它对这类候选结构上不可能有效，见上），
      // 但**观察日志仍然要写**——P0 的全部数据来源就是它。
      //
      // 2026-10-31 回归：跳过分类器之后 `obs` 恒为 null，而每处记录都是 `if (obs)`
      // 守卫，于是通知照发、观察日志一条不写。`observations.jsonl` 六小时没生成，
      // 我却在看 `--stats` 报 0 条并以为「还没有真实数据」。
      // 记录与分类是两件事，不能因为不分类就连记录一起丢掉。
      obs = {
        ts: new Date(nowMs).toISOString(),
        sessionId: c.sessionId,
        state: c.state,
        idleSec: Number.isFinite(c.idleSec) ? c.idleSec : null,
        // 宿主事实的分类结论就是它自己：不需要猜。
        kind: c.state,
        autoAnswerable: false,
        reason: c.reason || `host-fact:${c.state}`,
        confidence: null,
        notified: false,
        why: null,
        // 'host' 与 'ok' / 'error' 区分开：这三类行来自不同的判定路径，
        // --stats 能据此说清「分布跨了几个策略时期」。
        classify: 'host',
        fingerprint: c.evidenceFingerprint || '',
        // 来源与「在等什么」分开记：前者用于判断哪条管道的候选更准，
        // 后者用于回答「宿主到底说了什么」。两者都能从候选免费拿到，
        // 但缺了它们，事后回看分不出「jobs 报的 blocked」与「sessions 报的 waiting」。
        source: c.source || null,
        waitingFor: c.waitingFor || null,
      };
    }
    if (typeof classify === 'function' && !hostFact) {

      try {
        obs = classify(c);
      } catch (e) {
        // 分类回调自己炸了也不能中断派发：标成 error，退回按 state 通知
        if (logger) logger.error(`classify-failed session=${c.sessionId}: ${e.message}`);
        obs = { ts: new Date(nowMs).toISOString(), sessionId: c.sessionId, state: c.state, idleSec: Number.isFinite(c.idleSec) ? c.idleSec : null, kind: 'UNCLASSIFIABLE', autoAnswerable: false, reason: `分类异常：${e.message}`, confidence: null, notified: false, why: 'classify-error', classify: 'error' };
      }
      if (obs && typeof obs === 'object') {
        obs.fingerprint = c.evidenceFingerprint || '';
        // 观察日志必须能看出「当时停了多久」——即使注入的 classify 回调没带，
        // 也从候选补齐，否则 P1 没法回答「门槛该不该调」。
        if (!Number.isFinite(obs.idleSec) && Number.isFinite(c.idleSec)) obs.idleSec = c.idleSec;
        if (obs.classify !== 'error') {
          c.kind = obs.kind;
          c.autoAnswerable = obs.autoAnswerable;
        }
      } else {
        obs = null;
      }
    }

    const key = dedupeKey(c.sessionId, c.state, c.reason, c.evidenceFingerprint);
    const entry = state.notified[key];

    // 边沿已经处理过 → 永不再发。
    // `delivery: 'failed'` 也算「处理过」：发送失败退回仅记录，**不重试**。
    // 若这里放行，下一轮会把同一条再试一次，就是 AC5 禁止的静默重试。
    if (entry && (entry.notifyCount > 0 || entry.delivery === 'failed')) {
      summary.already++;
      if (obs) summary.observations.push({ ...obs, notified: false, why: outcomeWhy(obs, 'already-notified') });
      continue;
    }

    // ── 宿主事实：跳过分类门与时间门 ──
    // WAITING / FAILED / BLOCKED 都来自宿主自己写下的状态，不是从 transcript 推的。
    // 对它们做「这次停止是不是问句」的分类毫无意义：
    //   实测 WAITING 候选被 classifyCandidate 判成 UNCLASSIFIABLE + classify:error
    //   （因为 sessions 里没有对应的停止点），随后撞上 5 分钟时间门被抑制——
    //   **一个刚发生 5 秒的真实等待，被当成「刚停下，再等等」压掉了。**
    // 这跟 jobs 的 failed/blocked 是同一类东西，本来就该走同一条路。
    const isHostFact = HOST_FACT_STATES.includes(c.state);

    // ── 分类门：不该通知的停止直接抑制 ──
    // kind 门先于去重表登记：被抑制的候选不占用一个 notified 条目，
    // 否则同一会话下次因为别的原因停下来时会被「已处理」挡住。
    if (!isHostFact && obs && obs.classify !== 'error' && !NOTIFY_KINDS.includes(obs.kind)) {
      summary.suppressed.push({ key, sessionId: c.sessionId, why: 'kind-not-notifiable', kind: obs.kind });
      summary.observations.push({ ...obs, notified: false });
      if (logger) logger.info(`suppressed ${c.state} kind=${obs.kind} session=${c.sessionId}`);
      continue;
    }

    // ── 时间门：UNCLASSIFIABLE 刚停下先不发 ──
    // 87.7% 的在线停止判为 UNCLASSIFIABLE。门槛只作用于这一个 kind。
    // 注意：实测候选的 idleSec 中位数 1052s，300s 门槛在真实数据上几乎从不触发 ——
    // 它挡的是理论边界，不是实际噪音。实际压制噪音的是 hb_gap 判据自带的下限。
    // 与 kind 门同样先于 state 登记：被时间门挡下的不占用 notified 条目，
    // 等 idleSec 涨过门槛时同一轮就能正常走后面的流程。
    if (!isHostFact && obs && obs.classify !== 'error' && tooRecentToNotify(obs.kind, c.idleSec ?? obs.idleSec, minIdle)) {
      const idle = c.idleSec ?? obs.idleSec;
      summary.suppressed.push({ key, sessionId: c.sessionId, why: 'unclassifiable-too-recent', kind: obs.kind, idleSec: idle });
      summary.observations.push({ ...obs, idleSec: idle, notified: false, why: 'unclassifiable-too-recent' });
      if (logger) logger.info(`suppressed ${c.state} kind=${obs.kind} idle=${idle}s<${minIdle}s session=${c.sessionId}`);
      continue;
    }

    if (!entry) {
      state.notified[key] = {
        sessionId: c.sessionId,
        state: c.state,
        reason: c.reason,
        kind: c.kind || null,
        firstSeenAt: new Date(nowMs).toISOString(),
        lastNotifiedAt: null,
        notifyCount: 0,
        ackAt: null,
        source: c.source,
        // 收件箱需要的上下文。`state.notified` 原本只是去重表，
        // 但它同时是**唯一持久化下来的「发现了什么」**——调度侧读它比自己重扫便宜且一致。
        project: c.project || null,
        needs: c.needs || null,
        suggestedReply: c.suggestedReply || null,
        idleSec: Number.isFinite(c.idleSec) ? c.idleSec : null,
        lastSeenAt: new Date(nowMs).toISOString(),
      };
    }
    const rec = state.notified[key];

    const gate = canNotify(state, c.sessionId, nowMs);
    if (!gate.ok) {
      rec.suppressedBy = gate.why;
      summary.suppressed.push({ key, sessionId: c.sessionId, why: gate.why });
      if (obs) summary.observations.push({ ...obs, notified: false, why: outcomeWhy(obs, `budget-${gate.why}`) });
      continue;
    }

    if (dryRun) {
      summary.sent.push({ key, sessionId: c.sessionId, dryRun: true, kind: c.kind || null });
      if (obs) summary.observations.push({ ...obs, notified: false, why: outcomeWhy(obs, 'dry-run') });
      continue;
    }

    try {
      await notifier({
        title: notifyTitle(c),
        body: describe(c),
        tag: rec.state.toLowerCase(),
      });
      rec.notifyCount = 1; // 边沿触发：计到 1 就够了，再涨没有意义
      rec.lastNotifiedAt = new Date(nowMs).toISOString();
      rec.kind = c.kind || null;
      delete rec.suppressedBy;
      rec.delivery = 'submitted';
      recordSent(state, c.sessionId, nowMs);
      summary.sent.push({ key, sessionId: c.sessionId, kind: c.kind || null });
      if (obs) summary.observations.push({ ...obs, notified: true, why: null });
      if (logger) logger.info(`notified ${c.state} ${c.project || ''} kind=${c.kind || '-'} key=${key} session=${c.sessionId}`);
    } catch (e) {
      // 不吞：日志 ERROR + 汇总里可见 + 标成已处理（不重试）
      rec.delivery = 'failed';
      rec.lastError = e.message;
      summary.failed.push({ key, sessionId: c.sessionId, error: e.message });
      summary.errors.push(e);
      if (obs) summary.observations.push({ ...obs, notified: false, why: outcomeWhy(obs, `notify-failed: ${e.message}`) });
      if (logger) logger.error(`notify-failed key=${key} session=${c.sessionId}: ${e.message}`);
    }
  }

  if (observations && typeof observations.append === 'function' && summary.observations.length) {
    try {
      observations.append(summary.observations);
    } catch (e) {
      // 观察日志写失败必须可见：它不阻断通知，但会毁掉 P1 的数据来源
      if (logger) logger.warn(`observation-write-failed: ${e.message}`);
      summary.errors.push(e);
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
  classify = null,
  observations = null,
} = {}) {
  const stateDir = dir || defaultStateDir(env);
  const log = logger || createLogger(stateDir);
  const root = claudeRoot(env, claudeDir);

  // 完整性检查必须在 mkdirSync 之前：一旦建了目录，「丢了」和「首次运行」就分不出来了。
  // 归属检查：同一台机器上两份克隆会静默共用同一个 state.json。
  // 不改变路径（那会让「换目录就丢数据」），只让冲突可见。
  const claim = claimOwnership(stateDir, ROOT_DIR, { nowMs });
  if (claim.conflict) {
    const prevRepo = claim.previous && claim.previous.repo;
    const msg = `state-shared: 数据目录 ${stateDir} 已被另一个仓库使用（${prevRepo}）。` +
      '两份克隆共用同一个 state.json 会互相覆盖、发重复通知。';
    if (log) log.error(msg);
    if (log) log.warn('state-shared: 想隔离的话，给其中一份设 OVERWATCH_STATE_DIR 指向不同目录。');
  }

  const integrity = checkStateIntegrity(stateDir, { nowMs });
  const dirExisted = existsSync(stateDir);
  mkdirSync(stateDir, { recursive: true });

  if (integrity.lost) {
    // 大声告警：这是唯一一次能告诉用户「你的历史没了」的时机。
    // 不退出——监控坏了的第一反应不该是「干脆不监控」。
    const msg = `state-lost: 见证文件显示 ${integrity.previousSaves} 次保存（最后 ${integrity.lastSavedAt}），` +
      `但 state.json 和整个状态目录都不在了。历史已丢失，从空状态继续。`;
    if (log) log.error(msg);
    if (log && typeof log.warn === 'function') {
      log.warn('state-lost: 日志与 observations.jsonl 很可能同时在同一次删除中丢失。' +
        '本次运行会重建目录，但不会重建证据。见 tasks/dev-findings.md DF-020。');
    }
    // dry-run 的契约是「只算不发」，对告警同样成立——否则试跑会真的弹窗。
    // 日志里仍然记录，试跑的人看得到。
    if (!dryRun) {
      try {
        const n = notifier || (async () => {});
        await n({
          title: '⚠ Overwatch 状态丢失',
          body: `上次保存于 ${integrity.lastSavedAt || '未知'}，目录现已为空。已从空状态继续运行。`,
          urgency: 'high',
          tag: 'state-lost',
        });
      } catch { /* 通知不通不能拖垮启动，日志里已经写了 */ }
    }
  } else if (integrity.firstRun && !dirExisted) {
    if (log) log.info('首次运行：状态目录不存在且无见证文件，正常初始化');
  }

  const projectsRoot = join(root, 'projects');
  // 默认就接上分类：P0 的核心产物是观察日志，忘了传参就整段产出归零。
  // 传 `classify: () => null` 可显式关掉（测试夹具用）。
  const doClassify = classify === null
    ? ((c) => classifyCandidate(c, { projectsRoot, nowMs, logger: log }))
    : classify;
  const obsLog = observations === null ? createObservationLog(stateDir) : observations;

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
  // 两个来源一起跑：jobs 抓「过去失败过」，sessions 抓「此刻在等你」。
  // 后者才是高频且可行动的信号，但少了前者就看不见后台作业的失败。
  if (due(state.lastJobsScanAt, JOBS_INTERVAL) || forceFull) {
    const jobs = probeJobs(join(root, 'jobs'), { nowMs });
    summary.ran.push('jobs');
    summary.timings.jobsMs = Math.round(jobs.elapsedMs);
    candidates = candidates.concat(jobs.found);
    try {
      const waiting = probeWaiting(join(root, 'sessions'), { nowMs });
      summary.ran.push('waiting');
      summary.timings.waitingMs = Math.round(waiting.elapsedMs);
      candidates = candidates.concat(waiting.found);
    } catch (e) {
      // sessions 目录读不了不该拖垮整轮：jobs 的结果仍然有效
      if (log) log.warn(`waiting-probe-failed: ${e.message}`);
    }
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
    // 全量只在 --full 时跑（见下方 L-full 注释），所以「全量同轮到期就跳过增量」
    // 这个优化已经没有意义了——跳过增量的唯一结果是什么都没扫。
    // 首次建立基线仍然跳过（没有基线谈不上「变化」），其余情况一律扫变化的项目。
    if (firstProbe) {
      log.info(`probe 基线已建立：${probe.projects.length} 个项目（首轮只建基线，不扫描）`);
    } else if (forceFull) {
      log.info(`probe changed=${changed.length} 但本轮 --full，跳过增量`);
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
  //
  // **2026-10-31 停用。** 它原本每 30 分钟全量扫一次，理由是「补增量漏掉的盲区」。
  // 但 `candidatesFromScan` 只认 `NOTIFY_STATES`，而那三个状态（WAITING / FAILED /
  // BLOCKED）**全部来自宿主文件**，L-fast 每分钟已经完整读过一遍
  // （`probeJobs` 读 jobs/，`probeWaiting` 读 sessions/）。
  //
  // 于是 L-full 的产出恒为空集：实测连续三次 `full=28159ms / 21543ms / 19106ms`，
  // 每次 `candidates=0`。**一天烧约 25 分钟 CPU，换零个候选。**
  //
  // 留着它只有一个理由：为「将来某个基于 transcript 的推断状态」做准备。
  // 那种状态下它会重新有用，但那时应该连同判据一起加回来——而不是现在空转。
  //
  // `--full` 仍然可用：手动排查问题时要看到全量输出，那是调试工具，不是常驻开销。
  if (forceFull) {
    try {
      const r = await scan({ project: null, days: 3 });
      candidates = candidates.concat(candidatesFromScan(r.sessions, { nowMs }));
      summary.timings.fullMs = Math.round(r.elapsedMs);
      summary.ran.push('full');
      state.lastFullScanAt = new Date(nowMs).toISOString();
    } catch (e) {
      summary.errors = [...(summary.errors || []), e];
      log.error(`full-scan-failed: ${e.message}`);
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
    classify: doClassify, observations: obsLog, env,
  });
  summary.sent = dispatched.sent;
  summary.suppressed = dispatched.suppressed;
  summary.failed = dispatched.failed;
  summary.already = dispatched.already;
  summary.observed = dispatched.observations.length;
  summary.byKind = {};
  for (const o of dispatched.observations) {
    const k = o.kind || 'UNKNOWN';
    summary.byKind[k] = (summary.byKind[k] || 0) + 1;
  }
  if (dispatched.errors.length) summary.errors = [...(summary.errors || []), ...dispatched.errors];

  // dry-run 不落盘：它绕过了发送，但**仍会走 saveState**，
  // 于是和真身抢同一个 state.json，rename 报 EPERM 把整个 tick 打挂。
  // 2026-10-31 实测：一个 --dry-run 实例跑了 6 小时，真身三次 tick-failed。
  if (!dryRun) {
    saveState(stateDir, state);
    // 见证文件**每次保存后**更新，而不是只在启动时写。
    // 只在启动时写的话，一个跑了一周的进程会把 lastSavedAt 停在一周前，
    // 丢失告警就会报出错误的时间——而时间是这条告警唯一有用的部分。
    writeWitness(stateDir, { nowMs });
  }

  const parts = [];
  for (const layer of summary.ran) parts.push(layer);
  if (summary.timings.jobsMs != null) parts.push(`jobs=${summary.timings.jobsMs}ms`);
  if (summary.timings.probeMs != null) parts.push(`probe=${summary.timings.probeMs}ms`);
  if (summary.timings.fullMs != null) parts.push(`full=${summary.timings.fullMs}ms`);
  parts.push(`candidates=${eligible.length}`);
  parts.push(`sent=${summary.sent.length}`);
  parts.push(`suppressed=${summary.suppressed.length}`);
  parts.push(`already=${summary.already}`);
  if (summary.observed) {
    const kinds = Object.entries(summary.byKind || {}).map(([k, n]) => `${k}:${n}`).join(',');
    parts.push(`observed=${summary.observed}${kinds ? `(${kinds})` : ''}`);
  }
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

/** 通知可追溯率：生产环境中唯一能独立判定真伪的指标。
 *
 *  问题：一条通知说「会话 X 失败了 / 在等你」，它凭什么？如果答不出「宿主在哪写了这个事实」，
 *  这条通知就是凭空发明的。
 *
 *  阈值（写于测量之前，见 docs/research/2026-10-31-first-production-metric.md）：
 *  **可追溯率必须 = 100%**，任何一条追不到宿主事实即 FAIL。不设百分比宽容——
 *  一条误报的代价是用户开始忽略所有通知，是断崖式的。
 *
 *  实测历史：旧架构（hb_gap 推断）下 **0/5**，全部不可追溯，结构性必然。
 *
 *  ⚠ 2026-10-31 修正：第一版只查 jobs 的 state.json，于是 **WAITING 通知必然被判不可追溯**——
 *  而 WAITING 是宿主写在 `sessions/*.json` 里的，本来就是真的。
 *  端到端演练第一次就暴露了：`notified WAITING` 之后 `--trace` 报 0/2。
 *  指标查错了数据源，不是通知发错了。现在按 state 分派到对应的宿主文件：
 *    FAILED / BLOCKED → jobs 的 state.json
 *    WAITING          → sessions 的 status === waiting
 *
 *  返回 null 表示「无通知可判定」，不等于通过。 */
export function traceability(dir, jobs, liveSessions = null) {
  const target = asPath(dir);
  if (!target) return null;
  // 必须把归档日志一起读：watch.log 每 1 MiB 轮转（约两天），
  // 只读当前文件的话，**两天前的通知会从分母里消失**，
  // 指标会随日志轮转「自己变好」——那是这轮修持久化时才意识到的问题。
  let raw;
  try {
    const names = readdirSync(target);
    const archives = names.filter((n) => /^watch\..+\.log$/.test(n)).sort();
    raw = [...archives, 'watch.log']
      .map((n) => { try { return readFileSync(join(target, n), 'utf8'); } catch { return ''; } })
      .join('\n');
  } catch { return null; }
  if (!raw) return null;

  const notified = [];
  for (const line of raw.split('\n')) {
    // 与 logger.info(`notified ...`) 的格式严格对应；变了就得改这里
    const m = line.match(/^(\S+) \[INFO\] notified (\w+) \S* ?(?:kind=\S+ )?key=(\w+) session=(\S+)$/);
    if (m) notified.push({ ts: m[1], state: m[2], key: m[3], sessionId: m[4] });
  }
  if (!notified.length) return { total: 0, traced: 0, ratio: null, failures: [] };

  const bySession = new Map();
  for (const j of jobs || []) {
    if (j && j.sessionId) bySession.set(String(j.sessionId), j);
  }
  const liveBySession = new Map();
  for (const s of liveSessions || []) {
    if (s && s.sessionId) liveBySession.set(String(s.sessionId), s);
  }

  const failures = [];
  let unverifiable = 0;
  for (const n of notified) {
    if (n.state === 'WAITING') {
      // WAITING 是**瞬时**事实：会话文件里的 status 会被下一次状态变更覆盖，
      // 会话结束时文件被删。事后去查「它现在还 waiting 吗」，答案几乎必然是「不」。
      // 这不是通知发错了，是**这个状态在事后不可验证**。
      //
      // 所以 WAITING 不参与「可追溯率」的分子分母，单独计数并要求为 0 的失败：
      //   - 若还能查到该会话、且它变成 busy/idle → 正常（用户已经回话了）
      //   - 若查不到这个会话 → 也可能是正常（会话结束）
      // 两种情况都无法证明当初那条通知是假的。诚实的做法是**承认测不了**。
      unverifiable++;
      continue;
    }
    const j = bySession.get(n.sessionId);
    const hostState = j ? j.state : null;
    const ok = Boolean(j) && (j.state === 'failed' || j.state === 'blocked');
    if (!ok) failures.push({ ...n, hostState });
  }
  // 分母只算**事后可验证**的那部分；一条都没有时返回 null（无样本 ≠ 通过）
  const verifiable = notified.length - unverifiable;
  return {
    total: notified.length,
    verifiable,
    unverifiable,
    traced: verifiable - failures.length,
    ratio: verifiable === 0 ? null : (verifiable - failures.length) / verifiable,
    failures,
  };
}

/** 读宿主 job 文件，供 traceability 使用。 */
export function readJobStates(claudeDir) {
  const root = join(String(claudeDir || join(homedir(), '.claude')), 'jobs');
  const out = [];
  let dirs;
  try { dirs = readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    let raw;
    try { raw = readFileSync(join(root, d, 'state.json'), 'utf8'); } catch { continue; }
    let j;
    try { j = JSON.parse(raw); } catch { continue; }
    out.push({
      sessionId: j.sessionId || d,
      state: j.state || null,
      needs: typeof j.needs === 'string' ? j.needs : null,
      suggestedReply: typeof j.suggestedReply === 'string' ? j.suggestedReply : null,
    });
  }
  return out;
}

/** 调度侧读取监控侧：把 `state.notified` 转成「谁在等我」的清单。
 *
 *  DF-015：两半一直没接上。`watch.mjs` 后台发现了 WAITING/BLOCKED，发个通知就完了；
 *  `.claude/agents/*` 与 SKILL.md 对 `watch.mjs` 零引用，主线程永远不知道后台看见过什么。
 *
 *  ⚠ **`state.notified` 是历史表，不是现状表。** 它记录「曾经通知过什么」，
 *  条目会一直留到 TTL 过期。直接拿它当收件箱会撒谎：
 *  2026-10-31 实测，4 个会话早已变回 `busy`，收件箱却说它们还在等。
 *  这正是 DF-015「两半各说各话」的新版本，只是方向反了。
 *
 *  所以 `live` 必须传入：**收件箱是历史记录 × 当前宿主状态 的交集**。
 *  没有 live 数据时不猜——把条目标成 `stale: true` 并说明无法确认，
 *  让调用方知道这是旧账而不是现状。 */
export function buildInbox(state, { nowMs = Date.now(), ttlHours = 72, states = HOST_FACT_STATES, live = null } = {}) {
  const out = [];
  const ttlMs = Math.max(0, Number(ttlHours) || 0) * 3600e3;
  const notified = (state && state.notified) || {};
  const liveBySession = new Map();
  for (const s of live || []) {
    if (s && s.sessionId) liveBySession.set(String(s.sessionId), s);
  }
  const haveLive = Array.isArray(live);

  for (const [key, e] of Object.entries(notified)) {
    if (!e || !states.includes(e.state)) continue;
    if (e.ackAt) continue;
    const seen = Date.parse(e.lastSeenAt || e.firstSeenAt || '');
    if (Number.isFinite(seen) && ttlMs > 0 && nowMs - seen > ttlMs) continue;

    // 与当前宿主状态对账
    let stale = false;
    let liveStatus = null;
    if (haveLive) {
      const cur = liveBySession.get(String(e.sessionId));
      liveStatus = cur ? cur.status : null;
      // 历史说 WAITING，但现在已不是 waiting → 这条已经过时
      if (e.state === 'WAITING' && liveStatus !== 'waiting') stale = true;
      // FAILED / BLOCKED 的失效条件**不只是「会话不在了」**。
      // 2026-10-31 实测假阳性：一个会话早就在正常工作（live.status='busy'），
      // 但 jobs 里那条 failed 记录还在，收件箱就把它当「需要人处理」报出来。
      // jobs/*/state.json 是**最后一次作业的结果**，不是会话的当前状态。
      // 所以：会话仍活着且显然在干活（busy）→ 那条失败记录已经过时。
      // 注意不把 'idle' 也算过时：idle 可能正是失败之后停在那儿等你看。
      if ((e.state === 'FAILED' || e.state === 'BLOCKED') && cur && liveStatus === 'busy') stale = true;
      if ((e.state === 'FAILED' || e.state === 'BLOCKED') && !cur) stale = true;
    }

    out.push({
      key,
      sessionId: e.sessionId || null,
      state: e.state,
      reason: e.reason || null,
      project: e.project || null,
      needs: e.needs || null,
      suggestedReply: e.suggestedReply || null,
      idleSec: Number.isFinite(e.idleSec) ? e.idleSec : null,
      firstSeenAt: e.firstSeenAt || null,
      lastSeenAt: e.lastSeenAt || null,
      notified: (e.notifyCount || 0) > 0,
      source: e.source || null,
      // stale=true：历史说有，当前宿主说没有了。默认不展示，但保留在数据里。
      stale,
      liveStatus,
      // 没有 live 数据时不能断言现状
      unverified: !haveLive,
    });
  }
  const active = out.filter((o) => !o.stale);
  active.sort((a, b) => {
    const ai = a.idleSec == null ? Infinity : a.idleSec;
    const bi = b.idleSec == null ? Infinity : b.idleSec;
    return ai - bi;
  });
  return active;
}

/** 把收件箱渲染成 SKILL.md 可以直接交给 Agent 的文本。
 *  必须逐字带上 needs / suggestedReply：`relay-protocol.md` §5.1 要求不许摘要。 */
export function formatInbox(items) {
  if (!items || !items.length) {
    return '收件箱：空。后台没有发现任何在等你或失败的会话。\n' +
      '（空不等于健康——也可能是守护进程没在跑。用 `node scripts/install-watcher.mjs status` 确认。）';
  }
  const lines = [`收件箱：${items.length} 个会话需要人处理`];
  const unverified = items.filter((it) => it.unverified).length;
  if (unverified) {
    lines.push(`⚠ 其中 ${unverified} 条没有与当前宿主状态核对（读不到 sessions/）。`);
    lines.push('  它们可能早就自己走了——动手前先确认会话还在。');
  }
  for (const it of items) {
    const where = it.project || (it.sessionId || '').slice(0, 8);
    const idle = it.idleSec == null ? '等了未知时长' : `已等 ${Math.round(it.idleSec / 60)} 分钟`;
    const mark = it.unverified ? '（未核对）' : '';
    lines.push('');
    lines.push(`## ${it.state} · ${where}（${idle}）${mark}`);
    lines.push(`- sessionId: ${it.sessionId}`);
    if (it.needs) lines.push(`- 它在等：${it.needs}`);
    if (it.suggestedReply) lines.push(`- 宿主建议回复（逐字，不要改写）：${it.suggestedReply}`);
    if (!it.needs && !it.suggestedReply) lines.push('- 宿主没写 needs —— 需要看 transcript 才知道它在等什么');
  }
  return lines.join('\n');
}

/** 守护进程是否**真的在工作**，而不只是进程存在。
 *
 *  DF-023：2026-10-31 排查时发现常驻进程 CPU 在涨、进程活着，
 *  但 lastJobsScanAt 停在六小时前——最坏的一类故障：看起来在跑，实际没在跑。
 *  我当时一直用「进程存在」当作「在监控」，并据此判断「还没有真实数据」。
 *
 *  判据来自**调度周期本身**，不是拍的：
 *    L-fast 每 1 分钟跑一次 → 超过 3 个周期（3 分钟）没写 lastJobsScanAt 就是 stale
 *    L-mid  每 5 分钟跑一次 → 超过 3 个周期（15 分钟）就是 stale
 *  取 3 个周期而不是 1 个：单次 tick 可能因为扫描慢而推后，1 个周期会误报。
 *  超过 3 个周期还没动静，就不是「慢」，是「停了」。
 *
 *  返回 { healthy, reasons[], layers[] }。reasons 为空才算健康。 */
export const HEALTH_PERIODS = Object.freeze({
  jobs: JOBS_INTERVAL,
  probe: PROBE_INTERVAL,
});

export function healthCheck(state, { nowMs = Date.now(), periods = HEALTH_PERIODS } = {}) {
  const layers = [];
  const reasons = [];

  for (const [name, interval] of Object.entries(periods)) {
    const key = name === 'jobs' ? 'lastJobsScanAt' : 'lastProbeAt';
    const iso = state && state[key];
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) {
      layers.push({ name, interval, lastAt: null, ageMs: null, stale: true, reason: '从未运行' });
      reasons.push(`${name}：从未运行（${key} 为空）`);
      continue;
    }
    const ageMs = nowMs - t;
    const limit = interval * 3;
    const stale = ageMs > limit;
    layers.push({ name, interval, lastAt: iso, ageMs, stale, limit });
    if (stale) {
      reasons.push(`${name}：已 ${fmtAge(ageMs)} 未运行（上限 ${fmtAge(limit)}）`);
    }
  }
  return { healthy: reasons.length === 0, reasons, layers };
}

function fmtAge(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} 分钟`;
  const h = (m / 60).toFixed(1);
  if (h < 48) return `${h} 小时`;
  return `${(h / 24).toFixed(1)} 天`;
}

export function formatHealth(result) {
  if (!result) return '无法判定：没有状态文件。';
  const lines = [];
  for (const l of result.layers) {
    const age = l.ageMs == null ? '从未' : fmtAge(l.ageMs);
    const mark = l.stale ? '✗' : '✓';
    lines.push(`  ${mark} ${l.name.padEnd(6)} 上次 ${age}前   周期 ${fmtAge(l.interval)}（上限 ${fmtAge(l.interval * 3)}）`);
  }
  lines.push('');
  if (result.healthy) {
    lines.push('判定：运行中。所有层都在周期内。');
  } else {
    lines.push('判定：**没有在工作**。');
    for (const r of result.reasons) lines.push(`  - ${r}`);
    lines.push('');
    lines.push('注意：这**不代表进程死了**。进程可能还活着但卡住了——');
    lines.push('这恰恰是 DF-023 记的那类故障：看起来在跑，实际没在跑。');
  }
  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────

async function main(argv) {
  const flags = new Set(argv);
  if (flags.has('--help') || flags.has('-h')) {
    console.log('用法：node scripts/watch.mjs            # 常驻');
    console.log('      node scripts/watch.mjs --once     # 只跑一轮（到期层）');
    console.log('      node scripts/watch.mjs --full     # 强制全量跑一轮');
    console.log('      node scripts/watch.mjs --dry-run  # 只算不发');
    console.log('      node scripts/watch.mjs --stats    # 读观察日志出分布');
    console.log('      node scripts/watch.mjs --trace    # 通知可追溯率（生产指标，阈值 100%）');
    console.log(`状态目录：${defaultStateDir()}`);
    console.log(`UNCLASSIFIABLE 时间门槛：${unclassifiableMinIdleSec()}s（OVERWATCH_UNCLASSIFIABLE_MIN_IDLE 可覆盖）`);
    return;
  }

  if (flags.has('--stats')) {
    console.log(formatStats(observationStats(defaultStateDir()), { minIdleSec: unclassifiableMinIdleSec() }));
    return;
  }

  if (flags.has('--health')) {
    const dir = defaultStateDir();
    let state;
    try {
      state = loadState(dir, { logger: null }).state;
    } catch {
      console.log('无法读取状态文件——守护进程可能从未运行过。');
      process.exit(1);
    }
    const r = healthCheck(state, { nowMs: Date.now() });
    if (flags.has('--json')) {
      console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...r }, null, 2));
    } else {
      console.log(formatHealth(r));
    }
    process.exit(r.healthy ? 0 : 1);
  }


  if (flags.has('--inbox')) {
    const dir = defaultStateDir();
    const { state } = loadState(dir, { logger: null });
    // 必须带上当前宿主状态对账：state.notified 是历史表，不是现状表。
    const items = buildInbox(state, { nowMs: Date.now(), live: readLiveSessionStates() });
    if (flags.has('--json')) {
      console.log(JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 2));
    } else {
      console.log(formatInbox(items));
    }
    // 空收件箱不是错误：没有需要处理的事，退出 0。调用方靠文本判断。
    process.exit(0);
  }


  if (flags.has('--trace')) {
    const dir = defaultStateDir();
    const r = traceability(dir, readJobStates(), readLiveSessionStates());
    if (!r || r.total === 0) {
      console.log('没有可判定的通知（日志里没有任何 notified 行）。');
      console.log('这不是通过——它表示还没机会犯错。见 docs/research/2026-10-31-first-production-metric.md');
      process.exit(0);
    }
    console.log(`可判定通知 ${r.verifiable} 条，其中可追溯 ${r.traced} 条；` +
      `另有 ${r.unverifiable} 条 WAITING 事后无法验证（该状态是瞬时的）`);
    console.log(`通知可追溯率：${r.ratio === null ? 'n/a（无事后可验证的通知）' : (r.ratio * 100).toFixed(1) + '%'}`);
    console.log('阈值：100%（测量前写死，不设百分比宽容）');
    for (const f of r.failures) {
      console.log(`  UNTRACEABLE ${f.ts} state=${f.state} session=${f.sessionId.slice(0, 8)}` +
        `  → ${f.hostState === null ? '宿主无此记录' : `宿主记录为 ${f.hostState}`}`);
    }
    if (r.ratio === null) {
      console.log('判定：无样本 —— 这不是通过，是还无法判定');
      process.exit(0);
    }
    console.log(r.ratio >= 1 ? '判定：PASS' : '判定：FAIL');
    process.exit(r.ratio >= 1 ? 0 : 1);
  }

  const dryRun = flags.has('--dry-run');
  const forceFull = flags.has('--full');

  let notifier;
  try {
    const mod = await import('./notify.mjs');
    if (!mod.isNotificationAvailable()) throw new Error('通知通道不可用（需要 Windows + wscript + powershell）');
    notifier = mod.sendNotification;
  } catch (e) {
    // 没有桌面通知通道（非 Windows、或 wscript 缺失）时，退回**终端输出**。
    //
    // 2026-11-01 实测：旧代码退回一个必抛错的函数，于是每个候选都变成
    // `notify-failed` → `delivery: 'failed'` → **永不重试**。
    // 结果是在没有通知通道的机器上，系统是完全静默的：
    // 它发现了会话在等你，然后什么也不做，只在日志里留一行 ERROR。
    // 换台机器跑起来的用户永远收不到任何东西，也不会知道为什么。
    //
    // 终端输出不完美（守护进程没有终端），但它至少写进 runner.log，
    // 并且标记为 `delivery: 'console'` 而不是 'failed'——所以**不会被永久吞掉**。
    const why = e.message;
    console.error(`通知通道不可用，改为写日志：${why}`);
    console.error('  桌面通知需要 Windows + wscript + powershell。');
    console.error('  跨平台用法：定期跑 `node scripts/watch.mjs --inbox` 查看待处理项。');
    notifier = async (n) => {
      const line = `[NOTIFY] ${n.title || '(无标题)'}${n.body ? ' — ' + n.body : ''}`;
      console.error(line);
      if (n.logger && typeof n.logger.info === 'function') n.logger.info(line);
    };
  }

  if (flags.has('--once') || forceFull) {
    // 观察日志的 key 里带 ts 的话每一轮都是新行，所以 createObservationLog 每轮新建，
    // 但去重集是模块级的（见 createObservationLog 上方）。
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
export const __internals = { JOBS_INTERVAL, PROBE_INTERVAL, FULL_INTERVAL, PER_SESSION_MAX_24H, GLOBAL_MAX_24H, GLOBAL_MIN_GAP, LOG_MAX_BYTES, ACTIVE_WINDOW, TAIL_READ_BYTES, OBS_MAX_BYTES, UNCLASSIFIABLE_MIN_IDLE_SEC };
