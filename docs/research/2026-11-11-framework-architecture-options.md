# Agent 框架的架构选型：进程模型、状态、上下文、harness 接口

> 日期：2026-11-11
> 角色：研究 Agent SA2 · 产出形态：**exploration**（架构选型调研，不是实施计划）
> 命题：用户要自研 agent 框架，**工程结构**该长什么样——不是产品形态，不是功能清单。
> **未修改 Overwatch 任何代码，未碰 git，未新增任何 `scripts/` 文件。**

---

## 零、结论先行

**1. 进程模型：混合，但分界线不是「主 agent 进程内 / worker 进程外」，而是「编排进程内、执行进程外、worker 由我们 spawn」。**
主进程持有台账与调度状态；每个 worker 是一个我们自己 spawn 的子进程（`acpx <agent> exec/prompt` 或 `claude -p`），stdio 归我们所有。
**明确不用 `claude mcp serve` 当派发通道**——实测它有两个致命缺陷：不能取消（`TaskStop` 报 `No task found with ID: w1`）、spawn 出来的子 agent 跑不了 shell（`pwsh timed out after 5000ms`）。它只能当「纯推理外包」，不能当执行器。

**2. 状态管理：`tasks/runs/<run-id>/` 下「一份快照 + 一条只增事件流」，不引数据库。**
`run.json`（原子替换，复用 `scripts/watch.mjs` 已有的 `renameSync` 重试）+ `events.ndjson`（只追加）+ 每工单一个目录。
崩溃恢复**不靠标记位，靠现场探测**：pid 活着吗、`report.json` 存在吗、mtime 在最后一条事件之后吗——三者组合判 `RESUMABLE / ORPHANED / UNKNOWN`，**`UNKNOWN` 绝不静默降级成 `DONE`**。

**3. 上下文：主 agent 永远只拿一张 5 字段卡片 + 一个指针；全文落盘，永不进父上下文。**
这不是压缩，是**输入不存在**。实测确认这是通例：dsh 的 `reportRelay` 把 `progress` 直接 `return undefined`（`src/app/notices.ts:127`），报告超 600 字符截断并挂 `read` 指针（`:110`）；卡片预览 160 字符（`src/app/cards.ts:8`）；分页读默认 4000 字符（`src/app/resources.ts:87`）。
**预算从"估算"升级成"实测"**：ACP 的 `usage_update` 给真实 token 与 cost（实测 `{"used":7887,"size":200000,"cost":{"amount":0,"currency":"USD"}}`），MCP 的 `Agent` 结果也给 `totalTokens` 与完整 `usage`。CLAUDE.md #8 的「预算必须声明」因此第一次可以被执行，不再需要 `est:`。

**4. 零依赖：不要破。**
驱动层用 **`acpx` 二进制当外部进程**，不是 `import`。理由是可量化的：acpx 自身 148 个文件 / 43,753 行；官方 SDK 光 peer deps 就挂 `zod ^3.25||^4` 与 `@modelcontextprotocol/server`。而这台机器上 `claude-agent-acp` 跑不起来的已知原因正是 zod/v4 的 ESM 解析——**供应链风险在这里不是抽象概念，是已经发生过的故障**。

**5. 最重要的一条架构决策：把「谁 spawn 谁拥有」写成宪法第一条。**
谁 spawn 了进程，谁就拥有 cancel、流式事件、exit code 与 stderr。这条同时决定了四件事：不能用 MCP 当派发通道（无 cancel）、不能用单进程内编排（worker 不是我们的库）、必须读 ACP `initialize` 声明的能力而不是假设、以及「权限隔离」只能承诺「记录它做了什么」，不能承诺「阻止它做什么」。
这条与我实测的三件事一一对应，不是原则，是结论。

**6. 与已有 `2026-11-10-agent-framework-skeleton.md` 的关系：不推翻，收窄两处、改判一处。**
收窄：§3.5 把 `claude -p` 判成「不能作为 v0 的同步通道」——**实测在剥掉 4 个宿主变量后它能工作**（39.3 秒，exit 0，输出 `PONG`）。它的失败是**环境**造成的，不是接口造成的，所以它是合格的 T2 适配器，不是废件。
改判：§3.4 机制 1「不存在 progress 通道」——**方向对，但"不存在"过头了**。ACP 有 `session/update` 逐 token 流，MCP 有 30 秒一次的心跳通知。正确表述是「**父 agent 的上下文里不存在 progress**」，而不是「协议里不存在」：progress 存在于**子进程 → supervisor 的这条边**，supervisor 再决定丢弃它。

---

## 一、覆盖声明

### 1.1 真读了代码（`git clone` 到 `.tmp-analysis/sa2/`，已 gitignore）

| 仓库 | 规模 | 读了什么 |
|---|---|---|
| `deepseek-ai/dsh-superagent-prototype` | `src/` 12,390 行 / 113 文件 | `src/core/{engine,model,ports,tickets,assignments,stage,part}.ts` 全文；`src/app/{notices,cards,resources,effects,sessions,store,runtime,passes,delivery,context,assessment,limits}.ts` 相关段；`src/executor/{dsh,background}.ts`；`src/app/tools/{main,executor}.ts`；`prompts/` 全 12 篇；`cordis.patch.yml`；`docs/{003-execution,006-deployment,007-architecture}.md` |
| `OpenHands/software-agent-sdk` | `openhands-sdk` 85,944 行 | `agent/{acp_agent,parallel_executor}.py`、`conversation/{state,event_store,cancellation,stuck_detector,response_utils}.py`、`subagent/{registry,schema,scope}.py`、`context/condenser/{base,pipeline_condenser,llm_summarizing_condenser}.py`、`critic/base.py`、`mcp/client.py`；`openhands-tools/openhands/tools/{task,delegate,child_conversation}/` 全部；`openhands-agent-server/openhands/agent_server/conversation_lease.py` |
| `openclaw/acpx` | `src/` 43,753 行 / 148 文件 | `src/acp/{client,client-process,ndjson-stream}.ts`、`src/runtime.ts`、`src/runtime/public/{contract,events}.ts`、`src/runtime/engine/{controls,session-options}.ts`、`src/agent-registry.ts`、`package.json`；`docs/{exit-codes,permissions,prompting,session-control,sessions,session-watch,output-formats,custom-agents,runtime-process-lifecycle}.md`、`docs/2026-02-25-warm-session-owner-architecture.md` |
| Mastra `@mastra/acp` | 3 文件 811 行 | `agent-sdks/acp/src/{agent,connection,session}.ts`（本地 `mastra-acp-*.ts`） |
| ACP 规范 | `schema/v1/schema.json` 265 KB | `$defs` 逐项查过：`NewSessionRequest`、`AgentCapabilities`、`SessionCapabilities`、`StopReason`、`UsageUpdate`、`SessionUpdate` 全部 13 个变体、`ToolKind`、`RequestPermissionRequest`、`InitializeResponse` |

### 1.2 真跑了（本机，2026-11-11，Node 26.12.1，Claude Code 2.1.289，acpx 0.22.0，opencode 1.19.5）

| # | 命令 / 探针 | 结果 |
|---|---|---|
| P1 | `acpx --format json --json-strict opencode exec --file p.txt` | **成功**。`initialize` → `session/new` → 逐 token `agent_message_chunk` → `usage_update{used:7887,size:200000,cost:0}` → `{"stopReason":"end_turn","usage":{"inputTokens":6420,"outputTokens":4}}`。**冷启动整轮 80.4 秒**（第二个样本 80,394 ms） |
| P2 | `acpx --format json claude exec`（`claude-agent-acp` 0.95.0） | **失败**。`session/new` 返回 `{"code":-32000,"message":"Authentication required"}`，exit 1。剥掉 4 个宿主环境变量后同样失败。**本机 claude 适配器目前不可用** |
| P3 | `claude mcp serve` + `initialize` | 成功，**但耗时 9.4–10.3 秒**（本机网关冷启动）；`tools/list` 202 ms，23 工具，与既有记录一致 |
| P4 | 同上，`tools/list` 取 `Agent` 的 schema | `required: ["description","prompt"]`，可选 `subagent_type / model / name / team_name / mode / isolation` |
| P5 | 同上，cwd 设为 Overwatch 仓库，再取 `Agent` 描述 | **12 个 `oversight-*` 全部出现在可派发类型里**（`oversight-acceptor`…`oversight-safety`）。项目角色定义经 MCP 通道可见 |
| P6 | MCP `tools/call Agent`（`subagent_type: claude`，剥宿主变量） | **成功**。23.9 秒。返回结构化 JSON 字符串：`{"status":"completed","agentId":"aca45278…","agentType":"claude","content":[{"type":"text","text":"PONG"}],"resolvedModel":"claude-opus-5-5","totalDurationMs":17100,"totalTokens":16902,"usage":{…}}` |
| P7 | MCP `tools/call Agent`（`subagent_type: "oversight-acceptor"`，cwd=仓库） | **成功**，43 秒。它自报：「No Bash/shell tool exists in my toolset — this agent instance only has Read, Grep, Glob, and Write」——**经 MCP 通道独立复现了 FR2 审计的核心结论** |
| P8 | 同上，prompt 要求它跑 `node --test`（`subagent_type: general-purpose`） | 子 agent 报告：「the shell tool failed on every attempt, including a trivial `echo READY`, each returning **"Command contains malformed syntax that cannot be parsed: pwsh timed out after 5000ms (2 attempts)"**」。**MCP spawn 出来的子 agent 在本机跑不了 shell** |
| P9 | 同一 stdio 连接上并发两次 `Agent` 调用 | **两次并发执行**：分别于 49,966 ms 与 60,449 ms 返回，都是 `status: completed`。**MCP stdio 不是请求-响应串行，一条连接可多路复用** |
| P10 | 并发期间 `TaskStop{task_id:"w1"}`（`name` 已在 P9 的调用里设过） | **失败**：`Tool TaskStop input is invalid: No task found with ID: w1`。**MCP 通道没有可用的取消** |
| P11 | `Agent` 调用带 `_meta.progressToken` | 收到 `notifications/progress`：`{"progressToken":"tok","progress":30,"message":"Running for 30s"}`，约每 30 秒一次。**有心跳，但只有"跑了多久"，没有"在做什么"** |
| P12 | `claude -p --model haiku "…PONG"`（剥 4 个宿主变量） | **成功**：39,258 ms，exit 0，stdout=`PONG` |
| P13 | 同上，**不剥**宿主变量 | **失败**：exit 1，stdout=`Not logged in · Please run /login`，27,420 ms |
| P14 | `node --test scripts/*.test.mjs` | **722 / 722 全绿**，42.1 秒（本轮基线） |
| P15 | `node scripts/check-structure.mjs` | ✓ 全部通过 |
| P16 | `node -e "require('node:sqlite').DatabaseSync"` | 可用（Node 内置，零依赖） |

### 1.3 没做 / 无法核实

- **没跑 `acpx` 的 `--permission-policy` 真实生效验证**。文档说得很清楚（`docs/permissions.md`），但我没有构造一次真实的越权请求去验证它被拦下。
- **没验证 P8 的 pwsh 失败是普遍还是个例**。只跑了一次；可能是这台机器的 PowerShell 参数化问题，也可能是 `claude mcp serve` 的已知缺陷。**不作为结论，只作观测记录。** 这一条直接影响「MCP 能不能当执行通道」，建议 v0 用一个专门的负向测试钉死。
- **没实测 `ListAgents` 在 agent 运行中的返回**。P9 里它返回了 14 条**对等会话**（不是 in-flight 子 agent）；另一次带 `q` 过滤的调用 130 秒未返回（疑似挂起，无法区分是查询慢还是不支持该参数）。
- **没实测 dsh 本体**（`dsh --profile acp`）。用户已说「可以延缓」，且既有记录是「协议通、败在余额与 stdout 污染」。本报告关于 dsh 的结论**全部来自读它的源码**，不是运行它。
- **没做成本实测**。P1 的 `usage_update.cost.amount` 是 0（opencode 免费档），P6 的 `totalTokens: 16902` 有一次真实数，但没有可比的"做同一件活要花多少"的对照。
- **没读 OpenHands 的 `openhands-workspace` / `openhands-tools/preset`**。它们与本报告的模块边界结论无关，但如果要做沙箱，那里有现成的实现。

---

## 二、进程模型

### 2.1 三种形态各自的实际代价

| | 单进程内编排（Mastra / LangGraph / dsh） | 多进程（每个 worker 一个 CLI） | 混合（编排在内、执行在外） |
|---|---|---|---|
| **状态共享** | 直接共享内存对象。dsh 的 `ctx.agents.get(sessionId)` 拿到的是活对象，变更立刻可见 | 只能靠文件 / stdio 传输。没有共享内存 | 编排状态在进程内是对象，跨进程只有「工单文件 + stdio 上的结构化事件」 |
| **崩溃隔离** | **零**。dsh 的 worker 是 `DSH Session`，同一个 Node 进程里的对象；一个 native 模块崩溃带走整个编排器 | **完整**。子进程死不等于台账死 | **完整**（执行侧）。编排进程崩了，子进程成孤儿——需要显式的孤儿清理 |
| **取消一个 worker** | 直接调 `agent.cancel({kind:'user'}, {keepInbox:false})`（`dsh-ref/src/executor/dsh.ts:365`），同步、可靠 | 三级：ACP `session/cancel`（协作式）→ 关 stdin → `SIGKILL` / Windows `TerminateProcess` | 同多进程。**这是混合真正赢的地方** |
| **流式中间结果** | 事件订阅，进程内回调，零序列化开销 | stdio 上的 NDJSON。有 framing 成本，但 acpx 已经做完（`src/acp/ndjson-stream.ts:9`，单条上限 64 MB） | 同多进程 |

### 2.2 为什么「单进程内编排」对我们不成立

不是偏好问题，是三条实测事实：

1. **worker 不是我们的库。** dsh 能做单进程，因为它的 worker 是 `@deepseek-ai/dsh-agent` —— 它能 `agent.cancel()`、能订阅 `agent/status`、能 `ctx.tools.restrict()`。我们对 `opencode` / `claude` 一个都做不到。
2. **取消只有进程级手段。** 三个候选通道，实测结果：
   - MCP `TaskStop`：**失败**（P10，`No task found with ID: w1`）。而且我从 P4 的 schema 里确认 `Agent` 确实接受 `name` 参数——也就是说名字传了、调用也成功了，但 `TaskStop` 找不到它。这条路目前是死的。
   - ACP `session/cancel`：只有协作式。`acpx/src/acp/client.ts:1619` 发的是 JSON-RPC **notify**，等 adapter 自己收手；`contract.ts:49-51` 原文：「**ACP has no mid-turn steering request.**」
   - 杀进程：唯一有保证的一级。`acpx/src/acp/client-process.ts` 与 `docs/runtime-process-lifecycle.md` 自己说得很清楚：「Hosts retain responsibility for those policies」，acpx 只做 best-effort 后代清理（8 秒预算）。
   → **谁 spawn，谁才有最后一级取消。** 这一条单独就足以否掉「用 MCP 当派发通道」。
3. **流式结果只有 ACP 给。** P1 拿到逐 token 的 `agent_message_chunk`；P11 走 MCP 只拿到「跑了 30 秒」。差别不是好看不好看：**没有 token 级流，"看它是不是在原地打转"这件事就只能靠猜**——而这正是本仓 `scan-sessions.mjs` 已经在解决的问题的同一面。

### 2.3 为什么「纯多进程」也不够

纯多进程 = 主线程什么都不管，只 fork。那我们就没有地方放**验收闸**与**三事件收敛**——而这两件是本仓唯一独占的东西（`README.md`「唯一站得住的差异」）。
dsh 的教训在这里最直接：它的价值在 `src/core/`（15 个文件 2,103 行，**零 IO、全部同步、只 import `node:crypto`**），不在 `src/executor/dsh.ts`（673 行）。**编排逻辑必须是进程内的纯函数，执行必须是进程外的副作用。** 这正是它的分层。

### 2.4 定案

```
┌─ 编排进程（单个 Node 进程，可零依赖）───────────────────┐
│  run 台账：run.json / events.ndjson / tickets/*          │
│  纯函数：拆票、判事件、判预算、判超时                     │
│  验收闸：调 spawn 出的 acceptor 子进程，读它的判定         │
│                                                          │
│   spawn(stdio: pipe) ──┬──> [acpx opencode exec]  ← 执行  │
│                        ├──> [acpx claude exec]    ← 执行  │
│                        ├──> [claude -p --agent …] ← 执行  │
│                        └──> [acceptor 子进程]      ← 判定  │
└──────────────────────────────────────────────────────────┘
```

四条硬规则：

1. **每个工单一个子进程，从不开长驻池。** 理由是隔离优先于速度：计费/超时/取消都以进程为界。P1 的 80 秒冷启动是这台机器 opencode 的启动成本，不是协议成本——用「同一工单内的多轮 prompt 复用同一 session」摊掉它（acpx 的 `prompt` 子命令按 `(agentCommand, cwd, name)` 复用 session，只有 `exec` 是一次性）。
2. **stdio 的三根管道全部由编排进程持有。** 这是「拥有取消」的物理前提。任何「让 acpx 自己去连一个 daemon」的写法都会让这条失效。
3. **`claude mcp serve` 只用于"纯推理外包"**（判定、评分、写摘要），**不用于执行**。P8 的 shell 失败与 P10 的无取消共同决定这一条。若将来 P8 被证明是偶发，仍需 P10 有解才能改判。
4. **孤儿清理必须是显式的。** 编排进程启动时，扫 `tasks/runs/*/tickets/*/pid`，对每个 pid 做 `kill(pid, 0)` 存活探测 + 启动时间比对（防 pid 复用，这是 acpx 在 Windows 上用 `Win32_Process` 做的事），对存活但无主的子进程一律杀。**不做这件事，第三次崩溃后机器上会躺着一堆跑着的 agent。**

---

## 三、状态管理

### 3.1 存哪：文件，不是数据库

| 候选 | 判断 | 依据 |
|---|---|---|
| 内存 | ✗ | 崩溃即失。而且「用户中途介入」天然是跨进程的 |
| SQLite | **可用但不用**（v0） | `node:sqlite` 在本机可用（P16），且 dsh 正是这么做的（`src/app/store.ts:51`，`DatabaseSync` + WAL + schema 版本 11 + 迁移）。但**它换来的是事务与并发写，而我们 v0 只有一个写者**。为一个写者付 schema 迁移的成本是负收益 |
| **文件（快照 + 只增日志）** | ✓ | 本仓已有可用件：`scripts/watch.mjs:423` 的 `saveState` 已实现「临时文件 + `renameSync` + 失败重试」，注释写明 `:73`「Windows rename 非原子」——**这个坑已经踩过并修好了**，直接复用比引 SQLite 便宜 |

具体布局（全部在 `tasks/runs/<run-id>/`，该目录已 gitignore）：

```
<run-id>/
├─ run.json                  # 快照：run 级状态、预算、指针计数。原子替换
├─ events.ndjson             # 只追加。每行 {at, ticket, kind, payload}
├─ tickets/<tid>/
│   ├─ ticket.json           # 派发时的工单（不可变）
│   ├─ report.json           # 由 supervisor 写，不由执行者写（见 §4.3）
│   ├─ report.md             # 执行者自由写作，不进父上下文
│   ├─ transcript.ndjson     # 原始 ACP 事件流（可轮转）
│   └─ pid                  # 子进程 pid + 启动时间（孤儿探测用）
└─ verdict.md                # 验收闸输出
```

**顺序规则**：先写 `events.ndjson` 追加，再原子替换 `run.json`。恢复时以 `run.json` 为准、用 `events.ndjson` 补齐尾部——**日志是真相，快照是索引**。

### 3.2 崩溃后恢复：探测，不是信任

dsh 的 `resume()`（`src/executor/dsh.ts:524`）给了正确形状：重启后逐个 open ticket 检查，running 的调 `assignmentInterrupted`，pending 的重新入队，失败等待人。但它能这么做是因为它**拥有会话对象**（`ctx.agents.get(...)`）。我们没有，所以探测项不同：

| 探测 | 怎么查 | 判什么 |
|---|---|---|
| 子进程还活着吗 | `kill(pid,0)` + 记录里的启动时间与当前 kernel 启动时间比对 | 活着 → `STILL_RUNNING`，重挂 stdio（重挂失败则降级为 `UNKNOWN`） |
| `report.json` 存在吗 | 存在性 + mtime | 存在且 mtime ≥ 最后一条 event → `READY_TO_JUDGE` |
| 工单声明的超时到了吗 | 最后一条 event 的 at + `timeout_min` | 到了 → `TIMEOUT`（**不是「还在跑」**） |
| 三者都不成立 | — | **`UNKNOWN`** |

**`UNKNOWN` 必须冒泡成 `NEEDS_DECISION`，不许静默重试**。这不是洁癖，这是 P12/P13 的直接推论：`claude -p` 在宿主环境变量在场时 **exit 1 + 一句 `Not logged in`**、剥掉后 **exit 0 + 正确输出**——也就是说，**同一个命令在不同环境下可以是「失败」也可以是「成功」，而退出码本身不携带这个信息**。任何「exit code 即结论」的设计在这台机器上都是错的。

同时，dsh 的 `transient()`（`src/executor/dsh.ts:50`）是可直接搬的：匹配 `ECONNRESET / 429 / 50x / socket hang up / overloaded` 判可重试，其余不重试。它把「网络抖」与「真失败」分开，而我们自己的执行栈里**还没有这个区分**。

### 3.3 用户中途介入：只允许两个动作

dsh 的模型是「人在会话里说话 → 消息到达 owning ticket」（`src/core/model.ts` 的 `followupOwners`，整整 20 行判定）。**我们做不了**，因为平台安全模型禁止跨会话投递（ADR-0001 已裁决）。

所以只保留两个合法干预点：

1. **停**：终止某个工单（杀进程 + 记 `STOPPED_BY_USER`）。
2. **答**：回应一个 `NEEDS_DECISION`（把答复作为新的一轮 prompt 投进同一 session）。

**其余一切走新工单。** 理由：任何「中途改需求」如果没有新工单，就没有新的预声明验收标准，验收闸就失去了判定对象——这正好违反 CLAUDE.md 硬约束 4。dsh 允许 attach/handback 是因为它的工单有 Mandate 与 policy 版本可复验；我们没有，就不该开这个口子。

### 3.4 能不能复用 `tasks/runs/`

**能，而且比想象中更合适。** 现状（`tasks/runs/2026-10-30-p0/task-graph.json`）已经有：

- `run_id` / `root_goal` / `constraints[]` / `subtrees[]`
- 每个 subtree 有 `id / goal / capability / shape / timeout_min / why_this_layer / acceptance[{id,criterion,evidence,fail_if}]`
- `scripts/validate-run.mjs` 已经在机械校验它，**且已经实现了 v0 需要的三条检查**：`capability` 必须在 `CAPABILITIES` 枚举内（`validate-run.mjs:31`）、`shape` 必须在 `SHAPES` 内（`:34`）、`acceptance` 必须非空且四字段齐全（`:98–110`）、`fail_if` 非空、`VAGUE` 措辞黑名单（`:42`，`/^可选$/ /^视情况/ /^酌情/ …`）

**要加的三样**（都是字段，不是新机制）：

| 新增字段 | 加在哪 | 为什么 |
|---|---|---|
| `adapter` | subtree | 角色 ≠ harness（已由 skeleton §3.2 裁定）。值形如 `"acpx:opencode"` / `"claude-p:oversight-executor"` / `"native:oversight-acceptor"` |
| `boundary[]` | subtree | 「不许碰什么」。现有四要素缺的正是这一项（研究结论原文：「缺的是『边界』这一项——我们写了产出形态和验收标准，没写『不许碰什么』」） |
| `parent` | subtree | 现在只有 `depends_on` / `parallel_with`，**没有父子关系**，所以「3 层上限」无从校验。加一个字符串字段，`validate-run` 检查链长 ≤ 3 且无环 |

**为什么不改成 SQLite**：`validate-run.mjs` 是纯函数 + 读文件，`check-structure.mjs` 用 `spawnSync('git', …)` 读历史。整条工具链的假设是「状态是可读文本」。**改成数据库会把可审计性换成并发写，而 v0 没有并发写者。**

---

## 四、上下文管理

### 4.1 主 agent 拿到的「任务完成」是什么形状

**三层，缺一不可**：

```
第 1 层：卡片（进父上下文，硬上限 800 字节）
{
  "ticket_id": "T-0003",
  "state": "DONE",                     // DONE | BLOCKED | NEEDS_DECISION | UNKNOWN | TIMEOUT | STOPPED
  "summary": "≤160 字，supervisor 从 report.md 首段截取",
  "changed_files": ["path", "…"],      // ≤10 项，超出只报数量
  "cost": { "usd": 0.0, "tokens": 0, "wall_ms": 0 },
  "read": "tickets/T-0003/report.md"   // 指针
}

第 2 层：report.md（落盘，不进父上下文）
  执行者自由写作。无长度上限。可含代码、日志、推理。

第 3 层：transcript.ndjson（落盘，仅在「调查为什么」时读）
  原始 ACP 事件流。可轮转，默认保留最近 2000 条。
```

**为什么是三层而不是两层**：dsh 是两层（卡片 + `ticket/<id>/result` 指针），因为它的 worker 是自己的 Session，中间过程留在 DSH 的历史里。我们没有那个历史——ACP 事件流是唯一的过程证据，**而它恰恰是 `verify-claims` 需要的东西**（断言与支持它的工具调用配对）。

**关键设计：`report.json`/卡片由 supervisor 写，执行者只能写 `report.md`。** 这是 `evidence-discipline.md` 的直接延伸。dsh 也是这个形状：`orchestrator_report` 的 schema 在 `src/app/tools/executor.ts:75` 强制 `state` ∈ 五值、`summary` 必填、`human_action` ≤1000 字符，`run` 里先 `claimPull` 再 `engine.report` 再 `sessions.relay`，**全在一个事务里**（`:100-115`）。它防的是「报告写了但没送达」与「送达了但报告是假的」两件事。

### 4.2 worker 的完整输出存哪

| 内容 | 位置 | 保留策略 |
|---|---|---|
| ACP 原始事件 | `tickets/<tid>/transcript.ndjson` | 轮转，保留最近 2000 条 + 全文另行压缩存 `<tid>.ndjson.gz` |
| 执行者散文报告 | `tickets/<tid>/report.md` | 永久（v0 一个 run 只有几份，不构成压力） |
| 产物（改动、生成文件） | 由 worker 在自己的 worktree 里写，**不复制** | 只记路径 |
| stderr | `tickets/<tid>/stderr.log` | 保留末尾 64 KB 就够。它比 stdout 有用得多：P2 的 `Authentication required` 就在 JSON-RPC 错误里，而 stderr 是空的 |

**为什么显式保留 stderr**：实测 `acpx claude exec` 的失败**只在 stdout 的 JSON-RPC error 里**，stderr 完全为空（`EXIT=1` 是唯一线索）。而 acpx 自己的实现里 `withStderr()`（`mastra-acp-connection.ts:353` 同款逻辑）会把 stderr 拼到异常消息上——**这说明有经验的实现者都认为 stderr 是必要证据**。我们保留两路。

### 4.3 什么情况下主 agent 才需要看细节

**只有三种**，写死，不做判断：

1. **验收闸判 `REJECT` 且 `repair` 已失败一次**。此时需要一个决定：换策略 / 降级 / 向用户交回。要看 `report.md` 与 diff。
2. **worker 报 `NEEDS_DECISION`**。它给了问题，要看上下文才能答。
3. **用户问「为什么」**。

**明确不看**：任何 `progress`。任何「跑得慢」。任何「看起来不对」。

对照 dsh 的实现：`reportRelay`（`src/app/notices.ts:121`）在 `state === 'progress' && !answers` 时 `return undefined` —— **连 relay 都不生成**，不是生成后过滤。它的 `attention`（结构化提问）反而立刻 relay（`:123-126`）。这是「枚举而非过滤」的完整形态，可直接搬。

### 4.4 上下文预算怎么管（worker 可能产出 100KB）

**四道闸，从便宜到贵**：

| 闸 | 位置 | 参数 | 依据 |
|---|---|---|---|
| 1. 卡片硬上限 | supervisor 生成卡片时 | 800 字节；`summary` 截 160 字；`changed_files` ≤10 项 | dsh 用 600 字符（`notices.ts:110`）与 160 字符预览（`cards.ts:8`），我按字节收得更紧，因为中文 160 字 ≈ 480 字节 |
| 2. 投喂给 worker 的工单文本上限 | 派发时 | 目标 1500 字符、原始触发 600 字符；超出改挂指针 | dsh 完全相同：`src/executor/dsh.ts:113` `ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600` |
| 3. 指针读取预算 | 每次读 `report.md` 记账 | 每个 run 默认 ≤ 8 次「读全文」；分页读默认 4000 字符、上限 8000 | dsh `src/app/resources.ts:87` `limit ?? 4000`；卡片列表 20 条默认 / 50 上限 |
| 4. 预算（token / 钱） | supervisor 从 `usage_update` 累计 | 工单声明 `token_budget_pct`；超 80% 记 `BUDGET_WARN`，超 100% 杀进程判 `TIMEOUT` | ACP `UsageUpdate{used,size,cost}` 是**真实数**（P1 实测 `used:7887, size:200000`），不是估算 |

**第 4 道闸是这次调研最有实用价值的收获。** 本仓现在的预算全是 `est:`（`state-model.md` §7「token 预算的现实边界」明确说「只能用代理指标」）。**ACP 把这个限制拿掉了**：`session/update` 的 `usage_update` 每个 adapter 都会发（opencode 实测发了），MCP 的 `Agent` 结果也给 `totalTokens`（P6）。所以「预算必须声明」（CLAUDE.md #8）从一句愿望变成可执行检查。

---

## 五、与外部 harness 的接口

### 5.1 统一抽象：按能力分三档，不按产品分

```js
// 适配器契约（每个 harness 填一份，不猜）
const ADAPTER = {
  id: 'acpx:opencode',
  tier: 'acp',                    // acp | oneshot | mcp
  spawn: { cmd:'acpx', args:['--format','json','--json-strict','opencode','prompt','-s',SESSION] },
  caps: {                         // 全部来自 initialize 响应，不是假设
    cancel: 'cooperative',        // cooperative | process_only | none
    stream: 'token',              // token | message | none
    usage: 'per_call',            // per_call | session_cumulative | none
    resume: true,
    permission: 'per_tool',       // per_tool | mode_enum | none
    shell: true,
  },
  observe: ev => classify(ev),    // ACP session/update → 我们的五种事件
};
```

三档的实测能力对照：

| | `acp`（acpx） | `oneshot`（`claude -p`） | `mcp`（`claude mcp serve`） |
|---|---|---|---|
| 取消 | 协作式 + 杀进程 | 只有杀进程 | **无**（P10 失败） |
| 流式 | **逐 token**（P1） | 无（`-p` 一次性） | 只有 30 秒心跳（P11） |
| 并发 | 一个 session 串行；多 session 并行 | 天然（一个进程一个活） | **一条连接多路复用**（P9） |
| 用量 | 真实 `usage_update` | 无 | 结果里带 `totalTokens`（P6） |
| shell | 有 | 有 | **本机坏**（P8） |
| 实测延迟 | 80.4 s（首轮含冷启动） | 39.3 s | `initialize` 9.4 s + 调用 23.9 s |

**这不是三选一，是三条用途不同的通道**：`acp` 干执行（要流式、要取消），`oneshot` 干批处理（要简单、要能并发），`mcp` 干纯推理（要便宜、能多路复用）。

### 5.2 能力协商：读 `initialize`，别假设

ACP 的 `initialize` 响应结构（`acp-schema.json` `$defs.InitializeResponse`）：

```
agentCapabilities:
  loadSession          bool
  promptCapabilities   { image, audio, embeddedContext }
  mcpCapabilities      { http, sse }
  sessionCapabilities  { list, delete, additionalDirectories, systemPrompt, resume, close }
  auth
```

P1 实测 opencode 声明：`{loadSession:true, mcpCapabilities:{http:true,sse:true}, promptCapabilities:{embeddedContext:true,image:true}, sessionCapabilities:{close:{},fork:{},list:{},resume:{}}}`。

**规则**：**每一个可选调用前先查 it advertised**。三处必须查：

1. 想传 `systemPrompt` → 必须 `sessionCapabilities.systemPrompt` 存在。schema 原文：「Clients **MUST only** send this when the Agent advertises `sessionCapabilities.systemPrompt`」。传了不支持的会直接报错，不是静默忽略。
2. 想 resume → `sessionCapabilities.resume`；想 `loadSession` → `agentCapabilities.loadSession`。
3. 想穿 MCP 服务器 → `mcpCapabilities.http/sse` 分别门控。

OpenHands 的实现是范本（`openhands-sdk/openhands/sdk/agent/acp_agent.py:3355-3385`）：它把 `session_caps.additional_directories` 存成 `self._additional_directories_supported`，后续每次要不要传这个字段都查它。**不是 try 一下看报不报错。**

对不支持某能力的 harness：**降级而不是失败**，且降级要记账。

| 缺什么 | 降级动作 | 记什么 |
|---|---|---|
| `sessionCapabilities.resume` | 每轮新 session，靠 `report.md` 传递上下文 | `degraded: ["no_resume"]` |
| `usage_update` 缺失 | 回到 `est:` 估算，标注 `estimated: true` | 不许像现在这样把估算当精确值 |
| 不能结构化提问（no `request_permission` 之外的 elicitation） | 用 `NEEDS_DECISION` + 文本问题 | — |
| 连 `session/update` 都不发（只有最终结果） | 判为 `oneshot` 档，只接受终态 | `stream: none` |

### 5.3 权限模型：不统一，映射

**结论：不要试图做一个「统一权限模型」。** 三个 harness 的机制在语义上就不等价：

| harness | 机制 | 粒度 | 事实 |
|---|---|---|---|
| ACP | `session/request_permission` 反向请求；client 侧 `--approve-all/--approve-reads/--deny-all` + `--permission-policy` 逐工具策略 | **逐次工具调用** | acpx `docs/permissions.md`：`autoApprove / autoDeny / escalate / defaultAction`，优先级 `autoDeny → autoApprove → escalate → defaultAction → mode` |
| Claude Code | agent frontmatter 的 `tools:` 精确白名单 + `--permission-mode` | **会话级，静态** | 本仓 12 个角色就是这么做的；`check-structure.mjs` 强制只读角色不得含 `Edit/Bash` |
| OpenHands | `permission_mode` ∈ `always_confirm / never_confirm / confirm_risky`（`subagent/schema.py:43-46`）+ ConfirmationPolicy 类族 | **会话级，三值** | `security/confirmation_policy.py` 有 `AlwaysConfirm / NeverConfirm / ConfirmRisky` |
| MCP | 没有 | — | P10 已经证明连取消都没有 |

**做法**：Overwatch 只定义 **3 个策略档**，每档映射到各 harness 的具体配置：

```
read-only        → ACP: --deny-all + autoApprove:["read","search"]
                    Claude: tools: Read, Grep, Glob
                    OpenHands: never_confirm 但 tools 只有只读

workspace-write  → ACP: --deny-all + autoApprove:["read","search","edit"]，execute 走 escalate
                    Claude: tools: Read, Write, Edit, Glob, Grep
                    OpenHands: confirm_risky

full             → ACP: --approve-all
                    Claude: tools: *（仅 executor / repair）
                    OpenHands: never_confirm
```

**同时必须记两件事**（否则会重演「以为能自动接力」的错）：

1. **`escalate` 在非交互模式下的实际行为是「拒绝当前轮」**（acpx `docs/permissions.md` 原文：*"In non-interactive output, an escalated request is **denied for the current turn**"*）。所以我们不能靠 escalate 做「问用户」，只能靠 `NEEDS_DECISION` 事件。
2. **这些全是默认值，不是安全边界。** dsh 自己写死了这句（`docs/003-execution.md:80`）：*"These wrappers and directories establish **defaults, not a security boundary**. A worker can still execute a program by absolute path."* 而它的两个 preset 都是 `danger-full-access`（`docs/006-deployment.md:19`）。**我们能承诺的是「记录它做了什么」（transcript.ndjson + `request_permission` 事件），不是「阻止它做什么」。**

---

## 六、零依赖要不要破

### 6.1 自己写会痛在哪（按痛度排序）

| 件 | 自己写的成本 | 证据 |
|---|---|---|
| **ACP client** | **很痛，不建议** | acpx 43,753 行里，`src/acp/client.ts` 单文件 2,871 行、`terminal-manager.ts` 880 行、`client-process.ts` 337 行。这些行数不来自协议本身（NDJSON + JSON-RPC，`ndjson-stream.ts` 只有 166 行），来自**边角**：Windows 下 `.cmd` 需要 shell、pid 复用检测、进程后代清理、8 秒预算、错误归一化、conformance 测试 |
| **MCP client** | **中等偏痛** | 官方 SDK 的 peer deps 是 `zod` + `@modelcontextprotocol/server`。OpenHands 的 `mcp/client.py` 只有 330 行，但它是 `class MCPClient(AsyncMCPClient)`——**薄封装在 fastmcp 上**，不是从零写。自己写全 MCP 要处理 transport 协商、capability、通知、以及 stdio 子进程的生命周期 |
| 流式 NDJSON 解析 | **很轻** | 60 行足够（按 `\n` 切、`JSON.parse`、按 `id`/`method` 分派）。本机已有可用参考：`.tmp-analysis/acp-probe.mjs` 就是 60 行左右跑通的 |
| 进程管理 + 取消 | **中等** | 三级取消（notify → 关 stdin → kill）+ 后代清理。acpx 的 `docs/runtime-process-lifecycle.md` 说明了每一处陷阱 |
| 事件 → 状态的判定 | **不痛，应该自己写** | 这是我们独占的部分，且是纯函数 |
| 验收闸 | **不痛，应该自己写** | 同上 |

### 6.2 什么必须买

**只有一样：ACP 协议的实现。而且买的方式是「用二进制」，不是「装包」。**

具体：`acpx` 已经在 `PATH` 上（本机 0.22.0，`acpx --version` 正常），我们通过 `child_process.spawn` 调它，读它的 **`--format json --json-strict` 输出**。acpx 的文档明确保证这个格式**不加壳**：

> *"No acpx-specific event envelope wrapping ACP messages. No synthetic `type` / `stream` / `eventVersion` keys injected onto raw ACP traffic. No payload key renaming. What you read on stdout is the same wire-level JSON that would have crossed the ACP transport."*（`docs/output-formats.md`）

也就是说：**我们得到的是裸 ACP wire JSON，而依赖是零。** 这是这次调研在工程上最有价值的一条——它让「买协议」与「零依赖」不再是互斥选项。

### 6.3 破零依赖的代价

| 代价 | 具体 |
|---|---|
| **分发形态变了** | 现在 `git clone && node scripts/x.mjs` 直接跑（README「30 秒上手」）。有 `package.json` 后最少三步：`npm i` / 可能的 postinstall / 版本锁定。**这会把「配置库」变成「应用」**，而 ADR-0001 裁决的是前者 |
| **审查面变了** | `check-structure.mjs` 现在只查自己的 38 个脚本（`checkSyntax` 用 `node --check` 一次查完，实测 1.5 秒/6 文件）。有 `node_modules` 后，`node --test scripts/*.test.mjs` 的 42 秒基线会被依赖加载拖长，且硬门要开始考虑「依赖树里有什么」 |
| **供应链** | acpx 依赖 `zod ^4.6.7` / `commander ^15` / `tsx` / `@openclaw/fs-safe` / `@agentclientprotocol/sdk ^1.9`。而官方 SDK 的 peer 是 `zod ^3.25 \|\| ^4`。**这台机器上 `claude-agent-acp` 跑不起来的已记录原因就是 zod/v4 的 ESM 目录导入 bug**——这不是假设，是事故 |
| **Windows** | acpx 需要 `node >= 22.13`；本仓声称 Node ≥ 18 就够。引它作为 npm 依赖会直接抬高门槛 |

### 6.4 定案

```
v0：零依赖不动。
    - 不建 package.json。
    - acpx 当外部进程，spawn 它的二进制。
    - 只写 60 行 NDJSON 分派器（如果连 --format json 都不够用的话；目前看够用）。

触发重新评估的明确条件（不是「视情况」）：
    a) 需要 in-process 的 ACP runtime（例如要做 mid-turn 干预）——
       那时答案是「新建一个独立的 npm 包」，不是「污染 Overwatch 仓库」。
    b) acpx 的 stdout 开始混入非协议输出（它有 --json-strict 挡，但 pre-1.0 会变）。
       那时把 acpx 调用封在 scripts/harness-acpx.mjs 一个文件里，换实现只改一个文件。
    c) 需要 MCP client 的能力超过「一次性调 Agent」。MCP 目前在 P8/P10 上有硬缺陷，
       短期内不会成为需求。
```

---

## 七、参考实现的架构拆解

### 7.1 `deepseek-ai/dsh-superagent-prototype`（用户指定参考）

**规模**：`src/` 12,390 行 / 113 文件。分四层，**依赖方向单向**：

```
src/core/       15 文件  2,103 行   纯领域模型 + Engine。零 IO、只 import node:crypto
src/app/        38 文件  5,330 行   组合根 + 工具 + 卡片 + 队列 + 存储 + 视图
src/executor/    2 文件    840 行   唯一碰宿主 Agent API 的地方
src/sources/    16 文件  2,075 行   外部输入（GitHub / Feishu），可做成插件
src/infra/       5 文件    352 行   health / commands / environment / paths / text
src/client/      8 文件  1,230 行   前端（React），与后端解耦
```

**模块边界怎么画的**（这是最值得抄的一点）：

- `src/core/ports.ts:106` 定义 `Repositories`，**所有方法同步**，这样 `atomic<T>(work)` 能包住一个工作单元。原文注释：「Every method is synchronous so `atomic` can wrap a unit of work.」
- `src/core/engine.ts:24` 是**唯一写者**，且 `Engine` 的所有方法都是同步的；每个命令一个事务。`evaluateDue` 对每个 Eval 单独开事务。
- `src/core/ports.ts:59` 的 `Executor` 只有三个方法：`start / deliver / stop`，且**三个都只入队**。真正的执行在 `src/executor/dsh.ts`。这就是「编排是纯函数、执行是副作用」的物理形式。
- 角色化视图：`EngineForSources / EngineForMainSession / EngineForExecutor / EngineForSettings`，每个调用方只拿到自己那个 `Pick`。

**错误隔离怎么做**（三层，每层解决不同的失败）：

1. **持久化效果队列**（`src/app/effects.ts:46`）。每个 kind 一个 handler，带 `limit()`（并发上限）、`retry: [初始, 上限]`（指数退避，`attempt` 里算 `min(max, init * 2^attempts)`）、`ordered`（同一 kind 严格串行）。关键设计：`Later` 异常（`effects.ts:5`）——**「现在跑不了」不算失败，不递增 attempts**，只是推后。这样「worker 槽满了」和「adapter 真的挂了」被分开计账。
2. **worker 槽位**（`src/executor/dsh.ts:171` `WorkerSlots`）。1–16 个（`src/limits.ts:6`）。**同步预留**：`reserve()` 在 await 之前就占住，防两个 start 抢最后一个槽。人说一句可以多占一个（`by === 'person'`）——保证人的消息永远不排在新任务后面。
3. **后台工作与 turn 分离**（`src/executor/background.ts`）。`untilQuiet` 等 worker 的 shell job 与 subagent 都结束才算 idle；`killJobs` 逐个收集结束事件以免「杀完后 worker 被自己的 job 结束事件唤醒」。

**上下文怎么管**：见 §4。四个数字：600（relay 截断）、160（卡片预览）、4000（分页读默认）、10/3（列表条数，`cards.ts:36`）。还有一个更巧的：准入评估的上下文窗口（`src/sources/admission-context.ts:6-17`）——首 5 条 + 触发点前后各 5 条，**并且显式记账省略了多少条**（`omitted_before` / `omitted_after`）。**截断不记账 = 读者不知道信息缺了。**

**重启恢复**：`src/executor/dsh.ts:524` `resume()`。三种情况：running → 先停掉本进程内的残留（`cancel({keepInbox:true})`）、调 `assignmentInterrupted`；pending → 重新入队；失败 → 等人。恢复提示是一段固定文本（`RECOVERY_NOTE`，`:34`）：「The host restarted during this ticket. Inspect the current worktree, git history and GitHub state before continuing. **Do not repeat an already completed external operation.**」

**不能抄的**：它的 `danger-full-access`（`src/app/sessions.ts:152`）、它的 10 个特权 API（`sessionController.create` / `tools.restrict` / `steer` / `cancel` / `guard`）——ADR-0001 已裁决我们没有。

### 7.2 Mastra `@mastra/acp`

**规模**：6 个文件，约 950 行。**它是 shim，不是架构**，但它的分层顺序值得抄：

```
connection.ts  431 行  spawn 子进程 + initialize + session/new + prompt + promptStream + cancel + disconnect
agent.ts       380 行  实现 Mastra 的 SubAgent 接口，把 stream 包成 Mastra 的 ChunkType
session.ts     720 B   一个 ACPToolSession：持一个 connection，persistSession 开关
tool.ts         —      createACPTool：把 AcpAgent 包成一个普通 tool
types.ts        —      配置类型
index.ts        —      导出面
```

**三个可抄的点**：

1. **取消的三级降级**（`connection.ts:149-240`）：`promptStream` 里挂 `AbortSignal`，触发时调 `cancel()`（发 ACP notify），再 `queue.throw()`；`disconnect()` 里 `agentProcess.kill()`。**两层都要有**，因为 ACP 的 cancel 是协作式的。
2. **提前失败的判定**（`connection.ts:345` `throwIfPromptDidNotComplete`）：`stopReason !== 'end_turn'` 就抛。**这正好是我们要的那条规则**——`cancelled` / `max_tokens` / `refusal` 都不是「完成」，不能当 DONE。
3. **持久 session 的开关**（`session.ts`）：`persistSession === false` 时每次新建连接，否则复用。

**两个必须避开的缺陷**：

1. **usage 恒零**（`agent.ts:342` 与 `:369` 硬编码 `{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }`）。它拿到了 `session/update` 的 `usage_update` 但没有映射。**我们绝不能这样**——预算闸（§4.4 第 4 道）依赖真实数。
2. **`generate()` 与 `stream()` 不一致**：`generate()` 返回 `toolResults: []`（`:111`），`stream()` 却在 `:163` 收集了 tool results。同一个对象两种行为。**验收闸如果要看「执行者跑了哪些命令」，只能走 stream**——这种暗坑是薄封装的典型代价。

### 7.3 OpenHands 的 agent 运行时

**规模**：`openhands-sdk` 85,944 行。它是三者里唯一**既有自己的 agent runtime、又能驱动别人的 agent**的（`acp_agent.py` 5,090 行）。

**模块边界**：

```
agent/            LLM 循环（base.py 1,077 行）+ ACP 适配（acp_agent.py 5,090 行）+ 并行工具执行（357 行）
conversation/     EventLog（只增、带文件锁）+ ConversationState（可持久化）+ CancellationToken + StuckDetector
tool/             注册表 + schema + executor
context/          Condenser 管线（token 压力 / 事件数 / 显式请求三种触发）
subagent/         注册表 + Markdown frontmatter schema + 权限范围
workspace/        本地 / 远程 / Docker
```

**错误隔离的四层**：

1. `CancellationToken`（`conversation/cancellation.py`）——**故意不是 asyncio 原语**，注释写明「it must be usable from both the event-loop thread and thread-pool workers」。并行工具执行时能让 pending 的调用短路。
2. `StuckDetector`（`conversation/stuck_detector.py:29`）——五种卡死模式（action-observation 循环、action-error 循环、独白、交替模式、上下文窗口溢出），阈值默认 4 次（`types.py:150`）。**这是「判定是否在原地打转」的可执行版本**，比我们的 novelty 更直接。
3. `ParallelToolExecutor`（`agent/parallel_executor.py:47`）——每实例自己的线程池与 `ResourceLockManager`，注释明说「nested execution (e.g., subagents) **cannot deadlock** the parent」。
4. 持久化：`ConversationState.persistence_dir`（`state.py:103`）→ `EventLog`（`event_store.py:44`，append-only + `.eventlog.lock` + 长度 sidecar marker）。`TaskManager` 给每个子任务在**父的持久化目录下开了子目录**（`_SUBAGENTS_DIR = "subagents"`，`task/manager.py:47`），父不持久化才用临时目录并在 close 时删（`:510-523`）。

**上下文怎么管**：`CondenserBase`（`context/condenser/base.py:16`）—— `condense(view) -> View | Condensation`。`get_condensation_reasons` 判三种触发：显式请求 / token 超限（**硬要求**）/ 事件数超限（**软要求**）。`PipelineCondenser` 串联。关键设计：**token 压力是硬要求，事件数是启发式**（`:190-200`），因为「发下一次请求可能直接失败，而事件数只是历史管理」。

**跨进程所有权**：`openhands-agent-server/openhands/agent_server/conversation_lease.py` —— `owner_lease.json` + `filelock`，`DEFAULT_LEASE_TTL_SECONDS = 45.0`，含 `owner_host` / `owner_pid`，用 `os.kill(pid, 0)` 判活，**「拿不准就当作还活着」**（`:44` 注释原文）。这是「崩溃后谁来接管」的标准答案，可直接搬。

**它做的两件我们不认同的事**：

1. **`request_permission` 一律自动批准**（`acp_agent.py:1791`：*"Auto-approve all permission requests from the ACP server."* 取 `options[0]`）。对「headless bridge」合理，对我们等于放弃验收闸的第一道防线。
2. **`TaskManager.start_task` 是阻塞的**（`task/impl.py:20` 类注释明写 "blocking only"）。父 agent 在等子 agent 期间不能做别的。**这正好是我们用进程边界要避免的**——我们的 supervisor 在 worker 跑的时候必须是自由的。

---

## 八、推荐架构（一口气说完）

```
scripts/
├─ org.mjs                   CLI 入口：run / resume / status / stop
├─ org/
│  ├─ ledger.mjs             run.json + events.ndjson 读写（复用 watch.mjs 的原子替换）
│  ├─ ticket.mjs             工单 schema + 校验（扩 validate-run.mjs，不新写）
│  ├─ spawn.mjs              spawn / 三级取消 / 孤儿清理 / stdio 生命周期
│  ├─ adapters/
│  │   ├─ acp.mjs            调 acpx，解析裸 ACP NDJSON；能力表来自 initialize
│  │   ├─ oneshot.mjs        调 claude -p；只能拿终态
│  │   └─ mcp.mjs            调 claude mcp serve；只做推理，禁止执行
│  ├─ classify.mjs           ACP 事件 → 五态（DONE/BLOCKED/NEEDS_DECISION/UNKNOWN/TIMEOUT）
│  ├─ card.mjs               报告 → 800 字节卡片（纯函数，可单测）
│  └─ gate.mjs               验收闸：调 acceptor 子进程，读 verdict，负向测试
└─ org.test.mjs              纯函数的测试；spawn 相关用假 adapter
```

**七个不变量**（每一条都能被一条测试钉住）：

1. `report.json` 只由 supervisor 写，执行者进程对 run 目录**无写权限**（adapter 的 cwd 指向 worktree，不是 run 目录）。
2. `UNKNOWN` 不可被任何代码路径转成 `DONE`。
3. 一个 worker 的取消必须有 ≤ N 秒的硬上限（三级取消超时后一律 kill）。
4. 父 agent 的输入里，单个工单的字节数 ≤ 800，且 `read` 指针存在。
5. 预算来自 `usage_update`；取不到时标 `estimated: true`，**不许冒充精确值**。
6. 每个可选 ACP 调用前查 `initialize` 声明的能力，缺则降级并记账。
7. 任何 `progress` 事件不得进入父上下文（枚举里没有这个值）。

**与 skeleton §4 的「最小链路」的关系**：那条链路的判据（`node scripts/org.mjs run "…"` 退出码 0 + 五个文件非空 + verdict 逐条 AC）**仍然成立**。本报告在它下面加的是：进程边界、状态文件形状、卡片 schema、能力协商、预算来源。**没有一条要求改那条判据。**

---

## 九、反面证据与未知项

### 9.1 反对本报告最强的一条

**「你测的 80 秒 / 39 秒 / 24 秒，加起来证明不了这条链路能跑真实任务。」**
成立。P1 的 prompt 是「Reply with exactly: PONG」，除了协议握手什么都没验证。一次真实的 executor 任务（读代码、改文件、跑测试）在这台机器上会是什么耗时、会不会在 5 分钟处撞上某个 adapter 的默认超时，**完全未测**。
缓解不了的唯一办法是：**v0 的第一件事就是跑一次真实的 12 分钟任务，并把实际耗时写进 README**。T1 的判据必须包含「按真实任务重测」。

### 9.2 反对「不用 MCP 当派发通道」的证据

P9 证明 MCP **能**一条连接并发多个 Agent，这是 ACP 做不到的（一个 session 串行）。如果真实需求是「一次派 8 个纯推理 worker 做交叉验证」，MCP 可能更合适。
**但**：并发只对「不需要取消、不需要流式、不需要 shell」的任务有价值，而那正好是推理任务的形状。所以本报告的立场是「MCP 干推理、ACP 干执行」，不是「弃用 MCP」。

### 9.3 未知项

1. **P8 的 pwsh 失败是不是普遍**。一次样本。若普遍，`claude mcp serve` 连「推理 + 读文件」都勉强（它能 Read / Grep / Glob，所以恰好够做 acceptor）。
2. **P10 的 `TaskStop` 失败是否因为 `name` 不是 `task_id`**。schema 里 `TaskStop` 有两个参数 `task_id` / `shell_id`，而 `Agent` 的名称参数叫 `name`。可能后台 agent 的 id 只有完成时才知道——P6 的返回里确实有 `agentId`。**没试过用已知的 `agentId` 去 stop**（因为调用是阻塞的，拿不到它）。这是本报告最大的一个未验证假设。
3. **acpx 的 `--permission-policy` 真实生效未验证**（§1.3）。
4. **没验证「多工单并行」在 ACP 下的实际行为**。acpx 的 session 是 `(agentCommand, cwd, name)` 三元组，理论上不同 `name` 就是不同 session、可并行。但 `--ttl 300` 的 queue owner 是每 session 一个进程还是共用一个，没测。
5. **`claude -p` 在剥环境变量后能工作，但 39 秒的构成不知**。是冷启动、网关、还是模型？如果全是冷启动，那长任务的边际成本会低得多——这直接影响适配器选择。

---

## 十、复现方式

```bash
# 克隆三个参考实现
git clone --depth 1 https://github.com/deepseek-ai/dsh-superagent-prototype.git .tmp-analysis/dsh-ref
git clone --depth 1 https://github.com/OpenHands/software-agent-sdk.git            .tmp-analysis/sa2/oh-sdk
git clone --depth 1 https://github.com/openclaw/acpx.git                          .tmp-analysis/sa2/acpx

# P1：ACP 端到端（80.4 秒，拿到 usage_update 与 stopReason）
printf 'Reply with exactly: PONG\n' > /tmp/p.txt
acpx --format json --json-strict opencode exec --file /tmp/p.txt

# P2：claude 适配器（失败，Authentication required）
acpx --format json --json-strict claude exec --file /tmp/p.txt

# P12/P13：claude -p 的环境敏感性（这条最能说明「退出码不是结论」）
env -u CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST -u CLAUDE_CODE_HOST_AUTH_ENV_VAR \
    -u CLAUDE_CODE_HOST_SESSION_ID -u CLAUDE_CODE_MESSAGING_TOKEN \
    -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDECODE -u ANTHROPIC_BASE_URL \
    claude -p --model haiku "Answer with exactly one word: PONG"     # → PONG, exit 0, 39s
claude -p --model haiku "Answer with exactly one word: PONG"          # → Not logged in, exit 1

# P3–P11：MCP 通道的探针（脚本落在 .tmp-analysis/sa2/ 与 /tmp，未进仓库）
node .tmp-analysis/sa2/mcp-probe3.mjs       # initialize 9.4s + tools/list 202ms + 23 工具
node .tmp-analysis/sa2/mcp-agent-call2.mjs  # Agent 调用成功，返回结构化 JSON
node .tmp-analysis/sa2/par3.mjs             # 并发两个 Agent + TaskStop 失败
node .tmp-analysis/sa2/prog2.mjs            # progressToken → "Running for 30s" 心跳
node .tmp-analysis/sa2/acc.mjs              # oversight-acceptor 无 Bash（经 MCP 复现审计结论）
```

**最值得点进去的八个文件**：

| 想看什么 | 看哪 |
|---|---|
| 「编排是纯函数、执行是副作用」的物理形式 | `dsh-ref/src/core/ports.ts`（Executor 三方法 + 同步 Repositories）、`dsh-ref/src/core/engine.ts` |
| 上下文纪律的四个数字 | `dsh-ref/src/app/notices.ts:110`（600）、`cards.ts:8`（160）、`resources.ts:87`（4000）、`executor/dsh.ts:113`（1500/600） |
| 「progress 不转发」的原型 | `dsh-ref/src/app/notices.ts:127`（`return undefined`） |
| 崩溃恢复的三种情况 | `dsh-ref/src/executor/dsh.ts:524`（`resume()`）+ `RECOVERY_NOTE`（`:34`） |
| 持久化效果队列（重试/并发/`Later`） | `dsh-ref/src/app/effects.ts:46` |
| 能力协商该怎么做 | `oh-sdk/openhands-sdk/openhands/sdk/agent/acp_agent.py:3355-3385` |
| 「什么时候该接管别人留下的会话」 | `oh-sdk/openhands-agent-server/openhands/agent_server/conversation_lease.py` |
| 薄封装的三个坑（usage 恒零 / generate 与 stream 不一致 / 阻塞式 subagent） | `mastra-acp-agent.ts:111,342,369`、`oh-sdk/openhands-tools/openhands/tools/task/impl.py:20` |
