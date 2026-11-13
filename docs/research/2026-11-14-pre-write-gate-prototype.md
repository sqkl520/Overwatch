# 写前闸原型：PreToolUse 上「第一次写之前先读项目」能拦住，但拦不住「让 AI 去提问」

- 日期：2026-11-14
- 作者：执行 Agent P1
- 产出形态：artifact（`scripts/pre-write-gate.mjs` + 66 条测试 + 真实宿主实测）
- 实验宿主：`claude.exe 2.1.308`（`.../Claude-3p/claude-code/2.1.308/c17a819afb40/claude.exe`）
- 试跑装置与原始日志：`.tmp-analysis/pretooluse-proto/`（gitignored，**不发布**）
- 契约来源：`docs/research/2026-11-14-pretooluse-desktop-verification.md`（20 组实测，本文不重挖契约）

> **本文只写跑过的东西。** 凡没跑通的标「未跑通」，凡与已有结论冲突的，直接写冲突在哪。

---

## 0. 结论先行

**做出来了，在真宿主上跑通了「拦 → 照做 → 放行」的完整闭环。但有一处必须说清：这个闸能强制的是「先完成一个可机械验证的前置动作」，不是「先提问」。**

六条实测到的：

1. **拦得住 `Write`，也拦得住旁路。** 模型不做任何准备就写 → `permissionDecision:"deny"` + `continue:false`，文件不落盘，`permission_denials` 有完整记录，回合立刻结束（t1）。
   **`PowerShell` 的 `Set-Content` 同样被拦**（t4）—— 这是把 `2026-11-14` 报告 §3 G6 那个洞堵上的那一组。
2. **「读过项目」这件事可以被机械判定，而且不依赖 AI 配合。** 模型先读三个文件再写 → **一次都没被拦**，闸门从 transcript 里数出 3 个不同路径，自己写了标记（`satisfied_by:"auto"`，t2）。
   **这就是题意里方案 (b)，也是默认主路。**
3. **被拒之后 AI 能照 reason 做，然后放行。** t3 里模型被拒 → 跑 reason 里那条命令 → 重试 → 落盘，盘上标记记 `satisfied_by:"claim"`。
4. **重试绕不过去。** 状态式判定下，模型连续发 5 次同一个写，前 3 次全拒，第 4 次触发刹车结束回合（t5）。对照 `2026-11-14` 报告 E1 的计数器闸门：第 2 次就过了。
5. **同一装置把闸关掉，一切照旧通过。** 这是本文所有阴性结果的对照：`OW_PRE_WRITE_GATE=observe` 下 t1 的 `out.txt` **落盘了**、`denials: []`。**没有这个对照，前面四条的绿都不算绿。**
6. **一条新实测：本机宿主没有 `Bash` 工具。** 试跑时 stub 发 `Bash` 收到 `Error: No such tool available: Bash`，只有 `PowerShell`。这不会推翻已有结论（Bash 语料是别的会话里的），但它意味着**本机的闸必须把 `PowerShell` 当主路径，`Bash` 是兼容路径**。

**一句反问**：这个闸能强制的是「先读过 / 先跑过某个动作」，**不是**「先提问」。
`AskUserQuestion` 在 reason 里只是指令，机械核对不到。这一点与 `2026-11-14` 报告 §5.5 的裁决完全一致，本文没有推翻它，只是把它落成了代码。

---

## 1. 标记文件谁创建：(b) 为主，(a) 为逃生口

**结论：默认走 (b)（hook 从 transcript 判定后自己写），同时保留 (a) 作为 `satisfied_by:"claim"` 的逃生口。两者在标记里可区分。**

### 1.1 为什么 (b) 是主路

| | (a) AI 自己创建 | (b) hook 自动创建 |
|---|---|---|
| 依赖 AI 听话 | **是** | 否 |
| 能证明「真的读过」 | 不能 —— 它举手就行 | 能 —— 数 transcript 里的 `Read` |
| 天然通过 | 否，除非它知道闸存在 | **是**：本来就会先读项目的 agent 感觉不到闸门 |
| 失败模式 | AI 不跑命令 → 回合被 `continue:false` 结束 | transcript 里查不到读取（见 1.3） |

手动举手的问题不是「它会撒谎」这么轻：**它会把闸门退化成一句提示**。t3 里标记写的是 `reads: 0, satisfied_by: "claim"` —— 它确实一行都没读。

自动判定还有一个非显然的好处：**它把「读过项目」从一种声明变成了一个可复算的事实**。`decide()` 里数的是**不同路径**的集合，读同一个文件 50 次只算 1 个（测试 `读同一个文件多次只算一个`）。这条如果写成计数器，`Read README.md` × 3 就能骗过去。

### 1.2 为什么还留着 (a)

(b) 有一条硬边界：**读发生在本次会话之外时，transcript 里查不到**。三种常见情形：

- `/resume` 之前那个会话读过项目，新会话的 transcript 是空的；
- 子 agent 读的，主 transcript 里没有；
- 读发生在 hook 注册之前。

只留 (b)，这些会话会被永久拦住，而它其实读过。所以 `mark` 子命令必须存在。
**代价写清**：`satisfied_by:"claim"` 是一条自述，**事后可审计但当时不可信**。两个字段在日志里都留着，就是为了让「这个会话是通过验的，还是自己说的」永远查得到（`decide()` 的 `log.satisfiedBy`）。

### 1.3 (b) 的诚实边界

- **只读 transcript 尾部**（默认 1 MB）。一个读完项目又干了很久才第一次写的会话，读取记录可能已经滑出窗口。这是刻意的取舍：判定要在**每一次写之前**跑，全量扫 1.5 GB 语料不可接受。窗口可用 `OW_PRE_WRITE_GATE_TRANSCRIPT_BYTES` 调。
- **只认 `Read` / `NotebookRead` 和少数 shell 读动词**（`cat` / `head` / `tail` / `type` / `Get-Content`）。`grep` / `ls` / `Get-ChildItem` **不算读过** —— 看了文件名不算读了内容。这个判据可以争，代码里写在一处（`SHELL_READ_VERBS`），改起来是一行。
- **不区分「读了哪几个文件」**。现在只数不同路径的个数（默认 3）。要求「必须包含 README」需要多一条判据，本轮没做。

---

## 2. 实测：拦住了吗

装置与 `2026-11-14` 报告同形：**stub 只顶替模型那一端**，hook 注册、权限处理、工具循环、transcript 全是真 `claude.exe 2.1.308` 的。hook 里注册的是**仓库里的真脚本**，不是探针。
隔离目录：`.tmp-analysis/pretooluse-proto/proj/`，**没有动仓库的 `.claude/settings.json`**（试跑用的是 `proj/.claude/settings.json`）。

### 2.1 为什么不用 `claude -p` + 本地网关

先按题意试了，**跑不了**，两次都是已知形态：

```
env -u CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST -u CLAUDE_CODE_HOST_AUTH_ENV_VAR \
    -u CLAUDE_CODE_HOST_SESSION_ID -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDECODE \
    ... ANTHROPIC_BASE_URL=http://127.0.0.1:15721 claude -p "say PONG"
# → 120 秒零输出，随后 exit=0 且 stdout 完全为空（与 docs/FACTS.md:516 记录的一致）
```

网关侧：`POST /v1/messages` **25 秒无响应**（`http=000`）；`GET /v1/models` 正常返回 —— 通道通、消息接口不通。
这与 `docs/FACTS.md` 的结论一致：「`claude -p` 在本机当前环境下不可用——无论是保留还是剥掉宿主环境变量，都拿不到输出」。
**所以本轮改用与契约来源完全相同的装置**：真二进制 + stub 模型。这不是降级，是同一套已被 20 组实验验证过的装置。

**这个替代方案的局限必须写在前面**：模型是假的，所以「真实模型被拒后会不会照 reason 去做」这一条，本文**仍然没有真实模型的证据**（见 §6）。

### 2.2 t1：不做准备就写 → 拦截

```
claude exit=0  用时=8.1s
result      : ""            ← 回合被 continue:false 结束，没有最终回复
num_turns   : 2
denials     : [{ "tool_name": "Write", "tool_input": { "file_path": ".../out.txt", ... } }]
out.txt     : absent        ← 文件不落盘
.ow-read-done: absent

hook 记账 1 条：
  · tool=Write via=file-tool decision=deny halted=true marker=missing reads=0
```

**拦住了。** `num_turns=2` 说明拒绝之后**一轮即停** —— 这是 `continue:false` 在起作用（硬约束 ②）。

### 2.3 t4：用 PowerShell 的 `Set-Content` 绕过 → 同样被拦

```
claude exit=0  用时=6.0s
result      : ""
num_turns   : 2
denials     : [{ "tool_name": "PowerShell", "tool_input": { "command": "Set-Content -Path 'out.txt' -Value 'via powershell'", ... } }]
out.txt     : absent

hook 记账 1 条：
  · tool=PowerShell via=powershell decision=deny halted=true marker=missing reads=0
```

**G6 那个洞堵上了。** 依据是 `powershellWriteScan()`：它认 `Set-Content` / `Out-File` / `Add-Content` / `New-Item` / `Copy-Item` / 重定向，**含 `sc` 这类别名**（`sc` = `Set-Content`，最容易漏的那个）。
`-Value` 是内容不是路径，被显式排除 —— 否则 `Set-Content -Value 'x'` 会把内容当成文件名。

### 2.4 t2：先读三个文件再写 → 一次都没被拦

```
claude exit=0  用时=9.6s
result      : "done"
num_turns   : 5
denials     : []            ← 一次都没拦
out.txt     : read first, then wrote

.ow-read-done: { "version": 1, "session_id": "681d1d3c-...", "satisfied_by": "auto", "reads": 3 }

hook 记账 1 条：
  · tool=Write via=file-tool decision=allow reason=auto-satisfied-by-transcript marker=missing reads=3
```

**这是 (b) 主路成立的证据。** 模型完全不知道闸门存在，只是先读了 `README.md` / `math.mjs` / `index.mjs`，闸门从 transcript 数出 3 个不同路径，自己写了标记并放行。
注意 `marker=missing`：判定时标记还不存在，是 `decide()` 返回 `markWrite` 之后由 `runHook()` 落盘的 —— 纯函数不碰盘，才测得了。

### 2.5 t3：被拒 → 照 reason 做 → 放行

`brake=budget`（前 N 次不刹车，让模型能继续发工具调用）：

```
claude exit=0  用时=15.5s
result      : "done"
num_turns   : 4
out.txt     : attempt 2, after marking
.ow-read-done: { "satisfied_by": "claim", "reads": 0, "session_id": "6bd2c9a5-..." }

hook 记账 3 条：
  · tool=Write      via=file-tool  decision=deny        halted=false marker=missing
  · tool=PowerShell via=powershell decision=passthrough reason=not-a-write   ← 模型跑 reason 里那条命令
  · tool=Write      via=file-tool  decision=allow       reason=marker-present marker=same-session
```

**完整闭环跑通了**：拦 → 模型跑 reason 里的命令 → 重试 → 放行。
模型收到的 `tool_result` 是 `is_error=true` + reason 原文（下面第 3 节贴了原文），跑完命令后收到 `标记已写入：…`。

### 2.6 t5：连续重试 → 绕不过去，且刹车生效

`brake=budget`，`denyBudget=3`：

```
claude exit=0  用时=10.4s
num_turns   : 5
out.txt     : absent

hook 记账 4 条：
  · deny halted=false   ← 第 1 次
  · deny halted=false   ← 第 2 次
  · deny halted=false   ← 第 3 次
  · deny halted=true    ← 第 4 次，刹车，回合结束
```

**这一组同时证明了三件事**：
1. 重试**没有**变成放行（对照 E1 的计数器闸门：第 2 次就过了）；
2. 刹车按预算生效，而不是第 1 次就把回合打死；
3. 第 5 次写根本没发生 —— `num_turns=5` 是 4 次写 + 最后的文字轮。

### 2.7 阴性对照：把闸关掉，一切照旧

**这是本文最重要的一个对照。** `OW_PRE_WRITE_GATE=observe` 下跑同一个 t1：

```
result      : "done"
num_turns   : 2
denials     : []
out.txt     : written without reading      ← 落盘了
hook 记账 1 条：
  · tool=Write decision=would-deny reason=observe-mode
```

**同一个输入，闸开就拦、闸关就过。** 没有这一组，§2.2 的「拦住了」可能只是「模型没写」。

---

## 3. 硬约束逐条怎么防

### ① `exit 2` 不拦截 → 本脚本**只**用 `permissionDecision`

源码里所有 `process.exit(...)` 只有三种：`exit(0)`（hook 入口）、`exit(cli(...))`（子命令返回值）、`exit(2)`（**未知子命令的用法错误**，不是拦截）。
有一条测试直接扫源码守这个：

```js
test('源码里不存在以 exit code 表达拒绝的路径', () => {
  const exits = [...src.matchAll(/process\.exit\(([^)]*)\)/g)].map((m) => m[1].trim());
  for (const e of exits) {
    assert.ok(e === '0' || e === '2' || e.startsWith('cli('), `出现了意外的 exit(${e})`);
  }
});
```

另外**所有崩溃路径也 `exit 0`**：输入坏 / transcript 读不到 / 我们自己的代码抛了 → 记账 + 放行（fail-open）。理由是闸门故障不该让用户写不了文件。

**模板里写 `"shell": "powershell"`**。这条不是装饰：`2026-11-14` 报告 §4.2 证明，Windows 上不写它，宿主找不到 Git Bash 时会走 fallback，把任何非零退出转成 `ask` —— 那会**伪造出一个「拦住了」的假象**。有一条测试断言模板带着这个字段。

### ② 拒绝循环无上限 → 每次 deny 自带刹车

两档，默认 `halt`：

| 档位 | 行为 | 代价 |
|---|---|---|
| `halt`（默认） | deny 同时给顶层 `continue:false` + `stopReason` | **整个回合结束**，模型没机会「先去读」 |
| `budget` | 前 N 次 deny 不给 `continue:false`，第 N+1 次给 | 多花 N 次往返；N 由 `OW_PRE_WRITE_GATE_DENY_BUDGET` 定 |

**为什么默认 `halt`**：题目要求「拒绝时必须同时返回顶层 `continue:false`，否则会无限循环」。`halt` 严格符合这一条，且它是最坏情况下的正确行为。`budget` 是给「想让模型被拒后先去读文件」的场景用的，t3 / t5 就是它。

**计数器只用来刹车，绝不用来判定。** 这是 E1 那条实测的直接应用：`bumpDenials()` 的返回值只进 `halt` 的那个布尔式，`decide()` 判「拦不拦」看的是**盘上的标记**，跟计数无关。测试里有一条专门守这个：

```js
// 两次都拒绝：计数只影响刹车，不影响「拦不拦」
assert.equal(recs.filter((r) => r.decision === 'deny').length, 2);
```

reason 文案在两档里不同（`halt` 会明说「本次拒绝同时结束了本回合」），因为模型需要知道它还来不来得及补救。有测试断言两段文案不相等。

### ③ shell 旁路 → matcher 覆盖五个工具 + hook 内解析命令

模板 matcher：`Write|Edit|NotebookEdit|Bash|PowerShell`。

- `Bash` → **复用** `claim-ledger.mjs` 的 `bashWriteScan`（已过测试的 tokenizer，认重定向 / heredoc / `tee` / `cp` / `mv`，含 `cd` 基准追踪）。**不在两处各写一套规则**，否则两边迟早给出相反结论 —— 这是 `stop-verify-hook.mjs` 文件头同一条原则。
- `PowerShell` → 本文件的 `powershellWriteScan`。

**解析不出来的怎么办**：`sh -c "…"` / `xargs` / `Invoke-Expression` 一律**计数但放行**（`unresolved`）。理由是「没看」和「没写」必须区分开 —— 这个计数器进了记账，事后能查。**这是漏洞不是特性**，写在 §6。

---

## 4. 交付物

| 文件 | 内容 |
|---|---|
| `scripts/pre-write-gate.mjs` | 闸门本体。`decide()` 纯函数；`runHook()` 收副作用；`mark` / `status` 两个子命令 |
| `scripts/pre-write-gate.test.mjs` | 66 条测试（含端到端 spawn 与负向对照） |
| `templates/pre-write-gate.settings.json` | 可直接合并进 `.claude/settings.json` 的片段，含全部五个 matcher 与启用说明 |

### 4.1 三档模式（默认最保守）

```bash
OW_PRE_WRITE_GATE=observe   # 默认。只记账，stdout 什么都不输出 = 放行
OW_PRE_WRITE_GATE=warn      # 放行 + additionalContext 提醒（实测只注入一次，不引发循环）
OW_PRE_WRITE_GATE=deny      # 真的拦
```

`observe` 下 `decide()` 返回 `action:"passthrough"` 且 `output:null`。**「不输出」和「输出 allow」在宿主上不等价**：后者会参与 `deny>ask>allow` 的合并，多个 hook 并存时会抹掉别人的 deny。静默才是对的。

### 4.2 reason 是一段可执行指令链

实测原文（模型在 `tool_result` 里收到的，`is_error=true`）：

```
[overwatch] 写前闸：你还没读过这个项目，所以这次写入被拒绝。

在写任何文件之前，按顺序做完这三步：
1. 读 .../proj/CLAUDE.md（若不存在则跳过）、.../proj/README.md，
   以及至少 1 个源码文件（用 Read，不要用 Bash cat）。这算「读过项目」。
2. 若有你还不确定的点，用 AskUserQuestion 一次问清（最多 5 个）；没有就跳过这步。
3. 创建标记，然后原样重试你刚才那次写：
   node "<overwatch 仓库根>/scripts/pre-write-gate.mjs" mark --session <真实 session_id>（反例：实测时是本机绝对路径）

标记一旦存在，本会话后续的写不会再被拦。
注意：不要绕过闸门（用 shell 重定向、Set-Content、或者直接写标记文件都不算读过），
标记里记录了它是「验出来的」还是「自己说的」，事后能查。

本次拒绝同时结束了本回合（reason: 宿主对 PreToolUse 拒绝**没有次数上限**，不刹车会无限重试）。
下一步：先用 Read 读上面的文件，再运行第 3 步的命令，然后重试写入。
```

三点值得说：
- **`--session` 里的 ID 是 hook 现填的真实值**，模型不用知道自己的 session_id，照抄就行。
- **最小读取数随 `minReads` 变**（`至少 N 个源码文件`），文案与判据不会漂。有测试守。
- **明说了「不要绕过」和「事后能查」**。这不是靠吓，`satisfied_by` 字段是真的记着。

---

## 5. 测试与负向测试

本文件 66 条全过；全仓在同一时刻也是全绿（`node --test scripts/*.test.mjs` 无失败）。
全仓总数随时在变（同期还有别的改动在往里加测试），所以这里不写死一个总数 —— 写死的数字一定会漂。

`check-structure.mjs` 通过。

### 5.1 负向测试：把 bug 放回去，必须变红

四条，全部实跑（脚本 `.tmp-analysis/pretooluse-proto/negate.sh`）：

| 把什么改坏 | 期望 | 实测 |
|---|---|---|
| `output.continue = false` → `true`（去掉刹车） | 刹车相关测试红 | **fail 6** |
| `mode: 'observe'` → `'deny'`（默认变成会拦） | 「默认必须不拦」红 | **fail 5** |
| 从 shell 工具识别里摘掉 `PowerShell` | 旁路测试红 | **fail 4** |
| `if (!raw) return null` 删掉（空串当 0 的 bug 放回去） | `minReads` 回落到 0，自动放行失效 | **fail 1** |

**第四条是这个原型里真实修掉的 bug**，不是为测试编的：`Number('')` 是 `0`，所以只设 `OW_PRE_WRITE_GATE=deny` 时 `minReads` 变成 0，**(b) 那条主路被静默关掉**，闸门退化成纯荣誉制 —— 而且日志里看起来一切正常。这条是跑 t2 时发现的：模型明明读了 3 个文件，`log.reads` 却是 3 但 `minReads` 是 0，判定直接跳过。

每条负向测试跑完都恢复原文件，恢复后再跑一次确认回到全绿（`pass 66, fail 0`）。

### 5.2 边界覆盖

没有 `tool_input` / 未知工具 / 标记已存在 / Bash 命令不含写 / 不是 `PreToolUse` 事件 / 输入不是对象 / 坏 JSON 的标记 / transcript 读不到 / 闸门自己的文件（不自锁）/ `.claude/settings.json`（照拦）。
另有三条端到端：hook 当子进程跑，验 stdout 字节级形状与 exit code。

---

## 6. 诚实边界

**没跑通的 / 没做的**：

1. **真实模型被拒后会不会照 reason 去做 —— 仍然没有真实模型的证据。** 本轮 stub 是按脚本走的。「模型收到 deny → 真的先去读项目、真的运行那条命令」这一步，和 `2026-11-14` 报告 §7 一样，**未实测**。`claude -p` 在本机不可用（§2.1），这是硬阻塞，不是我省事。
   **最小可验证的替代方案**：把闸装进一个真实交互会话（`OW_PRE_WRITE_GATE=observe` 起步），让日志回答「`would-deny` 有多少次是模型紧接着自己去读文件的」。这需要人坐在那儿用一个会话，我做不到。
2. **`ask` 在桌面交互态是否弹卡片 —— 仍未实测。** 本轮全部在 `-p` 非交互模式下跑。
3. **shell 命令解析不出来时放行 = 漏洞。** `sh -c "echo x > y.txt"` / `xargs` / `Invoke-Expression` 都会漏。代码里计了 `unresolved`，但计数不等于拦住。**知道有这个洞，比假装没有好；但它是洞。**
4. **`New-Item -ItemType Directory` 判为「建目录」并放行**，与 Bash 侧 `mkdir` 的处置一致。但它同时也能建文件 —— 依赖 `-ItemType` 字面量，`New-Item foo` 会被当成建文件（更保守的方向）。
5. **标记绑定 session 是刻意的严格方向。** 标记里没有 `session_id` 时判**无效**（早期写法是「当通配」）。后者会在盘上留一个永久有效的标记：本会话建过一次，之后每个新会话都被静默放行，而日志里一切正常。
6. **只数「读过几个不同文件」，不校验读了哪几个。** 要求「必须含 README」是另一条判据，本轮没做。
7. **`permissionDisplay` 未用**（桌面专用、`@internal`、上游报告也没跑通）。

**装置的局限**：模型是假的。hooks、权限、工具循环、transcript、`continue:false`、`permission_denials` 都是真宿主的。凡涉及模型行为的推论，本文一律标「未实测」。

---

## 7. 与已有结论的关系

| 已有 | 本文的补充 |
|---|---|
| `2026-11-14-pretooluse-desktop-verification.md` §5.1：只 matcher `Write\|Edit` 会被 PowerShell 绕过（G6 实测） | **补上了那一半**：`powershellWriteScan` + 五个 matcher，t4 实测拦住 |
| 同上 §5.2：不要用计数器，用可观测状态（F1/F2） | **落成代码**：`markerValidity()` 查盘，`bumpDenials()` 只用于刹车。t5 实测重试绕不过去 |
| 同上 §5.5：「写前强制提问」不可行，「写前强制前置动作」可行 | **本文不推翻，只确认**。`AskUserQuestion` 在 reason 里是提示，不是强制；可机械核对的是「读过几个文件」和「标记在不在盘上」 |
| 同上 §5.4：`continue:false` 与「让模型先做别的事」互斥 | **给出可选的第三条路**：`brake=budget` 让前 N 次不刹车。t3（照着做，放行）与 t5（不听，刹车）各一组实测 |
| 同上 §6：`"shell": "powershell"` 别省 | 模板带上，测试守着 |
| `2026-11-13-critique-question-layer-product.md`：828 次介入里只有 **8.2%** 发生在首次写文件之前 | **本文不改变这个数。** 闸门做得到什么，跟「值不值得做」是两件事。技术可行性成立 ≠ 产品上该做 |

**最后一句自我约束**：这份报告不主张「应该把这个闸装进仓库」。默认是 `observe`，装上也什么都不拦。要不要开，得看 `tasks/runs/pre-write-gate/*.jsonl` 里 `would-deny` 的真实数量 —— 那个数字现在还没有，因为本仓没开。
