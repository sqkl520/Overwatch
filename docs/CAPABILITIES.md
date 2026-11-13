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
| 扫全部会话，压成一张可排序的表 | `node scripts/scan-sessions.mjs --days 3` | 每个会话一行：状态 / calls / novelty / idle / reason |
| 机器可读的同一份数据 | `node scripts/scan-sessions.mjs --json` | `sessions[]`，TUI 与下游脚本的输入 |
| 透传宿主的 `needs` / `suggestedReply` | `node scripts/scan-sessions.mjs --days 3` | `[BLOCKED]` 行下面的「等待输入 / 建议回复」两行 |
| 只列出**此刻在等你**的 | `node scripts/watch.mjs --inbox` | 后台已发现的等待/失败条目，带宿主原话 |
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
| 全量回归测试 | `node --test scripts/*.test.mjs` | 全绿；条数以命令输出为准 |
| 文档相对链接不悬空 | `node scripts/check-links.mjs` | 断链数，非 0 即失败 |

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
| 3. 开启拦截 | shell 里设 `OVERWATCH_STOP_VERIFY=block`（**不写进 settings 的 env**，见模板里的说明），重启会话 |
| 4. 看效果 | `node scripts/analyze-hook-samples.mjs` 看放行样本；`jsonl` 里 `outcome=blocked` 是拦住的那几次 |

设计取向（按对用户的伤害排序，详见脚本头注释）：

- **fail-open 且不可配置成 fail-closed**：hook 崩了、超时、输入是垃圾、transcript 读不到——一律放行。挡死一个会话比放过一个假完成更糟。
- **只拦「证据不足」，不拦「证据矛盾」**：`NO_EVIDENCE` / `STALE_ONLY` / `FAILED_ONLY` 拦；`UNKNOWN` / `UNCHECKABLE` 不拦——没读到不等于没做。
- **自设拦截上限 6 次**，不依赖宿主的 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`（那是实现细节，会随版本变）。
- **后台任务在跑就不拦**：`background_tasks` 非空意味着它在等活干完，结束回合是正常的。

依据：`docs/research/2026-11-12-stop-hook-prototype.md`（拦得住）、`2026-11-12-stop-hook-e2e-validation.md`（真模型上很少有机会拦）、`2026-11-13-hook-sample-logging.md`（先攒样本，不急着加规则）。

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
