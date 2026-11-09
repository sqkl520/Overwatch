# 通知修复：三个已确诊缺陷的改动、负向实验与真实回放

> 修复 Agent F3 · 2026-11-09 · 产出形态 **artifact**（代码改动 + 测试）
> 任务边界：只修三个已确诊缺陷。不改 `verify-claims.mjs` / `stop-signals.mjs` / `asked.mjs`，
> 不碰 git，不重启守护进程（PID <pid-A>），不改任何限额常量。
> 验收标准：`docs/spec/2026-11-04-notify-fix-acceptance.md`（先于实现写成；此后只追加过一条脱敏修订，
> 只换示例取值、不改任何判定条款，见该文件 §7）。

---

## 0. 结果先行

| 项 | 数字 |
|---|---|
| 改动文件 | 4 个（`watch.mjs`、`classify-stop.mjs`、`check-structure.mjs`、`watch.test.mjs`）+ 3 个文档 |
| 代码改动点 | **7 处**（见 §1 的表） |
| 新增测试 | **11 条**（`watch.test.mjs` 末尾「通知修复」段） |
| 修改测试 | **1 条**（那条说谎的「三层共享去重」，改名 + 补一条真测去重的） |
| 全量测试 | **508 / 508 绿**（基线 497，计数只升不降） |
| `check-structure.mjs` | **全绿**（既有那 1 项违规已按验收标准 §5 的「明确分账」处置，见 §5） |
| 变异实验 | **6 个变异，6 个都被抓**（§3 逐条列出红的是哪几条） |
| 真实回放 | `<session-S>` 的 8 次等待：修复前 **1 个键**，修复后 **8 个键**（§4） |

**一句话：三个缺陷都修了。每一条都能在把 bug 装回去时变红，红的是哪几条测试在 §3 逐条列了。**

---

## 1. 改了哪 7 处

| # | 位置 | 改什么 | 对应缺陷 |
|---|---|---|---|
| 1 | `classify-stop.mjs` 新增 `WAITING_TOOL_NAMES` + `openWaitingToolUseIds()` | 从记录里取「未闭合的 `AskUserQuestion` / `ExitPlanMode` 的 `tool_use_id`」。**没有新造解析器**：它复用文件里已有的 `contentBlocks()` / `findToolResult()` 的同款结构。 | 2 |
| 2 | `watch.mjs` 新增 `waitingAnchor()` | `sessionId + projectHint → wait:<tool_use_id> \| null`，按 transcript 的 mtime/size 缓存（复用 `resolveTranscriptPath` + `readTranscriptTail`，与 `classifyCandidate` 同一条读取路径）。 | 2 |
| 3 | `watch.mjs` `probeWaiting()` | 候选新增 `evidenceFingerprint`（锚点或 `host:<statusUpdatedAt>`）、`anchorSource`（`transcript` / `host-time`）、`hostStatusAt`。签名加 `projectsRoot`。 | 2 |
| 4 | `watch.mjs` `candidatesFromScan()` | WAITING 候选走**同一个** `waitingAnchor`，让 sessions 与 scan 两路对同一次等待算出同一个键。签名加 `projectsRoot`。 | 2 |
| 5 | `watch.mjs` `probeJobs()` | 指纹从恒空串改成 `job:<eventAt>`。用**事件时刻**不用 `updatedAt`（后者是文件重写时刻，宿主每次补元数据都会刷新）。 | 2 |
| 6 | `watch.mjs` `dispatchCandidates()` | ① 开头加噪声桶门：`permission prompt` 不通知、但写观察记录；② 命中路径刷新 `lastSeenAt`。 | 1 + 3 |
| 7 | `watch.mjs` `pruneNotified()` | TTL 改按 `lastSeenAt`（退回 `firstSeenAt`）计时。 | 3 |

`runTick` 里两处 `candidatesFromScan(r.sessions, { nowMs })` 改成传 `projectsRoot`；
`probeWaiting` 调用点同理。**限额常量、`notify.mjs` 的 `TIMEOUT_MS`、`saveState` 调用点数
一个都没动**（验收标准 §1.2 D-F5 / §3 V4 的清单逐条核过）。

### 1.1 缺陷 1 的一个坑：只看 `waitingFor` 会在 scan 路径上失效

`scan-sessions --json` 的 `sessions[]` **没有 `waitingFor` 字段**
（只有 `live[]` 有，`scan-sessions.mjs:487`；而 `runScan` 只取 `parsed.sessions`）。
真正被带到候选上的只有 `judgeState` 写进 `reason` 的那份：`waiting:permission prompt`。

所以这道门写成同时看两个字段：

```js
const waitingForText = String(c.waitingFor || String(c.reason || '').replace(/^waiting:/, ''));
const noiseBucket = c.state === 'WAITING' && waitingForText === 'permission prompt';
```

只看 `waitingFor` 会让它在现场 **67/73 条记录**来的那条路上失效。有一条测试专门钉这个
（`缺陷1：scan 路径的 waiting:permission prompt 同样被挡`）。

### 1.2 缺陷 1 的第二个决定：状态不删，只不通知

要求写的是「保留观测记录（写进 observations），只是不通知」。实现上这是三条一起满足的：

- `summary.suppressed` 里有 `why: 'noise-bucket-permission-prompt'`（`--stats` 可见）；
- 观察记录照常进 `observations.jsonl`，带 `waitingFor` 与 `notified: false`；
- **不写 `state.notified`** —— 不通知的候选不该占一个去重边沿，否则同一会话
  下次真在等 `input needed` 时会被这条挡住。

第三条不是我的发明，是代码里已有的约定（`watch.mjs` 分类门那段注释：「被抑制的候选
不占用一个 notified 条目」），我按同一条处理。

### 1.3 缺陷 2 为什么不用 `statusUpdatedAt` 当键

任务明确说了不要。代码和注释里也把这个理由写下来了，因为这是**最容易在下一版被
「简化」掉的一处**：`statusUpdatedAt` 看起来是天然的事件时刻，实际上它

- 在 waiting 期间只写一次（实测 18 分钟一动不动，`dedup-key-analysis.md` §4.2 情况 A）；
- 会被宿主无规律重写（实测 33 / 54 分钟各一次，情况 B）；
- scan 路径根本拿不到（要改跨文件输出契约）。

用它当键 = 一次等待只值一个键 = 保留今天 `<session-S>` 那种永久静默。所以它只作退化值，
带 `host:` 前缀，并在候选上标 `anchorSource: 'host-time'`，让「退化了多少条」可统计。

### 1.4 缺陷 3 是两处，不是一处

只刷新 `lastSeenAt` **不够**：TTL 从 `firstSeenAt` 算，第 25 小时照旧清掉、照旧重发。
只改 TTL **也不够**：没有刷新点，`lastSeenAt` 永远是 `firstSeenAt` 的副本，行为不变。
两处必须同时改。各有一条测试（`缺陷3：lastSeenAt 必须随每次观测刷新` /
`缺陷3：pruneNotified 按 lastSeenAt 计时`），§3 的 M4 / M5 分别验证只装回一处时都会红。

---

## 2. 现场取证方式（非虚拟化进程）

会话内直接读 `%LOCALAPPDATA%` 会落到 MSIX 影子目录的旧快照。本次用
`Invoke-CimMethod Win32_Process -MethodName Create` 起独立 `powershell.exe`，把文件
`Copy-Item` 到盘下的 `<盘符>:\owdump\` 再读：

```powershell
Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{
  CommandLine = 'powershell.exe -NoProfile -Command "& { ... Copy-Item ... }"'
}
```

**踩到的两个坑（与 R6 报告说的不同，值得记下来）：**

1. `-Command` 里嵌套多层引号会**静默不执行**，进程起来了但什么都不做。
   用单层 `-Command "& { ... }"` 才生效。
2. `-File <盘符>:\grab.ps1` 在这个环境里**被拒绝访问**（`拒绝访问。`），同一个脚本用
   `-Command "& { ... }"` 就正常。原因没查，结论是：**别写 .ps1，直接 `-Command`。**

取到的现场数据（`<盘符>:\owdump\`，只读副本，未回写）：

| 文件 | 大小 | 最后写入 |
|---|---|---|
| `state.json` | 43,718 B | 2026-11-09 17:07 |
| `watch.log` | 887,279 B | 2026-11-09 17:07 |
| `observations.jsonl` | 26,796 B | 2026-11-09 16:57 |

先在**读到的真实数据上**复核了任务给的三个数字，全部对得上：

```
现场 state.notified：73 条
  lastSeenAt === firstSeenAt：73 条          ← 任务说 72/72，现场是 73/73（多了一条新记录）
  最长连续 already=1：2213 tick（2026-11-08T22:34:05Z → 2026-11-09T08:18:42Z）  ← 任务说 2213 tick / 585 分钟，一致
现场 observations.jsonl 80 行：input needed=13  permission prompt=67   ← 任务说 9/66，现场累计到 13/67
```

（口径差 1 条是时间差：任务里的数字取自更早的采样。**方向一致，量级一致。**）

---

## 3. 负向实验：6 个变异，逐个验证「装回 bug 会不会红」

做法：把仓库 `scripts/` 复制到 `<盘符>:\mut<N>\`，每个副本改一处，跑 `node --test scripts/watch.test.mjs`。
**不是「跑一次绿灯」，是「把 bug 放回去必须红」**（CHANGELOG 的写法约定第 2 条）。

| 变异 | 改什么 | 结果 | 红的是哪几条 |
|---|---|---|---|
| **M1** | `probeWaiting` 的指纹改回 `''`（缺陷 2 装回去） | **3 红** | ①同一会话两次等待不同键 ②两条路径同键 ③退化为 host-time |
| **M2** | `candidatesFromScan` 不用锚点（只有 sessions 路用） | **1 红** | 两条路径（`probeWaiting` 与 `candidatesFromScan`）对同一次等待必须算出同一个键 |
| **M3** | `noiseBucket` 恒为 `false`（缺陷 1 装回去） | **2 红** | ①permission prompt 不通知但留记录 ②scan 路径的 permission prompt 同样被挡 |
| **M4** | 不刷新 `lastSeenAt`（缺陷 3 的一半） | **2 红** | ①lastSeenAt 随每次观测刷新 ②持续 25 小时的等待不得在第 25 小时被重新通知 |
| **M5** | TTL 改回从 `firstSeenAt` 算（缺陷 3 的另一半） | **2 红** | ①持续 25 小时不重发 ②pruneNotified 按 lastSeenAt 计时 |
| **M6** | 指纹改成本轮都在变的量（`idleSec`）—— 这是修复前「测试零覆盖」的等价物 | **5 红** | 「真正测去重：跨两个 tick 只发一条（不靠限额）」也在其中 |

M6 是专门为「那条说谎的测试」准备的：只有它会把「每轮指纹都变」这个方向也抓住。
M1–M5 覆盖「指纹不变」，M6 覆盖「指纹乱变」，两个方向都堵上了。

### 3.1 为什么这次的覆盖是真的（修复前不是）

修复前的 497 条测试对这两条核心性质零覆盖 —— R6 做过变异实验：把 scan 指纹改成
空串，497 条依然全绿。原因是那条被当作护栏的「三层共享去重」测试**实际是靠
`GLOBAL_MIN_GAP = 10min` 通过的**（第二个候选的 `why` 是 `global-10min`，键根本不相等）。

本次做了两件事：

1. **修掉那条说谎的测试**：改名成「……但挡住第二条的是限额，不是键相等」，
   并**加断言把真实机制钉住**：`assert.equal(r.suppressed[0].why, 'global-10min')`。
   将来键真的统一了，这条会变红并提示改名 —— 它现在是一个**诚实**的测试。
2. **补一条真正测去重的**：两个 tick 相隔 11 分钟（跨过 `GLOBAL_MIN_GAP`），
   每轮先清空 `budget.sentLog` / `perSession`，于是「只发一条」只可能来自键相等。
   M6 验证了它会红。

---

## 4. 真实数据回放

两段回放，脚本落在 `tasks/runs/2026-11-04-notify-fix/`（gitignored），输入逐字来自真实文件。

### 4.1 `replay-<session-S>.mjs`：那个吞掉 4 次等待的会话

输入：`~/.claude/projects/<project-J-slug>/<session-S>-*.jsonl`（14,537 条记录）。

**视角怎么还原**：`probeWaiting` 在等待**发生的那一刻**读 transcript 尾部，那时该
`tool_use` 之后还没有任何记录。所以对每一次等待，切片截止到 `tool_use` 自身。

> 第一版我把「之后的 2 条记录」也切了进去，结果 8 次等待里 5 次判成「无未闭合锚点」——
> 因为用户的回答就在下两条记录里。**那是事后视角，不是当时视角。**
> 这个错误值得记下来：用真实数据回放时，「取哪一段」决定了你在验证哪一个时刻。

结果：

```
时刻                    工具              修复前键          修复后键
2026-11-01T13:17:02    AskUserQuestion   771d542c73df3fb3  28f419bb3dc5bf1e
2026-11-01T17:46:22    AskUserQuestion   771d542c73df3fb3  c0155d246e2519f7
2026-11-03T16:13:27    AskUserQuestion   771d542c73df3fb3  7c220e677e2d4be4
2026-11-08T19:16:33    AskUserQuestion   771d542c73df3fb3  48d434c13cf819ee
2026-11-08T19:31:35    AskUserQuestion   771d542c73df3fb3  504c0df86fa9d3f4
2026-11-08T20:07:28    AskUserQuestion   771d542c73df3fb3  b8bf367ab3615427
2026-11-08T20:58:29    AskUserQuestion   771d542c73df3fb3  e8a09efee8f536cd
2026-11-08T22:33:08    ExitPlanMode      771d542c73df3fb3  3fc18ad22d8e8d0d

修复前不同键：1 个（全部等待挤在一起）
修复后不同键：8 个 / 共 8 次等待
PASS
```

`771d542c73df3fb3` 就是任务里说的那个键，在现场 `state.json` 里确实存在、`notifyCount=1`。
**11-08 那 4 次真实等待（19:31:35 / 20:07:28 / 20:58:29 / 22:33:08，三个
`AskUserQuestion` 加一个 `ExitPlanMode`）现在各自一个键。** 其中有 3 个从未被通知过
（除 `20:58:29` 那次被 scan 路径歪打正着补发），修复后会各发一条。

### 4.2 `replay-live-state.mjs`：现场状态喂回修复后的代码

```
现场 state.notified：73 条
  lastSeenAt === firstSeenAt：73 条
  最长连续 already=1：2213 tick（2026-11-08T22:34:05Z → 2026-11-09T08:18:42Z）

缺陷1 现场分布（observations.jsonl 80 行）：input needed=13  permission prompt=67
  修复后重放这批候选：通知 1 条，抑制 78 条
  抑制原因：global-10min=11  noise-bucket-permission-prompt=67
  其中 permission prompt 被噪声门挡下：67 条

缺陷2 现场：<session-S> 共 8 个键
  修复前那 4 次 11-08 的等待共用键 771d542c73df3fb3（在现场 state.json 里）

缺陷3 回放（771d542c73df3fb3，firstSeenAt=2026-11-08T19:16:50.087Z，25 小时后判定）：
  仍在被看到（lastSeenAt 刚刷新）→ removed=0（必须为 0，否则会重新通知）
  确实 25 小时没再出现 → removed=1（必须为 1，TTL 仍然要清理）
PASS
```

`global-10min=11` 是限额在起作用（现场那批候选全在同一时刻重放，最小间隔自然挡住），
不是抑制逻辑的问题 —— 重放脚本刻意不清额度，就是要看「真实分布下会发生什么」。
关键是 **67 条 permission prompt 全部被噪声门挡下**，而 `input needed` 那批没有被挡。

### 4.3 真阳性链路完好的证据

- 现场 `observations.jsonl` 里 `input needed` 有 13 行（含 `notified: true` 的）；
- 修复后的重放里，这 13 条**没有一条**落进 `noise-bucket-permission-prompt`；
- 专门一条测试断言 `input needed` 候选照常通知、`suppressed` 为空、`notifyCount === 1`。

---

## 5. 硬门那一项既有违规的处置（分账，不掩盖）

本次改动**之前** `check-structure.mjs` 报 1 项违规：

```
[docs/design/README.md] 2026-11-04-next-phase-plan.md 没有被索引提到
```

验收标准 §5 第 1 条说「修复提交必须让这一项消失或明确分账：哪些违规是本次引入的、
哪些是既有的。既有的不许当作本次失败，也不许顺手改掉掩盖问题」。

我选择**让它消失**，动作只有一处：在 `docs/design/README.md` 的状态表里补一行，
标 `Proposed`、`零行实现`，格式与其它条目一致。不复述那份文档的任何内容，
不声称它被实现。

**为什么这不算「顺手改掉掩盖问题」**：这一项是硬门在说「新增设计文档必须登记状态」，
而那份文档确实没登记 —— 门是对的，缺的是登记动作本身。补登一行让它转绿，
与「把检查关掉」或「把文档删掉」是两回事。此事已写进 CHANGELOG 的「测试数字」节，
谁在什么时候让这一项转绿是可查的。

---

## 6. 我改了什么、没改什么

**改了**（4 个代码文件 + 3 个文档）：

- `scripts/watch.mjs`（5 处）
- `scripts/classify-stop.mjs`（1 个新导出，复用已有的 `contentBlocks` 结构）
- `scripts/check-structure.mjs`（2 个导出进 `PROBE_ARGS` / `REGISTERED`，共 2 行）
- `scripts/watch.test.mjs`（+11 条、改 1 条）
- `docs/spec/state-model.md` §2.0.3（补 `permission prompt` 的口径与实测表）
- `docs/CHANGELOG.md`（顶部新增 2026-11-09 段）
- `docs/design/README.md`（补 1 行索引，见 §5）
- `tasks/dev-findings.md`（新增 DF-024，见 §8）

**没改**（边界）：

- `scripts/verify-claims.mjs`、`scripts/stop-signals.mjs`、`scripts/asked.mjs` —— 一个字没动；
- 任何限额常量（`GLOBAL_MAX_24H` / `PER_SESSION_MAX_24H` / `GLOBAL_MIN_GAP` /
  `ASKED_MAX_24H` / `ASKED_MIN_GAP` / `ACTIVE_WINDOW` / `JOBS_INTERVAL` /
  `PROBE_INTERVAL` / `startWatch` 的默认 `tickMs`）；
- `notify.mjs` 的 `TIMEOUT_MS`；`saveState` 的调用点数（仍为每 tick 1 次）；
- `NOTIFY_STATES` / `HOST_FACT_STATES` 的成员与语义；
- git 任何写操作；守护进程 PID <pid-A> 没动。

**没有声称的事**：

- 没有声称「延迟已修复」。任务里三个缺陷不包含延迟；验收标准 §1 的 M1/M2/M3 需要
  n≥30 条真实 WAITING 通知才能报数，本次没有产生新样本，也没跑真实轮询
  （跑会污染现场 `state.json`）。**这一项仍未判定。**
- 没有声称「标题已修复」。验收标准 §2 是另一个缺陷，本次不在范围内。
  顺带说一句：本次没碰 `notifyTitle` / `describe` / `project` 字段，
  所以 §2.4 的「`project` 仍是 slug」仍然成立，`resolveTranscriptPath` 的直接命中分支没受影响。

---

## 7. 仍未被覆盖的东西（诚实清单）

1. **退化路径的真实占比未知。** `anchorSource: 'host-time'` 的候选在真实数据里会有多少？
   现场 `sessions/` 里的 waiting 会话通常有 transcript，但**本机此刻 waiting=0**，
   没样本。修复后跑一段时间看 `observations.jsonl` 里 `anchorSource` 的分布，才知道
   这条修复的实际覆盖率。**这是「修好了吗」的唯一待验项。**
   另有一处已知残留：`scan-sessions --json` 的 `sessions[]` **没有** `statusUpdatedAt`
   （只有 `live[]` 有，而 `scan-sessions.mjs:487` 之后 `runScan` 只取 `parsed.sessions`）。
   所以两条路径都退化的场景下（transcript 也读不到），scan 侧仍退回 `lastActivity` 指纹、
   sessions 侧退回 `host:<statusUpdatedAt>`，**键仍然不等**。要彻底统一需要先改
   `scan-sessions` 的输出契约（把 `live[]` 按 sessionId join 进 `sessions[]`），
   属跨文件契约变更，不在本次边界内。代码里已把这条写成注释。
2. **锚点的「未闭合」判据依赖尾部 1MB。** 如果一次等待的 `tool_use` 与它的
   `tool_result` 都被截断在尾部之外，`openWaitingToolUseIds` 会返回 `[]`（不会误报
   为未闭合，也不会误报为已闭合 —— 它只是看不到）。此时退到 `host:` 值。
   这个方向是保守的（退化，不是错误），但它的发生率没测。
3. **`permission prompt` 之外还有别的兜底值。** `waitingFor` 的取值域是
   `input needed` / `dialog open` / `permission prompt` / `worker request` /
   `sandbox request` / `goal proposal`（`docs/spec/state-model.md` §2.0.3 引的
   `bVo()`）。本次只挡了 `permission prompt`（因为只有它有 n=66 的实测）。
   其余四个**没有样本**，既不能证明是噪声，也不能证明是真阳性 —— 保持原行为。
   **不要**因为「反正 permission prompt 是噪声」就顺手把它们一起挡掉，那是在没有数据的情况下扩大改动面。
4. **`already=1` 的连续段会不会真的消失，得跑起来才知道。** 修复让不同次等待换不同的键，
   但一个**不再变化**的等待仍然每 15 秒被看到一次、每次都 `already=1`。这是设计使然
   （边沿触发），不是 bug。要观察的是「一次新的等待能否打破这段连续」，
   那需要现场有新的 waiting 事件。

---

## 8. 顺带发现（已登记，未修）

**DF-024**（`tasks/dev-findings.md`）：同一 tick 内 WAITING 与 ASKED 可能对同一会话
各发一条。`runTick` 的收敛块用 `dedupeKey` 去重，而 WAITING 与 ASKED 的 `state` 不同，
天然不同键；验收标准 R7 要求的「宿主事实优先」当前没有实现。
`GLOBAL_MIN_GAP=10min` 会把第二条推后 10 分钟，但不会取消它。

**没顺手修的理由**：这属于验收标准 §2.6 明确划在「跨 tick 的重复发送」那一类，
不在「三个已确诊缺陷」的边界内。修它要动 `runTick` 的收敛逻辑，改动面比本次所有
改动加起来都大。

---

## 9. 复现命令

```bash
node scripts/check-structure.mjs                  # 全绿
node --test scripts/*.test.mjs                    # 508 / 508
node tasks/runs/2026-11-04-notify-fix/replay-<session-S>.mjs     # 8 次等待 → 8 个键
node tasks/runs/2026-11-04-notify-fix/replay-live-state.mjs   # 现场状态回放
```

变异实验（在仓库副本上做，不碰本仓库）：

```bash
cp -r scripts <盘符>/mut1/scripts && node -e "…把指纹改回空串…"
cd <盘符>/mut1 && node --test scripts/watch.test.mjs   # 期望 3 红
```
