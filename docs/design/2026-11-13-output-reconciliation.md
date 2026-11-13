# 产出对账：把「子 agent 说它产出了什么」换成「磁盘与 transcript 上的痕迹」

- 日期：2026-11-13
- 状态：**已接入派发链路（§7 四项已落地）**。`scripts/claim-ledger.mjs`（四方对账 + transcript 痕迹
  抽取）+ 46 条测试；§7 的四项已在同日接上：`task-graph.json` 的 `outputs[]` 必填（`validate-run.mjs`）、
  派发模板带 nonce 与产出登记节（`templates/dispatch.md`）、`executor` / `repair` 输出改四元组、
  `SKILL.md` 新增 §4.5 Phase D 作为验收的硬前置门。落地记录与**诚实边界**见
  `docs/research/2026-11-13-output-reconciliation-integration.md`。
  仍未做：`observe` 需手动跑第二步；Bash 写出的文件不在痕迹范围；纯文本结论无从对账。
- 触发要求：用户原话——**「我们的 agent 架构一定要避免 agent 已经产出了然而主线程却没有意识到。」**

> 本目录其余文档标注为「全部未实现」。这一份不同：判定层、工具层与派发链路均已是可运行代码。
> §7 保留为改动记录的原文，实际接法以落地报告为准（它同时写明了四类仍未覆盖的漏项）。

---

## 1. 现状诊断（读的是代码，不是推测）

### 1.1 子 agent 现在怎么交回结果

**只有一条路径：返回文本。** `docs/spec/dispatch-contract.md` §6 规定最终返回是结构化三元组
（`## 交付物` / `## 执行日志` / `## 我认为的薄弱点`），§6 最后一句是：

> 返回超过 15 行视为格式不可解析，按 `docs/spec/state-model.md` §2 判定。

12 份角色定义里，交付物的表达方式各不相同：

| 角色 | 交付物怎么表达 | 有没有落盘要求 |
|---|---|---|
| `planner` | 写 `tasks/runs/<run-id>/task-graph.json` | **有**，路径写死在定义里 |
| `critic` / `redteam` / `review` | 写 `tasks/runs/<run-id>/{critique,redteam,review}.md` | **有**，且明写「Write 只允许写这一个文件」 |
| `executor` / `repair` | 返回里写「<路径 或 关键结论>」 | **无**。路径是自由文本 |
| `research` | 返回里贴事实清单表格 | **无**（且可能整篇只在返回里） |
| `acceptor` / `resolution` / `relay` / `safety` / `probe` | 纯返回文本 | **无** |

也就是说：**凡是「写报告」的角色（critic / redteam / review）路径是确定的，凡是「干活」的角色
（executor / repair）路径是自由的。** 用户担心的那种失败——活干完了主线程不知道——正好发生在后者。

### 1.2 现有的格式约定有多强

`check-structure.mjs` 对角色只做四件事（`checkAgents()`，`scripts/check-structure.mjs:174` 起）：

1. frontmatter 必须有 `name` / `description`；
2. 只读角色不得拥有 `Edit` / `Bash`（`Write` 允许，但正文必须声明「只允许写报告」）；
3. `description` 不得短于 10 字符；
4. 每个角色必须在 `SKILL.md` 里被提到至少一次（`checkAgentReachability()`，反「定义了却从不派发」）。

**没有一个字检查返回值格式。** 三元组、15 行上限、`## 交付物` 这些约定，全靠 prompt 里写着，
没有任何执行者。子 agent 返回一段散文，主线程照样能读到，也照样没人报错。

### 1.3 有没有任何地方验证过「产出完整性」

有，但只覆盖到「派发图」这一层，不覆盖「产出」：

| 工具 | 检查什么 | 与产出的关系 |
|---|---|---|
| `validate-run.mjs` | `task-graph.json` 的 schema：`capability` / `shape` / `token_budget_pct` / `acceptance[]` / `why_this_layer` 是否齐全合法 | 检查**计划**，不检查**结果** |
| `verify-claims.mjs` | 末条 assistant 文本里的完成性声明 ↔ 会话内的工具调用 | 检查**声称 vs 工具调用**，覆盖的是宿主会话，不是派发任务 |
| `check-structure.mjs` | 文档引用的路径是否存在（`checkDocReferences()`） | 检查**文档指向**，不检查**任务产出** |
| `stop-verify-hook.mjs` | 回合结束点的完成声明 ↔ 证据 | 同上，是会话级不是任务级 |

**结论：从「派发出去」到「收回来」之间，没有任何一处核对过「子 agent 声称的东西在不在」。**

### 1.4 为什么这是结构性缺陷，不是疏忽

三个现有机制各自都对，合起来有一个洞：

- `state-model.md` §2.2 明确规定「判定不可由 Agent 自述」——**状态**不能自述。
- 但**交付物**可以自述，而且是唯一通道。
- 于是同一份返回文本里，前半段（交付物）是自述、后半段（薄弱点）也是自述，而状态判据却说「自述不算」。

这不是某个人忘了写检查，是「交付物必须是文本」这个前提本身有问题：
文本可以任意长、任意格式、可以被截断、可以整段是空的，而**主线程无法区分
「没产出」和「产出了但没传过来」**——这两种情况的处置完全相反。

### 1.5 一次真实形态（来自本项目自己的失败）

用户给的两个例子都属同一形状：

1. 守护进程活着、日志静默 4 小时、`--health` 说「运行中」。
   根因不是进程死了，是**检查器只看一条路径（`state.json`），而产出走另一条路径（`log`）**
   —— 已在 2026-11-12 修，`healthCheck` 现在并入 `log-health.json`（`scripts/watch.mjs:2583`）。
2. 一份报告写好了，主线程以为它在跑，等了 5 小时。

**两例的共同结构**：判定「有没有在干活」用的信号，与「产出」本身是两条独立的路径，
前者活着不能证明后者活着。`state-model.md` 的心跳推断被删除（§2.0.1）也是同一个教训的镜像：
**任何从间接信号推断产出的做法，在本仓库的语料上都已证伪**（6,308 次大间隔里 94.8% 之后仍有调用）。

---

## 2. 机制核心：四方对账

不依赖「返回文本」，依赖**四条独立的痕迹**，交叉比对。

```
        派发时                    执行中 / 结束时                  收活时
  ┌──────────────┐        ┌──────────────────────┐        ┌──────────────┐
  │ 期望 expect  │        │ 自述 claim（可选）    │        │ 磁盘 stat    │
  │ 该产出哪些文件│        │ 子 agent 自己记一笔   │        │ 现场算 sha256│
  └──────┬───────┘        └──────────┬───────────┘        └──────┬───────┘
         │                           │                           │
         │                  ┌────────┴────────┐                  │
         │                  │ 痕迹 observe    │                  │
         │                  │ 读子 agent 的   │                  │
         │                  │ transcript      │                  │
         │                  └────────┬────────┘                  │
         └───────────────┬───────────┴───────────────┬───────────┘
                         ▼                           ▼
                  reconcile() 四方比对 → 任务级结论 + 逐项状态
```

**为什么要四方，而不是两方：**

| 只用… | 会漏掉 |
|---|---|
| 期望 + 自述 | 自述可以撒谎/写错路径——这正是要治的病 |
| 期望 + 磁盘 | 分不清「文件是它写的」和「文件本来就在」；也分不清「写过但失败了」 |
| 磁盘 + 自述 | 没人自述时完全瞎（用户最担心的场景一） |
| **四方** | 已知的漏：路径不可确定解析的 Bash 写入（变量、通配、`find -exec`、临时位置；见 §3.6） |

### 2.1 三种证据的强度不等

| 来源 | 怎么来 | 能证明 | 不能证明 |
|---|---|---|---|
| 自述 `claim` | 子 agent 跑 `claim` 追加一行 | 它**认为**它写了哪个文件、当时的 sha256 | 文件现在还在、内容没变 |
| 磁盘 `stat` | 对账时现场 stat + sha256 | 文件此刻在、字节数、内容摘要 | 是谁写的、什么时候写的 |
| 痕迹 `observe` | 读 `subagents/agent-*.jsonl` 的 `tool_use` | 该 agent **确实调用过** Write/Edit 这个路径，且读得到成对 `tool_result` 的成败 | 调用之后文件有没有被别的东西覆盖 |

三者**都成立**才判 `OK`。只有自述 = 当前机制的现状，判不了完成。

### 2.2 逐项状态（`ITEM_STATUS`，九个值，有序）

| 值 | 含义 | 是怎么判出来的 |
|---|---|---|
| `OK` | 有自述、文件在、sha256 一致 | 全对得上 |
| `OK_WEAK` | 同上，但任一侧 hash 被截断（> 4 MiB） | 只比了前 4 MiB |
| `UNREPORTED` | 文件在，但没人自述 | **场景一**：产出了没报告 |
| `ABSENT` | 期望里有，磁盘没有，也没痕迹 | 没开工 |
| `DRIFTED` | 自述说写了，文件在，内容已不是当时那份 | **冲突 / 事后被改** |
| `MISSING` | 自述说写了，磁盘上没有 | **场景二**：报告了但不存在 |
| `EXTRA` | 不在期望里，但 transcript 显示这个 agent 写过 | 信息项，不算缺陷 |

### 2.3 任务级结论（`TASK_VERDICT`，八个值）

判定顺序是**有序互斥**的，顺序本身是设计：

| 序 | 结论 | 判据 | 为什么排这个位置 |
|---|---|---|---|
| 1 | `CONFLICT` | 同一路径被 ≥2 个任务声明或自述 | **先于一切**：两个 agent「都成功」是最坏的形态，比任何一个失败都糟 |
| 2 | `NO-EXPECTATION` | 任务存在但没声明路径 | 对应 CLAUDE.md 硬约束 8「未声明产出形态视为规划缺陷」 |
| 3 | `COMPLETE` | 全部 `OK` / `OK_WEAK` | |
| 4 | `EMPTY` | 全部 `ABSENT` | 没开工——**必须与 PARTIAL 分开**：处置不同 |
| 5 | `PARTIAL` | 有 `OK` 也有非 `OK` | **场景三**：产出一半就死了 |
| 6 | `MISSING` | 没有 `OK`，有 `MISSING` | 报的全是假的 |
| 7 | `DRIFTED` | 没有 `OK`，有 `DRIFTED` | |
| 8 | `UNREPORTED` | 其余（文件在但没人说） | |

`EMPTY` 与 `PARTIAL` 分开这一条不是洁癖：一个「没开工」的任务应该重新派发（可能派发就没成功），
一个「干到一半」的任务应该续做或修复（重派会重复劳动）。把它们混成一个「失败」，两种处置都会做错。

### 2.4 静默不是判据（写进代码的一条纪律）

`reconcile()` 会算 `silentMin`（距最后一条产出证据多少分钟）与 `quiet`（是否超过
`--timeout-min` 声明的时间窗）。**它只用来说「要不要催」，不参与任何判定。**

理由直接来自 `docs/spec/state-model.md` §2.0.1：实测 6,308 次超过 600s 的间隔里
5,977 次（94.8%）之后仍有工具调用。「停了很久」不能推出「失败」，那条推断已经删除过一次了。
报告末尾固定印一行：

> 注意：静默时长**不是失败判据**（state-model §2.0.1）。它只回答「要不要催」，不回答「要不要重跑」。

`COMPLETE` 且静默 5 小时，仍然是 `COMPLETE`——这条有专门的测试（`claim-ledger.test.mjs`
「静默不构成失败判据，只标 quiet」）。

---

## 3. 五个必须解决的场景

### 3.1 子 agent 产出了文件但没报告

**发现方式：`observe`（不需要它配合）。**

`observe` 读子 agent 的 transcript，抽出所有 `Write` / `Edit` / `MultiEdit` / `NotebookEdit`
调用与它们配对的 `tool_result`（`observedWrites()`）。归属靠 **nonce**：

1. `declare` 时生成一个 8 位十六进制 nonce，打印出来拼进派发 prompt；
2. `observe` 读每份 `agent-*.jsonl` 的头部 64 KiB，找这个 nonce；
3. 找到 → 该文件里所有写入痕迹归属到这个任务。

**为什么用 nonce 而不是 agent 名**：12 个角色名是复用的，同一次 run 里会有两个 `executor`。
**为什么不用 `--task` 硬指**：那等于人工把痕迹塞给某个任务，对账结果就变成假的。
（`--task` 只在 nonce 全对不上时作为显式回退，且 `observe` 会打印归属了几份。）

结果：任务判 `UNREPORTED` 而不是 `EMPTY`——**主线程知道「有东西产出，只是没人说」**。
这正是用户要的那条：不必依赖它报告。

### 3.2 子 agent 报告了但文件不存在

**发现方式：自述里的 sha256 / 字节数 vs 现场 `stat`。**

`claim` 时立刻对文件做 `stat` + `sha256`，写进自述行。对账时再算一次：

- 文件不在 → `MISSING`；
- 在但 hash 不同 → `DRIFTED`；
- 在且 hash 相同，但任一侧被截断（文件 > 4 MiB）→ `OK_WEAK`。

**为什么不判 `DRIFTED` 而判 `OK_WEAK`**：截断比对只覆盖前 4 MiB，尾部变化看不见。
「没看出差异」不等于「没有差异」——这是 `verify-claims.mjs` 的 `UNKNOWN` 纪律（文件头第 18 行）
在文件层面的对应。

### 3.3 子 agent 产出了一半就死了

**发现方式：`PARTIAL`，并与 `EMPTY` 严格区分。**

期望里声明了 N 个文件。如果 N=3，落地 2 个：

```
ST3  ◐ PARTIAL     ├ OK       a.md
                   ├ OK       b.md
                   └ ABSENT   c.md   — 期望里有，磁盘没有
```

**它不会变成 `COMPLETE`，也不会变成 `EMPTY`。** 三种处置各自不同：
`COMPLETE` 收活，`PARTIAL` 续做/修复，`EMPTY` 查派发是否失败。

另外：`observe` 会记录**失败的写入调用**（`tool_result.is_error === true`），
在 `why` 后面追加「（该写入调用报了错）」。这让「写了但失败」和「根本没写」在报告里可区分。

### 3.4 两个子 agent 写了同一个文件

**发现方式：`CONFLICT`，且排在任何其他结论之前。**

判定表是「路径 → 声明过它的任务集合」，`size > 1` 即冲突。声明来源有三处，任一命中都算：

- 两个任务都在 `declare` 里声明了同一路径；
- 一个声明、另一个在 `claim` 里自述了同一路径；
- 两个都在 `claim` 里自述了同一路径。

**路径先归一化再比对**（`pathKey()`）。这一条是实测踩出来的：子 agent 常用绝对路径
（`D:\repo\work\a.md`），派发方常用仓库相对路径（`work/a.md`）。不归一化时，同一个文件
会被判成「期望没落地」+「额外产出」——两边都错，而且表面上看起来像是两个独立问题。

归一化规则：相对路径按 base 展开 → 反斜杠转正斜杠 → Windows 下小写（NTFS 大小写不敏感）。
**只在比较时用**；台账与报告里打印原样路径，否则人就认不出自己给的那个字符串了。

### 3.5 主线程崩溃后重启

**发现方式：`adopt`。**

台账是 **append-only JSONL**：没有任何「修改」操作。所以崩溃最多丢掉最后几行，
不会把已记录的事实改坏。重启后：

```bash
node scripts/claim-ledger.mjs adopt --run <run-id>
```

它列出所有 `consumed === false` 的任务——即「产出已经在了（磁盘 + 痕迹都对得上），
但主线程还没接手」的那些。每个任务附带一条 `consume` 命令。

**`consumed` 是独立于「产出是否完整」的第二个维度。** 一个 `COMPLETE` 但未认领的任务，
`summary.ok` 仍然是 `false`——因为「产出在」和「主线程知道了」是两件事，而后者才是这次要治的病。

### 3.6 Bash 写出的文件：只认「可确定解析」的那一类

（2026-11-13 更新。本节原先写的是「一律不认」，理由——**猜路径必然误判**——仍然成立；
改变的是范围：把「猜」和「解析」分开，只对后者开口。实现与实测见
`docs/research/2026-11-13-bash-write-detection.md`。）

`bashWrites(cmd, cwd)` 只在**目标路径是字面量**时给出结果：

| 认 | 形态 |
|---|---|
| ✅ | 输出重定向 `> p`、`>> p`、`2> p`、`&> p` |
| ✅ | `cat > p <<'EOF' … EOF`（heredoc 正文整段丢弃，里面的 `>` 不是重定向） |
| ✅ | `tee p`、`cp src dst`、`mv src dst`（单源单目标） |
| ✅ | 命令里的字面量 `cd`：`cd sub && echo x > y.txt` → `<cwd>/sub/y.txt` |

| 不认 | 原因 |
|---|---|
| ❌ | 含 `$`、反引号、`*`、`?`、`[]`、`{}`、`~` 的路径（要展开才知道值） |
| ❌ | `cd $VAR` / `cd $(…)` / `pushd` / 子 shell：基准目录不可知 → **整条命令放弃**，不留前半截 |
| ❌ | `find -exec`、`xargs`、`sh -c "…"`、`eval`：路径在动态命令里 |
| ❌ | `mkdir`（目录不是文件）、`sed -i` / `perl -i`（原地改写 + 备份文件名判不准） |
| ❌ | `/tmp`、`/dev/null`、`%TEMP%`：判得出，但实测主流形态是探针，不是交付物 |
| ❌ | 没有 cwd 时的相对路径 |

**看不见的部分必须可数。** `bashWriteScan` 把每一类跳过分别计数，`observe` 把它们打进报告。
理由是本文件反复出现的那条：空结果不能当通过——「没有产出」与「没看」必须长得不一样。

**兜底不变**：Bash 产出的文件仍然可以（也应该）被 `declare` 显式声明，那时走磁盘比对，
完全不依赖解析。

---

## 4. 工具：`scripts/claim-ledger.mjs`

零依赖，只读（除五个写台账的子命令）。

### 4.1 六个子命令

| 命令 | 谁跑 | 什么时候 | 作用 |
|---|---|---|---|
| `declare` | 主线程 | 派发前 | 登记「这个任务该产出哪几个文件」，打印 nonce |
| `claim` | 子 agent（可选） | 每落一个文件 | 追加一条自述（含 sha256） |
| `observe` | 主线程 | 收活时 | 从 transcript 抽写入痕迹，不需要子 agent 配合 |
| `verify` | 主线程 | 收活时 | 四方对账，退出码 0/1 |
| `adopt` | 主线程 | 重启后 | 列出「有产出未认领」的任务 |
| `consume` | 主线程 | 接手后 | 标记已认领 |

```bash
# 派活前
node scripts/claim-ledger.mjs declare --run 2026-11-13-x --task ST1 \
  --paths docs/a.md,scripts/b.mjs --role executor --timeout-min 8
# → nonce: f383b473   把它拼进派发 prompt

# 收活前（可选，但强烈建议：它不依赖子 agent 配合）
node scripts/claim-ledger.mjs observe --run 2026-11-13-x --session <会话目录>

# 对账
node scripts/claim-ledger.mjs verify --run 2026-11-13-x          # 人读
node scripts/claim-ledger.mjs verify --run 2026-11-13-x --json   # 机器读
```

### 4.2 退出码

| 码 | 含义 |
|---|---|
| 0 | 全部 `COMPLETE` 且已认领 |
| 1 | 有缺陷（含未认领、含台账不存在） |
| 2 | 用法错误 / nonce 重复 / run 不存在 |

### 4.3 空结果的三条诚实规则

1. **台账为空 → 退出码 1**，报告印「这不是『全部完成』——是『从没登记过期望』」。
2. **`observe` 找不到任何 transcript → 退出码 1**，印「这不是『没有产出』——是『看不到』」。
3. **`observe` 扫到了 transcript 但一份都归属不上 → 不写任何行**，印「归属不了就不写：
   把它们记到某个任务名下会让对账结果变成假的」。
4. **台账里有读不懂的行 → 计数并列出，不参与对账**，其余照常。

这四条对应当前仓库里反复出现的一类失效：把「没检查」显示成「检查过且通过」
（`healthCheck` 的 `verified: false`、`verify-claims` 的 `UNKNOWN` 都是同一个教训）。

### 4.4 性能

- 定长 nonce 匹配只读每份 transcript 头部 **64 KiB**；
- 抽写入痕迹只读尾部 **8 MiB**（子 agent 的产出几乎都在生命后半段）；
- `sha256` 上限 **4 MiB**，超过就截断并标 `hashTruncated`；
- `probe` 可注入，测试不碰真实文件系统。

这些数字都是常量（`SUBAGENT_HEAD_BYTES` / `OBSERVE_TAIL_BYTES` / `HASH_MAX_BYTES`），
不是拍脑袋写死在散文里——`checkDocConstants()` 会核对文档写的值与源码一致。

### 4.5 台账长什么样

`tasks/runs/<run-id>/claims.jsonl`（那个目录已经 gitignore，且已经是 run 的既有落点）：

```jsonl
{"v":1,"ts":"2026-11-13T...","kind":"expect","run":"r1","task":"ST1","role":"executor","paths":["a.md","b.md"],"nonce":"f383b473","timeoutMin":8}
{"v":1,"ts":"...","kind":"claim","run":"r1","task":"ST1","agent":"a03ff","path":"a.md","source":"self","bytes":1024,"mtimeMs":1794...,"sha256":"..."}
{"v":1,"ts":"...","kind":"observe","run":"r1","task":"ST1","agent":"a03ff","path":"b.md","source":"write-tool","failed":false,"evidence":"agent-a03ff.jsonl#42"}
{"v":1,"ts":"...","kind":"consume","run":"r1","task":"ST1","path":null,"by":"main"}
```

四种行：`expect` / `claim` / `observe` / `consume`。**没有第五种**，也没有任何「更新」行。

---

## 5. 与现有资产的关系

### 5.1 `tasks/runs/` 台账——直接复用，不新建

`tasks/runs/<run-id>/` 已经是 run 的落点（`task-graph.json`、`baseline.md`、`state.json`），
且已在 `.gitignore` 里（运行台账可能含会话 ID 与本机路径，不可发布）。
`claims.jsonl` 放在那里，**不引入新的目录约定**，`check-structure.mjs` 的
`checkAbsolutePaths()` 也不会拦它（`tasks/runs` 在 `PRIVATE_PATHS` 里）。

### 5.2 `check-structure.mjs`——借用思路，不借代码

它已经能检查「文件存在」（`checkDocReferences()`）与「导出的函数能被调用」
（`checkImportable()` + `PROBE_ARGS`）。本工具的两处借法：

- **导出登记**：`claim-ledger.mjs` 的 31 个导出全部登记进 `PROBE_ARGS` 或
  `INTENTIONALLY_PROBED_FREE`，判定层函数会被硬门真实调用一次。
  这样「新加一个纯函数忘了测」会在结构门就暴露，而不是等到线上。
- **常量对账**：`HASH_MAX_BYTES` / `SUBAGENT_HEAD_BYTES` / `OBSERVE_TAIL_BYTES`
  写进文档时，`checkDocConstants()` 会核对。

**不借的部分**：`check-structure.mjs` 检查的是「文档指向的路径存在」，那是**静态**的；
产出对账检查的是「任务产出的路径存在」，那是**动态**的，且需要 run 上下文。
两者不能合并，否则硬门会依赖运行台账（而台账被 gitignore，CI 里没有）。

### 5.3 `verify-claims.mjs`——这是同一个问题的两个层面

用户在第 5 条里点出的判断是对的：**「声称做了 vs 真的做了」是一件事。**

| | `verify-claims.mjs` | `claim-ledger.mjs` |
|---|---|---|
| 对象 | 一个**会话** | 一个**派发任务** |
| 声称 | 末条 assistant 文本里的完成性断言 | `claim` 行 + 返回文本里的交付物路径 |
| 证据 | transcript 里的工具调用与退出码 | 磁盘 `stat`/`sha256` + transcript 里的写入调用 |
| 判定 | `SUPPORTED` / `STALE_ONLY` / `FAILED_ONLY` / `NO_EVIDENCE` / `UNKNOWN` / `UNCHECKABLE` | `OK` / `UNREPORTED` / `MISSING` / `DRIFTED` / … |
| 共性 | **「没读到」不等于「不存在」**——`UNKNOWN` 不判失败 | **「没自述」不等于「没产出」**——`UNREPORTED` 靠痕迹发现 |

两者刻意共用了同一条纪律，但**没有共用代码**：`verify-claims` 处理的是自然语言断言，
`claim-ledger` 处理的是文件路径。强行合并会让前者多出一堆「路径语义」，后者多出一堆「正则」，
两边的判据都会变松。**共享的是设计范式（三方交叉 + 三值判定 + 截断即弱证据），不是实现。**

**一个可以以后做、但现在不做的合并**：让 `claim-ledger` 的 `verify` 顺手调用
`verify-claims` 扫同一个 run 的子 agent transcript，把「它说测试通过了」也纳入对账。
这需要先解决「哪些断言属于哪个任务」，而当前 `verify-claims` 是会话级的——
没有 nonce 级别的归属，做了会造出假的对应关系。**记录为后续项，不在最小可用版内。**

---

## 6. 最小可用版本解决了哪几个场景

**已实现（可运行、有测试）：**

| 场景 | 解决程度 | 靠什么 | 测试 |
|---|---|---|---|
| 产出了文件但没报告 | ✅ 能发现 | `observe` + 磁盘 `UNREPORTED` | 「产出了文件但没人自述 → UNREPORTED」 |
| 报告了但文件不存在 | ✅ 能发现 | `claim` 的 sha256 vs 现场 `stat` → `MISSING` | 「自述说写了、磁盘没有 → MISSING」 |
| 产出一半就死了 | ✅ 能区分 | `PARTIAL` vs `EMPTY` | 「一半落地一半没落地 → PARTIAL」 |
| 两个 agent 写同一个文件 | ✅ 能发现 | `CONFLICT`，且先于一切结论 | 「两个任务声明同一路径 → CONFLICT」 |
| 主线程崩溃后重启 | ✅ 能恢复 | `adopt` 列未认领项 | 「无 consume → consumed=false …」 |
| 文件在自述之后被改 | ✅ 能发现 | hash 不等 → `DRIFTED` | 「自述之后文件被改过 → DRIFTED」 |
| Bash 写出的文件没报告 | ❌ 漏 | 见 §3.6 | — |
| 语义层面「做对了没有」 | ❌ 不做 | 那是 `acceptor` 的活 | — |

**没做的（下一版）：**

| 项 | 为什么现在不做 |
|---|---|
| ~~接入 `SKILL.md` 派发链路~~ | **已完成（2026-11-13）**：§7 四项全部落地，见 `docs/research/2026-11-13-output-reconciliation-integration.md` |
| `verify` 自动调 `observe` | 现在是两步（先 `observe` 再 `verify`）。自动化的前提是 `verify` 知道该扫哪个会话目录——`declare` 时补一个 `--session` 即可，但那是接口变更 |
| 与 `verify-claims` 合并 | 见 §5.3，需要先解决任务级归属 |
| TUI 里显示产出对账结论 | `oversight-tui.mjs` 已有三段视图，加第四段是纯展示层工作 |

---

## 7. 派发链路怎么接（未实现，写清改法）

### 7.1 `SKILL.md` 的 Phase B（派发）

派发每个 Agent 之前：

```bash
node scripts/claim-ledger.mjs declare --run <run-id> --task ST1 \
  --paths <从 task-graph 的 subtrees[].goal 里推不出来的，必须 Planner 声明>
```

**这里有一个必须解决的接口缺口**：`task-graph.json` 现在**没有「产出路径」字段**。
`acceptance[].evidence` 是 `<file:line>` 或链接（指向既有文件），不是「我要产出什么」。
所以 `declare` 的 `--paths` 目前只能由主线程现写，等价于把 Planner 该做的推给了主线程。

**正确改法**（下一版）：给 `validate-run.mjs` 的 subtree schema 加一个必填字段
`outputs: string[]`，表示「这个子树应当产出哪些文件」。它与 `acceptance[]` 的关系是：
`acceptance` 说「怎么算过」，`outputs` 说「过的时候磁盘上多了什么」。两者不可互推——
一条 AC 可能不需要新文件（「不加依赖」），一个 output 可能不对应任何 AC（「顺手写的日志」）。

### 7.2 派发 prompt 里必须带 nonce

公共段 `templates/dispatch.md` 追加一段：

```
## 产出登记（必须做）

你的任务产出路径已登记：
  <paths>

每写完一个文件，立刻执行：
  node scripts/claim-ledger.mjs claim --run <run-id> --task <task-id> --path <那个路径>

**不执行也不会漏**——主线程会读你的 transcript。但执行了，对账就能立刻判「内容没被人改过」。
把 nonce `<nonce>` 保留在你的第一条消息里（它用于把 transcript 归属到这个任务）。
```

最后一句是关键：nonce 已经写在 prompt 里，而 prompt 是子 agent transcript 的第一条 user 消息，
所以 `observe` 读头部 64 KiB 必然找到它。**这是一个不需要子 agent 做任何事的归属机制。**

### 7.3 `executor` / `repair` 的角色定义

「## 输出」节的三元组改为四元组，加一节：

```
## 我产出的文件
- <路径> —— <字节数>   （或：无）
```

并明写：**这一节不是给你自我评价用的，是给主线程对账用的。写错路径比不写更糟。**

### 7.4 验收前置一道对账

`SKILL.md` 的 Phase E 之前：

```bash
node scripts/claim-ledger.mjs verify --run <run-id> || exit 1
```

`PARTIAL` / `MISSING` / `CONFLICT` 时**不进入验收**——验收一个不完整或身份不明的交付物，
只会得到一份「不通过」，然后修复 Agent 去修一个可能根本不存在的东西。

---

## 8. 负向验证（回退即红）

每条都是「把机制去掉，测试必须变红」：

| 若去掉… | 哪条测试会红 |
|---|---|
| `observe` 的痕迹来源 | 「产出了文件但没人自述 → UNREPORTED」——没有痕迹时该场景会被判 `ABSENT`/`EMPTY` |
| `claim` 里的 sha256 | 「自述之后文件被改过 → DRIFTED」——只比字节数永远相等 |
| `PARTIAL` 与 `EMPTY` 的区分 | 「一半落地一半没落地 → PARTIAL」 |
| `CONFLICT` 的优先级 | 「两个任务声明同一路径 → CONFLICT，且先于 COMPLETE 判定」 |
| `pathKey` 归一化 | 「相对路径的期望与绝对路径的自述能对上」——会退化成 UNREPORTED + 一条虚假 EXTRA |
| `consumed` 维度 | 「产出完整但未认领，不能算通过」 |
| 「空台账 ≠ 通过」 | 「台账为空 → summary.ok=false」 |
| 「静默不是判据」 | 「静默不构成失败判据，只标 quiet」 |
| nonce 边界匹配 | 「findNonce 有边界，不许前缀命中」 |
| `observedWrites` 的失败识别 | 「失败的 Edit 不构成产出」 |

**结构门层面**：`claim-ledger.mjs` 的 31 个导出全部登记进 `PROBE_ARGS` /
`INTENTIONALLY_PROBED_FREE`。删掉任何一个登记项，`checkUnregisteredExports()` 会列出它；
把某个导出的函数体改坏到调用即抛，`checkImportable()` 会红。

---

## 9. 这份设计**不做**什么

诚实标注，避免被当成更大的承诺：

1. **不判断产出对不对。** 只看文件在不在、内容变没变。一个内容完全错误的文件，只要
   自述的 hash 对得上就是 `OK`。这是 `acceptor` 的活，不是对账的活。
2. **不保证子 agent 没撒谎。** 它可以在 `claim` 里写一个假的 hash——但那要求它主动伪造，
   而当前形态下它**什么都不做**就已经瞒过去了。把「主动伪造」与「没报告」分开，是本机制的全部收益。
3. **不覆盖路径不可确定解析的 Bash 写入**（§3.6）。字面量路径的重定向 / `cp` / `mv` / `tee` / heredoc 已能识别；
   变量、通配、`find -exec`、子 shell、`/tmp` 探针仍不认。
4. **不改变任何现有行为。** 本次只新增 `scripts/claim-ledger.mjs` + 测试 + 文档；
   派发链路（§7）一行未动。`SKILL.md` 不调它，它就完全不存在。
5. **不能替代 `verify-claims` 的断言层。** 两者处理的是不同粒度的同一件事（§5.3）。

---

## 10. 复跑

```bash
node scripts/claim-ledger.mjs help                   # 用法
node --test scripts/claim-ledger.test.mjs            # 46 条
node scripts/check-structure.mjs                     # 硬门
node --test scripts/*.test.mjs                       # 全量（927 条）
```
