# 让观察器随登录启动（Windows）

> P0 阶段：只观察、只通知，不执行任何代决策。本文只讲怎么让它跑起来。

## 结论先说

**这台机器上任务计划不可用**，用**启动文件夹 + VBS** 代替。两者效果相同：
登录后自动起、不弹窗、不需要管理员。实测任务计划下连 `cmd /c echo` 都返回 `0x1`，
而同一个 VBS 手动运行完全正常。

## 为什么不直接 `node scripts/watch.mjs`

因为 `powershell.exe` / `cmd.exe` 是控制台程序，`-WindowStyle Hidden` 隐藏不了它们：
conhost 窗口由外层创建，在出现之前无法隐藏。

实测（用 WinEvent 钩子，`EVENT_OBJECT_SHOW`，不是轮询）：

| 启动方式 | 窗口事件数 | 是否抢焦点 |
|---|---|---|
| `wscript.exe` + `Run(..., 0, ...)` | **0** | 否 |
| `powershell.exe -WindowStyle Hidden` | 2 | **是**（含一条 `FOREGROUND`） |

抢焦点那条足以让人第一周就关掉整个功能。

## 安装（一条命令）

```bash
node scripts/install-watcher.mjs install
```

它会做两件事：把启动器渲染到 **仓库里**，然后建一个指向它的开机自启快捷方式。

```bash
node scripts/install-watcher.mjs status     # 看状态
node scripts/install-watcher.mjs uninstall  # 移除开机自启（启动器文件留在仓库）
```

### 为什么启动器必须放在仓库里（DF-022）

旧版本的安装说明让人把 `start-watch.vbs` 写到 `%LOCALAPPDATA%\Overwatch\` ——
**那正是它要保护的数据目录**。

2026-10-31 实测：把数据目录整个删掉（为了验证丢失检测），启动器跟着没了，
**监控系统就此起不来**。数据可以重新积累，起不来则永远没有积累的机会。

现在三个文件各有各的位置，互不牵连：

| 文件 | 位置 | 删掉会怎样 |
|---|---|---|
| 启动器 | `<repo>/scripts/install/start-watch.vbs`（由模板生成） | 重跑 `install` 即可 |
| 开机自启 | `<Startup>/Overwatch Watch.lnk` → 启动器 | 同上 |
| 数据 | `%LOCALAPPDATA%\Overwatch\` | **告警 + 从空状态继续**，监控不中断 |

删掉数据目录之后，重启是这样的：

```
[INFO] watch 启动 dir=...\Overwatch tick=15000ms
[ERROR] state-lost: 见证文件显示 434 次保存（...），但 state.json 和整个状态目录都不在了。
[WARN] state-lost: 日志与 observations.jsonl 很可能同时在同一次删除中丢失。
```

**这两行是这次改动的全部意义**：系统能自己站起来，并且告诉你它丢过东西。

### 模板须为纯 ASCII

VBScript 按 ANSI 读 `.vbs`，UTF-8 中文会变成乱码并提前截断字符串字面量。
踩过的坑：报错是「未结束的字符串常量」，但**指向的行号是错的**。
`install-watcher.test.mjs` 里有一条测试专门守这个约束。

## 验证

```bash
# 进程在跑？
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*watch.mjs*' } | Select-Object ProcessId"

# 有没有可见窗口（应当为空）
powershell -NoProfile -Command "Get-Process node | Where-Object { \$_.MainWindowHandle -ne 0 }"

# 日志
tail -5 "%LOCALAPPDATA%\Overwatch\runner.log"
```

正常输出长这样（本机 2026-10-31 实跑，`%LOCALAPPDATA%\Overwatch\watch.log`）：

```
[INFO] watch 启动 dir=%LOCALAPPDATA%\Overwatch tick=15000ms
[INFO] tick jobs jobs=10ms candidates=0 sent=0 suppressed=0 already=0
[INFO] tick candidates=0 sent=0 suppressed=0 already=0
[INFO] tick candidates=0 sent=0 suppressed=0 already=0
```

绝大多数 tick 是 `candidates=0`——**这是正常的**，说明没有宿主报 `failed` / `blocked`。

真正发通知时的样子：

```
[INFO] notified FAILED D--Projects-rea-Project-work-shapez key=6da2fa52… session=5ead31fa-…
```

> ⚠ 本文件此前在这里展示过 `suppressed FAILED kind=WAITING_SUBAGENT`，并称「子 Agent 完成通知的停止占真实停止的约 68%」。
> **那一行从未出现过**：5,373 条日志里 `suppressed <大写状态> kind=…` 计数为 0。当时的实际日志里根本没有 `kind=` 字段（分类器尚未接入通知路径）。
> 上文已替换为真实日志。真实的通知样本只有 5 条，全部是 `FAILED`。

## 看分类分布

P0 期的核心产物是 `%LOCALAPPDATA%\Overwatch\observations.jsonl`：每条判定一行，
**包括被抑制的**。它是 P1 的数据来源，不要随手删。

```bash
node scripts/watch.mjs --stats
```

输出（**当前真实状态**，2026-10-31 实跑）：

```
观察样本：0 条（还没有 observations.jsonl）
```

这不是故障。`observations.jsonl` **只在有候选产生时才写入**，而回滚后（删掉心跳推断、
`NOTIFY_STATES` 只剩宿主事实）13 小时内候选数为 0——没有会话被宿主报 `failed` 或 `blocked`。

一旦有候选，`--stats` 才开始有内容，格式是：

```
观察样本：N 条（起始日 ~ 结束日）
分类分布：
  <KIND>                   <n>  <pct>%
通知：发了 X 条，抑制 Y 条
按 state 交叉：
  <STATE> → <KIND> <n> / ...
```

> ⚠ 本文件此前贴过一段「观察样本：6 条 / ASKED_UNANSWERED 16.7% / WAITING_SUBAGENT 16.7%」的输出，
> **那是编的**：当时 `observations.jsonl` 根本不存在，`formatStats` 的样本为 0。
> 现在这里只写实际输出，并明确标注 0 条是预期结果。

`why` 告诉你看这一行为什么没发：`kind-not-notifiable`（分类门）、`budget-*`（限额）、
`already-notified`（同一边沿已处理）、`dry-run`、`classify-error`（判不了，退回按 state 判断）、
`unclassifiable-too-recent`（刚停下，等 5 分钟时间门槛）。

## 三层轮询的代价

| 层 | 频率 | 实测耗时 |
|---|---|---|
| jobs 目录 | 15 秒 | 9–19 ms |
| mtime 探针 | 5 分钟 | 40–137 ms |
| 全量扫描 | 30 分钟 | 21 秒 |

常驻进程的 CPU 累计：跑 90 秒用掉约 1 秒，即约 1%。笔记本上可以接受，
但如果觉得费电，把 `tickMs` 调大或只保留 jobs 层。

## 卸载

删掉启动文件夹里的 `Overwatch Watch.lnk`，再 kill 掉进程：

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*watch.mjs*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
```

状态和日志在 `%LOCALAPPDATA%\Overwatch\`，不在仓库里，删不删都行。

## 已知限制

1. **任务计划在这台机器上不可用**（`0x1`，连 `cmd /c echo` 都失败）。启动文件夹是已验证的替代。

   排查过的方向全部无效：

   | 尝试 | 结果 |
   |---|---|
   | PowerShell `Register-ScheduledTask`，`RunLevel Limited` + `InteractiveToken` | `0x1` |
   | 同上，去掉显式 principal | `0x1` |
   | `schtasks /Create /RL HIGHEST` | 报告成功，无输出文件 |
   | `schtasks /Create /RU SYSTEM` | 报告成功，无输出文件 |
   | 最小 VBS（只写一行日志） | 不执行 |
   | 最小 `cmd /c echo hello > file` | 不执行 |

   `schtasks /Query /V` 会直接挂住（超时后无输出），说明任务计划服务本身响应异常。
   Operational 日志默认关闭，开启它需要额外配置，我没有继续深挖。

   **如果你在新机器上装，先跑一条最小任务验证计划任务可用**，可用则优先用它
   （支持崩溃重启、`StartWhenAvailable` 补跑），不可用再退回本文的启动文件夹方案。
2. **只在登录后启动**。机器重启但没人登录时不会跑。
3. **没有守护**。进程崩了不会自动重启；`watch.mjs` 自己捕获异常，但 OOM 之类救不了。
4. 通知走 WinRT Toast，被「专注助手」静音时用户看不到。P0 阶段这没关系（只观察），
   **到 P1 自动投递时必须处理**——通知送不到就不该动作。
