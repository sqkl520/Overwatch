# 给你的上手说明：Overwatch 是什么，以及怎么自己验证

- 写给：第一次听说这个项目的人
- 读完要多久：15 分钟（跳过证据段 5 分钟）
- **本文每一条声称后面都跟一条你能自己跑的命令。** 没有命令支撑的话，本文不写。

> 本文与 [README](../README.md) 的区别：README 讲**它是什么**，本文讲**你怎么确认它真的是**。
> 每一段都有「自己验一遍」，输出是 2026-11-15 本机的真实结果，行数会随你的语料变化。

---

## 0. 一句话

它做一件事：**当 AI 说「做完了」，去 transcript 里找支持这句话的工具调用；找不到，就把这句话标出来。**

其余能力（扫会话、看状态、通知你）都是围绕这件事的观测面。
它**不能**自动接力、不能替你决策、不往运行中的会话里写东西。

---

## 1. 三十秒跑起来

```bash
git clone https://github.com/sqkl520/UntilDone.git
cd UntilDone
node scripts/overwatch.mjs
```

`overwatch.mjs` 是唯一入口。不加参数跑自检，本机实测输出（你的数字会不同）：

```
overwatch doctor · 查 8 项前提 · 预算 1000ms（只查前提，不扫语料）

[   0ms] node        v26.12.1 · 工具下限 18.20.4 满足 · 测试下限 20.16.0 满足
[ 163ms] transcripts <home>/.claude/projects · 152 个项目 · 874 份 .jsonl · 最新一份 0 秒前
[   3ms] sources     jobs 11 个 state.json · sessions 15 个 .json
[   1ms] claude/     agents 12 个 · skills 1 个
[  18ms] gate        mode=observe · brake=halt · marker=absent
[ 251ms] watcher     启动器 在 · health 说 没有在工作 · jobs 上次 28.4前
[   1ms] platform    win32 · 桌面通知可用（Toast）

合计 576ms（本进程 502ms + 启动 74ms）/ 预算 1000ms —— 前提齐了，可以跑 scan
```

**三件值得注意的事**（都能自己验）：

1. **它只报读到的事实，不出红绿灯。** 没有 ✓ 也没有 ✗ —— 一个 ✓ 会让你以为"没问题"，
   而"读到了 874 份"才是事实。判定留给你。
2. **`watcher` 那行说「没有在工作」。** 这不是 bug，是我这台机器的守护进程确实停了 28 小时。
   一个会骗你说"一切正常"的自检比没有自检更坏。
3. **它有个 1000ms 的硬预算。** 超了会降级并**明说降级**（`415 份 .jsonl（下限）` /
   `71 个（未完）项目`），而不是偷偷跑久一点。

**自己验一遍**：`node scripts/overwatch.mjs; echo "exit=$?"` —— 根不存在是 2、根在但读不出是 3、
根在且为空是 0。三种情况输出和退出码都不同。

---

## 2. 核心能力：它凭什么值得用

### 2.1 「做完了」这句话，可以变成可核对的断言

```bash
node scripts/verify-claims.mjs --days 3
```

本机真实输出（两条节选）：

```
⚠ <项目> · ba900260 · 37.87MB · subagents=47
  AI 说：「与远端同步，CI 绿喵。」
  证据：CI 查询调用 12 次（成功 8 次）；最近一次成功在 21:03:55；之后 23:10:55 又改了源码
  判定：STALE_ONLY（CI / PR 检查通过）
  建议：成功结果在源码改动之后就失效了。重跑 gh pr checks，补上最后一次编辑之后的证据

⚠ <项目> · a80c452d · 49.5MB · subagents=225
  AI 说：「三件事都做完了。」
  证据：验证调用 2 次（成功 2 次）；最近一次成功和最后一次源码编辑都落在 22:47:26（同一秒）
  判定：STALE_ONLY（笼统的完成声明）
  建议：成功结果在源码改动之后就失效了。重跑你实际用的「验证」命令
```

**第二条最能说明它怎么工作**：「最后一次成功验证和最后一次源码编辑落在同一秒」——
这不是猜测，是从 transcript 的时间戳里读出来的。编辑在验证之后，验证就失效了。

### 2.2 它不是"一律怀疑"

这是我用它的理由。看一次全量的汇总：

```
合计 240 条可核对断言：23 SUPPORTED / 8 STALE_ONLY / 47 NO_EVIDENCE / 3 UNKNOWN / 159 UNCHECKABLE
覆盖 676 个 transcript，其中 226 个含可核对断言；读盘 0.88 GB
```

**159 条是 `UNCHECKABLE` —— 它自己承认判不了。** 一个把"不知道"单列成一档的工具，
比一个把所有东西都判成通过或失败的工具可信。

**自己验一遍**：`node scripts/verify-claims.mjs --days 7` 最后一行就是这张汇总。
看 `UNCHECKABLE` 的占比——那个数字越大，说明它越诚实（也说明它能力有限）。

### 2.3 四档判定，每档都有明确的"为什么"

| 判定 | 意思 |
|---|---|
| `SUPPORTED` | 找到支持这句话的工具调用，且在那之后没有改动 |
| `STALE_ONLY` | 曾经有过证据，但之后源码又改了 —— **证据过期了** |
| `FAILED_ONLY` | 只找到失败的调用 |
| `NO_EVIDENCE` | 这句话在整个会话里没有任何验证类调用 |
| `UNCHECKABLE` | 这一族本机没有确定性证据源，**判不了** |

`STALE_ONLY` 这一档是这个项目最独特的地方：大多数工具只区分"有没有跑过"，
而它区分"跑过、但之后又改了什么"。

---

## 3. 在你自己项目里用它

这是最实用的一部分，也是我一开始没想到的。

```bash
cd ~/your-project
node /path/to/Overwatch/scripts/overwatch.mjs launch --cwd . --dry-run
```

它会把本仓库的 12 个角色定义和两条闸**挂到你自己的项目上**，但**不改你的仓库一个字节**：

```
要执行的命令行（逐字，可直接复制粘贴；本次没有执行任何东西）：
  claude --plugin-dir '<overwatch>/dist/roster' --settings '<...>/settings-336225b3.json' \
         --append-system-prompt '【提问协议 · 由 Overwatch 追加】...'
```

**先跑 `--dry-run` 看它要做什么，再跑不带参数的真启动。** 这是刻意设计的：
一条完整、可直接复制粘贴的命令，你可以先读懂它再执行。

想只验"载荷挂对了没有"（不需要登录、不需要推理）：

```bash
node scripts/overwatch.mjs launch --verify
# 载荷挂对了：宿主列出 3 个角色，与 git 跟踪的 3 个逐个对上（不需要推理与认证）
```

**注意那句"与 git 跟踪的 3 个逐个对上"** —— 期望清单来自 `git ls-files`，不是来自磁盘。
所以你可以删掉一个 agent 文件试试，它会失败并点名缺哪个。

**自己验一遍**：`mv .claude/agents/oversight-acceptor.md /tmp/` 然后跑 `--verify`，
应该 exit 7 并说「宿主报 2 个，期望 3 个」。改回来再跑一次。

---

## 4. 配置是真的生效的（这一条以前不成立）

配置文件 `overwatch.config.json`：

```json
{
  "ask":  { "mode": "always", "maxQuestions": 5, "requireReadFirst": true, "minReads": 3 },
  "agent": { "roster": ["oversight-planner", "oversight-executor", "oversight-acceptor"] }
}
```

**两个配置项现在都真的有执行侧**，而且这一点以前是假的：

| 配置 | 怎么生效 | 以前 |
|---|---|---|
| `ask.mode` | 拼成 `--append-system-prompt` 追加进系统提示，模型开局就读到 | 只做事后审计，**不改任何行为** |
| `agent.roster` | 每次启动现场生成只含启用角色的 `dist/roster/`，宿主只加载那几个 | 只算"谁没启用"写进台账，**照旧挂 12 个** |

`roster` 生效的证据（宿主自己报的）：

```
$ claude --plugin-dir <overwatch>/dist/roster plugin details overwatch-roster
  Agents (3)  oversight-acceptor, oversight-executor, oversight-planner
```

而 `.claude/` 里是 12 个。**自己验一遍**：跑 `launch --dry-run`，
看 `--plugin-dir` 指向 `dist/roster` 还是 `.claude`。

**一种设计取舍值得你知道**：`dist/roster/` 每次启动**先清空再重建**。
它不维护第二份真源——源永远是 `.claude/agents/*.md`。这是刻意的：
这个项目已经为"两份形态必然漂移"吃过亏。

---

## 5. 它不能做什么（这一节比前面都重要）

### 5.1 不能自动接力

它不往运行中的会话里写东西。宿主没有提供这样一个接口，而且我们实测过几条可能的路径
（IPC 管道、UIA 自动化、CDP 调试端口），**没一条能稳定工作**。
它可以给你一份草稿，让你自己粘 —— 仅此而已。

### 5.2 分不清"真的没事"和"我不知道"

一部分能分清，一部分不能：

| 场景 | 它怎么说 |
|---|---|
| 收件箱空 + 守护进程在跑 | 确实没有要处理的（exit 0） |
| 收件箱空 + 守护进程停了 | **"这个空不可信"**（exit 3），并告诉你去看真实状态 |
| 断言无验证调用 | `NO_EVIDENCE` |
| 这一族本机没有证据源 | `UNCHECKABLE`（**不是**通过，也不是失败） |

但**它不知道你有没有真的读懂那句话**。`SUPPORTED` 只意味着"有支持它的工具调用"，
不意味着"这个改动是对的"。

### 5.3 `launch` 需要凭据

观测类能力全部不需要登录。只有 `launch`（真的起会话）要——它得让宿主发起推理。
没登录时它会明确说、exit 6，**不假装跑过**。

### 5.4 只在部分平台验证过

Windows 上做了大量实测。macOS / Linux 的 `--plugin-dir` 与 hook 行为**未验证**——
这台机器是 Windows，我没法真跑。文档里凡标「未验证」的地方就是字面意思。

---

## 6. 怎么判断该不该信它

它自己给出的判据，我整理成三条：

**第一，看它有没有把"不知道"单列成一档。**
把所有东西都判成通过或失败的工具有毒。这个工具在 240 条断言里给了 159 条 `UNCHECKABLE`。

**第二，看它有没有"降级并明说"。**
`doctor` 预算不够时输出 `415 份 .jsonl（下限）`，而不是偷偷跑久一点或者假装数全了。

**第三，看它失败时的行为。**
一个诚实的工具在失败时会**非零退出**并且说清原因。你可以故意造一个失败试试：
把 `.claude/agents/` 挪走一个文件，`launch --verify` 应该 exit 7 并点名。

---

## 7. 下一步读什么

| 你想知道 | 读哪个 |
|---|---|
| 每条能力对应的命令 | [`CAPABILITIES.md`](CAPABILITIES.md) —— 硬门会核那上面的命令 |
| 什么时候该跑什么、看到 X 做什么 | [`GUIDE.md`](GUIDE.md) |
| 状态怎么判、阈值多少 | [`spec/state-model.md`](spec/state-model.md) |
| 哪些声称是实测的、哪些还没验 | [`FACTS.md`](FACTS.md) —— 每条带证据等级 |
| 为什么是这个设计 | [`adr/`](adr/) |

---

## 附录：本文所有真实输出的采集时间

- 采集日期：2026-11-15
- 本机语料：152 个项目 / 874 份 transcript
- 采集方式：直接跑命令，输出原样粘贴（路径已替换成 `<home>` / `<overwatch>`）

**如果你跑出来的数字差很多，那大概率是语料规模不同，不是它坏了。**
先跑 `node scripts/overwatch.mjs` 看你自己的规模。
