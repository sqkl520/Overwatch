#!/usr/bin/env node
/**
 * analyze-hook-samples.mjs — 看 Stop hook「放行样本」的真实分布。
 *
 * `stop-verify-hook.mjs` 在判定为 `allow:no-checkable-claim`（根本没认出可核对断言）
 * 时会把末尾文本的前 500 字与工具调用摘要写进 `tasks/runs/stop-hook-samples.jsonl`。
 * 本脚本只读那个文件，回答三个问题：
 *
 *   1. 被放行的文本里，有多少条**含完成语义但一次测试都没跑**？（疑似漏检）
 *   2. 它们的形态有几种？按启发式聚成 5 类，不做模型判断。
 *   3. 有没有共同特征？交叉表：完成语义 × hadTestRun × hadBash × 工具数。
 *
 * ── 这个脚本**不参与拦截**，也不该被拿去自动拦截 ──────────────────
 *
 * 它存在的理由是「样本量不够，先看分布」。6 个样本（3 抓 3 漏）撑不起一条新规则；
 * 拿本脚本的输出直接生成正则，等于用分析工具给一个未知分布拟合参数。
 * 输出的每一行都是**待人工复核的候选**，不是「已确认的漏检」。
 *
 * ── 判据的来源 ────────────────────────────────────────────────────
 *
 * `hadBash` / `hadTestRun` / `hadVerification` 来自 hook 写样本时的**真实统计**
 * （遍历 transcript 的 tool_use，不是从自然语言里猜）。本脚本不重算它们。
 * 唯一新加的是「完成语义」的**宽松**识别 —— 它比生产用的 `COMPLETION_RE` 宽，
 * 目的正是把「生产判据说不是断言」的那些捞出来看。它只在这里用，永不回流到 hook。
 *
 * 用法：
 *   node scripts/analyze-hook-samples.mjs
 *   node scripts/analyze-hook-samples.mjs --file <path> --json
 *   node scripts/analyze-hook-samples.mjs --limit 20
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { displayWidth } from './tui-theme.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** 默认样本文件。与 `stop-verify-hook.mjs` 的 `samplePathFor` 必须一致 ——
 *  不一致的话分析命令会对着一个永远空的文件说「没有样本」，而那看起来像「没问题」。 */
export function defaultSamplesPath(env = process.env) {
  if (env.OVERWATCH_STOP_VERIFY_SAMPLES) return env.OVERWATCH_STOP_VERIFY_SAMPLES;
  return join(REPO_ROOT, 'tasks', 'runs', 'stop-hook-samples.jsonl');
}

/**
 * **分析专用**的宽松完成语义。两档：
 *
 *  - `COLON_COMPLETION_RE`：`已(全部)修好：` —— 实验里 P4 / P5 / P6 三组的形态。
 *    生产判据的 `(?=$|…标点…)` 前瞻把冒号当成「后面还有话说」而放弃，这里刻意认它。
 *  - `COMPLETION_ANY_RE`：更宽，`已+动词`、`都+动词+了`、英文 done/fixed。
 *
 * 两者都**只用于统计**。写回 `verify-claims.mjs` 是另一件事，需要先有分布数据。
 */
export const COLON_COMPLETION_RE = /(?:已|已经)\s*(?:全部|都|均已)?[^\n。；，,]{0,14}?(?:修好|修复|解决|完成|搞定|做完|改好|处理完|改完|补好|写上|收尾)\s*(?:了|啦|呀)?\s*[:：]/;

export const COMPLETION_ANY_RE = /(?:已|已经)\s*(?:全部|都|均已)?[^\n。；，,]{0,14}?(?:修好|修复|解决|完成|搞定|做完|改好|处理完|改完|补好|收尾)|(?:全部|都|均)\s*(?:修好|修复|解决|完成|搞定|做完|改好)|(?:修好|修复|搞定|改完|补好|解决)了|\b(?:done|fixed|completed|resolved)\b|\bit\s+works\s+now\b/i;

/** 读 JSONL。返回 `{ samples, badLines, total }`。文件不存在 → 空，不抛。
 *
 *  坏行只计数、不失败：样本文件是**追加写**的，一次进程被杀会留下半行，
 *  而那半行不该让整个分析停下来。 */
export function parseSampleLines(text) {
  const body = String(text || '');
  const samples = [];
  let badLines = 0;
  let total = 0;
  for (const line of body.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    total++;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object' && !Array.isArray(o)) samples.push(o);
      else badLines++;
    } catch {
      badLines++;
    }
  }
  return { samples, badLines, total };
}

/** 读样本文件。读不到就当作空 —— 分析命令没有「读失败」这个状态，
 *  它要么有数据要么没数据，模棱两可的报错只会让人以为工具坏了。 */
export function loadSamples(path) {
  try {
    if (!path || !existsSync(path)) return { samples: [], badLines: 0, total: 0, path: path || null };
    const r = parseSampleLines(readFileSync(path, 'utf8'));
    return { ...r, path };
  } catch {
    return { samples: [], badLines: 0, total: 0, path: path || null };
  }
}

/** 这段话含不含完成语义（宽松档）。`colon` 单列，因为它是本期最关心的形态。 */
export function completionShapeOf(text) {
  const t = String(text || '');
  if (COLON_COMPLETION_RE.test(t)) return 'colon';
  if (COMPLETION_ANY_RE.test(t)) return 'plain';
  return 'none';
}

/**
 * 形态聚类。**5 类，稳定不变**，好让多次采样的数字能直接对比。
 *
 *   detected-but-allowed  判定侧认出了族却仍然放行（正常情况下不该出现在样本里；
 *                         出现就说明记录被别的代码路径写进来了，是个 bug 信号）
 *   completion-colon      `已+动词：` 形态 —— 实验里 P4 / P5 / P6 三组
 *   completion-loose      有完成语义、但原始族正则一条都没命中
 *   completion-raw-hit    原始族正则命中了，但被否定 / 假设 / 部分完成（veto）筛掉的
 *   no-completion-language 这段话根本不含完成语义（正常的「我接下来要…」）
 *
 *  区分 `loose` 与 `raw-hit` 很重要：前者要补判据，后者要**复核否决条件对不对**，
 *  是两件方向相反的活。混在一起看就会得出「全都漏了」的错误结论。
 *
 *  判定顺序：`detected` → `raw-hit` → `colon` → `loose` → `no-completion`。
 *  `raw-hit` 排在 `colon` 前面是有意的：原始正则命中过，说明生产判据**看见了**这句话、
 *  是否决条件放掉的 —— 那与「完全没看见」是两件反向的活，不能被形态盖住。
 */
export function clusterOf(sample) {
  const s = sample || {};
  const text = String(s.lastMessage || '');
  const detected = Array.isArray(s.detectedFamilies) ? s.detectedFamilies : [];
  const raw = Array.isArray(s.rawFamilyHits) ? s.rawFamilyHits : [];
  if (detected.length) return 'detected-but-allowed';
  if (raw.length) return 'completion-raw-hit';
  if (completionShapeOf(text) === 'colon') return 'completion-colon';
  if (completionShapeOf(text) === 'plain') return 'completion-loose';
  return 'no-completion-language';
}

/** 这条样本是不是「疑似漏检」。
 *
 *  判据是**两个客观事实**的合取，不掺主观：
 *    ① 文本含完成语义（上面那套宽松识别）；
 *    ② 这一轮 `hadTestRun === false`（hook 遍历 transcript 得到的真实事实）。
 *
 *  为什么用 `hadTestRun` 而不是 `hadVerification`：任务的定义就是「跑没跑测试」。
 *  `hadVerification` 更宽（lint / tsc / build 都算），它在报告里单列一行 ——
 *  用它当判据会让「跑了 lint 说修好了」的会话被记成漏检，那是误伤。
 */
export function suspectOf(sample) {
  const s = sample || {};
  if (s.hadTestRun === true) return false;
  return completionShapeOf(s.lastMessage) !== 'none';
}

/** 更严的一档：连「任何形式的检查」都没做过。这批是**最值得先看**的。 */
export function strongSuspectOf(sample) {
  const s = sample || {};
  if (s.hadVerification === true) return false;
  return completionShapeOf(s.lastMessage) !== 'none';
}

/** 汇总统计。纯函数，`{}` 也必须能跑（结构门会拿空输入探一次）。 */
export function summarize(samples) {
  const arr = Array.isArray(samples) ? samples : [];
  const n = arr.length;

  const byCluster = {};
  const rawFamilies = {};
  let hadBash = 0;
  let hadTestRun = 0;
  let hadVerification = 0;
  let noShellAtAll = 0;
  let suspect = 0;
  let strongSuspect = 0;
  let withToolCalls = 0;
  let turnSum = 0;

  const suspects = [];

  for (const s of arr) {
    const c = clusterOf(s);
    byCluster[c] = (byCluster[c] || 0) + 1;

    for (const fam of (Array.isArray(s.rawFamilyHits) ? s.rawFamilyHits : [])) {
      rawFamilies[fam] = (rawFamilies[fam] || 0) + 1;
    }

    if (s.hadBash === true) hadBash++;
    if (s.hadTestRun === true) hadTestRun++;
    if (s.hadVerification === true) hadVerification++;
    if (s.hadBash !== true) noShellAtAll++;
    if (Number(s.toolCallCount || 0) > 0) withToolCalls++;
    turnSum += Number(s.assistantTurnCount || 0);

    if (suspectOf(s)) {
      suspect++;
      suspects.push(s);
      if (strongSuspectOf(s)) strongSuspect++;
    }
  }

  // 疑似漏检按形态再分一次 —— 「有几种形态」这个问题的直接答案。
  const suspectsByCluster = {};
  for (const s of suspects) {
    const c = clusterOf(s);
    suspectsByCluster[c] = (suspectsByCluster[c] || 0) + 1;
  }

  return {
    total: n,
    byCluster,
    suspectsByCluster,
    rawFamilies,
    hadBash,
    hadTestRun,
    hadVerification,
    noShellAtAll,
    withToolCalls,
    suspect,
    strongSuspect,
    avgAssistantTurns: n ? turnSum / n : 0,
    suspects,
  };
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

/** 按**显示宽度**右补空格。中文标签一个字占两列，`padEnd` 按字符数补会整体错位。
 *  复用 `tui-theme.mjs` 的 displayWidth（含 grapheme 聚类与东亚宽度表），
 *  而不是在这里再写一个宽度算法 —— 两份宽度算法迟早给出不同的对齐。 */
const padByWidth = (s, w) => {
  const str = String(s ?? '');
  const d = w - displayWidth(str);
  return d > 0 ? str + ' '.repeat(d) : str;
};

/** 一行统计：标签占固定显示宽度，数字右对齐，备注跟后面。 */
export function statLine(label, value, note = '') {
  return '  ' + padByWidth(label, 22) + String(value).padStart(4) + (note ? '  ' + note : '');
}

/** 渲染成人能读的报告。**必须把「这是候选不是结论」写在最上面** ——
 *  这份输出最容易被拿去当「确认的漏检数」引用，而它只是待复核的候选。 */
export function formatReport(summary, { path = null, badLines = 0 } = {}) {
  const s = summary || {};
  const total = Number(s.total || 0);
  const lines = [];

  lines.push('Stop hook 放行样本分析（allow:no-checkable-claim）');
  lines.push('='.repeat(56));
  lines.push('文件：' + (path || '(未指定)'));
  if (badLines) lines.push('坏行：' + badLines + '（追加写被打断留下的半行，已跳过）');
  lines.push('');

  if (!total) {
    lines.push('样本：0 条。');
    lines.push('');
    lines.push('这不是「没有问题」——是没有数据。让 Stop hook 跑一段真实会话再来。');
    lines.push('（记录默认开启，写在 ' + (path || 'tasks/runs/stop-hook-samples.jsonl') + '；');
    lines.push('  确认没被 --no-sample-log 或 OVERWATCH_STOP_VERIFY_SAMPLES=off 关掉。）');
    return lines.join('\n');
  }

  lines.push('样本：' + total + ' 条');
  lines.push('');

  lines.push('── 这一轮到底干了什么（hook 遍历 transcript 的真实统计）──────');
  lines.push(statLine('跑过测试', s.hadTestRun || 0, pct(s.hadTestRun || 0, total) + '%'));
  lines.push(statLine('做过任何检查', s.hadVerification || 0,
    pct(s.hadVerification || 0, total) + '%（测试 / 构建 / lint / 类型检查）'));
  lines.push(statLine('用过 shell', s.hadBash || 0, pct(s.hadBash || 0, total) + '%'));
  lines.push(statLine('完全没用过 shell', s.noShellAtAll || 0, pct(s.noShellAtAll || 0, total) + '%'));
  lines.push(statLine('平均 assistant 轮', Math.round((s.avgAssistantTurns || 0) * 10) / 10, ''));
  lines.push('');

  lines.push('── 疑似漏检（含完成语义 且 没跑过测试）────────────────────');
  lines.push(statLine('疑似', s.suspect || 0, pct(s.suspect || 0, total) + '%'));
  lines.push(statLine('其中更严的一档', s.strongSuspect || 0,
    pct(s.strongSuspect || 0, total) + '%（连 lint / build 都没做过）'));
  lines.push('');
  lines.push('  注意：这是**待人工复核的候选**，不是「已确认漏检」。宽松识别会把');
  lines.push('  「已经完成的报告我改了一处」这类描述性句子也算进来。');
  lines.push('');

  lines.push('── 形态分布（全部样本）──────────────────────────────────');
  const order = ['completion-colon', 'completion-raw-hit', 'completion-loose',
    'no-completion-language', 'detected-but-allowed'];
  const label = {
    'completion-colon': 'A 已+动词+冒号（P4/P5/P6 形态）',
    'completion-raw-hit': 'B 原始族命中但被否决（否定/部分完成）',
    'completion-loose': 'C 有完成语义、族一条没中',
    'no-completion-language': 'D 不含完成语义（正常）',
    'detected-but-allowed': 'E 认出了却仍放行（异常信号）',
  };
  const seen = new Set();
  for (const k of order) {
    if (!(k in (s.byCluster || {}))) continue;
    seen.add(k);
    lines.push(statLine(label[k] || k, s.byCluster[k],
      '(' + ((s.suspectsByCluster || {})[k] || 0) + ' 疑似)'));
  }
  for (const k of Object.keys(s.byCluster || {})) {
    if (seen.has(k)) continue;
    lines.push(statLine(k, s.byCluster[k], ''));
  }
  lines.push('');

  const fams = Object.entries(s.rawFamilies || {}).sort((a, b) => b[1] - a[1]);
  if (fams.length) {
    lines.push('── 原始族正则的命中次数（不经过否决过滤）──────────────────');
    for (const [f, c] of fams) lines.push(statLine(f, c, ''));
    lines.push('  命中却仍被放行 = 否决条件（否定 / 假设 / 部分完成）在起作用。');
    lines.push('  那不是 bug，但**值得逐条复核**：否决写宽了就会静默吞掉真断言。');
    lines.push('');
  }

  return lines.join('\n');
}

/** 疑似漏检里最值得先看的 N 条。按「越像真的漏检」排：有完成语义、没跑测试、
 *  但改过东西（toolCallCount > 0）。 */
export function topSuspects(summary, limit = 10) {
  const arr = Array.isArray(summary && summary.suspects) ? summary.suspects.slice() : [];
  arr.sort((a, b) => {
    const strong = Number(strongSuspectOf(b)) - Number(strongSuspectOf(a));
    if (strong) return strong;
    return Number(b.toolCallCount || 0) - Number(a.toolCallCount || 0);
  });
  return arr.slice(0, Math.max(0, limit));
}

function main(argv = process.argv.slice(2)) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  const path = arg('--file') || defaultSamplesPath();
  const limit = Number(arg('--limit') || 10);
  const asJson = argv.includes('--json');

  const loaded = loadSamples(path);
  const summary = summarize(loaded.samples);

  if (asJson) {
    // suspects 里含原文片段，JSON 输出同样受隐私边界约束：只到前 500 字（写入时已截）。
    process.stdout.write(JSON.stringify({
      path: loaded.path, total: loaded.total, badLines: loaded.badLines,
      ...summary,
    }, null, 2) + '\n');
    return 0;
  }

  process.stdout.write(formatReport(summary, { path: loaded.path, badLines: loaded.badLines }) + '\n');

  const top = topSuspects(summary, limit);
  if (top.length) {
    process.stdout.write('── 最值得人工复核的 ' + top.length + ' 条 ─────────────────────────\n');
    for (const s of top) {
      const ts = String(s.ts || '').slice(0, 19).replace('T', ' ');
      const flags = 'bash=' + (s.hadBash ? 'Y' : 'N')
        + ' test=' + (s.hadTestRun ? 'Y' : 'N')
        + ' check=' + (s.hadVerification ? 'Y' : 'N')
        + ' tools=' + Number(s.toolCallCount || 0);
      process.stdout.write('  ' + ts + '  ' + String(s.sessionId || '').slice(0, 8) + '  ' + flags + '\n');
      const snippet = String(s.lastMessage || '').replace(/\s+/g, ' ').slice(0, 100);
      process.stdout.write('    ' + snippet + '\n');
    }
    process.stdout.write('\n（原文只保留前 500 字，完整对话不进日志。）\n');
  }

  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main());
  } catch (e) {
    process.stderr.write('分析失败：' + String((e && e.message) || e) + '\n');
    process.exit(1);
  }
}
