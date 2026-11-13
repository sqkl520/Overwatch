# 写前闸扩宽：要动哪些函数、哪几条测试会红

> **状态：设计，零行实现。** 本文只回答「把 `pre-write-gate.mjs` 的判据改宽，到底要动哪些地方」。
> 它**不主张应该改宽**；§5 给的补丁序列是执行顺序，不是立项理由。
>
> 依据：`scripts/pre-write-gate.mjs`（906 行）与 `scripts/observe-reality-check.mjs`（815 行）逐个函数读过，
> 数字来自本机实测（语料快照 442 份主 transcript / fork 去重后 417 / 真实有写 136 / 沙箱有写 69）。
> 基线：`node --test scripts/*.test.mjs` **1231 条全绿**（2026-11-14 实跑），`check-structure.mjs` 0 违规。

---

## 0. 一句话结论

判据「不同文件数 ≥ 3」本身只有一行代码（`pre-write-gate.mjs:611`），**改宽的成本不在那一行，而在三处**：
证据从哪来（I/O 边界）、重放器要不要同步（否则 `decide()` 复算与报告对不上）、以及**现有测试几乎不覆盖新证据通道**
（实测：新增续接/子 agent 两条通道，92 条相关测试**一条都不红**）。

---

## 1. 现状测绘

### 1.1 `decide()` 的签名与结构

`scripts/pre-write-gate.mjs:552`

```js
export function decide(input, state = {})
```

**`input`——宿主 stdin 原样传进来的对象。** `decide` 只读其中 6 个字段（逐条核过，`:560-630`）：

| 字段 | 行 | 用途 | 缺了会怎样 |
|---|---|---|---|
| `hook_event_name` | `:563` | 非 `PreToolUse` 直接 passthrough | 视为 PreToolUse |
| `tool_name` | `:567` | 交给 `writeIntentOf` 判写 | 走 `unknown-tool` 分支 |
| `tool_input` | `:568` | 同上 | `intent.isWrite=false` → 放行 |
| `cwd` | `:569` | 定位标记文件 | 回落 `state.cwd` → `process.cwd()` |
| `session_id` | `:495`（经 `markerValidity`）、`:615`、`:630` | 标记绑定、写进标记、reason 文案 | 标记无效（`no-session-in-input`） |
| `prompt_id` | `:615` | 写进标记 | 空串 |

**`transcript_path` 被 `decide` 完全没碰**——它只在 `runHook` 的 `getReads` 里出现（`:744`）。这是 §2(b) 的关键。

**`state`——宿主看不到，全由调用方给。** 字段逐个（`:553-630`）：

| 字段 | 行 | 类型 | 说明 |
|---|---|---|---|
| `config` | `:553` | 对象 | 缺省回落 `defaultConfig()`；**测试靠它注入** `mode/minReads` |
| `cwd` | `:569` | 字符串 | 仅当 `input.cwd` 缺失时用 |
| `markerPath` | `:570` | 字符串 | 缺省 `markerPathFor(cwd)` |
| `marker` | `:591` | `{exists,data,error}` | 已读出的标记（**`decide` 不读盘**） |
| `getReads` | `:607` | 函数 | 惰性证据源；`runHook` 注入，测试不注入 |
| `reads` | `:609` | `{paths:[]}` | 测试用的静态证据源 |
| `denials` | `:626` | 数字 | 只影响刹车，不参与判定（`:657`） |
| `gateCommand` | `:629` | 字符串 | reason 里那句可复制命令 |
| `denyBudget` | `:627` | 数字 | 仅 `brake=budget` 时用 |

**返回结构** `{action, output, markWrite, log}`（`:543-551` 有逐字段注释）：

- `action`：`passthrough` | `allow` | `warn` | `deny`。**`passthrough` 与 `allow` 在宿主上不等价**——
  前者不输出（本 hook 不参与合并），后者输出 `allow`（参与 `deny>ask>allow` 合并）。这个区分是实测结论，不是设计偏好。
- `output`：写到 stdout 的 JSON；`passthrough` 时恒为 `null`（`:556`）。
- `markWrite`：`{satisfiedBy, reads, promptId}` 或 `null`；**`decide` 只返回，落盘在 `runHook`**（`:764-772`）。
- `log`：一行记账对象，字段由各分支各自铺（`tool/via/unresolved/paths/marker/reads/decision/allowReason/mode/brake`）。

### 1.2 它把「读过」定义成什么

**判据函数：`readTranscriptReads(transcriptPath, {bytes})`，`pre-write-gate.mjs:348`。**
它是唯一的证据生产函数。核心循环：

```js
377:  for (const line of lines) {
381:    try { rec = JSON.parse(s); } catch { out.unparsable++; continue; }
382:    const content = rec && rec.message && Array.isArray(rec.message.content) ? rec.message.content : null;
384:    for (const b of content) {
385:      if (!b || b.type !== 'tool_use') continue;
388:      if (READ_TOOLS.includes(n)) { add(inp.file_path || inp.notebook_path || inp.path); continue; }
389:      if (n === 'Bash' || n === 'PowerShell') {
393:        for (const seg of cmd.split(/[;|&\n]/)) {
397:          const verb = basename(String(t[i] || '')).replace(/\.exe$/i, '').toLowerCase();
398:          if (!SHELL_READ_VERBS.includes(verb)) continue;
399:          for (const a of t.slice(i + 1)) {
400:            if (/^-/.test(a)) continue;
```

两个白名单决定「什么算读过」：

- `READ_TOOLS = ['Read', 'NotebookRead']`（`:102`）
- `SHELL_READ_VERBS = ['cat','head','tail','type','get-content','gc','more']`（`:105`，注释明写「刻意窄：`grep`/`ls` 不算读过内容」）

去重按 `pathKeyOf`（`:366-374`），**不同文件路径计数**，同一文件读 50 次算 1 个。

窗口：只读 transcript **尾部 `transcriptBytes`（默认 1 MiB，`:117`）**，从中间切进去的首行丢弃（`:364`）。

### 1.3 证据数组怎么构造、谁调用、hook 运行时从哪来

```
宿主 stdin ──► main() :864 ──► parseHookInput() :804 ──► runHook() :733
                                                            │
                        ┌───────────────────────────────────┴─────────────────┐
                        │ getReads() :742  （惰性的，闭包缓存 cached）        │
                        │   └─ readTranscriptReads(input.transcript_path) :745│
                        └───────────────────────────────────┬─────────────────┘
                                                            ▼
                                                      decide() :552
                                                        :607-609  取证据
                                                        :611      判是否够
```

**惰性是刻意的**（`:605-606` 注释）：标记在盘上时根本不需要 transcript。实测依据是硬约束——闸门挡在每一次写之前，慢就是体感伤害。

**hook 运行时**：`transcript_path` 由宿主给（实测原文见 `docs/research/2026-11-14-pretooluse-desktop-verification.md:54`），绝对路径，可读。
**重放时**：`observe-reality-check.mjs` 不走 `readTranscriptReads`，而是自己实现了一份同构的 `tailGateReads()`（`:393`）+ `gateReadPathsInText()`（`:423`）+ `gateReadsOf()`（`:275`）。
**这条双实现是扩宽的主要风险源**——两处判据必须同步，否则报告数字与真 `decide()` 会漂（历史上真漂过一次，27 vs 26，见 `observe-reality-check.mjs:386` 注释与测试 `verdict 与「gateReads 阈值判断」必须给出同一结论`）。

### 1.4 `mode` 在哪里分支，扩宽后各模式怎么变

| 模式 | 分支行 | 判定后的行为 | 扩宽后 |
|---|---|---|---|
| `observe`（默认） | `:632` | `action:'passthrough'`, `output:null`, `log.decision='would-deny'` | **只影响日志里 `would-deny` 的条数**。这是唯一有真实反馈的模式 |
| `warn` | `:639` | `action:'warn'`，输出 `permissionDecision:"allow"` + `additionalContext:reasonFor(...)` | 发出的提醒会**变少**，且不再拦 |
| `deny` | `:656-674` | 输出 `permissionDecision:"deny"`，`halt` 时加 `continue:false` | 真的少拦 |

**注意**：`mode` 只决定「判定为不够读之后怎么表达」，**不参与判定本身**。扩宽判据 = 让 `:611` 那个分支更容易命中，
三种模式的表现因此是**同向的**：命中越多，`observe` 日志越少 `would-deny`、`warn` 越少提醒、`deny` 越少拦。

### 1.5 现有测试里哪些钉住了「当前判据」

基线：`pre-write-gate.test.mjs` **66 条**，`observe-reality-check.test.mjs` **26 条**（`grep -c '^\s*test('` 实数，与全量 1231 条一致）。

**我没有猜——我在临时副本上逐个上变异、实跑，看哪条变红。** 结果如下（变异脚本放临时目录，仓库零改动）：

| 变异 | 变红的测试 | 结论 |
|---|---|---|
| (d) 只改闸门解析器：`-n 20` 不再把 `20` 当文件 | **无**（92 pass / 0 fail） | ⚠ 闸门侧**没有**测试守这条 |
| (d) 闸门 + 重放器**两处都改** | `gateReadsOf 跳过 shell 的选项参数，取第一个位置参数`（`observe-reality-check.test.mjs:88`） | 只有重放器那条钉住了 |
| (c) 只扩 `SHELL_READ_VERBS` | **无** | ⚠ 闸门侧无守 |
| (c) 只扩 `READ_TOOLS` | `READ_TOOLS 覆盖 Read 与 NotebookRead`（`pre-write-gate.test.mjs:448`） | 常量形状被钉死 |
| (c) 重放器 `GATE_READ_VERBS` 扩动词 | `gateReadsOf 只认 Read/NotebookRead 与整份读的 shell 动词`（`:75`） | 以及 §1.5 表下 item |
| (c) 扩动词**且**让 Glob/Grep 贡献路径 | 追加 `readTranscriptReads 从真实文件里数出不同路径（含截断首行）`（`pre-write-gate.test.mjs:403`） | 该测试第 412 行明写 `Grep` 「不算读」 |
| (a) 新增「续接即放行」通道 | **无**（92 pass / 0 fail） | ⚠ 全新通道零覆盖 |
| (b) 新增「子 agent 读并入计数」通道 | **无**（92 pass / 0 fail） | ⚠ 全新通道零覆盖 |
| 改 `defaultConfig().minReads` 3→2 | **无** | ⚠ **默认阈值没有被任何测试钉住** |
| 改 `log.reads` 的算法（加权） | **无** | ⚠ 日志字段无守 |
| 改 observe 的 `log.decision` 文案 | 5 条红（见下） | 该字段有守 |
| 删掉 `:611` 的 `minReads` 闸（恒 false） | 5 条红：`verdict 与…同一结论`、`buildReport 端到端…`、`transcript 里读够 minReads…`、`负向：把 minReads 调高…`、`runHook 读到足够 transcript…` | 主路有守 |
| 把 `:611` 的阈值改宽但重放器 bucket 不动 | `verdict 与「gateReads 阈值判断」必须给出同一结论` | **这是最强的一条不变量** |
| 改 reason 文案里「至少 N 个源码文件」 | 2 条红：`reason 含可复制的命令…`、`reason 里的读取数随 minReads 变…` | 文案与判据不许漂 |
| 把 `warn` 分支短路掉（`if (false && mode==='warn')`） | **无** | ⚠ **`warn` 模式没有专门测试** |

**逐条列「扩宽会让哪几条变红」（按扩宽类型）**：

**扩宽 (d)（修参数误解析）会红 1 条：**
- `observe-reality-check.test.mjs:88` `gateReadsOf 跳过 shell 的选项参数，取第一个位置参数`
  —— 它第 94-95 行**故意钉住现状**：`assert.deepEqual(gateReadsOf('Bash',{command:'head -n 20 a.mjs'}), ['20'])`，注释写着「将来修了这条，测试会红，提醒同步改报告」。

**扩宽 (c)（结构性动词）会红 2 条：**
- `observe-reality-check.test.mjs:75` `gateReadsOf 只认 Read/NotebookRead 与整份读的 shell 动词`
  —— 第 81-85 行断言 `ls`/`grep`/`git log`/`Glob`/`Grep` **都返回 `[]`**。
- `pre-write-gate.test.mjs:403` `readTranscriptReads 从真实文件里数出不同路径（含截断首行）`
  —— 第 412 行 `toolUseLine('Grep', {pattern:'x'})` 被注释成「不算读」，断言 `r.paths` 恰好等于 3 个路径。
- 若同时改 `READ_TOOLS`：追加 `pre-write-gate.test.mjs:448`（`deepEqual([...READ_TOOLS].sort(), ['NotebookRead','Read'])`）。

**扩宽 (a) / (b)：零测试变红。** 这是本文最该被看到的一条——两条新证据通道目前**没有任何回归网**。

---

## 2. 扩宽的四条路，各自要动哪里

### (a) 续接会话的上游读

**要动**：`decide()` 新增一条判定分支（建议插在 `:611` 之前）；`runHook()` 新增一个惰性 provider（`:742` 旁）。

**hook 运行时能不能拿到这个数据——分两半回答，实测不同：**

1. **能不能知道「我在续接」**：能，但**不是从 stdin 字段**。`docs/research/2026-11-14-pretooluse-desktop-verification.md:51-63` 抓到的是完整 stdin，九个字段里**没有** `resumed` / `continued` / `parent_session` 之类。
   续接信号只在 transcript 的**第一条 user 消息正文**里：`"This session is being continued from a previous conversation…"`。
   重放器已经识别它——`CONTINUATION_RE`（`observe-reality-check.mjs:554`）/ `isContinuation()`（`:556`）。
   **所以这条路的实现形态是：读 transcript 头部，而不是读 stdin。**
2. **头部读得够不够**：实测 63 个有写的续接会话，标记的字节偏移 p50 = **72,777**、p90 = **570,066**、max = **1,130,826**。
   - 头部读 64 KiB 覆盖 19/63；
   - 262 KiB 覆盖 49/63；
   - 1 MiB 覆盖 62/63。
   **而现在的尾窗口只覆盖 29/63**（首写前 1 MiB 内）。要么加一次头部读，要么把窗口扩到「头 + 尾」两段。
3. **上游读在哪**：**这一条是硬边界。** `measure-gate-ceiling.mjs` 的实测记录（`scripts/measure-gate-ceiling.mjs:33-42`）：
   69 个续接会话里 `compactSummary.parentUuid` 能唯一解析到同目录兄弟 transcript 的只有 **12** 个；
   且「压缩前的 `tool_use` 记录**一条都不在本文件里**」（63/63 个有写续接会话 `preCompact = 0`）——
   **transcript 在压缩点被重写，历史不在盘上。**
   所以 (a) 能做到的上限是「**因为这是续接，所以放行**」（一条 self-declared 的豁免通道），
   而不是「去上一段会话里数它读过什么」。
   **这是判据的形态变化，不是权重的调整**——它把闸门从「验证」降级成「信任宿主的话」。

**纯函数性**：会被破坏，除非把「读头部」放进 provider。`decide` 保持纯的写法：`state.continued === true`（布尔），
由 `runHook` 在 `state` 里填，`decide` 只读布尔。**不要在 `decide` 里 open 文件。**

### (b) 子 agent 的读

**要动**：新增一个读子 agent transcript 的函数（建议新文件或 `pre-write-gate.mjs` 的 §transcript 段），
`runHook()` 注入 `state.subagentReads`，`decide()` 在 `:607-609` 之后并进证据集合。

**纯函数性——这个边界必须说清，二选一：**

- **方案 B1（推荐）：evidence provider。** `decide` 只接受 `state.subagentReads = string[]`（已归一化路径数组）。
  读盘全部在 `runHook` 里，跟 `getReads`（`:742`）完全同构。好处：`decide` 的纯函数性一点不变，
  测试可以继续用 `stateFor({reads})` 那种注入；坏处：`runHook` 变重。
- 方案 B2：`decide` 内部按需读。**不要这么做**——它会让 `decide` 不可单测，直接推翻 `:541` 的「不读盘、不写盘、不读环境变量」契约，
  并使 §1.5 里那些穷举式测试失效。

**hook 运行时能不能拿到这个数据——实测能，但有三个代价：**

1. **路径可推导**。子 agent transcript 在 `<transcript_path 去掉 .jsonl>/subagents/agent-*.jsonl`。
   实测 435 份主 transcript 里 **105** 份有该目录（`observe-reality-check.mjs:580`、`:623` 用的是同一推导）。
   注意有**两层**：`subagents/` 下直接文件 3723 个、子目录（`workflows/wf_*`）9 个。
   `scan-sessions.mjs:376-392` 的 `collectSubagentFiles` 是递归版，**只扫一层会漏**（该函数注释：实测 37% 在嵌套层）。
2. **成本**。全语料 3703 个子 agent jsonl / **6.16 GB**；单会话最多 **243 份**。
   尾部 256 KiB 读 243 份 = 60.7 MB / **321 ms**；**完整 JSON.parse** 同目录 = **1451 ms**。
   模板里 hook 的 `timeout` 是 10 秒、脚本内预算 `DEFAULT_BUDGET_MS = 5000`（`:816`）。
   **接进 hook 必须先加「取尾部 + 只解析 tool_use + 上限文件数」三重限制，否则最坏会话会吃掉一半预算。**
3. **归属不可靠**。`meta.toolUseId` 与主 transcript 的 `tool_use.id` 旧格式配不上（`toolu_bdrk_…` vs `call_…`）。
   实测 3613 个 meta 配上 3419（94.6%），但**失配集中在被拦集合上**（27 个被拦里 8 个一条都配不上）。
   所以 (b) 天然要分「严格」与「宽松」两档，对应 `subagentReadsByToolId()`（`:579`）与 `looseSubagentReads()`（`:622`）。
   **严格档才是「读发生在首写之前」；宽松档只证明「这个会话有子 agent 且它们读过」。**

### (c) 结构性探索（`ls`/`find`/`git log`/`Glob`/`Grep`）

**要动三处，缺一不可：**

1. 动词表：`SHELL_READ_VERBS`（`pre-write-gate.mjs:105`）。语义分类表已经在重放器里现成——
   `STRUCT_VERBS`（`observe-reality-check.mjs:70`，11 个动词）、`CONTENT_VERBS`（`:73`）、`STRUCT_TOOLS`（`:76`，5 个工具名）。
2. `readTranscriptReads` 的 `Bash`/`PowerShell` 分支（`:389-406`）要能产出**非路径**证据（`struct:ls:<指纹>`），
   否则同为 `ls` 的不同命令会被 `pathKeyOf` 压成 1 个。
   重放器已经踩过这个坑：`broadReadsOf()` 的注释（`:301-304`）明写「刻意不按动词去重……第一版按动词去重导致宽口径严重低估」。
3. `READ_TOOLS`（`:102`）要加 `Glob`/`Grep`，且 `:388` 那一行的 `file_path||notebook_path||path` 要改成「没路径时用 pattern 造指纹」，
   否则 Glob/Grep 贡献空串被 `add()` 丢掉（`add` 的 `if (!v) return`，`:369`）。

**「每个动词贡献多少权重」——这必须由数据定，不能拍。** 实测（窗口口径，真实 136 条）：

| 结构性权重 | would-deny | 相对基线 |
|---|---|---|
| 不计（现状） | 27/136（19.9%） | — |
| 每次探索算 0.25 个文件 | 22/136（16.2%） | −5 |
| 每次探索算 0.5 个文件 | 16/136（11.8%） | −11 |
| 每次探索算 1 个文件 | 15/136（11.0%） | −12 |

**权重从 0.5 提到 1.0 只多救 1 个会话**——说明结构证据要么有（≥3 次）要么没有，中间地带很薄。
**这条曲线本身是「不该细调权重」的证据**：0.5 与 1.0 的差别落在噪声里。

**纯函数性**：不受影响（只改 provider 内部解析）。**hook 运行时能拿到**：能，`tool_input` 是完整的（实测结论见
`2026-11-14-pretooluse-desktop-verification.md:81-82`），`ls`/`find`/`git log` 的命令原文都在。

### (d) `head -n 20` 之类的参数误解析

**词法解析器有两份，必须同改：**

| 位置 | 行 | 现状 |
|---|---|---|
| 闸门 `readTranscriptReads` 内联 | `pre-write-gate.mjs:393-405` | `if (/^-/.test(a)) continue;`（`:400`）——只看「以 `-` 开头」，不看「这个开关吃一个值」 |
| 重放器 `gateReadsOf` 内联 | `observe-reality-check.mjs:285-296` | 同构，`:291-292` |

**实测这条缺陷的真实方向与量级**（基线核对过：27/136，与已发布报告一致）：

- 现状：`head -n 20 a.mjs` → `['20']`，`tail -c 512 c.mjs` → `['512']`（我用 `readTranscriptReads` 实跑确认）。
- 修掉之后 **would-deny 从 27 升到 28（19.9% → 20.6%）**，唯一翻转的会话是 `be6b89cf`（4 个 → 2 个）。
  **方向是变严，不是变宽。** 与 `docs/research/2026-11-14-observe-mode-reality-check.md:192` 记的「影响 1/136」一致。

**修的边界在哪**：只要加一张「吃一个值的开关」表。重放器侧已有一份可抄：`redteam-gate-widening.mjs:45` 的
`/^-(?:n|c|lines|bytes|tail|max-count|m)$/i`；`measure-gate-ceiling.mjs:79` 有一份更宽的
`/^-(?:n|c|lines|bytes|max-count|m|k|d|s|e|q|v|z|width)$/i`。
**两份不一致本身就是待收的技术债**——现在已有三份各自维护的值表（`redteam:45`、`ceiling:79`、以及闸门里还没有）。

**纯函数性**：不受影响。**hook 运行时能拿到**：能，纯文本解析。

---

## 3. 权重设计空间：三种形态的评估

三种形态在**同一快照**上的实测（真实 136 有写 / 沙箱 69 有写，全部 1 MiB 尾窗口口径）：

| 形态 | 真实 would-deny | 沙箱阴性对照 | 现有测试变红 |
|---|---|---|---|
| 现状 `gate>=3` | 27/136（19.9%） | 51/69（73.9%） | — |
| **形态 1** 并进同一计数（+struct 1:1 +sub） | 1/136（0.7%） | 50/69（72.5%） | 0 |
| **形态 1** 并进同一计数（+struct 0.5 +sub） | 1/136（0.7%） | 51/69（73.9%） | 0 |
| **形态 1** 只并结构性（1:1） | 12/136（8.8%） | 51/69（73.9%） | 2（见 §1.5） |
| **形态 2** OR（`struct>=3 ∨ sub>=3 ∨ cont`） | 1/136（0.7%） | 51/69（73.9%） | 0 |
| **形态 3** 分档（强 `cont∨sub>=3` 放行；弱 `struct>=3` 降阈到 1） | 3/136（2.2%） | 51/69（73.9%） | 0 |
| **形态 3′** 分档（强 `cont∨sub>=3` 放行；弱不降阈） | 4/136（2.9%） | 51/69（73.9%） | 0 |

### 形态 1：并进同一个计数

- **现有测试**：如果不改 `READ_TOOLS`/`GATE_READ_VERBS` 的常量形状，**一条都不红**。若动常量，红 §1.5 里那 3 条。
- **`observe` 日志还能不能分桶**：**不能，除非加字段。** 现在 `log.reads = reads.length`（`:610`）是一个标量。
  并集之后这个数不再回答「读过几个文件」。**必须同时输出分项**（`log.readsFiles` / `log.readsStructural` / `log.readsSub`），
  否则 `observe` 日志失去唯一的诊断价值——而 `observe` 是**默认模式**，日志是这闸门唯一被使用的产物。
- **会不会永远放行**：不会，沙箱桶仍拦 50-51/69。但**注意**：形态 1 把三种强度完全不同的证据压成一个标量，
  「1 个 `ls`」与「1 个 `Read`」在这个数里不可区分。而实测已经证明**权重细调到 0.5 vs 1.0 只差 1 个会话**，
  说明这个标量其实分辨不出东西。

### 形态 2：多信号 OR

- **现有测试**：0 条红（我实跑过）。**这既是优点也是问题**——说明现有测试完全没守这条路径。
- **`observe` 日志还能不能分桶**：**能，而且比形态 1 更好**。每条信号可以单独记一个布尔/计数
  （`log.cont` / `log.subReads` / `log.structural`），事后能回答「这次放行是被哪条信号放掉的」——
  正对应 `attribute()` 已有的五类归因（`observe-reality-check.mjs:658`），分桶口径天然对齐。
- **会不会永远放行**：**这是形态 2 唯一的真风险，而且它已经发生了**。
  实测：真实项目里 `struct>=3` 的会话占 **121/136（89.0%）**；`sub>=3` 占 **96/136（70.6%）**；续接占 **54/136（39.7%）**。
  三条 OR 起来 → would-deny 掉到 **1/136**。
  沙箱桶没掉（51/69），所以**不是恒真**；但**真实项目上它已经接近不判了**。
  如果用 `cont` 作为 OR 项，那 39.7% 的会话**永久免检**（一次续接 = 一次豁免），强度远低于其它两项。

### 形态 3：分档

- **现有测试**：0 条红（实跑）。同样没有回归网。
- **`observe` 日志还能不能分桶**：能。分档天然带「落进哪一档」的字段，比形态 2 更好——它同时给出**档位**与**证据**。
- **会不会永远放行**：取决于「强档」怎么定义。
  - 强档含 `cont` → 39.7% 会话免检（与形态 2 同问题）。
  - 强档只含 `sub>=3` → 70.6% 会话免检，仍偏高，但至少是「有据可查的读」。
  - **弱档「`struct>=3` 降阈到 1」这一档几乎没有增益**：实测 T1 与 T3（降阈到 1 vs 不降阈）都只到 3/136。
    这说明**降阈这个动作是空转的**——真正在起作用的是「强档直接放行」。

### 推荐

**推荐形态 3′（分档，强档 = `cont` 与 `sub>=3` 分列两个独立信号，弱档不动阈值），理由三条，都可复核：**

1. **它保住了 `observe` 的分桶能力**，而 `observe` 是默认模式、日志是唯一产物。形态 1 会把那个标量搅浑。
2. **它的效果与形态 2 几乎相同（4/136 vs 1/136），但不把「1 个 `ls`」与「1 个 `Read`」放进同一个 OR。**
   形态 2 的 OR 让 89% 的真实会话只要碰过 `ls` 就免检；形态 3′ 要求的是「子 agent 真读过 3 个文件」这种强信号。
3. **实测显示权重细调是空转**（§2c 的 0.5 vs 1.0 只差 1 个会话；§3 的弱档降阈 vs 不降阈都是 3/136）。
   形态 3′ 的「档位」是离散的，不必为权重编一个没有数据支撑的系数。

**不推荐的**：形态 1 的「加权求和」（权重没有数据支撑，且摧毁日志）。**需要单独立项的**：`cont` 作为放行依据——
它是「信任宿主声明」，与「验证」是两种东西，不该混进同一个补丁。

---

## 4. 会破坏什么

### 4.1 钉住「阈值 3」「五类归因」「19.9%」的地方

**`checkDocConstants()`（`scripts/check-structure.mjs:1458`）核什么、不核什么：**

```js
1465:    for (const m of t.matchAll(/^const ([A-Z][A-Z0-9_]{2,}) = (\d[\d_]*)(?:;|\s*\/\/|\s*$)/gm)) {
1477:      for (const m of line.matchAll(/`([A-Z][A-Z0-9_]{2,}) = (\d[\d_]*)`/g)) {
```

- **核**：活文档里的 `` `CONST = 42` `` 形态（`LIVING_DOCS` 15 份，`:1370-1386`），与 `scripts/*.mjs` 里 `^const CONST = <数字>` 比对。
- **不核**：散文里的数字（注释明写「不查散文里的数字」）。
- **`minReads` 不在这个网的覆盖里**：它是 `defaultConfig()` 里的**对象属性**（`:115`），不是顶层 `const`，
  正则 `^const ([A-Z]...)` 抓不到。**实测确认**：改 `minReads: 3` → `2`，`check-structure.mjs` 仍绿、测试仍全绿。

**逐处结论：**

| 数字 | 钉在哪 | 改了会红吗 |
|---|---|---|
| 阈值 3（默认值） | `pre-write-gate.mjs:115`；文案里「至少 N 个源码文件」（`:518`）由 `minReads` 派生，不写死 | **不会红**（无测试守默认值；`checkDocConstants` 抓不到对象属性） |
| 「五类归因」 | `ATTRIBUTION_CLASSES`（`observe-reality-check.mjs:671`）；`observe-reality-check.test.mjs:372` 断言「五类计数之和 = 被拦数」 | 加第六类：**会红**（该测试断言的是和等于被拦数，加类不影响和，但它们同时断言了 A/C/D 各 1）；改名：红 |
| 19.9% | `docs/research/2026-11-14-observe-mode-reality-check.md`（多处）、`docs/research/README.md:153` | **不会红**。research 是历史记录，`checkDocConstants` 明确不查历史条目（`check-structure.mjs:279` 注释）。但**它会变成一句已经过期的话**——仓库规矩是 research 会过期，新结论要写新报告 |
| 136 / 27 / 49 等 | 同上（research）+ `measure-gate-ceiling.mjs:30-33` 的**硬断言** | research 不红；`measure-gate-ceiling.mjs` 的基线断言**会红**（它 exit 1）——这是**好事**，它是设计来红给你看的 |
| 66 条 / 26 条测试数 | 分散在 research 文档 | 不红（历史记录） |
| 总测试数 1231 | `README.md:150`、`CLAUDE.md:42`、`.github/workflows/validate.yml:24`、`docs/GUIDE.md:451` 四处 | **会红**。`checkTestCount()`（`:267-302`）数 `^\s*test(` 并四处对账（对照表在 `:280-285`）。**任何新增测试都必须同步这四个数字** |
| `reason` 文案里的「至少 N 个源码文件」 | `pre-write-gate.test.mjs:487`、`:495-500` | **会红**（实跑确认，2 条） |

**结论**：扩宽**不会**被文档常量门拦住，也**不会**被测试拦住（除 §1.5 列的那 3+2 条）——这正是麻烦所在。
改宽之后必须**主动**去更新 `docs/research/` 的索引状态（`docs/research/README.md` 的「已被推翻的结论」表），
否则那里会留着一句「19.9%，其中 88.9% 是闸门看不见的读」而代码已经不是那样。

### 4.2 `docs/CAPABILITIES.md` 有没有登记闸门

**没有。** 实测：`docs/CAPABILITIES.md` 里 `pre-write-gate` 出现 **0** 次、`写前闸` **0** 次。

- `checkCapabilities()`（`:1529`）只校验**已登记**的命令（脚本存在 + `--flag` 存在），未登记的不受管。
- 但 `README.md` 里也 0 次 → 不存在「README 承诺了而清单没登记」的悬空。
- **改了行为要不要同步？** 按仓库规矩（`CAPABILITIES.md:102`）：「加了能力 → 这里加一行，README 加一行」。
  **扩宽不是新能力**，是既有判据的参数变化，因此**不强制**。但**如果扩宽后打算把默认模式从 `observe` 改掉**，
  那就是能力级变化，必须登记——而且 `README.md` 与 `CAPABILITIES.md` 两处都要。
- **另一个门**：`checkDocCommands()`（`:1423`）会检查活文档里写的 `node` + 脚本路径 + `--flag` 三件套是否真实存在。
  如果扩宽引入新 env（如 `OW_PRE_WRITE_GATE_STRUCTURAL=1`），**模板 `templates/pre-write-gate.settings.json` 的说明段要同步**
  （它不在 `LIVING_DOCS` 里，所以不会红，但它是用户唯一会读的启用说明）。

### 4.3 CHANGELOG 硬规则的具体形态

`checkChangelog()`（`scripts/check-structure.mjs:1064`）：

- 规则原文在 `docs/CHANGELOG.md:9`：「**任何代码/配置/文档的更改都必须记入本 CHANGELOG**」。
- 机械形态（`:1103-1104`）：
  ```
  SOURCE_RE = /^(scripts\/|\.claude\/|docs\/|templates\/|rules\/|README\.md|CLAUDE\.md)/
  SKIP_RE   = /^(tasks\/runs\//
  ```
  取 `git log -60`，找「最后一个改动过 `docs/CHANGELOG.md` 的提交」作为**边界**（`:1106-1111`），
  只检查边界之后的提交；若某提交触及 `SOURCE_RE` 且未被**任何** CHANGELOG 里出现的 7-40 位 hex 引用 → `fail`。
- **两条豁免**（`:1096-1100`）：改 CHANGELOG 本身的提交视为已记录（自文档豁免）；`tasks/runs/` 不算。
- **对本文档的影响**：`docs/` 在 `SOURCE_RE` 里。**只新建 `docs/design/2026-11-14-gate-widening-patch-plan.md`
  （且同时改 `docs/design/README.md` 加索引行）本身就是一次 `docs/` 改动**，
  所以提交时必须同时写 CHANGELOG 条目，否则下一次硬门会红。
  （`docs/design/README.md` 的登记是 `checkDesignIndex()` 的硬要求：`docs/design` 下每个 `.md` 都必须出现在索引里，`:1310-1315`。）

---

## 5. 最小可行补丁序列

每个补丁：改动点 → 预期测试影响 → 预期 would-deny 方向 → 能否独立回滚。
**依赖关系**：P0 → P1 → {P2, P3}，P4 依赖 P2+P3。

### P0：给要改的东西先建回归网（**先做，且单独提交**）

- **改动**：不碰闸门。在 `pre-write-gate.test.mjs` 里为 §1.5 标 ⚠ 的空白补测试：
  (i) `readTranscriptReads` 的 `head -n 20` 现状（把缺陷钉住，让 P1 会红）；
  (ii) `decide` 在 `state.continued===true` 时不改变现有行为（现在没有这个字段，所以测试先断言 `undefined` 被忽略）；
  (iii) `defaultConfig().minReads === 3`（默认值无守）；
  (iv) `warn` 模式的专门测试（分支零覆盖）；
  (v) `log.reads` 是「不同文件数」的语义。
- **预期测试影响**：**0 红**，条数 +N。**必须同步 4 处数字**：`README.md:150`、`CLAUDE.md:42`、`.github/workflows/validate.yml:24`、`docs/GUIDE.md:451`。
- **would-deny**：不变（27/136）。
- **可独立回滚**：可以，纯测试。**但它必须最先做——否则后面每个补丁都是「改了不知道坏什么」。**

### P1：修 (d) 参数误解析，两份解析器同改

- **改动**：`pre-write-gate.mjs:399-404` + `observe-reality-check.mjs:291-295`，抽一张共享的值表
  （建议放 `pre-write-gate.mjs` 并 export，让 `observe-reality-check.mjs` 复用——**同时消掉
  `redteam-gate-widening.mjs:45` 与 `measure-gate-ceiling.mjs:79` 那两份重复值表**）。
- **预期测试影响**：P0 建的 (i) 会红，**改为断言 `['a.mjs']`**；`observe-reality-check.test.mjs:88` 会红，同步改。
- **would-deny**：**升** 27 → 28（变严 1 个，实测确认唯一翻转 `be6b89cf`）。**注意方向与「扩宽」相反。**
- **可独立回滚**：可以。**这是唯一一个「让闸门更严」的补丁，应该单独提交，避免和扩宽混在一起看不清方向。**

### P2：扩 (c) 结构性探索（依赖 P1 的共享值表）

- **改动**：`SHELL_READ_VERBS`（`:105`）加 `STRUCT_VERBS`（`observe-reality-check.mjs:70` 的 11 个）；
  `READ_TOOLS`（`:102`）加 `Glob`/`Grep`；`:388` 在无路径时用 pattern 造指纹；
  `:389-406` 允许产出非路径证据并按 `fingerprint` 去重。
- **预期测试影响**：红 3 条 —— `observe-reality-check.test.mjs:75`、`:88`（部分）、`pre-write-gate.test.mjs:403`、`:448`。
  全部是「钉住旧判据」的断言，**改测试是对的，但必须在提交信息里写明为什么**（`docs/GUIDE.md:451` 那段规矩）。
  **必须新增**一条测试钉住「结构性证据不能被 pathKeyOf 压成 1」——重放器已经踩过这个坑（`observe-reality-check.mjs:301-304`）。
- **would-deny**：27 → 15（同权）/ 16（0.5 权）。**降 11~12 个。**
- **可独立回滚**：可以。**但注意**：结构性证据单独上线就让 89% 的真实会话接近免检，是四条路里**面最宽**的一条。

### P3：扩 (b) 子 agent 读（依赖 P0，与 P2 无依赖，可并行）

- **改动**：新函数 `subagentReadsOf(transcriptPath, {maxFiles, bytesPerFile})`（严格档 + 宽松档两个返回值，
  对应 `subagentReadsByToolId`/`looseSubagentReads` 的语义）；`runHook` 注入 `state.subagentReads`；
  `decide` 在 `:607-609` 后并入；`log` 加 `log.subReads` / `log.subMatched`。
  **必须带 `maxFiles` 上限**——实测最坏会话 243 份、完整解析 1451 ms，而预算是 5000 ms。
- **纯函数性**：由 evidence provider 保住（§2b 方案 B1）。`decide` 只收数组。
- **预期测试影响**：0 红（现在没有守这条的测试）。**P0 必须先补**，否则这个补丁是黑的。
- **would-deny**：27 → 5（并入同计数）/ 参与 OR 时 → 1。**降 22 个，面最大的一条之一。**
- **可独立回滚**：可以。**但要先决定用严格档还是宽松档**——两档差 12 个会话（严格救 5、宽松救 18，实测），
  宽松档的归属不成立（旧格式配不上），**选宽松档等于把「有子 agent」当豁免**。

### P4：扩 (a) 续接（依赖 P3 的 provider 框架）

- **改动**：`runHook` 加一次**头部读**（实测需要 262 KiB 覆盖 49/63，1 MiB 覆盖 62/63）；
  `decide` 新增 `state.continued` 分支。**上限写清**：只能做到「续接即放行」，
  做不到「去上一段会话数读」——压缩前的 `tool_use` 一条都不在盘上（`measure-gate-ceiling.mjs:33-42`）。
- **预期测试影响**：0 红。**必须新增**测试钉住「`continued` 是 self-declared，日志里要能区分」。
- **would-deny**：27 → 4（分档，不含降阈）。
- **可独立回滚**：可以，**但语义代价最大**：39.7% 的真实会话在此之后永久免检。
  **建议单独提交并单独在 CHANGELOG 里说明「这是从验证降级成信任」。**

### 一个不该做的补丁

**不要把默认 `minReads` 从 3 改成 1 或 2 当作「扩宽」。** 实测阈值 1 是 13/136（9.6%）、阈值 2 是 22/136（16.2%）。
它与「扩宽判据」是两条正交的路：前者放宽**同一个判据**的门槛，后者改变**判据本身**。
混在一起提交会让 `observe` 日志无法归因（哪个变化导致的？），而日志是这闸门唯一的产物。

---

## 6. 诚实边界

1. **语料在本次工作中从 432 涨到 442 份**（并行任务在写 transcript）。所有百分比都用**同一快照**（442/417/136/69）重跑过；
   但 `136` 这个分母与已发布报告的 `136` 恰好相同——这是巧合，不是同一个快照。**引用数字时请连快照一起引**。
2. **`would-deny` 不是误伤率。** 这一条沿用 `docs/research/2026-11-14-observe-mode-reality-check.md:190` 的口径，本文没有改变它。
   本文所有「降了多少」都是「触发拦截的比例降了多少」，**不是**「误伤减少了多少」。
3. **本文没有真实模型行为数据。** `claude -p` 在本机被认证闸挡住（同上 §2.1）。所有结论都是对 transcript 的重放。
4. **§3 的推荐基于两条实测事实**（日志分桶能力、权重细调空转），不是基于「哪种形态更好用」的判断。
   「闸门该不该装」不是本文的问题，本文只回答「要改宽该动哪里」。
5. **沙箱阴性对照只到 69 条。** 形态 1 把沙箱拦数从 51 打到 50，**这 1 条的差落在噪声里**，
   不能据此说形态 1「削弱了闸门」——但它也不能反证没削弱。**唯一可靠的架空指标是沙箱拦数掉到 0，而所有形态都没掉到 0。**
