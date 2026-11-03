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

/** 超过这么久的问题不再**通知**（仍会出现在 --history 的积压里）。
 *
 *  为什么必须有上限：2026-11-01 实收一条「Let's learn English! 问了没答」的通知，
 *  而那个会话文件 **244 小时（10 天）没动过**。它的问句是真的，但会话早就结束了——
 *  你不会去回答它，被打断只有损失。**没答 ≠ 该提醒。**
 *
 *  24 小时和 BACKLOG_HOURS 一致：实测 99% 的真实回复都在 24 小时内，
 *  超过一天还没答的，提醒也来不及了。 */
export const MAX_QUESTION_HOURS = 24;

/** 「刚问完、先别催」和「问了很久、别催了」之间，还有一个问号没回答：
 *  **现在还值不值得提醒。**
 *
 *  2026-11-02 实收一条误报：PerfScope 会话 `d48b776b` 的问句是真的
 *  （`2026-11-01T23:31:45.824Z`，「要我把这批改动提交吗喵？还是先继续 PRD 里的 18 个任务喵？」），
 *  但它问完之后**一秒就 idle 了，之后静默 10.5 小时**。上面两个门都拦不住它：
 *  24 小时以内、不是客套。
 *
 *  所以这里补的是**现状对账**，不是又一个时间阈值。三条，全部可离线复算：
 *
 *  1. **问句之后会话自己动过吗**（任何新增记录，含 tool_use / 后续 assistant 输出）
 *     → 动过就说明它没有真的在等人，它在继续干活。
 *  2. **宿主当前是不是 `idle`**（读 `~/.claude/sessions/*.json` 的 `status`）
 *     → 只有 `idle` 才可能是「停在这儿等人」。`busy` 说明它正在跑；没有记录说明会话已结束。
 *     实测 `d48b776b` 的 `statusUpdatedAt` 是 `2026-11-01T23:31:46.007Z`——比问句晚 183 毫秒，
 *     之后一直没变。**宿主在问完那一刻就把它置为 idle，然后它一整夜都是 idle。**
 *  3. **同目录（同一 cwd）的另一个会话里，问句之后有人说过话吗**
 *     → 说过就说明人已经在那边回应了这件事，这边不必再催。
 *
 *  三条都是 fail-closed 的同一方向：**任何一条成立就不提醒**。
 *  代价是漏报——但这条通知的信噪比已经在用户那里透支了（2026-11-02 得到的是
 *  「别再误报」，不是「做到完美」）。 */
export const ASKED_FRESHNESS = Object.freeze({
  /** 宿主状态比 transcript 晚一点点写（实测 183 毫秒）。这个宽限避免把
   *  「宿主还没来得及更新」误判成「会话已经走了」。 */
  hostGraceMs: 5 * 60_000,
});

/** 「问句之后一直静默」超过这么久，就不再提醒。**这是本次误报的正面判据。**
 *
 *  为什么 24 小时不够：`MAX_QUESTION_HOURS` 是拿「回复延迟分布」标定的
 *  （p90 = 15.4h、98% 在 24h 内），它回答的是「多久没答算积压」，
 *  不是「现在还值不值得打断人」。`d48b776b` 的问句在窗口内（10.5h），
 *  但它所在的会话**问完那一秒就 idle，之后再没有任何记录**——
 *  这正是 `MAX_QUESTION_HOURS` 结构上答不出的那件事。
 *
 *  为什么是 8 小时（2026-11-02 实测，本机 241 个 transcript、411 个问句结尾的 turn）：
 *
 *  | 问句后到会话下一条记录的间隔 | 累计 |
 *  |---|---|
 *  | ≤ 1h  | 77% |
 *  | ≤ 2h  | 86% |
 *  | ≤ 4h  | 89% |
 *  | **≤ 8h** | **93%** |
 *  | ≤ 12h | 95% |
 *  | ≤ 24h | 100% |
 *
 *  取 8h：93% 会恢复的会话都已经恢复了，剩下 7% 静默超过 8 小时。
 *  代价是可量化的——按同一组样本回推，8 小时门槛会拦掉 32/411 条（7.8%），
 *  其中 28 条后来确实被人回答了。**这是主动选择漏报 6.8%，换取不再误报。**
 *
 *  为什么不取 12h 或 24h：本次误报的问句静默了 10.5 小时。12h 的门槛拦不住它，
 *  24h 更是原样放过——那就等于没修。
 *
 *  ⚠ 这个数字来自「问句后还有没有记录」，不是「人有没有回话」。后者更慢
 *  （p90 = 15.4h），拿它定阈值会让门槛形同虚设：会话早就自己继续干活了，
 *  人却在 15 小时后才回——那种情况下再提醒是多余的。 */
export const ASKED_MAX_SILENCE_HOURS = 8;

/** 问句之后有没有**任何**「会话自己又走了一步」的记录。
 *
 *  停止点之后 0.1 秒，宿主会写一条 `system/stop_hook_summary`（见 `d48b776b` 第 20523 行）。
 *  那**不是**会话继续，是宿主的簿记。判据因此收窄到「带 `message` 的记录」：
 *  `user` / `assistant` 才有 message，system / attachment / last-prompt / cost-state 没有。
 *
 *  返回 null 表示问句时刻不可解析——那是**不知道**，不是「没有继续」。 */
export function continuedAfterQuestion(records, questionTs) {
  const t0 = Date.parse(questionTs || '');
  if (!Number.isFinite(t0)) return null;
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r !== 'object' || !r.message) continue;
    const t = Date.parse(r.timestamp || '');
    if (!Number.isFinite(t) || t <= t0) continue;
    return { at: r.timestamp, type: r.type };
  }
  return null;
}

/** 读宿主实时会话状态：`~/.claude/sessions/*.json`。
 *
 *  为什么需要它：`asked.mjs` 一直号称「不依赖宿主」——这对**发现**成立，
 *  对**该不该提醒**不成立。会话是不是还停在原地，只有宿主知道。
 *  读不到时返回空数组，由 `assessAsked` 决定怎么办。 */
export function readHostSessions(sessionsRoot) {
  const root = typeof sessionsRoot === 'string' && sessionsRoot ? sessionsRoot : null;
  if (!root || !existsSync(root)) return [];
  const out = [];
  let names;
  try { names = readdirSync(root); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let s;
    try { s = JSON.parse(readFileSync(join(root, name), 'utf8')); } catch { continue; }
    if (!s || !s.sessionId) continue;
    const updated = Number(s.statusUpdatedAt);
    out.push({
      sessionId: s.sessionId,
      status: s.status || null,
      statusUpdatedAt: Number.isFinite(updated) ? updated : null,
      cwd: typeof s.cwd === 'string' ? s.cwd : null,
    });
  }
  return out;
}

/** 同 cwd 的**其它**会话里，问句之后有人说过话吗。
 *
 *  为什么不能只看当前 transcript：2026-11-02 那条误报就是活证据。
 *  问句在 `d48b776b`（PerfScope），而人早就在**同一个 cwd** 的另一个会话
 *  `36b92630` 里说过「你不需要提交，只需要将自己的工作全部做完」——
 *  **单文件判定结构上看不到这句话**。
 *
 *  什么算「人说的话」：`type === 'user'` 且 `origin.kind === 'human'`。
 *  不用正则去猜文本，因为 `tool_result` 也是 `user` 记录，会把每一轮工具回执都算成人话。
 *  （`origin` 字段是宿主写的，实测 `D--dsh`/`Github`/`PerfScope` 的会话都有。）
 *
 *  `siblings` 是 `[{ sessionId, humans: [{ at, text }] }]`——**已经提取好的真人消息**，
 *  不是原始记录。扫 1.3 GB transcript 时不能把记录留在内存里，见 `scanAll` 的 `humanIndex`。
 *  返回命中的那一条，没有则 null。 */
export function humanSpokeElsewhere(siblings, questionTs) {
  const t0 = Date.parse(questionTs || '');
  if (!Number.isFinite(t0)) return null;
  for (const s of Array.isArray(siblings) ? siblings : []) {
    if (!s || !Array.isArray(s.humans)) continue;
    for (const h of s.humans) {
      const t = Date.parse(h && h.at ? h.at : '');
      if (!Number.isFinite(t) || t <= t0) continue;
      if (!h.text || !String(h.text).trim()) continue;
      return { sessionId: s.sessionId || null, at: h.at, text: String(h.text).trim().slice(0, 120) };
    }
  }
  return null;
}


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
export function inspectTranscript(filePath, { nowMs = Date.now(), minHours = DEFAULT_MIN_HOURS, maxHours = MAX_QUESTION_HOURS } = {}) {
  const records = readRecords(filePath);
  if (!records) return null;
  return inspectRecords(records, { filePath, nowMs, minHours, maxHours });
}

/** 读一个 transcript 的全部记录。读不到返回 null（不是空数组——那是「读到了但空的」）。
 *  单份可达 117 MB，所以**调用方必须自己保证只读一次**并复用结果。 */
export function readRecords(filePath) {
  let raw;
  try { raw = readFileSync(filePath, 'utf8'); } catch { return null; }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { /* 半截行正常 */ }
  }
  return records;
}

/** 已经解析好记录时的判定。`scanAll` 需要它：它要把**所有**会话里的真人消息
 *  登记进跨会话索引，包括那些不以问句结尾、因而不会成为候选的会话。
 *  若只走 `inspectTranscript`，那些会话的记录在索引之前就被丢掉了。 */
export function inspectRecords(records, { filePath = null, nowMs = Date.now(), minHours = DEFAULT_MIN_HOURS, maxHours = MAX_QUESTION_HOURS } = {}) {
  const last = lastAssistantText(records);
  if (!last) return null;
  if (!endsWithQuestion(last.text)) return null;
  const kind = classifyQuestion(last.text);
  if (kind === 'greeting') return { skipped: 'greeting', filePath };
  const ts = Date.parse(last.timestamp || '');
  if (!Number.isFinite(ts)) return null;
  const hours = (nowMs - ts) / 3600e3;
  if (hours < minHours) return { skipped: 'too-recent', filePath, hours };
  // **上限同样重要，而且我一开始漏了。**
  //
  // 2026-11-01 你收到一条「Let's learn English! 问了没答」——那个会话文件
  // **244 小时（10 天）没动过**。通知一个 10 天前的问句是谎报：
  // 它所在的会话早就结束了，你根本没机会回答，也不该被打断。
  //
  // `BACKLOG_HOURS` 之前只用在 history 统计上，没用在「要不要通知」上——
  // 两件事都得有上限。
  if (hours > maxHours) return { skipped: 'too-old', filePath, hours };
  return {
    filePath,
    hours: Math.round(hours * 10) / 10,
    kind,
    question: String(last.text).trim().slice(-400),
    project: basename(dirname(filePath)),
    // 现状对账要用的原始事实。**判定不在这里做**——这里只读一个文件，
    // 看不到同 cwd 的另一个会话，也看不到宿主状态。由 `scanAll` 统一收集后交 `assessAsked`。
    questionTs: last.timestamp || null,
    records,
    cwd: lastCwd(records),
  };
}

/** 会话的 cwd。取**最后一条带 cwd 的记录**，因为会话中途可能 chdir
 *  （实测 `36b92630` 的记录里出现过 `PerfScope` 与 `PerfScope/PerfScope` 两种）。 */
export function lastCwd(records) {
  for (let i = (Array.isArray(records) ? records.length : 0) - 1; i >= 0; i--) {
    const r = records[i];
    if (r && typeof r.cwd === 'string' && r.cwd) return r.cwd;
  }
  return null;
}

/** 「现在还值不值得提醒」的综合判定。**这是本文件唯一做现状对账的地方。**
 *
 *  输入全部是显式给的，不在这里读盘——这样每条判据都能被单独测试。
 *  返回 `{ keep: boolean, why: string, evidence }`。`keep === false` 时 `why` 说明是哪条否掉的。
 *
 *  判定顺序（任何一条否掉就返回，后面的不再看）：
 *    1. 问句之后**一直静默**超过 `ASKED_MAX_SILENCE_HOURS` → `silent-too-long`
 *    2. 会话自己继续过（问句之后有带 message 的记录）→ `continued`
 *    3. 同 cwd 的另一个会话里，问句之后有真人说过话 → `answered-elsewhere`
 *    4. 宿主说它现在不是 idle → `host-not-idle`
 *    5. 宿主说它是 idle，但 idle 是问句之前就置下的 → `host-idle-before-question`
 *
 *  1 放在最前面是有意的：它不依赖宿主、不依赖跨会话，只依赖 transcript。
 *  本次误报里正是它单独就足以拦下（`d48b776b` 静默 10.5h > 8h）。
 *  把它排在后面，一条「宿主读不到 + 没有兄弟会话」的会话就会绕过它。
 *
 *  为什么 3、4 分开：`status === 'idle'` 只说明「现在没在跑」，不说明「它是因为这个问句停下来的」。
 *  实测 `d48b776b` 的 `statusUpdatedAt` 比问句晚 183 毫秒——**宿主在问完那一刻就置了 idle**。
 *
 *  读不到宿主信息（`host` 为 null）时**不因此拦截**：那是采集缺失，不是证据。
 *  把它当成「不在等人」会让一次探测故障伪装成一次正常的保守行为。
 *
 *  `continued` 是 `continuedAfterQuestion()` 的结果（不是原始记录）：
 *  调用方扫 1.3 GB transcript 时不能把记录留着，只能留住这一条事实。
 */
export function assessAsked({
  questionTs, continued = null, host = null, hostStatus = null,
  siblingHit = null, nowMs = Date.now(),
  maxSilenceHours = ASKED_MAX_SILENCE_HOURS,
} = {}) {
  const t0 = Date.parse(questionTs || '');
  const evidence = { questionTs: questionTs || null, hostStatus: hostStatus || null };
  evidence.continuedAt = continued ? continued.at : null;
  evidence.silentHours = Number.isFinite(t0) ? Math.round(((nowMs - t0) / 3600e3) * 10) / 10 : null;

  // ── 1. 静默多久了 ──
  //
  // **这条不看 `continued`。**二者是不同的问题：
  //   continued       → 它是不是自己又走了一步（走过就不是在等人）
  //   silentHours     → 就算它没走，这么久没动静也说明它不是「此刻在等你」
  //
  // 本次误报里两条同时成立（静默 10.5h、期间零记录）。但**静默时长单独就够用**，
  // 因为它是唯一不依赖宿主、不依赖兄弟会话的判据。反过来说：
  // 如果一条会话静默了 10 小时，即使宿主说它 idle、即使没人在别处说话，
  // 那也已经是「被忘了」，不是「正在等你」——那正是 MAX_QUESTION_HOURS 想表达
  // 却因为用了错误的分布（回复延迟而不是恢复延迟）而没表达出来的意思。
  if (Number.isFinite(evidence.silentHours) && evidence.silentHours > maxSilenceHours) {
    return { keep: false, why: 'silent-too-long', evidence };
  }

  if (continued) {
    return { keep: false, why: 'continued', evidence };
  }

  if (siblingHit) {
    evidence.siblingSessionId = siblingHit.sessionId || null;
    evidence.siblingAt = siblingHit.at || null;
    return { keep: false, why: 'answered-elsewhere', evidence };
  }

  if (!host) {
    // 没读到宿主状态：不拦。但要看得出「这条没对账」。
    evidence.hostKnown = false;
    return { keep: true, why: 'host-unknown', evidence };
  }
  evidence.hostKnown = true;
  evidence.hostStatusAt = Number.isFinite(host.statusUpdatedAt)
    ? new Date(host.statusUpdatedAt).toISOString() : null;

  if (hostStatus !== 'idle') {
    return { keep: false, why: 'host-not-idle', evidence };
  }

  // 是 idle，但 idle 是什么时候置上的？
  // 早于问句 → 这次 idle 与这个问句无关，会话在问之前就已经停着了。
  // 宽限 hostGraceMs：宿主写状态比 transcript 晚一点点（实测 183 毫秒），
  // 但 5 分钟的宽限足以覆盖一次慢写，又不足以掩盖「昨天就停着了」。
  if (Number.isFinite(host.statusUpdatedAt) && Number.isFinite(t0) &&
      host.statusUpdatedAt < t0 - ASKED_FRESHNESS.hostGraceMs) {
    return { keep: false, why: 'host-idle-before-question', evidence };
  }

  evidence.idleHours = Number.isFinite(t0) ? Math.round(((nowMs - t0) / 3600e3) * 10) / 10 : null;
  return { keep: true, why: 'still-waiting', evidence };
}

/** 扫所有主 transcript（跳过 subagents）。
 *
 *  `sessionsRoot` 给出时，会对候选做**现状对账**（见 `assessAsked`）：
 *  同 cwd 的其它会话里有人在问句之后说过话 → 不算待回答；宿主说它不是在 idle → 不算待回答。
 *  不给 `sessionsRoot` 时不做对账——那是老调用方的行为，保持兼容；新调用方都应该给。
 */
export function scanAll({
  projectsRoot, sessionsRoot = null, nowMs = Date.now(),
  minHours = DEFAULT_MIN_HOURS, maxHours = MAX_QUESTION_HOURS,
} = {}) {
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

  // 宿主实时状态：只在需要做对账时读一次，不在循环里反复读
  const hosts = sessionsRoot ? readHostSessions(sessionsRoot) : null;
  const hostById = new Map();
  for (const h of hosts || []) hostById.set(h.sessionId, h);

  const found = [];
  const skipped = {
    greeting: 0, tooRecent: 0, tooOld: 0,
    silentTooLong: 0, continued: 0, answeredElsewhere: 0, hostNotIdle: 0,
  };
  // 每个会话当前「是否仍以未回答的问句结尾」。
  // 判定「已回答」必须靠它，而不是靠「这次没出现在结果里」——
  // 后者会把「被 minHours 门槛过滤掉」也算成已回答，产生 0 小时假延迟（实测过）。
  const stillAsking = new Map();
  // 跨会话证据：cwd → [{ sessionId, humans: [{ at }] }]。
  //
  // **只存真人消息的时间戳，不存记录本身。**本机 transcript 合计 1.3 GB，
  // 每 5 分钟全读一遍已经是既有成本；再把这些记录留在内存里会让成本翻倍，
  // 而且完全没必要——跨会话判据只问一句话：「这个 cwd 下有没有别的会话，
  // 在某个时刻之后有人说过话」。
  //
  // 索引必须覆盖**全部**会话，不能只覆盖候选会话：
  // 2026-11-02 那条误报里，说话的人（`36b92630`）当时并不是候选——
  // 它早就自己继续干活了。只索引候选会话会正好漏掉这个证据。
  const humanIndex = new Map();
  // 候选的「轻量事实」：不含 records，几 MB 的记录只在这一遍里活着。
  const pending = [];

  // ── 第一遍：读每个会话，登记真人消息，并挑出候选 ──
  //
  // 必须分成两遍。单遍的话，候选能不能拿到「同 cwd 的其它会话」证据
  // 取决于目录遍历顺序——排在候选后面的会话还没进索引就在证据之外了。
  // 测试当场抓到了这个：先写 asker 再写 sibling 就不拦，反过来就拦。
  for (const f of files) {
    // **每份只读一次。**单份最大 117 MB，本机合计 1.3 GB——读两次不是翻倍，
    // 是把这一层从「本来就慢」变成「明显卡」。索引和判定共用这一份记录。
    const records = readRecords(f);
    const sid = sessionIdOf(f);
    const cwd = records ? lastCwd(records) : null;

    // 无论是不是候选，都把它里面的真人消息登记进跨会话索引
    if (records && cwd) {
      const humans = records
        .filter((x) => x && x.type === 'user' && x.origin && x.origin.kind === 'human')
        .map((x) => ({ at: x.timestamp || null, text: userText(x) }))
        .filter((h) => h.at && h.text);
      if (humans.length) {
        if (!humanIndex.has(cwd)) humanIndex.set(cwd, []);
        humanIndex.get(cwd).push({ sessionId: sid, humans });
      }
    }

    const r = records ? inspectRecords(records, { filePath: f, nowMs, minHours, maxHours }) : null;

    stillAsking.set(sid, Boolean(r && r.skipped !== 'greeting'));
    if (!r) continue;
    if (r.skipped === 'greeting') { skipped.greeting++; continue; }
    if (r.skipped === 'too-recent') { skipped.tooRecent++; continue; }
    if (r.skipped === 'too-old') { skipped.tooOld++; continue; }

    // 只留这一条事实，records 在这一轮之后就可以被回收
    pending.push({
      base: {
        filePath: f, sessionId: sid, cwd, hours: r.hours, kind: r.kind,
        question: r.question, project: r.project, questionTs: r.questionTs,
      },
      continued: records ? continuedAfterQuestion(records, r.questionTs) : null,
    });
  }

  // ── 第二遍：对每个候选做现状对账 ──
  for (const it of pending) {
    const { base, continued } = it;
    const host = hostById.get(base.sessionId) || null;
    // 同 cwd 的其它会话。按 cwd 精确匹配——这正是「用户在另一个窗口里做了同一件事」的形态。
    // cwd 缺失时不做跨会话判定：拿不准就别把别人的会话当成证据。
    const siblings = base.cwd
      ? (humanIndex.get(base.cwd) || []).filter((s) => s.sessionId !== base.sessionId)
      : [];
    const siblingHit = humanSpokeElsewhere(siblings, base.questionTs);

    const verdict = assessAsked({
      questionTs: base.questionTs,
      continued,
      host: hosts ? host : null,
      hostStatus: host ? host.status : null,
      siblingHit,
      nowMs,
    });

    if (!verdict.keep) {
      if (verdict.why === 'silent-too-long') skipped.silentTooLong++;
      else if (verdict.why === 'continued') skipped.continued++;
      else if (verdict.why === 'answered-elsewhere') skipped.answeredElsewhere++;
      else skipped.hostNotIdle++;
      continue;
    }
    found.push({ ...base, freshness: verdict.why, evidence: verdict.evidence });
  }

  found.sort((a, b) => a.hours - b.hours); // 最近的排前面
  return { found, scanned: files.length, skipped, stillAsking };
}

/** 一条用户记录里的文字。tool_result 块不算——它是工具回执，不是人话。 */
function userText(rec) {
  const c = rec && rec.message && rec.message.content;
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('').trim();
}

export function formatResult(result) {
  const { found, scanned, skipped } = result;
  if (!found.length) {
    const bits = skipBits(skipped, { brief: true });
    return `没有待回答的问题（扫了 ${scanned} 个 transcript）。
` +
      (bits.length ? `已排除：${bits.join('，')}。` : '');
  }
  const lines = [`${found.length} 个会话在等你回答（扫了 ${scanned} 个 transcript）`];
  const bits = skipBits(skipped, { brief: false });
  if (bits.length) lines.push(`已排除：${bits.join('，')}。`);
  for (const it of found) {
    const age = it.hours < 48 ? `${it.hours} 小时` : `${(it.hours / 24).toFixed(1)} 天`;
    lines.push('');
    lines.push(`## ${it.project}（${age}前，${it.kind === 'decision' ? '待决策' : '泛泛提问'}）`);
    lines.push(`  ${it.question.replace(/\s+/g, ' ').slice(-240)}`);
  }
  return lines.join('\n');
}

/** 跳过原因的文案。**必须说清「为什么不再提醒」**——
 *  用户看到「没报」会以为是漏报，其实是判据认为它不值得提醒。 */
function skipBits(skipped, { brief = false } = {}) {
  const s = skipped || {};
  const bits = [];
  if (s.greeting) bits.push(`开场客套 ${s.greeting}`);
  if (s.tooRecent) bits.push(`刚问完 ${s.tooRecent}`);
  if (s.tooOld) bits.push(brief
    ? `超过 ${MAX_QUESTION_HOURS} 小时 ${s.tooOld}（会话多半已结束）`
    : `超过 ${MAX_QUESTION_HOURS} 小时 ${s.tooOld}（会话多半已结束，不再提醒）`);
  if (s.silentTooLong) bits.push(`问后静默过久 ${s.silentTooLong}（超过 ${ASKED_MAX_SILENCE_HOURS} 小时，多半已被忘掉）`);
  if (s.continued) bits.push(`问句后自己继续了 ${s.continued}`);
  if (s.answeredElsewhere) bits.push(`同项目别的会话里已被回应 ${s.answeredElsewhere}`);
  if (s.hostNotIdle) bits.push(`宿主说已不在等 ${s.hostNotIdle}`);
  return bits;
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

  const result = scanAll({
    nowMs,
    minHours: Number.isFinite(minHours) ? minHours : DEFAULT_MIN_HOURS,
    // 现状对账需要宿主状态。默认读 ~/.claude/sessions（与 watch.mjs 同源）。
    sessionsRoot: join(homedir(), '.claude', 'sessions'),
  });

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
