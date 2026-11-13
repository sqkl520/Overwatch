#!/usr/bin/env node
/**
 * compose-agent-prompt.mjs — 把「主线程照着模板填空」换成「主线程只写该写的，其余由机器填」。
 *
 * 为什么需要它：`docs/spec/dispatch-contract.md` §1 规定
 * `prompt = 公共段 + 现写域段 + baseline`，但**没有任何脚本读过 `templates/dispatch.md`**
 * （`docs/research/2026-11-10-agent-roles-audit.md:295` 实测零命中）。于是三段拼装是纯手工约定，
 * 后果全是可复现的：
 *
 *   · 模板里的 `<nonce>` / `<paths>` 是占位符，没人填就原样发给子 agent，
 *     而 `claim-ledger observe` 靠 nonce 归属 transcript —— 归属失败是静默的。
 *   · 验收标准写着「判定前必须逐条跑 `check-structure.mjs`」，
 *     而 `acceptor` 的 tools 是 `Read, Grep, Glob, Write` —— **物理上跑不了**，
 *     它唯一能给的诚实结论是「不通过」。更硬的是：这道矛盾是**硬门强制**的，
 *     `check-structure.mjs` 的 READONLY_ROLES 明令只读角色不得含 Bash。
 *   · 「这个项目用 mvn 不是 npm」这类事实，本来 `scripts/project-commands.mjs` 能读出来，
 *     却要靠主线程记得手写；写错一次，子 agent 就照着错的做。
 *
 * ── 分层：谁写哪一层 ────────────────────────────────────────────────
 *
 * | 层 | 内容 | 谁写 | 变不变 |
 * |---|---|---|---|
 * | L0 身份 | 角色定义正文（职责边界、禁止事项、输出形状） | 人，冻结 | 同一角色跨任务**必须一致** |
 * | L1 协议 | `templates/dispatch.md` 的四输入/纪律/返回四元组/对账 | 仓库，冻结 | 极少变 |
 * | L2 现写 | 任务、验收标准、约束、停机条件 | **主线程，每个任务现写** | 每次不同 |
 * | L3 注入 | 构建/测试命令、硬门输出、baseline、上次失败模式、nonce、outputs | **机器从仓库状态派生** | 自动 |
 *
 * 两条分界规则（本文件的全部设计都从它们推出来）：
 *
 *   1. **机器能派生的，绝不手写。** 手写一个可派生的数字，就多了一个会漂的第二事实源
 *      （`docs/spec/output-format.md` §2.1：「数字只能来自脚本，不得由模型估算」）。
 *   2. **L0 是同一角色跨任务必须逐字相同的那部分。** 它一旦随任务变，
 *      「acceptor」就不再是一个岗位，而是一次性的措辞。
 *
 * 所以主线程**不写整份提示词**，它只写 L2；L0 只给指针（宿主自己加载），L1 与 L3 由本文件填。
 * 这不是「把模板填得更好」，是**把可派生的部分从人手里拿走**——它们漂移过太多次了。
 *
 * ── 提示词本身也要可对账 ────────────────────────────────────────────
 *
 * 光有「必填元素清单」只能证明**你填了**，不能证明**发出去的就是它**。所以 compose 时把
 * 成品 hash 记进 `prompts.jsonl`；收活时 `verify` 从子 agent transcript 的**第一条 user 消息**
 * 取正文重算 hash。这条链成立的前提已实测：本机 80/80 份子 agent transcript 的首条 user
 * 消息与父会话 `Agent` 工具调用的 `prompt` 参数**逐字节相同**（2026-11-14，本文件复核）。
 *
 * ── 用法 ───────────────────────────────────────────────────────────
 *
 *   # 派发前：从 task-graph.json 的子树生成提示词（L2 现写部分取自图，L3 自动注入）
 *   node scripts/compose-agent-prompt.mjs compose --run 2026-11-14-x --task ST1 \
 *     --graph tasks/runs/2026-11-14-x/task-graph.json --role acceptor \
 *     --stop "≤25 行输出；每项 AC 必带 file:line；找不到证据即判不通过" \
 *     --gate "node scripts/check-structure.mjs=tasks/runs/2026-11-14-x/gate-structure.txt" \
 *     --out tasks/runs/2026-11-14-x/ST1-acceptor.prompt.md
 *
 *   # 只看检查结果，不落文件（--dry-run）
 *   node scripts/compose-agent-prompt.mjs compose --run r --task ST1 --graph g.json --role review --dry-run
 *
 *   # 收活时：确认子 agent 实际收到的就是这份
 *   node scripts/compose-agent-prompt.mjs verify --run 2026-11-14-x --session <会话目录> [--task ST1]
 *
 * 退出码：0 = 通过；1 = 检查不过（拒绝派发）；2 = 用法错误。
 *
 * 零依赖。除 compose / verify 追加台账外不写盘。
 */

import {
  readFileSync, existsSync, mkdirSync, appendFileSync, statSync, readdirSync,
  openSync, readSync, closeSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectProjectCommands } from './project-commands.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export const PROMPT_LEDGER_VERSION = 1;

/** 提示词台账文件名。与 `claims.jsonl` 同目录、同一 append-only 纪律：
 *  没有任何「修改」操作，所以崩溃只丢最后几行，不会把已记录的事实改坏。 */
export const PROMPT_LEDGER_FILE = 'prompts.jsonl';

/** 四层。顺序即「从最稳定到最易变」，compose 也按这个顺序拼。 */
export const LAYERS = Object.freeze([
  {
    id: 'L0',
    name: '身份',
    author: '人（冻结）',
    source: '.claude/agents/<role>.md',
    rule: '同一角色跨任务必须逐字相同；compose 只放指针，不复制正文（宿主自己加载它）',
  },
  {
    id: 'L1',
    name: '协议',
    author: '仓库（冻结）',
    source: 'templates/dispatch.md',
    rule: '四输入、证据纪律、返回四元组、nonce 与产出登记；整段内联，保证同一个 run 里每份一字不差',
  },
  {
    id: 'L2',
    name: '现写',
    author: '主线程（每个任务现写）',
    source: 'task-graph.json 的子树 + 手写段落',
    rule: '任务、验收标准、约束、停机条件。**换一个任务就会错**的那部分才是它',
  },
  {
    id: 'L3',
    name: '注入',
    author: '机器（从仓库状态派生）',
    source: 'project-commands.mjs / task-graph.outputs / claims.jsonl / git / 注入的硬门输出',
    rule: '能派生的绝不手写——手写就多一个会漂的第二事实源',
  },
]);

/** 验收标准里一条判定项「要做什么才能核实」。三种，互斥。
 *
 *  这一层是整份文件的核心：它把「验收标准」从散文变成**可执行的需求**，
 *  从而能和角色的工具白名单做机械比对。今晚那条矛盾的唯一出路就是这个比对。 */
export const OBLIGATION_KINDS = Object.freeze([
  {
    id: 'command',
    label: '跑一条命令',
    needs: ['Bash'],
    note: '判定项点名了一条命令（`node scripts/x.mjs` / `npm run t` / `mvn ...`）',
  },
  {
    id: 'file',
    label: '读一个可引用位置',
    needs: ['Read'],
    note: '判定项要求 file:line、原文引述或某个磁盘文件',
  },
  {
    id: 'decision',
    label: '纯判断',
    needs: [],
    note: '判定项要求一个判断（「接口是否暴露到公网」），不需要额外工具',
  },
]);

/** 判据不是命令的动词。顺序无关，只做前缀/首词匹配。
 *  刻意不收 `git`：`git status` 常被写进「第三方复算清单」，但它不产生判定证据，
 *  收了会让每一份 AC 都变成 command 类，检查失去区分度。 */
const COMMAND_VERBS = Object.freeze([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'mvn', 'mvnw', 'gradle', 'gradlew',
  'cargo', 'go', 'pytest', 'python', 'python3', 'dotnet', 'make', 'tsc', 'bash', 'sh',
]);

/** 必须已被主线程填掉的占位符。**只查这几个具名占位符**——
 *  `dispatch.md` 的输出示例里有 `<路径 或 关键结论>` 这类合法占位，不能一并拦。 */
export const REQUIRED_PLACEHOLDERS = Object.freeze(['<run-id>', '<task-id>', '<nonce>', '<paths>']);

/** 角色的「独立性」约束：这些键一旦出现在 L2 上下文里，子 agent 就被锚定了。
 *  依据 `docs/spec/dispatch-contract.md` §3 与各角色定义里「不要读…」那几句。
 *
 *  为什么由 compose 拦而不是在 prompt 里写「请不要读」：契约 §3 的原话是
 *  「不靠 prompt 里写请不要读，靠不提供路径」。compose 是唯一知道「提供了什么」的地方。 */
export const FORBIDDEN_CONTEXT = Object.freeze({
  review: ['self_assessment', 'execution_log', 'weak_points'],
  acceptor: ['self_assessment', 'execution_log', 'weak_points', 'review_score'],
  redteam: ['self_assessment', 'weak_points'],
  critic: ['executor_output', 'review_score'],
  probe: ['reasoning_text'],
  safety: ['relay_rationale'],
});

/** 提示词必须有的元素。**每一条都是可机械判定的**——判不了的规则不配进这张表，
 *  否则它又会退化成一句「请务必包含」。
 *
 *  为什么必须有 `stop_condition`：这是唯一被实测证明能提高完成率的干预。
 *  窄任务（只跑一条 grep、5 分钟返回）5 分 25 秒完成 7,138 字节；
 *  宽任务（扫 6 个维度、12 分钟返回）9 分钟后仍是 75 字节骨架。
 *  原话「差异不在模型能力，在任务是否有明确的停机条件」
 *  （`docs/research/2026-11-14-prompt-based-multiagent-limits.md` §3.4）。 */
export const REQUIRED_ELEMENTS = Object.freeze([
  { id: 'role', label: '角色引用（L0 指针）', why: '没有角色则身份由措辞临时定义，跨任务不可比' },
  { id: 'task', label: '任务书（逐字）', why: '转述会被优化成一个错误的目标（契约 §2 #1）' },
  { id: 'acceptance', label: '验收标准（非空、含否决条件）', why: '标准不能事后编（硬约束 4）' },
  { id: 'shape', label: '产出形态', why: '无法判定「长时间无 Write 是否异常」（硬约束 8）' },
  { id: 'outputs', label: '产出路径声明', why: '收活对账的唯一期望来源（claim-ledger declare）' },
  { id: 'stop_condition', label: '停机条件（可判定）', why: '唯一被实测证明能提高完成率的干预' },
  { id: 'nonce', label: 'nonce', why: 'observe 靠它把 transcript 归属到任务，缺失是静默失败' },
  { id: 'tool_compat', label: '验收需求 × 工具白名单相容', why: '不相容时子 agent 只会判「不通过」——今晚那条矛盾的根' },
  { id: 'independence', label: '未注入被禁止的上下文', why: '锚定无法用 prompt 撤销，只能靠不提供（契约 §3）' },
]);

/** 不可判定的停机条件措辞。命中且**没有**任何量化界限时判不通过。 */
const VAGUE_STOP = /尽可能|尽量|全面|彻底|充分|深入|酌情|视情况|合理|适当|等等/;

// ── frontmatter / 角色工具集 ──────────────────────────────────────────

/** 极简 frontmatter 解析：支持 `key: value` 与 `key: |` 块。足够读 `tools:`。 */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return null;
  const out = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, inline] = kv;
    if (inline === '|' || inline === '>' || inline === '|-') {
      const block = [];
      let j = i + 1;
      while (j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === '')) { block.push(lines[j].trim()); j++; }
      out[key] = block.join(' ').trim();
      i = j - 1;
    } else {
      out[key] = inline.trim();
    }
  }
  return out;
}

/** 一个角色定义 → 它的工具白名单。
 *
 *  `tools` 整行缺失时宿主语义是「继承全部工具」。这比写错更危险——白名单静默变成全开，
 *  所以 `inheritAll: true` 必须被 compose 当成「无法判定」而不是「什么都能干」。 */
export function roleTools(agentText) {
  const fm = parseFrontmatter(agentText);
  if (!fm) return { tools: [], inheritAll: false, missingFrontmatter: true };
  if (fm.tools === undefined) return { tools: [], inheritAll: true, missingFrontmatter: false };
  const tools = String(fm.tools).split(',').map((s) => s.trim()).filter(Boolean);
  return { tools, inheritAll: false, missingFrontmatter: false };
}

// ── 判定项分类 ────────────────────────────────────────────────────────

/** 从一段文字里抽出「被点名要跑的命令」。
 *
 *  只认**首词是已知命令动词**的片段，且优先取反引号里的内容——那是「这是一条命令」的
 *  唯一可靠信号。刻意不做自然语言理解：猜错的后果是编出一条不存在的命令，
 *  比漏检更坏（`project-commands.mjs` 开头讲的是同一件事）。
 *
 *  命令尾部的散文必须切掉（`node x.mjs 全绿` → `node x.mjs`）：
 *  不切的话，同一条命令在 AC 里与在 `--gate` 里会得到两个字符串，
 *  「注入是否覆盖了这条 AC」永远判为否 —— 那会把所有注入都变成无效的。 */
export function extractCommands(text) {
  const s = String(text || '');
  const found = [];
  const push = (raw) => {
    const c = raw.trim().replace(/^`|`$/g, '').trim();
    if (!c) return;
    const first = c.split(/\s+/)[0].replace(/\.(cmd|exe)$/i, '').toLowerCase();
    if (!COMMAND_VERBS.includes(first)) return;
    // 切到第一个非命令字符为止：中文、箭头、括号、全角标点。
    // 命令与参数只可能由 ASCII 可见字符、空格和常见的 shell 符号组成。
    const clean = (c.split(/[^\x20-\x7e]/)[0] || '')
      .replace(/\s*[→|].*$/, '')
      .replace(/\s+(?:全绿|通过|必须|输出|应|且|并)$/u, '')
      .trim();
    if (clean && !found.includes(clean)) found.push(clean);
  };
  // 1) 反引号里的命令（最可靠）
  for (const m of s.matchAll(/`([^`]+)`/g)) push(m[1]);
  // 2) 裸写的 `node scripts/x.mjs`（兜底）
  for (const m of s.matchAll(/(?:^|[\s(（])((?:node|npm|npx|pnpm|yarn|mvn|mvnw|gradle|gradlew|cargo|go|pytest|python3?|dotnet|make|tsc)\s+[^\s，。；、]+(?:\s+[^\s，。；、]+)*)/g)) push(m[1]);
  return found;
}

/** 一条判定项 → `{kind, commands, files}`。
 *
 *  顺序即优先级：命令 > 文件 > 纯判断。
 *  这个顺序是刻意的——一条同时提到命令和文件的 AC，**难点是跑命令**，
 *  按文件算会让「acceptor 跑不了命令」这条矛盾被静默放过。 */
export function classifyRequirement(criterion) {
  const s = String(criterion || '');
  const commands = extractCommands(s);
  if (commands.length) return { kind: 'command', commands, files: [] };
  const files = [];
  for (const m of s.matchAll(/(?:^|[\s`(（])([A-Za-z0-9_][\w./-]*\.(?:md|mjs|js|json|mjs|py|java|ts|yml|yaml|txt)(?::\d+)?)/g)) {
    const f = m[1];
    if (!files.includes(f)) files.push(f);
  }
  if (files.length) return { kind: 'file', commands: [], files };
  return { kind: 'decision', commands: [], files: [] };
}

/** 判定项分类结果 → 这个角色必须具备的工具。
 *  多个判定项取并集（一条 AC 要跑命令，整个角色就得能跑命令）。 */
export function requiredTools(acceptance) {
  const need = new Set();
  for (const ac of acceptance || []) {
    const c = classifyRequirement(ac && (ac.criterion || ac));
    const spec = OBLIGATION_KINDS.find((k) => k.id === c.kind);
    for (const t of spec ? spec.needs : []) need.add(t);
  }
  return [...need];
}

/** 名字里是否带写工具，用于提示「只读角色 + 命令类 AC」这条矛盾的方向。 */
const WRITEISH = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);

// ── 检查 ──────────────────────────────────────────────────────────────

/** 停机条件是否可判定。
 *
 *  判定规则：至少有一条**可数的界限**——点名命令、带数字的配额、或时间上限。
 *  只有形容词的停机条件等于没有（「尽可能全面」永远满足不了，也永远不算违约）。 */
export function stopConditionProblem(stop) {
  const s = String(stop || '').trim();
  if (!s) return '缺失——没有停机条件的任务，产出一律退化成骨架';
  const hasCommand = extractCommands(s).length > 0;
  const hasNumber = /\d+\s*(?:分钟|分|秒|行|个|次|条|字节|份|处|files?|min|sec|lines?|bytes?)/i.test(s)
    || /\b≤\s*\d|<\s*\d/.test(s);
  if (hasCommand || hasNumber) return null;
  if (VAGUE_STOP.test(s)) return `只有形容词（"${s.slice(0, 24)}"）——不可判定，等于没有停机条件`;
  return '没有任何可数量界限（命令 / 数字配额 / 时间上限）——不可判定';
}

/** 核心检查。纯函数，不读盘；仓库状态由调用方作为参数注入。
 *
 *  返回 `{ok, checks[], errors[], warnings[]}`。`checks` 按 REQUIRED_ELEMENTS 逐项给结果，
 *  这就是「提示词的可对账清单」——每一项都能回答「凭什么说它满足」。
 *
 *  `roleText` 让工具相容性可判；传 null 表示调用方自己已解析（测试与 CLI 都走这条）。 */
export function checkPromptSpec({
  role,
  roleText = null,
  task,
  acceptance = [],
  shape,
  outputs = [],
  stopCondition,
  nonce,
  injected = [],
  context = {},
} = {}) {
  const errors = [];
  const warnings = [];
  const checks = [];
  /** 记一项检查。`failDetail` 只在不过时说（过的时候说它，读起来像在报错）；
   *  `okDetail` 是「凭什么说过」——对账清单要能回答这个问题，否则它只是打勾。 */
  const mark = (id, ok, failDetail, okDetail = '') => {
    checks.push({ id, ok, detail: ok ? okDetail : failDetail });
    if (!ok) errors.push(`${id}: ${failDetail}`);
    return ok;
  };

  // 1) L0 角色
  mark('role', typeof role === 'string' && !!role.trim(), '缺角色：身份会由措辞临时定义，跨任务不可比', `角色 ${role || '(空)'}`);

  // 2) 任务书
  //
  //  阈值刻意低（6 字符）。这道门要挡的是「空」与「一个词」，不是「写得不够好」——
  //  门调得过严会被关掉，而关掉之后什么都不剩（`docs/research/2026-11-14-observe-mode-reality-check.md`
  //  记的正是这件事：阈值 3 在真实项目上会拦 19.9%，其中 88.9% 是误伤）。
  const taskText = typeof task === 'string' ? task.trim() : '';
  mark('task', taskText.length >= 6,
    `任务书过短或缺失（${taskText.length} 字符）——转述会被优化成一个错误的目标`,
    `任务书 ${taskText.length} 字符`);
  if (taskText.length >= 6 && taskText.length < 20) {
    warnings.push(`task: 任务书只有 ${taskText.length} 字符——像一句标题而不是任务书；`
      + '宽任务书与 75 字节骨架的对应关系是实测过的');
  }

  // 3) 验收标准：非空 + 每项含 id/criterion/evidence/fail_if
  const acs = Array.isArray(acceptance) ? acceptance : [];
  const acProblems = [];
  if (!acs.length) acProblems.push('为空——验收标准不能事后编（硬约束 4）');
  acs.forEach((ac, i) => {
    const p = `AC${i + 1}`;
    if (!ac || typeof ac !== 'object') { acProblems.push(`${p} 不是对象`); return; }
    for (const k of ['id', 'criterion', 'evidence', 'fail_if']) {
      if (!ac[k] || !String(ac[k]).trim()) acProblems.push(`${p} 缺 ${k}`);
    }
  });
  mark('acceptance', acProblems.length === 0, acProblems.join('；'),
    `${acs.length} 项，每项含 id/criterion/evidence/fail_if`);

  // 4) 产出形态
  const shapes = ['artifact', 'exploration', 'hybrid'];
  const outs = Array.isArray(outputs) ? outputs : [];
  mark('shape', shapes.includes(shape), `产出形态必须是 ${shapes.join(' / ')} 之一（硬约束 8）`,
    shape ? `${shape}${shape === 'artifact' ? ` · ${outs.length} 个产出路径` : ''}` : '');

  // 5) 产出路径
  const outOk = shape === 'artifact' ? outs.length > 0 : true;
  mark('outputs', outOk, shape === 'artifact'
    ? 'artifact 必须声明 outputs：收活时对账靠它，空数组会让 verify 判 NO-EXPECTATION'
    : '',
    outs.length ? `${outs.length} 个路径` : (shape === 'artifact' ? '' : `${shape} 允许为空`));

  // 6) 停机条件
  const sp = stopConditionProblem(stopCondition);
  mark('stop_condition', !sp, sp || '', `可判定：${String(stopCondition).trim().slice(0, 40)}`);

  // 7) nonce
  mark('nonce', typeof nonce === 'string' && /^[0-9a-f]{8}$/i.test(nonce),
    '缺 8 位十六进制 nonce——observe 归属失败是静默的，不是报错', `nonce ${nonce}`);

  // 8) 工具白名单 × 验收需求
  //
  //  这是整份文件的要害。规则：
  //    验收要跑命令 ⇒ 角色必须有 Bash，**或**该命令的输出已被主线程跑过并注入（L3）。
  //  第二条出路是刻意的：`acceptor` 被设计成不跑命令（且硬门强制这一点），
  //  正确的修法不是给它 Bash，而是把硬门结果当作事实注入，让验收变成可 Read 核对的。
  if (roleText !== null && roleText !== undefined) {
    const { tools, inheritAll, missingFrontmatter } = roleTools(roleText);
    if (missingFrontmatter) {
      mark('tool_compat', false, '角色定义读不到 frontmatter，无法判定工具白名单');
    } else if (inheritAll) {
      mark('tool_compat', false, '角色定义省略了 tools 整行——宿主语义是「继承全部工具」，白名单静默变成全开');
    } else {
      const need = requiredTools(acs);
      const uncovered = [];
      const coveredBy = [];
      for (const t of need) {
        if (tools.includes(t)) { coveredBy.push(`${t}（角色自带）`); continue; }
        // Bash 缺失但有注入证据 → 允许（L3 替它跑了）
        if (t === 'Bash') {
          const injectedCmds = new Set((injected || []).map((x) => String(x && x.command || '').trim()));
          const missing = [];
          for (const ac of acs) {
            const c = classifyRequirement(ac && ac.criterion);
            if (c.kind !== 'command') continue;
            for (const cmd of c.commands) {
              if (injectedCmds.has(cmd)) coveredBy.push(`\`${cmd}\`（L3 注入）`);
              else missing.push(`${ac.id || '?'}: \`${cmd}\``);
            }
          }
          if (missing.length) uncovered.push(`需要 Bash 但角色没有，且未注入其输出 → ${missing.join('、')}`);
        } else {
          uncovered.push(`需要 ${t} 但角色没有`);
        }
      }
      mark('tool_compat', uncovered.length === 0,
        `${uncovered.join('；')}。两条出路：① 换成有该工具的角色；② 若确实不该给它，就把该命令的结果作为注入证据（--gate）`,
        coveredBy.length ? `已覆盖 ${coveredBy.join('、')}` : '验收不需要额外工具');
    }
  } else {
    checks.push({ id: 'tool_compat', ok: true, detail: '调用方未提供角色正文，跳过（由 CLI 负责解析）' });
  }

  // 9) 独立性
  const forbidden = FORBIDDEN_CONTEXT[role] || [];
  const present = forbidden.filter((k) => context && Object.prototype.hasOwnProperty.call(context, k));
  mark('independence', present.length === 0,
    `注入了不该给 ${role} 的内容：${present.join(', ')}——锚定无法用 prompt 撤销（契约 §3）`,
    forbidden.length ? `未注入 ${forbidden.join('/')}` : '该角色无额外禁止项');

  // 附带的提示项（不阻塞）
  if (Array.isArray(acs) && acs.length && acs.length < 2) {
    warnings.push('acceptance: 只有 1 条判定项——单条标准无法区分「部分完成」与「完整完成」');
  }
  for (const ac of acs) {
    const c = classifyRequirement(ac && ac.criterion);
    if (c.kind === 'decision' && !/不通过|不存在|未暴露|未出现|无/.test(String(ac && (ac.criterion || '')))) {
      warnings.push(`${ac && ac.id ? ac.id : '?'}: 判据既不含命令也不含文件，且未给出「什么情况算失败」的具体形态——'
        + '验收 Agent 可能给出主观判定`);
    }
  }
  const needToolsNow = requiredTools(acs);
  if (needToolsNow.includes('Bash') && roleText) {
    const { tools } = roleTools(roleText);
    if (tools.some((t) => WRITEISH.includes(t)) && !tools.includes('Write')) {
      warnings.push('该角色有 Bash 却无 Write——若验收需要落报告，请确认报告写到哪');
    }
  }

  return { ok: errors.length === 0, checks, errors, warnings };
}

// ── L3 注入 ───────────────────────────────────────────────────────────

/** 从仓库状态派生 L3。**这一层的内容一律不手写。**
 *
 *  `root` 可替换，测试用临时目录；`project` 可注入以避免读盘（纯函数化）。
 *
 *  刻意不注入的东西：会话 ID、绝对路径（可发布区禁盘符）、其他 agent 的结论。
 */
export function deriveInjected({
  root = ROOT,
  project = null,
  outputs = [],
  nonce = null,
  injected = [],
  priorFailure = null,
  nowMs = Date.now(),
} = {}) {
  const proj = project || detectProjectCommands(root);
  const facts = [];
  facts.push({
    label: '构建/测试命令',
    value: proj.test ? `\`${proj.test}\`` : '未识别出测试命令（不是「没有测试」，是「我没认出来」）',
    source: proj.source ? `读 ${proj.source}` : '仓库根没有可识别的标志文件',
  });
  if (proj.build) {
    facts.push({ label: '构建命令', value: `\`${proj.build}\``, source: proj.source || 'unknown' });
  }
  facts.push({
    label: '项目类型',
    value: proj.kind || 'unknown',
    source: 'scripts/project-commands.mjs 的 detectProjectCommands',
  });
  if (outputs && outputs.length) {
    facts.push({
      label: '本次要产出的文件',
      value: outputs.map((p) => `\`${p}\``).join('、'),
      source: 'task-graph.json 的 subtrees[].outputs（派发前已声明）',
    });
  }
  if (nonce) {
    facts.push({ label: 'nonce', value: `\`${nonce}\``, source: 'claim-ledger declare 生成' });
  }
  for (const g of injected || []) {
    const cmd = String(g && g.command || '').trim();
    if (!cmd) continue;
    facts.push({
      label: '硬门结果（已由主线程跑过）',
      value: `\`${cmd}\` → ${g.exitCode == null ? '结果见注入文件' : `exit ${g.exitCode}`}`
        + (g.path ? `，输出在 \`${g.path}\`` : '') + (g.sha256 ? `（sha256 ${g.sha256.slice(0, 12)}…）` : ''),
      source: '主线程在派发前执行并注入',
    });
  }
  if (priorFailure) {
    facts.push({
      label: '上次失败模式（负面约束，不是缩小范围）',
      value: String(priorFailure).trim(),
      source: 'claims.jsonl / 上一轮验收结论',
    });
  }
  facts.push({
    label: '时间',
    value: new Date(nowMs).toISOString(),
    source: '派发时刻',
  });
  return { facts, project: proj };
}

// ── 拼装 ──────────────────────────────────────────────────────────────

/** 读取 `templates/dispatch.md` 并填掉具名占位符。
 *
 *  填不掉的地方**不静默保留**：留下的 `<nonce>` 会让 observe 归属失败，
 *  而失败是静默的——所以 compose 在这里直接判错。 */
export function fillDispatchTemplate(templateText, { run, task, nonce, paths = [] }) {
  let t = String(templateText || '');
  const missing = [];
  const sub = (token, value) => {
    if (!t.includes(token)) return;
    if (!value) { missing.push(token); return; }
    t = t.split(token).join(value);
  };
  sub('<run-id>', run);
  sub('<task-id>', task);
  sub('<nonce>', nonce);
  sub('<paths>', paths.length ? paths.map((p) => `- ${p}`).join('\n') : null);
  const leftover = REQUIRED_PLACEHOLDERS.filter((p) => t.includes(p));
  return { text: t, missing: [...new Set([...missing, ...leftover])] };
}

/** 生成提示词正文。**顺序 = L0 指针 → L1 协议 → L2 现写 → L3 注入。**
 *
 *  为什么把 L3 放最后：它是唯一「可能被误当结论」的一层（硬门输出、上次失败模式）。
 *  放在 L2 之后，读者先看到「要判什么」，再看「已有什么事实」，不容易把事实当判定。 */
export function composePrompt({
  role,
  task,
  acceptance = [],
  shape,
  outputs = [],
  stopCondition,
  nonce,
  constraints = [],
  context = {},
  injectedFacts = [],
  dispatchTemplate = '',
  run = null,
  taskId = null,
  roleSource = null,
} = {}) {
  const lines = [];
  const acs = Array.isArray(acceptance) ? acceptance : [];

  lines.push(`<!-- 由 scripts/compose-agent-prompt.mjs 生成 · task ${taskId || '(未命名)'} · role ${role || '(未命名)'}`
    + `${nonce ? ` · nonce ${nonce}` : ''} -->`);
  lines.push('<!-- L0 身份来自 .claude/agents/<role>.md（宿主加载，本文件只放指针，不复制正文） -->');
  lines.push('');

  // L0
  lines.push('## 0. 身份（L0）');
  lines.push('');
  lines.push(`你以 \`${roleSource || `.claude/agents/oversight-${role}.md`}\` 定义的身份工作。`
    + '**不要**按本文重设身份；那一份是冻结点，本文只补它在「这一次任务」里缺的东西。');
  lines.push('');

  // L1
  if (dispatchTemplate) {
    lines.push('## 1. 派发公共协议（L1 · 逐字，未改写）');
    lines.push('');
    lines.push(dispatchTemplate.trim());
    lines.push('');
  }

  // L2
  lines.push('## 2. 本次任务（L2 · 主线程现写）');
  lines.push('');
  lines.push(String(task || '').trim() || '(缺失)');
  lines.push('');

  lines.push('### 2.1 验收标准（派发前已声明，事后不得增补）');
  lines.push('');
  if (acs.length) {
    lines.push('| # | 判定项 | 证据形式 | 直接否决条件 | 怎么核实 |');
    lines.push('|---|---|---|---|---|');
    const injectedCmds = new Set((injectedFacts || [])
      .filter((f) => f && f.label === '硬门结果（已由主线程跑过）')
      .map((f) => String(f.value || '')));
    for (const ac of acs) {
      const c = classifyRequirement(ac && ac.criterion);
      let how;
      if (c.kind === 'command') {
        const covered = c.commands.every((cmd) => [...injectedCmds].some((v) => v.includes(cmd)));
        how = covered ? '已在 L3 注入输出——读那份输出核对，不必自己跑' : `需跑 ${c.commands.map((x) => `\`${x}\``).join('、')}`;
      } else if (c.kind === 'file') {
        how = `读 ${c.files.slice(0, 3).map((f) => `\`${f}\``).join('、')}`;
      } else {
        how = '纯判断（无需额外工具）';
      }
      lines.push(`| ${ac.id || ''} | ${ac.criterion || ''} | ${ac.evidence || ''} | ${ac.fail_if || ''} | ${how} |`);
    }
  } else {
    lines.push('(缺失——验收标准不能事后编)');
  }
  lines.push('');

  if (constraints.length) {
    lines.push('### 2.2 本次约束');
    lines.push('');
    for (const c of constraints) lines.push(`- ${c}`);
    lines.push('');
  }

  lines.push('### 2.3 停机条件（唯一被实测证明能提高完成率的干预）');
  lines.push('');
  lines.push(String(stopCondition || '').trim() || '(缺失)');
  lines.push('');

  // L3
  lines.push('## 3. 本项目事实（L3 · 机器注入，不要手抄，也不要改）');
  lines.push('');
  lines.push('> 这一节由脚本从仓库状态派生。**它比其他任何地方的数字都新**——');
  lines.push('> 如果你在别处看到与之矛盾的数字，以这里为准，并在返回里指出那处矛盾。');
  lines.push('');
  if (injectedFacts.length) {
    lines.push('| 项 | 值 | 取自 |');
    lines.push('|---|---|---|');
    for (const f of injectedFacts) {
      lines.push(`| ${f.label} | ${String(f.value).replace(/\|/g, '\\|')} | ${f.source || ''} |`);
    }
  } else {
    lines.push('(无注入事实)');
  }
  lines.push('');

  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  return { markdown: body, layers: LAYERS.map((l) => l.id) };
}

// ── 提示词台账 ────────────────────────────────────────────────────────

/** 计算 hash 前的归一化。只做两件**无损**的事：CRLF → LF，去掉首尾空白。
 *
 *  为什么不做「去掉空行」这类清洗：那样两个不同的提示词会算出同一个 hash，
 *  台账就再也证明不了「发出去的是这一份」。 */
export function normalizeForHash(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
}

export function promptHash(text) {
  return createHash('sha256').update(normalizeForHash(text), 'utf8').digest('hex');
}

export function makePromptRow({ run, task, role, hash, bytes, checks = [], nowMs = Date.now() }) {
  return {
    v: PROMPT_LEDGER_VERSION,
    ts: new Date(nowMs).toISOString(),
    kind: 'prompt',
    run: String(run),
    task: String(task),
    role: role ? String(role) : null,
    hash: String(hash),
    bytes: Number(bytes) || 0,
    ok: (checks || []).every((c) => c.ok !== false),
  };
}

export function readPromptLedger(file) {
  const rows = [];
  const badLines = [];
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return { rows, badLines, exists: false }; }
  text.split('\n').forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    let r;
    try { r = JSON.parse(s); } catch { badLines.push({ line: i + 1, raw: s.slice(0, 120) }); return; }
    if (!r || typeof r !== 'object' || r.kind !== 'prompt') { badLines.push({ line: i + 1, raw: s.slice(0, 120) }); return; }
    rows.push(r);
  });
  return { rows, badLines, exists: true };
}

/** 从子 agent transcript 头部取「第一条 user 消息」的正文。
 *
 *  为什么是这一条：实测 80/80 份子 agent transcript 的首条 user 消息与父会话
 *  `Agent` 工具调用的 `prompt` 参数逐字节相同（2026-11-14）。所以它同时是
 *  「主线程写了什么」和「子 agent 收到什么」的唯一交汇点。 */
export function firstUserText(records) {
  for (const r of records || []) {
    if (!r || r.type !== 'user' || !r.message) continue;
    const c = r.message.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const t = c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
      if (t) return t;
    }
  }
  return null;
}

/** 读文件头部若干字节并按行解析成 JSON 记录。读不到返回 `{records: [], truncated}`。 */
export function readHeadRecords(file, maxBytes = 512 * 1024) {
  let fd;
  try {
    const st = statSync(file);
    const n = Math.min(maxBytes, st.size);
    const buf = Buffer.allocUnsafe(n);
    fd = openSync(file, 'r');
    const got = readSync(fd, buf, 0, n, 0);
    const text = buf.subarray(0, got).toString('utf8');
    const lines = text.split('\n');
    // 最后一行可能是被截断的半行：丢掉它，不要让它变成一条假记录
    const complete = lines.slice(0, -1);
    const records = [];
    for (const l of complete) {
      const s = l.trim();
      if (!s) continue;
      try { records.push(JSON.parse(s)); } catch { /* 跳过坏行 */ }
    }
    return { records, truncated: got >= n };
  } catch {
    return { records: [], truncated: false, missing: true };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 找会话目录下的子 agent transcript（只扫一层，compose 的 verify 不需要递归那么全）。 */
export function subagentFiles(sessionPath) {
  const p = String(sessionPath || '');
  const bases = [];
  if (p.endsWith('.jsonl')) bases.push(p.slice(0, -'.jsonl'.length));
  bases.push(p);
  for (const b of bases) {
    const dir = join(b, 'subagents');
    if (!existsSync(dir)) continue;
    try {
      return readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl')).map((f) => join(dir, f));
    } catch { /* ignore */ }
  }
  return [];
}

/** 对账：台账里记的 hash vs 子 agent 实际收到的那条消息的 hash。
 *
 *  返回 `[{task, role, expected, actual, match, file}]`。
 *  `match:null` 表示「找不到对应的 transcript」——**这不是通过**，
 *  是「看不到」。两者必须分开，否则「没收到」和「收到了另一份」长得一样。 */
export function verifyPrompts({ rows, sessionPath, task = null }) {
  const files = subagentFiles(sessionPath);
  const wanted = (rows || []).filter((r) => r && r.kind === 'prompt' && (!task || r.task === task));
  const out = [];
  const used = new Set();
  for (const row of wanted) {
    let hit = null;
    for (const f of files) {
      if (used.has(f)) continue;
      const { records } = readHeadRecords(f);
      const text = firstUserText(records);
      if (!text) continue;
      if (promptHash(text) === row.hash) { hit = { file: f, text }; break; }
    }
    if (!hit) {
      // 没命中也可能是「这份 transcript 在，但 hash 不同」——把最像的那份报出来
      let closest = null;
      for (const f of files) {
        const { records } = readHeadRecords(f);
        const text = firstUserText(records);
        if (!text) continue;
        if (row.task && text.includes(row.task) && !closest) closest = f;
      }
      out.push({ task: row.task, role: row.role, expected: row.hash, actual: null, match: closest ? false : null, file: closest });
      continue;
    }
    used.add(hit.file);
    out.push({ task: row.task, role: row.role, expected: row.hash, actual: row.hash, match: true, file: hit.file });
  }
  return { results: out, files: files.length, ok: out.length > 0 && out.every((r) => r.match === true) };
}

// ── CLI ───────────────────────────────────────────────────────────────

/** 支持重复 flag 的参数解析：同名的第二个值起进数组。 */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    let val;
    if (next === undefined || next.startsWith('--')) val = true;
    else { val = next; i++; }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = Array.isArray(out[key]) ? [...out[key], val] : [out[key], val];
    } else {
      out[key] = val;
    }
  }
  return out;
}

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const HELP = `compose-agent-prompt — 分层拼装子 agent 提示词

用法：
  node scripts/compose-agent-prompt.mjs compose --run <id> --task ST1 \\
    --graph tasks/runs/<id>/task-graph.json --role <role> \\
    [--stop "<停机条件>"] [--constraint "<约束>" ...] \\
    [--gate "<命令>=<输出文件>" ...] [--gate-exit N] [--prior-failure "<上次失败模式>"] \\
    [--nonce <8位hex>] [--out <文件>] [--dry-run] [--json]

  node scripts/compose-agent-prompt.mjs verify --run <id> --session <会话目录> [--task ST1] [--json]

说明：
  compose  从 task-graph.json 取该子树的 goal / acceptance / shape / outputs，
           L2 现写段由 --stop / --constraint 补齐，L3 由仓库状态自动注入。
           **检查不过就不落文件**——这是「acceptance 为空就拒绝派发」的一般形态。
  verify   收活时核对：子 agent 实际收到的首条消息，是否就是 compose 记下的那一份。

分四层：L0 身份（冻结，只放指针）/ L1 协议（templates/dispatch.md 逐字）/
        L2 现写（主线程写）/ L3 注入（机器从仓库状态派生）。

退出码：0 通过 / 1 检查不过或对不上 / 2 用法错误。
`;

function readText(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function sha256OfFile(p) {
  const t = readText(p);
  return t == null ? null : promptHash(t);
}

/** 8 位十六进制 nonce。与 `claim-ledger.mjs` 的 `makeNonce` 同形。
 *
 *  **为什么要 compose 生成而不是手写**：nonce 的作用是把 transcript 归属到任务，
 *  归属失败是静默的（`observe` 只是「扫了 N 份，没有一份能归属」，然后什么都不发生）。
 *  手写的 nonce 有两个可复现的错误：抄错、以及两个任务用了同一个（后者会让两个任务的
 *  产出混为一谈）。两者 compose 都能避免——它只在自己这一步生成，然后打印出
 *  与之配套的 `claim-ledger declare --nonce` 命令，两份台账因此必然一致。 */
export function makeNonce(random = Math.random) {
  let s = '';
  while (s.length < 8) s += Math.floor(random() * 16).toString(16);
  return s.slice(0, 8);
}

function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0] || 'help';
  if (cmd === 'help' || args.help) { console.log(HELP); return 0; }

  const root = resolve(String(args.root || ROOT));
  const run = args.run ? String(args.run) : null;

  if (cmd === 'compose') {
    if (!run) { console.error('缺少 --run <id>'); return 2; }
    const taskId = args.task ? String(args.task) : null;
    const role = args.role ? String(args.role) : null;
    if (!taskId || !role) { console.error('缺少 --task / --role'); return 2; }
    const graphPath = args.graph ? resolve(String(args.graph)) : join(root, 'tasks', 'runs', run, 'task-graph.json');
    const graphText = readText(graphPath);
    if (graphText == null) { console.error(`读不到 task-graph：${graphPath}`); return 2; }
    let graph;
    try { graph = JSON.parse(graphText); } catch (e) { console.error(`task-graph 不是合法 JSON：${e.message}`); return 2; }
    const st = (graph.subtrees || []).find((s) => s && s.id === taskId);
    if (!st) { console.error(`task-graph 里没有子树 ${taskId}`); return 2; }

    // 提示词台账与 task-graph.json **同目录**，不跟 --root。
    //
    //  为什么：--root 决定「去哪里找 .claude/agents 与 templates」（测试时用，指向仓库），
    //  而 run 的落点是「任务图在哪」。把两者绑在一起，会让台账写到一个与 run 无关的地方，
    //  而 verify 按 --root 去那里找 —— 找不到时报的是「从没记过」，即「写成功」和「没写」长得一样。
    //  这正是本仓反复踩的那个坑（claims.jsonl 也放在 tasks/runs/<id>/ 下，理由相同）。
    const runDir = dirname(graphPath);

    const acceptance = Array.isArray(st.acceptance) ? st.acceptance : [];
    const outputs = Array.isArray(st.outputs) ? st.outputs : [];
    const roleFile = join(root, '.claude', 'agents', `oversight-${role}.md`);
    const roleText = readText(roleFile);
    if (roleText == null) {
      console.error(`没有这个角色的定义：${roleFile}`);
      console.error('角色必须先存在于 .claude/agents/ —— compose 不发明岗位。');
      return 2;
    }

    // 注入的硬门结果：`<命令>=<输出文件>`，退出码用 --gate-exit
    const injected = [];
    for (const g of asArray(args.gate)) {
      const s = String(g);
      const eq = s.lastIndexOf('=');
      if (eq <= 0) { console.error(`--gate 需要形如 "<命令>=<输出文件>"：${s}`); return 2; }
      const command = s.slice(0, eq).trim();
      const path = s.slice(eq + 1).trim();
      const abs = resolve(root, path);
      if (!existsSync(abs)) {
        // 声明了注入却文件不在 = 验收会读到「未找到」然后判不通过。挡在这里。
        console.error(`--gate 的输出文件不存在：${path}（先真的跑一遍那条命令，再把输出落盘）`);
        return 2;
      }
      injected.push({ command, path, sha256: sha256OfFile(abs), exitCode: args['gate-exit'] == null ? null : Number(args['gate-exit']) });
    }

    // nonce 由 compose 生成，不由人写。理由见 makeNonce 的注释：手写有两个可复现的错误
    // （抄错、两个任务撞同一个），而两者都是静默的。
    const nonce = args.nonce ? String(args.nonce) : makeNonce();
    if (args.nonce && !/^[0-9a-f]{8}$/i.test(String(args.nonce))) {
      console.error('--nonce 必须是 8 位十六进制（不写就自动生成，除非在重跑同一个任务）');
      return 2;
    }
    const constraints = asArray(args.constraint).filter((x) => typeof x === 'string');
    const stopCondition = args.stop ? String(args.stop) : null;

    const spec = {
      role, roleText, task: st.goal, acceptance, shape: st.shape, outputs,
      stopCondition, nonce, injected, context: {},
    };
    const check = checkPromptSpec(spec);

    // L1：模板必须填得掉
    const tplPath = join(root, 'templates', 'dispatch.md');
    const tplText = readText(tplPath);
    let tpl = { text: '', missing: [] };
    if (tplText == null) {
      check.errors.push('L1: 读不到 templates/dispatch.md —— 没有公共段，纪律与对账段全缺');
    } else {
      tpl = fillDispatchTemplate(tplText, { run, task: taskId, nonce, paths: outputs });
      if (tpl.missing.length) {
        check.errors.push(`L1: 占位符没填掉：${tpl.missing.join(', ')}`
          + '（<nonce> 留下的后果是 observe 归属失败，且失败是静默的）');
      }
    }

    const { facts } = deriveInjected({
      root, outputs, nonce, injected,
      priorFailure: args['prior-failure'] ? String(args['prior-failure']) : null,
    });
    const { markdown } = composePrompt({
      role, task: st.goal, acceptance, shape: st.shape, outputs,
      stopCondition, nonce, constraints, context: {},
      injectedFacts: facts, dispatchTemplate: tpl.text, run, taskId,
    });

    const ok = check.errors.length === 0;
    if (args.json) {
      console.log(JSON.stringify({ ok, checks: check.checks, errors: check.errors, warnings: check.warnings, bytes: Buffer.byteLength(markdown) }, null, 2));
    } else {
      console.log(`compose · task ${taskId} · role ${role}`);
      for (const c of check.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.id}${c.detail ? ` — ${c.detail}` : ''}`);
      for (const w of check.warnings) console.log(`  ⚠ ${w}`);
      console.log('');
      console.log(ok ? `✓ 通过（${Buffer.byteLength(markdown)} 字节）` : `✗ 拒绝派发：${check.errors.length} 项`);
    }
    if (!ok) {
      if (!args.json) {
        console.log('');
        console.log('不落文件，也不记台账——一份检查不过的提示词发出去，子 agent 会照着错的做，');
        console.log('而且主线程不会知道。');
      }
      return 1;
    }

    const hash = promptHash(markdown);
    const outPath = args.out ? resolve(root, String(args.out)) : null;
    if (outPath && !args['dry-run']) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, markdown, 'utf8');
    }
    const ledger = join(runDir, PROMPT_LEDGER_FILE);
    if (!args['dry-run']) {
      mkdirSync(dirname(ledger), { recursive: true });
      appendFileSync(ledger, JSON.stringify(makePromptRow({
        run, task: taskId, role, hash, bytes: Buffer.byteLength(markdown), checks: check.checks,
      })) + '\n', 'utf8');
    }
    if (!args.json) {
      if (outPath) console.log(`已写入：${args.out}`);
      console.log(`提示词 hash：${hash.slice(0, 16)}…（已记入 ${PROMPT_LEDGER_FILE}）`);
      console.log('把这份的正文作为 Agent 工具的 prompt 参数发出去；verify 靠这个 hash 核对。');
      if (outputs.length) {
        // 与 prompt 里的 nonce 必须一致：两份台账（prompt 与 claim）靠它对齐。
        // 打印成可直接粘贴的整条命令 —— 让人拼参数就是让 nonce 有机会对不上。
        console.log('');
        console.log('配套的产出期望登记（nonce 与提示词里的是同一个）：');
        const parts = [
          'node scripts/claim-ledger.mjs declare',
          `--run ${run}`,
          `--task ${taskId}`,
          `--paths ${outputs.join(',')}`,
          `--role ${role}`,
          `--nonce ${nonce}`,
        ];
        if (st.timeout_min) parts.push(`--timeout-min ${st.timeout_min}`);
        console.log('  ' + parts.join(' '));
      }
    }
    return 0;
  }

  if (cmd === 'verify') {
    if (!run) { console.error('缺少 --run <id>'); return 2; }
    const session = args.session ? String(args.session) : null;
    if (!session) { console.error('缺少 --session <会话目录或主 transcript>'); return 2; }
    // 与 compose 同一条定位规则：--graph 指到哪个目录，台账就在哪个目录。
    // 不给 --graph 时退回 tasks/runs/<run>/，那是本仓的既有落点。
    const runDir = args.graph ? dirname(resolve(String(args.graph))) : join(root, 'tasks', 'runs', run);
    const ledger = join(runDir, PROMPT_LEDGER_FILE);
    const { rows } = readPromptLedger(ledger);
    if (!rows.length) {
      console.error(`没有提示词台账：${ledger}`);
      console.error('这不是「全部对得上」——是「从没记过」。先跑 compose。');
      return 1;
    }
    const res = verifyPrompts({ rows, sessionPath: resolve(session), task: args.task ? String(args.task) : null });
    if (args.json) { console.log(JSON.stringify(res, null, 2)); return res.ok ? 0 : 1; }
    console.log(`verify · ${res.results.length} 份提示词 / ${res.files} 份子 agent transcript`);
    for (const r of res.results) {
      if (r.match === true) console.log(`  ✓ ${r.task}（${r.role || '?'}）与台账一致`);
      else if (r.match === false) console.log(`  ✗ ${r.task}（${r.role || '?'}）收到的不等于台账里那一份 —— ${r.file || ''}`);
      else console.log(`  ? ${r.task}（${r.role || '?'}）找不到对应 transcript —— 这是「看不到」，不是「通过」`);
    }
    if (!res.ok) {
      console.log('');
      console.log('对不上时不要猜谁对。台账记的是 compose 那一刻的字节；');
      console.log('transcript 记的是子 agent 真正拿到的。两者不同，说明中间有人改过 prompt。');
    }
    return res.ok ? 0 : 1;
  }

  console.error(`未知子命令：${cmd}`);
  console.error(HELP);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
