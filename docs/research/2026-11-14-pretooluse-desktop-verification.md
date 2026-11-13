# PreToolUse 在桌面版宿主的实测契约

- 日期：2026-11-14
- 作者：验证 Agent H4
- 产出形态：artifact（结论报告）
- 实验宿主：`claude.exe 2.1.308`，transcript 均记 `entrypoint=claude-desktop-3p`
- 实验脚本与原始日志：`.tmp-analysis/pretooluse-lab/`（gitignored，不在可发布区）

> **本文只写实测到的东西。** 凡未实测的标「未实测」，凡与仓库已有结论冲突的，直接写冲突在哪。
> **推翻一条已有结论**：`2026-11-13-critique-question-layer-product.md` §三（「如果真要做机械强制」那段）
> 说「`PreToolUse` 本仓**零实现、零验证**」。**现在有 20 组实测了**（原有 7 组 + 本次补做 13 组），见 §3。

---

## 0. 结论先行

**能用。但「第一次写之前强制提问」这个形态，机械拦截这一半是成立的，提问那一半不成立。**

五条必须记住的：

1. **`PreToolUse` 能拿到完整的 `tool_input`，且能拦住 `Write`。**
   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
   "permissionDecisionReason":"…"}}` → 文件不存在，`permission_denials` 里有记录，
   reason 原文回到模型。见 §3 B1。

2. **`exit 2` 在 `PreToolUse` 上也不拦截 —— 与 Stop hook 一致。**
   同一次实验里 `deny` 拦住、`exit 2` 没拦住（D3：hook 触发 1 次，文件照样落盘）。
   原有 B4 看起来「exit 2 拦住了」是**假象**：那次被「Git Bash 未找到」的 fallback 污染了，
   宿主把任何非零退出统一转成 `ask`，而 headless `ask` = 拒绝。见 §4。

3. **`updatedInput` 真的能改写工具参数，且改写对模型透明。**
   B3 把 `file_path` 从 `gated.txt` 改成 `gated-REWRITTEN.txt`、把 `content` 整段替换，
   落盘的是改写后的文件，模型收到的是「File created successfully at …-REWRITTEN.txt」。
   见 §3 B3。

4. **hook 无状态，但**不需要**自己数次数 —— 数次数的那种闸门可以被一次重试直接绕过。
   `gate1` 计数的是**尝试次数**，模型一重试同一个写就通过了（E1）。
   正确做法是查**可观测状态**（标记文件在不在盘上），这样重试绕不过去（F1/F2）。见 §5。

5. **`PreToolUse` 的拒绝循环宿主没有上限。**
   实测连续拒绝 **69 次仍在继续**（G3，180 秒后我主动 SIGTERM 才停）。
   对比 Stop hook 有 9 次上限（`2026-11-12-stop-hook-prototype.md` §2.4）。
   **闸门必须自带刹车**：拒绝时同时返回顶层 `continue:false`（G4 实测一轮即停）。见 §5。

---

## 1. 输入契约（实测原文）

G1 用 `mode=log` 抓到的完整 stdin，逐字段照抄：

```json
{
  "session_id": "be30b2fa-…",
  "transcript_path": "…\\projects\\C--Users-…-ptu-lab-proj\\be30b2fa-….jsonl",
  "cwd": "…\\Temp\\ptu-lab\\proj",
  "prompt_id": "7b2df33f-1649-471a-ad5d-3efb93521854",
  "permission_mode": "acceptEdits",
  "effort": { "level": "max" },
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": { "file_path": "…\\proj\\gated.txt", "content": "written by the gated write\n" },
  "tool_use_id": "toolu_stub_1"
}
```

| 字段 | 用途 | 备注 |
|---|---|---|
| `session_id` | 会话身份 | 可用作闸门状态的天然分区键（比 `pid` 可靠；`pid` 每个 hook 进程都不同） |
| `transcript_path` | 当前 transcript 的绝对路径 | **可读**，闸门据此判断「之前写过没有」时不必自己记状态 |
| `cwd` | 会话工作目录 | 就是会话根，不是文件所在目录 |
| `prompt_id` | 本回合的身份 | **区分「首次写」的好锚点**：同一 `prompt_id` 内第一次 `Write` 即可判为首次 |
| `permission_mode` | 当前权限模式 | 实测值 `acceptEdits`（实验用 `--permission-mode=acceptEdits`） |
| `effort` | 对象 `{level}` | 实验环境为 `max` |
| `hook_event_name` | 事件名 | 固定 `"PreToolUse"`，可据此做事件分发 |
| `tool_name` | 工具名 | 实测见过 `Write` / `Edit` / `PowerShell` |
| `tool_input` | **完整参数** | `Write`：`file_path`,`content`；`Edit`：`file_path`,`old_string`,`new_string`,`replace_all` |
| `tool_use_id` | 本次调用 ID | 与 transcript 里的 `tool_use` 对得上 |

**两点是这次的实质收获**：

- `tool_input` 是**完整**的，不是摘要。`Write` 能拿到全文 `content`，
  `Edit` 能拿到 `old_string`/`new_string`/`replace_all` 三件套。这意味着闸门可以按**内容**判断，
  不必只看路径。
- **没有 `hook_count` 之类的计数**。宿主不提供「这是第几次调用」，状态得自己维护或从
  `transcript_path` 里读。

`Edit` 的 `tool_input`（G5 实测）：

```json
{ "file_path": "…\\proj\\probe.txt", "old_string": "hello",
  "new_string": "hello edited", "replace_all": false }
```

---

## 2. 输出契约

### 2.1 实测有效的部分

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow | deny | ask | defer",
    "permissionDecisionReason": "…",
    "updatedInput": { … },
    "additionalContext": "…"
  },
  "continue": true,
  "stopReason": "…"
}
```

| 字段 | 实测结果 | 证据 |
|---|---|---|
| `permissionDecision: "deny"` | **拦住**，文件不落盘，reason 原文回模型，`permission_denials` 记录 | B1、D4 |
| `permissionDecision: "allow"` | 放行 | B3、G2 |
| `permissionDecision: "ask"` | headless 下**退化成拒绝**（无人可问） | B2 |
| `permissionDecision: "defer"` | **未实测**。二进制里明确写 `defer is print-mode only`，交互模式会被忽略 | 二进制偏移 |
| `updatedInput` | **生效**，路径与内容都被替换，模型看到的仍是成功 | B3 |
| `additionalContext` | **生效**，以 `PreToolUse:Write hook additional context: …` 的系统块进入下一次请求 | G2 |
| `continue: false` + `stopReason` | **生效**，一轮即停 | G4 |
| `permissionDisplay` | **未实测**。`@internal` + 桌面宿主专用，需 initialize 声明 `host_worded_asks` | 二进制 schema |

### 2.2 契约的硬边界（从二进制 schema 读出，未逐条实测）

- `hookSpecificOutput.hookEventName` **必须**等于 `"PreToolUse"`，否则整条输出被判 `malformed`，
  走 fallback 路径。
- 顶层 `decision` 是**旧字段**（`approve|block`）。要 `ask` 必须用
  `hookSpecificOutput.permissionDecision`；写错位置宿主会给出明确报错：
  *"top-level decision is the legacy approve|block field; for "ask" use
  hookSpecificOutput.permissionDecision in a PreToolUse hook"*。
- `updatedInput` 会**过 schema 校验**。校验失败时宿主记
  *"The permission handler returned updatedInput for … that failed schema validation"* 并降级为 deny。
  所以改写只能改值，不能改形状。
- 多个 hook 时按 `deny > ask > allow` 取最严（二进制里 `Spe.deny/ask/allow` 的优先级比较）。

---

## 3. 各模式实测结果

装置：本地 stub 顶替模型（只替换模型那一端），跑的是**真的 `claude.exe`**，
hook 注册、权限处理、工具循环、transcript 全是真宿主的。
脚本：`hook.mjs`（按 `.mode` 切行为）+ `stub-server.mjs` + `trial.mjs`。

| 组 | mode | 返回值 | 文件落盘 | 模型收到 | 判定 |
|---|---|---|---|---|---|
| g1 / A1 | `log` | 无输出 | **是** | 成功 | 对照组，hook 触发但不干预 |
| A2 | `gate1` | 第 1 次 deny | 否（`num_turns=2`，模型没再重试） | reason | 只证明「第一次能拦」，**没证明第二次放行** |
| E1 | `gate1` | 第 1 次 deny，第 2 次放行 | 第 2 次**是** | 先 reason，后成功 | 计数式闸门**可被一次重试绕过** |
| B1 | `deny` | `permissionDecision:"deny"` | **否** | reason 原文，`is_error=true` | **拦住** |
| B2 | `ask` | `permissionDecision:"ask"` | **否** | reason 原文，`is_error=true` | headless 下等同拒绝 |
| B3 | `rewrite` | `allow` + `updatedInput` | **是（改写后）** | `File created successfully at …-REWRITTEN.txt` | **改写生效且透明** |
| B4 | `exit2` | `stderr` + `exit 2` | **否** | 见 §4（被 fallback 污染） | **不能作为 exit 2 的证据** |
| D1 | `exit1` | `stderr` + `exit 1` | **否** | 同 B4 的 fallback 文案 | 同上，被污染 |
| D3 | `exit2` + `shell:powershell` | `stderr` + `exit 2` | **是** | `File created successfully` | **exit 2 不拦截** |
| D4 | `deny` + `shell:powershell` | `permissionDecision:"deny"` | **否** | reason 原文 | 同装置下的阳性对照 |
| G2 | `allowctx` | `allow` + `additionalContext` | **是** | `additionalContext` 出现在下一请求的系统块 | **上下文注入生效** |
| G4 | `denyhalt` | `deny` + `continue:false` | **否** | 回合直接结束（`num_turns=2`，只 1 次请求） | **能刹车** |
| G6 | `gateverify` | deny | PowerShell 写的文件**是** | 无 hook 消息 | **PowerShell 绕过路径闸门** |

### 3.1 逐条要点

**B1 `deny`** —— 这是唯一被完整验证的拒绝路径。`permission_denials` 里带完整 `tool_input`，
说明宿主把「被 hook 拒绝」和「用户拒绝」记在同一处，下游取证可用。

**B2 `ask`** —— 实验用 `--permission-mode=acceptEdits` 跑非交互 `-p`。此时
`ask` 没有可问的人，宿主直接判拒绝。**桌面交互态下 `ask` 是否弹卡片，本次未实测**
（要真人在场点，stub 装置做不到）。二进制里有 `permissionDisplay` 字段与
`host_worded_asks` 能力位，说明卡片路径存在，但**我没跑通它**。

**B3 `rewrite`** —— 最有信息量的一组。hook 同时改了 `file_path` 和 `content`：

```js
next.file_path = p.replace(/\.txt$/, "") + "-REWRITTEN.txt";
next.content = "CONTENT REPLACED BY PRETOOLUSE HOOK\n";
```

盘上出现 `gated-REWRITTEN.txt`，内容正是替换后的那一行；**`gated.txt` 不存在**。
模型收到的是 `File created successfully at: …\\gated-REWRITTEN.txt`。
→ 改写对模型**不隐藏**（它看到的是新路径），但对**用户**是隐蔽的：
宿主没有在 UI 上提示「参数被 hook 改过」。这一点与
`2026-11-11-untapped-capabilities.md` §563 的判断一致，现在有实测支撑。

**G6 PowerShell 绕过** —— `gateverify` 只拦 `Write`/`Edit`。让模型改用
`PowerShell` 执行 `Set-Content`，hook 触发了一次但返回 passthrough，
`gated3.txt` 照样落盘。**任何只 matcher `Write|Edit` 的闸门，都从旁边漏过去。**

---

## 4. 与 Stop hook 的对比，尤其是 `exit 2`

### 4.1 结论：两个事件上 `exit 2` 都不拦截

| | Stop hook（已有实测） | PreToolUse（本次实测） |
|---|---|---|
| `exit 2` 拦截？ | **否**，记 `Failed with non-blocking status code`，回合照常结束 | **否**，工具照常执行、文件照常落盘 |
| 什么才拦？ | `{"decision":"block","reason":…}` | `hookSpecificOutput.permissionDecision:"deny"` |
| 语义出口 | 顶层 `decision` | `hookSpecificOutput`（顶层 `decision` 在这里是旧字段） |

**`exit 2` 在两个事件上都不生效，机制不同但结果一致。** 这加强了
`2026-11-12-stop-hook-prototype.md` §2.2 已经推翻的那条上游文档说法
（"exit 2 与 block 等价"）—— 现在有两个事件各一份证据。

### 4.2 B4 的假象怎么来的

B4 当时**看起来** exit 2 拦住了：文件没落盘，`permission_denials` 有记录。
但模型收到的不是 hook 的 stderr，而是这段：

```
PreToolUse:Write hook error: [node "…hook.mjs"]: failed; blocking because
Git Bash wasn't found and this hook doesn't set "shell" to "powershell",
so only exit code 0 or 2 counts as its verdict. …
[ptu-lab] blocked via exit code 2. …
```

关键在**"only exit code 0 or 2 counts as its verdict"** —— 这句话本身在说
「因为找不到 Git Bash，我不认这个退出码」。宿主走的是**降级路径**：
hook 启动环境退化成 PowerShell，任何非零退出都被当成失败并转成 `ask`，
headless 下 `ask` 即拒绝。

**决定性对照**：D1 用 `exit 1` 跑同一装置，得到**逐字相同的** fallback 文案并同样拦住。
如果 exit 2 有任何特殊含义，exit 1 不该有同样的行为。
**所以 B4 拦住的不是 exit 2，是「hook 进程失败」这个降级。**

D3 给 hook 显式加 `"shell": "powershell"`（二进制 schema 里确有此字段）后，
同一个 `exit 2` 触发 1 次、文件**落盘成功**、`permission_denials` 为空。
同一份 settings 下 `deny` 仍然拦住（D4）。**这一对才是干净的对照。**

### 4.3 `additionalContext` 在两处的行为不同

- **Stop**：`additionalContext` 是无限循环源（模型每轮收到同一段、再结束一次，
  撞上 9 次上限才放行）。
- **PreToolUse**：`additionalContext` **只注入一次**，挂在本次工具调用的结果旁边，
  不引发重试。G2 里注入后模型正常结束，`num_turns=2`。

原因是结构性的：Stop 的上下文喂回去会**再次触发 Stop**；PreToolUse 的上下文喂回去
只会让模型**继续处理这次工具调用的结果**，不会自动再发同一个工具调用。

---

## 5. 「第一次写之前强制提问」的可行性

问题拆成三问，逐个回答。

### 5.1 能不能拦住第一次 `Write`/`Edit`？—— **能，但必须挡住旁路**

拦住本身已被证明（B1、D4）。但「拦 `Write`/`Edit`」不等于「拦住写文件」：

| 旁路 | 实测/已有数据 | 后果 |
|---|---|---|
| `PowerShell`（本机默认 shell 工具） | **G6 实测绕过**：`Set-Content` 照常落盘 | 闸门形同不存在 |
| `Bash` | 本机 `Write`/`Edit` 之外，首次改动走 Bash 的会话占 **31.3%（51/163）** | 三分之一以上从旁边走 |
| `NotebookEdit` | 未实测 | 需一并 matcher |

所以 matcher 必须写成 `Write|Edit|NotebookEdit|PowerShell|Bash`，
并在 hook 内对 shell 类工具做命令解析（判断是否改写工作区）。**这一块不是本次的产出**，
仓库已有 `scripts/verify-claims.mjs` 的 `isMutatingCommand` 可复用。

### 5.2 能不能区分「第一次写」和「第 N 次写」？—— **能，但别用计数器**

hook 进程是**一次性**的（每次调用新 `pid`），确实无状态。但宿主给了两个更好的锚点：

| 方案 | 做法 | 实测结果 |
|---|---|---|
| 计数器（`gate1`） | 首次调用写个 `.gate-count`，之后放行 | **可绕过**：计的是**尝试**次数。模型原样重试同一个写就通过了（E1：第 2 次 `Write` 落盘） |
| **可观测状态**（`gateverify`） | 拒绝，除非标记文件真的在盘上 | **绕不过**：F1 连拒两次（`gated.txt` 与 `gated2.txt` 都没落盘）；F2 在标记文件写出后立刻放行目标写 |
| `prompt_id` + `transcript_path` | 读 transcript 判断本回合内是否已写过 | 未实测（本轮未做）。理论可行，但比查盘贵 |

**关键判断：不要用计数器。** 计数器把「第一次」定义成「第一次尝试」，
而模型被拒后的自然反应就是重试 —— 这恰好是闸门最想拦的那个动作。
用**结果状态**（标记文件存在与否）定义「第一次」，语义才是对的，且天然幂等。

F2 的完整链路（一次实验跑完，`num_turns=5`）：

```
Read probe.txt                    → 成功（被拦截期间可以读东西）
Write gated.txt                   → 拒绝："QUESTIONS.md does not exist yet…You may read files in the meantime."
Write QUESTIONS.md                → 成功（放行标记文件本身）
Write gated.txt                   → 成功
```

### 5.3 拦住之后，能不能让 AI 先做别的事？—— **能，且这是实测到的**

F2 里 `Read` 在拒写之后、标记写之前成功执行。说明拦截**不是**终止回合，
只是让那一次工具调用失败；模型收到 `is_error` 的 `tool_result` 后可以继续发别的调用。
reason 里写清「先写 QUESTIONS.md，期间可以读文件」，模型就照着做了（stub 按脚本走，
真实模型的行为见下面的诚实边界）。

### 5.4 可行性判断

| 子问题 | 判定 | 依据 |
|---|---|---|
| 拦住首次 `Write`/`Edit` | ✅ 可行 | B1、D4 |
| 区分首次与第 N 次 | ✅ 可行（用状态，不用计数） | F1/F2 |
| 拦截后模型可继续做别的事 | ✅ 可行 | F2 |
| 拦住**所有**写文件路径 | ⚠️ 需覆盖 PowerShell/Bash，本轮只证明「不覆盖就会漏」 | G6 |
| 「强制**提问**」（弹出问题等人答） | ❌ **不可行**（在 hook 内） | 见 5.5 |
| 拒绝循环有宿主兜底 | ❌ **没有**，必须自带 `continue:false` | G3/G4 |

### 5.5 「提问」这一半为什么不成立

`PreToolUse` 的 hook 只能返回**四种**决策：allow / deny / ask / defer。
其中只有 `ask` 接近「提问」，但：

- `ask` 让**宿主权限系统**去问，问的是「允许这次工具调用吗」，**不是**「你想让项目做什么」。
  问题的内容由宿主决定，hook 只能给 `permissionDisplay`（桌面专用、`@internal`、**我未跑通**）。
- 因此 `ask` 只能实现「**先确认再写**」，实现不了「**先问清需求再写**」。
- 要让模型主动提需求问题，得靠 `deny` 的 **reason 文本**去指令它 —— 但那是提示，不是强制。
  F2 里 stub 按脚本走所以「照着做了」；**真实模型会不会真的先问、问得对不对，本次未实测**。

**所以正确的表述是：`PreToolUse` 能强制「写之前必须完成某个前置动作」，
其中「读文件/建标记文件」是可以机械验证的，「提问」不可以。**
把「提问」当硬约束，只能在 reason 里写指令 + 在 Stop hook 里事后核对，
不能靠 `PreToolUse` 保证。

---

## 6. 实现方案（若要做）

```jsonc
// .claude/settings.json —— 只给片段，未在本仓启用
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Write|Edit|NotebookEdit|PowerShell|Bash",
      "hooks": [{
        "type": "command",
        "command": "node \"<repo>/scripts/first-write-gate.mjs\"",
        "shell": "powershell",     // Windows 上别省：否则 exit 语义被 fallback 改写
        "timeout": 10
      }]
    }]
  }
}
```

闸门逻辑（对应 F1/F2 已验证的形态）：

1. **放行标记文件本身**：`tool_input.file_path` 规范化后等于标记路径 → 放行。
2. **标记不存在 → 拒绝**，reason 写明「先写 X，期间可读文件」。
3. **同时返回 `continue:false`**：拒绝循环宿主无上限（G3 实测 69 次），
   必须自己刹车。**但注意**：`continue:false` 会终止整个回合，
   等于放弃「让模型继续做别的事」。这两条互斥，得二选一：
   - 要**保证不刷屏** → 用 `continue:false`，代价是回合结束、无法「先读再写」。
   - 要**让模型先做别的事** → 不给 `continue:false`，代价是**必须自己数次数**
     （比如同一 `prompt_id` 内拒绝超过 3 次就转 `continue:false`）。
   实测里 F2 没刷屏是因为 stub 按脚本走。**真实模型连续重试的情形未实测**——
   这是本方案最大的未验证点。
4. **shell 类工具**走命令解析，判是否改写工作区；不解析就等于没装（G6）。

**不要做的事**：不要用 `updatedInput` 改用户想写的路径来「纠正」模型。
B3 证明它生效且模型无感，正因为如此，用户也看不到改动 —— 这正是
`2026-11-11-untapped-capabilities.md` §563 警告的用法。

---

## 7. 诚实边界

**未实测的**：

1. **桌面交互态下 `ask` 是否弹卡片**。全部实验跑在 `-p` 非交互模式，
   `ask` 观察到的行为是「退化成拒绝」。卡片的真实观感没验过。
2. **真实模型被拒后会不会照 reason 去做**。模型端是 stub，按脚本走。
   「模型收到拒绝 → 真的先去读项目/提问」这一步**没有真实模型证据**。
3. **`defer`** 在此宿主交互模式下的行为（二进制说会被忽略，没跑）。
4. **`permissionDisplay`** 卡片文案（需 `host_worded_asks`，未跑通）。
5. **真实模型连续重试拒写**时的循环次数与体验。G3 的 69 次是 stub 每轮发同一调用的结果。

**装置本身的局限**：模型是假的。hooks、权限、工具循环、transcript 是真的，
但「模型如何反应」不是。凡涉及模型行为的推论，本文都标了「未实测」。

---

## 8. 与仓库已有结论的关系

| 已有 | 本文的补充 |
|---|---|
| `2026-11-11-untapped-capabilities.md` §1.2：hooks 有 33 个事件 | 补上 `PreToolUse` 的完整输入/输出契约（§1、§2） |
| `2026-11-11-untapped-capabilities.md` §563：`updatedInput` 不适合偷偷修正 | **实测支持**（B3：改写生效、模型无感、用户界面无提示） |
| `2026-11-12-stop-hook-prototype.md` §2.2：Stop 上 `exit 2` 不拦截 | **`PreToolUse` 上同样不拦截**，且找到 B4 假象的成因（§4.2） |
| `2026-11-13-critique-question-layer-product.md` §三：「`PreToolUse` 零实现、零验证」 | **已过时**：现有 20 组实测。但它的核心裁决**仍成立**——见下 |
| 同上：828 次介入里只有 **8.2%（68 次）** 发生在首次写文件之前 | 本文不改变这个数。**它才是产品判断的决定性事实**：闸门能拦住首次写，但首次写之前本来就只有 8.2% 的介入可被它影响 |
| 同上：首次改动走 Bash 的占 **31.3%** | G6 给出机制解释：只 matcher `Write|Edit` 的闸门会被 shell 工具绕过 |

**一句话**：技术可行性成立了，但 8.2% 这个比例成立与否不取决于技术。
本报告不主张「应该做」，只说明「做得到什么、做不到什么」。
