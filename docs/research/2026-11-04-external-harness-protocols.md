# 外部 harness 协议层调研（2026-11-04）

> 检索 Agent E1 · 产出形态：exploration（调研笔记）
> 目标：Overwatch 要「外包给别人的手下」——把任务交给外部 AI coding harness（Claude Code CLI、dsh 等），并收回结果。本文只谈**协议层**：怎么以编程方式驱动、怎么观察过程、怎么保留决策权。
>
> **验证声明**：本文的协议结论来自官方仓库源码/文档（经 `gh api` 读取），接口能力来自本机实测（`opencode acp`、`dsh --profile acp`、`claude mcp serve`、`acpx`）。凡未实测的，文中标注「未实测」。跑偏和失败的地方一并记录，不修饰。

---

## 1. 结论先行

1. **ACP（Agent Client Protocol）就是那条路，而且已经成熟可用。** 稳定在 v1（v2 已出 Draft），JSON-RPC 2.0 over stdio，官方实现者清单里有 50+ 个 agent、30+ 个 client。本机实测：外部 Node 进程成功扮演 ACP client，驱动 `opencode acp` 与 `dsh --profile acp` 走完 `initialize → session/new → session/prompt` 全流程，并**逐 token 收到流式中间结果**，不需要等结束。
2. **ACP 的权限请求方向是反的，这对 Overwatch 极其有利。** `session/request_permission` 是 **agent → client** 的请求：干什么由 agent 提议，**批不批由 client 决定**。Overwatch 作为 client 天然握有否决权，不需要事后审计。「公司」的决策层与执行层的边界，协议层已经帮你划好了。
3. **不用自己写 ACP client——`acpx` 已经写好了。** 单文件 CLI，`--format json` 输出的是**裸 ACP wire JSON**（官方保证不加壳、不改名），30 个内置 agent profile 里**同时包含 `claude` 和 `deepseek-harness`**。本机实测 `acpx` 端到端驱动 opencode 成功，拿到带 `messageId` 的流式分片与 usage/成本。
4. **MCP 不能当反向决策通道，ACP 能。** MCP 的 `sampling`（server 反向请求 LLM 调用）已在 `2026-07-28` 版**正式弃用**；仍可用的反向通道是 `elicitation`（server → client 求结构化输入）。而 ACP 从设计上就原生支持 agent → client 的双向 JSON-RPC，不必绕道。
5. **A2A 不是我们要的东西。** A2A 面向「跨组织的**不透明** agent 服务」，传输层是 HTTP/gRPC/SSE，要 agent 卡、服务发现、异步任务。而我们要驱动的是**本机子进程 CLI**，ACP 是 stdio + 子进程模型，正好对齐。A2A 是「对接别的公司的服务台」，ACP 是「把活派给楼下的外包工位」。
6. **这条路已经有人走通了，所以差异化不在协议层。** OpenHands 已把「ACP 驱动 Codex / Claude Code / Gemini CLI / OpenCode 子进程 + 流式工具卡 + 重启后 resume + 累计成本」做成了产品功能（源码 feature map `F29-acp-sessions.md`）。**结论：协议层是现成的、免费的、别人已验证的。Overwatch 的价值必须落在「公司结构 / 决策权归属 / 交接协议」上，而不是「我能驱动多个 harness」。**

---

## 2. 协议对比表

| 协议 | 定位 | 传输层 | 成熟度 | 我们能不能用 | 用来做什么 |
|---|---|---|---|---|---|
| **ACP** (Agent Client Protocol) | **编辑器/客户端 ↔ coding agent** | JSON-RPC 2.0 over **stdio**（远程 agent 的 HTTP/WS 仍在 WIP） | **v1 稳定**（当前 wire 版本 `1`）；v2 于 2026-07-20 发 Draft；v1 期内已落 15+ RFD | **能，已实测跑通** | **主路径**：外部进程作为 client 驱动 harness 干活 |
| **MCP** (Model Context Protocol) | agent ↔ 工具/数据 | JSON-RPC over stdio / HTTP / SSE | 成熟，已多轮修订（至 `2026-07-28`） | 能，但方向受限 | **反向通道**：把 Overwatch 暴露成 MCP server 给 agent 调；**不要**指望 sampling |
| **A2A** (Agent2Agent) | **不透明 agent 服务 ↔ 不透明 agent 服务** | HTTP+JSON / gRPC / JSON-RPC（多绑定） | v1.0.0 / v1.0.1（2026-05-28） | 能用但**不匹配** | 跨机器、跨组织的远程 agent 委托；本机 CLI 用不上 |
| **Claude Code 自身 CLI** | 单 harness 非交互执行 | 进程 + stdout（`--output-format`） | 成熟（本机 2.1.289） | 能，已实测 | 兜底路径；能力最全但锁死单一厂商 |
| **dsh 自有 SDK** | 另一个进程驱动 dsh runtime | 换行分隔 JSON-RPC over stdio | 有 TS + **Python** SDK | 能（未实测 SDK，实测了 ACP） | 若深度绑定 dsh，比 ACP 暴露更多（审批/提问/subagent 通知） |

---

## 3. ACP 深入

### 3.1 是什么、谁在推、什么状态

- **规范化站点**：`agentclientprotocol.com`；**仓库**：`agentclientprotocol/agent-client-protocol`（★4606，Apache-2.0）。
- **起源与主导**：Zed 发起，现已迁到独立的 `agentclientprotocol` GitHub 组织（注意：`zed-industries/claude-code-acp` 已重定向到 `agentclientprotocol/claude-agent-acp`）。README 里写着现任 lead maintainer 是 Sergey Ignatov。
- **状态（实测读取 README 原文）**：*"The current stable ACP protocol version is `1`."* v2 已于 2026-07-20 发 Draft。仓库同时存在 `schema/v1` 与 `schema/v2` 两套 JSON Schema。
- **定位**：明确对标 LSP —— *"similar to how the Language Server Protocol (LSP) standardized language server integration"*。

### 3.2 协议形状

**传输与编码**：JSON-RPC 2.0，stdio（agent 作为 client 的子进程）；方法（request/response）与通知（单向）两类消息。

**设计原则**（官方 architecture 文档原文）：
1. **MCP-friendly** —— 建在 JSON-RPC 上，尽量复用 MCP 类型
2. **UX-first**
3. **Trusted** —— 编辑器把本地文件和 MCP server 的访问权交给 agent，但仍控制其工具调用

**会话生命周期**：

```
initialize            → 协商版本 + 交换 capabilities
authenticate          → 若 agent 要求（可选）
session/new           → 新会话
  （或 session/load / session/resume）
session/prompt        → 发用户消息
  ← session/update            （流式进度，反复）
  ← session/request_permission（需要授权时，agent 反向问 client）
  → session/cancel            （需要中断时）
session/prompt 响应   → 带 stopReason 结束
```

**`session/update` 的全部变体**（v1 schema 原文，这是「它现在在干什么」的答案）：

| 变体 | 含义 |
|---|---|
| `agent_message_chunk` | **Agent 回复的流式分片** |
| `agent_thought_chunk` | **推理过程的流式分片** |
| `user_message_chunk` | 用户消息分片 |
| `tool_call` / `tool_call_update` | 工具调用新建 / 状态与结果变更 |
| `plan` | **Agent 的执行计划** |
| `available_commands_update` | 可用 slash 命令集合变化 |
| `current_mode_update` | 会话模式变化 |
| `config_option_update` | 会话配置项变化 |
| `session_info_update` | 会话元数据（标题等） |
| `usage_update` | **上下文用量与累计成本** |
| `notice` | 面向用户的即时通知（需 client 声明 `session.notices`） |
| `compaction_update` / `compaction_summary_chunk` | 上下文压缩（需 `session.compaction`） |

> **对 Overwatch 直接有用的四个流**：`agent_thought_chunk`（判断它是不是在瞎搞）、`plan`（提前看到它打算怎么做）、`tool_call`（正在动什么）、`usage_update`（实时成本）。这比等 58 秒拿一个最终 JSON 强一个量级。

**client 侧的方法**（即 agent 会反过来调我们什么）：

- `fs/read_text_file`、`fs/write_text_file` —— 文件访问
- `terminal/*` —— 终端
- `session/request_permission` —— **授权请求，一票否决的落点**
- `elicitation/create` —— 结构化追问（form / url 两种模式）

**权限请求的实际形态**（实测抓到的 schema）：

```json
{
  "method": "session/request_permission",
  "params": {
    "sessionId": "sess_abc123def456",
    "toolCall": { "toolCallId": "call_001" },
    "options": [
      { "optionId": "allow-once",  "name": "Allow once", "kind": "allow_once" },
      { "optionId": "reject-once", "name": "Reject",     "kind": "reject_once" }
    ]
  }
}
```

**关键：一个外部进程能不能扮演 client，驱动 agent 干活并拿到结果？——能。已实测。**

自建最小 ACP client（`.tmp-analysis/acp-turn.mjs`，约 120 行 Node）实测结果：

```
[+  9579ms] INIT ok deepseek-harness-acp v0.0.1
[+ 12729ms] SESSION <session-Y-uuid>
[+ 12729ms] PROMPT sent
[+ 13383ms] FAIL {"code":-32603,"message":"Internal error: turn failed: Insufficient Balance ..."}
```
—— dsh：协议握手、建模、发 prompt 全部成功，**败在 DeepSeek 账户余额不足**（不是协议问题）。

```
[+ 15708ms] INIT ok OpenCode v1.19.2
[+ 29141ms] SESSION ses_e3fbab857ffeYvPwZ81Eo3QKrr
[+ 29142ms] PROMPT sent
[+ 29158ms] UPDATE available_commands_update
[+ 98224ms] UPDATE agent_message_chunk OK
[+126121ms] UPDATE usage_update
[+126122ms] PROMPT_DONE stopReason= end_turn
```
—— opencode：**完整一轮成功**，中途收到流式 update，最后拿到 `stopReason`。

### 3.3 实现了 ACP 的 harness（官方清单摘录）

完整清单在 `docs/get-started/agents.mdx`，共 50+ 项。与我们相关的：

| Harness | ACP 支持方式 |
|---|---|
| **Claude Code** | 经 `agentclientprotocol/claude-agent-acp`（基于官方 Claude Agent SDK，★2743，日更） |
| **dsh (DeepSeek Harness)** | **原生** `dsh --profile acp` |
| **Gemini CLI** | **原生** `gemini --acp` |
| **Codex CLI** | 经 `agentclientprotocol/codex-acp` 适配器 |
| **OpenCode** | **原生** `opencode acp`（已实测） |
| Cursor / GitHub Copilot / Cline / OpenHands / Goose / Kimi CLI / Qwen Code / JetBrains Junie / Factory Droid / Mistral Vibe / Augment Code | 原生或适配器 |

**Client 侧**（即可以拿来抄/直接用的驱动方）：Zed、JetBrains、Neovim（4 个插件）、VS Code（多个扩展）、Emacs、Sublime、Qt Creator、Obsidian（4 个插件）；CLI 侧有 **`acpx`**、Orca、Raven、SpurCode、acp-runner 等。

### 3.4 ACP v2 Draft 的要点（对我们的影响）

2026-07-20 发布，核心是把「turn」打散：

- **prompt 响应不再代表 turn 结束**，而是返回插入会话的 `messageId`；agent 通过 update 流报同一个 ID。agent 可自行声明 `idle`。
- **后台工作与多 client 观察**成为一等公民 —— `session/update` 可在任意时刻发生。
- 消息/工具调用/终端输出统一用稳定 ID 打补丁（省略即不变，`null` 清空）。
- 权限请求带必填 `title` 和可扩展 `subject`，不再硬绑 tool call。
- diff 从 `oldText`/`newText` 改为结构化 file change（add/delete/modify/move/copy + binary）。

> **判断**：v2 的方向（后台工作、多观察者、可按 messageId 增量消费）恰好是 Overwatch 想要的形态。但**现在应按 v1 实现**，v2 只做前瞻。理由：v1 稳定且实现者最多；v2 尚为 Draft，agent 侧支持面未知。

---

## 4. MCP 作为反向通道

### 4.1 能不能反过来用

能，但**只有一半**。

**已弃用的那一半：`sampling`。** 官方 spec 在 `2026-07-28` 版明确标注：

> **Deprecated**: The Sampling feature is deprecated as of protocol version `2026-07-28` (SEP-2577). … New implementations **SHOULD NOT** adopt it.

也就是说，「让 server 反向请求 client 的 LLM 生成」这条路官方已经不推荐了。

**仍在用的那一半：`elicitation`。** server 可以向 client 请求结构化用户输入，两种模式：
- **form 模式** —— 受限 JSON Schema 收集非敏感数据
- **url 模式** —— 敏感/外部流程（如 OAuth），不在 client 内传输

Client 需在 initialize 时声明 `clientCapabilities.elicitation: { form: {}, url: {} }`。

### 4.2 这条路的实际价值：有限，而且 ACP 已经覆盖

如果 Overwatch 暴露成 MCP server 给外部 agent 调：
- **`elicitation` 可以让 agent「停下来问 Overwatch」** —— 技术上成立。但语义是「向用户收集结构化信息」，不是「向上级请示这个方案行不行」。用它做决策回调属于**语义挪用**，能跑但会积累技术债。
- 更根本的问题：**走 MCP 意味着 agent 是主、Overwatch 是工具**。而 ACP 里 Overwatch 是 client（主），agent 是子进程（从），权限请求天然回流。**要的方向 ACP 直接给，不必绕。**

### 4.3 有没有人在这么做

**有，但形态是「client 把自己的一部分暴露成 MCP server」**，这正是 Gemini CLI 官方文档写明的做法：

> 1. The client implements an **MCP server** that advertises its tools.
> 2. During the ACP `initialize` handshake, the client provides the connection details for its MCP server.
> 3. Gemini CLI connects to the MCP server, discovers the available tools…
> 4. When the model decides to use one of these tools, Gemini CLI sends a tool call request to the MCP server.

**这就是 Overwatch 该用的组合拳**：ACP 当主干（派活 + 收流 + 审批），MCP 当侧路（把自己能力塞给外部 agent 用）。两者不冲突，官方设计如此（ACP 的 "MCP-friendly" 原则就是为此）。

### 4.4 本机实测：`claude mcp serve`

实测 `claude mcp serve` 走 stdio MCP，`initialize` 正常返回：

```json
{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"claude/tengu","version":"2.1.289"}}}
```

`tools/list` 返回 **23 个工具**（与已知实测一致）：`Agent, Glob, Grep, Read, Edit, Write, NotebookEdit, WebFetch, ReportFindings, WebSearch, TaskStop, Skill, DesignSync, EnterWorktree, ExitWorktree, SendMessage, ListAgents, Workflow, CronCreate, CronDelete, CronList, ScheduleWakeup, PowerShell`。

> 注意：这是「把 Claude Code 当工具集暴露出去」，不是「让 Claude Code 回调我们」。且它的权限模型与 `-p` 模式不同，未做长时间实测。

---

## 5. Claude Code 的可编程接口（补齐已知之外的部分）

已知不重复。以下是本次实测补齐的：

### 5.1 有流式接口吗？——有，而且很完整

```
--output-format <format>      text | json | stream-json（仅配合 -p）
--include-partial-messages    流式分片（仅配合 -p + stream-json）
--input-format <format>       text | stream-json（后者为"实时流式输入"）
--replay-user-messages        把 stdin 的用户消息回射到 stdout 做确认
--include-hook-events         把 hook 生命周期事件并入输出流（仅 stream-json）
--forward-subagent-text       把子 agent 的文本/thinking 作为消息转发（仅 -p + stream-json）
```

**实测 `--output-format stream-json --include-partial-messages` 的事件骨架**（本机 2.1.289）：

```
{"type":"system","subtype":"init", ...}          → session_id / tools / model / permissionMode / capabilities / skills / agents / startup_timing
{"type":"system","subtype":"status","status":"requesting", ...}
{"type":"assistant","message":{...,"content":[...]}, ...}
{"type":"result", ...}                            → duration_api_ms / total_cost_usd / usage / num_turns / stop_reason
```

**所以「能不能边跑边收中间结果」的答案是能**，不必等 58 秒。`init` 事件里还白送了 `startup_timing`（各阶段毫秒数）——本机 `input_ready_ms: 11871`，说明光启动就约 12 秒，这解释了 58 秒里相当一部分是固定开销。

> 本次实测受沙箱认证限制（`Not logged in · Please run /login`，`duration_api_ms: 0`），**只验证了事件骨架，未验证 token 级分片**。骨架与官方参数语义一致，但「边跑边收」的粒度需要一次带认证的实跑复核。

### 5.2 有办法拿到「它现在在干什么」吗？——有

三层：
1. **`stream-json` + `--include-partial-messages`** —— 内容级流
2. **`--include-hook-events`** —— 工具调用前后的 hook 事件（`PreToolUse` 等），这是「马上要动手了」的信号
3. **`--forward-subagent-text`** —— 连子 agent 的思考和文本都能看到（带 `parent_tool_use_id`）

这三者组合，等价于 ACP 的 `session/update` 三件套（message / thought / tool_call），只是格式是 Claude Code 私有的。

### 5.3 `--permission-mode` 有哪些值

```
acceptEdits | auto | bypassPermissions | manual | dontAsk | plan
```

（本机 2.1.289 实测 `--help` 输出。注意与常见文档里的 `default`/`acceptEdits`/`plan`/`bypassPermissions` 四值不同，**这版的取值集合更大**。）

配套参数：
- `--permission-prompts host|none` —— `-p` 模式下谁回答权限询问。`host` = SDK host 或 `--permission-prompt-tool`；`none` = 无人回答，该拦的都自动拒绝，但**权限模式本身仍然生效**。
- `--allowedTools` / `--disallowedTools` —— 工具白名单/黑名单
- `--restricted` —— 移除跑代码的内置工具（Bash/PowerShell/REPL），忽略用户/项目/本地设置，把文件工具限制在工作目录内，**拒绝 bypassPermissions**

**`plan` 模式能不能做「只读探查」？——能，而且是官方定位。** `plan` 在权限模式枚举内，配合 `--permission-prompts none` 即「只出方案、不落地」。实测佐证：opencode 的 ACP `mode` 配置项里 `plan` 的描述原文是 *"Plan mode. Disallows all edit tools."* —— 不同 harness 对 `plan` 的语义是一致的。

### 5.4 有没有 hooks 机制

**有，而且可以用于自动化。** 证据来自官方 Claude Agent SDK 文档：

> A **hook** is a Python function that the Claude Code *application* (*not* Claude) invokes at specific points of the Claude agent loop.

关键能力（官方示例原文）：

```python
hooks={
    "PreToolUse": [
        HookMatcher(matcher="Bash", hooks=[check_bash_command]),
    ],
}
```
hook 返回：
```json
{"hookSpecificOutput": {"hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": "..."}}
```

> **这是 Overwatch 保留决策权的第二条通道**：即使不用 ACP，也可以挂 `PreToolUse` hook 做程序化审批。而且它比 ACP 的权限请求更底层——ACP 里 agent **可以**请求权限（`MAY`），hook 则是**必然**触发。

**完整的 hook 事件枚举**（从 `claude-agent-sdk-python` 的 `src/claude_agent_sdk/types.py` 源码读出，`HookEvent` 类型别名，共 8 个）：

```python
HookEvent = (
    Literal["PreToolUse"] | Literal["PostToolUse"] | Literal["PostToolUseFailure"]
    | Literal["UserPromptSubmit"] | Literal["Stop"] | Literal["SubagentStop"]
    | Literal["PreCompact"] | Literal["Notification"]
)
```

> 源码里另有 `SubagentStart` 钩子存在的迹象（`SubagentStartHookInput`），但不在 `HookEvent` 别名内 —— 说明它走的是另一条路径，未进一步核实。
>
> **对 Overwatch 最有用的是 `PreToolUse` + `PostToolUseFailure` + `SubagentStop`**：前者做审批，中者做失败捕获，后者做子 agent 完成通知（对应「手下也有手下」的回报）。


### 5.5 `--include-partial-messages` 之类存在吗

存在（见 5.1）。同类冷门但有用的还有：

| 参数 | 用途 |
|---|---|
| `--json-schema <schema>` | 结构化输出校验，**强制按 schema 返回** |
| `--max-budget-usd <amount>` | **硬性美元预算上限**（仅 `-p`）—— 对应 CLAUDE.md 的「派发必须声明预算」 |
| `--max-turns` | 轮数上限（在 Agent SDK 的 options 里） |
| `--session-id <uuid>` | **指定**会话 ID（不是续写，是创建时指定） |
| `--fork-session` | 续写时新建 ID 而非复用（做分支实验） |
| `--no-session-persistence` | 不落盘，不可 resume（仅 `-p`）—— 隔离性更好 |
| `--bare` | 极简模式：跳过 hooks/LSP/插件/auto-memory/CLAUDE.md 自动发现 |
| `--bg, --background` | **后台会话**，立即返回 ID，`claude logs/attach/stop/rm` 管理 |
| `--agent` / `--agents <json>` | 指定或**内联定义**自定义 agent |

> **`--bg` 值得单独注意**：这是 Claude Code 自带的后台任务模型（`claude agents` 列表、`claude logs <id>` 看输出、`claude attach <id>` 接管）。它和 Overwatch 的「监控 + 接力」有功能重叠，值得评估是否可以复用而非重造。

---

## 6. 各 harness 接口清单

### 6.1 Claude Code（本机 2.1.289）

| 能力 | 结论 |
|---|---|
| 外部驱动 | **能**。`-p` 非交互；`--output-format stream-json` 流式；`--input-format stream-json` 可做成持续会话 |
| ACP | **能**，经 `@agentclientprotocol/claude-agent-acp`（官方 SDK 封装，日更） |
| stdio MCP server | **能**，`claude mcp serve`，实测 23 工具 |
| 后台会话 | **能**，`--bg` + `claude agents/logs/attach/stop` |
| 程序化审批 | **能**，`PreToolUse` 等 hooks + `permissionDecision` |
| 限制 | 认证绑定单账号；`--permission-prompts none` 下未预批的都会被拒；本机沙箱内**认证被拒**，实跑需在宿主进程 |

### 6.2 dsh / DeepSeek Harness（本机桌面版）

| 能力 | 结论 |
|---|---|
| 身份 | `deepseek-ai/deepseek-harness`，MIT，★277k（含大量生态项目 star，见 §8 未知项） |
| 外部驱动 | **能，两条路** |
| ① ACP | **原生**，`dsh --profile acp`。**已实测**：`initialize` 返回 `agentInfo: deepseek-harness-acp v0.0.1`，`session/new` 成功 |
| ② 自有 SDK | 换行分隔 JSON-RPC over stdio。有 **TypeScript** (`@deepseek-ai/dsh-sdk-client`) 与 **Python** (`deepseek-harness-sdk`) 双实现 |
| SDK 方法 | `initialize` / `session/prompt` / `session/query` / `session/resume` / `session/wait` / `session/working-directory/get|set` / `shutdown` |
| SDK 反向通知 | `approval/request`、`user-question/ask`、`session.event`、`session.status`、`subagent.started/finished` |
| 限制 | **ACP server 明确是 "automation-only"**：官方原文说「intentionally omits DSH-specific presentation data and interactive UI features」，且**不支持** `session/load`、删除、fork、additional directories、modes、commands、plans、terminals、client filesystem、elicitation |
| 实测坑 | **往 stdout 写非协议日志**，会污染 ACP 通道（见 §7） |

> **dsh 的 SDK 比它的 ACP 更强**：SDK 有 `subagent.started/finished`、`user-question/ask`、`approval/request`，而 ACP 版本把子 agent、提问、elicitation 都裁掉了。**如果要深度用 dsh，用 SDK；如果要统一多家，用 ACP。**

### 6.3 OpenCode（本机 1.19.2）

| 能力 | 结论 |
|---|---|
| 外部驱动 | **能，三种** |
| ① ACP | **原生** `opencode acp`。**已实测完整一轮成功** |
| ② HTTP server | `opencode serve`（headless）+ `opencode attach <url>` |
| ③ 单次 CLI | `opencode run --format json`（raw JSON events）+ `--session` 续写 + `--agent` + `--model` |
| 优势 | 协议最规范的一家：`sessionCapabilities` 声明了 `close/fork/list/resume` 全套；`configOptions` 自带 `mode`（build/plan）与完整 model 列表 |
| 限制 | 需先 `opencode auth login` |

### 6.4 Codex CLI（本机 0.163.0）

| 能力 | 结论 |
|---|---|
| 外部驱动 | **能**。`codex exec` 非交互，`--json` 输出 JSONL，`-o` 输出最后消息，`--output-schema` 结构化 |
| 会话 | `codex exec resume` / `fork`；`queue` 给已有会话排消息 |
| server 模式 | `codex app-server`（**实验性**），有 `daemon` / `proxy`，还能 `generate-ts` / `generate-json-schema` 导出协议 |
| ACP | 经 `agentclientprotocol/codex-acp` 适配器 |
| 沙箱 | `-s read-only / workspace-write / danger-full-access`，粒度比 Claude Code 更明确 |
| 限制 | `app-server` 标注 experimental；`exec` 与交互式 CLI 的参数不完全互通 |

### 6.5 Gemini CLI

| 能力 | 结论 |
|---|---|
| 外部驱动 | **能** |
| ACP | **原生** `gemini --acp`，有专门文档 `docs/cli/acp-mode.md` |
| 无头模式 | 有 `docs/cli/headless.md` |
| hooks | **有**完整文档（`docs/hooks/`：best-practices / reference / writing-hooks） |
| 其它 | `plan-mode.md`、`session-management.md`、`checkpointing.md`、`rewind.md` |
| 特殊价值 | 官方文档**明确写了双向 MCP 集成**（见 §4.3），是最佳参考范式 |

### 6.6 Aider

| 能力 | 结论 |
|---|---|
| 外部驱动 | **能**（有限）。`--message` 发单条消息、处理、退出（禁用 chat 模式）；`--stream` 控制流式 |
| 协议 | **无 ACP、无 MCP server**（本次未找到） |
| 限制 | 定位是配对编程，不是长任务 agent；无会话生命周期、无权限模型、无结构化事件流 |

### 6.7 OpenHands

| 能力 | 结论 |
|---|---|
| ACP | **有，而且是它的一等产品功能**（不是实验） |
| 形态 | 从「ACP agent profile」启动的对话，把外部 coding agent（**Codex、Claude Code、Gemini CLI、Pi、OpenCode**）作为 **Agent Server 的子进程**运行 |
| 支持细节（源码 feature map `F29-acp-sessions.md` 原文） | 文本实时上屏；每个 tool call 一张卡片，从 `running` 更新到 `completed`/`failed`；编辑落到 workspace 并在 Changes 里显示；Stop 暂停 turn 并把进行中的工具卡置 `failed`；**Agent Server 重启后能 resume 同一 agent session**；模型切换走 agent 上报的模型列表；用量记在 `stats.usage_to_metrics.acp-managed`，**含累计成本** |
| 适配器举例 | `agent_state.acp_agent_name` 里记录的是 `@agentclientprotocol/codex-acp` 这类 |

> **这是本次调研最值得注意的一条外部证据**：OpenHands 已经把「ACP 驱动多个外部 CLI agent + 流式卡片 + 断点续接 + 成本统计」做成了产品。**说明这条路线的可行性不需要我们论证，已经被别人走通了。** 同时也意味着：Overwatch 的差异化**不能**只停留在「能驱动外部 harness」，得落在「围绕用户的公司结构 + 决策权 + 交接」上。

### 6.8 Cline

| 能力 | 结论 |
|---|---|
| ACP | **有**，在 ACP 官方实现者清单内 |
| 定位 | 仓库描述："Autonomous coding agent as an SDK, IDE extension, or CLI assistant" —— 明确有 SDK |
| 限制 | 未实测 |

### 6.9 它们有统一协议吗

**有，而且就是 ACP。** 这不是推测：ACP 官方实现者清单里，Claude Code / Codex / Gemini CLI / OpenCode / Cursor / Copilot / Cline / OpenHands / Goose / Kimi / Qwen Code / Junie / Droid / Mistral Vibe 全在列。

唯一的例外是 **Aider**（未见 ACP 支持）。而 dsh 是"A 原生 + B 自有 SDK"双轨。

> **结论：统一协议这件事已经发生了。我们不需要发明，只需要接上。**

---

## 7. 推荐路径：现在就做「外包给别人的手下」，最短的路

### 路线 A（推荐）：ACP + acpx 作为驱动层

```
Overwatch 主 agent
   │
   ├─ 决策/审批  ←── session/request_permission（反向请求，一票否决）
   ├─ 过程观察  ←── session/update（thought / plan / tool_call / usage）
   │
   └─ acpx（子进程，--format json）
         ├── acpx claude  …          → claude-agent-acp
         ├── acpx deepseek-harness … → dsh --profile acp
         ├── acpx gemini  …          → gemini --acp
         └── acpx codex   …          → codex-acp
```

**为什么是最短的路**：
1. **不用写协议栈**。`acpx --format json` 输出**裸 ACP wire JSON**（官方硬性保证：不加壳、不改名、不注入），我们直接解析 `session/update` 即可。
2. **不用为每家写适配**。30 个内置 profile，我们要的 `claude` 和 `deepseek-harness` 都在里面。
3. **决策权自动归位**。ACP 的权限请求方向就是 agent → client，Overwatch 天然是拍板的那个。
4. **已实测**。`acpx` 端到端驱动 opencode 成功，流式分片与 usage 都拿到了。

**实测证据**（`acpx 0.22.0`，`--format json`）：

```json
{"jsonrpc":"2.0","method":"session/update","params":{"update":{
   "sessionUpdate":"agent_message_chunk","messageId":"msg_1c07...","content":{"type":"text","text":"PRO"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"update":{
   "sessionUpdate":"agent_message_chunk",... "content":{"type":"text","text":"BE"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"update":{
   "sessionUpdate":"agent_message_chunk",... "content":{"type":"text","text":"_OK"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"update":{
   "sessionUpdate":"usage_update","used":9456,"size":200000,"cost":{"amount":0,"currency":"USD"}}}}
{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn",
   "usage":{"inputTokens":7664,"outputTokens":4,"totalTokens":9460,"cachedReadTokens":1792}}}
```

模型自己编的答案是 `PRO`+`BE`+`_OK` 三片 —— **逐 token 到达，不是等结束**。这就是「它现在在干什么」的答案。

### 实现要点（踩过的坑）

1. **不要自己 spawn `npx`**。Windows 上 `spawn` 一个 `.cmd`/`.bat` 需要 `shell:true`，而 `npx` 拉包会超时（本次实测 `claude-agent-acp` 经 npx 初始化超时失败）。**用 acpx 的 argv 配置，或直接指向已装好的可执行文件。**
2. **acpx 在 Windows 上只接受 `argv` 数组**，`--agent "命令 字符串"` 这种逃生舱是 Unix-only。已实测报错原文：*"Raw agent command strings are not supported on Windows. Configure the agent with an argv array."*
3. **acpx 配置位置是 `~/.acpx/config.json`，不是环境变量**。本次实测 `ACPX_CONFIG` 不生效。
4. **外部 agent 往 stdout 写日志 = 协议通道被污染**。本次实测 dsh 通过 acpx 时吐出 `[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s)...`，导致 acpx 报 `Failed to parse JSON message`。dsh 自己的文档也承认这点（*"Stdout carries only protocol traffic, so keep logging off it"*）—— 但它没做到。**必须给每个 harness 做一行一 JSON 的容错跳行**，否则整个通道崩。
5. **会话是持久化 + 可按 ID 续写的**。`session/resume`（v1 已稳定，2026-04-22）重连会话**不重放历史**，比 `session/load` 轻。这意味着 Overwatch 可以把「一次接线」拆成多次 prompt，不必一次说完。

### 路线 B（备选）：Claude Code CLI 直驱

若 ACP 某家实现不给力，退回到 `claude -p --output-format stream-json --include-partial-messages`。
- **优点**：能力最全（`--json-schema`、`--max-budget-usd`、hooks、`--bg`）。
- **缺点**：锁死单一厂商；输出格式是私有的，等于每换一家都要重写一遍解析。**这条路适合做「第一个能跑通的原型」，不适合做架构。**

### 路线 C（不推荐现在做）：A2A

A2A 解决的是「我的 agent 怎么找到并委托给**别人家的、跑在别的服务器上的、不透明的** agent」。它要 agent 卡、HTTP/gRPC、SSE、异步任务状态机。

**我们要的是驱动本机子进程 CLI。** 用 A2A 是拿高射炮打蚊子，而且中间还得自己写一层「A2A → ACP」桥。**除非将来 Overwatch 要跨机器/跨组织调用，否则不要碰。**

### 组合建议

- **主干**：ACP（经 acpx 或自研 client）
- **侧路**：Overwatch 自身暴露成 **MCP server**，通过 ACP 的 `mcpServers` 参数注入给外部 agent（Gemini CLI 官方文档已给出范式）。这让外部 agent 能**主动调用** Overwatch 的工具/查询，与 ACP 的主从关系互补。
- **不要用** MCP `sampling`（已弃用）。
- **MCP `elicitation`** 仅在你确实需要「agent 向用户要结构化信息」时用，别拿来当审批通道。

---

## 8. 未知项（查不到 / 没验到）

### 8.1 严格意义上没查到

1. **dsh 的 277k stars 真实性存疑。** `gh api` 返回 `★277123`，但同组织 `DeepSeek-V3` 是 `★104778`、`R1` 是 `★92004`。一个 2026-08 才发的 harness 超过旗舰模型 2.6 倍，且官方主页只有一句 "Everything is a Plugin."。**建议不要把 star 数当作成熟度证据。** 我没有进一步核实（如 star 增长曲线、fork 比、真实 issue 活跃度）。
2. **OpenHands 的 ACP 支持细节**。~~未拿到~~ → **已补**：它把外部 agent（Codex/Claude Code/Gemini CLI/Pi/OpenCode）作为 Agent Server 子进程运行，有完整的产品级行为规格（见 §6.7）。仍未确认的是它**自己**是否也能被当作 ACP agent 被外部驱动（它是 client，未必是 agent）。
3. **ACP v2 的 agent 侧实际支持面**。v2 是 Draft（2026-07-20），哪些 agent 已经实现了 `messageId` 语义、`idle` 状态、结构化 diff —— 没有查到实现矩阵。
4. **ACP 远程 agent（HTTP/WebSocket）的可用性**。官方明说 *"Full support for remote agents is a work in progress"*，没有时间表。
5. **`a2a` 与 coding CLI 的实际结合案例**。没找到「用 A2A 驱动 codex/claude CLI」的真实项目 —— 这可能反证了它不匹配，也可能只是我没找到。

### 8.2 没验到（受本机环境限制）

1. **Claude Code 的真实流式粒度**。沙箱内 `Not logged in`，`duration_api_ms: 0`，只拿到事件骨架（`system/init → system/status → assistant → result`），**没验证到 token 级 `--include-partial-messages` 分片**。需要一次宿主进程内的认证实跑。
2. **claude-agent-acp 适配器的实跑**。经 `npx` 拉取超时（`FAIL TIMEOUT initialize`），未验证。**这直接关系到「Claude Code 能否走 ACP」—— 目前只有官方清单和 README 佐证，没有本机实跑证据。**
3. **dsh 的 Python/TS SDK**。只读了 README，没装、没跑。但它的 ACP 路径已实测（协议层通，败在账户余额）。
4. **dsh 的 ACP 在「有余额」时的完整行为**。本次卡在 `Insufficient Balance`，所以 `session/update` 的实际流式内容、`session/request_permission` 是否真的会发 —— 都没看到。
5. **hooks 的完整事件列表**。~~未拿到~~ → **已补**：从 SDK 源码 `types.py` 的 `HookEvent` 类型别名读出 8 个事件（`PreToolUse / PostToolUse / PostToolUseFailure / UserPromptSubmit / Stop / SubagentStop / PreCompact / Notification`）。仍未验证的是**每个事件的 payload 字段**与**在 `-p` 模式下 harness 是否都触发**。
6. **`--permission-mode` 的实际语义差异**。拿到了 6 个取值（`acceptEdits/auto/bypassPermissions/manual/dontAsk/plan`），但 `manual` 与 `dontAsk` 的具体边界、与旧文档里 `default` 的对应关系，未验证。
7. **Codex `app-server` 协议**。知道能 `generate-json-schema` 导出，但没导、没读。
8. **多 harness 并行时的资源与成本行为**。ACP 支持多会话并发（一个连接多个 session），但没有实测 Overwatch 同时驱动 5 个 agent 时的表现 —— 而这正是 CLAUDE.md 硬约束 #2 要求的。

### 8.3 需要注意的方法论问题

- **本次大量依赖 ACP 官方 `docs/` 目录的自述**。实现者清单是**自报**的，我没有逐家验证。清单里把 Cline 直接列为 ACP agent 却没给链接，这类条目可信度存疑。
- **`acpx` 是 pre-1.0**（README 原文：*"Treat its CLI and runtime interfaces as evolving"*）。用它做主干意味着接受 API 会变。
- **star 数、日期、版本号都可能被污染**。网络搜索结果里出现过明显不可靠的来源（如声称 dsh ≥18 Node 而官方要求 ^22.19/≥24）。本文凡关键结论都尽量回到仓库原文，但**没有做交叉验证的条目已在上面单列**。

---

## 附：本次实测清单

| 命令 / 探针 | 结果 |
|---|---|
| `claude --help` | 2.1.289；拿到 `--permission-mode` 6 值、全部流式参数、`--bg`、`--bare` 等 |
| `claude -p --output-format stream-json --include-partial-messages` | 事件骨架确认；**认证被沙箱拒绝**（`duration_api_ms: 0`） |
| `claude mcp serve` + `tools/list` | **23 工具**，与已知一致 |
| 自建 ACP client → `opencode acp` | **完整一轮成功**，流式 update + `end_turn` |
| 自建 ACP client → `dsh --profile acp` | **协议层全通**，败在 `Insufficient Balance` |
| `acpx 0.22.0` → opencode（argv 配置） | **端到端成功**，裸 ACP JSON 流，逐 token 到达 |
| `acpx` → dsh | **协议层通**，败在余额不足；且 dsh 污染 stdout 触发 acpx 解析报错 |
| `acpx --agent "命令串"` | Windows 拒绝：必须用 `argv` 数组 |
| `ACPX_CONFIG` 环境变量 | **不生效**；只认 `~/.acpx/config.json` |
| `opencode acp --help` / `run --help` / `codex exec --help` | 确认各家非交互接口 |
| `gh api` 读 ACP / A2A / dsh / acpx / Agent SDK 官方文档 | 协议细节均有原文出处 |

**未运行**：任何长任务（遵守「不浪费 58 秒」要求）；dsh SDK；Codex `app-server`；hooks 实跑。
