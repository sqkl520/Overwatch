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

## 安装（三步）

> 下文的 `%REPO%` 换成你的仓库路径，`%LOCALAPPDATA%` 保持原样（Windows 会自己展开）。

### 1. 写启动脚本

`%LOCALAPPDATA%\Overwatch\start-watch.vbs`：

```vbscript
Option Explicit
Dim sh, fso, repo, logDir, runnerLog, cmd
On Error Resume Next
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
logDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Overwatch"
runnerLog = logDir & "\runner.log"

repo = "%REPO%"
If Not fso.FolderExists(repo) Then WScript.Quit 3

cmd = "cmd /c cd /d """ & repo & """ && node scripts\watch.mjs >> """ & runnerLog & """ 2>&1"
sh.Run cmd, 0, False
WScript.Quit 0
```

> **必须纯 ASCII。** VBScript 按 ANSI 读 `.vbs`，UTF-8 中文会变成乱码并
> 提前截断字符串字面量。我踩过这个坑，报错是「未结束的字符串常量」但指向的行号是错的。

### 2. 放一个快捷方式

放到 `shell:startup`（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`）：

- 目标：`C:\Windows\System32\wscript.exe`
- 参数：`"<上面那个 vbs 的完整路径>"`
- 起始位置：仓库根目录

一行命令：

```powershell
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'Overwatch Watch.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = 'C:\Windows\System32\wscript.exe'
$s.Arguments = '"%LOCALAPPDATA%\Overwatch\start-watch.vbs"'
$s.WorkingDirectory = '%REPO%'
$s.Save()
```

### 3. 立刻起一次（不必重启）

直接运行那个 `.lnk` 即可，等价于下次登录时的行为。

## 验证

```bash
# 进程在跑？
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*watch.mjs*' } | Select-Object ProcessId"

# 有没有可见窗口（应当为空）
powershell -NoProfile -Command "Get-Process node | Where-Object { \$_.MainWindowHandle -ne 0 }"

# 日志
tail -5 "%LOCALAPPDATA%\Overwatch\runner.log"
```

正常输出长这样：

```
[INFO] watch 启动 dir=%LOCALAPPDATA%Overwatch tick=15000ms
[INFO] tick jobs jobs=9ms candidates=0 sent=0 suppressed=0 already=0
[INFO] notified FAILED D--Projects-rea key=6da2fa52dccf2c60 session=5ead31fa
```

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

1. **任务计划在这台机器上不可用**（`0x1`，连 `cmd /c echo` 都失败）。原因未查清——
   任务计划的操作日志默认关闭，开启需要额外配置。启动文件夹是已验证的替代。
2. **只在登录后启动**。机器重启但没人登录时不会跑。
3. **没有守护**。进程崩了不会自动重启；`watch.mjs` 自己捕获异常，但 OOM 之类救不了。
4. 通知走 WinRT Toast，被「专注助手」静音时用户看不到。P0 阶段这没关系（只观察），
   **到 P1 自动投递时必须处理**——通知送不到就不该动作。
