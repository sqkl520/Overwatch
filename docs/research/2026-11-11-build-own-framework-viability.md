# 自研「super agent 框架」的代价与替代路径

> 日期：2026-11-11
> 角色：研究 Agent SA1 · 产出形态：**exploration**（深度调研，不是实施计划）
> 命题（用户原话）：**「我们又要自己自研一套类似 super agent 的 agent 框架」**
> **未修改 Overwatch 任何代码，未碰 git。**

---

## 覆盖声明

**实际拉取并逐项统计的**（`.tmp-analysis/dsh-ref`，`git clone --depth 1`）：

| 对象 | 做了什么 |
|---|---|
| `deepseek-ai/dsh-superagent-prototype` | 按目录统计文件数与行数、`git log`、`package.json`、`README.md`、`docs/000–008`（1,973 行）与 `prompts/`（291 行）全文要点、`src/core` 全部 21 个文件大小、`grep` 确认有无验收闸/证据核对 |
| GitHub API | 该仓库 `commits`（真实提交数，非 shallow 计数）、`stargazers`/`forks`/`pushed_at`；AutoGen / Swarm / MAF / LangGraph / OpenHands / Mastra / spec-kit / overstory / 1code / agent-teams-lite / Claude-Code-Workflow / gentle-ai / Warren / paseo / oh-my-claudecode 的元数据与 README 原文 |
| npm registry | `@mastra/acp` 64,561/月、`@openclaw/acpx` 35,554/月、`@agentclientprotocol/sdk` **30,107,922/月**、`@anthropic-ai/claude-agent-sdk` 61,334,229/月、acpx 包体 2.9 MB / 40 文件 |
| 一手文档 | `anthropics/claude-agent-sdk-python` 的 `types.py`（`AgentDefinition` / `agents=` / `max_turns` / `max_budget_usd` / `total_cost_usd` / `fork_session`）与 CHANGELOG、Claude Code agent-teams 文档（含 Limitations 全文）、Mastra subagents 文档 |
| Hacker News Algolia | 8 组关键词；拿到 3 条可引用的一手评论（含 1 条「弃用 LangGraph 后自己写」的原话） |
| arXiv | `2503.13657`（MAST）摘要 + 全文中的干预效果原文、`2505.18286`（Single-agent or Multi-agent Systems?）摘要原文 |

**没做的 / 不可得的**：

1. **dsh 花了多久做，算不出来。** 该仓库以**单个 squash 提交**发布（`gh api .../commits` 返回 `length: 1`，日期 2026-10-31），因此 `git log` 里没有任何工期信息。任务书要求「它花了多久做（看 git log）」——**这条要求在客观上不可满足**，下文 §5.2 给出我能给的最强替代估算与它的误差来源。
2. **没有安装、没有运行任何框架。** Mastra、acpx、Agent SDK 一行都没跑。所有「能/不能」都来自源码与文档语义。
3. **没有复算 15× token。** 该数字引自 Anthropic 自述，本机无多 agent 实测。
4. **没有找到「自己写编排→放弃→退回现成框架」的第一手复盘。** 但我找到了**四例「自己写的编排项目被归档/弃用」**（§3.3），性质不同，见该节说明。

---

## 零、结论先行

| # | 问题 | 结论 |
|---|---|---|
| **1** | 「super agent 框架」指什么最接近用户想要的 | **不是 (d) 上下文管理，也不是 (e) 运行时，而是 (a)+(b)+(c)：能派活给外部 CLI 的编排器 + 角色定义体系 + 验收层。** 从 dsh 反推：它 15,205 行里只有 **4,043 行（26.6%）是框架**，其余 **11,162 行（73.4%）是产品**（面板 4,037 行 = 26.6%、集成 2,059 = 13.5%、迁移/设置/HTTP/视图等接线约 5,066 行）。**用户想要的「公司」如果照 dsh 的样子造，七成工作量会花在他没要求的东西上。** |
| **2** | 最小可行集 | **5 件，缺一不成链**：工单 schema + 校验器 / 三事件汇报 + 卡片指针 / 独立上下文的验收闸 / 一个外部适配器 / run 台账（每文件唯一写入者）。**规模是 3 份 markdown + 3–4 个脚本，不是「一个框架」。** 可后加的 6 件、看着必需其实能买的 6 件见 §2。 |
| **3** | 真实代价 | 代码量级：**框架核心 4,043 行（dsh 实测，非估算）**；1 人维护的合理上限是**「一个模块 2,600 行 + 2,700 行测试」**——这是本仓 `watch.mjs` 的现状，它已产生 **24 条编号缺陷**。**四个真实放弃案例**：overstory（1,313★，明说「不再维护」）、1code（5,574★，6 周后归档）、agent-teams-lite（1,245★，改写成 CLI 产品）、Claude-Code-Workflow（2,117★，重写为 Maestro Flow）。**加上 AutoGen（61,777★，微软自己归档）、Swarm（22,121★，被 Agents SDK 取代）。** |
| **4** | 半自研路径 | 四条，按推荐度排：**① ACP 驱动买 acpx + 自写契约层（推荐）**；② Mastra 编排 + 自写验收闸（会推翻零依赖）；③ fork acpx（可控但永远追不上）；④ **写成 markdown 插件/SDK，不做独立框架**——这条我原本没想到，但 `github/spec-kit`（**149,162★**、234 个 md、纯 markdown 命令）证明「组织层即配置」是有人要且极便宜的。 |
| **5** | dsh 真实规模 | **15,205 行源码 / 111 文件 / 12,981 行测试（≈1:1）/ 9 篇规格 1,973 行 + prompt 291 行 / 运行时依赖只有 2 个 / 宿主依赖 23 个全 alpha / 1 个提交 / 0 release / issues 全关。它自己承认「有些文章里的设计只是方向，本原型没实现」，也承认「包装器不是安全边界」「只靠提示词的限制不是限制」「一切只增不删」。** |
| **6** | 什么情况下自研是错的 | 8 条可证伪条件，见 §6。**其中最硬的一条已经成立：12 份角色的 `tools` 全部不含 `Agent`，所以「公司」的实际深度是 1。深度为 1 的「框架」不是框架，是一个带检查表的 `spawn()`。** |

**一句话推荐**：**买驱动，造契约。别造运行时。**
「super agent 框架」应读作**「一份工单契约 + 一个验收闸 + 一个外部适配器」**，而不是「一个新的 agent 运行时」。前者是本仓唯一独占、已有一半资产、且被四个放弃案例反证出「产品部分才是无底洞」的东西；后者是 dsh 全部能力的来源，也正是 ADR-0001 已经裁决我们永远拿不到的那部分。

**必须诚实说的反面**：如果 §6 的 **C4**（验收闸拦不住东西）证伪，**整个自研计划应该砍掉**，退回去用 Mastra + 人工 review。我在调研中**没有找到任何证据能保证验收闸有效**——只有 Cognition 的二手中介证据与本仓 `verify-claims.mjs` 的 84.6% 精度小样本。

---

## 一、自研到底要造什么？五种理解与各自代价

### 1.1 五种理解

| 代号 | 理解 | 典型产物 | 谁已经做了 | 我们要花多少 |
|---|---|---|---|---|
| **(a)** | 能派活给外部 CLI 的**编排器** | `org.mjs run <goal>`；spawn 子进程、收流、判终态 | OpenHands（93,131★，ACP 全流程）、paseo（23,726★）、codeg、overstory（已弃） | **小**：acpx 已做完最脏的一半 |
| **(b)** | 一套**角色/组织**定义体系 | `.claude/agents/*.md` + tools 白名单 + 编队声明 | CrewAI（角色扮演）、OpenClaw team preset、spec-kit（**149k★**，纯 markdown） | **很小**：本仓已有 12 份，且被结构门钉住 |
| **(c)** | 一个**验收/质量**层 | AC schema + `gate.mjs` + 干净上下文 acceptor + verdict | **没有人做成一等公民**（Mastra evals 是离线打分，不是判别人交回的工单） | **中**：这是唯一独占项 |
| **(d)** | 一个**上下文管理**系统 | 分层摘要、卡片+指针、compaction、预算 | 宿主 compaction、Mastra memory、dsh 的四层（卡片/列表页/分页/评估窗口） | **不该自研**：宿主和 harness 已经在做，我们做只会更差 |
| **(e)** | 一个**运行时** | 进程池、沙箱、状态机、持久化副作用队列、并发额度 | dsh（主力）、Temporal/Kitaru 类持久执行 | **巨大，且买不到**：这是 Overwatch 唯一结构性缺失（ADR-0001） |

### 1.2 从 dsh 的实际形态反推

dsh 是这次唯一一个「像 super agent」的可读样本。把它按目录拆开（实测）：

| 目录 | 文件 | 行数 | 占比 | 这是什么 |
|---|---|---|---|---|
| `src/client/` | 26 | 4,037 | **26.6%** | 面板（`.tsx` 视图、设置表单、locale 770 行） |
| `src/app/` | 38 | 5,292 | **34.8%** | 接线：`migration.ts` 616、`store.ts` 291、`settings.ts` 267、`http.ts` 247、`prompts.ts` 247、`views/` 621… |
| `src/core/` | 15 | 2,088 | 13.7% | 领域模型（tickets 423 / model 353 / evals 340 / engine 270） |
| `src/sources/` | 16 | 2,059 | 13.5% | GitHub 459 / Feishu 267 等集成 |
| `src/executor/` | 2 | 838 | 5.5% | `dsh.ts` 673（派工单、起 Session）+ `background.ts` 165 |
| `src/infra/` | 5 | 347 | 2.3% | 环境、命令、健康 |
| 顶层 8 个文件 | 8 | 544 | 3.6% | policy 242 等 |
| **合计（`.ts`/`.tsx`）** | **110** | **15,205** | **100%** | 另有 `src/client/client.css` 1 个文件 → `find src -type f` 总计 **111** |

**文件构成**：92 个 `.ts` + 18 个 `.tsx` + 1 个 `.css` = 111。**行数 15,205 只统计 `.ts`/`.tsx`（不含 css）。**

**把它按「框架 vs 产品」重新切一次**：

```
框架（调度 + 执行 + 领域 + 副作用）      =  4,043 行   26.6%
  其中真正不可省的：
    core/            2,088
    executor/dsh.ts    673
    app/sessions.ts    352   （特权 API 全在这一份里）
    app/tools/*        406
    app/effects.ts     161
    app/notices.ts     129
    app/cards.ts        96
    app/delivery.ts     86
    app/outbox.ts       52
    ─────────────────────────
    小计               4,043 行
产品（面板 + 集成 + 迁移/设置/HTTP/视图接线）= 11,162 行   73.4%
  拆解：client/ 4,037（面板）
      + sources/ 2,059（集成）
      + app/ 剩余 4,010（migration 616 / store 291 / settings 267 / http 247 / prompts 247 / views 621 …）
      + 顶层 544（policy 242 / deployment 131 / kv 58 …）
      + executor/background.ts 165
      + infra/ 347
      = 11,162
```

**这就是第一条硬结论**：**dsh 之所以叫「super agent 原型」，不是因为那 4 千行框架，是因为外面 1 万行产品把它包成了一个可用的东西。** 如果我们照着「类似 super agent 的框架」去造，**约七成工作量会花在面板、设置、迁移、集成上，而那些都不是用户要求的「公司」。**

**反推用户想要哪一种**：用户原话是「围绕用户的公司 / 职责分明 / 不臃肿 / 可以外包」。这句话里**没有**「面板」、**没有**「沙箱」、**没有**「上下文压缩」。它只有三件事：岗位（b）、派活（a）、判断过不过（c）。

→ **最接近的是 (a)+(b)+(c)，并且 (c) 是唯一没人卖的。**

而 (d) 和 (e) 恰好是 dsh 唯一「买得到、我们拿不到」的两块：

| | dsh 怎么得到 | Overwatch 为什么拿不到 |
|---|---|---|
| (d) 上下文 | 两个 preset 装 `dsh-compaction-basic` + `tool-result-pruner`，配 160 字卡片 + `read` 指针 + 59,000/40,500 字符硬预算测试 | 卡片和指针**我们能自己写**（纯逻辑）；compaction 由宿主做，我们做不会更好 |
| (e) 运行时 | `sessionController.create` / `tools.restrict` / `tools.guard` / `agent.steer` / `agent.cancel` / `permissionPresets.set`——**全部来自 `@deepseek-ai/dsh-*`（23 个 alpha 包）** | ADR-0001 已裁决：对**用户已有的**会话，这 10 个 API 一个等价物都没有 |

**所以「自研运行时」这条路不是「难」，是「错」**——它会让我们和平台安全模型对打（README 已记录：跨会话消息「永远不算你的同意」）。

### 1.3 一个被忽略的第六种理解

调研中冒出来的一种：

**(f) 把组织层写成宿主可加载的配置（plugin / skill / markdown 命令集），而不是一个独立程序。**

证据是最强的：`github/spec-kit` **149,162★、13,396 fork**，核心交付物是 `templates/commands/` 下 **10 个纯 markdown 命令** + 4 个模板（共 16 个文件），零运行时。它的 CLI（`src/specify_cli` 3.2 MB Python ≈ 7 万行）是**分发器**，不是框架。

**为什么这条重要**：本仓现在**已经**是这个形态了（12 份 md + 5 份 spec + 4 个模板 + 零 npm 依赖）。用户说「自研一套框架」，但他的资产已经在 (f) 里。**做 (f) 的增量 ≈ 写 3 份新 markdown，而不是写一个新框架。** 代价是：没有可执行强制力，全靠 `check-structure.mjs` 这类门兜底——而审计已经证明那道门有 4 个可绕过的洞（§3.4）。

---

## 二、自研的最小可行集

### 2.1 必需件（不可省，缺一条链就断）

| # | 必需件 | 为什么不可省 | 本仓现状 |
|---|---|---|---|
| **N1** | **工单 schema + 机械校验器**：`goal`（逐字）/ `shape` / `AC[]`（每条含 `evidence` + `fail_if`）/ `boundary[]` / `budget` / `adapter` / `capability_gap` | 预声明 AC 是本仓最硬的一条；MAST 最大一类失败是规格类（FC1 41.77%，其中「步骤重复」单项 17.14%）。没有 schema 的派发等于自由文本 | 半有：`validate-run.mjs` 校验 `task-graph.json`，但**没有** `boundary`、没有 `fail_if` 必填 |
| **N2** | **三事件汇报 + 卡片 + 指针**：`DONE / BLOCKED / NEEDS_DECISION`，**无 progress**；父只读 6 字段，全文靠 `read` 指针 | 10 个系统的通例是「只在完成/阻塞/需要决策时唤醒上级」。dsh 有 progress 然后 `return undefined` 丢掉——那是它付过的学费。**枚举是不需要维护的白名单，过滤是需要维护的判断** | 无 |
| **N3** | **验收闸**：干净上下文的 acceptor，只看 `AC[]` + 机器跑出的证据 + diff，一票否决，`unknown` 不算 `fail` | **这是唯一独占项**。Cognition 二手中介：干净上下文 review agent 平均每 PR 抓 2 个 bug，58% 严重。**Mastra 的 evals 不是这个**（那是离线对数据集打分） | 半有：`verify-claims.mjs`（1,692 行，84.6% 精度）+ `oversight-acceptor` 定义，但后者**无 `Bash`，跑不了任何一条「判定前必须逐条跑」的标准** |
| **N4** | **一个外部适配器**（且只做一个） | 这是「带别人的手下」的最小可实现形态。多适配器在没有 ledger 时会互相踩（Cognition 的 Flappy Bird 失效） | 无代码。实测结论：`acpx`+`opencode` 唯一跑通；`claude-agent-acp` 在 Windows 上因 zod/v4 ESM 跑不起来；`claude -p` 三次全败且**exit 0 + 空 stdout** |
| **N5** | **run 台账 + 每文件唯一写入者** | dsh 的教训是「一切只增不删」；对策不是删，是**一开始就只存 5 类**且每类有消费方。单一写入者让「执行者伪造 report.json」在结构上不可能 | 无（`tasks/runs/` 只有 1 个 run、2 个文件） |

**这 5 件的实测规模参照**：dsh 的对应实现加起来 ≈ 4,000 行（N1≈423+340、N2≈96+129+161、N3≈0（它没有）、N4≈673、N5≈291+86）。**减去我们已付的成本（`verify-claims` 1,692 行、12 份角色、5 份 spec、4 个模板），增量约在 1,500–2,500 行 + 3 份 markdown。**

### 2.2 可选件（能后加，且后加更便宜）

| 可选件 | 什么时候才加 |
|---|---|
| 多工单 fan-out（≤3 并发） | 单 run 真的需要 ≥3 张验收互不依赖的工单 |
| 适配器能力矩阵 + 30 秒 canary 探针 | 接第二个 harness 时（第一个只有「能不能跑」一个问题） |
| `nonce` 回显 + `SILENT` 档 | 已经有 `claude -p` 这个静默失败的实例，v0 就该有 |
| `answers_ref.sha256` pin（需求漂移检测） | 只有做「问问题协议」时才需要 |
| 预算硬闸（读裸 ACP `usage_update`） | CLAUDE.md 硬约束 8 要求，但**v0 只有一个工单时可以事后看** |
| TUI / 面板 | **最后**。dsh 的 26.6% 是面板，别提前付这笔钱 |

### 2.3 看着必需、其实可以买的

| 看起来要自己写 | 实际买什么 | 证据 |
|---|---|---|
| ACP client / JSON-RPC / stdio 生命周期 | **`@agentclientprotocol/sdk`：月下载 30,107,922** | 自建最小 client 113 行能跑一轮，但生产级（队列/保活/权限/错误恢复/30 个 profile）→ acpx 用了 **2.9 MB / 40 文件 / 156 个版本** |
| 驱动各 CLI 的启动命令与参数 | **`@openclaw/acpx`**（35,554/月）+ 内置 profile（含 `claude`、`deepseek-harness`） | 本机已实测 acpx 0.22.0 → opencode 端到端跑通，逐 token 拿 `usage_update` |
| 进程内子 agent 定义 + 工具白名单 + 预算 | **`@anthropic-ai/claude-agent-sdk`：月下载 61,334,229** | `types.py` 里 `AgentDefinition`（description/prompt/tools/disallowedTools/model/skills/memory）、`agents=`（程序化定义子 agent）、`max_turns`、`max_budget_usd`、`total_cost_usd`、`num_turns`、`fork_session`、`hooks`、`can_use_tool` **全都有** |
| 并行/编排原语 | **Mastra**（29,449★，`@mastra/acp` 64,561/月，6 个源文件 ≈950 行） | subagent 的 `maxSteps`、`onDelegationStart`（`modifiedMaxSteps` / `proceed:false` / `iteration`）、`onDelegationComplete`（`bail()` / `resultText`） |
| 观测 / trace / token 成本归因 | **Mastra Observability** 或 Agent SDK 的 `total_cost_usd` | 我们自己只能「读 transcript 重建」，粒度更粗 |
| 持久执行 / 崩溃恢复 | **Temporal / Kitaru 类**（Kitaru 的 HN 帖原话：「pipelines 假设你知道图，agent 不知道」） | dsh 的 `Effects` 表 + `ON CONFLICT DO UPDATE` 是同一个问题的 161 行简化版 |

**一句话**：**驱动层 2026 年已经是白菜价（30M 月下载的官方 SDK、6 万月下载的框架包、635 MB 的成熟 CLI 生态），契约层和验收层全世界只有一个仓库在做，就是本仓。**

---

## 三、自研的真实代价

### 3.1 代码量级（对照 dsh 实测，不是估算）

| 层 | dsh 实测 | 我们要写多少 |
|---|---|---|
| 领域模型 + 状态机 | 2,088 行 | ~400–600（本仓 `state-model.md` + `validate-run.mjs` 已有一半） |
| 执行/派发 | 838 行（`dsh.ts` 673 里大部分是特权 API 调用） | ~500–800（换成 acpx 调用 + 三事件解析 + 六档失败） |
| 副作用队列 / 幂等 / 恢复 | 161 + 86 + 52 + 291(store) ≈ 590 行 | ~300（v0 只有 1 工单时可以先不上队列） |
| 验收闸 | **0 行（它没有）** | ~400（acceptor 编排 + verdict 校验 + gate.mjs 调用） |
| 卡片 / 有界上下文 | 96 + 129 ≈ 225 行 | ~150 |
| **小计（框架）** | **≈ 4,043 行** | **≈ 1,750–2,250 行 + 3 份 markdown** |
| 面板 / 设置 / 迁移 / 集成（产品） | 11,162 行 | **v0 写 0 行**（这是省下来的那 73.4%） |
| 测试 | 12,981 行（≈1:1） | 按本仓比例（9,531 / 15,389 = 62%）→ **≈ 1,100–1,400 行** |

**结论**：**「自研框架」的真实代码量是 2,000–3,000 行（含测试），不是 15,000 行。** 那 15,000 行的差额全是产品，而 v0 不需要产品。

这个数字与既有研究（`2026-11-10-framework-build-vs-buy.md` §5.3 的「3–6 人周」）同量级，但**现在有了结构证据而不是推算**：dsh 的框架部分被隔离出来了。

### 3.2 维护负担：1 人维护什么规模合理

**本仓自己就是最强的样本**：

| 事实 | 数字 |
|---|---|
| 脚本数 / 生产行数 | 38 个 / **15,389 行** |
| 测试 | 16 个 `*.test.mjs` / **9,531 行** |
| 最大单文件 | `watch.mjs` **2,614 行**（+ 2,706 行测试） |
| 第二大 | `oversight-tui.mjs` 2,078 行；`verify-claims.mjs` 1,692 行 |
| 编号缺陷 | **24 条**（DF-001…DF-024），仍有 **4 条 open** |
| 修复曲线 | `watch.mjs` 占了 DF-001…DF-024 的大部分——**同一个文件反复修 20+ 轮** |

**推论（可核对的经验值）**：

> **1 人维护的合理单模块规模 ≈ 2,600 行生产代码 / 2,700 行测试，且需要 20+ 轮修复才稳。**

这不是「能写多少」，是「写完要付多少」。本仓历史明确记录：`scripts/` 下的东西普遍需要 **2–3 轮修复**才稳（`watch.mjs` 有 DF-001…DF-024，`oversight-tui.mjs` 有 DF-012/DF-014）。

**所以**：v0 的 2,000–3,000 行 = **1 个 `watch.mjs` 的体量**。这是 1 人能扛的，但**意味着「框架」和「现有 38 个脚本」是同一个维护池里的**——不是加一个新东西，是让现有池子再大 15%。

**HN 上两位实践者给出的上限恰好一致**：

> *"Haven't really spent time working with more than 2-3 agents at a time. I quickly become the bottleneck when I review the diffs/plans … The sweet-spot is 2-3 agents co-ordinating at a time and me overseeing everything."*

> *"Usually I keep it to about 4 projects at a time, just to keep the context switching down."*

→ **1 人维护的上限不是 agent 数量，是「需要你拍板的次数」。** 这正好是验收闸存在的理由——它把「拍板」从人转移到一份预声明标准上。**但也意味着：验收闸如果经常误判，1 个人会被它拖死**（这是本方案最大的单点风险）。

### 3.3 有没有人自研后又放弃了？——有，四例，且性质与预期不同

**这是本次调研最大的增量。** 既有研究（2026-11-10）明确申报「没找到自己写编排然后失败的第一手复盘」。我找到了四例归档，但**它们的失败方式不是「退回现成框架」**，这本身是一个更重要的发现。

| 项目 | 星数 | 生命周期 | 结局 | 原话/证据 |
|---|---|---|---|---|
| **jayminwest/overstory** | 1,313★ | 2026-02-12 创建 → 归档 | **明说不再维护**，迁到 Warren（515★） | 「**No longer maintained.** … this repository is **archived (read-only)** — I am not reviewing issues or merging pull requests here anymore. … Active development has moved to Warren」 |
| **21st-dev/1code** | **5,574★** | 2026-01-14 创建 → 最后 release **2026-02-24** → 归档 | 6 周后停止开源，转私有 | 最后提交「Manual sync from private repo desktop source」；组织内 6 个仓库无一接替 |
| **Gentleman-Programming/agent-teams-lite** | 1,245★ | 2026-02-16 → 弃用 | 同作者重写为 `gentle-ai`（**8,724★**，CLI 产品） | 「deprecated in favor of gentle-ai … with a better installation experience, automatic updates, persistent memory … and support for 8 agents」——**纯 markdown 撑不住分发** |
| **catlog22/Claude-Code-Workflow** | 2,117★ | 2025-09-07 → 归档 | 重写为 Maestro Flow | 「This project has evolved into Maestro Flow … includes everything from CCW plus: Knowledge Graph, adaptive lifecycle engine, hook system, team collaboration」 |
| **（对照）microsoft/autogen** | **61,777★** | — | **微软自己归档**，指向 MAF | 「**Project archived and no longer maintained** … This project has been archived and is no longer actively maintained by Microsoft … New users should start with Microsoft Agent Framework」 |
| **（对照）openai/swarm** | 22,121★ | — | 被 Agents SDK 取代 | 「Swarm is now replaced by the OpenAI Agents SDK」 |

**这五例+两例对照给出的三个结论**：

1. **失败方式不是「退回框架」，是「重写一个更大的」。** 四个案例里三个有明确的继承者（Warren / gentle-ai / Maestro Flow），一个转私有。**没有一个说「我不该自己写，我该用 LangGraph」。**
   → 这对我们是**坏消息**：说明这个领域的正确做法还没被发现，「重写」是常态。
2. **失败点集中在「分发/安装/维护」，不在「编排逻辑」。** `agent-teams-lite` 的弃用理由表里 11 项对比，**没有一项是编排能力**，全是 installer / 自动更新 / 备份回滚 / 权限管理 / 配置同步。
   → **对 Overwatch 的直接含义**：本仓的「零 npm 依赖、clone 即用」是**资产不是限制**——它恰好绕过了这四例共同死因。
3. **连微软都放弃了自己的框架**（AutoGen 61,777★ → MAF）。**「自研框架」这件事连 61k 星的团队都守不住。** 这一条必须写进任何「我们自研」的决策依据里。

**唯一一条真正的一手「弃用现成框架后自己写」的话**（HN 47096466，Cord 讨论串）：

> *"We built something like this by hand without much difficulty for a product concept. We'd initially used LangGraph but **we ditched it and built our own out of revenge for LangGraph wasting our time with what could've simply been an ordinary python function.** Never again committing to any 'framework' … We have code on demand. Shallow libraries and frameworks are dead."*

同帖的反驳同样值得记：

> *"This is one of the worst takes I've ever heard. There's a reason industries have standards. If you replace established libraries with vibecoded alternatives you will have: less documentation, less tested code, no guarantees it's doing the right thing, a dice roll for whether it works this time on this project, and a bad time in general."*

**两边都对**。分界线是**你的问题是否真的只是一个「普通的函数」**。我们的问题（工单 + AC + 独立验收）不是——它是一个需要外部状态的协议。

### 3.4 最常见的失败点（有出处的，不是编的）

| # | 失败点 | 一手证据 | 我们会踩吗 |
|---|---|---|---|
| **F1** | **并发写同一份状态文件 → 截断 JSON → 全链路崩** | HN 46993479：*"I had seven on UserPromptSubmit, each reading stdin on their own. **Two wrote to the same JSON state file. Concurrent writes = truncated JSON = every downstream hook breaks.**"* | **会**。本仓已有同类教训（A8「用谓词值当事件身份做去重」）。正解是 **单写入者**（§2.1 N5） |
| **F2** | **「最后 20%」：假的 ready、worker 自己回答范围变更、门禁抖动** | 中文实践者（Orca skill 帖）：*"the hard part isn't assigning work, it's the last 20%"*；三类复现失效：false `ready` states / workers auto-answering scope changes / flaky gates + large diffs | **会**。`SILENT` 档（exit 0 + 空输出）就是 false ready 的实例，已本机实测 3/3 |
| **F3** | **集成边界上错误复利** | overstory `STEELMAN.md` §1：*"The compounding is worst at **integration boundaries** … Both pass their individual quality gates. The conflict only surfaces when the branches merge"* | **会**（多工单并行时）。v0 只有 1 工单，暂规避 |
| **F4** | **协调开销吃掉并行收益** | 同一份 `STEELMAN.md` 给了硬数字：*"A 20-agent swarm completing 15 tasks over 6 hours consumed **8M tokens (roughly $60)**. A single agent completing the same tasks sequentially over 8 hours consumed **1.2M tokens (roughly $9)**. The 2-hour speedup cost **$51** in additional coordination overhead."* | **会**。这就是 15× 的一手实证（6.7×），且它发生在**同一个人、同一个项目**里 |
| **F5** | **调试变成取证** | 同上 §4：*"You spend more time doing **forensic reconstruction** ('which agent modified this, when, and why?') than actually fixing the issue. **The debugging tax often exceeds any parallelism gains.**"* | **会**。本仓现在就有「读 transcript 重建」的成本 |
| **F6** | **过早分解：在问题被理解之前就切开** | 同上 §5：*"Swarms encourage breaking problems into subtasks **before the problem is fully understood**. This is backwards."* | **会**。这正是 `planner` 角色在做的事（它的 schema 是扁平的，且不知道 repair） |
| **F7** | **包装器不是安全边界** | dsh `docs/003-execution.md:80`：*"These wrappers and directories establish **defaults, not a security boundary**. A worker can still execute a program by absolute path."* | **会**，且更严重（我们连 prompt 都写不进别人的进程） |
| **F8** | **只靠提示词的限制不是限制** | dsh `docs/007-architecture.md:507`：*"Avoiding code reads is a prompt rule, **not a tool restriction**."* | **会**。审计实测：`oversight-probe` 被要求「不要读推理文本」，实测**读到了全文**，并自陈「读取本身没有越过任何权限边界」 |
| **F9** | **一切只增不删** | dsh `docs/007-architecture.md:484`：*"Nothing deletes old records yet, so **these grow without bound**"* | **会**。本仓 `state.json` 已 43 KB，去重表只增 |
| **F10** | **框架本身被抽象卡住** | Kitaru 作者（HN 47520115）：*"teams … stretch pipeline DAGs to run agents … It technically worked, but **the abstraction was fighting the whole way.** The core issue was that pipelines assume you know the graph upfront, but agents don't."* | **部分**。我们的「图」是工单树，不是 DAG——这一点上我们是对的 |

### 3.5 一条反直觉的代价：自研会持续被宿主追平

`docs/research/2026-11-04-competitive-landscape.md` 已记录三条，本次复核仍在：

| 宿主动作 | 覆盖了我们什么 |
|---|---|
| `claude agents`（Agent view） | 「一屏列出所有会话 + Working/Needs input/Completed 分组 + 状态变化通知 + 可派发可 peek」——**README 能力边界里「能」的整列** |
| **Agent teams**（`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`） | shared task list + lead + 点对点消息 + 队友独立上下文。**限制很硬**：`No nested teams`（队友不能再派生队友）、`Lead is fixed`（不能提升队友为 lead）、`/resume` 不恢复 teammate、`No per-teammate permission modes at spawn` |
| **Agent SDK 的 `agents=`** | 程序化定义子 agent（`AgentDefinition`：tools / disallowedTools / model / skills / memory）+ `max_budget_usd` + `total_cost_usd` + `fork_session` + hooks + `can_use_tool` |

**这一条的意义不是「算了吧」，是「必须选宿主做不到的那一格」**：宿主能做到「多层」，但**做不到「验收者与执行者零共享上下文 + AC 是数据 + 不通过有强制后果」**。`Agent teams` 的 `reviewer` 是 prompt 约定；Mastra 的 evals 是离线打分。

---

## 四、有没有「半自研」的路径？

### 路径 A（推荐）：ACP 驱动买 acpx + 自写契约层

```
Overwatch 契约层（自己写 ≈ 2,000 行 + 3 份 md）
  ├─ ticket.json + validate-ticket.mjs
  ├─ 三事件 supervisor + report.json（脚本写，执行者不许写）
  ├─ gate.mjs（跑 AC 的 evidence_cmd，给退出码 + stdout hash）
  ├─ acceptor（干净上下文，一票否决）
  └─ run 台账（5 类产物，每类唯一写入者）
        │
        ▼  spawn，--format json，裸 ACP
   acpx 0.22.0（2.9 MB / 40 文件 / MIT / 35,554 月下载）
        ├─ acpx opencode      ← 本机唯一实测跑通
        ├─ acpx claude        ← 待 zod/v4 ESM 修
        └─ acpx deepseek-harness ← dsh，待解决 stdout 污染
```

| | |
|---|---|
| **能省什么** | 协议栈（30M 月下载的 SDK）、30 个 profile 的启动参数、会话保活/队列/取消、per-tool 权限策略（`autoApprove`/`autoDeny`/`escalate`）、`usage_update` 直读（**Mastra 这条拿不到**）、零 npm 依赖 |
| **省不掉什么** | 契约三件（工单/三事件/验收闸）、能力矩阵（ACP 协议层**没有工具白名单字段**，183 个 `$defs` 逐项查过）、claude-agent-acp 的平台 bug、各 harness 的私有 `_meta` 差异 |
| **什么情况下会后悔** | ① acpx 是 **pre-1.0**（README 原文：「Treat its CLI and runtime interfaces as evolving」）→ 升级要重测；② 如果你后来要做 Web UI / OTel 全链路 / 多人协作 → 这三件 Mastra 已做完，自写不划算 |

**缓解措施（写死，不是「注意一下」）**：把 acpx 调用封在**一个** `scripts/adapters/acpx.mjs` 里。接口变了只改一个文件。

### 路径 B：Mastra 编排 + 自写验收闸

| | |
|---|---|
| **能省什么** | subagent 原语（`maxSteps` / `onDelegationStart` / `onDelegationComplete`）、Observability（OTel span + token/cost + Studio 面板）、Workflow、Evals 基础设施 |
| **省不掉什么** | 验收闸（**Mastra 明确不提供 council primitive**）、预声明 AC、三事件（subagent 只回 `text`，「Nested tool calls and subagent metadata … aren't added to the parent agent's model context」）、**usage**（`createACPTool` 路径的 `onFinish.usage` 恒为 `{0,0,0}`，社区有复现仓库 `nick-inkeep/mastra-acp-terminal-usage-repro`；逃生口是 `AcpAgent.connection.promptStream()`，但那已经绕过了 Mastra 抽象） |
| **硬代价** | `@mastra/core` 解包 **85 MB / 3,571 文件**，Node ≥ 22.13，2026-09 以来 **384 个 release**。**这会推翻 ADR-0001 与 README 第 5 行（零 npm 依赖、Node ≥18、clone 即用）** |
| **什么情况下会后悔** | ① 你其实不需要 Web UI/OTel——那就白付 85 MB 与 384 个 release 的升级税；② 你需要预算硬闸——它的 ACP usage 恒 0 是个已知 bug，要自己绕 |

**明确的切换条件（不是「视情况」）**：如果 v0 之后要做 **Web UI / 多人协作 / OTel 全链路 trace**，切到 Mastra。**这个切换会推翻 ADR-0001，必须由用户显式裁决，不能由 Agent 顺手决定。**

### 路径 C：fork acpx / fork 一个现成框架

| | |
|---|---|
| **能省什么** | 完全可控；acpx 是 MIT，可自由改 |
| **省不掉什么** | **永远追不上上游**。acpx 已有 156 个版本、40 个文件、2.9 MB；上游每修一个 harness 兼容问题你都要手动合 |
| **什么情况下会后悔** | 当你 fork 后 3 个月发现上游已经把你想做的事做完了，而你的分支落后 80 个提交——这是 fork 的标准死法 |

**判断**：**只在「上游明确拒绝某个我们必须有的能力」时 fork**。目前没有任何一条这样的能力。

### 路径 D：写成插件/SDK，不做独立框架

| | |
|---|---|
| **能省什么** | **最多。** 不要 CLI、不要 installer、不要面板。交付物是 `SKILL.md` + 命令 markdown + 2–3 个零依赖脚本。`github/spec-kit` 证明这个形态能到 **149,162★**（16 个模板/命令文件，234 个 md） |
| **省不掉什么** | 可执行强制力。没有 `check-structure.mjs` 这类门，配置就只是建议。**而本仓那道门有 4 个已实测可绕过的洞**（见下） |
| **什么情况下会后悔** | 当你要「不管执行者愿不愿意都得过 AC」时——插件层没有否决权，只有建议权 |

**本仓那道门的洞（审计实测 T1–T6，四个能绕过）**：

| 变异 | 期望 | 实际 |
|---|---|---|
| `oversight-executor` 的 tools 加 `Agent` | fail | **通过** —— 深度是规范里唯一的核心主张，门完全不看 |
| 删掉 `tools:` 整行 | fail（应必填） | **通过** —— 宿主语义下「省略 = 继承全部」，白名单静默变全开 |
| 给 `planner` / `resolution` 加 `Edit`+`Bash` | fail | **通过** —— 只读名单只有 6 个角色 |
| `oversight-critic` 改名 `oversight-critique` 后加 `Edit`+`Bash` | fail | **通过** —— 用 `name.includes(r)` 子串匹配，改名即绕 |

→ **路径 D 的前提是先把这 4 个洞补上**，否则「插件形态」的强制力是零。

### 4.5 四条路径的一页纸对照

| | 一次性成本 | 持续成本 | 保住的独占项 | 推翻 ADR-0001？ |
|---|---|---|---|---|
| **A acpx + 自写契约** | **1,500–2,500 行 + 3 md ≈ 3–6 人周** | 中（acpx 升级要重测） | ✅ 全部 | ❌ 不推翻 |
| **B Mastra + 自写闸** | 同 A + 85 MB 依赖 | **高**（384 release/年 + usage bug） | ✅ 全部 | **✅ 推翻** |
| **C fork** | 中 | **高**（永远追上游） | ✅ 全部 | ❌ |
| **D 纯插件** | **最低（≈3 份 md）** | **最低** | ⚠️ 只保「建议」不保「否决」 | ❌ |
| **（对照）全买** | ≈0 | 低 | ❌ 失去 W3/W4 | ✅ |

---

## 五、dsh-superagent-prototype 的真实规模

### 5.1 硬数字（本次实测）

| 项 | 值 | 怎么测的 |
|---|---|---|
| 源码 | **15,205 行 / 111 文件**（含 6 个 `.tsx`） | `find src -name '*.ts*' \| xargs wc -l` |
| 测试 | **12,981 行 / 53 个 spec**（≈1:1） | `find tests -name '*.ts'` |
| 规格文档 | 9 篇编号文档 **1,973 行** + `prompts/` **291 行** | `wc -l docs/*.md prompts/*.md` |
| 运行时依赖 | **2 个**：`proper-lockfile` 4.1.2、`zod` 4.4.3 | `package.json` |
| 宿主依赖 | **23 个 `@deepseek-ai/dsh-*`，全部 alpha**（`0.2.1-alpha.2` / cordis `4.0.5-alpha.1`） | `peerDependencies` |
| 提交数 | **1**（2026-10-31T12:05:39Z，"DeepSeek Harness Team"） | `gh api .../commits`，非 shallow 计数 |
| Release / Issues | **0 release；`open_issues: 0`，issue 与 PR 全关** | `gh api repos/...` |
| 热度 | **22,123★ / 2,669 fork**，`pushed_at` 2026-11-03 | 同上 |
| 磁盘 | `size_mb: 0`（单提交、无历史） | 同上 |

**核心模块行数（前 12）**：

| 文件 | 行 | 属于 |
|---|---|---|
| `src/client/locales.ts` | 770 | **产品（UI 文案）** |
| `src/executor/dsh.ts` | 673 | 框架（派工单 + 起 Session） |
| `src/app/migration.ts` | 616 | **产品（迁移）** |
| `src/sources/github.ts` | 459 | **产品（集成）** |
| `src/core/tickets.ts` | 423 | 框架（领域） |
| `src/core/model.ts` | 353 | 框架 |
| `src/app/sessions.ts` | 352 | **框架（特权 API 全在这）** |
| `src/core/evals.ts` | 340 | 框架 |
| `src/app/resources.ts` | 308 | 框架（卡片 + 分页） |
| `src/app/tools/main.ts` | 301 | 框架（路由工具 schema） |
| `src/client/prompts.tsx` | 295 | **产品（prompt 编辑器 UI）** |
| `src/app/store.ts` | 291 | 框架（SQLite） |

**最能说明问题的一组对比**：`src/core/stage.ts` **26 行**、`src/core/ids.ts` **5 行**、`src/core/replies.ts` **95 行**、`src/app/effects.ts` **161 行**、`src/app/cards.ts` **96 行**。
**这五份（合计 383 行）是既有分析里「最值得抄」的全部机制**——事件身份去重、合并写、purpose 闸门、stage 表、有界卡片。
**也就是说：那篇分析认为值钱的东西，只占这个仓库的 2.5%。**

### 5.2 它花了多久做——**这个问题在客观上无法回答**

`git log` 只有 **1 个提交**（2026-10-31），`gh api` 也确认 `length: 1`。这是**刻意的 squash 发布**：作者把内部历史压成一个提交再公开。

**所以任何「看 git log 算工期」的结论都是编的。** 我能给的最强替代与它的误差：

| 方法 | 结果 | 误差来源 |
|---|---|---|
| 代码量反推 | 28,186 行（源码+测试）+ 2,264 行（文档+prompt） | 与工期无固定比例 |
| 作者自述 | README 第一段：*"This code grew out of our team's day-to-day development work, **with much of the engineering done by coding agents**."* | 「much」是多少不知道 |
| 结论 | **不可知**。可在「数周（有 coding agent 辅助）到数月（纯人工）」之间，**不能再收窄** | — |

**这个「不可知」本身是一条发现**：它意味着**任何用「dsh 多久做出来的」来论证「我们也行」的推理都是无锚的**。正确做法是**用自己的历史速度反推**——本仓 80 个提交 / 12 天 / 15,389 行生产代码，但 75 个提交集中在头 3 天，后 9 天只有 5 个提交（全在修 bug）。**那才是真实速度曲线：前 3 天造完，后 9 天修。**

### 5.3 它自己承认没做的部分

| # | 自述 | 原文 |
|---|---|---|
| **1** | **文章里的设计 ≠ 本原型** | README:5「We have adapted it for publication, so it is **not identical** to our internal version or the implementation described in *Exploring Super-agent Design* … **Some designs discussed in the article are directions for future development and are not implemented in this prototype.**」 |
| **2** | **不是产品，是研究代码** | README:3「**Research prototype for reference only**, not an official DeepSeek product … Treat it as **research code, not production-ready software**. It may still contain bugs, and its coding style and engineering practices may be inconsistent.」 |
| **3** | **包装器不是安全边界** | `docs/003-execution.md:80`「These wrappers and directories establish **defaults, not a security boundary**. A worker can still execute a program by absolute path.」 |
| **4** | **主 agent 不读代码只是提示词** | `docs/007-architecture.md:507`「Avoiding code reads is a **prompt rule, not a tool restriction**.」 |
| **5** | **一切只增不删** | `docs/007-architecture.md:484`「**Nothing deletes old records yet**, so these grow without bound」 |
| **6** | **两个未解问题** | `docs/007-architecture.md:614-617`：① 信任边界（哪些 Trigger 字段可信）；② **部署隔离（agent 用独立 pin 的 harness 安装，避免宿主升级即失效）** ← **这正是我们的处境** |
| **7** | **无分层汇报** | 全文无「hierarchical / nested session / 一层层上报」。worker 的 subagent 用 `standard` preset，**`parentSession` 上溯最多 8 层只为找所属工单**，不是汇报链。**它没有「一层层子 agent 汇报给上一层」的机制，也不打算实现** |
| **8** | **没有验收闸** | `grep -rn "acceptance\|verdict\|pass.*fail.*gate" src/` 只命中「acceptance time」（接单时间）。**它没有「AC 是数据 + 判过不过」这一层** |
| **9** | **没有证据核对** | `grep -rn "evidence\|claim" src/` 只命中 `intent_evidence`（接单时的判断依据）。**它没有「这句断言有没有 tool_result 支持」** |

**第 8、9 条是本次最重要的单项发现**：**dsh——这个被 22k 人当作「super agent 范本」的项目——恰好没有我们唯一独占的那两样东西。** 这既证明「验收层没人做」，也证明「dsh 不能当作自研的完整模板」：照它抄，抄出来的东西不会有验收闸。

---

## 六、反向：什么情况下自研是错的

以下每条都是**可证伪的**，不是态度。

### 6.1 已经成立的三条（不需要新证据了）

**C1 —「深度 1 的框架不是框架」。**
12 份角色 `tools:` **全部显式声明，无一份含 `Agent`**（本次 `grep -H "^tools:" | grep -c -i "agent\|task"` → **0**）。宿主 `Agent teams` 也明写 `No nested teams`。所以「自己的手下也可以有手下」**当前物理不存在**。
→ **在深度 1 下，「自研框架」交付的是一个带检查表的 `spawn()`。** 这不值得叫框架，值得叫脚本。
**证伪方式**：给一个角色加 `Agent`，实测它派出第二层并回可解析的卡片。**做不到这条，「框架」这个词就该从文档里删掉。**

**C2 —「dsh 不能当模板」。**
它没有验收闸、没有证据核对、没有分层汇报（§5.3 第 7–9 条），且 73.4% 是产品。
→ **照它抄会抄到 11,162 行不需要的代码，同时漏掉唯一值钱的那一层。**

**C3 —「运行时自研是错的」。**
e 类（进程池/沙箱/状态机）需要 10 个特权 API，ADR-0001 已裁决拿不到；且平台明确禁止「代批权限」。
→ **谁提出「自研运行时」，就该先回答「你怎么拿到 `sessionController.create` 的等价物」。**

### 6.2 尚未验证、但一旦成立就必须停的五条

| # | 条件 | 判据（怎么测） | 成立时该怎么办 |
|---|---|---|---|
| **C4** | **验收闸拦不住东西** | 构造「diff 为空 + report 说 DONE」→ verdict 必须是「不通过」。做不到 → 停 | **砍掉整个自研计划**，退回 Mastra + 人工 review。**这是止损点，不是风险项** |
| **C5** | **AC 本身不可判定** | `verdict.items[].result=fail` 且理由是「AC 不可判定」的比例 **>20%** | 加 `critic` 在**派发前**攻击 AC（不是攻击交付物）；再超 → 说明 AC 这件事本身不成立 |
| **C6** | **失败主要来自上游，不是我们这侧** | 连续 10 次 run 里 ≥3 次失败，且原因都在适配器/上游（`claude -p` 的 SILENT、`claude-agent-acp` 的 zod bug、dsh 的 stdout 污染） | **「自研自己的 harness」不能解决这些问题**——那是同一个外部依赖。此时正确答案是换 harness，不是造 harness |
| **C7** | **经济学不成立** | 一个 run 的成本 > 同一任务用单个会话做 15× 的收益阈值。参照：overstory 实测 6.7×（8M vs 1.2M token，$60 vs $9） | 只在「任务值付得起」的场景用，不要产品化 |
| **C8** | **用户成了唯一操作者且每天问不到 3 次** | 「公司」摊销不了任何东西；回答问题的负担反而上升（这是 `company-architecture.md` §8.1 R1，它自称「唯一会否掉整个产品的风险」） | 退回「一个会话 + 一个更好的提问模板」 |

### 6.3 结构性条件：三条「别造」的红线

| 红线 | 理由 |
|---|---|
| **要 Web UI / OTel 全链路 / 多人协作** | 这三件 Mastra 已做完，自写不划算。**这时候自研是错的，买是对的** |
| **要跨机器/跨组织的委托** | 那是 A2A 的领域，不是 ACP。我们自己造会造错协议 |
| **要「阻止它做什么」而不是「记录它做了什么」** | 沙箱/权限隔离方面，dsh 自己都说「defaults, not a security boundary」。**承诺不了就别写进能力边界**，否则会重演「以为能自动接力」的错 |

### 6.4 一条必须写下来的反面证据（对自研不利）

arXiv **2505.18286**《Single-agent or Multi-agent Systems? Why Not Both?》摘要原文：

> *"we conduct an extensive empirical study comparing MAS and SAS across various popular agentic applications. We find that **the benefits of MAS over SAS diminish as LLM capabilities improve** … Furthermore, the performance discrepancy between MAS and SAS motivates our design of a hybrid agentic paradigm, **request cascading between MAS and SAS**, to improve both efficiency and capability. Our design improves accuracy by **1.1-12%** while **reducing deployment costs by up to 20%**."*

**这条对自研是双重不利的**：

1. **「多 agent 更好」这个前提在随模型变强而减弱**——所以「造一个多 agent 框架」的长期价值在下降，不是在上升。
2. **它给出的替代方案成本极低**：`request cascading`（在单个强 agent 与升级之间路由），**+1.1–12% 准确率、−20% 成本**。**这是一个「不造框架」也能拿到大部分收益的路径**，而且它的实现规模就是一次路由判断。

**同时它支持我们的哪一点**：它没有否定「独立验证者」。Cognition 的二手中介证据（干净上下文 review agent 每 PR 抓 2 个 bug、58% 严重）说明**收益来自上下文隔离，不是来自 agent 数量**。而上下文隔离**不需要框架**——只需要「另开一个干净会话」。

→ **所以最终判断要说得更准**：

> **自研的正当性不在「多 agent」，在「另一个干净上下文 + 一份预声明标准 + 一个不可逃的否决」这三样。**
> 前两样用一个 spawn 就能做到（不需要框架）。**只有第三样需要「契约 + 门 + 台账」，而那是 2,000 行，不是 15,000 行。**

---

## 七、给决策者的一页纸

```
「super agent 框架」该读成什么
  ✅ 一份工单契约（goal 逐字 + AC + boundary + 预算 + capability_gap）
  ✅ 一个三事件 supervisor（DONE / BLOCKED / NEEDS_DECISION，无 progress）
  ✅ 一个验收闸（干净上下文 + 机器证据 + 一票否决 + unknown≠fail）
  ✅ 一个外部适配器（acpx + opencode，只做一个）
  ✅ 一本 run 台账（5 类产物，每类唯一写入者）
  ❌ 不是一个运行时、不是一个面板、不是一个 DSL、不是一个上下文管理系统

规模（dsh 实测反推，不是估算）
  dsh 15,205 行 → 框架 4,043 行（26.6%）/ 产品 11,162 行（73.4%）
  我们的增量 ≈ 1,750–2,250 行 + 1,100–1,400 行测试 + 3 份 markdown
  ≈ 1 个 watch.mjs 的体量（2,614 + 2,706 行）

1 人维护的实测上限
  单模块 ≈ 2,600 行生产 / 2,700 行测试，需要 20+ 轮修复才稳
  本仓证据：watch.mjs → DF-001…DF-024；38 个脚本 / 15,389 行 / 4 条 open

四个真实放弃案例（本次新增，既有研究没找到）
  overstory 1,313★  明说「不再维护」→ Warren
  1code     5,574★  6 周后归档 → 转私有
  agent-teams-lite 1,245★ → gentle-ai（8,724★，因为「纯 markdown 撑不住分发」）
  Claude-Code-Workflow 2,117★ → Maestro Flow
  （对照）AutoGen 61,777★ → 微软自己归档，指向 MAF
  ★ 共同点：失败在「分发/安装/维护」，不在「编排逻辑」；
           结局是「重写一个更大的」，不是「退回现成框架」

什么情况下自研是错的（可证伪）
  已成立 —— 深度 1 的框架不是框架（12/12 角色无 Agent，宿主 No nested teams）
  已成立 —— dsh 不能当模板（它没有验收闸、没有证据核对、73.4% 是产品）
  已成立 —— 运行时自研是错的（10 个特权 API 拿不到，ADR-0001 已裁决）
  待证伪 —— C4 验收闸拦不住东西 → 砍掉整个计划，退回 Mastra + 人工 review
  待证伪 —— C5 AC 不可判定 >20% / C6 失败主要来自上游 / C7 成本 >15× / C8 用户成唯一操作者

一条对自研不利的硬证据（必须写进决策依据）
  arXiv 2505.18286：MAS 相对 SAS 的收益随模型变强而减弱；
  而它的替代方案（request cascading，单强 agent + 升级路由）
  拿到 +1.1–12% 准确率、−20% 成本，实现规模是一次路由判断。

推荐
  买驱动（acpx），造契约（工单/三事件/验收闸），不造运行时。
  理由不是偏好：驱动层是 30M 月下载的白菜价，
  而验收层四个放弃案例里没有一个人做过——dsh 也没有。
```

---

## 八、复现方式

```bash
# ── dsh 规模（本次全部数字的来源）
cd .tmp-analysis/dsh-ref
git rev-list --count HEAD                                    # 1
find src -name '*.ts*' | xargs wc -l | tail -1                # 15205 / 111
find tests -name '*.ts' | xargs wc -l | tail -1               # 12981 / 53
for d in src/*/; do
  echo "$d $(find "$d" -name '*.ts*' | wc -l) $(find "$d" -name '*.ts*' | xargs cat | wc -l)"
done
find src/core src/executor src/infra src/app -name '*.ts' | xargs wc -l | sort -rn | head -25
node -e "const p=require('./package.json');console.log(p.dependencies,Object.keys(p.peerDependencies).length)"
grep -rn "acceptance\|verdict" src/ | grep -v "acceptance time\|acceptance order"   # 空 = 无验收闸
grep -rn "hierarch\|nested session" docs/*.md                                       # 空 = 无分层汇报

# ── 真实提交数（shallow clone 的 rev-list 会骗人，要用 API）
export GH_TOKEN=$(gh auth token)
gh api "repos/deepseek-ai/dsh-superagent-prototype/commits?per_page=100" --jq 'length'   # 1
gh api repos/deepseek-ai/dsh-superagent-prototype --jq '{stars:.stargazers_count,issues:.open_issues_count,pushed:.pushed_at}'

# ── 放弃案例（四个）
gh api repos/jayminwest/overstory --jq '.archived'                    # true
gh api repos/jayminwest/overstory/readme -H "Accept: application/vnd.github.raw" | head -12
gh api repos/jayminwest/overstory/contents/STEELMAN.md -H "Accept: application/vnd.github.raw"   # 12 条自我反驳，含 8M/$60 硬数字
gh api repos/21st-dev/1code --jq '{archived,created_at,pushed_at}'
gh api repos/Gentleman-Programming/agent-teams-lite/readme -H "Accept: application/vnd.github.raw" | head -12
gh api repos/catlog22/Claude-Code-Workflow/readme -H "Accept: application/vnd.github.raw" | head -12
gh api repos/microsoft/autogen/readme -H "Accept: application/vnd.github.raw" | sed -n '14,32p'

# ── 组织层当 markdown 卖的最强反例
gh api repos/github/spec-kit --jq '{stars,forks}'
gh api "repos/github/spec-kit/git/trees/main?recursive=1" --jq '[.tree[]|select(.path|startswith("templates/"))|.path]'

# ── 宿主已经做到哪（这是自研要避开的正面冲突区）
grep -n -A25 "## Limitations" .tmp-analysis/cc-agent-teams.md

# ── 买得到的那一层（价格是白菜）
curl -s --proxy http://127.0.0.1:7897 "https://api.npmjs.org/downloads/point/last-month/@agentclientprotocol%2Fsdk"   # 30107922
curl -s --proxy http://127.0.0.1:7897 "https://api.npmjs.org/downloads/point/last-month/@anthropic-ai%2Fclaude-agent-sdk"  # 61334229
curl -s --proxy http://127.0.0.1:7897 "https://api.npmjs.org/downloads/point/last-month/@mastra%2Facp"                 # 64561
curl -s --proxy http://127.0.0.1:7897 "https://registry.npmjs.org/acpx/latest" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.version,j.dist.unpackedSize,j.dist.fileCount)})'

# ── 本仓自己的维护成本基线
ls scripts/*.mjs | grep -v test | xargs cat | wc -l    # 15389
ls scripts/*.test.mjs | xargs cat | wc -l              # 9531
grep -c "^### DF-" tasks/dev-findings.md               # 24
git log --pretty='%ad' --date=short | sort | uniq -c   # 前 3 天 75 个提交，后 9 天 5 个
```

**最值得点进去的 6 个文件**：

| 想看什么 | 看哪 |
|---|---|
| 「自研会怎么失败」的最好一手材料 | `jayminwest/overstory` 的 **`STEELMAN.md`**（12 条自我反驳 + `8M token/$60 vs 1.2M/$9` 硬数字） |
| 「纯 markdown 组织层」的上限与死因 | `Gentleman-Programming/agent-teams-lite` 的弃用理由表（11 项全非编排能力） |
| 宿主已经做到哪，我们该避哪一格 | `.tmp-analysis/cc-agent-teams.md` 的 `## Limitations`（`No nested teams` / `Lead is fixed`） |
| 买驱动该买谁、买完能拿到什么 | `acpx` 0.22.0 的 `docs/VISION.md` + `docs/permissions.md`；`@anthropic-ai/claude-agent-sdk` 的 `types.py:108`（`AgentDefinition`） |
| 「organizational layer as config」的最强证据 | `github/spec-kit` 的 `templates/commands/`（10 个纯 markdown 命令 → 149,162★） |
| 我们唯一值钱的那 383 行 | dsh 的 `src/core/{stage,ids,replies}.ts` + `src/app/{effects,cards}.ts` |
