# 下一阶段规划：优先级判定与任务拆解

> **状态：Proposed（规划产物，零行实现）。**
> 本文件不是能力说明。系统现在能做什么，读 [README.md](../../README.md) 的「能力边界」。
> 本文件回答一个问题：**接下来该做哪五件事，为什么是这五件，为什么不是别的那些。**

- 日期：2026-11-04（规划；现场核对于 2026-11-09）
- 作者：规划 Agent P1
- 产出形态：artifact
- 前置输入：用户原话「让工具中的 AI 能读到对话的具体内容，判断该如何继续因任何原因停下的项目，
  去读真实文件判断这个项目到底达没达到用户的需求，然后直接让对话中的 AI 继续运行」
- 用户已定约束：CLI 优先（否掉桌面 GUI）；允许只读命令与测试，不允许写文件与 git 操作；
  超过 7 天的 blocked 直接标过期

---

## 零、覆盖声明（先声明我读了什么，没读什么）

**读了**：`README.md`、`CLAUDE.md`、`docs/adr/0001-config-only.md`、`docs/adr/0002-honest-degradation.md`、
`docs/spec/2026-11-02-autorelay-acceptance.md`（全 12 条否决项）、
`docs/research/2026-11-02-redteam-deterministic.md`、`docs/research/2026-11-03-verify-claims.md`、
`docs/research/2026-11-01-relay-delivery-probe.md`、`docs/research/2026-10-31-first-production-metric.md`、
`docs/research/2026-11-01-ground-truth-first.md`、`docs/design/README.md`、
`docs/design/continuation-engine.md`、`docs/design/frontend-and-shape.md`、
`docs/spec/state-model.md` §2.0.1–2.0.2、`docs/spec/dispatch-contract.md` §1–§5、
`docs/observe-period.md`、`docs/CHANGELOG.md`（Unreleased 段与版本表）、
`tasks/accepted-deviations.md`（AD-001–AD-004）、`tasks/dev-findings.md`（DF-001 起）

**读了代码**：`scripts/watch.mjs`（`NOTIFY_STATES`、`NOTIFY_KINDS`、`HOST_FACT_STATES`、`canNotify`、
`probeJobs`、`probeWaiting`、`candidatesFromScan`、`classifyCandidate`、`findStopPoint`、
`dispatchCandidates`、`runTick`、`startWatch`、`createLogger`、`loadState`/`saveState`/`claimOwnership`/见证文件）、
`scripts/classify-stop.mjs`、`scripts/stop-signals.mjs`、`scripts/asked.mjs`、
`scripts/scan-sessions.mjs` 的 `judgeState`/`readLiveSessions`、`scripts/verify-claims.mjs` 的导出面、
`scripts/check-structure.mjs` 的硬门（`checkDesignIndex`、`checkChangelog`、`checkAgents`）

**做了**：对生产数据目录做了**只读**取证（文件大小、NUL 字节比、mtime、进程命令行、jobs/sessions 计数）；
没有运行任何测试，没有修改任何现有文件，没有碰 git，没有向任何会话投递消息。

**没做 / 无法核实**：宿主 `claude -p --resume` 对**已停止**（非运行中）会话的语义——这是本计划唯一
可能改变结论的未知项（见任务 T6）；`permissionMode` 是否已在此版本进入 `sessions/*.json`；
生产零输出故障的根因（见 §1.3，只报观测，不报结论）。

---

## 一、先纠正三个前提（我实测到的与简报不一致之处）

简报里的三个说法方向都对，但**具体落点错了**。如果不纠正，派出去的五个 Agent 会去打三个假目标。

### 1.1 最大的盲区不是「静默停机 30%」，是「错误停机 33%」——而且它已经实现，只是没接线

简报说：「静默停机是最大单一类别（约 30%），完全不在监控范围内」。
红队复核的实际分布（n=179，`2026-11-02-redteam-deterministic.md` §6）：

| 类别 | 占比 | 现状 |
|---|---|---|
| 纯结构可判（错误停机 33.0% + 结构化提问 0.6% + 坏工具调用 1.1%） | **34.6%** | `stop-signals.mjs` 实现了，**无人调用** |
| 确定性文本（交还词组 22.3% + 问句收尾 + 等外部事件 + 自述将继续） | 32.4% | `classify-stop.mjs` 部分实现 |
| 可命令核对（断言 vs 证据） | 14.0% | `verify-claims.mjs` 实现了，**无人调用** |
| 非问题项（占位/客套/权限/≤24 字） | 14.5% | 未剔除 |
| 真需要语义 | **4.5%** | — |

**「静默停机」不是 30% 的一个类别，它是 32.4% 那一堆的容器名。** 而其中真正「说完就走、
不带任何信号」的那部分，恰恰是 `2026-11-01-ground-truth-first.md` 证明过的：
**87.5% 的停止，AI 根本没在问任何东西，只是说完了。** 对它们告警，就是 `hb_gap` 的复刻。

我核对了代码，两条硬事实：

```
$ grep -c "error" scripts/classify-stop.mjs
0
```
—— 在线停止分类器**完全看不见 API 错误停机**。它没有 `error` 字段的任何判据。

```
$ grep -rn "from './stop-signals" scripts/*.mjs
scripts/stop-signals.test.mjs:16      ← 只有它自己的测试
$ grep -rn "verify-claims" scripts/*.mjs
（无生产引用）
```
—— `ERROR_STOP`（33%，最大单块）与 `verify-claims`（14%）**两个已实现的确定性判据，
一个都没有接进守护进程**。它们目前是分析脚本，不是产品。

而 `scan-sessions.mjs` 的 `judgeState()` 也不看 `error` 字段（我逐行读过：

宿主 failed/blocked/waiting → 休眠 → 关系推断，**没有 error 分支**）。

**所以真实盲区是**：一个会话因为 401 鉴权失败或 524 网关超时而停下，
`jobs/state.json` 不写（它不是后台作业）、`sessions/*.json` 的 status 回到 idle、
`judgeState` 判它 `EXPLORING` 或 `dormant`。**它永远不会通知。**
红队实测这类有 59 个（33.0%），其中 23 个是 401/403 鉴权失败。

这比「静默停机」更值钱，因为它是**结构性事实**（`error` 字段原文可读、两次运行 0 差异），
不需要任何语义判断，也没有误报风险偏好问题。

### 1.2 「接 AI 语义兜底」是在解决 4.5% 的长尾，且要付 58 秒和一次外部依赖

`claude -p` 58 秒、`claude mcp serve` 32 秒都是实测可用，这点没问题。
但红队 §7 的结论很硬：**剩下那 4.5% 不是「同一类问题的更多样本」，是一堆互不相同的长尾
（操作说明、复盘陈述、文档片段），长尾不适合模型，适合「报出来给人看」。**

把模型放在判据链上，还会遇到验收标准的硬门：
`2026-11-02-autorelay-acceptance.md` **V7** 明确禁止「自动发送的触发来自推断」。
模型判断属于推断的最坏形态——它不可复算。

**模型可以放的位置只有一个**（红队也同意这一条）：把「该不该打断人」从二分类升级成
「值得看一眼 / 值得打断 / 不用管」——**那是产品决策，不是判据**，而且当前 153 条样本
撑不起任何评估。所以：语义兜底排在最后，且只用于**生成草稿的一句话**，不用于决定是否通知。

### 1.3 生产实例可能已经在静默空转 8 天（现场发现，简报里没有）

这是本轮最重要的发现，直接改写优先级。取证方法：只读文件元数据与字节内容，不写任何东西。

```
最后一次真实写入      watch.log / state.json / observations.jsonl / runner.log
                      全部止于 2026-11-01 03:23:13（本地时间）
现在                  2026-11-09 05:18（本地时间）           → 约 8.1 天零输出

watch.log 大小         41,857 字节，末尾 76 字节全为 NUL
state.json             3,406 字节，**非零字节数 = 0**（整个文件是 0x00）
Overwatch.witness.json   189 字节，**非零字节数 = 0**
state.json.corrupt-*   不存在（说明 loadState 的 JSON.parse 失败分支近期没跑过）

守护进程               PID <pid-A> `node scripts\watch.mjs`，启动于 2026-11-09 03:13:01
owner.json             mtime 每 ~15 秒推进一次（间隔 20s / 35s / 40s 三次采样均观察到）
```

两件事同时为真，且互相矛盾：

1. `claimOwnership()` 是 `runTick()` 里的**第一条语句**（`watch.mjs:1760`），
   它每轮都重写 `owner.json` —— 所以**tick 确实在跑**。
2. 同一次 tick 里必然执行的 `createLogger().info()`、`saveState()`、`createObservationLog()`
   **没有留下任何字节变化**。而 `saveState` 若执行，`state.json` 会被整个替换（不可能还是 NUL）。

**我不给结论，只给三个候选解释和一条判别性测试**（写进任务 T2 的验收里）：

| 解释 | 判别方法 | 若是，含义 |
|---|---|---|
| A. 进程卡在某层轮询里，`runTick` 未推进到 `saveState` | 看进程是否仍在吃 CPU、是否有子进程 | 一个 tick 挂 8 天，是设计缺陷（无超时） |
| B. 文件系统侧把三个文件零填充（断电/休眠/还原点），进程本身正常但 `appendFileSync` 落在别处 | 比对 `OVERWATCH_STATE_DIR`、检查是否有第二份 state 目录 | 数据完整性事故，不是代码 bug |
| C. 进程 stdout 与文件句柄在会话断连时失效，`createLogger` 的 catch 把错误吞成 mirror | 在临时目录里用 `--once` 复现，再切到真实目录 | 日志层 try/catch 吞错，符合 DF-021 家族 |

**为什么这一条排第一**：本仓库的核心资产是「**看不见的东西不告警**」这条原则。
它有个必然推论：**一个看不见自己的守护进程，等于没有守护进程。**
现在生产实例连续 8 天对 30+ 会话零输出，而它的进程、归属文件、退出码全都是正常的。
这正是 DF-023 那一类事故（「看起来在工作、实际六小时没扫过东西」）的放大版。
在它修好之前，加任何新判据都是在给一个可能不转的发动机装新仪表。

---

## 二、优先级判定

### 2.1 候选项与排序

排序规则写在前头，避免事后调整：
**先保证「已交付的能力真的在跑」（P0）→ 再把已实现的判据接上线（P1）→ 再补用户能直接感知的那一段（P2）
→ 最后才加新能力（P3/P4）**。理由：仓库已经有过三次「先造指标再验证」的失败，
和一次「脚本存在但没人调用」的失败（`oversight-probe` 从不被派发）。**接线比造新东西的边际收益高一个数量级。**

| # | 候选项 | 用户可感知价值 | 成本 | 风险 | 依赖 | 建议顺序 |
|---|---|---|---|---|---|---|
| **P0** | **守护进程自证存活 + 状态损坏自愈** | 高（只在故障时可见，但那是唯一重要的时刻：从「沉默」变成「它告诉我它没在跑」） | 低（半天级，纯本地逻辑 + 单测） | 低。唯一风险是把「卡住」误报成「死了」，所以判据必须是**文件增长**而不是内存时间戳 | 无 | **1（先做，且限时）** |
| **P1** | **把 `ERROR_STOP` 接进候选生成**（33%，最大确定性块） | 高（23/59 是 401/403，会立刻在真实语料上命中） | 中（改 `judgeState` + `watch` 候选源 + 测试；判据与负向样本都现成） | 中。真风险是**把「错误已恢复的会话」也报出来**（后续成功调用覆盖）——`stop-signals` 已处理「终态」但需复核 | 无（可与 P0 并行） | **2** |
| **P2** | **「停下来之后做什么」：bundle + 证据 + 草稿**（continuation-engine ①②④⑥，不做⑤判定与⑧投递） | 高（每一次使用都可见：一条可粘贴的草稿 + 一张证据表） | 中高（新脚本 ~800 行 + TUI 接入；但 §1.5 的扫描策略已被实测定死，不需要再设计） | 中。风险是**草稿写成「重来」**（F-5）与**证据失效路径 44%**（F-3），两者都有既定处置 | P1（共用停止点与错误判据） | **3** |
| **P3** | **AI 语义兜底（`claude -p` / `mcp serve`）** | 低（覆盖 4.5% 长尾；用户大概率分不出「它多判对了哪一条」） | 中（58s 延迟；破坏零依赖承诺；需凭据与计费） | 高。V7 否决项直接命中「推断驱动触发」；且不可复算、不可回归 | P1+P2（必须先证明确定性层已榨干 95.5%） | **5（有条件才做）** |
| **P4** | **继续攻写入通道（UIA / IPC / CDP / `--resume`）** | **接近零**（见 §2.3） | 高（UIA 已实测抢焦点、最小化静默失败；IPC 默认 `hold`；CDP 缺私钥） | 极高。V12 要求用户显式批准「以用户身份输入」；C1–C8 要求新 Accepted ADR + 回滚实测 | — | **不建议继续（仅保留 T6 一条低成本探索）** |
| **P5** | 语义/动量的更多判据（novelty 调参、STALLED 复活、心跳） | 零（`STALLED` 全语料 0.018%，末态 0 次；`hb_gap` 5 发 5 误） | 低 | 高（会重新引入误报） | — | **不做** |

### 2.2 为什么 P0 排在 P1 前面（而不是「用户价值最大的先做」）

如果只看用户价值，P1（错误停机）排第一：它覆盖 33%，且能立刻在真实语料上命中 59 条。
但有一个前置事实：**P1 的产出必须经过 P0 那条管道才能到达用户。**
管线现在连续 8 天零输出、`state.json` 全 NUL 而无人知晓。
在 P0 完成之前做 P1，等于**无法验证 P1 是否真的生效**——那会让「接线成功」变成一个
和「守护进程活着」同样无法证伪的声明。

所以 P0 的正确形态是**限时诊断 + 最小加固**，不是重写：
半天之内若不能定位根因，就先落「文件增长探针 + 心跳自检」这道保险，把不确定留给下一篇。

### 2.3 哪些看起来重要，实际是伪需求（明确砍掉）

| 伪需求 | 为什么是伪的 | 依据 |
|---|---|---|
| **桌面 GUI** | 用户自己已否掉（「桌面版必须在前台，还要抢鼠标」）。且 TUI 已有列表/详情/草稿三视图 | 用户原话 |
| **继续攻 UIA 写入** | 实测三项硬缺陷：抢焦点打断输入、最小化静默失败、`SetValue` 异步导致读回误判。且验收标准 V12 把「在界面上代用户输入」单列为**只能用户批准**的红线 | CHANGELOG 现场事故两条；`autorelay-acceptance` §3 V12 |
| **跨会话 IPC 投递** | 默认 `crossSessionInbound: hold`，且**权限类对等检查的输入在 `sessions/*.json` 里不存在**，发送方无法从外部判定能否送达。改全局设置会让所有会话重启，且 §3 的权限类限制仍在 | `2026-11-01-relay-delivery-probe.md` §2–§3 |
| **`policy.jsonc` 的 `auto` 分级** | 设计文档 §6 自己已经把它推翻了（`auto` 一栏应当移除）。现在只剩 `confirm` / `never`，而 `confirm` 的语义就是「用户按一次」——它和 TUI 的 `c` 复制草稿**是同一件事的两种 UI**，没有新增能力 | `frontend-and-shape.md` §6 |
| **本地小模型** | 本机没有（ollama/llama-server/lmstudio 全无，11434/1234/5000/8000 全关）。为覆盖 4.5% 长尾装一个模型，成本远大于收益 | `redteam-deterministic.md` §7 |
| **在线停止分类器调优** | **结构性失败**：分类器需要「下一句」才能判断这次停止是问句还是结束，而在线时下一句还没发生。实测在线路径 95.4% 判 `UNCLASSIFIABLE` | README「已知局限」表；`2026-10-31-online-classification.md` |
| **novelty / 心跳 / STALLED 的任何再调参** | 三次失败同一病因：先造指标再验证。`STALLED` 全语料 56,809 个滑窗命中 10 次（0.018%），末态 0 次；`hb_gap` 5 条通知 5 条误报 | `state-model.md` §2.0.1–2.0.2 |
| **把「四态」当状态机驱动重跑** | 四态在真实数据里极不均衡（129 会话末态：EXPLORING 122）。`CLAUDE.md` 已写死：只有宿主上报的 FAILED/BLOCKED 是判据 | README「关于四态」 |

### 2.4 整个自动接力方向该不该放弃？——**分两半回答，不给整句**

数据支持一个明确的分割，我不回避：

**该放弃的一半：「自动把消息发进用户眼前那个会话」。** 三条独立理由：

1. **技术**：默认配置下送不到（`hold` + 权限类对等不可外部判定）。这是 `REFUTED` 档，
   有 T2/T3 证据，不是「还没试」。
2. **合规**：即便绕过，`autorelay-acceptance` §6.3 的 C1–C8 要求新 Accepted ADR、回滚实测、
   以及**用户本人批准**；走 UIA 还要额外 V12。这不是「评审太严」，是**这条路的授权成本
   高于它的收益**（见第 3 点）。
3. **差分价值**：自动发送相对「生成草稿 + 用户按一次 `c` 复制粘贴」节省的是**一次按键**。
   实测漏发率上限被定在 ≤50% 且要求如实展示（§4.4），而误发上限被写死为 **0**（§4.3）。
   一个「省一次按键、但必须做到 0 误发」的功能，投入产出比是全表最差的。
   一旦误发一条，用户会关掉整个自动模式——代价是断崖式的。

**不该放弃的一半：用户原话里的前两段。** 把它拆开看，用户要的三件事里，
前两件都可做且廉价：

| 用户要的 | 可做性 | 依据 |
|---|---|---|
| 读到对话具体内容 | **可做**，且廉价（有效上下文 p50 ≈ 315 token） | `continuation-engine.md` §1.1 |
| 去读真实文件判断达没达到 | **半可做**：能判「有没有证据」，不能判「对不对」 | 同上 §3；`2026-11-03-verify-claims.md` |
| 直接让对话中的 AI 继续运行 | **只能到「草稿 + 一次复制」** | ADR-0001 / ADR-0002 §4 |

**所以结论不是「放弃」，是「把第三条的验收口径从『已继续』改成『已交付一份可粘贴的继续指令 + 依据』」。**
这个口径可判定、可验收、不违反任何否决项，而且它占用户价值的大头。

**唯一还值得花 1 小时试的**：`claude -p --resume <id>` 对**已停止**会话的语义（不是运行中）。
`--help` 原文是「or starts a copy and **says so when the session is already running**」——
反过来说，**会话没在跑时可能真的续在原 ID 上**。这条路不碰用户窗口、不抢焦点，
且它的产物可以 T3 验证（transcript 是否新增记录）。但它是**写操作**（会改 transcript），
超出用户当前授权，所以只能做成一次性、可丢弃会话上的探索，且必须先取得用户同意。
见任务 T6。

---

## 三、任务拆解

编号约定：`T1`–`T7`。**T1 必须先于 T2/T3 完成**（其余可并行）。
每个任务的验收标准都是**可机械检验**的，不写「质量要好」。

---

### T1 生产实例零输出诊断（含心跳自检的最小加固）

```
任务名：诊断「守护进程活着但 8 天零输出」，并落一道文件增长探针
产出形态：hybrid（诊断报告 artifact + 最小加固代码）
角色：执行（需要 Bash 做复现，需要 Write 改代码与测试）
输入：
  - scripts/watch.mjs（runTick / startWatch / createLogger / loadState / saveState / claimOwnership）
  - scripts/watch.test.mjs（现有 128 条，必须全绿）
  - 现场证据（由主线程提供，只读）：%LOCALAPPDATA%\Overwatch\{watch.log,state.json,observations.jsonl,runner.log,owner.json}
    + %LOCALAPPDATA%\Overwatch.witness.json
必须回答的问题（逐条）：
  1. 为什么 owner.json 每 15 秒被重写，而同一 tick 内必然执行的 log.info / saveState 没有字节变化？
     逐行给出 runTick 的执行路径，指出在哪一句之后不可能再往下走。
  2. state.json（3406 B）与 witness（189 B）全为 0x00。这是「文件被零填充」还是「进程写入了空内容」？
     用 `fs.statSync` 的 size + 内容字节比 + mtime 交叉判断，给出判别过程。
  3. loadState 在 JSON.parse 失败时会 rename 成 `.corrupt-<ts>`。现在**没有** .corrupt 文件。
     这能否反证「loadState 近期从未执行过」？若能，结论是什么？
  4. createLogger 的 `catch` 分支只把错误 mirror 到 stdout、不落盘（watch.mjs:303-309）。
     在 stdout 是已断开的管道时会发生什么？这是否构成「日志层吞错」？
  5. 复现：在临时目录（OVERWATCH_STATE_DIR 指向 tmp）跑 `--once`，然后手工把 state.json 写成全 NUL，
     再跑一次，观察行为是否符合预期。给出两次的原始输出。
产出物路径：
  - docs/research/2026-11-04-watcher-silent-stall.md（诊断报告，含复算命令）
  - 最小加固：scripts/watch.mjs 内新增「上次保存时刻 + 本进程启动时刻 + 日志文件 size」
    三元组心跳，写进 state.json 与日志；连续 N 轮 size 无增长 → 发一条高优先级通知（复用现有 notifier）
  - scripts/watch.test.mjs 新增负向测试
验收标准：
  AC1 报告里每个结论都带 file:line 或原始命令输出（不可复算的结论按 T0 处理）
  AC2 复现步骤可被第三方在临时目录执行一次得到同形态输出
  AC3 把 state.json 写成全 NUL 后，守护进程**必须**发出「状态损坏」通知且不静默继续
  AC4 新增负向测试：把心跳判据删掉，测试必须变红（贴出红的那一次输出）
  AC5 `node --test scripts/*.test.mjs` 全绿；`node scripts/check-structure.mjs` exit 0
  AC6 **不允许**修改任何验收标准；若发现 P0 判据本身不可判定，写进「未覆盖项」
依赖：无
预算估计：token 15%，60–90 分钟
```

---

### T2 把 ERROR_STOP 接进候选生成（33% 最大确定性块）

```
任务名：让「API 错误停机」进入通知链路，且只报终态
产出形态：artifact
角色：执行
输入：
  - scripts/stop-signals.mjs（errorOf / hasRecentError / classifySession）
  - scripts/scan-sessions.mjs（judgeState / readLiveSessions）
  - scripts/watch.mjs（NOTIFY_STATES / HOST_FACT_STATES / candidatesFromScan / dispatchCandidates）
  - docs/research/2026-11-02-redteam-deterministic.md §6、§8.2
  - docs/spec/2026-11-02-autorelay-acceptance.md §3（V7）、§4.6（反例 1 与 8）
必须回答的问题（逐条）：
  1. 错误停机应该成为**第五个 NOTIFY_STATE**，还是走 `stop-signals` 生成候选后复用现有派发链？
     给出选择依据，并指出另一条路的代价。注意 `HOST_FACT_STATES` 的判定问句是
     「这个结论是谁下的？」——错误停机是**宿主写在记录上的 `error` 字段**，还是我们的推断？
  2. 「终态」如何判定？`stop-signals` 的 `classifySession` 用尾部 20 条记录找 error；
     若错误之后会话又成功继续了，必须不报。给出判据（时序 + 后续成功调用）与反例。
  3. 23 个 401/403 鉴权失败与 5xx/超时是否应该分成两类文案？
     抓 `needs` / `error` 原文，给出两类在真实语料里的可复现样例。
  4. 误报上限是 0。这条新判据的假阳性来源有哪些？逐条列出并给出消解办法。
  5. 现有 `NOTIFY_KINDS` 与 `UNCLASSIFIABLE_MIN_IDLE_SEC` 的门要不要作用在它身上？
     依据是什么（它是不是「这次停止是问句还是结束」的猜测）？
产出物路径：
  - scripts/scan-sessions.mjs 或 watch.mjs 的改动 + 新增判据模块（如 scripts/error-stop.mjs）+ 单测
  - docs/research/2026-11-04-error-stop-wiring.md（含全语料命中数、样本 10 条原文、假阳性分析）
验收标准：
  AC1 全语料跑一遍，报出：命中会话数、按错误类型分布、其中「后续已恢复」被正确排除的条数
  AC2 至少 10 条命中样例附 `error` 字段原文与出现位置（file:line 或记录索引）
  AC3 负向测试：构造「error 后紧跟成功调用」的记录，判据必须**不**通知；删掉该判据测试变红
  AC4 不引入任何推断型判据（novelty / 心跳间隔 / 「停了很久」）——逐条自查并在报告里声明
  AC5 `node --test scripts/*.test.mjs` 全绿；`check-structure.mjs` exit 0
依赖：T1（否则无法验证通知真的到达）
预算估计：token 15%，90–120 分钟
```

---

### T3 交接包：context-bundle + 证据表（不做判定、不做投递）

```
任务名：产出「用户能一眼看懂它凭什么说完成」的 bundle 与证据
产出形态：artifact
角色：执行
输入：
  - docs/design/continuation-engine.md §1.4（字段）、§1.5（扫描策略）、§3.2（E1–E5）、§3.3（只读动作）
  - docs/research/2026-11-03-verify-claims.md（四档 + 两个已修 bug 的形态）
  - scripts/verify-claims.mjs（复用 detectClaims / findEvidence / classifyEvidence / readBack）
  - scripts/scan-sessions.mjs 的 parseJsonl（注意：它是读尾部的，见 continuation-engine §1.5 的落地要求）
  - docs/spec/evidence-discipline.md §1（四件套）、§4（覆盖声明）
必须回答的问题（逐条）：
  1. 「有效上下文 p50 ≈ 315 token」能否复现？抽样 20 个会话给出实测分布。
     若复现不出来，改正这个数字并说明原因（这是本仓库的硬纪律）。
  2. 全量线性扫 110MB 的 7.6 秒是怎么测的？给出可复跑脚本与本次实测值。
     若本机已无 110MB 会话，如实说明并给替代样本。
  3. `thinking` 块必须在**脚本层物理剥离**（F-7）。给出剥离发生在哪一行，以及一条负向测试。
  4. 44% 的历史路径已失效。这些必须落 `UNVERIFIABLE(dangling_path)` 而不是 `UNMET`。
     给出计数与三条样例。
  5. `continued-in`（会话分叉）如何处理？给出 9 个样本的现状复查数（§F-4 说 9 个，4 个目标文件存在）。
  6. bundle 的失效条件是什么（scannedBytes + mtime）？给出缓存命中与失效各一次的实测。
产出物路径：
  - scripts/judge-context.mjs（新脚本，零依赖，纯函数 + CLI）
  - scripts/judge-context.test.mjs
  - docs/research/2026-11-04-context-bundle.md（实测报告）
验收标准：
  AC1 bundle 符合 continuation-engine §1.4 的 schema，字段名逐字一致
  AC2 `intent.verbatim` 与 `corrections[].verbatim` 是原文，测试断言「不得摘要」（比对原始字节）
  AC3 同一会话跑两次，bundle 字节相同（幂等）；mtime 变化后缓存失效
  AC4 报告含覆盖声明：读了哪些会话、没读什么、哪些无法核实
  AC5 单会话 p50 < 1 秒；给出 10 个会话的耗时表
  AC6 零依赖（不新增 import 外部包）；`node --test` 全绿；`check-structure.mjs` exit 0
依赖：T2（共用停止点与错误判据，避免两套 stopPoint 定义）
预算估计：token 25%，3–4 小时
```

---

### T4 攻击本计划（反方声音，强制不可合并）

```
任务名：找出本规划书的漏洞、过度设计与被忽略的可能性
产出形态：artifact（批评报告，不改任何文件）
角色：红队（tools 无 Edit；可以 Write 报告）
输入：
  - 本文件 docs/design/2026-11-04-next-phase-plan.md（**只此一份**）
  - README.md 的「能力边界」与「已知局限」
  - docs/spec/2026-11-02-autorelay-acceptance.md（12 条否决项，用来判我的计划是否违规）
  **不得读**：任何执行 Agent 的自评、T1–T3 的中间产出（防锚定）
必须回答的问题（逐条）：
  1. §1.1 说「错误停机 33% 才是最大盲区」。这个判断建立在 redteam 的 n=179 上，
     而 verify-claims 的 n=228 全量也只找到 25 个含断言会话、1 个 NO_EVIDENCE。
     **两个分母不同，我是否在用大比例包装小绝对数？** 给出你认为正确的分母与绝对数。
  2. §2.4 我判定「自动发送的差分价值只是一次按键」。这个判断忽略了什么？
     请具体地说出至少两种我没想到的场景（例如：人不在电脑前、批量 10 个会话、夜间）。
  3. 我把「AI 语义兜底」排到最后。若 4.5% 里恰好包含**最贵的错误**（例如「AI 说完成了但其实没有」），
     排序是否应当反转？给出判断依据，不要只给立场。
  4. §2.3 的伪需求清单里，有没有哪一条其实被我误杀了？
     特别检查：`policy.jsonc` 的 `confirm` 与 TUI 的「按 c 复制」是否真的等价。
  5. 我的 P0/P1 顺序假设「P1 的价值必须经过 P0 才能到达用户」。
     若 P0 的根因是环境事故（文件被零填充）而非代码 bug，这个假设是否还成立？
  6. 本计划有没有**过度设计**？逐任务指出可以砍掉的部分（例如 T3 的哪些字段其实没人会用）。
  7. 有没有一条我完全没想到的路线？至少给一条，并说明它为什么不违反 V1–V12。
产出物路径：
  docs/research/2026-11-04-plan-redteam.md
验收标准：
  AC1 每条批评必须指向本文件的具体小节号，不写泛泛而谈的「风险较大」
  AC2 至少 3 条批评要给出**可执行的替代方案**，而不是只否定
  AC3 必须有一条是「本计划漏掉的整条路线」，且附它不违反哪几条否决项
  AC4 必须自评：这份批评里哪一条最可能是错的，为什么
  AC5 不得修改本规划书；发现的问题写在报告里
依赖：无（与 T1/T2/T3 并行，且**必须在 T5 汇总前完成**）
预算估计：token 15%，60 分钟
```

---

### T5 验收：对照 12 条否决项与前序标准判定

```
任务名：判定 T1–T3 的产出是否可交付（一票否决）
产出形态：artifact
角色：验收（tools 无 Edit）
输入：
  - docs/spec/2026-11-02-autorelay-acceptance.md（**唯一判定依据**，逐条）
  - T1/T2/T3 的交付物与原始输出（不给它们的自我评价段落）
  - docs/spec/evidence-discipline.md §8
必须回答的问题（逐条）：
  1. 逐条核 V1–V12：本阶段产出是否触发了任一条？给出每条的一行结论与证据。
  2. T1–T3 声称的每个比率，是否满足 n ≥ 3/(1−声称值)？不满足的，指出该句必须改成「n 次中 m 次」。
  3. 每个 AC 的实际达成情况：达成 / 未达成 / 不可判定。不可判定的写进「未覆盖项」并说明原因。
  4. 有没有把「脚本存在」当成「已生效」？逐个检查是否真的被生产路径调用
     （`grep -rn` 生产引用，不是看测试）。
  5. 有没有把「投递成功 / 扫描完成」表述成「问题已解决」（V8）？
产出物路径：
  docs/research/2026-11-04-acceptance-verdict.md
验收标准：
  AC1 每条判定都指向本文件或规格的具体条目，且附原始输出路径
  AC2 引用了原始输出但文件不存在的，该条按 T0 处理并降级
  AC3 给出明确结论：PASS / FAIL / 部分通过（逐 AC），不得只写「基本可用」
  AC4 不得修改被验收的文件（工具限制，不是 prompt 约束）
依赖：T1、T2、T3（串行，最后跑）
预算估计：token 15%，45–60 分钟
```

---

### T6 唯一还可能改变结论的探索：`--resume` 对已停止会话

```
任务名：验证 claude -p --resume 对「已停止（非运行中）」会话的语义
产出形态：exploration（**不产出任何生产代码**）
角色：检索/探针
输入：
  - docs/adr/0001-config-only.md §代价·3（含 2026-10-30 修正）
  - docs/research/2026-10-30-hosted-automation.md
  - docs/spec/2026-11-02-autorelay-acceptance.md §2 R2、§3 V2/V12
  - `claude --help` 中 `--resume` / `--bg` / `--fork-session` 的原文
必须回答的问题（逐条）：
  1. 对一个**已停止**（不是 running）的会话执行 `claude -p --resume <id> "..."`，
     transcript 是否**在原 sessionId 文件上**新增记录（T3 判据：目标自己写下的记录）？
  2. 若产生副本（新 sessionId），`--help` 的「starts a copy and says so」是否真的会「says so」？
     原文是什么？
  3. 这个动作会不会向用户的窗口注入任何东西？（抢焦点 / 弹窗 / 改变用户可见状态）
  4. 它是否会在**用户不知情时消耗 token**？给出一次典型调用的 tokens 数（jobs/state.json 有真实字段）
  5. 它是否触发 V2（需要用户交互）与 V12（以用户身份发言）？逐条论证。
  6. 这算「写文件」吗？用户当前授权是「只读命令 + 测试」——把结论写清楚，不要替用户作决定。
硬性前置：**只能在一个专门为本次实验新建的一次性会话上做**（用临时 cwd），
不得对任何用户真实会话执行 --resume。执行前须在报告里写明「本次用了哪个一次性 sessionId」。
产出物路径：
  docs/research/2026-11-04-resume-stopped-session.md
验收标准：
  AC1 结论必须落在 T0–T4 的证据分级上，单次成功 = UNPROVEN（X2）
  AC2 必须报告失败路径的形态（X3），只报成功路径最高 UNPROVEN
  AC3 必须回答「这是否构成对运行中会话的注入」——注意区分「已停止」与「运行中」
  AC4 若结论是 REFUTED，不得只靠 T1（--help 文本），必须有 T2/T3
  AC5 不得修改任何生产代码；不得对用户真实会话执行 --resume
依赖：无（可立即并行，但**结论只影响 P4 的去留，不阻塞 T1–T3**）
预算估计：token 10%，45 分钟
```

---

### T7（可选，仅在 T2 交付后启动）接线 `verify-claims` 到 TUI 详情页

```
任务名：TUI 详情页显示「这条完成声明有没有证据」
产出形态：artifact
角色：执行
输入：scripts/oversight-tui.mjs（detail 视图）、scripts/verify-claims.mjs、T3 的 bundle 产出
必须回答的问题：
  1. 2.9–5.6 秒的全量耗时，放到 TUI 按键路径上是否可接受？给出按需单会话的实测耗时。
  2. 结论与依据必须同屏、依据不可折叠（continuation-engine §10）。给出布局与被截断时的声明方式。
  3. `UNKNOWN` 与 `NO_EVIDENCE` 的文案必须不同——前者是「没读到」，后者是「读完了也没有」。
产出物路径：scripts/oversight-tui.mjs + 测试 + docs/research/2026-11-04-tui-evidence.md
验收标准：
  AC1 单会话详情渲染 < 500ms（按需扫描，不全量）
  AC2 四档 + UNKNOWN 各有独立文案，测试断言五个字符串互不相同
  AC3 非 TTY 降级后仍显示证据表
  AC4 `node --test` 全绿；`check-structure.mjs` exit 0
依赖：T3（需要 bundle 与证据结构）
预算估计：token 10%，60–90 分钟
```

---

### 3.1 依赖图与并行度

```
        ┌───────────────┐
        │ T1 自证/自愈   │  ← 先做，半天限时
        └───────┬───────┘
                │（否则无法验证通知真的到达）
        ┌───────▼───────┐        ┌──────────────┐
        │ T2 ERROR_STOP  │───────▶│ T3 bundle     │───▶ T7（可选）
        └───────┬───────┘        └──────┬───────┘
                │                       │
                └──────────┬────────────┘
                           ▼
                    ┌────────────┐
                    │ T5 验收     │  ← 串行，必须最后
                    └────────────┘

  T4 红队（并行，必须在 T5 前完成）      T6 探索（并行，不阻塞任何人）
```

**必须串行**：`T1 → T2 → T3 → T5`（T5 必须最后）。
**可立即并行**：`T4`、`T6`；T2 可与 T1 的**诊断阶段**并行启动（代码改动等 T1 的结论），
但 T2 的**验收**依赖 T1 的管道可信。

---

## 四、建议并行派发的 5 个 Agent（可直接使用的 prompt 骨架）

**为什么是这五个**：T1（管道可信）+ T2（最大确定性块）+ T3（用户能感知的那一段）
是三条独立工作线，互不读对方产出；T4（攻击计划本身）必须现在做，因为它可能推翻排序；
T6（唯一可能改变结论的事实缺口）成本最低、并行无损。
**T5 不在这批**：它是验收，必须等 T1–T3 交卷。

公共段（五个 prompt 都要带，照 `docs/spec/dispatch-contract.md` §2 的四样东西）：

```
【项目】Overwatch（仓库根目录）—— 跨会话 AI 任务监控，纯 Claude Code 配置库，零依赖 Node 脚本。
【硬约束】主线程只做拆解/派发/汇总；你的产出必须能机械检验；不得事后新增验收标准。
【纪律】
 - 每个结论必须给 file:line 或原始命令输出。给不出出处的结论按 T0 处理，等于没说。
 - 「修好了」必须附负向证据：把 bug 放回去，测试/硬门要变红，贴出红的那次输出。
 - 不得修改任何验收标准。发现标准不可判定，写进「未覆盖项」并说明原因。
 - 不得碰 git（不 add / commit / push）。不得修改 tasks/runs/ 以外之外的本机配置。
 - 中文写作。最终返回结构化三元组：交付物路径 / 逐条 AC 达成情况 / 未覆盖项。
【产出形态与预算】见下。
```

### Agent 1（T1）

```
你是 Overwatch 的执行 Agent。任务：诊断守护进程「活着但 8 天零输出」，并落一道文件增长探针。
产出形态：hybrid（诊断报告 + 最小加固代码）。预算 token 15%、90 分钟。

【现场证据，只读，不要修改它们】
%LOCALAPPDATA%\Overwatch\ 下：watch.log 41857 B（末尾 76 B 全 NUL）、state.json 3406 B（非零字节 0）、
observations.jsonl 2264 B、runner.log 39724 B、owner.json（mtime 每 ~15s 推进）；
兄弟文件 %LOCALAPPDATA%\Overwatch.witness.json 189 B（非零字节 0）。
四个业务文件全部止于 2026-11-01 03:23:13；现在 2026-11-09 05:18。
PID <pid-A> = node scripts\watch.mjs，启动于 2026-11-09 03:13:01。

【必读】scripts/watch.mjs 的 runTick(L1740-2005) / startWatch(L2013-2046) /
createLogger(L266-319) / loadState(L336-377) / saveState(L406-434) / claimOwnership(L210-229) /
checkStateIntegrity + witness(L126-184)；scripts/watch.test.mjs（现有 128 条必须保持全绿）。

【必须回答，逐条编号作答】
1. owner.json 每 15 秒重写，而同一 tick 内必然执行的 log.info/saveState 零字节变化。逐行给出执行路径，
   指出不可能通过的那一句。
2. state.json 与 witness 全 0x00：是「文件被零填充」还是「写入了空内容」？给判别过程。
3. 没有 state.json.corrupt-* 文件，能否反证 loadState 近期从未执行？若能，结论是什么？
4. createLogger 的 catch 只 mirror 到 stdout 不落盘（L303-309）。stdout 是已断管道时会怎样？
   这算不算「日志层吞错」？
5. 在临时目录（OVERWATCH_STATE_DIR=tmp）复现：跑 --once → 手工把 state.json 写成全 NUL → 再跑。
   给出两次原始输出。

【交付】
 - docs/research/2026-11-04-watcher-silent-stall.md（含复算命令）
 - scripts/watch.mjs 新增心跳三元组（上次保存时刻 / 本进程启动时刻 / 日志 size）；
   连续 N 轮 size 无增长 → 发高优先级通知（复用现有 notifier，走 canNotify 限额）
 - scripts/watch.test.mjs 新增负向测试

【AC，逐条自检并在返回里报】
AC1 每个结论带 file:line 或原始命令输出
AC2 复现步骤第三方跑一次得到同形态输出
AC3 state.json 写成全 NUL 后守护进程必须发「状态损坏」通知，不静默继续
AC4 删掉心跳判据 → 新测试必须变红（贴红的那次输出）
AC5 node --test scripts/*.test.mjs 全绿；node scripts/check-structure.mjs exit 0

【禁止】修改验收标准；碰 git；改动任何 %LOCALAPPDATA%\Overwatch 下的现有文件（只读）；
假设根因而不做判别实验。
```

### Agent 2（T2）

```
你是 Overwatch 的执行 Agent。任务：让「API 错误停机」进入通知链路，且只报终态。
产出形态：artifact。预算 token 15%、120 分钟。依赖 T1 的结论（管道是否可信）。

【必读】scripts/stop-signals.mjs（errorOf / hasRecentError / classifySession / KINDS）、
scripts/scan-sessions.mjs 的 judgeState(L173-260) 与 readLiveSessions(L465-490)、
scripts/watch.mjs 的 NOTIFY_STATES(L103) / NOTIFY_KINDS(L973) / HOST_FACT_STATES(L1002) /
candidatesFromScan(L925) / dispatchCandidates(L1526-1690)、
docs/research/2026-11-02-redteam-deterministic.md §6 与 §8.2、
docs/spec/2026-11-02-autorelay-acceptance.md §3 V7 与 §4.6 反例 1/8。

【已核实的前提，不要重复调研】
- classify-stop.mjs 全文 0 次出现 "error"：在线分类器看不见错误停机。
- stop-signals.mjs 只被它自己的测试 import，没有任何生产引用。
- judgeState 没有 error 分支，所以 401/524 停下的会话会被判 EXPLORING / dormant，永不通知。
- 红队实测：错误停机 59/179 = 33.0%，其中 23 个是 401/403 鉴权失败。

【必须回答，逐条编号作答】
1. 走「第五个 NOTIFY_STATE」还是「stop-signals 生成候选后复用派发链」？给依据与另一条路的代价。
   注意 HOST_FACT_STATES 的准入问句是「这个结论是谁下的」——error 字段算宿主写的还是我们推的？
2. 「终态」判据：错误之后若会话又成功继续，必须不报。给出判据与反例。
3. 鉴权失败（401/403）与 5xx/超时是否分两类文案？给两类真实样例原文。
4. 误报上限是 0。列出该判据的全部假阳性来源，逐条给消解办法。
5. NOTIFY_KINDS 与 UNCLASSIFIABLE_MIN_IDLE_SEC 的门要不要作用在它身上？依据是什么。

【交付】改动（如 scripts/error-stop.mjs + scan-sessions/watch 接线）+ 单测 +
docs/research/2026-11-04-error-stop-wiring.md（全语料命中数 / 按类型分布 / 被正确排除的「已恢复」条数 /
≥10 条样例原文与位置 / 假阳性分析）

【AC】
AC1 全语料报出命中数、类型分布、已恢复排除数
AC2 ≥10 条样例附 error 原文与位置
AC3 负向测试：error 后紧跟成功调用必须不通知；删判据则测试变红
AC4 未引入任何推断型判据（novelty / 心跳 / 「停了很久」），逐条自查声明
AC5 全量测试全绿 + check-structure exit 0

【禁止】碰 git；修改验收标准；为了让数字好看而缩小分母（必须写清分母是什么）。
```

### Agent 3（T3）

```
你是 Overwatch 的执行 Agent。任务：产出 context-bundle 与证据表，让用户一眼看懂「它凭什么说完成」。
产出形态：artifact。预算 token 25%、4 小时。依赖 T2（共用停止点定义，不要自己再造一套）。

【必读】docs/design/continuation-engine.md（全篇，重点 §1.4 字段、§1.5 扫描策略、
§3.2 E1–E5、§3.3 只读动作与三条硬规则、§4.1 六要素、F-1..F-10）、
docs/research/2026-11-03-verify-claims.md（四档语义、两个已修 bug、精度 11/13）、
scripts/verify-claims.mjs（复用 detectClaims / findEvidence / classifyEvidence / readBack，
不要重写它们）、scripts/scan-sessions.mjs 的 parseJsonl。

【必须回答，逐条编号作答】
1. 「有效上下文 p50 ≈ 315 token」能否复现？抽 20 个会话给实测分布。复现不出来就改正数字并说明原因。
2. 全量线性扫 110MB = 7.6 秒的测法与本次实测值。本机已无该样本就如实说明并给替代。
3. thinking 块必须在脚本层物理剥离（F-7）。指出剥离在哪一行，并给负向测试。
4. 44% 历史路径失效 → 必须落 UNVERIFIABLE(dangling_path) 而不是 UNMET。给计数 + 3 条样例。
5. continued-in（会话分叉）怎么处理？复查 §F-4 的「9 个，4 个目标存在」今天是否还成立。
6. bundle 缓存失效条件（scannedBytes + mtime）？给命中与失效各一次实测。

【交付】scripts/judge-context.mjs + scripts/judge-context.test.mjs +
docs/research/2026-11-04-context-bundle.md

【AC】
AC1 schema 字段名与 §1.4 逐字一致
AC2 intent.verbatim 与 corrections[].verbatim 是原文（测试断言不得摘要，比对原始字节）
AC3 同一会话两次运行 bundle 字节相同；mtime 变化后缓存失效
AC4 报告含覆盖声明（读了哪些会话 / 没读什么 / 哪些无法核实）
AC5 单会话 p50 < 1 秒，给 10 个会话耗时表
AC6 零依赖；全量测试全绿；check-structure exit 0

【禁止】碰 git；代跑有副作用的命令（npm test / mvn 会写缓存，一律不跑）；
补全用户没说的验收标准；用四态的 state 字段驱动判断（§2.3）。
```

### Agent 4（T4）

```
你是 Overwatch 的红队 Agent。任务：攻击这份规划书，找出漏洞、过度设计、被忽略的可能性。
产出形态：artifact（批评报告）。预算 token 15%、60 分钟。

【只读这一份】docs/design/2026-11-04-next-phase-plan.md
【可参考】README.md 的「能力边界」「已知局限」；docs/spec/2026-11-02-autorelay-acceptance.md（12 条否决项）
【不得读】任何执行 Agent 的自我评价、T1–T3 的中间产出（会锚定）。

【必须回答，逐条编号作答】
1. §1.1 用 n=179 的 33% 说「错误停机是最大盲区」，但 verify-claims 全量 n=228 只有 25 个含断言会话、
   1 个 NO_EVIDENCE。我是不是在用大比例包装小绝对数？给出你认为正确的分母与绝对数。
2. §2.4 我判定「自动发送相对复制草稿只省一次按键」。这个判断忽略了什么？
   至少给两种我没想到的场景（人不在电脑前 / 批量 10 个会话 / 夜间 …）。
3. 我把语义兜底排最后。若 4.5% 里恰含最贵的错误（「说完成了其实没有」），排序该不该反转？给依据。
4. §2.3 伪需求清单里有没有误杀？特别核：policy.jsonc 的 confirm 与 TUI 按 c 复制是否真的等价。
5. 我的 P0→P1 顺序假设「P1 的价值必须经过 P0 才能到用户」。若 P0 根因是环境事故（文件被零填充）
   而非代码 bug，这个假设还成立吗？
6. 逐任务指出过度设计（可砍的部分），例如 T3 的哪些字段没人会用。
7. 至少给一条我完全没想到的路线，并说明它为什么不违反 V1–V12 的任意一条。

【交付】docs/research/2026-11-04-plan-redteam.md

【AC】
AC1 每条批评指向本文件具体小节号，不写「风险较大」这类空话
AC2 ≥3 条批评要给可执行替代方案，不只否定
AC3 必须有一条「整条被漏掉的路线」，附它未触发哪些否决项
AC4 自评：这份批评里哪一条最可能是错的，为什么
AC5 不修改规划书

【禁止】修改任何文件（除你的报告）；读其他 Agent 的产出。
```

### Agent 5（T6）

```
你是 Overwatch 的探针 Agent。任务：验证 claude -p --resume 对「已停止（非运行中）」会话的语义。
产出形态：exploration（不产出任何生产代码）。预算 token 10%、45 分钟。

【硬性前置，必须遵守】
- 只能在一个**专门为本次实验新建的一次性会话**上做（临时 cwd，如 %TEMP%\ow-resume-probe）。
- **绝不**对任何用户真实会话执行 --resume。
- 报告里必须写明本次用的一次性 sessionId。
- 先读 `claude --help` 里 --resume / --bg / --fork-session 的原文，逐字引用。

【必读】docs/adr/0001-config-only.md §代价·3（含 2026-10-30 修正）、
docs/research/2026-10-30-hosted-automation.md、docs/spec/2026-11-02-autorelay-acceptance.md §2 R2 与 §3 V2/V12。

【必须回答，逐条编号作答】
1. 对**已停止**会话执行 `claude -p --resume <id> "..."`，原 sessionId 的 transcript 是否新增记录？
   （T3 判据：目标自己写下的记录，不是「socket 写成功」或「退出码 0」）
2. 若产生副本（新 sessionId），--help 说的「starts a copy and says so」是否真的会 says so？原文是什么？
3. 会不会向用户窗口注入任何东西（抢焦点 / 弹窗 / 改变可见状态）？
4. 会不会在用户不知情时消耗 token？给一次典型调用的 tokens（jobs/*/state.json 有真实字段）。
5. 是否触发 V2（需要用户交互）与 V12（以用户身份发言）？逐条论证。
6. 这算「写文件」吗？用户当前授权是「只读命令 + 测试」。把结论写清，**不要替用户作决定**。

【交付】docs/research/2026-11-04-resume-stopped-session.md

【AC】
AC1 结论落在 T0–T4 上；单次成功 = UNPROVEN（X2）
AC2 必须报告失败路径形态（X3）；只报成功路径最高 UNPROVEN
AC3 明确区分「已停止」与「运行中」两种语义
AC4 若判 REFUTED，不得只靠 --help 文本，必须有 T2/T3
AC5 不修改任何生产代码；不对用户真实会话执行 --resume

【禁止】碰 git；对真实会话 --resume；把「没报错」当成送达证据。
```

---

## 五、反方声音（本规划的自我证伪位）

T4 是专门攻击本文件的任务。为了让它的攻击有靶子，我先自己写下**最可能被推翻的三处**：

1. **§1.1 的分母问题。** 我用 n=179 的「33% 错误停机」论证优先级，但那是「**已经停下来的**会话」
   里的比例。全量 228 个会话里含可核对断言的只有 25 个（11%），唯一一条 `NO_EVIDENCE` 只有 1 个。
   **绝对数很小。** 若「33%」在真实增量里对应的是每周 0–1 个事件，那 P1 的价值就被我高估了。
   T2 的 AC1 要求报绝对数，就是为了让这个错误可被发现。
2. **§2.4 的「只省一次按键」。** 它假设用户一直在电脑前。若用户的核心场景是「睡前挂 10 个会话、
   第二天早上看」，那「省一次按键」就变成「省 10 次上下文切换」，我的判断会整体反转。
   这个场景我没有数据。
3. **P0 的根因可能是环境事故。** 若 `state.json` 全 NUL 是一次断电/还原点造成的，
   而不是代码缺陷，那 P0 就降级成「一次性清理 + 一道廉价保险」，半天足够，不该占用第一优先级。
   T1 的判别实验就是为这个可能性准备的；**若判别结果为「环境事故」，P0 应立刻让位给 P1。**

---

## 六、交付前必须做的一件小事（我**没有**做，需要主线程补）

本文件落在 `docs/design/` 下，会触发两条仓库自己的硬门。按本任务「只新增这一个文档、不改现有文件」的
约束，我**没有**修改它们，但这意味着当前工作区跑 `check-structure.mjs` 会红：

| 硬门 | 位置 | 需要补的一行 |
|---|---|---|
| `checkDesignIndex` | `scripts/check-structure.mjs:795-812` | 在 `docs/design/README.md` 的逐份状态表里加一行：`2026-11-04-next-phase-plan.md` → `Proposed`，并写明「本文件是下一阶段规划，不描述已实现能力」 |
| `checkChangelog` | `scripts/check-structure.mjs:551-627` | 提交时在 `docs/CHANGELOG.md` 的 `[Unreleased]` 段记一条（含 commit hash） |

不加第一条，`node scripts/check-structure.mjs` 会明确报
「`2026-11-04-next-phase-plan.md` 没有被索引提到——新增设计文档必须登记状态」。
这是**规则的正常运作**，不是 bug。

---

## 七、一页纸总结（给主线程）

```
先修管道，再接判据，最后补用户能看见的那一段。写入通道放弃（只留 1 小时探索）。

P0  T1  守护进程自证存活 + 状态损坏自愈            半天    ┐
P1  T2  ERROR_STOP（33%，已实现未接线）接进通知链    2 小时  ├ 可并行推进
P2  T3  context-bundle + 证据表（用户直接可感）      4 小时  ┘
—   T4  红队攻击本计划                              1 小时   并行，必须在验收前完成
—   T6  --resume 已停止会话语义（唯一可能翻盘的事实）45 分钟  并行，不阻塞
—   T5  验收（对照 12 条否决项，一票否决）           1 小时   串行，最后
—   T7  TUI 显示证据（可选，T3 之后）

砍掉：桌面 GUI / UIA 写入 / IPC 投递 / policy auto 分级 / 本地小模型 /
      在线分类器调优 / novelty 与 STALLED 调参 / 四态当状态机用
```

**一句话**：用户的终极目标里，「让 AI 继续运行」这一条只能做到「一条可粘贴的草稿 + 一张证据表」，
这不是妥协，是宿主的硬约束（ADR-0001 已实测）。而这条**已经足够值钱**——
它把「30 个会话里谁卡住了、卡在哪、凭什么说它做完了」变成一张可操作的表。
剩下的自动发送，投入产出比是全表最差的一格。
