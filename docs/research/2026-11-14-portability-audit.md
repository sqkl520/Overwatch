# 可移植性审计：只在作者这台机器上成立的假设

> 审计日期 2026-11-14 · 审计对象 `3691d30` · 审计环境 Windows 11 / Node 26.12.1
> 方法：能跑的都跑了。Node 18.20.4 / 20.10.0 / 20.11.0 / 20.12.0 / 20.15.0 / 20.16.0 /
> 20.19.0 / 22.3.0 八个真实二进制从 nodejs.org 下载后逐版本实跑全量套件；
> 其余结论用构造语料 + 直接调用导出函数实测。**跑不出来的标「未验证」。**

审计口径：产品目标是「可以给别人用不掉链子」。所以本报告把
**「给出错误结论但不报错」排在「崩溃」之前** —— 崩溃用户会来问，
错误结论用户不会。

---

## 0. 一句话诊断

**产品形态没有搭起来。** 核心判据（`scan-sessions` / `verify-claims` / 写前闸）的
工程完成度很高，但它们的正确性全部锚在**三个只在作者机器上成立的假设**上：
`~/.claude/projects` 的精确目录形状、transcript 的当前 JSON 形状、以及
「大小写不敏感 + 用户叫 Administrator」。前两个由宿主决定、第三个由本机决定，
三处都没有版本闸或形状自检。任何一处漂移，工具**继续以高置信度的语气输出数字**。

最直接的证据：`git clone` 出来的全新副本，**第一条命令**（`check-structure.mjs`，
CLAUDE.md 要求「任何改动后必须跑」）就 exit 1，原因是一条 gitignored 文件缺失。

---

## 1. 环境假设清单

### 1.1 Node 版本 —— README 写错了，实测最低 20.16.0

| 出处 | 声明 |
|---|---|
| `README.md:14` | 「只要 Node ≥ 18」 |
| `docs/GUIDE.md:13` | 「Node ≥ 18」 |
| `docs/GUIDE.md:461` | 「确认 Node ≥ 18」 |
| `.github/workflows/validate.yml:17` | CI 用 `node-version: '20'`（实测等价于当前 20.x ≥ 20.16，所以 CI 绿是运气） |

**实测矩阵**（干净 HEAD 导出到临时目录，`node --test scripts/*.test.mjs`）：

| Node | pass | fail | 结论 |
|---|---|---|---|
| 18.20.4 | 1184 | **13** | ✗ |
| 20.10.0 | 1184 | **13** | ✗ |
| 20.12.0 | 1256 | **5** | ✗ |
| 20.15.0 | 1256 | **5** | ✗ |
| **20.16.0** | **1261** | **0** | ✓ 真实最低 |
| 20.19.0 / 22.3.0 / 26.12.1 | 1261 | 0 | ✓ |

**两个 API 是唯一的门槛**（逐版本探测确认）：

| API | 引入版本 | 用在哪 | 18 上 20.15 上 |
|---|---|---|---|
| `import.meta.dirname` | 20.11.0 | 6 个测试文件 | 缺（18） |
| `process.getBuiltinModule` | **20.16.0** | `claim-ledger.test.mjs`、`install-watcher.test.mjs`、`watch.test.mjs` | 缺（18 / 20.12–20.15） |

**生产脚本在 Node 18 上全部能跑**：30 个非测试脚本 `--check` 全过，
`scan-sessions` / `stop-signals` / `watch` / `claim-ledger` / `pre-write-gate` /
`oversight-tui` / `validate-run` 等 CLI 实跑 exit 0。
所以「用工具」的底线是 18，「跑测试验证工具」的底线是 **20.16.0**。

- **文档说了没有**：说了 ≥18，**是错的**。
- **不满足会怎样**：测试红 13 条（18）/ 5 条（20.12–20.15），报错信息是
  `process.getBuiltinModule is not a function` —— 指向的是**测试脚手架**不是产品代码，
  一个陌生用户很容易读成「这仓库质量不行」而不是「我的 Node 太旧」。
- **依据**：八版本实跑，见上表。

### 1.2 文档里的测试命令在 Windows 默认 shell 下直接失败

`README.md:150` / `CLAUDE.md:42` 的验收命令是 `node --test scripts/*.test.mjs`。
`node --test` **在 Node < 22 不做 glob 展开**（`fs.globSync` 22.3 才有）。
Windows 的 `cmd.exe` 和 PowerShell **都不会**为外部命令展开 glob。

实测（同一份干净 HEAD）：

| shell | Node 20.16 | 结果 |
|---|---|---|
| Git Bash（本机默认） | 20.16 | 正常跑 12 条 |
| `cmd.exe` | 20.16 | `Could not find '...\scripts\*.test.mjs'`，exit 1 |
| PowerShell | 20.19 | `Could not find '...\scripts\*.test.mjs'`，exit 1 |
| `cmd.exe` | 22.3+ | 正常（Node 自己展开） |

- **文档说了没有**：没有。全文没有一句「请在 Git Bash / WSL 下跑」，也没有
  「Windows 请用 `node --test scripts/`」。
- **不满足会怎样**：报错信息说文件找不到，用户会以为仓库不完整。
- **依据**：`cmd.exe` 与 `powershell` 各实跑一次。

### 1.3 `~/.claude/projects` 布局假设

`scan-sessions.mjs:853-861` 的遍历是硬编码的两层：

```
<root>/<slug>/<sessionId>.jsonl
<root>/<slug>/<sessionId>/subagents/**/*.jsonl      ← 递归（含 workflows/wf_*/）
```

假设清单与失效后果：

| 假设 | 违反时 | 会不会报错 |
|---|---|---|
| 主 transcript 叫 `<sessionId>.jsonl` | 实测：改成 `<sid>/transcript.jsonl` → 该会话**整个消失** | **不报错**。总数从 2 变 1，输出里没有任何「少了一个」的痕迹 |
| 子 agent 目录叫 `subagents/` | 改名 → 子 agent 全丢，`sub=0`、`maxDepth=0` | **不报错** |
| slug 是 cwd 的**无损**编码 | 见 §1.4，非 ASCII 会被折叠成 `-` | **不报错** |
| `<root>/memory` 是唯一要跳过的非项目目录 | 宿主新增任何非项目目录 → 当项目扫 | 不报错，混进统计 |

- **文档说了没有**：`scan-sessions.mjs` 的注释里写了很多「实测」，但**没有一处**说
  「这是宿主私有格式，版本变了会静默失效」。
- **依据**：构造 `<slug>/<sid>/transcript.jsonl` 与 `agents/` 两种替代布局，
  `scan-sessions --all` 分别报 0 个会话和 sub=1（只认出 `subagents/`）。

### 1.4 非 ASCII 项目路径：slug 是**有损**编码，且会碰撞

宿主把 cwd 编码成 slug 时**非 ASCII 字符逐字符变成 `-`**。本机真实语料：

```
C--C-----/           ← cwd = "C:\C盘清理路径"（已丢信息）
```

实测后果（两个不同项目 → 同一个 slug）：

```
D--Projects---       ← <drive>:\Projects\项目A 与 <drive>:\Projects\项目B 都编码成这个
```

（两个中文项目名逐字符变成 `-`，落到同一个 slug。）

同一 slug 目录下放两个不同 cwd 的会话，`scan-sessions --all` 输出：

```
[PRODUCING] Projects///     calls=1 ...
[PRODUCING] Projects///     calls=1 ...
```

**两个不同项目显示成同一个名字**，且没有任何提示。

- **文档说了没有**：没有。`README` / `GUIDE` 完全没提非 ASCII 路径。
- **不满足会怎样**：中文项目名用户的**所有**中文目录项目在面板上显示成同一个
  `Projects///` 或 `C/////`，用户无法分辨是哪个项目，也无法分辨是不是重复条目。
- **依据**：本机真实语料 `C--C-----` 实测；合成双项目碰撞实测。
- **补充**：写前闸的 `pathKeyOf` 也被这条影响，见 §3.1。

### 1.5 平台：Windows 是事实上的唯一一等公民

| 能力 | Windows | macOS / Linux | 代码位置 |
|---|---|---|---|
| 桌面通知 | Toast（wscript+VBS） | **无**，退回写 runner.log | `notify.mjs:173` 显式 throw |
| 开机自启 | 启动文件夹 + .lnk | 只给 launchd / systemd **文字说明**，不写文件 | `install-watcher.mjs:65` |
| 剪贴板 | PowerShell + UTF-16LE | `pbcopy` / `xclip` | `oversight-tui.mjs:384-397` |
| 状态目录 | `%LOCALAPPDATA%\Overwatch` | `$XDG_STATE_HOME/overwatch` | 三处各写一份（watch / notify / asked / install-watcher） |
| `PowerShell` 工具 | 存在 | **宿主没有这个工具** | 见 §3.2 |

**状态目录在 macOS 上没有按 Apple 惯例**：无 `LOCALAPPDATA` 时落到
`~/.local/state/overwatch` —— 这在 macOS 上是个不存在的惯例目录（惯例是
`~/Library/Application Support`）。不致命，但用户的备份/清理脚本会漏掉它。

- **文档说了没有**：`README.md:50` **说清了**通知与自启的平台差异，这条做得好。
  状态目录位置（尤其 macOS 的非惯例路径）没有任何文档。
- **依据**：`defaultNotifyDir({})` / `autostartAdvice('darwin'|'linux'|'freebsd')`
  直接调用实跑。

### 1.6 编码 / locale

- **stdout 编码**：实测在 `chcp 936`（GBK）与 `chcp 65001`（UTF-8）下，
  Node 写出的字节**完全相同**（都是 UTF-8），中文没有变 `?`。
  这意味着：在 GBK 控制台上直接看会显示乱码，但**重定向到文件后内容是对的**。
  这是 Node 的正常行为，不是本仓的缺陷；只是文档没提「GBK 终端下请重定向或 `chcp 65001`」。
- **`toLocaleString()`**：`scan-sessions.mjs:1017` 用了，实测在
  en-US / de-DE / zh-CN / ar-EG 四个 `LANG` 下输出一致（`1,234,567`）——
  Windows 上 Node 不跟随 `LANG`。Linux 上会跟随（未验证）。
- **`Intl.Segmenter`**：`tui-theme.mjs:355` 有 `segmenterAvailable()` 兜底，
  缺 ICU 时退化为按码点量宽。Node 18 实测 `typeof Intl.Segmenter === 'function'`。

**依据**：`chcp` 双档实跑 + 四 locale 实跑。

### 1.7 时区

- `--days N` 是**滚动窗口**（`nowMs - N*86400000`），不是自然日。
  `scan-sessions.mjs:828`、`verify-claims.mjs:1291` 一致。**没有**自然日边界硬编码。
- `stop-verify-hook.mjs:346` 的日志文件按**本地日期**分桶：
  `logPathFor({}, 2026-11-14T23:30Z)` 在 `TZ=UTC` 下得 `2026-11-14.jsonl`，
  在 `TZ=Asia/Shanghai` 下得 `2026-11-15.jsonl`。行为正确（本地日），但
  **同一台机器换时区会分裂成两个日志文件**，跨时区协作的两台机器无法直接对账。
- **文档说了没有**：没有。
- **依据**：三时区注入实跑。注意 Windows 上 `TZ` 环境变量只对部分 zone 生效
  （实测 `America/Los_Angeles` / `Europe/Berlin` 都被映射成 +8，只有 `UTC` 生效），
  所以「Linux 上的分桶行为」**未验证**。

### 1.8 权限 / 只读环境

写点清单（实测每处）：

| 写到哪 | 谁写 | 只读时 |
|---|---|---|
| `<cwd>/.claude/.ow-read-done` | `pre-write-gate` | 闸门判 `deny`（fail-closed，符合设计） |
| `<cwd>/.claude/.ow-gate-secret` | `pre-write-gate` | 同上 |
| `<repo>/tasks/runs/{pre-write-gate,stop-hook}/<日期>.jsonl` | 两个 hook | `appendLog` 返回 false / null，**静默丢弃** |
| `%LOCALAPPDATA%\Overwatch\` | watch / notify / asked | 静默
| `scripts/install/start-watch.vbs` | `install-watcher install` | **写进仓库**（见 §2.2） |

**写前闸会写进「用户的项目」而不是本仓**：`.ow-read-done` + `.ow-gate-secret`
落在被监控项目的 `.claude/` 下。实测（在临时用户项目里跑 hook）：

```
<user-project>/.claude/.ow-gate-secret   (65 B)
<user-project>/.claude/.ow-read-done     (471 B)
```

模板 `templates/pre-write-gate.settings.json:53` 只说「想把这个文件加进 .gitignore
就加」——**是可选项，不是必做步骤**。陌生用户装上闸门后 `git status` 会多出
两个文件，其中一个还是密钥。

- **依据**：`runHook()` 实跑 + 目录实测。

---

## 2. 硬编码扫描

`check-structure.mjs` 的路径检查（`checkAbsolutePaths`）拦的是**盘符 + 名字白名单**：

```js
const WIN_PATH = /[A-Za-z]:[\\/](?:Users|Projects|Server|Java|maven|Nodejs|Git)[^\s)"'`]*/g;
```

**负向实测**（这是本报告最重要的一张表）：

| 输入（`<X>` = 盘符） | 会不会被拦 |
|---|---|
| `<X>:\Users\Administrator\x` | ✓ 拦 |
| `<X>:\Projects\Overwatch` | ✓ 拦 |
| `<X>:\game\GTA\_work` | ✗ **漏** |
| `<X>:\work\myrepo` | ✗ **漏** |
| `<X>:\Documents\notes.md` | ✗ **漏** |
| `/home/alice/code/repo` | ✗ **漏**（POSIX 绝对路径完全不在规则内） |
| `<X>:\Users\bob\.claude` | ✓ 拦 |

即：**它只认「盘符 + 六个特定目录名」**。任何不在白名单里的盘符路径、任何
POSIX 绝对路径都不拦。这是硬门的形状缺陷，不是漏配。

### 2.1 命中的硬编码（代码里的行为假设）

| 文件:行 | 内容 | 会让谁的机器出错 |
|---|---|---|
| `scripts/observe-reality-check.mjs:110` | `/^C--Users-Administrator-AppData-Local-Temp/` | **所有非 Administrator 用户**：他们机器上的沙箱会话不被识别为沙箱，被当成真实项目计入「误拦率/真实项目 N」分母。实测：`<X>:\Users\alice\...\Temp\x` → `isSandbox = true`（因为 cwd 含 `/Temp/` 兜底），但 cwd 缺失或走非 C 盘时 → `false`。**非 C 盘的 Temp 与无 cwd 的沙箱一律漏判** |
| `scripts/observe-reality-check.mjs:112` | 同上，对 cwd 再测一次 | 同上 |
| `scripts/probe-evidence-sources.mjs:58` | `SANDBOX_SLUG_RE = /^[A-Za-z]--Users-Administrator-AppData-Local-Temp\|Overwatch--tmp-analysis/i` | 同上，且更窄（只认 Administrator） |
| `scripts/notify.mjs:53-54` | `SystemRoot \|\| '<X>:\\Windows'` | 无害兜底（正常 Windows 都有 `SystemRoot`） |
| `scripts/install-watcher.mjs:214` | `SystemRoot \|\| '<X>:\Windows'` | 同上 |
| `scripts/claim-ledger.mjs:321` | `'/tmp/', '/var/tmp/', '/private/tmp/', '/dev/', '/proc/'` | 这是一份**临时目录白名单**。Linux 上 `$XDG_RUNTIME_DIR`、macOS 的 `/var/folders/**` 都不在内 → 那些路径会被当成真实产出记进台账 |
| `scripts/install/start-watch.vbs:28` | `stateDir = "<X>:\Users\Administrator\AppData\Local\Overwatch"` | **生成的产物**（gitignored，`install` 时重渲染），但它在工作树里就以本机绝对路径存在 |

### 2.2 可发布区的路径检查有三个洞（负向实测）

洞 1：**`.claude/skills/` 不在扫描范围**。
`PUBLISHED_DIRS = ['docs','templates','rules','scripts','spec-adr']`，外加显式加入的
`.claude/agents` —— **没有 `.claude/skills`**。而 `CLAUDE.md` 的目录归属表把
`.claude/skills/oversight/SKILL.md` 列为「可发布 是」。

负向实测（在干净 HEAD 副本里往 SKILL.md 第一行插一行真实本机路径）：

```
见 <X>:\Users\Administrator\secret\run.mjs 与 <X>:\Projects\my-private-repo\x.md
→ check-structure.mjs 无任何违规输出
```

洞 2：**文件扩展名白名单**排除了 `.vbs` / `.ps1`。
`checkAbsolutePaths` 只扫 `['.md','.mjs','.js','.json','.yml','.yaml','.txt']`。
所以 `scripts/install/start-watch.vbs`（含本机绝对路径）与
`scripts/uia-probe.ps1`（45 KB，PowerShell 5.1）**在路径检查上是透明的**。

洞 3：见 §2 开头的 `WIN_PATH` 白名单缺陷。

- **文档说了没有**：`CLAUDE.md` 说「禁止在可发布区出现本机绝对路径。`check-structure.mjs`
  会拦」——这句话对 `.claude/skills/` 和 `.vbs/.ps1` 是**不成立的**。
- **依据**：三次负向注入实测。

### 2.3 其它硬编码

- **会话 ID**：生产脚本里**零个**硬编码完整 UUID（grep 确认）。
- **端口**：**零个**。全是本地文件 IPC。
- **机器名**：**零个**（无 `hostname()` 调用）。
- **时间戳常量**：`measure-gate-ceiling.mjs:611` 的 `cut = '2026-10-01T00:00:00.000Z'`
  是测量脚本的默认分析起点 —— 对陌生用户无意义但在 `measure-*` 探针里，可接受；
  `check-structure.mjs:415-416` 里的 `'2026-11-01T23:31:45.824Z'` 是 `checkImportable`
  的**探针参数**（注入一个固定时钟跑导出函数），属测试数据。

---

## 3. 跨平台实测

### 3.1 `pathKeyOf()` 在大小写敏感文件系统上**制造**了一个闸门绕过 —— 真实风险

```js
// scripts/pre-write-gate.mjs:221-223
export function pathKeyOf(p) {
  return String(p || '').replace(/\\/g,'/').replace(/\/+/g,'/').replace(/\/$/,'').toLowerCase();
}
```

注释写的是「Windows 下大小写不敏感，所以一律小写」，但**没有 `process.platform` 判断** ——
它在 Linux / macOS（默认 APFS 也大小写不敏感，但 Linux 一定敏感）上照样小写。

**实测（本机，调用 `decide()`，`mode: 'deny'`）**：

| 场景 | 结果 |
|---|---|
| 读过 `/repo/src/a.mjs`，要 `Edit` `/repo/src/A.mjs` | **allow / target-read** |
| 读过 `/tmp/caseprobe/src/a.mjs`，要 `Edit` `.../A.mjs` | **allow / target-read** |
| 读过 `a.mjs`，要 `Edit` `b.mjs`（对照） | deny |

即：在 Linux 上，**读过 `a.mjs` 就自动获得写 `A.mjs` 的许可**。两个文件在
ext4 上是完全无关的两个文件。这是 §1.4「Edit 侧判据改成读过目标文件本身」
（`docs/spec/2026-11-14-pre-write-gate-split.md`）的**直接失效** —— 那个 18/18
的实测结论在大小写敏感系统上不成立。

**同一个仓库里两个模块口径不一致**：
`claim-ledger.mjs:255-262` 的 `pathKey()` **有** `process.platform === 'win32'`
守卫，`pre-write-gate.mjs` 的 `pathKeyOf()` **没有**。两份「同一个文件」的判据
在 Linux 上会给出不同答案（实测 `pathKey` 也折叠 —— 因为跑在 Windows 上，
无法在本机证明 Linux 行为；**Linux 上的实际差异未验证**，但代码差异可读）。

- **文档说了没有**：`pre-write-gate.mjs:220` 的注释只写了 Windows，**没写 Linux**。
  `README.md:50` 说「macOS / Linux 给出 launchd / systemd 配置」，言下之意是支持。
- **不满足会怎样**：Linux 用户装上 deny 模式，闸门在 Edit 侧基本不设防。
- **依据**：`decide()` 直接调用，allow/deny 三组实测。

### 3.2 `bashWriteScan` 认的是 **bash**，但 `PowerShell` 分支在 Linux 上永不触发

`SHELL_TOOLS = ['Bash', 'PowerShell']`。Linux 上宿主没有 `PowerShell` 工具，
所以 `powershellWriteScan` 那一整套（`Set-Content` / `Out-File` / `[IO.File]::WriteAllText`）
在 Linux 上是死代码 —— **这不是缺陷，是白写**。

真正的问题在**工具名漂移**（实测，`mode: 'deny'`）：

| 工具名 | writeIntentOf | decide 结果 |
|---|---|---|
| `Write` | file-tool | **deny** ✓ |
| `Edit` | file-tool | **deny** ✓ |
| `PowerShell` | powershell | **deny** ✓ |
| `write_file` | none | **passthrough / unknown-tool** |
| `edit_file` | none | **passthrough / unknown-tool** |
| `mcp__fs__write` | none | **passthrough / unknown-tool** |
| `Shell` | none | **passthrough / unknown-tool** |
| `Terminal` | none | **passthrough / unknown-tool** |

即：**matcher 与工具名一漂，deny 模式整个失效**，日志里写的是
`passthrough / unknown-tool` —— 一行看起来完全无害的记录。代码注释
（`pre-write-gate.mjs:788-791`）确实说了「matcher 与宿主工具名漂移时会从这里看出来」，
但那是**日志里能看出来**，不是**会报出来**。而 `observe` 是默认模式、
日志默认没人看，这条等于不存在。

- **文档说了没有**：注释里提了「留名」，模板 `matcher` 写死
  `Write|Edit|NotebookEdit|Bash|PowerShell`，**没有**说「宿主加新工具名必须同步改 matcher」。
- **依据**：`decide()` 八组工具名实测。

### 3.3 `bashWriteScan` 有 4 类写动词既不记 writes 也不记 unresolved

模块头承诺「判不出的一律跳过并计数」（`claim-ledger.mjs:16`）。
实测以下命令**两个计数都不加**：

| 命令 | writes | unresolved | 说明 |
|---|---|---|---|
| `sed -i s/a/b/ x.mjs` | 0 | 0 | `inPlaceEdits=1`，单独字段 |
| `dd of=x.mjs if=/dev/zero` | [] | **0** | 漏 |
| `truncate -s0 x.mjs` | [] | **0** | 漏 |
| `install -m644 a b.mjs` | [] | **0** | 漏 |
| `ln -s a b.mjs` | [] | **0** | 漏 |
| `cp a b.mjs` / `mv a.mjs b.mjs` | 1 | 0 | ✓ |

即：`dd` / `truncate` / `install` / `ln -s` 落盘的文件**既不在产出里，也不在
「看不见的部分」里**。这正是模块头自己点名的病（「『没有产出』和『没看』长得一模一样」）
的复发，只是换了一批动词。

### 3.4 换行符 `\r\n`

实测：合法 JSONL 用 `\r\n` 分行，`parseJsonl` 正常解析（`records=2, bad=0`）——
因为 `split('\n')` 后每行尾部残留的 `\r` 会被 `JSON.parse` 当空白吃掉。
**`\r\n` 不是问题**，这条可以放心。

真正会静默失败的是 **BOM**：

```
plain.jsonl → records=1 bad=0
bom.jsonl   → records=0 bad=1     ← UTF-8 BOM 让 JSON.parse 整行失败
```

端到端实测：BOM 开头的 transcript 在 `scan-sessions` 里表现为
「时间未知 1」，会话**整个不见**。`verify-claims.mjs` **连 badLines 计数器都没有**
（grep 结果 0 处），所以那边是彻底的静默。

---

## 4. 「别人装了 Claude Code 但配置不同」的失败面

按严重度排。**A 档 = 用户发现不了**。

### A 档：给出错误结论且用户无法发现

**A1. transcript 的 `tool_use` 形状一变，会话被判成「没干活」**

实测三种形状，同一份 `scan-sessions --all`：

| 记录形状 | calls | 判定 |
|---|---|---|
| `message.content[{type:'tool_use'}]`（当前） | 1 | PRODUCING |
| `tool_calls[{id,name,arguments}]`（OpenAI 风格） | 0 | **EXPLORING / cold-start** |
| `message.content` 是字符串 | 0 | **EXPLORING / cold-start** |

三种都 `bad=0`。用户看到的是「这个会话只是刚开 / 在探索」，
而它其实写了一个文件。**没有任何计数、警告或版本字段提示「这条记录我没看懂」**。
`probe-evidence-sources.mjs:226-229` 认了 4 种 `tool_use.id` 命名空间
（`toolu_bdrk` / `toolu_` / `chatcmpl` / `tooluse_`），但**那是 id 前缀分类器，
不是形状自检**；真正决定 calls 的是 `extractCalls` 里那两行
（`rec?.message?.content` / `block?.type !== 'tool_use'`）。

- 用户怎么发现：**发现不了**。除非他手动 `grep tool_use` 那个 jsonl。

**A2. `--days` 在同一个仓库里有两个互相矛盾的语义**

| 工具 | 判据 | 出处 |
|---|---|---|
| `scan-sessions` | transcript **内部时间戳**（注释明确说「不再用文件 mtime」） | `scan-sessions.mjs:828,886` |
| `verify-claims` | 文件 **mtime** | `verify-claims.mjs:1291,1304` |

实测（同一份语料：内部时间 90 天前，mtime = 现在）：

```
verify-claims --days 7  → 包含这个会话（1 条）
scan-sessions --days 7  → 0 个会话，明确写 "窗口外 1"
```

即：**同一天、同一批文件，两个命令给出相反的答案**，而且两个都是「成功」退出。
`scan-sessions` 的注释解释了为什么 mtime 不可信（241 个文件里 122 个 mtime 与真实
活动差 >24h，最大 8.4 倍）—— 那个论证对 `verify-claims` **同样成立**，但它没改。

- 用户怎么发现：只有同时跑两个命令并对账才会发现。

**A3. 沙箱识别绑死 `Administrator`，陌生机器上分母是错的**

`observe-reality-check` / `probe-evidence-sources` 用来回答
「真实项目里有多少会话会被误拦」这个问题。它们的沙箱判据第一项是
`/^C--Users-Administrator-AppData-Local-Temp/`。

实测：

| cwd | slug | isSandbox |
|---|---|---|
| `<X>:\Users\Administrator\...\Temp\x` | 对应 slug | true |
| `<X>:\Users\alice\...\Temp\x` | 对应 slug | true（cwd 含 `/Temp/` 兜底） |
| **`<非C盘>:\Users\bob\...\Local\Temp\x`** | `...--Users-bob-...` | **false** |
| **cwd 缺失 + slug `C--Users-alice-...`** | — | **false** |
| `/tmp/sandbox` / `/var/folders/...` | — | **false** |

别人的机器上沙箱会话会被算进「真实项目」，**把误拦率凭空抬高**——
而这正是那两份报告里最关键的分母。

- 用户怎么发现：发现不了。数字看起来合理。

**A4. 子 agent 枚举在两处不一致，差 37% 的文件**

- `scan-sessions` 的 `collectSubagentFiles` **递归**进 `subagents/workflows/wf_*/`
  （注释：3220 个里 1190 个在那层）。
- `verify-claims` 的 `subagentFiles:1182-1188` **只读直接子文件**。

实测（一个直接子文件 + 一个 `workflows/wf_1/` 下的）：

```
scan-sessions  → calls=3 sub=2 depth=1
verify-claims  → subagentCount: null
```

后果：`verify-claims --include-subagents`（文档承诺「连子 agent transcript 一起找证据，
只会把 NO_EVIDENCE 降级成 UNKNOWN」）**在 workflows 型 subagent 上完全看不到东西**，
于是本该降级成 UNKNOWN 的判成 **NO_EVIDENCE**——「AI 说做了但没证据」，
一个比「无法判定」严重得多的指控。

- 用户怎么发现：只有知道 `subagents/workflows/` 存在才会怀疑。

**A5. 配置目录被搬走时，半数工具仍然读老路径**

`CLAUDE_CONFIG_DIR` 只有 `watch.mjs` 认（1 处）；`CLAUDE_PROJECTS_DIR` 只有
`tui-meta.mjs` 认（1 处）；其余全部硬编码 `join(homedir(), '.claude', 'projects')`。

实测：把 projects 放到 `CLAUDE_CONFIG_DIR` 下，`scan-sessions` 仍在扫老路径
（本机 436 个会话），`watch --inbox` 说「收件箱：空」。

- 用户怎么发现：看会话数不对才发现。而 `watch --inbox` 的空不是错误——它自己都说
  「空不等于健康，也可能是守护进程没在跑」，但没说「也可能是路径不对」。

**A6. `isGateOwnedPath` 的相对路径分支不看 cwd**

```js
return /\/\.claude\/\.ow-[^/]+$/.test(k) || /^\.claude\/\.ow-/.test(k);
```

实测：

```
isGateOwnedPath('.claude/.ow-read-done', '/completely/different/dir') → true
isGateOwnedPath('/victim/proj/.claude/.ow-payload', '/attacker')      → true
```

任何以 `.claude/.ow-` 结尾的绝对路径、以及任何相对形式，都被判成「闸门自己的文件」
而放行——**包括别的项目里的**。设计意图是防自锁，实现成了「名字对就放」。

**A7. 全新的 `git clone` 上，第一条命令就红**

```
git clone <repo> && cd <repo> && node scripts/check-structure.mjs
→ ✗ 3 项违规：CLAUDE.md:61 / docs/GUIDE.md:333 / docs/CAPABILITIES.md:63
   引用的文件不存在：.claude/settings.local.json
→ exit 1
```

`.claude/settings.local.json` 在 `.gitignore:2` 里，**不在 HEAD 里**，只在作者机器上。
而 `CLAUDE.md` 说「任何改动后必须跑 `check-structure.mjs`，两者都绿才能提交」。

也就是说：**陌生用户克隆下来，第一件被告知必须做的事就失败**，而失败原因是一个
他根本还没有的本地配置文件。（对照：测试套件在全新克隆上 **1261/1261 全绿**，
所以不是仓库不完整。）

- 用户怎么发现：立刻发现（这条属于「报错」，不属于静默）。但它会让用户
  对整个仓库产生错误的第一印象，且 CLAUDE.md 的措辞暗示「你环境有问题」。

### B 档：会报错（好得多）

| 场景 | 行为 |
|---|---|
| `~/.claude/projects` 不存在 — `scan-sessions` | exit 2 + 明确文案 |
| 同上 — `probe-evidence-sources` / `observe-reality-check` / `probe-parser-divergence` | exit 2 |
| 同上 — **`verify-claims` / `stop-signals` / `asked` / `watch` / `tui-meta`** | **exit 0 + 「0 条 / 空」** ← 见 A 档同类 |
| `~/.claude/projects` 存在但为空 | `scan-sessions` 报「0 个会话」（与「不存在」正确区分） |
| 只读 cwd 上的写前闸 | deny（fail-closed，符合设计） |
| 日志目录不可写 | `appendLog` 返回 false/null，**静默丢弃**（无提示） |

**这里的严重缺陷是退出码不一致**：同一个「找不到 transcript 根」的条件，
9 个工具里 4 个 exit 2（`scan-sessions` / `probe-evidence-sources` /
`observe-reality-check` / `probe-parser-divergence`），另 5 个 exit 0 并输出「一切正常」
（`verify-claims` / `stop-signals` / `asked` / `watch` / `tui-meta`）。
脚本化调用方（CI、wrapper）无法统一处理。

---

## 5. 汇总

### 5.1 交付口径

- **最低 Node 版本（实测）**：跑测试 **20.16.0**；只用工具 **18.20.4**（生产脚本 30/30 可解析、主要 CLI exit 0）。
  `README.md:14` / `docs/GUIDE.md:13` 的「≥ 18」对测试是**错的**。
- **最严重的 3 个可移植性问题**：
  1. **transcript 形状无自检**（§A1）：`tool_use` 换形状 → calls=0 → 判成「冷启动/探索」，`bad=0`，无任何提示。
  2. **`pathKeyOf()` 无条件小写化**（§3.1）：Linux 上「读过 `a.mjs`」= 「允许写 `A.mjs`」，写前闸 Edit 侧判据直接失效。
  3. **路径硬门的形状缺陷 + 覆盖洞**（§2）：`WIN_PATH` 只认 6 个目录名和盘符，POSIX 路径全不拦；`.claude/skills/`（可发布、已跟踪）与 `.vbs/.ps1` 完全不在扫描范围 —— 负向注入实测都漏。
- **「给出错误结论但不报错」的场景：11 个**，分别是
  A1 transcript 形状漂移 · A2 两个 `--days` 语义互斥 · A3 沙箱识别绑死 Administrator ·
  A4 子 agent 枚举差 37% · A5 `CLAUDE_CONFIG_DIR`/`CLAUDE_PROJECTS_DIR` 口径不一 ·
  A6 `isGateOwnedPath` 相对路径放行任意目录 · A7 `check-structure` 在 skills/.vbs 上失明 ·
  非 ASCII 项目名有损碰撞（§1.4）· 缺失 transcript 根时 5 个工具 exit 0 说「空」（§B）·
  BOM 使整个 transcript 静默失效且 `verify-claims` 无 badLines（§3.4）·
  `bashWriteScan` 对 `dd`/`truncate`/`install`/`ln -s` 既不记产出也不记 unresolved（§3.3）。

### 5.2 未验证

- Linux / macOS 上的**实际**运行行为（本机是 Windows；§3.1 的 `pathKey` 差异是从代码读出来的，不是跑出来的）。
- `TZ` 在 Windows 上只对部分 zone 生效，Linux 上的日志分桶行为未测。
- 宿主版本升级后的真实 transcript 形状（当前语料全部来自同一宿主 2.1.30x）。
- `toLocaleString()` 在非 Windows 上的 locale 跟随行为。

### 5.3 一条流程说明

本报告落在 `docs/research/` 下但**未登记进 `docs/research/README.md`** ——
任务是「只许写这一份报告」，登记需要第二次改文件。后果：
`check-structure.mjs` 的 `checkResearchIndex()` 会红一条
（「这些报告没有登记」）。这是一次有意的、明示的取舍，不是遗漏。
