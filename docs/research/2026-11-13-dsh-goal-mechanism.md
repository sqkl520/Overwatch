# dsh 的 agent 目标机制逆向：它怎么定目标、怎么追踪、和 Claude Code 的 TodoWrite 差在哪

- 日期：2026-11-13
- 角色：检索 Agent DS1。产出形态：**exploration**（逆向分析，不是设计稿）
- 对象：本机安装的 DeepSeek Harness，**`@deepseek-ai/dsh*` 全部包版本 `0.2.1-rc.2`**，桌面壳 `dshd/version` = `44.7.0`
- 方法：
  1. `D:\dsh\dshd\resources\app.asar`（182,794,869 B，18,309 个条目）——自写 asar 解析器逐条解出文件表与偏移，
     再按前缀抽取 30 余个 `@deepseek-ai/dsh-*` 包（含 `lib/*.js` 与 `README.md`）。**下面所有 `文件:行号` 都是抽取出的真实 JS 的行号**，
     括号里附 asar 内偏移供复核（绝对字节 = 4,779,796 + offset）。
  2. `D:\dsh\dshd\resources\app.asar.unpacked\`、`~/.dsh/`（profiles / sessions / presets）——确认真实运行配置。
  3. **真实会话日志**：`~/.dsh/sessions/**/session.v4.jsonl.zstd` 共 **1,426 个会话**，用 Node 内置 zstd 全量解压后统计
     `todo/write`、`goal/change`、`goal` 来源 `user/message` 的真实分布（不是推测）。
  4. `.tmp-analysis/dsh-ref`（`deepseek-ai/dsh-superagent-prototype`）——只看它把「目标」落到工单/授权上的那一段。
  **未运行 dsh 做任何任务，未修改 Overwatch 代码，未碰 git。**

> 口径说明（反例，避免混淆）：本机 `dsh` 安装根下的 `dshd` 子目录是 Electron 桌面壳 + 完整 `dsh` 包树；
> 同一根下的 `dsh plugin` 子目录是**本机用户的插件开发工作目录**（不是 dsh 本体）。
> 另外同盘 `Projects` 下的 `dsh-fcl-android-launcher`（安卓启动器）、`dsh-purge`（NTE 逆向）是用户自己的项目，
> 与本文无关，未纳入分析。

---

## 零、结论先行

| 问题 | 结论 |
|---|---|
| dsh 有没有类似 TodoWrite 的机制 | **有，而且有两套，不是一套。** ① `todo_write`——和 Claude Code 的 TodoWrite 几乎同构的**会话内任务清单**；② `goal` 子系统——**每会话一个持久完成目标**，带 4 态生命周期、revision/compare-and-set、以及**自动续行（每轮往会话里塞一条 `<goal_round>` 用户消息）**。Claude Code 只有①。 |
| ①的 schema | `{ todos: [{ content: string, status: 'pending'\|'in_progress'\|'completed' }] }`，**整表替换**，`additionalProperties: false`，无 id / 无 owner / 无 activeForm / 无 blocks。 |
| ②的 schema | `{ goal: { id, revision, objective, phase, blockedReason?: {code,message}, maxGoalRounds }, roundsStarted, createdAt, updatedAt }` + `activation: 'armed'\|'disarmed'`（**进程本地，不持久化**）。phase 四态 `active / paused / blocked / complete`。 |
| 「目标怎么定的」 | 模型自己调 `create_goal(objective, max_goal_rounds?)`，**从人类原话里「推断」**（`CREATE_DESCRIPTION` 原文："even if the user did not say goal"）。**没有独立的「先澄清再定目标」环节**；澄清只有两个可选钩子：`ask_user_question`（工具）和 plan mode（`exit_plan_mode` 由人审批）。 |
| 最硬的约束在哪 | **不在 schema，在权威校验**：`create/edit/pause/resume` 必须发生在**顶层 agent 的当前 turn 且该 turn 含一条 source.kind==='user' 的消息**；子 agent 造不出目标。这是 Claude Code TodoWrite 完全没有的一层。 |
| 有没有「目标 vs 证据」核对 | **没有独立的**。dsh 自己在 README 里把它列为 Known Limitation：`No independent evaluator`，「the caller that records completion or blocking is authoritative」。唯一带 `evidence` 字段的是 `ralph` 的轮次报告（`evidence: string[]`），但那也只是**worker 自己填**，不校验。 |
| 谁更适合我们 | **分工抄**：**目标层抄 dsh 的 goal**（单目标 + 阶段 + revision + 轮次预算 + 权威校验），**执行层抄 Claude Code 的 TodoWrite 的克制**（更少字段、更好强制）。见 §7。 |
| 最值得警惕的实测数据 | 1,426 个真实会话里，**只有 10 个用过 goal**（20 条 `goal/change`），**实际被消费的 goal 轮次总共 10 轮**，其中 6 个 goal 停在 `active` 且 `roundsStarted=0`（创建了就没人续）。同一批会话里 `todo_write` 被调 **364 次 / 157 个会话**。**目标机制不是高频路径。** |

---

## 一、dsh 的「目标」是什么：三套并列，不是一套

dsh 把「目标」拆成了**互不引用**的四个包，没有一个统一的 Goal 抽象层能覆盖全部。

| 机制 | 包 | 粒度 | 谁写 | 有没有自动推进 |
|---|---|---|---|---|
| `todo_write` | `@deepseek-ai/dsh-tool-todo` | **清单**（多条，每条三态） | 模型 | 无 |
| `goal` | `dsh-goal`（服务）+ `dsh-tool-goal`（模型工具）+ `dsh-command-goal`（`/goal` 命令）+ `dsh-goal-round-driver`（续行） | **单条持久目标**（每会话至多 1 个） | 模型 **或** 人（`/goal`） | **有**（轮次驱动） |
| plan mode | `@deepseek-ai/dsh-plan-mode` | **一次「计划」**（markdown 文本，人审批） | 模型写、人批 | 无 |
| `ralph` | `@deepseek-ai/dsh-tool-ralph` | **一个不可变 objective**，每轮起新 agent | 模型 | 有（固定循环） |
| Team 任务板 | `dsh-experimental-agent-team` | **共享 DAG**（多 agent 一条板） | 任一 team 成员 | 无（readiness 只是提示） |

组件装配见 `dsh-base/cordis.patch.yml:323-332`（goal / goal-round-driver / command-goal / plan-mode 四行）
与 `:437-445`（tool-todo 与 tool-goal）：

```yaml
323:    - id: goal            name: '@deepseek-ai/dsh-goal'
326:    - id: goal-round-driver   name: '@deepseek-ai/dsh-goal-round-driver'
329:    - id: command-goal    name: '@deepseek-ai/dsh-command-goal'
332:    - id: plan-mode       name: '@deepseek-ai/dsh-plan-mode'
437:    - id: tool-todo       name: '@deepseek-ai/dsh-tool-todo'
440:        allowParallelInProgress: true
444:    - id: tool-goal       name: '@deepseek-ai/dsh-tool-goal'
```

注意 `hold on`：`goal` 是**默认装上的**（base bundle），不是实验特性。上面那行注释原文是
"Persisted same-session goals reach the model and the slash menu here"。

---

## 二、`todo_write`：和 Claude Code 同构，但字段更少、约束更硬

### 2.1 schema（真实、逐字）

工具注册在 `dsh-tool-todo/lib/index.js:95-186`（offset 92,806,078），参数声明 `:99-121`：

```js
parameters: { todos: {
  type: "array",
  required: true,
  description: "The COMPLETE task list, replacing any previous list.",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      content: { type: "string", required: true,
                 description: "What the task is — a short imperative line." },
      status:  { type: "string", required: true,
                 enum: ["pending", "in_progress", "completed"],
                 description: "pending (not started) | in_progress (now) | completed (done)." }
    }
  }
} }
```

我在**真实会话日志**里核对了模型实际收到的 schema（读 `request/header` 事件，非 README）：

```json
{"type":"object","properties":{"todos":{"type":"array",
 "description":"The COMPLETE task list, replacing any previous list.",
 "items":{"type":"object","additionalProperties":false,
  "properties":{"content":{"type":"string","description":"What the task is — a short imperative line."},
                "status":{"type":"string","description":"pending (not started) | in_progress (now) | completed (done).",
                          "enum":["pending","in_progress","completed"]}},
  "required":["content","status"]}}},"required":["todos"]}
```

**字段数 2 个**。没有 `id`、没有 `activeForm`、没有 `owner`、没有 `blocks/blockedBy`、没有 `metadata`。

### 2.2 三个硬约束（都在 `execute` 里，不在 schema 里）

`dsh-tool-todo/lib/index.js:45-68`（`toTodoList`）：

| 约束 | 代码行 | 失败信息 |
|---|---|---|
| `content` trim 后非空 | `:50-53` | `invalid todo: \`content\` must be a non-empty string` |
| `content` **全表唯一**（去重） | `:54-56` | `invalid todos: duplicate content "…"` |
| `allowParallelInProgress: false` 时 **至多 1 个 `in_progress`** | `:66` | `invalid todos: at most one task may be in_progress (got N)` |
| 必须有调用方 agent session | `:172-173` | `todo_write requires an owning agent session` |

`allowParallelInProgress` 是**必填无默认值**的部署配置（`:20`，`z.boolean().required()`）：

```js
20: const Config = z.object({ allowParallelInProgress: z.boolean().required() });
```

`dsh` base bundle 里设成 `true`（`cordis.patch.yml:440`）——**即 dsh 官方默认允许并行 in_progress**，与 Claude Code 的
「同时只能有一个 in_progress」纪律相反。工具描述里这一句也是随配置变的（`:21-32`）：

```js
21: DESCRIPTION_HEAD  = "Record and update a task list to plan multi-step work and show progress; skip it for trivial
                        single-step tasks. Add one todo per concrete step before you start. "
22: DESCRIPTION_PARALLEL = "While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. "
23: DESCRIPTION_SINGLE   = "While work remains, keep exactly one todo `in_progress`. "
24: DESCRIPTION_TAIL     = "Mark each todo `completed` as soon as it is done."
```

### 2.3 状态存哪、什么时候清空（这是 dsh 的一个真设计）

```js
80:  ctx.sessionProjections.register({
81:    key: "todos",
85:    apply: (state, event) => {
86:      if (event.type === "todo/write") return event.data.todos;
87:      if (event.type === "turn/start") return null;      // ← 新一轮开始即清空
88:      return state;
89:    },
93:    stateVersion: 2
```

- 写入是一次 `session.append("todo/write", { todos })`（`:174`），**整表快照**，回放 last-write-wins。
- 投影（projection）在 **`turn/start` 时把清单置 null** —— 也就是说 **UI 上的清单是「本 turn 的」，跨 turn 不累积**。
  这和 Claude Code 的 TodoWrite（清单跨 turn 常驻、靠 `turnsSinceLastTodoWrite` 提醒刷新）是**相反的策略**。
- 但事件日志里旧快照都在，`session-format-v0-to-v1` 还专门给它做了迁移映射（`"todo/write": disposition(["todos"])`）。
- 工具**没有任何 system prompt section**：`dsh-tool-todo/lib/index.js` 里 `systemPrompt` 出现次数为 0。
  **强制力全靠工具描述一句话** —— 这一点和 Claude Code 靠 `<todo_reminder>` 注入 + `turnsSinceLastTodoWrite` 计数器
  反复催，是**两个方向**：dsh 更松（描述里只说 "skip it for trivial single-step tasks"），Claude Code 更主动（会主动催）。

### 2.4 真实使用情况（1,426 会话全量统计）

| 指标 | 数值 |
|---|---|
| 用过 `todo_write` 的会话 | **157 / 1,426**（11.0%） |
| `todo_write` 调用总数 | **364** |
| 成功写入的 `todo/write` 事件 | **354** |
| 被 schema 拒的调用 | **10**（2.7%） |
| 每会话调用次数 | min 1 / 中位 2 / max **24** |
| 单次清单最大条数 | **19** |
| 状态分布（所有出现过的 item） | pending 1,471 / completed 1,119 / in_progress 410 |

**10 次失败全部是「模型塞了 schema 没声明的字段」**，逐条实测（聚合其他工具的噪声后）：

```
"todos[0].id" is not a declared property (additionalProperties: false)    ×3
"todos[0].G" / "todos[0].surface" / "todos[0].self" is not a declared property ×各1
"todos[2]" must be an object                                             ×1
"todos" must be an array                                                 ×1
```

其中一条完整样本（session `n-236012bc-…`，seq 491→492）值得单独说：模型提交了**带 `activeForm` 的 Claude Code 风格清单**，
被 `additionalProperties: false` 当场拒掉：

```json
{"todos":[{"content":"Author new_api_internship_project_plan.md …","status":"completed","activeForm":"Authoring the project plan"}, …]}
```
```
{"type":"tool/result","data":{…"content":[{"type":"text","text":"Error: invalid arguments: \"todos[0].activeForm\" is not a declared property (additionalProperties: false); …"}],"isError":true},"error":{"name":"ToolArgsError","code":"INVALID_ARGS"}}}
```

**这是本次分析里信息量最大的一条实测**：模型会把 Claude Code 的习惯带过来，而 dsh 选择**硬拒而不是静默忽略**。
`dsh-tool-todo/README.md` 把这条写成了显式设计目标：「the logged snapshot must equal what the model believes it wrote,
so a nested/extended item shape fails loud at the schema boundary instead of silently flattening」。

---

## 三、`goal`：dsh 真正的「定目标」机制

这是 Claude Code 完全没有的东西，也是用户问的那部分。

### 3.1 完整 schema

服务端 wire schema，`dsh-goal/lib/types/index.js:51-65`（offset 76,965,448）：

```js
51: const goalProjectionSchema = zod.union([
52:   zod.object({
53:     goal: zod.object({
54:       id: zod.string().min(1),                             // "goal-<uuid>"
55:       revision: zod.number().int().positive(),              // 从 1 开始，每次变更 +1
56:       objective: zod.string().min(1),                       // 唯一的目标文本
57:       phase: zod.union([zod.literal('active'), zod.literal('paused'),
58:                         zod.literal('blocked'), zod.literal('complete')]),
58:       blockedReason: zod.object({ code: zod.string(), message: zod.string() }).optional(),
59:       maxGoalRounds: zod.number().int().positive(),
60:     }),
61:     roundsStarted: zod.number().int().nonnegative(),
62:     createdAt: zod.number(), updatedAt: zod.number(),
63:   }),
64:   zod.null(),                                               // 无目标 = null
65: ]);
```

模型侧工具 schema 有三件（`dsh-tool-goal/lib/index.js:265-330`，offset 92,131,920）：

| 工具 | 参数 |
|---|---|
| `get_goal()` | 无 |
| `create_goal(objective, max_goal_rounds?)` | `objective: string`（必填）、`max_goal_rounds?: number` |
| `update_goal(goal_id, revision, action, objective?, max_goal_rounds?, blocked_reason?)` | `action ∈ {edit, pause, resume, complete, blocked}` |

`update_goal` 的 `goal_id`/`revision` 是 **compare-and-set 前置条件**（`:214-220` 组 ref，`:395-401` 校验陈旧 revision，
错误码 `GOAL_STALE_REVISION`）。**模型必须先 `get_goal` 再 `update_goal`** —— 这是工具描述里明写的协议。

### 3.2 目标怎么产生的——**没有澄清环节，只有「推断」**

`dsh-tool-goal/lib/index.js:123`：

```js
const CREATE_DESCRIPTION = "Create a persisted goal that keeps this session working across automatic continuation rounds.
  Use it when the direct human request is a long-running objective, even if the user did not say \"goal\"; not for single-turn work.";
```

system prompt section `tool:goal`（`:195-198`，order = `TOOL_GOAL` = 2400 per `dsh-system-prompt/lib/index.js:30`）：

```
create_goal may infer goal intent from a direct human request in any language. After session resume or fork, an active goal is
disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it.
Mark complete only when the objective is actually achieved. Mark blocked only after the same blocking condition persists for at
least 3 consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful
remaining work is not blocked.
```

**这段在真实会话的 system prompt 里逐字存在**（我从 session `0bbe30e8…` 的最后一个 `system/message` 里 dump 出来，7,913 字符，
该段在第 33 行）。

真实样本：用户只说了 15 个字的需求，模型 12 步之后自己造了一个 200 字的 objective（session `session-0bbe30e8…`）：

```
用户原话（seq 17）：
  "请给我做一个dsh插件来使用户更方便的查看用量统计 / 查看 AI 模型的使用情况和成本统计 /
   你可以上网搜索现成的工具学习来方法，参照更成熟的项目 / 比如cc switch"

模型 create_goal（seq 125，同一 turn 内）：
  {"objective":"交付一个可安装、可运行的 DSH 插件 dsh-tally：在 DSH Web GUI 中便捷查看 AI 模型的用量统计与成本
   （按会话/模型/供应商/时间聚合 token、缓存、成本），参照 ccusage / cc-switch 等成熟项目的设计与价格数据方案；
   含 Host 侧数据聚合、Client 侧 UI 面板、安装与验证文档。","max_goal_rounds":40}

落库（seq 126）：
  {"type":"goal/change","data":{"kind":"goal/change","version":1,"operation":"create",
   "goal":{"id":"goal-86652695-…","revision":1,"objective":"…","phase":"active","maxGoalRounds":40},
   "roundsStarted":0,"createdAt":1792161435298,"updatedAt":1792161435298}}
```

**关键点：目标的「可验收性」完全由模型这次改写决定。** dsh 不校验 objective 里有没有可测量的判据，
没有模板、没有必填的 success criteria 字段。上面这条恰好写得好（"可安装、可运行"、列了四块交付物），
但这是模型自觉，不是机制保证。

**有没有「先澄清」？** dsh 提供两个可选钩子，但**都不在 goal 流程里**：

1. `ask_user_question`（`dsh-tool-ask-user`）：一次可以问多个问题，每题带 id/header/options，推荐项须排第一并标 `(Recommended)`；
   `mode: timed` + `timeout` 可在超时后放模型继续干别的（问题仍可回答）。**子 agent 不能调**（`DELEGATED_CALLER`），
   必须由 runtime root 调。
2. plan mode 的 `exit_plan_mode(plan)`（`dsh-plan-mode/lib/index.js:231-245`）：plan 必须是 markdown 且以 `# ` 开头，
   经 `userQuestions` 以 `intent: 'plan-review'` 呈现给人 **Approve / Keep planning**。
   base bundle 给的 plan 指令（`cordis.patch.yml:334-346`）明确写了分工：

   > "Do not use todo_write to track this planning phase: it tracks implementation after an approved plan,
   >  while the plan itself belongs in exit_plan_mode."

   —— **dsh 自己在 prompt 里把「计划」和「任务清单」切开了**，这一点比 Claude Code 清楚。

### 3.3 目标定了会不会变、怎么变

7 个 operation，全部**追加 `goal/change` 事件**（version 1，带变更后的**完整快照**，不是 delta）：

| operation | 允许的起始 phase | 结果 phase | 额外要求 |
|---|---|---|---|
| `create` | 无目标，或当前是 `complete` | `active` | revision 必须 = 1，roundsStarted 必须 = 0，id 必须是新 id |
| `edit` | 任意 | 不变 | objective / maxGoalRounds 至少改一个；**不能动 phase 和 blockedReason** |
| `pause` | `active` | `paused` | |
| `resume` | `active`(disarmed) / `paused` / `blocked` | `active` | **roundsStarted < maxGoalRounds**，否则拒 |
| `complete` | `active` / `paused` / `blocked` | `complete` | |
| `block` | `active` | `blocked` | blockedReason 必填，`code` 必须 lower-kebab-case |
| `clear` | 任意 | 无目标（写 tombstone） | revision +1 |

状态机是**严格回放折叠**的（`dsh-goal/lib/types/fold.js:169-215`，offset 76,951,153），
`validateSnapshotTransition` 会拒：不连续 revision、非法 phase 转移、创建/更新计数被改、时间戳倒流。
`create` 的规则在 `:260-267`：

```js
if (change.goal.revision !== 1 || change.goal.phase !== 'active' || change.roundsStarted !== 0
    || (state.goal !== undefined && state.goal.phase !== 'complete')
    || state.seenGoalIds.has(change.goal.id)) {
  throw new Error('goal create requires a fresh active revision-one goal with zero rounds');
}
```

**这意味着一件事：`/goal <新目标>` 只能在「当前无目标」或「当前已完成」时生效**，
否则必须先 `edit` / `pause` / `block` / `clear`。见 `dsh-command-goal/lib/index.js:127-143` 的拒绝文案：

```
"A goal is already {phase}. Use /goal edit <objective> to change it or /goal clear before replacing it."
```

### 3.4 目标是「每会话一个」

服务 `create` 里的硬拒（`dsh-goal/lib/types/index.js:271-277`）：

```js
271:  create(agent, request) {
272:    const spec = resolveCreateGoal(request, this.resolved.defaultMaxGoalRounds);
274:    const current = state?.goal;
275:    if (current !== undefined && current.phase !== 'complete') {
276:      throw new GoalError(`goal "${current.id}" already exists with phase "${current.phase}"`, 'GOAL_ALREADY_EXISTS');
```

README 里写明这是刻意的：「**One current goal** — parallel objectives and a separate goal database are intentionally absent」。

### 3.5 真实使用：低频、且大量「创建了就没人续」

| 指标（1,426 会话全量） | 数值 |
|---|---|
| 有过 `goal/change` 事件的会话 | **10** |
| `goal/change` 事件总数 | **20**（create 13 / complete 6 / clear 1） |
| 调过 `create_goal`/`update_goal`/`get_goal` 的会话 | **13** |
| **实际被消费的 goal 轮次**（source.kind==='goal' 的 user/message） | **10 轮，分布在 4 个会话** |
| 最终停在 `active` 的 goal | **6 / 10** |
| 其中 `roundsStarted = 0` 就停住的 | **全部 6 个** |
| `create_goal` 失败次数 | 15 次调用中 **2 次**，错误都是 `this goal operation requires a direct human turn on a top-level agent` |

**这是本次分析最重要的负面证据**：dsh 的目标机制**存在、可用、但极低频**，而且「创建了目标却一轮都不自动跑」
是主要形态（6/10）。原因从代码可以解释：`activation` 是进程本地的，**任何 session 边界（resume/fork/agent/created）
都会把 active goal 置为 disarmed**，必须由人显式 `resume`（或 `/goal resume`）才重新武装。
会话一关，目标就静止。

---

## 四、目标怎么追踪

### 4.1 进度 = 轮次计数，不是完成度

进度只有一个量：`roundsStarted / maxGoalRounds`。`maxGoalRounds` 默认 **256**（`dsh-goal/lib/types/index.js:217`），
`create_goal` 可覆盖，必须正整数。真实会话里人手动设的值：12 / 30 / 30 / 40 / 60 / 80 / 256 —— **人比默认值保守得多**。

轮次怎么被算：**只有真正进入模型历史的 goal 消息才算一轮**。`fold.js:294-303`：

```js
if (event.type === 'user/message') {
  const source = goalSource(event.data.source);
  if (source === undefined) return;
  const current = state.goal;
  if (current === undefined || current.phase !== 'active' || source.goalId !== current.id
      || source.revision !== current.revision || source.round !== state.roundsStarted + 1
      || source.round > current.maxGoalRounds) {
    throw new Error(`goal round at session event ${event.seq} is not the next admitted round of the active goal`);
  }
  state.roundsStarted = source.round;
}
```

即 **round 必须严格 +1 连续**，跳号/重号都判为回放失败。driver 侧对应「先预约再准入」：
`dsh-goal-round-driver/lib/index.js:142-166` 先算 `round = roundsStarted + 1`、构造带
`source: {kind:'goal', goalId, revision, round}` 的消息，再 `agent.followup(message)`（`:164`）；
**只有消息真的进了历史才计数**（reservation 被判定 stale 不消耗轮次）。

### 4.2 每一轮模型看到什么（唯一的目标重申点）

`dsh-goal-round-driver/lib/index.js:11-19`（offset 76,738,446）：

```
<goal_round>
Objective: "<JSON-quoted objective>"
Round: 3/40

Continue working toward the objective in this same session. Treat the current workspace, tool results, and durable session
state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and
verify the result. Before claiming completion, gather evidence that the whole objective is achieved, read the current goal,
and mark it complete. If work remains, leave the goal active for the next round. Follow the configured goal-tool policy
before reporting a blocker.
</goal_round>
```

**注意这几句是整个 dsh 里唯一「要求证据」的地方**，而且是**软约束**：
"gather evidence that the whole objective is achieved"、"Treat the current workspace, tool results, and durable session
state as authoritative; inspect them instead of assuming earlier narration is still current"。
没有 schema、没有校验、没有第二个人复核。

真实日志里逐字存在（session `0bbe30e8…` seq 4606 / 4610，objective 被 JSON 引号包住，中文照原样）：
```
{"type":"user/message","data":{"content":[{"type":"text","text":"<goal_round>\nObjective: \"交付一个可安装、可运行的 DSH 插件 dsh-tally：…\"\nRound: 1/40\n\nContinue working toward…"}]}}
```

### 4.3 目标完成怎么判定

**模型说了算。** 唯一的机制性约束是**权威来源**（谁有权说「完成」），不是**内容校验**：

`dsh-tool-goal/lib/index.js:72-79`（`completionAuthority`）：

```js
function completionAuthority(ctx, execution) {
  if (hasDirectHumanInput(ctx, execution)) return { kind: "direct-human" };
  const goal = ctx.goals.get(execution.agent);
  if (goal !== void 0 && isMatchingGoalRound(execution, goal)) return { kind: "goal-round", goal };
  return reject("complete and blocked require a direct human turn or the current goal round");
}
```

也就是说 `complete` / `blocked` 只接受两种授权：**人说的**，或**当前这一轮正好是这个 goal 的这个 revision 的这一 round**。

`blocked` 额外有**轮次下限**（`:360`）：

```js
if (args.action === "blocked" && authority.kind === "goal-round"
    && authority.goal.roundsStarted < resolved.blockedAfterConsecutiveRounds)
  throw new HarnessError(`blocked requires at least ${N} consecutive goal rounds; current round is ${…}`, "GOAL_TOOL_BLOCK_THRESHOLD");
```

`blockedAfterConsecutiveRounds` 默认 3（`:115`，`z.number().step(1).min(1).default(3)`）。**这是 dsh 唯一一个
「用轮次数硬拦模型偷懒」的机制**：想放弃？至少跑满 3 轮再说。这个思路值得抄。

`complete` 成功后还会 `exec.deferContext(...)` 注入一段 `<goal_complete>` 收尾指令（`:366`、`:85-96`），
要求模型「只报本会话前面轮次和工具结果真正确立的东西；会话里没有的细节就说没有，不要编」。

### 4.4 有没有「目标 vs 证据」的核对

**没有。** dsh 自己在两处 README 里承认：

`dsh-goal/README.md` Known Limitations:
> **No independent evaluator** — the caller that records completion or blocking is authoritative; evaluator-backed
> certification is deferred to a separate policy layer.

`dsh-goal-round-driver/README.md` Known Limitations:
> **No independent evaluator** — the model-facing goal policy decides when evidence is sufficient for completion and whether
> a blocker is semantically unchanged.

**唯一带结构化 `evidence` 的地方是 `ralph`**（`dsh-tool-ralph/lib/index.js:40-46`，offset 92,371,576）：

```js
const reportSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['continue', 'complete', 'blocked'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
    blocker: { type: 'string' },
  },
  required: ['status', 'summary', 'evidence', 'nextSteps', 'blocker'],
  additionalProperties: false,
}
```

校验规则（`:71-88`）**只校验形状，不校验内容**：

| status | 强制条件 |
|---|---|
| `continue` | `nextSteps.length > 0` 且 `blocker === ''` |
| `complete` | **`evidence.length > 0`** 且 `nextSteps.length === 0` 且 `blocker === ''` |
| `blocked` | `blocker` 非空 |

「`complete` 必须有至少一条 evidence」—— **这正是我们最缺的那条判据的形式**，但注意它只是「非空数组」，
`evidence: ["ok"]` 也能过。工具的 `DESCRIPTION`（`:124`）还专门提醒："Completion and blockers are worker reports,
not independent evaluation."

---

## 五、多 agent 场景下目标怎么分

**结论：dsh 的目标不跨 agent。父子目标之间没有对齐机制。**

### 5.1 派子 agent 时目标怎么传

`subagent` / `subagent_fork` 的参数里**没有 goal 字段**（真实 `request/header` 里读到的 schema）：

```
subagent:       { description: "3-5 word", prompt: "The complete, self-contained task…" }
subagent_fork:  { description, prompt: "…It already sees this conversation's completed turns…" }
```

- **`subagent`（spawn，全新上下文）**：目标只能靠 `prompt` 一段文本传。描述原话："It does not share this
  conversation's context, so include everything it needs."
- **`subagent_fork`（fork，继承已完成 turn）**：子 agent 拿到父会话**已完成 turn 的前缀**，但
  `dsh-subagent-fork-in-process/README.md` 明说：*"The seed carries conversation history only: the child still gets a
  fresh tool scope and none of the parent's authority."* **`activation` 是 per-session 的进程本地缓存，fork 出来的
  session 一定是 disarmed**（`dsh-goal/lib/types/index.js:227-229` 的 `ctx.on('agent/created')`）。

### 5.2 子 agent 能不能有自己的 goal

**能，但不影响父目标。** `GoalService` 以 `session` 为 key（`runtimeStates: WeakMap<Session, …>`），
每个 session 一份。所以子 agent 理论上能 `create_goal`——但被权威校验挡住：

`requireDirectHuman`（`dsh-tool-goal/lib/index.js:49-64`）：

```js
function hasDirectHumanInput(ctx, execution) {
  if (!ctx.agents.roots().includes(execution.agent)) return false;      // ← 必须是 root agent
  return someOpenTurnEvent(execution, e => e.type === "user/message" && e.data.source.kind === "user");
}
```

`create_goal` / `update_goal(edit|pause|resume)` 都先 `requireDirectHuman`（`:292`、`:343`、`:349`）。
**子 agent 不是 root，永远过不了这一关**。实测证据：2 次 `create_goal` 失败，错误都是
`this goal operation requires a direct human turn on a top-level agent`。

### 5.3 「父目标完成 = 所有子目标完成」有没有

**没有这种判定，但有一个反向的等待**：driver 在起新一轮之前会**等所有子 agent 静默**：

`dsh-goal-round-driver/lib/index.js:130-135`：

```js
const subagents = ctx.get("subagents");
if (subagents !== void 0) {
  await Promise.race([subagents.waitForChildren(agent), unloading.promise]);
  if (!readyAfterCheckpoint(state)) return;
}
```

即「**父目标推进的前置条件是子 agent 全部静默**」，但子 agent 做了什么、算不算完成，driver 不看。
README 原话："A round starts only at whole-agent idle and, when the subagent service is loaded, only after the agent's
progressing descendants settle"。

### 5.4 真正做多 agent 协作目标的是 Team 任务板（实验性、非默认装上）

若要看「多 agent 共享目标」，得看 `dsh-experimental-agent-team`（**实验包，默认不在 base bundle 里**）。
它的任务 schema（`lib/types/task-board.js:42-51`，offset 46,583,276）：

```js
const task = {
  id,                                   // "task-<n>"
  revision: 1,                          // CAS 前置
  subject:  requiredText(request.subject, 'subject', 200),
  description: requiredText(request.description, 'description', 16_384),
  status: 'pending',                    // pending | in_progress | completed | deleted
  blockedBy: this.dependencies(request.blockedBy ?? [], state),   // DAG
  writeScopes: this.writeScopes(request.writeScopes ?? []),       // 文件前缀，仅告警
};
```

三处值得注意：
- **`writeScopes` 只产生 warning，不阻塞任何东西**（`task-view.js:36-43`、`:54`；police 文本在
  `dsh-experimental-tool-agent-team/lib/index.js:29`："Write-scope overlap is advisory, not a lock"）。
- **`ready` 不是「被分配」，是「依赖都完成」**（`task-view.js:18-20`）：
  ```js
  export function taskReady(state, task) {
    return task.blockedBy.every(id => state.tasks.find(c => c.id === id)?.status === 'completed');
  }
  ```
  而且 `ready` 只是**查询谓词**，不会自动启动任何 owner（policy 原话："Task readiness never starts an owner"）。
- **claim 必须带当前 revision**（`task-board.js:97-118`），陈旧就 `TEAM_TASK_STALE_REVISION`。

---

## 六、和 Claude Code TodoWrite 的逐维对比

Claude Code 一侧的口径来自本次任务给定的背景（schema `{id, subject, description, activeForm, owner, status, blocks,
blockedBy, metadata}`，三态，靠 `turnsSinceLastTodoWrite` + `todo_reminder` 提醒）。dsh 一侧全部来自上文实证。

```
维度                | Claude Code TodoWrite                    | dsh 的机制                                   | 谁更好 | 理由
--------------------|------------------------------------------|----------------------------------------------|--------|--------------------------------------------
对象                | 清单（多条）                             | 清单（todo_write）+ 单目标（goal），两套并存  | 平     | 两套解决两个问题；dsh 额外有 goal 是净增益
字段                | id, subject, description, activeForm,    | content, status（2 个）                      | CC 略胜| CC 的 subject/description 分离更好读；但 CC
                    | owner, status, blocks, blockedBy, meta   |                                              |        | 的 8 字段里 4 个（id/blocks/blockedBy/meta）
                    |                                          |                                              |        | 实测几乎没人用，是纯负担
状态数              | 3（pending/in_progress/completed）       | todo 3 个；goal 4 个（+paused/blocked）       | dsh    | paused/blocked 是「停但不结束」，CC 只能在
                    |                                          |                                              |        | 文字里说「卡住了」，状态机看不见
并行 in_progress    | 只允许 1 个（隐含）                      | 部署配置决定；dsh base 默认 true（允许多个）  | CC     | 「同时只有一个进行中」是可读性最强的约束；
                    |                                          |                                              |        | dsh 把它做成配置说明它自己也没想清楚
持久化              | 会话内，跨 turn 常驻                     | 事件日志快照；**投影在 turn/start 置 null**   | 各有   | dsh 的日志可回放/可审计（CC 其实也落盘）；
                    |                                          |                                              |        | 但 dsh UI 只显示「本轮」，跨 turn 的连续感差
强制机制            | 描述 + turnsSinceLastTodoWrite +          | **只有描述一句话**，无计数器、无 reminder、   | **CC** | 这是最大的差距。dsh 全靠模型自觉；实测 11%
                    | todo_reminder 注入                       | 无 system prompt section                      |        | 会话用过 todo_write，中位数只有 2 次
schema 严格度        | 宽松（多字段容忍）                        | `additionalProperties: false`，**硬拒**       | **dsh**| 实测 10 次失败里 7 次是模型塞了 id/activeForm
                    |                                          |                                              |        | 之类的多余字段。dsh 让「模型以为写的」=「日志
                    |                                          |                                              |        | 里真有的」，这个不变量值得抄
单一所有者          | owner 字段（可多 agent 共享？）           | **无 owner，单一 agent session 独占**         | dsh    | dsh 明说 "subagent, shared, and swarm scopes are a
                    |                                          |                                              |        | deliberate cut"。没 owner 反而没有「谁改的」
                    |                                          |                                              |        | 歧义；实测也没有因为没 owner 出过问题
是否带验收标准      | 无（只有 subject/description 文本）      | **无**（objective 是自由文本）；ralph 的轮次  | 平/略dsh| dsh 至少在 `<goal_round>` 里写了 "gather
                    |                                          | 报告有 evidence: string[] 但只校验非空         |        | evidence"、`complete` 要求 evidence 非空；
                    |                                          |                                              |        | 但都不是「可验证判据」
权威校验            | 无                                       | **有，且很硬**：create/edit/pause/resume 必须  | **dsh**| 这条最关键：`hasDirectHumanInput` 要求
                    |                                          | 在 root agent 的当前 turn 且有 user 消息；     |        | root + 当前 turn + source==='user' 三条件。
                    |                                          | complete/blocked 只接受人 或 当前 goal round   |        | 实测拦住 2 次子 agent 越权造目标
compare-and-set     | 无（整表覆盖）                           | goal 用 {id, revision} CAS；Team 任务用        | **dsh**| 陈旧视图会拿到明确错误而不是静默覆盖。
                    |                                          | expectedRevision                             |        | 多 agent 场景下这是必需品
自动推进            | 无（模型自己决定下一步）                 | **有**：goal-round-driver 每 idle 塞一条       | dsh    | 但实测只有 10 轮真跑过；且 session 边界即
                    |                                          | <goal_round>，上限 maxGoalRounds（默认 256）   |        | disarm，实际几乎不自动推进
放弃的护栏          | 无                                       | `blocked` 至少跑满 blockedAfterConsecutive-   | **dsh**| 「想放弃？先跑满 3 轮再说」直接把「难度大」
                    |                                          | Rounds（默认 3）轮；并把 concrete condition   |        | 和「真阻塞」分开。CC 完全没有这层
                    |                                          | 写进 blocked_reason                          |        |
多 agent 支持       | 无（清单是会话局部的）                   | goal 明确不跨 agent；Team 任务板（实验）有     | 平     | 两者的「单目标」都不跨 agent。dsh 的 Team 板是
                    |                                          | DAG + CAS + writeScopes 告警                  |        | 另一条路线，但默认不装、且 writeScopes 只是告警
```

---

## 七、对 Overwatch「计划先行」机制的结论

### 7.1 直接回答用户原话

> dsh 似乎也有这样的功能，派出 agent 看看本机的 dsh 中，agent 定目标是怎么定的

**有，但不是靠一份清单。** dsh 的做法是：

1. **模型从人类原话里「推断」一个 objective**（`create_goal`），不澄清、不确认、不要求人签名。
   实测样本：15 个字的需求被改写成 200 字的四交付物目标。
2. **目标一落库就是持久状态**（事件日志里一条 `goal/change` 快照），跨 turn / 跨 resume 都在。
3. **推进靠 driver 每轮往会话里塞一条 `<goal_round>` 用户消息**，轮次有上限，`blocked` 有轮次下限。
4. **完成判定只看「谁有资格说」，不看「说的对不对」**——dsh 在 README 里自己承认没有独立评估器。

### 7.2 抄什么、别抄什么

| 判断 | 具体 |
|---|---|
| **必抄** | ① **权威校验那一层**（`hasDirectHumanInput`：root agent + 当前 turn + `source.kind==='user'` 三条件）。这是把「agent 自己给自己定目标」和「人真的要它做」分开的唯一硬手段，而我们的多 agent 场景更容易被 agent 自己编目标。② **`{id, revision}` compare-and-set**——陈旧视图要拿明确错误，不能静默覆盖。③ **`blocked` 的轮次下限**（先跑满 N 轮才允许判阻塞），把「难」和「真阻塞」分开。④ **`additionalProperties: false` 硬拒**——让「模型以为写的」等于「日志里真有的」；实测这条能抓住模型带 Claude Code 习惯的字段。⑤ **计划与清单分工**（`plan-mode` 的 prompt 明写 "Do not use todo_write to track this planning phase"）。 |
| **可抄但要改** | ⑥ `active/paused/blocked/complete` 四态。但要把 `activation`（armed/disarmed）**持久化**——dsh 把它做成进程本地，导致每次 resume 后目标都静止、实测 6/10 的 goal 创建后一轮都没跑。⑦ `evidence: string[]`（ralph 的做法）方向对，但「非空数组」太弱；我们应该要求 evidence 指向**具体文件:行号 或 命令输出**，并且能机器核验（这正是 Overwatch `verify-claims.mjs` 已经在做的事）。 |
| **别抄** | ⑧ **清单投影在 `turn/start` 置 null**。dsh 这样让 UI 只显示「本轮」，跨 turn 的连续感断了；我们的场景（跨会话监控）反而需要「上次到哪了」长期可见。⑨ **默认 `allowParallelInProgress: true`**。同时多个 in_progress 对观察者不可读。⑩ **默认 `maxGoalRounds: 256`**。实测人类自己设的值是 12–80，默认值大到形同没有上限。⑪ **目标由模型单方面改写不确认**。dsh 的 objective 完全由模型写，人没有 approve 环节（plan mode 有，goal 没有）。我们如果要「计划先行」，应该把 plan mode 的 approve 机制搬到 objective 上。 |

### 7.3 一个可以直接用的对照结论

dsh 把这件事拆成**两个阶段、两套机制、两个审批强度**：

```
探索/设计阶段 → plan mode（exit_plan_mode，人 Approve 才放行，plan 是 markdown，不进模型历史以外的状态）
执行阶段     → todo_write（清单，无审批）+ goal（单目标，模型自造，人可用 /goal 覆盖）
```

**「计划先行的审批」和「执行期的任务追踪」在 dsh 里是分开的两个东西，且只有前者有人工闸门。**
这个切分比 Claude Code 干净（Claude Code 的 TodoWrite 一件事干两份活，导致它既不能当计划也不能当验收依据）。
**如果我们只抄一样，抄这个切分。**

### 7.4 诚实的负面结论（写给自己看）

- **dsh 的目标机制是「存在但基本没人用」的**：1,426 个真实会话里 10 个用过 goal，总轮次 10 轮，
  6/10 的 goal 建完就停在 `active` 且零轮次。**不要因为「dsh 有」就认为「dsh 验证过它好用」。**
- dsh 的三套（todo / goal / plan）之间**几乎没有联动**：goal 不知道 todo 的存在，todo 不知道 goal 的存在，
  plan mode 的 prompt 唯一一次提到 todo 是叫模型**别用**它。**如果我们要做联动，那是一个 dsh 没有的设计，
  不能从 dsh 抄。**
- **「目标 vs 证据」这一层 dsh 是空的**，且它自己把它列在 Known Limitations 里并 defer 了。
  我们要做这一层，dsh 只能提供 `blocked` 轮次下限和 `evidence: string[]` 两个形状，不能提供实现。

---

## 附：证据索引（绝对字节 = 4,779,796 + offset）

| 文件（asar 内路径） | size | offset | 本次引用 |
|---|---|---|---|
| `/dsh/node_modules/@deepseek-ai/dsh-tool-todo/lib/index.js` | 6,602 | 92,806,078 | `:14-24` 状态与描述、`:45-68` 三项校验、`:80-93` todos 投影、`:95-186` 工具定义、`:170-180` append |
| `/dsh/node_modules/@deepseek-ai/dsh-goal/lib/types/index.js` | 27,458 | 76,965,448 | `:51-65` wire schema、`:125-149` 投影单元、`:217` 默认 256、`:227-229` agent/created 即 disarm、`:271-277` 单目标硬拒、`:316-372` 四个 transition、`:399` 陈旧 revision |
| `/dsh/node_modules/@deepseek-ai/dsh-goal/lib/types/fold.js` | 14,295 | 76,951,153 | `:11` PHASES、`:169-215` 状态机校验、`:260-267` create 规则、`:294-303` 轮次准入 |
| `/dsh/node_modules/@deepseek-ai/dsh-tool-goal/lib/index.js` | 16,692 | 92,131,920 | `:49-64` hasDirectHumanInput/requireDirectHuman、`:72-79` completionAuthority、`:115` blockedAfter 默认 3、`:123-124` create/get 描述、`:195-198` system prompt、`:265-330` 三个工具、`:360` 轮次下限 |
| `/dsh/node_modules/@deepseek-ai/dsh-goal-round-driver/lib/index.js` | 14,355 | 76,738,446 | `:11-19` `<goal_round>` 全文、`:80-82` drivable、`:130-135` 等子 agent、`:136-141` 轮次上限即 block、`:142-166` 预约+followup |
| `/dsh/node_modules/@deepseek-ai/dsh-plan-mode/lib/index.js` | 15,184 | 79,302,161 | `:231-245` `exit_plan_mode` schema、`:103-127` plan 投影 |
| `/dsh/node_modules/@deepseek-ai/dsh-command-goal/lib/index.js` | 7,224 | 44,673,405 | `:127-143` `/goal` 语法与拒绝文案 |
| `/dsh/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/types/task-board.js` | 12,036 | 46,583,276 | `:42-51` task 快照、`:97-118` claim/CAS |
| `/dsh/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/types/task-view.js` | — | — | `:18-20` taskReady、`:36-43` writeScope 告警 |
| `/dsh/node_modules/@deepseek-ai/dsh-tool-ralph/lib/index.js` | 17,330 | 92,371,576 | `:40-46` report schema（含 evidence）、`:71-88` 三态校验 |
| `/dsh/node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js` | 33,853 | 92,694,808 | `:384-420` subagent/subagent_fork 参数 |
| `/dsh/node_modules/@deepseek-ai/dsh-repeat-tool-reminder/lib/index.js` | 93,257 | 85,831,050 | 全包：**无任何 todo 相关逻辑**，只有同参数重复调用的提醒 |
| `/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` | 20,932 | 17,725,927 | `:323-346` goal/driver/command-goal/plan-mode 装配 + plan 指令、`:437-452` tool-todo / tool-goal / repeat-tool-reminder |

真实会话证据（读 `request/header` 与 `system/message`，非 README）：
- 模型实收 `todo_write` / `create_goal` / `update_goal` / `get_goal` / `subagent` / `subagent_fork` / `workflow` /
  `team_task_*` 的 schema：来自 `--D-dsh-dsh~0020plugin-dsh-tally--/session-0bbe30e8-…`（36 个工具）与
  `--D-Projects-Thunder--/session-0c71f3ff-…`（37 个工具）的 `request/header` 事件。
- `tool:goal` 的 system prompt 段（含 blockedAfter=3 插值）：同会话 `system/message` 第 33 段（全文 7,913 字符）。
- `<goal_round>` 逐字文本：同会话 seq 4606（inbox）与 4610（`user/message`，`source.kind='goal'`）。
- 全量统计脚本口径：`~/.dsh/sessions/**/session.v4.jsonl.zstd`，1,426 个文件，Node `zlib.zstdDecompressSync` 解压后
  逐行 `JSON.parse`，按 `type === 'tool/call' | 'tool/result' | 'todo/write' | 'goal/change' | 'user/message'` 聚合。
