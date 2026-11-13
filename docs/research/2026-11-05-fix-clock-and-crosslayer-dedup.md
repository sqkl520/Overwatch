# 修掉「定时翻红」的时钟注入缺陷，并把跨层去重真正统一

> 修复 Agent F5 · 2026-11-10 · 产出形态 artifact（代码 + 测试）
> 前置诊断：`docs/research/2026-11-05-dedup-test-failure.md`（下称「诊断报告」）
> 未碰 git。未修改 `scripts/verify-claims.mjs`、`scripts/asked.mjs`、
> `scripts/oversight-tui.mjs`、`scripts/tui-theme.mjs`。
> 读真实 `%LOCALAPPDATA%\Overwatch\` 走非虚拟化进程（PowerShell 落盘到 `%TEMP%` 再读）。

---

## 结论（先看这一段）

**测试从 582/1 红变成 588/588 全绿**；`check-structure.mjs` 通过；
`verify-bugfix-negatives.mjs` **18/18** 处回退都让预期测试变红。

**缺陷 1（时钟注入不彻底）修了 3 处**：
`loadState` 接受 `nowMs`、`runTick` 传下去、`probeMtime` 删掉一行从未使用的 `Date.now()`。
另外 `scan-sessions.mjs` 这个**子进程**也在自取挂钟，加了 `--now` 注入通道。

**缺陷 2（跨层去重）的根因比诊断报告里写的更深一层。** 诊断报告说的是「两路指纹源字段
不同」，这是对的，但**只改 `candidatesFromScan` 修不好**：`statusUpdatedAt` 这个字段
**在扫描输出里根本不存在**（`scan-sessions.mjs` 的 `sessions[]` 行不带它，只有 `live[]` 带），
所以那条「退化到 `host:<statusUpdatedAt>`」的分支在现状下是**死代码**。
真正的修法是三处联动：让扫描行带上宿主字段、把事件时刻解析抽成两源共用的模块、
让候选层只在一处决定 WAITING 的锚点。

**跨层统一后的实测证据**：用真实生产 transcript + 真实 `~/.claude/sessions/*.json`
跑两路，`a80c452d` 与 `f932d1d4` 的 sessions 键与 scan 键 **equal=true**（改动前不等）。

---

## 1. 缺陷 1：时钟注入不彻底

### 1.1 改动

| # | 文件:位置 | 改动 |
|---|---|---|
| 1 | `scripts/watch.mjs` `loadState` | 签名 `{ logger }` → `{ logger, nowMs = Date.now() }` |
| 2 | `scripts/watch.mjs` 原 `:371` | `pruneNotified(state.notified, Date.now())` → `pruneNotified(state.notified, nowMs)` |
| 3 | `scripts/watch.mjs` `runTick` | `loadState(stateDir, { logger: log })` → `{ logger: log, nowMs }` |
| 4 | `scripts/watch.mjs` `probeMtime` | 删掉 `const now = Date.now()`（**从未被使用**，是下一个定时炸弹的种子） |
| 5 | `scripts/scan-sessions.mjs` `main` | 新增 `--now <ISO>`；`cutoff` / `judgeState` / `idleSec` / `mergeJobRows` 全用它 |
| 6 | `scripts/watch.mjs` `runScan` | 新增 `nowMs` 参数，非空时以 `--now` 传给子进程；`runTick` 的两个 `scan({...})` 调用点都传 |
| 7 | `scripts/watch.test.mjs`（原 `:769`） | `loadState(dir)` → `loadState(dir, { nowMs: now })` |

第 5/6 项不在诊断报告的清单里。它是**同类缺陷的另一半**：`runTick` 拿到注入时钟，
但它 spawn 出去的 `scan-sessions.mjs` 自己调 `Date.now()`。于是同一轮里
`candidatesFromScan` 的活跃窗口用注入时钟、扫描输出的 `idleSec` 用真实时钟——
两段时间基准打架时，同一份数据会在不同 tick 被判定成不同 `idleSec`，
而 `idleSec` 会进通知正文（`idle=916m` 那类可读数字）。

**全仓扫的结果**（`runTick` 调用链内）：
`watch.mjs` 里含 `Date.now()` 的匹配 20 处，15 处是正确的默认参数写法。
剩下 5 处逐个核过：
- 原 `:371` —— 本 bug，已修；
- `probeMtime` 内的 `const now` —— 未使用，已删；
- `:2550` / `:2564`（`--stats` / `--inbox` CLI 入口）、`:2162`（注释）—— 正常用法，不动。
新增发现：`scan-sessions.mjs` 有 4 处（`cutoff` / `judgeState` 调用 / `idleSec` / `mergeJobRows`），
全部已走 `--now`。

### 1.2 为什么必须同时改测试那一处

诊断报告已经用四组合实测说清楚了（只改实现仍红、只改测试仍红）。
我在修完后复核了这一点：`loadState` 的剪枝发生在**两处**——`runTick` 内部一次、
测试自己读 state 时一次。后者不是「测试写错了」，它是一处合法调用，
只是此前这个函数不接受 `nowMs`。修好后它就该传。

**`assert.equal(n, 1)` 一个字都没动。**

---

## 2. 缺陷 2：跨层去重

### 2.1 为什么同一个等待会算出两个键（逐条实测）

| 层 | 指纹来源（修复前） | 语义 | 什么时候变 |
|---|---|---|---|
| sessions（`probeWaiting`） | `wait:<tool_use_id>`，取不到 → `host:<statusUpdatedAt>` | 「哪一次等待」 | 新 `tool_use_id` 出现时 |
| scan（`candidatesFromScan`） | `lastActivity` 的数字位后 10 位 | 「会话最后一次活动」 | 会话有**任何**新活动时 |

两者**语义就不同**，因此在物理上必然分叉。诊断报告给出的生产证据里，
`f932d1d4` 的 sessions 条目 `3679ed23e2930d88`（指纹为空串 + `waiting` 的旧形态）
与 scan 条目 `4991735d1f97e981` 就是这一对。

**我额外核出的一层**：`candidatesFromScan` 里那条「`statusUpdatedAt` 存在就退化成
`host:<ts>`」的分支，**在现状下永远不会触发**——因为 `scan-sessions.mjs` 的
`sessions[]` 行根本没有 `statusUpdatedAt` 字段（只有 `live[]` 有，而 `runScan` 只取
`parsed.sessions`）。代码注释自己也承认这一点（原 `watch.mjs:1019-1023`
「这条退化分支在现状下基本不触发」）。

所以**「两路都用 `waitingAnchor`」这个方向是对的，但不够**：`waitingAnchor` 是要靠
transcript 才拿得到的，而生产上大量 WAITING 会话已经没有未闭合的等待型 `tool_use`
（实测两个生产会话 `f932d1d4` / `a80c452d` 的 transcript 尾部都返回 `openIds = []`）。
一旦 transcript 锚点取不到，两路仍然会落到不同的退化值上。

### 2.2 统一方案（三处，缺一不可）

**① 扫描行带出宿主字段** —— `scripts/scan-sessions.mjs` 新增 `hostFieldsOf(live)`：

```js
export function hostFieldsOf(live) {
  const waitingFor = typeof live?.waitingFor === 'string' ? live.waitingFor : null;
  const at = Number(live?.statusUpdatedAt);
  return { waitingFor, statusUpdatedAt: Number.isFinite(at) && at > 0 ? at : null };
}
```

`sessions[]` 行现在带 `waitingFor` / `statusUpdatedAt`。这让 `candidatesFromScan`
的退化分支第一次真正可用。

**② 事件时刻解析抽成共享模块** —— `scripts/job-event-time.mjs`：

`requestIdTime` / `lastTimelineStateTime` / `resolveJobEventTime` 从 `watch.mjs`
原样搬出。`watch.mjs` 仍 `export { ... } from './job-event-time.mjs'`，
公开 API 与所有既有测试不变。

`scan-sessions.mjs` 侧新增唯一实现 `scanCrossLayerFingerprint({ hostState, job })`，
`jobToRow`（只有 job 的行）与主循环里「有 transcript 的 FAILED/BLOCKED 行」**都调它**。
于是 FAILED / BLOCKED 两路必然得出同一个 `job:<事件时刻>`。

**③ WAITING 的锚点只由一处决定** —— `candidatesFromScan`：

```js
const given = typeof s.evidenceFingerprint === 'string' ? s.evidenceFingerprint : '';
if (given.startsWith('job:') || given.startsWith('wait:')) {
  fingerprint = given;                      // 上游确定算好了，原样用
} else if (s.state === 'WAITING') {
  // 唯一一处决定 WAITING 的锚点：transcript 的 wait:<id>，退化 host:<statusUpdatedAt>
}
```

**为什么只认 `job:` / `wait:`，不放行 `host:` / `activity:`**：
我在第一版实现里让扫描行对 WAITING 也产 `host:<statusUpdatedAt>`，并在候选层原样透传。
实测发现这会让**跨层重新分叉**——sessions 侧走 `probeWaiting` 算得出 `wait:call_X`，
scan 侧却抄了个 `host:<ts>`，两路键又不等；而两边「都有指纹」会让这个分叉看起来像已统一，
**比两边都没有指纹更难发现**。这是我这一轮引入又自己抓到的缺陷，记在这里。
规则：能算出指纹的地方有两处，就必须指定唯一一处负责，另一处只提供原料。

### 2.3 统一前后的实测对比

**生产数据源**：非虚拟化进程拷出的真实 `state.json`（73 条 `notified`，7 条
`notifyCount>0`），加上真实的 `~/.claude/projects/**` transcript 与
`~/.claude/sessions/*.json`。

**统一前**（真实 `state.json` 里实际发出过的通知）：

```
2026-11-08T19:16:31.799Z d612c386 sessions ae4c82b3fa8bb605
2026-11-08T19:31:49.101Z 356e31e9 sessions 771d542c73df3fb3
2026-11-08T19:50:33.879Z a80c452d sessions d7b87f3d21e96c0f
2026-11-08T20:03:57.160Z a80c452d scan     a2fb30d72034f971
2026-11-08T21:00:43.990Z 356e31e9 scan     81bf69236a306942
2026-11-08T21:39:37.862Z f932d1d4 sessions 3679ed23e2930d88
2026-11-08T21:57:22.468Z f932d1d4 scan     4991735d1f97e981
```

**3 对**「同一会话、两个键、两次都真的发出去了」：

| 会话 | sessions 键 @ 时刻 | scan 键 @ 时刻 | 间隔 |
|---|---|---|---|
| `f932d1d4` | `3679ed23e2930d88` @ 21:39:37 | `4991735d1f97e981` @ 21:57:22 | 17.7 分钟 |
| `a80c452d` | `d7b87f3d21e96c0f` @ 19:50:33 | `a2fb30d72034f971` @ 20:03:57 | 13.4 分钟 |
| `356e31e9` | `771d542c73df3fb3` @ 19:31:49 | `81bf69236a306942` @ 21:00:43 | 88.9 分钟 |

（诊断报告写的是 2 对；把 `356e31e9` 也算上就是 3 对——那一对的 reason 两条都是
`waiting:input needed`、间隔 88.9 分钟，同属「同一次等待被两层各报一次」的形态。）

**统一后**（真实 transcript + 真实 `sessions/*.json` 跑两路）：

```
a80c452d sessions=host:2026-11-09T22:54:56.288Z(host-time) key=6215e1d517d7a76e
         scan    =host:2026-11-09T22:54:56.288Z(host-time) key=6215e1d517d7a76e  equal=true

f932d1d4 sessions=host:2026-11-10T00:00:06.144Z(host-time) key=ade4b32afbd145e7
         scan    =host:2026-11-10T00:00:06.144Z(host-time) key=ade4b32afbd145e7  equal=true
         旧 scan 键 05f20f0daf25b308 → 与 sessions 相等? false
```

**有 transcript 等待锚点时的同一次验证**（造一个未闭合 `AskUserQuestion`）：

```
sessions: wait:call_ABC ( transcript )
scan    : wait:call_ABC ( transcript )
equal = true | key = 41eb2a839d66d201
```

**FAILED / BLOCKED 跨层**（真实 `~/.claude/jobs/`，两源各自的真实读取路径）：

```
scan 行   7710fbdb BLOCKED job:2026-10-08T09:45:33.518Z jobs-timeline
scan 行   a9fa4c62 BLOCKED job:2026-10-05T15:57:00.000Z jobs-request-id
```

与 `probeJobs` 的事件时刻逐字相同（`resolveJobEventTime` 的同一份实现）。

### 2.4 那条断 `why === 'global-10min'` 的测试

按预期变红，已更新。原断言是「第二条被最小间隔挡下」，新断言是
`suppressed.length === 0`：键相等时第二条在 **runTick 的轮内去重**阶段就消失了，
**没有一条走到限额**。标题也从「挡住第二条的是限额，不是键相等」改成
「现在靠键相等，不再靠限额」。

这不是放宽标准——是断言指向了更强的事实。旧断言证明的是「限额兜住了重复」，
新断言证明的是「重复根本不产生」。

---

## 3. 负向测试（实测）

### 3.1 新增的负向测试

| 测试 | 钉住什么 |
|---|---|
| `loadState 必须用注入的 nowMs 剪枝，不得用真实挂钟` | 把 `Date.now()` 装回 `loadState` 立刻红。**不依赖「挂钟刚好走过 TTL」这个巧合。** 同时断言「TTL 之外的条目仍必须被清掉」——防止为了修时钟把剪枝整个关掉 |
| `防定时炸弹：锚点在 10 年后，同一 WAITING 事件仍只通知一次` | 锚点 `2036-06-01`，真实挂钟永远到不了「锚点 + TTL」 |
| `jobs 与 scan 报同一事件时只发一条 —— 现在靠键相等，不再靠限额` | 跨层键统一 |
| `跨层去重（端到端）：scan-sessions 输出与 probeJobs 对同一次失败算出同一个指纹` | 上游真的产了指纹，不只是候选层透传 |
| `跨层去重：scan 行必须带出宿主 waitingFor / statusUpdatedAt` | 扫描行真的带了宿主字段，且 `0` 不能当有效时间戳 |

### 3.2 关于「防定时炸弹」这条测试能挡什么、挡不住什么（必须说清楚）

我实测了「把 `Date.now()` 装回 `loadState`」这个回退，结果是：

```
✓ RED   loadState 必须用注入的 nowMs 剪枝   （actual 0, expected 1）
✗ GREEN 防定时炸弹                          （十年后锚点，真实时钟剪不掉）
```

**这是预期的，不是缺陷。** 十年后的锚点用真实时钟永远剪不掉，所以这条测试
**结构上挡不住**「时钟没注入」。它的职责是另一件事：**有没有别的挂钟泄漏
在 tick 之间偷偷改动去重状态**。挡「时钟没注入」的是 3.1 的第一条（锚点在过去）。
两条分工写进了测试注释里，免得下一个读到它的人误判它的覆盖面。

### 3.3 五处回退的逐条实测（`scripts/verify-bugfix-negatives.mjs` 新增项）

| id | 回退 | 变红的测试 |
|---|---|---|
| `b7-clock` | `pruneNotified(..., nowMs)` → `Date.now()` | `loadState 必须用注入的 nowMs 剪枝` |
| `b7-runtick` | `runTick` 不传 `nowMs` 给 `loadState` | `真正测去重：同一 WAITING 事件跨两个 tick 只发一条` |
| `b8-passthrough` | `candidatesFromScan` 不透传 `job:` 指纹 | `jobs 与 scan 报同一事件时只发一条` |
| `b8-scanfp` | `scanCrossLayerFingerprint` 恒返回 null | `跨层去重（端到端）` |
| `b8-hostfields` | 扫描行不带 `statusUpdatedAt` | `跨层去重：scan 行必须带出宿主` |

全仓实测输出末行：`✓ 18/18 处回退都让预期测试变红`（原有 13 项 + 新增 5 项）。

> 其中 `b8-hostfields` 是我第一版没挡住的：我最初只测了「候选层怎么用
> `statusUpdatedAt`」，没测「扫描行有没有真的带出来」。回退实测把它暴露了，
> 于是把字段摊平抽成 `hostFieldsOf()` 并补了直接测试。

---

## 4. 测试与硬门

```
node --test scripts/*.test.mjs       → 588 tests / 588 pass / 0 fail
node scripts/check-structure.mjs     → ✓ 结构检查全部通过
node scripts/verify-bugfix-negatives.mjs → ✓ 18/18
```

修复前基线：583 tests / 582 pass / 1 fail（诊断报告 §6）。
净增 5 条测试（142→143 是 watch.test.mjs 内部；10 年锚点 + 时钟注入 + 跨层端到端 +
宿主字段 + WAITING 退化统一）。

**改动文件**：
- `scripts/watch.mjs`（时钟注入、`candidatesFromScan` 指纹、`runScan --now`、`probeMtime` 清理、
  事件时刻转出）
- `scripts/scan-sessions.mjs`（`--now`、`hostFieldsOf`、`scanCrossLayerFingerprint`、
  `jobToRow` 事件时刻、transcript 行跨层指纹）
- `scripts/job-event-time.mjs`（新增，从 `watch.mjs` 抽出）
- `scripts/watch.test.mjs`（1 处调用补 `nowMs`、1 条断言更新、5 条新测试）
- `scripts/check-structure.mjs`（登记新导出）
- `scripts/verify-bugfix-negatives.mjs`（5 项回退）
- `docs/CHANGELOG.md`（顶部条目）

---

## 5. 仍存在的残留（不在本次边界内）

1. **WAITING 会话既没有 transcript 锚点、宿主也没写 `statusUpdatedAt`** 时，两路仍会分别
   落到 `activity:<lastActivity>`，键仍可能不等。`anchorSource` 会把这个状态说出来
   （`last-activity`），不再假装统一。这一档在真实数据上目前只影响 `sessions[]` 里
   没有 `live` 记录的历史会话。

2. **`ASKED` 层的指纹是问题文本**（`watch.mjs` `askedCandidates`）。同一个问题被问两次
   （真实的第二次等待）会算出同一个键 → 永久静默。这与本次的跨层去重无关，是
   `docs/research/2026-11-04-dedup-key-analysis.md` §1.2 记录的独立缺陷。

3. 诊断报告 §5 提到的「scan 行在宿主导出 `statusUpdatedAt` 之前退化」的原始建议是
   「改 `scan-sessions` 的输出契约」。本次做了这件事（`hostFieldsOf`），但**只覆盖
   transcript 行**：`mergeJobRows` 补入的纯 job 行没有 `statusUpdatedAt` 概念
   （job 记录里没有这个字段），它们的指纹走 `job:<事件时刻>`，与 `probeJobs` 一致。
