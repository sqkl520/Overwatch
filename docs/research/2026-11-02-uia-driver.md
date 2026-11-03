# UIA 驱动桌面版 Claude Code：实测报告

**日期**：2026-11-02
**执行**：执行 Agent R3
**产出**：`scripts/uia-probe.ps1`（可运行，只读/低风险子命令，**未实现真实发送**）
**结论一句话**：**读写可行，但不足以支撑无人值守自动发送。** 读取可以做到零打扰且可靠；写入会抢焦点、是异步的、且存在"报告成功但没写进去"的静默失败。不建议在当前形态下接自动发送。

---

## 一、结论先行

| 能力 | 结论 | 关键证据 |
|---|---|---|
| 读会话列表 / 读输入框 / 读当前会话 / 读忙碌态 | **可用，且不打扰用户** | 72/72 次前台采样无变化，窗口保持最小化 |
| 按名字定位会话 | **可用，但必须"找不到就中止"** | 20/20 精确命中；中段子串直接拒绝 |
| 写入输入框 | **可用但危险** | 抢焦点 + 异步 + 静默失败 |
| 真实点击 Send | **本报告不建议** | 见第五节五条阻断项 |
| 高频调用 | **不可行（CLI 形态）** | 冷启动 12–30 秒，热进程 ~195 毫秒 |

**一句话风险**：写入路径会**把最小化的窗口弹到前台并夺走键盘焦点**。实测时这打断了用户正在进行的输入。这不是理论风险，是发生过的。

---

## 二、实测数字

### 2.1 耗时（同一台机，CLI 冷启动，5 次）

| 子命令 | 5 次耗时 (ms) | 均值 |
|---|---|---|
| `enum-windows` | 16572 / 15916 / 12274 / 14055 / 15142 | ~14.0 s |
| `list-sessions` | 16710 / 20963 / 22688 / 15915 / 28742 | ~19.0 s |
| `get-status` | 25641 / 23336 / 30303 / 29610 / 20234 | ~25.8 s |

**耗时分解（单进程内计时，总计 12274 ms）**：

```
process+parse start                    17 ms
Assembly load                         322 ms
Add-Type C# compile                  7694 ms   <-- 占 63%
FromHandle (首次)                     8188 ms   <-- 首次触碰 +494 ms
FindAll Buttons (369)                9027 ms
FindAll All (1210)                  10217 ms
FindFirst Sidebar                   10282 ms
sidebar buttons w/ Name+Rect (62)   10481 ms
FindFirst Prompt                    10719 ms
ValuePattern read                   10745 ms
header scan over 1210 elems: 1526 ms (hits=1)
```

**热进程内循环（编译一次后跑 10 轮完整会话枚举）**：

```
setup_ms    = 3896
per_iter_ms = 322,188,189,195,171,180,172,185,175,174
avg         = 195 ms   min 171 / max 322
```

**结论**：冷启动的瓶颈是 `Add-Type` 的 C# 编译（约 7.7 秒），不是 UIA 本身。**热进程 195 毫秒 vs 冷启动 20 秒，相差约 100 倍。** 任何自动发送方案必须是长驻进程，不能是每次起一个新进程。

### 2.2 焦点抢占

**只读操作：不抢焦点。**

```
BASELINE 无 UIA 3 秒： 前台窗口种类 = 1
UIA 读操作 6 轮：      前台采样 ≠ Claude 的次数 = 72/72
                      前台窗口种类 = 1（始终是用户原来那个窗口）
操作结束时 Claude iconic = True（仍最小化），前台 = 用户窗口
```

**写入操作：抢焦点，并把最小化窗口恢复。**

```
执行前： 前台 = <hwnd-a> (pid <pid-a>, "<other-app-window>")
执行后： 前台 = <hwnd-b>   (pid <pid-b>, "Claude")
        Claude iconic False，fgIsClaude True
```

即：`write-prompt` 一次就把用户从另一个应用切走了。**这条必须写进 relay 设计约束**——如果守护进程在用户打字时写草稿，用户会正在输入到一半被弹走。

### 2.3 并发

4 个进程同时 `list-sessions`：

```
proc1 ok=true count=16 elapsed=3034
proc2 ok=true count=16 elapsed=2838
proc3 ok=true count=16 elapsed=3370
proc4 ok=true count=16 elapsed=2587
```

**4/4 全部成功，无异常、无互相污染**（纯读）。但注意并发不会更快——UIA 调用本身在 UI 线程上排队，4 个并发总耗时接近串行之和。写入并发未测（不做，因为写入本身要避免叠加）。

脚本里提供了 `Global\OmniSightUiaProbe` 命名互斥量的用法示例，实测 0 次等待超时。

### 2.4 会话定位可靠性

**坐标漂移实测**（同一个 OmniSight 会话行，三次采样）：

| 时刻 | 侧边栏 x | OmniSight 行 y | 列表顺序 |
|---|---|---|---|
| T1 | 8 | 376 | 第 3 位 |
| T2（窗口最小化） | 8 | 556 | 第 6 位 |
| T3（窗口被恢复） | 297 | — | 顺位再次变化 |

- x 从 **8 → 297**，整列平移 289 px
- 同一个会话行的 y 从 376 → 556，位移 180 px
- 窗口最小化时窗口矩形报 `-32000,-32000 160x28`

**所以任何固定坐标、任何"第 N 行"都不可用。** 脚本内**不含任何硬编码坐标**，全部按名字解析。

**按名字解析的严格度实测**（针对当前 20 行）：

```
exact full name      : EXACT:OmniSight Overwatch now
title only           : PREFIX:OmniSight Overwatch now
title + project      : PREFIX:OmniSight Overwatch now
partial (mid-string) : NOTFOUND          <-- 中段子串拒绝，防止误配
substring of 2 rows  : AMBIGUOUS-PREFIX:2  <-- 歧义直接中止
<project-B> (2 rows)   : AMBIGUOUS-PREFIX:2  <-- 同名会话真实存在
nonexistent          : NOTFOUND
empty                : NOTFOUND
chinese title only   : PREFIX:<session-title>
```

匹配阶梯：**精确 → 标题前缀 → 中止**。不存在"取第一个"、"取最近的"、坐标兜底。

### 2.5 误点后果

实测"找不到"路径：

```
$ uia-probe.ps1 dry-run-send "PROBE" -Match "no-such-session-xyz" -Json
exit = 2
error = active session does not match 'no-such-session-xyz'
        (active: '<session-title>'). Refusing to write.
```

**并且输入框未被触碰**（事后读回 `length=1, emptyish=true`，即空编辑器的那个换行）。

设计上截断了所有"乱点"路径：
1. 解析不到 → `exit 2`，不写
2. 解析到多行 → `exit 5`，不写
3. 当前会话与 `-Match` 不符 → `exit 2`，不写
4. **彻底没有基于坐标的点击**，所以"点错位置打开意外面板"这一类事故在结构上不可能发生

`dry-run-send` 只报告"会点哪个按钮"，**从不调用 InvokePattern**，且返回体里固定带 `"sent": false`。

### 2.6 多窗口

```
claude 进程数：23
顶层候选窗口：19
其中 Chrome_WidgetWin_1 且属于 claude 进程：4
  hwnd <hwnd-1>  hidden     <x>,<y> <w>x<h>    title=[Claude]
  hwnd <hwnd-2>  visible    <x>,<y> <w>x<h>    title=[Claude]     <-- 只有一个是真的
  hwnd <hwnd-3>  hidden     <x>,<y> <w>x<h>    title=[]
  hwnd <hwnd-4>  Chrome_WidgetWin_0  0x0       （子控件宿主）
```

**坑**：有 **3 个** 窗口标题都是 `Claude`。只按标题匹配会随机挑到隐藏窗口。脚本的选窗规则是四层：

1. 进程名 `^claude`（仅此不够，23 个进程只有一个有窗口）
2. 顶层 + `Chrome_WidgetWin_1` + 可见 + 非最小化
3. 尺寸 ≥ 800×600（最小化时跳过，因为会报 160×28 的假矩形）
4. **结构确认**：UIA 子树里必须同时找得到 `Group[Sidebar]` 和 `Edit[Prompt]`

**只有第 4 层是决定性的**——它把启动画面、隐藏宿主、通知窗口全部排除。当可用窗口 >1 个时，脚本拒绝猜，直接报 `exit 6` 要求调用方传 `-Hwnd`。

### 2.7 UIA 失效与重试

**重试包装语义实测**：

```
transient(2 次失败后成功) : result=ok attempts=3     <-- 会重试
permanent(一直失败)       : 3 次后抛错 code=7        <-- 会耗尽
logic(not-found)          : 1 次后抛错 code=2        <-- 不重试（关键）
```

最后一条是重点：**"找不到"属于逻辑错误，重试 5 次也还是找不到，只会把 20 秒拖成 100 秒**。脚本用异常上的 `ProbeExitCode` 把逻辑错误和瞬时错误分开，逻辑错误立即抛出。

**失效不是时间导致的**：缓存 20 个元素句柄，静置 45 秒后：

```
after 45s: reads=40 staleExceptions=0 positionChangesInCachedHandles=0
fresh rows: 20   cached rows: 20   same-position matches: 20
```

**0 次失效**。所以"UIA 句柄会过期"不是靠睡眠触发的，是**渲染/切换视图**触发的。

真正的失效形态更隐蔽，实测抓到三种：

**(a) 元素在但子树是空的**

```
sidebar: True
  class=dframe-sidebar offscreen=False
  buttons: 0        <-- 0！
  children: 0
```

`Group[Sidebar]` 本身找得到，但里面一个子元素都没有。此时 `FindAll(Descendants)` 返回空，`FindFirst` 还能命中。**这正是"手动一次成功、脚本连续失败"的原因。**

这个瞬时态最初被我写成了硬失败（"侧边栏没有按钮 ⇒ 这不是侧边栏"），结果**健康的窗口被整个排除在候选之外**，报 `no Sidebar group in UIA subtree`。修正后：侧边栏存在即认，空列表交给重试。

**(b) 写入静默失败**

对最小化窗口 `SetValue`：

```
intended 288 chars, composer holds 1 chars
```

**没有抛异常**，`SetValue` 正常返回，但值没进去。

**(c) 应用不在会话视图**

后期观测到：树里有 **1537 个后代、470 个按钮，但 0 个会话行**（高 ≥40、宽 ≥300 的行一个都没有），而 `Group[Sidebar]` 和 `Edit[Prompt]` 都还在。

```
sidebar=True children=0
descendants=1537  buttons=470  tallRows=0
prompt present=True
```

这不是脚本故障，是**应用当时确实不显示会话列表**。脚本对此的处理是诚实的：`list-sessions` 重试 10 次后以 `exit 7` 报 `sidebar present but no rows materialized yet`，`get-status` 返回 `session_view: false`，而不是谎报 `count: 0`。**"0 个会话"和"看不到会话列表"是两件事，不能混。**

针对这三种，已实现：
- 选窗的结构确认带 3 次重试 / 150 ms 间隔（处理 a）
- 会话行枚举空结果 → 可重试错误，不返回 0（处理 a/c）
- 写入后**轮询读回**直到载荷出现，预算 2500 ms，并报告 `settle_ms`（处理 b）
- 引入 `-Retryable` 标记，把"瞬时但带退出码"和"重试无意义的逻辑错误"分开（否则 a/c 永远不会被重试）

**关于重试语义的一个真实 bug**：最初的 `Invoke-WithRetry` 把所有带 `ProbeExitCode` 的异常都当逻辑错误直接抛出。这使得"子树还没建好"这种明显瞬时的状态**一次都不重试**。加 `-Retryable` 后，实测从 1 次变成 10 次尝试（`attempts: 11`，耗时 7639 ms）。

### 2.8 写入是异步的（差点造成误判）

第一次实现用固定 `Start-Sleep 60ms` 然后读回：

```
trial1 exit=0 verdict=mismatch intended=8 actual=1
```

但**紧接着直接查询，输入框里就是 `R3TRIAL1`**（8 字符）。也就是说 60 ms 太短，读回时值还在路上。

这个 bug 的后果很严重：如果按 mismatch 去回滚，会把**一个已经成功的写入回滚成一个空输入框**。改成轮询后消失。

---

## 三、被否决的两个假设

### 假设 1：最小化窗口可以用 UIA 驱动
**部分成立，但危险。** 读操作在最小化窗口上完全正常（20 个会话、输入框、忙碌态全读得到，且不抢焦点）。但写操作会**先把窗口恢复并抢焦点**再说。所以"后台静默写入"这个想法不成立。

### 假设 2：UIA 句柄靠时间过期
**证伪。** 静置 45 秒 0 次失效。失效是**渲染事件**触发的，且表现为"元素还在、子树空了"而不是抛异常。这意味着**重试必须重新查询整棵树**，重试一个缓存句柄毫无意义——脚本的 `Invoke-WithRetry` 每个 attempt 都从 `FromHandle` 重来。

---

## 四、其他实测到的状态信号（对 relay 有用）

侧边栏**没有任何选中态**：20 个会话行只支持 `InvokePattern`，`IsSelected` / `ItemStatus` / `HasKeyboardFocus` 全为空。所以"当前是哪个会话"**不能**从侧边栏读。

可用的替代信号（已实现进 `get-status`）：

| 信号 | 在哪 | 实测值 |
|---|---|---|
| 当前会话名 | 主区一个按钮，名字是 `"<会话名>, rename session"` | `<session-title>` |
| 是否在生成 | 动作按钮变成 `Stop` + 出现文本 `Claude is responding` | `busy=true`，`Stop` @ 1097,963 |

第二条很重要：**忙碌时 Send 按钮不存在，存在的是 Stop**。往一个正在生成的会话里"发送"是另一种操作，语义完全不同。

---

## 五、能否安全用于自动发送

**当前不建议。** 五条阻断项，按严重度：

1. **抢焦点**（已实测）。`SetValue` 会把最小化窗口提到前台并夺走键盘焦点。用户正在别的应用打字时会被打断。
2. **静默失败**（已实测）。最小化状态下 `SetValue` 不报错但不生效；只靠"调用成功"判断会以为写进去了。
3. **异步**（已实测）。固定延时读回会误判，进而误回滚。
4. **UIA 调用会挂死**（已实测）。作业后期多次出现 PowerShell 进程超过 120 秒无返回、连 `echo` 都无法执行。一个守护进程如果卡在 UIA 上，会静默停止工作。必须加外部超时 + 看门狗。
5. **性能**（已实测）。冷启动 12–30 秒。必须长驻进程，而长驻进程又放大了第 4 条的风险。
6. **UI 状态会变，脚本必须拒绝而不是猜**（已实测）。观测到应用处于"侧边栏和输入框都在、但一个会话行都没有"的状态（470 个按钮、0 个会话行）。此时任何"尽力而为"的实现都会把指令送进一个不确定的上下文。当前实现选择报错退出。

**若仍要做，前置条件**（缺一不可）：

- 用长驻进程，不要每次起 CLI（20 秒 vs 195 毫秒）
- `SetValue` 后**必须轮询读回**，不能只信返回值，也不能固定 sleep
- 每次操作前**必须**确认目标会话 = 预期会话（`-Match` 闸门），不符就中止
- 必须在**用户空闲时**才写（`GetLastInputInfo`，现成 `idle.ps1` 可复用）
- UIA 调用外层加硬超时（例如 10 秒），超时即杀进程重启，不能让守护进程挂着
- 写入前后保存/恢复用户已有草稿（**本次实测中我误覆盖了用户草稿，已按字节精确还原；这个失败模式在真实使用中一定会遇到**）

**真正安全的发送路径**：不碰 UIA 写入。桌面版 Claude Code 的真实发送应该走它自己的输入通道（如果存在 IPC / CLI / URL scheme），UIA 只用于**读取状态**——读取这一半实测是干净的：零打扰、可重试、名字定位可靠。

---

## 六、脚本用法

```bash
# 只读，安全
powershell -File scripts/uia-probe.ps1 enum-windows -Json
powershell -File scripts/uia-probe.ps1 list-sessions -Json
powershell -File scripts/uia-probe.ps1 get-status -Json
powershell -File scripts/uia-probe.ps1 read-prompt -Json

# 写入（会抢焦点；带会话闸门 + 读回校验 + 失败回滚）
powershell -File scripts/uia-probe.ps1 write-prompt "text" -Match "<会话名>" -Json
powershell -File scripts/uia-probe.ps1 write-prompt -TextFile payload.txt -Match "<会话名>" -Json
powershell -File scripts/uia-probe.ps1 clear-prompt -Json

# 演练：写入 + 校验 + 报告会点哪个按钮，但不点
powershell -File scripts/uia-probe.ps1 dry-run-send -TextFile payload.txt -Match "<会话名>" -Json
```

**退出码**：`0` 成功 / `2` 找不到 / `3` 校验失败 / `4` 仅空白差异 / `5` 歧义中止 / `6` 窗口未确定 / `7` UIA 错误或子树未就绪 / `8` 用法错误。

**注意 `exit 7` 有两种含义**：UIA 真正报错，或者"侧边栏在但会话行还没建好"。两者都需要调用方**不要**据此认为"没有会话"。`get-status` 的 `session_view` 字段用来区分布尔意义上的"能看到列表吗"。

**中文载荷务必用 `-TextFile`**：PS 5.1 的 argv 按系统 ANSI（本机 GB2312）解码，命令行直接传中文会乱码。这是实测踩到的。

**脚本文件必须存为 UTF-8 with BOM + CRLF**：本机 PS 5.1 在无 BOM 时按 GB2312 解析，源码里的中文注释会导致解析器意外断行（实测报 `TerminatorExpectedAtEndOfString`）。

---

## 七、实测过程中的两次事故（如实记录）

1. **误覆盖用户草稿**。在未确认用户是否正在输入的情况下连续跑了 5 次 `write-prompt`，把用户输入框里一段 47 字符的草稿覆盖成了 `PROBE5`。已从日志中取出原文（含反斜杠路径），按字节精确还原并校验 `exact match: true`。**没有发送任何消息**——全程未调用过 Send 的 InvokePattern，事后全树搜索探测字符串 0 命中，"You said" 记录里也没有它。
2. **隐藏了侧边栏**。为测试失效恢复，调用了 `Hide sidebar`，之后没找到恢复按钮（后续确认侧边栏实际仍在）。已确认侧边栏 20 行完好。

这两条本身就是第五节第 1 条和前置条件的证据：**UIA 写入对用户环境的影响是真实且不可忽略的。**

---

## 八、未验证

- 真实点击 Send（任务明确禁止，未做）。**全文件内 `Send` 只出现在注释与字符串中，没有任何一处对 Send 元素调用 `GetCurrentPattern(...).Invoke()`。**
- 切换会话（`InvokePattern` 点侧边栏行）——会改变用户视图，未做
- 多显示器 / 不同 DPI 缩放下的坐标（坐标本就不用，但焦点行为可能不同）
- 高负载下 UIA 挂死的精确触发条件（只观测到现象，未定位根因）

## 九、仓库状态

- `node scripts/check-structure.mjs` → **exit 0**
- `node --test scripts/*.test.mjs` → **375/375 通过**（约 7.6 s）
- 本次只新增文件，未改动任何现有脚本，未执行 git 操作
- 注：`CLAUDE.md` 写的「192 条测试」与实测 375 条不一致，属既有文档漂移，本次未改
