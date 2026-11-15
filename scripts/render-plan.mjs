#!/usr/bin/env node
/**
 * render-plan.mjs — 把 `task-graph.json` 渲染成「这一轮要做哪几件事、现在到哪了」。
 *
 * 为什么需要它：`.claude/skills/oversight/SKILL.md` §7 与 `docs/spec/output-format.md` §2
 * 都写着同一句话 —— **「格式是约定，渲染器还没有」**。plan 的数据形状早就定死在
 * `task-graph.json` 的 `subtrees` 里（`id` / `goal` / `shape` / `acceptance` / `outputs` /
 * `timeout_min`），但**史上只产出过 2 份图**，而且没有任何东西把图变成人看得懂的一屏。
 * 于是「每轮开头告诉用户要做什么」这件事，每次都由模型现编 —— 编出来的计划与真正
 * 派出去的东西没有对过账。
 *
 * 本文件只做一件事：**读同一份图 + 同一份台账，算出每个子树的进度，渲染成一屏**。
 * 它不产生第二套状态、不写任何文件、不改任何台账。
 *
 * ── 四个设计问题（答案在 docs/design/2026-11-14-plan-rendering.md）──────────
 *
 * 来源：`task-graph.json` 是**唯一**来源，不额外支持「主线程手写一段 plan」。
 * 时机：应用里「一轮」= 一次 run（`tasks/runs/<run-id>/`），不是一次用户输入、也不是一次派发。
 * 可见性：终端一屏 + `--json`。**不写文件** —— 写 `PLAN.md` 会多出第三份需要同步的真相。
 * 对账：`subtrees[].id` 与 `claims.jsonl` 的 `task` **是同一个键**，`outputs[]` 就是期望，
 *       `claim-ledger.mjs` 的 `reconcile()` 逐子树判落地。图里 5 件、台账只登记了 3 件，
 *       剩下 2 行会显示 `○ 待跑`，不可能被算进「完成」。
 *
 * ── 进度从哪来（**不自创第二套**）────────────────────────────────────────
 *
 * | 证据 | 来源 | 能证明 |
 * |---|---|---|
 * | 期望/自述/痕迹/认领 | `tasks/runs/<run>/claims.jsonl` | 每个子树落了几个文件、是否被主线程认领 |
 * | 派发记录 | `tasks/runs/<run>/prompts.jsonl` | 这个子树**曾经被派过**（只有它，不算完成） |
 * | 磁盘 | `outputs[]` 逐路径 stat | 图里声明要产出的文件此刻在不在 |
 *
 * 判定一律调用 `claim-ledger.mjs` 的 `reconcile()`，不重写一遍。删除或改名那个函数，
 * 本文件立刻失效 —— 这是有意的：两份实现对账逻辑必然分叉，而分叉之后「哪个是真的」
 * 永远没人回答得了。
 *
 * ── 一条必须守住的边界 ───────────────────────────────────────────────
 *
 * `timeout_min` 超了只标 `! 超时`，**不叫失败**。`docs/spec/state-model.md` §2.0.1 已删掉
 * 「间隔大 ⇒ 失败」这条推断（实测 6,308 次大间隔里 94.8% 之后仍有工具调用）。
 * 所以超时行的下一步是「先抽痕迹或催一次」，不是「重跑」。真正可据以重跑的只有
 * 宿主上报的 `FAILED` / `BLOCKED` / `WAITING` 与台账判出的 `MISSING` / `CONFLICT`。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────
 *
 *   node scripts/render-plan.mjs                    # 最近一个 run
 *   node scripts/render-plan.mjs --run <run-id>     # 指定 run
 *   node scripts/render-plan.mjs --json             # 机器可读（含 lines，与人读同源）
 *   node scripts/render-plan.mjs --runs-dir <dir> --root <dir>   # 别的 checkout / 测试用
 *
 * 退出码：0 = 渲染出来且无需处理；1 = 渲染出来但有失败/卡住/超时，或没有可渲染的图；
 *         2 = 用法错误。
 *
 * 零依赖，只读。
 */

import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeDisk, reconcile, readLedger } from './claim-ledger.mjs';
import { readPromptLedger } from './compose-agent-prompt.mjs';
import { truncateDisplay } from './tui-theme.mjs';
import { checkDependencyCycles } from './validate-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ── 常量 ──────────────────────────────────────────────────────────────

export const PLAN_VERSION = 1;

/** 默认输出**必须短**。它的用途是「让用户安心知道流程」，不是给审计员看。
 *  5 个子树的图超过这个行数就算失败 —— 失败的实现方式是把细节行按严重度挤掉并
 *  明说「还有 N 项未显示」，而不是静默截断。 */
export const MAX_LINES = 20;

/** 单行宽度上限。超过就截断：一行折成两行会把「一屏看懂」这个唯一用途毁掉。 */
export const ROW_WIDTH = 96;

/** 子树 id 之外留给 goal 的显示宽度。 */
const GOAL_WIDTH = 32;

/** 每个需要处理的行**最多**带几条细节行。两条：卡在哪、下一步。 */
const DETAIL_LINES = 2;

/** 状态 → 记号与中文名。记号沿用 `claim-ledger.mjs` 的 `VERDICT_MARK` 风格（几何/丁方符号，不是 emoji）。
 *
 *  **选记号的三条硬标准**（`docs/spec/tui-visual.md` §3.1 + §2.1）：
 *    1. 四款等宽字体（Consolas / Lucida Console / Cascadia Mono / Cascadia Code）的 `cmap`
 *       都得原生覆盖——缺一个，conhost 下就是豆腐块。U+25B8 `▸` 与 U+26A0 `⚠` 正是栽在这里。
 *    2. 真实终端里非豆腐块。ASCII 天然满足；非 ASCII 只收 §6 已实测过的那几个。
 *    3. 显示宽度为 1 列（`tui-theme.mjs` 的 `displayWidth`）。EAW=Ambiguous 的码点在有
 *       VS16 或终端设成双宽时变 2 列，整屏会抖列——`⚠`(U+26A0) 属这一类。
 *  另外还有一条**同屏唯一**：同一屏里一个记号只能表示一个状态。跨屏复用允许
 *  （plan 与列表页是两套状态体系），同屏复用会让「这一行到底是失败还是超时」无解。
 *  下面这张表就按这两条重排过：`FAILED` 与列表页对齐成 `×`（此前这里是 `✗`，
 *  同一个概念两个字形），`STUCK` 从豆腐块 `◐` 退成 `~`，`RUNNING` 的 `▸` 在 Lucida
 *  的 cmap 里没有，退成 `>`；`DEFECT` 的 `⚠` 是 Ambiguous 宽度，退成 `#`
 *  ——它不能退成 `!`，因为 `!` 已经被 `OVERDUE` 占用，同屏两个 `!` 违反上面那条。 */
const STATE_META = Object.freeze({
  DONE: { mark: '√', label: '已完成' },
  LANDED_UNCLAIMED: { mark: '?', label: '产出在未认领' },
  FAILED: { mark: '×', label: '失败' },
  UPSTREAM_FAILED: { mark: '<', label: '前置失败' },
  STUCK: { mark: '~', label: '卡住' },
  DEFECT: { mark: '#', label: '规划缺陷' },
  OVERDUE: { mark: '!', label: '超时' },
  RUNNING: { mark: '>', label: '进行中' },
  WAITING_ON: { mark: '·', label: '等待前置' },
  PENDING: { mark: '○', label: '待跑' },
});

/** 已验证字形 → 码位与证据。`STATE_META` 里每个记号都必须在这里有据可查，
 *  由 `render-plan.test.mjs` 断言（新增一个没验证过的字形会直接变红）。
 *
 *  证据形态：`cmap` 四款等宽字体全覆盖（本机用 WPF `GlyphTypeface.CharacterToGlyphMap`
 *  读真字体文件），宽度 1 列（`tui-theme.displayWidth`）。ASCII 的字形无需 `cmap` 论证。 */
export const VERIFIED_GLYPHS = Object.freeze({
  '√': { cp: 'U+221A', why: '四款 cmap 全覆盖，列宽 1（WGL4 数学算符区，Consolas/Lucida 原生含）' },
  '?': { cp: 'U+003F', why: 'ASCII' },
  '×': { cp: 'U+00D7', why: 'tui-visual.md §6 三终端实测，四款 cmap 全覆盖，列宽 1' },
  '<': { cp: 'U+003C', why: 'ASCII' },
  '~': { cp: 'U+007E', why: 'ASCII' },
  '#': { cp: 'U+0023', why: 'ASCII' },
  '!': { cp: 'U+0021', why: 'ASCII' },
  '>': { cp: 'U+003E', why: 'ASCII' },
  '·': { cp: 'U+00B7', why: '四款 cmap 全覆盖，列宽 1（claim-ledger 的 EMPTY 已用它）' },
  '○': { cp: 'U+25CB', why: 'tui-visual.md §6 三终端实测，四款 cmap 全覆盖，列宽 1' },
});

/** 需要人动手的状态。顺序即严重度：细节行按这个顺序分配行数预算。
 *
 *  `UPSTREAM_FAILED` 排在 `FAILED` 之后、`STUCK` 之前：它说的是「本子树没问题，
 *  是前置倒了」，处置上比「自己卡住」更靠上游一步——先修前置，本行才可能动。
 *  `WAITING_ON` **不在这里**：它表示「还没轮到，且有人会推进它」，不需要人动手。 */
const ATTENTION = Object.freeze(['FAILED', 'UPSTREAM_FAILED', 'STUCK', 'DEFECT', 'OVERDUE', 'LANDED_UNCLAIMED']);

/** 依赖里出现就意味着「本子树现在不该派」的状态。 */
const DEP_BLOCKS = Object.freeze(['PENDING', 'WAITING_ON', 'RUNNING', 'OVERDUE']);

/** 依赖里出现就意味着「前置没有交付，本子树的前置条件不成立」的状态。
 *  `DEFECT` **不在**这里：它的处置是「退回 planner」，由它自己那一行说；把它也算成
 *  前置失败会让下游一并变红，掩盖「问题只有一处」。下游此时落在 `PENDING`，
 *  也就是「轮到你看了」——那个判断没错。 */
const DEP_FAILED = Object.freeze(['FAILED', 'STUCK', 'UPSTREAM_FAILED']);

/** `subtrees[].on_dependency_failed` 的合法取值。缺省视为 `block`。
 *  `degrade` 的意思是「前置倒了我也能做我能做的」——research 型子树常属此类，
 *  没有它，一个不相关的失败前置会把整条研究线永久冻在 `UPSTREAM_FAILED` 上。 */
export const ON_DEP_FAILED_MODES = Object.freeze(['block', 'degrade']);

/** 台账里出现即算「这个子树被派过」的行类型。`consume` 也是 —— 有人认领过它。 */
const CAPABILITY_LABEL = Object.freeze({
  executor: 'exec', research: '研究', critic: '锐评', redteam: '红队', review: '评审',
  acceptor: '验收', relay: '接力', probe: '探针', planner: '规划', repair: '修复',
  resolution: '裁决', safety: '红线',
});

// ── 读盘 ──────────────────────────────────────────────────────────────

/** 人读的路径形态。**绝不打印绝对路径**：本机路径不该出现在任何输出里，
 *  而 run 目录又常以 `tasks/runs/` 为基准，相对路径恰好就是人能照着敲的那一个。 */
export function displayPath(abs, root = ROOT) {
  const a = resolve(abs);
  const r = resolve(root);
  const rel = a.startsWith(r + (process.platform === 'win32' ? '\\' : '/'))
    ? a.slice(r.length + 1).replace(/\\/g, '/')
    : null;
  if (rel) return rel;
  // 不在仓库根下（测试用的临时目录）：只留最后两段，避免泄出本机路径
  const segs = a.replace(/\\/g, '/').split('/').filter(Boolean);
  return segs.slice(-2).join('/');
}

/** `tasks/runs` 下最近一个**有** `task-graph.json` 的目录。
 *
 *  为什么按 task-graph 的 mtime 排而不是目录名：目录名是 run 的语义 id（`2026-11-13-x`），
 *  排序靠它等于靠人起名；图被重写过的那个 run 才是「此刻在跑的」。 */
export function findLatestRun(runsDir) {
  let entries;
  try { entries = readdirSync(runsDir, { withFileTypes: true }); } catch { return { run: null, checked: 0 }; }
  let best = null;
  let checked = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    checked++;
    const p = join(runsDir, e.name, 'task-graph.json');
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!best || st.mtimeMs > best.mtimeMs) best = { run: e.name, mtimeMs: st.mtimeMs };
  }
  return { run: best ? best.run : null, checked };
}

/** 读一个 run 的三份输入。**读不到就说读不到**，不返回空对象假装读过。
 *
 *  返回 `{ graph, graphError, claimRows, claimBadLines, promptRows, promptBadLines }`。
 *  `graphError` 取值：`null`（正常）/ `no-run-dir` / `no-graph` / `invalid-json`。 */
export function loadRun({ runsDir, run }) {
  const dir = join(runsDir, String(run));
  const graphPath = join(dir, 'task-graph.json');
  const out = {
    dir, graphPath, graph: null, graphError: null, graphErrorMsg: null,
    claimRows: [], claimBadLines: [], promptRows: [], promptBadLines: [],
  };
  if (!existsSync(dir)) {
    out.graphError = 'no-run-dir';
    return out;
  }
  if (!existsSync(graphPath)) {
    out.graphError = 'no-graph';
  } else {
    let raw = '';
    try {
      raw = readFileSync(graphPath, 'utf8');
    } catch (e) {
      out.graphError = 'invalid-json';
      out.graphErrorMsg = e.message;
    }
    if (out.graphError === null) {
      try {
        out.graph = JSON.parse(raw);
      } catch (e) {
        out.graphError = 'invalid-json';
        out.graphErrorMsg = e.message;
      }
    }
  }
  const claim = readLedger(join(dir, 'claims.jsonl'));
  out.claimRows = claim.rows;
  out.claimBadLines = claim.badLines;
  const prompt = readPromptLedger(join(dir, 'prompts.jsonl'));
  out.promptRows = prompt.rows;
  out.promptBadLines = prompt.badLines;
  return out;
}

/** 默认探测器。**必须返回 `reconcile` 期望的形状**（`{exists,size,sha256,...}`），
 *  不是布尔值 —— 直接复用 `claim-ledger.mjs` 的 `probeDisk`，基准目录由 `root` 决定。
 *  早先这里写过返回 `statSync().isFile()` 的版本，结果所有输出路径都被判 ABSENT：
 *  `reconcile` 读 `disk.exists`，布尔值上是 `undefined`，于是「文件在」变成了「文件不在」。
 *  这类错误不会报错，只会让渲染结果整片偏。 */
function defaultProbe(root) {
  return (p) => probeDisk(p, root);
}

// ── 进度 ──────────────────────────────────────────────────────────────

/** 这个子树被派过没有、什么时候派的、限时多少。
 *
 *  三种行都算「派过」：`expect`（登记过期望）、`claim`/`observe`（有人自述/有痕迹）、
 *  `consume`（主线程认领过）。**`prompts.jsonl` 只算派过，不算完成** —— 提示词发出去
 *  和活干完是两件事，混为一谈正是要治的病。 */
function dispatchOf(id, claimRows, promptRows) {
  let firstAt = null;
  let dispatched = false;
  let expectTimeout = null;
  const take = (ts) => {
    if (typeof ts !== 'string' || Number.isNaN(Date.parse(ts))) return;
    if (firstAt === null || ts < firstAt) firstAt = ts;
  };
  for (const r of claimRows || []) {
    if (!r || String(r.task) !== id) continue;
    dispatched = true;
    take(r.ts);
    if (r.kind === 'expect' && Number.isFinite(r.timeoutMin)) expectTimeout = r.timeoutMin;
  }
  for (const r of promptRows || []) {
    if (!r || String(r.task) !== id) continue;
    dispatched = true;
    take(r.ts);
  }
  return { dispatched, firstAt, expectTimeout };
}

/** 台账里那几个「落地了哪几个文件」的条目。没登记的子树拿不到这一项。 */
function itemsOf(task) {
  return task && Array.isArray(task.items) ? task.items : [];
}

const LANDED = Object.freeze(['OK', 'OK_WEAK', 'UNREPORTED']);
const missingPaths = (items) => items.filter((i) => !LANDED.includes(i.status)).map((i) => i.path);

/** 一组路径的短表述：`a`、`a 等 3 个`。行宽有限，但「几个」必须说清。 */
function pathList(paths, max = 2) {
  const ps = (paths || []).filter(Boolean);
  if (!ps.length) return '（无）';
  if (ps.length <= max) return ps.join('、');
  return `${ps.slice(0, max).join('、')} 等 ${ps.length} 个`;
}

/** 「没派过，且盘上没有产出」那一行的默认形态。`resolveStates` 会在依赖判定后
 *  把它改写成 `WAITING_ON` / `UPSTREAM_FAILED` / 原样保留 `PENDING`。
 *  单独抽出来是因为三条分支的 note/next_step 各不相同，但「待跑」这一份必须只有一处。 */
function mkPending(mk, outputs) {
  return mk('PENDING', {
    note: '未派发',
    blocker: null,
    next_step: outputs.length ? '派发前先 claim-ledger declare 登记 outputs' : '探索型可见，派发前先登记',
  });
}

/** 把「本子树自己」的本地状态 + 兄弟状态解析成最终状态。**纯函数**，不读盘。
 *
 *  只有 `PENDING` 会被改写——其余状态是台账或时间给出的硬事实，依赖推不动它们。
 *
 *  为什么必须有这一步：`localStateOf` 对「没派过」一律给 `PENDING`，于是
 *  「还没轮到」与「没人管」在屏幕上完全同形。三态的判据全部从图 + 台账 + 已算出的
 *  兄弟状态导出，**不引入新输入**：
 *
 *    WAITING_ON       前置里有人还在跑/还没轮到时它也不该动，不用人处理
 *    UPSTREAM_FAILED  前置倒了且本子树不允许降级，要人处理（先修前置）
 *    PENDING          前置全 DONE 或没有前置 —— 轮到你派了，要人处理
 *
 *  取「无进展」的那一档做合并，不看图里的书写顺序：`A 等 B、B 等 A` 在有环的图里
 *  两边都永远 `WAITING_ON`，所以 `validate-run.mjs` 必须在派发前就把环判死
 *  （见那边的 `checkDependencyCycles`）。这里另加一道**防御性**上限：状态回溯
 *  深度超过子树数就是图有问题，判 `DEFECT` 而不是死循环——渲染器读的图可能
 *  没经过校验器，它不能因为一张坏图就挂住。 */
function resolveStates(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const LIMIT = Math.max(1, rows.length); // 深度上限 = 子树数：合法的最长链就是 n-1 跳
  // 环的判定**不在这里重写一份**：`checkDependencyCycles` 是同一件事的唯一实现，
  // 两份实现必然分叉，而分叉之后「哪个是真的」没人回答得了。它只在派发前拒绝有环的图，
  // 但渲染器读到的图可能没经过校验器，所以这里也用它——复用判据，不是复用流程。
  const cyclic = new Set(checkDependencyCycles(rows.map((r) => ({ id: r.id, depends_on: r.depends_on }))));
  const done = new Map(); // id → 解析后的状态

  const resolve = (row, depth) => {
    if (done.has(row.id)) return done.get(row.id);
    if (row.state !== 'PENDING') { done.set(row.id, row); return row; }
    if (cyclic.has(row.id)) {
      const out = {
        ...row,
        ...STATE_META.DEFECT,
        state: 'DEFECT',
        note: '依赖成环',
        blocker: `${row.depends_on.join('、')} 与它互相等待——环上没有哪一条能先开始`,
        next_step: '改 task-graph.json 断环；validate-run.mjs 会在派发前拒绝这种图',
      };
      done.set(row.id, out);
      return out;
    }
    // 防御性上限：环已经被上面拦住了，走到这里仍超深就说明图还有别的毛病
    // （例如悬空引用被写成自指）。判 DEFECT 而不是让它无限递归把进程挂住。
    if (depth > LIMIT) {
      const out = {
        ...row, ...STATE_META.DEFECT, state: 'DEFECT',
        note: '依赖层级超限',
        blocker: `回溯 ${depth} 层仍未收敛（子树共 ${rows.length} 个）——图里有环或悬空引用`,
        next_step: '跑 node scripts/validate-run.mjs 定位',
      };
      done.set(row.id, out);
      return out;
    }
    const depStates = row.depends_on.map((d) => {
      const dep = byId.get(d);
      // 悬空引用（图里写了不存在的 id）：当「不可判定」，不当作失败——
      // `validate-run.mjs` 会在派发前把这种图判死，这里只求不崩。
      if (!dep) return null;
      return resolve(dep, depth + 1).state;
    });
    const resolved = resolveDependency(row, depStates);
    done.set(row.id, resolved);
    return resolved;
  };

  const out = rows.map((r) => resolve(r, 0));
  return { rows: out, cycles: [...cyclic] };
}

/** 一条 `PENDING` 子树 + 已解析的前置状态 → 最终那一行。 */
function resolveDependency(row, depStates) {
  const mk = (state, extra) => ({ ...row, ...STATE_META[state], state, ...extra });
  const known = depStates.filter(Boolean);
  const blockedDeps = row.depends_on.filter((d, i) => DEP_BLOCKS.includes(depStates[i]));
  const failedDeps = row.depends_on.filter((d, i) => DEP_FAILED.includes(depStates[i]));

  if (failedDeps.length && row.on_dependency_failed !== 'degrade') {
    return mk('UPSTREAM_FAILED', {
      note: `前置 ${failedDeps.join('、')} 没交付`,
      blocker: `${failedDeps.join('、')} 已经失败/卡住，它承诺的产出不会来了——本子树的输入缺了这一块`,
      next_step: `先处置 ${failedDeps.join('、')}；若本子树本来就不需要它，在图里把它标成 on_dependency_failed: "degrade"`,
    });
  }
  if (blockedDeps.length) {
    return mk('WAITING_ON', {
      note: `等 ${blockedDeps.join('、')}`,
      blocker: null,
      next_step: null,
    });
  }
  if (known.length !== depStates.length) {
    // 有前置引用在图里找不到：不猜。交给 validate-run 判死，这一行只说出事实。
    return mk('DEFECT', {
      note: '前置引用不可判定',
      blocker: `${row.depends_on.filter((d, i) => !depStates[i]).join('、')} 在图上找不到`,
      next_step: '先跑 node scripts/validate-run.mjs 把图修对',
    });
  }
  return row; // deps 全 DONE 或没有 deps —— 真正的 `PENDING`（轮到你派了）
}

/** 单个子树 → 一行状态，**只看它自己**（不看 `depends_on`）。**纯函数**：所有外部事实都由参数注入。
 *
 *  判定顺序就是「哪个信号更硬就用哪个」：宿主/台账判出的终局结论优先于时间推断，
 *  时间推断只用来区分「还在跑」与「超时未收活」。
 *
 *  取名叫「本地状态」是因为 `PENDING` 还要再过一道 `resolveStates` 的依赖判定：
 *  「没派过」有三种成因，处置完全不同（等前置 / 该派了 / 前置倒了）。判据全部从
 *  图 + 台账 + 兄弟状态导出，不引入任何新输入——本函数不读 `depends_on`，
 *  是因为它算的是「与别人无关的那部分事实」。 */
function localStateOf({ sub, task, disp, nowMs, probe }) {
  const id = String(sub.id);
  const outputs = Array.isArray(sub.outputs) ? sub.outputs.map(String) : [];
  const shape = String(sub.shape || '');
  const verdict = task ? task.verdict : null;
  const consumed = !!(task && task.consumed);
  const items = itemsOf(task);
  const elapsedMin = disp.firstAt ? Math.max(0, Math.round((nowMs - Date.parse(disp.firstAt)) / 60000)) : null;
  const limitMin = Number.isFinite(sub.timeout_min) ? sub.timeout_min
    : (Number.isFinite(disp.expectTimeout) ? disp.expectTimeout : null);

  const base = {
    id,
    goal: String(sub.goal || ''),
    capability: String(sub.capability || ''),
    shape,
    outputs,
    outputs_expected: outputs.length,
    outputs_landed: items.filter((i) => LANDED.includes(i.status)).length,
    consumed,
    elapsed_min: elapsedMin,
    timeout_min: limitMin,
    depends_on: Array.isArray(sub.depends_on) ? sub.depends_on.map(String) : [],
    parallel_with: Array.isArray(sub.parallel_with) ? sub.parallel_with.map(String) : [],
    on_dependency_failed: ON_DEP_FAILED_MODES.includes(sub.on_dependency_failed)
      ? sub.on_dependency_failed : 'block',
    verdict,
    items: items.map((i) => ({ path: i.path, status: i.status })),
  };
  const mk = (state, extra = {}) => ({ ...base, state, ...STATE_META[state], ...extra });

  // 1) 声明了 artifact 却没有任何 outputs —— 规划缺陷，先于一切（硬约束 8）。
  if (shape === 'artifact' && outputs.length === 0) {
    return mk('DEFECT', {
      note: '图里没写 outputs',
      blocker: '声明了 artifact 却没有 outputs，收活时无从对账',
      next_step: '退回 planner 补 outputs，再重跑 validate-run.mjs',
    });
  }

  // 2) 台账给出的终局结论。COMPLETE 之外的每一种都对应一个不同的处置（见 SKILL.md §4.5）。
  if (verdict === 'COMPLETE') {
    return mk('DONE', {
      note: consumed ? '已落地并认领' : '已落地，待认领',
      blocker: null,
      next_step: consumed ? null : 'node scripts/claim-ledger.mjs consume --run <run> --task ' + id,
    });
  }
  if (verdict === 'CONFLICT') {
    const conflicts = items.filter((i) => i.conflictWith && i.conflictWith.length);
    const others = [...new Set(conflicts.flatMap((i) => i.conflictWith))].join(' / ');
    return mk('FAILED', {
      note: '同一文件多任务争用',
      blocker: `${pathList(conflicts.map((i) => i.path))} 同时被 ${others || '其他子树'} 声明`,
      next_step: '停下，人工裁决这个文件归谁；裁决前不验收',
    });
  }
  if (verdict === 'MISSING' || verdict === 'DRIFTED') {
    const bad = items.filter((i) => i.status === 'MISSING' || i.status === 'DRIFTED');
    const why = verdict === 'MISSING' ? '自述说写了，磁盘上没有' : '自述之后文件被改过';
    return mk('FAILED', {
      note: verdict === 'MISSING' ? '自述与磁盘不符' : '产出漂移',
      blocker: `${pathList(bad.map((i) => i.path))} —— ${why}`,
      next_step: verdict === 'MISSING'
        ? '退回该 Agent 问清文件到底写到哪；不要整轮重跑'
        : '先确认是谁在自述之后改了它，再决定是否重新验收',
    });
  }
  if (verdict === 'PARTIAL') {
    const miss = missingPaths(items);
    return mk('STUCK', {
      note: `${base.outputs_landed}/${outputs.length} 落地`,
      blocker: `缺 ${pathList(miss)}`,
      next_step: '只续做缺的这几项（PARTIAL 禁止整轮重跑，重跑会覆盖已落地的部分）',
    });
  }
  if (verdict === 'UNREPORTED') {
    return mk('LANDED_UNCLAIMED', {
      note: '文件在，没人自述',
      blocker: '产出在磁盘上，但台账里没有任何人自述写过它',
      next_step: 'node scripts/claim-ledger.mjs adopt --run <run> 列出，认领后即可继续（不是缺陷）',
    });
  }

  // 3) 台账里没有这个子树：要么从没派过，要么盘上已经有产出但没人登记。
  if (!task) {
    // `probe` 返回的是 `{exists,...}` 而不是布尔值。写成 `.filter((p) => probe(p))`
    // 会把每个路径都当成「在」——对象恒为真值。这个错不报错，只会凭空多出
    // 一堆「盘上有产出」的假行，所以判据必须是 `probe(p).exists === true`。
    let onDisk = [];
    if (!disp.dispatched) {
      onDisk = outputs.filter((p) => {
        const d = probe(p);
        return d && d.exists === true;
      });
    }
    if (onDisk.length) {
      return mk('LANDED_UNCLAIMED', {
        note: '盘上有产出，台账无登记',
        blocker: `${pathList(onDisk)} 已经在磁盘上，但这个子树没有 expect / claim 记录`,
        next_step: '先补 declare 登记期望，再认领；否则「产出了主线程不知道」会再次发生',
      });
    }
    if (!disp.dispatched) {
      return mkPending(mk, outputs);
    }
  }

  // 4) 派过了、还没有终局结论（EMPTY / NO-EXPECTATION / 尚无 verdict）→ 看时间。
  const overdue = elapsedMin !== null && Number.isFinite(limitMin) && elapsedMin > limitMin;
  const spend = elapsedMin !== null ? `${elapsedMin}m / 限 ${limitMin}m` : (Number.isFinite(limitMin) ? `限 ${limitMin}m` : '时长未知');
  if (overdue) {
    return mk('OVERDUE', {
      note: `超时 ${spend}`,
      blocker: `登记超过 ${limitMin} 分钟仍无落地产出（已过 ${elapsedMin} 分钟）`,
      next_step: '先跑 claim-ledger observe 抽 transcript 痕迹，或催一次；静默不是失败判据，不要直接重跑',
    });
  }
  if (consumed) {
    return mk('DONE', { note: '已由主线程认领', blocker: null, next_step: null });
  }
  return mk('RUNNING', { note: `跑着 ${spend}`, blocker: null, next_step: null });
}

// ── 组装 ──────────────────────────────────────────────────────────────

/** 空状态的四种成因，各有一句不同的话。**不许合并** —— 「没规划」和「读不懂」的处置完全不同。 */
function emptyReasonText(reason, ctx) {
  if (reason === 'no-run-dir') {
    return [`run 目录不存在：${ctx.path}`, '这不是「计划为空」——是「这个 run 还没建目录」。'];
  }
  if (reason === 'no-graph') {
    return [
      `任务图不存在：${ctx.path}`,
      '这不是「计划为空」——是「还没规划」。派 oversight-planner 产出 task-graph.json，再用 validate-run.mjs 校验。',
    ];
  }
  if (reason === 'empty-graph') {
    return [
      `任务图为空：${ctx.path}`,
      '这不是「计划已完成」——是「图里一个子树都没有」。validate-run.mjs 会判它违规（subtrees 必须非空）。',
    ];
  }
  if (reason === 'invalid-json') {
    return [
      `任务图读不懂：${ctx.path}`,
      `JSON 解析失败：${ctx.msg || '未知错误'}`,
      '不会渲染一份猜出来的计划——先修好 JSON。',
    ];
  }
  if (reason === 'no-run') {
    const tail = ctx.checked ? `（扫了 ${ctx.checked} 个 run 目录，没有一个带 task-graph.json）` : '（tasks/runs 下没有 run 目录）';
    return [
      '没有任何可渲染的 plan' + tail + '。',
      '这不是「计划为空」——是「还没跑过一次规划」。先派 oversight-planner。',
    ];
  }
  return ['没有可渲染的 plan。', '这不是「计划为空」——是「没有输入」。'];
}

/** 摘要行：完成/总数 + 非零的分类 + 预算 + 最长限时。
 *
 *  零项一律不印（除了「待跑」：它是进度分母里唯一还该动的部分，0 也要说），
 *  否则 25 个子树的一行摘要会退化成一张表。`WAITING_ON` 归到「等前置」——
 *  它与「待跑」是两种不同的处境，合并就回到修改前的同形问题。 */
function summaryLine(plan) {
  const t = plan.totals;
  const bits = [`进度 ${t.done}/${t.total} 完成`];
  const pairs = [
    ['failed', '失败'], ['upstream_failed', '前置失败'], ['stuck', '卡住'], ['defect', '规划缺陷'],
    ['overdue', '超时'], ['landed_unclaimed', '待认领'], ['running', '进行中'],
    ['waiting_on', '等前置'], ['pending', '待跑'],
  ];
  for (const [k, label] of pairs) {
    if (k === 'pending' || t[k] > 0) bits.push(`${t[k]} ${label}`);
  }
  bits.push(`预算 ${plan.budget_pct}%`);
  if (plan.max_timeout_min) bits.push(`最长限时 ${plan.max_timeout_min} 分`);
  return bits.join(' · ');
}

/**
 * 人读的行。**JSON 里的 `lines` 就是它** —— 两套逻辑迟早会说两种话。
 *
 * 行预算（MAX_LINES）在这里一次性分配：先保行（每子树一行必须出现，除非真的放不下），
 * 再按 FAILED → STUCK → DEFECT → OVERDUE → LANDED_UNCLAIMED 的顺序给细节行。
 * 挤掉的细节**明说**被挤掉了，不静默截断。
 */
export function formatPlan(plan) {
  if (plan.empty) {
    const head = [`PLAN · 无可渲染的计划`];
    const notes = (plan.notes || []).map((n) => truncateDisplay(`  ⚠ ${n}`, ROW_WIDTH));
    return [...head, ...plan.empty_lines, ...notes];
  }
  const noteLines = (plan.notes || []).map((n) => truncateDisplay(`  ⚠ ${n}`, ROW_WIDTH));
  const head = [
    truncateDisplay(`PLAN ${plan.run} · ${plan.goal}`, ROW_WIDTH),
    truncateDisplay(summaryLine(plan), ROW_WIDTH),
    '',
  ];
  const rows = plan.subtrees;
  const idw = Math.max(2, ...rows.map((r) => r.id.length));
  const rowLine = (r) => truncateDisplay(
    `  ${r.mark} ${r.id.padEnd(idw)}  ${truncateDisplay(r.goal, GOAL_WIDTH)}  `
    + `${CAPABILITY_LABEL[r.capability] || r.capability || '—'} · ${r.note}`,
    ROW_WIDTH,
  );
  const detailLinesOf = (r) => {
    if (!ATTENTION.includes(r.state)) return [];
    const out = [];
    if (r.blocker) out.push(truncateDisplay(`      ↳ 卡在：${r.blocker}`, ROW_WIDTH));
    if (r.next_step) out.push(truncateDisplay(`      ↳ 下一步：${r.next_step}`, ROW_WIDTH));
    return out;
  };

  const tail = [];
  if (plan.needs_attention.length) {
    const ids = plan.needs_attention.slice(0, 3).join('、');
    const more = plan.needs_attention.length > 3 ? ` 等 ${plan.needs_attention.length} 个` : '';
    tail.push(truncateDisplay(`下一步：先处理 ${ids}${more}（详见该行 ↳）`, ROW_WIDTH));
  }

  // 行预算从这里开始一次性分配，硬约束是最终 `lines.length <= MAX_LINES`。
  //
  // 可能出现的行：head（标题 + 摘要 + 空行）、每子树一行、两条**告知行**
  // （「还有 N 个子树未显示」「N 个需处理项的细节被挤掉」）、tail（下一步）。
  // 告知行是「被砍了什么」的唯一证据，不能为了塞下更多行而不印 —— 静默截断
  // 会让用户以为看到的就是全部。所以两条告知行**先各留 1 行**，剩下的预算才给
  // 子树行与细节行。
  const NOTE_ROWS = 2;
  const MAX_ROWS = Math.max(1, MAX_LINES - head.length - noteLines.length - tail.length - NOTE_ROWS);
  let shown = rows;
  let droppedRows = 0;
  if (rows.length > MAX_ROWS) {
    shown = rows.slice(0, MAX_ROWS);
    droppedRows = rows.length - shown.length;
  }
  const droppedFlag = droppedRows > 0 ? 1 : 0;
  let budget = Math.max(0, MAX_LINES
    - (head.length + shown.length + droppedFlag + noteLines.length + tail.length + NOTE_ROWS));

  // 细节行按严重度顺序分配。同一状态内保持图的原有顺序（plan 的顺序本身有意义）。
  const detailByRow = new Map();
  for (const state of ATTENTION) {
    for (const r of shown) {
      if (r.state !== state) continue;
      const dl = detailLinesOf(r);
      const take = Math.min(dl.length, budget);
      if (take > 0) {
        detailByRow.set(r.id, dl.slice(0, take));
        budget -= take;
      } else {
        detailByRow.set(r.id, []);
      }
      if (budget <= 0) break;
    }
    if (budget <= 0) break;
  }
  const truncatedDetails = shown.filter((r) => ATTENTION.includes(r.state)
    && (detailByRow.get(r.id) || []).length < detailLinesOf(r).length).length;

  const lines = [...head];
  for (const r of shown) {
    lines.push(rowLine(r));
    for (const d of detailByRow.get(r.id) || []) lines.push(d);
  }
  if (droppedRows > 0) {
    lines.push(truncateDisplay(`  … 还有 ${droppedRows} 个子树未显示（图里共 ${rows.length} 个）`, ROW_WIDTH));
  }
  if (truncatedDetails > 0) {
    lines.push(truncateDisplay(`  … ${truncatedDetails} 个需处理项的细节被行数上限挤掉`, ROW_WIDTH));
  }
  lines.push(...tail);
  lines.push(...noteLines);
  return lines;
}

/**
 * 从已读好的输入算出 plan。**纯函数**：不读盘（`probe` 注入）。
 *
 * 把所有子树的进度汇总成 `totals` 与 `needs_attention`，并把台账的坏行数带出来 ——
 * 台账读不懂的行意味着「对账少看了几条」，那必须出现在人读的输出里。
 */
export function buildPlan({
  graph = null, graphError = null, graphErrorMsg = null,
  claimRows = [], claimBadLines = [], promptRows = [], promptBadLines = [],
  run = null, path = null, nowMs = Date.now(), probe = null, root = ROOT, checked = 0,
} = {}) {
  const probeFn = probe || defaultProbe(root);
  const notes = [];
  if (claimBadLines.length) notes.push(`claims.jsonl 有 ${claimBadLines.length} 行读不懂（已跳过，对账可能少算）`);
  if (promptBadLines.length) notes.push(`prompts.jsonl 有 ${promptBadLines.length} 行读不懂（已跳过）`);

  if (graphError || !graph || !Array.isArray(graph.subtrees) || !graph.subtrees.length) {
    // 空数组也算空状态：0 个子树的图不是「全部完成」，是「这张图什么也没说」。
    // 若把它当正常图画出来，摘要会是「进度 0/0 完成」—— 那是一种假装。
    const reason = graphError || (graph && Array.isArray(graph.subtrees) ? 'empty-graph' : 'invalid-json');
    const ctx = { path: path ? displayPath(path, root) : '(未知)', msg: graphErrorMsg, checked };
    const empty_lines = emptyReasonText(reason, ctx);
    return {
      v: PLAN_VERSION,
      run,
      goal: null,
      empty: true,
      reason,
      empty_lines,
      subtrees: [],
      totals: { total: 0, done: 0, landed_unclaimed: 0, failed: 0, upstream_failed: 0, stuck: 0, defect: 0, overdue: 0, running: 0, waiting_on: 0, pending: 0 },
      budget_pct: 0,
      max_timeout_min: null,
      needs_attention: [],
      ok: false,
      notes,
    };
  }

  const rec = reconcile({ rows: claimRows, probe: probeFn, nowMs, base: root });
  const byTask = new Map(rec.tasks.map((t) => [String(t.task), t]));

  // 两段式：先算「与别人无关」的本地状态，再让依赖把它们解析成终态。
  // 分两步的理由是**判据不混**——本地状态只吃台账与磁盘（可逐个子树独立复算），
  // 依赖判定只吃「兄弟算完了没」。合在一起写，任何一次图上的改序都会悄悄改变结论。
  const local = graph.subtrees.map((sub) => {
    const id = String(sub && sub.id);
    const task = byTask.get(id) || null;
    const disp = dispatchOf(id, claimRows, promptRows);
    return localStateOf({ sub: sub || {}, task, disp, nowMs, probe: probeFn });
  });
  const { rows: subtrees, cycles } = resolveStates(local);
  if (cycles.length) notes.push(`依赖成环（${cycles.join(' → ')}）—— 有环的图里「等前置」不收敛，先跑 validate-run.mjs`);

  const count = (state) => subtrees.filter((r) => r.state === state).length;
  const totals = {
    total: subtrees.length,
    done: count('DONE'),
    landed_unclaimed: count('LANDED_UNCLAIMED'),
    failed: count('FAILED'),
    upstream_failed: count('UPSTREAM_FAILED'),
    stuck: count('STUCK'),
    defect: count('DEFECT'),
    overdue: count('OVERDUE'),
    running: count('RUNNING'),
    waiting_on: count('WAITING_ON'),
    pending: count('PENDING'),
  };
  const budget = graph.subtrees.reduce((s, x) => s + (Number.isFinite(x && x.token_budget_pct) ? x.token_budget_pct : 0), 0);
  const timeouts = graph.subtrees.map((x) => (Number.isFinite(x && x.timeout_min) ? x.timeout_min : 0)).filter((n) => n > 0);
  const needs_attention = subtrees
    .filter((r) => ATTENTION.includes(r.state))
    .sort((a, b) => ATTENTION.indexOf(a.state) - ATTENTION.indexOf(b.state))
    .map((r) => r.id);

  return {
    v: PLAN_VERSION,
    run: run || graph.run_id || null,
    goal: String(graph.root_goal || ''),
    empty: false,
    reason: null,
    empty_lines: [],
    generated_at: new Date(nowMs).toISOString(),
    subtrees,
    totals,
    budget_pct: budget,
    max_timeout_min: timeouts.length ? Math.max(...timeouts) : null,
    needs_attention,
    ok: needs_attention.length === 0,
    notes,
  };
}

/** 一步到位：读 → 算 → 渲染。`--json` 输出的 `lines` 与默认输出**是同一个数组**。 */
export function renderPlan({ runsDir, run = null, root = ROOT, nowMs = Date.now(), probe = null } = {}) {
  const pick = run ? { run, checked: 0 } : findLatestRun(runsDir);
  if (!pick.run) {
    const plan = buildPlan({
      graph: null, graphError: 'no-run', run: null, nowMs, root, probe, checked: pick.checked,
    });
    return { plan, lines: formatPlan(plan) };
  }
  const loaded = loadRun({ runsDir, run: pick.run });
  const plan = buildPlan({
    graph: loaded.graph,
    graphError: loaded.graphError,
    graphErrorMsg: loaded.graphErrorMsg,
    claimRows: loaded.claimRows,
    claimBadLines: loaded.claimBadLines,
    promptRows: loaded.promptRows,
    promptBadLines: loaded.promptBadLines,
    run: pick.run,
    path: loaded.graphPath,
    nowMs,
    probe,
    root,
  });
  // 台账坏行是事实，必须出现在人读输出里，而不是只藏在 JSON 里。
  if (!plan.empty && plan.notes.length) plan.notes = plan.notes;
  return { plan, lines: formatPlan(plan) };
}

// ── CLI ───────────────────────────────────────────────────────────────

const HELP = `render-plan — 把 task-graph.json 渲染成「这一轮要做什么、现在到哪了」

用法：
  node scripts/render-plan.mjs [--run <run-id>] [--json] [--runs-dir <dir>]

  --run <id>    指定 run（默认取 tasks/runs 下最近改过 task-graph.json 的那个）
  --json        机器可读；其中 lines 与默认输出逐行相同
  --runs-dir    换 run 根目录（默认 tasks/runs）
  --root        换「仓库相对路径」的基准目录（默认仓库根；配合 --runs-dir 用于测试）

进度来自既有台账（claims.jsonl 的 expect / claim / observe / consume +
prompts.jsonl 的派发记录 + outputs 的磁盘状态），判定调用 claim-ledger 的 reconcile。
超时只标「超时」，不判失败 —— 静默不是失败判据（state-model §2.0.1）。

退出码：0 无需处理 / 1 有失败·卡住·超时 或 没有可渲染的图 / 2 用法错误。
`;

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i++;
  }
  return out;
}

/** 进程内调用入口。`overwatch.mjs plan` 转发到这里，而不是打印一条要用户自己复制的命令
 *  —— 那个入口存在的理由就是「干净 clone 上不知道第一条命令该跑什么」。
 *  **同步**：它只读盘与格式化，不 await 任何东西；调用方据此直接拿返回值当退出码。 */
export function main(argv) {
  const args = parseArgv(argv);
  if (args.help) { console.log(HELP); return 0; }
  const runsDir = resolve(String(args['runs-dir'] || join(ROOT, 'tasks', 'runs')));
  const root = resolve(String(args.root || ROOT));
  const run = args.run && args.run !== true ? String(args.run) : null;
  const { plan, lines } = renderPlan({ runsDir, run, root });

  // `--summary`：**只打第一行进度**。给 `overwatch doctor` 用 —— 它自己的预算是
  // 1000ms，而完整渲染实测 350–375ms，内联进来就撞破预算。
  // 但判据**不许有第二份**：summary 的文本就是 `lines[0]` 与 `lines[1]` 拼出来的，
  // 仍出自同一个 `renderPlan()`，不是另写一个「轻量版统计」。
  if (args.summary) {
    // 前两行是 `PLAN <run> · <goal>` 与 `进度 …`；空状态时只有一行说明。
    const head = lines.slice(0, 2).filter((l) => l && l.trim());
    console.log(head.join('\n'));
    return plan.empty ? 1 : 0;
  }

  if (args.json) {
    console.log(JSON.stringify({ ...plan, lines }, null, 2));
  } else {
    // notes 已经并进 `lines`（见 formatPlan），这里不再单独打印 —— 否则
    // `--json` 的 lines 与人读 stdout 就不一致，而「同源」是本文件的硬要求。
    console.log(lines.join('\n'));
  }
  if (plan.empty) return 1;
  return plan.ok ? 0 : 1;
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
