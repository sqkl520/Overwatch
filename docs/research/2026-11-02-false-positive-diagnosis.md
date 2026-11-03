# 2026-11-02 两条假阳性通知的根因诊断

> 诊断 Agent D1 · 产出形态 `exploration` · 只读，未改任何代码
> 证据来源：`%LOCALAPPDATA%\Overwatch\`（watch.log / runner.log / observations.jsonl / state.json）、
> `~/.claude/jobs/*/state.json`、`~/.claude/projects/**/*.jsonl`、`~/.claude/sessions/*.json`

---

## 结论先行

**两条通知都是真的发出去了，判定链路也都能完整复现——但它们误报的原因不是同一个。**

| | 根因（一句话） | 代码位置 |
|---|---|---|
| **BLOCKED** | `probeJobs()` 的 24 小时「新鲜度」门槛拿 `job.updatedAt`（宿主**重写记录**的时刻）当「阻塞**发生**的时刻」，于是 27.8 天前的一次 503 被当成刚发生的阻塞，只要 `updatedAt` 在 24h 内就一直留在候选池里。 | `scripts/watch.mjs:636` |
| **ASKED** | `asked.mjs` 只看**单个 transcript 的最后一行**是不是问句 + 问句距今 < 24h，既不与宿主 `sessions/*.json` 的 live 状态对账，也不用「会话已静默多久」做时效判断；而 `MAX_QUESTION_HOURS=24` 是拿**回复延迟分布**标定的，回答不了「这条问题现在还值不值得提醒」。 | `scripts/asked.mjs:118-135`、`scripts/watch.mjs:1694-1710` |

**是否同源：不同源。** 一个是**判据把「记录写入时间」错当成「事件发生时间」**（数据语义错误）；另一个是**判据只做文本局部判断、缺现状对账**（判定维度缺失）。

但两者被**同一个放大器**同时引爆，并且有一条可以指名道姓的共因：

1. 两张配额表都是 24 小时（`state.notified` 的 `NOTIFIED_TTL_HOURS` 与 `budget` 的滚动窗口），
2. 于是两个候选都被预算**憋了一整夜**。真正放行它们的是**同一条**时间戳 `2026-11-01T09:57:09.391Z`——它在 `2026-11-02T09:57:09.391Z` 越过 24 小时线，同时给 `sentLog`（8→7）和 `askedLog`（6→5）各腾出一个名额，两条通知因此在 2 分 27 秒内接连发出（09:57:22.928Z、09:59:49.463Z）。
3. 更关键：**发送路径完全没有「发之前再校验一次现状」这一步**——`buildInbox()` 里有完整的 live 对账（会把这个 <project-A> 条目判成 `stale: true` 并默认不展示），但 `dispatchCandidates()` 不调用它。

这和 README「已知局限」里那条「抑制准确率无法自测」是同一个洞的两侧：**收件箱会自己发现「这条已经过时了」，通知不会。**

---

## 一、两条通知的原始记录

### 1.1 通知发送日志（`watch.log`，UTC）

```
2026-11-02T09:57:22Z [INFO] state 清理：移除 5 条超过 24h 的已通知条目
2026-11-02T09:57:35Z [INFO] notified BLOCKED <project-A> kind=- key=1f81ac43e562b43f session=<session-A>
2026-11-02T09:57:38Z [INFO] tick jobs waiting jobs=10ms candidates=1 sent=1 suppressed=0 already=0 observed=1(BLOCKED:1)
2026-11-02T10:00:49Z [INFO] notified ASKED <project-B> kind=- key=77326dfc816f0674 session=<session-B>
2026-11-02T10:00:49Z [INFO] tick jobs waiting probe scan:<project-D-slug> scan:<project-D-slug> scan:<project-F-slug> scan:<this-repo-slug> scan:<project-C-slug> asked jobs=9ms probe=69ms candidates=2 sent=1 suppressed=0 already=1 observed=2(BLOCKED:1,ASKED:1)
```

`watch.log` 与 `runner.log` 两处记录一致（`runner.log:10095` / `runner.log:10104`）。

> 注：`watch.log` 的行时间是 **notifier 返回之后**写的，而 `observation.ts` / `lastNotifiedAt` 用的是 tick 起始的 `nowMs`。所以两条通知各差了 12 秒和 60 秒——BLOCKED 是 `09:57:22.928Z` → 日志 `09:57:35Z`，ASKED 是 `09:59:49.463Z` → 日志 `10:00:49Z`。差值来自 `await notifier()`（PowerShell toast）的耗时，不是时钟问题。下文一律以 `observation.ts` / `lastNotifiedAt` 为准。

### 1.2 观察日志（`observations.jsonl`）——发出那一条

```json
{"ts":"2026-11-02T09:57:22.928Z","sessionId":"<session-A>","state":"BLOCKED","idleSec":54962,"kind":"BLOCKED","autoAnswerable":false,"reason":"host-reported-blocked","confidence":null,"notified":true,"why":null,"classify":"host","fingerprint":"","source":"jobs","waitingFor":null}
```

```json
{"ts":"2026-11-02T09:59:49.463Z","sessionId":"<session-B>","state":"ASKED","idleSec":37800,"kind":"ASKED","autoAnswerable":false,"reason":"asked:decision","confidence":null,"notified":true,"why":null,"classify":"host","fingerprint":"s 里了喵。\n\n---\n\n现在 N 处前置全部修完。要我把这批改动提交吗？还是先继续清单里的 N 个任务？","source":"asked","waitingFor":null}
```

### 1.3 去重表里的两条边沿（`state.json` → `notified`）

```json
"1f81ac43e562b43f": {
  "sessionId": "<session-A>",
  "state": "BLOCKED",
  "reason": "host-reported-blocked",
  "firstSeenAt": "2026-11-01T18:41:21.390Z",
  "lastNotifiedAt": "2026-11-02T09:57:22.928Z",
  "notifyCount": 1,
  "source": "jobs",
  "project": "<project-A>",
  "needs": "API unavailable — retry · API Error: 503 No available channel for model <upstream-model> under group default (distributor) (request id: <request-id-1>) ...",
  "idleSec": 0,
  "lastSeenAt": "2026-11-01T18:41:21.390Z",
  "delivery": "submitted"
}
```

```json
"77326dfc816f0674": {
  "sessionId": "<session-B>",
  "state": "ASKED",
  "reason": "asked:decision",
  "firstSeenAt": "2026-11-02T01:25:18.275Z",
  "lastNotifiedAt": "2026-11-02T09:59:49.463Z",
  "notifyCount": 1,
  "source": "asked",
  "project": "<project-B>",
  "idleSec": 6840,
  "lastSeenAt": "2026-11-02T01:25:18.275Z",
  "delivery": "submitted"
}
```

注意两个 `firstSeenAt` 与 `lastNotifiedAt` 的间距：BLOCKED **15 小时 16 分**，ASKED **8 小时 34 分**。这个「先记下、整夜压着、早上突然发」的形态本身就是第一手证据。

---

## 二、这条通知对应的是哪个会话

不是猜的，名字来自宿主 job 记录自己的 `name` 字段：

```
~/.claude/jobs/<session-A>/state.json
{
  "state": "blocked",
  "name": "<project-A>",
  "nameSource": "user",
  "sessionId": "<session-A>",
  "resumeSessionId": "<session-C>",
  "cwd": "<project-root>\\<project-A>",
  "createdAt": "2026-09-12T12:09:34.354Z",
  "updatedAt": "2026-11-01T18:41:21.066Z",
  "firstTerminalAt": "2026-09-12T12:09:41.462Z",
  "linkScanPath": "<claude-home>\\projects\\<project-A-slug>\\<session-C>.jsonl",
  "linkScanOffset": 14322656
}
```

| 字段 | 值 |
|---|---|
| job 目录 | `<claude-home>\.claude\jobs\<session-A>` |
| sessionId | `<session-A>` |
| 项目目录 | `<mc-server-root>\Server plugin\<project-A>` |
| 主 transcript | `<claude-home>\.claude\projects\<project-A-slug>\<session-C>.jsonl`（14.3 MB，`linkScanOffset=14322656`） |
| 当前活着的会话 | `<session-D>`（`~/.claude/sessions/<pid>.json`，`status:"busy"`，name `<project-A> 多agent工作流`） |

**这里有一个容易被绕进去的坑**：`~/.claude/projects/` 下同时存在大小写两个目录，内容相同（NTFS 不区分大小写造成的双份列目录）：

```
<project-A-slug-lower>          ← 小写，probe 日志里看到的
<project-A-slug>-H...     ← 另一个项目
```

而 `notified.project` 里出现过 `<project-A>`（来自 jobs 的 `cwd` basename）和 `<project-A-slug-lower>`（来自 scan 的 slug）两种形态——同一条通知里用的是前者。

**关键事实**：`<session-A>` 在 `~/.claude/sessions/` 里**没有任何记录**（已核对全部 12 个 json），即这个会话进程早已不在。它是一个 9 月 12 日创建、10 月 5 日卡死的后台 job 的残骸记录。

---

## 三、BLOCKED 是怎么被判出来的

### 3.1 走的是哪条分支

**宿主上报的 `state` 字段，不是 classifier，也不是 `probeWaiting()`。**

判定链路（全部可复现）：

```
probeJobs(join(root,'jobs'))                       scripts/watch.mjs:608
  └─ 读 ~/.claude/jobs/<session-A>/state.json
     job.state === 'blocked'                        ✓ 命中
     updated = Date.parse(job.updatedAt)            = 2026-11-01T18:41:21.066Z
     nowMs - updated > ACTIVE_WINDOW ?              → 未超过（差 15.3h < 24h）✓ 通过
  └─ push { state:'BLOCKED', reason:'host-reported-blocked', source:'jobs', idleSec }
```

`state-model.md` §2 序 0.5 规定 `BLOCKED` **仅**认宿主 `jobs/*/state.json` 的 `state === 'blocked'`——**这一条实现完全符合规范**。

`candidatesFromScan` / `judgeState()` 没有参与（那条路径要求 transcript 尾部，这个会话的 transcript 停在 10-05）。

### 3.2 判定依据的原始数据

`~/.claude/jobs/<session-A>/state.json`（文件 mtime `2026-11-02 02:41:21 +0800` = `2026-11-01T18:41:21Z`）：

```json
{
  "state": "blocked",
  "detail": "API Error: 503 No available channel for model <upstream-model> under group default (distributor) <request-id-1> <request-id-2>. ...",
  "tempo": "blocked",
  "needs": "API unavailable — retry · API Error: 503 ...",
  "updatedAt": "2026-11-01T18:41:21.066Z",
  "createdAt": "2026-09-12T12:09:34.354Z"
}
```

而 `timeline.jsonl` 里这条 blocked **实际发生**在：

```json
{"at":"2026-10-05T15:57:02.483Z","state":"blocked","detail":"API Error: 503 No available channel for model <upstream-model> ...","text":"API Error: 503 ..."}
```

`timeline.jsonl` 里 `2026-11` 的记录数：**0**。最后一条事件就是 `2026-10-05T15:57:02.483Z`。

**所以：`state:"blocked"` 是 2026-10-05T15:57:02Z 写下的，`updatedAt` 是 2026-11-01T18:41:21Z——中间隔了 27 天。** `updatedAt` 只反映宿主最后一次**重写这个 json** 的时刻（例如启动时补写 `respawnFlags`、`name`、`providerEnv` 等元数据），不反映状态跃迁。

### 3.3 「24 小时活跃窗口」为什么没挡住它

```js
// scripts/watch.mjs:635-636
const updated = Date.parse(job.updatedAt || job.lastTerminalAt || job.createdAt || '');
if (!Number.isFinite(updated) || nowMs - updated > ACTIVE_WINDOW) { skipped++; continue; }
```

门槛用的正是上面那个被刷新的 `updatedAt`。于是候选从 `2026-11-01T18:41:21Z` 起**整整 24 小时**都是「活跃」的。

### 3.4 真正按下发送键的是「预算窗口翻转」

观察日志只有两条 BLOCKED 记录（`observationSeen` 去重导致中间的抑制没落盘，见 §7.2）：

```json
{"ts":"2026-11-01T18:41:21.390Z", ... ,"notified":false,"why":"budget-global-24h", ... }
{"ts":"2026-11-02T09:57:22.928Z", ... ,"notified":true,"why":null, ... }
```

`watch.log` 里紧邻的两次 tick 显示窗口在 09:57:07 与 09:57:35 之间翻转：

```
2026-11-02T09:57:07Z [INFO] tick jobs waiting jobs=59ms candidates=1 sent=0 suppressed=1 already=0 observed=1(BLOCKED:1)
2026-11-02T09:57:22Z [INFO] state 清理：移除 5 条超过 24h 的已通知条目
2026-11-02T09:57:35Z [INFO] notified BLOCKED <project-A> kind=- key=1f81ac43e562b43f session=<session-A>
2026-11-02T09:57:38Z [INFO] tick jobs waiting jobs=10ms candidates=1 sent=1 suppressed=0 already=0 observed=1(BLOCKED:1)
```

**精确复算 `canNotify()`（`GLOBAL_MAX_24H = 8`）。** `budget.sentLog` 里已经滚掉、但 `budget.perSession` 仍保留着的那一条是：

```
"2026-11-01T09:57:09.391Z"
```

（它来自 `2026-11-01T09:57:29Z` 那条 ASKED 通知——`runner.log:4820`，当时 `sessionId` 还是**完整绝对路径**，是后来被 `sessionIdOf` 修掉的那个 bug 的产物，所以它单独占了一个 `perSession` 键。）

按 `within(list, nowMs, DAY)` 复算：

| tick 时刻 | 该条年龄 | 窗口内条数 | 判定 |
|---|---|---|---|
| `09:57:07` | 23.9993 h | **8 / 8** | `BLOCKED`（`budget-global-24h`） |
| `09:57:22.928` | 24.0038 h | **7 / 8** | **PASS → 发出** |

**一条 24 小时前的时间戳滚出窗口，就这一条，把 8 降到 7。** 那个阻塞在 27.8 天前就发生了、进程早已不在、期间没有任何变化——触发它的唯一变量是预算算术。

**结论：这条通知的「触发时刻」完全由预算窗口的算术决定，与那个阻塞是否还存在、是否值得打扰毫无关系。**

---

## 四、ASKED 是怎么被判出来的

### 4.1 走的是哪条分支

```
asked.mjs: scanAll() → inspectTranscript(<session-B>.jsonl)     scripts/asked.mjs:118
  └─ lastAssistantText(records)      取最后一条 type==='assistant' 的非空文本
  └─ endsWithQuestion(text)          末尾最后一个 ?/？ 之后只剩 ≤2 字符  ✓
  └─ classifyQuestion(text)          命中 /要不要|要我|还是/ → 'decision'  ✓
  └─ hours = (now - 2026-11-01T23:31:45.824Z)/3600e3 = 10.48h
       hours < 1h ?  否
       hours > 24h ? 否       ← MAX_QUESTION_HOURS 正常工作，没有失效
  └─ return { kind:'decision', hours:10.5, question:... }
```

`watch.mjs:1694-1710` 把它转成候选：

```js
const asked = scanAll({ projectsRoot: join(root, 'projects'), nowMs, minHours: ASKED_MIN_HOURS });
const ac = askedCandidates(asked, { nowMs });
candidates = candidates.concat(ac);
```

### 4.2 逐条排除你列的四种可能

| 假设 | 判定 | 证据 |
|---|---|---|
| `endsWithQuestion()` 误判（代码块 / URL / 英文问句 / 列表问号） | **否** | 原文结尾是「…要我把这批改动提交吗？还是先继续清单里的 N 个任务？」，最后一个 `？` 之后只剩「喵」，`rest.length = 1 ≤ 2`。是真问句。 |
| `MAX_QUESTION_HOURS` 时间窗没生效 | **否** | `hours = 10.48 < 24`，本就不该被挡。这个常量在 `inspectTranscript` 里被正确调用（`e60dddf` 引入）。 |
| `BACKLOG_HOURS` 没生效 | **否** | 它按设计只用于 `mergeHistory` 的历史统计，不参与通知（`asked.mjs:278`）。不是本次原因。 |
| 重复通知去重失败 | **否** | 去重是成功的。`10:04:56.091Z` 那条 `why:"already-notified"`，`notifyCount` 停在 1。 |

### 4.3 那条问句本身是真实的

`<session-B>.jsonl`（117 MB）最后一条 assistant 文本，`uuid=<uuid-A>`、`timestamp=2026-11-01T23:31:45.824Z`：

```
## 三件我要诚实说的事喵
...
---

现在 N 处前置全部修完。要我把这批改动提交吗？还是先继续清单里的 N 个任务？
```

之后该 transcript **再无任何 `2026-11-02` 的 timestamp**（`rg -c '"timestamp":"2026-11-02'` = 0）。最后一条人类消息是 `2026-11-01T22:03:39.093Z`「先修那 N 处前置」；`last-prompt` 记录仍是它。

### 4.4 那么误报在哪

**不在「它是不是问句」，而在「这个提问还算不算『现在在问你』」。** 三个因素叠加：

1. **缺 live 对账。** `~/.claude/sessions/<pid>.json` 显示这个会话：

   ```json
   {"pid":<pid>,"sessionId":"<session-B>",
    "cwd":"<mc-server-root>\\Server plugin\\<project-B>",
    "status":"idle","statusUpdatedAt":1793575906007}
   ```

   `1793575906007` = `2026-11-01T23:31:46.007Z`——**它问完那一秒就 idle 了，并且 idle 了 10.5 小时**。`asked.mjs` 从不读这个文件。

2. **`MAX_QUESTION_HOURS=24` 的标定对象错了。** 注释写得很诚实：「实测 492 个真实问答对，回复延迟 p90 = 14.7h、99% 在 24 小时内」。这是**人类回复延迟的分布**，用来回答「等多久算失联」；但通知要回答的是「这条问题现在提醒还有没有用」。10.48 小时在这个窗口内，所以放行——**按代码是对的，按语义是错的**。

3. **同一项目的另一个并行会话已经给过答复。** 同一 cwd 下的 `<session-E>` 里，人类在 `2026-11-01T19:38:45.566Z` 说过：

   > 你不需要提交，只需要将自己的工作全部做完

   而 4 小时后 `<session-B>` 才来问「要我把这批改动提交吗喵？还是先继续…」。`asked.mjs` 的判定粒度是**单文件**（`inspectTranscript(filePath)`），结构上不可能看到这条。

### 4.5 同样被预算憋了 8.58 小时，而且是**同一条时间戳**放行的

```json
{"ts":"2026-11-02T01:25:18.275Z",...,"notified":false,"why":"budget-asked-24h",...}
{"ts":"2026-11-02T09:59:49.463Z",...,"notified":true,"why":null,...}
```

`ASKED_MAX_24H = 6`。按同样的复算方式（`askedLog` 历史 6 条，含那条 `2026-11-01T09:57:09.391Z`）：

| tick 时刻 | 该条年龄 | 窗口内条数 | 判定 |
|---|---|---|---|
| `01:25:18.275` | 15.469 h | **6 / 6** | `BLOCKED`（`asked-24h`） |
| `09:59:49.463` | 24.045 h | **5 / 6** | **PASS → 发出** |

**和 BLOCKED 是同一条**：`2026-11-01T09:57:09.391Z`。它在 `2026-11-02T09:57:09.391Z` 越过 24 小时线，同时给 `sentLog` 和 `askedLog` 各腾出一个名额。两条通知因此在 **2 分 27 秒内接连发出**——这就是用户体感的「刚才发出了两条错误通知」。

概率意义上这不是巧合：**本机 9 条发送里只有它一条落在那个位置，而它恰好同时占据两个配额表。** 单点故障同时放行两个互不相干的候选，把「两个独立的判据缺陷」压缩成「一起可见的事故」。

---

## 五、两条是否同源

**不同源。** 但共用一个放大器，且这个放大器有一条**具体的、可复现的**触发点（上面那条时间戳）。

### 5.1 根因 A：`updatedAt` 被当成事件时刻（BLOCKED）

```js
// scripts/watch.mjs:635-636
const updated = Date.parse(job.updatedAt || job.lastTerminalAt || job.createdAt || '');
if (!Number.isFinite(updated) || nowMs - updated > ACTIVE_WINDOW) { skipped++; continue; }
```

同一个字段还被当作「停了多久」的唯一来源写进通知正文（`scripts/watch.mjs:648`）：

```js
idleSec: Math.round((nowMs - updated) / 1000),
```

于是发出去的通知写着 `idle=916m`（15.3 小时），而真实的阻塞发生在 **27.8 天前**。这是一个**可验证的谎报**，不只是「过时」。

对照 `buildInbox()` 的同一条判断（`scripts/watch.mjs:1987-1988`）——它知道该怎么判：

```js
if ((e.state === 'FAILED' || e.state === 'BLOCKED') && cur && liveStatus === 'busy') stale = true;
if ((e.state === 'FAILED' || e.state === 'BLOCKED') && !cur) stale = true;
```

`<session-A>` 在 `sessions/` 里查不到（`!cur`），按 `buildInbox` 的规则应判 `stale: true`、默认不展示。**同一份数据，收件箱算得出「过时」，通知路径不算。**

### 5.2 根因 B：单文件文本判定 + 缺时效语义（ASKED）

见 §4.4。核心是判定维度缺失，不是判据算错。

### 5.3 共用放大器：24h 窗口翻转 + 发送前不复核

- `NOTIFIED_TTL_HOURS = 24`（去重表）、`budget.sentLog` / `askedLog` 滚动 24h、`ACTIVE_WINDOW = 24h`、`MAX_QUESTION_HOURS = 24` —— **四个 24 小时**，全部围绕「一天」这个未加论证的数字。
- 后果：所有在夜里被压下的候选会在**同一个窗口边界前后集体释放**。实测：

  | 通知 | 首次见到 | 实际发出 | 憋了 | 放行的那一条 |
  |---|---|---|---|---|
  | BLOCKED | 11-01T18:41:21Z | 11-02T09:57:22.928Z | 15h16m | `2026-11-01T09:57:09.391Z` 滚出 `sentLog`（8→7，上限 8） |
  | ASKED | 11-02T01:25:18Z | 11-02T09:59:49.463Z | 8h34m | **同一条**滚出 `askedLog`（6→5，上限 6） |

  两者相隔 2 分 27 秒发出，用户体感就是「刚才发出了两条错误通知」——**这解释了为什么这件事看起来像一个事故而不是两个**。

---

## 六、对照 `docs/spec/state-model.md`

### 6.1 BLOCKED 的判定：实现符合规范，但规范本身漏掉了「时效」

- `state-model.md` §2 序 0.5：`BLOCKED` 判据「**仅**宿主 `state === 'blocked'`」。实现一致。✓
- 但规范**通篇没有规定**「多久算过时」。`ACTIVE_WINDOW = 24h` 是实现私有常量，规范和 ADR 都没有背书（`grep ACTIVE_WINDOW docs/` 无命中）。
- 规范 §2 的「处置」列写的是「读它的 `needs` / `suggestedReply`，由人决定」。对一个 27.8 天前、进程早已不存在的 job，**这条处置指引没有意义**——你去「读」它，读到的是一句 27.8 天前的 503。

**判定：规范有缺口。** 缺口是「`BLOCKED` 的生命周期没有定义」——它从被写下到永远都有意义。

### 6.2 ASKED 的归类：实现跑偏

```js
// scripts/watch.mjs:826-830
/** 由宿主直接写下、不经过 transcript 推断的状态。
 *  这三者对「分类门 / 时间门」免疫 ... */
export const HOST_FACT_STATES = Object.freeze(['WAITING', 'BLOCKED', 'FAILED', 'ASKED']);
```

注释说「这三者」，数组里却有**四个**；更关键的是 `ASKED` **恰恰是由 transcript 推断出来的**（`asked.mjs` 开头第一行就写「**不依赖宿主**」）。把它并入 `HOST_FACT_STATES`，让它绕过了：

- `kind-not-notifiable` 门（`watch.mjs:1453`）
- `unclassifiable-too-recent` 时间门（`watch.mjs:1466`）
- 以及 `classifyCandidate` 的一切二次校验

观察日志里它甚至被打了 `"classify":"host"`——**一个推断信号的分类来源被标成宿主**：

```json
{"ts":"2026-11-02T09:59:49.463Z","sessionId":"<session-B>-...","state":"ASKED",...,"classify":"host",...}
```

而 `state-model.md` §2 明确写「每一步的判据必须是**可离线计算的事实**（来自 transcript 或 `claude agents --json`）」——这一点 ASKED 是满足的；但 §2 的表格里**根本没有 ASKED 这一行**。`grep -n "ASKED" docs/spec/state-model.md` 无命中。

**判定：两者都有问题。** 规范缺 ASKED 的定义；实现把它错误地归类为「宿主事实」从而获得豁免。

### 6.3 通知链路完全没有规范

`NOTIFY_STATES`、`HOST_FACT_STATES`、`ACTIVE_WINDOW`、`NOTIFIED_TTL_HOURS`、`canNotify()` 的四条限额、`askedCandidates()` 的指纹策略——**在 `docs/spec/` 下全部没有对应条文**（`grep -rn "NOTIFY_STATES\|ACTIVE_WINDOW" docs/spec/` 无命中）。

唯一相关的一句话在 `README.md:203`：

> **看不见的东西不告警。** 通知只能由宿主事实（`jobs.state`）触发，不由推断触发。宁可漏报，不可误报——误报通知会让人开始忽略通知。

而 `README.md:162` 还写着：

> 删除后 `NOTIFY_STATES = ['FAILED', 'BLOCKED']`

**但代码里是 `['WAITING', 'BLOCKED', 'FAILED', 'ASKED']`。** README 的这句陈述已经过期，且恰好掩盖了 ASKED 这条「不由宿主触发」的通道。

### 6.4 汇总

| 问题 | 是规范问题还是实现跑偏 |
|---|---|
| BLOCKED 把 27.8 天前的阻塞报成 15 小时前 | **实现**：`updatedAt` 语义误用。规范未定义时效，是**规范缺口**放大了它 |
| ASKED 绕过所有门 | **实现跑偏**（`HOST_FACT_STATES` 误归类）+ **规范缺口**（ASKED 未进 state-model） |
| 24h 窗口翻转导致集中释放 | **规范缺口**：通知子系统无规格，四个「24 小时」全是实现私有 |
| 发送前不复核现状 | **实现缺口**：`buildInbox` 有对账、`dispatchCandidates` 没有；规范未要求 |

---

## 七、附带发现（不影响上述结论，但会影响下一次复盘）

### 7.1 通知正文里的时间是假的

`describe()`（`scripts/watch.mjs:1321-1328`）用 `c.idleSec` 生成 `idle=916m`。对 jobs 来源，这个数来自被刷新的 `updatedAt`，**不是阻塞时长**。用户看到「受阻 · idle=916m」，实际是「27.8 天前的一个 503，记录文件 15 小时前被重写过」。

### 7.2 观察日志会隐藏「连续抑制了多久」

`createObservationLog()` 的去重键是：

```js
// scripts/watch.mjs:1093
const k = `${r.sessionId}|${r.state}|${r.kind}|${r.fingerprint || ''}|${r.why}`;
```

同一 `(session, state, kind, fingerprint, why)` 在进程生命周期内**只写一次**。于是「BLOCKED 被 `budget-global-24h` 连续压制了 15 小时」在 `observations.jsonl` 里只剩 **1 行**（18:41:21Z），尽管同期 `runner.log` 里有 **3,386** 条 tick 记录（`suppressed=1`）。

这直接影响了这次诊断的可读性——我一开始看到「只有两条记录」时，差点误判为「候选只出现过两次」。**观察日志目前的语义是「出现过什么」，不是「持续了多久」**，而 P1 要回答的恰恰是后者。

### 7.3 ASKED 是全文件读取

```js
// scripts/asked.mjs:120
raw = readFileSync(filePath, 'utf8');
```

本机顶层 transcript 共 **193 个、1.34 GB**，最大的单个 117 MB（正是 `<session-B>`）。`asked` 层每 5 分钟（且只要任一项目 mtime 变化）就把它们全读一遍。实测日志里出现 `probe=519ms`、`probe=345ms` 的离群 tick，与这一层同轮触发吻合。这不是本次误报的原因，但是下一次「守护进程变慢」的候选根因。

### 7.4 <project-A> 项目有两个「同名不同物」的实体

- 死掉的 job 会话 `<session-A>`（`~/.claude/jobs/<session-A>`，10-05 起 blocked，无 live session）
- 活着的会话 `<session-D>`（`~/.claude/sessions/<pid>.json`，`status: busy`，name `<project-A> 多agent工作流`，11-02 10:44 与 11:02 都有真人消息）

**同一个项目名、同一天，一个报「受阻」一个在正常干活。** 任何以 `project` 为键的展示或去重都会在这里出错——目前 `notified` 表是按 `dedupeKey(sessionId, ...)` 分的，侥幸没出错，但这是设计上的隐患。

---

## 八、修复方向（不在本次范围，供后续 Agent 参考）

按「改动最小 / 证据最强」排序：

1. **`probeJobs` 不要用 `updatedAt` 当事件时刻。** 优先取 `job.firstTerminalAt`（有则用，`<session-A>` 有：`2026-09-12T12:09:41.462Z`）或从 `timeline.jsonl` 尾部取最后一条 `state === 'blocked'` 的 `at`；若三者都没有，宁可跳过也不要拿 `updatedAt` 充数。
2. **`dispatchCandidates` 在发之前做一次 `buildInbox` 式的 live 对账。** 逻辑已经写好且测试过（`watch.test.mjs:1594` 附近），只是没被通知路径调用。对 `!cur`（会话已不存在）的 job 来源候选直接判过时。
3. **把 ASKED 从 `HOST_FACT_STATES` 拆出去**，让它重新走 `kind` 门与时间门；或至少在 ASKED 判定里合并 `sessions/*.json` 的 `statusUpdatedAt`，要求「会话仍活着且最近有活动」。
4. **重新标定 `MAX_QUESTION_HOURS`**：现在的 24h 来自「回复延迟 p99」，应当另立一个基于「提问后会话静默时长」的分布——本机有 492 个问答对的原始数据可复算。
5. **给通知子系统补规格。** `docs/spec/` 下新增一节，把 `NOTIFY_STATES` / `ACTIVE_WINDOW` / 四条限额 / 去重键 / 指纹策略写死，否则下一次仍会是「代码对了、语义错了」。
6. **修 README 那句过期的 `NOTIFY_STATES = ['FAILED','BLOCKED']`。**

---

## 九、证据清单（可复现命令）

```bash
# 两条通知（LOG 指 %LOCALAPPDATA%\Overwatch\watch.log 或 runner.log）
grep -n "notified BLOCKED\|notified ASKED" "$LOCALAPPDATA/Overwatch/watch.log" | tail -5

# 边沿与预算
node -e "const s=require(process.env.LOCALAPPDATA+'/Overwatch/state.json');console.log(s.notified['1f81ac43e562b43f'],s.notified['77326dfc816f0674'],s.budget)"

# <project-A> job 的真实阻塞时刻（timeline 最后一条即 10-05 的 503）
tail -c 2000 ~/.claude/jobs/<session-A>/timeline.jsonl

# <project-B> 的最后一条问句
tail -c 200000 ~/.claude/projects/<project-B-slug>/<session-B>.jsonl \
  | grep '"type":"assistant"' | tail -3

# 两个会话的 live 状态
cat ~/.claude/sessions/<pid>.json   # 两个会话的 live 状态各读一次
```

---

*报告完。未修改任何代码、未接触 git、未重启守护进程。*
