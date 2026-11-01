# Changelog

本项目：**Overwatch · OmniSight** —— 跨会话 AI 任务监控与接力调度，以**纯 Claude Code 配置库**形态交付（markdown 角色定义 + 零依赖 Node 脚本），它看见的不是一个会话，而是所有对话的全景。

> **仓库**：<https://github.com/sqcola/Overwatch> ｜ **版本**：`0.2.0` + `[Unreleased]`（无 tag、无 Release）

格式参照 [Keep a Changelog](https://keepachangelog.com/)。项目尚未正式发版，各段以**工作阶段/里程碑**划分，并标注对应的 git commit。所有日期取自 `git log --format=%ad --date=short`；规格与 ADR 的落款日期是 2026-10-29，首次提交发生在 2026-10-30 凌晨——两者不一致是事实，不是笔误。

> **★ 硬规则（项目约定）**：**任何代码/配置/文档的更改，都必须记入本 CHANGELOG**。
> 版本号规则：功能闭环（能扫、能判、能看、能出草稿）之前不标 `1.0.0`。
> **本文件只记「改了什么」**；经验 / 方法论 / 踩坑写进 `tasks/dev-findings.md`，不要写在这里。
>
> ⚠️ **本文件是内部流水账**。它按工作阶段记录改动，包含硬门的自我失效、验收轮次、提交事故这些**我们自己才关心**的东西。
> **面向用户的说明是另一份**：`README.md`（能力边界、30 秒上手、四态表）与 `docs/GUIDE.md`
> （437 行使用手册：你会看到什么、该做什么）。本文件不复述它们的结论。

> **三条不给糖吃的写法约定**：
> 1. 每条必须写出处——commit hash、文件路径、函数名、实测数字。写不出出处的，不要写。
> 2. 「修好了」必须有负向证据：把 bug 放回去，测试/硬门要变红。只跑一次绿灯不算。
> 3. 数字冲突时以最新实测为准，并在条目里说明旧数字为什么错。

---

## [0.1.0] - 2026-10-30（骨架落地，commit `28c85ae`）

> **一次提交装下整个产品**：35 个文件、3682 行。12 个角色定义、五份规格 + 一份上游设计稿、2 个 ADR、
> 2 个脚本、4 个模板、CI 工作流。
> 重点不在「文件齐了」，而在**首次提交之前就跑过一次真实语料**：2021 个 transcript、239,549 次 tool_use、
> 237,567 个相邻调用间隔。三条写在规格里的判据被这组数字当场推翻，改完才落盘。

### Added

- **12 个角色定义**（`.claude/agents/*.md`，共 723 行）：planner / executor / research / critic / redteam /
  review / acceptor / probe / safety / relay / repair / resolution。只读不靠 prompt 自觉：
  `acceptor`、`probe`、`safety`、`review`、`redteam`、`critic` 六个角色的 `tools` 里没有 `Edit`/`Bash`；
  `probe` 与 `safety` 连 `Write` 都没有。这条约定由 `check-structure.mjs` 的 `checkAgents()` 机械验证
  （`READONLY_ROLES` + `WRITE_TOOLS` 两张表），而不是靠声明。
- **调度入口** `.claude/skills/oversight/SKILL.md`（91 行）：Phase A 规划 → Phase B 并行编队 → 冲突登记 →
  验收 → 接力草稿。首次运行问 5 件事（监控范围 / 触发条件 / 口吻 / 禁止操作 / ADHD 友好输出），
  用户不答则按默认执行但必须声明「按默认执行」。**Agent 独立性靠不给路径实现**，不靠在 prompt 里写
  「请不要读同级输出」——后者是请求，前者是事实。
- **五份规格**（`docs/spec/`）：`state-model.md`（252 行，四态判定唯一真源）、`dispatch-contract.md`、
  `evidence-discipline.md`（finding 四件套）、`relay-protocol.md`、`output-format.md`；
  外加 `original-design.md`（309 行上游设计稿，作为被修正的对象保留）。
- **两个 ADR**：`0001-config-only.md`（为什么不做常驻进程）、`0002-honest-degradation.md`
  （状态 **Proposed**，用户批准前与规格冲突处以它为准）。
- **`scripts/scan-sessions.mjs`（500 行）**：从 transcript 事后重建会话状态。零依赖、只读、
  不写任何文件。「眼睛」的全部逻辑都在这一个文件里。
- **`scripts/check-structure.mjs`（262 行）**：结构硬门，6 项检查——可发布区零盘符、私有区必须被
  `.gitignore` 排除、`.gitignore` 不得排除产品本体、agent frontmatter、无空目录、README 必须声明
  「不能自动接力」。第 3 项专门针对参考项目的致命陷阱：那个项目忽略 `.claude/`、`rules/`、`tasks/`，
  对它正确，照抄过来会让 `git add -A` 静默什么都不加。
- **`scripts/state-model.test.mjs`（238 行 / 23 条）**：覆盖归一化、持久化变更识别、novelty、
  自适应阈值、四态优先级、冷启动、休眠。
- **4 个模板**（`templates/`）：`dispatch.md`（三段式派发公共段）、`acceptance-criteria.md`、
  `findings.md`、`relay-message.md`。
- **CI**（`.github/workflows/validate.yml`）：结构门与四态测试是硬门；脚本语法检查与死链检查标
  `continue-on-error`，理由写在文件里——「存量未清零前不阻塞」。

### Fixed（三条判据被实测推翻，发生在首次提交之前）

- **固定 180s 心跳阈值会误判 63.1% 的会话**。规格 §5.2 要求「心跳间隔 > 3 分钟 → FAILED」。
  实测 237,567 个间隔：至少出现一次 >180s 的会话 **1275 / 2021 = 63.1%**，全部间隔中 >180s 占 **9.72%**，
  分位数为 p50 = 14s、p90 = 174s、**p99 = 1444s**。按原文执行，六成以上会话会被判死至少一次——
  正是规格开篇要消灭的「误判 → 全量重跑 → 再误判」死循环换了个触发源。
  改为**会话自适应**：`clamp(p95(该会话自身间隔), 120s, 900s)`；样本 < 20 不下 FAILED，只标
  `liveness: insufficient-sample`。实现见 `scan-sessions.mjs` 的 `heartbeatThreshold()`。
- **novelty 原公式只描述 Read 类工具，对 62.3% 的调用恒为 0**。原式是
  `新 (file_path, offset, limit, pattern) 组合数 ÷ 窗口调用数`。实测工具分布 Bash **62.3%**、Read 15.0%、
  Edit 10.4%、Grep 5.9%、Write 2.0%、Agent 1.5%、Glob 0.7%。Bash 的入参是 `{command, description}`，
  **没有** `file_path/offset/limit/pattern`，签名恒等 → 分子恒为 0 → novelty 恒为 0 → 连续 3 窗 < 0.2
  → 正常跑 `mvn`/`git`/`node` 的 Agent 被判 `STALLED`。
  改为**按工具类型分签名**再加权平均（权重取实测占比，见 `DEFAULT_WEIGHTS`）；Bash 先归一化
  （取首词、剥绝对路径/数字/长字符串）再取 SHA-256 前 12 位。
- **`PRODUCING` 原定义含 `Bash`，纯探索没有通过路径**。原文 `PRODUCING = 有 Write/Edit/Bash/最终交付物`，
  而 `ls`、`git status`、`grep`、`cat` 全是 Bash。后果链是死的：纯探索 → 判 PRODUCING → 送验收 →
  无交付物 → 不通过 → 修复 Agent 无输入 → 3 轮后提交失败报告；而 `EXPLORING` 又规定「严禁重跑」。
  改为「产生了**持久化变更**」：成功的 `Write`/`Edit`，或 Bash 命中写入类动词表，且显式排除
  `git status|log|diff|show|branch`、`mvn -v`、`npm ls`、`ls`、`cat`（`READ_LOOKALIKES`）。
  判定改为**有序互斥**，状态 0 是宿主权威 `failed`——宿主说失败才算失败。

### Fixed（验收期抓到的两个「脚本在真实数据上不可用」）

- **DF-001：`normalizeBash` 正则指数回溯，扫描脚本挂死**。原实现
  `/(["'])(?:\\.|(?!\1).){40,}\1/g` 在 `'` + 连续反斜杠上不可终止：实测 `'` + 60 个反斜杠 →
  **90 秒超时**；真实语料里一条 472 字符的 `grep` 单次归一化 **17,897ms**；`--days 3` 与
  `--project MCServers` 均 60s 超时（exit 124）。README 的 30 秒上手命令直接挂住——产品唯一的
  「眼睛」在真实数据上不可用。
  改为手写线性状态机 `stripLongStrings()`，O(n)：病态输入 0.3–4.2ms，`--days 3` 全量扫描 13s。
  回归测试「归一化在病态输入上是线性的」保留在 `state-model.test.mjs`。
- **DF-002：休眠会话被误判为 FAILED**。实测反例 `[FAILED] Projects/rea ... hb=515s/120s idle=72.3h`：
  末次间隔超过 p95=120s，但整体已空闲 72.3 小时——它是结束了，不是失败了。判 FAILED 会触发一次
  毫无意义的重跑，而且是假警报。
  加 `DORMANT_MS = 1h` 新鲜度闸门：超时判 `EXPLORING` + `reason: dormant` + `liveness: stale`。
  **顺序有讲究**：休眠必须排在宿主权威 `failed` 之后，否则一个真失败过的会话会因时间久远被降级成
  「只是睡着了」。

### Notes

- 首次提交时：`23/23` 测试通过，结构门绿，验收 r2 **12/12** 条通过。
- **ADR-0002 是 Proposed 不是 Accepted**。它逐条推翻了上游设计稿的判据，但推翻的合法性需要用户批准；
  在批准前，`docs/spec/*` 与它冲突处以它为准。这条状态是刻意保留的，不是忘了改。
- 能力边界写在 README 顶部而不是附录：`--bg --resume <session-id>` 对**运行中**的会话会「starts a copy」，
  跨会话消息强制标注来源，因此**本库不能自动接力**。Relay 产出草稿，用户复制发送。
  这一条同时否掉了上游 §1「会话写入不可降级」——如实声明，而不是假装满足。

---

## [0.1.1] - 2026-10-30（数据层修复，commit `2d38a93`、`78f8f2b`）

> **这一版修的不是判据，是判据的输入。**
> 0.1.0 的三条判据在 2021 个 transcript 上验证过，逻辑是对的；但 `scan-sessions.mjs` 有三个字段
> 「外观像测量值，实际永远拿不到真值」。判据再对，喂进去的是空的，结论就是空的。
> 红队 run 一次抓出四个缺陷，全部先复现、再修、再写负向测试。

### Fixed（数据层三个字段在撒谎）

- **DF-005：`badLines` 恒为 `undefined`**。`out.badLines = bad` 把计数挂在**数组属性**上；
  `tailRecords()` 用 `slice(-n)` 返回新数组，属性丢失；`extractCalls()` 又返回另一个新数组，
  再丢一次。最终 `scanned.mainCalls.badLines` 永远是 `undefined`——一个恒假的「坏行数」字段。
  这正是 `output-format.md` 自己禁止的东西：**外观像遥测、实际编造**。
  改为 `parseJsonl()` 返回 `{ records, badLines }`，逐层显式传递，子 agent 的坏行数累加进主会话
  （`scanSessionDir()` 里 `badLines += parsed.badLines`）。
- **DF-006：`failed` / `blocked` 会话完全不可见**。实测三个数据源互不一致：

  | 数据源 | 条目 | 状态取值 |
  |---|---|---|
  | `~/.claude/jobs/<id>/state.json` | 12 | done=9 **failed=1 blocked=2** |
  | `claude agents --json` | 10 | blocked=2，其余 state 为空 |
  | `~/.claude/sessions/*.json` | 8 | 只有 busy / idle |

  扫描器只读了第三个，于是**扫描结果 8 条，实际 12 条**，1 个 failed、2 个 blocked 永远不显示。
  用户看着「全绿」，实际有三个会话停着。**这是本库作为「监督之眼」的根基性缺陷**。
  更糟的是接线也是断的：0.1.0 的 `main()` 调用 `judgeState` 时写的是硬编码的
  `sessionState: undefined`，所以 `state-model.md` §2 里那条「状态 0：宿主权威 FAILED，
  优先于一切推断」**从来不可能被触发**——规格写了，代码没接。
  新增 `readJobs()`，按 `linkScanPath` 里的 sessionId 建映射，并把 `hostState` 传进 `judgeState`；
  新增 `BLOCKED` 态（等输入既不是失败也不是探索，按 EXPLORING 处理会让用户以为它还在干活）。
  验证：`--days 30` 输出 `BLOCKED=2 FAILED=1`，此前为 0。
- **DF-007：子 agent 漏掉 37%**。`scanSessionDir()` 只遍历 `subDir` 的直接文件，
  3220 个 jsonl 中 **1190 个**在 `subagents/workflows/<wf-id>/` 下。会话 `3068431b` 报 `sub=28`，
  实际远多于此——派生树是残缺的，而 `maxDepth`、`tree_gain` 都建立在这棵树上。
  改为递归 `collectSubagentFiles()`；同时输出 `subagentsTotal` 与 `subagentsTruncated`，
  终端显示 `30/272~` 而不是骗人的 `30`。**截断可以存在，静默截断不行。**

### Fixed（硬门自己失效）

- **DF-009：硬门不检查脚本能不能被 Node 解析**。把 `const WINDOW = 20;` 改成 `const WINDOW = ;`，
  整个 `scan-sessions.mjs` 不可解析，`node --check` 报 `SyntaxError`，而 `check-structure.mjs`
  仍然输出「✓ 结构检查全部通过」并 exit 0。**一个在代码根本跑不起来时还绿的硬门，不是硬门。**
  新增 `checkSyntax()`：对 `scripts/*.mjs|js` 逐个 `spawnSync(process.execPath, ['--check', p])`。
  负向测试：注入语法错误后 exit 1。

### Changed

- **预算口径：能拿到真实 token 的会话不许再标 `est:`**。ADR-0001 §代价·4 曾断言「子 Agent 的 token
  消耗不可查，所有预算必须估算」。这对**后台作业**是错的：`~/.claude/jobs/<id>/state.json` 带真实的
  `tokens` 字段，实测 `3475667`、`2731240`、`1330604`、`965387`。报告现在打印 `tok=3476k`。
  规格 §7 同步改写：前台交互会话仍需估算并标 `est:`；能关联 job 的会话显示真实数字。
  **用估算值替代已有的精确值是倒退**，会让整条状态行显得比实际更不可信。
- **blocked 会话的 `needs` / `suggestedReply` 进入 CLI 输出**。宿主已经在 `state.json` 里写好了
  「在等什么」与「建议怎么回」（实测原文：「要我现在就把用户实测单交给你，还是你先看这四份测试报告？」
  /「把实测单发给我」）。Relay Agent 不必从零发明草稿，只需**补全 + 结构化**宿主已有的半成品。
  CLI 现在把这两个字段原样打印。

### Notes

- 测试 **23 → 26**（`2d38a93` 的 body：`26 tests pass (3 new for blocked precedence)`）。
  新增 3 条：blocked 单独成态、blocked 优先于休眠（等输入 2 小时仍是 BLOCKED）、
  failed 优先于 blocked。台账登记 DF-005..011。
- **这一版让 0.1.0 的判据第一次有了可信的输入**：novelty 的分母不再缺 37% 的调用；
  FAILED 分支第一次能真的被宿主信号触发；坏行数第一次是数字而不是 `undefined`。
  在此之前，「判据正确」是一句无法证伪的话。
- 仍未解决：`--recalibrate` 写在使用说明第 15 行，但 `main()` 只解析 `--json` / `--project` /
  `--days`，传进去被静默忽略（DF-003）。

---

## [0.2.0] - 2026-10-30（TUI，commit `b7ce5f4` … `d774543`）

> **产品第一次有「界面」。** 之前只有一份文本输出；这一版加了 1068 行的交互 TUI
> （`scripts/oversight-tui.mjs`，后续修复增到 1074 行）+ 342 行的视觉层（`scripts/tui-theme.mjs`）
> + 173 行视觉规格，一次提交 1876 行。
> 代价是：**渲染器读的是不可信输入**。transcript 里的项目名、session id、reason 全部来自磁盘，
> 而终端把 ESC 序列当命令执行。这一版的绝大部分修复都在这一点上。

### Added

- **交互 TUI**：j/k 或 ↑/↓ 移动、Enter 进详情、Esc 返回、c 复制接力草稿、r 刷新、? 帮助、q 退出。
  只做渲染——**不判定状态、不计算 novelty、不修改任何文件**，所有数字来自
  `scan-sessions.mjs --json` 的原样输出（ADR-0001 的「策略与执行同源」在这里的具体含义）。
- **三通道视觉语言**（`docs/spec/tui-visual.md`）：每个状态同时用字形、颜色、文字编码。
  理由是 WCAG 2.1 准则 1.4.1「Use of Color」——而 `FAILED`（红）与 `PRODUCING`（绿）恰好是最典型的
  红绿混淆对；颜色在管道、`TERM=dumb`、灰度截图里还会整层消失。**颜色是装饰，不是信息载体。**
- **字形被实测推翻过一次**：初稿用 `✕`（U+2715）与 `◐`（U+25D0）。实测 Windows Terminal / mintty
  正常，**conhost + PowerShell（Consolas）渲染成豆腐块**；查字体 `cmap`：Consolas、Lucida Console、
  Cascadia Mono、Cascadia Code 四款**都没有**这两个码位。换成 `×`（U+00D7）与 `○`（U+25CB），
  四款字体原生存在，三处终端实测均正常、均占 1 列。规则写进规格：新增字形必须同时验证
  cmap 覆盖 / 真实渲染 / 列宽为 1，缺一项不算通过。
- **`checkImportable()` 成为第 8 项硬门检查**：`node --check` 只查语法，查不到「调用了一个不存在的
  函数」——例如把 `wrapToWidth` 的循环变量改了一半，语法全绿、结构门全绿，按 `?` 打开帮助却抛
  `ReferenceError`。做法是真的 `import()` 一次并调用导出函数，调得通才算过。

### Fixed（OSC 52：只读渲染器能改你的剪贴板）

- **第一处（`b7ce5f4`）**：`truncateToWidth()` 逐码点拷贝，它的 `stripSgr()` 只匹配 CSI，而宽度测量
  用的却是 `tui-theme` 里更宽的 `ANSI_RE`。于是 `\x1b]52;c;<base64>\x07` 藏在 `reason` 或 `needs`
  里能**原样到达终端**：一段 transcript 内容就能让一个只读渲染器改写系统剪贴板。
  新增 `sanitize()`（剥掉所有 ANSI 序列、删除残留裸 ESC、把 C0 控制符替换成 `·` 但保留 `\n`/`\t`），
  覆盖 `project` / `reason` / `needs` / `suggestedReply` / `jobDetail`；`stripAnsi()` 从 `tui-theme`
  导出为单一真源，TUI 不再自带一份更窄的本地实现。
- **第二处（`c1d0490`，验收 r3 阻断）**：上面的修复只覆盖了五个字段，`sessionId`、`project`、
  `hostState` 仍在裸奔。`sessionId` 直接来自 transcript 文件名
  （`entry.replace(/\.jsonl$/,'')`），完全外部可控；假数据 `sid\x1b]52;c;eA==\x07end` 进详情页后，
  终端收到完整 OSC 52 序列——**只要按 Enter 就触发**，攻击面比第一处更宽。
  七个字段统一过 `sanitize()`；`buildDraft()` 的出口也净化，因为它的产物既显示又进剪贴板。
- **负向证据**：删掉任一 `sanitize()` 调用，测试套件变红。这是本轮唯一被接受的「修好了」证明。

### Fixed（TUI 的另外两个阻断）

- **DF-012：非 TTY 分支因契约变更整段失效**。`defaultScan` 从返回 Promise 改成返回
  `{ promise, cancel }` 之后，`main()` 仍写 `const { data, warning } = await scan(...)`——
  await 一个对象得到它自己，`data` 恒为 `undefined`。实测 `node scripts/oversight-tui.mjs | cat`
  输出「扫描失败：undefined」，stdout **0 字节**，exit 1。文档里写明的 `| cat` 与 `--plain`
  两种用法全部不可用。
  改为 `const job = scan(...); await job.promise;`。**这是第二次「改了函数契约，漏了一个调用点」**
  （r1 的 `charWidth` 是第一次），所以顺手把 `printPlain()` 改成接受可注入的 `sink`——
  它此前硬写 `process.stdout`，测试根本观测不到输出，才让这个回归活到了验收。
- **列表头的 liveness 是一句硬编码的谎**。原来固定打印 `liveness=reconstructed`，而默认窗口 19 个
  会话里 **17 个是 stale**。现在按真实分布渲染：`liveness stale=17 reconstructed=2`。
  写作本文时实测为 `stale=15 reconstructed=4`（19 个会话）——这个数字会变，硬编码不会。
- **按 q 退出要等扫描跑完**。`execFile` 没有取消，按 q 恢复了终端但进程还在等扫描结束：
  实测空窗 **11.5s**，`--days 30` 时可达 **110s**，用户以为卡死。
  `defaultScan` 改为返回 `{ promise, cancel }`，`close()` 调 `cancel()`；用一个永不 resolve 的
  scan 实测退出耗时 **228ms**。

### Changed

- **`displayWidth` 合并到 `tui-theme`**，TUI 不再自带一份。此前两份实现已漂移过一次：
  字形表 `BLOCKED` 用了 `▲`（规范里是 `STALLED` 的）、`FAILED` 用了 `✕`（conhost 下是豆腐块）。
- **子 agent 树显示真实比例**：`30/272~` 而不是 `30`。
- **非 TTY 输出可注入 sink**，为测试而改的产品代码——这是本轮唯一一次「为可测性让步」，
  理由写在 DF-012 里：不可观测的输出等于没测。

### Fixed（硬门第二次失效：白名单只覆盖 9/23）

- **`checkImportable` 的前缀白名单形同虚设**（`d774543`）。原过滤器是
  `/^(wrap|truncate|parse|build|glyph|state|badge|pad|display)/`，验收 r2 实测只覆盖
  **9 / 23** 个导出——`sanitize`、`detailLines`、`judgeState` 从来没被调用过。
  直接验证：把 `stripAnsi` 换成 `noSuchFn`，硬门**保持绿色**，而十条测试变红。
  改成**副作用黑名单**：默认探测所有导出，只跳过 `main` / `printPlain` / `copyToClipboard` /
  `run` / `exec` / `spawn` 等会起进程或写终端的名字。理由有实测支撑——朴素地调用每个导出要 **15s**，
  其中 **12.6s** 耗在 `oversight-tui` 的 `main` 上。
  同时在探针里 `await` 异步导出：此前一个 reject 的 async 导出会逃逸成未处理拒绝，
  让硬门以**错误的理由**失败。
  验证：`sanitize` 里放 `noSuchFn` → exit 1（由 `detailLines` 捕获）；`judgeState` 里放
  `noSuchHelper` → exit 1。两处在改之前都是静默的。门耗时 3.3s（本机今天复测 5.6–6.4s，含 7 个脚本）。

### Notes

- **验收走了 r1 → r4 四轮，每轮都在同一层翻车**（此处的 r1–r4 是 **TUI 阶段**的轮次，
  与 0.1.0 / 0.1.1 数据层验收用的 r1 / r2 不是同一批，别把两套编号混读）：
  - r1：`wrapToWidth` 调用了不存在的 `charWidth`——改函数时漏改调用点。
  - r2：量出 `checkImportable` 只覆盖 9/23 个导出，硬门在真 bug 面前是绿的。
  - r3：两个阻断，都是**自己引入的回归**——`sessionId`/`project`/`hostState` 未净化；
    非 TTY 分支因契约变更失效。
  - r4：11/11 通过，但验收同时指出「把 `sessionId` 的 `sanitize` 变异掉，测试仍然全绿」。
    这不是可以记一笔就走的「已知缺口」：同一个变异证明了详情页能泄漏 OSC 52，而当时 55 条测试里
    **没有一条进过详情页**（`ed239cf` 的 body 写的是 “nothing in 20 tests”，与逐文件实数的 55 不符；
    以 55 为准，结论不变）。于是导出 `detailLines()` 并加 3 条测试（全字段 OSC payload、
    2/7 截断比例、blocked 会话的 needs/suggestedReply），变异现在会让套件变红。
- **测试曲线**：`b7ce5f4` **52**（26 + 17 + 9，sanitize 向量 + 退出取消）→ `c1d0490` **55**
  （三条直接调 `main()`）→ `ed239cf` **58**（`detailLines`）。每个新守卫都做过变异测试。
  ⚠️ commit body 里的起点写的是「46」，按仓里 `scripts/*.test.mjs` 逐文件数找不到这个组合
  （`b7ce5f4` 之前只有 `state-model.test.mjs` 的 26 条）——**以可复算的 52/55/58 为准**，
  「46」疑似混入了别的统计口径。这正是本文件要求「每条可复算」的原因。
- **一次提交事故，如实记录**：`2063bf6` 把 `charWidth(cp)` 卷进了 `wrapToWidth`。那是一次变异测试的
  编辑，我没还原：备份文件是在**更早一次变异之后**存的，所以「还原」把坏版本复制了回来，`git add -A`
  把它提交了。工作区后来手工修好，缺陷只存在于历史里。
  **硬门抓到了它**（`checkImportable` 会调用每个导出函数）——但只在提交**之后**，因为我在变异**之前**
  跑的门。`9cd2b9f` 修复。此后规则：变异一律用 `git checkout -- <file>` 还原，绝不用临时副本；
  每次提交前再跑一次门。
- **仍未覆盖**（DF-014 当时状态）：App 层 0 条直接测试，键位路由（4 种 mode × 13 个键）、滚动窗口、
  窄屏拆列全裸。r3 的两个阻断都出在这一层。

---

## [Unreleased] - 2026-10-30（0.2.0 之后已提交的三项 + 欠账）

> 以下三项已在 `main` 上提交并通过全套测试，但尚未分配版本号——按项目约定，
> 等「能扫、能判、能看、能出草稿」闭环后再定版。

### Added

- **App 键位路由的 20 条测试**（`0a1901a` + `fe47496`，`scripts/app-router.test.mjs`，242 行）。
  `App` 从私有类改为导出，测试直接构造 App、喂按键、断言状态迁移：列表导航与边界、Enter/Esc 迁移、
  详情滚动含 pgup/pgdown、帮助面板按 `prevMode` 返回来源、q 与 ctrl-c 的区分、空数据不崩。
  **不启真实终端、不跑真实扫描**：stdout/stdin 用 `PassThrough`，`write` 直接吞掉；只有两条冒烟测试
  调真实渲染（100 列与 20 列各一次）。
  这是 DF-014 的主体修复：**r3 的两个阻断都出在这一层，而在它之前 58 条测试一条也没进过它。**
  文档同时记录：6 个变异（Esc 不重置滚动 / 帮助固定回列表 / move 去掉上下界 / pgdown 步长 /
  空列表 Enter 不判空）全部被抓。
- **`--recalibrate` 真正实现**（`53f27e9`，`recalibrateWeights()` + `main()` 分支）。
  这个 flag 从 0.1.0 起就写在使用说明第 15 行，但 `main()` 只解析 `--json` / `--project` /
  `--days`，传进去被静默忽略（DF-003）——**文档承诺了一个不存在的功能，持续了整个 0.1.x**。
  现在它统计本机实际工具分布，打印可直接粘回源码的 `DEFAULT_WEIGHTS` 字面量，并报告表外工具占比
  （>15% 时警告）。空输入返回 `null` 而不是全零。
  它立刻证明了存在的必要：三天语料给出 Bash **0.75** / Read 0.09 / Edit 0.09，而写死的全量权重是
  **0.62 / 0.15 / 0.10**。**权重会随工作方式漂移**，这不是理论担忧。

### Changed

- **测试总数 58 → 78 → 81**：20 条路由测试，3 条 `recalibrateWeights` 测试。写作本文时实测
  `node --test scripts/*.test.mjs` 为 **81/81 通过**（约 3.7s），结构门 exit 0。

### Notes（已知问题与欠账，按严重度排序）

- **DF-004 的台账条目已经过期**：它仍写着「权重重估没有可执行路径（见 DF-003）」，而 DF-003 已标
  `fixed`（`53f27e9`）。台账状态与事实不一致，下轮必须一并收口——**台账撒谎比代码撒谎更难发现**。
- **DF-008：`MAX_SUBAGENTS = 30` 截断派生树**。单会话实测有 **272** 个子 agent transcript，
  截断后 `maxDepth`、`tree_gain` 都建立在残缺的树上。现在至少显式暴露（`30/272~`），
  但上限该不该提高没有结论——需要实测不同上限下的耗时曲线（`--days 3` 全量扫描实测 14.4s）。
- **DF-011：接力协议没有把宿主给的原料列为一等输入**。`relay-protocol.md` §5 至今未提
  `needs` / `suggestedReply`，而 CLI 已经在打印它们。规格与实现各走各的。
- **DF-014 残留**：滚动窗口（`listOffset` 的跟随逻辑）与窄屏拆列的**视觉正确性**仍未覆盖
  （路由测试只验证「20 列不崩」，不验证「20 列好看且不重叠」）。
- **`padDisplay` 的断言有 +1 松弛**：`tui-theme.test.mjs` 写的是
  `displayWidth(padded) <= width + 1`，即最多允许溢出 1 列。这是 b7ce5f4 自己记下的遗留项，
  仍未被收紧——一条允许失败的断言，等于没有断言。
- **文档漂移：README 的目录地图没有 TUI**。`scripts/` 只列了 `scan-sessions.mjs` /
  `check-structure.mjs` / `state-model.test.mjs`，`oversight-tui.mjs`、`tui-theme.mjs`、
  `app-router.test.mjs`、`docs/spec/tui-visual.md` 全部缺席。产品已经有一个 1074 行的主界面，
  而仓库的**门面**假装它不存在（`docs/GUIDE.md` 有完整说明，但它目前是工作区里的未跟踪文件，
  尚未提交，README 也没有链接过去）。
- **数字漂移（两处，都是旧值没跟着改）**：`tasks/accepted-deviations.md` AD-003 写「180s 会误判
  **63.8%**」，而 ADR-0002 / state-model / README 一致为 **63.1%（1275/2021）**；
  `scripts/scan-sessions.mjs:35` 的注释写「本机 **1978** 会话」，文档一致为 **2021 个 transcript**。
  两处都不影响行为，但都会让读者以为存在第二个数据源。
- **AD-004 与 ADR-0001 的修正冲突**：AD-004 仍写「所有预算数字必须带 `est:` 前缀」，
  而 ADR-0001 §代价·4 已修正为「能关联 job 的会话显示真实 `tokens`」。同一件事在两份文档里
  说法相反，且都还在仓里。
- **CI 里有两条已经过时的建议门**：`validate.yml` 的「Script syntax (advisory)」与
  「Dead links (advisory)」标着 `continue-on-error`，理由是「存量未清零」。现在
  `check-structure.mjs` 的 `checkSyntax()` 已经是硬门，前一条只剩重复劳动；后一条从未清过存量。
  要么升级为硬门，要么删掉——**一条永不变红的检查会让人误以为被检查过**。
- **没有任何 tag 和 Release**。`git tag -l` 为空。上表所有版本号都是工作阶段代号，不是可安装的版本。

---

## [Unreleased] - 2026-10-31（回滚之后：说清楚它到底能做什么）

> 触发点是一次锐评：**4/10**。核心指控是「四态模型在真实运行里没有产生过一条可用信号」。
> 我复算了它的关键论据，两条成立、一条被夸大，然后按成立的部分改了代码和全部对外文档。
> 这一阶段的主题不是加功能，是**删掉不成立的推断，并把宣称收窄到实测范围内**。

### Removed（删掉一条会自己发明失败状态的推断）

- **`hb_gap` → `FAILED` 推断删除**（`d90a39d`）。`judgeState` 原先在「末次间隔超自适应 p95 且停够 60 秒」时判 `FAILED`。
  真实运行发出 5 条通知，**5 条全是它发明的误报**——对应会话分别在 13 秒 / 151 秒 / 411 秒后继续工作，
  其中一条报「失败」时正在跑 `sleep 240`。
  - **数字更正（`cdf4329`）**：删除时引用的「3390/3390 大间隔后都恢复，100% 误报」是**同义反复**——
    相邻两次调用之间有间隔，定义上第二次调用就发生了，测的是自己的前提。
    正确问法是「大间隔后还有没有 tool_use」：**5977/6308 = 94.8%**。结论不变，证据换成了可证伪的。
- **`NOTIFY_STATES` 收窄为 `['FAILED','BLOCKED']`**（`98a6fd3`）。两者都只认 `~/.claude/jobs/*/state.json` 里宿主写的 `state`。
  `STALLED` 移出：全语料 56,809 个滑窗里只命中 **10 次（0.018%）**，129 个会话的末态里 **0 次**。
  > 这里我自己错过一次：先前说「STALLED 不可达」，依据是 129 个会话的 novelty 最小值 0.60。
  > 那只看每个会话**最后三个**窗口。扫遍所有窗口就有 10 次命中。**「不可达」和「可达但罕见」导致不同的决策**，
  > 两个数字现在都写进规格。

### Fixed（两个实例互相打死对方的 tick）

- **`--dry-run` 落盘导致 rename EPERM**（`c9f743f`）。`--dry-run` 只抑制发送，仍走 `saveState`，
  与真身抢同一个 `state.json.tmp-<pid>` → `rename` 报 EPERM → **整个 tick 挂掉**（不是少发一条通知）。
  实测：一个 `--dry-run` 跑了 6 小时，真身三次 `tick-failed`。
  - 修复：dry-run 不再落盘；`saveState` 对 EPERM/EBUSY/EACCES 退避重试 4 次，最终失败时清理 tmp 并抛出
    「很可能有第二个实例」的可读错误，而不是裸 EPERM。
  - 负向证据：去掉 dry-run 守卫 → 51 条中 1 条变红；恢复 → 全绿。新增两条测试覆盖。

### Changed（宣称收窄到实测范围）

- **README 重写核心章节**（`5074bda`）。原文把四态模型当卖点，但 129 个会话的末态是
  `EXPLORING` 122 / `PRODUCING` 4 / `BLOCKED` 2 / `FAILED` 1 / `STALLED` 0——**有行动价值的只有宿主那两条**。
  现在开头一句话是「把 30 个会话压成一张表，并在宿主明确报错时叫醒你」，并附实测分布表说明别看状态机。
- **README 三个数字修正**：「2021 个 transcript / 63.1% 会话有 >180s 间隔 / p99=1444s」
  重算为 3,354 个 transcript、**52.7%**、**p99=331.6s**。旧数字不可复现。
- **`state-model.md` 与代码对齐**：它自称「唯一真源」，却仍把已删的心跳推断列为生效规则、`reason` 枚举仍允许 `hb_gap=`、
  且**完全没提 `BLOCKED`**。三处全改，并新增 §2.0.1（为什么删）、§2.0.2（STALLED 真实命中率）。
- **`GUIDE.md` 耗时重测**：`--days 3` 从「13 秒」改为 **33.4 秒**，`--days 30` 从「48 秒」改为 **87.4 秒**。
  同一文件历史上已被改过两次（110 秒 → 40 秒 → 48 秒），说明这类数字没人重测；现标注取数日期并要求引用前重测。
  `oversight-tui.mjs --help` 的对应数字同步改为 87 秒。
- **`tui-visual.md` / `dispatch-contract.md` / `relay-protocol.md` / `CLAUDE.md` 同步**（`585bab1`）。
  `relay-protocol.md` 的触发条件依赖 `STALLED`，实际不会发生，已标注并指向真正可用的 `needs` 透传。

### Fixed（文档里两个编造的产物）

- **`install-watcher.md` 的假日志行**：曾展示 `suppressed FAILED kind=WAITING_SUBAGENT` 并称「子 Agent 完成通知约占真实停止 68%」。
  **5,373 条日志里该行出现 0 次**，且当时的日志根本没有 `kind=` 字段。已替换为真实日志。
- **`install-watcher.md` 的假 `--stats` 输出**：曾贴 6 行分类分布（16.7% 等），而当时 `observations.jsonl` 不存在。
  现只写实际输出「观察样本：0 条」，并说明 0 是预期结果。

### Changed（观察期标准改为可达）

- **原标准要 85 天才能满足**（`64a83f3`）。原文要求「≥10 条已发通知」。实测宿主事实供给率：
  25.6 天、16 个 job 文件里只有 **3 个** `failed`/`blocked` = **0.117 条/天**，攒 10 条要 **85 天**。
  - 新标准改为**可追溯性**：每一条通知都必须能在 `jobs/*/state.json` 找到对应宿主事实，**一条找不到即回退**，不设百分比阈值。
  - 「跑够了」改为「出现 1 条真实通知且 `needs`/`suggestedReply` 对得上」——这条路径是确定性的，不是统计性的。
  - Q3（300 秒门槛）**作废**：该门槛只作用于 `UNCLASSIFIABLE` 候选，而候选现在只来自宿主事实。

### Added（CHANGELOG 硬规则终于有门了）

- **`checkChangelog()` 加入结构硬门**（`scripts/check-structure.mjs`，`ac362c9` + 自指豁免 `2e4850b`）。本文件开头写着「任何代码/配置/文档的更改，都必须记入本 CHANGELOG」，
  但在此之前**没有任何检查执行它**。实测有 27 个提交改了源码或规格却没留条目——包括我自己这一阶段的全部 5 个。
  - 做法：取「最后一个被本文件引用的 commit」到 HEAD 之间的提交，若改动了 `scripts/`、`.claude/`、`docs/`、`templates/` 等
    却无 hash 记录，直接 fail。
  - 用 hash 而不是日期或行数：本文件本来就要求「每条必须写出处——commit hash」，既然要求写，就该能验证在不在。
  - **负向证据**：把本文件回退到上一版，门报出 27 个未记录提交；恢复后通过。
  - **自指豁免**：`HEAD` 本身永远检查不了——提交无法在自己的内容里写自己的 hash。
    不加这条，任何修改本门的提交都会把自己判违规，只能再提交一次去记上一个，无限后退。
    代价是最新一个提交是盲区，下一次提交时纳入检查。

### Added（台账格式门，以及真正登记了 5 个开放项）

- **补登 5 个开放项**（`tasks/dev-findings.md` DF-015…DF-019）。此前 14 条**全部是 `[fixed]`**，看起来干干净净，
  实际是「没人往里面加」。这一阶段明确发现却未修的问题一个都没进台账。
  新增：DF-015 角色定义零引用 `watch.mjs`（监控与调度没接上）、DF-016 设计文档 970 行无实现、
  DF-017 在线分类 95.4% 失效、DF-018 抑制准确率无测量、DF-019 `needs` 覆盖稀疏。
- **`checkLedger()` 加入结构硬门**（`97533e6`）。只验证格式，不判断「该有多少 open」——那是判断不是事实。
  检查：条目状态必须在枚举内；`accepted-deviations.md` 每条必须写明不修的理由（没写理由的偏差就是一条待办）；
  全 fixed 时给出**提示但不阻塞**（可能是真的修完了，也可能是没人登记，值得每次看见）。
  - **负向证据**：把 DF-015 的状态改成 `[broken]`，门报出「不在枚举内」；恢复后通过。
### Added（第一个在生产里测、阈值先写死的指标）

- **通知可追溯率**（`watch.mjs --trace`，`traceability()` + `readJobStates()`）。
  锐评 agent 的及格线是「有一个指标是在生产里测出来的而不是回放模拟的，且阈值在测之前就写死」——
  此前**一条都不满足**。现在有了第一个：每条通知都必须能在 `~/.claude/jobs/*/state.json` 找到对应的
  `failed` / `blocked` 记录，**阈值 100%，不设百分比宽容**（理由：一条误报的代价是用户开始忽略所有通知，是断崖式的）。
  - **实测结果：0/5，判定 FAIL。** 五条通知全部不可追溯，且全部发生在 `hb_gap` 推断被删除之前。
    这不是巧合而是**结构性必然**：推断出来的「卡住」在宿主账本上根本不存在。
  - 删除 `hb_gap` 是这个指标唯一能通过的路径。当前架构候选只来自 `jobs.state`，按构造必然通过。
  - **诚实的边界**：5 条样本证明了旧架构不合格，**没有**证明新架构合格。新架构的合格是构造上的，不是实测的。
  - 完整分析：`docs/research/2026-10-31-first-production-metric.md`。
  - **变异验证**（两条）：把「必须是 failed/blocked」放宽成「有记录即可」→ 1 条测试红；
    把空样本的 `ratio` 从 `null` 改成 `1`（即「没发通知算通过」）→ 1 条测试红。
  - 空样本返回 `null` 而非 `1.0`：**没机会犯错不等于没犯错**，CLI 对此明确输出「这不是通过」。
### Fixed（CHANGELOG 门第一版会造成无限后退）

- **重写 `checkChangelog()` 的判定规则**。第一版是「找最近一个被引用的 hash 作为边界，检查它之前的提交」+「豁免 HEAD」，
  实际跑起来发现**每次提交之后门都变红**：新提交本身没法写自己的 hash（结构上不可能），所以它永远是新违规项；
  去修它就要再提交一次，于是又产生新的违规项。**无限后退。**
  这是它第一次在真实提交序列上运行就暴露的 —— 单测或手工试跑都看不出来，因为没有「连续提交」这个维度。
- 现在的规则两条：**边界**取「最近一次修改 CHANGELOG 的提交」（只查它之后的），**自文档豁免**：
  改动了 `docs/CHANGELOG.md` 本身的提交视为已记录。剩下的才是真欠账。
- **负向证据**：造一个只改 `scripts/watch.mjs`、不动 CHANGELOG 的提交，门报出「1 个提交改动了源码但没有条目」；
  撤销后通过。
- **诚实的代价**：历史欠账不追溯（那 37 个提交）。这条门只保证**从今往后**不再漂移，不声称过去的账已经平了。
### Added（逆向宿主，找到真正的「等待」信号）

- **`WAITING` 状态**。逆向 `claude.exe` 2.1.270 后发现宿主的状态是三态不是两态：
  `wS = { running: "busy", requires_action: "waiting", idle: "idle" }`。
  `waitingFor` 由 `bVo()` 判定，取值 `input needed` / `dialog open` / `permission prompt` /
  `worker request` / `sandbox request` / `goal proposal`。
  - **我此前的注释写死「busy / idle」，`waiting` 从未被读出来。** 实测后果：一个
    `status:"waiting", waitingFor:"input needed"` 的会话等了 **23 天**，被 `judgeState` 判成
    `EXPLORING / dormant`——**它在等人，系统说它在睡觉**。
  - 修复：`readLiveSessions()` 读 `waitingFor`；`judgeState` 新增 `WAITING` 且**排在 `dormant` 之前**
    （dormant 是「没在做事」，waiting 是「在等你」，后者信息量更大且可行动）；
    `probeWaiting()` 进 L-fast 1 分钟层；`NOTIFY_STATES = ['WAITING','FAILED','BLOCKED']`；
    TUI 字形 `!`；列表页行尾直接显示 `← 正在等你（input needed）`。
  - **这是唯一「动作方向明确」的信号**：`failed` 告诉你该重跑，`waiting` 告诉你该回话。
    其余所有状态都只是描述。而且它是**实时**的——用户一回话就消失，不像 `jobs.state` 会留着陈旧值。
  - **变异验证**（三条）：删掉 `WAITING` 分支 → 3 条测试红；把它移到 `dormant` 之后（复现原始 bug 的排序）→ 1 条红；
    把 `busy` 也当成候选 → 1 条红；去掉活跃窗口闸门 → 1 条红。
  - 完整逆向过程（含字节偏移与源码摘录）：`docs/research/2026-10-31-reverse-engineered-waiting-signal.md`。
- **更高层分类读不到**：宿主还有 `status_category` / `status_detail` / `needs_action` 三级分类，
  但它们只走 `reportMetadata`（远端桥接），**不落本地盘**。验证：全部 transcript 里 `post_turn_summary`
  只出现在 2 条 user 记录的工具返回内容里，没有 `{type:"system", subtype:"post_turn_summary"}` 记录。
### Notes（生产状态目录被清空，历史归零）

- **`%LOCALAPPDATA%Overwatch` 整个目录消失**，含 `state.json`、`watch.log`（5,348 行 / 438 KB）、
  `runner.log`、`start-watch.vbs`、`notify/`。发现时 watcher 进程仍在运行。**原因未查明**，
  没有证据指向具体操作，不写推测。
- **后果**：`--trace` 的 5 条通知样本没了（第一个生产指标退回「无样本」）；`observations.jsonl`
  没了（P0 观察期唯一产出）；13 小时 tick 记录没了。**全程没有告警**——watch 继续跑，
  `mkdirSync(recursive)` 静默重建目录。
- 已手工重建目录、重建启动脚本、重启 watcher（`tick jobs waiting`，waiting 探针已在跑）。
- 登记为 DF-020（目录丢失无告警）与 DF-021（无任何持久化/备份机制）。
- **这次损失改变了一件事的份量**：此前「第一个生产指标」的 5 条样本虽然判定 FAIL，
  但它是唯一一次真实生产测量。现在要靠重新积累。**这也是为什么不能把「等一条真实通知」当验收标准**——
  它又贵又脆。
### Added（状态丢失不再无声无息）

- **见证文件 + 启动完整性检查**（DF-020 修复）。状态目录被清空时，此前唯一的迹象是
  「日志突然变短」——而 `loadState` 把缺失当空状态、`mkdirSync` 静默重建目录，
  **外部看一切正常**。
  - 做法：在状态目录**外面**放兄弟文件 `<stateDir>.witness.json`，记录 `firstSeenAt` /
    `lastSavedAt` / `saves`，每次保存后更新。判定 `witness.saves > 0 && 无 state.json` → 丢失。
  - **放在目录外是关键**：放里面则目录被删时一起没了，就分不出「首次运行」和「数据丢了」。
  - **不退出**：告警后照常重建并继续监控——监控坏了的第一反应不该是「干脆不监控」。
    我最初提的方案是「拒绝启动」，写代码时意识到那是错的，改了。
  - **dry-run 不弹通知**：试跑契约「只算不发」对告警同样成立；日志仍记 `state-lost`。
    （这是写的时候真踩到的：第一版直接 `await notifier(...)`，`dry-run` 测试当场变红。）
  - **端到端演练**：真实目录 `mv` 走后启动，日志输出 `state-lost: 见证文件显示 14 次保存`；
    恢复后重启无误报，`firstSeenAt` 保持不变。
  - **测试抓到自己的 bug**：见证路径最初写成 `dirname(dirname(stateDir))`，对任意目录会塌到
    公共父目录，测试之间互相污染（一个临时目录的见证写进了 `%LOCALAPPDATA%`，让真目录误报丢失）。
    改成兄弟文件后对所有目录形状都成立。
  - **变异验证**（三条）：`lost` 恒 false → 4 条红；去掉每次保存的见证更新 → 1 条红；
    见证放回目录内 → 2 条红。
- 遗留：`--strict`（丢失时硬失败）尚未实现，登记为 DF-022；持久化/备份仍是 DF-021。
### Fixed（通知链路在真实 waiting 事件上跑通，代价是发现三处缺陷）

- **`WAITING` 端到端演练**：写入一个真实的 `status:"waiting"` 会话文件，守护进程在 75 秒内抓到并**真的发出了通知**：
  `notified WAITING ... sent=1`，观察日志记 `state=WAITING kind=UNCLASSIFIABLE notified=true`。
  这是整条链路（probe → 分派 → 通知）第一次在真实进程里走完。演练文件已删除。
  代价是暴露了三处缺陷，全部当场修掉：

  1. **`notifyTitle` 把确定的等待说成猜测。** 旧版先看 `kind`，而分类器对 `sessions/` 候选必然返回
     `UNCLASSIFIABLE`（那里没有对应停止点），于是标题印成「疑似停滞（判不出类型）」。
     现在宿主事实状态优先于分类结果：`✋ demo · 正在等你（input needed）`。
  2. **宿主事实被分类门与时间门误拦。** 一个刚等 5 秒的真实 `WAITING` 候选，被 `classifyCandidate` 判成
     `UNCLASSIFIABLE` 后撞上 5 分钟时间门，按「刚停下，再等等」压掉。新增 `HOST_FACT_STATES`
     （`WAITING` / `FAILED` / `BLOCKED`）—它们是宿主写的，不是推断的，**跳过两道门**。
  3. **可追溯性指标查错了数据源。** `--trace` 只查 `jobs/`，于是 `WAITING` 通知**必然**被判不可追溯。
     端到端第一次就暴露：`notified WAITING` 之后 `--trace` 报 0/2。

- **顺带删掉 L-full 的定时全量扫描。** 候选来源收敛到宿主事实后，`candidatesFromScan` 的产出恒为空集
  ——`WAITING`/`FAILED`/`BLOCKED` 都来自宿主文件，L-fast 每分钟已完整读过。
  实测连续三次 `full=28159ms / 21543ms / 19106ms`，每次 `candidates=0`：**一天烧约 25 分钟 CPU 换零个候选**。
  现在只在 `--full` 时跑（排查工具，不是常驻开销）。同时修掉一个由它引出的缺陷：
  「全量同轮到期就跳过增量」的优化在无全量时会让**首次变化永远不被扫描**。

- **可追溯率的口径修正**：`WAITING` 是**瞬时**状态，会话文件随即被覆盖、会话结束时被删。
  事后去查「它现在还 waiting 吗」，答案几乎必然是否——那不是通知发错，是这个状态**在事后不可验证**。
  现在 `WAITING` 不计入分子分母，单独计数。当前输出：
  `可判定通知 0 条…另有 2 条 WAITING 事后无法验证` → `判定：无样本 —— 这不是通过，是还无法判定`。

- **变异验证**（五条）：关掉宿主事实旁路 → 1 红；全部旁路 → 6 红；恢复 30 分钟全量 → 1 红；
  把标题判据移回分类之后 → 3 红；把 WAITING 重新计入可追溯率 → 1 红。
### Fixed（轮转不再删数据，DF-021）

- **两处「只留一份」的轮转改成归档、永不覆盖。** 观察期的全部价值来自积累，而旧实现每轮转一次就
  永久删掉更早的一份：
  - `observations.jsonl` 超 5 MiB → 覆盖 `observations.jsonl.1`
  - `watch.log` 超 1 MiB → 覆盖 `watch.log.1`
  - 量化：日志均 91 字节/行、约 **511 KB/天**，即**每两天丢一次日志**；
    观察记录均 356 字节/条，5 MiB ≈ 14,727 条。
  现在每次轮转写入 `observations.<ISO>.jsonl` / `watch.<ISO>.log`，从不删除。
  读取端（`--stats` / `--trace`）一并聚合全部归档，否则「攒够样本」永远攒不够。
- **顺带修掉一个被持久化掩盖的指标缺陷**：`traceability` 只读当前 `watch.log`，
  于是**两天前的通知会从分母里消失**——指标会随日志轮转「自己变好」。
  这是修轮转时才想到的，不是测出来的。
- **测试也顺手修了一个假保证**：旧测试名叫「轮转到 .1，旧内容不丢」，但它只断言 `.1` 存在，
  **从没验证过内容完整**。新的断言是「写 40 条必须能全部读回，一条不少」。
- **变异验证**（两条）：把观察日志轮转改回覆盖 → 1 红；把日志轮转改回覆盖 → 1 红。
- **仍未做**：异地副本（DF-021 残留风险）。归档仍在同一块盘同一目录，同一次清理会一起没。
  README 不声称「有备份」，只说「轮转不覆盖」。
### Notes（持久化演练：数据活了，启动器死了）

- 真实演练：把 `%LOCALAPPDATA%Overwatch` **整个删除**，验证两件事。
- **成立的部分**：见证文件在目录外，**在整目录删除中存活**（记录了 360 次保存）；
  从快照恢复 `state.json` 后重启，`checkStateIntegrity` 正确返回 `lost: false`，**无误报**。
  跨归档读取也验证过：写入 30 条跨 2 个归档 + 1 个当前文件，读回 30 条，`--stats` 看到 30 条。
- **演练暴露的新问题（DF-022）**：`start-watch.vbs` **住在它要保护的那个目录里**，
  所以目录一删，启动器跟着没了——**监测系统自己起不来了**。告警逻辑再完善也没用，
  因为没有任何东西在运行。我是靠手工重写启动脚本才恢复的。
  这比「数据丢失」更糟：数据可以重新积累，起不来则连积累的机会都没有。
- 未修，因为启动器放哪里是产品决策（仓库脚本生成到别处 / 用户指定稳定路径 / 系统服务）。
### Fixed（DF-022：启动器搬出数据目录）

- **启动器不再住在它要保护的那个目录里。** 旧安装说明让人把 `start-watch.vbs` 写到
  `%LOCALAPPDATA%\Overwatch\`——那正是数据目录。2026-10-31 演练中整目录一删，
  **启动器和数据一起没了，监控系统起不来**。数据能重新积累，起不来则永远没有积累的机会。
- 现在三处分离：
  - 模板 `scripts/install/start-watch.vbs.template`（版本控制，纯 ASCII）
  - 产物 `scripts/install/start-watch.vbs`（由 `node scripts/install-watcher.mjs install` 渲染，
    含本机路径，已 gitignore）
  - 开机自启 `<Startup>/Overwatch Watch.lnk` → 指向产物
- `install-watcher.mjs` 支持 `status` / `install` / `uninstall`，零依赖。
  用临时 `.ps1` 而不是 `powershell -Command` 建快捷方式——路径里的中文与空格在命令行传参时会被二次解析。
- **端到端演练**：删掉整个数据目录后，从仓库启动器一次成功重启，日志同时给出
  `state-lost: 见证文件显示 434 次保存`。**「站得起来」和「知道自己丢过东西」这两件事现在同时成立。**
- **结构门新增 `checkLauncherPlacement()`**：模板必须存在、必须含两个占位符、必须纯 ASCII，
  产物必须在仓库内。负向测试：往模板追加中文注释 → 门报「模板含非 ASCII 字符」。
- **测试**：`install-watcher.test.mjs` 9 条，含一条用 `cscript` 真解析渲染结果（跳过非 Windows）。
  三个变异被抓：把启动器路径改回数据目录 → 1 红；去掉双引号转义 → 1 红；模板加非 ASCII → 1 红。

### Changed（分类器不再在无效的地方空转，DF-017）＋ 台账状态一致性检查

- **宿主事实候选不再调用分类器。** 不是「分类器不准」，而是它对这类候选**结构上不可能有效**：
  `classifyStop` 需要一个 transcript 停止点，而 `WAITING` 来自 `sessions/*.json`，
  那些会话可能根本没有可读的尾部。实测对真实 WAITING 候选调用，100% 返回
  `kind=UNCLASSIFIABLE` + `classify=error`。
- 代价不是零：每轮都去读 transcript 尾部，产出一行「找不到该会话的 transcript」写进观察日志。
  实测 6 条观察记录里 5 条是这种噪音，唯一有信息量的 1 条也不影响通知
  ——因为宿主事实本来就跳过分类门。
- 分类能力保留：将来若重新引入基于 transcript 的推断状态，它立刻重新有用。
- **`--stats` 现在标出「旧策略时期的行」**：`byClass` 统计 classify 取值，
  检出 `classify=error` 时明确说明这些行不会再产生、但会稀释比例。
  不加这条的话，分布图看起来像当前行为，实际跨了两个不同的策略时期。
- **结构门新增台账状态一致性检查**：标题 `[open]` 与正文 `**状态**：fixed` 必须一致。
  2026-10-31 实测 DF-020 就是这种不一致——而台账是「还有多少债」的唯一来源，
  不一致的台账比没有台账更坏。负向测试：把标题改回 `[open]` → 门报「状态不一致」。
- **变异验证**（三条）：让宿主事实重新调用分类器 → 1 红；把 `stale` 恒置 0 → 1 红；
  不统计 `byClass` → 1 红。

### Added（DF-015：监控与调度接上了，用一份数据两个消费者）

- **`watch.mjs --inbox`**：调度侧读后台的发现。不引入新存储——`state.notified` 本来就是
  持久化的去重表，现在它同时是收件箱。**一份数据，两个消费者**，不会分叉。
- 收件箱条目带上 `needs` / `suggestedReply` / `project` / `idleSec`，
  `formatInbox()` 明确标注「逐字，不要改写」（`relay-protocol.md` §5.1 的要求）。
- **`SKILL.md` 新增 §0「先看后台发现了什么」**，排在扫描之前，并按状态分路：
  有 `suggestedReply` 的直接抄给用户、只有 `needs` 的派 relay、`needs` 为空的派 probe。
- **`oversight-relay` / `oversight-probe` 改为先读收件箱再自己扫。**
  probe 的触发条件从「STALLED」（实测 0.018% 命中）改为「收件箱里 WAITING 但 needs 为空」。
- **结构门新增 `checkInboxWiring()`**：SKILL.md 必须引用 `--inbox`、至少一个 agent 必须知道它、
  脚本必须真的实现它。文档写了但没人调用，和没写是一样的。负向测试：把 SKILL.md 里的
  `--inbox` 替换掉 → 门报「后台发现又接不上了」。
- **写的时候抓到自己一个 bug，而且是这个功能的要点**：第一版直接拿 `state.notified` 当收件箱，
  于是 4 个**早已变回 `busy`** 的会话被报成「正在等你」。
  `state.notified` 是**历史表，不是现状表**——条目会留到 TTL 过期。
  现在 `buildInbox` 必须传入当前宿主状态对账，是「历史 × 现状」的交集；
  读不到 `sessions/` 时标 `unverified` 而不是假装确定。
  这正是 DF-015「两半各说各话」的新版本，只是方向反了。
- **变异验证**（四条）：不排除已 ack → 1 红；不按 idleSec 排序 → 1 红；
  不做 WAITING 对账 → 1 红；不标 `unverified` → 1 红。

### Fixed（安装器清理数据目录里的旧启动器副本）

- 升级到 DF-022 布局之后，`%LOCALAPPDATA%\Overwatch\start-watch.vbs` 还留着一份**旧副本**。
  它能跑，但跑起来就回到了「启动器和数据住在一起」的旧布局，**而且不会有任何提示**。
  修复留了一个后门，等于没修。
- `install-watcher.mjs install` 现在会检测并删除这个副本，删不掉时明确警告而不是静默跳过。
- 实测：运行后数据目录里只剩 `state.json` / `watch.log` / `runner.log` / `notify/` / `launcher.log`。

### Fixed（观察日志六小时没生成——记录被静默丢弃）

- **回归来源是我上一轮的改动。** 为了让宿主事实不调用分类器（DF-017），
  `obs` 恒为 null，而每一处记录都是 `if (obs)` 守卫 → **通知照发，观察日志一条不写**。
  `observations.jsonl` 六小时没生成，我却在看 `--stats` 报 0 条并以为「还没有真实数据」。
  **记录与分类是两件事，不能因为不分类就把记录一起丢掉。**
- 现在宿主事实生成自己的记录：`kind` 就是状态本身，`classify: 'host'` 与 `ok`/`error` 区分开。
- 新增两个字段（都能从候选免费拿到，缺了事后分不清来源）：
  - `source`：`jobs` / `sessions` —— 判断哪条管道更准
  - `waitingFor`：宿主原话 —— `input needed` / `dialog open` / …
- **端到端验证**：写入真实 `status:"waiting"` 会话文件 → 守护进程 80 秒内抓到 →
  `notified WAITING ... sent=1`；第二次因 `budget-global-10min` 被抑制但仍留记录。
- **变异验证**：回到「宿主事实不生成 obs」→ 2 条测试红。

### Notes（为什么之前查不出是终端卡住而不是没数据）

- 排查时发现常驻进程 `lastJobsScanAt` 停在六小时前，而进程存活。
  手工 `--once` 立刻抓到候选并发出通知——**代码是对的，进程卡住了**。
- 这暴露一个更基本的问题：**我没有一个「守护进程还活着且在工作」的指标**。
  「进程存在」和「进程在干活」是两件事，而我一直在用前者。
  已登记 DF-023。

### Added（DF-023：存活指标——区分「进程死了」和「进程卡住了」）

- **`watch.mjs --health`**。判据来自调度周期本身，不是拍的：
  L-fast 每 1 分钟 → 超过 **3 个周期**（3 分钟）没写 `lastJobsScanAt` 就是 stale；
  L-mid 每 5 分钟 → 超过 **3 个周期**（15 分钟）同样。
  取 3 个而不是 1 个：单次 tick 可能因扫描慢而推后，1 个周期会误报。
  超过 3 个周期还没动静，就不是「慢」，是「停了」。
- **输出明确区分两种故障**：「进程死了」与「进程活着但卡住了」。
  DF-023 记的正是后者——2026-10-31 进程 CPU 在涨，但六小时没扫描，
  而我一直在用「进程存在」当作「在监控」。
- **复现验证**：构造 `lastJobsScanAt` 为六小时前 → `--health` 报
  「判定：**没有在工作**」，并逐层列出超限时长。
- **接进 `install-watcher.mjs status`**：装好了但没在跑是最容易忽略的情况，
  安装状态必须和存活状态一起看。
- **接进 `SKILL.md` §0**，排在收件箱之前：判定不健康时先修守护进程，
  否则「收件箱为空」会被误读成「一切正常」。
- **结构门 `checkInboxWiring()` 扩展**：SKILL.md 必须引用 `--health`，脚本必须实现它。
  负向测试：替换掉 `--health` → 门报「无法区分进程死了和进程卡住了」。
- **变异验证**（两条）：`stale` 恒置 false → 2 红；只取 1 个周期（会误报）→ 1 红。

### Fixed（收件箱第二个假阳性：已恢复的会话仍被报为失败）

- 实测：一个会话早在正常工作（`live.status='busy'`），但 `jobs/state.json` 里那条 `failed`
  记录还在，收件箱就把它报成「需要人处理」。
- 根因：`jobs/*/state.json` 记录的是**最后一次作业的结果**，不是会话的当前状态。
  第一版对账只判断「会话是否还存在」，没判断「它是否已经恢复」。
- 现在：会话仍活着且 `busy` → 旧失败记录算过时。**`idle` 不算过时**——
  那可能正是失败之后停在那儿等你看。
- 这是收件箱的第二个假阳性（第一个是 `state.notified` 被当成现状表）。
  两次都是同一个病根：**把「曾经发生过」当成「现在仍然如此」**。
- 变异验证：去掉 busy 判定 → 2 条测试红。

### Added（DF-016：设计文档有了索引，且入口指向它）

- **`docs/design/README.md`**：逐份标注状态，并给出 `hosted-mode.md` 的
  **「哪节已实现 / 哪节没有」对照表**。此前这三份文档在仓库里是孤岛——
  `README.md`、`CLAUDE.md`、`docs/spec/*` **零引用**，读者只有直接点进去才看得到。
- 对照表里每个 ✅ 都**在代码里核对过**，不是凭印象：
  §2 → `classify-stop.mjs`、§4.2 → `reasonClass()`、§4.3 → 三个 INTERVAL 常量、
  §4.4 → 三个限额常量、§4.5 → `delivery === 'failed'` 不重试。
  §1 策略 schema、§3 投递、§5 分阶段实施 → 都**未实现**。
- **说清 §3 为什么永远做不到**：ADR-0001 已证明自动投递不成立。
  凡是以「自动接力」为前提的设计（§1 分级、§3 投递、§5 演进）
  都建立在一个不成立的前提上。保留是因为数据有价值，不是因为还能实施。
- **`README.md` 与 `CLAUDE.md` 都加了指向**，README 那段直接写「它们一行代码都没实现」。
- **结构门新增 `checkDesignIndex()`**，守三件事：索引存在、每份设计文档都被索引提到、
  索引里必须有「未实现」字样。负向测试两条：去掉 README 的指向 → 门报错；
  索引里删掉一份文档名 → 门报「没有被索引提到」。

### Fixed（TUI 看不见正在等你的会话）

- **主界面对 `WAITING` 完全失明。** 实测：一个 `status:"waiting"` 的会话在
  `scan-sessions` 的人读输出里正确显示 `← 正在等你（input needed）`，
  但 TUI 列表里**完全没有它**。
- 根因：TUI 只读 `data.sessions`（transcript 扫描结果），而这个会话**没有 transcript**——
  它只存在于 `sessions/*.json`。而**正在等你这件事，恰恰常常发生在会话还没写多少 transcript 的时候**。
  主入口看不见它，等于这个功能是瞎的。
- 现在由 `mergeLiveSessions()` 合并两个来源，只补 `WAITING` / `BLOCKED` / `FAILED`
  （其余状态没有 transcript 就没有信息，补进来是噪音）。
- **顺带修掉三个连带问题**：
  - `STATE_ORDER` 是本地硬编码的第二份状态表，没跟上 `tui-theme.STATES`，
    于是 `WAITING` 显示成 `UNKNOWN`——**比不显示更糟，看起来像数据坏了**。现在从 `STATES` 派生。
  - `calls` 为 null 时显示 `calls=0`，是在撒谎（可能是 0 次，也可能是没扫）。现在显示 `—`。
  - 路径里的控制字符会破坏终端渲染，现在替换成空格。
- **我自己在同一件事上栽了第三次**：先只改了 `App.sessions()`，
  纯文本路径 `printPlain` 仍直接读 `data.sessions`，于是同一个会话
  在交互界面出现了、在 `| head` 输出里还是看不见。
  抽成 `mergeLiveSessions()` 让两条路径只能调同一个函数，
  并加了一条测试断言「至少两处调用」。
- **变异验证**（两条）：`printPlain` 改回裸读 → 1 红；`App.sessions` 改回裸读 → 1 红。

### Fixed（显示路径普查：四个视图各有一个 WAITING 相关缺陷）

把 `WAITING` 加进来之后，没有任何检查覆盖所有**显示路径**。逐个查完，四处都有问题：

| 路径 | 缺陷 | 后果 |
|---|---|---|
| 列表行 | `STATE_ORDER` 硬编码、不含 WAITING | 显示成 `UNKNOWN`，看起来像数据坏了（上一轮已修） |
| 列表行 | `calls` 为 null 时印 `calls=0` | **撒谎**：可能是 0 次调用，也可能是没扫（无 transcript） |
| 详情页 | `liveness` 未过 `sanitize` | 外部数据可注入 ANSI，只读渲染器能改写剪贴板 |
| 详情页 | `liveness: 'live'` 不在规格枚举里 | 自造了一个规格外的取值 |
| 接力草稿 | 不看 `state`，一律印「正在等待」 | **`FAILED` 会话被说成在等你**，复制出去是错的 |
| 帮助文本 | 仍写「本界面不计算任何状态」 | 与事实相反，会让人以为 TUI 不补充任何东西 |
| `--json` | `live` 条目没有 `state` 字段 | 只读 `sessions` 的调用方**静默漏掉**只在 live 里的 waiting 会话 |

修法：
- `calls` 未知显示 `—`；`liveness` 过 `sanitize` 且 `live` 补进规格枚举。
- 草稿措辞跟着状态走：`WAITING`「正在等待」/ `BLOCKED`「受阻，在等」/ `FAILED`「已失败，停在」。
- 帮助文本改成如实描述（「这三类会从宿主实时状态补进列表」）。
- `live` 条目补 `state`，两个数组**形状一致**，调用方可以只读一个字段。

**验证**：新增 6 条显示路径测试。**四个变异全部被抓**（草稿回退 → 1 红；`calls` 回退 → 1 红；
`liveness` 不净化 → 1 红；帮助文本回退 → 1 红）。
其中 `liveness` 的变异**第一次没抓到**——因为测试用的是干净值，过不过 `sanitize` 都一样；
补了一条带 OSC 52 的测试才关住。

### Fixed（派发链路普查：两个断点）

按照"显示路径普查"同样的方法查了派发链路（`SKILL.md` → planner → agent → 产出），
发现两处断点。它们都不是读代码能看出来的。

**断点一：`oversight-probe` 定义了却从不被派发。**
角色定义存在、触发条件还专门改过，但 `SKILL.md` 零引用——触发条件永远不会生效。
后果：`WAITING` 但 `needs` 为空时直接派 relay，relay 拿不到「在等什么」只能编。
修：路由表补「先 probe 再 relay」；结构门新增 `checkAgentReachability()`，
任何角色定义了却不被派发直接 fail。

**断点二：`task-graph.json` 的 schema 写了，产物从不校验。**
`oversight-planner.md` 里 schema 完整，但没有任何东西检查产出符合它。
**第一个真实 run（`2026-10-30-p0`）就漏了三个必填字段**：`token_budget_pct` / `parallel_with` / `depends_on`。
修：新增 `scripts/validate-run.mjs`（12 条测试），把 schema 变成可执行检查；
SKILL.md 要求「先校验再派发，不通过退回 planner，不要自己补字段」；
结构门保证这条引用不被删。**三个变异全部被抓。**

**校验器抓出的第二个问题——阈值是我编的**：第一版写「≥5 个子任务就算复杂」，
把一个真实的 2 任务 run 判违规。但那个 run 是合理的：一次小改动不需要 5 个 Agent。
CLAUDE.md 说的是「复杂任务」，而「是不是复杂」是规划时的判断，不是数字推断。
把阈值硬塞进校验器只会训练人绕过它。改成调用方显式传 `requireComplex`。

**顺带发现**：`tasks/runs/` 整个被 gitignore（含会话 ID），所以历史派发产物不在仓库里，
无法回溯。审计记录改放在 `docs/research/2026-11-01-dispatch-chain-audit.md`。

### Fixed（换台机器/换个目录跑起来的三个障碍）

方向：先让它在别处能跑。实测把仓库复制到临时目录，发现三处问题。

**1. 没有桌面通知通道时，系统完全静默。**
非 Windows（或 wscript 缺失）时，旧代码把 notifier 换成必抛错的函数，
于是每个候选 → `notify-failed` → `delivery: 'failed'` → **永不重试**。
系统发现了会话在等你，然后什么也不做，只在日志留一行 ERROR。
现在退回**终端输出**（写进 runner.log），走成功路径标记 `delivery: 'submitted'`，
不会被永久吞掉。真正的发送失败仍标 `failed`——兜底不等于掩盖故障。

**2. 同一台机器上两份克隆静默共用同一个 `state.json`。**
`defaultStateDir()` 是固定路径，**完全不看仓库位置**。正常情况这是对的
（换目录、换版本不丢数据），但两份克隆会互相覆盖、抢 `rename`、发重复通知，
而没有任何提示。实测：把仓库复制到临时目录跑，`--health` 报的是原仓库进程的数据。
不改变路径，只让冲突可见：新增 `owner.json` 归属标记，
检测到不同仓库时 ERROR + WARN，并给出 `OVERWATCH_STATE_DIR` 隔离方法。

**3. 安装器在非 Windows 上会拼出不存在的路径。**
`startupDir()` 无条件拼 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`，
在别的平台上 `install` 会静默建出一串垃圾目录、假装装好了。
现在非 Windows 返回 null，并给出**实测可用的替代做法**：
macOS 的 launchd plist、Linux 的 systemd user unit，以及「不配守护进程就跑 `--inbox`」的退路。

**端到端验证**：仓库复制到临时目录 + 独立 `OVERWATCH_STATE_DIR` → 扫描、health、
`owner.json`、日志全部正常，且不碰原仓库的数据。

**变异验证**：冲突检测恒 false → 1 红；通知兜底（两条：兜底走成功路径、真失败仍标 failed）。

### Fixed（首次打开 TUI 会等 26 秒，而文案说 10 秒）

- 实测：本机 33 个会话，首次扫描 **26.0 秒**。旧文案写「正在扫描…（首次扫描约 10 秒）」。
  **一个刚拿到仓库的人会等 26 秒，等到第 12 秒就开始怀疑卡死，然后 Ctrl-C。**
- 现在首次扫描期间显示：
  - **实时已等待秒数**（每秒更新），而不是写死的估计
  - 实测预期（「本机 33 个会话约 26s，语料越多越久」）
  - 「这不是卡死——`q` 可随时退出」
  - 不想等时的退路：`node scripts/scan-sessions.mjs --days 3`
- 摘要一条：`2929a9f` README 新增「在别处运行」一节（平台差异、数据目录共用与隔离）。

### Added（不依赖宿主的信号：`asked.mjs`）

**方法换了。** 前三次尝试（novelty、心跳间隔、停止分类）都是**先造指标，再拿语料验证**，
验证时才发现它测的东西在真实分布里极其稀少。这次反过来：**先看分布，再决定造什么。**

**先看的分布**（170 个 transcript、2,528 条真人消息、2,363 次接话）：

- 真人消息长度 **p50 只有 34 字符**，45% 不到 30 字符
- 短消息（打断/确认）里 **97% 前面没有任何工具调用**——AI 是在**说完话之后**被接住的，不是干活时被打断
- 每次接话前 AI 最后一句**是问句的只占 12.5%**……

**关键结论：87.5% 的「停下来」，AI 并没有在问任何问题——它只是说完了，人走开了。**

这解释了之前所有失败：任何以「停久了 = 有问题」为前提的指标，
都会把这 87.5% 的正常结束误判成异常。`hb_gap` 5/5 误报、novelty 0.018% 命中，都是这个结构性错配。

**所以信号只能是「AI 问了具体问题，没人回答」**——这一类可以完全从 transcript 判断，
不需要宿主。`node scripts/asked.mjs`。

**必须排除的两类**（都是实测出来的）：
- **开场客套**（「今天想做点什么呢喵？」）——永远不会有人回，实测 18 个里 7 个是这种
- **刚问完的**——人可能正在看，默认门槛 1 小时

**实测结果**：本机 5 个真实待决策会话，最早 11 小时前，最晚 21 天前。
逐个核对过，全是「AI 干完活、给了具体选项、等你拍板」。

**接入**：`SKILL.md` §0.6 排在收件箱之后（宿主不报的会话在这里补），结构门守住引用。

**写的时候修了两个自己的错**：
- `endsWithQuestion` 第一版写成「最后 300 字里有问号」，把「这是什么？反正做完了。」误判成问句。
  改成「问号之后没有实质内容」。
- 测试 fixture 自己写错了（文本结尾不是问句），函数是对的——改 fixture 不是改函数。

### Added（`asked.mjs` 历史：哪些问题被回答了、平均多久）

- 单次快照只能回答「现在谁在等我」，回答不了「**这东西到底有没有用**」——
  哪些提醒后真的被处理了、我平均多久回一次。没有后两个数字，就无法判断该不该继续提醒。
- 每次运行自动记入历史（`%LOCALAPPDATA%\Overwatch\asked-history.json`，
  与 watch 的状态目录同源，**不写仓库**）。`--history` 看统计，`--no-save` 只查不记。

**「已回答」的判据来自实测分布**（492 个真实问答对）：
回复延迟 **p50 = 0.83h，p90 = 14.7h，99% 在 24 小时内**。
所以「超过 24 小时没答」不是「还在考虑」，是「被忘了」——历史里单列这个数。

**写的时候两次踩到同一个坑：把「不知道」当成「已经答完」。**

1. 第一版用「这次没扫到」判已回答。`--hours 9999` 一跑，5 条全被判已回答、
   延迟算出 **0 小时**——被门槛过滤掉的和真回答的混在一起了。
   改成 `stillAsking: Map<sessionId, boolean>`，由扫描自己报告每个会话是否仍以问句结尾。
2. 第二版把 `Boolean(r && !r.skipped)` 塞进那个 Map，于是「被门槛过滤」又被记成 `false`，
   同样误判。改成只看「是否仍以问句结尾」，**与门槛无关**。
3. 守卫写成 `stillAsking.get(id) === false` 而不是 `!get(id)`——
   Map 里查不到表示「不知道」（比如 transcript 被删了），不能当成「已不再问」。

**变异验证**：`stillAsking` 判据恒真 → 1 红；`=== false` 放宽成 `!get()` → 1 红；
24h 阈值恒 false → 1 红。另外发现 `seen.has(key)` 那条守卫是**冗余的**
（`stillAsking` 已覆盖），删掉并注释说明为什么不需要它。

### Notes（已知且不打算近期修）

1. **在线停止分类 95.4% 判 `UNCLASSIFIABLE`** —— 结构性，分类器需要「下一句」而在线时下一句还没发生。
2. **抑制准确率无自动测量** —— 需要一个「回访」机制，属 P1。
3. **`needs` 覆盖稀疏** —— 16 个 job 里只有 2 个带 `needs`、1 个带 `suggestedReply`。
4. **12 个 agent 角色（743 行）中只有 2 个引用 `scan-sessions.mjs`，零个引用 `watch.mjs`** ——
   监控与调度两半仍未接上。锐评指出「970 行设计文档对应 0 行代码」，本阶段没有解决。

## 版本对照

| 版本 | 日期 | commit | 一句话 |
|---|---|---|---|
| `0.1.0` | 2026-10-30 | `28c85ae` | 骨架 + 五份规格 + 两个脚本；三条判据被 2021 个 transcript 推翻 |
| `0.1.1` | 2026-10-30 | `2d38a93`、`78f8f2b` | 数据层三个字段不再撒谎；硬门开始检查「脚本能不能解析」 |
| `0.2.0` | 2026-10-30 | `b7ce5f4` … `d774543` | TUI；OSC 52 与契约回归的四轮修复；硬门第二次失效被抓 |
| `[Unreleased]` | 2026-10-30 | `0a1901a`、`fe47496`、`53f27e9` | App 路由 20 条测试；`--recalibrate` 落地 |
| `[Unreleased]` | 2026-10-31 | `d90a39d` … `585bab1` | 删心跳推断与 STALLED 通知；修双实例争用；README/规格宣称收窄；观察期标准改为可达 |

## 取数方式

本文件中所有数字都可用以下命令复算：

```bash
git log --format='%h %ad %s' --date=short          # commit 与日期
git show <hash> --stat                              # 单次改动的文件与行数
node --test scripts/*.test.mjs                      # 写作本文时 192/192
node scripts/check-structure.mjs                    # 写作本文时 exit 0
node scripts/scan-sessions.mjs --days 3             # 工作区 19 个会话
node scripts/scan-sessions.mjs --recalibrate --days 3   # 当前语料的工具分布
```

比例类数字（63.1%、9.72%、p99=1444s、62.3% 等）来自 2026-10-30 对 2021 个 transcript 的一次实测，
**随会话增长会变**；引用时请连同样本量一起引用，不要只引百分比。
