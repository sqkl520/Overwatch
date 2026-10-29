# 派发契约

> 每个子 Agent 的 prompt = **本文件的公共段** + **Planning 现写的域专属段** + **baseline 事实快照**。
> 三段缺一视为规划缺陷，退回 Planning Agent（规格 §2.8）。

## 1. 拼装规则

```
prompt = templates/dispatch.md（公共段，长期稳定）
       + planning 现写（域专属：目标 / 文件清单 / 风险假设 / 定制检查项）
       + templates/baseline.md（当轮事实快照：commit、规模、已知问题数）
```

**为什么域专属段不预置**：参考项目预置了 30+ 份 `review-plan.md`，结果全部腐烂——没人知道哪份是当前真相。域段必须每次现写，写完即用完。

**为什么 baseline 必须共享**：所有 Agent 对同一组数字发言，才能发现「A 说 87 个文件、B 说 92 个」这类矛盾。baseline 由主线程派发前生成，不读其他 Agent 的输出。

## 2. 每个 Agent 必须收到的四样东西

| # | 内容 | 缺失后果 |
|---|---|---|
| 1 | 原始任务描述（不是别人的转述） | Agent 会优化一个错误的目标 |
| 2 | **预先声明的验收标准** | 事后编造标准，验收失去意义 |
| 3 | 产出形态声明（`artifact` / `exploration` / `hybrid`） | 无法判定「8 分钟无 Write 是否异常」 |
| 4 | token 预算与容忍窗口 | 无法做预算管理，只能事后惊讶 |

## 3. 独立性约束（防锚定）

| 角色 | 不得读取 | 原因 |
|---|---|---|
| 锐评 Agent | 执行 Agent 的自我评价、执行日志 | 会在别人的框架里打分 |
| 验收 Agent | 锐评 Agent 的分数 | 锐评管「好不好」，验收管「过不过」，混了就变成一个人 |
| 批判 Agent | 其他批判 Agent 的结论 | 防止第一个发言者定义议题 |
| 红队 Agent | 执行 Agent 的薄弱点自述 | 会直接照着打，失去独立构造反例的意义 |
| 探针 Agent | 目标 Agent 的推理文本，**只读工具调用日志** | 推理文本会诱导探针认同目标 |

**实现方式**：不靠 prompt 里写「请不要读」，靠**不提供路径**。主线程派发时只给必要的输入文件路径。

## 4. 角色清册

| 角色 | 工具白名单 | model | 职责 | 不可合并的理由 |
|---|---|---|---|---|
| `planner` | Read, Write, Glob, Grep | inherit | 拆解任务，声明验收标准与产出形态 | — |
| `executor` | Read, Write, Edit, Bash, Glob, Grep | inherit | 实质执行 | — |
| `research` | Read, Grep, Glob, WebSearch, WebFetch | inherit | 搜集外部事实 | 需要网络，executor 不该默认有 |
| `critic` | Read, Grep, Glob | inherit | 质疑**拆解与前提** | 输入是拆解图，不是交付物 |
| `redteam` | Read, Grep, Glob, Write | inherit | 攻击**交付物与结论** | 输入是交付物，不是拆解图 |
| `review` | Read, Grep, Glob, Write | inherit | 质量评分（1–10） | 主观评分，与客观判定分离 |
| `acceptor` | Read, Grep, Glob, Write | inherit | 对照预声明标准判定，一票否决 | 客观判定，不写分数 |
| `repair` | Read, Write, Edit, Bash, Glob, Grep | inherit | 仅在失败时触发 | 需要写权限，但不得改验收标准 |
| `probe` | Read, Grep, Glob | haiku | 只读日志判 `HEALTHY/UNFOCUSED/LOOPING` | 纯判定，允许短生命周期 |
| `relay` | Read, Grep, Glob, Write | inherit | 产出接力草稿 | — |
| `safety` | Read, Grep, Glob | haiku | 检查草稿是否触碰红线 | 输入是草稿，与 relay 的输入不同 |
| `resolution` | Read, Grep, Glob, Write | inherit | 裁决分歧 | 输入是双方原话，与 safety 不同 |

**`critic` / `redteam` / `review` / `acceptor` / `safety` / `probe` 全部没有 `Edit`**。这不是 prompt 里的「请勿修改」，是工具集物理限制。`scripts/check-structure.mjs` 会验证这一点。

**为什么 `relay` 和 `safety` 不合并**：合并后就是「自己写草稿、自己审红线」，重演参考项目「锐评自己写自己」的失效模式。

## 5. 产出形态声明格式

Planning 派发每个 Agent 时必须写明：

```yaml
shape: artifact | exploration | hybrid
acceptance:                      # 预声明，事后不得增补
  - id: AC1
    criterion: <可观测事实>
    evidence: <引用形式，如 file:line>
    fail_if: <什么情况直接否决>
token_budget_pct: 40
timeout_min: 8
```

## 6. 返回值格式

子 Agent 的最终返回**不是散文**，是结构化三元组：

```
## 交付物
<路径 或 内联结论>

## 执行日志
<关键决策点，每条一行，不写过程叙事>

## 我认为的薄弱点
<1–3 条，主动暴露>
```

返回超过 15 行视为格式不可解析，按 `docs/spec/state-model.md` §2 判定是否属 `FAILED`。**注意：不得因「没有交付物」直接判失败**——必须先过四态判定，`EXPLORING` 态的空返回是正常的。

## 7. 递归派生

子 Agent 可以派生下级，默认深度上限 3 层（宿主默认值即为 3，见 `docs/adr/0001-config-only.md`）。

**每一层派发必须写明「为什么需要这一层，而不是由父级自己完成」**。写不出理由就不许派生。到达深度 3 时，报告中必须标注「此结论在深度 3 仍未收敛」。
