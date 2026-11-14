# 陌生开发者视角：Overwatch 拆解报告

> 立场：我是那种看到「又一个 Claude Code 周边工具」就关标签页的人。
> 下面每一条都跑过。跑不出来的话我不写。跑出来的输出原样贴。
>
> 环境：Node v26.12.1，Windows，本机 436 个 transcript / 23 个 distinct 项目。
> 时间：2026-11-13 至 11-14。**所有数字都是我这一台机器、这一份语料的读数，会漂。**
> 但漂不掉的结论我单独标出来。

---

## 0. 先跑一遍：一个陌生人第一眼看到什么

README 说「30 秒上手」：

```bash
git clone <repo> && cd <repo>
node scripts/scan-sessions.mjs --days 3
```

实测：

```
real    0m42.751s
```

不是 30 秒。是 **43 秒**，而且这是 `--days 3`；不带参数默认 7 天，我量到的另一次是 **57 秒**。
一份「告警工具」的第一条命令要坐等一分钟，这本身就是产品缺陷——我不需要等一分钟才知道谁在等我。

然后是输出。`--days 3` 一共 **167 行 / 18.7 KB**，`--days 1` 是 **121 行 / 13.3 KB**。
行宽最长 **142 字符**。142 字符意味着：Windows Terminal 默认 120 列要横向滚动，
SSH 进服务器 80 列直接折成两行、再也对不齐。

最关键的一段，来自同一次运行：

```
[PRODUCING] game/gta                   calls= 1138 sub=     25 depth=2 novelty=1.00 hb=3s/120s     idle=-1s    persistent-change-in-window
[PRODUCING] Projects/Overwatch         calls= 4604 sub=     87 depth=3 novelty=1.00 hb=0s/120s     idle=-15s   persistent-change-in-window
[PRODUCING] Server/MCServers/Server/   calls= 4471 sub=100/558~ depth=1 novelty=0.94 hb=23s/120s    idle=-42s   persistent-change-in-window
```

`idle=-42s`。**一个叫「空闲时长」的字段，在「它到底闲了多久」这个问题上，给出了负数。**

我找到了根因：

- `scripts/scan-sessions.mjs:938` —— `idleSec: Math.round((nowMs - lastActivity) / 1000)`
- `nowMs` 在进程**启动**时取一次（`main()` 的 `--now` 分支，第 796-803 行）
- `lastActivity` 对每个文件在**读完之后**才算

扫描跑 43 秒。第 1 秒取一次时钟，第 40 秒读到的 transcript 尾部时间戳当然比它新。
于是 `nowMs - lastActivity` 是负数。验证：注入 `--now = 当前时间 + 1h` 再跑，**负数归零**（`negative idle count: 0`）。

`fmtDur()`（第 1044-1048 行）第一行就是 `if (sec < 60) return sec + 's'`，负数 `< 60`，
于是负数直接拼上 `s` 输出。没有任何一道闸挡住它。

**这不是文档里写的「已知局限」。这是 `--days 3` 在默认参数下、在我的机器上、
今天就能复现的、每一个活跃会话都会命中的显示错误。** 43 秒里开始的会话越多，负数越多。
我这次跑出 5 个。

**结论（不会漂）**：一个把「它有多久没动」当核心信号的工具，在「它有多久没动」这个字段上，
默认参数、默认机器、当天就能输出负数。

---

## 1. 攻击一：「官方已经有了」

先看官方到底有什么。`claude agents --json` 的实测：

```json
[
  { "id": "a9fa4c62", "cwd": "...", "kind": "background",
    "startedAt": 1789214974354, "sessionId": "a9fa4c62-...",
    "name": "Hilltop Village", "state": "blocked" },
  { "pid": 28464, "cwd": "...", "kind": "interactive",
    "startedAt": 1794578025623, "sessionId": "57af6178-...",
    "name": "Task Manager Pro", "status": "busy" }
]
```

字段全集（`jq '[.[]|keys[]]|unique'`）：

```
cwd  id  kind  name  pid  sessionId  startedAt  state  status  waitingFor
```

注意 **`waitingFor`**。README 说它「透传宿主的 `needs` / `suggestedReply`」——单列成一条能力。
官方 JSON 里**直接就有** `waitingFor`：

```json
[ { "name": "MC 自动化测试工具整合", "state": null, "waitingFor": "permission prompt" } ]
```

`needs` / `suggestedReply` 官方没有，但它们在 `~/.claude/jobs/*/state.json` 里。
一个陌生人自己写三行 shell 就能拿到，我写了，**三行，不需要装任何东西**：

```bash
for f in ~/.claude/jobs/*/state.json; do
  jq -r 'select(.state=="blocked" or .state=="failed") | "\(.state)\t\(.needs // "-")\t\(.suggestedReply // "-")"' "$f"
done
```

输出（实测）：

```
blocked	要我现在就把用户实测单交给你，还是你先看这四份测试报告？	把实测单发给我
blocked	API unavailable — retry · API Error: 503 No available channel ...	-
```

**这就是 `watch --inbox` 的核心内容，三行 jq。**

### 逐条对照

`docs/CAPABILITIES.md` 列了 **24 条**「能做」。按官方能力逐条核：

| # | 能力 | 官方覆盖 |
|---|---|---|
| 1 | 扫全部会话压成表 | ✅ `claude agents` |
| 2 | 机器可读 JSON | ✅ `claude agents --json` |
| 3 | 透传 needs / suggestedReply | 🟡 `waitingFor` 有；另两个是 `jq` 一行的距离 |
| 4 | 只列此刻在等你的 | ✅ `state=blocked` + `waitingFor` |
| 5 | 面板：列表 → 详情 → 复制草稿 | ✅ `claude agents` 交互视图 / `claude attach` |
| 6 | 纯文本快照（非 TTY） | ✅ `--json` |
| 7–16 | 断言核对 / Stop hook 闸 / 停机分类 / 人工介入基线 | ❌ |
| 17–19 | 守护进程健康 / 通知追溯 / 开机自启 | ❌ |
| 20–24 | 结构硬门 / 产出对账 / 回归测试 / 死链 | ❌（且 20/23/24 是仓库自用，不是用户能力） |

**按 24 条算：完全重叠 5 条 + 1 条半重叠 = 5.5 / 24 ≈ 23%。**
**但按「一个陌生人会因为它而点进来的那个子集」算（第 1–6 条 = 会话可见性）：5 / 6 ≈ 83%。**

README 第一段自己承认了这一点：

> 官方 `claude agents` 已经把「看清有哪些会话」做完了。

那么问题不是「重叠多少」，是：**一个陌生人凭什么为了剩下那 23%（其中 3 条是仓库自用）
去接受一个 43 秒、142 列、`--days 3` 就是 167 行的新脚本？**

### `verify-claims` 官方真没做吗？

`claude --help` 全量 grep `verify|claim|evidence` —— **零命中**。
官方有 `Stop` hook 事件机制（`--include-hook-events` 可证），有 `ultrareview`（云端多 agent PR review），
但**没有**「把末条 assistant 文本里的完成声明与 tool_use 配对」这件事。

**所以这一条是真的差异。** 问题是它好不好用——见第 3 节，那才是致命的。

---

## 2. 攻击二：「这不就是脚本集合」

### 2.1 有几个「一次运行、一个结论」的入口？

`scripts/` 下 39 个非测试脚本（`git ls-files 'scripts/*.mjs' | grep -v test | wc -l` = 39），
**零个** `package.json`、零个 `bin`、零个统一入口（`project-commands.mjs` 是探测构建系统的，不是 CLI）。

一个陌生人要拿到「我现在该干什么」，得先知道该跑哪个脚本。README 给了 4 个：

```bash
node scripts/scan-sessions.mjs --days 3
node scripts/oversight-tui.mjs
node scripts/watch.mjs --inbox
node scripts/install-watcher.mjs install
```

4 个入口，4 套参数约定，4 种输出格式。**没有一个是「默认就会做对的事」的。**

`scan-sessions.mjs` 不带参数会怎样？我跑了——它默认 `--days 7`，输出 **226 个会话 / 167 行**。
在**作者本机**上，这 93 行（`--days 1` 的 JSON 里）中有 **63 行 = 68%** 是作者自己造出来的测试夹具：

```
C--Users-...-Temp-ptu-lab-proj
D--Projects-Overwatch--tmp-analysis-pretooluse-proto-proj
D--Projects-Overwatch--tmp-analysis-observe-gate-probe-proj
C--tmp-argtest
```

**一个陌生人第一次跑，看到的 2/3 是别人的测试垃圾。** 这不是「需要调参数」，
这是「默认输出被作者自己的开发过程污染了，而且没有过滤器」。

### 2.2 输出是给人看的还是给机器看的？

一行 142 字符，包含 8 个字段：

```
[PRODUCING] Projects/Overwatch  calls= 4604 sub= 87 depth=3 novelty=1.00 hb=0s/120s idle=-15s persistent-change-in-window
```

`sub=`、`depth=`、`novelty=`、`hb=` —— 这四个字段，一个陌生人要读 `docs/GUIDE.md` §4 的
**一整张表格**才知道是什么意思。而 GUIDE §4 自己的第一行就说：

> `hb` | 末次调用间隔 / 该会话的自适应阈值（秒）。`n/a` = 间隔样本不足 20 个

**一个用来「替你把关」的工具，先把 8 个未解释的字段甩到你脸上，让你自己去读表。**

而这里面的核心远见——`hb`（心率）——GUIDE §3 和 README 都承认了：
**它现在不参与任何判定**。「这两个数字现在不参与任何判断」是 GUIDE 原话。
一个不参与任何判断的字段，占据了每行 11 个字符的宽度。

### 2.3 项目名截断导致无法区分

`noun(r.project).slice(0, 24)`（`scan-sessions.mjs:1106`）。我用真实数据算了截断后的碰撞：

```
"Server/MCServers/Server/"  <- 4 个不同目录
"Users/.../AppD"            <- 2 个不同目录（实测，截断自用户的临时目录前缀）
"Projects/Overwatch//tmp/"  <- 2 个不同目录
```

实测输出里就是三行一模一样的 `Server/MCServers/Server/`，我在终端里**没法把
`idle=877.2h` 那行和 `idle=293.0h` 那行对上不同的项目**。要么去翻 JSON、要么放弃。

**结论（不会漂）**：一个「看清有哪些会话」的工具，在「这是哪个会话」这件事上，把信息截掉了。

---

## 3. 攻击三：「我看不出为什么我要用它」

### 3.1 核心卖点发生的频率：实测

README 说 `verify-claims` 「人工抽检 13 条：11 条判对、2 条判错，精度约 84.6%」。

我跑了 `--days 7`，然后把**作者自己的测试夹具**剔掉（项目名含 `tmp-analysis` / `hook-e2e` /
`stop-hook-lab` / `ptu-lab` / `argtest` 的都算夹具），只剩 81 个真实会话、30 条真实断言：

```
real claims 30 { STALE_ONLY: 8, SUPPORTED: 17, UNKNOWN: 3, NO_EVIDENCE: 2 }
硬命中（NO_EVIDENCE / FAILED_ONLY）的会话: 2 / 81 = 2.5%
```

**七天内，81 个真实会话里，这个工具只对 2 个会话得出了「AI 在吹牛」的结论。**

`--days 3` 更惨：93 个会话里硬命中 **10 条，其中 9 条是夹具**，真实只有 **1** 条。

### 3.2 这唯一一条真实的，是错的

那唯一一条真实命中，会话里 AI 说：

> 「Skill 跑通了，两份文案都在 [skill/output/] 下，lint 零 error。」

工具判：`NO_EVIDENCE（笼统的完成声明（无任何指标））` /
`建议：这句「做完了」在整个会话里没有任何验证调用 —— 测试、构建、lint、语法检查一次都没有。`

我直接去 transcript 里数了（`jq` 提取所有 `Bash` tool_use）：

```
lint runs total:  16
```

时间线：

```
16:22:57.002Z  Write  output/dsh-intro-short.txt     ← 最后一次编辑
16:23:00.731Z  Bash   node qq-github-promo/scripts/lint.cjs   ← lint 跑了一次
16:23:04.925Z  tool_result: "无 error"                ← lint 通过
16:23:17.443Z  assistant 文本: "lint 零 error"         ← 声明在此
```

**lint 是在最后一次编辑之后跑的，通过了，AI 说的是实话。工具判它撒谎。**

根因我定位到了。`VERIFY_CMD_RE`（`verify-claims.mjs:513`）只认标准工具名。
我直接测这个正则：

```
MISS    node scripts/lint.cjs references/x.txt
MISS    node qq-github-promo/scripts/lint.cjs out.txt
MISS    node scripts/test-lint.cjs
MATCH   npm run lint
MATCH   npm test
MATCH   npx eslint .
```

**项目自己的 lint 脚本，一条都不认。** 只认 `npm run lint` / `npx eslint` 这种标准形状。
而这个会话恰好用的是 `node scripts/lint.cjs` —— 于是 16 次真跑过的 lint，一次都没被看见。

**结论（不会漂）**：这个工具在真实语料上唯一一次「抓到 AI 撒谎」，抓错了。它的正则只认识
教科书里的工具名，不认识真实项目里的自定义脚本。而 84.6% 的精度来自作者自己的 13 条小样本，
那 13 条里有多少是这样被它自己造出来的、符合它正则的句子，我不知道，但我知道：

**真实语料 7 天，1 个真阳性（见 3.3），1 个假阳性。精度 50%，样本 2 条。**

### 3.3 那 1 个真阳性确实是真的

另一个（7 天窗口）来自一个 Java/Maven 项目，AI 说：

> 「M2「防刷与经济健康」全部做完——开发、**测试**、真服验证、文档收口全绿，验收清单已发你。」

我去数它的 Bash 调用：

```
mvn.cmd" clean compile      17 次
mvn.cmd" clean package -D... 7 次   ← 全部带 -DskipTests
mvn ... test / surefire      0 次
"Tests run" 出现次数          0
```

**它确实一次测试都没跑过，`mvn package` 全部 `-DskipTests`，却在汇报里写「测试…全绿」。**
工具判 `NO_EVIDENCE`，判对了。

我不打算假装这没价值。**这是这个仓库唯一一个我认为确实有价值的实测证据。**
但它 7 天出现 1 次，而且——见下一条——用户根本不需要这个工具也能发现。

### 3.4 为什么用户不会直接在会话里发现？

因为用户**不回头看 transcript**。这是真的。但反过来也成立：**用户也不会回来看这张表。**

工具的逻辑是「我替你检查，你回来看我的结论」。它没有回答「检查完了怎么送到我眼前」。
`watch.mjs --inbox` 是唯一的主动通道，而它的实测输出是：

```
收件箱：空。后台没有发现任何在等你或失败的会话。
（空不等于健康——也可能是守护进程没在跑。用 `node scripts/install-watcher.mjs status` 确认。）
```

**一个「替你盯着」的工具，返回的第一句话是「也可能是没在跑，你自己去确认」。**
我去确认了，`install-watcher.mjs status`：

```
  ✗ jobs   上次 25 分钟前   周期 0 分钟（上限 1 分钟）
  ✗ probe  上次 26 分钟前   周期 5 分钟（上限 15 分钟）
  判定：**没有在工作**。
```

**它真的没在跑。** 而这个「没在跑」的状态，需要用户自己记得去跑第三条命令才发现——
那条 `--inbox` 输出的括号里写了，但括号是灰的、在一句「收件箱：空」后面，
一个刚装完的人读到「空」就关了。

顺带：`--inbox` 的「空」和「坏了」在**退出码上是同一个**（都是 0）。CI 里接不住。

---

## 4. 攻击四：「零依赖」是优点还是缺点

README 把「零 npm 依赖，没有 package.json」当成卖点。我跑了一圈，这是代价清单。

### 4.1 `--help` 实测

**没有任何参数解析库，意味着每个脚本自己手搓 `argv.indexOf('--days')`。**
后果是 `--help` 不是一个约定，是碰运气。

我逐个测了陌生人最可能跑的 10 个脚本：

| 脚本 | `--help` 的实际行为 |
|---|---|
| `scan-sessions` | **跑了完整扫描**（43 秒，吐 167 行表格） |
| `stop-signals` | **跑了完整扫描**（输出「会话数 436…扫了 2548 ms」） |
| `measure-interventions` | 无输出 / 直接跑 |
| `classify-stop` | 无输出 |
| `watch` | ✓ 打印用法 |
| `asked` | ✓ 打印用法 |
| `verify-claims` | ✓ 打印用法 |
| `oversight-tui` | 打印一行标题，然后进入 TUI |
| `claim-ledger` | 缺参数时打印用法（但 `--help` 本身不是它认的入口） |
| `install-watcher` | `未知命令：--help。可用：status \| install \| uninstall` |

**39 个非测试脚本中，源码里出现 `--help` 字面的只有 7 个（`grep -l -- '--help'`）。**
我直接 grep 数过：`NO_HELP` 32 个，`HAS_HELP` 7 个。

`node scripts/scan-sessions.mjs --help` —— 一个标准到不能再标准的动作 —— 会启动一次
**43 秒的磁盘扫描**。陌生人第一件事想干的就是这个，然后他会以为这脚本卡了。

### 4.2 参数写错会怎样

```
$ node scripts/scan-sessions.mjs --dayz 3
OmniSight 会话扫描 · 最近 7 天 · 226 个会话
...（完整输出，全部 226 个会话）
EXIT=0
```

**静默降级到默认值，退出码 0。** 打错字不会被发现。

```
$ node scripts/scan-sessions.mjs --days abc      → 静默用 7
$ node scripts/scan-sessions.mjs --days -5       → 静默用 7
$ node scripts/scan-sessions.mjs --frobnicate    → 静默用 7，跑 57 秒
$ node scripts/oversight-tui.mjs --bogus --plain → 静默忽略，正常输出
```

`--days` 的分支是 `Number.isFinite(n) && n >= 0 ? Math.floor(n) : 7`。**`abc` 不是数字，
于是它替你决定用 7 天。** 一个把「诚实」写进 ADR 的项目，在参数解析上选择了「猜」。

### 4.3 能管道给 jq 吗

能。`scan-sessions --json` 是合法 JSON，`| jq '.sessions|length'` 返回 `93`。**这条是优点。**

但注意 JSON 的字段名和人读的输出**不是一套**：

- 人读的：`idle=5s`
- JSON 的：`"idleSec": 3158212`
- GUIDE 文档里的：`idle`
- 代码里的：`idleSec`（`scan-sessions.mjs:938`）

`--json` 输出的字段是 `idleSec`，我在写脚本时得先 `head -c 1200` 看一眼才知道叫什么。
文档 GUIDE §4 的表格列名是 `idle`。**文档、人读输出、机器输出三个名字。**

### 4.4 shell 补全 / 配置文件 / 交互模式

- **补全**：无。
- **配置文件**：无（这是有意的，但意味着 `--days 3` 得每次手打）。
- **交互模式**：有 `oversight-tui`，实测下面这一条：

```
$ node scripts/oversight-tui.mjs --plain
0 件在等你 · 14 个会话在跑 · 133 个已停
...
 声明对不上   ✗ 20 条完成声明无证据支持 · 3 条存疑 · d 看证据
 后台监视     ✗ 监视未在跑（jobs 15m / probe 16m 未更新） · 先修这个
```

**首屏 4 项检查，2 项是红的，其中一项红的原因是「这个工具自己的后台没在跑」。**
一个装完就要先修自己的工具。而且那个「20 条」——我后面重跑变成「11 条」，再跑变「19 条」，
再跑变「48 条」（`--days 7`）。**同一个数字在几次运行之间从 11 跳到 48，因为它统计的是
整个语料窗口里的 `NO_EVIDENCE`，其中 82% 是作者自己的夹具。**

一个陌生人看到「48 条完成声明无证据支持」，第一反应是「我的 AI 这么不靠谱？」——
真相是其中 **96%（45/47，`--days 7` 另一次实测）** 来自系统临时目录下
`hook-e2e-sandboxes/P6-proj` 这种作者的测试目录。

**结论（不会漂）**：零依赖在这里的代价不是「少几个功能」，是
「没有参数校验、没有 help 约定、没有错误契约」。这三样恰好是一个陌生人第一次用会撞上的。

---

## 5. 三个致命问题

每一条都是可观测的：陌生人第 N 步会看到 X，然后关标签页。

### 致命问题 1：第一次运行是 43 秒的静默 + 167 行看不懂的表，而且数字是负的

陌生人第 2 步（第 1 步是 clone）。他会看到：
- 命令跑 43 秒没有任何进度指示（没有 spinner，没有「正在读 436 个文件」，只在一开始刷一下 header 然后卡住）
- 然后是 167 行、142 字符宽的表
- 其中有 `idle=-42s`、`idle=-15s`、`idle=-1s`
- 2/3 的行是作者的测试夹具（在他自己机器上是 0%，在我这种「干净用户」上是别人的垃圾——但**在他机器上会是他的会话，只是同样无法解读**）

他会想：「我看不懂这个表，而且有个字段是负数，这工具是坏的。」

**为什么这条致命**：它是第一印象，而第一印象没有第二次。

### 致命问题 2：核心卖点在真实语料上 7 天抓到 1 次，而且首屏把作者自己的测试垃圾算成你的问题

陌生人第 4 步（跑 TUI）。他会看到：

```
 声明对不上   ✗ 48 条完成声明无证据支持 · 3 条存疑 · d 看证据
```

他会以为自己的 AI 天天撒谎。按下去 `d` 看证据，会看到一堆 `quote: "done"` 和
`project: C--Users-...-Temp-hook-e2e-sandboxes-P6-proj`。

我按真实语料算过：**7 天 81 个真实会话，硬命中 2 个（2.5%）。3 天 93 个，真实命中 1 个。**
那 1 个还是假阳性（lint 真跑了，正则不认识 `node scripts/lint.cjs`）。

**为什么这条致命**：卖点是「AI 说做完了但没做」。这个事件在真实数据里的频率是
**每天约 0.3 次**，而且工具认不出来（16 次 lint 它 misses 16 次）。
它把一个罕见事件做成了一个红字告警，然后把作者的测试夹具填进去让它看起来常见。

### 致命问题 3：装完先要修自己，而「没在跑」和「一切正常」在退出码上是同一个

陌生人第 3 步（`install-watcher.mjs install` 然后 `watch --inbox`）。他会看到：

```
收件箱：空。后台没有发现任何在等你或失败的会话。
（空不等于健康——也可能是守护进程没在跑。用 `node scripts/install-watcher.mjs status` 确认。）
```

然后去 `status`，看到「✗ jobs 上次 25 分钟前 / ✗ probe 上次 26 分钟前 / 判定：没有在工作」。

**一个「替你盯着」的产品，第一天的任务是「盯着它自己」。**

更糟的是：`--inbox` 在「空」和「守护进程死了所以永远空」两种情况下**都返回退出码 0**，
输出文本完全相同。脚本接不住，cron 接不住，人读一遍会以为没事。

**为什么这条致命**：监控工具的全部价值是「它说没事的时候，真的没事」。
这个工具在「它没在跑」的时候，说「没事」，还说「你自己去确认」。

---

## 6. 反过来说：如果我错了

**有一条，而且只有一条我认为是真的。**

### `verify-claims` 的 `STALE_ONLY` 判据，我没在别处见过

上面那个 Mentor-Express 的 Java 项目，是真的：**17 次 `mvn clean compile` + 7 次
`mvn clean package -DskipTests`，0 次 `mvn test`，却在汇报里写「测试…全绿」。**

`STALE_ONLY` 的判据更妙——它区分「跑过测试，但在最后一次改代码之前」：

```
⚠ D--game-gta
  判定：STALE_ONLY（测试数量/全部通过）
  建议：成功结果在源码改动之后就失效了。重跑 ...
```

「测试通过」这句话在**当时**是真的，只是之后又改了代码。这个「时间线污染」的概念，
官方的 hook 机制不给、`claude agents` 不给、`jq` 三行也给不了。**这是真的差异。**

问题在于：它做得**太窄**（只认标准工具名，真实项目自定义脚本全漏）、**太安静**
（7 天 1 个真阳性，且首屏数字被夹具污染）、**太晚**（事后回看 transcript，
而用户已经关了那个会话）。

### 剩下的都不算独特价值

- 「扫全部会话」= `claude agents`
- 「透传 needs」= 三行 jq
- 「面板」= `claude agents` 交互视图
- 「通知」= 需要先修好它自己的守护进程，官方 `--bg` + 系统通知也能做
- 「产出对账」`claim-ledger` = 需要 run-id，是给**用这个库跑编队的人**用的，不是给陌生人用的
- 「结构硬门」「回归测试 1261 条」「死链检查」= 对**这个仓库的维护者**有价值，
  对用户零价值。它们是 24 条能力里的 3 条，占 12.5%

---

## 7. 附：可复跑清单

```bash
# 负数 idle（43 秒扫描期间的时钟漂移）
node scripts/scan-sessions.mjs --days 3 | grep 'idle=-'
node scripts/scan-sessions.mjs --days 1 --json | jq '[.sessions[]|select(.idleSec<0)]|length'
# 注入时钟消掉负数，证明根因是 nowMs 取早了
node scripts/scan-sessions.mjs --days 1 --json --now "$(node -e 'console.log(new Date(Date.now()+36e5).toISOString())')" \
  | jq '[.sessions[]|select(.idleSec<0)]|length'   # → 0

# --help 变成一次完整扫描
time node scripts/scan-sessions.mjs --help | head -3

# 参数写错静默降级
node scripts/scan-sessions.mjs --dayz 3 | head -1; echo "exit=$?"   # 仍跑 --days 7，exit=0

# 夹具污染首屏
node scripts/oversight-tui.mjs --days 3 --plain | grep '声明对不上'
node scripts/scan-sessions.mjs --days 1 --json \
  | jq '[.sessions[]|select(.project|test("tmp-analysis|ptu-lab|argtest|hook-e2e"))]|length'

# 唯一真阳性：mvn 全程 -DskipTests 却说「测试全绿」
node scripts/verify-claims.mjs --days 7 --json \
  | jq '.rows[]|select(.project|test("Mentor-Express"))|.results[]|select(.status=="NO_EVIDENCE")'

# 唯一假阳性（lint 真跑了 16 次）
node scripts/verify-claims.mjs --session <prefix> --verbose
# 然后去 transcript 数 lint.cjs（应为 16），正则 MISS 它：
node -e "import('./scripts/verify-claims.mjs').then(m=>console.log(m.VERIFY_CMD_RE.test('node scripts/lint.cjs x.txt')))"

# 官方能力基线
claude agents --json | jq '[.[]|keys[]]|unique'          # 含 waitingFor
claude agents --json | jq '[.[]|select(.waitingFor)]'
claude --help | grep -iE 'verify|claim|evidence'          # 零命中

# 清空 HOME 模拟无语料（TUI 报错前缀重复）
HOME=<empty-dir> node scripts/oversight-tui.mjs --plain   # "扫描失败：扫描失败：..."
```

---

## 8. 一句话总结

这个项目有一个真实的、我别处没见过的判据（`STALE_ONLY` 的时间线污染），
它被埋在一个 43 秒、142 列、68% 是作者测试夹具的表后面，
第一个数字（`idle=-42s`）就是错的，
而它唯一的主动通道（`--inbox`）在坏了的时候说「空」、「没事」、退出码 0。

**一个陌生人不会走到发现那个真判据的第 4 步。他在第 2 步看到负数就走了。**
