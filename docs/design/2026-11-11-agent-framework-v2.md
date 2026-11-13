# Agent 框架 v2：Mastra 能派活，我们只剩「判活」

> **状态：Proposed，零行实现。本文件不描述任何已实现能力。**
> 系统现在能做什么，读 [README.md](../../README.md) 的「能力边界」。
>
> 本文件是 [`2026-11-10-agent-framework-skeleton.md`](2026-11-10-agent-framework-skeleton.md)（下称 v1 骨架）的**修订版**，不是重写。
> 修订的原因不是「想清楚了」，是**前提被实测推翻了一条**：v1 的设计前提是「没有框架支持 ACP」。
> 2026-11-10 的调研（`docs/research/2026-11-10-framework-build-vs-buy.md`）证明 Mastra 有 `@mastra/acp` 一等公民包；
> 2026-11-11 本次**又在本机实跑**了它，并实跑出了三条与文档不符的事实。

- 日期：2026-11-11
- 作者：规划 Agent P4
- 产出形态：artifact（框架方案修订稿 + 可派发任务）

---

## 零、覆盖声明（按 `docs/spec/evidence-discipline.md` §4）

### 0.1 读了一手文档 / 源码

| 来源 | 读了什么 |
|---|---|
| `docs/research/2026-11-10-framework-build-vs-buy.md` | 全 331 行（§一结论先行、§三 ACP 支持、§四需求对照、§五代价推算、§六反面证据、§七推荐） |
| `docs/design/2026-11-10-agent-framework-skeleton.md` | 全 912 行（v0 五件 / 十不做、§3.3 深度、§3.5 适配器选型、§3.6 数据结构、§四最小链路、F1–F7） |
| `docs/research/2026-11-10-agent-roles-audit.md` | 全 355 行（12 份逐角色、白名单矛盾表、`check-structure` 六组负向测试、§六缺什么） |
| `docs/design/2026-11-11-company-architecture.md` | 全 841 行（三层两挂、唯一区别、外包失败六档、v0 编队、角色判决） |
| `docs/design/2026-11-11-question-protocol-thesis.md`、`docs/spec/2026-11-11-question-protocol.md` §0 | 定位与协议骨架（引用，不重做） |
| `docs/research/2026-11-04-orchestration-patterns.md` | 全 277 行（10 系统 progress 对照、14 条反模式 A1–A14） |
| `docs/research/2026-11-04-dsh-superagent-analysis.md`、`-competitive-landscape.md`、`-external-harness-protocols.md` | 结论节 + §7 acpx 实测节 |
| 本仓规格 | `README.md`、`CLAUDE.md`、`docs/spec/{dispatch-contract,evidence-discipline,output-format,state-model}.md`、`docs/adr/0001-config-only.md`、`.claude/skills/oversight/SKILL.md`、`templates/*.md` |
| 代码（只读） | `scripts/check-structure.mjs` 的 `checkAgents` / `checkDesignIndex` / `checkChangelog`；`scripts/validate-run.mjs` 头部与 `validateGraph`；`scripts/verify-claims.mjs` 导出面与 `EVIDENCE_STATUS` / `CLAIM_FAMILIES` |
| 一手产物（`.tmp-analysis/`，gitignored） | `mastra-acp-agent.ts`（380 行）、`mastra-acp-connection.ts`、`acp-tool.mdx`、`mastra-subagents.mdx`、`acp-schema.json`（183 个 `$defs`）；Mastra npm 包的 `dist/index.js`（本次新装） |

### 0.2 本次**实跑**了什么（这是本文件与 v1 最大的区别）

全部在 `%TEMP%` 下的两个临时目录做，**未改仓库任何文件**，未碰 git。
所用 Node 为 v26.12.1，网关为 `~/.claude/settings.json` 里的 `ANTHROPIC_BASE_URL`（模型摘要显示为 `deepseek-v4.1-flash` / `claude-opus-5` 等混合）。**成本数字是网关价，不是 Anthropic 官方价。**

| # | 探针 | 结果 | 状态 |
|---|---|---|---|
| P1 | `npm i @agentclientprotocol/claude-agent-acp@0.104.1` | 108 包，1 分钟装完 | ✅ |
| P2 | 裸 JSON-RPC `initialize` | 6.8–10.4 s 返回，`protocolVersion:1`，agent 自报 `claude-agent-acp`/`0.104.1` | ✅ |
| P3 | `session/new` + `session/prompt`（裸协议） | 72.6 s，逐 token 拿到 `agent_message_chunk: "ACP-OK"`，`stopReason: end_turn`，`usage_update` cost **$0.1212** | ✅ |
| P4 | **Windows 上 v1 说的 `zod/v4` ESM 崩溃** | **没有复现**。整个握手与回合正常 | ⚠️ 旧结论作废 |
| P5 | `@mastra/acp` `AcpAgent.generate()` 驱动同一适配器 | 成功，回 `"MASTRA-OK"`；**首轮 186 s，次轮 90.8 s** | ✅ |
| P6 | Mastra 返回结果的 `usage` | **`undefined`**。返回对象键只有 `text, response, toolResults, finishReason, runId`（dist 里 `inputTokens: 0` 硬编码，`steps: []`） | ✅ 证实 |
| P7 | Mastra 驱动 `opencode`（`command:'opencode'`） | **`spawn opencode ENOENT`**（Windows 上 `opencode` 是 `.cmd` shim） | ✅ 新发现 |
| P8 | Mastra 驱动 `opencode`（`command: cmd.exe, args:['/c','opencode','acp']`） | 成功，53.5 s，回 `"MASTRA-OPENCODE-OK"` | ✅ |
| P9 | Mastra 官方文档形态 `command:'npx', args:['-y','@agentclientprotocol/claude-agent-acp']` | **`spawn npx ENOENT`** | ✅ 新发现 |
| P10 | acpx `--agent "<命令字符串>"` / `--agent '["node",...]'` | 两者都被拒：*"Raw agent command strings are not supported on Windows. Configure the agent with an argv array"* | ✅ 证实 v1 记载 |
| P11 | acpx + `.acpxrc.json` 的 `agents.cc.argv` | 成功，104.8 s，17 行裸 ACP JSON，拿到 `agent_message_chunk: "ACPX-OK"` + `usage_update` cost **$0.1244** | ✅ 新发现（可用配方） |
| P12 | **工具白名单** `_meta.claudeCode.options.tools: ['Read','Grep']` | 一个回合 **0 次 `tool_call`**（同一提示词不限制时调了 5 次） | ✅ 有效 |
| P13 | `_meta...allowedTools:['Read']` + `disallowedTools:['PowerShell','Bash',...]` | **PowerShell 仍然被调用**，文件被写出 | ❌ **无效** |
| P14 | `session/set_mode` → `default`，然后写文件 | `session/request_permission` 触发，选项 `allow-once \| allow-with-updates \| reject`；选 `reject` 后**文件未创建** | ✅ 权限闸真的存在 |
| P15 | **Mastra 的默认权限行为**（不传 `onPermissionRequest`） | 写文件成功——它默认选 `options[0]` = `allow-once`，**等于自动批准** | ❌ **危险默认值** |
| P16 | acpx 默认（`--allowed-tools Write`，mode 仍是 adapter 默认 `auto`） | 文件被写出，**没有触发权限请求** | ❌ 同上的默认值 |
| P17 | **外部 session 会不会自动加载 `CLAUDE.md`**（cwd = 本仓库） | **会**。它背出了本仓硬约束 1–4 的原文 | ⚠️ **污染实测成立** |
| P18 | `_meta.claudeCode.options.settingSources: []` | 不再有 `CLAUDE.md`；仍会带 `git status` 快照与 `MEMORY.md` 索引 | ✅ 干净上下文的第一半 |
| P19 | `CLAUDE_CONFIG_DIR` 指向空目录（隔离 transcript） | 该目录下生成了独立的 `projects/*.jsonl`；`CLAUDE.md` 仍加载（除非同时 `settingSources:[]`） | ✅ |
| P20 | `systemPrompt: { mode:'override', content:[{type:'text',text:…}] }` | 生效：注入的角色指令覆盖了项目指令（回答被压成 `"ZQ"`） | ✅ 新发现（能力，见 §5.4） |
| P21 | 给外部 session `tools:['Agent']`，让它派子 agent | **成功**，回 `DEPTH2-OK`。**外部 harness 能到深度 2** | ⚠️ 改变 v1 的深度结论 |
| P22 | 外部 session 是否写 transcript | 会。`~/.claude/projects/<cwd-slug>/` 下本次探针落了 **20 个 session**；`scan-sessions.mjs --days 1` 能看到它们 | ⚠️ **扫描器会被自己的探针污染** |

**测试基线**：`node scripts/check-structure.mjs` → 通过，0 提示（本次开工前与收工后各跑一次）。

### 0.3 没做 / 无法核实

1. **没有跑一次完整的「工单 → 执行 → 验收」闭环**。本文的链路是设计，不是实测；实测只有它的每一段单独跑通。
2. **没有测 dsh**（用户说可延缓），也没有测 Mastra→dsh。
3. **没有测并发**（多 session 同时跑）、没有测 session 保活跨多轮的成本曲线。
4. **没有计费口径**。P3/P11 的 `$0.12` 是网关自报的 `usage_update.cost`，不能当 Anthropic 官方价引用。
5. **没有验证 Mastra 的 evals / harness / Studio 任何一项**。本文凡涉及它们，均标注「文档说的」。
6. **没有验证 acpx 的 `session/prompt` 多轮保活**（只跑了 `exec` 一次性）。
7. 本文所有「Mastra 能做什么」的判断，除 P5–P9、P15 外，均来自源码与文档，**不是实跑**。

---

## 一、结论先行（五条，每条可证伪）

**1. Mastra 覆盖的是「派活」，我们唯一还剩下的差异是「判活」——而且这个差异比 v1 写得更窄。**
Mastra 能：起进程、握手、建 session、发 prompt、流式收字、把外部 agent 变成 tool 或 subagent、在每条 ACP 通知上挂钩子、记录 trace/span。
Mastra 不能：把「验收标准」当成一个**数据字段**、让一个**没有参与执行的第三方**对它逐条判、并让判定结果**有强制后果**。前者它全给了，后者它一个都没给。
v1 曾把差异写成三条（N1 协议层 / N2 编排单位 / N3 通信面）。**N1 已被证伪，必须删掉**：Mastra 恰好就管得了别人的进程。剩下的 N2/N3 也不是三条独立理由，是同一件事的两面——**我们编的是「判据」，它编的是「消息」**。

**2. 所以「框架」这个名字应当放弃。**
如果只剩「判活」，那它不是一个框架，是**验收层**（acceptance layer）：四份 schema、三个脚本、一个干净上下文配方。它不需要自己的生命周期、自己的 runtime、自己的调度图——那些 Mastra 已经有，且写得比我们会写。
**继续叫「框架」，代价是每次讨论都要先解释「和 Mastra 什么关系」，而这个解释本身没有产出。**

**3. 但「该做的是一个 Mastra 插件」这个说法只对一半，本机实测给出了三条反对理由。**
① Mastra 的 ACP 路径 **拿不到 usage**（P6：`usage: undefined`，dist 里硬编码 0），而 `CLAUDE.md` 硬约束 #8 要求「派发必须声明预算」——预算在这个抽象层上是瞎的；逃生口是 `AcpAgent.connection.promptStream`，但那已经绕过 Mastra。
② Mastra 的**默认权限处理器选 `options[0]` = `allow-once`**（P15），实测会**静默批准写文件**。一个以「不信 AI 说做完了」为卖点的系统，不能把自己的执行层建在一个默认自动放行的封装上。
③ 官方文档给的 Windows 接法（`npx`）**在本机直接 ENOENT**（P9）；连裸 `command:'opencode'` 也 ENOENT（P7）。
**正确形态是「不依赖任何宿主的验收层」，Mastra 作为可选宿主之一挂上去。** 这样 acpx 与 Mastra 都能接，且哪天 Mastra 改默认值、改 usage 语义，验收层不受影响。

**4. v0 的五件可以缩到三件，而且缩掉的正是「买得到」的两件。**
v1 的五件是：A 工单 schema、B 一个适配器、C 三事件 supervisor、D 验收闸、E run 台账。
新前提下的结论：**B 买到（acpx，本机已验证 P11），E 缩成「三个文件 + 一个写入者表」（不需要独立设计）**；C 缩成「一个 20 行的提取器 + 三个值的枚举」（Mastra/acpx 都已经把事件流给你了，缺的只是把 `agent_message_chunk` 拼起来、把 `usage_update` 读出来）。
真正要自己写的只剩 **A（判据的数据形状）+ D（判据的执行者）**。这两件恰好是 Mastra 唯一不做的。

**5. v0 不引入 Mastra 依赖；引入的触发条件写死，不许「到时候再说」。**
不引的实测理由：装完 **149 MB / 10 085 个文件 / 6 分钟**（本机），要求 **Node ≥ 22.13**（本仓 README 写的是 ≥18），usage 恒缺，默认权限自动放行，文档的 Windows 接法不可用。
而**不引也能跑**：acpx + `claude-agent-acp` 本机实测走通一个完整回合（P11），零 npm 依赖、46 MB 的全局 CLI、一条 `.acpxrc.json` 就能配。
**切换条件（三条，任一成立才引）**：① 需要多工单 fan-out（≥3 张并行）且要可视化；② 需要 OTel 全链路 trace 进外部系统；③ 验收层已经被证明拦得住东西（即 v0 的红队攻击任务没能把它打穿）。
**切换必须由用户批准，因为它会推翻 ADR-0001 的「零依赖」。**

---

## 二、核心判断：既然 Mastra 能派活，我们还差什么

### 2.1 Mastra 覆盖了什么（逐项，标注证据强度）

| 能力 | Mastra 有没有 | 证据 | 对我们的含义 |
|---|---|---|---|
| 起外部 ACP 进程、握手、建 session | ✅ | P5/P8 实跑；`connection.ts` `spawn` + `ClientSideConnection` | **不用自己写** |
| 流式收字（`agent_message_chunk` → `text-delta`） | ✅ | `connection.ts:50` 只把 `agent_message_chunk` 转成 `{type:'text'}`，**其余全部走 `session-update`** | 要拿 tool_call / usage，必须用 `promptStream` 或 `connection` 上的钩子 |
| 把外部 agent 变成 **tool**（`createACPTool`） | ✅ | 输入 schema **只有 `{task: string}`**，输出 **只有 `{output: string}`**（dist `index.js:602-620`，一手） | **这就是「派活」的全部形状**：一句话出去，一段话回来 |
| 把外部 agent 变成 **subagent**（`AcpAgent`） | ✅ | P5 实跑 | 同上，多了 `onDelegationStart/Complete` 钩子 |
| 权限审批回调 | ✅ 但默认危险 | `onPermissionRequest` 存在；**不传时选 `options[0]`=allow-once**（P15 实测写出了文件） | 必须显式传，否则等于「全部放行」 |
| 工具白名单 | ❌（协议层）／✅（适配器私有通道） | ACP `NewSessionRequest` 只有 5 个字段（本机 schema 复核）；`_meta.claudeCode.options.tools` **实测有效**（P12），而 `allowedTools/disallowedTools` **实测无效**（P13） | 这层必须自己写，且**必须逐个 harness 验**——同一个适配器里两个名字相近的字段，一个生效一个不生效 |
| session 选项透传 | ✅ | `getNewSessionRequest()` 就是 `{cwd, mcpServers:[], ...options.session}`（dist） | 意味着我们能塞 `_meta`、能塞 `systemPrompt` |
| 预算 / usage | ❌ | P6：`usage: undefined`；dist 硬编码 `{inputTokens:0,...}`、`steps: []` | **必须从 `connection.promptStream` 自己读 `usage_update`**，等于绕过 Mastra |
| 重试 / 步骤上限 | ✅ | `maxSteps`、`onDelegationStart.modifiedMaxSteps` | 可用，但那是父 agent 的循环预算，不是工单预算 |
| evals（`gates`/`scored`/`passed`） | ✅ | 文档（本研究未实跑） | **对数据集离线评自己的 agent**，位置不在「这张工单回来的那一刻」 |
| 可观测（OTel / token / cost / Studio） | ✅ | 文档（未实跑） | 买得最值的一项，但它是**事后看**，不是**事前判** |
| 工单 schema（AC / boundary / 预算 / 证据命令） | ❌ | tool 的 input 只有 `task: string` | **这就是我们要写的第一件** |
| 三方裁决者（干净上下文、一票否决） | ❌ | `onDelegationComplete` 的 `bail()` 是**父 agent 的循环控制**；`resultText` 是**替换父模型看到的文本** | **这就是我们要写的第二件** |

**这张表的读法**：13 项里 **8 项买得到、2 项买一半、3 项必须自己写**（预算 / 工单 / 裁决）。而 3 项里，预算是**管道**，工单与裁决是**判断**——这才是我们真正剩下的东西。

### 2.2 「判活」到底指什么（定义要精确到可反驳）

> **判活 = 在一次外部执行返回之后，由一个没有参与该次执行的第三方，按一组在执行前就以数据形式存在的标准，逐条判定「过 / 不过 / 不知道」，并让这个判定对流程有强制后果。**

拆成五个要件，缺一即不成立：

| # | 要件 | 缺了会怎样 | Mastra 有吗 |
|---|---|---|---|
| J1 | **标准先于执行存在，且是数据** | 标准降级成 prompt 里的一句话，执行者可以顺手「补充理解」 | ❌（`task: string`） |
| J2 | **判定者与执行者上下文不共享** | 判定者读到执行者的自述，判成「他说得挺有道理」 | ⭕ 半个（`messageFilter` 能裁上下文，但裁决者仍是父 agent 自己） |
| J3 | **判定是三值的，且允许「不知道」** | 二元判定会逼判定者把「没证据」四舍五入成「通过」或「不通过」 | ❌（`finishReason: stop` 只有成功/失败） |
| J4 | **判定有强制后果** | 判定变成一条日志，流程照走 | ⭕ 半个（`bail()` 能停，但那是**父 agent 自己决定停**，不是第三方判「不过」导致停） |
| J5 | **判定本身可机读、可复算** | 下一次 run 无法复用，人也无法核对「上次为什么过」 | ❌（subagent 回来的就是 `text`） |

**J1 + J5 合并起来就是「判据是数据」；J2 + J4 合并起来就是「独立且有牙」。这两句话是验收层的全部内容。**

### 2.3 为什么它不能被 evals / `onDelegationComplete` 替代

**evals 不行，是位置不对。**
Mastra 的 evals（`gates` / `scored` / `passed` 三态判词，可进 CI）评的是「你自己的 agent 在一份数据集上的输出」。它的输入是**数据集的样本**，不是「刚才那个外部进程交回来的工单」。
差三件事：① 数据集是事先挑好的，工单是随机的；② 评的是 agent 的输出分布，不是某一次交付；③ 它在时间上可以晚于执行（CI 里跑），而验收必须在**重派之前**。
**一句话：evals 回答「这个 agent 好不好」，判活回答「这一单过不过」。**

**`onDelegationComplete` 不行，是身份不对。**
它确实在正确的位置上（执行刚结束、父模型还没看到结果），也确实能做三件事：`bail()` 停循环、`feedback` 写进记忆、`resultText` 替换父模型看到的文本。
但它**是父 agent 的钩子，不是第三方的裁决**。差别在三条可检验的地方：
1. **它拿不到 AC。** 它的入参是 `result / messages / error`，没有「预声明标准」这个入参——标准若存在，也只能存在父 agent 的 prompt 里（违反 J1）。
2. **它的输出不是一个判定。** `resultText` 是**改写**，改写之后的文本仍要父模型自己决定怎么处理；`bail()` 是**中止**，不是「不通过」。这两者都不产生一份「逐条 AC 的过/不过」的产物（违反 J3/J5）。
3. **它是同一个人。** 父 agent 既决定派什么活，又决定结果说得过去不说得过去——这正是 `CLAUDE.md` 硬约束 #3/#4 要拆开的那两件事。

**反过来说，验收层可以**用**这个钩子**：如果将来挂在 Mastra 上，`onDelegationComplete` 就是「验收层被调用」的最佳挂点——但它调用的必须是一个**独立上下文的判定者**，而不是在钩子里写几行 `if`。

### 2.4 那它还是框架吗？——不是，正面回答

**不是。它是一个层，不是一个框架。**

判据（三条，都可以被反驳）：

| 判据 | 框架 | 验收层 | 我们 |
|---|---|---|---|
| 有没有自己的生命周期 | 有（进程/session/调度图） | 没有（被调用、返回、结束） | **没有**。我们连常驻进程都不该有（ADR-0001） |
| 有没有「谁来跑」的决定权 | 有（它 spawn / 它调度） | 没有（宿主给谁它就判谁） | **没有**。v0 由 acpx 起进程；将来由 Mastra 起 |
| 有没有可替换的宿主 | 不，它就是宿主 | 是，换宿主不改判定逻辑 | **必须是**。这是本文件第 3 条结论的直接推论 |

**所以正确的自我描述是**：
> 「Overwatch 提供一个**验收层**：一份判据 schema、一个门禁脚本、一个干净上下文判定配方。它可以挂在 acpx 上（默认，零依赖），也可以挂在 Mastra 上（可选）。」

**不建议继续使用「框架」这个词。** v1 骨架里「框架」出现的每一次，都可以替换成「验收层 + 派发契约」，且替换后句子更准确。

---

## 三、旧方案逐条判决

v1 骨架的结论分三类：**仍成立 / 因新前提作废 / 要改**。逐条列，不重述理由（理由见原文或本文对应节）。

### 3.1 仍然成立（不要动）

| v1 的结论 | 为什么仍成立 |
|---|---|
| §1.2 命题 = P3「把目标切成带预声明 AC 的工单，派给不是我们的进程，判成过/不过/不知道」 | 这条**恰好就是判活**。Mastra 的出现没有改变它，反而把它从「三条理由之一」提成了「唯一理由」 |
| §2.2 X1 不做递归 | 仍然成立，但**理由要换**（见 3.3）。旧理由「物理不可达」已被 P21 推翻 |
| §2.2 X3 不做 progress 通道 | 仍然成立，且被 Mastra 反证：它的 subagent 只回 `text`，「Nested tool calls and subagent metadata aren't added to the parent agent's model context」（`mastra-subagents.mdx` 一手）——**通例是对的** |
| §2.2 X5 不承诺沙箱 | 仍然成立，且**必须加强**：P15/P16 证明连「默认会问」都不成立，默认是**自动放行** |
| §2.2 X6 不往用户会话注入 | ADR-0001 已裁决，与本次无关 |
| §2.2 X9 不把「修好了」当验收标准 | 成立；现在可以做成机器检查（§5.3 F3） |
| §2.2 X10 不做事后投票 | 成立 |
| §2.3 「v0 不承诺质量变好，只承诺可归责与不放行」 | 成立，且是本文最重要的诚实声明，原样保留 |
| §3.2 角色 ≠ harness 的两字段拆分（`role` / `adapter`） | 成立。Mastra 的 `AcpAgent` 恰好印证：`id/name/description` 与 `command/args` 是两组字段 |
| §3.4 三个「主 agent 不被淹没」的机制（无 progress / 卡片 + 指针 / 预算与超时不靠等） | 成立。Mastra 的 `messageFilter` + `slice(-10)` 是同一思路的另一种写法 |
| §3.6 `report.json` 由 supervisor 写、执行者只能写 `report.md` | 成立。这是「执行者不能自评」在数据结构上的落点 |
| §4.1「这条链路证明什么 / 不证明什么」两张表 | 成立，原样保留 |
| §七 风险 1（可能只是 `child_process` 的包装） | **风险升级为事实的一半**：Mastra 已经把这个包装做成了产品。见 §9 |

### 3.2 作废（新前提直接推翻）

| v1 的结论 | 原文位置 | 为什么作废 |
|---|---|---|
| **N1「协议层不对：它们管不了别人的进程」** | §1.3 表 N1 | **Mastra 管得了**，而且是官方包。这条必须删。留着的后果是：读者以为「没有框架能驱动外部 CLI」，从而支持一个已经不需要支持的结论 |
| **「不用现成框架的三条结构性理由」这个框架** | §1.3、§八 一页纸 | 三条变两条，且两条同源。保留「三条」是形式主义 |
| **§3.5「v0 首选 acpx + opencode，`claude-agent-acp` 在 Windows 上 `zod/v4` ESM 崩溃所以不用」** | §3.5 表第 2 行 | **P1–P4 实测推翻了这条**：0.104.1 在本机握手、建 session、跑完一个回合全部正常。旧结论基于更早的版本与一次 `npx` 超时。**必须改写为「旧结论已失效，实测已通」**，否则我们会因为一个过期的阻塞理由去接一个不是首选的后端（用户明确说优先 Claude Code） |
| **§3.3 结论「深度 1 是当前配置的事实，也是设计选择」的后半句** | §3.3 diff 块 | 前半句（12 份角色无 `Agent`）仍对；后半句「物理不可达」被 **P21** 推翻：外部 harness 只要拿到 `Agent` 就能到深度 2。**正确表述是「native 侧深度 1 是配置事实；外部侧深度由 harness 决定，我们只能观测不能封死」** |
| **§3.5 表「`claude -p` 不能作为 v0 同步通道」** | §3.5 表第 3 行 | 这条**不撤销但降级**：现在有了 ACP 通道，`claude -p` 不再需要讨论——它不是候选。**把整行删掉比留着更有信息量**，因为留着会让人以为它还是备选 |
| **§八「最关键的两个实测发现」②（`claude -p` 静默失败）** | §八 | 同上。它作为「为什么必须验非空产物」的**教训**仍然成立，作为**选型理由**已经作废 |

### 3.3 要改（结论方向对，论证或边界要改）

| v1 | 改成 | 为什么 |
|---|---|---|
| §2.1 v0 做五件（A–E） | **做三件**：A 判据 schema、D 验收闸、C′ 三值提取器。B 买、E 并入 A/D | 见 §4.2 |
| §2.2 X1 不做递归，理由「物理不可达」 | 理由改成：**「递归的成本在外部 harness 侧不可观测」**（P21：它能派，我们看不到；`usage` 又恰好拿不到，P6） | 物理不可达是假的；**不可观测**是真的，且更硬 |
| §3.1 v0 只用 4 个角色（planner/executor/acceptor/redteam） | v0 用 **3 个**（planner / acceptor / gate-runner 脚本），redteam 转周期性 | 审计结论：redteam 无 `Bash` 导致它在 v0 里什么也做不了；`executor` 岗位仍在但**不派 native**，物理实现是外部进程 |
| §3.6 `report.json` 六字段 | 保留六字段，**但把 `claim` 拆成 `claim_text` + `claim_candidates[]`** | `verify-claims.mjs` 的 `detectClaims` 是按「断言族」抽的，一个回合可能有多条断言；单字段会丢信息 |
| §四 最小链路第 [4] 步「从 ACP 流里只取三件事」 | 明确**取法**：`usage_update.cost` + 最后一个 `agent_message_chunk` 的**拼接全文** + `stopReason`；并**必须同时记录 `tool_call` 计数** | P3/P11 实测：`usage_update` 可能发两次（一次无 cost、一次有 cost），只取最后一次 |
| §五 F1–F7 七个任务 | 缩成 **W1/W2/W3/W4 四个**（见 §4.1 的买/写分界表） | F2（适配器 + `claude -p` 复测）的一半已被本次实测做完；F7（修深度声明）仍是文档修正，并入 W6 的能力矩阵一起做，不再单列 |
| §七 风险 3（`claude -p` 失败可能是网络问题） | **删除**（已由 ACP 通道绕开），换成新风险：**「验收层的判定者如果与执行者用同一个模型，收益只来自上下文隔离」** | arXiv 2503.13577 那条对「同质编排」的质疑仍然敞着，且 P5/P6 显示我们连执行侧的成本都拿不到 |

---

## 四、v0 边界（按新前提重划）

### 4.1 买 / 写分界（一张表定死）

| # | 要什么 | 买还是写 | 具体是什么 | 证据 |
|---|---|---|---|---|
| **W1** | 判据（工单）的 schema + 校验器 | **写** | `ticket.json`：`goal(逐字) / shape / role / adapter / boundary[] / acceptance[]{id,criterion,evidence_cmd,fail_if} / budget / timeout / why_this_layer`；`validate-ticket.mjs` | Mastra 的 tool input 只有 `task: string`（一手 dist） |
| **W2** | 三值提取器 | **写（小）** | 从 ACP 事件流里抽 `{state, summary, cost, changed_files, claim_text}`；`REPORT_STATES = ['DONE','BLOCKED','NEEDS_DECISION']` + 两个非事件态 `UNKNOWN`/`TIMEOUT` | acpx 已经是裸 ACP JSON（P11），缺的只是 20 行拼接 |
| **W3** | 门禁执行器（跑证据命令） | **写** | `gate.mjs`：读 ticket 的 `evidence_cmd[]`，逐条跑，记 `{ac_id, cmd, exit_code, stdout_sha256, stdout_head}` | 审计 §3：acceptor 无 `Bash`，且**不该有**——让它自己跑命令等于让它既当控方又当证人 |
| **W4** | 验收闸（一票否决） | **写** | acceptor 只读 `ticket.AC[] + report.json + gate.json + diff`，写 `verdict.json` | Mastra 无等价物（§2.3） |
| **W5** | ACP 驱动 | **买** | `acpx`（全局 CLI，46 MB，MIT）+ `claude-agent-acp`（108 包）；配置走 `.acpxrc.json` 的 `agents.<n>.argv` | P11 实测跑通；P10 证明 `--agent` 字符串在 Windows 不可用 |
| **W6** | 工具白名单 | **写（薄）** | 一个 `adapter-capabilities.json`：每个 harness 认哪个字段（`claude-agent-acp` 认 `_meta.claudeCode.options.tools`，**不认** `allowedTools/disallowedTools`） | P12/P13 实测定生死 |
| **W7** | 干净上下文配方 | **写（文档 + 一段 env）** | `settingSources: []` + `CLAUDE_CONFIG_DIR=<run>/home` + `cwd=<worktree>` + `nonce` 回显 | P17/P18/P19 实测 |
| **W8** | 预算硬上限 | **半买** | 读 `usage_update.cost`；`_meta.claudeCode.options.maxBudgetUsd` 作为第二道（Claude 专属） | P3/P11 实测拿到 cost；P6 证明经 Mastra 拿不到 |
| **W9** | 可观测 / UI / 调度图 | **不做** | v0 没有 | 需要它时引 Mastra，见 §4.3 |
| **W10** | 深度控制 | **不做，只观测** | 外部 harness 拿 `Agent` 就能到深度 2（P21），我们能做的是**记录 `spawnDepth` 并告警** | P21 |

**买的总量**：两条 CLI + 一份 JSON 配置。**写的总量**：四份 schema（ticket / report / gate / verdict）、三个脚本（`validate-ticket` / `extract` / `gate`）、一份能力矩阵、一段干净上下文配方。**没有一行协议代码。**

### 4.2 v0 从五件缩到三件（并说明为什么不能再缩）

| v1 的五件 | v2 处置 | 依据 |
|---|---|---|
| A 工单 schema + 校验器 | **保留，且升级为第一公民**（加 `evidence_cmd` / `nonce` / `answers_ref`） | 这是唯一 Mastra 结构上不做的「判断数据」 |
| B 一个外部适配器 | **买**：不写适配器，写**一个 40 行的 spawn 封装 + 一份能力矩阵** | P11 已跑通；v1 的 `scripts/adapters/acpx.mjs` 从「适配器」降级为「命令行拼装器」 |
| C 三事件 supervisor | **缩成提取器**（W2）。不再有「supervisor 进程」 | acpx/Mastra 都已把事件分好类；我们只需要把 `agent_message_chunk` 拼起来 |
| D 验收闸 | **保留，且是唯一核心** | §2.2 |
| E run 台账 | **缩成「五个机器产物 + 一张唯一写入者表」**，不再单列设计 | 见 §6.3；没有第二种设计可讨论 |

**能不能再缩到两件（只做 A + D）？** 技术上可以，但会失去唯一能证明「验收闸真的拦住了东西」的东西：**没有 W3（gate.mjs），acceptor 只能读文件、相信报告**——那正是审计里最重的一条缺陷。所以 **W3 是 D 的证据源，不可拆**。

**能不能缩到一件（只做 D）？** 不能。**J1 要求标准先于执行存在且是数据；没有 A，D 就没有输入。** 一个只会判「这段 diff 看起来对不对」的判定者，与「让另一个 agent 看看」没有区别——而后者 Mastra 已经有（subagent + reviewer prompt）。

### 4.3 要不要引入 Mastra？——不引，理由与切换条件

**v0 不引入。五条理由，前四条是实测。**

| # | 理由 | 实测/文档 | 影响 |
|---|---|---|---|
| 1 | **装依赖的代价** | 本机 `npm i @mastra/core@1.82.0 @mastra/acp@0.4.4` → **148 包 / 6 分钟 / 149 MB / 10 085 个文件** | 与 README 第 5 行「零 npm 依赖，只要 Node ≥ 18」直接冲突；且要求 **Node ≥ 22.13** |
| 2 | **预算拿不到** | P6：`usage: undefined`，dist 硬编码 0、`steps: []` | `CLAUDE.md` 硬约束 #8 无法在这个层面落实；逃生口 `connection.promptStream` 等于绕过 Mastra 的抽象 |
| 3 | **默认权限自动放行** | P15：不传 `onPermissionRequest` 时选 `options[0]`=allow-once，**文件被静默创建** | 一个「不信 AI」的系统不能把执行层建在默认放行的封装上。要安全就得自己写 `onPermissionRequest`，而**那时 Mastra 提供的东西已经只剩「spawn + 事件转发」** |
| 4 | **官方 Windows 接法不可用** | P9：`command:'npx'` → `ENOENT`；P7：`command:'opencode'` → `ENOENT` | 想用它就得自己写 `cmd.exe /c` 包装——而这层包装是我们本来就要写的 spawn 封装 |
| 5 | **没有它也能跑通同一件事** | P11：acpx + `.acpxrc.json` 跑完一个完整回合 | 零依赖路径存在且已验证；引入 Mastra 换不到「多一种能力」，只换到「多一层抽象」 |

**引入的触发条件（三条，任一成立；写死，不许「视情况」）**：

1. **多工单 fan-out ≥3 且需要可视化**。理由：那时我们要自己写调度图 + 进度面板，而 Mastra 的 Workflow + Studio 是现成的。
2. **需要 OTel 全链路 trace 进外部系统**。理由：`@mastra/core` 的 Observability 是买得最值的一项（调研 §四）。
3. **验收层已被证明拦得住东西**（§8 的红队攻击未能打穿 + 负向测试全绿）。理由：**在验收层自己没被验证之前引入宿主，等于把两个未验证的东西相乘**——v1 的 X7 已经立过这条规矩。

**切换的代价必须由用户批准，不许 Agent 顺手决定**：它会推翻 ADR-0001 的「零依赖配置库」形态，把仓库从一个 markdown + 零依赖脚本的库，变成一个**有构建产物、有 `package.json`、有 `node_modules` 的项目**。

**如果用户就是要 Mastra**：本方案的验收层**不需要重写**——W1/W3/W4 原样保留，W2 换成 `onDelegationComplete` 钩子，W5 从 acpx 换成 `AcpAgent`。**这正是把它设计成「层」而不是「框架」的回报。**

---

## 五、角色怎么改（基于审计结论）

### 5.1 12 个角色的逐个判决

判决依据三条硬事实（审计已核实）：**① 12 份全部无 `Agent`；② acceptor/redteam/relay/research 被要求做它们没有工具做的事；③ 10 种输出模板、零个解析器。**

| 角色 | 判决 | 具体动作 | 理由 |
|---|---|---|---|
| `planner` | **改** | ① `capability` 枚举 6 → 8（加 `gate` / `harness`，删不用的）；② 输出 `acceptance[].evidence_cmd` 替代 `evidence`；③ 删掉「递归深度上限 3 层」那句 | 审计 M7：按它自己的枚举造图，`validate-run` 判违规。它是全仓唯一有可校验产物的角色，v0 必须用它 |
| `acceptor` | **改（重点）** | ① 输入加 `gate.json`；② `Write` 改成「只允许写 `verdict.json`」并在正文写死路径；③ 输出从 5 段 markdown 改成 **`verdict.json` schema**（`pass/fail/unknown` 三值 + `uncovered[]`）；④ 保留 `Bash` 的**缺失**（不给） | 审计：它无 `Bash` 却要被判「逐条跑」。**正解不是给它 `Bash`，是给它跑过的结果**（gate.json）。给它 `Bash` 会让它同时是控方与证人 |
| `redteam` | **改** | **必须加 `Bash`**，且正文限定「只允许只读命令 + 在 `%TEMP%` 下写临时测试脚本」 | 审计：`:58` 要求「必须实际验证 ≥3 条（跑命令）」，`:10` 无 `Bash`。真实红队报告（`2026-11-04-redteam-notify-fix.md`）本身就是用别的工具集写的——**定义从未被执行过** |
| `critic` | **留，改边界** | 删掉第 3 问（「验收标准里哪些无法观测」）——那是 acceptor/planner 的活；保留前两问 | 审计 §2.4：它与 redteam 实质重叠 |
| `review` | **留** | 修 `color: magenta` → 合法值；`omitClaudeMd: true` 保留但正文补一句「你属于一个更大的体系，硬约束 #3/#4 仍然适用」 | 审计 §2.6：`magenta` 不在宿主枚举内，说明这 12 份没被逐字段校验过 |
| `repair` | **留，加锁** | ① 正文写死「只允许写 `tasks/runs/<id>/repair-<n>/`」；② `check-structure` 把它加入只读名单外的新名单：**`FORBIDDEN_PATHS` = 不得写 `acceptance*` / `ticket-*.json`** | 审计：它有 `Write/Edit/Bash`，而验收标准是仓库里的 markdown 文件——「不得修改验收标准」是纯 prompt，且不在只读名单里 |
| `probe` | **留** | 输入改成「只读 `scan-sessions.mjs --json` 的**输出文件**」（由脚本落盘），不是「跑那个脚本」 | 审计：它没有 `Bash`，实际只能自己解析 jsonl，而 prompt 没写怎么解析 |
| `research` | **改** | 加 `Bash`（只读命令），或删掉「优先实测」那一条——**二选一，不许两条并存** | 审计：`:22` 与 `:10` 直接冲突。同时补 `## 输入` 节（唯一缺失的一份） |
| `relay` | **改** | 加 `Bash`（它唯一的输入路径是 `node scripts/watch.mjs --inbox --json`）；或在定义里改成「输入是主线程给的收件箱 JSON 文件」 | 审计 M3：被派出后自报「不能，缺 Bash」，于是退回被自己禁止的路径。**自我否定的输入契约** |
| `safety` | **留** | 红线清单与 `relay-protocol.md` 的 5 类对齐（现在是 8 项，混进了 3 个质量项） | 审计 §2.10：同一份清单两个粒度，没有单一真源 |
| `resolution` | **留，限制 `Write`** | 声明唯一可写路径 | 审计：它的 `Write` 是 12 份里最没有边界的 |
| `executor` | **保留定义，v0 不派 native** | 岗位仍在（org chart 上是「执行者」），物理实现一律是外部 harness | 审计：它是「有全权的本地进程」，`git commit/push` 无拦截。v0 的执行者必须在 worktree 里 |

**统计**：12 份里 **6 份必须改工具集或输出格式**（planner/acceptor/redteam/research/relay/repair），**3 份改边界**（critic/review/resolution），**3 份只留不动**（probe/safety/executor）。

### 5.2 新增角色：只加两个，且都不许「会推理但不会跑」

| 新角色 | tools | 职责 | 为什么必须是角色而不是脚本 |
|---|---|---|---|
| `oversight-coordinator` | `Read, Write(仅 tasks/runs/**), Agent, Glob, Grep` | 拿一张工单 → 决定派给哪个 adapter → 收卡片 → 判断是否收敛 | **这是唯一需要 `Agent` 的岗位**（审计 §6.1：现有 12 份全是叶子，框架需要一层中层）。P21 证明宿主支持深度 2 |
| `oversight-harness` | `Read, Write(仅 tasks/runs/**/adapter-probe/*.json), Bash(仅 acpx / node 探测命令), Glob` | 跑 canary 探针：一个 30 秒的最小工单，验「进程起得来 / 有产物 / usage 拿到 / 工具白名单生效」 | 审计 §6.2：12 份 prompt 里**没有一个字**提到 ACP、stdio JSON-RPC、进程生命周期、退出码语义 |

**但要说清一条**：`oversight-harness` 这个角色**有可能不该存在**。
`company-architecture.md` 的 M4 说「能用脚本判的不设岗位」。canary 探针是确定性的（起进程、发一条 prompt、看四个布尔），**适合脚本**。
**本文的判断**：v0 **先写脚本** `scripts/adapter-probe.mjs`；只有当「探针失败后要决定改用哪个 adapter、为什么」这件事需要判断时，才升格成角色。
**判据（写死）**：如果连续 3 次 run 的探针结论是二元（能用/不能用）而没有产生任何需要权衡的选择，就永远不要这个角色。

### 5.3 输出格式必须统一成机器可解析的（这是审计里最贵的一条）

**现状**：12 份定义 10 种模板，`dispatch-contract.md:77` 要求的三元组**只有 executor 照抄**，全仓**没有任何脚本解析任何角色的返回值**。

**v2 的规则（三条，可机器检查）**：

1. **机器消费的产物一律是 JSON，且必须有 schema 与校验器。**
   机器消费 = 下游脚本会读它。v0 里只有四个：`ticket.json`、`report.json`、`gate.json`、`verdict.json`。
2. **人消费的产物一律是 markdown，且不许有任何脚本解析它。**
   `report.md`（执行者自述）、`failure.md`、`critique.md`、`review.md` 都属于这一类。
   **这条是给「10 种模板」的正面解释**：人读的模板不需要解析器——需要解析的是契约，不是散文。
3. **markdown 视图一律由 JSON 渲染，不手写。**
   `verdict.md` 由 `render-verdict.mjs` 从 `verdict.json` 生成。理由是 `output-format.md` §2.1 已经立过的同一条规矩：手写的渲染会随模型心情变化，而它自带格式可信度。

**这条规则怎么被强制**：`check-structure.mjs` 加一条检查——`docs/spec/org-contract.md` 里列出的每个 JSON schema，必须有对应的 `validate-*.mjs` 与 `*.test.mjs`；缺一个 fail。
（现有 `checkDesignIndex` 就是同类检查的先例，扩展成本低。）

### 5.4 顺带解决一个真实问题：角色 prompt 怎么送进外部 harness

**实测发现（P20）**：`session/new` 的 `systemPrompt: { mode: 'override', content: [{type:'text', text: …}] }` **真的会覆盖项目指令**（注入后回答被压成 `"ZQ"`）。
`schema.json` 里 `SystemPrompt` 是对象、`systemPrompt` 是 `SystemPrompt | null`；适配器要求 `content` 是**数组**（我第一次传字符串被拒：`expected array, received string`）。

**含义**：`role` 这个字段不是装饰——**它可以把 `.claude/agents/oversight-*.md` 的正文作为系统指令注入外部 session**。加上 P12 的工具白名单（`_meta.claudeCode.options.tools`），外部执行者第一次可以**同时**拿到「角色约束」与「工具裁剪」。
**这就是「角色 ≠ harness」那条分层（v1 §3.2）真正落地的地方**：同一份角色定义，native 走 frontmatter，外部走 `systemPrompt` + `_meta`。

**但必须标注不确定性**：`systemPrompt` 是 ACP 的**可选能力**（agent 要 advertise `sessionCapabilities.systemPrompt` 才接受）。本机 `claude-agent-acp` 0.104.1 支持且 `mode: override` 生效；`opencode` 未测。

---

## 六、最小链路（v0 必须跑通的一条）

任务选型与 v1 一致：**一件真的值得做、小到 12 分钟能做完、产物可机械检验的事**。
v1 选的是「给 README 的『已知局限』表补两行实测数字」——**沿用**，因为它的 AC 能精确到 `file:line` 与表格行数。

### 6.1 链路（每一步都有明确的产出与判据）

```
用户（唯一一次输入）
  node scripts/org.mjs run "把 README「已知局限」表补两行：STALLED 与 needs 覆盖率的实测数字"

──────────────────────────────────────────────────────────────────────
[0] org.mjs（脚本，不经过模型）
    run_id   = 2026-11-11-readme-limits-<goal_sha6>
    goal.md  ← argv 逐字 + sha256（逐字是被保证的，不是被要求的）
    run_home = tasks/runs/<id>/home        ← CLAUDE_CONFIG_DIR（隔离 transcript）
    worktree = .tmp-runs/<id>/worktree     ← 执行者的唯一可写区
    预算      root 40% / 单工单 30%，timeout 15 min

──────────────────────────────────────────────────────────────────────
[1] planner（native subagent，干净上下文）
    输入：goal.md 逐字 + 两本台账 + templates/acceptance-criteria.md
    产出：tasks/runs/<id>/ticket.json
      { goal(逐字) / shape:"artifact" / role:"executor" / adapter:"acpx:claude"
        boundary:["只改 README.md 的『已知局限』表","不碰 docs/spec/","不 git add/commit/push","不装依赖"]
        acceptance:[
          {id:"AC1", criterion:"『已知局限』表新增恰好 2 行",
           evidence_cmd:"node scripts/count-table-rows.mjs README.md 已知局限",
           fail_if:"行数 ≠2，或 README 其他段落有 diff"},
          {id:"AC2", criterion:"两行的数字都能追到一条可复跑命令",
           evidence_cmd:"node scripts/check-numbers-traceable.mjs README.md",
           fail_if:"任一数字在仓库里没有对应命令输出"},
          {id:"AC3", criterion:"不得新增待办类表述",
           evidence_cmd:"git -C <worktree> diff -U0 | grep -E '待办|TODO|计划中|后续'",
           fail_if:"grep 命中"},
        ]
        token_budget_pct:30 / timeout_min:12 / nonce:"a3f2c1d9"
        why_this_layer:"README 的表格改写在 12 分钟内可完成，但需要读全仓实测数据，不适合主线程上下文" }
    校验：node scripts/validate-ticket.mjs <ticket.json>     ← 不过就退回 planner

──────────────────────────────────────────────────────────────────────
[2] adapter-probe（脚本，每次 run 一次，结果缓存到当日）
    canary：在 worktree 建 canary.txt，内容 = nonce
    验证四件：进程起得来 / 文件在 / nonce 回显 / usage_update 拿到 cost
    任一失败 → exit 2，输出「adapter 不可用 + 原因 + 复现命令」，不进 [3]
    ★ 实测：一个最小回合 72–105 秒、$0.12（P3/P11），所以 canary 是 30 秒级不成立——
      真实成本就是一次完整回合。这条要写进预算。

──────────────────────────────────────────────────────────────────────
[3] 派发（脚本 spawn，不是模型）
    .acpxrc.json:
      { "agents": { "cc": { "argv": ["node", "<abs>/@agentclientprotocol/claude-agent-acp/dist/index.js"] } } }
    env: CLAUDE_CONFIG_DIR=<run_home>  +  ~/.claude/settings.json 的 env（网关凭据）
    cwd: worktree
    session 选项（经 acpx 的 --allowed-tools 或裸 ACP 的 _meta）：
      _meta.claudeCode.options = {
        tools: ["Read","Grep","Glob","Edit","Write","Bash"],   ← 实测有效（P12）
        settingSources: [],                                     ← 实测有效（P18）
        maxTurns: 40
      }
    prompt = templates/dispatch.md（公共段）
           + ticket 的 goal + boundary + AC（逐字）
           + nonce（易变段放最后，缓存友好）
    ★ 不给它看：其他工单、上次的自我评价、我们的历史结论

──────────────────────────────────────────────────────────────────────
[4] 提取（脚本，20 行）
    从 ACP 事件流里取：
      · 最后一个 usage_update 的 cost（实测可能发两次，前一次无 cost）
      · 全部 agent_message_chunk 拼接 = claim_text（原文，供 verify-claims）
      · stopReason（end_turn / max_tokens / …）
      · tool_call 事件计数（=0 时高度可疑）
      · 中间过程（thought / tool_call / plan）→ observation.jsonl，不进父上下文

──────────────────────────────────────────────────────────────────────
[5] 收拢（脚本）
    非空判据（三条同时成立才算 DONE）：
      ① worktree 里 `git status --porcelain` 非空
      ② nonce 出现在 claim_text 里
      ③ stopReason === 'end_turn'
    不成立 → state = UNKNOWN（★ 不是 DONE）
    写 report.json（六字段 + claim_candidates[]），写 cost.json

──────────────────────────────────────────────────────────────────────
[6] 门禁（脚本，这是 acceptor 的证据源）
    gate.mjs 逐条跑 ticket.acceptance[].evidence_cmd：
      只允许白名单命令（node scripts/*.mjs、git diff/status、grep）
      → gate.json = [{ac_id, cmd, exit_code, stdout_sha256, stdout_head}]

──────────────────────────────────────────────────────────────────────
[7] acceptor（native subagent，干净上下文）
    输入：ticket.AC[] 逐条 + report.json + gate.json + worktree diff
    ★ 不给：report.md、cost、上一轮 verdict、任何自我评价
    产出：verdict.json
      { ticket_id, verdict:"pass"|"fail"|"unknown",
        items:[{ac_id, result:"pass"|"fail"|"unknown", evidence_ref, note}],
        uncovered:[] }
    verdict.md 由脚本从 verdict.json 渲染（★ 消灭第 11 种模板）

──────────────────────────────────────────────────────────────────────
[8] 不过 → repair（native，最多 1 轮）→ 完整重新验收（不作废，不抽查）
    仍不过 → failure.md，exit 1，不假装通过

──────────────────────────────────────────────────────────────────────
[9] org.mjs 汇总（≤10 行，遵守 output-format.md 七条硬规则）
    [DONE] 2026-11-11-readme-limits-a3f2c1
    做了什么：README「已知局限」表 +2 行（STALLED 0.018% / needs 16 中 3）
    证据：tasks/runs/<id>/verdict.json（AC1 pass · AC2 pass · AC3 pass）+ gate.json
    花了：$0.13 · 3m20s · 1 个工单 · 0 次重试
    下一步：改动在 .tmp-runs/<id>/worktree，要合并请手动 diff
```

### 6.2 这条链路证明什么、不证明什么

| 证明了 | 怎么证明（负向） |
|---|---|
| 预声明 AC 在**外部执行者**身上生效 | 把 AC1 的行数改成 3 → `gate.json` 的 exit_code 必须 ≠0 → verdict 必须 fail |
| 「三事件」够用 | 整条链路里没有任何一次「问进度」；父上下文里只有一个卡片 |
| 验收闸拦得住东西 | 让执行者输出空改动（worktree 干净）→ verdict 必须 fail，且 `report.json` 的 state 必须是 UNKNOWN |
| 工具白名单真的裁剪 | 把 `tools` 里的 `Bash` 去掉，让执行者跑一条命令 → 它必须报告没有该工具（P12 已单独验过这条机制） |
| 「别人的手下」真的被驱动 | 执行者是 `claude-agent-acp` 起的 Claude Code 进程，不是我们的 subagent |

| **不证明** | 为什么 |
|---|---|
| 质量更好 | MAST：改角色规格 + 增强协调**效果不充分**（v1 §2.3 原样保留） |
| 能并行 | v0 只跑 1 个工单 |
| 递归可行 | 不是不可行（P21 已证外部能到深度 2），是**不可观测**（P6：usage 拿不到） |
| 便宜 | 实测一个最小回合 $0.12；一次 run 至少 2–3 个回合，即 **$0.25–0.5**。这个账 v0 必须算，不能估 |
| 干净上下文的判定者**真的**不含执行者痕迹 | P19 残余：即使 `settingSources:[]`，外部 session 仍会带 `git status` 与 `MEMORY.md`。**acceptor 是 native subagent，不受这条影响——但必须写进文档** |

### 6.3 文件 × 唯一写入者（这是「不臃肿」的可检查形式）

| 文件 | 唯一写入者 | 机器还是人读 | 谁消费 |
|---|---|---|---|
| `goal.md` | **脚本**（argv） | 机 + 人 | planner、acceptor |
| `ticket.json` | planner | 机 | `validate-ticket`、派发器、acceptor |
| `report.json` | **脚本** | 机 | acceptor、`org.mjs` |
| `report.md` | 执行者 | **只有人** | 无脚本解析 |
| `gate.json` | **脚本** | 机 | acceptor |
| `verdict.json` | acceptor | 机 | `org.mjs`、下次 run |
| `verdict.md` / `failure.md` | **脚本**（从 JSON 渲染） | 人 | 无脚本解析 |
| `cost.json` | **脚本** | 机 | `org.mjs` |

**三条推论**：
1. **机器产物只有 5 类**（goal / ticket / report / gate / verdict）。加第 6 类 = 拒绝。
2. **`report.md` 是唯一允许自由文本的产物，且没有任何脚本解析它。** 这解释了「10 种模板还能活这么久」：**人读的模板不需要解析器**。
3. **判断只发生在两处**：planner 写 `ticket.json`、acceptor 写 `verdict.json`。其余全是记录。**「公司只有两个判断点」——这一条是「不臃肿」的全部内容。**

---

## 七、待实测清单（哪些是文档说的、哪些是本次实测的）

### 7.1 本次已经实测、且**推翻**了既有文档的（必须改文档）

| # | 既有说法 | 本次实测 | 处置 |
|---|---|---|---|
| 1 | v1 §3.5：「`acpx` + `claude-agent-acp` 在 Windows 上 `zod/v4` ESM 崩溃，不用」 | **0.104.1 全通**（P1–P4） | v1 该行标注作废；v2 起 `acpx:claude` 是首选 adapter |
| 2 | 调研 §3.1 引社区复现：「Mastra ACP usage 恒 0」 | **证实，且更严重**：`usage: undefined`，`steps: []`（P6） | 文档结论成立，本文把它升级为「不引 Mastra 的第 2 条理由」 |
| 3 | 调研 §四：「Mastra 官方给了 Claude Code 接法（`npx …`）」 | **Windows 上 `spawn npx ENOENT`**（P9） | 「官方给了接法」≠「接法在本机可用」。必须补一条限定 |
| 4 | `claude-agent-acp` 认 `allowedTools` / `disallowedTools`（调研 §一.3、§四） | **实测无效**：给了 `disallowedTools:['PowerShell','Bash',…]`，PowerShell 仍被调用（P13）。**真正有效的是 `tools: [...]`**（P12） | 这是**本文件最有操作价值的一条**：能力矩阵必须逐字段验，不能照抄文档 |
| 5 | v1 §3.3：「深度 1 是物理不可达」 | **外部 harness 只要拿到 `Agent` 就到深度 2**（P21，回 `DEPTH2-OK`） | 深度不是平台墙，是**配置 + 观测问题** |
| 6 | 隐含假设：「外部 session 是干净的」 | **会自动加载项目 `CLAUDE.md`**（P17，它背出了硬约束原文） | 干净上下文必须**显式构造**（`settingSources:[]` + `CLAUDE_CONFIG_DIR`），不是默认 |
| 7 | 隐含假设：「我们 spawn 的进程不会进用户的会话列表」 | **会**：本次探针在 `~/.claude/projects/` 落了 20 个 session，`scan-sessions --days 1` 全部可见（P22） | **跨系统污染**：Overwatch 自己的扫描器会把自己的执行会话当成用户会话。必须在 adapter 层加标记（见 7.3） |

### 7.2 仍然是「文档说的，没实跑」

| # | 结论 | 影响 | 怎么验 |
|---|---|---|---|
| T1 | Mastra 的 evals / `gates` 三态判词 | 只影响「能不能用它替代验收」——本文判断不能，但没跑过 | 装 `@mastra/evals`，用一份含 3 条 AC 的数据集跑一次，看它能否接「这张工单」的输入 |
| T2 | Mastra 的 Observability / OTel span | 只影响「切换条件 2」 | 跑一次 `AcpAgent.generate`，看 trace 里有没有 ACP 子进程的 span |
| T3 | Mastra Workflow 的多工单 fan-out | 只影响「切换条件 1」 | 用 `.parallel()` 起 3 个 `AcpAgent`，测并发与成本 |
| T4 | **Mastra + `opencode` 的工具白名单** | 决定 `adapter-capabilities.json` 里 opencode 那一行填什么 | 对 opencode 的 `_meta` 试同一组字段，看哪个生效 |
| T5 | **`session/resume` 跨多轮的成本曲线** | 决定「一次 run 拆成多次 prompt」是否更省 | 一个 session 连发 3 个 prompt，记录每次 `usage_update.cost` |
| T6 | **`opencode` 的 `systemPrompt` 支持** | 决定角色注入能否跨 harness 复用 | 发 `session/new` 带 `systemPrompt`，看是否被拒 |
| T7 | dsh（用户说可延缓） | 不影响 v0 | 用户要求时再验 |

### 7.3 本次实测暴露的、必须进设计的两个新问题

**问题 A：我们 spawn 的会话会污染用户自己的会话库（P22）。**
实测：20 个探针 session 出现在 `~/.claude/projects/`，`scan-sessions.mjs --days 1` 把它们列进了「19 个有活动的会话」里。
后果：**Overwatch 的核心功能（扫描）会把 Overwatch 自己的执行进程当成用户的会话**——这正是 README 里「不制造噪声」的反面。
处置（v0 必须做）：`CLAUDE_CONFIG_DIR=<run_home>` 把 transcript 隔离到 run 目录（P19 实测可行）。
**代价**：隔离之后，这次执行**不会**出现在用户会话列表里——这既是修 bug，也是产品语义变化（执行者是「公司的员工」，不是「用户的会话」）。**这条要写进 README 的能力边界。**

**问题 B：`settingSources:[]` 之后仍有 `git status` 与 `MEMORY.md`（P19）。**
后果：如果我们打算让**外部** harness 当判定者（v1 曾经考虑过），它的上下文里会带仓库的变更清单——那是执行的结果之一，构成锚定。
**v0 的规避**：判定者一律用 native subagent（干净上下文由宿主保证），**不用外部 harness**。这条是硬规则，写进 `dispatch-contract.md`。

---

## 八、红队攻击任务（不可合并，强制）

> 派给 `oversight-redteam`（按本文件 §5.1 已加 `Bash`）。
> **不得读**任何执行 Agent 的自我评价、W1–W4 的中间产出、`docs/research/2026-11-10-agent-roles-audit.md` 的结论节（会锚定）。
> 允许读：本文件全文、`framework-build-vs-buy.md`、v1 骨架、`README.md`、`CLAUDE.md`、`docs/adr/0001-config-only.md`、Mastra 的 npm 包与文档、`acpx` 的 `--help`。

### 攻击任务：这套方案是不是只是把 Mastra 的文档重新组织了一遍？

```
任务名：证明或证伪「v2 = Mastra 文档的重新组织」
产出形态：artifact（批评报告，不改任何文件）
预算：token 15%，90 分钟

必须逐条作答（编号，不许合并）：

1. 【核心】本文件 §2.1 的 13 行能力表，有几行的证据是「文档说的」而不是「实测的」？
   逐行标注。凡标「文档说的」的行，请指出：如果我们把 Mastra 文档整段删掉，
   本文件还剩多少内容？（给出比例，并列出剩下的部分）

2. 【判活是不是真的存在】§2.2 把「判活」拆成 J1–J5。请对每一条回答：
   一个熟练的 Mastra 使用者，用 `createACPTool` + `onDelegationComplete` + 一个
   reviewer subagent + `messageFilter`，能不能在**不改 Mastra 源码**的前提下拼出 J1–J5？
   逐条给出「能 / 不能 / 部分」与**具体的 Mastra API 组合**。
   ★ 如果 5 条里 ≥4 条能拼出来，直接说「这是文档重组」，不要绕。

3. 【「层」与「框架」的区分是不是自我安慰】§2.4 用三条判据区分「框架 vs 层」。
   请攻击它：一个只有三份 schema + 两个脚本的东西，凭什么被称为「一个层」而不是
   「一个脚本集合」？「层」这个命名带来了什么可观测的差别？

4. 【零依赖的立场是不是在为一个技术债辩护】§4.3 用五条理由拒绝 Mastra。
   请逐条判断：哪几条是**真的技术理由**，哪几条是**「我们已经决定了所以找理由」**？
   特别是第 5 条（「不引也能跑」）——「能跑」是不是等于「应该自己维护」？
   请估算：如果我们自己维护 acpx 封装，一年要付多少次「上游接口变了」的成本？

5. 【实测的样本量】本文的核心证据是 P1–P22，全部是在**一台机器、一个网关、
   一个模型组合**下跑的。请指出：哪几条结论最可能不成立于其他环境？
   给出至少 3 条，并说明它们各自需要什么条件才能推翻。

6. 【§4.2 的「不能再缩」是不是在保护自己的工作量】
   我声称「缩到 A+D 会失去证据源」。请攻击：一个没有 `gate.mjs` 的验收闸，
   如果强制 acceptor 输出 `unknown` 而不是 `pass`，是不是就够了？

7. 【本次实测暴露的两个新问题，处置是否过头】
   §7.3 的 A（会话污染）：把 transcript 隔离到 run 目录，是不是反而让我们失去
   「用 verify-claims 核对执行者」的能力（因为 transcript 不在标准位置了）？
   §7.3 的 B（git status 残留）：判定者用 native subagent 就够了吗？
   它读的是同一个工作目录，`Read` 是任意的——「干净上下文」是不是又变成了 prompt 约束？

8. 【有没有一条我完全没想到的路线】至少一条，且必须不违反 ADR-0001 与 CLAUDE.md 的 8 条硬约束。

验收标准（预先声明，事后不得增补）：
  AC1 第 1 问必须给出**一个数字**（剩多少比例）与一份「剩下的部分」清单，不许含糊
  AC2 第 2 问必须逐条给「能/不能/部分」+ 具体 API 组合；若判「能」，必须给出**可运行的伪代码**
  AC3 第 3 问必须给出**一个可观测的差别**（不是哲学讨论）
  AC4 第 4 问必须给出维护成本估算，且标明是推算还是实测
  AC5 第 5 问至少 3 条，每条附「什么条件下推翻」
  AC6 必须有一节「经核实不成立的指控」（至少 2 条：我怀疑、但核实后成立的设计选择）
  AC7 自评：这份批评里最可能是错的哪一条，为什么
  AC8 不修改本文件；每条批评指向 §x.y 或具体行号
```

**止损点（写在前面）**：如果红队第 2 问的结论是「J1–J5 里 ≥4 条能用 Mastra 现有 API 拼出来」，**本方案应当退到「写一份 Mastra 使用手册」**，而不是写代码。这是本文件预设的否决条件。

---

## 九、风险（自己先写，不等红队）

### 风险 1（最高）：v2 可能只是「把 Mastra 的文档翻译成中文，再加一点自己的习惯」

这是 v1 风险 1 的升级版。v1 担心「只是 `child_process` 的包装」，那个担心**已经被 Mastra 变成了产品**——现在连包装都不需要写。
剩下的唯一辩护是：**J1–J5 拼不出来**。但第 2 问（红队）会逼我正面回答，而我自己先给一个悲观的估计：
**J1 拼得出**（把 AC 塞进 prompt，`createACPTool` 的 `task` 字段可以带任意文本）；**J2 拼得出**（`messageFilter` + 一个新 subagent）；**J3/J5 拼不出**（Mastra 的 subagent 只回 `text`，没有三值判定这个类型）；**J4 拼得出**（`bail()`）。
**即 4/5。** 如果红队也得到 4/5，按 §8 的止损点，**本方案应当被否决**。
**但注意「拼得出」与「拼得对」是两件事**：用 `messageFilter` 拼出来的 J2 仍是 prompt 约束（过滤什么由调用方决定，而调用方就是父 agent），而本文 §7.3 B 已经证明这类约束在本仓反复失效。**这个区别是本文最后的立足点，红队可以直接打它。**

### 风险 2：验收闸的单点故障（v1 风险保留）

调研 §5.4 引 HN 两位实践者：1 人维护的上限是「需要拍板的次数」。验收闸存在的意义是把拍板从人转移到预声明标准上——**如果它经常误判，1 个人会被它拖死**。
**缓解**：`verdict.json` 的三值里 `unknown` 是一等公民。一个只会说「过」和「不过」的闸是二元分类器，会说「不知道」的闸才是判据。

### 风险 3：`acpx` 是 pre-1.0（v1 风险保留，成本更高了）

README 原文：*"Treat its CLI and runtime interfaces as evolving"*。
v2 把 acpx 从「适配器之一」升级成「默认宿主的驱动层」，所以它变动的代价更大了。
**缓解（必须做）**：acpx 的所有调用点集中在 `scripts/adapters/acpx.mjs` 一个文件里。**这条不是建议，是 v0 的验收项之一**（`grep` 全仓 `acpx` 只允许命中这一个文件 + 配置文件 + 文档）。

### 风险 4（新增）：我们用的模型与执行者用的是同一个模型

调研 §6.1 引 arXiv 2503.13577：*"orchestration is only effective if there are performance or cost differentials between agents."*
本仓 12 个角色里 10 个是 `model: inherit`；`executor` 与 `acceptor` **都是 inherit**。实测 P3/P11 显示执行侧用的是网关上的 `deepseek-v4.1-flash`/`claude-opus-5` 混合。
**含义**：验收闸的收益只来自**上下文隔离**，不来自**能力差异**。这不是否决理由（Cognition 的实测正是「干净上下文 review」有效），但必须写进假设，**不能默认成立**。
**可测方式**：同一批工单跑两遍，一遍 acceptor 用 inherit、一遍用更强的模型，比较 `verdict.json` 的漏放率。

### 风险 5：v0 第一次跑真实任务时，成本可能比预期高一个量级

实测：一个**最小回合**（回 3 个字符）72–105 秒、**$0.12**。
本链路的第 1 次 run 至少含：canary（1 回合）+ 执行（1–3 回合）+ 可能 repair（+2 回合）+ acceptor（native，另算）。
**乐观估计 $0.3–0.5 / run；若执行者走偏，$1+。** 这个数字必须写在 `org.mjs` 的 dry-run 输出里，让用户派发前看到（`CLAUDE.md` 硬约束 #8）。

---

## 十、一页纸（给主线程）

```
问题变了：不是「没有框架支持 ACP」（已被推翻），
          而是「Mastra 能派活，没人做判活」。

Mastra 覆盖：起进程 / 握手 / 流式收字 / tool 或 subagent / 权限回调 /
             evals / OTel / Workflow / Studio —— 买得到，而且比我们会写。
Mastra 不覆盖：判据是数据 / 三方裁决 / 三值判定 / 判定有牙 / 判定可机读（J1–J5）。
             这五条 = 验收层 = 我们唯一剩下的东西。

所以：不该再叫「框架」。它是「验收层」：4 份 schema + 3 个脚本 + 1 个干净上下文配方。
     不做 Mastra 插件（实测：usage 恒缺 / 默认自动放行写 / Windows 官方接法 ENOENT），
     但做成「能挂 Mastra」的层——挂上去不改一行判定逻辑。

v0 五件 → 三件：A 判据 schema（写）/ D 验收闸（写，含 W3 门禁脚本作证据源）/ C′ 三值提取器（写 20 行）；
             B 适配器（买 acpx，已经跑通）/ E 台账（缩成一张「唯一写入者」表）。

要不要引 Mastra：v0 不引（149MB/10085 文件/6min/Node≥22.13/usage 恒缺/默认自动放行）。
             三条切换条件写死：多工单 fan-out 且要可视化 / 要 OTel / 验收层已被证明拦得住。
             切换会推翻 ADR-0001，必须用户批准。

角色：12 份里 6 份必须改工具或输出，3 份改边界，3 份不动。新增 2 个（协调者、harness）。
     输出统一：机器读的一律 JSON + schema + 校验器；人读的一律 markdown 且无脚本解析。

最小链路：一行命令 → planner 出 ticket → 校验 → canary → acpx 派发（tools 白名单 + 干净上下文）
         → 提取 → gate.mjs 跑证据命令 → acceptor 出 verdict.json → pass 收工 / fail 修一轮。

本次实测推翻的 7 条既有结论，最要紧的两条：
  ① claude-agent-acp 在 Windows 上能跑（旧的 zod/v4 崩溃已不复现）→ Claude Code 成为首选适配器
  ② 外部 session 会自动加载 CLAUDE.md、会写进用户的 transcript 目录 → 干净上下文必须显式构造，
     且我们 spawn 的会话正在污染用户自己的会话列表（scan-sessions 能看到）

七天后最该回答的问题（红队第 2 问）：
  J1–J5 里，一个熟练的 Mastra 用户能不能拼出 ≥4 条？
  能 → 本方案否决，改写 Mastra 使用手册。
  不能 → 验收层成立，进 v1（多工单）。
```

---

## 附：本文件未覆盖的部分（诚实申报）

1. **没有跑一次完整闭环**。每一段都单独实测过，但它们拼起来没有跑过。
2. **没有测并发与多工单**。v1/v2 都没测。
3. **没有读 Mastra 的 evals / harness / observability 源码**，只读了 ACP 与 subagents 两块。
4. **没有验证 `opencode` 的 `systemPrompt` 与工具白名单**（只验了 `claude-agent-acp`）。
5. **没有算清「一次 run 多少钱」**，只有单回合的 $0.12。
6. **没有向用户确认**：引不引 Mastra、要不要为它破零依赖。这是本文件列出的**待裁决项**，不是待办项。
7. **`docs/spec/evolution-discipline.md` 不存在**（v1 已申报过），本次同样没找到。
