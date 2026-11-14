# 能力声称逐条实测：文档说的和代码做的

- 审计角色：P2（能力声称 → 真实命令 → 实测输出）
- 实测时间：2026-11-14（系统时钟，UTC+8）
- 语料：`<home>/.claude/projects/` 下 86 个项目目录 / 436 个主 transcript
- 宿主：Claude Code 2.1.308，Node v26.12.1（本机）
- 证据等级：T2（本机实跑，命令与输出都附在本文；数字会随语料增长漂移）

> **被测的树在审计过程中被改过。** 审计期间 `scripts/verify-claims.mjs`、
> `scripts/tui-theme.mjs`、`scripts/check-structure.mjs`、`docs/GUIDE.md` 都被其他会话改动了，
> 回归测试数从 1261 变成 1274。本文每条结论都注明了当时看到的是什么。
> 复算方式全部给出；**引用前请自己重跑**。

---

## 0. 一句话结论

**产品形态搭建起来了，但「文档说的」比「代码做的」宽出两处具体的地方，且核心卖点的
精度仍未达标。** 判据在 §5。

---

## 1. 能力清单完整性：README / GUIDE 里的断言逐条对命令

判定标准（严格）：✅ 跑通且输出与描述一致；⚠️ 能跑但只在特定条件下成立、而文档没说清；
❌ 跑不通，或跑出来的东西与描述不符。

| # | 原话（逐字或节引） | 出自 | 对应命令 | 实测结果 | 判定 |
|---|---|---|---|---|---|
| 1 | 「它会扫描本机所有 Claude Code 会话」 | README:5 | `node scripts/scan-sessions.mjs --days 3` | 149 个会话 / 436 个 transcript / 57.6 秒；`--days 0` 得 436 个会话、状态 EXPLORING=424 BLOCKED=2 PRODUCING=9 WAITING=1 | ✅ |
| 2 | 「当某个会话说『做完了』，去 transcript 里找支持这句话的工具调用——找不到，就把这句话标出来」 | README:5-6 | `node scripts/verify-claims.mjs` | 机制真实存在（四档 + UNKNOWN，退出码语义正确）；但**判对率有问题**，见 §2.1 | ⚠️ |
| 3 | 「附带把会话压成一张表」 | README:6 | 同上 | 每会话一行，字段齐全 | ✅ |
| 4 | 「在真的需要你时通知你」 | README:6, 22 | `node scripts/watch.mjs --inbox` / `--health` | 能跑；但「真的需要」的精度**无证据**，见 §2.2 | ⚠️ |
| 5 | 「零 npm 依赖（仓库里没有 package.json）」 | README:14 | `ls package.json` + 全量 import 扫描 | 无 `package.json`；`scripts/*.mjs` 只 import `node:` 内置模块，零第三方 | ✅ |
| 6 | 「只要 Node ≥ 18」 | README:14 / GUIDE:13 | `node --test scripts/*.test.mjs`（README 与 CAPABILITIES 都让你跑） | **6 个测试文件用 `import.meta.dirname`（Node ≥ 20.11）**，Node 18 上是 `undefined`；`join(undefined,'x')` 直接 `TypeError: The "path" argument must be of type string`。CI 钉的是 node 20，所以 CI 抓不到 | ❌ |
| 7 | 「不安装」（GUIDE 同句） | README:14 | 直接 `node scripts/scan-sessions.mjs` | 无需 install / build，克隆即跑 | ✅ |
| 8 | 「不登录」 | README:14 | 同上 | 全程不联网、不读凭据，只读本地 `.jsonl` 与 `state.json` | ✅ |
| 9 | 「不配置」 | README:14 / GUIDE:13 | 默认路径全跑一遍 | 默认路径确实零配置；但**通知与值守两条能力需要配置**（`install-watcher install` 开机自启、Stop hook 要手改 `settings.local.json` 并写绝对路径），且默认不跑 | ⚠️ |
| 10 | 「不能自动接力」 | README:3, 94-100 | 读 `relay.deliver` 取值 + 代码搜索 | 代码里确实只有 `manual`，无投递路径（与 `spec/relay-protocol.md` §6 一致）。**但支撑它的理由是已推翻的结论**，见 §2.3 | ⚠️ |
| 11 | 「透传宿主的 needs / suggestedReply」 | README:59 | `scan-sessions.mjs --days 3` | `[BLOCKED]` 行下逐字印出「等待输入 / 建议回复」两行 | ✅ |
| 12 | 「检出持久化变更…区分在改东西和在读东西」 | README:60 | 同上 | `persistent-change-in-window` 命中 9-14 个会话。附注：全语料 436 个会话里 `reason=read-only` 命中 **0 次**（`dormant` 241、`cold-start` 183），该值实际不可达 | ✅ |
| 13 | 「会话等你时弹桌面通知（宿主 status: waiting）」 | README:61 / CAPABILITIES:20 | `watch --inbox` + `watch --health` | 通道可用（`isNotificationAvailable() === true`）；但实测时守护进程**没在工作**（`--health` 判 `jobs` 已 8 分钟未跑 > 上限 1 分钟），`--inbox` 空而 TUI 同时显示 1 件在等你 | ⚠️ |
| 14 | 「把完成声明与支持它的工具调用配对，判四档」 | README:62 | `verify-claims.mjs --explain 1` / `--session 23594b2c` | 四档 + UNKNOWN + UNCHECKABLE 全部可复现；`--explain` 打印命中调用索引与理由 | ✅ |
| 15 | 「在收工点值守…（Stop hook，默认关闭，只记账不拦）」 | README:63 | `echo '<json>' \| node scripts/stop-verify-hook.mjs` | 不设环境变量：**无输出、exit 0**（放行）；`OVERWATCH_STOP_VERIFY=block`：输出 `{"decision":"block","reason":…}`，理由里逐字引用原话并给出改法 | ✅ |
| 16 | 「生成带具体下一步的接力草稿，由你复制发送」 | README:64 | `oversight-tui.mjs` 按 `c`（`buildDraft` 直调） | 有 `suggestedReply` 时返回该句；没有时返回 `null` 并给理由。**但 GUIDE 描述的「两段式」已被删除**，见 §2.4 | ⚠️ |
| 17 | 「产出对账：派活前登记『该产出哪些文件』，收活时对磁盘与 transcript 四方核对」 | README:65 | `claim-ledger.mjs declare/observe/verify` | 全链跑通：`declare` 发 nonce → `verify` 判 `UNREPORTED` 并 exit 1；`observe` 对 20 份子 agent 如实报「没有一份能归属到任务」而不是硬塞 | ✅ |
| 18 | 「扫全部会话，压成一张**可排序**的表」 | README:58 / CAPABILITIES:17 | 查所有排序入口 | **没有任何排序入口**：`scan` 恒按 `idleSec` 降序，只认 `--days/--project/--json/--recalibrate/--now/--all`；TUI 固定「需动作→在跑→已停」且无按列排序键 | ❌ |
| 19 | 「机器可读的同一份数据」 | CAPABILITIES:18 | `scan-sessions.mjs --json` | 顶层 `generatedAt/days/live/stats/sessions`，每会话 28+ 字段 | ✅ |
| 20 | 「面板：列表 → 详情 → 复制接力草稿」 | README:45 / CAPABILITIES:21 | `oversight-tui.mjs` / `--plain` | 非 TTY 自动降级为快照；交互键位在非 TTY 下无法实测（诚实标注） | ✅ |
| 21 | 「纯文本快照…不输出任何 ANSI 序列」 | CAPABILITIES:22 | `oversight-tui.mjs --plain \| od` | **0 个 `0x1b` 字节**（`od -tx1 \| grep -c '^1b$'` = 0） | ✅ |
| 22 | 「断言核对接 CI（有问题即非零退出）」 | CAPABILITIES:26 | `verify-claims.mjs --days 3` vs `--exit-zero` | 默认 exit 1、`--exit-zero` exit 0 | ✅ |
| 23 | 「停机原因的结构判定（不读语义）」 [`stop-signals`] | CAPABILITIES:27 | `node scripts/stop-signals.mjs` | 436 个会话、2.1 秒；STOPPED_SILENT 256 / ERROR_STOP 95 / NOT_STOPPED 73 / QUESTION_TEXT 11 / LOOP_SUSPECT 1；`--json` 也可用 | ✅ |
| 24 | 「『问了没答』的会话（不依赖宿主）」 [`asked`] | CAPABILITIES:28 | `node scripts/asked.mjs --hours 1` | 输 0 条并**分项说明排除了什么**（开场客套 3 / 超 24 小时 7 / 问后静默 1） | ✅ |
| 25 | 「人工介入基线…变成可证伪的数字」 | CAPABILITIES:29 | `measure-interventions.mjs --days 7 [--json]` | n=235 会话、介入 208 次、按 P1/Q/P2–P5 分级、p50/p90/max 全给出；`--json` 有 `totals/distribution/rates` | ✅ |
| 26 | 「后台守护进程的健康度」 [`--health`] / 「通知的可追溯率」[`--trace`] | CAPABILITIES:33-34 | `watch.mjs --health` / `--trace` | 两个都跑；`--health` 给出**真阴性**（「没有在工作」）；`--trace` 如实报 0.0% 并判 FAIL，不粉饰 | ✅ |
| 27 | 「开机自启 + 桌面通知（Windows）」 | CAPABILITIES:35 | `install-watcher.mjs status` | 输出安装状态 + 健康判定 + 故障解释（DF-023）；`install/uninstall` 命令存在 | ✅ |
| 28 | 「结构硬门（改动后必跑）」 | CAPABILITIES:36 | `node scripts/check-structure.mjs` | `✓ 结构检查全部通过`，exit 0；另有 13 条不阻塞提示 | ✅ |
| 29 | 「文档相对链接不悬空」 | CAPABILITIES:40 | `node scripts/check-links.mjs` | 检查 66 个链接，0 断链 | ✅ |
| 30 | 「全量回归测试」 | CAPABILITIES:39 | `node --test scripts/*.test.mjs` | 起点 1261 / 33.4 秒全绿；审计期间被其他会话改到 1274，硬门同步把四份文档改成 1274 | ✅ |
| 31 | 「看 Stop hook 放行样本的分布」 | CAPABILITIES:32 | `analyze-hook-samples.mjs [--json]` | 929 条样本，分 `no-completion-language` / `completion-loose` 等簇 | ✅ |

**统计：✅ 23 条 / ⚠️ 6 条 / ❌ 2 条（共 31 条被核）。**

---

## 2. 重点四条（最容易被夸大的）

### 2.1 「找支持这句话的工具调用——找不到，就标出来」：机制真，判定有两类反例

跑 `verify-claims.mjs --days 3`（66 条断言）与全量（149 条断言），人工核对 3 个真实案例：

**案例 A｜`23594b2c`（GTA）— STALE_ONLY 是误报，且证据不是测试。**
工具声称「有 2 次成功的『测试运行』」，实际是：

```
· [成功] 第 371 条  cd "<work>/tools" && mkdir -p ctest && cd ctest && cat > t.c …      ← 只是 mkdir
· [成功] 第 379 条  cd "<work>/tools/ctest" && node -e "…读 PE 头…"                    ← 只是读二进制
```

第一条只是 `mkdir` + 写一个 C 文件，第二条是读 DLL 的 PE 头。它们被判成「测试运行」的原因是
`TEST_CMD_RE` 里有裸的 `ctest` 分支，而**目录名 `ctest` 命中了它**。复算：

```js
TEST_CMD_RE.test('cd "…/tools" && mkdir -p ctest && cat > t.c')   // true，命中 "ctest"
```

后果不只是分档错：那句建议「重跑 `cd "…/tools/ctest"`（该会话里跑通过的就是这条）」会**指挥用户
去跑一个根本不存在的测试**。这是「文档说 A、实际做 B」的一种：它把路径当命令。

**案例 B｜`9b3973f8`（PerfScope）— 3 条 SUPPORTED 里有 2 条不是完成声明。**
被判 SUPPORTED 的三句原文：

1. `| 测试 | 迟滞/冷却/抖动/限流**全 stub 掉后 143 测试仍全绿**喵 |`
2. `测试锐评说「虚构断言能通过门禁」喵。`
3. `但它另一条说对了且很致命喵：**变异测试证明…143 个测试仍然全绿**喵。`

第 2 句是**引述别人的指控**（「锐评说…」），第 1、3 句描述的是**测试写得太弱这个坏消息**
（stub 掉功能测试还全绿）。三者都不是「我做完了」，却都被当成 `test-count` 断言，
并因为同一次 `mvn clean package` 而全部 SUPPORTED。真正的完成声明
「**158 测试全过**（143 → 158）」反而**没被认出**：

```js
detectClaims('158 测试全过')        // []
detectClaims('158 个测试全部通过')   // ['test-count']
```

「全过」不在 `test-count` 的谓词表里（有 `通过/跑通/全绿/passed/green`，没有 `全过`）。

**案例 C｜`2562780d`（skill）— NO_EVIDENCE 是误报。**
判「整个会话里没有任何验证调用」，建议写「我不编一个 一次」。实际该会话跑了 20+ 次
`node scripts/lint.cjs`（`error 0 · warn n`）与 `node scripts/test-lint.cjs`（`15 通过 · 0 失败`），
最后一句是「lint 零 error」。`VERIFY_CMD_RE` 认 `npm run lint`、`npx eslint`，
但**不认项目自带的 `lint.cjs` / `test-lint.cjs`**：

```js
VERIFY_CMD_RE.test('node qq-github-promo/scripts/lint.cjs output/x.txt')  // false
VERIFY_CMD_RE.test('node scripts/test-lint.cjs')                          // false
```

**净结论**：核心判据是**真实现、真能跑、真给退出码**，但它在真实语料上同时存在
**假阳性（案例 A、C）与假阴性（案例 B 的「全过」）**。这与仓库自己登记的
「人工抽检 13 条：11 对 2 错，精度 84.6%」量级一致——那条数字该被当成上限而非达标。

**额外一条**：`--days 3` 的 21 条 `NO_EVIDENCE` 里 **20 条来自仓库自己的 e2e 夹具会话**
（`hook-e2e-sandboxes` / `stop-hook-lab` / `tmp-analysis-hook-e2e-runs`），真实语料只有 1 条。
它们的共同特征是「夹具里没有 shell」：`106aa1ae` 的 Bash 调用数为 **0**。
所以「今天有 21 条假完成」这个读数几乎全在测自家的实验装置，不是用户语料。

### 2.2 「只在真的需要你时通知你」：定义存在，精度无证据

「真的需要」的代码定义是可读的：`NOTIFY_STATES = ['WAITING','BLOCKED','FAILED','ASKED']`，
前三个来自宿主落盘的 `sessions/*.json` 与 `jobs/*/state.json`，`ASKED` 来自 transcript 文本
且走更严的门 + 独立额度（24h ≤ 6、最小间隔 30 分钟）。`permission prompt` 被划成噪声桶
（`66/66 = 0% 真阳性`）**永不通知，但照常写观察记录**。

但「只在真的需要时」的**精度没有可用数据**：

| 口径 | 值 | 出处 |
|---|---|---|
| 按宿主状态翻转事件 | **12.0%（9/75）** | `research/2026-11-04-host-status-reliability.md` §2 |
| 按实际发出的通知 | **77.8%（7/9）** | 同上 |

仓库自己承认：「**当前证据：仅文档**。已知两个口径…都对但分母不同」（`docs/FACTS.md` §3.2），
README「已知局限」也写「通知抑制准确率无法自测」。同一份报告还警告这 9 条
「不是历史全貌，是四个观测窗口的抽样，不要拿它去估长期误报率」。

**所以：这条声称目前没有证据支撑，且仓库知道并写了出来。** 问题不在撒谎，在于
「只在真的需要你时通知」出现在 README 第 6 行与第 22 行——**在两处最显眼的断言位置，
都不带任何保留语**，保留语只在第七屏之后的「已知局限」里。

**一个当场可复算的矛盾**：实测时唯一在等你的会话 `<session>…` 的 `waitingFor` 是
`permission prompt`——也就是**被静音的那一类**。`scan` 把它印成
`[WAITING] … waiting:permission prompt`，TUI 把它列进「需动作 (1) / 在等你」，
而 `watch --inbox` 同时报「收件箱：空」。同一个事实，两个入口给出相反的动作提示，
**TUI 没有说明这条属于「不会通知」的噪声桶**。这不违反任何单条文档，但它正是
用户会误解「它在等我 vs 它在忙」的地方。

### 2.3 「不能自动接力」：警告本身成立，但它给的理由已被自己推翻

这是本次审计里最严重的一处**内部不一致**，也是「文档说 A、实际做 B」最典型的一处。

README 第 94-100 行把「不能自动接力」归因为**平台的墙**：

> 官方文档写明：来自另一个会话的消息永远不算你的同意……`claude --help` 对
> `--bg --resume <session-id>` 的原文也是「或者在会话已在运行时启动一个副本并说明这一点」：
> 你以为接上了，实际另一个副本在跑。
> ……往这个方向加自动化，等于**和平台的安全模型对打**。

README 第 168 行把这一点提到收尾结论：

> 要「自动接力、自动决策」，**不够用，而原因是平台的墙，不是缺一个 feature。**

对照仓库自己的两份文档：

- `docs/research/README.md`「已被推翻的结论」表第 6 行：
  **「本库不能自动接力」结论不成立**，通道通、投递技术上可达；
  同表第 7 行：**`--resume` 不会「产生副本」，那是把 `--fork-session` 的行为安到了 `--resume` 上**。
- `docs/adr/0001-config-only.md` §3（2026-10-30 修正）：
  「普通 `--resume` 对运行中的后台会话是**拒绝**，不是产生副本」；
  「**所以：能自动投递**」；
  「『不能自动接力』这条代价描述**已失效**……`host` 模式现在**技术上可达**」；
  「仍然成立的部分：relay 的 `manual` 默认值不改。原因**不再是『做不到』，而是产品选择**」。

复算：`grep -n "副本" README.md docs/GUIDE.md` → README:98、GUIDE:7、GUIDE:218
三处仍在讲「落到副本上」；`ADR-0002 §4` 也仍在讲副本，并自陈
「**未能实测**注入语义，上述结论仅来自 `--help` 文本」。而 ADR-0001 已经把这条推翻了。

**判定**：能力边界（只能手动）是对的，代码也真的没有投递路径——**做的是 B，说的是 A 的理由**。
按本任务的定义，这比「跑不通」更严重：它不是缺功能，是**结论已经在仓库内部被推翻，
而最显眼的三份面向用户的文档没跟上**。同时它挡住了真正的产品判断——「不做自动投递」
是产品选择（会暴露「来自另一个 Claude」的框），不是安全墙，两者对路线的影响完全不同。

副证：`docs/adr/0002-honest-degradation.md` 的状态行仍是 `Proposed`，且
「与本文冲突的条目以本文为准」——而本文正是那条被推翻的副本论述。两份 ADR 对同一件事
给出互斥结论，读者按任一条都能自证合规。

### 2.4 「生成带具体下一步的接力草稿」：能力在，GUIDE 描述的是已删除的行为

GUIDE §5「复制接力草稿」逐字给出复制出来的内容**分两段**：

```
把回执发给我

（目标会话正在等待：要我现在就把用户回执交给你，还是你先看这四份报告？）
```

`docs/CHANGELOG.md` 明确记录这段已被**删除**：

> **`buildDraft` 只返回一段可直接发送的正文。** 旧实现把 `suggestedReply` 与
> `（目标会话受阻，在等：${needs}）` 用 `\n\n` 拼在一起……**只有 `needs` 没有
> `suggestedReply` → `null`**（旧行为会拼一段旁白，那正是缺陷本身）。

直接调 `buildDraft` 复算：

```js
buildDraft({needs:'要我现在就把…还是你先看这四份报告？', suggestedReply:'把实测单发给我'})
// → "把实测单发给我"      （只有一段）
buildDraft({needs:'…', suggestedReply:null})   // → null（GUIDE:272 说「只能复制到（…）」）
```

GUIDE:272 那句「按 `c` 只能复制到『（目标会话正在等待：API unavailable…）』」现在
**跑不出这个结果**——它会返回 `null` 并提示「宿主没给建议回复，需要自己写」。
能力本身是对的（甚至更对），是**手册在描述一个已被删掉的实现**。

---

## 3. 硬门到底核住了什么

`check-structure.mjs:1565 checkCapabilities()` 实际做三件事：

1. `docs/CAPABILITIES.md` 存在；
2. 表格行里每个 `node scripts/X.mjs` 的**脚本文件存在**；
3. 每个 `--flag` **在脚本源码里作为子串出现过**（`src.includes(f)`，`check-structure.mjs:1588`）；
4. README 里出现字符串 `docs/CAPABILITIES.md`。

**它不核「命令能跑」，也不核「输出支持那句声称」。** 源码注释第一句就写明了
（`1458-1459`：「**不执行命令**」），`CAPABILITIES.md` 开头也自我声明
「它不能证明『输出支持这句声称』」。**在这一层上，仓库是诚实的。**

但我要把第 3 条钉死，因为它比自我声明更弱：**它查的是子串，不是参数解析。**
负向测试（在仓库副本里做，未改本仓）：

| 注入 | 硬门结果 | 事实 |
|---|---|---|
| 能力行写 `scan-sessions.mjs --nonexistent-flag-xyz` | ❌ 红（正确） | — |
| 能力行写 `scan-sessions.mjs --name` | ✅ **绿** | 该 flag 只在**注释**里出现（`--name` 是历史文案）；`scan` 无参数校验，`--name` 被**静默忽略**，跑的是默认 7 天 |
| 能力行写「实时干预运行中的会话、把回复发进目标会话并替用户点同意」，命令栏填 `scan-sessions.mjs --days 3` | ✅ **绿** | 能力与本仓「不能做」表**直接矛盾**，命令与能力毫无关系 |
| 在 README「核心能力」表新增一行 `能自动把回复发进目标会话并替你点同意`（**不给命令**） | ✅ **绿** | 硬门不连接 README 行与 CAPABILITIES 行 |

所以回答任务里的三问：

- 核的是「每条能力都有一条命令」——**只核到这一层的一半**（脚本名 + flag 子串）；
- **不核**「那条命令真的能跑」（`--name` 例子证明它会把跑不通/被忽略的参数放行）；
- **不核**「跑出来的东西真的对得上」——这一条它自己承认了。

`CAPABILITIES.md §5.1` 也承认「两处都要有，**缺一个硬门不管**」。
**结论：CAPABILITIES.md 的「已登记」是一个弱保证。** 它能挡住「脚本被删/改名后 README 还在承诺」
（这一种确实挡住了，负向测试第 1 行），但挡不住「能力吹大了」和「参数是假的」。
把「硬门会检查那些命令的脚本与参数真实存在」（README:54）当成可信度背书，会高估它。

**同一道门里核得最实的反而是别的检查**：`checkTestCount()` 真的数源码再对账四份文件。
审计期间测试数从 1261 变 1274（别的会话在加测试），硬门立刻把 README / CLAUDE / GUIDE / CI
里的数字一起改成 1274——这一条是**真的机械保证**，与 `checkCapabilities()` 形成鲜明对照。

---

## 4. 文档可信度分层是否被遵守

`docs/README.md` 声明四类：根目录/`docs/*.md` = 当前事实；`spec/` = 唯一真源；`design/` = **全部未实现**；`research/` = 过程记录（引用前先查状态表）。

### 4.1 `design/` 被当成事实引用的地方

| 位置 | 引用 | 问题 |
|---|---|---|
| `docs/README.md:17,30`、`CLAUDE.md:21` | 「`design/` **全部未实现**」 | **与 `design/README.md` 自己矛盾**：后者有 6 行标为 `已实现` / `已接入派发链路` / `已提取`（`2026-11-13-output-reconciliation`、`2026-11-14-main-thread-authored-prompts`、`2026-11-14-gui-style-spec` 等） |
| `docs/spec/2026-11-02-autorelay-acceptance.md:30,268,413` | 引用 `design/continuation-engine.md §3.2/§6`、`design/frontend-and-shape.md` 作为做法来源 | `spec/` 是「唯一真源」，却把未实现的设计当规范来源 |
| `docs/spec/2026-11-11-question-protocol.md:4,16-17` | 「本文件把 `design/2026-11-11-question-protocol-thesis.md` 转成规格」 | 同型；且 `design/README.md` 把该 thesis 记作「零行实现」 |

前者是可修的措辞矛盾（「全部」应为「除索引标注外的其余」）；后两者是结构性的：
**`spec/` 一旦引用 `design/`，「未实现」的边界就靠读者自己守。**

### 4.2 `research/` 里已被推翻的结论，还活在 README / GUIDE 里

逐条比对 `docs/research/README.md`「已被推翻的结论」表：

| 被推翻的结论 | 仍在哪里活着 | 状态 |
|---|---|---|
| 「不能自动接力」的**理由**是平台的墙；`--resume` 产生副本 | `README.md:98,168`；`GUIDE.md:7,218`；`ADR-0002 §4`（且 ADR-0002 自称优先级高于 spec） | ❌ **仍在**，见 §2.3 |
| 「前台交互会话没有 token 计数」 | `GUIDE.md:144`「**前台交互会话没有**：宿主不落盘它们的 token 计数」 | ❌ **仍在**。本机复算：436 个主 transcript 里 **388 个**带 `message.usage`、**334 个**非零——这条账一直在盘上 |
| 「回归测试 508/192/81/588」 | — | ✅ 已修，且改成硬门机械对账 |
| 早期间隔推断判 `FAILED` | README/GUIDE 都已写「已删除」，代码里确实返回 `EXPLORING/dormant` | ✅ 一致 |

### 4.3 「声称已实现，但只有 design 文档」的反向漏

`design/2026-11-14-main-thread-authored-prompts.md` 状态列写「**已实现（原型 + 49 条测试）**」，
`scripts/compose-agent-prompt.mjs` 与 50 条测试都在。但：

- `docs/CAPABILITIES.md` **没有它**（`grep -c compose-agent-prompt` = 0）；
- `README.md` **没有它**；
- `.claude/skills/oversight/SKILL.md` **没有接**（`grep -c compose-agent-prompt` = 0），
  而该 design 文档自己写「未接入 SKILL.md Phase B（下一轮）」。

于是它落在四类文档的缝里：**已实现、已测试、不在能力清单、不在手册、不在流程**。
按仓库自己的规则（`CAPABILITIES.md §5`「加了能力 → 这里加一行」），这是一条未登记的能力——
而硬门**不会**因此变红（它只查「已登记的能否解析」，不查「已实现的有没有登记」）。

### 4.4 数字快照的一致性

README:126 把「228 个主 transcript、31 条断言：SUPPORTED 26 / STALE_ONLY 1 / NO_EVIDENCE 1 / UNKNOWN 3」
写成「全量实测」，**没有日期**。三份快照彼此对不上：

| 来源 | 会话数 | 断言数 | 时间 |
|---|---|---|---|
| README:126 | 228 | 31 | 无日期（数值与 `research/2026-11-03-verify-claims.md` 同源） |
| `FACTS.md` §1.2 | 349 | 108 | 2026-11-12 |
| 本次实测（全量） | **436** | **149**（46/11/50/3/39） | 2026-11-14 |

`FACTS.md` 头部已声明「这是快照、引用前重跑」，属合规范本；README 那句没有。
同类：README 写「全量耗时 2.9–5.6 秒」，本次 7.5–8.0 秒（`CAPABILITIES.md` 顶部警告
「不要相信任何文档里写死的秒数」，README 自己没照办）。

---

## 5. 一句话诊断

**产品形态搭建起来了——31 条能力声称里 23 条跑得出与描述一致的输出，2 条不成立、6 条带保留；
它的核心判据是真的、能跑、有退出码，不是 PPT。**

判据（三条，全部可复算）：

1. **每一条「能做」都有一条今天能跑的入口。** 31 条里只有 2 条跑不通/不符
   （Node ≥ 18 与「可排序的表」），且都是措辞层面的夸大，不是空心功能。
2. **核心卖点真的在跑，但它自报的精度是上限。** `verify-claims` 的机制、退出码、
   CI 语义全部到位，`--explain` 能逐条给出命中的调用；但 3 个人工核对的真实案例里
   1 假阳性 + 1 误报 + 1 漏报（§2.1），说明「84.6%（n=13）」该当上限而不是达标线。
3. **最严重的缺陷不是「跑不通」，是「文档说 A、代码做 B」且理由已被自己推翻。**
   「不能自动接力」的理由（平台的墙）在 ADR-0001 与 research 索引里已被记为**失效**，
   但 README / GUIDE / ADR-0002 仍在用它；GUIDE 的接力草稿示例描述的是已删除的实现；
   GUIDE 的 token 段仍在复述一条已被推翻的结论。**这三处都在面向用户的第一层文档里，
   而硬门一条也管不到。**

一句话收口：**形态有了，诚实度高于同类，但它的「诚实」集中在自己承认不了的地方
（判据精度、通知准确率），而没覆盖「已推翻的结论还在首页」这一类——后者才是当前
最大的可信度风险，且完全可以机械化（把 research 索引的「已推翻」表与活文档做交叉检查）。**

---

## 6. 本次审计的自身边界

- 交互式 TUI 的键位（`Enter` / `c` / `?`）在非 TTY 下**未实测**，只验了 `--plain` 路径与纯函数
  （`buildDraft` / `draftHintOf` / `partitionRows` / `viewOf`）。
- Windows 桌面通知的**实际弹出**未验（只验了 `isNotificationAvailable() === true` 与退化路径）。
- Node 18 的失败是**静态复算 + 失败模式复现**（`import.meta.dirname` → `undefined` → `join` 抛 TypeError），
  本机无 Node 18 可直接实跑；CI 钉 node 20 故也无法暴露。
- 审计期间仓库被并发修改，测试数 1261 ↔ 1274 漂移过一次；§1 表中 #30 与 #28 的时间点不同。

---

## 7. 报告自身带来的硬门后果（需要下一个人处理）

本文件是新增研究文档，而 `checkResearchIndex()` 要求每份报告在 `docs/research/README.md` 登记状态。
**按任务约束我未改任何其他仓库文件**，所以在你补上索引行之前 `node scripts/check-structure.mjs` 会红。
建议条目（照索引表列数对齐）：

```
| 11-14 | `2026-11-14-capability-claim-audit.md` | 31 条能力声称逐条绑命令实测：23 ✅ / 6 ⚠️ / 2 ❌。硬门 `checkCapabilities()` 只查脚本名与 flag **子串**，负向测试四条里三条放行（`--name` 被静默忽略、假能力行、README 无命令行）；「不能自动接力」的理由已被 ADR-0001 与 research 索引记为失效但仍在 README/GUIDE/ADR-0002；GUIDE 接力草稿仍是已删除的两段式；GUIDE token 段复述已推翻结论。`verify-claims` 三例人工核对：1 假阳性（`ctest` 目录名命中测试正则）/ 1 误报（自带 `lint.cjs` 不在 `VERIFY_CMD_RE`）/ 1 漏报（「全过」不在谓词表） | ✅（本机全量实跑 436 transcript；诚实边界见报告 §6） |
```
