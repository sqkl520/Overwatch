# 2026-11-02 BLOCKED 误报修复记录

> 修复 Agent F1 · 产出形态 `artifact`（代码 + 测试）
> 根因由诊断 Agent D1 确认（`docs/research/2026-11-02-false-positive-diagnosis.md` 根因 A），
> 主线程复核过原始数据。**口径由用户指定**：超过 7 天的 blocked 直接标过期，不再通知。

---

## 一、改了什么

改动集中在 `scripts/watch.mjs`，四处：

| 位置 | 改动 |
|---|---|
| 常量区 | 新增 `BLOCKED_MAX_AGE = 7 * DAY`（导出）、`TIMELINE_TAIL_BYTES = 256 * 1024` |
| 新增函数 | `requestIdTime(text)`、`lastTimelineStateTime(dir, terminal, maxBytes)`、`resolveJobEventTime(job, jobsDir)` |
| `probeJobs()` | 新鲜度判定与 `idleSec` 全部改走事件时刻；返回值新增 `expired[]` / `undated[]` |
| `runTick()` | 为过期与「定不了时」写一行日志；`describe()` 不再输出编造的分钟数 |

`docs/CHANGELOG.md` 顶部加了一条；`scripts/check-structure.mjs` 登记了三个新导出
（不登记会让结构门的「导出未登记」检查报警）。

**没碰的**：`ASKED` 相关代码（另一路 Agent 在处理）、`probeWaiting()`、
`FAILED` 的 24 小时口径、去重/限额/通知派发链路。

---

## 二、为什么这么改

### 2.1 根因是一个字段用错了，而它同时污染了两件事

```js
// 旧代码（scripts/watch.mjs:635-648）
const updated = Date.parse(job.updatedAt || job.lastTerminalAt || job.createdAt || '');
if (!Number.isFinite(updated) || nowMs - updated > ACTIVE_WINDOW) { skipped++; continue; }
...
idleSec: Math.round((nowMs - updated) / 1000),
```

`updatedAt` 是**文件元数据时间**。宿主会在启动、补写 `respawnFlags` / `name` / `providerEnv`
时重写 `state.json`，把它刷到当下——但 `state:"blocked"` 和 `detail` 里那个错误是**旧的**。

实测 `~/.claude/jobs/<session-A>/state.json`：

| 事实 | 值 |
|---|---|
| `state` | `"blocked"` |
| `detail` 里的 request id | `<request-id-1>` → `2026-10-05T15:57:00Z` |
| `timeline.jsonl` 末条 | `{"at":"2026-10-05T15:57:02.483Z","state":"blocked"}` |
| `timeline.jsonl` 里 2026-11 的记录数 | **0** |
| `updatedAt` | `2026-11-01T18:41:21.066Z` |
| `firstTerminalAt` | `2026-09-12T12:09:41.462Z` |

**阻塞发生在 2026-10-05，`updatedAt` 是 2026-11-01——差 27.8 天。**
旧判定器据此把这个 27 天前的 503 当成新鲜阻塞，并通过 `idleSec` 把它算成
`idle=916m`（15.3 小时）写进通知正文。**那个数字是编造的**：它精确到分钟，
来源却是一个和事件无关的时间戳。

### 2.2 三个时间源，取更旧的

```
timeline.jsonl 末条同状态记录的 at   ← 宿主自己的事件流水，最强证据
detail 里 request id 的时间戳        ← 由那次错误本身携带，重写记录改不动它
firstTerminalAt                       ← 只在前两者都缺时兜底
```

**为什么取更旧的而不是更新的**：三者都是真实事件时刻。更旧的那条离「现在」更远，
按它判过期只会**少发**不会多发。取新的会给一条其实早就死掉的记录续命——那正是这次 bug 的形态。

**为什么不退回 `updatedAt`**：那等于把 bug 原样留着。三者都拿不到时 fail-closed（不通知）。

**为什么 `timeline` 只认「同状态」的记录**：一个 job 可能先 `failed` 后 `blocked`。
最后一条 `blocked` 才是「这次阻塞何时发生」；取任意最后一条会让阻塞时刻被失败时刻顶替。
测试 `timeline 解析：只认同状态记录` 钉住了这条。

### 2.3 7 天，不是 24 小时

用户明确选择的口径。理由站得住：`jobs/*/state.json` 里那条终态**永久留着**，
实测 20 个 job 目录里 14 个停在 `blocked` / `failed`。一个 3 天前就卡住、进程还在的
后台作业仍然值得看一眼；一个 27 天前的 503 不值得。24 小时会挡掉前者。

`FAILED` 沿用 24 小时，**本任务不动它**——同一处代码但不同状态，改它超出授权范围。

### 2.4 日志必须留痕，但只留一次

`blocked-expired: <jobId> age=27.8d source=request-id`。

**按 job × 事件时刻做进程级去重**：L-fast 是 15 秒一层，20 个旧 job 每轮各写一行，
1 MiB 的日志半分钟就转掉了，会把真正的证据冲走（DF-021 是同类事故）。
键里带事件时刻，所以同一个 job 真的重新阻塞时会再记一次。

---

## 三、实测数字

### 3.1 本机真实数据（`~/.claude/jobs/`，19 个可解析的 job 目录）

```
scanned 19  found 0  expired 2  undated 0  ms 48.58   ← 冷缓存
```

| job | 判定 | 事件时刻来源 | 年龄 |
|---|---|---|---|
| `<session-A>` | **过期** | `request-id` | 28.77 天 |
| `<session-H>` | **过期** | `timeline` | 26.03 天 |

**修复前**：`<session-A>` 被判为活跃并发出通知（`idle=916m`）。
**修复后**：`found=0`，两条都只写一行 `blocked-expired` 日志。

### 3.2 成本

| 指标 | 修前 | 修后 |
|---|---|---|
| `probeJobs` 热态耗时（5 次） | ~12 ms | **14.6–15.3 ms** |
| `timeline.jsonl` 尾部读（19 个合计） | — | 43.6 ms 冷 / ~3 ms 热 |

多付约 3 ms / 轮。L-fast 15 秒一层 → 每天约 **17 秒** CPU（0.02% 单核）。
本机最长 `timeline.jsonl` 是 141 KB（`<job-E>`），256 KB 尾部预算覆盖全部，
实测 **0 次截断**；截断分支仍实现并 fail-closed，因为别的机器不一定这么小。

### 3.3 测试

- **全量**：`385/385`（基线 375 + 新增 10）
- **`watch.test.mjs`**：`125/125`
- **结构门**：`node scripts/check-structure.mjs` → exit 0

新增 10 条，逐条对应任务要求：

1. 27 天前的 blocked 不产生候选，且记为 `blocked-expired`
2. **核心用例**：`updatedAt` 很新（15.3h）但事件时间很旧（27.8d）→ 判过期
3. 6 天前的 blocked 仍产生候选，`idleSec` 从事件时刻算（不是从 1 分钟前算）
4. 7 天边界：差 1 秒有效，过 1 秒过期
5. 事件时间无法确定 → fail-closed，不通知但留痕
6. request id 可单独定时（timeline 缺失时）
7. 两个时间源都可用时取更旧的
8. `requestIdTime` 解析 `<request-id-1>`，非法值返回 null（含「月份 13」这种看起来合法的乱码）
9. timeline 只认同状态记录（先 failed 后 blocked，取 blocked 那条）
10. `runTick` 真的写出 `blocked-expired: stale age=27.8d`

### 3.4 负向验证（「修好了」必须有负向证据）

把判定行换回 `Date.parse(job.updatedAt || job.lastTerminalAt || job.createdAt || '')`，
重跑 `watch.test.mjs`：**10 条变红**。

| 变红的用例 | 归属 |
|---|---|
| 27 天前的阻塞不产生候选 | 新增 |
| **核心用例：`updatedAt` 新、事件时间旧** | 新增 |
| 6 天前的阻塞仍产生候选，`idleSec` 从事件时刻算 | 新增 |
| 7 天边界 | 新增 |
| 事件时间无法确定时 fail-closed | 新增 |
| request id 可单独定时 | 新增 |
| timeline 与 request id 取更旧的 | 新增 |
| timeline 只认同状态记录 | 新增 |
| runTick 写出 `blocked-expired` 日志 | 新增 |
| 分类：UNCLASSIFIABLE 停够 5 分钟才放行 | **既有**（夹具只给 `updatedAt`，现在被判「定不了时」） |

（第 10 条新用例 `requestIdTime` 是纯函数测试，与判定路径无关，所以照常绿。）

这条证明修复是 load-bearing 的，不是「跑一次绿灯」。
同时它暴露了一个必须说清的事：**旧夹具全部只写 `updatedAt`**——这正是旧实现能骗过测试的原因。
新逻辑下这些夹具被改成同时给 `firstTerminalAt`，否则它们会（正确地）落进 fail-closed 分支。

---

## 四、遗留与不做的事

1. **「发送前不复核现状」没有修。** 诊断文档建议的修复方向 2（`dispatchCandidates` 里做一次
   `buildInbox` 式 live 对账）不在本任务范围。现在这道防线前移到了 `probeJobs`——
   27 天前的记录根本进不了候选池——但「3 天前 blocked、会话早就恢复 busy」这类仍会漏过。
2. **`ASKED` 未动。** 另一路 Agent 在处理。`HOST_FACT_STATES` 里 `ASKED` 的归类问题原样保留。
3. **`FAILED` 仍是 24 小时口径。** 同一处代码、不同状态。改它需要单独的授权，
   而且 `FAILED` 的误报没有实测样本支撑（本机 3 条 failed 记录全部超过 24 天）。
4. **没有重启守护进程。** 修复在下一次启动后生效；当前跑的实例仍用旧逻辑。
