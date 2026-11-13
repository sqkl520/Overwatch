# 六条危险级不一致：修了什么，怎么核

- 日期：2026-11-13
- 角色：修复 Agent F9
- 产出形态：artifact（文档 + 代码 + 测试）
- 上游清单：`docs/research/2026-11-13-consistency-audit.md` 第二部分（🔴 危险 6 条）
- 边界：只修那 6 条。🟡 11 条与 🟢 7 条未动，见文末「没修的」。

> **一句话**：6 条全修完。**其中 3 条是代码对、文档错（改文档），2 条是代码真缺能力（改代码），
> 1 条两边都只对了一半（分别改）。**测试基线从 793 长到 826（我加的 5 条 + 同目录另一个 Agent 加的 28 条），
> 硬门加了一道 `checkTestCount()`。

---

## 一、逐条

### 1. 🔴 `docs/GUIDE.md:81` 教用户用已删除的判据 —— 文档错

**改文档。** 代码是对的：`scan-sessions.mjs:217-233` 留着完整的删除理由（6308 次大间隔里
5977 次、94.8% 之后仍有 `tool_use`；删除前 5 条通知全是这条推断的误报）。GUIDE 停在删除前的版本。

改法不是只换一行表格。同一件事在 GUIDE 里有**五处**陈述，逐处收口：

| 位置 | 原写法 | 现在 |
|---|---|---|
| `:81` 状态表 | 「宿主报失败 **或** 间隔超 p95 且 60s 无新记录 **或** 预算耗尽且零增益」 | 「**只有一种来路**：宿主 `state: "failed"`。不从间隔推断，也不从预算推断」 |
| `:92-105` 整节 | 「判 `FAILED` 的条件之一是末次间隔超过 p95」 | 按当前两道闸门重写：①宿主 `failed` ②`idle > 1h → dormant`，并说清顺序为什么不能换 |
| `:123` `reason` 合法值 | 含 `hb_gap=…`，漏 `host-reported-waiting` / `waiting:<waitingFor>` | 与 `judgeState()` 逐字对齐，并注明 `hb_gap` 已不在其中 |
| `:135` liveness | 「`insufficient-sample` … 因此**永远不会**被判 `FAILED`」 | 「**这三档都不影响状态判定**……任何会话都不会因为间隔被判 `FAILED`」 |
| `:321` FAQ | 同上 | 同上 |

**为什么 `:135` / `:321` 也是危险项**：它们隐含「样本够 20 就**会**判 FAILED」。用户读到的是
「样本不足才安全」，反推「样本够了就不安全」——这恰好是那条已删推断的行为。不是笔误，是同一错误的另一面。

`docs/spec/state-model.md:322-329` 同步（`liveness` 三档说明 + `reason` 合法值表）。

复算：`grep -n 'hb_gap\|p95' docs/GUIDE.md`——剩下的命中全是「已删除」的说明，没有一条还在教用户用它。

### 2. 🔴 测试数四份文件四个值 —— 双方都不够

四份文件四个值（README 508 / CLAUDE 192 / GUIDE·CI 81 / 设计稿 588），实测 **826**。

**我没有只把四个数字改成同一个。** 那只是把「下一次漂移」推迟到下一个提交。改法是让数字**不再需要手写**：

新增 `check-structure.mjs` 的 `checkTestCount()`（第 258-302 行）：

1. 数源码：`scripts/*.test.mjs` 里 `^\s*test\(` 的条数（不跑测试，一秒内完成，与「测试是否全绿」解耦）；
2. 逐处比对 `README.md` / `CLAUDE.md` / `docs/GUIDE.md` / `.github/workflows/validate.yml`；
3. 不一致 → `fail`，并且**找不到声明也 fail**（删掉那句话等于没人再核它）。

负向验证跑过：把 README 改回 `508`，硬门输出
`[README.md] 回归测试数写的是 508，源码实测 798。改成 798…` 且 exit 1；改回即绿。

**这道门在本次任务里立刻证明了自己**：写报告期间数字漂了两次（798 → 820 → 826，
同目录另一个 Agent 在改 `verify-claims.test.mjs` / `stop-verify-hook.test.mjs`），
每次都是硬门先报、我才知道要改。这不是演示，是真实发生的。

四份文档现在写 826，并各自注明「以 `node --test` 输出为准」。

**另有两处同类数字也改了**（审计 🟡#11 顺带）：`docs/design/2026-11-10-agent-framework-skeleton.md:105`
与 `:185` 的「588 条测试」。设计稿是**历史快照**，所以没改成 826，而是改成「近八百条」+ 注明
「写作时实测 588 条，确切值跑命令看」——把会漂的数字从断言里拿掉，而不是换一个新的会漂的数字。

### 3. 🔴 `verify-claims.mjs` 硬编码 `npm test` —— 代码真缺能力

**改代码。** 这条不是文档问题：`adviceFor()` 里那句 `'npm test（或本项目实际的测试命令）'`
是一段代码，且 `timeline` / `evidence.detail` 里的真实命令从来没人用。

**实际数据验证过这条有多真**：Maven 项目 `d--Server-MCServers-Server-plugin-Mentor-Express`
的会话 `3b390f6e`，改前建议是「重跑 npm test」，改后是
「重跑 `mvn -q clean verify`（依据 pom.xml）」。

新增三档溯源，按**可靠性**排序而不是按方便排：

| 档 | 来源 | 函数 | 为什么排这个位置 |
|---|---|---|---|
| 1 | `evidence.attempts[].cmd` | `actualCommandFor()` | 这台机器上**真实跑通过**的命令。优先取成功的那次——失败的可能是拼错的，让他照抄是二次伤害 |
| 2 | 仓库根标志文件 | `detectProjectCommands(cwd)`（复用 `project-commands.mjs`） | 项目**自己声明**的命令。Maven 项目绝不说 npm |
| 3 | 认不出 | —— | 直说认不出，**不编命令** |

配套两个小函数：

- `shortenCommand(cmd, matcher)`：从 `export JAVA_HOME="…" && "<maven 根>/bin/mvn.cmd" -f "…/pom.xml" clean verify`
  里裁出**真正要重跑的那一段**。**故意不做 `normalizeCommand`**——归一化会把引号里的路径压成
  basename（`-f "…/pom.xml"` → `-f pom.xml`），那条命令就不能跑了。这里要的是「能复制粘贴的」，不是「判断用的」。
- `evidenceTimeline()` 多返回一个 `cwd`（`lastCwd(records)`）。**只给建议用，不参与任何判定。**

`adviceFor()` 里 `test-count` / `build` 走这条链，其余族（commit / push / ci / probe / file-count）
命令由语义决定、与项目无关，保持原样并抽成 `INTRINSIC_CMD` 常量。

**测试（5 条，硬性要求的那三条都在）**：

1. Maven 项目给 `mvn` 且**不含** `npm`，含复合命令裁剪、路径不被压成 basename；
2. Node 项目抄**成功那条**（`npm run test:unit`）而不是失败那条（`npm test`）；
3. 无调用时退回项目配置，并**说出来源**（「依据 pom.xml」）；
4. 都认不出时**不点名任何命令**；
5. 负向守卫：`source` 必须是 `null` 而不是被兜底成某个默认命令。

### 4. 🔴 测试数（同一件事的另一半）

见第 2 条。审计把「四份文件」（#4）与「CLAUDE 192」（#10）、「设计稿 588」（#11）、
「CI 81」（#12）分列成四条，代码上是同一个根因（数字靠手写）。一次修完。

### 5. 🔴 `docs/GUIDE.md:403` 子 agent 上限写 30，实为 100 —— 文档错

`MAX_SUBAGENTS = 100`（`scan-sessions.mjs:490`），而 GUIDE 同一文件 `:122` 自己写的就是
「只展开了最近的 **100** 个」。`:403` 的「上限 30，显示 `30/N~`」是 2026-10 之前的值
（`CHANGELOG:1152` 的 DF-008 记录过 `MAX_SUBAGENTS = 30` 那次修改）。

改：`:403` → 100。顺带 `:326` 的「最多展开 30 个子 agent」→ 100（审计 🟡#9，同一数字的第三处）。

### 6. 🔴 `docs/GUIDE.md:317` 同样的 30 —— 同上

与第 5 条同一处代码常量的另一处文档。一并改。

### 附加：🔴 #24（审计列为 🟢，但性质同属「文档写了代码里不存在的东西」）

`STALLED` 判据在 GUIDE `:83` 与 `state-model.md:28` 都写「**且**派生树没有任何节点有增益」，
而 `judgeState()` 的签名是 `{ sessionState, waitingFor, calls, gapsMs, now }`——**根本不接收派生树**，
三条件里第三个在代码里不存在。

这条我按 🔴 处理，理由：它和 #1 是同一类错误（文档描述了一个不存在的判据），且它会让用户
以为「派生树有增益就不会判 STALLED」——实际机制不同（见下），据此判断会错。

**实际机制不是判据，是数据**：`scan-sessions.mjs:442-444` 把主 transcript 的调用与每个子 agent 的
调用合并成 `allCalls`（按时间排序），`judgeState` 收到的是它就是合并后的。子 agent 有新动作
→ 窗口 novelty 抬高 → 不会判 `STALLED`。所以**效果对、描述错**。

改法：GUIDE `:83` 与 `state-model.md:28` 照实写（去掉不存在的第三条件），并在
`state-model.md §5` 补上「靠合并时间线实现，不靠单独判据」——否则下一个人读 §5 还是会以为有个判据。

---

## 二、有没有「代码错了文档对了」

**有两条，但都不是「代码错」而是「代码缺能力」，所以是改代码**：

1. **第 3 条（`npm test`）** —— 文档没错，它压根没提这段建议；是代码里那段建议**本身是错的**，
   而且是可判定的错（对 Maven 项目指向不存在的命令）。修代码。
2. **第 2 条（测试数）** —— 四份文档都「写了数字」，但四个都不一样，所以没有一个可以被当作「对的」。
   真正的错误是**机制**：数字靠手写、没人核。修法是把判定权交给硬门（`checkTestCount()`），
   文档只负责与实测一致。

**没有一条是「文档对、代码错」**。逐条核过：`judgeState`、`MAX_SUBAGENTS`、
`attempts[].cmd`、`detailLines` 的 `head = Math.min(3, shown)`——每处代码的行为都符合它自己的注释，
不一致全在文档侧（或缺失侧）。

**另外发现一处审计没列的**（也是文档错）：`docs/spec/output-format.md:37` 的示例行
`[阶段B · Agent#9 FAILED · hb_gap=1240s>p95=620s · 重跑 1/2]` 用的是一个**再也不会出现**的
`reason` 与一条不会发生的推断。同一份 `state-model.md:329` 早就写了「当前代码不会产生 `hb_gap`」。
改成 `BLOCKED · host-reported-blocked`。这是 #1 的同一根因在另一份规格里。

---

## 三、测试与硬门

```
node --test scripts/*.test.mjs   →  tests 826  pass 826  fail 0
node scripts/check-structure.mjs →  ✓ 结构检查全部通过（exit 0）
```

基线 793 → **826**。其中 **+5 是本次新增**（第 3 条的命令溯源用例），
另外 +28 来自同目录另一个 Agent 在 `verify-claims.test.mjs` / `stop-verify-hook.test.mjs` 上的改动
（本次会话内并发发生，不是我的产出，我保留未动）。

复算测试数：`grep -cE '^\s*test\(' scripts/*.test.mjs | awk -F: '{s+=$2} END {print s}'` → 826。
或者直接跑一次硬门，它会告诉你该写多少。

硬门新增一项（`checkTestCount()`），负向验证已跑（见第 2 条）。其余 4 项是既有提示
（`verify-claims.mjs` 的 `COMPLETION_RE` 等四个导出未登记参数表），来自并发 Agent 的新代码，
不阻塞，也不是本次范围内的。

---

## 四、过程安全

审计报告记了一个事故：`verify-tui-negatives.mjs` 被超时 kill 后 `finally` 未执行、
`oversight-tui.mjs` 留在被改状态。**本次没有跑它**——修复这 6 条不需要负向变异器，
硬门的负向验证我用手改一处 + 跑门 + 改回来完成（第 2 条），没有触碰任何会被改写的源码文件。

`stop-verify-hook.mjs` 未碰。git 未碰（`git status` 只读）。

---

## 五、没修的（明确出界）

审计清单 24 条里，🟡 11 条与 🟢 7 条**未动**，其中几条值得下一轮优先：

| # | 是什么 | 为什么值得优先 |
|---|---|---|
| 🟡#7 | `--days 3` 报 33 秒，实测 65 秒 | 用户据此判断「跑一次多久」会错一倍 |
| 🟡#8 | `--days 30` 报 87 秒 / 「3,354 个 transcript」，实测 55 秒 / 332 个 | 分母在本机复现不出 |
| 🟡#16 | TUI 界面上写「每 8s 轮询」，实际是「扫描耗时 + 8s」 | `scheduleNext()` 在 `await job.promise` 之后才调。**这是代码缺陷，不只是文档** |
| 🟡#17 | GUIDE 全篇 0 次出现 `WAITING`，而它是会发通知的状态之一 | 用户不知道有这个状态 |
| 🟢#13 | `CHANGELOG:15` 说 GUIDE 是「437 行」，实测 416 行 | 数字会继续变，建议去掉行数 |
| 🟢#14 | `CHANGELOG:5` 仓库写 `sqcola`，README / remote 是 `sqkl520` | 不一致 |
| 🟢#21 | `docs/design/README.md:35` 与 `watch.mjs:7` 头注释写「1 分钟」，实为 15 秒 | |
| 🟢#23 | `PUBLISH-TRIAGE.md` 的「44 份」已与磁盘脱节（今 88 份） | 可发布区清单失效 |

其中 🟡#16（8 秒轮询）性质与本次 6 条相同——**陈述了没做的事**，且已被
`docs/research/2026-11-11-hostile-user-review.md` 第 8 条记过一次、至今未修。它需要改代码
（把 `scheduleNext()` 挪到 `await` 之前，或用独立定时器），不是本次「6 条」范围内。

---

## 六、改了哪些文件

| 文件 | 改了什么 |
|---|---|
| `docs/GUIDE.md` | 状态表 `FAILED` / `STALLED` 判据；§3 整节重写；`reason` 合法值；两处 liveness 说明；详情页示例按实跑输出重写；三处「30 → 100」；测试段（18 文件 / 826 项） |
| `docs/spec/state-model.md` | `STALLED` 判据去掉不存在的第三条件；§5 补「靠合并时间线实现」；`liveness` 三档与 `reason` 合法值表 |
| `docs/spec/output-format.md` | 示例行 `hb_gap=…` → `host-reported-blocked` |
| `README.md` / `CLAUDE.md` / `.github/workflows/validate.yml` | 测试数 → 826，注明以命令输出为准 |
| `docs/design/2026-11-10-agent-framework-skeleton.md` | 两处「588 条测试」→「近八百条」+ 历史快照说明；结构硬门数「5 道」→ 去掉具体数 |
| `scripts/verify-claims.mjs` | 新增 `shortenCommand` / `actualCommandFor` / `recoveryCommandFor`；`evidenceTimeline` 加 `cwd`；`adviceFor` 改为三档溯源 |
| `scripts/verify-claims.test.mjs` | 新增 5 条（Maven / Node / 项目配置 / 认不出 / 负向守卫） |
| `scripts/check-structure.mjs` | 新增 `checkTestCount()` + 三个新导出的探针登记 |
| `docs/CHANGELOG.md` | 顶部条目 |
| `docs/research/2026-11-13-dangerous-inconsistencies-fixed.md` | 本文件 |
