# 多 Agent 公司架构：几个层级、一条问题流、一个外包口

> **状态：Proposed。零行实现。**
> 本文件不描述任何已实现能力。系统现在能做什么，读 [README.md](../../README.md) 的「能力边界」。
>
> 用户原话（逐字，作为判据）：
> > 它可以带自己的手下，自己的手下也可以有手下
> > 它也可以带别人的手下，去完成自己手下做不到的事
> > 这两个都要做，我们目前先专攻带别人的手下（Claude code cli、dsh(可以延缓)），然后再专注搭建我们自己的 harness agent 框架
> > 这就是一个围绕着用户的公司，间接对接用户，公司内职责分明，又不臃肿，又可以外包给其他公司
>
> 产品定位（见 [`2026-11-11-question-protocol-thesis.md`](2026-11-11-question-protocol-thesis.md)）：
> **「替你被问」——用户是需求方，双向知识缺口必须同时补。**

- 日期：2026-11-11
- 作者：规划 Agent C1
- 产出形态：artifact（组织设计书）

---

## 零、覆盖声明（按 `docs/spec/evidence-discipline.md` §4）

**实际读了**：`docs/design/2026-11-11-question-protocol-thesis.md`（全 100 行）、
`docs/spec/2026-11-11-question-protocol.md`（全 1194 行）、
`docs/research/2026-11-10-agent-roles-audit.md`（全 355 行）、
`docs/research/2026-11-10-framework-build-vs-buy.md`（全 330 行）、
`docs/design/2026-11-10-agent-framework-skeleton.md`（全 912 行）、
`docs/research/2026-11-04-orchestration-patterns.md`（全 277 行）、
`docs/research/2026-11-04-dsh-superagent-analysis.md`（全 487 行）；
另读 `docs/spec/{dispatch-contract,evidence-discipline,output-format}.md`、
`docs/adr/0001-config-only.md`、`docs/design/README.md`、
`docs/research/2026-11-04-external-harness-protocols.md` §1–§3、
`docs/design/intent-contract.md` §2.3（capability 受控词表）、
`.claude/skills/oversight/SKILL.md`（全 177 行）、`templates/{dispatch,acceptance-criteria}.md`。

**代码侧只读核对**：
`grep -Hn "^tools:" .claude/agents/*.md`（12 份全部显式列了白名单，**无一份含 `Agent`**）；
`sed -n '1,80p' scripts/validate-run.mjs`（`CAPABILITIES` 12 值 / `SHAPES` 3 值 / `REQUIRED_FOR_COMPLEX`）；
`check-structure.mjs` 的 `checkDesignIndex`（`:916`）与 `checkChangelog`（`:683`）；
`node scripts/check-structure.mjs` 基线为**绿**。

**没做 / 无法核实**：

1. **没有做任何多 agent 实测**。下文关于深度、并发、成本的断言均引自既有研究，不是本机自测。
2. **没有验证子 Agent 能否调用 `AskUserQuestion`**。下文据此把「谁有权问用户」写成「持有该工具的进程」，
   并把「主线程是唯一持有者」标为 `[待验证]`（见 §3.3 T-Q1）。
3. **没有验证 ACP `elicitation/create` 在 opencode 上的实际行为**，因此「外部 harness 的追问必须回流」
   这条用的是协议能力，不是实测。
4. **没有算 15× 的实际金额**。v0 只有 1 个工单，这个账在 v1 之前必须补。
5. 本文件**不修改任何代码或配置**；唯一附带改动是 `docs/design/README.md` 的一行索引
   （`checkDesignIndex` 要求每份设计文档必须登记状态，不登记则结构门红）。

---

## 一、先确定这家公司卖什么

不确定这一条，后面每个岗位都能给自己找到理由。所以先说死：

> **公司出售的唯一商品是「一次不用返工的交付」。**
> 它不卖算力，不卖并行，不卖「多 agent 协作」——那三样 2026 年已经饱和
> （LangGraph 44.7k★、CrewAI 60.7k★、AutoGen 已归档；宿主自己做了 Agent view）。

由此推出三条**可否决设计**的判据：

| # | 判据 | 否决什么 |
|---|---|---|
| J1 | 任何岗位的存在，必须对应一条**别人做不了的判断** | 否则它是脚本，不是岗位 |
| J2 | 任何新增产物，必须属于**已有 5 类**之一 | 否则它应该是一个字段，不是一个文件 |
| J3 | 任何一层派发，必须能写出**父级缺的那项能力** | 否则这一层是为了层级而层级（反模式 A5） |

**J1 是最容易被违反的一条**，因为它听起来像常识。下面每个岗位都按它审过一遍。

---

## 二、组织结构

### 2.1 三层 + 两个旁挂

```
                 ┌──────────────────────────────────────┐
   公司外         │  用户（需求方）                        │
                 │  唯一入口，唯一授权来源                 │
                 └───────────────┬──────────────────────┘
                                 │  ① 原话（逐字）  ② 答案（acknowledged）
                 ┌───────────────▼──────────────────────┐
   L0  接待台      │  接待台 Intake                        │  1 人
      (前台/问询)  │  唯一能问用户；唯一持有问题包           │
                 │  逐字扫描原话；把答案切片下发            │
                 └───────────────┬──────────────────────┘
                                 │  ③ ticket.json（goal 逐字 + AC + 边界 + 预算 + 答案引用）
                 ┌───────────────▼──────────────────────┐
   L1  工头        │  工头 Foreman                         │  每 run 1 人
      (项目经理)   │  切工单；写契约；派活；收卡片           │
                 │  不读产物内容，只读卡片                 │
                 └───────────────┬──────────────────────┘
                                 │  ④ dispatch（prompt + 工单）
                 ┌───────────────▼──────────────────────┐
   L2  执行者      │  执行者 Worker                        │  每工单 1 个
      (干活的)     │  只干这一张工单；不定义自己干什么        │
                 │  可以是 native 子 agent，也可以是外部进程 │
                 └───────────────┬──────────────────────┘
                                 │  ⑤ report.json（6 字段）+ 指针
                                 ▼
                          （回到 L1，不越级）
   ────────────────────────────────────────────────────────
   旁挂 门禁        门禁 Gate（验收）                      每工单 1 人
                    不在汇报线上。只读 AC + 证据 + diff，写 verdict.json。
                    无 Edit / 无 Bash / 无 Agent。一票否决。

   旁挂 记账        不是岗位，是 3 个脚本 + 5 类文件（见 §6.3）
```

**为什么接待台和工头必须分开命名，即使 v0 里是同一个人**：它们是两种不同的判断
（「用户到底要什么」vs「这件事怎么切成能验收的小块」），失败方式也不同。
合并实现可以，合并命名不行——合并命名之后，就没有任何东西能提醒你它们该分开了。
v0 的合并与拆分触发条件写在 §6.1。

### 2.2 每个岗位的职责边界

**边界不是「你负责什么」，是「你绝对不能做什么」**——前者靠自觉，后者要靠工具集和写权限。

#### L0 接待台

| 做 | 绝对不能做 |
|---|---|
| 逐字收原话（不转述、不概括、不改写） | 读代码、读 diff、读执行日志 |
| 逐字扫描原话，列出 `decisions_seen`（§3.2） | 自己回答自己提的问题 |
| 生成并交付 `QuestionPack`；合并下属提议 | 自己宣布「用户答了」（这个判定属脚本） |
| 决定 ask / guess / drop，并记账 | 因为「问太多」而删除问题（只能停并报告「需求过宽」） |
| 把答案按 `subject` 切片，随工单下发 | 把全部答案广播给所有执行者 |
| 汇总成 ≤10 行给用户 | 修改任何产物文件、跑任何改仓库的命令 |

工具集（native 侧）：`AskUserQuestion` + `Agent` + `Read`。**无 `Write`、无 `Edit`、无 `Bash`。**
写台账的动作全部由脚本代劳——因为 `goal.md` 要求「逐字」，而逐字的唯一保证是**不经过模型**。

#### L1 工头

| 做 | 绝对不能做 |
|---|---|
| 把目标切成 ≤N 张能被独立验收的工单 | 写实现方案、写文件清单、写「你觉得该怎么改」 |
| 声明 AC（可观测 / 有证据命令 / 有 fail_if） | 事后增补或修改 AC |
| 声明 `boundary`（不许碰什么）与预算、时限 | 分配超过父层剩余预算的额度 |
| 按 `adapter` 能力矩阵选择谁来干 | 在适配器不支持 `boundary` 时仍然派需要边界的活 |
| 收 `report.json` 卡片，判「继续 / 升级 / 停」 | 读 `report.md` 全文（那是执行者的自述，会锚定） |
| 写 `ticket.json`、判四档失败 | 自己验收自己的工单 |

工具集：`Read, Write(仅 contracts/), Agent`。**无 `Edit`、无 `Bash`。**

#### L2 执行者

| 做 | 绝对不能做 |
|---|---|
| 只做这一张工单的目标 | 修改 AC、修改 `tasks/runs/` 下任何契约文件 |
| 在 worktree 里自由写产物 | 走出 worktree、动仓库主目录 |
| 遇到做不了的事 → 交还（`BLOCKED` + 一句理由） | 自己扩大范围把它硬做掉 |
| 提问题 → 提进 `proposed-<subtree>.jsonl` | 直接把问题问用户 |
| — | 自己写 `report.json`（那是 supervisor 写的） |

工具集：**由 harness 决定，不由我们决定**。这是本架构里最容易被误解的一处，见 §4.4。

#### 门禁（旁挂）

| 做 | 绝对不能做 |
|---|---|
| 对照 `ticket.AC[]` 逐条判 pass / fail / unknown | 参与执行、给出修法（那是修复的事） |
| 只读：`ticket.json` + `report.json` + `gate.json` + diff | 读 `report.md`、读上一轮 verdict、读锐评 |
| 写 `verdict.json`（逐条 + `uncovered[]`） | 判「AC 本身不可判定」为 fail（必须判 `unknown`） |

工具集：`Read, Grep, Glob, Write(仅 verdict.json)`。**无 `Edit`、无 `Bash`、无 `Agent`。**
现有 `oversight-acceptor` 缺的正是「能跑命令」——本架构不给它 `Bash`，
而是把「跑命令」拆成脚本 `gate.mjs`（见 §2.5 M4）。这样它的一票否决才**有证据可依**，
而不是「我无法核实」。

### 2.3 主 agent 和手下的唯一区别

这是本文件最要紧的一条，因为「不能只是 prompt 不同」是对的，但答案不是「工具不同」——
工具不同是**角色之间**的区别，不是**层级之间**的区别（三层都可以有 `Read`）。

> **唯一区别是：它写的东西会被下游当作「判据」，还是被当作「产物」。**

| | 手下（L2） | 主 agent（L0/L1） |
|---|---|---|
| 写什么 | **产物**：worktree 里的任意文件 | **契约**：`ticket.json` / `pack.json` / `verdict.json` |
| 产出被谁读 | 人读，或被门禁当**被检验对象** | **脚本解析**，解析结果改变别的进程的行为 |
| 能不能被机器判定 | 不能（只能对照 AC 判） | 能（schema + 校验器） |
| 有没有下级 | 没有（`tools` 不含 `Agent`） | 有 |

把这句变成可检查的不变量：

> **不变量 W：没有任何一个岗位同时拥有「写产物」和「写契约」的能力。**
> 数学上等价于：`write_scope` ∈ {`product`, `contract`}，且两者互斥。

现有 12 份里 **4 处违反**这条（审计 §三）：`acceptor` 有未限定路径的 `Write`；
`repair` 同时有 `Edit`/`Bash` 与改验收标准的能力；`relay`、`resolution` 的 `Write` 无边界。
**这不是「白名单偏紧」，是「谁有权改判据」这件事从来没被当成一个边界。**

三层强制力必须分开说，否则会把审计层当成物理层：

| 对象 | 强制力 | 机制 | 挡不住什么 |
|---|---|---|---|
| native 子 agent | **强（物理）** | `tools:` 是**精确枚举**（列出即只给这些，省略=全给）。写契约的岗位不给 `Edit`/`Bash`；执行的岗位不给 `Write` 到台账目录 | 角色定义写错（`check-structure` 现在查不出 `Agent`，T1 漏洞） |
| 外部 harness | **中（协议）** | ACP `session/request_permission` 是 **agent → client**：干什么由它提，批不批由我们定。cwd 只挂 worktree | 不支持 `request_permission` 的 harness（只能靠 cwd + 事后审计） |
| 主线程（L0/L1 的物理载体） | **弱（审计）** | 宿主决定它的工具集，我们改不了（ADR-0001）。只能事后用 `question-audit` 核对它有没有跑改仓库的命令 | 它自称没做。这是 ADR-0001 已接受的缺陷，本文件不假装解决 |

**最后一行是这套架构的诚实底线**：`acceptor` 的「不能改产物」是物理的，
主线程的「不能改产物」是审计的。两者不是一回事，不许可写成同一句话。

### 2.4 谁向谁汇报，汇报是什么形状

三条铁律：

1. **汇报只有三种状态，没有第四种。**
   ```js
   const REPORT_STATES = Object.freeze(['DONE', 'BLOCKED', 'NEEDS_DECISION']);
   ```
   不设 `progress`。dsh 有 `progress` 然后 `return undefined` 把它丢掉（`notices.ts:127`）——
   那是它付过的学费。**过滤是一个需要维护的判断，枚举是一个不需要判断的白名单。**

2. **向上只传一张卡片，6 个字段，全是机器可读的。**
   ```json
   { "ticket_id": "T-0001", "state": "DONE", "summary": "≤160 字",
     "changed_files": ["..."], "cost": {"usd":0,"tokens":0,"wall_ms":0},
     "read": "tasks/runs/<id>/report.md" }
   ```
   卡片由 supervisor（脚本）生成，**不由执行者生成**——执行者写自己的报告就是自我评价，
   而「锐评的结论不能由执行 Agent 自己写」是 CLAUDE.md 硬约束 3，对验收同样成立。

3. **平级之间没有通道。**
   执行者之间不通信、门禁与执行者不通信。**不是因为省 token，是因为任何平级通道都会成为第二条授权路径**：
   一条来自另一个 agent 的消息可以自称「用户同意了」，而 README 的判据是「看这条记录是谁写的，不看它像不像同意」。
   一旦开了平级通道，这个判据就要在每个接收方重新实现一次。**不开，就不用实现。**

### 2.5 「不臃肿」靠什么保证——六个机制，每个都能被脚本检查

用户要的「不臃肿」不是人数少，是**加了岗位之后总复杂度不涨**。口号做不到，只有机制能做到。

| # | 机制 | 一句话 | 怎么机械检查 |
|---|---|---|---|
| **M1** | **产物闭集** | 全公司只有 5 类机器产物：`goal` / `pack+answers` / `ticket` / `report` / `verdict`。新需求只能是**加字段**，不能是加第 6 类文件 | 校验器对 `tasks/runs/*/` 做形状检查：出现未登记的文件名 → fail |
| **M2** | **每岗必须有一条被消费的边** | 岗位产出 → **具名脚本解析** → 下游。没有消费者的岗位是死代码 | 扩展 `checkAgentReachability`：每个角色的输出 schema 必须被一个存在的脚本以字段名 grep 到 |
| **M3** | **同一 schema 唯一作者** | 两个岗位输出同形状 → 合并。这是现有 12 份「10 种模板、零个解析器」的根因 | 角色定义之间做输出字段集合的交叉比对，重合度 > 0.7 即警告 |
| **M4** | **能用脚本判的不设岗位** | 本轮据此**砍掉三个岗位**：门禁执行者、状态记账员、修复者（理由见 §9） | 新增岗位定义必须含一节「为什么脚本做不了」，缺失即 `checkAgents` fail |
| **M5** | **预算单调递减 + 编队声明** | `Σ子预算 × (1+overhead) ≤ 父预算`；每次 run 必须在 `ticket.json` 里声明本次编队，未声明的不许派 | `validate-ticket.mjs` 对预算做算术检查；对编队做集合检查 |
| **M6** | **`tools` 必须显式且完整** | 省略 `tools:` = 继承全部 = 白名单静默变全开（审计 T2） | `tools:` 成为**必填**字段；且必须能对上一个合法工具名表（审计 T6） |

**M1 是最硬的一条，因为它把「要不要加东西」变成了一道算术题。**
一个想加「进度报告」的人，会先被迫回答「它属于 5 类里的哪一类」——
答案是「哪一类都不是」，于是这个需求当场消失，而不需要开会讨论。

**M2 的现成先例是 `checkAgentReachability`**（`check-structure.mjs:955`）——
它是这个仓库里**唯一一条真正跑起来并拦住过东西**的角色检查（实测：把 `oversight-safety`
从 SKILL.md 删掉直接 fail）。本架构只是把它的判据从「有没有被提到」推进到「产出有没有被解析」。

### 2.6 递归：三道闸，按强度从硬到软

现有规范 `dispatch-contract.md` §7 写「默认深度上限 3 层」，**不可执行**：
12 份角色**全部显式列了 `tools:`，无一份含 `Agent`**（本次 grep 复核），
而 `tools` 是精确白名单 → 实际深度是 **1**。规范声称的能力在配置里不存在，比没有规范更坏。

新设计不写数字，写三道闸：

| 闸 | 类型 | 机制 | 挡得住什么 | 挡不住什么 |
|---|---|---|---|---|
| **G1 工具可达性** | **物理** | 深度上限 = 「哪个角色的 `tools` 里有 `Agent`」。宿主本身也在到限时收走该工具 | 越权派发（物理上没这个工具） | 角色定义写错——所以 `checkAgents` 必须查 `Agent`，现在完全不查 |
| **G2 预算单调递减** | **算术** | `Σ children.budget + 本层 overhead ≤ parent.budget`，`overhead ≥ ε`。于是最大深度 ≤ `log(1/ε) / log(1/(1-ε))`，与人的自觉无关 | 深度爆炸（钱先烧完），这是 15× token 的唯一硬约束 | 有钱的 run（预算极大时仍可深） |
| **G3 capability_gap 声明** | **语义** | 每层派发必须填 `capability_gap: "父级没有的能力 X"`，写不出 `validate-ticket` 拒绝 | 「为了层级而层级」 | 编一个理由（所以它是第 3 道，不是第 1 道） |

**关键区分：深度不是公司结构的属性，是单次派发的属性。**
公司可以设计 4 层，但每次 run 的深度由 ticket 树决定，且必须写进台账。
于是「我们有几层」这个问题有两个答案，必须分开说：

- **结构上限**：3 层（L0/L1/L2）。这是公司能表达的层级。
- **单次 run 的深度**：v0 = **1**（工单 → 外部执行者，无中间层）；v1 = 2；v2 才考虑 3。

**G2 的计算示例（这是唯一能真正封死递归的一条）**：若每层 overhead 占父预算 30%，
则第 3 层可用预算已不足父层的 50%，第 5 层不足 17%。而 v0 的单工单预算本来就是 root 的 30%——
**第 2 层就已经把预算吃穿了。** 这不是政策，是算术。

---

## 三、「问问题」在公司里怎么流动

这是产品的主题，所以它必须是结构的一部分，不是一个环节的礼貌用语。

### 3.1 五个环节与各自的所有者

| 环节 | 谁做 | 产出 | 机器可判定吗 |
|---|---|---|---|
| **① 收** | 脚本 `org.mjs` | `goal.md`（argv 逐字，sha256） | ✅ 逐字的唯一保证是不经过模型 |
| **② 扫** | 接待台 | `decisions_seen` 清单 | ⚠️ 靠 prompt，只能事后审计 |
| **③ 问** | 接待台 | `pack-<n>.json` + `deliveries[]` | ✅ `validate-questions` 的 `PACK_*` 错误码 |
| **④ 答** | 用户 → 脚本落盘 | `answers.jsonl`（只追加） | ✅ transcript 里 `tool_use` + `tool_result` 逐条匹配 |
| **⑤ 传** | 接待台切片 → 工头写进 ticket | `ticket.answers_ref` + 注入 prompt 的原文 | ✅ 事后 `question-audit` 追 `Answer → 动作` |

**②是唯一不可机械判定的一环**，这必须明说。问题协议 §9 L2 已经承认「问得对不对无法机械检验」。
本架构不试图解决它，只做一件事：**让「跳过 ②」在事后可见**——
`coverage.decisions_seen` 若与 `annotated` 的扫描痕迹对不上，判 `ZERO_ASK`。

### 3.2 逐字扫描：把「用户不知道自己不知道」变成可执行步骤

「逐字分析」如果只写在 prompt 里，它等于「请仔细一点」。所以给它一张固定的抽取表：

| 抽取 | 用户说「加个导出」 | 必须检查的缺项 | 命中即候选 decision |
|---|---|---|---|
| **名词 / 实体** | 导出 | 导谁、导什么范围、导到哪个载体 | subject=`export-target` |
| **动词 / 动作** | 加 | 新增还是改现有的？旧路径保留吗 | subject=`export-replaces` |
| **量词 / 形容词** | （无） | 多快算快、多大算大 → 换成可观测指标 | subject=`export-size-ceiling` |
| **否定 / 例外** | （无） | 什么情况不该做、谁能看到 | subject=`export-permission` |
| **隐含前提** | 数据在库里 | 数据多新、多一致、有没有权限读 | subject=`export-staleness` |

**这张表就是「主动告知」的入口。** 命中但 `risk ≤ 1` 的，不提问，写进
`coverage.decided_by_guess[].announced = true`——它在用户可见输出里变成一句：

> 你没提导出范围，我按「当前项目全部」做了；这会包含草稿数据。要改说一声。

**「主动告知」不需要新机制，它就是 announced guess。** 这正是问题协议 §1.3.1 已有的字段，
本架构只是把它认领为产品的第一半（用户→不知道自己不知道）。

第二半（AI→不知道用户意图）由 `source` 强制：每条问题必须能指回
`source.verbatim`（用户原话片段）或 `source.ref`（file:line / 规格 §x）。
**说不出出处的问题作废**，并计入 `decisions_dropped`。这是「围绕每一个字」的机械实现——
不是概括，是**逐词建立指针**。

### 3.3 三种权力，三种归属

「谁能拒绝一个问题」在原来的表述里是混的，必须拆成三件事，因为它们的后果完全不同：

| 权力 | 谁能行使 | 必须留下什么 | 不许出现的情形 |
|---|---|---|---|
| **drop**（不值得问） | **只有接待台** | `why_dropped` + 计入算术 | 「问太多所以不问了」 |
| **guess**（直接猜） | **只有接待台**，且 `risk ≤ 1` | `assumed` + `announced: true` | 猜 R2 以上；猜了不声明 |
| **noise 提示**（问了重复的） | **只有脚本**，且**只警告** | `ledger.json` 的 `warnings` | 用它阻止提问（协议 §5.6 已明令：一旦能拦，系统就有动机把问题判成重复） |

**planner 只能 propose，不能 drop。执行者只能 propose，不能问用户。**
这与协议的「子 Agent 只能提议，不能交付」一致，本架构只是给出了物理原因：
**它们的 `tools` 里没有 `AskUserQuestion`。** 不是不让，是没有。

#### 谁判定「问题已答」

**不是人，是脚本。** 这是本架构对问题协议最重要的一次落位：

> `acknowledged` 是**契约字段**（§2.3），所以它的唯一写入者必须是脚本。
> 接待台写 `questions[]`（判断），脚本写 `deliveries[].acknowledged_at`（事实）。

判据（协议 §5.1 三级）：`tool_use` 的 `input.questions[].question` 与包内 `ask`
归一化后逐条匹配 **且** 有对应 `tool_result` **且** 拿到时间戳。
缺任一条即 `delivered`（不算已问），包状态 `partially_answered`。

**一条推论**：如果接待台有 `Write` 到 `pack.json` 的权限，它就能伪造 `acknowledged_at`。
所以 `PACK_HANDWRITTEN`（协议 §7.1 第 3 条）不是一条风格检查，是**防伪造**。
本架构把这条升级为不变量 W 的一个实例。

### 3.4 答案怎么保证传到每个需要它的手下

**不是广播，是切片 + 版本。**

```
answers.jsonl（只追加，脚本写）
      │  每条带 subject / authorization / at
      ▼
ticket.answers_ref = { path, sha256 }
ticket.answers_subjects = ["export-target", "export-permission"]
      │
      ▼
supervisor 派发时，只把 answers_subjects 命中的那几条**原文**注入 prompt
（不注入无关答案，因为无关答案 = 一条用不上的授权，执行者可能会用它）
```

三条规则：

1. **相关答案逐字注入**，不摘要。摘要过的答案无法判断用户到底同意了什么
   （协议 §1.4 的 `raw` 要求，与 `evidence-discipline.md` §1 的「不许转述」同源）。
2. **不相关答案不下发**。这既是省上下文，也是**最小授权**：
   一个不知道「用户允许 push」的执行者，不会去 push。
3. **答案变了要能被发现**。`ticket.answers_ref.sha256` 是派发瞬间的 pin。
   收工时 supervisor 比对当前 `answers.jsonl` 的切片 hash：
   ```js
   if (pinned !== current) report.stale_answer = true;  // 不得直接判过
   ```
   `stale_answer` 的工单，`verdict.json` 必须标 `unknown` 或重派，不许 pass。
   **这是「需求传递」最容易断的地方**：用户改主意了，而旧工单还在按旧答案跑。

### 3.5 传递的证明：可追溯，不是「我发了」

协议 §5.3 的 `question-audit` 在架构里的位置是**收工后的第三条门**：

```
verify-claims:   断言("测试通过") → 找 supporting tool_use → 判四档
question-audit:  动作(push)      → 找 authorizing Answer  → 判三档
```

对每个 `capability_floor ≥ 2` 的动作 `a`，找一条 `answer.at < a.at` 且
`capability ∈ answer.authorization.granted` 的答案。找不到 → `SKIPPED_ASK`。

**这就是「答案传到了每个需要它的手下」的唯一证明**：不是「我下发了」，
而是「用了它的那个动作能追到它」。下发是动作，可追溯是结果；
只验证动作的系统，会在「发了但没送到」时给出绿灯。

---

## 四、外包机制（带别人的手下）

### 4.1 交接契约：给什么、要什么

**给出去的是工单，不是 prompt。** 这是与「spawn 一个 CLI」的全部区别。

```json
{
  "run_id": "2026-11-11-<slug>",
  "ticket": {
    "id": "T-0001",
    "goal": "逐字目标，不转述",
    "shape": "artifact | exploration | hybrid",
    "role": "executor",
    "adapter": "acpx:opencode",
    "capability_gap": "父级不能被派工单，因为它没有 Edit/Bash",
    "boundary": ["只改 README.md 的「已知局限」表", "不碰 docs/spec/",
                 "不 git add/commit/push", "不装依赖"],
    "acceptance": [
      { "id": "AC1", "criterion": "可观测事实",
        "evidence_cmd": "node scripts/count-rows.mjs README.md 已知局限",
        "fail_if": "行数 ≠ 2，或改动了该表以外的内容" }
    ],
    "answers_ref": { "path": "tasks/runs/<id>/questions/answers.jsonl", "sha256": "..." },
    "token_budget_pct": 30,
    "timeout_min": 12,
    "nonce": "a3f2c1d9"
  }
}
```

**要回来的只有三样**：

| 收什么 | 谁写 | 形状 |
|---|---|---|
| `report.json` | **supervisor（脚本）** | 6 字段卡片（§2.4） |
| `report.md` | 执行者 | 自由文本，**只有人能读，不走解析** |
| ACP 流里的 `usage_update` / `stopReason` | 协议 | 逐条数字，用于预算核对 |

**`evidence_cmd` 是本轮对 AC 结构的一处加固**：现有 `templates/acceptance-criteria.md`
的 `evidence` 是「引用形式（如 file:line）」，是**人读的**。改成命令后，
证据由 `gate.mjs` 跑出来（exit code + stdout hash），门禁读的是结果不是承诺。
这直接修掉审计里最重的一条：**`acceptor` 无 `Bash` 却要被判「判定前必须逐条跑」**。

**`nonce` 是专门用来治静默失败的一个字段。** 派发时注入一个随机串，要求在 `report.md`
里回显。原因见 §4.3 的第一档。

### 4.2 能力不一致怎么办：能力矩阵 + 探针，不支持就拒派

ACP 协议层**没有工具白名单字段**（183 个 `$defs` 里查过，`allowedTools` 等均不存在），
`NewSessionRequest` 只有 `cwd` / `additionalDirectories` / `mcpServers` / `systemPrompt` / `_meta`。
所以适配器能力必须**逐个探测并登记**，不能假设：

```js
// scripts/adapters/index.mjs
export const ADAPTERS = {
  'acpx:opencode': { supports: { stream:true, permission:true, usage:true, cancel:true, resume:true } },
  'acpx:claude':   { supports: { stream:true, permission:true, usage:true, cancel:true, resume:true },
                     known_break: 'Windows: zod/v4 ESM 解析失败（本机实测）' },
  'cli:claude -p': { supports: { stream:false, permission:false, usage:false, cancel:false, resume:false },
                     known_break: 'exit 0 + 空 stdout（本机实测 3/3 失败，静默）' },
};
```

三条派发前检查，任一不过就**拒派**（fail-closed，不是尽力而为）：

1. `ticket.boundary` 非空 → 要求 `supports.permission === true`。
   **不支持就别派。** 一条没有物理边界的工单，等于把「不许碰 X」写在 prompt 里（反模式 A1）。
2. `ticket` 需要结构化提问回流 → 要求 `supports.stream === true`（否则拿不到 `elicitation`）。
3. `token_budget_pct` 要能核对 → 要求 `supports.usage === true`，否则预算只能事后惊讶，
   违反 CLAUDE.md 硬约束 8。

**探针（canary）**：每个 `(adapter, version, day)` 第一次派真活之前，先跑一条约 30 秒的
探针工单（「在当前目录建 `canary.txt`，内容为 nonce」），验证四件事：
进程起得来 / 有产物 / nonce 回显 / usage 拿到。**探针不过，这个 run 直接停在规划阶段**，
输出「适配器不可用 + 原因 + 复现命令」。缓存结果，同一天不重复付这个成本。

**为什么必须有探针**：`claude -p` 的实测失败是 **exit 0 + stdout 完全为空**。
一个天真的 dispatcher 会把它判成「成功，只是没说话」——
**这正是我们要治的病，框架自己踩同一个坑是最不该出现的一种。**
探针把「它今天能不能用」变成一个 30 秒的、可复现的二元问题，而不是一次 4 分钟的空等。

### 4.3 失败：六档，互斥，全部落盘

| 档 | 判据 | 动作 | 终态 |
|---|---|---|---|
| `TRANSIENT` | 退出码 ≠0 且 stderr 含 408/429/5xx/连接错误 | 重试 ≤3，退避 15/30/60 秒 | 重试耗尽 → `FAILED` |
| `FAILED` | 退出码 ≠0，其余 | 不重试。同一原因 2 次后**必须换策略**（`state-model.md` §6 L5） | `FAILED` |
| `SILENT` | 退出码 =0，但 **nonce 未回显** 或 `changed_files` 为空 或 stdout 空 | **不重试**，冒泡成 `NEEDS_DECISION` | `UNKNOWN` |
| `TIMEOUT` | 超过 `timeout_min` | 杀进程，记 `killed:true` | `BLOCKED` |
| `STALE` | `answers_ref.sha256` 变了 | 不判过，重派 | `NEEDS_DECISION` |
| `BOUNDARY_BREACH` | 产物落在 `boundary` 外（存在即可检出：`git status` 有越界路径） | **判 fail，不重试**，记进 `dev-findings` | `FAILED` |

**`SILENT` 与 `BOUNDARY_BREACH` 是这一节新增的两档**，此前的四档里没有：

- `SILENT` 是实测出来的必然而不是假设（本机 3/3）。
- `BOUNDARY_BREACH` 是因为「边界」此前只是字符串。有了 worktree + cwd 之后，
  越界**是可检出的**——`git -C <worktree> status` 就是判据。**可检出就必须检出**，
  否则 `boundary` 字段与 prompt 里的「请不要」没有区别（反模式 A1）。

**「不重试」是六档里最重要的共同点**：只有 `TRANSIENT` 重试，其余一律不重试。
理由是 `state-model.md` 已经立过的一条规矩——**同一原因重跑两次还是错**，
再跑第三次不产生新信息，只产生新的账单。

### 4.4 一个反直觉的结论：外包比自建更容易守住边界

这是本架构里唯一「跑出来才发现」的判断，值得单列：

| | native 子 agent | 外部 harness |
|---|---|---|
| 「不许写 docs/」怎么保证 | **没有任何机制**。`tools` 只到工具级，不到路径级；它 `Edit` 什么路径不受限 | **cwd 只挂 worktree** + ACP `session/request_permission` 逐次审批 |
| 「不许跑某命令」怎么保证 | 只能不给 `Bash`；给了就全有 | `request_permission` 可以逐条拒（`options` 里 `reject_once`） |
| 谁能拒绝 | 事后审计 | **运行时否决** |

所以「先专攻带别人的手下」这个顺序，**在架构上有独立理由，不只是优先级**：
外部执行的每一次工具调用都经过我们（client）。而 native 执行时，
我们唯一的杠杆是「给不给那个工具」——粒度粗一个数量级。

**同一面镜像**：这也意味着 native 路线的边界承诺**现在就不成立**，
任何以「executor 有 Bash 但只改指定文件」为前提的设计都是假安全。
`oversight-executor` 的现状就是这样，见 §9。

---

## 五、与「问问题协议」的对接（一张表说清）

| 协议概念 | 在架构里的产生地 | 消费地 | 谁写 |
|---|---|---|---|
| `QuestionPolicy` | 项目根 `question-policy.json`（可发布）+ 运行级覆盖 | 接待台生成包时快照进 `policy` | 人 |
| `QuestionPack` | 接待台，在**第一个 artifact 型 ticket 派发之前**（upfront） | `validate-ticket` 要求引用的包 `state === 'answered'`；supervisor 注入答案 | 接待台（questions/coverage）+ 脚本（deliveries） |
| `Answer` | 宿主 `tool_result` | 切片下发进 ticket；`question-audit` 事后核对 | 脚本，只追加 |
| `coverage` 算术 | 接待台 | `validate-questions` 的 `PACK_ARITHMETIC` | 接待台 |
| `acknowledged` | 脚本判定 | 决定包能不能进 `state: answered` | 脚本 |
| escalation（中途 R3） | 执行者 → `NEEDS_DECISION` → 接待台 | 旧包 `superseded` + 新包 | 接待台 |

**闭环点只有一个**：`validate-ticket.mjs` 拒绝放行任何
「引用了未 answered 的包」的工单。这就是协议 §5.4 的「事前结构门」，
也是「必须问」在公司结构里的物理落点——**不问，就派不出去。**

三处本架构对协议的具体化（不是新增，是落位）：

1. **谁能问用户**：只有 `tools` 里含 `AskUserQuestion` 的进程。v0 里是主线程
   （12 份角色全都不含该工具，所以它们物理上问不了）。
   `[待验证]` 子 Agent 能否调用 `AskUserQuestion`——**这是 T-Q1，v0 必须先测**。
   若可以，则接待台可以下沉成一个角色；若不可以，「主线程兼任接待台」是唯一解。
2. **多手下合并**：v0 只有接待台一个提议者，合并逻辑退化成空。
   **但算术不变量必须照跑**（`decisions_seen = asked + guessed + dropped`）——
   因为只有一个提议者的时候，正是「不问」最容易发生的时候。
3. **外部 harness 的追问必须回流**：ACP 有 `elicitation/create`（agent → client 的结构化追问）。
   它**不能**直接变成给用户的问题，必须被重新 propose：补 `subject` / `source` / `risk`，
   进 `proposed-<subtree>.jsonl`，由接待台合并。
   理由不是礼貌，是**算术**：N 个直连通道会让 `decisions_seen` 无法计数，
   而那条算术是「必须问」唯一的强制机制。

---

## 六、最简可跑的公司（v0）

### 6.1 编队：两个角色、一个外部适配器、三个脚本

**12 个角色里 v0 只用 2 个**（`planner`、`acceptor`），外加一个外部执行者和三个脚本。

```
主线程（L0 接待台 + L1 工头 合并）
   │  工具：AskUserQuestion / Agent / Read     无 Write / 无 Edit / 无 Bash
   ├── planner（native subagent）  ← L1 的「笔」：把契约写成 schema
   │      工具：Read, Write(仅 tasks/runs/**/contracts/), Glob, Grep
   ├── acceptor（native subagent） ← 门禁（旁挂）
   │      工具：Read, Grep, Glob, Write(仅 verdict.json)
   └── executor 岗位 → 物理实现是外部进程
          acpx + opencode（唯一本机实测跑通的组合）
   ────────────────────────────────────
   脚本（不是岗位）：org.mjs / validate-ticket.mjs / gate.mjs / supervisor.mjs
```

**为什么主线程同时当接待台和工头**：v0 的 fan-out 是 1。切工单的判断在只有一张工单时
退化成「写一张工单」，合并两个岗位不损失任何能力，且省掉一层 15× 的成本。

**拆分触发条件（写死，不许「视情况」）**：

- 单次 run 需要 **≥3 张**验收互不依赖的工单 → 工头独立成角色（v1）
- 或 `pack` 数量连续 3 次 run **>1** → 接待台独立（因为它已经忙不过来了）
- 或主线程上下文中卡片数 **>5** → 同理

**这三个条件都是可观测的**（工单数、包数、卡片数都在台账里），不是感觉。

### 6.2 一条链路，精确到每一步的 IO

```
用户：node scripts/org.mjs run "把 README「已知局限」表补两行实测数字"
  │
  ├─[0] org.mjs（脚本）
  │      goal.md ← argv 逐字 + sha256；run_id 由 goal 的 hash 派生（可复现）
  │      ★ 不经过模型，所以「逐字」是被保证的，不是被要求的
  │
  ├─[1] 主线程·接待（逐字扫描 → 问）
  │      输入：goal.md 原文（只这一份）
  │      产出：questions/pack-1.json   { questions[], coverage, policy, deliveries:[] }
  │             ↑ 高 5 条，每条带 options[].consequence / recommended.falsifier / open_entry
  │      交付：AskUserQuestion（≤5 条）→ 脚本回填 deliveries[].acknowledged_at
  │      校验：validate-questions.mjs → PACK_* 错误码；算术必须配平
  │      ★ 用户答完，answers.jsonl 追加（脚本写）
  │
  ├─[2] 主线程·工头（写契约）
  │      派 planner → tasks/runs/<id>/contracts/ticket-1.json
  │      字段：goal(逐字) / shape / role=executor / adapter=acpx:opencode
  │            capability_gap / boundary[] / acceptance[](带 evidence_cmd)
  │            answers_ref{path,sha256} / token_budget_pct / timeout_min / nonce
  │      校验：validate-ticket.mjs
  │            · AC 非空且每条三字段齐 + evidence_cmd 能跑
  │            · 措辞黑名单：质量良好 / 功能正常 / 大致 / 基本 / 尽量 → 拒绝
  │            · answers_ref 指向的包必须是 state=answered
  │            · Σ子预算 ≤ 父预算；capability_gap 非空
  │
  ├─[3] 探针（脚本，每天每适配器一次）
  │      canary 工单 → adapter-ok.json { ok, nonce_echoed, usage_seen }
  │      不过 → 停在规划阶段，输出「适配器不可用 + 复现命令」，exit 2
  │
  ├─[4] supervisor 派发
  │      spawn: acpx opencode --format json     cwd: .tmp-runs/<id>/worktree
  │      prompt = 公共段(templates/dispatch.md) + 工单逐字 + 相关答案原文 + nonce
  │      ★ 易变段（baseline / nonce）放最后——缓存友好
  │
  ├─[5] 收拢（supervisor，脚本）
  │      从 ACP 流只取三件：最后一条 agent_message_chunk / stopReason / usage_update
  │      中间过程（thought / tool_call / plan）→ observation.jsonl，**不进父上下文**
  │      `git -C worktree status` 非空 且 nonce 回显 → 写 report.json
  │      否则 → SILENT → NEEDS_DECISION
  │
  ├─[6] gate.mjs（脚本，跑 AC 的 evidence_cmd）
  │      gate.json = [{ ac_id, cmd, exit_code, stdout_sha256, stdout_head }]
  │      ★ 门禁不再需要 Bash；它读的是「跑过的结果」，不是「跑的能力」
  │
  ├─[7] acceptor（native，干净上下文）
  │      输入：ticket.AC[] + report.json + gate.json + worktree diff
  │      ★ 不给：report.md、cost、上一轮 verdict、任何自我评价
  │      产出：contracts/verdict-1.json
  │            { ticket_id, verdict: pass|fail|unknown,
  │              items:[{ac_id, result, evidence_ref, note}], uncovered:[] }
  │      渲染：verdict.md 由脚本从 JSON 生成（★ 消灭第 11 种模板）
  │
  ├─[8] 不过 → 新工单 ticket-2，AC 用 **引用 + hash** 指向原 AC，附失败理由
  │      最多 1 轮。仍不过 → failure.md，exit 1，不假装通过
  │
  └─[9] org.mjs 汇总（≤10 行，output-format.md 七条硬规则）
         [DONE] run-id
         做了什么 / 证据在哪（verdict.json 路径）/ 花了多少 / 下一步
```

### 6.3 文件 × 唯一写入者（本架构的核心不变量）

| 文件 | **唯一写入者** | 写什么 | 谁能读 |
|---|---|---|---|
| `goal.md` | **脚本**（argv） | 用户原话，逐字 | planner、acceptor |
| `pack-<n>.json` | 接待台（模型） | questions / coverage / policy 快照 | 渲染器、审计 |
| ↳ `deliveries[].acknowledged_at` | **脚本** | 交付事实 | 审计 |
| `answers.jsonl` | **脚本**，只追加 | 用户原话 + 授权 | 切片下发、审计 |
| `ticket-<n>.json` | planner（模型） | 契约 | 校验器、supervisor、acceptor |
| `report.json` | **supervisor（脚本）** | 6 字段卡片 | acceptor、org.mjs |
| `report.md` | 执行者（外部进程） | 自由文本 | **只有人**。无脚本解析 |
| `gate.json` | **gate.mjs（脚本）** | 逐条命令的 exit code + hash | acceptor |
| `verdict.json` | acceptor（模型） | 逐条判定 + uncovered | org.mjs、审计 |
| `*.md` / TUI | **脚本** | 由上面派生 | 人 |

**这张表有三条推论，都是「不臃肿」的来源**：

1. **5 类机器产物**（goal / pack+answers / ticket / report / verdict），gate 是 verdict 的证据。
   加第 6 类 = 拒绝。
2. **`report.md` 是唯一允许自由文本的产物，且没有任何脚本解析它。**
   这解释了现有 12 份角色为什么「10 种模板、零个解析器」还能活这么久：
   **人读的模板不需要解析器，机器读的才需要。** 本架构把两者分开，各归各位。
3. **写契约的四个位置里，三个是脚本。** 判断（模型）只写两处：`questions` 和 `verdict`。
   **公司的判断点只有两个**——「用户到底要什么」和「这活过不过」。其余全是记录。

### 6.4 一周内可跑通的判据（写在前面，不许事后改口）

```
node scripts/org.mjs run "把 README「已知局限」表补两行实测数字"
→ exit 0
→ tasks/runs/<新>/ 下 5 类产物齐全且非空
→ verdict.json 的 items 覆盖 AC 全部条目，每条带 gate.json 的 exit_code
→ 至少一条 Answer 的授权被 question-audit 追到实际动作（AUTHORIZED）
→ 终端 ≤10 行；全程用户只输入了那一行命令，外加回答问题
→ 一次失败运行被完整记录（哪个环节 / 报什么 / 判成哪一档）
```

**这条判据不包含**：多工单、并行、递归、多 harness、自动重试跨 run。
它只证明**结构成立**——这正是「最简可跑」的定义。

---

## 七、演进：v0 → v1 → v2，每次的触发条件

| 版本 | 加什么 | **触发条件**（可观测，不许「到时候再说」） | 不满足就加会怎样 |
|---|---|---|---|
| **v0** | 2 岗位 + 1 外部适配器 + 5 类产物 + upfront 一问 + 门禁 | — | — |
| **v1** | ① 工头独立成角色（depth 2）② 多工单 fan-out（≤3 并发）③ escalation 通道做实 ④ `max_packs_per_run > 1` | ① 单 run 需要 ≥3 张验收互不依赖的工单；② `verdict.items[].result=fail` 且原因是「AC 不可判定」的比例 **>20%**（这个数字从 verdict.json 直接算得出）；③ 连续 3 次 run 出现 `NEEDS_DECISION` 且都是外部 harness 提的 | 没有 ①，多工单时主线程上下文会被卡片淹没；没有 ②，加一层也不会减少误判；没有 ③，`deferred` 策略会退化成「先干了再问」 |
| **v2** | ① 递归（depth 3）② 自建 harness agent 框架 ③ 多 harness 并行 | ① 能写出 `capability_gap` 且 G2 预算算得过（第 3 层预算 < root 的 17%）；② **外包的失败率（含 `SILENT` + `BOUNDARY_BREACH`）无法被适配层收敛**——即连续 10 次 run 里 ≥3 次失败，且原因不在我们这一侧；③ 任务值付得起 15× | 没有 ② 就自建，等于用「别人的 harness 不好用」当理由重写一遍别人的 harness；没有 ③，递归会把钱烧光且无法验证 |

**关于「先外包、后自建」这个顺序，我的判断是：顺序对，但不能串行等。**

用户说的「先专攻带别人的手下，再专注搭建自己的框架」，在**目标**上是对的。
但在**实现**上，这两件事是同一个接口的两面：
「外包」需要的工单 schema、三事件、验收闸，正是「自己的框架」的第一层。

所以正确的表述不是「先做 A 再做 B」，而是：

> **v0 同时交付「能带别人的手下」和「框架的第一个接口」，因为它们共用一份契约。
> 自建 harness 的触发条件不是「外包做完了」，是「外包的失败率无法用适配层收敛」。**

后者是一个可证伪的判据。前者是一个日期。**用日期驱动架构，就会在日期到来时造一个不需要的东西。**

---

## 八、风险

### 8.1 这套架构最可能怎么失败

按**概率 × 后果**排序，不是按严重度：

| # | 失败方式 | 为什么会发生 | 早期信号（可观测） | 缓解 |
|---|---|---|---|---|
| **R1** | **问问题变成新瓶颈，人工介入次数反而上升** | `pack_cap 5 × max_packs 3` = 最多 15 问。用户答到第 8 个就开始糊弄，糊弄的答案比不答更糟（它看起来像授权） | 答完率随问题数下降；`partially_answered` 占比上升 | v0 强制只有一包 ≤5；`USER_BURDEN` 提示；把「人工介入次数」指标从**生产期**扩到**提问期**一起统计 |
| **R2** | **验收闸误判，把一个人拖死** | 架构把「拍板」从人转移到 AC，但 AC 是模型写的。AC 写歪 → 门禁恒 fail → 每张工单都要人来看 | `verdict.items[].result` 连续 fail 且原因同类；`uncovered` 非空率上升 | 「AC 不可判定」必须判 `unknown` 而不是 `fail`；`unknown` 超阈值 → 触发 §7 v1 的 ②（加 critic 在派发前攻击 AC） |
| **R3** | **静默失败被当成成功** | `claude -p` 实测 exit 0 + 空输出。任何「没有产物 = 没事」的判据都会中招 | `SILENT` 档命中数 | nonce + `changed_files` 非空 + 探针；**UNKNOWN 不许静默重试** |
| **R4** | **需求漂移让交付物作废** | 用户改主意，旧工单在跑 | `stale_answer` 标记 | `answers_ref.sha256` pin + 收工比对；stale 不得判 pass |
| **R5** | **边界承诺落空** | ACP 无工具白名单；不支持 `request_permission` 的 harness 上，`boundary` 就是一串字符串 | `BOUNDARY_BREACH` 命中 | 能力矩阵 + 拒派；`git status` 检出越界 |
| **R6** | **主线程的「无 Bash」只是规范** | 宿主决定主线程工具集（ADR-0001） | `question-audit` 发现主线程跑过 mutating 命令 | 只能事后审计。**这一条不许写成「已解决」** |

**R1 是产品级风险，不是技术风险，而且是本架构唯一会否掉整个产品的风险。**
其余五条都会让产品难用，只有 R1 会让产品**比不用更糟**——
因为它把「AI 猜错要返工」换成了「用户被问烦了随手选一个，然后 AI 按错的方向做完了」。
判据是用户选定的那一个：**人工介入次数**。提问期的介入也要计进去，否则这个指标会被自己的设计刷绿。

### 8.2 看起来该有、其实不该有的东西

| # | 看起来该有 | 为什么不该有 |
|---|---|---|
| **X1** | **一个「协调者」agent** | 协调 = 一个脚本 + 一份 schema。一旦把它做成岗位，就必须给它「问下级」的工具，而反模式 A2 说的是：**一旦存在这条路，它就会替下级做决定**。dsh 的选择是主 Session 根本没有能消息 worker 的工具，并用测试钉死 |
| **X2** | **progress 通道** | 10 个系统的通例是「只有完成 / 阻塞 / 需要决策三种事件」。dsh 有 progress 然后显式丢弃。**枚举 vs 过滤**，选枚举 |
| **X3** | **一个「记忆 / 知识库」岗位** | 知识是文件 + 检索，不是判断。按 J1 它不成立 |
| **X4** | **一个「状态记账员」岗位** | 本架构砍掉了它，改为「每个字段有唯一写入者 + 只追加」。**单一写入者不需要记账员** |
| **X5** | **一个「门禁执行者」岗位** | 砍掉，改为 `gate.mjs`。它要做的事是「跑命令拿退出码」，零判断。设成岗位反而必须给它 `Bash`，于是它又能改被验收物 |
| **X6** | **一个「修复者」岗位** | 砍掉，改为「一张新工单，AC 用 hash 引用原 AC」。修法的唯一特殊要求是「不得改验收标准」，而 hash 引用**在结构上**保证了这一点——比 `repair.md:27` 的一句 prompt 强 |
| **X7** | **review / critic / redteam 的日常编队** | `review` 管「好不好」，v0 只需要「过不过」，混进来自毁独立性。`critic` 在 v0 没有拆解图可质疑。`redteam` 保留但**不进生产线**：每周一次攻击框架本身 |
| **X8** | **一个「提问 agent」** | 问题不是某个 agent 生成的，是接待台对用户原话做的逐字扫描 + 下属 propose。加第 13 个角色 = 第 13 种输出模板，而协议 §7.1 明确反对「问题是又一种散文模板」 |
| **X9** | **A2A / 服务发现 / agent 卡** | A2A 面向跨组织的不透明远程服务（HTTP/gRPC/SSE）。我们驱动的是本机子进程，ACP 就是为此设计的 |
| **X10** | **沙箱 / 权限隔离的承诺** | dsh 自己的文档原文：*"These wrappers and directories establish defaults, not a security boundary."* 我们只能承诺「记录它做了什么」，不能承诺「阻止它做什么」。**写进 README，否则会重演「以为能自动接力」的错** |
| **X11** | **多 agent 投票 / 事后合并** | Cognition：*"actions carry implicit decisions, and conflicting decisions carry bad results."* 要多方结论可比，唯一可靠办法是**派发前共享同一份 baseline**，不是事后投票 |
| **X12** | **一个「全能的」主线程** | 反过来也不对：主线程不能有 `Edit`/`Bash`。它一旦能改产物，它就会顺手改，而「顺手改」没有 AC、没有验收、没有门禁 |

---

## 九、砍了什么：对 12 个角色的逐个判决

**这是本文件最该被逐行读的一张表。** 判决依据只有两条：
① 它的产出有没有唯一消费者（M2）；② 它的判断能不能被脚本替代（M4）。

| 角色 | 判决 | 理由 |
|---|---|---|
| `planner` | ✅ **v0 用** | 唯一有机器可校验产物的岗位。但**降级为「笔」**：它不做拆解判断，只把主线程的契约写成 schema。它的 capability 枚举（6 值缺 `repair`）与 `validate-run.mjs`（12 值）冲突，必须先修 |
| `acceptor` | ✅ **v0 用，但改** | 一票否决不可省。**改两处**：① 补 `gate.json` 作为证据来源（它自己不许有 `Bash`）；② `Write` 限定为 `verdict.json` 一个路径（现在是无边界，可覆写被验收物） |
| `executor` | ⚠️ **保留定义、不派** | 它的 `tools` 含 `Edit`+`Bash`，是「有全权的本地进程」，全文零 git 约束。v0 的 worker 是外部进程，不受这份白名单约束。**保留**是因为它定义了 worker 岗位的契约；**不派**是因为它的边界承诺不成立（§4.4） |
| `repair` | ❌ **砍** | 改为「新工单 + AC hash 引用」。原因是它是全批风险最高的一份：有 `Edit`+`Bash` 且被要求「不得改验收标准」，而验收标准就是仓库里的 md 文件——**它握着改掉标准的全部工具**。用 hash 引用把这条从 prompt 约束变成结构约束 |
| `critic` | ❌ **v0 砍，v1 加** | v0 没有拆解图可质疑。**触发条件**：`verdict` 的 fail 里「AC 不可判定」占比 >20% → 让它在**派发前**攻击 AC（不是攻击交付物） |
| `redteam` | ⚠️ **留，但不进生产线** | 每周一次攻击框架本身。**它的 `tools` 缺 `Bash`，被要求「必须实测 ≥3 条」——这个矛盾必须就地修**（要么给 `Bash`，要么删掉「实测」要求） |
| `review` | ❌ **砍** | 管「好不好」，v0 只判「过不过」。加进来会污染独立性（`acceptor.md:25` 明令它不许读锐评分，而 review.md 就在同一目录下，靠 prompt 拦） |
| `research` | ❌ **砍** | v0 的任务不检索外部事实。且它**没有 `## 输入` 节**，被要求「优先实测」却无 `Bash`——两处自相矛盾 |
| `relay` | ❌ **砍** | 服务于「往用户会话发消息」，v0 不做（ADR-0001）。且它唯一允许的输入路径是一条 `node` 命令，它没有 `Bash`——**自我否定的输入契约** |
| `safety` | ❌ **砍** | 只服务于 relay 的红线检查，relay 砍了它就没有输入。且它的红线清单与 `relay-protocol.md` 从 5 类漂移成 8 项 |
| `probe` | ❌ **砍** | 输入是**用户已有会话的 transcript**。v0 观察的是自己派的进程，不需要它 |
| `resolution` | ❌ **砍** | 服务于多 agent 分歧。v0 只有 1 个执行者，没有分歧可裁决 |

**统计：12 → 2 个在编（planner / acceptor），1 个保留定义不派（executor），1 个转为周期性（redteam），8 个砍掉。**

砍掉 8 个不是「先用简单的，以后再补」，而是**其中 5 个（repair / relay / safety / probe / resolution）
在新的边界下永远不该回来**：它们各自服务一个 v0 之后也不会重新出现的场景
（改验收标准、往用户会话注入、多 agent 投票）。

**同时必须承认一句**：这 8 个被砍的角色，在「主线程的 12 种分工」这个旧形态下是成立的，
且有真实产出为证（`docs/research/2026-11-04-notification-system-critique.md` 等）。
**它们不是设计错了，是岗位变了。** 旧形态的本体是「一个会话内部分工」，
新形态的本体是「一个有契约的、可外包的组织」。两者需要的岗位不重叠。

---

## 十、一页纸

```
公司卖什么
  一次不用返工的交付。不卖并行、不卖协作。

结构（3 层 + 2 旁挂）
  L0 接待台  1 人  唯一能问用户；唯一持有问题包；逐字扫描；无 Write/Edit/Bash
  L1 工头    1 人  切工单、写契约、派活、收卡片；无 Edit/Bash
  L2 执行者  每工单 1 个  只干；可以是外部进程
  旁挂 门禁  每工单 1 人  不在汇报线上；一票否决；无 Edit/Bash/Agent
  旁挂 记账  不是岗位，是 3 个脚本 + 5 类文件

主 agent 与手下的唯一区别
  它写的东西是「判据」还是「产物」。
  不变量 W：没有岗位同时拥有 product 和 contract 两种写权限。
  强制力三级：native 子 agent = 物理；外部 harness = 协议；主线程 = 审计（诚实地说，它是弱的）。

递归靠三道闸，不靠数字
  G1 工具可达性（物理）· G2 预算单调递减（算术，唯一真正封死的）· G3 capability_gap（语义）
  结构上限 3 层；v0 单次 run 的深度 = 1。深度是派发的属性，不是公司的属性。

问题怎么流动
  收（脚本逐字）→ 扫（逐字抽取表，五类缺项）→ 问（接待台，upfront ≤5）
  → 答（脚本判 acknowledged，接待台不许自己宣布）→ 传（按 subject 切片 + sha256 pin）
  三种权力分开：drop / guess 只归接待台且必须记账；噪声提示只归脚本且只警告。
  传递的证明不是「我下发了」，是「用了它的那个动作能追到它」。

外包
  给工单不给 prompt；要回来只有 6 字段卡片 + 指针。
  能力矩阵 + 30 秒探针；能力不匹配就拒派，不是尽力而为。
  失败六档，只有 TRANSIENT 重试。SILENT（exit 0 但 nonce 没回显）是最危险的档。
  反直觉结论：外包比自建更容易守住边界，因为 request_permission 是运行时的否决权。

不臃肿的六个机制
  M1 产物闭集（5 类）· M2 每岗有被消费的边 · M3 同一 schema 唯一作者
  M4 能用脚本判的不设岗位 · M5 预算递减 + 编队声明 · M6 tools 必填且合法

v0（一周）
  主线程(L0+L1) + planner + acceptor + acpx:opencode + 4 个脚本
  用户一人一句 → 一包问题 → 一张工单 → 一个外部进程 → 一次验收 → 十行汇总

砍掉了什么
  12 个角色 → 在编 2 个。砍 8 个（其中 5 个永远不该回来），
  另外三个设想中的岗位（协调者 / 记账员 / 门禁执行者）全部改成脚本。

最可能怎么失败
  不是技术失败。是「问得太多，用户随手选一个」——那时人工介入次数反而上升。
```

**如果只从这份文件里记住一句话**：

> **层级不是人数的概念，是契约嵌套的概念。**
> 一个人能派活，是因为他能写一张工单；一张工单有资格被派，是因为它带着预声明的 AC 和引用了已答的问题包。
> 没有这两样，他派出去的只是一段 prompt，不是一条工单。
