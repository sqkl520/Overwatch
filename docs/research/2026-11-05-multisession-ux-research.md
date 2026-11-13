# 多会话用户真正需要 TUI 回答什么

> 日期：2026-11-05（检索与实测执行于 2026-11-09/10）
> 角色：检索 Agent TR3。产出形态：**exploration**（需求实证，不是设计稿）
> **未修改 Overwatch 任何代码，未碰 git。**
> 全部引用逐条带来源；找不到证据的地方写「没找到」，不用「一般来说用户会……」填空。

---

## 覆盖声明（按 `docs/spec/evidence-discipline.md` §4）

**实际抓取并读了原文的**

| 来源 | 内容 | 方式 |
|---|---|---|
| Hacker News（Algolia API） | 约 20 个帖子／评论树，重点是 49107749（Agent-Manager，98 分／80 评论）、47602986（agents-observe，77 分）、47765556（Claude Control）、47310039（amux）、47287559（iTerm2 tab status）、46913565（Beam）、49245269（Ask HN 2026-08） | `hn.algolia.com/api/v1/items/<id>`，原文 HTML 去标签 |
| `code.claude.com/docs/en/agent-view.md` | Agent view 全篇（11 万字符），含分组、行摘要、空状态、`--json` 字段表 | 直取 `.md` 源 |
| GitHub README（`gh api .../readme`） | `asheshgoplani/agent-deck`（100 KB）、`YoanWai/agent-manager`（22 KB）+ `docs/usage.md`（108 KB）、`getpaseo/paseo`、`sethdeckard/atria`、`herdrdev/herdr`、`Yeachan-Heo/oh-my-claudecode` | `gh api` |
| GitHub issues（`gh api`） | paseo #9155 / #9166 / #9193；agent-deck #3089 等 | `gh api` |
| `githubstatus.com`、`healthchecks.io/docs` | 空状态原文 | `curl --proxy` |
| `sre.google/sre-book/monitoring-distributed-systems/` | 「Every page should be actionable」整段 | `curl --proxy` |
| 本机实测 | `scan-sessions.mjs --days 3 --json`、`oversight-tui.mjs --plain`、`claude agents --json --all`、`verify-claims.mjs`、`~/.claude/jobs/*/state.json`、`~/.claude/sessions/*.json` | 只读 |

**做了但没拿到**：Reddit（`reddit.com` 返回 403、pullpush 526）；X/Twitter；Cursor Agents Window 只有官方文档，没有用户评价。

**没做**：没有跑任何 A/B 或用户测试；没有采访真实用户；没有改 TUI 去验证改动效果。

**无法核实**：`claude agents` 的 Haiku 行摘要质量（需要真的盯着它跑）；**没有查看任何竞品截图**
（只读了 README / docs 的文字描述，图片链接没有抓取），所以「第一屏长什么样」全部来自文档自述，
不是视觉核对。

---

## 零、结论先行

**1. 用户要的不是「每个会话处于什么状态」，是「哪一个在等我、等我做什么」。**
六个竞品（官方 agent view + agent-deck / agent-manager / herdr / paseo / atria），
**没有一个把工具调用次数或新颖度放主屏**（六个 README 里 `novelty` 出现 0 次）；
其中五个把「需要你」做成**默认优先或一键可达**：agent view 分 `Needs input` / `Ready for
review` 置顶、agent-deck 默认 `sort = "waiting"`、agent-manager 的 `w` 只显示 waiting /
finished / errored、herdr 的用户原话是「priority queue of agents requiring intervention」、
paseo 的侧栏有独立 `Needs review` 组。**atria 是例外**——它只提供 `s` 循环排序，README 里
没有「需要你置顶」的描述。
用户原话反复是同一个句式：「which one needs me and which one is still working」
（Claude Control 作者）、「no good way to see which of your 8 running sessions actually needs
attention」（amux 作者）、「I can't tell what state any of them is in without tabbing through
every terminal. One of them is usually sitting on a permission prompt I never saw」（Agent-Manager
作者，98 分）。**「needs you」是筛子，不是字段。**

**2. 我们当前主屏，一个可行动的条目都没有——包括此刻真实存在的两个。**
实测：宿主 `claude agents --json` 报 2 个后台会话处于 `blocked`（其中一个的 `needs` 是
「要我现在就把用户实测单交给你，还是你先看这四份测试报告？」，另一个是 API 503 错误），
而 `oversight-tui.mjs --days 3 --plain` 的输出里 `BLOCKED` 行数是 **0**。
原因不是渲染，是行源：`scan-sessions.mjs` 以 **transcript（.jsonl）为行源**，`jobs/state.json`
只在「已经有这一行」时补字段。这两条在扫描里都不成行，但**原因不同**：
`7710fbdb` 的 transcript **不存在**（全盘找不到，`linkScanPath` 指向的文件也不存在）；
`a9fa4c62` 的 transcript 存在（`resumeSessionId: af6779f8-…`），但 mtime 是 **7.9 天前**，
被默认的 `--days 3` 窗口挡住了。TUI 的 `mergeLiveSessions` 只从 `~/.claude/sessions/*.json`
补 `WAITING/BLOCKED/FAILED`——而后台任务不写那个目录（实测该目录 0 条 blocked）。
**这是本次调研最硬的一条：仪表盘漏掉的正好是唯一的待办，而且两种漏法不一样，
说明「行的全集」不能用单一数据源。**

**3. `calls` / `novelty` 不是决策字段，是语料统计量。它们占了主屏约 30 列，换来 0 个决策。**
实测 n=29（`--days 3`）：`calls` p10/p50/p90 = 157 / 1733 / 3906，与子 agent 数相关系数
**0.976**（它就是「这个 transcript 有多长」的代理量），与 idle 小时数相关系数 **-0.15**
（说明不了「它是卡住还是在跑长活」）。`novelty` 17/29 **恰好等于 1.00**，最小值 0.707，
p10 = 0.91——而判 `STALLED` 的阈值是 0.2，于是判据从不触发（与 `README.md` 自述
「56,809 个滑窗命中 10 次，0.018%」一致）。用户例子里那行
`calls=2589 nov=0.94` 落在中位数附近，**不代表任何需要做的事**。

**4. 主场景是「离开—回来 + 通知后确认」，不是持续监控。**
证据是用户原话（「几小时后回来记不得每一个在干什么」），不是推测；而且本机实测
`scan-sessions --days 3` **16–21 s**、宿主官方 `claude agents --json` **7–11 s**，
TUI 的 8 秒轮询是「扫描完再等 8 秒」，实际周期 **≥24 s**。
**「实时监控」在这台机器上物理不成立**，界面不该按监控模式设计。

**5. 空状态的正确形态是「一行结论 + 时间戳 + 一个动作」，不是空列表。**
GitHub Status 用一行 `All Systems Operational` 加一个 last-updated；
healthchecks.io 的原则是「按时到就不出声」（silence = health）；
`git status` 用一行 `nothing to commit, working tree clean`。
反例：`gh pr list` 和 `npm outdated` 在空的时候**什么都不打印**（本机实测 exit 0、零输出）——
用户无法区分「没事」和「命令挂了」。

---

## 一、真实证据

### 1.1 用户抱怨的原文

| # | 原话（去 HTML 标签，未改字） | 来源 |
|---|---|---|
| 1 | 「I've been running multiple Claude Code sessions in parallel across different repos and got tired of **cmd-tabbing between terminal tabs trying to figure out which one needs me and which one is still working**.」 | Claude Control 作者，HN 47765556 |
| 2 | 「I built amux because running 5–10 Claude Code agents at once across different repos turned into an unmanageable mess of terminal tabs and forgotten sessions… **there's no good way to see which of your 8 running sessions actually needs attention. I was losing work and wasting money.**」 | amux 作者，HN 47310039 |
| 3 | 「I run three or four coding agents at once and the part that eats my time isn't the coding, it's that **I can't tell what state any of them is in without tabbing through every terminal. One of them is usually sitting on a permission prompt I never saw.**」 | Agent-Manager 作者，HN 49107749（98 分） |
| 4 | 「I run multiple Claude Code sessions and **kept losing track of which tab finished or needs permission**.」 | iTerm2 tab status 作者，HN 47287559 |
| 5 | 「I run multiple Claude Code sessions and **the biggest friction isn't organizing terminals, it's remembering what each one was doing when I come back hours later**. Subwindow naming helps, but a **'last command' preview** in the quick switcher would save me from opening each one just to remember where I left off.」 | Beam 帖子评论，HN 46913565 |
| 6 | 「Also been observing **'productivity loss' by working on multiple Claude Code sessions in parallel (~5-7)** and having to context switch between them multiple times during the day. Sometimes I literally have to ask 'My brain is fried, can you catch me up? Keep it concise…' Other times I force myself to not open another session and rather wait for a few minutes for an ongoing session to finish. Otherwise there's the built-in 'recap' summary at the end of each chat, but **for whatever reason I rarely read them**.」 | Ask HN: What are you working on?（2026-08），HN 49245269 |
| 7 | 「**surfacing/managing session state is only part of the issue, context switching between them is another entirely and feels like the real productivity bottleneck for me**」 | HN 49112018 |
| 8 | 「The only real advantage is that **it makes the agent status glanceable in the sidebar**, which can be nice if you don't want to cycle through your tmux panes to check if something's blocked or complete.」 | herdr 用户，HN 49109494 |
| 9 | 「My main reason for herdr over tmux is **the priority queue of agents requiring intervention**.」 | HN 49109586 |
| 10 | 「Claude Code runs in the terminal. When you step away from your computer, **the session keeps working but you lose visibility and control**.」 | CCBot 作者，HN 46923707 |

第 5 条是本次调研里信息量最大的一句：**用户要的不是「状态」，是「我离开时它在做什么」**——
一个「上一条命令／最后一句话」的预览，比任何状态机都直接命中。

第 10 条和第 5 条合起来，正好是「回顾模式」的定义：**离开 → 回来 → 快速恢复上下文**。

### 1.2 竞品主屏：第一行是什么、按什么排

| 工具 | 第一屏顶部是什么 | 排序依据 | 每行内容 | 空状态 |
|---|---|---|---|---|
| **`claude agents`**（官方） | 一行计数 **`N awaiting input`**；分组顺序 `Pinned` → `Ready for review` → `Needs input` → `Working` → `Completed` | 需要你的排在最前；`Ctrl+T` 固定、`Shift+↑↓` 手动排；`Ctrl+S` 切成按目录分组 | 状态字形 + 名字 + **一句 Haiku 生成摘要**（「在做什么 / 在等什么 / 产出了什么」）+ 年龄 + `#PR号`（按 PR 状态着色） | 「空的分组标题 + 每个标题下的一句说明 + 输入框上一行解释」，鼓励你派发第一个任务 |
| **agent-deck** | 「全部会话一屏：running / waiting / done」；tmux 状态栏 `⚡ [1] frontend [2] api [3] backend` | 默认 **`sort = "waiting"`（最近开始等的排 [1]）**，可选 `last_accessed`（「像 Alt+Tab」） | `●` running / `◐` waiting / `○` idle / `✕` error + 名字 + 分组 + 成本行 | 首次运行是 Welcome（检测已装哪些 CLI、是否登录） |
| **agent-manager** | 项目树 + 每行右侧 `state · tool · age`；`w` 一键**只显示需要注意的**（waiting / finished / errored） | 分组内可手动拖拽排序；`w` 过滤 | 名字 + 你上一条消息（`❯`）+ **agent 最后一条消息**（`↳`）；working 且还没说话时显示 loader | 首次运行是 4 步 setup + 一段 tour |
| **herdr** | 侧栏「每个 pane 标 working / blocked / idle」 | 「priority queue of agents requiring intervention」 | 状态 + 名字 | — |
| **paseo** | 侧栏分组含 **`Needs review`**；issue #9155 要求「看一眼不算已处理，要手动消除」 | 分组 + 项目排序（issue #9187 要求按 workspace sort） | workspace + agent 状态 + 通知 | — |
| **atria** | 「discover agents，显示实时状态，一个地方发 prompt」 | `s` 循环切换排序列 | 状态（读 pane 底部）+ 名字 | 空时 `S` 执行 setup |
| **我们（现状）** | `OmniSight · 会话列表 · 最近 3 天 · liveness stale=17 reconstructed=12` | `STATE_ORDER` 后 `idle` 降序 | 状态 + 项目路径 + `calls=` + `nov=` + `idle=` + `reason` | 有会话时永不为空；`counts \|\| '无异常'` 只在零状态时出现 |

**共同点（这是可复用的结论）**：**在六个竞品里能读到主屏字段描述的那几个，没有任何一个
把「调用次数」或「新颖度」放进去**（`novelty` 在六份 README 里出现 0 次）。
它们放的是：谁需要你 → 它在说什么 → 它多久没动静 → 它产出了什么（PR/diff）。
我们的三列 `calls / novelty / reason` 在竞品里**一个都没有对应物**。
（`paseo` 的 README 不描述行内容，只有侧栏分组——**这一条对它是未核实**。）

**另一个共同点**：六个竞品里**至少四个**提供「**不 attach 就能回复**」——
`claude agents` 的 `Space` peek+reply、agent-deck 的 `o`（README：「Send a message to the
selected session (a busy Claude session queues it, no interrupt)」）、agent-manager 的 `space`
（「type, enter, and the prompt lands in that agent's pane」）、atria 的 `Ctrl+R` quick response
（需先开 agent screen stream）。herdr / paseo 的 README 里没有对应键位描述，**未确认**。详见 §五。

### 1.3 反证：这个需求不是普适的

不能只挑支持自己的证据。同一批讨论里明确有反面声音：

> 「I use coding agent but still don't see the need to manage a swarm of them like this.
> **Is there an actual use case for this or this is just for tokenmaxxing?**」——HN 49111645

> 「In my experience thus far, surfacing/managing session state is only part of the issue,
> context switching between them is another entirely and feels like the real productivity
> bottleneck for me」——HN 49112018（同一句既是需求确认，也是需求边界的否定）

> 「**Most of the AI tools people are building have little to zero value.** … I'm getting really
> tired of everyone doing their own special rain dances and then acting like they made it rain.」
> ——HN 49112708

> 「Everybody has a TUI for running Claude Code these days, huh?」——HN 49109763

**对本次调研的意义**：**「多会话」本身不是需求，「多会话里有一个卡住了而我漏掉了」才是。**
界面如果只是把所有会话列全，就落进了 49111645 嘲讽的那一类。

### 1.4 诚实缺口

- **没有找到任何 survey 或带样本量的统计**（「多少人同时开几个会话」）。HN 搜索、GitHub 搜索均无。
  本文所有「用户在几个会话」的数字都来自帖子作者自述（5–7、8、5–10、3–4、12），**不能当成分布**。
- **没有找到「agent 监控面板做失败」的复盘**（与 `2026-11-04-competitive-landscape.md` 的缺口一致）。
- Reddit 抓不到（403），所以「Reddit 上有没有更具体的抱怨」**未知**。
- 竞品排序只能从文档描述推断；除 agent-manager 与 paseo 外没看到实际截图。

---

## 二、用我们自己的数据反推字段价值

### 2.1 实测分布（`node scripts/scan-sessions.mjs --days 3 --json`，n=29 历史 + 12 live）

| 字段 | 实测分布 | 能不能支撑一个决定 |
|---|---|---|
| `state` | PRODUCING 13 / EXPLORING 16（`--json` 的 29 条历史；`--plain` 因并入 live 行显示为 12/17），其余 0 | **不能**。只有 2 个值出现，且都对应「不干预」 |
| `reason` | 只有 2 个值：`dormant` 16 / `persistent-change-in-window` 13 | **不能**。等价于 state，纯冗余 |
| `calls` | p10/p50/p90 = 157 / 1733 / 3906；max 5147 | **不能**。与 `subagents` 相关 **0.976**（= transcript 长度代理），与 idle 小时相关 **-0.15** |
| `novelty` | **17/29 恰为 1.00**；min 0.707，p10 0.91 | **不能**。0.2 的判据阈值永不触发；0.94 与 0.98 没有行为差别 |
| `idleSec` | <1h 13 / 1-6h 2 / 6-24h 5 / 1-3d 1 / 3-7d 1 / **>7d 8** | **能**，但只在两个用途：<15 min（还在动）与「≥1 天且不是 blocked」（归档候选） |
| `needs` / `suggestedReply` | **0/29**（全部 null） | 应该是**最高价值**，但链路断了（见 §2.2） |
| `tokens` | **0/29**（全部 null） | 有价值（成本），但链路断了 |
| `hostState` | 12/29 有值（全为 busy/idle） | 能，但两处宿主源会打架（见 §2.3） |
| `liveness` | stale 17 / reconstructed 12 | **不能**。这是「我们读得准不准」，不是「用户要做什么」 |
| `hbThresholdSec` / `lastGapSec` | 两列数 | **不能**。是实现细节，只对排查判定器有用 |
| `badLines` / `maxDepth` / `subagentsTotal` | — | 不能（诊断用） |

**成本字段其实存在，只是没接**：`~/.claude/jobs/<id>/state.json` 里有
`tokens: 3475667`（那个 blocked 的 Hilltop Village 优化）、`suggestedReply: "把实测单发给我"`、
`needs: "要我现在就把用户实测单交给你，还是你先看这四份测试报告？"`。
这些都在宿主文件里躺着，`scan-sessions` 也读了 jobs，**但只为「已有 transcript 行」的会话附加**。

### 2.2 最硬的一条：主屏漏掉唯一的两个待办（可复现）

复现（只读）：
```bash
claude agents --json --all        # 22 条，其中 state=blocked 2 条
node scripts/scan-sessions.mjs --days 3 --json | node -e "..."   # 29 条，state=BLOCKED 0 条
node scripts/oversight-tui.mjs --days 3 --plain                  # 汇总：PRODUCING=12 EXPLORING=17
```

两条 blocked 的明细：

| sessionId 前缀 | name | state | needs | tokens | updatedAt |
|---|---|---|---|---|---|
| `7710fbdb` | Hilltop Village优化 | blocked | 「要我现在就把用户实测单交给你，还是你先看这四份测试报告？」 | 3,475,667 | 2026-10-08（**32 天前**） |
| `a9fa4c62` | Hilltop Village | blocked | 「API unavailable — retry · API Error: 503 No available channel for model…」 | 1,330,604 | 2026-11-01（**8 天前**） |

**它们为什么消失**（`scripts/scan-sessions.mjs` 的行源）：

1. 行来自 `readdirSync(projects/<proj>)` 里的 `*.jsonl`，且**只看 mtime 在 `--days` 窗口内的**。
   - `7710fbdb`：**全盘没有它的 jsonl**（`Get-ChildItem -Recurse -Filter '7710fbdb*'` 返回空，
     `state.json` 的 `linkScanPath` 指向的文件 `existsSync === false`）。所以任何 `--days` 都扫不到它。
   - `a9fa4c62`：它的 `state.json` 里 `resumeSessionId: af6779f8-…`，那个 transcript **存在**，
     但 mtime 是 7.9 天前——**`--days 3` 把它挡住**。实测 `--days 9 --json` 里它出现了，
     **但行的 `sessionId` 是 `af6779f8`（transcript 文件名），不是宿主报的 `a9fa4c62`**，
     字段是全的：`state: BLOCKED, hostState: blocked, tokens: 1330604,
     needs: "API unavailable — retry · API Error: …"`。
     **也就是说管线能算对，唯一的门槛是「这条会话在不在行集合里」，而它由 transcript
     的 mtime 与 `--days` 决定，默认 3 天。** 而且即便 `--days 40`，`sessionId` 仍是
     `af6779f8`——**宿主 id 与 transcript id 不是一回事，按 sessionId 去重会漏。**
   - `7710fbdb` 则**在 40 天窗口里也不出现**（实测 `--days 40` 的 153 条里没有它）。
2. `jobs/state.json` 只被用作 `jobBySession` 的**查表补充**（`scan-sessions.mjs:604-646`），
   不会新增行。
3. TUI 的 `mergeLiveSessions` 只从 `~/.claude/sessions/*.json` 补 `WAITING/BLOCKED/FAILED`
   （`oversight-tui.mjs:641-707`），而后台任务**不写**那个目录（实测 `sessions/*.json` 里
   `blocked` 0 条、`waiting` 0 条）。

**结论**：`BLOCKED` 这条判据在设计上是「宿主事实」，在实现上却是「transcript 的附属品」。
**最能驱动动作的字段，可靠地漏掉了最该被看见的会话。** 这比字段排序严重一个数量级。

**但「补上」不等于「全部置顶」。** 这两条正好演示了另一种失效：`7710fbdb` 已经等了
**32 天**（用户在 10 月 8 日之后显然没回来处理它），`a9fa4c62` 等了 8 天且 `needs` 是一条
API 503 报错而不是问题——**它不是「在等你」，是「早就死了但没人清理」**。
所以「需要你」这一栏必须带**时效衰减**：超过 N 天（建议 3–7 天）的 blocked 归入
「僵尸：结束它还是继续？」而不是继续占据待办首位。这与 §4.3 的「已读／静音」是同一件事的两端。

### 2.3 附带发现：两个宿主源会互相打架

同时抓 `~/.claude/sessions/*.json` 和 `claude agents --json` 对比同一 pid：

| pid | 名字 | sessions.json | claude agents --json | 备注 |
|---|---|---|---|---|
| 11772 | Let's learn English! | `idle` | `busy` | `statusUpdatedAt` 已 300 分钟未变 |
| 24112 | web-style-atlas | `idle` | `busy` | 已 339 分钟未变 |

`statusUpdatedAt` 的年龄达到 5 小时而状态仍是「busy」——说明 `sessions/*.json` 的
`status` 是**粘滞**的，不能当实时信号用。官方文档明说「Read session state from a script」
要用 `claude agents --json`，并且 `~/.claude/jobs/*/state.json` 的值「会在下一次更新时被替换」，
不是稳定接口。**我们的主屏应当以 `claude agents --json` 为准，jobs 只取 `needs`/`suggestedReply`/`tokens`。**

### 2.4 字段价值排序（按「它能不能支撑一个决定」）

#### 第一层：进主屏（缺一个用户就会漏事）

| 字段 | 为什么 | 依据 |
|---|---|---|
| `需要你`（blocked / waiting / failed，来自宿主，不来自推断） | 唯一能驱动动作的判据 | 竞品六个工具全部置顶；`state-model.md` §2 自述「真正有行动价值的只有宿主上报的那两条」 |
| `它在等什么`（`needs` 原文，截到一行） | 「needs you」是筛子，但用户要知道是**什么**事才决定先处理哪个 | Agent-Manager 每行右侧就是「agent 最后一条消息」；`claude agents` 的 peek 首行就是「the exact question it's asking」 |
| `会话名 + 项目`（不是路径） | `claude agents --json` 的 22 条里 21 条有非空名字且两两不同（1 条名字为空）；而路径去重后 30 行只有 15 个不同标签，`Server/MCServers/Server…` 出现 **12 次**——路径在主屏上不具区分度，名字有 | 实测两处数据对比 |
| `等了多久`（从进入等待算起，不是 lastActivity） | 8 天 vs 8 分钟是完全不同的处置 | `claude agents` 行尾年龄；agent-deck `sort=waiting` |
| `最后说了什么`（一句） | 回顾模式下唯一的上下文恢复手段 | Beam 评论（§1.1 #5）；`claude agents` 的 Haiku 行摘要；agent-manager 的 `↳` |

#### 第二层：一次按键可达（详情页/peek）

PR/CI 状态、tokens/成本、diff（它改了什么）、subagent 树、worktree 分支、
`waitingFor` 细分（`input needed` 精确率 100% / `permission prompt` 精确率 0%，
见 `state-model.md` §2.0.3——**这个区分决定要不要通知**，但不需要在主屏）。

#### 第三层：从主屏砍掉

| 字段 | 砍的理由（数字化） |
|---|---|
| `calls` | 与 subagents 相关 0.976，与 idle 相关 -0.15；p10–p90 覆盖 157–3906，没有阈值可用 |
| `novelty` / `noveltyAll` | 17/29 恰为 1.00；判据阈值 0.2 永不触发；竞品零对应物 |
| `reason`（`dormant` / `persistent-change-in-window`） | 与 state 一对一同构，纯冗余；且是英文内部枚举，用户读不懂 |
| `liveness`（`stale` / `reconstructed`） | 描述「我们读得准不准」，不是「你要做什么」 |
| `hbThresholdSec` / `lastGapSec` / `badLines` / `maxDepth` / `subagentsTotal` | 排查判定器用，属详情页或日志 |

**一行账**：`calls=11 + novelty=8 + idle=11` 固定占 30 列；去掉 `calls`/`novelty` 后
省下 19 列，足以把 `reason` 换成 `needs` 的一句话——而 `needs` 现在是**空的**（0/29），
原因见 §2.2，不是字段没价值。

### 2.5 `idle` 的哪个区间是用户关心的

实测 29 条的 idle 分桶：

| 区间 | 条数 | 用户会做什么 |
|---|---|---|
| < 5 min | 12 | 不动作（正在干活） |
| 5 min – 1 h | 1 | 可能想确认是不是在等权限（真正需要的是 `waitingFor`，不是时长） |
| 1 – 24 h | 7 | **几乎不动作**。文档自己写「EXPLORING 严禁重跑」 |
| > 24 h | 9（其中 > 7 天 8 条） | 归档/清理候选，不是「监控」对象 |

**结论：`idle` 只需两种呈现**——`还在动（<15 min）` 和 `很久没动（≥1 天）`；
中间那 1h–24h 的 7 条占据了屏幕却不对应任何动作。这与 `README.md`
「其余状态是描述，不是判据」是同一件事的另一个说法。

---

## 三、场景判断：监控 / 回顾 / 响应

| 场景 | 证据 | 是否主场景 |
|---|---|---|
| **持续监控**（每几分钟看一次） | 反面证据更强：HN 49113621「If you're truly multi-tasking with this type of setup it feels more like 'tiktok coding', 'brainrot coding'」；49112018 说状态可见性只是问题的一半；本机实测 8 秒轮询实际周期 ≥24 s（扫描 16–21 s + 8 s 间隔），**物理上做不到** | **否** |
| **回顾**（离开几小时回来看） | Beam 评论「remembering what each one was doing **when I come back hours later**」；Ask HN「end-of-chat recap… **I rarely read them**」（说明用户想要轻量的、入口处的摘要，不是长 recap）；CCBot「step away… lose visibility」；Widgetful 整页叙事就是「23:40 合盖 → 04:30 最后一个会话结束」 | **是，第一主场景** |
| **响应**（收到通知后去确认） | 通知链路已被独立解决：青蛙叫声、Pushover hook、vibe-notch（2.5k★）、agent-deck 通知栏、Widgetful「Waits for you」；`claude agents` 在会话开始等输入/完成/失败时发 `Notification` 钩子 | **是，第二主场景**，但**入口在通知，不在 TUI** |

**判断**：TUI 的主场景是 **回顾 + 响应**，不是监控。这有三个直接后果：

1. **首屏必须是「我不在的时候发生了什么」**，不是「现在每一行是什么状态」。
2. **刷新间隔不重要，进入时的第一帧很重要。** 24 s 的周期对监控是缺陷，对回顾是无害的——
   只要首屏在扫描完成前就给出可读的东西。现在首帧是「首次扫描进行中… 已等待 Ns」的等待页
   （`oversight-tui.mjs:456-475` 自己记的实测是 33 个会话 26 s，本次实测 `--days 3` 16–21 s），
   这段时间屏幕上是**没有结论的**。
3. **「处理完标记为已知」是必需能力。** paseo #9155 正是因为「看一眼就被当成已处理」
   而提了 feature request；agent-manager 用 `.` 手动标记 idle。
   **没有「已读」状态，回顾模式下的列表会越看越长，最后没人看。**

补充一条时间尺度的证据：`claude agents` 的行年龄「counted from when the session was created」，
而 finished session 的年龄「freezes at how long the run took」——**官方把它当「时长」而不是「时刻」用**，
这正是回顾视角。

---

## 四、空状态设计

### 4.1 判断标准

空状态要同时回答三件事，少一件用户就会怀疑是不是坏了：

1. **结论**：现在有没有事（一行）；
2. **可信度**：你什么时候看的（时间戳 / 覆盖面）；
3. **下一步**：我还能做什么（一个动作）。

### 4.2 五个真实例子

**① GitHub Status**（`githubstatus.com`，抓到的 HTML）
```html
<div class="page-status status-none">
  <h2 class="status font-large">All Systems Operational</h2>
  <span class="last-updated-stamp font-small"></span>
</div>
```
一行结论 + 一个「最后更新」时间戳；其余是订阅表单。**没有列表**。

**② healthchecks.io**（`healthchecks.io/docs`）
> 「It keeps silent **as long as pings arrive on time**. It raises an alert as soon as a ping
> does not arrive on time.」
> 状态枚举：`New` / `Up`（「All is well」）/ `Late` / `Down`。
「安静 = 健康」被写进了产品定义。**没有异常时它什么都不说**，异常时只说「没按时到」，
不说「为什么」（cause 让用户自己查）。

**③ Google SRE**（`sre.google/sre-book`）
> 「Every time the pager goes off, I should be able to react with a sense of urgency.
> I can only react with a sense of urgency a few times a day before I become fatigued.
> **Every page should be actionable.** Every page response should require intelligence.
> If a page merely merits a robotic response, it shouldn't be a page.
> Pages should be about a **novel problem** or an event that hasn't been seen before.」
> 「it's better to spend much more effort on catching **symptoms** than causes」
这是「空状态」的理论依据：**分页器静默是正确行为，不是缺陷**。

**④ `git status`**（本机实测）
```
On branch master
nothing to commit, working tree clean
```
一行结论（`working tree clean`）+ 一个定位（`On branch master`）。

**⑤ `claude agents` 空状态**（官方文档）
> 「Before you dispatch your first session, agent view shows the empty section headers with a
> description under each, plus a one-line explanation above the input, in place of the session
> list. Type a prompt in the input at the bottom and press `Enter` to dispatch your first session.」
空的**分组标题保留**（让用户知道将来会长什么样）+ 一句解释 + 一个动作（输入框）。

**反例（本机实测，2026-11-10）**：
- `gh pr list`（本仓库，有 remote、没有 PR）→ **零输出**，exit 0。
  在无 remote 的临时仓库里同样没有列表，但会打一行 `no git remotes found`、exit 1——
  也就是说**「空」与「出错」在零输出时无法区分**，靠的是退出码，不是屏幕。
- `npm outdated`（依赖全部最新）→ **零输出**，exit 0。
用户无法区分「没事」和「命令没跑起来」。**这正好是我们 TUI 首帧的风险**：现在的首帧是
「首次扫描进行中… 已等待 Ns」，实测 16–21 s 里屏幕上没有任何状态结论。

### 4.3 对我们的具体建议

**A. 「没事」时只输出一行，且带时间戳与覆盖范围。**

```
✓ 没有需要你处理的会话（22 个会话：12 个交互 · 10 个后台；后台里 0 个在等、7 个 stopped、1 个 done；核查于 14:32，覆盖 18 个项目）
```

要点：`✓` 是结论；`22 个会话：12 个交互 · 10 个后台…0 个在等` 是覆盖范围（`claude agents --json`
的权威口径，实测 10 个 background = 2 blocked + 7 stopped + 1 done，12 个 interactive = 10 busy + 2 idle）；
`核查于 14:32` 是可信度；不列会话。

**B. 「有事」时，也只列有事的那几条，其余折叠成一行。**

```
! 1 个在等你（今天）
  <会话名>              等 6 分钟   「要我把测试改成 mock 还是连真库？」              [Space 回复]

· 2 个僵尸（>7 天没动，宿主仍标 blocked）
  Hilltop Village优化   等 32 天    要我现在就把用户实测单交给你，还是你先看这四份测试报告？   [x 结束 / p 置顶]
  Hilltop Village       等 8 天     API 503，重试或换模型                            [Enter 打开]

其余 19 个：10 个正在跑 · 2 个 idle · 7 个已停止                              [Tab 展开]
```

要点：**「在等你」和「早就死了」必须分开**。上面的实测数据里，两条 blocked 全部属于后者
（32 天 / 8 天，其中一条的 `needs` 是 503 报错而不是问句）。把僵尸混进待办，
就是在制造罚款单式的疲劳——Google SRE 那句「Pages should be about a **novel problem**」
说的正是这个。

这直接对应 GitHub Status 的「一行 + 时间戳」和 Google SRE 的「只 page 症状」。

**C. 加一个「已读／静音」动作，否则回顾模式会烂掉。**
`paseo #9155` 的原文：「I often glance at a result and want to come back to it later.
As it stands, **glancing at it counts as dismissing it**.」——他们的解法是「手动消除 + 显式
Mark reviewed」。agent-manager 用 `.`（「Mark a finished or waiting session idle without
entering it」）。**我们要的是同一样东西**：不进会话也能把一条标记为「我看过了」。

**D. 首帧就要有结论，不能让用户等 26 s 看空白。**
`claude agents --json` 在这台机器上 7–11 s 就够（22 条），`scan-sessions --days 3` 要 16–21 s。
**先画 `claude agents --json` 的结果（谁在等你），再在后台上齐 transcript 派生的字段。**
这也是官方文档给脚本用户的建议路径。

---

## 五、给 TUI 的具体结论（只给判断，不改代码）

1. **行源要改**：以 `claude agents --json --all` 为**行的全集**，`scan-sessions` 只作为
   「这一行有没有 transcript / 有没有改动」的**补充**。现在的方向是反的，导致 §2.2 的漏报。
2. **主屏列**：`需要你? / 名字 / 它在等什么（一句）/ 等了多久 / 最后一次动作`。
   `calls`、`novelty`、`reason`、`liveness` 全部移到详情页。
3. **排序**：`需要你（按等待时长降序）` → `在跑（<15 min 有动作）` → `其余折叠成一行`。
   不要按 `STATE_ORDER` 排，因为 5 个状态里只有 2 个会出现。
4. **空状态**：见 §4.3 A/B/C；一行结论 + 时间戳 + 覆盖范围 + 一个动作。
5. **「不 attach 也能回复」优先于「再加一个字段」。**
   六个竞品里至少四个做了这件事（`claude agents` 的 `Space`、agent-deck 的 `o`、
   agent-manager 的 `space`、atria 的 `Ctrl+R`）。agent-manager 作者自述他放弃 agent-deck 的
   原因就是「what I kept missing was **answering an agent without attaching to it**」
   （HN 49111394，作者 `yoanwaidev`；与 §1.1 引的第 3 条同一人——**这两条不是两份独立证据**）。
   这比再多显示一个指标更接近用户说的「the real productivity bottleneck」。

---

## 来源

**Hacker News（Algolia API，`https://hn.algolia.com/api/v1/items/<id>`，抓取于 2026-11-09/10）**
- 49107749 · Agent-Manager: A Tmux TUI for Running Claude Code, Codex and OpenCode（98 分 / 80 评论）
- 47602986 · Show HN: Real-time dashboard for Claude Code agent teams（77 分）
- 47765556 · Show HN: Claude Control – macOS dashboard for managing Claude Code sessions
- 47310039 · Show HN: Amux – single-file agent multiplexer for headless Claude Code sessions
- 47287559 · Show HN: iTerm2 tab status for Claude Code sessions
- 46913565 · Show HN: Beam – Terminal Organizer for macOS
- 46923707 · Show HN: CCBot – Control Claude Code from Telegram via tmux
- 49245269 · Ask HN: What are you working on?（2026-08）
- 50418008 · Ask HN: What are you working on?（2026-11，Widgetful）
- 49111394 / 49109494 / 49109586 / 49109559 / 49112018 / 49111645 / 49111771 / 49112708 / 49109763 · 同帖评论

**官方文档**
- Claude Code · Agent view：`https://code.claude.com/docs/en/agent-view.md`（分组、行摘要、空状态、`--json` 字段、supervisor、`~/.claude/jobs` 非稳定接口）

**GitHub（`gh api`，2026-11-10）**
- `asheshgoplani/agent-deck` README（状态表、`sort = "waiting"`、通知栏、`$` 成本面板）
- `YoanWai/agent-manager` README + `docs/usage.md`（行格式、`w` 过滤、`space`、`.` 标记 idle）
- `getpaseo/paseo` README + issues #9155 / #9166 / #9193
- `sethdeckard/atria` README（`Ctrl+R` quick response、`s` 排序）
- `herdrdev/herdr` README（blocked 优先队列）
- `Yeachan-Heo/oh-my-claudecode` README（HUD、`omc wait`）
- 星数（2026-11-10）：herdr 49,699 · agent-manager 667 · atria 20 · muster 2

**空状态**
- `https://www.githubstatus.com/`（`All Systems Operational` + last-updated 的 HTML 片段）
- `https://healthchecks.io/docs/`（「keeps silent as long as pings arrive on time」）
- `https://sre.google/sre-book/monitoring-distributed-systems/`（「Every page should be actionable」）

**本机实测（只读）**
- `node scripts/scan-sessions.mjs --days 3 --json`（n=29，16–21 s）
- `node scripts/oversight-tui.mjs --days 3 --plain`（汇总 PRODUCING=12 EXPLORING=17，无 BLOCKED 行）
- `claude agents --json --all`（22 条，blocked 2；7–11 s）
- `node scripts/verify-claims.mjs --days 3`（17 条断言：8 SUPPORTED / 5 STALE_ONLY / 1 FAILED_ONLY / 1 NO_EVIDENCE / 2 UNKNOWN）
- `~/.claude/jobs/{7710fbdb,a9fa4c62}/state.json`、`~/.claude/sessions/*.json`
