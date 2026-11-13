# 2026-11-11 · 陈年问句被当成「需动作」+ `c` 复制内容错误

> 用户实拍两个缺陷，本文记录修法与依据。产出形态 `artifact`（代码 + 测试）。
>
> 改动文件：`scripts/tui-layout.mjs`、`scripts/oversight-tui.mjs`、
> `scripts/check-structure.mjs`、`scripts/oversight-tui.test.mjs`、
> `scripts/tui-layout.test.mjs`、`scripts/tui-redesign.test.mjs`、
> `scripts/app-router.test.mjs`、`scripts/verify-tui-negatives.mjs`。
>
> **未碰**：git、`scripts/verify-claims.mjs`、`scripts/asked.mjs`、配色/视觉。

---

## 一、缺陷 1：陈年问句被当成「需动作」

### 现象

用户截图（修前）：

```
需动作 (2)
 Hilltop Village优化    33.1d  c 复制回复
    它在等：要我现在就把用户实测单交给你，还是你先看这四份测试报告？
 Hilltop Village        8.7d   Enter 看原文
    API unavailable — retry · API Error: 503 ...
```

用户原话：

> 有些哈，都是我很久很久都没有搞过的对话了，它发了个问句就判定成需动作这很不合理

### 根因

`WAITING` 状态**没有老化上限**。`watch.mjs:85` 有 `BLOCKED_MAX_AGE = 7 * DAY`，
通知门用它拦掉了超龄的 blocked；但展示侧（`tui-layout.mjs: partitionRows`）
直接按 `ACTION_STATES.includes(row.state)` 分区，一个 33 天前的 blocked
照样进「需动作」——而且按 `idleSec` 降序排，它**永远排第一位**。

实测确认了两条现场记录：

| job | state | 事件时刻 | 年龄 | needs | suggestedReply |
|---|---|---|---|---|---|
| `7710fbdb` | blocked | `2026-10-08T09:45:33.518Z` | 33.1d | 要我现在就把用户实测单交给你，还是你先看这四份测试报告？ | 把实测单发给我 |
| `a9fa4c62` | blocked | `2026-11-01T18:41:21.066Z` | 8.7d | （无） | （无） |

### 阈值怎么定的：实测分布

写了 `measure-answer-latency.mjs`（一次性脚本，读本机
`~/.claude/projects/**/*.jsonl`，不写仓库），统计「以问号结尾的 assistant
消息 → 之后第一条真人消息」的延迟。

**样本**：247 个 transcript、457 条问句、443 条能配对到真人回复、11 条从未有人回。

```
回答延迟（小时）
  p50   : 0.27h
  p75   : 1.93h
  p90   : 10.93h
  p95   : 15.23h
  p99   : 17.59h
  p99.9 : 28.57h
  max   : 28.6h

落在阈值内
  ≤  1h : 65.9%
  ≤  6h : 83.3%
  ≤ 12h : 92.1%
  ≤ 24h : 99.5%   ← 24h
  ≤ 48h : 100.0%
```

### 结论：WAITING = 24h

- **24h 覆盖 99.5%**，是 p99（17.59h）的 1.4 倍。剩下的 0.5% 正是「永远不会有人回」的那批
  —— 它们应当老化，这正是本缺陷要修的对象。
- 与仓库里已有口径一致：`asked.mjs: MAX_QUESTION_HOURS = 24`、
  `ASKED_MAX_SILENCE_HOURS = 8`，两者都是从同一份回复延迟分布标定的。
  三处用同一条线，不会出现「通知门说超龄、展示门说还年轻」。
- 没选 p95（15h）：p95 会放过 5% 的真实回复，在 443 个样本上是 22 条——
  把还在合理等待中的会话提前降级，比多留一条陈旧条目更烦人。

### BLOCKED / FAILED = 7d

- **BLOCKED 直接复用 `BLOCKED_MAX_AGE`**，不重新发明一个数。测试钉住
  `ACTION_MAX_AGE_SEC.BLOCKED * 1000 === BLOCKED_MAX_AGE`：通知门与展示门对同一件事
  必须用同一把尺，否则会出现「不通知你，但列表里天天排第一」。
- **FAILED = 7d 是推定值**，镜像 BLOCKED。两者都是宿主写下的终态事实、都永久留在
  `state.json` 里，没有理由让其中一个活得更久。这是全表唯一一条没有独立实测的数，
  在代码里写明了。

### 不丢弃：降级进「已停」

用户明确要求「所有都要显示」，所以既不能留在需动作（误报），也不能删掉（漏报）。
做法是**降级**：

- `partitionRows` 把超龄的行推进 `stopped`，并打上 `stale: true` +
  `staleAgeSec` / `staleLimitSec`；
- 返回值多一个 `stale` 数组，供调用方区分措辞；`buildSections` 透传到视图层；
- 「已停」计数行变成 `已停 (227) 4.5h–36.6d前 · 其中 2 条超龄 · h 展开`；
- 按 `h` 展开时，超龄行的标题后缀 `· 超龄`，与普通历史会话在视觉上可区分；
- 详情页新增一段「已超龄」说明，写清年龄、上限、为什么不给建议回复。

**不变的硬约束**：三段合计仍等于总行数（测试钉住）。

### 可注入时钟

`staleOf(session, nowMs)` / `ageSecOf(session, nowMs)` **自己不读挂钟**：

- 优先用行上已有的 `idleSec`（它由 `buildSections({nowMs})` /
  `liveToRow(live, nowMs)` / `jobToRow(job, nowMs)` 一路传下来）；
- 其次才用 `(nowMs - statusUpdatedAt)` 现算；
- 两个都没有 → `stale: false`（fail-open）。**看不见的年龄不等于年轻**，
  但也不该凭猜把一条真实等待藏起来。
- 拿不到任何时刻时 `nowMs = null`，`staleOf` 返回不超龄。

App 侧：`buildListFrame` / `buildDetailFrame` / `copyDraft` 都传 `this.now()`，
一帧只取一次，避免「这一帧说还年轻、下一帧说超龄」的抖动。

### 修后实测（本机真实数据）

```
0 件在等你 · 13 个会话在跑 · 227 个已停
...
已停 (227)  4.5h–36.6d前 · 其中 2 条超龄 · h 展开
   · 超龄降级：Hilltop Village优化（33.2d > 7.0d 上限）
   · 超龄降级：Hilltop Village（35.9d > 7.0d 上限）
```

两条陈年 blocked 从「需动作」降到了「已停」，且都还在、都点名了年龄与上限。

---

## 二、缺陷 2：`c` 复制的内容是错的

### 现象

用户按 `c`，剪贴板里是：

```
把实测单发给我

（目标会话受阻，在等：要我现在就把用户实测单交给你，还是你先看这四份测试报告？）
```

### 两个独立错误

**(a) `needs` 这个元注释进了剪贴板。** 旧 `buildDraft` 把 `suggestedReply` 和
`（目标会话受阻，在等：${needs}）` 两段用 `\n\n` 拼在一起。第二段是**给人看的上下文**，
它属于屏幕，不属于剪贴板。粘进对话框就变成「发了一句奇怪的话」。

**(b) 陈旧的 `suggestedReply` 不该被当成可发的内容。** 「把实测单发给我」是宿主
33 天前猜的一句话，那个会话早就不动了。复制它出去没有任何意义。

### 改成了什么

`buildDraft(session, { nowMs })` 现在只返回**一段可直接发送的正文**：

| 情况 | 返回 |
|---|---|
| 有 `suggestedReply` 且未超龄 | 它的原文，一行，不加任何前后缀 |
| 超龄（`staleOf().stale`） | `null` —— 不给假内容 |
| 只有 `needs`、没有 `suggestedReply` | `null` —— 以前会拼一段旁白，那正是缺陷 |
| 什么都没有 | `null` |

**为什么「只有 needs 时返回 null」是故意的**：没有 `suggestedReply` 时的正确动作是
「人去自己写」，不是「复制一句旁白」。`actionCell` 相应地也不画 `c 复制回复`
（规划 P6：不提供假按钮）——否则就是按了没反应的按钮。

新增 `draftHintOf(session, {nowMs})`：给界面用的可复制性说明，**不进剪贴板**。
它和 `buildDraft` 对「能不能复制」必须永远一致，由测试钉住（这正是这次缺陷的根——
界面上写了什么和剪贴板里是什么，以前是两处各自决定的）。

`copyDraft` 改为：`draftHintOf` 先取原因 → `buildDraft` 取正文 → 无正文时提示
具体原因（「无草稿可复制：已 33.2d 没动，不再给建议回复」），而不是含糊的
「没有 needs / suggestedReply」。

### `needs` 仍然显示在屏幕上

`--plain` 的 L2 需动作段仍然**逐字**打 `它在等：${needs}`，详情页也仍有「它在等」
一段。`relay-protocol.md §5.1` 要求逐字展示，这条没有放松——
变的是**剪贴板**，不是屏幕。展示与复制是两条路，测试分别锁住。

---

## 三、测试

### 基线

```
改前：node --test scripts/*.test.mjs → 700 / 700 全绿
改后：node --test scripts/*.test.mjs → 715 / 715 全绿（+15，无删除、无跳过）
node scripts/check-structure.mjs → 通过，0 提示
```

### 新增测试

| 文件 | 新增 |
|---|---|
| `tui-layout.test.mjs` | 8 条：`ACTION_MAX_AGE_SEC` 完整性、与 `BLOCKED_MAX_AGE` 同线、`staleOf` 注入时钟、阈值两侧（30 天 WAITING）、降级不丢弃、收件箱来源也受老化约束、`stoppedSummary` 数出超龄、`actionCell` 不给假按钮 |
| `oversight-tui.test.mjs` | 5 条：草稿只含正文、无旁白无 needs 原文、超龄不给建议回复、`draftHintOf` 与 `buildDraft` 永远一致、详情页「已超龄」说明 |
| `tui-redesign.test.mjs` | 2 条：`buildSections` 端到端降级 + 三段合计不变、超龄会话按 c 不给草稿 |
| `app-router.test.mjs` | 1 条：App 真实取数链下 `c` 的正文不含 needs 旁白 |

**锚点远离阈值**：老化测试用 **33.1 天**（实测真实值，非构造值）与 **30 天**
（> 24h 上限 30 倍），不贴边界。时钟全部注入 `2026-11-11T00:00:00Z`。

### 负向验证：19/19 全红

`node scripts/verify-tui-negatives.mjs` → **19/19 处回退都让预期测试变红**
（原有 11 项 + 本次新增 8 项）：

| id | 回退 | 预期变红的测试 |
|---|---|---|
| `v12-age-waiting` | 删掉 `WAITING` 的 24h 上限 | `ACTION_MAX_AGE_SEC：WAITING 有上限` |
| `v13-age-partition` | 让 `partitionRows` 无视 `staleOf` | `partitionRows：超龄的…降级进「已停」` |
| `v14-age-drop` | 降级改成直接丢弃（漏报） | 同上 |
| `v15-draft-needs` | 把 `（目标会话受阻，在等：…）` 塞回草稿 | `草稿里绝不能出现「目标会话」这类旁白` |
| `v16-draft-stale` | 去掉 `buildDraft` 的超龄判断 | `超龄的等待不给建议回复` |
| `v17-draft-needs-only` | 退回「只有 needs 也拼旁白」 | `草稿只含可直接发送的正文…` |
| `v18-detail-explain` | 删掉详情页的超龄说明 | `详情页：超龄的会话必须说清` |
| `v19-stopped-count` | 不再报「其中 N 条超龄」 | `stoppedSummary：降级来的条目要能被数出来` |

每一处都是**真正改文件、跑测试、再还原**，不是注释声明。

---

## 四、边界与遗留

- 未碰 git，未 commit；未改 `verify-claims.mjs` / `asked.mjs`；未动配色。
- `FAILED = 7d` 没有独立实测，是本表唯一推定值（已写在代码注释里）。
- `idleSec` 的语义是「宿主最后一次写这个状态文件的时刻」而非「问句发出的时刻」。
  实测 `7710fbdb` 的 `eventAt` 与 `updatedAt` 一致（`2026-10-08T09:45:33.518Z`），
  所以对本例没有偏差；但若某个宿主的 `updatedAt` 因元数据重写被推到当下
  （`job-event-time.mjs` 头注释记过 27.8 天的偏差案例），老化会偏晚。
  这时 `scan-sessions.mjs` 的 `eventAt`（timeline / request-id / firstTerminalAt）
  更准，但列表行目前传的是 `idleSec`。**这是已知残留，未在本单修**。
