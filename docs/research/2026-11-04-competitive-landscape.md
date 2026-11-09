# 竞品与失败案例调研：多 agent 编排/监控/接力

- 日期：2026-11-04（检索执行于 2026-11-09）
- 作者：检索 Agent E3
- 产出形态：exploration
- 方法：一手抓取官方文档（`code.claude.com/docs`、`cursor.com/docs`、`cognition.ai/blog`）、GitHub API 计数、Hacker News Algolia API 原始评论、arXiv API 摘要。**凡本文引用的数字与引文均可回溯到下列来源；无来源的判断已标注「推测」。**

> **覆盖声明**：`cognition.ai` 的博客正文抓到（HTML 解析成功）；`cursor.com/changelog` 抓到；
> `code.claude.com` 的 markdown 源文档抓到（比网页更干净）。
> 未抓到：X/Twitter 讨论、Reddit 具体帖子（搜索引擎未返回可用索引）、Devin 的实际定价页。
> 这几个方向如需补，应另派一轮。

---

## 一、结论先行

**1. 我们原定要做的「多会话监控面板」，宿主已经原生做完了，而且是官方默认路径。**
Claude Code 已内置 `claude agents`（Agent view，research preview）：一屏列出所有后台会话、
按「Working / Needs input / Completed」分组、每行一条 Haiku 生成的摘要、状态变化发通知
（`Notification` hook，类型 `agent_needs_input` / `agent_completed`）、可派发、可 peek 回复、可 attach 进完整会话。
它覆盖了 `README.md`「能力边界」表里「能」的那一整列。这不是"将来会做"，是**现在已经发布**。

**2. 「自动接力」不是没人做，是平台方刻意堵死了。这不是市场空白，是安全边界。**
官方跨会话消息（cross-session messaging，v2.1.224+）文档原文写明：来自另一会话的消息
**「永远不算你的同意」**——它不能替你回答权限提示、不能改配置、消息里的斜杠命令不会被执行。
也就是说：接力草稿能发，但**"无痕冒充用户点同意"这件事被平台明确禁止**。
我们 README 里那句「无法独立满足原始设计稿 §1」，现在有了官方依据——**这不是我们的能力缺陷，是宿主的正确设计**。
继续往这个方向投入，等于和平台的安全模型对打。

**3. 这一品类在开源侧已经饱和，且实证需求很弱。**
GitHub 搜索计数（2026-11-09）：`claude code session manager` 610 个仓库、`claude code monitor` 4083 个、
`coding agent orchestrator` 7484 个。头部项目星数：`oh-my-claudecode` 40.7k、`paseo` 23.6k、
`jcode` 21.6k、`Claude-Code-Usage-Monitor` 8.8k。
但 Show HN 上的同类产品**普遍只有 1–77 分、大量 0 评论**（Agent Deck 3 分、Claude Control 2 分、
claude-code-dashboard 3 分；最好的 agents-observe 77 分）。**供给极度过剩 + 关注度极低**，这是典型的
「做的人比用的人多」信号。

**4. 多 agent 的实证结论是「省着用」，而这恰好支持我们的对抗式方法论，不支持我们的产品化野心。**
Anthropic 自己的数据：agent 比 chat 多烧 4× token，多 agent 系统多烧 **15×**，
且 **token 用量单独解释 80% 的性能方差**——多 agent 的收益主要是"花更多 token"，
不是因为架构更聪明。Anthropic 同时承认「大多数编码任务的可并行部分少于研究任务」。
Cognition 更直接：2025 年写《Don't Build Multi-Agents》，2026-04 改口成《Multi-Agents: What's Actually Working》，
新结论是 **「写入保持单线程，其他 agent 只贡献智力」**，并把无结构 swarm 称为「distraction」。

**5. 但有一条我们真正独占、且被真实用户痛点验证过的东西：断言 vs 证据的核对。**
HN 长贴里反复出现同一个词——**「sanitised optimism」**（消毒过的乐观）：
agent 报「修好了」，其实是把报错吞了。有用户说「现在总让它先证明真的生效了再往下走」。
`verify-claims.mjs`（断言 vs 证据）与「锐评不得由执行者自己写」正好打在这个点上。
**这是差异，但它是一个 feature / 方法论，不是一个产品。**

---

## 二、竞品对比表

| 产品 | 定位 | 多 agent 支持 | 跨会话监控 | 自动接力 | 与我们的差异 |
|---|---|---|---|---|---|
| **Claude Code Agent view**（`claude agents`，research preview） | 官方后台会话调度台 | 派发多会话；每个是完整 CC 会话 | **原生**：分组表 + Haiku 行摘要 + 通知 | 否（可 peek 回复，但要你按） | **正面覆盖我们的核心**。我们唯一超出的是「断言核对」与「跨 harness」 |
| **Claude Code Agent teams**（实验，默认关） | 官方多 agent 协作 | 共享任务表 + 点对点消息 + lead | 部分（lead 视角） | 否 | 限制多：**不能嵌套团队**、不能提升 teammate 为 lead、`/resume` 不恢复 teammate、任务状态会滞后 |
| **Claude Code cross-session messaging**（v2.1.224+） | 官方会话间消息 | 会话互发纯文本 | 可列举同机/跨机/云端会话 | **平台禁止代批权限** | 我们的「接力草稿」与它重叠；而且它比我们更安全（有来源标注、防环、限流） |
| **Claude Code Projects**（public beta） | 云端持续协作 | thread 并行，Claude 自己派 | **Overview 面板列出谁需要你** | 部分（云端跑，不本地） | 云端优先；Team/Enterprise 尚未开放 |
| **Cursor Agents Window**（Cursor 3，2026-04-02 GA） | agent-first IDE | 并行 agent，local/cloud/SSH/手机/Slack | 有（多 workspace 统一） | 否 | 商业闭源、绑 Cursor；已扩展语音、部署、iOS |
| **Devin / Cognition** | 自主 AI 工程师 | **Devin 管 Devin**（2026-03）：每个子 Devin 独立 VM | Devin Desktop「Agent Command Center」 | 部分（manager 派活 + 合成） | **和我们的愿景最像**，但他们在云上、每会话独立 VM、有专有模型与训练 |
| **Windsurf → Devin Desktop** | IDE + agent 管理中心 | Spaces 共享上下文；ACP 接第三方 agent | 有 | 否 | 已被 Cognition 收编；「工程师的工作正在转向 agent 管理」 |
| **OpenHands**（93k★） | 开源自主开发 agent | 有（多 agent 委托） | 弱 | 否 | 面向"完成一个 issue"，不是"监控你所有会话" |
| **SWE-agent**（20.8k★） | 学术向 issue→PR | 单 agent（ACI 设计） | 无 | 否 | 基准驱动，不做工作流 |
| **oh-my-claudecode**（40.7k★） | 编排层（npm 包） | team-plan→prd→exec→verify→fix 流水线 | HUD + session 摘要 + replay | **有：`omc wait` 限流自动续跑** | **功能上比我们多**（含我们想做的自动恢复） |
| **paseo**（23.6k★） | 桌面+手机多 agent 编排 | 多 harness | 有 | 否 | 商业/产品化程度高 |
| **codeg**（4.4k★） | 跨 harness 聚合工作区 | CC/Codex/OpenCode/Pi/Grok | 有 | 否 | **跨 harness 这块和我们重叠** |
| **agent-deck**（1.2k★） | TUI 会话管理器 | 多 harness | 有（tmux） | 部分 | 同上 |
| **agents-observe**（Show HN 77 分） | 实时观测面板 | agent teams | 有（hook → sqlite → websocket） | 否 | 只做观测，作者自述"下一层是完整编排" |
| **agent-sessions / Claude Control / claude-code-dashboard** | 桌面/网页监控 | 仅 CC | 有 | 否 | 同类小项目，星数 2–314，验证了需求也验证了天花板 |

**这张表最重要的一行是最后三行**：同类小产品大量存在但都不温不火。说明**需求真实存在，但付费/持续使用的意愿不足以支撑一个独立产品**（推测：这也解释了为什么它们大多停在个人项目）。

---

## 三、失败案例复盘

### 3.1 最重要的一条：Cognition 自己否定了自己，然后又部分改回来

**2025-06-12《Don't Build Multi-Agents》**（作者 Walden Yan，Devin 团队）两条原则：

> **原则 1：共享上下文，共享完整的 agent 轨迹，而不只是单条消息。**
> **原则 2：动作携带隐式决策（Actions carry implicit decisions），冲突的决策带来坏结果。**

原话摘录：

> 「我倾向于认为，原则 1 和 2 重要到、且极少值得违反，以至于**你应当默认排除任何不遵守它们的 agent 架构**。」

他们举的例子非常具体：把"做一个 Flappy Bird 克隆"拆成"做背景"和"做小鸟"两个子 agent，
结果一个做成了超级马里奥风格的背景，一个做成了不像游戏资产的鸟——最后合成 agent 只能收拾烂摊子。

> 「截至 2025 年 6 月，Claude Code 是一个会派生子任务的 agent 的例子。但它**从不与子 agent 并行工作**，
> 子 agent 通常只负责回答问题，不写任何代码。为什么？因为子 agent 缺少主 agent 的上下文……
> Claude Code 的设计者刻意选择了简单路线。」

> 「就目前而言，我不认为**有人**在专门投入解决这个困难的跨 agent 上下文传递问题。」

**2026-04-22《Multi-Agents: What's Actually Working》**——10 个月后改口：

> 「我们的原始观察对**并行写手 swarm** 仍然成立：那个领域里大多数性感点子仍然没有看到有意义的采用。
> 但我们找到了一个更窄的模式：**多个 agent 为任务贡献智力，而写入保持单线程。**」

> 「我们还是别绕弯子：SWE 1.5 作为主模型不够好，这个设置没法真正跑起来。」

> 「**无结构 swarm——任意网络里的 agent 互相协商——基本是个干扰项。** 实际形态是 map-reduce-and-manage：
> manager 拆活、children 执行、manager 合成并回报。」

> 「所有开放问题都是沟通问题。」（弱小模型何时升级、子 agent 如何把自己的发现告诉兄弟、上下文怎么传而不淹死接收方）

**我们能学到什么**：

- 我们的 `CLAUDE.md` 硬约束里「禁止静默共识」「锐评不得由执行者自己写」在方向上**是对的**，
  但 Cognition 2026 的发现给出了更精确的版本：**生成者/验证者循环效果最好时，两者事先不共享任何上下文**。
  他们的实测：即使 PR 是 Devin 自己写的，Devin Review 平均每个 PR 抓 2 个 bug，约 58% 是严重的
  （逻辑错误、漏边界、安全漏洞）；原因是 **context rot**——长会话的 agent 注意力被稀释，干净的 review agent 反而更聪明。
  **这直接支持「锐评 Agent 拿干净上下文」这个设计，而且说明了为什么"不给它执行者的自我评价"不只是伦理要求，还是效果要求。**
- 但同时也说明：**如果一个任务需要多个 agent 并行写**，我们目前没有任何上下文一致性手段，这是已知的开放问题，
  不是我们能解决的（Cognition 说要靠下一代模型的训练来解决）。

### 3.2 学术侧的失败证据

**《Why Do Multi-Agent LLM Systems Fail?》**（arXiv:2503.13657，v3 2025-10-26，UC Berkeley 等）：

> 「尽管多 agent 系统（MAS）备受热情追捧，它们在流行基准上的**性能提升往往是微小的**。」

- 数据集 **MAST-Data**：1600+ 条标注轨迹、7 个主流 MAS 框架、150+ 任务、6 位人类专家。
- 失败分类 **MAST**：**14 种失败模式，3 大类**——(i) 系统设计问题、(ii) agent 间失配、(iii) 任务验证与终止。
  标注者一致性 Cohen's κ = 0.88。
- **最关键的负面结果**：他们试了两种干预——改进 agent 角色规格、增强协调策略——**「发现不充分」**。
  原文：这些失败「需要更复杂的解决方案」。

**对我们的意义**：`docs/spec/dispatch-contract.md` 里那套"角色 + 验收标准预先声明"属于第 (i) 类干预。
论文说这类干预**效果不足**。我们的 192 条测试和结构硬门保证的是**我们自己的流程不腐化**，
不是保证"多 agent 一定比单 agent 好"。这两件事不要混为一谈。

**《Rethinking the Value of Multi-Agent Workflow: A Strong Single Agent Baseline》**（arXiv:2601.12307，2026-01-18）：

> 「大多数框架是同质的——所有 agent 共享同一个基座 LLM，只在 prompt、工具、工作流位置上有差别。
> 这带来一个问题：这种工作流能否被单个 agent 通过多轮对话模拟？……
> 结果显示**单 agent 可以达到同质工作流的性能，并且因为 KV cache 复用而有更高的效率**，
> 甚至能匹配自动优化的异构工作流。」

他们的 OneFlow 算法在**不牺牲准确率**的前提下降低了推理成本。

**对我们的意义**：如果我们说的"5 个 Agent 并行"跑的是同一个模型（大概率是），
那我们在论文的分类里属于**同质工作流**——被证明可以用单 agent 多轮对话等价复现，且更便宜。
**我们唯一能反驳的是"角色分离带来的独立性"（避免自我确认偏差），而这一点需要证据，不能靠断言。**

### 3.3 成本侧的硬数据

Anthropic《How we built our multi-agent research system》（2025-06-13）原文：

> 「在我们的数据里，agent 通常比 chat 交互多用约 **4×** 的 token，而多 agent 系统比 chat 多用约 **15×** 的 token。
> 为了经济上可行，多 agent 系统需要的任务价值必须高到足以支付这份性能提升。」

> 「**大多数编码任务的可真正并行的部分少于研究任务**，而且 LLM agent 在实时协调和委派方面还不够好。」

> 「多 agent 系统之所以有效，主要是因为它帮助**花掉足够多的 token** 来解决问题。
> 在我们的分析中，三个因素解释了 BrowseComp 上 **95%** 的性能方差，
> 其中 **token 用量本身就解释了 80%** 的方差。」

配套证据（HN 真实用户，agents-observe 讨论帖）：

> 「你们每天是在烧几百还是几千美元的 Claude token 吗？我最多让一两个 agent 干点有用的事就撞限流了。」

> 「我在 Pro 上撞了很多次限制。升到 Max $200/月之后就很久没撞过了。**如果你的 skills 和插件装得多，
> token 会烧得快 5–10 倍。**」

**结论**：一个建立在"多 agent 并行"之上的产品，**它的用户必须先是高消费用户**。
这天然把市场限制在 Max/Team/Enterprise 层。而这一层的用户，恰恰最可能直接用官方的 Agent view + Projects。

### 3.4 「有人做过跨会话监控然后失败了吗」

**查不到具体的失败复盘。** 这是本次调研的一个诚实缺口：没有找到任何一篇"我做了一个 agent 监控面板，
然后关掉了，原因是 X"的公开复盘。搜索引擎和 HN 搜索都没有返回。

但找到了**间接证据，方向一致**：

- **供给远大于关注**：4083 个 `claude code monitor` 仓库；Show HN 上同类产品普遍 ≤ 77 分且常常 0 评论。
- **作者自己转行**：agents-observe 作者在帖子里说「下一个大层是完整编排」，
  也就是说**只做观测不够，他自己也知道**。
- **平台吞噬**：Agent view 落地后，「看清 30 个会话在干什么」从"需要第三方工具"变成"内置功能"。
  这是这一品类最典型的死法——**不是做错了，是被宿主顺手做了**。

---

## 四、真实痛点证据（原文引用）

来源：Hacker News Algolia API，`hn.algolia.com/api/v1/items/<id>`，抓取于 2026-11-09。

### 4.1 上下文切换的精神成本（这是最真实的需求）

Ask HN: What are you working on? (August 2026)，item 评论：

> 「也在观察**并行开多个 Claude Code 会话（约 5–7 个）带来的生产力损失**——
> 一天里要来回上下文切换很多次。有时候我 literally 得说『我脑子炸了，你能帮我跟上进度吗？说简洁点……』
> 其他时候我强迫自己不再开新会话，而是干等几分钟让手上的跑完。」

Show HN: Beam – Terminal Organizer（2026-02-06）：

> 「我跑多个 Claude Code 会话，最大的摩擦**不是**整理终端，**是几小时后回来时记不起每一个在干什么**。
> 子窗口命名有帮助，但快速切换器里能有个『上一条命令』预览会更好。」

Show HN: 监控面板（2026-03-10）：

> 「干得漂亮！我每天用 Claude Code，**管理多个会话绝对是个痛点**。」

**判断**：这个痛点是真实的、被反复独立表述的。但注意——**它已经被 Agent view 解决了**，
而且用户对"解决方式"的期待是"轻量、内嵌"，不是"另一个仪表盘"。

### 4.2 「消毒过的乐观」——我们真正的差异点

Show HN: Real-time dashboard for Claude Code agent teams（item 47602986），多条独立评论：

> 「**不透明问题**是我撞得最狠的：当一个协调者并行派生 3–4 个 agent（builder、reviewer、tester），
> 你唯一的可见性就是它们选择回报的东西。而那通常是**被消毒过的、而且危险地乐观的**。」

> 「上面说的消毒过的乐观是这个帖子里的真正缺口。事件流日志告诉你调用了什么工具、什么顺序，
> **但它不告诉你 agent 自报的结果和现实是否一致。**」

> 「『agent 报告修好了』这个问题是真的。我见过 agent 说『修好了！』，其实就是把错误压下去了。
> 角色分离（builder/reviewer/tester）有帮助，但 **reviewer agent 也倾向于太客气**。
> 让它明确输出 PASS/FAIL/UNKNOWN、不给『整体看起来不错』留空间，是唯一对我有效的做法。」

> 「我也确认『消毒过的乐观』是真的。**必须加显式验证步骤**，因为 Claude 老是在只是消音了错误的时候就报成功。
> 现在**我总让它先证明真的生效了再往下走**。」

**这是本次调研最有价值的一条**：它同时验证了
(a) `verify-claims.mjs` 的问题定义是对的，
(b) 「锐评/验收必须能一票否决、不得给模糊结论留空间」是用户自己摸索出来的解法，
(c) 「执行者自评不可信」是有实证的，不只是我们的方法论洁癖。

### 4.3 通知 / 等待这件事，用户已经自己解决了

Message your other Claude Code sessions 讨论帖（173 分，72 评论）：

> 「当我的 Claude/Codex 跑完（或者需要我注意），它会 ping 一个本地 HTTP 端点，在我笔记本上放一声青蛙叫。
> 我发现这**极大提升了生活质量**。」

> 「我写了个小 exe，通过 Pushover 发通知。你可以配置 Claude Code 在 `idle_action`（agent 做完了）、
> `question`（agent 有事问你）、或者 `PermissionRequest` 时运行 hook。」

还有专门的项目在做：`cmux`（`cmux notify --title "Claude Code" --subtitle "Waiting" --body "Agent needs input"`）、
`bingbong`、`Claude Code Notifier Plus`、`vibe-notch`（2.5k★，"Claude Code notifications without the context switch"）。

**判断**：通知是**已解决**的问题。我们 README 里「在会话等你时叫醒你」这一条，**不构成差异**。

### 4.4 「自动接力」别人怎么解决的？

**没有人解决，而且原因清楚。** 三种替代路径，全都不是"自动接力"：

1. **handoff 文档 / 交接 skill**：Matt Pocock 的 `handoff` skill、`next_session_prompt.md` 协议、
   `ContextLedger`（"隔天要花十分钟重新解释在做什么"）。**都是人触发的**。
2. **上下文检索而非压缩**：Simon Willison 在该帖的诉求——「我受够了压缩。我要 agent 被压缩但仍能通过搜索和工具调用
   完整访问之前的对话。」相关项目：`memory_mcp`、`harness`、`hydra-acp`。
3. **官方跨会话消息**：Claude 自己发消息给另一个 Claude，纯文本，**不能代批权限**。

该帖里唯一的"自动"味道的东西是 `oh-my-claudecode` 的 `omc wait`：**限流重置后自动续跑**。
这是"因为外部原因停了→自动恢复"，不是"因为要决策→自动替用户决策"。

**判断**：**"自动接力"这条需求，在语义上被拆成了两半**——
「因为限流/掉线而停」→ 有人做（`omc wait`）；
「因为要用户决策而停」→ **平台明确禁止、也没人做**。
我们的 value proposition 如果落在后半句，等于在卖一个平台不让卖的东西。

---

## 五、我们的定位建议

### 5.1 差异点真伪判定

| 我们声称的 | 真差异？ | 依据 |
|---|---|---|
| 跨会话监控面板 | **伪** | Agent view 原生；开源 4000+ 同类 |
| 等用户时通知 | **伪** | 官方 `Notification` hook + `preferredNotifChannel`；vibe-notch 等一堆 |
| 跨 harness 扫描 | **弱** | codeg / paseo / agent-deck 都做了 |
| 四态判定（PRODUCING/EXPLORING/STALLED） | **伪**（我们自己也已承认） | 自家 README：STALLED 56,809 窗命中 10 次（0.018%），末态从未命中 |
| 接力草稿 | **弱** | 官方 cross-session messaging 更安全；我们也承认不能无痕注入 |
| **断言 vs 证据核对**（`verify-claims.mjs`） | **真** | HN 多条独立评论提出同一痛点「sanitised optimism」；Cognition 实测生成/验证分离有效 |
| **结构性停机检出**（`stop-signals.mjs`：错误停机 33%） | **真** | 我们自己的 n=179 实测；但没有外部对照，**属于自证** |
| **对抗式多 agent 方法论**（锐评/验收/修复三权分立、禁止静默共识） | **真，但是方法论不是产品** | Cognition 2026 的"干净上下文 review 更有效"间接支持；MAST 论文说单纯改角色规格不够 |

### 5.2 该不该继续做

**分三层回答，因为这三层的答案不一样。**

**第一层：作为一个"监控 + 通知 + 接力"的产品——不该继续。**
理由是硬的，不是我保守：
- 宿主原生覆盖（Agent view + cross-session messaging + Projects + `/goal`）；
- 开源侧 4000+ 同类、头部 4 万星；
- 关注度极低（Show HN 普遍个位数到两位数分数）；
- 而"自动接力"这一半被平台安全模型明确禁止。
**继续做的结果是可以预见的：做完就过时，而且是在跟宿主的版本发布赛跑。**

**第二层：作为一个"验证纪律"的 skill / hook / plugin——值得继续，而且应该现在就做。**
`verify-claims.mjs` + `classify-stop.mjs` + `stop-signals.mjs` 解决的是「agent 说完成了，到底有没有完成」。
这是**唯一一个既能被外部证据支持、又不在宿主路线图上、又不在开源饱和区**的点。
建议形态：**Claude Code 的一个 skill/plugin**（用 `Stop` hook 触发断言核对），
而不是一个要独立安装、独立维护运行台账的系统。分发渠道用官方 marketplace。

**第三层：作为一个"围绕用户的 AI 任务公司"的宏大叙事——应当知道这是在和谁竞争。**
Cognition 的 Devin Desktop 明确说「软件工程师的工作正在转向 **agent management**」，
并且已经做到 Devin 管 Devin、每个子 Devin 独立 VM、ACP 接第三方 agent。
Anthropic 的 Projects 在做"一个对话指挥一堆云端 thread，告诉你谁需要你"。
**这两家都在做我们描述的那个形状，而且都比我们多至少一样东西：VM 级隔离，或者宿主的实现权。**
我们唯一还有的、他们结构上不会做的，是**跨 harness 的、以证据为准的怀疑**——
大厂倾向于假设自家 agent 是可信的，第三方才有动机去做"我不信你说的，我要看证据"。

### 5.3 具体的三条建议

1. **把 `verify-claims` 抽出来做成独立可分发的 skill，砍掉其余。**
   现在的 `scan-sessions` + `watch` + 台账，是"为了证明 verify-claims 有用"而建的脚手架。
   脚手架可以留作内部工具，但不该是产品。

2. **在 README 里把「不能自动接力」从"我们的降级"改写为"平台的安全边界"。**
   现在 README 的语气是"我们做不到，我们诚实"。但官方文档写了「来自另一会话的消息永远不算你的同意」——
   **这说明"做不到"是正确行为，不是缺陷。** 这个叙述反转会显著提升项目的可信度。

3. **不要再增加任何「监控/看板/状态机」类功能。** 每增加一个，就多一处和宿主版本赛跑的地方。
   `docs/design/2026-11-04-next-phase-plan.md` 里的 T1–T5，**建议先确认它们不与 Agent view 重复**——
   据本文调研，其中至少"状态可见性""等待通知"两项已经被原生覆盖。

---

## 六、本次调研的缺口（诚实声明）

以下方向**没有查到**，不应被当成"不存在"：

1. **没有找到任何一篇"agent 监控面板"的失败复盘。** 只有间接信号（低关注度、作者转向编排）。
2. **没有找到 Reddit 上的具体讨论帖。** 搜索引擎未返回可用索引；HN 搜索有效，Reddit 需要另想办法。
3. **没有拿到 Devin 的实际定价与 ACU 消耗数据。** 只有 ARR 传闻（$492M→$900M→目标 $1B），且来源是二手商业媒体，**不应引用为事实**。
4. **Factory.ai 的"Droids"架构没有查到一手资料。** 搜索结果全是无关的中文趋势文。
5. **Cursor 3 的 Agents Window 只拿到官方文档，没拿到真实用户评价。**
6. **"同质多 agent 可被单 agent 复现"（arXiv 2601.12307）我没有验证它的实验设置**（是否覆盖 Claude Code 这类真实编码工作流），
   如果它的基准是合成任务，那对我们的适用性要打折。

---

## 来源

**一手官方文档**
- Claude Code · Agent view：`https://code.claude.com/docs/en/agent-view.md`
- Claude Code · Agent teams：`https://code.claude.com/docs/en/agent-teams.md`
- Claude Code · Cross-session messaging：`https://code.claude.com/docs/en/cross-session-messaging.md`
- Claude Code · Run agents in parallel（五种方式对比）：`https://code.claude.com/docs/en/agents.md`
- Claude Code · Projects：`https://code.claude.com/docs/en/claude-projects.md`
- Claude Code · `/goal`：`https://code.claude.com/docs/en/goal.md`
- Claude Code · Worktrees：`https://code.claude.com/docs/en/worktrees.md`
- Cursor · Agents Window：`https://cursor.com/docs/agent/agents-window`
- Cursor · Changelog（2026-11-06 语音、2026-11-05 live apps）：`https://cursor.com/changelog`

**厂商博客**
- Cognition《Don't Build Multi-Agents》2025-06-12：`https://cognition.ai/blog/dont-build-multi-agents`
- Cognition《Multi-Agents: What's Actually Working》2026-04-22：`https://cognition.ai/blog/multi-agents-working`
- Cognition《Devin can now Manage Devins》2026-03-19：`https://cognition.ai/blog/devin-can-now-manage-devins`
- Cognition《Introducing Devin Desktop》2026-06-02：`https://cognition.ai/blog/introducing-devin-desktop`
- Cognition《What We Learned Building Cloud Agents》2026-04-23：`https://cognition.ai/blog/what-we-learned-building-cloud-agents`
- Anthropic《How we built our multi-agent research system》2025-06-13：`https://www.anthropic.com/engineering/multi-agent-research-system`

**论文（arXiv API 取的摘要）**
- Why Do Multi-Agent LLM Systems Fail? `arXiv:2503.13657`（MAST / MAST-Data）
- Rethinking the Value of Multi-Agent Workflow: A Strong Single Agent Baseline `arXiv:2601.12307`

**Hacker News（Algolia API，`hn.algolia.com/api/v1/items/<id>`）**
- 49222824 · Message your other Claude Code sessions（173 分 / 72 评论）
- 47602986 · Show HN: Real-time dashboard for Claude Code agent teams（77 分）
- 47314375 · Show HN: Dashboard for monitoring multiple Claude Code sessions（3 分）
- 47765520 / 48061179 · Show HN: Claude Control（2 分）

**GitHub（REST API `/search/repositories`，2026-11-09 抓取）**
- `Yeachan-Heo/oh-my-claudecode` 40,709★（含 `omc wait` 限流自动续跑）
- `getpaseo/paseo` 23,605★ · `1jehuang/jcode` 21,634★ · `Maciek-roboblog/Claude-Code-Usage-Monitor` 8,797★
- `spacering-net/codeg` 4,407★ · `realiti4/claude-swap` 4,570★ · `graykode/abtop` 3,809★
- `farouqaldori/vibe-notch` 2,533★ · `standardagents/dmux` 1,818★ · `disler/claude-code-hooks-multi-agent-observability` 1,566★
- `asheshgoplani/agent-deck` 1,235★ · `hoangsonww/Claude-Code-Agent-Monitor` 1,160★ · `onikan27/claude-code-monitor` 314★
- `OpenHands/OpenHands` 93,026★ · `SWE-agent/SWE-agent` 20,765★
- 搜索计数：`claude code session manager` 610 / `claude code monitor` 4,083 / `coding agent orchestrator` 7,484
