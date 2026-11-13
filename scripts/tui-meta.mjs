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
 * 两条纪律：
 *   1. **读不到就说读不到**（返回 null / 空串），不拿目录名伪装成标题 ——
 *      调用方自己决定回退到 cwd 尾段，且要能看出这是回退值；
 *   2. **不判定状态**。这里只取文本；是不是问句由 `asked.mjs` 的纯函数回答。
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { lastAssistantText as lastAssistantFrom, lastCwd, endsWithQuestion } from './asked.mjs';

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

/** 从已解析的记录里取标题、末条 assistant 文本、以及「末条是不是一个没人回的问句」。纯函数。
 *
 *  「问了没答」这一行**不能靠 inbox**：inbox 来自 watch 的历史通知表，与 transcript
 *  是两道独立数据源（裁决 R2 的理由）。这里就地算，成本为零——记录本来就已经读进来了。
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
  return {
    title,
    lastAssistant: last ? String(last.text || '').trim() : '',
    lastAssistantAt: last ? (last.timestamp || null) : null,
    cwd: lastCwd(list),
    // 「末条是谁说的」——决定「问了没答」成不成立。只看 assistant 结尾的问句，
    // 因为人说完话之后的问号不是「在问我」（那是轮到助手回答）。
    lastSpeaker: lastSpeakerOf(list),
    question: last ? pendingQuestionOf(list, last) : null,
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

/** 末条 assistant 文本是问句 → 返回它（截断到 200 字）；否则 null。 */
export function pendingQuestionOf(records, last) {
  const speaker = lastSpeakerOf(records);
  if (speaker !== 'assistant') return null;
  const text = String((last && last.text) || '').trim();
  if (!text) return null;
  return endsWithQuestion(text) ? text.slice(-200) : null;
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
