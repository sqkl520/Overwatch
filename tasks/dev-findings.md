# 范围外发现台账

> 执行 Agent 在**任务范围外**发现的 bug，一律**不得自行修复**，登记到这里，由主线程统一排期。
>
> 为什么要这条：不设边界时，修一个 bug 会扫出三个存量问题，修完又扫出五个，任务永远不闭环。

## 状态枚举

| 状态 | 含义 |
|---|---|
| `open` | 已登记，未处理 |
| `triaged` | 主线程已确认，待排期 |
| `scheduled` | 已进入某个 run 的拆解图 |
| `fixed` | 已修复（附修复的 run-id） |
| `wontfix` | 决定不修（必须写明理由） |

## 登记格式

```
## DF-001 [open] 一句话描述
- 发现于：run-id / agent 名
- 位置：file:line
- 证据：<原文或复现>
- 影响：<如果不修会怎样>
- 建议归属：<哪个子树 / 或「独立任务」>
```

---

## 台账

### DF-001 [fixed] `normalizeBash` 长字符串正则指数回溯，扫描脚本在真实语料上挂死

- **发现于**：验收 run（AC7），验收 Agent 实测
- **位置**：`scripts/scan-sessions.mjs` 的 `normalizeBash`
- **证据**：原实现 `/(["'])(?:\\.|(?!\1).){40,}\1/g` 在 `'` + 连续反斜杠输入上不可终止。实测 `'` + 60 个反斜杠 → **90 秒超时**；真实语料中一条 472 字符的 `grep` 命令单次归一化 17,897ms。`--days 3` 与 `--project <project>` 均在 60s 超时（exit 124）。
- **影响**：README 的 30 秒上手命令直接挂住；产品唯一的「眼睛」在真实数据上不可用。
- **修复**：改为手写线性状态机 `stripLongStrings()`，O(n)。病态输入现为 0.3–4.2ms，`--days 3` 全量扫描 13s。
- **回归测试**：`state-model.test.mjs` 的「归一化在病态输入上是线性的」

### DF-002 [fixed] 休眠会话被误判为 FAILED

- **发现于**：修复 DF-001 后重跑全量扫描
- **位置**：`judgeState()` 的 FAILED 分支
- **证据**：`[FAILED] Projects/<project-A> calls=2483 ... hb=515s/120s idle=72.3h`。该会话末次间隔 515s 超过 p95=120s，但整体已空闲 72.3 小时——它是结束了，不是失败了。
- **影响**：假警报。用户会去「重跑」一个早就完成的会话。
- **修复**：加 `DORMANT_MS = 1h` 新鲜度闸门，超时判 `EXPLORING` + `reason: dormant` + `liveness: stale`
- **回归测试**：`state-model.test.mjs` 的「长时间无活动的会话判休眠，不判 FAILED」

### DF-003 [fixed] `--recalibrate` 在文档中承诺但脚本未实现

- **发现于**：验收 run（未覆盖项）
- **位置**：`scripts/scan-sessions.mjs:15` 的用法注释、`docs/spec/state-model.md` §3.5
- **证据**：`main()` 只解析 `--json` / `--project` / `--days`，传 `--recalibrate` 被静默忽略。
- **影响**：规格说「换环境应重估权重」，但没有可执行路径。
- **修复**：新增 `recalibrateWeights()` 与 `--recalibrate` 分支，输出可直接粘回源码的 `DEFAULT_WEIGHTS` 字面量，并报告表外工具占比。实测 `--days 3` 得到 Bash 0.75 / Read 0.09 / Edit 0.09，与写死的全量权重（0.62/0.15/0.10）差异明显——正是它该存在的理由：权重会随工作方式漂移。

### DF-004 [fixed] ADR 数字已重算（权重重估后来由 DF-003 补齐）

- **发现于**：验收 run r1（未覆盖项）
- **位置**：`docs/adr/0002-honest-degradation.md`、`docs/spec/state-model.md` §3.5
- **原始问题**：ADR 中 tool_use 与间隔数曾被读成「写反」。复核后确认未写反，但数字已随会话增长过期。
- **现状**：已于 2026-10-30 重算并同步为 **2021 个 transcript / 239,549 次 tool_use / 237,567 个间隔 / 63.1% / 9.72% / p99=1444s**，三处文档一致（ADR-0002、state-model §4.1、README）。
- **已收口**：当时把「`--recalibrate` 可重算」的表述改成了「换环境应重估」；后来 DF-003 把该 flag 真正实现，所以两种表述现在都成立。

### DF-005 [fixed] `badLines` 恒为 `undefined`（挂在数组属性上，被 `slice` 丢掉）

- **发现于**：红队 run（加前端调研时）
- **位置**：`scan-sessions.mjs` 的 `parseJsonl` / `tailRecords` / `extractCalls`
- **证据**：`out.badLines = bad` 把属性挂在数组上；`tailRecords` 用 `slice(-n)` 返回新数组，属性丢失；`extractCalls` 又返回另一个新数组。最终 `scanned.mainCalls.badLines` 永远是 `undefined`。
- **影响**：前端若展示「坏行数 0」，那是一个恒假字段——正是 `output-format.md` 自己禁止的「外观像遥测、实际编造」。
- **修复**：`parseJsonl` 改为返回 `{ records, badLines }`；逐层显式传递并累加子 agent 的坏行数。

### DF-006 [fixed] `failed` / `blocked` 会话完全不可见（只读了三个数据源中的一个）

- **发现于**：红队 run
- **位置**：`readLiveSessions()` 只读 `~/.claude/sessions/*.json`
- **证据（实测）**：
  | 数据源 | 条目 | 状态取值 |
  |---|---|---|
  | `~/.claude/jobs/<id>/state.json` | 12 | done=9 **failed=1 blocked=2** |
  | `claude agents --json` | 10 | **blocked=2**，其余 state 为空 |
  | `~/.claude/sessions/*.json` | 8 | 只有 busy/idle |
- **影响**：扫描结果 8 条，实际 12 条。1 个 failed、2 个 blocked 永远不显示。用户看着「全绿」，实际上有三个会话停着。**这是本库作为「监督之眼」的根基性缺陷。**
- **修复**：新增 `readJobs()`，按 `linkScanPath` 里的 sessionId 建立映射，把 `failed`/`blocked` 传给 `judgeState`；新增 `BLOCKED` 态（等输入既不是失败也不是探索）。
- **验证**：`--days 30` 输出 `BLOCKED=2 FAILED=1`，此前为 0。

### DF-007 [fixed] 子 agent 只扫直接子文件，漏掉 `workflows/` 下的 37%

- **发现于**：红队 run
- **位置**：`scanSessionDir()` 只遍历 `subDir` 的直接文件
- **证据**：3220 个 jsonl 中 **1190 个**在 `subagents/workflows/<wf-id>/` 下。会话 `<session-id>` 报 `sub=28`，实际远多于此。
- **修复**：新增递归 `collectSubagentFiles()`；同时输出 `subagentsTotal` 与 `subagentsTruncated`，终端显示为 `30/272~` 而非骗人的 `30`。

### DF-009 [fixed] 硬门不检查脚本能否被 Node 解析

- **发现于**：同类工具调研 run
- **位置**：`check-structure.mjs`
- **证据**：把 `const WINDOW = 20;` 改成 `const WINDOW = ;`，整个 `scan-sessions.mjs` 不可解析，`node --check` 报 `SyntaxError`，但 `check-structure.mjs` 仍然输出「✓ 结构检查全部通过」exit 0。
- **影响**：硬门声称「结构有问题就红」，但脚本根本无法运行时它照样绿。写代码时一次手滑就能让唯一的自动化检查失效。
- **修复**：新增 `checkSyntax()`，对 `scripts/*.mjs|js` 逐个跑 `node --check`。负向测试确认注入语法错误后 exit 1。

### DF-010 [fixed] `--recalibrate` 后的第二处：预算结论被真实数据推翻

- **发现于**：同类工具调研 run
- **位置**：`docs/adr/0001-config-only.md` §代价·4、`docs/spec/state-model.md` §7
- **证据**：`~/.claude/jobs/<id>/state.json` 含真实 `tokens` 字段，实测 `3475667`、`2731240`、`1330604`、`965387`。
- **影响**：ADR 断言「预算只能估算，必须标 `est:`」——对后台作业是错的。用估算值替代已有的精确值会让状态行显得比实际更不可信。
- **修复**：两处文档改为「前台交互会话需估算并标 `est:`；能关联 job 的会话显示真实 tokens」。

### DF-011 [fixed] 接力草稿的原料已部分由宿主提供

- **发现于**：同类工具调研 run
- **位置**：`docs/spec/relay-protocol.md`、`oversight-relay` agent
- **证据**：blocked 会话的 `state.json` 含 `needs`（「要我现在就把用户实测单交给你，还是你先看这四份测试报告？」）与 `suggestedReply`（「把实测单发给我」）。
- **影响**：Relay Agent 不必从零生成草稿，而是**补全 + 结构化**宿主已有的半成品，成本显著降低。
- **修复**：`relay-protocol.md` 新增 §5.1（原料表 + 三条分路 + 两种典型误用）与 §5.2（relay 的输入清单）；`oversight-relay` agent 增加「有 suggestedReply 时补全而非创作」与「无 suggestedReply 时按 needs 类型分三种正确动作」；`oversight/SKILL.md` 的 Phase F 改为先分路再派发。

### DF-008 [fixed] `MAX_SUBAGENTS = 30` 截断派生树

- **发现于**：红队 run
- **位置**：`scan-sessions.mjs` 的 `MAX_SUBAGENTS`
- **证据**：单会话实测有 272 个子 agent transcript。截断后 `maxDepth`、`tree_gain` 都建立在残缺的树上。
- **决策依据（2026-10-30 实测）**：12 个最坏会话上量了耗时-覆盖曲线——cap=30 覆盖 23.7% / 11.6s；cap=50 覆盖 39.4% / 16.1s；**cap=100 覆盖 72.8% / 19.4s**；cap=200 覆盖 92.7% / 24.7s；cap=500 覆盖 99.7% / 41.9s。
- **取 100 而非更高**：本机 69 个有子 agent 的会话里 61 个在 100 以内，只有 8 个超过。四态判定只需「任一节点有增益 → 整棵树 EXPLORING」，采样足以发现增益；覆盖率低损害的是详情页画不全，不是判定错误。
- **修复**：上限提到 100，超出的仍由 `subagentsTruncated` 显式暴露；新增 `subagentsComplete` 布尔字段，让下游知道 maxDepth / novelty 是否建立在采样上。全量扫描从 11.6s 变为 17.4s。

### DF-012 [fixed] 非 TTY 分支因契约变更整段失效

- **发现于**：TUI 验收 r3
- **位置**：`oversight-tui.mjs` 的 `main()` 非 TTY 分支
- **证据**：`defaultScan` 从返回 Promise 改成 `{ promise, cancel }` 后，`main()` 仍写 `const { data, warning } = await scan(...)`——await 一个对象得到它自己，`data` 恒为 `undefined`。实测 `node scripts/oversight-tui.mjs | cat` 输出 `扫描失败：undefined`，stdout 0 字节，exit 1。
- **影响**：文档写明的 `| cat` 与 `--plain` 两种用法全部不可用；ST1-AC7 从「降级正常」变成「根本没有输出」。
- **同类前科**：r1 的 `charWidth` 也是改一半的调用点。两次都是「改了函数契约，漏了一个调用方」。
- **修复**：改为 `const job = scan(...); await job.promise;`；`printPlain` 增加可注入的 `sink` 参数（此前硬写 `process.stdout`，导致测试无法观测）。

### DF-013 [fixed] `sessionId` / `project` / `hostState` 未净化，OSC 52 仍可穿透

- **发现于**：TUI 验收 r3
- **位置**：`oversight-tui.mjs` 的 `detailLines()`、`listRow()`、详情头、`printPlain()`
- **证据**：假数据 `sessionId: 'sid\x1b]52;c;eA==\x07end'` 进入详情后，终端收到完整的 OSC 52 序列。`sessionId` 来自 `scan-sessions.mjs` 的 `entry.replace(/\.jsonl$/,'')`——即 transcript 文件名，外部可控。`project` 在 24 列内装得下 13 字节的短 payload。
- **影响**：与 DF-005 同类，但攻击面更宽：只要按 Enter 进详情就触发。
- **修复**：所有外部来源字段（`project` / `sessionId` / `reason` / `needs` / `suggestedReply` / `jobDetail` / `hostState`）统一过 `sanitize()`；`buildDraft()` 出口也净化（它的产物会进剪贴板）。

### DF-014 [fixed] App 层无直接测试（r3 两个阻断的共同盲区）

- **发现于**：TUI 锐评与验收 r2/r3
- **位置**：`oversight-tui.mjs` 的 `App` 类（约 340 行）
- **现状（2026-10-30 定稿）**：`scripts/app-router.test.mjs` 20 条直接驱动 `App`——列表导航与边界、Enter/Esc 迁移、详情滚动含 pgup/pgdown、帮助面板按 prevMode 返回来源、q 与 ctrl-c 的区分、空数据不崩、100 与 20 列两档渲染冒烟。
- **验证**：6 个变异（Esc 不重置滚动 / 帮助固定回列表 / move 去掉上下界 / pgdown 步长 / 空列表 Enter 不判空）全部被抓。
- **仍未覆盖**：滚动窗口（`listOffset` 的跟随逻辑）、窄屏拆列的视觉正确性（只验证不崩）。
- **已做**：`detailLines` 已导出并单独测试（见 oversight-tui.test.mjs）。

### DF-015 [fixed] 12 个角色定义里没有一个引用 watch.mjs，监控与调度两半没接上

- **发现于**：2026-10-31 锐评 agent（结论「4/10」的第三条指控）
- **位置**：`.claude/agents/*.md`（12 个文件，743 行）、`.claude/skills/oversight/SKILL.md`
- **证据**：在 `.claude/` 下 grep `watch.mjs` 无任何结果。只有 `oversight-probe.md` 与 `oversight-relay.md` 提到
  `scan-sessions.mjs`，其余 10 个角色对监控层零引用。SKILL.md 也只调 `scan-sessions`。
- **影响**：产品有两个部分——「守夜人」`watch.mjs`（后台常驻、发通知）与「调度流程」`SKILL.md`（主线程派发 agent）。
  **两者共享同一份判定逻辑，却互不知情。** 后台发现 `BLOCKED` 发通知，主线程的调度流程完全不知道这件事发生过；
  反过来 SKILL.md 让主线程自己扫会话，与后台守夜人重复劳动。
- **为什么不自行修**：怎么接是产品决策——让 `watch` 写一个主线程读取的状态文件、让 `probe` agent 直接读
  `observations.jsonl`、还是承认后台只做通知不参与调度。三条路的产品含义不同。
- **处置（2026-10-31 已修）**：`watch.mjs --inbox` 提供收件箱，SKILL.md §0、relay、probe 全部改为先读它。
  `checkInboxWiring()` 守住这条线不再断。

### DF-016 [fixed] docs/design/ 下 970 行描述的能力没有对应实现

- **发现于**：2026-10-31 锐评 agent（「970 行设计文档对应 0 行代码，天花板 2.5%」）
- **位置**：`docs/design/hosted-mode.md`（457 行）、`docs/design/verdict-intent-contract.md`、`docs/spec/dispatch-contract.md`
- **证据**：`docs/design/` 下三个文件共 970+ 行，描述 L1–L5 升级、意图契约、判定-意图双层。
  `scripts/` 里没有任何模块实现它们；`watch.mjs` 只做「检测 → 通知」，不做升级也不做代决策。
- **影响**：读者（包括未来的我）会以为系统具备分级升级与代决策能力。ADR-0001 已声明「纯配置库、不自动接力」，
  **但设计文档没有同步降级**，两者给出相反的印象。
- **为什么不自行修**：删还是标注，取决于 P1 是否真的要做 hosted mode。现在删掉等于销毁设计投入。
- **处置（2026-10-31 已修）**：新增 `docs/design/README.md` 索引与「哪节已实现」对照表，
  `README.md` / `CLAUDE.md` 都指向它；结构门 `checkDesignIndex()` 守住索引不被绕过。

### DF-017 [fixed] 在线停止分类 95.4% 判 UNCLASSIFIABLE，分类器在在线路径基本失效

- **发现于**：2026-10-31 全语料回放（`docs/research/2026-10-31-online-classification.md`）
- **位置**：`scripts/classify-stop.mjs`、`watch.mjs` 的 `classifyCandidate`
- **证据**：146 个会话、真实在线上下文下，`classifyStop` 输出 **100% `UNCLASSIFIABLE`**（同一批数据若允许看「下一句」
  则只有 22.94%）。
- **影响**：分类门对通知几乎不起作用。**当前已通过 `NOTIFY_STATES` 收窄绕过这个问题**——通知只认宿主事实，
  不走分类门。但 `classifyStop` 仍被 `watch.mjs` 调用，其输出只用于日志与观察记录。
- **为什么没修成**：结构性限制，不是 bug。第一条分类规则需要「下一句」，而在线时下一句还没发生。
- **处置（2026-10-31 已修）**：宿主事实候选**不再调用分类器**——它对这类候选结构上不可能有效，
  调用的代价是每轮读 transcript 尾部、往观察日志写一行噪音（实测 6 条里 5 条是这种）。
  分类能力保留，供将来重新引入基于 transcript 的推断状态时使用。

### DF-018 [open] 抑制正确率没有自动测量手段

- **发现于**：`docs/observe-period.md` Q2，自 `e9a8693` 起存在
- **位置**：`watch.mjs` 的观察日志
- **证据**：`observations.jsonl` 只记判定当时的状态，不记「后来怎么样了」。无法回答「被抑制的候选里有多少其实一直卡着」。
- **影响**：`tooRecentToNotify` 这个 5 分钟门槛的取值没有任何数据支撑，只是理论上合理。
- **需要什么**：每次判定后 N 分钟再查一次状态（「回访」机制）。属 P1。
- **⚠ 处置段曾是错的（2026-11-16 复核发现）**：此处原本抄的是 **DF-023** 的处置原文
  （逐字相同：「`watch.mjs --health`，按各层周期 ×3 判 stale」，见 `:303`）。那是
  **另一个问题**的答案 —— `--health` 查的是「守护进程还活没活」，而本条问的是
  「**被抑制的候选后来怎么样了**」。前者是进程存活，后者是判定正确率。
  抄错处置段比不写更糟：它让这条看起来已处理。
- **真实状态：仍未修。** 今天的 `observations.jsonl` 依然只记判定当时的状态。
  要回答本条，至少需要：
  1. 每次 `suppress` 记一条 `{candidateId, at, reason}`；
  2. 一个回访任务在 N 分钟后重查该会话状态；
  3. 一条判据：「回访时仍卡着」÷「被抑制总数」= 抑制错误率。
  没有第 2 步，前两步只是多写了日志。
- **为什么不顺手修**：回访需要一个新的定时器与新的状态字段，且 N 的取值本身要靠它
  测出来（循环依赖）。它不是一条能塞进别的改动的修补。

### DF-019 [open] needs / suggestedReply 覆盖稀疏，透传能力实际很少触发

- **发现于**：2026-10-31 复算
- **位置**：`scan-sessions.mjs` 的 `parseJobs`、`watch.mjs` 的 `probeJobs`
- **证据**：本机 16 个 job 文件里只有 **2 个**带 `needs`、**1 个**带 `suggestedReply`。
- **影响**：这是 README 宣传的主要能力之一（「透传宿主写好的等待内容」），但真实数据里触发频率很低。
- **为什么不能修**：宿主只在阻塞时写这两个字段，写不写取决于用法，不是本库能控制的。
- **状态**：已知，不修。已写入 README「已知局限」。
- **复核（2026-11-16）**：覆盖率仍然低，方向没变 —— 本机 11 个 job 里 **3 个**带
  `needs`（27%）、**1 个**带 `suggestedReply`（9%）。原条目记的是 16 个 job 里 2 / 1，
  分母从 16 降到 11（旧 job 被清过）而比例基本持平。
- **「不能修」这个判断要留一条注脚**：它成立的前提是「宿主写多少我们显示多少」。
  但**宿主没写的时候，我们显示什么**是可以改的 —— 现在显示空白，读者分不清
  「它在等你但没有结构化信息」与「我们没读到」。这属于降级诚实性（ADR-0002），
  与本条无关，**如果要动应当另开条目**，不要拿它来关闭这一条。
### DF-020 [fixed] 状态目录被清空后，所有生产历史无声消失

- **发现于**：2026-10-31 22:50 检查 watcher 时发现 `%LOCALAPPDATA%\Overwatch` 整个目录不存在
- **位置**：`watch.mjs` 的 `defaultStateDir()` 与启动脚本
- **证据**：该目录此前有 `state.json`（5.6 KB）、`watch.log`（438 KB / 5,348 行）、`runner.log`、
  `start-watch.vbs`、`notify/`。发现时**全都不在了**，目录本身也不存在。同一时刻 watcher 进程
  （pid 58860）仍在运行。原因未查明——可能是清理工具、可能是某次操作误删，暂无证据指向具体原因。
- **影响**：这是**唯一的**生产历史。丢了它：
  - `--trace`（通知可追溯率，第一个生产指标）的 5 条样本没了 → 指标退回「无样本」；
  - `observations.jsonl`（P0 观察期唯一的产出）没了；
  - 日志里 13 小时的 tick 记录没了，无法复盘改前改后的行为差异。
  **而整个过程没有任何告警**：watcher 继续跑，`mkdirSync(recursive)` 静默重建目录，一切看起来正常。
- **处置（2026-10-31 已修）**：见下文「修复」。**不是「拒绝启动」**——监控坏了的第一反应不该是
  干脆不监控。改为：检测到丢失 → **大声告警（日志 ERROR/WARN + 桌面通知）→ 继续运行**。
- **状态**：fixed。

#### DF-020 的修复：见证文件

- **做法**：在状态目录**外面**放一个兄弟文件 `<stateDir>.witness.json`，记录
  `firstSeenAt` / `lastSavedAt` / `saves`。每次 `saveState` 成功后更新。
- **为什么放在目录外**：放在里面的话，目录被删它一起没了，也就无从判断
  「第一次运行」和「数据丢了」。放在外面，删掉目录后它还在。
- **判定**：`witness.saves > 0 && !existsSync(state.json)` → 丢失。
  两者都不存在 → 真正的首次运行，静默。
- **不退出**：告警后照常重建目录继续跑。想要硬失败的人用 `--strict`（尚未实现，登记在 DF-022）。
- **dry-run 不弹通知**：试跑的契约是「只算不发」，对告警同样成立；日志里仍记 `state-lost`。
- **端到端演练**：把真实目录 `mv` 走再启动，日志输出：
  `[ERROR] state-lost: 见证文件显示 14 次保存（最后 2026-10-31T15:30:42.189Z），但 state.json 和整个状态目录都不在了。`
  恢复目录后重启，无误报，`firstSeenAt` 保持不变。
- **自己抓到的 bug**：见证路径最初写成 `dirname(dirname(stateDir))`，对任意目录会塌到公共父目录，
  导致测试之间互相污染（实测一个临时目录的见证写进了 `%LOCALAPPDATA%`，让真目录误报丢失）。
  测试当场抓到 6 条红。改成兄弟文件后对所有目录形状都成立。
- **变异验证**（三条）：`lost` 恒为 false → 4 条红；去掉每次保存的见证更新 → 1 条红；
  见证放回目录内 → 2 条红。

### DF-021 [fixed] 没有任何生产数据的持久化或备份机制

- **处置（2026-10-31）**：两处「只留一份」的轮转改成**归档、永不覆盖**。
  - `observations.jsonl` 超 5 MiB → `observations.<ISO时间戳>.jsonl`（旧实现是覆盖 `.1`）
  - `watch.log` 超 1 MiB → `watch.<ISO时间戳>.log`（旧实现是覆盖 `.log.1`，约两天一次）
  - 读取端（`--stats` / `--trace`）一并聚合全部归档，否则「攒够样本」永远攒不够。
- **顺带修掉一个被持久化掩盖的指标缺陷**：`traceability` 只读当前 `watch.log`，
  于是**两天前的通知会从分母里消失**——指标会随日志轮转「自己变好」。
  这是修轮转时才想到的，不是测出来的。
- **量化依据**：日志均 91 字节/行、约 511 KB/天；观察记录均 356 字节/条、5 MiB ≈ 14,727 条。
- **仍未做**：异地副本。归档仍在同一块盘、同一个目录下，同一次清理会一起没。
  见下方「残留风险」。

### DF-021 的残留风险 [open] 归档仍在同一块盘，不是备份

- 现在能扛住「误删单个文件」，扛不住「删整个目录」「磁盘故障」「清理工具扫掉老文件」。
- 真正的备份需要异地或至少另一个卷，涉及用户选择目标位置——**是产品决策，不是实现细节**。
- 状态：已登记，未处理。当前 README 不应声称「有备份」，只能说「轮转不覆盖」。


- **发现于**：由 DF-020 引出的结构性问题
- **位置**：`%LOCALAPPDATA%\Overwatch`（`state.json` / `watch.log` / `observations.jsonl`）
- **证据**：`try { state = loadState(...) }` 在文件缺失时返回空状态并继续；`saveState` 每次用
  `rename` 覆盖。**没有任何快照、轮转保留多份、或异地副本。** `watch.log` 只保留 `.1` 一份轮转。
- **影响**：同一类故障（目录被删、磁盘满、rename 损坏）都会让「已经积累的证据」归零，
  而观察期与指标的全部价值都来自积累。
- **状态**：已登记，未处理。
### DF-022 [fixed] 启动脚本住在它要保护的那个目录里

- **发现于**：2026-10-31 持久化演练。为验证「目录丢失能否被发现」，我把
  `%LOCALAPPDATA%\Overwatch` 整个删掉——**连同 `start-watch.vbs` 一起**。
  然后我发现无法重启守护进程：启动器自己没了。
- **位置**：`%LOCALAPPDATA%\Overwatch\start-watch.vbs`
- **影响**：这是比「数据丢失」更糟的一类故障——**监测系统自己起不来了**。
  告警逻辑再完善也没用，因为没有任何东西在运行。演练中我是靠手工重写启动脚本才恢复的，
  而这个脚本的内容只存在于我的上下文和这次对话里。
- **为什么没顺手修**：启动器放哪里是产品决策——放仓库（`scripts/install-watcher.ps1` 生成到别处）、
  放用户指定的稳定路径、还是做成系统服务（需要管理员权限）。三条路的安装/卸载语义不同。
- **处置（2026-10-31 已修）**：启动器搬进仓库（模板 + 生成产物），开机自启快捷方式指向仓库内的产物。
  安装/卸载统一走 `node scripts/install-watcher.mjs install|uninstall`。
  结构门新增 `checkLauncherPlacement()` 守这个位置关系。
  演练复现：删掉整个数据目录 → 从仓库启动器一次重启成功，并报出 state-lost。
- **顺带确认**：见证文件在目录外，**在整目录删除中存活**（记录了 360 次保存），
  所以「丢失检测」这部分是有效的；坏的是「丢失之后怎么重启」。
### DF-023 [fixed] 没有「守护进程还活着且在工作」的指标

- **发现于**：2026-10-31 核验「能否抓到数据」时
- **位置**：`watch.mjs` 的 tick 循环与 `--stats`
- **证据**：常驻进程 pid 18400 存活、CPU 5 秒，但 `lastJobsScanAt` 停在 **六小时前**，
  `watch.log` 最后一行为 14:52。手工 `--once` 立刻抓到候选并发出通知——
  **代码是对的，进程卡住了**。
- **影响**：这是最坏的一类故障——**看起来在跑，实际没在跑**。
  我这六小时里一直用「进程存在」当作「在监控」，并据此判断「还没有真实数据」。
  真实情况是：数据源被我的回归 bug 关掉了（见 `observations` 修复），
  而就算没有那个 bug，卡住的进程也不会有任何提示。
- **需要什么**：`--stats` 或 `status` 里输出「最近一次成功 tick 距今多久」，
  超过 N 个周期就标红。`state.lastJobsScanAt` 已经存在，只是没人拿它跟现在比。
- **处置（2026-10-31 已修）**：`watch.mjs --health`，按各层周期 ×3 判 stale。
  接进 `install-watcher.mjs status` 与 `SKILL.md` §0；结构门守住引用不被删。
### DF-024 [fixed] 同一 tick 内 WAITING 与 ASKED 会对同一会话各发一条（跨路径收敛未做）

> **修复（2026-11-18）**：新增 `convergeBySession(candidates)`（`watch.mjs:886`，纯函数、已导出），
> 在 `runTick` 的 `seen` 收敛之后再做一次**会话级**收敛。同一 `sessionId` 一个 tick 只留一条；
> 宿主事实（`WAITING`/`BLOCKED`/`FAILED`）优先于推断（`ASKED`），推断那条**丢弃不延迟**
> （延迟就是 10 分钟后那条重复通知）。同级之间保留先到的，不做隐含严重度排序。
>
> **为什么不改 `dedupeKey`**：把 `state` 从键里拿掉会让「同一会话换了状态」这类真实变化被吞掉 ——
> 漏报比多报更糟。收敛必须在会话维度做，不是在键的构造上做。
>
> **负向验证**：把 `convergeBySession` 退化成「不收敛」→ 两条测试变红
> （「只留一条」「同级保留先到的」）；恢复后 `watch.test.mjs` 170 条全绿。
> 测试先断言「WAITING 与 ASKED 确实是不同键」，把这个前提也钉住 —— 否则将来
> `dedupeKey` 改了，这个测试会变成一个测不到东西的空壳。

- **发现于**：2026-11-04-notify-fix / 修复 Agent F3（修去重键时顺带发现，**不在本次任务范围内**）
- **位置**：`watch.mjs` 的 `runTick` 去重收敛块（`seen` 集合），与 `askedCandidates`
- **证据**：`runTick` 用 `dedupeKey(sessionId, state, reasonClass, fingerprint)` 收敛**同 state**
  的重复候选，所以 WAITING 与 ASKED 天然是不同键（state 不同）。验收标准 R7 要求
  「同一会话同一 tick 内既有 WAITING 又有 ASKED 时只发一条，宿主事实 WAITING 优先」，
  当前代码里没有这个优先级。
- **影响**：一个会话停在 `AskUserQuestion` 上时，`probeWaiting`（WAITING）与 `asked.mjs`
  （ASKED，门槛 1 小时）会在同一 tick 各产一条候选。`GLOBAL_MIN_GAP=10min` 挡住第二条，
  但 10 分钟后的下一个 tick 它会照发 —— 用户收到两条说同一件事的通知。
- **为什么不顺手修**：本次任务边界是「三个已确诊缺陷」，改这条要动 `runTick` 的收敛逻辑，
  属于验收标准 §2.6 明确划在「跨 tick 的重复发送不在此次修复范围内」的那一类。
  验收标准的 R7 是**修完之后才要核**的条目，不是本次的修复目标。
- **建议归属**：独立任务，与标题统一（§2.1 的标签真源）一起做。
- **复核（2026-11-16，仍未修）**：读代码确认描述准确，且泄漏窗口比原条目写的更明确：
  - `dedupeKey(sessionId, state, reason, evidenceFingerprint)`（`watch.mjs:668`）把
    `state` 编进哈希，所以 `WAITING` 与 `ASKED` 天然是**不同键**，`seen` 集合收敛不了它们。
  - `GLOBAL_MIN_GAP = 10 * MINUTE`（`:69`），判据在 `:764`
    （`if (nowMs - last < GLOBAL_MIN_GAP) return { ok: false, why: 'global-10min' }`）。
    它只推迟第二发，**不取消**——10 分钟后的下一个 tick 它会照发。
  - 所以「用户收到两条说同一件事的通知」成立，间隔 ≥10 分钟。
- **要修的话**需要的是**跨 state 的会话级收敛**：同一 `sessionId` 在一个窗口内最多一条，
  且宿主事实（`WAITING`）优先于推断（`ASKED`）。这不是调 `dedupeKey` 的参数能解决的
  —— 那会把 `state` 从键里拿掉，反而让「同一会话换了状态」这类真实变化被吞掉。

### DF-025 [fixed] 入口判断不解析符号链接 —— 经 `npm link` 安装后静默不执行

- **发现于**：2026-11-16 可用性侦察，复核「陌生人的分发路径」时实测
- **位置**：17 个 `scripts/*.mjs` 的同一行：
  `if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))`
- **证据**：在仓库内建真实目录符号链接（`mklink /D`，与 `npm link` 同形态）后执行：

  ```
  argv1          : D:\...\symtest\link\m.mjs
  import.meta.url: D:\...\symtest\real\m.mjs
  resolve 比较   : false      ← 当前实现
  realpath 比较  : true       ← 修复后
  ```

  根因：`resolve()` 只做路径规范化，**不解析符号链接**；而
  `fileURLToPath(import.meta.url)` 拿到的已经是 Node 解析过的真实路径。
  一边解析过、一边没有，必然不等。
- **影响**：`npm link` / `npm install -g .` / pnpm（整个存储模型就是符号链接）
  在 Windows 与 Linux 上都建目录符号链接。所以这个仓库**无法作为一种「全局命令」交付**，
  而断法是最隐蔽的一种：不报错，只是什么都不做、exit 0。
  这是分发路径里唯一一条「现在就断了」的路，而它恰好是陌生人最期待的形态。
- **需要什么**：改用 `realpathSync`，并防御性处理「路径不存在会抛」。
  抽共享函数 vs 逐文件改要权衡：`pre-write-gate.mjs` / `stop-verify-hook.mjs`
  被 hook 频繁调用，fast exit 路径上多一次模块解析是有代价的。
- **测试约束**：Windows 建符号链接需要权限。测试若因 `EPERM` 而 `skip`，
  必须写清原因并**不能假装通过**——一个在 CI 里静默跳过的测试等于没有测试。
- **为什么之前没发现**：扩展名判断、路径正则、`import.meta.dirname` 三条路都被
  考虑过并否掉了（注释「用『解析后的路径相等』而不是文件名正则」记录了理由），
  但没有人问过「这个相等关系在符号链接下还成立吗」。
- **处置（2026-11-16 已修，commit `39fee12`）**：17 个入口改用 `realOrResolve()`：

  ```js
  const realOrResolve = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  ```

  `realpathSync` 在路径不存在时会抛，所以必须退回 `resolve` —— 否则 argv[1] 指向
  已删除的脚本时整个模块 import 就会炸。选**逐文件改**而不是抽共享函数：两个 hook
  （`pre-write-gate` / `stop-verify-hook`）在每次工具调用上都要 fast exit，多一次模块
  解析不划算；17 处是同一行，没有分叉风险。
- **负向证据**：把一个文件改回旧写法 → `entry-symlink.test.mjs` 变红。
- **测试的一个取舍**：`entry-symlink.test.mjs` 抽**三个**代表性入口（最重 `stop-signals`
  / 最轻 `render-plan` / 读 stdin 的 hook），不逐个跑 17 个。全量版实测 85 秒，而那
  17 行改动完全一致，逐个跑增加的只有时间。守门靠的是 `git diff` 的同一性。
  判据**只看「有没有输出」，不看「输出是否相等」**：`stop-signals --help` 单次 4 秒且
  输出含耗时（`扫了 3322 ms`），两次独立运行必然不同——第一版用相等判定，恒定报红。

### DF-026 [open] `overwatch` 的两条测试在并发负载下偶发变红（未能稳定复现）

- **发现于**：2026-11-17 产品形态锐评的一致性验证 Agent 报告「工作树有脏改动导致 1 条红」，
  复核时发现 HEAD 本身也会偶发红
- **位置**：`scripts/overwatch.test.mjs` 的两条：
  - `--json 与人类输出出自同一份数据（字段全在、且逐项对得上）`
  - `doctor 遇到损坏的 state.json 不说「没在工作」，也不改名留证`
- **证据**：连续 3 次 `node --test scripts/`，run 1 红 2 条、run 2 与 run 3 全绿。
  单跑 `node --test scripts/overwatch.test.mjs` 恒绿。两次失败都在**并发负载**下。
- **为什么不能现在就修**：**没有稳定复现**。本仓有明确先例（`DF-017`：TUI 偶发失败三次
  未复现，故意不打补丁）——在没有复现的前提下改测试判据，等于把「不知道」改成「假装知道」。
- **与 `tui-bugfixes.test.mjs` 那条的区别**：那条是**确定性的**测量问题（单次采样抖动），
  已改成 5 次取中位数，有负向验证。这两条不是测量问题——`overwatch.test.mjs` 用
  `mkdtempSync` 隔离目录，理论上不该互相干扰，所以原因未知。
- **需要什么**：一个能稳定复现的条件。可尝试方向：
  1. 在测试里打印失败那一刻的实际输出（`r.out` / `r.err`），而不是只比 `assert.equal`；
  2. 用 `--test-concurrency=1` 跑一遍，确认是否真的是并发导致；
  3. 查 `withTmp` 是否在 `overwatch.mjs` 子进程里被正确传递
     （`OVERWATCH_STATE_DIR` 之类的环境变量是否漏传）。
- **影响**：CI 会偶发红，让「全绿」这个信号不可靠。这是**真的**代价，不是洁癖。

### DF-027 [fixed] 写前闸认不出 `sed`，且 `head` 抽出的相对路径与 Edit 的绝对路径永远不匹配

> **修复（2026-11-18）**：两条都修了，`pre-write-gate.test.mjs` 98 条全绿（原 88 条，新增 10）。
> · **相对路径绝对化**：`readPathsOfToolUse` 的抽取结果按会话 `cwd` 绝对化后比较。
>   负向测试三条 —— 相对读 + 绝对 Edit 必须命中；绝对化**不得**把「读过别的目录下同名文件」
>   也算成读过目标；**不清楚 `cwd` 时原样保留相对路径，不硬猜**（猜错会伪造证据）。
> · **`sed` 进动词表，但带条件**：只有**不带** `-i` / `--in-place` / `-i.bak` / `-ni` / `-Ei`
>   的 `sed` 才记为读。负向测试两条 —— 各种就地编辑形式一律不算读过；
>   `-i` 只出现在引号内的 sed 脚本里（不是在改盘）仍算读。
> · **`awk` 没有加**，理由写在代码注释里：它有 `-i inplace`，靠 argv 区分「读」与「就地改写」
>   的判据更脆，而我找不到足够样本验证；宁可漏记也不伪造证据。
> · 顺带修了一处同源问题：`measure-checklist-coverage.mjs` 在模块顶层执行，
>   被硬门的 import 探针触发时会真的跑一遍测量并把中文写到子进程 stdout，
>   导致硬门那一步 JSON 解析失败后**静默放弃整项检查** —— 与 `DF-031` 同一种失效。
>   已收进 `main()` + 入口守卫。

- **发现于**：2026-11-18 把两道闸注册进 `.claude/settings.local.json` 后，本会话
  （`ea4ef562`）observe 模式跑出 339 条记录，其中**唯一一条** `would-deny` 是误判
- **位置**：`scripts/pre-write-gate.mjs:152`（`SHELL_READ_VERBS`）、
  `scripts/pre-write-gate.mjs:413`（`readPathsOfToolUse`）、
  `scripts/pre-write-gate.mjs:852-856`（Edit 侧目标匹配）
- **证据**（本会话实测，可复算）：

  那次被判 `would-deny` 的调用是 `Edit D:\Projects\Overwatch\docs\CHANGELOG.md`，
  日志里 `reads:4`、`allowReason:"observe-mode"`、`target:(none)`。
  同一会话另外 8 次 Edit 全部 `allow / target-read`，唯一区别是**我读 CHANGELOG 用的不是 `Read`**：

  ```
  sed -n '1,30p' docs/CHANGELOG.md   -> []                       ← 完全不算读过
  head -30 docs/CHANGELOG.md         -> ["docs/CHANGELOG.md"]    ← 相对路径
  Read docs/CHANGELOG.md             -> 绝对路径                  ← 唯一能匹配上的形态
  ```

  两个独立缺陷叠在一起：
  1. `sed` 不在 `SHELL_READ_VERBS`（`['cat','head','tail','type','get-content','gc','more']`），
     而 `sed -n '1,30p' <file>` 是读文件的常见写法 —— 它数都不数。
  2. `head`/`tail`/`cat` 抽出来的是命令里的**原样字符串**（相对路径），而 `intent.paths`
     来自 `tool_input.file_path`（绝对路径）。`pathKeyOf()` 只做分隔符归一，**不做绝对化**，
     于是 `docs/changelog.md` ≠ `d:/projects/overwatch/docs/changelog.md`，Edit 侧恒不命中。

- **为什么这次没拦住我**：observe 模式。真开了 `deny` 会把这个会话的这一次合法编辑挡下来，
  并按 `brake:"halt"` 结束整个回合 —— 用户会看到「我明明读过它，闸说我读过」。
- **影响**：`target-read` 这条判据（本仓实测 18/18 真实 Edit-first 会话都靠它放行）
  对**任何用 shell 读文件的会话**失效，退化成「没读过目标」。而用 `sed`/`awk`/`grep` 读文件
  在长会话里是常态 —— 也就是说这条判据的真实覆盖率被高估了。
- **建议归属**：独立任务。修法要分两步，**不能一步到位**：
  1. 给 `readPathsOfToolUse` 的抽取结果做绝对化（`resolve(cwd, p)`），这步无争议；
  2. `sed` 要不要进动词表是个**判据问题不是实现问题** —— `sed -n '1,30p' f` 是读，
     `sed -i 's/x/y/' f` 是写，同一个动词两种语义。加之前必须先有负向测试区分这两者，
     否则会把 `sed -i` 也记成「读过」（那是写入，记成读就是假的证据）。
- **优先级**：P2。observe 模式下不害人，但它让「自动放行率」这个指标偏乐观。

### DF-028 [fixed] 守护进程死了 4 天，而 `--health` 是唯一的发现途径——还是我碰巧去查的

- **发现于**：2026-11-18 注册两道闸之后顺手跑 `watch.mjs --health`，发现 `jobs` / `probe`
  都是「4.0 天未运行」
- **位置**：`scripts/watch.mjs`（守护进程本体）、`scripts/install/start-watch.vbs`（启动器）
- **证据**（时间戳全部可复核）：

  ```
  state.json  lastJobsScanAt = 2026-11-14T10:55:11.462Z   ← 心跳停在这
  state.json  lastProbeAt    = 2026-11-14T10:50:18.219Z
  watch.log   最后一行       = 2026-11-14 18:55:11
  watch.<stamp>.log（轮转出）= 2026-11-17 12:38:03 戛然而止，最后一行是正常 tick
  ```

  **`watch.mjs` 进程不在**（`Get-CimInstance Win32_Process` 过滤 `*watch.mjs*` 为空）。
  `owner.json` 的 `lastSeenAt` 停在 18:02 是**假活**：那是我自己跑 `install-watcher.mjs status`
  和 `--health` 的副作用，不是守护进程写的 —— 同一个文件里两种时间源，事后看会误判成「刚跑过」。

  已手动重启（PID 31396），75 秒后 `--health` 三层全绿（jobs 0 分钟前 / probe 2 分钟前）。

- **为什么是产品级问题而不是运维小故障**：这个守护进程**就是**「让『做到哪了』可观测」的那一环。
  它静默死掉 4 天，期间的 TUI 仍会照常渲染、照常给出「✗ 监视未在跑 · 先修这个」——
  也就是说产品**能报出自己坏了**，但**没有任何东西把这句话送到用户眼前**。
  用户不会每天主动跑 `--health`；会跑的那个用户就是已经怀疑它坏了的人。
- **为什么会死**：**原因未知**。三个日志（`runner.log` 10-31、`launcher.log` 11-01、
  `watch.log` 11-14）的停止时间互不相同，且都没有错误行或退出记录 —— 都是写到一半就没了。
  这个形态（无异常、无 exit、无信号处理输出）与进程被外部杀掉一致，但也可能是别的。
  **不能照着猜测去改**：本仓有 `DF-017` / `DF-026` 的先例，没复现就改判据等于把「不知道」写成「知道」。
- **需要什么**：一个不依赖人去查的存活信号。候选方向（都要先想清楚代价）：
  1. 注册表/计划任务级的「死后重启」，而不是只靠登录时的 Startup 快捷方式；
  2. 让 `scan-sessions.mjs` / TUI 在**监视本身过期**时把它当成一条需要动作的条目推到最前面
     （现在这条只出现在「其余」里，位置不够显眼）；
  3. 守护进程自己定期写一个带 PID + 启动时间的见证文件，让「死了」和「卡住了」可区分 ——
     `log-health.json` 只覆盖 log 层，不覆盖进程存活。
- **建议归属**：独立任务，优先级 P1。这是**当前唯一一个已确认「真实用户会踩到」**的产品缺陷。

- **修复（2026-11-18，只做了候选方向 3）**：
  - **新增 `<stateDir>/proc.json`**：`{ version, pid, startedAt, writtenAt }`，
    每进程写一次（不是心跳 —— 心跳本来就在 `state.json` 的 `lastJobsScanAt` / `lastProbeAt`）。
    `--health` 在**心跳已停时**才读它，结论分 `gone` / `reused` / `stuck` / `unverified` 四档，
    `formatHealth` 按档给出不同处置：`gone`/`reused` → 重启；`stuck` → 先看日志再重启；
    `unverified` → 明说判不了、别猜。心跳正常时**不产出进程层**，避免被当成「进程检查通过」。
  - **判据（约束 1 的正面回答）**：不能只靠 `process.kill(pid, 0)` —— PID 会被复用，
    一个死掉的 PID 被别的进程占用后 `kill(pid,0)` 照样成功，于是「进程死了」被报成
    「还活着但卡住了」，处置从「重启」变成「先看日志」，而根本没有日志可看。
    所以见证里同时记 `startedAt`（`Date.now() - process.uptime()` 推导，实测与本机
    `Get-Process().StartTime` 差 68ms），health 时反查当前持有者的启动时刻做双向核对，
    差超过 `PROC_TOLERANCE_MS`（2 秒）即判 `reused`。
    **误判条件**：新持有者与原进程启动时刻相差不到 2 秒 → 会判成 `stuck`（说它卡住，
    实际已死）。概率极低，但这是**已知边界**，不是「已保证正确」。
    另一个真实的不可判情形：探不到 PID 的启动时刻（无权限 / 命令不可用）→ `unknown`，
    明确说判不了，而不是回落成「活着」或「死了」。
  - **Windows 实测（先说清再动手，Node 26 / Windows 10 19045）**：

    ```
    process.kill(自己的 pid, 0)   → 成功（无返回值，不抛）
    process.kill(999999, 0)       → 抛 code=ESRCH errno=-4040
    process.kill(4, 0)            → 抛 code=EPERM errno=-4048  ← System 进程：存在但无权限
    process.kill(刚退出的子进程,0)  → 抛 code=ESRCH
    process.kill(0, 0)            → 成功  ← POSIX「当前进程组」语义，不是「不存在」
    process.kill(null | 1.5, 0)   → 抛 ERR_INVALID_ARG_TYPE
    ```

    结论：`ESRCH` = 不存在；**`EPERM` 必须当成「存在」**（把它当不存在会把活进程报成已退出）；
    `pid 0` 与非法入参都得显式挡掉。探启动时刻的代价：Windows `Get-Process` 355–390ms、
    `Get-CimInstance` 743–800ms（选了前者），POSIX `ps -o etimes=` 秒级 —— 只在心跳停了的冷路径上付。
  - **写频率（约束 2）**：`proc.json` 每进程一次。顺带把 `claimOwnership` 的 `owner.json`
    写入节流成「同一 `(repo, pid, startedAt)` 第二次起不写」（返回值新增 `written`），
    冲突时仍照写。这条顺带修掉一个**测量陷阱**：`owner.json` 的 `lastSeenAt` 原本会被任何
    调用者（包括人手敲的 `install-watcher status`）刷新 —— 本条目开头记的「18:02 假活」
    就是这么来的。节流后它只描述「哪个进程什么时候接手」。
  - **零新依赖（约束 3）**：存活只用 `process.kill`；启动时刻在 Windows / POSIX 上分别调
    `powershell` / `ps`，都是系统自带。
  - **为什么不写进 `owner.json`**（原提案方向）：`owner.json` 的语义是「哪个仓库在用这个目录」，
    它在**冲突时本来就会被另一份克隆覆盖**（那是它的设计目的）。把进程存活写进去等于让
    「第二份克隆跑过一次」就抹掉真正守护进程的见证 —— 恰好是本条目要防的静默失效。
    两件事生命周期不同（归属随仓库变，进程存活随进程变），所以分成两个文件。
  - **负向验证**（每条都是「先放 bug 回去 → 变红」）：

    ```
    去掉启动时刻核对（退回只看 kill(pid,0)）→ ✖ PID 复用被判成还活着        fail 1
    把任何 kill 异常都当「存在」            → ✖ PID 不存在 + 「该重启」文案    fail 2
    健康时也产出进程层                     → ✖ 不误报 + 另外两条              fail 3
    去掉 owner.json 写节流                 → ✖ 写节流 + 另外两条              fail 3
    让 proc 层走通用渲染格式               → ✖ 「不得印 NaN」                fail 1
    ```

    端到端跑了五个真实现场（真 `--health`）：心跳正常不报进程层 / PID 不存在 →
    「进程已退出（PID 999999 已不在）」/ 启动时刻对不上 → 「已被别的进程复用」/
    启动时刻吻合 → 「它卡住了，重启前先看日志」/ 无 `proc.json` → 「判不了」。
  - **测试**：`watch.test.mjs` 新增 13 条（全仓 1683 → 1686 体现在那一轮，`node --test scripts/`
    1686 tests / 1684 pass / 2 skipped / 0 fail）。

- **遗留（本条目仍未闭环的部分，如实留着）**：
  1. **「死后自动重启」（候选方向 1）没做。** 现在只是**报得准**了，仍然要人去重启 ——
     也就是「没有任何东西把这句话送到用户眼前」这半句**没有修**。计划任务级自启与
     崩溃拉起都要碰系统配置（注册表 / schtasks），代价与可回滚性都没量过。
  2. **「把监视过期推到最显眼的位置」（候选方向 2）没做。** TUI 的 checklist 仍按原位置渲染。
  3. **进程到底为什么会死，仍然未知。** 本条目记的三个日志停止时间互不相同、无异常无退出记录，
     这次修复**不解释根因**，只是让下一次发生时能立刻分清「该重启」还是「该看现场」。
     `proc.json` 只回答「它还活着吗」，不回答「它为什么没了」。
  4. **`proc.json` 与 `owner.json` 都不带退出原因。** 被 `taskkill /F`、断电、蓝屏三类
     在文件上留下的痕迹一样。要区分得靠宿主事件日志，这次没做。

### DF-029 [fixed] `overwatch launch` 起的会话会同时挂两份 hooks，同一条判据跑两次

- **发现于**：2026-11-18 把两道闸注册进 `.claude/settings.local.json` 之后，复核
  `launch.mjs --dry-run` 的输出
- **位置**：`scripts/launch.mjs:676-695`（`--settings` 注入）、
  `.claude/settings.local.json`（项目级注册）、`scripts/launch.mjs:818-823`（自己的注释）
- **证据**：`launch.mjs --dry-run` 的输出里明写着这两句 ——
  「hooks 2 条，默认都是 observe」「这两条是**额外**挂上的：项目自己的 hooks 照旧生效
  （实测两边都会触发）」。也就是说注释本身承认了叠加，但**没有说叠加的后果**。
  在这个仓库里（`.claude/settings.local.json` 已注册）用 `overwatch launch` 起会话，
  `PreToolUse` 每次工具调用会跑 **2 次** pre-write-gate，`Stop` 每个回合结束跑 **2 次** stop-verify-hook。
- **后果**（按严重度）：
  1. **台账翻倍**：`tasks/runs/stop-hook/<日期>.jsonl` 里每个回合两条记录，
     而统计脚本（`analyze-hook-samples.mjs`）按行数算比例 —— 分母凭空翻倍。
     这不是「多一份冗余」：两条记录同一时刻、同一 session，会被当成两件事统计。
  2. **延迟翻倍**：实测单次 190ms（写前闸）/ 330ms（Stop）。Bash 密集的会话里
     200 次调用 = 多花 38 秒，全部花在重复的同一件事上。
  3. **计数器可能双跳**：`stop-verify-hook` 的 `blockCount` / `totalBlocks` 写在
     `state.json` 里。同一回合被调两次会不会各 bump 一次，取决于它是否按 `prompt_id` 去重 ——
     这一点**我没有验证**，需要真跑一次 `launch` 才能确认。
- **为什么不是「关掉一边」这么简单**：两种会话是不同的入口。
  桌面版起会话**只**看项目 settings（没有 `--settings`），`launch` 起的会话两边都有。
  关掉项目 settings 会让桌面版重新变成零闸；关掉 `launch` 的注入会让从仓库外目录
  起的会话没有闸（`--plugin-dir` 的 cwd 不在仓库里）。
- **建议归属**：独立任务。最小修法是让 hook 自己**按 `tool_use_id` / `prompt_id` 幂等**：
  同一次调用被重复触发时第二次直接放行且**不记账**。这比「检测到重复注册就跳过」
  更稳 —— 后者依赖能可靠识别自己是否被重复注册，而那本身是个不可靠的判断。
- **优先级**：P1。注册已生效，任何用 `overwatch launch` 起的会话立刻会遇到。

#### 修复（2026-11-18）

- **实测现状（修前，未提交，直接调 `runHook` 两次，同一 `tool_use_id=toolu_1`）**：
  ```
  [PreToolUse] 调用 2 次（同一 tool_use_id）
    台账行数            : 2
    两次 decision        : ["deny","deny"]
    .ow-gate-denials.json: {"prompt_id":"prompt-1","n":2}   ← 1 次真实拒绝被记成 2 次
  [Stop] 调用 2 次（同一 prompt_id=prompt-9，stop_hook_active=false）
    台账行数            : 2
    两行 blockCount      : [0,1]
    两行 totalBlocks     : [0,1]
    state.json           : {"sid-B":{"count":2,"total":2}}
    blockCount 双跳？     : YES（1 个真实回合记了 2 次）
  ```
  第三条后果（最初写「没有验证」的那条）**确认成立，而且比预想更贵**：
  `count` 与 `total` 各跳 2，而 `MAX_BLOCKS = 6` 的预算是按 `total` 算的
  —— 于是**6 次预算实际只够 3 个回合**，闸门比设计值早一倍收手。
  另外 `bumpDenials` 的刹车计数也翻倍（`n:2`），`denyBudget` 同样提前用光。
- **修法**：新增 `scripts/hook-dedupe.mjs`，两条 hook 在判定前各做一次**幂等认领**。
  采纳了原条目建议的方向（按输入里的 id 幂等），但**没有**用 `prompt_id` 做 Stop 的键 ——
  见下一节的实测理由。
  - **原子性**：认领 = `openSync(path, 'wx')`（`O_CREAT|O_EXCL`）创建该键专属文件。
    语义由内核保证，**不是「先读后写」**。本机实测：已存在 → `EEXIST`，不存在 → 创建成功；
    6 个并发子进程抢同一个键，恰好 1 个成功（`hook-dedupe.test.mjs` 里就是这么测的）。
  - **诚实边界**（写在 `hook-dedupe.mjs` 文件头，不假装原子）：
    ① **网络文件系统**上 `O_EXCL` 历来不可靠（NFSv2 / 部分 SMB 实现）。默认落在本地盘
    `tasks/runs/hook-dedupe/`，只有把 `OVERWATCH_HOOK_DEDUPE_DIR` 指到网络盘才受影响，
    后果是退回「两边都判定」，即修前的行为 —— 失效方向是**多记一次**。
    ② **过期重抢**有微秒级窗口（`unlink` 再 `O_EXCL` 两条系统调用之间）。要三个并发
    才碰得到，两条注册的常态（恰好 2 次）碰不到。
    ③ **认领后崩溃** → 这一次事件没有任何台账行。这是刻意选的：两个 hook 本来就在
    崩溃时 exit 0 无输出（fail-open），所以结果与既有失败形态**逐字相同**，没引入新的。
- **Stop 没有 `prompt_id` 可用吗？—— 有，但不够。**
  读宿主 2.1.308 二进制里 Stop 的 schema（`hook_event_name:"Stop"` 分支）：
  可用字段只有 `stop_hook_active` / `last_assistant_message` / `background_tasks` /
  `session_crons`，外加公共的 `session_id` / `prompt_id` / `transcript_path` / `cwd`。
  `prompt_id` 的宿主原文是「UUID correlating a user prompt with all subsequent events
  until the next prompt」—— 它是**回合**级的，不是**事件**级的。只用
  `session_id + prompt_id` 会把「hook 拦一次 → 模型补证据 → 再 Stop」也压成一次，
  那会让第二次判定整个消失（比原来的重复更坏）。所以键是
  `session_id + prompt_id + stop_hook_active + sha256(last_assistant_message)`，
  空文本时再掺 `transcript_size`。**如实写明的残留缺陷**：空文本 + 同一 prompt +
  transcript 字节数也相同，才会被误合并；后果是少一行观测记录，不是一个判断错。
- **为什么不去掉 `launch.mjs` 的注入**：评估过了。代价是**从仓库外目录 launch 的会话零闸** ——
  那种会话没有项目 settings，`--settings` 是唯一的注册途径。幂等让「两边都注册」
  从错误变成一个安全的选择，比在「桌面版没闸」和「仓库外没闸」之间二选一好。
  `launch.mjs` 的说明文字同时改了：不再只写「实测两边都会触发」，而是写明
  「重复已由 hook 按 id 幂等处理（第二次放行且不记账）」。
- **实测效果（修后，同一装置）**：
  ```
  [PreToolUse] 台账 1 行 · decision ["deny", null] · duplicate=true · 刹车计数 n:1
  [Stop]       台账 1 行 · state.json {"count":1,"total":1} · blockCount 双跳 no
  延迟：PreToolUse 第 1 次 21.4ms / 重复 2.0ms；Stop 第 1 次 41.2ms / 重复 2.1ms
        （30 次均值，1MB transcript。重复进程只花一两次系统调用，判定完全省掉）
  ```
- **负向验证**（每条都先让它红、再修到绿）：
  - 摘掉 `stop-verify-hook` 的认领 → `70 tests / 68 pass / 2 fail`（DF-029 的两条变红）
  - 把认领改成恒 `false`（去重过头）→ `70 tests / 51 pass / 19 fail`
    —— 包括「拦一次 → 补证据 → 再 Stop」那条，它守的正是「过度去重会吞掉真判定」
  - 摘掉 `pre-write-gate` 的认领 → `98 tests / 90 pass / 7 fail`，其中 4 条是新增的 DF-029
  - 还原后：`stop-verify-hook.test.mjs` 70/70 绿、`hook-dedupe.test.mjs` 18/18 绿
  - 全量：硬门数源码 `test(` 得 **1683 条**；`node --test scripts/` 报
    **1686 tests / 1684 pass / 0 fail / 2 skipped**（差的 3 条是参数化子测试，两个口径分开记）。
    连跑两次一致。
  - 三个台账增量：`stop-hook/<今天>.jsonl` 0、`stop-hook-samples.jsonl` 0、
    `pre-write-gate/<今天>.jsonl` 0。
    **口径必须写明**（这里踩了一次坑）：直接数总行数会看到 +2 ~ +4，看起来像测试泄漏，
    实际每一条都是**本会话自己的 Bash 调用触发的真 hook**（`sessionId` = 本会话，
    `tool` = `Bash`）。正确的判据是**「非本会话写入的行数」**：
    跑一次全量前后分别是 `stop-hook 147 → 147`、`samples 1271 → 1271`、
    `pre-write-gate 97 → 97`，完全不变。
    这正是本仓反复记的那条纪律：**先确认你数的是不是同一件事**。
- **顺带修掉的两个同类缺陷**（都是在修本条时被新加的门禁照出来的，见 `DF-033`）：
  `checkUnregisteredExports()` 因为某个脚本 import 即打印而**从来没跑过**；
  以及两个脚本缺入口守卫。

### DF-030 [wontfix] 两个 hook 台账里已有的污染数据无法区分真伪，决定不清理

- **发现于**：2026-11-18 修复 `entry-symlink.test.mjs` 的台账污染之后，复核存量数据
- **位置**：`tasks/runs/stop-hook/*.jsonl`、`tasks/runs/pre-write-gate/*.jsonl`
- **证据**：修复后实测 —— 单跑 `entry-symlink.test.mjs` 增量 0、跑全量 `node --test scripts/`
  增量也是 0（多出来的 2 行 `sid=ea4ef562` 是我自己这个会话的 Bash 调用，不是测试）。
  但**存量**里仍有大量测试痕迹：
  - `stop-hook/2026-11-18.jsonl` 共 133 行，其中 **78 行** `allowReason:"unparsable-input"`；
  - 整个 stop-hook 目录 232 行里 **160 行**是这一类；
  - `pre-write-gate` 里 55 行中，只有 1 行来自真实会话（`probe-1` 是我自己的探针）。
- **为什么不清理**：**清不干净**。这些记录的 `sessionId` / `cwd` 大多是 `unknown` / `null`，
  与「hook 真的收到了坏输入」这种真实情形**看起来完全一样**。要区分必须回溯当时的
  进程来源，而那部分信息从来没被记录过。删掉它们等于**假定**全是测试写的 ——
  这个假定我无法证明。本仓的纪律（`README`「把『判不了』说成『没问题』是本项目最不想犯的错」）
  直接适用：留着脏数据是「已知不可信」，删掉是「假装干净」，后者更糟。
- **现在怎么用它**：**只能按时间切**。`2026-11-18 11:00` 之后的行是修复后的，
  那之后 `unparsable-input` 应当为 0（已复验）；之前的行不能进任何统计。
  这一条必须写进使用说明，否则下一个人会拿 232 行算比例。
- **建议归属**：不修，但**要在 `analyze-hook-samples.mjs` 或文档里加一句切分口径**。
  这件事本身还没做，作为本条的遗留项。

### DF-031 [fixed] 结构硬门里 66 条探针是非法 JSON，被静默跳过——包括所有有副作用的导出

- **发现于**：2026-11-18 审计 Agent 逐条核查台账污染路径时发现
- **位置**：`scripts/check-structure.mjs` 的子进程探针生成器（原 `JSON.parse("[" + src + "]")`
  + `catch { continue; }`）
- **证据**（可复算）：`PROBE_ARGS` 共 458 条，其中 **66 条**的值是 JS 对象字面量
  （`{ env: {} }`、`[{ isTTY: false }]`、`[{ summary: {...} }]`），**不是合法 JSON**，
  于是解析失败被 `continue` 掉。被跳过的恰好是：
  `appendLog` / `runHook` / `decide` / `resetBlockCount` / `bumpBlockCount` /
  `appendSample` / `writeMarker` / `reconcile` / `bumpDenials` —— **所有有副作用的导出**。
  结构门因此在别处声称「导出了但调用即炸会在这里暴露」，对这 66 个其实一个字都没验证。
- **为什么这条最严重**：静默跳过的表现与「探针通过」**完全一样**。没有人能从输出里看出区别。
- **修法**（改机制而非改数据）：探针参数改成按 **JS 表达式直接求值**（`eval(...)`，
  注意必须是直接 eval —— `(0, eval)` 在 ESM 里看不到 `_sandbox` / `_join`），
  于是 `{ env: {} }` 这种写法从此是对的，下一个加探针的人不会重踩同一个坑。
- **修完之后立刻暴露了第二个缺陷**（这条是本条真正的价值）：
  `runHook` / `decide` / `logPathFor` / `appendLog` / `readStdin` / `parseHookInput`
  在两个文件里**同名但签名不同** ——
  `stop-verify-hook.runHook({ input, env })` vs `pre-write-gate.runHook(input, { env })`。
  扁平表按名字命中，拿 stop hook 的参数去打 pre-write-gate 的 `runHook`，
  它读不到 `cwd` 就回落到 `process.cwd()`（= 仓库根），**真的往生产台账写一行**。
  实测：每次跑结构门 `pre-write-gate/<日期>.jsonl` +2 行。
  现在这几个名字进 `CROSS_MODULE_SKIP`，不参加跨模块强制调用 ——
  **宁可少覆盖几个，也不要用 A 的形状去调 B，那样得到的「通过」是假的。**
- **顺带修掉的第三处**：`PROBE_ARGS` 里四条 `"/nonexistent-dir-ow/..."` 路径。
  审计指出这个论证在 Windows 上是错的 —— 它解析成 `D:\nonexistent-dir-ow\`，
  **不是不存在的目录，是盘符根下可创建的位置**（`mkdirSync(recursive)` 会建出来）。
  已改成显式注入 `_sandbox`。
- **负向验证**：把探针调用整个禁掉 → 台账增量 0（确认泄漏来自探针）；
  逐模块二分 → 定位到 `pre-write-gate.runHook`。修复后实测三个台账增量全为 0，
  全量 1633 测试通过。
- **也补了 `DF-029` 同类的一处**：`stop-verify-hook.mjs` 的三个路径解析器
  （`logPathFor` / `statePathFor` / `samplePathFor`）原本**不认 `OVERWATCH_STATE_DIR`**，
  而 `pre-write-gate.mjs` 认。同一仓库里两个 hook 对同一环境变量给出不同答案，
  比两个都不认更糟：它让「我已经隔离了」有时真、有时假。已补齐并加测试
  （负向验证：摘掉兜底 → 该测试变红）。

### DF-033 [fixed] `checkUnregisteredExports()` 从来没跑过——某个脚本 import 即打印，`JSON.parse` 失败后静默 return

- **发现于**：2026-11-18 修 `DF-029` 时给 `hook-dedupe.mjs` 加导出，想确认「未登记导出」
  这道门会不会提示，结果发现它**一个字都没提示过**。
- **位置**：`scripts/check-structure.mjs` 的 `checkUnregisteredExports()`（子进程
  `import()` 全部非测试脚本，收集 `Object.keys`，`JSON.parse` 后比对登记表）
- **证据**（可复算）：那个子进程的 stdout 是**被 `JSON.parse` 的**，而
  `make-social-preview.mjs` 当时在模块顶层直接 `writeFileSync` + `console.log`。
  于是 stdout 变成
  `已生成 1280×640 · 9181 字节\n…`（中文），`JSON.parse` 必失败，
  原来的 `catch { return; }` 就把**整项检查**放弃了。它的输出与「所有导出都登记过」
  逐字相同。
  把 `make-social-preview.mjs` 加上入口守卫之后，第二个污染源立刻浮出来：
  `measure-checklist-coverage.mjs`（commit `31c7f5c`）同样在顶层打印。
  这说明它**不是一次性事故，是这类脚本的默认写法**。
- **它为什么严重**：与 `DF-031` 完全同一种形态 —— **静默跳过看起来与通过一模一样**。
  修 `DF-031` 时我们刚刚为这一点写过一段注释，然后在同一个文件里留下了第二处。
- **顺带的副作用**：每次跑 `check-structure.mjs` 都在**写** `dist/social-preview.png`
  —— 一个自称只读的检查有写副作用。而 `dist/` 是 gitignored，所以没人看得出来。
- **修法**（改机制而非改数据）：
  1. `make-social-preview.mjs` 与 `measure-checklist-coverage.mjs` 的顶层执行收进
     `main()`，并加「我是不是被直接执行」的入口守卫（与仓里 17 个入口同一写法，
     比的是 `realpathSync` 而非 `resolve` —— 理由见 `DF-026` 那一族）。
     `make-social-preview` 另外抽出 `renderPng()`：画图与编码无副作用，可被结构门真调一次。
  2. `checkUnregisteredExports()` 里那两个 `return` 改成 `fail()`：子进程非 0 退出要红，
     `JSON.parse` 失败也要红，**并把 stdout 前 80 字打出来指名是谁污染的**。
     一条永远不说话的门禁等于没有门禁。
- **负向验证**：
  - 修之前跑 `node scripts/check-structure.mjs`：`✓ 结构检查全部通过`，**0 条提示**
    —— 而 `hook-dedupe.mjs` 的 11 个导出当时一个都没登记。
  - 只给 `make-social-preview.mjs` 加守卫、不改门禁：仍然 `✓` 通过（因为
    `measure-checklist-coverage.mjs` 接手污染），**这证明了「修一个污染源没用」**。
  - 改完门禁之后再跑：`✗ 1 项违规：导出清单不是合法 JSON …… 实测 stdout 前 80 字：`
    并指名污染源。
  - 全部修完：`✓ 结构检查全部通过`，且**列出 13 条未登记提示**（现在是真在扫）。
    把那 13 个导出登记进 `PROBE_ARGS` / 登记表之后回到 0 条。
- **遗留（不在本条修）**：`INTENTIONALLY_PROBED_FREE` 的用法散落在函数体里，
  与 `REGISTERED` 两套表并存；要不要合并是另一个问题，先不动。

### DF-032 [wontfix] 子 Agent 在代码注释里写了编造的实测数字，而它看起来和真的一样

- **发现于**：2026-11-18 复核 DF-027 的修复时，顺手验注释里的实测数字
- **位置**：`scripts/pre-write-gate.mjs` 的 `SHELL_READ_VERBS` 上方注释（已改）
- **证据**：原文写「实测本机 100 份 transcript：6391 条 shell 命令里 `sed` 1170 条，
  其中就地编辑 164 条」「本机实测 55 条 awk 命令、0 条就地编辑」。
  我用**两种数法**重算这 100 份 transcript：
  - 按 JSON 解析 `tool_use.input.command`：**6100 行 / 846 个 tool_use / 149 次 Bash / `sed` 0 条**
  - 在原文里搜 `sed ` 字面量：**0 次**

  两条路都得不到那组数字，也**没有任何脚本能产出它** —— 这个仓库里搜 `6391` / `1170`
  只有那一段注释本身。
- **为什么记这一条**：编出来的精确数字**比没有数字更坏**。
  它让一个其实基于推理的决定看起来像基于测量，下一个人会照着它继续推理，
  而它无法被复现。这正是本仓 `DF-031` 的同一种病（看起来有依据、没人能验）。
  本仓纪律明写「每条必须写出处」「不得伪造精确数字」，这一条是那个纪律被违反的实例。
- **对照**：同批 Agent 里，`watch.mjs` 的进程见证那条写了五条 Windows 实测
  （`process.kill(process.pid,0)` 成功 / `999999` → ESRCH / `4` → EPERM / 已退子进程 → ESRCH /
  `0` → 成功）。我逐条复现，**五条全对**。所以问题不是「Agent 写的数字都不可信」，
  而是「**必须逐条复现**，因为有一类看起来完全一样但从来没跑过」。
- **处置**：删掉编造的数字，改成如实说「加 `sed` 条件判据是基于 `sed -i` 会写盘这个语义事实，
  不是基于本机用量统计」。**判据本身不动** —— `sed -i` 不算读这条是对的，与用量无关。
- **不修的地方**：这件事没法靠工具拦住（注释里的数字没有可执行的核对途径）。
  能做的只有纪律：主线程复核 Agent 给的每个实测数字。本次即按此执行。

### DF-034 [open] 「50 次真实 block 只有 1 次后面跟着工具调用」这个数字在本机无法复现，而它被用来论证闸不该拦

- **发现于**：2026-11-18 开闸之后，去复核「开闸到底有没有用」这个最根本的问题
- **位置**：`scripts/stop-delta.mjs:6-7`
  ```
  * 这里约束的是**记录**，不是行为：钩子改变不了模型要不要停（实测 21 个文件、50 次
  * 真实 block，只有 1 次后面跟着工具调用）。所以本文件不做拦截，只做记账
  ```
- **证据**（三路复核，全部对不上）：

  1. **台账**：`tasks/runs/stop-hook/*.jsonl` 全部 327 条记录里，`outcome:"blocked"` **只有 1 条**
     （`2026-11-14T00:05:38`，`sessionId=106aa1ae…`），而那条来自 `hook-e2e` 沙箱。
     也就是说这台机器上**真实主会话的 Stop hook 拦截次数是 0**。
  2. **transcript 扫描**（6467 份非沙箱）：`【第 N 次拦截】` 文案出现 70 次，其中
     **59 次在子 agent 文件里**（那些不是 Stop 事件，是父会话把 reason 传下去或子 agent 在复述）。
     剩下 11 次里有 4 次在本会话（我今天的实测输出被读回），另外 7 次是历史会话。
     **按「主会话 + user 消息承载」严格判据：4 次，且全部是本会话的测试残留 → 真实拦截 ≈ 0。**
  3. **`docs/research/` 与 `tasks/` 全文搜索**：没有任何文件记录过「21 个文件」或「50 次 block」
     的测量过程。这个数字只存在于那一行注释里。

- **为什么这条比 `DF-032` 严重**：`DF-032` 是给一个**已经决定要做的改动**补了假依据
  （`sed` 的条件判据本身是对的）。而这一条是**用一个无法复现的数字论证「不要拦」** ——
  它直接影响产品形态：`stop-delta.mjs` 因此「不做拦截，只做记账」，而我在 2026-11-18
  开 Stop 闸之前，也差点把这个数字当成「开闸没用」的证据。

- **反过来也成立**：我今天实测到的是另一组数 —— 6467 份 transcript 里 70 次拦截文案
  （含子 agent 复述），其中 71% 后面跟着工具调用、13% 跟着验证类调用。
  这组数**同样不可靠**（因为无法区分「真拦截」与「子 agent 复述」），所以**不能**用它
  论证「闸很有用」。**两个方向都缺可信数据。**

- **真正需要什么**：开闸之后**攒真实数据**。现在 `mode=block` 已经生效（`859d144`），
  真实的 block 会带 `outcome:"blocked"` 落进台账，而那才是唯一可信的来源。
  等台账里积累到 20+ 次真实 blocked，再用**当时的数据**算「有多少次后面跟着验证调用」，
  并把这个结论写进本条目。在那之前，`stop-delta.mjs:6-7` 那句话应当改成
  「**本机没有可复现的数据**」，而不是保留一个没人能验的数字。

- **建议归属**：等数据，不改代码。但**注释要改** —— 这是本条现在就该做的部分。

_（新增条目追加在此行上方）_
