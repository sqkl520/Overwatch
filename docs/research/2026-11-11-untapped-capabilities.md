# Claude Code 生态里还没被我们利用的能力

- 日期：2026-11-11
- 作者：探索 Agent X2
- 产出形态：exploration（技术可能性调研）
- 目标对象：Claude Code CLI 2.1.308（Windows x64 单文件 Bun 编译产物，297,376,928 字节，
  `%LOCALAPPDATA%\Claude-3p\claude-code\2.1.308\<hash>\claude.exe`；源码明文在偏移
  126,000,000–140,000,000 与 245,000,000–294,000,000 两段）
- 方法：二进制字符串/源码段直接读取（下称「二进制」+ 字节偏移）、官方文档（`code.claude.com/docs`，
  下称「文档」+ 文件:行号）、本机真实数据（`~/.claude/` 下 transcript 与注册表）、真实 socket 连接测试
- **未做的事**：没有运行 `claude.exe`，没有修改 Overwatch 代码，没有碰 git

> 本文只回答「技术上还能做什么」。凡未实测的，标「未实测」；凡查不到的，直接写查不到。

---

## 0. 结论先行

1. **我们最大的遗漏是 hooks，而且漏掉的正是最关键的那一个：`Stop`。**
   `Stop` hook 在 Claude 每次「准备结束回合」时同步触发，**可以拒绝结束**（`decision:"block"` 或
   exit 2），把理由作为下一轮指令喂回模型；也可以只注入 `additionalContext` 而不激怒用户。
   这不是「技术上可能」——这是平台**内置的**「AI 说要完成时自动触发验证」机制。
   Overwatch 现在整套「判活」体系是**事后从 transcript 反推**状态；`Stop` hook 是**事前**由宿主
   主动告知，且输入里直接给了 `last_assistant_message`（本轮最终回复原文）与
   `background_tasks` / `session_crons`（区分「真的完了」和「在等后台任务」）。
   二进制里 `Stop` 的事件说明原文：「Right before Claude concludes its response」（偏移 128,069,776）。

2. **hooks 一共 33 个事件、5 种处理器类型，不是我们以为的 8 个事件、1 种命令。**
   事件全集（二进制偏移 245,625,744，`var xd=[...]`）：`PreToolUse` `PostToolUse`
   `PostToolUseFailure` `PostToolBatch` `Notification` `UserPromptSubmit` `UserPromptExpansion`
   `SessionStart` `SessionEnd` `Stop` `StopFailure` `SubagentStart` `SubagentStop` `PreCompact`
   `PostCompact` `PreModelSwitch` `PostModelSwitch` `PermissionRequest` `PermissionDenied`
   `Setup` `TeammateIdle` `TaskCreated` `TaskCompleted` `Elicitation` `ElicitationResult`
   `ConfigChange` `WorktreeCreate` `WorktreeRemove` `InstructionsLoaded` `CwdChanged`
   `FileChanged` `DirectoryAdded` `MessageDisplay`。
   处理器类型：`command`、`http`、`mcp_tool`、`prompt`（LLM 判定）、`agent`（带工具的多轮子 agent，
   最多 50 轮）——外加插件级 `function`（in-process JS，见 §1.7）。

3. **「往运行中会话投递指令」不是做不到，是开关没打开。** 有两条**官方**通道：
   ① **channels**（MCP server 推送事件进运行中的会话，research preview）；
   ② **跨会话消息**（`SendMessage` / inbox socket，Windows 需 ≥ 2.1.234，我们是 2.1.308）。
   对②，之前的调研（`2026-11-02-path-a-ipc.md` §结论 3）判定「投递到 bypassPermissions 会话
   只有 0.35 可信度」，理由是「IPC 无法声明 `fromMode`，必然命中 `no-mode-asserted`」。
   **这个结论可以被配置绕过**：`crossSessionInbound: "accept"` 一旦生效，闸门函数在检查
   `fromMode` 之前就返回 `accept`（二进制 277,410,000 区段，`function k(e,n)` 第一行
   `let o=iat(); if(o!==void 0) return h(o);`）。本次实测：从磁盘读到另一会话的 `peerToken`，
   用它建连后连接**保持 5 秒以上**；换 32 位假 token 则 221ms 断开。

4. **transcript 里至少还有 12 类信息我们没取，其中 4 类能直接变成判据**：
   每轮 token/成本（`message.usage`）、权限决策来源（`permissionDecision.source`）、
   重试耗尽（`system/api_error` 的 `retryAttempt>=maxRetries`）、宿主 Stop hook 汇总
   （`system/stop_hook_summary`）。详见 §3。

5. **另有一条完全没用的观测通道：OpenTelemetry。** 8 个指标、约 30 种事件，含
   `hook_execution_complete` 的 `num_blocking` / `additional_context_chars`、
   `subagent_completed` 的 `is_async` / `total_tool_uses`、`api_retry_exhausted`。
   代价是一个环境变量（且**不能**从项目 settings 里打开，见 §2.5）。

6. **明确做不到的**：MCP `sampling`（Claude Code 根本不声明这个客户端能力，二进制
   254,352,905 的 capabilities 字面量里没有 `sampling` 键）；CDP 调试端口（命中即 `exit(1)`）；
   `-p` 里派 agent team 队友；`-p` 里跑插件 monitors；`--bg` 与 `-p` 共存。详见 §5。

---

## 1. Hooks：被严重低估的能力

### 1.1 `Stop` hook 能做什么（这是本报告的核心）

**输入**（文档 `hooks.md:2831`）：`stop_hook_active`、`last_assistant_message`、
`background_tasks`、`session_crons`，加上公共字段 `session_id` / `prompt_id` /
`transcript_path` / `cwd` / `permission_mode` / `effort` / `agent_id` / `agent_type`。

**输出**（文档 `hooks.md:2880-2912`）：

| 返回 | 效果 |
|---|---|
| `{"decision":"block","reason":"..."}` | **拒绝结束**，`reason` 作为 Claude 下一轮指令 |
| exit 2（stderr） | 同上，效果等价（文档 `hooks.md:2903`） |
| `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"..."}}` | 继续对话但不报错，transcript 标为 `Stop hook feedback` |
| 不输出 / exit 0 | 允许结束 |

**这就是「AI 说要完成时自动触发验证」的官方实现。** 写一个 Stop hook：读 `last_assistant_message`
→ 跑测试/检查断言 → 不通过就 `exit 2` 并把失败摘要打到 stderr。模型会收到「你还不能结束，
因为 X」，然后继续干活。

**两条必须知道的约束**（文档 `hooks.md:2833`）：
- `stop_hook_active` 为 `true` 表示「你现在就是被上次 stop hook 拦下来的」，要检查它否则死循环。
- **连续 8 次拦截后被强制放行**。可用 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 提高（二进制
  128,172,609 有该变量）。每调用一次工具，计数归零。

**更省事的等价物：`/goal`。** 文档 `goal.md:106-116` 原文：`/goal` 就是「session 级
prompt-based Stop hook 的内置快捷方式」，且**在 `-p` 下可用**：
`claude -p "/goal CHANGELOG.md has an entry for every PR merged this week"`。
它跑完整个循环才退出。这直接解决了我们「`claude -p` 155 秒 + 静默失败」的一半问题——
至少你知道它是在干活还是卡住了（配 `--output-format stream-json` 可看每一轮）。

**`agent` 型 Stop hook**（文档 `hooks.md:4099-4120`）更进一步：它 spawn 一个**带工具的子
agent** 去验证，最多 50 轮，能读文件、跑命令，返回 `{"ok":true|false,"reason":"..."}`。
样板就是官方给的「所有单测通过才许停」。这就是「验收 Agent」的现成形态——不用我们调度，
写在 settings 里就有。

### 1.2 五种处理器类型（我们之前只知道 `command`）

| type | 说明 | 适用事件 |
|---|---|---|
| `command` | shell 命令，stdin 收 JSON | 全部 |
| `http` | POST JSON 到 URL，响应体同 JSON 输出格式 | 除 `SessionStart`/`Setup` 外全部 |
| `mcp_tool` | 直接调某个 MCP server 的某个工具，参数支持 `${tool_input.file_path}` 插值 | 全部 |
| `prompt` | 单次 LLM 判定，返回 `{ok,reason,impossible}` | 工具类事件 + `Stop`/`SubagentStop`/`UserPromptSubmit`/`TaskCompleted`/`TeammateIdle` |
| `agent` | 带工具的多轮子 agent 判定 | 同上，除 `PermissionRequest` |

`http` 型特别值得注意：**我们不需要写本地 hook 脚本，只要起一个 HTTP 端口，就能让所有会话的
所有事件 POST 过来。** 而且它支持 `headers` + `allowedEnvVars` 做鉴权（文档 `hooks.md:1758-1785`）。
对 Overwatch 来说，这是「把 hooks 变成事件总线」的最短路径。

`prompt` / `agent` 型的意义：**验证逻辑可以用自然语言写，不用写代码**。`prompt` 默认模型是
「后台功能用的那个模型」（可显式指定 `model`），`agent` 默认 Haiku（二进制 135,991,276 起）。

### 1.3 配置在哪、怎么注册

| 位置 | 作用域 | 可共享 |
|---|---|---|
| `~/.claude/settings.json` | 所有项目 | 否（本机） |
| `.claude/settings.json` | 单项目 | **是，可提交** |
| `.claude/settings.local.json` | 单项目 | 否 |
| managed policy settings | 组织级 | 是 |
| 插件 `hooks/hooks.json` + manifest `hooks` 键 | 插件启用期间 | 是 |
| **skill frontmatter** | 调用后整个 session 剩余时间 | 是 |
| **subagent frontmatter** | 该 subagent 运行期间（`Stop` 自动转 `SubagentStop`） | 是 |

技能/子 agent frontmatter 里写 hooks 这条，Overwatch 完全没用到。文档
（`hooks.md:2141-2200`）给了完整例子。限制：`v2.1.304+` 每个技能来源（项目/个人/每个插件）
每 session 最多注册 1,024 个 hook，matcher 总长 16,384（文档 `hooks.md:711`）。

**热重载**：文档 `hooks.md:736` 原文「Direct edits to hooks in settings files are normally
picked up automatically by the file watcher.」——改 settings 里的 hook 不用重启。

**注册顺序**：多层 settings 的 hooks 是**合并**而非覆盖（文档 `hooks.md` Hook locations 节）。

### 1.4 那些「一看就很有用但我们没做」的 hook 配置项

从二进制 zod schema（偏移 245,655,845 附近）读出的**完整字段集**，文档里分散在各处：

| 字段 | 作用 | 文档 |
|---|---|---|
| `async: true` | 后台跑，不阻塞 | `hooks.md:453`、`hooks.md:4144` |
| `asyncRewake: true` | 后台跑，**exit 2 时把模型叫醒**（隐含 async） | 二进制 245,655,845 |
| `rewakeMessage` / `rewakeSummary` | 唤醒时给模型的前缀 / 给用户的一行摘要（`@internal`） | 同上 |
| `once: true` | 跑一次后自动移除（**仅 skill frontmatter 生效**） | `hooks.md:425` |
| `if: "Bash(git *)"` | 用权限规则语法过滤，**不匹配就不 spawn 进程** | `hooks.md:422` |
| `timeout` | 秒 | `hooks.md:445-456` |
| `onFailure: "block"` | hook 自己失败（脚本缺失/超时/JSON 非法）时算作 exit 2 | `hooks.md:456`、`hooks.md:930` |
| `statusMessage` | spinner 里显示的文案 | `hooks.md:445` 区段 |
| `args: []` | **exec form**：`command` 当可执行文件直接 spawn，不过 shell | `hooks.md:452`、`hooks.md:458` |
| `shell: "powershell"` | 强制指定解释器（`bash` \| `powershell`） | `hooks.md:458` 区段 |
| `cloud: "device" \| "skip"` | 云会话被本机驱动时是否在本机跑（`@internal`） | 二进制 245,656,106 |

`if` 字段值得单独说：它用**权限规则语法**匹配「工具名 + 参数」，所以 `"Edit(*.ts)"` 只在
TypeScript 文件上触发。这是唯一能避免「每个 hook 都 spawn 一次进程」的机制。

### 1.5 hook 输出的硬上限

文档 `hooks.md:1078`：`additionalContext` / `systemMessage` / `initialUserMessage` /
纯 stdout 合计上限 **10,000 字符**。超了会落盘，并以 `num_outputs_persisted` 计数
（`monitoring-usage.md` Hook execution complete 事件）。我们的草稿动辄几千字，要注意。

`PostToolBatch`（二进制 128,068,004）是**每批工具调用只触发一次**（不是每个工具一次），
适合「一次注入整批上下文」。

### 1.6 `StopFailure`：这是「宿主上报的 FAILED」的正面信号

二进制 275,153,052 的事件说明：「Fires instead of `Stop` when an API error (rate limit,
auth failure, etc.) ended the turn. Fire-and-forget — hook output and exit codes are ignored.」
matcher 可按 `error` 类型过滤：`rate_limit` `overloaded` `authentication_failed`
`oauth_org_not_allowed` `account_on_hold` `billing_error` `invalid_request`
`model_not_found` `server_error` `max_output_tokens` `cloud_credential_error` `unknown`
（文档 `hooks.md:2923` 区段）。

**这意味着「会话因为 API 错误挂了」不再需要我们从 transcript 猜——挂个 `StopFailure`
hook 就有确定信号。** README 说「实际产出有区分度的只有宿主上报的 FAILED/BLOCKED」，
`StopFailure` 正好补上「失败但宿主没标 FAILED」这一类。

### 1.7 插件级 `function` hook（in-process JS）：文档之外的拦截层

二进制 135,998,075 起的插件 `hooks.json` schema 提到一个 `modules` 键：

> 「The hooks module: one path, relative to this hooks.json, of a module exporting
> `register(on)`. ... What it hooks and calls is read from its source before it loads;
> `claude plugin validate` shows the result.」

对应文档 `plugins/mods/events.md`。它跑在 Claude Code **自己的进程内**，事件是另一套：
`tool.call`、`tool.check`、`prompt.submit`、`turn.start`、`turn.step`、`turn.complete`、
`settings.read`、`classic.<HookEvent>`（即所有经典 hook 事件的镜像）。

两个能力是 settings hook 做不到的：
- **`turn.step` 可以改模型**：`yield* next({ ...e, model: 'haiku' })`——请求发出去前换掉模型。
  也能读到 `result.usage`（`input_tokens` / `output_tokens` / `cache_read_input_tokens` /
  `cache_creation_input_tokens`）。
- **`settings.read` 可以改/拒绝会话设置**——包括 Claude Code 自己的那次读取。

代价：要装成插件（`--plugin-dir` 可临时加载），且官方有个「built-in guard」会拦掉部分 hook。
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` 是这个特性的开关（二进制 245,954,394）。

---

## 2. 其他没探索的能力

### 2.1 Channels：往运行中的会话推事件（官方，research preview）

**这是「无法向运行中会话注入指令」这条结论的唯一官方反例。**

机制（文档 `channels-reference.md:30-56`）：写一个普通 MCP server，声明
`capabilities.experimental['claude/channel'] = {}`，然后调
`mcp.notification({method:'notifications/claude/channel', params:{content, meta}})`。
Claude Code 收到后，把内容作为 `<channel source="..." ...>正文</channel>` 塞进模型上下文，
**模型立刻开始处理**。

最小实现是一个 30 行的 TS 文件（文档 `channels-reference.md:75-140`）：stdio MCP server +
一个本地 HTTP 端口，任何 POST 过来的内容都转发进会话。启动：
`claude --dangerously-load-development-channels server:webhook`。

**还能反向**：声明 `capabilities.experimental['claude/channel/permission'] = {}` 后，
Claude Code 把权限提示推给 channel server（`notifications/claude/channel/permission_request`，
带 `request_id` / `tool_name` / `description` / `input_preview`），远端回
`notifications/claude/channel/permission` + `behavior: allow|deny` 即可。
**本地终端对话框和远端同时有效，谁先答谁生效。**（文档 `channels-reference.md:436-500`）

**限制（决定了它对 Overwatch 的可行性）**：
- 需要 claude.ai 或 Console API key 认证；Bedrock/Vertex/Foundry 不可用。
- `--channels` 只接受 Anthropic 维护的 allowlist（Telegram / Discord / iMessage / fakechat）。
  自建的必须走 `--dangerously-load-development-channels`，**每次启动弹一个全屏确认框**。
  → 这条通道适合「人在旁边」，不适合无人值守。
- 事件只在会话开着时到达。`-p` 模式下可用（文档 `channels.md:276`），但同样需要那个 flag。
- 官方明说事件送达**没有 ack**：`mcp.notification()` 的 await 只保证写进 transport，
  会话没加载或策略拒绝就**静默丢弃**。

### 2.2 跨会话消息：官方 API，且闸门可以被配置打开

文档 `cross-session-messaging.md` 全文。要点：

- 每个会话绑一个 inbox：Unix socket（macOS/Linux）或**命名管道**（Windows）。
  路径在 `/status` 的 `Peer address` 行，也通过环境变量 `CLAUDE_CODE_MESSAGING_SOCKET`
  导出给 hooks 和 Bash 命令；配套 token 是 `CLAUDE_CODE_MESSAGING_TOKEN`。
- Windows 上**必须**先发一行 `{"type":"auth","token":"<token>"}`，否则连接立刻关闭。
- 消息在服务端是**纯文本**，到达后作为一条 user 消息进入队列；它**不能**代替你批准权限、
  不能改配置、里面的 `/命令` 不会执行（文档 `cross-session-messaging.md:161-170`）。
- 发消息的工具是 `SendMessage`，发现是 `ListAgents`（`/list-agents`、`/peers`）。
- `SendMessage` 支持 `notify_when_idle`：**订阅「那个会话下次空闲时通知我一次」**，
  不花对面 token，12 小时过期（文档 `cross-session-messaging.md:80-108`）。
- `-p` 也能绑 inbox，所以长跑 worker 可以被消息叫醒。要无人值守接收，把它启动时带
  `--settings '{"crossSessionInbound":"accept"}'`。

**本次实测（真实连接，未发消息）**：

| 实验 | 结果 |
|---|---|
| 本机枚举 `\\.\pipe\`（2026-11-11 两次采样） | 1,440–1,492 个管道，其中 `LOCAL\cc-msg-*` **14–17 个** |
| `~/.claude/sessions/*.json` | 14 条记录，**14 个 pid 全部存活** |
| 读 `~/.claude/sessions/<pid>.<sha256>.key` | 拿到 `peerToken`（32 hex），**未提权** |
| 用该 token 连另一会话（name=`shapez`, pid=10504）的管道 | 连接保持 **5,012ms**（未断） |
| 同一管道换 32 位假 token | **221ms** 断开 |

结论：认证是「同用户即信任」级别。**关键增量在于**：闸门函数
（二进制 277,410,000 区段的 `function k(e,n)`）的判定顺序是

```
let o = iat();                 // 读 crossSessionInbound
if (o !== void 0) return h(o); // accept/hold/refuse 直接生效
if (e?.selfSent) return {policy:"accept"};
...  // 只有到这里才会比较 fromMode，才可能出 no-mode-asserted
```

所以只要用户 settings 里写了 `"crossSessionInbound": "accept"`，
**`fromMode` 根本不参与判定**，之前「必然命中 `no-mode-asserted`」的推理不成立。
注意作用域：项目/本地 settings 只能写更严的值，`accept` 必须写在 user settings 或 `--settings` 里
（文档 `settings-reference.md:4672-4700`）。

**完全未被记录的 flag**：`--messaging-socket-path <path>`（二进制 126,148,384）。
官方 `claude --help` 里有，但`docs/en/*.md` 全部 grep 不到。它允许给会话指定一个固定
管道名，外部桥接进程不用每次去猜。

### 2.3 斜杠命令 / skills / plugins / marketplace

- **skills 与 custom commands 已合并**：`.claude/commands/deploy.md` 和
  `.claude/skills/deploy/SKILL.md` 都产生 `/deploy`（文档 `skills.md` 开头）。
- frontmatter 里能做我们没想到的事：`context: fork`（在子 agent 里跑）、`agent: Explore`
  （指定用哪个子 agent）、`background: false`（同步等结果）、`model:` / `effort:`
  （只影响当前回合）、`allowed-tools:`（当前回合免审批）、`disallowed-tools:`、
  `disable-model-invocation: true`（只能人手动触发）、`hooks:`（见 §1.3）。
- `${CLAUDE_SKILL_DIR}` / `${CLAUDE_PROJECT_DIR}` / `${CLAUDE_PLUGIN_ROOT}` 在
  **正文和 `allowed-tools` 两处都替换**，因此可以做到「跑自己带的脚本不弹权限框」。
- **marketplace 可以完全本地**：`claude plugin marketplace add ./path`，
  文档 `plugins/cli-reference.md` 见 `Invalid marketplace source format. Try: owner/repo,
  https://..., or ./path`（二进制 126,175,548 区段）。→ 我们的东西可以**只靠一个目录分发**。
- `"claude plugin validate"` 能静态检查插件（含 hooks 模块的调用面）。

### 2.4 子 agent 的创建与通信

- 子 agent transcript 落在 `<session>/subagents/agent-<id>.jsonl`，**配套一个
  `.meta.json`**：`{agentType, description, toolUseId, spawnDepth, requestShape,
  requestNonInteractive}`（本机实测，Overwatch 已递归收集 `agent-*.jsonl`，但**没读 meta**）。
- 本机共 **5,044 个**子 agent transcript 文件。
- `SubagentStart` / `SubagentStop` hook 提供 `agent_id` / `agent_type` /
  **`agent_transcript_path`** / `last_assistant_message`（文档 `hooks.md:2678`）——
  不用扫目录就知道子 agent 什么时候起停、结果是什么。
- 子 agent 之间能互相发消息（需 Claude 给它们命名，文档 `agent-teams.md`）。
- `--forward-subagent-text`（+ `--output-format stream-json`）能在**流里**拿到子 agent 的
  文本和 thinking，带 `parent_tool_use_id` 可还原整棵树（文档 `cli-reference.md:95`）。

### 2.5 OpenTelemetry：一整条没用的观测管道

文档 `monitoring-usage.md`。开关是**环境变量**，不是 settings：

```
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_METRICS_EXPORTER=otlp|prometheus|console
OTEL_LOGS_EXPORTER=otlp|console
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
```

8 个指标：`session.count`、`lines_of_code.count`、`pull_request.count`、`commit.count`、
`cost.usage`、`token.usage`、`code_edit_tool.decision`、`active_time.total`。
`token.usage` 带 `type`（input/output/cacheRead/cacheCreation）、`model`、`query_source`
（main/subagent/auxiliary）、`agent.name`、`skill.name`、`mcp_server.name`。

约 30 种事件，与我们最相关的几个：
- `claude_code.hook_execution_complete`：`num_blocking`、`num_non_blocking_error`、
  `total_duration_ms`、`additional_context_chars`、`num_outputs_persisted`。
- `claude_code.subagent_completed`：`is_async`、`total_tool_uses`、`duration_ms`、
  `model_swapped`、`total_tokens`。
- `claude_code.compaction`：`pre_tokens` / `post_tokens` / `precompute_reuse`。
- `claude_code.api_retry_exhausted`、`api_error`（带 `error` 分类）。
- `claude_code.tool_decision`：`decision` + **`source`**（`config` / `hook` /
  `user_permanent` / `user_temporary` / `user_abort` / `user_reject`）。

**硬约束**：`CLAUDE_CODE_ENABLE_TELEMETRY`、`OTEL_*_EXPORTER`、`OTEL_EXPORTER_OTLP_*`
**不能**从项目或本地 settings 的 `env` 块生效（文档 `settings-reference.md:2468-2487`）。
必须写在 user settings、`--settings`、或启动环境里。这解释了为什么它一直没被发现——
从项目配置里写是无效的，而且 2.1.282 起还会给警告。

### 2.6 其他被忽略的开关

- **`--include-hook-events`**：`-p --output-format stream-json` 下把 `hook_started` /
  `hook_progress` / `hook_response` 打进流（文档 `cli-reference.md:100`）。
  **这是从外部观测 hook 生命周期的唯一方式**，且不需要装任何东西。
- **`--input-format stream-json`**：多轮输入，配合 `--replay-user-messages` 做 ack。
  这意味着**一次 `-p` 进程可以喂多轮**——不用每次重启（省掉我们测到的 155 秒启动）。
- **`--json-schema`**：结构化输出校验，结果在 `structured_output` 字段。
- `--max-turns`、`--max-budget-usd`、`--task-budget`（`output_config.task_budget`）。
- `--session-id <uuid>`：自己指定会话 ID（写 transcript 时可预测路径）。
- `--fork-session`：在 `--resume` 时开新 ID，不动原会话。
- `--bare`：跳过 hooks / skills / plugins / MCP / CLAUDE.md 的自动发现，启动更快。
  **注意**：`--bare` 连 hooks 都不跑（文档 `headless.md:61`），要用 hooks 的地方别开。

### 2.7 二进制里有但 `docs/en/*.md` 查不到的 CLI flag

（全部来自 `claude --help` 文案段的二进制读取，偏移 126,131,500–126,152,000）

`--messaging-socket-path`、`--session-mirror`（SDK 内部：在 stdout 发 transcript_mirror 帧）、
`--await-claim`（预热备用进程，等 `claim_session` 控制请求）、`--await-initialize`、
`--reply-on-resume`、`--host-auth-is-org-sign-in`、`--hard-fail`、
`--system-prompt-snapshot <on|off>`、`--enable-auth-status`、`--thinking <mode>`、
`--thinking-display`、`--brief`（启用 `SendUserMessage` 工具，让 agent 主动找人说话）、
`--agent-id` / `--agent-name` / `--team-name` / `--agent-color` / `--teammate-mode` /
`--agent-type`（agent team 用的）、`--sdk-url`（`-p` 时用远端 WebSocket 做 SDK I/O）、
`--attach-serve`、`--correlation-id`、`--pool`、`--on-branch`、`--plugin-dir-no-mcp`。

其中 `--sdk-url` 和 `--await-claim` 值得单独留意：前者意味着 **SDK 协议可以跑在 WebSocket 上**，
后者意味着**可以预先热身一个进程**，等派活时才绑定会话——这直接对冲我们测到的 155 秒启动。
（未实测，这两个都是 SDK 内部用途，没有文档保证稳定性。）

### 2.8 会话注册表里我们没用到的字段

`~/.claude/sessions/<pid>.json` 本机字段（2026-11-11 采样 14 条，字段并集）：

```
pid sessionId cwd startedAt procStart version peerProtocol peerFeatures kind entrypoint
pidDomain messagingSocketPath name nameSince updatedAt status statusUpdatedAt
hostSessionId nameSource waitingFor asksForConvertedSkills
```

Overwatch 已经用了 `status` / `waitingFor` / `statusUpdatedAt` / `hostSessionId`。
**没用的**：`messagingSocketPath`（= 可投递地址）、`peerFeatures`（`["notify_idle",
"artifact_yield"]`）、`version`（跨版本兼容判断）、`procStart`（防 PID 复用）。

`waitingFor` 的完整取值（二进制 281,419,886 起的表）：`input needed`、
`permission prompt`、`sandbox request`、`dialog open`、`worker request`、`goal proposal`。
最后两个是 2.1.308 才有的（`goal proposal` = Claude 主动提议设一个 session goal）。

---

## 3. transcript 里还没被提取的信息

**统计口径**：`~/.claude/projects` 下**全部顶层会话文件**，采样于 2026-11-11 本次调研期间。
语料是活的（本次会话本身就在往里写），两次采样在几分钟内从 261 涨到 278 文件，
因此下表数字应视为**数量级**而非精确快照。子 agent 文件（`**/subagents/*.jsonl`）
共 **5,044 个**，未计入下表。

Overwatch 目前只取 timestamp / role / tool_use / tool_result / 文本。

| # | 字段 | 数量级 | 能判断什么 | 可用性 |
|---|---|---|---|---|
| 1 | `message.usage.{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}` | 每条 assistant 消息 | **每轮真实 token 与缓存命中**。可算「这轮涨了多少上下文」「缓存是不是重建了」 | 直接可用 |
| 2 | `{"type":"cost-state", totalCostUSD, modelUsage, totalAPIDuration, totalToolDuration, startTime}` | **191 条 / 88 个文件有**；其中 **76 个（86%）落在文件最后 3 行** | 会话总成本、按模型的 token 分解、API 等待 vs 工具耗时。**在文件末尾**，尾部读取就够 | 直接可用 |
| 3 | `system/api_error` → `{error.status, error.connection.code, retryAttempt, maxRetries, retryInMs, source}` | **6,022 次重试**；**143/278 会话**至少一次；**231 次耗尽**（173 次之后模型仍出话，58 次直接结束） | **「这个会话刚撞上 502/429/ECONNRESET」的确定信号**，以及「重试已耗尽」 | 直接可用，强烈建议 |
| 4 | `permissionDecision: {decision, source, reasonCode, grantScope}` | **31,923 条**。分布：`config` 31,826 / `user_temporary` 90 / `user_permanent` 3 / **`hook` 3** / `user_reject` 1 | `source=config` = **没问人、规则自动批**；`user_*` = 真的有人点过；**`hook` = 某个 hook 做的决定** | 直接可用 |
| 5 | `system/stop_hook_summary` → `{hookCount, hookInfos, hookErrors, hookAdditionalContext, preventedContinuation, stopReason, hasOutput}` | **4,884 条**，`entrypoint` 分布：`claude-desktop-3p` 4,858 / `cli` 26 | **宿主自己就在跑 Stop hooks**（`command:"callback"`，每会话 2 个）。实测 `preventedContinuation` / `hookErrors` / `hookAdditionalContext` / `hasOutput` **全为 0/false**——这些宿主 hook 只观察不干预。可用来判断「这一回合有没有被拦」 | 直接可用 |
| 6 | `message.model` | 每条 assistant | 模型切换记录。实测跨 25 种模型 id（`SCNet-Max` 214,306 / `deepseek-ai/deepseek-v4.1-flash` 58,045 / `muse-spark-1.3-contributor` 5,903 / `claude-opus-5` 1,939 / …）。`<synthetic>` 511 条 = **宿主伪造的消息**（错误/中断），不是模型输出 | 直接可用 |
| 7 | `message.content[].type === "thinking"` 块 | **130,816 条** assistant 消息含 thinking（占 assistant 消息 44.1%） | 模型的内部推理。**数量太大，不适合当触发信号** | 可用，慎用 |
| 8 | `[Request interrupted by user]` 文本 | **270 次** | 人打断。**这是「人不耐烦了」的硬信号**，比任何推断都准 | 直接可用 |
| 9 | `attachment` **35 类**（不是我们以为的 18 类） | 见下表 | 其中 `hook_additional_context`（179 条）直接证明 **hook 注入上下文真的在发生** | 大部分可用 |
| 10 | `{"type":"api-request", params:{model,betas,max_tokens,thinking,output_config}}` + `api-request-blob` + `api-request-shape` | 25,489 / 42,212 / 99 | 请求的实际形状：用了哪些 beta、thinking 配置、effort。`shapeHash` 相同 = prompt 结构没变 | 可用（`blob` 很大，别全读） |
| 11 | `{"type":"queue-operation", operation:"enqueue"/"dequeue"/"remove"/"popAll", reason:"absorbed_mid_turn"}` | 8,769 / 3,233 / 5,525 / 3 | **用户排队消息的出现与被吸收**。`remove` + `reason` 能看出「这条消息没被单独回答，被并进了别的回合」 | 可用 |
| 12 | `{"type":"file-history-delta"/"file-history-snapshot", trackingPath, backup:{backupFileName, version}}` | 2,700 / 2,613 | 每次文件改动的**版本号**。可统计「改了哪些文件、改了几版」 | 可用 |
| 13 | `{"type":"mode", mode:"normal"}` / `{"type":"permission-mode", permissionMode}` | 18,440（**全是 `normal`**）/ 594 | 权限模式**变更历史**。实测分布 `bypassPermissions` 515 / `auto` 39 / `acceptEdits` 26 / `plan` 10 / `default` 4 | 可用（`mode` 无用） |
| 14 | `{"type":"system", subtype:"compact_boundary", compactMetadata:{trigger,preTokens,durationMs,preservedSegment}}` | 127 | 压缩发生点、压缩前 token、耗时 | 可用 |
| 15 | `{"type":"atis-latch"}` / `last-prompt` / `custom-title` / `agent-name` / `agent-setting` | **22,233** / 899 / 835 / 817 / 1 | 无害但**不适合做判据**（`atis-latch` 数量巨大且无语义） | 跳过 |
| 16 | `isSidechain` / `parentUuid` / `logicalParentUuid` / `agentId` / `toolUseID` | 524,829 条带 `isSidechain` | 重建对话树与子 agent 归属 | 可用 |
| 17 | `entrypoint` / `version` / `gitBranch` / `userType` / `cwd` | 每条 | 跨版本行为差异（本机同时存在 2.1.270 / 2.1.289 / 2.1.308 / 2.1.322 的会话） | 可用 |

### attachment 类型明细（全语料实测，35 类）

只列有解释价值的；`total_tokens_reminder` 一类恒定的已聚合。

| type | 次数 | 内容 | 价值 |
|---|---|---|---|
| `total_tokens_reminder` | **92,432** | `<total_tokens>N tokens left</total_tokens>` | **剩余预算的实时读数**。占全部 attachment 的 85%，别存 |
| `environment` | 5,583 | `{workingDirectory, isWorktree, isGitRepo, additionalWorkingDirectories, platform, shell, osVersion}` | 高 |
| `queued_command` | 3,751 | 排队中的用户指令 | 高 |
| `edited_text_file` | 1,766 | 被外部编辑过的文件内容 | **高**（「文件在会话外被改了」） |
| `prompt_snapshot` | 722 | 整个 systemPrompt 快照 | 巨大，别全读 |
| `skill_listing` | 414 | 技能清单 | 中 |
| `file` | 398 | 附件文件 | 低 |
| `model` / `instructions` | 367 / 366 | 当前模型 / CLAUDE.md 内容 | 中 |
| `agent_listing_delta` | 337 | 可用的子 agent 类型清单 | 中 |
| `session_context` | 334 | 会话上下文（实测为空对象） | 无 |
| `deferred_tools_record` | 330 | 被推迟的工具 | 中 |
| `compact_file_reference` | 214 | 压缩时保留的文件引用 | 中 |
| **`hook_additional_context`** | **179** | **hook 注入给模型的上下文** | **高——hooks 真的在改动上下文，这是证据** |
| `todo_reminder` | 163 | 待办提醒 | 中 |
| `remote_session_change` | 142 | 远端会话变化 | 中 |
| `task_reminder` | 133 | 待办提醒 | 低 |
| `nested_memory` | 70 | 嵌套 CLAUDE.md 记忆 | 中 |
| `mcp_instructions_delta` | 43 | MCP server 的 instructions | 中 |
| `task_status` | 22 | `{taskId, taskType:"local_agent", description, status, outputFilePath}` | **子 agent 完成 + 输出文件路径** |
| `plan_mode` / `plan_mode_exit` / `plan_mode_reentry` | 17 / 32 / 1 | 计划模式进出 | 中 |
| `command_permissions` | 18 | 命令权限 | 中 |
| `date` / `date_change` | 759 / 19 | 当前日期 | 低 |
| `dynamic_skill` | 10 | 动态加载的技能 | 中 |
| `auto_mode` / `auto_mode_exit` | 8 / 2 | auto 模式进出 | 中 |
| `budget_usd` | 3 | `{used, total, remaining}` | **预算** |
| `ultra_effort_enter` / `ultra_effort_exit` | 3 / 2 | effort 切换 | 中 |
| `already_read_file` / `read_truncation_notice` | 2 / 2 | 文件已读 / 读取被截断 | 低 |
| `plan_file_reference` | 2 | 计划文件引用 | 中 |
| `workflow_keyword_request` | 1 | 请求进入 workflow | 中 |
| `opened_file_in_ide` | 1 | 在 IDE 里打开了文件 | 低 |

**判据建议（按信噪比排序）**：
1. `system/api_error` 的 `retryAttempt>=maxRetries` —— 「重试耗尽」，最硬的失败信号。
2. `[Request interrupted by user]` —— 「人打断了」，最硬的「不耐烦」信号。
3. `permissionDecision.source` —— 区分「config 自动批」/「真的有人批」/「hook 决定」。
4. `stop_hook_summary.preventedContinuation` —— 「停止被拦」。
5. `cost-state.totalCostUSD` 的增量 —— 成本燃烧速率（且在文件尾部，读取成本低）。
6. `attachment.type==="task_status"` + `status` —— 子 agent 起停（比扫目录准）。
7. `queue-operation` 的 `remove` + `reason:"absorbed_mid_turn"` —— 消息被吞。
8. `attachment.type==="hook_additional_context"` —— 有 hook 在改上下文（只在装了 hook 的机器上出现）。

**不建议当判据**：`thinking`（13 万条，占 assistant 消息 44%，文本长语义弱）、
`atis-latch`（22,233 条无语义记录）、`mode`（18,440 条全是 `normal`）、
`total_tokens_reminder`（9.2 万条，占 attachment 85%，只在预算快耗尽时才有信息量）。

---

## 4. 其他 harness：同一套抽象已经存在，但不在 transcript 格式上

### 4.1 Codex CLI（本机 0.163.0，`@openai/codex`）

**hooks 系统与 Claude Code 高度同构**（源码 `codex-rs/protocol/src/hooks.rs`）：

```
HookEventName = preModelRequest | postModelRequest | preToolUse | permissionRequest |
                postToolUse | preCompact | postCompact | sessionStart | sessionEnd |
                userPromptSubmit | subagentStart | subagentStop | stop | interrupt
```

处理器类型：`command`（带 `commandWindows` 分平台字段）、`mcp_tool`、`prompt`、`agent`。
执行模式 `sync` / `async`。

**`Stop` hook 的输出 schema 与 Claude Code 几乎逐字相同**
（`codex-rs/hooks/schema/generated/stop.command.output.schema.json`）：

```json
{"continue": true, "decision": "block", "reason": "...", "stopReason": null,
 "suppressOutput": false, "systemMessage": null}
```

输入也带 `hook_event_name` / `stop_hook_active` / `last_assistant_message` / `model` /
`permission_mode` / `session_id`（后者枚举是 `default|acceptEdits|plan|dontAsk|bypassPermissions`
—— 连模式名都一样）。**一个 Stop hook 脚本可以两边通用。**

差异：Codex 的 `additionalContext` 有 token 阈值（`additionalContextLimit`，默认 2,500 token，
超了落盘并附恢复元数据），Claude Code 是 10,000 字符。

**transcript 格式不同**：`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`，
每行 `{timestamp, ordinal, type, payload}`。`type` 实测有：`session_meta`、`turn_context`、
`world_state`、`token_usage_record`、`response_item/message`、`response_item/reasoning`、
`event_msg/token_count`、`event_msg/thread_settings_applied`、`event_msg/item_completed`、
`event_msg/task_started`、`event_msg/task_complete`、`event_msg/turn_aborted`。
另外 `~/.codex/session_index.jsonl` 是 `{id, thread_name, updated_at}` 的索引。

### 4.2 Gemini CLI

hooks（`docs/hooks/reference.md`）：`BeforeTool` `AfterTool` `BeforeAgent` `AfterAgent`
`BeforeModel` `BeforeToolSelection` `AfterModel` `SessionStart` `SessionEnd` `Notification`
`PreCompress`。**exit code 语义完全一致**：0 成功、2 阻断（stderr 作拒绝理由）、其他警告。
输出字段 `systemMessage` / `suppressOutput` / `continue` / `stopReason` / `decision` /
`reason` —— 又一套同构。

**但没有 Stop hook**：它的「agent 结束」是 `AfterAgent`，定位是「观察 + 可打断」，
没有 `last_assistant_message` 这种「本轮最终回复」字段。→ **跨 harness 的「完成时验证」
只有 Claude Code 和 Codex 能对齐，Gemini 对不齐。**

transcript：`session-*.json`（**不是 JSONL**），带 `TokensSummary`
`{input, output, cached, thoughts, tool, total}`。结构完全不同。

### 4.3 结论：能统一的是「hook 协议」，不是「transcript 格式」

- **hook 协议层已经事实上统一了**：Claude Code 和 Codex 的 Stop hook 输入/输出可以共用一套脚本；
  Gemini 除了缺 Stop 之外，输出字段也兼容。
- **transcript 格式无法统一**：三家分别是 JSONL+`type`、JSONL+`{type,payload}`、JSON+结构化记录。
  写一个「同一套解析器」等于写三个解析器加一层抽象，收益不抵成本。
  更划算的是**统一在 hook 层**：每个 harness 各写 5 行 hook 脚本，产出同一种事件 JSON。
- 已有跨 harness 统一抽象：**ACP**（不是 transcript 抽象，是驱动抽象）。
  `2026-11-04-external-harness-protocols.md` 已详述，此处不重复。ACP 管「怎么驱动」，
  hooks 管「怎么观察」，两者正交。

---

## 5. 反向：技术上做不到 / 不该做

### 5.1 确定做不到（有证据）

| 想做的事 | 结论 | 证据 |
|---|---|---|
| MCP server 反向调 Claude 做一次模型调用（`sampling`） | **做不到** | Claude Code 的客户端能力字面量（二进制 254,352,905）：`function ke(){return{roots:{listChanged:!0},elicitation:{},...}}` —— **没有 `sampling` 键**。SDK 里 `"Client does not support sampling (required for ...)"` 是它的错误分支（偏移 129,826,744） |
| CDP 调试端口注入 | 做不到 | 在开关黑名单里，命中即 `exit(1)`（`2026-11-02-host-interfaces.md` §结论 4） |
| `-p` 里派 agent team 队友 | 做不到 | 文档 `agent-teams.md:60`「Spawning teammates also requires an interactive session. In non-interactive mode with the `-p` flag ... Claude doesn't spawn teammates」 |
| `-p` 里跑插件 monitors | 做不到 | 文档 `plugins/components.md:587`「plugin monitors don't start in non-interactive mode with the `-p` flag」 |
| `--bg` 与 `-p` 共存 | 做不到 | 文档 `headless.md:21`「Claude Code rejects `--bg`」 |
| `--bare` + hooks | 做不到 | 文档 `headless.md:61`「Hooks still don't run in bare mode」 |
| 从项目 settings 打开 OTEL | 做不到 | 文档 `settings-reference.md:2468-2487`，只有「关掉」的值能生效 |
| 用 hook 改「已发生的」工具结果 | 做不到 | `PostToolUse` 只能 `additionalContext` 或 `decision:block`，不能改 `tool_response` |
| 卸载/禁用单个 hook 而保留配置 | 做不到 | 文档 `hooks.md:734`「There is no way to disable an individual hook while keeping it in the configuration」 |

### 5.2 能做但会被平台判定为违规 / 不可持续

| 做法 | 为什么不该做 |
|---|---|
| 用 `--dangerously-load-development-channels` 做无人值守投递 | 每次启动弹全屏确认框，需要人点「I am using this for local development」。把它自动化 = 绕平台的安全确认，且 channels 是 research preview，协议随时会变 |
| 直接读 `~/.claude/sessions/*.key` 拿 `peerToken` 往别的会话投递 | 技术上可行（本次实测认证通过），但这是**冒用会话身份**。平台明确说消息「永远不算你的同意」，绕开 `crossSessionInbound` 闸门就是把安全模型当摆设。合法的做法是让用户自己在 settings 里写 `accept` |
| 用 `mailbox`/IPC 把「批准」塞给别的会话 | 二进制里明确有 `it can't approve anything` 的约束（文档 `cross-session-messaging.md:163`）。伪造批准 = 权限提升 |
| 拦截 `Stop` hook 无限阻止结束 | 平台有 8 次硬上限（`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`），硬改这个变量让模型无限转圈 = 烧用户的钱 |
| 在 hook 里 `updatedInput` 改工具参数做「偷偷修正」 | `PreToolUse` 的 `updatedInput` 是给「允许并修正」用的，不是给「改掉用户意图」用的。用户看不到改动 |

### 5.3 看着像能做到、其实只是「没找到」

| 现象 | 真相 |
|---|---|
| `claude -p` 155 秒 + 有时 exit 0 空输出 | 不是 bug 而是**默认非流式**：文本模式只在最后打一次结果。加 `--output-format stream-json --verbose --include-partial-messages` 就能看到每一轮。启动慢是另一回事，`--bare` / `--await-claim` 可缓解 |
| 「往运行中会话注入指令做不到」 | **说错了一半**。走 IPC 默认被 `hold` 是真的；但（a）`crossSessionInbound: accept` 可绕开，（b）channels 是官方通道。真正做不到的是「无声无息、不要人确认、还跨版本稳定」 |
| 「transcript 里没有成本信息」 | 有。`cost-state` 记录带 `totalCostUSD` + 按模型分解，且**在文件末尾**（实测 76/88 个有成本记录的文件落在最后 3 行）——尾部读取就够 |
| 「hooks 只有 8 个事件」 | 33 个。`stop_hook_summary` 里我们一直当成「宿主噪音」的那个 `command:"callback"`，就是宿主的 Stop hooks |

---

## 6. 如果只能做三件事

按「改动小 / 收益大 / 不违背能力边界」排序：

1. **在项目 `.claude/settings.json` 里加一个 `Stop` hook，做「完成即验证」。**
   最保守版本：`type:"prompt"`，prompt 是「检查上一轮声称的改动是否真的做了」，不用写代码。
   最激进版本：`type:"agent"`，让它跑 `node --test` 和 `check-structure.mjs`，不过就 exit 2。
   这一步同时废掉 Overwatch 里「事后推断它做完了没有」的一部分逻辑。

2. **把 `system/api_error` 的「重试耗尽」和 `[Request interrupted by user]` 接进判定。**
   两者都是**确定事实**、已在语料里大量存在（231 次耗尽 / 270 次打断），
   解析成本是每行一个正则。这比任何启发式都硬。

3. **接 OpenTelemetry，把 `hook_execution_complete` 与 `subagent_completed` 拉进来。**
   一次性配置，之后所有会话的 hook 成败、子 agent 起停、token 成本都是结构化事件，
   不用解析 transcript。**注意必须用环境变量，写 settings 里无效。**

---

## 附：本文引用的位置索引

**二进制（`claude.exe` 字节偏移）**

| 偏移 | 内容 |
|---|---|
| 245,625,744 | `var xd=[...]` —— 33 个 hook 事件名全集 |
| 245,654,769 | 5 种 hook 处理器 zod schema（含 `async`/`asyncRewake`/`once`/`if`/`onFailure`/`args`/`shell`/`cloud`） |
| 128,069,776 | `Stop` 事件说明：「Right before Claude concludes its response」 |
| 128,068,004 | `PostToolBatch` 事件说明 |
| 275,153,052 | `StopFailure` 事件说明 |
| 128,145,872 | `"Stop hook prevented continuation"` |
| 128,172,609 | `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` |
| 129,272,124 | 内嵌的 `## Hooks Configuration` 完整文档（含 Hook Structure / Hook Events / Hook Types / JSON Output） |
| 129,272,552 | 内嵌文档的「Hook Events」表 |
| 135,989,468 | 「LLM prompt hook type」 |
| 135,990,048 | 「MCP tool hook type」 |
| 135,990,384 | 「HTTP hook type」 |
| 135,991,276 | 「Agentic verifier hook type」 |
| 254,352,905 | MCP 客户端能力字面量 `function ke(){return{roots:{listChanged:!0},elicitation:{},...}}`——**无 sampling** |
| 129,826,744 | `"Client does not support sampling"` |
| 277,410,000 区段 | 跨会话消息入站闸门 `function k(e,n)`：`crossSessionInbound` 优先于 `fromMode` |
| 128,514,208 | `peer_message_status` 等 uds-messaging 消息类型 |
| 128,518,116 | 内嵌的注入配方：「Inject messages (auth line REQUIRED here ...)」+ 可直接复制的 `node -e` 片段 |
| 128,512,300 区段 | `selfSent` / `childTokenPresented` / `from_plugin` 等 peer 身份字段 |
| 126,148,384 | `--messaging-socket-path <path>`（官方 help 有、docs 无） |
| 126,148,591 | `--brief`（启用 `SendUserMessage` 工具） |
| 126,131,500–126,152,000 | `claude --help` 全部文案段（其余未记录 flag 都在这里） |
| 135,998,075 | 插件 `hooks.json` 的 `modules` / `register(on)` 说明（in-process function hooks） |
| 281,419,886 | `waitingFor` 取值表：`input needed` / `permission prompt` / `sandbox request` / `dialog open` / `worker request` / `goal proposal` |
| 254,351,500 区段 | `ke()` 与 `lln()`/`aln()`——能力对象的构造与 `extensions` 合并 |

**官方文档（`https://code.claude.com/docs/en/` + 行号，均为本次实际抓取的 `.md` 版本）**

| 文件:行 | 内容 |
|---|---|
| `hooks.md:711` | 每来源 1,024 hooks / 16,384 matcher 字符上限 |
| `hooks.md:736` | hook 配置由文件监听器热重载 |
| `hooks.md:754` | `transcript_path` 异步写、可能滞后；Stop 请用 `last_assistant_message` |
| `hooks.md:1078` | 输出 10,000 字符上限 |
| `hooks.md:1330-1358` | SessionStart 的 `initialUserMessage` / `sessionTitle` / `watchPaths` / `reloadSkills` |
| `hooks.md:4144` | 后台执行 hook（`async` / `asyncRewake`） |
| `hooks.md:422` | `if` 字段：权限规则语法过滤，只在工具类事件求值 |
| `hooks.md:425` | `once`：仅 skill frontmatter 生效 |
| `hooks.md:445-501` | command / http / mcp_tool 三类处理器的字段表 |
| `hooks.md:452-500` | exec form vs shell form |
| `hooks.md:499-520` | HTTP hook 字段（`url` / `headers` / `allowedEnvVars`） |
| `hooks.md:539` | MCP tool hook 字段 |
| `hooks.md:676-720` | 在 skill / subagent frontmatter 里定义 hooks 及限制 |
| `hooks.md:704-718` | 每来源 1,024 hooks / 16,384 matcher 字符上限 |
| `hooks.md:732` | `disableAllHooks`，且「无法单独禁用某个 hook」 |
| `hooks.md:736` | hook 配置由文件监听器热重载 |
| `hooks.md:754` | `transcript_path` 异步写、可能滞后；Stop 请用 `last_assistant_message` |
| `hooks.md:930` | `onFailure: "block"` 的语义 |
| `hooks.md:1078` | 输出 10,000 字符上限 |
| `hooks.md:1330-1358` | SessionStart 的 `initialUserMessage` / `sessionTitle` / `watchPaths` / `reloadSkills` |
| `hooks.md:2435-2475` | PostToolBatch：每批一次、可注入 additionalContext |
| `hooks.md:2819-2912` | **Stop 事件全文**：输入字段、8 次上限、decision control |
| `hooks.md:2829` | Stop input 字段表 |
| `hooks.md:2893-2912` | Stop decision control（block / additionalContext） |
| `hooks.md:2923` | StopFailure 的错误分类 |
| `hooks.md:3960-4098` | prompt-based hooks 与 `{ok,reason,impossible}` 响应 |
| `hooks.md:4099-4120` | agent-based hooks（最多 50 轮、默认 Haiku、超时 60s） |
| `hooks.md:4144` | 后台执行 hook |
| `hooks-guide.md:1032` | hook 跑在非交互 shell |
| `headless.md:21` | `-p` 与 `--bg` 冲突 |
| `headless.md:41` | `-p` 会跑项目 `.claude/settings.json` 的 hooks |
| `headless.md:61` | `--bare` 不跑 hooks |
| `headless.md:130` | `--output-format json` 带 `total_cost_usd` 与分模型明细 |
| `cli-reference.md:95` | `--forward-subagent-text` |
| `cli-reference.md:100` | `--include-hook-events` |
| `cli-reference.md:103` | `--json-schema` |
| `cli-reference.md:114-115` | `--permission-prompt-tool` / `--permission-prompts` |
| `monitoring-usage.md:579-760` | OTEL 指标与事件全集 |
| `monitoring-usage.md:1307-1400` | hook 三个事件（registered / start / complete） |
| `monitoring-usage.md:1413-1440` | `subagent_completed` |
| `settings-reference.md:4672-4700` | `crossSessionInbound` 及其作用域规则 |
| `settings-reference.md:2468-2487` | `env` 里被忽略的变量（含全部 OTEL 开关） |
| `channels.md:276-293` | `-p` 下 channels 可用、安全模型 |
| `channels.md:338-348` | research preview、allowlist、两个 flag 不在 `--help` |
| `channels-reference.md:30-56` | channel 架构 |
| `channels-reference.md:192-256` | Server options / 通知格式 |
| `channels-reference.md:436-500` | 权限提示中转 |
| `cross-session-messaging.md:57-140` | 投递语义、`notify_when_idle` |
| `cross-session-messaging.md:161-226` | 入站消息的四个限制、inbound controls |
| `cross-session-messaging.md:226-270` | inbox socket、token、Windows 强制认证 |
| `agent-teams.md:60` | `-p` 不派 teammate |
| `plugins/components.md:587` | 插件 monitors 不在 `-p` 启动 |
| `plugins/mods/events.md` | `tool.call` / `turn.step` / `settings.read` / `classic.*` |
| `goal.md:106-116` | `/goal` 在 `-p` 下可用 |

**Codex / Gemini 源码（GitHub，经 `gh api` 读取）**

| 位置 | 内容 |
|---|---|
| `openai/codex: codex-rs/protocol/src/hooks.rs` | 14 个 hook 事件名 |
| `openai/codex: codex-rs/hooks/schema/generated/*.command.output.schema.json` | 各事件输入/输出 schema |
| `openai/codex: codex-rs/protocol/src/…HookHandlerType.ts` | `command` / `mcpTool` / `prompt` / `agent` |
| `google-gemini/gemini-cli: docs/hooks/reference.md` | 11 个 hook 事件、exit code 语义、公共输出字段 |
| `google-gemini/gemini-cli: packages/core/src/services/chatRecordingTypes.ts` | Gemini transcript 结构 |

**本机实测数据**

| 来源 | 数字 |
|---|---|
| `~/.claude/projects`（采样时 278 个顶层会话文件，语料在增长） | 约 734,000 行；`system/api_error` 6,022 次；重试耗尽 231 次（173 后续有回合 / 58 直接结束）；打断 270 次；含 thinking 的 assistant 消息 130,816 条；`stop_hook_summary` 4,884；`permissionDecision` 31,923；`cost-state` 191 |
| `~/.claude/projects/**/subagents/` | 5,044 个子 agent transcript |
| `~/.claude/sessions/*.json` | 14 条记录，14 个 pid 全部存活；`waitingFor` 实测出现 `input needed` |
| `\\.\pipe\` 枚举（两次采样） | 1,440–1,492 个管道，其中 `LOCAL\cc-msg-*` 14–17 个 |
| socket 认证测试 | 真 token 连接保持 5,012ms；假 token 221ms 断开 |
