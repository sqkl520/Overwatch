# Agent 框架雏形（v0 骨架）：边界、结构、最小链路

> **状态：Proposed，零行实现。**
> 本文件不描述任何已实现能力。系统现在能做什么，读 [README.md](../../README.md) 的「能力边界」。
> 本文件回答五个问题：**这个框架解决什么具体问题 / v0 做到哪为止 / 结构长什么样 / 最小链路是什么 / 怎么拆成可派发的任务。**

- 日期：2026-11-10
- 作者：规划 Agent P3
- 产出形态：artifact（框架雏形设计书 + 可派发任务）
- 前置输入：用户原话（逐字，作为设计前提）
  > 它可以带自己的手下，自己的手下也可以有手下
  > 它也可以带别人的手下，去完成自己手下做不到的事
  > 这两个都要做，我们目前先专攻带别人的手下（Claude code cli、dsh(可以延缓)），然后再专注搭建我们的 harness agent 框架
  > 这就是一个围绕着用户的公司，间接对接用户，公司内职责分明，又不臃肿，又可以外包给其他公司

---

## 零、覆盖声明

**读了（本仓）**：`README.md`（全）、`CLAUDE.md`（全）、`.claude/agents/*.md` **全部 12 份正文与 frontmatter**、
`.claude/skills/oversight/SKILL.md`（全 177 行）、`docs/spec/dispatch-contract.md`（全）、
`docs/spec/evidence-discipline.md`（全）、`docs/spec/output-format.md` §1–§4、
`docs/spec/state-model.md` §5.1–§5.3、`docs/adr/0001-config-only.md`（全）、
`docs/design/README.md`、`docs/design/2026-11-04-next-phase-plan.md`（全 774 行）、
`docs/design/2026-11-05-tui-redesign-plan.md` §0–§1、`docs/design/continuation-engine.md` §0–§1.1、
`docs/research/2026-11-04-dsh-superagent-analysis.md`（全）、
`docs/research/2026-11-04-orchestration-patterns.md`（全）、
`docs/research/2026-11-04-external-harness-protocols.md`（全）、
`docs/research/2026-11-04-competitive-landscape.md`（全）、
`docs/research/2026-11-01-dispatch-chain-audit.md`（全）、
`docs/research/2026-11-02-path-b-recount.md` §四（`claude -p` 判死那节）、
`docs/research/2026-11-05-verify-claims-productization.md` §一、
`tasks/dev-findings.md`（状态枚举与全部 open 条目）、`tasks/accepted-deviations.md`（AD-001–AD-004）、
`templates/dispatch.md`、`templates/acceptance-criteria.md`、`docs/CHANGELOG.md`（Unreleased 段）、
`tasks/runs/2026-10-30-p0/task-graph.json`（真实 run 产物）。

**读了代码**：`scripts/check-structure.mjs` 的 `checkAgents` / `checkAgentReachability` /
`checkDesignIndex` / `checkChangelog` / `checkInboxWiring`；`scripts/validate-run.mjs` 的
`CAPABILITIES` / `SHAPES` / `validateGraph` 头部；`scripts/verify-claims.mjs` 的
`detectClaims` / `findEvidence` / `classifyEvidence` / `scanSession` / `readTailRecords` / `resolveSession` 导出面。

**做了（只读实测，2026-11-10，本机 Claude Code 2.1.289）**：

| # | 命令 / 探针 | 结果 |
|---|---|---|
| 1 | `node scripts/check-structure.mjs` | ✓ 全部通过 |
| 2 | `node --test scripts/*.test.mjs` | **588 / 588 全绿**（52.9 秒；设计书写于 2026-11-10，此后持续增长——确切值跑这条命令看） |
| 3 | `claude -p --agent oversight-nonexistent-xyz "say hi"` | 门牌列出 18 个可用 agent，**含全部 12 个 `oversight-*`** —— 项目角色定义能被 `--agent` 解析 |
| 4 | `claude -p --agent oversight-probe ...`（剥 4 个宿主变量 + `ANTHROPIC_BASE_URL=http://127.0.0.1:15721`） | **3 分 10 秒后 exit=0，stdout 完全为空** |
| 5 | `claude -p --max-budget-usd 0.10 "Answer with exactly one word: PONG"` 同上配方 | 130 秒超时，无输出 |
| 6 | `claude -p --model haiku --verbose --output-format stream-json` 同上配方 | **4 分 07 秒**，只产出 `system/init` + `system/api_retry error_status=524`，无 result 事件；`startup_timing.input_ready_ms` 在两次运行里分别是 21032 / 0 |
| 7 | `curl -X POST http://127.0.0.1:15721/v1/messages` | **22 秒无响应**（code=000） |
| 8 | `curl -X POST http://127.0.0.1:15721/claude-desktop/v1/messages`（无有效令牌） | 2.3 **毫秒**返回 401 |
| 9 | `grep '^tools:' .claude/agents/*.md` | 12 份**全部命中**，**没有任何一份含 `Task`**（本版本派生子 agent 的工具名是 `Task`，见 #6 的 `init.tools`） |

**没做 / 无法核实**：
- **没有做任何多 agent 派发实验**，没有验证「5 个 Agent 并行」在本机的实际耗时与成本分布。本文件所有关于并发的论断都引自研究结论，不是自测。
- 没有实测 `acpx` 的当前版本（研究文档记的是 0.22.0，本次未复核版本与可用性）。
- 没有读 `scripts/watch.mjs` / `oversight-tui.mjs` 全文（与本设计无直接关系）。
- 没有确认 #4–#6 的根因是「网关上游慢/524」还是「`claude -p` 本身」。**只报观测，不报根因**——判别实验写进 T2。
- 用户原话里「间接对接用户」的语义（是「不让用户看到内部过程」还是「用户只跟一个入口说话」）我按后者理解，未向用户确认。

**本文件最重要的一条与简报不一致之处**：简报把「`claude -p`：58 秒，全套工具，配方是去掉四个宿主变量 + `ANTHROPIC_BASE_URL=http://127.0.0.1:15721`」列为「已确认的技术事实，不要重新验证」。**本次按该配方复现，三次全部失败**（3m10s 空输出 exit=0 / 130s 超时 / 4m07s 只拿到 524 重试）。我不推翻「它曾经能用」，但**不能再把它当作 v0 的同步派发通道**。见 §3.5。

---

## 一、前置问题：这个框架要解决什么具体问题

### 1.1 先承认最危险的那个答案

如果答案是「让多个 agent 协作」，那这个项目不该存在。理由不是品味，是三条硬事实：

1. **现成框架已经饱和**：LangGraph / AutoGen / CrewAI / OpenAI Agents SDK 都有自己的子 agent、handoff、supervisor 形态，且都被证明可用。
2. **宿主已经做了我们原来想做的那一层**：`claude agents`（Agent view）原生列出所有会话、按 Working / Needs input / Completed 分组、状态变化发通知、可派发可 peek。这是 README 自己承认的。
3. **多 agent 的实证是「省着用」**：Anthropic 自报多 agent 比 chat 多烧 **15×** token，且 token 用量单独解释 **80%** 的性能方差。MAST（1600+ 轨迹）实测「改进角色规格」「增强协调」两类干预**效果不充分**。arXiv 2601.12307 更进一步：同质工作流可被单 agent 多轮对话等价复现，且更便宜。

所以「多几个 agent 一起干活」这个卖点，在 2026 年 11 月既没有技术理由，也没有经济理由。

### 1.2 这个框架真正要解决的问题

用户原话里其实已经排好了三件事，只是没分开命名。把它们拆开：

| # | 问题 | 现状 | 归属 |
|---|---|---|---|
| P1 | **注意力**：这么多个会话，谁在等我、谁在空转 | 宿主原生覆盖（Agent view + Notification hook + 4 千个开源同类） | **不是我们的问题，不该再做** |
| P2 | **归责**：「AI 说它做完了」到底有没有证据 | 只有第三方有动机做（大厂默认信任自家 agent）；HN 长贴反复出现「sanitised optimism」 | **我们独占，已实现（`verify-claims.mjs`）** |
| P3 | **组织**：一个超出单会话能力的目标，怎么切成工单、派给不同 harness、把结果收敛成一份能验收的交付 | 没有任何一方解决。dsh 只带自己的手下；OpenHands 只驱动子进程不建组织；Cognition 说「所有开放问题都是沟通问题」 | **这个框架要解决的** |

**所以框架的命题是 P3，一句话：**

> 把「一个目标」变成「一组带预声明验收标准的工单」，派给**不是我们的** CLI 进程去干，并把回收上来的东西判成「过 / 不过 / 不知道」，而不是判成「AI 说它做完了」。

注意这句话里没有「并行」「协作」「swarm」。**它是关于「归责与收敛」的，不是关于「并发」的。** 这个区别决定了后面每一个设计选择。

### 1.3 为什么不用现成框架

不是「我们更聪明」，是三条结构性不匹配。**每一条都可以被证伪，写在下面。**

| # | 不匹配 | 具体证据 | 什么情况下这条不成立（即：该改用现成框架） |
|---|---|---|---|
| **N1** | **协议层不对：它们管不了别人的进程** | LangGraph 的 subgraph、AutoGen 的 GroupChat、OpenAI 的 handoff 都要求 worker 在**同一个 runtime 内**、由你的进程持有生命周期。我们要带的是**别人的 CLI 进程**：id 是宿主的、权限是宿主的、能不能插话不由我们决定。dsh 的完整调度能力建立在 10 个特权 API 上（`sessionController.create` / `tools.restrict` / `steer` / `cancel` / `guard`），Overwatch 一个都没有——ADR-0001 已裁决。**对得上的协议是 ACP，不是任何编排框架。** | 如果 v0 只用 native subagent（自己 spawn、自己拥有生命周期），则 N1 不成立，LangGraph/langgraph-supervisor 可以直接用。**这正是「带自己的手下」那一支的结论：它不需要框架，它需要 Agent SDK。** |
| **N2** | **编排单位不对：我们编的是「工单 + 预声明 AC」，它们编的是「消息/节点」** | MAST 的失败分布是 规格 41.77% / 交互失配 36.94% / 验收 21.30%，最大单点是「步骤重复 17.14%」。这两类失败都不是「编排图不够灵活」，是**没有一份外部状态被反复重述**。Magentic-One 的消融给了硬数字：去掉 task ledger + progress ledger，GAIA 掉 **31%**。我们的派发契约 §2 已经要求「四样东西」（原任务 / 预声明 AC / 产出形态 / 预算），这是 ledger 的一种；现成框架里没有等价物，要自己写。 | 如果 MAST 那 41.77% 的规格类失败在我们这里**不发生**（即预声明 AC 没带来任何改善），则 N2 不成立，该退回去用现成框架。**这条是可测的：见 §5 的 T5 的成功判据。** |
| **N3** | **通信面不对：它们默认的通信面是「全广播」，我们要的是「三事件」** | AutoGen GroupChat 是**全量广播**（这是它上下文臃肿的主因）。我们逐系统核对过（`orchestration-patterns.md` §一，10 个系统）：**通例是「只在完成 / 阻塞失败 / 需要决策这三种事件上唤醒上级」，没有任何系统把子级中间步骤推送上去。** dsh 有 `progress` 通道，然后用 `return undefined` 把它丢掉。所以正确做法不是「过滤 progress」，是**「只有三种事件存在」**。 | 如果任务本质上需要高频来回协商（例如设计评审式对话），三事件不够用，该用共享消息流的框架。**v0 明确不做这类任务。** |

**还有一条不算「不匹配」但必须写的理由**：我们已有的资产是**现成的、被近八百条测试钉住的**组织资本——12 个带工具白名单的角色、派发四要素、两本台账、四档证据分级、结构硬门。在 LangGraph 里这些全部是「你自己写」。**换框架意味着把这些全部重写一遍，且失去已经验证过的那一层。**（写作时实测 588 条；测试数一直在长，确切值以 `node --test scripts/*.test.mjs` 的输出为准，见 `docs/GUIDE.md` §9。）

**反过来，也要说清楚现成框架在什么场合明显更好**：任务形状固定、要跑几十上百次的 fan-out（Claude Code workflows 的 `16 并发 / 1000 agent / 25 agent 告警`）；需要跨机器/跨组织的委托（A2A）；需要复杂 DAG 调度与重试。**这三件 v0 一件都不做。**

### 1.4 用户说的「先专攻带别人的手下，再搭自己的框架」——我的判断

**这个顺序在目标上是对的，在实现上会把同一块砖砌两遍。**

理由：用户说的「带别人的手下」如果只是「能 spawn 别人的 CLI」，那它不是公司的职能，是 `child_process`——**OpenHands 已经把「ACP 驱动 Codex / Claude Code / Gemini CLI / OpenCode + 流式工具卡 + 重启 resume + 累计成本」做成了产品功能。** 那一层不需要我们论证。

真正让「带别人的手下」变成「公司」的，是三件在协议层之下、执行层之上的东西：

1. **工单**：派出去的是什么（目标 + 预声明 AC + 边界 + 预算），而不是一句 prompt。
2. **汇报契约**：回来的只有三件事，且结构可机读。
3. **验收闸**：谁判「过不过」，且不能是干活的那个人。

**这三件就是框架本身。** 所以「先做外包、后做框架」实际上是「先做框架的接口、后做框架的递归」——顺序不冲突，只是需要把命名分清：

- **v0 = 一个工单 + 一个外部适配器 + 一个验收闸**。这既是「带别人的手下」，也是框架的第一块砖。
- **v2 = 递归（自己的手下有手下）**。这不是 v0 的自然延伸，是另一条成本曲线（15×），必须单独裁决。

我建议这样表述给用户：**v0 同时交付「带别人的手下」和「框架雏形」，因为它们是同一个接口的两面；递归留到 v2，理由是物理不可达 + 成本，不是优先级。**

---

## 二、雏形的边界

### 2.1 v0 做什么（五件，缺一不成链）

| # | 做什么 | 为什么是这五件之一 |
|---|---|---|
| **A** | **工单数据结构 + 校验器**：`ticket.json`（目标 / shape / AC[] / 边界 / 预算 / 适配器），由 `planner` 角色产出，由脚本机械校验 | 「预声明验收标准」是本仓最硬的一条，也是 MAST 里最大的一类失败（41.77%）。没有 schema 的派发模板等于自由文本——研究结论原话：「我们的派发模板目前是自由文本模板，没有任何 schema 拒绝『派发者顺手加实现方案』」 |
| **B** | **一个外部适配器**：`acpx` + `opencode acp`（本地已实测端到端跑通，逐 token 流式） | 用户要的「带别人的手下」的最小可实现形态。**只做一个**，因为多适配器在没有 ledger 的情况下会互相踩（Cognition A4） |
| **C** | **三事件汇报协议 + supervisor**：只允许 `DONE` / `BLOCKED` / `NEEDS_DECISION`。没有 progress。报告落盘，父只读 5 个字段 + 指针 | 「主 agent 怎么不被淹没」的唯一正确答案是**不发**，不是压缩。这是 10 个系统的通例 |
| **D** | **验收闸**：`acceptor` 角色（干净上下文，只看 ticket 的 AC + 报告指针）逐条判；不过 → `repair` 一轮 → **完整**重验 | 一票否决 + 执行者不自评，是「sanitised optimism」的唯一对治。Cognition 实测：干净上下文 review agent 平均每个 PR 抓 2 个 bug，58% 严重 |
| **E** | **run 台账**：`tasks/runs/<run-id>/{goal.md, ticket.json, report.json, verdict.md, cost.json}`，一条链路跑完必须齐全 | dsh 的教训是「一切只增不删」；我们的对策不是删，是**一开始就只存五样**，且每样都有消费方（TUI / verify-claims / 下一轮 planner） |

**一周内可跑通的判据（写在前面，避免事后改口）**：

```
node scripts/org.mjs run "把 README「已知局限」表补两行实测数字"
→ 退出码 0
→ tasks/runs/<新 run-id>/ 下五个文件都存在且非空
→ verdict.md 里有逐条 AC 判定（不是「基本满足」）
→ 终端最后输出 ≤10 行：做了什么 / 证据在哪个文件 / 花了多少钱 / 下一步
→ 全程用户只输入了那一行命令
```

**这条判据不包含**：多工单、并行、递归、多 harness、自动重试跨 run。**它只证明「结构成立」，这正是「雏形」的定义。**

### 2.2 v0 不做什么（每条给理由，不是给态度）

| # | 不做 | 理由（不是「以后再做」，是「现在做就是错的」） |
|---|---|---|
| **X1** | **不做递归（子 agent 再派子 agent）** | **物理不可达**：本版本派生子 agent 的工具名是 `Task`（实测 `init.tools`），12 份角色 frontmatter **全部显式列了 `tools:` 且无一份含 `Task`**。Claude Code 的 `tools` 是精确白名单，所以**这 12 个角色最深只能到深度 1**。而 `dispatch-contract.md` §7 写着「默认深度上限 3 层」——**规范声称的能力在实际配置里不存在，这比没有规范更坏**（一个读者会据此设计三层方案）。v0 的动作是**修规范**，不是加能力。成本侧：15× token，v0 没有任务值够付这笔钱。 |
| **X2** | **不做多适配器并行（同时接 Claude Code / dsh / Codex）** | 并发写同一个产物 = Cognition 的「Flappy Bird」失效：一个做背景一个做鸟，合成 agent 只能收拾烂摊子。v0 只证明「一个适配器闭环」。接第二家是 `v1`，前提是 v0 的验收闸能被证明拦得住东西。 |
| **X3** | **不做 progress 通道（哪怕是「先加上再过滤」）** | 过滤是一个**需要维护的判断**，枚举是一个**不需要判断的白名单**。dsh 有 progress 然后丢掉，那是它已经付过的学费。我们直接不做这个字段。 |
| **X4** | **不自己写 ACP client** | `acpx --format json` 输出裸 ACP wire JSON（官方保证不加壳），30 个内置 profile 里含 `claude` 与 `deepseek-harness`。自己写协议栈是纯粹的重复劳动。**但 `acpx` 是 pre-1.0**，所以适配器必须藏在子进程边界后面，坏了能整个换掉而不动上层。 |
| **X5** | **不做沙箱/权限隔离的承诺** | dsh 自己的文档原文：「These wrappers and directories establish **defaults, not a security boundary**. A worker can still execute a program by absolute path.」只写在 prompt 里的限制等于没限制；我们连 prompt 都写不进别人的进程。**v0 只能承诺「记录它做了什么」，不能承诺「阻止它做什么」。** 这条必须写进 README，否则会重演「以为能自动接力」的错。 |
| **X6** | **不做往用户已有会话注入（自动接力）** | 平台安全模型明确禁止：来自另一会话的消息「永远不算你的同意」。ADR-0001 已裁决。v0 的边界是「spawn 自己的进程」，**不是「接管用户的进程」**。 |
| **X7** | **不做 GUI / 不改 TUI** | TUI 刚在 2026-11-05 重做过一轮，`docs/design/2026-11-05-tui-redesign-plan.md` 的七个任务零行实现。在框架未跑通前动界面，是把两个未验证的东西相乘。 |
| **X8** | **不做配置语言 / 插件系统 / DSL** | v0 的 ticket 用 JSON，adapter 用 JS 对象，宁可丑。dsh 的 1.5 万行里有相当一部分是「Everything is a Plugin」的代价，我们用不上。 |
| **X9** | **不把「修好了」当成验收标准** | 这是本仓已有纪律（`evidence-discipline.md` §1 四件套），但**在框架里必须变成可执行检查**：`verdict.md` 里出现「基本满足」「整体不错」「大致完成」之一 → 校验器直接判 verdict 无效。 |
| **X10** | **不做「事后合并 + 多轮投票」** | Cognition 的原则 2：「actions carry implicit decisions, and conflicting decisions carry bad results」。若要多 agent 结论可比，唯一可靠的办法是**派发前生成同一份 baseline 事实快照**（`dispatch-contract.md` §1 已有此设计），不是事后投票。 |

### 2.3 一条不写进上表、但决定成败的边界

**v0 不承诺「质量变好」。** MAST 的结论是：改角色规格、增强协调这两类干预**效果不充分**。v0 只能承诺两件可测的事：

1. **可归责**：每个交付物都能追到「谁派的、什么 AC、谁判的过、证据在哪」。
2. **不漏放**：验收不过的时候，不会因为「看起来差不多」被放过去。

**「质量更好」需要证据，而 v0 的设计里没有任何东西能产生那个证据。** 这句话要留在文档里，防止下一个读者把「结构成立」误读成「效果更好」。

---

## 三、结构设计

### 3.1 角色从哪来：沿用 12 个，但 v0 只用 4 个

**沿用，不新定义。** 理由：这 12 份是唯一被「近八百条测试 + 结构硬门」钉住的组织资本，而且它们的**工具白名单是物理边界**（`checkAgents()` 强制只读角色不得含 `Edit`/`Bash`），不是 prompt 里的请求。重写等于放弃这道门。

但 **v0 只用 4 个**，其余 8 个不派：

| 角色 | v0 用不用 | 理由 |
|---|---|---|
| `planner` | ✅ **用** | 产出 ticket.json（它的输出 schema 已经写好，`validate-run.mjs` 已经在校验） |
| `executor` | ✅ **用**（作为**外部适配器的任务描述来源**，不是 native 角色） | 见 §3.2 的分层说明 |
| `acceptor` | ✅ **用** | 一票否决；`tools` 无 `Edit`，改不了被验收的文件（物理限制） |
| `redteam` | ✅ **用**（每周一次攻击框架本身，见 §5 T6） | 是本仓唯一有「必须实际验证 ≥3 条」硬要求的角色 |
| `critic` | ❌ 不用 | 它的输入是**拆解图**，v0 只有 1 个工单，没有拆解图可质疑 |
| `research` | ❌ 不用 | 需要网络，且 v0 的任务不检索外部事实 |
| `review` | ❌ 不用 | 管「好不好」，v0 只需要「过不过」。**混进来自毁独立性** |
| `repair` | ⚠️ 有限用 | 只在验收不过时触发，最多 1 轮（不是 3 轮——v0 没有足够的钱跑 3 轮） |
| `probe` | ❌ 不用 | 它的输入是**别人的 transcript**（用户已有会话），v0 spawn 的进程由我们自己观察，不需要它 |
| `relay` / `safety` | ❌ 不用 | 服务于「往用户会话发消息」，v0 不做（X6） |
| `resolution` | ❌ 不用 | 服务于「多 agent 分歧」，v0 只有 1 个执行者，没有分歧可裁决 |

**这张表本身就是「不臃肿」的实现**：12 个角色都在，但 v0 的编队是 4 个。dsh 的做法是主 Session 的 preset 里干脆不放某些工具；我们的做法是**保留定义、按 run 声明编队**，并在 `ticket.json` 里写清本次用了哪几个、为什么不用其余。

### 3.2 最关键的一条分层：**角色 ≠ harness**

这是整份设计里最容易搞混、也最容易搞砸的一处。

```
角色（org chart 上的位置）        谁在物理上干活
─────────────────────────       ──────────────────────────
planner        ─────────────→   native subagent（我们的 Claude Code 会话内）
acceptor       ─────────────→   native subagent
redteam        ─────────────→   native subagent
executor       ─────────────→   ★ 外部适配器（acpx + opencode）  ← v0 唯一的外包位
```

**为什么必须分开命名**：用户原话「带别人的手下」里的「手下」有两层意思——
(a) 组织里的一个**岗位**（executor），(b) 干活的一个**进程**（Claude Code CLI / dsh / opencode）。
如果不分开，就会出现「executor 这个角色绑死在 Claude Code 上」的结果，换 harness 时整个组织图要重画。

**v0 的做法**：`ticket.json` 里 `role: "executor"` 和 `adapter: "acpx:opencode"` 是**两个字段**。
同一个 executor 岗位，明天可以换 `adapter: "acpx:claude"`，组织图不动。

**顺带解决一个真实矛盾**：`dispatch-contract.md` §4 的角色清册里，`executor` 的工具白名单是
`Read, Write, Edit, Bash, Glob, Grep`——那是**native subagent 的**白名单。外部 harness 不受它约束
（opencode 有自己的权限模型，ACP 的 `session/request_permission` 方向是 agent → client）。
所以 §4 那张表要加一列：**「本角色在 native 执行时 / 在外部适配器执行时，各自的白名单在哪」**。v0 只需要填 executor 一行。

### 3.3 层级怎么限：把「3 层」改成「1 层」，并把理由写成实测

现有规范 `docs/spec/dispatch-contract.md` §7：

> 子 Agent 可以派生下级，默认深度上限 3 层（宿主默认值即为 3，见 `docs/adr/0001-config-only.md`）。

**这条不可执行，我有三条独立证据**：

1. **12 份角色全部显式列了 `tools:`**（实测 §0 表格第 9 行），**没有一份含 `Task`**。
   本版本的派生子 agent 工具名是 `Task`（实测 `claude -p` 的 `init.tools` 数组里第一个就是 `Task`，
   同时没有 `Agent`）。Claude Code 的 `tools` 字段语义是**精确白名单**（列出即只给这些），
   所以这 12 个角色**只能到深度 1**。
2. Claude Code 对 subagent **本来就不给 `Task`**（"withholds the `Agent` tool from every subagent except a fork"）。
   所以即便给角色加了 `Task`，深度 2 的下一层仍然拿不到派生能力，除非显式 fork。
3. 结构硬门 `checkAgents()` **只校验「只读角色不得含 `Edit`/`Bash`」，不校验 `Task` 的有无**——
   这道门对深度完全无感。

**结论与动作**（v0 必须做，属于文档修正而非能力新增）：

```diff
- 子 Agent 可以派生下级，默认深度上限 3 层（宿主默认值即为 3）。
+ v0 的深度是 **1 层**（主线程 + 一层执行者），这是**设计选择**，也是**当前配置的事实**：
+   12 份角色定义全部显式声明了 tools 白名单，均不含 Task（派生子 agent 的工具在本版本叫 Task），
+   所以它们物理上派生不了下一层。规范不描述不存在的能力。
+ 递归（深度 ≥2）不在 v0 范围内。若将来要做，前提是：① 给需要递归的角色显式加 Task 并接受 15× token；
+   ② 每一层派发必须写明「为什么需要这一层，而不是由父级自己完成」；③ 独立裁决，不随 v0 顺延。
```

**这条修正的价值不在措辞，在于**：它把「我们有个三层组织」这个幻觉换成了「我们有一层组织，且我们知道自己只有一层」。后者才能被用来做决策。

### 3.4 主 agent 怎么不被淹没：三个机制，一个都不可省

**机制 1：不存在 progress 通道（枚举，不是过滤）**

```js
// 汇报只有三种。没有第四种，也没有"其它"。
const REPORT_STATES = Object.freeze(['DONE', 'BLOCKED', 'NEEDS_DECISION']);
```

对照：dsh 的 `ReportState` 是六值（`progress / waiting / ready / blocked / failed / dropped`），
然后 `notices.ts:127` 把 `progress` 显式丢掉。**我们直接不提供这个值。**

**机制 2：报告落盘，父只读五个字段 + 指针**

父 agent 收到的**不是子 agent 的正文**，是一个卡片：

```json
{
  "ticket_id": "T-0001",
  "state": "DONE",
  "summary": "≤160 字",              
  "changed_files": ["path", "..."],  
  "cost": { "usd": 0.0, "tokens": 0 },
  "read": "tasks/runs/<id>/report.md"   ← 指针，需要全文时按需读
}
```

**「给了指针就敢截断」是这套设计能成立的关键**：截断不是信息丢失，是把成本推给真正需要的人。
（dsh 的 `preview()` 截 160 字，Anthropic Research 的 subagent 报告是 1,000–2,000 token。）

**机制 3：预算与超时由 supervisor 判，不由父 agent 等**

- 每个 ticket 声明 `token_budget_pct` 与 `timeout_min`。
- 超时 → supervisor 判 `TIMEOUT`（**不是**「还在跑」）。理由：dsh 用代码守卫拦 `sleep` 和 >30s 超时，
  理由是「a blocked step delays new candidates」；我们的 `runTick` 曾经把派发放所有层之后，
  轮内 p90=45s，是同一个失效模式。
- 父 agent 在等待期间**不做任何轮询**，因为三事件里没有「进度」可轮询。

**这三条合起来的效果**：主 agent 的上下文里，一个工单最多占一行卡片；10 个工单最多占 10 行。
不是靠压缩做到的，是靠**输入不存在**做到的。

### 3.5 外部 harness 怎么接：先用 acpx + opencode，不用 `claude -p`

**这是本设计里唯一一处我推翻简报前提的地方，所以证据给全。**

| 候选 | 本机实测（2026-11-10） | 结论 |
|---|---|---|
| **`acpx` + `opencode acp`** | 研究文档记录：端到端跑通，逐 token 流式，拿到 `usage_update` 与 `stopReason`（`acpx 0.22.0`） | **v0 首选**。唯一被实测跑通的组合 |
| **`acpx` + `claude`（claude-agent-acp）** | 未跑通：Windows 上 `zod/v4` 目录导入的 ESM 解析 bug | 不用。不是我们的 bug，但要等它修 |
| **`claude -p`** | 按简报给的配方（剥 4 个宿主变量 + `ANTHROPIC_BASE_URL=127.0.0.1:15721`）复现 **3 次全败**：3m10s 后 **exit=0 且 stdout 完全为空**；130s 超时；4m07s 只拿到 `api_retry error_status=524` | **不能作为 v0 的同步通道**。但**不能判死**——见下文 |
| **`claude mcp serve`** | 32 秒，stdio，23 工具 | 不是「派活」，是「把 Claude 当工具集」。**方向不对**（MCP 里 agent 是主、我们是工具；ACP 里我们是主） |
| **dsh（`dsh --profile acp`）** | 协议层全通，败在 DeepSeek 账户余额；且**往 stdout 写非协议日志会污染 ACP 通道** | 用户已说「可以延缓」。**v1 候选**，且必须先解决 stdout 污染 |

**为什么 `claude -p` 这一条特别危险**（比「慢」严重得多）：

> **它在失败时 `exit=0` 且没有任何 stderr。**
>
> 一个天真的 dispatcher 会把它判成「成功，只是没说话」——这正好是我们要治的病
> （README：「AI 说它做完了」到底有没有证据）。**框架自己踩同一个坑，是设计缺陷里最不该出现的一种。**

所以 v0 的 supervisor 有一条硬规则（属于机制 1 的补充）：

```js
// exit 0 + 空 stdout + 无 report.json  ==> UNKNOWN，不是 DONE
// 且 UNKNOWN 必须冒泡成 NEEDS_DECISION，不许静默重试
```

**`claude -p` 的处置**：不判死，降级成 **T2 的一个前置子任务**（重新验证它是否可用，给出可复现判据）。
通过 → 升为第二个适配器；不通过 → 在 README 的能力边界里写清「本机 `claude -p` 当前不可用于派发，原因与复现命令」。

**为什么这个选择是对的，而不是「偷懒不接 Claude Code」**：用户明确说优先 Claude Code CLI。
我不是不接，是**它今天在这台机器上不工作，且失败方式是静默的**。先接一个能跑的（opencode），
把工单/汇报/验收这条链证明成立；等 `claude -p` 或 `claude-agent-acp` 修好，换 adapter 字段即可——
这正是 §3.2「角色 ≠ harness」那条分层换来的好处。

### 3.6 交接格式（v0 的唯一硬数据结构）

**`ticket.json`**（由 planner 产出，由 `scripts/validate-ticket.mjs` 机械校验）：

```json
{
  "run_id": "2026-11-11-<slug>",
  "ticket": {
    "id": "T-0001",
    "goal": "逐字目标，不是转述",
    "role": "executor",
    "adapter": "acpx:opencode",
    "shape": "artifact",
    "boundary": ["不许碰 docs/spec/", "不许 git 操作", "不许装依赖"],
    "acceptance": [
      { "id": "AC1", "criterion": "可观测事实", "evidence": "file:line | 命令输出", "fail_if": "什么情况直接否决" }
    ],
    "token_budget_pct": 30,
    "timeout_min": 12,
    "why_this_layer": "为什么需要派出去，而不是主线程自己做"
  }
}
```

**必填判据**（复用 `validate-run.mjs` 已有的四类检查，加两条）：
- `acceptance` 非空，每条三字段齐全，`fail_if` 不得为空（**没有否决条件的标准等于没有**）
- `shape` ∈ `{artifact, exploration, hybrid}`
- `why_this_layer` 非空（写不出就不许派）
- **新增**：`boundary` 非空（研究结论：「派发四要素」缺的正是「不许碰什么」）
- **新增**：措辞黑名单 —— `criterion` 里出现「质量良好 / 功能正常 / 大致 / 基本 / 尽量」→ 拒绝

**`report.json`**（由 supervisor 从适配器产出物里抽取，**执行者不能自己写这个文件**）：

```json
{
  "ticket_id": "T-0001",
  "state": "DONE | BLOCKED | NEEDS_DECISION | UNKNOWN | TIMEOUT",
  "summary": "≤160 字",
  "changed_files": [],
  "claim": "执行者原话里那句完成声明（逐字，供 verify-claims 核对）",
  "cost": { "usd": 0, "tokens": 0, "wall_ms": 0 },
  "read": "tasks/runs/<id>/report.md"
}
```

**关键设计**：`report.json` 由 supervisor 写，不由执行者写。
理由：执行者写自己的报告 = 自我评价，而 `evidence-discipline.md` 与本仓三处角色定义都明令禁止把自我评价喂给判定方。
**执行者只能在 `report.md` 里自由写作，那部分不进入父 agent 的上下文。**

**失败处理（四档，互斥）**：

| 情形 | 判定 | 动作 |
|---|---|---|
| 适配器退出码 ≠0 且 stderr 里有 408/429/5xx/连接错误 | `TRANSIENT` | 重试 ≤3，退避 15/30/60 秒（dsh 的 `transient()` 口径，可整段照抄） |
| 退出码 ≠0，其余 | `FAILED` | 不重试。同一原因重跑 2 次后**必须换策略**（`state-model.md` §6 L5 已有此规则） |
| 退出码 =0 但无 `report.md` / 无 `changed_files` / stdout 空 | `UNKNOWN` | **不重试，冒泡成 NEEDS_DECISION**。这是 `claude -p` 实测暴露的那条 |
| 超过 `timeout_min` | `TIMEOUT` | 杀进程，记 `killed: true`，冒泡成 BLOCKED |

---

## 四、最小链路（一条，精确到命令）

任务选型原则：**一件真的值得做、但小到 12 分钟能做完、且产物可机械检验的事**。
不选「写一个功能」（会拉进测试/构建的副作用），选「补一份文档里的实测数字」——
因为这类任务的验收标准可以精确到 `file:line`，且不需要跑测试。

```
用户输入（唯一一次输入，一行）：
node scripts/org.mjs run "把 README「已知局限」表补两行：STALLED 与 needs 覆盖率的实测数字"

────────────────────────────────────────────────────────────────
[1] 主线程（org.mjs）
    生成 run_id = 2026-11-11-readme-limits-<hash6>
    写 tasks/runs/<id>/goal.md ← 用户原话，逐字，不转述
    写 tasks/runs/<id>/baseline.md ← 当轮事实快照（commit、README 行数、
         verify-claims 上次全量结果、scan-sessions 上次全量结果）
    预算：root 40% / 单工单 30%，总时限 20 分钟
    ★ 主线程不读 goal.md 之外任何东西，不分析任务

────────────────────────────────────────────────────────────────
[2] planner（native subagent，干净上下文）
    输入：goal.md 逐字 + baseline.md + 台账两本
    产出：tasks/runs/<id>/ticket.json
      goal: "在 README「已知局限」表里补两行，每行必须带实测数字与测法"
      role: executor / adapter: acpx:opencode / shape: artifact
      boundary: ["只改 README.md 的「已知局限」表", "不碰 docs/spec/",
                 "不 git add/commit/push", "不安装任何依赖"]
      AC1: 「已知局限」表新增恰好 2 行
           evidence: file:line + 表格行数
           fail_if: 行数 ≠2，或改动了该表以外的任何 README 内容
      AC2: 每行的数字都能追到一条可复跑的命令
           evidence: 表中出现的命令原文
           fail_if: 数字没有对应命令，或命令跑不出该数字
      AC3: 不得新增「待办」「以后会修」类表述
           evidence: git diff 里 grep
           fail_if: 出现 TODO / 待办 / 计划中 / 后续
    主线程：node scripts/validate-ticket.mjs <ticket.json>  ← 不过就退回 planner

────────────────────────────────────────────────────────────────
[3] supervisor 派发（外部适配器，这是"别人的手下"）
    spawn: acpx opencode --format json
    cwd:   .tmp-runs/<id>/worktree   ← 独立目录，不污染仓库
    prompt = 公共段(templates/dispatch.md)
           + 域段(ticket 的 goal + boundary + AC，逐字)
           + baseline.md            ← 易变段放最后（缓存友好）
    ★ 不给它看：其他工单、上次的自我评价、我们的历史结论

────────────────────────────────────────────────────────────────
[4] 从 ACP 流里只取三件事（不是全量）
    - 最后一条 agent_message_chunk 拼起来 = 执行者的完成声明（原文，供 AC 与 verify-claims）
    - stopReason（end_turn / max_tokens / ...）
    - usage_update 的 cost
    ★ 中间过程（thought / tool_call / plan）落 observation 日志，不进父上下文

────────────────────────────────────────────────────────────────
[5] supervisor 收拢
    ★ 检查 worktree 里真的有改动：git -C <worktree> diff --stat 非空
       空 → state = UNKNOWN（不是 DONE）
    写 report.json（那五个字段）+ 复制 report.md（执行者原文）
    写 cost.json

────────────────────────────────────────────────────────────────
[6] acceptor（native subagent，干净上下文）
    输入：ticket.json 的 AC[] 逐条 + report.json 的 read 指针 + worktree 的 diff
    ★ 不给它：report.md 里的执行者自评、cost、我们的历史结论
    产出：verdict.md
      ## 验收结论：通过 / 不通过
      ## 逐项判定  | AC | 通过/不通过 | 证据(file:line 或「未找到」) | 说明 |
      ## 否决理由（逐条，附「改哪一项即可通过」）
      ## 覆盖声明
    ★ 校验器拦：verdict.md 出现「基本满足/整体不错/大致完成」→ verdict 无效

────────────────────────────────────────────────────────────────
[7] 不过 → repair（native，最多 1 轮）→ 完整重新验收（不是抽查）
    仍不过 → 写 failure.md，退出码 1，不假装通过

────────────────────────────────────────────────────────────────
[8] 结果回到用户（≤10 行）
    [阶段E · DONE] 2026-11-11-readme-limits-a3f2c1
    做了什么：README「已知局限」表 +2 行（记录了 STALLED 0.018% 与 needs 16 中 3）
    证据：tasks/runs/<id>/verdict.md（AC1 ✅ AC2 ✅ AC3 ✅）
    花了：$0.04 · 3m12s · 1 个工单 · 0 次重试
    下一步：改动在 worktree .tmp-runs/<id>/worktree，要合并请手动 diff
```

### 4.1 这条链路证明什么、不证明什么

| 证明了 | 怎么证明的 |
|---|---|
| 「预声明 AC」能在**外部执行者**身上生效 | AC 是 ticket 字段，不是 prompt 里的一句话；acceptor 只看 AC[] 与 diff |
| 「三事件」够用 | 整条链路里没有一次「问进度」；父 agent 的上下文里只有一个卡片 |
| 「验收闸」拦得住东西 | 有负向测试：把 AC 改坏 / 让执行者输出空改动 → verdict 必须是不通过（T4 的 AC） |
| 「别人的手下」真的被驱动了 | 执行者是 `opencode` 进程，不是我们的 subagent；worktree 里有它的实际改动 |

| **不证明** | 为什么 |
|---|---|
| 质量更好 | MAST：改角色规格 + 增强协调**效果不充分**。见 §2.3 |
| 能并行 | v0 只跑 1 个工单。并行需要 ledger，是 v1 |
| 递归可行 | 见 §3.3，物理不可达 |
| 便宜 | 15× token 的账 v0 没算过，因为只有 1 个工单 |

---

## 五、任务拆解（7 个，6 个可并行）

编号约定：`F1`–`F7`。依赖关系见 §5.8。
**每个任务的验收标准都是可机械检验的**，不写「质量要好」。所有任务遵守 `evidence-discipline.md` §4 的覆盖声明要求。

---

### F1 工单与报告的数据结构 + 校验器

```
任务名：把 ticket/report 从「模板」变成「schema + 可执行校验」
产出形态：artifact
角色：executor（native；需要 Write 与 Bash）
输入：
  - 本文件 §3.6（唯一权威定义）
  - scripts/validate-run.mjs（照抄它的结构：CAPABILITIES/SHAPES/VAGUE + 逐字段报错）
  - .claude/agents/oversight-planner.md 的输出 schema（已有，但缺 boundary）
  - docs/spec/dispatch-contract.md §2「四样东西」、§5「产出形态声明格式」
必须回答的问题：
  1. 哪些字段可以由 planner 自由写、哪些必须是机器可判的枚举？逐字段给出归类与理由。
  2. 「没有 fail_if 的标准等于没有」——用哪条检查兜住？举一个能通过 planner 但会被校验器拒的反例。
  3. report.json 由 supervisor 写、执行者只能写 report.md。这个分离在数据结构上如何体现
     才让「执行者伪造状态」不可能（而不是「不鼓励」）？
  4. 校验器的退出码语义是什么？（0/1/2 分别代表什么，能否直接接进 CI）
  5. 现有 validate-run.mjs 的哪几条检查可以直接复用、哪几条语义不同不能复用？逐条列出。
产出物路径：
  - scripts/validate-ticket.mjs（新，零依赖）
  - scripts/validate-ticket.test.mjs
  - docs/spec/org-contract.md（ticket/report/verdict 三份 schema 的规格，含字段语义与反例）
验收标准：
  AC1 validate-ticket 对 §3.6 的示例 ticket 返回 0；对「AC 缺 fail_if」的 ticket 返回 1 且报错含字段路径
  AC2 措辞黑名单生效：criterion 含「质量良好」→ exit 1，错误信息引原文
  AC3 负向测试：把 boundary 检查删掉后，对应测试必须变红（贴出红的那次输出）
  AC4 org-contract.md 的三份 schema 与 §3.6 逐字段一致（测试断言字段名集合相等，不是子集）
  AC5 node --test scripts/*.test.mjs 全绿；node scripts/check-structure.mjs exit 0
  AC6 零依赖（不新增 import 外部包）；覆盖声明齐全
依赖：无
预算估计：token 15%，90 分钟
```

---

### F2 外部适配器 + `claude -p` 复测

```
任务名：做出唯一一个可用的外部适配器，并把 claude -p 判成「可用/不可用/不知道」
产出形态：hybrid（适配器代码 = artifact；claude -p 复测 = exploration）
角色：executor（native）
输入：
  - 本文件 §0 表格第 4–8 行（本次实测记录）与 §3.5
  - docs/research/2026-11-04-external-harness-protocols.md §7（acpx 用法、Windows argv 限制、stdout 污染）
  - docs/research/2026-11-02-path-b-recount.md §四（claude -p 的 30+ 次矩阵）
  - tasks/runs/2026-11-02-path-b-recount/claude_p_decisive.sh（现成的复现脚本骨架）
必须回答的问题：
  1. claude -p 的三次失败（3m10s 空 exit=0 / 130s 超时 / 4m07s 只拿到 524）的根因是什么？
     用判别实验分开这四种可能：(a) 网关上游 524，(b) CLI 启动后卡在鉴权分支，
     (c) 模型别名 haiku 被网关映射到不可用模型，(d) exit=0 是 CLI 自己的 bug。
     每种可能给出一个能独立证伪它的命令。
  2. 「exit 0 + 空 stdout」在什么条件下出现？能否构造一个必然重现它的最小输入？（给出命令）
  3. acpx 的当前版本、opencode 的当前版本是多少？`--format json` 的裸 ACP 保证是否仍成立？
  4. dsh 往 stdout 写非协议日志（`[llm-deepseek-account] ...`）会让 acpx 报
     `Failed to parse JSON message`。适配器必须怎么做才能一行坏 JSON 不崩整个通道？
  5. 会话结束的三种信号（`stopReason` / 进程退出 / 静默）里，哪一个最可靠？给出实测。
产出物路径：
  - scripts/adapters/acpx.mjs（统一接口：`run(ticket, {cwd, timeoutMs}) -> {state, summary, cost, events}`）
  - scripts/adapters/index.mjs（adapter 注册表，key 是 `acpx:opencode` 这种字符串）
  - docs/research/2026-11-10-claude-p-recheck.md（复测报告，含全部原始输出）
  - docs/research/2026-11-10-acpx-adapter.md（实测报告）
验收标准：
  AC1 用适配器跑一条真实的最小任务（"在临时目录建 a.txt 写入 hello"），
     返回 state=DONE 且 changed_files 含该文件（给出完整调用与输出）
  AC2 用适配器跑一条注定失败的任务（"改一个不存在的文件"），
     返回 state ∈ {FAILED, BLOCKED}，**不得返回 DONE**
  AC3 构造一行坏 JSON 混进 ACP 流，适配器必须跳过并继续（负向测试：删掉容错则测试变红）
  AC4 claude-p-recheck.md 必须对四种可能**逐条给出判定**（成立/不成立/无法判定），
     不得只给一个总体结论。无法判定的写进「无法核实」并说明缺什么
  AC5 报告里每个数字都附可复跑命令；单次成功按 UNPROVEN 计，不得写成「已验证可用」
  AC6 零依赖；全量测试全绿；check-structure exit 0
依赖：F1（适配器的输出必须符合 report.json schema）
预算估计：token 25%，4 小时
```

---

### F3 supervisor：三事件、预算、超时、UNKNOWN

```
任务名：把「主 agent 不被淹没」做成代码，而不是靠父 agent 自觉
产出形态：artifact
角色：executor（native）
输入：
  - 本文件 §3.4 与 §3.6 的失败处理四档
  - docs/research/2026-11-04-orchestration-patterns.md §一（10 个系统的 progress 通道对照表）
  - docs/research/2026-11-04-dsh-superagent-analysis.md §2.3（ReportState 六值与 progress 被丢弃的实现）
  - scripts/watch.mjs 的 canNotify / 限额逻辑（复用「宁可少发」的取向，不要求复用代码）
必须回答的问题：
  1. 「只有三事件」在代码里怎么强制？如果适配器返回了第四种东西（例如 progress 文本），
     代码是丢弃、报错、还是归到三事件之一？给出选择与代价。
  2. 超时判定用 wall clock 还是事件间隔？两者在「适配器卡在启动」时表现如何不同？（给出实测）
  3. UNKNOWN 冒泡成 NEEDS_DECISION 之后，如果用户不回答，这个工单的终态是什么？
     会不会永远占着一个「未完成」？给出判据（复用 BLOCKED_MAX_AGE 这类过期语义）。
  4. report.json 由 supervisor 写、执行者只能写 report.md——
     如果执行者**在 report.md 里写了一段合法的 JSON 冒充 report.json**，supervisor 会不会被骗？
     给出防御与一条负向测试。
  5. 父 agent 的上下文预算：一个工单卡片多少 token？10 个工单多少？给出实测（不是估算）。
产出物路径：
  - scripts/org/supervisor.mjs（派发、等待、收拢、判四档、写 report.json）
  - scripts/org/supervisor.test.mjs（含注入假适配器，不依赖真有 opencode）
  - docs/research/2026-11-10-supervisor-contract.md（事件语义与预算实测）
验收标准：
  AC1 REPORT_STATES 导出且长度恰为 3；测试断言适配器返回 "progress" 时被归入三事件之一（不是第四种）
  AC2 注入一个「永远不退出」的假适配器 → 到 timeout_min 必须判 TIMEOUT 并杀进程（测试 <5 秒跑完，用短 timeout）
  AC3 注入一个「exit 0 + 空输出 + 无改动」的假适配器 → 必须判 UNKNOWN，**不得判 DONE**（负向测试：改判 DONE 则变红）
  AC4 执行者在 report.md 里写合法 report.json 内容时，supervisor 不得采用它（负向测试）
  AC5 10 个工单卡片的序列化总长度 ≤ 2KB，给出实测
  AC6 零依赖；全量测试全绿；check-structure exit 0
依赖：F1、F2
预算估计：token 20%，3 小时
```

---

### F4 验收闸 + 负向测试

```
任务名：让「验收不过」这件事在框架里真的能发生
产出形态：artifact
角色：executor（native）
输入：
  - .claude/agents/oversight-acceptor.md（全文，它的判定规则就是实现规范）
  - .claude/agents/oversight-repair.md（「只修被指出的问题」「不得改验收标准」）
  - docs/spec/evidence-discipline.md §8
  - 本文件 §4 的 [6][7] 两步
必须回答的问题：
  1. verdict.md 的「无效判定」检测：哪些词/句式必须被判为无效？
     给出至少 6 个（「基本满足」「整体不错」「大致完成」只是三个）与各自的理由。
  2. acceptor 只看 AC[] + diff + report.json 的指针。如果 diff 为空但 report 说 DONE，
     判定必须是什么？给出判据与一条测试。
  3. repair 最多 1 轮。第 2 轮仍不过时，failure.md 必须含什么才算合格？
     （提示：不能只是一句「还是不过」）
  4. 「完整重新验收」与「抽查」在实现上怎么区分？如果实现里没有区别，这条规范就是假的。
  5. 验收闸会不会把「AC 本身写得不可判定」也算成执行者的错？正确处理是什么？
产出物路径：
  - scripts/org/verify-gate.mjs（读 ticket + report + diff → 调 acceptor → 校验 verdict 有效性）
  - scripts/org/verify-gate.test.mjs
  - docs/spec/org-contract.md 补一节「verdict 有效性判定」
验收标准：
  AC1 verdict.md 含「基本满足」→ 判 verdict 无效并给出原文（6 个词表逐个测试）
  AC2 构造 diff 为空 + report=DONE 的输入 → 判定必须是「不通过」（负向测试：改判通过则变红）
  AC3 repair 轮数上限用测试钉死：第 2 次触发 repair 时抛错（不是静默继续）
  AC4 「完整重新验收」的实现必须是：把 verdict.md 整份作废、acceptor 重跑、不得复用上一轮的逐项结论
      —— 用测试断言「第二轮 acceptor 的输入里不含第一轮 verdict」（这是可机械检验的）
  AC5 全量测试全绿；check-structure exit 0；零依赖
依赖：F1
预算估计：token 20%，3 小时
```

---

### F5 最小链路端到端 + 台账

```
任务名：跑通 §4 那条链路一次，并且台账齐全
产出形态：hybrid（CLI 入口 = artifact；端到端实跑 = 证据）
角色：executor（native）
输入：
  - 本文件 §4（唯一权威流程）
  - F1/F2/F3/F4 的产出
  - docs/spec/output-format.md §1（七条硬规则，最终输出必须遵守）
必须回答的问题：
  1. 端到端一次的总耗时与总成本是多少？拆成「planner / 派发 / 执行 / 验收 / 修复」五段，逐段给实测。
  2. §2.1 那条「一周可跑通判据」逐项能否满足？不能的项，是设计错了还是实现没做完？
  3. 用户只输入一行命令，中途有没有任何一次需要他介入？（如果有，是哪一步，为什么躲不掉）
  4. run 目录下五个文件是否都有消费方？（没有消费方的文件就是垃圾，列出来）
  5. 如果 opencode 在这次运行时不可用（未登录 / 无余额 / 版本变了），链路的降级路径是什么？
     降级时终端输出什么？（不能是「一切正常」）
产出物路径：
  - scripts/org.mjs（CLI 入口：`run <goal>` / `status <run-id>` / `--dry-run`）
  - tasks/runs/<新 run-id>/（五个文件；该目录 gitignored，不入库）
  - docs/research/2026-11-10-org-e2e.md（端到端实测报告，含逐段耗时表与一次失败记录）
验收标准：
  AC1 `node scripts/org.mjs run "<真实小任务>"` 退出码 0，五个文件非空（给出 ls -l 输出）
  AC2 最终终端输出 ≤10 行，且首行是状态、末行是下一步（对照 output-format §1 的 1/7 条）
  AC3 至少记录**一次失败运行**的完整形态（哪个环节、报什么、怎么判的），不得只报成功路径
  AC4 降级路径实测：把 adapter 改成不存在的 key → 必须明确报错并以非 0 退出，不得「正常结束」
  AC5 逐段耗时表有 5 段，每段一个数字 + 一条复跑命令
  AC6 零依赖；全量测试全绿；check-structure exit 0
依赖：F1、F2、F3、F4（串行最后）
预算估计：token 20%，3 小时
```

---

### F6 攻击这份规划（强制不可合并）

```
任务名：找出本设计里「看起来像框架其实只是包装器」的部分
产出形态：artifact（批评报告，不改任何文件）
角色：redteam（tools 无 Edit；可 Write 报告）
输入：
  - 本文件（**只此一份**）全文
  - README.md 的「能力边界」与「已知局限」
  - docs/research/2026-11-04-competitive-landscape.md §五（差异点真伪判定表）
  - docs/research/2026-11-04-orchestration-patterns.md §三（14 条反模式 A1–A14）
  - docs/adr/0001-config-only.md
  【不得读】任何执行 Agent 的自我评价、F1–F5 的中间产出（会锚定）
必须回答的问题（逐条编号作答）：
  1. **这是不是只是 `child_process` 的一层包装？** §3.5 说 OpenHands 已经把「ACP 驱动多个
     CLI + 流式 + resume + 成本」做成产品。我声称的差异是「工单 + 三事件 + 验收闸」。
     请具体指出：这三样里有哪一样是 OpenHands / codeg / paseo **真的没有**的？
     如果三样都没有，直接说「这是包装器」。
  2. **§1.2 的 P1/P2/P3 划分是不是为了给自己找活干？** P2（断言 vs 证据）已经有
     `verify-claims.mjs`；P3 是不是把 P2 重新包装了一遍？给出判据。
  3. **15× token 的账我一次都没算。** 若 v0 跑一次 4 分钟 / $0.04，这只够做「补两行文档」。
     什么样的任务值得用这套框架而不是直接开一个会话？给出至少两种，或说「没有」。
  4. **§2.2 的 X1（不做递归）是不是把用户明确要的东西砍掉了？**
     用户原话第一句就是「自己的手下也可以有手下」。我的理由是物理不可达 + 成本。
     这个理由是不是在用一个实现细节否掉一个产品需求？
  5. **§3.3 修规范 vs 加能力。** 如果用户真正要的是递归，那么「把规范改成 1 层」
     就是在**把需求改小以适应实现**。这条批评如果成立，正确的做法是什么？
  6. **本文件自己有没有踩 A1（把限制写在 prompt 里当边界）？** 逐条检查 §2.2 的 X5
     与 §3.6 的 boundary 字段——`boundary` 是写在 ticket 里的字符串，执行者可以无视它。
     那它与「写在 prompt 里的限制」有什么区别？
  7. 有没有一条我完全没想到的路线？（至少一条，并说明它为什么不违反 ADR-0001 与 12 条否决项）
产出物路径：
  docs/research/2026-11-10-framework-plan-redteam.md
验收标准：
  AC1 每条批评指向本文件的具体小节号（§x.y），不写「风险较大」这类空话
  AC2 问题 1 必须给出**明确判断**（是包装器 / 不是包装器），并列出对比对象的具体功能清单作依据
  AC3 至少 3 条批评要给**可执行的替代方案**，不只否定
  AC4 必须有「经核实不成立的指控」一节（至少 2 条：我怀疑但你验完后发现不成立的设计选择）
  AC5 自评：这份批评里哪一条最可能是错的，为什么
  AC6 不修改本文件；发现的问题写在报告里
依赖：无（与 F1–F5 并行，且**必须在 F7 汇总前完成**）
预算估计：token 15%，60 分钟
```

---

### F7 修掉深度声明的自相矛盾（文档修正）

```
任务名：把 dispatch-contract §7 的「3 层」改成本仓实际能做到的「1 层」，并留下可复算的证据
产出形态：artifact（规格修正，不改任何代码）
角色：executor（native）
输入：
  - docs/spec/dispatch-contract.md §7（全文）
  - .claude/agents/*.md 全部 12 份 frontmatter 的 tools 行
  - 本文件 §3.3（三条证据）
  - claude -p 的 init.tools 实测（`Task` 是派生子 agent 的工具名）
必须回答的问题：
  1. 12 份角色的 tools 并集里有没有 `Task`？（给出 grep 命令与输出）
  2. Claude Code 的 `tools` 字段是「精确白名单」还是「追加」？依据是哪份文档的哪句原文？
     如果找不到原文，说明只有间接证据（`init.tools` 与 `--agent` 实测），不得写成确定结论。
  3. 除了 §7，还有哪些地方声称了递归能力？（`grep -rn "递归\|派生\|深度" docs/ .claude/`）
     逐条列出并判定：也改 / 不改 / 改为「v2 候选」。
  4. 用户原话「自己的手下也可以有手下」与「v0 深度 1」的冲突，应该在文档里怎么表述
     才既不加戏也不隐瞒？（给出一段 ≤5 行的替换文本）
  5. 这条修正要不要进 CHANGELOG？（对照 `checkChangelog` 的规则）
产出物路径：
  - docs/spec/dispatch-contract.md §7 的替换文本
  - docs/spec/org-contract.md 新增一节「v0 的层级：1 层，且为什么」
  - （若触发）docs/CHANGELOG.md 的 Unreleased 条目
验收标准：
  AC1 替换后的 §7 不含「3 层」「上限 3」等字样（grep 断言）
  AC2 替换文本里的每一条事实都有可复跑命令或 file:line
  AC3 `grep -rn "深度上限 3" docs/ .claude/` 的输出为空（或剩余命中都在「v2 候选」语境里）
  AC4 第 4 问的替换文本 ≤5 行，且必须同时包含「用户要递归」与「v0 不做递归」两个事实
  AC5 node --test 全绿；check-structure exit 0
依赖：无（可立即并行）
预算估计：token 10%，45 分钟
```

---

### 5.8 依赖图与并行度

```
                        ┌──────────────────┐
                        │ F7 修深度声明     │  独立，可立即开
                        └──────────────────┘

        ┌───────────────┐
        │ F1 schema/校验 │
        └───┬───────┬───┘
            │       │
            │   ┌───▼────────────┐
            │   │ F4 验收闸       │
            │   └───┬────────────┘
            │       │
        ┌───▼───────▼────────┐
        │ F2 适配器 + 复测    │
        └───────┬────────────┘
                │
        ┌───────▼────────┐
        │ F3 supervisor   │
        └───────┬────────┘
                │
        ┌───────▼────────┐
        │ F5 端到端       │  串行，最后
        └────────────────┘

   F6 红队（并行，必须在裁决前完成）
```

**必须串行**：`F1 → (F2 ‖ F4) → F3 → F5`（F5 必须最后）。
**可立即并行**：`F6`、`F7`；`F4` 只依赖 F1，可与 F2 并行。
**并行度**：第一批可同时开 `F1`、`F6`、`F7`（3 个）；F1 完成后开 `F2`、`F4`（2 个）。

---

## 六、一周时间表（按「能不能跑通」而不是「做完了没有」排）

| 日 | 做什么 | 判据（不是「完成了」，是「能观测到什么」） |
|---|---|---|
| D1 | F1 + F7 + F6 启动 | `validate-ticket` 能拒掉一个坏 ticket；§7 不再声称 3 层；红队报告有「是/不是包装器」的明确判断 |
| D2–D3 | F2（含 `claude -p` 复测） | 适配器能跑通「建 a.txt」并能判出「改不存在的文件」是失败；`claude -p` 有四种可能的逐条判定 |
| D3–D4 | F4 | 「diff 为空 + report=DONE」被判不通过（有测试） |
| D4–D5 | F3 | 假适配器卡死 → TIMEOUT；假适配器 exit 0 空输出 → UNKNOWN（两条都有测试） |
| D5–D6 | F5 | §2.1 的五条判据逐项打勾，含一次失败运行记录 |
| D7 | 红队结论裁决 + 是否进 v1 | 若红队判「这是包装器」且我反驳不了 → **停，不进 v1** |

**这一周不包含**：多工单、多 harness、递归、TUI 集成、任何 README 定位改动。

---

## 七、我认为最大的风险（自己先写，不等红队）

### 风险 1（最高）：这条链路可能**只是 `child_process` 的一层包装**

诚实地说：v0 的可见产物是「派一个 opencode 进程，收一份报告，判一下」。
这确实可以描述成「一个带验收的 `spawn()`」。而 OpenHands 已经做了「ACP + 流式 + 成本 + resume」。

**唯一可能站得住的差异**：OpenHands 的验收是**人看的**（Changes 面板、工具卡），不是**机器判的**。
我们的差异在「AC 是数据、判定是产物、不通过有强制后果」。**但这一点我没有任何外部证据支持它是用户要的。**

**如果红队（F6）能证明这一点也不成立，v0 应该停在这里，不进 v1。** 这是本文件预设的止损点。

### 风险 2：我把「递归」这个用户明确要的东西，用一个实现细节否掉了

用户原话第一句：「它可以带自己的手下，自己的手下也可以有手下」。
我在 §3.3 把它改成「v0 深度 1」，理由是「12 个角色没有 `Task` 工具」。

**这个理由可能是在用实现细节否掉产品需求。** 正确的表述应该是：
「递归是产品需求。**当前配置不支持，并且当前成本模型不支持（15×）。**
v0 不做的原因不是「做不到」，是「没算清账之前做会烧光预算且无法验证」。」
——我倾向于第二个表述，但 §3.3 的替换文本写得太像第一个。F7 的第 4 问就是为这个准备的。

### 风险 3：`claude -p` 实测失败可能是**我这台机器当时的网络/网关状态**，不是普遍事实

三次失败里有一次明确是 `524 server_error`，那是上游网关的问题，不是 CLI 的问题。
如果换个时段它就能跑通，那我基于「它不可用」所做的适配器选择（选 opencode）就是基于一个瞬时故障。

**缓解**：F2 的第 1 问要求用判别实验把四种可能分开，且明确允许结论是「无法判定」。
**但在它给出结论之前，这个风险是敞着的。**

### 风险 4：整件事与 `verify-claims` 的定位可能重叠到自我欺骗

`verify-claims.mjs` 做的是「从 transcript 判断完成声明有没有证据」。
v0 的验收闸做的是「对照 AC 判断交付物过不过」。
**两者都叫「不信 AI 说的」，很容易被写成一件事。** 如果它们其实是同一件事，那 v0 就不是新框架，是把已有脚本包了一层。

**判据**：`verify-claims` 的输入是**别人的 transcript**（用户已有会话），v0 的输入是**我们自己派的工单的产物**。
前者我们只有读权，后者我们有全部所有权。**这个区别如果撑不起两条产品线，就该合并。**

### 风险 5：一周时间表假设了「F1–F5 的产出一次就够用」

本仓的历史显示，`scripts/` 下的东西普遍需要 2–3 轮修复才稳（`watch.mjs` 有 DF-001 到 DF-024，
`oversight-tui.mjs` 有 DF-012/DF-014）。**如果 F1–F5 也走同样的曲线，一周只够跑通「丑但能跑」的版本。**
这不是失败——雏形的定义就是「能跑通」，但不要在一周后把它当成「框架已完成」。

---

## 八、一页纸（给主线程）

```
问题：不是「让多个 agent 协作」（已饱和 + 宿主已做 + 15× 成本），
      是「把目标切成带预声明 AC 的工单，派给别人的进程，判成过/不过/不知道」。

不用现成框架的三条结构性理由：
  N1 协议层不对（它们管不了别人的进程；对得上的是 ACP）
  N2 编排单位不对（我们编工单+AC，它们编消息/节点；MAST 41.77% 是规格类失败）
  N3 通信面不对（它们默认全广播，我们要「只有三事件存在」）
  每条都给了「什么情况下这条不成立」——可被证伪。

v0 = 五件：工单 schema + 一个适配器 + 三事件 supervisor + 验收闸 + run 台账
v0 不做十件：递归 / 多适配器并行 / progress 通道 / 自写 ACP client /
             沙箱承诺 / 往用户会话注入 / GUI / DSL / 「修好了」当标准 / 事后投票

最关键的两个实测发现：
  ① 12 份角色全部无 Task 工具 → §7 的「3 层」不可执行，v0 改为 1 层并说明理由
  ② claude -p 按简报配方复现 3 次全败，且失败是「exit 0 + 空输出」（静默失败）
     → v0 适配器改用 acpx+opencode（唯一实测跑通的组合），claude -p 降级为 F2 的复测子任务

最小链路（一条命令到一段话）：
  org.mjs run "补两行实测数字" → planner 出 ticket → 校验 → acpx+opencode 干 →
  抽三件事 → supervisor 判四档 → acceptor 逐条判 AC → 不过则 repair 一轮 →
  输出 ≤10 行：做了什么 / 证据在哪 / 花了多少 / 下一步

七天后不该做的事：进 v1、接第二家 harness、动 TUI、改 README 定位。
七天后最该回答的问题：红队说「这只是 spawn() 的包装」，我能不能反驳。
```

---

## 附：本文件未覆盖的部分（诚实申报）

1. **没有做任何多 agent 实测**。所有关于并发、成本、耗时的论断都引自研究文档，不是自测。
2. **没有验证 `acpx` 的当前可用性**。研究文档记的是 0.22.0，本次未复核版本、未跑。
3. **没有确认 `claude -p` 失败的根因**。只报观测（3 次失败的具体形态），根因判别写进 F2。
4. **没有向用户确认**「间接对接用户」的确切语义。
5. **没有算成本**。15× token 的账在 v0 只有一个工单的情况下没有意义，但 v1 之前必须算。
6. **没有读 `scripts/watch.mjs` 与 `oversight-tui.mjs` 全文**，与本设计无直接关系。
7. **`docs/spec/evolution-discipline.md` 不存在**（简报列为必读）。已按最接近的
   `docs/spec/evidence-discipline.md` 与 `docs/spec/dispatch-contract.md` 代替。
