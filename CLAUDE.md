# CLAUDE.md

本仓库是 **Overwatch**：跨会话 AI 任务监控与接力调度系统。代号 OmniSight。

> **先读 [README.md](README.md) 的能力边界。** 本库不能自动接力。

## 硬约束（不可协商）

1. **主线程只做三件事**：拆解、派发、汇总。不亲自检索、分析、编码、写作。
2. 复杂任务至少 5 个独立 Agent 并行，必须包含锐评、验收、修复三个不可合并的角色。
3. **锐评的结论不能由执行 Agent 自己写**，且锐评的 prompt 中不得包含执行 Agent 的自我评价。
4. **验收 Agent 一票否决**。标准必须预先声明，不得事后编造。
5. **禁止静默共识**。多 Agent 结论相同时，至少一个被要求找反面证据。找不到反例 ≠ 结论正确。
6. 递归派生默认深度上限 3 层，每层须写明「为什么需要这一层」。
7. **全量重跑仅适用于 `FAILED` 态**。`EXPLORING` 态严禁重跑。
8. 派发时必须声明产出形态（`artifact` / `exploration` / `hybrid`）与预算。未声明视为规划缺陷。

## 规格入口

**先读 [`docs/README.md`](docs/README.md)** —— 它按「你想知道什么」指路，并说清四类文档的可信度不同
（`spec/` 是现行事实、`design/` 全部未实现、`research/` 是会过期的过程记录）。

| 需要什么 | 读哪个 |
|---|---|
| 能做什么、每条能力对应的命令 | `docs/CAPABILITIES.md`（硬门会核那上面的命令） |
| 状态怎么判、阈值多少 | `docs/spec/state-model.md` |
| 怎么派发、给 Agent 什么 | `docs/spec/dispatch-contract.md` |
| finding 怎么写、台账怎么用 | `docs/spec/evidence-discipline.md` |
| 接力怎么触发、草稿怎么写 | `docs/spec/relay-protocol.md` |
| 输出长什么样 | `docs/spec/output-format.md` |
| 为什么是纯配置库 / 为什么降级 | `docs/adr/0001-config-only.md`、`docs/adr/0002-honest-degradation.md` |
| 某条研究结论还成不成立 | `docs/research/README.md`（状态索引 + 「已被推翻的结论」表） |
| 想看设计推演（**全部未实现**） | `docs/design/README.md` —— 先读它，再决定要不要点进去 |

## 常用命令

```bash
node scripts/scan-sessions.mjs --days 3        # 扫描会话，判定状态（耗时随语料增长，跑一次看实际值）
node scripts/scan-sessions.mjs --json          # 机器可读
node scripts/verify-claims.mjs --days 3        # 「AI 说它做完了」有没有证据
node scripts/check-structure.mjs               # 结构硬门
node --test scripts/*.test.mjs                 # 全量回归测试（1276 条，硬门会对账这个数字）
```

**任何改动后必须跑 `check-structure.mjs` 和全量测试。** 两者都绿才能提交。

> 注意：实际产出有区分度的只有宿主上报的 `FAILED` / `BLOCKED` / `WAITING`。其余状态是描述，不是判据——
> 不要用 `EXPLORING` / `PRODUCING` / `STALLED` 去驱动重跑或重拆解。见 `README.md`「六种状态」。

## 目录归属（谁能写哪里）

| 内容 | 位置 | 可发布 |
|---|---|---|
| Agent 角色定义 | `.claude/agents/*.md` | 是 |
| 调度流程 | `.claude/skills/oversight/SKILL.md` | 是 |
| 规格与决策记录 | `docs/` | 是 |
| 派发模板 | `templates/` | 是 |
| 校验脚本 | `scripts/` | 是 |
| 两本台账 | `tasks/dev-findings.md`、`tasks/accepted-deviations.md` | 是 |
| **运行台账** | `tasks/runs/` | **否**（gitignored，含会话 ID） |
| **本机配置** | `.claude/settings.local.json`、`CLAUDE.local.md` | **否** |

**禁止在可发布区出现本机绝对路径。** `check-structure.mjs` 会拦。

## 与参考项目的关系

结构参考了一个同类项目的双层工作区，但**刻意不照搬**：

- 借鉴：控制层/发布层分离、四件套证据纪律、两本台账、工具白名单限制写权限、分级门禁。
- 丢弃：`versions/` 提交二进制、`tasks/` 占 42% 跟踪文件、`agent-memory` 多份分叉、硬编码本机路径。
- **特别注意**：那个项目的 `.gitignore` 忽略 `.claude/`、`rules/`、`tasks/`。对它正确，对**本仓库致命**——照抄会让 `git add -A` 静默什么都不加。`check-structure.mjs` 专门检查这条。

## 提交前

1. `node scripts/check-structure.mjs` 通过（含 CHANGELOG 硬规则：改了源码/规格却没记条目会**直接 fail**）
2. `node --test scripts/*.test.mjs` 全绿
3. 若改了规格，同步更新 ADR 或台账
4. 不用 `git add -A` —— 先 `git status` 看清楚
