/**
 * hook-dedupe.mjs — 「同一次 hook 事件只判定一次」的唯一实现。
 *
 * ── 它修的是什么（`DF-029`）────────────────────────────────────────
 *
 * `.claude/settings.local.json` 注册了两条 hook，而 `scripts/launch.mjs` 也用
 * `--settings` 注入同名两条。宿主的实测行为是**叠加**（`launch.mjs:818` 自己写着
 * 「实测两边都会触发」），所以用 `overwatch launch` 起的会话里同一次事件会跑两遍：
 *
 *   · PreToolUse：同一次工具调用跑 2 次写前闸
 *   · Stop：同一个回合结束跑 2 次 Stop 闸
 *
 * 实测（2026-11-18，直接调 `runHook` 两次，同一 `tool_use_id`）：
 *   台账 2 行；`stop-verify-hook` 的 `state.json` 里 `count`/`total` 各跳 2 —— 也就是
 *   「一个回合」被记成了两次拦截，6 次预算实际只够 3 个回合。
 *
 * ── 为什么修「幂等」而不是「检测重复注册」────────────────────────────
 *
 * 「我是不是被重复注册了」是个不可靠的判断：hook 只能看到自己的 stdin 和盘上的文件，
 * 看不到宿主把哪些 settings 叠在了一起（`--settings` 注入的那份与本文件无关）。
 * 而幂等只需要一个**已经在输入里的键**：同一次调用被触发两次时，那个键逐字相同。
 *
 * ── 键怎么取（每个 hook 各自决定，本文件只提供机制）──────────────────
 *
 *   PreToolUse : `session_id` + `tool_use_id`。`tool_use_id` 是每次工具调用的身份，
 *                与 transcript 里的 `tool_use` 对得上（见
 *                `docs/research/2026-11-14-pretooluse-desktop-verification.md` §1）。
 *   Stop       : `session_id` + `prompt_id` + `stop_hook_active` + `last_assistant_message`
 *                的哈希 + transcript 字节数。**Stop 的输入里没有任何「第几次调用」字段**
 *                （宿主 schema 实测：`Stop` 只有 `stop_hook_active` / `last_assistant_message`
 *                / `background_tasks` / `session_crons`），所以只能用这几个可观测量的组合。
 *
 * ── 并发：这是**原子创建**，不是「先读后写」──────────────────────────
 *
 * 一次认领 = 用 `O_EXCL`（`openSync(path, 'wx')`）创建**这个键专属**的文件。
 * 语义由内核保证：两个进程同时对同一个路径 `O_CREAT|O_EXCL`，只有一个成功，另一个拿到
 * `EEXIST`。**没有「检查不存在再创建」这个窗口** —— 那正是本仓反复踩过的先读后写竞态。
 *
 * 本机实测（NTFS，2026-11-18）：已存在 → `EEXIST`；不存在 → 创建成功。
 *
 * 仍然**不原子**的地方，如实写在这里，不假装：
 *   1. **网络文件系统**。NFSv2 的 `O_EXCL` 历来不可靠（老内核会退化成非原子），
 *      SMB 各实现也有差异。本仓默认把认领文件写进 `tasks/runs/`（本地盘），
 *      只有把 `OVERWATCH_HOOK_DEDUPE_DIR` 指到网络盘上时这一条才生效。
 *      那种配置下的后果：两个进程都可能认领成功 → 退回「两边都判定、都记账」，
 *      也就是**修之前的行为**。失效方向是「多记一次」，不是「漏判一次」。
 *   2. **过期重抢**。键文件超过 `CLAIM_TTL_MS` 后，第一个发现它的进程会先 `unlink`
 *      再重新 `O_EXCL` 创建。这两步之间有一个**极短窗口**（微秒级，一次系统调用）：
 *      若第三个进程恰好在窗口内创建成功，前一个会按「重复」处理。三个并发调用
 *      才会碰到，两条注册的常态（恰好 2 次）碰不到。
 *   3. **先认领、后崩溃**。进程在认领成功之后、记账之前死掉，另一个进程会看到
 *      `EEXIST` 而保持沉默 —— 这一次事件**没有任何判定与台账行**。这是刻意选的
 *      失效方向：静默降级一次观测，而不是让用户被锁在会话里（两个 hook 都是 fail-open）。
 *
 * ── 失效方向（决定了整个设计）───────────────────────────────────────
 *
 * 任何「拿不到可靠的键」或「认领文件写不进去」的情形，一律**放弃去重、照常判定** ——
 * 也就是退回修之前的行为。绝不能反过来：去重失败就跳过判定，那等于把闸门静默关掉，
 * 而这个仓库最反对的就是「静默」。
 */

import {
  appendFileSync, closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** 认领文件的存活时间。超过它，同一个键会被当成「上一次的残留」重新认领。
 *
 *  取 10 分钟的依据：两条注册的触发间隔是**毫秒级**（宿主同时起两个子进程），
 *  而 10 分钟远小于「同一 prompt 内还能再来一次完全相同 Stop」的可能性 —— 那种情形
 *  需要模型逐字重复同一条回复，且 transcript 一字节没长。短于此值是为了让「只有一份
 *  注册」的会话里留下的残留尽快失效，不把真事件吞掉。 */
export const CLAIM_TTL_MS = 10 * 60 * 1000;

/** 目录里超过这么多条认领文件才扫一遍清理。
 *
 *  为什么不在每次认领时都扫：那是 O(n) 次 `statSync`，而 hook 的预算是「每一次工具
 *  调用」。一次 `readdirSync` 很便宜，超过阈值才逐个 stat 并删过期的 —— 正常的
 *  会话永远到不了这个阈值（一回合几十次调用量级），长期跑才会。 */
export const SWEEP_AT = 512;

/** 认领根目录名。默认在 `tasks/runs/hook-dedupe/`（gitignored）。 */
export const DEDUPE_DIR_NAME = 'hook-dedupe';

/** 被跳过的重复调用记在这里（只记条数，不参与任何判定）。 */
export const SKIPPED_FILE = 'skipped.jsonl';

/** 认领根目录。
 *
 *  优先级与本仓其它隔离变量**刻意一致**：
 *  `OVERWATCH_HOOK_DEDUPE_DIR`（显式覆盖）→ `OVERWATCH_STATE_DIR`（本仓统一的临时区
 *  变量，两个 hook 都认）→ 仓库默认 `tasks/runs/hook-dedupe`。
 *  中间那一层必须有：测试与结构门的探针都靠它把副作用关进临时目录；漏了它，
 *  「我已经隔离了」这句话就对这个文件无效。 */
export function dedupeRoot({ env = process.env } = {}) {
  const explicit = String((env && env.OVERWATCH_HOOK_DEDUPE_DIR) || '').trim();
  if (explicit) return explicit;
  const stateDir = String((env && env.OVERWATCH_STATE_DIR) || '').trim();
  if (stateDir) return join(stateDir, DEDUPE_DIR_NAME);
  return join(REPO_ROOT, 'tasks', 'runs', DEDUPE_DIR_NAME);
}

/** 某个 hook 的认领目录。按 hook 分目录，不同 hook 的同名键不会互相挡住。 */
export function claimDirFor(root, hookId) {
  return join(String(root || dedupeRoot()), safeSegment(hookId) || 'unknown');
}

/** 键 → 文件名。用 sha256 而不是原键：键里含会话 ID 与回复原文，落成文件名会泄漏；
 *  且文件名长度有上限（Windows 单个路径分量 255），原键可能很长。 */
export function claimPathFor(root, hookId, key) {
  const digest = createHash('sha256').update(String(key || ''), 'utf8').digest('hex').slice(0, 32);
  return join(claimDirFor(root, hookId), digest + '.json');
}

/** 把键拼成一个字符串。**任何一段为空就返回 `null`** —— 缺一段就等于缺一个可靠判据，
 *  这时宁可不去重（退回修之前的行为），也不能拿半个键去猜「这是同一次事件」。 */
export function claimKeyOf(hookId, parts = []) {
  const id = safeSegment(hookId);
  if (!id) return null;
  const arr = Array.isArray(parts) ? parts : [parts];
  if (!arr.length) return null;
  const seg = [];
  for (const raw of arr) {
    const v = raw == null ? '' : String(raw);
    if (!v) return null;
    seg.push(v.replace(/[\u0000]/g, ' '));
  }
  return id + '\u0000' + seg.join('\u0000');
}

/** 文件系统安全的一段名字。只允许 `[a-z0-9-]`，其余折成 `-`。 */
function safeSegment(v) {
  return String(v || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * 认领一次事件。**这是整个模块唯一的写入口，且永不抛。**
 *
 * @returns {{claimed: boolean, why: string, path?: string, ageMs?: number}}
 *   `claimed: true`  → 本次是第一个到的，照常判定并记账
 *   `claimed: false` → 同一次事件的重复触发，调用方必须**直接放行且不记账**
 *
 * 「永不抛」是硬要求：去重是记账层的优化，它崩了不能让闸门的判定跟着崩。
 */
export function claimOnce({ hookId = 'unknown', key = '', env = process.env, nowMs = Date.now() } = {}) {
  const k = String(key || '');
  if (!k) return { claimed: true, why: 'no-key' };

  let root;
  let path;
  try {
    root = dedupeRoot({ env });
    path = claimPathFor(root, hookId, k);
  } catch {
    return { claimed: true, why: 'no-path' };
  }

  const body = JSON.stringify({
    hookId: String(hookId || 'unknown'),
    // 只留前 200 字：认领文件是给「谁抢到了」用的，不是语料。
    key: k.slice(0, 200),
    at: new Date(nowMs).toISOString(),
    pid: process.pid,
  }) + '\n';

  const tryCreate = () => {
    const fd = openSync(path, 'wx');
    try { writeSync(fd, body); } finally { closeSync(fd); }
  };

  try {
    mkdirSync(dirname(path), { recursive: true });
    tryCreate();
    sweepIfCrowded(dirname(path), nowMs);
    return { claimed: true, why: 'claimed', path };
  } catch (e) {
    // 写不进去（只读盘 / 没权限 / 满了）：**放弃去重、照常判定**。
    // 反方向（认领失败就跳过判定）等于把闸门静默关掉，本仓明确不做。
    if (!e || e.code !== 'EEXIST') return { claimed: true, why: 'claim-failed:' + ((e && e.code) || 'unknown') };
  }

  // 已存在：可能是同一次事件的第二次触发，也可能是上一次留在盘上的残留。
  //
  // `ageMs` 用 `mtimeMs`（墙钟）减去 `nowMs`（调用方给的时刻）。两者来源不同，
  // 所以**可能为负**（调用方传了一个比文件更早的时刻 —— 测试里为了可复算会这么做，
  // 生产里也可能遇到系统时钟被调整）。负值一律当 0 处理：**绝不因为时钟不齐
  // 就把一份刚写的认领当成残留重抢** —— 那会把一次真事件判成两次。
  let ageMs = null;
  try { ageMs = Math.max(0, nowMs - statSync(path).mtimeMs); } catch { ageMs = null; }

  if (ageMs !== null && ageMs > CLAIM_TTL_MS) {
    // 残留：删掉再抢一次。删与抢之间有一个微秒级窗口（见文件头 §并发 2）。
    try { unlinkSync(path); } catch { /* 别人先删了也没关系 */ }
    try {
      tryCreate();
      sweepIfCrowded(dirname(path), nowMs);
      return { claimed: true, why: 'stale-reclaimed', path, ageMs };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return { claimed: true, why: 'reclaim-failed:' + ((e && e.code) || 'unknown') };
      return { claimed: false, why: 'duplicate-race', path, ageMs };
    }
  }

  return { claimed: false, why: 'duplicate', path, ageMs };
}

/** 清理过期的认领文件。只在目录条目超过 `SWEEP_AT` 时才真的扫。
 *
 *  为什么需要清理：认领文件是「一次事件一个」，长期跑会无限增长。而它只在
 *  `CLAIM_TTL_MS` 内有意义，过期之后留着只是磁盘上的垃圾。
 *  失败一律吞掉 —— 清理不是判定的一部分。 */
export function sweepIfCrowded(dir, nowMs = Date.now()) {
  try {
    const names = readdirSync(dir);
    if (names.length < SWEEP_AT) return 0;
    let n = 0;
    for (const name of names) {
      if (!name.endsWith('.json') || name === SKIPPED_FILE) continue;
      const p = join(dir, name);
      try {
        if (nowMs - statSync(p).mtimeMs > CLAIM_TTL_MS) { unlinkSync(p); n++; }
      } catch { /* 单个文件读不到不影响其余 */ }
    }
    return n;
  } catch {
    return 0;
  }
}

/** 记一条「这次触发被当成重复，跳过了」。
 *
 *  为什么不写进 hook 自己的台账：那条台账的**行数就是分母**（
 *  `analyze-hook-samples.mjs` 按行算比例）—— 记进去就又翻倍了，等于什么都没修。
 *  所以单独一个只追加的文件，回答的是另一个问题：「去重到底有没有真的触发」。
 *  这个文件里的行**不参与任何统计**，它只证明机制在跑。
 *
 *  永不抛；写不进去就返回 null。 */
export function recordSkipped({ hookId = 'unknown', key = '', env = process.env, nowMs = Date.now(), why = '' } = {}) {
  try {
    const dir = claimDirFor(dedupeRoot({ env }), hookId);
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      at: new Date(nowMs).toISOString(),
      hookId: String(hookId || 'unknown'),
      why: String(why || ''),
      keyHash: createHash('sha256').update(String(key || ''), 'utf8').digest('hex').slice(0, 16),
    }) + '\n';
    appendFileSync(join(dir, SKIPPED_FILE), line);
    return true;
  } catch {
    return null;
  }
}
