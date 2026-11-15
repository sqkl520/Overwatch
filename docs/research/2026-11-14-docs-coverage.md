# 文档覆盖与假承诺传播（复核）

- 日期：2026-11-14
- 作者：复核 Agent（只读；除本报告与本页登记外不改任何仓库文件）
- 产出形态：`exploration`（结论报告，零行改实现）
- 实测环境：Windows 11 / Git Bash / Node v26.12.1
- 任务范围：三件小事——新入口的文档覆盖、`agent.roster` 假承诺的传播面、CHANGELOG 最上面三段的可疑声称

> **结论先行：新用户按 README 走，不会知道 `overwatch.mjs` 存在**（三个面向用户的文件里 0 命中）。
> `agent.roster` 仍有 4 处在暗示它生效。CHANGELOG 顶部三段里有 4 条声称与代码不符，
> 其中最硬的一条是「7 项前提」——实际 8 项，且本机实测 1086–1200 ms **超出它自己声明的 1000 ms 预算**。

---

## 1. 新入口的文档覆盖

`grep -c`（大小写不敏感，`launch` 含 `launchd` / `launcher` 这类无关词）：

| 文件 | `overwatch.mjs` | `launch` |
|---|---|---|
| `README.md` | **0** | 1（是 `launchd`，无关） |
| `docs/GUIDE.md` | **0** | 1（是 `...android-launcher`，无关） |
| `docs/CAPABILITIES.md` | **0** | **0** |

**新用户会不会知道这个入口存在：不会。** 依据：

1. README 的「30 秒上手」第一条命令直接是 `node scripts/scan-sessions.mjs --days 3`，
   之后是 `oversight-tui` / `watch --inbox` / `install-watcher install`——四条原生命令，
   没有一条经过入口。README 的目录树（`scripts/ scan / watch / verify-claims / ...`）
   也没列 `overwatch.mjs` / `launch.mjs`。
2. `docs/CAPABILITIES.md` 是「每条声称绑一条能跑的命令」的唯一清单，其中 `overwatch.mjs`
   与 `launch` 都是 0 行。按该文件自己的规矩（「加不出命令的能力…不该写进 README」），
   反过来说明：入口与 launch 属于**没有任何能力清单条目**的新能力。
3. 唯一指向它的是 `docs/README.md:12`（「我刚装完，装对了吗 → spec/2026-11-14-entry-point.md」）
   与 README 末尾「从 `docs/README.md` 开始」。也就是说：**要走两跳、且第一跳在 README 最底部**，
   才能读到入口。这不算「README 覆盖了」。
4. 对照 `overwatch.mjs` 自己的文件头注释：它存在的理由之一就是「干净 clone 上不知道第一条命令该跑什么」。
   入口做了这件事，但 README 的第一条命令仍在推荐绕开它的旧命令 —— 理由与入口互相抵消。

**副产物发现（不是本次任务要求，但不写会误导下一个人）**：入口自称「唯一入口」，
但 `scan`/`verify`/`tui`/`watch`/`plan` 五个子命令**实测全部 exit 4**（只打印等价原生命令）。
即：新用户即使找到了入口，能用的只有 `doctor` 与 `launch`。文档没有一处写明这个落差。

---

## 2. `agent.roster` 假承诺的传播面

**先更正任务书的前提。** `grep -rn roster scripts/*.mjs | grep -v question-audit` **不是零命中**：
`scripts/launch.mjs` 有 26 行命中。它读配置（`configInfo()`）、算「没被启用的角色」
（`rosterGap()`）、把 `roster.applied:false` 写进 `--json` 与台账。
所以准确的说法不是「没有一行代码读它」，而是「**没有一行代码按它派发或挂载**」——
后者成立，且 launch 三处都如实说了。

逐处判定（只算结构化文档，不含 `docs/research/` 的历史报告）：

| 位置 | 原文要点 | 判定 |
|---|---|---|
| `overwatch.config.json:11` | 裸键 `"roster": [三个角色名]`，无任何注释说明它不生效 | **暗示生效**（配置文件的存在本身就是承诺） |
| `docs/design/2026-11-14-agent-roster-policy.md:13` | 「**未启用的岗位，它负责的环节不执行。** 这是用户明确要的」 | **暗示生效**（该 doc 无「零行实现」字样；靠 `docs/design/README.md` 索引一句「零行实现」兜底） |
| `docs/spec/2026-11-14-question-audit.md:206` | 「启用哪些岗位」 | **暗示生效** |
| `docs/spec/2026-11-14-question-audit.md:219` | 「打错一个名字等于**静默少一个岗位**」 | **暗示生效**（这句话只有在 roster 真的筛岗位时才成立） |
| `docs/spec/2026-11-14-launch.md` §5（14 行命中） | 整节「只影响调度，不影响挂载」+「没有一行代码在执行」+ 三处告知表 | **如实**（唯一一处写透的；但「没有一行代码在执行」这句本身已被 `launch.mjs` 推翻，需改成「没有一行按它派发」） |
| `docs/README.md:13` | 「roster 为什么只能整目录挂」 | **如实** |
| `docs/design/README.md:28` | 「**零行实现**」 | **如实** |
| `README.md` / `docs/GUIDE.md` / `docs/CAPABILITIES.md` | 0 命中 | **沉默**（既不暗示也不澄清——新用户读不到任何提示） |

**合计：4 处在暗示生效，3 处如实，3 份用户文档完全沉默。**

代码层还有两处在加强这个假承诺（不在任务清单里，但传播面的一部分）：
`scripts/question-audit.mjs:218` 拒绝空 roster 的理由写着「没有一个角色就没有可派发的东西」；
`launch.mjs` 注释里同句。两句话都让读者以为 roster 决定派发。

---

## 3. CHANGELOG 最上面三段：最可疑的 5 条

只核「已实现 / 新增 / 修好了」形态里最像会翻车的 5 条，不逐条核。

| # | 声称（段 / 原话） | 核实结果 |
|---|---|---|
| 1 | 段 1 ·「1000ms 内报告 **7 项**前提事实」+「本机实测 691ms」 | **两半都不成立。** `overwatch.mjs` 的 `CHECKS` 是 8 项（`doctor` 首行自己印「查 8 项前提」），第 8 项 `plan` 是段 1 后半段自己加的 Changed 条目——**同一段里前文说 7、后文说 8**。时间：连跑三次自报 **1086 / 1200 / 1149 ms**，均超 1000 ms 预算；父进程计墙钟 1511–1686 ms。`docs/spec/2026-11-14-entry-point.md:19` 同样写「7 项」，没跟着改。 |
| 2 | 段 1 ·「`agent.roster` 目前没有一行代码在执行（`grep -rn roster scripts/*.mjs` 排除 `question-audit` 后**零命中**）」 | **字面假，结论真。** 实测 `launch.mjs` 26 行命中并真的读它；但没有任何代码按它派发/挂载，所以「不影响挂载」的结论成立。**这条错误的危害在于**：它把一句可复核的 grep 数字写成了证据，而那个数字当场可证伪——下一个人照抄这句会重复传播「零命中」。 |
| 3 | 段 1 ·「`docs/spec/output-format.md` 与 `SKILL.md` 里那句**「渲染器还没有」至此第一次有了实现**」 | **没做。** `docs/spec/output-format.md:17,20` 仍写「仓库里没有任何脚本输出这个格式…得先写一个渲染器——现在没有」；`.claude/skills/oversight/SKILL.md:238` 仍写「格式是约定，渲染器还没有」。另外 `render-plan.mjs` 输出的是**任务级 plan**（`PLAN <run> · 进度 2/5…`），不是 output-format §2 的**逐 Agent 状态行**（`[阶段B · Agent#3 EXPLORING · reads=…]`）——两者不是同一个东西，「至此第一次有了实现」把两件事混成一件。 |
| 4 | 段 1 ·「`question-audit.mjs` + `overwatch.config.json` —— **提问层（S3/S5）第一次有实现**」 | **只有审计器，没有层。** 脚本真能跑（`--help` 正常，四条判据都在），但它是**事后扫 transcript** 的工具：`grep -rn question-audit .claude/ README.md docs/GUIDE.md docs/CAPABILITIES.md templates/` **零命中**——SKILL.md 的派发流程不调它，README/CAPABILITIES 不列它，配置里的 `ask.mode: "always"` 没有任何执行侧消费者（唯一的 `ask.mode` 读取点在 `question-audit.mjs:619`，是审计自身）。即：**配置写了「每次都审」，但没有任何环节会在派发时审。** 这正是「假承诺」的第二种形态：不是配置无效，是配置没有执行者。 |
| 5 | 段 3 ·「测试数 1261 → 1274（**四份声明文件已同步**）」 | **数字全面落后。** 硬门实测源码 1533 条（`^\s*test\(`），四份文件现在都写 1533——同步机制本身有效，但这一条记的是当时的快照且没标日期口径。更要紧的是同段提到的 `verify-claims.test.mjs` **156 → 169**：实测现为 **180**。另 `docs/GUIDE.md:451` 写「**28 个测试文件**」，实际 `ls scripts/*.test.mjs \| wc -l` = **34**——文件数这个数**硬门不查**（`checkTestCount()` 只数 `test(` 条数，不数文件），所以它可以任意过期而不红。<br>**审计期间又漂了**：并行会话在改 `launch.mjs` 并新增 `launch-negatives.test.mjs`，收尾时源码条数已 **1533 → 1537**、测试文件 **34 → 35**，硬门当场把 README / GUIDE / CLAUDE / CI 四处报红。这说明**条数有门、文件数没有门**这条判断是对的，也说明「同一个数被五处文档各写一遍」的同步成本是真实存在的。 |

**顺带核过、确认属实的几条**（供对照，不是本次重点）：`check-structure.mjs` 的 `PRIVATE_PATHS`
豁免真实存在，且在干净 clone 上硬门全绿（实测）；`scan-sessions.mjs --days abc` / `-5` 均 exit 2；
`--days 3` 扫 526 行 idle，负数 **0** 行；`pre-write-gate.mjs` 的 `pathKeyOf()` 已有 win32 守卫；
`launch.mjs` 的 `--settings` 落盘文件顶层只有 `hooks` 一个键；`launch --verify` 对假宿主
`Agents (0)` 与「只印名字不印清单」两种形态都判 exit 7（这两条恰好是 `2026-11-14-launch-acceptance.md`
判 FAIL 的 AC2，现已修）；`render-plan.test.mjs` 的 CLI 端到端测试确实改用 `Date.now()` 算登记时刻。

---

## 4. 建议（不改，只记）

1. README 的「30 秒上手」第一条命令换成 `node scripts/overwatch.mjs`（doctor），
   原生命令降为「想直接跑某一步时」的第二组。否则入口写了等于没写。
2. `overwatch.config.json` 的 `agent.roster` 要么加一条 `_note` 键说明「只影响调度，
   当前无执行者」，要么从配置里删掉、等真有消费者再加回来。**配置文件里的无效键比文档里的
   失效段落更危险**——文档会被读，配置会被信。
3. `docs/spec/2026-11-14-question-audit.md` 的 roster 两行加一句「当前无执行者」。
4. CHANGELOG 段 1 的「7 项」改 8，「691ms」加实测日期；「零命中」那句改成
   「只有 `launch.mjs` 读它，用于告知不影响挂载」。
5. `docs/GUIDE.md` 的「28 个测试文件」要么改成实际值，要么删掉这个数——
   它现在是一个**硬门不守**的裸数字，下一个加测试的人不会想到要去改它。
