# 计划先行（Plan-first）：Claude Code 的 checklist 到底是什么，以及它该不该进我们的产品

- 日期：2026-11-13
- 作者：研究 Agent PL1
- 产出形态：**exploration**（机制调研 + 实现方案，零行代码）
- 用户诉求（原话）：「我希望 AI 的每轮对话最开始都可以像这种列一个 plan，让用户安心知道具体流程」
- **未修改 Overwatch 任何代码，未碰 git，未运行 `claude.exe`。**

## 逆向对象与可复现锚点

| 对象 | 位置（脱敏） | 大小 | SHA-256 |
|---|---|---|---|
| Claude Code CLI | `<LOCALAPPDATA>/Claude-3p/claude-code/2.1.308/c17a819afb40/claude.exe` | 297,376,928 B | `c9796ba22a9221586b36371b36f5b66198d66eb4badf6a4cf4a5f7b07becea53` |
| Claude 桌面版 | `<Program Files>/WindowsApps/AnthropicPBC.Claude_3.6556.2.0_x64__<hash>/app/resources/app.asar` | 52,738,879 B | 未算（只读抽样） |

方法：Node 以 `latin1` / `utf8` 整文件读入，`indexOf` 定位，按字节偏移切片打印。asar 按
`16 + headerSize` 计算数据区基址（`169320 + 16`），再按 header JSON 里的 `offset` 解出单个文件。
**没有反汇编，没有运行目标进程。** 文中每个结论附字节偏移；换版本即失效。

下文偏移均指**该文件内绝对字节偏移**（asar 内文件另行标注「asar 内偏移」）。

---

## 一、结论先行

**1. 那个 checklist 不叫 plan，它叫 `TodoWrite`，而且它和「plan mode」是两套完全不同的东西。**

| | `TodoWrite` / `todo_reminder` | `EnterPlanMode` / `ExitPlanMode` |
|---|---|---|
| 是什么 | 一个**工具**，模型每次调用提交完整待办数组 | 一个**模式**，先只读探索，再把计划写进文件、要用户批准 |
| 产物 | 内存里的状态（`appState.todos[agentId]`） | 磁盘上的 plan 文件（或 web 端的字符串） |
| 谁决定内容 | 模型自己 | 模型自己 + 用户可编辑 |
| 用户能不能改 | 不能（只能看） | 能（批准 / 驳回 / 直接编辑 plan 文件） |
| 生命周期 | 全部 `completed` 时**自动清空**（@263210673） | 跨会话可复用（Devin 到 `~/.devin/plans/`；Claude Code 存 plan 文件） |
| 出现频率 | 每轮都可能 | 用户显式进入，或模型判定任务非平凡时请求进入 |

用户截图里那五行 `○` 是**前者这一族**（具体是 Task 族，也可能仍是 TodoWrite——两族渲染进同一张表，
从截图上无法区分，见 §2.2）。但 Anthropic 自己在 plan 批准后写的是
「**Start with updating your todo list if applicable**」（@130157699）——**plan 是 todo 的上游**。
这两层被我们混为一谈，是本文要拆开的第一个问题。

**2. `TodoWrite` 在 2.1.308 里已经默认关闭，被 `TaskCreate` / `TaskUpdate` 取代了。**
`isEnabled(){return !KO() && Fq()}`（@263210421）；`KO()` 是
`CLAUDE_CODE_ENABLE_TASKS !== false`（@253916167），**默认返回 true**，所以 `!KO()` 为假，
TodoWrite 不注册。替代族（`TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` / `TaskStop`）
用 `uae() = KO() && Fq()` 启用——**两个门禁互为反相**，一次开关只可能启一族。

两族的**提醒**也互为反相，这是最容易抄错的一处：

| | 提醒函数 | 首行门禁 | 计数器 |
|---|---|---|---|
| TodoWrite | `W$r`（@257906520） | 提醒 `todo_reminder` 时 `if(KO()\|\|!Fq())return[]`（@259480285） | `turnsSinceLastTodoWrite` |
| Task 族 | `z$r`（@257907383） | 提醒 `task_reminder` 时 `if(!KO())return[]`（@257907383） | `turnsSinceLastTaskManagement` |

两者的**阈值常量完全相同**（同一个 `sxe`，@257844987），文案也几乎逐字相同
（@259480412 vs @259481031，只把 `TodoWrite` 换成 `${TaskCreate}`/`${TaskUpdate}`）。
**唯一区别是启用方向。** 所以更准确的说法是：**这不是一次功能重构，是一次同一机制的
A/B 切换**——`KO()` 就是那根开关。

桌面版显式注入 `CLAUDE_CODE_ENABLE_TASKS:"true"`（asar `index.chunk-BGSuBN9K.js`），
按上式推出**桌面版走 Task 族，不走 TodoWrite**。但这与用户截图里那个 `○` 清单并不矛盾：
两族渲染进同一张表——TUI 把两路状态合并成一个工作项数组
`[...uve(运行中的), ...mve(TodoWrite 形态), ...pve(Task 形态)]`（@281124867；`mve` 定义于 @281123987，`pve` 于 @281124245）。
所以：**机制换过名字，用户看到的形态没变。** 抄的时候要抄「形态 + 提醒机制」，不要抄「工具名」。

**3. 它的 schema 只有三个字段，但有一条不写在 schema 里、只写在 prompt 里的硬约束：「整个数组替换」+「恰好一个 in_progress」。**

```js
// @256150964 / @256151020 / @256151146 / @263209917
const TodoStatus = z.enum(["pending", "in_progress", "completed"]);
const Todo = z.object({
  content:    z.string().min(1, "Content cannot be empty"),   // 祈使式，如 "Run tests"
  status:     TodoStatus,
  activeForm: z.string().min(1, "Active form cannot be empty"), // 进行式，如 "Running tests"
});
const TodoWriteInput  = z.object({ todos: z.array(Todo) });     // ← 无 id，无 parent，无 ac
const TodoWriteOutput = z.object({ oldTodos: z.array(Todo), newTodos: z.array(Todo) });
```

`activeForm` 是这套设计里唯一真正聪明的一处：**同一件事存两份文案**，进行中显示进行式、
否则显示祈使式。截图里 `○ 查看 C 盘当前容量与剩余` 是 `content`，跑起来会变成
`查看 C 盘当前容量与剩余中` 之类（中文没有形态变化，这个设计在中文里收益接近于零——见 §5.4）。

**没有 `id`、没有 `parent_id`、没有依赖、没有验收条件、没有工时。** 它是一张**给用户看的
进度条**，不是一张**可校验的任务图**。这一点非常关键：我们已有的 `task-graph.json`
比它严格一个量级，**不要退化去抄它的 schema**。

**4. 「安心」是真的，但它买自「短 + 稳 + 机器产生」，不是买自「用户审过」。**
CHI'25 的 plan-then-execute 实测（N=248，6 个日常任务，4 组对照）给出的是**反面证词**：
用户对计划的介入**没有**校准信任（H1 / H3 未获支持），介入**增加了** NASA-TLX 的
Mental Demand / Temporal Demand / Frustration，而且**「全自动」两组的信心最高**——
一旦让用户参与规划，对规划阶段的信心**显著下降**。同时有用户原话抱怨
「far, far too detailed in an unnecessary way… as long as the job gets done」。
**结论：列计划的收益来自「用户知道机器在按什么顺序干活」这件事本身；一旦升级成
「请用户审阅并批准计划」，收益反转成成本。** 这直接决定 §5 的默认值。

**5. 它和我们「问问题」不是同一维度的东西，不该合并成一个流程，该串成一条流水线。**

```
问问题  →  对齐「要做什么」（需求）   ← 已经写进 docs/spec/2026-11-11-question-protocol.md
列计划  →  对齐「打算怎么做」（路径） ← 本文
验收    →  判定「做没做到」（结论）   ← 已经写进 templates/acceptance-criteria.md
```

三者是**同一条流水线上的三道闸**，共用一份 JSON。合并会得到一个巨大的、既不可校验
也不可渲染的怪物；串联则可以让**计划的每一项就是一条验收标准**——这是本文最想推的一条
（§4.3）。Claude Code 做不到这一点，因为它的 `todo` 里根本没有 `ac` 字段。

---

## 二、Claude Code 的 TodoWrite 机制（附证据）

### 2.1 完整 schema 与语义

| 字段 | 类型 | 约束 | 出处 |
|---|---|---|---|
| `todos` | `Todo[]` | 整个数组，**每次全量替换** | @263209917 |
| `todos[].content` | `string` | `min(1)`，祈使式（"Run tests"） | @256151020 |
| `todos[].status` | `"pending" \| "in_progress" \| "completed"` | 三值，无 `blocked`、无 `failed`、无 `deleted` | @256150964 |
| `todos[].activeForm` | `string` | `min(1)`，进行式（"Running tests"） | @256151020 |
| 输出 `oldTodos` / `newTodos` | `Todo[]` | 供 UI 做 diff | @263209983 |

**注意 `TaskUpdate` 的状态集不同**：`["pending","in_progress","completed","deleted"]`（@256151635，`xXo`），
并且支持 TodoWrite 没有的字段：`subject` / `description` / `activeForm` / `owner` /
`metadata` / `addBlocks` / `addBlockedBy`（`lXo` 白名单，@256148185）。也就是说
**Task 族才是完整的「任务图」，TodoWrite 是它的只读简化视图**。

### 2.2 触发条件（三道门，缺一不出）

**第一道：工具必须在工具列表里。** `if(!n.options.tools.some(h=>Rt(h,GA)))return[]`（@257906538）。

**第二道：提醒模式不是 `off`。** `KEn()`（@257845041）读
`CLAUDE_CODE_TODO_REMINDER_MODE`，否则读特性开关 `tengu_soft_slate_nudge`（默认 `"baseline"`），
值为 `"off"` 时整条链路关闭。

**第三道：两个计数器同时越过阈值。** 常量 `sxe = {TURNS_SINCE_WRITE: 10, TURNS_BETWEEN_REMINDERS: 10}`
（@257844987）；判定 `if(r>=sxe.TURNS_SINCE_WRITE && s>=sxe.TURNS_BETWEEN_REMINDERS)`（@257906738），
其中 `r = turnsSinceLastTodoWrite`、`s = turnsSinceLastReminder`，由 `U$r()`（@257905913）
从 transcript 反向扫描得出——扫到最近一条 `tool_use.name==="TodoWrite"` 之前有多少个 assistant 轮次。

**这三道门合起来的含义**：**提醒是「模型连续 10 轮没更新待办且 10 轮没被提醒过」才触发的兜底**，
不是每轮都说。所以截图上「每轮都有」的观感来自**模型自己主动调用**，不来自提醒。

**另需注意的第 0 道门**：`W$r` 的第一句是 `if(!n.options.tools.some(h=>Rt(h,GA)))return[]`——
**只要 TodoWrite 不在工具列表里，提醒永不触发**。而 §一.2 已证明 2.1.308 默认 `!KO()` 为假、
TodoWrite 不注册，所以**在默认 CLI 上这条提醒链路整条是死的**；活着的是结构完全对称的
`task_reminder`（@257907383，门禁 `if(!KO())return[]`）。

### 2.3 提醒长什么样（模型侧）

```
The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit
from tracking progress, consider using the TodoWrite tool to track progress. Also consider
cleaning up the todo list if has become stale and no longer matches what you are working on.
This is just a gentle reminder - ignore if not applicable.

Here are the existing contents of your todo list:

[1. [in_progress] 查看 C 盘当前容量与剩余
2. [pending] 重新统计顶层目录占用
...]
```

出处：`case"todo_reminder"` 分支，@259480285 起（渲染文本 @259480412 / @132425688）。
渲染进 `isMeta: true` 的 attachment，**用户看不到这段**，只有模型看到。

### 2.4 更新方式：全量替换 + 全完成即清空

```js
// @263210673
create(e){return{async call({todos:r}){
  let n = e.agentId ?? K();
  let s = e.todos.get(n) ?? [];
  let p = r.every(y => y.status === "completed");   // ← 全部完成？
  return e.todos.set(n, p ? [] : r),                 // ← 是：清空；否：整表替换
         { data: { oldTodos: s, newTodos: r } };
}}}
```

**全部完成时列表被丢弃**。对终端用户是优点（不留垃圾）；对**我们**是硬伤——我们的产品定位是
「跨会话事后审计」，丢弃等于销毁证据。§5 的实现建议里必须反过来。

工具返回给模型的话术是固定一句：
「Todos have been modified successfully. Ensure that you continue to use the todo list to track
your progress. Please proceed with the current tasks if applicable」（@263210819）。

### 2.5 prompt 里的硬约束（不在 schema 里，但会改变模型行为）

长版描述 `_s`（@263200517 / @128385508）：

- 「**Task States**：pending / in_progress（limit to ONE task at a time）/ completed」
- 「Mark tasks complete **IMMEDIATELY** after finishing (don't batch completions)」
- 「**Exactly ONE** task must be in_progress at any time (not less, not more)」
- 「Remove tasks that are no longer relevant from the list entirely」
- 「Never mark a task as completed if: Tests are failing / Implementation is partial / You
  encountered unresolved errors / You couldn't find necessary files or dependencies」
- 「**When in doubt, use this tool.**」

短版描述 `Io`（@263209642）：

> Update the todo list for the current session. To be used proactively and often to track progress
> and pending tasks. **Make sure that at least one task is in_progress at all times.**

**这两句互相矛盾**：「恰好一个」vs「至少一个」。同一份产物里两条互斥约束，
说明这两段字符串是不同时期、不同人写的。我们抄的时候**只能留一条**，并且要能机械校验。

触发阈值写在 prompt 里而不是 schema 里：「Complex multi-step tasks - When a task requires
**3 or more** distinct steps」（@263200927）。**3 是阈值，也是显示预算**（见 §2.6）。

### 2.6 渲染：CLI 用方块，桌面版用圆圈

**CLI（`In` 组件，@279944708）**：

```js
var Rn = 3, _n = 100, Cl = 12, Tl = 6;   // @279944609
function Rcr(i){                          // @272591888
  switch(i){
    case "completed":   return { icon: te.tick,             color: "success" };  // ✔ U+2714
    case "in_progress": return { icon: te.squareSmallFilled, color: "claude" };  // ◼ U+25FC
    case "pending":     return { icon: te.squareSmall };                         // ◻ U+25FB
  }
}
```

glyph 表在 @253711435（`tick:"\u2714"`）与 @253711516（`squareSmallFilled:"\u25FC"`）。
表头是 `Tasks · N/M done`；**`Rn=3` 表示不展开时只画 3 行**，其余折叠成
`… +x in progress, y pending, z completed`；展开上限 `_n=100`。

**桌面版（`○` 的来源）**：桌面主窗口的 HTML 第一行就写着
「this is the html for app title bar and error UI. **everything else gets loaded from claude.ai**」
（asar `/.vite/renderer/main_window/index.html`）。**桌面版是 Electron 壳 + 远端 web UI**，
所以那个圆圈勾选、`Run 2 commands ›`、`33s · 1.4k tokens` 都是 claude.ai 前端渲染的，
**不在本地可执行文件里**——这就是我在 asar 全量扫描里一个 `○`/`✔`/`◼` 都没找到的原因
（扫描 629 个条目、全部 `.js|.mjs|.css|.html`，命中 0）。

桌面版能渲染的前提在**系统提示词**里，见 §2.7。

### 2.7 最关键的发现：桌面版系统提示词**强制**模型用 checklist，理由写得很直白

asar 内 `/.vite/build/index.chunk-B7K6kkCQ.js`（本地偏移 2,517,344 起）：

```text
<todo_list_tool>
The Claude desktop app includes a task list for tracking progress.

**DEFAULT BEHAVIOR:** Claude MUST use the task list tool for virtually ALL tasks that involve
tool calls.

Claude should use the tool more liberally than the advice in the tool's own description would
imply. This is because the task list is nicely rendered as a widget to users in the desktop app.

**ONLY skip the task list if:**
- Pure conversation with no tool use (e.g., answering "what is the capital of France?")
- User explicitly asks Claude not to use it

**Suggested ordering with other tools:**
- Review Skills / AskUserQuestion (if clarification needed) → create task list → actual work

<verification_step>
Claude should include a final verification step in the task list for virtually any non-trivial
task. This could involve fact-checking, verifying math programmatically, assessing sources,
considering counterarguments, unit testing, taking and viewing screenshots, generating and
reading file diffs, double-checking claims, etc.
</verification_step>
</todo_list_tool>
```

三件事值得抄，一件要警惕：

1. **抄**：`AskUserQuestion（若有澄清）→ 建 task list → 开工`。这正是 §4 要的形式化，
   Anthropic 已经在生产环境这么排了。
2. **抄**：`verification_step` —— **把「验收」写进待办的最后一项**。Claude Code 用 prompt
   保证它出现；我们要用 schema 保证它出现（§4.3）。
3. **抄**：桌面版**明说**「比工具描述建议的更频繁地用」，理由是「用户看得见」。
   这是把 **UI 呈现价值**作为提高调用频率的正当理由——直接回答了用户那句「让用户安心」。
4. **警惕**：`MUST ... for virtually ALL tasks` 在桌面端是**硬性强制**。我们的产品没有
   远端灰度能力，一条 prompt 改错就是全体用户改错；而且 §3 的 CHI'25 数据显示强制参与
   会带来认知负荷。**我们要的是「条件性展示」而不是「无条件展示」。**

同时注意同一份提示词里 `<ask_user_question_tool>` 的写法（本地偏移 2,515,790）：
「Claude should always use this tool **before starting any real work**」——提问在前，
计划在后，Anthropic 的顺序与 §4 一致。

### 2.8 plan mode：和 todo 是两件事，但 plan 批准后会**要求**建 todo

`ExitPlanMode` 的判定与话术（@130153072）：

- 「Use this tool when you are in plan mode and have finished **writing your plan to the plan file**
  and are ready for user approval.」
- 「This tool does **NOT** take the plan content as a parameter - it will read the plan from the
  file you wrote」（CLI 版）；web 版改为「Pass the whole plan as `plan`, in Markdown.
  This session has no plan file」
- 「**Do NOT use AskUserQuestion to ask "Is this plan okay?"** … that's exactly what THIS tool does.」
- 用户批准后注入：「User has approved your plan. You can now start coding. **Start with updating
  your todo list if applicable.**」（@130157699）

plan mode 的硬约束（@131947648）：

> Plan mode is active. The user indicated that they do not want you to execute yet -- you **MUST NOT**
> make any edits, run any non-readonly tools … This supercedes any other instructions …
> **this is the only file you are allowed to edit**.

**四条可直接借用的设计决策**：
1. **计划是一个文件，不是一个参数**（在能给文件的时候）。文件可编辑、可 diff、可跨会话复用。
2. **「批准计划」是一个独立动作，不是一次提问**。Anthropic 明确禁止用提问工具代劳。
3. **计划批准 → 生成待办**，单向。不反向从待办推计划（推不出来，待办没有理由）。
4. **计划阶段物理只读**。不是 prompt 里「请不要改」，是工具集限制——与我们 `dispatch-contract.md`
   §3 的「不靠 prompt 里写请不要读，靠不提供路径」是同一种思路。

---

## 三、其他产品怎么做

### 3.1 横向对照

| 产品 | 有没有「先给计划」 | 有没有「待办清单」 | 粒度 | 何时不列 |
|---|---|---|---|---|
| **Claude Code（CLI 2.1.308）** | 有，`EnterPlanMode`（需用户同意进入，写 plan 文件，`ExitPlanMode` 批准） | 有，`TodoWrite`/`Task*`，阈值「3 步以上」 | 3–5 项（示例 5 项；显示折叠在 3 行） | 「单步、琐碎、纯对话」 |
| **Claude 桌面版** | 同上（共享 CLI 内核） | 同上，但系统提示词**强制**「virtually ALL tasks」 | 同上 | 仅纯对话或用户明说不 |
| **Cursor** | 有，Plan Mode（`Shift+Tab`）：「asks clarifying questions → researches codebase → creates a comprehensive implementation plan → you review and edit → click to build」 | **官方 Agent 文档里没有 todo 清单**（llms.txt 全量索引只有 `agent/plan-mode.md` 与 help 页，无 todo 条目） | 无公开粒度 | 「quick changes or tasks you've done many times before」 |
| **Devin（Cognition）** | 有，Plan mode：「Explore your codebase」「**Ask clarifying questions** to ensure the plan aligns with your goals」「Provide multiple options … with an interactive interface」「Present a detailed plan, **written in an external Markdown file**」 | **有**，但归属于 Cascade 时代：「Plans and Todo Lists … a **specialized planning agent** continuously refines the long-term plan while your selected model focuses on short-term actions」 | 无公开粒度 | 其它 4 个模式（Code / Smart / Ask / Bypass） |
| **Windsurf（现 Devin Desktop，Cascade legacy）** | 同上（已并入 Devin） | 同上，且**规划与执行由两个不同模型分工** | 无公开粒度 | — |

出处：
- Cursor `https://cursor.com/docs/agent/plan-mode.md`、`https://cursor.com/help/ai-features/plan-mode.md`
- Devin `https://docs.devin.ai/desktop/devin-local/modes.md`、`https://docs.devin.ai/work-with-devin/ask-devin.md`
- Windsurf/Devin `https://docs.windsurf.com/windsurf/cascade/cascade.md`（"Plans and Todo Lists" 节）

### 3.2 三个可分辨的架构，别混着抄

| 架构 | 代表 | 规划者 | 计划的存放 | 优点 | 缺点 |
|---|---|---|---|---|---|
| **A. 单 Agent 自报** | Claude Code `TodoWrite` | 执行者自己 | 内存状态 | 零额外成本，随时改 | 自证，不可审计；全完成即丢弃 |
| **B. 模式闸门** | Claude Code `plan mode`、Cursor Plan Mode | 执行者自己，但**物理只读** | 磁盘文件 | 计划可编辑、可复用、批准即授权 | 一次只服务一个任务；用户要读长文 |
| **C. 双模型分工** | Windsurf Cascade | **独立规划 Agent** | 会话内 TODO | 规划不被执行细节污染 | 两份心智模型要同步；贵 |

**我们该抄 B 的「闸门」+ C 的「独立规划者」+ A 的「轻量形态」，但把 A 的自证环节换成机器判定。**
理由：Overwatch 的存在理由就是「AI 说它做完了」不可信（README 第一节）。抄 A 的自报 `status` 等于
把我们已经证明不可信的东西重新引入产品。

### 3.3 反面证据（必须进设计约束，不许略过）

| 证据 | 具体数字 / 原话 | 对我们的约束 |
|---|---|---|
| **CHI'25 plan-then-execute**（He, Demartini, Gadiraju，N=248，6 任务，2×2 四组） | ① 「user involvement in the planning and execution **does not significantly impact** user trust and calibrated trust」；H1/H3 **未获支持**。② NASA-TLX：规划介入显著影响 **Mental Demand / Temporal Demand / Frustration**；执行介入影响 Performance / Effort；「involvement in **both** planning and execution posed a **higher cognitive load**」。③ 信心：**AP-AE（全自动）在规划与执行两阶段信心都最高**；一旦用户参与规划，「significantly **lower** confidence in planning」。④ 计划质量 → 执行准确率：低质 1–8%、误导性 59%、高质 66±7%；**717 个「高质量计划」任务里仍有 235 个执行错误**。⑤ 用户原话：「it's far, far **too detailed** in an unnecessary way… as long as the job gets done」。⑥ 「Once the efforts to control/interact with LLM agents are **greater than the efforts to execute the tasks themselves**, users will be unwilling to adopt such assistance.」 | 计划**默认不要求用户批准**；条目数有上限；计划质量与执行质量要分开归因（计划对 ≠ 做得对） |
| **「Learning When to Plan」**（arXiv:2509.03581v3，Paglieri 等） | 「existing methods like ReAct prompt LLMs to explicitly plan **before every action**; however, we demonstrate that **always planning is computationally expensive and degrades performance on long-horizon tasks**, while **never planning further limits performance**」；且「these agents can be effectively **steered by human-written plans, surpassing their independent capabilities**」 | 计划要**选择性**生成，不是每轮；但**人写的计划确实能提升上限** → 支持「用户可编辑计划」而不是「只读展示」 |
| **「To Trust or to Think」**（Buçinca et al., CSCW 2021，N=199） | 认知强制（cognitive forcing）能降低过度依赖，**但**「people assigned the **least favorable subjective ratings** to the designs that reduced the overreliance the most」 | 「让人停下来看」的手段**必然被讨厌**。要么不做，要么只在高风险时做，并明说为什么 |
| **CHI'25 的「convincingly wrong」** | 计划「at first glance … quite plausible and trustworthy」，用户「**do not find any space for improvement**」；作者结论「plausible but wrong LLM outcomes can be **detrimental** to user trust calibration」 | 计划**不能设计成「看起来对就行」**。必须每项自带可观测的反驳条件 |

**把上面四条压成一句设计约束**：
> 计划的**展示**是净收益；计划的**审阅**是净成本，只在风险够高时才值得。
> 因此默认「展示不确认」，把「确认」留给 `risk ≥ 1` 或 `shape === artifact`。

---

## 四、与「问问题」的整合方案

### 4.1 先回答「能不能合并」

**不能合并成同一个对象，但必须串成同一条流水线，并共用一份 JSON。**

理由三条：

1. **语义不同构**。问题问的是「你要 A 还是 B」，计划说的是「我打算先做 1 再做 2」。
   一个是**决策点**，一个是**路径**。`question-protocol.md` §1.2 的 `Question` 有
   `risk` / `options[].reversible` / `excludes`，而计划条目需要的是 `ac_id` / `depends_on` /
   `est`。字段集交集很小，硬合并会得到一个 40 字段的联合体，校验器写不出来。
2. **时机不同**。`question-protocol.md` §2 已经把提问时机参数化为 `upfront` / `gated` / `deferred`。
   计划只在「问题已答」之后有意义——**没有答案的计划是猜测的伪装**。把两者合并会诱使模型
   在问题未答时先出计划，然后用计划倒推出「我猜的答案」，这恰好破坏 §5.1 的「必须问」强制机制。
3. **失败模式不同**。问题该问没问 → 需求错（`question-protocol.md` §5.2 已定义缺陷）。
   计划该列没列 → 只是不好看，**不影响正确性**。把两个失败模式塞进一个对象，
   校验器要么把「没列计划」判成硬失败（过严，会逼出垃圾计划），要么把「没问问题」降级（危险）。

**必须共用一份 JSON 的原因**：计划的每一项应当**就是**一条验收标准。见 §4.3。

### 4.2 流水线（可直接画成图）

```
                        ┌──────────────────────────────────────────┐
                        │  QuestionPack（已有规格，不新增）          │
   用户一句话 ─────────▶ │  ≤5 问 · risk 0–3 · coverage 算术不变量   │
                        └───────────────┬──────────────────────────┘
                                        │ state === 'answered'
                                        ▼
                        ┌──────────────────────────────────────────┐
                        │  Plan（本文新增）                         │
                        │  plan.items[] ≤ 5 · 每项带 ac_id + fail_if│
                        │  generated_from: {pack_id, answers[]}     │
                        └───────────────┬──────────────────────────┘
                                        │
                    ┌───────────────────┴───────────────────┐
        risk ≥ 1 或 shape === artifact          其它全部情况
                    │                                       │
                    ▼                                       │
        ┌───────────────────────┐                           │
        │  PlanGate（一次）      │                           │
        │  批准 / 编辑 / 驳回    │                           │
        │  超时 → 按 policy       │                           │
        └───────────┬───────────┘                           │
                    └───────────────────┬───────────────────┘
                                        ▼
                        ┌──────────────────────────────────────────┐
                        │  Todo / TaskGraph（已有 task-graph.json）  │
                        │  一项 = 一个 subtree，带 acceptance[]      │
                        └───────────────┬──────────────────────────┘
                                        ▼
                        ┌──────────────────────────────────────────┐
                        │  Acceptor（已有角色，一票否决）            │
                        │  逐项判 AC → 回写 item.status             │
                        └──────────────────────────────────────────┘

     渲染层：任何时刻只展示「当前 + 接下来 2 项」，其余折叠为 「… +N」。
```

**图上的四个「不变量」**（能机械校验，写进 §5.2 的校验器）：

| 不变量 | 形式 | 防止什么 |
|---|---|---|
| **I1 来源闭合** | `plan.generated_from.pack_id` 必须指向一个 `state ∈ {answered, partially_answered}` 的包 | 计划倒推猜测 |
| **I2 项数守恒** | `len(items) + len(folded) === plan.declared_steps` | 静默丢步骤（抄 `Coverage` 的算术不变量） |
| **I3 每项有 AC** | `∀ item: item.ac_id ∈ subtree.acceptance[].id` | 「看起来对就行」 |
| **I4 状态由外定** | `item.status` 只能由 accept 结果回写，不由执行 Agent 自填 | 我们存在的理由（自证不可信） |

### 4.3 关键设计：计划项 = 验收标准（同一份数据，看两次）

这是本文与 Claude Code 最大的分歧点。它的 `todo` 和 `acceptance` 是两套东西；
我们让它们**是同一个数组的两个视图**：

```ts
// 唯一真源。计划页渲染「顺序 + 文案」，验收页渲染「判据 + 否决条件」。
interface PlanItem {
  id: string;                 // "P-<run-id>-<nn>"，稳定，答案/证据靠它回指
  content: string;            // 祈使式，≤ 40 半角 / 20 全角（沿用 output-format §1 第 5 条）
  active_form: string | null; // 进行式；中文可留 null（见 §5.4）
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  // ↑ 与 Claude Code 的差别：多 failed / skipped，且 status 由 Acceptor 写，不由执行者写

  // ↓ 与 acceptance-criteria.md 共用
  ac_id: string;              // 必须能在 subtree.acceptance[] 里找到
  criterion: string;          // 可观测事实
  evidence: string;           // file:line / 命令输出 / 原文引述
  fail_if: string;            // 什么情况直接否决（非空，沿用现有模板）

  depends_on: string[];       // PlanItem.id[]
  est_minutes: number | null; // null = 不知道；不许编（沿用 output-format §2.1 的同一条纪律）
  source: 'question' | 'constraint' | 'baseline' | 'planner_proposal';
  source_ref: string | null;  // source==='question' 时指向 Q-id；'planner_proposal' 时必须 null 并置 risk
  risk: 0 | 1 | 2 | 3;        // 与 Question.risk 同一套词表
}
```

**收益**（三条，都可观测）：
1. **「计划」不再是额外产出**。写计划 = 写验收标准，模型没有多写一遍的动机去注水。
2. **计划与验收同步漂移**。改了 `criterion` 就是改了验收，不可能「计划说 A、验收判 B」。
3. **`fail_if` 强制每项自带反驳条件**，直接堵住 CHI'25 的「convincingly wrong」——用户看到的
   不是「我打算做 X」，而是「我打算做 X；如果出现 Y，我做错了」。

### 4.4 计划由谁产出

**独立 planner（已有 `oversight-planner`），不是主 agent 顺手写。**

四条理由，前三条是既有约束的直接推论：

| 理由 | 依据 |
|---|---|
| 主线程只做拆解 / 派发 / 汇总 | `CLAUDE.md` 硬约束 1 |
| 执行者写自己的计划 = 自证 | 对应 `dispatch-contract.md` §3「锐评的结论不能由执行 Agent 自己写」的同一条逻辑 |
| 规划需要读 question pack + baseline + 规格，执行者不该有这些上下文 | 上下文隔离，同 `dispatch-contract.md` §3 |
| 双模型分工被证明有效 | Windsurf：「规划 agent 持续精炼长程计划，你选的模型专注短期动作」 |

**但要抄 Claude Code 的一条反例补丁**：planner 产出的计划**必须能被用户直接编辑**
（`ExitPlanMode` 的 `planWasEdited` 字段，@130156808，就是为这个存在的）。
所以 `Plan` 的落地形态是**一个 markdown 文件 + 一份 JSON**：md 给人改，JSON 给机器校验，
改完重新校验（I2/I3 不变）。`question-protocol.md` §7.1「唯一真源是 JSON，散文是渲染结果」
在这里要**反转一半**：人可以改散文，但改完必须重新生成 JSON，否则校验器拒收。

### 4.5 粒度：3 是显示预算，5 是硬上限，不是目标

三个数字都有出处，但含义不同，别混：

| 数字 | 出处 | 含义 | 我们怎么用 |
|---|---|---|---|
| **3** | Claude Code `Rn=3`（@279944609），不展开只画 3 行 | **显示**预算 | 首屏只画 3 行 + `… +N` |
| **3** | 工具描述「3 or more distinct steps」（@263200927） | **触发**阈值 | <3 步不生成 Plan，直接做 |
| **5** | `output-format.md` §1 第 5 条「列表不超过 5 条」；`question-protocol.md` `pack_cap: 5` | **硬上限** | `plan_cap: 5`，超出进 `folded[]` |
| **5** | 用户截图的五行 | 用户心理预期 | 与上一条一致，不需额外规则 |

**用户截图那 5 项，恰好落在硬上限上，不是常态。** 而且截图里第 1 项
（「查看 C 盘当前容量与剩余」）和第 5 项（「对比清理前变化并出报告」）是**不同层级**——
第 5 项是第 1–4 项的汇总。这说明**模型自己列计划时会层级混乱**，需要校验器拦
（§5.2 的 I5）。

---

## 五、我们的实现建议（可派发为任务）

### 5.1 五条默认值（每条都注明为什么是这个值）

| 项 | 默认值 | 为什么 | 可配置 |
|---|---|---|---|
| 是否展示计划 | **是**（`len(items) >= 3` 时） | 展示是净收益（§3.3 第 1、2 条）；<3 步展示是噪音 | 否 |
| 是否要用户确认 | **否**，除非 `risk >= 1` 或 `shape === 'artifact'` | 「审阅是净成本」（§3.3 CHI'25：规划介入未提升信任、提升认知负荷、降低信心） | 是（`plan_policy.require_approval`） |
| 谁写 | `oversight-planner` | `CLAUDE.md` 硬约束 1 + 自证禁令 | 否 |
| 状态谁写 | `oversight-acceptor` | 我们存在的理由：自证不可信 | 否 |
| 完成后是否清空 | **否**，保留并归档到 `tasks/runs/<run-id>/plan.json` | Claude Code 全完成即清空（@263210673），那是「不打扰用户」的取舍；我们要的是可审计 | 否 |

### 5.2 要新建的文件（4 个，全部只读或只写新路径）

| 文件 | 作用 | 关键约束 |
|---|---|---|
| `docs/spec/plan-protocol.md` | 规格：`Plan` / `PlanItem` / `PlanGate` / 五条不变量 I1–I5 | 照 `question-protocol.md` 的结构写；每个默认值标 `[设计选择]` |
| `scripts/validate-plan.mjs` | 校验器 | 五条不变量；I5 见下 |
| `scripts/validate-plan.test.mjs` | 正负测试 | **必须含负向变异**（沿用 `question-protocol.md` §8.3） |
| `templates/plan.md` | 人可编辑的渲染模板 | 与 `templates/acceptance-criteria.md` 字段一一对应 |

**I5（新增，用于拦截图里那种层级混乱）**：
```
∀ item: item.content 不得是其它 item 的并集或汇总。
可机械检测的弱形式：若某个 item 的 content 以「汇总 / 对比 / 出报告 / 总结」开头，
则它必须是最后一个 item（按 depends_on 拓扑序），且其 depends_on 非空。
```
这不是完美判据，但能拦住「第一项查容量、最后一项出总报告」这种最典型的错误层级。

### 5.3 与现有脚本的接口（不新增运行时，符合 ADR-0001）

- `validate-run.mjs` 已经要求 `subtrees[].acceptance` 非空且 `criterion` 不可含 `VAGUE` 匹配
  （`scripts/validate-run.mjs` L88–L110）。**`plan.items[]` 直接复用同一个 `acceptance[]` 数组，
  不新增字段**，所以 `validate-plan.mjs` 只需校验**顺序、数量、拓扑**，不必重写可判定性检查。
- `scan-sessions.mjs` 已经能判 `PRODUCING` / `EXPLORING`，**不引入新的状态**。
  计划是描述，不是判据——与 `README.md`「关于四态」的结论一致。
- TUI（`oversight-tui.mjs`）加一栏，**首屏渲染 3 行 + `… +N`**，抄 `Rn=3`。

### 5.4 三条必须写进规格的「不要抄」

1. **不要抄「全完成即清空」。** @263210673 那行 `e.todos.set(n, p ? [] : r)` 会销毁审计痕迹。
2. **不要抄「恰好一个 in_progress」用于多 Agent。** `CLAUDE.md` 硬约束 2 要求至少 5 个并行
   Agent，全局单一 `in_progress` 会逼着模型串行。**改成 per-subtree 一个 `in_progress`，
   全局视图是折叠。**
3. **不要抄 `activeForm` 到中文为主的产品。** 这个字段的唯一价值是「进行式 ≠ 祈使式」，
   中文没有形态变化（「运行测试」两种语境同形）。**允许 `active_form: null`**，
   校验器不得因此报错——否则会逼出「正在运行测试中」这种病句。

### 5.5 派发建议（5 个 Agent，含三个不可合并角色）

| # | 角色 | 产出 | 预算 |
|---|---|---|---|
| 1 | `oversight-planner` | 写 `docs/spec/plan-protocol.md`（含 I1–I5） | est 15% |
| 2 | `oversight-executor` | 写 `validate-plan.mjs` + `templates/plan.md` | est 20% |
| 3 | `oversight-executor` | 写 `validate-plan.test.mjs`（**必须带负向变异**） | est 15% |
| 4 | `oversight-redteam` | 专攻「计划变成表演」：构造一条**通过全部 I1–I5 但完全无信息**的计划 | est 15% |
| 5 | `oversight-acceptor` | 对照 §5.1 的五个默认值逐条判定，一票否决 | est 10% |

**红队 Agent 的必答问题**（写进 prompt，不许改）：
> 构造一条满足全部不变量、但用户读完仍然不知道机器要做什么的计划。
> 如果你构造不出来，请说明是哪一条不变量挡住了你，以及它是否可被绕过。

（这一条对应 `CLAUDE.md` 硬约束 5「禁止静默共识」：5 个 Agent 都同意时，
至少一个要被要求找反面证据。）

---

## 六、未解决 / 我确实没做到的部分

1. **没验证桌面版渲染路径的字节级证据**。桌面主窗口的 checklist 由 claude.ai 远端渲染，
   **本地没有那份 JS**（asar 全量扫描 glyph 命中 0，Electron 缓存的 `Cache_Data` 只有 2.3 MB，
   无匹配）。所以 §2.6「`○` 来自 web」的结论只有一条间接证据
   （index.html 的注释「everything else gets loaded from claude.ai」），**不是直接证据**。
2. **没能在离线环境核实 `33s · 1.4k tokens` 那行的具体格式串**。CLI 侧存在等价能力
   （`showTurnDuration` 设置，描述为「Show "Cooked for Nm Ns" after each assistant turn」，
   @127429140；token 计数见 `nb()` 返回 `${mr(h)} tokens`，@266255428 一带），
   但桌面版那行的实际拼装代码在远端，**我没读到**。
3. **没跑过任何实验**。CHI'25、arXiv:2509.03581、CSCW'21 的数字全部是「论文自报」，
   我没有复现。§3.3 表格里每个数字都标了出处条目，未做二次计算。
4. **没验证 Cursor 是否有未文档化的 todo 清单**。我只核了 `cursor.com/llms.txt` 全量索引
   与 `agent/plan-mode.md`、help 页；**「文档里没有」不等于「产品里没有」**。
5. **没测中文渲染宽度**。§5.4 第 3 条「`active_form` 可空」是**基于中文无形态变化**的推断，
   没有实测过用户是否更希望看到「正在…」的动感。
6. **版本时效**：所有偏移对 2.1.308 有效；TodoWrite 已在默认路径上关闭，
   下一版可能整段删除。**本文的机制结论有保质期，§5 的设计建议不受影响。**

---

## 覆盖声明

- **实际读了全文的**：
  - `claude.exe` 2.1.308（SHA-256 见文首）：`TodoWrite` schema（@256150964 / @256151020 / @256151146 /
    @263209917 / @263209983）、工具对象与门禁（@263210122 / @263210406 / @263210421 / @263210673）、
    长短两版描述（长版 @263200517 / @128385508，短版 @263200056 / @263209642）、
    `todo_reminder` 三道门与常量（@257844987 / @257845041 / @257906520 / @257906538 / @257906649 /
    @257906738）、提醒渲染文案（@259480285 / @259480412 / @132425688）、
    `task_reminder` 反相门禁与文案（@257907383 / @259481031）、
    `TaskCreate`/`TaskUpdate` schema（@256148185 / @263288608 / @256151635）、
    状态图标与折叠常量（@272591888 / @279944609 / @279944708）、glyph 表（@253711435 / @253711516）、
    `EnterPlanMode` 描述（@129146516）、`ExitPlanMode` 描述与批准话术（@130153072 / @130154172 / @130157699 / @130156808）、plan mode 系统消息（@131947648）、
    门禁函数（@253916167 `KO` / @257767905 `Fq` / @248894541 `Bd` / @245222574 `oQo` /
    @248421673 `Qjt` / @257767485 `pDr`）、TUI 合并两路状态（@281123987 / @281124245 / @281124867）。
  - 桌面版 `app.asar`：header JSON（629 个条目全量解出）、
    `/.vite/build/index.chunk-B7K6kkCQ.js` 的 `<todo_list_tool>` 与 `<ask_user_question_tool>` 全文
    （asar 内 2,515,790 / 2,517,344）、`/.vite/renderer/main_window/index.html` 首行注释、
    `/.vite/build/index.chunk-BGSuBN9K.js` 的 `CLAUDE_CODE_ENABLE_TASKS:"true"` 注入点。
  - 本仓：`CLAUDE.md`、`README.md`、`docs/spec/question-protocol.md`（§0/§1/§2/§7 全文）、
    `docs/spec/dispatch-contract.md`、`docs/spec/evidence-discipline.md`、`docs/spec/output-format.md`、
    `docs/spec/state-model.md` §1–§2、`templates/acceptance-criteria.md`、
    `.claude/skills/oversight/SKILL.md` §0–§0.5、`scripts/validate-run.mjs` L40–L120、
    `scripts/check-structure.mjs` L100–L145 / L1040–L1095、`docs/research/2026-11-11-claude-status-block-reverse.md`、
    `docs/research/2026-11-11-tui-checklist-redesign.md`、`docs/CHANGELOG.md` 头部。
  - 外部：arXiv:2502.01390v1（CHI'25，**下载 PDF 后本地抽流读全文**：Abstract / §4.1–4.4 / §5.1–5.4 /
    Table 3/7/8/9 / §6.1 / §6.3）、arXiv:2509.03581v3（摘要全文）、
    「To Trust or to Think」（arXiv 摘要全文）、Cursor `agent/plan-mode.md` + help 页、
    Devin `devin-local/modes.md` + `work-with-devin/ask-devin.md` + `cli/*` llms 索引、
    Windsurf `cascade/cascade.md`（Plans and Todo Lists 节）。
- **做了哪些检查**：asar 629 条目全量按 `todo` / `Todo` / `TODO` / `○` / `◼` / `✔` 扫描；
  asar 全量按 `.js|.mjs` 扫 `todoToolsOptIn` / `CLAUDE_CODE_ENABLE_TASKS` / `ENABLE_TODO_TOOLS` /
  `todoFeatureEnabled`；`grep -abo` 逐条 pin 偏移；`sha256sum` 算可执行文件摘要。
- **没做什么**：没运行 `claude.exe`；没反汇编；没跑 `node --test` 或 `check-structure.mjs`
  （未改任何代码，新增文档不影响门禁结论）；没碰 git；没测中文渲染宽度；
  没复现任何论文实验；**没读到** Cursor 是否存在未文档化 todo 组件。
- **无法核实的**：桌面版 `○` 的实际渲染代码（在 claude.ai 远端，本地无副本）；
  `33s · 1.4k tokens` 的格式串；**用户截图那一族到底是 TodoWrite 还是 Task 族**——
  两族渲进同一张表、glyph 同一套，本地证据无法区分（只能确定桌面版注入了
  `CLAUDE_CODE_ENABLE_TASKS:"true"`，按门禁反相推出应是 Task 族，但**没有看到 host
  launch options 里 `todoToolsOptIn` 的实际取值**）。
