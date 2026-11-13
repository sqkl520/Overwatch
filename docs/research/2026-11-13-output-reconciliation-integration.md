# 产出对账接进派发链路：四项落地 + 一个诚实的边界

- 日期：2026-11-13
- 角色：执行 Agent OL2
- 产出形态：`artifact`
- 前置：`docs/design/2026-11-13-output-reconciliation.md`（判定层与工具层已完成，§7 未实现）

> 一句话：本轮把设计 §7 的四项**全部落地并跑通**。整条链 `validate-run` →
> `declare` → `claim` → `observe` → `verify` → `consume` 在真实 run 数据上 exit 0；
> 两处硬机制各做了一次真实回退，对应测试确实变红。
>
> 但最后那个问题（「能防住产出丢失吗」）的答案是**有条件的是**，条件写在 §6，不含糊。

---

## 1. 四项各改成了什么样

### 7.1 `task-graph.json` 加 `outputs: string[]`

改 `scripts/validate-run.mjs`：

- 新增导出 `checkOutputs(st)`（判据集中一处）、`outputPathError(p)`（单路径判据）、
  `outputPathKey(p)`（比较用归一化）、常量 `SHAPES_REQUIRING_OUTPUTS = ['artifact']`。
- `validateGraph` 对每个子树调用 `checkOutputs`，把结论并进 errors/warnings。
- 新增两个导出已登记进 `check-structure.mjs` 的 `PROBE_ARGS`（真实调用一次）与 `REGISTERED`。

**取舍：必填，不是选填。** 理由三条：

1. `outputs` 是收活时对账的**唯一期望来源**（`claim-ledger declare --paths` 直接吃它）。
   选填的话，planner 少写一行，`verify` 只能判 `NO-EXPECTATION`——而那时已经是**收活时**，
   没有期望就无从补，无从补就分不清「没产出」和「产出了没传过来」。
2. 这与硬约束 4（验收标准必须预先声明）是同一条结构：**期望必须早于结果存在**。
   选填等于允许某些派发永远没有期望。
3. **代价实测为零**：仓库里唯一的历史图 `tasks/runs/2026-10-30-p0/task-graph.json`
   本来就不合法（缺 `token_budget_pct` / `parallel_with` / `depends_on`，改动前跑就已经 exit 1）。
   `tasks/runs/` 又是 gitignored 的运行台账，没有对外兼容义务。

**另外加了一条比设计要求更严的**：`shape: artifact` 时 `outputs` 不得为空数组。
不加这一条，写 `[]` 就是绕过必填最省事的写法，而 `artifact` 的字面含义本来就是
「落到磁盘的交付物」。`exploration` / `hybrid` 允许空数组——它们按定义不承诺文件。

**校验规则**（每条都有正反用例）：必须是数组；元素必须是字符串；不能空/纯空白；
不能首尾带空白；不能是绝对路径（`C:\`、`C:/`、`/`、`\\server`、以及 Windows 的
驱动器相对形态 `C:a.md`）；不能含 `..`；不能以分隔符结尾。

绝对路径用**正则**判而不是 `path.isAbsolute`：`C:\repo\a.md` 在 Linux CI 上
`isAbsolute` 返回 false，同一个派发图在开发机与 CI 会得到两个结论。这道门必须与平台无关。

跨子树重复路径只 `warn` 不 `error`：静态图里两次声明几乎总是规划错误，但真正的判定权
留给 `claim-ledger` 的 `CONFLICT`（它有自述与痕迹，能看到真正发生了什么）。

### 7.2 派发模板加 nonce 段

改 `templates/dispatch.md`：

- 「输出格式（强制）」从三元组改为四元组，行数上限 15 → 18（多出来的三行是给对账的，不是给叙述的）。
- 新增「## 产出登记（必须做）」：登记路径占位、可抄的 `claim` 命令、nonce 段落。
- 新增「## 我产出的文件」的格式与纪律。

nonce 那段的原文（关键句加粗处是刻意的）：

```
**不执行也不会漏**——主线程会读你的 transcript（`claim-ledger observe` 靠下面那个 nonce
把你写过的文件一条条抽出来）。执行了只是让对账多一条「内容没被人改过」的证据
```

后面还写了一句理由，因为不写理由的纪律会被下一个维护者当成仪式删掉：

> 如果这里写「必须 claim 否则算失败」，等于又造了一条自述通道——而自述正是这次要治的病。
> `claim` 是**加分项**（提供 hash），不是**准入项**。

**nonce 假设已实测验证，成立，且是逐字节的。** 见 §3。

### 7.3 角色定义改四元组

改 `.claude/agents/oversight-executor.md`、`.claude/agents/oversight-repair.md`：

- 「## 输出」节增第四项「## 我产出的文件」，格式 `- <路径> —— <字节数>`（或「无」）。
- 新增独立一节「## 我产出的文件」，明写：**不是给你自我评价用的，是给主线程对账用的。
  写错路径比不写更糟**，并给了两种错误的**不同后果**：
  - 写「无」而实际写了 → 从 transcript 能发现，判 `UNREPORTED`，只是多一步；
  - 写了不存在的路径 → 判 `MISSING`，主线程去查一个根本不存在的东西，真正的问题被掩盖。
- 「## 禁止」各加一条：不得为让返回看起来完整而写没写过的路径。

**`tools` 缺 `Bash` 的问题：不存在，不需要解决。** 两个角色的白名单实测都是
`Read, Write, Edit, Bash, Glob, Grep`，`claim` 命令跑得起来。（派单里预判可能缺，
复核后不缺。设计 §1.1 的表格也没说它们缺，缺的是 `acceptor` / `probe` / `safety` /
`review` / `redteam` / `critic` 那六个只读角色——它们不写文件，也就不需要 `claim`。）

我**没有**选「Write 一个 claim 文件」那条路：它要另造一种记录格式、另写一套读取逻辑，
而 `claim-ledger` 的台账已经是 append-only JSONL、已进硬门、已有 49 条测试。
为一个不存在的问题多造一套机制，只会多一个会漂的东西。这条判断被测试固定住了：
`reconciliation-wiring.test.mjs` 有一条专门断言两个角色的 `tools` 含 `Bash`——
防止将来白名单被收窄时，角色定义里那句命令**悄悄变成一句跑不起来的指示**。

### 7.4 验收前加对账

改 `.claude/skills/oversight/SKILL.md`，新增 `## 4.5 Phase D：收活前对账`，位置在
Phase C 与 Phase E 之间（不是文件末尾——位置本身是判据，测试断言
「verify 必须出现在 `## 5. Phase E` 之前」）。

内容：

```bash
node scripts/claim-ledger.mjs verify --run <run-id> || exit 1
```

`PARTIAL` / `MISSING` / `CONFLICT` 不进入验收，并逐结论给处置：

| 结论 | 怎么做 |
|---|---|
| `PARTIAL` | 续做缺的那几个（不要整轮重跑——重复劳动会覆盖已落地的部分） |
| `EMPTY` | 重新派发——可能是派发本身就没成功 |
| `MISSING` | 退回该 Agent，要求说清文件写到哪去了 |
| `CONFLICT` | 停下，人工裁决谁拥有那个文件；期间不验收 |
| `UNREPORTED` | `consume` 认领后继续——产出在，只是它没自报 |
| `NO-EXPECTATION` | 退回 planner 补 `outputs`，重跑 `validate-run.mjs` |

**理由写进了文档**（任务书要求的那句，一字未改）：

> 验收一个不完整或身份不明的交付物，等于给虚假的通过盖章。

并逐条展开为什么：`PARTIAL` 会让验收 Agent 对着「不完整」判不通过、修复 Agent 去修一个
其实只是没跑完的活；`CONFLICT` 时磁盘上那份是谁写的说不清，通过的是「碰巧最后写入的那一份」；
`MISSING` 最坏的结果是它通过了，因为验收 Agent 读到的是返回文本，而文本里写着路径。

另外补了两处 Phase B 的接线（否则 §4.5 是空转的）：

- Phase B 明说要先跑 `declare`、把 nonce 拼进 prompt；
- §4.5 明说 `declare --paths` 必须**直接取自 task-graph 的 `subtrees[].outputs`**，
  不许主线程现编——现编的期望等于事后编造验收标准。

---

## 2. 落地清单

| 文件 | 改了什么 |
|---|---|
| `scripts/validate-run.mjs` | `outputs` 必填校验 + 3 个新导出 + 1 个新常量 |
| `scripts/validate-run.test.mjs` | +12 用例（合法/非法路径、缺失、空数组、跨子树重复、1 条真实回退） |
| `scripts/reconciliation-wiring.test.mjs` | **新文件**，18 用例：7.2 / 7.3 / 7.4 的接线 + 3 条回退断言 |
| `scripts/claim-ledger.test.mjs` | +3 端到端 CLI 用例（含 nonce 归属的真实夹具） |
| `templates/dispatch.md` | 四元组 + 产出登记节 + nonce 段 |
| `.claude/agents/oversight-executor.md` | 四元组 + 「我产出的文件」节 |
| `.claude/agents/oversight-repair.md` | 同上（并区分「修复后的交付物」与「这次动过的全部文件」） |
| `.claude/agents/oversight-planner.md` | schema 加 `outputs`、规则 8、字段说明 |
| `.claude/skills/oversight/SKILL.md` | 新增 §4.5 Phase D + Phase B 接线 |
| `scripts/check-structure.mjs` | 新导出登记（PROBE_ARGS 3 项 / REGISTERED 4 项） |
| `docs/CHANGELOG.md` | 顶部条目 |
| 计数四处 | README / CLAUDE / GUIDE / validate.yml 同步为 960 |

**未碰**：`scripts/oversight-tui.mjs`、`scripts/watch.mjs`、`scripts/verify-claims.mjs`、git。

---

## 3. nonce 假设：成立，逐字节

机制的地基是「派发 prompt 是子 agent transcript 的第一条 user 消息」。
这一条不成立，整个 `observe` 归属就是空的——所以我把它当**待证伪的命题**测，不当前提用。

**做法**：遍历本机 `~/.claude/projects/**/subagents/agent-*.jsonl`，对每份 transcript 找
第一条 `type === 'user' && !isMeta` 的记录，取出其正文，与父会话
（`<session-id>.jsonl` 同名文件）里所有 `Agent` / `Task` 工具调用的 `input.prompt` 比对。

**结果**（2026-11-13 本机，`D--Projects-Overwatch` 下 7 个有 subagents 的会话）：

| 指标 | 值 |
|---|---|
| 子 agent transcript 总数 | 140 |
| 有父会话且能对上的 | 127 |
| **`text.length === prompt.length` 且前缀相同** | **127 / 127** |
| 「前缀相同但有额外尾巴」 | **0** |
| 找不到第一条非 meta user 消息 | 0 |
| 无父会话 transcript 可对照 | 4 |

**没有一次改写、没有一次包装、没有一次追加**。另外两个数字：

- 最长的派发 prompt 是 11,880 字符（另有 8,613 / 7,471 / …），全部远小于
  `SUBAGENT_HEAD_BYTES`（64 KiB），所以 `observe` 只读头部就能找到 nonce；
- 第一条 user 记录的字节偏移：中位数 0，最大 471（前面是一条 `session_context` attachment），
  同样远小于 64 KiB。

**旁证**：`claim-ledger.test.mjs` 新增了一条夹具测试，把「两份 transcript、只有头部含 nonce
的那份被归属」固定下来，并断言 `来自 1/2 份` 与台账里只有一条 `observe` 行。
回退这个归属（把 `findNonce` 摘掉）该测试会红。

**一个需要写明的边界**：140 里有 4 份找不到父会话（会话文件已被清理），13 份是本项目
自己的 `.meta.json` 旁挂文件被误计入（已用 `.endsWith('.jsonl')` 排除后重算）。
这 4 份不影响假设——没有父会话就无从比对，但也无从派发，属于另一个问题。

---

## 4. 实际跑通的证据

### 4.1 真实 run 数据（`tasks/runs/2026-11-13-output-reconciliation/`）

建了一份 5 子树的 `task-graph.json`，`outputs` 齐全：

```
$ node scripts/validate-run.mjs tasks/runs/2026-11-13-output-reconciliation/task-graph.json
✓ tasks/runs/2026-11-13-output-reconciliation/task-graph.json
exit=0
```

整条链（`--run 2026-11-13-output-reconciliation`）：

```
declare  OL2-ST1 → 2 个文件  nonce: 281f9a3e
declare  OL2-ST3 → 2 个文件  nonce: 7a66e328
declare  OL2-ST4 → 1 个文件  nonce: f076158b
claim    ×5（每个文件一次，各带 sha256）
verify   → exit 1，「3 个任务里 3 个有缺陷（3 个未认领）」，三行都是 ✓ COMPLETE
consume  ×3
verify   → exit 0，「对账通过：3 个任务的产出全部落地、与自述一致、且已被认领」
```

**注意第一次 `verify` 的 exit 1**：三个任务全部 `COMPLETE`，但**未认领**也算缺陷。
这正是设计 §3.5 那条：「产出在」和「主线程知道了」是两件事。

### 4.2 `observe` 的真实归属（临时夹具，非真实会话）

构造两份子 agent transcript，只有 `agent-aaa.jsonl` 头部含 nonce `deadbeef`：

```
observe → 已记录 1 条 transcript 痕迹，来自 1/2 份子 agent transcript
台账    → {"kind":"observe","task":"ST1","path":"...\\out1.md","evidence":"agent-aaa.jsonl#1"}
verify  → ? ST1 · UNREPORTED — 文件在，transcript 有写它的调用，但没人自述 痕迹：agent-aaa.jsonl#1
```

第二份（无 nonce）**一条都没写进台账**——这正是设计要的行为：归属不了就不写，
否则对账结果是假的。

### 4.3 测试数字

```
$ node --test scripts/*.test.mjs
ℹ tests 960 / pass 960 / fail 0
```

源码 `^\s*test(` 计数也是 960（`check-structure.mjs` 的 `checkTestCount()` 两处对账一致）。
基线 927 → 960（+33）。

---

## 5. 负向验证：回退即红（真做了，不是声称）

不是「改坏了测试会红」的推理，是**真的改文件、跑测试、看结果、还原**：

| 回退 | 怎么做 | 结果 |
|---|---|---|
| 关掉 `outputs` 校验 | `const ores = checkOutputs(st)` → `{ errors: [], warnings: [], okPaths: [] }` | `validate-run.test.mjs` **7 条变红**（缺失/非数组/绝对路径/`..`/空串/artifact 空数组/跨子树重复） |
| 注释掉验收前对账 | SKILL.md 里 `node …verify --run <run-id> \|\| exit 1` 前加 `#` | `reconciliation-wiring.test.mjs` **1 条变红**（7.4 的 verify 判据） |
| 还原 | 两个文件从备份写回 | `42 / 42` 绿 |

合计 9 条红。还原后全量 960 全绿，硬门 exit 0。

另外 3 条**内建**回退断言（不依赖手动操作，每次跑测试都在验）：
- 删掉模板里「不执行也不会漏」→ 7.2 判据变假；
- 删掉 executor 的「## 我产出的文件」→ 7.3 判据变假；
- 把 `checkOutputs` 的结果丢弃 → 负向测试自身会红（它同时断言「原版拒绝」与「回退版通过」）。

---

## 6. 核心问题：现在能防住「agent 产出了但主线程没意识到」吗？

**答案是：能防住其中一部分，而缺的那一部分不是靠再补代码能补上的。**

### 6.1 能防住的，靠哪个具体机制

**靠 `observe` + 磁盘判据的 `UNREPORTED`，且它不需要子 agent 配合。**

具体链路：`declare` 时生成 nonce → 派发 prompt 带着 nonce → 子 agent 哪怕一个字都不报告、
根本不知道 `claim-ledger` 存在，它的 transcript 头部仍然有那个 nonce → `observe` 按 nonce
归属 → 抽 `Write` / `Edit` / `MultiEdit` / `NotebookEdit` 的 `tool_use`（并读成对
`tool_result` 的 `is_error`）→ 与 `declare` 的期望交叉。

于是出现这一格的区分：

- 期望里有、磁盘上没有、**也没有痕迹** → `ABSENT` / `EMPTY` = **真的没开工**；
- 期望里有、磁盘上有、**痕迹也在**、但没人自述 → `UNREPORTED` = **产出了，只是没人说**。

**这两种的处置完全相反**（重派 vs 认领）。在本次接法之前，这两种在返回文本里长得一模一样
——都是「一小段散文」或「什么都没写」。现在它们被分开了。

而且这条路径**不依赖任何人的自觉**：子 agent 不跑 `claim` 完全没问题（模板里明写了
「不执行也不会漏」），主线程哪怕崩溃重启也能用 `adopt` 列出「有产出、未认领」的任务。

`SKILL.md` §4.5 把它变成验收的**硬前置门**（`|| exit 1`），所以它不会「知道有问题但照样往下走」。

### 6.2 防不住的，缺什么

**第一，`observe` 仍未自动调用，需要主线程记得跑两步。**
`declare` 不记 `--session`，`verify` 不知道该扫哪个会话目录（设计 §6 已列为下一版）。
现在的顺序是 `observe` 然后 `verify`。**只跑 `verify` 不跑 `observe` 时，机制退化成「期望 + 磁盘
+ 自述」三方**——此时一个「产出了但没自述」的文件仍判 `UNREPORTED`（磁盘看得到），
但一个**只用 Bash 写、又没声明**的文件完全看不见（见下一条）。这是当前接法里最值得补的缺口，
补法是给 `declare` 加 `--session` 让 `verify` 自己调 `observe`。

**第二，Bash 写出的文件完全不在痕迹范围内**（设计 §3.6 已诚实标注，本轮未改）。
`observedWrites()` 只认四个写工具。`> out.txt`、`cp`、`tee`、`sed -i` 一律不认——
因为从命令行猜路径必然误判，而误判的代价是让人不再相信这个工具。
兜底路径是「显式 `declare`，走磁盘比对」，但那要求派发方事先想到。
**在本仓库语料上这不是理论风险**：`D--Projects-Overwatch` 下 137 份有写操作的子 agent
transcript 里 131 份用过 `Bash`。也就是说，一个 agent 如果习惯用 `printf > file` 而不是
`Write`，它的产出在 `observe` 眼里是不存在的。

**第三，本机制只覆盖「文件型产出」。** 一份只在返回文本里的结论（`research` 角色的典型形态）
没有路径可对账。设计 §1.1 已指出这类角色「可能整篇只在返回里」，本轮没有改变它。

**第四，也是最根本的一条：它防的是「主线程没意识到」，不是「主线程被误导」。**
子 agent 可以主动伪造 `claim` 的 hash。但这个边界是设计刻意的（§9）：当前形态下它
**什么都不做**就已经能瞒过去，所以先把「没报告」与「主动伪造」分开，收益是完全的。
把后者也治掉需要「文件是谁写的」这件事的密码学证据，不在本机制射程内。

### 6.3 结论，一句话

**「产出了但没自述」这一类，现在由 `observe` + `UNREPORTED` 兜住，且不需要子 agent 配合——
这是本次接法真正买到的东西。剩下的漏项依次是：`observe` 还得手动跑第二次、
Bash 写出的文件看不见、纯文本结论无从对账。第一条是接口变更（下一版可修），
后两条是设计已声明的边界，不该假装覆盖。**

---

## 7. 复跑

```bash
node scripts/validate-run.mjs tasks/runs/2026-11-13-output-reconciliation/task-graph.json  # exit 0
node --test scripts/validate-run.test.mjs scripts/reconciliation-wiring.test.mjs           # 42 条
node --test scripts/claim-ledger.test.mjs                                                 # 49 条
node --test scripts/*.test.mjs                                                            # 960 条
node scripts/check-structure.mjs                                                          # exit 0
```
