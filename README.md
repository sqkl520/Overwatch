[English](README-EN.md) | 简体中文

<div align="center">

# UntilDone

**一次给到需求，便一次做完。**

它约束 AI 在动手前把需求问清楚、收工时把「做完了」对上证据 —— 不给你「一轮一个骨架、二轮一层皮毛」。
跨会话监控只是让它能看见「这一轮到底做到哪了」的附属能力，不是产品定义。

![CI](https://github.com/sqkl520/UntilDone/actions/workflows/validate.yml/badge.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A518.20.4%20%C2%B7%20tests%2020.16%2B-blue?style=flat-square)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)
![Tests](https://img.shields.io/badge/regression%20tests-1873%20passing-brightgreen?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

**零依赖** · **不用安装** · **不登录也能核对证据** —— `git clone` 之后 `node scripts/overwatch.mjs` 就行

**[⚡ 快速开始](#-快速开始)** ·
[能力清单](docs/CAPABILITIES.md) ·
[使用手册](docs/GUIDE.md) ·
[问题反馈](https://github.com/sqkl520/UntilDone/issues)

</div>

> ⚠️ **这是一个高一牲用 AI 辅助开发（vibe coding）做的工具库，处于早期开发中**
> 有任何问题、建议都欢迎提交 [Issues](https://github.com/sqkl520/UntilDone/issues)；
> 如果喜欢这个项目就 Star 一下喵 ⭐
>
> **它不是 App，也不是 Claude Code 插件**：没有安装包、没有 Release、没有 npm 包 ——
> **对外可用的版本就是你 clone 到的那一刻的 `main`**。内部阶段号在
> [`docs/CHANGELOG.md`](docs/CHANGELOG.md) 头部（当前 `0.2.0` + `[Unreleased]`），
> 那是给自己看的工作阶段，不是可下载的版本。想确认手上这份能跑什么，跑
> `node scripts/overwatch.mjs` —— 它只说读到的事实，不替你判通过。

---

## ✨ 功能特性

**需求传递：三道闸**

- **开工前问够再写** —— 第一次写文件之前，transcript 里必须已经有 N 个去重后的提问（`ask.minQuestionsBeforeWrite`，默认 `0` = 这条判据不存在）
- **先证明读过项目** —— 首次写文件前要读过 ≥3 个不同文件（`minReads`）；Edit 侧另有一条：必须读过被改的那个文件本身
- **收工前对上证据** —— 说完「做完了」，Stop hook 去 transcript 里找支持这句话的工具调用；`NO_EVIDENCE` / `STALE_ONLY` / `FAILED_ONLY` 拦，「判不了」的放行
- **收活时机械对账** —— 子 agent 说它产出了哪些文件，`claim-ledger.mjs verify` 拿「期望 / 自述 / 磁盘 / transcript 痕迹」四方交叉

**证据核对**

- **断言 vs 证据** —— 四档判定 `SUPPORTED` / `STALE_ONLY` / `NO_EVIDENCE` / `UNCHECKABLE`，不猜、不合并
- **时效性推理** —— 不是「找到了构建成功的记录」，而是「那个成功你后来改了源码，已经失效」
- **十个断言族，九个有确定性证据源** —— 测试条数、构建、文件数、产物 hash、commit、push、PR/CI、运行时探针，以及无指标的空口完成声明；`todos`（「待办清空」）**没有**证据源，单列一档、不参与四档比例
- **能当 CI 用** —— 存在 `NO_EVIDENCE` 即非零退出（`--exit-zero` 可强制放行）
- **解释得清** —— `--explain 1` 给出命中的调用、最后一次源码编辑、判定理由

**会话观测**

- **一张表看全部会话** —— 每个会话一行：状态 / 调用数 / novelty / 闲置时长 / 判定理由
- **透传宿主原话** —— `[BLOCKED]` 行下面直接给出宿主写的「等待输入 / 建议回复」
- **谁在等你** —— `watch.mjs --inbox`，退出码 3 专门区分「确实没有」与「空但守护进程没在跑」
- **面板** —— 列表 → `Enter` 看详情 → `c` 复制接力草稿；非 TTY 自动降级成纯文本快照
- **机器可读** —— `--json` 是同一份数据，人类输出由它渲染，不是两套

**自检与台账**

- **唯一入口** —— `overwatch.mjs` 报 8 项前提事实，**1000ms 预算且会把超支说出来**（本机实测 1133ms，输出末尾直接写「1133ms / 预算 1000ms」），不扫语料
- **起一个挂了载荷的会话** —— `launch`，先 `--dry-run` 逐字看清会执行什么；`--verify` 只验载荷，不需要登录
- **结构硬门** —— 23 项检查（测试数对账、文档路径与命令、能力清单、内外链、台账格式……）
- **两本台账** —— `tasks/dev-findings.md`（范围外发现）、`tasks/accepted-deviations.md`（已知偏差）

> 每条能力对应的**确切命令**见 [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) ——
> 硬门会核那里的脚本与参数真实存在。「不能做」那张表也写在那里，附依据，不是没做完。

## 🚀 快速开始

1. 确认 Node：跑工具 **≥ 18.20.4**，跑测试 **≥ 20.16.0**（用了 `import.meta.dirname` 与 `process.getBuiltinModule`）
2. 克隆并自检（不需要安装、不需要登录、没有 `package.json`）

   ```bash
   git clone https://github.com/sqkl520/UntilDone.git
   cd UntilDone
   node scripts/overwatch.mjs
   ```

3. 读这 8 行。**每行只报读到什么，不出红绿灯**（本机实测输出，路径已换成占位符）

   ```
   overwatch doctor · 查 8 项前提 · 预算 1000ms（只查前提，不扫语料）
   [   0ms] node        v26.12.1 · 工具下限 18.20.4 满足 · 测试下限 20.16.0 满足
   [ 209ms] transcripts <home>/.claude/projects · 81 个（未完）项目 · 509 份 .jsonl（下限） · 最新一份 2 小时前
   [   8ms] sources     jobs 11 个 state.json · sessions 10 个 .json
   [   2ms] claude/     agents 12 个 · skills 1 个 · settings.local.json 已建
   [  47ms] gate        mode=observe · brake=halt · marker=exists {...}
   [ 624ms] watcher     启动器 在 · 快捷方式 在 · health 说 未认出 · 数据目录 <state>
   [   1ms] platform    win32 · 桌面通知可用（Toast） · 开机自启有启动文件夹
   [ 116ms] plan        <run-id> · 进度 1/5 完成 · 2 失败 · 2 待认领 · 预算 50% · 最长限时 8 分
   合计 1133ms（本进程 1013ms + 启动 120ms）/ 预算 1000ms —— 前提齐了，可以跑 scan
   ```

   三种空状态是分开的：根不存在 → `exit 2`，根在但读不出 → `exit 3`，根在且 0 份 → `0`。

4. 挑一条往下走（入口只路由，不代跑）

   ```bash
   node scripts/scan-sessions.mjs --days 3        # 每个会话一行：状态 / 调用数 / 闲置时长
   node scripts/verify-claims.mjs --days 3        # 「AI 说它做完了」有没有证据
   node scripts/oversight-tui.mjs                 # 面板：列表 → Enter 详情 → c 复制接力草稿
   node scripts/watch.mjs --inbox                 # 谁在等你
   node scripts/check-structure.mjs               # 结构硬门
   ```

**面板长这样**（`node scripts/oversight-tui.mjs --plain`，真实输出，项目名换成占位）：

```
1 件在等你 · 12 个会话在跑 · 3 个已停
纯文本快照（交互界面需在终端运行） · 窗口 最近 1 天 · 数据 0s前

 声明对不上   … 4 条存疑 · d 看证据
 后台监视     ✗ 监视未在跑（jobs 2.2d / probe 2.2d 未更新） · 先修这个
 ✓ 其余 1 项没有发现

需动作 (1)
 项目 A                                             1.9d  Enter 看原文
    它在等：login required — run /login

在跑 (12)
 项目 B                                              2s  构建仍在进行，没开始写。
 项目 C                                             12s  Description 更新成功，但 **Topics 是空的**。
 项目 D                                             28s  守卫实现得很到位（正则覆盖换行/空白）。
```

三处值得看：

- **第一行是判决不是标题**：「1 件在等你」排在最前，「12 个会话在跑」是背景
- **「后台监视 ✗」而不是一个绿勾**：它没在跑，会影响上面那个「1」的可信度，所以直接说
- **「其余 1 项没有发现」而不是「全部正常」**：只报查到的，不替你没查的背书

## ❓ 常见问题

| 问题 | 解法 |
|---|---|
| 我按旧文档在 `Overwatch` 目录放了叫停文件，现在不改目录名也生效吗？ | 生效，两个都认。`%LOCALAPPDATA%/UntilDone/stop-hook.PAUSE` 是主路径，旧名 `Overwatch` 那条**故意保留**（`DF-041`）。想知道自己放对没有：`node scripts/pre-write-gate.mjs status --cwd .` 会把正在检查的每条路径列出来并标出命中的那条 |
| 我明明在 shell 里 `export` 了 `OVERWATCH_STOP_VERIFY=block`，闸还是没拦 | 桌面版 hook 的环境变量继承**宿主进程**，不是你的终端。要写进 `.claude/settings.local.json` 的 `env` 块。这个失效方向最坏：你以为闸开了，其实一直是观测模式，而没有任何东西会提示你 |
| 装了写前闸，怎么一点感觉都没有？ | 两件事都默认关：`OW_PRE_WRITE_GATE` 不设 = `observe`（只记账），`ask.minQuestionsBeforeWrite` 默认 `0`（判据不存在）。先跑几天看 `<状态目录>/pre-write-gate/<日期>.jsonl` 里的 `would-deny`，再决定开不开 |
| `--days 30` 为什么这么慢？ | 它按**文件**扫，不按天。耗时随语料增长而变，不随天数线性变：每个会话最多读 4 MB 尾部、最多展开 100 个子 agent。日常用 `--days 3`。**不要相信任何写死的秒数**，包括本 README 里没有写的那些 |
| 扫描会不会影响正在跑的会话？ | 不会。只读 `~/.claude/projects/` 的 `.jsonl` 和 `~/.claude/jobs/` 的 `state.json`，不写文件、不加锁、不发信号 |
| 面板能不能改会话状态？ | 不能。状态是**算出来的**，不是存起来的 —— 没有「状态字段」可改。面板只渲染 `scan-sessions.mjs --json` 的返回，不提供假按钮 |
| 我的会话显示 `EXPLORING` 三天了，是卡住了吗？ | 大概率不是。`idle` 超过 1 小时判休眠（`reason: dormant`），`FAILED` **只认宿主上报**，不从「停了很久」推。最可靠的信号是打开那个会话看一眼 |
| `claude agents --json` 已经能看会话了，为什么还要用这个？ | 两者回答不同问题：前者答「宿主注册了哪些、此刻 busy/idle/blocked」（没有 `failed`、没有 novelty / idle 时长 / 派生树 / token），后者答「这些会话在干什么、卡在哪儿」。`scan` 判断「该不该管」，`claude agents` 确认「这个会话是否真的注册着、能不能投递」 |
| `UNCHECKABLE` 占八成的意思是「没问题」吗？ | 不是，是**判不了**。它只在少数有明确工具调用可对的断言上有效（构建成功、测试通过、推送完成、文件数）。把「判不了」说成「没问题」是本项目最不想犯的错 |
| 能不能让 AI 自动把回复发进目标会话？ | 不能，而且不是没做完 —— 见 [为什么不能自动接力](#-为什么不能自动接力) |
| 宿主明明给了 `needs`，为什么我这边大多是空的？ | `needs` / `suggestedReply` 只在**阻塞时**由宿主写入。本机实测 16 个 job 里只有 2 个带 `needs`、1 个带 `suggestedReply` |
| 改了 `.claude/agents/` 里的角色，怎么生效？ | 新开的会话自动加载；已打开的不热更新（启动时读入）。改完先跑 `node scripts/check-structure.mjs`，它会查 frontmatter、`description` 长度、只读角色有没有混进 `Edit`/`Bash` |
| 硬门红了 / 测试红了怎么办？ | 看 [`docs/GUIDE.md`](docs/GUIDE.md) §10「出问题了怎么办」，按报错逐类对照。硬门必须在**仓库根**跑，否则它会把你当前目录当仓库根 |

## 🔧 它是怎么工作的

```
你的会话（宿主 claude）
   │  每个回合起止各回调一次，没有常驻进程
   ├─ PreToolUse ──► scripts/pre-write-gate.mjs ──► <状态目录>/pre-write-gate/<日期>.jsonl
   │                   判据：读没读过项目 / 问没问够 N 个问题
   └─ Stop ────────► scripts/stop-verify-hook.mjs ─┐
                                                    │ 复用同一套判定
   ~/.claude/projects/*.jsonl（只读）───────────────┴─► detectClaims → findEvidence → classifyEvidence
                                                            │
                    scripts/scan-sessions.mjs ◄─────────────┘（同一批 transcript，只读尾部）
                              │ --json
                              ▼
              oversight-tui.mjs（面板） / watch.mjs（收件箱、通知、健康）
```

两条纪律贯穿全仓：**只读宿主留下的痕迹，自己只写台账**；**判不了就说判不了，不拿缺失当证据**。

### 技术栈

| 层 | 用了什么 |
|---|---|
| 运行时 | Node（工具 ≥ 18.20.4，测试 ≥ 20.16.0），**无 `package.json`、无 `node_modules`** |
| 代码量 | 56 个生产脚本 + 45 个测试文件（1873 条 `test(`，硬门数源码对账） |
| 接口面 | 宿主 hooks（`PreToolUse` / `Stop`）+ 命令行 + 纯文本 / JSON 输出 |
| 角色 | `.claude/agents/` 12 份 markdown 定义 + 1 个调度 skill（宿主直接加载） |
| 存储 | 宿主 transcript 只读；自己的状态落在 `tasks/runs/`（gitignored）与用户状态目录 |
| CI | GitHub Actions：[`validate.yml`](.github/workflows/validate.yml) —— 结构门 + 载荷布局 + 全量测试 |

<details>
<summary><b>关键设计一：为什么是 hook，不是守护进程</b></summary>

一个「拦住这一回合」的东西必须在**回合边界**上被调用，而回合边界只有宿主知道。自建守护进程
要么轮询 transcript（事后重建，拦不住），要么往运行中的会话里注入（平台封死的路径）。

所以真正的拦截面是宿主的两条 hook：

- `PreToolUse` —— 在工具执行**之前**拿到 `tool_name` 与 `tool_input`，可以返回 `permissionDecision: "deny"`
- `Stop` —— 在回合结束时拿到 `transcript_path`，可以返回 `{"decision": "block"}` 让模型继续

两点实测出的坑：`exit 2` **不**等价于 `{"decision":"block"}`（会被记成
`Failed with non-blocking status code`，回合照常结束）；`timeout` 低于 60 秒会被宿主静默 kill，
表现为「hook 跑了但没生效」。

</details>

<details>
<summary><b>关键设计二：为什么三道闸默认都是关的</b></summary>

误拦的代价不对称。挡死一个诚实的会话，比放过一个吹牛贵得多 —— 用户会把 hook 整个关掉，
然后连记账都没有了。所以：

- 写前闸三档 `observe` / `warn` / `deny`，**默认 `observe`**，只往台账写 `would-deny`
- 收工闸默认 `off`，只记账、永远 `exit 0`
- `ask.minQuestionsBeforeWrite` 默认 `0`，等于这条判据**不存在**（装上后行为逐字节不变，有测试钉住）
- 收工闸 `fail-open` 且**不可配置成 fail-closed**：hook 崩了、超时、输入是垃圾、transcript 读不到 —— 一律放行
- 只拦「证据不足」，不拦「证据矛盾」：`UNKNOWN` / `UNCHECKABLE` 一律放行，**没读到不等于没做**
- 自设拦截上限 6 次（`MAX_BLOCKS = 6`，实际语义是「每 10 分钟 6 次」，因为计数按时间归零），不依赖宿主的 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`（那是会随版本变的实现细节）

</details>

<details>
<summary><b>关键设计三：为什么面板不假装实时</b></summary>

`scan-sessions.mjs` 是**事后重建**：每个文件只读末尾 4 MB，主 transcript 取末尾 1200 条记录，
子 agent 各取 400 条、最多 100 个。这不是省事的偷工，是「一小时扫完几百份 transcript」的唯一办法。

代价写在明面上：`liveness` 字段会告诉你这份重建有多新（`reconstructed` / `stale` /
`insufficient-sample`），而面板顶部那行「数据 0s前」就是它。要确认某个会话此刻的真实状态，
最可靠的办法仍然是**打开它看一眼**。

</details>

## 🎯 唯一站得住的差异：断言 vs 证据

这是整个项目的理由。看一条真实输出：

```
AI 说：「## 交付完成：**BUILD SUCCESS — 1341 例全绿**」
证据：构建调用 5 次（成功 2 次）；最近一次成功在 11-16 19:58；之后 11-16 20:56 又改了源码
判定：STALE_ONLY（构建/编译成功）
建议：成功结果在源码改动之后就失效了。重跑 `mvn -q -DskipTests package`，
      补上最后一次编辑之后的证据
```

**注意第三行。** 它不是说「找到了构建成功的记录」，而是说**那个成功已经失效了** ——
因为构建之后你又改了源码。这是证据的时效性推理，不是「找关键词」。

四档判定：

| 档位 | 含义 |
|---|---|
| `SUPPORTED` | 断言有对应调用，且调用在最后一次相关改动之后 |
| `STALE_ONLY` | 有对应调用，但之后又改了相关代码 —— **成功已失效** |
| `NO_EVIDENCE` | 说了做完了，找不到任何对应调用 |
| `UNCHECKABLE` | 断言类型不在可核对范围内 —— **判不了，明说判不了** |

### 诚实的数字

7 天窗口，2026-11-18 实测 192 条可核对断言：

```
SUPPORTED      20   10.4%
STALE_ONLY      3    1.6%
NO_EVIDENCE    11    5.7%
UNKNOWN         3    1.6%
UNCHECKABLE   155   80.7%   ← 八成判不了
```

**80.7% 判不了。** 这不是缺陷，是边界：它只在少数**有明确工具调用可对**的断言上有效
（构建成功、测试通过、推送完成、文件数）。其余一律归 `UNCHECKABLE` 而不是猜。
把「判不了」说成「没问题」是本项目最不想犯的错。

这些数字会随语料增长而变 —— 想看你机器上的，跑 `node scripts/verify-claims.mjs --days 7`。
不要把这里的分子分母当成常量引用。写这份 README 时用**同一条命令**重跑，本机得到
`172 条：10 SUPPORTED / 4 STALE_ONLY / 3 NO_EVIDENCE / 1 UNKNOWN / 154 UNCHECKABLE` ——
**条数变了，形态没变**。这就是为什么每条数字后面都要跟一条命令：能重跑的数字才算证据。

## 📋 六种状态，只有三个能驱动动作

代码里有 `EXPLORING` / `PRODUCING` / `STALLED` / `FAILED` / `BLOCKED` / `WAITING`，
但真实数据里极不均衡。2026-10-31 实测 129 个会话的末态：

| 状态 | 命中 | 说明 |
|---|---|---|
| `EXPLORING` | 122 | 绝大多数会话的末态 |
| `PRODUCING` | 4 | 窗口内有真实写入 |
| `BLOCKED` / `FAILED` | 2 / 1 | 宿主报的，不是推的 |
| `WAITING` | 0–1 | 宿主实时状态，你一说话就消失，抓不到末态 |
| `STALLED` | **0** | 全语料 56,809 个滑窗里命中 10 次（0.018%），末态从未命中 |

**不要把它当状态机用。** 真正能驱动动作的只有宿主上报的那几个。
会发通知的是 `WAITING` / `BLOCKED` / `FAILED` / `ASKED`；前三个的判据来自宿主文件、
不来自推断，`ASKED` 是从 transcript 文本推的，走另一套更严的门。

2026-11-21 用默认 7 天窗口重跑（524 个会话）：`EXPLORING 511 / PRODUCING 10 / BLOCKED 3`，
`FAILED`、`WAITING`、`STALLED` **一个都没有**。形状和两个月前一致 —— 也就是说，
「用 `EXPLORING` 去驱动重跑或重拆解」这件事从来没有成立过。

## ⚠️ 已知局限

这些不是待办，是知道但选择不做的：

| 局限 | 实测 | 为什么不修 |
|---|---|---|
| 在线停止分类基本失效 | 在线路径 **95.4%** 判 `UNCLASSIFIABLE` | 结构性：要判这次停止是问句还是结束得看下一句，而在线时下一句还没发生 |
| 通知抑制准确率无法自测 | 无自动测量手段 | 需要人标注「这条该不该发」，没有基准 |
| `needs` 覆盖稀疏 | 16 个 job 里只有 2 个带 `needs`、1 个带 `suggestedReply` | 宿主只在阻塞时写，取决于用法 |
| `STALLED` 近乎不可达 | 全语料 0.018% | 见上文「六种状态」 |
| 清单机制覆盖不到真实使用 | 7 天窗口：不含沙箱 72 份 transcript，派发 54 份（75%），走清单 **1 份（1.4%）** | 加闸只加给已经在守规矩的那一小撮人，而那批人本来不太需要 |

两条和本库无关但影响你怎么用它：

- **多 agent 不是免费的。** Anthropic 自述多 agent 系统比 chat 多烧约 **15×** token，
  且 token 用量单独解释 **80%** 的性能方差 —— 收益主要来自花更多 token，不是架构更聪明。
  MAST 论文（1600+ 轨迹）实测「改进角色规格」和「增强协调」两种干预效果不充分；
  本仓库 `.claude/agents/` 的方法论属于后一类，别指望它能单独把结果变好。
- **扫描是事后重建，不是实时。** 要确认某个会话此刻的真实状态，最可靠的办法是打开它看一眼。

**够用与否**：要「这几个会话里哪个在等我、哪个在报假完成」，够用；要「自动接力、自动决策」，
**不够用**，而原因是平台的墙，不是缺一个 feature。

## 🚧 为什么不能自动接力

能力边界写在这里，是因为它最容易被误解成「还没做」：

- 宿主的会话是**独立进程**，没有受支持的注入接口。往运行中的会话写东西需要模拟输入，
  而那是平台明确封的路径（实测过 UIA、IPC 管道、CDP 调试端口，全部不可用）。
- 所以本库只能**生成草稿**（面板里按 `c` 复制），由你粘贴发送。
- 这不叫「降级」，这叫「如实说平台的边界在哪」。

## 📌 当前进度

> 最后更新：2026-11-21。本表只记**实现状态**，不记「计划中的 fixN」——
> 本仓库没有 tag、没有 Release，版本以 `main` 为准。

**三道闸，逐个说清楚：**

| 闸 | 位置 | 现状 |
|---|---|---|
| 开工前问清需求 | `scripts/pre-write-gate.mjs`（`PreToolUse`） | ✅ **已实现，默认关**。`ask.minQuestionsBeforeWrite` 默认 `0` = 判据不存在；开了也只数次数，判不了「问得准不准」 |
| 过程中自拆清单供确认 | `scripts/claim-ledger.mjs` + `scripts/validate-run.mjs` | ⚠️ **工具在，没有闸**。清单率实测 1.4%（不含沙箱），覆盖不到真实使用，所以没加闸 |
| 收工前逐项核对落盘 | `scripts/stop-verify-hook.mjs`（`Stop`） | ✅ **已实现，默认 `off`（只记账）**，本机已开 `block`。台账 355 条判定里拦住过 2 条 |

**各模块：**

| 模块 | 状态 |
|---|---|
| 唯一入口 / 8 项前提自检 | ✅ 完成（1000ms 预算，三种空态分开） |
| 会话扫描（六态、novelty、派生树、宿主流） | ✅ 完成 |
| 面板（列表 / 详情 / 纯文本降级 / 复制草稿） | ✅ 完成 |
| 断言 vs 证据（九个断言族、四档 + 时效推理） | ✅ 完成 |
| 写前闸（读没读过 / 问没问够 / 三档 / 刹车） | ✅ 完成，**默认 observe** |
| 收工闸（fail-open、只拦证据不足、自设上限） | ✅ 完成，**默认 off** |
| 产出对账（期望 / 自述 / 磁盘 / transcript 四方） | ✅ 完成 |
| 后台守护 + 桌面通知 + 开机自启（Windows） | ✅ 完成（`install-watcher.mjs`） |
| 自动接力 / 自动把回复发进目标会话 | ❌ 平台封死，不做（见上文） |
| 实时状态 | ❌ 事后重建，不假装（见「怎么工作」） |
| 清单闸 | ⚠️ 无闸，原因是覆盖率（见「已知局限」） |

## 📦 构建与验证

**没有构建步骤** —— 没有 `package.json`、没有 `node_modules`、没有编译产物。
「构建」在这个仓库里等于「跑一遍门」。

**环境要求**：Node ≥ 18.20.4（跑工具）/ ≥ 20.16.0（跑测试）。

```bash
node scripts/check-structure.mjs     # 结构硬门：23 项检查，0 违规才绿
node scripts/check-links.mjs         # 文档相对链接不悬空（170 份 .md，0 断链）
node --test scripts/                 # 全量回归：45 个文件、1873 条
```

`check-structure.mjs` 与全量测试**都必须绿才能提交**。两条命令都在一秒到半分钟量级，
CI 上跑的是同一套（[`validate.yml`](.github/workflows/validate.yml)）：

```yaml
- node scripts/check-structure.mjs      # 结构 / 语法 / 文档一致性 / 能力清单
- node scripts/build-payload.mjs --verify-self   # .claude/ 载荷布局
- node --test <全部测试文件>             # 分两段跑：快的 43 个文件，spawn 重的两个串行
```

> 测试分两段不是洁癖：`launch.test.mjs` spawn 宿主 28 次，和其余文件抢默认并发，
> 实测从 20 秒涨到 116 秒并被判超时。分开跑总时长反而更短。

## 🤝 开发与贡献

这是一个高一牲在课余时间做的小项目，代码不算漂亮，但每一条判据都有测试钉着，
每一个「修好了」都要求负向证据（把 bug 放回去，测试或硬门要变红）。

- **贡献指南**：[`CONTRIBUTING.md`](CONTRIBUTING.md) —— 怎么报问题、怎么提 PR、代码约定与「绿」的标准。
- **报 bug 请带上**：`node scripts/overwatch.mjs` 的输出、`node --version`、复现步骤。
  它只说事实，正好是排查需要的那一份。
- **想改代码请先开个 Issue 说一声**，避免白写。
- **安全报告**：**不要开公开 issue**，见 [`SECURITY.md`](SECURITY.md)。
- **跑测试**：`node --test scripts/`（1873 条回归测试；**这个数字由硬门数源码 `test(` 调用对账，写错即红**，
  所以照抄即可、不必手工数。实跑报告会比它多几条 —— 子测试会被单独计数）。

> **贡献者名单和 Star 曲线这里目前都没有。** star 数是 0，star-history 会画出一张空图；
> 提交记录里的两个 GitHub 账号是同一个人。等真有第二个人再来补这两块 —— 放一张只有自己的图表，
> 比不放更容易让人误判这个项目的状态。

## 📚 文档

> 完整索引见 [`docs/README.md`](docs/README.md) —— 它按「你想知道什么」指路，
> 并说清四类文档的可信度不同（`spec/` 是现行事实、`design/` 全部未实现、`research/` 会过期）。

| 文档 | 内容 |
|---|---|
| [`docs/FOR-USERS.md`](docs/FOR-USERS.md) | **给新用户的上手说明**：每条声称后面跟一条你能自己跑的命令 |
| [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) | 能力 → 可运行命令的对照表；「不能做」附依据 |
| [`docs/GUIDE.md`](docs/GUIDE.md) | 使用手册：输出怎么读、出问题怎么办 |
| [`docs/FACTS.md`](docs/FACTS.md) | 逐条实测的事实清单：证据等级 + 复跑命令 + 已被推翻的结论 |
| [`docs/spec/state-model.md`](docs/spec/state-model.md) | 状态判据的唯一真源（阈值、六态、为什么删掉「间隔大⇒失败」） |
| [`docs/spec/dispatch-contract.md`](docs/spec/dispatch-contract.md) | 怎么派发、给 Agent 什么 |
| [`docs/spec/evidence-discipline.md`](docs/spec/evidence-discipline.md) | finding 怎么写、台账怎么用 |
| [`docs/spec/relay-protocol.md`](docs/spec/relay-protocol.md) | 接力怎么触发、草稿怎么写 |
| [`docs/adr/`](docs/adr/) | 决策记录：为什么是这个形态、为什么降级、为什么提问算投资 |
| [`docs/design/README.md`](docs/design/README.md) | 设计存档索引 —— **全部未实现**，别当能力说明读 |
| [`docs/research/README.md`](docs/research/README.md) | 实测报告索引 + **已被推翻的结论表**（引用前必须查） |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | 按阶段记录的改动流水账（含失败记录与自我失效的判据） |

## ⚖️ 许可与致谢

MIT —— 见 [`LICENSE`](LICENSE)。

- 判据的分级方式（T0 断言 / T1 静态原文 / T2 可重跑 / T3 端到端 / T4 反向对照）来自本项目
  [`docs/spec/2026-11-02-autorelay-acceptance.md`](docs/spec/2026-11-02-autorelay-acceptance.md)，继续沿用。
- 双层工作区（控制层 / 发布层）、四件套证据纪律、工具白名单限写权限这几样结构参考了一个同类项目，
  但**刻意没有照搬**它的 `.gitignore`（它会忽略 `.claude/`、`tasks/`，对本仓库是致命的）。
- 感谢 [Claude Code](https://claude.com/claude-code) 的 hook 接口 —— 没有 `PreToolUse` 与
  `Stop` 这两个可拦截的回调点，这个项目里「闸」的那一半根本无处附着。
