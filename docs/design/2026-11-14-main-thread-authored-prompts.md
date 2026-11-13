# 多 agent 的提示词该由主线程写：分层、分界、与可机械检验的质量判据

- 日期：2026-11-14
- 角色：设计 Agent N2
- 产出形态：**artifact**（机制设计 + 可运行原型 `scripts/compose-agent-prompt.mjs` + 50 条测试 + 本文）
- 用户原话：**「多 agent 的提示词应该由主线程 agent 编写」**
- 已读（逐份）：`.claude/agents/*.md` 12 份、`templates/dispatch.md`、`templates/acceptance-criteria.md`、
  `templates/baseline.md`、`docs/spec/dispatch-contract.md`、`docs/spec/evidence-discipline.md`、
  `docs/spec/output-format.md`、`.claude/skills/oversight/SKILL.md`、
  `docs/research/2026-11-14-prompt-based-multiagent-limits.md`、
  `docs/research/2026-11-10-agent-roles-audit.md`、`scripts/claim-ledger.mjs`、
  `scripts/validate-run.mjs`、`scripts/project-commands.mjs`、`scripts/check-structure.mjs`。
- **没有修改**那 12 份角色定义，没有碰 git，没有动 `tasks/runs/` 下既有运行台账。

> **本文不是「应该让模型自由发挥写提示词」。** 恰恰相反：结论是**主线程该写的范围比想象的小得多**，
> 而「让它写」的目的不是增加自由，是**让不该由人写的那部分不再由人写**。

---

## 0. 结论先行

**1. 「由主线程编写」这句话拆开是四层，只有一层真该由主线程写。**

| 层 | 内容 | 谁写 | 依据 |
|---|---|---|---|
| **L0 身份** | 角色正文（职责边界、禁止事项、输出形状） | **人，冻结** | 同一角色跨任务必须逐字一致；一旦随任务变，「acceptor」就不再是岗位 |
| **L1 协议** | `templates/dispatch.md` 的四输入 / 纪律 / 返回四元组 / 对账 | **仓库，冻结** | 同一个 run 里每份必须一字不差，否则分歧会被误当成发现 |
| **L2 现写** | 任务、验收标准、约束、停机条件 | **主线程，每个任务现写** | 「换一个任务就会错」的那部分——这才是用户说的「编写」 |
| **L3 注入** | 构建/测试命令、硬门输出、outputs、nonce、上次失败模式 | **机器从仓库状态派生** | 能派生的绝不手写：手写就多一个会漂的第二事实源 |

**主线程的工作从「照模板填空」变成「只写 L2」**。这不是把模板填得更好，是**把可派生的部分从人手里拿走**。

**2. 今晚那条矛盾的真正修法不是给 acceptor 加 `Bash`。**

实测确认（`scripts/compose-agent-prompt.mjs` 的 `roleTools()` 对着真实文件跑）：
`oversight-acceptor` 的 tools 是 `Read, Grep, Glob, Write`，没有 `Bash`。
而 `docs/spec/2026-11-02-autorelay-acceptance.md:375-376` 与
`docs/spec/2026-11-04-notify-fix-acceptance.md:404-409` 的「第三方复算清单」标题就叫
**「判定前必须逐条跑」**。**它跑不动任何一条，唯一能给出的诚实结论是「不通过」。**

更硬的一点：**这道矛盾是被硬门强制的**。`scripts/check-structure.mjs:37` 的
`READONLY_ROLES = ['acceptor', 'probe', 'safety', 'review', 'redteam', 'critic']`
与 `:203` 的判据「只读角色不得拥有 Edit/Bash」——给 acceptor 加 `Bash` 会让结构门变红。
所以「加个工具」这条路是**关着的**，理由也正当：验收者一旦能跑会改东西的命令，它就不再是验收者。

**正确的修法是第三条路：让主线程在派发前把那条命令跑掉，把输出作为事实注入。**
验收因此从「跑命令」变成「读一份已落盘的输出并核对」，`acceptor` 保持只读，
而它现在有了可判定的证据。原型把这条路做成了**机械检查**（见 §3.2）。

**3. 质量保证的可行判据只有一种：把验收标准变成「可执行的需求」，再和工具白名单做比对。**

散文标准（「代码质量良好」）无法机械检验。但「这条 AC 要求跑哪条命令 / 读哪个文件 / 还是纯判断」
**是可以分类的**——`classifyRequirement()` 三分类（command / file / decision），
而每个分类有明确的工具需求。于是：

```
验收需求（command） → 需要 Bash
角色白名单          → acceptor 没有 Bash
⇒ 判不通过，并给出两条出路
```

这条判据**在派发前**就能算出来，不依赖任何模型自述。这是本文最实在的产出。

**4. 提示词本身可以像 `claim-ledger` 一样对账——而且前提已经被实测过。**

compose 时把成品 hash 记进 `prompts.jsonl`；收活时从子 agent transcript 的
**第一条 user 消息**取正文重算 hash。这条链成立的前提我**亲自复核**了：
本机同一会话的 40 份子 agent transcript，首条 user 消息与父会话 `Agent` 工具调用的
`prompt` 参数 **40/40 逐字节相同**（另有 77 条父级 `Agent` 调用带 `prompt` 字段可对上）。
所以「主线程写了什么」与「子 agent 收到什么」有唯一的交汇点，且可离线复算。

---

## 1. 现在到底是怎么运作的（事实，不是推测）

### 1.1 三段式拼装是**纯手工约定**，没有任何脚本读过它

`docs/spec/dispatch-contract.md:8-12` 规定：

```
prompt = templates/dispatch.md（公共段）
       + planning 现写（域专属）
       + templates/baseline.md（当轮事实快照）
```

而 `docs/research/2026-11-10-agent-roles-audit.md:295` 的实测是
**`grep -rn "templates/dispatch" scripts/*.mjs` 零命中**。
也就是说三段拼装全靠主线程记得，缺一段**没有任何东西会报错**。

我复核了这一条（本轮 `grep` 结果一致），并且它的后果是可指的：

| 漏掉的部分 | 后果 | 是否静默 |
|---|---|---|
| `<nonce>` 没填 | `claim-ledger observe` 归属失败，产出对账判 `EMPTY` | **是**——observe 只打印「扫了 N 份，没有一份能归属」 |
| `outputs` 没给 | `verify` 判 `NO-EXPECTATION` | **是**，直到收活时才发现 |
| 停机条件没写 | 产出退化成骨架（见 §1.2） | **是**，且看起来像「模型不行」 |

### 1.2 停机条件是唯一被实测证明能提高完成率的干预

`docs/research/2026-11-14-prompt-based-multiagent-limits.md` §3.4 的对照：

| | 宽任务（slice-16） | 窄任务（S04 变量对账） |
|---|---|---|
| 任务书 | 「扫 6 个维度、两个 970 行文件、12 分钟内返回」 | 「只跑一条 grep，记录命中行，不做推断，5 分钟返回」 |
| 最终产物 | 9 分钟后仍是 **75 字节骨架** | **5 分 25 秒完成，7,138 字节** |
| 工具调用数 | 大量只读分析 + 自我推翻线索 | **3 次** |

原话：「**差异不在模型能力，在任务是否有明确的停机条件**」。
同一份材料里还有整批证据：「要求『贴 grep 输出』的 6 个切片全部完成，
要求『扫 6 个维度』的宽任务 3 次全部超时」（同文 §3.4 引 `wave2a-sweep.md:442`）。

**所以停机条件不能是「建议包含」，必须是「没有就拒绝派发」**——原型把它做成了硬检查。

### 1.3 12 份角色定义的形状（我逐份读过）

| 角色 | tools | 职责 | 定义里要求它做的事，工具够不够 |
|---|---|---|---|
| `planner` | Read, Write, Glob, Grep | 拆解 + 声明 AC/形状/预算 | 够（只写 JSON） |
| `executor` | Read, Write, Edit, Bash, Glob, Grep | 实质执行 | 够 |
| `research` | Read, Grep, Glob, WebSearch, WebFetch | 外部事实 | **不够**：`:22` 写「优先实测」，无 Bash |
| `critic` | Read, Grep, Glob, Write | 质疑拆解与前提 | 够（读图 + 写 critique） |
| `redteam` | Read, Grep, Glob, Write | 攻击交付物 | **不够**：`:58` 要「跑命令、写小测试」，无 Bash |
| `review` | Read, Grep, Glob, Write | 质量评分 | 够（读交付物） |
| `acceptor` | Read, Grep, Glob, Write | 对照 AC 判定，一票否决 | **不够**：外部 AC 写「判定前必须逐条跑」，无 Bash |
| `repair` | Read, Write, Edit, Bash, Glob, Grep | 修被指出的问题 | 够 |
| `probe` | Read, Grep, Glob | 三选一判活性 | 够（只读日志） |
| `relay` | Read, Grep, Glob, Write | 接力草稿 | **不够**：`:23` 让读收件箱（`watch.mjs --inbox`），无 Bash |
| `safety` | Read, Grep, Glob | 红线检查 | 够 |
| `resolution` | Read, Grep, Glob, Write | 裁决分歧 | 够 |

**12 份里有 4 份是「职责与工具互相否定」**（research / redteam / acceptor / relay），
这不是巧合，是同一个结构性成因：**写角色定义的人不知道调用方会给它什么工单**，
于是把「最好能做到」写进了职责，把「保守一点」写进了 tools。
两者从来没有人核对过——直到现在也没有，因为**核对需要同时看两边**。

> **这正是 L2 该由主线程写的真正理由**：只有它同时握着「这次的任务」和「这个角色的能力」。
> 角色定义那边看不见工单，工单那边看不见白名单。**分层不是为了分工，是为了让这两样在派发前相遇。**

### 1.4 一条反驳我自己的证据（必须写）

`docs/research/2026-11-14-prompt-based-multiagent-limits.md` §3.7 有一条刺眼的实测：

> **并集只比最好的单个 agent 多 1 条。** 四个 agent 合起来几乎没超过最好的那个。
> **没有哪个 agent 找到别人完全找不到的独特东西**——最多是「有人漏了某条，别人补上」。
> 这说明分歧的来源是**覆盖遗漏**，不是**视角差异**。

如果分歧主要来自覆盖遗漏，那么「把提示词写得更好」的边际收益可能**小于**「多派一个 agent」。
这条直接约束了本文的野心：**分层设计不承诺提高审计质量**，它承诺的是三件更窄的事——
① 消灭「职责与工具互斥」这一类必错；
② 消灭三段拼装的静默漏项；
③ 让提示词可对账（可复算，而不是可相信）。

---

## 2. 分层设计

### 2.1 分界规则（两条，其余都从它们推出来）

**规则一：机器能派生的，绝不手写。**
手写一个可派生的数字，就多了一个会漂的第二事实源。
`docs/spec/output-format.md:32` 已经为状态行立过这条规矩：
「手写的状态行会随模型心情变化……这比没有状态行更坏——它自带格式可信度，用户无法区分真假」。
提示词里的「本项目用 `mvn` 不是 `npm`」是同一类东西：`scripts/project-commands.mjs`
能从 `pom.xml` / `package.json` 读出来，让人抄一遍只会抄错。

**规则二：L0 是「同一角色跨任务必须逐字相同」的那部分。**
判据很硬：如果某个内容**随任务变**，它就不是身份，是一次性的措辞。
`acceptor.md` 里「你只判定，不改稿。你有一票否决权」是身份；
「本次要判这四条 AC」不是。

### 2.2 四层清单

```json
{
  "role": "acceptor",
  "task": "<L2 现写：本次任务，逐字>",
  "context": { "<L3 注入：从工单/产出派生>" },
  "constraints": ["<L2 现写：本项目的具体约束>"],
  "acceptance": [{ "id": "AC1", "criterion": "", "evidence": "", "fail_if": "" }],
  "stop_condition": "<L2 现写：可判定的停机条件>",
  "layers": {
    "L0": { "source": ".claude/agents/oversight-acceptor.md", "author": "人（冻结）", "in_prompt": "只放指针" },
    "L1": { "source": "templates/dispatch.md", "author": "仓库（冻结）", "in_prompt": "逐字内联" },
    "L2": { "source": "task-graph.json 的子树 + 手写段", "author": "主线程" },
    "L3": { "source": "project-commands / outputs / claims / git", "author": "机器" }
  }
}
```

**为什么 L0 只放指针、不复制正文**：复制会让角色定义出现第二个副本，
两份必然漂移（`docs/research/2026-11-10-agent-roles-audit.md` 记的 `agent-memory` 多份分叉是同一个病）。
宿主本来就加载 `.claude/agents/*.md`，复制的唯一效果是制造第二真源。

**为什么 L1 必须逐字内联、不能引用路径**：子 agent 的独立性要求「它不会去读别的文件」。
`dispatch.md` 里有「你不会收到的东西」与「四条最容易犯的错」——那是**必须出现在它眼前**的内容。

**为什么 L3 放最后**：它是唯一可能被误当结论的一层（硬门输出、上次失败模式）。
放在 L2 之后，读者先看到「要判什么」，再看「已有什么事实」。

### 2.3 哪些该现写、哪些该模板化（直接回答用户的问题）

| 内容 | 该现写？ | 理由 |
|---|---|---|
| 角色身份、职责边界、禁止事项 | **不，写死在 L0** | 跨任务必须一致；变一次就不再有可比性 |
| 输出格式、返回四元组 | **不，写死在 L0/L1** | 格式是约定，写清楚了就能执行（§5.2 的判断标准） |
| 证据纪律（四件套、覆盖声明） | **不，写死在 L1** | 同上 |
| **本次任务** | **是，L2** | 只有主线程知道这次要干什么 |
| **验收标准** | **是（但可回填），L2** | 见下：标准必须预先声明，但**可以从工单半自动生成** |
| **停机条件** | **是，L2，且强制** | 唯一被实测证明有效的干预 |
| **本次约束**（"用 mvn 不是 npm"） | **不，L3 派生** | 机器能读，人写只会错 |
| 硬门输出 | **不，L3 注入** | 机器能跑；人跑一遍再抄一遍是两次出错的机会 |
| outputs / nonce | **不，L3 派生** | 同上，且 nonce 抄错是静默失败 |
| 上次失败模式 | **不，L3 派生** | 从 `claims.jsonl` / 上一轮验收结论读 |

**「验收标准」这一行是唯一需要细说的。** 它必须**预先声明**（硬约束 4），
但「预先声明」不等于「必须人手写」。`planner` 已经把 `acceptance[]` 写进 `task-graph.json` 了。
所以主线程的活是**补齐与检查**（有没有 `fail_if`、能不能观测、需要什么工具），不是从零编。

---

## 3. 主线程的写作流程（具体到读什么、写到哪、怎么传）

### 3.1 流程

```
① 读 task-graph.json 的单个子树          → goal / acceptance / shape / outputs / timeout_min
② 读对应角色定义                          → tools（**只读 frontmatter，不改它**）
③ 分类每条 AC                             → command / file / decision
④ 逐条比对 ③ 与 ②                         ← 今晚那条矛盾在这里被发现
   不满足 → 主线程去跑那条命令，把输出落盘，作为 --gate 注入
⑤ 派生 L3（项目命令 / outputs / nonce / 上次失败）
⑥ 填 templates/dispatch.md 的具名占位符    ← 任何一个没填就拒绝派发
⑦ 拼成一份 markdown（L0 指针 → L1 → L2 → L3）
⑧ 记 hash 进 prompts.jsonl，打印配套的 claim-ledger declare 命令
⑨ 把正文作为 Agent 工具的 prompt 参数发出去
```

第 ④ 步是新增的，也是全程唯一需要判断力的一步。其余都是机械的。

### 3.2 第 ④ 步的判据（这是整份设计的核心）

```
AC 要求跑一条命令（`node scripts/x.mjs`、`npm run t`、`mvn verify`）
  → 需要 Bash
角色白名单里有没有 Bash？
  有 → 通过
  没有 → 两条出路：
         ① 换角色（如果这个 AC 本来就该由能跑命令的角色做）
         ② 主线程跑一次，把输出落盘，作为 --gate 注入
            → 验收从「跑命令」变成「读一份已落盘的输出并核对」
```

**为什么 ② 是正解而不是妥协**：`acceptor` 不该有 `Bash` 的理由是「验收者一旦能改东西就不再是验收者」。
注入方案保住了这条性质，同时让它有了可判定的证据。
**注入只覆盖它声明的那一条命令**——一条注入不会放行所有命令类 AC（原型有专门的回退测试守这条）。

### 3.3 写到哪

| 产物 | 路径 | 为什么 |
|---|---|---|
| 提示词正文 | `tasks/runs/<run-id>/<task>-<role>.prompt.md` | 与 `task-graph.json` 同目录；`tasks/runs/` 已 gitignore（含会话 ID） |
| 提示词台账 | `tasks/runs/<run-id>/prompts.jsonl` | 与 `claims.jsonl` 同目录、同一 append-only 纪律 |

**一个真实的坑（原型里修过）**：台账最初跟着 `--root` 走，而 `--root` 决定的是
「去哪里找角色定义与模板」。两者绑在一起会让台账写到一个与 run 无关的地方，
而 `verify` 去那里找时**报的是「从没记过」**——「写成功」和「没写」长得一模一样。
改为**跟 `task-graph.json` 同目录**。这与 `claims.jsonl` 的落点选择是同一条理由。

### 3.4 怎么传给子 agent

`Task` / `Agent` 工具的 `prompt` 参数，正文就是 compose 的产物。
**实测前提**（我本轮复核）：本机同一会话 40 份子 agent transcript，
首条 user 消息与父会话 `Agent` 调用 `prompt` **40/40 逐字节相同**。
所以：

- compose 记录的 hash = 主线程写的字节
- transcript 首条消息的 hash = 子 agent 收到的字节
- 两者相等 ⇒ 「发出去的确实是这一份」

**这不依赖子 agent 配合**——和 `claim-ledger observe` 同理，痕迹在 transcript 里，不由它自述。

---

## 4. 质量保证机制

### 4.1 必须有的元素（九条，每条都可机械判定）

| # | 元素 | 判据 | 缺了会怎样 |
|---|---|---|---|
| 1 | `role` | 非空，且 `.claude/agents/oversight-<role>.md` 存在 | 身份由措辞临时定义 |
| 2 | `task` | 非空且 ≥6 字符 | 转述会被优化成错误目标 |
| 3 | `acceptance` | 非空；每项含 `id/criterion/evidence/fail_if` | 标准事后编（硬约束 4） |
| 4 | `shape` | ∈ `artifact/exploration/hybrid` | 无法判「久无写入是否异常」（硬约束 8） |
| 5 | `outputs` | `artifact` 时必须非空 | 收活对账判 `NO-EXPECTATION` |
| 6 | `stop_condition` | 含命令 / 数字配额 / 时间上限之一 | 产出退化成骨架（§1.2 实测） |
| 7 | `nonce` | 8 位十六进制 | `observe` 归属失败，且**静默** |
| 8 | `tool_compat` | 验收需求 × 工具白名单，见 §3.2 | 子 agent 只能判「不通过」（今晚那条） |
| 9 | `independence` | 未注入该角色被禁止的上下文 | 锚定无法用 prompt 撤销（契约 §3） |

**这张表刻意只收了判得了的。** 判不了的规则不配进这张表——它会退化成一句「请务必包含」，
而「规则存在」与「规则生效」之间隔着一个人工实现的第三层（同文 §3.3 的原话）。

### 4.2 能不能自动检查？能，而且「检查不过就不落文件」

`compose` 的退出码就是判据：**exit 1 时不写提示词、不记台账、不打印发出去的指令。**
这一条的措辞是刻意的：

> 不落文件，也不记台账——一份检查不过的提示词发出去，子 agent 会照着错的做，而且主线程不会知道。

「acceptance 为空就拒绝派发」是这条规则的一个特例，不是全部。
原型里 8 条回退测试专门验「反过来必须拒绝」，因为只断言「现在通过」的测试挡不住下次重构把它删掉。

### 4.3 产出的提示词也可对账（`claim-ledger` 的同构）

| | `claim-ledger` | `compose-agent-prompt` |
|---|---|---|
| 期望 | `declare --paths`（派发前） | `compose` 记 hash（派发前） |
| 事实 | 磁盘 / 自述 / transcript | transcript 首条 user 消息 |
| 对账 | `verify` 四方交叉 | `verify` 比 hash |
| 找不到时 | 「这不是没有产出，是看不到」 | 「这是看不到，不是通过」 |

第三行最后一条是最重要的：**`match: null`（找不到 transcript）与 `match: false`（找到了但不是这一份）
必须分开**。混成一个「对不上」会让「transcript 还没落盘」和「prompt 被人改过」长得一样。

### 4.4 这套机制**不能**保证什么（诚实边界）

1. **不能保证提示词「写得好」。** 它只保证「该有的都有」和「工具够用」。
   一份九项全绿但任务描述写得含糊的提示词，照样会产出骨架。
2. **不能替代验收。** hash 对得上只证明「发出去的是这一份」，不证明「这一份是对的」。
3. **不能从根上消灭 §1.3 的四条矛盾。** 它只能**在派发时拦住**，让主线程去选择
   「换角色」还是「注入证据」。角色定义本身要不要改（比如给 `research` 加 `Bash`），
   是另一个决定，本文不替它做（理由见 §6）。
4. **认不出项目类型时只能如实说不知道。** 本仓库没有 `package.json` / `pom.xml`
   / `build.gradle` / `Cargo.toml` / `go.mod` / `pyproject.toml`，所以
   `detectProjectCommands()` 返回 `unknown`——原型注入的是
   「未识别出测试命令（不是「没有测试」，是「我没认出来」）」。这是**已知缺口**，见 §6。

---

## 5. 最小可行原型

### 5.1 它是什么

`scripts/compose-agent-prompt.mjs`（零依赖，两个子命令）：

```bash
# 派发前：生成 + 检查
node scripts/compose-agent-prompt.mjs compose --run <run-id> --task ST1 \
  --graph tasks/runs/<run-id>/task-graph.json --role acceptor \
  --stop "每项 AC 必带 file:line；找不到证据即判不通过；25 分钟内返回" \
  --gate "node scripts/check-structure.mjs=tasks/runs/<run-id>/gate-structure.txt" \
  --gate-exit 0 --out tasks/runs/<run-id>/ST1-acceptor.prompt.md

# 收活时：核对子 agent 收到的就是这一份
node scripts/compose-agent-prompt.mjs verify --run <run-id> --session <会话目录>
```

退出码：0 通过 / 1 检查不过或对不上 / 2 用法错误。

### 5.2 它在真实角色定义上的实际输出（本机真跑，非编造）

对着 `oversight-acceptor.md` 与一份含命令类 AC 的任务图：

```
compose · task ST1 · role acceptor
  ✓ role — 角色 acceptor
  ✓ task — 任务书 41 字符
  ✓ acceptance — 2 项，每项含 id/criterion/evidence/fail_if
  ✓ shape — artifact · 1 个产出路径
  ✓ outputs — 1 个路径
  ✓ stop_condition — 可判定：每项 AC 必带 file:line；找不到证据即判不通过；25 分钟内返回
  ✓ nonce — nonce 1fa47693
  ✗ tool_compat — 需要 Bash 但角色没有，且未注入其输出 → AC1: `node scripts/check-structure.mjs`。
                  两条出路：① 换成有该工具的角色；② 若确实不该给它，就把该命令的结果作为注入证据（--gate）
  ✓ independence — 未注入 self_assessment/execution_log/weak_points/review_score

✗ 拒绝派发：1 项
```

加上 `--gate`（主线程真的先跑了 `check-structure.mjs` 并把输出落盘）之后：

```
  ✓ tool_compat — 已覆盖 `node scripts/check-structure.mjs`（L3 注入）
✓ 通过（6749 字节）
已写入：tasks/runs/r1/ST1-acceptor.prompt.md
提示词 hash：643765536ee66c9b…（已记入 prompts.jsonl）

配套的产出期望登记（nonce 与提示词里的是同一个）：
  node scripts/claim-ledger.mjs declare --run r1 --task ST1 \
    --paths tasks/runs/r1/verdict.md --role acceptor --nonce 1fa47693 --timeout-min 25
```

**最后那段是有意的**：nonce 由 compose 生成并打印成**可直接粘贴的整条命令**。
让人拼参数就是让 nonce 有机会对不上，而两份台账（`prompts.jsonl` 与 `claims.jsonl`）靠它对齐。

### 5.3 它生成的提示词长什么样

```
<!-- 由 compose-agent-prompt.mjs 生成 · task ST1 · role acceptor · nonce 1fa47693 -->
## 0. 身份（L0）           ← 只放指针，不复制角色正文
## 1. 派发公共协议（L1）    ← templates/dispatch.md 逐字，占位符已填
## 2. 本次任务（L2）
   2.1 验收标准           ← 表格，多一列「怎么核实」（命令 / 读哪个文件 / 纯判断）
   2.2 本次约束
   2.3 停机条件
## 3. 本项目事实（L3）      ← 机器注入，注明「与其他地方矛盾时以这里为准」
```

L2.1 多出来的那一列「怎么核实」是 L3 的产物：有注入时写「已在 L3 注入输出——读那份输出核对，不必自己跑」，
没有时写「需跑 `xxx`」。**子 agent 因此不需要自己推断该不该跑命令。**

### 5.4 测试

`scripts/compose-agent-prompt.test.mjs`，50 条。重点不是「现在通过」，是**回退断言**：

- 对着**真实的** 12 份角色定义断言 acceptor 没有 `Bash`（并断言它一旦有了，这份原型的主要理由就消失）
- acceptor + 命令类 AC + 无注入 ⇒ **必须拒绝**，且错误里必须同时给出两条出路
- 同一条 AC + 注入 ⇒ **必须通过**
- 注入只覆盖它声明的那条命令（两条 AC 只注入一条 ⇒ 另一条必须被点名报出来）
- 台账 hash 必须与落盘字节一致；`verify` 的 `null`（看不到）与 `false`（不是这一份）必须分开
- 检查不过时**不落文件、不记台账**（否则就是「发出去但主线程不知道」）

---

## 6. 没做的事 / 已知缺口（诚实声明）

1. **没有改那 12 份角色定义。** 用户明确说不要改。§1.3 的四条矛盾我**提议**这样处理：
   - `acceptor`：**不改**。它的只读性是设计意图，且硬门强制。用注入方案。
   - `redteam` / `research`：`redteam` 的定义里写着「必须实际验证至少 3 条（跑命令、读数据、写小测试）」，
     `research` 写着「优先实测」。这两条与「无 Bash」直接冲突。**建议二选一**：
     要么加 `Bash`（但 `READONLY_ROLES` 会拦，需要同时评估它是否还该算只读），
     要么改掉那两句（明确「实测由主线程注入」）。**这是一个决定，不是一次编辑**，本文不替用户做。
   - `relay`：它的输入契约（「先读收件箱」）与工具集自相矛盾，且 `SKILL.md` 又禁止它自己重扫。
     建议后者优先——即改掉 `relay` 的输入契约，让主线程把收件箱内容逐字传给它。
2. **本项目自身认不出构建系统。** 本仓没有 `package.json`，`detectProjectCommands()` 返回 `unknown`，
   所以 L3 注入的「构建/测试命令」是「未识别出」。**建议**在 `project-commands.mjs` 里加一条
   「有 `scripts/*.test.mjs` 且无其他标志文件 ⇒ `node --test scripts/*.test.mjs`」。
   本轮**没做**——它会改变一个已被 43 条测试钉住的模块的行为，属于另一件事。
3. **没有做真实多 agent 跑通验证。** 原型的验证是「对着真实角色定义与真实任务图跑判定」，
   **不是**「真的派一个子 agent 出去看它是否因此表现更好」。后者成本高且需要另一次实验设计。
   本文所有关于「完成率」的数字都引自既有研究，标了出处，**我没有重跑**。
4. **`extractCommands` 是启发式的，会漏。** 它只认首词是已知命令动词的片段（`node/npm/mvn/gradle/...`），
   刻意的。漏检的后果是「某条命令类 AC 被当成文件类」，从而放过一条本该拦的矛盾。
   反向（把散文当命令编出一条不存在的命令）更坏，所以选了保守方向。这是权衡，不是完善。
5. **没有把 compose 接进 `SKILL.md` 的 Phase B。** 接进去会改调度入口的行为，
   而这轮的目标是「机制设计 + 可运行原型」。接法很清楚：Phase B 第 2 步之前插一次 compose，
   退出码非 0 就停下。**建议下一轮做**，并且要配一条硬门（否则它和 `templates/dispatch.md` 一样没人调用）。

---

## 7. 一句话回答用户的三个问题

**分层**：四层——L0 身份（人，冻结）/ L1 协议（仓库，冻结）/ L2 现写（主线程）/ L3 注入（机器）。

**哪些该现写**：任务、验收标准（从工单补齐而非从零编）、停机条件、本次约束里机器读不出来的部分。
**哪些该模板化**：角色身份、职责边界、输出格式、证据纪律。
**哪些该自动注入**：构建/测试命令、硬门输出、outputs、nonce、上次失败模式。

**质量怎么保证**：把那九条变成机械判据，检查不过就**不落文件、不记台账**；
核心一条是把验收标准分类成「跑命令 / 读文件 / 纯判断」再和工具白名单比对——
这是今晚那条矛盾唯一能在**派发前**算出来的形态。提示词本身记 hash，收活时从 transcript
首条 user 消息重算，`null` 与 `false` 分开报。
