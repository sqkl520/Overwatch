# 去重测试长期红着：根因是 `pruneNotified` 用真实时钟剪掉了注入时钟的去重条目

> 诊断 Agent D5 · 2026-11-10 · 产出形态 exploration
> 全部结论附 `文件:行号` 或原始输出。**未修改** `scripts/watch.mjs` 与 `scripts/watch.test.mjs`，未碰 git。
> 复现脚本在 `.tmp-analysis/d5-*.mjs`；候选补丁在 `.tmp-analysis/patched/`（只改副本）。
> 读真实 `%LOCALAPPDATA%\Overwatch\` 走的是非虚拟化进程（`Win32_Process` → 落盘到 Temp 再读），
> 因为会话内直接读会落到 MSIX 影子快照。

---

## 结论（先看这一段）

**1. 两次 tick 算出的去重键完全相同，都是 `17e24ec93b6f9417`（指纹 `wait:call_ONCE`）。**
去重逻辑没有失效——失效的是**保存去重表的那一步**。

**2. 根因是实现 bug，不是测试写错。** 位置在 `scripts/watch.mjs:371`。
**修复需要两处：实现补上时钟注入，测试读 state 时把时钟传进去**（见第 3 节的四组合实测）。

```js
const pruned = pruneNotified(state.notified, Date.now());   // ← 用的是真实时钟
```

`loadState` 在 `watch.mjs:1959` 被 `runTick` 调用，而它不接受 `nowMs`：
`export function loadState(dir, { logger = null } = {})`（`watch.mjs:336`）。
于是**每条进入 `runTick` 的路径都会用「真实当前时间」去剪 `state.notified`**，
而整个测试契约是「`nowMs` 是可注入的时钟」。

测试的锚点是 `2026-11-08T20:10:00Z`（`watch.test.mjs:751`），当前真实时间是 `2026-11-10T00:0xZ`——
**相差 27.8 小时 > `NOTIFIED_TTL_HOURS = 24`**。所以：

- tick 1 正常发一条通知，磁盘上写下键 `17e24ec93b6f9417`，`lastSeenAt = 2026-11-08T20:10:00Z`；
- tick 2 内部 `loadState` 用真实时钟剪枝 → 该条目 `lastSeenAt` 已 27.8 小时 → **删除**；
- 键不复存在 → 第二次当作全新边沿 → 再发一条。

**3. 干净提交 `55d9225` 上也是红的，因为它是「到点变红」的定时炸弹。**
提交时刻 `2026-11-09T15:54:03Z`，距锚点 19.73 小时，**当时是绿的**。
翻红临界点是 `锚点 + 24h` = `2026-11-09T20:10Z`（北京时间 11-10 04:10），实测：
`anchor=23.9999h 前 → 1 条`；`anchor=24.0001h 前 → 2 条`。
把 `Date.now` 冻结到提交时刻跑全套：该用例**通过**（`.tmp-analysis/d5-freeze.mjs` 已验证）。
所以「在 55d9225 上照样红」的观察是真的，但它不等于「引入时就红」。

**4. 线上不会因为这个 bug 真重复通知。** 生产 watcher 的注入时钟就是真实时钟，两者一致，
实测同一 WAITING 事件跨 11 分钟两个 tick 只发 1 条（`.tmp-analysis/d5-prodshaped.mjs`）。
但线上**另有**跨层键不同的重复：生产 `state.json` 里可确认 **2 对**「同一次等待、两个键、两次实际发送」
（见第 5 节）。那是独立缺陷，修本 bug 不改变它。

**5. 缺陷在实现，但修复要动两处代码（实现 1 处 + 测试 1 处）。** 测试断言的正是产品要的行为，
且它当时是绿的、只因时钟走了才红——这是确定性缺陷，不是断言不成立。
修复做法：`loadState(dir, { nowMs })` → `pruneNotified(state.notified, nowMs)` → `runTick` 传 `nowMs`，
**外加测试第 769 行改为 `loadState(dir, { nowMs: now })`**。实测：**139/139 全绿**，
且 `assert.equal(n, 1)` 一个字都没动。只修实现或只修测试都不够（四组合实测见第 3 节）。

**6. 顺带确认：`watch.test.mjs:736-737` 那条绿的测试与失败那条不矛盾。** 两者揭示的是两个不同缺陷：
绿的那条是「同 tick、FAILED、两路键不同 → 靠限额兜底」；红的那条是「跨 tick、WAITING、键相同 →
本应靠去重挡下 → 条目被真实时钟偷删」。详见第 4 节。

---

## 1. 两次 tick 各自的键（实测输出）

`.tmp-analysis/d5-repro.mjs`：

```
waitingAnchor: wait:call_ONCE
probeWaiting candidates:
  sessionId sess-dedupe, state WAITING, reason "waiting:input needed",
  fingerprint "wait:call_ONCE", anchorSource "transcript",
  key "17e24ec93b6f9417"

NOTIFY# 1 {... title "✋ D:Pdemo · 正在等你（input needed）" ...}
TICK1 sent=1 already=0
TICK1 notified keys: []          ← 已经是空的了

--- second probe ---
fingerprint "wait:call_ONCE", anchorSource "transcript", key "17e24ec93b6f9417"
NOTIFY# 2 {... idle=11m ...}
TICK2 sent=1 already=0
TOTAL NOTIFIED: 2
```

**两次的指纹和键逐字相同。** 逐条排除题目列出的怀疑方向：

| 怀疑方向 | 实测结论 |
|---|---|
| `waitingAnchor` 返回 null → 退化成 `host:<statusUpdatedAt>` | **否**。返回 `wait:call_ONCE`，`anchorSource='transcript'` |
| `call_ONCE` 被 `tool_result` 闭合 | **否**。`writeWaitingTranscript` 只有传 `closed: true` 才补 `tool_result`（`watch.test.mjs:2271`），本用例只传 `{ id: 'call_ONCE' }` |
| `readTranscriptTail` / `anchorCache` key | **否**。两次都命中同一路径，cache key 是 path + (mtime,size)，文件未变 |
| 两次 tick 之间 transcript 时间戳变了 | **否**。测试只写一次 transcript，两个 tick 之间没有任何文件写入 |
| `dedupeKey` 第四参数传的东西不同 | **否**。两次都是 `wait:call_ONCE` |

真正丢条目的一步，是把 tick1 的 state 读回来时：

```
S1 after tick1  (on disk)     : [ '17e24ec93b6f9417' ]  notifications = 1
   real now = 2026-11-10T00:00:20Z   injected now = 2026-11-08T20:10:00Z
S2 loadState(dir).state keys  : []      ← pruneNotified 用真实 Date.now() 剪掉了
S3 after saveState (on disk)  : []
S4 after tick2                : [ '17e24ec93b6f9417' ]  notifications = 2
```

（`.tmp-analysis/d5-chain.mjs`）

**注意 S2 这一步在测试里（`watch.test.mjs:769`），但它不是唯一的触发点。**
我做了决定性隔离：**完全绕开测试的 `loadState`/`saveState` 往返**，只清额度、只跑两个 `runTick`：

```
tick1 -> notifications = 1 | on-disk keys: [ '17e24ec93b6f9417' ]
after budget wipe, on-disk keys still: [ '17e24ec93b6f9417' ]
tick2 -> TOTAL notifications = 2
=> 只跑 runTick 就已经红了：根因在 runTick 内部（实现 bug）
```

（`.tmp-analysis/d5-internal.mjs`）

即：`runTick` 自己内部的 `loadState`（`watch.mjs:1959`）就已经把条目剪掉了。
**即使把测试第 769 行改成 `loadState(dir, { nowMs: now })`，只要 `watch.mjs` 不修，这条照样红。**
我实测确认了这一点：只把测试改成传 `nowMs`、`watch.mjs` 不变 → 仍然 `actual: 2`。

---

## 2. 这是测试错还是实现错

**实现错。** 三条理由：

1. **测试的表达与产品语义一致。** 「同一次等待跨两个 tick 只发一条」正是 `dedupeKey` + `state.notified`
   存在的理由（`watch.mjs:444-514` 的长注释逐字描述了这件事）。断言没有写错。
2. **它是「时钟敏感」而非「断言不成立」。** 冻结 `Date.now` 到提交时刻，同一条测试通过：
   ```
   [freeze] Date.now() -> 2026-11-09T16:00:00.000Z
   ✔ 真正测去重：同一 WAITING 事件跨两个 tick 只发一条（不靠限额） (574.0ms)
   ```
   把锚点换到 23.9999 小时前 → 1 条；24.0001 小时前 → 2 条（`.tmp-analysis/d5-window.mjs`）。
   一条会随挂钟走动而改变结论的测试，暴露的是被它测的代码里有个未注入的时钟。
3. **同类缺陷在别处也存在但没被发现。** `watch.mjs` 里含 `Date.now()` 的匹配共 20 处，其中 15 处是
   `nowMs = Date.now()` 这种**默认参数**（正确的可注入写法）。剩下 5 处里 1 处是注释
   （`watch.mjs:2162`），4 处是直接调用，已逐个核过：
   - `watch.mjs:371` `pruneNotified(state.notified, Date.now())` —— **`runTick` 必经路径，本 bug 就是它**；
   - `watch.mjs:895` `probeMtime` 内的 `now` —— 只用于 `elapsedMs`，不参与任何判定；
   - `watch.mjs:2550` / `2564` —— CLI 入口（`--stats` / `--inbox`）自己取当前时间，属正常用法。

   只有第一处是在「已经声明了 `nowMs` 契约」的函数体内绕过它。

### 线上会不会真的重复通知

**这条机制本身不会。** 生产 watcher 的注入时钟就是真实时钟：

```
生产形态（注入时钟≈真实时钟）同一等待跨 tick 通知数 = 1 ✔ 不重复
```
（`.tmp-analysis/d5-prodshaped.mjs`）

真实 `%LOCALAPPDATA%\Overwatch\state.json`（非虚拟化进程读）里 73 条 `notified`，
其中 `notifyCount>0` 的 7 条，`suppressedBy` 分布：`per-session-24h` 61 条、`global-10min` 5 条、空 7 条。
`lastSeenAt === firstSeenAt` 的条目是 **73/73**（不是文档里常引的 72/72）。这条数据有一个干净的物理解释，
不需要推测：**`state.json` 的最后写入时刻是 `2026-11-09T09:07:31Z`，而刷新 `lastSeenAt` 的修复
（`watch.mjs:1761`）是随 `55d9225` 在 `2026-11-09T15:54:03Z` 才落地的——快照比修复早 6.8 小时。**
也就是说这份生产状态里跑的是**修复前**的代码，73/73 相等是修复前的预期形态，不是回归。
它**与 `pruneNotified` 的剪枝无关**：剪枝窗口 24 小时，而这些条目全在 11-08~11-09，没有一条真的超过 24 小时。

**但线上另有一种真实重复，与本 bug 无关，且已经发生。** 见下一节。

---

## 3. 修复建议

### 该改实现（并且必须同时补测试的一处调用）

**缺陷在原实现；修复需要同时补测试的一处调用。** 我实测了四种组合：

| watch.mjs | 测试第 769 行 | 结果 |
|---|---|---|
| 原样 | 原样 | ✖ actual 2 |
| **已修** | 原样 | ✖ **actual 2（仍然红）** |
| 原样 | 已修 | ✖ actual 2 |
| **已修** | **已修** | ✔ 139/139 全绿 |

原因：`loadState` 的剪枝发生在**两个**地方各一次——

1. `runTick` 内部（`watch.mjs:1959`）→ tick 2 一进来就把条目剪掉；
2. **测试自己**（`watch.test.mjs:769` 的 `loadState(dir)`）→ 它在 tick 2 之前就剪了一次，
   并用 `saveState`（第 772 行）把剪空的结果写回磁盘。

两处必须一起修。第 2 处不是「测试写错了」——它是一个**合法调用**，
只是这个函数在当时不接受 `nowMs`；修好 `loadState` 之后它可以传，就应该传。

最小补丁（实测 139/139 全绿）：

```js
// watch.mjs:336 —— 接受注入时钟
export function loadState(dir, { logger = null, nowMs = Date.now() } = {}) {
  ...
  const pruned = pruneNotified(state.notified, nowMs);   // watch.mjs:371

// watch.mjs:1959 —— runTick 把它传下去
const { state, corrupt } = loadState(stateDir, { logger: log, nowMs });

// watch.test.mjs:769 —— 测试也传它（唯一一处需要动的测试代码）
const st1 = loadState(dir, { nowMs: now }).state;
```

**`assert.equal(n, 1, ...)`（第 775 行）一字未动。** 动的只是「读 state 时用哪个时钟」，
不是「断言几条」。这是关键区别：修的是时钟传递，不是放宽标准。

理由：

- **`nowMs` 是 `runTick` 公开契约的一部分**（`watch.mjs:1894`），但内部有一个调用点无视它。
  这不是「测试没模拟好」，是**契约在内部有泄漏**。修它是修复契约一致性，不是迁就测试。
- **它是确定性的**：不依赖当前时刻。修好后任何一天跑都是绿的（冻结时钟到 1 小时前/100 天前实测都过）。
- **不弱化任何断言**：不需要放宽 `assert.equal(n, 1)`，不需要 mock 全局 `Date.now`，不需要改锚点日期。
- **风险面很小**：`loadState` 只有 4 个调用点（`watch.mjs:336` 定义、`1959`、`2545`、`2562`），
  后两个是 CLI 路径，`nowMs` 默认值 `Date.now()` 让它们行为完全不变。

### 顺带的负向测试建议

建议补一条**会把 bug 装回去就变红**的测试，这个 bug 才会永久被钉住：

```js
test('loadState 必须用注入的 nowMs 剪枝，不得用真实时钟', () => {
  const dir = tmp();
  try {
    const now = Date.parse('2026-11-08T20:10:00Z');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      version: 1,
      notified: { k: { sessionId: 's', state: 'WAITING', reason: 'waiting:input needed',
        firstSeenAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(),
        notifyCount: 1, delivery: 'submitted' } },
      budget: { day: null, sent: 0, sentLog: [], perSession: {} },
    }));
    assert.equal(Object.keys(loadState(dir, { nowMs: now }).state.notified).length, 1,
      '注入的时钟必须生效；用真实 Date.now() 会在锚点满 24h 后把条目剪掉');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

这条测试的价值在于：它**不依赖「挂钟走到锚点 24 小时之后」这个巧合**，
把 `Date.now()` 装回去就会立刻变红。上面那个真实用例是「到点才红」的，
一条会在半夜自动翻红的测试，比一条从第一天就红的测试难排查得多。

**已实测验证**（`.tmp-analysis/v6/neg.test.mjs` 与 `.tmp-analysis/patched/neg.test.mjs`）：

```
未修的 watch.mjs  → pass 0 / fail 1  (actual: 0, expected: 1)
已修的 watch.mjs  → pass 1 / fail 0
```

---

## 4. 那条「靠限额通过」的测试与失败那条矛盾吗？

**不矛盾。它们是两个不同缺陷的两个不同侧面。**

### 两条测试各自的机制

`watch.test.mjs:702-742`（绿的那条，断言在 `736-737`）测的是 **FAILED，jobs 与 scan 两条路径同轮都报**：

```
FAILED jobs 键: 33261d550e0b0e65   ← 指纹 job:<firstTerminalAt>
FAILED scan 键: 0ba0711f835db543   ← 指纹 lastActivity 数字位
  -> 相等? false
```
（`.tmp-analysis/d5-q4.mjs`）

键不相等 → 第二个不被去重挡 → 但它撞上 `GLOBAL_MIN_GAP = 10min`（`canNotify`）→ `why='global-10min'`。
**它测的确实是限额，而且断言诚实地说出了这一点**（测试注释与标题都明说「挡住它的是限额，不是键相等」）。

`watch.test.mjs:744`（红的那条）测的是 **WAITING，sessions 单一路径跨两个 tick**：

```
WAITING 两次 tick 键: 970b8a16bcbf53b3 970b8a16bcbf53b3 -> 相等? true
```

键相等 → 本应被去重挡 → 但去重条目被 `pruneNotified(真实时钟)` 删了 → 发两条。

### 结论：不是「去重在某些路径生效、某些不生效」

而是：

| 层 | 同 tick 内两条路径 | 跨 tick（同一路径） |
|---|---|---|
| WAITING | **键相等**（`wait:<tool_use_id>`，实测两路都是 `wait:call_X`） | 键稳定，但条目可能被真实时钟剪掉 → **本 bug** |
| FAILED | **键不相等**（`job:<ts>` vs `lastActivity`） | 键各自稳定，**跨 tick 必然重复** |

所以「一条绿一条红」不代表去重行为不一致：

- 绿的那条：**同 tick、FAILED、两路键不同 → 靠限额挡下**。它诚实地说明了「去重没生效」。
- 红的那条：**跨 tick、WAITING、键相同 → 本应靠去重挡下 → 条目被偷删**。

**两条测试互相补充，构成了一对完整的证据：它们一起说明「跨层去重至今没有统一」。**
一条说「FAILED 跨层靠限额兜底」，另一条说「WAITING 跨 tick 本已修好，但被未注入的时钟破坏了」。

---

## 5. 额外发现：跨层 FAILED 的重复在生产里真实发生过

这不是本次任务的问题，但它解释了我为什么要去查线上数据，且它与第 4 点的绿测试同源。

`.tmp-analysis/d5-failed-dup.mjs` 复现（时钟一致，不是本 bug）：

```
tick1 sent=1 suppressed=["global-10min"]  keys: [05b1d5b6111ac518, adbc6a0238262038]
tick2 sent=1 already=1
TOTAL notifications for ONE failed event: 2
  #1 ✖ D:Pdemo · 宿主报失败 :: host-reported-failed · idle=1m · 事件 2026-11-10 00:00Z
  #2 ✖ dup    · 宿主报失败 :: host-reported-failed · idle=12m
```

同一次失败跨越 10 分钟限额后，**被另一条路径以自己的键重新通知了一次**，标题还不同
（一条带 `事件` 时刻，一条不带）——这正是 `docs/research/2026-11-04-dedup-key-analysis.md` §2.1
警告过的形态。

生产证据（真实 `state.json`，7 条 `notifyCount>0`，按 `lastNotifiedAt` 排序）：

```
notifiedAt                  sess      src       key               reason
2026-11-08T19:16:31.799Z  d612c386  sessions  ae4c82b3fa8bb605  waiting:input needed
2026-11-08T19:31:49.101Z  356e31e9  sessions  771d542c73df3fb3  waiting:input needed
2026-11-08T19:50:33.879Z  a80c452d  sessions  d7b87f3d21e96c0f  waiting:permission prompt
2026-11-08T20:03:57.160Z  a80c452d  scan      a2fb30d72034f971  waiting:permission prompt
2026-11-08T21:00:43.990Z  356e31e9  scan      81bf69236a306942  waiting:input needed
2026-11-08T21:39:37.862Z  f932d1d4  sessions  3679ed23e2930d88  waiting:input needed
2026-11-08T21:57:22.468Z  f932d1d4  scan      4991735d1f97e981  waiting:input needed
```

两处「同一次等待、两个键、两次实际发送」：

| 会话 | 第一次（sessions） | 第二次（scan） | 间隔 |
|---|---|---|---|
| `f932d1d4` | `3679ed23e2930d88` @ 21:39:37 | `4991735d1f97e981` @ 21:57:22 | 17.7 分钟 |
| `a80c452d` | `d7b87f3d21e96c0f` @ 19:50:33 | `a2fb30d72034f971` @ 20:03:57 | 13.4 分钟 |

其中 `f932d1d4` 的那对键，`docs/research/2026-11-04-dedup-key-analysis.md` §2.1 已独立核对过是
同一次等待。同一份 `state.json` 里还能看到中间那次尝试
`4181354ebb8ac70c`（scan，`firstSeenAt=21:41:58`，`suppressedBy=global-10min`，`notifyCount=0`）——
**同一次等待在 20 分钟里产生了三个不同的键**，中间那个只被 10 分钟限额偶然挡住。

注意 `a80c452d` 那两条都是 `permission prompt`、且**两条都真的发出去了**：
`permission prompt` 噪音桶（`watch.mjs:1655` 的 `noiseBucket`）是随 `55d9225` 才加的，
而这份快照的最后写入是 `2026-11-09T09:07:31Z`，早于该提交 6.8 小时。所以噪音桶**当时还不在**，
是后来才给这条路径补上的保险。

**修好 `loadState` 不会改变这一现状。** 实测补丁版跑同样的跨层 FAILED 场景仍然发 2 条。
这属于 `docs/research/2026-11-04-dedup-key-analysis.md` §7 第 1 条记录的「已知残留」
（`candidatesFromScan` 在 scan 行没有 `statusUpdatedAt` 时退化成 `lastActivity`），
需要改 `scan-sessions` 的输出契约，不在本次边界内。**建议单独排期，不要和本修复绑在一起。**

---

## 6. 复现清单

| 脚本 | 证明什么 |
|---|---|
| `.tmp-analysis/d5-repro.mjs` | 两次 tick 的键逐字相同，`state.notified` 在 tick1 后已为空 |
| `.tmp-analysis/d5-prune.mjs` | 磁盘上有 `17e24ec93b6f9417`，`loadState` 返回 `[]`；`pruneNotified` 在真实时钟下删 1 条、注入时钟下删 0 条 |
| `.tmp-analysis/d5-chain.mjs` | 四步链条：tick1 写盘 → loadState 剪枝 → saveState 落空 → tick2 重发 |
| `.tmp-analysis/d5-internal.mjs` | **决定性**：不调用测试的 loadState 往返，只跑 runTick，仍然红 → 根因在 runTick 内部 |
| `.tmp-analysis/d5-nosave-internal.mjs` | 同上，另一种写法，同样 `RED` |
| `.tmp-analysis/d5-window.mjs` | 锚点 23.9999h 前→1 条，24.0001h 前→2 条；精确翻红边界 |
| `.tmp-analysis/d5-freeze.mjs` | 冻结 `Date.now` 到提交时刻，该用例通过 → 「提交时是绿的」 |
| `.tmp-analysis/d5-prodshaped.mjs` | 注入时钟≈真实时钟时只发 1 条 → 线上不受本 bug 影响 |
| `.tmp-analysis/patched/watch.mjs` + `.tmp-analysis/patched/watch.test.mjs` | 候选补丁（实现 3 行 + 测试 1 行），跑 `watch.test.mjs` 副本 → **139/139 全绿** |
| `.tmp-analysis/patched/neg.test.mjs` / `.tmp-analysis/unpatched/neg.test.mjs` | 建议的负向测试：跑在已修版 `pass 1`，跑在未修版 `pass 0 / fail 1`（`actual: 0, expected: 1`） |

> 四组合实测（只改实现 / 只改测试）用的临时副本已清理。复现方式：把第 3 节的三处改动分别
> 单独施加到 `scripts/watch.mjs` 与 `scripts/watch.test.mjs` 的副本上，跑
> `node --test --test-name-pattern="真正测去重" <副本>`，前三种均为 `actual: 2`，第四种 `pass 1`。
| `.tmp-analysis/d5-failed-dup.mjs` / `d5-plants.mjs` | 补丁不改变跨层 FAILED 重复（原版与补丁版都是 2 条） |
| `.tmp-analysis/d5-q4.mjs` | FAILED 两路键不等；WAITING 两路键相等 |

### 当前基线（未修改仓库状态）

```
node --test scripts/watch.test.mjs   → 139 tests / 138 pass / 1 fail
node --test scripts/*.test.mjs       → 583 tests / 582 pass / 1 fail
node scripts/check-structure.mjs     → ✓ 结构检查全部通过
```

---

## 7. 一句话给主线程

**去重键是对的（两次都是 `17e24ec93b6f9417`），是守卫它的 `state.notified` 条目被真实时钟偷删了。**
`watch.mjs:371` 的 `pruneNotified(state.notified, Date.now())` 应该用调用方传进来的 `nowMs`——
因为 `loadState` 是 `runTick` 的必经路径，而 `runTick` 的契约里 `nowMs` 是可注入的。
测试锚点定在 `2026-11-08T20:10Z`，提交时距锚点 19.7 小时（绿），
锚点满 24 小时后（11-10 04:10 北京时间）自动翻红——**所以 55d9225 上现在是红的，但它提交那一刻是绿的。**
修法：实现 3 行 + 测试第 769 行 1 行（`loadState(dir, { nowMs: now })`），实测 139/139 全绿。
**只修实现仍红**——这一点容易漏。
线上不受本 bug 影响（注入时钟就是真实时钟）。另有一处**独立的**跨层键不统一
（WAITING 两路已统一，FAILED 的 `job:<ts>` vs `lastActivity` 尚未），
生产已实际重复通知 **2 对**，需要单独修。
