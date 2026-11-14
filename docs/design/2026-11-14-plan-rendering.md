# 每轮开头一个 plan：渲染器设计

> **状态：已实现（`scripts/render-plan.mjs` + 27 条测试）。**
> 本文记录四个设计问题的答案、进度从哪来、以及它在应用里挂在哪。
> 与 `docs/design/` 其余文档不同，这一份描述的是**已经能跑的东西**。

## 0. 为什么会有这一份

用户原话：

> 我希望 AI 的每轮对话最开始都可以像这种列一个 plan，让用户安心知道具体流程

在此之前，这句话是**没有实现**的。两处文档自己承认了：

| 位置 | 原文 |
|---|---|
| `docs/spec/output-format.md:17` | 「仓库里**没有任何脚本输出这个格式**」 |
| `.claude/skills/oversight/SKILL.md:238` | 「每轮携带。**格式是约定，渲染器还没有**」 |

`tasks/runs/*/task-graph.json` 史上只产出过 **2 份**，而且没有任何东西把它们变成人看得懂的一屏。
于是「每轮开头告诉用户要做什么」这件事，每次都由模型现编 —— 编出来的计划与真正派出去的东西没有对过账。

**所以问题不是「设计 plan 格式」。** plan 的数据形状早就定死在 `task-graph.json` 的
`subtrees` 里（`id` / `goal` / `shape` / `acceptance` / `outputs` / `timeout_min`）。
缺的是：这份数据**从哪来、什么时候渲染、谁看见、最后怎么对账**。

## 1. 四个设计问题

### 1.1 来源：`task-graph.json` 是唯一来源

**只从 `task-graph.json` 渲染，不支持「主线程手写一段 plan」。**

理由不是洁癖。手写 plan 与图并存时，两者必然分叉，而分叉之后没人能回答「哪个是真的」。
`claim-ledger.mjs` 已经在治同一类病（子 agent 自述 vs 磁盘），它的结论是「自述不可信，
要有第三方证据」。手写 plan 就是「计划的自述」——它没有第三方可对。

一个附带好处：`validate-run.mjs` 已经在强校验这张图（`outputs` 必填、`acceptance` 必填、
`why_this_layer` 必填）。从图渲染意味着**渲染器的输入已经被校验过一次**，先验地排除了
「渲染一份缺字段的计划」这种失败。

### 1.2 时机：应用里「一轮」= 一次 run

这是本条设计里最容易含糊的地方，必须说死：

| 候选定义 | 为什么不用 |
|---|---|
| 一次用户输入 | 一次输入可能派 3 次 Agent，也可能什么都不派。plan 会一秒内变三次，用户更不安 |
| 一次派发 | 一个 run 里有 5 次派发。用户会看到 5 份 plan，但它们是同一份计划的不同阶段 |
| **一次 run（`tasks/runs/<run-id>/`）** | **选它。** run 是有明确起止的工作单元，`task-graph.json` 与 `claims.jsonl` 都以它为目录 |

所以「每轮对话最开始列一个 plan」在应用形态下的准确含义是：
**每进入一个 run、以及每次状态变化时，重新渲染同一份 plan。** 图不变，变的是进度。

### 1.3 可见性：终端一屏 + `--json`，**不写文件**

- 默认输出：终端，**≤ 20 行**（`MAX_LINES`）。超过就算失败。
- `--json`：机器可读，其中 `lines` 字段与默认输出**是同一个数组**。

**为什么不写 `PLAN.md`：** 仓库已经有两本需要人工同步的台账（`dev-findings.md`、
`accepted-deviations.md`），再加一份会变成第三份。更要命的是它会被 `git add` 进仓，
于是一份**每次状态变化都过时**的文件变成了提交历史的一部分。
需要留档时用 `--json > x.json`，让调用方自己决定写到哪。

### 1.4 对账：`subtrees[].id` 与台账 `task` 是同一个键

这是本条设计能成立的关键，也是**唯一不引入第二套数据**的原因：

```
task-graph.json   subtrees[].id        = "OL2-ST1"
task-graph.json   subtrees[].outputs    = ["scripts/validate-run.mjs"]
                       ↓ 派发时原样传给 claim-ledger declare
claims.jsonl      kind:"expect" task:"OL2-ST1" paths:[...]
claims.jsonl      kind:"claim"  task:"OL2-ST1" path:"scripts/validate-run.mjs"
                       ↓ 收活时对账
claim-ledger reconcile() → { task:"OL2-ST1", verdict:"COMPLETE", items:[...] }
```

`render-plan.mjs` 的判定**一律调用 `claim-ledger.mjs` 的 `reconcile()`**，不重写一遍。

**「plan 说 5 件，最后做了 3 件」怎么发现：** 图里有 5 个 `subtrees`，渲染器逐个子树
查台账。没在 `claims.jsonl` 里出现的子树走 `PENDING` 分支（`○ 待跑`），
**不可能被算进「完成」**。分子 `totals.done` 只统计台账判 `COMPLETE` **且已认领**的子树。
所以「5 件做了 3 件」在输出里就是 `进度 3/5 完成 · 2 待跑`，不需要额外机制。

**一个刻意不做的判定：** 图里有、台账里没有、但磁盘上已经有 outputs 的子树，
判 `LANDED_UNCLAIMED`（`?`），不是 `DONE`。因为「文件在」可能是上一次 run 的遗留，
也可能是别的 agent 顺手写的。`claim-ledger` 的 `EXTRA` 判据正是为此存在。

## 2. 进度从哪来（不自创第二套）

| 证据 | 文件 | 能证明 | 不能证明 |
|---|---|---|---|
| 期望 / 自述 / 痕迹 / 认领 | `claims.jsonl` | 每个子树落了几个文件、是否被主线程认领 | 文件内容对不对（那要验收） |
| 派发记录 | `prompts.jsonl` | 这个子树**曾经被派过** | 活干完了 |
| 磁盘 | `outputs[]` 逐路径 stat | 图里声明要产出的文件此刻在不在 | 是谁写的 |

三条读数合并方式：

```
                              ┌─ claims.jsonl 有 expect/claim/consume？
subtree in task-graph.json ───┤
                              └─ prompts.jsonl 有同名 task？
                                       ↓
                              reconcile(claims) 给出 verdict
                                       ↓
                     stateOf() 把 (verdict, dispatched, elapsed, disk) 折成一个状态
```

`prompts.jsonl` 只用来区分「没派过」（`PENDING`）与「派了没回」（`OVERDUE` / `RUNNING`）。
**它永远不参与「完成」判定** —— 提示词发出去和活干完是两件事，混为一谈正是
`docs/design/2026-11-13-output-reconciliation.md` 要治的病。

## 3. 状态机

八种状态，每一种对应一个**不同的处置**。合并任意两个都会丢信息：

| 状态 | 记号 | 判据 | 下一步 |
|---|---|---|---|
| `DONE` | ✓ | 台账 `COMPLETE` 且已 `consume` | 无 |
| `LANDED_UNCLAIMED` | ? | 文件在但没人自述 / `UNREPORTED` | `adopt` 后认领（不是缺陷） |
| `FAILED` | ✗ | `CONFLICT` / `MISSING` / `DRIFTED` | 按 SKILL.md §4.5 分路处置 |
| `STUCK` | ◐ | `PARTIAL`（落了几个、缺几个） | **只续做缺的**，禁止整轮重跑 |
| `OVERDUE` | ! | 派了超过 `timeout_min` 且零产出 | 先 `observe` 抽痕迹或催一次 |
| `RUNNING` | ▸ | 派了、未超时、还没结论 | 等 |
| `PENDING` | ○ | 没派过（无 expect、无 prompt） | 先 `declare` 再派 |
| `DEFECT` | ⚠ | `shape: artifact` 但 `outputs: []` | 退回 planner 补图 |

**`OVERDUE` 与 `FAILED` 必须分开。** `docs/spec/state-model.md` §2.0.1 已删掉
「间隔大 ⇒ 失败」这条推断（实测 6,308 次大间隔里 94.8% 之后仍有工具调用）。
把超时渲染成失败，等于把已删掉的推断偷偷装回来，而且这次它会驱动重跑。

## 4. 行数上限怎么实现

`MAX_LINES = 20`，硬约束。分配顺序：

1. **每条子树必须先有一行。** 一行就是「这件事存在」的全部证据，砍掉它等于假装没这回事。
2. 剩余预算按 `FAILED → STUCK → DEFECT → OVERDUE → LANDED_UNCLAIMED` 分配细节行，
   每条最多 2 行（「卡在哪」「下一步」）。
3. **两条告知行各预留 1 行**：「还有 N 个子树未显示」「M 个需处理项的细节被挤掉」。
   砍了什么必须印出来 —— 静默截断会让用户以为看到的就是全部。

12 个子树全部超时的实测输出是 19 行，第 1 个子树带两条细节，其余 11 个只留行，
并印出「11 个需处理项的细节被行数上限挤掉」。25 个子树时行本身被砍，印出「还有 5 个子树未显示」。

## 5. 它在应用里挂在哪

**选择：每次状态变化都重新渲染（事件驱动），不是启动时打一次，也不独占 TUI。**

三种候选的权衡：

| 方案 | 为什么不选 / 为什么选 |
|---|---|
| 启动时打一次 | 用户看完就过时了。plan 的价值是「现在到哪了」，静态 plan 只剩「当初说要做什么」 |
| 挂在 TUI 上独占一屏 | TUI 的已有分工是「列表 → 详情 → 复制草稿」（`docs/spec/tui-visual.md`），plan 是它的**输入之一**，不是替代品 |
| **事件驱动，每次状态变化渲染一次** | **选它。** 与 `watch.mjs` 的三层轮询天然对齐：每次扫描到状态变化，就重渲染一次 |

具体接法（**未接线，本文只定义接点**）：

- `renderPlan()` 是纯读函数，可以在任何地方调用：`watch.mjs` 每次扫描后、
  `oversight-tui.mjs` 进入 run 视图时、`stop-verify-hook.mjs` 收工时。
- 它**不写任何文件**，所以接入点之间不会互相竞争。
- 接入时**不要**把它做成定时器 —— 定时器会让 `node scripts/watch.mjs` 的后台进程
  每分钟多一次磁盘扫描（三个台账文件），而 run 的数量与文件大小都不受控。
  应当挂在「扫描已经发现状态变化」那一步之后。

为什么这算「应用」而不是「一个脚本」：它读的是应用自己的运行状态（`tasks/runs/`），
产出的是应用自己的一屏（`docs/spec/output-format.md` 要求的那种），
并且**判定逻辑与对账器共用同一份实现**（`claim-ledger.reconcile`）。
一个脚本的价值是「能跑」；应用组件的价值是「与系统其余部分的真相是同一份」。
第 1.4 节那张数据流图就是这条区别的具体形式。

## 6. 已知局限

1. **`prompts.jsonl` 只有 `compose-agent-prompt.mjs` 会写。** 主线程跳过那一步时
   （直接手写 prompt），`OVERDUE` 与 `PENDING` 的区分会失效 —— 有 `expect` 的仍能区分
   （`expect` 也算派过），完全没有台账行的子树一律显示 `PENDING`。
   这是允许的降级方向：**显示「未派」比显示「失败」安全**。
2. **`exploration` 型子树的「完成」无从判。** `outputs: []` 是合法的（不承诺文件），
   所以它们只能靠 `consume` 或 `expect` 推进到 `DONE`。`reconcile()` 对无路径的
   子树判 `NO-EXPECTATION`，渲染器把它当「派了在跑」处理，不判失败。
3. **不同 run 之间不比较。** 一个 run 的 plan 只对它自己有效。跨 run 的接力另由
   `docs/spec/relay-protocol.md` 管。

## 7. 相关文件

| 文件 | 作用 |
|---|---|
| `scripts/render-plan.mjs` | 渲染器实现（`buildPlan` / `formatPlan` / `renderPlan` / `loadRun`） |
| `scripts/render-plan.test.mjs` | 27 条测试，含 5 条负向 |
| `scripts/claim-ledger.mjs` | 对账的唯一实现（只读它，未改） |
| `scripts/compose-agent-prompt.mjs` | `prompts.jsonl` 的读取契约（只读它的 `readPromptLedger`） |
| `.claude/skills/oversight/SKILL.md` §7 | 状态行约定 —— 本渲染器是它的第一个实现 |
| `docs/spec/output-format.md` §2 | 输出格式约定 —— 同上 |
