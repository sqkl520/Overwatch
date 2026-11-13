# TUI 主屏实现：布局数学抽离、三段分区、空状态自证

- 日期：2026-11-10
- 角色：执行 Agent T1。产出形态：**artifact**（代码 + 测试）
- 输入规格：`docs/design/2026-11-05-tui-redesign-plan.md`（§2.4 草图 / §2.5 字段矩阵 /
  §2.6 空状态 / §九·二 三条裁决）；参考实现分析
  `docs/research/2026-11-05-dsh-tui-analysis.md`、`docs/research/2026-11-05-claude-tui-reverse.md`
- 结论：**已实现并通过验收。** `node --test scripts/*.test.mjs` → **700 / 700 全绿**；
  `node scripts/check-structure.mjs` → 通过；负向验证 **11 / 11** 处回退都让预期测试变红。

---

## 零、一句话

旧界面把「全景」和「待办」压进同一张 29 行的表，两件事都没答好。新主屏把它们**分层**：
第 1 行是判决（`3 件在等你`），第 2–5 行是判决凭什么成立（四道独立数据源），
然后才是需动作段、在跑段、已停段（压成一行）。**布局数学全部抽成零依赖纯函数，逐条可单测。**

---

## 一、实现的屏幕

| 层 | 屏幕 | 内容 | 键 |
|---|---|---|---|
| L0 | 判决行 | `N 件在等你 · M 个会话在跑 · K 个已停`，右对齐扫描新鲜度 | — |
| L1 | 检查表 | 4 行，一行不砍（裁决 R2）：等你回应 / 问了没答 / 声明对不上 / 后台监视。每行写**来源** | — |
| L2 | 需动作区 | 两行一条：①`❯ 标题 + 等了多久 + c 复制回复/Enter 看原文` ②**逐字 needs**（不摘要） | `Enter` `c` |
| L3 | 在跑区 | 单行：`标题 / …/尾两段路径 / 最后动静 / 近`（transcript 末条 assistant 文本） | — |
| L4 | 已停区 | 压成一行 `已停 (19) 1.5h–1.7d前 · h 展开 · 大部分是历史`（裁决 R1） | `h` |
| L5 | 详情首屏 | 状态 / 身份 / 最近说 / 证据 —— **只放能改变动作的四块** | `Enter` |
| L6 | 内部量与证据 | `novelty` / `calls` / `liveness` / `hbThresholdSec` / `tokens` / 派生计数；证据面板 | `i` `d` |

**四种空/坏态互相区分**（§2.6）：首扫中 / 扫完确实没事 / 扫完但监视没跑 / 扫描失败。
第三态把 `⚠ 后台监视未在运行 —— 「0 件在等你」这件事不可信` 放在判决行之后的第一屏，
**且不替换会话列表**（两者都是事实）。

---

## 二、抽出的纯函数（本次重构的主要收益）

### `scripts/tui-layout.mjs`（新文件，零 I/O、无时钟、无全局状态）

| 函数 | 职责 | 守的规格 |
|---|---|---|
| `fmtSpan` / `fmtAgeMs` / `fmtScanAge` | 时长与新鲜度，跨档边界已取整 | 无 `60s`/`24.0h` 这类边界噪声 |
| `truncateWithDisclosure` | 截断 + **可数披露** `… (+316 列)` | 溢出不得静默（Claude TUI §3.5） |
| `alignRight` / `layoutRow` / `joinWithin` | 定宽列布局，空单元格也占位 | 列恒定，不随数据抖动 |
| `windowOf` | 视口窗口化（纯函数，替换实例状态） | 光标始终可见、不跳回顶部 |
| `resolveLayout` / `layoutStages` | 6 档降级阶梯，顺序显式声明 | 76 / 60 / 44 / micro |
| `binaryOf` / `partitionRows` | 六态降二值；三段分区 | 需动作优先、活着且有 transcript 才「在跑」 |
| `verdictParts` / `stoppedSummary` / `sectionTitle` | 判决行与段标题文案 | 「N 件在等你」排第一（P2） |
| `checklistRows` | 检查表四行（含证据三态与体检标记） | 裁决 R2；「空」必须自证 |
| `footerParts` | 最后一行 = 健康度，不是键位 | §2.4 第 3 条 |
| `titleOf` / `shortPath` / `runningColumns` / `runningRowOf` / `actionRowOf` | 行渲染 | 固定列宽、三通道不重叠 |
| `composeListScreen` | **整屏组装** | 每行 ≤ cols；判决行恒第 1 行；状态行恒最后一行 |

### `scripts/tui-meta.mjs`（新文件，I/O 只有一个有界读）

`transcriptPathFor` / `metaFromRecords` / `lastSpeakerOf` / `pendingQuestionOf` /
`readTailRecords`（128 KB 尾部）/ `createMetaCache`（按 mtime 失效，上限 512 条）。
读不到就返回 `null` —— 不拿目录名伪装成标题。

### `scripts/tui-theme.mjs`（新增）

`BINARY`（彩色下统一 `•`，无色下切 `• ! ? × ◦`）、`binaryMark` / `binaryColor`。
**`blocked` 用蓝色不用红色**（「被挡住」不是「坏了」）。

### `scripts/oversight-tui.mjs`（改造）

新增导出：`viewOf`（字段矩阵的唯一入口 —— 拿不到的字段画不上屏）、`buildSections`、
`actionViewOf`、`askedCountOf`、`waitingCountOf`、`claimsTally`、`scanAgeText`、`defaultClaimsScan`。
`App.buildListFrame()` 现在只取数，渲染全交给 `composeListScreen`。

---

## 三、负向测试：11 / 11

`node scripts/verify-tui-negatives.mjs` —— 每处回退都真正改文件、跑测试、再还原。

```
✓ v1-verdict   判决行改回「先报会话总数」            → verdictParts：「N 件在等你」必须排第一
✓ v2-checklist 砍掉「问了没答」这一行                → checklistRows：恒 4 行，一行不砍
✓ v3-source    检查表来源列整列删掉                  → checklistRows：每行都写来源
✓ v4-health    体检失败也画成 ✓                      → 监视在跑与没在跑必须打不同标记
✓ v5-alert     不再生成「监视没跑」告警              → 告警不替换会话列表
✓ v6-stopped   已停段默认就展开                      → 裁决 R1：已停默认压成一行
✓ v7-restate   把 reason 拼回列表行                  → AC4 主屏不得出现 reason
✓ v8-disclose  可数披露换成裸截断                    → 超宽时必须说出丢了多少列
✓ v9-plain     纯文本路径退回「只印一句汇总」        → --plain 端到端
✓ v10-width    composeListScreen 不再裁剪超宽行      → body 里的超宽行也被裁剪
✓ v11-binary   未知状态兜底返回 running              → binaryOf：六态降到二值
✓ 11/11 处回退都让预期测试变红
```

其中 v7、v10、v11 最初**没有变红**（测试挡不住），已补测试夹具与断言后重新验证通过 ——
这三条是这次唯一靠负向验证才发现的测试空洞。

---

## 四、真实 `--plain` 输出（实际运行，未编辑）

命令：`node scripts/oversight-tui.mjs --plain --days 3`（本机，2026-11-10，exit 0）

```text
3 件在等你 · 10 个会话在跑 · 19 个已停
纯文本快照（交互界面需在终端运行） · 窗口 最近 3 天

 检查了什么                                         结论
 等你回应    WAITING/BLOCKED/FAILED              →  3 个
 问了没答    transcript 末条是问句               →  0 个
 声明对不上  完成声明无证据支持                  →  1 条  6 存疑 · d 看证据
 后台监视    jobs 1.1d / probe 1.1d 未运行       →  ✗  先修这个

需动作 (3)
 Hilltop Village优化                                 33.1d  c 复制回复
    它在等：要我现在就把用户实测单交给你，还是你先看这四份测试报告？
    建议回复（逐字）：把实测单发给我
 Hilltop Village                                      8.7d  Enter 看原文
    它在等：API unavailable — retry · API Error: 503 No available channel for model global:deepseek-v4.1-flash under group default (distributor) (request id: 202610051557008747741508268d9d6fVaOO9eq) (request id: 202610051556594967423008268d9d6E62LAjGZ). This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:15721).
 MC 自动化测试工具整合                                  0s  Enter 看原文

在跑 (10)
 web-style-atlas                              0s  加两条断言：搜索必须真的筛出结果（这能抓住 `P is not defined` 那类崩溃…
 Let's learn English!                         0s  结构正确了。向 §5.7 补上 agentO 那一段，然后做最终验证喵。
 shapez                                       0s  `x=7` 是带子，`x=8` 空。region `[7,-40,8,-40]` 应该能放 cutter（2 格正…
 批量 Outlook 邮箱的管理与保护                0s  从 5.8 秒降到 2.7 秒。剩余的 2.7 秒来自两处：密钥创建时的一次 icacls（…
 OmniSight                                    2s  两条核实结果，**一条对一条错**。 ## 核实 1：`claude -p` 现在成功了 ``` …
 PerfScope                                    4s  `isChunkForceLoaded` 只是一次 LongSet.contains，成本可以忽略不计喵。核…
 多智能体审计框架项目调研                    11s  全部通过（175 项 + 17 条 lint + 12 条自测）。研究 agent 仍在运行。 ## …
 dsh-fcl-android-launcher                     1m  已派出 2 个修复单，继续填窗口。 ## 本轮派出的 **`fix-222`（6 条）** —— …
 C盘空间占用与可清理项                        2m  数据基本齐全了。最后核对 Temp、NVIDIA 和 Chrome 的内部大项，确认具体可…
 Hilltop Village 多agent工作流               21m  ## 全部做完了喵 我自己跑的独立复核通过喵： ``` [WARNING] Tests run: 846…

已停 (19)  1.5h–1.7d前 · h 展开

汇总（六态，仅供核对，不驱动动作）：WAITING=1 BLOCKED=2 PRODUCING=9 EXPLORING=20
监视未在跑：jobs：已 26.3 小时 未运行（上限 1 分钟）；probe：已 26.4 小时 未运行（上限 15 分钟）
提示：j/k 移动 · Enter 详情 · c 复制草稿 · h 展开已停 · d 证据 · i 内部量 · r 刷新 · ? 帮助 · q 退出（交互模式需 TTY）
```

### 同一份真实数据的交互屏（76 列，30 行，无颜色）

```text
3 件在等你 · 10 个会话在跑 · 19 个已停                              8s前扫描
 ⚠ 后台监视未在运行 —— 「0 件在等你」这件事不可信
   先修：node scripts/install-watcher.mjs install

 检查了什么                                                             结论
 等你回应       WAITING/BLOCKED/FAILED          3 个
 问了没答       transcript 末条是问句           0 个
 声明对不上     完成声明无证据支持              1 条  6 存疑 · d 看证据
 后台监视       jobs 1.1d / probe 1.1d 未运行      ✗  先修这个

 需动作 (3)                                                 等了      怎么回
❯ Hilltop Village优化                                      33.1d c 复制回复
   要我现在就把用户实测单交给你，还是你先看这四份测试报告？
  Hilltop Village                                         8.7d Enter 看原文
   API unavailable — retry · API Error: 503 No available channel… (+316 列)
  MC 自动化测试工具整合                                     0s Enter 看原文

 在跑 (10)                                                   最后动静     近
  web-style-atlas           …/Web/style            0s 九个静态闸门 + 8 条浏…
  Let's learn English!      …/Server plugin/L…     0s 结构正确了。向 §5.7 …
  PerfScope                 …/Server plugin/P…     0s `isChunkForceLoaded` …
  shapez                    …/Project work/sh…     0s `obs-l8.json` 是旧的…
  OmniSight                 …/Projects/Overwa…     6s 两条核实结果，**一条…
  批量 Outlook 邮… (+14 列) …/Account/MailDesk     8s 需要定义 `existedBefo…
  dsh-fcl-android-launcher  …/Projects/dsh-fc…     9s 已派出 2 个修复单，继…
 多智能体审计框架项目调研   …/many-agents_mul…    25s 全部通过（175 项 + 17…
  C盘空间占用与可清理项     C盘清理路径           57s 数据基本齐全了。最后…
  Hilltop Village… (+14 列) …/target/surefire…    20m ## 全部做完了喵 我自…
 已停 (19)  1.5h–1.7d前 · h 展开 · 大部分是历史
1 条声明对不上 · 数据来自8s前的扫描 · 监视未在跑
```

实测宽度：**76 / 60 / 44 / 30 四档，整屏超宽行数均为 0**。
窄档按声明顺序撤块：60 列撤「近」列 → 44 列撤已停段与检查表来源列 → 30 列撤路径副行与「等了」。

---

## 五、验收自查

| 验收点 | 结果 | 证据 |
|---|---|---|
| 零 npm 依赖 | ✅ | 无 `package.json`；只 import `node:` 与仓内模块 |
| 布局函数纯函数可单测 | ✅ | `tui-layout.test.mjs` 61 条；`tui-meta.test.mjs` 22 条 |
| CJK 宽度用 `displayWidth` | ✅ | 全程单一真源，未新写宽度规则 |
| `--plain` 继续可用 | ✅ | 上文实际输出；`tui-redesign.test.mjs` 有端到端断言 |
| 现有键位不退化 | ✅ | `j/k` `Enter` `c` `r` `q` `?` 全保留，新增 `h` `d` `i` `g/G` |
| 测试 588 → 700，无红 | ✅ | 700 pass / 0 fail |
| 草图 A 每行 ≤ 78 | ✅ | `tui-layout.test.mjs` 逐行断言，最宽 72 |
| 负向 ≥ 3 项 | ✅ | 11 项，全部变红 |
| 硬门通过 | ✅ | `check-structure.mjs` 无违规 |
| 未改 verify-claims / asked / watch | ✅ | 只 import 它们（`flattenResults` / `lastAssistantText` / `healthCheck` 等） |
| 未碰 git | ✅ | 无 commit |

---

## 六、过程中发现并修掉的问题

1. **D1 复现**：`liveToRow` 的 `base.split(/[\/]/)` 只切 `/`，Windows 上项目名变成整条路径。
   改为切两个分隔符，并把原始 `cwd` 一并保留（列表页要 `…/尾两段`，详情页要完整路径）。
   已加回归测试 + 负向项。
2. **`fmtSpan(null)` 曾返回 `0s`** —— `Number(null) === 0`。没有 idleSec 的行会被画成
   「0 秒前」，这是撒谎。现在显式返回 `n/a`。
3. **检查表备注列被截成 `d …`** —— `d 看证据` 是那一行唯一可执行的提示。备注列从 14 列
   提到 20 列，来源列相应收窄。
4. **`app-router.test.mjs` 的夹具**：主屏改三段后，`live: []` 意味着「宿主说一条活的都没有」，
   PRODUCING 会落进已停段并被折叠。该文件测的是键位路由，不是分区，夹具补上 `live` 即可 ——
   这是**测试夹具过时**，不是行为退化，已在测试里写清理由。
5. **`main()` 的 `claimsScan` 可注入**：新增参数，默认 `defaultClaimsScan`（子进程，
   实测 7.2s，不进 8 秒轮询）。纯文本路径与扫描**并行**跑证据，所以快照里那一行是真数字，
   不是「正在算证据」。

---

## 七、我没做的（明确边界）

- **没在真实终端里跑交互模式**（本环境无 pty）。交互屏的截图是把真实 scan/verify-claims
  数据喂给 `App.buildListFrame()` 得到的纯文本，**不是手机拍屏**。真终端下的颜色观感、
  `❯` 字形的实际渲染未验证 —— 这需要验证 Agent 在有 TTY 的机器上补。
- **`i` / `d` 面板只做了渲染，没做滚动到底的实测**：证据面板的内容来自 `renderSessionBlock`，
  本轮只验证了「有内容 + 不超宽」，没验证「长证据能滚完」。
- **`after` 宽度 30 以下的 micro 档没有真实数据验证**：只跑了合成夹具。
- `projectLabel()`（从目录编码反推路径）**仍留在详情页的 deprecated 路径里**，
  主屏已不再用它（改用 transcript 的 `cwd`）。
