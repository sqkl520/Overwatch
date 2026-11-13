# 一致性审计：文档声称 vs 代码事实

- 审计日期：2026-11-13
- 审计范围：全仓 `.md`（不含 `.tmp-analysis/` 参考项目副本）、`scripts/*.mjs`、`.claude/`、`.github/workflows/`
- 实测环境：本机，Node v26.12.1，工作树 HEAD 为 `699231d` + 未提交改动
- 产出形态：exploration（只审计，未改任何产品文件）

> **方法**：能跑的真跑。测试数、耗时、阈值、命令行参数、每个脚本是否存在，全部用 `node` 实测或 `grep` 源码核对。核不出的标注「未核」并写明原因。全量测试只跑一次（`node --test scripts/*.test.mjs` → 793/793）。

---

## 一、结论先行

**共查出 24 处不一致**，其中 🔴 危险 6、🟡 误导 11、🟢 陈旧 7。「未核」2 处。

**最严重的三条**：

1. **测试数四个文件四个值**（README 508 / CLAUDE 192 / GUIDE·CI 81 / 设计文档 588），实测 **793**。这是本仓论题的自我否定：一个卖「断言必须有证据」的项目，在最核心的数字上四份文件四个值，而 CI 里那个 81 已经停在两年前的量级。
2. **README/GUIDE 报的 `--days 3` 扫描耗时 33 秒，实测 65 秒**（本机 332 个 transcript；文档自己援引的分母是 3,354 个，与实测语料规模对不上）。用户据此判断「跑一次多久」会错一倍。
3. **GUIDE §3 的 `FAILED` 判据与代码相反**：GUIDE 第 81 行仍写「或两次调用间隔超过 p95 且 60 秒无新记录；或预算耗尽且零增益」都是 FAILED 判据，而代码里这两条**都已删除**（`scan-sessions.mjs:219` 注释、`state-model.md §2.0.1` 都明写删除）。用户照 GUIDE 会把一个只是歇了一会儿的会话判成「该重跑了」——正是 ADR-0002 花整篇篇幅要消灭的误判。

> 另有一条**过程性发现**：`verify-tui-negatives.mjs` 的 v17 变异（把 `buildDraft` 退回「有 needs 就拼旁白」）在我的 90 秒超时下被 `kill`，`finally` 未执行，`oversight-tui.mjs` 留在被改状态、`oversight-tui.test.mjs` 出现 2 条红。我已手工还原并把全量测试跑回 793/793。这说明该负向验证器**在被打断时会留下脏工作树**——它没有「先写备份、崩溃后能恢复」的机制，只有 `try/finally`。

---

## 二、🔴 危险（会让用户做错决定）

| # | 文件:行号 | 声称 | 实际 | 核对方法 |
|---|---|---|---|---|
| 1 | `docs/GUIDE.md:81` | `FAILED` 判据 = 「宿主报失败 **或**间隔超 p95 且 60s 无新记录 **或**预算耗尽且零增益」 | 代码只认宿主 `jobs.state === 'failed'`。p95 推断与预算判据**均已删除** | 读 `scripts/scan-sessions.mjs:174-262`（`judgeState` 全函数）+ `state-model.md:71-80` |
| 2 | `docs/GUIDE.md:94` | 「判 `FAILED` 的条件之一是末次调用间隔超过 p95」 | 这条已被删除。代码注释 `scan-sessions.mjs:219` 明写「2026-10-31 全语料实测后删掉了」 | 同上；`grep -n 'p95.*FAILED' scripts/scan-sessions.mjs` 命中处全是「已删除」的注释 |
| 3 | `scripts/verify-claims.mjs:1228` | 补救建议硬编码 `'npm test（或本项目实际的测试命令）'` | 实际命令就在 `timeline` / `evidence.detail.hits` 里（`cmd` 字段，`verify-claims.mjs:626` 的 `tag()` 已带 `cmd.slice(0,160)`），但 `adviceFor()` 没用它。对 Maven 项目输出「重跑 npm test」 | 跑 `node scripts/verify-claims.mjs --days 3`，末段建议对 Java 会话仍打印 `npm test`；读 `adviceFor()` 全文（1222-1260）确认无 `cmd` 取用 |
| 4 | `README.md:128` / `CLAUDE.md:36` / `docs/GUIDE.md:393` / `.github/workflows/validate.yml:23` | 回归测试 508 / 192 / 81 / 81 条 | 实测 **793**（18 个 test 文件，逐文件相加 = 793） | `node --test scripts/*.test.mjs` → `tests 793 pass 793`；逐文件跑一遍求和亦为 793 |
| 5 | `docs/GUIDE.md:403` | 「子 agent 上限 30，超出被截断（显示 `30/N~`）」 | 常量 `MAX_SUBAGENTS = 100`（`scan-sessions.mjs:490`）。同一文件第 122 行自己写的是「展开最近的 **100** 个」 | `grep -n 'MAX_SUBAGENTS' scripts/scan-sessions.mjs`；实测输出里出现 `sub=100/506~` |
| 6 | `docs/GUIDE.md:317` | 「每个会话最多展开 **30** 个子 agent」 | 同 #5，实为 100 | 同 #5 |

> #1/#2 与 #5/#6 都是同一份 GUIDE 内部自相矛盾：第 81 行 vs §2.0.1、第 403 行 vs 第 122 行。用户不需要交叉核对代码就能发现，但会被哪个是真的搞糊涂。

---

## 三、🟡 误导（数字不对但不影响能否使用）

| # | 文件:行号 | 声称 | 实际 | 核对方法 |
|---|---|---|---|---|
| 7 | `README.md:33`、`docs/GUIDE.md:36`、`CLAUDE.md:33` | `--days 3` 实测约 **33 秒** | 实测 **65 秒**（118 会话 / 332 transcript）；同机 `--days 30` 为 55 秒 | `time node scripts/scan-sessions.mjs --days 3` |
| 8 | `docs/GUIDE.md:317`、`:320` | `--days 30` 为 87 秒、分母「3,354 个 transcript」 | 实测 55 秒；本机 transcript 总数 332。「3,354」这个分母在本机任何一次运行都复现不出 | 同 #7 + 输出首行 `transcript 332 个` |
| 9 | `docs/GUIDE.md:317` | 「最多展开 30 个子 agent」导致耗时 | 100（见 #5） | 同 #5 |
| 10 | `CLAUDE.md:36` | 192 条 | 793 | 同 #4 |
| 11 | `docs/design/2026-11-10-agent-framework-skeleton.md:105`、`:185` | 「被 **588 条测试**钉住」 | 793（588 是 2026-11-05 的历史值） | 同 #4 |
| 12 | `.github/workflows/validate.yml:23` | 「全部回归测试（81 条…）」 | 793 | 同 #4 |
| 13 | `docs/CHANGELOG.md:15` | GUIDE 是「**437 行**使用手册」 | 实测 405 行 | `wc -l docs/GUIDE.md` |
| 14 | `docs/CHANGELOG.md:5` | 仓库 `https://github.com/sqcola/Overwatch` | `git remote -v` 是 `https://github.com/sqkl520/Overwatch.git`；README:18 也用 `sqkl520` | `git remote -v` |
| 15 | `docs/GUIDE.md:344` | 「scan 顶部那 **8 行**『宿主注册的活跃会话』」 | 实测 **12 行**（主机上注册的会话数会变；这里的「8」是写死的旧快照） | 跑一次 `scan --days 3` 数那一段行数 |
| 16 | `docs/GUIDE.md:56`、`:137` | TUI「默认每 **8 秒**重扫」 | `DEFAULT_INTERVAL_SEC = 8` 属实，但 `scheduleNext()` 在 `await job.promise` **之后**才调用（`oversight-tui.mjs:1400`），单轮扫描本身 50-65 秒，于是实际刷新周期 ≈ 扫描耗时 + 8 秒。界面上那句「每 8s 轮询」陈述了没做的事（此缺陷 `docs/research/2026-11-11-hostile-user-review.md` 第 8 条已记录，**至今未修**） | 读 `refresh()`（1369-1405）：`await job.promise` 后才 `scheduleNext()` |
| 17 | `docs/GUIDE.md:74-79` | 「读懂**五态**…是五种，不是四种」，表格 5 行 | 代码里 6 个可输出状态（`EXPLORING/PRODUCING/STALLED/FAILED/BLOCKED/WAITING`，`scan-sessions.mjs:1094` 的排序数组）。GUIDE 全篇 **0 次**出现 `WAITING`，而它是 README 明确列出的会发通知状态之一 | `grep -c WAITING docs/GUIDE.md` → 0；`grep -n "const order" scan-sessions.mjs` |

---

## 四、🟢 陈旧（只是过期，无害）

| # | 文件:行号 | 声称 | 实际 | 核对方法 |
|---|---|---|---|---|
| 18 | `docs/GUIDE.md:393` | 「**四个**测试文件」 | 18 个 | `ls scripts/*.test.mjs \| wc -l` |
| 19 | `docs/GUIDE.md:393` | 全跑 `node --test scripts/`（**本机 81 项**全绿） | 该命令确实可用（实测 793 全绿），但数字停在 81 | 跑 `node --test scripts/` → 793 |
| 20 | `docs/design/2026-11-10-agent-framework-skeleton.md:105` | 「**5 道**结构硬门」 | `check-structure.mjs` 调用 16 个 `check*()` 函数 | `grep -cE '^check[A-Z][a-zA-Z]*\(\);' scripts/check-structure.mjs` → 16 |
| 21 | `docs/design/README.md:35` | §4.3 三层轮询 = 「1 分钟 / 5 分钟 / 30 分钟」 | `JOBS_INTERVAL = 15 * 1000`（15 秒），不是 1 分钟。`watch.mjs:7` 头注释也还写「L-fast 1 分钟」，与同文件 `:58` 的 15 秒矛盾（CHANGELOG:1807 记录改成 15 秒，但两处注释与 hosted-mode.md:377 没跟着改） | `grep -n 'JOBS_INTERVAL' scripts/watch.mjs`；`sed -n '7p' scripts/watch.mjs` |
| 22 | `docs/design/2026-11-10-agent-framework-skeleton.md:58`、`:307-308` | `acpx` 版本记 **0.22.0**；`claude-agent-acp` 未跑通 | `claude-agent-acp` 最新发布版是 **0.100.3**（npm registry 实查），`.104.1` 在 npm 上不存在——`docs/CHANGELOG.md:135` 写「`claude-agent-acp@0.104.1` 在 Windows 上全部正常」这个版本号**存疑**（可能是本地未发布版本或笔误）。「未跑通」一条已被 CHANGELOG:135 推翻 | `npm view claude-agent-acp versions --json` → 末位 `0.100.3` |
| 23 | `docs/PUBLISH-TRIAGE.md:68` | 「合计 **44 份**（42 份 docs + README + CLAUDE）」 | 判定日期是 2026-11-02 的历史快照，当时确为 44 份；今日 `docs/**/*.md` 已 86 份 + 根 2 份 = 88 份，新增的 research/design 文档（含本审计报告）**不在任何一批分拣记录里** | `ls docs/*.md docs/*/*.md README.md CLAUDE.md \| wc -l`；`grep -n '判定日期' PUBLISH-TRIAGE.md` |
| 24 | `docs/GUIDE.md:81` 表格里 `STALLED` 与 `:83` | `STALLED` 判据含「**且派生树无任一节点有增益**」 | `judgeState()` 根本不接收派生树参数（签名 `{ sessionState, waitingFor, calls, gapsMs, now }`），只检查「最后 20 次调用有无持久化变更」。三条件的第三条件在代码里**不存在** | 读 `scan-sessions.mjs:174` 签名 + `:236-246` STALLED 分支 |

---

## 五、交叉引用与命令正确性（已核对，无问题或有备注）

| 检查项 | 结果 |
|---|---|
| `docs/design/README.md` 索引表的 11 个文件 | 全部存在 ✅（唯一未列的是 README.md 自身，正常） |
| `docs/CHANGELOG.md:39` 引用的 `scripts/oversight-tui.mjs:580` | `viewOf()` 确实在第 580 行 ✅ |
| `docs/CHANGELOG.md:47`（TUI 修复条目）引用的 `tui-layout.mjs:395` | `partitionRows()` 确实在第 395 行 ✅ |
| 文档里 `node scripts/*.mjs` 命令 | 除 `docs/design/` 下明确标注「零行实现 / Proposed」的 `org.mjs` / `validate-ticket.mjs` / `count-table-rows.mjs` / `count-rows.mjs` / `check-numbers-traceable.mjs` / `judge-context.mjs` / `serve.mjs` 之外，其余全部存在 ✅。这些属设计稿里的**未来**命令，不是失效引用（但 `docs/design/README.md` 已声明零实现，风险可控） |
| `node scripts/watch.mjs --inbox`（README:37） | 可用 ✅（实测输出「收件箱：空」） |
| `node scripts/scan-sessions.mjs --recalibrate`（state-model:189） | 可用 ✅，实跑输出 `Bash: 0.75` 等新权重 |
| `node scripts/verify-claims.mjs --include-subagents`（verify-claims 头注释） | 参数存在 ✅ |
| `node scripts/check-links.mjs` | 45 个链接 0 断链 ✅ |
| `node scripts/check-structure.mjs` | 通过，0 违规 ✅ |
| `git clone https://github.com/sqkl520/Overwatch.git`（README:18） | 与 `git remote -v` 一致 ✅（CHANGELOG:5 是另一回事，见 #14） |
| `docs/spec/*.md` 内部 `§` 引用 | `state-model §3.4` / `§5` / `§7` / `§4.4` 等章节编号全部存在 ✅ |

---

## 六、未核（2 处，附原因）

| # | 声称 | 为什么未核 |
|---|---|---|
| U1 | `README.md:113`「verify-claims 全量 228 主 transcript / 31 条断言 / SUPPORTED 26… / 耗时 2.9–5.6 秒」 | 需固定某一天的语料快照才能复现「228 / 31 / 26」这组分布。实测当次是「332 transcript / 77 条断言 / 28 SUPPORTED / 7.2 秒」，但语料每天都在长，**无法判定是「当时数字错」还是「语料已漂移」**。耗时的量级（2.9–5.6s vs 实测 7.2s）看起来偏乐观，但不足以断言 |
| U2 | `README.md:105`「Cognition 2026 实测：每个 PR 抓 2 个 bug，约 58% 严重」、「约 15× token、解释 80% 方差」 | 外部文献数字，需访问原文核对，超出本机审计范围 |

---

## 七、建议修复优先级

**P0（当天修，改 1 行、零风险）**
1. 把测试数统一为 793：`README.md:128`、`CLAUDE.md:36`、`docs/GUIDE.md:393`、`.github/workflows/validate.yml:23`。**更好的做法**：CI 与硬门里不写死数字，跑完 `node --test` 后比较实测值——否则下一次提交又会漂。
2. `docs/GUIDE.md:81` 与 `:94` 的 `FAILED` 判据，照 `state-model.md §2.0.1` 改写为「只认宿主上报」。
3. `docs/GUIDE.md:403`、`:317` 的「子 agent 上限 30」改为 100（与同文件第 122 行一致）。

**P1（本周修，涉及代码）**
4. `verify-claims.mjs:1228` 的 `adviceFor()`：从 `timeline` / `evidence` 里取实际命令（`hits[].cmd` 已带），取不到再退回泛化措辞。这是「报告里指错命令」的直接来源。
5. GUIDE §3 补上 `WAITING`（或在标题里说清「这里只讲 5 个，另有 WAITING 见 §2」），让「五态」与代码的 6 个输出状态对齐。
6. `verify-tui-negatives.mjs` 加「崩溃可恢复」：变异前把原文写到临时文件，启动时若发现临时文件则先恢复——现在的 `try/finally` 挡不住 `SIGKILL`/超时。

**P2（下个迭代，数字重测）**
7. README/GUIDE/CLAUDE 的 33 秒、87 秒必须在当前语料上重测后改写，并按 GUIDE:319 的既有约定标上取数日期。
8. `docs/design/README.md:35` 与 `watch.mjs:7` 头注释的「1 分钟」改为 15 秒，或说明已是 15 秒。
9. `docs/CHANGELOG.md:15` 的「437 行」改为「约 400 行」或去掉行数（会继续变）。
10. `docs/CHANGELOG.md:5` 的 `sqcola` 与 `README.md:18` 的 `sqkl520` 二选一，统一。

**P3（记账）**
11. `PUBLISH-TRIAGE.md` 补记 2026-11-05 之后新增的 research/design 文档（含本报告）分拣结论，否则「可发布区」清单已与磁盘脱节。

---

## 附：实测原始数据

```
$ node --test scripts/*.test.mjs
ℹ tests 793   ℹ pass 793   ℹ fail 0   ℹ duration_ms 42983

逐文件：
  app-router 21 · asked 68 · classify-stop 42 · install-watcher 12
  measure-interventions 34 · oversight-tui 46 · replay-observe 15 · state-model 41
  stop-signals 34 · stop-verify-hook 35 · tui-bugfixes 38 · tui-layout 76
  tui-meta 22 · tui-redesign 28 · tui-theme 9 · validate-run 12
  verify-claims 116 · watch 144        （合计 793）

$ time node scripts/scan-sessions.mjs --days 3     → 65s（118 会话 / 332 transcript）
$ time node scripts/scan-sessions.mjs --days 30    → 55s（276 会话 / 332 transcript）
$ time node scripts/verify-claims.mjs              → 8.0s（77 断言 / 28 SUPPORTED）
$ node scripts/check-structure.mjs                 → 通过，0 违规（16 个 check 函数）
$ node scripts/check-links.mjs                     → 45 链接，0 断链
$ node scripts/gen-width-table.mjs --stats         → eawRanges 298（与文档一致）

$ ls scripts/*.test.mjs | wc -l           → 18
$ ls scripts/*.mjs | grep -v test | wc -l → 25
$ ls .claude/agents/*.md | wc -l          → 12（与 README/GUIDE 一致）
$ wc -l docs/GUIDE.md                     → 405（CHANGELOG 说 437）
$ npm view claude-agent-acp versions      → 末版 0.100.3（无 0.104.1）
```
