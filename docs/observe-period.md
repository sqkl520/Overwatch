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

### 最低样本量

| 指标 | 最低 | 理由 |
|---|---|---|
| 观察记录 | **≥ 100 条** | 少于这个数，分类分布全是噪声 |
| 已发通知 | **≥ 10 条** | 少于这个数，判断不了「烦不烦」 |
| 覆盖天数 | **≥ 3 天** | 要跨过「开机重启」和「长时间不干活」两种状态 |

### Q1：通知是不是太多

**判定标准**：每天通知 ≤ 5 条算正常；> 10 条说明门槛太低或分类太差。

**先看 `--stats` 里的通知率**：

- 通知率 **< 10%** → 正常
- **10–30%** → 偏高，看 Q3 决定要不要调门槛
- **> 30%** → 分类基本没起作用，回到 Q2

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

**这个问题的答案已经用历史语料算出来了，不必等观察期：300 秒既不高也不低，因为它在真实数据上几乎从不触发。**

回放 4610 个真实停止点（158 个 transcript，跨 4.5 个月）：

```
候选的 idleSec 分布（n=166）
  60-300s       8    4.8%
  300-900s     18   10.8%
  900-1800s   125   75.3%
  >=1800s      15    9.0%
  min=132s  p50=1052s
```

原因：`hb_gap` 判据要求「末次间隔超过会话自适应 p95」，而 p95 被 clamp 在 120–900 秒。
**一个会话被判成候选时，它往往已经停了十几分钟。** 门槛在它面前没有机会生效。

实测把门槛从 60 调到 300，通知量是 67 对 66——差异来自扫描相位，不是门槛。

**所以观察期不该再花时间验证这个门槛。** 该看的是：

| 该看的 | 在哪 |
|---|---|
| 通知总量是否可接受 | `runner.log` 里 `sent=1` 的出现频率 |
| 通知内容是否都是 `UNCLASSIFIABLE` | `--stats` 的分类分布 |
| 有没有 `classify: error` | `--stats` 的 `why` 分布 |

如果通知确实太多，**调门槛是无效的动作**——真正该调的是 `hb_gap` 的 clamp 下限，或者给 `UNCLASSIFIABLE` 换一个更强的判据。

## 四、什么情况下该回退

出现以下任一，**停止观察，回来改设计**：

1. **分类全collapse**：`UNCLASSIFIABLE` 占比 > 95%，且 `EXTERNAL_BLOCKED` 也接近 0 —— 说明分类器在在线环境下完全无效，需要 P1 的 `live.status` / `children` 信号
2. **误报率不可接受**：用户实际感受到「通知都是没用的」，且 `--stats` 显示发的都是 `UNCLASSIFIABLE`
3. **资源异常**：`runner.log` 里 `probe` 耗时 > 5 秒，或进程 CPU 持续 > 5%
4. **观察日志写满**：`observations.jsonl` 轮转频繁（> 每天一次），说明判定频率异常

## 五、观察期结束后产出什么

写一份 `docs/research/<日期>-p0-observations.md`，必须包含：

1. **实际样本量和天数**
2. **分类分布**（从 `--stats` 抄，标注取数时间）
3. **Q2 的手工核对结果**（抽了多少、多少抑制错了）
4. **对 300 秒门槛的结论**：保持 / 调高 / 调低，附数据
5. **对 P1 的具体建议**：哪条信号最该先接

**如果样本不够，明确写「样本不足，无法判定」**，不要用几十条数据硬给结论。

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
