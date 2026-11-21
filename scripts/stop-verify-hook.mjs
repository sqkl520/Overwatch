#!/usr/bin/env node
/**
 * stop-verify-hook.mjs — Stop hook 验证闸。
 *
 * 宿主在 Claude **准备结束回合时同步调用**本脚本，把本轮最终回复原文
 * (`last_assistant_message`) 等字段以 JSON 从 stdin 喂进来。脚本判定「这句话里的
 * 完成性断言有没有证据」，没有就返回 `{"decision":"block","reason":"..."}`，
 * 宿主把 reason 作为下一轮指令喂回模型。
 *
 * 与 `verify-claims.mjs` 的分工：判定逻辑**完全复用**它（`detectClaims` /
 * `findEvidence` / `classifyEvidence`），本脚本只负责「读 hook 输入 → 调判定 →
 * 写 reason → 记账」。不在两处各写一套规则，否则两边迟早给出相反的结论。
 *
 * ── 设计原则（按对用户的伤害排序）───────────────────────────────
 *
 * 1. **fail-open 是默认，且不可配置成 fail-closed。** hook 崩了、超时了、输入是垃圾、
 *    transcript 读不到 —— 一律放行（exit 0，无输出）。理由：这个 hook 挡的是
 *    「Claude 想结束」。它一旦故障就挡死，用户会看到一个**无法结束的会话**。
 *    那比一百个未验证的断言更糟 —— 后者是数据质量问题，前者是用户被锁在门外。
 *    宿主本身有 8 次强制放行的兜底（`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`），但那是
 *    宿主给的保险，不该成为我们依赖的唯一保险。
 *
 * 2. **默认只放行不拦。** `OVERWATCH_STOP_VERIFY` 没设成 `block` 时，本脚本只写观测
 *    记录、永远 exit 0。用户必须显式开启。见 `docs/research/2026-11-12-stop-hook-prototype.md`。
 *
 * 3. **后台任务在跑就不拦。** 输入里的 `background_tasks` 非空意味着它在等活干完，
 *    这时候「结束回合」是正常的。拦它等于让人在电梯里按关门键。
 *
 * 4. **只认「证据不足」，不认「证据矛盾」。** `NO_EVIDENCE` / `STALE_ONLY` 拦；
 *    `FAILED_ONLY` 也拦（明确的失败）；`UNKNOWN` / `UNCHECKABLE` **不拦** ——
 *    我们没读到不等于它没做。宁可漏放一个假的，不可错拦一次真的。
 *
 * ── 输入 / 输出 ─────────────────────────────────────────────────
 *
 * stdin: 宿主给的 JSON（`session_id` / `transcript_path` / `cwd` / `hook_event_name` /
 *        `stop_hook_active` / `last_assistant_message` / `background_tasks` /
 *        `session_crons` / `permission_mode` / `effort`）。
 * stdout: `{"decision":"block","reason":"..."}` 或空（放行）。
 *
 * ── 可观测 ─────────────────────────────────────────────────────
 *
 * 每次**判定**都追加一行 JSON 到 `tasks/runs/stop-hook/YYYY-MM-DD.jsonl`。
 * 这是「闸门是否有效」的唯一数据来源，所以连「放行为什么放行」也要记。
 * 路径可用 `OVERWATCH_STOP_VERIFY_LOG` 覆盖（测试用）。
 *
 * 另有一条**放行样本**通道（见文件末 §样本记录）：判定为 `no-checkable-claim`
 * 时把末尾文本的前 500 字与工具调用摘要追加到 `tasks/runs/stop-hook-samples.jsonl`。
 * 它只是语料，**不参与判定** —— 现在是采集阶段，不是规则阶段。
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detectClaims, findEvidence, classifyEvidence, buildEvidenceIndex, readBack,
  readTailRecords, subagentFiles, isTestCommand, isVerificationCommand, CLAIM_FAMILIES,
  familyName,
} from './verify-claims.mjs';
import { detectProjectCommands, commandHint } from './project-commands.mjs';
import { stateRoot, STATE_DIR_NAME, LEGACY_DIR_NAME, resolveStateDir } from './state-dir.mjs';
import { createHash } from 'node:crypto';
import { claimOnce, claimKeyOf, recordSkipped } from './hook-dedupe.mjs';

/** 修前这里还有 `const HERE = ...` 与 `const REPO_ROOT = resolve(HERE, '..')`，
 *  只被三处**台账默认路径**用。三处都已改到 `ledgerRoot()`（状态目录），
 *  所以两个常量连同它们的用途一起消失了 —— 留着只会让下一个人以为
 *  「框架根是这个 hook 的正当落点」。 */

/** 判定会拦的档位。UNKNOWN / UNCHECKABLE 刻意不在此列（见文件头 §4）。 */
export const BLOCKING_STATUS = Object.freeze(['NO_EVIDENCE', 'STALE_ONLY', 'FAILED_ONLY']);

/** 默认最多回溯这么多。Stop hook 跑在**用户的回合结束点上**，慢就是直接的体感伤害。
 *  实测：尾部 1MB 足够覆盖绝大多数会话的最后一次编辑 + 最后一次测试。 */
export const DEFAULT_BACKTRACK_MB = 8;

/** hook 的整体预算（毫秒）。超过就放行 —— 宁可放过，不可让用户等。
 *  宿主自己的 hook `timeout` 是第二道保险，不能当第一道。 */
export const DEFAULT_BUDGET_MS = 20_000;

/** 从第几次拦截开始升级语气。宿主默认 8 次后强制放行，我们在 4 次时开始明说。 */
export const ESCALATE_AT = 4;

/** 我们自己的拦截上限。到顶就不再拦，只记账。
 *
 *  为什么要有自己的上限，而不是信宿主的 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`：
 *  宿主的默认值是实现细节（实测 2.1.308 是「连续 9 次后强制放行」），会随版本变；
 *  而「用户被锁在无法结束的会话里」是**不可接受**的后果。把上限写在我们这边，
 *  代价是可能比宿主早放行两次（少拦两次），换来的是任何宿主版本下都不会锁死。
 *  取 6：留两个身位给宿主的兜底，且足够让模型走完「发现 → 跑测试 → 贴输出」的循环。 */
export const MAX_BLOCKS = 6;

/** 模式：off（默认，只观测不拦）/ block（真的拦）。 */
export function modeOf(env = process.env) {
  const v = String(env.OVERWATCH_STOP_VERIFY || '').trim().toLowerCase();
  if (v === 'block' || v === 'on' || v === '1' || v === 'true') return 'block';
  return 'off';
}

// ── 用户叫停路径（三层）。见 `docs/` 里那份「停要带 delta」的设计 §4。 ──
//
// **为什么需要这一层**：任何一个默认开启的强拦，都必须给出一个不可被 hook 逻辑
// 覆盖的用户叫停路径，否则就是把用户锁在自己的会话里。真实事故：用户说
// 「stop everything, you are done」之后，会话又起了子 agent 和一次外部 run 并截图。
//
// 三层各管一种情形，缺一层就有一种锁门方式：
//   L1 文件闸   —— 用户想一劳永逸地关掉这个闸（不需要它理解任何上下文）
//   L2 用户发话 —— 用户**已经说话了**（事故里正是这种：他说了停，hook 还在拦）
//   L3 预算耗尽 —— 闸门自己用完了配额，且这件事必须可见
//
// 这里先说清它**不保证**什么：它只保证「我们不再增加轮次」。正在跑的
// 子 agent / 后台任务 / 外部命令**停不了** —— 那需要宿主提供 abort 接口，
// 本仓已把「实时干预运行中的会话」列为做不到（CAPABILITIES.md，ADR-0001 §代价·3）。

/** 叫停文件名。改名只影响**目录**，文件名不动 —— 用户手里已有的文件不必重命名。 */
export const PAUSE_FILE_NAME = 'stop-hook.PAUSE';

/** L1 的闸门文件路径族。放**仓库外**（`%LOCALAPPDATA%/<状态目录>/`），两条理由：
 *  ① 被 hook 的项目通常不是本仓库（模板里 `CLAUDE_PROJECT_DIR` 是用户当前项目），
 *     放 `tasks/runs/` 会落到别人的仓库里去；
 *  ② `DF-020` 记录过状态目录被整个清空且无告警，别把「唯一能关门的开关」也放进去。
 *
 *  **为什么是一个列表而不是一个路径（`DF-041`，2026-11-21 修）**：
 *  `state-dir.mjs` 把状态目录从 `Overwatch` / `overwatch` 改名成 `UntilDone` / `untildone`，
 *  而这里此前硬编码旧名。后果是**闸关不掉**：用户按新文档在 `UntilDone/` 放文件不生效，
 *  必须猜中旧目录才行 —— 而这是本 hook 唯一的叫停开关。
 *
 *  目录解析规则**刻意不照抄** `resolveStateDir()` 的「新存在用新、否则用旧」：
 *  那条规则的目的是「别让历史数据看起来消失了」，对**数据**正确；而 PAUSE 文件的语义是
 *  「用户要求停止」。用户可能因为看到旧文档、旧脚本、或自己迁移到一半，把文件放在任一处。
 *  所以这里的方向是 **fail-safe：任何一条候选路径存在都算叫停**（宁可多放行一次，
 *  不可漏掉一次叫停）。
 *
 *  候选顺序 = 优先级，主路径在前：
 *    1. `OVERWATCH_STOP_VERIFY_PAUSE`（显式指定，唯一生效，不叠加）
 *    2. `$OVERWATCH_STATE_DIR/stop-hook.PAUSE` —— 本仓统一的临时区变量。两个 hook 与
 *       `hook-dedupe` 都认它，「我把副作用关进临时目录了」这句话对叫停路径也必须为真
 *       （`DF-041` 影响 2）。
 *    3. `<stateRoot>/UntilDone|untildone/stop-hook.PAUSE` —— 新目录
 *    4. `<stateRoot>/Overwatch|overwatch/stop-hook.PAUSE` —— 旧目录（**向后兼容，不许删**）
 *
 *  路径拼接**复用 `state-dir.mjs` 的 `stateRoot()` 与两个目录名常量**，不在本文件写第三份。
 *  此前那段 `env.LOCALAPPDATA || env.XDG_STATE_HOME || join(homedir(), '.local', 'state')`
 *  在 win32 上没有 `%LOCALAPPDATA%` 时会回落到 `.local/state`，与 `state-dir.mjs` 的
 *  `AppData/Local` 不是同一个地方 —— 同一台机器两个「状态根」正是本仓反复付账的那类漂移。 */
export function pausePathsFor(env = process.env) {
  const explicit = String(env.OVERWATCH_STOP_VERIFY_PAUSE || '').trim();
  if (explicit) return [explicit];

  const plat = process.platform === 'win32' ? 'win32' : 'posix';
  const out = [];
  const stateDir = String(env.OVERWATCH_STATE_DIR || '').trim();
  if (stateDir) out.push(join(stateDir, PAUSE_FILE_NAME));
  try {
    const root = stateRoot(env);
    out.push(join(root, STATE_DIR_NAME[plat], PAUSE_FILE_NAME));
    out.push(join(root, LEGACY_DIR_NAME[plat], PAUSE_FILE_NAME));
  } catch { /* 连状态根都算不出来：只剩上面那条 `OVERWATCH_STATE_DIR` 候选 */ }

  // 去重（`OVERWATCH_STATE_DIR` 恰好指到状态目录本身时会出现重复项）。
  return [...new Set(out)];
}

/** **主**闸门文件路径 = `pausePathsFor()` 的第一项。
 *
 *  保留这个名字是因为它在 `pre-write-gate.mjs`、模板与文档里已被引用；语义从
 *  「唯一路径」变成「用户最该放文件的那一个」。**判定不走它** —— 判定走
 *  `pausedPathOf()` 的全量候选，否则旧路径上的文件会被这条主路径挡住。 */
export function pausePathFor(env = process.env) {
  const all = pausePathsFor(env);
  if (all.length) return all[0];
  // 候选为空只可能发生在 `stateRoot()` 抛了、且没设 `OVERWATCH_STATE_DIR`。
  // `pausePathFor()` 是给人和日志看的名字，不能让调用方拿到 `undefined`；
  // 判定不受影响（`pausedPathOf()` 对空候选返回 null，即「没暂停」）。
  try {
    return join(stateRoot(env), STATE_DIR_NAME[process.platform === 'win32' ? 'win32' : 'posix'], PAUSE_FILE_NAME);
  } catch {
    return PAUSE_FILE_NAME;
  }
}

/** L1：返回**命中的那条**路径；没命中返回 null。
 *
 *  与 `isPaused()` 分开是为了可观测：只回布尔的话，「用户想停」与「用户把文件放错了地方」
 *  在日志与 `status` 输出里长得一样。命中的是哪一条要能说出来。 */
export function pausedPathOf(env = process.env) {
  let paths;
  try { paths = pausePathsFor(env); } catch { return null; }
  for (const p of paths) {
    if (!p) continue;
    try { if (existsSync(p)) return p; } catch { /* 单条读不了不影响其余候选 */ }
  }
  return null;
}

/** L1：闸门文件存在 = 用户要求停止拦截。**必须在任何判定之前检查**。
 *
 *  「不可被 hook 覆盖」= hook 的任何分支都无法越过它。它**可以**被模型用 Bash 删掉 ——
 *  但那是一次会在 transcript 里留痕的操作，事后可审计。这里不假装它是安全的。 */
export function isPaused(env = process.env) {
  return pausedPathOf(env) !== null;
}

/** L2：最后一条**真人**消息是否晚于上次拦截 → 用户已经表态，此后不再拦。
 *
 *  **不用文本匹配**「stop everything」：多语言、多说法，而且那本身是不可判定的
 *  意图识别。本仓已有反例（`measure-interventions.mjs` 的 NUDGE 正则要靠
 *  `NUDGE_MAX_LEN` 兜住误判）。这里用结构性判据：`origin.kind === 'human'`。
 *
 *  与 `stop_hook_active` 的关系：那条说的是「这次 Stop 已经是某次 hook 拦下来的」，
 *  说的是**机制**；这条说的是「用户在拦截之后又说话了」，说的是**人**。
 *  两者会重叠，但语义不同，所以分开判、分开记。 */
export function userIntervenedSince(sessionId, {
  records = null, env = process.env, nowMs = Date.now(),
} = {}) {
  if (!sessionId || !Array.isArray(records) || !records.length) return null;
  const lastBlock = lastBlockAt(sessionId, { env });
  if (!lastBlock) return null;
  let lastHuman = null;
  for (const r of records) {
    if (!r || r.origin && r.origin.kind !== 'human') continue;
    if (r.type !== 'user' && r.role !== 'user') continue;
    const t = Date.parse(r.timestamp || '');
    if (!Number.isFinite(t)) continue;
    if (lastHuman === null || t > lastHuman) lastHuman = t;
  }
  if (lastHuman === null || lastHuman <= lastBlock) return null;
  return { lastHumanAt: new Date(lastHuman).toISOString(), lastBlockAt: new Date(lastBlock).toISOString() };
}

/** 上次拦截的时间戳（毫秒）。没有记录返回 0。只读，不修改状态。 */
export function lastBlockAt(sessionId, { env = process.env } = {}) {
  try {
    const p = statePathFor(env);
    if (!existsSync(p)) return 0;
    const state = JSON.parse(readFileSync(p, 'utf8'));
    const cur = state && state[sessionId];
    return Number(cur && cur.lastAt || 0);
  } catch {
    return 0;
  }
}

/** 读 stdin 全部内容。宿主可能不关管道，所以要靠上层超时兜底。 */
export function readStdin(stream, limitBytes = 4 * 1024 * 1024) {
  return new Promise((res) => {
    let buf = '';
    let done = false;
    const finish = () => { if (!done) { done = true; res(buf); } };
    stream.setEncoding('utf8');
    stream.on('data', (c) => {
      buf += c;
      if (buf.length > limitBytes) { finish(); }
    });
    stream.on('end', finish);
    stream.on('error', finish);
    // 已经在末尾（EOF 已过）时不会再有 end 事件
    if (stream.readableEnded) finish();
  });
}

/** 安全地解析 hook 输入。解析失败返回 null —— 调用方按 fail-open 处理。 */
export function parseHookInput(text) {
  try {
    const o = JSON.parse(String(text || ''));
    // 数组也是合法 JSON，但 hook 输入永远是对象。认成对象会在后面静默变成
    // 「没有 last_assistant_message」→ 放行 —— 结果对，但不是因为判定正确。
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    return o;
  } catch {
    return null;
  }
}

/** 本轮的「真·最后一条 assistant 文本」。
 *
 *  hook 输入里的 `last_assistant_message` 是权威来源，但它偶尔为空（比如纯工具轮）。
 *  为空时退回 transcript 的尾部读取 —— 两条路都失败就返回空串，调用方据此放行。
 */
export function resolveAssistantText(input, records) {
  const direct = String((input && input.last_assistant_message) || '').trim();
  if (direct) return direct;
  const arr = Array.isArray(records) ? records : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const r = arr[i];
    if (!r || r.type !== 'assistant') continue;
    const blocks = Array.isArray(r.message && r.message.content) ? r.message.content : [];
    const t = blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('').trim();
    if (t) return t;
  }
  return '';
}

/** 判定这一轮该不该拦。
 *
 *  `subagentRecords` 是可选的旁证：子 agent 的 transcript 记录。给了就在**主 transcript
 *  判为要拦**之后再看它们 —— 代价只在我们本来就要拦的时候才付。
 *
 *  为什么需要它（实测依据）：抽 80 个真实会话，15 个含可核对断言，其中 **14 个有子 agent
 *  transcript**。执行 Agent 把测试跑在子 agent 里、主会话只贴结论，是这套工作流的常态。
 *  不查子 agent，闸门会对绝大多数真实会话误报「没证据」—— 那正是 `verify-claims.mjs`
 *  当年踩过的坑（它为此加了 `--include-subagents`）。
 *
 *  查到之后**不判 SUPPORTED，判 UNKNOWN 然后放行**。理由与 `verify-claims.mjs` 一致：
 *  子 agent 的调用不在主时间线上，我们无法确认它发生在最后一次编辑之后。宁可放过，
 *  不可错拦 —— 拦截在这里是「直接阻止用户结束会话」，误报的代价比在报告里标错一格高得多。
 */
export function decide({ input, records, cwd, project, blockCount = 0, mode = 'off', subagentRecords = null } = {}) {
  const text = resolveAssistantText(input, records);
  const claims = text ? detectClaims(text) : [];
  const checkable = claims.filter((c) => c.checkable);

  const base = {
    mode,
    checkableCount: checkable.length,
    claimFamilies: checkable.map((c) => c.family),
    blockCount,
    // 判定用的原文。放行样本要记它的前 500 字；在这里给出去，避免 runHook 再解一遍
    // 又和判定的取文路径分叉（两条路读出的文本不一致，样本就会对着错的原文分析）。
    assistantText: text,
  };

  // ── `stop_hook_active`：**先判它，再判别的**。 ──
  //
  // 宿主文档的定义是「这次 Stop 已经是某次 Stop hook 导致继续的结果」。它的用途是
  // 防止对一个永远不成立的条件反复 block —— 文档原话是「查这个值，否则会反复拦」。
  //
  // 这个字段此前只被记进日志（`record.stopHookActive`），`decide()` 从头到尾不读它，
  // 等同「照文档写了一半」。现在它在最前面，因为它的语义是**关于这次调用本身**的，
  // 而不是关于某个 claim 的。
  //
  // **为什么放在 `no-checkable-claim` 之前**：没有可核对断言时本来就放行，先判后判
  // 结果一样；但把它放前面，日志里的 `allowReason` 会准确 —— 否则一个因
  // `stop_hook_active` 而放行的调用会被记成「没有可核对断言」，两个完全不同的原因
  // 混成一条，事后统计就又出现「同一个桶里装两件事」。
  if (input && input.stop_hook_active) {
    return {
      ...base,
      action: 'allow',
      allowReason: 'stop-hook-active',
      blocking: [],
      reason: '',
    };
  }

  if (!checkable.length) {
    return { ...base, action: 'allow', allowReason: 'no-checkable-claim', blocking: [], reason: '' };
  }

  // 后台任务 / 定时任务在跑：它在正常工作，不该拦。
  const bg = Array.isArray(input && input.background_tasks) ? input.background_tasks : [];
  const crons = Array.isArray(input && input.session_crons) ? input.session_crons : [];
  if (bg.length || crons.length) {
    return {
      ...base,
      action: 'allow',
      allowReason: 'background-tasks-running',
      backgroundTasks: bg.length,
      sessionCrons: crons.length,
      blocking: [],
      reason: '',
    };
  }

  const index = buildEvidenceIndex(records);
  let blocking = [];
  for (const claim of checkable) {
    const verdict = verdictFor(claim, records, index);
    if (BLOCKING_STATUS.includes(verdict.status)) {
      blocking.push({ claim, verdict });
    }
  }

  if (!blocking.length) {
    return { ...base, action: 'allow', allowReason: 'all-claims-supported', blocking: [], reason: '' };
  }

  // 主 transcript 说要拦 —— 这时才去看子 agent。放行理由要如实写明是「旁证」。
  if (Array.isArray(subagentRecords) && subagentRecords.length) {
    const subIndex = buildEvidenceIndex(subagentRecords);
    const stillBlocking = [];
    const seenInSubagents = [];
    for (const b of blocking) {
      const subVerdict = verdictFor(b.claim, subagentRecords, subIndex);
      if (subVerdict.status === 'SUPPORTED') {
        seenInSubagents.push({ family: b.claim.family, quote: b.claim.quote });
      } else {
        stillBlocking.push(b);
      }
    }
    if (seenInSubagents.length) {
      if (!stillBlocking.length) {
        return {
          ...base,
          action: 'allow',
          allowReason: 'evidence-only-in-subagents',
          seenInSubagents,
          blocking: [],
          reason: '',
        };
      }
      // 一部分在子 agent 里有、一部分没有：只拦缺的那部分。
      return {
        ...base,
        action: 'block',
        blocking: stillBlocking,
        seenInSubagents,
        reason: buildReason({ blocking: stillBlocking, project, blockCount, mode }) + subagentCaveat(seenInSubagents),
      };
    }
  }

  return {
    ...base,
    action: 'block',
    blocking,
    reason: buildReason({ blocking, project, blockCount, mode }),
  };
}

/** 单条断言的证据判定。抽出来是为了主 transcript 与子 agent 用同一套逻辑。 */
function verdictFor(claim, records, index) {
  const evidence = findEvidence(records, claim);
  if (claim.family === 'artifact-hash') {
    const h = (String(claim.quote || '').match(/\b[0-9a-f]{7,40}\b/i) || [])[0];
    evidence.detail = evidence.detail || {};
    evidence.detail.hits = h
      ? index.resultTexts.filter((r) => r.text.includes(h)).map((r) => r.index)
      : [];
  }
  return classifyEvidence({ claim, evidence, truncated: false, records });
}

/** 在 reason 末尾补一句「哪几条在子 agent 里看到了旁证」。 */
function subagentCaveat(seen) {
  if (!seen || !seen.length) return '';
  const fams = [...new Set(seen.map((s) => familyName(s.family)))];
  return '\n\n（' + fams.join('、') + ' 在子 agent 的 transcript 里找到了旁证，已放行；'
    + '下面拦的是主会话里确实没有证据的部分。）';
}

/** 族 ID → 给模型看的中文名称的**唯一出处**在 `verify-claims.mjs` 的 `familyName()`。
 *  这里曾经抄过一份本地映射表，实测后果是两份表分叉 —— 拦截文案里因此混进
 *  `vague-completion` 这种内部 ID，模型读到「没有任何 vague-completion 调用」
 *  只会困惑，那不是它能执行的指令。`familyName()` 对未知族返回一句通用人话。 */

const STATUS_LABEL = {
  NO_EVIDENCE: '本会话里找不到对应证据',
  STALE_ONLY: '证据在最后一次源码编辑之前，编辑之后没重跑',
  FAILED_ONLY: '只找到失败的调用',
};
/**
 * 把判定结果写成**下一轮的具体指令**。
 *
 * 这是整个 hook 里最容易被做坏的一处。写成「证据不足」等于给模型一句它无法执行的
 * 废话，它下一轮会重复同一句话，然后被第二次拦。所以每条 reason 必须包含：
 *   ① 它自己说的原话（让模型认出这是它刚写的）；
 *   ② 缺的是什么（时间线，不是分类名）；
 *   ③ 具体跑什么命令（从项目配置读，不是硬编码 npm test）；
 *   ④ 第几次拦截（到阈值后明说「再拦几次宿主会强制放行」）。
 */
export function buildReason({ blocking = [], project = null, blockCount = 0, mode = 'off' } = {}) {
  const lines = [];
  const n = blockCount + 1;

  if (n >= ESCALATE_AT) {
    lines.push('【第 ' + n + ' 次拦截】宿主在连续多次拦截后会强制放行本轮。'
      + '如果你确实无法拿到证据（例如测试环境不可用），请在回复里**明说你没跑**，不要继续声称完成。');
  } else {
    lines.push('【第 ' + n + ' 次拦截】你准备结束，但下面这些完成性断言缺少证据。');
  }
  lines.push('');

  for (const b of blocking) {
    const quote = String((b.claim && b.claim.quote) || '').trim();
    const fam = (b.claim && b.claim.family) || '';
    const status = b.verdict && b.verdict.status;
    lines.push('· 你写的是：「' + quote + '」');
    lines.push('  ' + familyName(fam) + ' —— ' + (STATUS_LABEL[status] || status)
      + '（' + String((b.verdict && b.verdict.reason) || '').replace(/\n/g, ' ') + '）');
  }
  lines.push('');

  // 测试类断言才提"跑什么命令"；别的族各给各的办法。给错命令比不给更糟。
  const fams = new Set(blocking.map((b) => b.claim && b.claim.family));
  const wantsTest = fams.has('test-count') || fams.has('build') || fams.has('pr-ci');
  if (wantsTest) {
    lines.push(commandHint(project) + '。');
  }
  if (fams.has('commit')) lines.push('提交类断言：运行 `git log -1 --oneline` 贴出真实的 commit 行。');
  if (fams.has('push-remote')) lines.push('推送类断言：运行 `git status -sb` 确认没有 ahead 的提交。');
  if (fams.has('runtime-probe')) lines.push('运行类断言：重新探活一次（curl / netstat / Get-Process）并贴出输出。');
  if (fams.has('file-count')) lines.push('文件数量断言：运行 `git status --short` 数一下实际改了几个文件。');
  if (fams.has('artifact-hash')) lines.push('hash 断言：贴出 `sha256sum <文件>` 或 `git rev-parse HEAD` 的实际输出。');
  if (fams.has('vague-completion')) {
    lines.push('「做完了」这类话没有任何具体指标可比对 —— 请跑一次任何形式的检查'
      + '（测试 / 构建 / lint / 语法检查都算）并把最后几行贴出来，或者把这句话改成'
      + '「改了但没验证」。只读地看一眼文件（cat / grep / git diff）不算验证。');
    // 这一族的模型经常紧跟着说「我没有 shell，跑不了」。那不是证据，但它是一条
    // 可以被接受**并且必须被承认**的出路 —— 说清楚，免得它下一轮又编一次。
    lines.push('如果本会话确实没有执行能力，就**直接说「改了，未验证」**，'
      + '不要一边说「修好了」一边在正文里补一句跑不了 —— 那样两句话互相拆台，'
      + '而开头那句才是用户会信的那句。');
  }

  lines.push('');
  lines.push('拿到证据就贴出来再结束；如果拿不到，请把上面那句话改成如实的描述（例如「未运行测试」）。');

  // 宿主上限是 10,000 字符，留足余量。超了会被截断，截断的指令比没有更糟。
  const out = lines.join('\n');
  return out.length > 4000 ? out.slice(0, 3980) + '\n…（已截断）' : out;
}

/** 观测记录的**兜底根**：宿主机状态目录。
 *
 *  ## 为什么不再落到 `REPO_ROOT/tasks/runs/`（2026-11-21 修）
 *
 *  修前三处台账（观测日志 / 拦截计数 / 放行样本）的默认路径都是
 *  `join(REPO_ROOT, 'tasks', 'runs', ...)` —— 锚在**脚本位置**。而本 hook 被挂进的是
 *  **用户的项目**（模板里 `CLAUDE_PROJECT_DIR` 是当前项目），于是它每跑一次就往
 *  **框架仓库**里写一行日志。在别人机器上那是「框架目录被写脏」；在本机那是
 *  「用户项目的观测数据全进了另一个仓库」。
 *
 *  hook 的观测记录是**机器状态**，不是项目内容 —— 它描述的是「这台机器上的闸门跑过什么」，
 *  换一个项目也该是同一条历史。所以它该住在 `state-dir.mjs` 管的宿主机状态目录里
 *  （`%LOCALAPPDATA%/UntilDone/`），与 `asked-history.json`、守护进程的见证文件同一处。
 *  那里已经带着改名迁移规则（`Overwatch` → `UntilDone`），复用它就不会有第三份目录名。
 *
 *  **本函数只是 `resolveStateDir` 的别名**，不是第二份判据 —— 存在的原因是
 *  `pre-write-gate.mjs` 也要用同一个根，而「谁来提供这个根」必须只有一个答案。
 *  别名比复制一份 `join(env.X || ...)` 好：复制的那份一定会在下一次改名时漏掉。
 *  `OVERWATCH_STATE_DIR` 的优先级由 `resolveStateDir` 自己处理（它认这个变量），
 *  所以这里不再重判一次。 */
export function ledgerRoot(env = process.env) {
  return resolveStateDir(env);
}

/** 观测记录路径。默认 `<状态目录>/stop-hook/YYYY-MM-DD.jsonl`。
 *
 *  中间两层（`OVERWATCH_STOP_VERIFY_LOG` / `OVERWATCH_STATE_DIR`）的理由是 `DF-031`：
 *  此前只有 `pre-write-gate` 认 `OVERWATCH_STATE_DIR`，本文件不认 —— 于是任何沿用
 *  「设 `OVERWATCH_STATE_DIR` 隔离」这个既有约定的测试/探针，在这个 hook 上都会
 *  **静默失效并写进生产台账**。同一个仓库里两个 hook 对同一个环境变量给出不同答案，
 *  比两个都不认更糟：它让「我已经隔离了」这句话变成有时真、有时假。 */
export function logPathFor(env = process.env, nowMs = Date.now()) {
  if (env.OVERWATCH_STOP_VERIFY_LOG) return env.OVERWATCH_STOP_VERIFY_LOG;
  const d = new Date(nowMs);
  const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return join(ledgerRoot(env), 'stop-hook', day + '.jsonl');
}

/** 追加一行观测记录。**永不抛** —— 记账失败不能影响判定。 */
export function appendLog(record, env = process.env, nowMs = Date.now()) {
  try {
    const p = logPathFor(env, nowMs);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(record) + '\n');
    return p;
  } catch {
    return null;
  }
}

/**
 * 拦截计数。同一 session 的连续拦截次数决定 reason 的语气，也是判断
 * 「是不是卡死在循环里」的依据。
 *
 * 存法：`tasks/runs/stop-hook/state.json` 里按 sessionId 记 `{ count, lastAt, total }`。
 *
 * **两个数，用途完全不同：**
 *   · `count`  连续拦截数，超过 `RESET_AFTER_MS`（10 分钟）没有新拦截就归零。
 *              只用于 **reason 的语气**（「第 5 次拦截」在用户泡了杯咖啡回来之后
 *              还这么说很奇怪）。
 *   · `total`  **会话累计**拦截数，永不因时间归零，只有 `resetBlockCount` 能清。
 *              用于 **预算**。
 *
 * **为什么要拆成两个（2026-11-16 修正）**：原实现只有一个 `count`，既当语气又当预算，
 * 于是上限的实际语义是「**每 10 分钟 6 次**」而不是「每会话 6 次」：
 *
 *   拦 6 次 → prevCount >= MAX_BLOCKS 放行（不 bump 也不 reset，count 停在 6）
 *          → 模型安静 10 分钟
 *          → readBlockCount 读到 0
 *          → 又拿到 6 次
 *
 * 且 `resetBlockCount` 在**任何一次放行**时都被调用，所以「拦一次、模型正常结束、
 * 下一个回合再拦」也会把预算清零。6 天能拦出 5,184 次。
 * 那个六天烧掉 $15,066.79 的真实事故不需要破解宿主的上限 —— 我们的上限同样挡不住。
 *
 * 一个会到期的闸门不是闸门。`total` 是不再到期的那一半。
 *
 * 注意：这里**不**读 transcript、不读宿主内部状态，只用我们自己写的文件。
 * 代价是进程崩溃会丢计数；那只是语气降级，不是安全问题，值得。
 */
export const RESET_AFTER_MS = 10 * 60 * 1000;

export function statePathFor(env = process.env) {
  if (env.OVERWATCH_STOP_VERIFY_STATE) return env.OVERWATCH_STOP_VERIFY_STATE;
  const stateDir = String(env.OVERWATCH_STATE_DIR || '').trim();
  if (stateDir) return join(stateDir, 'stop-hook', 'state.json');
  return join(ledgerRoot(env), 'stop-hook', 'state.json');
}

export function bumpBlockCount(sessionId, { env = process.env, nowMs = Date.now() } = {}) {
  try {
    const p = statePathFor(env);
    let state = {};
    try { state = JSON.parse(readFileSync(p, 'utf8')); } catch { state = {}; }
    const cur = state[sessionId];
    // `count` 按时间窗归零（语气用）；`total` 只增不减（预算用）。
    const count = cur && nowMs - Number(cur.lastAt || 0) < RESET_AFTER_MS ? Number(cur.count || 0) : 0;
    const total = Number(cur && cur.total || 0);
    state[sessionId] = { count: count + 1, lastAt: nowMs, total: total + 1 };
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(state));
    return count;
  } catch {
    return 0;
  }
}

/** 清**连续**计数（语气用）。**保留 `total`** —— 预算不因「这次放行了」而清零。
 *
 *  原实现是 `delete state[sessionId]`，把整个条目连同累计一起删掉，于是
 *  「拦一次 → 模型正常结束 → 下一回合再拦」每一次都从 0 重新计预算。
 *  这是预算实际变成「每 10 分钟 6 次」的第二条路径（第一条是 `count` 按时间归零）。
 *
 *  现在只把 `count` 归零并保留 `total`；条目本身留着，`lastAt` 也留着（语气判断要用）。 */
export function resetBlockCount(sessionId, { env = process.env } = {}) {
  try {
    const p = statePathFor(env);
    if (!existsSync(p)) return;
    let state = {};
    try { state = JSON.parse(readFileSync(p, 'utf8')); } catch { return; }
    const cur = state[sessionId];
    if (!cur) return;
    state[sessionId] = { count: 0, lastAt: Number(cur.lastAt || 0), total: Number(cur.total || 0) };
    writeFileSync(p, JSON.stringify(state));
  } catch { /* ignore */ }
}

/** 读 transcript 的有界回溯。读不到就返回空 —— 上层按「没有可核对断言」放行。 */
export function loadRecords(transcriptPath, { backtrackMB = DEFAULT_BACKTRACK_MB } = {}) {
  if (!transcriptPath) return { records: [], truncated: false, bytesRead: 0 };
  try {
    const back = readBack(transcriptPath, { steps: [backtrackMB * 1024 * 1024] });
    return { records: back.records, truncated: Boolean(back.truncated), bytesRead: back.bytesRead };
  } catch {
    return { records: [], truncated: false, bytesRead: 0 };
  }
}

/** 读子 agent 的 transcript（有界）。没有就返回空数组。
 *
 *  只读尾部 `SUBAGENT_TAIL_BYTES`：子 agent 的证据通常就在最近一次调用附近；
 *  全读在真实语料里是 5 GB 量级，不能在一个「回合结束点」上做。 */
export const SUBAGENT_TAIL_BYTES = 2 * 1024 * 1024;

export function loadSubagentRecords(transcriptPath) {
  try {
    const subs = subagentFiles({ path: transcriptPath });
    if (!subs.length) return [];
    const out = [];
    for (const f of subs) {
      try {
        const r = readTailRecords(f, SUBAGENT_TAIL_BYTES);
        if (r.records && r.records.length) out.push(...r.records);
      } catch { /* 单个子 agent 读失败不影响其余 */ }
    }
    return out;
  } catch {
    return [];
  }
}

// ── 放行样本记录（2026-11-13）────────────────────────────────────────
//
// 背景：实验里 6 组「AI 声称做完」的会话，修好 vague-completion 后仍有 3 组
// （P4 / P5 / P6）被判 `no-checkable-claim` 直接放行。它们的共同形态是
// `已+动词` 后面接了冒号（`已全部修好：`），被 COMPLETION_RE 的 `(?=$|…)`
// 前瞻当成「后面还有话说」而放弃。
//
// 主线程的决定：**不要在 Stop hook 里继续加正则**。6 个样本（3 抓 3 漏）
// 撑不起一条新规则 —— 那是在用 6 个点拟合一个未知分布。先采集真实分布，再决定。
//
// 所以这里只做三件事：把被放行的末尾文本的前 500 字留下来、把「这一轮到底
// 有没有真的跑过检查」如实统计出来、写进一个 gitignored 的 JSONL。
// **不改判定**：记完之后照样放行。

/** 只记前 500 字。完整对话不进日志 —— 这是隐私边界，不是性能取舍。 */
export const SAMPLE_TEXT_LIMIT = 500;

/** 样本文件路径。默认 `<状态目录>/stop-hook-samples.jsonl`（**不再写进框架仓库**，
 *  理由见 `ledgerRoot()` 的注释）。可用 `OVERWATCH_STOP_VERIFY_SAMPLES` 覆盖（测试用）。 */
export function samplePathFor(env = process.env) {
  if (env.OVERWATCH_STOP_VERIFY_SAMPLES) return env.OVERWATCH_STOP_VERIFY_SAMPLES;
  return join(ledgerRoot(env), 'stop-hook-samples.jsonl');
}

/** 样本记录开关。默认**开**（只是写日志，无副作用）。
 *  `--no-sample-log` 或 `OVERWATCH_STOP_VERIFY_SAMPLES=off` 关掉。
 *
 *  为什么默认开：这一层是为了「积累真实分布」，关掉就等于什么都没发生。
 *  为什么允许关：用户可能不想让 hook 往仓库里写任何东西，而这不是安全边界，
 *  只是个便利开关。 */
export function sampleLogEnabled(env = process.env, argv = process.argv) {
  try {
    if (String(env.OVERWATCH_STOP_VERIFY_SAMPLES || '').trim().toLowerCase() === 'off') return false;
    const args = Array.isArray(argv) ? argv : [];
    if (args.includes('--no-sample-log')) return false;
    return true;
  } catch {
    return true; // 读不了命令行不该让记录静默消失；它无副作用。
  }
}

/** 一轮会话的工具调用摘要。**这是判断「该不该拦」的核心依据**，所以必须真统计，
 *  不能靠 `last_assistant_message` 里有没有「测试」两个字去猜。
 *
 *  - `hadBash`：跑过任何 shell 工具（Bash / PowerShell）。哪怕只是 `ls`。
 *  - `hadTestRun`：其中**至少一条真的跑了测试**（TEST_CMD_RE，排除 skip-tests）。
 *  - `hadVerification`：至少一条是「任何形式的检查」（测试 / 构建 / lint / 类型检查）。
 *    这比 `hadTestRun` 宽 —— 修 lint 的人不该被记成「什么都没验证」。
 *  - `toolCallCount` / `shellCallCount`：量级参照，判断是不是个「光说不做」的会话。
 *
 *  读的是**已经读进内存的 records**（runHook 传进来的尾部窗口），不额外读盘。
 */
export function toolSummaryOf(records) {
  const arr = Array.isArray(records) ? records : [];
  let toolCallCount = 0;
  let shellCallCount = 0;
  let hadBash = false;
  let hadTestRun = false;
  let hadVerification = false;
  const toolNames = new Set();

  for (const rec of arr) {
    if (!rec || rec.type !== 'assistant') continue;
    const blocks = Array.isArray(rec.message && rec.message.content) ? rec.message.content : [];
    for (const b of blocks) {
      if (!b || b.type !== 'tool_use') continue;
      toolCallCount++;
      const name = String(b.name || '');
      if (name) toolNames.add(name);
      if (!SHELL_TOOLS.has(name)) continue;
      hadBash = true;
      shellCallCount++;
      const cmd = String((b.input && (b.input.command || b.input.cmd)) || '');
      if (!cmd) continue;
      // 抛异常也算「跑过」—— 命令确实被执行了，只是失败了。样本里要如实记。
      try {
        if (isTestCommand(cmd)) hadTestRun = true;
        if (isVerificationCommand(cmd)) hadVerification = true;
      } catch { /* 命令归一化炸了不该毁掉统计 */ }
    }
  }

  return {
    hadBash,
    hadTestRun,
    hadVerification,
    toolCallCount,
    shellCallCount,
    toolNames: [...toolNames].slice(0, 20),
  };
}

/** shell 工具名。与 `verify-claims.mjs` 的 `SHELL_TOOLS` 保持一致。
 *  这里复制一份而不是 import，是因为样本层不该因为上游改了常量就跟着变 ——
 *  它要记的是「当时 hook 认为哪些是 shell」，而那正是它实际用的这份。 */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** 当时文本里**本该被认出、但没被认出**的疑似完成语义。
 *
 *  这是给分析用的旁证，不是判定：拿整张 CLAIM_FAMILIES 表逐条跑一遍原文，
 *  看有没有「族命中但被更强的否决条件筛掉」的情形。样本里 `detectedFamilies`
 *  为空而这里非空，就是最值得人工看的那些条。
 *
 *  为什么不直接复用 `detectClaims`：它返回的是**最终**结论（含否定 / 假设 / veto
 *  过滤）。这里要的是「原始正则层面的命中」，两者是不同的东西，混用会把
 *  「被正确否决」误记成「漏检」。
 */
export function rawFamilyHits(text) {
  const t = String(text || '');
  if (!t) return [];
  const hits = [];
  for (const fam of CLAIM_FAMILIES) {
    try {
      if (fam.re.test(t)) hits.push(fam.id);
    } catch { /* 单条正则炸了不影响其余 */ }
  }
  return hits;
}

/** 造一条样本记录。纯函数 —— 不写盘，测试可以直接断言它。
 *
 *  字段为什么是这些（对应后续要回答的三个问题）：
 *    · 有多少被放行的文本其实该拦 → `hadTestRun` / `hadVerification` / `hadBash`
 *    · 有几种形态 → `lastMessage`（供迭代聚类）+ `rawFamilyHits`
 *    · 有没有共同特征 → `detectedFamilies`（识别到的）与 `rawFamilyHits`（原始命中）
 *      vs `hadTestRun`（做没做）的交叉表
 *
 *  `turnCount` 需要 transcript 的**真实**轮数；这里只能给出尾部窗口内的 assistant
 *  条数，字段名因此叫 `assistantTurnCount` 而不是笼统的 `turnCount` —— 把窗口计数
 *  叫成总轮数就是让分析者拿着错的数算比例。
 */
export function buildSample({ nowMs = Date.now(), sessionId = 'unknown', text = '', decision = {}, records = [], truncated = false } = {}) {
  const body = String(text || '');
  const summary = toolSummaryOf(records);
  const assistantTurnCount = (Array.isArray(records) ? records : [])
    .filter((r) => r && r.type === 'assistant').length;
  return {
    ts: new Date(nowMs).toISOString(),
    sessionId: String(sessionId || 'unknown'),
    reason: 'no-checkable-claim',
    lastMessage: body.slice(0, SAMPLE_TEXT_LIMIT),
    lastMessageLength: body.length,
    truncated: body.length > SAMPLE_TEXT_LIMIT,
    hadBash: summary.hadBash,
    hadTestRun: summary.hadTestRun,
    hadVerification: summary.hadVerification,
    toolCallCount: summary.toolCallCount,
    shellCallCount: summary.shellCallCount,
    toolNames: summary.toolNames,
    assistantTurnCount,
    // 判定侧看到的东西。为空 = 这一族整个没认出来，正是要收集的那一类。
    detectedFamilies: Array.isArray(decision.claimFamilies) ? decision.claimFamilies : [],
    checkableCount: Number(decision.checkableCount || 0),
    // 原始正则命中（不经过否定 / 假设 / veto 过滤）。与 detectedFamilies 的差集
    // 是「被正确否决」的候选，不是漏检 —— 分析命令会把两者分开统计。
    rawFamilyHits: rawFamilyHits(body),
    transcriptTruncated: Boolean(truncated),
    sampleVersion: 1,
  };
}

/** 追加一条样本。**永不抛** —— 记账失败不能影响判定。返回写入路径或 null。 */
export function appendSample(record, env = process.env) {
  try {
    const p = samplePathFor(env);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(record) + '\n');
    return p;
  } catch {
    return null;
  }
}

/** Stop 的去重键（`DF-029`）。
 *
 *  **Stop 的输入里没有「第几次调用」这类字段** —— 宿主 schema 实测（2.1.308 二进制里的
 *  `hook_event_name:"Stop"` 分支）只有 `stop_hook_active` / `last_assistant_message` /
 *  `background_tasks` / `session_crons`，外加公共的 `session_id` / `prompt_id` /
 *  `transcript_path` / `cwd`。没有 `tool_use_id` 那种天然唯一 id。
 *
 *  所以只能退而求其次，用「同一次 Stop 被触发两次时必然逐字相同」的那几项拼：
 *    · `session_id`      会话身份
 *    · `prompt_id`       本回合（宿主文档：同一个 prompt 下的后续事件共用它）
 *    · `stop_hook_active` 第 2 轮起翻成 true —— 它同时也是「这次 Stop 是某次 hook
 *                        拦下来的」的标记，所以「拦一次 → 模型补证据 → 再 Stop」
 *                        两次的键**必然不同**，不会被误去重
 *    · `last_assistant_message` 的哈希 同一回合里两次触发逐字相同；而模型改过回复
 *                        之后再结束，哈希就变了
 *
 *  **已知边界，如实写在这里**：`last_assistant_message` 为空（纯工具轮）时这一项
 *  对任何回合都相同，于是「同一 prompt 内连续两次空文本 Stop」会被当成同一次而合并。
 *  为此额外掺入 transcript 的文件大小 —— 它只在空文本时才加（有文本时**不能**加：
 *  transcript 可能在两次触发之间被 flush，键一变去重就失效，而那是最常见的情形）。
 *  代价：两个真的不同的空文本回合，恰好在同一字节数上结束，会被合并成一次 ——
 *  后果是少一行观测记录与一条放行样本，不是一个判断错。方向选得与全文件一致：
 *  宁可少记，不可错拦。 */
export function stopTurnKeyOf(input, { transcriptSize = null } = {}) {
  const i = input && typeof input === 'object' ? input : {};
  // **每一段都走 `safeString`**：`String(x)` 在 `toString` 会抛的对象上直接抛。
  // 有测试专门喂一个 `{ toString() { throw } }` 的 `last_assistant_message`，
  // 第一版就是在这里红的 —— 去重层的崩溃不该让判定跟着崩（本 hook 的 fail-open
  // 是有测试守的，别在去重这一层把它破掉）。
  const text = safeString(i.last_assistant_message);
  const digest = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24);
  const parts = [
    safeString(i.session_id),
    safeString(i.prompt_id),
    i.stop_hook_active ? 'active' : 'idle',
    digest,
  ];
  if (!text) parts.push(transcriptSize === null ? 'na' : String(transcriptSize));
  return claimKeyOf('stop-verify-hook', parts);
}

/** transcript 大小。拿不到返回 null（这只会让空文本那条键更粗，不影响判定）。 */
function transcriptSizeOf(p) {
  try { return statSync(String(p || '')).size; } catch { return null; }
}

/** 主流程。返回宿主该看到的东西：`{ decision, reason }` 或 null（放行）。
 *
 *  **这个函数自己就是 fail-open 的**：内部的 try/catch 包住整段判定。理由是不能
 *  依赖调用方记得包。`main()` 里也有一层，两层冗余是有意的 —— 这里多一层，测试
 *  就能直接驱动 `runHook` 而不必跑整个进程。 */
export function runHook({ input, env = process.env, nowMs = Date.now(), sampleLog } = {}) {
  const i = input || {};
  let mode;
  try {
    mode = modeOf(env);
  } catch {
    return null; // 连环境变量都读不了：放行。
  }
  const sessionId = (() => {
    try { return String(i.session_id || 'unknown'); } catch { return 'unknown'; }
  })();

  // ── 同一个回合结束点只判一次（`DF-029`）──────────────────────────────
  //
  // 两条注册叠加时，宿主为**同一次** Stop 起两个本进程，两者的 stdin 逐字相同。
  // 判定与记账之前先认领（`hook-dedupe.mjs` 用 `O_EXCL` 原子创建，不是先读后写）。
  //
  // **位置必须在任何写盘之前**，`bumpBlockCount` 是最要命的一处：实测同一回合被调
  // 两次时 `state.json` 里的 `count`/`total` 各跳 2，于是 6 次预算只够 3 个回合。
  // 放在判定之前还顺带省掉重复进程那次 transcript 读（实测 330ms/次）。
  //
  // 认领失败一律照常判定（`claimOnce` 永不抛，拿不到键就返回 `claimed:true`）；
  // 失效方向永远是「多记一次」，不是「漏判一次」。
  //
  // 「认领成功之后、输出之前崩了」这个窗口的后果是：这一次 Stop 没有任何输出 ——
  // 那**就是**本 hook 的 fail-open 结果（`main()` 的 catch 与超时分支都是 exit 0
  // 无输出），所以没有引入新的失败形态。
  const dedupeKey = stopTurnKeyOf(i, {
    nowMs,
    transcriptSize: transcriptSizeOf(safeString(i.transcript_path)),
  });
  const claim = claimOnce({ hookId: 'stop-verify-hook', key: dedupeKey, env, nowMs });
  if (!claim.claimed) {
    recordSkipped({ hookId: 'stop-verify-hook', key: dedupeKey, env, nowMs, why: claim.why });
    // **不写台账、不动 state.json、不写样本**：那三处都是「一次事件一行 / 一跳」，
    // 重复触发写进去就是本次要修的那个缺陷。跳过记录单独一个文件，
    // 它证明机制在跑，但不参与任何比例统计。
    return null;
  }

  let loaded;
  let project;
  let d;
  try {
    loaded = loadRecords(safeString(i.transcript_path));
    project = detectProjectCommands(safeString(i.cwd) || process.cwd());

    // 计数在读之前算，好让 buildReason 拿到的是「之前拦过几次」。
    // 两个数，用途不同（见 `RESET_AFTER_MS` 上方）：
    //   prevCount → reason 的语气（会随安静时间归零）
    //   prevTotal → 预算（会话累计，不归零）
    const prevCount = mode === 'block' ? readBlockCount(sessionId, { env, nowMs }) : 0;
    const prevTotal = mode === 'block' ? readTotalBlocks(sessionId, { env }) : 0;

    // ── 用户叫停：L1 / L2 都在判定之前。 ──
    //
    // **位置是有意的**：这两层一旦生效，本函数**任何分支**都不许再拦。放在 `decide()`
    // 之前，也就不可能被某个 claim 的判定绕过。
    //
    // L1（闸门文件）在最前，因为它是唯一与上下文无关的一层 —— 用户不需要理解
    // 这个 hook 判什么，只要让文件存在就能关门。
    if (mode === 'block' && isPaused(env)) {
      // **记「命中的是哪一条」，不记主路径。** 两个候选都检查之后，
      // 「用户想停」与「用户把文件放错了地方」在布尔层面长得完全一样 ——
      // 而后者正是 `DF-041` 这次要修的那种事故。`pausePath` 保留（旧字段，勿破坏台账消费方），
      // 新增 `pausePaths`（正在检查的全集）与 `pauseHit`（真命中的那一条），
      // 于是「我放的是 UntilDone，为什么日志说 Overwatch」不用猜。
      appendLog({
        at: new Date(nowMs).toISOString(), sessionId, mode,
        hookEventName: safeString(i.hook_event_name) || null,
        stopHookActive: Boolean(i.stop_hook_active),
        outcome: 'allowed-user-paused',
        pausePath: pausePathFor(env),
        pauseHit: pausedPathOf(env),
        pausePaths: pausePathsFor(env).length,
      }, env, nowMs);
      return null;
    }
    // L2（用户已发话）：只在 block 模式下才有意义 —— off 模式本来就不拦。
    if (mode === 'block') {
      const intervened = userIntervenedSince(sessionId, { records: loaded.records, env, nowMs });
      if (intervened) {
        appendLog({
          at: new Date(nowMs).toISOString(), sessionId, mode,
          hookEventName: safeString(i.hook_event_name) || null,
          stopHookActive: Boolean(i.stop_hook_active),
          outcome: 'allowed-user-intervened',
          ...intervened,
        }, env, nowMs);
        return null;
      }
    }

    // 先只看主 transcript。只有它说要拦时，才花钱读子 agent —— 见 decide 的注释。
    const firstPass = decide({
      input: i, records: loaded.records, cwd: i.cwd, project, blockCount: prevCount, mode,
    });
    let subagentRecords = null;
    d = firstPass;
    if (firstPass.action === 'block') {
      subagentRecords = loadSubagentRecords(safeString(i.transcript_path));
      if (subagentRecords.length) {
        d = decide({
          input: i, records: loaded.records, cwd: i.cwd, project,
          blockCount: prevCount, mode, subagentRecords,
        });
      }
    }

    const record = {
      at: new Date(nowMs).toISOString(),
      sessionId,
      mode,
      hookEventName: safeString(i.hook_event_name) || null,
      stopHookActive: Boolean(i.stop_hook_active),
      permissionMode: safeString(i.permission_mode) || null,
      cwd: safeString(i.cwd) || null,
      project: { kind: project.kind, test: project.test, source: project.source },
      transcriptBytesRead: loaded.bytesRead,
      transcriptTruncated: loaded.truncated,
      checkableCount: d.checkableCount,
      claimFamilies: d.claimFamilies,
      subagentRecords: subagentRecords ? subagentRecords.length : 0,
      seenInSubagents: (d.seenInSubagents || []).map((s) => s.family),
      action: d.action,
      allowReason: d.allowReason || null,
      blockCount: prevCount,
      // 会话累计，与 `blockCount`（连续）分开记。事后想知道「这个会话一共被拦过几次」
      // 只能看这个数 —— `blockCount` 会因安静 10 分钟而归零。
      totalBlocks: prevTotal,
      blocking: (d.blocking || []).map((b) => ({
        family: b.claim.family,
        quote: b.claim.quote,
        status: b.verdict.status,
        why: b.verdict.reason,
      })),
      reason: d.action === 'block' ? d.reason : '',
      // 本行记录的是**本次判定**：该拦 / 不拦，以及实际做了什么。
      // `allowed-budget-exhausted` 是 2026-11-16 新增：预算耗尽与「证据齐全」在界面上
      // 必须能分开，否则「闸门用完配额」和「全部验证通过」显示成同一件事。
      outcome: d.action === 'block'
        ? (mode === 'block' ? (prevTotal >= MAX_BLOCKS ? 'allowed-budget-exhausted' : 'blocked') : 'observed-only')
        : 'allowed',
    };
    appendLog(record, env, nowMs);

    if (d.action !== 'block') {
      // 放行样本：只在「根本没认出可核对断言」时记 —— 那正是本期唯一在扩的缺口。
      // 记完照样放行，**不参与判定**。这一步的任何失败都必须被吞掉（appendSample 自己
      // 就是 never-throw），否则一次写盘失败会变成一次用户会话结束不了。
      if (d.allowReason === 'no-checkable-claim'
        && (sampleLog === undefined ? sampleLogEnabled(env) : Boolean(sampleLog))) {
        try {
          appendSample(buildSample({
            nowMs,
            sessionId,
            text: d.assistantText || '',
            decision: d,
            records: loaded.records,
            truncated: loaded.truncated,
          }), env);
        } catch { /* 样本层的任何问题都不影响放行 */ }
      }
      if (mode === 'block') resetBlockCount(sessionId, { env });
      return null;
    }
    if (mode !== 'block') return null; // 观测模式：只记账，不拦。

    // 我们自己的上限：到顶就放行。不依赖宿主的 CLAUDE_CODE_STOP_HOOK_BLOCK_CAP。
    // **用 prevTotal（会话累计）而不是 prevCount（连续）** —— 一个会到期的闸门不是闸门。
    if (prevTotal >= MAX_BLOCKS) return null;

    bumpBlockCount(sessionId, { env, nowMs });
    return { decision: 'block', reason: d.reason };
  } catch (e) {
    // 判定自己炸了：记账后放行。绝不因为我们的 bug 让用户无法结束会话。
    appendLog({
      at: new Date(nowMs).toISOString(),
      sessionId,
      mode: mode || 'off',
      action: 'allow',
      allowReason: 'hook-internal-error',
      error: String((e && e.message) || e),
      outcome: 'allowed',
    }, env, nowMs);
    return null;
  }
}

/** `String(x)` 的安全版：`toString` 会抛的对象也返回空串，不把判定拖下水。 */
function safeString(v) {
  try { return v == null ? '' : String(v); } catch { return ''; }
}

/** 读当前连续拦截次数（不递增）。只用于 reason 的语气。 */
export function readBlockCount(sessionId, { env = process.env, nowMs = Date.now() } = {}) {
  try {
    const p = statePathFor(env);
    if (!existsSync(p)) return 0;
    const state = JSON.parse(readFileSync(p, 'utf8'));
    const cur = state && state[sessionId];
    if (!cur) return 0;
    if (nowMs - Number(cur.lastAt || 0) >= RESET_AFTER_MS) return 0;
    return Number(cur.count || 0);
  } catch {
    return 0;
  }
}

/** 读**会话累计**拦截次数（不递增、**不**按时间归零）。这是预算的唯一依据。
 *
 *  与 `readBlockCount` 分开的理由见 `RESET_AFTER_MS` 上方那段：一个数不能既当语气
 *  又当预算 —— 语气该随安静时间归零，预算不该。
 *  老状态文件没有 `total` 字段时返回 0（迁移：已有会话从此刻开始计预算，不追溯）。 */
export function readTotalBlocks(sessionId, { env = process.env } = {}) {
  try {
    const p = statePathFor(env);
    if (!existsSync(p)) return 0;
    const state = JSON.parse(readFileSync(p, 'utf8'));
    const cur = state && state[sessionId];
    if (!cur) return 0;
    return Number(cur.total || 0);
  } catch {
    return 0;
  }
}

/** CLI 入口。任何异常都吞掉并 exit 0 —— fail-open。 */
async function main() {
  const budget = Number(process.env.OVERWATCH_STOP_VERIFY_BUDGET_MS || DEFAULT_BUDGET_MS);

  // 自设预算兜底：宿主对 hook 也有超时，但我们不能赌它的默认值。
  // 超时后仍然 exit 0（放行），并记一条 budget-exceeded。
  let timer = null;
  const guard = new Promise((res) => {
    timer = setTimeout(() => res('__TIMEOUT__'), budget);
    if (timer.unref) timer.unref();
  });

  let raw;
  try {
    raw = await Promise.race([readStdin(process.stdin), guard]);
  } catch {
    raw = '';
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (raw === '__TIMEOUT__') {
    appendLog({ at: new Date().toISOString(), action: 'allow', allowReason: 'hook-budget-exceeded', budgetMs: budget, outcome: 'allowed' });
    return; // 放行
  }

  const input = parseHookInput(raw);
  if (!input) {
    appendLog({ at: new Date().toISOString(), action: 'allow', allowReason: 'unparsable-input', bytes: String(raw || '').length, outcome: 'allowed' });
    return; // 放行
  }

  let out;
  try {
    out = runHook({ input });
  } catch (e) {
    // 判定自己炸了：记账后放行。绝不因为我们的 bug 让用户无法结束会话。
    appendLog({ at: new Date().toISOString(), sessionId: input.session_id || 'unknown', action: 'allow', allowReason: 'hook-internal-error', error: String((e && e.message) || e), outcome: 'allowed' });
    return;
  }

  if (out && out.decision === 'block') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: out.reason }));
  }
}

/** 「我是不是被直接执行」——比的是**真实路径**。`resolve()` 只规范化路径、不解析符号
 *  链接，而 `fileURLToPath(import.meta.url)` 已经是真实路径；通过目录符号链接执行
 *  （`npm link` / `npm i -g .` / pnpm 的 store）时两边必然不等，程序会静默 exit 0、零输出。
 *  realpath 失败（路径不存在）退回 resolve：一次失败不能让正常执行也坏掉。 */
const realOrResolve = (p) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};
if (process.argv[1] && realOrResolve(process.argv[1]) === realOrResolve(fileURLToPath(import.meta.url))) {
  main().then(() => process.exit(0)).catch(() => process.exit(0));
}
