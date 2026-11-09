# 红队 RT2：攻击「立即派发 + projectLabel」修复方案

> 产出形态：**exploration**。未修改任何代码、未碰 git、未重启守护进程。
> 攻击对象：拟议修复（1) L-fast 探完立刻派发 + 发送前回读 live 状态；(2) `projectLabel(raw, name)` 六处共用。
> 所有结论均来自**真实生产数据**（经 WMI `Win32_Process Create` 起的非虚拟化进程读取）
> 与本仓库真实函数（`import` 进来跑，不是重写）。

---

## 0. 结论先行

| # | 攻击点 | 判定 | 决定性证据 |
|---|---|---|---|
| **A1** | 提前派发能修好 21:00 那条迟到通知吗 | **不能。一条都发不出去。** | 20:58:43 那个 L-fast tick **已经抓到了候选**（日志 `candidates=1 already=1`）。挡住它的是**去重表**，不是派发位置。用真实 `state.json` + 真实 `probeWaiting` 候选重跑 `dispatchCandidates`：`sent=0 already=1`。根因是 sessions 源不产 `evidenceFingerprint`，键恒为 `771d542c73df3fb3`，19:31:49 就发过了。 |
| **A2** | 拆开后限额还准吗 | **不准，且已经在生产中造成重复通知。** | 同一次等待被两条路径各产一个键（`771d…` / `81bf…`，实测复算一致）。`<session-U>` 在 21:39:43 与 21:58:04 弹了**两次**，而 transcript 显示那是**同一次等待**（21:39:32 提问 → 22:18:20 才回答）。18 分钟内同一件事两个标题。 |
| **A3** | 发送前回读 live 状态可靠吗 | **不可靠，回读的字段本身就是滞后的谎言。** | `<session-T>` 此刻 `status=waiting`、`statusUpdatedAt` 停在 **22:33:40（115 分钟前）**，而 transcript 此后新增 **328 条**记录。回读会看到 `waiting` → 照发。R2 反例（"发送前发现状态已变 → 抑制"）在这个会话上**永远不触发**。 |
| **A4** | 提前派发会加剧 saveState 竞争吗 | **数值上不会（实测并发 429 次零 EPERM），但它会直接触发预先声明的否决项 V4。** | `saveState` 实测 5–9ms/次；4 进程并发 4 秒共 429 次 `rename`，**0 次 EPERM**。但 `docs/spec/2026-11-04-notify-fix-acceptance.md` §3 **V4 明文："每 tick `saveState` 调用次数 > 1" 即整体否决**。方案 A 若不落盘就会重复发，落盘就必然 >1 次。 |
| **B1** | 延迟到底能降多少 | **比宣称少得多：约 5% 的样本受益，其余 95% 完全不变。** | 见 §2.2 的结构分析 + 实测 tick 间隔分布。用今天真实间隔算「等到下一次派发」的盲区：**P(M1 > 20s) = 10.01%**。 |
| **B2** | L-fast 本身多快 | **~10ms。它不是成本，L-mid 才是。** | `jobs` p50=8ms / p95=14ms（4575 条日志行统计）；`probeWaiting` 我直接计时 **7.8ms**（10 个会话文件）。 |
| **B3** | 通道占多少 | **4.2–4.4s，固定，消不掉。** | 用 `notify.mjs` 同款 wscript→PowerShell→WinRT 链路实测 3 次：**4402 / 4151 / 4412 ms**。 |
| **C1** | `name` 会不会和实际项目不符 | **不会（10/10 都是宿主自动命名，`nameSince === startedAt`），但它会漂移到与 cwd 不同的语义。** | `OmniSight` ↔ cwd `Overwatch`（本仓库，公开）；`<project-I>` ↔ `<project-I-dir>`；`<project-B>` ↔ `<project-B-dir>`；`<project-J>` ↔ `<project-J-dir>`。可读性更好，但**不是目录名**——`state.notified` 里存它会让 `resolveTranscriptPath` 的直接命中失效。 |
| **C2** | 24 字符截断会不会撞名 | **会，而且在只有 slug 可用的 95.7% 会话上大面积撞。** | 对 35 个真实项目 slug 做截断：**4 组碰撞**。`<prefix-A>…` 一个标签覆盖 **5 个不同项目**（`<project-A>` / `<project-B>` / `<project-C>` / `<project-D>` / `<project-E>`）。`<prefix-B>…` 覆盖 **7 个**临时目录。 |
| **C3** | 真的只有六处吗 | **不是。生产侧 6 处 + 消费侧 6 处 = 12 处**，且方案只提了六处。 | 自己 grep 全仓：`asked.mjs:547`、`oversight-tui.mjs:660`、`scan-sessions.mjs:726`、`verify-claims.mjs:1132/1139/1149`、`stop-signals.mjs:530` 都是人可见的标签位。方案漏掉的 `watch.log` 里的 `notified … ${c.project}`（`:1704`）会**静默缩小可追溯率分母**（实测见 §3.3）。 |
| **C4** | 把 label 塞进 `project` 会怎样 | **直接触发 T-F8，并让 transcript 直接命中路径失效。** | `resolveTranscriptPath`（`:1137`）用 `project` 当路径前缀。实测：正确 slug 首调 **26.6ms**（直接命中）；用显示名回退到全目录索引 **37.2ms**（231 项、31ms 构建）。且 `state.notified.project` 的历史值（slug）与新值（label）不可比。 |
| **D1** | 有没有更根本的解法 | **有：让 L-mid 真正离开关键路径，而不是把派发往前挪。** 提前派发只对「L-mid 轮开始前那 15 秒内出现的 waiting」有效。 | 见 §4.1。方案 A 在 L-mid **执行期间**（占墙钟 11.6%）内新产生的 waiting 上**完全无效**——那时 L-fast 已经跑过了。 |
| **D2** | 事件驱动可行吗 | **技术上可行，但 `fs.watch` 在真实 sessions 目录 12 秒内 0 事件**（无状态变化时），且被验收标准 V2 卡住（每 tick 仍必须读 `sessions/*.json`）。它只能叠加，不能替代轮询。 | 实测：`fs.watch(~/.claude/sessions)` 12s → 0 事件；临时目录模拟宿主 `tmp+rename` 原子重写 → 能收到 `rename`/`change`。 |
| **D3** | 不修的危害有多大 | **标题问题每天必遇（43% 通知是 slug）；迟到问题一周 1–3 次真正变成假警报。** | 生产日志 5 天共 11 条通知（10-31:1、11-02:3、11-08:7）。今天 7 条里 **3 条标签是 slug（43%）**；M1 > 20s 的 **6 条**，但真正"落地时用户已答完"的只有 **21:01 那 1 条**。 |

**一句话**：这个方案修的是**一个不存在的瓶颈**（派发位置），漏掉了**真正的瓶颈**（去重键 + L-mid 占着单线程主循环）；标题部分方向对，但把 label 塞进 `project` 会同时踩 T-F8 和可追溯率分母两个雷。

---

## 1. 攻击 A：提前派发会引入什么

### A1. 致命：21:00 那条通知，提前派发一条都发不出去

这是整个方案最大的漏洞。**方案假设"发送排在最后"是迟到的原因。实测不是。**

生产的真实 `%LOCALAPPDATA%\Overwatch\watch.log`（WMI 非虚拟化读取）在事故窗口里是这样：

```
2026-11-08T20:58:28Z tick jobs waiting jobs=15ms candidates=0 ...     ← AskUserQuestion 在 20:58:29.147Z
2026-11-08T20:58:43Z tick jobs waiting jobs=6ms  candidates=1 sent=0 suppressed=0 already=1
2026-11-08T20:58:58Z tick jobs waiting jobs=8ms  candidates=1 sent=0 suppressed=0 already=1
   …（连续 8 个 L-fast tick，全部 already=1）
2026-11-08T21:00:28Z tick jobs waiting jobs=11ms candidates=1 sent=0 suppressed=0 already=1
2026-11-08T21:01:28Z tick jobs waiting probe … asked jobs=8ms probe=212ms candidates=2 sent=1 ...  ← 唯一的 L-mid 轮
```

**L-fast 在 20:58:43 就已经探到了 waiting，而且每一轮都探到。** 它没发，不是因为它排在 L-mid 后面——**那一轮根本没有 L-mid**（`tick jobs waiting jobs=6ms`，全程 6ms）。它没发是因为 `already=1`，即 `dispatchCandidates` 里：

```js
if (entry && (entry.notifyCount > 0 || entry.delivery === 'failed')) {
  summary.already++;
  continue;                        // watch.mjs:1610
}
```

**决定性复现**（用真实 `state.json` 还原 20:58:43 时点的状态 + 真实 `probeWaiting` 产出的候选 + 真实 `dispatchCandidates`）：

```
candidate（sessions 源，无 evidenceFingerprint）:
  {"sessionId":"<session-S>-...","state":"WAITING","reason":"waiting:input needed",
   "project":"<project-J-dir>","idleSec":14,"source":"sessions"}
dedupeKey = 771d542c73df3fb3        ← 与 19:31:49 那次完全相同
state 里有这个键吗: true (notifyCount=1)

=== 如果按方案 A：L-fast 一探完就立刻派发，会怎样？ ===
sent=0 already=1 suppressed=[]
通知是否真的发出: false

=== 同样的状态，但给候选补上 evidenceFingerprint（P1-2 的做法）===
  >>> 通知发出: ✋ <project-J-dir> · 正在等你（input needed）
sent=1 already=0
```

**根因**：`reasonClass('waiting:input needed') === 'waiting'`，`probeWaiting` 不产 `evidenceFingerprint`，于是 sessions 源的键恒定。19:31:49 发过一次，此后**该会话每一次真等待都被判成"已处理"**。20:58 那次能通知到你，纯粹因为 L-mid 的 scan 路径**恰好**带了指纹（`8205829147`）、算出另一个键——这是巧合，不是设计。

**所以**：方案 A 对本次事故的净效果 = **0**。要修好它，必须先修去重键（`probeWaiting` 补 `evidenceFingerprint`）。而那一改**会引入 A2 的重复通知**。

### A2. 拆开后限额不准，而且已经在生产中重复弹过

同一次等待、同一个 `sessionId`、同一个 `reason`，两条路径产生**两个不同的键**——用真实函数复算：

```
sessions  (无指纹) : 771d542c73df3fb3
scan      (有指纹) : 81bf69236a306942
```

`canNotify` 的限额全部基于 `state.budget.perSession[sessionId]` 与 `state.budget.sentLog`。两个不同的键意味着**两条通知各自走一遍限额，各自占用额度**。`GLOBAL_MIN_GAP = 10min` 只推迟，不阻止——10 分钟后的下一个 tick 照发。

**生产中已经发生过**。`<session-U>` 今天弹了两次，我核对 transcript 确认那是**同一次等待**：

```
2026-11-08T21:39:32.139Z  assistant  AskUserQuestion
2026-11-08T22:18:20.204Z  user       The user answered: ...
```

```
21:39:43Z notified WAITING style        key=3679ed23e2930d88  ← sessions 源
21:58:04Z notified WAITING <project-I-slug>  key=4991735d1f97e981  ← scan 源
```

**同一次等待、18 分钟内、两个标题。** 而且第二次发的时候（21:58:04）用户还在等（22:18 才答），所以它不是"过期警报"——它是**纯粹重复**。

`state.json` 里现在有 **47 条** notified 条目，其中 `<session-T>` 攒了 **30 条**不同的键（同一个 `reason: waiting:permission prompt`），`<session-S>` 攒了 **8 条**。**去重表已经不是去重表，是限流器。**

⚠ 补充：如果按 A1 给 sessions 源补指纹（P1-2），同一等待会有**两个可发的键**。实测 `<session-T>` 的 per-session 额度当天已用 2/2，所以第二个会被 `per-session-24h` 挡住——**但那是巧合，不是设计**。对当天**第一次**等待的会话，额度还剩 2 格，两条都会发出去。我在一个干净的 state 上构造了这个场景，`perSession` 用量 `["10:00:00.000Z"]`，**第二条被 `GLOBAL_MIN_GAP` 推迟到 11 分钟后发出**。这与 F2 的复现路径一致。

### A3. 回读 live 状态不可靠——回读的字段本身就是滞后的

方案 P0-2：「发送前回读一次 live 状态，`status` 已不是 `waiting` → 放弃发送」。

**问题是 `status` 会滞后。** 此刻（2026-11-09T00:28Z）真实宿主文件：

```
session <session-T-uuid> (<pid-B>.json)
  name="<project-B>"  cwd="<盘符>:\<project-B-dir>\<project-B>"
  status=waiting  waitingFor="permission prompt"
  statusUpdatedAt=2026-11-08T22:33:40.161Z  held=115min
  transcript newest record = 2026-11-09T00:25:10.179Z
  records written AFTER statusUpdatedAt = 328
  => 发送前回读 live 会看到: status=waiting —— 仍会被判成「在等你」
```

**宿主说它从 22:33 就在等你，而它此后写了 328 条记录。** 回读只会确认这个谎言。

同类证据：`<session-S>` 的 `waiting:permission prompt` 从 **21:11:50 挂到 22:20:52（约 69 分钟）**，其间 transcript 一直在长（21:15 / 21:20 / 21:25 均有工具调用）。今天的观察日志里这条被反复判 `budget-per-session-24h` 挡住了——**纯属巧合**。

**回读的延迟问题**：`readLiveSessionStates` 实测 **4.82ms**（10 个文件），可以忽略。真正的风险不是"回读慢"，是"回读读到的字段不真"。而且回读之后状态又变了这个窗口无法消除——**回读只是把窗口从 32s 缩到 5ms，但如果字段本身就是错的，缩到 0 也没用。**

### A4. saveState：数值上不是问题，但它直接撞验收标准 V4

实测成本：

```
saveState 单次: 5–9ms（28KB / 47 条 notified）
随 notified 增长: n=500 → 22ms；n=1000 → 74ms
4 进程并发写入 4 秒: 86 / 116 / 96 / 131 次成功，0 次 EPERM
```

**并发 EPERM 风险实测不高**（`saveState` 有 3 次重试 + 40ms 退避，足够）。

但它撞的是另一件事：`docs/spec/2026-11-04-notify-fix-acceptance.md` §3

> **V4** | **修复引入新的写盘竞争** | 每 tick `saveState` 调用次数 > 1；…（判据：`saveState` 调用点计数）

方案 A 的结构性后果：如果提前派发后**不立即落盘**，下一轮 tick 会重复发（去重表还没更新）；**立即落盘**则每轮 2 次 `saveState`。两者必选一个，**后者直接触发 V4 整体否决**。

---

## 2. 攻击 B：延迟到底能降多少

### 2.1 分段耗时（实测，不是估算）

| 段 | 实测 | 方法 |
|---|---|---|
| `probeJobs` | 5–15ms（p50 **8ms**，p95 14ms，n=4575） | 生产日志 `jobs=\d+ms` 全量统计 |
| `probeWaiting` | **7.8ms** | 直接调真实函数，10 个会话文件 |
| **L-fast 合计** | **~10–20ms** | 上面两项相加 |
| `probeMtime` | p50 **61ms**（n=261） | 生产日志 `probe=\d+ms` |
| 增量 `scan-sessions` × 5 | **8.8s**（文档实测） | 诊断报告 §2.1 |
| `asked.mjs` `scanAll` | **22.9s**（我实测，231 个 transcript / 1.64GB） | 直接调 `scanAll` |
| **L-mid 轮内耗时** | p50 **32.0s**，p95 47s，max 324s（n=59，仅今日） | 生产日志相邻 tick 差分 |
| **通道（wscript→PS→WinRT→回执）** | **4151 / 4402 / 4412 ms** | 用 `notify.mjs` 同款链路实测 3 次 |
| `readLiveSessionStates`（回读） | **4.82ms** | 直接调真实函数 |

**结论：L-fast 只要 ~10ms。延迟 100% 来自"L-mid 占着单线程主循环"这一件事。** 方案说的"把这些挪走"是对的，但**方案并没有把它们挪走**——它只是把派发插到它们**前面**。

### 2.2 关键：提前派发只对 5% 的样本有效

`runTick` 的顺序决定了改进的边界。假设派发点是"L-fast 之后"：

| waiting 出现的时刻 | 占墙钟比例 | 当前 M1 | 方案 A 下 M1 | 改善 |
|---|---|---|---|---|
| L-fast 轮之间的 15s 睡眠（85%） | 85% | 0–15s | 0–15s | **无** |
| L-mid 轮开始前的 15s 睡眠（5%） | 5% | 32–47s | 0–15s | ✅ |
| **L-mid 执行期间（32s）** | **~11.6%** | 47–62s | **47–62s（无改善）** | **无** |

第三行是致命的：**L-mid 执行期间 L-fast 已经跑过了**，那时还没看到 waiting；下一轮 L-fast 要等 `32s + 15s = 47s`。方案 A 在 L-mid 轮末尾（如果只派发一次）或轮前派发，都看不到这 32s 里新出现的 waiting。

L-mid 占墙钟比例实测：**2077s / 4.96h = 11.6%**（2026-11-08，逐 tick 差分累加）。

所以方案 A 的真实收益上限 ≈ **5% 的样本**。它宣称的是"p50 32s → <1s"，实际能改的只是那 5%。

### 2.3 用今天真实 tick 间隔算 M1 超限概率

把"等待到达时刻在 tick 间隔内均匀分布"作为模型，用 11-08 的真实 tick 间隔：

```
n=1090, span=5.17h
P(M1 >  8s) = 53.2%
P(M1 > 14s) = 18.1%
P(M1 > 20s) = 10.01%   ← 验收标准 §1.2 的硬上限 / D-F1
P(M1 > 30s) =  6.97%   ← D-F2 单条即整体否决
```

**这 10% 里，方案 A 只能消掉约 5 个百分点**（上表第二行）。剩下的 5% 来自 L-mid 执行窗口，方案 A 碰不到。

**验收标准的算术后果**：§1.4 要求 **n ≥ 30 条真实样本**。若单样本失败概率是 4%（乐观），

```
P(30 条样本里至少一条 M1 > 20s) = 1 − 0.96^30 = 71%
```

**即方案 A 有约 71% 的概率通不过它自己预先声明的 D-F1。** 要到 95% 通过率，单样本失败率必须 < 0.17%——那要求 M1 在所有样本上都 ≤ 20s，只有"探针与派发永不被长任务挡住"才能做到。

### 2.4 一个被忽略的固定成本

M3 = M1 + M2，而 **M2 实测 4.2–4.4s，消不掉**（PowerShell 冷启动）。验收标准 §1.2 给 M3 的 p50 上限 13s，其中 M2 占 4.3s，**留给 M1 的只有 8.7s**——比 §1.2 给 M1 单独定的 8s 还紧。

方案 A 即便把 L-mid 收益全拿到（乐观 5%），M1 的分布主体仍是"0–15s 的 tick 盲区"。**tickMs = 15s 意味着 M1 的中位数天然在 7.5s 左右，已经贴着 p50 ≤ 8s 的红线。** p90 会被 L-mid 窗口顶到 20s 以上。

---

## 3. 攻击 C：标题方案

### C1. `name` 的语义：不是"用户手改的名字"，是宿主自动概括

实测 10 个活会话，**10/10 都满足 `nameSince === startedAt`**（差 0 秒），即**会话一创建宿主就自动命名了**，没有一个是用户后改的。所以"用户手动改的名字与实际不符"这个担心不成立。

但它带来**另一种**风险——`name` 是 AI 概括，会与 cwd 语义漂移：

| `name` | cwd basename | 关系 |
|---|---|---|
| `OmniSight` | `Overwatch` | 完全不同 |
| `<project-I>` | `<project-I-dir>` | 不同 |
| `<project-B>` | `<project-B-dir>` | 不同 |
| `<project-J>` | `<project-J-dir>` | 不同 |
| `<project-L>` | `<project-L-dir>` | 不同 |
| `<project-E>` | `<project-E-dir>` | 前缀 |

**可读性更好，但它不是目录名。** 这直接决定了 §C4：不能把它塞进 `project` 字段。

**覆盖率也很低**：231 个 transcript 里，只有 **10 个（4.3%）** 有 `sessions/*.json` 记录（即只有"当前活着"的会话有 `name`）。其余 **95.7%** 只能靠 transcript 里的 `cwd` 兜底——实测 99.5% 能取到 cwd，**1 个完全取不到**（回退 `sessionId[0:8]`）。

### C2. 「cwd basename」对长路径会得到什么

对 `<盘符>:\<project-J-parent>\<project-D-dir>` 这类路径：

```
split(/[\\/]/).pop() → "<project-D-dir>"
```

**42 字符 / 42 显示列。** 远超声称的 24 字符上限，直接撑爆标题。这条正是缺陷二的原样复现（`probeWaiting` 现在就是这么做的）。

### C3. 24 字符截断会撞名——实测 4 组，最严重的一组覆盖 5 个不同项目

对 35 个真实项目 slug 做"取末段 + 截 24"：

```
COLLIDE <prefix-B>…  ← 7 个：<scratch-dir-1> / <scratch-dir-2> / <scratch-dir-3> /
                                          <scratch-dir-4> / <scratch-dir-5> / <scratch-dir-6> / <scratch-dir-7>
COLLIDE <prefix-C>…  ← 2 个：<project-G> / <project-G>-recon-upstream-full
COLLIDE <prefix-A>…  ← 5 个：<project-D> / <project-E> /
                                          <project-C> / <project-A> / <project-B>
COLLIDE <prefix-A-lower>…  ← 2 个：<project-E-slug> / <project-F>
```

**`<prefix-A>…` 一个标签覆盖 5 个活跃项目。** 用户看到这个标题，无法判断是哪一个。

**缓解事实**：由于方案优先用 `name`，而 10 个真实 `name` 截到 24 显示列**零碰撞**（实测），碰撞风险集中在 95.7% 无 `name` 的历史会话上。但这恰好是收件箱（`buildInbox` 读历史 `state.notified`）会碰到的范围。

**而验收标准 §2.1 直接判定这种降级为 FAIL**：

> 也不许把 slug「末段」当标签：实测 `…-plugin-<project-C-slug>-` 的末段是 `English`，`…-<project-D-slug>` 的末段是 `heavy`，`…-<project-E-slug>` 的末段是 `Village` —— **这不是降级显示，是错误信息**

**按字符数截断还会切出 48 显示列**（`askedCandidates` 当前实现）：

```
"<project-E>"  .length=25 → "<project-E-trunc>"  displayW=28
```

而按 24 **显示列**截断是 `"<project-E-trunc-24>"`（displayW=24）。**两种算法结果不同**——§2.2 明确要求用显示宽度，方案里的"超 24 字符截断"是**字符数**，会踩 T-F3。

### C4. 塞进 `project` 会同时踩两个雷

**雷一：`resolveTranscriptPath` 的直接命中失效。**

```js
function resolveTranscriptPath(projectsRoot, sessionId, projectHint, nowMs) {
  if (typeof projectHint === 'string' && projectHint) {
    const direct = join(root, projectHint, `${sessionId}.jsonl`);   // ← 拿 project 当路径前缀
    if (existsSync(direct)) return direct;
  }
  // 否则遍历所有项目目录建索引（60s 缓存）
}
```

实测代价：正确 slug 首调 **26.6ms**（直接命中）；用显示名 → 回退索引 **37.2ms**（231 项、构建 31ms）。绝对值不大，但验收标准 **T-F8 明文禁止**：

> **T-F8** | `state.notified[].project` 被改成显示名（破坏 `resolveTranscriptPath` 的直接命中）

**雷二：可追溯率分母静默缩小。** `traceability()` 的正则：

```js
/^(\S+) \[INFO\] notified (\w+) \S* ?(?:kind=\S+ )?key=(\w+) session=(\S+)$/
```

`\S*` 吃标签位——**标签里带空格就整行匹配不上**。实测把 3 行（1 行 slug、2 行含空格的中文名）喂进去：

```
物理行数 = 3
traceability total = 1    ← 分母
```

**丢了两条，指标静默变好。** 而 10 个真实 `name` 里 **4 个含 ASCII 空格**（`<project-E>`、`<project-B>`、`<project-C>`、`<project-L>`）——**修标题会让这个坑大面积恶化**。

### C5. 「六处」不够——实际 12 处

生产侧 6 处（方案列的六处）+ 消费侧 6 处。方案**完全没提**的：

| 位置 | 后果 |
|---|---|
| `watch.mjs:1704` `notified ${c.project}` | 写进 `watch.log`，`traceability()` 解析它。带空格 → 分母缩小（C4 已实测） |
| `watch.mjs:1667` → `state.notified[].project` → `buildInbox`(`:2205`) → `formatInbox`(`:2243`) | **收件箱给调度 Agent 读**。标签错会让主线程去错的项目里找人。这条最难察觉，因为它不弹窗 |
| `oversight-tui.mjs:660` `base.split(/[\/]/)` | 反斜杠切不开，**完整路径原样进 TUI**（实测 `<project-I-slug>` → 整条路径） |
| `scan-sessions.mjs:726` `noun(r.project)` | 手动排查时最先看的表格 |
| `asked.mjs:547` `## ${it.project}` | 历史报告正文 |
| `verify-claims.mjs:1132/1139/1149` | CLI 输出 |

方案说"六处共用"，实际只覆盖生产侧；**C3/C4 会把 slug 原样带进日志、收件箱和 TUI**。

---

## 4. 攻击 D：方案没考虑到的

### 4.1 更根本的解法：让 L-mid 离开关键路径，而不是把派发往前挪

这是我在 §2.2 里算出来的直接推论。**提前派发只对"L-mid 轮开始前那 15 秒内出现的 waiting"有效（约 5% 样本）。** 真正能让 M1 的分布主体从"0–15s + 11.6% 的 32–62s 长尾"变成"稳定 < 1s"的，只有一件事：

**把 L-mid（`scan-sessions` + `asked.mjs`，合计 ~31s）移出派发循环** —— 独立进程、独立节奏，主循环只保留 `probeJobs` + `probeWaiting` + `dispatch`（合计 ~25ms）。

这样做之后：
- 主循环周期稳定在 15s + 25ms，L-mid 不再插入任何延迟。
- 代价：`asked.mjs` 的 22.9s 是**全量读 1.64GB / 231 个 transcript**，独立进程仍然要跑，只是不挡派发。
- 这一步**不违反 V2**（"每 tick 仍必须读 `sessions/*.json`" 仍成立，`JOBS_INTERVAL` 不变）。

**方案 A 与它的区别**：方案 A 是在**同一条阻塞链**上调整顺序，根本解法是**拆链**。

### 4.2 事件驱动：技术可行，但被规则卡住，且不能单独用

实测 `fs.watch`：

```
监听 `<用户目录>/.claude/sessions` 12 秒 → 0 事件（这段时间确实没有状态变化）
临时目录模拟宿主 tmp+rename 原子重写 → 收到 rename / change / rename / change / rename
```

**技术上能工作**（宿主的写入形态未知，但原子替换和直接写都能收到事件）。但：

1. **验收标准 V2 明文**：「每 tick 仍必须读 `sessions/*.json`（测试断言 `probeWaiting` 被调用）」。事件驱动**只能叠加在轮询之上**，不能替代。
2. **Windows `fs.watch` 的已知不可靠性**：目录被删/重建、缓冲区溢出会静默丢事件。对一个"漏一条就等于失效"的系统，这是需要独立验证的风险。
3. **它不解决识别延迟的下界**：即使 0 延迟知道状态变了，通道仍要 4.2s。

**为什么现在不用**：因为现在的架构是"单线程 + 分层轮询"，加 `fs.watch` 需要引入并发/去抖/重连，是一个独立的可靠性工程。**但它是唯一能把 M1 压到 < 100ms 的路**，值得作为 P1 而不是"将来"。

### 4.3 一个更简单、且被方案漏掉的即时收益

**发送前最后一刻才渲染 title/body**——方案 B 已经接近这个（`projectLabel` 在 `notifyTitle`/`describe` 时调用），但没有做**最后一刻回读**。

更根本的做法：`dispatchCandidates` 里 `await notifier({ title, body })` 之前，**现算** title/body，并且**只回读这一个 session**（4.82ms/10 个文件 → 单个 < 1ms）。这样：
- 标题一定用最新的 `name`（用户刚改的名字立刻生效）。
- 回读只针对一个 session，比 `readLiveSessionStates` 全量读便宜。

**但这解决不了 A3** ——因为回读的 `status` 字段本身就滞后。

### 4.4 不修的实际危害

**通知量基线**（生产日志，全部历史）：

```
2026-10-31: 1 条
2026-11-02: 3 条
2026-11-08: 7 条
合计 11 条 / 5 个有 tick 的日子 ≈ 2.2 条/天
```

**标题问题**：今天 7 条里，标签是 slug 的 **3 条（43%）**，是短名/basename 的 4 条。**每天都会遇到**，而且**每一条 slug 都是 30–64 字符，Windows Toast 标题会被截断或撑爆**。

**延迟问题**：今天 7 条里 M1 > 20s 的 **6 条**，但真正"落地时用户已经答完"的只有 **1 条（21:01）**：

```
2026-11-08T20:58:29Z  AskUserQuestion
2026-11-08T21:00:54Z  用户回答
2026-11-08T21:01:27Z  Toast 落地  ← 迟到 33.7s，落地时是假警报
```

其余 5 条虽然 M1 很大（44s / 42s / 907s / 972s / 5359s），但用户**当时确实还在等**——迟到，但不假。

**所以**：
- **标题**：每天 1–3 次，纯粹难看/难以分辨，**每次都在**。
- **假警报**：一周 1–3 次（按今天的比例，7 条里 1 条 → 约 2.2 条/天 × 14% ≈ 0.3 次/天 ≈ 2 次/周）。
- **真正的风险不在这两个数字，在于 A2**：如果按 A1 的修法给 sessions 源补指纹，**重复通知会从"每天 0 次"变成"每次等待 2 条"** —— 那是比迟到更糟的退化，因为它直接消耗信任。

---

## 5. 我的建议（按优先级）

| # | 建议 | 理由 | 代价 |
|---|---|---|---|
| **R-1** | **先确认目标是"不迟到"还是"不重复"** | 这两个目标当前互相冲突：补指纹修好了 A1，但打开 A2。必须先声明取舍 | 0（决策） |
| **R-2** | **去重键按 `sessionId + state + reasonClass + statusUpdatedAt` 派生，两条路径都产** | 一次等待 = 一个 `statusUpdatedAt` = 一个键。这才是"同一次等待只通知一次"的正解 | 改 `probeWaiting` + `candidatesFromScan`，2 处 |
| **R-3** | **L-mid 拆成独立进程** | 这是唯一能把 M1 的主体压下来的结构性改动（§4.1） | 新增进程 + 状态交换，较大 |
| **R-4** | **新增独立标签字段，`project` 保持 slug 语义** | 同时避开 T-F8 与可追溯率分母 | 小（加字段） |
| **R-5** | **标签用 `displayWidth` 截断，且优先 `name`；`notified` 日志行标签位把空白换成 `·`** | 直接满足 R4/R5 与 T-F3/T-F7 | 小 |
| **R-6** | **回读只用于"证明状态真的变了"，不用于"证明状态没变"** | `status` 字段会滞后 115 分钟（A3）；用它做正面证据是安全的，做负面证据不安全 | 小（改判据方向） |

**R-6 是本次红队最反直觉的一条**：方案的 P0-2 用 `status === 'waiting'` 作为"该发"的正面证据——这恰好是 `status` 字段最不可靠的用法。反过来用（`status !== 'waiting'` → 不发）是安全的，因为它只会让**更多**通知被抑制；用它作为"该发"的依据，等于把一条 115 分钟前的状态当成"此刻在等你"。

---

## 6. 复现记录

全部只读；脚本在 `.tmp-rt2/`（未提交）。

```bash
# 1. 真实生产文件必须用 WMI 起的非虚拟化进程读（MSIX 会重定向到影子副本）
#    完整做法见 docs/research/2026-11-04-watcher-silent-failure.md 实验 2：
#    Invoke-CimMethod Win32_Process Create → cmd.exe /c <某 bat> → node.exe <某脚本>
# 非虚拟化视角: watch.log 627645B；虚拟化视角: 41857B 且停在 10-31

# 2. A1：用真实 state + 真实 probeWaiting 候选 + 真实 dispatchCandidates
node .tmp-rt2/sim2.mjs
# → 提前派发: sent=0 already=1（发不出去）
# → 补指纹后: sent=1（发得出去）

# 3. A2：两条路径的键
node --input-type=module -e "import {dedupeKey} from './scripts/watch.mjs';
  console.log(dedupeKey('<session-S>-...','WAITING','waiting:input needed',''));           // 771d542c73df3fb3
  console.log(dedupeKey('<session-S>-...','WAITING','waiting:input needed','8205829147')); // 81bf69236a306942"

# 4. B：分段耗时
#   probeWaiting 直接计时 → 7.8ms
#   scanAll() → 22.9s（231 transcript / 1.64GB）
#   通道 wscript→PS→WinRT → 4151 / 4402 / 4412 ms（.tmp-rt2/measure-notify.mjs）

# 5. B3：超限概率（用 11-08 真实 tick 间隔）
#   P(M1>20s) = 10.01%, P(M1>30s) = 6.97%（.tmp-rt2/o/blind2.txt）

# 6. C3：截断碰撞
#   35 个真实 slug → 4 组碰撞，最严重一组 5 个项目共用一个标签

# 7. C4：可追溯率分母
node --input-type=module -e "import {traceability} from './scripts/watch.mjs';
  // 3 行里 2 行带空格 → total=1"
```

**未做的事**：未修改任何源码；未 commit / push；未重启守护进程；未发送真实 Toast（测量通道时用的是同款链路但省掉 `Show()`）。
