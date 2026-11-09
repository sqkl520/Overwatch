# DeepSeek dsh-superagent-prototype 架构分析：它是什么、哪些能抄、哪些抄不了

- 日期：2026-11-04（现场克隆核对于 2026-11-09）
- 对象：`https://github.com/deepseek-ai/dsh-superagent-prototype`（下称 dsh-superagent）
- 方法：`git clone --depth 1` 到 `.tmp-analysis/dsh-ref`（已 gitignore），读完全部 `docs/`（9 篇 1973 行）、
  全部 `prompts/`（438 行）、`src/` 核心模块（111 文件 15205 行）、`cordis.patch.yml`、`tests/model-surface.spec.ts`、
  `tests/cards.spec.ts`、`tests/docs.spec.ts`。**未修改 Overwatch 任何代码，未碰 git。**
- 产出形态：exploration（架构分析笔记，非实施计划）

---

## 零、结论先行

| 问题 | 结论 |
|---|---|
| 它到底是什么 | 一个**常驻的 GitHub/Feishu 客服-工程师**：监听仓库事件 → 一个"路由 Session"判断该不该接活 → 接了就开一个**自己创建的**独立 Session 去干 → 干完回到原始对话里回复。不是一个"多 Agent 框架"，是一个**单仓库的单 agent 值班程序**。 |
| 用户说「目标一致」对不对 | **对了一半，而且是最关键的那一半**：主 agent 只做「接单/派单/转达」，不碰实现细节；子 agent 拿原始上下文而不是转述。但**它成立的前提 Overwatch 没有**——所有 worker Session 是它 `create` 出来的，所以它能 steer/inject/cancel、能限制工具、能在工单结束时收回权限。 |
| 最值得抄的三样 | ① **事件身份去重 + 等待行合并写**（不是拿谓词值当身份）；② **卡片 + `read` 指针的有界上下文协议**（160 字预览，全文按需分页）；③ **出站消息的 `purpose` 闸门**（ack/answer/result/attention 四选一，各自的放行条件写在代码里）。 |
| 抄不了的 | 全部**生命周期特权**：创建 Session、注册/限制/守卫工具、注入 system prompt section、`danger-full-access` 权限预设、worker slot 并发控制、结束工单后收回工具。Overwatch 观察的是**用户已有的**会话，这些事一件也做不到（已由 ADR-0001/0002 实测确认）。 |
| 和用户设想「Overwatch 带领各 harness 中的 agent」的差别 | 它带的是**自己的**手下；用户想带的是**别人的**手下。前者是调度问题，后者是权限问题。dsh 的调度层可以整段搬，执行层一行搬不了。 |
| 成熟度 | 原型。`git log` **只有 1 个提交**（"feat: add the dsh-superagent research prototype"），0 release，`has_issues: false`（issue/PR 全关），README 第一段自述 "Research prototype for reference only… not identical to our internal version"。21.5k star / 2.5k fork 是发布 9 天内的热度，不是工程质量信号。 |

---

## 一、它到底是什么

### 1.1 一句话

**单仓库的值班 agent**：GitHub（可选 Feishu）上有人 @ 它 → 判断这活该不该接 → 接了就在一个**独立 Session + 独立 worktree** 里做 → 做完回原对话贴 PR 链接。

`package.json` 的 description 原文：

> A proactive agent for one GitHub repository, as a DSH (DeepSeek Harness) bundle: it listens to GitHub and, optionally, Feishu, evaluates requests under a Policy, turns authorized ones into Tickets, and executes each in its own DSH Session.

### 1.2 解决什么问题、给谁用

解决的问题**不是**"多 Agent 协作"，是**"怎么让一个 agent 替一个团队值班而不把团队的注意力烧光"**。
`docs/000-philosophy.md:5` 把整个项目的判据压成一句：

> **Take as little human attention as possible, and give as much value as possible.**
> Every part of the project is judged by the attention it costs. A message, a notification, a question, a setting, a panel element and a paragraph of documentation each cost someone's attention, and each has to give more value than that, or it is removed.

用户是**一个小团队**（一个仓库），不是个人开发者，也不是"想编排一堆 agent 的人"。

### 1.3 规模、语言、依赖、成熟度（实测）

| 项 | 值 | 来源 |
|---|---|---|
| 语言 | TypeScript（ESM，`.ts` 直接跑，tsdown 打包） | `package.json` |
| 源码 | 111 文件 / 15205 行（含 6 个 `.tsx` 前端面板文件） | `find src -type f` + `wc -l` |
| 测试 | 59 个 spec 文件 + `tests/fixtures/` / 14960 行（≈1:1 测试比） | `find tests` |
| 规格文档 | 9 篇编号文档 1973 行 + prompts 438 行 | `wc -l` |
| 运行时依赖 | **只有两个**：`proper-lockfile`、`zod` | `package.json` dependencies |
| 宿主依赖 | 21 个 `@deepseek-ai/dsh-*` + `cordis` 的 **alpha** 版本（`0.2.1-alpha.2` / `4.0.5-alpha.1`） | peerDependencies |
| 提交历史 | **1 个提交**，2026-10-31，"DeepSeek Harness Team" | `git log` |
| Release / Issue | 0 release；`has_issues: false`，`has_pull_requests: false` | `gh api repos/...` |
| 状态目录 | 一个 SQLite（`orchestrator.sqlite`，schema 11）+ 目录锁 | `src/app/store.ts`、`docs/007-architecture.md:450` |

**重要限定**：因为 issue 和 PR 都是关的，**没有"它踩过的坑"的一手线索**。第五节列出的坑全部来自它自己写在 README / 文档 / 代码注释里的自述，不是社区反馈。

---

## 二、架构（重点）

### 2.1 三层结构：Source → Engine → Executor

```
GitHub / Feishu ──Trigger──> Intake ──> Thread ──> Eval ──Decision──> Ticket ──Assignment──> Executor Session
                                                                        │                        (worker-<ticket id>)
                                                                        └──── Channel 回复 ──────┘
```

- **Source**：事件源插件，管读位置、去重、把人话翻译成 Trigger（`src/sources/kind.ts` 定义 `SourceKind` 协议）。
- **Engine**（`src/core/engine.ts`，270 行）：**唯一写入者**，管 Trigger/Thread/Decision/Ticket/Assignment 五个聚合。
  拆成 5 个 `EnginePart`：`Intake` / `Evals` / `Tickets` / `Assignments` / `Replies`，依赖单向流动（`docs/007-architecture.md:44`）。
- **Executor**（`src/executor/dsh.ts`，673 行）：一个工单一个 Session + 一个目录。
- **两个角色**：`orchestrator`（主 Session，代码里的 `masterId`）与 `worker`（每个工单一个 Executor Session）。

### 2.2 主 agent 做什么、不做什么（这是最有价值的部分）

分工不是靠"请你自己判断"，是**四层强制**同时上的：

**(a) 工具集物理限制**。主 Session 的 preset 里 `tool-fs` 写死 `write: false, edit: false`，没有 subagent、没有 web、没有 file search、没有 todo、没有 ask-user（`cordis.patch.yml` 的 `dsh-superagent-router-preset`）。代码里再 restrict 一次：

```
// src/app/sessions.ts:263
binding.disposers.push(agent.ctx.tools.restrict({ allow: ['skill', 'bash', 'read', 'read_image', 'job_output', 'job_list', 'job_kill'] }),
```

**(b) 工具 schema 的字段就是职责边界**。`orchestrator_route` 的每个 item 只能填这些（`src/app/tools/main.ts:47-56`）：

```
kind: 'accept' | 'attach' | 'ignore' | 'stop'
trigger_id / ticket_id / title(≤200) / worktree_name / acknowledgement(≤100 词) / note(≤30 词) / reason(≤500)
```

**没有**"实现方案""验收标准""文件清单""测试要求"字段。想塞也会被 schema 拒（`.strict()`）。
`docs/004-prompts.md:77`：

> The main Session only routes: it forwards the original Trigger and the routing facts, and makes no technical decisions, through one routing tool that takes the decisions on several waiting candidates in one call. **A routing note has at most 30 words.**
> The Executor reads the original sources, judges the scope, implements and verifies.

**(c) 显式禁令**（`prompts/shared.md:5`，这是两个角色共享的那一段）：

> Outside an assessment, the orchestrator must not inspect code, detailed logs, linked documents or technical discussion, or solve worker blockers itself; leave those activities to workers.

`prompts/dispatch.md:14/38/40/52` 逐条展开：不扩 scope、不转述成工作计划、不追上下文引用、不读 transcript 编计划。

**(d) 禁止等待，强制"事件推着走"**。`prompts/orchestrator.md:16`：

> Worker reports, follow_up notices, new candidates and a background job's end, with its output, arrive by themselves as messages: never wait for them with sleep, polling or job waits; end the turn when nothing is left to do.

这条**有代码守卫**，不只是提示词（`src/app/sessions.ts:77-85`）：`sleep` 出现在命令位置、`timeoutMs > 30_000`、`job_output wait > 5s` 一律被 `guard` 拦下，返回 `NO_WAIT` 文案。

**(e) 还有个测试把提示词钉死**：`tests/cards.spec.ts` 用 `RULES` 表逐条校验"某条规则必须出现在某个 prompt 文件的原文里、某些词不得出现"。改提示词改掉这条规则，测试红。
这解决了"提示词腐烂"——Overwatch 的 `docs/spec/dispatch-contract.md` 没有等价机制。

### 2.3 子 agent 怎么被创建、调度、汇报

**创建**（`src/app/sessions.ts:157-176`）：

```
await ctx.sessionController.create({ sessionId: 'worker-<ticketId>', workspaceId, agentPreset: 'dsh-superagent-worker' })
ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
```

Session id 由工单 id 派生（`workerSessionId()`，`src/executor/dsh.ts:24`），所以**可寻址、可重建、可恢复**。

**调度**：一切外部动作走持久化副作用队列 `Effects`（`src/app/effects.ts`），六种 kind：
`assessment / launch / delivery / relay / notice / reply`，各有并发上限、是否保序、退避参数（`docs/007-architecture.md:164`）。
命令在事务里 `enqueue`，提交后才执行——这是它能在崩溃/重启后不丢消息的根。

**汇报**：worker 只能调六个工具（`src/app/tools/executor.ts`）：

| 工具 | 作用 |
|---|---|
| `orchestrator_read` | 读**自己工单**范围内的资源（别人的读不到，`src/app/resources.ts` 的 `readable()` 校验） |
| `orchestrator_ack` | 接单确认（≤100 词，发到原消息下） |
| `orchestrator_report` | `progress / ready / blocked / failed / dropped` + `human_action`（结构化提问）+ `pr_number` |
| `orchestrator_thread_unrelated` | 判定某线程与本单无关，交还并说明 |
| `orchestrator_thread_follow` | 只订阅一个线程作上下文（不授权） |
| `orchestrator_trigger_handback` | 把越界的请求交还，附一句理由 |

**关键设计**：`ReportState` 里 `progress` 和 `ready/blocked/failed/dropped` 是**分流**的
（`src/app/notices.ts:107-121`）：普通 `progress` **不转发给主 Session**，只更新工单记录；
只有提问、结果、阻塞才 relay。这直接回答"主 agent 怎么不被细节淹没"——**不是压缩，是不发**。

### 2.4 上下文怎么管理（四层，从粗到细）

| 层 | 机制 | 出处 |
|---|---|---|
| 1. 卡片 | 所有给模型看的对象都是**有界卡片**：`preview()` 截 160 字，加 `read: 'ticket/<id>'` 指针 | `src/app/cards.ts:8` |
| 2. 列表页 | 工单/触发/线程/决策列表默认 20 条、上限 50，返回 `next_offset` | `src/app/resources.ts` 的 `list()` |
| 3. 按需分页 | `orchestrator_read` 全文按 4000 字（上限 8000）分页，`next_offset` 续读 | `src/app/tools/tool.ts` 的 `readTool()` |
| 4. 评估窗口 | 主动评估只给**首 5 条 + 触发点前后各 5 条**；触发本身 ≤4000 字，最近邻 ≤1200，其余 ≤400，更远的只给 50 字 stub | `src/sources/admission-context.ts` 的 `threadWindow()`；`src/app/assessment.ts:37` |

而且**评估指令不放进 payload**，写在系统提示词的 `runtime/admission` 段（`docs/007-architecture.md:534`）——
同一条规则不会在每次工具调用里重复付费。

长上下文兜底：两个 preset 都装了 `dsh-compaction-basic` + `tool-result-pruner`（`thresholdChars: 8192, headChars: 4096, tailChars: 1024`，`cordis.patch.yml:83-90`）。
压缩后的防重：`prompts/dispatch.md:44` —— "Check ticket summaries after compaction to avoid duplicate work."

**还有一条硬预算测试**（`tests/model-surface.spec.ts:40`）：

```
const BUDGET: Record<Role, number> = { orchestrator: 59_000, worker: 40_500 }
```

system prompt + 工具定义的总字符数超了，测试红。注释写明"降低是允许的，提高必须在 commit message 里说明理由"。

### 2.5 多层嵌套支持吗？

**领域层：严格两层，且是刻意的。**

- 主 Session 的 preset **没有 subagent 工具**（`cordis.patch.yml:122` 注释："no subagents, web, file search or writes…"）。
- Ticket → Executor 是唯一的派生关系，深度固定为 2。

**宿主层：worker 可以再派 subagent，但领域上不可见。**

worker preset 装了 `tool-subagent`（`provider: spawn, agentPreset: standard`，`cordis.patch.yml`）。
这些 subagent：

- 用 `standard` preset，继承 worker 的权限与工作工具（`src/app/sessions.ts:303` 的 `limitSubagent()`，沿 `parentSession` 上溯最多 8 层找到所属工单）；
- **工单结束时工具被收回**（`workOnly()` 的 guard：`'Ticket ended; new work needs a new authorized ticket'`）；
- **没有工单、没有报告、没有授权**——它们只是 worker 的一次工具调用，不是领域概念；
- 只为"并发语义"被跟踪：工单 turn 结束时若还有 job/subagent 在跑，**这个工单继续占 slot、状态仍是 working、不报 waiting**（`docs/003-execution.md:33`），turn 后最多 30 分钟（`BACKGROUND_LIMIT_MS`，`src/executor/dsh.ts:32`），到点杀 job、subagent 允许继续。

所以：**它没有"一层层子 agent 汇报给上一层"的机制**。subagent 的结果只回到它的父 Session（worker），
不构成可审计的层级。用户设想的"Overwatch 带领一层层子 agent"，**这个项目没有实现，也不打算实现**——
`README.md:5` 明说文章里有些设计"are directions for future development and are not implemented in this prototype"。

### 2.6 有没有明确的"什么该主 agent 做、该派出去"

有，而且**枚举式**，不是原则式：

| 主 agent 做 | 派给 worker |
|---|---|
| 判断该不该接（Eval：gate + assessment） | 读代码、判断 scope |
| accept / attach / ignore / stop 四选一 | 实现、测试、自审、开 PR |
| 转达结果与提问（原样转发，不改写） | 决定技术方案 |
| 保存设置/提示词（仅在明确人工要求时） | 处理人类 follow-up（越界的交还） |

判据落点：`prompts/shared.md`（职责）、`prompts/dispatch.md`（路由规则）、`prompts/admission.md`（主动接单的判据）。
三者互不重叠，且 `tests/cards.spec.ts` 会校验"同一规则不能在两处重复表述"（`RULES` 表的可选第 5 列 `gone` 是禁语列表，多条规则用它禁掉旧表述，例如防止"follow-up 要到主 Session 再看"这种被废弃的说法复活）。

---

## 三、与 Overwatch 的可比性

### 3.1 Overwatch 现状（对照基准，引自本仓 README / 设计存档）

- 能：扫会话 transcript、判状态、发通知、生成接力草稿；`claude -p` / `claude mcp serve` 已验可用。
- 不能：往用户眼前那个会话注入指令（ADR-0001 三条路全堵）。
- 判据覆盖率：非问题项 14.5% / 纯结构 34.6% / 确定性文本 32.4% / 可命令核对 14.0% / 真需语义 4.5%。
- 通知系统有系统性缺陷：**把"会话处于什么状态"当作事件**，用谓词值做去重身份 → 同时误合并与误分裂
  （`docs/research/2026-11-04-notification-system-critique.md` §0）。

### 3.2 它有哪些 Overwatch 现在缺的（按可迁移性排序）

| # | 机制 | 为什么 Overwatch 缺 | 可迁移性 |
|---|---|---|---|
| 1 | **事件身份去重**：everything 用内容派生 id（`key(...)` = sha256(JSON) 前 32 位，`src/core/ids.ts`） | Overwatch 用 `dedupeKey(sessionId, state, reason)`，state/reason 是每轮重算的谓词，第二次真等待被静默 | **完全可迁移**——换掉身份值即可 |
| 2 | **等待行合并写，而不是永久抑制**：`Effects.enqueue` 的 `ON CONFLICT(kind,key) DO UPDATE`（`src/app/effects.ts:61-64`）——同 key 的新通知**覆盖**尚未发出的旧通知，保留队列位置 | Overwatch 的去重表"已通知条目会永久占据"（`scripts/watch.mjs:367` 注释自己承认） | **完全可迁移** |
| 3 | **出站消息的 purpose 闸门**：`acknowledgement / answer / result / attention` 四选一，每个有其放行条件（`src/core/replies.ts:57-100`）；`result` 要求工单已 ready/merged；`attention` 要求与工单当前 open question 文本**逐字相等** | Overwatch 的通知没有"这条消息凭什么发"的门，只有 state 判定 | **可迁移**（语义层） |
| 4 | **结构化事实而非自由文本**：`docs/001-domain.md` 的 "Rejected concepts" 明确否决"Inferring 'waiting on a person' from a report's free text — the classification needs structured facts" | Overwatch 恰恰在从自由文本推断（`classify-stop.mjs` 的词组匹配） | **可迁移**（方向），但 Overwatch 拿不到结构化事实，只能从 transcript 反推 |
| 5 | **stage 表：按"在等谁"分类，首行命中即返回**（`src/core/stage.ts`，8 个开放 stage（5 个 person/* + working + working/queued + idle）+ 5 个结束态，共 13 个闭集值）；`person/*` = 必须人动，`working`/`idle` = 不用管 | Overwatch 的 `EXPLORING/PRODUCING/STALLED` 区分度几乎为零（129 个会话 122 个 EXPLORING） | **可迁移**——把状态从"它在干什么"改成"它在等谁" |
| 6 | **卡片 + read 指针** | Overwatch 读 transcript 是整段读；没有"先给 160 字摘要 + 指针，需要时再分页"的协议 | **可迁移** |
| 7 | **硬预算测试**（prompt+tools ≤ 59000/40500 字符） | Overwatch 没有对自身派发 prompt 的体积上限 | **可迁移** |
| 8 | **文档一致性硬门**：`tests/docs.spec.ts` 校验编号文档只能引用更早的、每个本地链接可解析、007 的表必须列全每个模块和每个测试 | Overwatch 有 `check-structure.mjs`，但没校验"规格引用的代码路径是否还存在" | **可迁移** |
| 9 | **Host 模拟器测试**：`tests/fixtures/host.ts` 模拟整个 DSH，`tests/runtime.spec.ts` 端到端跑 | Overwatch 面对的是不可控真宿主，没有等价物 | **部分**（可做 transcript 回放器） |

### 3.3 它有哪些设计依赖特权、Overwatch 没法照搬

这是本节最重要的一张表。**dsh 的全部"调度能力"都建立在这 10 个 API 上**（grep 实测，全部来自 `@deepseek-ai/dsh-*`）：

| 它做的事 | 用的 API | Overwatch 为什么做不到 |
|---|---|---|
| 创建 worker Session | `ctx.sessionController.create(...)`（`src/app/sessions.ts:144`） | Overwatch 观察的会话是用户启动的，它没有 id 分配权 |
| 给 Session 选 preset / 权限 | `permissionPresets.set(..., 'danger-full-access')`（`:152`） | 不能改别人的权限 |
| 注入 system prompt 段 | `agent.ctx.systemPrompt.section({...})`（`:244`） | 改不了别人会话的系统提示词 |
| 注册 / 限制 / 守卫工具 | `ctx.tools.register` / `.restrict({allow})` / `.guard(fn)`（`:208/263/264`） | **完全不可能**——这是 Overwatch 与它最大的能力差 |
| 往运行中会话插话 | `agent.steer(message)` / `agent.inject(message)` / `agent.followup(message)`（`src/app/delivery.ts:79-81`） | ADR-0001：注入落副本，窗口里看不到。**这条是 Overwatch 全部设计的天花板** |
| 打断/取消一个 turn | `agent.cancel({kind:'user'}, {keepInbox})`（`src/executor/dsh.ts:365` 等多处） | 不能中断用户会话 |
| 结束工单后收回工具 | `tools.guard` 检查 `liveTicket`（`src/app/sessions.ts:292-296`） | 无介入点 |
| 建目录、起 worktree | `workspaceRegistry.create(cwd)` + prepare 命令 | 可以，但只能在自己的目录里干（占本机资源） |
| 排空 / 杀掉 subagent | `subagents.drainChildren` / `jobs.kill`（`src/executor/background.ts`） | 完全不可见 |
| 独占并发额度 | `WorkerSlots`（`src/executor/dsh.ts:180+`） | 无意义（不用它管并发） |

**一句话**：dsh 是**裁判 + 教练 + 老板**三合一（它同时拥有授权、生命周期、执行环境）；
Overwatch 只是**看台上的观察员**，最多加上"给教练递纸条"（`claude -p` 产出建议/草稿）。

### 3.4 用户设想的「Overwatch 带领各个 harness 中的 agent」 vs 它的架构

| 维度 | dsh-superagent | 用户设想 |
|---|---|---|
| 手下是谁的 | 自己 `create` 的，id 可预测（`worker-<ticket>`） | 用户已有的会话，id 是宿主的 |
| 能不能插话 | 能（`steer`/`inject`） | **不能**（ADR-0001 实测） |
| 能不能限权 | 能（工具白名单 + guard + preset） | 不能 |
| 能不能收工 | 能（工单结束 → 工具被拦） | 不能 |
| 派活的形态 | 开一个新 Session，附原始 trigger + 授权范围 | 只能生成"接力草稿"给人转发 |
| 可行性判断 | 完整闭环 | **只能在"生成草稿 + 观察 + 通知"这一层闭环** |

**结论：差别不在架构品味，在所有权（ownership）。** dsh 的三层（Source/Engine/Executor）里，
Engine 和 Executor 都要求"我是唯一写入者"。Overwatch 若要照搬，唯一诚实的路径是
**自己 spawn `claude -p` 会话当手下**（这条已验证可用），那样它就拥有了那些会话——
但那是**另一条产品线**（自建执行层），不是"带领用户已有的会话"。
两者的调度协议可以共用，执行层不能共用。这一点必须写进 README 的能力边界，否则会重演"以为能自动接力"的错。

---

## 四、可借鉴的具体机制（能抄的，逐条给出处）

### 4.1 去重身份：内容派生 id，而不是谓词值

```ts
// src/core/ids.ts（全文 4 行）
export function key(...values: string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)
}
```

用途一览（全部同一函数）：

| 场景 | key 的输入 | 效果 |
|---|---|---|
| Eval | `('eval', threadKey, policyVersion, at, ...triggerIds)` | 同一批 Trigger 同一时刻只有一个 Eval |
| 回复 | `('ack', trigger.id)` / `('reply', triggerId, text)` | **同一句回复重试不会发两遍** |
| relay | `key('worker-result', ticket.id, ticket.updatedAt, text)` | 同一报告同一文本只 relay 一次 |
| 副作用行 | `(kind, key)` 主键 | 同 kind 同 key 覆盖而非新增 |

**对 Overwatch 的直接含义**：去重键必须是**"这件事是什么"**（哪个 tool_use、哪条消息、哪次提问），
不能是**"这个会话现在是什么状态"**。红队 C1 的结论与此完全一致，只是 dsh 提供了可运行的参照实现。

### 4.2 合并写（coalescing）而不是永久抑制

```ts
// src/app/effects.ts:61-64
enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void {
  this.store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE
    SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due`)
```

配套的注释在 `src/app/notices.ts:11-13`，说得很直白：

> `name` is the coalescing key in `Effects` (a newer notice with the same `name` overwrites an unsent waiting one, rather than permanently deduplicating future notices).

**这就是 Overwatch「去重表永久占位」bug 的正解**：同一件事实重复出现时，覆盖未发出的那条；
而"同一件事再次发生"应该用**不同的 key**（例如 `receiptNotice` 用 `randomUUID()`，`src/app/notices.ts:39`），
不能靠"键恒定所以抑制"。

### 4.3 出站消息的 purpose 闸门

`src/core/replies.ts` 的 `ReplyRequest` 是判别联合，四个 purpose 四套规则：

| purpose | 放行条件（代码） |
|---|---|
| `acknowledgement` | 工单 live + trigger 已到达该工单 + 有 channel + trigger 是人发的；每 trigger 只发一次（`id = key('ack', trigger.id)`） |
| `answer` | 必须引用一条**人问的问题** trigger；且该问题在本工单 `answers` 列表里 |
| `result` | 工单必须 `ready` / `completed` / `merged` / `dropped`，否则 `UserError('notReady')` |
| `attention` | `human_action` 必须与工单当前 `attention.question` **逐字相等**，否则 `UserError('notAttention')` |

配套提示词 `prompts/replies.md` 把"不要伪装"写死：

> Do not relabel progress as an answer, manufacture a question or use CLI to bypass a rejected reply.

**对 Overwatch**：现在所有通知都是"提醒"。若引入 purpose（`waiting_for_answer` / `permission_needed` / `failed`），
并要求每条通知必须能填出"用户现在能做什么"这一栏，43% 的误报会**在构造阶段就被拒**——
这正是 `prompts/team/communication.md` 的做法："Before sending, identify what the human can now review, use, decide or unblock; if nothing, send nothing."

### 4.4 stage 表：按"在等谁"分类

`src/core/stage.ts` 26 行，`docs/003-execution.md:8-16` 是同一张表。首行命中即返回：

| 序 | stage | 条件 |
|---|---|---|
| 1 | `person/delivery` | 输入投递失败 |
| 2 | `person/answer` | 有未回答的结构化提问 |
| 3 | `person/review` | 最新报告是 `ready` |
| 4 | `person/blocked` / `person/failed` | 最新报告 blocked/failed 且此后无人回话 |
| 5 | `working/queued` | 无 Assignment 或 pending |
| 6 | `idle` | 报告 waiting 或 Assignment ended |
| 7 | `working` | 其余 |

`person/*` 全部意味着"没有人类就动不了"，**这就是 Overwatch 唯一需要输出的行动信号**。
其余状态是描述，不需要告警——和 Overwatch README「关于四态」的结论同向，但 dsh 把它做成了**闭集 + 有序互斥 + 有测试逐行覆盖**（`tests/stage.spec.ts`）。

### 4.5 有界卡片 + 指针

```ts
// src/app/cards.ts:8
export function preview(text: string): string { return text.replace(/\s+/g, ' ').slice(0, 160) }
// src/app/cards.ts:36
export const INPUTS = 10, ASSIGNMENTS = 3
// src/app/cards.ts:95
return { related_tickets: order.slice(0, 8).map(ticketCard), tickets_total: tickets.length }
```

每张卡都带 `read: 'ticket/<id>'`，需要时再 `orchestrator_read`。**"给了指针就敢截断"** 是这套设计能成立的关键——
截断不是信息丢失，是把成本推给真正需要的人。

### 4.6 角色 prompt 的拼装顺序（可整段照抄结构）

`docs/004-prompts.md:44-59` 给出严格的拼装顺序，**且要求"最后一段是 Policy"**，理由写在文档里：

> The Policy section is regenerated from settings on every model request. It contains the Policy version, accept mode… **It is last so a Policy change leaves the preceding prompt text unchanged.**

对 Overwatch：`docs/spec/dispatch-contract.md` 现在的 `prompt = 公共段 + 域段 + baseline` 三段，
可以补一条"**易变段放最后**"，否则每次派发都会让前面的内容在缓存里失效（若用带缓存的 API）。

### 4.7 权限分级：默认 observe，只有被记录过的规则才 auto

`src/policy.ts` 的 `EvalConfigSchema.mode: 'off' | 'observe' | 'auto'`，默认 `observe`。
`observe` 模式下主动接单的判定**照样跑**，只是结果记成 `would_accept` 不执行（`src/policy.ts:55-58`）：

```ts
if (strength === 'inferred' && settings.eval.mode !== 'auto') {
  const proposal = { title, scope, worktree_name: name }
  return { kind: 'ignore', audit: { ...audit, would_accept: true, proposal }, reason: { code: 'observed', values: { text: assessment.reason } } }
}
```

`SETUP.md:58` 说明默认值选择理由："accept mode `observe`, which records proactive work without doing it"。

**对 Overwatch**：这直接对应"自动接力的分级 L0–L5"（`docs/design/hosted-mode.md` §1.2）——
dsh 的分级更粗糙（三档 vs 六档），但它的**实现方式值得抄**：不是"关闭功能"，是"照常判定但只记录"。
这样用户能在打开之前看到"如果开着会发生什么"。Overwatch 已有 `observe` 概念的雏形（`docs/observe-period.md`），可以对齐。

### 4.8 评估规则的强制完备性

`src/policy.ts:44`（`assessmentOutcome`）：

```ts
if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some(rule => !ids.has(rule.id))) {
  throw new Error('Exactly one assessment for every enabled rule is required; disabled, unknown or missing rule IDs are not allowed')
}
```

**每条启用的规则必须被逐条判定一次，无论匹配与否**，并且 `matched: false` 也要给理由。
配套 `prompts/admission.md` 结尾："a reason saying that a rule does not apply cannot be a positive match."

**对 Overwatch**：这等价于"验收必须对照**预先声明的**每一条标准逐条判定"（`docs/spec/evidence-discipline.md` 的要求），
dsh 把这条做成了**运行时异常**，而不是 prompt 里的呼吁。这是它可以抄的最硬的工程手段之一。

### 4.9 提示词/文档的硬门（三条，都是测试）

| 测试 | 校验什么 | 对应 Overwatch 的缺口 |
|---|---|---|
| `tests/cards.spec.ts` | 每条规定必须出现在指定 prompt 文件的**原文**里，禁用词不得出现 | prompt 腐烂 |
| `tests/model-surface.spec.ts:389-396` | prompt + tool schema 总字符 ≤ 59000/40500 | 派发 prompt 体积失控 |
| `tests/docs.spec.ts` | 编号文档只能链接更早的；每个本地链接可解析；007 的表必须列全每个模块与每个测试文件 | 规格与代码脱节 |

第三条最有意思：`docs/007-architecture.md` 的 Module 表里列了 100+ 个文件路径，**测试会走文件系统验证它们都存在**，
并且反向要求"src 下的每个模块都要在表里出现"。这解决了"文档腐坏"最难的一部分。

### 4.10 恢复语义（restart / retry / crash）

`docs/003-execution.md:118-160` 写得非常细，三条值得抄：

1. **"什么算已读"有明确定义**：消息进入 Session history 才算 read（`session/event: user/message`），
   且"被取消的步不计"。这避免了"我发了但不知道它看没看到"的经典模糊。
2. **恢复通知要求先核对再动手**：重启后的 recovery note 明确写"check its directory, git history and GitHub before repeating any outside action"。
3. **瞬态失败 vs 永久失败分流**：`transient()`（`src/executor/dsh.ts:50-56`）只认 408/429/5xx 和连接类错误，其余直接判失败；瞬态最多重试 3 次，退避 15/30/60 秒。

---

## 五、它踩过的坑（自述，无 issue 可查）

| # | 坑 | 原文出处 | Overwatch 会不会踩 |
|---|---|---|---|
| 1 | **包装器不是安全边界** | `docs/003-execution.md:80`："These wrappers and directories establish defaults, not a security boundary. A worker can still execute a program by absolute path."；`docs/006-deployment.md` 明说两个 preset 都是 `danger-full-access`，"For isolation, use a dedicated OS account" | **会**，而且更严重。Overwatch 若要 spawn `claude -p` 干活，同样只是"默认值"级别的隔离 |
| 2 | **只靠提示词的限制不是限制** | `docs/007-architecture.md:507`："Avoiding code reads is a prompt rule, not a tool restriction." 它自己承认主 Session 有 `read`/`bash` 工具，只是靠 prompt 让它不去读 | **会**。凡是"禁止 Agent 做 X"只写在 prompt 里，就等于没禁止 |
| 3 | **一切只增不删** | `docs/007-architecture.md:484`："Nothing deletes old records yet, so these grow without bound"（trigger/disposition/decision/ended ticket/receipt/每个 settings 与 prompt 版本） | **会**。Overwatch 的 `state.json` 已经 43KB 且去重表只增 |
| 4 | **attach 是不可逆操作** | `prompts/dispatch.md:10`："A duplicate ticket can be closed; **a wrong attachment subscribes the ticket to the whole thread and stays.**" | **可类比**：Overwatch 的一旦发出通知就无法收回，所以派发前的判据必须严于事后补救 |
| 5 | **靠自由文本推断"在等人"是错的** | `docs/001-domain.md` Rejected concepts 表最后一行："Inferring 'waiting on a person' from a report's free text — The classification needs structured facts; the Executor asks through a structured field." | **Overwatch 正在踩这个坑**，且没有"结构化字段"可用，只能从 transcript 反推。这说明 Overwatch 的天花板比 dsh 低——它不能要求对方"用结构化字段报告" |
| 6 | **让判定方自己等，会阻塞整条流水线** | `docs/004-prompts.md:78`："A guard refuses `sleep`, shell timeouts over 30 seconds and job waits over 5 seconds, because a blocked step delays new candidates." | **会**。Overwatch 的 `runTick` 把派发放所有层之后，轮内 p90=45s（见 `docs/spec/2026-11-04-notify-fix-acceptance.md` F3/F4），正是同一个失效模式 |
| 7 | **失败后锁死工具会挡住人类** | `docs/001-domain.md` Rejected concepts："Locking all of an Executor Session's tools when it fails or blocks | It would refuse a person working directly in the Session, and the report after recovery; pausing automatic input is enough" | **会**。Overwatch 若要"停掉一个会话"，同样要区分"停自动输入"和"禁止人操作" |
| 8 | **策略变更不能撤销在途工作** | 同上："Cancelling running Tickets on a Policy change | A cancelled change leaves half-finished work; the change is recorded and delivered instead" | 未见 Overwatch 讨论，值得记一笔 |
| 9 | **拿不到 issue 反馈** | 仓库 `has_issues: false`、0 release、1 个提交 | 说明"21.5k star"完全不能当质量背书。**引用这个项目时必须标注"单提交原型"**，否则会拿它当成熟方案 |
| 10 | **它自己列的未解问题** | `docs/007-architecture.md:614-617`：① 信任边界（哪些 Trigger 字段可信）；② 部署隔离（agent 用独立 pin 的 harness 安装） | 第二个正是 Overwatch 的处境：宿主升级即失效 |

---

## 六、给 Overwatch 的三条判断（不是计划，是结论）

1. **能抄的是"调度协议"，不是"调度系统"。**
   具体是四件：事件身份去重（§4.1）、合并写（§4.2）、purpose 闸门（§4.3）、stage 表（§4.4）。
   这四件都是纯逻辑，零宿主依赖，可以独立实现并单测。**其中 §4.1 + §4.2 直接对应通知系统被 C1 判定"重做"的那条根本错误。**

2. **抄不了的是"执行权"。**
   Overwatch 永远不会有 `agent.steer` / `tools.restrict` / `tools.guard` / `sessionController.create` 对用户会话的等价物。
   任何以"替用户会话做决定并执行"为前提的设计（`hosted-mode.md` §1 分级、§3 投递、§5 演进）都建立在不成立的前提上——
   这一点 ADR-0001 已经裁决过，本次分析只是**从另一个项目的架构给出的独立佐证**。

3. **用户设想的"Overwatch 带领各 harness 中的 agent"有两个可行落点，二者需要分开命名：**
   - **落点 A（观察者 + 顾问）**：带领"名义上"的 agent——派发任务给人、给人草稿、给人判据。已实现的部分就在这里。
   - **落点 B（自建执行层）**：`claude -p` 起自己的会话，此时 Overwatch *拥有*生命周期，可以照抄 dsh 的 Engine/Executor 分层。
     这是一条新线，与"观察用户已有会话"不冲突，但不能混谈——混谈就会重演"以为能自动接力"。

   dsh 的价值在于：**落点 B 若要做，它提供了完整的、可读的、1.5 万行的参照实现**（含 59 个 spec 文件、1.5 万行测试），
   而落点 A 的协议层（去重、purpose、stage）也可以从它这里直接取。

---

## 七、复现方式

```bash
cd <本仓根目录>   # 例如仓库根
git clone --depth 1 https://github.com/deepseek-ai/dsh-superagent-prototype.git .tmp-analysis/dsh-ref
cd .tmp-analysis/dsh-ref
git log --oneline                     # 1 个提交
find src -type f | wc -l              # 111
find src -name '*.ts*' | xargs wc -l  # 15205
find tests -name '*.ts*' | xargs wc -l # 14960
```

关键文件索引（若要深入）：

| 想看的 | 文件 |
|---|---|
| 主/子分工的全部规则 | `prompts/shared.md`、`prompts/orchestrator.md`、`prompts/dispatch.md`、`prompts/admission.md`、`prompts/work.md` |
| 领域模型与"被否决的概念" | `docs/001-domain.md`（Rejected concepts 表最有价值） |
| 状态机 | `src/core/stage.ts`（26 行）+ `docs/003-execution.md:11-22` |
| 上下文预算 | `src/app/cards.ts`、`src/sources/admission-context.ts`、`src/app/assessment.ts:37`、`tests/model-surface.spec.ts:40` |
| 去重与幂等 | `src/core/ids.ts`、`src/app/effects.ts:61`、`src/app/delivery.ts:19`、`src/app/store.ts:266`、`src/app/outbox.ts:31` |
| 出站闸门 | `src/core/replies.ts` |
| 特权 API 全清单 | `src/app/sessions.ts`、`src/executor/dsh.ts`、`src/app/delivery.ts`、`cordis.patch.yml` |
| 它踩的坑 | `docs/003-execution.md:80`、`docs/007-architecture.md:484/507/614`、`docs/001-domain.md` Rejected concepts |
