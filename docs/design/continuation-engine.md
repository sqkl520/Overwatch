# 续接引擎：读内容 → 判状态 → 验证 → 出指令

> **状态：Proposed，零行实现。** 本文描述的能力目前一行代码都没有。
> 读它之前请先读 [README.md](../../README.md) 的「能力边界」，尤其「本库不能自动接力」那一节。
> 本文第 5 节会证明：**本文描述的能力为什么只能做到「产出指令草稿」，不能做到「让对话自己继续跑」。**

- 日期：2026-11-02
- 触发：用户提的原始需求——「让工具里的 AI 读会话具体内容，判断项目到底达没达到需求，去读真实文件验证，然后直接让对话中的 AI 继续运行」
- 本文回答四件事：读什么、判什么、怎么验证、怎么出指令；外加架构选择、失败模式、最不可靠的一环

---

## 0. 一句话结论

用户的需求拆开是三件事，**前两件可做，第三件受宿主能力约束，本仓库已经实测不可能**：

| 用户要的 | 可行性 | 依据 |
|---|---|---|
| 读会话内容，还原「用户要什么 / AI 做到哪 / 停在哪」 | **可做**，且成本极低（有效上下文 p50 约 315 token） | 本文 §1，本机 182 个 transcript 实测 |
| 读真实文件判断「达没达到」 | **半可做**。只能判「有没有证据」，不能判「对不对」 | 本文 §3，实测「声称测试通过」4 例中 0 例真跑过测试 |
| 直接让对话中的 AI 继续跑 | **做不到**。只能产出让你复制发送的草稿 | [ADR-0001](../adr/0001-config-only.md)、[ADR-0002 §4](../adr/0002-honest-degradation.md) |

第三条不是本文能绕过的。本文把它降到「一条 3 行的草稿 + 一次点击复制」，但**不假装它能自动发送**。

---

## 1. 读什么：从 transcript 里提取有效上下文

### 1.1 五个实测数字（本机，2026-11-02）

| 指标 | 值 | 怎么测的 |
|---|---|---|
| 主 transcript 数 / 总体积 | 182 个 / 1.28 GB | `find ~/.claude/projects -name '*.jsonl'` |
| `user` 记录总量 | 20,513（抽样头 3MB/文件） | 解析后按 `type` 计数 |
| 其中带 `origin.kind === 'human'` | 639 = **3.12%** | 与既有「3.1%」独立吻合 |
| 有效上下文（全部真人消息 + 末 3 条 AI 正文） | p50 **1,007 字符 ≈ 315 token**，p90 4,529 字符 ≈ 1,415 token | 逐会话拼装后取长度分位 |
| 真人消息条数 / 会话 | p50 4 条，p90 12 条，max 58 条 | 同上 |

**这组数字决定了整个设计的形状：读全部真人消息是廉价的。** 不需要「智能选取」，不需要 RAG，不需要摘要链。p90 也就 1.4k token。

### 1.2 结构化判据优先，文本特征兜底

真人与噪声的区别**不需要靠正则猜**。宿主在记录上写了结构化字段：

```json
{
  "type": "user",
  "message": { "role": "user", "content": "..." },
  "origin": { "kind": "human" },
  "promptSource": "typed",
  "turnOrigin": "human",
  "toolUseResult": null
}
```

判据优先级（实测覆盖率：**91.2% 的会话含至少一条带 `origin` 的记录**）：

| 层 | 判据 | 覆盖率 | 可靠性 |
|---|---|---|---|
| L1 | `origin.kind === 'human'` | 全部 `user` 记录的 9.8% 带 `origin` 字段 | **最高**。宿主自己写的来源标签 |
| L2 | `promptSource === 'typed'` / `turnOrigin === 'human'` | 同上 | 高，与 L1 冗余 |
| L3 | 文本特征兜底（见下） | 剩余 8.8% 的会话 | **低**，必须标 `provenance: heuristic` |

**L3 的必要条件**（实测：去掉噪声后「干净消息」里只有 24% 是真人，所以 L3 单独用会严重污染）：

```
排除，满足任一即丢：
  - toolUseResult !== undefined          // 工具结果回灌（占 user 记录 87.2%）
  - isMeta === true                       // 系统元信息（1.4%）
  - message.content 是数组                // 数组内容实测 2823/2838 是 tool_result
  - 文本匹配 <command-name>|<local-command-stdout>|<task-notification>|<system-reminder>
  - 文本匹配 <pasted_content id=...> 前缀且前面无 human 标记   // 实测大量粘贴是真人，不能一概丢
```

> 实测反例：一段「数组 content 且无 `toolUseResult`」的记录，实际内容是 `[{"type":"text","text":"Continue from where you left off."}]` 和 `[Request interrupted by user]`。
> 这两条**是宿主注入，不是真人**。但它们与真人打断在语义上等价（都表示「人希望继续」），
> 所以 L3 里把它们归为 `injected_imperative` 一个单独类别，不当作需求来源，但参与「停在哪」的判定。

### 1.3 排除系统注入：一个必须显式建模的类别

原有结论「96.9% 不是真人」是对的，但把它当成「噪声一律丢弃」会在两处出错：

| 类别 | 实测样例 | 丢弃？ | 为什么 |
|---|---|---|---|
| 工具结果回灌 | `toolUseResult.stdout` | **丢**（但留给 §3 用） | 不是对话，是证据 |
| slash 命令回显 | `<command-name>/model</command-name>` | 丢 | 无需求信息 |
| 后台任务通知 | `<task-notification>...<status>completed</status>` | **留作事件** | 它解释「为什么 AI 又动了一下」，是停顿点的成因之一 |
| 子 Agent 返回摘要 | `agentId/description/status` 形态的 toolUseResult | 留作**分工线索** | 它说明「这部分交给子 Agent 了」，避免把委派误判为遗漏 |
| `away_summary` | 宿主自写的「你要什么 / 已做到哪 / 下一步」 | **一等输入** | 覆盖率仅 3.3%，但质量最高，见下 |
| `continued-in` | `{ continuedInSessionId: "..." }` | **必读** | 会话被分叉了。见 §6 失败场景 F-5 |

**`away_summary` 是免费的高质量摘要，但覆盖率太低（6/182 = 3.3%），只能当加速器，不能当依赖。** 实测样例：

```
"You wanted scrollback fixed in Claude Code; Node/npm are confirmed and
 claude-code-scroll 0.1.0 is installed and verified. Next: run claude-scroll,
 or just set CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 alone if the problem is
 buttons not scrolling."
```

它有意图、有状态、有下一步——恰好是本引擎四段输出的三段。**遇到就用，遇不到不补。**

### 1.4 「有效上下文包」（Context Bundle）的字段

这是本文的输出物之一，后续所有环节只读它，不再读原始 transcript。

```jsonc
{
  "schema": "overwatch.context-bundle/1",
  "sessionId": "…",
  "cwd": "…",                    // 来自末尾记录的 cwd，不是猜的
  "transcript": { "path": "…", "bytes": 115351008, "scannedBytes": 115351008, "mode": "full" },
  "provenance": "structured",    // structured | heuristic | degraded

  "intent": {                    // 用户要什么，按时间排列，不合并
    "source": "first_human | job_intent | host_summary",
    "verbatim": "给这个插件加一个登录功能…",   // 原文，不摘要
    "corrections": [                            // 后续修正，逐条原文
      { "at": "…", "verbatim": "不是登录，是 OAuth 回调" }
    ]
  },

  "progress": {                  // AI 做到哪，只要事实，不要自述
    "turns": 42,
    "humanMessages": 7,
    "touchedFiles": ["…"],       // 来自 Edit/Write/file-history-delta，不来自 AI 自述
    "testCommandsRun": [],       // 来自 Bash 命令词表匹配
    "gitOps": [],                // commit/push/merge，含 hash
    "subagentCount": 3,
    "lastAssistantText": "…",    // 末条正文，截断到 2000 字符
    "lastToolCall": { "name": "Bash", "cmd": "npm run build", "at": "…" }
  },

  "stopPoint": {                 // 停在哪，分类见 §2.2
    "kind": "asked_question | said_done | interrupted | failed_tool | host_blocked | session_forked | unknown",
    "evidence": "原文引用",
    "idleMs": 1234567
  },

  "openLoops": [                 // 悬空的东西：谁在等谁
    { "kind": "todo",      "text": "…", "at": "…" },
    { "kind": "unanswered", "text": "…", "at": "…" },   // AI 问了没答
    { "kind": "failed_cmd", "text": "npm run build", "stderr": "…" }
  ]
}
```

**硬约束：`intent.verbatim` 与 `corrections[].verbatim` 必须是原文**，禁止摘要。
理由见 `docs/spec/evidence-discipline.md` §1 第 2 条——转述之后无法判断是不是编的。摘要在 LLM 手里是廉价动作，但它是**冲突检测**的唯一依据：用户中途改了需求，摘要会把改动抹平。

### 1.5 读取策略：全量扫，还是头尾各读一段

这是本设计里唯一被我实测推翻的初始假设。

| 策略 | 真人消息捕获率 | 单会话耗时 |
|---|---|---|
| 头 1MB + 尾 1MB | **36.8%**（756/2055） | ≈ 20ms |
| 头 512KB + 尾 512KB | 23.9%（492/2055） | ≈ 10ms |
| **全量线性扫** | **100%** | 110MB → **7.6 秒**；65MB → 3.7 秒 |

最坏的会话：69 条真人消息，头尾各 1MB 只捞到 6 条。原因是**需求散落在中段**——用户在第 30 轮改需求，那一轮既不在头也不在尾。

全量扫 1.28GB 全语料要 **69 秒**（18.9 MB/s，JSON.parse 主导）。这个成本只有在「一次扫全部」时不可接受。

**结论：按需单会话全量扫。**

```
判断发生在用户点开某一个会话时（TUI 按 Enter / 命令行指定 session-id）
  → 只扫那一个文件 → p50 会话 < 1 秒，110MB 极端情况 7.6 秒 → 可接受
批量为全部会话生成 bundle → 不可接受（69 秒）→ 不做
```

**这一条直接推翻了架构 (b)**：如果由脚本在后台扫描全部会话再判断，代价不可接受。见 §5。

> 落地要求：`scan-sessions.mjs` 现有的 `parseJsonl(path, maxBytes)` 是**读尾部**的。
> 新代码不能复用它来拿「全部真人消息」。可以直接复用它的 `parseJsonl`（`maxBytes = Infinity` 时天然退化为整读），
> 但必须新增流式版本，否则 110MB 文件会被整个读进内存。

---

## 2. 判断什么：三问，且每问都要有 falsifier

设计原则来自本仓库三次失败的信号（`docs/research/2026-11-01-ground-truth-first.md`）：
**先造指标再验证，必然测到 0.018% 的东西。** 所以每一问都必须先写清「什么样的证据会推翻它」。

### 2.1 三问的定义

| 问 | 判定 | 输出枚举 | 推翻它的证据（falsifier） |
|---|---|---|---|
| Q1 达没达到 | 需求条目 × 证据 | `MET` / `PARTIAL` / `UNMET` / `UNVERIFIABLE` | 找到一条已声明需求，其证据只能从 AI 自述取得 |
| Q2 差在哪 | 未闭环项清单 | `openLoops[]` | 某项其实已在后续轮次被解决（时序检查） |
| Q3 下一步 | 一条可执行动作 | `nextAction` | 这个动作会导致重复劳动 / 与需求冲突 |

**`UNVERIFIABLE` 必须是一等状态，不是失败。** 理由是实测：只有 5% 的会话里能找到测试命令执行记录，30% 的会话改了文件却从没跑过测试或 git。对它们只能判「无法验证」，判 `MET` 是撒谎，判 `UNMET` 是冤枉。

### 2.2 「停在哪」的分类（stopPoint.kind）

这是 Q3 的输入，也是本引擎与原 `scan-sessions` 四态最大的区别：**四态描述的是活动量，这里描述的是因果关系。**

| kind | 判据 | 处置 |
|---|---|---|
| `asked_question` | 末条 AI 正文以问句结尾，且后面无真人消息 | 答它；若问题本身是需求澄清，见 §6 F-2 |
| `said_done` | 末条 AI 正文声称完成（词表 + 无后续动作） | **进 §3 验证**。这是最危险的一类 |
| `interrupted` | 末条是 `[Request interrupted by user]` | 不要替用户继续，先问用户 |
| `failed_tool` | 末条 toolUseResult 的 `stderr` 非空或 `interrupted: true` | 从失败命令重建下一步 |
| `host_blocked` | `~/.claude/jobs/*/state.json` 的 `state ∈ {blocked, failed}` | 读 `needs` / `suggestedReply`，优先于一切推断 |
| `session_forked` | 存在 `continued-in` 记录 | **不要续接旧会话**，转到 `continuedInSessionId` 的新文件 |
| `unknown` | 以上都不匹配 | 只给草稿骨架，不给结论 |

> 末条记录常常**不是对话**：实测 182 个会话的末尾记录类型是 `cost-state`(39) / `last-prompt`(78) / `atis-latch`(15) / `attachment`(5) / `assistant`(5)。
> 直接取「最后一行」会把成本统计当成 AI 的最后一句话。**必须跳过元数据类型，回溯到真正的 `assistant` / `user`。**

### 2.3 为什么不用现有的四态

现有四态（`PRODUCING` / `EXPLORING` / `STALLED` / `FAILED`）测的是**动量**：窗口内有没有写入、novelty 高不高。
本引擎要的是**因果**：它为什么停、停在一个需要什么动作的状态。

两者不能互换。举例：一个会话末态 `PRODUCING`（刚写完文件），但它其实已经完成了任务并且在等用户验收。按动量看它在产出，按因果看它 `said_done` 且待验证。**用四态驱动续接，会在正确完成的地方再推一把，产生重复劳动。**

**结论：本引擎不吃 `state` 字段，只吃 `context-bundle`。** 四态继续服务于「哪个会话值得看一眼」，本引擎服务于「看一眼之后做什么」。

---

## 3. 验证：如何证明「AI 说完成了」是真的

### 3.1 先看实测：自述有多不可信

| 指标 | 实测 | 样本 |
|---|---|---|
| 末条 AI 声称「测试/构建通过」的会话 | **4** | 182 个 transcript |
| 其中**实际执行过** test/build 命令的 | **0** | 同上 |
| 改了文件但从未跑测试、也从未 git commit 的会话 | 54 / 183 = **30%** | 尾部 2MB |
| 跑过测试的会话 | 9 / 183 = **5%** | 同上 |
| 有 git commit/push 的会话 | 75 / 183 = **41%** | 同上 |
| 会话改过的文件路径，现在还在磁盘上的 | 815 / 1455 = **56%** | 同上 |

**「声称通过」的 4 例里，0 例真跑过测试。** 这个方向与用户的直觉一致，但机制值得说清：
其中一例是改 CHANGELOG 后说「P0 全部落地」，一例是说「curl 都正常」——后者确实执行了 5 次 curl，
只是我的 `TEST_CMD` 词表不含 curl。**所以「没跑测试」≠「说假话」，只能说明「测试不是它的证据」。**

这决定了验证的设计：**不判断 AI 有没有撒谎，只列举它留下了什么可复验的东西。**

### 3.2 证据分级（这是本设计的核心机制）

按可信度从高到低，**低级别不能替代高级别**：

| 级 | 证据 | 从哪来 | 能证明什么 | 实测可得率 |
|---|---|---|---|---|
| **E1** | 宿主记录的文件变更 + 备份版本 | `file-history-delta.trackingPath` + `backup.version` | 某个文件**在某时刻被改过**，且宿主留了备份 | 含 `trackingPath` 的 delta 513 条 |
| **E2** | 命令真实输出 | `toolUseResult.stdout/stderr` | 某命令跑过，输出是这个 | 27,233 条工具结果 |
| **E3** | 当前磁盘状态 | 现在去读那个文件 / 跑 `git status` | 文件**现在**长这样 | 路径存活率 56% |
| **E4** | AI 自述 | `assistant.message.content[].text` | **什么都不证明** | 100% |
| **E5** | 宿主意图记录 | `jobs/*/state.json.intent` | 用户原始要什么（覆盖率 16/18 = 89%） | 89% |

**规则：任何 `MET` 判定必须至少有一条 E1/E2/E3。只有 E4 的需求条，判 `UNVERIFIABLE`。**

`file-history-delta` 的样例（这是 E1 的形态，注意它有绝对路径和备份版本号）：

```json
{"type":"file-history-delta",
 "trackingPath":"<project-D>\\<module>\\src\\main\\java\\...\\LocaleUtils.java",
 "backup":{"backupFileName":"a73b73b3812fbf89@v1","version":1,
           "backupTime":"2026-10-08T15:49:05.505Z",
           "realParentDir":"<project-D>\\<module>\\src\\main\\java\\..."}}
```

### 3.3 验证动作的可执行清单

判定器（§5）可以调用的验证动作，**全部只读**：

| 动作 | 命令形态 | 输出到哪 |
|---|---|---|
| 文件存在性 | `stat <path>` | `evidence: {kind: "exists", path, mtime}` |
| 文件内容断言 | `grep -n <symbol> <path>` | `evidence: {kind: "contains", path, line, text}` |
| 版本控制状态 | `git -C <cwd> status --porcelain` | `evidence: {kind: "git", dirty: [...]}` |
| 提交是否存在 | `git -C <cwd> log --oneline -n 20` | `evidence: {kind: "commit", hash, subject}` |
| 测试是否通过 | **不代跑**，只查 transcript 里有没有 E2 | `evidence: {kind: "test_output", verbatim}` |
| 服务是否在跑 | 不查。这是运行时状态，不是项目状态 | 不适用 |

三条硬规则：

1. **不代跑有副作用的命令。** `npm test` 会写缓存、`mvn` 会下依赖、`npm install` 会改 `node_modules`。判定器是只读角色（tools 无 `Bash`），需要命令时必须由主线程转派 `oversight-executor` 并声明预算。
2. **不猜测用户的验收标准。** 「加个登录功能」的验收标准必须来自用户原话或 `jobs/*/state.json.intent`。判定器**不得**自己补一条「登录应该支持 OAuth」然后判 UNMET。这是 `oversight-acceptor` 的「不得事后新增标准」在同一条原则上的延伸。
3. **56% 的路径会失效。** 旧会话里超过四成的改动路径已经不在磁盘上（临时目录、已重命名的仓库、被删的分支）。这时的判定是 `UNVERIFIABLE(dangling_path)`，**不是 `UNMET`**。

### 3.4 一个具体例子，走完整条链

用户说「加个登录功能」，AI 说「已完成」，transcript 里有 3 次 Edit 到 `src/auth/login.ts`。

```
Q1: 需求「加登录功能」
  ├─ 拆成可验证断言（来源：用户原话，不得补充）
  │    A1 存在登录相关代码            ← 用户原话「加个登录功能」
  │    A2 它能被调用                  ← 「加个功能」的隐含最低要求（须标 inferred）
  │    A3 它按用户说的方式工作        ← 用户没说方式，**不得推断**
  ├─ A1: E1 有 file-history-delta 指向 src/auth/login.ts  → MET
  ├─ A2: E3 grep 到 export function login 且被 route 引用 → MET
  └─ A3: 无依据                                          → UNVERIFIABLE
结论: PARTIAL (2 MET / 0 UNMET / 1 UNVERIFIABLE)
      → 下一步不是「重做登录」，是「向用户确认登录方式」
```

**注意最后那一行。** 这是「差在哪」的正确输出形态：`UNVERIFIABLE` 要转成**一个问用户的问题**，而不是一个让 AI 去猜的指令。

---

## 4. 生成指令：怎么保证是「继续」而不是「重来」

### 4.1 指令的六要素（缺一不可）

沿用并扩展 `docs/spec/relay-protocol.md` §4.2 的三要素：

| # | 要素 | 来源 | 反例 |
|---|---|---|---|
| 1 | 停滞点定位 | `stopPoint` + 原文引用 | 「上一步好像失败了」 |
| 2 | **已完成清单** | `progress.touchedFiles` + E1/E2 | 缺这一项 = 指令会让人重做 |
| 3 | 未闭环项 | `openLoops[]` | 「继续推进」 |
| 4 | 具体下一步 | 一条命令或一个明确动作 | 「你看着办」 |
| 5 | 决策授权 | 「如果 A 不行就做 B，不用问我」 | 无 → 下一轮还停 |
| 6 | **禁止重复声明** | 「不要重做已完成的 X」 | 无 → AI 重写一遍已有代码 |

**第 2 和第 6 是本文相对现有 relay 协议新增的。** 原因是「继续」的最大风险不是方向错，是**重复劳动**：AI 没有完整的上文（上下文被压缩过），你让它「继续做登录」，它可能把已有的 `login.ts` 重写一遍。

### 4.2 模板（实际输出形态）

```markdown
继续。你停在 <stopPoint.evidence 原文>。

**已完成，不要重做**：
- src/auth/login.ts（3 次编辑，2026-11-02T10:12Z）
- `npm run lint` 通过（输出见 transcript #4412）

**还差**：<openLoops[0] 原文>

下一步：`<具体命令>`
如果 <失败形态>，改用 `<fallback>`，不用问我。
```

### 4.3 防冲突检查（必须执行，不能靠 prompt 自觉）

生成后、交付前，过三道机器检查：

| 检查 | 判据 | 不通过怎么办 |
|---|---|---|
| **需求冲突** | 指令里的动作是否与 `intent.corrections[]` 任一原文矛盾 | 打回重写，冲突项列入 `conflicts[]` |
| **重复劳动** | 指令要求修改的文件是否在 `progress.touchedFiles` 里 | 允许，但必须显式写「修改已有 X，不是新建」 |
| **红线** | 沿用 `relay-protocol.md` §3 五类 | 退 `oversight-safety`，判 `REJECT` |

需求冲突检查是新东西，值得单说。实测用户会中途改需求（`corrections` 非空的会话很多），而 AI 的最终状态是按**旧需求**跑的。这时你的指令如果按旧需求写，等于把用户已经放弃的方向又推回去。

**这条检查不能由生成指令的同一个角色做**——那是自己检查自己。必须由另一个只看「指令 + 用户原话」的角色做。这与 `CLAUDE.md` 硬约束 3「锐评不能由执行者自己写」同源。

### 4.4 长度与形态

沿用现有约束：≤5 行、≤1 个命令块、不重复目标会话已有的上下文。
新增一条：**「已完成清单」不计入 5 行限制**。它必须写清，挤不下就砍「决策授权」，不能砍已完成清单。

---

## 5. 架构：三种做法的代价，以及推荐哪个

### 5.1 三种做法的实测约束

| 方案 | 可行性 | 实测约束 | 代价 |
|---|---|---|---|
| **(a) 新 agent 角色** `.claude/agents/oversight-judge.md` | **可做** | 需被 SKILL.md 提及（硬门 `checkAgentReachability`）；只读角色 tools 不得含 `Edit`/`Write`/`Bash`（硬门 `checkAgents`） | 每次判断消耗一个子 Agent 的 context；无状态，不可回归测试 |
| **(b) 脚本调 API** `judge.mjs` + Claude API | **本机不可做** | `claude -p` 实测返回 `Not logged in · Please run /login`；无 `.credentials.json`；`customApiKeyResponses` 只有代理占位符 | 需要用户自备 API key 与计费；引入依赖，破坏「零依赖」承诺 |
| **(c) 派发子 Agent** 由主线程临时 `Agent` 调用 | **可做** | 同 (a)，但没有角色定义 → prompt 无法版本管理 | prompt 散落在调用点，改一次要改多处；`check-structure` 管不到 |

### 5.2 推荐：**确定性脚本产出 bundle + 角色定义做判断**（a 的变体）

拆分点选在「能不能用代码写死」：

```
Node 脚本（确定性，零依赖，可单测）        Agent（判断性，不可测）
─────────────────────────────────        ──────────────────────────
读 transcript → context-bundle     →      Q1 达没达到（需要理解需求）
跑 E1/E2/E3 证据收集                →      Q2 差在哪
执行 §4.3 三道机器检查               →      Q3 下一步（需要写自然语言）
一致性/覆盖率校验                    →      指令正文
```

三条理由：

1. **bundle 的产出必须可单测。** 本届的规则是「改了必须跑全量测试」。如果 bundle 由 Agent 产出，测试无法覆盖，它就成了第二个「看起来在工作、实际六小时没扫过东西」的 `watch.mjs`（DF-023）。
2. **判断环节无法写死。** 需求理解、`UNVERIFIABLE` 与 `PARTIAL` 的界线、下一句话怎么说——这些是语言判断，写成规则必然出现「0.018% 命中」。
3. **bundle 是缓存单元。** 同一个会话反复判断，不该反复读 110MB。bundle 落 `tasks/runs/<id>/context-bundle.json`（gitignored），带 `scannedBytes` 与文件 mtime，用于失效。

### 5.3 角色定义（`oversight-judge`）的规格

```yaml
name: oversight-judge
tools: Read, Grep, Glob          # 无 Bash：不能自行跑命令（见 §3.3 规则 1）
model: inherit                    # 要理解需求，不能给 haiku
maxTurns: 20
dispatched-by: other              # 或写进 SKILL.md，二选一
```

输入只有三样，**这是硬约束**：

1. `context-bundle.json`（§1.4）
2. `evidence.json`（脚本收集的 E1/E2/E3）
3. 用户原话（`intent.verbatim` + `corrections[].verbatim`，**逐字，不摘要**）

**不给它**：原 transcript 全文（会淹没在 19 万行里）、现有 relay 草稿（避免锚定）、`scan` 的 `state` 字段（避免用动量代替因果）。

### 5.4 为什么不选 (b)，说得更清楚一点

(b) 的吸引力是「后台自动扫所有会话」，这恰好是**用户需求里最想要的部分**。它不可行的原因有两层：

- **表层**：本机没有可用凭据，`claude -p` 未登录。这是环境问题，理论上可解。
- **深层**：即使有凭据，全语料扫一遍 69 秒（实测）。要判断 N 个会话就要 N×(单会话成本)，而这一步无法增量——因为真人消息散落中段，没法只读尾部做增量。**成本随会话数线性增长，且每个会话都不可省。**

而用户真正需要判断的会话数是**个位数**（当前在等的、停下来的）。所以按需判断在成本上优一个数量级。

---

## 6. 会失败的场景

### F-1 AI 说完成，实际没完成

- **实测**：声称「测试通过」4 例，实际跑过测试 0 例。
- **应对**：`said_done` 一律不采信，强制走 §3。只有 E1/E2/E3 才判 `MET`。E4 单独存在 → `UNVERIFIABLE`。
- **残余风险**：E3（现在去读文件）会把「后来的别的会话改的」算成「这个会话做的」。缓解：E3 必须与 E1 的 mtime 比对，时间在会话之后的不计入。

### F-2 用户需求本身模糊

- **实测**：真人消息 p50 长度 **34 字符**，45% 短于 30 字符（2,528 条样本，见 `2026-11-01-ground-truth-first.md`）。「修一下」「继续」这类不是需求。
- **应对**：需求可验证断言数 = 0 时，输出**不是草稿，是一句提问**。引擎要敢于说「我不知道你要什么」。
- **必须避免**：拿 AI 的猜测当需求。这是 LLM 判定器最容易犯的错——它会自动把「加个登录功能」脑补成完整 PRD，然后按脑补的 PRD 判分。

### F-3 说没完成，其实完成了

- **实测**：56% 的历史文件路径已失效；30% 的会话改了文件但没跑测试也没 commit。
- **应对**：这些全部落 `UNVERIFIABLE`，**不落 `UNMET`**。二者的处置完全不同：`UNMET` → 继续干；`UNVERIFIABLE` → 问用户。
- **残余风险**：用户看到一堆 `UNVERIFIABLE` 会觉得工具没用。这是诚实的代价，见 `docs/adr/0002-honest-degradation.md`。

### F-4 会话被分叉了，你续接的是旧壳

- **实测**：9 个会话有 `continued-in` 记录，其中 4 个目标文件存在。
- **后果**：往旧会话发指令，AI 看到的是「到分叉点为止」的历史，会把已经做过的再做一遍。这与 `ADR-0001` 描述的 `--resume` 副本问题是**同一类错误的不同来源**。
- **应对**：`stopPoint.kind = session_forked` 时，拒绝为旧会话出草稿，改指向 `continuedInSessionId`。若目标文件不存在，判 `UNVERIFIABLE(fork_target_missing)` 并只提示用户。

### F-5 输出了「重来」而不是「继续」

- **成因**：AI 的上下文被压缩过，不记得自己做过什么。
- **实测依据**：110MB 的会话对应 19,152 条记录，远超任何窗口。
- **应对**：§4.1 第 2、6 要素（已完成清单 + 禁止重复声明）为强制项；§4.3「重复劳动检查」机器执行。

### F-6 用户的修正被漏掉

- **成因**：只取第一条真人消息当需求。
- **实测**：真人消息 p90 有 12 条，其中相当一部分是修正。
- **应对**：`intent.corrections[]` 保存**全部**真人消息原文；§4.3「需求冲突检查」必须与全部修正比对。

### F-7 判定器被 transcript 里的推理文本说服

- **成因**：AI 的 `thinking` 块写得头头是道，判定器读了会认同。
- **先例**：`oversight-probe` 的定义里已经写死「不要读目标 Agent 的推理文本」，理由就是「读了就会认同它的思路」。
- **应对**：bundle 在脚本层**物理剥离** `thinking` 块。不依赖判定器自律——`oversight-probe` 的教训是靠 prompt 约束不如靠数据层不给。

### F-8 一次判断消耗掉整个上下文

- **实测**：bundle p50 315 token、p90 1,415 token。加上证据与原话，仍在 3k token 内。
- **残余风险**：证据 `verbatim` 可能很长（一条 `git log` 20 行）。应对：`evidence[].verbatim` 单条上限 500 字符并标 `truncated: true`，**截断必须声明**，不能悄悄截。

### F-9 会话刚刚好、但被判定器判成未完成

- **成因**：`said_done` 之后用户再也没有说话，主机又没报 `blocked`。
- **实测**：87.5% 的「停止」AI 并没有在问任何问题——它只是说完了，人走开了（`2026-11-01-ground-truth-first.md`）。
- **应对**：`said_done` + E1/E2/E3 齐全 → 明确输出「**已完成，无需续接**」。引擎的价值包含「告诉你不必做什么」。若判定器永远只会输出「继续」，它就是个误报生成器——这正是 `hb_gap` 被删除的原因。

### F-10 读到的不是「用户的」项目

- **成因**：会话的 `cwd` 可能是临时目录（实测 `<temp-dir>`、`<scratch-repo>` 等），也可能是仓库子目录（同一仓库出现 4 个不同 cwd）。
- **应对**：`cwd` 取自 transcript 的 `cwd` 字段（**不是从项目 slug 反推**）；先 `git rev-parse --show-toplevel` 归一到仓库根，再取证据。临时目录下的会话默认 `UNVERIFIABLE(ephemeral_cwd)`。

---

## 7. 数据流（文字版）

```
① 触发
   用户点开某会话（TUI Enter）   或   `node scripts/judge-context.mjs <session-id>`
        │
        ▼
② 采集（脚本，确定性）          judge-context.mjs
   ├─ locate:   sessionId → ~/.claude/projects/<slug>/<id>.jsonl
   │            若遇 continued-in → 改指向新 id
   ├─ scan:     全量流式扫描（§1.5），剥离 thinking / tool_result
   ├─ jobs:     读 ~/.claude/jobs/*/state.json（intent / needs / suggestedReply / state）
   └─ host:     读 ~/.claude/sessions/*.json（pid 活着 → 该会话可能仍在跑，标记 live）
        │
        ▼
③ 产出 bundle                  → tasks/runs/<id>/context-bundle.json
   字段见 §1.4；provenance ∈ {structured, heuristic, degraded}
        │
        ▼
④ 收集证据（脚本，只读）        evidence.json
   E1 file-history-delta / E5 jobs.intent
   E2 toolUseResult.stdout/stderr
   E3 现在去 stat/grep/git status（受 §3.3 规则 1 约束，不跑有副作用的命令）
   每条证据带 {kind, verbatim, at, truncated}
        │
        ▼
⑤ 判定（oversight-judge Agent）
   输入: bundle + evidence + 用户原话逐字
   ├─ Q1 需求条目 × 证据 → MET / PARTIAL / UNMET / UNVERIFIABLE
   ├─ Q2 openLoops 时序去重（后轮已解决的移除）
   └─ Q3 nextAction（或「无需续接」）
        │
        ▼
⑥ 生成指令（同一 Agent，或独立 relay Agent —— 见 §9 最不可靠的一环）
        │
        ▼
⑦ 三道机器检查（脚本）
   需求冲突 / 重复劳动 / 红线
   ├─ 任一不通过 → 打回 ⑥（≤2 轮）
   └─ 全通过 ↓
        │
        ▼
⑧ 交付
   TUI 展示：结论 + 依据（证据表）+ 草稿
   用户按 c 复制 → **用户自己粘贴发送**
   草稿落 tasks/runs/<id>/relay-draft-<n>.md，sent 由用户确认
```

全程**没有自动发送**。⑧ 之后宿主侧没有任何动作，这是 `ADR-0001` 的结论，本文不改。

---

## 8. 每个环节的输入输出（速查）

| # | 环节 | 输入 | 输出 | 失败表现 | 兜底 |
|---|---|---|---|---|---|
| ② | 采集 | sessionId | `context-bundle.json` | 文件不存在 / 全坏行 | `provenance: degraded`，只出骨架 |
| ④ | 证据 | bundle | `evidence.json` | 路径失效 | 标 `dangling_path`，可继续 |
| ⑤ | 判定 | bundle + evidence | 五态判定 + `openLoops` | 需求断言为空 | 转为提问，不出草稿 |
| ⑥ | 生成 | 判定结果 | 草稿文本 | 超 5 行 / 含红线 | 打回重写 ≤2 轮 |
| ⑦ | 检查 | 草稿 + 修正清单 | `pass` / `reject(reason)` | 冲突未检出 | 见 §9 |
| ⑧ | 交付 | 通过件 | 用户可见的结论 + 依据 | 用户不看依据 | 见 §10 |

---

## 9. 最不可靠的一环

**是 ⑥「生成指令」，而不是很多人会先怀疑的 ⑤「判定」。**

理由分三层，每层都有本仓库的先例：

**第一层：判定有真值可对照，生成没有。**
Q1 的判定可以拿「文件到底存在吗」检验。但「这条指令是不是最优下一步」**没有任何可计算的真值**。同一份 bundle，两个合格的执行者会给出两条都合理的指令，无法判定谁对。这是本仓库第一次遇到「无法构造 falsifier」的环节。

**第二层：生成是唯一同时被三方拉扯的环节。**
它要同时满足：用户原意（§4.3 冲突检查）、不重复劳动（§4.3 重复检查）、红线清单（`relay-protocol.md` §3）、≤5 行（§4.4）。四条约束在一个自然语言句子里争夺空间。现有 relay 协议只写了 3 条就已经需要 Safety Agent 单独过一遍。

**第三层，也是最致命的：按 `CLAUDE.md` 硬约束 3，生成者不能自评；但指令的质量只有在用户发出去、目标会话回应之后才能验证。**
于是形成一个循环：判断→生成→发送→观察结果→才知道判断对不对。而这个观察结果**永远不会回流成训练信号**，因为本库没有运行时、没有真值标注、`sent` 字段还要用户手动确认。
`docs/research/2026-10-31-first-production-metric.md` 已经踩过这个坑：可追溯率这个指标「能测」，是因为每条通知都能回溯宿主事实。指令质量没有对应的宿主事实可回溯。

**推论（这一条改变架构）：**

1. **判定与生成必须由两个角色做。** 判定者看到证据和原话；生成者只看到「结论 + 已完成清单 + 未闭环项」，**不看证据细节**。这既防止生成者用证据为自己辩护，也让「必填要素」变成生成者唯一的自由度——自由度越小，越可能被机器检查兜住。
2. **指令不追求「最优」，只追求「不犯错」。** 目标从「给出最好的下一步」降级为「不重做、不冲突、不越红线」。这是可判定的。
3. **必须记录 `sent` 与后续**，哪怕只是用户点一下「已发送」。没有这个信号，这个能力永远无法知道自己准不准。这条**比任何实现细节都重要**。

---

## 10. 怎么让人看到依据，而不只是结论

四条硬约束，都来自本仓库已有的失败教训：

1. **结论与依据同屏，依据不可折叠。** 现有 TUI 的详情页已经有这个形态，直接复用：判定在上，证据表在下。用户要能一眼看出「它凭什么说完成」。
2. **每条判定必须带 `file:line` 或原文引用**（`evidence-discipline.md` §1 四件套）。写不出证据的判定项，输出为 `UNVERIFIABLE`，不许输出为 `MET`。
3. **覆盖声明强制**（`evidence-discipline.md` §4）：告诉我它读了哪些文件、**没**读什么、哪些无法核实。没有覆盖声明的判定不计入结论。
4. **判定器必须能说「无需续接」。** 一个只会输出「继续」的引擎等于 `hb_gap`——5 条通知 5 条误报的复刻。**「不用做」是一等结论，不是失败。**

---

## 11. 与现有设计的关系（避免重复造）

| 已有 | 关系 | 处置 |
|---|---|---|
| `docs/spec/relay-protocol.md` | 本引擎是它的上游：先判「要不要续接」，再按它的格式出草稿 | 不重复它的草稿格式与红线清单，直接引用 |
| `oversight-relay` Agent | 保留，作为 ⑥ 的候选实现 | 需要新增「已完成清单」要素（§4.1 第 2 条） |
| `oversight-probe` Agent | 与本引擎判的东西不同：它判「是否在循环」，本引擎判「达没达到」 | 不合并。probe 读行为日志，judge 读需求与证据 |
| `oversight-acceptor` Agent | 概念最近，但它是「给我标准我来判」，本引擎是「没有标准我去找证据」 | 复用它的「不得事后新增标准」「找不到证据即不通过」两条原则 |
| `scan-sessions.mjs` 的四态 | **不吃它的 `state` 字段**（§2.3） | 它继续服务「哪个会话值得看」，本引擎服务「看了之后做什么」 |
| `asked.mjs` | 它只找「问了没答」，是本引擎 `stopPoint.kind = asked_question` 的一个特例 | 判定层可调用它的判据；bundle 层不重复实现 |

---

## 12. 明确不做的

| 不做 | 为什么 |
|---|---|
| 自动把指令发进目标会话 | `ADR-0001` 已实测不可能；本文不重新论证 |
| 后台批量判断全部会话 | 69 秒/全语料，且无法增量（§1.5） |
| 代跑测试或构建来验证 | 有副作用；只读角色无 `Bash`（§3.3） |
| 由 AI 补全用户没说的验收标准 | 会让 `UNMET` 变成可制造的状态（§3.3 规则 2） |
| 用 `state` 四态驱动续接 | 动量≠因果（§2.3） |
| 读 AI 的 `thinking` 做判定 | 会被推理文本说服（F-7，`oversight-probe` 已有先例） |

---

## 附：本文所有实测的复算入口

数字都会随会话增长变化，比例稳定。复算方式（零依赖，Node ≥ 18）：

```bash
# 真人消息占比（本文 3.12%）
node -e "…"   # 见下方口径

口径：
  语料     = ~/.claude/projects/<slug>/*.jsonl（主 transcript，不含 subagents/）
  真人     = record.type==='user' && record.origin?.kind==='human'
  噪声     = toolUseResult!==undefined || isMeta===true || Array.isArray(content)
  全量扫描 = createReadStream + readline（110MB → 7.6s，1.28GB → 69s）
```

> **诚实标注**：本文的 §1.1、§1.5、§3.1 数字取自我在 2026-11-02 对 182 个主 transcript 的实测，
> 样本是**本机单机**，且部分指标（如「声称测试通过 4 例」）样本量极小，只能证明方向，不能给出比率。
> 其中「测试通过 4 例中 0 例真跑测试」经复核有一例实际执行了 5 次 `curl`——是我的命令词表不含 curl，
> **不是 AI 撒谎**。保留这个反例，因为它是本文最想避免的那类结论：把「我的检测器没找到」写成「它不存在」。

