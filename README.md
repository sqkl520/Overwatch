# Overwatch

**在 AI 想收工时替你把关。**

它会扫描本机所有 Claude Code 会话，但真正的价值只有一个动作：当某个会话说「做完了」，
去 transcript 里找支持这句话的工具调用——找不到，就把这句话标出来。附带把会话压成一张表，
在真的需要你时通知你。

> 这一版刻意**收窄了定位**。它不做「管理你所有的会话」——官方 `claude agents` 已经把
> 「看清有哪些会话」做完了（见下）。它做的是官方没有的那一件事：
> **把「AI 说它做完了」变成一句可核对的断言。** 其余能力是围绕这件事的观测面。
> 每一条能力对应的命令见 [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md)。

零 npm 依赖（仓库里没有 `package.json`），只要 Node ≥ 18。不安装、不登录、不配置。

---

## 它解决什么问题

同时开五六个会话已经很常见。真正的摩擦不是切窗口，而是几小时后回来时记不清**哪个在干什么、哪个卡住了、哪个一直在等你**：一个会话三小时前抛了个二选一的问题，你没看见；另一个说「修好了」，其实只是把报错吞了；其余几个在跑，但你不知道它们是在推进还是在原地打转。

Overwatch 给这三件事可见性：扫全部 transcript → 判状态 → 只在真的需要你时通知。它不替你决策，也不往运行中的会话里写东西。

## 30 秒上手

```bash
git clone https://github.com/sqkl520/Overwatch.git
cd Overwatch
node scripts/scan-sessions.mjs --days 3
```

真实输出格式（项目名已替换）：

```
OmniSight 会话扫描 · 最近 3 天 · 19 个有活动的会话
liveness: reconstructed（事后重建，非实时上报）

[PRODUCING] Projects/<repo>     calls=  988 sub=    13 depth=1 novelty=0.97 hb=0s/120s    idle=5s   persistent-change-in-window
[EXPLORING] Projects/<repo-2>   calls= 5840 sub=100/272~ depth=1 novelty=1.00 hb=0s/120s  idle=67.5h dormant
```

`--days 3` 一次全量实测约 **33 秒**。`dormant` 不告警——会话只是结束了，不是坏了。

```bash
node scripts/oversight-tui.mjs            # 面板：列表 → Enter 详情 → c 复制接力草稿
node scripts/watch.mjs --inbox            # 一次性看谁在等你
node scripts/install-watcher.mjs install  # 开机自启 + 桌面通知
```

Windows 有开机自启和 Toast；macOS / Linux 给出 launchd / systemd 配置但没有通知通道，退回写 `runner.log`。**没有通知通道时不会静默丢弃**，`--inbox` 随时能看。

## 核心能力

下表每一行都对应 `docs/CAPABILITIES.md` 里一条**能跑的命令**——硬门会检查那些命令的脚本与参数真实存在。

| 能做 | 不能做 |
|---|---|
| 扫全部会话，压成一张可排序的表 | 实时干预运行中的会话 |
| 透传宿主的 `needs` / `suggestedReply`（它在等什么、建议回什么） | 自动把回复发进目标会话 |
| 检出持久化变更（`Write`/`Edit`/写命令），区分「在改东西」和「在读东西」 | 判断改得对不对 |
| 会话等你时弹桌面通知（宿主 `status: waiting`） | 从「停了很久」推断失败——**实测后已删除该推断** |
| 把完成声明与支持它的工具调用配对，判四档（见下） | 保证 AI 没在别处撒谎 |
| 在收工点值守：AI 想结束回合时拦住没有证据的完成声明（Stop hook，默认关闭） | 替用户点「结束」或「允许」 |
| 生成带具体下一步的接力草稿，由你复制发送 | 自动接力（见下） |
| 产出对账：派活前登记「该产出哪些文件」，收活时对磁盘与 transcript 四方核对 | 保证子 agent 说的就是它做的（只核对文件痕迹，不核对语义） |

### 关于「六种状态，只有两个能驱动动作」

代码里有 `EXPLORING` / `PRODUCING` / `STALLED` / `FAILED` / `BLOCKED` / `WAITING`，但在真实数据里极不均衡。2026-10-31 实测 129 个会话的末态：

| 状态 | 命中 | 说明 |
|---|---|---|
| `EXPLORING` | 122 | 绝大多数会话的末态 |
| `PRODUCING` | 4 | 窗口内有真实写入 |
| `BLOCKED` / `FAILED` | 2 / 1 | 宿主报的，不是推的 |
| `WAITING` | 0–1 | 宿主实时状态，你一说话就消失，抓不到末态 |
| `STALLED` | **0** | 全语料 56,809 个滑窗里命中 10 次（0.018%），末态从未命中 |

**不要把它当状态机用。** 真正能驱动动作的只有宿主上报的那几个。会发通知的是 `WAITING` / `BLOCKED` / `FAILED` / `ASKED`；前三个的判据来自宿主文件、不来自推断，`ASKED` 是从 transcript 文本推的，走另一套更严的门。

## 和官方 `claude agents` 是什么关系

`claude agents --json` 已经能列出所有会话、按状态分组、可派发可回复。**它把「看清有哪些会话」这件事原生做完了**，这一点直说。两者回答不同的问题：

```
claude agents --json  →  宿主注册了哪些会话，此刻 busy / idle / blocked
scan-sessions.mjs     →  这些会话在干什么、有没有卡住、卡在哪儿
```

同一次运行实测：前者给 10 条（blocked=2 busy=4 idle=4），`scan --days 3` 给 19 条（PRODUCING=3 EXPLORING=16）。`claude agents` 看不到 `failed`，也没有 novelty、idle 时长、派生树、token 用量；`scan` 则要从 transcript 重建，天生有延迟。**两个都用**：`scan` 判断「该不该管」，`claude agents` 确认「这个会话是否真的注册着、能不能投递」。

本仓库超出这一层的地方只有一处：**断言与证据的核对**。其余能力官方在覆盖，开源侧也有几千个同类项目——不假装这是蓝海。

## 为什么不能自动接力

**这不是本库的缺陷，是平台的安全边界。**

官方文档写明：来自另一个会话的消息**永远不算你的同意**——不能替你回答权限提示、不能改配置、消息里的斜杠命令不会被执行。`claude --help` 对 `--bg --resume <session-id>` 的原文也是「或者在会话已在运行时启动一个副本并说明这一点」：你以为接上了，实际另一个副本在跑。

所以 `relay.deliver` 只有一个合法值：`manual`。草稿由 TUI 按 `c` 复制，或由 Relay Agent 写好经 Safety Agent 过红线，**粘贴和回车这两步永远是你的**。往这个方向加自动化，等于和平台的安全模型对打。

## 通知系统：三个修掉的真 bug

2026-11-04 的修复，每一个都有真实日志与负向测试（把 bug 装回去测试必然变红）。

| 缺陷 | 实测 | 修复后 |
|---|---|---|
| `permission prompt` 是噪声桶 | **66/66 = 0% 真阳性**（`input needed` 是 9/9 = 100%） | 不再通知，但照常写观察记录 |
| 去重键恒等 | 会话 `<session-S>` 的 **8 次真实等待挤成 1 个键**，一次都收不到 | 8 次等待 → 8 个键 |
| `lastSeenAt` 从不刷新 | 现场 **73/73 条**记录 `lastSeenAt === firstSeenAt`，超过 24h 的等待在第 25 小时被重新通知 | TTL 改按 `lastSeenAt` 计时 |

真实日志里 `already=1` 出现 **5413 次**，其中连续 **2213 个 tick（585 分钟）**在同一个键上空转——这就是键恒等的形状。

更早一次删代码同样值得记：初版会推断「末次调用间隔超自适应 p95 且停够 60 秒 → `FAILED`」。全语料实测后删掉——真实运行发了 5 条通知，**5 条全是它发明的 `FAILED`**，对应会话分别在 13 / 151 / 411 秒后继续干活，最离谱的一条在报「失败」时正在跑 `sleep 240`。删掉之后脚本从「猜 5 次全错」变成「不猜」。

## 唯一站得住的差异：断言 vs 证据

Agent 报「修好了」而实际只是把报错吞了——HN 长贴上反复出现的词是 **「sanitised optimism」**，有用户的说法是「现在我总让它先证明真的生效了再往下走」。Cognition 2026 的实测方向一致：独立的干净上下文 review agent 平均每个 PR 抓 2 个 bug，约 58% 是严重的。

`scripts/verify-claims.mjs` 把这件事做成可运行的判据：从最后一条 assistant 文本认出可核对的完成性断言（测试通过 / 构建成功 / 已提交 / 已推送 / 文件数 / hash），在 transcript 的 tool_use / tool_result 里找支持它的调用，再按「最后一次源码编辑」这条时间线判四档：

```
SUPPORTED / STALE_ONLY / FAILED_ONLY / NO_EVIDENCE   （另有 UNKNOWN = 读不全，不当「没有」）
```

全量实测（228 个主 transcript、31 条断言）：`SUPPORTED 26 / STALE_ONLY 1 / FAILED_ONLY 0 / NO_EVIDENCE 1 / UNKNOWN 3`。人工抽检 13 条：11 条判对、2 条判错，**精度约 84.6%**（样本小，只能当量级看）。全量耗时 2.9–5.6 秒。

2026-11-13 起多认一族 **`vague-completion`**：「修好了」「搞定了」这类**没有任何指标**的完成声明——它们恰恰最需要证据，而改造前被判为「没认出断言」直接放行。范围与已知漏报见 `docs/CAPABILITIES.md` §4。

同仓库还有两个确定性判据：`stop-signals.mjs`（停机原因的结构判定：错误停机、死循环、上下文压力、原始目标提取，全部不读语义）和 `asked.mjs`（从文本判断「问了没答」，不依赖宿主）。都能直接跑，例如 `node scripts/verify-claims.mjs --days 3`、`node scripts/stop-signals.mjs`。

**收工值守（可选）**：`scripts/stop-verify-hook.mjs` 把上面的判定挂到宿主的 `Stop` 事件上——
AI 想结束回合时，宿主先问它一句「你的完成声明有证据吗」，没有就把理由喂回去让它补。
**默认关闭，只记账不拦**；开启方式、上限与 fail-open 设计见 `docs/CAPABILITIES.md` §3。

## 目录

```
Overwatch/
├─ .claude/agents/       12 个角色定义（宿主直接加载）
├─ docs/                 入口 docs/README.md · CAPABILITIES 能力清单 · GUIDE 手册
│                        spec/ 规格 · adr/ 决策 · research/ 实测报告（含状态索引）
│                        design/ 全是未实现的设计推演，状态见 docs/design/README.md
├─ scripts/              scan / watch / verify-claims / stop-verify-hook / TUI / 硬门
└─ tasks/                两本台账：范围外发现、已知偏差
```

新来的人从 [`docs/README.md`](docs/README.md) 开始——它按「你想知道什么」指路，并说清四类文档的可信度不同。

改动后必跑 `node scripts/check-structure.mjs`（结构硬门）与 `node --test scripts/*.test.mjs`（973 条回归测试；**这个数字由硬门与实跑对账，写错即红**，所以照抄即可、不必手工数）。

## 已知局限

这些不是待办，是知道但选择不做的：

| 局限 | 实测 | 为什么不修 |
|---|---|---|
| 在线停止分类基本失效 | 在线路径 **95.4%** 判 `UNCLASSIFIABLE` | 结构性：要判这次停止是问句还是结束得看下一句，而在线时下一句还没发生 |
| 通知抑制准确率无法自测 | 无自动测量手段 | 需要人标注「这条该不该发」，没有基准 |
| `needs` 覆盖稀疏 | 16 个 job 里只有 2 个带 `needs`、1 个带 `suggestedReply` | 宿主只在阻塞时写，取决于用法 |
| `STALLED` 近乎不可达 | 全语料 0.018% | 见上文「六种状态」 |

两条和本库无关但影响你怎么用它：

- **多 agent 不是免费的。** Anthropic 自述多 agent 系统比 chat 多烧约 **15×** token，且 token 用量单独解释 **80%** 的性能方差——收益主要来自花更多 token，不是架构更聪明。MAST 论文（1600+ 轨迹）实测「改进角色规格」和「增强协调」两种干预效果不充分；本仓库 `.claude/agents/` 的方法论属于后一类，别指望它能单独把结果变好。
- **扫描是事后重建，不是实时。** 每个文件只读末尾 4 MB，主 transcript 取末尾 1200 条记录。要确认某个会话此刻的真实状态，最可靠的办法是打开它看一眼。

**够用与否**：要「这几个会话里哪个在等我、哪个在报假完成」，够用；要「自动接力、自动决策」，**不够用**，而原因是平台的墙，不是缺一个 feature。

## License

MIT
