# 第一个生产指标：通知可追溯率 = 0.0%

- 日期：2026-10-31
- 数据来源：本机 `%LOCALAPPDATA%\Overwatch\watch.log`（5,348 行，跨 2026-10-30 18:00 ~ 2026-10-31 13:14）
- 判定：**FAIL**（阈值 100%，实测 0/5）
- 意义：这是本项目**第一个在真实生产运行中测量、且阈值在测量之前就写死的指标**。
  在此之前所有数字都是离线回放或事后重建。

## 一、为什么选这个指标

锐评 agent 给的及格线是：

> 有一个指标是在生产里测出来的而不是回放模拟的，且阈值在测之前就写死。

按这个标准，本项目此前**一条都不满足**。要么是回放（`replay-observe.mjs`），要么是扫历史 transcript
（`scan-sessions.mjs`），要么是文档里的估算。真正由后台守护进程 `watch.mjs` 在运行中产生的数据只有一处：
`watch.log` 里的 `notified` 行。

生产数据能支撑的指标也只有这一处。摊开看：

| 想测的 | 能不能测 | 为什么 |
|---|---|---|
| 通知数是否过多 | 能，但样本 5 条 | 供给率 0.117 条/天，攒不出分布 |
| 是否漏报 | **不能** | 需要知道「该通知而没通知」的事件总数，无基准 |
| 分类是否准确 | **不能** | 在线 100% `UNCLASSIFIABLE`，没有可比的真值 |
| **通知是否可追溯** | **能** | 每条通知都能到 `~/.claude/jobs/*/state.json` 里找对应记录 |

「可追溯」是唯一一个**每条通知都能独立判定真伪**的指标：它不需要真值标注，不需要对照组，
只需要「这条通知说 X 会话 `FAILED`，请指出宿主在哪写了 `FAILED`」。

## 二、阈值（写于测量之前）

```
任何一条通知，若在 ~/.claude/jobs/*/state.json 中找不到该 sessionId 且 state ∈ {failed, blocked}
的记录，即为不可追溯。
阈值：可追溯率必须 = 100%。不设百分比宽容——5 条样本上的「80% 可追溯」没有意义。
```

选择 100% 而不是「≥95%」的理由：一条通知的代价是用户从工作中被打断。一条假警报就是一次真实打扰，
而这类打扰只要发生过，用户就会开始忽略所有通知——**漏报的代价是线性的，误报的代价是断崖式的**。

## 三、结果

```
通知条数：5
job 文件：16（failed/blocked：3）

[UNTRACEABLE] 2026-10-30T18:08:28Z state=FAILED  session=5ead31fa  → no job file
[UNTRACEABLE] 2026-10-30T20:01:37Z state=FAILED  session=d48b776b  → no job file
[UNTRACEABLE] 2026-10-30T20:24:13Z state=FAILED  session=d48b776b  → no job file
[UNTRACEABLE] 2026-10-30T20:53:08Z state=FAILED  session=5ead31fa  → no job file
[UNTRACEABLE] 2026-10-30T23:05:36Z state=FAILED  session=70ea7c06  → no job file

可追溯率：0.0%  (0/5)
判定：FAIL
```

**五条全部不可追溯，一条都对不上。** 而且这五条全部发生在 2026-10-30 18:00–23:05，
即 `hb_gap` 推断被删除之前（`d90a39d`，10-31）。删除后 13 小时内通知数为 **0**。

复算方式：

```bash
node -e "
const fs=require('fs'),p=require('path'),os=require('os');
const log=fs.readFileSync(p.join(process.env.LOCALAPPDATA,'Overwatch','watch.log'),'utf8');
const n=[...log.matchAll(/notified (\w+) (\S+) .*session=(\S+)/g)].map(m=>({s:m[1],id:m[3]}));
const jobs=fs.readdirSync(p.join(os.homedir(),'.claude','jobs')).map(d=>p.join(os.homedir(),'.claude','jobs',d,'state.json')).filter(f=>fs.existsSync(f)).map(f=>JSON.parse(fs.readFileSync(f,'utf8')));
let ok=0;for(const x of n){const j=jobs.find(j=>j.sessionId===x.id);if(j&&(j.state==='failed'||j.state==='blocked'))ok++;}
console.log(ok+'/'+n.length);
"
```

## 四、这个结果说明什么

**它不是「指标测出了 bug」，而是「指标测出了这类通知本来就不该存在」。**

五条通知全是 `hb_gap` 推断产生的 `FAILED`。`hb_gap` 的语义是「这个会话已经超过自己的 p95 间隔没动了」。
而 `jobs/*/state.json` 只记录宿主认为**失败**或**阻塞**的会话。**这两者本来就不该有交集**——
推断出来的「卡住」在宿主的账本上根本不存在，因为它不是宿主的判断。

所以 `0/5` 不是巧合，是**结构性的 0**。一条从推断产生的通知，永远无法追溯到宿主事实。
这个指标在旧架构下**不可能通过**，删除 `hb_gap` 是唯一能通过它的方式。

这也反过来解释了为什么这个指标值得保留：**它把「通知是否诚实」变成了一个可执行的检查**，
而不是靠事后读日志说「这些看着都像误报」。

## 五、对当前的判定与后续

- **当前架构下**：`NOTIFY_STATES = ['FAILED','BLOCKED']`，候选**只能**来自 `jobs.state`。
  按构造，每条通知必然可追溯。所以这个指标现在是**结构性满足**的，不需要再测一次来证明。
- **但它仍然需要在真实数据上跑一次才算验证过**。当前状态：**0 条通知**，无法判定。
  按 `observe-period.md` 的新标准，需要等到「1 条真实通知且 `needs`/`suggestedReply` 对得上」。
- **如果将来任何改动让通知重新从推断产生**（哪怕是「更准的推断」），这个指标会立刻从 100% 掉下来。
  这是它作为回归护栏的价值。

## 六、诚实的边界

1. **样本只有 5 条，且全部来自已删除的架构。** 它证明了旧架构不合格，**没有**证明新架构合格。
   新架构的合格是**构造上**的，不是实测的。两者不是一回事，文档里不能混着写。
2. **这个指标无法测「漏报」。** 一条都没发的会话，没有东西可以追溯。
3. **「可追溯」不等于「该发」。** 宿主报 `failed` 的会话，用户可能早就知道了。
   可追溯只排除了「凭空发明」，没有排除「正确但无用」。
