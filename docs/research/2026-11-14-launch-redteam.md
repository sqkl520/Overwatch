# 红队：`overwatch.mjs launch` 会把什么弄坏

- 日期：2026-11-14
- 作者：红队 Agent L2（立场：在这个 wrapper 被写成代码之前找出它的失效面，不是来帮它上线的）
- 产出形态：`exploration`（结论报告，零行改现有文件）
- 实测环境：Windows 11 / Git Bash / Node v26.12.1 / `claude` CLI **2.1.289**；
  本机**无独立 Anthropic 登录**（`claude auth status` → `loggedIn:false, authMethod:"none"`，exit 1）
- 探针：`.tmp-analysis/launch-redteam/`（仓内）与独立 fixture 目录 `%TEMP%/ow-launch/`（**仓外**，见 §0.1）
- 证据等级：T2/T3（本机实跑，命令与输出随文）；跑不出来的进 §7

> **本文不修任何东西。** 上一轮同事（`2026-11-14-plugin-payload-redteam.md`）攻的是「载荷怎么坏」；
> 本文攻的是**多出来的那一层 wrapper**：它自己怎么坏、它让用户的什么静默失效、它值不值得存在。

---

## §0 七行裁定

```
① --settings 是【合并】，不是覆盖。用户 hooks 一条不少（三源扇出实测 3/3 全触发）。
   但【标量键会覆盖】：model / permissions.defaultMode / env 同名键被应用值顶掉。
   用户项目里写了 defaultMode:"plan"，挂上应用的 --settings 后实测变成 acceptEdits，文件当场落盘。
   ——「静默解除用户的只读意图」是本轮最重的一条，且和「hooks 兵分三路」是同一份实测的两个面。

② roster 是【假承诺】。grep 全仓：agent.roster 只被 question-audit.mjs 校验形状，
   没有任何代码读它去选 agent。而 --plugin-dir 只能整个目录挂，12 个 agent 无条件全上。

③ 四条「只有 wrapper 能做」的事，实测只有 1.5 条站得住。其余用户一行命令就能做，
   且其中一条（hooks）用户自己配反而更安全——因为是显式写进自己 settings 的。

④ 未登录机器上：doctor / scan / verify / tui / watch 全部可用；launch 起得来（TUI 正常显示），
   但第一个回合挂住 → 重试 9 次 → 报 API error。**launch 不是「不能用」，是「看起来能用」。**

⑤ 退出码不可传递。宿主在认证失败时 exit 1 但 subtype:"success"；在 base_url 不可达时
   实测挂 90 秒不返回；交互式未认证时重试 9 次而不是退出。wrapper 无法把这四种分辨成不同码。

⑥ wrapper 若用「干净环境」spawn（最佳实践），PATHEXT 缺失让 hooks 静默归零（同事已测）；
   本轮新增：用户项目自己的 disableAllHooks:true 也能让应用的 --settings hook 一起哑掉，
   而 claude 仍 exit 0、is_error:false、文件照写。**用户的一个合法设置能废掉应用的全部介入能力。**

⑦ 结论：这个 wrapper 的【必要性被高估】。建议不做 launch，或只做 §5.3 里那 1.5 条的唯一形态。
```

### §0.1 一个必须先说的方法论更正

我第一轮把 fixture 建在**仓库内部**（`.tmp-analysis/launch-redteam/proj-*`），结果所有用例里
claude 都自动加载了 `<repo>/.claude/agents` 的 12 个 agent——因为 cwd 在仓内，
宿主按**项目布局**读到了它们。那一轮「--settings 覆盖了用户的 hook」的结论是**假的**，
成因是同一个 stub 的回合被前一个用例吃光了。

搬到仓外（`%TEMP%/ow-launch/`）并**每个用例起一个新的 stub** 之后，结论翻转。
这条写在这里，因为本仓已经吃过一次「一份 MSIX 影子目录冒充现场」的亏
（`2026-11-04-watcher-silent-failure.md`）；我这次犯的是同一类错，方向反过来：**测试台污染了被测物**。

---

## §1 认证：这条路的真实边界

### 1.1 `-p` 与交互式，失败形态完全不同（实测）

| 形态 | 未登录时 | 退出码 | 耗时 |
|---|---|---|---|
| `claude -p "hi"` | stdout `Not logged in · Please run /login` | **1** | ~0.9 s |
| `claude -p "hi" --output-format json` | `is_error:true, subtype:"success", result:"Not logged in · Please run /login"` | **1** | ~0.8 s |
| `claude "say OK"`（交互式，真有 TTY） | TUI 正常启动，`Opus 5 with max effort · API Usage Billing` | — | 启动 <2 s |
| 同上，发一个回合 | `✻ Perusing…` 转 40 s+，然后 `API error · Retrying in 0s · attempt 2/9`，最终 `524 upstream_error · attempt 3/9` | **永不自己退出** | 实测 >4 分钟 |
| `claude "say OK"`（无 TTY，stdio 管道） | stdin 挂 3 s 后 `Not logged in` | 1 | ~3 s |
| `-p` + `ANTHROPIC_BASE_URL` 指向不可达端口 | 零输出，**挂 90 秒不返回** | 未返回 | >90 s |

**关键差异**：`-p` 是**响的**（exit 1 + 一行明确文案），交互式是**静默的**（起得来、看着正常、第一个回合挂住并重试 9 次）。
ADR-0003 §2.2 记的「缺 `CLAUDE_CODE_HOST_AUTH_ENV_VAR` → 挂起 75 秒零输出」是**第三种**形态，与这两者都不同。

**产品含义**：`launch` 走的是交互式。**它的认证失败形态是本报告里最坏的一种**——用户看到一个能用的界面，
发一句话之后转圈，转两分钟才看到一句 `API error`。而同一台机器上 `claude -p` 会立刻说清楚。

### 1.2 未登录机器上，这个应用能做什么、不能做什么（明确清单）

逐条实测，不是推断：

| 能力 | 未登录时 | 证据 |
|---|---|---|
| `overwatch` / `doctor` | **可用**，exit 0 | 去掉三个认证变量后跑，七项全读到，`code=0` |
| `scan`（读 transcript 判态） | **可用** | 纯读文件，不碰网络 |
| `verify`（断言 vs 证据） | **可用** | 同上 |
| `tui`（面板） | **可用** | 同上 |
| `watch` / `--inbox` / `--health` | **可用** | 同上（通知通道与本机 Toast 可用） |
| 写前闸 hook（`pre-write-gate.mjs`） | **可用且能真拦** | 纯本地进程，不碰网络 |
| `claude plugin list` / `plugin validate` | **可用**（不需要认证） | 两者 exit 0，2.5–2.7 s |
| **`launch` 起的会话** | **起得来，干不了活** | TUI 正常，第一回合挂住 → 9 次重试 → `API error` |
| **任何需要模型的功能**（接力草稿、跨会话总结、派发 agent） | **不可用** | 全都要 spawn `claude -p` |

**所以答案是**：这个应用在未登录机器上**不是废的**——五条主功能里四条（观测/判定/介入/通知）一条都不需要推理，
ADR-0003 §2.3 那张表是对的。**但 `launch` 恰好是唯一必须登录才能用的那条腿的入口。**
把「用户必须已登录宿主」变成「用这个功能的前提」，与「给别人用不掉链子」并不矛盾——
矛盾的是**把 launch 当成默认入口**。默认入口必须是无条件可用的那个（doctor/scan/verify）。

### 1.3 `--dry-run` 缓解不了，因为宿主没有这个 flag

- `claude --help | grep dry-run` → **零命中**。`claude --dry-run` → `error: unknown option '--dry-run'`。
- 所以 `overwatch launch --dry-run` 只能测**应用自己拼的命令行**，测不到任何宿主行为。
- 它能验证的：路径存在、命令行语法、`auth status`。（后者实测可行，见 §1.4）
- 它**不能**验证的：hook 会不会触发、agent 会不会加载、模型认不认这个会话。前两项是同事那份报告的全部结论
  （四种形态全部 exit 0 且不触发），第三项未登录根本测不了。

**「能测的」与「能用的」之间的距离** = `--dry-run` 绿了但第一个回合挂死。这个距离就是 §1.1 那张表。

### 1.4 唯一诚实的认证检查：`claude auth status`

实测：未登录时 **exit 1**，已登录时 exit 0，且**不需要任何认证即可运行**（它读的是本地配置）。
JSON 里 `loggedIn` / `authMethod` 可直接断言。**这是 doctor 该加的第八项**，不是 launch 自己发明一套。

（注意：本机 `auth status` 在带宿主环境变量时也说 `loggedIn:false`——因为本机的推理是借
`host-creds-*.json` 的网关令牌，不属于任何「登录」。ADR-0003 §2.2 的第 2 句话因此再次成立：
**本机的「能用」是这台机器的状态，不是产品契约。**）

---

## §2 启动器本身就是新的失败面

### 2.1 四层，且每层的失败信号强度递减

```
应用 → (1) spawn claude → (2) 宿主加载载荷 → (3) 载荷里的 agent 被派发 → (4) agent 跑脚本
```

| 层 | 失败时用户看到 | 谁报错 |
|---|---|---|
| (1) `claude` 不存在 | `ENOENT`（wrapper 必须自己翻译成话） | 应用（若它检查 `error.code`） |
| (2) 载荷没加载 | **什么都没变** | 无人（同事 §1.4 已证 4 类静默） |
| (3) agent 没被派发 | 模型自己干活，用户看不出编队不存在 | 无人 |
| (4) 脚本挂了 | `hook error` 只进 `--debug-file` | 无人（除非加 `--debug`） |

**单向恶化**：越往深处，越静默。而 `launch` 恰好是唯一一个会把用户带到第 (4) 层的入口。

### 2.2 退出码：四种情况实测

| 情况 | 宿主退出码 | 能分辨吗 |
|---|---|---|
| 交互式正常退出（`/exit` 或 Ctrl-D） | 0 | 能 |
| 认证失败（`-p`） | **1**，但 `subtype:"success"`、`is_error:true` | 只能靠解析 JSON，退码不够 |
| 认证失败（交互式） | **永不退出**（重试 9 次） | **不能** |
| base_url 不可达（`-p`） | **不返回**（>90 s） | **不能** |
| 二进制不存在 | `spawnSync` → `status:null`, `error.code:'ENOENT'` | 能，但需要应用自己看 `error` |
| 未知 flag | 1 + `error: unknown option` | 能 |

**所以「wrapper 如实转达退出码」这句话在执行层面是空的**：交互式场景下宿主根本不会给出一个
「认证失败」的码——它给的是 `0`（用户自己退出）或永远不给。ADR-0003 §5.3 已记 `subtype:"success"`+`is_error:true`；
本轮新增**交互式这一格是「不退出」**，比那个更坏。

### 2.3 信号与孤儿进程（Windows 实测）

| 场景 | 结果 |
|---|---|
| wrapper spawn 子进程（默认 `detached:false`），SIGINT 给 wrapper | **子进程一起死**（Windows 上 Ctrl-C 发给控制台进程组） |
| wrapper **崩溃**（`taskkill /F`），子进程默认 | 子进程**跟着死** |
| wrapper 崩溃，子进程 `detached:true` | 子进程**活着，成为孤儿**（t+4s 到 t+10s 实测均 ALIVE） |

**结论**：Windows 上默认行为反而是安全的（进程组一起收）。**风险在 wrapper 主动用 `detached:true` 做后台启动**——
那时 wrapper 一崩，`claude` 会留着烧 token。这不是理论：本仓在遇到「零输出挂起」时的第一反应就是丢后台。

---

## §3 载荷与用户自己的东西冲突

### 3.1 `--settings`：**合并**，不是覆盖（这条是本轮最重要的实测）

三组 A/B，每次新起 stub，cwd 在仓外：

```
### 1 control: user project, no --settings
 exit=0 hookFires=1   FIRED {"src":"USERPROJ", ...}
### 2 app --settings on user project
 exit=0 hookFires=2   FIRED {"src":"APP", ...}      ← 应用的在
                      FIRED {"src":"USERPROJ", ...} ← 用户自己的也还在
### 3 app --settings on plain project
 exit=0 hookFires=1   FIRED {"src":"APP", ...}
### 4 plain project, no settings
 exit=0 hookFires=0
```

**再叠一个 plugin 里的 hook，三源全触发（`hookFires=3`：`USERPROJ` / `PLUGIN_HOOK` / `APP`）。**
所以「应用会把用户自己的 hooks 静默干掉」这个灾难**不成立**——hooks 段是**扇出合并**，
与同事 §2.4 的结论一致。

### 3.2 但**标量键被覆盖**：用户的 `defaultMode:"plan"` 被顶成 `acceptEdits`

这条是新发现，且比 hooks 那条严重。用户项目 `.claude/settings.json` 写着 `permissions.defaultMode:"plan"`（只读观察），
应用带一份 `--settings`（含 `defaultMode:"acceptEdits"`，而 `templates/pre-write-gate.settings.json` 的使用说明里
就要求用户在 headless 下用它）：

```
### A control: user plan mode, no app --settings
  permissionMode=plan          gated=blocked     ← 写被挡住了
### B user plan mode + app --settings acceptEdits
  permissionMode=acceptEdits   gated=WRITTEN     ← 文件落了
```

同一次 A/B 里 `model` 也从 `claude-opus-5-5` 变成了 `claude-haiku-4-5`（应用值赢）。
`env` 是**按键合并**（用户的 `OW_USER_ONLY` 与应用的 `OW_APP_ONLY` 都在，同名键应用赢）。

**逐键语义（实测）**：

| 键 | 语义 |
|---|---|
| `hooks`（按事件+matcher） | **扇出合并**，都跑 |
| `env` | **按键合并**，同名键应用值赢 |
| `model` | **覆盖** |
| `permissions.defaultMode` | **覆盖**（用户 plan → 应用 acceptEdits） |
| `permissions.deny` / `allow` | **保留**（用户 `deny:["Write"]` 在应用 `--settings` 下仍拦住写入，实测 blocked） |

**产品含义**：应用带 `--settings` 时必须**不带 `permissions.defaultMode` 和 `model`**，否则它在静默改写用户的安全姿态与花费。
这是「只用 wrapper 挂 hooks」唯一站得住的理由，也是它最容易做错的地方。

### 3.3 `--plugin-dir` 不影响用户已有的 plugin

- 两个 `--plugin-dir` 共存：`plugins=["plug-a","plug-b", ...]`，**两个都在**，顺序与 flag 顺序一致。
- 用户项目自己的 `.claude/agents/local-agent.md` 在挂载荷后**仍在**（`agents=["local-agent"]`，与 plugin 的
  `overwatch:oversight-*` 并存）。
- 同名时靠前缀区分：`oversight-critic`（项目版）与 `overwatch:oversight-critic`（载荷版）**同时出现**——
  与同事 §2.2 一致。用户 `/agents` 里会看到两个同名条目，**不会**被静默替换。
- **例外**：用户自己装了同名 plugin `overwatch` 时，**载荷版无条件赢**（同事 §2.5 已实测，本轮未重测）。

**所以 `--plugin-dir` 是加法的，不是破坏性的。** 冲突面在「视觉噪音」和「同名 plugin」，不在数据丢失。

### 3.4 `--agents <json>` 是唯一能精确控制装载集合的通道（实测）

| 方式 | 结果 |
|---|---|
| `--agents '{"probe-a":{description,prompt}}'` | `agents=["probe-a"]`，**只有它** |
| `--agents <路径>` | 同上（文件形态可用） |
| `--plugin-dir` + `--agents` | 两者**并存**（`["only-one","plug-a:shared-agent"]`） |

schema 实测（严格校验，写错就 exit 1）：

- `tools` 必须是**数组**：`tools:"Read, Grep"` → `Error: Invalid --agents configuration: probe-a.tools: Invalid input: expected array, received string`（exit 1）
- `description` **必填**：`{"x":{"prompt":"p"}}` → `expected string, received undefined`（exit 1）
- 未知字段**被静默忽略**（`bogusField` 不报错）——这与本仓「未知键必须报错」的纪律相反，不能靠它做校验
- 多行 `description` 可用；`model` 可传
- 把仓库 12 个 agent 的 frontmatter 转成 `--agents` JSON：**14,374 字节**，实测 12 个全部加载
  （命令行长度远低于 Windows 32k 上限，不需要临时文件）

**结论：roster 有实现路径，只是不是 `--plugin-dir`。** 但 `--agents` 有代价：
它**不给 skill**（`overwatch:oversight` 不会出现），也不给 plugin 的 version/来源标记。

---

## §4 roster 能不能只挂一部分

### 4.1 `--plugin-dir` 只能整目录 —— 这是 flag 的定义

`--help` 原文：`Load a plugin from a directory or .zip`。目录里的 `agents/*.md` 全部加载，
**没有过滤参数**。实测挂 `dist/payload`：12 个 agent 全部出现。

### 4.2 所以 `agent.roster` 现在是**假承诺**（可证）

```
$ grep -rn "roster" scripts/*.mjs | grep -v question-audit
（零命中）
```

全仓只有 `question-audit.mjs` 用它做**形状校验**（`unknown-role` / `bad-roster` / `duplicate-role`），
**没有任何代码读它去选择装载哪些 agent**。

文档侧的声称：

- `docs/spec/2026-11-14-question-audit.md:206`：`agent.roster`「启用哪些岗位」——**这句现在的执行语义是「校验通过而已」**
- `docs/design/2026-11-14-agent-roster-policy.md:24`：「**未启用的岗位，它负责的环节不执行。** 这是用户明确要的。」
- `overwatch.config.json` 里就写着 3 个角色

**一个用户把 roster 改成 `["oversight-executor"]`，`launch` 起来仍然加载 12 个。** 不报错、不提示。
这与本仓最恨的那类缺陷（`--days abc` 静默回落 7 天）是同一个形状，只是换到了配置面。

### 4.3 有没有别的实现方式：有，两个半

| 方案 | 能只挂一部分吗 | 代价 |
|---|---|---|
| `--agents <json>`（14 KB） | **能，精确控制** | 丢 skill；得自己维护 frontmatter→JSON 的转换（**又一份真源**） |
| 临时目录里只放 roster 里的 agent + manifest | **能** | 每次 launch 写临时目录；`${CLAUDE_PLUGIN_ROOT}` 与 skill 路径得跟着改 |
| `--plugin-dir` + `--agent <name>` | **不能** | `--agent` 只选**当前会话**用哪个，不限制可派发集合；实测 12 个仍全在 `init.agents` |

第三条我实测过：`--agents` 装 12 个 + `--agent oversight-acceptor`，`init.agents` 仍是 12 个。
**「只挂一部分」和「默认用哪个」是两件事**，别混。

---

## §5 这个功能真的需要吗

### 5.1 用户自己能敲的那一行

```bash
claude --plugin-dir <repo>/dist/payload --settings <repo>/templates/pre-write-gate.settings.json
```

**这两样用户今天就能做，不需要 wrapper。** 而且实测在未登录机器上 `--plugin-dir` + `plugin validate`
都能跑通，用户自己验证「挂上了没有」的能力和 wrapper 一样。

### 5.2 wrapper 多做了什么（逐项核查，只剩 1.5 条）

| wrapper 声称的价值 | 用户自己做得到吗 | 实测判定 |
|---|---|---|
| 拼 `--plugin-dir` / `--settings` | 做得到 | **不算价值** |
| 把 `<OVERWATCH_ROOT>` 替换成真实路径 | **做不到**（模板里是占位符） | ✅ **真价值 0.5 条**：实测把模板原样传给 `--settings`，hook 报 `Cannot find module '…\proj-plain\scripts\pre-write-gate.mjs'`，**exit 0、文件照写、`is_error:false`** |
| 保证 `PATHEXT` 在环境里 | 做不到（用户不会想到） | ✅ **真价值 0.5 条**（同事 §1.3 已证） |
| 让 `/oversight` 可用 | 做得到，但**一样拿不到裸名** | ❌ 两条路都前缀化成 `overwatch:oversight` |
| 配 roster | 做得到（`--agents`） | ❌ 见 §4 |
| 传 session 状态 / 台账 | **做得到**（都是读文件） | ❌ |
| 选模型、调预算 | 做得到（`--model` / `--max-budget-usd`） | ❌ |

**「只有 wrapper 能做」的只有两半条：占位符替换 + `PATHEXT` 保证。** 两者都是**一次性正确性问题**，
不是每次启动都需要 wrapper 参与的问题——它们可以变成「`doctor` 检查 + 文档写死」，
或者一次 `install` 写出一份**已替换占位符**的 settings 文件。

### 5.3 所以这个功能应该做成什么形状

如果一定要做，**只做那个 1.5 条**，不要做「启动器」：

1. `overwatch settings --write <path>`：把模板渲染成一份**绝对路径已替换**的 settings，落在应用状态目录。
   （用户从此可以自己 `claude --settings <那个文件>`，不需要 wrapper）
2. `doctor` 增一项「hook 能不能触发」：检查 `PATHEXT`、检查渲染后的文件存在、`auth status`。

**不要**：接管进程、转达退出码、做 `--dry-run` 假装验证、做后台启动。

---

## §6 五个具体失败场景

### F1（最严重）「用户的 plan 模式被应用静默解除」

1. 用户项目 `.claude/settings.json` 写 `permissions.defaultMode:"plan"`（他有意让 Claude 只读）。
2. 他跑 `overwatch launch`（应用带 `--settings`，里面有 `defaultMode:"acceptEdits"`——`templates/` 的说明就是这么教 headless 的）。
3. **发生什么**：`permissionMode=acceptEdits`，文件**当场落盘**。实测 A/B：control `blocked`，挂上应用后 `WRITTEN`。
4. **用户看到**：完全正常的一次会话。他甚至会以为 plan 模式还在。
5. **怎么才会发现**：几乎不会。除非他去看 `stream-json` 的 `init.permissionMode`，或者事后发现文件被改了。
6. **根因**：`--settings` 在标量键上是覆盖语义。**修法只有一个：应用的 settings 里不许出现 `defaultMode` / `model`。**

### F2（最严重）「挂上了，但闸门从来没拦过」——用户自己的一个设置就能废掉它

1. 用户项目里有 `{"disableAllHooks": true}`（一个完全合法的设置，用于临时关掉自己的 hook 调试）。
2. 应用带 `--settings` 挂自己的 hook。
3. **发生什么**：`hookFires=0`，文件**照写**，`exit=0`、`is_error:false`。实测两组：
   `disableAllHooks:true` → 0 次；`CLAUDE_CODE_SAFE_MODE=1` → 0 次。
4. **用户看到**：一切正常。应用以为自己在监督，闸门一次没跑。
5. **怎么才会发现**：只有 `--debug-file` 里的线索（而 `disableAllHooks` 那条连 ERROR 都不一定有）。
6. **这是同事 F1 的第二种触发源**：他证了「应用自己的环境」能废掉 hook；本轮证「**用户的配置**」也能。
   两者叠加意味着**任何只在 spawn 时断言一次的检查都不够**——必须在 `init` 消息里验。

### F3「用户以为自己配了 roster，12 个 agent 全在」

1. 用户把 `overwatch.config.json` 的 `agent.roster` 改成 `["oversight-executor"]`（设计文档明写「未启用的岗位不执行」）。
2. `question-audit` 校验通过（它是合法名字）。
3. 跑 `overwatch launch`。
4. **发生什么**：12 个 agent 全部加载。`init.agents` 里有 `oversight-planner`、`oversight-critic`… 全在。
5. **用户看到**：没有报错、没有提示。他会以为 planner 不会被派发。
6. **怎么才会发现**：去看 `init.agents`，或者发现 `oversight-planner` 居然在干活。

### F4「退出码说 0，会话其实一个 token 都没跑」

1. 用户在一台**装了 claude 但没登录**的机器上跑 `overwatch launch`。
2. TUI 正常起，他输入一句需求。
3. **发生什么**：`Perusing…` → 40 s 后 `API error · Retrying · attempt 2/9` → `524 upstream_error · attempt 3/9`。
   他按 Ctrl-C 退出 → wrapper 拿到 **exit 0**。
4. **用户看到**：一次「有点卡的会话」，退出码 0。CI 里这条会算成功。
5. **怎么才会发现**：只有他注意到屏幕上那句 `API error`。退出码、stderr、wrapper 的汇总全是干净的。

### F5（最轻，但最常见）「用户以为应用帮他挂好了 hook，其实模板占位符没替换」

1. 应用实现时把 `templates/pre-write-gate.settings.json` 原样传给 `--settings`（最自然的写法）。
2. 文件里 `"command": "node \"<OVERWATCH_ROOT>/scripts/pre-write-gate.mjs\""`。
3. **发生什么**：hook 进程 cwd = 用户项目，Node 解析 `<OVERWATCH_ROOT>/scripts/…` → `Cannot find module '…\proj-plain\scripts\pre-write-gate.mjs'`。
4. **用户看到**：`exit 0`、`is_error:false`、`result:"done"`、文件正常写入。**唯一线索在 `--debug-file` 里。**
5. **怎么才会发现**：不会。这条和同事 F3「相对路径让宿主跑了用户项目里的同名脚本」是同一根因的两面。

---

## §7 没测的 / 不能当结论的

1. **干净登录态下的交互式会话**：本机 `auth status` 是 `loggedIn:false`，所以「已登录时交互式会不会也重试 9 次」**未验证**。
   §1.1 里「重试 9 次」这一格是本机网关 524 造成的，**不能推广成「未登录时的通用行为」**。
   能确证的只有：**TUI 起得来、第一回合挂住、不会自己退出**。
2. **Linux / macOS 一行未跑**：`--settings` 的合并语义、信号传递、`detached` 的孤儿行为都**只在 Windows 实测**。
3. **`--agents` 与 `--plugin-dir` 在 roster 过滤下的完整等价性**：`--agents` 丢 skill 这一点实测过；
   但「生成临时目录只放部分 agent」这条路**没有跑**（§4.3 第二行是推断）。
4. **用户装了同名 plugin `overwatch` 的冲突**：同事已测「载荷版无条件赢」，本轮未重测。
5. **`--settings` 传入一份「用户自己的 settings 文件路径」会怎样**（即应用直接复用用户的文件而不是叠加）：未测。
6. **`auth status` 在真实已登录机器上的耗时**：本机 1.97 s。这个数进了 doctor 的 1000 ms 预算就破预算。

---

## §8 如果上面某条错了，什么证据能推翻它

1. 在**已登录**的机器上，交互式会话在认证失败时不进入重试循环，而是立刻给出明确提示 → §1.1 那格的严重性高估了。
2. 应用带 `--settings` 时 `permissions.defaultMode` **不**覆盖用户的 → §3.2 / F1 错。
3. 某段代码读 `agent.roster` 去过滤 `--plugin-dir` 的内容 → §4.2「假承诺」错（但 grep 全仓为零命中）。
4. `templates/*.settings.json` 里的 `<OVERWATCH_ROOT>` 已经在某处被替换 → §5.2 那 0.5 条价值消失（但 grep 只命中模板自身）。
5. `--plugin-dir` 接受某个我漏掉的过滤参数 → §4.1 错。

---

## §9 给决策者的六行

```
① --settings 是合并，不是覆盖：用户的 hooks 一条不少（三源扇出实测）。
   但标量键会覆盖——用户的 defaultMode:"plan" 实测被顶成 acceptEdits，文件当场落盘。
   「应用的 settings 里不许出现 defaultMode / model」是一条硬约束，不是风格建议。

② roster 是假承诺。agent.roster 全仓只被校验形状，没有一行代码读它选 agent。
   --plugin-dir 只能整目录挂，12 个全上。要做，得换 --agents <json>（实测可行，14 KB）。

③ 「只有 wrapper 能做」只剩 1.5 条：替换 <OVERWATCH_ROOT> 占位符、保证 PATHEXT。
   两条都是【一次性的正确性问题】，不需要每次启动都有 wrapper 在场。
   建议改成 `overwatch settings --write` + doctor 增一项，而不是做一个启动器。

④ 未登录机器上应用不是废的：doctor/scan/verify/tui/watch/hook 全都可用，四条主功能不要推理。
   坏的是 launch——它起得来、看着正常、第一回合挂住。**别把 launch 做成默认入口。**

⑤ 退出码传递是空话：交互式认证失败时宿主不退出（重试 9 次），base_url 不可达时 >90 s 不返回。
   wrapper 无法把这几种分辨成不同码。「如实转达退出码」在执行层面没有落脚点。

⑥ 如果一定要做 launch：只做「渲染 settings 文件」+「启动前跑 auth status」，
   不带 defaultMode/model，不接管进程，不做后台 detached（那会产生烧 token 的孤儿）。
   一句话：这个 wrapper 的价值被高估了，它该做的是【准备好环境让用户自己启动】，不是【代替用户启动】。
```
