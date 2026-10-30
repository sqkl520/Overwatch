# Overwatch 使用手册

面向使用者：你会看到什么、该做什么。规格细节在 `docs/spec/`，设计理由在 `docs/adr/`。

## 1. 这是什么

**本库不能自动接力。** 目标会话运行时，宿主的 `--resume` 注入会落到副本上，窗口里看不到任何东西；跨会话通道又强制标注来源。草稿只能你复制发送。

它扫描本机所有 Claude Code 会话的 transcript，重建真实状态，并为卡住的会话准备接力草稿。

## 2. 五分钟上手

Node ≥ 18，零 npm 依赖，`package.json` 不存在。不需要安装、登录或配置。

### 命令 1：看一眼所有会话

```bash
node scripts/scan-sessions.mjs --days 3
```

真实输出（本机 2026-10-30，节选）：

```
OmniSight 会话扫描 · 最近 3 天 · 19 个有活动的会话
liveness: reconstructed（事后重建，非实时上报）

宿主注册的活跃会话 8 个：
  idle  Let's learn English!               可投递(带来源标注)

[PRODUCING] Projects/Overwatch         calls=  988 sub=     13 depth=1 novelty=0.97 hb=0s/120s     idle=5s    persistent-change-in-window
[EXPLORING] Projects/dsh/fcl/android   calls= 5840 sub=100/272~ depth=1 novelty=1.00 hb=0s/120s     idle=67.5h dormant

汇总：EXPLORING=16  PRODUCING=3
```

**什么时候用**：想知道「现在有几个会话在动、有没有卡住的」。`--days 3` 全量一次约 13 秒。退出码：有 `FAILED` 返回 1，正常 0，找不到 transcript 根目录 2。脚本化调用时别把 1 当崩溃。

### 命令 2：打开面板

```bash
node scripts/oversight-tui.mjs
```

真实输出（同上，非 TTY 快照）：

```
OmniSight · 会话列表 · 最近 3 天 · liveness stale=16 reconstructed=3
纯文本快照（交互界面需在终端运行）
  状态        项目                     calls       novelty  idle        reason
  ● PRODUCING Projects/dsh/fcl/androi… calls= 1415 nov=0.80 idle=50s    persistent-change-in-window
  ○ EXPLORING Server/MCServers/Server… calls=  201 nov=1.00 idle=45.7d  dormant

汇总：PRODUCING=3 EXPLORING=16
```

**什么时候用**：想持续盯着、按 Enter 看细节、按 `c` 复制接力草稿。默认每 8 秒重扫，`r` 立即刷新。

### 命令 3：结构硬门

```bash
node scripts/check-structure.mjs
```

真实输出：

```
check-structure · 仓库结构硬门

✓ 结构检查全部通过
```

**什么时候用**：只在你要改这个仓库时。它检查：可发布区有没有本机绝对路径、`.gitignore` 是否误伤产品本体、agent frontmatter 与只读角色白名单、空目录、脚本能否解析与 import、README 的能力边界声明。任何改动后都必须跑。

## 3. 读懂五态

**是五种，不是四种。** `BLOCKED` 是后加的：它不在判定链上，是宿主直接报告的事实（会话在等人输入），优先级高于一切推断。另外四种由 transcript 计算，**有序互斥**：从上往下比，命中即返回。

| 状态 | 大白话判据 | 你该做什么 |
|---|---|---|
| `BLOCKED` | 宿主说它在等输入：权限确认、API 报错、沙箱拦截 | 看 `needs`（在等什么）与 `suggestedReply`（建议怎么回），回一句 |
| `FAILED` | 宿主明确报过失败；或两次调用间隔超过该会话自己的 p95 阈值且之后 60 秒无新记录；或预算耗尽且零增益 | 这是**唯一允许全量重跑**的状态 |
| `EXPLORING` | 其余情况：只读工具在跑、novelty 达标、样本不足、或已休眠 | **不干预**，只做预算管理；**严禁重跑** |
| `STALLED` | 连续 3 个窗口 novelty < 0.2，且窗口内无持久化变更，且派生树没有任何节点有增益 | 先探针，再收窄，最后重新拆解，不要直接重跑 |
| `PRODUCING` | 最近 20 次调用里出现过持久化变更：成功的 `Write`/`Edit`，或 Bash 命中写入类命令（`git commit`、`npm install`、`mvn package`、写文件重定向） | 不干预，等验收 |

三个容易误会的点：

1. **只读不算没干活。** `ls`、`git status`、`grep`、`cat` 全是 Bash。如果「调用了 Bash 就算 PRODUCING」，只读探索会被当成有交付物，送验收、判不通过、重跑。所以判据是「有没有产生持久化变更」。
2. **`EXPLORING` 不等于活着。** 它包含休眠。看 `reason`：`dormant` 是结束了，`read-only` 才是真的在读东西。
3. **`STALLED` 不等于失败。** 它只是「连续 3 个窗口（每窗 20 次调用）都几乎没有新动作」，先探针再决定。

### 为什么空闲 3 天的会话是 `EXPLORING` 而不是 `FAILED`

判 `FAILED` 的条件之一是「末次调用间隔超过该会话自己的 p95 阈值」。空闲 3 天的会话末次间隔当然很大，按这条会判死。但它是**做完了**，不是**失败了**。

所以判定链里有一条休眠闸门：最后一次调用距今超过 1 小时，直接判 `EXPLORING` + `reason: dormant` + `liveness: stale`，不再往下比。它必须排在宿主报 `failed` 之后——宿主明确报过失败的会话，不该因为时间久被降级成「只是睡着了」。

真实例子（`--days 3`，本机）：`Projects/rea` 空闲 3.7 天，上一次两调用间隔 515 秒，阈值 120 秒。没有这条闸门，它会被判 `FAILED`，然后你会去「重跑」一个三天前就结束的会话。

## 4. 读懂输出

```
[PRODUCING] Projects/Overwatch   calls=  988 sub=     13 depth=1 novelty=0.97 hb=0s/120s   idle=5s   persistent-change-in-window
```

| 字段 | 含义 |
|---|---|
| `[PRODUCING]` | 五态之一，宽度固定，方便竖着扫 |
| 项目名 | 目录名还原（`D--Projects-Overwatch` → `Projects/Overwatch`），超 24 列截断 |
| `calls` | 扫到的工具调用总数，含子 agent。为控制耗时，每个文件只读末尾 4 MB；主 transcript 取末尾 1200 条记录，每个子 agent 取末尾 400 条 |
| `sub` | 子 agent 数量，`100/272~` 见下 |
| `depth` | 派生树最大层深 |
| `novelty` | 轨迹新颖度 0–1：最近 20 次调用里「没见过的调用」的加权占比。1.00 = 全是新动作；连续三窗低于 0.20 判 `STALLED`。不足一窗为 `null` |
| `hb` | 末次调用间隔 / 该会话的自适应阈值（秒）。`n/a` = 间隔样本不足 20 个 |
| `idle` | 距最后一次调用多久：`35s` / `2m` / `13.6h` / `45.7d` |
| `reason` | 判定理由，合法值仅 `host-reported-blocked`、`host-reported-failed`、`dormant`、`hb_gap=…`、`novelty=…`、`persistent-change-in-window`、`read-only`、`cold-start` |
| `tok=3476k` | 真实 token 用量，见下 |
| `BAD=n` | 有 n 行 transcript 解析失败。少量不影响判定；持续增长说明记录在损坏 |

### `100/272~` 是什么意思

读作：**总共发现 272 个子 agent transcript，本次只展开了最近的 100 个，`~` 表示被截断。** 上限按实测定的：12 个最坏会话上，cap=30 覆盖 23.7%、耗时 11.6s；cap=100 覆盖 72.8%、19.4s；cap=200 覆盖 92.7%、24.7s。本机 69 个有子 agent 的会话里 61 个在 100 以内，所以取 100 只让少数巨无霸变慢。

代价是 `depth` 与树活性建立在采样的树上——所以显式标出来，而不是假装 100 就是全部。**但判定不受影响**：四态只需要「任一节点有增益 → 整棵树 EXPLORING」，采样已足够发现增益；覆盖率低损害的是详情页画不全。没截断时只显示一个数字，如 `sub=13`。

### `liveness stale=17 reconstructed=2` 怎么读

顶栏这一行是**当前这批会话的 liveness 分布**，不是全局状态。`stale` = 最后一次调用距今超过 1 小时、心跳不反映当前（几乎都是休眠会话）；`reconstructed` = 心跳从事后 transcript 重建、间隔样本够 20 个；`insufficient-sample` = 样本 < 20、算不出阈值，因此**永远不会**被判 `FAILED`。数字来自当前数据，不是写死的：实测同一天不同时刻跑，出现过 `stale=16 reconstructed=3` 与 `stale=15 reconstructed=4`。

### `tok=3476k` 从哪来，为什么有的会话没有

来自宿主 `~/.claude/jobs/<job-id>/state.json` 的 `tokens` 字段，是**真实用量**（除以 1000 取整），只有能关联到后台作业（`linkScanPath` 含 sessionId）的会话才有。**前台交互会话没有**：宿主不落盘它们的 token 计数，中途也查不到。本库不会编一个估算值贴上去——规格明确禁止「外观像遥测、实际编出来的数字」。

## 5. 用 TUI

```bash
node scripts/oversight-tui.mjs                 # 最近 3 天，8 秒轮询
node scripts/oversight-tui.mjs --days 1 --interval 15 --plain
```

**列表页**：`j`/`↓` 下一行，`k`/`↑` 上一行，`g`/`Home` 首行，`G`/`End` 末行（帮助面板未列出但可用），`Enter` 详情，`c` 复制接力草稿，`r` 立即刷新，`?` 帮助，`q` 退出。**详情页**：`j`/`k` 滚动 1 行，`PgDn`/`PgUp` 滚动 10 行，`Esc` 返回列表（滚动归零），`c` 复制，`r` 刷新，`?` 帮助，`q` 退出。**帮助 / 草稿面板**：`q` 退出程序，其他任意键关闭面板回原页面。任何页面 `Ctrl-C` 都退出。

### 详情页能看什么

真实输出（某 `BLOCKED` 会话，80 列。实际还多 `目录`、`lastActivity` 两行，派生树部分有 30 行 `◇ 子 agent #n`，这里省略）：

```
  项目         Server/MCServers/Server/plugin/Hilltop/Village
  sessionId    7710fbdb-06a6-44c1-8925-c76a25a39edb
  state        ? BLOCKED
  reason       host-reported-blocked
  liveness     reconstructed
  hostState    blocked
  jobDetail    3 tasks done (reports moved, 2 MINORs fixed, committed d08ef3b)
  calls        2038
  novelty      1.00
  noveltyAll   0.91
  idle         22.0d
  心跳         末次 38s / 阈值 211s
  tokens       3475667

派生树 · 层深 1 · 子 agent 100/128（已截断）
  │ ◇ 子 agent #1
  │ ◇ 子 agent #2
  │ ◇ 子 agent #3
```

其后 #4–#30 共 27 行同样格式，再接 `│ … 另 1 个未展开 · 完整比例 30/31`，然后是「等待输入」与「建议回复」两段（内容见 §6 的 before 例子）。

- `novelty` 是最近一窗，`noveltyAll` 是全会话平均。差很多说明最近在重复。
- `◇` 表示该节点状态未由 `scan --json` 暴露，不是警告。
- 详情页只读：不判定、不算 novelty、不写文件，数字原样来自 `scan-sessions.mjs --json`。

### 复制接力草稿

选中会话（`BLOCKED` 最可能有草稿）→ 按 `c` → 看到 `已复制到剪贴板` → 切到目标会话粘贴、回车。复制出的内容分两段：

```
把实测单发给我

（目标会话正在等待：要我现在就把用户实测单交给你，还是你先看这四份测试报告？）
```

**`c` 只对宿主提供了 `needs` / `suggestedReply` 的会话有效**，即 `~/.claude/jobs/` 里有记录的 `BLOCKED` 会话。`STALLED` / `FAILED` 按 `c` 会提示「该会话没有 needs / suggestedReply，无草稿可复制」，那类要走 §6 的编队路径写草稿。

复制失败时弹出草稿面板（标题「复制失败，请手动选择」），用鼠标选中文本自己复制。Windows 上中文不会变问号：走 PowerShell + UTF-16LE，不是 `clip.exe`（后者在 GBK 代码页下会把中文变成 `?`）。

### 非 TTY 下自动降级

管道、重定向、CI、`--plain`：切换为一次性纯文本快照，打印完退出，不输出任何 ANSI 序列。

```bash
node scripts/oversight-tui.mjs | cat        # 纯文本
node scripts/oversight-tui.mjs > snap.txt   # 同上
NO_COLOR=1 node scripts/oversight-tui.mjs   # 仍交互，但无色
```

判断依据是 `stdout.isTTY`。颜色另有两条关闭条件：`NO_COLOR` 非空、`TERM=dumb`。关掉颜色信息量不减少——每个状态同时用字形、颜色、文字三通道编码，灰度下靠 `?` `×` `▲` `●` `○` 的形状区分。

## 6. 接力怎么做

### 为什么只能手动

宿主对**运行中**会话的注入会落到副本上（`claude --help` 原文：`or starts a copy and says so when the session is already running`）。你以为接上了，实际另一个副本在跑，此后监控的是分叉出来的新会话。跨会话消息通道虽然有，但契约要求投递标注来源，做不到「以你的口吻发一条」。

所以 `relay.deliver` 只有一个合法值：`manual`。本库不假装能自动投递。

### 完整流程

1. 扫描发现 `BLOCKED` / `STALLED`。
2. 看 `needs`：它在等什么。
3. 有 `suggestedReply` → TUI 按 `c` 复制；没有 → 派 `oversight-relay` 写草稿，再派 `oversight-safety` 过红线（`/oversight relay <session-id>`）。
4. 粘贴到目标会话，回车。
5. 下一轮扫描，该会话重新进入监控。

第 3 步两条路的区别：

| 情况 | 草稿从哪来 | 怎么拿 |
|---|---|---|
| 宿主报 `blocked`，`jobs/state.json` 带 `needs` / `suggestedReply` | 宿主已给半成品，TUI 拼装 | 按 `c` |
| `STALLED` / `FAILED`，或宿主只给 `needs` 没给建议 | Relay Agent 写，Safety Agent 审 | `/oversight relay <session-id>` |

草稿硬要求（`docs/spec/relay-protocol.md`）：不超过 5 行、不超过 1 个命令块、必须含「你停在 X」+「具体下一步」+「如果 A 不行就做 B，不用问我」三要素。不写「请继续」这类没有信息量的话。

### 宿主已经给了 `needs` 和 `suggestedReply`，这意味着什么

意味着这个会话**不是失败了，是在等你**。宿主停下时自己记录了「在等什么」和「建议怎么回」，扫描脚本原样透传。

三个实际影响：

1. 不用读 transcript 猜它在等什么，状态行下面直接印出来。
2. 草稿成本大幅下降：Relay Agent 是**补全宿主已有的半成品**，省一轮往返。
3. 但 `suggestedReply` 不一定对。它只解决「当前这个问句」，不解决「为什么会停在这里」。要改方向就自己改，别盲信。

### 一个真实的 before / after

**before**（`--days 30`，本机真实记录）：

```
[BLOCKED  ] d//Server/MCServers/Serv   calls= 2038 sub= 30/31~ depth=1 novelty=1.00 hb=38s/211s    idle=527.5h host-reported-blocked tok=3476k
            等待输入：要我现在就把用户实测单交给你，还是你先看这四份测试报告？
            建议回复：把实测单发给我
```

最后一条 AI 消息是一份完成汇报（「三件事都做完了喵」，列了四份测试报告路径），结尾抛了个二选一的问题，然后停住 22 天。它没坏，是在等人。

**你做的**：TUI 选中它，按 `c`，粘到那个会话，回车。或者直接手打「把实测单发给我」。

**after**：会话继续干。下一次扫描时 `state` 不再是 `BLOCKED`——要么 `PRODUCING`（开始写），要么 `EXPLORING`（开始读）。**系统不会自动确认你发没发**，`sent` 只有你自己能置。

反面例子，同一批数据里另一个 `BLOCKED`：

```
[BLOCKED  ] d//Server/MCServers/Serv   calls= 1340 ... host-reported-blocked tok=1331k
            等待输入：API unavailable — retry · API Error: 503 No available channel ...
```

它没有 `suggestedReply`，因为等的是 API 恢复，不是等你回话。按 `c` 只能复制到「（目标会话正在等待：API unavailable…）」。正确的动作是**检查推理网关**（`127.0.0.1:15721`）或换模型，然后自己发一句让它重试——不是催它。

## 7. 跑编队（进阶）

### `oversight` skill

```
/oversight new                    # 跑一轮完整流程
/oversight status                 # 看当前状态
/oversight relay <session-id>     # 给某个会话写接力草稿
/oversight demo                   # 最小演示：3 个 Agent 跑通全流程
```

流程：Phase A 规划 → B 并行派发 → C 冲突登记 → E 验收与修复 → F 接力（手动）。主线程只做拆解、派发、汇总，不亲自检索、分析、编码、写作。首次运行问 5 件事（监控范围、接力触发、口吻、禁止操作、ADHD 输出），不答就按默认执行并声明「按默认执行」。

### 12 个角色

| 角色 | 干什么 |
|---|---|
| `planner` | 拆任务树，预先声明验收标准、产出形态、预算 |
| `executor` | 按子树执行，产出交付物 |
| `research` | 查外部事实，标来源与可信度 |
| `critic` | 质疑拆解与前提，不管交付物好坏 |
| `redteam` | 攻击交付物：反例、边界、崩溃场景 |
| `review` | 质量评分 1–10，指出最致命的 3 个问题 |
| `acceptor` | 对照预声明标准逐项判定，一票否决 |
| `repair` | 按验收理由与锐评意见修复，仅失败时触发 |
| `probe` | 只读日志判 `HEALTHY_EXPLORING` / `UNFOCUSED` / `LOOPING` |
| `relay` | 写接力草稿 |
| `safety` | 检查草稿是否触碰红线 |
| `resolution` | 裁决分歧；判不了就说还需要什么证据 |

**`critic` / `redteam` / `review` / `acceptor` / `safety` / `probe` 的 `tools` 里没有 `Edit`**，这是工具白名单的物理限制，不是 prompt 里写「请不要改」。`check-structure.mjs` 会验证。三个不可合并的角色各有原因：锐评管「好不好」、验收管「过不过」，混了就是一个人的左右手；relay 与 safety 合并就是「自己写草稿、自己审红线」；critic 与 redteam 的输入不同，一个看拆解图，一个看交付物。

### 什么时候该用编队，什么时候不值得

值得：需要多个独立视角、有明确「过/不过」判定、错了代价高（发布、迁移、对外文档）。

不值得：

- 单一事实查询——派一个 research 就够，编队只是把一次搜索变成五次。
- 你 10 分钟能写完的东西——编队固定成本（拆解、派发、冲突登记、验收）比任务本身大。
- 没有可观测验收标准的任务（「让代码更优雅」）——acceptor 无法判定，只会退化成主观打分。
- `EXPLORING` 态的会话想「重跑一遍看看」——规格禁止，这正是死循环的入口。

### 验收标准为什么必须预先声明

因为事后编的标准一定**照着已有结果写**。交付物缺了某个能力，标准就自动不提那条；多做了一件没用的事，标准就把它写成加分项。验收 Agent 拿到的若是一份为当前结果量身定制的清单，它的「一票否决」就是橡皮图章。

做法：`planner` 在**派发执行 Agent 之前**写 `templates/acceptance-criteria.md`，每条必须有 `criterion`（可观测事实）、`evidence`（引用形式，如 `file:line`）、`fail_if`（什么情况直接否决）。没有 `fail_if` 的标准等于没有。

## 8. 常见问题

**Q：会话显示 `EXPLORING`，怎么判断它是不是活着？**

按顺序看三个字段：`idle` 小于 1 小时可能在跑，大于 1 小时判休眠（`reason: dormant`）；`liveness` 为 `stale` 表示心跳不反映当前，`insufficient-sample` 表示样本 < 20 不下 `FAILED` 判定，`reconstructed` 表示有完整重建；再看扫描顶部「宿主注册的活跃会话」里的 `busy`/`idle`（`claude agents --json` 同源）。三者都不确定时，最可靠的信号是**打开那个会话看一眼**。本库事后重建，天生有延迟，不假装实时。

**Q：`--days 30` 为什么这么慢？**

它按**文件**扫，不按天。窗口越长，落进来的 transcript 越多：本机 `--days 3` 是 19 个会话、13 秒；`--days 30` 是 124 个会话、实测 48 秒。每个会话最多读 4 MB 尾部、最多展开 30 个子 agent，所以耗时不随天数线性增长，而随「还没被裁掉的文件数」增长。（`--help` 里原本写「30 天约需 110 秒」，那是优化前的值；现已改为「实测约 40 秒，随语料增长」。）日常用 `--days 3`。面板里按 `q` 会立刻杀掉扫描子进程，不会卡住等它跑完。

**Q：扫描会不会影响正在跑的会话？**

不会。只读 `~/.claude/projects/` 下的 `.jsonl` 和 `~/.claude/jobs/` 下的 `state.json`，不写文件、不加锁、不发信号。唯一副作用是十几秒到一分钟的 CPU 与磁盘读。

**Q：面板能不能改会话状态？为什么不能？**

不能。状态是**算出来的**，不是存起来的——没有「状态字段」可改。面板只做渲染：调用 `scan-sessions.mjs --json`，原样显示返回字段，不计算 novelty、不做判定（ADR-0001 的硬边界）。往运行中的会话写东西的能力宿主本来就不给（见 §6），所以「改状态」没有对应操作，面板也不提供假按钮。

**Q：我改了 `.claude/agents/` 里的角色，怎么生效？**

新开的会话自动加载；已打开的会话不会热更新，角色定义在会话启动时读入。改完先跑 `node scripts/check-structure.mjs`：它检查 frontmatter 是否有 `name`/`description`、`description` 是否够长（主线程靠它路由）、只读角色有没有混进 `Edit`/`Bash`。红了按提示改，别指望运行时报错。

**Q：这个库和 `claude agents` 有什么区别，为什么要用两个？**

`claude agents` 回答「宿主注册了哪些会话、现在 busy/idle/blocked」；`scan-sessions.mjs` 回答「这些会话在干什么、有没有卡住、卡在哪」。同一次运行实测：

```
claude agents --json  → 10 条：blocked=2 busy=4 idle=4，其中 2 条 background
scan --days 3         → 19 条：PRODUCING=3 EXPLORING=16
```

`claude agents` 看不到 `failed`（只有 `blocked`），没有 novelty、idle 时长、派生树、token；`scan` 则要从 transcript 重建，有延迟。两个都用：`scan` 判断「该不该管」，`claude agents` 确认「这个会话是否真的注册着、能不能投递」。scan 顶部那 8 行「宿主注册的活跃会话」就是把后者并进来了。

补充：`novelty=null` = 最近 20 次调用不够一窗，此时只可能判 `EXPLORING`，不会判 `STALLED`，调用攒够自动恢复。

## 9. 出问题了怎么办

### 硬门红了

先看它报哪一类。典型的一条：

```
✗ 1 项违规：

  [.gitignore] 排除了产品本体目录 ".claude"（规则：.claude/）——git add -A 会静默什么都不加
```

这是照抄参考项目 `.gitignore` 的后果，删掉那条规则即可。本仓库的 `.gitignore` 刻意不包含 `.claude/`、`docs/`、`tasks/`、`scripts/`、`templates/`，它们就是产品本体。

| 报错 | 含义 | 怎么办 |
|---|---|---|
| `可发布区出现本机绝对路径` | 文档里写了 `D:\...`，clone 到别处无意义 | 改相对路径或 `<你的路径>`；作为反例引用时同一行要带「反例/示例/实测」 |
| `私有路径未在 .gitignore 中排除` | `tasks/runs/` 或 `settings.local.json` 可能被提交 | 补 `.gitignore` |
| `frontmatter 缺少必填字段` | agent 少了 `name` 或 `description` | 补上，`description` 至少 10 字 |
| `只读角色 "xxx" 拥有写工具` | 把 `Edit`/`Bash` 加给 critic/acceptor 一类 | 删掉；只读角色最多留 `Write` 且正文须声明只写报告 |
| `空目录不会被 git 跟踪` | 建了个空目录 | 放文件或删掉 |
| `无法被 Node 解析` / `import 或调用导出函数时失败` | 语法错，或改了函数契约漏改调用方 | 看冒号后的第一行错误，通常是变量未定义 |
| `缺少能力边界声明` | README 没写「不能自动接力」 | 补回去，这是产品诚实性的硬要求 |

硬门必须在**仓库根目录**跑。在别的目录跑会把它当根，扫出几千项无关违规——那是路径问题，不是仓库问题。

### 测试红了

```bash
node --test scripts/state-model.test.mjs
```

真实失败输出（故意改坏休眠闸门后）：

```
✖ 长时间无活动的会话判休眠，不判 FAILED (5.4064ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected

  + 'STALLED'
  - 'EXPLORING'
```

`+ actual` 是脚本现在算出的，`- expected` 是测试认为应该的。先判断哪边对——测试也可能过期。改判定逻辑时先想清楚这个测试保护的是什么行为；行为本身要变就改测试并在提交信息里写明为什么，不要为了让测试变绿而把断言改软。

四个测试文件：`state-model.test.mjs` 管五态判定、novelty、心跳阈值、Bash 归一化、权重重估；`tui-theme.test.mjs` 管字形、颜色开关、CJK 宽度；`oversight-tui.test.mjs` 管渲染、净化、草稿拼装、纯文本输出；`app-router.test.mjs` 管按键路由、页面迁移、滚动边界。全跑 `node --test scripts/`（本机 81 项全绿）。

### 扫描报错

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `无法定位 transcript 根目录`，退出码 2 | 这台机器还没有会话记录，或 `HOME`/`USERPROFILE` 指错 | 确认 `~/.claude/projects/` 存在，在正确用户下运行 |
| 输出 0 个会话，但你知道有 | `--days` 太短，或 `--project` 过滤词不匹配 | 放宽 `--days`；`--project` 做子串匹配，写目录名的一部分即可 |
| 面板顶部 `⚠ 扫描失败…` | 扫描超时（>180 秒）、非零退出无 JSON、或输出不是合法 JSON | 手动跑 `node scripts/scan-sessions.mjs --json \| head` 看真实报错；确认 Node ≥ 18 |
| 某会话 `calls` 很小但明显干过很多活 | 每个文件只读末尾 4 MB，主 transcript 取末尾 1200 条记录，子 agent 各取 400 条 | 正常设计，不是 bug |
| `sub` 明显小于预期 | 子 agent 上限 30，超出被截断（显示 `30/N~`） | 正常设计；调大上限会显著拖慢扫描 |

排查顺序固定：先 `node --version`，再 `node scripts/scan-sessions.mjs --days 1`，再 `--json` 看结构，最后才怀疑代码。大多数「扫描坏了」是环境或路径问题。
