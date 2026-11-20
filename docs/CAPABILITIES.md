# 能力清单：每条声称对应一条能跑的命令

> 这份文件的唯一目的：让 README 里「能做 / 不能做」不再是**靠人相信**的话。
> 每一条「能做」都必须绑到一条**现在就能跑**的命令；跑出来的东西要能支持那句话。
>
> **硬门会检查这张表**（`check-structure.mjs` 的 `checkCapabilities()`）：脚本必须存在、
> 参数必须被该脚本认。它不能证明「输出支持这句声称」——那要你自己读一遍输出。
> 但它能挡住最坏的一种：能力还在 README 里承诺，脚本已经删了或改了名。
>
> 加一条能力 = 加一条命令 + 在 README「核心能力」表里加一行。加不出命令的能力，
> 要么是还没做完，要么本来就不该写进 README。

## 1. 能做（每条都有命令）

| 能力 | 命令 | 你看什么 |
|---|---|---|
| **自检：这台机器能干什么、缺什么**（唯一入口，不加参数即此） | `node scripts/overwatch.mjs` | 8 项前提事实，每行只说读到什么，不出红绿灯；空（exit 2）与坏（exit 3）分开 |
| **起一个挂了载荷的会话** | `node scripts/overwatch.mjs launch` | 交互式会话，载荷是本仓库的 `.claude/`，工作目录是你的项目。**挂几个取决于 `agent.roster`**，随附配置只启用 3 个 |
| 先看会挂上什么，不执行 | `node scripts/overwatch.mjs launch --dry-run` | 载荷 / roster / 两条 hook / 逐字命令行 |
| **只验载荷挂对没有**（不需登录、不需推理） | `node scripts/overwatch.mjs launch --verify` | 宿主列出的角色与 `git` 跟踪的**源定义**（12 份）逐个对；缺一个即非零退出。**验的是源目录完整，不是实际挂载数** |
| 在你自己的项目里用（载荷不变，工作目录变） | `node scripts/overwatch.mjs launch --cwd <你的项目>` | 上面同一条，只是 `--cwd` 指过去 |
| 扫全部会话，压成一张表（顺序固定：先按状态，同状态按闲置时长降序） | `node scripts/scan-sessions.mjs --days 3` | 每个会话一行：状态 / calls / novelty / idle / reason。**没有 `--sort` 参数** |
| 看某个命令怎么用（不执行） | `node scripts/scan-sessions.mjs --help` | 用法与退出码；0.4 秒返回，**不做任何扫描** |
| 机器可读的同一份数据 | `node scripts/scan-sessions.mjs --json` | `sessions[]`，TUI 与下游脚本的输入 |
| 透传宿主的 `needs` / `suggestedReply` | `node scripts/scan-sessions.mjs --days 3` | `[BLOCKED]` 行下面的「等待输入 / 建议回复」两行 |
| 只列出**此刻在等你**的 | `node scripts/watch.mjs --inbox` | 后台已发现的等待/失败条目，带宿主原话。**退出码**：0 = 确实没有要处理的；**3 = 空但守护进程没在跑**（这个「空」不可信，它会直说并给你拿到真实状态的命令） |
| 面板：列表 → 详情 → 复制接力草稿 | `node scripts/oversight-tui.mjs` | 列表页按 `Enter` 进详情、按 `c` 复制草稿 |
| 面板的纯文本快照（非 TTY / CI） | `node scripts/oversight-tui.mjs --plain` | 打印一次即退出，无 ANSI |
| 把完成声明与支持它的工具调用配对 | `node scripts/verify-claims.mjs` | `SUPPORTED` / `STALE_ONLY` / `FAILED_ONLY` / `NO_EVIDENCE` / `UNKNOWN` |
| 只查一个会话的断言 | `node scripts/verify-claims.mjs --session <id前缀>` | 该会话每条断言的判定与时间线 |
| 解释某条断言为什么这么判 | `node scripts/verify-claims.mjs --explain 1` | 命中的调用、最后一次源码编辑、判定理由 |
| 断言核对接 CI（有问题即非零退出） | `node scripts/verify-claims.mjs --days 7` | 退出码 1 = 存在 `NO_EVIDENCE` / `FAILED_ONLY`（默认行为；`--exit-zero` 可强制 0） |
| 停机原因的结构判定（不读语义） | `node scripts/stop-signals.mjs` | `ERROR_STOP` / `STOPPED_SILENT` / `QUESTION_TEXT` 分布 |
| 「问了没答」的会话（不依赖宿主） | `node scripts/asked.mjs --hours 1` | 问了具体问题、人还没回的会话 |
| 人工介入基线：把「介入变少」变成可证伪的数字 | `node scripts/measure-interventions.mjs --days 7` | 介入总数、按类型/按可避免性分级、每会话分布 |
| 人工介入基线的机器可读版 | `node scripts/measure-interventions.mjs --json` | `totals` / `distribution` / `rates` |
| Stop hook 验证闸：AI 想收工时替你把关 | `node scripts/stop-verify-hook.mjs`（由宿主调用，见 §3） | 判定写进 `tasks/runs/stop-hook/<日期>.jsonl` |
| 看 Stop hook 放行样本的分布 | `node scripts/analyze-hook-samples.mjs` | 含完成语义但一次测试都没跑的候选 |
| 后台守护进程的健康度 | `node scripts/watch.mjs --health` | 各轮询层「多久没扫过」，判断是活着还是在空转 |
| 通知的可追溯率（生产指标） | `node scripts/watch.mjs --trace` | 每条通知能不能追到一次真实事件 |
| 开机自启 + 桌面通知（Windows） | `node scripts/install-watcher.mjs status` | 已安装 / 未安装（`install` / `uninstall` 同理） |
| 结构硬门（改动后必跑） | `node scripts/check-structure.mjs` | 0 违规才绿；含测试数对账、文档路径、能力清单 |
| 产出对账：子 agent 说产出的东西，磁盘上在不在 | `node scripts/claim-ledger.mjs verify --run <run-id>` | `COMPLETE` / `PARTIAL` / `MISSING` / `CONFLICT` 等逐任务结论 |
| 从 transcript 抽子 agent 的写入痕迹（不需要它配合） | `node scripts/claim-ledger.mjs observe --run <run-id> --session <会话目录>` | 每条写文件的调用（`Write`/`Edit` + 路径可确定解析的 Bash 写入），含失败的调用，并打印「判不出」的逐类计数 |
| 全量回归测试 | `node --test scripts/` | 全绿；条数以命令输出为准 |
| 文档相对链接不悬空 | `node scripts/check-links.mjs` | 断链数，非 0 即失败。范围是 `git ls-files '*.md'`（实测 170 份，含根级与 `templates/`），判据在 `scripts/link-check.mjs`：文件在不在、锚点在不在、目标会不会被 gitignore 掉 |
| 生成仓库社交预览图（1280×640） | `node scripts/make-social-preview.mjs --out docs/assets/social-preview.png` | 一张 PNG；GitHub 的 social preview 没有 API，要人工上传 |
| 清单机制在真实使用中覆盖多少 | `node scripts/measure-checklist-coverage.mjs --days 7` | 派发率 / 清单率两个口径（含沙箱、不含沙箱）。**数字低不是缺陷，是「加闸值不值得」的依据** |
| 把 Stop 闸改成 block 会拦多少个真实会话 | `node scripts/replay-stop-gate.mjs --days 30` | 三档：全部 / 非沙箱 / **★ 会真的跑闸（真实项目 + 主会话）**。**只看 ★ 那一行** —— 子 agent transcript 不产生 Stop 事件，混进去会把拦截率虚高数倍 |

> 想确认某个数字：跑对应命令，**不要相信任何文档里写死的秒数/占比**。
> 扫描耗时、命中率、token 用量都随语料增长而变，见 `docs/research/README.md`「互相矛盾的地方」。

## 2. 不能做（附依据，不是没做完）

| 不能做 | 依据 | 哪份文档说清了为什么 |
|---|---|---|
| 实时干预运行中的会话 | 宿主的 `--resume` 对运行中会话是拒绝或分叉；跨会话通道强制标注来源 | `README.md`「为什么不能自动接力」、`docs/adr/0001-config-only.md` §代价·3 |
| 自动把回复发进目标会话 | 同上；`relay.deliver` 只有 `manual` 一个合法值 | `docs/spec/relay-protocol.md` §6 |
| 判断「改得对不对」 | 那需要读语义与业务意图，超出「断言 vs 证据」的判据范围 | `README.md` 核心能力表「不能做」列 |
| 从「停了很久」推断失败 | 该推断 2026-10-31 全语料实测后已删除：6308 次大间隔里 94.8% 之后仍有工具调用 | `docs/spec/state-model.md` §2.0.1 |
| 保证 AI 没在别处撒谎 | 只核对末条 assistant 文本里的可核对断言，不覆盖没写进文本的事 | `README.md`「唯一站得住的差异」 |
| 给前台交互会话贴真实 token 数 | 宿主不落盘前台会话的 token；编一个估算值违反「不得伪造精确数字」 | `docs/spec/state-model.md` §7 |
| 在线判定「这次停止是问句还是结束」 | 要判得看下一句，而在线时下一句还没发生（实测 95.4%→100% `UNCLASSIFIABLE`） | `README.md`「已知局限」 |

## 3. Stop hook 验证闸：怎么开、默认是什么

**默认关闭。** 不设环境变量时，`stop-verify-hook.mjs` 只**记账、永远放行**，不会拦住任何会话。

| 步骤 | 做什么 |
|---|---|
| 1. 注册 hook | 把 `templates/stop-verify-hook.settings.json` 合并进 `.claude/settings.local.json`（本机私有），把 `command` 换成你机器上本仓库的绝对路径 |
| 2. 观测模式（默认） | 不设环境变量。跑几次后看 `tasks/runs/stop-hook/<日期>.jsonl`，确认它对你的用法没误判 |
| 3. 开启拦截 | 见下方「怎么开才对」——**桌面版必须写进 `settings.local.json` 的 `env` 块**，shell 环境变量传不到 |
| 4. 看效果 | `node scripts/analyze-hook-samples.mjs` 看放行样本；`jsonl` 里 `outcome=blocked` 是拦住的那几次 |

### 怎么开才对（2026-11-18 更正）

模板和上面这行此前都写「在 shell 里设 `OVERWATCH_STOP_VERIFY=block`，**不要**写进 settings 的 env」。
**那个建议在桌面版上不成立。**

hook 进程的环境变量继承自**宿主进程**，不是你的终端。桌面版从 Start Menu / 快捷方式启动，
它的环境里没有你 shell 里 `export` 的东西 —— 于是「设了变量、重启会话」之后
`jsonl` 里 `mode` 仍然是 `off`，而**没有任何东西会提示你开闸失败了**。
这个失效方向最坏：你以为闸开了，其实一直是观测模式。

正确做法（本机已验证）：

```json
// .claude/settings.local.json（gitignored）
{
  "env": { "OVERWATCH_STOP_VERIFY": "block" },
  "hooks": { ... }
}
```

原建议的顾虑是「写进 settings 太容易忘，改了不记得改回来」——那个顾虑是真的，
但它换来的是「根本开不起来」，代价更大。想临时关掉用**叫停路径**（下面三条），
不要靠删 `env` 那一行。

**实测（2026-11-18，47MB transcript，真实主会话）**：
- 无证据的完成声明 → 输出 `{"decision":"block", reason:...}`，exit 0
- 同一输入 + `%LOCALAPPDATA%/Overwatch/stop-hook.PAUSE` 存在 → 无输出（不拦）
  （该次实测时叫停文件只认旧目录名；2026-11-21 起 `UntilDone/` 与 `Overwatch/` **任一存在即生效**，见 `DF-041`）
- 同一输入 + `stop_hook_active:true` → 无输出（不拦，防循环）
- 每次判定耗时 **374–445ms**

设计取向（按对用户的伤害排序，详见脚本头注释）：

- **fail-open 且不可配置成 fail-closed**：hook 崩了、超时、输入是垃圾、transcript 读不到——一律放行。挡死一个会话比放过一个假完成更糟。
- **只拦「证据不足」，不拦「证据矛盾」**：`NO_EVIDENCE` / `STALE_ONLY` / `FAILED_ONLY` 拦；`UNKNOWN` / `UNCHECKABLE` 不拦——没读到不等于没做。
- **自设拦截上限 6 次**，不依赖宿主的 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`（那是实现细节，会随版本变）。
- **后台任务在跑就不拦**：`background_tasks` 非空意味着它在等活干完，结束回合是正常的。

依据：`docs/research/2026-11-12-stop-hook-prototype.md`（拦得住）、`2026-11-12-stop-hook-e2e-validation.md`（真模型上很少有机会拦）、`2026-11-13-hook-sample-logging.md`（先攒样本，不急着加规则）。

## 3.5 写前闸的 `ask.minQuestionsBeforeWrite`：第一次写之前先问够 N 个问题

**默认 `0` = 这条判据完全不存在。** 装上写前闸的现有项目升级后行为**逐字节不变**
（测试用「0 时连 transcript 都不读」钉住了这一点，不是看代码里有没有 `if`）。

`N > 0` 时：第一次写文件之前，transcript 里必须已经有 ≥N 个**去重后**的问题
（`AskUserQuestion` + `ExitPlanMode`，判据实现是 `pre-write-gate.mjs` 的 `isAskToolName()`）。
**注意三处判据并不统一，如实列出**：

| 模块 | 认哪些 | 与闸门是否一致 |
|---|---|---|
| `pre-write-gate.mjs`（本条判据） | `AskUserQuestion` + `ExitPlanMode`（大小写敏感） | — |
| `measure-ask-vs-tell.mjs` | 同两个名字，但先小写化再比较 | 行为等价（宿主给的工具名大小写固定） |
| `question-audit.mjs` | 主分支**硬编码只认 `AskUserQuestion`** | **不一致**：只有 `ExitPlanMode` 的会话，闸门数 1、审计数 0 |

此前这里写「三处一处口径」——**那句话是假的**，`measure-ask-vs-tell.mjs` 根本没 import
`isAskToolName`，`question-audit.mjs` 的主分支也不走它。2026-11-20 独立验收判 FAIL 时指出。
只判**第一次写** —— 写过就不再判，写到一半才拦会打断正在进行的活。
「写过」的定义是**真写成过**：该调用的 `tool_result` 存在且不是错误。
被闸门拒掉的那次写不算（否则「拒 → 重试」会把判据自己解除）。

**子 agent 不参与这条判据**（直接放行，日志记 `questions:"subagent-exempt"`）。
理由是硬的：`oversight-executor` / `oversight-repair` 的工具白名单里没有 `AskUserQuestion`，
被拒后它物理上做不到 reason 要求的事；而且子 agent 的调用 `transcript_path` 指向主 transcript，
拿主 transcript 的计数去判子 agent 的第一次写，判的是别人的账。

| 步骤 | 做什么 |
|---|---|
| 1 | 先把写前闸按 `templates/pre-write-gate.settings.json` 装上（见该文件的 `_how_to_enable`） |
| 2 | 在**你的项目根**的 `overwatch.config.json` 的 `ask` 段写 `"minQuestionsBeforeWrite": 3` |
| 3 | 临时试跑不改文件：环境变量 `OW_ASK_MIN_QUESTIONS=3`（**优先于**配置文件） |
| 4 | 确认它真的生效：`node scripts/pre-write-gate.mjs status --cwd <你的项目>` |

```json
// <你的项目根>/overwatch.config.json —— 只写这一段也能生效，其余键走默认
{ "ask": { "minQuestionsBeforeWrite": 3 } }
```

```powershell
# 临时试跑（不改任何文件）。桌面版的 hook 继承宿主进程的环境，
# 所以这个变量要设在「启动 claude 的那个环境」里，不是设在你的终端里。
$env:OW_ASK_MIN_QUESTIONS = "3"
node scripts/pre-write-gate.mjs status --cwd D:\你的项目    # 看 minQuestions 一行
```

**它和另外两条判据的关系**（三条独立、各自 deny、各自给 reason）：

| 顺序 | 判据 | 什么时候放行 |
|---|---|---|
| 0 | `minQuestionsBeforeWrite` | 问够了 N 个不同问题，或**这个会话真写成过文件**，或这是子 agent（有 `agent_id`） |
| 1 | Edit 侧：`target-read` | 读过**这个文件本身** |
| 2 | Write 侧：`minReads` | 读过 ≥N 个**不同**文件 |

叫停路径与另一条闸**共用同一族文件**（`DF-041`，2026-11-21 起）：
任一存在即放行，主路径在前。

| 顺序 | 路径 | 语义 |
|---|---|---|
| 1 | `$OVERWATCH_STOP_VERIFY_PAUSE` | 显式指定。给了就**只有**这一条生效，不叠加 |
| 2 | `$OVERWATCH_STATE_DIR/stop-hook.PAUSE` | 本仓统一的临时区变量，两个 hook 与 `hook-dedupe` 都认 |
| 3 | `%LOCALAPPDATA%/UntilDone/stop-hook.PAUSE`（POSIX：`$XDG_STATE_HOME/untildone/`） | 主路径 |
| 4 | `%LOCALAPPDATA%/Overwatch/stop-hook.PAUSE`（POSIX：`…/overwatch/`） | **向后兼容，不许删** |

本次判定命中的是哪一条，会记进台账的 `pauseHit` 字段；
`node scripts/pre-write-gate.mjs status --cwd <项目>` 会把四条路径全部列出并标出命中项。
刹车也共用同一份 `brake` / `denyBudget`，没有第二个预算。

**它为什么默认关、以及这条判据的诚实边界**：

- 判的是**数得清的次数**，不是「问得准不准」。问三个敷衍的问题照样能过闸 ——
  这一条本仓库判不了（需要语义理解），见 `docs/spec/2026-11-14-question-audit.md` §8。
- 只判**第一次写**。前半场没问、写到一半才想清楚方向 → 这条闸不会再出现。
- 形态不可读的提问（`questions` 是坏 JSON，实测 6/197 次）**不参与判定**：
  解析失败 ≠ 没问，把它当 0 会拦一个按规矩做了的会话。
- transcript 读不到、配置是垃圾、键值超范围 → 一律回落到 `0`（不拦）。
- **长会话不会永久锁死。** 尾窗口（默认 1 MB）里一个提问都没有时，闸门会**向前回扫**，
  最多到 `OW_PRE_WRITE_GATE_TRANSCRIPT_SCAN_BYTES`（默认 8 MB，实测 213 ms）。
  **够数即停**：`need` 满足时只付 1 MB 那一档（本机 8 MB 会话实测 35.5 ms / 1 块）。
  扫到上限仍不够 → **放行**并在日志记 `scanTruncated:true`；任何一块解析失败或块边界
  无法对齐，同样记 `scanTruncated:true` —— **读得不完整就明确说出来**，不报一个假的
  「读完了、没问题」。块边界**对齐到行首**（跨边界的整行会拼回来解析一次），
  不会因为一行跨在 1 MB 边界上而静默消失。
  「没有证据在窗口里」永远不等于「没问过」。本机实测：172 个 >1 MB 会话里
  49 个的提问全部落在尾窗口之外（最大 102.9 MB / 全文 9 问 / 尾内 0 问）——
  不回扫的话这些会话在 `brake=halt` 下**无解**。
- 走 `mark` 逃生口（或标记已存在）的会话不受这条约束 —— 逃生口的意义就是「我知道我在干什么」。
- **子 agent 直接放行。** 见 §3.5 开头的理由；日志 `questions` 记 `"subagent-exempt"`。

## 4. 断言族：`verify-claims.mjs` 认哪些「完成声明」

`vague-completion` 是 2026-11-13 新增的一族，专治**没有任何指标的**完成声明——
「修好了」「搞定了」「已完成」，这类恰恰是最需要证据的一类。

| 族 | 认什么 | 有没有确定性证据源 |
|---|---|---|
| `test-count` | 数字 + 测试语汇（`All 10 tests pass`） | 有 |
| `build` | `构建/编译` + `成功/通过` | 有 |
| `file-count` | 数字 + `文件` | 有 |
| `artifact-hash` | 7–40 位 hex | 有 |
| `commit` / `push-remote` / `pr-ci` | 具体子命令 / 远端名 / CI 结果 | 有 |
| `runtime-probe` | 服务/端口 + `启动/监听` | 有 |
| `todos` | 「待办清空 / 全部完成」 | **无**（`checkable:false`，不参与四档比例） |
| `vague-completion` | `修好了 / 已完成 / Done` 等无指标声明 | 有（要有一次验证类调用） |

`vague-completion` 的取向与 `test-count` 相反：**宁可窄**。漏掉一个吹牛只损失一条统计；
误拦一个诚实的会话会逼用户每次结束都去跑测试，最后干脆把 hook 关掉。

已知未修：**`已 + 动词 + 冒号`** 形态仍漏（`已全部修好：`）。
这是刻意不修的——6 个样本撑不起一条新正则，先由 `analyze-hook-samples.mjs` 攒分布。
依据：`docs/research/2026-11-13-vague-claim-detection.md`、`2026-11-13-hook-sample-logging.md`。

## 5. 维护规则

1. **加了能力 → 这里加一行，README「核心能力」表加一行。** 两处都要有，缺一个硬门不管（它查的是本文件的命令、README 的入口）。
2. **删了脚本或改了参数 → 先跑 `node scripts/check-structure.mjs`。** 它会在这里红，逼你同步。
3. **写「不能做」必须附依据路径。** 没有依据的「不能做」是懒惰，读者会以为是没做完。
4. **本文件自己也会过期。** 它引用的命令由硬门把关，但它引用的**结论**（某一族判得准不准）不会——那要去 research 索引看状态。
