# ADR-0003：这个项目是应用，不是插件，也不是配置库

- 状态：**Accepted**（用户 2026-11-14 拍板，原话：「我们这个项目是应用不是插件」）
- 日期：2026-11-14
- 取代：**ADR-0001 的「纯 Claude Code 配置库」定位**（部分取代，逐条见 §5）
- 相关：[ADR-0001](0001-config-only.md)、[ADR-0002](0002-honest-degradation.md)（**不受影响，继续有效**）

---

## 0. 一句话

**它是应用**：用户启动它，它自己拥有进程、生命周期、退出码与状态目录，靠读宿主留下的会话、按自己的判据判定、
并以「起子进程驱动本机已认证的 `claude`」和「由宿主回调它的 hook」两种方式介入。

**它不是**：不是 Claude Code 插件（不装进宿主、不由宿主加载）、不是配置库（产品不是 `.claude/` 里那几个
markdown）、不是样板间（不要求你把仓库 clone 到某处再在里面开 Claude Code）。

---

## 1. 背景：ADR-0001 的取舍为什么在当时是对的，现在不成立

ADR-0001（2026-10-29）把「clone 即用」排在「可安装」之前，因此拒绝了 plugin 形态。它的四条反悔信号是：

1. 宿主提供对运行中会话的稳定注入接口；
2. 需要同时监控 10 个以上会话；
3. 四态误判率无法靠规则收敛；
4. 出现第二个宿主。

**这四条里没有一条覆盖「产品目标从『作者自用』变成『给别人用』」。** 所以 ADR-0001 不是被它自己的信号
触发的，是**被前提变更推翻的**——把这件事写成「反悔信号触发」会伪造一个不存在的因果链。ADR-0001 的推理
在它的前提下仍然成立；变的不是证据，是目标。

具体哪个前提变了，逐条对照：

| ADR-0001 的理由 | 当时成立的条件 | 现在 |
|---|---|---|
| 「clone 即用，没有安装步骤」 | 使用者是作者，路径固定在本机 | **失效**：陌生人的第一个问题不是「能不能用」，是「我装对了没有」（`../research/2026-11-14-stranger-first-run-audit.md`） |
| 「策略与执行同源，改 markdown 就生效」 | 规则由人读、由主线程遵守 | **失效**：给别人用之后，规则必须能被程序执行，不能只被遵守 |
| 「与宿主同生命周期」 | 监督者不需要比被监督者活得久 | **已被代码推翻**：`scripts/watch.mjs` 是常驻守护循环，`scripts/install-watcher.mjs install` 装开机自启。ADR-0001 原文「不包含常驻进程、不包含守护循环」与现状不符已有一段时间 |

**这一节的方法论要求**：不要把它读成「ADR-0001 错了」。它没错，它过期了。

---

## 2. 决定前必须回答的技术问题：应用能不能自己发起推理

这是本 ADR 唯一不能靠论证解决、只能靠实测解决的问题。**2026-11-02 / 2026-11-12 的记录说「`claude -p` 在本机
不可用」**（`../research/2026-11-14-observe-mode-reality-check.md` §2.1、`../FACTS.md` §1.5）。
本轮重测，结论需要**收窄而不是推翻**——见 §2.1。

### 2.1 四条通道的实测（2026-11-14，本机，CLI 2.1.289）

| 通道 | 结论 | 证据 | 等级 |
|---|---|---|---|
| `claude -p` | **可用**，但**需要显式的三段认证环境** | `claude -p "What is 3+4?"` → 助手消息 `"7"`；`"Create probe.txt containing HELLO"` → 真落盘 | **T3**（文件真的被写） |
| `claude mcp serve` | **可用**，23 个工具，能拿到真实推理 | `tools/list` → 23；`tools/call Agent` → `{"status":"completed","content":[{"text":"A2_PROBE_OK"}],"resolvedModel":"claude-opus-5-5","totalTokens":15258}` | **T3** |
| `acpx`（ACP） | **可用**，能跑完一整轮 | `acpx claude "What is 8+9?" --format json` → `17` + `[done] end_turn`，连跑 2 次同形 | **T3** |
| `claude agents --json` | **可用**，16 个会话，字段 `id/cwd/kind/startedAt/sessionId/name/state,pid/status` | 直接输出 | **T2** |
| hooks（`PreToolUse`） | **可用**，且能真拦住 | `permissionDecision:"deny"` → 文件未创建、`permission_denials` 有条目、reason 回到模型 | **T3 + T4** |

### 2.2 那个「认证闸」到底是什么——T4 拆到最小条件

用 `~/.claude/settings.json` 的 `ANTHROPIC_BASE_URL` 与本机宿主网关令牌构造四组环境，每组只差一个变量：

| 环境 | 结果 | 退出码 |
|---|---|---|
| `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `CLAUDE_CODE_HOST_AUTH_ENV_VAR` | **`"11"`，6 秒** | 0 |
| 去掉 `ANTHROPIC_BASE_URL` | `Failed to authenticate…` | 1 |
| 去掉 `CLAUDE_CODE_HOST_AUTH_ENV_VAR` | **挂起 75 秒，零输出** | 被 SIGTERM |
| 去掉 `ANTHROPIC_AUTH_TOKEN` | `Not logged in · Please run /login` | 1 |
| 完全继承当前 shell 环境（即 `claude` 由另一个 Claude 会话拉起） | `Not logged in · Please run /login` | 1 |

**这是 T4：四个变量缺哪一个，失败形态都不同，且「零输出挂起」只出现在缺 `CLAUDE_CODE_HOST_AUTH_ENV_VAR` 时。**
所以 2026-11-12 记录的「剥掉变量后 180/400 秒超时、零输出」不是另一个 bug，是**这一格**——它当时被记成了
「`claude -p` 不可用」。

**但必须立刻收窄，否则会得出错误的产品结论：**

- 本机**没有独立的 Anthropic 登录**（`~/.claude.json` 里 `oauthAccount` 不存在），且 `api.anthropic.com`
  从本机直连 403。所以本机能拿到推理的唯一路径是**宿主网关令牌**。
- 那三段的来源是 `<宿主数据目录>/host-creds-*.json`，**`expiresAt` 约 1 小时滚动、文件名带随机 uuid、
  过期的旧文件不会被删**（本轮同时看到两个文件，一活一死）。
- 读这个文件是**读宿主为自己子进程准备的私有凭据**，不是公开接口：无文档、无兼容承诺、随版本变。
- 本机那条网关（`127.0.0.1:15721`）的监听者是一个第三方本地供应商切换器（`../FACTS.md` §1.5），
  不是 Anthropic 官方端点。

**所以正确的表述是两句话，不是一句：**

1. **对普通用户**：`claude -p` 的可用性等于「他的 `claude` CLI 已登录」。这是**正常情况**，不需要任何
   环境技巧——应用直接 spawn 即可。（此格**未验证**：本机没有干净登录态，无法实测。）
2. **对本机**：只能靠借宿主凭据。「可用」是**这台机器的一个状态**，不是产品可以依赖的契约。

**产品含义**：应用可以有推理腿，但**不得把「读 host-creds」写进产品路径**。它应当 spawn 用户的 `claude`，
把认证失败当作一个**可报告的前提缺失**（`doctor` 已经有 `gate` / `sources` 这类项，这里是同类），
而不是当作「想办法绕过」。

### 2.3 如果应用不能自己发起推理，它的「应用性」在哪

即便推理腿完全不可用，它仍然是应用，因为它的三个主功能都不需要自己调模型：

| 功能 | 需要推理吗 | 机制 |
|---|---|---|
| 观测（会话状态、谁在等你） | 不需要 | 读 transcript 与宿主状态文件 |
| 判定（断言 vs 证据） | 不需要 | 确定性判据（`verify-claims.mjs`） |
| 介入（拦住「没读就写」的写） | 不需要 | **宿主回调它的 hook**，不是它去推 |
| 通知 | 不需要 | 本机 Toast / 日志 |
| 生成接力草稿、跨会话总结 | **需要** | spawn `claude -p` |

即：**「应用性」的第一条腿是它有自己的进程、退出码、状态目录与判据；第二条腿是它能在需要时驱动 `claude`。**
第一条腿无条件成立，第二条有条件。把第二条当成前提去设计，是这份 ADR 要防的主要错误。

**介入这条腿的证据最硬**：应用自己的 hook 返回 `permissionDecision:"deny"`，目标写真的没落盘，
模型在下一轮里**读到了 reason 并据此改变行为**（实测文本含 `OW_APP_GATE: read the project first`，
随后模型说「让我先看项目」）。这是 T3 + T4，不是「设计上可以」。

---

## 3. 决定

### 3.1 一句话定义

> **一个由用户启动的本地可执行程序：它拥有自己的进程与状态目录，读宿主的会话记录做判定，用退出码和
> 结构化输出对外交付；需要推理时 spawn 本机已认证的 `claude`，需要介入时由宿主的 hook 回调它。**

### 3.2 一句话非定义

> **它不是插件**（不是 `.claude-plugin/plugin.json`、不装进宿主、不靠宿主加载才能存在）；
> **不是配置库**（产品不是 `.claude/agents/*.md` 与 `.claude/skills/*`——那些是它的**运行时载荷**，不是产品本身）；
> **不是样板间**（不要求用户把仓库 clone 到某个位置、再在那个目录里开 Claude Code 才能用）。

一个容易混淆的边界要写清：**应用会用 plugin 格式打包自己的 agents/skills/hooks，这不等于它是插件。**
区别在「谁加载谁」——是**应用在起 `claude` 时用 `--plugin-dir` 把自己的载荷挂进去**，不是用户把应用装进宿主。

### 3.3 「应用」意味着什么：五个必须有明确答案的问题

这一节**不留三选一**。

#### 入口在哪

`node scripts/overwatch.mjs`（无参数 = `doctor`）。这是**唯一入口**；其余 `scan` / `verify` / `tui` / `watch`
是它路由出去的原生命令。

现状：**有入口，没有名字**。仓库里没有 `package.json`、没有 `bin/`、没有可执行名，用户必须敲
`node scripts/overwatch.mjs`。这是缺口，不是取舍。

#### 装在哪

**装在它自己的目录**（现在是一个 clone；将来可以是 `npm pack` 的产物）。**不装进用户的项目。**
运行时数据在独立状态目录（`install-watcher.mjs` 的 `stateDirFor()` 已经这么做了），
**不在被监控项目里**——否则「应用」会往每个项目里拉屎。

#### `.claude/` 那一层怎么办——**单一答案：变成应用自带的运行时载荷，由应用按需挂载**

不是「应用自带的模板」（那意味着要复制到用户项目里），也不是「不再需要」，而是：

- `.claude/agents/*.md`（12 个 `oversight-*`）与 `.claude/skills/oversight/` **在仓库里保留**——
  贡献者在这个仓库里开发时，宿主照旧自动加载它们，本仓自用体验不变。
- **产品运行时不再依赖它们**。应用起 `claude` 时用 `--plugin-dir <应用载荷目录>` 把自己的 agents / skills /
  **hooks** 挂进去，从任意 cwd 生效。

**实测依据（T3 + T4）**：把一份最小 plugin（1 agent + 1 skill + 1 hook）放在临时目录，
`cwd` 设为一个无关目录，`--plugin-dir` 指过去：

```
agents = ["a2-probe:probe-agent", "claude", "Explore", "general-purpose", …]
skills = ["a2-probe:probe-skill"]
plugins = [{"name":"a2-probe","source":"a2-probe@inline","version":"0.1.0"}]
```

且该 plugin 里的 agent **真的能被派发**（返回 `PROBE_AGENT_LOADED`），plugin 里的 hook **真的会触发**。

**反向对照**：把仓库根直接当 `--plugin-dir` 传进去 → `plugins = []`、`agents` 里没有 `oversight-*`。
因为`.claude/agents` 是**项目布局**，不是 plugin 布局。**这证明了两者不是一回事**，也证明了迁移是必须的。

#### 怎么升级

**现状：没有。** 没有版本号、没有 git tag、没有更新通道；唯一机制是 `git pull`。
`overwatch.mjs doctor` 报 7 项前提，但**不报自己的版本**——因为没有一个版本号可报。

这是「应用」最贵的一条缺口，写在 §4 的缺口表里。

#### 配置：用户能改什么

**现状：散在两处，没有单一真源。**
- 9 个 `OVERWATCH_*` 环境变量（`OVERWATCH_STATE_DIR` / `OVERWATCH_STOP_VERIFY` / `OVERWATCH_REPO` …）；
- `.claude/settings.local.json`（本机私有，gitignored），hook 注册要**手改 JSON 并换成本机绝对路径**。

改一个「阈值」需要知道去哪个文件、改哪个键，这对「给别人用」是硬伤。

#### 依赖宿主，但不由宿主加载

**是。** 依赖的形态是「spawn」与「hook 回调」，两种都不要求宿主知道应用的存在：

- spawn：`claude -p` / `claude mcp serve` / `acpx claude` 都是**应用主动拉起子进程**（三条已实测，§2.1）；
- hook：应用把自己的 hook 写进 `--settings` 或 plugin，**宿主在 `PreToolUse` 时回调它**。

**实测陷阱（必须记下来，否则「应用」会静默失去全部 hook）**：
当应用用**精简环境** spawn `claude` 时，hook **一条都不会触发**。逐变量二分定位到 **`PATHEXT`**——
hook 命令里的裸 `node` 在缺 `PATHEXT` 时解析不到。带 `PATHEXT` 触发，不带不触发，各跑 2 次复现。
一个「应用」如果把环境清干净再起子进程（这恰恰是最佳实践），会**静默**丢掉全部介入能力，
而 `claude` 的退出码仍然是 0。

#### 退出码语义

**部分有。** `overwatch.mjs` 已经有 6 值契约（0 前提读到 / 1 自身 bug / 2 transcript 根不存在 /
3 根在但读不出 / 4 子命令未实现 / 5 用法错误），且文档与测试对账。其余脚本各自为政
（`scan` 0/1/2、`watch --health` 0/1、`verify-claims` 0/1）。**统一还没做完。**

---

## 4. 形状检查表：「应用」的每个特征 × 现在有没有 × 缺什么

| 特征 | 现在有没有 | 证据 | 缺什么 |
|---|---|---|---|
| **一个统一的入口命令** | **有（半个）** | `scripts/overwatch.mjs`：无参数 = `doctor`，7 项，实测 exit 0，预算 1000ms；`--help` 立即 exit 0 | 没有可执行名（无 `package.json` / `bin/`），用户得敲 `node scripts/overwatch.mjs` |
| **安装 / 初始化路径** | **没有** | `README.md` 第 14 行明写「不安装、不登录、不配置」；`install-watcher.mjs` 装的是**监视器自启**，不是应用本身 | 一条 `install`：装到哪、装什么、失败怎么回滚 |
| **自检（doctor）** | **有** | `overwatch.mjs` 无参数 = doctor：node / transcripts / sources / claude / gate / watcher / platform 七项，逐项带真实耗时；空/坏/正常三态分明（exit 2 / 3 / 0） | 不报**自己的版本**（没有版本号可报）；不报**推理腿是否可用**（§2.2 的认证状态） |
| **版本与升级** | **没有** | 仓库里没有 `package.json`（`git ls-files` 计数为 0），无 `VERSION`，`git tag` 为空 | 版本号、面向用户的变更摘要、升级动作本身 |
| **配置（用户可改什么）** | **部分** | 9 个 `OVERWATCH_*` 环境变量；hook 注册要手改 `.claude/settings.local.json` 并填本机绝对路径 | 单一配置文件 + 校验（改错了要报错，不能静默回落） |
| **依赖宿主但不由宿主加载** | **有** | `claude -p` → `"7"`；`mcp serve` → 23 工具 + 真实推理；`acpx` → `17`+`end_turn`；hook 回调 → deny 生效 | 无（这一条已经成立，但见 §3.3 的 `PATHEXT` 陷阱） |
| **退出码语义（可被管道 / CI 用）** | **部分** | `overwatch.mjs` 0–5 六值且文档/测试对账；`scan` 0/1/2；`watch --health` 0/1；`verify-claims` 0/1 | 全部脚本对齐到同一张表 |

**最短的三条缺口**（按「挡住用户的程度」排）：

1. **没有版本与升级**——用户无法知道自己装的是什么、也升不了级。一条都没有。
2. **没有安装路径**——`README` 说「不安装」，这对「给自己用」是优点，对「给别人用」是缺口。
3. **配置没有单一真源**——散在 9 个环境变量与一份手改的私有 JSON 里，改错静默。

---

## 5. 代价（诚实写，不修饰）

### 5.1 ADR-0001 的其他结论，逐条判断还成不成立

| ADR-0001 的条目 | 现在还成立吗 | 为什么 |
|---|---|---|
| 「不包含常驻进程、不包含数据库、不包含守护循环」 | **不成立，且早已不成立** | `watch.mjs` 是常驻 tick 循环；`install-watcher.mjs install` 装开机自启（Startup 下 `.lnk` 实测存在）；实测有活着的 `watch.mjs` 进程。**这条不是本次变更造成的，是记录落后于代码**，一并作废 |
| 「策略与执行同源，改 markdown 就生效」 | **不成立** | 给别人用之后，判据必须能被程序执行。markdown 仍是**规格**，不再是**执行体** |
| 「没有强制力，主线程可以自称 PRODUCING 绕过」 | **部分反转** | `PreToolUse` 的 `deny` 是**真强制**：实测文件未落盘、`permission_denials` 有记录、reason 回到模型。应用自己的 hook 可以带强制力；**但前提是 hook 真的被加载**（见 `PATHEXT` 陷阱） |
| 「心跳只能事后重建」 | **部分成立** | 前台交互会话仍是事后重建；守护进程把它压到 1 分钟级 |
| 「接力只能 `manual`」 | **成立，且理由变了** | 不是「做不到」，是产品选择：投递会把「来自另一个 Claude」的框暴露给目标会话。ADR-0001 §代价·3 的 2026-10-30 修正仍然有效 |
| 「token 只能估算」 | **成立** | 后台作业有真值（`state.json` 的 `tokens`），前台交互会话仍只能 `est:` |
| 「与宿主同生命周期」 | **不成立** | 守护进程比单个会话活得久，这是它存在的理由 |

**ADR-0002（诚实降级）不受影响，继续有效。** 应用形态**增加**了需要降级的地方（版本未知、推理腿不可用、
配置不全），不减少任何一条。`overwatch.mjs doctor` 的「预算内没跑完就说没跑完」正是 ADR-0002 的直接应用。

### 5.2 失去了什么

1. **「打开文件夹就能用」没了。** 用户现在需要先装、再跑。这个门槛是真实的，不是想象中的。
2. **本仓库的自用体验会分叉。** 贡献者在这个仓库里开 Claude Code，`.claude/agents` 自动加载；用户跑的却是
   打包后的 plugin 载荷。**两份形态一旦漂移，漂移的那份没人测**——本仓已经吃过这个亏
   （同一个「已读」问题出现三份判据，两份漂移）。所以 `.claude/` 到 plugin 的迁移必须是**同源生成**，
   而不是手抄一份。
3. **判据从文档变成代码。** 改一条阈值从「改 markdown」变成「改代码 + 测 + 发布」。ADR-0001 担心的正是这个，
   它是对的，只是这个代价现在必须付。
4. **多了一个必须维护的对外契约。** 版本号、退出码、配置文件格式、plugin 布局——每一样都要有人守。

### 5.3 本轮实测发现的、会直接咬到「应用」的两个缺陷

1. **`claude -p --output-format json` 的 `result` 字段为空，而 `subtype` 是 `success`、`is_error` 是 `false`。**
   三次复现。真实输出只在 `stream-json` 的 `assistant` 消息里。**任何按 `.result` 解析的应用都会拿到空串
   并以为成功。** 这是「应用读错了会静默交白卷」的典型。
2. **`PATHEXT` 缺失时 hook 静默不触发**（§3.3）。退出码仍是 0。

这两条都不是设计问题，是**集成契约问题**，写在这里是因为它们决定了「应用」能不能可靠工作。

---

## 6. 反悔信号

出现以下任一，应重新评估本 ADR：

1. **`claude -p` / `--plugin-dir` / hooks 的契约在某个版本被移除或改语义**，且这种变化**无法在 `doctor` 里检出**
   （能检出就不算反悔，算正常的版本适配）。
2. **用户实际需要的是「嵌进编辑器」而不是「独立进程」**——如果多数人想要的是 IDE 里的一个面板，那 plugin 形态
   会重新成为正确答案，本 ADR 的前提「应用」就错了。
3. **`.claude/` → plugin 的迁移让本仓自己无法开发**（贡献者打不开仓库就干活），说明两份形态的维护成本
   超过了应用带来的收益。
4. **应用必须读宿主私有凭据才能工作**（即 §2.2 的第二句话成了唯一情况）——那说明它不是一个能发布的产品，
   而是一个本机脚本，应当退回非产品形态并如实说明。

---

## 7. 未验证项（不得当作结论引用）

| 事项 | 状态 |
|---|---|
| 干净登录态（有 `oauthAccount` 或真实 `ANTHROPIC_API_KEY`）下 `claude -p` 是否需要任何环境变量 | **未验证**。本机无此条件 |
| `claude -p --output-format json` 的 `result` 为空，是**本机网关**的行为还是 CLI 的行为 | **未验证**。只有本机一种环境 |
| macOS / Linux 上 `--plugin-dir` 与 hook 的行为 | **未验证**。只在 Windows 实测 |
| 打包后的 plugin 载荷与仓内 `.claude/` 的**同源生成**方案 | **已实现**（2026-11-14）：`scripts/build-payload.mjs` 从 `.claude/` **生成** plugin 布局载荷到 gitignored 的 `dist/payload/`，`--check` 以七条判据验同源、`--print-dir` 供入口脚本消费。方案选「生成，不维护」；实测生成物 `claude plugin list` 为 `Status: ✔ loaded`（12 agents + 1 skill），`plugin validate --strict` 通过。37 条测试，其中第 4 组 10 条是负向（漂移/伪造必须红）。**载荷不含 hooks**：实测 hook 脚本的 import 闭包漏一跳时 `claude` 退出码仍是 0（静默失去介入能力），故 hooks 归应用用 `--settings` 挂。设计、四个实测问题（布局必填项 / 同名 agent / hooks 声明 / 多 `--plugin-dir`）与未验证项见 [`../design/2026-11-14-payload-generation.md`](../design/2026-11-14-payload-generation.md) |
