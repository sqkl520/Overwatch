# 唯一入口的契约（现行规格）

> 本文件是 `scripts/overwatch.mjs` **现行行为**的规格，不是设计推演。
> 与代码冲突时以代码为准，并就地修本文（`docs/README.md` 的「四类文档」表）。
>
> 依据（全部为实测，不是估算）：
> - 四个真卡点与 TUI 首屏「先修这个」的来历：`../research/2026-11-14-stranger-first-run-audit.md` §1.3、§4、§7
> - Node 真实下限（用工具 18.20.4 / 跑测试 20.16.0）与 Windows 下 `node --test scripts/*.test.mjs` 失败：`../research/2026-11-14-portability-audit.md` §1.1、§1.2
> - 为什么宁可降级也不假装：`../adr/0002-honest-degradation.md`
> - 为什么**不**另写一份判据：`../research/2026-11-14-gate-widening-redteam.md` §4（同一问题两份判据必然漂移，漂移的那份没人测）
>
> 测试：`scripts/overwatch.test.mjs`（30 条，含 2 条把入口源码改造成退化版本再跑起来的负向用例，
以及 1 条钉住「入口名以 `watch.mjs` 结尾，导入它会启动守护进程」的回归用例）。

---

## 0. 一句话

`node scripts/overwatch.mjs` 不加参数 = `doctor`：**在 1000 ms 内报告 7 项前提的事实**，
每行只说「读到了什么」，不打印红绿灯，判定留给最后一行。
其余子命令**只路由、不代跑** —— 一个诚实的空壳比一个会和原命令悄悄分叉的半成品好。

---

## 1. 为什么这个文件存在（问题陈述，不是功能列表）

陌生人在干净 clone 上遇到的四个卡点里有三个同源：**没有任何命令回答「我装对了没有」**。

| 现象（实测） | 后果 | 本入口怎么处理 |
|---|---|---|
| 不知道第一条命令该跑什么 | 三条文档命令各自都要先满足隐含前提 | 无参数运行 = 前提自检，且第一行先说「查哪几项、预算多少」 |
| `node --test scripts/*.test.mjs` 在 cmd.exe/PowerShell + Node 20 下报「文件找不到」 | 用户以为仓库不完整，实际是自己的 Node 太旧 / shell 不展开 glob | 报 Node 版本，并**直接探测两个 API** 在不在（版本号是推断，API 是事实） |
| 首跑 TUI 第一屏是「✗ 监视未在跑 · 先修这个」，而这三句话在 README/GUIDE/CAPABILITIES 里 0 命中 | 第一屏在教用户修一个他没装过的守护进程 | `doctor` 的 `watcher` 项直接说「启动器在不在、health 说什么、数据目录在哪」，并把 `install-watcher.mjs install` 摆出来 |
| 同一分钟 `scan` 报 BLOCKED=2 / `watch --inbox` 报空 / TUI 报先修监视 | 三个视角互相矛盾且都「没错」 | `watch` 的路由明确写「`--inbox` 只读通知历史，首跑必空 —— 那是历史为空，不是没有 blocked 会话」 |

---

## 2. 首屏的四条硬规则（逐条可判定）

| # | 规则 | 判定方式 | 钉住它的测试 |
|---|---|---|---|
| 1 | **PLAN 先行**：第一行说清查什么、几项、预算多少毫秒 | 首行必须匹配 `^overwatch doctor · 查 \d+ 项前提 · 预算 \d+ms` | `无参数运行 = doctor`；负向用例删掉 PLAN 头后该断言必红 |
| 2 | **每项带耗时** | 7 行都匹配 `^\[\s*\d+ms\]`；耗时是**真测的**（`Date.now()` 包住每项），不是估算 | `doctor 的每一行都是「读到了什么」` |
| 3 | **每行只说「读到了什么」，不打印红绿灯** | 项正文里不得出现 `✓` / `✗` | 同上 |
| 4 | **空状态与坏状态必须可分** | 见 §3 | 三条：空 / 坏 / 两者不同 |

**规则 3 的范围要说清**：它约束**本入口自己写的行**。被复用的脚本（写前闸、`install-watcher`）
原输出里的 `✓` / `✗` / `**` 在转发时被去掉字形、只留词 —— 判定权仍归写的那个脚本，
本入口不重算它说得对不对（见 §5）。

---

## 3. 空 / 坏 / 正常：三态而不是两态

`transcript 根` 的三种状态必须**分别**呈现。合并任意两种都会让用户走错方向：
「去装 Claude Code」和「去查权限」是两件相反的事。

| 状态 | 判据（代码位置） | 人类输出 | `facts.kind` | 退出码 | 建议跑 scan？ |
|---|---|---|---|---|---|
| **空** | `statSync` 抛 `ENOENT` / `ENOTDIR` | `根 … 不存在 —— 这台机器上还没有 Claude Code 的会话记录` | `absent` | **2** | 否（没有语料，那条建议是错的） |
| **坏** | `stat` 成功但 `!isDirectory()`；或 `readdirSync` 抛（`EACCES` 等） | `根 … 读不出 —— 路径在，但 stat 失败：<errno>` / `… 但不是目录（ENOTDIR）` / `… 但枚举失败：<errno>（权限？）` | `unreadable` | **3** | 否 |
| **正常** | 目录可枚举 | `根 · N 个项目 · M 份 .jsonl · 最新一份 K 前` | `ok` | **0** | 是 |

「空目录」（根在、0 份 transcript）**不是**空状态：它是 `ok` + `0 个项目`，退出码 0。
前提齐了，只是还没有数据 —— 这和「这台机器没用过 Claude Code」是不同的事实。

> **负向证明**：测试里把入口源码的 `kind: 'unreadable'` 全部替换成 `kind: 'absent'`
> 并统一文案，产出一个变异体**真的跑起来**，断言它把「坏」报成「不存在」且退出码 2。
> 也就是说 §3 这三条正向断言在这份变异体上必然红 —— 否则它们没在守任何东西。
>
> 这里踩过一个坑，写下来以免复发：变异体最初放在临时目录、文件名不同，而入口原先用
> `/overwatch\.mjs$/` 判「我是不是被当 CLI 跑的」，于是变异体**一声不响地不执行**，
> 负向断言全部平凡通过。现在入口用「解析后的路径相等」判，测试先断言变异体的输出非空。
> **一个不跑的负向测试比没有更坏**：它给人「已经验过了」的错觉。

---

## 4. 耗时上限：1000 ms 是硬约束

`doctor` 的预算是 **1000 ms**，是常量不是环境变量（超了是设计错误，不是环境慢）。
本机基线（实测，非估算）：`gate` 进程内 4 ms + `watcher` spawn 300–350 ms +
枚举 540 余份 transcript 约 100–130 ms + Node 启动 90–140 ms，报告值 **500–740 ms**。
`time node scripts/overwatch.mjs` 会再多 170–210 ms —— 那是**父进程拉起 node 本身**的成本
（同机 `node -e 'console.log(0)'` 就是 210 ms），不在任何预算里，所以人类输出末行明说这件事。
真值必须写在输出里，不能让人自己去对账。

| 量 | 含义 | 谁用 |
|---|---|---|
| `steps[].ms` | 该项自己的耗时 | 人类输出左栏 |
| `workMs` | 本进程内耗的毫秒数（不含 Node 启动） | `--json` |
| `bootMs` | `performance.timeOrigin` 到 `main` 开始，即 Node 自己的启动成本 | `--json` |
| `wallMs` | `bootMs + workMs`。**这才是与 1000 ms 上限对账的数** | 人类输出的「合计」与测试 |

只报 `workMs` 会让「1000 ms 上限」变成一句自欺的话（用户 `time` 量到的是 `wallMs`）。

**截止时刻挂在 `performance.timeOrigin` 上**，不是挂在 `runDoctor` 开始处。
理由：全量测试并发跑时本机实测 Node 启动被拖到 700–800 ms；若截止时刻从「import 全部
完成之后」再算 920 ms，doctor 会在启动已经很贵的情况下**再**花掉一整份预算 ——
实测 `wallMs` 1683 ms。把两段成本算进同一个预算，剩下的时间才是真可用的。

**预算不够时不许假装查过**：剩余时间 < 150 ms 就不查，`gate` / `watcher` 两项
各自印「预算内没时间跑（剩 Nms / 预算 Mms）—— 直接跑原命令」。这是 ADR-0002 的诚实降级，
不是静默留空。

**枚举也分段**：transcript 计数到 400 ms（且不越过截止时刻）就停，
`facts.enumeratedFully: false`，人类输出写「N 个（未完）项目」/«M 份 .jsonl（下限）»
—— 到点还没数完的如实说没数完。

---

## 5. 复用清单：本入口一份判据也不重写

| `doctor` 的项 | 事实来自 | 怎么问 |
|---|---|---|
| `node` | `process.version` + `typeof import.meta.dirname` + `typeof process.getBuiltinModule` | 直接读 |
| `transcripts` | `tui-meta.mjs` 的 `projectsRoot(env)`（唯一认 `CLAUDE_PROJECTS_DIR` 的入口） | 直接读 + `stat`/`readdir` |
| `sources` | `<claudeDir>/jobs`、`<claudeDir>/sessions` 的存在与计数 | 直接读 |
| `claude/` | 仓库 `.claude/agents`、`.claude/skills`、`.claude/settings.local.json` | 直接读 |
| `gate` | **`pre-write-gate.mjs` 导出的 `cli(['status', '--cwd', <repo>])`** | **进程内调用**（截获它自己的 stdout） |
| `watcher` | 安装状态：`install-watcher.mjs` 的 `launcherPath(repo)` / `shortcutPath(env)`；存活判定：**`node scripts/watch.mjs --health`** | 前者进程内，后者 **spawn**（见 §5.1） |
| `platform` | `notify.mjs` 的 `isNotificationAvailable()`、`install-watcher.mjs` 的 `startupDir(env)` | 直接读 |

取词只做**去字形**（`✓ ✗ ⚠ ● ○` 与 `**`）和**按键名取值**，不做判定：
拿不到就印「未认出」或原样转发，**绝不编一个不存在的字段**。

> 为什么不能重写这几份判据：`../research/2026-11-14-gate-widening-redteam.md` §4 记录的是
> 同一个「已读」问题出现三份口径（闸门 / 重放器 / 探针）、三份都自称正确、其中两份漂移。
> 判据的第二份实现永远比第一份少测。规矩：这里的每一行都必须是**既有函数/命令的原文**或
> **一次 `stat`/`readdir` 的直接结果**，不得出现「我认为它算不算通过」。

### 5.1 ⚠ `watch.mjs` 只能 spawn，不能 import —— 本文件踩过的坑

`watch.mjs` 的「我是不是被当 CLI 跑的」判据是 `/watch\.mjs$/.test(process.argv[1])`，
而本入口叫 **`over**watch.mjs`，**以 `watch.mjs` 结尾**。

于是 `await import('./watch.mjs')` 会让它认为自己是主模块并**当场启动守护进程**。
实测后果：`doctor` 的输出里混进 `watch 启动 dir=… tick=15000ms`，然后进程**永不退出**
（守护进程的定时器还活着）—— 一个自检命令把自己变成了守护进程。

所以：`watcher` 的存活判定走 **spawn**（`argv[1]` 是 watch.mjs 自己的路径）。
`scripts/overwatch.test.mjs` 里有一条 `★` 标记的测试专门钉这件事，判据是
「输出里不许出现 `watch 启动` / `tick=Nms` / `candidates=N`」。

另外两个模块的判据不匹配 `overwatch.mjs`，import 安全：
`install-watcher.mjs` 比**解析后的路径**，`pre-write-gate.mjs` 比 `pre-write-gate\.mjs$`。

### 5.2 为什么 `gate` 在进程内、`watcher` 在 spawn

| 项 | 方式 | 单次成本（本机实测） |
|---|---|---|
| `gate` | 进程内调 `cli()` | **4 ms**（spawn 要 210–350 ms） |
| `watcher` | spawn `watch.mjs --health` | 300–350 ms（不能不 spawn，见 §5.1） |

早期版本两项都 spawn，实测墙钟稳定在 1000 ms 边缘 —— 那 900 ms 里 800 ms 是
「启动 Node 去问一个 4 ms 的问题」。把 `gate` 移进进程内后，报告值降到 500–740 ms。

`--cwd` 必须显式传给 `cli()`：它默认读 `process.cwd()`，而 `doctor` 的语义是
「在**本仓库**里问闸门」。不传的话，用户在别的目录敲 `node <repo>/scripts/overwatch.mjs`
会去问那个目录的标记与密钥 —— 同一份输出两个答案。

### 5.3 `doctor` 只读

`watch.mjs` 的 `loadState()` 在 `state.json` 解析失败时会把文件**改名留证**
（`*.corrupt-<ts>`）。那对守护进程是对的，对一个自检命令不是。

所以 `doctor` **不调 `loadState`**：先自己确认文件不存在 / 能 `JSON.parse`，
读不出就如实报「state.json 读不出或不是合法 JSON —— 未改动它」，并且
**不说「没有在工作」**（那是把「没数据」说成「坏了」）。

两条测试钉住它：① 空 state 目录里跑完 doctor 后目录内容不变；② 损坏的 `state.json`
不被改名，`facts.stateNote` 说出原因，`text` 里不出现「没有在工作」。

---

## 6. 子命令：只路由，不代跑

| 子命令 | 退出码 | 原生命令 | 路由文案必须说的事 |
|---|---|---|---|
| `scan` | **4** | `node scripts/scan-sessions.mjs --days 3` | 参数无转化，直接跑；默认窗口 7 天 |
| `verify` | 4 | `node scripts/verify-claims.mjs` | `--days` 在这里按**文件 mtime**，`scan` 按 transcript 内部时间；两个口径不同，本入口不统一 |
| `tui` | 4 | `node scripts/oversight-tui.mjs` | 非 TTY 自动降级为纯文本；`--plain` 是显式要求 |
| `watch` | 4 | `node scripts/watch.mjs --inbox` / `--health` | `--inbox` 只读通知历史，**首跑必空**；那是历史为空，不是宿主没有 blocked 会话 |
| `plan` | 4 | `node scripts/render-plan.mjs` | 渲染器不存在时明说「还没做，不是坏了」 |

**为什么退出码是 4 而不是 0**：脚本化调用方（CI / wrapper）必须能区分「跑完了」与
「只是告诉你去跑原命令」。用 0 会让 `overwatch scan` 在管道里看起来像成功执行过扫描。

**为什么不做真 wrapper**：`scan` / `verify` 的参数语义本身就互相冲突（见上表第二行），
一个「统一了参数」的 wrapper 只能靠**替用户选一个口径**，而那个选择不会有第二份判据来测它。

子命令之后的参数**原样接在第一条原生命令后面并打印出来**，但**不执行**。
若原生命令自己已带同名参数（如 `scan --days 3` 对 `scan --days 1`），不叠加 ——
两个窗口并列会让读者猜哪个生效。

---

## 7. `--help` 必须立刻退出

`--help` / `-h` / `help` 在最前面判、立即 `return`，**不做任何一项检查、不起任何子进程**。

| 判定 | 方式 |
|---|---|
| 退出码 0 | 三条测试 |
| 输出里没有 `查 N 项前提`、没有 `[ Nms]`、没有 `数据目录` | `--help 立刻退出、退出码 0、且不跑 doctor` |
| 在「坏 transcript 根」的机器上仍是 0 | `--help 在有坏 transcript 根的机器上也 exit 0` |
| 比一次 `doctor` 快 | `--help 比一次 doctor 明显快` |

后两条是刻意的：`--help` 的失败模式不是「打印得不好」，是**顺手做了检查**然后因环境而失败。
本仓库吃过这个亏 —— `node scripts/scan-sessions.mjs --help` 会把 `--help` 当普通参数
直接全量扫描（实测 43 秒）。

---

## 8. 退出码表（每个码只有一个含义）

| 码 | 含义 | 典型场景 |
|---|---|---|
| 0 | 前提都读到了 | 正常机器 |
| 1 | **本入口自己出了意外**（bug，不是环境问题） | doctor 抛异常；stderr 会写明「这是 bug」 |
| 2 | transcript 根**不存在** | 干净机器，还没用过 Claude Code |
| 3 | transcript 根**在、但读不出** | 权限 / 不是目录 / 枚举失败 |
| 4 | 该子命令**未实现**（已打印原生命令） | `scan` / `verify` / `tui` / `watch` / `plan` |
| 5 | 用法错误 | 未知子命令 / 未知选项 / 参数缺值 / `--budget` 非正数 |

**参数解析的两段式**（这是「退出码 5」的全部来源）：

- 本入口自己的四个选项 `--help` / `--json` / `--now` / `--budget` **位置无关** ——
  `doctor --json` 与 `--json doctor` 是同一句话。
- 子命令**之前**的未知选项 → 退出码 5（用户真的敲错了）。
- 子命令**之后**的一切 → 原样收进 `rest`，不解释（它们是目标命令的参数）。

审计实测 `scan --bogus-flag` 静默照跑、`--days` 缺值静默回落 7 天 ——
「静默回落」是这类 CLI 最贵的缺陷：用户以为自己改了窗口。

---

## 9. 可复现性

`--now <ISO>` 注入参考时刻，影响「最新一份多旧」的计算。不注入时取 `Date.now()`。

时间差一律 `max(0, now - past)` —— **本入口不产生负数**。
审计里 `idle=-7s` 那个负数是 `scan-sessions` 的 `nowMs` 取样时机造成的（扫到一半
新写入的 transcript 时间戳晚于它），不是「时钟倒流」；`doctor` 只有「现在 - 过去」一种减法。

`--budget <ms>` 压低预算用于测「预算内没跑完」分支。它不是性能调参旋钮：
默认 1000 ms 是设计约束，改它只用来验证诚实降级。

---

## 10. 已知边界（不打算做）

| 不做 | 理由 |
|---|---|
| 真实现 `scan` / `verify` / `tui` / `watch` 的 wrapper | 这些命令的参数语义互相冲突（§6）；wrapper 必须替用户选口径，而那个选择没有第二份判据测 |
| 检查 transcript 的**形状**（`tool_use` 的 JSON 结构是否漂移） | 那需要读全量语料，与 1000 ms 预算直接冲突；属于 `probe-parser-divergence.mjs` 的职责 |
| 判定「状态是否健康」 | 本入口只报事实。审计的第一条结论就是：一个 ✓ 会让人停止思考，而「读到了 451 份 .jsonl」不会 |
| 替代 `check-structure.mjs` / 全量测试 | 那是提交前的硬门，面对的是**改代码的人**；`doctor` 面对的是**刚装完的人** |

---

## 11. 与其它文档的关系

- `docs/CAPABILITIES.md`：`overwatch.mjs` 的能力行**由主线程统一登记**（本文件不代改，
  避免与并行 Agent 冲突）。登记时应写 `node scripts/overwatch.mjs`（无参数）与
  `node scripts/overwatch.mjs doctor`。
- `README.md` 的「30 秒上手」：建议把第一条命令换成 `node scripts/overwatch.mjs`，
  它比 `scan` 快两个数量级且不需要任何前提 —— **同样由主线程统一同步**。
- `docs/GUIDE.md`：`doctor` 是「出问题了怎么办」之前那一步，即「先确认前提」。
