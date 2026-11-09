# 通知修复验收标准（预先声明）

> **状态：Declared，先于修复产出。**
> 本文件写于「实施修复」与「红队攻击」两个 Agent 交卷**之前**，依据只有现场事实与当前代码。
> **事后增补标准无效。** 要改，必须在本文件末尾追加带日期的「修订」节（§7），
> 说明改的是哪一条、为什么原标准不可判定、以及改动发出时是否已经看到修复结论。
>
> 依据：`docs/spec/evidence-discipline.md` §8（验收必须对照预先声明的标准）、
> `docs/spec/2026-11-02-autorelay-acceptance.md` §1（证据分级 T0–T4、rule of three）、
> `templates/acceptance-criteria.md`（不得写无法观测的条目）。

## 元信息

```
run_id:            2026-11-04-notify-fix
declared_at:       2026-11-09
declared_by:       oversight-acceptor（V4）
shape:             artifact（本文件本身即交付物）
judged_against:    仅本文件的条目，不接受任何未在此列出的标准
judged_scope:      仅两个缺陷 —— (1) 通知送达延迟，(2) 标题显示目录 slug
```

**本文件回答两个问题：什么算延迟修好了、什么算标题修好了。**
它不回答怎么修。修法是执行 Agent 的域；本文件只负责把「修好」变成可机械检验的条件，
并列出触发即整体否决的情形。

---

## 0. 事实基线（判定前必须先承认这些）

这些都是**写本文件时已经存在**的事实。它们不是推断，也不需要再证。

| # | 事实 | 出处 | 证据级 |
|---|---|---|---|
| F1 | 真实 `watch.log` 里有一条 `notified WAITING … session=<id>`，该会话在 `20:58:29Z` 停在 `AskUserQuestion`，用户 `21:00:54Z` 回答，Toast `21:01:27.846Z` 落地 —— **迟到 33.7 秒** | 现场日志 + transcript | T2 |
| F2 | 同一会话两次通知两个不同标题：`21:39:43 notified WAITING style` 与 `21:58:04 notified WAITING <project-I-slug>` | 现场日志 | T2 |
| F3 | `runTick` 把派发放在**所有层之后**：L-fast → L-mid（增量 scan + asked）→ 最后才 `dispatchCandidates` | `scripts/watch.mjs:1740`–`2005`，`1961` 处 | T1 |
| F4 | 轮内耗时 `p50=32s / p90=45s`，其中一轮 L-mid 跑了 5 个项目的 `scan-sessions`（8.8s）和一次 `asked.mjs`（21.9s） | 现场日志 | T2 |
| F5 | `scan-sessions.mjs:624` 把目录 slug 原样写进 `project`，`watch.mjs:935` 原样透传，`notifyTitle`/`describe` 原样使用 | 代码 | T1 |
| F6 | 时钟粒度 1 秒：`createLogger` 把 ISO 时间截断到秒（`replace(/\.\d{3}Z$/, 'Z')`） | `scripts/watch.mjs:299` | T1 |
| F7 | PowerShell 冷启动 3.3–4.2 秒是**每次发通知都要付**的固定成本，`notify.mjs` 的 `TIMEOUT_MS = 25_000` | `scripts/notify.mjs:12`、`:37` | T1 |
| F8 | 当前轮询粒度：`tickMs = 15_000`、`JOBS_INTERVAL = 15s`、`PROBE_INTERVAL = 5min` | `watch.mjs:57–59`、`:2019` | T1 |
| F9 | 检测端到端**不可能验证「用户看到了」**：Toast 只保证「提交给系统」。`notify.mjs` 自己写明了这一条 | `scripts/notify.mjs:60`、`:160` | T1 |
| F10 | 通知额度一个都不能动：全局 8/24h、单会话 2/24h、全局最小间隔 10min、ASKED 6/24h 且间隔 30min | `watch.mjs:62–68` | T1 |
| F11 | `startWatch` 的循环是「跑完 `runTick` 再 `sleep(tickMs)`」——**实际周期 = 轮内耗时 + 15s**，不是固定 15s。F4 的 32s 是全轮中位数还是仅 L-mid 轮，我核不了（见 §1.2 注解） | `watch.mjs:2035`–`2043` | T1 |

**F1 的 33.7 秒不是「慢」，是「假警报」**：通知到达时用户已经回答了 33 秒，
那条「正在等你」在落地的那一刻就是假的。判定延迟时必须记住这一点：
**可接受延迟的上限，是「状态仍然为真」的窗口，不是「用户还记不记得」的窗口。**

---

## 1. 缺陷一：通知送达延迟 —— 验收标准

### 1.1 三个指标（分开测，不许混成一个「平均延迟」）

| 指标 | 起点 | 终点 | 它诊断什么 |
|---|---|---|---|
| **M1 内部延迟** | 宿主写入状态的时刻（`sessions/*.json` 的 `statusUpdatedAt`） | `notifier()` 被调用的时刻 | 调度层是不是又挡住了派发 |
| **M2 通道延迟** | `notifier()` 被调用 | `notify()` 返回（已拿到 PowerShell 回执） | Toast 冷启动 + 回执轮询 |
| **M3 端到端** | 宿主写入状态的时刻 | `notify()` 返回 | 用户实际承受的那一段 |

**M3 ≡ M1 + M2，不是平均值，是逐条相加。**不允许用「平均值相减」得到其中任何一个。

### 1.2 上限（写死，不许改口径）

| 指标 | p50 | p90 | 硬上限 | 依据 |
|---|---|---|---|---|
| **M1** | ≤ 8s | ≤ 14s | **≤ 20s** | 轮询粒度 15s（F8）；状态翻转时刻在一轮内均匀分布 ⇒ 期望等待 ≈ 7.5s；探针本身实测 ms 级（jobs 5–12ms）。**超过 20s 说明这一轮被别的层挡住了**（见下节：L-mid 轮的轮内耗时按 F4 可达 32s）。 |
| **M2** | ≤ 4.5s | ≤ 6s | **≤ 8s** | PowerShell 冷启动 3.3–4.2s（F7），`POLL_MS=50`。给到 6s 是 50% 余量；8s 之后再高说明回执轮询退化了。命中 `TIMEOUT_MS=25s` 的那一条**单独计 FAIL**，不摊进平均值。 |
| **M3** | ≤ 13s | ≤ 18s | **≤ 25s** | M3 逐条相加。p50 取 13s（= M1 的 8s + M2 的 4.5s，向上取整）；硬顶 25s 对应「M1 已达 20s 时 M2 最多 5s」。**缺陷样本 33.7s 在任一档都不通过。** |

**M1 与 M2 的硬上限不能相加当作许可**：两条独立上限只用于**分层诊断**（判断是调度层还是通道层坏了）。
对任何**单条**样本，约束是 M3 ≤ 25s 这一条。M1 = 20s 且 M2 = 8s 的样本 M3 = 28s，**判 FAIL**。

**基线事实 A（先否定一个我一度写错的说法）**：`tickMs = 15s` 与 `JOBS_INTERVAL = 15s` 相等，
但 waiting 探针**不会**隔轮跑。`startWatch` 的顺序是「跑完 `runTick` 再 `sleep(15s)」
（`watch.mjs:2035`–`2043`），而 `state.lastJobsScanAt` 记的是**本轮开始**的时刻
（`watch.mjs:1854`），于是下一轮的 `nowMs − t` = 轮内耗时 + 15s > 15s，`due()` 恒为真。
**结论：每轮都探。**（我先前写「会隔轮跑、M1 会双峰」，读到 `due()` 与 `startWatch` 后作废。）

**基线事实 B（真正的问题）**：周期 = **轮内耗时 + 15s**，不是 15s；
而探针在轮首、派发在轮尾（F3）。于是 M1 完全由两件事决定：

1. 这条 waiting 出现在轮内的哪个位置（轮首之前 / 轮首之后）；
2. 这一轮的 L-mid 是否到期（到期就要多付 8.8s 的 scan + 21.9s 的 asked）。

一条在探针跑完之后才进入 waiting 的会话，要等**下一轮**才被看见 ——
这在 L-mid 重轮上就是 F1 那条 33.7s 的形状。

**F4 的口径我核不了**：`p50=32s / p90=45s` 是「跑的轮」的耗时还是全部轮次的耗时，
取决于那份统计怎么筛样本（我没读它的原始输出；现场 `watch.log` 尾部我读到的是一段
2026-10-31 的**严格 15 秒间隔**记录，那一段轮内耗时接近 0 —— 说明 32s 不是「所有轮」的口径）。
两种口径的后果不同，判定时必须先问清楚：

- 若 32s 是全轮 p50 ⇒ 现状观测周期约 47s，M1 的 p50 应在 40s 上下，F1 的 33.7s 是一条**偏好**的样本。
- 若 32s 只是 L-mid 轮 ⇒ 19/20 的轮次周期仍是 15s，M1 的 p50 在 8s 附近，
  但每 5 分钟有一轮落在 32–45s 的窗口里 —— 那一轮的 waiting 就是 F1 那条样本的形态。

**两种口径下结论相同**：20s 的 M1 硬顶不可能靠调 `tickMs` 达到（tickMs 降到 0，
L-mid 轮仍要付 32s）。它要求结构变化：等待探针与派发在轮内**前移**，
或与耗时的 L-mid 层**脱钩**。这正是该修的东西，所以这条标准不是随手能过的。

若修复把 `tickMs` 从 15s 降到 5s 却没解决轮内耗时，M1 在 L-mid 轮依然 > 30s，**照判未达标**，
且会同时触发 V4（写盘频率翻三倍）。

**另立一条天花板**：M3 出现任一条 **> 30s 即整体否决**，不看样本量、不看分位数。
理由：30s 已经超过「用户回答一条 AskUserQuestion」的常见耗时量级，
再发出去的多半是假警报。这条不受 §1.4 的样本门槛约束 —— 一条就够。

### 1.3 「允许延迟」的三种情形（其余一律不许）

1. **额度/静音抑制**：`canNotify` 返回 `ok:false`。这是**不发**，不是延迟。
   必须带 `suppressedBy=<why>`，并在 `--stats` 里可见。不以任何形式计入 M1/M2/M3。
2. **候选在 `ACTIVE_WINDOW`（24h）之外**：不产生通知。同上，是「不发」。
3. **宿主自身的时刻误差**：`statusUpdatedAt` 落后于真实等待时刻（宿主写盘延迟）。
   这种情况下 M1/M3 会偏高但实现无责，允许同时报一个辅助指标
   **M0 = 通知提交时刻 − 该会话首次被任一 tick 观测到的时刻**。
   **M0 只能作为解释，永远不能替代 M1/M3 的达标判定。**

**明确的「不算例外」清单**（写在这里，防止事后被放宽）：

- L-mid 正在跑长任务（8.8s 的 scan / 21.9s 的 asked）**不是例外**。
  根因就是「发送排在所有层之后」（F3），把它当例外等于承认缺陷没修。
- 「这一轮本来就要跑全量」**不是例外**。
- 「通知通道排队」**不是例外**，M2 有独立预算。
- 「用户当时不在电脑前」**不是例外**，与本指标无关。

### 1.4 样本量（按 `2026-11-02-autorelay-acceptance.md` §1.3 的 rule of three）

| 声称 | 最低样本 | 依据 |
|---|---|---|
| 「延迟已修复」/ 报任何分位数 | **n ≥ 30 条真实 WAITING 通知** | 少于 30 连 p90 的粗估都撑不住 |
| 「p90 ≤ 18s」写成数字 | **n ≥ 60** | n < 60 时只许写「n 次中 m 次 ≤ 18s」，**不许换算成百分位、不许四舍五入到「基本达标」** |
| 「100% ≤ 25s」 | **n ≥ 60 且零违规** | rule of three：零错误下 95% 置信下界 ≈ 1 − 3/60 = 0.95 |
| 「最坏轮次也达标」 | **n ≥ 5 条落在「L-mid 同轮到期」的 tick 上** | 这一条是为 F4 设的。**没有这一条，修完只要挑好样本就能达标** |

样本构成硬要求：

- 跨 **≥3 个项目**、**≥3 个自然日**；同一会话最多占 1/3。
- 必须包含**至少 1 条**由 `scan` 路径产生、**至少 1 条**由 `probeWaiting` 产生、**至少 1 条**由 `asked` 产生的通知 —— 三条路径的候选构造方式不同，只测一条会漏掉另外两条。
- **构造样本（注入临时 `claudeDir` 下的 `sessions/*.json`）不计入 n**，只能用于 §5 的反例对照（T4）。理由：注入样本的 `statusUpdatedAt` 是自己写的，测出来的延迟是自己编的。

### 1.5 测量方法（可复现，不许「感觉快了」）

**前置要求（这是一条验收项，不是建议）**：`notified` 日志行必须携带两个时间戳字段，
且 `session=<id>` 保持行尾、整行可被 `traceability()` 解析（见 §2.7 的机械判据）。

报告格式（新字段放在 `key=` **之前**）：

```
YYYY-MM-DDTHH:MM:SSZ [INFO] notified <STATE> <label> stateAt=<ISO|null> tookMs=<n> kind=<kind|-> key=<16hex> session=<id>
```

- `stateAt` = **候选携带的宿主事件时刻**。WAITING 取 `sessions/*.json` 的 `statusUpdatedAt`（`probeWaiting` 已把它放进候选的 `updatedAt`，`watch.mjs:606`）；ASKED 取问题时间戳（`asked.mjs` 的 `questionTs`）；拿不到就写 `null`，该条**不参与** M1/M3 判定。
- `tookMs` = `notifier()` 到返回的实测毫秒（`notify()` 已经返回 `tookMs`，直接用，不要重算）。
- **`stateAt` 严禁用派发时刻 `nowMs` 填充。**用 now 算延迟恒等于 0 —— 这是本指标唯一的作弊口，见 §3 V5。

**关键细节：`notified` 行是 `await notifier()` **之后**才写的**（`watch.mjs:1691`–`1704`）。
所以日志首列时间戳标的是**通道返回时刻**，不是派发时刻。这意味着：

```
M3 = (日志首列时间戳 + 1s) − stateAt        // +1s 是 F6 秒级截断的保守修正
M1 = M3 − tookMs / 1000                      // 反推派发时刻
M2 = tookMs / 1000
```

**+1s 修正的方向是让指标更严，不是更松**：`createLogger` 把 ISO 时间戳截断到整秒（向过去舍入），
所以原始差值是「至少这么大」，加 1s 得到上界估计。拿未修正的原始差值去比硬上限 = 放宽，判判定无效。

复算方式：写一个 `node` 脚本读 `watch.log`，逐行解析首列时间戳、`stateAt`、`tookMs`，
按上式算三个指标。脚本必须先校验 `stateAt !== 'null'`，否则该行不计入样本。
**不允许用 `lastNotifiedAt` / `state.json` 里的时间戳代替日志首列** —— 那是第二轮持久化，
和「通知提交」不是同一时刻。

规则：

- 提取脚本必须落在 `scripts/` 或 `tasks/runs/<run-id>/`，**附原始 `watch.log` 片段与 `sessions/*.json` 快照**。
  没有 `sessions` 快照的样本，`stateAt` 不可独立核对 → 该样本按 T1 处理，**不计入 n**。
- 原始输出放 `tasks/runs/<run-id>/`（已 gitignore）；本文件与任何可发布文档只放相对路径引用。
- 分位数算法必须写明（例如「最近秩法，n=61 时 p90 取第 55 位」）；换算法要重报全部数字。
- **1 秒粒度的容差**：F6 决定了 `watch.log` 时间戳只有秒精度。判定时 p50/p90 允许 ±1s 容差；
  硬上限（20s / 25s / 30s）**不给容差** —— 差一秒也是差。
- **终端兜底通道的样本不算**：没有 Toast 通道时 `watch.mjs:2471` 换成写 `runner.log` 的 notifier，
  它没有 `tookMs`、也不是用户可见的通道。这类样本一律不计入 n，也不许用来证明「更快了」。
  M2 的样本必须来自真实 `sendNotification`（`notify.mjs:166`）的返回值。

### 1.6 证伪条件（出现任一条即判「没修好」，不需要再看别的）

| # | 条件 |
|---|---|
| **D-F1** | 任一 WAITING 样本 M1 > 20s，或 M3 > 25s |
| **D-F2** | 任一样本 M3 > 30s（单条即否决） |
| **D-F3** | 测量起点用了派发时刻 / `nowMs` / `Date.now()`，而不是 `stateAt` |
| **D-F4** | 报出的样本里**没有**「L-mid 同轮到期」的 tick（说明挑了好样本，或根本没解耦） |
| **D-F5** | 达标路径依赖修改以下任一常量：`GLOBAL_MAX_24H`、`PER_SESSION_MAX_24H`、`GLOBAL_MIN_GAP`、`ASKED_MAX_24H`、`ASKED_MIN_GAP`、`ACTIVE_WINDOW`、`JOBS_INTERVAL`（只能变小，不能变大）、`startWatch` 的默认 `tickMs`（只能变小） |
| **D-F6** | 通知在「宿主已不再是 waiting」之后仍然发出（用户已回答 / 会话已结束），且本 tick 内没有一条 `resolved-before-send` 记录 |
| **D-F7** | 声称达标但样本 n < 30，或 n < 60 却报了百分位数字 |
| **D-F8** | 用「平均延迟」或 M0 代替 M1/M3 |

---

## 2. 缺陷二：标题显示目录 slug —— 验收标准

### 2.1 标签优先级（唯一规则，不允许分支例外）

用户可见的「标签」（Toast 标题里的项目位、正文的项目位、收件箱标题、TUI 项目列）**只能**按下列顺序取值，取到第一个非空即停：

| 序 | 来源 | 判据 | 备注 |
|---|---|---|---|
| **1** | `sessions/*.json` 的 `name` | 存在且净化后非空 | 宿主写的**会话显示名**。本机 10 个活会话 10 个有值，最长 29 显示宽度。`nameSource` 实测多为 `null`、一个为 `"user"` —— 所以它是「宿主认可的显示名」，不是「用户一定亲手命名过」；这不影响优先级，因为它是唯一面向人的字段 |
| **2** | transcript 最后一条带 `cwd` 的记录的 basename | 能取到 | `asked.mjs` 已有 `lastCwd()`（`:296`）。用于会话已经不在 `sessions/` 里的情况 |
| **3** | `sessionId` 前 8 位 | 以上都没有 | 短、丑、**但不说谎**。这是兜底终点 |

**slug 永不出现在用户可见标签位。**判据：标签匹配 `^[A-Za-z]--` 或以 `-` 分段且含 `--` 的目录名 → FAIL。
也不许把 slug「末段」当标签：实测 `…-plugin-<project-C-slug>` 的末段是 `English`，
`…-<project-D-slug>` 的末段是 `heavy`，`…-<project-E-slug>` 的末段是 `Village` ——
**这不是降级显示，是错误信息**，比 `sessionId` 前 8 位更糟。

### 2.2 截断（给具体数字）

| 项 | 规则 |
|---|---|
| 标签长度 | **≤ 24 显示宽度**（`displayWidth`，CJK/全角算 2，不是 `.length`） |
| 截断方式 | 取 23 列 + `…`（`…` 占 1 列），**不得从代理对中间切** |
| 依据 | `oversight-tui.mjs:389` 的 `COL_PROJECT = 24`；`askedCandidates`（`watch.mjs:2355`）有一个 24 的截断但**用的是 `.length`**，对中文会截出 48 显示列 —— 那不是可复用的实现，只是碰巧数字相同 |
| 标题总长 | **≤ 60 显示宽度** |
| 标题里的 `waitingFor` | 也截 24 显示宽度；完整原文留在正文（`relay-protocol.md` §5.1 要求逐字） |
| 正文字段 | 正文保留完整 `needs`（逐字，不摘要）+ `idle=`，不得因为标题变长而丢字段 |

**不许按字符数截断。**一个 12 个码点 / 24 个显示列的中文会话名（实测样本），
按 `.length` 截 24 什么都不会发生，按 24 显示列刚好齐平 —— 两种算法会得出不同结果，
必须选显示宽度那一种。

### 2.3 「六处」到底是多少处 —— 我从代码里数出来的

派发任务里的「六处共用」指的是**生产侧**。我把生产和消费两侧都列出来，共 **12 处**。
（我是否受了任务里那句话的提示，见 §8 覆盖声明里的污染披露。）

**生产侧（把 slug / cwd / name 变成标签的 6 处）**

| # | 位置 | 现状 | 为什么必须在这份清单里 |
|---|---|---|---|
| P1 | `scripts/scan-sessions.mjs:624` | `project: projectDir`（**原始 slug**） | 缺陷的诞生点。`watch.mjs:935` 原样透传 |
| P2 | `scripts/asked.mjs:292` | `project: basename(dirname(filePath))`（**原始 slug**） | 第二个 slug 源头。P5 从它派生 |
| P3 | `scripts/watch.mjs:602` | `cwd.split(/[\\/]/).pop()` 优先，`name` 仅在 cwd 缺失时兜底 | **顺序与 §2.1 相反**：name 被放在兜底位上 |
| P4 | `scripts/watch.mjs:789` | `job.cwd.split(/[\\/]/).pop()`，**完全忽略 `job.name`** | 最容易漏的一处：`jobs/*/state.json` 里**部分**作业有 `name` 字段（实测 `<job-a>/state.json` 有 `name`，另一份没有），代码一次都没读 |
| P5 | `scripts/watch.mjs:2351`–`2356` | slug → 最后一个 `-` 之后 → 截 24 | 产出 `Village` / `heavy` / `English` 这类错误标签 |
| P6 | `scripts/oversight-tui.mjs:660` | `base.split(/[\/]/).pop()` | **正则是 `/[\/]/`，字符类里只有正斜杠**（`\/` 是被转义的 `/`）。Windows 反斜杠路径**整条保留、不被切** —— 实证：`liveToRow({cwd:'<盘符>:\\Web\\style'})` 的 `project` 是整条路径。所以这里有双重问题：既不用 name，又泄露完整路径 |

**消费侧（把标签变成用户可见文本的 6 处）**

| # | 位置 | 呈现给谁 | 备注 |
|---|---|---|---|
| C1 | `watch.mjs:1463` `notifyTitle()` | Toast 标题（Windows 默认只显示标题） | 唯一的「一眼看到」位 |
| C2 | `watch.mjs:1493` `describe()` | Toast 正文 | 与 C1 各自独立拼装同一个字段（F2 的另一半） |
| C3 | `watch.mjs:1704` 的 `notified …` 行 | 人（`watch.log`）+ **机器**（`traceability()` 在 `:2086` 解析它） | 改这一处会碰到生产指标，见 §2.7 |
| C4 | `watch.mjs:1667` → `state.notified[].project` → `buildInbox`(`:2205`) → `formatInbox`(`:2243`) | 收件箱，**给调度 Agent 读** | 标签错误会让主线程去错的项目里找人。这条最难察觉，因为它不弹窗 |
| C5 | `oversight-tui.mjs:156` `projectLabel()`（调用点 `:411` 列表、`:503` 详情、`:1031` 详情标题、`:1129` 纯文本快照） | TUI | F2 里那条 `style` 是 P3（`probeWaiting` 的 cwd basename）算出来的，不是 P6；但走 `liveToRow` 补进来的同一会话会在 TUI 里显示**整条路径**（P6 的 `split(/[\/]/)` 不切反斜杠，已实测）。两处都得改 |
| C6 | `scan-sessions.mjs:726` 的 `noun(r.project)` | `scan-sessions` 自己的表格输出 | 手动排查时最先看的东西 |

**判据**：修复必须让 **P1–P6 与 C1–C4 全部**经由单一取标签函数（单一真源）。
只改「六处」＝只改生产侧，C3/C4 会把 slug 原样带进日志与收件箱；只改 C1/C2 ＝标题好了、TUI 与收件箱照旧。

**例外（允许显示完整路径的唯一位置）**：`oversight-tui.mjs:504` 的「目录」行。
它是排查用的显式字段，允许显示 `cwd` 原文；但必须 (a) 仍然净化控制字符，(b) 不出现在 Toast / 正文 / 收件箱里。

### 2.4 `project` 字段的语义不许被改

`project` 现在是**机器标识**，不是显示名：`resolveTranscriptPath()`（`watch.mjs:1136`–`1139`）
把它当路径前缀用（`join(root, projectHint, sessionId + '.jsonl')`）。
**把 `project` 改成显示名会让这条直接命中的快路径失效，退化成全目录索引（60s 缓存），
并且让 `state.notified.project` 的历史值（slug）与新值（显示名）不可比。**

正确形态：**新增独立字段承载标签；`project` 保持 slug / 目录语义。**
判据：`state.notified` 新条目里 `project` 仍匹配原 slug 形态，且新增了标签字段；
`resolveTranscriptPath` 的直接命中分支仍有测试覆盖。

### 2.5 什么时候可以显示 slug —— 我的答案

**只有一处：不可发布的本机调试输出。**具体是 `--json` 的 `project` 字段、
`watch.log` 里非标签位的机器字段、`tasks/runs/` 下的原始台账。
理由是这些位置的读者是脚本或排查者，slug 是**身份**，不是标签。

**用户可见位置一律不许出现 slug**，包括：Toast 标题、Toast 正文、收件箱（`formatInbox`）、
TUI 项目列、`scan-sessions` 的人类可读表格、以及任何写进 `docs/` 的截图。

### 2.6 同一会话同一个标签（F2 的直接对应）

同一 `sessionId` 在**同一 tick 内**产生的所有候选，标签必须**逐字符相同**。
判据：

- `notifyTitle(c)` 与 `describe(c)` 的标签实参是同一个值（不是各算一遍）。
- 同一会话被 `probeWaiting` 与 `candidatesFromScan` 各报一次时，只发**一条**通知，
  且这条的标签等于 §2.1 规则算出来的值。
  （现状下两者产生**不同的去重键**，于是同一次等待能发两条 —— 这是 F2 的结构原因。）

  **已实测复现（写本文件时跑的，不是推断）**：同一次等待、同一个 `sessionId` 与 `reason`，
  `probeWaiting` 候选的 `dedupeKey` = `3679ed23e2930d88`、`candidatesFromScan` 候选的
  `58df0c46ff5f945e` —— **不相等**，因为后者的 `evidenceFingerprint` 由 `lastActivity`
  的数字位派生、前者为空（`watch.mjs:945` vs `:597`）。

  **F2 那两条日志（相隔 18 分钟、同一会话、两个标题）的完整机制**：
  同一 tick 内两条候选都会进 `state.notified`，但第二条被 `GLOBAL_MIN_GAP = 10min` 挡下
  （`canNotify` 的 `global-10min`，`watch.mjs:504`–`507`）；
  **10 分钟之后的那一 tick**，第二条的键仍未发过，于是照常发出，带着 slug 标题。
  于是同一次等待、两个标题、相隔 18 分钟。
  这解释了「为什么不是两条紧接着弹」——是额度把重复拆到了两个时间点，不是有两条独立的等待。
  注意：修标题（统一标签）能让两条标题一致，但**不会**消掉重复发送本身；
  去重键的统一是另一件事。本文件只要求「同一 tick 内只发一条」（R7/R8），
  跨 tick 的重复发送不在此次修复范围内 —— 但它必须登记进 `tasks/dev-findings.md`。

### 2.7 不许静默缩小可追溯率的分母

`traceability()` 的正则（`watch.mjs:2086`）：

```
/^(\S+) \[INFO\] notified (\w+) \S* ?(?:kind=\S+ )?key=(\w+) session=(\S+)$/
```

它用 `\S*` 吃标签位 —— **标签里带空格就整行匹配不上，该条从分母里消失，指标静默变好**。
这个坑现在就已经存在（`cwd` basename 含空格的 waiting 会话，例如
`…/Server plugin/<某项目>` 的 basename 就带空格），修复标题会让它大面积恶化
（本机 10 个活会话名里 **4 个**含 ASCII 空格，且这 4 个恰好是宽度最大的那几个）。

**硬要求（二选一，都必须有测试锁定）**：

1. 日志标签位**不含空白**（把空白替换成 `·`），整行继续被现有正则解析；或
2. 同步更新该正则，并加一条「用新行格式断言 `total` 等于行数」的测试。

**机械判据**：把一份**旧格式**日志（含带空格标签的行）与一份**新格式**日志
（同样条数、同样会话）分别喂给 `traceability()`，两次 `total` 必须相等且等于行数。
样本放 `tasks/runs/<run-id>/`。

### 2.8 证伪条件

| # | 条件 |
|---|---|
| **T-F1** | 任一用户可见标签位出现 slug（`^[A-Za-z]--` 或含 `--` 的目录名） |
| **T-F2** | 同一 `sessionId` 在同一 tick 内出现两个不同标签 |
| **T-F3** | 标签显示宽度 > 24，或按 `.length` 截断把中文/代理对切坏 |
| **T-F4** | `sessions/*.json` 里有 `name`，标签却不是该 `name`（截断后）—— 用基准快照逐条比对 |
| **T-F5** | 标题或正文出现盘符 / 完整路径（`^[A-Za-z]:[\\/]`） |
| **T-F6** | 标签为空串（`notify.mjs` 会抛 `TypeError`，等于不发），或标题总长 > 60 显示宽度 |
| **T-F7** | `traceability()` 对同一批日志的 `total` 比修复前少 |
| **T-F8** | `state.notified[].project` 被改成显示名（破坏 `resolveTranscriptPath` 的直接命中） |
| **T-F9** | 为了让标签「统一」而把 `name` 覆盖成 slug 或固定串（例如一律用 `OmniSight`） |

**关于历史条目**：`NOTIFIED_TTL_HOURS = 24`，所以修复后 24 小时内收件箱仍可能出现修复前写入的 slug 条目。
**这不判未修复**，但也不得作为任何达标证据：这些条目一律不计入 §3 的反例结论，
且不得出现在任何截图里充当「修复后效果」。

---

## 3. 全局否决项（任一触发，整体不通过）

「整体不通过」是门，不是扣分。触发后两个缺陷都不得被描述为「已修复」。

| # | 否决项 | 机械判据 |
|---|---|---|
| **V1** | **为了降延迟跳过安全检查** | 出现下列任一即触发：① L-fast 派发路径绕过 `canNotify`；② 绕过 `dedupeKey` 或 `state.notified` 边沿登记；③ 去掉 `UNCLASSIFIABLE` 的 300s 时间门（`tooRecentToNotify`）；④ 跳过「发送前不重试」契约（AC5）。判据：`watch.test.mjs` 里对应用例必须仍在且通过；`git diff` 中不得删除对 `canNotify` / `dedupeKey` / `tooRecentToNotify` 的调用 |
| **V2** | **为了降延迟降低扫描频率** | `JOBS_INTERVAL` 与 `startWatch` 默认 `tickMs` **只能变小不能变大**；`PROBE_INTERVAL` 不得变大；每 tick 仍必须读 `sessions/*.json`（测试断言 `probeWaiting` 被调用）。把 waiting 探针并回 5 分钟一层 = 直接触发 |
| **V3** | **标题兜底引入新的信息泄露** | 用户可见位出现盘符或完整路径（`^[A-Za-z]:[\\/]`）；或 `state.notified.project` 存进完整 `cwd`；或复用 `liveToRow` 的 `split(/[\/]/)`（它不切反斜杠，等于把整条路径原样留下） |
| **V4** | **修复引入新的写盘竞争** | 每 tick `saveState` 调用次数 > 1；在 tick 之外修改 `state.json`；新增第二个写入者；缩短 `tickMs` 后未说明写盘频率（`tickMs=5s` ⇒ 每天 17,280 次 `rename`，必须给出 EPERM 风险说明与实测）。判据：`saveState` 调用点计数 + 一次「两个实例同时跑」的负向测试 |
| **V5** | **用派发时刻冒充状态时刻** | `stateAt` 等于 `nowMs`／`Date.now()`；或缺 `stateAt` 却仍计入 M1/M3。这是本指标唯一的作弊口：用 now 算延迟恒为 0 |
| **V6** | **并发派发把通道拖死** | 改成「先发后扫」后，`notify()` 的 3.3–25s 若同步阻塞 tick，会让**同一 tick 内第 2 条**通知的 M1 超标。额度把每 tick 的条数压得很低：`GLOBAL_MIN_GAP=10min` 卡住非 ASKED 的第 2 条，`ASKED_MIN_GAP=30min` 卡住 ASKED —— 但**两个不同会话的「1 条 WAITING + 1 条 ASKED」是可以在同一 tick 发出的**（各占独立额度）。判据：构造这个组合（两个**不同** sessionId），第 2 条的 M3 仍须 ≤ 25s。若达不到，必须说明并降级 —— 例如把 `TIMEOUT_MS` 收紧到 ≤ 8s，但那要单独给实测，且不得因此把失败判成成功 |
| **V7** | **用单条样本或构造样本冒充分布** | 注入 `sessions/*.json` 造出来的样本计入 n；或用 n=1 的「跑一次很快」声称达标（`2026-11-02-autorelay-acceptance.md` §2.6 X2：N=1 = `UNPROVEN`，无例外） |
| **V8** | **只测快路径** | 样本里没有一条落在「L-mid 同轮到期」的 tick；或所有样本都来自同一会话/同一天 |
| **V9** | **改 `state` 语义来回避标题问题** | 把 `WAITING` 换成别的 state / 别的文案来「解决」标题或延迟。`NOTIFY_STATES`、`HOST_FACT_STATES` 的成员与语义一个都不许动 |
| **V10** | **事后放宽本文件** | 修改本文件正文而不追加 §7 的修订节；或修订节声称「事前已写」但内容引用了修复后才存在的证据 |
| **V11** | **只修 12 处里的一部分却声称全修** | 12 处（§2.3 的 P1–P6、C1–C4，另加 C5/C6 若声称全链路统一）中任一仍直接把 slug 送到用户可见位。判据：逐处 `file:line` 引用修复后的代码，附一条 grep 结果 |

---

## 4. 必测反例清单（12 个，修复后逐个注入并留对照记录）

每条都必须有：注入方式（脚本/夹具/临时 `claudeDir`）、期望动作、实际动作、证据文件路径。
记录放 `tasks/runs/<run-id>/`。

| # | 场景 | 正确行为 | 禁止行为 | 可观测判据 |
|---|---|---|---|---|
| **R1** | 会话在 `scan-sessions` 跑到一半时进入 waiting | 本轮结束时已发出，或下一 tick 立即发出；延迟仍满足 M1 | 因为 scan 结果里该会话还是旧状态，就把刚探到的 WAITING 抑制掉 | `notified WAITING` 行存在；M1 ≤ 20s |
| **R2** | 通知发出**前一瞬间**用户已回答（`status` 从 `waiting` 变 `busy`） | 发送前回读 live 状态，发现已变化 → **抑制**，记 `resolved-before-send` | 照发一条「正在等你」 —— 这正是 33.7s 迟到造成的假警报 | 该 tick 0 条 WAITING 通知 + 1 条 `suppressed why=resolved-before-send` |
| **R3** | `sessions/*.json` 里 `name` 为空串或字段缺失 | 退到 cwd basename；仍取不到则退 `sessionId[0:8]` | 用 slug；或标签为空导致 `sendNotification` 抛错 | 标签非空、非 slug、宽度 ≤ 24 |
| **R4** | `name` 超长（50 个 ASCII 字符） | 截到 24 显示宽度 + `…` | 原样发（撑爆标题）；按 `.length` 切；切出半个代理对 | 标签 `displayWidth ≤ 24`；末字符是 `…` |
| **R5** | `name` 含空格与中文（`<含空格的中文会话名>`） | Toast 标题原样带空格；`notified` 日志行仍能被 `traceability()` 解析 | 日志行断成两截 / 该条从分母里消失 | `traceability().total` 等于日志行数 |
| **R6** | `name` 含控制字符或 ANSI/OSC 序列（如 `\x1b]52;c;<base64>\x07`） | 净化后再进 Toast XML 与日志 | 破坏 XML（整条发不出）；或日志被换行符切断 | 通知成功提交；日志行数 = 通知条数 |
| **R7** | 同一会话同一 tick 内既有 WAITING（`probeWaiting`）又有 ASKED（`asked.mjs`） | **只发一条**：宿主事实 WAITING 优先；ASKED 只进观察日志 | 两条都发（用户收到两条说同一件事） | 该 sessionId 该 tick 的 `notified` 行数 = 1 |
| **R8** | 同一会话被 `probeWaiting` 与增量 `scan` 各报一次 WAITING | 收敛为一条 | 两条不同标签 —— F2 的直接复现 | 该 sessionId 该 tick 的标签只有一个值 |
| **R9** | waiting 后 2 秒用户就回答，且本轮正好是 L-mid 同轮到期 | M1 仍 ≤ 20s；或 R2 的抑制生效 | 延迟被 L-mid 推到 30s+ | 该 tick 的 `tick … probe … asked` 与 `notified` 同时出现，且 M1 达标 |
| **R10** | 通知通道失败（PowerShell 写 `result.ok=false` 或超时 25s） | 记 `delivery:'failed'`、**不重试**、不阻塞后续派发与下一 tick | 重试；或同步阻塞到下一 tick 被拖垮 | 该条失败 1 次；下一 tick 的 `tick` 行按时出现 |
| **R11** | `statusUpdatedAt` 缺失或为 0 | 不产生候选（现状已如此，必须保持） | 用 `now()` 兜底当状态时刻 —— 延迟会算成 0，指标瞬间「完美」 | 该会话 0 条通知；且无 `stateAt` 为 now 的行 |
| **R12** | `cwd` 含空格与多层目录（如 `<盘符>:\\<含空格的目录>\\<项目>`） | 标签取 `name`（若在 `sessions/` 里），否则取 basename 并截断；任何位置都不出现完整路径 | 复用 `liveToRow` 的 `split(/[\/]/)`，把整条路径留在 `project` 里 | 标签不含 `\\` 与盘符；`displayWidth ≤ 24` |

**R2 是本清单里唯一「允许不发」的条目，也是最重要的一条**：
修复延迟缺陷的最终目的不是「更快地弹窗」，而是**不再弹出一条已经过期的警报**。
若实现选择不做发送前回读，则 R2 判未解决，且必须在 `tasks/dev-findings.md` 登记为已知偏差。

---

## 5. 第三方复算清单（判定前必须逐条跑）

```
1. node scripts/check-structure.mjs                     → 必须全绿
   （注意：判定时它本来就有 1 项历史违规——docs/design/README.md 未索引
     2026-11-04-next-phase-plan.md，见 §8。修复提交必须让这一项消失或明确分账：
     哪些违规是本次引入的、哪些是既有的。既有的不许当作本次失败，也不许顺手改掉
     掩盖问题。本次修复只要碰了源码，就必须同时遵守 CHANGELOG 硬规则。）
2. node --test scripts/*.test.mjs                       → 必须全绿（当前基线 497 条）
   计数只许上升，不许下降；被删除的用例必须在 diff 里逐条列出理由
3. 取修复后的 watch.log + sessions 快照，按 §1.5 复算 M1/M2/M3，报 n 与逐条原始值
4. 逐条核 §1.4 的样本构成（项目数 / 天数 / 三条来源路径 / L-mid 同轮 tick 数）
5. 逐条核 §2.3 的 12 处：每处给出修复后的 file:line 与一行 grep 结果
6. 按 §2.1 优先级造 4 个标签用例（name 有 / name 空 / 无 sessions 记录 / 全无），逐条比对
7. 跑 §4 的 12 个反例，每个都要有注入脚本与「期望 vs 实际」对照
8. 核 §3 的 V1–V11：逐条给「未触发」的证据，不是「没看到」
9. 核 §2.7：旧格式日志与新格式日志的 traceability().total 相等
10. 核 §2.4：state.notified 新条目的 project 仍是 slug；resolveTranscriptPath 直接命中仍有测试
11. git diff 逐行看：常量（§1.2 的 D-F5 清单）、notify.mjs 的 TIMEOUT_MS、saveState 调用点
    有没有被改动；每处改动都要有对应条目支撑，没有就是 §3 的某一条
```

任一条跑不动（脚本报错、文件不存在、无法执行），**不判通过**。
「没找到反例」不等于「通过」（`evidence-discipline.md` §8）。

---

## 6. 我的角色边界

| 能做 | 不能做 |
|---|---|
| 判每条标准「达标 / 未达标 / 不可判定」，逐条给证据引用 | 替执行 Agent 决定用哪种修法（解耦 / 缩短 tick / 并发派发，都是它的域） |
| 一票否决：§3 任一项触发即整体不通过 | 批准「先上线再说」或「观察一段时间再看」 |
| 否决「用构造样本冒充现场样本」「用平均掩盖最坏」 | 修改被验收的代码或已产出的证据 |
| 判定某条标准本身不可判定，并在覆盖声明里写明，同时给出能给的判定 | 事后加严或放宽标准（只能走 §7） |
| 接受「如实报未达标」为合法结论 | 接受「作者解释了为什么做不到」为「做到了」 |

---

## 7. 修订规则

```
格式：在本节下方追加
  ### 修订 <n>：<日期>
  - 改哪一条：
  - 为什么原标准不可判定：
  - 修订发出时是否已看到修复结论：是 / 否
  - 若「是」：本条修订只对之后产生的证据生效，之前的证据按旧标准判定
```

**没有修订记录的标准变更 = 无效判定。**

### 修订 1：2026-11-09（脱敏，不改判定）

- 改哪一条：§2.1 的示例 slug、§2.2 的中文样本名、§4 的 R5 / R12 示例、§8 的两处实测引用。
- 为什么原标准不可判定：不是不可判定，而是这些示例里含本机真实项目名与目录名，**不能随仓库公开发布**。
  改的是示例的**取值**，判定规则、阈值、否决项、反例的期望行为一个字未动。
- 修订发出时是否已看到修复结论：否（此次改动发生在分拣阶段，早于本文件的判定执行）。
- 因此：本文件对修复的判定效力不变；凡引用示例取值的地方，一律读作「同类样本」，不读作特定项目。

---

## 8. 覆盖声明

- **我读了哪些文件（含行段）**：`scripts/watch.mjs`（`runTick` 1740–2005、`canNotify` 473–509、
  `recordSent` 511–526、`probeWaiting` 575–617、`probeJobs` 780–811、`candidatesFromScan` 925–951、
  `notifyTitle` 1463–1491、`describe` 1493–1508、`dispatchCandidates` 1526–1726、
  `resolveTranscriptPath` 1133–1155、`traceability` 2067–2130、`buildInbox` 2166–2227、
  `formatInbox` 2231–2254、`healthCheck` 2269–2325、`askedCandidates` 2334–2367、
  `createLogger` 266–319、`saveState` 400–434、`startWatch` 2013–2046、常量 45–107）；
  `scripts/notify.mjs`（全文）；`scripts/scan-sessions.mjs`（`readLiveSessions` 465–500、
  主循环 570–700、`printHuman` 700–740）；`scripts/asked.mjs`（`inspectTranscript` 260–300、
  `lastCwd` 296、阈值 53/61/122）；`scripts/oversight-tui.mjs`（`sanitize` 69–80、
  `projectLabel` 156–160、`COL_PROJECT` 389、`listRow` 395–430、`detailLines` 495–510、
  `liveToRow` 654–695、`mergeLiveSessions` 699–712）；`docs/spec/2026-11-02-autorelay-acceptance.md`
  （§1 全文、§2.6、§3、§7）；`docs/spec/evidence-discipline.md`、`docs/spec/relay-protocol.md` §1–§4、
  `templates/acceptance-criteria.md`、`CLAUDE.md`、`scripts/check-structure.mjs`（路径门与文档索引门）。
- **我做了什么检查**：跑了一次 `node --test scripts/*.test.mjs`（**497 条全绿**，这是回归基线）；
  跑了一次 `node scripts/check-structure.mjs`（**当前已有 1 项违规**：`docs/design/README.md` 未索引
  `2026-11-04-next-phase-plan.md` —— 与本次验收无关，但意味着「全绿」这个前提目前不成立，
  验收时必须区分「我引入的」与「本来就有的」）。
  实测了 `liveToRow({cwd:'<盘符>:\\<project-I-dir>', name:'<project-I>'})` 的 `project` 返回值
  （结论：整条路径原样返回，因为源文件里的正则是 `/[\/]/`，只切正斜杠）；
  实测了 `askedCandidates` 对 slug `…-<project-E-slug>` 的产出（结论：`Village`）；
  实测了 `traceability()` 的正则对「标签含空格」的日志行（结论：匹配失败、整行掉出分母）；
  读了两份 `sessions/*.json` 的实际字段（确认 `name` / `nameSource` / `statusUpdatedAt` 存在，
  本机 10 个活会话 10 个有 `name`，最长 29 显示宽度）。
- **我没做什么**：没有读 `docs/research/2026-11-04-*` 任何研究报告的正文；
  没有读任何 `*fix*` 实施报告；没有运行 `scripts/watch.mjs` 的真实轮询（会污染现场 `state.json`）；
  没有修改任何代码或测试；没有跑 `git` 任何写操作。
- **需要主动披露的一处污染（请评审按此判断我的独立性）**：我用 `grep` 搜「六处」这个词时，
  工具的**全局搜索**把 `docs/research/2026-11-04-waiting-notification-diagnosis.md` 的若干
  **行片段**打进了我的上下文（第 1、17、49、173、180、189、314、336、428 行）。
  其中第 428 行逐字列出了该文件自己的六处清单：`scan-sessions` / `candidatesFromScan` /
  `probeWaiting` / `askedCandidates` / `notifyTitle` / `describe`；
  第 17 行含有「这条通知由 scan 路径产生」的因果判断。

  事实层面我必须说清楚：**我看到了那几个名字，然后才去读代码。**
  所以「§2.3 完全独立得出」这句话我不能写。能确认的是：

  - 我的 P1–P6 与该文件的六处**只有部分重合**：P1（scan-sessions）、P2（asked.mjs）、
    P3（probeWaiting）对应；`candidatesFromScan`（`watch.mjs:935`）我当成**透传点**写进了 P1 的
    「为什么必须在这份清单里」，没有单列；`notifyTitle` / `describe` 我归到**消费侧** C1/C2。
  - 该文件**没有**提到 P4（`probeJobs` 忽略 `job.name`）、P6（`liveToRow` 的 `split(/[\/]/)` 不切反斜杠，
    实测会把整条路径留在 `project` 里）、以及 C3（日志行 → `traceability` 分母）、C4（收件箱）——
    这四项是我读代码 + 实测发现的。
  - §1 的延迟标准、§1.2 的 F11、§2.7 的正则缺陷，与该文件无关。

  **结论**：标题优先级规则（§2.1）与延迟的整套指标（§1）不受影响；
  §2.3 的**清单完整性**可能受了提示。若评审要求完全独立，请按 §7 记一条修订，
  由另一位未接触该文件的 Agent 重新数一遍并逐处对照。
- **我无法核实的部分**：Toast 是否真的被用户看到（F9：结构上不可验证，只能到「已提交」）；
  33.7 秒那条样本的 M1/M2 拆分（日志里没有 `stateAt`，无法拆）；
  F4 的 `p50=32s / p90=45s` 是「全轮」还是「L-mid 轮」的口径（没有原始统计输出）；
  修复后的实际延迟（修复还没产出）；`statusUpdatedAt` 的宿主侧写盘延迟分布（n=1，不足以估计）。

---

## 9. 一句话总结（给主线程）

**延迟的判据是「状态仍然为真的窗口」，不是「快不快」：
M1 p90 ≤ 14s / 硬顶 20s，M3 p90 ≤ 18s / 硬顶 25s / 出现任一条 > 30s 即否决；
n ≥ 30 才能报数，n ≥ 60 才能报百分位，且样本必须含 ≥5 条「L-mid 同轮到期」的最坏轮次。**

**标题的判据是「slug 一票否决」：
name > cwd basename > sessionId 前 8 位，24 显示宽度截断，slug 末段连兜底都不算；
用户可见位出现 slug 即 FAIL。**

**最容易被人事后放宽的地方是四处**：
① 把「L-mid 正在跑长任务」写成合法例外（那正是要修的根因，见 §1.3「不算例外」清单）；
② 用 n=1 的「跑一次 3 秒」代替分布，或把注入样本算进 n（§1.4 / V7）；
③ 修完标题后日志标签位带空格，让 `traceability()` 的分母静默变小、指标自己变好（§2.7）；
④ 把「M1 硬顶 20s、M2 硬顶 8s 都满足了」当成 M3 也就满足（28s > 25s，见 §1.2 的不可相加条款）。
