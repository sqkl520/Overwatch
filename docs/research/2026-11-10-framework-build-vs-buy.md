# Agent 框架：买还是造？——现成方案的逐项对照

> 日期：2026-11-10
> 角色：检索 Agent FR1 · 产出形态：**exploration**（调研笔记，不是实施计划）
> 命题（用户原话）：**Overwatch 要做 agent 框架，为什么不直接用现成的？如果答不出，那这个框架就不该造。**
> **未修改 Overwatch 任何代码，未碰 git，未跑全量测试。**

---

## 覆盖声明（按 `docs/spec/evidence-discipline.md` §4）

**实际读了一手文档 / 源码的**（GitHub API 取原文，落盘在 `.tmp-analysis/`，已 gitignore）：

| 来源 | 读了什么 |
|---|---|
| Mastra `@mastra/acp` | `agent-sdks/acp/README.md`、`src/{agent,connection,tool,types,session,index}.ts` 全文（约 950 行）、`docs/src/content/en/docs/connections/acp.mdx`、`reference/acp/{acp-agent,create-acp-tool}.mdx`、`docs/subagents.mdx`（570 行）、`docs/guides/multi-agent-systems.mdx`、`docs/harness/overview.mdx`、`docs/evals/gates-and-verdicts.mdx`、changelog |
| ACP 规范 | `agentclientprotocol/agent-client-protocol` 的 `schema/v1/schema.json`（265 KB，183 个 `$defs`），逐项查过 `NewSessionRequest` / `SessionCapabilities` / `SystemPrompt` / `SessionMode` / `AgentCapabilities` / `ClientCapabilities` |
| ACP SDK | `agentclientprotocol/python-sdk` README、目录结构；`@agentclientprotocol/sdk` 的 npm 元数据（peer deps、exports） |
| Claude ACP 适配器 | `agentclientprotocol/claude-agent-acp` README、`src/new-session-meta.ts`、`docs/{air-extensions,model-configuration}.md`、`src/tests/v1/create-session-options.test.ts` |
| acpx | `README.md`、`docs/{permissions,output-formats,session-control,custom-agents,VISION}.md`、`package.json` |
| OpenClaw（39.4 万★，acpx 的母项目） | `README.md`、`VISION.md`、`docs/tools/acp-agents.md`、`docs/tools/subagents.md`、`docs/concepts/{multi-agent,delegate-architecture,parallel-specialist-lanes}.md`、`docs/automation/standing-orders.md` |
| pydantic-ai harness | `docs/harness/{index,acp}.md`、`src/pydantic_ai_harness/experimental/acp/_adapter.py` 头部 |
| LangChain deep agents | `libs/acp/README.md` |
| AutoGen | `README.md`（含 archived 声明） |
| Microsoft Agent Framework | `README.md` |
| OpenAI Swarm | `README.md`（含 replaced 声明） |
| 其他 | 各框架 GitHub 元数据（star / license / pushed_at）、PyPI / npm 版本与下载量、Hacker News Algolia（`Ask HN: Are you using an agent orchestrator to write code?` 即 46993479，60 条评论全文） |

**本机既有材料**（不重复验证，只引用）：`docs/research/2026-11-04-external-harness-protocols.md`（ACP 实测、acpx 端到端、dsh 与 opencode 驱动）、`2026-11-04-orchestration-patterns.md`（10 系统进度通道对照、MAST、Magentic-One 消融）、`2026-11-04-competitive-landscape.md`（竞品与 Cognition 两篇）、`docs/design/2026-11-10-agent-framework-skeleton.md`（框架雏形设计）。

**没做**：
- **没有安装或运行任何框架**。Mastra / LangGraph / Agent SDK 一行代码都没跑。所有「能/不能」判断来自源码与文档语义，不是实跑。
- 没有实测 `@mastra/acp` 驱动 `claude-agent-acp` 或 dsh（本机既有的 acpx→opencode 实测不等于 Mastra 实测）。
- 没有做任何「自己写编排层」的实验，所以「自己写的代价」一节的人月估算是**推算，不是实测**。
- 没有读 Mastra 全部文档（只读了 ACP / subagents / harness / evals 四块），其余能力面可能低估或高估。
- **没有找到「自己写编排然后失败」的第一手复盘**。这一条我尽力了：HN Algolia 四个查询、WebSearch 四个查询、GitHub 仓库搜索，均无匹配。见 §6.3。

**方法学限制**（必须先说）：
- GitHub code search 的 `acp` 关键词命中大量假阳性（`capacity`、`Changelog` 之类）。本文凡说「某框架不支持 ACP」，都对 `agentclientprotocol` 这个全词做过二次核对；`crewAI` 的 170 条 `acp` 命中经逐条查看全是 changelog 噪音，`agentclientprotocol` 命中数为 **0**。
- star 数、下载量只能当量级看，不能当成熟度证据（`2026-11-04-external-harness-protocols.md` §8.1 已就 dsh 的 277k★ 提出过同类警告）。
- 「2026 年新出现的框架」这一项，我能给的最强答案是 **Mastra** 与 **OpenClaw**——两者都不在任务给的清单里，但都比我预想的更接近需求。见 §3。

---

## 一、结论先行

**1. 结论是「混合」，但不是五五开：核心编排层自己写，且必须自己写；驱动外部 harness 的那一层必须买（用 ACP + 现成 client），一行协议代码都不要自己写。**
判据不是偏好，是一条可证伪的结构事实：**在主流编排框架里，只有一个（Mastra）是围绕 ACP 设计过接入的**。LangGraph / CrewAI / AutoGen / OpenAI Agents SDK / Google ADK / Microsoft Agent Framework / Strands / smolagents 对 `agentclientprotocol` 的命中数全部为 **0**（§4 表）。它们的 worker 是「同进程里的一次 LLM 调用」，我们的 worker 是「别人机器上、别人权限模型里的一个 CLI 子进程」。这中间的差别不是适配器能补的，是两套生命周期所有权。

**2. 但「没有框架支持 ACP」这个说法已经不成立了，有一个例外，而且是决定性的：Mastra。**
`@mastra/acp` 是一个**一等公民包**（不是示例代码），把任意 ACP agent 包装成 Mastra 的**工具**或**子 agent**，支持流式 `agent_message_chunk` → `text-delta`、`tool_call`/`tool_call_update` → `tool-call`/`tool-result`、`onPermissionRequest` 回调做审批、`persistSession` 跨调用保活、`createClient` 注入扩展方法。官方文档里直接给了 Claude Code 的接法（`npx @agentclientprotocol/claude-agent-acp`）和 OpenCode / Gemini CLI / Cline 的启动命令表。月下载 **64,561**。
**所以正确的问题不是「要不要用框架」，而是「Mastra 已经覆盖了多少，剩下多少必须自己写」。** 这是本次调研对原命题的最大修正。

**3. 剩下那部分，Mastra 恰好不覆盖，而且不是「还没做」，是「设计上不做」——它覆盖的是「派活」，不覆盖「判活」。**
Mastra 有一等公民的 evals（`gates` / `scored` / `passed` 三态判词、`checks.calledTool`、CI 强制），但那是**对你自己 agent 的输出做离线评分**，输入是数据集，不是「别人进程交回来的工单，配一份预声明 AC」。Mastra 的 `onDelegationComplete` 允许你替换父模型看到的文本（`resultText`）、允许 `bail()`、允许 `feedback`——**这是「给结果加注解」，不是「一票否决」**。换句话说：**Mastra 能帮你把活派出去并漂亮地收回来，但「AI 说它做完了」这件事它不管。** 而那正是 Overwatch 唯一被真实痛点验证过的差异（README §「唯一站得住的差异」）。
同理，ACP 协议本身**没有工具白名单字段**（我逐项查过 183 个 `$defs`：`allowedTools` / `toolAllowlist` / `toolsWhitelist` 均不存在），工具裁剪只能通过各 harness 私有的 `_meta` 通道做（`claude-agent-acp` 认 `_meta.claudeCode.options.tools` / `disallowedTools` / `maxBudgetUsd` / `maxTurns` / `settings`，见其 `src/new-session-meta.ts` 与 `src/tests/v1/create-session-options.test.ts`）。**这层私有约定必须自己写，任何框架都不会替你写。**

**4. 「自己写全部」是错的，「用框架 + 自己补 ACP 驱动」也已经过时——正确形态是「用一个 ACP-aware 的框架（Mastra 或 acpx 裸用）+ 自己写三件它不管的事」。**
那三件是：**工单 schema（预声明 AC 是字段不是 prompt）**、**三事件汇报协议（DONE / BLOCKED / NEEDS_DECISION，无 progress）**、**验收闸（干净上下文的 acceptor，一票否决，与执行者零共享）**。这三件在本仓已有 spec 与 12 个角色定义，是**已付成本**，换框架等于重写。**规模估算（推算，非实测）：约 2 个脚本 + 3 份 markdown 的增量，不是一个人的半年。** 详见 §5.3。

**5. 决定性的否决理由不是「框架不够好」，是「用户要的那个东西不在任何框架的命题里」。**
现成框架的命题是「让多个 agent 协作完成一次任务」。用户要的命题是「围绕一个用户，把目标切成工单、派给不是自己的进程、把回收的东西判成过/不过/不知道」。前者 2026 年已经饱和（LangGraph 44.7k★、CrewAI 60.7k★、AutoGen 61.8k★ 且**已归档**、OpenAI Agents SDK 30.6k★、MAF 14.6k★、ADK 22.2k★、Mastra 29.4k★），后者**一个都没有**。
**但这条必须诚实标注**：它成立的前提是「验收闸真的比 exec 自评有效」。这个前提目前只有 Cognition 的二手中介证据（干净上下文 review agent 每 PR 抓 2 个 bug、58% 严重）与本仓 `verify-claims.mjs` 的 84.6% 精度小样本。**如果这个前提不成立，整个框架就该砍掉，退回去用 Mastra + 人工 review。** 该前提的检验方式已写在 `2026-11-10-agent-framework-skeleton.md` §5 T5，本次不重复。

---

## 二、框架清单：定位、成熟度、心智负担

数据取自 GitHub API（2026-11-10）与 PyPI / npm。**「能否驱动外部 CLI agent」一列以 `agentclientprotocol` 全词命中为准**，附二次核对。

| 框架 | 定位 | 成熟度（可核） | 心智负担 | 驱动外部 CLI agent（ACP） | 能否做「带验收的对抗结构」 |
|---|---|---|---|---|---|
| **LangGraph** | 图/状态机编排，"resilient agents" | 44,734★，MIT，PyPI `1.2.20`，285 个 release，日更 | **高**。图、状态、checkpointer、subgraph、supervisor 包各自一套概念；本仓既有研究已记录「节点数上去后拓扑爆炸」（第三方博客，未交叉验证） | ❌ `agentclientprotocol` 命中 **0** | 结构上能做（图里放一个 acceptor 节点），但 AC、证据、一票否决全要自己写 |
| **AutoGen**（微软） | 对话式多 agent | 61,770★，**已归档、官方明说不再维护**，CC-BY-4.0 | 中高（GroupChat 全广播） | ❌ 命中 0 | 能做对话式评审；但**不该选一个归档项目** |
| **CrewAI** | 角色扮演 + 流程 | 60,715★，MIT，PyPI `1.15.39`，505 个 release，日更 | **低**（角色/task 心智最轻） | ❌ `agentclientprotocol` 命中 **0**（170 条 `acp` 全是 changelog 噪音） | 有角色概念，无验收闸、无证据链 |
| **OpenAI Agents SDK** | 轻量多 agent + handoff | 30,596★，MIT，PyPI `0.24.0`，日更。**Swarm 已被它取代**（Swarm README 原文） | 低 | ❌ 命中 0 | handoff 是「控制权转移」，与「判定权独立」方向相反 |
| **Claude Agent SDK**（Anthropic） | 驱动 Claude Code 的官方 SDK | 8,509★（Python），MIT，PyPI `0.2.180`，152 个 release，日更 | 低（如果你只想要 Claude Code） | ⭕ **不直接说 ACP**，但它是 `claude-agent-acp` 的底层；ACP 那条路是「用适配器包它」 | 无。它是 harness，不是编排层 |
| **Magentic-One**（微软研究院） | 双台账 + 停滞重规划 | **PyPI `magentic-one` 只有 1 个 release（0.0.1）**；能力已被搬进 `microsoft/agent-framework` 的示例（`samples/03-workflows/orchestrations/magentic.py`） | 中（task ledger + progress ledger 两个概念） | ❌ 命中 0 | **本项最强**：它的 ledger 消融（去掉掉 GAIA 31%）是唯一硬数字，但它是「自评」，不是「独立验收」 |
| **Microsoft Agent Framework** | AutoGen 的官方继任者，企业向 | 14,616★，PyPI `1.25.0`，66 个 release，日更。**主打 A2A + MCP**（A2A 命中 177） | 中高（workflow / agent / middleware / checkpoint / hosting 五套） | ❌ `acp` 命中 **0**（A2A 有 177，但那是对接远程不透明 agent，不是本机子进程） | 有 checkpoint / HITL，无证据链 |
| **Google ADK** | code-first Python agent 工具包 | 22,171★，PyPI `2.14.0`，日更 | 中 | ❌ 命中 0（唯一 1 条是 `mcp_tool.py:720` 里一句引用 ACP `_meta` 字段的**注释**，不是支持） | 弱 |
| **pydantic-ai + pydantic-ai-harness** | 类型化 agent + 官方 harness 库 | 21,116★，PyPI `2.66.0`，359 个 release | 中（capability 组合式） | ⚠️ **有 ACP，但方向相反**：`run_acp_stdio` 是把**你的** Pydantic AI agent **作为 ACP server 供编辑器驱动**，不是驱动别人的 CLI。且明确标 experimental：「may still be **removed**, not just changed」 | 无 |
| **LangChain deep agents** | "batteries-included agent harness" | 31,170★ | 中 | ⚠️ **方向也相反**：`libs/acp/` 是把 Deep Agent **暴露为 ACP server**（`dcode --acp`） | 无 |
| **Mastra** | TS agent 框架 + workflow + evals + harness | 29,441★，Apache-2.0（`ee/` 除外），npm `@mastra/core@1.82.0`，2026-09 以来 **384 个 release** | **中**。概念不少（Agent / Workflow / Subagent / Memory / Evals / Harness / Signals），但 ACP 那块 API 面很小：`@mastra/acp` 只有 6 个源文件、约 950 行 | ✅ **`@mastra/acp` 一等公民**：`AcpAgent`（子 agent）+ `createACPTool()`（工具），官方文档直接列 Claude Code / OpenCode / Gemini CLI / Cline 接法，月下载 64,561 | 部分：evals 有 `gates` 三态判词与 CI 强制，`onDelegationComplete` 可 `bail()`/替换 `resultText`；**但没有「预声明 AC + 独立验收者」这个结构** |
| **OpenClaw**（不在原清单，但必须报） | 个人/团队 AI 助手 Gateway，原生 ACP | **394,274★**，MIT，`pushed_at` 当天；`docs/tools/acp-agents.md` 原生支持「Claude Code / Cursor / Copilot / Droid / OpenCode / Gemini CLI 经 acpx 驱动」，且能反向 `openclaw acp` 把自己暴露成 ACP server | **最高**（Gateway / 频道 / 多 agent / 子 agent / standing orders / cron / 插件 / 沙箱，是一整套产品） | ✅ **完全支持，而且是它的产品主线之一** | 有「team preset」（coordinator / researcher / writer / **reviewer**）+ standing orders（approval gates / escalation），但 reviewer 是**同一个模型写 AGENTS.md 的 prompt 约定**，不是独立验收闸 |

**关于「2026 年新出现的相关框架」**：任务要求覆盖这一项。我能给的最强答案就是上面两行——**Mastra**（TS，ACP 一等公民）与 **OpenClaw**（ACP 是核心路径）。两者都不在原清单里，且都比我预想的更接近需求。除此之外，我在 npm 上搜到一批「面向 coding agent 的编排」包（`@openclaw/acpx`、`@ai-sdk/harness-acp`、`@tanstack/ai-acp`、`@ycodium-ai/agent-acp`、`@posthog/agent`、`crewly`、`triflux` 等），说明「ACP 编排」已经是一条有竞争者的赛道，不是空地想。**没有一个是「带验收闸」的。**

---

## 三、ACP 支持情况（决定性因素，单独成节）

### 3.1 结论

**「用现成框架」这件事在 2026-11 有唯一一个正确答案：Mastra。其他编排框架对 ACP 的支持都是 0。**

但要注意三条限制，否则会把 Mastra 的能力想大：

1. **Mastra 的 ACP 只做「驱动」，不做「验收」。** 它把外部 agent 变成 `tool` 或 `subagent`，交回一段文本（`createACPTool` 的 output schema 就是一个 `output: string`）。**usage 它拿不到**——我读了 `src/agent.ts`，`createOnFinishResult()` 里 `usage` 被硬编码为 `{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }`。外部社区已经有人为此写了最小复现仓库（`nick-inkeep/mastra-acp-terminal-usage-repro`，2026-10-20），README 原文：*"The Mastra run returns the same text, but `onFinish.usage` … are `{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }`"*。同一作者另有一个复现：`max_tokens` 终止时抛出的错误**绕过调用方 try/catch**，Node 直接 exit 1。
   → 精确地说：**`AcpAgent` 这一层拿不到 usage**。逃生口存在——`AcpAgent.connection` 是公开属性，其 `promptStream()` 会原样吐出除 `agent_message_chunk` 外的全部 `session/update`（含 `usage_update`），但**那已经绕过了 Mastra 的抽象，等于自己解析 ACP**。
   → **对我们的直接含义**：CLAUDE.md 硬约束 #8「派发必须声明预算」，如果走 Mastra 的 ACP 路径，**预算无法从框架的 `onFinish` 拿，必须自己从 `connection.promptStream` 或 `acpx --format json` 的裸流里读 `usage_update`。**
2. **ACP 协议层没有工具白名单。** `NewSessionRequest` 的全部字段只有 `cwd` / `additionalDirectories` / `mcpServers` / `systemPrompt` / `_meta`。`systemPrompt` 还是可选能力（agent 要 advertise `sessionCapabilities.systemPrompt` 才接受），`mode` 要 agent advertise `SessionMode` 才能切。**工具裁剪只能走各家私有 `_meta`**——`claude-agent-acp` 认 `_meta.claudeCode.options.{tools, disallowedTools, maxBudgetUsd, maxTurns, settings, hooks, mcpServers}`，但那是适配器的约定，不是协议。
   → **对我们的直接含义**：12 个角色的 tools 白名单，在外部 harness 上**不可能由协议保证**，只能「逐 harness 写适配 + 记录哪些字段它不认」。这是纯自己写的活。
3. **Mastra 是 TS 且要 Node ≥ 22.13，`@mastra/core` 解包 85 MB / 3571 个文件。** 与本仓「零 npm 依赖、Node ≥ 18、clone 即用」（README 第 5 行）直接冲突。
   → **这不是否决理由，是边界条件**：框架层不可能再做成「零依赖配置库」。如果选这条，Overwatch 就从配置库变成一个有构建产物的项目。**这个代价必须由用户显式批准，不能由 Agent 顺手决定。**

### 3.2 为什么不是「自己写 ACP client」

不用写。证据：
- **官方 SDK 成熟**：`@agentclientprotocol/sdk` 月下载 **30,107,922**；Python 版 `agent-client-protocol` 同源。
- **acpx 已把最脏的部分做完**：673 个 blob、462 个 `.ts` 文件共约 5.3 MB（其中 267 个测试文件），支持 30 个内置 profile（含 `claude` 与 `deepseek-harness`）、`--format json` 输出裸 ACP、per-tool 权限策略（`autoApprove` / `autoDeny` / `escalate` / `defaultAction`）、session 保活与队列、`cancel` / `set-mode` / `set` / `status` 控制面。它的 `VISION.md` 自己写明了定位：*"`acpx` should not try to do too many things at once"*、*"The primary user is another agent, orchestrator, or harness."*
- **本机已实测过**（`2026-11-04-external-harness-protocols.md` §7）：`acpx 0.22.0` 端到端驱动 opencode 成功，逐 token 拿到 `agent_message_chunk` 与 `usage_update`，无需等结束。
- **自建最小 client 只需 113 行**（`.tmp-analysis/acp-turn.mjs`，既有实测产物）。
→ **判断：ACP 驱动层「买」，且买 acpx 或 Mastra，不自己造。这一条没有争议空间。**

### 3.3 那「编排层」还剩多少是自己写

把 Mastra 能给的扣掉，剩下的就是我们必须写的。逐项列，**每项都标明「Mastra 有没有」**：

| # | 必须写的东西 | Mastra 有吗 | 证据 | 为什么不能省 |
|---|---|---|---|---|
| **W1** | **工单 schema**：`ticket.json` 的 `goal / shape / AC[] / boundary / budget / adapter / role`，以及机械校验器 | ❌ | `createACPTool` 的 input schema 只有 `{ task: string }`；`AcpAgent.generate(messages)` 也是自由文本 | 预声明 AC 是本仓最硬的一条，也是 MAST 里最大一类失败（规格类 41.77%） |
| **W2** | **三事件汇报协议 + 父只读 5 字段 + 指针** | ⚠️ 半个 | Mastra 的 subagent 只回 `text`（+可选 `subAgentToolResults`）；`onDelegationComplete` 能替换/加注解但**不能把结果结构化** | 「默认无进度通道」是 10 个系统的通例（既有研究 §一）；框架默认给的是「一句话总结」 |
| **W3** | **验收闸**：干净上下文的 acceptor，只看 `ticket.AC[]` + diff + report 指针，一票否决 | ❌ | evals 的 `gates` 是**离线对数据集**跑，不是「对刚回来的这个工单判过不过」；`onDelegationComplete` 的 `bail()` 是父 agent 的循环控制，不是独立裁决者 | 这是 Overwatch 唯一独占的差异 |
| **W4** | **证据核对**：断言 vs transcript 里的 tool_use/tool_result，判四档 | ❌ | Mastra 无等价物（Observability 是 trace/span/cost，不是「这句话有没有证据」） | 已实现（`verify-claims.mjs`，全量 31 条断言，人工抽检 84.6% 精度） |
| **W5** | **深度/并发的物理限制** | ✅ 部分 | Mastra 有 `maxSteps`、`onDelegationStart` 的 `proceed: false`、`modifiedMaxSteps`、`iteration` 计数 | 本仓现状是「12 个角色全部不含 `Task`，实际深度 1」，这条框架帮不上 |
| **W6** | **预算硬上限** | ⚠️ 靠适配器 | Mastra 的 ACP usage 恒为 0（见 §3.1）；`claude-agent-acp` 认 `_meta.claudeCode.options.maxBudgetUsd`，但那是 Claude 专属 | CLAUDE.md 硬约束 #8 |

**W1 + W2 + W3 是「框架」，W4 已有，W5/W6 靠适配器 + 自读裸流。**
这就是「自己写」的真实规模：**不是写一个框架，是写三份 markdown + 两个脚本，再挂在一个现成的 ACP 驱动上。**

---

## 四、需求对照表（§3 原表填全）

| 需求 | 我们为什么要 | 哪个框架支持 | 支持到什么程度 |
|---|---|---|---|
| **驱动外部 CLI agent（ACP）** | 核心定位：「带别人的手下」 | **Mastra**（`@mastra/acp`）；**OpenClaw**（acpx 一等公民 + `openclaw acp` 反向暴露）；acpx 裸用 | **Mastra**：命令 + argv + 环境 + cwd + model + `persistSession` + `onPermissionRequest` + `createClient` 扩展，官方文档给了 Claude Code / OpenCode / Gemini CLI / Cline 接法。**但不给 usage，`max_tokens` 终止的错误会漏出 try/catch（社区复现）**。**OpenClaw**：能力更全（会话绑定、后台任务、`/acp spawn`、`sessions_spawn({runtime:"acp"})`），代价是接受整套 Gateway（39.4 万★，GitHub `size` 字段 13.1 GB）。**其余框架：LangGraph / CrewAI / AutoGen / OpenAI Agents SDK / Microsoft Agent Framework / Google ADK / Strands / smolagents 均为 0；pydantic-ai 与 LangChain deep agents 有 ACP 但方向相反（把自己暴露成 ACP server），不能驱动别人的 CLI** |
| **角色分工 + 工具裁剪** | 12 个角色靠 tools 白名单（`check-structure.mjs:195-210` 校验） | **Mastra**：`Agent({ tools: {...} })` 静态或动态按 requestContext 解析；**OpenClaw**：per-agent `skills` allowlist + `tools.*` 策略 + `allowAgents`；**ACP 协议本身**：❌ 无字段 | **协议层零支持**（183 个 `$defs` 里没有工具白名单）。外部 harness 的工具裁剪只能经各适配器私有 `_meta`（`claude-agent-acp`：`options.tools` / `disallowedTools`）。**这是必须自己写、且要逐 harness 验的** |
| **对抗结构（执行/锐评/验收/红队）** | CLAUDE.md 硬约束 #2/#3/#4 | **Magentic-One**（双台账 + 停滞重规划，有 31% 消融数字）；**Mastra**（council 模式无专用 primitive，要自己用 workflow `.parallel()` 拼；evals 有 gates 判词）；**OpenClaw**（team preset 有 coordinator/researcher/writer/**reviewer**） | **没有一个把「独立验收者」做成一等公民**。Mastra 文档原话：「Mastra doesn't provide a dedicated council primitive」；OpenClaw 的 reviewer 是 `AGENTS.md` 里的角色契约（prompt 约定），本仓既有研究已证「prompt 禁令是假安全」（dsh `docs/007-architecture.md:507` 自述） |
| **证据纪律（每条结论可复算）** | 仓库核心方法论；`verify-claims.mjs` | **无**。Mastra Observability 是 trace/span/token/cost 归因，不是「这句断言有没有 tool_result 支持」 | 零。已自研，且这是唯一独占差异 |
| **默认无进度通道** | 既有研究结论：这是通例 | **LangGraph** `output_mode="last_message"` 默认；**LangChain deep agents** 单个 report；**OpenAI** `as_tool()` 只回最终输出；**Mastra** subagent 只回 `text`，「Nested tool calls and subagent metadata … aren't added to the parent agent's model context」 | **这一条框架普遍做对了**。本仓不需要自研，只需要在汇报协议里保持「只有三事件」 |
| **成本控制（15× token）** | Anthropic 自述；CLAUDE.md 硬约束 #8 | **Mastra**：Observability 有 token/cost 聚合 + metrics；`maxSteps`；但 **ACP 路径的 usage 恒为 0**。**OpenClaw**：per-subagent model 降级（`agents.defaults.subagents.model`）。**claude-agent-acp**：`_meta.claudeCode.options.maxBudgetUsd` / `maxTurns` | **框架层给「观测」，不给「硬闸」**。硬闸在适配器私有字段里。要「派发时声明预算并强制」，仍得自己读裸 ACP `usage_update` |
| **可观测/可追溯** | 用户要复盘 | **Mastra**：OpenTelemetry span 层级、token/cost、logs 关联 trace、feedback 绑 trace、Studio 面板；**OpenClaw**：Control UI、subagents 面板、run transcript；**MS AF**：内置 OTel | **这一条买得最值**。本仓自己做的只有「读 transcript 重建」，粒度更粗。**但注意**：可观测是「事后看」，不是「事前判」 |

**表格读法**：8 项里，**3 项（ACP 驱动、可观测、无进度通道）买得到且买得值**；**1 项（工具裁剪）协议层根本没有，必须自己补**；**2 项（对抗结构、证据纪律）没有一个框架做到，且是本仓唯一独占**；1 项（成本控制）买一半；1 项（角色分工）框架有等价物但语义不同（Mastra 的 `tools` 是给**自己的** agent 配工具，我们的白名单是**契约**，还带 `check-structure.mjs` 硬门）。

---

## 五、自己写的代价：具体到人月与维护负担

**先声明：这一节的人月是推算，不是实测。** 基准是本仓已交付的体量，不是行业均值——因为「自己写编排」的成本几乎全部取决于「你已经有什么」。

### 5.1 本仓的既有资产（决定「自己写」便宜的原因）

| 资产 | 规模（实测） |
|---|---|
| 12 个角色定义（带 tools 白名单 + 不可合并理由） | `.claude/agents/*.md` |
| 5 份规格（dispatch-contract / state-model / evidence-discipline / relay-protocol / output-format） | `docs/spec/` |
| 脚本（不含测试） | **14,611 行**，`scripts/*.mjs` |
| 测试 | **9,139 行，13 个 `*.test.mjs`**。用例数两个官方口径冲突：`README.md:128` 写 **508 条**，`CLAUDE.md:36` 写 **192 条**。本次未跑测试，**不采信任何一个作为精确值**，只当作「数百条量级」 |
| 结构硬门 | `check-structure.mjs`，含 CHANGELOG 硬规则、角色白名单校验、设计索引校验 |

→ **这正是「自己写」便宜、换框架贵的结构性原因**：这些资产在 LangGraph / CrewAI 里是「你自己写」，在本仓是「已经写完并被测试钉住」。

### 5.2 自己写的三个真实坑（有出处）

**坑 1：并发写同一份状态文件 → 截断 JSON → 全链路崩。**
HN 46993479 里一位用 84 个 Claude Code hook 的人的原话：

> *"I had seven on UserPromptSubmit, each reading stdin on their own. Two wrote to the same JSON state file. Concurrent writes = truncated JSON = every downstream hook breaks. One dispatcher per event running them sequentially from cached stdin fixed it."*

同帖另一人（做 swarm 的人）的原话：

> *"80% of my debugging time wasn't fixing bad code, but fixing race conditions where agents were overwriting each other's context or hallucinating because they didn't have the latest state. I ended up building a 'traffic light' protocol (essentially a semaphore for swarms) to force serialization on critical tasks."*

→ **本仓已有同类教训**（`2026-11-04-dedup-key-analysis.md`、A8「用谓词值当事件身份做去重」）。**这类坑不会因为「自己写」而消失，只会因为「自己写」而由你承担。** 这是自己写的真实成本项，且是**无底洞型**（每加一个并发写入方就要重审一次）。

**坑 2：AC 之外的一切都要自己长出来。** 一个用 84 hook 的实践者的总结值得记：

> *"No framework, no runtime. Just files. You can use one hook or eighty-four."*

这句话的正面是「文件就是架构」，反面是「没有框架替你兜底，文件之间的不变量全靠你自己维持」。本仓的 `check-structure.mjs` 就是在兜这个底，**它已经在膨胀**（CHANGELOG 硬规则、角色白名单、设计索引三块）。

**坑 3：自己写会持续被「宿主新特性」追平。** `docs/research/2026-11-04-competitive-landscape.md` 已记录：`claude agents`（Agent view）把「多会话监控」原生做完了，`oh-my-claudecode`（40,728★）把「多 agent 编排」做成了 npm 包，OpenClaw（394,274★）把「ACP 驱动外部 harness + 团队角色 + standing orders」做成了产品。**这三条都在我们的方向上，且都比我们成熟。**

### 5.3 人月推算（明确标注为估算）

| 方案 | 一次性成本 | 持续成本 | 备注 |
|---|---|---|---|
| **A. 纯自研（连 ACP 驱动也自己写）** | **不推荐**。ACP client 本机实测 113 行可跑通一轮，但要生产级（队列、保活、权限策略、错误恢复、30 个 profile）→ acpx 用了 673 个文件 / 约 5.3 MB TS / 267 个测试。**照着抄 ≈ 2–3 人月，且永远追不上上游** | 高 | 唯一好处是完全可控；但 acpx 是 MIT，可控性可以靠 fork 拿到 |
| **B. 自研编排层 + acpx 驱动** | **本仓已有资产抵扣后，剩 W1+W2+W3 ≈ 2 个脚本 + 3 份 markdown。粗估 3–6 人周**（含负向测试）。依据：`validate-run.mjs` / `verify-claims.mjs` 这类脚本在本仓的既有体量与工期 | **中**。acpx 是 pre-1.0（README 原文：「Treat its CLI and runtime interfaces as evolving」），每次升级要重测；每加一个 harness 要重测权限与 usage | **推荐**。前提是保持零依赖、不引入 Mastra |
| **C. Mastra + 自研 W1/W2/W3/W6** | 引入成本高：`@mastra/core` 解包 **85 MB / 3571 文件**，Node ≥22.13，与「零 npm 依赖」直接冲突；`@mastra/core` 2026-09 以来 **384 个 release**。自研部分同 B | **高**。每次 Mastra 大版本升级都要重测；且 ACP usage 恒为 0 的 bug 要自己绕 | 换来的是 Observability / Evals / Workflow / Studio。**如果将来要做 Web UI 与 OTel，这条更值** |
| **D. 全买（Mastra 或 OpenClaw 直接用）** | **≈ 0** | **低** | **但会失去唯一独占的差异（W3/W4），且与「零依赖」冲突。** 若「验收闸有效」这个前提被证伪，这条就是正确答案 |

**我的估算置信度：低。** 理由：我没有做任何工程量实测（不装框架、不写原型）；本仓既有脚本工期我只有行数没有工时记录。**这个数字只能当量级看，不能当排期依据。**

### 5.4 关于「1 人维护」

HN 上两位实践者的经验值，恰好给出「1 人能做到什么」的边界：

> *"Haven't really spent time working with more than 2-3 agents at a time. I quickly become the bottleneck when I review the diffs/plans … The sweet-spot is 2-3 agents co-ordinating at a time and me overseeing everything."*

> *"Usually I keep it to about 4 projects at a time, just to keep the context switching down."*

→ **1 人维护的上限不是 agent 数量，是「需要你拍板的次数」。** 这与「验收闸」的方向一致：acceptor 存在的意义就是把「拍板」从人转移到一份预声明标准上。**但也意味着：验收闸本身如果经常误判，1 个人会被它拖死。** 这是本方案最大的单点风险。

---

## 六、反面证据与未知项

### 6.1 反对「自己写」的最强证据

1. **Anthropic 官方建议**（`Building effective agents` 原文，`.tmp-analysis/anthropic-bea.txt:47`）：
   > *"We suggest that developers start by using LLM APIs directly: many patterns can be implemented in a few lines of code. If you do use a framework, ensure you understand the underlying code. Incorrect assumptions about what's under the hood are a common source of customer error."*
   → 注意：这段**支持「少用框架」**，但它的意思是「用底层 API，别用重框架」，不是「造个新框架」。**它恰好支持我们的形态：acpx 裸流 + 薄编排，而不是 LangGraph。**
2. **Cognition 的两次表态**（既有研究 §3.1）：2025 年「默认排除不满足共享上下文的架构」，2026 年改口成「写入保持单线程，其他 agent 只贡献智力」，并把无结构 swarm 称为 *"distraction"*。→ 这**否定**并行写手 swarm，但**支持**「generator / verifier 事先不共享上下文」，即我们的验收闸。
3. **arXiv 2503.13577（`When Should We Orchestrate Multiple Agents?`）摘要原文**：
   > *"orchestration is only effective if there are performance or cost differentials between agents."*
   → **这是一条对我们不利的证据**：如果我们的 acceptor 与 executor 用同一个模型（实测：12 个角色里 **10 个是 `model: inherit`**，只有 `oversight-probe` 与 `oversight-safety` 是 `haiku`，而 `executor` 与 `acceptor` **都是 inherit**），那么「编排」带来的收益只来自**上下文隔离**，不来自能力差异。**这必须写进假设，不能默认成立。**

### 6.2 反对「买」的最强证据

1. **AutoGen 已归档**，官方原文：*"This project has been archived and is no longer actively maintained by Microsoft."* → 买一个归档项目是错的；买它的继任者 MAF 可以，但 MAF 的 ACP 支持是 0。
2. **OpenAI Swarm 已被 Agents SDK 取代**（README 原文）→ 清单里的 Swarm 项不应再评估。
3. **Magentic-One 的 PyPI 包只有 1 个 release（0.0.1）**，能力已并入 MAF 的示例 → 「Magentic-One 作为独立框架」实际不存在。
4. **pydantic-ai 的 ACP 是反方向且标 experimental**（原文：「may still be **removed**, not just changed」）。
5. **Mastra 的 ACP 有已知缺陷且社区已开复现仓库**（usage 恒 0；`max_tokens` 错误漏出 try/catch，Node exit 1）。→ **买 Mastra 不是零风险**。

### 6.3 我没找到的东西（诚实申报）

1. **「自己写编排然后失败/放弃」的第一手复盘：没找到。** 我查了 HN Algolia 四组关键词（`rolled our own agent framework`、`why we ditched langgraph`、`build your own agent orchestrator`、`agent framework regret`）、WebSearch 四组、GitHub 仓库搜索。**只有间接材料**：HN 46993479 里两条「自己写的人踩了什么坑」（§5.2），以及第三方博客说 LangGraph 「80 节点后拓扑爆炸」（未能交叉验证，不作为结论）。
   → **这一项的缺失本身是个发现**：这说明「自己写编排」在这个领域**还没有足够多的失败样本被公开**，也可能说明**死掉的项目不会写复盘**。不能因为「找不到失败案例」就推断「自己写安全」。
2. **Mastra ACP 驱动 Claude Code 的实跑证据：没有。** 它的文档给了接法（`npx @agentclientprotocol/claude-agent-acp`），但没有本机实测。本仓既有实测是 acpx→opencode，不是 Mastra→Claude。
3. **OpenClaw 的实际可用性：没验。** 394,274★ 与 GitHub `size` 字段 13.1 GB（含历史）需要谨慎看待；我没装、没跑、没读它的 ACP 实现代码（只读了 docs 与 CLI 类型定义文件的存在性）。
4. **「验收闸有效」这个前提：未证。** 见 §1 第 5 条。
5. **2026 年是否还有别的「ACP 一等公民」框架：可能漏。** 我的检索路径是 GitHub code search + npm search + 各框架 repo 内搜。如果某个框架用别的词指代 ACP（比如自造适配层），我会漏掉。

---

## 七、推荐方案

### 7.1 明确判断（三句话）

1. **该自己写的是「编排层」，不该自己写的是「驱动层」。** 驱动层用 `acpx`（或将来用 Mastra 的 `@mastra/acp`），编排层自己写——因为**没有任何框架把「预声明 AC + 独立验收 + 证据核对」当作一等公民**，而这正是本仓唯一独占、且已被真实痛点验证的差异。
2. **最接近的现成方案是 Mastra，不是 LangGraph。** 它是唯一把「驱动任意 ACP agent」做成官方包的主流框架（`@mastra/acp`，6 个源文件、约 950 行、月下载 6.4 万、官方文档直接给 Claude Code 接法）。但它**不覆盖验收闸**，且 ACP 路径的 usage 恒为 0，与「零依赖」冲突。
3. **不推荐 OpenClaw，尽管它能力最全。** 394k★、原生 ACP、team preset 有 reviewer、standing orders 有 approval gates——但它是**整套产品**（Gateway + 频道 + 插件 + 沙箱），接受它等于放弃「零依赖配置库」这个 ADR-0001 已裁决的形态，且它的 reviewer 是 prompt 约定而非独立闸。

### 7.2 具体方案（不做「视情况而定」）

**v0 架构（推荐 B 的变体）：**

```
Overwatch 编排层（自己写，约 2 脚本 + 3 markdown）
  ├─ W1 ticket.json + validate-ticket.mjs        ← 新写
  ├─ W2 三事件汇报协议（DONE/BLOCKED/NEEDS_DECISION）← 新写，无 progress
  ├─ W3 acceptor（干净上下文，只看 AC[] + diff + report 指针）← 复用 12 角色
  ├─ W4 verify-claims.mjs                         ← 已有
  └─ W6 budget：读裸 ACP usage_update             ← 自己解析 acpx --format json
        │
        ▼
   acpx（子进程，--format json，MIT，pre-1.0）
        ├─ acpx claude  …  → @agentclientprotocol/claude-agent-acp
        ├─ acpx deepseek-harness … → dsh --profile acp
        └─ acpx opencode  … → opencode acp（已实测）
```

**为什么选 acpx 而不是 Mastra 作为 v0**：
- acpx 是 **CLI + 裸 ACP JSON**，我们的编排层是零依赖 Node 脚本，**不需要引入 85 MB 的 `@mastra/core`**，不破坏「clone 即用」。
- acpx 直接给 `usage_update`，能落实「预算必须声明」（CLAUDE.md #8）；Mastra 的 ACP usage 恒为 0。
- acpx 有 per-tool 权限策略（`autoApprove/autoDeny/escalate/defaultAction`），可以映射「锐评只读 / 执行可写」的角色白名单。
- 代价：acpx 是 pre-1.0，接口会变。**缓解：把 acpx 调用封在一个 `scripts/harness-acpx.mjs` 里，接口变了只改一个文件。**

**什么情况下应该改用 Mastra（明确的切换条件，不是「视情况」）**：
- 如果 v0 之后要做 **Web UI / 多人协作 / OTel 全链路 trace**——这三件 Mastra 已经做完，自己写不划算。
- 如果 **W6 的裸流解析反复出 bug**（acpx 的 stdout 污染、版本漂移），说明「薄封装」这条路在维护上不成立，此时应退到 Mastra 的托管式适配。
- **切换点必须在 v0 验收后由用户裁决，不由 Agent 顺手决定**，因为它会推翻 ADR-0001。

**明确不做**：
- 不写 ACP client（acpx / 官方 SDK 已覆盖，30M 月下载）。
- 不引入 LangGraph / CrewAI / AutoGen / OpenAI Agents SDK（ACP 支持全为 0，且 AutoGen 已归档、Swarm 已废弃）。
- 不做「自己能递归派生子 agent」的 v2（本仓 12 个角色全部不含 `Task`，实际深度 1；这条已在 `2026-11-10-agent-framework-skeleton.md` §3.3 记录）。
- 不因为「Mastra 最接近」就直接采纳它——**采纳它之前必须回答一个问题是「零依赖还要不要」**，这是用户的决定，不是调研能替答的。

### 7.3 如果只能给一句话

**买 ACP 驱动，造验收闸。** 因为驱动这一层 2026 年已经是白菜价（30M 月下载的官方 SDK、6.4 万月下载的框架包、673 个文件的成熟 CLI），而验收这一层**全世界只有一个仓库在做，就是本仓**。

---

## 八、复现方式

```bash
# 框架元数据（本次全部经 gh api）
gh api repos/langchain-ai/langgraph --jq '{s:.stargazers_count,p:.pushed_at}'
gh api repos/microsoft/autogen/readme -H "Accept: application/vnd.github.raw" | head -30   # 归档声明
gh api repos/openai/swarm/readme  -H "Accept: application/vnd.github.raw" | head -10       # 已被取代

# ACP 支持（关键：用全词 agentclientprotocol，acp 有大量假阳性）
gh api search/code -X GET -f q="repo:<owner>/<repo> agentclientprotocol" --jq .total_count

# Mastra ACP 一手材料
gh api repos/mastra-ai/mastra/contents/agent-sdks/acp/src/agent.ts -H "Accept: application/vnd.github.raw"
gh api repos/mastra-ai/mastra/contents/docs/src/content/en/docs/connections/acp.mdx -H "Accept: application/vnd.github.raw"
gh api repos/mastra-ai/mastra/contents/docs/src/content/en/reference/acp/create-acp-tool.mdx -H "Accept: application/vnd.github.raw"

# ACP 协议本身（确认没有工具白名单字段）
gh api repos/agentclientprotocol/agent-client-protocol/contents/schema/v1/schema.json \
  -H "Accept: application/vnd.github.raw" > acp-schema.json
node -e "const d=require('./acp-schema.json').\$defs; console.log(Object.keys(d['NewSessionRequest'].properties))"

# Mastra ACP 的已知缺陷（第三方复现）
gh api repos/nick-inkeep/mastra-acp-terminal-usage-repro/readme -H "Accept: application/vnd.github.raw"

# acpx
gh api repos/openclaw/acpx/contents/docs/permissions.md -H "Accept: application/vnd.github.raw"
gh api repos/openclaw/acpx/contents/docs/VISION.md -H "Accept: application/vnd.github.raw"

# 下载量 / 版本
curl -s --proxy http://127.0.0.1:7897 "https://api.npmjs.org/downloads/point/last-month/@mastra%2Facp"
curl -s --proxy http://127.0.0.1:7897 "https://api.npmjs.org/downloads/point/last-month/@agentclientprotocol%2Fsdk"
```

**最值得点进去的 5 个文件**：
| 想看什么 | 看哪 |
|---|---|
| 「用框架」这条路到底通到哪 | `mastra-ai/mastra` 的 `agent-sdks/acp/src/{agent,connection}.ts`（usage 恒 0 就在 `agent.ts:342`） |
| 协议层为什么帮不了工具裁剪 | ACP `schema/v1/schema.json` 的 `$defs.NewSessionRequest.properties`（只有 5 个字段） |
| 买 ACP 驱动该买谁 | `openclaw/acpx` 的 `docs/VISION.md` + `docs/permissions.md` |
| 自己写会踩什么坑（第一手） | HN 46993479，两条评论：并发写状态文件、swarm 的 traffic-light 信号量 |
| 最全但最重的现成方案 | `openclaw/openclaw` 的 `docs/tools/acp-agents.md` + `docs/concepts/multi-agent.md`（team preset） |
