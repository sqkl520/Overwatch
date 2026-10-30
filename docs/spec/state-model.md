# 四态模型规格

> 本文件是可执行判据的**唯一真源**。任何与此冲突的表述（包括原始设计稿）以本文件为准。
> 阈值来历与实测证据见 [`../adr/0002-honest-degradation.md`](../adr/0002-honest-degradation.md)。

## 1. 为什么不是「成功 / 失败」

把「没有交付物」和「没有报错」混为一谈，会让正常探索期被误判为失败，进而触发全量重跑；重跑后又是探索期，再被误判——死循环。

因此定义四个状态，并把「零产出」改名为**零语义增益**：读一个新文件是增益；第 4 次读同一个文件、内容没变，是零增益。

## 2. 状态判定（有序互斥，首个命中即返回）

判定顺序不可调换。每一步的判据必须是**可离线计算的事实**（来自 transcript 或 `claude agents --json`），不是 Agent 的自述。

| 序 | 状态 | 判据 | 处置 |
|---|---|---|---|
| 0 | `FAILED`（宿主权威） | 宿主 `~/.claude/sessions/*.json` 或 `claude agents --json` 明确报 `failed` | 全量重跑。**优先于一切推断**，不被时间冲淡 |
| 1 | `EXPLORING`（休眠） | 最后一次调用距今超过 **1 小时**（`DORMANT_MS`） | 不干预。标注 `reason: dormant`、`liveness: stale` |
| 2 | `FAILED`（推断） | 任一成立：<br>(a) transcript 出现不可解析行且**连续 3 次**重试仍失败；<br>(b) 心跳间隔超过该会话自适应阈值（见 §4）**且**后续 60s 内无任何新记录；<br>(c) token 预算耗尽且窗口内增益为 0 | 全量重跑（**唯一允许重跑的状态**） |
| 3 | `STALLED` | 连续 3 个窗口 novelty < 0.2，**且**该窗口内无持久化变更，**且**派生树无任一节点有增益 | L2 探针 → L3 收窄 → L4 重新拆解 |
| 4 | `PRODUCING` | 窗口内存在**持久化变更**：成功的 `Write` / `Edit`，或 Bash 命令命中写入类动词表（§3.4） | 不干预，等验收 |
| 5 | `EXPLORING` | 其余全部情况（只读工具、novelty 达标、或冷启动样本不足） | **不干预**，只做预算管理与状态行标注 |

### 2.0 为什么需要「休眠」这一支

没有它的时候，一个空闲 72 小时的会话会因为「末次间隔 515s > p95 120s」被判 `FAILED`（实测反例见 `tasks/dev-findings.md` DF-002）。它是结束了，不是失败了——判 FAILED 会触发一次毫无意义的重跑，且是假警报。

休眠分支**必须排在宿主权威 `failed` 之后**：宿主明确报过失败的会话，不该因为时间久远而被降级成「只是睡着了」。


### 2.1 与原始设计稿的关键差异

原始设计稿写 `PRODUCING = 有 Write/Edit/Bash/最终交付物输出`。但 `ls`、`git status`、`grep`、`cat` **全部是 Bash**。按原文，任何只读探索都会被判 `PRODUCING`，`EXPLORING` 只在「纯 Read、零 Bash」时出现。而 `EXPLORING` 又规定「严禁重跑」，两条规则组合后，纯探索型任务没有任何通过的路径。

本文件把 `PRODUCING` 的判据从「调用了某个工具」改为「产生了持久化变更」。

### 2.2 判定不可由 Agent 自述

`state` 字段只由 `scripts/scan-sessions.mjs` 从 transcript 计算得出。Agent 在返回文本里写「我正在探索」不构成证据。主线程写 `tasks/runs/<id>/state.json` 时，必须携带计算脚本的输出摘要。

## 3. 轨迹新颖度（novelty）

### 3.1 为什么按工具类型分签名

原始公式 `新 (file_path, offset, limit, pattern) 组合数 ÷ 窗口调用数` 只描述了 Read 类工具。实测 239,549 次调用的分布：

| 工具 | 占比 | 是否有 `file_path/offset/limit/pattern` |
|---|---|---|
| Bash | 62.3% | **无**（入参是 `command` / `description`） |
| Read | 15.0% | 有 |
| Edit | 10.4% | 有 `file_path`（无 offset） |
| Grep | 5.9% | 有 `pattern` / `path` |
| Write | 2.0% | 有 `file_path` |
| Agent | 1.5% | 无 |
| Glob | 0.7% | 有 `pattern` |

按原公式，占六成的 Bash 调用签名恒等 → 分子恒为 0 → novelty 恒为 0 → 正常跑 `mvn` / `git` / `node` 的 Agent 被判 `STALLED`。

### 3.2 分签名规则

每个工具调用产生一个签名，并对窗口内该工具的调用统计去重率：

| 工具 | 签名构造 | 说明 |
|---|---|---|
| `Read` | `file_path \| offset \| limit` | 原公式 |
| `Edit` | `file_path \| old_string` 的 SHA-256 前 12 位 | 同文件不同位置算新 |
| `Write` | `file_path \| content` 的 SHA-256 前 12 位 | 覆写同样内容算旧 |
| `Grep` | `pattern \| path \| glob` | |
| `Glob` | `pattern` | |
| `Bash` | `命令首词 \| 去掉可变部分后的参数` 的 SHA-256 前 12 位 | 见 §3.3 |
| `Agent` | `subagent_type \| description` | 同描述重复派发算零增益 |

### 3.3 Bash 签名的归一化

Bash 命令的原始字符串几乎不重复（每次路径都不同），直接用会让 novelty 恒为 1。必须先归一化：

1. 取命令首词作为 `verb`；
2. 剥离以下可变部分：绝对路径（替换为 `<path>`）、数字字面量（替换为 `<n>`）、引号内的长字符串（替换为 `<str>`）、时间戳；
3. 对剩余字符串取 SHA-256 前 12 位。

例：

```
git status --short          → verb=git,    digest(git status --short)
git log --oneline -20       → verb=git,    digest(git log --oneline -<n>)
npm run build               → verb=npm,    digest(npm run build)
```

同一窗口内连续跑 5 次 `git status` 得 novelty 0；跑 `git status` → `npm build` → `git log` → `pytest` → `npm test` 得 novelty 1.0。

### 3.4 写入类动词表（用于 `PRODUCING` 判定）

命中即视为产生持久化变更：

```
> >> tee cp mv rm mkdir touch install
git commit git add git merge git rebase git checkout
npm install npm ci pnpm add yarn add pip install
mvn package mvn install mvn deploy gradle build cargo build go build
```

**显式排除**（读起来像写、实际不是）：`git status`、`git log`、`git diff`、`mvn -v`、`npm ls`、`ls`、`cat`、`echo`（重定向除外）。

### 3.5 归一化加权

```
novelty = Σ_t ( w_t · unique_t / total_t ) / Σ_t w_t
```

只在窗口内 `total_t > 0` 的工具参与求和。默认权重取实测占比：

| 工具 | 权重 |
|---|---|
| Bash | 0.62 |
| Read | 0.15 |
| Edit | 0.10 |
| Grep | 0.06 |
| Write | 0.03 |
| Agent | 0.02 |
| Glob | 0.02 |

权重来自单机样本（2021 个 transcript），换环境应重估：`node scripts/scan-sessions.mjs --recalibrate --days 7` 会统计本机实际的工具分布，并打印可直接粘回源码的 `DEFAULT_WEIGHTS` 字面量。

### 3.6 窗口参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| 窗口大小 | 20 次调用 | |
| 窗口步长 | 5 次调用 | **原始设计稿未定义，此处补齐** |
| 冷启动 | 前 19 次调用 | 不足一窗时：`novelty = null`，状态只能落在 `EXPLORING`，不得判 `STALLED` |
| `STALLED` 阈值 | 连续 3 窗 < 0.2 | 三窗之间必须有重叠步进，不是同一窗口重复计数 |

## 4. 心跳与活性

### 4.1 为什么不用固定 180 秒

实测 237,567 个相邻 tool_use 间隔（实测于 2026-10-30，数字随会话增长会变）：

| 指标 | 值 |
|---|---|
| 至少一次 >180s 的会话占比 | **63.1%** |
| 全部间隔中 >180s 的比例 | **9.72%** |
| p50 / p90 / p99 | 14s / 174s / **1444s** |

按固定 180s 判 `FAILED`，六成以上会话会被判死至少一次。

### 4.2 自适应阈值

```
threshold = clamp(p95(该会话自身全部间隔), 120s, 900s)
```

- 样本 < 20 个间隔：不计算阈值，状态只能落在 `EXPLORING`，标注 `liveness: insufficient-sample`；
- 超过阈值后**不立即判 FAILED**，必须再等 60 秒确认无新记录；
- 判 `FAILED` 时在状态行标注实际阈值，例如 `hb_gap=1240s > p95=620s`。

### 4.3 心跳信号从哪来

`tool_use` block 自身**没有**时间戳，取所在 transcript 行的 `timestamp`。子 Agent 的 transcript 在：

```
~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<agent-id>.jsonl
```

主 transcript 里对应的是 `Agent` 工具的 `tool_use`，其 `id` 与子文件 `.meta.json` 的 `toolUseId` 相同。

### 4.4 `liveness: reconstructed` 的诚实标注

本库没有运行时守护进程，心跳是**事后重建**的，不是实时上报。因此：

- 状态行必须带 `liveness: reconstructed`；
- 不能在会话进行中「实时」干预，只能在下一轮读取时发现；
- 若宿主未来提供实时 hook，升级路径见 `docs/adr/0001-config-only.md`。

## 5. 派生树活性

父 Agent 卡在只读工具上，可能是在等子 Agent。只要派生树**任一节点**有增益，整棵树判 `EXPLORING`，不判 `STALLED`。

### 5.1 树的重建方式（已实测可行）

1. 主 transcript 中每个 `Agent` tool_use 的 `id`；
2. 对应 `<session>/subagents/agent-<id>.jsonl`；
3. 该文件的 `.meta.json` 含 `toolUseId`、`spawnDepth`、`agentType`；
4. 子 Agent 自己的 transcript 里若再有 `Agent` 调用，递归展开。

实测本机语料存在 `spawnDepth` 2（128 个）与 3（4 个），父子可对上。

### 5.2 合并规则

```
tree_gain = max(所有节点的 novelty)
tree_state = (tree_gain ≥ 0.2) ? EXPLORING : 按 §2 依次判定
```

### 5.3 读取收敛性

30 次读取后，若路径仍横跨 `node_modules` / `dist` / `.git` / `target` 且从未进入任务相关目录，标 `unfocused: true`，建议注入收窄提示。此项只做提示，不改变状态。

## 6. 升级阶梯（不可跳级）

| 级 | 触发 | 动作 | 是否改变状态 |
|---|---|---|---|
| L1 | 进入 `EXPLORING` 且 novelty 下滑 | 状态行标注 | 否 |
| L2 | 预算达阈值，或连续 3 窗 novelty < 0.2 | 派 Progress Probe Agent | 否 |
| L3 | 探针判 `UNFOCUSED` / `LOOPING` | 下一轮派发时携带收窄约束 | 否 |
| L4 | L3 后 1 窗仍零增益 | 判 `STALLED`，由 Planning 重新拆解（拆小） | **是** |
| L5 | 同一原因重跑 2 次 | 禁止第 3 次同策略重跑，必须换策略 | 否，标注 `circuit_breaker: true` |

**L3 的能力边界**：无法向运行中的 Agent 注入中途消息。所谓「注入」实为**在下一轮派发该 Agent 时，把收窄指令写进 prompt**。`state.json` 记 `inject: deferred` 而非 `inject: sent`。原始设计稿 §5.4 假设宿主支持中途消息，本库不支持。

## 7. 产出形态与预算

| 形态 | 无 Write 容忍窗口 | 探索 token 预算 | 只看 |
|---|---|---|---|
| `artifact` | 8 分钟 | 任务 token 的 40% | 是否出现持久化变更 |
| `exploration` | 不设窗口 | 任务 token 的 70% | 只判 novelty |
| `hybrid` | 12 分钟 | 任务 token 的 50% | 两者 |

**token 预算的现实边界**：前台交互会话的实际 token 消耗不可查，只能用**代理指标**（调用次数 × 该模型的平均单次开销），状态行里必须标注 `est:`，例如 `budget=est:31%`。

**例外**：后台作业在 `~/.claude/jobs/<id>/state.json` 里有真实的 `tokens` 数值（实测 3,475,667 这种量级）。能关联到 job 的会话，**应当显示真实数字，不得标 `est:`**——用估算值替代已有精确值是倒退。

不得伪造精确百分比。

## 8. 状态行语法

```
[阶段B · Agent#3 EXPLORING · reads=42/novelty=0.74/hb=14s · no_write=4m · budget=est:31% · liveness=reconstructed]
```

字段约束：

| 字段 | 来源 | 约束 |
|---|---|---|
| `阶段` | `state.json` 的 `phase` | A–F |
| `Agent#N` | `state.json` 的 `agents[].id` | 整数 |
| 状态 | §2 计算 | 四选一 |
| `reads` | transcript 计数 | 整数 |
| `novelty` | §3 计算 | 两位小数；冷启动为 `null` |
| `hb` | 距最后一次 tool_use | 秒或分钟 |
| `no_write` | 距最后一次持久化变更 | 分钟；不适用于 `exploration` |
| `budget` | 代理估算 | **必须带 `est:` 前缀** |
| `liveness` | §4.4 | `reconstructed` / `insufficient-sample` / `stale` |

`liveness` 取值含义：

| 值 | 含义 |
|---|---|
| `reconstructed` | 已从事后 transcript 重建出心跳序列 |
| `insufficient-sample` | 间隔样本 < 20，无法算自适应阈值，不下 FAILED 判定 |
| `stale` | 会话已休眠（最后一次调用 > 1h），心跳数据不反映当前状态 |

`reason` 的合法取值：`host-reported-failed`、`dormant`、`hb_gap=…`、`novelty=…`、`persistent-change-in-window`、`read-only`、`cold-start`。

任何字段无法计算时写 `unknown`，**不允许估算出一个看起来精确的数字**。外观像遥测、实际由语言模型编出的数字，比没有状态行更坏。
