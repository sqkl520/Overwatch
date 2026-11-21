#!/usr/bin/env node
/**
 * validate-run.mjs — 校验一次派发的产物是否符合契约。
 *
 * 为什么需要它：`tasks/runs/<run-id>/task-graph.json` 的 schema 写在
 * `.claude/agents/oversight-planner.md` 里，但**从来没有任何东西检查产出的 JSON 符合它**。
 * 结果是 planner 写什么就是什么——字段名拼错、漏掉 acceptance、把「可选」写进图里，
 * 都要等到下游 Agent 拿到残破输入才发现。
 *
 * 这个脚本把那份 schema 变成可执行的检查。它不是"额外的文档"，是契约的执行者。
 *
 * 用法：
 *   node scripts/validate-run.mjs --complex tasks/runs/<run-id>/task-graph.json
 *   node scripts/validate-run.mjs --simple  tasks/runs/<run-id>/task-graph.json
 *   node scripts/validate-run.mjs --all tasks/runs
 *
 * `--complex` / `--simple` 是**必选的复杂度声明**（二者取一）：
 * 硬约束 2 的「≥5 个独立 Agent，含锐评/验收/修复」只有在声明复杂时才执行，
 * 而「是不是复杂」是规划时的判断，不是数字推断。两个都不给时脚本会明确打印
 * 「复杂度未声明、那条检查没跑」——**不检查也是一次决定，它必须看得见**。
 *
 * 校验的字段（**全部必填**，缺一个就 exit 1）：
 *   id / goal / capability / shape / token_budget_pct / timeout_min /
 *   parallel_with / depends_on / acceptance[] / outputs[] / why_this_layer
 *
 * `outputs[]` 是 2026-11-13 加的。它存在的唯一理由是**收活时要有期望**：
 * `scripts/claim-ledger.mjs` 用它判 `COMPLETE` / `PARTIAL` / `EMPTY`。
 * 没有它，「agent 产出了但主线程不知道」这件事只能靠 agent 自觉报告——那正是要治的病。
 * 详见 `docs/design/2026-11-13-output-reconciliation.md` §7.1。
 *
 * 退出码：0 = 合法；1 = 有违规；2 = 文件读不到。
 *
 * 零依赖。
 */

import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverRoles } from './roles.mjs';

import { projectRoot, runsDirInfo } from './project-root.mjs';

/** capability 与 shape 的合法取值。
 *
 *  **`CAPABILITIES` 不再写死。** 它原先是一份 12 个字面量的数组，旁边写着「单一真源：
 *  改这里，同时要改 oversight-planner.md 里的同一张表」—— 那句注释自己就承认了有两个源，
 *  而第二个源没有任何东西去核。现在它是 `scripts/roles.mjs` 注册表的 id 集合：
 *  角色目录里有什么，任务图的 `capability` 就允许什么，加一个角色不必改这里。
 *
 *  顺序稳定（按 id 排序），因为报错信息里会把这串原样打出来给人看。 */
export const CAPABILITIES = Object.freeze(discoverRoles().map((r) => r.id).sort());
export const SHAPES = Object.freeze(['artifact', 'exploration', 'hybrid']);

/** 有产出路径要求的 shape。`artifact` 的字面含义就是「落到磁盘的交付物」，
 *  声明了 artifact 却写 `outputs: []` 是自相矛盾——那会让收活时的对账
 *  判 `NO-EXPECTATION`（CLAUDE.md 硬约束 8：未声明产出形态视为规划缺陷）。 */
export const SHAPES_REQUIRING_OUTPUTS = Object.freeze(['artifact']);

/** `subtrees[].on_dependency_failed` 的合法取值。缺省 = `block`。
 *
 *  `block`：前置失败/卡住时本子树判 `UPSTREAM_FAILED`，等前置被处置。
 *  `degrade`：前置倒了也照样开工——「我要的是那批数据，拿不到就用手上这些」。
 *
 *  **为什么必须有 `degrade`**：research / critic 型子树的输入往往只是「素材之一」，
 *  一个不相关的失败前置能把整条研究线永久冻住，而它其实完全能产出。没有这个开关，
 *  `on_dependency_failed` 的默认严格性会把「诚实」变成「僵死」。
 *
 *  非枚举值**报错而不是回落**：拼错成 `"degraded"` 时静默当 `block` 处理，
 *  规划者的意图与校验器的行为就会长期不一致，而屏幕上两个状态长得一样。 */
export const ON_DEP_FAILED = Object.freeze(['block', 'degrade']);

/** 相对路径判据。返回错误描述，合法时返回 null。
 *
 *  为什么在派发图这一层就拦，而不是等派发出去再让 claim-ledger 报：
 *  `outputs` 会被原样交给 `claim-ledger declare --paths`，而 `declare` 把路径
 *  按仓库根展开后去 stat。一个绝对路径或含 `..` 的路径在那一步不会报错，
 *  只会指向一个**别的文件**——对账结果从此变成错的，而且看起来很正常。
 *  路径的合法性是**可以在派发前判定**的，所以它必须在这里判。
 *
 *  绝对路径用正则判而不是 `path.isAbsolute`：`C:\\repo\\a.md` 在 Linux CI 上
 *  `isAbsolute` 返回 false，同一个派发图在开发机与 CI 上会得到两个结论。
 *  这道门必须与平台无关，否则它守不住任何东西。 */
export function outputPathError(p) {
  if (typeof p !== 'string') return '必须是字符串';
  if (!p.trim()) return '不能是空字符串';
  if (p !== p.trim()) return `首尾不能有空白：${JSON.stringify(p)}`;
  if (/^(?:[A-Za-z]:[\\/]?|[\\/])/.test(p)) {
    // 盘符后不带分隔符（`C:a.md`）在 Windows 上也是绝对路径（相对于该盘当前目录），
    // 所以 `[\\/]?` 而不是 `[\\/]`。漏掉它的后果与 `C:\a.md` 一样：指向磁盘上别处的文件。
    return `必须是仓库相对路径，不能是绝对路径：${p}`;
  }
  const segs = p.split(/[\\/]+/);
  if (segs.includes('..')) return `不能含 ..（会指到任务范围之外）：${p}`;
  if (/[\\/]$/.test(p)) return `必须是文件路径，不能以分隔符结尾：${p}`;
  return null;
}

/** 比较用的归一化。只用于「两个子树是否声明了同一个文件」，**不改写台账里的原样路径**
 *  （理由同 claim-ledger 的 pathKey：改了人就认不出自己给的那个字符串了）。
 *  Windows 下大小写不敏感，所以比较键统一小写。 */
export function outputPathKey(p) {
  return String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
}

/** 不可判定的措辞：写进图里等于没有约束。 */
const VAGUE = [/^可选$/, /^视情况/, /^酌情/, /^看情况/, /^尽量/, /^尽可能/, /^适当/];

/** CLAUDE.md 硬约束 2：复杂任务至少 5 个独立 Agent，
 *  且必须含锐评 / 验收 / 修复三个不可合并的角色。 */
export const REQUIRED_FOR_COMPLEX = Object.freeze(['review', 'acceptor', 'repair']);
export const MIN_SUBTREES = 5;

/** 校验一个子树的 `outputs`。返回 `{ errors, warnings, okPaths }`。
 *
 *  **为什么 outputs 是必填**：它是收活时对账的唯一期望来源——`scripts/claim-ledger.mjs`
 *  的 `declare --paths` 直接吃它，`verify` 靠它判 `COMPLETE` / `PARTIAL` / `EMPTY`。
 *  做成选填的话，planner 少写一行，`verify` 只能判 `NO-EXPECTATION`，而那时已经是
 *  **收活时**了——没有期望就无从补，无从补就分不清「没产出」和「产出了没传过来」。
 *  这与硬约束 4（验收标准必须预先声明）是同一条结构：**期望必须早于结果存在**。
 *
 *  代价是旧 run 数据会变红。实测这个代价是零：本仓库唯一的那份历史
 *  `tasks/runs/2026-10-30-p0/task-graph.json` 本来就不合法
 *  （缺 `token_budget_pct` / `parallel_with` / `depends_on`，早已 exit 1）。
 *
 *  **为什么 artifact 不许为空**：`artifact` 的字面含义就是落到磁盘的交付物。声明它是
 *  artifact 却写 `outputs: []` 是自相矛盾，而那恰恰是绕过必填最省事的写法。
 *  `exploration` / `hybrid` 允许空数组——它们不承诺文件。 */
export function checkOutputs(st) {
  const errors = [];
  const warnings = [];
  const okPaths = [];
  const e = (field, msg) => errors.push({ field, msg });

  if (!Array.isArray(st.outputs)) {
    e('outputs', '必须是数组——收活时的对账靠它；不写期望就无法判断产出在不在');
    return { errors, warnings, okPaths };
  }
  if (st.outputs.length === 0 && SHAPES_REQUIRING_OUTPUTS.includes(st.shape)) {
    e('outputs', `shape 为 ${st.shape} 时不能为空——artifact 的字面含义就是落到磁盘的文件`);
  }
  st.outputs.forEach((op, j) => {
    const bad = outputPathError(op);
    if (bad) e(`outputs[${j}]`, bad);
    else okPaths.push(op);
  });
  return { errors, warnings, okPaths };
}

/** 依赖图环检测。返回**成环的子树 id 列表**（按图序、去重），有环时非空。
 *
 *  **为什么必须在派发前判死**：`render-plan.mjs` 把「没派过的子树」按前置状态分成
 *  `WAITING_ON` / `PENDING` / `UPSTREAM_FAILED`。这套判据在无环图上必然收敛，
 *  但在环上不收敛 —— `A 等 B、B 等 A` 两边都会判 `WAITING_ON`，谁也不在
 *  `ATTENTION` 里，于是**两件事都永远没人处理，而且屏幕上看起来一切正常**。
 *  渲染器那边有一道防御性深度上限，但那只能不让它挂住，救不回被吞掉的待办。
 *  「没人管」必须在图进入系统的那一刻就被判死，不能等到渲染时才降级。
 *
 *  只走 `depends_on`（有向边 A→B 表示 A 依赖 B）。`parallel_with` 是无向的
 *  并列关系，成环对它没有意义。
 *
 *  实现用三色 DFS（0 未访问 / 1 在栈上 / 2 已完成）：`1` 是回边的判据。
 *  递归深度就是最长链长，而 `validate-run` 的输入是一张手写的小图，
 *  不为它改成迭代——真需要时环检测早就先报了。 */
export function checkDependencyCycles(subtrees) {
  const nodes = new Map();
  for (const st of Array.isArray(subtrees) ? subtrees : []) {
    if (!st || typeof st.id !== 'string') continue;
    nodes.set(st.id, Array.isArray(st.depends_on) ? st.depends_on.filter((d) => typeof d === 'string') : []);
  }
  const color = new Map(); // id → 0/1/2
  const inCycle = new Set();

  const visit = (id, pathStack) => {
    const c = color.get(id) || 0;
    if (c === 2) return;
    if (c === 1) {
      // 回边：栈上从 id 起到当前的全部节点都在环里（这是最小环，报它最有指向性）
      const at = pathStack.indexOf(id);
      for (const x of pathStack.slice(at)) inCycle.add(x);
      return;
    }
    color.set(id, 1);
    pathStack.push(id);
    for (const dep of nodes.get(id) || []) {
      if (nodes.has(dep)) visit(dep, pathStack);
    }
    pathStack.pop();
    color.set(id, 2);
  };

  for (const id of nodes.keys()) if (!color.get(id)) visit(id, []);
  // 按图序返回，输出稳定 —— 否则同一次图的错误列表会随 Map 迭代顺序漂移
  return [...nodes.keys()].filter((id) => inCycle.has(id));
}

/** 校验一张派发图。`opts.requireComplex` 是**三态**（见下方复杂度段的注释）：
 *
 *    true      显式声明复杂 → 硬约束 2 逐条执行（缺角色或缺数量都判 error）
 *    false     显式声明不复杂 → 不执行，但对「看起来复杂」的声明发警告
 *    undefined 没声明 → 不执行，且 `declared_complexity` 会如实写 'undeclared'
 *
 *  `declared_complexity` 是返回值的一部分，**不只在 errors 里**：调用方（CLI、
 *  硬门、未来的渲染器）需要能区分「检查过并放行」与「压根没检查」，
 *  而 errors 为空对这两种是同一个样子。 */
export function validateGraph(graph, { requireComplex } = {}) {
  const errors = [];
  const warnings = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  const warn = (p, m) => warnings.push(`${p}: ${m}`);

  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return { ok: false, errors: ['根：必须是一个对象'], warnings: [] };
  }
  for (const k of ['run_id', 'root_goal']) {
    if (typeof graph[k] !== 'string' || !graph[k].trim()) err(k, '必须是非空字符串');
  }
  if (!Array.isArray(graph.constraints)) err('constraints', '必须是数组');
  if (!Array.isArray(graph.subtrees) || !graph.subtrees.length) {
    return { ok: false, errors: [...errors, 'subtrees: 必须是非空数组'], warnings };
  }

  const ids = new Set();
  /** outputPathKey → 子树 id。用于发现「两个子树声明了同一个文件」。 */
  const outputOwners = new Map();
  graph.subtrees.forEach((st, i) => {
    const p = `subtrees[${i}]`;
    if (!st || typeof st !== 'object') { err(p, '必须是对象'); return; }
    if (typeof st.id !== 'string' || !st.id.trim()) err(`${p}.id`, '必须是非空字符串');
    else if (ids.has(st.id)) err(`${p}.id`, `重复的 id：${st.id}`);
    else ids.add(st.id);

    if (typeof st.goal !== 'string' || !st.goal.trim()) err(`${p}.goal`, '必须是非空字符串');

    if (!CAPABILITIES.includes(st.capability)) {
      err(`${p}.capability`, `"${st.capability}" 不在合法取值内（${CAPABILITIES.join(' / ')}）`);
    }
    if (!SHAPES.includes(st.shape)) {
      // CLAUDE.md 硬约束 8：未声明产出形态视为规划缺陷
      err(`${p}.shape`, `"${st.shape}" 不在合法取值内（${SHAPES.join(' / ')}）`);
    }

    const pct = st.token_budget_pct;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0 || pct > 100) {
      err(`${p}.token_budget_pct`, '必须是 0 到 100 之间的数字');
    }
    const to = st.timeout_min;
    if (typeof to !== 'number' || !Number.isFinite(to) || to <= 0) {
      err(`${p}.timeout_min`, '必须是正数');
    }

    for (const k of ['parallel_with', 'depends_on']) {
      if (!Array.isArray(st[k])) { err(`${p}.${k}`, '必须是数组'); continue; }
      for (const ref of st[k]) {
        if (ref === st.id) err(`${p}.${k}`, '不得引用自己');
        else if (!graph.subtrees.some((x) => x && x.id === ref)) {
          err(`${p}.${k}`, `引用了不存在的 ${ref}`);
        }
      }
    }

    // `on_dependency_failed` 是**选填**（缺省 block），但一旦写了就必须是枚举值。
    // 非法值不回落成 block：那会让「拼错」与「明确要求严格」在屏幕上同形。
    if (st.on_dependency_failed !== undefined && !ON_DEP_FAILED.includes(st.on_dependency_failed)) {
      err(`${p}.on_dependency_failed`,
        `"${st.on_dependency_failed}" 不在合法取值内（${ON_DEP_FAILED.join(' / ')}；不写等于 block）`);
    }

    if (!Array.isArray(st.acceptance) || !st.acceptance.length) {
      // CLAUDE.md 硬约束 4：验收标准必须预先声明
      err(`${p}.acceptance`, '必须是非空数组——验收标准不能事后编');
    } else {
      st.acceptance.forEach((ac, j) => {
        const ap = `${p}.acceptance[${j}]`;
        if (!ac || typeof ac !== 'object') { err(ap, '必须是对象'); return; }
        for (const k of ['id', 'criterion', 'evidence', 'fail_if']) {
          if (typeof ac[k] !== 'string' || !ac[k].trim()) err(`${ap}.${k}`, '必须是非空字符串');
        }
        if (typeof ac.criterion === 'string') {
          for (const v of VAGUE) {
            if (v.test(ac.criterion.trim())) {
              err(`${ap}.criterion`, `"${ac.criterion}" 不可判定——不可判定的条目等于没有`);
            }
          }
        }
        // evidence 必须指向可核查的位置，不能是「见上文」
        if (typeof ac.evidence === 'string' && ac.evidence.trim()
            && !/[:#\d]/.test(ac.evidence) && !/^https?:/.test(ac.evidence)) {
          warn(`${ap}.evidence`, `"${ac.evidence}" 不像可追溯的引用（应含 file:line 或链接）`);
        }
      });
    }

    if (typeof st.why_this_layer !== 'string' || !st.why_this_layer.trim()) {
      // CLAUDE.md 硬约束 6：每层须写明「为什么需要这一层」
      err(`${p}.why_this_layer`, '必须写明为什么需要这一层');
    }

    // ── outputs：这个子树应当产出哪些文件 ──────────────────────────
    // 判据集中在 checkOutputs（纯函数），这里只负责把结论并进 errors/warnings。
    const ores = checkOutputs(st);
    for (const e of ores.errors) err(`${p}.${e.field}`, e.msg);
    for (const w of ores.warnings) warn(`${p}.${w.field}`, w.msg);
    for (const op of ores.okPaths) {
      const k = outputPathKey(op);
      const seen = outputOwners.get(k);
      if (seen && seen !== st.id) {
        // 不判 error：静态图里同一个文件被两个子树声明，几乎总是规划错误，
        // 但也可能是「共享的索引文件由后一个子树追加」。判定权留给 claim-ledger 的
        // CONFLICT（它有自述与痕迹，能看到真正发生了什么）；这里只提醒。
        warn(`${p}.outputs`, `${op} 与 ${seen} 声明了同一个文件——两个 agent 写同一个文件是最坏的形态`);
      } else outputOwners.set(k, st.id);
    }
  });

  // ── 依赖成环 ──────────────────────────────────────────────────────
  // 悬空引用与自引用已经在上面逐条报过；这里查的是**引用都合法但互相等**。
  // 那比悬空更坏：图上每条边都能在 id 表里对上，看起来完全正常，而实际
  // 没有任何一条能先开始（详见 checkDependencyCycles 的注释）。
  const cyclic = checkDependencyCycles(graph.subtrees);
  if (cyclic.length) {
    err('subtrees', `depends_on 成环：${cyclic.join(' → ')} —— 环上每一条都会永远「等前置」，`
      + '没有任何一条能先开始，会一起静默停在屏幕外。断环后再派发。');
  }

  // 复杂度约束
  const caps = graph.subtrees.map((s) => s && s.capability);
  // 复杂度只看调用方显式声明，**不由子任务数推断**。
  //
  // 最初写成「>= 5 个子任务就算复杂」，实测一个真实的 2 任务 run 因此被判违规。
  // 但那个 run 是合理的：一次小改动确实不需要 5 个 Agent。
  // 硬约束 2 说的是「复杂任务」，而「是不是复杂」是规划时的判断，不是数字推断。
  // 硬把阈值塞进校验器，只会训练人绕过它。
  //
  // **三态，不是两态**（2026-11-21）：
  //   true       = 调用方声明「这是复杂任务」→ 硬约束 2 逐条执行
  //   false      = 调用方声明「这不复杂」    → 不执行，但用数字复核这个声明
  //   undefined  = 没声明                   → 不执行，且**必须让这件事被看见**
  //
  // 为什么 undefined 不能折成 false：折了之后，「我不想声明」与「我声明过、且被
  // 机器复核过」在屏幕上同形。而这一整类缺陷的病根就是**不检查与通过同形**——
  // 缺陷 A 的原形正是 CLI 从不传 opts，于是 requireComplex 恒为 false，
  // 那三条角色检查一次都没跑过，而输出照样是一行 ✓。所以 CLI 必须每次印出
  // 「复杂度声明：…」，让「没检查」出现在每一份输出里，而不是只在心里。
  const declared = requireComplex === true ? 'complex'
    : requireComplex === false ? 'simple' : 'undeclared';

  // 数字推断**只用来复核人的声明**，不用来代替人做决定。
  // 这是缺陷 A 的正面利用：≥5 个子树或图上已含锐评/验收/修复之一，
  // 说明规划者自己已经把它当复杂任务在拆了。此时声明 `--simple` 是自相矛盾的。
  const looksComplex = graph.subtrees.length >= MIN_SUBTREES
    || REQUIRED_FOR_COMPLEX.some((r) => caps.includes(r));

  if (declared === 'complex') {
    for (const need of REQUIRED_FOR_COMPLEX) {
      if (!caps.includes(need)) {
        err('subtrees', `复杂任务缺少 ${need} 角色——锐评 / 验收 / 修复不可合并也不可缺`);
      }
    }
    // 子任务数在声明为复杂时是**错误**而不是提示：CLAUDE.md 硬约束 2 的原话是
    // 「复杂任务至少 5 个独立 Agent」，两个条件同属一条约束，不能只执行一半。
    if (graph.subtrees.length < MIN_SUBTREES) {
      err('subtrees', `声明为复杂任务却只有 ${graph.subtrees.length} 个子任务；`
        + `CLAUDE.md 硬约束 2 要求复杂任务至少 ${MIN_SUBTREES} 个独立 Agent。`
        + '要么补足，要么改声明 --simple 并说明为什么这不复杂');
    }
  } else {
    if (graph.subtrees.length < MIN_SUBTREES) {
      warn('subtrees', `只有 ${graph.subtrees.length} 个子任务；CLAUDE.md 要求复杂任务至少 ${MIN_SUBTREES} 个独立 Agent`);
    }
    if (declared === 'simple' && looksComplex) {
      warn('subtrees', `声明为 --simple，但图上看起来是复杂任务（${graph.subtrees.length} 个子树`
        + `${graph.subtrees.length >= MIN_SUBTREES ? ` ≥ ${MIN_SUBTREES}` : ''}`
        + `${REQUIRED_FOR_COMPLEX.some((r) => caps.includes(r)) ? '，且已含锐评/验收/修复角色' : ''}）。`
        + '复核这个声明，或改成 --complex');
    }
  }

  return { ok: errors.length === 0, errors, warnings, declared_complexity: declared };
}

/** 从磁盘读并校验。 */
export function validateFile(path, opts) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (e) {
    return { ok: false, errors: [`读不到 ${path}：${e.message}`], warnings: [] };
  }
  let graph;
  try { graph = JSON.parse(raw); } catch (e) {
    return { ok: false, errors: [`${path} 不是合法 JSON：${e.message}`], warnings: [] };
  }
  const r = validateGraph(graph, opts);
  return { ...r, path };
}

// ── CLI ───────────────────────────────────────────────────────────────

/** CLI 的复杂度声明 → `requireComplex`。
 *
 *  **这一层就是缺陷 A 的修复点。** 原先 `main()` 调 `validateFile(t)` 不传 opts，
 *  于是 `requireComplex` 恒为默认的 false，硬约束 2 的三条角色检查在命令行上
 *  **一次都没执行过**——只有测试里手动传 `{ requireComplex: true }` 才碰得到它。
 *
 *  返回 `{ opts, problem }`。`problem` 非空表示声明本身有问题（两个都给 / 给错），
 *  CLI 应当 exit 2，而不是挑一个默认值继续跑：静默选一个的方向，
 *  两种都是错的——选 complex 会把简单任务全判死，选 simple 会静默关掉硬约束。 */
export function complexityOpts(argv) {
  const has = (f) => argv.includes(f);
  if (has('--complex') && has('--simple')) {
    return { opts: {}, problem: '--complex 与 --simple 只能给一个：复杂度是一次二选一的声明' };
  }
  if (has('--complex')) return { opts: { requireComplex: true }, problem: null };
  if (has('--simple')) return { opts: { requireComplex: false }, problem: null };
  return { opts: {}, problem: null };
}

function main(argv) {
  const all = argv.includes('--all');
  const { opts, problem } = complexityOpts(argv);
  if (problem) { console.error(problem); return 2; }
  // `--complex` / `--simple` 是布尔开关，不是目标文件 —— 必须从 targets 里滤掉，
  // 否则它们会被当成路径去 stat，报出一句「读不到 --complex」。
  const targets = argv.filter((a) => !a.startsWith('--'));

  // `--all` 不给目录时的默认目标：**用户项目的 runs 目录**，不是脚本位置。
  //
  //  修前必须显式写 `--all tasks/runs`，否则报用法错误 —— 那一句「tasks/runs」是
  //  **相对 cwd** 的，在别人项目里跑恰好是对的，在本仓以外跑却要靠人记得。而这条命令
  //  最常被调度流程自动调用（SKILL.md 的校验阶段），自动调用方不该依赖 cwd 猜路径。
  //
  //  现在：`--all` 而不给目标 → 用 `projectRoot()` 阶梯 + `paths.runs` 算出的 runs 目录，
  //  并把**用的是哪一个**打印出来（不然「扫了 0 个」与「扫错了地方」同形）。
  if (all && !targets.length) {
    const root = projectRoot({});
    if (!root) {
      console.error('--all 没给目录，且找不到用户项目根（第 5 级）。');
      console.error('  给一个目录（例如 `--all .untildone/runs`），或在项目里建 .untildone/ 或 .git/。');
      return 2;
    }
    const info = runsDirInfo(root);
    console.error(`[validate-run] --all 默认目标 → ${info.dir}（来自 ${info.source}）`);
    targets.push(info.dir);
  }

  if (!targets.length) {
    console.error('用法：node scripts/validate-run.mjs --complex|--simple <task-graph.json> [...]');
    console.error('      node scripts/validate-run.mjs --complex|--simple --all [<runs 目录>]');
    console.error('');
    console.error('--all 不给目录时扫项目根的 runs 目录（见 overwatch.config.json 的 paths.runs）。');
    console.error('--complex 执行 CLAUDE.md 硬约束 2（≥5 个独立 Agent，含锐评/验收/修复）；');
    console.error('--simple 声明这次不是复杂任务。不给声明时那几条检查不会跑，输出里会写明。');
    return 2;
  }

  let results = [];
  if (all) {
    for (const dir of targets) {
      if (!existsSync(dir)) continue;
      for (const sub of readdirSync(dir)) {
        // `--all` 的语义是「这个目录下每个 run 的 task-graph」。直接传文件时
        // （`--all tasks/runs/*/task-graph.json` 很自然会被这么写）`readdirSync`
        // 抛 ENOTDIR，脚本崩掉——那不是「没有图」，是无意义的失败。跳过非目录项。
        const runDir = join(dir, sub);
        try { if (!statSync(runDir).isDirectory()) continue; } catch { continue; }
        const p = join(runDir, 'task-graph.json');
        if (existsSync(p)) results.push(validateFile(p, opts));
      }
    }
    if (!results.length) {
      console.log(`没有找到任何 task-graph.json（查了 ${targets.join(', ')}）。`);
      console.log('这不是失败——它表示还没有跑过一次派发。');
      return 0;
    }
  } else {
    // **缺陷 A 就在这里**：原先这一行是 `validateFile(t)`，opts 被丢掉。
    results = targets.map((t) => validateFile(t, opts));
  }

  // 复杂度声明必须印在**每一次**输出里，包括全部通过的那一次。
  //
  //  理由见 validateGraph 里 declared 那段：这一整类缺陷的病根是「没检查」与
  //  「检查过并放行」在屏幕上同形。把声明写进输出头，是让「没检查」这件事实
  //  每次都被看见的最小代价——它不阻塞，但它不再隐身。
  const decl = results[0] && results[0].declared_complexity;
  const DECL_TEXT = {
    complex: '复杂任务（执行硬约束 2：≥5 个子任务 + 锐评/验收/修复）',
    simple: '非复杂任务（硬约束 2 不适用）',
    undeclared: '未声明 —— 硬约束 2 没有执行。加 --complex 或 --simple',
  };
  if (decl) console.log(`复杂度声明：${DECL_TEXT[decl] || decl}\n`);

  let bad = 0;
  for (const r of results) {
    const name = r.path ? basename(resolve(r.path)) : '(inline)';
    if (r.ok) {
      console.log(`✓ ${r.path || name}`);
    } else {
      bad++;
      console.log(`✗ ${r.path || name}`);
      for (const e of r.errors) console.log(`    ${e}`);
    }
    for (const w of r.warnings) console.log(`    ⚠ ${w}`);
  }
  if (results.length > 1) console.log(`\n${results.length - bad}/${results.length} 合法`);
  return bad ? 1 : 0;
}

/** 「我是不是被直接执行」——比的是**真实路径**。`resolve()` 只规范化路径、不解析符号
 *  链接，而 `fileURLToPath(import.meta.url)` 已经是真实路径；通过目录符号链接执行
 *  （`npm link` / `npm i -g .` / pnpm 的 store）时两边必然不等，程序会静默 exit 0、零输出。
 *  realpath 失败（路径不存在）退回 resolve：一次失败不能让正常执行也坏掉。 */
const realOrResolve = (p) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};
if (process.argv[1] && realOrResolve(process.argv[1]) === realOrResolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
