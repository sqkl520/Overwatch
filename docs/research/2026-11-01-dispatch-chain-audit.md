# 派发链路端到端普查

- 日期：2026-11-01
- 目的：验证 `SKILL.md` → planner → agent → 产出的整条链路，不靠读代码猜

## 一、查出的断点

### 1. `oversight-probe` 定义了，但 SKILL.md 从不派它

`oversight-probe` 的角色定义存在，触发条件还专门改过（指向收件箱），
但 `SKILL.md` 里**零引用**——它的触发条件永远不会生效。

**影响**：`WAITING` 但 `needs` 为空时，SKILL.md 直接派 `oversight-relay`。
而 relay 拿不到「在等什么」就只能编。probe 的职责正是先判这一步
（只看工具调用日志、不读推理文本，三选一给出 `HEALTHY_EXPLORING` / `UNFOCUSED` / `LOOPING`）。

**修复**：路由表新增「先派 probe 再据此派 relay」；结构门加 `checkAgentReachability()`，
任何角色定义了却不被派发直接 fail。

### 2. `task-graph.json` 的 schema 写了，但产物从不校验

`.claude/agents/oversight-planner.md` 里完整定义了 `task-graph.json` 的 schema，
但**没有任何东西检查产出的 JSON 符合它**。

**第一个真实 run 就漏了三个必填字段**：

```
$ node scripts/validate-run.mjs tasks/runs/2026-10-30-p0/task-graph.json
✗ subtrees[0].token_budget_pct: 必须是 0 到 100 之间的数字
✗ subtrees[0].parallel_with: 必须是数组
✗ subtrees[0].depends_on: 必须是数组
```

**修复**：新增 `scripts/validate-run.mjs`，把 schema 变成可执行检查，
校验 CLAUDE.md 硬约束 2/4/6/8 对应的字段；SKILL.md 规划阶段要求先校验再派发；
结构门保证这条引用不被删。

## 二、校验器抓出的第二个问题：复杂度阈值是我编的

第一版写「`>= 5` 个子任务就算复杂，必须含 review/acceptor/repair」，
结果把一个真实的 2 任务 run 判成违规。

但那个 run 是合理的——一次小改动确实不需要 5 个 Agent。
CLAUDE.md 硬约束 2 说的是「**复杂任务**」，而「是不是复杂」是规划时的判断，不是数字推断。

**把阈值硬塞进校验器，只会训练人绕过它。** 改成调用方显式传 `requireComplex`。

## 三、仍然无法验证的部分

| 环节 | 为什么验不了 |
|---|---|
| planner 实际拆解质量 | 需要一个真实任务跑一轮，且要人判断拆得好不好 |
| agent 产出是否遵守模板 | `tasks/runs/` 被 gitignore（含会话 ID），历史产物不在仓库里 |
| 主线程是否真的「不亲自做」 | 这是行为约束，代码无法强制 |

## 四、这一轮的方法

先枚举所有显示/派发路径，再逐个用真实数据跑，**不靠读代码猜**。
两处断点都不是读代码能看出来的：probe 的孤儿状态要 grep 交叉引用；
schema 不校验要拿真实产物跑一遍校验器才暴露。
