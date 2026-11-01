---
name: oversight
description: OmniSight 调度入口。拆解 → 并行派发 → 冲突登记 → 验收 → 接力草稿。用户说「启动监控」「派编队」「跑一轮 Oversight」时使用。
argument-hint: "[new | demo | status | relay <session-id>]"
disable-model-invocation: true
---

# OmniSight 调度入口

> 主线程只做三件事：**拆解、派发、汇总**。不亲自检索、分析、编码、写作。

## 0. 先确认后台真的在工作

```bash
node scripts/watch.mjs --health
```

**这一步不能跳过。** 「进程存在」和「进程在工作」是两件事——
2026-10-31 一次排查中，进程活着、CPU 在涨，但已经**六小时没扫描过任何东西**（DF-023）。
我当时用「进程存在」当作「在监控」，并据此判断「还没有真实数据」。

判定不健康时，**先修好守护进程，再谈其他**。守护进程没在跑时看到的「一切正常」
不是信息，是缺失信息。

## 0.5 再看后台发现了什么

```bash
node scripts/watch.mjs --inbox
```

后台守护进程（`watch.mjs`）盯着所有会话，它已经知道谁在等人、谁失败了。
不先读它，你就会把已经知道的事重新发现一遍——而且可能发现得不一样。

**收件箱为空要先排除「因为守护进程没在跑所以空」**（见 §0）。

收件箱的每一行都带着宿主的原话（`needs` / `suggestedReply`），**逐字转给 Agent，不许摘要**。

分路处理：

| 收件箱里的情况 | 谁处理 |
|---|---|
| `WAITING` / `BLOCKED` 且有 `suggestedReply` | 宿主已给半成品。直接给用户复制，**不必派 Agent** |
| `WAITING` / `BLOCKED` 只有 `needs` | 派 `oversight-relay`，把 `needs` 逐字给它 |
| `WAITING` 但 `needs` 为空 | **先派 `oversight-probe` 判定它在等什么**，再据此派 `oversight-relay` |
| `FAILED` | 派 `oversight-relay`，从 transcript 重建失败点；**不要按「在等待」写措辞** |
| 收件箱为空且 §0 判定健康 | 确实没有需要处理的事 |

**`needs` 为空时不能直接派 relay。** relay 拿不到「在等什么」就只能编——
它的输入契约里写着「`needs` / `suggestedReply`（若有，逐字给出）」，
没有就得靠 transcript 猜。`oversight-probe` 的职责正是先判这一步：
它只看工具调用日志、不读推理文本，三选一给出 `HEALTHY_EXPLORING` / `UNFOCUSED` / `LOOPING`。

> 2026-11-01 发现：`oversight-probe` 定义存在、触发条件也改过，
> 但 SKILL.md **从不派它**——它的触发条件永远不会生效。

后台只**发现**，不**处理**——它不改代码、不代答、不重跑。处置永远在你（或你派的 Agent）这里。

## 0.6 再看「问了但没人答」的会话（不依赖宿主）

```bash
node scripts/asked.mjs
```

有些会话宿主**不会**报 `waiting`——比如 AI 做完了活、给了几条选项让你拍板，
但宿主认为它只是正常结束。这些会话会一直躺着，没人提醒。

这个脚本直接从 transcript 判断：最后一条消息是问句 + 距现在多久。
**不看宿主状态，所以能覆盖宿主不报的场景。**

判据来自实测（`docs/research/2026-11-01-ground-truth-first.md`）：

- 2,363 次真人接话里，**87.5% 的「停下来」AI 并没有在问任何问题**——它只是说完了。
  所以「停久了 = 有问题」这个框架是错的，这个脚本**只找问了问题的**。
- 开场客套（「今天想做点什么呢」）永远不会有人回，已排除。

## 0.5 再确认扫描能力

```bash
node scripts/scan-sessions.mjs --days 3
```

若脚本报错，先修环境，不要继续。能力不可用时降级路径见 README 的「能力边界」。

## 1. 首次运行：问 5 件事

用户没回答就按默认执行，但必须声明「按默认执行」：

| # | 问题 | 默认 |
|---|---|---|
| 1 | 监控范围 | 所有可见会话 |
| 2 | 接力触发 | (b) 停滞 + (c) 重复失败 + (d) 手动 |
| 3 | 接力口吻 | (b) 中性继续 |
| 4 | 禁止操作 | 删除 / 外发 / 交易 / 权限变更 |
| 5 | ADHD 友好输出 | 开 |

## 2. Phase A：规划

派 `oversight-planner`，输入原始需求 + P0 答案 + 台账。产出 `tasks/runs/<run-id>/task-graph.json`。

**拿到产物先校验，再派发：**

```bash
node scripts/validate-run.mjs tasks/runs/<run-id>/task-graph.json
```

不通过就退回 planner 重做，**不要自己补字段**——补出来的预算和依赖关系是编的，
下游 Agent 会当真。这个校验器把 `planner.md` 里的 schema 变成可执行的检查；
在它出现之前，第一个真实 run 就漏了 `token_budget_pct` / `parallel_with` / `depends_on` 三个必填字段。

**主线程审核拆解图**，确认没有「主线程自己顺手做了」的隐含任务，然后派发。

## 3. Phase B：并行编队

按拆解图并行派发。复杂任务至少 5 个 Agent，必须包含：

- 执行 Agent ×N（`oversight-executor`）
- 检索 Agent（`oversight-research`）
- 批判 Agent（`oversight-critic`）
- 红队 Agent（`oversight-redteam`）
- 锐评 Agent（`oversight-review`）
- 验收 Agent（`oversight-acceptor`）

**独立性**：每个 Agent 只收到「原始任务 + 验收标准 + 产出形态声明」，不读同级输出。靠**不提供路径**实现，不靠 prompt 里写「请不要读」。

## 4. Phase C：冲突登记

所有 Agent 返回后，按「一致 / 分歧 / 互补」分类。

- 实质分歧 → 派 `oversight-resolution` 裁决
- **禁止主线程自己「感觉哪个对」**
- 一致结论也要标注「N 个 Agent 同意」，并注明是否有人被要求找反面证据

## 5. Phase E：验收与修复

1. `oversight-acceptor` 对照预声明标准判定
2. 不通过 → `oversight-repair` → **完整重新验收**（不是抽查）
3. 最多 3 轮，仍不通过 → 提交失败报告，**不假装通过**

## 6. Phase F：接力（手动）

```bash
node scripts/scan-sessions.mjs --json | node -e "
  const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log(d.sessions.filter(s=>s.state==='BLOCKED'||s.state==='STALLED'||s.state==='FAILED'));
"
```

**先分路，再派发**（`docs/spec/relay-protocol.md` §5.1）：

| 情况 | 怎么做 |
|---|---|
| `BLOCKED` 且有 `suggestedReply` | 宿主已给半成品。TUI 按 `c` 直接复制，**不必派 Agent** |
| `BLOCKED` 只有 `needs` | 派 `oversight-relay`，把 `needs` 逐字给它 |
| `STALLED` / `FAILED`（无 job 记录） | 派 `oversight-relay`，从 transcript 重建停滞点 |

1. 派 `oversight-relay` 产出草稿（给它 `needs` / `suggestedReply` 原文，不要摘要）
2. 派 `oversight-safety` 过红线
3. **主线程不写草稿、不判红线**
4. 把通过的草稿交给用户复制

**注意 `needs` 的类型**：等 API 恢复的 `blocked` 没有 `suggestedReply`，催它重试是错的——
正确动作是检查网关或换模型。见规格 §5.1 的两种误用。

## 7. 状态行

每轮携带，由脚本渲染：

```
[阶段B · Agent#3 EXPLORING · reads=42/novelty=0.74/hb=14s · budget=est:31% · liveness=reconstructed]
```

**不手写数字**。算不出来的写 `unknown`。

## 最小演示

用户说「最小演示」时，只派 3 个 Agent：`oversight-executor` + `oversight-review` + `oversight-acceptor`，跑通一轮完整流程。
