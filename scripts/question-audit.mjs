#!/usr/bin/env node
/**
 * question-audit.mjs — 事后审计「AI 问问题」的**可观测形态**。零依赖，只读。
 *
 * ── 为什么是事后审计，不是事前强制 ────────────────────────────────
 * 用户的三条原话是判据来源：
 *
 *   1「问要问的准，要问的泛，这是一切未来持续性工作的基础」
 *   2「在问问题之前 AI 需要了解项目文件夹状态，环境状态，然后再去问，
 *      而不是写完文件再去问」
 *   3「有很多时候用户是不知道要实现这个功能还要考虑到什么什么的，
 *      也有很多时候 AI 不知道用户真正的意图」
 *
 * 第 1 条里的「准」和「泛」**无法机械判定**——它们要求判断问题内容对不对，
 * 那需要语义理解，而本仓库的纪律是「外观像遥测、实际由语言模型编出的数字，
 * 比没有更糟」（`state-model.md` §8）。所以本脚本**不判定准不准**。
 *
 * 它判定的是第 2 条里那句可观测的话：**问的时点在不在读之后**。那是两个
 * tool_use 记录在 transcript 里的先后顺序，纯结构事实，可离线复算。
 *
 * 而「写前强制提问」已由实测证否（`docs/research/2026-11-14-pretooluse-desktop-verification.md`
 * §5.5：`PreToolUse` 的 `ask` 只能问「允许这次调用吗」，问不了「你想做什么」）。
 * 所以这里走事后审计：把「没读就问」从「没人会发现」变成「一次可复现的报告」。
 * **这是提高可见度，不是消除。** 与 `state-model.md` §2.2 同一立场。
 *
 * ── 四条判据的结论（逐条写在输出里）────────────────────────────────
 *   C1 问之前读过项目吗        **可判定**（tool_use 先后顺序）
 *   C2 问了几次 / 每次几问     **可判定**（但必须按 tool_use id 去重）
 *   C3 有没有重复问已知信息     **不可判定**（关键词重叠是启发式，见 §3 的告警）
 *   C4 有没有该问而没问        **不可判定**（缺「待决点清单」这个输入）；
 *                              只有一个代理指标：写了文件却整场零提问
 *
 * ── 实测到的两处「不处理就会算错」─────────────────────────────────
 *   ① **33,090 行重复 tool_use**（同一 id 出现两行：一行带 timestamp、一行不带，
 *      宿主重写留下的）。按行数会算错。实测 273 次原始 AskUserQuestion 调用，
 *      按 id 去重后是 **197** 次——虚高 39%。所有计数一律按 id 去重。
 *   ② **`input.questions` 不总是数组**。实测 197 次去重调用里 **6 次是 JSON 字符串**，
 *      而这 6 条字符串**全部 JSON.parse 失败**（模型把引号写坏了）。
 *      把它们当「问了 0 件事」是错的，当「问了 1 件」也错。单独记 `questionsUnknown`，
 *      且这类调用**不参与**「超过 maxQuestions」的判定——不知道就不许判。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   node scripts/question-audit.mjs                    # 扫全部主 transcript
 *   node scripts/question-audit.mjs --days 7           # 只看 7 天内有活动的
 *   node scripts/question-audit.mjs --json             # 机器可读
 *   node scripts/question-audit.mjs --root <dir>       # 指定语料目录（测试用）
 *   node scripts/question-audit.mjs --config <file>    # 指定配置文件
 *   node scripts/question-audit.mjs --strict           # 把「没读就问」也算违规
 *
 *  退出码：0 = 无阻塞违规；1 = 有阻塞违规（`--strict` 时 zero-ask 也算）；
 *          2 = 配置非法 / 语料目录读不到（**不静默回落**）。
 */

import {
  readFileSync, readdirSync, existsSync, statSync,
  realpathSync,
} from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { readPathsOfToolUse, pathKeyOf } from './pre-write-gate.mjs';
import { questionsOfAsk, normalizeText } from './question-form.mjs';
// 复用既有的去重判据与宽口径读取判据，不另写一份。
// `dedupeForks()` 判的是「前 N 条调用序列是否逐字相同」；
// `broadReadsOf()` 是「结构性探索（ls/find/grep/Glob）也算了解项目」那一档。
import { dedupeForks, broadReadsOf } from './observe-reality-check.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── 配置文件与校验（S5「可配置」）──────────────────────────────────────

/** 配置文件放在**仓库根**，不是 `.claude/`。
 *
 *  三条理由，都是本仓库的既有约定推出来的：
 *
 *  1. **本项目是应用，不是插件。** 应用的配置在项目根（`package.json` /
 *     `tsconfig.json` 的位置），用户打开仓库第一屏就该看见「这台机器按什么策略问」。
 *     放进 `.claude/` 等于把它做成编辑器集成的内部细节。
 *  2. **`.claude/` 在本仓库是「产品本体 + 本机私有」的混合层。** 那里已有
 *     `settings.local.json`（gitignored）与 `.claude/.ow-*`（gitignored，含签名密钥）。
 *     再放一份**可发布**的默认策略进去，读者无法从路径判断它该不该提交。
 *  3. 它必须可提交（默认策略是被审计对象），根目录的 `overwatch.config.json`
 *     没有歧义。
 *
 *  文件名带 `overwatch.` 前缀而不是赤裸的 `config.json`：本仓库根已经有一个
 *  `CLAUDE.md`（宿主约定），`config.json` 太容易被认成宿主配置。 */
export const CONFIG_FILE = 'overwatch.config.json';

/** `ask.mode` 的三个合法值。`never` 是用户拍板保留的「小众玩法」（测模型质量）。 */
export const ASK_MODES = Object.freeze(['always', 'never', 'auto']);

/** `auto` 模式判定「这个会话够复杂、该问」的两个阈值。**常量导出**，测试要钉住它们。
 *
 *  为什么用「写过几个不同文件」和「工具调用次数」而不是模型自评：后者是编出来的数字。
 *  两个阈值都是实测分布的中位数附近（257 个有工具调用的会话里，
 *  写过 ≥3 个不同文件的 147 个、工具调用 ≥15 次的 168 个、并集 168 个）——
 *  即 `auto` 会把约 65% 的会话判为「该问」。**这个比例是实测的，不是设计意图。** */
export const AUTO_COMPLEX_FILES = 3;
export const AUTO_COMPLEX_TOOLCALLS = 15;

/** `.claude/agents/` 里现存的角色名。`agent.roster` 只接受这些值（外加 `executor` 单跑合法）。
 *
 *  为什么写死在这里而不是每次读目录：配置**校验**必须在干净 clone 上也能跑，
 *  而 `.claude/agents/` 是真的在产品本体里（不会被 gitignore），所以读目录也行——
 *  但那样一来「角色名打错」会随目录变化而时过时不过，校验结果不稳定。
 *  写死 + 由 `question-audit.test.mjs` 断言「这份清单与目录一致」，两边不会漂。 */
export const KNOWN_ROLES = Object.freeze([
  'oversight-acceptor', 'oversight-critic', 'oversight-executor', 'oversight-planner',
  'oversight-probe', 'oversight-redteam', 'oversight-relay', 'oversight-repair',
  'oversight-research', 'oversight-resolution', 'oversight-review', 'oversight-safety',
]);

/** 默认配置。**问是默认，不问要显式关掉**（用户拍板第 2 条）。 */
export function defaultConfig() {
  return {
    version: 1,
    ask: {
      mode: 'always',
      maxQuestions: 5,
      requireReadFirst: true,
      minReads: 3,
      /** 第一次写文件之前必须已经问过几个问题。**0 = 不启用**（默认）。
       *
       *  这一项的**执行侧不是本脚本**，是写前闸的 `pre-write-gate.mjs`
       *  （`decide()` 里那段「判据零」）。本文件只负责让它能通过校验、
       *  不被判成 `unknown-key` —— 键白名单与执行侧分离是本仓库的既有结构：
       *  `ask.mode` 的执行侧也在 `launch.mjs`，不在这里。
       *
       *  取值范围与执行侧的 `MAX_MIN_QUESTIONS` 一致（0..20）。
       *  为什么默认 0、为什么不是本脚本执行，见 `pre-write-gate.mjs` 的
       *  `minQuestionsBeforeWriteOf()`。 */
      minQuestionsBeforeWrite: 0,
    },
    agent: {
      roster: ['oversight-planner', 'oversight-executor', 'oversight-acceptor'],
    },
  };
}

/** 校验一份配置对象。**非法即报错，绝不静默回落**。
 *
 *  这是本仓库付过学费的一条：`scan-sessions.mjs` 的 `--days abc` 曾经静默回落成 7 天，
 *  于是「只看 1 天」的调用实际扫了一周，而输出里没有任何提示。配置比命令行参数更危险
 *  （它不出现在命令行历史里，没人会重新看一遍），所以这里：
 *
 *    · 未知键 = 错误（`unknown-key`）。拼错 `ask.requirReadFirst` 不会被当成默认值忽略，
 *      否则用户会以为自己关掉了闸门、实际上开着。
 *    · 类型不对 = 错误（`bad-type`），不做 `Number('')===0` 那类隐式转换。
 *    · 语义矛盾 = 错误（`contradiction`），形态沿用 `question-protocol.md` §2.7。
 *
 *  @returns {{ok:boolean, config:object|null, errors:Array<{code:string,path:string,msg:string}>}}
 */
export function validateConfig(raw) {
  const errors = [];
  const err = (code, path, msg) => errors.push({ code, path, msg });

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    err('bad-root', '', '配置根必须是 JSON 对象');
    return { ok: false, config: null, errors };
  }

  // 顶层键白名单。`$schema` 允许存在但不参与判定（编辑器提示用）。
  const TOP = new Set(['$schema', 'version', 'ask', 'agent']);
  for (const k of Object.keys(raw)) {
    if (!TOP.has(k)) err('unknown-key', k, `未知的顶层键 "${k}"（拼错了？允许：${[...TOP].join(' / ')}）`);
  }

  if (raw.version !== 1) {
    err('bad-version', 'version', `version 必须是数字 1（当前：${JSON.stringify(raw.version)}）`);
  }

  const ask = raw.ask;
  const cfg = defaultConfig();
  if (ask === undefined) {
    err('missing-section', 'ask', '缺少 ask 段。不写就等于不声明策略——请显式写出来');
  } else if (ask === null || typeof ask !== 'object' || Array.isArray(ask)) {
    err('bad-type', 'ask', 'ask 必须是对象');
  } else {
    const ASK_KEYS = new Set(['mode', 'maxQuestions', 'requireReadFirst', 'minReads', 'minQuestionsBeforeWrite']);
    for (const k of Object.keys(ask)) {
      if (!ASK_KEYS.has(k)) err('unknown-key', `ask.${k}`, `未知键 "ask.${k}"（允许：${[...ASK_KEYS].join(' / ')}）`);
    }
    if (!ASK_MODES.includes(ask.mode)) {
      err('bad-mode', 'ask.mode',
        `ask.mode 必须是 ${ASK_MODES.join(' / ')}（当前：${JSON.stringify(ask.mode)}）`);
    } else {
      cfg.ask.mode = ask.mode;
    }
    // **`mode: "never"` 时 `maxQuestions` 允许 0。** 原来无条件下限是 1，于是
    // 「关掉提问」这个配置**无法表达** —— 用户写 `{mode:"never", maxQuestions:0}`
    // 会被判 `bad-range`，而写 `maxQuestions:1` 又说不通（都关了还问几个）。
    // 校验器把合法配置判成非法，等于强迫用户填一个语义上撒谎的数字。
    const maxLower = ask.mode === 'never' ? 0 : 1;
    if (!Number.isInteger(ask.maxQuestions) || ask.maxQuestions < maxLower || ask.maxQuestions > 20) {
      err('bad-range', 'ask.maxQuestions',
        `ask.maxQuestions 必须是 ${maxLower}..20 的整数（当前：${JSON.stringify(ask.maxQuestions)}）。`
        + '字符串 "5" 也拒绝——隐式类型转换正是静默校验失效的来源');
    } else {
      cfg.ask.maxQuestions = ask.maxQuestions;
    }
    if (typeof ask.requireReadFirst !== 'boolean') {
      err('bad-type', 'ask.requireReadFirst',
        `ask.requireReadFirst 必须是布尔（当前：${JSON.stringify(ask.requireReadFirst)}）`);
    } else {
      cfg.ask.requireReadFirst = ask.requireReadFirst;
    }
    if (!Number.isInteger(ask.minReads) || ask.minReads < 0 || ask.minReads > 50) {
      err('bad-range', 'ask.minReads', `ask.minReads 必须是 0..50 的整数（当前：${JSON.stringify(ask.minReads)}）`);
    } else {
      cfg.ask.minReads = ask.minReads;
    }
    // `ask.minQuestionsBeforeWrite`：写前闸的执行侧。**校验与执行分两处，但口径必须一致**
    // —— 这里拒绝的范围与 `pre-write-gate.mjs` 的 `MAX_MIN_QUESTIONS`（20）逐字相同，
    // 否则会出现「配置校验通过、闸门当非法回落到 0」的静默失效。
    // 由于两处都写死了 20，`question-audit.test.mjs` 里那条断言把它钉住了。
    if (ask.minQuestionsBeforeWrite === undefined) {
      // 缺省 = 0（不启用）。**不报 missing**：这是老配置的既有形态，凭空要求新键
      // 会让所有已有用户的配置文件突然变非法。
      cfg.ask.minQuestionsBeforeWrite = 0;
    } else if (!Number.isInteger(ask.minQuestionsBeforeWrite)
      || ask.minQuestionsBeforeWrite < 0 || ask.minQuestionsBeforeWrite > 20) {
      err('bad-range', 'ask.minQuestionsBeforeWrite',
        `ask.minQuestionsBeforeWrite 必须是 0..20 的整数（当前：${JSON.stringify(ask.minQuestionsBeforeWrite)}）。`
        + '0 = 不启用这条判据；字符串 "3" 也拒绝，理由同 maxQuestions');
    } else {
      cfg.ask.minQuestionsBeforeWrite = ask.minQuestionsBeforeWrite;
    }
    // 语义矛盾：mode=never 时「问之前必须读过项目」没有主语可约束。
    // 不静默忽略——让用户显式写 false，是这个配置项存在的意义。
    if (ask.mode === 'never' && ask.requireReadFirst === true) {
      err('contradiction', 'ask.requireReadFirst',
        'ask.mode="never" 与 ask.requireReadFirst=true 矛盾（不问就不存在「问之前」）。'
        + '要关掉提问，请同时写 "requireReadFirst": false');
    }
  }

  const ag = raw.agent;
  if (ag === undefined) {
    err('missing-section', 'agent', '缺少 agent 段（至少要写 agent.roster）');
  } else if (ag === null || typeof ag !== 'object' || Array.isArray(ag)) {
    err('bad-type', 'agent', 'agent 必须是对象');
  } else {
    const AG_KEYS = new Set(['roster']);
    for (const k of Object.keys(ag)) {
      if (!AG_KEYS.has(k)) err('unknown-key', `agent.${k}`, `未知键 "agent.${k}"（允许：${[...AG_KEYS].join(' / ')}）`);
    }
    const roster = ag.roster;
    if (!Array.isArray(roster)) {
      err('bad-type', 'agent.roster', `agent.roster 必须是数组（当前：${JSON.stringify(roster)}）`);
    } else if (!roster.length) {
      err('bad-roster', 'agent.roster', 'agent.roster 不能为空——没有一个角色就没有可派发的东西');
    } else {
      const seen = new Set();
      for (const r of roster) {
        if (typeof r !== 'string') {
          err('bad-type', 'agent.roster', `agent.roster 的每一项必须是字符串（当前：${JSON.stringify(r)}）`);
          continue;
        }
        if (!KNOWN_ROLES.includes(r)) {
          err('unknown-role', 'agent.roster', `未知角色 "${r}"（允许：${KNOWN_ROLES.join(', ')}）`);
        }
        if (seen.has(r)) err('duplicate-role', 'agent.roster', `角色 "${r}" 重复出现`);
        seen.add(r);
      }
      cfg.agent.roster = roster.filter((r) => typeof r === 'string');
    }
  }

  return { ok: errors.length === 0, config: errors.length === 0 ? cfg : null, errors };
}

/** 读配置文件。**文件不存在 = 用默认值**（这是唯一的回落）；
 *  文件存在但读不了/解析不了/校验不过 = **错误，返回 null 配置**，调用方必须停。
 *
 *  @returns {{found:boolean, path:string, config:object|null, errors:Array}}
 */
export function loadConfig(file = join(ROOT, CONFIG_FILE)) {
  const p = String(file || '');
  if (!p || !existsSync(p)) {
    return { found: false, path: p, config: defaultConfig(), errors: [] };
  }
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch (e) {
    return { found: true, path: p, config: null, errors: [{ code: 'unreadable', path: p, msg: `读不了配置文件：${e.message}` }] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { found: true, path: p, config: null, errors: [{ code: 'bad-json', path: p, msg: `JSON 解析失败：${e.message}` }] };
  }
  const v = validateConfig(raw);
  return { found: true, path: p, config: v.config, errors: v.errors };
}

// ── transcript 解析 ───────────────────────────────────────────────────

/** 判据本身住在 `question-form.mjs`（2026-11-19 搬出），这里**只转出**。
 *
 *  搬家的理由只有一个：写前闸（`pre-write-gate.mjs`）要数「问过几个问题」，
 *  而它直接 import 本文件会形成环 —— 本文件 import 了 `observe-reality-check.mjs`，
 *  后者在模块顶层求值 `GATE_SHELL_READ_VERBS`，环会让那一行在常量初始化之前执行，
 *  直接 TDZ ReferenceError。环的成因见 `question-form.mjs` 文件头。
 *
 *  判据仍然只有一份：本文件不再有这两个函数的实现。既有的调用方（本文件的
 *  `scanSession`、`nearDuplicateQuestions`、`question-audit.test.mjs`、
 *  以及一切 `import { questionsOfAsk } from './question-audit.mjs'` 的地方）
 *  **一行都不用改**。 */
export { questionsOfAsk, normalizeText };

/** 会话里「读过项目」的四种口径。**都要，因为它们的结论不同**，而且差异实测存在：
 *
 *   · `anyRead`     —— 读过任意一个**文件路径**（Read / NotebookRead / cat / head …）。
 *   · `docRead`     —— 读过任意一份**项目文档**（CLAUDE.md / README.md / GUIDE.md）。
 *                      用户原话第 2 条说的「了解项目文件夹状态、环境状态」，文档最直接。
 *   · `codeRead`    —— 读过任意一个**源码/配置**文件。
 *   · `structural`  —— 做过**结构性探索**（Glob / Grep / LS / `ls` / `find` / `git log`）。
 *   · `coveredRead` —— 按闸门自己的判据 `reads >= minReads` 且是**不同**文件。
 *                      最严，且**与写前闸共用同一实现**（`readPathsOfToolUse` +
 *                      `pathKeyOf`），不另起一套动词表——本仓库立过「判据只能有一份」
 *                      的规矩（`observe-reality-check.mjs` 曾复制一份，改一边不生效）。
 *
 *  **为什么必须有 `structural` 这一档**（实测教训）：`3f0f6fac`（PerfScope）的
 *  序列是 `Glob → Agent×6 → TaskOutput×2 → WebSearch×2 → Agent…`，第 20 次调用
 *  才是提问，而第一个 `Read` 在第 32 次。按 `anyRead` 判它是「先问后读」——
 *  但它开场就 Glob 了整个项目目录。用户原话是「了解项目**文件夹状态**、环境状态」，
 *  那正是 Glob 在做的事。**判据漏了这一档，就会把「正确地先看目录再问」误判成缺陷。**
 *
 *  反面同样成立，所以本脚本把两种口径的判定**都输出**（`verdict.any` / `verdict.broad`），
 *  不替读者选。
 */
const DOC_NAMES = /^(claude\.md|readme\.md|guide\.md|agents\.md|contributing\.md)$/i;
const CODE_EXT = /\.(mjs|js|cjs|ts|tsx|jsx|py|java|go|rs|c|cc|cpp|h|hpp|json|jsonc|yml|yaml|toml|css|scss|html|md|ps1|sh|gradle|xml)$/i;

/** 扫一个会话的记录，抽出审计需要的一切。**纯函数**：记录进、结构出，不读盘。
 *
 *  @param {Array<object>} records transcript 记录（已 JSON.parse 的行）
 *  @param {{minReads?:number}} [opts]
 */
export function scanSession(records, { minReads = 3 } = {}) {
  const arr = Array.isArray(records) ? records : [];
  const seenIds = new Set();       // 跨会话去重：宿主会把同一 tool_use 写两行
  const readFiles = new Set();     // 归一化后的不同文件
  const writtenFiles = new Set();
  const asks = [];
  const seq = [];                  // fork 去重用的调用指纹序列（只留前 400 条）
  let callIndex = 0;
  let anyRead = -1;
  let docRead = -1;
  let codeRead = -1;
  let structural = -1;
  let coveredRead = -1;
  let firstWrite = -1;
  let duplicateCallLines = 0;
  let agentCalls = 0;

  for (const rec of arr) {
    const content = rec && rec.message && Array.isArray(rec.message.content) ? rec.message.content : null;
    if (!content) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      // 去重：同一 id 的第二行是宿主重写留下的副本，不是第二次调用。
      // 实测全语料 33,090 行是重复的；不去重会把「问了几次」系统性算高 39%。
      if (typeof b.id === 'string' && b.id) {
        if (seenIds.has(b.id)) { duplicateCallLines++; continue; }
        seenIds.add(b.id);
      }
      callIndex++;
      // fork 指纹：`工具名 + 入参摘要`。用 id 会误判（同上理由：宿主重写会换 id），
      // 用整个 input 会太贵；名字 + 第一个参数就足够区分「同一次对话的拷贝」。
      if (seq.length < 400) {
        const p = b.input && (b.input.file_path || b.input.notebook_path
          || b.input.path || b.input.command || b.input.pattern);
        seq.push(`${b.name}|${String(p || '').slice(0, 80)}`);
      }

      for (const raw of readPathsOfToolUse(b.name, b.input)) {
        const k = pathKeyOf(raw);
        if (!k) continue;
        if (anyRead < 0) anyRead = callIndex;
        const bn = basename(String(raw).replace(/\\/g, '/')).toLowerCase();
        if (DOC_NAMES.test(bn)) { if (docRead < 0) docRead = callIndex; }
        else if (CODE_EXT.test(bn)) { if (codeRead < 0) codeRead = callIndex; }
        if (!readFiles.has(k)) {
          readFiles.add(k);
          if (readFiles.size >= Math.max(1, Number(minReads) || 1) && coveredRead < 0) coveredRead = callIndex;
        }
      }

      // 结构性探索（Glob / Grep / LS / ls / find …）也算「看了项目」。判据来自
      // `observe-reality-check.mjs` 的 `broadReadsOf()`，不另写一份。
      if (structural < 0 && broadReadsOf(b.name, b.input).length) structural = callIndex;

      if (b.name === 'Write' || b.name === 'Edit' || b.name === 'NotebookEdit') {
        const p = b.input && (b.input.file_path || b.input.notebook_path || b.input.path);
        const k = pathKeyOf(p);
        if (k) writtenFiles.add(k);
        if (firstWrite < 0) firstWrite = callIndex;
      }

      if (b.name === 'AskUserQuestion') {
        const q = questionsOfAsk(b.input);
        asks.push({
          at: callIndex,
          id: typeof b.id === 'string' ? b.id : null,
          questionCount: q.unknown ? null : q.questions.length,
          questionsUnknown: q.unknown,
          form: q.form,
          questions: q.questions,
          // 提问之前派过几次子 agent。这是 C1 的**已知不可归因项**：
          // 子 agent 在主 transcript 里只有一个 `Agent` 调用记录，它读了什么不在这里。
          agentCallsBefore: agentCalls,
        });
      }

      if (b.name === 'Agent') agentCalls++;
    }
  }

  const known = asks.filter((a) => !a.questionsUnknown);
  return {
    toolCalls: callIndex,
    duplicateCallLines,
    seq,
    asks,
    askCalls: asks.length,
    // 只有「形态可读」的调用才计入问题数；不知道的不算 0、也不算 1。
    questionsKnown: known.reduce((n, a) => n + a.questionCount, 0),
    questionsUnknownCalls: asks.length - known.length,
    filesRead: readFiles.size,
    filesWritten: writtenFiles.size,
    agentCalls,
    firstAsk: asks.length ? asks[0].at : -1,
    firstWrite,
    firstRead: {
      any: anyRead, doc: docRead, code: codeRead, structural, covered: coveredRead,
    },
  };
}

/** 「问之前有没有读过项目」的判定。**这是本脚本的主判据**。
 *
 *  判据是**记录顺序**，不是时间戳：两者在同一会话里一致，但重复行会让时间戳并列；
 *  用去重后的调用序号没有并列问题。实测 54 个提问会话里「同一批消息里既读又问」
 *  的并列情形 **0 个**——真有并列时返回 `tie`，不猜。
 *
 *  **两种口径都算，都返回**（`verdict.narrow` / `verdict.broad`），调用方自己选：
 *   · `narrow` 只认「读了文件**内容**」（`anyRead`）。
 *   · `broad`  把结构性探索也算上（`structural`，即 Glob/Grep/ls/find）。
 *  用户原话是「了解项目**文件夹状态**、环境状态」——`broad` 更贴那句话。
 *  但 `broad` 更松，所以两个都输出、不隐藏。
 *
 *  **第三种情形必须单独出来：`unattributable`。**
 *  实测 `3f0f6fac`（PerfScope）序列：`Glob → Agent×6 → TaskOutput×2 → WebSearch×2 → …`
 *  → 第 20 次调用提问，第 32 次才有第一个 `Read`。它在提问前派了 6 个子 agent——
 *  **子 agent 读了什么，主 transcript 里没有记录**（只有一个 `Agent` 调用）。
 *  把它判成「没读就问」是错的：证据不在这一份文件里。所以只要提问前有过 `Agent`
 *  派发而本地又找不到任何读取证据，就判 `unattributable`，并**不计入违规**——
 *  「没读到」不等于「没有」，这是本仓库立过的规矩（`verify-claims.mjs` 的 UNKNOWN 纪律）。
 *
 *  @returns {{verdict:{narrow:string,broad:string,effective:string}, basis:string, at:object}}
 */
export function judgeReadFirst(session) {
  const s = session || {};
  const first = s.firstAsk;
  if (!s.askCalls || first < 0) {
    return { verdict: { narrow: 'no-ask', broad: 'no-ask', effective: 'no-ask' }, at: {} };
  }
  const r = s.firstRead || {};
  const num = (v) => (Number.isFinite(v) ? v : -1);
  const decide = (at) => {
    if (at < 0) return 'no-read';
    if (at < first) return 'read-first';
    if (at > first) return 'ask-first';
    return 'tie';
  };
  const narrowAt = num(r.any);
  const broadCandidates = [narrowAt, num(r.structural)].filter((v) => v >= 0);
  const broadAt = broadCandidates.length ? Math.min(...broadCandidates) : -1;
  const narrow = decide(narrowAt);
  const broad = decide(broadAt);

  // `effective` 取两口径里**对本会话最有利**的那个：只要有一种口径显示「先读过」，
  // 就不判它违规。理由：判据的目的是抓「完全没看就开始问」，不是抓「只看目录没读文件」。
  // 判决本身不隐藏——`narrow`/`broad` 都原样给出。
  //
  // **`no-read` 与 `ask-first` 必须分开**：前者是「一个文件都没读」（更严重），
  // 后者是「读了但在问之后」。合并会让报告说不清缺陷到底是什么。
  let effective;
  if (narrow === 'read-first' || broad === 'read-first') effective = 'read-first';
  else if (narrow === 'tie' || broad === 'tie') effective = 'tie';
  else if (narrow === 'no-read' && broad === 'no-read') effective = 'no-read';
  else effective = 'ask-first';

  // 投票前的 Agent 派发 = 证据可能在别处。
  const agents = (s.asks && s.asks[0] && num(s.asks[0].agentCallsBefore)) || 0;
  if (effective !== 'read-first' && effective !== 'tie' && agents > 0) effective = 'unattributable';

  return {
    verdict: { narrow, broad, effective },
    at: { firstAsk: first, firstReadAny: narrowAt, firstStructural: num(r.structural), agentsBefore: agents },
  };
}

// ── C3 的启发式（**明确不是判据**）────────────────────────────────────

/** 从问题文本里抽「看起来像标识符」的词：开源名、文件名、配置键、编号。
 *  故意窄：只认 ASCII 词形（`df-018` / `CLAUDE.md` / `--trace`），
 *  中文不做分词——中文二元组重合会把「怎么处理」和「怎么弄」判成高度重合，
 *  那种假阳性会让整个指标失去意义（`classify-stop.mjs` 的 research 已记录过这点）。 */
const IDENT_TOKEN = /[A-Za-z][A-Za-z0-9_.\-]{2,}/g;

/** 一份项目文档里的标识符集合（用于 C3）。读三种入口文档，缺失即跳过。 */
function docTokensOf(cwd) {
  const set = new Set();
  const base = String(cwd || '');
  if (!base) return set;
  for (const n of ['CLAUDE.md', 'README.md', join('docs', 'README.md')]) {
    const p = join(base, n);
    if (!existsSync(p)) continue;
    let t = '';
    try {
      if (statSync(p).size > 2 * 1024 * 1024) continue;  // 巨型文档不参与，避免把一切判成「已知」
      t = readFileSync(p, 'utf8');
    } catch { continue; }
    for (const m of t.match(IDENT_TOKEN) || []) set.add(m.toLowerCase());
  }
  return set;
}

/** 一条问题「有多少词已经在项目文档里出现过」。
 *
 *  **这是启发式，不是判据。** 输出里它叫 `docTokenOverlap`，不给判定词 `redundant`。
 *  实测 377 条可算的问题里，这个分数 ≥0.5 的占 13.0%——但逐条看，命中的绝大多数
 *  是「问题里提到了项目里的名字」（例如「要不要支持 /hilltop manage」），
 *  那**不是**在问已知信息。所以本脚本只把它当线索给出，不当缺陷。
 *  @returns {{tokens:number, hit:number, ratio:number}|null}
 */
export function docTokenOverlap(question, docTokens) {
  const toks = new Set((String(question || '').match(IDENT_TOKEN) || []).map((s) => s.toLowerCase()));
  if (!toks.size) return null;
  if (!docTokens || !docTokens.size) return null;
  let hit = 0;
  for (const t of toks) if (docTokens.has(t)) hit++;
  return { tokens: toks.size, hit, ratio: hit / toks.size };
}

// ── C3 的另一半：会话内重复问（**这一半是可判定的**）──────────────────

/** 同一会话里两次问「几乎同一件事」。用字符二元组重合系数（与 `classify-stop.mjs`
 *  的 `relevanceOf` 同口径，0.8 以上算重复）。
 *
 *  为什么这一半可判定、而「重复问已知信息」不可判定：**这里两个文本都是问题**，
 *  比较的是它们彼此；那里要拿问题去比「用户已经说过的所有话」，那是开放集合，
 *  漏一条就判错。实测 588 条问题里，会话内近似重复 5 对（4 个会话）、逐字重复 1 对。
 *  这个数字小到说明「重复问」不是当前的主要毛病——**如实给出，不夸大**。 */
function bigramsOf(s) {
  const t = normalizeText(s);
  const set = new Set();
  if (t.length === 1) set.add(t);
  for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2));
  return set;
}

export function nearDuplicateQuestions(questions, threshold = 0.8) {
  const arr = Array.isArray(questions) ? questions.filter((q) => typeof q === 'string' && q.trim()) : [];
  const pairs = [];
  const grams = arr.map(bigramsOf);
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const A = grams[i]; const B = grams[j];
      if (!A.size || !B.size) continue;
      let inter = 0;
      for (const g of A) if (B.has(g)) inter++;
      const r = inter / Math.min(A.size, B.size);
      if (r >= threshold) pairs.push({ i, j, ratio: Math.round(r * 1000) / 1000 });
    }
  }
  return pairs;
}

// ── 汇总与判定 ────────────────────────────────────────────────────────

/** 把一批会话的扫描结果判成「违规」与否。**判据完全由配置决定**，所以这一层可测。
 *
 *  违规只有两种，都必须是「可机械复现」的：
 *    · `read-first-violation` —— `requireReadFirst: true` 且出现 `ask-first` / `no-read`
 *    · `too-many-questions`   —— **单次调用**里 `questions` 数超过 `maxQuestions`
 *      （`questionsUnknown` 的调用**不参与**：不知道就不许判）
 *
 *  `maxQuestions` 是**每次调用**的上限，不是整场总额。依据是用户原话「一次问清，
 *  最多 5 个」（`pre-write-gate.mjs:725` 的 reason 文案逐字沿用）——它的主语是「一次」。
 *  按整场总额判会把「开了三次会、每次问 3 个」判成超限，而那是正常的迭代提问。
 *
 *  `mode` 的作用：
 *    · `never`  —— 不问是策略，零提问不违规；此时 `requireReadFirst` 校验层已拒绝为 true。
 *    · `always` —— 出现「写了文件但整场零提问」记 `zero-ask`（这是 spec §5.2 的 `ZERO_ASK`
 *                  在**没有待决点清单**时唯一能机械算的形态）。
 *    · `auto`   —— 只对「复杂会话」（写过 ≥AUTO_COMPLEX_FILES 个文件 或
 *                  工具调用 ≥AUTO_COMPLEX_TOOLCALLS）执行 `always` 的判据，
 *                  简单会话免检。阈值是实测常量，不是感觉。
 */
export function judgeSession(session, cfg, { strict = false } = {}) {
  const conf = cfg || defaultConfig();
  const ask = conf.ask || {};
  const mode = ask.mode || 'always';
  const maxQ = Number.isInteger(ask.maxQuestions) ? ask.maxQuestions : 5;
  const violations = [];
  const s = session || {};

  const complex = s.filesWritten >= AUTO_COMPLEX_FILES || s.toolCalls >= AUTO_COMPLEX_TOOLCALLS;
  const enforce = mode === 'always' || (mode === 'auto' && complex);

  const rf = judgeReadFirst(s);
  // `no-read`（一个文件都没看过）与 `ask-first`（读了但在问之后）都违反「先读再问」。
  const rfBad = rf.verdict.effective === 'ask-first' || rf.verdict.effective === 'no-read';

  if (mode !== 'never' && ask.requireReadFirst && rfBad) {
    violations.push({ code: 'read-first-violation', verdict: rf.verdict, detail: rf.at });
  }

  if (mode !== 'never' && enforce) {
    if (s.askCalls === 0 && s.filesWritten > 0) {
      violations.push({ code: 'zero-ask', detail: { filesWritten: s.filesWritten, complex } });
    }
    // 逐次判，不判总额（见上方注释）。
    const over = (s.asks || []).filter((a) => !a.questionsUnknown && a.questionCount > maxQ);
    if (over.length) {
      violations.push({
        code: 'too-many-questions',
        detail: { calls: over.length, worst: Math.max(...over.map((a) => a.questionCount)), max: maxQ },
      });
    }
  }

  if (strict && rfBad && !violations.some((x) => x.code === 'read-first-violation')) {
    // `--strict` 额外把「没读就问」在 auto/never 下也算上。它是给 CI 用的更严口径，
    // **不改变判据本身**，只放宽「什么时候执行这条判据」。
    violations.push({ code: 'read-first-violation', verdict: rf.verdict, detail: rf.at, note: 'strict' });
  }

  return { violations, complex, enforced: enforce, readFirst: rf };
}

/** 哪些违规算「阻塞」（退出码 1），哪些只报告（退出码 0）。
 *
 *  这条区分是被**实测逼出来的**，不是设计洁癖：本机 230 个有工具调用的会话里
 *  153 个（67%）「写了文件却整场零提问」。若它算违规，本脚本**永远红**——
 *  一个永远红的门等于没有门，而「永远红」还会让人开始忽略所有输出。
 *
 *  更根本的理由在 CLAUDE.md 里已经写过：「其余状态是描述，不是判据——
 *  不要用 EXPLORING / PRODUCING / STALLED 去驱动重跑或重拆解」。
 *  `zero-ask` 是同一个位置：它是**当前现实的描述**（这个仓库里 AI 大多数时候不问），
 *  不是一件可以「修好」的事。真正可以称之为缺陷的是 `read-first-violation`
 *  （读了没读是二值的、可复现的）和 `too-many-questions`（用户明确说过「最多 5 个」）。
 *
 *  `zero-ask` 仍然逐会话报出来，只是想让人看见它——**看见 ≠ 判红**。 */
export const BLOCKING_CODES = Object.freeze(['read-first-violation', 'too-many-questions']);
export const ADVISORY_CODES = Object.freeze(['zero-ask']);

/** 从违规计数里算退出码。`--strict` 时 advisory 也升级成阻塞（CI 想更严时用）。 */
export function exitCodeFor(violCounts, { strict = false } = {}) {
  const counts = violCounts || {};
  for (const c of BLOCKING_CODES) if (counts[c]) return 1;
  if (strict) for (const c of ADVISORY_CODES) if (counts[c]) return 1;
  return 0;
}

/** 汇总一批 `{session, meta}`。**纯函数**：调用方负责读盘。 */
export function summarize(rows, cfg, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const verdicts = {
    'read-first': 0, 'ask-first': 0, unattributable: 0, tie: 0, 'no-read': 0, 'no-ask': 0,
  };
  // 窄口径（只认读了文件内容）单独计数：它是更严的那个数，报告里两个都给。
  const narrowVerdicts = { 'read-first': 0, 'ask-first': 0, tie: 0, 'no-read': 0, 'no-ask': 0 };
  let sessions = 0;
  let withAsk = 0;
  let askCalls = 0;
  let questionsKnown = 0;
  let unknownCalls = 0;
  let dupLines = 0;
  let wroteWithoutAsk = 0;
  let complexSessions = 0;
  let nearDupPairs = 0;
  const violCounts = {};
  const out = [];

  for (const r of list) {
    const s = r && r.session ? r.session : r;
    if (!s || !s.toolCalls) continue;
    sessions++;
    askCalls += s.askCalls || 0;
    questionsKnown += s.questionsKnown || 0;
    unknownCalls += s.questionsUnknownCalls || 0;
    dupLines += s.duplicateCallLines || 0;
    const v = judgeReadFirst(s);
    verdicts[v.verdict.effective] = (verdicts[v.verdict.effective] || 0) + 1;
    narrowVerdicts[v.verdict.narrow] = (narrowVerdicts[v.verdict.narrow] || 0) + 1;
    if (s.askCalls) withAsk++;
    if (s.filesWritten > 0 && !s.askCalls) wroteWithoutAsk++;
    const j = judgeSession(s, cfg, opts);
    if (j.complex) complexSessions++;
    for (const x of j.violations) violCounts[x.code] = (violCounts[x.code] || 0) + 1;
    const qs = (s.asks || []).flatMap((a) => (a.questions || []).map((q) => q.question));
    nearDupPairs += nearDuplicateQuestions(qs).length;
    out.push({
      meta: (r && r.meta) || {}, session: s,
      verdict: v.verdict.effective, verdicts: v.verdict, at: v.at,
      violations: j.violations,
    });
  }

  const violations = out.reduce((n, r) => n + r.violations.length, 0);
  return {
    sessions, withAsk, askCalls, questionsKnown, unknownCalls, dupLines,
    wroteWithoutAsk, complexSessions, nearDupPairs,
    verdicts, narrowVerdicts, violCounts, violations, rows: out,
  };
}

// ── 语料遍历 ──────────────────────────────────────────────────────────

/** 读一份 transcript 的全部记录。**读全量，不读尾部**。
 *
 *  这与 `pre-write-gate.mjs` 的 1 MB 尾部窗口**故意不同**，两者不是同一件事：
 *
 *    · 闸门是**热路径**（每次 PreToolUse 都要判），读尾部是因为延迟预算，
 *      `2026-11-14-widened-evidence-sources.md` §4.3 实测尾部 1 MB 是 p50 2.89ms。
 *    · 本脚本是**离线审计**，判的是「第一次读」和「第一次问」谁先发生——
 *      这两个都在会话**开头**。读尾部正好把它们切掉。
 *
 *  实测这条差别不是理论的：本机 485 份主 transcript 里 **70 份 >8MB**（最大 128.6MB）。
 *  用 8MB 尾部窗口跑，提问会话从 54 个掉到 45 个——**漏掉的 9 个恰好是长会话**，
 *  而长会话正是最该审的那批。全量读一遍 2.2 GB 实测 22.9 秒，一次离线审计完全付得起。 */
function readRecords(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return { records: [], bad: 0 }; }
  const records = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { records.push(JSON.parse(s)); } catch { bad++; }
  }
  return { records, bad };
}

function walkMainTranscripts(root) {
  const out = [];
  const walk = (d) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      // 子 agent 的 transcript 里没有「用户发言」，也没有会话级 cwd 语义，
      // 与 measure-execution-phase.mjs 同处置：不计入。
      else if (e.name.endsWith('.jsonl') && !f.includes('subagents')) out.push(f);
    }
  };
  walk(root);
  return out;
}

/** 会话最后活动时间：取最后一条带 timestamp 的记录。
 *  **不用文件 mtime**——`scan-sessions.mjs` 已实测过宿主会追加不含 timestamp 的
 *  元数据行刷新 mtime（241 个文件里 122 个偏差 >24h，最大差 8.4 倍）。 */
function lastActivityOf(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (!rec || typeof rec.timestamp !== 'string') continue;
    const t = Date.parse(rec.timestamp);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** 扫语料。`root` 不存在时**返回错误**，不返回空结果——空结果会被读成「一切正常」。 */
export function scanCorpus({ root, days = 0, cfg, nowMs = Date.now(), strict = false, minReads } = {}) {
  const dir = String(root || join(homedir(), '.claude', 'projects'));
  if (!existsSync(dir)) {
    return { error: `语料目录不存在：${dir}`, rows: [], summary: null };
  }
  const files = walkMainTranscripts(dir);
  const conf = cfg || defaultConfig();
  const mr = Number.isInteger(minReads) ? minReads : (conf.ask && conf.ask.minReads) || 3;
  const cutoff = days > 0 ? nowMs - days * 24 * 3600e3 : null;
  const rows = [];
  let unreadable = 0;
  const forks = [];
  for (const f of files) {
    const { records } = readRecords(f);
    if (!records.length) { unreadable++; continue; }
    const last = lastActivityOf(records);
    if (cutoff !== null && (last === null || last < cutoff)) continue;
    const session = scanSession(records, { minReads: mr });
    if (!session.toolCalls) continue;
    const cwd = records.find((r) => r && typeof r.cwd === 'string')?.cwd || null;
    forks.push({
      meta: { file: f, project: basename(dirname(f)), cwd, lastActivity: last },
      session,
      // `dedupeForks()` 要的两个字段：会话长度（用于挑「最完整的那份」）与调用序列前缀。
      records: records.length,
      mtimeMs: 0,
      sessionId: f,
      seq: (session.seq || []).slice(0, 400),
    });
  }

  // **fork 去重**。实测这条不是洁癖：本机 485 份主 transcript 里有 182 份是同一次
  // 对话的 fork 副本（按首条人类消息分组实测 24 组、多出 182 份），其中 15 组的
  // 前几条 tool_use id **逐字相同**——它们不是「相似的会话」，是同一次会话的多份拷贝。
  // 不合并就会把同一个「没读就问」数 5 遍，百分比也随之失真。
  // 判据直接用 `observe-reality-check.mjs` 的 `dedupeForks()`，不另写一份。
  const { kept, merged } = dedupeForks(forks);
  for (const k of kept) rows.push({ meta: k.meta, session: k.session });

  const summary = summarize(rows, conf, { strict });
  summary.scannedFiles = files.length;
  summary.unreadableFiles = unreadable;
  summary.forkCopiesMerged = merged;
  return { error: null, rows: summary.rows, summary };
}

// ── 渲染 ──────────────────────────────────────────────────────────────

const VERDICT_LABEL = {
  'read-first': '先读后问',
  'ask-first': '先问后读',
  'no-read': '没读就问',
  unattributable: '证据在子 agent 里',
  tie: '同一批消息',
  'no-ask': '没提问',
};

/** 人类可读报告。**最后一行是一句结论**，且结论的措辞随数据变——
 *  不允许「无论如何都说做得不错」那种模板。 */
export function formatReport(result, { cfg, configPath, configFound } = {}) {
  const s = result && result.summary;
  if (!s) return `审计失败：${(result && result.error) || '未知错误'}`;
  const conf = cfg || defaultConfig();
  const mode = conf.ask.mode;
  const lines = [];

  lines.push(`question-audit · 提问形态事后审计`);
  lines.push('');
  lines.push(`配置：${configFound ? configPath : `${CONFIG_FILE}（不存在，用内置默认）`}`);
  lines.push(`        mode=${mode} maxQuestions=${conf.ask.maxQuestions} `
    + `requireReadFirst=${conf.ask.requireReadFirst} minReads=${conf.ask.minReads}`);
  lines.push(`语料：${s.scannedFiles} 份主 transcript，${s.sessions} 个有工具调用的会话`
    + (s.unreadableFiles ? `（${s.unreadableFiles} 份读不到，已跳过——不计入分母）` : ''));
  lines.push('');

  lines.push('## 判据一：问之前读过项目吗（可判定）');
  lines.push('');
  lines.push('  两个口径都算、都列出。用户原话是「了解项目文件夹状态、环境状态」，');
  lines.push('  所以「结构性探索（Glob/Grep/ls）也算」的宽口径更贴那句话；窄口径只认读了文件内容。');
  const asked = s.sessions - (s.verdicts['no-ask'] || 0);
  lines.push(`  提问会话  ${asked} 个（占 ${s.sessions ? ((asked / s.sessions) * 100).toFixed(1) : '0'}%）`);
  const total = asked || 1;
  const show = (obj, indent) => {
    for (const k of ['read-first', 'ask-first', 'unattributable', 'tie', 'no-read']) {
      const n = obj[k] || 0;
      if (!n && k !== 'read-first' && k !== 'ask-first') continue;
      // 不做 padEnd：中文与英文混排时按字符数补齐反而会参差（本仓库有 `width-table.mjs`
      // 专门管这件事，这里不值得为四行表格引入它）。用「标签 + 数字 + 百分比」三段式。
      lines.push(`${indent}${VERDICT_LABEL[k]}：${n} 个（${((n / total) * 100).toFixed(1)}%）`);
    }
  };
  lines.push('  宽口径（含结构性探索）：');
  show(s.verdicts, '    ');
  lines.push('  窄口径（只认读了文件内容，更严）：');
  show(s.narrowVerdicts, '    ');
  lines.push('');

  lines.push('## 判据二：问了几次、每次几问（可判定）');
  lines.push('');
  lines.push(`  提问调用  ${s.askCalls} 次（按 tool_use id 去重；丢弃了 ${s.dupLines} 行重复记录）`);
  lines.push(`  问题总数  ${s.questionsKnown} 个`);
  lines.push(`  形态不可读 ${s.unknownCalls} 次（questions 不是可解析的数组——不知道，不算 0）`);
  const perSess = asked ? (s.questionsKnown / asked).toFixed(1) : '0';
  lines.push(`  平均会话  ${perSess} 个问题 / ${asked ? (s.askCalls / asked).toFixed(1) : 0} 次调用`);
  lines.push('');

  lines.push('## 判据三：有没有重复问已知信息');
  lines.push('');
  lines.push(`  会话内近似重复  ${s.nearDupPairs} 对（可判定：两次提问的字符二元组重合 ≥0.8）`);
  lines.push('  与项目文档的词汇重叠：**不可判定**，见 --json 的 docTokenOverlap');
  const why = ['  为什么不可判定：判据要拿问题去比「用户已经说过的全部内容」，那是开放集合；',
    '  实测 377 条可算的问题里 13.0% 命中 ≥0.5，逐条看绝大多数只是「问句里提到了项目里的名字」',
    '  （例：「要不要支持 /hilltop manage」），不是在问已知信息。把这种当缺陷会逼人删掉好问题。'];
  lines.push(...why);
  lines.push('');

  lines.push('## 判据四：有没有该问而没问');
  lines.push('');
  lines.push(`  写了文件却整场零提问  ${s.wroteWithoutAsk} 个会话`);
  lines.push('  「需求里有歧义词但没问」：**不可判定**——缺「本轮识别出的待决点清单」这个输入。');
  lines.push('  没有那份清单，「没问」与「没必要问」在数据上完全同形。');
  lines.push('');

  if (s.violations) {
    lines.push(`## 违规（按上面那份配置判）`);
    lines.push('');
    const adv = ADVISORY_CODES.filter((c) => s.violCounts[c]);
    for (const [code, n] of Object.entries(s.violCounts)) {
      const kind = ADVISORY_CODES.includes(code) ? '描述（不阻塞）' : '阻塞';
      lines.push(`  ${code.padEnd(22)} ${String(n).padStart(4)}  ${kind}`);
    }
    if (adv.length) {
      lines.push('');
      lines.push('  zero-ask 是**现状的描述**，不是可以「修好」的缺陷：这个仓库里 AI 大多数时候不问。');
      lines.push('  它在这里逐会话列出，只想让人看见；退出码不受它影响（`--strict` 时才升级）。');
      lines.push('  理由同 CLAUDE.md：「其余状态是描述，不是判据」。');
    }
    lines.push('');
  }

  // 一句结论：措辞由数据决定，不是固定模板。
  const rf = s.verdicts['read-first'] || 0;
  const af = s.verdicts['ask-first'] || 0;
  const un = s.verdicts.unattributable || 0;
  const nr = s.verdicts['no-read'] || 0;
  let conclusion;
  if (!asked) {
    conclusion = `结论：语料里没有可判定的提问会话，四条判据都给不出结论。`;
  } else if (af + nr === 0) {
    conclusion = `结论：${asked} 个提问会话里没有一个是「没读就问」`
      + (un ? `（另有 ${un} 个证据落在子 agent 里，判不了，不计入）` : '')
      + `；但这只证明顺序对，不证明问得准——那一条本脚本判不了。`;
  } else {
    conclusion = `结论：${asked} 个提问会话里 ${rf} 个先读后问、${af + nr} 个没读就问`
      + `（${(((af + nr) / asked) * 100).toFixed(1)}%）`
      + (un ? `，${un} 个证据在子 agent 里判不了` : '')
      + `。后者是可用一条命令复算的缺陷。`;
  }
  lines.push(conclusion);
  if (mode === 'never') {
    lines.push('注：ask.mode=never（小众玩法：测模型质量时故意不问）。此时零提问不是缺陷。');
  }
  return lines.join('\n');
}

// ── 命令行 ────────────────────────────────────────────────────────────

/** 严参数解析：**非法值报错，不回落**。
 *  `--days abc` 在本仓库有过一次真实事故（静默回落成 7 天，输出里毫无提示），
 *  所以这里的数字参数一律返回 `NaN` 由调用方报错，绝不 `|| 默认值`。 */
export function parseArgs(argv) {
  const out = { _: [], json: false, strict: false };
  const takeNum = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      out._err = `--${name} 需要一个非负数字（收到：${JSON.stringify(v)}）`;
      return null;   // 不写进 out：留着 undefined，免得调用方误把一个 NaN 当有效值用
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'json' || key === 'strict' || key === 'help') { out[key] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out._err = `--${key} 需要一个值`; continue; }
    i++;
    if (key === 'days') {
      const v = takeNum(next, 'days');
      if (v !== null) out.days = v;
    } else if (key === 'root') out.root = next;
    else if (key === 'config') out.config = next;
    else if (key === 'min-reads') {
      const v = takeNum(next, 'min-reads');
      if (v !== null) out.minReads = Math.floor(v);
    } else out._err = `未知参数 --${key}`;
  }
  return out;
}

const HELP = `question-audit — 提问形态的事后审计（四条判据，两条判不了）

用法：
  node scripts/question-audit.mjs [--days N] [--root <dir>] [--config <file>] [--json] [--strict]

判据：
  C1 问之前读过项目吗    可判定（tool_use 先后顺序，按 id 去重）
  C2 问了几次、每次几问  可判定（questions 不是数组时记「不知道」，不算 0）
  C3 重复问已知信息      会话内近似重复可判定；与文档比词汇重叠不可判定
  C4 该问而没问          不可判定（缺「待决点清单」）；代理指标 = 写了文件却零提问

退出码：0 无阻塞违规 / 1 有阻塞违规（--strict 时 zero-ask 也算）/ 2 配置非法或语料目录读不到
`;

export function cli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(HELP); return 0; }
  if (args._err) {
    console.error(`[question-audit] ${args._err}`);
    console.error('（参数非法即停，不回落默认值——见本脚本 parseArgs 的注释）');
    return 2;
  }

  const loaded = loadConfig(args.config || join(ROOT, CONFIG_FILE));
  if (!loaded.config) {
    console.error('[question-audit] 配置非法，已停止（不回落默认值）：');
    for (const e of loaded.errors) console.error(`  · ${e.path || '(根)'} [${e.code}] ${e.msg}`);
    return 2;
  }

  const result = scanCorpus({
    root: args.root,
    days: Number.isFinite(args.days) ? args.days : 0,
    cfg: loaded.config,
    strict: args.strict === true,
    minReads: Number.isInteger(args.minReads) ? args.minReads : undefined,
  });
  if (result.error) {
    console.error(`[question-audit] ${result.error}`);
    return 2;
  }

  if (args.json) {
    const payload = {
      config: { path: loaded.path, found: loaded.found, effective: loaded.config },
      summary: { ...result.summary, rows: undefined },
      rows: result.summary.rows.map((r) => ({
        project: r.meta.project,
        lastActivity: r.meta.lastActivity ? new Date(r.meta.lastActivity).toISOString() : null,
        toolCalls: r.session.toolCalls,
        askCalls: r.session.askCalls,
        questionsKnown: r.session.questionsKnown,
        questionsUnknownCalls: r.session.questionsUnknownCalls,
        filesRead: r.session.filesRead,
        filesWritten: r.session.filesWritten,
        firstRead: r.session.firstRead,
        firstAsk: r.session.firstAsk,
        verdict: r.verdict,
        verdicts: r.verdicts,
        violations: r.violations.map((v) => v.code),
        // 启发式：只给线索，不给判定词
        docTokenOverlap: docTokenOverlapOfSession(r, loaded.config),
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(formatReport(result, {
      cfg: loaded.config, configPath: loaded.path, configFound: loaded.found,
    }));
  }
  return exitCodeFor(result.summary.violCounts, { strict: args.strict === true });
}

/** JSON 输出里的 C3 线索。**只读，逐会话算**；文档集按 cwd 缓存，避免重复读同一份。
 *  没有 cwd 或文档都没有时返回 null（不假装算过）。 */
function docTokenOverlapOfSession(row, cfg) {
  const cwd = row && row.meta ? row.meta.cwd : null;
  if (!cwd || !existsSync(cwd)) return null;
  const tokens = docTokensOf(cwd);
  if (!tokens.size) return null;
  const qs = (row.session.asks || []).flatMap((a) => (a.questions || []).map((q) => q.question));
  const hits = [];
  for (const q of qs) {
    const o = docTokenOverlap(q, tokens);
    if (o && o.tokens >= 2 && o.ratio >= 0.5) hits.push({ question: q.slice(0, 120), ...o });
  }
  return { considered: qs.length, flagged: hits.length, hits: hits.slice(0, 5), heuristic: true };
}

/** 「我是不是被直接执行」——比的是**真实路径**。`resolve()` 只规范化路径、不解析符号
 *  链接，而 `fileURLToPath(import.meta.url)` 已经是真实路径；通过目录符号链接执行
 *  （`npm link` / `npm i -g .` / pnpm 的 store）时两边必然不等，程序会静默 exit 0、零输出。
 *  realpath 失败（路径不存在）退回 resolve：一次失败不能让正常执行也坏掉。 */
const realOrResolve = (p) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};
if (process.argv[1] && realOrResolve(process.argv[1]) === realOrResolve(fileURLToPath(import.meta.url))) {
  process.exit(cli());
}
