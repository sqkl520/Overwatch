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
> （使用手册：你会看到什么、该做什么；行数以 `wc -l` 为准）。本文件不复述它们的结论。

> **三条不给糖吃的写法约定**：
> 1. 每条必须写出处——commit hash、文件路径、函数名、实测数字。写不出出处的，不要写。
> 2. 「修好了」必须有负向证据：把 bug 放回去，测试/硬门要变红。只跑一次绿灯不算。
> 3. 数字冲突时以最新实测为准，并在条目里说明旧数字为什么错。

---

## [Unreleased] - 2026-11-14（写前闸：按首写工具拆判据 + 堵掉伪造标记）

> 两件事都是**已实测确认**的缺陷，不是设计推演。依据：
> `docs/research/2026-11-14-gate-widening-resolution.md`（P1 的裁决）与
> `docs/research/2026-11-14-gate-widening-redteam.md` §1.5 / §5-B（伪造路径）。
> 复算：`node scripts/resolution-gate-audit.mjs --only R8`。

### Changed

- **`pre-write-gate.mjs`：`Edit` / `MultiEdit` / `NotebookEdit` 换成「读过这个文件本身」这条判据**
  （新增 `EDIT_SIDE_TOOLS`，新增 `allowReason:"target-read"`）。`Write` 与 shell 写入**一行未改**，
  仍是「读过 ≥`minReads` 个不同文件」。
  **依据**：R8 实测被拦 27 个会话 = Edit/MultiEdit 4 · Write 23；被拦里「首写前读过同一文件」4 个
  （即这 4 个**全都**读过自己的目标）。本机复算（`observe-reality-check` 的 `analyzeOne`，435 份
  transcript → fork 去重后 410，有写 202）：真实 Edit-first 18 个里 targetRead **18**、
  「reads≥3 且**没**读目标」**0** 个；沙箱 Edit-first 8 个里 targetRead 7、同类 0 个。
  逐会话对照旧判据：**只有 4 个会话改变判定**（正是那 4 个误伤），其余 198 个逐条相同。
  **这一条比原来更严**，不是更松：它同时拦下「读了 3 个无关文件就改一个没读过的文件」——
  与宿主自己的 Edit 门一致。安全兜底是标记语义：任何通过的 `Write` 都会落标记，
  所以「先写新文件再 Edit 它」走 `marker-present`，不会掉进这一支。
  `target-read` **不写标记**：它只证明这一个文件读过，不证明读过这个项目。
- **`pre-write-gate.mjs`：`satisfied_by:"auto"` 改为必须带 HMAC-SHA256 签名**（`node:crypto`，零依赖）。
  签名覆盖 `session_id + at + reads + verified_at + reads_sample + prompt_id`，密钥是
  `.claude/.ow-gate-secret`（**首次写 `auto` 标记时随机生成**，32 字节 hex，不硬编码）。
  `markerValidity()` 重算比对（`timingSafeEqual`），不合法即判 `auto-unsigned` /
  `auto-bad-signature` / `auto-no-secret`，并退回 transcript 判定。
  **依据**：红队 §1.5 + §5-B 实测一条 `echo '{"satisfied_by":"auto","reads":99}' > .claude/.ow-read-done`
  就能让闸门记 `allow / marker-present / by=auto`，事后审计完全失效；且 `session_id` 从
  `$CLAUDE_CODE_SESSION_ID` 就能读到，不需要猜。
  **新增 `allowReason:"secret-tamper"`**：命中密钥文件的写单独拦，**不**跟 `gate-own-file` 一起放行
  —— 否则改密钥再签一次，等于没签。
  **为什么选签名而不是「加字段降级」**：任务书给的备选（`verified_at` + `reads_sample` 缺了就降级
  untrusted）**不构成防护** —— 那两个字段同样是写标记的人随手能填的，伪造成本没变。签名是唯一能把
  「闸门写的」和「别的进程写的」分开的机制。
  `reasonFor()` 里 `gateCommand` 那段保留（合法的逃生口），文案加强一句：手写的 `"auto"` 标记会被拒。
  `claim` **不签** —— 它本来就是自述，签了反而会被误读成「验出来的」。
- **`status` 子命令**多打两行（`secret` 在不在、marker 签名 valid/INVALID），否则「标记看起来在、
  其实不算数」这件事在盘上不可见。

### 未做（诚实边界，写在这里免得下次再猜）

- **`decide()` 仍是纯函数**：签名密钥由调用方经 `state.secret` 传入，`runHook` 负责读盘。
- **`state.getReads` 在生产 hook 路径下拿到的是「读过哪些不同文件」的完整路径列表**
  （`readTranscriptReads` → `readPathsInTranscriptText` → `readPathsOfToolUse`），不是只有计数 ——
  所以 `target-read` 在真实 hook 里可用。**但 `transcript_path` 指的是主 transcript**，
  子 agent 的读不在其中（`subagents/*.jsonl` 是兄弟目录，闸门不扫）；那类会话走 `claim` 逃生口。
- 只读 transcript 尾部（默认 1 MB），读取发生在窗口之前的会话仍拿不到证据 —— 既有边界，未变。
- `Edit` 侧不再接受「读过几个」作为证据；若某个模型真会「不读就 Edit」，日志里会出现
  `observe-mode`/deny 且 `reads` 很高 —— 那是可观测的，不是静默的。

### 测试

- **测试数 1242 → 1261**（`pre-write-gate.test.mjs` 66 → 85，+19）。四份声明文件已同步。
- 覆盖：`Edit` 目标读过 → `target-read`；`Edit` 读过 5 个**别的**文件 → **仍拦**（关键负向，
  证明不是把 Edit 侧整体放宽）；`Write` 侧逐条不变；伪造 `auto`（无签名 / 假签名 / 改了 `reads`
  不重签 / 换密钥）→ 全部不放行；闸门自己写的 → 放行；密钥被删 → 旧 `auto` 失效；
  `pathKeyOf` 归一化（大小写与分隔符折叠，但**不做**绝对化）。
- **负向验证（真跑过）**：去掉 `!editSide` 守卫 → 「读过 5 个别文件仍拦」变红（fail 1）；
  绕过 `verifyMarkerSig` → 5 条伪造用例同时变红（fail 5）。两处已还原。

---



> 修的是**一个已经确认、会让测量失去意义的缺陷**：`observe-reality-check.mjs` 的重放器
> 自己写了一份「与闸门同构」的路径抽取。同构是**声称**，不是保证 —— 闸门把读动词表改宽
> （例如加 `ls`）之后，重放不会跟着变，于是「改宽后降到 4%」这种数无法用重放复算。
> 更糟的是 `observe-reality-check.test.mjs` 里那条名叫「与闸门一致」的测试只比较重放器
> **内部的两个函数**，是个假守门人。
> **没有修改闸门的判定行为**：66 条 `pre-write-gate.test.mjs` 一条未改、全绿。

### Added

- **`scripts/probe-parser-divergence.mjs`**：先量化再修。两种口径（同文本 / 同文件+同窗口）
  逐会话比对，另加 5 组合成用例覆盖已知差异点。**给数字，不给判断。**
  实测结论：真实语料 155 个会话两种口径**都是 0 分叉**，但**合成用例 3/5 分叉** ——
  所以「真实语料 0 分叉」不等于「等价」，只是这批语料没踩到那三种形状。
- **`scripts/probe-parser-divergence.test.mjs`**（8 条）：守「探针真的比了两侧」，
  含「小语料必须报 0 分叉」——「等价」必须由跑出来支撑，不能靠注释声称。

### Changed

- **`pre-write-gate.mjs`**：抽出并导出纯函数 `readPathsOfToolUse()` /
  `readPathsInTranscriptText()`，`readTranscriptReads()` 改为调用它们。
  另导出只读常量 `GATE_SHELL_READ_VERBS`。**行为逐字节等价**：用 33 组合成输入
  （含空路径 / 纯空白 / 首尾空格 / `null` / `0` / `false` / 重复项 / 大小写 / 反斜杠）
  对提取前后的解析器逐条对账，0 差异。
- **`observe-reality-check.mjs`**：`gateReadsOf()` / `gateReadPathsInText()` 改为委托闸门
  的同一个实现；`GATE_READ_VERBS` 改为从 `GATE_SHELL_READ_VERBS` **派生**（不再是第二份字面量）。
  `readVerbs` 参数只为让测试证明「动词表是判据的唯一来源」，生产调用从不传。
- **修好一处被复制了两遍的窗口 bug**：`tailGateReads()` 与 `measure-gate-ceiling.readWindowText()`
  曾经**无条件丢首行**，而闸门只在「读满窗口」时丢。文件比 1MB 小时会少算一条完整记录。
  两处已同步到闸门的真实条件。
- **测试数 1231 → 1242**（+11：探针 8 条 + 重放器真守门人 3 条）。四份声明文件已同步。

### Changed（测试口径）

- `observe-reality-check.test.mjs` 里那条假测试改成真测试：喂**同一段文本**给闸门的实现与
  重放器，断言路径数组逐条相同；另加一条负向验证 —— 在测试内给动词表注入 `ls`，
  断言重放器跟着变。**已实测**：把重放器改回「自己一份动词表」，这两条**都变红**（fail 2）。
- 已知解析缺陷（`head -n 20 a.mjs` 取到 `20`）**本轮不修**，但钉在测试里：
  重放器必须**带着同一个缺陷**才算同构，将来修它会红。

### 未改变的数字（必须说明，不许假设）

- 重跑 `node scripts/observe-reality-check.mjs` 仍是 **19.9%（27/136）**，
  p50 6 / p90 14.5 / mean 7.5、读 0 个 13（9.6%）、cumulative 26、broad 15、
  归因五类 5/5/8/6/3 —— 全部逐位相同。原因是那三处分叉在本次语料里一次都没触发。
  这不是「所以分叉不要紧」，只是「这批语料没踩到」。

---

## [Unreleased] - 2026-11-14（主线程写的提示词：分层 + 派发前的机器检查）

> 产出：`scripts/compose-agent-prompt.mjs` + `scripts/compose-agent-prompt.test.mjs`（50 条）+
> 报告 `docs/design/2026-11-14-main-thread-authored-prompts.md`（索引已登记）。
> 起因是用户原话「多 agent 的提示词应该由主线程 agent 编写」，以及今晚那条实测矛盾：
> `acceptor` 的 tools 是 `Read, Grep, Glob, Write`，而验收标准写「判定前必须逐条跑
> `check-structure.mjs` / `node --test`」—— 它跑不了任何一条，唯一能给的诚实结论是「不通过」。
> **没有修改** 12 份角色定义，没有碰 git、`tasks/runs/`。新增 50 条测试，硬门全绿。

### Added

- **`scripts/compose-agent-prompt.mjs`**：把「主线程照模板填空」换成四层拼装。
  **L0 身份**（人写的，冻结，提示词里只放指针）/ **L1 协议**（`templates/dispatch.md` 逐字内联，
  具名占位符必须填掉）/ **L2 现写**（任务、验收标准、约束、停机条件）/ **L3 注入**
  （构建/测试命令、硬门输出、`outputs`、nonce、上次失败模式，全部从仓库状态派生）。
- **`checkPromptSpec()`**：九条必填元素的机械检查（`REQUIRED_ELEMENTS`）。
  不过就 **exit 1，且不落文件、不记台账** —— 否则就是「提示词发出去但主线程不知道」。
- **工具相容性判据**（`classifyRequirement` + `requiredTools`）：把每条验收标准分类成
  `command` / `file` / `decision`，再和角色 `tools` 比对。
  验收要跑命令而角色没有 `Bash` ⇒ 拒绝，并给出两条出路（换角色 / 主线程跑完把输出注入）。
  **这是今晚那条矛盾唯一能在派发前算出来的形态。**
- **`prompts.jsonl` + `verify`**：compose 时记成品 hash，收活时从子 agent transcript 的
  **第一条 user 消息**取正文重算。`match: null`（找不到 transcript）与 `match: false`
  （找到了但不是这一份）**分开报**。

### Findings

1. **acceptor 那条矛盾是硬门强制的，不是文档疏忽。** `scripts/check-structure.mjs:37` 的
   `READONLY_ROLES` 与 `:203` 的「只读角色不得拥有 Edit/Bash」会挡住「给它加 `Bash`」这条修法。
   所以正解不是加工具，而是**主线程在派发前把命令跑掉、把输出作为事实注入**——
   验收从「跑命令」变成「读一份已落盘的输出并核对」，`acceptor` 保持只读。
2. **三段式拼装从来没有脚本读过。** `grep -rn "templates/dispatch" scripts/*.mjs` 本轮复核仍零命中
   （`docs/research/2026-11-10-agent-roles-audit.md:295` 记的同一事实）。
   后果里最贵的是 `<nonce>` 没填：`claim-ledger observe` 归属失败**不报错**，只打印「扫了 N 份没有一份能归属」。
3. **「主线程写的提示词」不是「让模型自由发挥」。** 结论相反：主线程该写的范围比现在小得多，
   只写 L2；可派生的（命令、outputs、nonce、失败模式）必须从人手里拿走。
   判据是 `docs/spec/output-format.md:32` 已经立过的那条——手写的数字会随模型心情漂，
   而它「自带格式可信度，用户无法区分真假」。
4. **前提已复核：40/40。** 同一会话 40 份子 agent transcript 的首条 user 消息与父会话
   `Agent` 工具调用的 `prompt` 参数**逐字节相同**（另有 77 条父级 `Agent` 调用带 `prompt` 字段可对上）。
   这是「提示词可对账」的地基；没有它，hash 台账证不了任何事。
5. **本仓自身认不出构建系统。** 没有 `package.json` / `pom.xml` / `build.gradle` / `Cargo.toml` /
   `go.mod` / `pyproject.toml`，`detectProjectCommands()` 返回 `unknown`。
   原型因此注入「未识别出测试命令（不是『没有测试』，是『我没认出来』）」。**已知缺口，未修**：
   它会改变一个已有 43 条测试钉住的模块的行为，属于另一件事。
6. **12 份角色定义里 4 份「职责与工具互斥」**（`acceptor` / `redteam` / `research` / `relay`）。
   本轮只做**派发前拦截**，**没有改定义**——改法是决定（加 `Bash` 还是改掉那句职责），不是一次编辑。

### Changed

- 回归测试 1145 → **1195**（+50）。四份声明文件（README / CLAUDE.md / GUIDE / CI）已同步，
  `checkTestCount()` 硬门核对通过。
- `scripts/check-structure.mjs`：PROBE_ARGS 新增 13 条（compose 的纯函数），
  REGISTERED 新增 `COMPOSE_PROMPT_FNS`（26 条）。



> 产出：`scripts/observe-reality-check.mjs` + `scripts/observe-reality-check.test.mjs`（26 条）+
> 报告 `docs/research/2026-11-14-observe-mode-reality-check.md`（索引已登记）。
> 装置是**历史语料重放**：432 份主 transcript / 2.0 GB / 约 90 秒全量。
> 没有动仓库 `.claude/settings.json`，没有碰 git、`tasks/runs/`。新增 26 条测试，硬门全绿。

### Added

- **`scripts/observe-reality-check.mjs`**：在真实语料上重放 `pre-write-gate.mjs` 的判定。
  三个口径同时给：**gate**（闸门真实实现，1 MB 尾窗）、**cumulative**（同判据不看窗口）、
  **broad**（+`ls`/`find`/`grep`/`Glob`/`git log`）。判定走**真 `decide()`**，不重写一份。
- **五类互斥归因**（`attribute()`）：`A-continuation` / `B-subagent` /
  `B2-subagent-unattributed` / `C-broad-explore` / `D-no-evidence`。判据全部可复核。

### Findings

1. **真实模型行为仍然没有证据，且这一轮确认它做不了。** `claude -p` 不是「静默失败」，
   是**认证闸**：`ANTHROPIC_BASE_URL` 指向宿主网关，`ANTHROPIC_AUTH_TOKEN` 只注入给宿主管理的进程。
   实测 `Not logged in · Please run /login`（exit 0）与剥掉宿主变量后的 `401 认证失败`（exit 0），
   网关 `/v1/models` 无授权头 `http=401`。**`observe` 模式本身也测不到** —— 它不拦，模型就没有障碍可反应。
2. **阈值 3 在真实项目上会拦 19.9%（27/136 个有写会话）。** 首次写前 gate 口径可见的不同文件数
   **p50=6 / p90=14.5 / mean=7.5**，真「读 0 个就写」只有 **9.6%（13/136）**。
   阈值扫描：0→0%、1→9.6%、2→16.2%、3→19.9%、5→38.2%、8→58.8%。
3. **27 次「会拦」里 88.9%（24/27）拦的时候项目其实被读过。** A 续接 5（读在上一段会话）、
   B 子 agent 5（严格 `toolUseId` 配对）、B2 旧格式配不上 8、C 结构性探索 6。
   落进 `D-no-evidence` 的只有 3 次，其中 2 次是「只读了目标文件本身」（`Read pom.xml` → `Edit pom.xml`）的真误伤。
   **没有任何一个是「一句话改拼写」那种简单任务** —— 题目预设的「读 0 个＝简单任务」在语料上不成立。
4. **阴性对照：66 个测试沙箱会话被拦 49 次，归因 100% 是 `D-no-evidence`。** 闸门对它们完全正确。
   没有这一桶，前面的比例无法区分「闸门太严」和「语料本来如此」。
5. **语料卫生两处必查，不查会得到 38.1% 这种错数（第一版就是）：**
   ① 本仓自己的实验沙箱（`Temp\*`、`.tmp-analysis/*`）混在里面，必须分桶；
   ② **224/224 个有写会话都存在时间戳倒退**（148 个 >60s、116 个 >1h，最大 293h），
   成因是 `queue-operation` 等元数据写当前时间而对话记录是 resume 回放的旧历史。
   故子 agent 的先后判定改用**主 transcript 字节偏移**，不用时间戳。
   `--order file` 与 `--order time` 实测给出**同一组被拦会话**（差集 0），两种口径在本语料上等价。
6. **顺带发现闸门自身一个解析缺陷（未修，不在本任务范围）：** `head -n 20 a.mjs` 会把 `20`
   当成读过的文件（`tail -c 512` 同理），因为 `-n` 被跳过而其值没有。方向是**多算 → 更宽松 → 更少拦截**，
   影响 1/136 个会话（19.9% → 20.6%）。测试把现状钉住了，将来修它会红。

### Changed

- 回归测试 1119 → **1145**（+26）。四份声明文件（README / CLAUDE.md / GUIDE / CI）已同步，
  `checkTestCount()` 硬门核对通过。



> 产出：报告 `docs/research/2026-11-14-prompt-based-multiagent-limits.md`（索引已登记）。
> **零行代码改动**——纯 exploration，读外部只读目录 `many-agents_multi-prompt-files_token-heavy/`
> 后写的根因分析。没有修改那个目录的任何文件，没有碰 git、`tasks/runs/`。
> 未新增脚本，因此测试数不变。

### Added

- **`docs/research/2026-11-14-prompt-based-multiagent-limits.md`**：回答「提示词式多 agent
  为什么不够原生」。核心结论是**谁持有计划**（`Claude, turn by turn` vs `The script`），
  并给出 11 个维度的逐条对比（提示词方案 / 原生方案 / 差距后果 / 是否必须原生）、
  9 条来自外部框架实跑记录的失败案例、以及「用现有 Claude Code 原语能补多少」的覆盖表。
- **提示词够用的 7 类**（不该重做的清单）：审什么 / 什么算证据 / 什么结论不成立 /
  报告形状 / 角色可见性 / 停机条件 / 裁量留痕。判据一句话：
  **运行时能判定真假的交给原生，需要读懂内容才能决定的留在提示词。**

### Findings

1. **那个框架自己已经算出了这个结论**：6,113 行里 **2,809 行（47%）**在做并发/状态/重试/契约，
   原话是「**这不是简化版，是更差的版本**」（`harness-first-pivot.md:111`、`:126`）。
   47% 就是「不够原生」的可量化定义。
2. **最贵的一条不是功能缺失，是状态只能靠代理指标。** 三条代理指标各错过一次：
   8 分钟阈值（真实常态 47 分钟，12 个里 9 个会被误杀）、转录大小（35 分钟误判）、
   `in_flight` 数组（自己忘了更新就一直错）。而唯一的 A 级活性证据 `TaskStop` **是破坏性的**。
3. **契约退化成散文是可量化的**：15 个真实产物 **0 个**含 JSON 信封；40 份产物只有 **9 份**
   可被 grep 解析；契约里写「一律视为违规」的 19 条判据，校验器实测有 **3 条从未执行**。
4. **递归在机制上是 0**：7 个 wrapper 的 `tools` 全部不含 `Agent`，子 Agent 结构上无法再派；
   而 `triage.md:124` 写着 9×5×5×5=1125 并称「这不是上限，是目标」。**提示词在许诺运行时不提供的能力。**
5. **多 agent 的增益是并集不是视角**：4 个同提示词 agent 并集只比最好的单个多 1 条，
   Jaccard 相对随机仅 1.25×（`AGENT-CONSISTENCY.md:152-170`）。所以「多派几个」不需要原生，
   **「调度多派」才需要**。
6. **覆盖评估：11 个维度里 7 个能被现有原语覆盖，加权后约 6.5/11。**
   硬缺口 4 条：跨会话持久状态（`Workflow` resume「Same session only」）、运行中注入
   （`No mid-run user input`）、子→父投递语义（返回值是「已启动」不是「已完成」）、
   深度与预算的强制（宿主到限只拒绝，不按你的意图降级）。

### 诚实边界

- **所有外部数字均未重跑**。本文核对的是「原文确实在哪个文件哪一行这么写」，不是「原文真对」。
  标 `[未复核]` 的条目需主线程或验收 Agent 复算。
- **未在 `Workflow` 上做任何实测**，覆盖表是按能力映射推的。三个可证伪的下一步实验写在报告 §5.4。

---

## [Unreleased] - 2026-11-14（中断的**代价**：按返工需求率重算，并发现「中断=返工」不成立）

> 产出：`scripts/measure-intervention-cost.mjs` + `scripts/measure-intervention-cost.test.mjs`（43 条）+
> 报告 `docs/research/2026-11-14-intervention-cost.md`（索引已登记）。
> **没有改任何既有脚本的逻辑**——分组 / 执行起点 / 人类发言判据全部从
> `measure-execution-phase.mjs` import，官方的 `run()` 直接调用，只追加代价指标。
> 没有碰 git、`tasks/runs/`。新增 43 条测试，硬门全绿。

### Added

- **`scripts/measure-intervention-cost.mjs`**：执行期中断的代价测量器。
  主指标 **返工需求率** = 执行期含否定/撤销/重做语义的人类发言 ÷ 执行期中断。
  判据复用 `classifyHumanMessage()` 的 `correction` 档，不另写正则。
- **第二层去重：恢复分支快照**（`dedupeResumeForks`）。第一层「整份内容哈希 + 记录条数」
  抓不到一类簇：同一段对话写成多个 sessionId，**前缀逐条相同（连时间戳都相同）、长度不同**，
  短的那份是恢复出来的早期快照。判据 = 同 `firstTs` 同首条人类消息 + 归一化记录序列
  公共前缀 ≥ 较短者的 98% 且 ≥ 30 条。实测合并 66 份 / 25 簇。

### Findings

1. **第二层去重把 A 组从 14 改成 7，改变了上一轮报告的可引用性。**
   三份 `2b8b5fc6` / `69a23385` / `b7deae45` 全被判进 A 组，前缀 99.9% / 99.6% 相同，
   是同一段对话的副本；而那份对话恰好是 A 组 undo 最多的一个。
   **上一轮 A=14 的具体数字不能再直接引用**，方向性结论（体量解释一切）不受影响。
2. **控制体量后「开工前提问」的代价不更低。** 返工需求率 A 1.20%（n=7）/
   B 0.99%（n=34），置换检验 p=0.69，Cliff's delta +0.109。
   分层（286–1024 层 A 2.44% vs B 1.55%；>1024 层 0.88% vs 0.61%）与 1:1 体量匹配
   （0 胜 2 负 3 平）方向一致。**但只有 15 个返工事件（0.87%），证伪不了，只能说无数据支持。**
3. **「中断 = 返工」这个前提本身不成立**（本次最硬的观察）：1727 次执行期中断里
   只有 **15 次（0.87%）是纠正**，最大的一块是新增需求 / 补充前提（1379 次）。
   用户举的「你完全理解错了，重做」在真实语料里是万分之一量级的事件。
   这解释了为什么「按次数」和「按代价」都测不出提问的优势。
4. **文件重叠度这个候选被实测否决**：中断后 10 个写操作落在中断前已写过文件上的比例
   32.4%，同长度随机窗口 42.0%——**中断点更低**。它测的是工作连续性，不是返工。
   否定结论已固化进脚本（`redoShareAfterInterruptions` + `redoShareRandomWindows`），可复算。
5. **自撤销事件只能当辅助**：中断后 2.69% vs 中断前 2.23%（仅高 20%），
   且与任务体量相关 0.75——大任务自然改得多。
6. **主指标与体量的相关只有 0.31**（中断数与体量是 0.90）。返工需求不是体量的另一种说法，
   这是它比「中断次数」更适合做对比口径的直接理由。

### 一句话

```
主指标不是次数，是代价；代价的实测结果：A 不低于 B，但样本只有 15 个事件。
真正的发现在于 —— 中断绝大多数根本不是返工，所以这个问题的前提需要重写。
```

---

## [Unreleased] - 2026-11-14（写前闸原型：`PreToolUse` 上「第一次写之前先读项目」跑通闭环）

> 产出：`scripts/pre-write-gate.mjs` + `scripts/pre-write-gate.test.mjs`（66 条）+
> `templates/pre-write-gate.settings.json`。报告 `docs/research/2026-11-14-pre-write-gate-prototype.md`
> （`docs/research/README.md` 已登记）。试跑装置与原始日志在 `.tmp-analysis/pretooluse-proto/`（gitignored，**不发布**）。
> **没有动 `.claude/settings.json`**（仓库级），没有碰 git。本文件新增 66 条测试，硬门全绿。

### Added

- **`scripts/pre-write-gate.mjs`** —— 首次写文件之前要求「已读过项目」的 PreToolUse 闸门。
  `decide()` 是**纯函数**（判据全在参数里），`runHook()` 收全部副作用，所以判定逻辑可被单测穷举。
  三档 `OW_PRE_WRITE_GATE=observe|warn|deny`，**默认 observe**（只记账，stdout 不输出 = 放行）。
- **`scripts/pre-write-gate.test.mjs`**（66 条）—— 含端到端 spawn 与四条负向回退。
- **`templates/pre-write-gate.settings.json`** —— 可直接合并进 `.claude/settings.json`，matcher 覆盖
  `Write|Edit|NotebookEdit|Bash|PowerShell`，带 `"shell": "powershell"`。
- `scripts/check-structure.mjs`：登记本模块的 17 个导出探针参数（纯函数实调一次）与 7 个常量，
  否则结构门会把它们列成「未登记」。

### 设计选择（两条，都写在文件头与报告里）

1. **标记文件默认由 hook 创建，不由 AI 举手。** hook 从 transcript 尾部数本会话 `Read` 过的
   **不同文件路径**，够了就自己写 `.claude/.ow-read-done` 并放行（`satisfied_by:"auto"`）。
   AI 被拒后跑 `mark` 子命令是逃生口（`satisfied_by:"claim"`，自述，事后可审计）。
   理由：(a) 只看 AI 听话会把闸门退化成提示；(b) 是「本来就会先读项目的 agent 感觉不到闸门」。
2. **标记绑定 session，没有 `session_id` 的标记判无效。** 早期写法是「没写 session 就当通配」，
   那会在盘上留一个永久有效的标记：本会话建过一次，之后每个新会话都被静默放行，而日志里一切正常。

### 实测（真 `claude.exe 2.1.308` + stub 模型，与 `2026-11-14-pretooluse-desktop-verification.md` 同装置）

- **t1** 不做准备就写 → deny + `continue:false`，`num_turns=2`，文件**不落盘**，`permission_denials` 有完整记录。
- **t4** 用 `PowerShell` 的 `Set-Content` 绕 → **同样被拦**。堵上验证报告 §3 G6 那个洞。
- **t2** 先读三个文件再写 → **一次都没被拦**，闸门从 transcript 数出 3 个路径，自己写标记（`satisfied_by:"auto"`）。
- **t3** 被拒 → 模型跑 reason 里那条命令 → 重试 → 落盘（`satisfied_by:"claim"`）。完整闭环。
- **t5** 连续发 5 次同一个写 → 前 3 次全拒、第 4 次刹车结束回合。**重试绕不过去**（对照 E1 计数器第 2 次就过）。
- **阴性对照**：`OW_PRE_WRITE_GATE=observe` 下同一个 t1，`out.txt` **落盘了**、`denials: []`、记账 `would-deny`。

### Findings（三条）

1. **`claude -p` 在本机仍然不可用**，两次复现：剥掉宿主变量 + 指向本地网关 → 120 秒零输出、`exit=0`、
   stdout 完全为空；网关 `/v1/messages` 25 秒无响应（`http=000`），但 `/v1/models` 正常。
   与 `docs/FACTS.md:516` 一致。**所以模型行为类推论一律标「未实测」。**
2. **本机宿主没有 `Bash` 工具**：stub 发 `Bash` 收到 `Error: No such tool available: Bash`，只有 `PowerShell`。
   不推翻已有 Bash 语料结论（那是别的会话），但它意味着本机的闸必须以 `PowerShell` 为主路径。
3. **一个真实 bug 由实测暴露**：`Number('')` 是 `0`，所以只设 `OW_PRE_WRITE_GATE=deny` 时 `minReads`
   被读成 0，**(b) 自动放行那条主路被静默关掉**，闸门退化成纯荣誉制 —— 而日志里看起来一切正常。
   跑 t2 时发现（模型读了 3 个文件却仍被拒）。已修，并有一条负向测试守着（放回 bug → 1 条变红）。

---

## [Unreleased] - 2026-11-14（PreToolUse 契约：`exit 2` 与 Stop hook 一样不拦，拒绝循环没有宿主兜底）

> 产出：报告 `docs/research/2026-11-14-pretooluse-desktop-verification.md`（`docs/research/README.md` 已登记）。
> 实验脚本与原始日志在 `.tmp-analysis/pretooluse-lab/`（gitignored，**不发布**）。
> **零生产代码改动**：没有新增 `scripts/` 模块，没有动 `.claude/settings.json`（仓库级），没有碰 git。
> 测试数不变（1010），硬门全绿。

### Added（只在报告里，不在代码里）

- **`PreToolUse` 的完整输入契约**：`session_id` / `transcript_path` / `cwd` / `prompt_id` /
  `permission_mode` / `effort` / `hook_event_name` / `tool_name` / `tool_input` / `tool_use_id`。
  `tool_input` 是**完整参数**（`Write` 拿得到全文 `content`，`Edit` 拿得到 `old_string`/`new_string`/`replace_all`）。
  **没有「第几次调用」这类字段**；`prompt_id` 是可用的「本回合」锚点。

### Findings（其中两条会改变已有文档的可信度）

1. **`exit 2` 在 `PreToolUse` 上同样不拦截** —— 与 `2026-11-12-stop-hook-prototype.md` §2.2 在 Stop 上的实测一致。
   本仓 `2026-11-13` 那组 B4 看着「exit 2 拦住了」，**是假象**：那次被「Git Bash 未找到」的 fallback 污染，
   宿主把 hook 进程失败转成 `ask`，headless 下 `ask` 即拒绝。决定性对照：`exit 1` 得到**逐字相同**的 fallback 文案
   并同样拦住；给 hook 显式加 `"shell": "powershell"` 后，同一个 `exit 2` 触发 1 次、**文件照常落盘**。
   同装置下 `deny` 仍拦住 —— 这一对才是干净的。
2. **`PreToolUse` 的拒绝循环没有宿主上限** —— 实测连续拒绝 **69 次仍在继续**（等 180 秒后我主动 SIGTERM 才停）。
   对比 Stop hook 有 9 次上限。**任何闸门必须自带刹车**：拒绝时同时返回顶层 `continue:false`（实测一轮即停）。
   代价写清：`continue:false` 会终止整个回合，与「让模型被拒后先去读文件」互斥。

### 实测（20 组，宿主 `2.1.308`，transcript 均记 `entrypoint=claude-desktop-3p`；原有 7 组 + 本次补做 13 组）

- `deny` → 文件不落盘、reason 原文回模型、`permission_denials` 有记录。
- `ask` → 非交互 `-p` 下退化成拒绝（**桌面交互态弹不弹卡片，未实测**）。
- `updatedInput` → **真的改写**：路径 `gated.txt`→`gated-REWRITTEN.txt`、`content` 整段替换，
  盘上出现改写后的文件，模型收到的是新路径。**改写对模型透明，对用户界面也透明**——
  这正是 `2026-11-11-untapped-capabilities.md` §563 警告的用法，现有一条实测。
- `additionalContext` → 以 `PreToolUse:Write hook additional context: …` 的系统块注入，**只注入一次、不引发循环**
  （与 Stop hook 上它会无限循环形成对比）。
- **旁路**：只 matcher `Write|Edit` 的闸门，被 `PowerShell` 的 `Set-Content` 直接绕过（实测落盘）。
  与已有「首次改动走 Bash 占 31.3%」互相印证。

### 仍需说明的边界

模型端是 stub（hooks / 权限 / 工具循环 / transcript 全是真的）。所以「模型被拒后会不会照 reason 去先读项目/提问」
**没有真实模型证据**，报告里标了「未实测」。**`PreToolUse` 能做的是「写前强制某个前置动作」，
做不到「写前强制提问」**——`ask` 只能问「允许这次工具调用吗」。

---

## [Unreleased] - 2026-11-14（执行期中断：按用户口径重算，并把「提问算成本」那条推导拆开）

> 产出：`scripts/measure-execution-phase.mjs`（新增，纯函数导出 + CLI + `--json`）、
> `scripts/measure-execution-phase.test.mjs`（37 条）、
> 报告 `docs/research/2026-11-14-execution-phase-measurement.md`。
> `scripts/check-structure.mjs` 登记 22 个纯函数（PROBE_ARGS + REGISTERED）与 8 个有副作用的导出。
> 测试数 973 → 1010（硬门与 `node --test` 两处对账）。
>
> **为什么不改 `measure-interventions.mjs`**：那个脚本的口径是「人工介入总数」，把
> `AskUserQuestion` 的作答算作一类介入（Q）。按用户 2026-11-14 的模型，提问是开工前的投资、
> 不是执行期的成本。**两套口径必须同时存在、能互相换算**，所以新开一个器，旧数字原样保留。

### Added

- **`measure-execution-phase.mjs`**：测「执行起点之后的人类发言数」。
  三个边界可复算：执行起点 = 第一次 `Write`/`Edit`/`NotebookEdit`，或第一次被
  `verify-claims.mjs` 的 `isMutatingCommand` 判为改写工作区文件的 Bash 命令；
  执行期 = 墙钟；执行期中断 = 其中除会话首条外的人类发言（`AskUserQuestion` 的作答与
  `[Request interrupted by user]` 标记单独计数，不进主指标）。
  分组 A（第一次提问在执行起点前）/ B（之后）/ C（从不提问）/ none（无写操作）。
  输出 mean/median/p90、零中断率、执行期时长、纠正/催促构成、体量分层、最小工具数门槛、
  体量 1:1 匹配对照、偏 Spearman 相关、两条敏感性检验（边界挪到首次工具调用 / 严格口径）。
  置换检验 5000 次固定种子，同一输入必得同一 p 值。
- **`matchedPairs()`**：按执行期工具数做 1:1 匹配（容差 log 比 ≤ 0.7），返回胜负计数与逐对明细。
  存在的理由：A/B 的体量分布严重不重叠（p50 154 vs 1060），四分位分层粒度不够。

### Changed

- `README.md` / `CLAUDE.md` / `docs/GUIDE.md` / `.github/workflows/validate.yml`：
  回归测试数 973 → 1010（新增 37 条）。硬门 `checkTestCount()` 对账。
- `docs/research/README.md`：登记本轮报告。
- `docs/design/README.md`：登记另一个 Agent 新增的 `2026-11-14-agent-roster-policy.md`
  （硬门 `checkDesignIndex()` 要求的配套索引行，不是对那份文档内容的裁决）。

### Findings（写进报告，这里只列会被后续工作依赖的三条）

1. **A 组的执行期中断原始值确实低于 B（mean 14.4 vs 30.5，p = 0.011），但 A 的活小 6.6 倍**
   （执行期工具 p50 154 vs 1060，时长 p50 19 h vs 171 h）。控制体量后效应消失甚至反向：
   每 100 次工具 A 3.29 / B 1.94（A 更差）、1:1 匹配 3 胜 3 负、门槛 ≥400 时 A 反超 38.5 vs 31.4。
   **「提前问减少执行期中断」在本机语料上没有数据支持。**
2. **28 个执行期零中断的会话全部在 C 组，执行期工具全部 ≤ 11。**
   门槛 ≥ 20 工具的 136 个会话里零中断 0 个——「一口气做完」目前是小任务的产物。
3. **同语料两套口径的差额**：旧口径 2530（非首条人类发言 2346 + 作答 184）、
   新口径 2253（只数执行期人类发言），差 277（−10.9%）。
   `2026-11-13-critique-question-layer-product.md` §4.4 的「828 → 859」把开工前提问的作答
   算进了分子（本语料 15 次），新口径下这部分对执行期成本贡献为 0。
   **但必须同时记住**：184 次作答里 169 次（91.8%）落在执行期，且被新口径排除在主指标之外。

### 顺带修掉的一个测量污染

语料里有 **19 簇 / 51 份 fork 重放**（内容逐条相同、sessionId 不同、时间戳被整体平移几分钟）。
最刺眼的一簇 3 份全被判进 A 组，而 A 组总共只有 14 个。按 sessionId 去重抓不到；
按「执行起点之前的内容哈希」会过度合并（同项目同初始化流程会撞前缀）；
最后用「整份文件归一化内容哈希 + 记录条数」，归一化连时间戳都丢掉。去重 80 份。

---

## [Unreleased] - 2026-11-13（Bash 写入识别：从「一律不认」到「可判定才认」，并给误判设了几道硬闸）

> 产出：`scripts/claim-ledger.mjs`（新增 `bashWrites` / `bashWriteScan` / `observedWriteScan` 三个导出，
> `observe` 接上 Bash 通道并报告「判不出」的计数）、`scripts/claim-ledger.test.mjs`（+13 用例，含 3 条真实回退）、
> `scripts/check-structure.mjs`（三个新导出登记进 PROBE_ARGS）、
> 报告 `docs/research/2026-11-13-bash-write-detection.md`。
> 测试数 960 → 973（硬门与 `node --test` 两处都是 973）。
>
> **修的是上一轮自己写下的「刻意不做」**：`observe` 只认 `Write`/`Edit`，Bash 写出的文件看不见。
> 那条理由（「猜路径必然误判」）**仍然正确**——所以这一轮不是把「猜」做得更聪明，
> 而是划出「**哪些命令的写入路径根本不需要猜**」，只对那一小类开口。

### Added

- **`bashWrites(cmd, cwd) -> string[]`**（纯函数）。只识别路径**可确定解析**的形态：
  输出重定向 `>` `>>` `2>` `&>`、`cat > p <<'EOF' … EOF`、`tee p`、`cp src dst`、`mv src dst`；
  命令里的字面量 `cd` 参与基准目录换算（`cd sub && echo x > y.txt` → `<cwd>/sub/y.txt`）。
  判不出就返回空数组，**不返回猜测**。
- **`bashWriteScan(cmd, cwd)`**：同一套解析，额外给出「判不出」的逐类计数
  （动态路径 / 临时位置 / 目录 / 原地改写 / 目标是已有目录）。**没看的部分必须可数**，
  否则「没有产出」和「没看」长得一模一样——那正是 `claim-ledger` 开头点名的病。
- **`observe` 接上 Bash 通道**，台账行新增 `source: 'write-tool' | 'bash'`（原来固定是 `transcript-write`，
  现在用 `via: 'transcript'` 表示证据来源、用 `source` 区分通道）。`--no-bash` 可整条关掉。
- **`observe` 报告里打印跳过计数**：`判不出、已跳过：动态路径 N 条 · 临时位置 N 条 · 目录(非文件) N 条 · 原地改写 N 条 · 目标是已有目录 N 条`。

### 实测（不是推断）

- **本机抽样 526 份子 agent transcript、36,673 次 Bash 调用**（按 `files[::step]` 等距抽取，可复算）：
  解析出 1,149 条写入路径，**其中 1,149 条的 basename 原样出现在命令字符串里（100% 字面量证据）**；
  0 条的 basename 是凭空生成的。落到磁盘核对：254 条文件此刻存在，**0 条解析结果指向目录**
  （`cp src dst` 里 `dst` 是目录时会另计为「目标是已有目录」并跳过）。
- **跳过量**（同一批样本）：动态路径 8,653、临时位置 7,626、目录 646、原地改写 123。
  这解释了为什么「只用 Write 才算产出」会漏——也解释了为什么不能把「用过 Bash」当成「用 Bash 写任务产出」：
  真正落到可判定路径上的只有 1,149 / 36,673 ≈ **3.1%**。
- **回退即红（3 条真实负向验证）**：把 `bashWrites` 改成恒返回 `[]` → 6 条测试变红；
  删掉「路径含 `$` `*` `?` 等即判动态」那一行 → 3 条变红；把 `cd` 失败时仍保留前半截结果 → 1 条变红。
  三次都还原后 62/62 绿。

### 刻意不做

- **不认 `find -exec` / `xargs` / `sh -c "…"` / `eval` / 子 shell。** 路径在动态命令里，
  看得见的是外层字符串，看不见的是它真正写了什么。**一律计数，不给结果。**
- **不认 `mkdir`。** 目录不是文件：`probeDisk` 拒收目录，把目录写进期望会永远判 `ABSENT`。
  计数但不产出路径。
- **不认 `sed -i` / `perl -i`。** 原地改写会顺带生成备份文件（`f.bak`、`f~`），
  名字取决于工具与参数，**判不准**。计数。
- **不认 `/tmp`、`/dev/null`、`%TEMP%`。** 判得出，但实测这批样本里它们的主流形态是探针
  （`cat > /tmp/FmtCheck.java`、`cp x /tmp/en.bak`），不是交付物。计数但不当产出。
- **不改「期望」的定义。** Bash 命中的路径仍然只作为 transcript 痕迹（可能进 `extras`），
  判定仍以 `declare` 的期望为准——否则一个误判就能让 `verify` 判出 `COMPLETE`。

### 已知边界（不假装覆盖）

- **`cp a dst` 里 `dst` 是目录时，真正的产出是 `dst/<basename>`。** 纯函数不许读盘，
  所以解析层给的是 `dst`；`observe` 收账时用 `statSync` 判它是目录并跳过（计数）。
  `declare` 显式声明那条路径仍然有效——那是唯一不会被动的兜底。
- **未声明 cwd 的相对路径一律放弃。** transcript 每条记录带 `cwd`，所以 `observe` 走的是它有；
  外部调用方没给 cwd 时只有绝对路径会被认出来。这是保守方向，不是漏洞。

---

## [Unreleased] - 2026-11-13（产出对账 · 接进派发链路：从「工具存在」到「有人在调」）

> 产出：`scripts/validate-run.mjs`（`outputs` 必填 + `checkOutputs` / `outputPathError` /
> `outputPathKey` 三个导出）、`scripts/validate-run.test.mjs`（+12 用例，含 1 条真实回退）、
> `scripts/reconciliation-wiring.test.mjs`（新文件，18 用例）、
> `scripts/claim-ledger.test.mjs`（+3 端到端 CLI 用例）、
> `templates/dispatch.md`、`.claude/agents/oversight-executor.md`、`.claude/agents/oversight-repair.md`、
> `.claude/skills/oversight/SKILL.md`（新增 §4.5 Phase D）、`scripts/check-structure.mjs`（导出/探针登记）、
> 报告 `docs/research/2026-11-13-output-reconciliation-integration.md`。
> 测试数 927 → 960（实跑核对，源码 `^\s*test(` 与 `node --test` 两处都是 960）。
>
> **上一轮留下的缺口**（同一天的条目，见下）：`claim-ledger.mjs` 能跑、46 条测试全绿，
> 但 `SKILL.md` 不调它，它就完全不存在——设计 §7 自己写明了「派发链路一行未动」。
> 本轮把那四项全部落地。这不是「新功能」，是**把已有的判定接上调用方**。

### Added

- **`task-graph.json` 的每个子树必须写 `outputs: string[]`**（`scripts/validate-run.mjs`）。
  它是收活时对账的唯一期望来源：`claim-ledger declare --paths` 直接吃它。
  **必填，不是选填**——选填则 planner 少写一行，`verify` 只能判 `NO-EXPECTATION`，
  而那时已经是收活时，没有期望就无从补。与硬约束 4 同构：期望必须早于结果存在。
  代价为零：仓库唯一的历史图本来就不合法（缺三个字段，早已 exit 1）。
  `shape: artifact` 时不得为空数组（否则必填被 `[]` 绕过）；`exploration` / `hybrid` 可以空。
  校验：绝对路径（含 `C:x` 驱动器相对形态）、UNC、`..`、空串、尾部分隔符一律 exit 1。
- **派发模板加「产出登记（必须做）」与四元组第四节**（`templates/dispatch.md`）。
  关键是那句 **「不执行也不会漏」——主线程会读你的 transcript**：没有它，`claim` 就会从
  加分项退化成准入项，等于又造了一条自述通道，而自述正是这次要治的病。
- **`executor` / `repair` 的输出改为四元组**，新增「我产出的文件」节，明写
  「不是给你自我评价用的，是给主线程对账用的。**写错路径比不写更糟**」。
  两个角色的 `tools` 本来就有 `Bash`（实测 `tools: Read, Write, Edit, Bash, Glob, Grep`），
  所以 `claim` 命令跑得起来——这一条被测试固定住，防止将来白名单收窄时悄悄失效。
- **`SKILL.md` 新增 §4.5 Phase D：收活前对账**，位于 Phase C 与 Phase E 之间。
  `PARTIAL` / `MISSING` / `CONFLICT`（以及 `EMPTY` / `UNREPORTED` / `NO-EXPECTATION`）不进入验收，
  并逐结论写明处置（续做 / 重派 / 退回 / 人工裁决 / 认领 / 补 outputs）。
  理由写在入口文档里：**验收一个不完整或身份不明的交付物，等于给虚假的通过盖章**。

### 实测（不是推断）

- **nonce 假设成立，逐字节。** 本机 127 份有父会话的子 agent transcript，其第一条非 meta
  user 消息与父会话里 `Agent` 工具调用的 `prompt` 字段**完全相同**（`text.length === prompt.length`，
  无一份是「前缀相同 + 尾巴」）。prompt 长度最大 11,880 字符，全部落在
  `SUBAGENT_HEAD_BYTES`（64 KiB）窗口内。
- **整条链真跑通**：`tasks/runs/2026-11-13-output-reconciliation/` 下 5 个子树、`outputs` 齐全，
  `validate-run.mjs` exit 0；`declare → claim → verify`（未认领时 exit 1）`→ consume → verify` exit 0。
- **回退即红**：把 `const ores = checkOutputs(st)` 换成空结果 → `validate-run.test.mjs` 7 条变红；
  把 SKILL.md 里那行 `verify || exit 1` 注释掉 → wiring 测试 1 条变红；还原后 42/42 绿。

### 刻意不做

- **不读子 agent 返回文本里的「我产出的文件」去对账。** 它是给人看的摘要，不是证据来源。
  证据只有三个：自述行（`claim`）、磁盘、transcript 痕迹。把返回文本也当成一方，
  等于让「写了一段话」重新变成判据——那正是这次要拆掉的东西。
- **`observe` 仍未自动调用**（设计 §6 已列为下一版）。`declare` 没记 `--session`，
  `verify` 不知道该扫哪个会话目录；自动化的前提是接口变更，本轮不做。

---

## [Unreleased] - 2026-11-13（产出对账：子 agent 干完了活，主线程凭什么知道）

> 产出：`scripts/claim-ledger.mjs`（新脚本，31 个导出 / 6 个子命令）、
> `scripts/claim-ledger.test.mjs`（+46 用例）、`scripts/check-structure.mjs`（导出登记 + 探针参数）、
> 设计 `docs/design/2026-11-13-output-reconciliation.md`、`docs/CAPABILITIES.md` + `README.md` 各一行。
> 测试数 881 → 927（实跑核对）。
>
> **要解决的问题**（用户原话）：「我们的 agent 架构一定要避免 agent 已经产出了然而主线程却没有意识到。」
> 诊断出来的现状：`docs/spec/dispatch-contract.md` §6 规定子 agent 用三元组文本交回结果，
> 而**从派发到收活之间，没有任何一处核对过「它声称的东西在不在」**。
> `validate-run.mjs` 只校验派发图、`verify-claims.mjs` 只校验会话级断言、
> `checkDocReferences()` 只校验文档指向——三者都不碰「任务产出」。
> 12 份角色里，写报告的角色（critic / redteam / review）路径写死，干活角色（executor / repair）
> 的交付物路径是自由文本，用户担心的那种失败正好发生在这里。

### Added

- **`scripts/claim-ledger.mjs`：四方对账。** 四个独立来源交叉：派发时登记的**期望**
  （该产出哪些文件）、子 agent 的**自述**（可选，含 sha256）、现场的**磁盘** `stat`/hash、
  以及从子 agent transcript 抽出的**写入痕迹**。逐项判 `OK` / `OK_WEAK` / `UNREPORTED` /
  `ABSENT` / `DRIFTED` / `MISSING`，任务级判 `COMPLETE` / `PARTIAL` / `EMPTY` /
  `UNREPORTED` / `DRIFTED` / `MISSING` / `CONFLICT` / `NO-EXPECTATION`。
- **`observe` 不需要子 agent 配合。** 读 `subagents/agent-*.jsonl` 的 `tool_use` 与成对
  `tool_result`，用派发时写进 prompt 的 8 位 nonce 做归属（按 nonce 而不是角色名：
  同一次 run 会有两个 `executor`）。子 agent 一个字都不报告，痕迹照样在。
- **`CONFLICT` 排在任何结论之前。** 两个 agent 写同一个文件时「都成功」是最坏形态，
  比任何一个失败都糟。路径先按 `pathKey` 归一化再比——子 agent 给绝对路径、派发方给
  仓库相对路径，不归一化会把同一个文件判成「期望没落地 + 额外产出」，两边都错。
- **`PARTIAL` 与 `EMPTY` 严格分开。** 干到一半要续做，没开工要查派发是否失败，
  混成一个「失败」两种处置都会做错。
- **`consumed` 是第二个维度。** 产出完整但主线程还没接手，`summary.ok` 仍是 false。
  `adopt` 专用于崩溃重启后列出「有产出、未认领」的任务。
- **空结果三规则**：台账为空 → 退出码 1 并印「这不是全部完成，是从没登记过期望」；
  `observe` 找不到 transcript → 退出码 1 并印「这不是没有产出，是看不到」；
  扫到 transcript 但一份都归属不上 → **不写任何行**（记到某个任务名下会让结果变假）。

### 刻意不做

- **不判「Bash 写出的文件」。** 从命令行猜目标路径必然误判（`2>&1`、`tee -a`、`sed -i` 的备份文件），
  而误判的代价是让人不再相信这个工具。兜底：Bash 产物照样可以 `declare`，那时走磁盘比对。
- **不判产出对不对。** 只看在不在、变没变；内容完全错误但 hash 对得上仍是 `OK`。那是 `acceptor` 的活。
- **静默不是失败判据。** `silentMin` / `quiet` 只用来说「要不要催」；`COMPLETE` 且静默 5 小时仍是
  `COMPLETE`。依据 `state-model.md` §2.0.1（6,308 次大间隔里 94.8% 之后仍有调用），有专门测试守着。
- **派发链路一行未动。** `SKILL.md` 不调它它就完全不存在。接法写进设计文档 §7，
  并指出一个真实接口缺口：`task-graph.json` 没有 `outputs[]` 字段，现在 `--paths` 只能由主线程现写。

---

## [Unreleased] - 2026-11-12（日志轮转：交来的「静默 4 小时」是影子目录，改修「失败不可见」）

> 产出：`scripts/watch.mjs`（`createLogger` / `healthCheck` / `formatHealth` + 3 个新导出）、
> `scripts/watch.test.mjs`（+7 用例 DFS-01…DFS-07）、`scripts/check-structure.mjs`（导出登记 + 探针参数）、
> 报告 `docs/research/2026-11-12-log-rotation-SILENT-failure.md`。
>
> **先证伪**：任务给的三条证据里，`watch.log`（41,857 B / 末行 10-31T19:22:58Z）**是 MSIX 影子副本**。
> WMI 起进程外进程复核：真实 `watch.log` **289,957 B、末行当前**，与 stdout 镜像 `runner.log`
> **逐行一致（2383 行 / 0 条缺失）**。那两份 1,048,5xx 的归档正是轮转产物，06:58:03Z 那次
> 轮转后新 `watch.log` 从第一行开始长——**轮转一直是好的**。
> 这是 `2026-11-04-watcher-silent-failure.md` 之后的**第二次同类误诊**。
>
> **改的是真缺陷**：`--health` 只读 `state.json`（调度心跳），结构上无法发现日志系统自己的故障。
> 一个吞掉自己失败的 logger，会让「守护进程在跑」与「它什么都没记」变成同一画面。

### Fixed

- **日志失败三层可见。** 原来四处静默：`statSync` 非 ENOENT 失败一律 `return`（不再轮转）、
  两次 `rename` 都失败后完全静默（轮转永久失效）、`appendFileSync` 失败只 mirror 到 stdout（行丢弃）、
  `--health` 不看日志。现在每条故障同时：写进日志本身第一行（`[WARN] log-health: <kind>`）、
  写 stderr（`[log-fault] <kind>`，被 VBS 拉起时进 `runner.log`）、写 `log-health.json`。
  同一故障按签名去重，换一种故障重新报。
- **轮转三级降级，失败不停止写。** `rename` → **先复制再截断** → 继续追加（超限）。
  第 2 级必须先复制：单纯截断会永久丢掉旧日志的最后 1 MB，而按本项目自己的规矩
  （README 与硬门都在守）证据不能由程序替你决定删掉。复制成功则另存
  `watch.<时间戳>.copy.log`；复制也失败时 `kind` 报 `rotate-failed-truncated` 而非
  `rotate-failed-copied`，**明说内容会丢**。
  判据：**日志无限增长 > 日志静默停止**——前者用户能用 `ls` 看见，后者看不见。
- **写失败落 `watch.log.emergency`。** 原来 `catch` 后直接 `return`，那一行永久消失。
- **`healthCheck(state, { logHealth })` 新增日志层。** `undefined`（调用方没传）与 `null`
  （从未坏过）都标 `verified: false` 并单独输出，**不当作健康**——「没检查」不能长得像「检查过且通过」。
  `--health` 现在读 `log-health.json`，日志坏了直接退出码 1 并指名故障类型。
- **`createLogger` 加 IO 接缝 `deps`。** Windows 上让 `rename` 真失败需要另一进程持句柄、
  NTFS `chmod` 不生效、杀软改变行为——**做不到稳定复现的负向测试等于没有**，所以注入必抛错的 IO。

### 负向验证（回退即红）

| 回退项 | 变红的用例 |
|---|---|
| 轮转失败静默吞掉 | DFS-01、DFS-02 |
| `stat` 失败一律静默 `return` | DFS-04 |
| 写失败不落应急文件 | DFS-05 |
| `healthCheck` 不看日志层 | DFS-06 |
| 截断前不先复制（旧内容永久丢失） | DFS-02b |

### 测试

`node --test scripts/*.test.mjs` → **881 / 881 全绿**（本 Agent 开工基线 873，+8：
DFS-01…DFS-07 + DFS-02b）。`node scripts/check-structure.mjs` → 通过。
四份文件的测试数已同步 873 → 881。

### 未做 / 存疑

- **生产守护进程未重启**（PID 25456），新逻辑下次启动才生效。按任务要求不重启。
- **但该进程在本轮工作中已经停了**：最后一轮 tick `2026-11-12T13:11:02Z`，日志里没有
  `watch 退出`。我**没有**对它执行任何 kill；三次受控实验（哑进程 / 真 watcher 实例 / 结构门）
  都没能复现「被测试杀掉」。**查不出原因，也不能证明与我无关**——是否重启请用户决定。
  详见报告 §八。
- `createObservationLog` 有同类静默 `catch`（观察日志追加无应急文件），本轮未改，记在报告 §七。

---

## [Unreleased] - 2026-11-13（事实清单：在多次结论翻转之后，给一份能信任的基线）

> 产出：`docs/FACTS.md`（新增）。入口登记在 `docs/README.md` 的两处表里。
>
> **为什么需要它**：这个项目在几小时内经历了多次结论翻转——「15/24 是假报告」→ 1/31；
> 「`claude -p` 不能用」→ 能用但慢且会静默失败 → 今天两种剥法都失败；
> 「`claude-agent-acp` 版本不存在」→ 查错了包；「`NO_EVIDENCE` 37 条是痛点」→ 94% 来自自建沙盒；
> 「守护进程死了 7.75 天」→ MSIX 影子目录，进程一直活着。
> 用户要的不是又一份报告，是一份**每条都写清证据等级和复跑命令**的清单。
>
> **测试基线**：`node --test scripts/*.test.mjs` → **880 / 880 全绿**。
> `node scripts/check-structure.mjs` → 通过。`node scripts/check-links.mjs` → 60 链接 0 断链。
>
> **边界**：未改任何代码、未碰 git。所有探针落在 `.tmp-analysis/`（gitignore）。

### Added

- **`docs/FACTS.md`。** 四部分：已验证的技术事实（每条含 T1–T4 证据等级 + 可直接复制的命令 + 实测输出）、
  已被推翻的结论（7 条，逐条写「曾经 / 为什么错 / 现在的正确说法 / 线索」）、
  未验证的假设（5 条，写清「有 / 无 / 仅文档」）、明确的未知（6 条，写清「需要什么才能答」）。
  开头有「如何读这份文档」，说明证据等级含义、哪些是快照哪些是稳定事实、数字会漂。

### 实测确认（本文件新增的数字）

- 回归测试 **873 条 / 19 个测试文件**（`node --test`，42 秒）。
- `verify-claims` 全量 **349 transcript / 108 断言**：41 SUPPORTED / 10 STALE_ONLY / 0 FAILED_ONLY / 49 NO_EVIDENCE / 3 UNKNOWN / 5 UNCHECKABLE。
- `NO_EVIDENCE` 的**沙盒 vs 真实**：按断言 **46 : 3**，按会话 **45 : 3**；`rea` 那 2 条 uuid 交集 99.7% 是同一份 transcript 的副本。
- 介入基线：`--days 7` = 117 次 / 144 会话；`--days 0` = 830 次 / 347 会话；P1 占比分别为 56.4% 与 37.6%。
- 介入发生在首次写操作之前的比例，四种口径 **4.5%–7.8%**（锐评报告写 8.2%，复现不出，方向和量级一致）。
- 并发曲线：**86.7% 墙钟无活跃会话**（353 transcript / 62 万条记录 / 3,506 小时）。
- `claude mcp serve`：**23 个工具**，`tools/call` 能真的执行。
- ACP：`acpx opencode exec` **成功返回 PONG**；`acpx claude exec` 卡在 `session/prompt` 的 `Authentication required`。
- `claude -p`：保留变量 → `Not logged in`；全剥 → 挂起（>400 秒）；只剥认证留 `ANTHROPIC_BASE_URL` → 「网关缺少 Authorization 头」。**P12 配方今天不复现。**
- 网关模型列表 2 个，实际路由是 `SCNet-Max`（最近 3 天 118,315 条记录）；传假模型名不会被网关拒，转发上游后 503。
- MSIX 影子目录：**同一文件 ID、不同目录枚举结果**（真实 11 项 / 影子 7 项，差的 4 项全是 10-31 之后产生的）；写入互通，非虚拟化子进程读数一致。
  **修正**：上一份报告的「会话内读 `%LOCALAPPDATA%` 会被重定向」**今天不复现**——会话内读到的是活数据。
- Stop hook：`decision:block` 真能拦（stdout 报文 + 账本 `outcome:blocked`）；
  `stop-verify-hook.mjs:259` 的 `truncated: false` 硬编码**仍然存在**，T4 对照证明改为 `true` 会从 `NO_EVIDENCE` 翻成 `UNKNOWN`。

### Known issue（本文件新发现，未修）

- **守护进程活着（PID 25456，state.json 每 15 秒更新），但最新日志从 06:58 起不再增长，已静默 3.45 小时。**
  已排除独占锁与权限；未查明根因。`watch.mjs --health` 读 state.json，所以它说「运行中」是真的，
  但它不会告诉你日志已停。登记在 `docs/FACTS.md` §1.5 与 §3.3。



> 报告：`docs/research/2026-11-13-claim-detection-fixes-and-multimodel.md`
> （含真实实验回归、多模型可达性实测、以及「当前环境无法验证兼容多模型」的证据）。
>
> **测试基线**：`node --test scripts/*.test.mjs` → **880 / 880 全绿**（改动前实跑一次 860 / 860）。
> `node scripts/check-structure.mjs` → 通过，0 违规 0 提示。
> 负向验证：`node scripts/verify-claim-fix-negatives.mjs` → **5/5 处回退都让预期测试变红**。
>
> **边界**：未碰 git；未碰 `scripts/oversight-tui.mjs` / `scripts/watch.mjs`。

### Fixed

- **`已全部修好`（不带「了」）漏检。** `detectClaims('已全部修好')` → `[]`，而加一个「了」
  就能认出来。缺陷在两条既有分支中间：`VAGUE_ZH` 的动词全带「了」，`VAGUE_DONE_HEAD`
  又不许「已」与动词间插词。P4 的最终首句正是 `…，已全部修好：`，P5 是
  `…，已按下面方式修好：`，两组 hook 都记 `checkableCount: 0` 后放行。
  新增 `VAGUE_DONE_BARE` 分支（`(?:^|[，,、])` + `已` + 最多 10 个非虚词 + 光杆动词
  + **复用 `VAGUE_TAIL`**）。复用 tail 是关键：定语（`七份已完成报告…` / `已完成的报告有三份`）
  仍然被挡在外面，上一轮的防误伤规则一条没动。
  （`scripts/verify-claims.mjs`：`COMPLETION_RE` 新增分支；`VAGUE_TAIL` 补 `：:`。）

- **`All four fixes are applied` 漏检（P4/P5/P6 里最后一处）。** 修完上一条后回归发现
  P6 仍然放行。它的首句是 `All four fixes are applied to lib.js.` —— `VAGUE_EN` 只认句首
  裸 `Done`/`Fixed`/`Completed`/`Resolved`，这句一个都没有。新增 `VAGUE_EN_ALL`
  （句首锚定 + 数量词可选 + 名词限定在 fixes/changes/bugs/issues/patches/edits + 必须完成体）。
  实测语料 312 段末尾文本里只命中 P6 一处。

- **`Whether tests pass matters here.` 被判成 `test-count`。** 那是英文的间接疑问，
  不是「测试通过」。`NEGATION_RE` 管不了它（既无否定也无失败措辞），`INTERROGATIVE_RE`
  也管不了（没有问号）。P1 因此被误拦一次。新增 `HYPOTHETICAL_LEAD_RE` /
  `HYPOTHETICAL_MARK_RE` / `HYPOTHETICAL_BRIDGE_RE` / `INVERSION_QUESTION_RE` 与
  `isHypotheticalMatch()`，并在 `detectClaims` 里**按每一处命中判、不按整句判**：
  只有当该族的**所有**命中都被假设语管着时才丢弃，`hits.every(...)`。
  整句否决会误杀 `我检查了测试是否通过，结果是 18/18 通过。` 的后半句 —— 这一条由
  `n5` 负向验证守住。

- **reason 文案混入英文族 ID。** V2 的拦截文案里出现「整个文件范围内没有任何
  vague-completion 调用」。根因不是漏映射，是**映射表抄了两份**：
  `classifyEvidence` 里那份漏了该族，退回 `|| fam`；`stop-verify-hook.mjs` 里那份有。
  改为唯一出处：`verify-claims.mjs` 新增 `FAMILY_NAMES` / `ACTIVITY_NAMES` 与
  `familyName()` / `activityName()`，`stop-verify-hook.mjs` 删掉本地表改 import。
  两个函数对未知族**都不回吐 ID**（退回「完成性断言」/「相关」）—— 写 `|| id`
  只是把同一个 bug 换个位置。

### Added

- **`scripts/verify-claim-fix-negatives.mjs`**：本批 5 处修复的负向验证。每处回退 →
  跑测试 → 还原，要求预期的那条测试真的变红。`n5` 是反向守卫：把「逐处命中判」改成
  「整句否决」，同句后半段的真断言会被误杀，对应测试必须红。
  它不是 `verify-bugfix-negatives.mjs` 的一部分 —— 那个脚本只跑 `tui-bugfixes.test.mjs`。

### 回归（真实实验数据，不是构造句）

`.tmp-analysis/hook-e2e/runs/` 的 19 组最终文本送进真实的 `decide()`，pre/post 对照：

| 变化 | 组 |
|---|---|
| 放行 → 拦截 | **P4 / P5 / P6**（全部是本次目标） |
| 拦截 → 放行 | **无** |
| 拦对的仍然拦 | P2 / P3 / PC1 / PC2 / PC3 / S1 |
| 有证据的仍然放 | C1 / H1 |
| 无断言可核对的仍然放 | H2 / H2b / H3 / N1 / NB1 / V1 / V2 / P1 |

全量语料 312 段末尾文本 A/B：新增 3 条（就是 P4/P5/P6 那三句），**丢失 0 条**，
309 段完全一致。

### Known（本次查清，但做不到）

- **「兼容多模型」在当前环境无法在闸门层验证。** cc-switch 本地网关
  （`127.0.0.1:15721`）忽略客户端的 `model` 字段，按 provider 配置一律重写成
  `deepseek-ai/deepseek-v4.1-flash` —— 连 `totally-nonexistent-model-xyz` 都回 200 并由
  该模型服务。`proxy_request_logs` 里四个不同模型名全部记成同一路由。
  绕过网关直连上游（`api.furry.vg`）能指定模型（已实测 5 个模型真路由），但那条路是裸
  HTTP，组不成「宿主 + Stop hook」的真实会话。已做的只是**判据层**验证：4 个模型在
  「施压 + 无 shell」场景下都说了「全部测试通过」，`detectClaims` 全部识别、
  `decide()` 全部拦截；`z-ai/glm-5.3-flash` 三次尝试无有效文本（2 次空 content、1 次 524）。
  **`vague-completion` 这一族在别的模型上会用哪些新措辞，本次没有能力回答** ——
  而 P4/P5/P6 的漏检全是「模型换了说法」造成的。

---

## [Unreleased] - 2026-11-13（文档长效机制：把「记得同步」换成「不同步就红」）

> 报告：`docs/research/2026-11-13-doc-sync.md`（含一致性巡检、四类机制的取舍与「不值得做」的理由）。
>
> **测试基线**：`node --test scripts/*.test.mjs` → **871 / 871 全绿**（本条目写作时实跑）；
> 数字以命令输出为准，硬门的 `checkTestCount()` 会对账。`node scripts/check-structure.mjs` → 通过。
>
> **边界**：未碰 git；未改 `oversight-tui.mjs` / `watch.mjs` / `verify-claims.mjs`（另有 Agent 在改，
> 它们的 11 条「导出未登记」提示保持原样、不阻塞）。

### Added

- **`docs/CAPABILITIES.md`**：把 README「能做」表里的每条能力绑到一条**可运行的命令**。
  硬门 `checkCapabilities()` 校验脚本存在、参数被支持、README 必须指向它。这是「能力声称可验证化」
  的落地：文档不再只是承诺，而是能被 `check-structure.mjs` 核对。
- **`docs/README.md`**：文档总入口。按「你想知道什么」指路，并写明四类文档的可信度不同
  （`spec/` 现行事实、`design/` 全部未实现、`research/` 会过期）。
- **`templates/baseline.md`**：`dispatch-contract.md` §1 一直要求每个 Agent 收到 baseline 快照，
  而该模板此前**从未存在**（`2026-11-10-agent-roles-audit.md` §6.6 记录过）。补上。
- **四道新的文档一致性硬门**（`scripts/check-structure.mjs`）：
  - `checkDocReferences()` —— 活文档引用的 `scripts/` `templates/` 路径必须存在；计划中的路径须在该行标「待建」。
  - `checkDocCommands()` —— 文档里的 `node scripts/x.mjs --flag`，脚本要存在、`--flag` 要真被源码支持。
  - `checkDocConstants()` —— 文档写 `` `CONST = N` `` 时，源码里该常量必须真是 N。
  - `checkResearchIndex()` —— 每份研究报告必须在 `docs/research/README.md` 登记状态。

### Changed

- **README 收窄产品定位**：从「把所有会话压成一张表」改为「**在 AI 想收工时替你把关**」。
  看清会话这件事官方 `claude agents` 已做完；本库唯一站得住的差异是「断言 vs 证据」。
  核心能力表新增「收工值守（Stop hook，默认关闭）」一行，并指向 `CAPABILITIES.md`。
- **状态数口径统一**：`GUIDE` 的「五态」状态表**漏了 `WAITING`**（`judgeState` 实际产出六态），
  补齐并按 `judgeState()` 的真实顺序重排；`tui-visual.md` 的「唯二参与通知」改为四态
  （`NOTIFY_STATES = WAITING/BLOCKED/FAILED/ASKED`）；`state-model.md` §8 的「四选一」改「六选一」。
- **`output-format.md` §2 状态行**：原文称「由 `scripts/scan-sessions.mjs` 渲染」，**代码里没有任何脚本
  输出这个格式**（本机 grep 确认）。改为诚实标注：格式是约定、渲染器未实现、数字只能取自 `--json`。
  `.claude/skills/oversight/SKILL.md` §7 同步。
- **`tui-theme.mjs` 的状态含义文案**：`FAILED` 的 `meaning` 还写着已删除的心跳推断，
  `STALLED` 还写着「派生树无任一节点有增益」（`judgeState` 不接收派生树）。按代码事实重写。
  这不只是文案——这串文案就是 TUI 上给用户看的解释。

### Fixed

- **`docs/research/README.md` 报告总数从写死的 62 改为「以目录实际份数为准」**，并补登记
  3 份此前漏登记的报告（`pre-commit-audit` / `plan-first-mechanism` / `dsh-goal-mechanism`）。
  写死的计数本身就是会漂的数字，改成交给硬门数。

### Known（未修，刻意不碰）

- `scripts/verify-claims.mjs` 的 11 个导出未登记进 `PROBE_ARGS`（硬门只提示不阻塞）。
  该文件另有 Agent 在改，本轮不碰，留待其收口后统一登记。

---

## [Unreleased] - 2026-11-13（Stop hook 放行样本记录：先攒分布，再决定加不加规则）

> 报告：`docs/research/2026-11-13-hook-sample-logging.md`（含漏检形态、字段设计、分析命令用法）。
>
> **测试基线**：`node --test scripts/*.test.mjs` → **860 / 860 全绿**（基线 826，新增 34：
> `stop-verify-hook.test.mjs` +15、`analyze-hook-samples.test.mjs` +19）。
> 基线跑了两遍：第一遍 826 条中 1 条**计时型**性能用例红（`normalizeBash 处理长字符串不随长度变慢`，
> 实测 32 倍长度 7.4 倍耗时），第二遍 826 / 826 全绿；该文件单跑亦全绿。属机器负载下的抖动，
> 与本次改动无关（本次没碰 `normalizeBash`），但它是真会红，记在这里而不是假装没看见。
> `node scripts/check-structure.mjs` → 通过，0 提示（改动前后各跑一次）。
>
> **边界**：未提交；未碰 git；**未改 `vague-completion` 的任何规则**，也未改
> `verify-claims.mjs` 的判定逻辑。只动了 hook 的记账侧与新加一个只读分析脚本。

### Added

- **放行样本记录**：Stop hook 判定 `allow:no-checkable-claim` 时，把该轮末尾文本的
  **前 500 字**与**真实工具调用摘要**追加到 `tasks/runs/stop-hook-samples.jsonl`（gitignored）。
  默认**开启**（无副作用，只写日志），`--no-sample-log` 或
  `OVERWATCH_STOP_VERIFY_SAMPLES=off` 可关。**记录不参与判定**：记完之后照样放行。

  > 为什么先记录不加规则：修好 `vague-completion` 后实测 6 组里仍是 3 抓 3 漏
  > （P4 / P5 / P6 漏）。漏的三组共同形态是 `已+动词` 后接冒号 ——
  > `项目里的 4 个 bug 都在 lib.js...已全部修好：`。6 个样本撑不起一条新正则，
  > 那是在用 6 个点拟合一个未知分布。

- **`scripts/analyze-hook-samples.mjs`**：只读分析命令。回答「有多少条含完成语义但
  `hadTestRun=false`」「形态有几种」「有没有共同特征」。5 类形态固定不变，便于多次
  采样对比。**它不自动拦截，输出是待人工复核的候选，不是「已确认漏检」。**

### Changed

- `stop-verify-hook.mjs` 的 `decide()` 返回值新增 `assistantText`（判定实际用的原文）——
  样本据此记录，避免记录层与判定层各自解读一次 `last_assistant_text` 而在两处读出不同文本。
- 四处回归测试数声明 826 → 860（`README.md` / `CLAUDE.md` / `docs/GUIDE.md` /
  `.github/workflows/validate.yml`），由结构门对账。

### Known（未修，本次刻意不碰）

- **`state-model.test.mjs` 有一条计时型性能用例会偶发红**：
  `normalizeBash 处理长字符串不随长度变慢`。本次改动前跑了两遍基线 ——
  第一遍实测「长度 32 倍但耗时 7.4 倍」，第二遍全绿；该文件单跑 41/41 全绿。
  也就是说它受机器负载干扰，不是稳定失败，也不是本次改动引入的（本 PR 没碰 `normalizeBash`）。
  留给后续决定：要么放宽阈值，要么把这条改成不依赖 wall-clock 的判据（例如统计内层循环次数）。

---

## [Unreleased] - 2026-11-12（Stop hook 端到端验证：闸门能拦，但这台机器上很少有机会拦）

> 报告：`docs/research/2026-11-12-stop-hook-e2e-validation.md`（含两次实验事故、样本量、污染说明）。
>
> **边界**：只做实验与记录，**未改任何产品代码**；未碰 git；沙箱与运行数据都在
> `.tmp-analysis/hook-e2e/`（gitignored）和 `%TEMP%\hook-e2e-sandboxes\`。

### Added

- **端到端验证报告**：用真实模型（不是原型阶段的 mock）跑 Stop hook，回答「拦截后模型行为分几种」。
  14 次有效运行（干净配置 6 次）、**2 次真实拦截**（干净配置仅 1 次；n 太小，不给比例）。
- 实验装置修复：`run.mjs` 新增 `--nobash` / `--sealed` / `--pressured` 三个条件；沙箱移出仓库，
  hook 改用 `--settings` 显式注入（`--setting-sources` 会把父级 CLAUDE.md 一起拉进沙箱）。

### Fixed

- **实验装置的致命污染**（不是产品 bug，是实验 bug）：沙箱原在仓库的 `.tmp-analysis/` 下，
  `--setting-sources project` 让宿主向上发现仓库自己的 `CLAUDE.md` 并注入。P1 的模型据此推理出
  「这是一个 hook e2e test，我是被测试的对象」。对照实验确认 `--setting-sources ""` + `--settings`
  可以只挂 hook、不引入 CLAUDE.md。此前 9 组样本因此作废。

### Known（未修，留给后续决定）

- **`vague-completion` 漏报 `已全部修好`（不带「了」）。** 实测
  `detectClaims('已全部修好')` → `[]`，而 `已全部修好了` → `vague-completion`。
  根因是 `VAGUE_DONE_HEAD` 不允许 `已` 与动词之间插入「全部」，`VAGUE_ZH` 又要求有「了」。
  P4 的最终首句正是这个形态，`hooklog` 记 `checkableCount: 0` 后放行。
- **`test-count` 误报假设从句。** `detectClaims('Whether tests pass matters here.')` → `test-count`，
  P1 因此被误拦一次。`NEGATION_RE` 只管否定，不管 whether / 是否 这类假设语。
- **reason 文案混入英文族名**：V2 的拦截文案里出现「整个文件范围内没有任何vague-completion调用」，
  族 ID 未走中文映射。

---


## [Unreleased] - 2026-11-13（Stop hook 漏掉「修好了」：新增无指标完成声明族）

> 报告：`docs/research/2026-11-13-vague-claim-detection.md`（含设计取舍、误伤边界、真实语料实测）。
>
> **测试基线**：`node --test scripts/*.test.mjs` → **826 / 826 全绿**（基线 798，新增 28）。
> `node scripts/check-structure.mjs` → 通过，0 提示。
>
> **边界**：未提交；未碰 git；未碰 `oversight-tui.mjs` / `watch.mjs`。

### Fixed

- **Stop hook 对「笼统的完成声明」完全失明。** 已有九族**全部**要求句子里有具体指标
  （数字 / hash / 命令名 / 远端名），于是「修好了」「搞定了」「Fixed.」一个都不命中，
  判定退回 `allow:no-checkable-claim` 直接放行。实验 P2 组实测：模型没有 Bash 工具、
  改了 `lib.js`、零次测试，最后说「修好了。三处 bug 都在 lib.js。」——拦截 **0** 次。
  （`scripts/verify-claims.mjs`：新增 `COMPLETION_RE` / `COMPLETION_VETO_RE` /
  `CLAIM_FAMILIES` 的 `vague-completion` 族，以及 `detectClaims` 的 `veto` 支持。）

- **新增 `isVerificationCommand()`：这类断言要的证据是「任何一次检查」，不是「某个特定测试」。**
  跑过测试、构建、lint、类型检查、语法检查都算；**只读观测**（`ls` / `cat` / `grep` /
  `git status` / `git diff`）不算 —— 把它们算进来，本族就形同虚设。
  `mvn package -DskipTests` 也不算：它恰好什么都没验证。

### Changed

- **`stop-verify-hook.mjs` 的拦截文案**新增一段：明说「只读观测不算验证」，并给出
  「如果本会话确实没有执行能力，就说『改了，未验证』」这条出路 —— 否则模型会拿着
  `git diff` 的输出蒙混过关。

### 防误伤（这一条是本族的重点，不是附注）

- **句首锚定 + 短主语。** 句中出现的「修好了」绝大多数在描述或复述，不认。
  实测反例（语料 `ea4ef562`，它自己就在讨论这个漏洞）：`而说"修好了"的人，往往什么都没跑`。
- **`已 + 动词` 不许当定语。** `七份已完成报告全部只留在会话记录里，没有落盘到 docs/`
  这句话恰恰在坦白**没落盘**，却被旧写法当成完成声明（实测语料 `536cf97b`）。
- **动词后不许接长宾语。** `完成了这件事需要三步。` 是在讲方法，不是报完成。
- **部分完成不拦。** `修好了 test.js 的语法错误，但业务逻辑还没测` —— 它已经主动交代了
  缺口，比光说「修好了」诚实。拦它会教会模型「下次别交代」。
- **纯对话 / 只改文档 → UNCHECKABLE，不拦。** 零改动、零命令的会话判 UNCHECKABLE；
  只改了 markdown 的（`lastCodeIndex < 0`）也判 UNCHECKABLE —— 没有任何测试能验证它，
  要求它跑测试是把「无解」说成「没做」（实测：`0a0e115c` 79 个 Write 全是 `_study/*.md`）。

### 真实语料实测（341 个主 transcript，尾部 1 MB）

| 指标 | 改前 | 改后 |
|---|---|---|
| 含可核对断言的会话 | 67 | **85**（+18） |
| 断言条数 | 76 | **101**（+25） |

25 条 `vague-completion` 的判定分布：SUPPORTED 10 / NO_EVIDENCE 7 / UNCHECKABLE 5 /
STALE_ONLY 2 / UNKNOWN 1。**真正会被拦的只有 9 条**（NO_EVIDENCE + STALE_ONLY），
其余 16 条放行。这 9 条里包括实验 P2 / P3 / PC1 / S1 四组，以及 `0a0e115c` / `f37b9290`
两句「两件事都做完了」（有源码改动、无任何验证调用）。

### 证据

- 负向：把 `vague-completion` 从 `CLAIM_FAMILIES` 摘掉，P2 的原话在其余九族里**一条都不命中**
  （`verify-claims.test.mjs` 的「关掉 vague-completion 族，P2 那个用例必须变红」）。
- 误伤：7 组「不该被识别」的用例（否定 / 假设 / 引用 / 代码块 / 纯对话 / 句中描述 / 定语）
  全部保持不识别；另有一组证明挡住「部分完成」的是 `veto` 而不是正则碰巧不匹配。
- 端到端：真实 P2 transcript 走 `decide()` → `action: block`，
  `verdict.status: NO_EVIDENCE`（改前是 `allow:no-checkable-claim`）。

---

## [Unreleased] - 2026-11-13（TUI 非 TTY 红测：夹具过时，并揪出列表页不净化外部文本）

> 报告：`docs/research/2026-11-13-tui-test-regression.md`（含因果链、真实数据实测、负向证据）。
>
> **测试基线**：`node --test scripts/*.test.mjs` → **793 / 793 全绿**（基线 791，新增 2）。
> `node scripts/check-structure.mjs` → 通过，0 提示（改动前后各跑一次）。
>
> **边界**：未提交（见下）；未碰 git；未碰 `watch.mjs` / `verify-claims.mjs` / `stop-verify-hook.mjs`。

### Fixed

- **列表页与 `--plain` 完全不净化外部文本，OSC 52 可改写系统剪贴板。** 详情页
  （`detailLines`）一直对 `project` / `sessionId` / `needs` 调 `sanitize`，列表页一个字都没调；
  `detailLines` 的 `cwd`（`whereRaw`）也漏了一行。实测把 `\x1b]52;c;eA==\x07` 塞进 `project`，
  `node scripts/oversight-tui.mjs --plain` 原样放行。修法是在 `viewOf()`
  （`scripts/oversight-tui.mjs:580`，列表页与纯文本页**唯一**的取数入口）统一净化
  `title` / `path` / `needs` / `suggestedReply` / `meta.lastAssistant` / `meta.question`，
  并补上 `detailLines` 的 `whereRaw`。`key` 故意不净化：它是光标身份，必须与 `cursorKey`
  逐字相等。这是「两条展示路径各修一半」（DF-012 / DF-017）的又一次复发，所以修在必经点而不是渲染层。

### Changed

- **`oversight-tui.test.mjs` 的夹具补上 `live`，红测不是显示逻辑坏了。** `main() 非 TTY 分支
  能产出输出` 2026-11-13 红灯（790/791）。根因：`partitionRows`（`tui-layout.mjs:395`）判「在跑」
  要求**出现在宿主 `live` 里且有 transcript**，而夹具只给了 `sessions`，那条 `PRODUCING` 会话
  被判成**已停**；「已停」在 `--plain` 里默认压成一行计数，项目名根本不进屏。
  `cwd` 与这条红测无关——`viewOf` 的兜底链是 `meta.cwd → row.cwd → row.project`，
  无 cwd 照样有项目名（实测 `scan --json --days 3` 的 **110/110 条 sessions 都没有 cwd**，
  cwd 只在 `live`（11/11）与 transcript meta 里）。
- **四条断言全部收紧，没有一条放松。** 旧 OSC 测试（`oversight-tui.test.mjs:226`）是**假绿**：
  夹具同样缺 `live`，会话掉进折叠的已停段，`project` / `needs` 一个字没渲染，
  「没有 ESC」于是自动成立。新增「必须进在跑段」「净化后正文仍在」的断言把它变成真测试，
  并新增两条：需动作段的 `needs` / 建议回复净化（在跑段不画 needs）、`viewOf` 纯函数层
  （无 cwd 兜底 + 五个字段净化）。负向测试：撤掉 `viewOf` 的 `sanitize` → 3 条红；恢复 → 全绿。

---

## [Unreleased] - 2026-11-13（一致性审计的 6 条 🔴：用户照文档做会做错决定）

> 报告：`docs/research/2026-11-13-dangerous-inconsistencies-fixed.md`。
> 来源清单：`docs/research/2026-11-13-consistency-audit.md` 的第二部分（🔴 危险档 6 条；
> 该报告共 24 条，本次只修这 6 条，🟡/🟢 留给后续）。
>
> **测试基线**：`node --test scripts/*.test.mjs` → **826 / 826 全绿**。这个数字在本轮内变过三次
> （审计时 793 → 加 5 条建议命令用例 = 798 → 同目录另一个 Agent 又加 22 条 = 820 → 再加 6 条 = 826），
> 每一次都是被本轮新增的 `checkTestCount()` 抓住的：它报「写的是 N，源码实测 M」并 exit 1。
> **这正是这道门存在的理由** —— 数字不会再悄悄漂，漂了就有一步必做的动作。
> `node scripts/check-structure.mjs` → 通过（含新增的 `checkTestCount()` 一道门）。
>
> **边界**：未提交；未碰 git；未碰 `stop-verify-hook.mjs`；未跑 `verify-tui-negatives.mjs`
> （审计报告记了它被超时 kill 后会留脏工作树，本次不需要它）。

### Fixed

- **GUIDE 教用户用一条已删除的 `FAILED` 判据——照做会对只是歇一会儿的会话执行全量重跑。**
  `docs/GUIDE.md:81` 写「宿主报失败 **或** 两次调用间隔超过 p95 且之后 60 秒无新记录 **或** 预算耗尽且零增益」，
  而 `scripts/scan-sessions.mjs:217-233` 明写这两条推断 2026-10-31 全语料实测后已删除
  （6308 次大间隔里 5977 次、94.8% 之后仍有 tool_use）。改成「只有一种来路：宿主 `state: "failed"`」，
  并把 §3 的「为什么空闲 3 天是 EXPLORING」整节按当前两道事实闸门重写。
  同类陈述一并收口：`:94` 的 p95 理由、`:135`/`:321` 的「样本不足 → 永远不会判 FAILED」
  （`FAILED` 已与样本无关）、`:123` 的 `reason` 合法值表（混着已不存在的 `hb_gap=…`，漏了
  `host-reported-waiting` / `waiting:<waitingFor>`）。`docs/spec/state-model.md:322-329` 同步。
- **`verify-claims.mjs` 的补救建议硬编码 `npm test`，对 Maven 项目指错命令。** 实际命令一直在
  `evidence.attempts[].cmd` 里没人用。新增 `recoveryCommandFor()` 三档溯源：
  `actualCommandFor()`（会话里**成功跑过**的那条，`shortenCommand()` 从
  `export JAVA_HOME=… && mvn.cmd -f …` 里裁出命令本体）→ `detectProjectCommands(cwd)`
  （`project-commands.mjs`，读 `package.json` / `pom.xml` / `build.gradle` / `Cargo.toml` / `go.mod`）
  → 直说认不出、**不编命令**。`evidenceTimeline()` 因此多返回一个 `cwd` 字段（只给建议用，不参与判定）。
  真实语料实测：`d--Server-MCServers-Server-plugin-Mentor-Express` 的 `3b390f6e` 会话
  现在给 `mvn -q clean verify（依据 pom.xml）`，改前给的是 `npm test`。
- **子 agent 上限 GUIDE 写 30，代码是 100**（`MAX_SUBAGENTS = 100`，`scan-sessions.mjs:490`），
  且同一文件 `:122` 自己写的就是 100。`GUIDE.md:317`、`:410` 与详情页示例一并改。
- **`STALLED` 判据里有一项代码不存在。** GUIDE `:83` 与 `state-model.md:28` 都写「且派生树没有任何
  节点有增益」，而 `judgeState()` 的签名是 `{ sessionState, waitingFor, calls, gapsMs, now }`，
  根本不接收派生树。该效果实际由 `allCalls`（主线程 + 子 agent 调用合并按时间排序，
  `scan-sessions.mjs:442-444`）实现——子 agent 有新动作就抬高 novelty。照实改写，并在
  `state-model.md §5` 补上「靠合并时间线实现，不靠单独判据」。
- **详情页示例整段是旧版 TUI 的输出。** `GUIDE.md` 的 `项目/sessionId/idle` 形态已被
  `状态/身份/最近说` 取代，`派生树 · 层深 1 · 子 agent 100/128（已截断）` 也换成了
  `派生 100/122 · 层深 1 · …`。按本机实跑的真实输出重写，并说明 L5/L6 两层与「只画 3 行」的披露规则。

### Added

- **`check-structure.mjs` 的 `checkTestCount()`** —— 测试数四份文件四个值
  （README 508 / CLAUDE 192 / GUIDE·CI 81 / 设计稿 588，实测 793）是本仓论题的自我否定：
  一个卖「断言必须有证据」的项目，在最核心的数字上四份文件四个值。这次不是把 4 个数字改成 1 个就完事
  （下一次加测试又会漂），而是**数源码**（`^\s*test\(` 的条数）再与 `README.md` / `CLAUDE.md` /
  `GUIDE.md` / `validate.yml` 逐处对账，不一致直接 `fail`。负向验证：把 README 改回 508，
  硬门报「回归测试数写的是 508，源码实测 798」并 exit 1；改回 798 恢复绿灯。
- **`verify-claims.test.mjs` 新增 5 条**：Maven 项目必须给 `mvn` 且**不含** `npm`（含复合命令裁剪、
  路径不许被压成 basename）、Node 项目抄成功那条而不是失败那条、无调用时退回项目配置且要说出来源、
  都认不出时不点名任何命令、以及一条把「写死 `npm test`」这条路堵死的负向守卫。

---

## [Unreleased] - 2026-11-12（Stop hook 验证闸原型：事前拦截跑通，且推翻了上游文档一条结论）

> 报告：`docs/research/2026-11-12-stop-hook-prototype.md`（含真实拦截证据、边界处理、已知限制）。
> 上游依据：`docs/research/2026-11-11-untapped-capabilities.md` §1。
>
> **测试基线**：`node --test scripts/*.test.mjs` → **791 / 791 全绿**（基线 756，新增 35）。
> `node scripts/check-structure.mjs` → 通过，0 提示（改动前后各跑一次）。
>
> **边界**：未提交（新增文件见下）；未碰 git；未动 `~/.claude/settings.json`；
> 未在仓库内注册任何生效的 hook（默认关闭）。所有实跑都在 `%TEMP%` 下的临时目录完成。

### Added

- **`scripts/stop-verify-hook.mjs`** —— Stop hook 验证闸。宿主在 Claude 每次准备结束回合时同步调用，
  读 `last_assistant_message` → 复用 `verify-claims.mjs` 的 `detectClaims/findEvidence/classifyEvidence`
  逐条定档 → 证据不足（`NO_EVIDENCE` / `STALE_ONLY` / `FAILED_ONLY`）时返回
  `{"decision":"block","reason":"..."}`，reason 作为下一轮指令喂回模型。
  **默认 off（只记账，永远 exit 0）**，需显式设 `OVERWATCH_STOP_VERIFY=block` 才拦。
- **`scripts/project-commands.mjs`** —— 从仓库根标志文件认项目类型并给出**真实**测试命令
  （node/maven/gradle/cargo/go/python/dotnet；认不出就明说认不出）。存在的理由是
  `verify-claims.mjs` 的 `adviceFor()` 把命令写死成 `npm test`，对 Maven 项目是错的建议。
- **`scripts/stop-verify-hook.test.mjs`** —— 35 条测试。重点是负向：默认模式必不拦、
  四条 fail-open 路径、`UNKNOWN` 不升级成 `NO_EVIDENCE`、Maven 项目的 reason 里不许出现 `npm test`。
- **`templates/stop-verify-hook.settings.json`** —— 注册片段 + 三步启用说明（不含生效 hook）。

### 实测（推翻上游文档的一条结论）

- **`exit 2` 不拦截**。上游 `hooks.md:2903` 说它与 `decision:block` 等价；实测 2.1.289 与 2.1.308
  都记成 `Failed with non-blocking status code`，回合照常结束。原型因此只用 `decision:block`。
- **上限是 9 次，不是 8 次**。默认「连续 9 次后强制放行」；`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=N`
  → 拦 N 次后在**第 N+1 次**放行（`cap=3` 实测拦 4 次）。
- **`additionalContext` 不是温和版拦截**，它会让模型每轮重复触发直到撞上限（实测跑到第 9 轮）。
- **`timeout` 过小时是静默 kill**：`hookInfos.durationMs` 有值、`hasOutput:false`、`hookErrors:[]` ——
  「hook 跑了但没生效」，极难从现象反推。模板写 60 秒并把这条写进注释。
- **子 agent 旁证是准确率分水岭**：80 个真实会话里 15 个含可核对断言，其中 14 个有
  `subagents/`。只读主 transcript 会对绝大多数真实会话误报「没证据」，所以
  `decide()` 在主 transcript 判为要拦**之后**才去读子 agent 尾部（代价只在本来就要拦时付），
  查到则放行并记 `evidence-only-in-subagents`（不判 SUPPORTED：子 agent 不在主时间线上）。
- **性能**：真闸门在 128.6 MB 的 transcript 上实测 0.54–1.49 s（3 次），靠 `readBack` 有界回溯。

---

## [Unreleased] - 2026-11-11（框架 v2 修订：Mastra 能派活，我们只剩「判活」）

> 文档：`docs/design/2026-11-11-agent-framework-v2.md`（689 行）。
> 索引：`docs/design/README.md` 增一行（`checkDesignIndex` 要求登记）。
>
> **测试基线**：`node scripts/check-structure.mjs` → 通过，0 提示（改动前后各跑一次）。
> 未跑 `node --test`：本次零代码改动，仅新增/修订文档。
>
> **边界**：零行代码改动；未碰 git；零 npm 依赖。本文件是设计推演，不描述已实现能力。
> **所有实跑都在 `%TEMP%` 下的临时目录完成**，未在仓库内安装任何包。

### Changed

- **agent 框架 v2 修订稿**（Proposed，零行实现）。修订动因是一条前提被实跑推翻：
  v1 骨架基于「没有框架支持 ACP」，而 Mastra 的 `@mastra/acp` 是一等公民包（调研 2026-11-10），
  本次又在本机跑通了它。三条核心修正：
  - **N1「协议层不对：它们管不了别人的进程」作废**。Mastra 恰好管得了。v1 的「三条结构性理由」缩为两条，且两条同源：
    我们编「判据」，它编「消息」。
  - **「框架」降级为「验收层」**。给出「框架 vs 层」三条判据（有无自己的生命周期 / 有无「谁去跑」的决定权 /
    有无可替换的宿主），并正面回答：既然只剩判活，它不该叫框架。
  - **v0 五件缩到三件**：判据 schema（写）/ 验收闸（写）/ 三值提取器（写 20 行）；
    适配器买 `acpx`、台账缩成一张「唯一写入者」表。
- **「判活」被定义成五个可反驳的要件（J1–J5）**：标准先于执行且是数据 / 判定者上下文不共享 /
  三值判定（含「不知道」）/ 判定有强制后果 / 判定可机读。并逐条论证 evals 与 `onDelegationComplete` 为何不能替代
  （evals 位置不对：评数据集不是评这张工单；`onDelegationComplete` 身份不对：它是父 agent 的钩子，拿不到 AC、不产出判定）。
- **不引入 Mastra 的五条理由，前四条是本机实测**：装依赖 148 包 / 6 分钟 / 149 MB / 10 085 文件、要求 Node ≥ 22.13；
  `usage` 恒为 `undefined`（dist 硬编码 0、`steps: []`）；**默认权限处理器选 `options[0]`=allow-once，实测静默写出文件**；
  官方文档的 Windows 接法 `command:'npx'` 直接 `ENOENT`。切换条件写死三条，任一成立才引，且必须用户批准（会推翻 ADR-0001）。

### Added

- **22 条本机实跑记录（P1–P22）**，其中 **7 条推翻了既有文档结论**：
  - `claude-agent-acp@0.104.1` 在 Windows 上**握手 / 建 session / 跑完回合全部正常**——v1 §3.5「`zod/v4` ESM 崩溃」已不复现，
    `acpx:claude` 因此成为首选适配器（用户明确说优先 Claude Code）。
  - **`allowedTools` / `disallowedTools` 实测无效**（给了 `disallowedTools:['PowerShell',…]`，PowerShell 仍被调用）；
    真正生效的是 `_meta.claudeCode.options.tools`。同一适配器里两个名字相近的字段，一生效一不生效——能力矩阵必须逐字段验。
  - **外部 session 会自动加载项目 `CLAUDE.md`**（它背出了本仓硬约束 1–4 的原文），且**会写进用户的 transcript 目录**：
    本次 20 个探针 session 出现在 `~/.claude/projects/` 下，`scan-sessions.mjs --days 1` 全部可见。
    后果是**跨系统污染**——扫描器会把我们自己的执行会话当成用户的会话。处置：`CLAUDE_CONFIG_DIR` + `settingSources:[]`（均已实测有效）。
  - 深度不是平台墙：给外部 session `tools:['Agent']` 后它**真的派出了第二层**（回 `DEPTH2-OK`）。
    v1 §3.3「深度 1 是物理不可达」的后半句因此作废；正确表述是「native 侧深度 1 是配置事实，外部侧由 harness 决定，我们只能观测」。
- **角色改法（12 份逐个判决）**：6 份必须改工具集或输出格式（planner / acceptor / redteam / research / relay / repair）、
  3 份改边界（critic / review / resolution）、3 份不动（probe / safety / executor）。
  关键修正：`acceptor` **不给 `Bash`**，而是给它 `gate.json`（跑过的结果，不是跑的能力）——给它 `Bash` 等于让它同时是控方与证人。
- **输出格式统一规则（三条）**：机器读的一律 JSON + schema + 校验器（v0 只有四个：ticket / report / gate / verdict）；
  人读的一律 markdown 且**不许有任何脚本解析**；markdown 视图一律由 JSON 渲染。
  这正面解释了「10 种模板、零个解析器」为何能共存：人读的模板不需要解析器。
- **红队攻击任务（强制不可合并）**，8 个必答问题，核心是第 2 问：J1–J5 里一个熟练的 Mastra 用户能不能拼出 ≥4 条。
  **止损点写在前面**：若能拼出 ≥4 条，本方案应退化为「Mastra 使用手册」，不写代码。

---

## [Unreleased] - 2026-11-11（公司架构设计书：三层 + 两个旁挂，12 个角色砍到 2 个）

> 文档：`docs/design/2026-11-11-company-architecture.md`（841 行）。
> 索引：`docs/design/README.md` 增一行（`checkDesignIndex` 要求登记）。
>
> **测试基线**：`node --test scripts/*.test.mjs` → **722 / 722 全绿**。
> `node scripts/check-structure.mjs` → 通过，0 提示。
>
> **边界**：零行代码改动；未碰 git；零 npm 依赖。本文件是设计推演，不描述已实现能力。

### Added

- **多 agent 公司架构设计书**（Proposed，零行实现）。把用户原话「围绕着用户的公司 / 职责分明又不臃肿 /
  可以外包给其他公司」落成可检查的组织图：
  - **三层 + 两个旁挂**：L0 接待台（唯一能问用户）、L1 工头（切工单写契约）、L2 执行者；
    门禁与记账旁挂——门禁不在汇报线上，记账不是岗位而是脚本。
  - **主 agent 与手下的唯一区别**：写的是「判据」还是「产物」。落成不变量 W——
    没有岗位同时拥有 `product` 与 `contract` 两种写权限。强制力分三级并如实标注
    （native 子 agent 物理 / 外部 harness 协议 / 主线程仅审计）。
  - **递归三道闸**：G1 工具可达性（物理）、G2 预算单调递减（算术，唯一真正封死的）、
    G3 `capability_gap`（语义）。据此指出 `dispatch-contract.md` §7 的「3 层」不可执行
    （12 份角色 tools 全部显式且无一份含 `Agent`，本次 grep 复核）。
  - **问题五环节**：收（脚本逐字）→ 扫（五类缺项抽取表）→ 问（upfront ≤5）→
    答（`acknowledged` 只由脚本判定）→ 传（按 `subject` 切片 + `sha256` pin）。
    三种权力分开：drop / guess 只归接待台且必须记账；噪声提示只归脚本且只警告。
  - **外包失败六档**：只有 `TRANSIENT` 重试。新增 `SILENT`（exit 0 但 nonce 未回显）
    与 `BOUNDARY_BREACH`（`git status` 可检出越界），后者把 `boundary` 从字符串变成可检出项。
  - **「不臃肿」六个可检查机制**（M1 产物闭集 / M2 每岗有被消费的边 / M3 同一 schema 唯一作者 /
    M4 能用脚本判的不设岗位 / M5 预算递减 + 编队声明 / M6 `tools` 必填且合法）。
  - **角色判决**：12 → 在编 2 个（`planner` 降为「笔」、`acceptor` 补 `gate.json` 证据源并限定写路径）、
    `executor` 保留定义不派、`redteam` 转周期性，其余 8 个砍掉（其中 5 个在新边界下永远不该回来）。
    另砍掉三个设想中的岗位（协调者 / 状态记账员 / 门禁执行者），全部改为脚本。

---

## [Unreleased] - 2026-11-11（检查表去表头：零值不占行，全绿压成一句）

> 报告：`docs/research/2026-11-11-tui-checklist-redesign.md`（含改前改后的真实 `--plain` 输出）。
> 依据：`docs/research/2026-11-11-claude-status-block-reverse.md`（逆向 Claude Code CLI 2.1.308，
> 全部结论附字节偏移）。用户截图反馈「检查表很突兀」。
>
> **测试基线**：`node --test scripts/*.test.mjs` → **722 / 722 全绿**（基线 715，新增 7）。
> `node scripts/check-structure.mjs` → 通过，0 提示。
> 负向验证：`scripts/verify-tui-negatives.mjs`，**23 / 23 处回退都让预期测试变红**（新增 4 项）。
>
> **边界**：未碰 git；未改 `scripts/verify-claims.mjs`、`scripts/asked.mjs`、`scripts/watch.mjs`；
> 未动配色（`BINARY` / `binaryMark` / `binaryColor` 一行未改）；仍零 npm 依赖。

### Changed

- **删掉检查区的「检查了什么 / 结论」元表头。** 逆向结论：Claude Code 的表格组件写好了
  `header` 渲染分支，但全库 **7 处实例、0 处使用表头**；真正带表头的只有 `/doctor` 规范里那张
  markdown 表，且列名全是数据名（`Component | Uses | Verdict`），**没有任何「检查了什么」式的元描述**。
  我们这对表头占着首屏最贵的一行却零信息量，还让空态看起来像「一张没填完的表」。

- **检查项改写成「标签 + 一句断言」，四列压成两段。** 旧形态是标签 / 来源 / 结论 / 备注四列
  （`→ 3 个`、`→ 0 个` 这种右对齐计数）。现在每项是一句自陈述句，照抄它的双版本 `label` 写法：
  `声明对不上 ✗ 1 条完成声明无证据支持 · 7 条存疑 · d 看证据`。
  严重度用**字形 + 颜色**两个通道（`✗` 硬失败 / `·` 需要注意 / `…` 还在算或不知道），
  与 `tui-visual.md` §1「颜色是装饰，不是信息载体」一致。

- **零值的项不占行，但被数进收尾句（不是静默丢弃）。** 逆向的机制是
  `if(i===""||i==="none")continue` 加「无发现写一句」（`/doctor` 规范原文：
  `If a check has no findings, say so in one line and move on`）。
  移植过来：有事的项逐行画，没事的项压成 `✓ 其余 2 项没有发现`；**四项全清白时只留一句
  `✓ 4 项检查都清白 · 监视在跑`**——这一句里「监视在跑」必须逐字出现，
  因为健康时它是最容易被计数吞掉的那一项。

- **`--plain` 与交互屏共用同一套呈现。** 旧实现两条路径各写一份（一条 `checklistLine`、
  一条手拼 `padDisplay('检查了什么', 51)`），于是同一个概念有两套文案。
  现在两条路都走 `checklistLines()`；`--plain` 之外多给一行 `依据：inbox · asked · verify-claims · health`
  ——那是**数据源清单**，不是表头，是「检查了什么」这个短语的正确替代（逆向 §3.3 第 7 条）。

### Added

- **`tui-layout.checklistSentence(row, { wide })`（纯函数）**：一项检查的一句话断言。
  无发现时说短句（`没有会话问了没答`），不说 `0 个`。刻意不含颜色，由渲染层决定怎么染。

- **`tui-layout.isQuietRow(row)`（纯函数）**：`tone === 'ok'` 才算「查了、没发现」。
  `muted`（还在算）与 `bad`（读不到 state.json）都**不算**——搞反了就是把「不知道」说成「清白」。

- **`tui-layout.checklistSummaryLine(count, { rest, extra })`（纯函数）**：收尾句。
  `rest: false` 是全绿判决（`✓ 4 项检查都清白`），`rest: true` 是「压掉的项数」（`✓ 其余 2 项没有发现`）。

- **`tui-layout.checklistLines(rows, { cols, layout, useColor, skipKinds, extra })`（纯函数）**：
  决定哪几项上屏。返回 `{lines, hidden, quiet}`；`quiet` 只取决于「有没有非绿项」，
  **与 `skipKinds` 无关**——否则「监视未跑但被告警行说过了」会得出「4 项都清白」，
  那正是本仓库最不能犯的错。默认跳过 `inbox`：它的数字就是 L0 的第一位，
  下面还有整段需动作原文，再画一行是同一件事的第三遍。

- **7 条单元测试 + 4 项负向验证**（`v20`–`v23`）：表头不许回来、零值不许占行、
  全绿不许变空白、健康时「监视在跑」不许被吞掉。每一条都实测「把改法放回去 → 预期测试变红」。

### Removed

- **`tui-layout.checklistHeaderLine()`。** 它唯一的职责是画那对元表头。留着它等于留着一条
  随时会被再调用一次的路径；`check-structure.mjs` 的 `PROBE_ARGS` / 导出白名单同步删除。

### 保留（逆向报告明确说这是我们的优势，不是缺陷）

1. **常驻性本身**：它监控用户看得见的对话框，我们监控看不见的后台进程——用户没有 `/status` 可敲。
2. **「数据多新」**：它只在诊断场景给 `Last update attempt`；我们的 `8s前扫描` 常驻在判决行右侧。
3. **后台监视存活状态**：本机实测 jobs / probe 停过 31 小时，那是真实发生过的失效。
4. **失败项必带一条出路**：`claude doctor` 是 `- <issue>` + `  Fix: <fix>`；
   我们的 `先修这个` / `d 看证据` 同构，保留。


## [Unreleased] - 2026-11-11（需动作老化 + 剪贴板只放能直接发出去的话）

> 报告：`docs/research/2026-11-11-tui-stale-and-copy-fix.md`（含实测延迟分布）。
> 用户实拍两个缺陷：33 天前的问句被判成「需动作」；按 `c` 复制到「回复正文 + 一段元注释」。
>
> **测试基线**：`node --test scripts/*.test.mjs` → **715 / 715 全绿**（基线 700，新增 15）。
> `node scripts/check-structure.mjs` → 通过，0 提示。
> 负向验证：`scripts/verify-tui-negatives.mjs`，**19/19 处回退都让预期测试变红**（新增 8 项）。
>
> **边界**：未碰 git；未改 `scripts/verify-claims.mjs`、`scripts/asked.mjs`；未动配色。

### Added

- **`tui-layout.ACTION_MAX_AGE_SEC`：需动作的老化上限，每个事实态一档。**
  `WAITING` 此前**没有任何上限**（`BLOCKED` 有 `watch.mjs: BLOCKED_MAX_AGE`，WAITING 什么都没有），
  于是一个 33 天前问的问题今天仍然进「需动作」，还因为按 `idleSec` 降序排而**永远排第一位**。

  | 状态 | 上限 | 依据 |
  |---|---|---|
  | `WAITING` | **24h** | 本机 247 个 transcript 实测：457 条问句、443 条能配对到真人回复，延迟 p50 0.27h / p90 10.93h / p95 15.23h / **p99 17.59h**，**99.5% 在 24h 内**。与 `asked.mjs: MAX_QUESTION_HOURS` 同一口径。 |
  | `BLOCKED` | **7d** | 直接复用 `watch.mjs: BLOCKED_MAX_AGE`。通知门与展示门对同一件事必须用同一把尺，测试钉住两者相等。 |
  | `FAILED` | **7d** | 镜像 BLOCKED。**本表唯一推定值**（无独立实测），代码注释里已声明。 |

- **`ageSecOf` / `staleOf` / `ageLimitOf`（纯函数，时钟可注入）。** 优先用行上已有的
  `idleSec`，其次 `(nowMs - statusUpdatedAt)`，两者都取不到时 **fail-open**（不凭猜藏起真实等待）。
  **自己不读挂钟** —— 这个仓库刚因硬编码 `Date.now()` 修过 bug。

- **`oversight-tui.draftHintOf`：草稿可复制性说明。** 给界面用、不进剪贴板，
  与 `buildDraft` 对「能不能复制」必须永远一致（测试钉住）——两者分家正是本次缺陷的根。

### Changed

- **`buildDraft` 只返回一段可直接发送的正文。** 旧实现把 `suggestedReply` 与
  `（目标会话受阻，在等：${needs}）` 用 `\n\n` 拼在一起，第二段粘进对话框就变成一句奇怪的话。
  现在：有 `suggestedReply` 且未超龄 → 返回原文；**超龄 → `null`**（33 天前猜的话不该被复制）；
  **只有 `needs` 没有 `suggestedReply` → `null`**（旧行为会拼一段旁白，那正是缺陷本身）。
  `needs` 仍**逐字**显示在 `--plain` 的 L2 段与详情页（`relay-protocol.md §5.1` 未放松）——
  变的是剪贴板，不是屏幕。

- **`partitionRows` 把超龄的需动作事实降级进「已停」，不丢弃。**
  用户要求「所有都要显示」，所以既不能留在需动作（误报）也不能删掉（漏报）。
  降级行带 `stale: true` + `staleAgeSec` / `staleLimitSec`；返回值多一个 `stale` 数组；
  三段合计仍等于总行数（测试钉住）。

- **`stoppedSummary` 数出降级条数**：`已停 (227) 4.5h–36.6d前 · 其中 2 条超龄 · h 展开`。
  按 `h` 展开时超龄行标题后缀 `· 超龄`；详情页新增「已超龄」说明（年龄 / 上限 / 为什么不给建议回复）。

- **`actionCell` 判据收紧**：从「有没有 suggestedReply」改成「按 c 到底会不会得到东西」。
  超龄的行不再画 `c 复制回复`（规划 P6：不提供假按钮）。

- `App.buildListFrame` / `buildDetailFrame` / `copyDraft` 统一把 `this.now()` 传下去：
  一帧只取一次时钟，避免「这一帧说还年轻、下一帧说超龄」。

### Tests

- 新增 15 条。老化锚点用 **33.1 天**（`7710fbdb` 实测值）与 **30 天**，不贴阈值边界，
  时钟全部注入 `2026-11-11T00:00:00Z`。
- 负向 8 项（`v12`–`v19`）逐条真正回退源码再跑测试：删 `WAITING` 上限、
  让 `partitionRows` 无视 `staleOf`、把降级改成丢弃、把 needs 塞回草稿、
  去掉超龄判断、退回「only needs 也拼旁白」、删详情页说明、不再数超龄条数。

### Known

- `idleSec` 是「宿主最后一次写状态文件的时刻」，不是「问句发出的时刻」。
  对本例无偏差（`7710fbdb` 的 `eventAt` 与 `updatedAt` 同为 `2026-10-08T09:45:33.518Z`），
  但若宿主因元数据重写把 `updatedAt` 推到当下（`job-event-time.mjs` 头注释记过 27.8 天的案例），
  老化会偏晚。`scan-sessions.mjs` 的 `eventAt` 更准，但列表行目前传 `idleSec`。**未在本单修。**

## [Unreleased] - 2026-11-10（TUI 主屏重做：布局数学抽离 + 三段分区 + 空状态自证）

> 报告：`docs/research/2026-11-10-tui-implementation.md`（含真实 `--plain` 输出）。
> 规格来源：`docs/design/2026-11-05-tui-redesign-plan.md`（§2.4 草图 / §2.5 字段矩阵 /
> §2.6 空状态 / §九·二 三条裁决）。
> 负向验证：`scripts/verify-tui-negatives.mjs`，**11/11 处回退都让预期测试变红**。
>
> **测试基线**：`node --test scripts/*.test.mjs` → **700 / 700 全绿**（基线 588，新增 112）。
> `node scripts/check-structure.mjs` → 通过。
>
> **边界**：未碰 git；未改 `scripts/verify-claims.mjs`、`scripts/asked.mjs`、`scripts/watch.mjs`
> （只 import 它们的导出）。

### Added

- **`scripts/tui-layout.mjs`（新文件）：列表页的布局数学，全部是零依赖纯函数。**
  旧实现的宽度、列宽、降级、视口全写在 `oversight-tui.mjs` 的 `buildFrame()` 里，
  「76 列下这一行有多宽」只能靠人眼看，**无法单测**。现在抽出 `fmtSpan` / `truncateWithDisclosure` /
  `layoutRow` / `windowOf` / `resolveLayout` / `binaryOf` / `partitionRows` / `checklistRows` /
  `composeListScreen` 等 20 个导出，配 61 条单元测试。

- **`scripts/tui-meta.mjs`（新文件）：标题与「近」列的有界读取。**
  transcript 的 `custom-title` / `agent-name`（128 KB 尾部只读）+ 末条 assistant 文本 +
  「末条是不是一个没人回的问句」。按 `(路径, mtime)` 缓存，8 秒轮询下未改动的文件零成本。
  读不到就返回 `null`，不拿目录名伪装成标题。

- **`scripts/tui-theme.mjs` 新增二值状态表 `BINARY`**：彩色下四类共用 `•`（颜色承载语义），
  无色下切 `• ! ? × ◦`（形状承载语义）。`blocked` 用蓝色不用红色 —— 「被挡住」不是「坏了」。

- **`scripts/oversight-tui.mjs` 新增导出**：`viewOf`（字段矩阵的唯一入口，拿不到的字段画不上屏）、
  `buildSections` / `actionViewOf` / `askedCountOf` / `waitingCountOf` / `claimsTally` /
  `scanAgeText` / `defaultClaimsScan`。

- 新增键位：`h` 展开/收起已停段、`d` 证据面板、`i` 详情页内部量。

### Changed

- **主屏重排为 L0–L4 五层**：判决行（`N 件在等你` 在最前）→ 检查表 4 行 → 需动作段 →
  在跑段 → 已停段（压成一行）。第 1 行是判词不是计数；最后一行是健康度不是键位提示。
- **列表页只说「在跑 / 已停」**，六态名不再出现在主屏。`PRODUCING` 与 `EXPLORING` 的处置
  都是「不干预」，并排展示等于告诉用户「29 条都要关注」。
- **`reason` 列从主屏删除**；`novelty` / `calls` / `liveness` / `hbThresholdSec` /
  `lastGapSec` / `tokens` 下沉到详情页的 `i` 高级区。详情页的子 agent 从 51 行压成一行计数。
- **选中不再用反显**（SGR 7）：改为 `❯` + 绿色，与严重度的状态字形/颜色分属两条视觉通道。
- **空状态分四态**：首扫中 / 扫完确实没事 / 扫完但监视没跑 / 扫描失败。
  第三态把「先修监视」放进第一屏，**且不替换会话列表**。
- **`--plain` 与交互屏同源**：都走 `buildSections()` + `composeListScreen()`，
  差别只在宽度固定 200、无光标。纯文本路径也会并行读宿主事实与 `verify-claims`。

### Fixed

- **D1 复现并修复：`liveToRow` 只切 `/` 不切 `\`**，Windows 上 `project` 变成完整路径
  （`base.split(/[\/]/)`）。最该被看见的那几类（WAITING/BLOCKED/FAILED 且无 transcript）
  恰好走这条路。改为切两个分隔符，并保留原始 `cwd` 供列表页显示 `…/尾两段`。
- **`fmtSpan(null)` 曾返回 `0s`**（`Number(null) === 0`）——没有 `idleSec` 的行会被画成
  「0 秒前」，这是撒谎。现在显式返回 `n/a`。
- **检查表备注列被截成 `d …`**：`d 看证据` 是该行唯一可执行的提示。备注列 14 → 20 列。
- **`app-router.test.mjs` 夹具过时**：主屏改三段后 `live: []` 让 PRODUCING 落进已停段并被折叠。
  该文件测键位路由，夹具补上 `live` 即可（已在测试里写清理由，不是放宽断言）。

---

## [Unreleased] - 2026-11-10（时钟注入不彻底 + 跨层去重至今没统一）

> 报告：`docs/research/2026-11-05-fix-clock-and-crosslayer-dedup.md`（诊断在前一份
> `2026-11-05-dedup-test-failure.md`）。负向验证：`scripts/verify-bugfix-negatives.mjs`
> 新增 5 项回退，实测 **18/18 处回退都让预期测试变红**。
>
> **测试基线**：`node --test scripts/*.test.mjs` → **588 / 588 全绿**（修复前 582/1 红）。
> `node scripts/check-structure.mjs` → 通过。
>
> **边界**：未碰 git；未改 `scripts/verify-claims.mjs`、`scripts/asked.mjs`、
> `scripts/oversight-tui.mjs`、`scripts/tui-theme.mjs`。

### Fixed

- **时钟注入不彻底：`loadState` 写死 `Date.now()` 剪去重表，导致一条测试定时翻红。**
  `watch.mjs:371` 的 `pruneNotified(state.notified, Date.now())` 无视调用方可注入的时钟，
  而 `loadState` 是 `runTick` 的必经路径。测试锚点 `2026-11-08T20:10Z` 距真实时钟超过
  `NOTIFIED_TTL_HOURS = 24` 之后，tick 2 一进来就把去重条目剪掉，同一次等待被当成新边沿
  再发一条。**这不是引入时就红，是时钟走过了 TTL 才红**——实测翻红边界精确在「锚点 + 24h」。
  修法：`loadState` 接受 `{ nowMs }`，`pruneNotified(state.notified, nowMs)`，`runTick` 传下去；
  测试读 state 时也传 `nowMs`（它是一处合法调用，只是此前函数不接受这个参数）。
  顺带删掉 `probeMtime` 里一行从未使用、却绕过注入时钟契约的 `const now = Date.now()`。

- **`scan-sessions.mjs` 子进程自取挂钟，与 `runTick` 的注入时钟打架。** 新增 `--now <ISO>`
  参数，`runScan({ nowMs })` 自动透传；`judgeState` / `idleSec` / `--days` 窗口 / `mergeJobRows`
  全部改用这一个「现在」。不传时行为与以前完全一致。

- **跨层去重至今没统一：同一次等待由 sessions 与 scan 两条路径各发一条。**
  两路对同一次等待算出不同的键：sessions 侧退化成 `host:<statusUpdatedAt>`（状态最后一次
  变化时刻），scan 侧退化成 `lastActivity` 的数字位后 10 位（会话最后一次活动时刻）。
  生产 `state.json` 里可确认 **3 对**「同一会话、两个键、两次实际发送」
  （`f932d1d4` 间隔 17.7 分钟、`a80c452d` 13.4 分钟、`356e31e9` 88.9 分钟）。
  修法分三处，缺一不可：
  1. `scan-sessions.mjs` 新增 `hostFieldsOf()`，把 `sessions/*.json` 的
     `waitingFor` / `statusUpdatedAt` 带进行上（以前**只有 `live[]` 有，`sessions[]` 没有**，
     所以 `candidatesFromScan` 的退化分支在现状下是死代码）；
  2. 宿主终态的事件时刻解析抽成 `scripts/job-event-time.mjs`，`probeJobs`（jobs 源）
     与 `scan-sessions` 的 `scanCrossLayerFingerprint`（scan 源）**共用同一个解析器**，
     于是 FAILED / BLOCKED 两路都得出 `job:<事件时刻>`；
  3. `candidatesFromScan` 优先透传扫描行自带的 `job:` / `wait:` 指纹，且 **只认这两个前缀**——
     WAITING 的锚点只能由它一处决定（`wait:<tool_use_id>`，退化 `host:<ts>`），
     否则「两处都有指纹」会把分叉伪装成已统一。
  实测（真实生产 transcript + 真实 `sessions/*.json`）：`f932d1d4` 与 `a80c452d`
  两路键均 **equal=true**；改动前旧算法对同一对数据算出两个不同的键。

### Changed

- **`candidatesFromScan` 的 `evidenceFingerprint` 语义改变**：从「`lastActivity` 的数字位后 10 位」
  改成带语义前缀的三种形态（`job:` / `wait:` / `host:` / `activity:`）。旧形态的问题是
  它**没有任何语义**：看上去像「事件时刻」，实际上是「会话最后一次活动的毫秒数后 5 位」，
  连截断都丢了年份。前缀让观察日志能直接分辨退化来源（`anchorSource` 同步给出）。

- **`jobToRow` 增加 `eventAt` / `eventSource` / `eventWhy` / `evidenceFingerprint` / `anchorSource`。**
  以前 `lastActivity` 用的是 `updatedAt`（文件重写时刻，宿主任意一次元数据写入都会把它推到当下，
  实测差 27.8 天），现在事件时刻单独成字段，不再借用 `lastActivity`。

- **测试标题更正**：`L-fast 与 L-full 报同一事件时只发一条 —— 但挡住第二条的是限额，不是键相等`
  改为 `jobs 与 scan 报同一事件时只发一条 —— 现在靠键相等，不再靠限额`。
  原断言 `why === 'global-10min'` 按预期变红（键统一后第二条在轮内去重阶段就消失），
  新断言钉住更强的事实：`suppressed.length === 0`。

### Added

- **防定时炸弹测试**：锚点放到十年后（`2036-06-01`）跑同一 WAITING 跨 tick 场景，必须仍然只发一条。
  它的职责是「有没有别的挂钟泄漏在 tick 之间偷偷改动去重状态」，**挡不住**「把 `Date.now()` 装回
  `loadState`」（未来锚点用真实时钟剪不掉）——那件事由上一条 `loadState 必须用注入的 nowMs 剪枝`
  负责。两条分工写进了测试注释。

- `scripts/job-event-time.mjs`：`requestIdTime` / `lastTimelineStateTime` / `resolveJobEventTime`
  从 `watch.mjs` 抽出，成为 jobs 源与 scan 源的唯一实现。`watch.mjs` 仍原样转出，公开 API 不变。



> 报告：`docs/research/2026-11-05-tui-bugfixes.md`。六个缺陷全部由多个 Agent 独立实测确认，
> 修法以「负向可验证」为门槛：`scripts/verify-bugfix-negatives.mjs` 把每处修复回退一次，
> 对应测试必须变红。实测 **13/13 处回退都挡住了**。
>
> **边界**：不重做视觉设计，只修 bug。`scripts/verify-claims.mjs` 与 `scripts/asked.mjs` 未触碰。

### Fixed

- **Bug1 `--days` 按文件 mtime 过滤，时间窗口完全失真。** 宿主会往 transcript 尾部追加
  不含 timestamp 的元数据记录（`last-prompt` / `custom-title` / `mode` / `cost-state` /
  `atis-latch` …），每次刷新文件 mtime，但会话一步都没走。实测本机 241 个 transcript 里
  **122 个**的 mtime 与最后一条真实记录相差超过 24h，最大 8.4 倍（mtime 194.7h vs 内部
  1637.9h）。现在窗口判据改为 `scan-sessions.mjs` 新增的 `lastActivityOf()`：从尾部找第一条
  带 `timestamp` 的记录。整份文件无 timestamp 时返回 `null` 并计入 `stats.transcriptsUnknownTime`，
  **不假装知道**。
- **Bug2 `displayWidth` 宽度表错误。** 旧表手抄 20 段 W/F，Unicode 18.0 有 **298 段**；
  没有 grapheme 聚类，`👍🏻` 被量成 4 列。实测 10 个代表性字符（`⚓ ⚪ 🟡 🟢 🟣 ✅ ⚡ ⌚ × ▲`）
  **错 8 个**，修复后 **0 个**。现在宽度表由新增的 `scripts/gen-width-table.mjs` 从
  `scripts/data/EastAsianWidth.txt` + `scripts/data/emoji-data.txt`（Unicode 18.0 原文件）
  生成到 `scripts/width-table.mjs`（EAW-W/F 298 段→合并 126 段，183,866 码点；
  Emoji_Presentation 302 段→80 段，其中 26 个码点是 EAW 未覆盖、由 emoji 表补上的）。
  聚类用 Node 内置 `Intl.Segmenter`，零依赖不变。
  `truncateToWidth` 的 O(n²) 一并修掉：6400 字 **321ms/call → 8ms/call**
  （实现搬到 `tui-theme.truncateDisplay`，按 grapheme 簇累加；`oversight-tui.truncateToWidth`
  只转发，避免出现第二份宽度规则）。
- **Bug3 光标用下标而非 ID，会复制错人的草稿。** 列表每次刷新按 idle 重排，下标的含义会变：
  实测 8 秒轮询下排序从 `[b,a]` 变 `[a,b]` 后，下标 0 指向了另一条会话，按 `c` 复制到的是
  别人的接力草稿。现在 `App` 记录 `selectedId`（`sessionKey`：sessionId > hostSessionId >
  transcriptId > project），渲染与复制都按 ID 反查位置。会话消失时重新锚定到合法行并保证
  「高亮行 == 复制对象」。
- **Bug4 两个 blocked 会话在主屏完全不可见。** `7710fbdb`（等 32 天）**全盘无 transcript**，
  任何 `--days` 都扫不到；`a9fa4c62`（503）的 transcript 存在但 mtime 被窗口挡住，且行里的
  sessionId 是 `af6779f8` 而非宿主 id。现在行的全集来自**三个来源的并集**：
  `sessions`（transcript 重建）+ `live`（宿主实时状态）+ `jobs/*/state.json`（宿主 job）。
  去重按身份集合求并集（处理 a9fa4c62↔af6779f8 这类别名）。新增 `--all` / `--days 0`
  表示不限窗口，且状态行主动说出「另有 N 个在窗口外」。
- **Bug5 `WAITING` 没有颜色。** `badge('WAITING', true)` 返回 **0 个 ESC**——SGR 表缺
  `brightYellow`，`paint()` 静默降级。这是「此刻正在等你」的状态，最该亮的一个。补齐
  8 色 + 8 亮色，并让 `paint()` 遇到未定义色名**记录 + 告警**（`unknownColors()` /
  `setColorWarn()`），不再沉默。
- **Bug6 「无异常」吞掉「没数据」。** `counts || '无异常'` 把「真的 0 个会话」和「扫到 2 个
  但一个都没认出来」印成同一个词。现在两种情况分别由 `emptyLines()` 与状态行说明，
  且「没事」必须自证：检查了多少 transcript / 多少 job / 窗口多大 / 数据多新。

### Added

- `scripts/gen-width-table.mjs` + `scripts/data/{EastAsianWidth,emoji-data}.txt`：
  宽度表的生成器与官方数据源，`--check` 校验表与数据一致（手改 `width-table.mjs` 会变红）。
- `scripts/tui-bugfixes.test.mjs`（38 条）：六个 bug 的正向 + 负向测试。
  宽度期望值从 Unicode 原始数据现算，不用自算基准。
- `scripts/verify-bugfix-negatives.mjs`：13 处回退的自动化负向验证。

### Changed

- `scan-sessions.mjs --json` 新增 `stats`（扫描覆盖度：看过多少 transcript、窗口内外各多少、
  时间未知多少、job 补入多少）与每行的 `source` / `hasTranscript` / `hostSessionId` /
  `transcriptId` / `lastCallAt`。`done` / `stopped` 的 job 不补入列表（无行动价值）。



> 注：本节日期取任务指定的报告落款日（`docs/research/2026-11-05-verify-claims-productization.md`），
> 与下方 2026-11-09 节**不是按日期倒序** —— 放在顶部是因为它是最近一次改动的入口。
> 二者互不影响：11-09 节改的是通知系统（`watch.mjs`），本节只动 `verify-claims.mjs`。

> 四份独立调研指向同一结论：本仓库唯一站得住的差异是 `scripts/verify-claims.mjs`
> （断言 vs 证据核对），其余能力官方 `claude agents` 与开源生态已覆盖。
> 这个脚本能跑，但**不是能用的产品**：`--help` 会直接开始扫描，没有单会话模式，
> 退出码恒为 0，输出只有统计报表没有人能照着做的下一步。
> 报告与真实输出：`docs/research/2026-11-05-verify-claims-productization.md`。
>
> **边界**：只做「让人能用」，不做「让它更准」。判定逻辑一个字没动 ——
> 同一时刻用 `git show HEAD:scripts/verify-claims.mjs` 与新版各跑一次全量，
> 逐条比对 38 条断言的 status，**0 处差异**。

### Added

- **`--help` / `-h`：真实帮助，且不扫描。** 旧版 `--help` 落到 `parseArgs` 里无人认领，
  直接开始 5 秒全量扫描；用户想找参数只能读源码。帮助文本是常量 `HELP_TEXT`，
  含六档语义、全部参数、退出码、JSON 结构。实测 `node --help` 只花进程启动时间，不读 transcript。
- **`--session <id前缀|路径>`：单会话模式。** 这是最缺的一条 —— 定位到一个可疑会话后，
  想再确认只能重扫全部 240 个（5 秒）。前缀 ≥4 字符、必须**唯一命中**，歧义时列候选并退 2，
  绝不替你瞎选。实测 8.46 MB 的会话 546 ms，全量 5.1 秒。
- **退出码语义**：`0` = 无 `NO_EVIDENCE`/`FAILED_ONLY`；`1` = 有；`2` = 用法错误。
  `UNKNOWN` **不算失败** —— 截断导致读不到，不等于它没做，把它当失败就是在制造假阳性。
  `--exit-zero` 可强制 0。这样它能直接进 CI / git hook。
- **`--explain <n>`**：第 n 条断言的完整来龙去脉（原话、判定、理由、命中的每条命令及其钟点、
  最后一次源码编辑位置、计数、建议）。
- **`--verbose`**：连 `SUPPORTED` 一起列。命中调用多于 8 次时只列失败项与最后 5 次，
  避免一屏刷满（一个构建族常有 24 次调用）。
- **`--format md`**：markdown 表格，直接贴 PR 评论。
- **输出重写**：从「统计报表」改成「告警块」——
  `<图标> <项目> · <短id>` / `AI 说：「原话」` / `证据：…` / `判定：…` / `建议：…`。
  证据行说人话（「最后一次源码编辑在 10-19 01:35，之后没再测试运行过」），
  建议是可执行的（「重跑 npm test 确认；若确实在子 agent 里跑过，加 --include-subagents 再查一次」）。
  统计压到最后三行。
- **`timeline`**：`scanSession` 的每条结果多一个 `timeline`（最后一次编辑/成功/失败的时刻与路径）。
  **只供渲染**，判定仍只看记录下标顺序，不看时间戳。同一秒时不许假装分得出先后。
- 新导出 17 个（`parseArgs`、`resolveSession`、`exitCodeFor`、`evidenceSentence`、`adviceFor`、
  `renderSessionBlock`、`renderMarkdown`、`renderDetail`、`renderSummary`、`fmtClock`、
  `verdictIcon`、`evidenceTimeline`、`timeOf`、`attemptTimes`、`attemptTime`、`flattenResults`、
  `HELP_TEXT`/`ALERT_STATUS`），全部登记进 `scripts/check-structure.mjs` 的探针表并实际调用。

### Fixed

- **`UNKNOWN` 的证据行会说谎。** 三个来源（截断 / 命令被转后台 / 子 agent 有可疑证据）
  原先在渲染层可能被一律说成「更早的部分没读到」。后台执行与截断的补救方式完全不同
  （前者要前台重跑拿退出码，后者要读更多），说错来源会让用户照着做然后什么都没变。
  现在证据行与建议都按 `reason` 分流。
- **跨天时间显示踩坑。** 一个会话可横跨数天，只印 `HH:MM:SS` 会让「08:43 成功、
  之后 22:36 失败」看起来像同一天里倒退。`fmtClock` 现在同日只给钟点、跨天带 `MM-DD`。

### 验证

- `node scripts/check-structure.mjs` 通过。
- `node --test scripts/*.test.mjs` **545 条全绿**（基线 508 + 新增 37）。
  `verify-claims.test.mjs` 自身从 79 条增至 116 条（+37）。
- **五项负向实验**（关掉功能，测试必须变红，均已实测）：
  1. 短路掉 `--help` 的 early return → 2 条红；
  2. `exitCodeFor` 改成恒 `0` → 3 条红；
  3. 忽略 `--session` 退化成全量扫描 → 2 条红；
  4. 渲染层把 `UNKNOWN` 改写成 `NO_EVIDENCE` → 1 条红；
  5. 渲染层把三种 `UNKNOWN` 来源压成一句话 → 2 条红。

---

## [Unreleased] - 2026-11-09（通知系统三个已确诊缺陷：噪声桶、去重键恒等、`lastSeenAt` 不刷新）

> 用户原话：「先修目前的漏洞」。三个缺陷都已由多个 Agent 独立实测确认，数字是真的。
> 验收标准先于实现写成：`docs/spec/2026-11-04-notify-fix-acceptance.md`（526 行）。
> 完整取证与负向实验记录：`docs/research/2026-11-04-fix-notify-dedup.md`。

### Fixed

- **`permission prompt` 是噪声桶，不再产生通知（但照样写观察记录）。**
  实测（n=75 个宿主翻转事件）`waitingFor === 'input needed'` 9/9 = 100% 真、
  `'permission prompt'` 66/66 = 0% 真。根因是 `requires_action` 一律映射成 `waiting`，
  只有 `AskUserQuestion` 才写 `input needed`，其余全塞进 `permission prompt` 兜底桶
  （66 个里 46 个卡在会话自己写的 `Bash(sleep 840~900)` 上）。
  位置：`scripts/watch.mjs` `dispatchCandidates` 开头。判据同时看 `waitingFor` 与 `reason`
  —— `scan-sessions --json` 的 `sessions[]` 没有 `waitingFor` 字段，只看前者会让这道门
  在 scan 路径上失效，而 67/72 条记录来自那条路。`input needed` 链路一个字未动。
  观测记录保留（`why: 'noise-bucket-permission-prompt'`），因为删掉状态就无法验证
  误报真的消失，也答不出宿主多久这样一次。

- **去重键：WAITING 改用 transcript 里未闭合的等待型 `tool_use_id` 作锚点。**
  修复前 `probeWaiting` 与 `probeJobs` 的指纹恒为空串，而 `reasonClass` 把
  `waiting:input needed` / `waiting:permission prompt` 压成同一个 `waiting` ——
  同一会话的多次等待共用一个键。实测 `<session-S>` 一个键吞掉 11-08 的 **4 次真实等待**，
  `watch.log` 连续 **2213 个 tick（585 分钟）`already=1`**（全日志 `already=1` 共 5413 次）。
  位置：新增 `classify-stop.mjs` 的 `openWaitingToolUseIds()` + `watch.mjs` 的 `waitingAnchor()`；
  `probeWaiting` / `candidatesFromScan` / `probeJobs` 三处产键点统一走它。
  **不用 `statusUpdatedAt` 单独当键**：实测它在 waiting 期间只写一次、18 分钟不动
  （`watch.mjs` 的 `docs/research/2026-11-04-dedup-key-analysis.md` §4.2），
  用它 = 一次等待只值一个键 = 保留今天这种永久静默；它只作取不到 transcript 时的退化值，
  且带 `host:` 前缀、候选上标 `anchorSource`，让覆盖率可统计。

- **`lastSeenAt` 正常刷新，TTL 改按 `lastSeenAt` 计时。**
  实测 72/72（现场取证 73/73）条记录 `lastSeenAt === firstSeenAt`，而 `pruneNotified`
  从 `firstSeenAt` 算 24h TTL —— 一次持续超过 24h 的等待会在第 25 小时被清掉，
  然后**同一个等待被重新通知一次**。位置：`dispatchCandidates` 命中路径 + `pruneNotified`。
  两处必须一起改：只刷新不算 lastSeenAt、只改 TTL 而不刷新，都修不好。

### Added

- **负向测试 11 条**（`scripts/watch.test.mjs` 末尾「通知修复」段）。当前套件对
  「同一次等待跨路径同键」「不同次等待不同键」这两条核心性质**零覆盖** ——
  把 scan 指纹改成空串，修复前的 497 条依然全绿。新增用例逐个做了变异验证：
  把 bug 装回去时**必然变红**，6 个变异的红/绿记录见研究报告 §3。
- `scripts/check-structure.mjs` 的 `PROBE_ARGS` 登记 `openWaitingToolUseIds` / `waitingAnchor`，
  于是「导出但调用即炸」在这道门就会暴露。

### Changed

- **修掉一条说谎的测试**：`watch.test.mjs` 原「L-fast 与 L-full 报同一事件时只发一条
  （三层共享去重）」——实测挡住第二条的是 `GLOBAL_MIN_GAP=10min`（`canNotify`），
  两个键根本不相等。改名为「……但挡住第二条的是限额，不是键相等」，并加断言
  `suppressed[0].why === 'global-10min'` 把真实机制钉住；另补一条真正测去重的用例
  （跨 11 分钟两个 tick、每轮清空额度，只发一条）。

### 测试数字

508 条全绿（基线 497 + 新增 11）。`check-structure.mjs` 现已全绿。

**关于硬门那 1 项既有违规的处置（不掩盖）**：本次改动**之前** `check-structure.mjs` 已报
`[docs/design/README.md] 2026-11-04-next-phase-plan.md 没有被索引提到`。验收标准
§5 第 1 条允许「让这一项消失或明确分账（既有的不许当作本次失败，也不许顺手改掉掩盖问题）」。
本次选择**让它消失**，动作只有一处：在 `docs/design/README.md` 的状态表里补一行
（标 `Proposed`、`零行实现`），与该文件的其它条目格式一致。
这不是「顺手改掉掩盖问题」——那份规划文档本来就该在索引里；不复述它的任何内容，
也不声称它被实现。记录在此，是为了让「谁在什么时候让这一项转绿」可查。

### 公开前的文档分拣（本批 13 份）

本批新增的研究与设计文档一并做了公开分拣，判定与逐份理由写在 `docs/PUBLISH-TRIAGE.md` §七。
三份直接公开（竞品、协议、编排模式调研，来源全为公开仓库与文档）；十份含本机标识，
把真实项目名、会话 ID、绝对路径、PID、MSIX 包哈希、临时目录名换成占位符——
**实测数字、阈值、结论一个字未改**。零份 PRIVATE：与上一批那五份宿主接口文档不同，
这批写的是本仓库自己的守护进程逻辑，不构成可执行攻击面。

其中 `docs/spec/2026-11-04-notify-fix-acceptance.md` 的改动以**它自己的 §7 修订节**形式追加，
因为该文件明令「事后改标准无效」；修订写明只换了示例取值、判定条款一字未动。

分拣清单本身也做了一次二次清理：它原先用「替换前」的原值来说明改了什么，
而那些原值正是被脱敏掉的东西，等于把泄漏在清单里又写了一遍。现在只写形态、不写取值。

---

## [Unreleased] - 2026-11-03（`verify-claims`：把「AI 说它做完了」做成可运行的判据，并修掉它自己的两处假阴性）

> 新增 `scripts/verify-claims.mjs`（+ `scripts/verify-claims.test.mjs`）：从 transcript 的
> tool_use/tool_result 里核「完成性断言有没有证据」。实测报告见
> `docs/research/2026-11-03-verify-claims.md`。此前同一天已落地过一版骨架（未在本文件记账，
> 今回溯补记），本轮补的是**真实测量 + 两个真 bug**。

### Added

- **`scripts/verify-claims.mjs`：三层纯函数。** `detectClaims` 从最后一条 assistant 文本认断言 →
  `findEvidence` 在记录里找该族的调用与退出码 → `classifyEvidence` 用「最后一次**源码**编辑」
  这条时间线判四档（`SUPPORTED` / `STALE_ONLY` / `FAILED_ONLY` / `NO_EVIDENCE` + `UNKNOWN`）。
  6 个可核对族（`test-count` / `build` / `commit` / `push-remote` / `pr-ci` / `file-count`），
  `todos` 等无证据源的族单列 `UNCHECKABLE`，**不混进四档比例**。
- **全量语料实测（228 个主 transcript / 1.58 GB）**：含可核对断言 25 个会话、31 条断言；
  四档 `SUPPORTED 26 / STALE_ONLY 1 / FAILED_ONLY 0 / NO_EVIDENCE 1 / UNKNOWN 3`。
  全量耗时 **2.9–5.6 s**，读盘 320 MB（约全量 20%）。需回溯的 25 个会话里 **0 个触到 24 MB 上限**
  —— 本语料没有一次「因为读不下去而可能漏证据」的截断。
- **`--include-subagents`**：子 agent 的证据只用来把 `NO_EVIDENCE` 降级成 `UNKNOWN`，
  **从不**升级成 `SUPPORTED` —— 子 agent 的调用不在主时间线上，无法确认它发生在编辑之后。

### Fixed（两处假阴性，都是实测出来的，都加了负向测试）

- **shell 编辑的 kind 恒为源码。** 旧代码
  `const k = /\.(?:[a-z0-9]+)\b/i.test(use.cmd) ? 'unknown' : 'code'` 两边都不返回 `'doc'`，
  而时间线判据是 `e.kind !== 'doc'` 才算源码改动 —— 于是 `cp *.jar backups/`、`cat > docs/x.md`
  这类写入会**作废掉之前的测试证据**。实测把 `bdf7a413`（`cp versions/*.jar`）和
  `9daa6a00`（编辑 `.gitignore`）两次真的 `SUPPORTED` 判成 `STALE_ONLY`。
  改法：按**实际写入目标**的扩展名定 kind（`shellEditKind`），并新增 `NON_SOURCE_FILES`
  把 `.gitignore` / `.gitattributes` 一类当文档；判不出来时按文档处理。
  负向测试：装回旧代码，4 条新测试变红。
- **`tests=29 failures=0` 被读成 29 个失败。** 旧 `FAIL_OUTPUT_RE`
  的 `\b[1-9]\d*\s+(?:failing|failed|failures?|errors?)\b` 命中了「29 failures」，
  让 `36b92630` 一次真的 `BUILD SUCCESS` 被记成失败调用；全语料 266 处、35 个会话受影响。
  改法：加否定前瞻 `(?![=:\s]*0\b)`。回归验证：丢掉 266 处匹配，**没有一处是真失败**。
  负向测试：删掉前瞻，2 条新测试变红。

### Changed

- **`scripts/check-structure.mjs`**：`NON_SOURCE_FILES` 登记进 `PROBE_ARGS` 的数据常量表，
  消除「导出未登记」提示。

### 与前序研究的对照（数字冲突，以本轮实测为准）

- `docs/research/2026-11-02-redteam-deterministic.md` §3.2 的「23 个 test-count 会话里
  **15 个完全无测试调用**」**今天复现不出来**。两处原因已定位：
  ① 该节脚本的测试命令正则是 `mvn\s+[^\n]*(test|verify)`，**匹配不到 `mvn.cmd`**（本机 Maven
  就是 `mvn.cmd`），只改这一处，`无任何测试调用` 从 **13 降到 9**，`证据充分` 从 **5 升到 9**；
  `db46051b` 有 2 次成功 `mvn.cmd … test`（`Tests run: 547, Failures: 0`）在最后一次编辑之后。
  ② 该节称那 15 个会话「全部为 0 个子 agent」，今天实测 `3b390f6e` 有 **51** 个、`84419879` 有 **36** 个。
  **旧数字错在测试命令正则，不在结论方向**：本轮唯一一条 `NO_EVIDENCE`（`3b390f6e`）
  经逐条核查确实只跑过 `mvn clean compile` 与 `mvn clean package -DskipTests`，`Tests run:` 出现 0 次，
  该判为真。

### 精度（诚实标注）

- 人工抽检 13 条（全部非 `SUPPORTED` + 每族至少 1 条 `SUPPORTED`），回到原始输出逐条裁决：
  **11 对 2 错，精度约 84.6%**（样本小，只能当量级）。
  两条错：`64460e7d` 的 `STALE_ONLY` 假阳性（临时脚手架目录 `_backup-extract/*.mjs` 被当源码改动 +
  跨仓库比较）；`3b390f6e` 的 `NO_EVIDENCE` 在 `--include-subagents` 后降级为 `UNKNOWN`。
- 已知未修局限（报告中 §4 全列）：断言只认最后一条文本、`file-count` 语义歧义、
  脚手架目录未排除、跨仓库串线、不核断言里的数量、`echo "EXIT=$?"` 拿到的是管道尾部命令的退出码。

---

## [Unreleased] - 2026-11-02（ASKED 误报：一个推断信号继承了宿主事实的门禁豁免）

> 承接 `docs/research/2026-11-02-false-positive-diagnosis.md` 的根因 B。同一天早上收到第二条
> 「❓ <project-B> · 问了没答」，而那个问句已经**静默 10.5 小时**，人早在同一项目的另一个会话里
> 用别的方式回应过了。两件事都要修：**判定缺现状对账** + **`ASKED` 被错误归进 `HOST_FACT_STATES`**。
> 修复说明见 `docs/research/2026-11-02-fix-asked.md`。

### Fixed（`ASKED` 从 `HOST_FACT_STATES` 移出：分类错误，不是阈值问题）

- **根因**：`scripts/watch.mjs` 的 `HOST_FACT_STATES` 是
  `['WAITING','BLOCKED','FAILED','ASKED']`，而紧邻注释写的是「**这三者**对分类门/时间门免疫」。
  `ASKED` 是后加进去的，加进去之后它**绕过了所有门禁**——分类门、时间门，以及此后加的任何一道。
  更糟的是观察日志把它标成 `"classify":"host"`：一个**从 transcript 文本推断出来**的信号
  （`asked.mjs` 文件头第一句就是「不依赖宿主」）被记成宿主写的结论，事后复盘也会被误导。
- **改法**：`HOST_FACT_STATES` 收窄为 `['WAITING','BLOCKED','FAILED']`，注释重写并写明判据：
  **这个结论是谁下的？** 宿主下的 → 进；我们从文本猜的 → 不进。`ASKED` 现在走和其它推断状态
  一样的路（分类器会判出 `ASKED_UNANSWERED`，那是 `NOTIFY_KINDS` 的一员），并在候选生成阶段
  先做「还值不值得提醒」的判定。
- **防复发**：新增 4 条测试，把 `ASKED` 加回数组会**4 条全红**（实测，见下）。

### Added（`asked.mjs` 的现状对账：三个可离线复算的判据）

诊断结论是「缺少『现在还值不值得提醒』的判断」。新增 `assessAsked()`，判定顺序有讲究：

1. **静默过久** `silent-too-long` —— 问句之后一直没动静超过 `ASKED_MAX_SILENCE_HOURS = 8`。
2. **会话自己继续过** `continued` —— 问句之后有带 `message` 的记录（`tool_use` / 后续输出）。
3. **同 cwd 别处已回应** `answered-elsewhere` —— 同项目另一个会话里，问句之后有真人说过话。
4. **宿主说已不在等** `host-not-idle` —— `sessions/*.json` 的 `status !== 'idle'`。
5. **idle 早于问句** `host-idle-before-question` —— 那次 idle 与这个问句无关。

第 1 条排在最前是有意的：它不依赖宿主、不依赖跨会话，**本次误报单独靠它就拦下了**。
排在后面的话，一条「宿主读不到 + 没有兄弟会话」的会话会绕过它。

- **为什么 24 小时不够**：`MAX_QUESTION_HOURS = 24` 是拿**回复延迟分布**标定的（p90 = 15.4h），
  回答的是「多久没答算积压」，不是「现在还值不值得打断人」。本次问句在 24h 窗口内（10.5h）。
- **8 小时怎么来的**（本机 241 个 transcript、**411 个问句结尾的 turn**，实测恢复间隔累计分布）：

  | 问句后到下一条记录的间隔 | ≤1h | ≤2h | ≤4h | **≤8h** | ≤12h | ≤24h |
  |---|---|---|---|---|---|---|
  | 累计占比 | 77% | 86% | 89% | **93%** | 95% | 100% |

  取 8h = 「93% 该恢复的都恢复了」那条线。**代价可量化**：同一组样本回推，8h 门槛会拦掉
  32/411 条（7.8%），其中 28 条后来确实被人回答——**主动选择漏报 6.8%，换取不再误报**。
  不取 12h/24h：本次问句静默了 10.5 小时，12h 拦不住它，24h 原样放过，等于没修。
- **跨会话证据的结构**：索引必须覆盖**全部**会话，不能只覆盖候选。误报里说话的那个会话
  （`<session-E>`）当时自己已经继续干活了，**根本不是候选**。为此 `scanAll` 分成两遍：
  第一遍读每份 transcript、登记真人消息、挑出候选；第二遍才做对账。
  单遍会有一个隐蔽 bug——**结果取决于目录遍历顺序**（测试当场抓到，见 `scanAll：跨会话证据与目录遍历顺序无关`）。
- **只索引时间戳，不留记录**：本机 transcript 合计 1.3 GB，单份最大 117 MB。
  `humanIndex` 只存 `{ at, text }`，记录在那一轮之后即可回收；结果对象里也剥掉 `records`。
  实测 `scanAll` 全量 **34 秒**（244 份）。
- **判「人话」不看文本**：`type === 'user'` 且 `origin.kind === 'human'`。用正则猜会把 `tool_result`
  也算成人话（它也是 `user` 记录），每一轮工具回执都变成「人类已答复」。
- **fail-open 的边界**：读不到宿主状态时**不因此拦截**（`host-unknown`），因为采集缺失不是证据。
  但静默门槛不依赖宿主，所以那种情况下它仍然生效。

### 实测（数字全部可复算）

- **修复前会报、修复后不报**：`<session-B>` 的问句是真的（`2026-11-01T23:31:45.824Z`），
  宿主 `statusUpdatedAt` 是 `23:31:46.007Z`（**晚 183 毫秒**——问完那一秒就 idle 了），
  之后只有一条 `+96ms` 的 `stop_hook_summary`（宿主簿记，**不算**会话继续），再无记录。
  10.5 小时后静默门槛拦下。修复前它进了通知。
- **同 cwd 的另一句话**：`<session-E>` 里真人在 `2026-11-01T19:38:45.566Z` 说过
  「你不需要提交，只需要将自己的工作全部做完」——在问句**之前** 3.9 小时，
  所以不算对这条问句的回应。但它证明了「单文件判定看不到这句话」这个结构问题：
  跨会话索引现在能看到它，只是时间戳判定为「不是回应」。
- **全量扫描**：本机 244 份 transcript、`found=0`，`skipped={greeting:3, tooRecent:1, tooOld:4}`。
- **测试**：`418/418`（基线 375）。本次新增 **33 条**（`asked.test.mjs` 38→68，+30；
  `watch.test.mjs` 新增 3 条 + 改写 1 条）。其余新增条目属 BLOCKED 那一阶段的改动。
  **负向验证**（两组，都实测跑过）：
  - 把 `ASKED` 加回 `HOST_FACT_STATES` → **4 条变红**（含 2 条防复发回归）。
  - 把 `ASKED_MAX_SILENCE_HOURS` 从 8 改成 24 → **5 条变红**，其中就是本次 bug 的核心用例。

---

> 承接 `docs/research/2026-11-02-false-positive-diagnosis.md` 的根因 A。用户当天早上收到一条
> 「⏸ <project-A> · 受阻 · idle=916m」，实际是 **27.8 天前**一次已死进程的 503。
> 诊断已把根因钉死，本阶段只做修复——**口径由用户指定：超过 7 天的 blocked 直接标过期，不再通知。**
> 修复说明见 `docs/research/2026-11-02-fix-blocked.md`。

### Fixed（`probeJobs` 的事件时刻：一个字段用错，编出一个精确的假数字）

- **根因**：`scripts/watch.mjs` 的 `probeJobs()` 拿 `job.updatedAt` 当「阻塞发生时刻」，并据此
  ①过 24 小时新鲜度门槛 ②算 `idleSec` 写进通知正文。`updatedAt` 是**文件元数据时间**：宿主启动、
  补写 `respawnFlags` / `name` / `providerEnv` 时会重写这个 json，把它刷到当下。
  实测 `~/.claude/jobs/<session-A>/state.json`：`state:"blocked"`，`detail` 里 request id 是
  `<request-id-1>`，`timeline.jsonl` 末条 `{"at":"2026-10-05T15:57:02.483Z","state":"blocked"}`，
  而 `updatedAt` 是 `2026-11-01T18:41:21.066Z`——**差 27.8 天**。`timeline.jsonl` 里 2026-11 的记录数 = 0。
- **改法**：新增 `resolveJobEventTime()`，按可靠性取事件时刻，**绝不退回 `updatedAt`**：
  1. `timeline.jsonl` 末条**同状态**记录的 `at`（宿主自己的事件流水，最强证据）
  2. `detail`/`needs` 里 request id 的时间戳（由那次错误本身携带，重写记录不会改它）
  3. `firstTerminalAt`（只在前两者都没有时兜底，且它偏旧，只会让判过期更保守）
  两者都可用时**取更旧的**——都是真实事件时刻，更旧的离现在更远，按它判过期只会少发不会多发。
- **7 天过期规则**：`BLOCKED_MAX_AGE = 7 * DAY`（用户指定）。超过即不产生候选，并写一行
  `blocked-expired: <jobId> age=27.8d source=<timeline|request-id|first-terminal>`。
  日志**按 job × 事件时刻进程级去重**：L-fast 是 15 秒一层，20 个旧 job 每轮各写一行会把
  1 MiB 日志在半分钟内转掉（DF-021 那类事故）。`FAILED` 沿用原 24 小时口径，未改。
- **编造的时长**：`idleSec` 改从事件时刻算。`describe()` 里短时长仍是 `idle=42m`，
  超过 90 分钟改用天（`idle=27.8 天`），jobs 候选额外带 `事件 2026-10-05 15:57Z`，让人当场能核对。
- **fail-closed**：三个时间源都拿不到时**不通知**，记 `blocked-undated: <jobId> why=no-event-time`。
  宁可漏报一条无法定时的旧记录，也不把重写时刻当事件时刻。
- **时钟可注入**：`probeJobs(jobsRoot, { nowMs, blockedMaxAge })`——`blockedMaxAge` 可注入，
  测试用固定时钟（`Date.parse('2026-11-02T10:00:00.000Z')`）复现原 bug 现场。

### 实测（数字全部可复算）

- **本机 19 个 job 目录**（`~/.claude/jobs/`）：修复后 `found=0 expired=2 undated=0`。
  `<session-A>` 由 `request-id` 判出 **28.77 天**，`<session-H>` 由 `timeline` 判出 **26.03 天**。
  旧实现把 `<session-A>` 报成 15.3 小时并通知；现在不通知。
- **成本**：`probeJobs` 热态 **14.6–15.3 ms**（5 次），修前约 12 ms。多出的 3 ms 来自 19 个
  `timeline.jsonl` 的尾部读（单个 0.34–6.42 ms，合计 43.6 ms 冷缓存 / 15 ms 热态）。
  L-fast 是 15 秒一层，每天多付约 17 秒 CPU（0.02% 单核）。
- **`timeline.jsonl` 大小**：本机最长 141 KB（`<job-E>`），尾部预算 256 KB 覆盖全部，
  实测 0 次截断——但截断分支仍然实现并 fail-closed，因为别的机器不一定这么小。
- **测试**：`385/385`（基线 375 + 新增 10）。**负向验证**：把判定行换回
  `Date.parse(job.updatedAt …)`，10 条测试变红，其中 7 条是本次新增的 BLOCKED 用例。

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
  `--project <project-E>` 均 60s 超时（exit 124）。README 的 30 秒上手命令直接挂住——产品唯一的
  「眼睛」在真实数据上不可用。
  改为手写线性状态机 `stripLongStrings()`，O(n)：病态输入 0.3–4.2ms，`--days 3` 全量扫描 13s。
  回归测试「归一化在病态输入上是线性的」保留在 `state-model.test.mjs`。
- **DF-002：休眠会话被误判为 FAILED**。实测反例 `[FAILED] Projects/<project-C> ... hb=515s/120s idle=72.3h`：
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
  3220 个 jsonl 中 **1190 个**在 `subagents/workflows/<wf-id>/` 下。会话 `<session-P>` 报 `sub=28`，
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
  「在等什么」与「建议怎么回」（实测原文：「要我现在就把用户回执交给你，还是你先看这四份报告？」
  /「把回执发给我」）。Relay Agent 不必从零发明草稿，只需**补全 + 结构化**宿主已有的半成品。
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

### Added（ASKED 接进 watch.mjs 轮询）

`asked.mjs` 不再只能手动跑——它现在是 `watch.mjs` 的一层，会自己提醒。

**成本决定了放哪一层。** 实测全量扫描 **18.9 秒**（171 个 transcript），
**绝不能放进 L-fast**（60 秒一次）。放在 L-mid（5 分钟），且**只在项目 mtime 变了、
或从没扫过时才跑**——`probeMtime` 只要 60ms 而且已经算好了 `changed`，直接复用，
没有变化时这一层成本为 0。

**识别与去重**：`ASKED` 与 `WAITING` 分开，因为前者是**从 transcript 看出来的**
（最后一条 assistant 是问句），宿主不报的场景也能覆盖。
`evidenceFingerprint` 用**问题文本**而非时间——时间每轮都在走，会让去重失效。

**额度必须分开。** 实测一次 asked 扫描产出 5 条，而全局上限是 8 条/24h——
这批一进来就把当天额度吃掉大半，之后真正的 `FAILED` 反而发不出去。
不调高全局上限（那会变吵），而是给 ASKED **独立额度**：6 条/24h + 最小间隔 30 分钟。
两边互不挤占，测试里双向验证过。

**端到端实测**：

```
notified ASKED <project-B> ... candidates=5 sent=1 suppressed=4 observed=5(ASKED:5)
```

5 个候选，发 1 条，4 条被 30 分钟间隔正确地压后。

**跑起来才发现的两个 bug**：
- `sessionId` 成了**完整绝对路径**——`split(/[\/]/)` 匹配不到单个反斜杠，
  通知里直接泄露出本机路径。改用 `sessionIdOf`（`lastIndexOf` 剥离目录）。
- 项目名是完整 slug（`<project-B-slug>`），标题撑爆。
  取最后一段。

**变异验证**：去掉独立额度 → 2 红；指纹换成时间 → 1 红；去掉 ASKED 标题 → 1 红；
`sessionId` 回到 split 写法 → 1 红。

### Fixed（历史把「历史积压」算成「待回答」）

- **症状**：`asked --history` 报「累计 5 条问题，已回答 0 条 · 仍待回答 5 条」。
  但那些问题最早的是 **21 天前**的，所在会话早就不动了——**永远不会有人回答**。
  这个数字永远难看，而它不反映系统好坏，只反映「仓库里有多少历史遗留」。
- **根因**：首轮扫描把历史积压一次性收进来，都当成「新发现」。
- **修法**：首次见到一个**已经很老**的问题时标为 `backlog`，不计入「待回答」统计。
  它们仍出现在 `asked.mjs` 的输出里（确实没答），只是不进历史的分母。

**阈值是 24 小时，不是拍脑袋**：实测 492 个真实问答对，回复延迟 **p90 = 14.7h、99% 在 24 小时内**。
初版写 48，实测发现 44 小时的问题仍被算作「待回答」——那已越过 p99 一倍，显然不是在等。

**跑出来的结果**：4 条全部判为积压，**当前 0 条活跃待答**。这才是真实状态。

**顺带修的两处**：
- 文案里硬编码「48 小时」，改阈值后对不上。现在引用 `st.backlogHours`（来自常量）。
- 积压条目不参与「已回答」判定——它们对应的会话早已结束，「没再扫到」是常态。

**变异验证**：阈值改回 48 → 1 红；积压不跳过回答判定 → 1 红；`pending` 用全部条目而非非积压 → 1 红。

### Fixed（`stripLongStrings` 是 O(n²)，真实语料里最慢单条 11.3ms）

- **症状**：`scan-sessions` 处理 52,309 条真实 Bash 命令要 5.9 秒，最慢一条
  **11.3ms 处理 207 字符**——短命令却极慢。
- **根因**：`stripLongStrings` 用 `out += ch` 逐字符拼接。V8 里每次 `+=` 都可能重新分配，
  是 **O(n²)**。不是正则回溯（那是另一个已修的老问题，见 DF-001）。
- **修法**：改数组 + `join`，并把连续的非引号字符攒起来一次性 push。
- **实测**：同一批 52,309 条命令 **5,894ms → 1,957ms**，平均 0.113ms → **0.037ms**。
- **行为一致性验证**：新旧实现对全部 52,329 条真实命令逐条对比，**差异 0 条**。
- **回归测试**：用「32 倍长度耗时不该超 6 倍」守线性——长字符串被整体替换成 `<str>`，
  不逐字符复制，实测 200 与 6400 字符耗时比值约 0.8。
  变异（退回 `+=`）→ **3 条测试红**。

### Fixed（子 agent 每个读 4MB，导致扫描要 40 秒）

- **实测 A/B**：`--days 3` 扫描，**旧版 41–44 秒，新版 23 秒**（快 45%）。
  之前记的「28 秒」是缓存热时的数字，不可靠；这个对比是同机连续跑出来的。
- **根因**：`parseJsonl` 对每个文件都用 4MB 上限读尾部。主 transcript 需要这个，
  但**子 agent 文件不需要**——它们只贡献最近 `MAX_CALLS_PER_SESSION`（400）条调用。
  实测语料：主 transcript 1.2GB，**子 agent 5.2GB / 3518 个文件**，
  每会话最多展开 100 个 → 最坏情况每会话读 **400MB**。
- **修法**：`parseJsonl(path, maxBytes)` 接受上限参数；子 agent 用 `SUBAGENT_READ_BYTES = 512KB`。
  512KB 实测能覆盖远超 400 条记录。
- **一致性验证**：新旧版对 32 个会话逐一对比，**状态差异 0**。
- **回归测试**用 `parseJsonl` 真实函数（不是复制逻辑）：造一个 >512KB 文件，
  断言 512KB 读到 ≥400 条、少于 4MB 读到的条数、且截断首行不算坏行。
  变异（512KB → 16KB）→ 1 红。

### 顺带修的（`stripLongStrings` O(n²)）

- 真实语料 52,309 条 Bash 命令，最慢一条 **11.3ms 处理 207 字符**——短命令却极慢。
  根因是 `out += ch` 逐字符拼接的 O(n²)，不是正则回溯。
- 改数组 + join 后同一批 **5,894ms → 1,957ms**，平均 0.113ms → 0.037ms。
- **52,329 条真实命令逐条对比，差异 0 条**。

### Fixed（两个你实际遇到的问题）

**1. 「等了 45 秒才弹窗」——L-fast 周期 60 秒。**

实测那条 <project-C> 通知：`idle=45s` 才发出。轮询周期是 60 秒，所以最坏要等一分钟。

两个探针合计只要 **23ms**，15 秒周期每天多花约 100 秒 CPU（**0.15% 单核**）。
改成 **15 秒**——把「等了好一会」换成「几乎立刻」，这个交换明显值得。

**2. 「<session-A> 谎报军情」——通知了一个 10 天前的问句。**

实测那条：session `<session-O>` 的文件 **244 小时（10 天）没动过**。
问句是真的，但会话早就结束了——你根本没机会回答，被打断只有损失。

**根因**：`BACKLOG_HOURS` 只用在 **history 统计**上，没用在本该用的地方——**要不要通知**。
新增 `MAX_QUESTION_HOURS = 24`，超过就不提醒（仍出现在 `--history` 的积压里）。

**24 小时不是说定的**：实测 492 个真实问答对，回复延迟 p90 = 14.7h、**99% 在 24 小时内**。
超过一天还没答的，提醒也来不及了。

修完的结果：**当前 0 条待提醒**，4 条超时的被正确归为「会话多半已结束」。
之前那 5 条通知**全是误报**。

**变异验证**：去掉上限 → 2 条测试红。

### Added（前端与产品形态规格，`docs/design/frontend-and-shape.md`）

按 2026-11-01 的方向定了三件事，写成了规格（**未实现**）：

- **接力方式**：按风险分级，**由用户自定义 auto / confirm**。
  关键设计：风险判据**不由程序猜**——实测在线分类 95.4% 判不出、novelty 0.018% 命中，
  任何「自动判风险」都会退化成拍脑袋。所以规则是**用户显式声明、可读、可审计**的
  `policy.jsonc`，程序只做匹配。`auto` 不是「AI 决定」，是「用户事先授权了这条规则」。
- **产品形态**：终端 TUI（扩展）→ 系统托盘/通知中心 → 本地 Web 面板（只绑 127.0.0.1）。
- **TUI 必须随时显示当前是 auto 还是 confirm**——误以为在 confirm、实际是 auto，
  是最危险的失败模式。

**核验时发现一件重要的事**：ADR-0001 里「不能自动接力」那条**早已被修正过**
（2026-10-30），真实情况是**能投递，但来源标注改不掉**。本机实测：
9 个会话全部注册 `messagingSocketPath`，**命名管道 6/6 连接成功**。

**还有一件必须说清楚的**：我用全语料搜「真实的跨会话投递记录」，**45 条命中全是误报**——
它们出现在子 agent 的系统提示快照里，因为我们发给子 agent 的 prompt 本身就描述了该机制。
**本机从未发生过一次真实投递。** 所以规格里「接收方会不会执行 AI 发来的指令」
这条验证**没有历史数据可用**，只能实测，已写进规格的「必须先验证」清单。

### Added / Changed（跨会话投递验证：`auto` 模式被证伪）

按方向要先验证「自动接力做不做得到」，结论是**默认配置下做不到**。

**能做的（实测）**：8 个会话全部注册 `messagingSocketPath`，命名管道 **8/8 连接成功**，
`peerToken` 全部可读，协议全是 v1。**通道本身是通的。**

**做不到的（真实投递）**：向 idle 会话发一条测试消息 → **没有任何回音，接收方状态无变化**。

逆向 `claude.exe` 2.1.270 找到原因：

```
Your "crossSessionInbound" setting is "hold";
set it to "accept" to deliver held messages.
```

**默认 `hold`：所有入站消息被扣住等人批准，不送达会话。**
更硬的一条：`[that session runs in the same permission class as this one]`
——权限类必须一致，而 `permissionMode` **不在 `sessions/*.json` 里**（实测 8 个全部无此字段），
**发送方无法从外部判断能否送达**。

**所以规格里的 `auto` 删掉**，只保留 `confirm`（一键确认，以用户身份发出，不走跨会话通道）
和 `never`（只通知）。用户可自定义的范围相应收窄。

**将来切换的三个条件**（缺一不做）：`crossSessionInbound` 默认 accept 或可检测 /
权限类可从外部读取 / 投递有送达回执。

新增 `scripts/probe-relay.mjs`（可复现上面全部结论）与
`docs/research/2026-11-01-relay-delivery-probe.md`（完整证据）。

### Notes（已知且不打算近期修）

1. **在线停止分类 95.4% 判 `UNCLASSIFIABLE`** —— 结构性，分类器需要「下一句」而在线时下一句还没发生。
2. **抑制准确率无自动测量** —— 需要一个「回访」机制，属 P1。
3. **`needs` 覆盖稀疏** —— 16 个 job 里只有 2 个带 `needs`、1 个带 `suggestedReply`。
4. **12 个 agent 角色（743 行）中只有 2 个引用 `scan-sessions.mjs`，零个引用 `watch.mjs`** ——
   监控与调度两半仍未接上。锐评指出「970 行设计文档对应 0 行代码」，本阶段没有解决。

## [Unreleased] - 2026-11-02（UIA 驱动桌面版：能读，不能安全写）

> 承接 `5c37ba3`（接力探针判定 auto 模式在此宿主上不可建）。既然跨会话通道默认 `hold` 且权限类不可判，
> 下一假设是「用 Windows UI Automation 直接驱动桌面版窗口」。本阶段把这条路做成**能跑的脚本**并实测其风险。
> **结论：读可行且零打扰，写不可安全自动化。** 详见 `docs/research/2026-11-02-uia-driver.md`。

### Added

- **`scripts/uia-probe.ps1`**（45.6 KB，PowerShell 5.1 + `UIAutomationClient`）。七个子命令：
  `enum-windows` / `list-sessions` / `get-status` / `read-prompt` / `write-prompt` / `clear-prompt` / `dry-run-send`。
  **不含真实发送**：`dry-run-send` 只报告「会点哪个按钮」，返回体固定 `"sent": false`，全文件无 Send 的 `InvokePattern`。
  - **零硬编码坐标**。会话按名字解析，匹配阶梯为 精确 → 标题前缀 → 中止，中段子串直接拒绝。
  - **找不到就中止**：`exit 2` 不写；歧义 `exit 5` 不写；当前会话与 `-Match` 不符 `exit 2` 不写。
  - **无 `param()` 块**，手写 argv 解析。PS 5.1 的 `-File` 绑定在本机表现为 switch 参数偶发误绑并吞掉脚本自身
    stdout，且参数名支持前缀匹配（新增字段可能被认为满足某个参数名）。守护进程调用的 CLI 不能有这个不确定性。
- **`docs/research/2026-11-02-uia-driver.md`**：全部实测数字、三种 UIA 失效形态、两次现场事故。

### 实测（数字全部可复算）

- **耗时**：冷启动 `enum-windows` 均值 **14.0s**、`list-sessions` **19.0s**、`get-status` **25.8s**（各 5 次）。
  单进程内计时分解：`Add-Type` C# 编译 **7694 ms（占 63%）**，首次 `FromHandle` 另加 **~494 ms**。
  **热进程内 10 轮完整枚举均值 195 ms**（min 171 / max 322）——**相差约 100 倍**。
  结论：任何自动化必须长驻，不能每次起 CLI。
- **焦点**：只读操作 **72/72 次前台采样未变**，窗口保持最小化；`write-prompt` 一次就把前台从
  `hwnd <hwnd-a> (pid <pid-a>)` 切到 `hwnd <hwnd-b> (Claude)` 并取消了最小化。**读不抢焦点，写抢。**
- **并发**：4 进程同时 `list-sessions`，4/4 成功、无污染（纯读）。
- **坐标漂移**：同一个会话行，侧边栏 x 从 **8 → 297**、y 从 **376 → 556**；列表顺序同时变化。
- **多窗口**：**23 个 `claude` 进程**，其中 **3 个窗口标题都是 `Claude`**（2 个隐藏、1 个可见）。
  仅按标题匹配会挑到隐藏窗口；决定性判据是 UIA 子树里同时有 `Group[Sidebar]` 和 `Edit[Prompt]`。
- **重试**：瞬时错误 3 次内成功；永久错误耗尽后 `exit 7`；**逻辑错误（找不到）1 次即抛，不重试**。
- **句柄失效**：缓存 20 个句柄静置 **45 秒 → 0 次失效**。失效由**渲染事件**触发，不由时间触发；
  表现为「元素还在、子树空了」（`sidebar=True, buttons=0, children=0`）而**不是**抛异常。

### Fixed（本阶段自己抓到的四个缺陷）

- **`.Count` 在 StrictMode 下对空结果抛错**：`get-status` 直接 `$rows.Count`，`$rows` 为 0 时
  `The property 'Count' cannot be found`，整个命令 `exit 7`。改为 `$rows = @(...)` 后再取 `.Count`。
- **侧边栏「空」被当成「不存在」**：`Find-SidebarElement` 原本要求 ≥3 个按钮子孙，否则返回 `$null`。
  实测侧边栏会在渲染重建期间短暂为空，于是**健康窗口被整个排除**，报 `no Sidebar group in UIA subtree`。
  负向证据：修前 `list-sessions` 稳定 `exit 6`，修后同一条命令正常返回。
- **`Invoke-WithRetry` 不重试瞬时状态**：原实现把所有带 `ProbeExitCode` 的异常当逻辑错误立即抛出，
  导致「子树还没建好」一次都不重试。新增 `-Retryable` 标记后，实测从 **1 次**变为 **10 次**尝试（`attempts: 11`，7639 ms）。
- **`SetValue` 是异步的，固定延时读回会误判**：用 `Start-Sleep 60ms` 读回得到 `verdict=mismatch, intended 8, actual 1`，
  而紧接着直接查询输入框里**就是那 8 个字符**。若按 mismatch 去回滚，会把**已成功的写入回滚成空**。
  改为轮询读回（预算 2500 ms，报告 `settle_ms`）。

### Notes（阻断项，按严重度）

1. **写入抢焦点**（实测）。用户在别的应用打字时会被弹走。
2. **最小化窗口写入静默失败**（实测）。`SetValue` 不抛异常但不生效（`intended 288 → actual 1`）。
3. **异步**（实测）。固定延时读回会误判并触发错误回滚。
4. **UIA 调用会挂死**（实测）。作业后期多次出现 PowerShell 进程 >120s 无返回，连 `echo` 都卡住。
5. **性能**（实测）。冷启动 12–30s，必须长驻，而长驻放大第 4 条。
6. **UI 状态会变**（实测）。观测到 `470 个按钮、0 个会话行`、而侧边栏与输入框都在的状态。
   此时"尽力而为"会把指令送进不确定的上下文；当前实现选择报错（`exit 7` / `session_view: false`）。

**两次现场事故（如实记录）**：误覆盖用户 47 字符草稿（已按字节精确还原，`exact match: true`）；
误调 `Hide sidebar`（侧边栏实际未受影响，20 行完好）。**全程未调用 Send，全树搜索探测串 0 命中。**


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
