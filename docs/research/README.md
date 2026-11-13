# 研究存档

> 这里 66 份报告（截至 2026-11-13，不含本页）是**过程记录**，不是当前事实。
> 每一份都写于当时那份语料、那个宿主版本、那段代码上。语料在长、代码在改、结论会过期。
>
> **引用任何结论前，先查本页的状态标记。**
>
> 索引建立于 2026-11-13，判定依据是**后续报告里的反驳**或**本机重跑**，逐条写在「依据」列。
> 凡我实测过的，写「本机实测」；凡只能靠后续报告推断的，写报告名。
>
> 报告份数不写死：**实际份数 = `docs/research/` 下除本页外的 `.md` 个数**，
> 由 `check-structure.mjs` 的 `checkResearchIndex()` 保证每一份都在本页登记过。

## 怎么用这一页

| 符号 | 含义 | 引用时怎么办 |
|---|---|---|
| ✅ 有效 | 结论仍成立，关键数字已复核 | 可以直接引用，但注意语料规模会变 |
| ⚠️ 部分失效 | 主结论成立，但有具体数字/细节被推翻 | **只引主结论，不引被推翻的那个数** |
| ❌ 已推翻 | 结论错误，有后续证据反驳 | **不要引用**，见下一节的正确说法 |
| ❓ 未验证 | 只是提出，没实测 | 只能当假设，不能当依据 |

## ⚠️ 已被推翻的结论（不要引用）

| 报告 | 曾经的结论 | 为什么错 | 正确的说法 |
|---|---|---|---|
| `2026-11-02-deterministic-signals.md` | 确定性判据只覆盖 **10.6%**；**43.5%** 必须靠语义 | 红队逐条复算：确定性可判的真实大块是「错误停机 34.6%」，被算进了「剩下的 89.4%」；43.5% 那类是**工具执行**问题不是语义问题，其中 15/23 根本没跑测试 | 纯结构可判 **34.6%–36.4%**；真需要语义 **4.3%–5.3%**（`2026-11-02-redteam-deterministic.md`） |
| 同上 | 停机时「在等人做决定」但**不带问号** = **115/115（100%）** | **同义反复**：`classifySession` 先把问号结尾的分到 `QUESTION_TEXT`，再在 `STOPPED_SILENT` 里数它，恒等于 100% | 全库实际命中 37–38 次，放宽「结尾」定义后 68 次 |
| 同上 | 死循环 **2/188** | 只扫了尾部 512KB。全文件扫描命中 **31.7%** | 判据两头都不准，不要用这个数 |
| `2026-11-02-redteam-deterministic.md` | 15 个会话「声称测试通过但没跑」 | 测试命令正则 `mvn\s+` 匹配不到本机实际用的 `mvn.cmd`；4 个真有测试的被算成「无调用」。且 15/24 的分母口径在两份文档里不一致 | 全量 228 会话里 `NO_EVIDENCE` 只有 **1 个**（`2026-11-03-verify-claims.md` §五） |
| `2026-10-31-online-classification.md` | 在线模拟下 `UNCLASSIFIABLE` **87.7%** | 作者自认：`TOOL_USE_OTHER` 这个桶是模拟时自己编的，`KINDS` 里没有 | 用真实分类器跑同样 146 个末态 = **100% `UNCLASSIFIABLE`** |
| `2026-10-30-hosted-automation.md` | 「本库不能自动接力」**结论不成立**，能自动投递 | 通道通 ≠ 能投递。真实投递实测：消息被 `hold` 扣住，接收方无回音、transcript 零痕迹。复核 Agent 判 `UNPROVEN`，成功投递样本 **n=0** | 默认配置下**投递不可用**；通道可达但卡在策略闸门（`2026-11-01-relay-delivery-probe.md`、`2026-11-02-path-a-recount.md`） |
| 同上 | `--resume` 运行中会话会「产生副本」 | 把 `--fork-session` 的行为安到了 `--resume` 上。实际是**拒绝**，只有显式 `--fork-session` 才分叉 | `2026-10-30-hosted-automation.md` §2.1 已自我更正 |
| `2026-11-02-path-a-ipc.md` | 「有条件可行」，置信度 **0.95** | 复核：n=0 次成功投递，买到的证据档位只有 T1+T2，一条 T3 都没有；`fromMode` 其实可以随信封带进来（与原文相反） | **`UNPROVEN`**（`2026-11-02-path-a-recount.md`） |
| `2026-11-02-path-b-gateway.md` | 路径 B「可行」，置信度 0.90–0.99 | 免认证通道成立；但「`claude -p` 覆盖 `ANTHROPIC_API_KEY` 就能跑通」被**证伪**——真正的变量是宿主的两个受管环境变量，带它们时怎么覆盖都 401 | 免认证通道 ✅；`claude -p` 那条处方 ❌（`2026-11-02-path-b-recount.md` §四） |
| `2026-10-31-replay-observations.md` | 「300 秒门槛」是核心待验参数 | 门槛 60/120/300 三档通知量**完全一样**（67/67/66）；真正在拦的是 `hb_gap` 判据。而 `hb_gap` 本身随后被删除 | 门槛在真实流量上几乎不生效；`hb_gap` 已于 2026-10-31 删除（`2026-10-31-rollback-executed.md`） |
| `2026-11-04-external-harness-protocols.md` | hooks 共 **8 个事件** | 从二进制里读出的是 **33 个事件、5 种处理器类型** | 见 `2026-11-11-untapped-capabilities.md` §1.2 |
| `2026-11-11-untapped-capabilities.md` | `exit 2` 与 `{"decision":"block"}` **效果等价** | 原型在 2.1.289 与 2.1.308 上各测一次：`exit 2` 被记成 `Failed with non-blocking status code`，回合照常结束 | 只有 `{"decision":"block"}` 能拦（`2026-11-12-stop-hook-prototype.md` §2.2） |
| `docs/GUIDE.md:139`（引用了早期结论） | 「前台交互会话没有 token 计数」 | 253 个主 transcript 里 **181 个**带非零 `message.usage`，其中 180 个关联不到 job；全语料累计 $18,325 | 这条账一直都在，只是从没被读过（`2026-11-11-blind-spots.md` §3） |
| `README.md` / `CLAUDE.md` / `CI`（历史版本） | 回归测试 508 / 192 / 81 / 588 条 | 四份文件四个值，且都过期 | **826 → 860**（写本页期间又加了 34 条）。现在由 `check-structure.mjs` 的 `checkTestCount()` 硬门对账，写错直接 fail |
| `2026-11-13-consistency-audit.md` 🟡#22 | 「`claude-agent-acp@0.104.1` 在 npm 上不存在」 | **本机实测：这个结论本身错了。** 包名有两个：`@agentclientprotocol/claude-agent-acp`（就是 CHANGELOG 说的那个）**有 0.104.1**，最新 **0.106.0**；无 scope 的 `claude-agent-acp` 才是最高 0.100.3。审计查错了包 | 版本号 0.104.1 存在。但「Windows 上全部正常」仍不复现：本机 `acpx@0.22.0 claude exec` 能走完 `initialize`→`session/new`，在 `session/prompt` 返回 `{"code":-32000,"message":"Authentication required"}` |

## 🔥 最该读的（按价值排序）

| # | 报告 | 一句话 | 状态 |
|---|---|---|---|
| 1 | `2026-11-04-watcher-silent-failure.md` | **一份 MSIX 影子目录冒充了现场。** 主线程交来的三条「已确认事实」全部是看错了物理目录。凡是读 `%LOCALAPPDATA%` 得出的结论，都要先问「我看的是哪个目录」 | ✅ |
| 2 | `2026-11-03-verify-claims.md` | 把前序「15/24 撒谎」拆到 1/31，并定位到 `mvn.cmd` 正则。**全仓「断言 vs 证据」纪律最好的样板** | ✅ |
| 3 | `2026-11-11-blind-spots.md` | 用 11,488 个活跃段重建并发曲线，**87.1% 墙钟没有任何活跃会话**——推翻了整个产品赖以成立的用户画像 | ✅ |
| 4 | `2026-11-02-redteam-deterministic.md` | 把同一批 transcript 上的三个关键数字逐个打掉，含一个「同义反复」的方法论错误 | ⚠️（其中 15 条已被上一条推翻） |
| 5 | `2026-11-02-false-positive-diagnosis.md` + `2026-11-02-independent-recount.md` | 两条误报，两种根因（字段用错 / 维度缺失），且独立复算给出不同结论（一条误报、一条只是迟到） | ✅ |
| 6 | `2026-11-13-consistency-audit.md` | 24 处「文档声称 vs 代码事实」，先跑再写。**读它比读 GUIDE 更能知道当前真相** | ⚠️（#22 一条错，测试数已从 793 变 826） |
| 7 | `2026-11-11-framework-architecture-options.md` | 唯一给出「MCP 不能当派发通道」实测证据的一份（不能取消 + 子 agent 跑不了 shell） | ✅ |
| 8 | `2026-11-12-stop-hook-prototype.md` | 在真实 `claude.exe` 上跑通「拦→改口→再拦」完整循环，并推翻官方文档里的一条 | ✅ |

## 全部报告

### 2026-10-30 – 2026-10-31（观察期与信号探索）

| 日期 | 文件 | 一句话结论 | 状态 |
|---|---|---|---|
| 10-30 | `2026-10-30-hosted-automation.md` | 代决策判据 68.9% 的 `end_turn` 在等子 Agent；投递机制是命名管道 | ⚠️（68.3% 已复核；「能投递」被后续驳回） |
| 10-30 | `2026-10-30-stop-signals.md` | 权限确认/等决策型停止有**三类结构化信号**，不依赖文本正则 | ✅（数字随语料变：`AskUserQuestion` 54→177→228） |
| 10-31 | `2026-10-31-first-production-metric.md` | 第一个生产指标：通知可追溯率 **0/5 = 0%**，阈值写在测量之前 | ✅（样本 5 条，只证明旧架构不合格） |
| 10-31 | `2026-10-31-online-classification.md` | 离线 68% vs 在线 ≤4.8%，差距来自「在线看不到下一句」 | ⚠️（87.7% 应作 100%） |
| 10-31 | `2026-10-31-replay-observations.md` | 用历史语料回放 P0 观察期；300 秒门槛从未生效 | ⚠️（门槛结论被架空；方法学仍值得读） |
| 10-31 | `2026-10-31-reverse-engineered-waiting-signal.md` | 宿主有**三个**状态 `busy/waiting/idle`，`waitingFor` 才是判据 | ✅（`waitingFor` 精度后经 11-04 量化） |
| 10-31 | `2026-10-31-rollback-executed.md` | 回退条件命中：停止观察、回来改设计；并自我批评「保留决定、改写叙述」 | ✅（这是那轮最诚实的一份） |

### 2026-11-01 – 2026-11-03（真值、投递、复核）

| 日期 | 文件 | 一句话结论 | 状态 |
|---|---|---|---|
| 11-01 | `2026-11-01-dispatch-chain-audit.md` | 派发链路两个断点：`oversight-probe` 从不被派、`task-graph.json` 从不校验 | ✅（两处均已修：SKILL.md 已引用 probe，`validate-run.mjs` 已存在） |
| 11-01 | `2026-11-01-ground-truth-first.md` | 打断发生在 AI **说完话之后**；「停久了」是常态不是异常 | ✅ |
| 11-01 | `2026-11-01-relay-delivery-probe.md` | 默认配置下**消息被扣住不送达**，通道通≠能投递 | ✅ |
| 11-02 | `2026-11-02-deterministic-signals.md` | 确定性判据能判「停没停」，不能判「干完没有」 | ⚠️（主方向成立，三个关键数字被红队推翻） |
| 11-02 | `2026-11-02-redteam-deterministic.md` | 攻击上一条：10.6%→34.6%，45.9% 被证伪，115/115 是同义反复 | ⚠️（它自己的「15 个会话」被 11-03 推翻） |
| 11-02 | `2026-11-02-false-positive-diagnosis.md` | 两条误报两种根因：字段用错（`updatedAt` 当事件时刻）/ 维度缺失（只看末行） | ✅ |
| 11-02 | `2026-11-02-independent-recount.md` | 不看别人诊断，从原始日志重算：A 是误报、B 只是迟到 8.5 小时 | ✅ |
| 11-02 | `2026-11-02-fix-blocked.md` | 修 BLOCKED 误报：三个时间源取更旧的，>7 天标过期 | ✅（`BLOCKED_MAX_AGE = 7 * DAY` 在代码里） |
| 11-02 | `2026-11-02-fix-asked.md` | 修 ASKED 误报：新增五条判据；并把它移出「宿主事实」豁免表 | ✅（豁免表那条是更严重的结构性修复） |
| 11-02 | `2026-11-02-host-interfaces.md` | 12 条通道逐条实测；`mcp__ccd_*` 是一次性进程内 SDK server | ⚠️（`claude -p`/`mcp serve` 的「可用」后被收窄） |
| 11-02 | `2026-11-02-path-a-ipc.md` | IPC 投递「有条件可行」0.95 | ❌（复核判 `UNPROVEN`） |
| 11-02 | `2026-11-02-path-a-recount.md` | 复核上一条：只有 T1+T2，n=0 次成功投递 | ✅（这是纠正件） |
| 11-02 | `2026-11-02-path-b-gateway.md` | 本机网关免认证通道可用，`claude -p` 覆盖 KEY 即通 | ❌（免认证 ✅，`claude -p` 处方被证伪） |
| 11-02 | `2026-11-02-path-b-recount.md` | 复核上一条：`claude -p` 判死；令牌/ACL 三条成立 | ✅ |
| 11-02 | `2026-11-02-uia-driver.md` | UIA 读可行（零打扰），写会抢焦点且静默失败 | ✅（当时记录的「192 vs 375 测试」已作废） |
| 11-03 | `2026-11-03-verify-claims.md` | 25/228 会话含可核对断言，`NO_EVIDENCE` 仅 1；并用 `mvn.cmd` 正则解释前序 15 个从哪来 | ✅ |

### 2026-11-04 – 2026-11-05（通知系统、去重、TUI）

| 日期 | 文件 | 一句话结论 | 状态 |
|---|---|---|---|
| 11-04 | `2026-11-04-competitive-landscape.md` | 官方 `claude agents` 已覆盖我们的核心；「自动接力」是平台安全边界不是市场空白 | ✅（唯一差异是「断言 vs 证据」） |
| 11-04 | `2026-11-04-dedup-key-analysis.md` | 产键 5 处；最危险的是「不同次等待被算成同一个键」；`statusUpdatedAt` 不能当键 | ✅（修复已落地） |
| 11-04 | `2026-11-04-dsh-superagent-analysis.md` | dsh 是单仓库值班 agent；生命周期特权整段搬不了 | ✅ |
| 11-04 | `2026-11-04-external-harness-protocols.md` | ACP 是那条路，`acpx` 已写好，A2A 不匹配 | ⚠️（hooks 8 事件被推翻；`claude-agent-acp` 当时未实测） |
| 11-04 | `2026-11-04-fix-notify-dedup.md` | 修三个缺陷，7 处改动，6 个变异全被抓 | ✅（记录有效；测试数当时 508） |
| 11-04 | `2026-11-04-host-status-reliability.md` | `waiting` 按事件算只有 **12%** 真；`waitingFor=input needed` 100% 准；丢掉 `permission prompt` | ✅（噪声桶门已实现） |
| 11-04 | `2026-11-04-notification-system-critique.md` | 结论：推倒重做（三层轮询、四态状态机都该砍） | ⚠️（事实成立，**建议未被采纳**：三层轮询仍在 `watch.mjs`） |
| 11-04 | `2026-11-04-orchestration-patterns.md` | 不转发 progress 是通例；边界靠 schema 不靠 prompt；深度用工具可达性 | ✅ |
| 11-04 | `2026-11-04-redteam-notify-fix.md` | 攻击「立即派发」方案：挡它的是去重表不是派发位置 | ✅ |
| 11-04 | `2026-11-04-waiting-notification-diagnosis.md` | 信号为真但迟到 33.7 秒；标题是 raw slug 因为走的是 scan 路径 | ✅（「8s 轮询」缺陷至今未修） |
| 11-04 | `2026-11-04-watcher-silent-failure.md` | 守护进程没坏，是观测工具看错了目录（MSIX 影子） | ✅ |
| 11-05 | `2026-11-05-claude-tui-reverse.md` | CLI 是 React 19 + 魔改 Ink + 纯 JS flexbox，不是从零写 ANSI | ✅ |
| 11-05 | `2026-11-05-dsh-tui-analysis.md` | dsh-TUI 可抄的是**零依赖纯函数**（布局数学、固定列宽、光标用 ID）；并发现我们的 `displayWidth` 错 9/22 | ✅（宽度表已修） |
| 11-05 | `2026-11-05-dedup-test-failure.md` | 去重测试长期红：`pruneNotified` 用真实时钟剪掉注入时钟的条目 | ✅（已修） |
| 11-05 | `2026-11-05-fix-clock-and-crosslayer-dedup.md` | 修时钟注入 + 跨层去重；588/588 | ✅（记录有效） |
| 11-05 | `2026-11-05-multisession-ux-research.md` | 用户要的是「哪个在等我」；我们主屏一个可行动条目都没有（真实存在 2 个 blocked 却显示 0） | ✅ |
| 11-05 | `2026-11-05-tui-bugfixes.md` | 修六个 TUI 缺陷（mtime 窗口、宽度表、光标、三源合并、颜色、空状态） | ✅（当时 583 条，1 条预存红） |
| 11-05 | `2026-11-05-verify-claims-productization.md` | `--help` 曾直接开扫；加单会话模式与退出码；判定逻辑 0 改动 | ✅ |

### 2026-11-10 – 2026-11-13（框架选型、TUI 重做、一致性）


| 日期 | 文件 | 一句话结论 | 状态 |
|---|---|---|---|
| 11-10 | `2026-11-10-agent-roles-audit.md` | 12 份角色定义不能当「员工」：**无一份含 `Agent`**，4 个角色缺 `Bash` 却要求跑命令 | ✅（P7 独立复现了「没有 Bash」） |
| 11-10 | `2026-11-10-framework-build-vs-buy.md` | 买驱动、造契约；只有 Mastra 是 ACP 一等公民 | ✅ |
| 11-10 | `2026-11-10-tui-implementation.md` | 主屏实现：判决行 / 检查表 / 三段分区 / 四种空态；布局数学全抽成纯函数 | ✅（当时 700/700） |
| 11-11 | `2026-11-11-ambiguity-detection.md` | 没有「一句话进问题出」的现成检测器；194% 的问题在写文件之后才问 | ✅ |
| 11-11 | `2026-11-11-blind-spots.md` | 87.1% 墙钟无活跃会话；前台会话有 token 账；`file-history` 是没用过的版本库 | ✅（本机重算 86.8%，同向） |
| 11-11 | `2026-11-11-build-own-framework-viability.md` | 「super agent 框架」应读作「契约 + 验收闸 + 适配器」；dsh 只有 26.6% 是框架 | ✅ |
| 11-11 | `2026-11-11-claude-status-block-reverse.md` | 它有四种状态说明形态，**没有**「检查了什么」这种元表头 | ✅ |
| 11-11 | `2026-11-11-framework-architecture-options.md` | 编排进程内、执行进程外；**MCP 不能当派发通道**（无取消 + 子 agent 跑不了 shell） | ✅ |
| 11-11 | `2026-11-11-hostile-user-review.md` | 苛刻用户视角：项目自己就是它要治的病（三处测试数三个值、监视已死 32 小时） | ✅（所列缺陷多已修） |
| 11-11 | `2026-11-11-intervention-baseline.md` | 人工介入基线 798 次；37% 本可开工前问掉；19.3% 是「说完就停」 | ✅ |
| 11-11 | `2026-11-11-question-methodology.md` | 可抄的是缺陷分类学；「问几个」的 11.4 不能照搬；多问会让 Pass@1 腰斩 | ✅ |
| 11-11 | `2026-11-11-tui-checklist-redesign.md` | 删表头、零值不占行、全绿压一句 | ✅ |
| 11-11 | `2026-11-11-tui-stale-and-copy-fix.md` | 33 天前的问句排「需动作」第一位；`c` 复制内容错 | ✅ |
| 11-11 | `2026-11-11-untapped-capabilities.md` | `Stop` hook 是平台内置的「声称完成就校验」机制；hooks 有 33 个事件 | ⚠️（`exit 2` 等价一条被推翻） |
| 11-12 | `2026-11-12-log-rotation-SILENT-failure.md` | 交来的「日志静默 4 小时」**又是 MSIX 影子目录**（本机第 2 次：真实 `watch.log` 289 KB、逐行等于 `runner.log`）；改修真实缺陷——日志失败三层可见 + 轮转三级降级 + `--health` 读 `log-health.json` | ✅（4 条负向验证：回退即红） |
| 11-12 | `2026-11-12-stop-hook-prototype.md` | 真拦住了：`decision:block` 有效、`exit 2` 无效、默认上限 9 次、子 agent 旁证是准确率分水岭 | ✅ |
| 11-12 | `2026-11-12-stop-hook-e2e-validation.md` | 真模型上只拦下 2 次；模型倾向「验证或坦白」而非谎报；发现「已全部修好」漏报 | ✅（自称样本不足，不外推） |
| 11-13 | `2026-11-13-consistency-audit.md` | 24 处不一致（🔴6/🟡11/🟢7），测试数实测 793 | ⚠️（#22 包名查错；测试数已 826） |
| 11-13 | `2026-11-13-dangerous-inconsistencies-fixed.md` | 6 条危险级全修；新增 `checkTestCount()` 让测试数不再手写 | ✅ |
| 11-13 | `2026-11-13-tui-test-regression.md` | 红测是夹具过时，不是显示逻辑坏；顺手修了列表页不净化外部文本（OSC 52 改剪贴板） | ✅ |
| 11-13 | `2026-11-13-vague-claim-detection.md` | 新增 `vague-completion` 族，拦住「修好了」这种无指标完成声明 | ⚠️（3 抓 3 漏，冒号形态仍漏，见下一条） |
| 11-13 | `2026-11-13-hook-sample-logging.md` | 漏报的三种形态全是「`已+动词` + 冒号」；**决定不加正则，先攒样本** | ⚠️（当时 `detectClaims('…已全部修好：')` 返回 `[]`。**已被下一条修掉**） |
| 11-13 | `2026-11-13-claim-detection-fixes-and-multimodel.md` | 修三个识别缺陷（`已全部修好` / `Whether tests pass…` / reason 混英文族名）+ P6 的 `All four fixes are applied`；**查清「兼容多模型」在当前环境无法在闸门层验证** | ✅（真实实验 19 组回归：P4/P5/P6 放行→拦截，无一组从拦截变放行；多模型结论是「不可验证」，含证据） |
| 11-13 | `2026-11-13-pre-commit-audit.md` | 提交前总核对（69 个未提交文件 / 5000+ 行）：硬门 exit 0、860/860 全绿，但仍有 1 条阻塞级界面误报 + 1 条破坏负向验证纪律的问题 | ⚠️（阻塞项后来是否修完，以 `tasks/dev-findings.md` 为准；本报告是快照） |
| 11-13 | `2026-11-13-critique-stop-hook-product.md` | 锐评：Stop hook 验证闸**不该做成独立产品**——93.7% 可拦时刻在会话中段（用户不在读）、真实语料 `NO_EVIDENCE` 仅 2 条（其余 43 条在实验靶场）、理由里 `truncated` 硬编码导致 14.9% 的拦截虚报证据范围 | ✅（本机全量复算；未做桌面 App GUI 验证，见报告覆盖声明） |
| 11-13 | `2026-11-13-plan-first-mechanism.md` | 逆向 Claude Code 的 `TodoWrite` 与 plan mode：**是两套东西**，plan 是 todo 的上游；并给出「plan-first」进产品的可选路径 | ❓（exploration，零行实现，未做产品裁决） |
| 11-13 | `2026-11-13-dsh-goal-mechanism.md` | dsh 有**两套**目标机制（`todo_write` 会话内清单 + `goal` 每会话持久目标，后者能自动续行）；Claude Code 只有前者 | ❓（exploration，逆向 + 1,426 个真实会话统计，未做产品裁决） |
| 11-13 | `2026-11-13-doc-sync.md` | 文档与代码一致性巡检 + 建立长效机制：能力清单、文档路径/命令/常量三道具化检查进硬门 | ✅（本轮产出，含「不值得做」的机制及理由） |
| 11-13 | `2026-11-13-critique-question-layer-product.md` | 锐评「需求澄清层」方案 B：**否决当前形态**；本机复算全量 828 次介入里只有 **8.2%（68 次）**发生在首次写文件之前（写文件会话内部为 91.4% 在后），开工前问直接作用的只是这一小块 | ✅（数字均本机复算；裁决是评审结论，实施与否待主线程决定，勿当既定方针） |
| 11-13 | `2026-11-13-output-reconciliation-integration.md` | 把产出对账接进派发链路（设计 §7 四项全落地）：`task-graph` 的 `outputs` 必填、派发模板带 nonce、executor/repair 改四元组、SKILL.md 验收前加硬前置门。**nonce 假设逐字节实测成立**（127/127）。诚实边界：`observe` 仍需手动跑第二步、Bash 写出的文件看不见 | ✅（真实 run 跑通 declare→claim→verify→consume→adopt；两次真实回退共 9 条测试变红；960/960 全绿） |
| 11-13 | `2026-11-13-bash-write-detection.md` | Bash 写出的文件「认不认」是伪二选一：真正的分界是**路径是否需要展开**。可确定解析的 5 类（重定向 / heredoc / `tee` / `cp` / `mv`）+ 字面量 `cd` 已识别；变量、通配、`find -exec`、子 shell、`/tmp` 探针不认。**526 份 transcript / 36,673 次 Bash 调用里解析出 1,149 条路径，basename 全部原样出现在命令中（0 条凭空生成）** | ✅（62 条 claim-ledger 测试 + 3 条真实回退：恒返回空→6 红、删动态字符防线→3 红、cd 失败留前半截→1 红；全仓 973/973 全绿） |

## 文档同步审计（2026-11-13）

`2026-11-13-doc-sync.md` 是那一轮的记录。它把「文档会过期、靠人记得同步不现实」这件事
从「再加一份会过期的文档」变成**提交前会红的检查**。现在守着的六道具化门见
[`../README.md`](../README.md) 的「硬门守着哪些文档一致性」。

它同时给出了**不该做的机制**（附理由），避免下一个人从零再想一遍：
检查「文档里的台词式数字」、检查「描述性能力声称是否属实」、每份报告强制状态守卫。


## 互相矛盾的地方

同一件事被不同报告说成不同值。**引用前先确认口径和语料日期。**

| 主题 | 说法 A | 说法 B | 现状 |
|---|---|---|---|
| 回归测试数 | 192（CLAUDE）/ 375（uia 实测）/ 508（README）/ 545 / 583 / 588 / 700 / 722 / 793 / 826 | **860**（2026-11-13 本机实跑） | **860**。硬门 `checkTestCount()` 已强制对账，改错直接 fail |
| `claude -p` 能不能用 | 能用（`2026-11-02-host-interfaces.md` 实测返回 42） | 静默失败 exit 0 + 空 stdout（`2026-11-11-build-own-framework-viability.md`，3/3） | 取决于**有没有剥掉宿主的两个受管变量**。剥掉后 39.3 秒成功（`2026-11-11-framework-architecture-options.md` P12）；不剥必然 401。**「能用」是有条件的** |
| `claude-agent-acp` 版本与可用性 | 0.104.1 在 Windows 全部正常（`docs/CHANGELOG.md`） | 0.95.0 报 `Authentication required`（P2）；审计称 0.104.1「不存在」 | **本机实测**：0.104.1 存在（scoped 包，最新 0.106.0）；`acpx claude exec` 走到 `session/new` 成功、`session/prompt` 报 `Authentication required`。**「握手/建会话正常」成立，「跑完回合」不成立** |
| `UNCLASSIFIABLE` 占比 | 87.7%（末态模拟） | 95.4%（回放口径）/ 100%（真实分类器） | **100%**。三个数的分母不同，不能并列引用 |
| `waiting` 准确率 | 12%（按状态翻转事件） | 77.8%（按实际发出的通知） | 同一份报告的两种口径，**都对**：限额与理由门把精确率从 12% 拉到 78%。引用必须带口径 |
| 「没跑测试却声称通过」的会话数 | 15（`2026-11-02-redteam-deterministic.md`） | 13（原样重跑）/ 9（修 `mvn.cmd` 后）/ 1（全量 `NO_EVIDENCE`） | **1 个 `NO_EVIDENCE`**，其余是正则与语料漂移 |
| 同时开几个会话 | 「同时开 10+ 是常态」（产品假设） | 87.1% 墙钟零活跃，≥5 个只占 4.7% | **87.1% 无活跃**。10+ 是假画像（`2026-11-11-blind-spots.md`，本机重算 86.8%） |
| `AskUserQuestion` 调用数 | 54（10-30）/ 177→175（11-11 baseline）/ 228（11-11 ambiguity）/ 234（同报告另一口径） | — | 语料从 146 长到 267 个 transcript，**绝对数只增**；只引比例不引绝对数 |
| `--days 3` 扫描耗时 | 33 秒（README/GUIDE 写死）/ 51.8 秒 / 65 秒 / **本机今天 99 秒**（347 transcript） | — | **随语料线性增长**。任何写死的秒数都会过期 |
| `claude mcp serve` 能不能当执行通道 | 可用，23 个工具（`2026-11-02-host-interfaces.md`） | 不能：无取消（`No task found with ID: w1`）+ spawn 的子 agent 跑不了 shell（`pwsh timed out after 5000ms`） | **只能当纯推理外包，不能当执行器**（`2026-11-11-framework-architecture-options.md` P8/P10） |
| 自动接力 | ADR「不能」→ `2026-10-30` 「能」→ 复核 `UNPROVEN` → `2026-11-04` 「平台禁止」 | — | **默认配置下不可用**。通道可达，闸门默认关 |
| 通知系统该修还是重做 | 该修（F3 修了三个缺陷） | 该重做（`2026-11-04-notification-system-critique.md`） | **修了，没重做**。三层轮询与四态状态机仍在 `watch.mjs`——锐评的判断至今未被反驳，也未被采纳 |
| 扫描耗时 / 子 agent 上限 | 30（GUIDE 旧版） | 100（`MAX_SUBAGENTS`） | **100**（已修） |

## 今晚确认过的活跃事实（可直接引用）

| 事实 | 证据 | 我核过没有 |
|---|---|---|
| 回归测试 **860** 条（2026-11-13 本机实跑） | `node scripts/check-structure.mjs` 的 `checkTestCount()` 数源码 `^\s*test(` 得 860；四份文档已同步为 860 | **是**，本机实跑。**这仍是会漂的数字**：写本页的两小时内它从 826 变到 860（同目录另一个 Agent 在加测试），硬门当场报了 4 处违规。**引用前跑一次命令，别信任何写死的值** |
| `claude-agent-acp` 的 ACP 适配器在本机跑不完一轮 | `acpx@0.22.0 --format json claude exec` → `initialize` OK、`session/new` OK、`session/prompt` 返回 `Authentication required` | **是**，本机实跑 |
| 该包的最新版本号 | scoped `@agentclientprotocol/claude-agent-acp` = **0.106.0**（含 0.104.1）；无 scope 的 `claude-agent-acp` = **0.100.3** | **是**，`npm view` 实查 |
| Stop hook 能拦住，但 `exit 2` 不拦截 | 宿主记 `Failed with non-blocking status code`，回合照常结束；只有 `{"decision":"block","reason":…}` 有效 | 代码 `scripts/stop-verify-hook.mjs:797` 只走 block；报告有 2.1.289/2.1.308 两次实测 |
| `claude mcp serve` 能执行工具，但不能派子 agent 跑 shell | P6 `tools/call Agent` 成功 23.9s；P8 子 agent 报 `pwsh timed out after 5000ms`；P10 无取消 | 报告实测（n=1，作者自己标了「不作为结论」） |
| **87.1%** 墙钟时间无活跃会话 | 按 gap>5min 切活跃段重建并发曲线（11,488 段） | **是**，我按同法重算得 **86.8%**（347 transcript / 1.8 GB / 3491 小时墙钟 / 1873 段） |
| 6 份报告是本机私有，不进仓 | 首行 `<!-- PRIVATE: 不在公开范围内 -->` + `.gitignore` 逐条列名 | **是**：`2026-11-02-host-interfaces.md`、`path-a-ipc.md`、`path-a-recount.md`、`path-b-gateway.md`、`path-b-recount.md`（5 份，不是 6 份） |

> 最后一条我特意写出来：任务书说「6 份」，`grep` 结果是 **5 份**。索引页本身也会犯「数字没核」的错。

## 维护规则

1. **新增报告必须在本页登记**，并给出状态与依据。没有状态的研究报告等于没有结论。
2. **状态只升不降的除外**：✅ 可以被后续报告降级为 ⚠️ 或 ❌，降级时**必须在「已被推翻的结论」表里加一行**，写清正确说法。
3. **不要改历史报告里的数字。** 它们是当时的实测记录，改了就没有证据价值。要更正就写新报告，然后在这里改状态。
4. **本页自己也要被核。** 上面每一行「依据」都是一条可复算的线索；发现某行依据不成立时，改那一行，不要整页重写。
