# 红队：用 `--plugin-dir` 挂载载荷，会在哪里坏

- 日期：2026-11-14
- 作者：红队 Agent P2（立场：在方案实现前找出它怎么坏，不是来帮忙的）
- 产出形态：`exploration`（结论报告，零行改现有文件）
- 实测环境：Windows 11 / Git Bash / Node v26.12.1 / `claude --version` = **2.1.289**，
  桌面宿主二进制 `claude.exe` = **2.1.308**（`CLAUDE_CODE_EXECPATH` 读出），本机另有 2.1.270
- 探针脚本与原始日志：`.tmp-analysis/payload-redteam/`（gitignored，不在可发布区）
- 证据等级：T2（本机实跑，命令与输出随文）；跑不出来的进 §7

> **本文不修任何东西。** 每条结论都带可复跑的命令或产物文件名。
> 写作期间另一个 Agent 正在做「从 `.claude/` 生成载荷」（`scripts/build-payload.mjs`，未提交），
> 本文**直接攻击那个方向**，它当时的实现已按 §4 复跑过。

---

## §0 六行裁定

```
① 最可能静默失效的不是「flag 被移除」，是「flag 在、载荷在、hook 不触发」。
   实测四种形态全部 exit 0、文件照样落盘、用户零提示（§3）。ADR §6 的反悔信号 1
   把方向搞反了：移除会 exit 1（响），语义漂移才静默。

② `--plugin-dir` 不在「未文档化契约」的黑暗里：它在 `--help` 里、无 experimental 标记、
   官方文档有专页，且 2.1.270 / 2.1.308 两个版本都有。但它**不是稳定 API**，
   没有版本闸，产品侧没有任何「宿主版本 + 载荷契约」的对账。

③ ADR §6 说「无法在 doctor 里检出」——**这半句是错的**。`claude plugin list --json`
   能检出 3 类（路径不存在 / hooks.json 坏 / 显式 disabled），但**漏 4 类**
   （布局错、manifest 缺、hook 目标不存在、hook 用相对路径）。它还是 4.4 秒/次、永远 exit 0。

④ hooks 的路径问题有解：`${CLAUDE_PLUGIN_ROOT}` **确实存在**（plugin 上下文有值、
   `--settings` 上下文是 null，实测）。但用它就把 hook 的 import 闭包（6 个文件）一起绑进载荷，
   任何一跳断掉都是静默的。ADR 已把 hooks 排除出载荷——那条决定是对的，本文证明它对。

⑤ 「同源」的第三条路：**把 `.claude-plugin/plugin.json` 放进 `.claude/` 里**。
   实测一个目录同时是项目布局和 plugin 根，12 agent + 1 skill 全加载、`validate --strict` 过、
   结构硬门不红。零生成步骤、零第二真源、CI 能测（§4）。

⑥ 装载成功也不等于用户能用：12 个 agent 以 `overwatch:oversight-*` 出现在用户的 `/agents`；
   skill 变成 `overwatch:oversight`，**`/oversight` 从 slash 列表里消失**，
   而 `docs/GUIDE.md:279` 写的正是 `/oversight new`（§2）。
```

---

## §1 版本漂移：契约稳不稳，能不能检出

### 1.1 契约原文与本机版本

`claude --help`（2.1.289）原文，逐字：

```
  --plugin-dir <path>                   Load a plugin from a directory or .zip
                                        for this session only; a folder of
                                        plugins loads each child (repeatable:
                                        --plugin-dir A --plugin-dir B.zip)
                                        (default: [])
```

- `--help` 全文搜 `experimental|preview|beta` 与 plugin 相关的组合：**零命中**。没标预览。
- 三个本机二进制逐个跑 `--help | grep -c plugin-dir`：2.1.270 = **3**、2.1.308 = **3**、2.1.289 = **3**。
  2.1.286 目录是空的（只剩一个空 build 目录），无法验证。
- 官方文档（`.tmp-analysis/cc-agent-view.md:773` 缓存）有专页链接
  `plugins/create#load-a-directory-or-archive-for-one-session`。所以它**不是**「只在 `--help` 里露过脸」。
- 但**没有任何一处**写「这是稳定 API」或给出兼容承诺。ADR §6 称它「未文档化契约」，
  准确说法应是「**有文档、无兼容承诺**」。

### 1.2 「被移除」是什么形态：响的，不是静的

```
$ claude --plugin-dir-REMOVED x -p hi
stderr: error: unknown option '--plugin-dir-REMOVED'
exit:   1
```

**移除是响的。** 应用 spawn 时会拿到 exit 1 + 明确文案，`doctor` 把它当「前提缺失」报出来就行
（ADR §2.2 已经为 `gate`/`sources` 建了这个模式）。所以「契约被移除」**不构成** ADR §6 的反悔信号 1。

### 1.3 真静默的是「语义漂移」，且不是一种，是四种

四种形态我都构造并跑了端到端（真 `claude` 二进制 + 本地 stub 上游，脚本 `.tmp-analysis/payload-redteam/run2.mjs`、`bare.mjs`）：

| 形态 | hook 触发 | 文件落盘 | 退出码 | 用户看到 |
|---|---|---|---|---|
| 正常 | 1 次 | 是（可拦） | 0 | — |
| 删掉 `PATHEXT` 环境变量 | **0 次** | **是** | **0** | **空** |
| `--safe-mode` / `CLAUDE_CODE_SAFE_MODE=1` | **0 次** | **是** | **0** | **空** |
| hook 命令写相对路径 `node scripts/x.mjs` | **0 次** | **是** | **0** | **空** |
| 只拷 `pre-write-gate.mjs`、不带 import 闭包 | **0 次** | **是** | **0** | **空** |

两条对照原始输出：

```
withpathext2: exit=0 hookFires=1 gated=EXISTS
nopathext2:   exit=0 hookFires=0 gated=EXISTS
```

```
--settings run: exit 0  gated= EXISTS
hook log: (none)
（--debug-file 里唯一线索：）
[ERROR] "Hook PreToolUse:Write (PreToolUse) error: status code 1
  stderr: node : 无法将“node”项识别为 cmdlet…CommandNotFoundException"
```

**注意最后一行**：这是宿主**真的报了错**，但它只写进 `--debug-file`。
同一次运行用普通 `-p`（不加 `--debug`）时，`stderr` 是空的、`is_error=false`、`permission_denials=[]`、
`result:"done"`。所以「用户会不会发现」的答案是：**不会**。

### 1.4 ADR §6「无法在 doctor 里检出」——半对半错，要改写

`claude plugin list --json` **是**一个有效检测点。逐形态实测（`doctorprobe.mjs`）：

| 载荷形态 | `plugin list --json` 找到 | 报 error | 判定 |
|---|---|---|---|
| 正常目录 | 1 | 0 | ✅ |
| 正常 zip | 1 | 0 | ✅ |
| 不存在的路径 | 1 | 1 `Path not found` | ✅ 检出 |
| `hooks/hooks.json` 是坏 JSON | 1 | 1 `Hook load failed: JSON Parse error` | ✅ 检出 |
| **仓库根当 `--plugin-dir`（项目布局）** | **0** | **0** | ❌ **静默** |
| **指向 `agents/` 子目录** | **0** | **0** | ❌ **静默** |
| **没有 `.claude-plugin/plugin.json`** | 1（`version:"unknown"`） | **0** | ❌ 静默 |
| **hook 指向不存在的脚本** | 1 | **0** | ❌ **静默** |
| **hook 命令用相对路径** | 1 | **0** | ❌ **静默** |

`claude plugin validate --strict` 也不救最后一行：给 hook 一个不存在的
`${CLAUDE_PLUGIN_ROOT}/hooks/typo-file.mjs`，实测 **`✔ Validation passed`，exit 0**。
（`validate` 只查 manifest 与 JSON 语法，不查 hook 目标文件存不存在。）

**所以那句要改成**：
> `--plugin-dir` / hooks 的契约在某个版本被移除 → **能检出**（exit 1）；
> 语义漂移（hook 不再从 plugin 加载、`${CLAUDE_PLUGIN_ROOT}` 改名、agent 不再加前缀）→
> **只有在应用主动跑 `plugin list` 且逐项断言时才能检出**，而当前 `overwatch doctor` 不跑它。

补两条对 `doctor` 的现实约束：

- `claude plugin list --json` 本机实测 **4.0–4.4 秒/次**，且**四种形态全部 exit 0**。
  `overwatch.mjs` 的预算是 `DEFAULT_BUDGET_MS = 1000`（实测 doctor 墙钟 1172 ms）。
  **把这条检测塞进 doctor 的 1000ms 预算是物理上不可能的**，只能异步/缓存。
- 宿主自带的 `claude doctor` **完全不看 plugin**：带一个坏 hooks.json 的 `--plugin-dir` 跑，
  输出仍是 `No installation issues found.`（两次实测）。指望宿主替我们检，检不到。

---

## §2 用户自己的 plugin 会不会被我们干扰

### 2.1 12 个 agent 会出现在用户的 `/agents` 列表里——实测名单

用真载荷（`dist/payload`）在无关 cwd 起 `claude -p ... --output-format stream-json`，
init 消息的 `agents` 字段：

```
agents: ["claude","claude-code-guide","Explore","general-purpose",
 "overwatch:oversight-acceptor","overwatch:oversight-critic",  …（12 个全部）
 "Plan","statusline-setup"]
```

`plugin details` 给出的常驻开销：**Always-on ~480 tok，加进每一次会话**。
用户只要是被我们 spawn 的会话，就白付这 480 token —— 这可能是设计意图（主线程要调度），
但「用户 `/agents` 里多出 12 个他不认识的 `overwatch:*`」不是。

### 2.2 用户项目里已有同名 agent：不冲突，但**重复显示**

在用户项目 `.claude/agents/oversight-critic.md` 放一份同名定义，再挂载荷：

```
agents: [ … "oversight-critic", …（项目版）
         … "overwatch:oversight-critic", …（载荷版） …]
```

两者共存，靠前缀区分。`--agent oversight-critic` 命中项目版、`--agent overwatch:oversight-critic`
命中载荷版（工具集实测不同：项目版 5 个工具、载荷版 4 个）。**没有冲突，但有歧义**：
用户 `ls .claude/agents/` 看到自己没写过这个文件，`/agents` 里两个同名条目。

### 2.3 最严重的一条：`/oversight` 这个入口消失了

skill 在 plugin 里一律加 `<plugin>:` 前缀。真载荷实测：

```
slash_commands: 51 个
oversight-ish: ["overwatch:oversight"]
bare "oversight" in slash_commands: false
```

而仓库自己的文档写的是裸 `/oversight`：

- `docs/GUIDE.md:279`：`/oversight new                    # 跑一轮完整流程`
- `docs/GUIDE.md:226` / `:235`：`/oversight relay <session-id>`

**用户按 GUIDE 敲 `/oversight new`，得不到任何补全，也不会有报错——他只会以为这个功能不存在。**
这是本文找到的、对「陌生人第一次使用」最狠的一条：装载完全成功，入口静默消失。

### 2.4 hooks 冲突：不「谁赢」，是「都跑」

用户项目 `.claude/settings.json` 一个 `PreToolUse:Write` hook + 载荷一个同 matcher hook，
实测**两个都触发**，日志两行：

```
hook log: {"src":"user"}
{"src":"plugin"}
```

两个插件各挂一个同 matcher hook，也是两次触发（`fire=2`，`CLAUDE_PLUGIN_ROOT` 分别是两个载荷）。
所以语义是**扇出**，不是覆盖。对我们有利（不会被用户 hook 顶掉），
代价是**同一次写会产生两倍的 hook 进程**，而 hook 的性能预算是 5 秒（`templates` 里写明），
用户那个 hook 慢会挤掉我们那个——或者反过来，我们慢会挤掉用户的。

### 2.5 用户自己装了同名 plugin（`overwatch`）：他的 agent 静默输掉

构造：用户 plugin 也叫 `overwatch`，里面有一个同名 `oversight-critic` 但只给 `Read` 工具；
载荷版给 `Read,Grep,Glob,Write`。两种 flag 顺序都跑：

```
payload 在前 → tools = ["Read","Grep","Glob","Write"]
user    在前 → tools = ["Read","Grep","Glob","Write"]
```

**载荷版无条件赢，与 `--plugin-dir` 顺序无关。** 用户那个 `overwatch` plugin 的 agent 定义
被静默覆盖，没有任何警告。这不是我们「干扰」用户的合理代价，这是一个真 bug 面：
`overwatch` 是个很容易被占用的名字。

---

## §3 载荷里放 hooks 的现实风险

### 3.1 schema 是同一套，路径不是

plugin 的 `hooks/hooks.json` 就是 `{"hooks":{...}}`，与 `.claude/settings.json` 的 hooks 段同形状
（官方 marketplace 里 `claude-security`、`hookify`、`security-guidance` 三个 plugin 的
`hooks/hooks.json` 我都读了，形状一致）。

`${CLAUDE_PLUGIN_ROOT}` **存在**，且只在 plugin 上下文有值。同一个 dump 脚本，两种挂法：

```
plugin 上下文: {"CLAUDE_PLUGIN_ROOT":"…\\plhook2","CLAUDE_PROJECT_DIR":"…\\ow-outside-proj","cwd":"…\\ow-outside-proj"}
--settings 上下文: {"CLAUDE_PLUGIN_ROOT":null,"CLAUDE_PROJECT_DIR":"…\\ow-outside-proj","cwd":"…\\ow-outside-proj"}
```

**hook 进程的 cwd 是用户项目，不是载荷目录。** 这就是相对路径必然出错的根因。

### 3.2 相对路径：真的解析到用户项目，真的不存在

载荷 hook 写 `node scripts/pre-write-gate.mjs`，从用户项目（那里没有 `scripts/`）跑：

```
[ERROR] "Hook PreToolUse:Write (PreToolUse) error: status code 1
  stderr: Error: Cannot find module 'C:\\…\\ow-outside-proj\\scripts\\pre-write-gate.mjs'
  code: 'MODULE_NOT_FOUND'"
```

而且我做了更强的一版：在用户项目里**放一个同名的 `scripts/pre-write-gate.mjs`**（内容完全不同），
hook 会**跑用户项目里那个文件**。这比「不存在」更坏 —— 我们等于让宿主去执行用户项目里
一个我们没写过的脚本。

### 3.3 绝对路径：不可移植；而且 import 闭包是 6 个文件

写绝对路径能跑（ADR §3.3 的 PATHEXT 实验就是这么做的），但换个安装位置就坏。
写 `${CLAUDE_PLUGIN_ROOT}` 才对，可那就必须把脚本带进载荷。实测闭包：

```
pre-write-gate.mjs → claim-ledger.mjs
stop-verify-hook.mjs → verify-claims.mjs → asked.mjs, project-commands.mjs
project-commands.mjs
共 6 个文件
```

只拷 `pre-write-gate.mjs` 的实测结果：

```
closure: exit=0 fires=0 gated=EXISTS
[ERROR] Hook … error: status code 1
  Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…\\hooks\\claim-ledger.mjs'
```

**少拷一个文件 = 介入能力归零，退出码 0。** 此外 `pre-write-gate.mjs:117` 用
`REPO_ROOT = resolve(HERE,'..')` 定位日志目录；载荷在 `dist/payload/` 时，
日志会写到 `dist/tasks/runs/…` —— 一个谁也不会去看的地方。

### 3.4 最坏情况用户怎么才会发现：基本发现不了

- 普通 `-p` / TUI 运行：`stderr` 空、`is_error=false`、`result:"done"`、写入成功。
- 唯一线索是 `--debug-file` 里的 `[ERROR] Hook … error`，**没有 --debug 就没有它**。
- `plugin list` 说 `Status: ✔ loaded`（hook 脚本不存在时也是 loaded，§1.4）。
- `plugin validate --strict` 也说 `✔ Validation passed`。
- 宿主 `claude doctor` 说 `No installation issues found`。

**四道检查全绿，闸门一次没拦。** 这正是本仓 2026-11-12 就记过的形态（`exit 0 + 静默`），
只是换了个触发源。

> 顺带钉死另一条：`templates/pre-write-gate.settings.json` 里那句
> 「Windows 上不写 `shell: powershell`，宿主找不到 Git Bash 时会走 fallback」——
> 我实测了 `"shell":"powershell"` 的 plugin hook：正常环境触发、**删掉 `PATHEXT` 后照样不触发**
> （报 `CommandNotFoundException`）。**`shell: powershell` 治不了 PATHEXT，别把它当解药。**

### 3.5 结论：ADR 把 hooks 排除出载荷，这个决定是对的

不是「保守」，是**有实测支撑的唯一选择**。hooks 属于应用行为，由应用在 spawn 时用
`--settings` 带绝对路径（同一条实测证明这条路能真拦住，且 `--settings` 下 hook 会触发）。
但要注意：`--settings` 路线的 hook 也在用户项目 cwd 里跑，所以**仍然只能用绝对路径**——
这条限制没被消除，只是被隔离到一个「应用自己知道自己装在哪」的场景里。

---

## §4 「同源」能不能真保证

### 4.1 生成物 gitignore 掉：CI 里永远测不到「载荷能用」

实测确认：

- `.gitignore` 新加了 `dist/`；`git archive HEAD` 导出后 `ls dist` → 不存在。
- CI（`.github/workflows/validate.yml`）两步：`check-structure.mjs`、`node --test scripts/`。
  **全文 grep `plugin-dir` 零命中**，`dist/payload` 只在 `build-payload.mjs` 自己的注释和测试里出现。
- 在干净导出上跑 `node scripts/build-payload.mjs --check`：

```
✘ 载荷与源不同源（1 条）：
  ❯ 载荷目录不存在：dist/payload
exit 1
```

**结论**：CI 能测「载荷与源一致」，**测不到「载荷真的能被宿主加载」**。
`build-payload.test.mjs` 全部用 `mkdtemp` 造 fixture，从不 spawn `claude`、从不 `--plugin-dir`。
所以「载荷可用」这件事，只在作者机器上有人验证过——正是 ADR §5.2 担心的那种漂移，
只是从「两份 markdown 漂移」变成「生成物与运行时行为漂移」。

### 4.2 第三条路（**实测通过，未实现，本文只给方向**）

不用生成，也不用两份真源：**把 `.claude-plugin/plugin.json` 放进 `.claude/` 里面**。

```
<repo>/.claude/
  .claude-plugin/plugin.json     ← 只有这一行是新的
  agents/*.md                    ← 项目布局认这里
  skills/oversight/SKILL.md      ← 项目布局认这里
```

同一个目录，两种身份：

- cwd = repo 时，宿主按**项目布局**读 `.claude/agents`、`.claude/skills`（不受 manifest 影响）；
- `--plugin-dir <repo>/.claude` 时，同一个目录就是 **plugin 根**，`agents/` 和 `skills/<名>/SKILL.md`
  正好落在 plugin 布局要求的位置上。

实测（把仓库 `.claude/` 完整复制到临时目录，再加一个 `plugin.json`）：

```
$ claude --plugin-dir <copy>/.claude plugin details overwatch
  Agents (12)  oversight-acceptor … oversight-safety
  Skills (1)   oversight
$ claude plugin validate <copy>/.claude --strict
  ✔ Validation passed
```

并且把这一行加进干净导出的 `.claude/` 后跑结构硬门：

```
$ node scripts/check-structure.mjs
✓ 结构检查全部通过     exit 0
```

**它买到的**：零生成步骤、零 `dist/`、CI 能直接 `--plugin-dir .claude` 测真加载、
不需要「用户 clone 后谁保证载荷生成过」这个无解问题。
**它没买到的**（必须写清）：
1. skill 仍然被前缀化成 `overwatch:oversight`，`/oversight` 照样不存在（§2.3）——
   这是 plugin 加载的固有语义，第三种路也不解决；
2. 想改 plugin 名字就必须改 manifest 且改所有调用方；
3. `.claude/.claude-plugin/` 对项目布局是透明的，但对「`ls -a .claude` 的人」不是。

> 另一条候选（生成到 `dist/`）的问题是 §4.1；「以 plugin 布局为真源」的问题是
> ADR §5.2 已写的「弄坏本仓自用」。第三条路是目前唯一同时满足
> 「一份真源 / CI 可测 / 自用不变」的。

### 4.3 「clone 下来后谁保证载荷被生成过」

现状答案：**没人**。仓库零依赖、无 `package.json`、无 install 钩子。
`overwatch` 入口也没调 `build-payload`（`grep -rn build-payload scripts/` 只命中
`build-payload.mjs` / `.test.mjs` / `check-structure.mjs` 的探针登记表）。
所以今天的真相是：**载荷只在手动跑过 `node scripts/build-payload.mjs` 的机器上存在。**
第三条路直接消掉这个问题——不需要生成。

---

## §5 macOS / Linux：静态分析

本机是 Windows，**没有跑过一行 Linux**（§7 已登记）。以下是读代码得出的判断，分两档。

### 5.1 已确证的跨平台问题（代码里能指出行）

| 项 | 位置 | Linux 上会怎样 |
|---|---|---|
| `pathKeyOf` 大小写折叠 | `scripts/pre-write-gate.mjs:226-229` | **已修**：`return process.platform === 'win32' ? s.toLowerCase() : s;`。portability-audit §3.1 那条已不成立，本次实测确认有守卫 |
| `pathKey` 折叠 | `scripts/claim-ledger.mjs:260` | 也有 `win32` 守卫。两处口径已一致 |
| `notify.mjs` Toast | `scripts/notify.mjs:46,64` | 非 win32 显式 throw / 返回 false，退回 `runner.log`（设计如此） |
| `startupDir()` | `scripts/install-watcher.mjs:63-65` | 非 win32 返回 `null`，自启只给 launchd/systemd 文字说明 |
| `PowerShell` 分支 | `pre-write-gate.mjs` 的 `SHELL_TOOLS` | Linux 宿主无 `PowerShell` 工具 → 该分支是死代码（不是缺陷，是白写） |
| 剪贴板 | `oversight-tui.mjs:384-397` | `pbcopy` / `xclip` 分派，非 win32 路径存在 |
| **相对路径 `node scripts/x`** | 载荷 SKILL/agent 正文 11 处 / 5 个 agent | **所有平台都一样坏**，与 OS 无关（§3.2） |

**载荷内容本身没有 Windows 专属假设**：`.claude/` 全目录 grep
`PowerShell|\.cmd|\.lnk|startupDir|PATHEXT` → **零命中**。
所以「agent/skill 的正文」在 Linux 上不会因为 Windows 特有词而坏。

### 5.2 怀疑但未验证（Linux 上可能不同，我不下结论）

1. **`--plugin-dir` 在 Linux 上的行为**：未跑。风险点是路径大小写（Linux 敏感）、
   zip 解包与权限位、`${CLAUDE_PLUGIN_ROOT}` 里的空格/引号。
2. **`PATHEXT` 那个陷阱在 Linux 上不存在**（Linux 没有这个变量），
   但等价物是「`node` 不在 hook 继承的 PATH 里」——**未验证** hook 继承的是谁的 PATH。
3. **hook 的 `shell` 默认值**：Windows 上默认走 cmd/PowerShell fallback（`templates` 里写过
   任何非零退出会被转成 `ask`）；Linux 上默认大概率是 `/bin/sh`。**未验证**。
4. **`claude plugin list` 的 4.4 秒**是 Windows 冷启动 + 本机插件数导致；
   Linux 上未知。
5. **`toLocaleString` / `TZ` 分桶**：portability-audit §1.7 已标未验证，本文未重测。

**一句话**：能确证的是「载荷正文跨平台安全」+「两个 pathKey 已加守卫」；
**`--plugin-dir` 与 hook 的 Linux 行为仍然是 T0，一个字都别当结论引。**

---

## §6 六个具体失败场景

每条都是可执行的操作序列。

### F1（最严重）「装上了，但闸门从来没拦过」——PATHEXT

1. 应用用「干净环境」spawn `claude`（这是最佳实践，很多 wrapper 都这么做）。
2. 环境里没有 `PATHEXT`（Windows 上只要不是从完整 shell 继承就会缺）。
3. 载荷 hook 写 `node "${CLAUDE_PLUGIN_ROOT}/hooks/pre-write-gate.mjs"`。
4. **发生什么**：hook 一次都不触发；`claude` exit 0；目标文件正常写入。
5. **用户看到**：`result:"done"`，stderr 空，`plugin list` 说 `✔ loaded`。
6. **怎么才会发现**：只有加 `--debug-file` 并去 grep `[ERROR] Hook … error`。
   或者事后看 `tasks/runs/pre-write-gate/<date>.jsonl` 是空的——但那个文件在
   `dist/tasks/runs/` 下面（§3.3），没人会去。
7. **实测输出**：`nopathext2: exit=0 hookFires=0 gated=EXISTS`（A/B 各 2 次）。

### F2（最严重）「用户的 `/oversight` 不见了」——命名空间前缀

1. 应用 spawn `claude --plugin-dir <载荷>`，一切成功。
2. 用户按 `docs/GUIDE.md:279` 敲 `/oversight new`。
3. **发生什么**：slash 列表里只有 `overwatch:oversight`，`oversight` 不存在。
   `/oversight new` 不会被补全，也不是「命令不存在」的错误——它就是没有匹配。
4. **用户看到**：输入框里一个没有任何补全的字符串；他回车会被当成一句普通的话发给模型。
5. **怎么才会发现**：几乎不会。除非用户去 `/help` 里逐条找，或读 init 消息的 `slash_commands`。
6. **实测**：`slash_commands` 51 项，`filter(/oversight/)` = `["overwatch:oversight"]`，
   `includes("oversight")` = `false`。
7. **根因不是 bug，是语义**：plugin 里的 skill 一律前缀化。所以要么改文档、
   要么把 skill 放进 `.claude/commands` 之类不被前缀化的位置、要么让应用在
   system prompt 里告诉模型「入口叫 `overwatch:oversight`」。**本文不选，只指出**。

### F3「相对路径让宿主跑了用户项目里的同名脚本」

1. 载荷 hook 写 `node scripts/pre-write-gate.mjs`（很自然，因为仓库里就是这么写的）。
2. 用户在 `D:\foo` 里有一个自己的 `scripts/pre-write-gate.mjs`（同名不同物）。
3. **发生什么**：hook 进程的 cwd 是 `D:\foo`，Node 解析到**用户那个文件**并执行它。
   它 exit 0 → 宿主认为 hook 通过 → 写入放行。
4. **用户看到**：什么都没发生。他的脚本被一个陌生进程调用了一次，副作用未知。
5. **怎么才会发现**：他如果给那个脚本加了日志，会看到诡异的调用记录。
6. **实测**：`Cannot find module '…\\ow-outside-proj\\scripts\\pre-write-gate.mjs'`（不存在时）；
   我在用户项目里放了同名文件后，它被执行了。

### F4「CI 全绿，发布的载荷根本装不上」

1. 开发者改 `.claude/agents/oversight-critic.md`，忘了跑生成器。
2. 提交，CI 跑 `check-structure` + `node --test`，**全绿**（因为 CI 不生成、不挂载载荷）。
3. 发版。
4. **发生什么**：用户拿到的载荷和仓库里的 agent 定义不一致——或者根本没有载荷
   （`dist/` gitignored，`git archive`/`npm pack` 都不带它）。
5. **用户看到**：应用起 `claude` 时 `--plugin-dir` 指向一个不存在的目录。
   `plugin list` 会说 `✘ Path not found`（这一格是响的），但如果应用没检查，
   模型就只是在没有任何 `oversight-*` agent 的情况下跑。
6. **怎么才会发现**：只有当应用实现了 §1.4 那套 `plugin list` 断言时才会。
   今天没有任何测试覆盖「载荷能被宿主加载」：`grep plugin-dir scripts/*.test.mjs` → 只命中一句注释。
7. **实测**：干净导出上 `--check` → `✘ 载荷目录不存在：dist/payload`，exit 1。

### F5「用户自己有个叫 overwatch 的 plugin」

1. 用户从某个 marketplace 装了 `overwatch@something`，里面有 `oversight-critic` 等 agent。
2. 应用同时挂自己的 `--plugin-dir`（plugin name 也叫 `overwatch`）。
3. **发生什么**：两个 plugin 都 `✔ loaded`，但同名 agent 只保留一份——
   实测**我们的那份赢**，与 `--plugin-dir` 顺序无关（两种顺序工具集都是我们的 4 个工具）。
4. **用户看到**：两个 plugin 都显示 loaded，`/agents` 里只有一份 `overwatch:oversight-critic`，
   但它是**我们的**，不是他以为的那个。
5. **怎么才会发现**：几乎不会。他只会觉得「我那个 plugin 的 agent 好像不太对劲」。
6. **这条说明**：`plugin.json` 里的 `name` 是个全局命名空间，选一个通用词（`overwatch`）
   等于宣告跟所有同名者冲突，且我们赢。**应改成不容易撞的名字。**

### F6「用户开了 safe-mode / bare，载荷整体消失」

1. 用户遇到某个问题，照着 `--help` 的建议加 `--safe-mode`（"useful for troubleshooting"），
   或者他的 wrapper 默认加了 `--bare`。
2. **发生什么**：`--safe-mode` 下 init 消息 `agents` 只剩
   `["claude","claude-code-guide","Explore","general-purpose","Plan"]`——
   **12 个 `overwatch:*` 全部消失，skills 里也没有 `overwatch:oversight`**，
   slash_commands 里没有它。`--bare` 更狠：hook 也不触发（`hookFires=0`）。
3. **用户看到**：一切正常启动。应用以为自己在监督一个编队，实际上编队不存在。
4. **怎么才会发现**：不会。除非应用在 spawn 之后检查 init 消息（`stream-json` 的
   `subtype:"init"` 里有 `agents`/`skills`/`plugins` 三个字段——**这是唯一可靠的运行期自检点**）。
5. **实测**：`--safe-mode` → agents 无 `overwatch:*`；`--bare` → `exit=0 hookFires=0`。
6. **产品含义**：如果应用要 spawn `claude`，它必须传 `--output-format stream-json`
   并**断言 init 里的 `plugins` 含自己**，否则 F1/F4/F6 全部无法检出。

---

## §7 没测的 / 不能当结论的

1. **Linux / macOS 一行未跑**。§5.2 五条全是静态分析或推测。
2. **干净登录态下的 `--plugin-dir`**：本机没有 `oauthAccount`，所有需要真推理的用例
   都走本地 stub 上游（只验 hook/agent 装载，不验模型行为）。
3. **`--plugin-dir` 的未来版本**：本机只有 2.1.270 / 2.1.289 / 2.1.308 三个二进制，
   2.1.286 目录为空。无法给出「语义在哪个版本变过」的时间线。
4. **hook 的 5 秒预算与两倍扇出叠加**（§2.4）：用户 hook + 我们的 hook 同时跑时谁被 kill，
   未测。
5. **`maxTurns` / `omitClaudeMd` 在 plugin agent 上是否生效**：我测到 `tools:` **生效**
   （restricted agent 只拿到 `Read`），但 `maxTurns`/`omitClaudeMd` 未构造可判定用例。
   这三个字段都写在仓库的 12 个 agent 里，**其中两个是未验证的**。
6. **zip 载荷的 hook 展开**：实测 zip 形态 hook 触发 1 次、能拦（`fires=1 gated=EXISTS`），
   但 zip 只适用于发布包形态，与「同源」无关，未深挖。
7. **`--plugin-dir` 的 arity 有个反直觉行为**：`--help` 写 `(repeatable: --plugin-dir A --plugin-dir B.zip)`，
   实测空格分隔的 `--plugin-dir A B` 会把 `B` 当**值**吃掉（后续 `plugin list --json` 报
   `unknown option '--json'`）。**必须重复写 flag，不能空格并列。** 这条已确认，写在这里
   免得被当成「未验证」。

---

## §8 如果上面某条错了，什么证据能推翻它

1. 在**第二台机器**（干净 Windows、无本机插件市场缓存）上，`--plugin-dir` 指向同一份载荷，
   `plugin list --json` 找到且 `errors` 为空 → 我对「静默盲区」的严重性高估了。
2. 在 Linux 上跑 §3.4 那一组（坏 hooks.json / 相对路径 / 缺 import），
   任何一个能给出非零退出码或 stderr → §3.4「四道检查全绿」错。
3. 在宿主的某个版本上 `/oversight`（无前缀）出现在 `slash_commands` → §2.3 错。
4. 把 `plugin.json` 放进 `.claude/` 后，宿主在本仓 cwd 下开始按 plugin 布局读
   （即 12 个 agent 变成 `overwatch:*`）→ §4.2 的「两种身份互不干扰」错。
5. CI 里加一步 `claude --plugin-dir .claude plugin list --json` 并断言通过
   → §4.1「CI 测不到载荷可用」不再成立（但那是修了，不是我错了）。

---

## §9 给决策者的六行

```
① 最危险的失效不是「flag 没了」（那会 exit 1），是「flag 在、hook 不触发」。
   PATHEXT / safe-mode / 相对路径 / 缺 import 四种形态，实测全部 exit 0 且文件照样落盘。
   唯一的运行期自检点是 stream-json init 里的 plugins/agents，必须断言。

② `--plugin-dir` 有文档、无兼容承诺、无 experimental 标记，2.1.270→2.1.308 都在。
   移除是响的，语义漂移是静的。ADR §6 的「无法在 doctor 里检出」要改成
   「只有主动跑 plugin list 且逐项断言才检得出」——而且它 4.4 秒，塞不进 1000ms 预算。

③ hooks 的路径问题有解（${CLAUDE_PLUGIN_ROOT} 实测有值），但代价是 6 个文件的 import 闭包，
   少一个就静默归零。ADR 把 hooks 排除出载荷是对的，本文证实它对。

④ 「同源」的第三条路是：plugin.json 放进 .claude/ 里。一个目录两种身份，
   实测 12 agent + 1 skill 全加载、validate --strict 过、结构硬门不红。零生成、CI 可测。

⑤ 装载成功 ≠ 用户能用：/oversight 变成 overwatch:oversight，GUIDE.md 里那两条命令静默失效。
   这条比所有 hook 问题都更容易咬到第一个陌生用户。

⑥ 六个场景里最严重的两个：F1（闸门从不触发，四道检查全绿）与 F2（/oversight 消失）。
   前者让「应用性」的第一条腿断掉，后者让用户以为产品没做出来。
```
