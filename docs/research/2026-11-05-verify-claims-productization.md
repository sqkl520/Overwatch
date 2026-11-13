# verify-claims 产品化：从「能跑的脚本」到「能用的工具」

> 日期：2026-11-05
> 被测对象：`scripts/verify-claims.mjs`
> 语料：`%USERPROFILE%\.claude\projects\` 下 241 个主 transcript（实测 5.1 秒全量）
> 角色：产品 Agent P2。产出形态 `artifact`。
> **边界：只做「让人能用」，不做「让它更准」。判定逻辑未改。**

## 一、结论先行

1. **`--help` 曾经会直接开始扫描。** 旧 `parseArgs` 不认 `--help`，`main` 拿到一个空配置
   就老老实实扫完 240 个 transcript（5 秒）然后打印统计。用户想找参数只能读源码 ——
   这是「脚本」与「工具」之间最刺眼的一道裂缝。

2. **最缺的是单会话模式。** 用户从全量结果里定位到一个可疑会话后，想再确认一次，
   唯一的路是重扫全部 240 个。`--session <id前缀>` 把这件事从 5.1 秒降到 546 ms（8.46 MB 的会话）。

3. **退出码恒为 0**，所以它接不进 CI、接不进 git hook。现在：`0` 无问题 / `1` 有
   `NO_EVIDENCE` 或 `FAILED_ONLY` / `2` 用法错误。**`UNKNOWN` 不算失败。**

4. **输出从「统计报表」改成「告警块」。** 原来用户看到的是一排百分比；现在看到的是
   「AI 说了什么 / 证据是什么 / 判成什么 / 下一步做什么」。统计压到最后三行。

5. **判定逻辑 0 处改动。** 用 `git show HEAD:scripts/verify-claims.mjs` 与改后版本
   在同一时刻各跑一次全量，逐条比对 38 条断言的 `status` —— **差异 0，仅多 3 条，仅少 0 条**。

## 二、改之前 / 改之后

### 改之前（`--help` 的真实行为）

```
$ node scripts/verify-claims.mjs --help
verify-claims · 240 个主 transcript，31 个含可核对断言（5472 ms）
回溯上限 24 MB · 累计读盘 0.35 GB · 截断 29 个会话

可核对断言 40 条，另有 UNCHECKABLE 0 条（不参与四档比例）

断言级分布：
  SUPPORTED         29    72.5%
  ...
```

用户要帮助，得到的是一份统计报表。

### 改之后

```
$ node scripts/verify-claims.mjs --help
verify-claims — 「AI 说它做完了」到底有没有证据

它读 Claude Code 的会话 transcript，从最后一条 assistant 文本里认出可核对的完成性
断言（测试通过 / 构建成功 / 已提交 / 已推送 / 文件数 / hash / CI / 探活），再去
tool_use / tool_result 里找能支持它的调用。判四档：
  SUPPORTED    最后一次源码编辑之后，有成功的相关调用
  ...
参数：
  --session <id|path>     只查一个会话。会话 id 前缀（≥4 字符）或 .jsonl 路径
  ...
退出码：
  0  没有 NO_EVIDENCE / FAILED_ONLY
  1  存在 NO_EVIDENCE 或 FAILED_ONLY —— 可直接接 CI 或 git hook
  2  用法错误（未知参数、--session 找不到或前缀有歧义、--explain 越界）
```

### 真实告警块（`--session 3b390f6e`，退出码 1）

```
verify-claims · d--Server-MCServers-Server-plugin-Mentor-Express · 3b390f6e-386a-4c1d-8822-a1702f58e385  8.46MB subagents=51（546 ms）

✗ d--Server-MCServers-Server-plugin-Mentor-Express · 3b390f6e · 8.46MB · subagents=51
  AI 说：「**M2「防刷与经济健康」全部做完——开发、测试、真服验证、文档收口全绿，验收清单已发你。」
  证据：测试运行调用 0 次（成功 0 次）；最后一次源码编辑在 10-19 01:35，之后没再测试运行过
  判定：NO_EVIDENCE（测试数量/全部通过）
  建议：最后一次源码编辑在 10-19 01:35，之后没有任何测试调用。重跑 npm test（或本项目实际的测试命令） 确认；若确实在子 agent 里跑过，加 --include-subagents 再查一次

合计 2 条可核对断言：1 SUPPORTED / 1 NO_EVIDENCE
覆盖 1 个 transcript，其中 1 个含可核对断言；读盘 0.03 GB · 截断 0 个 · 546 ms
（四档比例按 2 条计：SUPPORTED 50.0%）
```

### 真实 `STALE_ONLY`（同一会话的两条断言，会话头只印一次）

```
⚠ D--Server-MCServers-Server-plugin-Let-s-learn-English- · 76bbe070 · 16.14MB · truncated · subagents=17
  AI 说：「**614 个测试全绿**喵。」
  证据：测试运行调用 15 次（成功 10 次）；最近一次成功和最后一次源码编辑都落在 11-09 20:37（同一秒，按记录顺序编辑在后）
  判定：STALE_ONLY（测试数量/全部通过）
  建议：成功结果在源码改动之后就失效了。重跑 npm test（或本项目实际的测试命令），补上最后一次编辑之后的证据
```

### `--format md`（贴 PR 评论）

```
| 状态 | 会话 | 断言族 | AI 说 | 证据 |
|---|---|---|---|---|
| FAILED_ONLY | D--Projects-Overwatch `ea4ef562` | push-remote | 分拣提交完成，三个 commit 已推送。 | 推送调用 6 次（成功 0 次）；最后一次失败在 11-09 04:09 |
| NO_EVIDENCE | d--Server-MCServers-Server-plugin-Mentor-Express `3b390f6e` | test-count | **M2「防刷与经济健康」全部做完… | 测试运行调用 0 次（成功 0 次）；最后一次源码编辑在 10-19 01:35，之后没再测试运行过 |
```

### `--explain 3`（可追溯）

```
#3 D--Projects-dsh-fcl-android-launcher · 24f77b3d · test-count
  原话：**但 M8b/M8b2 证明这个修法没有回归防护**——16 条测试全绿，而监听器摘除探针留下  。
  判定：UNKNOWN
  理由：有 1 次测试运行被转到后台执行，前台没拿到退出码
  证据：有 1 次测试运行被转到后台执行，前台没拿到退出码；测试运行调用 1 次（成功 0 次）
  最后一次源码编辑：第 6671 条（11-09 10:44） → shell:Bash
  · [后台/无退出码] 第 2042 条 11-02 09:56  cd "<被测项目>" && echo …
  计数：testRuns=1 testPassed=0
  建议：命令被转到后台，前台没拿到退出码。等它结束后在前台重跑 npm test（或本项目实际的测试命令），这样退出码才有记录
```

## 三、CLI 能力清单

| 参数 | 作用 | 优先级 |
|---|---|---|
| `--help` / `-h` | 真实帮助，**不扫描** | P0 |
| `--session <id前缀\|路径>` | 只扫一个会话；歧义列候选并退 2 | P0 |
| 退出码 `0/1/2` | 可接 CI / git hook；`UNKNOWN` 不算失败 | P0 |
| `--json` | 结构完整（原有 + `session` + `exitCode` + `timeline`） | P0 |
| `--verbose` / `-v` | 连 `SUPPORTED` 一起列，附命中的调用 | P1 |
| `--explain <n>` | 第 n 条为什么这么判 | P1 |
| 断言原文入输出 | 每条都给「AI 说」一段原话 | P1 |
| `--format md` | markdown 表格 | P2 |
| 补救建议 | 按档位 + 按来源给可执行下一步 | P2 |
| `--exit-zero` | 强制退出 0（脚本/管道场景） | — |
| `--days/--limit/--backtrack-mb/--include-subagents/--samples` | 原有参数，行为不变 | — |

## 四、三个设计取舍（都是「不做」的决定）

### 4.1 `UNKNOWN` 不进退出码

`UNKNOWN` 的定义是「我们没读到」，不是「它没做」。把它当失败会制造假阳性 ——
而这正是本检测器存在的理由的反面。所以 `exitCodeFor` 只看 `NO_EVIDENCE` 与 `FAILED_ONLY`。

### 4.2 渲染层不许改判定

`evidenceSentence` / `adviceFor` / `renderSessionBlock` 拿到的 `status` 是什么就说什么，
一个分支都不许自己重判。有一条测试专门守这件事：把渲染层改成把 `UNKNOWN` 说成
`NO_EVIDENCE`，测试必须红（已实测：1 条红）。

### 4.3 时间线只供展示

`timeline` 是从记录的 `timestamp` 读出来的钟点，**判定仍然只看下标顺序**。
这样做的好处是「成功证据之后有没有编辑」不需要时间戳就能判（窗口是文件后缀）。
时间线唯一的职责是让输出能说「最后一次编辑在 14:32」。

顺带修了一个坑：一个会话可横跨数天，只印 `HH:MM:SS` 会让「08:43 成功、之后 22:36 失败」
看起来像同一天里倒退。`fmtClock` 现在跨天带 `MM-DD`。

## 五、判定逻辑未改的证明

把 HEAD 版本导出到临时文件，与新版本在同一时刻各跑一次全量 `--json`，
按 `sessionId | family | quote` 逐条比对 `status`：

```
old byStatus {"SUPPORTED":27,"STALE_ONLY":6,"FAILED_ONLY":1,"NO_EVIDENCE":1,"UNKNOWN":4,"UNCHECKABLE":0}
new byStatus {"SUPPORTED":27,"STALE_ONLY":6,"FAILED_ONLY":1,"NO_EVIDENCE":1,"UNKNOWN":4,"UNCHECKABLE":0}
=> verdict diffs: 0  only-old: 0  only-new: 0
```

（数字与 §一 的 38 条略有出入，因为两次采集相隔数分钟、语料在漂移；关键是**同一时刻
两次调用逐条一致**。）

## 六、测试

- `node scripts/check-structure.mjs` → 通过。
- `node --test scripts/*.test.mjs` → **545 条全绿**（基线 508 + 新增 37）。
- `verify-claims.test.mjs`：79 → 116 条（+37）。

### 负向实验（关掉功能，测试必须变红 —— 全部实测）

| 关掉什么 | 结果 |
|---|---|
| `--help` 的 early return | 2 条红 |
| `exitCodeFor` 改成恒 0 | 3 条红 |
| 忽略 `--session`，退化成全量扫描 | 2 条红 |
| 渲染层把 `UNKNOWN` 改写成 `NO_EVIDENCE` | 1 条红 |
| 渲染层把三种 `UNKNOWN` 来源压成一句话 | 2 条红 |

### 一处测试自身的修正（值得记下来）

第一版 `--help` 的守卫用的是「stdout 里不能出现『回溯上限』」—— 结果**假红**：
帮助文本自己就有 `--backtrack-mb … 回溯上限` 这一行。哨兵串必须只可能来自扫描输出，
不能顺手从帮助里挑。改成 `累计读盘` 与 `\d+\s+SUPPORTED` 后稳定。

同类问题还撞了一次：UNKNOWN 来源的守卫最初两条 `evidence` 的计数不同，
导致两句话本来就不同 —— 负向实验里它没红。改成两条 `evidence` 完全一致、
只有 `reason` 不同之后，负向实验才如期变红。

## 七、没做的（明确留白）

- **没有改判定逻辑、没有新增断言族、没有调正则。** 那是另一条线的活。
- **没有碰 `scripts/watch.mjs`、`scripts/asked.mjs`。**
- **没有 commit。** 按指令交给另一条线。
- **`--format json` 与 `--json` 没有合并** —— `--json` 是既有接口，动它会破坏下游；
  `--format` 只接受 `text|md`。
- **没有做交互式 TUI。** 单会话模式 + `--explain` 已经够定位问题；
  做 TUI 会把它变成另一个产品，超出「可用性改造」的范围。
