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
- **证据**：原实现 `/(["'])(?:\\.|(?!\1).){40,}\1/g` 在 `'` + 连续反斜杠输入上不可终止。实测 `'` + 60 个反斜杠 → **90 秒超时**；真实语料中一条 472 字符的 `grep` 命令单次归一化 17,897ms。`--days 3` 与 `--project MCServers` 均在 60s 超时（exit 124）。
- **影响**：README 的 30 秒上手命令直接挂住；产品唯一的「眼睛」在真实数据上不可用。
- **修复**：改为手写线性状态机 `stripLongStrings()`，O(n)。病态输入现为 0.3–4.2ms，`--days 3` 全量扫描 13s。
- **回归测试**：`state-model.test.mjs` 的「归一化在病态输入上是线性的」

### DF-002 [fixed] 休眠会话被误判为 FAILED

- **发现于**：修复 DF-001 后重跑全量扫描
- **位置**：`judgeState()` 的 FAILED 分支
- **证据**：`[FAILED] Projects/rea calls=2483 ... hb=515s/120s idle=72.3h`。该会话末次间隔 515s 超过 p95=120s，但整体已空闲 72.3 小时——它是结束了，不是失败了。
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
- **证据**：3220 个 jsonl 中 **1190 个**在 `subagents/workflows/<wf-id>/` 下。会话 `3068431b` 报 `sub=28`，实际远多于此。
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

### DF-016 [open] docs/design/ 下 970 行描述的能力没有对应实现

- **发现于**：2026-10-31 锐评 agent（「970 行设计文档对应 0 行代码，天花板 2.5%」）
- **位置**：`docs/design/hosted-mode.md`（457 行）、`docs/design/verdict-intent-contract.md`、`docs/spec/dispatch-contract.md`
- **证据**：`docs/design/` 下三个文件共 970+ 行，描述 L1–L5 升级、意图契约、判定-意图双层。
  `scripts/` 里没有任何模块实现它们；`watch.mjs` 只做「检测 → 通知」，不做升级也不做代决策。
- **影响**：读者（包括未来的我）会以为系统具备分级升级与代决策能力。ADR-0001 已声明「纯配置库、不自动接力」，
  **但设计文档没有同步降级**，两者给出相反的印象。
- **为什么不自行修**：删还是标注，取决于 P1 是否真的要做 hosted mode。现在删掉等于销毁设计投入。
- **状态**：已登记，未处理。当前处置是在 README「已知局限」里点明天花板。

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
- **状态**：已登记，未处理。

### DF-019 [open] needs / suggestedReply 覆盖稀疏，透传能力实际很少触发

- **发现于**：2026-10-31 复算
- **位置**：`scan-sessions.mjs` 的 `parseJobs`、`watch.mjs` 的 `probeJobs`
- **证据**：本机 16 个 job 文件里只有 **2 个**带 `needs`、**1 个**带 `suggestedReply`。
- **影响**：这是 README 宣传的主要能力之一（「透传宿主写好的等待内容」），但真实数据里触发频率很低。
- **为什么不修**：宿主只在阻塞时写这两个字段，写不写取决于用法，不是本库能控制的。
- **状态**：已知，不修。已写入 README「已知局限」。
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
### DF-023 [open] 没有「守护进程还活着且在工作」的指标

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
- **状态**：已登记，未处理。
_（新增条目追加在此行上方）_
