# 宿主的 `status` 字段不可信：`waiting` 的准确率是 12%（按状态翻转事件）／78%（按实际发出的通知）

- 日期：2026-11-09
- 角色：检索 Agent R7
- 产出形态：exploration（量化实测）
- **未修改任何代码、未改 git、未碰任何被监控的文件。**
- 数据来源：`~/.claude/sessions/*.json`（10 个）、`~/.claude/projects/**/*.jsonl`（21 个近 3 天主 transcript + 全部同目录 `subagents/`）、
  `%LOCALAPPDATA%\Overwatch\{watch.log,runner.log,state.json,observations.jsonl}`
- **读取方式（关键）**：`%LOCALAPPDATA%` 下的四个文件全部经 `Win32_Process Create` 起的非虚拟化 `cmd.exe /c copy` 取出再读。
  会话内直接读拿到的是 8 天前的影子快照，见 §6.1。

---

## 0. 结论先行

| # | 问题 | 实测结论 |
|---|---|---|
| 1 | `waiting` 的真实准确率 | **按「宿主翻转状态的事件」算：9/75 = 12.0%。** 按「实际发出的通知」算：账本内 7 条 **5 真**（71.4%），加上日志里两条更早的 **7/9 = 77.8%**。三个数不矛盾：`reason` 与额度门把大量垃圾事件挡在了发送之前，见 §2.3。 |
| 2 | 谁在撒谎 | **不是字段被写坏，是它回答的问题和我们以为的不是同一个。**`requires_action` 的语义是「宿主看起来卡住了」，而不是「有一个权限框在等人点」。证据：`permission prompt` 这一类 **66 个事件里 0 个**有真的待批工具，其中 46 个卡在 agent 自己写的 `sleep 870` 上（§3.2）。 |
| 3 | `busy` 会不会反向撒谎 | **不会。** 4,603 个 `busy` 采样里 0 个存在待答 `AskUserQuestion`；主 transcript 静默超 10 分钟的样本占 21.2%，但同一时刻子 agent 一定在写（两者都静默超 10 分钟：0%）。 |
| 4 | `idle` 呢 | **诚实。** 389 个 `idle` 采样期间 transcript 一次都没增长，100% 一致。 |
| 5 | 有没有别的字段可用 | **没有。** 10 个文件 2,950 次采样里 `updatedAt === statusUpdatedAt` **100%**；二进制里确实有 `state`/`tempo`/`needs` 字段，但这一版桌面端**一次都没写过**（0/10 文件）。 |
| 6 | 推荐替代判据 | **`waitingFor === "input needed"` 单独用**：9/9 = 100% 精确，且 `AskUserQuestion` 事件 81 个里 80 个最终被人回答（98.8%）。**丢掉 `permission prompt` 整条路径**，代价是 0 个真阳性、消灭 100% 的误报。见 §5。 |
| 7 | 历史误报量 | `watch.log` 共 **9 条 `notified WAITING`**，按逐条回放：**7 真 / 2 假 = 77.8%**。其中 2 条假的全部来自同一个 `permission prompt` + `sleep` 会话。 |

**一句话**：`status` 是个「此刻看起来没动静」的瞬时描述，我们把它当成了「它在等你」的事实断言。前者每 5 分钟就会错一次，后者只在真人被 `AskUserQuestion` 挡住时为真。

---

## 1. 全量扫描：当前 10 个会话

采样时刻 `2026-11-09T09:46:36Z`（本地 17:46）。`transcript` 路径按 `projects/<slug>/<sessionId>.jsonl` 用 sessionId 反查得到，10/10 命中，无重复 sessionId。

| 会话名 | `status` | `waitingFor` | `statusAge` | 主 transcript 静默 | 子 agent 静默 |
|---|---|---|---|---|---|
| <project-J-name> | busy | — | 45.2 min | 166 s | 8 s |
| <project-H-name> | busy | — | 88.1 min | 1,897 s | 18 s |
| <project-G> | busy | — | 29.9 min | 122 s | 2,843 s |
| OmniSight | busy | — | 80.0 min | 490 s | 9 s |
| <project-I-name> | busy | — | 78.4 min | 25 s | 2 s |
| <project-B-name> | busy | — | 0.4 min | 603 s | 19 s |
| <project-C-name> | busy | — | 77.2 min | 620 s | 4 s |
| <project-E-name> | busy | — | 82.6 min | 97 s | 1 s |
| <project-K-name> | busy | — | 5.0 min | 2 s | 1 s |
| <project-A> | busy | — | 8.8 min | 308 s | 5 s |

`busy` 出现在 `statusAge = 88 分钟`上不是 bug：这 10 个会话全在跑多 agent 工作流，主线程静默时子 agent 在写盘，宿主把它算作 running 是对的。

同一窗口（08:41:12Z → 09:26:10Z，542 轮 2–3 秒采样）的状态构成直方图：

```
busy=8  waiting=1  idle=1   356 轮
busy=10 waiting=0  idle=0    81 轮
busy=9  waiting=1  idle=0    72 轮
busy=9  waiting=0  idle=1    33 轮
```

并发上限：`busy ≤ 10`、`waiting ≤ 1`、`idle ≤ 1`。542 轮里 `waiting` 从没超过 1 个，且样本中出现的每一次都是同一个会话（<session-T>）——**「同时只有一个会话在等」不是宿主的公平性，是那个会话一直在假 waiting**（§2.4）。

---

## 2. `waiting` 的准确率

### 2.1 判据定义（先说清楚，免得事后编）

对每一个「宿主翻转状态」的事件，取 `statusUpdatedAt`（= 通知时刻 − `idleSec`，可由 `state.json.notified[].firstSeenAt` 与 `idleSec` 精确还原，全部对得上），
然后在**该时刻**重放 transcript 展开的 `tool_use` 集合，问一个问题：**有没有一个 `AskUserQuestion` / `ExitPlanMode` 的 `tool_use` 悬空未解？**

- 有 → `GENUINE`（真的在等人，除了人没人能推进）
- 悬空的是 `sleep`/`Start-Sleep` 的 Bash → `FALSE_SLEEP`（卡在它自己的定时器上）
- 悬空的是别的工具 → `FALSE_TOOL`
- 什么都不悬空 → `FALSE_MIDTURN`（宿主只是觉得它「没在动」）

这个判据不是猜的：`AskUserQuestion` 在 transcript 里一定表现为一条 `assistant/tool_use` + 一条 `user/tool_result`，后者正文是宿主写的 `Your questions have been answered: "…"="…"`。逐字可查（§3.3 有一条完整样本）。

**样本口径说明**：`state.json.notified` 有 73 条去重事件，`observations.jsonl` 有 80 条观察；两者按同一个 `statusUpdatedAt`（±5 s）归并后得到 **75 个事件**。下面一律用 75。

### 2.2 事件级：75 个事件，9 个是真的

窗口：`2026-11-08T19:16:31Z → 2026-11-09T08:57:19Z`（13.4 小时，5 个会话）。

| 判定 | 数量 | 占 |
|---|---|---|
| `GENUINE`（悬空 `AskUserQuestion`） | **9** | **12.0%** |
| `FALSE_SLEEP`（悬空 `sleep` Bash） | 46 | 61.3% |
| `FALSE_TOOL`（悬空其它 Bash） | 3 | 4.0% |
| `FALSE_MIDTURN`（无悬空工具） | 17 | 22.7% |
| 合计 | 75 | 100% |

按会话拆：

| 会话 | 真 | 假 |
|---|---|---|
| <session-W>（<project-E> 单 agent） | 1 | 0 |
| <session-V> | 1 | 0 |
| <session-S>（<project-J>） | 3 | 5 |
| <session-U>（<project-I-name>） | 4 | 0 |
| <session-T>（<project-B-name>） | **0** | **61** |

**`reason` 与真相是完美分离的：**

| `waitingFor` | 事件数 | 真 | 精确率 |
|---|---|---|---|
| `input needed` | 9 | 9 | **100%** |
| `permission prompt` | 66 | 0 | **0%** |

这不是统计相关，是定义性的：宿主只在 `tool_name === AskUserQuestion`（或 `dialog:` 前缀）时写 `input needed`，其余一律写 `permission prompt`（见 §4.1 的 `Cw` 函数）。**`permission prompt` 是个兜底桶，不是「有人要你点批准」。**

**<session-T> 一个会话贡献了 66 个假事件里的 61 个（92%），且它自己的准确率是 0/61。** 这个会话的模式是：派一批后台任务 → 起一个 `sleep 840~900` 的 Bash 轮询 → 期间什么都干不了。宿主管这叫 `waiting/permission prompt`，实质上它在等**它自己派的活儿**，不是在等人。

### 2.3 通知级：7 条实际发出的通知，5 条是真的

`state.json.budget.sentLog` 有 7 个时间戳，与 `notified` 里 `notifyCount > 0` 的 7 条一一对应。

| 发送时刻 (UTC) | 会话 | 发送时 `reason` | 悬空工具 | 判定 | 结果 |
|---|---|---|---|---|---|
| 11-08 19:16:31 | <session-W> | `waiting:input needed` | `AskUserQuestion` | **真** | 用户 105 s 后回答 |
| 11-08 19:31:49 | <session-S> | `waiting:input needed` | `AskUserQuestion` | **真** | 用户 445 s 后回答 |
| 11-08 19:50:33 | <session-T> | `waiting:permission prompt` | `Bash(sleep 840; …)` | **假** | 无人回答；534 s 后自恢复 |
| 11-08 20:03:57 | <session-T> | `waiting:permission prompt` | `Bash(sleep 840; …)` | **假** | 无人回答；354 s 后自恢复 |
| 11-08 21:00:43 | <session-S> | `waiting:input needed` | `AskUserQuestion` | **真** | 用户 10 s 后回答（已知的「迟到 33.7 秒」那条） |
| 11-08 21:39:37 | <session-U> | `waiting:input needed` | `AskUserQuestion` | **真** | 用户 2,322 s 后回答 |
| 11-08 21:57:22 | <session-U> | `waiting:input needed` | `AskUserQuestion` | **真** | 用户 1,258 s 后回答 |

**通知级 5/7 = 71.4% 精确。** 为什么比事件级高这么多：`reason` 是唯一的过滤条件，而 `input needed` 这一类恰好 100% 是真的——5 条 `input needed` 全部真，2 条假全部是 `permission prompt`。

### 2.4 实时采样：428 个 `waiting` 采样，0 个真在等人

两轮实时采样（3 s × 12 min + 2 s × 9 min）共 542 轮、5,420 个会话快照，其中 `waiting` 采样 428 个（全部来自 <session-T>，持续 30.8 分钟的一次事件）：

| 该瞬间 transcript 的悬空工具 | 采样数 | 占 |
|---|---|---|
| 有工具在执行（`Bash`） | 403 | 94.2% |
| 无悬空工具（回合中） | 25 | 5.8% |
| **悬空 `AskUserQuestion`（真在等人）** | **0** | **0%** |

这 30.8 分钟里，transcript 新增 75 条记录、15 条主链工作记录、8 次 `tool_use`、5 段助手文本，其中一次是派新 agent（`09:11:48 Agent`）——**它在干活，状态却写着「在等你」。**

---

## 3. 滞留时间分布

### 3.1 三个不同的「滞留」

| 度量 | 定义 | n | p50 | p90 | max |
|---|---|---|---|---|---|
| **停留时长** | `statusUpdatedAt` → 下一次状态翻转 | 75 | **308 s** | **1,251 s** | **19,641 s（5.5 h）** |
| **恢复滞后** | `statusUpdatedAt` → transcript 里第一条后续工作记录 | 44 | **89 s** | **385 s** | 643 s |
| **滞留尾巴** | 恢复时刻 → 下一次状态翻转（这段全是假的） | 44 | **284 s** | **3,101 s** | **18,998 s（5.3 h）** |

分母口径：75 个事件里，44 个能在观测窗口内找到「恢复」那一条工作记录；其余 31 个要么整个窗口内 agent 都没回来（人在睡觉，那是真的在等），要么状态值一直挂到窗口结束。

按 `reason` 拆停留时长：

- `waiting:input needed`（n=9）：p50 = 734 s，p90 = 5,412 s，max = 5,412 s — 这些**确实该等这么久**（人在睡觉）。
- `waiting:permission prompt`（n=66）：p50 = 308 s，p90 = 1,231 s，max = 19,641 s — 这些**全是滞后**。

### 3.2 最严重的 8 次

| 会话 | `statusUpdatedAt` | agent 恢复 | 状态共停留 | 其中纯滞留 | 类别 |
|---|---|---|---|---|---|
| <session-T> | 11-09 02:58:56 | 03:09:39 (+643 s) | 19,641 s | **18,998 s = 5.3 h** | 无悬空工具 |
| <session-U> | 11-08 20:09:19 | 20:10:58 (+99 s) | 5,412 s | 5,313 s | **真在等人** |
| <session-S> | 11-08 19:31:35 | 19:31:35 (+2 s) | 5,211 s | 4,752 s | **真在等人** |
| <session-T> | 11-08 20:45:29 | 20:52:45 (+435 s) | 4,310 s | 3,874 s | `sleep` 轮询 |
| <session-S> | 11-08 21:25:50 | 21:25:51 (+2 s) | 3,103 s | 3,101 s | 悬空其它 Bash |
| <session-T> | 11-09 08:26:18 | 08:26:31 (+13 s) | 1,854 s | 1,841 s | 无悬空工具 |
| <session-T> | 11-09 02:21:44 | 窗口内没恢复 | 1,297 s | — | 无悬空工具 |
| <session-T> | 11-08 20:03:53 | 20:09:43 (+351 s) | 1,251 s | 900 s | `sleep` 轮询 |

两件事要一起看：

- <session-S> 那两条最刺眼：**状态翻转后 2 秒 agent 就继续干活了，但状态在接下来 86.9 分钟内一直写着 waiting。**
- 但排名第 2、3 的恰恰是**真的在等人**的那两条。**「停留久」不等于「滞留久」**——这两个量必须分开报，混在一起会把最诚实的两条算成最坏的。

### 3.3 用户给的样本，逐字复核

用户的原话是「`<session-T>`：`status=waiting`，`statusUpdatedAt` 停在 22:33:40（115 分钟前），但 transcript 此后新增 328 条记录」。

我按 `timestamp > 2026-11-08T22:33:40Z` 数了该 transcript：截至 `2026-11-09T00:28:00Z` 恰好 **328 条**。118 分钟的窗口里：主链工作记录 104 条。**这条样本完全成立，不是转述误差。**

同一会话，`2026-11-08T22:33:40Z` 这个状态值一直挂到 `2026-11-09T08:26:18Z` 才翻——**持续 9 小时 53 分**，其间 transcript 新增 988 条记录、291 条主链工作。期间唯一一次 `AskUserQuestion` 在 `08:57:12Z`（那是下一次事件）。

### 3.4 总账

按「每个事件的状态从 `statusUpdatedAt` 挂到下一次翻转」累计，5 个会话合计 **18.2 会话·小时**写着 waiting；其中 agent 已经在工作、状态还没翻回来的 **13.8 会话·小时 = 75.8%**。

| 会话 | 真事件 | 假事件 | 标称 waiting | 其中假的 | 假占比 |
|---|---|---|---|---|---|
| <session-W> | 1 | 0 | 0.01 h | 0.00 h | 0% |
| <session-V> | 1 | 0 | 0.00 h | 0.00 h | 0% |
| <session-S> | 3 | 5 | 3.02 h | 2.78 h | 92% |
| <session-U> | 4 | 0 | 1.80 h | 1.48 h | 82% |
| <session-T> | 0 | 61 | 13.39 h | 9.55 h | 71% |

两个需要注意的口径问题，否则这张表会被误读：

1. **<session-W> / <session-V> 的 0.00 h 是窗口边界**：它们的事件在观测窗口开头，下一次翻转在窗口外，所以只计到窗口结束。不是说它们从没真等过——它们各有 1 个真事件，见 §2.2。
2. **<session-U> 的 82% 里包含「真在等人」的滞留**：它在 20:09:19 提了 `AskUserQuestion`，人 99 秒后才答，但状态又挂了 5,313 s 才翻回 `busy`。这一段既是真等待、又是真滞留。**「假事件」和「假时间」不是同一个指标**：事件准确率 12.0% 是无偏的，时间占比 75.8% 会把「真等了很久」也计进去。

### 3.5 「跑完了也没在等」的那一类

**有，占 22.7%（17/75）。** 这 17 个事件在 `statusUpdatedAt` 那一刻 transcript 里**没有任何悬空工具**——回合已经在跑，宿主却报了 waiting。典型案例：<session-T> 在 `08:49:11Z` 起了一个 `sleep 870`，`08:59:14Z` 超时退出后继续跑，状态翻转发生在两次工具之间的空隙里。

还有更极端的一次：`2026-11-09T02:58:56Z` 那条，`status=waiting` 一直挂到 `08:26:18Z`（**5.5 小时**），而 transcript 在这段时间里只有 101 条记录，全挤在 `03:xx` 和 `08:xx` 两个小时——中间是**整机睡眠**。宿主把「机器睡着」也表达成了 `waiting`。

---

## 4. 根本原因

### 4.1 谁写、什么时候写

`status` / `statusUpdatedAt` / `waitingFor` 三个字段全部由 **`claude.exe` 自己写**，位置 `~/.claude/sessions/<pid>.json`。从 2.1.308 二进制（`%LOCALAPPDATA%\Claude-3p\claude-code\2.1.308\<hash>\claude.exe`，249,522,848 字节）读到的完整链路：

```js
// ① SdkSessionState（宿主 SDK 侧的三态）→ 落盘 status 的映射
var BA = { running: "busy", requires_action: "waiting", idle: "idle" };

// ② 订阅 sessionState.stateChanged，只在「status+waitingFor 这个字符串」变化时才写
function Cw(e) {
  let r;
  return (n, s) => {
    let g = BA[n];
    let S = g !== "waiting" ? undefined
          : (s?.tool_name === Vs || s?.tool_name.startsWith("dialog:"))
              ? "input needed" : "permission prompt";
    let h = `${g}\n${S ?? ""}`;
    if (h === r) return;          // ← 关键：没变就不写
    r = h;
    NOe({ status: g, waitingFor: S }, e).then(...);
  };
}

// ③ 真正落盘
async function NOe(e, n) {
  let r = Date.now();
  await fn({ ...e, updatedAt: r, ...(e.status !== undefined && { statusUpdatedAt: r }) }, n);
}
```

（`Vs` 是 `AskUserQuestion` 的工具名常量。`dialog:` 前缀指 MCP elicitation 一类的对话工具。）

另一条路径（desktop/headless 的会话状态机）：

```js
function wye(h) {
  let E = Cio(h);
  if (E !== undefined) return { status: "waiting", waitingFor: E, working: false };
  return { status: h.isLoading || h.delegatedActive ? "busy" : "idle", waitingFor: undefined, working: h.isQueryActive };
}
function Cio(h) {
  if (h.queuedElicitation)          return "input needed";
  if (h.topDialogWaitingFor !== undefined) return h.topDialogWaitingFor;
  if (h.pendingWorkerRequest)       return "worker request";
  if (h.pendingSandboxRequest)      return "sandbox request";
  if (h.isShowingLocalJSXCommand && !h.isResponseStreaming && !h.delegatedActive) return "dialog open";
  return;
}
```

### 4.2 为什么它不跟着实际活动更新

三条独立机制叠在一起：

1. **`requires_action` 的语义不是「有权限框」。** 它是「本轮看起来卡住了」。`Cw` 的映射表把 `requires_action` 一律翻成 `waiting`，只有工具名正好是 `AskUserQuestion`（或 `dialog:` 前缀）时 `waitingFor` 才写 `input needed`，**其余一律叫 `permission prompt`**。所以「permission prompt」根本不是「有人在给你弹框」，它是**兜底桶**。实测把这个兜底桶的内容物全捞出来了：48 次悬空 `Bash`、17 次什么都没悬空。**没有一次是真的权限对话框。**

2. **写盘是「字符串变了才写」。** `if (h === r) return;` —— 一个会话在 `waiting/permission prompt` 上一次 `sleep 840` 超时、再起一个 `sleep 870`，两次翻转之间状态字符串完全没变（都是 `waiting\npermission prompt`），所以**中间那 10 分钟 agent 真的在跑工具，`statusUpdatedAt` 一动不动**。这直接解释了 §3 的 75.8% 假时间。

3. **翻回 `busy` 的时机由宿主的状态机决定，不由 transcript 决定。** 实测「agent 恢复」到「status 变 busy」之间 p50 = 284 s、p90 = 3,101 s、max = 5.3 h。这中间任何读取 `status` 的进程都会看到过期的 `waiting`。

**结论：这个字段的语义是「宿主上一次状态机求值的结果」，不是「现在的实际情况」。它没有失效，是我们误读了它的含义。**

### 4.3 有没有别的字段

**会话 JSON 里没有。** 10 个文件累计出现过的字段只有 20 个：

```
pid, sessionId, cwd, startedAt, procStart, version, peerProtocol, peerFeatures,
kind, entrypoint, hostSessionId, pidDomain, messagingSocketPath, name, nameSince,
updatedAt, status, statusUpdatedAt, nameSource, waitingFor
```

- `updatedAt` 与 `statusUpdatedAt` **2,950/2,950 采样完全相同**，且二进制里两者在同一次调用里赋值。**它不携带任何独立信息**，不能当「最近活动时间」用。（仓库里 `watch.mjs:593` 的 `Number(s.statusUpdatedAt ?? s.updatedAt ?? 0)` 这个 fallback 是无效保险。）
- 二进制里的记录 schema 还有 `state`、`detail`、`tempo`（`"active"|"idle"|"blocked"`）、`needs`、`output` —— **这一版桌面端一个都没写**（0/10 文件）。`tempo: "blocked"` 才是我们真正想要的那个字段，但它不存在。

**唯一的独立真相源是 transcript 本身**（`projects/<slug>/<sessionId>.jsonl`）和它的兄弟目录 `projects/<slug>/<sessionId>/subagents/*.jsonl`。

---

## 5. 推荐的替代判据（每条都带实测可靠性）

### 5.1 判据 A（主判据，直接可上）：`status==='waiting' && waitingFor==='input needed'`

**实测：9/9 = 100% 精确，0 假阳性。**

按 session 拆：<session-W> 1/1、<session-V> 1/1、<session-S> 3/3、<session-U> 4/4。
按发送拆：5 次 `input needed` 通知 **5/5 全真**。

**召回也是够的**：近 3 天 21 个 transcript 里 `AskUserQuestion`/`ExitPlanMode` 的 `tool_use` 共 **81 次**，其中 **80 次（98.8%）** 最终收到 `user/tool_result`（人回答了）。中位等待 168 s，p90 2,562 s，max 10.1 h。反过来查漏：4,603 个 `busy` 采样里 0 个存在悬空 `AskUserQuestion`，389 个 `idle` 采样里 0 个存在悬空工具——**采样窗口内没有一次「人在等但状态没报」的漏报**。

代价：**只覆盖 `AskUserQuestion` 和 `ExitPlanMode`。** 真正的权限对话框（`tool_name` 是 `Bash`/`Write` 且权限模式非 bypass）也会落进 `permission prompt`，这条路会被彻底关掉。在那台机器上这是净收益（测量结果：`permission prompt` 66 个事件里 0 个真），但换一台机器、换一个权限模式就不成立了。**所以这个判据的可靠性绑在「这台机器上所有会话都是 bypass/auto 权限」这个前提上，必须写进验收条件。**

### 5.2 判据 B（否决器，必配）：悬空工具是 `sleep`/`Start-Sleep` 就绝不通知

**实测：46/46 假。** 46 个 `FALSE_SLEEP` 事件的悬空工具全部是形如
`sleep 840; cd … && node _round3_progress.js …` 的自轮询 Bash。

实现成本：读 transcript 尾部，展开 `tool_use`/`tool_result` id 集合，取未闭合项的 `input.command`。

**尾部窗口够用，双向都验过**：1 MB 尾部与全文件扫描的悬空集合逐会话对比，10 个会话**幻影悬空 0 个、漏报 0 个**（4 MB 尾部同样）。`api-request-blob` 记录会重复携带 `tool_use` id（<project-E> 会话 261 个 id 里 65 个重复出现在 blob 中），但因为 id 相同、`Map` 覆盖，不影响结果。

**实现陷阱（我踩了两次，写在这里省下一个人）**：transcript 里有**没有 `timestamp` 字段的记录**（`api-request-blob` 等），而且它们携带 `tool_use`。如果重放时不先 `if (!r.timestamp) continue`，就会把历史上一大批已闭合的工具重新「打开」，得到 300–1100 个假悬空项。第一版脚本就是这样，把「1 MB 尾部漏了 1,086 个悬空项」这种荒谬结论算了出来。**加时间戳守卫之后，全文件与 1 MB 尾部完全一致。**

### 5.3 判据 C（判断「还在不在干活」，用来解读 `busy`）：主 transcript mtime + 子 agent 目录 mtime

**实测：`busy` 本身可信，前提是你把子 agent 算进去。**

| 条件 | 采样占比 |
|---|---|
| `busy` 且主 transcript 静默 > 10 min | 21.2%（425/2,009） |
| `busy` 且主 transcript 与子 agent **同时**静默 > 10 min | **0.0%** |
| `busy` 且同时静默 > 5 min | 0.0%（1/4,603） |

也就是说：**只看主 transcript 会把 21% 的健康会话误判成「卡死」，加上 `projects/<slug>/<sid>/subagents/*.jsonl` 的 mtime 之后，误判降到 0。**

这一步很重要，因为我在第一次分析时就踩了这个坑：只看主 transcript，会得出「<project-H> / <project-E> / OmniSight 三个会话 `busy` 是假的」的结论；查子 agent 目录，它们的子 agent 分别在 5 s / 1 s / 8 s 前写过盘——`busy` 完全正确。

### 5.4 判据 D（补充，不够用）：transcript「静默时长」阈值

**实测：单独用会误报，不能当主判据。**

- 状态翻成 `waiting` 之前，transcript 已经静默多久：p50 = 87 s，p90 = 269 s，max = 348 s（`permission prompt`，n=65）；`input needed` 那一类是 0–209 s。**宿主用的明显是一个「静默 ≈ 1 分钟以上」的软阈值**，不是真实的事件。
- 反过来，长静默不一定是等待：<session-T> 在 `03:09:40Z → 08:26:18Z` 之间**连续 5 小时 17 分钟零记录**（整机睡眠），transcript 里 101 条记录全部集中在 `03:xx` 和 `08:xx` 两个小时里。这段静默既不是「在等你说什么」，也不是「跑完了」。
- 而真正的「等人」静默可以达到 10 小时（`<session-U>` 2,322 s、`<project-G>` 8,641 s、`Overwatch` 86,868 s）。

静默时长无法区分「睡觉 / 等 API / 跑长命令 / 等人」，只能当辅助过滤。

### 5.5 判据 E（补充）：`AskUserQuestion` 在 transcript 里的悬空 `tool_use` id

这是判据 A 的**独立实现**，不依赖宿主字段。精确率与 A 同级（同一判据重放），但能覆盖「`status` 还停在 `busy` 而人已经在被问」的窗口——**实测这个窗口在这台机器上不存在**（0/4,603 `busy` 采样有悬空 `AskUserQuestion`），所以它是保险，不是增益。

### 5.6 汇总表

| 判据 | 成本 | 精确率（实测） | 召回 | 什么时候会骗你 |
|---|---|---|---|---|
| **A. `waitingFor==='input needed'`** | 读 1 个小 JSON | **100%（9/9 事件，5/5 通知）** | 81 个 Ask 事件全覆盖 | 会话跑在非 bypass 权限、真的弹权限框时（这台机器上 0 次） |
| **B. 悬空工具是 sleep → 否决** | 读 1 MB 尾部 | **100%（46/46 假）** | — | 用户真的在批一个 `sleep` 命令 |
| **C. 主 transcript + 子 agent mtime** | stat 1–N 个文件 | 误判 21.2% → **0%** | — | 子 agent 目录被清理 |
| D. 静默阈值 | stat | 差（p50 87 s 就会误报） | 高 | 睡觉、长命令、等 API |
| E. 重放悬空 `AskUserQuestion` | 读 1 MB 尾部 | 100%（同 A） | 同 A | 尾部窗口截断（实测 0 幻影） |

**建议的组合判据（按顺序，任一否决即不发）：**

```
1. status === 'waiting'                       （必要，不充分）
2. waitingFor === 'input needed'              （A：丢掉整个 permission prompt 桶）
3. 尾部重放，存在悬空 tool_use                  （E：证明它真的卡住了）
4. 那个悬空 tool_use 的名字 ∈ {AskUserQuestion, ExitPlanMode}   （A 的独立复核）
5. 若名字是 Bash，其 command 不以 sleep/Start-Sleep 开头      （B：兜底否决）
```

第 3–5 条是在**不信任宿主字段**的情况下重算一遍，成本是每个候选读 1 MB 尾部（10 个 transcript 合计 322 MB，最大 114 MB，1 MB 尾部读在毫秒级）。当前 `watch.mjs` 已经在做第 3 步（`findStopPoint` + `classifyStop`），缺的是把它当作**否决条件**而不是**分类依据**。

### 5.7 不要用的东西

- **`updatedAt`**：与 `statusUpdatedAt` 恒等（2,950/2,950）。拿它当「最近活动时间」会在所有地方退回同一个错值。
- **`ACTIVE_WINDOW = 24h` 这道门**（`watch.mjs:596`）：实测最长滞留 5.5 h，从未接近 24 h。**这道门一次都没起过作用**，它挡不住这里的任何一条误报。
- **`busy` 当「在干活」**：对，但必须带上子 agent。只看主 transcript 会把 21% 的健康会话判死。

---

## 6. 历史回溯

### 6.1 环境陷阱的实证（先记下来，这条本身是发现）

会话内直接 `Get-Content $env:LOCALAPPDATA\Overwatch\watch.log` 读到的是 **41,857 字节、最后一行 `2026-10-31T19:22:58Z`** 的影子快照。
经 `Win32_Process Create` 起的非虚拟化进程复制到容器外再读，同一个文件是 **885,327 字节、最后一行 `2026-11-09T09:02:16Z`**。

**相差 21 倍、8 天。** 影子目录里 `state.json` 43,156 字节、`observations.jsonl` 2,264 字节，真机分别是 43,716 与 26,796 字节。
`launcher.log` 在影子目录里停在 11-01，真机里也只有 11-01——两处都说明这个文件没在写。

推论：**任何在会话内读 `%LOCALAPPDATA%\Overwatch` 得到的结论都必须先验证向量。** 我在本次分析的最初 20 分钟里就是拿的影子快照，当时得到的「`watch.log` 只有 455 行、只发过 2 条通知」是错的。上一份研究（`2026-11-04-redteam-notify-fix.md`）用的是 WMI 路径，结论未受影响。

### 6.2 `notified WAITING` 的总数

**真实 `watch.log` 里共 9 条。** 完整清单：

| # | 时刻 (UTC) | 会话 | 日志里的 kind | 判定 |
|---|---|---|---|---|
| 1 | 10-31 20:49:40 | 50ec242b（Overwatch） | `-` | **真**（悬空 `AskUserQuestion`，161 s 后被回答） |
| 2 | 11-02 11:58:55 | <session-X>（<project-G>） | `-` | **真**（悬空 `AskUserQuestion`，8,641 s 后被回答） |
| 3 | 11-08 19:16:35 | <session-W> | `-` | **真** |
| 4 | 11-08 19:31:57 | <session-S> | `-` | **真** |
| 5 | 11-08 19:50:41 | <session-T> | `-` | **假**（`sleep 840`） |
| 6 | 11-08 20:04:24 | <session-T> | `-` | **假**（`sleep 840`） |
| 7 | 11-08 21:01:28 | <session-S> | `-` | **真** |
| 8 | 11-08 21:39:43 | <session-U> | `-` | **真** |
| 9 | 11-08 21:58:04 | <session-U> | `-` | **真** |

**7 真 / 2 假 = 77.8% 精确。**

时间分布本身是个警告：9 条里有 7 条挤在 `11-08 19:16 – 21:58` 的 **2 小时 42 分钟**内。守护进程只在 5 个时间段活着（`watch 启动` 共 5 次），中间有 **24.1 h / 69.4 h / 77.6 h** 三段完全空档。所以这个 9 条**不是历史全貌，是四个观测窗口的抽样**，不要拿它去估长期误报率。

按这个抽样推算的历史误报量：**2 条**。
如果改用「事件级 12%」去推算，会得到 8 条误报——**这个算法是错的**，必须说清楚为什么：事件级的 12% 是「字段翻转一次有多大概率是真的」，而通知是**经过 `input needed` 理由、全局 10 分钟最小间隔、单会话 2 次/24h、全局 8 次/24h 四道门过滤之后**才发出的。`observations.jsonl` 的 80 条观察记录里，61 条被 `budget-per-session-24h` 挡下、8 条被 `budget-global-10min` 挡下、4 条被 `already-notified` 挡下，只有 7 条成了通知——**正是这个过滤把精确率从 12% 拉到了 78%**。

顺带得到一个可用的数字：`<session-T>` 在过去 13.4 小时里被记下 **62 条观察记录（归并后 61 个事件）**，只有 **2 次**发成了通知。它的额度（单会话 24h ≤ 2）已经打满，这就是为什么那次 5.3 小时的滞留没有变成一次打扰——**额度机制在不经意间承担了准确率兜底**。

### 6.3 日志里其它值得记的数字

- `watch.log` 里 `observed=` 的 tick 共 6,183 条，其中带 `WAITING:` 的 **5,722 条（92.6%）**。也就是说**守护进程几乎每一轮都在看着某个「waiting」会话**。
- `sent>0` 的 tick 只有 **11 次**（9 条 WAITING + 1 条 BLOCKED + 1 次 ASKED 合并轮）。**误报密度 = 2/11 = 18% 的发送轮次。**
- `runner.log` 与 `watch.log` 内容重叠（前者 3,634 行是后者的子集），没有独立信息。

---

## 7. 顺带发现（不在任务范围，但会影响判据选择）

1. **`<session-T>` 的 `sleep 840~900` 轮询是本仓所有误报的最大单一来源。** 24 小时里 48 次。它每次都在 10 分钟 Bash 超时前 1 分钟左右退出，形成周期 8–10 分钟、每次持续 5–10 分钟的假 `waiting`。**修 `status` 的判据，不如先修这个会话的工作方式**；但那是另一个会话的事，此处只记录。
2. **`watch.log` 没有 `.1` 归档。** `watch.mjs` 的轮转逻辑会写 `watch.log.1`，真机目录里没有——说明 885 KB 还没到 1 MB 上限，或者归档被删过。历史只保留了 6 天（10-31、11-01、11-02、11-05、11-08、11-09），更早的已经没了。
3. **`<session-T>` 有 5 小时 17 分钟整机睡眠的证据**（`03:09:40Z → 08:26:18Z` 零记录，前后记录集中在两小时）。在这段时间里 `status=waiting` 挂着不动。**任何基于「静默时长」的判据都必须先区分「整机睡眠」和「等用户」**，否则每次合盖都会产出一条「它等你一晚上了」。
4. **9 个会话里有 8 个跑多 agent 工作流**，主 transcript 静默是常态而非异常。这直接把「主 transcript mtime」这个最容易想到的判据的误判率推到 21%。子 agent 目录是必须的。

---

## 8. 复现方式

本次分析用的临时脚本放在 `%TEMP%` 下的两个临时目录里（分析中途被系统清理过一次，后半段重写了一遍），全部是只读的 Node ESM。要点：

- 全量扫描 10 个 transcript（合计 322 MB，最大 114 MB）耗时 3.8 秒——读取时按 4 MB 分块流式提取 `"timestamp":"…"`，不整文件 `JSON.parse`。
- 事件级判定需要**全文件**展开 `tool_use` 集合；尾部 1 MB 与全文件结果对 10 个会话完全一致（幻影 0 个），所以生产实现可以放心只读尾部。
- `state.json` 的 73 条与 `observations.jsonl` 的 80 条用 `firstSeenAt − idleSec×1000` 还原 `statusUpdatedAt`，与 `sessions/*.json` 里当时的值逐条吻合（同一 pid 的 `statusUpdatedAt` 精确到毫秒）。
- `%LOCALAPPDATA%` 的读取：`Invoke-CimMethod Win32_Process -MethodName Create` 起 `cmd.exe /c copy …`，落盘到 `%TEMP%` 后再读。直接 `Get-Content` 会拿到影子目录。
