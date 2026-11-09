# watcher「静默」故障诊断：一份 MSIX 影子目录冒充了现场

**日期**：2026-11-04（诊断执行于 2026-11-09 05:20–07:05 本地时间）
**角色**：诊断 Agent D4
**产出形态**：exploration（根因报告）
**结论**：**误诊。守护进程没有故障，它一直在正常写。被观察的那份数据是 MSIX 文件系统虚拟化留下的影子副本。**

---

## 一、结论先行

**PID `<pid-A>` 从未停止写日志。它一直在写，每秒约 1.1 KB，`watch.log` 已累计到 606 KB。**

主线程交来的现象描述里，最核心的三条「已确认事实」全部不成立：

| 交来的事实 | 实测 | 性质 |
|---|---|---|
| `state.json` 3406 字节全 NUL，mtime 停在 11-01 03:23 | 真实 `state.json` 是 **19803 字节、全文正常 JSON、每 15 秒更新** | 看到的是影子副本 |
| `watch.log` 停在 10-31 19:22，7.75 天零输出 | 真实 `watch.log` 是 **606,571 字节、4735+ 行 tick、最后一行为 23:01:37Z** | 看到的是影子副本 |
| `runner.log` / `observations.jsonl` 停在 11-01 | 真实文件是 153 KB / 12 KB，**mtime = 刚刚** | 看到的是影子副本 |
| `owner.json` 的 `lastSeenAt` 每 15 秒推进 | **这一条是对的** | — |

「进程活着、在烧 CPU、在更新 `owner.json`，却不写 `state.json`、不写 `watch.log`」——这个矛盾本身就是答案：**它不是矛盾，是观察工具看错了目录。**

### 根因

这台机器上存在**两个** `%LOCALAPPDATA%\Overwatch` 目录，它们对不同的进程呈现不同内容：

```
A（真实）  %LOCALAPPDATA%\Overwatch
           NTFS 目录 ID = 0x...126000000 27b1
           内容：state.json 19803 / watch.log 606571 / owner.json 149 / 全部新鲜

B（影子）  %LOCALAPPDATA%\Packages\
           AnthropicPBC.Claude_<pkg-hash>\LocalCache\Local\Overwatch
           内容：state.json 不存在 / state.json.corrupt-* 3406 全 NUL /
                 watch.log 41857（其中末 76 字节为 NUL）/ runner.log 39724
                 全部冻结在 2026-10-31 19:23
```

`AnthropicPBC.Claude_...` 是 Claude 桌面应用的 **MSIX 包**。MSIX 会为 AppContainer 进程启用文件系统虚拟化（`LocalCache\LocalRedirect` 机制），把对 `%LOCALAPPDATA%` 的写入重定向到包内私有路径。

**决定性实验**：同一个绝对路径字符串，两种方式启动的 `node.exe` 看到不同内容——

```
A) 由 Claude Code 的 bash 会话启动：
   LOCALAPPDATA = %LOCALAPPDATA%
   stat watch.log → 41857 字节, mtime 2026-10-31T19:23:13Z      ← 影子

B) 由 WMI Win32_Process::Create 启动（不经 Claude 会话）：
   LOCALAPPDATA = %LOCALAPPDATA%          ← 一模一样
   stat watch.log → 606090 字节, mtime 2026-11-08T23:00:36Z     ← 真实
```

环境变量完全相同，路径字符串完全相同，看到的内容不同。这是虚拟化重定向的唯一特征。

**所以：主线程（以及本 Agent 前半段的全部检查）都在包内视角下取证，拿到的是 10-31 那一刻被冻结的快照。**

---

## 二、为什么会有这份影子副本，它是什么时候产生的

影子目录里的内容不是伪造的，它是**真实数据在 2026-10-31 19:23:13 的冻结快照**。判据：

1. 影子 `watch.log` 的前 41781 字节与真实 `watch.log` 的**开头部分逐字节一致**（同为 `2026-10-31T17:26:19Z [INFO] watch 启动 dir=...`）——但真实文件此后继续增长，影子停止。
2. 影子 `watch.log` 的 `size = 41857`，`validDataLength = 41781`，**差恰好 76 字节**，而一条 tick 日志行（`2026-10-31T19:23:13Z [INFO] tick ...\n`）正好是 **76 字节**。
3. `state.json` 影子 3406 字节、`validDataLength = 0`；witness 影子 189 字节、全部 NUL。

**这是典型的 NTFS「已分配但未落盘」形态**：文件被扩展（EOF 前移、mtime 更新），但数据从未写入有效数据流，读出来就是 0。这不是 `saveState` 的 bug——`saveState` 用 `tmp + rename`，根本上产生不出「全 NUL 且 VDL=0」的目标文件。

这条线索指向**进程在 10-31 19:23:13 前后被强制终止**（强杀 / 电源事件 / 休眠恢复），NTFS 上留下扩展未落盘的文件。

历史日志证实那段时间确实有 `state-lost` 事故：

```
2026-10-31T17:26:19Z [ERROR] state-lost: 见证文件显示 434 次保存
  （最后 2026-10-31T17:25:49.200Z），但 state.json 和整个状态目录都不在了。
  历史已丢失，从空状态继续。
```

这与 `docs/research/2026-10-31-rollback-executed.md` 和 `DF-020` 记的是同一次事故。

### 影子是怎么产生的

MSIX 虚拟化会把「包内进程看到的初始状态」快照到 `LocalCache\Local`。此后：

- **守护进程**（由 VBS → `cmd /c` 启动，继承的是**用户登录会话**环境，不是 AppContainer）→ 写真实目录 A
- **Claude 桌面应用的 Agent 工具**（AppContainer / 有包身份的进程）→ 写影子目录 B

于是两条线各自演化，7 天里再没交汇过。

**更正一处早先的推断**：本文初稿写「Claude 应用在 11-01 01:26 首次启动，那一刻物化了影子」，**这是错的**。`launcher.log` 的首行 `2026/11/1 1:26:16 [vbs] launching` 是 **Overwatch 自己的 VBS 启动器**写的（`start-watch.vbs` 的 `Note "launching"`），不是 Claude 应用写的。它只能证明 watcher 在那一刻被拉起过，**不能**作为影子物化时刻的证据。物化时刻我没有独立证据，见 §七。

旁证（来自自启项与进程链，均已于诊断中核实）：

- 启动文件夹里存在 `Overwatch Watch.lnk`（创建于 2026/11/1 4:48:51）——自启已安装，这与「重启后 watcher 会自己回来」一致，也解释了真实日志里 5 次启动的分布。
- 进程链 `PID <pid-A> ← cmd <pid-B> ← PID <pid-C>`，而 **`<pid-C>` 已不存在**——符合 `wscript.exe` 拉起 `cmd` 后自己退出（`WShShell.Run(..., 0, False)` 非阻塞）的行为。这条链两端都不是 AppContainer，佐证守护进程走的是真实目录。
- 传统 `AppData\Local\VirtualStore` **不存在**（`Test-Path` 返回 False）。所以本次不是 UAC 文件虚拟化，而是 MSIX 的 `LocalCache\Local` 重定向——两者机制不同，别混为一谈。

---

## 三、三个候选根因的逐条判定

### 候选 A：`state.json` 被零填充 → `JSON.parse` 抛异常 → 提前 return，不写日志

**否定。** 三重证据：

1. **代码路径不允许**。`loadState`（`watch.mjs:336-377`）在 `JSON.parse` 失败时并不 return，而是把坏文件 `rename` 成 `state.json.corrupt-<ts>`，写一条 `logger.error`，然后**返回 `{ state: emptyState(), corrupt: true }` 继续跑完整个 tick**。`--once` 之后必然会写 `saveState` 与 `watch.log`。

2. **复现实测**：把真实的 3406 字节全 NUL 文件复制到隔离目录，用 `OVERWATCH_STATE_DIR` 指过去跑 `--once`：

   ```
   [ERROR] state.json 解析失败，已改名留证：...state.json.corrupt-2026-11-08T21-34-36-512Z
           （Unexpected token ' ', "        "... is not valid JSON）
   [INFO]  blocked-expired: 7710fbdb age=31.5d source=timeline
   [INFO]  tick jobs waiting probe jobs=11ms candidates=1 sent=1 ... 
   ```
   坏状态被改名、tick 正常完成、日志正常追加。**损坏的 state 不会让进程静默。**

3. **反证**：如果进程真的走到了 `loadState` 的失败分支，它一定会在目录里留下 `state.json.corrupt-*`。真实目录里**唯一的** `corrupt-*` 文件是 `2026-11-08T22-13-07-930Z`，而该文件的时间戳落在本次诊断时段内（我 22:13 做了损坏复现实验）。它在影子目录里同样存在——说明这个 rename 是**影子侧某次启动**做的。

### 候选 B：写文件时进程被杀/断电，NTFS 留下零填充

**部分成立，但只解释「影子为什么坏」，不解释「为什么不写日志」。**

- NUL 填充 + `validDataLength=0` + size 停在 76 字节边界，确实是「扩展了但没落盘」的形态，来源是 10-31 约 19:23 的一次异常终止。Event Log 只能回溯到 11-05（System 日志最旧一条为 `11/05/2026 01:20:44`），10-31 的断电/强杀证据已不可考，因此只能凭 NTFS 形态判定，不能凭事件日志判定。
- 但候选 B 无法解释 `owner.json` 每 15 秒推进——那是**同一次 `runTick` 里、`loadState` 之前**的 `claimOwnership`（`watch.mjs:1760`）。如果进程卡在写文件上，`owner.json` 也写不动。两者能一活一死，只能是**它们在不同的目录**。

### 候选 C：某个 probe 卡在无限循环 / 超长等待，CPU 在烧

**否定。** 实测：

- CPU 占用 **7.58%**（637 s / 8411 s 生命周期）。对一个每 15 秒醒一次、每轮只做两次 `readdir` + `stat` 的进程，7.5% 偏高但完全不是死循环的量级（死循环会顶满一个核，即 100%/核数）。
- 9 个线程全部处于 `Wait` 状态，最大 CPU 的一条是 `EventPairLow`（542 s）——那是 libuv 事件循环线程在等 I/O，不是忙等。
- **最硬的证据**：真实 `watch.log` 里有 **4700 行 `[INFO] tick`**，每 15 秒一条，最后一条是 `2026-11-08T22:57:01Z`。卡住的话不可能持续产出 tick。
- 无 `tick-failed`、无 `[ERROR]`、无 `[WARN]`（整份 606 KB 日志里 0 条）。

候选 C 之所以看起来像，是因为「日志不增长」这个观察本身错了。

---

## 四、真实运行状况（顺带修正几项其他认知）

从真实的 `watch.log`（606 KB / 4735 行）读出来的实况：

```
启动次数：5 次
  2026-10-31T19:28:43Z
  2026-11-05T09:50:24Z
  2026-11-08T15:54:54Z
  2026-11-08T18:54:51Z
  2026-11-08T19:13:01Z   ← 当前 PID `<pid-A>`（本地 11-09 03:13:01）

tick 分布（按天）：10-31:349  11-01:613  11-02:2781  11-05:123  11-08:869
ERROR/WARN 行：0
日志归档：无（watch.*.log 不存在 → 未轮转，也未丢过日志）

运行断档（>2 小时）：
  25.0h  gap  → 2026-11-01T21 之前
  69.0h  gap  → 2026-11-05T09 之前
  77.0h  gap  → 2026-11-08T15 之前
```

**这三次断档与「7.75 天零输出」是同一件事的两面**：机器在关机/休眠，守护进程不在跑。真实日志证明它每次起来都正常写。

当前 `state.json`（19803 字节）健康：

```
lastJobsScanAt  = 2026-11-08T23:01:37Z   （每 15 秒推进）
lastProbeAt     = 2026-11-08T22:53:27Z   （每 5 分钟推进）
lastAskedScanAt = 2026-11-08T22:53:27Z
notified 条目   = 30
budget.sentLog  = 7 条
```

`node scripts/watch.mjs --health` 同样报告「运行中，所有层都在周期内」。**注意：`--health` 也会被虚拟化重定向**——在 Claude 会话里跑它，读的是影子目录；上面的数字来自非虚拟化进程。

`watch.log` 与 `runner.log` 尾部逐行相同：VBS 启动器把 `stdout/stderr` 重定向到 `runner.log`，而 `createLogger(..., { mirror })` 把同一行同时写进 `watch.log`。两份文件是同一内容的双写，不是两个数据源。**这是判读时容易误判的地方：runner.log 不是独立证据。**

---

## 五、判别实验（每个 5 分钟内可跑）

### 实验 1：`\\?\` 长路径前缀绕过虚拟化（最快，2 分钟）

**原理**：MSIX / AppContainer 的重定向只作用于 Win32 常规路径解析。`\\?\` 前缀走 `NtCreateFile` 的原始路径，绕过重定向层。

```powershell
# 在 Claude 会话的 shell 里跑，对比两行输出
$A = '\\?\%LOCALAPPDATA%\Overwatch'
$B = '\\?\%LOCALAPPDATA%\Packages\<AnthropicPBC.Claude_*>\.Local\Overwatch'
Get-ChildItem -LiteralPath $A -Force | Select-Object Name,Length,LastWriteTime
Get-ChildItem -LiteralPath $B -Force | Select-Object Name,Length,LastWriteTime
```
**判据**：若两者条目数/大小不同 → 虚拟化重定向已确认。

### 实验 2：WMI 起一个非虚拟化进程（最干净，3 分钟）

```powershell
$out = '<repo>\.tmp-analysis\probe.txt'
$code = 'const fs=require("fs");const d="<user-home>\\AppData\\Local\\Overwatch";const L=["LOCALAPPDATA="+process.env.LOCALAPPDATA];for(const n of fs.readdirSync(d)){const s=fs.statSync(d+"\\"+n);L.push(n+" "+s.size+" "+new Date(s.mtimeMs).toISOString())}fs.writeFileSync("<repo>\\.tmp-analysis\\probe.txt",L.join("\n"))'
Set-Content -Path '<repo>\.tmp-analysis\probe.cjs' -Value $code -Encoding UTF8
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = '"node.exe" "<repo>\.tmp-analysis\probe.cjs"'
}
Start-Sleep 5; Get-Content $out
```
**判据**：WMI 启动的进程看到的 `watch.log` 大小会显著大于 41857。本次实测为 **606090 字节**，而同一路径在会话内是 **41857 字节**。

### 实验 3：按 NTFS 文件 ID 反查真实路径（不需要绕虚拟化，但需要 ID）

```powershell
# fsutil 的 usn readdata 给出 Parent FileRef#，queryfilenamebyid 把它解成规范路径
fsutil usn readdata '%LOCALAPPDATA%\Overwatch\watch.log'
# 记下 Parent FileRef#，例如 0x...<file-id-A>
fsutil file queryfilenamebyid C: 0x...<file-id-A>
# → \\?\%LOCALAPPDATA%\Overwatch
```
同样对影子目录里的 `watch.log` 做一次，得到的父路径会是
`\\?\C:\...\Packages\AnthropicPBC.Claude_...\LocalCache\Local\Overwatch`。

**判据**：两条不同的父路径 = 两个不同目录，即使它们的名字都叫 `Overwatch`。

### 实验 4（负向验证，确认候选 A 已死）

```powershell
$t = '<repo>\.tmp-analysis\t1'
Remove-Item $t -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $t | Out-Null
[IO.File]::WriteAllBytes("$t\state.json", (New-Object byte[] 3406))
$env:OVERWATCH_STATE_DIR = $t
node <repo>\scripts\watch.mjs --once
Get-ChildItem $t
```
**判据**：必须出现 `state.json.corrupt-<ts>`，`watch.log` 必须被创建/追加。本次实测已通过——损坏的 state 不会导致静默。

---

## 六、这次误诊暴露的真实问题（这部分是有效产出）

### P0-1：诊断工具与被诊断进程不在同一个文件系统视图

这是本次事故的元凶，也是**所有后续判断的污染源**。

- Claude 会话里的 Bash / PowerShell / Node 都带 AppContainer 包身份，`%LOCALAPPDATA%` 被重定向到 `Packages\AnthropicPBC.*\LocalCache\Local`。
- 守护进程由 VBS → `cmd /c` 启动，无包身份，写真实 `%LOCALAPPDATA%`。
- 两者路径**字符串完全相同**，`--health`、`--stats`、`--inbox`、`--trace` 从会话里跑全部读影子。

**后果**：`--health` 会对着 10-31 的冻结快照报「运行中」或「已停」，两个答案都不可信。这正是 `DF-023`（「看起来在跑，实际没在跑」）的镜像版本——**看起来没在跑，实际一直在跑**。

**建议**：`watch.mjs` 增加一个显式的视图自检。最省的做法是在 `watch.log` 的 `watch 启动` 行里带上进程的真实文件 ID（`fsutil file queryfileid` 等价物），并在 `--health` 里比对：当前读到的 `state.json` 的文件 ID 与最后一次启动行里记录的是否一致；不一致就明说「读到的不是守护进程在写的那份」。

### P0-2：两个数据目录共用同一个名义路径，`owner.json` 的归属检查失效

`claimOwnership`（`watch.mjs:210-230`）设计目的是发现「两个仓库共用一个状态目录」。它靠比较 `repo` 路径，而这次冲突的**双方是同一个仓库、同一个路径、不同的物理目录**——归属检查天然看不见。

本次实测：真实 `owner.json` 与影子 `owner.json`（现已不存在，被改名时的清理带走）内容都是 `{"repo":"<repo-root>"}`。**检查通过，但数据在撕裂。**

### P1：`.witness.json` 的定位在影子目录下会指向错误位置

`witnessPath()` 用「兄弟文件」`<dir>.witness.json`。在虚拟化下：
- 真实：`%LOCALAPPDATA%\Overwatch.witness.json`（191 字节，`saves: 10072`，每 tick 更新）
- 影子：`<shadow>\Overwatch.witness.json`（189 字节，全 NUL，冻结在 10-31）

两者都存在，名字相同。`checkStateIntegrity` 只读自己那一侧，所以**两边都不会报 `lost`**。丢失告警在这个场景下彻底失效。

### P1：`watch.log` 的 VDL 缺口说明「追加」也会留下 NUL

影子 `watch.log` 的 `size - validDataLength = 76`，恰好一条 tick 行的长度。这说明 NTFS 在文件被扩展（`append` 预分配）后、数据落盘前进程死亡，会留下「size 包含、内容为 0」的尾部。

`createLogger` 用 `appendFileSync`，本身不写 NUL；但如果曾用 `ftruncate` / `setEndOfFile` 预分配，或文件系统在扩展时被中断，就会留下这种尾巴。**建议**：日志轮转/追加后做一次 `validDataLength` 校验成本太高，不值得；但诊断脚本读日志时应把尾部全 NUL 视为「该行未落盘」，而不是当作内容。

### P2：诊断期间我误建了文件，已清理

我在验证「两个路径是否同一目录」时向 `%LOCALAPPDATA%\Overwatch\` 写了 `D4-MARKER.txt` 和 `d4-escape.txt`，随后确认这两个写入同时出现在真实与影子两侧（这本身也印证了虚拟化），并已用非虚拟化进程删除。真实目录现在不含任何我创建的文件。**教训**：在虚拟化环境下做「写入了吗」这类实验，写操作本身也会被重定向，必须用非虚拟化通道验证。

---

## 七、现在就能确定 vs 仍需确认

### 已确定（有直接观测支撑）

1. **守护进程从未故障**。真实 `watch.log` 606 KB、4735 行 tick、0 条 ERROR/WARN，最后一条 `2026-11-08T23:01:37Z`。`lastJobsScanAt` 每 15 秒推进。
2. **存在两个物理目录共用同一名义路径**。文件 ID 反查与 `\\?\` 前缀遍历双重确认。
3. **会话侧看到的是 10-31 19:23 的冻结快照**。影子 `watch.log` 前 41781 字节与真实文件开头逐字节相同。
4. **候选 A 已被负向测试否定**。损坏 state 会触发 rename + 继续跑，不会静默。
5. **候选 C 已被否定**。4700 行 tick 与 7.58% CPU 不能共存于「卡住」假设。
6. **NUL 填充是 NTFS 扩展未落盘，不是代码 bug**。`saveState` 的 tmp+rename 产生不出 VDL=0 的目标文件。

### 仍需确认（我给不出证据，不装作有）

1. **10-31 19:23 那次异常终止的确切原因**。System 日志最旧只到 11-05 01:20，10-31 的断电/强杀记录已被滚掉。NUL/VDL 形态能证明「扩展后未落盘」，不能证明是断电、强杀还是休眠。
2. **影子快照被物化的确切时刻**。影子目录的 mtime 是 10-31 19:23，但那只是继承自被复制源文件的元数据，不是物化动作的时间。`launcher.log` 的 11-01 01:26:16 是 Overwatch 自己的 VBS 启动器写的，与 Claude 应用无关，**不能**用作证据（见 §二 更正）。我没有能定这一刻的独立证据。
3. **「7.75 天零输出」是否也只是观察偏差**。真实日志显示最后写入是刚发生的；主线程看到的「最后一条 10-31 19:22:58Z」纯粹是影子文件内容。但这台机器确实有 25h / 69h / 77h 三次断档，**在那些窗口里守护进程是真的没跑**——只是不是主线程所指的那 7.75 天。
4. **`596 KB` 的 `watch.log` 为什么没触发 1 MiB 轮转**。当前 606 KB，尚未到上限。因此日志轮转逻辑还没被真实触发过，`rotateIfNeeded` 的归档分支仍属未验证路径。

### 对 P0 故障定级的影响

**这不是 P0 生产故障。** 监控系统工作正常；出故障的是**观测通道**。建议把这条单独记一条 finding：诊断工具必须能声明「我看的是哪个物理目录」，否则所有 `--health` / `--stats` / `--trace` 的输出都不可作为判据。

---

## 八、附：本次用到的取证脚本

全部临时脚本在 `.tmp-analysis/`（已 gitignore），关键几个：

| 脚本 | 作用 |
|---|---|
| `d4-nonvirt.cjs` / `d4-env.cjs` | 由 WMI 启动的非虚拟化进程，对比两侧目录与 `LOCALAPPDATA` |
| `d4-final.cjs` | 非虚拟化视角下的 VDL、tick 分布、断档统计 |
| `d4-usnfilt.mjs` / `d4-usn5.mjs` | 解析 `fsutil usn readjournal` 的 CSV，按父目录 ref 归类 |
| `d4-hash.mjs` | 五文件哈希 + mtime + size 时序采样 |
| `d4-append.mjs` | 验证「append 到 VDL<size 的文件」不会抛错 |

**未做的事**：没有停止或重启 PID `<pid-A>`，没有修改任何真实状态文件，没有碰 git。
