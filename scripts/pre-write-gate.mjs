#!/usr/bin/env node
/**
 * pre-write-gate.mjs — PreToolUse 写前闸：**第一次写文件之前，先证明你读过这个项目**。
 *
 * 宿主在每次工具调用**之前**同步调用本脚本，把 `{session_id, transcript_path, cwd,
 * prompt_id, permission_mode, effort, hook_event_name, tool_name, tool_input, tool_use_id}`
 * 以 JSON 从 stdin 喂进来。脚本若判「这是本次会话的第一次写、且没有任何读过项目的证据」，
 * 就返回 `permissionDecision:"deny"`，reason 里放一条**可执行**的指令链，喂回给模型。
 *
 * 契约与实测依据：`docs/research/2026-11-14-pretooluse-desktop-verification.md`（20 组，
 * 真 `claude.exe 2.1.308`）。原型与实测：`docs/research/2026-11-14-pre-write-gate-prototype.md`。
 *
 * ── 三条实测硬约束，逐条怎么防 ─────────────────────────────────────
 *
 * ① **`exit 2` 不拦截**（D3：hook 触发 1 次、文件照样落盘；B4 的「拦住了」是 Git Bash
 *    缺失的 fallback 假象）。本脚本**只有一种拦截表达**：标准输出上的
 *    `hookSpecificOutput.permissionDecision:"deny"`。任何 `process.exitCode=2` 的写法都不存在
 *    —— 本文件所有退出路径都是 `exit 0`，包括崩溃路径（崩溃 = 放行，见 §fail-open）。
 *
 * ② **拒绝循环宿主无上限**（G3：连拒 69 次仍在跑）。所以每次 deny 都带刹车：
 *    默认 `brake="halt"` → deny 同时给顶层 `continue:false`，一轮即停（G4 实测）。
 *    代价是**终止整个回合**，也就放弃了「让模型被拒后先去读文件」。
 *    要后者就换 `brake="budget"`：前 N 次 deny 不给 `continue:false`（模型可以继续读），
 *    N 次之后照样刹车。计数器**只用来刹车，不用来判定** —— 判定永远查磁盘状态，
 *    所以「重试绕过」这条路不通（E1 证明计数器判定可以被一次重试直接绕过）。
 *
 * ③ **只 matcher `Write|Edit` 会被 shell 绕过**（G6：`PowerShell` 的 `Set-Content`
 *    照常落盘）。所以本脚本自己解析两类 shell 工具：
 *      · `Bash` → 复用 `claim-ledger.mjs` 的 `bashWriteScan`（重定向 / heredoc / tee / cp / mv）
 *      · `PowerShell` → 本文件的 `powershellWriteScan`（Set-Content / Out-File / 重定向 / …）
 *    模板 `templates/pre-write-gate.settings.json` 里的 matcher 覆盖五个工具名。
 *    解析不出来的（`sh -c`、`xargs`、`Invoke-Expression`）**计数但放行**，见 §诚实边界。
 *
 * ── 状态：查磁盘，不数次数 ────────────────────────────────────────
 *
 * 标记文件 `<cwd>/.claude/.ow-read-done`，内容是 JSON：
 *   `{version, session_id, at, satisfied_by, reads, prompt_id, [verified_at, reads_sample, sig]}`
 *
 * 谁创建它——**两条路都开，主路是 (b)**：
 *
 *   (b) **`satisfied_by:"auto"`（默认走这条）**：hook 读 transcript 尾部，数本会话已经
 *       `Read` 过几个不同的文件；够了就**自己**写标记并放行。不依赖 AI 听话，也不依赖
 *       它知道本闸存在——一个本来就会先读项目的 agent 根本感觉不到闸门。
 *   (a) **`satisfied_by:"claim"`（逃生口）**：AI 被拒后按 reason 跑
 *       `node <repo>/scripts/pre-write-gate.mjs mark`。它**没有**读过任何东西，这是自述。
 *
 * 为什么两条都留：只看 (a) 是荣誉制（AI 不读也能举手）；只看 (b) 则有硬边界——读发生在
 * 本会话之外（`/resume` 前的旧会话、子 agent、读屏工具），transcript 里就查不到，闸门会
 * 永远拦一个其实读过项目的会话。所以 (b) 是判定主路，(a) 是记账透明的逃生口：
 * 标记里 `satisfied_by` 把「验出来的」和「自己说的」分开，事后可审计。
 * `decide()` 只会返回 `markWrite`，真正写盘在 `runHook()`——纯函数不碰盘，才测得了。
 *
 * ── 两条判据（2026-11-14 按首写工具拆开）────────────────────────────
 *
 *   · `Edit` / `MultiEdit` / `NotebookEdit`（改**已有**文件）：判「**读过这个文件本身**」。
 *     实测（`resolution-gate-audit.mjs` R8）：真实项目里 18/18 个 Edit-first 会话都在改之前
 *     读过目标文件，而「读过 ≥3 个不同文件」这条仍误拦其中 4 个。反例：被拦的 4 个
 *     **全都**读过自己的目标文件 —— 误伤是纯损失。
 *   · `Write` 与 shell 写入（`Bash` / `PowerShell`）：**行为不变**，仍数「读过 ≥minReads 个
 *     不同文件」。理由是定义性的：新建文件没有「目标文件」可读，实测被拦的 27 个里 23 个
 *     是 `Write`。拿 Edit 的判据去管它，等于把闸门整个拆掉。
 *
 * 目标锚定放行**不写标记**：它只证明「这一个文件读过」，不证明「读过这个项目」。
 * 所以后续的 `Write` 仍按阈值判 —— 这条比原来的行为更严，不是更松。
 *
 * ── 签名：`satisfied_by:"auto"` 必须带 HMAC ────────────────────────
 *
 * `auto` 的含义是「闸门自己从 transcript 里验出来的」，那它就**不能**是任何进程写一句话
 * 就能冒充的。做法：`writeMarker()` 写 `auto` 时，用
 * `.claude/.ow-gate-secret`（首次运行生成，32 字节 hex）对
 * `session_id + at + reads + verified_at + reads_sample` 做 HMAC-SHA256，写进 `sig`；
 * `markerValidity()` 重算比对（`timingSafeEqual`）。`claim` 不需要签名 —— 它本来就是自述，
 * 签了反而会让人误以为它是验出来的。
 *
 * 边界（写死在代码里，不是猜的）：
 *   · **secret 文件被删** → 下次运行重新生成 → 旧 `auto` 标记的签名验不过 → **失效**（不是放行），
 *     闸门退回「查 transcript」那条路重新判一次。
 *   · **secret 读不到 / 建不出来**（目录只读）→ `auto` 标记一律判 `auto-no-secret` 无效。
 *     这不会变成「永远拦」：同一个目录里标记文件也写不进去，那种情况下闸门本来就没有主路，
 *     只剩 `claim` 逃生口（与引入签名之前完全一致）。**没有做 fail-open 降级** ——
 *     「没有密钥」永远不等于「谁写的都算」。
 *   · 密钥文件本身不许被写：命中 `.claude/.ow-gate-secret` 的写单独判 `secret-tamper`，
 *     不跟 `gate-own-file` 一起放行 —— 否则改密钥再伪造签名，等于没签。

 *
 * ── 模式（默认最保守）─────────────────────────────────────────────
 *
 *   `OW_PRE_WRITE_GATE=observe`（**默认**）  只往 `tasks/runs/pre-write-gate/<日期>.jsonl`
 *                                          记账，stdout 什么都不输出 = 放行。
 *   `OW_PRE_WRITE_GATE=warn`                 放行 + `additionalContext` 提醒（实测只注入
 *                                          一次、不引发循环），不拦。
 *   `OW_PRE_WRITE_GATE=deny`                 真的拦。
 *
 * ── fail-open ────────────────────────────────────────────────────
 *
 * 输入解析不了、transcript 读不到、我们自己的代码抛了——一律放行并记账。理由同
 * `stop-verify-hook.mjs`：闸门故障不该让用户写不了文件。
 *
 * ── 用法 ─────────────────────────────────────────────────────────
 *
 *   # hook 入口（宿主调用，stdin 进 stdout 出）
 *   node scripts/pre-write-gate.mjs
 *   # 手动举手（reason 里让模型跑的那条）
 *   node scripts/pre-write-gate.mjs mark [--session <id>] [--reads <n>] [--cwd <dir>]
 *   # 看当前状态（调试用）
 *   node scripts/pre-write-gate.mjs status [--cwd <dir>]
 */

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bashWriteScan } from './claim-ledger.mjs';
import { claimOnce, claimKeyOf, recordSkipped } from './hook-dedupe.mjs';
// 「一次提问的参数长什么样」的唯一解析处（2026-11-19 从 `question-audit.mjs` 搬出）。
// **不能直接 import `question-audit.mjs`**：它 import `observe-reality-check.mjs`，
// 后者在模块顶层求值 `GATE_SHELL_READ_VERBS` —— 环会让那一行在常量初始化前执行，
// 直接 TDZ ReferenceError。见 `question-form.mjs` 文件头。
import { questionsOfAsk, normalizeText } from './question-form.mjs';
// 叫停路径（L1 文件闸）。**复用，不新造**：见 §叫停（`pausePathFor` 的注释）。
import { pausePathFor, pausedPathOf, pausePathsFor, ledgerRoot } from './stop-verify-hook.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** 标记文件相对**会话 cwd** 的路径。跟着项目走，不跟着仓库走。 */
export const MARKER_REL = '.claude/.ow-read-done';

/** 拒绝计数（刹车用）相对 cwd 的路径。只影响 `brake="budget"`。 */
export const DENIAL_REL = '.claude/.ow-gate-denials.json';

/** 签名密钥相对 cwd 的路径。**每次会话首次生成**，只在本机、只在 `.claude/` 下。
 *  它是 `auto` 标记不可伪造的唯一依据：读得到源码不等于读得到密钥（密钥不上仓）。 */
export const SECRET_REL = '.claude/.ow-gate-secret';

/** 触发闸门的工具名。注意 shell 类要**解析命令**才知道是不是写，见 `writeIntentOf`。 */
export const WRITE_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** 改**已有**文件的工具。判据是「读过这个文件本身」，见文件头 §两条判据。
 *  `Write` 不在这里 —— 新建文件没有目标文件可读，对它用这条判据等于把闸门拆掉。 */
export const EDIT_SIDE_TOOLS = Object.freeze(['Edit', 'MultiEdit', 'NotebookEdit']);

export const SHELL_TOOLS = Object.freeze(['Bash', 'PowerShell']);

/** 三种模式。`observe` 是默认——不显式开启就绝不干预。 */
export const MODES = Object.freeze(['observe', 'warn', 'deny']);

/** 两种刹车。`halt` 是默认，因为它严格符合「拒绝必须带 continue:false」。 */
export const BRAKES = Object.freeze(['halt', 'budget']);

/** transcript 里算「读过」的工具名。`Read` 之外加 Notebook 读。 */
export const READ_TOOLS = Object.freeze(['Read', 'NotebookRead']);

/** shell 里算「读过文件」的动词。刻意窄：`grep`/`ls` 不算读过内容。
 *
 *  `readVerbs` 参数**只为让重放器能验证「动词表是判据的唯一来源」**而存在：
 *  生产调用从不传它，传了就等于改判据。`observe-reality-check.test.mjs` 用
 *  「注入 `ls`」证明重放器跟着动 —— 重放器若自己写一份动词表，那条测试会红。
 *
 *  ## 为什么 `sed` 在表里，而 `awk` 不在（`DF-027`，2026-11-18）
 *
 *  `sed` 一个动词两种语义：`sed -n '1,30p' f` 是读，`sed -i 's/x/y/' f` 是写。
 *  所以光把它加进表是不够的 —— 表只回答「这个动词像不像读」，回答不了「这一次是不是读」。
 *  带就地编辑的一律由 `shellInPlaceEdit()` 排除，**不进**这张表也解决不了问题
 *  （那样 `sed -n ...` 永远数不上）。一律记成读，就是给那些就地编辑伪造证据。
 *
 *  `awk` **不加**：它读文件没有像 `sed -i` 这样集中的开关形态 —— `awk` 改文件的常见写法是
 *  `awk ... f > g && mv g f`（在动词表之外，靠重定向识别）、GNU 的 `-i inplace`，
 *  还有脚本里 `print > "f"` 这种**藏在一对引号里的写**。要判干净得解析 awk 程序体，
 *  那已经不是「读动词表」这件事了；判不干净就记成读，是拿证据换覆盖率。
 *  同一条线上 `head`/`tail`/`cat` 也没有需要排除的写形态（`cat f > g` 确实读了 `f`，
 *  写的是 `g`，记 `f` 是对的；`tee` 本来就不在表里）。
 *
 *  ## 修正：这一段此前写过一组编造的实测数字（2026-11-18 复核）
 *
 *  原文写「实测本机 100 份 transcript：6391 条 shell 命令里 `sed` 1170 条，
 *  其中就地编辑 164 条」「本机实测 55 条 awk 命令、0 条就地编辑」。**这两个数都不成立**：
 *  本机 100 份 transcript 重新数一遍是 **6100 行 / 846 个 tool_use / 149 次 Bash 调用 /
 *  `sed` 出现 0 次**（两种数法都试过：按 JSON `tool_use.input.command` 解析，
 *  以及在原文里找 `sed `）。也就是说这组数字既不是从这台机器上算出来的，
 *  也没有任何脚本能产出它。
 *
 *  这不是笔误。本仓的纪律是「每条必须写出处」「不得伪造精确数字」，
 *  而编出来的精确数字**比没有数字更坏**：它让一个其实基于推理的决定看起来像基于测量，
 *  下一个人会照着它继续推理。所以删掉，改成如实说：**加 `sed` 的条件判据是基于
 *  「`sed -i` 会写盘」这个语义事实，不是基于本机用量统计。**
 *
 *  这也正是 `DF-031` 的同一种病：一个看起来有依据的数字，没人能复现，
 *  而它一直在影响判断。 */
const SHELL_READ_VERBS = Object.freeze(['cat', 'head', 'tail', 'type', 'get-content', 'gc', 'more', 'sed']);

/** 导出只读引用：重放器用它验证「动词表是判据的唯一来源」。
 *  它是**数据**，不是判据入口 —— 想让重放器用别的动词表，走 `readVerbs` 参数。 */
export const GATE_SHELL_READ_VERBS = SHELL_READ_VERBS;

/** 回扫上限的默认值。8 MB 是按实测定的：本机 485 份主 transcript 里 >8 MB 的有 70 份，
 *  而验收点出的 49 个「尾部 1 MB 内 0 问」的会话最大 102.9 MB —— 8 MB 覆盖不了全部，
 *  所以到上限仍不够时必须 `truncated` + 放行，而不是判 deny。
 *  8 MB 的实测耗时 213 ms（见 `readTranscriptActivity` 文件头；2026-11-19 重测）。
 *
 *  **必须声明在 `defaultConfig()` 之前**：它被那个函数引用，而 `defaultConfig()` 里
 *  引用一个 `const` 是 TDZ 风险 —— 只要有人在模块顶层先调一次就 `ReferenceError`。
 *  `question-form.mjs` 的文件头记的正是同一类事故（环导致常量初始化前被求值）。
 *  当前没有模块顶层调用，所以没炸；但「现在没炸」不是「不会炸」。 */
export const DEFAULT_MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** 默认配置。全部可用环境变量覆盖，测试靠传 `env` 对象注入。 */
export function defaultConfig() {
  return {
    mode: 'observe',
    brake: 'halt',
    /** `brake="budget"` 时，同一个 (session, prompt) 内前几次 deny 不刹车。 */
    denyBudget: 2,
    /** 算「读过项目」的最少**不同**文件数。reason 文案按这个数生成，两处不会漂。 */
    minReads: 3,
    /** 读 transcript 尾部多少字节。判定只花一次有界读，不扫全文件。 */
    transcriptBytes: 1024 * 1024,
    /** `ask.minQuestionsBeforeWrite > 0` 时，一块不够就向前回扫，最多扫到这么多字节
     *  （从文件尾算起）。8 MB 的实测耗时 213 ms，见 `readTranscriptActivity()` §有界回扫。
     *  到上限仍不够 → 放行（`truncated`），绝不拿「没读到」当「没问过」。 */
    transcriptScanBytes: DEFAULT_MAX_SCAN_BYTES,
    /** 跨会话承认标记。默认否：新会话 = 没读过这个项目的新 AI。 */
    crossSession: false,
    /** **第一次写之前必须已经问过几个问题**。`0` = 这条判据完全不启用（默认）。
     *
     *  判据来源是用户原话：「一旦开头提示词给的模糊，做出来的东西不是用户想要的
     *  就是白费力气了 …… 做成配置项，让用户可以自定义开头问几个问题，
     *  保留自由度，走错方向的风险由用户承担。」
     *
     *  默认 0 是硬要求：装上这个闸的现有用户行为必须**逐字节不变**。
     *  开启方式是 `overwatch.config.json` 的 `ask.minQuestionsBeforeWrite`，
     *  或环境变量 `OW_ASK_MIN_QUESTIONS`（临时试跑用）。见 `minQuestionsBeforeWriteOf()`。 */
    minQuestionsBeforeWrite: 0,
  };
}

/** 从 env 读配置。非法值一律回落到默认（保守方向）。 */
export function configOf(env = {}) {
  const cfg = defaultConfig();
  const mode = String(env.OW_PRE_WRITE_GATE || '').trim().toLowerCase();
  if (MODES.includes(mode)) cfg.mode = mode;

  const brake = String(env.OW_PRE_WRITE_GATE_BRAKE || '').trim().toLowerCase();
  if (BRAKES.includes(brake)) cfg.brake = brake;

  const num = (k, lo, hi) => {
    const raw = String(env[k] ?? '').trim();
    // 缺省与空串必须回落到默认，**不能**当 0。这个坑真的踩到了：
    // `Number('')` 是 0，于是只设了 `OW_PRE_WRITE_GATE=deny` 时 minReads 变成 0，
    // 「自动满足」那条主路被静默关掉，闸门退化成纯荣誉制。测试里有一条专门守这个。
    if (!raw) return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= lo && v <= hi ? Math.floor(v) : null;
  };
  const db = num('OW_PRE_WRITE_GATE_DENY_BUDGET', 0, 20);
  if (db !== null) cfg.denyBudget = db;
  const mr = num('OW_PRE_WRITE_GATE_MIN_READS', 0, 50);
  if (mr !== null) cfg.minReads = mr;
  const tb = num('OW_PRE_WRITE_GATE_TRANSCRIPT_BYTES', 4096, 64 * 1024 * 1024);
  if (tb !== null) cfg.transcriptBytes = tb;
  const tsb = num('OW_PRE_WRITE_GATE_TRANSCRIPT_SCAN_BYTES', 4096, 512 * 1024 * 1024);
  if (tsb !== null) cfg.transcriptScanBytes = tsb;

  const cs = String(env.OW_PRE_WRITE_GATE_CROSS_SESSION || '').trim().toLowerCase();
  cfg.crossSession = ['1', 'true', 'on', 'yes'].includes(cs);
  return cfg;
}

/** `OW_ASK_MIN_QUESTIONS` 的合法上界。20 与 `ask.maxQuestions` 的上界一致 ——
 *  要求「问够 $N 个问题」而 `maxQuestions` 只允许一次问 20 个，两个数不该脱节。
 *  超过这个值一律当非法（回落到配置文件的值），**不静默夹紧**：夹紧会让
 *  「我写了 999」变成「其实是 20」，而用户以为自己关掉了这条路。 */
export const MAX_MIN_QUESTIONS = 20;

/** 读 `ask.minQuestionsBeforeWrite`：**env > `overwatch.config.json` > 0**。
 *
 *  ## 为什么要有这条判据，和为什么它默认关
 *
 *  用户原话：「提前问主要服务的是长时间工作这个目的。一旦开头提示词给的模糊，
 *  做出来的东西不是用户想要的就是白费力气了 …… 做成配置项，让用户可以自定义
 *  开头问几个问题，保留自由度，走错方向的风险由用户承担。」
 *
 *  所以：**默认 0，即这条判据完全不存在**。装了这个闸的现有用户升级后
 *  行为必须逐字节不变。想开的人自己写一个 N，风险他自己承担 —— 这一点必须
 *  写在使用者读得到的地方（`docs/CAPABILITIES.md`），不能只写在代码里。
 *
 *  ## 为什么读配置文件时**不走 `question-audit.validateConfig()`**
 *
 *  那个校验器的键白名单是硬编码的 `{mode, maxQuestions, requireReadFirst, minReads}`，
 *  而它**还没有** `minQuestionsBeforeWrite`（本项先落地在闸门侧）。走它的话，
 *  用户一写这个键就会被判 `unknown-key`，`loadConfig` 返回 `config:null`，
 *  于是 `launch` 的 roster 也跟着读不出来 —— 一个新开关把无关功能带塌了。
 *  所以这里**只读自己那一个键**，任何读不出来都回落到 0（fail-open）：
 *  这条判据的失效方向必须是「不拦」。
 *
 *  等 `question-audit.validateConfig()` 也加上这个键（同一个改动里的后续工作），
 *  这里可以改成复用它，判据仍然只有一份。
 *
 *  @param {object} env
 *  @param {{configFile?:string}} [opts] `configFile` 缺省为会话 cwd 下的 `overwatch.config.json`
 */
export function minQuestionsBeforeWriteOf(env = {}, { configFile = null, cwd = null } = {}) {
  const fromConfig = () => {
    const p = String(configFile || (cwd ? join(String(cwd), 'overwatch.config.json') : ''));
    if (!p || !existsSync(p)) return 0;
    let raw;
    try { raw = JSON.parse(readFileSync(p, 'utf8')); } catch { return 0; }
    const ask = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.ask : null;
    if (!ask || typeof ask !== 'object' || Array.isArray(ask)) return 0;
    const v = ask.minQuestionsBeforeWrite;
    if (v === undefined) return 0;
    // 只认整数。字符串 `"3"` 一律当没写 —— 隐式类型转换正是静默校验失效的来源
    // （`question-audit.validateConfig` 的 `bad-range` 说的是同一件事）。
    if (!Number.isInteger(v) || v < 0 || v > MAX_MIN_QUESTIONS) return 0;
    return v;
  };

  const raw = String(env.OW_ASK_MIN_QUESTIONS ?? '').trim();
  if (raw) {
    const v = Number(raw);
    // 缺省与空串必须回落到「配置文件」，**不能**当 0 —— 与 `configOf` 的 `num()`
    // 踩过的是同一个坑：`Number('') === 0` 会静默关掉一个开关。
    // 非法值也回落到配置文件，而不是 0：写错一个环境变量不该把用户刚开的功能关掉。
    if (Number.isFinite(v) && Number.isInteger(v) && v >= 0 && v <= MAX_MIN_QUESTIONS) return v;
  }
  return fromConfig();
}

/** 标记文件绝对路径。`cwd` 是会话根（宿主实测：就是会话根，不是文件所在目录）。 */
export function markerPathFor(cwd) {
  return join(String(cwd || process.cwd()), ...MARKER_REL.split('/'));
}

export function denialPathFor(cwd) {
  return join(String(cwd || process.cwd()), ...DENIAL_REL.split('/'));
}

/** 密钥文件绝对路径。跟着会话 cwd 走，理由同 `markerPathFor`。 */
export function secretPathFor(cwd) {
  return join(String(cwd || process.cwd()), ...SECRET_REL.split('/'));
}

// ── 写操作的识别 ──────────────────────────────────────────────────────

/** 归一化路径用于比较。Windows 下大小写不敏感，所以一律小写 + 正斜杠。
 *
 *  **大小写折叠必须按平台分**：Linux 的 `a.mjs` 与 `A.mjs` 是两个文件。
 *  无条件小写会把它俩折成同一个 key，于是「读过 `a.mjs`」会放行 `Edit A.mjs` ——
 *  Edit 侧那条「读过目标文件本身」的判据（18/18 实测）在 Linux 上直接失效。
 *  同仓 `claim-ledger.mjs` 的 `pathKey()` 本来就有这个守卫，两处口径必须一致。 */
export function pathKeyOf(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** 这个路径是不是**闸门自己的**文件（标记 / 刹车计数 / 闸门日志）。
 *
 *  必须放行，否则 AI 永远写不出标记，闸门自锁。范围刻意收到 `.claude/.ow-*`：
 *  `.claude/CLAUDE.md`、`.claude/settings.json` 这些**不是**我们的，照拦。 */
export function isGateOwnedPath(p, cwd) {
  const k = pathKeyOf(p);
  const base = pathKeyOf(cwd);
  if (!k) return false;
  if (base && k.startsWith(base + '/')) {
    const rel = k.slice(base.length + 1);
    if (rel.startsWith('.claude/.ow-')) return true;
  }
  return /\/\.claude\/\.ow-[^/]+$/.test(k) || /^\.claude\/\.ow-/.test(k);
}

/** 取 `Write`/`Edit`/`NotebookEdit` 的目标路径。 */
function fileTargetsOf(toolName, ti) {
  if (!ti || typeof ti !== 'object') return [];
  const raw = [ti.file_path, ti.notebook_path, ti.path, ti.target_file];
  return raw.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
}

/** PowerShell 里会落盘的命令。含官方别名（`sc` 就是 `Set-Content`，最容易漏）。 */
const PS_WRITE_VERBS = Object.freeze([
  'set-content', 'add-content', 'clear-content', 'out-file', 'tee-object',
  'new-item', 'set-item', 'copy-item', 'move-item', 'rename-item',
  'export-csv', 'export-clixml', 'set-clipboard',
  // 别名
  'sc', 'ac', 'clc', 'ni', 'si', 'cpi', 'copy', 'mi', 'move', 'rni', 'ren',
  'epcsv', 'epxml',
]);

/** 会「再跑一条看不见的命令」的动词：解析不出来，必须计数。 */
const PS_OPAQUE_VERBS = Object.freeze([
  'invoke-expression', 'iex', 'invoke-command', 'icm', 'start-process', 'saps',
  'start-job', 'sajb', 'invoke-item', 'ii', '&', 'call',
]);

/** 取 `-Path`/`-FilePath`/… 的值，否则取第一个位置参数。`null` = 判不出。
 *
 *  `-Value` 是**内容**不是路径，绝不能被当成目标 —— 否则 `Set-Content -Value 'x'`
 *  会把内容字符串当成文件名。这类「参数名近义」的坑在 PowerShell 比 Bash 多得多。 */
function psTargets(argv) {
  const pathFlags = /^-(path|filepath|literalpath|destination|target|outfile|pspath)$/i;
  const valueFlags = new Set([
    '-value', '-encoding', '-itemtype', '-force', '-name', '-inputobject',
    '-append', '-nonewline', '-width', '-delimiter', '-confirm', '-whatif', '-asbytestream',
    '-filter', '-include', '-exclude', '-recurse',
  ]);
  const out = [];
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^-/.test(a)) {
      if (pathFlags.test(a) && i + 1 < argv.length) { out.push(argv[i + 1]); i++; continue; }
      if (valueFlags.has(a.toLowerCase()) && i + 1 < argv.length) { i++; continue; }
      continue;
    }
    positional.push(a);
  }
  const picked = out.length ? out : positional.slice(0, 1);
  return picked.length ? picked : null;
}

/** PowerShell 命令是不是写文件。返回 `{isWrite, paths, dirs, unresolved}`。
 *
 *  这一支是 G6 那条实测洞的补丁：`Set-Content -Path gated.txt -Value 'x'` 在只 matcher
 *  `Write|Edit` 的闸门下照常落盘。 */
export function powershellWriteScan(cmd) {
  const scan = { isWrite: false, paths: [], dirs: 0, unresolved: 0 };
  const text = typeof cmd === 'string' ? cmd : '';
  if (!text.trim()) return scan;

  // `[IO.File]::WriteAllText(...)` / `[System.IO.File]::AppendAllText(...)`
  if (/\[(?:System\.)?IO\.File\]::(?:Write|Append)\w+/i.test(text)) {
    scan.isWrite = true;
    scan.unresolved++;
  }

  // 按语句分隔符切。PowerShell 的 `;` 与换行都是分隔符，`|` 是管道（左侧可能是写）。
  const segments = text.split(/[;\n]/).flatMap((s) => s.split(/\|(?!\|)/));
  for (const segRaw of segments) {
    const seg = segRaw.trim();
    if (!seg) continue;

    // 重定向：`>`, `>>`, `1>`, `2>`, `*>`, `2>&1` 不是写文件
    const redir = /(?:^|\s)(?:\*|\d)?>{1,2}(?:&(?:\d+|-))?\s*([^\s;|]+)/g;
    for (const m of seg.matchAll(redir)) {
      const target = m[1];
      if (m[0].includes('&') && /^&?(?:\d+|-)$/.test(target)) continue;
      if (!target || /^&/.test(target)) continue;
      scan.isWrite = true;
      scan.paths.push(target.replace(/^["']|["']$/g, ''));
    }

    // 命令词：跳过 `$x = ` 这类赋值前缀
    const tokens = seg.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && (/^[$@(]/.test(tokens[i]) || tokens[i].includes('='))) i++;
    if (i >= tokens.length) continue;
    const verb = tokens[i].replace(/^["']|["']$/g, '').toLowerCase();
    const argv = tokens.slice(i + 1).map((t) => t.replace(/^["']|["']$/g, ''));

    if (PS_OPAQUE_VERBS.includes(verb)) { scan.unresolved++; continue; }
    if (!PS_WRITE_VERBS.includes(verb)) continue;

    // 建目录不是写文件内容（和 Bash 侧 `mkdir` 的处置一致）
    const itemType = argv.findIndex((a) => /^-itemtype$/i.test(a));
    const isDir = (itemType >= 0 && /^(directory|dir|container)$/i.test(argv[itemType + 1] || ''))
      || ['mkdir', 'md', 'new-item'].includes(verb) && /-itemtype\s+(directory|dir)/i.test(seg);
    if (isDir) { scan.dirs++; continue; }

    const targets = psTargets(argv);
    if (!targets) { scan.unresolved++; continue; }
    scan.isWrite = true;
    for (const t of targets) scan.paths.push(t);
  }
  return scan;
}

/** 一次工具调用是不是「写文件」。
 *
 *  返回 `{isWrite, via, paths, dirs, unresolved}`。`unresolved>0` 表示命令里有我们解析不出来的
 *  片段（`sh -c`、`xargs`、`iex`）——**计数但不当写**，见文件头 §诚实边界。 */
export function writeIntentOf(toolName, toolInput, cwd) {
  const name = String(toolName || '');
  const res = { isWrite: false, via: 'none', paths: [], dirs: 0, unresolved: 0 };
  if (!name) return res;

  if (WRITE_TOOLS.includes(name)) {
    const paths = fileTargetsOf(name, toolInput);
    res.isWrite = paths.length > 0;
    res.via = 'file-tool';
    res.paths = paths;
    return res;
  }

  if (SHELL_TOOLS.includes(name)) {
    const cmd = toolInput && typeof toolInput === 'object'
      ? (toolInput.command ?? toolInput.script ?? toolInput.CommandLine ?? '')
      : '';
    if (typeof cmd !== 'string' || !cmd.trim()) return res;
    res.via = name === 'PowerShell' ? 'powershell' : 'bash';
    if (name === 'PowerShell') {
      const s = powershellWriteScan(cmd);
      res.isWrite = s.isWrite;
      res.paths = s.paths;
      res.dirs = s.dirs;
      res.unresolved = s.unresolved;
      return res;
    }
    // Bash 侧复用已过测试的实现（`claim-ledger.mjs` 的 tokenizer）。
    // cwd 不可知时相对路径判不出，`bashWriteScan` 会记 unresolved —— 保守方向。
    let s;
    try {
      s = bashWriteScan(cmd, cwd || null);
    } catch {
      res.unresolved++;
      return res;
    }
    res.isWrite = s.writes.length > 0;
    res.paths = s.writes.map((w) => w.path);
    res.dirs = s.dirs;
    res.unresolved = s.unresolved + (s.abortedForCwd || s.abortedSubshell ? 1 : 0);
    return res;
  }

  return res; // 未知工具：不判写，放行（由 checkUnregistered / 日志暴露）
}

// ── transcript：数「读过什么」 ────────────────────────────────────────

/** 这一段命令是不是**就地编辑**（`sed -i`）。返回 true 时整段不算读过。
 *
 *  `DF-027` 的核心：`sed` 一个动词两种语义，所以判据不能只按动词名做。
 *  识别的是**就地编辑开关**，不是「有没有 `-i` 这三个字符」—— 因为
 *  `sed -n '/-i/p' f` 里也含 `-i`，那是被读的内容，不是改盘的开关。
 *
 *  认的形态：
 *    `-i` ／ `-i.bak`（GNU 后缀）／ `-ni`、`-Ei`（组合短选项）／ `--in-place`、`--in-place=.bak`
 *  （这里**没有**用量统计。此前写着「本机 164 条真实就地编辑命令全部落在前四种里」——
 *  那 164 是编的，见文件上方 `SHELL_READ_VERBS` 那段修正与 `DF-032`。
 *  这几种形态的依据是 `sed` 的**选项语法**，不是本机出现频次。）
 *
 *  只扫**独立 token**：`s/a/-i/`、`/-i/p` 这类脚本参数不以 `-` 开头，天然被排除。
 *  唯一的漏法是 `--` 之后的 token —— 那时后面的 `-i` 是文件名而不是开关，
 *  但 `sed` 没有「`--` 之后还要读开关」的用法，所以漏判方向是「多记一次读」，
 *  与修前一致，不制造新的假证据。 */
function isInPlaceEdit(argv) {
  for (const a of argv) {
    const s = String(a || '');
    if (s === '--') break;                      // 选项结束：后面的 `-i` 是文件名
    if (/^--in-place(=|$)/.test(s)) return true;
    // 单横线短选项簇里含 `i`（`-i` / `-ni` / `-Ei` / `-i.bak`）。`--` 已被上面排除。
    if (/^-[A-Za-z]*i/.test(s)) return true;
  }
  return false;
}

/** 从 `sed` 的参数里取出**输入文件**。取不到返回 null。
 *
 *  为什么不能沿用通用的「取第一个非 `-` 开头 token」：在 `sed` 上，第一个位置参数
 *  **不是文件，是脚本**。实测 `sed -n '1,30p' docs/CHANGELOG.md` 会抽出 `1,30p`
 *  （绝对化后 `D:\repo\1,30p`），真正的目标文件永远数不上 —— 「修好了 sed」就成了空话。
 *
 *  规则（GNU sed 实际语义，只取判据需要的部分）：
 *    · `-e SCRIPT` / `--expression`、`-f FILE` / `--file` 出现时，脚本在选项值里，
 *      之后**第一个位置参数就是输入文件**；
 *    · 否则第一个位置参数是脚本，**第二个**才是输入文件；
 *    · 短选项簇按字符走（`-ne 'p'` 里 `e` 吃值、`-ni` 里 `i` 只吃粘连后缀）；
 *    · `--` 之后全是位置参数。
 *
 *  判错的方向：返回 null（这一段不计）或返回了非文件 token（多记一次读）。
 *  两者都不制造「把写当成读」—— 写那一侧由 `isInPlaceEdit` 单独挡。 */
function sedInputFile(argv) {
  const a = argv.map((x) => String(x ?? ''));
  let i = 0;
  let scriptGiven = false;
  while (i < a.length) {
    const s = a[i];
    if (s === '--') { i++; break; }
    if (s.startsWith('--')) {
      const name = s.slice(2).split('=')[0];
      if (name === 'expression' || name === 'file') { scriptGiven = true; }
      // 带值的长选项：`--x=y` 自带值，`--x y` 吃下一个 token
      i += (['expression', 'file', 'line-length'].includes(name) && !s.includes('=')) ? 2 : 1;
      continue;
    }
    if (s.startsWith('-') && s.length > 1) {
      // 短选项簇。遇到吃值的 `e`/`f`/`l` 就停下：值要么是簇内剩余字符，要么是下一个 token。
      const body = s.slice(1);
      let consumedNext = false;
      for (let k = 0; k < body.length; k++) {
        const ch = body[k];
        if (ch === 'e' || ch === 'f') { scriptGiven = true; }
        if (ch === 'e' || ch === 'f' || ch === 'l' || ch === 'i') {
          // `e`/`f`/`l`：簇内剩余字符即值；没有剩余则值在下一个 token（`i` 只吃粘连后缀）
          if (k === body.length - 1 && ch !== 'i') consumedNext = true;
          break;
        }
      }
      i += consumedNext ? 2 : 1;
      continue;
    }
    break;                                  // 位置参数开始
  }
  // 剩下的都是位置参数：没有 -e/-f 时，第一个是脚本，跳过它
  return a[i + (scriptGiven ? 0 : 1)] || null;
}

/** 把一条读到的路径落到**绝对路径**上，基准是会话 `cwd`。`DF-027` 的第二个缺陷。
 *
 *  `pathKeyOf()` 只做分隔符归一、**不做消解**，所以修前 `docs/changelog.md`
 *  永远不等于 `<repo>/docs/changelog.md`：Edit 侧的目标来自
 *  `tool_input.file_path`（绝对），shell 侧来自命令原文（常常是相对），
 *  `target-read` 那条判据对任何用 shell 读文件的会话恒不命中。
 *
 *  **为什么不硬回落到 `process.cwd()`**：那是「跑 hook 的那个进程」的目录，
 *  不是会话目录。拿它当基准等于把一个猜测变成证据 —— 测试进程的工作目录
 *  会冒充成用户项目根。拿不到 `cwd` 就原样返回（退回修前行为），
 *  调用方少了基准时会表现出「相对路径仍不匹配」，那是可诊断的，不是静默错答案。
 *
 *  只消解**相对**路径：绝对路径已无歧义，再做一次 `resolve()` 在 Windows 上会把
 *  `/c/x` 这类 POSIX 风格串改挂到当前盘根（`D:\c\x`），凭空造出一个不存在的路径。
 *  `~` 开头的也不猜（不是 `resolve()` 能处理的语义），原样保留。 */
function toAbsoluteReadPath(p, cwd) {
  const s = String(p || '');
  if (!s || !cwd) return s;
  if (s.startsWith('~')) return s;
  if (isAbsolute(s)) return s;
  try { return resolve(String(cwd), s); } catch { return s; }
}

/** 一次工具调用读到了哪些文件路径。**纯函数**：不读盘、不看状态。
 *
 *  这是「什么叫读过项目」的**唯一实现**。`readTranscriptReads()`（闸门）与
 *  `observe-reality-check.mjs` 的重放器都调它 —— 重放器曾经自己写了一份，
 *  于是闸门改动词表后重放不会跟着变，报告上的百分比就成了不可复算的话。
 *  分叉规模见 `scripts/probe-parser-divergence.mjs`。
 *
 *  `cwd` 是**会话目录**（宿主在 hook 输入里给 `cwd`），用来把相对路径绝对化。
 *  它放在第 4 位、默认 `null`，是刻意的：既有调用方（重放器、审计脚本）不改一行，
 *  行为与修前逐字相同；闸门这一条路在 `runHook` 里把 cwd 一路传进来。
 *  改动更小的备选是「让 `decide()` 归一化」—— 但那样每个新比较点都得记得归一一次，
 *  而这条路径上已经有四个消费者（闸门 / 重放器 / 提问审计 / 两个测量脚本），
 *  漏一个就是一个静默错答案。在**抽取点**做一次，只有一处可能错。
 *
 *  已知缺陷（本轮**不修**，修它会改变闸门行为）：带独立值的选项把值当成路径 ——
 *  `head -n 20 a.mjs` 取到 `20`。方向是多算（更宽松）。这个缺陷被
 *  `observe-reality-check.test.mjs` 钉在测试里，将来修它会红。 */
export function readPathsOfToolUse(name, input, readVerbs = SHELL_READ_VERBS, cwd = null) {
  const out = [];
  const n = String(name || '');
  const inp = input && typeof input === 'object' ? input : {};
  // 与闸门原实现（内联的 `add()`）逐字一致：trim 后为空即不计数。
  // 这一条不是美化 —— 空白路径曾被重放器数成一个文件，是实测确认的分叉点之一。
  const add = (raw) => {
    const v = String(raw ?? '').trim();
    if (v) out.push(toAbsoluteReadPath(v, cwd));
  };
  if (READ_TOOLS.includes(n)) {
    add(inp.file_path || inp.notebook_path || inp.path);
    return out;
  }
  if (n !== 'Bash' && n !== 'PowerShell') return out;
  const cmd = typeof inp.command === 'string' ? inp.command : '';
  if (!cmd) return out;
  // 只认「整份读」的动词，避免把 `grep`/`ls`/`Get-ChildItem` 当成读过内容
  for (const seg of cmd.split(/[;|&\n]/)) {
    const t = seg.trim().split(/\s+/);
    let i = 0;
    while (i < t.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i]))) i++;
    const verb = basename(String(t[i] || '')).replace(/\.exe$/i, '').toLowerCase();
    if (!readVerbs.includes(verb)) continue;
    const argv = t.slice(i + 1);
    // `sed` 既是读也是写：带就地编辑的**整段**不计数（见 `isInPlaceEdit` 的注释）。
    // 只对 `sed` 做这一判 —— 其它动词目前在表里没有写语义，
    // 给它们套同一个开关判断只会引入「`cat -i` 不算读」这种凭空的副作用。
    if (verb === 'sed' && isInPlaceEdit(argv)) continue;
    // `sed` 的**第一个位置参数是脚本**（`'1,30p'`、`'s/x/y/'`），不是文件名。
    // 通用循环会把它当文件（实测 `sed -n '1,30p' f` 抽出 `1,30p`），
    // 于是真正的目标永远数不上 —— 所以 `sed` 走 `sedInputFile()` 单独取。
    // 不能推广到别的动词：`head -n 20 f` 里 `20` 是选项值、`f` 才是文件，
    // 形状一样语义不同（那个已知缺陷本轮不修，见函数头注释）。
    if (verb === 'sed') {
      const f = sedInputFile(argv);
      if (f) add(/^["']|["']$/.test(f) ? f.replace(/^["']|["']$/g, '') : f);
      continue;
    }
    for (const a of argv) {
      if (/^-/.test(a)) continue;
      add(/^["']|["']$/.test(a) ? a.replace(/^["']|["']$/g, '') : a);
      break;
    }
  }
  return out;
}

/** 从 transcript 文本里数「读过哪些不同文件」。**纯函数**：文本进、数组出。
 *
 *  与 `readTranscriptReads` 的关系：后者负责「读文件尾部」，把文本交给本函数。
 *  两者分开是为了让重放器能用**同一段文本**、**同一个判据**，而不是复制一份循环。
 *
 *  `cwd` 透传给 `readPathsOfToolUse`（相对路径绝对化的基准）。默认 `null`：
 *  既有调用方行为不变。 */
export function readPathsInTranscriptText(text, readVerbs = SHELL_READ_VERBS, cwd = null) {
  const seen = new Set();
  const paths = [];
  let lines = 0;
  let unparsable = 0;
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    lines++;
    let rec;
    try { rec = JSON.parse(s); } catch { unparsable++; continue; }
    const content = rec && rec.message && Array.isArray(rec.message.content) ? rec.message.content : null;
    if (!content) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      for (const raw of readPathsOfToolUse(b.name, b.input, readVerbs, cwd)) {
        const k = pathKeyOf(raw);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        paths.push(raw);
      }
    }
  }
  return { paths, lines, unparsable };
}

/** 从 transcript 尾部数「本会话读过哪些不同文件」。**只读，不写**。
 *
 *  `transcript_path` 是宿主给的绝对路径，实测可读。读尾部而不是全文件：判定在每一次
 *  PreToolUse 上都要跑，全量扫 1.5 GB 语料是不可接受的延迟。尾部 1MB 足够覆盖一个
 *  「刚读完项目、马上要写」的会话。
 *
 *  返回 `{paths, bytesRead, lines, truncatedFirst, unparsable}`。 */
export function readTranscriptReads(transcriptPath, { bytes = 1024 * 1024, readVerbs = SHELL_READ_VERBS, cwd = null } = {}) {
  const out = { paths: [], bytesRead: 0, lines: 0, truncatedFirst: false, unparsable: 0 };
  const p = String(transcriptPath || '');
  if (!p) return out;
  let buf;
  try {
    const r = readTailBytes(p, bytes);
    if (!r) return out;
    buf = r.buf;
    out.bytesRead = r.bytesRead;
  } catch {
    return out;
  }
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  // 从中间切进去时第一行必然是半条，丢掉 —— 否则会多出一个 unparsable
  if (out.bytesRead >= bytes && lines.length > 1) { lines.shift(); out.truncatedFirst = true; }

  const parsed = readPathsInTranscriptText(lines.join('\n'), readVerbs, cwd);
  out.paths = parsed.paths;
  out.lines = parsed.lines;
  out.unparsable = parsed.unparsable;
  return out;
}

/** 一次 transcript 工具调用算不算「写」。**判据与 `writeIntentOf` 同源**，
 *  但这里只用最窄的一条：`Write`/`Edit`/`MultiEdit`/`NotebookEdit` 与能从命令里
 *  认出来的 shell 写。理由见 `readTranscriptActivity()` 的 `priorWriteCalls`。 */
function isWriteUse(name, input, cwd) {
  if (!String(name || '')) return false;
  try { return writeIntentOf(name, input, cwd).isWrite; } catch { return false; }
}

/** 从 transcript 里数：本会话**问过几个不同的问题**、**写成过几次**、**读过哪些文件**。
 *  **只读，不写**。一次有界读（默认尾部 `bytes`，不够则**有界回扫**）算出三样东西。
 *
 *  ## 为什么和 `readTranscriptReads()` 分成两个函数
 *
 *  `readTranscriptReads()` 是已有判据的唯一实现，五个消费者依赖它（闸门 / 重放器 /
 *  提问审计 / 两个测量脚本）。它只抽「读过哪些文件」。这里要的是另外两样，
 *  硬塞进去会让它的返回值变成一个所有调用方都要多拿一份的对象 —— 那是改动更大、
 *  更容易漂的方向。所以**读盘逻辑共用 `readTailBytes`，解析逻辑各自成一处**，
 *  没有第二份「怎么算读过」的实现。
 *
 *  ## 三样东西的判据
 *
 *  · `questions` —— **去重后的问题原文**。键是 `normalizeText(question)`，
 *    所以同一个问题换个标点/空格仍算同一个。`ExitPlanMode` 贡献一个固定键
 *    `'exitplanmode'`：它是「计划批准」，同样是一次「我停下来等你」。
 *
 *    **口径**：`AskUserQuestion` 与 `ExitPlanMode` **都算**，与
 *    `measure-ask-vs-tell.mjs` 一致。`question-audit.mjs` 的 `scanSession()` 现在
 *    也走同一个 `isAskToolName()`（2026-11-19 统一），两处一处口径。
 *
 *  · `askCalls` —— **按 `tool_use.id` 去重后**的提问调用次数。宿主会把同一次调用
 *    写成两行（实测全语料 33,090 行重复），不去重会系统性算高 39%。
 *
 *  · `priorWriteCalls` —— 转录里**真的写成过**几笔写。定义改过两次，每次都因为
 *    原来的定义在真宿主上不成立（见 §两次修正）。现行定义：
 *    **该 `tool_use` 有对应的 `tool_result`，且那个 result 不是错误。**
 *
 *    ## 两次修正（2026-11-19，验收判 FAIL 的那两条）
 *
 *    **修正一：`priorWriteCalls` 恒 ≥ 1，判据从不执行。**
 *    原实现把「尾部窗口里出现过写调用」整片算作「之前写过」，注释理由是
 *    「闸门在 PreToolUse 阶段跑，本次调用还没落进 transcript」。
 *    **这个前提是假的**：真 `claude.exe` 上实测（mock 模型 + 真宿主，
 *    `2026-11-19` 复现），hook 触发时本次 `Write` 的 `tool_use` **已经落盘**，
 *    只是还没有 `tool_result`。于是每一笔写都被数成「之前写过」，
 *    `priorWriteCalls > 0` 恒成立，这条判据**一次都不执行**。
 *
 *    **修正二：被拒的写也被算成「写成过」。**
 *    顺着修正一继续查（同一次复现）：被闸门拒绝的那次写的 `tool_result`
 *    是 `is_error:true`，文件**从未落盘**。原实现不区分 result，于是
 *    「被拒 → 重试」这条路第一次被拒，第二次就被当成「已经写过」放行 ——
 *    判据被自己的拒绝动作解除了。
 *
 *    两次修正合起来只有一条判据：**`tool_result` 存在且非 error**。
 *    它同时解决「本次调用自身」（无 result）与「被拒的调用」（error result）
 *    两个假阳性，而且不需要拿 `tool_use_id` 去比 —— 比 id 只能解决前者。
 *    拿不到 `is_error` 字段（老格式）时按「成功」算：方向是更容易跳过判据（宽松），
 *    与全文件的 fail-open 取向一致。
 *
 *  ## 有界回扫（修正三）
 *
 *  只读尾部 1 MB 会让长会话**永久锁死**：本机实测 172 个 >1 MB 会话里 49 个的提问
 *  全部落在窗口外（最大 102.9 MB / 全文 9 问 / 尾内 0 问）。那种会话 `have < need`
 *  恒成立，`brake="halt"` 下每次拒都结束回合 —— 用户没有出路。
 *
 *  所以 `need > 0` 且一块不够时**向前回扫**，直到够数或到 `maxScanBytes`（默认 8 MB）。
 *  仍然不够且还有未扫内容 → `truncated: true`，调用方**必须据此放行**（不判）。
 *  「没读到」永远不是「没问过」。
 *
 *  实测耗时（本机，`pre-write-gate.mjs` 的 `readTailBytes` + 逐行 `JSON.parse`，
 *  8 MB 会话）：单块 1 MB 27.3 ms / 扫满 8 MB 213.1 ms。
 *  `need` 满足即停（问题落在尾块里时 35.5 ms、只读 1 块），所以常见情况只付 1 MB 那一档。
 *  **改前那句「`need` 满足即停」是假的**：`out.distinctQuestions` 只在循环外赋值，
 *  循环内读到的永远是初值 0，早停是死代码、每次扫满上限（旧实现同一场景 200.1 ms / 8 块）。
 *
 *  ## 块边界对齐到行首（修正四，2026-11-19 第二轮验收 FAIL 的根因）
 *
 *  旧实现只对每块的**首行**做 `shift()`：块起点不落在行首时，被切开的那一行
 *  **同时是上一块的末行**——尾半段被 `shift()` 丢掉、头半段留在上一块里单独
 * `JSON.parse` 失败，两半都不进任何计数，**整条记录静默消失**，而 `truncated`
 * 仍报 `false`。实测量化（7397 份 transcript）：9965 行跨在 1 MB 边界上，
 * 同一 8 MB 窗口下对比单块 vs 分块，4258 个 >1 MB 会话里 `priorWriteCalls`
 * 不一致 220 个、`reads` 不一致 79 个。端到端误拦已复现：文件 1 MB+98 字节、
 * 三个问题都在文件开头 → 头块把提问行切掉、`q=0`、`truncated=false` → 误拦。
 *
 *  现行做法：**块边界对齐到行首，并把右邻块丢掉的那半行补回来**。
 *  块 k 从 `start` 开始、右边界 `effEnd`；`start > 0` 时丢掉 `[start, 首个 \n]`
 *  这段半行，并把它交给下一轮（`carry`）——下一轮的右边界延伸到 `start + carry`，
 *  于是那一行在被切开的另一侧**是完整的一行**。覆盖率因此是连续的
 *  `[start_n, size)`，没有空洞，也不需要「重复解析边界行、靠集合幂等兜住」。
 *
 *  兜底：任何一块出现 `unparsable > 0`，或整块落在同一行里（行比块还长），
 *  `truncated` 一律置 `true`。静默丢数据是这次 FAIL 的根本原因——宁可让下游
 *  知道「这次读得不完整」，也不能报一个假的「读完了，没问题」。
 *
 *  ## fail-open
 *
 *  路径为空 / 读不到 / 全是坏 JSON → 返回空结构，`bytesRead:0`。
 *  调用方据此判定「这条判据没有数据」，**不许因此拦人**。
 *
 *  @returns {{questions:string[], askCalls:number, distinctQuestions:number,
 *             unknownAskCalls:number, priorWriteCalls:number, reads:string[],
 *             unreadable:boolean, truncated:boolean, chunks:number,
 *             bytesRead:number, lines:number, unparsable:number}}
 */
export function readTranscriptActivity(transcriptPath, {
  bytes = 1024 * 1024, readVerbs = SHELL_READ_VERBS, cwd = null,
  /** 需要几个问题。`>0` 才启用回扫；`0`（默认）= 只读一块，行为与引入回扫前逐字相同。 */
  need = 0,
  /** 回扫上限（字节，从文件尾算起）。 */
  maxScanBytes = DEFAULT_MAX_SCAN_BYTES,
} = {}) {
  const out = {
    questions: [], askCalls: 0, distinctQuestions: 0, unknownAskCalls: 0,
    priorWriteCalls: 0, reads: [], unreadable: true, truncated: false, chunks: 0,
    bytesRead: 0, lines: 0, unparsable: 0,
  };
  const p = String(transcriptPath || '');
  if (!p) return out;

  // 跨块共享的解析状态。用集合而不是累加：块与块不重叠，但保守起见仍按集合去重
  // （同一条 `tool_use` 被宿主写成两行是**真实存在**的，见 `askCalls` 的口径）。
  // `results` 也必须在这里而不是在 `ingestActivity()` 里新建 —— `tool_use` 与它的
  // `tool_result` 是两行，块边界可以落在两者之间（见 `ingestActivity()` 文件头）。
  const acc = {
    seenIds: new Set(), seenQ: new Set(), seenReads: new Set(),
    results: new Map(),     // tool_use_id -> isError，跨块共享
    writeIds: new Set(),    // 写成过的写调用 id，**结算放到循环后**（见 ingestActivity）
  };
  const wantQ = Math.max(0, Number(need) || 0);
  const cap = Math.max(0, Number(maxScanBytes) || 0);
  /** 已扫到的左边界（绝对偏移）。`null` = 还没读过，等价于文件尾。 */
  let end = null;
  let size = 0;
  /** 右邻块丢掉的那半行（本块某一行被块边界切开的**右半段**，还没有左半段）。 */
  let carry = Buffer.alloc(0);

  for (;;) {
    let r;
    try {
      r = readTailBytesFrom(p, bytes, end === null ? 0 : size - end);
    } catch {
      break;
    }
    if (!r) break;
    size = r.size;
    out.unreadable = false;
    if (!r.bytesRead) break;        // 读不动了（空文件 / 防御空转）
    out.chunks++;
    out.bytesRead += r.bytesRead;

    const blockEnd = end === null ? size : end;
    const blockStart = blockEnd - r.bytesRead;

    // 块 [blockStart, blockEnd)。它从行首开始**当且仅当** `blockStart === 0`。
    // 否则从中间切进去：开头那半行不在这里解析，而是当作 `carry` 交给左侧块，
    // 由左侧块用自己那半段拼成完整行解析一次 —— 全局恰好一次。
    // 旧实现只 `shift()` 不回收，两半各自 JSON.parse 失败、整条记录静默消失，
    // 而 `truncated` 仍报 false（见函数头 §块边界对齐到行首）。
    let buf = r.buf;
    let nextEnd = blockStart;
    let headPartial = null;         // 本块被切开的**首行左半段**，交给左侧块
    if (blockStart > 0) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        // 整块落在同一行里（行比块还长）：整块都是某行的中段，继续向左凑。
        // 这一段的字节没有交给 `ingestActivity`，但 `end` 会一直往前推；若最后
        // 停在文件头，那整行会在 `blockStart === 0` 那一次被完整解析。真正读完
        // 不了的只有「到上限」那种，那时 `truncated` 本来就为 `true`。
        carry = Buffer.concat([buf, carry]);
        end = blockStart;
        if (!wantQ) break;                        // 不回扫（默认路径）
        if (carry.length >= cap) break;           // 一行就吃满上限，没得读了
        continue;
      }
      if (nl > 0) headPartial = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);                 // 从此处起对齐到行首
      // **未覆盖区间的右端点就是 `blockStart`**，不是 `blockStart + nl + 1`。
      // `[blockStart, blockStart + nl)` 这段（被切开的行的**后半段**）已经放进
      // `headPartial`，由左侧块拼成完整行解析；算进 `nextEnd` 会重复解析它。
      nextEnd = blockStart;
    }

    // `buf` 从行首开始，但末端可能被块边界截断。按**字节**找最后一个换行，
    // 中间整行直接解析，末尾那半行与 `carry`（右邻块的左半段）拼成一行。
    // 在这里而不是在字符串上分，是为了不把被截断的多字节字符解码成 U+FFFD。
    const lastNl = buf.lastIndexOf(0x0a);
    const lines = [];
    if (lastNl >= 0) {
      const head = buf.subarray(0, lastNl).toString('utf8');
      if (head) lines.push(...head.split('\n'));
    }
    const tailBytes = lastNl >= 0 ? buf.subarray(lastNl + 1) : buf;
    // `tailBytes` 什么时候是完整行：`carry` 非空时两段拼起来是完整行；`carry`
    // 为空时它本身就是完整行（文件末行没有结尾换行，或右邻块正好从行首开始）。
    if (tailBytes.length || carry.length) {
      const joined = Buffer.concat([tailBytes, carry]);
      if (joined.length) lines.push(joined.toString('utf8'));
    }
    carry = headPartial || Buffer.alloc(0);

    if (lines.length) ingestActivity(out, acc, lines, { readVerbs, cwd });
    // 早停必须读**实时**的去重数：`out.distinctQuestions` 只在循环外赋一次值的
    // 旧实现里，循环内读到的永远是初值 0，早停是死代码、每次扫满上限
    // （2026-11-19 第二轮验收 FAIL 的第 1 条）。
    out.distinctQuestions = acc.seenQ.size;

    if (nextEnd === 0) { end = 0; break; }        // 已经读到文件头
    end = nextEnd;
    if (!wantQ) break;                             // 不回扫（默认路径）
    if (out.distinctQuestions >= wantQ) break;     // 够了（早停）
    if (size - end >= cap) break;                  // 到回扫上限
  }

  out.distinctQuestions = acc.seenQ.size;
  // `priorWriteCalls` 在这里一次性结算，**不在 `ingestActivity()` 里边扫边加**：
  // 回扫是从尾向前的，写调用与它的 `tool_result` 可以跨块、中间还隔着重复副本行。
  // 边扫边加会让结果取决于**扫到的先后**（实测 5.93 MB 会话单块 86 / 分块 85）。
  // 结算口径与逐行读完全一致：`tool_use` 是写、有对应 result、且 result 非 error。
  out.priorWriteCalls = 0;
  for (const id of acc.writeIds) {
    if (acc.results.has(id) && acc.results.get(id) !== true) out.priorWriteCalls++;
  }
  // 「还有没看过的内容」= 决策者必须知道的第三态。没读到 ≠ 没有。
  //
  // 三种停法要分开算，**这一条不能沿用旧口径**：
  //   · 读到文件头（`end === 0`）→ 全读了，`false`。
  //   · **够数提前停**（`distinctQuestions >= need`）→ `false`。这是必须的：
  //     下游 `decide()` 是「先看 `truncated`，`true` 就放行且不判」。旧实现
  //     「`fromEnd < size` 即 truncated」配上修好的早停会把**每一次**够数的判定
  //     都变成被迫放行 —— 闸门又变回永不执行。**早停与 truncated 是一对**，
  //     只修其中一个会把缺陷从一个方向搬到另一个方向。
  //   · 其余（到上限 / 读不动 / 停在文件中间）→ `true`。
  const reachedStart = end === 0 || (end === null && size === 0);
  const metNeed = wantQ > 0 && out.distinctQuestions >= wantQ;
  out.truncated = out.unreadable === false && !reachedStart && !metNeed;
  // **兜底**：任何一块出现解析失败（`unparsable > 0`），说明这次读不完整 ——
  // 静默丢数据是第二轮 FAIL 的根本原因。宁可让下游看到 `truncated` 后放行，
  // 也不能报一个假的「读完了、没问题」。
  if (out.unreadable === false && out.unparsable > 0) out.truncated = true;
  return out;
}

/** 把一块 transcript 文本解析进 `out` / `acc`。**可被多块重复调用**（幂等）。
 *
 *  `acc.results`（`tool_use_id -> isError`）**必须跨块累积**，不能每块新建一个 Map：
 *  `tool_use` 与它的 `tool_result` 是两行，块边界可以落在两者之间。块内局部的 Map
 *  在那种情况下永远看不到对方那一半，`priorWriteCalls` 就**少算** —— 实测量化
 *  （同一份夹具、唯一 id、块 300 字节）：单块 20 笔，分块只剩 8 笔。这是分块逻辑
 *  的第三个静默丢数据点，与块边界丢整行同源（各块独立解析），一并修在这里。 */
function ingestActivity(out, acc, lines, { readVerbs, cwd }) {
  // 第一趟收集 tool_result：`priorWriteCalls` 的判据依赖它（见函数头 §两次修正）。
  // `is_error` 缺失（undefined）按成功算 —— 老格式不写这个字段，方向是宽松。
  const results = acc.results;   // tool_use_id -> isError(boolean)，**跨块共享**
  // 注意：这一趟只是把 result 收进共享 Map；`priorWriteCalls` 的加法在循环外结算（见文件尾）。
  for (const line of lines) {
    const rec = parseLine(line);
    if (!rec) continue;
    const content = rec.message && Array.isArray(rec.message.content) ? rec.message.content : null;
    if (!content) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_result') continue;
      if (typeof b.tool_use_id === 'string' && b.tool_use_id) results.set(b.tool_use_id, b.is_error === true);
    }
  }

  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    const rec = parseLine(line);
    if (!rec) { out.unparsable++; continue; }
    out.lines++;
    const content = rec.message && Array.isArray(rec.message.content) ? rec.message.content : null;
    if (!content) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      // 宿主重写留下的副本行不是第二次调用（`question-audit.mjs` 实测 33,090 行）。
      if (typeof b.id === 'string' && b.id) {
        if (acc.seenIds.has(b.id)) continue;
        acc.seenIds.add(b.id);
      }
      for (const raw of readPathsOfToolUse(b.name, b.input, readVerbs, cwd)) {
        const k = pathKeyOf(raw);
        if (!k || acc.seenReads.has(k)) continue;
        acc.seenReads.add(k);
        out.reads.push(raw);
      }
      if (isAskToolName(b.name)) {
        out.askCalls++;
        if (b.name === 'ExitPlanMode') {
          // 计划批准 = 一次「我停下来等你」。用一个固定键，不给它编一个问题文本 ——
          // 编了就等于凭空造出「问过什么」的证据。
          recordQuestion(out, acc, 'exitplanmode', 'ExitPlanMode');
          continue;
        }
        const q = questionsOfAsk(b.input);
        if (q.unknown) { out.unknownAskCalls++; continue; }
        for (const item of q.questions) recordQuestion(out, acc, normalizeText(item.question), item.question);
      } else if (isWriteUse(b.name, b.input, cwd)) {
        // **只有真落盘的写才算「之前写过」。** 判据是 tool_result 存在且非 error：
        //   · 本次调用（hook 触发时 tool_use 已落盘、还没 result）→ 不算；
        //   · 被闸门拒掉的写（result 是 is_error:true，文件从未写）→ 不算；
        //   · 真正写成了的 → 算。
        // 前两条正是 2026-11-19 验收判 FAIL 的那两条（见函数头 §两次修正）。
        //
        // **这里只登记 id，不做加法。** 回扫是**从尾向前**的，而 `tool_use` 与它的
        // `tool_result` 可以隔着几百行（真实语料里有重复副本行与 thinking 块隔着）。
        // 边扫边加会出现这种顺序依赖：右块先处理到写调用、它的 result 还在 `carry`
        // 里没解析 → 不加；等左块解析到 result 时，那个 `tool_use` 已被 `seenIds`
        // 判成重复而跳过 → 这笔**永远不加**。实测 5.93 MB 会话：单块 86 / 分块 85。
        // 结算放到循环之后（见 `readTranscriptActivity()` 尾部），与块序无关。
        const id = typeof b.id === 'string' ? b.id : '';
        if (id) acc.writeIds.add(id);
      }
    }
  }
}

/** `JSON.parse` 一行，坏行返回 null（调用方决定怎么记）。 */
function parseLine(line) {
  const s = typeof line === 'string' ? line.trim() : '';
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/** 记一个问题（按归一化文本去重）。空键直接丢弃 —— 空白问题不是问题。 */
function recordQuestion(out, acc, key, text) {
  if (!key || acc.seenQ.has(key)) return;
  acc.seenQ.add(key);
  out.questions.push(text);
}

/** 哪些工具名算「一次提问」。**这一处就是唯一口径**，`question-audit.mjs` 的
 *  `scanSession()` 也用它，两处不再各写一份（2026-11-19 统一）。
 *
 *  为什么 `ExitPlanMode` 算：它是「我停下来等你批准」，与提问在**判据语义**上同类
 *  （都代表模型主动停下来要人做决定）。用户原话要防的是「一句话都没问就开始写」，
 *  计划批准同样打破了那句话。 */
export function isAskToolName(name) {
  return name === 'AskUserQuestion' || name === 'ExitPlanMode';
}

/** 有界从尾部读：读文件末尾 `bytes` 字节之前 `fromEnd` 字节处的窗口。
 *  返回 `{buf, bytesRead, size}` 或 null。`size` 是文件总大小。
 *
 *  与 `readTailBytes` 的唯一区别是多了 `fromEnd`（回扫用）与 `size`（判「读到文件头没有」）。
 *  合成一个函数而不是写两份 readSync 循环：两份循环就是两个 bug 位。 */
function readTailBytesFrom(p, bytes, fromEnd = 0) {
  let fd = null;
  try {
    fd = openSync(p, 'r');
    const size = fstatSync(fd).size;
    const end = Math.max(0, size - Math.max(0, Number(fromEnd) || 0));
    const want = Math.max(0, Math.min(end, Number(bytes) || 0));
    if (!want) return { buf: Buffer.alloc(0), bytesRead: 0, size };
    const start = end - want;
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return { buf: got === want ? buf : buf.subarray(0, got), bytesRead: got, size };
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 有界从尾部读最后 `bytes` 字节。返回 `{buf, bytesRead, size}` 或 null。
 *
 *  **只是 `readTailBytesFrom(p, bytes, 0)`**：不要在这里再写一份 `readSync` 循环。
 *  两份循环就是两个 bug 位，而这两条路径（读侧判据 / 写侧判据）必须从同一个
 *  「怎么从文件尾读一段」的实现出发，否则窗口边界行为迟早会分叉。
 *
 *  `size` 是**文件总大小**（不是读了多少）：调用方靠它判断「尾部窗口之外还有没有东西」。
 *  没有它就只能猜 —— 而「猜不到就不判」和「以为读完了所以判」是两种完全不同的结论。 */
function readTailBytes(p, bytes) {
  return readTailBytesFrom(p, bytes, 0);
}

// ── 标记文件 ─────────────────────────────────────────────────────────

/** 密钥长度（字节）。32 字节 = 256 位，用 `randomBytes` 生成，不依赖任何常量。 */
const SECRET_BYTES = 32;

/** 标记路径 → 会话 cwd。`<cwd>/.claude/.ow-read-done` 上两级就是 cwd。 */
function cwdOfMarker(markerPath) {
  const p = String(markerPath || '');
  return p ? dirname(dirname(p)) : '';
}

/** 读密钥。**只读，不生成** —— 校验路径不该有副作用。
 *  密钥必须是 `[0-9a-f]` 长串：坏内容（被写成一句玩笑、被截断）一律当没有。 */
export function readGateSecret(secretPath) {
  const p = String(secretPath || '');
  if (!p || !existsSync(p)) return null;
  try {
    const s = readFileSync(p, 'utf8').trim();
    return /^[0-9a-f]{32,128}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** 读密钥，没有就生成。**这是唯一会创建密钥的地方**，只在真要写 `auto` 标记时调用。
 *
 *  并发：两个会话同时首次运行会各写一份，后写的赢；所以写完**重读一次**，
 *  以盘上那份为准 —— 否则签名用的密钥和下次校验用的不是同一份，标记会立刻失效。 */
export function ensureGateSecret(secretPath) {
  const existing = readGateSecret(secretPath);
  if (existing) return existing;
  const p = String(secretPath || '');
  if (!p) return null;
  try {
    mkdirSync(dirname(p), { recursive: true });
    const s = randomBytes(SECRET_BYTES).toString('hex');
    writeFileSync(p, s + '\n', { mode: 0o600 });
    return readGateSecret(p) || s;
  } catch {
    return null;
  }
}

/** 签名字符串。字段顺序写死在一处 —— 两处各写一份就是分叉的起点。
 *
 *  签的字段**包含** `reads` / `reads_sample` / `verified_at`：改任何一个都会让签名失效，
 *  所以「写一个 `{"satisfied_by":"auto","reads":99}` 进去」不再等于「验过了 99 个」。 */
export function markerSigOf(data, secret) {
  const d = data && typeof data === 'object' ? data : {};
  const sample = Array.isArray(d.reads_sample) ? d.reads_sample.join('\n') : String(d.reads_sample || '');
  const parts = [
    Number(d.version) || 0,
    String(d.session_id || ''),
    String(d.at || ''),
    Number(d.reads) || 0,
    String(d.verified_at || ''),
    sample,
    String(d.prompt_id || ''),
  ];
  return createHmac('sha256', String(secret)).update(parts.join('\u0000')).digest('hex');
}

/** 校验签名。`secret` 为空（密钥文件不存在 / 读不出）时**一律 false** ——
 *  这条是刻意的：宁可让 `auto` 标记失效退回「查 transcript」，也不要让「没有密钥」
 *  变成「谁写的都算」。 */
export function verifyMarkerSig(data, secret) {
  const sec = typeof secret === 'string' ? secret : '';
  if (!sec) return false;
  const sig = data && typeof data.sig === 'string' ? data.sig : '';
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const want = markerSigOf(data, sec);
  try {
    return timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

/** 读标记。返回 `{exists, data, error}`。坏 JSON 视为「存在但不合法」，由 `markerValidity` 判。 */
export function readMarker(markerPath) {
  const p = String(markerPath || '');
  if (!p || !existsSync(p)) return { exists: false, data: null, error: null };
  try {
    const raw = readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { exists: true, data: null, error: 'not-an-object' };
    }
    return { exists: true, data, error: null };
  } catch (e) {
    return { exists: true, data: null, error: String((e && e.message) || e).slice(0, 120) };
  }
}

/** 写标记。`satisfied_by` 把「验出来的」和「自述的」分开，这是事后审计的唯一依据。
 *
 *  `satisfied_by:"auto"` 必然带签名；**签不出来就不写**（返回 null），
 *  因为一个验不过的 `auto` 标记比没有标记更糟：它会让盘上看起来「已满足」。
 *  `claim` 不签 —— 它本来就是自述，签了反而会让人误读成「验出来的」。 */
export function writeMarker(markerPath, {
  sessionId = '', satisfiedBy = 'claim', reads = 0, promptId = '', readsSample = null,
  nowMs = Date.now(), secret = null,
} = {}) {
  const p = String(markerPath || '');
  if (!p) return null;
  const auto = satisfiedBy === 'auto';
  let sec = null;
  if (auto) {
    sec = String(secret || '') || ensureGateSecret(secretPathFor(cwdOfMarker(p)));
    if (!sec) return null;
  }
  const at = new Date(nowMs).toISOString();
  const data = {
    version: 1,
    session_id: String(sessionId || ''),
    at,
    satisfied_by: satisfiedBy,
    reads: Number(reads) || 0,
    prompt_id: String(promptId || ''),
  };
  if (auto) {
    data.verified_at = at;
    if (Array.isArray(readsSample) && readsSample.length) data.reads_sample = readsSample.slice(0, 5);
    data.sig = markerSigOf(data, sec);
  }
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
    return data;
  } catch {
    return null;
  }
}

/** 标记算不算数。
 *
 *  默认**绑定 session**：标记是「这个 AI 读过这个项目」的断言，换一个会话就是一个没读过
 *  项目的新 AI。`crossSession=true` 时放宽成「这个目录曾经有人读过」。
 *  `satisfied_by` 原样带出来，`deny`/`allow` 的日志里都留着。
 *
 *  **标记里没有 session_id 时判无效**，这一条是刻意选的严格方向。曾经的写法是「没写
 *  session 就当作通配」，那会在盘上留一个永久有效的标记：本会话建过一次，之后**每一个**
 *  新会话都被静默放行 —— 闸门从此形同不存在，而且日志里看起来一切正常。宁可让一条
 *  没有 session 的标记失效（AI 会照 reason 重跑一次带 `--session` 的命令），
 *  也不要留一个悄悄失效的闸门。
 *
 *  **`satisfied_by:"auto"` 必须带合法签名**（见 `verifyMarkerSig`）。密钥由调用方通过
 *  `state.secret` 传入 —— `decide()` 保持纯函数，不自己读盘。`claim` 不需要签名。 */
export function markerValidity(state, input, cfg = defaultConfig()) {
  const m = state && state.marker ? state.marker : { exists: false, data: null };
  if (!m.exists) return { valid: false, why: 'missing', by: null, data: null };
  const d = m.data;
  if (!d) return { valid: false, why: 'unparsable', by: null, data: null };
  const by = typeof d.satisfied_by === 'string' ? d.satisfied_by : 'unknown';
  const sid = String((input && input.session_id) || '');
  const msid = String(d.session_id || '');
  if (!msid) return { valid: false, why: 'marker-without-session', by, data: d };
  // 会话先判：换会话是更严重的问题，不该被「签名对了」盖过去。
  if (cfg.crossSession) return finish(markerSigCheck(state, d, by));
  if (!sid) return { valid: false, why: 'no-session-in-input', by, data: d };
  if (msid !== sid) return { valid: false, why: 'other-session', by, data: d };
  return finish(markerSigCheck(state, d, by));

  /** `satisfied_by` 只认两个值；`auto` 还要过签名。 */
  function markerSigCheck(st, data, kind) {
    if (kind !== 'auto' && kind !== 'claim') {
      return { valid: false, why: 'unknown-satisfied-by', by: kind, data };
    }
    if (kind === 'claim') return { valid: true, why: 'same-session', by: kind, data };
    const sec = st && typeof st.secret === 'string' ? st.secret : null;
    if (!sec) return { valid: false, why: 'auto-no-secret', by: kind, data };
    if (!verifyMarkerSig(data, sec)) {
      return { valid: false, why: data && data.sig ? 'auto-bad-signature' : 'auto-unsigned', by: kind, data };
    }
    return { valid: true, why: 'same-session', by: kind, data };
  }
  function finish(v) {
    if (v.valid && cfg.crossSession) return { valid: true, why: 'cross-session-allowed', by: v.by, data: v.data };
    return v;
  }
}


// ── reason：必须是可执行的指令链，不能是「请先了解项目」 ────────────────

/** 生成 reason。**唯一要求**：模型读完这一段就知道下一条命令该敲什么。
 *
 *  实测依据：reason 原文会作为 `is_error` 的 `tool_result` 内容回到模型（B1/D4）。
 *  所以它是一段 prompt，不是一条错误消息。
 *
 *  ## `halt` 下第 3 步的文案必须换（2026-11-19，验收第 5 条）
 *
 *  原实现两种刹车下都用「创建标记，然后**原样重试**你刚才那次写」，然后在 `halt`
 *  分支追加「本次拒绝同时结束了本回合」。两句在 `halt` 下**互相否定**：回合都结束了，
 *  没有「刚才那次写」可以重试。与 `reasonForQuestions()` 是同一个病，同一处修。
 *
 *  修法：`halt` 时第 3 步只说「创建标记」（那条命令仍然有效、仍然该跑），
 *  并明确「本回合已结束，不会有重试」。`budget` 时才说「然后重试这次写」。 */
export function reasonFor({ cwd, markerPath, gateCommand, minReads, halt, denialCount, maxDenials }) {
  const c = String(cwd || '.');
  const need = Number(minReads) || 3;
  const lines = [
    `[overwatch] 写前闸：你还没读过这个项目，所以这次写入被拒绝。`,
    ``,
    `在写任何文件之前，按顺序做完这三步：`,
    `1. 读 ${c}/CLAUDE.md（若不存在则跳过）、${c}/README.md，`,
    `   以及至少 ${Math.max(0, need - 2)} 个源码文件（用 Read，不要用 Bash cat）。这算「读过项目」。`,
    `2. 若有你还不确定的点，用 AskUserQuestion 一次问清（最多 5 个）；没有就跳过这步。`,
    halt
      ? `3. 创建标记（这条命令本身仍然有效）：`
      : `3. 创建标记，然后重试你刚才那次写：`,
    `   ${gateCommand}`,
    ``,
    `标记一旦存在，本会话后续的写不会再被拦。`,
    `注意：不要绕过闸门（用 shell 重定向、Set-Content、或者直接写标记文件都不算读过）。`,
    `标记里记着它是「验出来的」（satisfied_by:"auto"，必须有闸门自己签的 sig）还是`,
    `「自己说的」（"claim"，一条自述）—— 两者事后都查得到；手写的 "auto" 标记会被拒。`,
  ];
  if (halt) {
    // 面向**用户**，不是模型：这一回合已经结束，模型拿不到下一轮。
    lines.push(
      ``,
      `── 本回合已结束 ──`,
      `这条拒绝带 \`continue:false\`（宿主对 PreToolUse 拒绝**没有次数上限**，不刹车会无限重试），`,
      `所以本回合已经停了，不会有「重试这次写」。下一步由**你（用户）**决定：`,
      `重新发一句话，或在会话里先跑上面第 3 步的命令。`,
      `想关掉这道闸：把 \`ask.minQuestionsBeforeWrite\` 改回 0、设 \`OW_ASK_MIN_QUESTIONS=0\`、`,
      `或建 PAUSE 文件（与 Stop 闸共用，见 docs/CAPABILITIES.md §3.5）。`,
    );
  } else if (denialCount > 0) {
    lines.push(``, `这是本回合第 ${denialCount + 1}/${maxDenials} 次拒绝；到上限后本回合会被强制结束。`);
  }
  return lines.join('\n');
}

/** 「先问够 N 个问题」这条判据的 reason。**同样是可执行指令链，不是建议。**
 *
 *  与 `reasonFor()` 的关系：两条判据各有各的失败原因，混成一段会让模型
 *  分不清现在该干什么（读文件？还是问问题？）。所以文案分开、格式一致。
 *
 *  ## 两种刹车下文案必须不同（2026-11-19，验收第 5 条）
 *
 *  原本文案在两种模式下写同一句话，结果自相矛盾：既说「**原样重试**你刚才那次写」，
 *  又说「本次拒绝**同时结束了本回合**」。`halt` 下这两句不可能同时成立 ——
 *  回合已经结束，没有「刚才那次写」可以重试；用户要做的**是重新发一句话**。
 *  这是「给出做不到的指令」，与第 6 条同一个病。
 *
 *  所以：
 *    · `halt=true`  → 面向**用户**：这一回合已经停了，你能做的是重新发一句话
 *      （或先跑 status 看生效值）。**不提「重试」**，因为不存在可重试的东西。
 *    · `halt=false` → 面向**模型**：本回合还活着，问完之后重试这次写，闸门会重新数。
 *
 *  另外两条被删掉的：
 *    · 「若你确实认为没有需要问的，就明说理由，然后重试」—— 重试必然再被拒
 *      （判据只看 transcript 里的问题数，不看理由），那是一条**永远失败**的指令。
 *    · 「会在 reason 里留下这一条，事后可审计」—— 没有落地物。日志当时只记
 *      `reasonLen`，reason 原文根本没进台账。现在改成实话：日志记的是
 *      **判据的读数**（`questions` / `priorWrites` / `denyBy`），不是你的理由。
 *
 *  `have` 是去重后已有的问题数。 */
export function reasonForQuestions({ cwd, need, have, halt, denialCount, maxDenials }) {
  const needN = Math.max(1, Number(need) || 1);
  const haveN = Math.max(0, Number(have) || 0);
  const miss = Math.max(0, needN - haveN);
  const c = String(cwd || '.');
  const lines = [
    `[overwatch] 写前闸：本会话还没问够问题，所以这次写入被拒绝。`,
    ``,
    `配置要求：第一次写文件之前，至少问过 ${needN} 个**不同**的问题（\`ask.minQuestionsBeforeWrite\`）。`,
    `现在数到 ${haveN} 个（同一个问题重复问只算 1 个），**还差 ${miss} 个**。`,
    ``,
    `为什么有这条：开头需求一旦模糊，做完才发现方向不对就是白费力气。`,
    `问什么才有用 —— 只问那些**答案会改变你接下来怎么写**的事，不要问能自己从仓库里读出来的：`,
    `  · 范围：这次改哪些文件 / 明确不碰哪些（「顺带一起改」是最常翻车的一类）。`,
    `  · 取舍：两个都能做时选哪个，以及为什么（不要替用户选，也不要两个都做）。`,
    `  · 验收：用户怎么判断「这就算做完了」—— 要跑哪条命令、看哪个输出。`,
    `  · 反例：用户已经明确说过的，别再问一遍；那是浪费他的一次回答。`,
    ``,
    `做法：用 AskUserQuestion 一次问 ${miss} 个（一次调用里放多个问题算多个）。`,
  ];
  if (halt) {
    // 面向用户。**不许出现「重试」**：本回合已经结束，没有可重试的东西。
    lines.push(
      ``,
      `── 本回合已结束 ──`,
      `这一条拒绝带 \`continue:false\`，所以本回合已经停了，不会有人「重试」这次写`
      + `（宿主对 PreToolUse 拒绝没有次数上限，不刹车会无限重试）。`,
      `接下来由**你（用户）**决定：`,
      `  · 直接在下一条消息里把要求说清楚（这就是这条判据想要的结果）；或`,
      `  · 想先确认生效值，跑「看生效值」那条命令（见下方）。`,
      ``,
      `如果你认为这条判据不该开：把 overwatch.config.json 的 \`ask.minQuestionsBeforeWrite\` 改回 0，`
      + `或临时设 \`OW_ASK_MIN_QUESTIONS=0\`。`,
      `想让闸门暂停而不改配置：建一个 PAUSE 文件（与 Stop 闸共用，路径见 docs/CAPABILITIES.md §3.5），存在即放行。`,
      ``,
      `审计说明：台账里记的是**判据的读数**（本次数到 ${haveN} 个问题、要求 ${needN} 个、`
      + `拒绝原因 questions），不是任何人的理由。`,
    );
  } else {
    // 面向模型。回合还活着，问完可以重试这次写。
    lines.push(
      ``,
      `然后重试你刚才那次写 —— 闸门会自己从 transcript 重新数，不需要跑任何命令。`,
      `注意：本闸不会因为「你觉得不需要问」而放行（判据只数 transcript 里的问题个数，`
      + `不看理由），所以别把「说明理由」当成一条出路。`,
      ``,
      `审计说明：台账里记的是**判据的读数**（本次数到 ${haveN} 个问题、要求 ${needN} 个、`
      + `拒绝原因 questions），不是任何人的理由。`,
    );
    if (denialCount > 0) {
      lines.push(``, `这是本回合第 ${denialCount + 1}/${maxDenials} 次拒绝；到上限后本回合会被强制结束。`);
    }
  }
  if (c && c !== '.') lines.push(``, `会话目录：${c}`, `看生效值：node scripts/pre-write-gate.mjs status --cwd "${c}"`);
  return lines.join('\n');
}

// ── 判定（纯函数）────────────────────────────────────────────────────

/** 判定一次 PreToolUse。**纯函数**：不读盘、不写盘、不读环境变量。
 *
 *  返回 `{action, output, markWrite, log}`：
 *    · `action`     `passthrough` | `allow` | `warn` | `deny`
 *    · `output`     要写到 stdout 的 JSON 对象；`passthrough` 时为 `null`（什么都不输出）
 *    · `markWrite`  `{satisfiedBy, reads, promptId}` 或 `null`；由 `runHook` 落盘
 *    · `log`        一行记账，永远是对象
 *
 *  ## 为什么 action 不直接叫 `deny`/`allow`
 *  「不输出」与「输出 allow」在宿主上不等价：前者是「本 hook 不参与」，后者会参与
 *  `deny>ask>allow` 的合并（实测二进制逻辑）。多个 hook 并存时，静默才是对的。 */
export function decide(input, state = {}) {
  const cfg = state.config || defaultConfig();
  const log = { at: new Date().toISOString(), mode: cfg.mode, brake: cfg.brake };
  const passthrough = (reason, extra = {}) => ({
    action: 'passthrough', output: null, markWrite: null,
    log: { ...log, decision: 'passthrough', allowReason: reason, ...extra },
  });

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return passthrough('unparsable-input');
  }
  if (input.hook_event_name && input.hook_event_name !== 'PreToolUse') {
    return passthrough('wrong-event', { event: String(input.hook_event_name) });
  }

  const tool = String(input.tool_name || '');
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : null;
  const cwd = String(input.cwd || state.cwd || process.cwd());
  const markerPath = state.markerPath || markerPathFor(cwd);
  const intent = writeIntentOf(tool, ti, cwd);
  const secretPath = state.secretPath || secretPathFor(cwd);

  log.tool = tool;
  log.via = intent.via;
  log.unresolved = intent.unresolved;

  if (!intent.isWrite) {
    // 未知工具 / 只读命令 / 建目录 —— 不参与。「unknown-tool」单独留名，
    // 因为 matcher 与宿主工具名漂移时会从这里看出来。
    const why = intent.via === 'none' ? 'unknown-tool'
      : (intent.dirs > 0 && !intent.paths.length ? 'dir-only' : 'not-a-write');
    return passthrough(why, { dirs: intent.dirs });
  }
  log.paths = intent.paths.slice(0, 5);

  // 密钥文件本身**不**走 `gate-own-file`：那是「闸门自己的文件，否则自锁」白名单，
  // 而密钥一旦可写，签名就等于不存在。改密钥 = 改判据，必须报出来。
  if (intent.paths.length && intent.paths.every((p) => pathKeyOf(p) === pathKeyOf(secretPath))) {
    return passthrough('secret-tamper', { secretPath });
  }

  // 闸门自己的文件必须放行，否则标记永远写不出来（自锁）。
  if (intent.paths.length && intent.paths.every((p) => isGateOwnedPath(p, cwd))) {
    return passthrough('gate-own-file');
  }

  const mv = markerValidity(state, input, cfg);
  log.marker = mv.why;
  log.markerPath = markerPath;

  if (mv.valid) {
    return {
      action: 'allow', output: null, markWrite: null,
      log: { ...log, decision: 'allow', allowReason: 'marker-present', satisfiedBy: mv.by },
    };
  }

  // (b) 主路：transcript 里已经读过够多的文件 → 自己写标记并放行。
  // 注意「够多」不是「尝试过」：数的是**不同文件路径**，读同一个文件 50 次也只算 1 个。
  //
  // `state.reads` 可以是数组（测试注入），也可以是函数（`runHook` 注入，**惰性**读盘）。
  // 惰性的理由：标记在盘上时根本不需要 transcript；只有正要拒绝时才值得花那次读。
  const reads = typeof state.getReads === 'function'
    ? (state.getReads() || [])
    : (Array.isArray(state.reads && state.reads.paths) ? state.reads.paths : []);
  log.reads = reads.length;

  // ── 判据零（`ask.minQuestionsBeforeWrite`）：第一次写之前先问够 N 个问题 ────────
  //
  // 安排在这里的三条理由，每条都是判据的一部分，不是实现细节：
  //
  //   ① **在 `markerValidity` 之后**。标记存在 = 这个会话已经过闸（或显式跑了
  //      `mark` 逃生口）。逃生口的意义就是「我知道我在干什么」；再拿提问去堵它，
  //      等于把逃生口拆掉 —— 而这个闸的失效方向必须是「能干活」。
  //   ② **在两条读侧判据之前**。它是**独立**的第二道闸：读够了不等于问对了。
  //      两条判据各自 deny、各自给 reason，混在一起模型会不知道先做哪件事。
  //   ③ **`minQuestionsBeforeWrite === 0` 时整个分支不存在** —— 连
  //      `state.getActivity` 都不许调（测试里用一个会抛异常的函数钉住了这一点）。
  //      这是「默认值不破坏现有用户」这条硬要求的**唯一**可验证形态：
  //      不是看代码里有没有 `if`，而是看那条读盘路径有没有被走到。
  //
  // 只判**第一次写**：`priorWriteCalls > 0` 直接跳过。写到一半才拦会打断正在进行的活，
  // 而这条判据要防的是「开头方向就错了」，那时候还什么都没写。
  //
  // **`priorWriteCalls` 的定义改过两次**（2026-11-19，验收判 FAIL 后）：现在它只数
  // 「有非 error 的 `tool_result` 的写」。原来把「本次调用自身」（hook 触发时已落进
  // transcript、还没 result）与被闸门拒掉的写（result 是 `is_error:true` 但文件没写）
  // 都算成了「之前写过」—— 前者让判据一次都不执行，后者让「拒 → 重试」把判据自己解除。
  // 见 `readTranscriptActivity()` §两次修正。
  const needQ = Number(cfg.minQuestionsBeforeWrite) || 0;
  let askGate = null;   // `null` = 这条判据不参与；否则是 `{need, have, miss, unknown}`
  // ── L1 叫停路径：排在**这条判据**的所有分支之前 ───────────────────────
  //
  // 复用 `stop-verify-hook.mjs` 的 `pausedPathOf()` / `pausePathsFor()`（`isPaused()` 是
  // 它的布尔投影），不新造一个开关：
  //   · 造第二个 PAUSE 文件等于要求用户记住两个路径，而他只会在被锁住时才发现第二个也在；
  //   · `check-structure.mjs` 的 `checkStopHookKillSwitch()` 已经在守「默认开启的强拦
  //     必须有可调用的叫停路径」；复用同一个函数，本闸自动落在那条规则的覆盖范围内。
  //
  // **刻意放在 `needQ > 0` 之内，而不是放在 `decide()` 的最前面。** 放在最前面会让
  // `minQuestionsBeforeWrite = 0` 的现有用户在 PAUSE 文件存在时行为改变（本闸从
  // 「照常判」变成「一律放行」）—— 而「0 时逐字节不变」是这次改动的硬要求。
  // 一个默认关闭的判据不许顺带改掉别人已有的行为，哪怕方向是「更宽松」。
  if (needQ > 0 && state.paused === true) {
    // `pauseHit` = 真命中的那一条候选路径（`DF-041`）。只报主路径的话，
    // 「我把 PAUSE 放在 UntilDone 里了」和「它命中的是 Overwatch 那份旧文件」分不开。
    return passthrough('user-paused', { pausePath: state.pauseHit || state.pausePath || null });
  }

  // ── 子 agent 不参与这条判据（2026-11-19，验收第 6 条）──────────────────
  //
  // **为什么直接放行，而不是「让子 agent 也去问」**：
  //
  //   ① 多数子 agent 的 `tools:` 白名单里**没有** `AskUserQuestion`
  //      （`.claude/agents/oversight-executor.md` / `oversight-repair.md` 都是
  //      `Read, Write, Edit, Bash, Glob, Grep`）。被拒之后它**物理上做不到** reason
  //      要求的事，而 `brake="halt"` 会直接结束回合 —— 子 agent 的工作永远不会完成。
  //      这是「给出做不到的指令」，比不拦更糟。
  //   ② 就算某个 agent 有提问工具，它的提问也不该由这里判：子 agent 的输入不是用户
  //      直接给的，所谓「开头需求模糊」在派发那一刻就由主线程决定了。
  //   ③ 判据的可观测性在这里是断的：子 agent 的调用 `transcript_path` 指向**主**
  //      transcript（实测见 `docs/research/2026-11-14-widened-evidence-sources.md` §4.2），
  //      所以「这个子 agent 问过几个问题」在主 transcript 里根本数不出来。
  //      拿主 transcript 的计数去判一个子 agent 的第一次写，判的是别人的账。
  //
  // 识别方式：宿主在 stdin 里给 `agent_id`（且只对子 agent 调用给）。字段缺失 =
  // 主线程调用，照常判。**不存在中间态**，所以不需要额外配置。
  //
  // 注意这条**只**豁免提问判据，不豁免读侧判据：读侧判据对子 agent 的失效方向是
  // 「多读几个文件就过」，而它本来就打算读 —— 那不是硬锁。
  const isSubagent = Boolean(input.agent_id);
  if (needQ > 0 && isSubagent) {
    log.questions = 'subagent-exempt';
    log.agentId = String(input.agent_id).slice(0, 40);
  } else if (needQ > 0) {
    const act = typeof state.getActivity === 'function'
      ? state.getActivity()
      : (state.activity && typeof state.activity === 'object' ? state.activity : null);
    if (!act || act.unreadable === true) {
      // 读不到 transcript / 没有这条数据 = **不知道**，而不知道不许判。
      // 与整个闸的 fail-open 一致：这条判据的失效方向只能是「不拦」。
      log.questions = 'unavailable';
    } else {
      log.questions = Number(act.distinctQuestions) || 0;
      log.questionsUnknown = Number(act.unknownAskCalls) || 0;
      log.priorWrites = Number(act.priorWriteCalls) || 0;
      // 形态不可读的提问（`questions` 是坏 JSON）不参与：不知道就不许判。
      // 一条都问不出来、却有不可读的调用 —— 说明它是问过的，只是我们读不懂。
      if (Number(act.unknownAskCalls) > 0 && Number(act.distinctQuestions) === 0) {
        log.questions = 'unknown-form';
      } else if (Number(act.priorWriteCalls) > 0) {
        // 已经**写成过**（不是「发起过」、不是「被拒过」）—— 这条判据不再介入。
        // `log.questions` 留着，方便事后分桶。
        log.questions = Number(act.distinctQuestions) || 0;
      } else if (act.truncated === true) {
        // **有没扫到的内容**：回扫到上限仍不够数。这种情况下 `have` 是「至少这么多」，
        // 不是真值 —— 拿它去拦就是拿「没读到」当「没问过」（修正三）。
        // 所以不判，并把这件事记进日志：它不是正常放行，是被迫放行。
        log.questions = `truncated-after-${Number(act.chunks) || 0}-chunks`;
        log.scanTruncated = true;
      } else {
        const have = Number(act.distinctQuestions) || 0;
        if (have < needQ) askGate = { need: needQ, have, miss: needQ - have };
      }
    }
  }

  if (askGate) {
    const commonQ = {
      cwd, need: askGate.need, have: askGate.have,
      denialCount: Number(state.denials) || 0,
      maxDenials: Number(state.denyBudget) || 0,
    };
    const stopReasonQ = '[overwatch] pre-write gate: 第一次写文件前没问够问题，已拒绝并结束本回合。';
    if (cfg.mode === 'observe') {
      return {
        action: 'passthrough', output: null, markWrite: null,
        log: {
          ...log, decision: 'would-deny', allowReason: 'observe-mode',
          denyBy: 'questions', reason: reasonForQuestions({ ...commonQ, halt: false }),
        },
      };
    }
    if (cfg.mode === 'warn') {
      return {
        action: 'warn',
        output: {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            additionalContext: reasonForQuestions({ ...commonQ, halt: false }),
          },
        },
        markWrite: null,
        log: { ...log, decision: 'warn', allowReason: 'warn-mode', denyBy: 'questions' },
      };
    }
    // deny。刹车策略与另一条判据**共用同一份** `brake` / `denyBudget` / 计数器 ——
    // 不新造机制，也不给它单独一份预算：用户设的「这个回合最多拦几次」说的是整个闸。
    const haltQ = cfg.brake === 'halt'
      || (Number(state.denials) || 0) >= (Number(cfg.denyBudget) || 0);
    const reasonQ = reasonForQuestions({ ...commonQ, halt: haltQ });
    const outputQ = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reasonQ,
      },
    };
    if (haltQ) {
      outputQ.continue = false;
      outputQ.stopReason = stopReasonQ;
    }
    return {
      action: 'deny', output: outputQ, markWrite: null,
      log: {
        ...log, decision: 'deny', halted: haltQ, satisfiedBy: null,
        // `reason` 原文进台账：这里**必须**有落地物。「事后可审计」若能指到这个字段
        // 才是真的；只记 `reasonLen` 的时候那句话是空的（2026-11-19，验收第 5 条）。
        // 台账在 `tasks/runs/`（gitignored、本机），所以 reason 里的绝对路径不外泄。
        denyBy: 'questions', reason: reasonQ, reasonLen: reasonQ.length,
      },
    };
  }

  // ── 判据一（Edit 侧）：改**已有**文件时，判据换成「读过这个文件本身」。 ──────────
  //
  // 实测（`node scripts/resolution-gate-audit.mjs --only R8`）：真实项目 18/18 个 Edit-first
  // 会话都在改之前读过目标文件，而「读过 ≥3 个不同文件」仍误拦其中 4 个 —— 这 4 个**全都**
  // 读过自己的目标。误伤是纯损失，所以换锚点。
  //
  // 本机复算（`observe-reality-check.mjs` 的 analyzeOne，435 份 transcript）：
  //   真实 Edit-first 18 个：targetRead 18 · reads≥3 且**没**读目标 0 个
  //   沙箱 Edit-first  8 个：targetRead  7 · reads≥3 且**没**读目标 0 个
  // 也就是说「读过几个」在 Edit 侧**一次都没单独起过作用** —— 两种读法在现有语料上等价，
  // 而换锚点后 4 个误伤归零。代价是把「读了 3 个无关文件就改一个没读过的文件」也拦下，
  // 这一条与宿主自己的 Edit 门一致（它同样对「改一个没读过的既有文件」报错），是**更严**、不是更松。
  //
  // 安全兜底：任何通过的 `Write` 都会落标记（`auto` 或 `claim`），所以「先写新文件、再 Edit 它」
  // 走的是 `marker-present`，不会掉进这一支。
  //
  // **不写标记**：它只证明「这一个文件读过」，不证明「读过这个项目」。
  const editSide = EDIT_SIDE_TOOLS.includes(tool);
  const targetKeys = editSide ? new Set(reads.map(pathKeyOf).filter(Boolean)) : null;
  const hitTarget = targetKeys
    ? intent.paths.map(pathKeyOf).filter((k) => k && targetKeys.has(k))
    : [];
  if (hitTarget.length) {
    return {
      action: 'allow', output: null, markWrite: null,
      log: {
        ...log, decision: 'allow', allowReason: 'target-read',
        satisfiedBy: null, target: hitTarget[0],
      },
    };
  }

  // 判据二（Write / shell 侧）：行为**一行未改** —— 仍是「读过 ≥minReads 个不同文件」。
  // `editSide` 显式排除它，否则「读了 5 个无关文件」会被这条放行，Edit 侧就等于没改。
  if (!editSide && cfg.minReads > 0 && reads.length >= cfg.minReads) {
    return {
      action: 'allow',
      output: null,
      markWrite: { satisfiedBy: 'auto', reads: reads.length, promptId: String(input.prompt_id || ''), readsSample: reads.slice(0, 5) },
      log: {
        ...log, decision: 'allow', allowReason: 'auto-satisfied-by-transcript',
        satisfiedBy: 'auto', readSample: reads.slice(0, 5),
      },
    };
  }

  const common = {
    cwd, markerPath,
    minReads: cfg.minReads,
    denialCount: Number(state.denials) || 0,
    maxDenials: Number(state.denyBudget) || 0,
  };
  const gateCommand = state.gateCommand
    || `node ${join(REPO_ROOT, 'scripts', 'pre-write-gate.mjs')} mark --session ${String(input.session_id || '<session_id>')}`;

  if (cfg.mode === 'observe') {
    return {
      action: 'passthrough', output: null, markWrite: null,
      log: { ...log, decision: 'would-deny', allowReason: 'observe-mode', reason: reasonFor({ ...common, gateCommand, halt: false }) },
    };
  }

  if (cfg.mode === 'warn') {
    // 实测：PreToolUse 的 additionalContext 只注入一次，不引发循环（G2）。
    // 所以「提醒但不拦」这一档有宿主行为支撑，不是我们编的。
    return {
      action: 'warn',
      output: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: reasonFor({ ...common, gateCommand, halt: false }),
        },
      },
      markWrite: null,
      log: { ...log, decision: 'warn', allowReason: 'warn-mode' },
    };
  }

  // deny。刹车策略决定要不要 continue:false（硬约束 ②）。
  const halt = cfg.brake === 'halt' || (Number(state.denials) || 0) >= (Number(cfg.denyBudget) || 0);
  const reason = reasonFor({ ...common, gateCommand, halt });
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  if (halt) {
    // 顶层 continue:false —— G4 实测「一轮即停」。
    output.continue = false;
    output.stopReason = '[overwatch] pre-write gate: 未读项目就写文件，已拒绝并结束本回合。';
  }
  return {
    action: 'deny', output, markWrite: null,
    log: { ...log, decision: 'deny', halted: halt, satisfiedBy: null, reason, reasonLen: reason.length },
  };
}

// ── 记账 ────────────────────────────────────────────────────────────

/** 记账文件路径。
 *
 *  优先级：`OW_PRE_WRITE_GATE_LOG`（显式覆盖，测试与试跑用它）→
 *  `OVERWATCH_STATE_DIR`（本仓脚本统一的临时区变量，硬门的探针会设它 ——
 *  否则「调用一次 export 看它炸不炸」就会真的往仓库里写一行日志）→
 *  **宿主机状态目录**的 `pre-write-gate/<日期>.jsonl`。
 *
 *  ## 最后一级为什么不再是 `REPO_ROOT/tasks/runs/`（2026-11-21 修）
 *
 *  那个默认值锚在**脚本位置**。而本闸被挂进的是**用户的项目**（模板里
 *  `CLAUDE_PROJECT_DIR` 是当前项目），于是它每次判一次写就往**框架仓库**里追加一行。
 *  在别人机器上那是把框架目录写脏；在本机那是用户项目的观测数据全进了另一个仓库。
 *
 *  闸门记账和 stop hook 的三处台账是同一类东西：**机器状态，不是项目内容**。
 *  它描述「这台机器上的闸门跑过什么」，换项目也该是同一条历史，所以住
 *  `state-dir.mjs` 管的状态目录（`%LOCALAPPDATA%/UntilDone/`）。
 *  目录解析**复用** `stop-verify-hook.mjs` 的 `ledgerRoot()`：同一个文件里两份
 *  「状态目录在哪」的判据必然漂移 —— 本仓为此付过账（`fmtDur`、宽度表、
 *  `readTailRecords`）。 */
export function logPathFor(env = {}, nowMs = Date.now()) {
  const override = String(env.OW_PRE_WRITE_GATE_LOG || '').trim();
  if (override) return override;
  const d = new Date(nowMs).toISOString().slice(0, 10);
  return join(ledgerRoot(env), 'pre-write-gate', `${d}.jsonl`);
}

export function appendLog(record, env = {}, nowMs = Date.now()) {
  const p = logPathFor(env, nowMs);
  try {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(record) + '\n');
    return true;
  } catch {
    return false;
  }
}

/** 读 / 推进「本回合已拒绝几次」的计数器。**只用于刹车**，绝不参与判定。 */
export function bumpDenials(path, promptId, { readOnly = false } = {}) {
  const key = String(promptId || '');
  let state = { prompt_id: key, n: 0 };
  try {
    if (existsSync(path)) {
      const cur = JSON.parse(readFileSync(path, 'utf8'));
      if (cur && cur.prompt_id === key) state = { prompt_id: key, n: Number(cur.n) || 0 };
    }
  } catch { /* 坏文件按 0 起算 */ }
  if (readOnly) return state.n;
  const next = { prompt_id: key, n: state.n + 1 };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next) + '\n');
  } catch { /* 记不上就退回 halt 语义由调用方处理 */ }
  return next.n;
}

// ── 组装：读盘 → decide → 写盘 ───────────────────────────────────────

/** 把一次 PreToolUse 从「输入对象」跑到「stdout 对象」。
 *
 *  副作用集中在这里：读标记、读 transcript、写标记、记账。`decide` 保持纯，
 *  所以判定逻辑可以被单测穷举。 */
export function runHook(input, { env = {}, nowMs = Date.now(), cwd: cwdOverride = null } = {}) {
  const cfg = configOf(env);
  const cwd = String((input && input.cwd) || cwdOverride || process.cwd());
  const markerPath = markerPathFor(cwd);
  const denialPath = denialPathFor(cwd);
  const secretPath = secretPathFor(cwd);
  const promptId = String((input && input.prompt_id) || '');

  // ── 同一次工具调用只判一次（`DF-029`）────────────────────────────────
  //
  // 两条注册（`.claude/settings.local.json` 与 `launch --settings`）叠加时，宿主会为
  // **同一次**工具调用起两个本进程，两者 stdin 逐字相同，`session_id + tool_use_id`
  // 也就相同 —— 用这个键做幂等认领（`hook-dedupe.mjs`；`O_EXCL` 原子创建，
  // 不是「先检查再创建」）。
  //
  // **认领必须在判定之前**，理由只有一条：`DF-029` 的第二个后果是延迟翻倍
  // （实测 190ms/次）。放在判定之后，重复进程照样读一遍 transcript，
  // 那一条就一点没修。放在判定之前，重复进程只花一两次文件系统调用。
  //
  // 于是有人会问：认领之后、输出之前崩了怎么办？那一次事件就没有任何 deny。
  // **这正是本 hook 本来就会做的事** —— `main()` 的 catch 与超时分支都是 exit 0
  // 无输出（fail-open）。所以重复进程的「静默」与认领进程崩溃时的结果**逐字相同**，
  // 没有引入新的失败形态。
  //
  // 键缺一段（比如没有 `tool_use_id`）时 `claimKeyOf` 返回 null、
  // `claimOnce` 拿到空键直接 `claimed:true` —— 放弃去重、照常判定。
  // 不拿半个键去猜「这是同一次事件」。
  const dedupeKey = claimKeyOf('pre-write-gate', [
    String((input && input.session_id) || ''),
    // 宿主 schema 里 `tool_use_id` 是 `PreToolUse` 的必填字段（实测契约见
    // `docs/research/2026-11-14-pretooluse-desktop-verification.md` §1）。
    String((input && input.tool_use_id) || ''),
  ]);
  const claim = claimOnce({ hookId: 'pre-write-gate', key: dedupeKey, env, nowMs });
  if (!claim.claimed) {
    recordSkipped({ hookId: 'pre-write-gate', key: dedupeKey, env, nowMs, why: claim.why });
    // 静默：不输出、不记账、不动刹车计数、不写标记。台账行数就是统计的分母，
    // 刹车计数直接决定第几次 deny 要 `continue:false` —— 这两处再记一次等于没修。
    return { action: 'passthrough', output: null, markWrite: null, duplicate: true, log: null };
  }

  // transcript 惰性读：标记在盘上就直接放行，那次读不该发生。
  //
  // **`cwd` 必须传进去**（`DF-027`）：transcript 里的 shell 路径是命令原文，
  // 常常是相对路径（`head -30 docs/CHANGELOG.md`），而 Edit 侧的目标是绝对路径。
  // 绝对化的基准只能是**会话目录**，而这个值只有 `runHook` 有（宿主在 stdin 里给）。
  // 放到 `decide()` 里归一化不行 —— 那里已经拿到的是两个各自成型的集合，
  // 少了「哪条相对路径是以谁为基准写下的」这个信息，只能猜。
  let cached = null;
  const getReads = () => {
    if (cached === null) {
      cached = (input && input.transcript_path)
        ? readTranscriptReads(input.transcript_path, { bytes: cfg.transcriptBytes, cwd }).paths
        : [];
    }
    return cached;
  };

  // 「问过几个问题 / 写过没有」——**同一个 transcript 尾部只读一次**。
  //
  // 与 `getReads` 合用一个 `cachedActivity`：`readTranscriptActivity()` 已经把
  // 「读过哪些文件」一并算出来了，所以两条判据都开的时候，读盘次数仍然是 1 次
  // 而不是 2 次。**这里不共用 `getReads` 的缓存对象**是有意的：两者的调用时机
  // 不同（`getReads` 在标记缺失时必被调；`getActivity` 只在 `needQ>0` 时被调），
  // 共用一个变量会让「0 时连读盘都没发生」这条硬要求变得依赖调用顺序。
  //
  // **`needQ === 0` 时这个函数永远不会被调用** —— `decide()` 里那道分支根本不存在。
  // 这就是「默认值不破坏现有用户」的可验证形态。
  let cachedActivity = null;
  const getActivity = () => {
    if (cachedActivity === null) {
      // `need` 传进去才会回扫（`need=0` 时只读一块，行为与引入回扫前逐字相同）。
      // `maxScanBytes` 由配置给：回扫是**有上限**的，到上限仍不够由 `truncated` 表达，
      // 调用方据此放行 —— 见 `readTranscriptActivity()` §有界回扫。
      //
      // **`need` 必须读 `minQuestionsBeforeWriteOf()`，不能读 `cfg.minQuestionsBeforeWrite`。**
      // 那个值在 `defaultConfig()` 里恒为 0，配置文件/env 的覆盖发生在下面
      // `state.config = {...}` 那一行 —— 本闭包捕获的是 `cfg`，读它等于永远不回扫。
      // 2026-11-19 实测过这个 bug：回扫函数正确、`state.config` 正确，只有这一行读错了变量，
      // 于是长会话仍然永久锁死（`DF-038` 第 4 条的回归测试抓到的就是它）。
      const needQ = Number(state.config && state.config.minQuestionsBeforeWrite) || 0;
      cachedActivity = (input && input.transcript_path)
        ? readTranscriptActivity(input.transcript_path, {
          bytes: cfg.transcriptBytes, cwd, need: needQ, maxScanBytes: cfg.transcriptScanBytes,
        })
        : { questions: [], distinctQuestions: 0, unknownAskCalls: 0, priorWriteCalls: 0, reads: [], unreadable: true };
    }
    return cachedActivity;
  };

  // 密钥**只读不生成**：校验一次判定的路径不该在盘上留东西。生成只发生在
  // `writeMarker({satisfiedBy:"auto"})` 里 —— 那才是真需要签名的时刻。
  // 副作用集中在这里、`ensureGateSecret` 只在写标记里调用，所以这两个读盘动作
  // 都归 `runHook`，`decide()` 依旧是纯函数。
  const pauseHit = pausedPathOf(env);
  const state = {
    config: cfg,
    cwd,
    markerPath,
    secretPath,
    marker: readMarker(markerPath),
    secret: readGateSecret(secretPath),
    getReads,
    getActivity,
    // L1 叫停：路径与判据都来自 `stop-verify-hook.mjs`（见 `decide()` 里的注释）。
    // `paused` 由 `pauseHit` 推出 —— **只调一次 `pausedPathOf()`**。分两次算两条候选路径
    // 会让「判据说暂停了、日志说没命中」成为可能，而这两句必须永远一致。
    paused: pauseHit !== null,
    pauseHit,
    pausePath: pausePathFor(env),
    pausePaths: pausePathsFor(env).length,
    denials: bumpDenials(denialPath, promptId, { readOnly: true }),
    gateCommand: gateCommandFor(input),
  };
  // `ask.minQuestionsBeforeWrite` 的生效值。**只在这一行算**，且**一定**要覆盖
  // `defaultConfig()` 的 0 —— 否则配置文件里写了也不生效（那正是本仓库反复批判的
  // 「配置项存在但没有执行侧」）。
  //
  // 读不出来时 `minQuestionsBeforeWriteOf()` 回落到 0（fail-open），
  // 所以配置是垃圾也不会让用户写不了文件。
  state.config = { ...cfg, minQuestionsBeforeWrite: minQuestionsBeforeWriteOf(env, { cwd }) };

  const out = decide(input, state);

  // 落盘只在判定之后 —— `decide` 保持纯，副作用全部收在这里。
  if (out.markWrite) {
    writeMarker(markerPath, {
      sessionId: String((input && input.session_id) || ''),
      satisfiedBy: out.markWrite.satisfiedBy,
      reads: out.markWrite.reads,
      promptId: out.markWrite.promptId,
      readsSample: out.markWrite.readsSample || null,
      secret: state.secret,
      nowMs,
    });
  }
  if (out.action === 'deny') bumpDenials(denialPath, promptId);
  if (out.log && typeof out.log === 'object') out.log.sessionId = String((input && input.session_id) || '');
  appendLog(out.log, env, nowMs);
  return out;
}

/** reason 里要模型「原样敲」的那条命令。抽出来只为可测。 */
function gateCommandFor(input) {
  const sid = String((input && input.session_id) || '');
  const script = join(REPO_ROOT, 'scripts', 'pre-write-gate.mjs').replace(/\\/g, '/');
  return `node "${script}" mark${sid ? ` --session ${sid}` : ''}`;
}

/** 读 stdin 全部内容。宿主可能不关管道，所以外层还要有时间闸（见 `main`）。 */
export function readStdin(stream, limitBytes = 4 * 1024 * 1024) {
  return new Promise((res) => {
    let buf = '';
    let done = false;
    const finish = () => { if (!done) { done = true; res(buf); } };
    stream.setEncoding('utf8');
    stream.on('data', (c) => {
      buf += c;
      if (buf.length > limitBytes) finish();
    });
    stream.on('end', finish);
    stream.on('error', finish);
    if (stream.readableEnded) finish();
  });
}

/** 安全解析 hook 输入。解析失败返回 `null` → 调用方 fail-open。 */
export function parseHookInput(text) {
  try {
    const o = JSON.parse(String(text || ''));
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    return o;
  } catch {
    return null;
  }
}

/** 预算（毫秒）。闸门挡在每一次写之前，慢就是直接的体感伤害。
 *  超预算 = 放行 + 记账 —— 用户的「写」比我们的判定重要。 */
export const DEFAULT_BUDGET_MS = 5000;

/** CLI：`mark` / `status`。 */
export function cli(argv = [], env = process.env, nowMs = Date.now()) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const cmd = String(args[0] || '');
  const flag = (name, dflt = '') => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
  };
  const cwd = String(flag('--cwd', env.OW_PRE_WRITE_GATE_CWD || process.cwd()));
  const markerPath = markerPathFor(cwd);

  if (cmd === 'mark') {
    const data = writeMarker(markerPath, {
      sessionId: String(flag('--session', env.CLAUDE_CODE_SESSION_ID || '')),
      satisfiedBy: 'claim',
      reads: Number(flag('--reads', '0')),
      promptId: String(flag('--prompt-id', '')),
      nowMs,
    });
    if (!data) { process.stderr.write(`无法写入标记：${markerPath}\n`); return 1; }
    process.stdout.write(`标记已写入：${markerPath}\n${JSON.stringify(data)}\n`);
    return 0;
  }

  if (cmd === 'status') {
    const m = readMarker(markerPath);
    const cfg = configOf(env);
    const sec = readGateSecret(secretPathFor(cwd));
    // `ask.minQuestionsBeforeWrite` 的**生效值**（env > 配置文件 > 0）。看清楚它，
    // 否则「我明明写了 3，为什么没拦」和「我写了 0，为什么拦了」都要靠猜 ——
    // 这个仓库对「配置项存在但没有执行侧」已经有过太多教训。
    const minQ = minQuestionsBeforeWriteOf(env, { cwd });
    const sig = m.exists && m.data && m.data.satisfied_by === 'auto'
      ? (verifyMarkerSig(m.data, sec) ? 'valid' : 'INVALID（缺签名或密钥不符 —— 这条 auto 不算数）')
      : '—';
    // ── 叫停路径的现状：**列出全部候选，标出命中的那一条**（`DF-041`）──
    //
    // 两个目录都认之后，「用户想停」与「用户把文件放错了地方」在布尔层面完全一样。
    // 所以这里把「正在检查哪些路径、命中的是哪一条」直接印出来 —— 用户自查
    // 「我该把文件放哪」不该靠读源码。不命中也照样列出路径：那才是「没生效」时
    // 唯一能回答「我到底该放哪」的地方。
    const pausePaths = pausePathsFor(env);
    const pauseHit = pausedPathOf(env);
    const pauseLines = pausePaths.length
      ? [
        `pause       : ${pauseHit ? `PAUSED（命中 ${pauseHit}）` : 'not paused'}`,
        ...pausePaths.map((p, idx) => `pause path ${idx + 1}: ${p}${p === pauseHit ? '  ← 命中' : ''}`),
      ]
      : ['pause       : 无可检查路径（连状态根都算不出来 —— 设 OVERWATCH_STOP_VERIFY_PAUSE）'];
    const lines = [
      `mode        : ${cfg.mode}`,
      `brake       : ${cfg.brake}${cfg.brake === 'budget' ? `（前 ${cfg.denyBudget} 次不刹车）` : ''}`,
      `minReads    : ${cfg.minReads}`,
      `minQuestions: ${minQ}${minQ === 0 ? '（这条判据不启用）' : '（第一次写之前必须先问够这么多个不同问题）'}`,
      `cwd         : ${cwd}`,
      `marker      : ${markerPath}`,
      `marker state: ${m.exists ? (m.error ? `exists-but-broken (${m.error})` : `exists ${JSON.stringify(m.data)}`) : 'absent'}`,
      `secret      : ${sec ? 'present' : 'absent'}（${secretPathFor(cwd)}）`,
      `marker sig  : ${sig}`,
      ...pauseLines,
    ];
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }

  process.stderr.write(
    '用法：node scripts/pre-write-gate.mjs [mark|status] [--session <id>] [--reads <n>] [--cwd <dir>]\n'
    + '无子命令 = hook 入口（stdin 进，stdout 出）。\n',
  );
  return 2;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length) {
    process.exit(cli(argv));
    return;
  }
  const env = process.env;

  let raw = '';
  const guard = new Promise((r) => setTimeout(() => r('__TIMEOUT__'), DEFAULT_BUDGET_MS));
  try {
    raw = await Promise.race([readStdin(process.stdin), guard]);
  } catch {
    raw = '';
  }
  if (raw === '__TIMEOUT__') {
    appendLog({ at: new Date().toISOString(), decision: 'passthrough', allowReason: 'hook-budget-exceeded' }, env);
    return;
  }

  const input = parseHookInput(raw);
  if (!input) {
    // fail-open：输入坏了不是「该拦」的理由。
    appendLog({ at: new Date().toISOString(), decision: 'passthrough', allowReason: 'unparsable-input', bytes: String(raw || '').length }, env);
    return;
  }

  let out;
  try {
    out = runHook(input, { env });
  } catch (e) {
    appendLog({
      at: new Date().toISOString(), decision: 'passthrough',
      allowReason: 'hook-internal-error', error: String((e && e.message) || e).slice(0, 200),
    }, env);
    return;
  }
  if (out && out.output) process.stdout.write(JSON.stringify(out.output) + '\n');
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
