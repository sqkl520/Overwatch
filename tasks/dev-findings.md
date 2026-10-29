# 范围外发现台账

> 执行 Agent 在**任务范围外**发现的 bug，一律**不得自行修复**，登记到这里，由主线程统一排期。
>
> 为什么要这条：不设边界时，修一个 bug 会扫出三个存量问题，修完又扫出五个，任务永远不闭环。

## 状态枚举

| 状态 | 含义 |
|---|---|
| `open` | 已登记，未处理 |
| `triaged` | 主线程已确认，待排期 |
| `scheduled` | 已进入某个 run 的拆解图 |
| `fixed` | 已修复（附修复的 run-id） |
| `wontfix` | 决定不修（必须写明理由） |

## 登记格式

```
## DF-001 [open] 一句话描述
- 发现于：run-id / agent 名
- 位置：file:line
- 证据：<原文或复现>
- 影响：<如果不修会怎样>
- 建议归属：<哪个子树 / 或「独立任务」>
```

---

## 台账

### DF-001 [fixed] `normalizeBash` 长字符串正则指数回溯，扫描脚本在真实语料上挂死

- **发现于**：验收 run（AC7），验收 Agent 实测
- **位置**：`scripts/scan-sessions.mjs` 的 `normalizeBash`
- **证据**：原实现 `/(["'])(?:\\.|(?!\1).){40,}\1/g` 在 `'` + 连续反斜杠输入上不可终止。实测 `'` + 60 个反斜杠 → **90 秒超时**；真实语料中一条 472 字符的 `grep` 命令单次归一化 17,897ms。`--days 3` 与 `--project MCServers` 均在 60s 超时（exit 124）。
- **影响**：README 的 30 秒上手命令直接挂住；产品唯一的「眼睛」在真实数据上不可用。
- **修复**：改为手写线性状态机 `stripLongStrings()`，O(n)。病态输入现为 0.3–4.2ms，`--days 3` 全量扫描 13s。
- **回归测试**：`state-model.test.mjs` 的「归一化在病态输入上是线性的」

### DF-002 [fixed] 休眠会话被误判为 FAILED

- **发现于**：修复 DF-001 后重跑全量扫描
- **位置**：`judgeState()` 的 FAILED 分支
- **证据**：`[FAILED] Projects/rea calls=2483 ... hb=515s/120s idle=72.3h`。该会话末次间隔 515s 超过 p95=120s，但整体已空闲 72.3 小时——它是结束了，不是失败了。
- **影响**：假警报。用户会去「重跑」一个早就完成的会话。
- **修复**：加 `DORMANT_MS = 1h` 新鲜度闸门，超时判 `EXPLORING` + `reason: dormant` + `liveness: stale`
- **回归测试**：`state-model.test.mjs` 的「长时间无活动的会话判休眠，不判 FAILED」

### DF-003 [open] `--recalibrate` 在文档中承诺但脚本未实现

- **发现于**：验收 run（未覆盖项）
- **位置**：`scripts/scan-sessions.mjs:15` 的用法注释、`docs/spec/state-model.md` §3.5
- **证据**：`main()` 只解析 `--json` / `--project` / `--days`，传 `--recalibrate` 被静默忽略。
- **影响**：规格说「换环境应重估权重」，但没有可执行路径。
- **建议归属**：独立小任务

### DF-004 [triaged] `--recalibrate` 与规格、实现三者已对齐，但 DF-003 仍开放

- **发现于**：验收 run r1（未覆盖项）
- **位置**：`docs/adr/0002-honest-degradation.md`、`docs/spec/state-model.md` §3.5
- **原始问题**：ADR 中 tool_use 与间隔数曾被读成「写反」。复核后确认未写反，但数字已随会话增长过期。
- **现状**：已于 2026-10-30 重算并同步为 **2021 个 transcript / 239,549 次 tool_use / 237,567 个间隔 / 63.1% / 9.72% / p99=1444s**，三处文档一致。规格中「`--recalibrate` 可重算」的表述已删除，改为「换环境应重估」。
- **仍开放**：权重重估没有可执行路径（见 DF-003）。

_（新增条目追加在此行上方）_
