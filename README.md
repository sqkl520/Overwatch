[English](README-EN.md) | 简体中文

<div align="center">

# UntilDone

**一次给到需求，便一次做完。**

它约束 AI 在动手前把需求问清楚，然后一次做到底 —— 不给你「一轮一个骨架、二轮一层皮毛」。
跨会话监控只是让它能看见「这一轮到底做到哪了」的附属能力。

![CI](https://github.com/sqkl520/UntilDone/actions/workflows/validate.yml/badge.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A518.20.4-blue?style=flat-square)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)
![Tests](https://img.shields.io/badge/regression%20tests-1627%20passing-brightgreen?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

**零依赖** · **不安装** · **不登录也能用** —— `git clone` 之后 `node scripts/overwatch.mjs` 就行

**[⚡ 30 秒上手](#-30-秒上手)** ·
[能力清单](docs/CAPABILITIES.md) ·
[使用手册](docs/GUIDE.md) ·
[问题反馈](https://github.com/sqkl520/UntilDone/issues)

</div>

> ⚠️ **早期项目。** 没有 tag、没有 npm 包，仓库就是发布物。
> 有任何问题欢迎 [提交 Issue](https://github.com/sqkl520/UntilDone/issues)；觉得有用就 Star 一下 ⭐
>
> **本 README 不维护版本号** —— 版本以 [Releases 页](https://github.com/sqkl520/UntilDone/releases) 为准。

---

## ✨ 它解决什么问题

大多数 coding agent 的失败不是「做错了」，而是**提前收工**。一轮只搭个骨架，你追一句，
下一轮再糊一层皮毛 —— 三轮下来代码长得像做完了，实际每一处都停在「能跑」那一档。

根因不在模型能力，在**需求在传递中丢失**。你脑子里有五件事，写进 prompt 剩三件，
模型读出来理解两件半，做完一件就宣布完成 —— 而它宣布完成时，没有任何东西拦住它。

UntilDone 在三个位置各放一道闸：

| 位置 | 闸 | 拦住什么 |
|---|---|---|
| 开工前 | 问清需求 | 「我以为你要的是 X」—— 把歧义在写第一行代码之前暴露 |
| 过程中 | 自拆清单，你确认 | 清单是你认过的，不是它事后编的；缺项在动工前就可见 |
| 收工前 | 逐项核对落盘 | 「说做完了」要能在 transcript 里找到对应工具调用 |

**它保证的不是「你看清有没有做完」，是「它一次做完」。** 前者是把判断成本留给你，
后者才是省下你的时间 —— 这条区别决定了整个产品的形态。

> 现状要说清楚：这三道闸**中间那道还没有实现**，收工闸默认是观测模式（只记账、不拦）。
> 本仓库自己的实测数据显示它拦得住（见[诚实的数字](#-诚实的数字)），但覆盖范围只有两成断言。
> 别把路线图当成现状读。

### 和「跨会话监控」是什么关系

监控是这个框架的**附属能力**，不是产品定义。它存在的理由只有一个：一轮跑很久，
你得知道它到底在推进还是在原地打转 —— 否则「一次做完」就无从判断。

也正因为如此，官方 `claude agents` 已经把「看清有哪些会话」原生做完了，这一点直说：

```
claude agents --json  →  宿主注册了哪些会话，此刻 busy / idle / blocked
scan-sessions.mjs     →  这些会话在干什么、有没有卡住、卡在哪儿
verify-claims.mjs     →  它说的「做完了」，在 transcript 里找得到证据吗
```

**只有第三行是官方没有的**，而它服务的正是上面那道收工闸。

---

## 🚀 30 秒上手

```bash
git clone https://github.com/sqkl520/UntilDone.git
cd UntilDone
node scripts/overwatch.mjs
```

`overwatch.mjs` 是自检：一秒钟内告诉你这台机器能干什么、缺什么、现在有没有任务在跑 ——
**只报读到的事实，不替你判通过。**

```
overwatch doctor · 查 8 项前提 · 预算 1000ms（只查前提，不扫语料）
[   0ms] node        v26.12.1 · 工具下限 18.20.4 满足 · 测试下限 20.16.0 满足
[ 203ms] transcripts <home>/.claude/projects · 71 个（未完）项目 · 415 份 .jsonl（下限）
[  39ms] sources     jobs 11 个 state.json · sessions 15 个 .json
[   2ms] claude/     agents 12 个 · skills 1 个
[  62ms] gate        mode=observe · brake=halt · marker=absent
[ 409ms] watcher     启动器 在 · health 说 未认出
[   1ms] platform    win32 · 桌面通知可用（Toast）
[  80ms] plan        <run-id> · 进度 2/5 完成 · 1 失败 · 2 待认领
合计 795ms / 预算 1000ms —— 前提齐了，可以跑 scan
```

**面板长这样**（`node scripts/oversight-tui.mjs`，真实输出，项目名换成占位）：

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
 项目 B                                              2s  `SendMessageW` 返回 `LRESULT`，需要先转换成 `HICON`。
 项目 C                                             12s  Description 更新成功，但 **Topics 是空的**。
 项目 D                                             28s  守卫实现得很到位（正则覆盖换行/空白）。
```

三处值得看：

- **第一行是判决不是标题**：「1 件在等你」排在最前，「12 个会话在跑」是背景
- **「后台监视 ✗」而不是一个绿勾**：它没在跑，会影响上面那个「1」的可信度，所以直接说
- **「其余 1 项没有发现」而不是「全部正常」**：只报查到的，不替你没查的背书

### 核心命令

```bash
node scripts/scan-sessions.mjs --days 3        # 每个会话一行：状态 / 调用数 / 闲置时长
node scripts/verify-claims.mjs --days 3        # 「AI 说它做完了」有没有证据
node scripts/oversight-tui.mjs                 # 面板：列表 → Enter 详情 → c 复制接力草稿
node scripts/watch.mjs --inbox                 # 谁在等你
node scripts/check-structure.mjs               # 结构硬门
```

每一条能力对应的命令见 [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) —— 硬门会检查那里的脚本与参数真实存在。

---

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
不要把这里的分子分母当成常量引用。

---

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

---

## ⚠️ 已知局限

这些不是待办，是知道但选择不做的：

| 局限 | 实测 | 为什么不修 |
|---|---|---|
| 在线停止分类基本失效 | 在线路径 **95.4%** 判 `UNCLASSIFIABLE` | 结构性：要判这次停止是问句还是结束得看下一句，而在线时下一句还没发生 |
| 通知抑制准确率无法自测 | 无自动测量手段 | 需要人标注「这条该不该发」，没有基准 |
| `needs` 覆盖稀疏 | 16 个 job 里只有 2 个带 `needs`、1 个带 `suggestedReply` | 宿主只在阻塞时写，取决于用法 |
| `STALLED` 近乎不可达 | 全语料 0.018% | 见上文「六种状态」 |

两条和本库无关但影响你怎么用它：

- **多 agent 不是免费的。** Anthropic 自述多 agent 系统比 chat 多烧约 **15×** token，
  且 token 用量单独解释 **80%** 的性能方差 —— 收益主要来自花更多 token，不是架构更聪明。
  MAST 论文（1600+ 轨迹）实测「改进角色规格」和「增强协调」两种干预效果不充分；
  本仓库 `.claude/agents/` 的方法论属于后一类，别指望它能单独把结果变好。
- **扫描是事后重建，不是实时。** 每个文件只读末尾 4 MB，主 transcript 取末尾 1200 条记录。
  要确认某个会话此刻的真实状态，最可靠的办法是打开它看一眼。

**够用与否**：要「这几个会话里哪个在等我、哪个在报假完成」，够用；要「自动接力、自动决策」，
**不够用**，而原因是平台的墙，不是缺一个 feature。

---

## 🔧 为什么不能自动接力

能力边界写在这里，是因为它最容易被误解成「还没做」：

- 宿主的会话是**独立进程**，没有受支持的注入接口。往运行中的会话写东西需要模拟输入，
  而那是平台明确封的路径（实测过 UIA、IPC 管道、CDP 调试端口，全部不可用）。
- 所以本库只能**生成草稿**（`c` 键复制），由你粘贴发送。
- 这不叫「降级」，这叫「如实说平台的边界在哪」。

---

## 📁 目录

```
UntilDone/
├─ .claude/agents/       12 个角色定义（宿主直接加载）
├─ .claude/skills/       调度流程
├─ docs/                 入口 docs/README.md · CAPABILITIES 能力清单 · GUIDE 手册
│                        spec/ 规格 · adr/ 决策 · research/ 实测报告（含状态索引）
│                        design/ 全是未实现的设计推演，状态见 docs/design/README.md
├─ scripts/              scan / watch / verify-claims / stop-verify-hook / TUI / 硬门
└─ tasks/                两本台账：范围外发现、已知偏差
```

新来的人从 [`docs/README.md`](docs/README.md) 开始 —— 它按「你想知道什么」指路，
并说清四类文档的可信度不同（`spec/` 是现行事实、`design/` 全部未实现、`research/` 会过期）。

## 🤝 参与

- 跑测试：`node --test scripts/`（1629 条回归测试；**这个数字由硬门数源码 `test(` 调用对账，写错即红**，
  所以照抄即可、不必手工数。实跑报告会比它多几条 —— 子测试会被单独计数。要 Node ≥ 20.16，因为用了 `import.meta.dirname`）。
- 结构硬门：`node scripts/check-structure.mjs`
- 两条都必须绿才能提交，细节见 [CONTRIBUTING.md](CONTRIBUTING.md)
- 安全报告：**不要开公开 issue**，见 [SECURITY.md](SECURITY.md)

## 📄 License

MIT —— 见 [LICENSE](LICENSE)
