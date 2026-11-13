# 12 个角色定义审计：它们能不能直接当框架的「员工」

- 日期：2026-11-10
- 审计者：审计 Agent FR2（exploration 形态）
- 审计对象：`.claude/agents/*.md` 全部 12 份（762 行，逐份读完正文与 frontmatter）
- 交叉对象：`docs/spec/dispatch-contract.md`、`docs/spec/evidence-discipline.md`、`docs/spec/relay-protocol.md`、
  `docs/spec/output-format.md`、`docs/adr/0001-config-only.md`、`.claude/skills/oversight/SKILL.md`、
  `scripts/check-structure.mjs`、`scripts/validate-run.mjs`、`templates/*.md`、`tasks/runs/2026-10-30-p0/`
- 本文件是审计报告，不是能力说明。**未修改任何角色定义，未碰 git。**

---

## 零、结论先行

**1. 不能直接用作框架的「员工」。** 原因是结构性的，不是打磨问题：这 12 份定义描述的是「一个主线程的 12 种分工」，而框架需要的是「能自己领活、能派活、能验收、能对外」的岗位。两者的信息结构不同——现有定义里**没有一个角色能派出下一个角色，也没有一个角色能驱动外部进程**。

**2. 深度 3 层是空头支票，且比「写错」更糟。** 12 份全部显式写了 `tools:`，**无一份含 `Agent`**。我实测了本会话里被派出的 `oversight-executor`，它自报的工具是 `Read, Write, Edit, Bash, Glob, Grep`——没有 `Agent`。同一会话里 `general-purpose` 角色**有** `Agent` 并且成功派出了第二层（回 `DEPTH2-OK`）。**所以天花板是角色定义造成的，不是宿主造成的。**

**3. 有三个角色被要求做它们物理上做不到的事**（这是本次最严重的一类问题，不是「白名单偏紧」，是「职责与工具直接互相否定」）：

| 角色 | 定义要求它做什么 | 缺什么工具 | 出处 |
|---|---|---|---|
| `redteam` | 「必须实际验证至少 3 条（**跑命令**、读数据、写小测试）」 | `Bash` | `oversight-redteam.md:58` vs `:10` |
| `research` | 「**优先实测**。能跑一条命令验证的，不要引用文档」 | `Bash` | `oversight-research.md:22` vs `:10` |
| `relay` | 「先读收件箱：`node scripts/watch.mjs --inbox --json`」 | `Bash` | `oversight-relay.md:23` vs `:10` |
| `acceptor` | 验收标准要求「判定前必须逐条跑」脚本 | `Bash` | `2026-11-04-notify-fix-acceptance.md:401`、`:423` vs `acceptor.md:10` |

**4. `check-structure.mjs` 对角色定义的门是「有，但漏得很多」。** 五条负向测试里**四条能绕过**：给 executor 加 `Agent` 通过；删掉 `tools:` 整行通过（而在宿主语义下「省略 = 继承全部工具」，这等于把白名单静默变成全开）；给 planner/resolution 加 `Edit`+`Bash` 通过；正文里随手写一句「不得修改」就让报告路径声明失效。**唯一真正有效的是 `checkAgentReachability`（角色必须被 SKILL.md 提到）和「只读角色不得含 Edit/Bash」。**

**5. 输出格式没有统一约定，所以框架拿不到可判定的返回值。** 12 份定义里有 10 种不同的输出模板；`dispatch-contract.md:77` 要求所有子 Agent 返回同一个三元组，但**只有 executor 一份照抄了它**（`oversight-executor.md:34`），且没有任何脚本解析任何角色的返回值。框架若按「读返回值」设计，现在读到的是自由散文。

**6. 缺的关键角色是三类，都不是「再加一个 reviewer」**：①能派活的协调者（有 `Agent` 的角色）；②能驱动外部 harness 的适配器角色（对应你说的「带别人的手下」）；③能真正跑机器校验的门禁角色（现在这份活挂在不许跑命令的 acceptor 身上）。

---

## 一、方法与证据限定

**读法**：12 份全文逐行读，不只看 `tools:` 行。

**实测**（在**临时副本**上做负向测试，真仓库未被改动；`git status` 与本轮开始时一致）：

| # | 手段 | 结果 |
|---|---|---|
| M1 | 真派一个 `oversight-executor` 子 Agent，让它自报工具 | `Read, Write, Edit, Bash, Glob, Grep`；无 `Agent` |
| M2 | 真派 `oversight-acceptor`，让它自报工具并试调 `Bash` | `Read, Grep, Glob, Write`；`Bash` 不存在（"没有这个工具可调"） |
| M3 | 真派 `oversight-relay`，问它能否执行 `watch.mjs --inbox --json` | 不能，缺 `Bash` |
| M4 | 真派 `general-purpose`（有 `Agent`）派第二层 | **成功**，第二层回 `DEPTH2-OK` |
| M5 | 真派 `oversight-probe`，让它 `Read` 同级产物 `task-graph.json` | **读到全文**——「不要读推理文本」是 prompt 约束，不是边界 |
| M6 | 临时副本上对 `check-structure.mjs` 做 6 组变异 | 见 §五 |
| M7 | 用 `validate-run.mjs` 跑 planner 自述的 6 值 capability 图 | 判违规：缺 `repair`（planner 的枚举里没有 repair） |

**没做 / 无法核实**：

- 没有在真仓库上做任何写操作或变异；所有门禁负向测试在 `%TEMP%/ow-audit` 副本上执行。
- 没有实测「12 个角色并行跑一轮完整 Phase A–E」的耗时与 token（无法在不派真实任务的前提下做）。
- `check-structure.mjs` 的 `checkChangelog` 在非 git 副本里会跳过，所以副本的绿灯不完全等价于真仓库绿灯；但本次测试的每条规则都在 `checkAgents` 内，不依赖 git。
- 宿主文档取自仓库内的 `.tmp-analysis/cc-8831ab.md`（gitignored 的本地快照），不是当场从网络取。

**一处与既有文档不一致**：`docs/design/2026-11-10-agent-framework-skeleton.md:239` 说「本版本派生子 agent 的工具名是 `Task`」，`claude -p` 的 `init.tools` 里没有 `Agent`。**本会话实测的子 Agent 工具列表里是 `Agent`，`Task` 不在其中**（宿主文档 `cc-8831ab.md:505` 记「2.1.63 起 Task 改名为 Agent，旧写法仍作别名」）。两种叫法指向同一能力，**结论不变**（12 份定义两种都没有），但引用时应注明是哪个通道观察到的。

---

## 二、逐个角色分析

### 2.1 `oversight-planner`（规划）

- **职责**：把需求拆成可并行子树，为每个子树预先声明产出形态、验收标准、预算；写 `task-graph.json`。
- **白名单**：`Read, Write, Glob, Grep`（`:11`）——无 `Bash`、无 `Agent`。
- **能不能干成活**：**大部分能**。产出的是一份 JSON，`Write` 足够；`Read/Glob/Grep` 够读台账与规格。这是 12 份里**唯一有可机器校验产物**的角色，配套的 `validate-run.mjs` 也确实存在。
- **但它有三个自相矛盾**：
  1. `:33` 写「递归深度上限 3 层」，而它自己没有 `Agent` 工具，且它产出的 schema 是**扁平**的（只有 `subtrees[]`，没有 `children`/`parent`/`depth` 字段，见 `:44`–`:60`）。**深度这件事在数据结构和工具集两侧都不存在**，只在文档里存在。
  2. `:48` 的 `capability` 枚举只列 6 个值（`executor|research|critic|redteam|review|acceptor`），而 `validate-run.mjs:27`–`:30` 的合法值是 12 个。**planner 按自己的文档写图，会通不过校验器的复杂任务规则**——因为 `CLAUDE.md:10` 硬约束 2 要求复杂任务必须含**修复**角色，而 planner 的枚举里根本没有 `repair`。实测（M7）：我按 planner 文档的 6 个 capability 造图，`requireComplex: true` 下直接判违规。
  3. `:28` 让读者去 `dispatch-contract.md §5` 看验收标准格式，而那份文档 §5 与 `templates/acceptance-criteria.md` 的字段一致；这一条是**对的**，是 12 份里少见的正确交叉引用。
- **仅靠 prompt 的约束**：`:28`「事后增补标准无效」、`:30`「不得塞主线程顺手做的任务」、`:31`「不得替执行 Agent 做实质分析」。这三条都在写完之后才生效，没有任何机制检查产出的图里有没有隐藏的实现方案或事后标准。**`validate-run.mjs` 能查字段缺失，查不了内容违规。**

### 2.2 `oversight-executor`（执行）

- **职责**：按单个子树执行实质工作，产出交付物。
- **白名单**：`Read, Write, Edit, Bash, Glob, Grep`（`:10`）——**这是 12 份里权限最大的一档**（与 `repair` 相同）。
- **能不能干成活**：**能**。工具与职责匹配，是这批定义里最没有内部矛盾的一份。
- **但作为「框架员工」它错位了**：它有 `Edit` 与 `Bash`，意味着它是**直接改仓库的那一方**。框架里「被派活的手下」应该是受限于工单范围的外部执行者；现有 executor 是「有全权的本地进程」。差别在于：工单外的副作用（装依赖、改配置、`git commit`、`git push`）**没有任何工具层或 prompt 层的拦截**——`executor.md` 全文没有一行提到 git（`grep "git " .claude/agents/*.md` 零命中），而 `CLAUDE.md` 提交前那节明确要求「不用 `git add -A`」。
- **仅靠 prompt 的约束**：`:24`「不要读其他执行 Agent 的输出」、`:30`「不得自行修复任务范围外的 bug」、`:32`「重跑时不得缩小任务范围」。前两条都是可绕的（它能 `Read`、能 `Bash`，路径就在仓库里）。

### 2.3 `oversight-acceptor`（验收，一票否决）

- **职责**：对照**预先声明**的标准逐项判定，拥有一票否决权，「管过不过，不管好不好」。
- **白名单**：`Read, Grep, Glob, Write`（`:10`）——**无 `Bash`、无 `Edit`**。
- **能不能干成活**：**不能，而且这是本批最严重的一处。** 证据是它自己的项目给出的验收标准长什么样。`docs/spec/2026-11-04-notify-fix-acceptance.md:401` 的「第三方复算清单」写着「**判定前必须逐条跑**」，内容包括：
  ```
  1. node scripts/check-structure.mjs  → 必须全绿
  2. node --test scripts/*.test.mjs    → 必须全绿（当前基线 497 条）
  3. 取修复后的 watch.log + sessions 快照，按 §1.5 复算 M1/M2/M3
  ...
  ```
  并且 `:423` 明写「任一条跑不动（脚本报错、文件不存在、无法执行），**不判通过**」。
  **一个没有 `Bash` 的 acceptor，面对这份标准只能判「不通过」——它跑不动任何一条。** 而它同时又必须给出「逐条判定」和「覆盖声明」（`:30`、`:52`），于是唯一能写出的诚实结论是「我无法核实」，这正是 `acceptor.md:54` 那一条「哪些判定项我无法完全核实」的常态而非例外。
- **`Write` 有、`Edit` 没有 → 「只判定不改稿」只对一半成立。** `:34` 自己写着「你的 tools 里没有 `Edit`，这不是 prompt 约束」——**这句话本身就是半真半假**：它对 `Edit` 成立，对 `Write` 不成立，而 `Write` 足以覆盖整份交付物。`acceptor.md:19`–`:23` 的输入里**没有说验收报告写到哪**，全文没有一行「只允许写报告路径」——所以 `check-structure.mjs:203` 报告路径正则对它是**靠 `不得修改` 三个字（`:34`）蒙过去的**。
- **实测（M2）**：我让它把一份临时文件改成 `MUTATED-BY-ACCEPTOR`，它**拒绝了**，并且理由给得很准：「我的工具集里有未被限制的 `Write`，schema 层面没有任何东西阻止我覆写……所以如果假设是『正文里声明的只读不是工具层边界』，那么按工具清单检查就已经证实了」。**注意这条证据的两面性**：它证明了 prompt 约束**这次**有效，也证明了**唯一起作用的是判断，不是工具**。研究结论（`2026-11-04-orchestration-patterns.md:44`：「能被模型的下一句话绕过的，都不是边界」）在这里成立——只是这次模型没有越线。

### 2.4 `oversight-critic`（批判）

- **职责**：质疑**拆解是否合理**，不评价交付物。
- **白名单**：`Read, Grep, Glob, Write`（`:10`）。
- **与规格不一致**：`dispatch-contract.md:46` 写 `critic` 是 `Read, Grep, Glob`（**无 Write**），文件里有 `Write`。**规格表与实际定义漂移**，而没有任何检查发现它（见 §五）。文件侧是对的——它要写 `critique.md`（`:19`）。**错的是规格。**
- **能不能干成活**：**能，但职责边界在文件内部就是糊的**。它的 5 个必答问题（`:32`–`:36`）里，第 3 问是「**验收标准里，哪些是无法观测的**」——那是**验收标准的设计质量**，属于 planner 的产出，不是「拆解结构」。而实际交付物 `docs/research/2026-11-04-notification-system-critique.md` 的标题是「通知系统该推倒重做，不是修」，攻击的是**整个系统**，既不是拆解也不是前提。**这个角色的既定职责和它实际做的事是两回事。**
- **仅靠 prompt 的约束**：`:28`「不要读执行 Agent 的产出」。实测（M5，同类角色）表明这类禁令不构成边界——它能 `Glob` 到 `tasks/runs/*/` 下的一切，也能 `Read` 任意文件。**规格 `dispatch-contract.md:37` 声称「靠不提供路径实现」，但路径就在工作目录里，`Read` 不需要被给路径。**

### 2.5 `oversight-redteam`（红队）

- **职责**：攻击交付物与结论，构造反例。
- **白名单**：`Read, Grep, Glob, Write`（`:10`）——**无 `Bash`**。
- **能不能干成活**：**不能。** `:58` 要求「必须实际验证至少 3 条（**跑命令**、读数据、写小测试），不能全靠推演」；`:20` 说「只允许**只读命令**与临时测试脚本」。**一个没有 `Bash` 的角色既跑不了命令，也写不了测试脚本。** 这两句在工具集面前是空话。
- **更硬的证据是它的真实产出**：`docs/research/2026-11-04-redteam-notify-fix.md:3`–`:6` 自述「所有结论均来自**真实生产数据**（经 WMI `Win32_Process Create` 起的非虚拟化进程读取）与本仓库真实函数（**`import` 进来跑**，不是重写）」。**这不可能由一个没有 `Bash` 的角色完成。** 也就是说：真实红队工作是用**另一个工具集**（有 `Bash` 的通用 agent）做的，`oversight-redteam` 这份定义**没有被按它自己的约束执行过**——否则那份报告写不出来。
- **仅靠 prompt 的约束**：`:28`「不要读执行 Agent 的『我认为的薄弱点』」——同样是可绕的。

### 2.6 `oversight-review`（锐评）

- **职责**：质量评分 1–10，给最致命的 3 个问题，「管好不好，不管过不过」。
- **白名单**：`Read, Grep, Glob, Write`（`:10`）——与 critic 完全相同。
- **能不能干成活**：**能**（它只读交付物 + 原需求，写一份 review.md）。这是本批里工具与职责最匹配的之一。
- **小缺陷**：`:12` 的 `color: magenta` **不是宿主接受的取值**（宿主枚举是 `red/blue/green/yellow/purple/orange/pink/cyan`，见 `cc-8831ab.md:314`）。不影响功能，说明这 12 份文件**没有被逐字段校验过**。
- **`omitClaudeMd: true`（`:14`）的副作用**：它启动时**不加载 `CLAUDE.md`**。而「锐评的结论不能由执行 Agent 自己写」「禁止静默共识」这些硬约束**只存在于 `CLAUDE.md` 里**。这 4 个 `omitClaudeMd` 角色（acceptor/critic/redteam/review）的 prompt 里也**没有重述**这些约束——设计意图是「靠不提供上下文保持干净」，代价是**它们也不知道自己在整个体系里的位置**。

### 2.7 `oversight-repair`（修复）

- **职责**：仅在验收不通过或锐评低于阈值时触发，接收验收理由 + 交付物 + 锐评意见进行修复。
- **白名单**：`Read, Write, Edit, Bash, Glob, Grep`（`:9`）——与 executor 同档，**全批最大**。
- **能不能干成活**：**能，但这是风险最高的一份**。`:27` 写「**不得修改验收标准**。如果标准本身错了，写进返回的『新风险』节，不要自己改」。而验收标准是**仓库里的 markdown 文件**（真实例子：`docs/spec/2026-11-04-notify-fix-acceptance.md`，526 行），`repair` 有 `Write` + `Edit` + `Bash`。**于是「不得修改验收标准」是纯 prompt 约束，而它握有改掉标准的全部工具。** 一个被验收卡住的修复者，最省力的路径就是改标准——这正是 `evidence-discipline.md:52` 想防的那件事。
- **`repair` 也不在 `check-structure.mjs` 的只读名单里**（`READONLY_ROLES` 只有 6 个，见 §五），所以这条约束**连一层形式检查都没有**。

### 2.8 `oversight-probe`（活性探针）

- **职责**：只读工具调用日志，三选一判 `HEALTHY_EXPLORING / UNFOCUSED / LOOPING`。
- **白名单**：`Read, Grep, Glob`（`:14`），`model: haiku`（`:15`）。
- **能不能干成活**：**部分能**。它的输入写的是「transcript **或** `scan-sessions.mjs --json` 的输出」（`:24`）——**它跑不了那个脚本**，只能 `Read` transcript 原文（`~/.claude/projects/.../*.jsonl`）。所以它实际只能走「自己解析 jsonl」这条路，而 prompt 里没写怎么解析，也没给 schema。
- **仅靠 prompt 的约束**：`:26`「**不要读**目标 Agent 的推理文本」。实测（M5）：我让它 `Read` 了一份同级 `task-graph.json`，**它读到了全文**，并在回答里自己说「读取本身没有越过任何权限边界，问题是输入范围，不是访问权限」。**这是本次审计最干净的一条证据：prompt 层的输入隔离没有物理实现。**

### 2.9 `oversight-relay`（接力草稿）

- **职责**：为目标停滞会话产出一条用户会亲手发出去的接力消息草稿。
- **白名单**：`Read, Grep, Glob, Write`（`:10`）——无 `Bash`。
- **能不能干成活**：**不能按它自己写的流程干。** `:20`–`:30` 是它最核心的输入路径：
  ```
  **先读收件箱，不要自己重新扫描**：
  ```bash
  node scripts/watch.mjs --inbox --json
  ```
  ```
  实测（M3）：被派出的 `oversight-relay` 自报「**不能**。缺 `Bash`（无可执行 shell 的工具），无法运行 `node scripts/watch.mjs --inbox --json`」。于是它只能退回 `Read` transcript——**而它自己的 prompt 明令「不要自己重新扫描」**。**这是一个自我否定的输入契约**：唯一被允许的路径不可达，被禁止的路径是唯一可达的。
- **一处纯文本缺陷**：`:34` 与 `:35` 是**同一行重复了两次**（「目标会话的最后 N 条消息（不含 AI 推理文本…）」）。说明这些文件没有经过最基本的重复行检查。
- **另一处漏写**：`relay-protocol.md:108` 要求「草稿 → 写入 `tasks/runs/<id>/relay-draft-<n>.md`」，**`relay.md` 全文没有提到这个路径**，也没像 critic/redteam/review 那样声明「只允许写这一个文件」。它的 `Write` 是**未约束的**。

### 2.10 `oversight-safety`（安全）

- **职责**：只看草稿，查是否触碰红线，判 `ACCEPT / REJECT`。
- **白名单**：`Read, Grep, Glob`（`:9`），`model: haiku`（`:10`）。
- **能不能干成活**：**能**（只读文本、出二元判定），工具与职责匹配。
- **但它的输入可能不存在**：它读「草稿全文」，而草稿的唯一合法落点是 `tasks/runs/<id>/relay-draft-<n>.md`——`relay` 的角色定义里**没有要求写这个文件**（见 2.9）。两个角色之间**没有一份显式的接口约定**。
- **红线清单已经漂移**：`relay-protocol.md:53`–`:63` 是 **5 类**红线；`safety.md:29`–`:36` 是 **8 项**，多出「与原始需求矛盾」「本机绝对路径」「替用户承诺」三项。多出来的三项**不是红线**（它们是质量项），却被并列进同一张「命中即 REJECT」的表。**同一份清单在两个文件里以两种粒度存在，没有单一真源。**
- **仅靠 prompt 的约束**：`:59`「判 ACCEPT 之前必须逐项检查完 8 项」——没有人能验证它真的查了 8 项。它的输出模板要求逐项给证据（`:43`–`:46`），这是 12 份里**唯一自证覆盖率**的设计，算加分项。

### 2.11 `oversight-research`（检索）

- **职责**：搜集外部事实，每条标来源与可信度。
- **白名单**：`Read, Grep, Glob, WebSearch, WebFetch`（`:10`）——**唯一有网络工具的角色**，无 `Bash`。
- **能不能干成活**：**一半**。查文档能，**实测不能**——`:22` 明写「**优先实测**。能跑一条命令验证的，不要引用文档」，而它没有 `Bash`。**它的第 3 条规则与它的工具集直接冲突**，且这条规则是它区别于其他角色的核心价值（「实测 > 官方文档 > 社区经验」是 `resolution.md:26` 的裁决基准）。
- **结构性缺失**：**它没有 `## 输入` 节。** `grep -c "^## 输入"` 对它返回 0；其余 11 份都有。而 `dispatch-contract.md:18` 要求每个 Agent 必须收到四样东西（原任务、验收标准、产出形态、预算）。**这份定义连「我要收什么」都没写**，`Glob` 到 41 份研究文档时会自己决定读哪些。

### 2.12 `oversight-resolution`（裁决）

- **职责**：读分歧双方原话，判断哪一方证据更强；判不了就给「还需要什么证据」。
- **白名单**：`Read, Grep, Glob, Write`（`:10`）。
- **能不能干成活**：**能**（纯文本比较），且它的输出是 12 份里**最可判定的**：三值裁决 `支持 A / 支持 B / 悬置`（`:35`）+ 固定的证据强度对比表（`:41`–`:46`）。这是框架可直接消费的形状。
- **但它的 `Write` 是 12 份里最没有边界的**：critic/redteam/review 三份都写明了「只允许写这一个文件」（各自 `:19`），**resolution 与 relay 都没有**。而 resolution 也不在 `check-structure.mjs` 的只读名单里——**给它加 `Edit`+`Bash` 能直接通过结构门**（实测见 §五）。

---

## 三、白名单 vs 职责的矛盾表

严重度按「会不会让这个角色交出一份**看似合格实则没做**的产出」排：

| 角色 | 声称的职责 | tools 白名单 | 矛盾点 | 严重度 |
|---|---|---|---|---|
| `acceptor` | 对照预声明标准判定，一票否决 | `Read, Grep, Glob, Write` | 项目自己的验收标准要求「判定前必须逐条跑」脚本（`2026-11-04-notify-fix-acceptance.md:401/423`），它跑不了任何一条；`Write` 未限定路径，可覆写被验收物 | **致命** |
| `redteam` | 构造反例，必须实际验证 ≥3 条 | `Read, Grep, Glob, Write` | 被要求跑命令/写测试脚本，但无 `Bash`（`:58` vs `:10`）；真实红队报告（`2026-11-04-redteam-notify-fix.md:3`）证明实际执行用的是别的工具集 | **致命** |
| `repair` | 只修被指出的问题，不得改验收标准 | `Read, Write, Edit, Bash, Glob, Grep` | 验收标准是仓库文件，它有改它的一切工具；约束纯 prompt（`:27`），且不在只读名单里 | **致命** |
| `relay` | 先读收件箱再写草稿 | `Read, Grep, Glob, Write` | 唯一允许的输入路径是一条 `node` 命令（`:23`），无 `Bash`；退回的路径被自己禁止；草稿落点未声明 | **高** |
| `research` | 优先实测，事实必须可验证 | `Read, Grep, Glob, WebSearch, WebFetch` | 「能跑一条命令验证的不要引用文档」（`:22`）却跑不了命令；无 `## 输入` 节 | **高** |
| `planner` | 拆解 + 声明标准/形态/预算 + 深度上限 3 层 | `Read, Write, Glob, Grep` | capability 枚举 6 值缺 `repair`，与校验器（12 值）和 `CLAUDE.md:10` 冲突；schema 扁平无 depth 字段，`Agent` 也没有（`:33`/`:48`） | **高** |
| `executor` | 按子树执行，不动范围外 | `Read, Write, Edit, Bash, Glob, Grep` | 全权本地进程：`Bash` 下 `git commit/push`、装依赖、改配置均无拦截，全文零 git 约束 | **高** |
| `probe` | 只读工具调用日志，不读推理文本 | `Read, Grep, Glob` | 输入写的是「transcript 或 `scan-sessions.mjs --json`」，脚本跑不了；「不要读」实测可绕（能读任意文件） | **中** |
| `critic` | 只质疑拆解与前提 | `Read, Grep, Glob, Write` | 与规格表不一致（规格无 `Write`）；第 3 问越界到验收标准设计；实际交付物攻击的是整个系统 | **中** |
| `resolution` | 比较双方证据强度 | `Read, Grep, Glob, Write` | `Write` 无路径边界（另三个写报告角色都有）；不在只读名单，可被加 `Edit/Bash` 而门禁不响 | **中** |
| `review` | 质量评分 1–10 | `Read, Grep, Glob, Write` | 无实质矛盾；`color: magenta` 非法；`omitClaudeMd` 使其不知道 `CLAUDE.md` 的硬约束 | **低** |
| `safety` | 查草稿红线，二元判定 | `Read, Grep, Glob` | 工具匹配；但红线清单与 `relay-protocol.md:53` 的 5 类漂移成 8 项，且输入文件可能不存在（relay 未要求写） | **低** |

**统计**：12 份里 **3 份致命、4 份高、3 份中、2 份低**。工具与职责完全无矛盾且无结构性缺失的，只有 `review` 和 `safety` 两份。

---

## 四、职责重叠：critic / redteam / review / acceptor / safety 的边界

规格声称它们是五个不可合并的角色（`dispatch-contract.md:47`–`:56`），理由是「输入不同、视角不同」。**实际边界比声称的薄**：

| 对 | 声称的区分 | 实际区分 | 判定 |
|---|---|---|---|
| `review` vs `acceptor` | 主观评分 vs 客观判定；后者不得读前者的分数引用 | **工具集完全相同**（`Read, Grep, Glob, Write`），输入几乎相同（交付物 + 原需求；acceptor 多一份 AC 文件）。区分**只存在于 prompt** | 边界靠自律 |
| `critic` vs `redteam` | 前者输入拆解图，后者输入交付物 | 工具集差一个 `Write`（critic 有，规格说没有）。critic 的第 3 问（`:34` 无法观测的验收标准）与 redteam 的「误判」方向（`redteam.md:33`：「这个判据在什么真实数据分布下会给出错误结论」）**指的是同一件事** | 实质重叠 |
| `redteam` vs `acceptor` | 攻击 vs 判定 | 无重叠（不同问题：会怎么崩 vs 过不过） | 清晰 |
| `safety` vs `acceptor` | 红线二元判定 vs 多标准判定 | safety 是 acceptor 的**窄 schema 特化**（2 值 vs 通过/不通过）。它存在的正当理由是「不许自己审自己」（`dispatch-contract.md:58`），这条成立 | 清晰（但清单漂移） |
| `critic` vs `planner` | 拆 vs 检查拆 | critic 的第 3 问实际在**评验收标准的设计质量**，那是 planner 的产物 | 越界 |

**结论**：五者里真正不可合并的是 `safety`（不同 schema、不同触发点）和 `acceptor` vs `redteam`（不同问题）。`review`/`acceptor` 的分离**只有 prompt 支撑**——而 `acceptor.md:25` 又要求它「不要读锐评的分数」，这是一条**没有路径隔离**的禁令：`review.md` 就在 `tasks/runs/<run-id>/` 下，`acceptor` 有 `Glob` 和 `Read`。

---

## 五、`check-structure.mjs` 对角色定义做了什么

### 5.1 它验证什么（`scripts/check-structure.mjs:174`–`:217`）

| 检查 | 规则 | 有效？ |
|---|---|---|
| frontmatter 存在 | `:185` | 有效 |
| `name` / `description` 必填 | `:189`–`:193` | 有效 |
| `description` ≥ 10 字 | `:213` | 有效（理由写的是「主线程无法据此路由」，成立） |
| 只读角色不得有 `Edit`/`Bash` | `:198`–`:208`，名单在 `:37`（acceptor/probe/safety/review/redteam/critic） | **有效但名单不全**（见 5.3） |
| 只读角色有 `Write` 时须声明只写报告 | `:203` 的正则 `/只允许写\|只能写\|只写报告\|报告路径\|不得修改/` | **形式有效、实质可绕**（见 5.2 #3） |
| 角色必须被 SKILL.md 提到 | `checkAgentReachability`，`:901`–`:921` | **有效**（实测：把 `oversight-safety` 从 SKILL.md 删掉直接 fail，报「定义了却从不被派发」） |

### 5.2 六组负向测试（临时副本，真仓库未动）

| # | 变异 | 期望 | 实际 | 判定 |
|---|---|---|---|---|
| T1 | `oversight-executor` 的 tools 加 `Agent` | fail | **通过（exit 0）** | **漏洞**：深度是规范里唯一的核心主张，门完全不看 |
| T2 | 删掉 `oversight-probe` 的 `tools:` 整行 | fail（应为必填） | **通过** | **最危险的漏洞**：宿主语义下「省略 = 继承全部工具」（`cc-8831ab.md:300`），门把一个白名单变成了全开白名单，且不报警 |
| T3 | `oversight-probe` 改回 `Read, Grep, Glob, Write`，正文追加一行「不得修改任何文件。」 | 应仍 fail（它没声明**报告路径**） | **通过** | 正则只看字面，任意一句含「不得修改」就满足 |
| T4 | `oversight-resolution` / `oversight-planner` 加 `Edit`+`Bash` | fail | **通过** | 只读名单只有 6 个角色，另 6 个（planner/executor/research/relay/repair/resolution）无任何约束，而 planner 和 resolution 本来不该有 `Edit` |
| T5 | `oversight-critic` 改名 `oversight-critique` 并加 `Edit`+`Bash` | fail | **通过** | `:198` 用 `name.includes(r)` 子串匹配，**改个名就绕过** |
| T6 | 把 probe 的工具改成 `Read, Grep, Glbo, SuperTool`（不存在的工具名） | 应提示 | **通过，无提示** | 门不校验工具名合法性；宿主会在启动时报「zero tools」，但门是绿的 |

**唯一按预期工作的是**：`acceptor` 加 `Edit` → fail（`:206` 的 Edit/Bash 分支）；`safety` 从 SKILL.md 移除 → fail（`:915` 的可达性分支）。

### 5.3 它不验证什么（框架视角的关键缺口）

1. **`Agent` 工具的有无**。规范（`dispatch-contract.md:94`、`CLAUDE.md:14`）声称 3 层，门对深度**完全无感**。这是「规范与实际不符」能长期存在而不被发现的原因。
2. **`tools` 字段是否必填**。T2 证明省略即通过，而在宿主语义里省略＝继承全部。
3. **工具名是否真实存在**（T6）。
4. **规格表与定义文件的一致性**。`dispatch-contract.md:44`–`:54` 有一张工具白名单表，`validate-run.mjs:26` 的注释还写着「下面的 `checkAgentDocSync` 会查」——**`checkAgentDocSync` 这个函数在仓库里不存在**（`grep` 全仓只命中那行注释）。所以 §3 表里 `critic` 那份漂移（规格无 `Write`，文件有 `Write`）无人发现。
5. **输出格式是否符合 `dispatch-contract.md:77` 的三元组**。没有任何检查，也没有任何脚本解析返回值。
6. **`model` / `color` / `maxTurns` 的取值合法性**。`review` 的 `color: magenta` 非法而门不知情。
7. **`omitClaudeMd: true` 的后果**。4 个判定角色不加载 `CLAUDE.md`，而 `CLAUDE.md` 是硬约束的唯一载体；门不检查它们的 prompt 里有没有重述这些约束。
8. **没有回归测试**。`scripts/*.test.mjs` 里**没有一份** import 或调用 `check-structure.mjs`（`grep -rln "check-structure" scripts/*.test.mjs` 零命中）；`verify-bugfix-negatives.mjs` 的 18 个变异里**没有一个是 agent 规则**。而 `check-structure.mjs` 本身在 `CLI_SCRIPTS` 白名单里（`:61`），所以 `checkImportable` 也不会碰它。**这条门从未被负向验证过**——本次审计的 T1–T6 是它第一次被反向测试。

---

## 六、如果要做框架，这些角色缺什么

### 6.1 缺能派活的角色（最根本的一条）

12 份定义 + 12 份规格，**没有任何一个角色持有 `Agent` 工具**。这意味着：

- 现有体系里「谁派活」的答案是「主线程」——即 `SKILL.md` 描述的那个不在 `.claude/agents/` 里的会话。**框架里没有「主线程」这个岗位**，它是操作者的位置。
- 于是现有 12 角色全都是**叶子节点**，而框架需要至少一层**中层管理者**：能读工单、拆分、派给下属、收结果、判是否收敛。
- 实测（M4）证明宿主**支持**这个能力（`general-purpose` 派出了第二层并回 `DEPTH2-OK`）。**缺的是定义，不是平台。**

### 6.2 缺能调度外部 harness 的角色

这是你说的「带别人的手下」（Claude Code CLI / dsh）。现有 12 角色里：

- 只有 `executor`/`repair` 有 `Bash`，但它们的 prompt 是**「在本地仓库里写代码」**，不是「驱动一个外部进程并回收它的产出」。
- 没有角色知道 ACP、stdio JSON-RPC、进程生命周期、退出码语义、权限模式协商这些东西——`grep -rn "harness\|ACP" .claude/agents/` 零命中。
- 也没有角色负责**为外部工单写任务描述**。`docs/design/2026-11-10-agent-framework-skeleton.md:192` 提议让 `executor` 兼任「外部适配器的任务描述来源」，但 `executor.md` 的输入契约是「单个子树的 goal + acceptance」（`:20`），**它自己不知道自己可能是在给别人写工单**。

### 6.3 缺能真正跑机器校验的角色

框架的验收必须能跑测试。现有安排把这件事给了 `acceptor`（无 `Bash`），于是验收只能退化成「读文件 + 相信报告」——**这恰恰是 `evidence-discipline.md` 全篇在防的东西**。缺的岗位是「门禁执行者」：有 `Bash`、无 `Write`、输入是命令清单、输出是逐条退出码。

### 6.4 缺角色间的接口约定（输入输出格式）

**输入侧**：只有 `planner` 的产物有 schema（`task-graph.json` + `validate-run.mjs`）。其余全是自然语言 bullet。11 份里有 11 种「## 输入」写法，`research` 一份干脆没有。

**输出侧**：12 份定义里有 **10 种不同的输出模板**（planner=JSON、executor=三元组、review=分数+3问题、acceptor=逐项表+覆盖声明、redteam=反例表、critic=5问、probe=三选一、relay=草稿+依据+红线、safety=ACCEPT/REJECT+逐项、resolution=三值裁决+强度表、repair=修复表、research=事实清单）。`dispatch-contract.md:77` 要求统一三元组，**只有 executor 照做**。

**没有一份是可被机器判定的**：全仓 `grep` 不到任何解析 `锐评分` / `验收结论` / `ACCEPT` / `HEALTHY_EXPLORING` 的脚本代码。**框架若要求「结构化返回值」，现在需要给 12 个角色各写一个解析器——那就是 12 套契约。**

**旁证**：真实产出的落点也不在定义说的地方。`critic`/`redteam`/`review` 都声明写 `tasks/runs/<run-id>/*.md`，但实际的两份最强产出在 `docs/research/2026-11-04-notification-system-critique.md` 与 `2026-11-04-redteam-notify-fix.md`；`tasks/runs/` 下**只有 1 个 run 目录、2 个文件**（`baseline.md`、`task-graph.json`），**没有任何 review.md / redteam.md / critique.md**。也就是说：**这三条写报告约束在实践中从未被执行过。**

### 6.5 缺预算/终止的执行者

`token_budget_pct` 与 `timeout_min` 被 `validate-run.mjs:76`–`:83` 校验为「是数字」，**然后没有任何消费者**（`grep` 全仓只有 planner 定义、模板、校验器三处提到）。`maxTurns` 由宿主强制（有效），但**预算分配 = 只声明不执行**。框架需要有人（或某个 hook）在超预算时终止并回报，否则「预算」是装饰。

### 6.6 缺的三样「别的」：派发模板未拼装、baseline 模板不存在、状态归属不明

- `dispatch-contract.md:8`–`:12` 规定 prompt = 公共段 + 域段 + `templates/baseline.md`。**`templates/baseline.md` 不存在**（`ls templates/` 只有 4 份）。真实 run 里有一份手写的 `tasks/runs/2026-10-30-p0/baseline.md`，但那不是模板。
- `templates/dispatch.md` 有，但**没有任何脚本读它**（`grep -rn "templates/dispatch" scripts/*.mjs` 零命中）。三段式拼装是纯手工约定。
- **没有人拥有 run 状态**：`state.json` 在主线程手里，`task-graph.json` 在 planner 手里，`review/redteam/critique.md` 在三个判定角色手里，**没有角色负责把「这一轮走到哪了」写下来**。框架需要这个岗位，否则每轮都靠重新扫描。

---

## 七、结论：能不能直接用作「员工」

### 不能。缺的不是打磨，是三类岗位和一层接口

**这是角色设计问题与框架设计问题各一半，但**主因是框架侧**。理由：

**角色侧的问题是「职责与工具互相否定」的有 4 处**（acceptor 跑不了验收、redteam 被要求实测却无 shell、relay 唯一输入路径不可达、research 被要求实测却无 shell）。这 4 处是可以就地修的——加 `Bash`，或改掉「必须实测」的句子，二选一。**它们不是设计错误，是「写规范的人没想到工具集」的错误。**

**框架侧的问题是岗位缺失**，这部分改 prompt 改不出来：

| 缺的岗位 | 为什么现有 12 个都顶不上 |
|---|---|
| **协调者 / 管理者**（有 `Agent`） | 所有角色都是叶子；派活是操作者的动作，不是岗位 |
| **外部 harness 适配器** | 12 份 prompt 里没有一个字提到外部进程、协议、生命周期 |
| **门禁执行者**（有 `Bash`、无 `Write`） | 现有唯一「判定」角色不许跑命令 |
| **状态记账员** | 状态分散在 4 个角色 + 主线程手里，无人汇总 |

### 能直接复用的部分（不要重写）

这不是「12 份全部推倒」。以下三样是本仓最扎实的资产，**应当保留并加码**：

1. **工具白名单这一形式本身**。12 份全部显式声明 `tools:`，这是「物理边界」而非「prompt 请求」——研究结论（`2026-11-04-orchestration-patterns.md:106`）把它列为「本仓最扎实的一条」。要补的是把 `Agent` 纳入门的检查范围，并把 `tools` 变成必填。
2. **`planner` → `task-graph.json` → `validate-run.mjs` 这条链路**。这是全仓唯一「产出可被判定的岗位」，框架的工单结构应该从这里长出来，而不是另起一套 `ticket.json`。但要先修 planner 的 capability 枚举（6 值 → 12 值）和扁平 schema（加 `children`/`depth`）。
3. **`evidence-discipline.md` 的四件套 + `safety` 的逐项自证覆盖率**。`safety.md:43`–`:46` 的输出表要求每一行给草稿原文作证据——这是 12 份里唯一能自证「我真的查了 8 项」的设计，应推广到 acceptor。

### 如果一定要「能不能用」的二选一

- **作为「主线程的 12 种分工」**：能用，且已经在用（有真实产出为证）。
- **作为「框架的员工名册」**：不能用。最少要先做四件事——①给 `planner` 之外再加一个持 `Agent` 的协调角色；②给 `acceptor`/`redteam` 补 `Bash`，或删掉它们做不到的要求；③统一输出为可解析 schema（否则每个角色要配一个解析器）；④把 `check-structure.mjs` 的角色门补到能查 `Agent`、必填 `tools`、校验工具名、比对规格表。

**最后一句，也是这次审计最想说的一条**：这 12 份文件的最大问题不是某条白名单少了 `Bash`，而是**它们与规范之间没有机器连接**。`dispatch-contract.md §4` 的角色表、§7 的深度、`CLAUDE.md:14` 的硬约束 6、`planner.md:33` 的 3 层——这四处描述的是同一个不存在的递归能力，而**没有任何一条检查能发现它们都在说假话**。`checkAgentReachability` 是唯一一条真正跑起来过的角色检查，它证明「可执行的门」是有效的；问题在于它只覆盖了「有没有被提到」，没覆盖「说的和做的是不是一回事」。

---

## 附：复现方式

```bash
# 12 份的工具白名单（本报告 §三 的第一列来源）
grep -Hn "^tools:" .claude/agents/*.md

# 规格表与文件的一致性（本报告 §五 5.3 #4）
node --input-type=module -e '...'   # 见本报告溯源：按 dispatch-contract.md:44-54 的正则抽表，逐角色比对

# 深度：规范 vs 配置
grep -n "深度" docs/spec/dispatch-contract.md CLAUDE.md .claude/agents/oversight-planner.md
grep -c "Agent" .claude/agents/*.md    # 全部为 0（正文里提到 Agent 的是别的意思）

# 验收标准是否要求跑命令（这是 acceptor 矛盾的证据）
sed -n '401,424p' docs/spec/2026-11-04-notify-fix-acceptance.md

# 门禁负向测试（务必在副本上做，不要动真仓库）
cp -r .claude scripts docs templates README.md CLAUDE.md .gitignore "$TEMP/ow-audit/"
cd "$TEMP/ow-audit" && node scripts/check-structure.mjs
```

**门禁负向测试的具体变异**（本报告 §五 5.2 的 T1–T6）：改 `tools:` 行后重跑 `node scripts/check-structure.mjs`，看 exit code 与 `✗` 行。T2 与 T4 是最值得复验的两条：**删掉整行 `tools:`、给 planner 加 `Edit, Bash`**——两者都应当 fail，现在都通过。
