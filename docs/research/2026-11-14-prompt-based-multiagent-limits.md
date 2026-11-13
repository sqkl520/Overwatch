# 提示词式多 Agent 的极限：拆解「不够原生」到底指什么

- 日期：2026-11-14
- 角色：分析 Agent N1
- 产出形态：**exploration**（根因分析，零行代码改动）
- 材料：外部只读目录 `many-agents_multi-prompt-files_token-heavy/`，下称 `<TOKEN-HEAVY>`；
  其中的框架目录下称 `<FW>`（`<TOKEN-HEAVY>/multi-agent-audit-framework/`）。
  **未修改该目录任何文件，未碰 git。**
- 方法：读 `README.md` / `START-HERE.md` / `framework/` 全部 24 份 md（9,312 行）/
  `experiments/` 29 份记录 / `docs/analysis/` 31 份诊断 / `<TOKEN-HEAVY>/audit-runs/` 的实跑观察与
  「13 份锐评」材料；与 Overwatch 自己的实测记录对账。
- **诚实边界**：我**没有重跑**任何数字。凡本文引用「47 分钟」「22/80」「99.9% 等」，
  都是原文自己的实测值，我核对的是**它在原文哪个文件哪一行**，不是它真不真。
  标 `[未复核]` 的条目尤其需要主线程或验收 Agent 复算。

---

## 0. 结论先行

**1. 「不够原生」最核心的一条：谁持有计划。**
提示词方案里，「计划」是主 Agent 上下文里的一段**自述**；运行时既不持有它，也无法校验它。
于是所有控制机制只能写成「要求模型自觉遵守」的散文，所有运行时事实只能**事后从副作用反推**。
原生方案的差别不是「有 API」，是**计划变成运行时的数据结构**（脚本变量 / 调度器状态），
控制因此是强制的、事实因此是直接的。这个框架的 `protocol.md` §0.0 与官方
`workflows.md` 的对比表逐字说的是同一件事：「谁决定下一步跑什么」——
`Claude, turn by turn` vs `The script`（引文见 `<FW>/framework/orchestrator/protocol.md:60-66`）。

**2. 由此派生三条结构性代价，不是写法问题，改写措辞修不掉：**

| 代价 | 机制 | 实测后果 |
|---|---|---|
| **状态只能靠代理指标** | 运行时不给「这个 agent 在跑吗、到终态了吗」，主 Agent 只能看 mtime / 转录大小 / 自己维护的 `in_flight` 数组 | 按 8 分钟阈值会杀掉 12 个正常 agent 中的 9 个（47 分钟才是常态）；22/80 个 agent 转录恒 0 字节但实际在工作 |
| **契约只能靠提示词** | 没有 schema 强制执行，返回信封是否合规靠模型自律 | 15 个真实产物 **0 个**含 JSON 信封；40 份产物只有 **9 份**可被 grep 解析 |
| **主 Agent 上下文即总线** | 子级结果、账本、计划全从同一个上下文窗口进出 | 200 个 agent × 每份 500 token 摘要 = **10 万 token 起步**，还没算框架文档本身 |

**3. 这个项目自己已经算出了这个结论。**
它统计出框架 6,113 行里 **2,809 行（47%）**在做并发/状态/重试/契约，而 harness 原生提供且更精确；
原话是「**这不是简化版，是更差的版本**」（`<FW>/docs/analysis/2026-11-09-harness-first-pivot.md:111`、`:126`）。
换句话说：**47% 的体量是「为了在没有原生机制的环境里模拟原生机制」而付出的成本**——
这正是「不够原生」的可量化定义。

**4. 该原生的只有控制面；判断面必须留在提示词层，而且那是唯一值钱的一半。**
必须原生：派发/并发、终态与活性、结构化返回、token 与耗时计量、权限闸、深度与预算的**强制**。
提示词够用：审什么、什么算证据、什么结论不成立、报告长什么样、角色如何分工、任务书的停机条件。
同一次统计里「判断类」占 **2,752 行（46%）**，harness 永远无法替代（同上 `:113`）。

**5. 用现有 Claude Code 原语能补掉 11 个维度里的约 7 个（按后果加权约 6.5/11）。**
`Workflow`（脚本持有计划）+ `Stop`/`PreToolUse`/`SubagentStop` hooks + `subagents/*.jsonl` 与
`.meta.json`（`toolUseId`/`spawnDepth`）+ `usage` 计量，合起来能覆盖控制面的绝大部分。
补不掉的四条是硬的：**跨会话持久状态、运行中注入、子→父的投递语义、深度/预算的强制**。

---

## 1. 它现在是怎么运作的（事实部分）

### 1.1 主 Agent 怎么「指挥」

不是有调度 API，而是**读操作规程 → 自己决定 → 用 Agent 工具派 → 从「返回值 + 产物文件」取结果**。

```
主 Agent（同一个对话）：
  ① 读 protocol.md / scale-mapping.md / run-state.md（常驻 2,641 行，见 §1.3）
  ② 按查表规则算出该派几个（唯一一次算术，protocol.md:109-144）
  ③ 用 Agent 工具逐轮派发，每个子 Agent 拼一段 system prompt
  ④ 收返回值，按 output-contract 校验（其实是主 Agent 自己人肉校验）
  ⑤ 写 state.json，回到 ③
```

关键点：**①④⑤ 全部发生在主 Agent 的上下文里**。所以「调度」不是一段程序在跑，
是模型每一轮**重新履行一遍规程**。`protocol.md:433-437` 把这个机制写得最清楚：

> ```
> Agent 循环的退出条件 = "本轮回复里没有 tool call"
> 「汇报进度」天然没有 tool call
> → 汇报就等于交差
> ```

这条不是模型的性格问题，是 agent 循环的机械属性。框架为它写了 §0.8（交付粒度）、
`stop-hook.mjs`、`lint-autonomy.mjs` 五条静态规则——**全是在提示词与静态检查这一侧补一个只能由
运行时提供的性质**。

### 1.2 文件扮演什么角色

| 文件 | 真实角色 | 它想代替的原生机制 |
|---|---|---|
| `README.md` / `START-HERE.md` | 安装说明 + 粘贴块。**「安装」= 复制一段话**（`START-HERE.md:21-62`） | 插件/入口点注册 |
| `orchestrator/protocol.md`（1,241 行） | 调度程序。门控、重派、裁量分级、账本、并发护栏全在里面 | 调度器代码 |
| `orchestrator/scale-mapping.md`（369 行） | 查表 + 算术：N 片 → 派几个、并发窗口多少 | 队列与并发控制器 |
| `orchestrator/environment-probe.md` | 能力探测**协议**（先问用户四个问题） | 能力协商（初始化的 `capabilities` 交换） |
| `artifacts/run-state.md`（630 行） | 状态机 + `state.json` schema + 断点续跑协议 | 运行时 journal / 任务表 |
| `components/output-contract.md`（702 行） | 子 Agent 的返回 schema（六角色） | 工具参数 schema（强校验） |
| `templates/wave*.md`（共 2,300+ 行） | 每个角色的行为规则 | agent 的 system prompt（这一项本来就是提示词该管的事） |
| `wrappers/*.md` | 身份 + 触发 + `tools` 白名单 | subagent 定义（**这一项是原生的**） |
| `state.json` | 「唯一事实来源」的落盘账本 | 运行时状态（它只是投影） |
| `PLAN.md`（`<TOKEN-HEAVY>/audit-runs/PLAN.md`） | 一次 6-agent 汇总裁决的人工记录 | 计划的持久化 |
| `expert-*.md` | 各专业视角的**提示词草稿**（成本/设计/红队/证据/冲突） | 角色定义（半个原生） |

注意最后一列的分布：**只有 `wrappers/*.md` 的 frontmatter 和 `tools` 是 harness 真认识的**，
其余 frontmatter 字段（`template`/`requires`/`wave`/`trigger_event`/`role`）
框架自己承认「harness 不认识，读者是主 Agent 和人工」（`<FW>/framework/PORTABILITY.md:12-15`）。

### 1.3 常驻加载量：一个可量化的「不原生」税

主 Agent 全程常驻 `protocol.md`(1,241) + `scale-mapping.md`(369) + `run-state.md`(630) +
`final-report.md`(401) = **2,641 行**，外加各模板的触发摘要。这是一个**每回合都要重读**的规程。
原生方案里，同等语义由运行时持有，模型上下文里只有「当前任务」和「结果」。

### 1.4 结果怎么汇总回来

设计上是三段：

```
子 Agent → 写产物文件（artifact_path）+ 返回 JSON 信封（payload）
        → 主 Agent 只读信封（不读正文），把 artifact_path 记进 state.json
        → 最终报告只做「路径拼接 + 排序 + 统计」，不重写内容（protocol.md:948）
```

实践上是四段破损（全部有实测记录）：

| 破损 | 证据 |
|---|---|
| 子 Agent 根本不写信封 | 15 个真实产物 **0 个**含 JSON 信封，下游写了 73 行 `salvageFromMarkdown()` 去猜（`<FW>/framework/wrappers/recon-scout.md:67-69`） |
| 产物大多不可机器解析 | 40 份产物只有 **9 份**可被 grep 命中（`<FW>/docs/analysis/2026-11-01-structural-diagnosis.md:137`） |
| 账本少记一半 | 实际 ≥47 个实例，`budget.spawned_by_wave` 只记 **22**（同上 `:31-32`、`:87-89`） |
| 门控全部在场但没有一个真的拦住了东西 | 同上的原话（`:36`） |

一句话概括 §1：**它不是「编排器 + worker」，是「一份很长的操作规程 + 一个必须每回合重新读规程的模型」。**

---

## 2. 逐维度对比

### 2.1 主表

| # | 维度 | 提示词方案怎么做 | 原生应该是什么 | 差距导致的后果（证据） | 必须原生？ |
|---|---|---|---|---|---|
| 1 | **派发**（谁决定下一步） | 主 Agent 每回合读 `scale-mapping` 查表，自己决定派谁、派几个（`protocol.md:109-144`）；「派发」= 一次 Agent 工具调用 | 脚本/调度器持有循环与分支（`workflows.md` 官方对比表：`The script` vs `Claude, turn by turn`） | ① 每回合都要重新履行规程，规程 2,641 行常驻；② 「派完就汇报」= 回合结束，需要 `stop-hook.mjs` 才能拉回（`protocol.md:583-590`）；③ 主 Agent 需要「看一眼」时裁量不可避免，round31 出现 9/40 维度偏离且未申报（`structural-diagnosis.md:98-104`） | **分半**：派发的**执行**必须原生；派发的**内容**（谁该审什么）提示词够用 |
| 2 | **状态**（在跑吗/到终态了吗） | 主 Agent 自己维护 `in_flight` 数组 + `slices[].state`，落盘 `state.json`；活性判据是产物文件存在与否 | 运行时给每个 task 一个可查询的终态；journal 由运行时写 | ① **误杀**：8 分钟阈值杀掉 12 个正常 agent 中的 9 个，实测常态 47 分钟（`environment-probe.md:79-83`、`harness-first-pivot.md:26-29`）[未复核]；② **假活**：主 Agent 连续 35 分钟说「还在跑」，产物 22:39 就写完了，因为它盯的是转录大小（`FAILURE-MODES.md:24-26`）；③ **假死**：22/80 个 agent 转录恒 0 字节，实际都在干活（`FAILURE-MODES.md:50-52`）；④ 账本自己忘了更新，判断就一直错（`protocol.md:506`） | **必须原生**。这是所有后果里最贵的一条 |
| 3 | **并行**（并发控制） | 「同一条消息里发多个 Agent 工具调用」；上限靠 `min(8, harness_cap)` 查表 + 「不得自行提高」的禁令 | 运行时并发批次，有自己的上限与背压 | ① 上限写死过 4/8，实测默认是 16(workflow)/20(subagent)、可调 256（`environment-probe.md:86-90`）——**框架从来没有能力知道自己超没超**；② 并发是「上限不是目标」（`scale-mapping.md:202`），与用户要的「≥5 专家」语义相反，需要拆成两个字段（`<TOKEN-HEAVY>/audit-runs/plan-decomposition.md` C8）；③ 排队派发由主 Agent 手工 FIFO，中途失败只能靠人重算 | **必须原生**（数量本身），提示词只该声明「要几个」 |
| 4 | **上下文**（消息传递） | 子级 → 写文件 → 父级读文件路径 + 信封；波次间用 Resume Packet（`handoff-schema.md`，只带指针与摘要） | 编排层变量持有中间结果，父上下文只有最终答案（官方：「Intermediate results stay in script variables」） | ① 主 Agent 上下文是唯一总线，200 agent × 500 token = 10 万 token 起（`compatibility.md:151-155`）；② 第 k 个 agent 的 prompt 一定被前 k−1 个结论锚定，**无法「忘记」**（`compatibility.md:78-85`）；③ 串行降级时「独立分析」物理上不可能，框架只能要求「诚实声明」（`compatibility.md:87-95`） | **必须原生**（隔离与传递机制）；「摘要该写什么」提示词够用 |
| 5 | **递归**（嵌套派生） | 提示词里写「允许递归，深度 ≤3」，`triage.md` 给了 9×5×5×5=1125 的理论值 | 运行时按 depth 派发，父子关系在运行时结构里 | ① **结构上做不到**：7 个 wrapper 的 `tools` 全是 `Read, Grep, Glob, Bash, Write`（+`Edit`），**没有一个含 `Agent`**，所以子 Agent 无法再派（`<FW>/framework/wrappers/*.md:4`；`plan-decomposition.md` C10 第②点核实过）；② 账本是**扁平一维数组**，孙 Agent 无处登记 → 失败率分母失真（`plan-decomposition.md` C10 第③点、§补充）；③ 产物命名 `round{N}-{wave}-{slice}.md` 不含 depth，递归必撞名（同 C10 第④点）；④ 1125 这个数只是提示词里的算术，没有机制保证任何一层 | **必须原生**。提示词连「能不能派」都决定不了 |
| 6 | **终止**（生命周期） | 靠「所有实例进入终态」的布尔门控 + 人工判断「算不算跑完」；写了 `stop-hook.mjs` 在回合结束时拦 | 运行时报告终态；无终态即无完成 | ① **死锁**：门控要求全 `SUCCESS` 而 `PERMANENT_FAILURE` 合法且禁止重派 → 门永远打不开 → round31 停在 `IN_PROGRESS` 且**没有最终报告**（`protocol.md:965-986`、`structural-diagnosis.md:106-110`）；② 反向死锁：「任何报错都全量重跑」会把这条死锁原样请回（`plan-decomposition.md` §4 错误点 1）；③ 「汇报即交差」需要 hook 才能挡住（`protocol.md:428-450`） | **必须原生**（终态由运行时给）；「什么算合格」提示词够用 |
| 7 | **错误**（传播与归因） | 子 Agent 自己填 `status` 四种终态，主 Agent 自己分类（`classify-failures.mjs` 是**事后**的分类器） | 运行时传播失败（stall retry、`null` 占位、可 await 的错） | ① 失败名本身带着错误推断：`SCRIPT_TIMEOUT` 暗示超时，实测更多是「还没写完」（`harness-first-pivot.md:70-84`）；② 「父级没意识到子级已产出」不是偶发 bug：dsh 实测 `subagent` 返回 `"started subagent <id>"`，结论走另一条 `subagent-settled` 注入到父级**下一轮**（`<FW>/framework/orchestrator/protocol.md:516-548`、`experiments/dsh-probe/DSH-EXPERIMENT.md:93-107`）；③ 「一个子问题失败」与「整轮失败」的区别只能靠散文规定 | **必须原生**（失败语义与传播）；「怎么补救」提示词够用 |
| 8 | **结构化输出**（契约） | `output-contract.md` 702 行 schema + 「禁止宽容解析」的禁令 + 一个自建校验器 | 工具参数 schema / structured output，不合法就调用失败 | ① 0/15 产物含信封（`recon-scout.md:67-69`）；② 下游为它写 73 行「从散文里捞 JSON」的补丁，框架自己承认「是补丁，不是护栏」；③ 契约里写了「一律视为违规」的 19 条里，校验器实测有 **3 条从来没执行**（`CONTRACT-PROBE.md:10-20`）——**「写了规则」和「规则被执行」之间隔着一整个人工实现的第三层** | **必须原生**（强 schema）；「字段语义」提示词够用 |
| 9 | **度量**（token/耗时/成本） | 完全没有：原设计里没有这两个维度 | 运行时给每 agent 的 token、耗时、模型 | ① 改用 mtime 推测耗时，「会骗人」（`harness-first-pivot.md:31-35`）；② 直到 2026-11-09 才知道单 agent 常态是 47 分钟（此前按 8–10 分钟设计）；③ 「什么任务用什么模型」至今没有规则（`START-HERE.md:185`） | **必须原生**。提示词无法计量自己 |
| 10 | **隔离与权限**（写权限闸） | `tools` 白名单（**这一层是原生的**）+ 零写入原则 586 行散文 + 报告末尾贴 `git status` 自证 | 运行时权限闸（allow/deny 由宿主执行） | ① 5 个只读 wrapper 全都带 `Bash`，技术上完全能 `git commit`/`rm`，框架只能写「不得」（`structural-diagnosis.md:44-51`）；② 路径含空格 → 工具调用被权限系统静默拒绝 → agent 不报错继续分析直到超时（`report-naming.md` §5.2，事故：42 分钟产物一次都没写成功）[未复核] | **必须原生**（闸本身）；「哪些路径不许写」提示词够用 |
| 11 | **预算/深度护栏的强制** | `total_budget=60`/`max_rounds=5` 写在提示词里，靠主 Agent 自觉不超 | 运行时硬上限 + 触顶时的确定性降级 | ① 60 这个数**原本是用来代替 token 计量的**（`scale-mapping.md:56` 自认「从未计量 token」）；② 递归 3 层 × 扇出 5 → 理论上千，机制上没有任何拦截；③ 触达 harness 的 1,000 agent/run 时框架**没有任何分支**，会被当普通失败处理（`plan-decomposition.md` §4 错误点 2） | **必须原生**（硬上限）；「预算怎么分」提示词够用 |

### 2.2 一句话读这张表

- **1/3/4/5/6/7/8/9/11 这 9 行的「机制」列，提示词方案都是「要求模型自觉遵守」。**
  这就是「不够原生」的准确含义——**不是不能用，是每一条都要靠一个额外机制去补，而补出来的机制本身又要靠提示词维护**。
- **10 行的 `tools` 白名单是唯一一处「提示词方案也用上了原生机制」的地方**，效果立竿见影
  （子 Agent 拿不到写权限就真的写不了）。这是最好的反证：**凡是交给运行时的，就没再出过事**。
- 第 2 行（状态）是**后果最贵**的一条：它同时污染「要不要重派」「覆盖率是多少」「这一轮算不算跑完」三个判断。

---

## 3. 失败案例：从实践记录里找的结构性证据

### 3.1 误杀：一个比真实值小一个数量级的阈值

| 我定的规则 | 真实常态 | 差距 | 后果 |
|---|---|---|---|
| 「8 分钟无更新即重派」 | 47 分钟 | 6 倍 | 按该阈值，截图里 12 个 agent 有 **9 个会被杀，而它们全在正常工作** |
| 「10 分钟无输出即 `TaskStop`」 | 47 分钟 | 5 倍 | 4 个 agent 被终止，2 个被记成 `SCRIPT_TIMEOUT`，据此写出「宽扫失败率 25%」 |

出处：`<FW>/docs/analysis/2026-11-09-harness-first-pivot.md:22-45`；`<FW>/framework/orchestrator/environment-probe.md:96`
（原话：「**永远不要发明一个比 harness 更小的超时值**」）。

**为什么这是结构性的**：提示词方案里，主 Agent 拿不到「它还在跑吗」，只能自己发明一个代理指标。
**代理指标选错不是能力问题，是没有别的可用指标**。改规则只是换一个代理指标，
下一个还会错（框架后来确实又错了：改用「转录大小」，`FAILURE-MODES.md:24-26`）。

### 3.2 唯一的 A 级活性证据是破坏性的

> `TaskStop` 返回 `Successfully stopped task: a784...` —— 这是**第一次拿到 A 级证据**：
> 它证明该 agent **确实在运行**。反过来，`TaskStop` 对 A2 返回 `No task found with ID` —— 也证明它**已经不存在**。
> **这条之前我没有办法判断。** `ListAgents` 只列对等会话，不列子 Agent；进程表里 25 个 `claude.exe`
> 的启动时间都不匹配；输出文件 mtime 又分不清「卡住」和「正在长时间思考」。

出处：`<TOKEN-HEAVY>/audit-runs/round1-web-style/RUN-OBSERVATIONS.md:38-43`。

这是全篇最锋利的一条证据：**探测即终止**。一个观测者要判断「你还活着吗」，只能杀掉它看有没有反应。
任何原生运行时都不可能把活性查询做成破坏性操作。

### 3.3 契约退化成散文（并且校验器也没执行）

| 事实 | 数值 | 出处 |
|---|---|---|
| 真实产物含 JSON 信封的 | **0 / 15** | `recon-scout.md:67-69` |
| 40 份产物里可被 grep 解析的 | **9 / 40** | `structural-diagnosis.md:137` |
| 契约里写着「一律视为 `CONTRACT_VIOLATION`」的判据 | **19 条** | `CONTRACT-PROBE.md:1-20` |
| 其中校验器实测**从未执行**的 | **3 条** | 同上 `:10-20` |

结论不是「作者写得不好」，而是：**「规则存在」与「规则生效」之间隔着一整个人工实现的第三层**。
原生 schema 校验里这一层是零成本的（不合法就调用失败），提示词方案里它是一整个 `check-payload.mjs`
（39,899 字节）+ 77 条自测。

### 3.4 任务书的停机条件：完成率由「有没有终点」决定，不由模型能力决定

| | 宽任务（slice-16） | 窄任务（S04 变量对账） |
|---|---|---|
| 任务书 | 「扫 6 个维度、两个 970 行文件、12 分钟内返回」 | 「只跑一条 grep，记录命中行，不做推断，5 分钟返回」 |
| 最终产物 | 9 分钟后仍是 **75 字节骨架** | **5 分 25 秒完成，7,138 字节** |
| 工具调用数 | 大量只读分析 + 自我推翻线索 | **3 次** |

出处：`<FW>/framework/templates/wave2a-sweep.md:384-401`；原话：「**差异不在模型能力，在任务是否有明确的停机条件**」
（`:397`）。另有整批证据：「要求『贴 grep 输出』的 6 个切片全部完成，要求『扫 6 个维度』的宽任务 3 次全部超时」（`:442`）。

**这条属于「提示词够用」的正面证据**：配额、固定命令、不做清单——都不需要原生机制，
但它们必须是**派发时写进任务书的**，而不是写在框架文档里「希望模型遵守」。
框架把它写成了硬规则（`wave2a-sweep.md:405-411`），但 `START-HERE.md:181` 自己也承认
「**尚未用宽任务验证它真能提完成率**」。

### 3.5 父级看不到子级：不是疏忽，是返回值语义

dsh `0.2.1-rc.2` 实测（`<FW>/experiments/dsh-probe/DSH-EXPERIMENT.md:93-107`）：

```
tool result:  "started subagent 82757119-..."
```

真正的结论走另一条路——`agent/inbox/spliced` 事件以 `subagent-settled` 形式注入父级**下一轮**。
而 dsh 自己的子 Agent 提示词明写了这件事（同文 `:124-128`）：

> The parent shares your workspace but **does not automatically receive your transcript,
> tool output, or reasoning.**

**这条直接否掉了「再加一句提示词就能让父级看到子级产出」的想法**：返回值语义就是「已启动」。
框架的补救是写一个检查器（`dsh-session-audit.mjs`，12 用例），并在真实数据上跑出
**9 个 session 里 4 个「开了 turn 却零 assistant 消息」**（`START-HERE.md:189`）[未复核]。
**检测到了，但改不了语义**——这就是「补丁」与「机制」的差别。

### 3.6 递归：提示词里写了 1125，机制上是 0

- 7 个 wrapper 的 `tools` 全部不含 `Agent` → 子 Agent **结构上无法**再派（`<FW>/framework/wrappers/*.md:4`）
- 账本 `ledger.agents` 是一维数组，`total_agent_count` 是单计数器 → 孙 Agent 无处登记（`plan-decomposition.md` C10）
- `state.json` 的 `phase` 枚举是闭集且没有 `plan` 相位 → 「先由规划 Agent 拆解」在状态机里没有合法落点（同文 C11/C12）

**注意 `triage.md` 的写法**：它把 1125 当「目标」而不是上限，还写「这不是『上限』，是『目标』」
（`<FW>/framework/orchestrator/triage.md:124-126`）。**一个提示词文件在许诺一个它无法交付的能力。**
这是「不够原生」最容易被误读成「写得不够狠」的地方。

### 3.7 并行不是增益：多派 agent 主要在对抗随机遗漏

| 指标 | 实测 | 随机基线 | 倍数 |
|---|---|---|---|
| 4 个同提示词 agent 两两 Jaccard | 0.742 | 0.598 | **1.25×** |
| 9/18 条缺陷被 4/4 全中 | 9 条 | 5.56 条 | 1.6× |

更重要的是这两条（`<FW>/experiments/AGENT-CONSISTENCY.md:152-170`）：

> **并集只比最好的单个 agent 多 1 条。** 四个 agent 合起来几乎没超过最好的那个。
> **没有哪个 agent 找到别人完全找不到的独特东西**——最多是「有人漏了某条，别人补上」。
> 这说明分歧的来源是**覆盖遗漏**，不是**视角差异**。

加上另一份记录：多 agent 与单遍对「原生型缺陷」的检出都是 **0%**（`<FW>/experiments/STATUS.md:142-148`）。

**结构性含义**：提示词方案的分工是「同一份代码多派几个」，产出的是**并集**，边际收益递减。
真正需要「不同视角」时的做法是**分工不同**（检索/执行/批判/红队/验证），而这需要的是
**角色与波次的映射**——一项判断，提示词够用（`plan-decomposition.md` C9 的方案 (b)）。
**所以「多 agent」本身不需要原生，「多 agent 的调度」才需要。**

### 3.8 控制面没有事务语义：三次运维事故

| 事故 | 事实 | 出处 |
|---|---|---|
| 实验数据丢失 | `audit-out` 目录被重建，五轮实验原始数据归零；「我没有执行过任何删除命令」 | `<FW>/experiments/DATA-LOSS.md:26-36` |
| 泄题两次 | 答案表 `manifest.json` 与被审目录同树；E/F 两组作废 | `<FW>/experiments/LEAK-INCIDENT.md:33-35` |
| `git checkout` 误删 | 有未提交改动时 `git checkout -- framework/wrappers/` 等同删除，5 个文件内容丢失，无法恢复 | `<FW>/experiments/CHECKOUT-INCIDENT.md:1-21` |

这三条与多 agent 无关，但它们暴露同一个东西：**提示词方案里没有任何一处有「事务」**。
原生的编排层至少有 journal（`workflows.md` 的「resume after a pause」靠 per-agent 结果缓存），
而提示词方案的回滚是「记得先备份」——一条写在文档里的道德要求。

### 3.9 证据边界（必须写明）

`experiments/AB-P2-report.md`、`AB-P3-report.md`、`AB-RUNTIME-report.md`、`AB-PATTERNS-report.md`
是**审计质量的消融实验**（召回率/误报），**不是编排证据**。它们证明的是
「模式 1/2/3 清单能把原生型缺陷召回从 35.7% 提到 66.7%」（`ABLATION.md:86`），
与「提示词式编排够不够原生」是两件事。本文没有把它们当编排证据用。

---

## 4. 用现有 Claude Code 原语能补多少

### 4.1 可用的原语（含本机/官方出处）

| 原语 | 已知事实 | 出处 |
|---|---|---|
| `Agent` 工具（subagent） | 可派子 Agent；宿主默认嵌套 **3 层**；每条实例新上下文，只有最终消息回父级 | `docs/spec/dispatch-contract.md:92-96`；官方对比表转录见 `<FW>/audit-runs/research-workflow-vs-agent.md:94-117` |
| 深度实测 | 外部 session 给 `tools:['Agent']` 能到**深度 2**；本机语料有 `spawnDepth` 2（128 个）、3（4 个），父子可对上 | `docs/design/2026-11-11-agent-framework-v2.md` P21；`docs/spec/state-model.md:255-260` |
| `Workflow` 工具 | 脚本持有计划与中间结果；默认 16 并发（1–256 可调）、单 run 1,000 agent、`parallel()` ≤4,096 项、25 agent / 1.5M token 告警、`maxBudgetUsd` 硬上限、逐 stage 指定 model、native stall retry 5 次 | `docs/FACTS.md:425`（23 工具含 `Workflow`）；转录 `<FW>/audit-runs/research-workflow-vs-agent.md:147-159`、`:299-326`、`:283-297` |
| `Stop` hook | `{"decision":"block"}` 有效；**`exit 2` 实测不拦**（2.1.289 / 2.1.308 两次） | `docs/research/2026-11-12-stop-hook-prototype.md:21`、`:104-113` |
| `PreToolUse` hook | `deny` 能拦 `Write`，也能拦 `PowerShell` 旁路；**拒绝循环宿主无上限（实测连拒 69 次）**，须自带 `continue:false` | `docs/research/2026-11-14-pretooluse-desktop-verification.md:40-43` |
| `SubagentStart` / `SubagentStop` | 提供 `agent_id` / `agent_type` / **`agent_transcript_path`** / `last_assistant_message` | `docs/research/2026-11-11-untapped-capabilities.md:303-305` |
| `subagents/agent-<id>.jsonl` + `.meta.json` | meta 含 `toolUseId`、`spawnDepth`、`agentType`；本机 5,044 个子 agent transcript | 同上 `:299-301`；`docs/spec/state-model.md:255-260` |
| 用量与事件 | 每轮 `message.usage`；OTel 的 `subagent_completed` / `hook_execution_complete` / `api_retry_exhausted` | `docs/research/2026-11-11-untapped-capabilities.md:56`、`:326-334` |
| `isolation: worktree` | subagent 可独立 git checkout | 转录 `<FW>/audit-runs/research-workflow-vs-agent.md:130-133` |

### 4.2 覆盖表：11 个维度里能补几个

| # | 维度 | 用现有原语能补？ | 靠什么 | 剩余缺口 |
|---|---|---|---|---|
| 1 | 派发 | ✅ **能** | `Workflow` 脚本（`pipeline()`/`parallel()`）；计划从「提示词」变成「脚本」 | 哪些任务该派、派几个——仍是判断，留在框架 |
| 2 | 状态 | 🟡 **部分** | `SubagentStop` 给终态 + `agent_transcript_path`；`Workflow` 有 per-agent result 与 journal；`.meta.json` 的 `spawnDepth` 可重建树 | **跨会话**仍只能事后重建（`state-model.md:236-240`：`liveness: reconstructed`）；`Workflow` 的 resume **仅同 session**（`resumeFromRunId`「Same session only」） |
| 3 | 并行 | ✅ **能** | `Workflow` 并发批次（默认 16 / 1–256）+ `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` | 无（数量交给运行时后，框架只剩「要几个」这条判断） |
| 4 | 上下文 | ✅ **能** | 脚本变量持有中间结果；父上下文只收最终答案；subagent 本来就有独立上下文窗口 | 子级之间要通信仍需命名 + `SendMessage`，且是可选能力 |
| 5 | 递归 | 🟡 **部分** | 显式给需要的角色加 `Agent`（P21 实测可到深度 2）；`spawnDepth` 可观测；`SubagentStop` 可记账 | **改不了**：深度上限是宿主的（3 层）、账本体系的树形登记要自己设计、产物命名要加 depth 段；「到限就移除 Agent 工具」是宿主行为 |
| 6 | 终止 | ✅ **能（最强）** | `Stop` hook `decision:block` + `Workflow` 原生终态 + `agent()` 的 null 语义 | 「什么算合格交付」是判断，仍要靠 `stop-hook` 的**规则内容** |
| 7 | 错误 | 🟡 **部分** | `Workflow` 的 stall retry（5 次）、structured-output 重试、`parallel()` 里 `null` 占位、`api_retry_exhausted` 事件；`PreToolUse` 可拦确定性错误（如空格路径） | **子→父的「已启动 ≠ 已完成」语义改不了**（dsh 实测；Claude Code 的 subagent 同构）；`TaskStop` 走 MCP 通道时不可用（`TaskStop` 报 `No task found`） |
| 8 | 结构化输出 | ✅ **能** | `Workflow` 的 `agent(prompt, {schema})`：schema 不合法即调用失败，5 次重试 | 字段**语义**（什么算证据、必须带 `file:line`）仍是判断；`schema` 只保证形状 |
| 9 | 度量 | ✅ **能** | `/workflows` 的 per-agent token；`modelUsage`；`subagent_completed` 的 `duration_ms`/`total_tool_uses` | 官方**未记载**每 agent 的耗时显示（转录 `research-workflow-vs-agent.md:274-275` 标「未找到」）；成本口径要自己定 |
| 10 | 隔离与权限 | ✅ **能** | `PreToolUse` deny + `continue:false`；`tools` 白名单（已是原生）；`isolation: worktree` | **只能承诺「记录它做了什么」，不能承诺「阻止它做什么」**（`docs/research/2026-11-11-framework-architecture-options.md:14`）；`ask` 只能问「允许这次调用吗」，问不出业务问题 |
| 11 | 预算/深度强制 | 🟡 **部分** | `maxBudgetUsd`（到顶拒 spawn + 停后台 agent + `error_max_budget_usd`）；1,000 agent/run 是硬墙 | 触顶后的**降级分支要自己写**；深度限制只能观测不能强制 |

**计数**：✅ 7 个（1/3/4/6/8/9/10）、🟡 4 个（2/5/7/11）、❌ 0 个。
但按后果加权要打折：第 2 项（状态）是后果最贵的一条，它只到 🟡，
因为**跨会话**这一半补不上；第 5 项（递归）和第二半的 7（错误）同理由。**我的估计是 6.5/11。**

### 4.3 补法的关键点（每条一句，避免「知道了但仍然写错」）

1. **把计划搬进 `Workflow` 脚本，不是搬进更长的 protocol.md。** 否则只是把 2,641 行常驻规程换成 3,000 行。
2. **活性判据换成 `SubagentStop` 事件，不用 mtime、不用转录大小、不用 `in_flight` 数组。** 三条代理指标已经各错过一次。
3. **`Stop` hook 只认 `{"decision":"block"}`，`exit 2` 实测不拦。** 照官方文档写会静默失效。
4. **`PreToolUse` 必须自己数次数并自带 `continue:false`**，宿主对拒绝循环没有上限（实测 69 次）。
5. **结构化返回用 `agent(..., {schema})`，不要用「请返回以下 JSON」加一个自建校验器。** 前者零成本，后者是 39,899 字节 + 77 条测试。
6. **子级结论不要指望 `Agent` 的返回值。** 返回的是「已启动」；要么读 `agent_transcript_path`，要么在脚本里 await 结果变量。
7. **递归只给明确需要的角色加 `Agent`，并且同时改账本（加 `parent_agent_id`/`depth`）与产物命名。** 只加工具不改账本 = 记账幻觉。

### 4.4 一个反证：交给运行时的部分确实没再出过事

`tools` 白名单是这套框架里**唯一**原生生效的机制。它的效果是硬的：没有 `Write` 就真的写不出文件。
对照组是 `artifact_path` 必填——同一条「必须写产物」的要求，写在契约里时 15/15 全部落空，
写成「校验器 + 目录必须先建」之后，问题变成「目录谁建」这种可机械定位的缺陷
（`report-naming.md` §5.1 的原话：「机械规则的价值在于它会立刻暴露这类遗漏；
自然语言规则则会让它一直藏着，直到有人真跑一遍」）。

---

## 5. 还缺什么

### 5.1 四条硬缺口（现有原语补不上）

| # | 缺口 | 为什么补不上 | 影响 |
|---|---|---|---|
| G1 | **跨会话持久状态** | `Workflow` 的 resume 明确「Same session only」；跨 session 必须 relaunch，否则 `nothing to resume` | 「一次对话跑不完」这件事仍然存在。差别只是从「人来说继续」变成「人重新发一次 Workflow 调用」。**这恰好是 Overwatch 想做的事，而 Overwatch 只能观测、不能投递** |
| G2 | **运行中注入** | `No mid-run user input`；`inject` 只能是「下一轮派发时写进 prompt」 | L3 级的「收窄提示」永远延迟一轮（`state-model.md:286-288` 记 `inject: deferred`） |
| G3 | **子→父投递语义** | 返回值就是「已启动」；父级默认不共享子级 transcript | 只能靠「读 transcript」或「脚本变量」补偿。前者是事后，后者要求子级结论走 `agent()` 的返回值——而返回值也可能被 `null` 顶掉 |
| G4 | **深度与预算的强制** | 深度是宿主行为（到限移除工具）；预算只能设总额，不能设「每层每扇出」 | 递归的「9×5×5×5=1125」永远只是算术。**提示词许诺的上限，运行时只会拒绝，不会按你的意图降级** |

另一条不算缺口但必须承认：**权限只能承诺「记录」不能承诺「阻止」**
（`docs/research/2026-11-11-framework-architecture-options.md:14`）。
所以「零写入」在原生层也只能做到「事后可证 + 尽量拦截」，做不到「保证不发生」。

### 5.2 不该重做的（提示词够用，原生反而更复杂）

| 内容 | 为什么留在提示词层 | 依据 |
|---|---|---|
| 审什么（切片规则、维度划分、可达性） | 是领域判断，harness 不知道「什么算源码」 | `<FW>/projects` 无关；`structural-diagnosis.md` D9/D9.1 证明它需要按项目配置而非写死 |
| 什么算证据（门 0） | 「本回合逐字回显」是**语义**要求，schema 只能要求「有个 quote 字段」 | `evidence-policy.md:16-35`；`SCOPE-PROBE.md:14-27` 证明「声明范围」可以撒谎而形状合法 |
| 什么结论不成立（Skeptic/Arbiter） | 对抗性判断无法机械校验 | `AGENT-CONSISTENCY.md:134-150`：只靠多数表决会漏掉一半，需要「分歧标记」 |
| 报告长什么样（交付物规范） | 是格式约定，写清楚了就能执行 | `START-HERE.md:97-137` 的六节/四节规范 |
| 角色分工与可见性 | 「红队不看执行者结论」是**信息隔离的策略**，不是机制 | `compatibility.md:78-105` 说明机制挡不住主动读取，只能靠顺序与声明 |
| 任务书停机条件（配额/第一命令/不做清单） | 唯一被实测证明能提高完成率的干预 | `wave2a-sweep.md:384-411`、`:442` |
| 裁量留痕（`discipline_log` + `mechanisable_check`） | 是治理设计，不是调度 | `protocol.md:630-703` |

**判断标准一句话**：**「运行时能判定真假」的交给原生；「需要读懂内容才能决定」的留在提示词。**
按这条标准，框架现在的 47% 编排类里**绝大部分属于前者**（并发、状态、重试、耗时、token、schema），
46% 判断类里**全部属于后者**。它的自我诊断（`harness-first-pivot.md:130-144`）与这条标准一致。

### 5.3 对「公司架构」的直接含义

用户的原话是「带自己的手下，手下也可以有手下，也可以外包」。按本文的分析，三层应该这样切：

```
运行时（harness）负责：扇出、并发、相位、终态、耗时、token、模型选择、schema 强校验、权限闸
框架负责：岗位定义、问题流、证据标准、裁决规则、交付物形状、停机条件
用户负责：不可逆决策、预算上限、要不要中途签核
```

**「更原生」的落地判据不是「用上 Workflow」，而是：主 Agent 的上下文里还剩多少「必须靠自述维持」的东西。**
现在它有 2,641 行常驻规程 + 一个自己维护的 `in_flight` 数组 + 一个自己写的账本。
每一样都可以问一句：**这东西运行时能不能直接给？** 能给的，就应该删掉，而不是写得更细。

### 5.4 三个可证伪的下一步实验（建议派给后续 Agent）

1. **同一份审计任务，`Workflow` 版 vs 提示词版，比「主 Agent 常驻上下文行数」与「人工介入次数」。**
   预测：Workflow 版主 Agent 上下文 < 500 行、介入 0 次；提示词版 ≥2,641 行、介入 ≥1 次/相位。
   若预测不成立，「不够原生」这个问题就不值得重做。
2. **`SubagentStop` 作为活性判据的误判率。** 用本机 5,044 个子 agent transcript 回放，
   比较「`SubagentStop` 时刻」vs「产物 mtime」vs「转录大小」三种判据的 DONE/RUNNING 判定差异。
   预测：后两者与真实终态的一致率显著低于前者。**这是唯一能验证 §2.1 第 2 行的实验。**
3. **`agent(..., {schema})` 对信封合规率的提升。** 用现有 15 份真实产物（0 份含信封）做对照，
   同任务改用 schema 强制。预测：合规率 0% → 100%，且不需要 `salvageFromMarkdown()`。

---

## 6. 引用索引（本文所有 `file:line` 的出处）

外部材料（只读）：

- `<FW>/framework/orchestrator/protocol.md` — 60-66（规划权）、109-144（派发算术）、428-450（提示词强度分层）、
  433-437 / 583-590（agent 循环=回合结束）、506（账本自维护）、516-548（dsh 父级漏产物）、
  630-703（裁量分级）、948（只读账本）、965-986（F1 死锁）、1202-1216（并发护栏）
- `<FW>/framework/orchestrator/environment-probe.md` — 79-83、86-90、96、106
- `<FW>/framework/orchestrator/scale-mapping.md` — 16-45（§0 harness 优先）、56（从未计量 token）、135-137、202
- `<FW>/framework/orchestrator/compatibility.md` — 78-105（串行泄漏通道）、151-183（上下文预算）
- `<FW>/framework/orchestrator/triage.md` — 124-126、186、165-187（递归上界）
- `<FW>/framework/artifacts/run-state.md` — 46（计数纪律）、199-200（派发前写 in_flight）
- `<FW>/framework/wrappers/recon-scout.md` — 67-69（15 产物 0 信封）
- `<FW>/framework/wrappers/*.md:4` — `tools` 字段（无 `Agent`）
- `<FW>/framework/templates/wave2a-sweep.md` — 384-411（窄任务/停机条件）、442、458
- `<FW>/framework/components/evidence-policy.md` — 16-35（门 0）
- `<FW>/framework/components/output-contract.md` — 107（六角色闭集）
- `<FW>/framework/PORTABILITY.md` — 12-15、70-73
- `<FW>/framework/artifacts/report-naming.md` — §5.1、§5.2（空格路径事故）
- `<FW>/docs/analysis/2026-11-09-harness-first-pivot.md` — 11-16、22-45、70-84、111-126、130-144
- `<FW>/docs/analysis/2026-11-01-structural-diagnosis.md` — 31-36、44-51、87-89、98-104、106-110、137
- `<FW>/docs/analysis/2026-11-04-autonomy-fix.md` — 全文（报告即终点）
- `<FW>/experiments/FAILURE-MODES.md` — 12-19、24-26、50-56、58-66
- `<FW>/experiments/AGENT-CONSISTENCY.md` — 152-170、134-150
- `<FW>/experiments/STATUS.md` — 142-148
- `<FW>/experiments/ABLATION.md` — 52-70
- `<FW>/experiments/CONTRACT-PROBE.md` — 10-20
- `<FW>/experiments/SCOPE-PROBE.md` — 14-27
- `<FW>/experiments/DSH-EXPERIMENT.md` — 93-107、124-128
- `<FW>/experiments/DATA-LOSS.md`、`LEAK-INCIDENT.md`、`CHECKOUT-INCIDENT.md`
- `<TOKEN-HEAVY>/audit-runs/round1-web-style/RUN-OBSERVATIONS.md` — 38-43、54-60
- `<TOKEN-HEAVY>/audit-runs/plan-decomposition.md` — §1.2（C3/C5）、§1.4（C10/C11）、§4（三个错误点）
- `<TOKEN-HEAVY>/audit-runs/research-workflow-vs-agent.md` — 94-105（官方对比表）、130-133（worktree）、
  147-159（并发与硬限）、274-275（耗时「未找到」）、283-297（模型选择）、299-326（重试三层）
- `<TOKEN-HEAVY>/audit-runs/expert-conflicts.md` — 冲突 #8/#9（tools 无 Agent、role 闭集）

Overwatch 本仓：

- `docs/spec/state-model.md` — 236-240（liveness reconstructed）、255-260（spawnDepth 实测 2/3）、286-288（inject deferred）
- `docs/spec/dispatch-contract.md` — 92-96（递归深度 3 + 每层须写理由）
- `docs/design/2026-11-11-agent-framework-v2.md` — P21（外部 session 到深度 2）
- `docs/research/2026-11-11-untapped-capabilities.md` — 299-307（subagents/.meta.json、SubagentStart/Stop）、326-334（OTel）
- `docs/research/2026-11-12-stop-hook-prototype.md` — 21、104-113（`exit 2` 不拦）
- `docs/research/2026-11-14-pretooluse-desktop-verification.md` — 40-43（拒绝循环 69 次）
- `docs/research/2026-11-11-framework-architecture-options.md` — 14（MCP 不能取消 / 子 agent 跑不了 shell）、62（P10）
- `docs/research/2026-11-04-orchestration-patterns.md` — 209（A-8：角色定义不含 `Agent` → 实际不可递归）
- `docs/FACTS.md` — 425（宿主 23 工具含 `Workflow`）

---

## 7. 本报告没做的事（诚实声明）

1. **没有重跑任何数字。** 47 分钟、22/80、0/15、9/40、69 次、1.25× 等全部来自原文。
   凡标 `[未复核]` 的，主线程或验收 Agent 应复算；其余我核对的是「原文确实这么写」，不是「原文真对」。
2. **没有在 Workflow 上做任何实测。** §4 的覆盖表是**按能力映射**推的，不是跑出来的。
   `workflows.md` 的引文来自本仓既有转录（`2026-11-09` 那次核实），没有重新抓取官方页面。
3. **没有修改 `<TOKEN-HEAVY>` 下任何文件**，因此无法用「改一行看会不会红」的方式验证本文的因果判断。
4. **没有评价那套框架的审计质量**（那是它的强项，与本文问题无关）。
   本文只回答「它的编排层为什么不能更原生」。
