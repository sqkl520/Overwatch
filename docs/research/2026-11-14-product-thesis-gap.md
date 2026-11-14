# 命题 vs 实现：这个项目做的是不是用户要的那件事

- 日期：2026-11-14
- 角色：审计 Agent P3（角度：**命题 vs 实现**，不重复 P1 陌生人走查 / P2 能力核验）
- 产出形态：`exploration`（只读审计，除本文件外未改任何仓库文件）
- 判据唯一来源：用户原话（逐字，见 §0）
- 每条判断附 `file:line` 或可复跑命令。**本文未修改任何代码，未碰 git。**

> ⚠ **落盘副作用（必须先说）**：新增本文件会让 `check-structure.mjs` 的
> `checkResearchIndex()` 报红（新研究报告必须在 `docs/research/README.md` 登记状态）。
> 本任务约束是「只写这份报告、不改其他文件」，所以**那一行索引没有补**。
> 主线程需补一行索引，硬门才会重新变绿。这不是免责，是一个待办：
> 现在的仓库状态下 `node scripts/check-structure.mjs` 会 fail。

---

## 0. 命题原文（判据）

> 我们的理念是用户一次给到需求便一次做完，不会中途停止，而最重要的一个环节就是需求的传递，问问题是一个很重要的环节
>
> 用户可自定义，但必须问问题，这是我们这个项目的主题
>
> 有很多时候用户是不知道要实现这个功能还要考虑到什么什么的，也有很多时候AI不知道用户真正的意图
>
> 我希望 AI 的每轮对话最开始都可以像这种列一个 plan，让用户安心知道具体流程
>
> 问要问的准，要问的泛…在问问题之前AI需要了解项目文件夹状态，环境状态，然后再去问，而不是写完文件再去问
>
> 可以给别人用不掉链子，让任何人的开发效率变高

2026-11-14 修正：

> 全部都可配，包括不问，但不问属于小众玩法，比如测试AI模型质量

---

## 1. 拆成可判定子命题

判据一律是「**运行时会怎样**」，不是「有没有文档说」。

| 代号 | 子命题 | 可观测判据 |
|---|---|---|
| **S1** | 一次做完，不中途停 | 什么情况下会话会停？停下来时，「为什么停」「还差什么」有没有交到用户手上？ |
| **S2** | 需求传递不失真 | 用户原话 → 主 agent → 子 agent，哪一跳有机制能测失真？能不能事后对账？ |
| **S3** | 动手前问该问的 | 问了什么、准不准；有没有「先读项目再问」的顺序约束 |
| **S4** | 每轮开头一个 plan | plan 在哪产生、谁写、用户能否看到、能否与最终产出对账 |
| **S5** | 问不问可配 | 配置项在哪；改了什么会变 |
| **S6** | 给别人用不掉链子 | 装什么、改什么；价值主张对陌生人是否成立 |

---

## 2. 逐条查证

### S1 一次做完 —— **有骨架**

**已实现的部分（事后检测，不是事前保证）：**

- `scripts/scan-sessions.mjs` 给每个会话一个 `reason` 字段，TUI 与 `--plain` 都会印。
- `scripts/stop-signals.mjs` 对停机原因做结构判定。本机实跑（`node scripts/stop-signals.mjs`）：
  436 个 transcript，`ERROR_STOP` 95（26.2%）、`STOPPED_SILENT` 256（70.5%）、`QUESTION_TEXT` 11（3.0%）、
  **结构性判据给出具体原因的只有 96/363 = 26.4%**。原始目标可从日志取出 97.7%。
- `scripts/watch.mjs --inbox` 透传宿主的 `needs` / `suggestedReply`（宿主原话）。

这三件回答的是「它**停在哪**」，不是「它**为什么没做完**」。

**唯一会真的「不让它停」的机制：** `scripts/stop-verify-hook.mjs` —— 宿主的 `Stop` 事件上，
完成声明缺证据就 `{"decision":"block"}`，reason 里写明「你写的是哪一句 / 缺什么时间线 / 跑什么命令」
（`stop-verify-hook.mjs:284-310`）。这确实是「停下来时把还差什么交回去」。

**但它不构成 S1：**

1. **默认关闭**（`docs/CAPABILITIES.md:59`：「不设环境变量时只记账、永远放行」）。
2. **在本仓库里从未注册过。** `.claude/settings.local.json` 没有 `hooks` 键；`.claude/settings.json` 不存在；
   `git log --all -- .claude/settings.json .claude/settings.local.json` 零条 —— 两道 hook 从来没被提交过。
   `tasks/runs/stop-hook/2026-11-12.jsonl` 只有 1 行，内容是 `allowReason:"unparsable-input"`。
3. **触发窗口极小。** 锐评 C1 复算（`docs/research/2026-11-13-critique-stop-hook-product.md` §2.3）：
   可拦的完成声明里 **93.7% 发生在会话中段**，只有 6.3% 落在会话最后一次交还；
   而用户唯一会读那句话的时刻是最后一次。净命中 **4/240 = 1.7%** 的「说完就停」类介入。
4. 它拦的是「**假完成**」，不是「**没做完**」。两者不同：一个撒谎，一个说实话但没干完。后者它放行。

**唯一有实测支撑的「提高完成率」杠杆不在流程里。** `compose-agent-prompt.mjs` 把「停机条件」列为九条必填元素之一，
依据是真实实验（`docs/research/2026-11-14-prompt-based-multiagent-limits.md` §3.4：窄任务 5 分 25 秒完成
7,138 字节，宽任务 9 分钟后仍是 75 字节骨架）。但这个脚本**没接进任何流程**：

```
$ grep -c compose-agent-prompt .claude/skills/oversight/SKILL.md templates/dispatch.md
0
0
$ find . -name prompts.jsonl -not -path './.git/*'
（无输出）
```

`docs/design/README.md:29` 自己写着「**未接入 `SKILL.md` Phase B**」。
`prompts.jsonl` 在磁盘上不存在 = 这个工具从没对一次真实派发生效过。

**判定：有骨架。** 事后「停在哪」已实现；事前「不让它停」只有一个默认关闭、本仓未注册、
窗口 6.3% 的闸门；唯一有证据的杠杆是未接线的原型。

---

### S2 需求传递 —— **有骨架（对的是产出，不是需求）**

先把链路画出来（规格说的）：

```
用户原话 → root_goal（task-graph） → 子树 goal → compose 的 L2 段 → 子 agent 首条 user 消息
```

**哪一跳有机制：**

| 跳 | 机制 | 查的是什么 |
|---|---|---|
| `root_goal` 本身 | `validate-run.mjs:133` | **只查「非空字符串」** |
| 子树 `goal` | `validate-run.mjs:151` | 只查「非空字符串」 |
| 子树 `goal` → prompt | `compose-agent-prompt.mjs:349` | **只查 `taskText.length >= 6`**，短于 20 字符给 warning |
| prompt → 子 agent 实收 | `compose-agent-prompt.mjs` 的 `verify`（hash 台账） | 查「**字节是否相同**」 |

**关键发现：`root_goal` 根本不进子 agent。**
`compose-agent-prompt.mjs:939` 与 `:963` 都是 `task: st.goal` —— 只取子树 goal。
`grep -n root_goal scripts/compose-agent-prompt.mjs` 零命中。也就是说：

> 子 agent 收到的是 **planner 对需求的转述**，不是用户的字，也不是 run 的根目标。

而 `templates/dispatch.md:24` 明写「原始任务描述（逐字）｜缺失时：停下来，说明缺了什么」——
这条**没有被任何代码检查**。hash 台账证明的是「主线程写的那份 = 子 agent 收到的那份」，
起点在 planner 的转述之后。**它审计的是副本一致性，不是保真性。**

**已实现的那一半是真的：** `claim-ledger.mjs` 是四方对账（期望 / 自述 / 磁盘 / transcript），
`SKILL.md` §4.5 把它设为验收前置门，`reconciliation-wiring.test.mjs` 钉住了接线，
`tasks/runs/2026-11-13-output-reconciliation/claims.jsonl` 有 3 个任务的真实记录。
本机实跑 `claim-ledger verify --run 2026-11-13-output-reconciliation`：
`COMPLETE / COMPLETE / DRIFTED`，**exit 1**，且 DRIFTED 的说明是
「hash 与自述不一致（文件在自述之后被改过）」——它工作得很准。

但它对账的是「**说过要产出的文件，在不在**」。用户要的是「**做出来的东西，是不是我要的**」。
README 自己承认做不到后者：「不能判断改得对不对」。

**判定：有骨架。** 产出交付对账 = 已实现且接线；需求语义对账 = 没有，
而且现有链路把 `root_goal` 从子 agent 的视野里丢掉了，`dispatch.md:24` 的「逐字」要求无人执行。

---

### S3 动手前问该问的 —— **没有**

- 规格存在且写得不弱：`docs/spec/2026-11-11-question-protocol.md`（1100+ 行，含 `QuestionPack` / `ZERO_ASK` /
  `no_open_questions_why` / `REDUNDANT_ASK`）。**但它第一行就写着**：
  「状态：Proposed。**零行实现。**」；`:850` 写着「新增 `scripts/question-audit.mjs`（**本文不实现，只定义**）」。
- 文件不存在：
  ```
  $ ls scripts/question-audit.mjs scripts/validate-questions.mjs scripts/question-protocol.test.mjs
  ls: cannot access ...（三个都不存在）
  ```
- 方向提案文档 `docs/design/2026-11-11-question-protocol-thesis.md` 在索引里的状态是
  「方向性声明 … **不是设计方案，零行实现**」（`docs/design/README.md:23`）。
- 仓库里所有带 `ask` 的脚本都是**探测器，反方向**：
  `asked.mjs` 找「AI 问了、人没答」；`measure-execution-phase.mjs` / `measure-interventions.mjs`
  事后数 `AskUserQuestion`。**没有任何东西生成问题或校验问题。**
- 「问之前先读项目」的顺序约束：**只作为一句劝告**出现在写前闸的拒绝理由里
  （`pre-write-gate.mjs:725-728`：1. 读 CLAUDE.md/README + 源码 2. 用 AskUserQuestion 一次问清 3. 建标记重试）。
  它是「第一次**写**」时的 reason 文本，不是判据。模型完全可以先问、后读，没有任何东西会判它错。
  `docs/research/2026-11-14-pre-write-gate-prototype.md` 的原话：「『第一次写之前强制提问』仍不可行——
  `AskUserQuestion` 只是 reason 里的指令，机械核对不到」。
- 本机实跑 `node scripts/asked.mjs --hours 1`：扫了 436 个 transcript，**0 条待回答**。
  它能告诉你「有没有人没答」，不能告诉你「该问的有没有问」。

**唯一和 S3 沾边且能跑的是度量**：`measure-execution-phase.mjs:440` 有 `readsBeforeAsk`，
输出「第一次提问前读项目状态：全体 median 161（n=53），A median 4，B median 380」。
**它证明一件事：99% 的情况下，提问之前早就读了一百多个文件。** 用户担心的「写完文件再去问」
在数据上不是问题——问题是**问这件事本身有没有发生**，而它在这 322 个会话里只发生了 186 次。

**判定：没有。** 不是「有骨架」——连一个校验器/一次接线都没有。规格是清醒的，产品是零行。

---

### S4 每轮开头一个 plan —— **没有**（面向用户的 plan）；plan 数据结构 = **有骨架**

分两件事，别混：

**(a) 用户能看到的、每轮开头的 plan：没有。**

- `docs/spec/output-format.md:17`：「**这一节描述的是约定，不是已实现的能力。仓库里没有任何脚本输出这个格式**」。
- `.claude/skills/oversight/SKILL.md:238`：「**格式是约定，渲染器还没有**」。
- `docs/research/2026-11-13-plan-first-mechanism.md` 是 `exploration`、零行实现，
  `docs/research/README.md:144` 状态 `❓`，注明「**未做产品裁决**」。
- 用户截图里那种 `○` 清单是宿主自己的 `TodoWrite` / `TaskCreate`，**不是本仓库产出**。
  逆向结论：2.1.308 里 TodoWrite 默认关闭，走 Task 族（`plan-first-mechanism.md` §一.2）。
  也就是说**宿主已经会显示 plan**，这一条命题本仓库根本没接。

**(b) 有一个 plan 数据结构，但它不是用户要的那种 plan：**

- `tasks/runs/<run-id>/task-graph.json` + `validate-run.mjs` 确实是一张**可校验的计划**：
  每棵子树必填 `goal / shape / token_budget_pct / timeout_min / parallel_with / depends_on / acceptance / outputs / why_this_layer`
  （`validate-run.mjs:17-18`）。
- 它比宿主的 todo 严格一个量级（有 `ac`、有预算、有依赖），这是设计文档自己指出的
  （`plan-first-mechanism.md` §一.3「**不要退化去抄它的 schema**」）。
- **但**：它是**每个 run 一份**，不是**每轮一份**；由 `oversight-planner` 写；**没有任何渲染器**给用户看；
  全仓库历史上只有 **2 份** `task-graph.json`（`find tasks/runs -name task-graph.json`），
  5 个月 84 个 commit 里 Phase A 跑过约 2 次。

**判定：面向用户的 plan = 没有；plan 数据 + 校验器 = 有骨架（且几乎没用过）。**

---

### S5 问不问可配 —— **没有**

- 「问不问」这个维度**连可配的对象都不存在**（S3 = 没有），所以谈不上配置。
- 裁定文档存在：`docs/design/2026-11-14-agent-roster-policy.md`（岗位组合 + `stop/retry:N/escalate`），
  `docs/design/README.md:28` 状态：「**零行实现**」。`grep -rn roster --include=*.mjs --include=*.json` 在
  `scripts/`、`templates/` 下**零命中**（只有 `.tmp-analysis/` 里第三方项目的同名文件）。
- 该文档 `:73` 还有一句危险的话：「对应**已实现的** `no_open_questions_why` 和 `claim-ledger` 的 `declare` 记录」。
  `no_open_questions_why` **只出现在 `docs/spec/2026-11-11-question-protocol.md` 里，零行实现**；
  `claim-ledger declare` 记录的是**产出路径期望**，与问题无关。**这句「已实现」是错的**，
  它会让读者以为 S5 已有落点。
- 真正存在的配置面是**另外一组**环境变量，配的是闸门不是提问：
  `OW_PRE_WRITE_GATE=observe|warn|deny`、`OW_PRE_WRITE_GATE_MIN_READS`、`OVERWATCH_STOP_VERIFY=block` 等
  （`pre-write-gate.mjs:177-190`、`stop-verify-hook.mjs`）。它们有测试、改了就变。
  **但两道 hook 在本仓库都没注册**（见 S1），所以这些开关此刻全是惰性的。

**判定：没有。** 唯一的配置面（闸门 env）配的是一道默认关、本仓未注册的闸。

---

### S6 给别人用不掉链子 —— **脚本已实现；方法论只有文档/作者配置**

**脚本侧：真的 clone 即用。**
零 npm 依赖，无 `package.json`，`node scripts/scan-sessions.mjs --days 3` 直接出结果。
本机实跑已确认 `check-structure` exit 0、28 个测试文件、`verify-claims` / `stop-signals` / `asked` /
`claim-ledger` / `validate-run` 全部可跑。这是货真价实的那一半。

**方法论侧：是作者自己的配置，不是产品。**

- `.claude/agents/*.md` 12 份 + `.claude/skills/oversight/SKILL.md` 是**项目作用域**的：
  只有在**本仓库目录内**开 Claude Code 才加载。陌生人要在自己项目里用，得手工把 12 个 md +
  1 份 SKILL + `templates/` + `scripts/` 复制过去。
- **没有安装脚本、没有插件/marketplace manifest、没有 `npx` 入口。**
  `scripts/install-watcher.mjs` 只装「开机自启 + Toast」，是运行时组件的安装，不是方法论的安装。
- hook 的接入方式也是手工：`templates/pre-write-gate.settings.json` 的 `_how_to_enable` 第 2 条
  「把下面 hooks 段整段合并进 `.claude/settings.json` …把 `command` 换成**你机器上的绝对路径**」。
  两份模板都要求手工改绝对路径 —— `check-structure` 之所以禁止可发布区出现本机路径，
  正是因为这类东西天然不可移植。
- **判据（有没有一键初始化）：没有。**

**价值主张对陌生人成立吗：部分成立，但窄。**
陌生人拿到的第一手价值是 `verify-claims.mjs`：它不需要理解 12 个角色、不需要注册 hook，
对着自己的 transcript 就能跑，且确实能判 `SUPPORTED / STALE_ONLY / FAILED_ONLY / NO_EVIDENCE / UNKNOWN`。
本机实跑 `verify-claims --days 3` 立刻给出可读的判定与建议。这一条对陌生人是真成立的。

**但它回答的是「AI 那句『做完了』有没有证据」，不是「需求传对了没有」。**
而这恰好是 S1 的**事后检测**，与 S2/S3 的**事前传递**是两件事（见 §3）。

**判定：脚本 = 已实现；方法论 = 只有文档 + 作者配置；无安装、无打包、无多用户验证。**

---

## 3. 关键反问：这个仓库真正在运行的是什么

### 3.1 按代码量分布

`scripts/` 下非测试脚本按用途粗分：

| 类别 | 条数 | 例 |
|---|---|---|
| **观测 / 取证**（读 transcript、判状态、验断言、出面板、测量） | **26** | scan / watch / verify-claims / stop-signals / asked / classify-stop / TUI / measure-* / probe-* / replay / observe-* |
| **派发侧**（需求进入 + 产出对账） | **4** | compose-agent-prompt / claim-ledger / validate-run / project-commands |
| 闸门（hook） | 2 | pre-write-gate / stop-verify-hook |
| 其它（硬门、安装、宽度表） | 4 | check-structure / check-links / install-watcher / … |

**观测 : 派发 ≈ 6.5 : 1。** 这不是「顺手做的监控」，这是**主力**。

### 3.2 「产品-代码」错位

README 第一句：「**在 AI 想收工时替你把关。**」（`README.md:3`）

README 自己把错位说破了一段（`README.md:9-12`）：

> 这一版刻意**收窄了定位**。它做的是官方没有的那一件事：
> **把「AI 说它做完了」变成一句可核对的断言。** 其余能力是围绕这件事的观测面。

所以不是「作者没意识到」，是**已在文档里做过一次定位切换**。问题只剩：切到的那个东西，
和用户的句子是不是同一个产品？

逐条对照（命题 → 实际）：

| 命题 | 实际实现 | 是同一个产品吗 |
|---|---|---|
| 一次做完，不中途停 | 末条完成声明的证据核对（**事后**） | **相邻，不同**：「它撒谎了」≠「它没做完」，且发生在 6.3% 的收工点 |
| 需求传递不失真 | 产出**文件是否落地**的对账 | **不同**：查的是交付物存在性，不是需求语义 |
| 动手前问该问的 | 无 | — |
| 每轮一个 plan | 无（宿主自己有） | — |
| 问不问可配 | 无（只有闸门 env） | — |

**结论：命题说的是「事前把需求问准，然后一次做完」；代码做的是「事后核对 AI 有没有撒谎」。**
这两件事在**方向**上相反（事前 vs 事后），在**对象**上也不同（需求 vs 断言）。
把它们连起来的那条论证，只在设计文档里出现过一次假设——
`question-protocol-thesis.md` §「与现有资产的关系」说「`verify-claims` 的『断言 vs 证据』，
与『需求 vs 实现』是**同一形状**」。**这句话是类比，不是实现；而仓库只实现了类比的前一半。**
README 也明确堵死了延伸：「不能判断『改得对不对』」。

**那个东西有没有价值：有，但要单独定价。**

- 它解决的痛是真实的（「sanitised optimism」），判据是确定性的，不依赖模型，本机可跑。
- 但它自己的锐评算出**可用市场很薄**：`2026-11-13-critique-stop-hook-product.md` §2.2-2.4 ——
  需要的用户是「介入次数 ≥5」的那 **15.8%**；闸门净命中 **4/240**；
  有一半的「证据」来自它自己的实验沙箱。
- `2026-11-14-blind-spots.md` 那条「87.1% 墙钟没有任何活跃会话」被索引标为
  **推翻了整个产品赖以成立的用户画像**（`docs/research/README.md:「已被推翻的结论」` #3）。

**所以：有错位，而且错位后的那个产品，被它自己的研究判定为「痛点是薄的那一侧」。**

### 3.3 一个不该被轻放的客观事实

方法论本体（Phase A–E 多 agent 对抗）在本仓库自己的 84 个 commit、5 个月里，
`task-graph.json` 只出现过 **2 份**。也就是说：**这套方法论几乎没被它的作者用来开发它自己。**
这不是道德指控，是 S6 的证据：**一个连作者日常都不走流程的方法论，陌生人为什么要装？**

---

## 4. 「给别人用」的特殊检查

陌生人要用这套方法，需要做：

1. 装 Claude Code（宿主前提）。
2. clone 本仓库。
3. **要么**把 12 份 `.claude/agents/*.md` + `.claude/skills/oversight/SKILL.md` + `templates/` 复制进他自己的项目
   ——**要么**每次都在本仓库目录里工作。
4. 若要用闸门：手工把 `templates/*.settings.json` 合并进 `.claude/settings.json`，
   并把 `command` 改成他机器上的**绝对路径**。
5. 若要用 `oversight` skill：`disable-model-invocation: true`（`SKILL.md:5`），
   意味着**不会自动触发**，必须用户手动敲 `/oversight`。

**判据「有没有安装脚本 / 一键初始化」：没有。** 三个步骤全是手工复制与改路径。

**如果不装这套（只 clone 跑脚本），还剩下多少价值？**
剩下的是 §3.1 的 26 个观测/取证脚本 + 4 个派发脚本。这恰好是 README 声称的那一个价值主张，
**且它不需要方法论**——`verify-claims.mjs` 不 import 任何 agent 定义。
**这反过来说明：方法论不是产品的必要部分，是作者的工作方式。**

---

## 5. 一句话诊断

**产品形态在「事后证据核对」这一侧搭起来了，在「事前提问 + 需求传递 + 每轮 plan」这一侧一行没搭；
而后者是用户说「这是我们这个项目的主题」的那三句。**

严格说不是「我们做了另一个东西」——是**我们做了用户那句话的末尾（一次做完的结果），
没做它的开头（怎么才能一次做完）**。而开头才是用户反复强调的部分（「最重要的一个环节」）。

---

## 6. 缺的是工程量，还是产品定义？

**答：产品定义。而且分歧能精确到一句话。**

### 6.1 为什么不是工程量

- 提问层的「机制」是廉价的：一个 pack 校验器（规格已把 schema、四档风险、`ZERO_ASK`、`no_open_questions_why`
  全定义完，`validate-run.mjs` 是现成的模板：60 行级 JSON Schema 校验 + 测试）加一次 SKILL 接线。
  这比 `pre-write-gate.mjs`（55 KB、85 条测试）小一个量级。
- plan 渲染器：`scan-sessions --json` 已经在产数据，TUI 已经在渲染列表；加一个「本轮 plan」视图是几十行。
- 需求保真对账：把 `root_goal` 传进 `compose` 并在子 agent 首条 user 消息里核对，改两行
  （`compose-agent-prompt.mjs:939/963` 的 `task: st.goal` → 带上 `root_goal`）。
- **这些都不是硬骨头。** 硬骨头在别处。

### 6.2 为什么是产品定义

因为**「问问题」的价值，被这个仓库自己的测量否掉了**，而产品定义还停在「必须问」上。

三处互相打架的说法：

| # | 出处 | 说的是 |
|---|---|---|
| ① | 用户（2026-11-11） | 「**必须问问题，这是我们这个项目的主题**」 |
| ② | `2026-11-13-critique-question-layer-product.md` §2.1 | 本机复算：全量 828 次介入里**只有 8.2% 发生在首次写文件之前**；81.9% 在之后 |
| ③ | `measure-execution-phase.mjs` 本机全量实跑（322 会话 / 2805 人类发言 / 186 次提问） | A 开工前提问 n=14 mean **14.4** ／ C 从不问 n=140 mean **6.8**；**A 的活小 6.6 倍**（每 100 次工具：A 3.3 / B 1.9 / C 1.7）；体量匹配 7 对 **A 胜 4 / B 胜 3**；一次性完成率 A **0.0%**、B **0.0%**、C **31.4%** |
| ④ | `docs/research/README.md:151` | 索引原话：「**『提前问减少打断』无数据支持**」 |

也就是说：**命题的因果链「问准了 → 一次做完」，在本机 5 个月语料上跑不出正向证据；
按最干净的口径（A vs C），「开工前问」组的执行期中断反而更多、零中断率是 0%。**

而锐评还指出一个**定义级**的自相矛盾（`2026-11-13-critique-question-layer-product.md` §一.3）：
项目主指标是「人工介入次数变少」，但提问的作答（`Q` 类）**计入介入**。
按口径换算，**即使提问器 100% 精准，主指标也从 828 涨到 859** ——
问得越准，指标越差。「问问题」同时是**机制**和**成本**，而定义没决定它是哪一个。

### 6.3 分歧具体在哪一句

> 用户：「**问问题是一个很重要的环节**」／「**必须问问题，这是我们这个项目的主题**」
>
> 仓库自己的数据：「**提前问减少打断无数据支持**」；A 组一次性完成率 **0.0%**；按项目自己的指标，提问**让总数变大**。

这两句话不能同时当产品定义。必须选一句：

- **选用户**：那是**价值选择**，不是可验证的性能主张。那就要明确写「我们主张问，即使测不出收益」，
  并且**改主指标**（把提问从「成本」里拿掉，否则永远自相矛盾），然后 S3/S4/S5 才是该做的事，
  工程量大不了，定义清楚就能开工。这一步的产出是**一句新指标定义**，不是代码。
- **选数据**：那 README 现在的定位（事后证据核对）就是对的，
  「问问题是我们这个项目的主题」必须从命题里删掉，S3/S4/S5 从产品范围里移除。
  这一步的产出是**一句删除**，也不是代码。

**两条路都不需要写更多脚本；需要有人拍板哪一句是真的。** 这就是「缺的是产品定义」的意思。

### 6.4 一个附带证据，说明这个分歧一直在被推迟而不是解决

「必须问不可关闭」→ 2026-11-14 改成「全部都可配，包括不问」。
`docs/design/2026-11-14-agent-roster-policy.md` §「为什么『全部可配』是对的」给的理由是：
「用户要的是**能力**，不是**强制**」，「好的工具：默认安全，但允许关掉」。

这个理由把**强制**解决了，但**没有回答价值**：如果提问测不出收益（§6.2 ③④），
「默认安全」里的「安全」指什么？默认值该是「问」还是「不问」？文档没给判据，只给了偏好。

**所以 11-14 的修正是一致性修复，不是定义裁决。** 定义仍然悬着。

---

## 7. 附：本次审计的复跑清单

```bash
node scripts/check-structure.mjs                      # 本任务前 exit 0（加了本文件后会红，见文档头）
node scripts/measure-execution-phase.mjs --days 0     # 322 会话 / A n=14 / C n=140
node scripts/asked.mjs --hours 1                      # 436 transcript / 0 待答
node scripts/stop-signals.mjs                         # 436 会话 / 结构原因 26.4%
node scripts/verify-claims.mjs --days 3               # 四档判定可读
node scripts/claim-ledger.mjs verify --run 2026-11-13-output-reconciliation   # 3 任务 / DRIFTED / exit 1
node scripts/compose-agent-prompt.mjs compose --run <id> --task <t> --role executor --stop "≤25 行输出" --dry-run
grep -c compose-agent-prompt .claude/skills/oversight/SKILL.md                # 0
find . -name prompts.jsonl -not -path './.git/*'                              # 无
ls scripts/question-audit.mjs scripts/validate-questions.mjs                   # 都不存在
grep -c hooks .claude/settings.local.json                                     # 0
find tasks/runs -name task-graph.json                                         # 2 份
```

---

## 8. 诚实边界

- 本审计**没有**重跑锐评 C1 引用的 603/37 次 `end_turn` 分类，那需要自写重放；
  我引用的是它的结论并标注了出处。§6.2 ②③④ 的数字是**我自己跑出来的**。
- 「A 组一次性完成率 0.0%」的分母只有 14，**样本小**，不能单独当结论；
  它与 `measure-execution-phase` 的体量匹配结果（7 对 4:3）方向一致，两条一起看才稳。
- 「几乎没被用来开发自己」只能从 `task-graph.json` 的份数推断。
  作者也可能在别的目录里跑过这套流程，那些记录不在本仓库 —— 这一条是**下界**，不是精确值。
- 对 `docs/design/2026-11-14-agent-roster-policy.md:73` 的「已实现」指控是逐字核过的：
  `grep` 全仓，`no_open_questions_why` 只在这份 spec 与 research 里出现，无实现。
