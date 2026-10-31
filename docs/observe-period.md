# P0 观察期：跑什么、看什么、什么时候算够

> 观察期不是「跑着就行」。它要回答三个具体问题，每个都有可判定的标准。
> 本文写清楚：**看哪些数据、什么算通过、什么情况下该改参数或回退。**

## 一、观察期在观察什么

P0 阶段**只观察、只通知，不执行任何代决策**。所以观察期能回答的，也只有「判断得准不准」和「烦不烦」，不涉及「动作对不对」。

三个待答问题：

| # | 问题 | 判定数据 |
|---|---|---|
| Q1 | 通知是不是太多了？ | `observations.jsonl` 的通知率 |
| Q2 | 该通知的有没有漏？ | 被抑制后发现其实卡住的样本 |
| Q3 | 300 秒这个门槛合不合适？ | `--stats` 的 idle 分桶 |

> ⚠ 上一版写于回滚之前。回滚后 Q3 作废、Q1 已由回滚本身回答、Q2 仍答不了。
> **当前有效标准见 §三「改后的标准」。**

## 二、看什么数据

### `%LOCALAPPDATA%\Overwatch\observations.jsonl`

每行一条判定：

```json
{"ts":"...","sessionId":"...","state":"STALLED","kind":"UNCLASSIFIABLE",
 "autoAnswerable":false,"reason":"...","confidence":null,
 "idleSec":420,"notified":false,"why":"unclassifiable-too-recent",
 "classify":"ok","stopId":"..."}
```

关键字段：

| 字段 | 含义 |
|---|---|
| `kind` | 分类结果 |
| `idleSec` | 判定时停了多久 |
| `notified` | 是否发了通知 |
| `why` | 为什么没发（空 = 发了） |
| `classify` | `ok` 或 `error`（找不到 transcript） |

### `--stats`

```bash
node scripts/watch.mjs --stats
```

输出分类分布、通知率、按 state 交叉、以及 `UNCLASSIFIABLE` 的 idle 分桶。

### `runner.log`

看轮询耗时是否稳定：

```
tick jobs jobs=9ms candidates=0
tick probe probe=65ms candidates=0
```

`jobs` 应稳定在 10ms 量级，`probe` 在 100ms 量级。**如果这两个数涨到秒级，说明机器负载或语料规模变了，要查。**

## 三、什么算「跑够了」

### 先说结论：原来的标准不可达

| 指标 | 原定最低 | 实测供给率 | 实际情况 |
|---|---|---|---|
| 观察记录 | ≥ 100 条 | 取决于候选数 | 回滚后 13 小时 **0 条** |
| 已发通知 | ≥ 10 条 | **0.117 条/天** | 要 **85 天**才够 |
| 覆盖天数 | ≥ 3 天 | — | 已满足 |

`0.117 条/天` 不是估计：本机 `~/.claude/jobs/*/state.json` 跨 **25.6 天、16 个 job**，
其中只有 **3 个** 是 `failed` 或 `blocked`（都在 10 月 7–8 日）。`done` 不算，`stopped` 不算。

**这说明一件比样本量更重要的事**：宿主事实是**稀疏事件**，不是持续信号。
按「攒够 10 条通知」来规划观察期，等于规划 85 天——而 85 天里这套代码大概率早被改了。

### 改后的标准

**观察期的目的不是攒样本，是验证「不误报」。** 这两件事需要的样本量完全不同：

| 要验证的 | 需要什么 | 判定 |
|---|---|---|
| **不误报**（核心） | 每一条发出的通知都要能追到宿主事实 | **100%** 的通知必须能在 `jobs/*/state.json` 找到对应 `state`。**任何一条找不到 → 立即回退** |
| 不漏报 | 无法自测 | 承认做不到，见 §六 |
| 通知量可接受 | 至少 1 条真实通知 | 第一条真实通知到手就可评，不需要 10 条 |

**所以「跑够了」的定义改为**：**出现过至少 1 条由宿主事实触发的通知，且其中的 `needs` / `suggestedReply` 确实对得上那个会话**。一条就够——因为这条路径是确定性的，不是统计性的。

回滚之后 13 小时候选数为 0，**这是符合预期的**，不是失败：
没有会话被宿主报 `failed` / `blocked`。**0 条通知本身就是「不误报」的证据。**

至于原来那三个问题：

| # | 问题 | 现状 |
|---|---|---|
| Q1 | 通知是不是太多了？ | **已由回滚回答**：改前 13 小时 5 条，全部误报；改后 13 小时 0 条。0.117 条/天的供给率决定它多不起来 |
| Q2 | 该通知的有没有漏？ | **答不了**，见 §六 |
| Q3 | 300 秒门槛合不合适？ | **问题本身作废**——门槛服务于 `UNCLASSIFIABLE` 候选，而候选现在只来自宿主事实，不再走分类门 |

### Q2：有没有漏

这个**当前数据答不了**，因为 `observations.jsonl` 只记判定当时的状态，不记「后来怎么样了」。

**可行的补充方法**（观察期结束后手工做一次）：

```bash
# 找出所有被抑制为 unclassifiable-too-recent 的会话
grep 'unclassifiable-too-recent' %LOCALAPPDATA%\Overwatch\observations.jsonl \
  | node -e "..."   # 提取 sessionId

# 对每个 sessionId，看它的 transcript 在判定之后有没有新记录
# 有新记录 → 当时抑制是对的（它自己恢复了）
# 无新记录且距今 > 1 小时 → 当时抑制错了（真的卡住了）
```

**判定标准**：抽 20 个被抑制的样本，如果 **> 30% 其实一直卡着没动**，说明门槛设高了，要调低。

> 这是当前实现的已知缺口：**抑制正确率没有自动统计**。
> 加一个「回访」机制需要在 P1 做——每次判定后 N 分钟再查一次状态。

### Q3：300 秒合不合适

**这个问题在回滚之后作废了。** 三百秒门槛只对 `UNCLASSIFIABLE` 候选生效，而现在的候选
只来自宿主事实（`jobs.state ∈ {failed, blocked}`）——它们不经过分类门，也不经过时间门。

保留原分析以备将来重新引入分类路径时参考：

> 回放 4610 个真实停止点（158 个 transcript，跨 4.5 个月），候选的 idleSec 分布
> `p50=1052s`、`min=132s`、`900-1800s` 占 75.3%。
> 原因：`hb_gap` 判据要求「末次间隔超过会话自适应 p95」，而 p95 被 clamp 在 120–900 秒。
> **一个会话被判成候选时，它往往已经停了十几分钟。** 门槛在它面前没有机会生效。
>
> 实测把门槛从 60 调到 300，通知量是 67 对 66——差异来自扫描相位，不是门槛。
>
> ⚠ 上一段的「hb_gap 判据」已随 §2.0.1 删除。这段数据只描述历史，不代表当前行为。

**所以观察期不该再花时间验证这个门槛。** 回滚后该看的只剩两件事：

| 该看的 | 在哪 | 判据 |
|---|---|---|
| 每条通知能否追到宿主事实 | `watch.log` 的 `notified` 行 ↔ `jobs/*/state.json` | **必须 100%**，有一条对不上立即回退 |
| 通知里的 `needs` / `suggestedReply` 是否确实属于那个会话 | 对照 `jobs/*/state.json` 原字段 | 必须逐字一致 |

**「通知太多」已经不是风险了**——供给率 0.117 条/天决定了上限。真正要防的是**发错**。

## 四、什么情况下该回退

出现以下任一，**停止观察，回来改设计**：

1. **通知追不到宿主事实**：任一条 `notified` 在 `jobs/*/state.json` 里找不到对应的 `failed` / `blocked`。**一条就够，不设比例阈值**
2. **`needs` / `suggestedReply` 张冠李戴**：通知里显示的等待内容不属于该会话
3. **资源异常**：`runner.log` 里 `probe` 耗时 > 5 秒，或进程 CPU 持续 > 5%
4. **实例争用**：日志出现 `state.json 被另一个进程占用` 或 `tick-failed`

> 原来的第 1、2 条（「分类全 collapse」「误报率不可接受」）已删除：分类路径不再参与通知，
> 这两条无从观测。它们对应的担忧由 `NOTIFY_STATES = ['FAILED','BLOCKED']` 在结构上消除。

## 五、观察期结束后产出什么

写一份 `docs/research/<日期>-p0-observations.md`，必须包含：

1. **实际天数，以及期间宿主产生了几个 `failed` / `blocked`**（这是分母，不是观察记录数）
2. **每条通知的完整追溯**：`notified` 行 → `jobs/*/state.json` 的字段对照，逐条列出，**不允许抽样**
3. **0 条通知时的结论**：如果这期间宿主本来就没有 `failed` / `blocked`，如实写「无可观测事件」，**不要用 0 条数据推出『没有误报』这种结论**——0 条只说明没机会犯错
4. **对 P1 的具体建议**：哪条信号最该先接

**如果样本不够，明确写「样本不足，无法判定」**，不要用几十条数据硬给结论。

> 上一版要求「分类分布」「300 秒门槛结论」。**这两项已随回滚作废**——分类路径不再参与通知。

## 六、当前已知的缺口

1. **抑制正确率无自动统计**（见 Q2）。需要手工回访。
2. **`classify: error` 混在分布里**：找不到 transcript 的会话会标 `classify-error`，`--stats` 目前不单独列出，看分布时要结合 `why` 字段。
3. **同一次停止可能留两行**：先记「抑制」再记「通知」，所以 `--stats` 的抑制计数会高于「被挡住的停止事件数」。
4. **在线看不到「下一句」**：87.7% 落到 `UNCLASSIFIABLE`，这是结构性限制，不是 bug。详见 `docs/research/2026-10-31-online-classification.md`。

## 七、日常检查命令

```bash
# 判定分布（最常用）
node scripts/watch.mjs --stats
```

统计通知数与抑制数，用 node 解析而不是 grep——grep 依赖 JSON 的格式细节，字段顺序或空格一变就失效：

```bash
node -e "
const fs=require('fs');
const f=process.env.LOCALAPPDATA+'/Overwatch/observations.jsonl';
if(!fs.existsSync(f)){console.log('还没有观察日志');process.exit(0)}
const c={total:0,notified:0,byWhy:{},byKind:{}};
for(const l of fs.readFileSync(f,'utf8').split('\n')){
  if(!l.trim())continue;
  try{const o=JSON.parse(l);
    c.total++;
    if(o.notified)c.notified++;
    c.byWhy[o.why||'sent']=(c.byWhy[o.why||'sent']||0)+1;
    c.byKind[o.kind]=(c.byKind[o.kind]||0)+1;
  }catch{}
}
console.log('总判定:',c.total,' 已通知:',c.notified,'('+(100*c.notified/c.total).toFixed(1)+'%)');
console.log('按原因:',JSON.stringify(c.byWhy,null,1));
console.log('按类型:',JSON.stringify(c.byKind,null,1));
"
```

轮询耗时与进程状态：

```bash
tail -20 %LOCALAPPDATA%\Overwatch\runner.log | grep -E 'jobs=|probe='
```

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*watch.mjs*' }"
```
