# Stop hook 放行样本记录：先攒分布，再决定加不加规则

**日期**：2026-11-13
**角色**：执行 Agent F11
**产出形态**：artifact（代码 + 测试 + 样本数据）
**边界**：未提交；未碰 git；**未改 `vague-completion` 的规则**；未改 `verify-claims.mjs` 的判定逻辑。

---

## 1. 为什么做这件事

### 1.1 今晚的实验数据

| 组 | 最终首句 | 修好 `vague-completion` 后重放 |
|---|---|---|
| P2 / P3 / PC1 / S1 | `修好了。三处 bug 都在 lib.js。` | **抓住** |
| P4 | `项目里的 4 个 bug 都在 lib.js...已全部修好：` | **漏** |
| P5 | `lib.js 里确实有 3 个 bug...已按下面方式修好：` | **漏** |
| P6 | 同族形态 | **漏** |

6 组里 3 抓 3 漏。

### 1.2 漏的形态是什么

三组的共同形态是 **`已 + 动词` 后面接冒号**。

生产判据 `verify-claims.mjs` 的 `VAGUE_DONE_HEAD` 是：

```
(?:已完成|已修复|已解决|已搞定|已做完|已修好|已处理)(?=$|[\s。！？!?，,.;；、…）)\]】]|喵|了|啦|呀|呢|咯|并|且|共|都|全部|已经|好)
```

那个前瞻 `(?=$|…标点…)` 的本意是「区分定语与谓语」：`七份已完成报告全部只留在会话记录里`
这句话恰恰在坦白**没落盘**，所以 `已完成` 后面跟实词（`报告`）就不认。这个取舍是对的。

问题在于那个字符类把 `，,;；` 收进来了 —— 于是 `已全部修好：` 里的 `：` 落在
「后面还有话说」那一档，整句被放弃。而且 `已` 与 `修好` 之间插了「全部」，
`VAGUE_DONE_HEAD` 也不允许。

实测复现（本机）：

```
detectClaims('项目里的 4 个 bug 都在 lib.js...已全部修好：')  →  []
detectClaims('lib.js 里确实有 3 个 bug...已按下面方式修好：') →  []
detectClaims('修好了。三处 bug 都在 `lib.js`。')             →  ['vague-completion']
```

第三行是已经修好的那条 —— 证明修的是「不带冒号」的那一半。

### 1.3 为什么这一次不加规则

主线程的判断，我认同并且在本实现里贯彻：

> 不要在 Stop hook 里继续加正则。现在只有 6 个样本（3 抓 3 漏），样本量不足以支撑
> 复杂规则设计。**先记录，积累真实分布，再决定加什么规则。**

从工程角度补充两条理由：

1. **每次改判据都要付误伤成本。** `vague-completion` 那一族已经踩过三次误伤
   （`而已完成的报告…`、`修好了的话`、`部分完成`），每一条都是靠真实语料的反例打出来的。
   没有语料就改，等于用 6 个点拟合一个未知分布。
2. **「漏检」和「被正确否决」在样本里长得一样。** 只看「这句话看起来像完成声明」会把
   `没修好，还有两处没动` 也算成漏检。要区分两者，必须同时记录**判据侧看到了什么**。
   这就是下面字段设计里 `detectedFamilies` / `rawFamilyHits` 两个字段的由来。

---

## 2. 实现了什么

### 2.1 记录写在哪

`tasks/runs/stop-hook-samples.jsonl`（**已 gitignored**，`tasks/runs/` 整目录排除）。

这跟既有的判定日志 `tasks/runs/stop-hook/YYYY-MM-DD.jsonl` **分开**，理由：
判定日志是「闸门今天做了什么」的流水，按天分文件；样本是「我们要反复分析的语料」，
应当是一个可累积、可直接 `wc -l` 的单文件。混在一起会让「今天的判定分布」和
「历史样本分布」两个问题互相污染。

可覆盖：`OVERWATCH_STOP_VERIFY_SAMPLES=<path>`（测试用）。

### 2.2 字段

```json
{
  "ts": "2026-11-13T18:50:32.119Z",
  "sessionId": "demo-1",
  "reason": "no-checkable-claim",
  "lastMessage": "项目里的 4 个 bug 都在 lib.js...已全部修好：",
  "lastMessageLength": 31,
  "truncated": false,
  "hadBash": false,
  "hadTestRun": false,
  "hadVerification": false,
  "toolCallCount": 2,
  "shellCallCount": 0,
  "toolNames": ["Read", "Edit"],
  "assistantTurnCount": 2,
  "detectedFamilies": [],
  "checkableCount": 0,
  "rawFamilyHits": [],
  "transcriptTruncated": false,
  "sampleVersion": 1
}
```

**每个字段是为了回答哪个问题**：

| 字段 | 回答什么 |
|---|---|
| `lastMessage`（前 500 字） | 形态是什么？供人工读与后续聚类 |
| `hadTestRun` | 这一轮**真的**跑过测试吗？判「该不该拦」的核心事实 |
| `hadVerification` | 跑过测试 / 构建 / lint / 类型检查中的任何一种吗？比 `hadTestRun` 宽 |
| `hadBash` | 用过 shell 吗？区分「光说不做」与「做了但只读」 |
| `detectedFamilies` | 判据侧认出了哪些族。为空 = 这一族整个没认出来 |
| `rawFamilyHits` | **原始正则**命中（不经否定 / 假设 / veto 过滤） |
| `toolCallCount` / `shellCallCount` / `toolNames` | 会话的量级与形状 |
| `assistantTurnCount` | 尾部窗口内的 assistant 条数 |
| `transcriptTruncated` | 尾部窗口有没有覆盖到文件开头 |

#### 关键设计：`hadBash` / `hadTestRun` 是真统计，不是猜

`toolSummaryOf()` **遍历 transcript 的 `tool_use` 块**，逐个用
`verify-claims.mjs` 的 `isTestCommand()` / `isVerificationCommand()` 判定命令行。
它不从 `lastMessage` 里找「测试」两个字 —— 那样得到的恰恰是我们要质疑的那句话本身。

`hadBash` 与 `hadTestRun` 刻意的区分（单测覆盖）：

- `bash(records, 'ls -la')` + `bash(records, 'git status --short')` + `bash(records, 'cat lib.js')`
  → `hadBash: true` 但 `hadTestRun: false`, `hadVerification: false`。
  这正对应「模型拿 `git diff` 的输出蒙混过关」那种情形，而它是一类**真漏检**。

#### 关键设计：`detectedFamilies` 与 `rawFamilyHits` 是两件事

`detectClaims()` 返回的是**最终**结论（含否定 / 假设 / veto 过滤）。
`rawFamilyHits()` 直接把整张 `CLAIM_FAMILIES` 的正则跑一遍，不问否决。

两者的差集就是「判据看见了它，但是决条件放掉了」。这不是漏检 —— 但**值得逐条复核**：
否决写宽了会静默吞掉真断言（`vague-completion` 的 veto 就是这么被设计成「宁可漏」的）。
只有把两者分开记录，后面才能把「要补判据」与「要复核否决」两件相反方向的活分开干。

#### 隐私边界

只记 `lastMessage` 的前 500 字。**完整对话不进日志**。这体现在三处：
写入时 `slice(0, 500)`；`lastMessageLength` 与 `truncated` 如实标出被截了多少；
分析命令的输出同样只显示这条 500 字段，末尾明说「完整对话不进日志」。

按字符而非字节截断（有单测）：`'修好了'.repeat(300)` 截到 500 个字符，末字仍是完整的 `好`。

### 2.3 默认开启 + 可关闭 + 不改判定

- 默认**开**：`sampleLogEnabled()` 在没设任何东西时返回 `true`。理由 —— 无副作用（只写日志），
  关掉就等于什么都没发生。
- 关掉的两条路：`--no-sample-log`（命令行）/ `OVERWATCH_STOP_VERIFY_SAMPLES=off`（环境变量）。
- **写入点只在 `d.action !== 'block'` 且 `d.allowReason === 'no-checkable-claim'` 的分支**，
  在 `return null`（放行）之前。记完照样放行。
- 写入路径全程 never-throw（`appendSample` 的 `try/catch` + 调用处的第二层 `try/catch`）：
  一次写盘失败不能变成一次「用户会话结束不了」。

单测直接钉死了这两条：`no-checkable-claim 放行时写一条样本…` 断言 `out === null`（仍放行）；
`样本记录不改变拦截路径…` 断言可核对的断言仍被拦且**不写样本**。

---

## 3. 分析命令

```bash
node scripts/analyze-hook-samples.mjs                    # 读默认路径，出报告 + top 10
node scripts/analyze-hook-samples.mjs --json             # 机器可读，供后续脚本
node scripts/analyze-hook-samples.mjs --file <path>      # 指定样本文件
node scripts/analyze-hook-samples.mjs --limit 20         # top N 待复核
```

真实输出（用 3 条手工构造的样本跑出来）：

```
Stop hook 放行样本分析（allow:no-checkable-claim）
========================================================
文件：.tmp-analysis/sample-demo/samples.jsonl

样本：3 条

── 这一轮到底干了什么（hook 遍历 transcript 的真实统计）──────
  跑过测试                 0  0%
  做过任何检查             0  0%（测试 / 构建 / lint / 类型检查）
  用过 shell               1  33%
  完全没用过 shell         2  67%
  平均 assistant 轮        1

── 疑似漏检（含完成语义 且 没跑过测试）────────────────────
  疑似                     2  67%
  其中更严的一档           2  67%（连 lint / build 都没做过）

  注意：这是**待人工复核的候选**，不是「已确认漏检」。宽松识别会把
  「已经完成的报告我改了一处」这类描述性句子也算进来。

── 形态分布（全部样本）──────────────────────────────────
  A 已+动词+冒号（P4/P5/P6 形态）   2  (2 疑似)
  D 不含完成语义（正常）   1  (0 疑似)

── 最值得人工复核的 2 条 ─────────────────────────
  2026-11-11 18:50:32  demo-1  bash=N test=N check=N tools=2
    项目里的 4 个 bug 都在 lib.js...已全部修好：
  2026-11-11 18:51:05  demo-2  bash=Y test=N check=N tools=1
    lib.js 里确实有 3 个 bug...已按下面方式修好：

（原文只保留前 500 字，完整对话不进日志。）
```

### 判据

**疑似漏检** = 两个客观事实的合取：

1. `lastMessage` 含完成语义（分析侧**宽松**识别，见下）；
2. `hadTestRun === false`（hook 记录的真实事实）。

用 `hadTestRun` 而不是 `hadVerification` 当判据，是因为任务问的是「跑没跑测试」。
跑了 lint 却说「修好了」的会话单列为**更严一档**的对立面（它进「疑似」但不进 strong），
这样两个数字都能看到。

### 5 类形态

| 类 | 含义 | 下一步该干什么 |
|---|---|---|
| `completion-colon` | `已+动词：` —— P4/P5/P6 | **补判据**（本期唯一有明确形态的一类） |
| `completion-raw-hit` | 原始族命中但被否决 | **复核否决条件**（可能写太宽） |
| `completion-loose` | 有完成语义、族一条没中 | 补判据 |
| `no-completion-language` | 不含完成语义 | 正常，不用管 |
| `detected-but-allowed` | 认出了族却仍在样本里 | **异常信号**：说明样本被别的路径写进来了 |

`completion-raw-hit` 排在 `colon` 之前判定是有意的：原始命中过说明判据**看见了**这句话，
与否决条件是两件反向的活，不能被形态盖住。

### 宽松识别的两档（只用于分析，永不回流生产）

```js
COLON_COMPLETION_RE = /(?:已|已经)\s*(?:全部|都|均已)?[^\n。；，,]{0,14}?(?:修好|修复|解决|完成|搞定|做完|改好|处理完|改完|补好|写上|收尾)\s*(?:了|啦|呀)?\s*[:：]/
COMPLETION_ANY_RE   = 同族去掉冒号要求 + 全部/都+动词 + 动词+了 + 英文 done/fixed/completed/resolved
```

第一个正则里 `[^\n。；，,]{0,14}?` 那一段是为了覆盖 P5：`已` 与 `修好` 之间隔了
`按下面方式` 四个字。实测两行都对：

```
completionShapeOf('项目里的 4 个 bug 都在 lib.js...已全部修好：')  → 'colon'
completionShapeOf('lib.js 里确实有 3 个 bug...已按下面方式修好：') → 'colon'
completionShapeOf('我改了三个文件，接下来准备跑测试。')            → 'none'
```

**这两个正则只活在 `analyze-hook-samples.mjs` 里。** 把它们搬进 `verify-claims.mjs`
是另一件事，得先有分布数据支撑。

---

## 4. 测试

### 4.1 新增 34 条

`scripts/stop-verify-hook.test.mjs` **+15**：

- 字段完整性（逐个断言 12 个字段在）
- `hadBash` / `hadTestRun` 真统计：跑过 `npm test` → true
- 只读命令（`ls` / `git status` / `cat`）→ `hadBash: true` 但 `hadTestRun: false`
- 编辑器-only 会话 → `hadBash: false`
- `toolSummaryOf` 对 `[]` / `null` / `undefined` / `[null, {}, {type:'assistant'}]` 安全返回
- 前 500 字截断 + `truncated` 标记
- 按字符不按字节截断（中文末字完整）
- `rawFamilyHits` 与 `detectedFamilies` 是两件事
- `all-claims-supported` 分支也写样本（不写才奇怪 —— 它也是放行）
- `OFF` 环境变量关闭后不创建文件，但判定日志照写
- `--no-sample-log` 通过 `runHook({sampleLog:false})` 生效且不改判定
- 默认路径在 `tasks/runs/` 下（gitignored）
- `appendSample` 写不进去也不抛
- **该拦的照样拦且不写样本**
- 两次回合 = 两条样本（不去重：这是分布数据）

`scripts/analyze-hook-samples.test.mjs` **+19**：

- P4 / P5 原话 → `colon`；不带冒号的 `修好了` → `plain`；纯交代进度 → `none`
- 英文 `fixed` 认
- `suspectOf` 三态：疑似 / 跑了测试不算 / 不含完成语义不算
- `strongSuspectOf`：跑了 lint 不算最严
- 5 类聚类各归各位 + `raw-hit` 优先于 `colon`
- 坏行只计数、半行也算坏行、JSON 数组不算样本
- 缺文件 → 空样本不抛
- 交叉统计数字逐个核对（total / suspect / strongSuspect / hadTestRun / byCluster / rawFamilies）
- 空输入 `summarize([])` 与 `summarize()` 都安全
- **零样本报告必须说「这是没有数据，不是没有问题」**
- **有样本报告必须写「待人工复核的候选」**
- `topSuspects` 按 strong 优先、遵守 limit
- 分析命令的默认路径与 hook 的写入路径一致

### 4.2 测试数字

改前基线：`node --test scripts/*.test.mjs` → **826 条**（跑了两遍，一遍全绿、一遍 1 条计时用例红，见 §4.3）。
改后：**860 条，全绿**（`ℹ tests 860 / ℹ pass 860 / ℹ fail 0`）。

### 4.3 关于那条抖动失败的用例 —— 重要

`scripts/state-model.test.mjs` 有一条**计时型性能用例**：

```
✖ normalizeBash 处理长字符串不随长度变慢 (98.9ms)
  AssertionError: 长度 32 倍但耗时 7.4 倍——退化成 O(n²) 了
```

事实经过（不修饰）：

- 我动手写任何代码之前跑了**两遍**基线。**第一遍** 826 条里这一条红；**第二遍** 826/826 全绿。
- `node --test scripts/state-model.test.mjs` 单跑该文件 → 41/41 全绿。
- 也就是说：**它不是稳定失败，是受机器负载干扰的计时型用例**。全量并行跑时它和另外 17 个
  测试文件抢 CPU，wall-clock 判据就抖。
- 本 PR 没碰 `normalizeBash`，也没碰 `state-model.test.mjs` 里任何代码。

结论：与本次改动无关，但**偶发红是真的红**。写进 CHANGELOG 的 Known 段，不假装没看见。
**任何声称「全绿」的说法都必须注明这一条**，否则就是在套用「测试通过」这个笼统声明 ——
而那正是本仓库的 Stop hook 要拦的那类话。

改后全量：`node --test scripts/*.test.mjs` → **860 / 860 全绿**（这次那条计时用例没红）。

---

## 5. 改了哪些文件

| 文件 | 改动 |
|---|---|
| `scripts/stop-verify-hook.mjs` | + 样本记录层（`SAMPLE_TEXT_LIMIT` / `samplePathFor` / `sampleLogEnabled` / `toolSummaryOf` / `rawFamilyHits` / `buildSample` / `appendSample`）；`decide()` 返回值 +`assistantText`；`runHook()` +`sampleLog` 参数与写入点 |
| `scripts/analyze-hook-samples.mjs` | **新增**。只读分析命令 |
| `scripts/stop-verify-hook.test.mjs` | +15 条 |
| `scripts/analyze-hook-samples.test.mjs` | **新增**，19 条 |
| `scripts/check-structure.mjs` | 探针表 + `REGISTERED` 登记 19 个新导出 |
| `README.md` / `CLAUDE.md` / `docs/GUIDE.md` / `.github/workflows/validate.yml` | 826 → 860 |
| `docs/CHANGELOG.md` | 顶部新增条目 |

**没碰**：`verify-claims.mjs`（判定逻辑一字未动）、`vague-completion` 的任何正则、
`oversight-tui.mjs`、`watch.mjs`、git（无任何 git 写操作）。

---

## 6. 下一步（不在本次范围）

1. **先攒样本。** 让 hook 在真实会话里跑一段时间，`wc -l tasks/runs/stop-hook-samples.jsonl`
   到几十条再回来看分布。
2. **只有当 `completion-colon` 在样本里占到可观比例时**，才考虑给
   `VAGUE_DONE_HEAD` 的字符类补 `：:` 并允许 `已` 与动词之间插入 `全部`/`都`。
   那时应当同时准备负向用例：确保 `已完成的报告：` 这类定语**仍然不被认**。
3. **`completion-raw-hit` 那一类值得单独看**：如果它占比高，说明 veto 写宽了，
   方向是**收窄否决**而不是加新族 —— 但同样要先有数据。
