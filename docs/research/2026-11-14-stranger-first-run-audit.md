# 陌生人首次运行审计：今天克隆这个仓库，5 分钟内能拿到价值吗

- 日期：2026-11-14
- 审计者：P1，扮演**从没听过本项目的人**。未读 `docs/research/` 下任何既有报告，只读 README / GUIDE / CAPABILITIES / docs/README / CLAUDE.md，以及文档点名要跑的命令所对应的脚本。
- 被审对象：公开仓 `origin/main` 的 HEAD `3691d30`（与本地 HEAD 相同）。**全部实测在 `<tmp>` 下的一次性 clone 内完成，本仓库未产生任何文件**（本报告除外）。
- 方法：真跑命令、贴真实输出与退出码；「卡住」一律停下记录，不翻源码找答案（唯一例外是确认某条行为是「产品设计」还是「环境问题」时，读被点名脚本的相关行）。

> 关于本文件本身：新增 research 报告需要登记到 `research/README.md`，否则 `check-structure.mjs` 会红。任务禁止改动仓库其它文件，故未登记。这本身是一条发现（见 §6）。

## 0. 一句话结论

**「能跑、且有一个真有用的点，但交付面失守」——判断为「半成品（可自用，不可发布）」**，不是「能用的工具」，也不是「内部脚本集」（因为它确有对外承诺的命令、输出与文档体系）。判据见 §7。

---

## 1. 「30 秒上手」逐字走一遍

README §30 秒上手 只有三条命令。逐条结果：

### 1.1 `git clone https://github.com/sqkl520/Overwatch.git`

- 成功。完整 clone 约 **5 秒 / 8.7 MB**，`--depth 1` 约 **7 秒**。
- 无子模块、无 LFS、无 `package.json`、不需要 `npm install`。这一点 README 说得准确。

### 1.2 `cd Overwatch && node scripts/scan-sessions.mjs --days 3`

- **能跑，退出码 0。** 但耗时 **43–56 秒**（README 写「约 33 秒」）。这不算错——GUIDE §9 明说「不要相信任何写死的秒数」，并且承认这个数字漂移过 33/48/77/87 秒。但 README 与 GUIDE 对同一命令给了两个数（33 秒 vs 77 秒），陌生人第一眼看到的是 README 那个。

- **输出与 README「真实输出格式」的差异**（这是本节最重要的发现）：

README 展示的格式：

```
OmniSight 会话扫描 · 最近 3 天 · 19 个有活动的会话
liveness: reconstructed（事后重建，非实时上报）

[PRODUCING] Projects/<repo>     calls=  988 sub=    13 ...
[EXPLORING] Projects/<repo-2>   calls= 5840 sub=100/272~ ...
```

实际输出（`--days 3`，本机语料）：

```
OmniSight 会话扫描 · 最近 3 天 · 138 个会话
transcript 436 个：窗口内 136 · 窗口外 299 · 时间未知 1 · job 10 个（补入 2）
⚠ 1 个 transcript 内部没有任何时间戳，无法判定是否在窗口内，未计入
liveness: reconstructed（事后重建，非实时上报）

宿主注册的活跃会话 14 个：
  busy    批量 Outlook 邮箱的管理与保护                可投递(带来源标注)
  ...

[BLOCKED  ] Server/MCServers/Server/   calls= null sub=      0 ... host-reported-blocked tok=3476k
            等待输入：要我现在就把用户实测单交给你，还是你先看这四份测试报告？
            建议回复：把实测单发给我
[PRODUCING] X/////                     calls=  306 sub=      0 ... idle=5m    persistent-change-in-window
...
汇总：BLOCKED=2  EXPLORING=133  PRODUCING=14
提示：本脚本只观察，不干预。状态不可由 Agent 自述覆盖，见 docs/spec/state-model.md §2.2。
```

逐项对照：

| README 写的 | 实际 | 性质 |
|---|---|---|
| 首行「19 个**有活动的**会话」 | 「138 个会话」 | 措辞变了（口径：含 0 调用的冷启动会话）。文档落后 |
| 无 transcript 统计行 | 有「transcript 436 个：窗口内/外/时间未知/job」+ 一条 ⚠ | README 少了两行，且这两行恰是「这是真扫描还是没扫到」的关键说明 |
| 无「宿主注册的活跃会话」块 | 有 14 行 `busy/idle <名称> 可投递(带来源标注)` | GUIDE §2 有这段，README 没有 |
| 无「汇总」行 | 有 | README 缺 |
| 行内字段 `calls/sub/depth/novelty/hb/idle/reason` | 一致（字段集完全相同） | **这一层是准的** |
| `sub=100/272~` | 实测出现 `sub=100/131~`、`sub=100/558~` | 格式一致 |
| `idle=5s`、`idle=67.5h` | 实测还有 **`idle=-7s`、`idle=-28s`（5–8 行）** | 产品缺陷：负时长未在文档的 idle 格式清单（`35s / 2m / 13.6h / 45.7d`）里 |

- **`idle` 为负**是实打实的：`{"idleSec": -22, "lastActivity": "<now+22s>", "state": "PRODUCING", "src": "transcript"}`。成因是 `nowMs` 在扫描开始时取一次，而扫描期间生成的 transcript 尾部记录时间戳晚于它；窗口截断到秒级也会放大。对陌生人的意义：这是一个「数字可能倒着走」的表，而本仓库全部叙事都建立在「数字可核对」上。
- **行标签不可用于行动**：138 行里 108 行 `calls<=20`、48 行 `calls=0 cold-start`、85 行 `dormant`；按行首字段统计有 12 个标签各出现 2 次以上（最大一组 47 行，是同一段用户目录前缀被截成 24 列；另一组 46 行是同一项目下的临时子目录）；还有一个由盘符 slug 解码出的乱名（形如 `X/////`）出现 2 次。**行里没有会话 ID**（`grep` 命中 0），所以「看到一行想处理它」没法从这张表走到任何后续动作——必须去 TUI 才能拿到 ID。

### 1.3 `node scripts/oversight-tui.mjs`（README 紧接着给的第二条）

- 在管道里自动降级为纯文本快照（文档承诺的行为，实测一致），**退出码 0，耗时约 56 秒**（内部又跑了一次 `scan --json`）。
- 首屏第一机制是清单，第二条就是：

```
 声明对不上   ✗ 21 条完成声明无证据支持 · 3 条存疑 · d 看证据
 后台监视     ✗ 监视未在跑 · 先修这个
```

- 「声明对不上」这条**确实有价值**，且与 `verify-claims` 的输出对得上（同一语料：NO_EVIDENCE 20 条 + STALE_ONLY 1 条 ≈ 21）。数字每次跑会变（同一天多次跑见过 11/12/21/22），因为语料在动；这里只记录量级。
- 「后台监视 ✗ 监视未在跑 · **先修这个**」是**首跑最伤的一句**：新克隆的机器上不可能有 `%LOCALAPPDATA%/Overwatch/state.json`，于是 `healthCheck` 必然判「没在工作」，并把「先修这个」摆在第一屏。它没说要修什么、也没有指向 `install-watcher.mjs`。我在 README / GUIDE / CAPABILITIES / docs/README 里 grep 「监视未在跑」「先修这个」「后台监视」，**0 命中**——这条首屏文案没有任何文档解释。
  - 我验证过这不是我的环境问题：把 `OVERWATCH_STATE_DIR` 指到一个不存在的目录、或指到一个空目录，都会稳定出现这句；只有先跑过 `watch.mjs --once`（或 install-watcher）才会消失。

### 1.4 `node scripts/watch.mjs --inbox`（README 紧接着给的第三条）

- 退出码 0，输出「收件箱：空。后台没有发现任何在等你或失败的会话。（空不等于健康……）」
- **但在同一分钟、同一份语料上，`scan` 报 `BLOCKED=2`。** 原因是 `buildInbox` 只遍历 `state.notified`（通知历史），从不做一次现场扫描——首跑时历史为空，所以永远是「空」。GUIDE/README 都没写「这条命令要先有后台监视跑过才有意义」。括号里那句「空不等于健康」只解释了「守护进程可能没跑」，没解释「宿主明明有 2 个 blocked，这里也是空」。
- 一个陌生人在三分钟内会看到：表里有 2 个 BLOCKED，收件箱说没有，面板说先修监视。三个视角互相矛盾，且都「没错」——这是设计取舍，但对首跑体验是硬伤。

---

## 2. 有没有「第二次用」

**结论：README 没有。GUIDE 有，但 README 不指向它。**

- README 里**没有任何一条「下次什么时候跑、跑完看什么、看到 X 做什么」的闭环**。`## 30 秒上手` 之后直接进 `## 核心能力`（一张能做/不能做的对照表），再往下全是「我们修了哪些 bug」「和官方 claude agents 什么关系」「为什么不能自动接力」。这是**给评审者写的**，不是给使用者写的。前 51 行读完，一个人知道「它能扫会话、能核对完成声明」，但不知道「明天早上我该跑哪条」。
- GUIDE 有这部分，而且质量不低：每条命令有「**什么时候用**」；§6 有一个真实的 before/after 叙事（一个 BLOCKED 会话停了 22 天、按 `c` 复制「把回执发给我」、之后继续干活），这是全仓最好的一段。
- **但 README 一个指向 GUIDE 的链接都没有**（`grep -c 'docs/GUIDE' README.md` = 0 命中）。README 只链 `docs/CAPABILITIES.md` 与 `docs/README.md`；`docs/README.md` 再链 GUIDE。从 README 到「我该敲什么、会看到什么」是**两跳**，而 README 自己在目录块里只写了「GUIDE 手册」四个字。
- `--days 3` 的解释：README 只有一句「一次全量实测约 33 秒；`dormant` 不告警」。**没有说为什么是 3、什么时候该改成 1 或 7、不写这个参数时默认几天**（实测默认 **7**，文档 grep 0 命中）。GUIDE §9 讲了成本模型（按文件不按天），但同样没说默认值是多少。
- CLI 对陌生人不友好，实测三条：
  - `scan --help`：**不打印帮助，直接跑一次全量 7 天扫描**（31 秒）。
  - `scan --days`（漏值）/ `scan --days abc`：**静默回落到 7 天**，无报错。
  - `scan --bogus-flag`：**静默忽略，照跑**。
  - 对照：`oversight-tui --help`、`watch --help` 都正常。所以「有没有 --help」在同一个仓库里不一致。
  - `--project`（GUIDE §10 教人排查时才提）可用，但不在任何 help 里。

---

## 3. 前 5 分钟花在「理解这是什么」上的时间

按中文字数 ÷ 400 字/分钟估算：

| 文件 | 中文字数 | 读完约 |
|---|---|---|
| README.md | 2 468 | **6.2 分钟** |
| docs/GUIDE.md | 6 095 | 15.2 分钟 |
| docs/CAPABILITIES.md | 1 782 | 4.5 分钟 |
| docs/README.md | 929 | 2.3 分钟 |
| CLAUDE.md | 794 | 2.0 分钟 |

- **README 全文 6.2 分钟 > 承诺的 30 秒，也 > 5 分钟预算。** 只读到第一段示例（第 51 行）约 1.2 分钟；加上 clone 7 秒 + 扫描 50 秒，**到第一次看到输出约 2 分钟，这在 5 分钟内是可行的**。代价是：要读懂那 138 行，必须再走两跳到 GUIDE §4 的字段表。
- 读完 README 我能否一句话说清它干什么？**能，但那句话是 README 第 5 行给的，不是我读出来的**：「它扫描本机 Claude Code 会话，在 AI 说『做完了』时去 transcript 里找证据，找不到就标出来。」后面 120 行没有加固这句话，反而在讲 bug 修复史。

**我作为样本的困惑清单（逐条，不客气）：**

1. 仓库叫 **Overwatch**，输出每行都印 **OmniSight**。README 从头到尾没解释这两个名字的关系（`CLAUDE.md` 第一行有「代号 OmniSight」，但陌生人不是被 CLAUDE.md 引导的——README 里没有一处指向它）。第一屏就出现未解释的别名。
2. `hb=0s/120s`、`novelty=0.97`、`depth=1`、`sub=100/272~`、`reason=persistent-change-in-window` **在 README 里全部没有定义**；定义在 GUIDE §4，两跳之外。README 贴了带这些字段的示例，却没给字段表。
3. `[PRODUCING] X/////`：一个项目名印成一串斜杠，我不知道这是什么、重不重要。这类名字占了不少行。
4. 同一标签出现 46–47 次，且**没有会话 ID**，我不知道哪一行是「我现在该管的那个会话」。
5. `idle=-7s`：负的时间。我第一反应是「这工具坏了」。
6. 「先修这个」：修什么？怎么修？文档里查不到。
7. `watch --inbox` 说空，`scan` 说 2 个 blocked。我不知道该信谁。
8. `--days 3` 为什么是 3？不写会怎样（默认 7）？文档没说。
9. README 说「真实输出格式」，但三行都对不上（首行口径、缺 transcript 统计行、缺汇总）。**在一个把「不伪造数字」当核心卖点的仓库里，示例输出与真实输出不一致，是最伤信任的一处。**
10. 第 61 行「实测后已删除该推断」、第 102–114 行「三个修掉的真 bug」：对陌生人是噪声——我还没用过这个工具，就在读它的故障史。这些内容有价值，但位置应在 `docs/CHANGELOG` 或 research，不应占据首屏的一半。
11. `node --test scripts/*.test.mjs`（README 第 150 行，陌生人不一定会跑，但硬门自己的话术在这里）在 Windows cmd/PowerShell + Node 18/20 下**直接报错**，见 §4.2。

---

## 4. 冷启动门槛清单

### 4.1 运行前提

| # | 前提 | 文档写明了吗 | 不满足会怎样（实测） | 依据 |
|---|---|---|---|---|
| 1 | **必须已经用 Claude Code，且本机有会话记录**（`~/.claude/projects/`） | README 只在第 5 行说「扫描本机所有 Claude Code 会话」；GUIDE §10 把它写进「出问题了怎么办」。**没有任何地方把它列为「前提条件」** | 目录不存在 → `无法定位 transcript 根目录：<home>\.claude\projects`，**退出码 2**（干净，可诊断）。目录存在但为空 → 退出码 0，0 个会话（干净）。 | 实测；`scan-sessions.mjs:495-498` `findTranscriptRoot()` 只查 `<home>/.claude/projects` |
| 2 | Node 版本 | README/GUIDE 均写 **≥ 18** | `scan` 在 **Node 16 与 18 上都能跑通**（实测），所以 18 不是真下限；但**文档里的测试命令在 Node 18/20 + Windows cmd/PowerShell 下失败**（见 4.2）。CI 钉的是 Node 20。 | 实测 `npx node@16/18 scan`；`.github/workflows/validate.yml` `node-version: '20'` |
| 3 | `~/.claude/jobs/*/state.json` | GUIDE §3/§4 说明了 `BLOCKED`/`FAILED`/`tok` 来自它；README 未提 | 缺失 → **静默**少掉 BLOCKED/FAILED 两类事实，不报错、不提示，输出看起来正常 | `scan-sessions.mjs:562-578` `readJobs()` 目录不存在返回 `[]` |
| 4 | `~/.claude/sessions/*.json` | GUIDE §3 提了 | 缺失 → **静默**少掉 `WAITING` 与「宿主注册的活跃会话」块 | 实测空 HOME 时该块整段消失，无提示 |
| 5 | `CLAUDE_CONFIG_DIR` 支持一致性 | **完全未写进用户文档** | `watch.mjs` 认它，`scan-sessions.mjs` **不认**（硬编码 `homedir()`）。实测：设了 `CLAUDE_CONFIG_DIR` + 空 HOME，`watch --once` 正常工作，`scan` 报「无法定位 transcript 根目录」退出 2。两个工具对同一台机器给出不同结论。 | `watch.mjs:claudeRoot()` vs `scan-sessions.mjs:495` |
| 6 | `OVERWATCH_STATE_DIR` | 只在脚本里出现，用户文档 0 命中 | 不设 → 状态写到 `%LOCALAPPDATA%/Overwatch`（Win）/ `~/.local/state/overwatch`（其他）。不会报错；但这意味着**工具不「只读」**——`watch` 会落盘 `state.json`/`observer.jsonl`/日志。GUIDE §9 说「不写文件」，指的是扫描器，不是守护进程，容易误读。 | `watch.mjs:234-241`；实测 `%LOCALAPPDATA%/Overwatch/` 下确有多份运行文件 |
| 7 | `tasks/runs/` 存在 | 文档说明它是运行时产物、gitignored，autocreate；**实测无影响** | 缺失 → 各脚本自己 `mkdirSync` 或降级提示，不报错 | 实测 |
| 8 | 权限 / chmod / 环境变量 / 配置文件 | 无 | 快捷启动全部 `node scripts/x.mjs`，**不需要 `chmod +x`**；quickstart **不需要任何环境变量** | 实测 |
| 9 | 平台 | README 第 50 行如实写了 Windows / macOS / Linux 差异 | 非 Windows：无 Toast（退回写 `runner.log`）、`install-watcher` 给 launchd/systemd 配置而不是假装装好；剪贴板走 `pbcopy` / `xclip`（Linux 缺 `xclip` 时按 `c` 会失败并降级为「复制失败，请手动选择」面板——**这条前提文档没写**）。 | `notify.mjs:46-64`、`install-watcher.mjs:71-96`、`oversight-tui.mjs:clipboardCommand()` |
| 10 | 路径 / 编码 / locale | 未写 | **实测都没问题**：克隆到含空格与中文的路径（`<tmp>/ow 中文 路径`）`scan` 与 TUI 均正常；GBK(936) 控制台下中文正常；时区不影响（全部 ISO 时间戳）。 | 实测 |
| 11 | 宿主（Claude Code）版本 | 未写 | 有代码注释依赖实测过的宿主版本（`2.1.270` 的 `wS` 状态表），但**没有版本闸门**；宿主改字段名就会静默少字段。无法在本次审计中验证，**不确定**。 | `scan-sessions.mjs:500-520` |
| 12 | 目录结构假设（slug 编码、子 agent 目录） | GUIDE §4 解释了 `100/272~` 与「每个子 agent 取末尾 400 条」，未解释 slug→显示名的解码规则 | slug 解码是把 `-` 全部换成 `/` 并去掉首段盘符前缀，所以盘符根目录的 slug 会被渲染成一串斜杠（形如 `X/////`），带空格的目录名会被渲染成 `A/B/C/` 这类假路径。**这是乱名与重名的来源，且文档没有说明这只是一种「显示还原」而不是真路径。** | `scan-sessions.mjs:1058` `noun()`；实测重名 12 组 |

### 4.2 仓库自身的「改动后必跑」在干净 clone 上是红的（最严重）

```
$ node scripts/check-structure.mjs
check-structure · 仓库结构硬门

✗ 3 项违规：
  [CLAUDE.md] 第 61 行引用的文件不存在：.claude/settings.local.json（…）
  [docs/GUIDE.md] 第 333 行引用的文件不存在：.claude/settings.local.json（…）
  [docs/CAPABILITIES.md] 第 63 行引用的文件不存在：.claude/settings.local.json（…）
退出码 1
```

- `.claude/settings.local.json` 是 **gitignored 的本机私有文件**（`.gitignore:2`）。所以：**任何干净 clone 上，这个「改动后必须绿」的硬门必然红**，而且红的理由是三份文档让你去创建一个私有文件。作者本机有这个文件（`<repo>/.claude/settings.local.json`，445 B），所以作者永远看不到。
- 后果一：GUIDE §2「命令 3：结构硬门」贴的「真实输出」是 `✓ 结构检查全部通过`——**与干净 clone 的实际结果相反**。这是本报告中「文档说的和看到的不一致」最硬的一例。
- 后果二：CI 因此全红。`gh run list` 最近 **7/7 全部 failure**，失败步骤就是 `Structure gate`，报错与上面三行逐字相同。
- 后果三：会出现「越诚实的用户越早放弃」：一个新贡献者克隆、跑硬门（文档让他跑）、红、发现要造一个他不该提交的私有文件、且 README 说这个数字「写错即红」——他多半直接关掉。

### 4.3 文档里的测试命令在 Windows 默认终端下失败

`node --test scripts/*.test.mjs`（README 第 150 行、CLAUDE.md、GUIDE §10 都这么写）：

| 环境 | 结果 |
|---|---|
| Git Bash + Node 26 | 1261 pass / 0 fail（约 52 秒） |
| **cmd.exe + Node 20**（CI 的版本） | `Could not find '<repo>\scripts\*.test.mjs'`，**退出码非 0** |
| **PowerShell + Node 20** | 同上 |
| PowerShell + Node 22 | 正常，1261 pass |
| PowerShell + Node 26 | 正常 |

原因：`node --test` 的 glob 支持只在较新版本才有；Windows 的 cmd 与 PowerShell **不会为原生命令展开通配符**（bash 会，所以 Linux CI 没问题）。文档声明「Node ≥ 18」而命令在 18/20 的 Windows 上不成立——**这是文档与工具链的双重问题**，且恰好打在「请照抄这个命令」的地方。

（未验证：Node 18/20 跑完整 1261 条是否会因 API 差异失败。我只在 26 上跑了全量并全绿；单文件在 18 上无问题。**不确定，因为没跑。**）

---

## 5. 哪些是产品问题，哪些是环境问题

**产品问题（与我的机器无关，换个陌生人也一样）**

1. 干净 clone 上结构硬门必红（§4.2）；CI 7/7 红；GUIDE 展示的「通过」输出与现实相反。
2. 文档测试命令在 Windows + Node 18/20 下失败（§4.3）。
3. README 的「真实输出格式」与真实输出不一致（首行口径、少 transcript 统计行、少汇总）——在「不伪造数字」的产品叙事下是自伤。
4. 首跑 TUI 第一屏就有「监视未在跑 · **先修这个**」，无文档、无指引、无链接。
5. `watch --inbox` 首跑必空，与同一时刻 `scan` 报的 BLOCKED 数量矛盾；README 未说明它依赖历史。
6. `scan` 的 CLI：`--help` 不生效、缺值/非法值静默回落到 7 天、未知参数静默忽略；`--project` 不在任何 help 里；默认 7 天未文档化。
7. 人读表格**没有会话 ID**，12 组重名、48 行 `calls=0`、85 行 `dormant`、`X/////` 这类乱名——表格可看，不可行动。
8. `idle` 出现负值（`-7s`…`-37s`），而文档的 idle 格式清单里没有负数这一档。
9. `CLAUDE_CONFIG_DIR` 在两个工具间行为不一致（一个认、一个不认），且未文档化。
10. README 不链 GUIDE；「第二次用」完全不在 README 的路径上。

**环境问题 / 我的样本偏差（必须说明）**

1. 我在这台机器上有大量真实会话（436 个 transcript / 730 MB），所以 `--days 3` 的 43–56 秒、138 行输出都受此影响；在只有几十个会话的机器上会快得多、短得多（实测空 HOME：0.8 秒；一个演示项目：1.8 秒）。README 的 33 秒与 GUIDE 的 77 秒差异同源，不算 bug。
2. 「陌生人没有 Claude Code」这一情形是我用 `HOME`/`USERPROFILE` 覆盖**模拟**的，没有真机验证；模拟下报错文案清晰、退出码 2，属于好行为。
3. 我的 TEMP 在 C 盘、系统语言中文、代码页 936；未在 macOS/Linux 上实测，非 Windows 分支只做了代码与文档对照。
4. 未测：真实终端里的交互 TUI（键位、颜色、`c` 复制）、Stop hook 端到端、Windows Toast 实际弹出。这些在非 TTY 下无法验证。
5. 本报告写作时，本地工作树有他人未提交改动（`tui-theme.mjs` 等）与未跟踪报告；**本报告的全部数字取自临时 clone 的 HEAD `3691d30`**，与本机工作树无关。

---

## 6. 顺带发现

- 新增一份 research 报告会让硬门多一条「未登记」违规。任务禁止我改 `research/README.md`，故本文件当前会让 `check-structure` 多红一行。**这不是文档缺陷，是流程要求**：合并本报告时必须同时登记索引。
- `install-watcher.mjs status` 打印的「快捷方式 ✓ 存在」在本机是为真，因为快捷方式路径是全局的（`%APPDATA%/.../Startup/Overwatch Watch.lnk`）；也就是说这条命令的结论与「你克隆的是哪个仓库」无关。对我这个陌生人，它正确地报了「未安装」，但它的输出把我的临时 clone 路径原样印在「仓库」一行——不影响使用，仅记录。
- `analyze-hook-samples.mjs` 在没有任何样本时输出「样本：0 条。这不是『没有问题』——是没有数据。」——这是全仓最好的「空状态」文案，值得作为 TUI 首屏的参照。
- 完整测试跑一次会向 `tasks/runs/stop-hook-samples.jsonl` 写一条样本（`stop-verify-hook.test.mjs`）；文件 gitignored，不污染提交，但「跑测试会在工作区留痕」这一点未文档化。

---

## 7. 一句话诊断与判据

**诊断：半成品——「可自用，不可发布」。**

判据（不是感觉，逐条对应上文实测）：

1. **有真价值点，且它经得起跑**：`verify-claims.mjs` 在真实语料上 2 秒内给出可行动的结论（例：「AI 说『全部测试通过，336/336』，本会话测试调用 0 次 → NO_EVIDENCE」，并附「建议」），84.6% 精度这个数字也被它自己的输出结构支撑（UNKNOWN 不混进 NO_EVIDENCE）。这不是玩具。**→ 排除「内部脚本集」。**
2. **交付面失守**：干净 clone 上自家硬门必红、CI 全红、文档示例输出与真实输出不一致、测试命令在声明的 Node 下限 + Windows 默认终端下报错。**→ 排除「能用的工具」**：一个工具发布出去，第一条「照抄这行」的命令不能是错的。
3. **首跑引导是反的**：陌生人拿到的第一屏在教他修一个他没装过的守护进程，而不是告诉他「现在去 Claude Code 里让它说一句『我修好了』，再回来跑这条」。
4. **没有第二次用**：README 不含任何「什么时候跑、看什么、看到 X 做什么」；唯一的真实叙事（22 天 BLOCKED 的 before/after）在 GUIDE §6，而 README 不链 GUIDE。

**要让它在 5 分钟内成立，最小改动（按性价比排序）：**

1. 修硬门：把「引用 `.claude/settings.local.json`」的三处改成「示例/待建」标注，或让检查接受该文件不存在。**这是 1 行改动，直接让 CI 与干净 clone 变绿。**
2. README 的「真实输出」换成本机现跑的**完整**输出（含 transcript 统计行与汇总行），或用「节选（省略 N 行）」明确标注。
3. README 第 24 行那一节改成真正的 30 秒：只留「clone → scan → 这 5 行说明」，并把 GUIDE §6 的 before/after 搬上来一小段作为「第二次用」。
4. TUI 首屏：没有 state.json 时，「先修这个」换成「后台监视未运行——`node scripts/install-watcher.mjs install` 或忽略（`--inbox` 仍可用但只有历史）」。
5. `scan` 加一个 12 行的 `--help`；`--days` 缺值/非法值报错而不是静默 7 天；默认值写进 README。
6. 表格行加短会话 ID（8 位，全仓已在别处使用这个长度）。
7. 文档测试命令改成 `node --test scripts/`（目录形式，跨 shell 稳），或注明「Windows 请用 Node 22+ / Git Bash」。
