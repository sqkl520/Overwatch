# 写前闸判据按首写工具拆分（现行规格）

> 本文件是 `scripts/pre-write-gate.mjs` **现行判定逻辑**的规格，不是设计推演。
> 与代码冲突时以代码为准，并就地修本文（`docs/README.md` 的「四类文档」表）。
>
> 依据裁决：`../research/2026-11-14-gate-widening-resolution.md`（P1）。
> 反向证据与绕过路径：`../research/2026-11-14-gate-widening-redteam.md`。
> 消融与阴性对照：`../research/2026-11-14-gate-widening-ceiling.md`。
> 19.9% 的来源与口径：`../research/2026-11-14-observe-mode-reality-check.md`。
> 为什么闸门宁可降级也不假装：`../adr/0002-honest-degradation.md`。
>
> **语料快照（本文所有语料数字都锁在这一行）**：
> 主 transcript **435** · 解析 435 · fork 去重后 **410**（合并 25）·
> 真实项目 234（**有写 136**）· 沙箱 176（**有写 66**）。
> 复算：`node scripts/resolution-gate-audit.mjs --only R8`（首两行逐字打印这六个数）。
> 语料是活的，换一次快照绝对数会浮动；比率同量级。
>
> 行号以 2026-11-14 的实现为准。函数名与常量名比行号稳，优先按名字找。

---

## 0. 一句话

闸门从「一次写之前，读过 ≥ `minReads` 个不同文件」拆成两条判据：
**改已有文件（`Edit` 家族）判「读过这个文件本身」，新建/覆盖与 shell 写入（`Write` / `Bash` / `PowerShell`）判据一字未改。**

这不是放宽阈值，是**换锚点**：`Edit` 侧比原来更严（不再允许「读了三个无关文件就算过关」），`Write` 侧逐字节不变。

---

## 1. 判据表

| 工具 | 改动前 | 改动后 | 依据 |
|---|---|---|---|
| `Edit` / `MultiEdit` / `NotebookEdit` | `已读不同文件数 ≥ minReads`（默认 3） | **`pathKeyOf(目标) ∈ 已读路径集合`** 即放行；**不满足就拦，没有「读够 N 个」兜底**（见 §1.2） | R8 |
| `Write` | `已读不同文件数 ≥ minReads` | **不变**（同一行代码，未被 Edit 分支影响） | R8 + AC3 |
| `Bash` / `PowerShell` 的写入 | 同上 | **不变** | 同上 |
| 闸门自有文件（`.claude/.ow-*`，密钥除外） | `passthrough / gate-own-file` | **不变** | 自锁要求 |
| 密钥文件（`.claude/.ow-gate-secret`）的写 | 原先落在自锁白名单内 | **`passthrough / secret-tamper`**（不进白名单） | 签名不可被改密钥绕过 |

判据落点（按名字找，不按行号）：`decide()` 内 `const editSide = EDIT_SIDE_TOOLS.includes(tool)` 起，
到 `if (!editSide && cfg.minReads > 0 && reads.length >= cfg.minReads)` 为止。`EDIT_SIDE_TOOLS` 是导出常量，
只含三个 `Edit` 家族工具名，**`Write` 绝不在内**。

### 1.1 「已读」的定义（两条判据共用，未变）

- 工具：`Read`、`NotebookRead`（`READ_TOOLS`）；
- shell 动词：`cat` `head` `tail` `type` `get-content` `gc` `more`（`SHELL_READ_VERBS`，刻意窄，`ls`/`grep` 不算）；
- 去重键：`pathKeyOf()` = 反斜杠→正斜杠、折叠重复斜杠、去尾斜杠、**小写**。它**不做** `resolve()`：
  `src/a.mjs` 与 `/repo/src/a.mjs` 是两个不同的键。这一条被测试钉住（`pre-write-gate.test.mjs` 的
  `pathKeyOf 归一化：Edit 的目标与实际读到的路径只靠它比对`）。
- 证据窗口：transcript **尾部 `transcriptBytes`（默认 1 MiB）**，从中间切进去时丢首行。

### 1.2 `Edit` 侧「不设阈值兜底」是本规格的选择，理由是实测

| 事实（语料快照见文首） | 真实项目 | 沙箱 |
|---|---|---|
| 首写是 `Edit` 家族 | 18 | 8 |
| 其中首写前**读过目标文件本身** | **18（100%）** | 7 |
| 其中「读够 ≥3 个」 | 14 | 7 |
| **「读够 ≥3 个」但没读目标** | **0** | **0** |
| 首写即被拦（阈值 3） | 4 | 1 |
| 上一条里**读过目标**的（= 纯误伤） | **4 / 4（100%）** | **0 / 1** |

复算：见 §6 复算 R2。

**两种读法在现有语料上一次都没分开过**（那一格是 0）。所以「兜底与否」目前**不可观测**，
不构成取舍依据。选「不兜底」的理由是方向：它与宿主自带的文件读取门一致（宿主对「改一个没读过的既有文件」本来就会报错），
而「读了 3 个无关文件就允许改第 4 个没读过的文件」是纯粹的放松。**若将来语料里出现那一格 > 0，
本文要重写这一节，并给出兜底的实测代价。**

### 1.3 目标锚定放行**不写标记**

`allowReason:"target-read"` 的返回里 `markWrite` 恒为 `null`。理由是可验证的：
它只证明「这一个文件读过」，不证明「读过这个项目」。若它写标记，后续每一次 `Write` 都会被一条更弱的证据永久放行——
那才是真的把闸门拆掉。代价见 §3.2。

---

## 2. 验收标准（一票否决）

格式按 `dispatch-contract.md` §5。**每条的 `evidence` 都是可跑的命令或可查的测试名**，
不是「看起来对」。全部在语料快照 S0（文首那一行）上实跑过。

| id | criterion | evidence | fail_if |
|---|---|---|---|
| **AC1** | `Edit` 的 `intent.paths` 任一命中已读集合 → `action:"allow"`、`allowReason === "target-read"`、`markWrite === null`；`MultiEdit` / `NotebookEdit` 同样成立 | 测试 `Edit：读过目标文件本身 → 放行，allowReason 是 target-read`、`MultiEdit / NotebookEdit 归到 Edit 侧`；手工复现见 §6 复算 R3 | 返回 `deny`；或 `allowReason` 与 `auto-satisfied-by-transcript` 混在同一个值里（分不出桶就等于没有这个判据）；或 `markWrite` 非 `null` |
| **AC2** | **负向**：`Edit` 未读目标、但读了别的 5 个不同文件 → 仍 `deny` | 测试 `负向：Edit 没读过目标、但读了别的 5 个文件 → 仍拦`；`node scripts/resolution-gate-audit.mjs --only R8` 的交叉表那一格 | 返回 `allow`，或 `allowReason` 变成阈值类的值。**这条不过 = Edit 侧被整体放宽了，必须否决** |
| **AC3** | `Write` / `Bash` / `PowerShell` 的判定与改动前**集合相同**：对同一份首写证据，「按阈值判」与「真 `decide()`」在**非 Edit 家族**首写上给出同一个 deny 集合 | 测试 `Write 侧行为逐字节不变：读过目标文件也不放行（只有阈值算数）`；§6 复算 R4 输出 `setEqual=true` | 两边集合不等；或出现 `tool:"Write"` 且 `allowReason:"target-read"` 的行 |
| **AC4** | 手写的 `satisfied_by:"auto"` 标记不放行；伪造 `sig` 与缺 `sig` 的 `why` 分得开（`auto-unsigned` / `auto-bad-signature`） | 测试 `伪造 {"satisfied_by":"auto"} 无签名字段 → 不放行`、`伪造带假签名 → 不放行`、`签名覆盖 reads：改了数字但不重签 → 不放行`、`签名与密钥绑定：换一个密钥即失效`、`缺密钥时 auto 判 auto-no-secret`；`e2e：伪造标记文件（shell 一条命令）不再放行` | 手写 `auto` 标记后 `action:"allow"`；或「缺密钥」退化成放行；或 `why` 只有一个值（分不清是没签还是签错） |
| **AC5** | 闸门**自己**写的标记仍放行（`allowReason:"marker-present"`，`satisfiedBy` 原样带出）；`.claude/.ow-*` 的自锁放行仍生效；对密钥文件的写**不**走自锁 | 测试 `闸门自己写的标记 → 放行（完整签名往返）`、`闸门不放行对密钥文件的写`；`node scripts/pre-write-gate.mjs status --cwd <dir>` 的 `marker sig` 行 | 自锁断了（标记永远写不出来）；或密钥文件落进 `gate-own-file` |
| **AC6** | 沙箱阴性对照**不掉**：沙箱桶 would-deny 数不低于基线 **49 / 66**（= 74.2%） | `node scripts/observe-reality-check.mjs` 的「测试沙箱/探针（对照）」段；`node scripts/measure-gate-ceiling.mjs` 的 `沙箱 would-deny（基线）` 自检行（两者在同一次运行里对账） | 沙箱拦截数 < 49。**掉 = 判据被削空，与「阈值 0」同级（那次是 0/69）** |
| **AC7** | `decide()` 仍是纯函数：函数体内不出现任何 `fs` 标识符、不读 `process.env`；全量测试仍绿 | 静态扫描见 §6 复算 R5（实测：`decide()` 166 行、`fs` 标识符 0、`process.env` 0）；`node --test scripts/*.test.mjs` | 函数体内出现 `readFileSync` / `existsSync` / `openSync` / `process.env`；或需要改测试夹具才能过 |

**AC6 的基线值必须连快照一起引。** 本文的基线是 **49/66**（435/410/136/66 快照）；
`2026-11-14-gate-widening-ceiling.md` §2 写的是 **51/69**，那是它自己的 439 份 / 沙箱 69 快照。
两个数都对，**混引就是错**。判断标准是「不低于同一次运行里参考实现报出的值」，不是某个写死的常数——
`measure-gate-ceiling.mjs` 的 `alignWithBaseline()` 就是为此存在（它对不上时会红，而不是静默）。

### 2.1 AC 与「实现长什么样」的对应关系

- AC1/AC2 钉住**判据**（`target-read` 这条分支存在且只对 `Edit` 家族开）。
- AC3 钉住**没动另一半**（阈值分支显式排除 `editSide`）。
- AC4 钉住**`auto` 不可伪造**（HMAC + 会话绑定 + 密钥文件不可写）。
- AC5 钉住**自锁**（否则闸门因为写不出标记而永远拦）。
- AC6 钉住**没被架空**（唯一能识别「削弱到恒真」的硬指标）。
- AC7 钉住**副作用边界**（读盘只在 `runHook`，`decide()` 可穷举测试）。

---

## 3. 已知残留问题（不写进规格就等于假装它们不存在）

### 3.1 `head -n 20 a.mjs` → `20` 的解析缺陷：未修，已被测试钉住

`readPathsOfToolUse()` 对 shell 段取「动词后第一个不以 `-` 开头的 token」，但**带独立值的选项不吃值**。
实测（`node --input-type=module -e` 直接调该导出）：

| 命令 | 产出 | 方向 |
|---|---|---|
| `head -n 20 a.mjs` | `["20"]` | **多算**假路径 |
| `head -c 400 x.md` | `["400"]` | 多算 |
| `gc -TotalCount 5 z.ps1` | `["5"]` | 多算 |
| `cat -n a.mjs` | `["a.mjs"]` | 正确（这条必须同时成立） |

**方向是双向的**，不是单纯「多算就宽松」：

- 多算：上面三行——`20` 被当成「读过的文件」，凑数；
- 漏算：真实文件 `a.mjs` 因为值字段先被取走而**没进**已读集合——这一半会让闸门**更严**，而且是错的严格。

语料实测：真实项目 **40 / 136** 个会话的首写窗口证据里含纯数字假路径（沙箱 1 / 66）。
修它的净效果是 **变严**（见 §4-P2）。现状被 `observe-reality-check.test.mjs` 的**两条**断言钉住：
`gateReadsOf 跳过 shell 的选项参数，取第一个位置参数` 与 `已知解析缺陷钉住：带独立值的选项把值当路径（本轮不修）`。
两条都断言 `head -n 20 a.mjs → ['20']`，修它会红——这是刻意的：
**改判据的人必须先看到它红，再去改报告。**

### 3.2 永久豁免：129 / 136（94.9%）的会话一旦首写被放行，本会话后续写全部放行

标记一旦落盘，`markerValidity()` 就让本会话后续所有写走 `allowReason:"marker-present"`，不再看证据。

本快照实测（§6 复算 R6）：

| 口径 | 真实项目 | 沙箱 |
|---|---|---|
| 整个会话**拿到**标记的（**改动后**） | **129 / 136（94.9%）** | 12 / 66 |
| 整个会话拿不到的（**改动后**） | 7 | 54 |
| 整个会话拿不到的（**改动前**） | 1 | 49 |
| 「无标记时仍需读 transcript」的写意图总数（前 → 后） | 282 → **455（+61%）** | 150 → 178 |

**两个 94.9% 不是同一个数**，别混引：
`gate-widening-redteam.md` §0.5 的 129/136 是「首写前已有 ≥1 条结构性探索」（它的改宽口径，
本改动**没有**采纳结构性探索）；本节的 129/136 是「整个会话最终拿到标记」。两者恰好同为 129，是巧合，
定义完全不同。

「拿不到标记」从 1 升到 7 是这次拆分的**直接代价**：`target-read` 不写标记，所以纯 `Edit` 会话（改动前靠阈值放行并写标记的那类）
现在每次写都要重读一遍 transcript。表里那 +61% 就是这个代价的量化。

### 3.3 续接会话不可判：「续接放行」这条路做不到

三个独立事实，全部本机复算：

| 事实 | 实测 | 方法 |
|---|---|---|
| 压缩前的 `tool_use` 记录 | 435 份 transcript 里 `"preCompact"` 出现 **0** 次 | 逐文件读全文找该键 |
| `parentSessionId` 作为**记录顶层键** | **0 次 / 0 份文件** | 逐行 `JSON.parse` 后判 `hasOwnProperty` |
| `parentSessionId` 作为**字符串**（任意深度） | 566 次 / **165 份**文件，但全部嵌在 `attachment`(359) `api-request-shape`(106) `user`(48) `assistant`(31) `api-request-blob`(21) `queue-operation`(1) 这些**载荷**里，没有一条是「我续接自哪个会话」的记录 | 同上，只统计 `type` 分布 |
| PreToolUse stdin 字段 | **10 个**：`session_id` `transcript_path` `cwd` `prompt_id` `permission_mode` `effort` `hook_event_name` `tool_name` `tool_input` `tool_use_id` | `../research/2026-11-14-pretooluse-desktop-verification.md` §1 的实测原文 |

子 agent 调用时 stdin 会多 `agent_id` / `agent_type` 两个字段
（`../research/2026-11-14-widened-evidence-sources.md`），但它们说明「调用者是子 agent」，
**不说明当前会话是续接的**。

**结论**：闸门无法自己判断「这是压缩续接」，因此**不能**实现「续接放行」。
唯一可做的是「信任宿主声明的续接摘要文本」——那是把判据从「验证」降级成「信任」，
本规格**不采纳**（与 `../adr/0002-honest-degradation.md` 的诚实降级原则相反：
降级必须写明，且不能假装它是验证）。

### 3.4 子 agent 的 I/O 成本：最坏 2.9 s，而预算闸罩不住它

| 事实 | 实测 | 来源 |
|---|---|---|
| 单会话子 agent 目录最大 | **243 个 `.jsonl` / 449 MB** | `gate-widening-redteam.md` §3.3 |
| 全量解析该目录耗时 | **2923 ms** | 同上 |
| 每文件尾部 1 MB | 1955 ms（丢 39% 的 tool_use） | 同上 |
| 每文件尾部 64 KB | 179 ms（丢 96%） | 同上 |
| 本 hook 单次墙钟中位（1 MB 尾窗口） | **175 ms**（node 启动基线 114 ms） | 同上 §3.1 |
| `DEFAULT_BUDGET_MS` | 只 `Promise.race` 包住 `readStdin` | `scripts/pre-write-gate.mjs` 的 `main()`：`guard` 只传进 `readStdin` 那个 race，`runHook(input, { env })` 之外没有任何超时 |
| 宿主 timeout（模板） | 10 s，且超时是**静默 kill**（fail-open，日志里看不出来） | `templates/pre-write-gate.settings.json`；`../research/2026-11-12-stop-hook-prototype.md` §5 |

**本改动不扫子 agent**（`Edit` 侧只比对已在手的 `reads`，没有新增 I/O），所以这条不构成本次上线的阻塞。
但它决定了「以后能不能靠子 agent 的证据救更多会话」——答案是**不能**，除非先把预算闸扩到 `runHook`。
一句话：`DEFAULT_BUDGET_MS = 5000` 只保护输入，不保护判定。

### 3.5 `Edit` 侧被拒时，reason 文案仍在教「读 README.md + 一个源码文件」

`reasonFor()` 不接收工具名，也没有 `editSide` 参数，所以 `Edit` 侧被拒时给出的是：

```
1. 读 <cwd>/CLAUDE.md（若不存在则跳过）、<cwd>/README.md，
   以及至少 <minReads-2> 个源码文件（用 Read，不要用 Bash cat）。这算「读过项目」。
```

**照着做并不满足 `Edit` 侧的判据**（它要的是「读你要改的那个文件」）。这不是死路——reason 第 3 步的
`mark` 逃生口仍能放行——但**指令链与判据不匹配**：模型会读完 README 仍然被拒，然后才去跑 `mark`。

复现：`decide()` 喂一个 `Edit`、`reads` 里放 3 个非目标文件，读 `output.hookSpecificOutput.permissionDecisionReason`。

### 3.6 重放器的两个数现在会不一致（27 vs 23），而它的输出写着「必须一致」

`observe-reality-check.mjs` 的「指标 2」现在打印：

```
gate 口径        would-deny 27 / 136 = 19.9%
真 decide() 复算 deny 23 / allow 113   ← 必须与上一行一致
```

**它不一致，差 4，而且这 4 个正好是 `target-read` 放行的会话**（`910e505f` `aed8ec22` `ea338c0e` `3e58c93b`）。
原因：上一行是「读数 < 3」的纯计数，下一行走的是真 `decide()`（含新判据）。两边都对，只是**不再是同一个量**。

这条必须在报告里改口径（按首写工具分列，或在下一行注明「含 target-read，差 4」），否则下一个人会
把 4 当成复现失败。**本文不掩盖它**：它是 P1 的直接副作用，属于测量层欠账，不是闸门缺陷。
（沙箱桶 delta = 0，49 vs 49，因为沙箱里那 8 个 `Edit` 首写只有 7 个命中目标，命中的那 7 个原本就 ≥3 读。）

### 3.7 `claim` 标记仍可手写：这是最便宜的一条绕过，且是设计允许的

实测（`runHook` 两条链）：

```
第 1 步 Bash: echo '...' > .claude/.ow-read-done   → passthrough / gate-own-file（闸门放行这条命令）
第 2 步 Write target.txt                            → allow / marker-present, satisfied_by="claim"
```

`claim` 按设计不签名（它是自述，签了反而会让人误读成「验出来的」），所以手写它与跑
`node scripts/pre-write-gate.mjs mark` 等价。**签名堵掉的是 `auto`**（`gate-widening-redteam.md` §5-B 那条
`echo '{"satisfied_by":"auto"…}'` 现在会得到 `deny / marker:auto-unsigned`）。

要彻底堵住 `claim`，唯一办法是取消这个逃生口——而那会把「读发生在会话之外」的会话永久拦死
（§3.3 的续接就是这类）。**这是一个已知的、有意的取舍，不是遗漏。**

---

## 4. 上线顺序（不可跳级）

每一步都写明：前置条件 → 可独立回滚吗 → **什么时候该停下重评估**。

### P1 — 拆闸（本规格描述的这一件）

- **前置**：无。`decide()` 拿得到 `intent.paths`（`fileTargetsOf()` 从 `file_path` / `notebook_path` / `path` / `target_file` 取），不需要新输入、不需要新 I/O。
- **可独立回滚**：**可以**。回滚 = 删掉 `editSide` 那条分支（并把阈值分支的 `!editSide &&` 去掉），一处分支、一行条件。
  `observe` 模式下不产生任何拦截，可以先跑一周看日志再定。
- **验收**：AC1–AC7。
- **该停下重评估的判据**：
  1. AC2 或 AC3 红 —— 说明拆分方向或边界错了，**停**，不许靠改测试过；
  2. 沙箱桶（AC6）从 49 掉下来 —— 判据被削空，**停**；
  3. `observe` 日志里出现 `tool:"Write"` + `allowReason:"target-read"` —— 分支边界泄漏，**停**。

### P2 — 修解析缺陷（`head -n 20`），**不**算改宽

- **前置**：P1 已落地（否则两个「+1」会被混记成一次）。
- **方向必须是「变严」，别让人以为是放宽**：
  - P1 之前：**27 → 28**（`gate-widening-ceiling.md` §2，443 份 / 沙箱 69 快照）；
  - P1 之后重算（本快照）：**23 → 24**，翻转的会话是 `be6b89cf`（`Bash` 首写，窗口证据 4 → 2）。
  - 机制：原先 `head -c 400` 的 `400` 这类**假路径**在凑数，假路径被清掉后计数下降 → 更少会话达标。
- **可独立回滚**：可以，一处解析逻辑。
- **验收**：`head -n 20 a.mjs` 不得产出 `20`；**且** `cat -n a.mjs` 必须仍产出 `a.mjs`（两个方向相反的用例都得有）。
  修完必须同步把 `observe-reality-check.test.mjs` 里那两条「钉住现状」的断言改掉，并在报告里写明口径已变。
- **该停下重评估的判据**：出现任何「由拦变放行」的会话——它的方向应该是单向的（只变严）。实测翻转 1 个、方向是放行→拦，符合预期。

### P3 — `Write` 侧阈值 3 → 1

- **前置**：P1 + P2 已落地，且 P4 的日志已经积累（否则你不知道 1 会放出什么）。
- **可独立回滚**：可以，一个常量（`OW_PRE_WRITE_GATE_MIN_READS` 亦可覆盖）。
- **实测（本快照，含 P1）**：真实 **27 → 13 / 136（9.6%）**；沙箱 **49 → 48 / 66（72.7%）**。
  掉的那 1 个沙箱会话是真读了 ≥1 个文件才写，本来就该放行（`gate-widening-ceiling.md` §4.1）。
  复算：`node scripts/observe-reality-check.mjs --threshold 1`。
- **该停下重评估的判据**：沙箱桶掉 **> 2**（`gate-widening-ceiling.md` 的同一结论：阈值 1 只该掉 2 个；
  本快照是 1 个）。掉更多 = 1 太宽。

### P4 — 用 `observe` 跑一段，收「野生 would-deny」

- **前置**：P1–P3 落地。把 `templates/pre-write-gate.settings.json` 的 hooks 段合并进
  `.claude/settings.local.json`，**不设** `OW_PRE_WRITE_GATE`（默认 observe）。
- **可独立回滚**：删掉 hooks 段即可，不改代码。
- **验收**：`tasks/runs/pre-write-gate/<日期>.jsonl` 里出现 `would-deny` 行，且逐条能对上归因；
  **不允许**在没有任何野生样本的情况下开 `deny`。
- **该停下重评估的判据**：见 §5.3。

### P5 — 用「写了但没读目标」重定义测量重心

- **前置**：P1–P4 的数据在手（阈值只能从数据定，不能先写死）。
- **做什么**：`attribute()` 的归因从「A/B/B2/C/D 五类」改成「`Edit` 未读目标 / `Write` 未读任何项目文件」。
- **可独立回滚**：只改测量脚本，不动闸门。
- **验收**：`resolution-gate-audit.mjs --only R8` 的 `deniedReadTargetBefore` 与
  `measure-gate-ceiling.mjs` 的对齐断言逐项相等。

---

## 5. `observe` 日志的读法

### 5.1 按 `allowReason` 分桶

日志行是一行一个 JSON（`tasks/runs/pre-write-gate/<日期>.jsonl`）。分桶只用四个字段：
`tool`、`decision`、`allowReason`、`satisfiedBy`；`target-read` 行额外有 `target`，`would-deny` 行额外有 `reason`。

| `allowReason` | 含义 | 是否经过证据判定 |
|---|---|---|
| `target-read` | `Edit` 侧：目标文件读过（**本次新增的桶**） | 是 |
| `auto-satisfied-by-transcript` | `Write` 侧：读够 ≥ minReads（闸门自己写 `auto` 标记） | 是 |
| `marker-present` | 本会话已有有效标记，**直接放行** | **否** |
| `gate-own-file` | 写的是 `.claude/.ow-*`（自锁） | 否 |
| `secret-tamper` | 写的是密钥文件（不放行，只记录） | 否 |
| `observe-mode` | 判为「该拦」但当前是 observe（`decision:"would-deny"`） | 是 |
| `warn-mode` | 同上但发提醒 | 是 |
| passthrough 侧：`not-a-write` / `dir-only` / `unknown-tool` / `wrong-event` / `unparsable-input` / `hook-budget-exceeded` / `hook-internal-error` | 本 hook 不参与 | 否 |

**必看的三条交叉表**（每条都要 `tool` 分列，否则 Edit 与 Write 会被混成一个数）：

1. `tool × allowReason` —— 看 `target-read` 是否只出现在 `Edit`/`MultiEdit`/`NotebookEdit` 上；
2. `satisfiedBy × marker` —— 看 `auto` 与 `claim` 各占多少（`claim` 高说明模型在绕过判据，不是判据在起作用）；
3. `decision × tool` —— `would-deny` 的工具分布，改造前后应当只有 `Edit` 家族会减少。

### 5.2 本快照的预期分布（用来判断「线上是不是这个样子」）

把两个桶的每一次写意图按新判据回放（§6 复算 R7）：

| 桶 | 真实项目（21848 次写意图） | 沙箱（467 次） |
|---|---|---|
| `marker-present` | 21392（**97.9%**） | 289（61.9%） |
| `observe-mode`（would-deny） | 164（0.8%） | 136（29.1%） |
| `target-read` | 162（0.7%） | 30（6.4%） |
| `auto-satisfied-by-transcript` | 129（0.6%） | 12（2.6%） |
| `gate-own-file` | 1 | 0 |

（分母在几分钟内从 21717 漂到 21848 —— 语料在长。**比率稳定，绝对数别当常数引。**）

两个必须注意的读数：

- **97.9% 的写根本没经过判定**。这是 §3.2 的直接后果——闸门实际只影响每个会话的**第一次**写。
  任何「闸门拦下了多少」的说法，分母都该是「无标记时的写意图」= `21848 − 21392 − 1(gate-own-file)` = **455**，
  不是 21848。这个恒等式在每次复算里都成立（R6 独立复算同一量也得 455），可以拿它当真值校验。
- `target-read` 在非标记放行里占 **162 / (162+129) = 55.7%**。**这不是架空信号**，是预期值。

### 5.3 什么信号说明这次改动是错的、该回滚

**先纠正一个容易写错的判据**：`target-read` 占比高 **不**等于判据被架空。语料里 `Edit` 首写是
**18/18 命中目标**，占比 100%，而这个判据经得起负向验证（把目标路径改坏一个字符，`readTarget` 立刻从
18/18 掉到 0/18）。所以「占比 >95%」单独出现时是**预期**，不是警报。
「被架空」的正确信号是 `marker-present` 的覆盖率，不是 `target-read` 的份额。

真正可观测、且方向明确的回滚信号：

| # | 信号（在 jsonl 上算） | 阈值 | 说明什么 | 动作 |
|---|---|---|---|---|
| S1 | `tool ∈ Edit 家族` 且 `decision:"allow"` 的行里，`allowReason:"target-read"` 的份额 | > 95% **且** `reads` 的 p50 ≥ `minReads` | 该判据在线上从不单独起作用（本快照：p50 = 11 ≥ 3，就是这种情况） | 可回滚 P1 省一条分支；**但不是错误** |
| S2 | `tool:"Write"` 或 `tool` 是 shell 类，却出现 `allowReason:"target-read"` | **> 0** | 分支边界泄漏，Edit 判据漏到 Write 侧 | **立即回滚**。这是 AC3 的线上版本（实测 0） |
| S3 | `target-read` 行的 `target` 字段为空 / 缺失 | **> 0** | 判据失效：没有目标却声称读了目标 | **立即回滚**（实测 0） |
| S4 | 沙箱桶（`paths` 含 `Temp\` 或 `.tmp-analysis`）里 `target-read` 的份额 | > 30%（本快照 6.4%） | 阴性对照被削弱：连「写个文件然后停」的会话也开始享受 Edit 判据 | 停下重评估 AC6 |
| S5 | `tool ∈ Edit 家族` 却出现 `allowReason:"auto-satisfied-by-transcript"` | **> 0** | Edit 侧掉回了阈值判据 = 兜底被加回来了（与 §1.2 的方向相反） | **立即回滚**（实测 0） |
| S6 | `marker-present` 份额 | ≥ 99.9% **且** `target-read` < 0.2% | 改动在线上完全不可观测，做了等于没做 | 回滚，或先解决 §3.2 的豁免面 |
| S7 | `would-deny` 之后同一 `sessionId` 在同一 `prompt_id` 内出现 `allowReason:"marker-present"` 且 `satisfiedBy:"claim"` | 次数占比 > 50% | 模型在照 reason 跑 `mark` 而不是去读文件（§3.7 的常态） | 不是 bug，但要重估「闸门是否在教模型绕过自己」 |

S2 / S3 / S5 是**不可能事件**——它们一旦出现就说明实现错了，不需要累计样本。三条在本快照上实测都是 **0**。

**一个必须写下来的反例，否则这条判据会被写反**：
`decision:"would-deny"` 且 `tool ∈ Edit 家族` 且 `reads ≥ minReads` **不是**异常信号——
它正是 AC2 的预期行为（读了 3 个无关文件、就是没读目标，所以拦）。本快照实测出现 **29 次**（沙箱 3 次）。
把它当警报会让人得出「拆闸没生效」的错误结论。

---

## 6. 复算清单

```bash
# R0 语料快照与 R8 判据事实（约 60–120 秒）
node scripts/resolution-gate-audit.mjs --only R8

# R1 §3.6 的重放/decide 分歧（这是脚本**直接打印**的，约 90 秒）
#     输出必含两行：`gate 口径 would-deny 27 / 136 = 19.9%` 与 `真 decide() 复算 deny 23 / allow 113`
#     两者差 4 是预期的（见 §3.6），不是复现失败
node scripts/observe-reality-check.mjs

# R2 §1.2 的交叉表（脚本不打印它，用这个内联复算；输出见下）
node --input-type=module -e "import{listTranscripts,analyzeOne,dedupeForks,isSandbox,defaultRoot}from'./scripts/observe-reality-check.mjs';import{pathKeyOf}from'./scripts/pre-write-gate.mjs';const E=n=>['Edit','MultiEdit','NotebookEdit'].includes(String(n));const{kept}=dedupeForks(listTranscripts(defaultRoot()).map(analyzeOne));for(const[k,l0]of[['real',kept.filter(s=>!isSandbox(s))],['sandbox',kept.filter(s=>isSandbox(s))]]){const l=l0.filter(s=>s.firstWrite),e=l.filter(s=>E(s.firstWrite.name)),rt=s=>(s.readPathsWindow||[]).some(p=>pathKeyOf(p)===pathKeyOf(s.firstWrite.path||''));console.log(k,'n='+l.length,'editFirst='+e.length,'readTarget='+e.filter(rt).length,'thrOk='+e.filter(s=>s.gateReads>=3).length,'thrOkButNoTarget='+e.filter(s=>s.gateReads>=3&&!rt(s)).length,'denied='+e.filter(s=>s.gateReads<3).length,'deniedReadTarget='+e.filter(s=>s.gateReads<3&&rt(s)).length)}"
# 实测输出：
#   real    n=136 editFirst=18 readTarget=18 thrOk=14 thrOkButNoTarget=0 denied=4 deniedReadTarget=4
#   sandbox n=66  editFirst=8  readTarget=7  thrOk=7  thrOkButNoTarget=0 denied=1 deniedReadTarget=0

# R3 AC1/AC2/AC4/AC5 的最小复现（纯函数层，不需要真会话）
node --test scripts/pre-write-gate.test.mjs

# R4 AC3 的集合相等 + AC6 的阴性对照（同一次运行里与参考实现对账）
node scripts/measure-gate-ceiling.mjs

# R5 AC7 的静态纯度扫描（实测 166 行 / 0 个 fs 标识符 / 0 个 process.env）
node --input-type=module -e "import{readFileSync}from'node:fs';const a=readFileSync('scripts/pre-write-gate.mjs','utf8').split('\n');const s=a.findIndex(l=>l.startsWith('export function decide('));const e=a.findIndex((l,i)=>i>s&&l==='}');const b=a.slice(s,e+1).join('\n');console.log('lines',e-s+1,'fs',(b.match(/\b(readFileSync|writeFileSync|appendFileSync|existsSync|openSync|readSync|fstatSync|mkdirSync|readdirSync|statSync)\b/g)||[]).length,'env',(b.match(/process\.env/g)||[]).length)"

# R6 §3.2 的标记覆盖率（无标记时的写意图数、整会话拿不到标记的会话数）
#     无现成脚本，判据：按文件顺序重放每个会话的写意图，维护「已读不同路径集合」；
#     改动前 = 集合 ≥3 即放行并写标记；改动后 = Edit 家族命中目标即放行（**不写标记**），
#     Write/shell 集合 ≥3 即放行并写标记。计数 = 标记尚未落盘时遇到写意图的次数。
#     实测 真实 282→455 / 1→7，沙箱 150→178 / 49→54

# R7 §5.2 的 allowReason 预期分布（同上，把每次判定结果按 allowReason 分桶）
#     实测 真实 21848 次写意图：marker-present 21392 / observe-mode 164 / target-read 162
#          / auto-satisfied-by-transcript 129 / gate-own-file 1
#     真值校验：总写意图 − marker-present − gate-own-file 必须 == R6 的「无标记写意图」455

# R8 解析器分叉必须仍为 0（拆分不得引入第二份解析）
node scripts/probe-parser-divergence.mjs

# R9 P3 的阈值效应
node scripts/observe-reality-check.mjs --threshold 1

# 全量回归 + 结构硬门
node --test scripts/*.test.mjs
node scripts/check-structure.mjs
```

**最小复现（AC1 / AC2 / AC4 / AC5 的纯函数版）**：`decide()` 不读盘，四条都能在三行内构造出来——
给 `state.reads = { paths: [...] }` 与一个 `state.secret`，喂一个 `tool_input.file_path`。
这正是 AC7（纯函数）值钱的地方：判据可以被穷举验证，不需要真会话。
