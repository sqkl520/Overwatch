# 设计存档

> ⚠ **本目录没有一份文档描述的是当前已实现的能力。**
>
> 这里是**设计推演**，不是使用说明。想了解系统现在能做什么，
> 读 [README.md](../../README.md) 的「能力边界」和 [docs/GUIDE.md](../GUIDE.md)。
>
> 保留这些文档的理由：里面有大量实测数据（可代答率 2.5%、子 Agent 信号 70.9% 等），
> 删掉要重做。**但不要按它们实施。**

## 逐份状态

| 文件 | 状态 | 已实现的部分 | 未实现的部分 |
|---|---|---|---|
| [`hosted-mode.md`](hosted-mode.md) | **Proposed** | §2 停止分类器、§4.2 去重键、§4.3 三层轮询、§4.4 限额、§4.5 通知降级 —— 见下方对照 | §1 策略 schema（分级 L1–L5、`when` 表达式）、§3 投递组件、§5 分阶段实施 |
| [`intent-contract.md`](intent-contract.md) | **已裁决否决** | — | 全部。边际贡献仅 2.7pp，且方法与目标正交 |
| [`verdict-intent-contract.md`](verdict-intent-contract.md) | **裁决记录** | — | 本身不是方案，是三方的裁决过程与结论 |
| [`frontend-and-shape.md`](frontend-and-shape.md) | **Proposed** | — | 前端三层形态、策略文件 schema、自动接力的分级与用户规则。**技术前提已实测**（命名管道可达），但「接收方会不会执行 AI 发的指令」尚未验证 |
| [`continuation-engine.md`](continuation-engine.md) | **Proposed** | — | 读 transcript 还原需求与进度、按证据分级判断达没达到、产出「继续」而非「重来」的指令草稿。**未实现**。结论：前两件可做且廉价（有效上下文 p50≈315 token），第三件受 ADR-0001 约束，只能产草稿 |
| [`2026-11-04-next-phase-plan.md`](2026-11-04-next-phase-plan.md) | **Proposed** | — | 下一阶段的优先级判定与任务拆解（五件事、为什么是这五件）。**零行实现**，是规划产物，不是能力说明 |
| [`2026-11-05-tui-redesign-plan.md`](2026-11-05-tui-redesign-plan.md) | **Proposed** | — | TUI 重做的现状诊断、信息架构（判决行 / 检查表 / 三段分区 / 空状态自证）、从 dsh-TUI 的可抄与不抄、七个可派发任务。**零行实现**，未获裁决前不得开工实现 |
| [`2026-11-10-agent-framework-skeleton.md`](2026-11-10-agent-framework-skeleton.md) | **Proposed** | — | agent 框架 v0 骨架：为什么不用现成框架（N1/N2/N3 三条结构性理由，各附证伪条件）、v0 做五件不做十件、角色 ≠ harness 的分层、三事件汇报协议、一条最小链路、七个可派发任务。**零行实现**；§三.3 与 §七 记录了本文件推翻/降级的两条既有前提 |
| [`2026-11-11-question-protocol-thesis.md`](2026-11-11-question-protocol-thesis.md) | **方向性声明** | — | 用户原话与由此推出的产品定位：把人工干预集中到开工之前（「问问题」是项目主题）。**不是设计方案，零行实现**；记录四个已确认约束与代价前移的理由 |
| [`2026-11-11-agent-framework-v2.md`](2026-11-11-agent-framework-v2.md) | **Proposed** | — | agent 框架 v2（修订 v1 骨架）：承认 Mastra 覆盖「派活」、我们只剩「判活」（J1–J5 五个要件），据此把「框架」降级为「验收层」；v0 五件缩到三件；给出不引 Mastra 的五条实测理由与三条切换条件；12 个角色的逐个判决；统一「机器读 JSON / 人读 markdown」的输出规则。**零行实现**；含 P1–P22 共 22 条本机实跑记录，其中 7 条推翻了既有文档结论 |
| [`2026-11-11-company-architecture.md`](2026-11-11-company-architecture.md) | **Proposed** | — | 多 agent 公司架构：三层（接待台 / 工头 / 执行者）+ 两个旁挂（门禁 / 记账）、主 agent 与手下的唯一区别（写判据 vs 写产物）、递归的三道闸（工具可达性 / 预算递减 / capability_gap）、问题五环节流转与三种权力归属、外包的交接契约与失败六档、「不臃肿」的六个可检查机制、v0 只留 2 / 12 个角色。**零行实现**；§九 给出 12 个角色的逐个判决，砍掉 8 个 |
| [`2026-11-13-output-reconciliation.md`](2026-11-13-output-reconciliation.md) | **已接入派发链路** | `scripts/claim-ledger.mjs` 四方对账 + 端到端 CLI 测试；§7 四项已落地（`task-graph` 的 `outputs` 必填、模板带 nonce、executor/repair 四元组、`SKILL.md` §4.5 验收前置门），见 `docs/research/2026-11-13-output-reconciliation-integration.md`。§3.6 的 Bash 盲区已收窄为「只认可确定解析的字面量路径」，见 `docs/research/2026-11-13-bash-write-detection.md` | 仍未做：`observe` 需手动跑第二步（`declare` 未记 `--session`）、变量 / 通配 / `find -exec` / 子 shell / `/tmp` 探针这类 Bash 写入仍不在痕迹范围、纯文本结论无从对账。**用户原话：「避免 agent 已经产出了而主线程没意识到」** |
| [`2026-11-14-gui-style-spec.md`](2026-11-14-gui-style-spec.md) | **已提取，未实现** | 桌面版 GUI 的设计规格：从 MSIX 包内 `app.asar` 与 `ion-dist/` 两份独立来源提取的 CSS token（侧边栏 288px、对话栏 640px、clay `#d97757`、33 档暖调灰阶、待办轨道逐像素尺寸）。两处来源互相印证，数值非猜测 | 全部未实现。§9 列明未获取项：compose 框 placeholder 文案、侧边栏完整 JSX、除 `Ctrl+K` 外的键位、3 个 `progress-*` 关键帧、Anthropicons 字形表 |
| [`2026-11-14-agent-roster-policy.md`](2026-11-14-agent-roster-policy.md) | **裁定记录（用户原话）** | — | 本身不是方案，是用户 2026-11-14 的两条裁定：岗位组合可配（`executor` 单跑 / 常规 / 高风险 / 测模型质量）、阻塞处置可配（`stop` / `retry:N` / `escalate`），并推翻 2026-11-11「必须问不可关闭」的表述。**零行实现**；「不问（策略跳过）」与「该问没问（`ZERO_ASK`）」的区分依赖 `question-protocol.md` §5.2 的 `no_open_questions_why` |
| [`2026-11-14-main-thread-authored-prompts.md`](2026-11-14-main-thread-authored-prompts.md) | **已实现（原型 + 49 条测试）** | L0–L3 四层分工（身份冻结 / 协议冻结 / 主线程现写 / 机器注入），`scripts/compose-agent-prompt.mjs` 的 `compose` 与 `verify`：验收需求 × 工具白名单相容性检查（今晚「acceptor 跑不了 check-structure」那条的机械判据）、九条必填元素、停机条件可判定性、`prompts.jsonl` hash 台账与 transcript 首条 user 消息对账 | 未接入 `SKILL.md` Phase B（下一轮）；`extractCommands` 是启发式的会漏；本仓无构建标志文件故 L3 的「构建/测试命令」恒为 `unknown`；12 份角色定义里 4 份「职责与工具互斥」只做拦截**未改定义**（改法是决定，不是编辑） |
| [`2026-11-14-gate-widening-patch-plan.md`](2026-11-14-gate-widening-patch-plan.md) | **Proposed（零行实现）** | — | 写前闸 `decide()` 判据改宽**要动哪些函数**：现状测绘（证据链 `runHook.getReads → readTranscriptReads → decide:611` 的完整调用路径与行号）；四条扩宽路（续接 / 子 agent / 结构性探索 / 参数误解析）各自改哪里、纯函数边界怎么处理、hook 运行时拿不拿得到数据；三种权重形态在同一语料快照上的实测对比（形态 1 并集 / 形态 2 OR / 形态 3 分档 → would-deny 27→1/1/4，沙箱阴性对照不掉）；**用变异测试逐条列出扩宽会让哪 4 条测试变红、以及另 7 条空白**（续接/子 agent/warn 模式/默认阈值/log.reads 全零覆盖）；P0–P4 补丁序列与回滚粒度。**未实现**：本文只测绘与排序，不主张应该改宽 |
| [`2026-11-14-product-layer.md`](2026-11-14-product-layer.md) | **Proposed（零行实现）** | — | 产品层：陌生人从看到 repo 到获得价值缺的那一层。逐跳路径与 9 个断点（5 条工程量 / 3 条产品定义），判定**缺的是产品定义**且分叉点是 ADR-0001 那句「`clone 即用` 优先于 `可安装`」（2026-11-14 的产品目标已把它推翻）；推荐「改成可安装」并给出入口契约（`scripts/overwatch.mjs` 子命令路由、首屏 PLAN + 环境段、1 秒预算的实测依据）、M1–M4 四个阶段各带机械验收与停下条件、三个陷阱（过早 TUI / daemon 当入口 / 发 npm 包）与两条不入选方向（多 provider / agent framework）、以及「只能做一件事」的答案（把 `.claude/` 装进别人的项目）。**未实现**：入口脚本、`init`、首屏输出全部为零行 |

## `hosted-mode.md` 的已实现 / 未实现对照

代码里引用了这份文档的地方（`notify.mjs`、`watch.mjs`）都指向**已实现的那部分**：

| 章节 | 内容 | 现状 |
|---|---|---|
| §2 停止分类器 | `classifyStop()` 的判定顺序与输出对象 | ✅ `scripts/classify-stop.mjs`，42 条测试 |
| §4.2 去重键 | `sessionId + state + reason` 不够，要剥掉数字 | ✅ `reasonClass()` |
| §4.3 三层轮询 | 1 分钟 / 5 分钟 / 30 分钟的成本依据 | ✅ `watch.mjs`（L-full 已于 2026-10-31 停用，见 CHANGELOG） |
| §4.4 通知限额 | 每会话 24h ≤2、全局 ≤8、最小间隔 10 分钟 | ✅ `canNotify()` |
| §4.5 通知降级 | 送不到时退回仅记录，不重试 | ✅ `dispatchCandidates()` |
| §1 策略 schema | 分级模型、`when` 表达式、完整配置 | ❌ 未实现 |
| §3 投递组件 | 自动把草稿发进目标会话 | ❌ **不可能实现**，见 [ADR-0001](../adr/0001-config-only.md) |
| §5 分阶段实施 | L1→L5 的演进路径 | ❌ 从未开始 |

## 为什么 §3 永远做不到

ADR-0001 记录的实测结论：目标会话正在运行时，`--resume` 落到副本上，
你的窗口里不会出现任何东西。宿主虽有跨会话消息通道，但投递必须标注来源，
无法做到「无痕模仿用户」。

所以凡是以「自动接力」为前提的设计（§1 的分级、§3 的投递、§5 的演进），
**都建立在一个不成立的前提上**。它们仍保留，是因为里面的数据与推理过程有价值，
不是因为它们还能被实施。
