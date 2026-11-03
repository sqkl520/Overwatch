# 2026-11-02 两条通知的独立复算

> 复核 Agent D2。**不看任何人的诊断**，只从 `~/.claude/` 下的原始日志重算。
> 全部数字由本机原始文件重算得出，可按下文 §7 的命令复现。

## 1. 结论先行

| # | 通知原文（守护进程日志） | 我的独立结论 | 差在哪 |
|---|---|---|---|
| A | `2026-11-02T09:57:35Z notified BLOCKED <project-A>` | 该会话**早已结束**（最后一次真实活动 2026-10-05T15:57:02Z，即 27.7 天前；宿主自己在 `daemon.log` 里已 `settled (done)`）。按本项目词汇只能叫 `EXPLORING / dormant`，处置是**不干预、不通知**。 | **确认误报**。`BLOCKED` 的内容是 27.7 天前的一次 503，`idleSec=54962`（15.3 小时）算的是「job 记录被写入」到「现在」，不是「卡住多久」。真正正确的数字 `idle=40091 分钟`（27.8 天）在同一轮的另一个代码路径里就算出来了，被扔掉了。 |
| B | `2026-11-02T10:00:49Z notified ASKED <project-B>` | 最后一条 assistant **确实是问句、确实没人回答**（真人最后一句在 8.5 小时之前，问句在它之后）。`ASKED` 这个**判定是对的**。 | **不是假阳性，是「迟到 + 内容残缺」**。问题出现于 11-01T23:31Z，首次入库 11-02T01:25Z，被 `budget-asked-24h` 压住，直到 09:57 清理掉 5 条旧条目才放行 → 通知晚了 **8.5 小时**；`needs` 是被截断的第 200 个字符起的片段，开头是 `t-world.ps1\`` 半个词。 |

一句话：**A 是判据错（把陈旧的宿主记录当实时事实），B 是投递错（判据对、时机和载荷错）。**

原始数据里能区分出来的宿主信号只有 `FAILED` / `BLOCKED` 两条（`README.md` 已写明），
而这两条恰好都依赖「宿主记录 = 此刻为真」这个前提 —— A 证明这个前提在**后台作业**这一类上是假的。

---

## 2. 事件 A：<project-A> 的 `BLOCKED`

### 2.1 它到底是哪个会话

按 `name` 字段匹配（不是按字面搜目录名），会话元数据里只有一个 <project-A>：

- `~/.claude/sessions/41192.json`：`"name":"<project-A> 多agent工作流"`、`status":"busy"`、cwd 指向 <project-A> 目录。
  这是**当前活着的那个**会话 `<session-D>`，不是被报的那条。
- 被报的是**后台作业**：`~/.claude/jobs/<session-A>/state.json`，`"name":"<project-A>"`、
  `"sessionId":"<session-A>"`、
  `"resumeSessionId":"<session-C>"`、
  `"linkScanPath"` 指向 `<session-C>-…jsonl`、`"template":"bg"`。
  守护进程日志 `notified BLOCKED <project-A> … session=<session-A>…` 与它一致。

**注意：`<session-A>` 这个 sessionId 在本机根本没有对应 transcript 文件。**
`~/.claude/projects/<project-A-slug>/` 下只有 `<session-C>`、`<session-Q>`、`<session-R>`、`<session-D>` 等，
没有 `<session-A>.jsonl`。任何按 sessionId 去找 transcript 的下游（分类、traceability、relay 草稿）都只能扑空 ——
这解释了观察日志里该条 `fingerprint:""`、`classify:"host"`。

### 2.2 宿主当时到底说了什么（原文）

`~/.claude/jobs/<session-A>/state.json` 关键字段，逐字：

```json
"state": "blocked",
"detail": "API Error: 503 No available channel for model <upstream-model> under group default (distributor) <request-id-1> <request-id-2>. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (<local-gateway>).",
"needs": "API unavailable — retry · API Error: 503 …(同上)…",
"updatedAt": "2026-11-01T18:41:21.066Z",
"firstTerminalAt": "2026-09-12T12:09:41.462Z",
"linkScanOffset": 14322656,
"linkScanPath": "…\\<session-C>.jsonl"
```

### 2.3 这条 503 是「刚才」还是「很久以前」——查证

我没有相信 `updatedAt`，而是回到 transcript 里比对这段文字：

`<session-C>-…jsonl` 中 `timestamp: 2026-10-05T15:57:02.390Z` 的 assistant 记录，顶层字段：

```
"error": "server_error", "isApiErrorMessage": true, "apiErrorStatus": 503
```

其 `message.content[0].text` 与上面 `job.detail` **逐字节相同**（两者长度均为 351，程序比对
`detail.endsWith(text) === true`）。它前面紧挨着的是一条工具失败：

```
[2026-10-05T15:53:42.710Z] tool_result is_error=true
"claude-sonnet-5[1M] is temporarily unavailable (server error), so auto mode cannot determine
 the safety of Bash right now. …"
```

并且这是该文件的**最后一条** assistant 记录 —— 我扫了整份 14.3 MB 文件（不是只看尾部）：

- 文件内出现过的最大 `timestamp` = `2026-10-05T15:57:02.510Z`
- 最后一条 `origin.kind === "human"` 的真人消息 = `2026-10-05T14:58:03.490Z`（「继续」之前那条）
- 全文含 `2026-11` 的时间戳数量 = **0**

**结论：这条 503 是 2026-10-05 的，距通知时刻 27 天 18 小时。**

### 2.4 宿主其实已经判过它结束了，只是那个判断写在守护进程不读的地方

`~/.claude/daemon.log`（Claude 自己的后台作业守护日志）同一条作业的生命周期：

```
[2026-11-01T18:41:21.055Z] [bg] bg spawned <session-A> (fleet)
[2026-11-01T19:42:16.053Z] [bg] bg retire <session-A>: idle-prompt, idle 61m
[2026-11-01T19:42:16.307Z] [bg] bg settled <session-A> (done)
```

也就是说：11-01T18:41 拉起（resume 的是那份 10-05 的 transcript）→ 立刻又撞同一个 503 →
写 `blocked` → **19:42 被宿主以 `idle-prompt` 退休，落定 `done`**。

`jobs/<session-A>/state.json` 在 `done` 之后**没有被重写**（它仍是 `blocked`，`updatedAt` 仍是 spawn 那一刻）。
对照另一条已知干净的作业 `jobs/<job-C>`：`firstTerminalAt=2026-10-05T12:26:44Z` 而 `updatedAt=14:56:21Z`，
说明这个字段**本可以在终态被再刷一次**，但 `blocked` 这一支没有。

`scripts/*.mjs` 里对 `daemon.log` 的引用数 = **0**（grep 全仓无命中）。所以「已 settled (done)」这个事实，
Overwatch 从头到尾没看过。

### 2.5 守护进程当时算出来的东西

`%LOCALAPPDATA%\Overwatch\observations.jsonl`：

```json
{"ts":"2026-11-02T09:57:22.928Z","sessionId":"<session-A>-…","state":"BLOCKED","idleSec":54962,
 "reason":"host-reported-blocked","notified":true,"why":null,"source":"jobs","fingerprint":""}
```

`54962 s = 15.27 h`。这个数 = `now − job.updatedAt(18:41:21Z)`，即「作业被拉起的时刻」，**不是**「卡住的时刻」。
`notifyTitle` → `⏸ <project-A> · 受阻`；`describe` 里的 `idle=916m` 同样是这 15.3 小时。
用户看到的是「<project-A> 受阻，等了 916 分钟，在等：API unavailable — retry · API Error: 503 …」——
一个 27 天前的事件被包装成 15 小时前的新鲜事件。

### 2.6 放行它的那道门为什么没拦住

`ACTIVE_WINDOW = 24h` 判的是 `now − job.updatedAt`。15.3 h < 24 h，过了。
**这是结构性失效，不是阈值没调好**：把 24h 改成 6h 也拦不住 —— 作业本来就是 15 小时前被拉起的，
它的「新鲜度」来自被拉起，而不是来自出错。

同一轮里正确的数字其实已经算出来了，只是挂在另一个 sessionId 下：

```
$ node scripts/scan-sessions.mjs --days 3 --json --project <project-A>
<session-C> BLOCKED host-reported-blocked idle=40091m  ← 27.8 天（正确）
<session-R> EXPLORING dormant            idle=4066m
<session-Q> EXPLORING dormant            idle=3765m
<session-D> PRODUCING persistent-change-in-window idle=1m
```

原因在 `sessionId` 的取法不一致：

- `scripts/scan-sessions.mjs` 的 `readJobs()`：`sessionId` = 从 `linkScanPath` 抠出来的 → `<session-C>`
- `scripts/watch.mjs` 的 `probeJobs()`：`job.sessionId || job.resumeSessionId || name` → `<session-A>`

两条路径对**同一条记录**给出两个不同的 sessionId，于是 `candidatesFromScan` 用 `lastActivity`（10-05，
远超 24h）正确地把它丢掉了，而 `probeJobs` 用 `updatedAt` 错误地把它捡了回来。
正确判据与错误判据在同一进程里并存，去重键也不同（`<session-A>|BLOCKED|host-reported-blocked|`）。

### 2.7 我的判定

**`WAITING` / `BLOCKED` / `FAILED` / `ASKED` 都不是。这个会话已经结束了。**

- 最后一次真实活动：`2026-10-05T15:53:42Z`（工具失败）→ `15:57:02Z`（503）
- 最后一次真人发言：`2026-10-05T14:58:03Z`
- 宿主自己的结论：`settled (done)` @ `2026-11-01T19:42:16Z`
- 现在没有进程在跑它（`sessions/*.json` 里没有 <session-A>；作业目录里 `resumeFlags` 只是历史参数）

按 `docs/spec/state-model.md` 的词汇表，7 天无活动的会话落 `EXPLORING / dormant`（第 1 行，`DORMANT_MS=1h`）。
但更诚实的说法是**它不在状态机里** —— 状态机的五个状态都假设「会话还在」。这是词汇表缺一个 `ENDED`。

---

## 3. 事件 B：<project-B> 的「问了没答」

### 3.1 是哪个会话

`notified ASKED <project-B> … session=<session-B>`。
对应 `~/.claude/projects/<project-B-slug>/<session-B>-….jsonl`，**116.9 MB / 111.5 MiB**（本机最大的一份），
mtime `2026-11-01T23:31:45.956Z`。

### 3.2 尾部原文（这句话到底是不是在问用户）

最后一条带文本的 assistant 记录，`timestamp 2026-11-01T23:31:45.824Z`，结尾两段逐字：

> 我写进 CHANGELOG 的 Notes 里了。
>
> ---
>
> 现在 N 处前置全部修完。**要我把这批改动提交吗？还是先继续清单里的 N 个任务？**

这是一次**二选一的明确决策请求**（`classifyQuestion` 判 `decision`，命中 `要我` + `还是`）。
不是反问、不是自问、不是引述用户 —— 引述会带引号且问号不在句末，这里问号在最后一个字符。

### 3.3 它之后还有没有别的记录

我把该文件最后 4 MB 解析出来逐条看，问句之后只有三条：

```
+1 assistant 2026-11-01T23:31:45.833Z  （只有 thinking 块，空 text）
+2 system    2026-11-01T23:31:45.920Z  subtype=stop_hook_summary, preventedContinuation=false
（文件到此为止，mtime 也是 23:31:45）
```

没有任何 `tool_use`；没有任何 `origin.kind === "human"`。

我扫了**整份** 116.9 MB 文件统计真人消息：共 57 条，**最后一条**是
`2026-11-01T22:03:39.093Z`「先修那 N 处前置」——在问句之前 1.5 小时。
文件内最大 `timestamp` = `2026-11-01T23:31:45.920Z`，之后没有任何写入。

### 3.4 所以判据对不对

**对。** 三条都成立：末条 assistant 是问句、问号在句末、问号之后没有真人消息。
`hours = (10:00:49Z − 23:31:45Z) ≈ 10.5 h`，落在 `MAX_QUESTION_HOURS = 24` 以内，
在 `DEFAULT_MIN_HOURS / ASKED_MIN_HOURS = 1` 以上。规范层面这是一次合法命中。

### 3.5 那用户为什么觉得是误报 —— 真正的毛病

**(1) 迟到了 8.5 小时。** 同一条问题在 `observations.jsonl` 里的完整轨迹：

```
2026-11-01T21:15:34Z  ASKED  notified=false  why=budget-asked-24h   （同一会话更早的那版问句）
2026-11-02T01:25:18Z  ASKED  notified=false  why=budget-asked-24h   （本条文首次入库，已被压住）
2026-11-02T09:59:49Z  ASKED  notified=true   why=null                ← 实际发出
2026-11-02T10:04:56Z  ASKED  notified=false  why=already-notified
```

放行时刻 `09:57:22Z` 恰好是 `state 清理：移除 5 条超过 24h 的已通知条目` 的那一轮 ——
`askedLog` 是**滚动 24 小时窗口**，旧条目过期腾出名额，这条才够格。
也就是说：**通知的时机由「别的通知的过期时间」决定，不由「这个问题有多急」决定。**
早上 01:25 就在等你，你 10:00 才被叫。

**(2) 载荷被截断在词中间。** `state.notified["77326dfc816f0674"].needs` 长 200 字节，逐字开头是：

```
t-world.ps1` 留在 harness 里喵——这类问题会反复出现喵。\n\n### ③ 还留了 5 条 lint 警告没修…
```

`askedCandidates` 写的是 `needs: String(it.question).slice(-200)` —— 砍掉的是**开头**，
于是 toast 正文从一个词的中间开始，真正的问句被压在最后 30 个字里。
`evidenceFingerprint` 用最后 60 字（设计如此，为了去重稳定），但展示用的 `needs` 不该这样截。

**(3) 会话本身已经不在了。** `~/.claude/sessions/` 22 个文件里没有 `<session-B>`；
transcript 自 23:31 未再写入。你收到「问了没答」时，能回答它的那个进程已经不在了 ——
通知没说这一点，也没给 resume 的入口。

---

## 4. 假阳性来源逐项核对（点名要求的六条）

| 假设 | 结论 | 证据 |
|---|---|---|
| `endsWithQuestion()` 把代码块 / URL / 表格里的 `?` 当提问 | **潜在缺陷存在，但本机当前语料没触发** | 我直接调用该函数做了 26 个反例探测。确认会的：`见 https://x.com/a?b=1?`（URL 以 ? 结尾）→ 判提问；`` 执行 `a?b:c?` ``（行内代码以 ? 结尾）→ 判提问；表格行 `\| 要提交吗？\|`（问号后跟 `\|`，`\|` 不在剥离字符集里，`rest.length=1≤2`）→ 判提问。不会的：``` 围栏 / `self?` 中段 URL / `为什么？因为…`（自问自答）。本机 186 份 transcript 里只有 8 份以问句结尾，逐条读过，**没有一条是这三种形态**。 |
| 问号结尾但其实是**反问 / 自问 / 引述用户** | **本轮未命中** | 8 条里 0 条属于这类。反例 `难道不是这样吗？` 确实会被判提问（`kind=vague`），但语料里没有。 |
| 会话长时间没动（十几天前）被当新问题 | **这条门槛是好的，独立复算通过** | 我用 `nowMs=2026-11-02T10:00:49Z` 亲自跑 `scanAll`：`scanned 196, found 1, skipped {greeting:3, tooRecent:0, tooOld:4}`。被 `MAX_QUESTION_HOURS=24` 正确排除的是 66.7h / 68.1h / 304.2h（12.7 天）/ 543.0h（22.6 天）那四条。3 条开场客套被 `GREETING` 排除。**`BACKLOG_HOURS` / `MAX_QUESTION_HOURS` 确实生效了。** |
| 宿主 `status` 有滞后，读到的是几小时前的 `waiting` | **未命中本次两条，但机制存在** | 事件 A 是 `jobs` 路径的滞后（`updatedAt` 停在 spawn 时刻）。另有一个同类隐患：`2026-11-02T10:09:57Z` 观察记录 `<session-D> WAITING / waiting:permission prompt` 来自 **scan 路径**，而该会话的 `sessions/41192.json` 在 `10:10:21` 已变回 `busy` —— 也就是说这个 `waiting` 存活不到 24 秒。它这次只是被 `budget-global-24h` 顺手压住（`notified=false`），不是被判据压住。`probeWaiting` 只在探测瞬间成立，但 **scan 路径产出的 WAITING 在发送前不会复验**，也没有最短驻留时间。 |
| 子 Agent（subagent）消息被当主会话提问 | **排除** | 两重证据：(a) `scanAll` 的 walk 跳过路径含 `subagents` 的文件；(b) 我遍历全部 **186** 份顶层 transcript，检查「最后一条带文本的 assistant 记录是否 `isSidechain:true`」→ **0 份**。 |
| 工具返回内容里含问号被当 assistant 提问 | **排除** | `lastAssistantText` 只认 `r.type === 'assistant'`；`tool_result` 记录是 `type:"user"` 且内容在 `content[].type==='tool_result'` 里，不会进入文本拼接。事件 A 的 503 文本虽在 assistant 记录里，但它不含问号，且 `asked` 层压根没报它。 |

---

## 5. 是规范定错、实现跑偏，还是数据有歧义

三条都占，各自对应一件事：

**(a) 规范缺一个状态 → `ASKED` 不在规格里。**
`grep ASKED docs/spec/*.md` **零命中**。但实现里 `ASKED` 同时是
`NOTIFY_STATES` 四个之一、`HOST_FACT_STATES` 四个之一，而且**豁免分类门与时间门**
（`dispatchCandidates` 里 `isHostFact` 分支）。`docs/spec/state-model.md` §2 的互斥表里只有
`FAILED / BLOCKED / WAITING / EXPLORING / STALLED / PRODUCING`。
**一个会发通知、会绕过两道门的判定，在「可执行判据的唯一真源」里不存在。**
它还是唯一一个**由 transcript 推断**却被登记成 `classify:"host"` 的状态（观察日志里就能看到），
这与同文件「判定不可由 Agent 自述、宿主事实优先」的框架是矛盾的。

**(b) 实现跑偏 → `probeJobs` 把「作业记录写入时刻」当成「事件时刻」。**
`idleSec = now − job.updatedAt`。对 `failed` 尚可（失败时会写一次），对 `blocked` 不行：
`blocked` 是一个**可以永远不刷新**的陈旧值。规范 §2 第 0.5 行写「仅宿主 `state === 'blocked'`」，
字面上实现没违背 —— 所以这条要算**规范给了个不可执行的判据**：它没有声明新鲜度归谁负责。
另外 `probeJobs` 与 `readJobs` 对同一条记录产出两个 sessionId（§2.6），使同一轮里正确判据与错误判据并存。

**(c) 数据本身有歧义 → `updatedAt` 与内容时间可以差 27 天，且没人能一眼看出。**
`<session-C>-….jsonl` 的 **mtime 是 `2026-11-01T19:42:16Z`**（正是被 retire 的那一刻），
而**内容里最大的时间戳是 `2026-10-05T15:57:02Z`**。
任何拿 mtime 当新鲜度的判据（`probeMtime` → 触发增量扫描，正是它让 <project-A> 这个项目被扫到）
都会把这份文件当成 14 小时前的。**mtime 会撒谎，这是宿主行为，不是我们的 bug —— 但判据必须不依赖它。**

---

## 6. 我建议的判据（只写判据，不改代码）

1. **`BLOCKED` / `FAILED` 必须带「事件时刻」，不能用记录写入时刻。**
   后台作业的可用证据只有两处：`daemon.log` 的 `settled (<结论>)` 行，以及 `linkScanPath`
   指向的 transcript 的**内容最大时间戳**。后者已在 `scan-sessions.mjs` 里算出来了。
   判据：`eventAge = 现在 − max(transcript 内容最大时间戳, job.firstTerminalAt)`，
   `eventAge > ACTIVE_WINDOW` 就不通知。对 A 而言 `eventAge = 27.7 天` → 正确抑制。
2. **宿主说 `done` / `settled` 之后，旧的 `blocked` 一律作废。**
   `daemon.log` 是唯一写明终态的地方，不读它就等于放弃这个信号。
3. **`probeJobs` 与 `readJobs` 必须用同一个 sessionId 取法**，否则去重键不同、同一件事会被两条路径各报一次。
4. **`ASKED` 进规格**，并明确它「由 transcript 推断」，不作为 `host` 事实跳过分类门。
5. **`endsWithQuestion` 的尾部剥离集要包含 `` ` ``、`|`、`]`、`>`**；
   并显式拒绝「问号前是 URL / 围栏内」的形态。当前 26 个探测里 3 个误判，全部是这三类。
6. **`needs` 展示不要用 `slice(-200)`**。至少保证不从一个词中间起头（向前找到最近的换行或标点）。
7. **`WAITING` 在发送前复验一次**（scan 路径的 waiting 生命周期实测可短于 24 秒）。

---

## 7. 复算方法（可复现）

```bash
# 事件 A：作业状态与生命周期
node -e 'const j=require(process.env.USERPROFILE+"/.claude/jobs/<session-A>/state.json");console.log(j.state,j.updatedAt,j.linkScanPath)'
# → blocked 2026-11-01T18:41:21.066Z …\<session-C>-…jsonl
grep -n "<session-A>" ~/.claude/daemon.log | tail -3
# → spawned 18:41:21 / retire idle-prompt 19:42:16 / settled (done) 19:42:16

# 事件 A：证明 503 文本来自 10-05（整文件扫，不只看尾部）
#   该文件内 timestamp 最大值 = 2026-10-05T15:57:02.510Z；含 "2026-11" 的时间戳数 = 0
#   文本长度 351，与 job.detail 逐字节相同；记录带 error=server_error / apiErrorStatus=503

# 事件 B：末条 assistant 文本与「之后有无真人消息」
#   <session-B>：末条文本 ts=2026-11-01T23:31:45.824Z，之后仅 1 条空文本 thinking + 1 条 stop_hook_summary
#             真人消息 57 条，最后一条 2026-11-01T22:03:39.093Z

# 语料级复算（我自己算的，不是抄 asked.mjs 的输出）
#   186 份顶层 transcript → 8 份以问句结尾
#   nowMs=2026-11-02T10:00:49Z 时：found=1，skipped{gretting:3, tooOld:4}
#   全部 186 份中「末条带文本 assistant 是 sidechain」= 0

# 守护进程自己的账
#   %LOCALAPPDATA%\Overwatch\observations.jsonl（115 行）
#   %LOCALAPPDATA%\Overwatch\watch.log / runner.log（notified 共 18 条）
#   %LOCALAPPDATA%\Overwatch\state.json（notified / budget.sentLog / budget.askedLog）
```

> 说明：本文所有路径用 `~` 与 `%LOCALAPPDATA%` 表示。可发布区不允许出现本机绝对路径
> （`scripts/check-structure.mjs` 会拦），故未贴盘符路径原文。
>
> 落盘后跑过 `node scripts/check-structure.mjs`：**本文件 0 违规**。
> 同一轮里另外 2 项违规来自另一份并行产出的调研文档（不在公开范围内，未入库），
> 含两条本机绝对路径，不属于本次复核范围，未改动。

