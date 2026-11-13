# Baseline 模板 · 当轮事实快照

> 派发前由主线程生成，随每个子 Agent 的 prompt 一起发下去（`docs/spec/dispatch-contract.md` §1）。
>
> **为什么必须共享同一份**：所有 Agent 对同一组数字发言，才能发现「A 说 87 个文件、B 说 92 个」。
> 没有它，每个 Agent 自己去数，分歧会被误当成发现。
>
> 三条纪律：
> 1. **先跑命令，再填数字。** 每个数字后面写它是哪条命令得来的。
> 2. **不写「约」「大概」。** 算不出来就写 `unknown`，并说明为什么算不出来。
> 3. **不复制上一轮的 baseline。** 它是快照不是配置——上一轮的数字这一轮就是错的。

## 元信息

```
run_id:
generated_at:          # ISO 时间戳
generated_by:          # 主线程
repo_head:             # git rev-parse --short HEAD
branch:
working_tree:          # clean / N 个未提交文件
```

## 仓库规模

| 指标 | 值 | 取自 |
|---|---|---|
| 跟踪文件数 | | `git ls-files \| wc -l` |
| 源码行数（scripts/） | | `wc -l scripts/*.mjs` |
| 文档份数（docs/） | | `find docs -name '*.md' \| wc -l` |
| 回归测试数 | | `node --test scripts/*.test.mjs` 输出的 `tests` 行 |

## 硬门状态

```
node scripts/check-structure.mjs   →   exit 0 / N 项违规（逐条抄）
node --test scripts/*.test.mjs     →   pass N / fail N
```

## 已核实的关键事实

> 这一节是本轮**所有 Agent 都必须同意**的前提。每条写「结论 + 出处 + 怎么复算」。
> 只写你亲手跑过的；转述别人的结论要标「未复核」。

| # | 事实 | 出处（file:line / 命令） | 我复核过吗 |
|---|---|---|---|
| 1 | | | |

## 已知问题（本轮不动）

> 从 `tasks/dev-findings.md` 的 open 项与 `tasks/accepted-deviations.md` 抄过来。
> 目的：让 Agent 知道哪些「发现」是已知的，不要重复报。

| ID | 一句话 | 状态 |
|---|---|---|

## 明确不在范围内的

> 写清楚本轮**不**改什么，避免 Agent 顺手扩大范围（`CLAUDE.md` 硬约束的反面）。

-
