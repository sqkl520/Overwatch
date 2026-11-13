# 2026-11-13 · 提交前总核对（69 个未提交文件 / 5000+ 行）

> 产出形态 `exploration`（核对报告）。**未修改任何源码，未碰 git。**
> 核对手段：真跑硬门与全量测试、真跑两组负向验证、真造数据复现界面、逐文件静态扫描。
> 所有引用的行号取自核对当时的实际文件内容。

---

## 零、先声明一件事：仓库在核对期间仍在变

核对开始时 `git status` 是 **68 个未提交文件、826 条测试**；核对过程中又有 Agent 提交了新工作
（`scripts/analyze-hook-samples.mjs` 与其测试、`docs/research/2026-11-13-hook-sample-logging.md`，
mtime 02:59–03:02），测试数变成 **860**，四份文档（README / CLAUDE / GUIDE / validate.yml）同步改成 860。

这不是抱怨，是结论的一部分：**「全绿」是一个会移动的目标**。本报告的所有数字都标注了取数时刻，
复跑时请以命令输出为准，不要以本文为准。

---

## 一、能不能提交

**不能。有 1 条阻塞级问题（必然被用户看见的误报界面），另有 1 条会破坏「负向验证」纪律真实性的问题。**

| 项 | 实测结果 |
|---|---|
| `node scripts/check-structure.mjs` | **exit 0，0 违规 0 提示** |
| `node --test scripts/*.test.mjs` | **860 / 860 全绿，0 fail 0 skip**（核对开始时 826/826，同样全绿） |
| `node scripts/gen-width-table.mjs --check` | exit 0，表与 Unicode 数据一致 |
| `node scripts/verify-tui-negatives.mjs` | **23/23 回退都让预期测试变红** |
| `node scripts/verify-bugfix-negatives.mjs` | **16/18**，2 处失效（见 B1） |
| 临时文件混入 | 无。`.tmp-analysis/` 被 `.gitignore:16` 的 `.tmp-*` 正确忽略 |

**测试与硬门都是真跑过的，不是读代码推测。两者都绿。** 但绿不等于能交 —— 见下。

---

## 二、阻塞级（🔴 必须修，但本报告不代修）

### R1 `scripts/oversight-tui.mjs:1620` | 安静机器上首屏谎报「监控坏了」 | 造数据实跑复现

```js
} else if (!flat.length) {
  body = emptyLines(this, cols);
}
```

`flat` 来自 `flatList()`（`oversight-tui.mjs:1705`），而 `flatList` **默认不包含「已停」段**
（`stoppedExpanded` 默认 `false`，见 `:1198`）。于是「没有任何会话在等你、也没有任何会话在跑、
但有 N 个已停会话」这个**完全正常的安静状态**，`flat.length === 0` 成立，走进 `emptyLines()`，
而 `emptyLines()`（`:780`）对 `transcriptsSeen > 0` 的分支写的是：

> `⚠ 一个会话都没识别出来 —— 检查过 347 个 transcript、10 个 job，全部落空`

实测（用真实 `scan-sessions --json --days 3` 的输出，滤掉需动作态、`live: []`）：

```
0 件在等你 · 0 个会话在跑 · 130 个已停
 ✓ 4 项检查都清白 · 监视在跑
⚠ 一个会话都没识别出来 —— 检查过 347 个 transcript、10 个 job，全部落空
  215 个在窗口外（最近 3 天）
  检查了 347 个 transcript · 10 个 job · 最近 3 天 · 数据来自 0s前
```

同一帧里同时说「130 个已停」和「一个会话都没识别出来」。这正是本仓库自己列为头号诚实性缺陷的
形态 —— `README.md`「关于『四态』」与 `docs/design/2026-11-05-tui-redesign-plan.md` §2.6
都写明「『没查』与『全清白』不能同形」「空状态不得使用断言词」。**这是回归，不是存量**：
HEAD 的 `buildListFrame` 用 `sortedSessions()`（全量），会话数不为 0 就不会走空状态分支。

为什么测试没抓到：860 条测试里**没有一条**构造「有已停、无需动作、无在跑」的夹具。
所有 `makeApp`/`emptyLines` 用例要么 `sessions: []`，要么带 action 行。

**触发概率**：任何一次「没有会话在等你、也没有会话在跑」的时刻都会命中（早晨、任务间歇、
监视刚启动）。这不是边角。

### R2 `scripts/verify-bugfix-negatives.mjs:142`（b4-outwin） | 负向验证 2/18 失效 | 真跑步 `--only b4-outwin`

```
✗ b4-outwin      Bug4  不再提示「窗口外还有 N 个」（应让窗口外提示测试变红）
      → 问题：测试仍然全绿——这条测试挡不住这个回退
```

完整跑 `verify-bugfix-negatives.mjs` 得 **16/18**；`docs/CHANGELOG.md:601` 写的是
「**18/18 处回退都让预期测试变红**」。两处失效：

- **b4-outwin**：变异体指向 `statusLine()`（`oversight-tui.mjs:795`）。重构后主屏最后一行由
  `footerLineParts()`（`:1677`）渲染，「窗口外还有 N 个」那句话搬到了 `:1689`。`statusLine`
  已成死代码，**变异改的是一个没人调用的函数**，所以测试自然不红。
- **b3-index**：变异体的 `find` 片段里写的是 `sessionKey(s)`，现存代码已改名 `this.keyOf(s)`
  （`:1266`），`applyMutation` 直接抛「找不到要回退的片段」（`verify-bugfix-negatives.mjs:207`）。

严重级别判定的理由：**功能本身没坏**（「窗口外还有 N 个」在 `footerLineParts` 里照常工作，
实测可见），坏的是**「修好了必须有负向证据」这条纪律的真实性**。仓库把这条写进
`CLAUDE.md` 与 `docs/CHANGELOG.md` 顶部的「三条不给糖吃的写法约定」，一条失效的变异体
等于把「已验证」变成了空话。**提交前必须把这两条变异体重新对准活代码**（或删掉并说明），
否则下一轮验收会拿 16/18 当成 18/18 引用。

---

## 三、建议修（🟡）

| # | 位置 | 问题 | 怎么发现的 |
|---|---|---|---|
| Y1 | `oversight-tui.mjs:34-43` | **9 个 import 进来从未使用**：`paint`、`ACTION_MAX_AGE_SEC`、`ACTION_STATES`、`ageSecOf`、`layoutStages`、`runningRowOf`、`metaFromRecords`、`readTailRecords`、`summarizeClaims`。重构后渲染走了 `tui-layout`，这些遗留绑定没清 | 静态扫描 + 逐名 grep 计数（每个都只有 import 那 1 次出现） |
| Y2 | `oversight-tui.mjs:540`、`:555`、`:795` | **三处死函数**：`listHeaderLine` / `columnHeaderLine`（HEAD 里各有 2–3 处调用，`buildListFrame` 重写后零调用）、`statusLine`（同上）。合计约 90 行，全是「旧列表头 + 旧状态行」的残骸 | 逐函数比对 HEAD 与现工作树的调用点 |
| Y3 | `oversight-tui.mjs:669` | `waitingCountOf` 是 **export 的纯函数，但仓库内零调用、零测试**。`askedCountOf` 有测试（`tui-redesign.test.mjs:420`），它的姊妹函数没有 | 导出面扫描 + 测试文件 grep |
| Y4 | `check-structure.mjs:347-351` | **5 条探针是空转**：`stripLongStrings` / `stateCounts` / `columnHeaderLine` / `usage` / `glyphOf` 登记在 `PROBE_ARGS` 里，但这 5 个名字**在 `scripts/` 下根本没有 export**（`stripLongStrings` 在 `scan-sessions.mjs:70` 是普通函数；其余在 `oversight-tui.mjs` 也是普通函数）。`checkImportable` 用 `Object.entries(m)` 只遍历 export，命中不到 → 探针永远不执行，门却显示「通过」 | 写脚本 import 全部模块，把 `PROBE_ARGS` 的键与实际导出集合做差集 |
| Y5 | `check-structure.mjs:632`、`:740` | **12 个 `REGISTERED` 名字不存在于任何模块**，其中 `CORRECTION_MAX_LEN` 最可疑：`measure-interventions.mjs` 里只有 `MAX_CLASSIFY_LEN`（`:79`），没有 `CORRECTION_MAX_LEN` —— 像是改名时只改了实现、没改登记表。其余 11 个是 Y4 那批非导出函数的登记残留 | 同上，差集方向反过来跑 |
| Y6 | `scripts/measure-interventions.mjs` + `measure-interventions.test.mjs`（34 条）| **零条 CHANGELOG 条目**。`grep measure-interventions docs/CHANGELOG.md` → 0 命中；其配套报告 `docs/research/2026-11-11-intervention-baseline.md` 也未在 CHANGELOG 出现。违反 `CLAUDE.md`「任何改动后…记进 CHANGELOG」与本文件顶部的硬规则 | 新文件 × CHANGELOG 全量交叉比对 |
| Y7 | `docs/GUIDE.md:402` | 写「**18 个测试文件**，860 项全绿」，实际 `ls scripts/*.test.mjs` 是 **19 个**（`analyze-hook-samples.test.mjs` 新增后未同步）。注意：硬门只对账「条数」（`checkTestCount`，`check-structure.mjs:267`），**不对账文件数**，所以这道门抓不到 | 文件计数 |
| Y8 | 6 份 `docs/research/2026-11-1*.md` | **无任何入站链接的孤儿文档**：`2026-11-11-{ambiguity-detection, blind-spots, build-own-framework-viability, framework-architecture-options, intervention-baseline, question-methodology}.md`。全仓 markdown 里没有任何一份引用它们，CHANGELOG 也没提。按「读者找不到 = 不存在」的标准，这 6 份等于没写 | 遍历全部 md，按文件名反查引用 |

---

## 四、可以不管（🟢）

| # | 位置 | 说明 |
|---|---|---|
| G1 | `classify-stop.mjs:60` 与 `stop-signals.mjs:416` | 两个模块都 export 了 `KINDS` 且值不同。**HEAD 就是这么写的**，是「两个不同概念撞名」（停止分类族 vs 停止信号族），不是覆盖。用 `import { KINDS as X }` 可区分，未造成实际影响 |
| G2 | `asked.mjs` / `verify-claims.mjs` 各有 `lastAssistantText` | 同名不同形：前者返回 `{text, timestamp}`，后者返回 `string`。**HEAD 已存在**，两处口径不同但各自内部自洽 |
| G3 | `readSlice` / `readTailRecords` 各两份 | 同上，HEAD 已存在。`verify-claims` 版本多返回 `size` 字段，是超集 |
| G4 | `tui-theme.mjs` 的 `isWideCp` / 宽度实现 | 只有一份实现，从 `width-table.mjs` 查表。`displayWidth` / `padDisplay` / `truncateDisplay` 共用 `measure()`，没有分叉。**未发现两套实现并存** |
| G5 | `oversight-tui.test.mjs:369` | 测试夹具里有 `'D:Projects' + \t + 'demo'`。是**故意构造的制表符路径**（测对齐），不是本机绝对路径泄漏 |
| G6 | `scan-sessions.mjs` / `oversight-tui.mjs` 各有 `fmtDur` | 两份格式化口径不同（scan 版不处理 `n/a` 与负值）。都是内部函数，不跨模块调用 |

---

## 五、逐项回答任务里的七个问题

1. **测试真的全绿吗** —— 是。核对开始 826/826，核对中因并发新增变 860/860，两次数都是 `fail 0 skip 0`。**未找到红测**，所以「哪条红、谁改的」不适用。
2. **硬门真的过了吗** —— 是，exit 0，0 提示。两次运行（826 时、860 时）都通过。
3. **有没有半成品** —— 有，但不是半成品代码，是**重构残骸**：3 个死函数 + 9 个死 import（Y1/Y2/Y3）、12 条死登记（Y5）。新增代码里 `TODO` / `FIXME` / `XXX` **零命中**（新增行扫描），注释掉的代码块 **0 处**，`debugger` **0 处**，生产代码里的 `console.log` 全部是 CLI 的正常输出（`scan-sessions` / `verify-claims` / `gen-width-table` 的人类可读模式），**无调试残留**。硬编码测试数据 **0 处**（唯一命中的是 G5 的故意夹具）。
4. **有没有互相覆盖** —— 热点文件里**同一个函数被定义两次：0 处**。`KINDS` / `MUTATIONS` 同名不同模块的情况见 G1；`MUTATIONS` 是 `verify-bugfix-negatives` 与 `verify-tui-negatives` 各自的变异体表，撞名无影响。常量重复定义且值不同：未发现（`ACTION_STATES` 只在 `tui-layout.mjs:275` 定义一次，`oversight-tui` 是 import）。
5. **新导出是否都登记了 / 有没有登记了但实现是空壳的** —— 登记侧：`checkUnregisteredExports` 通过，无未登记导出。反向**有 12 条登记了但名字不存在**（Y5），其中 `CORRECTION_MAX_LEN` 是明显的改名遗留。另有 5 条探针登记在案但对应函数未 export，探针永远空转（Y4）。这两类硬门都抓不到，因为门只做「有导出但没登记」这一个方向。
6. **文档与代码是否一致** —— 测试条数四处（README / CLAUDE / GUIDE / validate.yml）**全部为 860，且与源码 `test(` 计数 860 完全一致**，硬门的 `checkTestCount` 也在把关。CHANGELOG 顶部条目覆盖了 11-13 的 Stop hook、TUI 红测、一致性审计等改动，`docs/design/README.md` 索引覆盖了全部 5 份新设计文档（硬门的 `checkDesignIndex` 在把关）。**不一致项**：GUIDE 的文件数（Y7，18 vs 19）、`measure-interventions` 无 CHANGELOG 条目（Y6）、6 份孤儿 research（Y8）。
7. **有没有把临时文件混进来** —— 没有。52 个未跟踪文件全部是 `.md`(36) / `.mjs`(18) / `.txt`(2，Unicode 原始数据，`gen-width-table.mjs` 明确要求入库) / `.json`(1，`templates/stop-verify-hook.settings.json`，是模板不是产物)。`.tmp-analysis/` 被 `.gitignore` 的 `.tmp-*` 命中（`git check-ignore` 确认）。无 `mo.json`、无 `*.log`、无实验产物。`scripts/data/*.txt` 是**应当提交**的（宽度表数据源，`--check` 依赖它）。

---

## 六、提交前的最小动作清单

按优先级，改完重跑硬门 + 全量测试 + 两组负向验证：

1. **修 R1**：`buildListFrame` 的空状态判据不能用 `flat.length`。应当用「三段全空」（`sections.action.length + sections.running.length + sections.stopped.length === 0`）才进 `emptyLines`；「只有已停」时画已停段标题（或提示 `h 展开`），**绝不进「没识别出来」分支**。并补一条夹具：`sessions` 里只有非 action 态、`live: []`，断言输出**不含**「没识别出来」。
2. **修 R2**：把 `b4-outwin` 的 `find` 指到 `footerLineParts`（`oversight-tui.mjs:1689`）；把 `b3-index` 的 `sessionKey(s)` 改成 `this.keyOf(s)`。改完 `verify-bugfix-negatives.mjs` 必须回到 18/18。
3. **清 Y1/Y2/Y3**：删死 import 与三处死函数。注意 `tui-bugfixes.test.mjs:480` 断言源码含「状态全部未识别」——那句在 `printPlain`（`:1988`）里也有一份，删 `statusLine` 不会让这条测试变红，但要复跑确认。
4. **修 Y4/Y5**：`PROBE_ARGS` 里删掉不能 export 的键（或把它们改成 export）；`REGISTERED` 里补 `MAX_CLASSIFY_LEN` 的改名对应项，删掉不存在的 12 个。
5. **补 Y6/Y7/Y8**：`measure-interventions` 补 CHANGELOG 条目；GUIDE 的 18 改 19；6 份孤儿文档至少在 CHANGELOG 或 `docs/design/README.md` 里挂一次引用。

---

## 七、结论

**这些改动没有互相打架，但它们留下了重构残骸，并且引入了一个用户必然看见的误报界面。**

- 测试与硬门是**真绿**的，且测试数在四处文档间是一致的 —— 这一点比多数仓库做得好。
- 但绿是「测过的都过」，不等于「该测的都在」。R1 是个 860 条测试全覆盖不到的常见状态，
  而它呈现出来的正是这个仓库最不能接受的那种错误：把「安静」说成「坏了」。
- R2 更隐蔽：它不影响功能，但让「18/18 负向验证」这个被反复引用的数字失去依据。
  一条变异体指向死代码，比没有这条变异体更糟 —— 它给了虚假的安全感。

**先修 R1 和 R2，再谈提交。** 其余 🟡 可以在同一轮或下一轮清掉。
