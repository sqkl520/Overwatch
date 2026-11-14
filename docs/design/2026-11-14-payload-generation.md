# plugin 载荷生成：从 `.claude/` 到可分发的 `--plugin-dir` 载荷

> **状态：已实现（`scripts/build-payload.mjs` + 37 条测试）。**
> 本文回答 ADR-0003 §5.2 那个两难：「两份形态一旦漂移，漂移的那份没人测」。
> 与前几份 design 文档不同，这一份描述的是**已经能跑的东西**，含四个实测问题的答案。

## 0. 问题：一个真源，两种布局

ADR-0003 把 `.claude/agents/*.md` 与 `.claude/skills/` 定成应用的**运行时载荷**。同一个还在仓库里
服务另一件事：贡献者在本仓开 Claude Code 时，宿主按**项目布局**自动加载它们。

而 `--plugin-dir` 要的是**plugin 布局**。这两种布局**不是一回事**，实测：

```
# 把仓库根直接当 --plugin-dir 传进去（cwd 是一个无关目录）
$ claude --plugin-dir <仓库根> plugin list
Session-only plugins (--plugin-dir / --plugin-url):
  # （空 —— plugins = [])
# init 消息里 agents = ["claude","Explore","general-purpose","Plan", …]，没有 oversight-*
```

于是只要用户跑的载荷是「另外抄一份」，就存在两份真源；而**漂移的那份没人测**。
本仓已经吃过这个亏：同一个「已读」问题曾出现三份判据，其中两份漂移。

## 1. 选的方案：A —— 生成，不维护

`dist/payload/` 是**构建产物**，永不入库（`.gitignore` 有 `dist/`）。由
`scripts/build-payload.mjs` 每次从 `.claude/` 生成。真源只有一份。

四个候选逐个判，判据都是实测而不是偏好：

| 方案 | 判 | 理由 |
|---|---|---|
| **A. 生成，不维护** | **选它** | 真源唯一；`--check` 能在漂移时报红；不需要管理员权限；不动 `.claude/`（本仓自用零变化） |
| B. 以 plugin 布局为真源，`.claude/` 变成生成物 | 否 | 实测根目录的 `agents/` **不会**被当项目布局加载（`--print` 的 init 里 agents 清单没有它）。选了 B，本仓自己就不能用了 —— 那正好是 ADR-0003 §6 的反悔信号 3 |
| C. 软/硬链接 | 否 | 本机 `core.symlinks=false`。实测：把一个软链接 `git add` 后 clone 出来，它变成 **9 字节的普通文本文件**，内容是链接目标（`real/x.md`）。静默失效，且跨平台不可靠 |
| D. 检查器（用测试证明两份相等，不生成） | 否 | 它要求两份都存在于磁盘上，而「手抄的第二份」正是要消灭的东西。检查器只能发现漂移，不能消灭它 |

**A 的代价要写清**：「什么时候生成」需要一条约定。本文件给出的约定是
`--check` 是硬门的一部分（可以由 CI / 提交前跑），没重建就红 —— 而不是「记得生成」。

## 2. 四个实测问题

环境：Windows，`claude` 2.1.289 / 2.1.308 各验过，cwd 一律是一个与仓库无关的临时目录
（避免项目级 `.claude/` 干扰）。最小 plugin 二分法：每轮只改一个变量，用
`claude plugin validate` 的退出码与 `plugin details` 的组件清单判。

### 2.1 plugin 布局到底要什么

| 组件 | 位置 | 必填 / 约束 | 证据 |
|---|---|---|---|
| 清单 | `.claude-plugin/plugin.json` | **只有 `name` 是硬必填**。缺 `name` → `✘ Invalid input: expected string, received undefined`，exit 1 | 只填 `{}` / 只填 `version` 两组都报同一条 |
| | | `version` / `description` / `author` 缺了只是 **warning**，exit 0；但 **`--strict` 把 warning 当错误**，exit 1 | `{"name":"x"}` → 普通 0 / strict 1；四字段齐 → 0 / 0 |
| | | **未知字段在 `--strict` 下判红**（`x-overwatch: Unknown field`） | 加一个 `x-overwatch` 即红 |
| agents | `<plugin根>/agents/*.md` | **只认一层**：`agents/sub/x.md` 不进清单 | `agents/top-agent.md` + `agents/sub/nested-agent.md` → `Agents (1) top-agent` |
| | | 清单里显示的是**文件名**（`file-name`），实际注册名取 **frontmatter 的 `name`**（`declared-name`） | 文件名与 name 故意不同，`plugin details` 显示前者、init 消息里是 `amis:declared-name` |
| skills | `<plugin根>/skills/<名>/SKILL.md` | **必须是「目录 + SKILL.md」**，`skills/*.md` 平铺不被识别 | 平铺 `flat-skill.md` + 目录 `a/SKILL.md` 同测 → `Skills (1) a` |
| | | 目录名不必等于 frontmatter `name`（清单显示目录名，注册名用 frontmatter `name`） | `aaa/SKILL.md` 里 `name: frontmatter-name-aaa` → 清单 `aaa`，init 里 `sorder2:aaa` |
| hooks | `<plugin根>/hooks/hooks.json` | **必须包在 `"hooks"` 对象里**，与 `settings.json` 同一字段形状。顶层直接写 `PreToolUse` → **校验失败**（不是警告） | 两种写法各跑一次；报错原文：「PreToolUse/PermissionRequest is declared at the top level, outside the "hooks" object」 |
| commands | `<plugin根>/commands/*.md` | 也认，且它们会进 `skills` 清单（`cmds:probe-cmd`） | `commands/probe-cmd.md` → `Skills (1) probe-cmd` |

另外两条本生成器用到的实测：

- **额外文件无害**：载荷里放一个 `payload-manifest.json`（宿主不认识的 json），
  `plugin list` 仍 `Status: ✔ loaded`，`--strict` 也过。所以自证信息可以放在同级，不必进 `plugin.json`。
- **`--plugin-dir` 可以指向「一堆 plugin 的父目录」**：`--plugin-dir /tmp/pdir`（下面有 `p1/` `p2/`）
  会把两个都加载。所以载荷目录本身必须是 plugin 根，不能是 plugin 根的父目录。

### 2.2 plugin 的 agent 与项目 `.claude/agents` 同名时会怎样

**不覆盖、不并列成两个可同名调用的东西、不报错 —— plugin 的自动加 `<plugin名>:` 前缀。**

在 `/tmp/collproj` 里放一个项目的 `.claude/agents/probe-agent.md`（回 `PROJECT_WINS`），
plugin 里也有一个同名 `agents/probe-agent.md`（回 `PLUGIN_WINS`）：

```
init agents = ["claude", …, "p1probe:probe-agent", "Plan", "probe-agent", "statusline-setup"]
              └─ plugin 的（带前缀）                              └─ 项目的（裸名）

--agent probe-agent            → PROJECT_WINS   （命中项目那份）
--agent p1probe:probe-agent    → PLUGIN_WINS    （命中 plugin 那份）
```

**对产品的含义（好消息）**：本仓自用**不会**被自己的载荷干扰。贡献者在本仓开 Claude Code，
`.claude/agents` 照旧以裸名加载，`--agent oversight-acceptor` 走的还是仓库里那份。
用户跑应用时挂载荷，得到的是 `overwatch:oversight-acceptor`，两者可以同时在场。

**对生成器的含义**：载荷**不需要**改 agent 名去避让。改写正文或 frontmatter 就等于开始
「生成第二份内容」，正是要防的漂移。所以生成器只做**复制**，逐字节不改
（`build-payload.test.mjs` 有一条断言守这个）。

真跑一次生成的载荷在无关目录下的清单：

```
agents = ["claude","Explore","general-purpose",
          "overwatch:oversight-acceptor", …共 12 个…, "Plan","statusline-setup"]
skills = [ … , "overwatch:oversight" ]
plugins = [{"name":"overwatch","source":"overwatch@inline","version":"0.0.0+g2f6513f71576"}]
```

且 `--agent oversight-acceptor`（裸名）在**无关目录**里能解析到载荷那份 —— 没有同名项目 agent 时，
裸名就是唯一的那个，宿主会回退匹配。

### 2.3 plugin 里的 hooks 怎么声明，和 `.claude/settings.json` 是同一套字段吗

**字段是同一套，但有两个 plugin 专属的差异，两个都必须在实测里踩到。**

1. **形状**：`.claude/settings.json` 的 `hooks` 段直接放在 settings 根下；plugin 的
   `hooks/hooks.json` 也要求同形 —— 但**根下必须再包一层 `hooks` 键**（见 2.1 表）。
   顶层裸写 `PreToolUse` 会让整个 hook 文件不被应用。
2. **`${CLAUDE_PLUGIN_ROOT}` 只在 plugin 上下文里有值**。实测同一份 `hooks.json` 内容：

| 挂法 | `CLAUDE_PLUGIN_ROOT` | 命令能否只写相对路径 |
|---|---|---|
| `--plugin-dir <dir>` | `C:\…\hprobe`（有值） | 能 |
| `--settings <同一个文件>` | **`null`** | 不能，必须写绝对路径 |

3. **hook 真的会触发，且能真拦**。一个最小 `PreToolUse → Write` hook 返回
   `permissionDecision: "deny"`：

```
prompt: "Create denied.txt containing HELLO"，--permission-mode acceptEdits
stdout 里出现 3 次 "OW_PAYLOAD_PROBE: deny works from plugin hook"（deny 理由三次回到模型）
文件 denied.txt：不存在  ← 真的没落盘
```

同一条在 `--settings` 下也复现（`w2.txt` 不存在、reason 回到模型）。两个挂法都能真拦。

#### 于是有一个必须写下来的决定：**载荷里不放 hooks**

plugin 里的 hook 命令要写 `${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs`，这就要求载荷把
**脚本及其整条 import 闭包**一起带走。实测踩到过：只拷 `pre-write-gate.mjs`，它在
`claim-ledger.mjs` → `verify-claims.mjs` 那一跳断掉：

```
[Hook PreToolUse:Write] ERR_MODULE_NOT_FOUND: Cannot find module
  …\owproto\scripts\verify-claims.mjs  imported from …\owproto\scripts\claim-ledger.mjs
```

而 `claude` 的**退出码仍是 0**、文件照常落盘 —— 静默失去介入能力。把 `scripts/*.mjs`
整目录拷进去能跑（实测 `would-deny` 记账正常），但那等于把「应用的实现」也塞进载荷：
ADR-0003 §3.2 说得很清楚，`.claude/` 那层是**载荷**，不是产品本体。

所以本生成器的结论是：**hooks 属于应用行为，由应用在 spawn 时用 `--settings` 带上自己的
绝对路径**（实测这条路能真拦住），不属于这份 markdown 载荷。载荷只产 agents + skills。
测试里有一条断言 `dist/payload/hooks` **不存在**，防止有人日后顺手加回去。

### 2.4 `--plugin-dir` 能不能多次传，能不能和用户自己的 plugin 共存

**都能。**

```
$ claude --plugin-dir /tmp/p1probe --plugin-dir /tmp/p2probe plugin list
Installed plugins:
  ❯ taste-skill@taste-skill     ← 用户自己装的，Scope: user，✘ disabled
Session-only plugins (--plugin-dir / --plugin-url):
  ❯ p1probe@inline              Path: …\p1probe   Status: ✔ loaded
  ❯ p2probe@inline              Path: …\p2probe   Status: ✔ loaded
```

- 多次传：两个都在，各自独立 `loaded`。
- 与用户 plugin 共存：用户装上的是 `Scope: user` 那一档，`--plugin-dir` 的是 `Scope: session`。
  两档并列显示，互不顶掉。init 消息的 `plugins` 数组里，载荷是 `overwatch@inline`，
  用户的是 `xxx@xxx`，builtin 的是 `@builtin`。
- 传一个**父目录**也成立（2.1 最后一条），但本项目不用这种形式 —— 生成的载荷目录本身就是 plugin 根。

## 3. 实现

```
scripts/build-payload.mjs         唯一生成器（零依赖）
  summarizeSources(root)          扫 .claude/ → 载荷文件清单；布局不对就攒 problems
  payloadDigest(rows)             内容摘要（只吃 <sha256>+源路径，不吃 mtime / 绝对路径 / git）
  pluginManifest(digest)          plugin.json 的四个字段
  pluginManifestBytes(digest)     固定字节形态（LF / 两空格 / 结尾换行）
  planPayload({root})             读源、算哈希、算摘要，不写盘
  buildPayload({root,out})        先 rmSync 目标目录，再写；源有问题则一件都不写
  checkPayload({root,out})        七条判据，不写盘
  parseArgv / main                CLI（`parseArgv` 刻意不叫 `parseArgs`：结构硬门的探针表按名命中所有模块）
```

产物（真跑一次，`node scripts/build-payload.mjs`）：

```
dist/payload/
├── .claude-plugin/
│   └── plugin.json
├── agents/
│   ├── oversight-acceptor.md
│   ├── oversight-critic.md
│   ├── oversight-executor.md
│   ├── oversight-planner.md
│   ├── oversight-probe.md
│   ├── oversight-redteam.md
│   ├── oversight-relay.md
│   ├── oversight-repair.md
│   ├── oversight-research.md
│   ├── oversight-resolution.md
│   ├── oversight-review.md
│   └── oversight-safety.md
├── payload-manifest.json
└── skills/
    └── oversight/
        └── SKILL.md
```

`plugin.json`：

```json
{
  "name": "overwatch",
  "version": "0.0.0+g2f6513f71576",
  "description": "OmniSight 运行时载荷：oversight-* 角色定义与 oversight 调度 skill。由应用在起 claude 时用 --plugin-dir 挂载，不是给用户装进自己项目的插件。",
  "author": { "name": "overwatch" }
}
```

`claude plugin list` 对生成物（cwd 是无关目录）：

```
Session-only plugins (--plugin-dir / --plugin-url):
  ❯ overwatch@inline
    Version: 0.0.0+g2f6513f71576
    Path: <仓库根>/dist/payload
    Status: ✔ loaded
```

`claude plugin details overwatch`：`Skills (1) oversight` / `Agents (12) oversight-*` /
`Hooks (0)` / `MCP servers (0)`，`Always-on: ~480 tok`。`validate --strict` 通过。

### 3.1 版本号为什么是 `0.0.0+g<摘要12位>`

- semver 的 build metadata 段，实测 `validate --strict` 接受（`0.0.0+g…`、`0.0.0+g….dirty`、`0.0.1-dev.g…` 都过）。
- **刻意不取 git commit**：那样每提交一次 `--check` 就红一次，而源一个字节没变 —— 红得没道理，
  久了就没人看红。取内容摘要则满足「同一份源 ⇒ 同一份载荷 ⇒ 同一串版本」，构建可复现
  （测试有一条：连产两次逐字节相同）。
- **这不是产品版本号。** ADR-0003 §4 的第一条缺口（没有版本与升级）**仍然没被补上**。
  等仓库有了 `VERSION` 或 `package.json`，`pluginManifest()` 应当优先读它，不再用内容摘要冒充版本。
  本文件不伪造那一步。

### 3.2 同源怎么保证：`--check` 的七条判据

`node scripts/build-payload.mjs --check`，只读，exit 0 = 同源 / 1 = 漂移。
七条各对应一类真实事故：

| # | 判据 | 防的是 |
|---|---|---|
| 1 | 载荷目录与 `payload-manifest.json` 存在且可解析 | 「同源」无从谈起 —— 从没建过，或不是本生成器产的 |
| 2 | 清单自洽：`sourceDigest` == 按它自己的 `files` 表重算的值 | 有人手改清单的摘要去迁就漂移 |
| 3 | **源现在的摘要 == 清单里的摘要**（并且点名哪个源文件新增/改动/删除） | 「源变了但载荷没重建」—— 本生成器的主要用途 |
| 4 | 载荷里每个文件在、长度对、**哈希对** | 载荷被改 / 被截断 / 被换掉 |
| 5 | 载荷里**没有**清单外的文件 | 有人手工往载荷里补东西 —— 这就是第二真源的开头 |
| 6 | `.claude-plugin/plugin.json` 字节 == 重新算的；四字段齐；无未登记字段 | 版本号与内容脱钩；字段会让 `--strict` 判红 |
| 7 | 源树自身无布局问题（agents 子目录 / skills 平铺 / 缺 `SKILL.md`） | 「生成了但宿主不认」—— 静默少件 |

另外还查 `payloadVersion` 与 `generator`：换了生成器或改了载荷格式要求重建。

负向证明（`build-payload.test.mjs` 的第 4 组，10 条）：改源不重建 → 红并点名文件；删源 → 红；
改载荷一个字节 → 红；往载荷塞文件 → 红；手改清单摘要 → 红；连 files 表一起伪造 → 仍红
（`plugin.json` 版本那条）；plugin.json 加未知字段 → 红；载荷缺文件 → 红；目录不存在 → 红。

**「改动后的负向测试」为什么必须做**：这七条里任何一条删掉，正向用例都还会绿 ——
只有把「伪造」造出来才看得见它是否真在判。这是本文件测试的主要篇幅所在。

## 4. 边界：这份载荷**不**做什么

- **不声明 hooks**（见 2.3）。hooks 由应用在 spawn 时用 `--settings` 带。
- **不改写 agent 正文或 frontmatter**。只复制。改写 = 第二真源。
- **不带 `scripts/`**。载荷只含 markdown 与清单。
- **不产版本号**。`0.0.0+g…` 是内容摘要，不是产品版本（§3.1）。
- **不入库**。`dist/` 在 `.gitignore` 里，理由见该条注释。
- **没做的**：`overwatch.mjs` 里还没有一个命令真的去 spawn `claude --plugin-dir <载荷>`。
  本文件只保证「载荷能被生成、能自证同源、宿主真的加载它」，把载荷接到应用的推理腿
  （ADR-0003 §2.2 的 `claude -p`）是下一步，不在本次范围。

## 5. 未验证

| 事项 | 状态 |
|---|---|
| macOS / Linux 上 `--plugin-dir` 的布局契约是否完全一致（大小写、路径分隔符） | **未验证**。本机只有 Windows |
| `plugin details` 的 token 估算是否随模型版本变化 | **未验证**。`~480 tok` 是本机 2.1.289 的一次读数 |
| plugin 之间的 agent 重名（两个 `--plugin-dir` 各有 `oversight-acceptor`）谁胜 | **未验证**。只测了「plugin vs 项目」 |
| 干净登录态下 `claude -p` + 载荷 + hook 三者同时工作的完整链路 | **未验证**。本机认证走宿主凭据（ADR-0003 §2.2） |
