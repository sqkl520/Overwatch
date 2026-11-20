[English](SECURITY-EN.md) | 简体中文

# 安全策略

## 先说清楚它是什么、不是什么

UntilDone 是一个**纯 Claude Code 配置库**：markdown 角色定义 + 零依赖 Node 脚本，没有常驻服务、
没有后端、没有账号体系（`docs/adr/0001-config-only.md`）。它做三件事：

1. **读**本机 `~/.claude/` 下的会话记录（transcript、`sessions/*.json`、`jobs/*/state.json`），
   判定每个会话在干什么、有没有卡住；
2. **写**它自己的运行台账与状态（`tasks/runs/`、`%LOCALAPPDATA%/UntilDone`、会话目录下的
   `.claude/.ow-*`）；
3. **在宿主会话里当 hook**：写前闸（`PreToolUse`）与收工闸（`Stop`）拦截工具调用或回合结束。

它**不联网**（`probe-relay.mjs` 连本机命名管道是唯一的套接字，见 §2）、**不收集遥测**、
**没有更新检查器**、**从不向你要 token**、**不存任何凭据**。

**每个文件读写与子进程都能追到代码位置** —— 下面每一节都给了 `文件:行号`。
如果文档与代码冲突，**以代码为准**，并欢迎开 issue 指出。

> ⚠️ **先说最重要的一条**：**这个库读得到你全部的对话内容。**
> 它读 transcript，而 transcript 里有你让 AI 看过的代码、贴过的报错、写过的密钥（如果你贴过）。
> 它的降级手段是「打码」与「少读」，不是权限隔离。见 §5。

---

## 支持范围

**本项目没有版本号可谈。** 实测：`git tag` 为空，没有 Release，没有 npm 包 ——
仓库的 `main` 分支就是发布物（`README.md` 开头）。

| 你跑的东西 | 是否支持 |
|---|---|
| `main` 的最新提交 | ✅ 只有这一种 |
| 任何旧的 clone | ❌ 修复不会回移到分支；唯一办法是 `git pull` |
| fork | ❌ 由 fork 者自己负责 |

两点如实说明：

- **`main` 没有分支保护**（维护者实测：GitHub API 返回 `Branch not protected`），
  所以「修复落在 main」意味着**修复一到 main 就生效**，中间没有评审门。这同时也是攻击面：
  任何能推 `main` 的凭据，都能直接改掉 hook 的行为。
- **没有 git 签名要求，也没有 release 产物**。你 `git pull` 到的东西就是全部内容；
  没有可供比对的校验和。想确认自己跑的是哪一版，`git rev-parse --short HEAD`。

---

## 报告漏洞

**不要为安全问题开公开 issue。** 公开 issue 所有人可见，包括会在修复前利用它的人。

**首选 —— GitHub 的私密漏洞报告** ——
[开一份 draft advisory](https://github.com/sqkl520/UntilDone/security/advisories/new)。
在修复发布之前，它只有你和维护者能看到。

> 这条渠道是**仓库设置里的一个开关**，2026-11-21 实测为 `enabled: true`，
> 链接可用。如果哪天它又变成关闭，这个链接会失效，下面的备用路径就是干这个的。

如果上面那个链接对你的账号不生效，就开一个
[普通 issue](https://github.com/sqkl520/UntilDone/issues/new)，正文**只写一句话**：
「security report, please enable a private channel」，**别的什么都不要写** ——
不要细节、不要复现步骤、不要受影响的路径。维护者会开一条私密渠道，在那里回你。

不要把漏洞细节放进公开 issue、PR 或 commit message。

### 请提供什么

| 需要 | 为什么 |
|---|---|
| **克隆的提交 hash**（`git rev-parse --short HEAD`） | 没有 tag 也没有 Release，hash 是唯一能定位到那一版的标识 |
| **`node scripts/overwatch.mjs` 的整块输出** | Node 版本与平台在里面。**贴之前先删掉路径**：`transcripts` 行的 `root` 与 `sources` 行的 `claudeDir` 是你的家目录绝对路径（`checkSources()`），`--json` 里同样是原文 |
| **完整命令与 `OW_*` / `OVERWATCH_*` 环境变量** | 闸门的模式、日志落点、状态目录都由环境变量决定。同一份代码在 `OW_PRE_WRITE_GATE=observe` 与 `deny` 下行为完全不同 |
| **复现步骤或最小 PoC** | 一份最小复现比一篇长文有用 |
| **攻击者能得到什么** | **影响比机制重要**。「能注入一个转义序列」和「能让只读报告改写你的剪贴板」是两件事 |
| **相关日志片段，已脱敏** | 会话 id、项目名、本机路径、transcript 原文都不该出现在公开内容里 |

### 响应时间

| | |
|---|---|
| 确认收到 | **7 天内** |
| 初步判断（是不是真问题、多严重） | **14 天内** |
| 修复，或书面说明为什么决定不修 | 确认的问题在 **90 天内** |

这些是目标，不是合同。这是一个单人维护的项目。如果过了窗口还没回复，
在 advisory 里再 ping 一次 —— 没动静意味着通知漏了，不是报告被无视了。
没有漏洞赏金，也没有 PGP 密钥（要加密的话请先问，别默认有）。

---

## 1. 范围 —— 什么算安全漏洞

**这一节的每一条都对应一个具体的攻击面，不是通用清单。**

### 在范围内

| 类别 | 具体是什么 | 审查处（代码位置） |
|---|---|---|
| **终端转义注入** | transcript 内容、项目名、会话标题、`cwd`、`needs` / `suggestedReply`、`delta` 的 token 列表都会上屏。任一处能发出活的转义序列（OSC 52 写剪贴板、移动光标、伪造 SGR 让别人读错判定），就是真漏洞 | `tui-theme.mjs` 的 `stripAnsi()` / `ANSI_RE`；`oversight-tui.mjs` 的 `sanitize()`（`:106`），以及 `viewOf()`（`:601`）是唯一必经的净化入口 |
| **只读路径被用来产生副作用** | 一个自称「只读报告」的渲染能改剪贴板、能写文件，就是漏洞。这条有过真实历史：`DF-013`（`sessionId` / `project` / `hostState` 未净化，OSC 52 穿透），已修 | `oversight-tui.mjs:1000` / `:1042` 的注释记着为什么只从 `viewOf` 取字段 |
| **由 transcript 内容驱动的路径穿越或任意文件读** | 会话 `cwd`、实例名、run id、日志文件名等外部可控输入逃出预期目录 | `claim-ledger.mjs:244` / `:520` 的路径解析；`project-commands.mjs` 的 `detectProjectCommands()` 只按**会话 cwd** 读仓库根标志文件，单文件上限 256 KiB（`MAX_READ_BYTES`） |
| **hook 被诱导去做别的事** | 两个 hook 从 stdin 收 JSON，并被接进别人的会话。输入必须被当成不可信数据：解析失败要 fail-open，不能把输入拼进命令 | `pre-write-gate.mjs` 的 `parseHookInput()` / `readStdin()`（4 MiB 上限 + 时间闸）；`stop-verify-hook.mjs` 的 fail-open 设计 |
| **闸门被静默关掉或绕过** | 让闸门看起来在工作、实际一条判据都没执行（`DF-031` / `DF-033` 是这一类：静默跳过与通过输出逐字相同）；或者绕过签名伪造「验出来的」标记 | `pre-write-gate.mjs:1212` 的 `verifyMarkerSig()`（HMAC-SHA256 + `timingSafeEqual`）；密钥文件本身被写判 `secret-tamper`（`:1515`） |
| **凭据泄漏** | 本项目不要 token、不存 token。找到一条代码路径：读一个含密钥的环境变量然后写到任何地方（日志、台账、`tasks/runs/`、终端），那是漏洞 | 全仓唯一的 secret 是闸门自己的 `.claude/.ow-gate-secret`；`launch.mjs:613` 只在**提示文案**里提到 `ANTHROPIC_API_KEY` 这个名字，不读取它 |
| **让 hook 拦住本该放行的操作** | `stop-verify-hook.mjs` 默认 fail-open 且不可配置成 fail-closed；把它的崩溃变成「会话无法结束」是安全问题（可用性也是安全） | `stop-verify-hook.mjs` 文件头「设计原则 1」；`isPaused()` 是 L1 叫停路径 |

### 不在范围内 —— 预期行为或已声明的取舍

| 不算漏洞 | 依据 |
|---|---|
| **本库读 `~/.claude/` 下的文件** | 这就是它的用途。跑它 = 授予它读你会话记录的权限。`SECURITY.md` 不打算把这件事包装成别的 |
| **本库能读到 transcript 里的全部对话内容** | 同上。它只读**尾部一段**（默认 1 MiB / 512 KiB 两档），这是性能与隐私的双重让步，不是隔离 |
| **`tasks/runs/` 里出现会话 id 与本机路径** | 按设计被 gitignore（`.gitignore:8`）。**不要提交它。** 它的存在是「事后可审计」的代价 |
| **`--days N` 会扫到什么就打印什么** | 本地的、只读的报告。屏幕上出现你不想被人看见的内容，是「如实报告」的直接后果 |
| **`probe-relay.mjs --send` 真会往别的会话投一条消息** | 它存在的目的就是测这件事。不跑它就没有连接 |
| **hook 会拦你的工具调用 / 回合结束** | 这是产品功能。你能选择装不装、开哪一档（`observe` / `warn` / `deny`），也能用叫停文件一刀切断（§8） |
| **上游问题**：Claude Code 自身、Node 的 bug | 报给上游。若上游缺陷**在本库被放大**，那部分是我们的 |

---

## 2. 网络 —— 实际核实结果

**结论：整个仓库只有一处套接字连接，连的是本机命名管道，不是网络。**

核实方法（可自行复算）：

```bash
grep -rn "from 'node:net'\|from 'node:http'\|from 'node:https'\|from 'node:tls'\|from 'node:dgram'" scripts/
grep -rn "\bfetch(\|globalThis.fetch\|WebSocket\|undici" scripts/ .claude/ templates/
```

两条命令的命中：

| # | 命中 | 用途 | 是不是网络 |
|---|---|---|---|
| 1 | `scripts/probe-relay.mjs:37` `import net from 'node:net'` | 连**本机命名管道** | **不是** |
| 2 | `scripts/gen-width-table.mjs:22`–`23`、`scripts/width-table.mjs:7` | `https://www.unicode.org/...` 出现在**注释**里，说明那两个数据文件的来源 | 不是调用。数据已 vendored 在 `scripts/data/` |
| 3 | `scripts/published-paths.mjs:28` | 注释里拿 `http://x` 举例，说明正则为什么要排除 URL | 不是调用 |

`fetch` / `WebSocket` / `node:http(s)` / `node:tls` / `node:dgram` 在 `scripts/`、`.claude/`、
`templates/` 里**零命中**（`verify-claims.mjs:455` 的 `fetch\s+first` 是一条匹配 git push
报错文本的正则，不是网络调用）。

### 唯一的套接字：`probe-relay.mjs`

| 事实 | 位置 |
|---|---|
| 会话注册信息从 `~/.claude/sessions` 读 | `probe-relay.mjs:41`、`:44`（`listSessions()`） |
| socket 路径取自注册文件里的 `messagingSocketPath` | `probe-relay.mjs:58` |
| 建立连接 | `probe-relay.mjs:91`（`canConnect`）、`:128`（`sendFrame`） |
| **对 `messagingSocketPath` 只判非空，不校验前缀/形状** | `probe-relay.mjs:90`：`if (!socketPath) { done(...) }` 之后直接 `net.createConnection(socketPath)`（`:91`） |
| `--send <pid>` 会真的发一帧，内容里带 `peerToken` | `probe-relay.mjs:219`–`:226`（token 从 `<pid>.<64hex>.key` 读出，`:71`–`:85`） |

**这意味着什么，如实说**：本脚本信任 `~/.claude/sessions/*.json` 里写的路径。
如果你能写那个目录（它在你自己的家目录下，权限由操作系统管），你就能让这个脚本
去连任意一个命名管道。本库不校验它。这是「只用来做本机诊断的脚本」的边界，
不构成提权 —— 能改那个目录的人本来就能改更多东西。它**不连 TCP**，也不需要网络。

### 入站

**没有监听端口。** 没有任何脚本调用 `listen()` / `createServer()`。
本库不是服务，没有可连的地址。

---

## 3. 文件 —— 读什么、写什么

### 读（外部数据，全部只读打开）

| 路径 | 用途 | 读多少 | 位置 |
|---|---|---|---|
| `~/.claude/projects/**/*.jsonl` | transcript：状态判定、断言核对、采样 | **尾部窗口**：1 MiB（`CLAIM_TAIL_BYTES`）、512 KiB（`TAIL_BYTES`）、有界回溯（`readBack` 的 `steps`） | `verify-claims.mjs:50` / `:1092` / `:1107`；`stop-signals.mjs:42` / `:78` |
| `~/.claude/sessions/*.json` | 宿主注册的活跃会话 | 整个 JSON | `watch.mjs:1045`；`scan-sessions.mjs:649`；`probe-relay.mjs:44` |
| `~/.claude/jobs/**/state.json` | `BLOCKED` / `FAILED` / `WAITING` 的宿主事实来源 | 整个 JSON | `scan-sessions.mjs:690`；`watch.mjs:2683` |
| transcript 里记录过的会话 `cwd` 下的构建标志文件 | 认「这个项目该怎么跑测试」（`package.json` / `pom.xml` / `build.gradle` / `Cargo.toml` / `go.mod` / `pyproject.toml` / `*.sln` …） | **只读仓库根**，单文件上限 256 KiB，不递归 | `project-commands.mjs:24` / `:116`；调用点 `verify-claims.mjs:1872`、`stop-verify-hook.mjs:855` |
| 仓库自身 | 硬门、载荷、宽度表 | —— | 全部 `scripts/*.mjs` |

**`~/.claude/` 只读、从不写。** 核实：`writeFileSync` / `appendFileSync` / `rmSync` /
`mkdirSync` 的调用点里，**没有一处**路径含 `.claude`、`projects`、`sessions` 或 `jobs`
（`grep` 可复算）。唯一的 `.claude` 写入发生在**你的项目目录**里（见下），不是 `~/.claude`。

### 写（全部在四个地方之一）

| 位置 | 内容 | 可覆盖？ | 位置 |
|---|---|---|---|
| `<仓库>/tasks/runs/**` | 闸门台账（`pre-write-gate/<日期>.jsonl`、`stop-hook/<日期>.jsonl`、`stop-hook-samples.jsonl`、`hook-dedupe/`）、launch 台账、run 台账 | `OVERWATCH_STATE_DIR` / `OVERWATCH_RUNS_DIR` / `OW_PRE_WRITE_GATE_LOG` / `OVERWATCH_STOP_VERIFY_LOG` 可改道 | `pre-write-gate.mjs:1810`；`stop-verify-hook.mjs:452` / `:505` / `:603`；`hook-dedupe.mjs:100`；`launch.mjs:494` |
| 状态目录：`%LOCALAPPDATA%/UntilDone`（Windows）或 `$XDG_STATE_HOME/untildone` | `state.json`、观察日志、`asked-history.json`、`notify/`、进程见证、`.witness.json` | `OVERWATCH_STATE_DIR` 可改道；改名前的 `Overwatch` 目录存在时**继续用旧的**（不自动搬） | `state-dir.mjs:30`–`:63`；`watch.mjs:112`；`asked.mjs:714`；`notify.mjs:44` |
| 会话目录：`<cwd>/.claude/.ow-*` | 写前闸的标记 `.ow-read-done`、拒绝计数 `.ow-gate-denials.json`、**签名密钥** `.ow-gate-secret`（`mode 0600`） | 跟项目走，不跟仓库走 | `pre-write-gate.mjs:128` / `:131` / `:135` / `:1183` |
| 临时目录 / 仓库内生成物 | `os.tmpdir()/overwatch-replay-cache`（回放缓存，可用 `--cache off` 关）、`dist/`（plugin 载荷、社交预览图）、`scripts/install/start-watch.vbs`（安装器渲染）、`scripts/width-table.mjs`（从 `scripts/data/` 生成） | —— | `replay-observe.mjs:915`；`build-payload.mjs:350`；`make-social-preview.mjs:265`；`install-watcher.mjs:188`；`gen-width-table.mjs:35` |

**一个会写到仓库外的动作**：`install-watcher.mjs install` 会在
`%APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup/` 下建一个快捷方式
`Overwatch Watch.lnk`（`install-watcher.mjs:62` / `:102`）。这是**开机自启**，只有你显式
跑 `install` 才会发生，`uninstall` 会删掉它。非 Windows 上 `startupDir()` 返回 `null`，
它不假装装好了，而是打印 launchd / systemd 的做法。

**唯一会临时改写源码的脚本**：`verify-bugfix-negatives.mjs`、`verify-claim-fix-negatives.mjs`、
`verify-tui-negatives.mjs`。它们为了做负向验证，会**临时**把 bug 写回源码、跑测试、再写回原文
（`verify-bugfix-negatives.mjs:203`–`:215`，`finally` 保证还原）。它们**不改 git 状态**。
如果你不想让任何东西改工作树，就别跑这三个。

---

## 4. 它会不会执行你没让它执行的命令

**核实结论：仓库里没有 `shell: true`（`grep -rn "shell: true" scripts/` 零命中）。**
所有子进程都用参数数组起，不经 shell 拼串。全部子进程调用点：

| 起什么 | 谁 | 位置 | 是不是「你没让它执行」 |
|---|---|---|---|
| `git ls-files` / `git log` / `git show` / `git --version` | 硬门 | `check-structure.mjs:122` / `:1548` | 不是，只读查询 |
| `node --check`、`node --input-type=module -e <自造脚本>`、`node --test` | 硬门 / 负向验证 | `check-structure.mjs:376` / `:958` / `:1495`；`verify-*.mjs` | 不是，脚本内容由本仓库生成 |
| `claude`（或 `--host-bin` 指定）| `overwatch launch` | `launch.mjs:1154` | **是你要的**：这个子命令的作用就是起一个宿主会话 |
| `wscript.exe` → `powershell.exe` 跑本仓库生成的 `.ps1` | 桌面通知 | `notify.mjs:186`；`install-watcher.mjs:233` | 不是，脚本由本仓库内联模板生成 |
| `powershell.exe` / `pbcopy` / `xclip`（写系统剪贴板） | TUI 按 `c` 复制草稿 | `oversight-tui.mjs:394`–`:430` | 不是，只有你按键才发生 |
| `powershell` `Get-Process .StartTime` / `ps -o etimes=` | 判守护进程是否还活着、PID 有没有被复用 | `watch.mjs:288` / `:296` | 不是，只读查询 |
| `node <本仓库脚本>` | 入口路由、WUI 扫描、TUI 抽样、健康检查 | `overwatch.mjs:202`；`watch.mjs:1301`；`oversight-tui.mjs:309` / `:344` | 不是 |
| `taskkill /T` | `launch --print` 超时后杀进程树 | `launch.mjs:1190` | 不是，杀的是它自己刚起的子进程 |

**`scripts/uia-probe.ps1`**（1168 行，PowerShell + UI Automation）是仓库里唯一能操作
**别人窗口**的东西。它**没有任何 `.mjs` 调用它**（`grep -rn "uia-probe" scripts/*.mjs` 零命中），
只能你手动跑。它自己的安全模型：只按名字在 UIA 树里找控件、**从不按坐标点**；
找不到唯一目标就中止（`ProbeExitCode 2`）；写进输入框后用 `SetValue`（`:772`）并**读回轮询**，
不匹配就还原成写入前的内容（`:812`）；**从不调用 Send 按钮的 `InvokePattern`**
（全文件只有 `:593` / `:685` 两次「探测该模式是否存在」，没有 `.Invoke(` 调用）。
两次现场事故记在 `docs/CHANGELOG.md`：误覆盖过一份 47 字符草稿（已按字节还原）、
误调过一次 `Hide sidebar`。**它是实验工具，不是产品功能。**

---

## 5. 本库防不住什么

**这一节是本文件最重要的部分。** 每一条都是真实存在的限制，不是免责声明。

1. **它读你的全部对话。** transcript 里有你让 AI 看过的代码、贴过的报错、写过的路径。
   本库按**尾部窗口**读（1 MiB / 512 KiB），并且只把**摘录**写进自己的台账 ——
   但它读得单次就是那么多，而「读到了什么」由你的语料决定，不由它决定。
2. **摘录也会落盘。** `tasks/runs/stop-hook-samples.jsonl` 会存下「本轮最后一段回复的前
   500 字」加工具调用摘要（`stop-verify-hook.mjs:599` 的 `SAMPLE_TEXT_LIMIT`、`:603` 的
   `samplePathFor`）。这是刻意的：那一层是为了「先采集真实分布，再决定加不加规则」。
   它默认**开**，可以用 `OVERWATCH_STOP_VERIFY_SAMPLES=off` 或 `--no-sample-log` 关掉。
   **关掉它之前，先知道它默认开着。**
3. **hook 会拦你的工具调用与回合结束。** `pre-write-gate.mjs` 在你第一次写文件前可能返回
   `permissionDecision:"deny"`；`stop-verify-hook.mjs` 在 `OVERWATCH_STOP_VERIFY=block` 时
   会返回 `{"decision":"block"}`，把 reason 作为下一轮指令喂回模型。
   本机这份 `.claude/settings.local.json`（gitignored、不在仓库里）就把这个开关设成了 `block`。
4. **叫停路径可以被模型删掉。** L1 叫停文件（`stop-verify-hook.mjs` 的 `pausePathsFor()`：
   `%LOCALAPPDATA%/UntilDone/stop-hook.PAUSE`，兼容旧的 `Overwatch/` 同名文件，任一存在即生效）
   能让闸门立刻闭嘴，但它的注释自己写着：
   「它**可以**被模型用 Bash 删掉 —— 但那是一次会在 transcript 里留痕的操作，事后可审计。
   这里不假装它是安全的。」
   **两处都认的直接后果**：只删一处不再能解除叫停，得删掉全部候选（或用
   `OVERWATCH_STOP_VERIFY_PAUSE` 指到一个不存在的路径）。这是 fail-safe 方向上的代价。
5. **闸门默认 fail-open。** hook 崩了、超时了、输入是垃圾、transcript 读不到 —— 一律放行
   （两个 hook 的文件头都写了理由：闸门故障不该让人写不了文件、不该让人结束不了会话）。
   **代价是：一个坏掉的闸门看起来和「没有可拦的东西」一样。** 判据是台账里的
   `allowReason`，不是你看到的「没报错」。
6. **它信任它读到的路径。** `probe-relay.mjs` 不校验 `messagingSocketPath`（§2）；
   收工闸按 transcript 里记的 `cwd` 去读那个项目的 `package.json` 等文件（§3）。
   这两个信任的前提是「你的家目录与你的项目目录是可信的」。
7. **`launch` 起的宿主会话继承你**整个**环境变量。** `childEnv()`（`launch.mjs:409`）是 `{ ...process.env }` 加一条 `PATHEXT` 兜底 —— 你没传给它的东西（包括任何含密钥的环境变量）都会原样传给子进程。这是必须的（宿主自己靠这些变量工作），但它意味着「这个 shell 里有什么，那个会话里就有什么」。
8. **它不防设备已被攻破。** 能读你的家目录的进程，能读本库读到的一切，还能改本库的判据
   （hook 脚本就在仓库里）。
8. **没有专职安全响应，没有漏洞赏金，`main` 没有分支保护。** 见 §支持范围。

---

## 6. 已知的残余风险（知情但未修）

这些不是「没想到」，是权衡后保留的。列在这里，是为了让你能自己判断风险。
条目号对应 `tasks/dev-findings.md`。

| 条目 | 状态 | 一句话 |
|---|---|---|
| **`DF-030`** | `wontfix` | `tasks/runs/` 里的 hook 台账已有**无法区分真伪**的污染行（历史测试写的与真实会话写的长得一样，`sessionId` / `cwd` 多是 `unknown` / `null`）。清理等于**假定**全是测试写的，而那个假定无法证明，所以留着脏数据。**用它做统计只能按时间切**（`2026-11-18 11:00` 之后才是干净的） |
| **`DF-021` 的残留风险** | `open` | 观察日志与运行台账的归档**仍在同一块盘、同一个目录下**：能扛住「误删单个文件」，扛不住「删整个目录 / 磁盘故障 / 清理工具」。**本库没有备份机制，README 也不应声称有** |
| **`DF-026`** | `open` | `overwatch.test.mjs` 的两条测试在并发负载下偶发变红，未能稳定复现。影响不是「数据错」，而是**「全绿」这个信号不可靠** —— CI 偶发红会训练人忽略红 |
| **`DF-034`** | `open` | 「50 次真实 block 只有 1 次后面跟着工具调用」这个数字在本机**无法复现**，而它曾被用来论证「Stop 闸不该拦」。注释应改成「本机没有可复现的数据」。**这不是漏洞，但它是一个警示**：本库的判据强度依赖真实台账，而台账里目前真实 `blocked` 记录极少 |
| **`DF-032` / `DF-035` / `DF-037` / `DF-038`** | `wontfix` / `open` | 编造或无法复现的数字被写进注释与文档（同一个失败模式复发过四次）。**对安全的含义**：任何一条引用本仓「实测数字」的断言，都应该被当作待复核的，而不是已证实的 |
| **`DF-039`** | `fixed` | 硬门那道「可发布区零盘符」只认 7 个固定前缀，真实的 8 条本机路径一直报绿。改后第一轮抓出 8 条。**它的教训仍然有效**：一条只覆盖一部分的判据，报绿与不报一样糟 |
| **`DF-013`** | `fixed` | `sessionId` / `project` / `hostState` 未净化，OSC 52 可以让**只读渲染器改写你的系统剪贴板**。已统一走 `sanitize()`。**留在这里是因为它是本库最严重的一类历史缺陷的样本**：净化只做在详情页、列表页没做，两条展示路径各修一半 |

**我自己核实到、但台账里没有的一处不一致**（写出来而不是藏着）：
`stop-verify-hook.mjs` 的叫停文件路径曾经硬编码旧目录名 `'Overwatch'`，
没有跟随 `state-dir.mjs` 的改名规则（`UntilDone` / `untildone`），也不认
`OVERWATCH_STATE_DIR`。**2026-11-21 已修**（`DF-041` → `fixed`）：现在是一族候选路径，
**任一存在即暂停**，主路径在前：

| # | 路径 |
|---|---|
| 1 | `$OVERWATCH_STOP_VERIFY_PAUSE`（显式指定；给了就只认这一条） |
| 2 | `$OVERWATCH_STATE_DIR/stop-hook.PAUSE` |
| 3 | `%LOCALAPPDATA%/UntilDone/stop-hook.PAUSE`（POSIX `$XDG_STATE_HOME/untildone/`） |
| 4 | `%LOCALAPPDATA%/Overwatch/stop-hook.PAUSE`（旧名，**向后兼容，不许删**） |

判定方向与 `resolveStateDir()` 的「新优先、否则旧」**有意相反**：那条规则保护的是数据
（别让历史看起来消失了），而这里保护的是「用户要求停止」这件事本身 —— 所以宁可多放行一次，
不可漏掉一次。代价写在 §5 第 4 条（只删一处不再能解除叫停）。
**可观测性**：台账 `allowed-user-paused` 行记 `pauseHit`（真命中的路径）；
`node scripts/pre-write-gate.mjs status --cwd <项目>` 会把四条候选全列出来并标出命中项 ——
「我该把文件放哪」不必读源码。

---

## 7. 已知的加固措施（可自行验证）

| 措施 | 位置 | 说明 |
|---|---|---|
| 终端转义净化 | `oversight-tui.mjs:106` `sanitize()`；`tui-theme.mjs` 的 `ANSI_RE` / `stripAnsi()` | `stripAnsi` 同时认 CSI 与 **OSC**（`\x1b]...`）。历史缺陷是「TUI 自己写了一份更窄的 CSI-only 正则」，注释在 `tui-theme.mjs:332` |
| 净化只有一个入口 | `oversight-tui.mjs` 的 `viewOf()` | 列表页与纯文本页都从它取数据；渲染层不另开一道。`DF-013` 的修法 |
| 闸门签名不可伪造 | `pre-write-gate.mjs:1212` `verifyMarkerSig()` | HMAC-SHA256 + `timingSafeEqual`；`auto` 标记没有合法签名就判无效；**没有 fail-open 降级**（「没有密钥」≠「谁写的都算」） |
| 密钥文件禁止被写 | `pre-write-gate.mjs:1515` | 命中密钥路径的写单独判 `secret-tamper`，不跟「闸门自己的文件」一起放行 |
| hook 输入有界 | `pre-write-gate.mjs` 的 `readStdin()`（4 MiB）+ 时间闸（`DEFAULT_BUDGET_MS` = 5000） | 超预算 = 放行 + 记账：用户的「写」比判定重要 |
| hook 崩溃不锁人 | 两个 hook 都 fail-open | `stop-verify-hook.mjs` 文件头「设计原则 1」：一个打不开的闸比一百个未验证的断言更糟 |
| 拦截次数有上限 | `stop-verify-hook.mjs:89` `MAX_BLOCKS = 6`；`:503` `RESET_AFTER_MS` | 用**会话累计**而不是连续计数 —— 一个会到期的闸门不是闸门 |
| 台账路径脱敏 | `launch.mjs:221` `maskPath()`、`:884` 的 `ledgerEntry()` | 把仓库根 / 家目录 / 临时目录换成 `<repo>` / `<home>` / `<tmp>`，其余盘符路径换成 `<abs>/<文件名>`。曾有两条漏出（`judge.detail` 整块塞进来没过遮罩），由测试抓住 |
| 去重键不落原文 | `hook-dedupe.mjs:115` | 键用 `sha256` 截断做文件名 —— 键里含会话 id 与回复原文，落成文件名会泄漏 |
| 不执行 shell | 全仓 `grep "shell: true"` 零命中 | 子进程一律参数数组 |
| SDK 无第三方依赖 | 没有 `package.json`，只用 `node:` 内置模块 | 没有 `npm install` 这一步，也就没有安装期脚本 |

---

## 8. 加固建议（给用户）

- **跑之前先读一遍你要装的那两个 hook。** 它们是 `scripts/pre-write-gate.mjs` 与
  `scripts/stop-verify-hook.mjs`，都由你手动合并进 `.claude/settings.json` 或
  `.claude/settings.local.json`（模板在 `templates/`）。默认是 `observe`（只记账、只放行），
  要拦得你自己开 `OW_PRE_WRITE_GATE=deny` / `OVERWATCH_STOP_VERIFY=block`。
- **先跑几天 observe，再决定开不开。** 台账在 `tasks/runs/pre-write-gate/<日期>.jsonl`，
  看 `would-deny` 有多少、都是哪些工具。
- **不想让它写任何东西进仓库**：把 `OVERWATCH_STATE_DIR` 指到仓库外，
  两个 hook 与 `hook-dedupe` 都认这一个变量。
- **不想留下对话摘录**：`overwatch-hook-samples` 默认开 —— 关掉它：
  `OVERWATCH_STOP_VERIFY_SAMPLES=off` 或给 hook 加 `--no-sample-log`。
- **想立刻让闸门闭嘴**：创建 `%LOCALAPPDATA%/UntilDone/stop-hook.PAUSE`
  （旧的 `%LOCALAPPDATA%/Overwatch/stop-hook.PAUSE` 同样生效），或用
  `OVERWATCH_STOP_VERIFY_PAUSE` 指到别处。候选路径与判定方向见 §6 末段（`DF-041`，已修）。
  **想知道自己放对没有**：`node scripts/pre-write-gate.mjs status --cwd <项目>` 会列出
  正在检查的每一条路径，并标出命中的那一条。
- **贴日志到公开地方之前自查**：`tasks/runs/` 里有会话 id、本机路径、工具调用路径；
  `doctor` 输出里有你的家目录。这些都不在脱敏范围内 —— 脱敏是**你**这一步的事。
- **不要 `git add -A`**：`tasks/runs/` 与 `.claude/.ow-*` 里含会话 id 与闸门签名密钥。
- **不要跑 `scripts/uia-probe.ps1`，除非你清楚它在操作哪个窗口。** 它改写别人会话的输入框。
- **`main` 没有分支保护**：如果你 fork 并在生产用，自己加保护、自己钉版本（记下 hash）。

---

> 本文档描述的是 `main` 分支在写作时刻的实现。**没有版本号可引** —— 想核对你就跑
> `git rev-parse --short HEAD`。安全断言以代码为准；文档与代码冲突时，代码赢，
> 而指出冲突的 issue 是欢迎的。
