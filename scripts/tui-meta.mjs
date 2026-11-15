#!/usr/bin/env node
/**
 * tui-meta.mjs — 列表页需要、但 `scan-sessions.mjs --json` 没有的两个字段。
 *
 * 规划 §2.5 要求列表页新增两项读取：
 *   - **标题**（transcript 的 `custom-title` / `agent-name`），用来替代被截断到
 *     24 列、5 行完全一样的目录名（P4「身份优先于状态」）；
 *   - **最后一条 assistant 文本**（「近」列），用来替代同义反复的 `reason` 列。
 *
 * 实测（`docs/design/2026-11-05-tui-redesign-plan.md` §1.5）：
 * 128 KB 尾部读取覆盖 `custom-title` 29/29、末条 assistant 文本 29/29，
 * 29 个会话合计 92 ms。这里按 **(路径, mtime)** 缓存，8 秒轮询下未改动的文件零成本。
 *
 * 三条纪律：
 *   1. **读不到就说读不到**（返回 null / 空串），不拿目录名伪装成标题 ——
 *      调用方自己决定回退到 cwd 尾段，且要能看出这是回退值；
 *   2. **不判定状态**。这里只取文本；是不是问句由 `asked.mjs` 的纯函数回答；
 *   3. **「与时间无关的事实」留在缓存里，「与时间有关的判定」不留在缓存里。**
 *      读取按 (路径, mtime) 缓存，mtime 不变就不会重读 —— 若把「问了没答」的
 *      时间门槛结论一起缓存，一条 0.5 小时前的问题会永远停在「刚问完」这一档。
 *      所以缓存里只放 `questionAt` / `questionContinued` 这类事实，判定由
 *      `askedVerdictOf()` 用调用方注入的 `nowMs` 现算。
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  lastAssistantText as lastAssistantFrom, lastCwd, endsWithQuestion,
  classifyQuestion, continuedAfterQuestion, assessAsked,
  DEFAULT_MIN_HOURS, MAX_QUESTION_HOURS,
} from './asked.mjs';

/** 尾部读取窗口。实测 29/29 覆盖（最远一条距 EOF 32 KB），留 4 倍余量。 */
export const META_TAIL_BYTES = 131072;

/** projects 根目录。与 scan-sessions 的 findTranscriptRoot 同义，但允许覆盖（测试用）。 */
export function projectsRoot(env = process.env) {
  const custom = env && env.CLAUDE_PROJECTS_DIR;
  if (typeof custom === 'string' && custom) return custom;
  return join(homedir(), '.claude', 'projects');
}

/**
 * 一条扫描行对应的 transcript 路径。**取不到就是 null，不要拼一个不存在的路径。**
 *
 * 优先级：transcriptId > sessionId（与 scan 的去重身份顺序一致）。
 * 目录名用扫描行自带的 `project`——它不是从 cwd 反推的，是宿主真实写入的目录名。
 *
 * @param {{project?: string, transcriptId?: string, sessionId?: string}} row
 * @param {string} [root]
 * @returns {string|null}
 */
export function transcriptPathFor(row, root = projectsRoot()) {
  if (!row || !row.project) return null;
  const id = row.transcriptId || row.sessionId;
  if (!id) return null;
  return join(root, String(row.project), `${id}.jsonl`);
}

/** 从已解析的记录里取标题、末条 assistant 文本，以及「问了没答」的**原始事实**。纯函数。
 *
 *  「问了没答」这一行**不能靠 inbox**：inbox 来自 watch 的历史通知表，与 transcript
 *  是两道独立数据源（裁决 R2 的理由）。这里就地算，成本为零——记录本来就已经读进来了。
 *
 *  **这里只产出事实，不产出判定。** 判定（够不够久、静默多久、会话有没有自己继续）
 *  全部在 `askedVerdictOf()` 里，与 `asked.mjs` 同源。理由见文件头纪律 3。
 */
export function metaFromRecords(records) {
  const list = Array.isArray(records) ? records : [];
  let title = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const rec = list[i];
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type !== 'custom-title') continue;
    const t = typeof rec.customTitle === 'string' ? rec.customTitle.trim()
      : typeof rec.title === 'string' ? rec.title.trim() : '';
    if (t) { title = t; break; }
  }
  if (!title) {
    for (let i = list.length - 1; i >= 0; i--) {
      const rec = list[i];
      if (!rec || typeof rec !== 'object') continue;
      if (rec.type !== 'agent-name') continue;
      const t = typeof rec.agentName === 'string' ? rec.agentName.trim() : '';
      if (t) { title = t; break; }
    }
  }
  const last = lastAssistantFrom(list);
  const qText = last ? pendingQuestionOf(list, last) : null;
  const qAt = last ? (last.timestamp || null) : null;
  return {
    title,
    lastAssistant: last ? String(last.text || '').trim() : '',
    lastAssistantAt: qAt,
    cwd: lastCwd(list),
    // 「末条是谁说的」——决定「问了没答」成不成立。只看 assistant 结尾的问句，
    // 因为人说完话之后的问号不是「在问我」（那是轮到助手回答）。
    lastSpeaker: lastSpeakerOf(list),
    // ── 「问了没答」的三样原始事实，**不是结论** ──
    //
    // 这里刻意**不**给一个叫 `question` 的成品字段：它会被调用方直接拿去上屏，
    // 而「够不够久 / 静默多久 / 会话有没有自己继续」这三道门槛取决于**当前时刻**，
    // 一旦写进按 mtime 缓存的元数据就会被冻住（一条 0.5 小时前的问题会永远
    // 停在「刚问完」那一档）。判定在同一次渲染里现算，见 `oversight-tui.viewOf`。
    questionText: qText,
    questionAt: qText ? qAt : null,
    questionContinued: qText ? continuedAfterQuestion(list, qAt) : null,
  };
}

/** 最后一条带 message 的记录是谁说的。 */
export function lastSpeakerOf(records) {
  for (let i = (Array.isArray(records) ? records.length : 0) - 1; i >= 0; i--) {
    const rec = records[i];
    if (!rec || typeof rec !== 'object' || !rec.message) continue;
    if (rec.type === 'assistant') return 'assistant';
    if (rec.type === 'user') {
      // tool_result 也以 user 记录的形式出现，它不是「人说话了」。
      const c = rec.message.content;
      const blocks = Array.isArray(c) ? c : [];
      const human = blocks.length === 0
        ? true
        : blocks.some((b) => b && b.type === 'text' && String(b.text || '').trim());
      if (human) return 'human';
      continue;
    }
  }
  return null;
}

/**
 * 末条 assistant 文本是不是「问了没答」的**候选** → 是就返回它（截断到 200 字），否则 null。
 *
 * 判据与 `asked.mjs` 的 `inspectRecords` 前三步**逐条对齐**（直接调用同两个纯函数）：
 *   1. 末条说话的是 assistant（人说完话之后的问号不算「在问我」）；
 *   2. `endsWithQuestion` —— 问号之后没有实质内容（修辞问号不算）；
 *   3. `classifyQuestion` 判成 `greeting` 的开场客套不算（「今天想做点什么呢」永远没人回）。
 *   4. `continuedAfterQuestion` 有命中说明会话问完之后自己又走了一步，不是在等人。
 *
 *  **不做的**：`minHours` / `maxHours` / 宿主状态对账。它们依赖「现在是几点」和
 *  宿主现状，必须由调用方在同一次渲染里用 `askedVerdictOf()` 现算，不能进缓存。
 */
export function pendingQuestionOf(records, last) {
  const speaker = lastSpeakerOf(records);
  if (speaker !== 'assistant') return null;
  const text = String((last && last.text) || '').trim();
  if (!text) return null;
  if (!endsWithQuestion(text)) return null;
  if (classifyQuestion(text) === 'greeting') return null;
  return text.slice(-200);
}

/**
 * 「这个问句现在还值得算进『问了没答』吗」——**直接复用 `asked.mjs` 的 `assessAsked`**。
 *
 * 为什么不是在这里再写一份判据：`asked.mjs:280` 那段注释逐字记录着 2026-11-01
 * 的假阳性（「Let's learn English! 问了没答」那个会话文件 **244 小时没动过**，
 * 提醒一个 10 天前的问句是谎报）。TUI 侧曾把这条 bug 又写了一遍——
 * 只判「末条是 assistant 且以问号结尾」，一条 10 天前的问句照样计数。
 * 两份判据各写一遍必然漂移，所以这里**只做转接，不做判断**。
 *
 * 全部输入都是显式给的，函数本身不读盘：`host` / `hostStatus` / `siblingHit`
 * 由调用方决定给不给。读不到（`null`）时 `assessAsked` 不因此拦截——
 * 那是采集缺失，不是证据。
 *
 * @param {{questionAt?: string|null, questionContinued?: object|null}} meta  metaFromRecords 的事实
 * @param {object} [p]
 * @param {number} [p.nowMs]
 * @param {object|null} [p.host]       宿主会话状态（`statusUpdatedAt` 用）
 * @param {string|null} [p.hostStatus]
 * @param {object|null} [p.siblingHit]
 * @param {number} [p.minHours]        默认与 `asked.mjs` 同一个常量
 * @param {number} [p.maxHours]
 * @returns {{keep: boolean, why: string, evidence: object}}
 */
export function askedVerdictOf(meta, {
  nowMs = Date.now(),
  host = null,
  hostStatus = null,
  siblingHit = null,
  minHours = DEFAULT_MIN_HOURS,
  maxHours = MAX_QUESTION_HOURS,
} = {}) {
  const at = meta && meta.questionAt ? meta.questionAt : null;
  if (!at) return { keep: false, why: 'no-question', evidence: { questionTs: null } };
  const t0 = Date.parse(at);
  if (!Number.isFinite(t0)) return { keep: false, why: 'unparsable-time', evidence: { questionTs: at } };
  const hours = (nowMs - t0) / 3600e3;
  // 两道时间门与 `asked.mjs` 的门顺序一致：先「刚问完先别催」，再「太久了别催了」。
  // 顺序不影响结果（两个区间不相交），但保持同序便于两侧对照阅读。
  if (hours < minHours) {
    return { keep: false, why: 'too-recent', evidence: { questionTs: at, hours: Math.round(hours * 10) / 10 } };
  }
  if (hours > maxHours) {
    return { keep: false, why: 'too-old', evidence: { questionTs: at, hours: Math.round(hours * 10) / 10 } };
  }
  return assessAsked({
    questionTs: at,
    continued: meta.questionContinued ?? null,
    host: host ?? null,
    hostStatus: hostStatus ?? null,
    siblingHit: siblingHit ?? null,
    nowMs,
  });
}

/** 读文件尾部并按行解析。半截行丢弃（与 verify-claims 的 readTailRecords 同一口径）。 */
export function readTailRecords(file, maxBytes = META_TAIL_BYTES) {
  let size;
  try { size = statSync(file).size; } catch { return { records: [], size: 0, truncated: false }; }
  const len = Math.min(maxBytes, size);
  const offset = Math.max(0, size - len);
  const buf = Buffer.allocUnsafe(len);
  let fd;
  try {
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, len, offset);
  } catch {
    return { records: [], size, truncated: false };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* 已关 */ } }
  }
  const text = buf.toString('utf8');
  const body = offset > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  const records = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* 半截行 / 坏行 */ }
  }
  return { records, size, truncated: offset > 0 };
}

/**
 * 带 mtime 失效的读取缓存。8 秒轮询下，未改动的 transcript 不会重复读。
 *
 * 上限 512 条：`--all` 实测 241 个 transcript，2 倍余量足够；
 * 超出时按插入顺序丢最旧的（Map 的键顺序即插入顺序）。
 */
export function createMetaCache({ maxEntries = 512, read = readTailRecords } = {}) {
  const map = new Map();
  let reads = 0;
  return {
    /** @returns {{title: string|null, lastAssistant: string, lastAssistantAt: string|null, mtimeMs: number|null}} */
    get(file, { mtimeMs = null } = {}) {
      if (!file) return { title: null, lastAssistant: '', lastAssistantAt: null, mtimeMs: null };
      const key = String(file);
      const hit = map.get(key);
      const mtime = Number.isFinite(mtimeMs) ? mtimeMs : null;
      // 命中条件：mtime 已知且相等；mtime 未知时只在已有缓存时复用（宁可旧一点也不要每轮重读）
      if (hit && (mtime === null || hit.mtimeMs === mtime)) return hit.value;
      const r = read(key);
      reads++;
      const value = { ...metaFromRecords(r.records), mtimeMs: mtime, bytes: r.size };
      // 删了再插，让它变成「最近使用」——否则热会话会被最早插入的冷会话挤掉
      map.delete(key);
      map.set(key, { mtimeMs: mtime, value });
      if (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      return value;
    },
    /** 供测试断言「没有重复读」。 */
    stats() { return { entries: map.size, reads }; },
    clear() { map.clear(); reads = 0; },
  };
}
