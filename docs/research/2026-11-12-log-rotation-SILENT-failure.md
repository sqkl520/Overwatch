# 日志轮转「静默」故障：先证伪，再修真实缺陷

- 日期：2026-11-12
- 角色：修复 Agent F13
- 产出形态：artifact（`scripts/watch.mjs` + `scripts/watch.test.mjs` + 本章）
- 边界：**未重启生产守护进程**（PID 25456）；未碰 `scripts/oversight-tui.mjs`；未碰 git。
  ⚠ 该进程在本轮工作中**已经自行停止**，原因查不出，见 §八。
- 取数时刻：2026-11-12T11:50Z–12:45Z（§八 的复核到 15:40Z）
- 收工状态：`node --test scripts/*.test.mjs` → **881 / 881**；`check-structure.mjs` → 通过

---

## 零、一句话结论

**任务描述里的「日志静默 4 小时」复现不出来——因为它不是真的。** 我读到的那三个文件
来自 MSIX 包虚拟化后的影子目录；真实数据目录里的 `watch.log` 289 KB、正在实时写入，
与 stdout 镜像 `runner.log` **逐行完全一致（2383 行 / 0 条缺失）**。

但排查过程暴露了一个**真的、可复现的**缺陷，而且比原假设更严重：
`--health` 只检查调度心跳（`state.json`），**结构上无法发现日志系统自己的故障**。
一个把自己失败吞掉的 logger，会让「守护进程在跑」和「它什么都没记」变成同一个画面。
本轮修的是这个。四条负向验证已确认：把修复逐条回退，对应测试当场变红。

---

## 一、任务前提的第一条断言先被证伪

### 1.1 我看到的「证据」是影子目录

任务给的三行证据，我的会话读出来确实如此：

| 文件 | 我的会话读到 | 真实数据目录 |
|---|---|---|
| `watch.2026-11-11T17-52-33-329Z.log` | 1,048,517 B，末行 17:51:21Z | 同（这份是真的） |
| `watch.2026-11-12T06-58-03-383Z.log` | 1,048,522 B，末行 06:55:55Z | 同（这份是真的） |
| `watch.log` | **41,857 B，末行 2026-10-31T19:22:58Z** | **289,957 B，末行 12:02:01Z（当前）** |

`watch.log` 那一行是假的。核对方法（按 MEMORY 里 `msix-localappdata-shadow` 的规则）：
用 WMI 起一个**不在包沙箱内**的进程去看同一路径。

```powershell
# 用 WMI 起一个不在包沙箱内的进程；把输出写到包外路径再读
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = 'cmd.exe /c dir %LOCALAPPDATA%\Overwatch > <repo外路径>\out.txt 2>&1'
}
```

非虚拟化进程看到的目录是 **8 项**，我的会话看到的是 **11 项**——多出来的 3 项
（`watch.log` 以外的 `state.json`、`owner.json`、`observed` 系）是包沙箱按已知文件名
拼出来的旧快照。41,857 字节那份 `watch.log` 与
`...\Packages\AnthropicPBC.Claude_*\LocalCache\Local\Overwatch\watch.log`
**同 size、同 mtime、同内容**（含末尾 76 个 NUL 字节），是 10-31 那份的物理副本。

### 1.2 真实日志没有断，而且轮转一直在工作

```
watch.log 真实大小 289,957 B，首行 06:58:03Z（= 上一次轮转切点），末行当前
与 runner.log（stdout 镜像）比对：2383 行 vs 2383 行，0 条缺失，0 条多余
error/warn 行：0
```

那两份 1,048,5xx 的文件正是**轮转的产物**：06:58:03Z 那次轮转把 1,048,522 的
`watch.log` 改名成带时间戳的归档，然后新 `watch.log` 从第一行开始长。到 12:02 时它
已经长到 289 KB。**「轮转后新日志从未被正确写入」这个判断，是被影子目录骗出来的。**

这也解释了两份归档为什么只差 54-59 字节就顶着上限：`rotateIfNeeded` 的判据是
`size + incoming > maxBytes`，所以最后一次写入必然落在离上限不到一行的地方，差几十字节是
**设计如此**，不是卡死的痕迹。

### 1.3 一条值得记下的教训

排查这类「日志停了但进程活着」的问题，**第一个动作应该是用进程外视角确认文件本身**，
而不是在会话内 `ls`。本轮如果直接按任务前提改代码，会得到一份「修了一个不存在的问题」
的提交，并且顺手把真正该修的可见性缺陷留在原地。

### 1.4 这是第二次

`2026-11-04-watcher-silent-failure.md` 记的是**同一类故障**：那天交来的三条「已确认事实」
（`state.json` 全 NUL、`watch.log` 停在 10-31、`runner.log` 停在 11-01）也全是影子副本，
真实进程一直在正常写。那份报告当时就把根因写清了——MSIX 给 AppContainer 进程做的
文件系统重定向，**同一个路径字符串，包内进程看到的是冻结快照**。

今天这次是同一个坑的第二遍，只是换了三个受害文件（这次是 `watch.log` 被冻结在 41,857 B）。
索引页把它排在「最该读的」第 1 位，仍然没能阻止重演。所以除了修代码，本文额外做了一件事：
**把「先证伪再动手」写成流程**——凡是交来的证据里有 `%LOCALAPPDATA%` 下的文件读数，
先用 WMI 起一个进程外进程复核，再决定改不改代码。

一份报告被读过、被排到第 1 位、还是没能阻止重演，说明需要的是**检查点**而不是**结论**。
本轮没有再往文档里加一句「注意影子目录」——加第十句也是一样。

---

## 二、真正的问题：日志失败不可见

### 2.1 原始实现的三处静默（`scripts/watch.mjs` 的 `createLogger`，改前 265-320 行）

```js
try { size = statSync(file).size; } catch { return; }       // ① 一律跳过轮转
...
try { renameSync(file, archived); } catch {
  try { rmSync(rotated, { force: true }); } catch { /* ignore */ }
  try { renameSync(file, rotated); } catch { /* ignore */ }  // ③ 双重失败完全静默
}
...
catch (e) { if (mirror) mirror(...); return; }               // ④ 写失败只进 stdout
```

四处问题，按后果排序：

| # | 位置 | 后果 |
|---|---|---|
| ④ | `appendFileSync` 失败 | 行直接丢弃。没有 stderr、没有应急文件、state 里没有痕迹 |
| ③ | 两次 `rename` 都失败 | **轮转永久失效**：之后每行都走 append，文件无限增长，无人知晓 |
| ① | `statSync` 非 ENOENT 失败 | 不轮转、不报错。目录权限一变就静默退化 |
| ② | `--health` 只看 `state.json` | **日志坏不坏与它无关**——两条写入路径，一条活不能证明另一条活 |

第 ② 条是任务里点出的设计缺陷，我确认它成立：`healthCheck(state)` 的签名里根本没有
日志这个维度。

### 2.2 复现（先写测试，后改代码）

Windows 上让 `renameSync` 真失败需要另一个进程持有句柄，NTFS 的 `chmod` 不生效，
杀软会改变行为——**做不到稳定复现的负向测试等于没有**。所以给 `createLogger` 加了
一个 IO 接缝 `deps`（默认全是真实现），测试注入整组必抛错的函数。

七个用例（`DFS-01`…`DFS-07`）在**原始实现**上是这样失败的：

| 用例 | 原始实现的失败形态 |
|---|---|
| DFS-01 rename 失败后日志必须继续写 | 行写进去了，但降级事实只字未留；`stderr` 空 |
| DFS-02 rename+截断都失败 → 继续追写 | 无任何降级记录 |
| DFS-03 正常轮转 | 通过（原本就正常，留作回归） |
| DFS-04 stat 失败（EACCES）必须可见 | 静默返回，`stderr` 空 |
| DFS-05 主文件写失败 → 应急文件 | 行丢弃，只 mirrors 到 stdout |
| DFS-06 `healthCheck` 读日志健康 | 签名里没有这个参数，无从读起 |
| DFS-07 `readLogHealth` 无文件返回 null | 函数不存在 |

---

## 三、修法

### 3.1 失败三层可见

每一条故障都同时走三条路，**任何一条单独成立都不算修好**：

1. **写进日志本身**——降级的第一行强制带 `[WARN] log-health: <kind>（见 log-health.json）`。
   事后复盘看的是日志文件，不是 stderr。
2. **写 stderr**（进程外可见；被 VBS 拉起时进 `runner.log`）与 `mirror`（stdout）。
   格式 `[log-fault] <kind>: <detail>`。同一故障按签名去重（否则每行喊一遍把 runner.log 冲掉），
   但**换一种故障必须重新喊**。
3. **写 `log-health.json`**（数据目录下的旁挂文件，不是 `state.json` 的字段）。
   `--health` 读它。

为什么是旁挂文件而不是 `state.json` 字段：`createLogger` 在 `runTick` 的默认参数里就构造好了，
早于 `loadState`；而 `saveState` 是每轮最后一次写。放同一个文件里会互相覆盖。

```json
{ "healthy": false, "kind": "rotate-failed-truncated", "streak": 3,
  "detail": "rename→... 失败（EPERM ...），已截断原文件", "at": "...", "maxBytes": 1048576 }
```

### 3.2 轮转失败不停止写（三级降级）

```
1. rename → watch.<时间戳>.log            （正常路径）
2. 失败 → **先复制**到 watch.<时间戳>.copy.log，再截断原文件
3. 都失败 → 继续追加（超限）              （日志无限增长 > 日志静默停止）
```

第 2 级为什么必须**先复制再截断**：单纯 `writeFileSync(file, '')` 会永久丢掉旧日志的
最后 1 MB——而按本项目自己的规矩（`README.md`、`check-structure.mjs` 都在守这条），
证据不能被程序替你决定删掉。复制成功则内容另存；复制也失败时，health 文件里
`kind` 会是 `rotate-failed-truncated` 而不是 `rotate-failed-copied`，**明说内容会丢**。

第 3 级是刻意的：超限的文件用户能用 `ls` 看见，停止的日志看不见。

### 3.3 `--health` 现在能发现日志坏了

`healthCheck(state, { logHealth })` 新增日志层，四种状态**必须可分**：

| `logHealth` | 判定 |
|---|---|
| `undefined`（调用方不传） | **不加日志层**，输出形状与改动前完全一致 |
| `null`（health 文件不存在） | `？ log 尚无日志健康记录（从未出现过故障）`——是「没记录」，不是「正常」 |
| `{healthy:true}` | `✓ log 正常` |
| `{healthy:false}` | `✗ log <kind>（<detail>）`，并进 `reasons` → 整体不健康，退出码 1 |

「没检查」与「检查过、没问题」在输出里长得不一样，是这一条的重点。

**为什么 `undefined` 不加层，而不是加一个 `verified: false` 的层**：TUI 的检查表会把每一层
渲染成 `<name> <age>`，而日志层没有 `ageMs`，实测渲染成「log 从未」——把「没检查」
读成「从没运行」。为了统一形状而在别的调用方那里制造一句假话，是更糟的交换。
所以只有明确传了 `logHealth`（`null` 或对象）才加这一层。

**日志层刻意不印大小。** 试过印，但它是「上次写 health 那一刻」的量（正常路径按分钟节流），
实测与真实值差一截（69 vs 172）。给一个精确到字节却已过期的数字，正是
`output-format.md` §2.1 禁止的那种「看起来精确的估算」。日志层要回答的是
「日志系统有没有坏」，不是「现在多少字节」。`log-health.json` 里仍保留 `sizeBytes`
供程序读，只是 `--health` 的文本不展示它。

---

## 四、用真实卡住状态验证（不重启进程）

拿真实的 1,048,522 字节文件当 `watch.log`（副本，不碰生产），注入各档失败。
三次都写一条 200 字节的行，确保越过上限（离上限只剩 54 字节）：

```
A（rename 正常）：
  轮转成功 → watch.2026-11-12T14-59-56-355Z.log + 新 watch.log 229 B
  log-health: healthy: true

B（rename EPERM）：
  watch.<时间戳>.copy.log = 1,048,522 B  ← 与原文件等大，旧内容一字不丢
  新 watch.log 首行：2026-11-12T14:59:56Z [WARN] log-health: rotate-failed-copied（见 log-health.json）
  stderr: [log-fault] rotate-failed-copied: rename→... 失败（EPERM），已复制到 ...copy.log 并截断原文件
  --health: healthy = false，reasons 指名 rotate-failed-copied

C（rename + copy + truncate 全挂）：
  watch.log 1,048,842 B（> 上限 1,048,576）← 超限但内容完整，一行不丢
  末两行：rotate-failed-append-only 的 WARN + 那一行正文
  --health: healthy = false，kind = rotate-failed-append-only
```

**修复后这类故障的表现**：生产进程需要重启才会用上新代码（本轮未重启）。
重启之后，如果真出现 rename 被占用，日志**不会停**，旧内容先被复制走，
`--health` 会退出码 1 并指名 `rotate-failed-copied` / `rotate-failed-append-only`；
`log-health.json` 里有 `streak`，能看出「一直没恢复」。

---

## 五、负向验证（回退修复，测试必须变红）

用一次性脚本逐条打补丁回退（脚本已随临时目录删除；复现方法：把下表左列的代码改回原文，
例如把 `catch { renameErr = e; }` 换回 `catch { /* ignore */ } return { rotated: false };`）：

| 回退项 | 变红的用例 |
|---|---|
| 轮转失败静默吞掉 | DFS-01、DFS-02 |
| stat 失败一律静默 return | DFS-04 |
| 写失败不落应急文件 | DFS-05 |
| 截断前不先复制（旧内容会永久丢掉） | DFS-02b |
| `healthCheck` 不看日志层 | DFS-06 |

四条全部生效。恢复后 152/152 全绿（含 DFS-02b）。

---

## 六、测试数字

| 时刻 | `node --test scripts/*.test.mjs` |
|---|---|
| 开工基线 | 873 / 873 |
| 本 Agent 结束后 | **881 / 881**（+8：DFS-01…DFS-07 + DFS-02b） |

`node scripts/check-structure.mjs` → 通过。README / CLAUDE.md / GUIDE.md / validate.yml
里的测试数已同步为 881（硬门会对账）。

---

## 七、未做的事 / 残留

1. **生产进程仍是旧代码**（PID 25456）。新逻辑要下次重启才生效。本轮按任务要求不重启。
2. `createObservationLog` 的 `catch { /* ignore */ }`（`scripts/watch.mjs`，观察日志追加）
   有同类问题：写失败只由调用方记 WARN，没有应急文件。本轮未改——它不是本次故障路径，
   且改动会与 F13 范围外的观察日志设计纠缠。记在这里，不假装已覆盖。
3. 验证用的临时脚本（`analyze.mjs` / `compare*.mjs` / `verify-real.mjs` / `negative.mjs`）
   建在包外的临时目录里，跑完已删除，不在仓库内。每个实验的复跑方法都写在本文件对应小节里。

---

## 八、工作中发现并如实记录的一件事：守护进程在本轮期间停止了

**事实**（不修饰）：PID 25456 的最后一轮 tick 是 `2026-11-12T13:11:02Z`（本地 21:11:02）。
我开工时（11:50Z）它还在每 15 秒更新 `state.json`，收工时（13:46Z 复核）它已经不在了。
`state.json` / `watch.log` / `runner.log` 三个文件的 mtime 都停在 13:11:02Z，日志**没有**
`watch 退出` 这一行（`startWatch` 正常收尾会写它），说明不是优雅退出。

**我做了什么、没做什么**：

- 我**没有**执行任何 `taskkill` / `Stop-Process` / `kill` 针对 25456。全程只做代码修改与单元测试。
- 我跑过多次 `node --test scripts/*.test.mjs`（全量 880→881 条）与 `node scripts/check-structure.mjs`。
  `watch.test.mjs` 的注释明确写「全部用 mkdtemp 临时目录，不碰真实 %LOCALAPPDATA%」，
  我复核了 25 处 `runTick({...})` 调用，全部显式传 `dir`。

**受控实验（用来证明或排除因果关系，而不是靠「我没做」）**：

1. 起一个哑 node 进程 → 跑全量 881 条 → **哑进程存活**。排除「测试套件无差别杀 node 进程」。
2. 用 `OVERWATCH_STATE_DIR` 改道另起一个**真的** `watch.mjs --dry-run` 常驻实例 → 跑全量 881 条
   → **实例存活**。排除「测试套件杀掉常驻 watcher」。
3. 跑 `check-structure.mjs` → 前后 node PID 集合比对，**没有 PID 消失**。排除结构门。

**所以：我查不出它为什么停，我也不能证明与我无关。** 三种可能都还没排除：

- 宿主（Claude 桌面 App）重启会话时顺带清理了它拉起的子进程；
- 某个我没运行过的外部工具/脚本动了它；
- 进程自身崩溃（事件日志里没有 WER 记录，也没有 Application Error 条目）。

**这条必须留给用户判断**：任务明确写「不要重启正在运行的守护进程（PID 25456 附近）」。
现在它已经不在了，**是否重启请用户决定**。若要我重启，命令是
`node scripts/install-watcher.mjs install` 或直接跑 `node scripts/watch.mjs`——但那会改变运行状态，
不该由修复 Agent 单方面决定。

**一个讽刺的巧合**：这正是本文要修的那类问题——**「监控自己停了，而没人知道它为什么停」**。
现有的 `--health` 只能报「多久没 tick 了」，报不出「它是被杀的、崩的、还是退出的」。
本轮修的 `log-health.json` 补不上这一块（它记的是日志子系统故障，不是进程生命周期）。
建议另开一条：在 `startWatch` 的 `SIGINT`/`SIGTERM` 处理器与 `process.on('exit')` 里落一个
`watch-alive.json`（含 pid / 启动时刻 / 最后 tick / 退出原因），这样下次能区分「优雅退出」与「被杀」。
本轮不做——它超出「日志轮转」的范围，且需要用户先决定进程去留。

