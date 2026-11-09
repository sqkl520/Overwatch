# 批判 C1：通知系统该推倒重做，不是修

> 产出形态：**exploration**（设计批判）。作者：批判 Agent C1。
> **未修改任何代码、未碰 git、未重启守护进程。**
> 所有证据来自三类来源，逐条标注：**(T1)** 读代码行；**(T2)** 对生产文件与真实语料的只读实测；
> **(T3)** 逻辑推演（标出推导链）。凡是我自己算的数字都给复现命令。

---

## 0. 结论先行

| 问题 | 判断 |
|---|---|
| **该修还是该重做** | **重做。** 只修 bug 的路径已被实测堵死：RT2 证明最小修复（提前派发 + 补指纹）会**同时**打开重复通知（从每天 0 次变成每次等待 2 条）和 `saveState` 每轮 >1 次（撞验收 V4）。这不是偏好问题。 |
| **哪些是根本性错误** | 一条：**把「会话处于什么状态」当作事件**。状态是每轮重算的谓词，事件是某个时刻发生的一次转变。用谓词值做去重身份，必然同时误合并（同一事实两个口径 → 两个键）和误分裂（键恒定 → 第二次真等待被静默）。两个方向都在生产里发生了。 |
| **该砍掉的设计** | ① 四态状态机（`EXPLORING/PRODUCING/STALLED`）；② 三层轮询（L-fast/L-mid/L-full）；③ 全局去重表 + 4 个限额常量；④ `reasonClass` 归一化；⑤ 把 `statusUpdatedAt` 当延迟基准；⑥ 在线停止分类器（`classify-stop.mjs` 的 CLI 路径）。 |
| **该保留的资产** | 三条原则（fail-closed、不重试、留痕）与四个判据模块（`stop-signals.mjs`、`verify-claims.mjs`、`asked.mjs`、`probeJobs`）。它们是这个仓库真正值钱的部分，且**都没被接进生产**。 |
| **最简架构** | **4 个部件**：事件源（transcript 尾部未配对 `tool_use`）、去重（`tool_use.id`）、判据（现成函数直接 import）、落地前回读（唯一的"不谎报"实现）。详见 §3。 |

**一句话**：这套系统在真实数据上的准确率是 **4/7 ≈ 57%**，而且它每天只发 2.2 条。一个每天发 2 条、43% 是假的的通知系统，问题不是"哪里写错了"，是"它在用错误的东西定义事件"。

---

## 1. 决定性证据（先摆数据，再谈设计）

### 1.1 七条真实通知，三条是假的——判据全在 transcript 里可查

生产 `watch.log` 里只有 2 条 `notified` 行，但 `state.json` 的 `budget.sentLog` 记录了 7 次真实发送（T2）。我对**每一次发送时刻**回放了该会话当时的 transcript 前缀，计算「此刻有哪些 `tool_use` 还没有配对的 `tool_result`」：

| 发送时刻 (UTC) | 会话 | 当时未配对的 tool_use | 判定 |
|---|---|---|---|
| 19:16:31 | <session-W> | `AskUserQuestion@19:16:28` | ✅ 真的在等 |
| 19:31:49 | <session-S> | `AskUserQuestion@19:31:35` | ✅ 真的在等 |
| **19:50:33** | **<session-T>** | **`Bash@19:49:19`（`sleep 840`）** | ❌ **在干活，不是等你** |
| **20:03:57** | **<session-T>** | **`Bash@19:59:43`（`sleep 840`）** | ❌ **在干活，不是等你** |
| 21:00:43 | <session-S> | `AskUserQuestion@20:58:29` | ✅ 真的在等（但迟到 33.7s） |
| 21:39:37 | <session-U> | `AskUserQuestion@21:39:32` | ✅ 真的在等 |
| **21:57:22** | **<session-U>** | **`AskUserQuestion@21:39:32`（同一个）** | ❌ **重复** |

**3/7 = 43% 是假的。**

复现（只读）：
```bash
node --input-type=module -e "
  // 对每个发送时刻 T，扫 transcript 前缀，收集 tool_use.id 并减去 tool_result.tool_use_id
  // 完整脚本见本报告 §6 第 1 条"
```

**为什么这两条 `Bash` 是决定性的**：它们是 `sleep 840`（14 分钟）。两次通知发出时，那条命令**正在执行**，`tool_result` 分别在 19:59:20 与 20:09:43 才到达（T2）。宿主在那一刻报的 `waiting / permission prompt` 是**残留**。

⚠ 我在 1.1 里必须自我设限一条：`waitingFor: "permission prompt"` 理论上可能是某个子 agent 挂着未处理的权限提示。我**没有**逆向宿主的 `bVo()` 状态机，不能断言这个 `waiting` 是错的。我能断言的是更弱但足够的一条：**在那个时刻，主会话正在执行一条 14 分钟的 Bash，用户没有任何可做的事。** 按「用户是否被打扰且无事可做」判，这两条是误报。

### 1.2 去重表已经不是去重表，是限流日志

生产 `state.json`（T2，非虚拟化读取，43 KB）：

```
notified 条目：73 条
涉及会话：    5 个
实际发出：    7 条
建了从未发出：66 条（其中最早的一条已经积压 14.5 小时，suppressedBy=global-10min）
```

最严重的一个会话 `<session-T>` 独占 **59 个键 / 13.4 小时**，键间隔的分布是：

```
min 4.0min  p25 5.1min  p50 5.2min  p75 5.2min  max 327.4min
间隔 < 6 分钟的：47 / 59
```

**p50 = 5.2 分钟，正好是 `PROBE_INTERVAL = 5 * MINUTE`（`watch.mjs:58`，T1）。** 这不是去重，这是「每 5 分钟记一笔『我又看见它在等』」，然后靠 24 小时 TTL（`pruneNotified`，`watch.mjs:382-398`）定期清空。

### 1.3 键会同时误合并和误分裂——两个方向都在生产里发生了

- **误合并**：`probeWaiting`（`watch.mjs:575-617`，T1）构造候选时**不产 `evidenceFingerprint`**（对比 `candidatesFromScan` 在 `:945` 产、`askedCandidates` 在 `:2362` 产）。而 `reasonClass("waiting:input needed") === reasonClass("waiting:permission prompt") === "waiting"`（T2 实测）。于是 sessions 源的键恒为 `771d542c73df3fb3`。该键在 19:31:49 就 `notifyCount=1`，此后**每一次**真等待都被判 `already`。
  → 20:58:43 那个 tick 的 `candidates=1 already=1` 就是这个（任务描述里的日志）。
- **误分裂**：同一次等待被两条路径各产一个键。`<session-U>` 在 21:39:43（`key=3679ed23e2930d88`，sessions 源）与 21:58:04（`key=4991735d1f97e981`，scan 源）弹了两次，而 transcript 显示那是**同一次等待**（21:39:32 提问 → 22:18:20 才回答）。

**同一个设计在 40 分钟内既吞掉了一条真通知，又多发了一条假通知。** 这不是两个 bug，是同一个错误的两个面。

### 1.4 宿主 `statusUpdatedAt` 在两天内以**相反**的方式撒谎

我连续采样了生产会话文件（T2）：

| 会话 | 时刻 | `status` | `statusUpdatedAt` 距今 | transcript |
|---|---|---|---|---|
| <session-T> | 2026-11-09 00:28 | waiting | **115 分钟前** | 此后新增 **328 条**记录 |
| <session-T> | 2026-11-09 09:18:21 | waiting | **0 秒**（刚刷新） | 未配对的 `Bash` 是 09:11:57 发的（6 分钟前） |
| <pid-E> (<session-T>…) | 2026-11-09 08:38 | waiting | 刷新中 | 每 ~20s 推进一次 |

**同一个字段，两种撒谎方式**：

1. **滞后**：115 分钟没变，而会话一直在干活 → 用它做正向证据（`status === 'waiting'` 所以该发）会把旧状态当新事实（RT2 的 A3 已证）。
2. **无意义刷新**：等待已经持续 6 分钟，`statusUpdatedAt` 却是 0 秒前 → **用它算「等了多久」或「通知延迟」会得到 0**。

后果很硬：验收标准 `2026-11-04-notify-fix-acceptance.md` §1.5 规定 `stateAt` = `statusUpdatedAt`（T1，`:155`），并用它算 M1/M3。**这个指标测的不是延迟，是宿主最后一次重写文件的时刻。** 这不是实现问题——是指标定义本身不成立。

### 1.5 `buildInbox` 在生产上已经坏了：60 条，同一个会话

用真实 `state.json` + 真实 `readLiveSessionStates()` 调真实 `buildInbox`（T2）：

```
收件箱：60 个会话需要人处理
## WAITING · <project-B-slug>（已等 0 分钟）
- sessionId: <session-T>-...
- 宿主没写 needs —— 需要看 transcript 才知道它在等什么
## WAITING · <project-B-slug>（已等 0 分钟）
（……同样内容再 58 遍）
```

**60 条 items、1 个 distinct sessionId**。而 `SKILL.md` §0.5 要求主线程「先读收件箱」，并把它当作派发的输入。这条最危险，因为它不弹窗、不报警，直接把调度侧喂成一堆重复项。

附带的第二个缺陷：`lastSeenAt` 只在条目**创建时**写一次（`watch.mjs:1671`，T1；全文件没有第二处写它）。于是 24h TTL 从「首次看见」算，不是从「最后看见」算——但那个 24h 也没机会生效，因为 `pruneNotified` 按 `firstSeenAt` 清（`:391`，T1）。两个字段含义不同却用同一个 TTL，是「同一个数字两个含义」的第三次复发。

### 1.6 现有测试里有多少绑在旧骨架上

`node --test scripts/*.test.mjs` = **497 条全绿**（T2，实测）。按文件：

| 文件 | 条数 | 与调度骨架耦合？ |
|---|---|---|
| `watch.test.mjs` | **128** | **是**。按关键词分类约 **76 条**测的是去重/限额/分类门/时间门/分发/收件箱/可追溯率 |
| `replay-observe.test.mjs` | 15 | 是（`import {NOTIFY_STATES, dedupeKey, canNotify, recordSent, observationStats, formatStats}`，`replay-observe.mjs:65-68` T1） |
| `state-model.test.mjs` | 41 | 否（判据本身） |
| `asked/stop-signals/verify-claims/classify-stop` | 68+34+79+42 | 否（纯函数） |
| `oversight-tui/app-router/validate-run/install-watcher/tui-theme` | 37+20+12+12+9 | 否 |

**耦合面 ≈ 143/497 = 29%。** 这 143 条**不必全部作废**——它们大部分测的是行为契约（「同一个事件只发一次」「发送失败不重试」「判不了就不发」），那些契约在重做后仍然成立，只是接口换了。真正的重写量是接口层，不是行为层。

### 1.7 已实现的强判据覆盖率与频率（决定"该监控什么"）

对全语料实测（T2）：

**结构化提问（`AskUserQuestion` / `ExitPlanMode` + 无对应 `tool_result`）**
```
全语料 tool_use 事件：225（全文件顺序读，含尾窗重复计数）
其中能配到 tool_result 的：225 / 225 —— 语料里没有一条"提问永久悬空"的历史记录
可算延迟的配对（两端时间戳都在）：177 = AskUserQuestion 165 + ExitPlanMode 12
回答延迟：n=166（去重后按 id），p10=41s  p25=79s  p50=149s  p75=405s  p90=2382s
存活曲线：>20s 92.8% | >45s 88.0% | >60s 84.3% | >300s 34.3% | >1h 7.3% | >24h 0%
频率：167 个 AskUserQuestion 跨 25 个活跃日 ≈ 每日 6.7 个
当前开着的（最近 24h 窗口）：0 个
```

**终态 API 错误（`errorOf` + 该 assistant 记录是文件最后一条 assistant）**
```
终态错误会话：61 个
  其中 Temp/自测目录：10 个
  其中只有 1–2 条 assistant 记录的裸 auth 失败：20 个
  真实项目：51 个（最多的是 <project-A> 13、Overwatch 10、<project-H-dir> 9）
最近一次真实终态错误：2026-11-02T15:08Z（本报告写于 11-09，即 7 天前）
24 小时内：0 个
```

**完成声明无证据（`verify-claims`）**
```
40 个会话里 7 个有可提取的声明（8%），共 9 条 claim
其中 STALE_ONLY 2 条、SUPPORTED 6 条、UNKNOWN 1 条
```

**文本问句（`endsWithQuestion`）**
```
`docs/research/2026-11-02-deterministic-signals.md` §5.2 实测：
115 条「确实在等你」的话里，100% 不以问号结尾 —— 命中 0
```

四条判据的画像完全不同：**结构化提问高频高准、终态错误低频高值、完成声明低频高值、文本问句零命中**。而现在的架构用一个"会话状态"把它们全部压成同一形状。

---

## 2. 问题一详解：为什么"修"走不通

### 2.1 根本性错误只有一条

**把「会话处于什么状态」当作事件。**

| | 状态（现在用的） | 事件（该用的） |
|---|---|---|
| 定义 | 每轮重新计算的谓词：`now - lastActivity > 1h` 且 宿主说 waiting | 某个时刻发生了一次**可配对的转变**：`tool_use` X 创建了，其 `tool_result` 还没出现 |
| 身份 | 不稳定。同一个事实两个口径 → 两个键；谓词值不变 → 永远同一个键 | 稳定。`tool_use.id` 是宿主生成的 UUID，一次性的 |
| 天然去重 | 否 | 是 |
| 时效 | 需要额外的"边界在哪个时刻"的判断 | `tool_use` 自带 `timestamp` |

从这张表可以直接推出三个必然结论，全部在生产里应验：

1. **必然需要去重表 + 限额**。因为状态没有身份，只能靠 `session|state|reasonClass|fingerprint` 造一个，而 `reasonClass` 是为了抹掉漂移的数字才存在的（`watch.mjs:442-447` 的注释自己说：曾直接用完整 reason，导致"去重形同虚设，退化成限流"）。**`reasonClass` 的存在本身就是"选了错误的事件定义"的化石。**
2. **必然需要多层轮询**。因为状态是谓词，谓词要重新计算，重算要读 transcript；而读 transcript 贵（`asked.scanAll` 实测 22.9s，RT2 §2.1），于是拆层、分层到期、派发被最慢的层拖住。**45 秒延迟不是 bug，是"用状态做事件"的直接后果。**
3. **必然误报**。因为"状态成立"不等于"有事可做"（`Bash sleep 840` 在跑时状态也是 waiting）。

### 2.2 如果只修 bug，下一类 bug 会在哪里冒出来

模式是：**任何以「会话状态谓词」为输入的下游组件，都会被去重/限额/时效三件事轮流污染。** 按"已经发生 → 下一个"排：

| # | 位置 | 状态 | 证据 |
|---|---|---|---|
| 1 | `dispatchCandidates` 去重键 | 已坏（误合并 + 误分裂） | §1.3 |
| 2 | `buildInbox` | **已坏**（60 条同一会话） | §1.5 |
| 3 | `runTick` 派发位置 | 已坏（45s 延迟） | 诊断报告 §2.2 |
| 4 | `traceability()` 正则 | **已在坏**（标签带空格 → 掉出分母，实测 3 行只剩 1） | RT2 §C4 |
| 5 | `--stats` 分布 | 已无意义（观察日志 6 条里 5 条 `UNCLASSIFIABLE` + `classify:error`） | §7 实测 |
| 6 | `NOTIFIED_TTL_HOURS` vs `lastSeenAt` | 结构错位（TTL 按 firstSeen 清，lastSeen 从不更新） | §1.5 |
| 7 | **下一个**：`replay-observe.mjs` | 它 import 了 `dedupeKey`/`canNotify`/`recordSent`，是**唯一**的外部消费者。任何键语义变更都会静默改变它的回放结论，而它是所有"这判据值不值得接"的证据来源 | `replay-observe.mjs:65-68` |
| 8 | **下一个**：`probeJobs` 的事件时刻推断 | `resolveJobEventTime`（`watch.mjs:698-724`）有 4 个候选源、按"取最旧"排序。这是同一个问题的另一形态：**宿主不给事件时刻，我们造一个** | T1 |

第 7 条是重做风险的核心：**回放工具会被重做悄悄改坏，而它正是评估重做效果的唯一手段。** 重做时必须先钉住回放工具的输入契约。

### 2.3 重做的成本

| 项 | 量 | 依据 |
|---|---|---|
| 需要重写的调度骨架 | `watch.mjs` 约 **1763 / 2507 行**（去重+限额、探针、分发、runTick、traceability、inbox） | T2 按行段计数 |
| 需要重写/改断言的测试 | 约 **91 条**（`watch.test.mjs` 76 + `replay-observe.test.mjs` 15） | §1.6 |
| 不受影响 | **354 条**（判据模块、TUI、结构门、asked/verify-claims/classify-stop/stop-signals） | §1.6 |
| 可复用的生产代码 | `stop-signals.mjs` 540 行（34 测试）、`verify-claims.mjs` 1163 行（79 测试）、`asked.mjs` 的 `classifyQuestion`/`humanSpokeElsewhere`、`probeJobs` 的 fail-closed 逻辑 | T1 |
| **结论** | 重做的净增量约 **600–800 行新代码 + 90 条测试改写**，而非从零开始 | T3 |

**风险三条，按严重度：**

1. **丢 fail-closed**。现在的 `probeJobs` 在事件时刻不可判定时**不通知但留痕**（`watch.mjs:760-766`，T1），这是全仓最好的一段代码。重做最容易顺手把它简化掉。必须原样保留并加负向测试。
2. **丢 AC5（发送失败不重试）**。`dispatchCandidates` 把 `delivery:'failed'` 也当作"已处理"（`:1615`，T1），注释写明理由。重做若引入重试，会消耗信任。
3. **回放工具失效**（§2.2 第 7 条）。必须在改任何东西之前，先给 `replay-observe.mjs` 加一条"输入契约快照"测试。

**为什么"只修"更贵的是另一件事**：最小修复会**打开一个现在没有的故障**。RT2 用真实函数复算过：给 sessions 源补 `evidenceFingerprint` 修好 A1，同一次等待就会有**两个可发的键**，对当天第一次等待的会话额度还剩 2 格 → 两条都发（RT2 §A2 实测：第二条被 `GLOBAL_MIN_GAP` 推迟 11 分钟后照发）。**修复会把"每天 0 次重复"变成"每次等待 2 条"。** 那是比迟到更糟的退化。

---

## 3. 问题三详解：最简架构（具体设计，不是原则）

### 3.1 四个部件

```
① 事件源       每 5 秒：stat 最近活动会话的 transcript mtime（3.6ms）
               mtime 变了 → 读尾部 64 KB，解析出「未配对的 tool_use」集合
                          （实测 10 个活会话 tail+parse = 17.7 ms）

② 去重         key = tool_use.id（宿主生成的 UUID）
               —— 不是 session|state|reasonClass|fingerprint

③ 判据         直接 import 已实现的纯函数：
                 questionAnswered(records)  ← stop-signals.mjs:311
                 endsWithoutToolUse(rec)    ← stop-signals.mjs:102
                 errorOf(rec)               ← stop-signals.mjs:128
                 classifyEvidence(...)      ← verify-claims.mjs:754

④ 落地前回读    发送前重读该会话的 64 KB 尾：
                 该 tool_use.id 已有 tool_result → 不发，记 resolved-before-send
```

### 3.2 事件从哪来，为什么这个源最可靠

**`transcript` 尾部未配对的 `tool_use`。** 理由是它是**唯一不依赖推断的结构化事实**：

- `tool_use` 块有 `id`，`tool_result` 块有 `tool_use_id`，配对是**字符串精确相等**。不需要分类器、不需要文本匹配、不需要宿主状态。
- 实测可靠性：232 个 transcript 里，**64 KB 尾部窗口**与 50 MB 全量读对「未配对 tool_use 集合」的结论 **10/10 一致（零 mismatch）**（T2）。
- 实测成本：`fs.statSync` 21 个最近文件 **3.6 ms**；10 个活会话 tail 64 KB + JSON.parse **17.7 ms**（T2）。

**对比三个候选源的实测结论**：

| 源 | 覆盖 | 可靠性 | 结论 |
|---|---|---|---|
| `sessions/*.json` 的 `status` | 最近 24h 有 21 个活跃 transcript，只有 **10 个**有宿主会话文件（T2） | `statusUpdatedAt` 两天内以相反方式撒谎两次（§1.4） | **不能做正向证据**，只可做反向（`!= 'waiting'` → 不发） |
| `jobs/*/state.json` | 本机 13 个 job，2 个 failed/blocked，最近 7 天一次 | 事件时刻要 4 个候选源去猜（`resolveJobEventTime`） | 保留，但只用于后台作业 |
| transcript 尾部 | **100%**（每个会话都有 transcript） | 配对是精确字符串相等 | **主源** |

⚠ 一个必须写进设计的诚实边界：**这套事件源只能看见「用工具提问」。** 实测 115 条「确实在等你」的话里 **100% 不以问号结尾**（`2026-11-02-deterministic-signals.md` §5.2），`endsWithQuestion` 命中 0。所以文本问句这一类**必须放弃**——它是 87.5% 的主体，但判不出来。硬判就是 `hb_gap` 的复刻（5 发 5 误）。

### 3.3 怎么去重：`tool_use.id`

用 §1.1 的 7 次真实发送回放：

```
按 tool_use.id 做键：
  会发：4 条（4 个不同的 AskUserQuestion id）
  重复被挡：1 条（<session-U> 21:57 那次与 21:39 同一个 id）
  压根不产生事件：2 条（那两条是 Bash 在跑，不是提问）
```

**零误合并、零误分裂、不依赖 `reasonClass`、不需要 4 个限额常量。**

那限额还要不要？要，但只剩一个用途：**首次运行时不要把历史事件刷屏**。正确形态是"启动时只看 `age < 24h` 的事件"，而不是 4 个滚动窗口常量（`GLOBAL_MAX_24H` / `PER_SESSION_MAX_24H` / `GLOBAL_MIN_GAP` / `ASKED_MAX_24H`）。这 4 个常量在 §1.2 里已经被证明会产生 66 条积压和 60 条重复收件箱。

### 3.4 什么时候发：实时两类，其余进摘要

| 事件 | 形态 | 依据 |
|---|---|---|
| 结构化提问未答且**超过 30s** | **实时** | 存活曲线：30s 时 92% 还没答；30s+5s 送达的假阳性率 **0.7%（1/152）**（T2 实测） |
| 终态 API 错误（`errorOf` + 该记录是最后一条 assistant） | **实时** | 61 个终态错误里 0 个后来恢复过工作（实测）。低频（7 天 0 次），每条都值钱 |
| 完成声明无证据（`verify-claims`） | **摘要** | 8% 会话有声明、22% 拿不出证据；不需要打断 |
| `Bash` 长跑 / silent stop / `WAITING` 但无提问 | **不发，进摘要一行** | §1.1：两条 `sleep 840` 就是在这一类里变成误报的 |

**dwell 门槛的选择有实测支撑**（T2，n=166）：

| dwell | 会发 | 落地时已成假（+5s 送达） | 落地时已成假（+20s 送达） |
|---|---|---|---|
| 15s | 93% | 0.6% | 2.6% |
| 30s | **92%** | **0.7%** | 4.6% |
| 45s | 88% | 0.7% | 6.8% |
| 60s | 84% | 2.9% | 13.6% |

**取 30s**：覆盖率 92%，假阳性 <1%（5 秒送达），且从 30s 到 60s 覆盖率只掉 8 个百分点而假阳性翻 4 倍——60s 是更差的点。注意这与现在的 `UNCLASSIFIABLE_MIN_IDLE_SEC = 300` 不同：那个门槛是给"判不出来的状态"设的，本设计**没有"判不出来"这一类**（判据只有命中/未命中）。

**摘要节奏**：不要"每小时一份"。实测每天 6.7 个提问，实时发完就没有摘要的必要了。摘要按**"有内容才发，没有就静默"**——空摘要会教用户忽略摘要，比不发更糟。

### 3.5 怎么保证不谎报：fail-closed 的具体实现

四处，每一处都可机械检验：

| # | 情形 | 动作 | 判据 |
|---|---|---|---|
| **F-1** | 读不到 transcript / JSON 坏行 | **不发**，记一条 `unreadable` | 现状 `probeJobs` 的做法（`watch.mjs:760-766`），保留 |
| **F-2** | `tool_use` 没有 `id`（老格式） | **不发**，记 `no-id` | 无 id 就无法去重，发了就是重复源 |
| **F-3** | **发送前回读**发现 `tool_use.id` 已有 `tool_result` | **不发**，记 `resolved-before-send` | 唯一的"落地时不撒谎"实现。这个检查单向安全：只会减少通知 |
| **F-4** | 宿主 `status` 用反不用正 | `status !== 'waiting'` → 不发；`status === 'waiting'` → **不作为发送理由** | §1.4：它会滞后 115 分钟。反向用它只会抑制更多，是安全的 |

**为什么 F-3 是这套设计的关键**：现有架构里**没有**这一条（`grep -rn "resolved-before-send" scripts/` = 空，T1）。33.7 秒那条事故的本质不是"慢"，是"发送前没有核对"。F-3 用 4.8ms 的实现（`readLiveSessionStates` 实测）或更便宜的单会话回读，就能把"落地时已成假"从 0.7% 压到接近 0。

**并且 F-3 让延迟指标变得诚实**：不需要 `stateAt`/`tookMs`/M0/M1/M2/M3 那一整套（那套的起点 `statusUpdatedAt` 已被 §1.4 证伪）。真正的指标只有一个：**落地时仍然成立的比例**。这个指标可以直接从 `resolved-before-send` 的计数算，不需要任何时间戳。

### 3.6 与现有代码的具体对应

| 新部件 | 现成代码 | 状态 |
|---|---|---|
| 事件源 | `readTail`（`stop-signals.mjs:73`）+ `questionAnswered`（`:311`） | 已实现、已测（34 条） |
| 终态错误判据 | `errorOf`（`:128`）+ `endsWithoutToolUse`（`:102`） | 已实现、已测 |
| 完成声明判据 | `verify-claims.mjs` 全部 | 已实现、已测（79 条） |
| 标签订名 | `asked.mjs` 的 `classifyQuestion`/`GREETING` 清噪逻辑 | 部分可用 |
| 后台作业 fail-closed | `probeJobs` + `resolveJobEventTime` | 已实现，**保留不动** |
| **待写** | 5 秒主循环、事件构造、id 去重、回读、摘要渲染 | **约 400–600 行** |

---

## 4. 问题二详解：全量监控这个前提是错的

**是错的。** 三条独立理由：

1. **覆盖率**：87.5% 的停机 AI 没在问任何东西（`2026-11-01-ground-truth-first.md`）；非问题项 14.5% + 真需语义 4.5% = 19% 不可判。**全量监控的绝大部分产出必然是噪音。**
2. **频率倒挂**：最有价值的信号（终态错误、完成声明无证据）频率最低（7 天 0 次 / 8% 会话）；最没价值的信号（状态变化）频率最高（<session-T> 13.4 小时 59 次）。**全量监控是为高频低值信号优化架构，代价是低频高值信号被限额挤掉。** 生产里真实发生：19:50 那条 `global-10min` 抑制就是被 5 分钟一次的刷屏挤掉的。
3. **宿主覆盖**：最近 24h 有 21 个活跃 transcript，只有 10 个有宿主会话文件（T2）。"全量监控所有会话状态"这句话的一半数据源只覆盖一半会话。

**替代方向逐个判断**：

| 方向 | 判断 | 数据 |
|---|---|---|
| 只监控「明确在等用户」（`AskUserQuestion`/`ExitPlanMode` 的 `tool_use` 且无 `tool_result`） | **✅ 主力。** 结构化事实，不是推断。实测 30s dwell + 5s 送达 = 覆盖 92%、假阳性 0.7% | §1.7 / §3.4 |
| 只监控「AI 声称完成但拿不出证据」 | **✅ 但要进摘要，不做实时。** 8% 会话、22% 无证据。它回答的是"最贵的错误"，但不需要 30 秒内打断人 | §1.7 |
| 只监控「报错停机」 | **✅ 实时，但要知道它有多稀疏。** 61 个终态错误，最近一次 7 天前；20 个是 Temp 目录的裸 auth 失败（应过滤） | §1.7 |
| 干脆不做实时，改定期摘要 | **❌ 部分否。** 结构化提问 p50 = 149s、84% 在 60s 内没答——**这是实时的场景**。一小时后告诉你"一小时前有人问你，你已经答了"就是当前缺陷的放大版 | §1.7 存活曲线 |
| 监控文本问句（`endsWithQuestion`） | **❌ 放弃。** 115 条真等待命中 0 | `deterministic-signals.md` §5.2 |
| 监控 `novelty` / 心跳 / `STALLED` | **❌ 已证死。** `STALLED` 56,809 滑窗命中 10 次（0.018%）、末态 0 次；`hb_gap` 5 发 5 误。§2.0.1/2.0.2 已删除 | `state-model.md` |
| 在线停止分类器（`classify-stop` CLI） | **❌ 结构性失败。** 在线 95.4% 判 `UNCLASSIFIABLE`——它需要"下一句"才能判，在线时下一句还没发生 | `2026-10-31-online-classification.md` |

---

## 5. 如果只允许改一件

**改事件定义。** 具体是：把「候选」从 `{sessionId, state, reason, idleSec}` 改成 `{sessionId, toolUseId, kind, createdAt}`。

理由：§1.2、§1.3、§1.5、§1.6、§3.3 里所有的具体故障——66 条积压、60 条重复收件箱、误合并、误分裂、59 个键/13 小时、4 个限额常量、`reasonClass` 的存在理由——**全部是"事件没有身份"的下游后果**。一个 `tool_use.id` 就能同时消掉这六条。

这一条不需要重写 `stop-signals.mjs`、`verify-claims.mjs`、`probeJobs`，也不需要碰 354 条无关测试。它是重做的**最小切口**，也是验证"重做是否值得"的**最低成本实验**。

如果只改这一条会怎样：`dispatchCandidates` 的去重键、`buildInbox` 的聚合、限额的必要性全部要重写——也就是说，改完这一条，剩下的架构已经站不住了。这就是我认为该重做而不是修的原因：**最小正确改动自动否定了现有骨架。**

---

## 6. 复现记录（全部只读）

```bash
# 1. 七条通知时刻的未配对 tool_use（§1.1）
#    对每个发送时刻 T，扫 transcript 前缀，收集 tool_use.id 并减去 tool_result.tool_use_id
#    实现见 §1.1 内联脚本；输入：state.json 的 budget.sentLog 7 个时间戳

# 2. 去重表统计（§1.2）
node -e "const st=require(process.env.LOCALAPPDATA+'/Overwatch/state.json');
  console.log(Object.keys(st.notified).length, st.budget.sentLog.length)"

# 3. 60 条重复收件箱（§1.5）
node --input-type=module -e "import {buildInbox,readLiveSessionStates} from './scripts/watch.mjs';
  const st=JSON.parse(require('fs').readFileSync(process.env.LOCALAPPDATA+'/Overwatch/state.json','utf8'));
  const items=buildInbox(st,{nowMs:Date.now(),live:readLiveSessionStates()});
  console.log(items.length, new Set(items.map(i=>i.sessionId)).size)"

# 4. 回答存活曲线（§1.7 / §3.4）：全语料 166 个 AskUserQuestion 的 tool_use→tool_result 间隔
#    逐行读全部 transcript，建 id→result 表，排序后按阈值计数

# 5. tail 64 KB vs 全量读的一致性（§3.2）：10 个活会话，两种窗口的未配对集合比对，0 mismatch
```

**实测运行环境**：`node --test scripts/*.test.mjs` = **497 通过 / 0 失败**；`watch.log` 与 `state.json` 经**非虚拟化进程**读取（见 `2026-11-04-watcher-silent-failure.md` 的 MSIX 影子目录结论）。

---

## 7. 自我设限（我可能错在哪）

1. **§1.1 的"假阳性"判定依赖"Bash 在跑 ≠ 该通知"这个前提。** 有人可以说"用户可能想中途打断那条 14 分钟的命令"。我不接受这个反驳（通知文案是「正在等你（permission prompt）」，不是「可以打断」），但承认它是价值判断而非事实判断。
2. **我没有逆向宿主 `bVo()` 状态机**，所以不能说 `waiting/permission prompt` 是"错的状态"。我只能说它在这个时刻**不可行动**。
3. **225 个结构化提问全部有答案**这句受尾部窗口限制：如果提问在很早以前、`tool_result` 在 64 KB 窗口之外，我会误判为"未答"。实测 64 KB 与 50 MB 在**当前 10 个活会话**上结论一致，但不保证对 232 个历史文件都成立。
4. **重做成本 600–800 行是估算**，没有做过原型。真实成本可能高 2 倍。但"只修会打开重复通知"是实测，不是估算。
5. **我用的是 2026-11-08/09 这 36 小时的生产数据。** 7 条通知、3 条假，样本量小（rule of three：n=7 时 95% 置信下界约 1−3/7 = 0.57，与我报的 57% 巧合一致）。**这个数字本身不可靠，可靠的是那三条的机制**——每一条都能在 transcript 里逐字核对。

---

## 8. 给主线程的三句

1. **重做，不是修。** 最小修复（提前派发 + 补指纹）实测会同时打开"每次等待 2 条重复"和"`saveState` 每轮 >1 次"两个新故障。
2. **最该砍掉的是「会话状态」这个事件定义**，以及为它服务的整套脚手架（四态、三层轮询、全局去重表、4 个限额常量、`reasonClass`）。它们不是 bug，是同一个错误的六个下游表现。
3. **最简架构四个部件**：事件源 = transcript 尾部未配对 `tool_use`；去重 = `tool_use.id`；判据 = `stop-signals`/`verify-claims` 直接 import；不谎报 = 落地前回读一次。实时只发两类（提问未答 > 30s、终态 API 错误），其余进"有内容才发"的摘要。
