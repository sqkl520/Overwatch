# TUI 重做：诊断、信息架构与任务拆解

> **状态：Proposed（规划产物，零行实现）。**
> 本文件不描述任何已实现能力。系统现在能做什么，读 [README.md](../../README.md) 的「能力边界」。
> 本文件只回答三个问题：**现在的界面为什么答不出用户的问题 / 应该按什么层次重排 / 怎么拆成可派发的任务。**

- 日期：2026-11-05（数据现场重测于 2026-11-09）
- 作者：规划 Agent TP1
- 产出形态：artifact
- 前置输入：用户原话「重做 TUI 界面，贴合实际需求」，并给出五条现场观察（29 行同质、`reason` 无信息、项目名截断、`novelty` 无意义、主问题被埋）
- 用户已定约束：可读本地代码与 dsh-TUI 源码；可用逆向工具读宿主 CLI；**不改现有代码、不碰 git、不跑全量测试**

---

## 零、覆盖声明

**读了（本仓库）**：`README.md`、`CLAUDE.md`、`scripts/oversight-tui.mjs`（全 1201 行）、
`scripts/tui-theme.mjs`（全 350 行）、`docs/spec/tui-visual.md`、`docs/spec/output-format.md`、
`scripts/scan-sessions.mjs` 的 `judgeState` / `readLiveSessions` / `readJobs` / 主扫描循环、
`scripts/watch.mjs` 的 `NOTIFY_STATES` / `HOST_FACT_STATES` / `buildInbox` / `formatInbox` /
`healthCheck` / `BLOCKED_MAX_AGE` / CLI 分支、`scripts/verify-claims.mjs` 的导出面与 `summarizeClaims`、
`scripts/asked.mjs` 的 `scanAll` / `formatResult`、`docs/spec/state-model.md` §8、
`docs/spec/evidence-discipline.md`、`docs/spec/dispatch-contract.md` §1–§5、
`docs/design/README.md`、`templates/dispatch.md`、`scripts/check-structure.mjs` 的四道硬门、
`docs/GUIDE.md` §5（TUI 使用说明）。

**读了（外部）**：`ccch1mneyyy/dsh-TUI` 浅克隆到 `.tmp-analysis/dsh-tui`（1825 个源文件 / 143,772 行）。
重点读 `src/screens/SessionSupervisor.tsx`（1010 行）、`src/components/sessions/SessionListRow.tsx`、
`src/dsh-adapter/agent-view.ts`、`src/components/design-system/{StatusIcon,HintLine,ListItem,Divider,Pane,LoadingState}.tsx`、
`src/components/{listWindow.ts,launchpadLayout.ts,ApprovalPanel.tsx,SubagentDashboard.tsx,ActivityLine.tsx}`、
`src/theme.ts` 的三档配色原则、`src/i18n.ts` 的 `supervisor-*` 文案、`docs/interaction.md`、`README_ZH.md`。

**做了（只读实测）**：`scan-sessions --days 3 --json`（19.3s，29 条）、`--days 9`（39.3s）、`--days 12`（48.5s，148 条）；
`verify-claims --days 3 --json`（7.2s，34 会话 17 条断言）；`asked.mjs --json`（31.8s，241 文件，命中 0）；
`watch.mjs --inbox`（空）、`--health`、`install-watcher.mjs status`；`claude agents --json`（9.4s，14 条）；
只读 `~/.claude/{sessions,jobs,projects}` 的元数据与 transcript 尾部；读 `$LOCALAPPDATA/Overwatch/state.json` 的
`notified` 表（73 条）；用 `oversight-tui.mjs` 的导出函数对真实数据渲染纯文本快照与详情页；
对 `claude.exe`（2.1.x，249 MB）做了**字符串检索**（`esc to interrupt`、`? for shortcuts`、`ctrl+x to stop`、
`Do you want to proceed`、`Yes, and don't ask again`、`Context low`、`Tip: …`、12 个 spinner 动词）。

**没做 / 无法核实**：
- **没有反编译 `claude.exe`**。上条只是字符串命中，能证明「这些文案存在」，不能证明渲染布局。
  本文凡涉及 Claude Code CLI 的界面结论，一律标注为「字符串证据，未验证布局」。
- 没有在 pty 里真跑 dsh-TUI（需要 pnpm 全量依赖）。对它的结论来自源码与文档，不是运行观察。
- 没有跑 `node --test scripts/*.test.mjs`（用户明确要求跳过）。
- 未验证：`claude agents --json` 的两条 `blocked` 会话为何在 `projects/` 里找不到同名 transcript（见 §1.4 D6）。
- 未验证：`verify-claims` 的 84.6% 精度在本次数据上是否依然成立（本轮只统计了档位分布，未人工抽检）。

**环境说明**：读 `$LOCALAPPDATA` 的相关取证用了普通 Node 进程（非虚拟化入口）；
`~/.claude/projects/`、`~/.claude/sessions/`、`~/.claude/jobs/` 均正常读取。

---

## 一、现状诊断

### 1.1 现有屏幕清单

| # | 屏幕 | 入口 | 显示什么 | 行数（真实数据） |
|---|---|---|---|---|
| S1 | 列表 `buildListFrame` | 启动默认 | 标题行 + 列头 + 会话区 + 键位提示 + 状态行 | 恒等于终端高度；30 行终端下会话区 **26 行**，29 条会话需滚动 |
| S2 | 详情 `buildDetailFrame` | `Enter` | 14 个键值对 + 派生树 + `needs` / `suggestedReply` | 实测 67 行（含 51 个 `◇ 子 agent #N`）；补上 `needs`/`suggestedReply` 后 73 行 |
| S3 | 帮助 `helpPanel` | `?` | 键位 + 四态含义长文 + 判定来源说明 | 约 22 行 |
| S4 | 草稿 `buildDraftPanel` | `c` 复制失败时 | 草稿全文 | 动态 |
| S5 | 纯文本快照 `printPlain` | 非 TTY / `--plain` | 同 S1 + 尾部 `needs` 摘要 | 实测 **35 行**（本机 29 条数据） |
| S6 | 首次扫描等待 `pendingLines` | 首屏 0–26s | 已等待秒数 + 「不是卡死」+ 替代命令 | 9 行 |

S6 是这套界面里**唯一一处已经处理好的「空/等待」状态**：它给了预期时长、给了计时、给了替代路径，
并且明确否定了「卡死」这个错误解读（`oversight-tui.mjs:461-475`）。重做时应当把它当作空状态的样板，
而不是重写。

### 1.2 列表页（S1）字段逐个判死

真实数据（`--days 3`，29 条，2026-11-09 重测）：

| 字段 | 实测取值分布 | 用户能否据此改变下一步 | 结论 |
|---|---|---|---|
| `state` | PRODUCING 12 / EXPLORING 17 | **不能**。两类的处置都是「不干预」（`tui-visual.md` §2 处置列自己写的） | **降级**：只保留「要不要我管」二值，不展示六态名 |
| `reason` | `dormant` 16 / `persistent-change-in-window` 12 / `read-only` 1 | **不能**。三种取值是状态名的同义反复 | **删除**，原位换成「一句话为什么」（§3.2） |
| `project`（截断到 24 列） | 29 行 → 18 个不同标签 → **截断后仅 14 个**；`Server/MCServers/Server…` 一行占 5 条 | 不能——5 行完全无法区分 | **替换主键**：改用 `custom-title`（实测 29/29 可得），路径退到第二行 |
| `calls` | 157 … 5142 | 不能。多不等于该管 | **降级**到详情 |
| `novelty` | **17 条恰为 1.00**，其余 0.60–0.96 | 不能。是滑窗去重的中间量 | **删除**（详情的高级区可看） |
| `idle` | 28s … 22.8d | **能**，但被误读：它统计的是「最后一次 tool_use」，不是「文件多久没动」 | **保留并重命名**（`最后动静`），另加「上次真实活动距今」 |
| `liveness` 分布（表头） | `stale=16 reconstructed=13` | 不能。内部数据质量标记 | **从表头移除**，改为全屏只出现一次的数据新鲜度 |
| 逐行状态染色 | 29 行的**状态段**全部上色（`oversight-tui.mjs:999-1009` 只给状态列着色，其余字段无色）。实测这 29 行里 **0 行**属于需动作三类，即 29 段颜色全部无动作含义 | 不能。全彩等于没有重点 | **改为：只有需要动作的行上色** |

**根因不是列太多，是列表答错了问题。** 29 行里真正「活着」的只有 12 条（`scan.live` 12 条，全部 `busy`）；
另外 17 条是 `EXPLORING`：`idle` 从 **28 秒**（一条 `read-only`）到 **22.8 天**，
其中 **9 条超过 3 天**，这 9 条的 `idle` 覆盖 119–547 小时（5.0–22.8 天）。
它们被收进来，是因为 `--days 3` 过滤的是**文件 mtime**（`scan-sessions.mjs:592-594`），
而 transcript 尾部有 `last-prompt` / `custom-title` / `mode` 之类的小记录在不断刷新 mtime。
实测这 9 个文件：`mtime` 距今 **4.7–22.8 小时**，`idleSec` 却是 **5.0–22.8 天**——
两个数差 **5 倍到 116 倍**（逐条：116 / 110 / 70 / 37 / 11 / 10 / 9 / 9 / 5）。

所以「29 行全是同一类」的准确说法是：**界面把「三天内文件被动过」当成了「三天内有会话在跑」**，
于是把 17 条历史当成现状铺在用户面前。

### 1.3 详情页（S2）的浪费

对一个有 51 个子 agent 的会话，`detailLines` 输出 67 行（补上 `needs` / `suggestedReply` 后是 73 行），
其中 **51 行**是：

```
  │ ◇ 子 agent #1
  ...
  │ ◇ 子 agent #51
```

而每行都标注「节点字形 ◇ 表示该节点状态未由 scan --json 暴露」——
**即 51 行全部是「我不知道」**。派生树从第 15 行开始，占 53 行；真正该看的 `needs` 落在**第 69 行**（共 73 行），
`建议回复` 在第 72 行。在 30 行高的终端里，用户要按 40 次 `j` 才能看到「它在等什么」。

详情页另有两个问题：
- `novelty`、`noveltyAll`、`hbThresholdSec`、`lastGapSec`、`liveness`、`calls` 与「我要不要现在处理它」无关，
  却与 `state`、`reason` 同权重排列；
- 没有**证据区**。产品唯一的差异点（`verify-claims`）在界面上**完全不存在**：
  `grep -n "verify-claims\|verifyClaims" scripts/oversight-tui.mjs` 返回空。界面只 import 了 `tui-theme`。

### 1.4 六条实测缺陷（有行号，供修复任务用）

| # | 现象 | 证据 | 影响 |
|---|---|---|---|
| D1 | 从宿主 live 状态补进来的行，项目名在 Windows 上变成完整路径 | `oversight-tui.mjs:659-660`：`base.split(/[\/]/).pop()` 只切 `/`，不切 `\`。实测 `liveToRow({cwd:'D:\\…\\testharness'})` → `project` 为整条路径；同一函数给 POSIX 路径则正确返回 `overwatch` | 最该被看见的那几类（WAITING/BLOCKED/FAILED 且无 transcript）恰好在这条路上 |
| D2 | 唯一可用的动作键在本机数据上是死的 | 29 条里 `needs=0`、`suggestedReply=0`。`buildDraft` 返回 `null`，按 `c` 得到「该会话没有 needs / suggestedReply，无草稿可复制」 | 界面的唯一动词在真实数据上 0 命中 |
| D3 | 「空」不可信 | `watch.mjs --inbox` 输出「收件箱：空」；同一时刻 `install-watcher.mjs status` 判定 jobs/probe **8.2 / 8.3 小时未运行** | 空收件箱有两种成因（真的没事 / 监视没跑），界面不区分 |
| D4 | `state` 命名与用户心智不一致 | `tui-theme.mjs` 的六态里，`PRODUCING` 的处置是「不干预，等验收」，`EXPLORING` 是「不干预，严禁重跑」 | 12 + 17 行共用「不干预」，用户读到的是「29 条都要关注」 |
| D5 | `WAITING` 的 `brightYellow` 不在 SGR 表里 | `tui-theme.mjs:21-29` 的 `SGR` 无 `brightYellow`；`paint()` 遇未知色名**原样返回**。实测 `badge('WAITING', true)` → `"! WAITING"`，**0 个 ESC**，其余五态均 2 个 | 「最需要人处理」的态反而没有颜色，且不会报错 |
| D6 | 两个 `blocked` 会话在三源里各说各话 | `claude agents --json` 给 14 条，含 2 条 `blocked`（`a9fa4c62`、`7710fbdb`）；这两条 **既不在** `scan.sessions`，**也不在** `scan.live`。`a9fa4c62` 的 `linkScanPath` 指向 `af6779f8`，而 `af6779f8` 的 transcript 存在但 mtime 是 7.9 天前（超过 `--days 3` 窗口）；`7710fbdb` 的 transcript 在 `projects/` 下完全找不到 | 同一台机器上「有没有事」，三个数据源给出三个答案 |

D5 与 D6 之所以重要，是因为它们正落在「主问题」上：最该亮的东西没亮（D5），
最该被报的东西没被报（D6）。

### 1.5 缺失但用户需要的信息

| 缺什么 | 为什么需要 | 数据在哪（已实测可得） |
|---|---|---|
| **会话标题** | 项目目录名无法区分同名任务；实测 5 行同名 | transcript 的 `custom-title` / `agent-name`，**29/29 可取**；末条距 EOF 最远 **32 KB**（字节精确测量），128 KB 读取窗口 29/29 覆盖 |
| **它在做什么（一句话）** | 替代 `reason` 列的唯一候选 | transcript 尾部最后一条 assistant 文本，**29/29 可取**；读 128 KB × 29 条 = **92 ms** |
| **它是否真的在等** | `needs` 覆盖稀疏（本机 0/29），不能只靠它 | `watch.mjs` 的 `buildInbox`（历史 × 宿主现状交集）+ `asked.mjs`（问句未答） |
| **完成声明是否站得住** | 产品唯一差异点，界面上完全没有 | `verify-claims --days 3 --json`：34 会话 17 条断言，本轮 **FAILED_ONLY 1 / STALE_ONLY 5 / NO_EVIDENCE 1 / UNKNOWN 2**（7.2s） |
| **数据有多新、监视是否在跑** | 决定「空」能不能信 | `state.json` 的 `lastJobsScanAt` / `lastProbeAt` + `healthCheck` |
| **同名会话的去歧义信息** | 21 个不同标题里，4 个标题各占 2–4 条 | `cwd`（transcript 里 29/29 有）、`branch`、最后活动时间 |

---

## 二、信息架构

### 2.1 一句话

> **默认屏回答的是「有没有事」，不是「有哪些会话」。列表是第二屏，而且只属于「已经活着的那些」。**

现在的设计把「全景」和「待办」压进同一张表，结果两件事都没答好：
主问题（我该做什么）被 17 条历史稀释，次问题（整体健康度）被 29 行的同质化噪声污染。
新架构把二者**分层而不是并列**：第一行永远是判决，第二屏才是清单。

### 2.2 七条排序规则（可逐条验收）

| # | 规则 | 反例（现在的做法） |
|---|---|---|
| P0 | **一屏一问题**。每个屏幕只回答一个问题；列表屏回答「有没有事」，不回答「有哪些会话」 | S1 同时回答状态、项目、调用数、novelty、空闲时长、reason |
| P1 | **三段分区**：`需动作` / `在跑` / `已停`。段顺序即优先级；段标题自带计数；**空段不画**（画一个 0 行标题就是噪声） | 六态混排成一列，靠状态名区分，用户要自己数 |
| P2 | **主问题常驻**。状态行第一位永远是「N 件在等你」，不是「N 个会话」 | `statusLine` 第一位是 `${sessions.length} 会话`（`oversight-tui.mjs:485`） |
| P3 | **一行一事实**。任何可见字段必须能改变用户的下一步；不能改变的进「高级区」（详情页按 `i` 才出现） | `calls` / `novelty` / `liveness` 与 `state` 同权重 |
| P4 | **身份优先于状态**。标题 > 短路径 > 完整 cwd；同名时用路径尾段 + 最后活动时间去歧义 | 24 列截断后的目录名，5 行完全一样 |
| P5 | **空状态必须自证**（见 §2.6） | 状态行只在计数全零时写「无异常」，没有任何来源 |
| P6 | **不提供假按钮**。没有草稿就没有 `c`；按下去要明说「没有」，并给出真实可做的替代 | `HINT_LIST` 无条件写 `c 复制草稿`（`oversight-tui.mjs:54`） |
| P7 | **窄屏先撤解释，后撤动作**。撤除顺序必须显式声明，动作列永不撤 | 现有 `showCalls/showNov/showIdle/showReason` 是「按宽度逐个砍尾部」，没声明谁更重要 |

### 2.3 屏幕层次

```
L0  判决行        ← 永远是第 1 行（1 行）
L1  检查表        ← 「有没有事」凭什么成立（≤4 行）
L2  需动作区      ← 0..N 行，空则不画
L3  在跑区        ← 只含活着且有 transcript 的会话
L4  已停区        ← 一行计数，按 h 展开成列表
L5  详情（Enter）  ← 身份 / 状态 / 最近说 / 证据；按 i 展开内部量
L6  高级与证据     ← novelty、calls、liveness、派生树计数、verify-claims 原文
```

### 2.4 屏幕草图

以下草图按 **76 列**设计（80 列终端留 2 列页边距仍有富余）。
**验收要求：草图中每一行的显示宽度 ≤ 78（CJK 按 2 列算）**——已用 `displayWidth` 逐行量过，
实测最宽 72 列（A 66 / B 72 / C 67）。

> 草图的**计数是真的**（0 件在等、12 在跑、17 已停、1 条声明对不上、监视 8.2h 未运行），
> 取自 2026-11-09 本机实测；**标题与摘要文字是占位**，用来说明版式，不是对该会话的描述。
> 唯一例外：草图 B 的两条 `needs` 原文取自 `~/.claude/jobs/` 里的真实值（`7710fbdb` 与 `a9fa4c62`）。

#### A. 全部正常（本机此刻的真实状态）

```
 0 件在等你 · 12 个会话在跑 · 17 个已停              8 秒前扫描

 声明对不上  ✗ 1 条完成声明无证据支持 · d 看证据
 后台监视    ✗ 监视未在跑（jobs 8.2h / probe 8.3h 未更新） · 先修这个

 在跑 (12)                                    最后动静   近
 ❯ OmniSight                  Overwatch         8s    改 TUI 规格
   PerfScope 多 agent 工作流    MCServers        6s    跑 mvn test
   shapez                     rea/shapez        17s    ...
   ...                                          12 条，j/k 移动
 已停 (17)  28 秒–22.8 天前 · h 展开 · 大部分是历史

 1 条声明对不上 · 数据来自 8s 前的扫描 · 监视未在跑      ? 帮助
```

> **2026-11-11 修订**：原草图这里是一张带 `检查了什么 / 结论` 表头的四行表，
> 下面还有两行 `→ 0 个`。逆向 Claude Code CLI 后改了形态
> （`docs/research/2026-11-11-claude-status-block-reverse.md` §3，
> 落地记录 `docs/research/2026-11-11-tui-checklist-redesign.md`）：
> **删掉元表头；没有发现的检查项不占行，被压掉的项数进收尾句；四项全清白时只留一句
> `✓ 4 项检查都清白 · 监视在跑`**。四条数据源本身一条没砍。

三处刻意的设计：

1. **第 1 行是判决，不是计数。** 「0 件在等你」放在最前；「12 个会话在跑」是补充。
2. **检查区回答「凭什么说没事」。** 四行对应四种证据源；有事的逐行给断言 + 出路，
   没事的压成一句，**绝不留空白**（空白会让「全清白」与「没查」同形）。
3. **最后一行是健康度而不是键位提示。** 键位在 `?` 里；状态行的位置留给「你还该知道的一件事」。
   这里它说的是「后台监视没在跑」——这比任何一行会话都更该被看见（D3）。

> **A 与 B 不是同一时刻的两个快照，是同一个数据在同一判据下的两种结果。**
> A = 只信 `scan`（29 条：12 跑 + 17 停，0 件待办）；
> B = 加上 `claude agents --json` 才发现的两条 `blocked`（§1.4 D6）。
> 这正是「多源合并」在图上的样子：**A 看起来完全健康，而它是错的。**

#### B. 有待处理项

```
 2 件在等你 · 最早一件等了 3 小时 42 分            12 秒前扫描

 在这里回应                                       等了     怎么回
 ❯ Hilltop Village 优化   Hilltop Village          3h42m   c 复制回复
   API unavailable — retry · API Error: 503
   保留数据 root 手机      work/mobile phone        18m     Enter 看原文
   要我现在就把用户实测单交给你，还是你先看这四份测试报告？

 在跑 10 · 已停 17 · 1 条声明对不上 (d)                 ? 帮助
```

- 每行两块：**身份 + 等了多久 + 怎么回**（上），**它在等什么（逐字，不摘要）**（下）。
  逐字是 `relay-protocol.md` §5.1 的硬要求，界面不得代为概括。
- 第二行没有 `suggestedReply` 时，动作列必须写 `Enter 看原文`，**不能写 `c`**（P6）。
- 只有这一段上色（`yellow` / `red`），其余行一律无色——这才是颜色该有的强调作用（§3.3）。

#### C. 详情视图

```
 OmniSight · Overwatch · 2/12                              Esc 返回

 状态    ● 在跑（宿主 busy）· 最后工具调用 8 秒前 · 窗口内 3 次写入
 身份    Overwatch · …/Projects/Overwatch · ea4ef562
 最近说  「改完 TUI 规格了，等你拍板要不要拆任务。」
 证据    1 条完成声明 · FAILED_ONLY
         「分拣提交完成，三个 commit 已推送。」
         最后一次编辑之后 0 次成功推送，3 次失败      d 看完整链
 ── 按 i 显示内部量 ──────────────────────────────────────────────
 novelty 0.92 / noveltyAll 0.94 · calls 748 · 派生 51 个（无状态）
 liveness reconstructed · 心跳阈值 900s · hostState null
```

- 首屏只放**能改变动作**的四块：状态、身份、最近说、证据。
- 51 个子 agent 压成一行计数。按 `e` 才展开，且展开时明确「这 N 个节点的状态 scan 拿不到」。
- `novelty` 仍然存在，但在折叠区里，且**不再逐位小数展示**（0.92 与 0.94 的差别没有动作含义）。

#### D. 窄屏降级阶梯（60 列，必须显式声明）

撤除顺序（从最可省到最不可省），**与 dsh-TUI 的 `launchpadLayout` 同一思想，但按我们自己的字段重排**：

```
① 撤「近」列（一句话摘要）        —— 最可省：它是辅助信息
② 撤「已停」段标题与计数          —— 折叠成状态行里的一个数字
③ 撤检查表的「来源」列            —— 只留结论，来源进详情
④ 撤路径副行                      —— 只留标题
⑤ 撤「等了多久」                  —— 但「需动作」段整段永不撤
⑥ 只留：判决行 + 需动作段 + 状态行 —— 最矮的终端也要能回答「有没有事」
```

**永不撤除的三样**：判决行（L0）、需动作段（L2）、动作列（`c` / `Enter`）。
理由：把动作撤掉等于把界面变成一个只读报表，而本产品的全部价值在于「谁在等你」。

### 2.5 字段 → 屏幕矩阵

| 字段 | 来源 | L0 | L2 | L3 | L5 首屏 | L6 高级 | 处理 |
|---|---|---|---|---|---|---|---|
| 需动作计数 | inbox 交集 | ● | — | — | — | — | 新增聚合 |
| 标题 | transcript `custom-title` | — | ● | ● | ● | — | 新增读取 |
| 最后一条 assistant 文本 | transcript 尾部 | — | ● | ● | ● | — | 新增读取 |
| `needs` / `suggestedReply` | jobs | — | ● | — | ● | — | 上位到动作列 |
| `verify-claims` 档位 | 独立脚本 | ● | ● | — | ● | ● | **新增接入** |
| `healthCheck` 结果 | watch | ● | — | — | — | — | 新增接入 |
| `state` | scan | 二值 | ● | ● | ● | — | 六态降二值 |
| `idleSec` | scan | — | ● | ● | ● | — | 改名「最后动静」 |
| `project` | scan | — | 副行 | 副行 | 副行 | — | 降为副行 |
| `cwd` | live / transcript | — | — | — | ● | — | 去歧义用 |
| `reason` | scan | — | — | — | — | — | **删除** |
| `novelty` / `noveltyAll` | scan | — | — | — | — | ● | 降级 |
| `calls` | scan | — | — | — | — | ● | 降级 |
| `liveness` | scan | — | — | — | — | ● | 降级（新鲜度在 L0 出现一次） |
| `hbThresholdSec` / `lastGapSec` | scan | — | — | — | — | ● | 降级 |
| `subagents*` / `maxDepth` | scan | — | — | — | 计数 | 展开 | 51 行占位 → 1 行 |
| `tokens` / `badLines` | scan | — | — | — | — | ● | 降级 |
| 扫描时刻 | scan `generatedAt` | ● | — | — | — | — | 上位 |

规则：**L0/L2 出现的字段必须能改变动作；否则一律下沉到 L5/L6。**
按这张表，列表页的可见字段从 7 个降到 3–4 个，而「需动作」段从 0 个信息量变成 4 个。

### 2.6 「没有异常」时界面长什么样（最难的一种状态）

这不是排版问题，是**诚实性问题**。现状：没有异常时状态行写 `无异常`（`stateCounts()` 返回空串时替换），
而这句话没有任何证据支撑。同类失效在本仓库已经发生过一次——`buildInbox` 的注释写得很清楚：
`state.notified` 是历史表不是现状表，直接当收件箱会撒谎（`watch.mjs:2314-2316`）。

所以空状态必须携带**三件事**：

| 要素 | 为什么必须 | 现在的数据 |
|---|---|---|
| **检查了什么**（4 项，逐项写来源） | 否则用户不知道「空」是全绿还是漏检 | inbox / asked / verify-claims / health，各自可单独跑 |
| **数据有多新** | 扫描是事后重建，可能已过期 | `scan.generatedAt`，实测 8 秒–19 秒的 scan 耗时决定它 |
| **监视是否在跑** | 后台不动 = 「空」这件事本身不可信 | `healthCheck`：本机实测 8.2h / 8.3h 未运行 |

并且：**空状态不得使用「无异常」「一切正常」这类断言词**。
可用句式：「没有需要你处理的会话」，后面紧跟检查表。断言要能被推翻，措辞就必须能被推翻。

第三种状态也必须区分（现在混在一起）：

| 状态 | 界面应该长什么样 | 现状 |
|---|---|---|
| 首扫中（0–26s） | S6 的等待页（已做好） | ✅ |
| 扫完，确实没事 | 检查表全 0 + 健康度 | ❌ 只有「无异常」三个字 |
| 扫完，但监视没跑 | **检查表打 ✗，并把「修监视」放到第一屏** | ❌ 与上者无法区分 |
| 扫描失败 | 保留现有 `⚠` 警告 + 原因 | ✅ 基本可用 |

---

## 三、从 dsh-TUI 能学什么

### 3.1 它是什么（先划清界限）

| 维度 | dsh-TUI | 我们 |
|---|---|---|
| 定位 | 聊天主界面的替代 TUI（持续交互） | 巡检面板（每次看几秒） |
| 规模 | 1825 个源文件 / 143,772 行 / `src` 15 MB | 1 个文件 1201 行 + 1 个主题文件 350 行 |
| 栈 | React + Ink + pnpm + 24 套主题 + 插件系统 | **零 npm 依赖**，只用 `node:` 内置（`README.md` 第 5 行） |
| 输入 | 鼠标、粘贴、图片、立绘、动画、真彩色 | 键盘、纯文本、8 色 |

结论：**抄交互契约与判断规则，不抄实现栈。** 任何要求引入 Ink/React 的方案都直接违反产品的
第一条承诺（不安装、不登录、不配置），必须否决。

### 3.2 它的信息组织方式（可抄的部分最多）

1. **一个域只留一个界面。** `SessionSupervisor.tsx` 的注释原文：「Those were three screens over one domain,
   which is why they kept needing patches to agree with each other.」——`/resume`、`/agentview`、`/home`
   三个入口收敛成一个屏（`SessionSupervisor.tsx:37-46`）。
   **对我们的直接含义**：列表 / 详情 / 收件箱 / 已停 不该是四个并列视图，而是一个有层次的界面；
   否则它们会像本仓库的「两条展示路径」那样分叉——`oversight-tui.mjs:692-698` 记着这个教训的原版
   （DF-012 / DF-017：改了 `App.sessions()` 却漏了 `printPlain`）。

2. **分栏 = 稳定分区，不是布局炫技。** 左侧工作区栏 + 右侧会话列表 + 每行自己的 live 状态；
   窄屏时栏位整体让位（`railVisible`），而不是把两栏压成一栏。
   **可抄**：我们的「需动作 / 在跑 / 已停」三段可以用同样的「分区 + 让位」处理，而不是用排序混排。

3. **优先级写在排序函数里，且可被测试。** `AGENT_VIEW_STATUS_ORDER = ['needs-input','working','failed',
   'completed','idle','stopped']`（`agent-view.ts:15-17`），一条常量就是产品优先级。
   **可抄**：我们的 `STATE_ORDER` 应该改成**动作优先级**（需回应 > 跑着 > 已停），
   并且像它一样是一行可读常量，而不是散在渲染里的 `if`。

4. **主问题在别处也常驻。** 聊天页底部的 `← N 个会话等待输入`（`i18n.ts:1299`），
   用户不打开列表就知道有几件事。这是「主问题不能被淹」的另一种解法：**在不相关的屏幕上放一个数字**。
   **可抄**：我们的 `--inbox` 与 `install-watcher` 输出已经能做到，TUI 只是没接。

5. **一句话摘要分四种来源并标注来源。** `summaryKind: 'none'|'prompt'|'tool'|'assistant'`
   （`agent-view.ts:60-75`），摘要按「assistant 文本 > 工具名 > 首条提示」降级，且**知道自己是哪一种**。
   **强烈建议抄**：这正是替换 `reason` 列的机制。我们用它填「近」这一列，并且必须标注来源
   （`近:` 表示来自 transcript 尾部，不是权威状态），避免读者把它当成状态判定。

6. **空状态不是一个字符串，是一组位置。** 列表为空时，`+ 新建会话` 卡片仍占第 0 行，
   注释写明理由：「It is also the only affordance that works when the pane is EMPTY,
   which is exactly when the list has nothing to offer.」（`SessionSupervisor.tsx:760-767`）
   **可抄**：我们空状态里「修监视」这一行就是同一个位置——**空的时候，唯一能做的事必须还在屏幕上**。

### 3.3 它的视觉语言

| 做法 | dsh-TUI 的原话 / 证据 | 判定 |
|---|---|---|
| **正文一律黑白灰，彩色只给特殊文字** | `theme.ts:414-416`：「正文类文字一律黑白灰…彩色只留给特殊文字——品牌橙、工具蓝、成功绿、警示沙、错误赤」；Codex 档更狠：「90% 黑白灰 / 8% 紫 / 2% 功能色」（`theme.ts:689-693`） | **抄**。直接解决我们「29 行全彩 = 没有重点」 |
| **两行行高，标题与事实分行** | `SessionListRow.tsx:61-66`：「Two lines rather than one because the two carry different jobs… on a narrow terminal the title is what loses」 | **抄**。一行塞标题 + 事实，窄屏必先丢标题 |
| **状态列宽度恒定** | `SessionListRow.tsx:134-140`：「The state cell holds EXACTLY two columns on every row… a column that appears only when a session is busy would shift every title on screen」 | **抄**。我们现在的 `stateColumn` 是 `padEnd(9)` 定宽，这条已经做对，别改坏 |
| **动作状态用动画，静止状态不画** | 只有 `working` 才订阅动画帧（`SessionListRow.tsx:42-50`：`useAnimationFrame(focused ? 120 : null)`）；空闲行不 tick | **不抄**（我们是 8 秒轮询的快照，动画会让人以为它是实时的，反而撒谎） |
| **字形必须考虑字体覆盖** | `tui-visual.md` §3.1 已有一条更严的实测规则（conhost 豆腐块，`✕`/`◐` 被 `×`/`○` 取代） | **保留我们自己的规则**。它比 dsh 的 `✻/✽/∙` 更保守，因为我们的用户可能是 conhost |
| **渐变色 / 板块背景色 / 24 套主题** | `theme.ts` 有 100+ 语义色键、明暗双档、品牌切换 | **不抄**。零依赖 + 8 色终端 + `NO_COLOR` 是硬约束（`tui-visual.md` §4） |
| **页边距自备一层（PageMargin）** | `PageMargin.tsx:12-24`：终端 padding 不可读，所以根布局自备 2 列 / 1 行 | **可抄**（低成本）：我们现在内容贴左边缘，加 1–2 列缩进会显著提升可扫读性 |

### 3.4 它的交互模型

| 键位 / 机制 | 行为 | 我们是否采用 |
|---|---|---|
| `←/→` | 切换栏位（工作区栏 ↔ 会话列表） | **采用**，改成「段间移动」（需动作 ↔ 在跑 ↔ 已停） |
| `↑/↓`、`PgUp/PgDn`、滚轮 | 移动 / 翻页 | 采用（我们已有 `j/k`，保留并加 `PgUp/PgDn`——已被 `parseKeysWithRest` 支持，只是列表页没接） |
| **直接打字即过滤**（无 `/` 前缀） | 任何未被占用的可打印字符进入过滤 | **采用**。29 条时过滤是刚需，现在完全没有 |
| **`HintLine` 动态显示当前可用键** | 每屏只显示此刻能用的键，主键加粗（`HintLine.tsx` 解析 `**…**`） | **采用**。现在的 `HINT_LIST` 是常量，在草稿面板 / 帮手上都不变，属于撒谎 |
| `Enter` | 当前栏位的「默认动作」 | 采用；但必须与「选中哪一行」同源（`sessionIndex` 的注释：`Enter can only ever open the row the user is looking at`） |
| `Esc` 分层退出 | 关帮助 → 关预览 → 退出过滤 → 中断 | **采用简化版**：过滤态 `Esc` 清空 → 列表态 `Esc` 回到 L0 |
| `?` 帮助 | 只列键位与一句话说明 | 采用，但**把四态长文移出帮助** |
| 鼠标 / 悬停 tooltip / 右键菜单 | 全屏模式下的完整指针支持 | **不抄**。我们没有鼠标解析，加它=重写 `parseKeys` 与全部布局 |
| `Ctrl+B` 侧栏、`Ctrl+O` 详情、`Ctrl+T` 轨迹 | 多面板 | **不抄**。面板系统是 4000+ 行的东西，我们的屏只有 1 个 |

### 3.5 明确不能抄的五条（附理由）

| 不能抄 | 理由（针对本仓库，不是针对 dsh） |
|---|---|
| React / Ink / 任何 npm 依赖 | 违反 `README.md` 第一条承诺与 ADR-0001 的零依赖边界；`check-structure.mjs` 也是按「无 package.json」假设的 |
| 立绘 / 像素鲸鱼 / 3 段开场动画 | 巡检面板每次只看几秒；动画会被误读成「实时」——而 README 明确写了「扫描是事后重建，不是实时」 |
| 24 套主题 + 品牌切换 | 我们是 8 色 + `NO_COLOR`；主题系统会让 `tui-theme.test.mjs` 的「三通道」保证失效 |
| 15 万字 i18n 字典 | 我们只有 1 种输出语言；文案表反而会成为「改了界面忘了改文案」的新分叉点 |
| 「一个域只留一个界面」的**规模** | 它合并的是 `/resume` `/agentview` `/home` 三个**同质**入口；我们没有三个入口，不能为了统一而增加入口 |

---

## 四、任务拆解

### 4.1 依赖图

```
        T1 数据契约 ─────────────┐
        T2 IA 规格 ──────────────┤
        T3 四源真值核对 ─────────┼──► T7 实现（串行，最后）
        T4 视觉与降级阶梯 ───────┤
        T5 键盘与交互 ───────────┤
        T6 红队（攻击本规划）────┘（结论必须回灌 T2/T4，不得由执行者自评）
```

- **T1–T6 可并行**（T6 必须与其余五个同时派发，且**不读它们的产出**）。
- **T7 必须串行**，且必须在 T2/T4/T5 收口、T6 的攻击清单被裁决之后才开始。
- 递归深度：本层 1，不再派生（理由：六个任务的输入都是同一份规划 + 同一批实测数据，再拆一层只会增加协调成本）。

### 4.2 任务卡

#### T1 数据契约与身份模型

```
任务名：TUI 数据契约（四源合并、身份去歧义、字段可用性）
产出形态：artifact
角色：执行（executor，只读 + 写一份文档）
输入：本文件 §1、§2.5；scripts/scan-sessions.mjs；scripts/watch.mjs 的 buildInbox/healthCheck；
      scripts/verify-claims.mjs 的导出；scripts/asked.mjs；claude agents --json 的字段表
必须回答：
  1. 「有没有事」这一判决，最少需要哪几个数据源？每个源的代价（实测耗时）是多少？
  2. 四个源之间 sessionId 对不上时怎么处理？（已知 D6：两个 blocked 在 scan 与 live 里都不存在）
  3. 标题、cwd、最后一条 assistant 文本，从 transcript 取的最小读取量是多少？缓存键是什么？
  4. 同一会话的「需动作」有多个来源矛盾时（如 inbox 说有、live 说 busy），以谁为准？为什么？
  5. 8 秒轮询下，新增读取（标题/摘要/证据）的预算上限是多少 ms？
产出物路径：docs/design/2026-11-05-tui-data-contract.md
验收标准：
  AC1 每个被选中的字段都必须给出「来源文件:行号」与「本机实测的可取率」（如 29/29），
      并附一条可复跑的命令与它的输出。
  AC2 必须给出一个字段可用性表：字段 × 来源 × 实测可取率 × 单次读取字节数 × 全量耗时。
  AC3 必须显式列出「哪个源不可信、为什么、界面怎么对待它」，至少覆盖 D3 与 D6。
  fail_if：出现任何未标注来源的数字；宣称某字段「一般都有」而无实测；把推测写成结论。
依赖：无（可并行）
```

#### T2 信息架构规格

```
任务名：IA 规格（把本文件的七条规则写成可验收的规格）
产出形态：artifact
角色：执行（executor）
输入：本文件 §2 全文；docs/spec/output-format.md；docs/spec/tui-visual.md；templates/acceptance-criteria.md
必须回答：
  1. 每个屏幕的「一屏一问题」分别是什么？写出这一句话。
  2. 字段 → 屏幕矩阵的每一格，理由必须能回答「不放在这里会怎样」。
  3. 三段分区（需动作/在跑/已停）的边界判据是什么？「已停」与「需动作」会不会重叠？重叠时归哪段？
  4. 空状态四种形态（首扫/全绿/监视未跑/扫描失败）的**逐字文案**是什么？
  5. 76/60/40 列三档，每档的撤块顺序与剩余内容，逐档给出截图级草图。
产出物路径：docs/spec/2026-11-05-tui-ia.md（**规格区**，不是 design 区）
验收标准：
  AC1 每张草图的所有行，按 displayWidth 计算 ≤ 该档宽度；必须附统计脚本与输出。
  AC2 空状态文案必须包含「检查了什么 / 数据多新 / 监视是否在跑」三要素，缺一 fail。
  AC3 文案里不得出现「无异常」「一切正常」「已全面检查」三者之一；用 grep 验证并附输出。
  AC4 每个字段在矩阵里只出现一次主位；重复出现必须在该行写理由。
  fail_if：草图超宽；空状态只有一句话；任何一条规则无法用机器检查。
依赖：可与 T1 并行；收口时字段名必须与 T1 对齐（若冲突，以 T1 的实测为准并回写本规格）
```

#### T3 四源真值核对（exploration）

```
任务名：「空」到底可不可信 —— 四源交叉核对
产出形态：exploration
角色：检索（research，只读，不写代码）
输入：本文件 §1.4 D3/D6；scripts/watch.mjs 的 buildInbox / healthCheck；install-watcher.mjs status；
      claude agents --json；verify-claims --days 3 --json
必须回答：
  1. 同时在 4 个源里对比「需要人处理的会话」：inbox / scan / claude agents / verify-claims。
     给出交集、差集、以及每个差集的成因（要能指到代码行）。
  2. D6 那两条 blocked（a9fa4c62 / 7710fbdb）到底是什么？为什么 transcript 找不到？
     它们的 `needs` 还成立吗？给出去歧义的判据。
  3. 本机现在「监视没在跑」持续了多久？`healthCheck` 的判定阈值是多少？（读 HEALTH_PERIODS）
  4. 「空收件箱」在什么条件下是可信的？给出一个可机械检查的三条合取条件。
  5. TUI 应该在什么条件下拒绝显示「0 件在等你」，而改显示「无法确认」？
产出物路径：docs/research/2026-11-05-tui-truth-sources.md
验收标准：
  AC1 每个差集条目必须能复跑复现（附命令 + 输出片段）。
  AC2 第 4 问的答案必须写成三段可判定的布尔表达式，不得是散文。
  AC3 必须有一节「我无法核实的部分」，且不得为空（这是 exploration，允许有未知）。
  fail_if：把「收件箱空」直接等同于「没事」；对 D6 给出没有证据的猜测。
依赖：无
```

#### T4 视觉语言与降级阶梯

```
任务名：视觉规格（黑白灰 + 点睛、双行行高、撤块阶梯、字形实测）
产出形态：artifact
角色：执行（executor；需要真终端验证的部分标出并留给验证 Agent）
输入：scripts/tui-theme.mjs 全文；docs/spec/tui-visual.md 全文；
      .tmp-analysis/dsh-tui/src/theme.ts（三档配色原则）、SessionListRow.tsx（双行与定宽列）、
      launchpadLayout.ts（撤块阶梯）
必须回答：
  1. 新的「强调预算」：一屏最多几处着色？色相如何映射到「需动作/在跑/已停」？
  2. D5（WAITING 的 brightYellow 不在 SGR 表里，实测 0 个 ESC）怎么修？修完如何负向测试？
  3. 双行行高在 40 列时怎么降级？标题与「近」谁先让？
  4. 新引入的字形（若有）必须过 `tui-visual.md` §3.1 的三项验证（cmap / 真实终端 / 1 列）。
     没条件验证的字形一律不准引入。
  5. 灰度下（去色）三种段落靠什么区分？（必须仍是形状/缩进/文字，不是颜色）
产出物路径：docs/spec/2026-11-05-tui-visual-v2.md
验收标准：
  AC1 每个新字形都有一行「验证方式 + 结果」，缺验证的字形数为 0。
  AC2 必须给出「关色后信息量不减少」的论证：逐段落列出灰度下的区分手段。
  AC3 撤块阶梯必须是编号列表，且最后一条明确写出「永不撤除」的三样。
  fail_if：引入需要 npm 依赖的字形/图标库；用颜色作为唯一区分手段。
依赖：可与 T2 并行（T2 定结构，T4 定皮）
```

#### T5 键盘与交互模型

```
任务名：交互契约（键位、模式栈、过滤、假按钮禁令）
产出形态：artifact
角色：执行（executor）
输入：scripts/oversight-tui.mjs 的 parseKeysWithRest / onKey / App（只读）；
      .tmp-analysis/dsh-tui/docs/interaction.md；.tmp-analysis/dsh-tui/src/components/design-system/HintLine.tsx
必须回答：
  1. 模式栈有几层？每层 `Esc` 去哪？画出状态图（文字版即可）。
  2. 「直接打字即过滤」与现有键位是否冲突？（逐个检查 j/k/g/G/c/r/q/?/Enter/Esc/PgUp/PgDn）
  3. 每一屏的 hint line 内容表（逐屏逐行给出），且必须随状态变化（有草稿/无草稿、有选中/无选中）。
  4. 「没有草稿时按 c」的完整交互是什么？（提示文案 + 是否提供替代动作 + 替代动作是什么）
  5. 列表为空 / 过滤无结果 / 首扫中 三种情况下，哪些键仍然有效？逐键列表。
产出物路径：docs/spec/2026-11-05-tui-interaction.md
验收标准：
  AC1 键位表必须覆盖现有全部键，且每个键在每个模式下都有明确行为或明确的「无效」。
  AC2 过滤态的键位冲突必须逐键核对并附现有代码行号。
  AC3 每屏 hint line 的最大宽度必须 ≤ 60（窄屏也得放得下），附 displayWidth 统计。
  fail_if：出现「按了没反应也没提示」的键；hint line 与真实可用键不一致。
依赖：可与 T2 并行
```

#### T6 红队：攻击这份规划（详见 §六）

```
任务名：红队 —— 证明这份规划里有过度设计
产出形态：artifact
角色：红队（redteam；**不读 T1–T5 的任何产出**）
输入：本文件全文（只有这一份）；README.md 的能力边界；scripts/oversight-tui.mjs；
      docs/spec/tui-visual.md
必须回答：
  1. 七条 P 规则里，哪几条可以被删掉而不损失任何用户价值？逐条给反例。
  2. 三层屏幕（须动作/在跑/已停）是不是过度设计？如果两段就够，是哪两段？
  3. 检查表（L1）是不是在给用户看「测试报告」？普通用户会读吗？
  4. 「证据区」（verify-claims）有多少概率被真正使用？给出量化推理。
  5. 如果只能改 3 个地方，改哪 3 个？为什么其余 7 个可以先不做？
  6. 找出本文件里至少 3 处「用实测数字包装的判断」——即数字是真的，但结论不成立的地方。
产出物路径：docs/research/2026-11-05-tui-plan-redteam.md
验收标准：
  AC1 必须给出「建议删除清单」，每条含：删的是什么 / 删了会怎样 / 依据。
  AC2 第 6 问必须真的找出 3 处，且给出反证；找不到反证时写「本轮未发现」并说明搜了什么（不得静默通过）。
  AC3 必须有一节「我认为这份规划最可能错的地方」，不得为空。
  fail_if：全篇同意；或用「建议进一步优化」这类无法执行的话代替具体删改。
依赖：无（与 T1–T5 并行，且不得读它们的产出——独立性靠不给路径，不靠 prompt 里写「请勿」）
```

#### T7 实现（串行，最后）

```
任务名：按收口后的规格改造 oversight-tui.mjs（保持单文件 + 零依赖）
产出形态：artifact
角色：执行（executor）
输入：T1/T2/T4/T5 收口后的四份文档 + T6 裁决记录 + 本文件
必须回答：不适用（执行）
产出物路径：scripts/oversight-tui.mjs、scripts/tui-theme.mjs、scripts/oversight-tui.test.mjs
验收标准（**必须在派发前冻结**，由主线程先写进 templates/acceptance-criteria.md）：
  AC1 列表页首行必须能在一行内回答「几件在等你」；用 grep 断言渲染函数存在且测试覆盖。
  AC2 同一份 scan JSON 在 76 列下渲染，每行 displayWidth ≤ 76（新测试用例覆盖）。
  AC3 D1（live 行项目名不切分 Windows 路径）必须有回归测试：把 bug 装回去测试必红。
  AC4 29 行真实数据下，列表页不得出现 `reason` 与 `novelty` 字段（grep 排除）。
  AC5 `node scripts/check-structure.mjs` 通过；`node --test scripts/oversight-tui.test.mjs` 全绿。
  fail_if：引入任何 npm 依赖；新增超过 300 行而没有新增测试；改动 `tui-theme.mjs` 的六态字形而无终端验证记录。
依赖：T1–T6 全部收口
```

---

## 五、建议并行派发的 5 个 Agent（prompt 骨架）

> 每个 prompt = `templates/dispatch.md` 公共段 + 下面这段域专属段 + baseline 事实快照。
> **域专属段必须逐字包含本文件路径**，不要转述本文件内容——转述会让 Agent 在别人的框架里思考。

### 5.1 A1（= T1，数据契约）

```
你是本轮 TUI 重做编队中的数据契约 Agent。

## 原始任务
（本文件 §4.2 T1 卡片逐字复制）

## 你必须先读的三份东西
1. D:/…（相对路径：docs/design/2026-11-05-tui-redesign-plan.md 的 §1、§2.5）
2. scripts/scan-sessions.mjs（judgeState / readLiveSessions / readJobs / 主循环）
3. scripts/watch.mjs（buildInbox / healthCheck / HOST_FACT_STATES）

## 已确证的基线事实（不要重新测，直接引用）
- scan --days 3：29 条，PRODUCING 12 / EXPLORING 17，耗时 19.3s（本机）
- 29 条里 needs=0、suggestedReply=0、tokens=0
- transcript 尾部 128 KB 内：custom-title 29/29 可得，最后一条 assistant 文本 29/29 可得，
  全量 29 条共 92 ms
- claude agents --json：14 条，含 2 条 blocked，这两条的 sessionId 不在 scan.sessions 也不在 scan.live

## 产出形态
artifact。写入 docs/design/2026-11-05-tui-data-contract.md。

## 验收标准
（本文件 §4.2 T1 的 AC1–AC3 逐字复制，不得修改、不得增补）

## 明确禁止
- 不改 scripts/ 下任何文件
- 不跑 node --test（耗时，且本轮不验收实现）
- 不写「一般都有」「通常情况下」这类判断
```

### 5.2 A2（= T2，IA 规格）

```
你是本轮 TUI 重做编队中的信息架构 Agent。

## 原始任务
（本文件 §4.2 T2 卡片逐字复制）

## 你必须先读
1. docs/design/2026-11-05-tui-redesign-plan.md 的 §2 全文（七条规则、字段矩阵、三张草图）
2. scripts/oversight-tui.mjs（现有四屏的渲染函数）
3. docs/spec/tui-visual.md §1–§4（三通道与颜色关闭条件）

## 基线事实
- 76 列是本轮的设计基准；60 列与 40 列必须给出降级档
- 现有 `HINT_LIST` / `HINT_DETAIL` / `HINT_DRAFT` 是常量，不随状态变化（本规划的 P6 判定为缺陷）

## 产出形态
artifact。写入 docs/spec/2026-11-05-tui-ia.md。

## 验收标准
（本文件 §4.2 T2 的 AC1–AC4 逐字复制）

## 特别注意
草图里的每一行都会被机器量宽度。写完自己跑一遍统计（displayWidth，CJK 计 2 列），把输出贴进文档。
不要为了让草图好看而缩窄它——超宽就是超宽。
```

### 5.3 A3（= T3，四源真值）

```
你是本轮 TUI 重做编队中的真值核对 Agent。你的产出是 exploration，允许有「不知道」。

## 原始任务
（本文件 §4.2 T3 卡片逐字复制）

## 你必须先读
1. docs/design/2026-11-05-tui-redesign-plan.md 的 §1.4（六条缺陷）与 §2.6（空状态）
2. scripts/watch.mjs 的 buildInbox 全文注释（它记着一次真实的「收件箱撒谎」事故）
3. scripts/install-watcher.mjs 的 status 分支与 healthCheck 的阈值

## 允许执行的命令（只读）
node scripts/watch.mjs --inbox --json
node scripts/watch.mjs --health --json
node scripts/install-watcher.mjs status
node scripts/scan-sessions.mjs --days 3 --json
node scripts/verify-claims.mjs --days 3 --json
claude agents --json
不得写文件到 ~/.claude/ 或数据目录。

## 产出形态
exploration。写入 docs/research/2026-11-05-tui-truth-sources.md。

## 验收标准
（本文件 §4.2 T3 的 AC1–AC3 逐字复制）

## 特别注意
第 5 问（什么时候该拒绝显示「0 件在等你」）是本轮最重要的产出。写成一个可判定的条件，
不要写「视情况而定」。
```

### 5.4 A4（= T4，视觉规格）

```
你是本轮 TUI 重做编队中的视觉规格 Agent。

## 原始任务
（本文件 §4.2 T4 卡片逐字复制）

## 你必须先读
1. scripts/tui-theme.mjs（全文，350 行）
2. docs/spec/tui-visual.md（全文，尤其 §3.1 字形被实测推翻的那一节）
3. .tmp-analysis/dsh-tui/src/theme.ts 的 414-416 与 689-693 行（正文黑白灰原则）
4. .tmp-analysis/dsh-tui/src/components/launchpadLayout.ts 的撤块阶梯注释
5. .tmp-analysis/dsh-tui/src/components/sessions/SessionListRow.tsx 的 61-66 与 134-140 行

## 已确证的基线事实
- badge('WAITING', true) 实测返回 0 个 ESC（SGR 表缺 brightYellow），其余五态各 2 个
- 现有五字形 ? × ▲ ● ○ 已在本机 conhost / Windows Terminal / mintty 三处实测无豆腐块
- 本产品零 npm 依赖

## 产出形态
artifact。写入 docs/spec/2026-11-05-tui-visual-v2.md。

## 验收标准
（本文件 §4.2 T4 的 AC1–AC3 逐字复制）

## 特别注意
不许引入任何未经三处终端实测的新字形。没有条件实测的，写「待验证」并把它排除在设计之外。
```

### 5.5 A5（= T5，交互契约）

```
你是本轮 TUI 重做编队中的交互契约 Agent。

## 原始任务
（本文件 §4.2 T5 卡片逐字复制）

## 你必须先读
1. scripts/oversight-tui.mjs 的 parseKeysWithRest / parseKeys / App.onKey / App.render
2. .tmp-analysis/dsh-tui/docs/interaction.md 的「输入与全局快捷键」表
3. .tmp-analysis/dsh-tui/src/components/design-system/HintLine.tsx（动态 hint 的实现思路）
4. .tmp-analysis/dsh-tui/src/screens/SessionSupervisor.tsx 的 440-470 行（Enter 与选中同源的注释）

## 基线事实
- 现有键位：j/k/g/G/Enter/Esc/c/r/?/q/PgUp/PgDn/方向键；`parseKeysWithRest` 已解析出全部方向键与翻页键
- 现在**没有过滤功能**，也没有任何动态 hint
- `c` 在本机数据上 100% 落到「无草稿可复制」

## 产出形态
artifact。写入 docs/spec/2026-11-05-tui-interaction.md。

## 验收标准
（本文件 §4.2 T5 的 AC1–AC3 逐字复制）

## 特别注意
第 4 问（没有草稿时按 c）是 P6「不提供假按钮」的落地。必须给出逐字提示文案 + 替代动作，
并说明替代动作在 4 个数据源各缺失时的行为。
```

---

## 六、反方任务（T6）的具体攻击清单

红队不是「再检查一遍」，是**构造反例**。以下是主线程应写进 T6 prompt 的攻击方向（不写结论，只写方向）：

| # | 攻击点 | 反例形态 | 成立时的后果 |
|---|---|---|---|
| R1 | **三段分区是不是过度设计** | 如果 12 个在跑的会话里，用户实际只关心其中 2 个，那么「在跑」这一段就是 12 行的噪声，与现在的 29 行没有本质区别 | 应删掉「在跑」段，只保留「需动作」+ 一行计数 |
| R2 | **检查表是不是自嗨** | 用户打开面板时只想知道「有没有事」，四行检查表他读了一次就再也不读 | L1 应压成一行，其余进 `?` |
| R3 | **证据区是不是伪需求** | verify-claims 本轮 17 条断言里只有 1 条 FAILED_ONLY，而该条在 Overwatch 仓库自己身上——用户可能从不看别的项目 | 证据区只保留「有问题的会话」入口，不做常驻面板 |
| R4 | **「最后一条 assistant 文本」是不是又一个 reason 列** | 17 条历史会话的末条文本都是「完成了 X」，信息量与 dormant 相当 | 该列只在「在跑」段显示 |
| R5 | **标题 29/29 可得这个结论是否被过度外推** | 本机 29 个会话恰好都有 `custom-title`（末条最远距 EOF 32 KB）；但 `agent-name` 只在部分会话里有，且这份样本只有 29 条、全部来自本机同一版本的宿主。换成别人的机器、别的宿主版本、或 `--days 12` 的 148 条，覆盖率未知 | 必须写「本机 29/29，读取窗口 128 KB 覆盖 29/29」而不是「总是可得」，并在实现里保留「无标题 → 回退到 cwd 尾段」的路径 |
| R6 | **P2「主问题常驻」会不会变成第二个『29 会话』** | 如果「N 件在等你」长期是 0，它会退化成装饰，与「29 会话」同命运 | 需要给出「0 时显示什么」的规则（本文件 §2.6 已给，但红队应质疑它是否够） |
| R7 | **颜色减少会不会让高危漏看** | 现在 29 行全彩至少让 FAILED 有机会被看见；改成「只有需动作上色」后，若判据漏了（D6 就是漏了），界面上什么都不剩 | 需要一条兜底：「任何来自宿主事实的异常，即使判据不全，也必须上色」 |

R5 与 R7 是**可能推翻本规划**的两条，必须在 T6 里优先攻击。

---

## 七、前置未知与风险

| 风险 | 现状 | 处理 |
|---|---|---|
| 新增读取（标题 + 摘要）会不会拖慢轮询 | 实测 29 条 × 128 KB = 92 ms；但 `--days 12` 是 148 条，线性外推约 470 ms | T1 必须给出缓存策略（按 mtime 失效），并在 AC 里写死上限 |
| `verify-claims` 每次 7.2 s，不能放进 8 秒轮询 | 已验证 | 设计为独立命令 + TUI 按需触发（`d` 键），或低频（≥60s）缓存 |
| D6 的两条 blocked 会话来源不明 | 未验证 | T3 的第 2 问；若查不出，界面必须能把「三个源不一致」本身显示出来 |
| 用户是否真的需要「已停」段 | 未验证（红队 R1） | 由 T6 裁决；本规划不预先删 |
| 本仓库现有硬门已红 1 条（`docs/research/2026-11-05-verify-claims-productization.md` 含本机绝对路径） | 实测 `check-structure.mjs` 报 1 项违规，与本规划无关 | 不由本规划修；登记给主线程 |

---

## 八、与本仓库既有规格的关系

| 既有文件 | 影响 | 处理 |
|---|---|---|
| `docs/spec/tui-visual.md` | 六态字形与三通道**保留**；新增「强调预算」「双行行高」「撤块阶梯」 | 由 T4 出新版规格，旧文件保留并标注「v1，被 v2 取代」 |
| `docs/spec/output-format.md` | 不冲突。它的 §2 状态行是「Agent 回报格式」，不是 TUI 版面 | 不改 |
| `docs/spec/state-model.md` §8 | 「状态行语法」有 `novelty` / `budget` 字段——那是 Agent 回报用的，TUI 不必照搬 | 不改，但新 IA 要在文档里说明「两者不是同一个东西」，避免下一个人照抄 |
| `docs/GUIDE.md` §5 | 键位说明与新交互契约会不一致 | 由 T7 在实现后同步 |
| `scripts/tui-theme.mjs` | 六态定义是单一真源，`STATE_ORDER` 从它派生（`oversight-tui.mjs:30-34`） | 新 IA 的「三段优先级」必须也从这个文件派生，不得在渲染里另写一份 |

---

## 九、裁决记录（留给主线程）

本文件是**提案**，不是裁决。以下三条必须由主线程在派发 T7 之前给出明确结论，写回本节：

1. 「已停」段保留还是删除（红队 R1）。
2. 检查表（L1）保留几行（红队 R2）。
3. 证据区（verify-claims）是常驻面板还是按需入口（红队 R3）。

**未裁决不得开工 T7。** 事后补规格等于事后编标准，`docs/spec/dispatch-contract.md` §2 已明确禁止。

---

## 九·二、裁决结论（主线程，2026-11-10）

红队的三个问题都成立，但它们问的是「要不要」，而真正该问的是「**用户的注意力花在哪**」。
三条裁决依据同一条原则：**屏幕上每一行都必须能改变用户下一秒的动作**。

### R1 —「已停」段：保留，但只保留一行，默认折叠

**裁决：保留，压成一行计数；按 `h` 展开。**

理由（不是折中，是两条独立依据）：

1. **用户已明确要求「所有都要显示」**（2026-11-10）。删掉整段与用户指令直接冲突。
2. 但「17 个已停」里 16 个是 22.8 天前就结束的历史会话，展开成 17 行会让真正该看的
   「在跑 (12)」被挤出第一屏。**保留不等于展开**——信息存在与信息占据屏幕是两件事。

判据：一行 `已停 (17) 28 秒–22.8 天前 · h 展开`。这行能改变动作（用户会判断「有没有我忘了关的」），
而展开后的 17 行不能（它们没有待办）。按 §2.5 的规则，它待在 L4 而不是 L2。

### R2 — 检查表：4 行全留，一行不砍

**裁决：保留 4 行（等你回应 / 问了没答 / 声明对不上 / 后台监视）。**

理由：这四行不是四个「功能」，是**四道独立的数据源**。少任何一行，「没事」这句话就少一个佐证：

| 行 | 砍掉后丢失什么 |
|---|---|
| 等你回应 | 主诉（用户最常问的） |
| 问了没答 | transcript 侧的独立判据，与上一行不同源 |
| 声明对不上 | **产品唯一差异点**，砍了等于砍掉 validate-claims 的入口 |
| 后台监视 | 砍掉后「0 件事」与「监视挂了」无法区分——§2.6 已经证明这是真实发生过的失效 |

红队 R2 的顾虑是「4 行占掉首屏」。但这个顾虑在 76 列宽下不成立：
四行检查表实测占 4 行，而它替换掉的是原来 29 行里的 `reason` 列——**净减 25 行**。

### R3 — 证据区：常驻「1 行摘要」，完整内容按 `d` 进入

**裁决：L0 判决行与检查表里常驻计数（`1 条 · d 看证据`），完整证据面板按需展开。**

理由：

1. **「声明对不上」是本产品唯一的真差异**（四份独立调研的结论），它必须在首屏可见——
   否则用户装了不知道有这个能力。
2. 但完整证据（断言原文 + 工具调用时间线 + 建议）动辄十几行，常驻会淹掉会话列表。
   实测 `--session 3b390f6e` 输出 8 行，全量 31 条断言则是数百行。
3. 采用 dsh-TUI 的「**可数披露**」原则：首屏写 `1 条`，而不是写 `有`。

**所以 R3 的答案是分层的，不是二选一**：计数常驻（0 行成本，因为已在检查表里），
证据按需（`d` 键，复用 `verify-claims --verbose` 的输出）。

---

### 三条裁决的共同依据

红队三个问题都可以归结为同一句：**这一行能不能改变用户下一秒的动作？**

- 「已停」计数能（判断有没有遗忘的会话）；展开的 17 行不能 → **保计数、折叠列表**
- 检查表每行能（各是一个数据源的存活证明）→ **全留**
- 证据计数能（提示存在待核对项）；完整证据不能（除非用户决定去核对）→ **计数常驻、内容按需**

据此，§2.5「L0/L2 出现的字段必须能改变动作，否则下沉」这条规则适用于全部三条裁决。
