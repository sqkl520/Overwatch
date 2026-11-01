#!/usr/bin/env node
/**
 * asked.mjs — 找出「AI 问了具体问题，人还没回答」的会话。**不依赖宿主。**
 *
 * 为什么是这个信号，而不是别的：
 *
 *   2026-11-01 先看真实分布，才发现之前三次尝试（novelty、心跳间隔、停止分类）
 *   全都建立在「停下来 = 有问题」这个错误前提上。实测 2,363 次真人接话：
 *   **87.5% 的停止，AI 并没有在问任何问题**——它只是说完了，人走开了。
 *   任何以「停久了」为前提的指标，都会把这部分误判成异常。
 *
 *   剩下的 12.5% 才是真正的「在等你」。而这一类**完全可以从 transcript 判断**：
 *   最后一条 assistant 消息里有问句 + 距今多久。不需要宿主写 waitingFor。
 *
 * 为什么要排除开场客套：
 *   实测 18 个问句结尾的会话里，7 个是「今天想做点什么呢喵？」这类问候。
 *   那不是卡住，是会话开场的客套话——永远不会有人回，也不该打扰人。
 *   判据：泛泛的「想做什么」是客套；带具体选项/具体动作的才是待决策。
 *
 * 用法：
 *   node scripts/asked.mjs                 # 人类可读
 *   node scripts/asked.mjs --json          # 机器可读
 *   node scripts/asked.mjs --hours 2       # 只看停了 2 小时以上的（默认 1）
 *
 * 零依赖。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 默认只看停够这么久的。1 小时：刚问完、人可能正在看，不该催。 */
export const DEFAULT_MIN_HOURS = 1;

/** 会话开场的客套话。这些永远没人回，也不该提醒。 */
export const GREETING = /今天想做什么|想从哪里开始|有什么需要帮忙|有什么可以帮|吩咐我就好|一声令下|告诉我.{0,6}需求|想做点什么呢|随时准备帮你|想让我帮|需要我做什么/;

/** 从 transcript 记录里取最后一条 assistant 的文字。 */
export function lastAssistantText(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (!r || r.type !== 'assistant' || !r.message) continue;
    const c = r.message.content;
    const txt = Array.isArray(c)
      ? c.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('')
      : (typeof c === 'string' ? c : '');
    if (txt.trim()) return { text: txt, timestamp: r.timestamp || null };
  }
  return null;
}

/** 末尾是不是问句。
 *
 *  **不是「最后 N 字里有问号」**——实测反例：`这是什么？反正做完了。`
 *  中间的问号是修辞，不是提问。判据是**问号之后没有实质内容**：
 *  去掉尾部标点后，最后一个问号必须就在结尾（最多再跟几个短词）。 */
export function endsWithQuestion(text) {
  if (!text) return false;
  const s = String(text).trim();
  const lastQ = Math.max(s.lastIndexOf('？'), s.lastIndexOf('?'));
  if (lastQ < 0) return false;
  // 问号之后剩下的内容：只有标点、空白，或极短的收尾词（如「喵」）
  const rest = s.slice(lastQ + 1).replace(/[\s"'）)】」』”。.…!！~～喵呀哦啊吧呢吗]+/g, '');
  return rest.length <= 2;
}

/** 判一条「问句」是真待决策，还是开场客套。 */
export function classifyQuestion(text) {
  const t = String(text || '');
  if (GREETING.test(t)) return 'greeting';
  const tail = t.slice(-400);
  // 具体选项（(a)/(b)、1.、- 列表）或明确的请求动作。
  // 「要我…」是真实语料里最常见的形态（「要我把旧三个删掉腾空间吗？」），必须收进来——
  // 早期版本只写了「要不要」，把这类全判成了 vague。
  const hasOptions = /\([a-d]\)|（[a-d]）|^\s*[1-9][.、]/m.test(tail);
  const hasAction = /要不要|要我|你说一声|请(你|问)|需要你|你看|选哪|哪个|还是/.test(tail);
  return (hasOptions || hasAction) ? 'decision' : 'vague';
}

/** 从 transcript 文件判定一个会话。返回 null 表示没有可报的东西。 */
export function inspectTranscript(filePath, { nowMs = Date.now(), minHours = DEFAULT_MIN_HOURS } = {}) {
  let raw;
  try { raw = readFileSync(filePath, 'utf8'); } catch { return null; }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { /* 半截行正常 */ }
  }
  const last = lastAssistantText(records);
  if (!last) return null;
  if (!endsWithQuestion(last.text)) return null;
  const kind = classifyQuestion(last.text);
  if (kind === 'greeting') return { skipped: 'greeting', filePath };
  const ts = Date.parse(last.timestamp || '');
  if (!Number.isFinite(ts)) return null;
  const hours = (nowMs - ts) / 3600e3;
  if (hours < minHours) return { skipped: 'too-recent', filePath, hours };
  return {
    filePath,
    hours: Math.round(hours * 10) / 10,
    kind,
    question: String(last.text).trim().slice(-400),
    project: basename(dirname(filePath)),
  };
}

/** 扫所有主 transcript（跳过 subagents）。 */
export function scanAll({ projectsRoot, nowMs = Date.now(), minHours = DEFAULT_MIN_HOURS } = {}) {
  const root = projectsRoot || join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return { found: [], scanned: 0, skipped: { greeting: 0, tooRecent: 0 } };
  const files = [];
  const walk = (d) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.jsonl') && !f.includes('subagents')) files.push(f);
    }
  };
  walk(root);

  const found = [];
  const skipped = { greeting: 0, tooRecent: 0 };
  for (const f of files) {
    const r = inspectTranscript(f, { nowMs, minHours });
    if (!r) continue;
    if (r.skipped === 'greeting') { skipped.greeting++; continue; }
    if (r.skipped === 'too-recent') { skipped.tooRecent++; continue; }
    found.push(r);
  }
  found.sort((a, b) => a.hours - b.hours); // 最近的排前面
  return { found, scanned: files.length, skipped };
}

export function formatResult(result) {
  const { found, scanned, skipped } = result;
  if (!found.length) {
    return `没有待回答的问题（扫了 ${scanned} 个 transcript）。\n` +
      `已排除：开场客套 ${skipped.greeting} 个，刚问完不到门槛 ${skipped.tooRecent} 个。`;
  }
  const lines = [`${found.length} 个会话在等你回答（扫了 ${scanned} 个 transcript）`];
  if (skipped.greeting || skipped.tooRecent) {
    lines.push(`已排除：开场客套 ${skipped.greeting} 个，刚问完 ${skipped.tooRecent} 个。`);
  }
  for (const it of found) {
    const age = it.hours < 48 ? `${it.hours} 小时` : `${(it.hours / 24).toFixed(1)} 天`;
    lines.push('');
    lines.push(`## ${it.project}（${age}前，${it.kind === 'decision' ? '待决策' : '泛泛提问'}）`);
    lines.push(`  ${it.question.replace(/\s+/g, ' ').slice(-240)}`);
  }
  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────

function main(argv) {
  const json = argv.includes('--json');
  const hi = argv.indexOf('--hours');
  const minHours = hi >= 0 ? Number(argv[hi + 1]) : DEFAULT_MIN_HOURS;
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node scripts/asked.mjs [--json] [--hours N]');
    console.log('  找出「AI 问了具体问题，人还没回答」的会话。不依赖宿主状态。');
    console.log(`  --hours N   只看停了 N 小时以上的（默认 ${DEFAULT_MIN_HOURS}）`);
    return 0;
  }
  const result = scanAll({ nowMs: Date.now(), minHours: Number.isFinite(minHours) ? minHours : DEFAULT_MIN_HOURS });
  if (json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2));
  } else {
    console.log(formatResult(result));
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}

void ROOT;
