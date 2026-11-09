# WAITING 通知诊断：信号为真但迟到 45 秒；标题是 raw slug 因为这条走的是 scan 路径

> 诊断对象：2026-11-08T21:01:27Z（本地 05:01:27）发出的一条 Overwatch Toast：
> `✋ <project-J-slug> · 正在等你（input needed）`
> / `<project-J-slug> · waiting:input needed · idle=2m`
>
> 产出形态：exploration（诊断报告）。作者：诊断 Agent D3。
> **未修改任何代码、未改 git、未重启守护进程。**

## 0. 结论（先给判定）

| 问题 | 结论 |
|---|---|
| 真阳性还是假阳性 | **信号是真的，但送达时已经过期。** 会话在 20:58:29Z 确实停在一次 `AskUserQuestion` 上等人回答（transcript 逐字可查）。用户 21:00:54Z 回答，Toast 21:01:27.846Z 才落地，**迟到 33.7 秒**。用户看到时它已经在干活了。按「用户是否被打扰且无事可做」判，是误报；按「宿主是否撒谎」判，不是。 |
| 为什么会迟到 | **不是 PowerShell 冷启动，是整轮串行。** 该轮从 21:00:43.000Z 开始，45 秒后才派发。实测今日 L-mid 轮内耗时 p50=32s / p90=45s / p95=59s（n=52）。`runTick` 把 `dispatchCandidates` 放在**所有层都跑完之后**，而 L-mid 要跑 5 个项目的 `scan-sessions`（实测 8.8s）+ 一次 `asked.mjs`（实测 21.9s）。用户在轮内第 11 秒就答了，那时还没派发。 |
| `idle=2m` 对不对 | **算术对，语义可疑。** `idleSec=138` 是 scan 层对「距最后一次工具调用」的测量（20:58:29.147Z 那次 `AskUserQuestion`），不是修过的那个「从被重写的 `updatedAt` 反推」的 bug。但同一个 `idle=` 标签在两条路径上含义不同：sessions 源是「状态已等多久」，scan 源是「距上次工具调用」。同一时刻实测过两个值：719s 与 54s。 |
| 标题为什么是原始 slug | **这条通知由 scan 路径产生，不是 `probeWaiting`。** `scan-sessions.mjs:624` 把目录 slug 直接写进 `project`，`watch.mjs:935` 原样透传，`notifyTitle`/`describe` 原样使用。`probeWaiting`（`watch.mjs:602`）反而做了 basename 归一化。生产日志里有三组活体对照实验（同一会话、两条路径、两种标题）。 |
| 会话有没有 `name` | **有**：`"name": "<project-J-name>"`，`nameSince === startedAt`。通知链路一次都没读它。 |

**一句话**：判据没撒谎，送达机制让它在 45 秒后变成谎言；标题难看是「scan 路径没做归名」这个已知缺陷的第三次复发。

---

## 1. 事实链

| 时刻（UTC） | 事实 | 证据 |
|---|---|---|
| 20:58:29.147Z | 会话发出 `AskUserQuestion`，问「调研确认 Claude Code 的 Workflow 原生提供了我们 2900 行编排层的大部分能力。怎么处理？」 | transcript `<session-S>…jsonl` |
| 20:58:29 起 | 宿主报 `status:"waiting"`、`waitingFor:"input needed"` | 生产 `state.json` + 观察日志 |
| 21:00:28Z | 上一轮 tick 结束（`candidates=1 already=1`） | 生产 `watch.log` |
| **21:00:43.000Z** | **本轮开始**（上一 tick + 15s 休眠） | 同上，推算 |
| 21:00:43.990Z | 本轮 `nowMs`。观察日志写下 `WAITING / waiting:input needed / idle=138 / source=scan / notified=true` | 生产 `observations.jsonl` |
| **21:00:54.157Z** | **用户已回答**（「开始时询问用户…需要随机应变」） | transcript `user` 记录 |
| 21:01:28Z | `notified WAITING <project-J-slug> key=81bf69236a306942` | 生产 `watch.log` |
| **21:01:27.846Z** | **Toast 落地** | Windows `wpndatabase.db` `Notification.Id=53464`，`HandlerId=287`(`Overwatch.Notifier`)，`Tag="waiting"` |

派生：本轮耗时 **44.8s**；决策→落地 **43.9s**；回答→落地 **33.7s**。

### 1.1 Toast 原始载荷（逐字，来自 Windows 通知库）

```xml
<?xml version="1.0"?><toast><visual><binding template="ToastGeneric">
<text>✋ <project-J-slug> · 正在等你（input needed）</text>
<text><project-J-slug> · waiting:input needed · idle=2m</text>
</binding></visual></toast>
```

> 正文分隔符是 ` · `，`waiting:input needed` 中间**没有空格**。任务描述里的 ` - ` 是转写近似。
> 两行 slug 重复不是渲染问题：标题与正文各自独立拼装同一个 `project` 字段。

### 1.2 会话原始字段（脱敏，`~/.claude/sessions/<pid-D>.json`）

诊断开始时（仍处于 waiting）的快照，敏感值脱敏，`name`/`status`/`cwd`/`updatedAt` 保留：

```json
{
  "pid": <pid-D>,
  "sessionId": "<session-S-uuid>",
  "cwd": "<盘符>:\\<project-J-parent>\\<project-J-dir>",
  "startedAt": 1794168339175,
  "procStart": "134386419343398354",
  "version": "2.1.308",
  "peerProtocol": 1,
  "peerFeatures": ["notify_idle", "artifact_yield"],
  "kind": "interactive",
  "entrypoint": "claude-desktop-3p",
  "hostSessionId": "<host-session-uuid>",
  "pidDomain": "win32:<主机名>",
  "messagingSocketPath": "\\\\.\\pipe\\LOCAL\\cc-msg-<id>",
  "name": "<project-J-name>",
  "nameSince": 1794168339175,
  "updatedAt": 1794172310563,
  "status": "waiting",
  "statusUpdatedAt": 1794172310563,
  "waitingFor": "permission prompt"
}
```

收尾时（23:23Z）同一文件已是 `status:"idle"`、`statusUpdatedAt:1794177205379`（22:33:25Z）。

### 1.3 最后一条 assistant 内容（逐字）

时间戳 `2026-11-08T20:58:29.064Z`，紧接 `AskUserQuestion`：

```
调研把我上一轮的判断**推得更远了**——而且方向和我说的不完全一样。

## 调研的核心结论（官方文档核实）

Claude Code 有一个官方一等特性叫 **dynamic workflows**，官方原文：

> "A dynamic workflow is a JavaScript script that orchestrates many subagents at once."
> —— code.claude.com/docs/en/workflows.md
…
## 下一步该做什么（需要你决定方向）

调研给出了一个我无法自己决定的结论：**如果目标 harness 是 Claude Code，我们的编排层（约 2900 行）大部分应该删掉，改成一份「Workflow 脚本模板」**——那是真正的 harness 原生形态。

但这意味着**推翻现有 6113 行的一半**。而且如果是给别的 harness 用，那部分还有价值。
```

紧随其后的工具调用：

```
AskUserQuestion:
  编排层 — 调研确认 Claude Code 的 Workflow 原生提供了我们 2900 行编排层的大部分能力。怎么处理？
    A. 改写为 Workflow 脚本（推荐）
    B. 双轨：保留兼容层 + 加脚本
    C. 暂不改动
```

**这就是「在等用户输入」的教科书定义。** 生产 Toast 面板里那条 `✋ 正在等你（input needed）` 在**判定**上是站得住的。

---

## 2. 真相：为什么它会变成误报

### 2.1 45 秒花在哪（实测分解）

同一轮里 L-mid 要做的活，我在本机单独重测：

| 步骤 | 实测 | 说明 |
|---|---|---|
| 5 个项目的 `scan-sessions --project …` | 1.9 + 1.8 + 0.9 + 2.1 + 2.0 = **8.8s** | 日志里那 5 个 `scan:*` |
| `asked.mjs` 全量扫描 | **21.9s** | 日志里那个 `asked` |
| 三者合计 | **≈31s** | 与 p50=32s 吻合 |
| 本轮实测 | **44.8s** | 含 PowerShell 冷启动 3.3–4.2s 与两台并发负载 |

今日 L-mid 轮内耗时分布（生产日志，n=52）：

```
p50=32s   p75=40s   p90=45s   p95=59s   max=10452s（18:54 那次，含重启）
```

对照：纯 L-fast 轮内耗时 p50=0s / p95=1s / max=8s，n=889。

### 2.2 结构原因

`runTick()` 的顺序是：

```
claimOwnership → loadState
  L-fast（probeJobs + probeWaiting，~10ms）
  L-mid （probeMtime + 最多 5 个 scan-sessions + asked.mjs，~31s）   ← 时间全在这里
  L-full（仅 --full）
  去重
  dispatchCandidates(...)                                            ← 发送在最后
  saveState
```

于是：**一个在第 1 秒就已经知道的事实，要等到第 45 秒才被发出去。** 用户在这 45 秒里的任何输入都不会被 C 记住——`nowMs` 在轮开始时就被冻结，之后不会再回读宿主状态。

这不是「PowerShell 慢」，也不是「采样间隔太长」。这是**串行流水线把延迟集中在最后一步**。`canNotify`（`watch.mjs:473`）只管额度，不管时效；`buildInbox`（`watch.mjs:2166`）事后会拿 live 对账标 `stale`，但**桌面 Toast 没有这一步**。

### 2.3 `waiting` 本身也会滞留（旁证）

生产观察日志里，同一会话在 21:10 之后被反复判成 `waiting / permission prompt`，而每条的 `idleSec` 只有 13–36 秒——意味着**工具调用就在十几秒前刚发生过**：

```
21:10:53Z  <session-S>  WAITING  waiting:permission prompt  idle=13  source=scan  → budget-per-session-24h
21:16:01Z  <session-S>  WAITING  waiting:permission prompt  idle=14  source=scan  → budget-per-session-24h
21:21:15Z  <session-S>  WAITING  waiting:permission prompt  idle=26  source=scan  → budget-per-session-24h
21:26:26Z  <session-S>  WAITING  waiting:permission prompt  idle=36  source=scan  → budget-per-session-24h
22:17:40Z  <session-S>  WAITING  waiting:permission prompt  idle=7   source=scan  → budget-per-session-24h
```

宿主把这个 `waiting` 从 21:11:50Z 挂到 22:20:52Z，**约 69 分钟**，其间 transcript 一直在长（21:15 / 21:20 / 21:25 均有工具调用）。这几次**没有弹窗，纯属巧合**——都被 `per-session-24h` 额度挡住了。去掉额度它们会全部变成误报。

⚠ 保留意见：`waitingFor: "permission prompt"` 理论上可能是某个子 agent 挂着一条未处理的权限提示，而主 agent 继续推进。我没有逆向宿主的 `bVo()` 状态机，**不能断言这是残留**；但「通知系统拿它当『此刻在等你』发出去」这件事，在这个状态下是不成立的。

---

## 3. 任务二：标题为什么是目录 slug

### 3.1 代码路径（钉死）

```
runTick ── L-mid ── runScan() ──► node scripts/scan-sessions.mjs --json
                                     │
                    scan-sessions.mjs:624   project: projectDir        ← slug 在此诞生
                                     │
                watch.mjs:935  candidatesFromScan(): project: s.project ← 原样透传
                                     │
                watch.mjs:1692  notifier({ title: notifyTitle(c), body: describe(c) })
                                     │
                watch.mjs:1464  const where = c.project || …
                watch.mjs:1494  const where = c.project ? `${c.project}` : …
                                     │
                                 两行都是 slug
```

三条独立证据：

1. **生产 `state.json`**：`81bf69236a306942` → `"source": "scan"`, `"project": "<project-J-slug>"`。
2. **生产 `observations.jsonl`**：`21:00:43.990Z … idle 138 … source scan … notified true`。
3. **去重键可复算**：`dedupeKey(sid,"WAITING","waiting:input needed","8205829147") = 81bf69236a306942`，与日志 `key=` 一致；`8205829147` 正是 20:58:29.147Z 的数字尾巴。**只有 scan 路径带 `evidenceFingerprint`**（`watch.mjs:945`），`probeWaiting` 不产这个字段。

### 3.2 最硬的证据：生产日志里的三组活体对照

同一会话、同一天、两条路径各发一次，标题形态不同：

```
2026-11-08T19:31:57Z notified WAITING <project-J-dir>        key=771d542c73df3fb3  ← sessions 源
2026-11-08T21:01:28Z notified WAITING <project-J-slug>  key=81bf69236a306942 ← scan 源

2026-11-08T19:50:41Z notified WAITING <project-B>                                        key=d7b87f3d21e96c0f  ← sessions 源
2026-11-08T20:04:24Z notified WAITING <project-B-slug>      key=a2fb30d72034f971  ← scan 源

2026-11-08T21:39:43Z notified WAITING style                                              key=3679ed23e2930d88  ← sessions 源
2026-11-08T21:58:04Z notified WAITING <project-I-slug>                                       key=4991735d1f97e981  ← scan 源
```

**三次，每次都是「sessions 源给短名 / scan 源给 slug」。** 这不是偶发，是两条路径的确定性差异。

### 3.3 四条路径各写各的（含一处新错误）

| 路径 | `project` 的来源 | 对本文会话的结果 |
|---|---|---|
| `probeWaiting`（`watch.mjs:602`） | `s.cwd.split(/[\\/]/).pop()` | `<project-J-dir>`（可读，但 40 字符仍撑标题） |
| `probeJobs`（`watch.mjs:789`） | 同上 | 同上 |
| `candidatesFromScan`（`watch.mjs:935`） | `s.project` ← scan 记录原样 | **slug（撑爆）** |
| `askedCandidates`（`watch.mjs:2350`） | `raw.split('-').filter(Boolean).pop()` + 截 24 | **`heavy`**（实测）——对含连字符的项目名产出无意义残词 |

`askedCandidates` 里那句注释「取最后一段，和 `probeJobs`/`probeWaiting` 的做法一致」是**错的**：三者做法互不相同，且第三种对 `<project-J-dir>` 给出 `heavy`。

### 3.4 `name` 有没有被用上

全仓库只有三处读 `name`：`scan-sessions.mjs:476`（放进 live 数组）、`probeWaiting:602`（**仅当 `cwd` 为空时兜底**）、`oversight-tui` 若干处。**通知链路一次都没用。**

所以「有可读名字却显示 slug」是 bug，不是「没名字只能兜底」。

### 3.5 附带的同类 bug：TUI 列表的字符类写错

`scripts/oversight-tui.mjs:660`：

```js
const where = base.split(/[\/]/).pop().replace(CTRL, ' ') || null;
```

字符类 `[\/]` 里 `\/` 只是转义的斜杠，**字符类实际只含 `/`，不含反斜杠**。实测对 Windows 路径永远切不开，返回整条绝对路径：

```
cwd     : <盘符>:\<project-J-parent>\<project-J-dir>
project : <盘符>:\<project-J-parent>\<project-J-dir>
```

同仓库 `watch.mjs:602` 写的是 `[\\/]`，是对的。这行漏了一层转义。现有测试用 `D:Projects<tab>demo`（无反斜杠）做夹具，恰好绕开。

---

## 4. 附带发现

### 4.1 sessions 源的去重键不含指纹 → 同一会话第二次等待永远不再通知

`reasonClass("waiting:input needed") === "waiting"`，`reasonClass("waiting:permission prompt") === "waiting"`（实测）。而 `probeWaiting` **不产 `evidenceFingerprint`**。于是 sessions 源的键恒定：

```
dedupeKey(sid,"WAITING","waiting:input needed","")      = 771d542c73df3fb3
dedupeKey(sid,"WAITING","waiting:permission prompt","") = 771d542c73df3fb3   ← 同一个
```

`771d542c73df3fb3` 在 19:31:57Z 就已 `delivery:"submitted"`。此后该会话**每一次真等待**都会被判成「已处理」。20:58 那次还能通知到你，纯粹因为 scan 路径带指纹、算出另一个键——**巧合，不是设计**。

该会话在生产 `state.json` 里已攒 **8 个 WAITING 键**，其中 6 个 `notifyCount: 0`：

```
771d542c73df3fb3  sessions  count=1  19:16:50  <project-J-dir>
9c1adc7ee89da52a  scan      count=0  19:33:27  slug
81bf69236a306942  scan      count=1  21:00:43  slug   ← 本次诊断对象
b097d12e3e1eaa74  scan      count=0  21:10:53  slug
00a58c57a16898f4  scan      count=0  21:16:01  slug
98fc3296c17aaefe  scan      count=0  21:21:15  slug
f3ce65e68026459a  scan      count=0  21:26:26  slug
bfe32d9290d4175c  scan      count=0  22:17:40  slug
```

### 4.2 关于「守护进程不写盘」——**那是观测假象，已排除**

诊断早期我从某个进程视角看到 `%LOCALAPPDATA%\Overwatch` 里 `state.json` 全 NUL、`watch.log` 停在 10-31。**那是错的**：那是 MSIX 文件系统虚拟化留下的影子副本（与同时段另一路诊断 D4 的结论一致，`docs/research/2026-11-04-watcher-silent-failure.md`）。

用非虚拟化进程（WMI 拉起 `cmd`）读取真实目录：

| 文件 | 影子副本（我先前看到的） | **真实生产文件** |
|---|---|---|
| `state.json` | 3406 B，全 NUL | **20,359 B，正常 JSON，31 条 `notified`，7 条 `sentLog`** |
| `watch.log` | 41,857 B，mtime 10-31，末 76 字节 NUL | **614,151 B，4,825 行，4,774 条 tick，0 条 ERROR/WARN，末尾 `23:17:47Z`** |
| `observations.jsonl` | 2,264 B，停在 10-31 | **12,631 B，38 条** |
| `runner.log` | 39,724 B | **157,704 B** |
| `Overwatch.witness.json` | 189 B，全 NUL | **`saves: 10150`，`lastSavedAt: 23:18:47Z`** |

**守护进程一直正常。** 推论：`node scripts/watch.mjs --health|--stats|--trace` 在**我这个会话的进程上下文里**读的是影子副本，输出不可作判据。这不是本次任务的结论，但它是「为什么之前会误判后台没在跑」的答案，值得单独立案。

---

## 5. 修复建议（不改代码，只给建议）

### P0-1 让 WAITING 立刻发，不等 L-mid

这是本次误报的**直接原因**，也是收益最大的一条。

`runTick` 现在把 `dispatchCandidates` 放在所有层之后。建议：**L-fast 跑完就派发一次宿主事实候选**，L-mid 的 `scan`/`asked` 结果留到下一轮（或在本轮末尾再派发一次）。

- 改动点：`watch.mjs` `runTick` 内，在 `waiting`/`jobs` 两个探针之后插一次 `dispatchCandidates(hostFactOnly)`。
- 预期：WAITING 延迟从 **p50 32s / p90 45s** 降到 **< 1s**（L-fast 实测 p95 = 1s）。
- 风险：`saveState` 会从每轮 1 次变成 2 次。相对 45 秒的误报，这个代价可以接受；若在意，可在同一次 `dispatchCandidates` 调用后立刻 `saveState` 一次。

### P0-2 发送前再对一次 live 状态

`dispatchCandidates` 调 `notifier` **之前**，对候选 `sessionId` 回读 `readLiveSessionStates()`（11 个小 JSON，实测 <10ms）：

- `status` 已不是 `waiting` → 放弃发送，标 `stale-before-send`，写一条观察。
- 这能消掉「轮内用户已回答」这类窗口，即使 P0-1 没做也能挡掉大部分。

### P0-3 统一用 `projectLabel(raw, name)`，六处共用一个函数

```js
export function projectLabel(rawProject, sessionName = null) {
  const n = String(sessionName || '').trim();
  const base = n || String(rawProject || '').split(/[\\/]/).filter(Boolean).pop() || '';
  return base.length > 24 ? base.slice(0, 24) + '…' : base;
}
```

配套（缺一条都不完整）：

1. `scan-sessions.mjs` `results.push({…})`（约 622 行）加 `name: live?.name ?? null`。`liveBySession` 里已经有 `name`（`scan-sessions.mjs:476`），但现在没往结果里带，所以 scan 路径拿不到。
2. `watch.mjs:935` `candidatesFromScan`：`project: projectLabel(s.project, s.name)`。
3. `watch.mjs:602` `probeWaiting`：`project: projectLabel(s.cwd, s.name)`（别只用 basename，40 字符照样撑标题）。
4. `watch.mjs:2350` `askedCandidates`：删掉 `raw.split('-').filter(Boolean).pop()`，改 `projectLabel(it.project)`，并改掉那条错误注释。
5. `watch.mjs:1464` `notifyTitle`、`watch.mjs:1494` `describe`：用 `projectLabel(c.project, c.name)`；`c.name` 由候选透传。

预期标题：`✋ <project-J-name> · 正在等你（input needed）`。

### P0-4 正文不要重复标题里的项目名

`describe()` 无条件把 `where` 放 `bits[0]`。既然标题已有它，正文只留 `reason · idle=…`（`needs` 仍逐字保留，`relay-protocol.md` 的硬要求）。最省事的做法：在 `dispatchCandidates` 里算一次 `where`，标题与正文共用。

### P1-1 WAITING 要带「等待开始后没有新活动」的佐证

`probeWaiting` 与 `candidatesFromScan` 的 WAITING 分支加一条 cheap 检查：

- `lastActivity > statusUpdatedAt` → 宿主报的 waiting 已过时（§2.3 实测滞留 69 分钟，其间多次工具调用），**不通知**，写 `stale-waiting` 观察。
- 否则正常通知。

`scan` 路径本来就有 `lastActivity`；`probeWaiting` 可复用 `state.probe` 里已有的 `maxMtimeMs`（`watch.mjs:819`，约 60ms）。

### P1-2 sessions 源去重键补指纹

`probeWaiting` 候选加 `evidenceFingerprint: String(s.statusUpdatedAt).slice(-10)`。否则 §4.1 那个恒定键会让同一会话的第二次等待永久静默——**这已经真实发生过**（19:31 的键吞掉了此后所有 sessions 源 WAITING）。

### P1-3 修 `oversight-tui.mjs:660`

`/[\/]/` → `/[\\/]/`，并优先 `live.name`。

### P2 给 `idle=` 换名字，或在正文里标注它测的是什么

同一个标签在两条路径上测的是两个东西（「状态已等多久」vs「距上次工具调用」，同刻实测 719s vs 54s）。建议 sessions 源写 `held=`（状态持续时长）、scan 源写 `idle=`，或直接写全 `已等待 …`。这属于措辞层面，但正是「一个数字两个含义」这类事故的温床。

---

## 6. 复现与验证记录

全部只读，未改代码、未重启、未碰 git。

```bash
# 1. Toast 原文（Windows 通知库，只读）
node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(
  '<用户目录>/AppData/Local/Microsoft/Windows/Notifications/wpndatabase.db',{readOnly:true});
  // select Id,HandlerId,Tag,ArrivalTime,Payload from Notification where Id=53464
  "
# → HandlerId=287 (Overwatch.Notifier), Tag="waiting", ArrivalTime=2026-11-08T21:01:27.846Z

# 2. 会话实时状态
cat '<用户目录>/.claude/sessions/<pid-D>.json'

# 3. 复算标题（仓库真函数）
node --input-type=module -e "import {notifyTitle} from './scripts/watch.mjs';
  console.log(notifyTitle({state:'WAITING',reason:'waiting:input needed',
    project:'<project-J-slug>',idleSec:138}))"
# → ✋ <project-J-slug> · 正在等你（input needed）

# 4. 复算去重键
node --input-type=module -e "import {dedupeKey,reasonClass} from './scripts/watch.mjs';
  console.log(reasonClass('waiting:input needed'), reasonClass('waiting:permission prompt'));
  console.log(dedupeKey('<session-S>-…','WAITING','waiting:input needed','8205829147'));
  console.log(dedupeKey('<session-S>-…','WAITING','waiting:input needed',''));"
# → waiting waiting
# → 81bf69236a306942   （与生产 state.json 条目一致）
# → 771d542c73df3fb3   （与 19:31 那条一致）

# 5. 轮内耗时分解
node scripts/scan-sessions.mjs --days 3 --project <各项目> --json   # 1.9+1.8+0.9+2.1+2.0 = 8.8s
node --input-type=module -e "import {scanAll} from './scripts/asked.mjs';
  scanAll({nowMs:Date.now(),minHours:1})"                           # 21.9s

# 6. TUI 路径切分 bug
node -e "const p='<盘符>:\\\\<project-J-parent>\\\\<project-J-dir>';
  console.log(p.split(/[\\/]/).pop())"                              # 原样返回整条路径

# 7. 读真实生产文件（绕开 MSIX 影子副本）
powershell -NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
  -Arguments @{CommandLine='cmd.exe /c dir <LOCALAPPDATA>\Overwatch'}"
# → state.json 20,359 / watch.log 613,911（随后仍在增长，收尾时 614,151）/ observations.jsonl 12,631
```

旁证：

- `node --test scripts/oversight-tui.test.mjs` 37 条全绿——现有测试**覆盖不到** §3.5 的字符类（夹具用不带反斜杠的串）。
- `scan-sessions --project token-heavy --days 1` 输出 `[WAITING] Projects/AI/prompt/many/ … waiting:permission prompt`，同一会话被 scan 判成 WAITING，且其 `project` 字段就是 slug。
- 生产 `watch.log` 全天 **0 条 ERROR / 0 条 WARN**。

---

## 7. 未验证 / 不确定性

1. **这 44.8s 里各段的确切占比**没有逐段打点。8.8s（5 个 scan）+ 21.9s（asked）是我**现在**单独重测的，当时机器上还有 6 个 subagent 与另一路诊断在跑，可能更慢。3.3–4.2s 的 PowerShell 冷启动是 `notify.mjs` 自己实测过的数。**总和不等于 44.8s，差额未查明。**
2. **21:00 那一刻 `sessions/<pid-D>.json` 的原始字节**已不可恢复（宿主后来重写成 `idle`）。我用生产 `observations.jsonl` 的 `source=scan` + `reason=waiting:input needed` 与 transcript 的 `AskUserQuestion` 两条独立记录互证，但不是同一份文件的原字节。
3. **`waitingFor: "permission prompt"` 从 21:11 挂到 22:20 是真残留还是子 agent 挂起**：只观测到「宿主说 waiting 而工具调用仍在发生」，没有逆向宿主的判定函数，**不下结论**。
4. **`_nowMs` 冻结的副作用范围**：我确认 `runTick` 的 `nowMs` 在轮开始时确定，但没有逐条审计所有调用点（`within()` 的额度窗口、`pruneNotified` 的 TTL）是否都受它影响。
5. **MSIX 影子副本的物化机制**：与 D4 的报告一致，未独立复现其文件 ID 取证。

---

## 8. 一句话回答主线程的三个问题

1. **真阳性还是假阳性**：信号真（`AskUserQuestion` 可查），但**送达时已过期 33.7 秒**——按用户体验是误报，按判据真伪不是；根因是 `runTick` 把发送放在所有层之后，L-mid 一轮要 32–45 秒。
2. **标题缺陷的确切原因**：这条通知走的是 **scan 路径**，`scan-sessions.mjs:624` 把目录 slug 直接写进 `project`，`notifyTitle`/`describe` 原样使用；`probeWaiting` 那条路径反而做了 basename 归一化。生产日志里有三组「同一会话、两条路径、两种标题」的活体对照。会话本来就有 `name`（`<project-J-name>`），通知链路一次都没读。
3. **修复建议一句话**：L-fast 探完就立刻派发（顺带在发送前回读一次 live 状态），并加一个 `projectLabel(raw, name)`（优先 `sessions/*.json` 的 `name`，其次 cwd basename，超 24 字符截断），让 `scan-sessions`/`candidatesFromScan`/`probeWaiting`/`askedCandidates`/`notifyTitle`/`describe` 六处共用。
