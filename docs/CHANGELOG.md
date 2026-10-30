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

## 版本对照

| 版本 | 日期 | commit | 一句话 |
|---|---|---|---|
| `0.1.0` | 2026-10-30 | `28c85ae` | 骨架 + 五份规格 + 两个脚本；三条判据被 2021 个 transcript 推翻 |
| `0.1.1` | 2026-10-30 | `2d38a93`、`78f8f2b` | 数据层三个字段不再撒谎；硬门开始检查「脚本能不能解析」 |
| `0.2.0` | 2026-10-30 | `b7ce5f4` … `d774543` | TUI；OSC 52 与契约回归的四轮修复；硬门第二次失效被抓 |
| `[Unreleased]` | 2026-10-30 | `0a1901a`、`fe47496`、`53f27e9` | App 路由 20 条测试；`--recalibrate` 落地 |

## 取数方式

本文件中所有数字都可用以下命令复算：

```bash
git log --format='%h %ad %s' --date=short          # commit 与日期
git show <hash> --stat                              # 单次改动的文件与行数
node --test scripts/*.test.mjs                      # 写作本文时 81/81
node scripts/check-structure.mjs                    # 写作本文时 exit 0
node scripts/scan-sessions.mjs --days 3             # 工作区 19 个会话
node scripts/scan-sessions.mjs --recalibrate --days 3   # 当前语料的工具分布
```

比例类数字（63.1%、9.72%、p99=1444s、62.3% 等）来自 2026-10-30 对 2021 个 transcript 的一次实测，
**随会话增长会变**；引用时请连同样本量一起引用，不要只引百分比。
