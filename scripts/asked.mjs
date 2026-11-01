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

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 默认只看停够这么久的。1 小时：刚问完、人可能正在看，不该催。 */
export const DEFAULT_MIN_HOURS = 1;

/** 已经是「积压」而不是「新问题」的阈值（小时）。
 *
 *  2026-11-01 实测：首轮扫描一次性收进 5 条问题，最早的是 21 天前。
 *  它们所在的会话早就不动了——**永远不会有人回答**。
 *
 *  把这类和新出现的问题混在一起，会让「已回答 0 / 待回答 N」永远难看，
 *  而它并不反映系统好坏，只反映「这个仓库里有多少历史遗留」。
 *
 *  为什么是 24：实测 492 个真实问答对，回复延迟 p90 = 14.7h、99% 在 24 小时内。
 *  超过一天还没答的，不是「在等」，是「被忘了」或「会话结束了」。
 *  （初版写 48，实测发现 44 小时的问题仍被算作待回答——已越过 p99 一倍。）
 *
 *  注意：积压条目**仍会出现在 asked.mjs 的输出里**（它们确实没答），
 *  只是不计入历史的「待回答」统计。
 */
export const BACKLOG_HOURS = 24;

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
  // 每个会话当前「是否仍以未回答的问句结尾」。
  // 判定「已回答」必须靠它，而不是靠「这次没出现在结果里」——
  // 后者会把「被 minHours 门槛过滤掉」也算成已回答，产生 0 小时假延迟（实测过）。
  const stillAsking = new Map();
  for (const f of files) {
    const r = inspectTranscript(f, { nowMs, minHours });
    const sid = sessionIdOf(f);
    // 注意：这里是「该会话现在是否仍以未回答的问句结尾」，**与 minHours 门槛无关**。
    // 早期写成 Boolean(r && !r.skipped)，于是被门槛过滤的也被记成 false，
    // 高门槛一跑就把 5 条全判成「已回答」，延迟算出 0 小时。
    stillAsking.set(sid, Boolean(r && r.skipped !== 'greeting'));
    if (!r) continue;
    if (r.skipped === 'greeting') { skipped.greeting++; continue; }
    if (r.skipped === 'too-recent') { skipped.tooRecent++; continue; }
    found.push(r);
  }
  found.sort((a, b) => a.hours - b.hours); // 最近的排前面
  return { found, scanned: files.length, skipped, stillAsking };
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

// ── 历史：这条问题是什么时候第一次出现的、后来被回答了吗 ──
//
// 由 492 个真实问答对得出的判据（2026-11-01 实测）：
//   回复延迟 p50 = 0.83h，p90 = 14.7h，**99% 在 24 小时内**。
//   所以「超过 24 小时没答」不是"还在考虑"，是"被忘了"——这是历史里最该看的数字。
//
// 为什么要历史：单次快照只能回答"现在谁在等我"，回答不了
//   "哪些提醒后真的被处理了""我平均多久回一次""这个东西到底有没有用"。
//   而没有后两个数字，就无法判断该不该继续提醒。

import { createHash } from 'node:crypto';

/** 会话内问题的稳定标识：sessionId + 问题文本的指纹。
 *  不用行号——transcript 会追加，行号会变。 */
export function questionKey(sessionId, question) {
  const h = createHash('sha256').update(`${sessionId}|${question}`).digest('hex').slice(0, 12);
  return h;
}

/** 从文件路径推 sessionId（文件名就是 uuid）。
 *
 *  路径在 Windows 上可能含 `\`（转义后的字面双反斜杠），
 *  `[\d]` 类的单字符类挡不住。用「剥掉目录与扩展名」而不是 split，
 *  这样对 `/`、`\`、`\` 混排都成立。 */
export function sessionIdOf(filePath) {
  const s = String(filePath).replace(/\.jsonl$/, '');
  const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return idx >= 0 ? s.slice(idx + 1) : s;
}

export function loadHistory(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && j.entries ? j : { version: 1, entries: {} };
  } catch { return { version: 1, entries: {} }; }
}

export function saveHistory(file, hist) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(hist, null, 2) + '\n', 'utf8');
}

/** 把当前扫描结果并进历史。
 *
 *  **「已回答」的判据是「该会话不再以未回答的问句结尾」，不是「这次没扫到」。**
 *  后者会把「被 minHours 门槛过滤掉」也算成已回答——实测产生了 0 小时的假延迟。
 *
 *  stillAsking: Map<sessionId, boolean>，由 scanAll 提供。
 *  缺失时（老调用方）保守处理：不做回答判定，只更新 lastSeenAt。 */
export function mergeHistory(hist, found, { nowMs = Date.now(), stillAsking = null } = {}) {
  const iso = new Date(nowMs).toISOString();
  const seen = new Set();
  let added = 0;
  let backlog = 0;

  for (const it of found) {
    const sid = sessionIdOf(it.filePath);
    const key = questionKey(sid, it.question);
    seen.add(key);
    const e = hist.entries[key];
    if (!e) {
      // 首次见到一个**已经很老**的问题 → 标为 backlog，不算「新发现」。
      // 它所在的会话多半早就不动了，永远不会有人回答；把它算进「待回答」
      // 只会让统计永远难看，而那不反映系统好坏。
      const isBacklog = Number(it.hours) >= BACKLOG_HOURS;
      if (isBacklog) backlog++;
      hist.entries[key] = {
        sessionId: sid,
        project: it.project,
        question: it.question.slice(-200),
        kind: it.kind,
        firstSeenAt: iso,
        lastSeenAt: iso,
        seenCount: 1,
        // backlog 的条目单独计数，不进「待回答」
        backlog: isBacklog,
        questionAgeHoursAtFirstSeen: Number.isFinite(it.hours) ? it.hours : null,
        answeredAt: null,
        answerLatencyHours: null,
      };
      added++;
    } else {
      e.lastSeenAt = iso;
      e.seenCount = (e.seenCount || 0) + 1;
      // 之前判过已回答、现在又出现 → 那不是回答，撤销
      if (e.answeredAt) { e.answeredAt = null; e.answerLatencyHours = null; e.reopenedAt = iso; }
    }
  }

  let answered = 0;
  if (stillAsking) {
    for (const [key, e] of Object.entries(hist.entries)) {
      if (e.answeredAt) continue;
      // backlog 条目不做回答判定：它们对应的会话早已结束，
      // 「没再扫到」是常态，不是「被回答了」。
      if (e.backlog) continue;
      // 只有明确知道该会话「不再以问句结尾」才判已回答。用 === false 而不是 !get(...)：
      // Map 里没有这个会话时返回 undefined，那表示「不知道」，不能当成「已不再问」——
      // 否则一个刚被删掉的 transcript 会被记成已回答，污染延迟统计。
      // （不需要额外排除本次仍扫到的：那种情况下 stillAsking 恒为 true。）
      if (stillAsking.get(e.sessionId) === false) {
        e.answeredAt = iso;
        const first = Date.parse(e.firstSeenAt || '');
        e.answerLatencyHours = Number.isFinite(first)
          ? Math.round(((nowMs - first) / 3600e3) * 10) / 10 : null;
        answered++;
      }
    }
  }
  return { added, answered, backlog, total: Object.keys(hist.entries).length };
}

/** 历史统计。回答「这东西有没有用」。
 *
 *  **backlog 条目单独算**：它们对应的会话早就结束了，永远不会有人回答。
 *  把它们算进「待回答」会让这个数字永远难看，而那不反映系统好坏。 */
export function historyStats(hist, { nowMs = Date.now() } = {}) {
  const all = Object.values(hist.entries || {});
  const backlog = all.filter((e) => e.backlog);
  const live = all.filter((e) => !e.backlog);
  const answered = live.filter((e) => e.answeredAt);
  const pending = live.filter((e) => !e.answeredAt);
  const lat = answered.map((e) => e.answerLatencyHours).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const q = (x) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * x))] : null);
  // 超过 24 小时仍未回答的：由实测分布，99% 的回复在 24h 内，所以这些基本是被忘了
  const stale = pending.filter((e) => {
    const first = Date.parse(e.firstSeenAt || '');
    return Number.isFinite(first) && (nowMs - first) > 24 * 3600e3;
  });
  return {
    total: all.length,
    backlog: backlog.length,
    // 让文案引用常量，不写死数字——写死过一次 48，改阈值后文案就对不上了
    backlogHours: BACKLOG_HOURS,
    answered: answered.length,
    pending: pending.length,
    stalePending: stale.length,
    latency: lat.length ? { p50: q(0.5), p90: q(0.9), min: lat[0], max: lat[lat.length - 1] } : null,
  };
}

/** 历史文件位置。与 watch.mjs 同源规则：**绝不写仓库**。
 *  和 watch 的状态目录放一起，这样备份/清理时是一份东西。 */
export function historyPath(env = process.env) {
  if (env.OVERWATCH_STATE_DIR) return join(env.OVERWATCH_STATE_DIR, 'asked-history.json');
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'Overwatch', 'asked-history.json');
  }
  const xdg = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(xdg, 'overwatch', 'asked-history.json');
}

export function formatHistory(st) {
  if (!st.total) {
    return '历史：空。还没有记录过任何问题。\n' +
      '（每次运行 `node scripts/asked.mjs` 都会自动记录，不需要额外操作。）';
  }
  const lines = [`历史：累计 ${st.total} 条问题`];
  if (st.backlog) {
    lines.push(`  其中 ${st.backlog} 条是**历史积压**（首次发现时就已超过 ${st.backlogHours} 小时）——`);
    lines.push('  它们所在的会话早已结束，不会有回复，不计入下面的统计。');
  }
  lines.push(`  已回答 ${st.answered} 条 · 仍待回答 ${st.pending} 条`);
  if (st.stalePending) {
    lines.push(`  其中 ${st.stalePending} 条已超过 24 小时——由实测分布，99% 的回复在 24h 内，`);
    lines.push('  这些基本是被忘了，而不是还在考虑。');
  }
  if (st.latency) {
    lines.push('');
    lines.push('从发现到被回答的延迟：');
    lines.push(`  p50 ${st.latency.p50}h · p90 ${st.latency.p90}h（最短 ${st.latency.min}h，最长 ${st.latency.max}h）`);
    lines.push('');
    lines.push('这是判断「该不该继续提醒」的依据：延迟远小于提醒门槛，说明提醒没在解决真问题。');
  }
  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────

function main(argv) {
  const json = argv.includes('--json');
  const showHistory = argv.includes('--history');
  const noSave = argv.includes('--no-save');
  const hi = argv.indexOf('--hours');
  const minHours = hi >= 0 ? Number(argv[hi + 1]) : DEFAULT_MIN_HOURS;
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node scripts/asked.mjs [--json] [--hours N] [--history] [--no-save]');
    console.log('  找出「AI 问了具体问题，人还没回答」的会话。不依赖宿主状态。');
    console.log(`  --hours N   只看停了 N 小时以上的（默认 ${DEFAULT_MIN_HOURS}）`);
    console.log('  --history   看历史统计：发现多少、被回答多少、平均多久回');
    console.log('  --no-save   只查不记（默认每次运行都会更新历史）');
    console.log(`  历史文件：${historyPath()}`);
    return 0;
  }

  const nowMs = Date.now();
  const histFile = historyPath();

  if (showHistory) {
    const hist = loadHistory(histFile);
    const st = historyStats(hist, { nowMs });
    if (json) {
      console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...st }, null, 2));
    } else {
      console.log(formatHistory(st));
    }
    return 0;
  }

  const result = scanAll({ nowMs, minHours: Number.isFinite(minHours) ? minHours : DEFAULT_MIN_HOURS });

  let merged = null;
  if (!noSave) {
    const hist = loadHistory(histFile);
    merged = mergeHistory(hist, result.found, { nowMs, stillAsking: result.stillAsking });
    try { saveHistory(histFile, hist); } catch { /* 记不了历史不影响本次输出 */ }
  }

  if (json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...result, history: merged }, null, 2));
  } else {
    console.log(formatResult(result));
    if (merged) {
      console.log('');
      console.log(`历史：新记 ${merged.added} 条，判定已回答 ${merged.answered} 条，累计 ${merged.total} 条。`);
      console.log('（看整体统计用 --history）');
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}

void ROOT;
