# Overwatch · OmniSight

> **Omni（全）+ Sight（看见），双关 Oversight（监督）。**
> 它看见的不是一个会话，而是所有 AI 对话的全景。
> **Oversight —— 无处不在的监督，而不是无处不在的干预。**

---

## ⚠ 能力边界（先读这一段）

**本库不能自动接力。**

Relay 会产出接力草稿，但**需要你复制并发送**。原因是宿主的注入语义：

> `claude --help` 中 `--bg --resume <session-id>` 的原文：
> continues that session in the background under the same ID, **or starts a copy and says so when the session is already running**

目标会话正在运行时，注入落到副本上，你的窗口里不会出现任何东西。宿主虽有跨会话消息通道（本机 8 个交互会话全部注册了 `messagingSocketPath`），但投递必须标注来源，无法做到「无痕模仿用户」。

**因此本库无法独立满足原始设计稿 §1「会话写入不可降级」的要求。** 我们选择如实声明，而不是假装满足。完整推演见 [ADR-0001](docs/adr/0001-config-only.md) 与 [ADR-0002](docs/adr/0002-honest-degradation.md)。

### 它实际能做什么

**一句话：把 30 个会话压成一张表，并在会话等你时叫醒你。**

| 能 | 不能 |
|---|---|
| 扫描所有会话，压成一张可排序的表 | 实时干预运行中的会话 |
| 透传宿主自己写好的 `needs` / `suggestedReply`（「它在等什么」「建议回什么」） | 自动把回复发进目标会话 |
| 检出写入动作（`Write`/`Edit`/写命令），区分「在改东西」和「在读东西」 | 判断改得对不对 |
| 在会话等你时发桌面通知（宿主 `status: waiting`） | 从「它停了很久」推断失败——**已实测删除该推断** |
| 告诉你它在等什么（`input needed` / `dialog open` / `permission prompt` 等） | 读完普通对话就能知道所有细节 |
| 生成带具体下一步的接力草稿，由你复制发送 | 自动接力 |

**关于「四态」**：代码里确实有 `PRODUCING` / `EXPLORING` / `STALLED` / `FAILED` / `BLOCKED`，但它们在真实数据里极不均衡。2026-10-31 实测 129 个会话的末态：

| 状态 | 命中 | 说明 |
|---|---|---|
| `EXPLORING` | 122 | 绝大多数会话的末态 |
| `PRODUCING` | 4 | 窗口内有真实写入 |
| `BLOCKED` | 2 | 宿主报的，不是推的 |
| `FAILED` | 1 | 宿主报的，不是推的 |
| `WAITING` | 0–1 | 宿主报的实时状态，用户一回话就消失，所以抓不到末态 |
| `STALLED` | **0** | 全语料 56,809 个滑窗里命中 10 次（0.018%），末态从未命中 |

**所以不要把它当「状态机」用。** 它是一张表加一个宿主事实触发器。`STALLED` 已经不参与通知（见下一节），`FAILED` 只认宿主上报。

---

## 30 秒上手

```bash
git clone https://github.com/sqcola/Overwatch.git
cd Overwatch
node scripts/scan-sessions.mjs --days 3
```

输出示例（本机实跑，节选）：

```
OmniSight 会话扫描 · 最近 3 天 · 23 个有活动的会话
liveness: reconstructed（事后重建，非实时上报）

宿主注册的活跃会话 8 个：
  idle  dsh-fcl-android-launcher           可投递(带来源标注)
  busy  OmniSight 跨对话监督调度                  可投递(带来源标注)

[PRODUCING] Projects/Overwatch   calls= 2465 sub=     28 depth=1 novelty=0.96 hb=0s/120s     idle=6s    persistent-change-in-window
[EXPLORING] Server/MCServers/Server/   calls=  185 sub=      0 depth=0 novelty=1.00 hb=91s/900s    idle=326.9h dormant
```

`dormant` 的会话不告警——它们只是结束了，不是坏了。

零依赖，只需 Node ≥ 18。
### 在别处运行

```bash
git clone <repo> && cd Overwatch
node scripts/scan-sessions.mjs --days 3      # 不需要安装，直接能跑
node scripts/watch.mjs --inbox                # 看有没有会话在等你
```

**零依赖**，只要 Node ≥ 18。

想让它常驻并弹通知：

```bash
node scripts/install-watcher.mjs install
```

| 平台 | 开机自启 | 桌面通知 |
|---|---|---|
| Windows | ✓ 启动文件夹 | ✓ Toast |
| macOS | 给出 launchd 配置 | ✗ 退回终端输出 |
| Linux | 给出 systemd user unit | ✗ 退回终端输出 |

没有通知通道时，通知会写进 `runner.log` 并标为正常投递——
**不会静默丢弃**，你可以定期 `--inbox` 看。

#### 同一台机器跑两份

数据目录默认是固定路径（`%LOCALAPPDATA%\Overwatch` / `~/.local/state/overwatch`），
**两份克隆会共用它**。检测到会报 `state-shared` 并把冲突的仓库路径写进日志。
要隔离就显式指定：

```bash
OVERWATCH_STATE_DIR=/path/to/my-state node scripts/watch.mjs
```


---

## 目录地图

```
Overwatch/
├─ .claude/
│  ├─ agents/          12 个角色定义（唯一真源，宿主直接加载）
│  └─ skills/oversight/  调度入口 /oversight
├─ docs/
│  ├─ GUIDE.md         使用手册：你会看到什么、该做什么
│  ├─ CHANGELOG.md     改了什么，按工作阶段记录
│  ├─ spec/            七份规格：状态模型 / 派发契约 / 证据纪律 / 接力协议 / 输出格式 / TUI 视觉 / 原始设计稿
│  └─ adr/             两个决策记录：为什么纯配置库、为什么诚实降级
├─ scripts/
│  ├─ scan-sessions.mjs    「眼睛」：扫描会话并判定状态
│  ├─ watch.mjs            「守夜人」：三层轮询，在会话等你或失败时通知
│  ├─ oversight-tui.mjs    终端界面：列表 / 详情 / 帮助 / 草稿
│  ├─ tui-theme.mjs        状态字形与配色（单一真源）
│  ├─ check-structure.mjs  结构硬门
│  └─ *.test.mjs           190 条回归测试
├─ tasks/
│  ├─ dev-findings.md      范围外发现（不许自行修）
│  └─ accepted-deviations.md  已知不修（不计入判定）
└─ templates/          派发 / 验收标准 / 接力消息 / findings 模板
```

**每个目录都有真实内容，没有占位目录。** `scripts/check-structure.mjs` 会验证这一点。

---

## 三个脚本

| 命令 | 用途 |
|---|---|
| `node scripts/oversight-tui.mjs` | **主界面**。列表 → `Enter` 详情 → `c` 复制接力草稿。非 TTY 自动降级纯文本 |
| `node scripts/scan-sessions.mjs --days 3` | 一次性快照，输出纯文本或 `--json` |
| `node scripts/scan-sessions.mjs --recalibrate --days 7` | 重算 novelty 权重（换机器或工作方式变了就跑一次） |

完整说明见 **[docs/GUIDE.md](docs/GUIDE.md)**。

---

## 核心概念

### 通知只由宿主事实触发

最初的版本会推断：**末次调用间隔超过自适应 p95、且停够 60 秒 → 判 `FAILED`**。

2026-10-31 全语料实测后删掉了这条推断。真实运行发了 5 条通知，**5 条全是它发明的 `FAILED`**——对应的会话在 13 秒 / 151 秒 / 411 秒后继续干活。最离谱的一条，报「失败」时那个会话正在跑 `sleep 240`。

删除后 `NOTIFY_STATES = ['FAILED', 'BLOCKED']`，两者都只认 `~/.claude/jobs/*/state.json` 里宿主写的 `state` 字段。**它不再猜。**

这是我做过的改动里唯一一条「删代码比加代码更有用」的：脚本从「猜 5 次全错」变成「不猜」。

### 状态判定（不是状态机）

代码保留了有序互斥判定，首个命中即返回：

| 状态 | 判据 | 处置 |
|---|---|---|
| `FAILED` | **仅**宿主 `jobs.state === 'failed'` | 全量重跑（唯一允许重跑的状态） |
| `BLOCKED` | **仅**宿主 `jobs.state === 'blocked'` | 看它 `needs` 写了什么 |
| `WAITING` | **仅**宿主 `sessions.status === 'waiting'` | **回它**。`waitingFor` 说明在等什么 |
| `EXPLORING` | 只读工具 / 长期休眠 | **不干预**，只做预算管理 |
| `PRODUCING` | 窗口内有**持久化变更**（`Write`/`Edit`/写命令） | 不干预，等验收 |
| `STALLED` | 连续 3 窗 novelty < 0.2 且无变更 | 实测 0.018% 命中，**不触发通知** |

判定是**有序互斥**的，首个命中即返回。完整定义见 [docs/spec/state-model.md](docs/spec/state-model.md)。

**为什么 `PRODUCING` 只认持久化变更**：`ls` / `grep` / `git status` 都走 Bash，如果把 Bash 一概算作「在产出」，纯探索会被判 `PRODUCING`，状态机没有出口。

### 为什么心跳阈值不是固定值

实测本机 3,354 个 transcript、1,386,846 个调用间隔（2026-10-31 复算）：

- 至少出现一次 >180s 间隔的会话占 **52.7%**
- 全部间隔中 >180s 占 **1.95%**，p95 = 70.7s，p99 = 331.6s

按固定 180s 判失败，一半以上的会话会被误判至少一次。所以阈值取**每个会话自身的 p95**（夹在 120s–900s）。

> ⚠ 这三个数字此前写作「63.1% / 9.72% / p99=1444s」，已确认无法从当前语料复现，上面的数字是重算结果。README 曾长期引用未复算的数字，这正是本次重写的起因之一。

---

## 设计原则

1. **主线程只做三件事**：拆解、派发、汇总。不亲自检索、分析、编码、写作。
2. **锐评与验收是两道独立的门**：锐评管「好不好」，验收管「过不过」。混了就变成一个人的左右手。
3. **只读靠工具白名单，不靠 prompt**：`acceptor` / `review` / `redteam` / `critic` / `safety` / `probe` 的 `tools` 中没有 `Edit`。`check-structure.mjs` 会验证。
4. **禁止静默共识**：多个 Agent 结论相同时，必须至少一个被要求找反面证据。找不到反面证据 ≠ 结论正确。
5. **token 充足不意味着可以跳过辩论**，只意味着辩论可以更深、更狠。
6. **看不见的东西不告警。** 通知只能由宿主事实（`jobs.state`）触发，不由推断触发。宁可漏报，不可误报——误报通知会让人开始忽略通知。

---

## 已知局限（不打算近期修）

这些不是待办，是我知道但选择不做的：

| 局限 | 实测数据 | 为什么不修 |
|---|---|---|
| 在线停止分类基本失效 | 在线路径 **95.4%** 判 `UNCLASSIFIABLE` | 结构性：分类器需要「下一句」才能判断这次停止是问句还是结束，而在线时下一句还没发生 |
| 抑制准确率无法自测 | 无自动测量手段 | 需要人标注「这条通知该不该发」，没有基准 |
| `needs` 覆盖稀疏 | 16 个 job 里只有 2 个带 `needs`、1 个带 `suggestedReply` | 宿主只在阻塞时写，取决于用法 |
| 四态里 `STALLED` 近乎不可达 | 全语料 0.018% | 见上文「状态判定」 |

**够用与否的判断**：如果你要的是「30 个会话里哪个在等我」，够用。如果你要的是「自动接力、自动决策」，**不够用，而且我知道缺什么**——见 [ADR-0001](docs/adr/0001-config-only.md)。

### 关于 `docs/design/` 里的 970 行

仓库里有一批设计文档，描述的是**分级升级、意图契约、自动投递**这些能力。

**它们一行代码都没实现。**

保留是因为里面有实测数据（可代答率 **2.5%**、子 Agent 信号误判 **70.9%** 等），删了要重做。
但**不要按它们实施**——其中「自动投递」在 [ADR-0001](docs/adr/0001-config-only.md) 里已被证明做不到。

逐份状态与「哪节已实现」的对照见 [docs/design/README.md](docs/design/README.md)。

---

## 参考与致谢

目录结构的组织方式参考了 [Let's Learn English](https://github.com/sqkl520/Minecraft-server-plugin-Let-s-learn-English) 的双层工作区模式，但**刻意不照搬**：

- **借鉴**：控制层与发布层分离、四件套证据纪律、两本台账、机器可读的验收标准、agent 工具白名单限制写权限。
- **丢弃**：`versions/` 提交二进制、`tasks/` 占 42% 跟踪文件、`agent-memory` 多份分叉副本、硬编码本机路径、单版本 449 行的 CHANGELOG。
- **警惕**：那个项目的 `.gitignore` 忽略了 `.claude/`、`rules/`、`tasks/`——对它是正确的（只发布 `src/`），对**本仓库是致命的**，照抄会让 `git add -A` 静默什么都不加。`check-structure.mjs` 专门检查这条。

---

## License

MIT
