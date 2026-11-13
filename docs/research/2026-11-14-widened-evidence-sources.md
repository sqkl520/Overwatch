# 扩宽写前闸的证据来源：语料事实与运行时边界

- 日期：2026-11-14
- 作者：检索 Agent A1
- 产出形态：artifact（`scripts/probe-evidence-sources.mjs` + 本报告）
- 语料：`~/.claude/projects/`，本机 2026-11-14 快照。剔除本仓实验沙箱后 **257 份主 transcript**（原始 439 份含沙箱）
- 前序：`docs/research/2026-11-14-observe-mode-reality-check.md`（19.9% / 27 个被拦会话）、`docs/research/2026-11-14-pretooluse-desktop-verification.md`（hook 输入契约）
- 复算：`node scripts/probe-evidence-sources.mjs`（全量约 2 分 14 秒）；`--json` 出机器可读；`--section A|B|C|D` 单跑

> **本文只写跑过的东西。** 未跑通的标「未验证」；数字与已有报告冲突时同时给出并说明口径差异。
> **本文不含「建议扩宽」这类判断。** §5 只列每个候选判据的运行时可行性、能消掉多少、引入什么新风险。

---

## 0. 结论先行（六条）

1. **子 agent 的记录在 `<会话目录>/subagents/agent-<agentId>.jsonl`，与主 transcript 同名同层。** 父目录名就是主 transcript 的文件名去掉 `.jsonl`。同目录还有 `agent-<agentId>.meta.json`（一条 JSON，含 `agentType`/`description`/`toolUseId`/`spawnDepth`）。
2. **两套 id 命名空间是 provider 决定的，不是时间决定的。** `meta.toolUseId` 与主 transcript 的 `Agent` 工具调用 id 配对率 **94.74%（3493/3687）**；配不上的 194 条按命名空间分布是 `call_NN 44 / chatcmpl 91 / call_other 57 / empty 2`。**从记录本身能判断该用哪套 id**：同一份 transcript 里，`Agent` 调用的 id 是什么形态，`meta.toolUseId` 就是什么形态。
3. **比 `meta.toolUseId` 更硬的锚是 `toolUseResult.agentId`。** 主 transcript 里每次 `Agent` 调用都有一条 `type:"user"` 的 `tool_use` 结果记录，其 `toolUseResult.agentId` **直接等于子 agent 文件名**（3528/3724 = 94.74%）。这个字段的存在率是 **5748/5768 = 99.65%**。但它**不是全局唯一的**：907 个 agentId 被 >1 个会话引用（最多 12 个），跨项目 slug 的只有 9 个，且其中 8 个指向同一对目录（一个沙箱与一个真实项目）。
4. **续接会话有两种判据，在本语料上完全等价。** 文本前缀正则与首条人类消息上的 `isCompactSummary:true` **都命中 68 次，分歧 0**。但 `PreToolUse` 的 stdin 里**没有任何字段**告诉你「这是续接会话」——判据本身不在输入里，必须去读 transcript 头部（见 §2.3）。
5. **闸门在 `PreToolUse` 时刻拿得到 `transcript_path`，但它指向主 transcript，即使调用来自子 agent。** 2.1.308 上额外给了 `agent_id` / `agent_type`（这一条不在 20 组历史实测的字段表里，是本轮新观测）。**子 agent 的 transcript 在该 hook 触发时已经落盘**（实测：hook 内 `stat` 得到 69950 字节，且已含 1 次 Read）。
6. **「闸门去读子 agent transcript」的代价不是零。** 全语料 103 个会话带 `subagents/`，子 agent 正文合计 **6195.5 MB**，单会话最大 **428.4 MB**，单文件均值 **1.66 MB**。按当前实现的口径（每个文件读尾部）在 hook 内跑一遍，p50 310 ms、p90 1370 ms、最大 3903 ms——**而主 transcript 尾部 1 MB 的读取 p50 只有 2.89 ms**。

---

## 1. 子 agent transcript 存在哪、怎么认

### 1.1 路径与目录关系

**事实**：子 agent 记录落在主 transcript **同名的目录**下。

```
<root>/<slug>/<sessionId>.jsonl                     ← 主 transcript
<root>/<slug>/<sessionId>/subagents/
        agent-<agentId>.jsonl                       ← 子 agent 正文
        agent-<agentId>.meta.json                   ← 子 agent 元数据
```

真实例子（会话 ID 已截为前 8 位；`<root>` = `~/.claude/projects`，`<slug>` 是宿主把 cwd 编码出来的目录名）：

```
<root>/D--Projects-Account/19957fde-…jsonl
<root>/D--Projects-Account/19957fde-…/subagents/agent-ae55b33ebff3c802d.jsonl
<root>/D--Projects-Account/19957fde-…/subagents/agent-ae55b33ebff3c802d.meta.json
```

`meta.json` 的完整内容（真样本，`toolUseId` 与 `description` 原样，其余字段照抄）：

```json
{"agentType":"general-purpose","description":"2E strings for batch 2",
 "toolUseId":"call_02_e5S70jc2iMEQOHQ1G4qQ8786",
 "spawnDepth":1,"requestShape":"background","requestNonInteractive":true}
```

**复算**：`node scripts/probe-evidence-sources.mjs --section A`。输出里有「主 transcript N · 其中带 subagents/ 目录 M」。

**本机实测**（剔除沙箱后）：主 transcript 257 份，其中 **103 份**带 `subagents/` 目录；子 agent 正文 **3724** 份、meta **3687** 份（16 份正文没有 meta，2 份 meta 的 `toolUseId` 为空）。

### 1.2 两套 id 命名空间：出现在什么条件下

**结论：由 provider/模型决定，不是由时间决定。** 依据是把 3687 个 meta 的 `toolUseId` 前缀与它自己那份正文里第一条 assistant 记录的 `message.model` 交叉列表：

| `meta.toolUseId` 前缀 | 子 agent 自己跑的模型（该组合出现次数最多的那一个） | 条数 |
|---|---|---|
| `call_00_…` / `call_01_…` / … | `SCNet-Max` | 1327 |
| `chatcmpl-tool-…` | `deepseek-ai/deepseek-v4.1-flash` | 816 |
| `toolu_bdrk_…` | `claude-opus-4-8` | 30 |
| `toolu_…`（Anthropic 原生形态） | `claude-opus-5-5` | 17 |
| `call_<base64>` | `SCNet-Max` / `gpt-5.6-sol` / `glm-5.3` | 96+ |

**这解释了一件事**：`2026-11-14-observe-mode-reality-check.md` §5.3 把「失配」归因为「旧格式会话（2026-10 及更早）」。这一半对、一半不对：

- **对的一半**：失配确实集中在特定会话。
- **不对的一半**：不是「10 月才有 `toolu_bdrk`」，而是「**那个会话的子 agent 跑在另一个 provider 上**」。按月份统计 `Agent` 工具调用的 id 前缀，`toolu_bdrk` 在 **2026-10 出现 150 次**，2026-11 出现 0 次；但同一个月（2026-10）里 `call_NN` 有 1992 次、`chatcmpl` 有 1297 次、`call_hex` 有 1150 次。**同一个月份并存四套命名空间。**

**能不能从记录本身判断该用哪套？——能，而且不需要判断。**

关键事实：`meta.toolUseId` 要配的是**主 transcript 里 `Agent` 工具调用的 `tool_use.id`**。这不是「猜哪套命名空间」，而是**在同一份 transcript 内部做字符串比对**。主 transcript 里 `Agent` 调用的 id 是什么形态，配得上的 `meta.toolUseId` 自然就是什么形态。跨命名空间的失配只发生在「主线程的 Agent 调用 id 与子 agent meta 的 id 来自不同 provider」时（例如主线程跑 A 模型、子 agent 跑 B 模型，两侧 id 由不同上游分配）。

**本机实测配对率**：

| 口径 | 配对 | 总数 | 比率 |
|---|---|---|---|
| `meta.toolUseId` ↔ 主 transcript `Agent.tool_use.id` | 3493 | 3687 | **94.74%** |
| 子 agent 文件名 ↔ 主 transcript `toolUseResult.agentId` | 3528 | 3724 | **94.74%** |

失配侧的命名空间分布（`--section A` 的 `metaUnmatchedNamespace`）：`chatcmpl 91`、`call_other 57`、`call_NN 44`、`empty 2`。

**复算**：

```bash
node scripts/probe-evidence-sources.mjs --section A --json | node -e '
const r=JSON.parse(require("fs").readFileSync(0));
const a=r.A;
console.log("meta配对", a.metaToolUseIdMatched, "/", a.subMetas, a.metaMatchRate+"%");
console.log("失配命名空间", JSON.stringify(a.metaUnmatchedNamespace));'
```

### 1.3 除了 `meta.toolUseId`，还有什么字段能锚定「第几次 Agent 调用之前」

这是一个一个查的，每条给出「有没有 / 在哪个字段 / 能不能用」：

| 候选 | 存在吗 | 位置 | 结论 |
|---|---|---|---|
| **`toolUseResult.agentId`** | **有，99.65%** | 主 transcript 里 `type:"user"` 的记录，`toolUseResult.agentId` | **最硬的一条**。它直接等于 `agent-<id>.jsonl` 的文件名，不需要任何命名空间映射。但它只回答「这个子 agent 属于本会话」，**不回答「它在首写之前还是之后」**——先后的判断仍要靠这条记录在主 transcript 里的**字节偏移**。 |
| **字节偏移** | 有 | 每条记录在 jsonl 里的起始字节 | **唯一可靠的先后判据**。实测 224/224 个有写会话存在时间戳倒退（前序报告 §3.2），所以不能用 `timestamp`。用 `toolUseResult.agentId` 那条记录的偏移与首写偏移比大小即可。 |
| `timestamp` | 有 | 每条记录 | **不能用**。子 agent 与主线程不同钟（前序报告实测：1d781bb6 的子 agent 起于 18:18，主线程首写 17:40）。 |
| `parentUuid` | 有（子 agent 正文里） | 子 agent 记录之间串链，首条为 `null` | 能重建子 agent 内部顺序，**锚不到主线程**——两边的 `uuid` 空间不交叉。 |
| `sessionId` | 有，**子 agent 记录里写的是主会话的 id** | 子 agent 正文每条记录都有 | 证明「这个子 agent 属于哪个会话」，**不能**区分是哪次 `Agent` 调用。实测：`agent-a59224653c08c0b69.jsonl` 的 `sessionId` 等于主会话 id。 |
| `agentId`（正文里的字段） | 有 | 子 agent 正文每条记录 | 同上，只证明归属。 |
| `isSidechain` | 有 | 子 agent 正文全为 `true`；主 transcript **0 条为 true** | 用来认出「这是子 agent 的记录」。**实测：435 份主 transcript 里 `isSidechain:true` 的记录数为 0**，子 agent 的活动不会镜像进主 transcript。 |
| `promptId` | 有 | 两边都有 | 粒度是「一轮」，不是「一次 Agent 调用」。 |
| `spawnDepth` | 有 | meta 里 | 只说明嵌套深度（实测 1/2/3 都有），不定位调用。 |
| `description` | 有 | meta 里 | **不能**用。实测 B2 会话里主线程的 `Agent.input.description` 与子 agent meta 的 `description` **一条都对不上**（0/4、0/9、0/11…）——那是不同批次的子 agent。 |
| `sourceToolAssistantUUID` / `sourceToolUseID` | 有（主 transcript 的 user 记录上） | 指向产生这次 tool_use 的 assistant 记录 | 可用于重建主线程内的调用顺序，**不**指向子 agent 文件。 |

**因此：「这个子 agent 是在首写之前派的吗」这个问题，唯一可复算的答案路径是**
`主 transcript 里 toolUseResult.agentId 记录的字节偏移 < 首写偏移`。

### 1.4 实测统计与复算脚本

> **语料是活的。** 下面是一份快照（本报告写作期间，本机还有别的会话在往 `~/.claude/projects/` 里写）。
> 复跑时绝对数会小幅漂移；**稳定的是比率**（三次运行都是 94.74%）。
> 复算时请以脚本输出为准，不要拿本文的绝对数当断言。

| 指标 | 值（快照） |
|---|---|
| 带 `subagents/` 目录的主 transcript | 103 / 257 |
| 子 agent 正文 `.jsonl` | 3724 |
| 子 agent `meta.json` | 3687 |
| `meta.toolUseId` 严格配上 | 3493（**94.74%**） |
| `meta.toolUseId` 配不上 | 194 |
| 子 agent 文件名 = `toolUseResult.agentId` | 3528（**94.74%**） |
| 对不上 | 196 |
| 主 transcript 里 `Agent` 工具调用总数 | 5768 |
| 其中带 `toolUseResult.agentId` 的结果记录 | 5748（**99.65%**），跨 135 个会话 |
| 被 >1 个会话引用的 agentId | 907（最多 12 个会话共用） |
| 其中跨**不同项目 slug** | **9**（8 个集中在同一对目录） |

```bash
# 全部数字
node scripts/probe-evidence-sources.mjs --section A --json

# 手感：抽一个会话，看它的 Agent 调用 id 与 meta.toolUseId 是否同形态
node scripts/probe-evidence-sources.mjs --section A --samples 5
```

---

## 2. 「续接会话」怎么从 transcript 自己认出来

### 2.1 宿主写的续接摘要长什么样

**真实样本**（脱敏后照抄首 200 字，取自 `145542ab` 会话的首条人类消息）：

```
This session is being continued from a previous conversation that ran out of context. The summary below covers the earli…
```

该记录的字段集（与普通人类消息的关键差异就是最后两个）：

```json
{"parentUuid":null,"isSidechain":false,"promptId":"…","type":"user",
 "message":{"role":"user","content":"This session is being continued from a previous conversation…"},
 "isVisibleInTranscriptOnly":true,"isCompactSummary":true,
 "uuid":"…","timestamp":"…","userType":"external","entrypoint":"claude-desktop-3p",
 "cwd":"…","sessionId":"…","version":"2.1.308","gitBranch":"HEAD"}
```

### 2.2 有没有比「文本形态」更硬的信号

逐个查证：

| 候选信号 | 存在吗 | 实测 |
|---|---|---|
| **`isCompactSummary`（布尔）** | **有** | **与文本判据完全等价**：257 份主 transcript 里，文本正则命中 68、标志位命中 68、**分歧 0**。 |
| `isVisibleInTranscriptOnly` | 有 | 与 `isCompactSummary` 同时出现（68/68）。不是独立信号，是同一个事件的另一个字段。 |
| `compactMetadata` | 有 | 是 `type:"system"` 记录上的字段，含 `trigger`/`preTokens`/`postTokens`；**用途不同**：它记录「压缩发生了」，不记录「这份 transcript 的第一条是不是摘要」。 |
| `sessionId` 变化 | **不存在这种记录** | 464 份文件里 `sessionId` 是固定的；没有「上一段的 sessionId」写在会话里。 |
| `parentSessionId` | **不存在** | 全语料 90 万条记录里，这个字段出现 **0 次**。 |
| `leafUuid` | 存在但**无关** | 出现在 `type:"last-prompt"` 记录上，记录「最后一条 prompt 的 uuid」，不是续接信号。 |
| `continuedInSessionId` | 存在但**是反向的** | `type:"continued-in"` 记录，全语料 **4 条**。它写在**上一段**会话里，指向下一段，不是写在续接会话里。 |
| 首条记录的 `role`/`type` | 有 | 续接会话的首条人类消息仍是 `type:"user"`/`role:"user"`，**与普通消息同形**，区分不出来。 |

**附加事实**：`isCompactSummary` 出现在 91 份主 transcript 里，但只有 **68 份**是在**首条**人类消息上。另外 23 份是「会话中途压缩后继续」——**不是续接会话，那些会话的读在本文件里是能看到的**。这个区分很重要：拿「出现过 `isCompactSummary`」当续接判据会多判 23 个。

**续接摘要出现在文件里的什么位置**（257 份，仅统计首条人类消息带标志位的 68 份）：

| 统计量 | 字节偏移 |
|---|---|
| min | 1050 |
| p50 | 68970 |
| max | 1130653 |
| **超过 1 MB（= 闸门当前窗口）的** | **1 份** |

这意味着「内容在文件里、但闸门读不到」这件事，对续接会话**不是**主因——68 份里 67 份的首条摘要都在 1 MB 以内。

**复算**：

```bash
node scripts/probe-evidence-sources.mjs --section B --json | node -e '
const b=JSON.parse(require("fs").readFileSync(0)).B;
console.log("文本",b.textContinuation,"标志位",b.flagContinuation,"分歧",b.onlyText+b.onlyFlag);'
```

### 2.3 关键难点：闸门运行时拿不到判断续接所需的字段

这一条是本文最重要的负面结论之一。

**`PreToolUse` hook 的 stdin 字段全集**（把 20 组历史实测的 `hook-log-*.jsonl` 取并集，再用本轮新实测补齐）：

| 字段 | 说明 |
|---|---|
| `session_id` | 会话 id |
| `transcript_path` | 主 transcript 绝对路径（**即使是子 agent 发起的调用，也是主 transcript**，见 §4.2） |
| `cwd` | 会话根 |
| `prompt_id` | 本回合 id |
| `permission_mode` | 如 `acceptEdits` |
| `effort` | `{level}` |
| `hook_event_name` | 固定 `"PreToolUse"` |
| `tool_name` / `tool_input` / `tool_use_id` | 本次调用 |
| `agent_id` / `agent_type` | **本轮新观测**：仅当调用来自子 agent 时出现（2.1.308）。历史 20 组实测里没有，因为那些实验都是主线程直接调工具 |

**这十个（或十二个）字段里，没有任何一个告诉闸门「本会话是续接会话」。** 判断续接必须读 transcript 内容。

**闸门读得到吗？——读得到，但当前实现没读，而且「读得到」不等于「读得对」。**

- `transcript_path` 指向主 transcript，可读（前序报告 §1 已实测）。
- 判据所需的证据（首条人类消息的 `isCompactSummary` / 文本前缀）在文件**头部**。
- 当前 `readTranscriptReads()` 只读**尾部 1 MB**（`scripts/pre-write-gate.mjs`，函数 `readTranscriptReads`，默认 `bytes = 1024*1024`）。**尾读结构性地拿不到首条消息。**
- 要拿就得**再读一次头部**（额外一次有界读）。这是可行的，但它是**新增 IO**，不是免费。

**所以准确的表述是**：这条路**闸门走得通**，但代价是「每次首次写判定要多读一次 transcript 头部」，且——下一句是决定性的——**§5 的实测显示它只能多覆盖 5 个会话，而其中 0 个是「只有它」能覆盖的**（见 §5.2 的边际表）。

**明确不能做的**：
- 不能用 `session_id` 变化检测续接——会话内 `session_id` 恒定，且「上一段的 sessionId」根本不写在续接会话里。
- 不能用 `parentSessionId`——这个字段全语料不存在。
- 不能靠 hook 的其它输入字段——它们没有。

---

## 3. 结构性探索的证据强度

### 3.1 分级

按「能证明什么 / 不能证明什么」分级，术语沿用 `observe-reality-check.mjs` 的 gate / broad 两档：

| 强度 | 手段 | 能证明 | 不能证明 | 语料实测频次（257 份真实 transcript） |
|---|---|---|---|---|
| **0（不算证据）** | 无 | —— | —— | 见 §5.3 |
| **1 最弱** | `git status` / `git log --oneline -n 5` / `ls`（无参数） | 「AI 知道这里是个 git 仓库」/「知道目录里有什么名字」 | 内容、结构、约定、该改哪个文件 | `git` 20160 次、`ls` 19096 次、`dir` 5 次 |
| **2 弱** | `ls -la` / `find -maxdepth 2` / `tree` | 目录布局、文件大小与时间 | 文件内容 | `find` 3311 次、`tree` 2 次 |
| **3 中** | `git log --stat` / `git show <c>:<path>` / `du` / `stat` | 历史演进、某个文件曾经是什么 | 当前内容是否还是那样 | `du` 459 次、`stat` 396 次、`file` 112 次 |
| **4 较强** | `Grep`（工具）/ `grep -rn` / `rg` | **某个符号/字符串在哪些文件里**——这最接近「知道改哪里」 | 上下文、类型、调用关系 | `Grep` 815 次、shell `grep` 56386 次、`rg` 99 次 |
| **5 强** | `Glob`（工具）/ `find -name` 命中具体文件 | 文件名与位置 | 内容 | `Glob` 136 次 |
| **6 = 闸门现状** | `Read` / `cat` / `head` / `tail` | 读过内容 | —— | 主线程 `Read` 6846 次（其中尾部 1 MB 内的见前序报告） |

**「命中条数」这一列是关键**：`Grep` 工具的结果里**确实带命中数**，但**只在一种形态下带**：

- `^Found (\d+) files?` —— **66/744 次 Grep 结果**（8.9%）
- `^Found (\d+) matches?` —— **0 次**
- 其余 Grep 结果是「`No matches found`」（46 次）、「`No files found`」（22 次）或**直接是文件路径清单**（没有计数）
- `Glob` 的结果**从不带计数**（131 次全部是路径清单或 `No files found`）

所以「用命中条数当强度信号」在语料里只覆盖 **8.9% 的 Grep 调用**。拿不到计数的那些仍然可以用「结果非空」当弱信号，但那就退化成「它搜到了东西」——不能区分 1 条和 500 条。

**复算**：

```bash
node scripts/probe-evidence-sources.mjs --section C --json | node -e '
const c=JSON.parse(require("fs").readFileSync(0)).C;
console.log("Glob",c.globCalls,"Grep",c.grepCalls,"shell结构动词",c.bashStructCommands);
console.log("带命中数的结果",JSON.stringify(c.toolResultsWithHitCount),"总结果",JSON.stringify(c.toolsWithHitCount));'
```

### 3.2 C 类那 6 个会话具体做了什么

C 类被拦会话 = 主线程没读过够 3 个文件、但做过 ≥3 次结构性探索。**逐条列出首写前的全部工具调用**（路径脱敏为项目内相对形态，命令原文保留）：

**`2562780d` / `801ed9e6`**（同一任务的两份 fork；目标是新建 `qq-github-promo/SKILL.md`）

```
ls -la "<项目根>/AI/prompt skill" 2>/dev/null || pwd
cd "<项目根>/AI/prompt skill" && ls -la; echo "---"; find . -maxdepth 3 -name "*.md" | head -50
pwd; echo "---"; ls -la; echo "--- parent ---"; ls -la ..
cd "<项目根>/AI prompt" && find "for claude code" -maxdepth 3 | head -40; …
cd "…/many-agents_multi-prompt-files_token-heavy" && find . -maxdepth 4 -type d -name "skills" -o -maxdepth 4 -name "SKILL.md" | …
```

**判断**：这套命令做了「列目录 + 按名找 `SKILL.md`」，**建立了对同类 skill 目录布局的认识**。它没有读任何一个已有 `SKILL.md` 的内容。对一个「新建一份同类文档」的任务，这是**恰当且足够的探索**；对「改哪个函数」的任务则不够。

**`61fe6d9f` / `d3b951b4`**（同一个 `.claude/launch.json` 任务的两份 fork）

```
curl -s -o /tmp/ds_share.html …            ← 抓的是一份网络文档，不是本项目
cat /tmp/ds_share.html | head -100
pwd && ls -a | head -30 && ls .claude 2>/dev/null
ls -la "…/.claude/launch.json" "…/Github/.claude" 2>&1; echo "---"; ls "…/.claude/" 2>&1 | head -20
Glob .claude/launch.json
Glob <家目录>/.claude/launch.json
```

**判断**：两次 `Glob` **精确确认了目标文件是否存在**（这两次 Glob 的答案直接决定要不要新建）。这不是「读过项目内容」，但它是**针对目标文件的直接取证**——比「读了 3 个无关源码文件」更贴近「知道自己要写什么」。

**`4d15fd65`**（逆向 shapez 的 Electron 包，目标是写一份 app-package.json）

```
ls -la "/d/Steam/steamapps/common/shapez.io" 2>&1; echo "=== subdirs (depth2) ==="; find … -maxdepth 2 -type d …
find … -type f -size +200k -printf '%10s  %p\n' … | sort -rn | head -50
find … -type f \( -iname '*.asar' -o -iname '*.exe' -o -iname '*.dll' -o … \) …
echo "APPDATA=$APPDATA"; … ls -la "$APPDATA/shapez.io" …; … ls -la "$APPDATA/shapez.io/mods" …
echo "cwd: $(pwd)"; ls -la; … node -v …; npm -v …; python --version …; git --version …
cd … && cat version debug.log steam_appid.txt 2>&1; … ls -la save/ …
find "$APPDATA/shapez.io" -type f -printf '%10s  %p\n' … | sort -rn | head -30
npx --yes @electron/asar extract-file "…/app.asar" package.json 2>&1 | head -5; ls -la package.json …
```

**判断**：**这是本文 27 个被拦会话里探索最扎实的一个**。它按大小排序找可疑文件、按扩展名筛、直接 `cat` 了 `version` / `debug.log` / `steam_appid.txt`（这三个是**整份读**——但闸门的 `cat` 动词只取**第一个**非选项参数，所以只算 1 个）、并且用 `asar extract-file` 真的取出了包内 `package.json`。**闸门判据在这条命令链上明显收窄了**：一条 `cat a b c` 只记 `a`。

**`57af6178`**（Task Manager Pro，目标是写 `_probe/sysinfo.ps1`）

```
cd /d/Projects/Task-Manager-Pro 2>/dev/null && pwd && ls -la || echo "DIR_MISSING"
powershell -NoProfile -Command "$cs=Get-CimInstance Win32_ComputerSystem; …"      ← 探本机环境，非项目
ls -la /d/Projects 2>/dev/null | head -50; … pwd; … ls ~ | head -20
ls -la "/d/Projects/Task Manager Pro"; echo "=== git ==="; cd "…" && git status --short 2>&1 | head -20
```

**判断**：先确认目录存在、再 `ls`、再 `git status`。这**建立了「项目在哪、有多大、有没有未提交改动」的认识**。它没有读 `package.json`，也没有读任何源码。

**小结**：6 个 C 类会话里，**5 个的探索与任务目标直接相关**（`4d15fd65` 最深，`57af6178` 最浅）；**没有一个是「先乱翻再瞎写」**。但同样确定的是：**只有 1 个（`4d15fd65`）真的读到了文件内容**（`cat version debug.log steam_appid.txt`），其余 5 个停在「知道目录结构 / 确认文件存在」。

---

## 4. 闸门在运行时到底能拿到多少历史

### 4.1 stdin 里有 `transcript_path` 吗？指向谁？

**有，且指向主 transcript——即使调用来自子 agent。**

本轮实测（`claude.exe 2.1.308` 真二进制 + stub 模型，子 agent 由宿主真实派生）。子 agent 内部发起 `Write` 时，hook 收到的完整 stdin：

```json
{
  "session_id": "…",
  "transcript_path": "…\\projects\\D--Projects-Overwatch\\<sid>.jsonl",
  "cwd": "…",
  "prompt_id": "…",
  "permission_mode": "acceptEdits",
  "agent_id": "a51d9b20e2a5aa243",
  "agent_type": "general-purpose",
  "effort": { "level": "max" },
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": { "file_path": "…\\sub-out.txt", "content": "written by subagent\n" },
  "tool_use_id": "toolu_sub_…"
}
```

**要点**：

1. `transcript_path` 是**主** transcript（不在 `subagents/` 下，路径里没有 `subagents` 段）。三次独立运行、共 275 次 hook 触发，**没有一次拿到子 agent 自己的路径**。
2. `agent_id` / `agent_type` 是**新增可用的锚**：只要它们出现，就说明本次调用来自子 agent，且 `agent_id` 直接等于 `agent-<id>.jsonl` 的文件名。
3. 这一对字段不在 `2026-11-14-pretooluse-desktop-verification.md` §1 的字段表里——那份表的 20 组实验全是主线程直接调工具，所以没观察到。**本文补上这一条。**

### 4.2 闸门现在怎么数「读过几个文件」

**读现有源码**（`scripts/pre-write-gate.mjs`，2026-11-14 03:38 快照；行号会随并行改动漂移，故以函数名为准）：

| 环节 | 函数 | 行为 |
|---|---|---|
| 触发判定 | `decide(input, state)` | 先 `writeIntentOf()` 判是不是写；是写则查标记；标记无效则取 `state.getReads()` |
| 取读取证据 | `runHook()` 注入的 `getReads` 闭包 | **惰性**调用 `readTranscriptReads(input.transcript_path, {bytes: cfg.transcriptBytes})`——只在「正要拒绝」时才花这次读 |
| 实际读盘 | `readTranscriptReads(transcriptPath, {bytes=1MB})` → `readTailBytes()` | **只读尾部**，默认 1 MB（`defaultConfig().transcriptBytes`）。用 `fd + readSync` 从 `size-bytes` 起读，不整文件入内存 |
| 解析 | `readPathsInTranscriptText()` | 逐行 `JSON.parse`；取 `message.content` 里 `type:"tool_use"` 的块 |
| 认哪个工具 | `READ_TOOLS = ['Read','NotebookRead']` + `SHELL_READ_VERBS = ['cat','head','tail','type','get-content','gc','more']` | `Read` 取 `file_path`/`notebook_path`/`path`；shell 只认这 7 个动词，且**只取命令段里第一个非选项参数** |
| 计数 | `decide()` 里 `reads.length >= cfg.minReads`（默认 3） | 数的是**归一化路径去重后的不同文件个数**（`pathKeyOf`：小写 + 正斜杠） |

**两个由这个实现决定的事实**：

- **窗口是 1 MB**，不是全文件。前序报告实测：把窗口放开到全文件（cumulative 口径）只多救 1 个会话（27→26），所以窗口**不是**主要瓶颈。
- **一条 `cat a b c` 只记 `a`**（`for (const a of t.slice(i+1)) { …; break; }`）。§3.2 的 `4d15fd65` 正是这种情形。

### 4.3 若闸门想在运行时知道「子 agent 读过什么」，要读哪些文件？那时它们落盘了吗？

**要读的文件**：`<transcript_path 去掉 .jsonl>/subagents/agent-<agent_id>.jsonl`，以及（若不用 `agent_id`）同目录的 `*.meta.json`。

**落盘时机——实测结论：已经落盘了。**

实测装置：真 `claude.exe 2.1.308`，stub 冒充模型，项目内注册一个 `PreToolUse` hook（`node hook.mjs`，matcher 覆盖 `Write|Edit|Agent|Read`）。hook 每次触发时 `stat` 主 transcript 与 `subagents/`。

三次独立运行的一致结果：

| hook 触发时的调用方 | `transcript_path` | `subagents/` 目录 | 该子 agent 正文大小 | 正文里已记录的 `Read` 数 |
|---|---|---|---|---|
| 主线程 `Agent`（第 1 次） | 主 transcript | **不存在** | —— | —— |
| 子 agent 的 `Read` | 主 transcript | 存在 | **69950 字节** | **1**（就是当前这次） |
| 子 agent 的 `Write` | 主 transcript | 存在 | **163527 字节** | **1** |
| 主线程 `Write`（首次） | 主 transcript | 存在 | 141086 字节 | 1 |

**关键细节**：子 agent 的**当前这次**工具调用在 hook 触发时**已经写进它的正文**——`own_reads_seen_at_hook: 1` 出现在子 agent 自己的 `Read` hook 里，说明宿主是「先落盘再调 hook」。因此 hook 内读到的文件是**最新的**，不会漏掉当前这一步。

**但有一个未验证的边界**：子 agent 的 `meta.json` 在**第一次** `Agent` 调用触发 hook 时还不存在（上表第 1 行 `subagent_dir_exists:false`）；到子 agent 第一次触发时已在。这符合「宿主先派生、再落 meta」的直觉，但**「meta 在子 agent 的第一次工具调用之前一定已落盘」这条只在本次 3 次运行里观察到，不外推**。

**代价（同样是实测）**：把「读主 transcript 尾部 + 逐个读所有子 agent 尾部」跟「只读主 transcript 尾部」比，在 102 个带 `subagents/` 的真实会话上：

| 口径 | p50 | p90 | max |
|---|---|---|---|
| 只读主 transcript 尾部 1 MB | **2.89 ms** | 4.85 ms | 55.22 ms |
| 再读所有子 agent 尾部 2 MB | **310.72 ms** | **1370.22 ms** | **3902.67 ms** |

（子 agent 数量 p50 20 个、p90 80 个、max 243 个；体积 p50 32.45 MB、p90 170.48 MB、max 428.39 MB。脚本：本机 `.tmp-a1/hook-cost.mjs`，逻辑等价于 `stop-verify-hook.mjs` 的 `loadSubagentRecords` + `SUBAGENT_TAIL_BYTES = 2 MB`。）

**这就是闸门现有的 5 秒预算（`DEFAULT_BUDGET_MS`）会撞上的地方**：p90 1370 ms 尚可，max 3903 ms 已经逼近 5000 ms 的上限，而超预算的行为是**放行**——即「装了这个功能，在最需要它的会话上它会静默失效」。

---

## 5. 结论表

口径说明：**被拦会话 = 前序报告那 27 个**（真实项目 136 个有写会话里，阈值 3 会拦的那 27 个）。下表每个数字都是在这 27 个上重算的，脚本 `.tmp-a1/overlap.mjs`（逻辑与 `observe-reality-check.mjs` 同源）。

### 5.1 候选判据 × 三列

| # | 候选扩宽判据 | 运行时可行性 | 能消掉几类误拦（27 个里） | 引入的新风险 | 证据等级 |
|---|---|---|---|---|---|
| **A** | 读**本会话自己的** `subagents/`，用 `meta.toolUseId` 严格配 `Agent.tool_use.id`，且该 `Agent` 调用在首写之前 | **可行**。hook 内可 `readdir` + 读 meta；`agent_id`/`agent_type` 在本轮实测里直接给到。代价是 §4.3 的 IO（p50 310 ms / max 3.9 s） | **5 个**（19957fde, e99e2ef7, 3e58c93b, 9835af16, f932d1d4） | ① IO 超预算即静默放行；② 需要「首写偏移」做先后判据，而闸门**当前不记录首写**——要新增状态 | **T2**（可复算脚本）+ **T3**（落盘时机端到端实测） |
| **B** | 同上，但用**全局** `agentId → subagents/` 索引（跨会话目录找） | **技术上可行、语义上有新风险**。§1.4：907 个 agentId 被多个会话引用，跨 slug 的 9 个 | **16 个**（A 的 5 个 + 仅靠它多救的 9–11 个） | ① **跨会话借证据**：11 个恢复的会话里，证据全部来自**另一个会话目录**；② 依赖 `agentId` 的全局唯一性——**实测不成立**（见 §1.4 / §5.3 风险条）；③ 同一个 agentId 最多被 12 个会话引用，无法判断「哪一份才是本次的」 | **T2**（可复算）+ ⚠️ 有已知反例 |
| **C** | 认「续接会话」：读 transcript **头部**判断 `isCompactSummary` / 文本前缀 | **可行但需新增一次头部读**。字段不在 hook stdin 里（§2.3），必须读文件 | **5 个**（dc11a911, 3658564c, 910e505f, bc2f3a8e, 52ea643c）。**但边际为 0**——这 5 个里有 0 个是「只有 C 能救」 | ① 每次首次写判定多一次头部读；② **判据本身宽**：它承认的是「上一段会话读过」，而上一段读了什么**本会话看不到**，等于把一个布尔当真值 | **T2** |
| **D** | 认结构性探索：`ls`/`find`/`git log`/`Glob`/`Grep` 计入证据（重复计数，不按动词去重） | **完全静态可行**：证据就在主 transcript 的尾部 1 MB 内，无需额外 IO、无需额外状态 | **12 个**，其中 **6 个只有它救得了**（2562780d, 801ed9e6, 61fe6d9f, d3b951b4, 4d15fd65, 57af6178） | ① **判据强度弱**：§3.2 显示 6 个里只有 1 个真读了文件内容；② 一旦认 `ls`，一个「`ls` 三次就写」的会话也算读过——**这是把闸门退化成「敲过键盘就算读过」** | **T2** + §3.2 人工逐条核对（近似 T1） |
| — | **四个候选的并集** | —— | **25 / 27** | —— | **T2** |
| — | **四个都救不了的** | —— | **2 个**：`aed8ec22`、`ea338c0e`（都是「`Read pom.xml` → `Edit pom.xml`」，只读了 1 个文件） | —— | **T2** |

### 5.2 边际贡献（「只有它能救」的会话）

| 候选 | 独立覆盖 | **只有它能覆盖** |
|---|---|---|
| A（本会话 subagents + 严格配对） | 5 | **0** |
| B（全局 agentId 索引） | 16 | **9**：9ab6f582, 1d781bb6, 4503b66b, 536cf97b, a3a6d43a, be96580d, d35de735, 677257a4, 9aa577ef |
| C（续接判据） | 5 | **0** |
| D（结构性探索） | 12 | **6**：2562780d, 801ed9e6, 61fe6d9f, d3b951b4, 4d15fd65, 57af6178 |

**这张表是本文最重要的结果**：A 和 C 各自能覆盖 5 个，但**它们的 5 个全部被别的候选覆盖**（A⊂B；C 的 5 个里有 4 个同时在 B 或 D 里，`910e505f` 在 B 里）。**没有边际贡献。**

### 5.3 各候选的具体反例

**B 的反例（最重要）**：`536cf97b` 是前序报告归为 `D-no-evidence`（「子 agent 目录为空，无法证实也无法证伪」）的会话。用 B 的全局索引，它能凑出 42 个「读过的文件」——**但这些文件全部来自同 slug 下的另一个会话 `e99e2ef7` 的目录**。

实测证据（`cross-session.mjs`）：B 恢复的 16 个会话里，**11 个的证据全部来自别的会话目录**，0 个来自多个不同会话（都是一对一借用）。`lender-slug.mjs` 进一步确认：**这 11 个的借用对象都在同一个项目 slug 下**（即同一项目的另一份会话，通常是 fork/续接的同族），跨 slug 的 lender 只有 1 个（`a5ef7190`，一个沙箱会话）。

**这不能直接判成「错」**——同项目同族的会话确实可能读过同一批文件。但它把「本会话读过」悄悄换成了「**这个项目里某个会话读过**」，而闸门的文案与语义都是前者。这是一个**语义扩宽**，不是同等强度的证据。

**agentId 不唯一（B 的必要条件被证伪）**：

```bash
# 逻辑见 .tmp-a1/collision.mjs：同一个 agentId 被几个会话的 toolUseResult 引用
distinct agentIds referenced: 3548
 referenced by MORE THAN ONE session: 907
 max sessions referencing one agentId: 12
```

**D 的反例**：`57af6178` 的探索是 `ls` + `git status` + 一条探测本机环境的 PowerShell（与项目无关）。把它算成「读过项目」是**过度让步**——它连 `package.json` 都没打开。

**A 的反例**：A 与 B 的差别只在「在不在本会话目录」。`e99e2ef7` 用 A 能救（自己目录里有 42 个读），`536cf97b` 用 A 救不了（自己目录是空的）——两者是**同一个项目、同一批子 agent**，只因为 fork 时目录没跟过来，一个救了、一个没救。

---

## 6. 诚实边界

1. **子 agent 落盘时序只测了 3 次运行、1 个宿主版本（2.1.308）。** 「hook 触发时子 agent 正文已含当前这次调用」这条**在语料里无法验证**（语料是事后快照，没有 hook 触发时刻的状态）。它是端到端实测结论，不是语料结论。
2. **`agent_id` / `agent_type` 字段只在本轮实测里见过。** 历史 20 组 hook 实验没有这两个字段，因为它们全是主线程调工具。**这两个字段是否在所有版本/所有模式下都出现，未验证。**
3. **C 类 6 个会话的「是否真的了解项目状态」是人工判断。** §3.2 的命令原文是事实，结论（「5 个与任务相关」「只有 1 个读到内容」）是判断。判据写在了正文里，可被反驳。
4. **§4.3 的耗时是单机单次测量。** 它是「逐个文件读尾部」这一实现口径的成本，换实现（例如只读 meta、或用 `agentId` 直接定位）成本会低得多——**本文没有测那些实现**。
5. **27 这个分母来自前序报告的口径**（真实项目 = 剔除沙箱 + fork 去重）。`probe-evidence-sources.mjs` 的 `--section A/B/C/D` 用**同样的沙箱子判据但不做 fork 去重**，所以它的「主 transcript 257」与前序报告的「真实项目 232」不同源。**§5 的 27 个全部沿用前序报告的口径**，未重算分母。
6. **`Grep` 命中数只覆盖 8.9% 的结果。** §3.1 的「命中条数可否当强度信号」这一问的答案是「能，但只对 8.9% 的调用有效」，不是「能」。
7. **本文没有测「模型被拒后会不会照 reason 去做」。** 与本仓已有结论同一条边界：那需要真模型被真拦住，`claude -p` 在本机撞认证闸（前序报告 §2.1）。

---

## 7. 复算清单

```bash
# 全部四节（约 2 分 14 秒，读 2 GB 语料）
node scripts/probe-evidence-sources.mjs

# 单节
node scripts/probe-evidence-sources.mjs --section A   # 子 agent 路径与两套 id 的配对率
node scripts/probe-evidence-sources.mjs --section B   # 续接会话的两种判据
node scripts/probe-evidence-sources.mjs --section C   # 结构性探索与命中数
node scripts/probe-evidence-sources.mjs --section D   # 闸门运行时的可见范围

# 机器可读
node scripts/probe-evidence-sources.mjs --json

# 连沙箱一起看（数字会变，用来验证沙箱判据本身在起作用）
node scripts/probe-evidence-sources.mjs --no-exclude-sandbox --section A
```

**§5 的 27 个会话归因**：复算依赖前序报告的 `observe-reality-check.mjs`（`node scripts/observe-reality-check.mjs --json`），本文的候选覆盖矩阵是在其输出上二次计算。两者分开放，是为了让「闸门拦了谁」与「谁还能救」各有独立、可单独复跑的来源。

## 8. 与仓库已有结论的关系

| 已有 | 本文的补充 |
|---|---|
| `2026-11-14-observe-mode-reality-check.md` §5.3：B2 失配归因为「旧格式（2026-10 及更早），id 命名空间不同」 | **部分修正**：不是时间，是 **provider**。2026-10 同月并存四套命名空间（`call_NN` 1992 / `chatcmpl` 1297 / `call_hex` 1150 / `toolu_bdrk` 150） |
| 同上 §5.3：「全语料 3613 个 meta 里配上 3419（94.6%）」 | **复现并细化**：本机快照 3687 个 meta 里配 3493（94.74%），并按命名空间拆出失配的 194 条 |
| 同上：`A-continuation` 的判据是「首条人类消息是宿主写的续接摘要」（文本正则） | **补一条等价且更硬的判据**：同一条记录上的 `isCompactSummary:true`，在 257 份上**分歧 0** |
| `2026-11-14-pretooluse-desktop-verification.md` §1：hook stdin 十个字段 | **补两个**：`agent_id` / `agent_type`（仅子 agent 调用时出现）；并实测 `transcript_path` **始终是主 transcript** |
| 同上 §5.2：「读 transcript 判断本回合内是否已写过 —— 未实测」 | **本轮实测了其中一半**：闸门在 hook 时刻能读主 transcript，也能读到已落盘的子 agent 正文 |
| `2026-11-13-bash-write-detection.md`（shell 写操作解析） | 本文不动它；但 §4.2 记了一条相邻的**读**侧缺陷：`cat a b c` 只记 `a` |
