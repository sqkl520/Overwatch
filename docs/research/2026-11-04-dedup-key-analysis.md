# 去重键系统梳理：五处产键、三类语义冲突，以及为什么不能改用 statusUpdatedAt

> 检索 Agent R6 · 2026-11-09 · 产出形态 exploration
> 全部结论附 `文件:行号` 或原始输出。未修改任何代码，未碰 git，未重启守护进程。
> 读取真实日志/状态走的是非虚拟化进程（`Invoke-CimMethod Win32_Process` → 落盘到盘根下的临时目录），
> 因为会话内直接读 `%LOCALAPPDATA%` 会落到 10-31 的影子快照（实测那份 `state.json` 停在 11-01 03:22）。

---

## 结论（先看这一段）

1. **产键的地方一共 5 处，不是 2 处。** 除了已知的 `probeWaiting`（sessions）和 `candidatesFromScan`（scan），
   还有 `probeJobs`（jobs）、`askedCandidates`（asked），以及观察日志自己的进程内去重集。
   前四处最终都汇进同一个 `dedupeKey()`（`scripts/watch.mjs:452`），差异只在**第四个参数传什么**。

2. **最危险的语义冲突不是"同一次等待报两次"，而是"不同次等待被算成同一个键"。**
   现状里有两个独立的漏报源：
   - `probeJobs` 与 `probeWaiting` **完全不产指纹**（传 `''`），所以键 = 会话 + 状态 + reasonClass。
     `reasonClass` 会把 `waiting:input needed` 和 `waiting:permission prompt` **压成同一个 `waiting`**
     （实测：两者算出 `3679ed23e2930d88`，完全相同）。同一会话第二次等待，宿主换了 `waitingFor`，
     键也不变 → **永久静默**。
   - `askedCandidates` 的指纹是**问题文本**（`watch.mjs:2362`）。同一个问题问两次（真实的第二次等待），
     键完全相同 → **永久静默**。实测两条不同 `nowMs` 的相同问题算出同一个键。

3. **实测统计（真实 `state.json`，72 条 notified）**：
   - 5 条来自 sessions、67 条来自 scan、0 条来自 jobs/asked；
   - **67 条 scan 条目对应只有 3 个「会话×等待事件」**（<session-T> 58 条、<session-S> 7 条、<session-U> 2 条）；
   - **3 条是"事件相同但键不同"造成的重复通知**（已实际发出）；
   - 65 条 `notifyCount=0`，其中 60 条被 `per-session-24h` 挡住 —— 去重表里绝大部分是
     **同一次等待被反复重新编号**留下的废条目，不是 72 个不同事件。

4. **不能改用 `statusUpdatedAt` 派生键。** 实测它在 waiting 期间**只写一次、不再推进**
   （<session-T> 从 09:18:21 到 09:36:45 连续 18 分钟一动不动，而 transcript 期间新增了数十条记录）。
   它表示的是"**状态最后一次变化**"，不是"一次等待"。用它做键会得到：一次持续 8 小时的等待 = 一个键
   → 与今天的 sessions 路径一样永久静默，只是把问题从"漏报第二次"扩大到"漏报所有后续"。
   它**唯一**的正确用途是当"这次等待何时开始"的时刻，而这需要一个能区分"第几次等待"的容器。

5. **推荐方案：键改用「宿主侧等待锚点」，即 transcript 里**未闭合的** `AskUserQuestion`/`ExitPlanMode`
   的 `tool_use_id`**，取不到时退回 `(sessionId, WAITING, statusUpdatedAt)` 元组并接受它只能覆盖一次。
   理由与实测见 §4.4。这是唯一"一次等待一个值、不同等待不同值"的字段，且**已被验证跨文件稳定**
   （同一个 id 在 3 个不同 transcript 文件里逐字相同）。

---

## 1. 枚举所有产键的地方

### 1.1 唯一的键构造函数

`scripts/watch.mjs:449-457`：

```js
export function dedupeKey(sessionId, state, reason, evidenceFingerprint = '') {
  return createHash('sha256')
    .update(`${sessionId}|${state}|${reasonClass(reason)}|${evidenceFingerprint}`)
    .digest('hex')
    .slice(0, 16);
}
```

`reasonClass`（`watch.mjs:442-447`）取 reason 里**第一个 `[a-zA-Z_][\w-]*` 前缀**：

```
reasonClass('waiting:input needed')      → 'waiting'      （实测）
reasonClass('waiting:permission prompt') → 'waiting'      （实测）
reasonClass('waiting:sandbox request')   → 'waiting'      （实测）
reasonClass('asked:decision')            → 'asked'        （实测）
reasonClass('asked:greeting')            → 'asked'        （实测）
reasonClass('host-reported-waiting')     → 'host-reported-waiting'（连字符在字符类里，不切）
```

**这就是第一处结构性缺陷**：`waitingFor` 的全部区分度（"在等输入" vs "在等权限" vs "在等 sandbox"）
在进键之前就被抹掉了。

### 1.2 五处产键点

| # | 位置 | 第四个参数（evidenceFingerprint） | 何时变 | 何时不变 | 键的层级 |
|---|---|---|---|---|---|
| ① | `probeWaiting` → 候选无该字段 → `watch.mjs:1609` 传 `undefined` → 默认 `''` | **恒为空串** | 永不 | 永远 | **会话+状态级**（最粗） |
| ② | `candidatesFromScan` → `watch.mjs:945` | `lastActivity` 的**数字位最后 10 位** | 该会话（含所有 subagent）有新的 tool_use 时 | 会话完全静止时 | **状态级**（每次新活动换一个键） |
| ③ | `probeJobs` → 候选无该字段 → `watch.mjs:1609` 传 `undefined` → `''` | **恒为空串** | 永不 | 永远 | **会话+状态级** |
| ④ | `askedCandidates` → `watch.mjs:2362` | **问题文本的最后 60 字符** | 问题文本变了 | 同一问题文本反复出现时 | **问题级**（不是事件级） |
| ⑤ | 观察日志进程内去重 → `watch.mjs:1265` | `${sessionId}\|${state}\|${kind}\|${fingerprint}\|${why}` **明文拼接**（不是哈希） | 同上 | 同上 | 进程级，重启即清 |

补注：
- ②的 `lastActivity` 来自 `scan-sessions.mjs:619`——`lastCall.ts`，即**该会话所有 tool_use
  （主 transcript + 最多 100 个子 agent）里时间最晚的那一个**。实测印证：<session-U> 在 21:41:58 那条
  scan 条目的指纹 `8214124821` 精确对应 `subagents/agent-aac2a585d58265af4.jsonl` 里
  `2026-11-08T21:41:24.821Z` 的 `tool_use:Bash`；21:57:22 那条的 `8215714004` 对应
  `subagents/agent-a6567aad33902e7a2.jsonl` 的 `2026-11-08T21:57:14.004Z`。
- ⑤ 是唯一"不哈希"的键，且它的 `fingerprint` 字段来自候选，所以它的去重语义完全继承 ①②③④。
- 还有两处**名字里带 fingerprint 但不参与 `state.notified`**：
  `scripts/stop-signals.mjs:154 toolFingerprint`（工具名+参数，用于 detectLoop）和
  `scripts/scan-sessions.mjs:62/120/121` 的 `sha()`（用于 signatureOf / isPersistentChange 判定）。
  这两处与去重表无关，列出来是为了排除"第三条产键路径"的误判。

### 1.3 键的写入与判定

`watch.mjs:1609-1619`：

```js
const key = dedupeKey(c.sessionId, c.state, c.reason, c.evidenceFingerprint);
const entry = state.notified[key];
if (entry && (entry.notifyCount > 0 || entry.delivery === 'failed')) {
  summary.already++;   // ← 从此永不再发，直到 24h TTL 到期
  ...
  continue;
}
```

`state.notified` 的条目结构（`watch.mjs:1655-1672`）：`sessionId / state / reason / kind /
firstSeenAt / lastNotifiedAt / notifyCount / ackAt / source / project / needs / suggestedReply /
idleSec / lastSeenAt`，命中后追加 `lastNotifiedAt / kind / delivery / suppressedBy`。

**过期规则**：`pruneNotified`（`watch.mjs:386-398`）从 **`firstSeenAt`** 算 24 小时，`loadState` 时清理
（`watch.mjs:371`）。**注意不对称**：`lastSeenAt` 只在条目**创建时**写一次
（`watch.mjs:1671`），命中路径从不刷新它 —— 实测 72 条里 `lastSeenAt === firstSeenAt` 的有 **72 条**（全部）。
后果：一次持续超过 24 小时的等待，条目会在第 25 小时被清掉，然后**同一个等待被重新通知一次**。
这是"重复通知"的第二个独立成因（与键设计无关，但与本次主题直接相关）。

---

## 2. 键的语义冲突全貌

### 2.1 同一次「等待」，不同路径算出的键相同吗？—— **不同**

实测（用真实 sessionId 复算，全部命中生产 `state.json`/`watch.log` 里已存在的键）：

```
<session-U> sessions 路径  3679ed23e2930d88   ← watch.log:4473（21:39:43 发出）
<session-U> scan 路径 A    4181354ebb8ac70c   ← state.json（21:41:58 首次出现）
<session-U> scan 路径 B    4991735d1f97e981   ← watch.log:4539（21:58:04 发出）
```

同一次等待（transcript 证实 21:39:32 `AskUserQuestion#call_00_hfp7bxx47de58gkt2jocs1h1` 提问，
22:18:20 才收到 tool_result），**三个不同的键，两次实际通知**。

用当前代码直接验证（`node -e` 调 `dedupeKey`）：

```
jobs key = 01d0142f0f0a9bd4 | scan key = 2799c5391525b826 | equal? false
scan 同一等待两轮: d72650267aa1ea89 6347d5ae3962b27e equal? false
```

跨层去重**完全不工作**。而项目里那条被当作护栏的测试
（`watch.test.mjs:702`「L-fast 与 L-full 报同一事件时只发一条（三层共享去重）」）之所以是绿的，
**不是因为键相等，而是因为 `GLOBAL_MIN_GAP = 10min` 把第二个候选挡在了 `canNotify`**
（`watch.mjs:504-507`）。实测把这条链路打出来：

```
tick1 n=1 sent=[key 01d0142f0f0a9bd4] suppressed=[key f7cfbee87a9fb5b5 why=global-10min] already=0
tick2（+11 分钟）n=2 sent=[key 33835a58a73120a1] already=1
=> 同一事件被发了 2 次
```

**这是本次最值得记的一条**：测试名宣称"三层共享去重"，实际验证的是"限额挡住了第二条"。
键不相等这件事被限额掩盖了整整一个版本。

### 2.2 不同次「等待」，会不会算出相同的键？—— **会，这是静默漏报**

**(a) 同一会话第二次等待，`waitingFor` 变了，键不变。**

`reasonClass` 把 `waiting:input needed` 与 `waiting:permission prompt` 都压成 `waiting`，
而 sessions 路径的指纹恒为 `''`。实测：

```
<session-T>  sessions perm : d7b87f3d21e96c0f
<session-T>  sessions input: d7b87f3d21e96c0f   ← 完全相同
```

后果（真实数据）：`<session-S>` 的 sessions 条目 `771d542c73df3fb3` 在 `19:31:49` 发出后，
transcript 里又发生了 **4 次真实等待**（19:31:35 / 20:07:28 / 20:58:29 / 22:33:08，三个
`AskUserQuestion` 加一个 `ExitPlanMode`）—— 除了其中一次被 scan 路径"歪打正着"补发，
其余全部落在同一个键下，**永久静默**。`watch.log` 里能直接看到 22:34 之后的连续压制：

```
2026-11-08T22:34:05Z ... candidates=1 sent=0 suppressed=0 already=1 observed=1(WAITING:1)
...（连续 2213 个 tick，直到 2026-11-09T08:18:42Z）
```

这一段连续压制 **585 分钟**，是全部日志里第二长的静默段（最长一段 735 分钟，2026-11-01→11-02）。

**(b) `asked` 路径：同一问题问两次 → 同键。**

```
同一问题的两次等待 -> 同键? true
```

指纹是问题文本（`watch.mjs:2362`），刻意排除了时间（`watch.mjs:2332-2333` 的注释说明这是
DF-022 之后的决定）。方向对，但粒度过粗：**"同一个问题被问第二次"是一次真实的新等待**，
在这里被算成同一次。

**(c) 指纹编码本身就丢了一天以上的信息。**

`watch.mjs:945` 的 `.slice(-10)` 取 ISO 串数字位的**最后 10 位**，即 `MMDDhhmmss`。
实测：

```
2026-11-08T21:41:24.821Z -> fp = 8214124821
2026-11-18T21:41:24.821Z -> fp = 8214124821   ← 相同
2026-10-28T21:41:24.821Z -> fp = 8214124821   ← 相同
```

年、月的一部分被截掉了。这不是当前漏报的主因（TTL 24h 挡住了跨月场景），
但它意味着**指纹不是一个能唯一标识时刻的量**，不能当作"事件 id"用。

### 2.3 三条路径的键分布（真实 `state.json`，n=72）

```
按 source: { sessions: 5, scan: 67 }        ← jobs 0、asked 0
按 state : { WAITING: 72 }                  ← 全部
```

按 `(sessionId, state, reasonClass)` 分组：

```
<session-W>  WAITING waiting   1 个键（sessions）
<session-S>  WAITING waiting   8 个键（1 sessions + 7 scan）
<session-V>  WAITING waiting   1 个键（sessions）
<session-T>  WAITING waiting  59 个键（1 sessions + 58 scan）
<session-U>  WAITING waiting   3 个键（1 sessions + 2 scan）
```

**72 个键 → 5 个会话 → 实际上只有 3 次被通知过的等待事件。**

---

## 3. 实测当前生产状态

数据源：真实 `%LOCALAPPDATA%\Overwatch\state.json`（43166 字节，2026-11-09T16:30:09 本地时间）
与 `watch.log`（871843 字节，覆盖 2026-10-31 19:28 → 2026-11-09 08:30 UTC）。

### 3.1 `notified` 表规模与形态

- **72 条记录**，全部 `state=WAITING`。
- 键形态只有两种（与 §1.2 的 ①②③④ 对应，其中 ③④ 本期零样本）：
  - `sessions(noFp)` 5 条 —— 全部可复算（用 `''` 作指纹，5/5 命中）；
  - `scan(lastActivity)` 67 条 —— 指纹均为 10 位数字串（`observations.jsonl` 里 67 条 `scan` 行的
    `fingerprint` 长度分布：`10ch × 67`）。

### 3.2 「键相同但实际是不同事件」—— 有多少

**5 个 sessions 键全部属于这一类**（因为它们不含任何事件区分信息）。逐一给出证据：

| 键 | 会话 | 该键覆盖的等待事件（transcript 实证） | 是否漏报 |
|---|---|---|---|
| `ae4c82b3fa8bb605` | <session-W> | 0 次后续等待 | 否 |
| `771d542c73df3fb3` | <session-S> | **4 次**（19:31:35 / 20:07:28 / 20:58:29 / 22:33:08） | **是** |
| `301544b3341ff8e0` | <session-V> | 0 次（`notifyCount=0`，从未发出） | 否 |
| `d7b87f3d21e96c0f` | <session-T> | 0 次（该会话 11-08 只有 1 次真人回复） | 否 |
| `3679ed23e2930d88` | <session-U> | **1 次**（21:39:32 —— 因 `firstSeenAt` 是 20:10:24，键在 20:10 就已创建） | 部分（该次由 scan 路径补发，见 §2.1） |

**保守计数：5 条里有 1 条确定为静默漏报了 4 次真实等待**（<session-S>），
另有 1 条（<session-U>）在语义上覆盖了 1 次但被另一条路径意外补上。
`asked` 路径本期 0 条生产样本，但 §2.2(b) 已用代码实测证明它会同键。

### 3.3 「事件相同但键不同」—— 有多少

**3 条已实际发出的重复通知**（同一会话、同一 `waiting:` reasonClass、`sessions` 已发过之后
`scan` 又发了一次）：

```
<session-T>  a2fb30d72034f971  20:03:57   晚于 sessions 通知 19:50:33
<session-S>  81bf69236a306942  21:00:43   晚于 sessions 通知 19:31:49
<session-U>  4991735d1f97e981  21:57:22   晚于 sessions 通知 21:39:37
```

外加 **64 个多余键**：67 条 scan 条目里，只有 3 条真正发出过（`notifyCount=1`），其余 64 条
是同一次等待被反复重新编号留下的空壳（`notifyCount=0`）。
被压制的分布：`per-session-24h` 60 条、`global-10min` 5 条、无 `suppressedBy` 7 条（= 发出去的）。

### 3.4 一个会掩盖统计的细节

`state.notified` 同时承担两个职责：去重表 **和** 收件箱的唯一持久化来源
（`watch.mjs:1665-1666` 的注释明确说了这一点，`buildInbox` 在 `watch.mjs:2176` 直接遍历它）。
所以"清理废条目"不是纯粹的卫生问题——**删条目等于删收件箱历史**。
任何键重构都必须同时说明 `buildInbox` 的迁移策略。

---

## 4. 评估「改用 statusUpdatedAt 派生」这个方案

### 4.1 statusUpdatedAt 是什么

`probeWaiting` 读 `sessions/*.json`（`watch.mjs:593`）：

```js
const updated = Number(s.statusUpdatedAt ?? s.updatedAt ?? 0);
```

它同时被当作 **候选的 `updatedAt`**（`watch.mjs:606`）和 **`idleSec` 的基准**（`watch.mjs:607`），
还被用作活跃窗口过滤（`watch.mjs:596`）。

### 4.2 事实 4 的"滞留 115 分钟"是真的，但要分清两种情况

**实测（多轮采样，非虚拟化进程无关——`sessions/` 目录本身不在虚拟化范围内，直接可读）：**

情况 A —— **状态未变时它完全不推进**：

```
09:35:38 waiting 09:18:21
09:35:50 waiting 09:18:21
...
09:36:45 waiting 09:18:21     （连续 6 次采样，18 分钟内一字不动）
09:36:58 busy    09:36:50     ← 状态一变，立刻跳到 09:36:50
```

同期该会话 transcript 新增了数十条记录（09:18→09:36 之间有多轮 Bash tool_use/tool_result），
所以这不是"会话没动"，是**宿主只在 status 字段变化时才写这个时间戳**。

情况 B —— **waitting 期间的"滞留"可以有 60-100 分钟**：

```
08:45:16 waiting  （在等 permission prompt）
...            （transcript 持续活动，多条 tool_result 带 permissionDecision=accept）
10:12:13 waiting  （数值跳到这里，仍是 waiting）
```

一次 waiting 里数值跳了两次（08:45:16 → 09:18:21 → 10:12:13），间隔分别 33 分钟和 54 分钟。
说明宿主在某些事件上会重写它（推测与 permission 重算 / 队列变化有关），但**没有任何文档保证**，
且**不能指望它在每次新等待时都推进**。

### 4.3 所以用它派生的键会怎样

- **如果它在一次等待里不变**（情况 A 已实测 18 分钟不变）→ 键不变 → **同一次等待只发一次**（正确），
  但**第二次等待如果宿主重置了 status（busy→waiting），值会变**（09:36:50 那次证明会变）→ 键变
  → **能发出第二次**。
- 但 `statusUpdatedAt` 的语义是"状态最后一次变化"，**它不含"这是第几次等待"**。
  在一次持续 8 小时的 waiting 里如果宿主因为任何内部原因重写它（情况 B 实测 33/54 分钟就会重写），
  **同一次等待会被当成新的，重新通知**。
- 更硬的问题：**`scan` 路径根本没有这个字段。** 实测候选字段清单：

```
candidatesFromScan 产出的候选字段: sessionId,state,reason,project,needs,idleSec,lastActivity,evidenceFingerprint,suggestedReply,source
有 statusUpdatedAt 吗: false
```

`scan-sessions --json` 的 `sessions[]` 行里也**没有** `statusUpdatedAt`
（只有 `live[]` 数组有，`scan-sessions.mjs:487`；而 `runScan` 只取 `parsed.sessions`，
`watch.mjs:914-915`）。所以"两条路径都产这个键"需要先改 `scan-sessions.mjs` 的输出契约
**并**把 `live[]` 按 sessionId join 进 `sessions[]`——这是一次跨文件契约变更。

- 我还实测了这个方案的完整形态（sessions 与 scan 两路都从 `statusUpdatedAt` 派生指纹）：
  **全量测试 497 条全绿**，且 `sessions` 与 `scan` 两路的键**确实会相等**：

  ```
  字段都在时:  sessions key = c1be79800b525add  scan key = c1be79800b525add  相等? true
  ```

  但另外两个路径拿不到这个字段：

  ```
  scan 行缺字段时（现状 scan-sessions 不输出该字段）: key = 5346a15e9ca15fbd  相等? false
  jobs 路径（jobs/*/state.json 根本没有这个字段）:    key = f1e393c897fdd5a0
  ```

  **结论：这个方案能治"同一次等待报两次"，前提是先改 `scan-sessions.mjs` 的输出契约；
  但它治不了"不同次等待被合一次"，而且对 `jobs` 路径无效。**

### 4.4 明确推荐

**不要用 `statusUpdatedAt` 派生去重键。** 理由：

1. 它是**状态级**字段（"状态最后一次变化"），不是**事件级**字段（"第几次等待"）。
   用它当键 = 承认"一次等待只值一个键" = 保留今天 <session-S> 那种漏报。
2. 它在等待期间会被宿主无规律重写（实测 33 分钟、54 分钟各一次），
   所以连"一次等待一个键"这个弱保证都不成立——它可能变成"一次等待 N 个键"。
3. `scan` 路径没有它，需要跨文件契约变更才能"两路都用"。

**推荐：用 transcript 里「未闭合的等待型 tool_use」的 `tool_use_id` 作为锚点。**

为什么是它：

- **它天然是"一次等待"**：`AskUserQuestion` 和 `ExitPlanMode` 各自代表一次明确的"我停下来等你"。
  闭合（收到 `tool_result`）就是这次等待结束。下一次等待必然是一个**新的 id**。
- **实测跨文件稳定**：同一个 id 在多个 transcript 里逐字相同，包括被复制/汇总到别的会话文件里的情况：

```
f932 21:39  call_00_hfp7bxx47de58gkt2jocs1h1 -> FOUND in 3 file(s): agent-a17cfc38..., agent-ac1d420d..., <session-U>....
356e 19:31  call_00_if5tgmla8pwunmkskdwy4i03 -> FOUND in 2 file(s): <session-S>..., agent-a17cfc38....
36b9 19:21  call_00_1y6hlav7a51z7iwelqfr9pbl -> FOUND in 2 file(s): <session-V>..., agent-a17cfc38....
```

- **它区分得开同一会话的连续等待**：实测 `<session-S>` 在 11-01→11-09 有 13 个 `AskUserQuestion`，
  id 全不相同；`<session-T>` 的 permission 等待期间，未闭合的 `tool_use` 是
  `call_00_btzzx2bdi80dtot1bcq77tkw`（19:28:31 Bash）→ `call_00_15rplywxeoq8pqodc139mjvo`
  （19:49:19）→ `call_00_md533n95ggbz8i1hwwwgjpv0`（19:59:43）→ …… 每一次都不同。
- **它不需要新接口**：`classify-stop.mjs` 已经在读 transcript 尾部并提取 `tool_use`
  （`classify-stop.mjs:425-430`，`evidence.stopUuid` / `evidence.lastToolUse`），
  `readTranscriptTail` 已有 1MB 尾部预算（`watch.mjs:1045`）。把"未闭合的等待型 tool_use id"
  加进候选是一处小改动。
- **它有明确退化路径**：读不到 transcript（sessions 里有 waiting 但 transcript 不在）时，
  退回 `(sessionId, WAITING, statusUpdatedAt)` 元组。这正是今天 sessions 路径的行为，
  **不会比现在更差**，而且是可检测的（候选上标一个 `anchorSource: 'transcript' | 'host-time'`，
  便于事后统计覆盖率）。

**成本与风险（必须一并说明）：**

- `probeWaiting` 目前**不读 transcript**（它只读 `sessions/*.json`，15 秒一轮，8ms）。
  为它加一次 transcript 尾部读，会把 L-fast 的成本从 ~8ms 抬到"每个 waiting 会话一次文件读"。
  实测 waiting 会话数为 0~1（当前为 0），所以**常态下接近零成本**，但这是新增的 I/O 路径，
  必须在实现时按"只有 waiting 候选才读"来设计。
- `scan` 路径已经在读 transcript（`scan-sessions`），加这一步是顺路。
- `asked` 路径已经在读 question 文本，改成"取 `AskUserQuestion` 的 tool_use_id"是**更准而不是更贵**。
- **不推荐用"最后一条记录的时间戳"**：实测它就是 `lastActivity`，也即今天 scan 路径的输入，
  已被证明会在等待期间不断变化（一次等待裂成 N 个键，见 §2.1 的 4181354ebb8ac70c / 4991735d1f97e981）。
- **不推荐用 `AskUserQuestion` 的 `uuid`**（记录级 uuid）：实测同一次 tool_use 会以**两行**
  出现（一行带 `timestamp`、一行 `timestamp: undefined`——那是重写留下的），
  而 `tool_use_id` 在两行里相同。`tool_use_id` 才是稳定锚点。

---

## 5. 受影响的测试

### 5.1 直接依赖去重键的测试

`grep` 结果（`scripts/*.test.mjs`）：

- **直接调用 `dedupeKey()` 的：`watch.test.mjs` 12 处调用，分布在 5 个 test 里**
  （第 55、80、82、86-87、92-95、202、224 行）：
  - `AC2 去重：同一个键只通知一次，喂 3 次相同状态只出 1 条`（:37）
  - `AC2 去重：reason 变化视为新事件`（:60）
  - **`AC2 去重键：sessionId | state | reasonClass | evidenceFingerprint 的 sha256 前 16 位`（:79）**
    —— 这一条**逐字断言了键的构成**（"state 变 → 新键"、"reason 类别变 → 新键"、
    "sessionId 变 → 新键"、"证据指纹变（卡在别处）→ 新键"、以及"novelty 数字不同但同类，键必须相同"）。
    改键构造方式，**这一条必然红**。
  - `AC5 notify 抛错时退回仅记录…`（:180，用 `dedupeKey('x','FAILED','host-reported-failed')` 查条目）
  - `AC1/状态格式：写出的 JSON 含文档要求的全部字段`（:217，用 `dedupeKey('s','FAILED','r')` 建条目）
- **直接构造 `state.notified[...]` 的：3 个 test**（:225、:238、:1244-1245）+ 断言空表的 :262。
- **给候选传 `evidenceFingerprint` 的：18 处**（分布在时间门/分类门/宿主事实那批端到端测试里）。

### 5.2 我实测跑过的变异（在仓库副本上，未动真实仓库）

复制仓库到盘根临时目录下的四个副本（`owA` / `owcopy2` / `owcopy3` / `owcopy4`），逐个变异后跑全量：

| 变异 | 全量测试 | 行为验证（同一事件跑两轮 tick） |
|---|---|---|
| **V1** sessions 路径也产指纹（`lastActivity` 数字派生） | **497 / 497 绿** | **发 2 次（错误）** —— scan 指纹随 subagent 漂移 |
| **V2** 指纹整个不参与键（`void evidenceFingerprint`） | **496 绿 / 1 红** | 只红 `AC2 去重键：…sha256 前 16 位`（:79） |
| **V3** sessions 用 `String(updated)`、scan 用 `statusUpdatedAt \|\| lastActivity` | **497 / 497 绿** | **发 2 次（错误）** —— 两条路径派生的源字段不同 |
| **V4** scan 路径不再产指纹（两路键一致） | **497 / 497 绿** | **发 1 次（正确）** |
| **V5** 两路统一用 `statusUpdatedAt`，且给 scan 行补上该字段 | **497 / 497 绿** | `sessions` 与 `scan` 的键**相等**（实测 `c1be79800b525add` == `c1be79800b525add`）；但 `jobs` 路径拿不到该字段，仍是不同键 |

**结论：改键的构造方式最多红 1 条测试。** 现在的测试套件对这件事的覆盖是**不及格的**——
它只钉住了 `dedupeKey` 这个纯函数的形状，没有钉住"同一次等待在两个路径下必须同键"、
"不同次等待必须不同键"这两条真正重要的性质。

**V4 值得单独记一句**：它是所有变异里最小的一个（把 `watch.mjs:945` 的指纹改成 `''`），
全量测试全绿，而它**真正修好了跨层重复**（发 1 次）。
这反过来说明：那条"L-fast 与 L-full 报同一事件时只发一条（三层共享去重）"的测试
（`watch.test.mjs:702`）在当前代码下**也是靠限额才通过的**——
它的断言 `n===1` 在 `GLOBAL_MIN_GAP=10min` 下成立，把限额调成 0 就会看到 2 次。

### 5.3 需要新增的测试（建议，本次不实现）

1. **同一次等待、两条路径 → 同键**：构造一个候选同时经 `probeWaiting` 和 `candidatesFromScan`
   产出，断言 `dedupeKey` 相等。今天这条会红（`01d0142f0f0a9bd4 ≠ 2799c5391525b826`）。
2. **同一会话两次等待 → 不同键**：用真实 transcript 片段（两个不同的 `AskUserQuestion` id），
   断言两次算出的键不同。今天这条会红（<session-S> 的 4 次等待共用一个键）。
3. **`waitingFor` 变 → 键必须变**：断言 `waiting:input needed` 与 `waiting:permission prompt`
   得到不同键。今天这条会红（都是 `3679ed23e2930d88`）。
4. **`asked` 同问题第二次 → 键必须变**：今天这条会红（§2.2(b) 已实测 `true`）。
5. **跨层去重不依赖限额**：现有 `watch.test.mjs:702` 的断言 `n===1` 是在限额挡下成立的，
   应改成"把 `GLOBAL_MIN_GAP` 设为 0 后仍只有 1 条"。

---

## 6. 附带发现（不在任务范围内，但会直接影响本次判断）

1. **`lastSeenAt` 从不刷新**（§1.3）。72 条条目全部 `lastSeenAt === firstSeenAt`。
   这使 TTL 以"首次发现"计时：**一次持续超过 24 小时的等待会在第 25 小时被重新通知一次**。
   `<session-U>` 的 `3679ed23e2930d88` 的 TTL 到点是 `2026-11-09T20:10:24Z`——写这份报告时它已过期，
   如果那个会话再次进入 waiting，会重新弹一次。

2. **`buildInbox` 与去重表共用一个容器**（§3.4）。任何键重构都必须同时考虑收件箱。

3. **`state.json`（43166 字节）里 `notified` 占 30601 字符、`probe` 占 1785 字符（32 个项目）**。
   `probe` 是 mtime 快照，与本次主题无关；但它说明体积大头是去重表，不是探针。

4. **会话被"改名"时标题会变、键不变**：`<session-U>` 在 21:39 的标题是 `style`（来自
   `sessions/*.json` 的 `cwd` basename），21:58 的标题是 `<project-I-slug>`（来自 scan 的 project slug）。
   这正是 `docs/spec/2026-11-04-notify-fix-acceptance.md §2.6` 记录的 F2。**该文档的判断是对的**：
   它明确写了"修标题不会消掉重复发送，去重键的统一是另一件事"。本次实测确认了这一点。

5. **检查结构硬门当前是红的**（与本次工作无关，是既有状态）：
   `[docs/design/README.md] 2026-11-04-next-phase-plan.md 没有被索引提到`。
   我没动它，只报告。

---

## 附：本次实测所用的非虚拟化读取方式

```powershell
# 1) 写一个 .ps1 到**非虚拟化路径**（盘根下的临时目录，不能用 %TEMP%）
# 2) 用 Win32_Process.Create 启动它，输出重定向到文件
$p = @{ CommandLine = "cmd.exe /c powershell.exe -NoProfile -ExecutionPolicy Bypass -File <非虚拟化路径>\grab.ps1 > <非虚拟化路径>\out.txt 2>&1" }
Invoke-CimMethod Win32_Process -MethodName Create -Arguments $p
```

注意两点（都踩过）：
- **不要**在 `-Command "..."` 里嵌套多层引号——实测会静默不执行。写成 `.ps1` 文件最稳。
- `%TEMP%` 目录本身也在虚拟化范围内，输出必须落到**盘根下自建的目录**这类非虚拟化路径才读得到；
  且要 `cmd.exe /c` 包一层，否则重定向不生效。

实测对比：虚拟化视图里 `%LOCALAPPDATA%\Overwatch\state.json` 是 43166 字节但内容停在
**2026-11-01 03:22**（`watch.log` 41857 字节，同样停在 11-01）；非虚拟化视图里同一个文件是
**871843 字节，覆盖到 2026-11-09 08:30**。两者文件名相同、大小不同——只看大小会以为读到了真数据。
