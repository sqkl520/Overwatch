# Claude Code 的「状态说明」区块逆向：我们那块「检查了什么」学歪了没有

- 日期：2026-11-11
- 作者：检索 Agent FR3
- 产出形态：exploration（逆向分析）
- 目标：Claude Code CLI 2.1.308，Windows x64 单文件可执行，297,376,928 字节
  （`<LOCALAPPDATA>/Claude-3p/claude-code/2.1.308/<hash>/claude.exe`，本机绝对路径已脱敏；
  SHA-256 见 `docs/research/2026-11-05-claude-tui-reverse.md`）
- 前置阅读：`docs/research/2026-11-05-claude-tui-reverse.md`

## 方法与手段（如实声明）

**只做静态分析，未执行目标。** 手段与 TR2 那轮相同：Node 以 `latin1` 一次性读入整个
exe，用 `indexOf` / 正则定位，按字节偏移切片打印上下文。脚本留在
`.tmp-analysis/fr3/*.mjs`（`lib.mjs` + `s1`…`s67`）。**没有反汇编，没有运行**。

文中每个结论都附字节偏移，换版本即失效。

---

## 一、结论先行

**1. Claude Code 有「状态说明」，但它不是一张表。它有四种形态，且都不带表头。**

| 形态 | 长什么样 | 什么时候出现 |
|---|---|---|
| **键值行**（`/status`） | `Version: 2.1.308` / `Model: Opus 4.6` / `cwd: D:\…` | 用户主动敲 `/status`，**整块只在对话框里**，主屏不显示 |
| **分节键值**（`buildStatusSections`） | `Session` / `Environment` / `Internal` 三节，每节是键值行；**空节整节不渲染** | 同上，是 `/status` 的数据源 |
| **整句断言**（诊断检查项） | `Connected to the Anthropic API (api.anthropic.com)` / `Not signed in to claude.ai` | `claude doctor`（终端）、`/doctor`（会话内）、Remote Control 面板 |
| **两列文本**（`/stats`） | `Favorite model: …` + `Total tokens: …` 左右两对，`padEnd(18)` 硬对齐 | `/stats` |

**没有任何一处出现「检查了什么 / What was checked」这类元表头。**
`/status` 用的列定义是 `[{bold:!0},{width:"fill"}]`（@288513450）——两个**匿名列**，
第一列加粗，没有 `header` 字段。

**2. 它把「检查项 → 结果」写成一句自陈述句，而不是「键 | 值」两列。**

最硬的证据是 Remote Control 的检查表（@252379662 起）：

```js
z=[{label:n?"Connected to the Anthropic API (api.anthropic.com)"
                 :"Not connected to the Anthropic API (api.anthropic.com)", ok:n},
   {label:r?"Not disabled by org policy (disableRemoteControl)"
                 :"Disabled by org policy (disableRemoteControl)", ok:r},
   {label:i?"Signed in to claude.ai":"Not signed in to claude.ai", ok:i},
   {label:_?"claude.ai subscription active":"claude.ai subscription auth not active", ok:_},
   …
   {label:g==="allowed"?"Org policy allows Remote Control (allow_remote_control)"
        :g==="unavailable"?"Org policy could not be verified (allow_remote_control)"
        :…"Org policy does not allow Remote Control (allow_remote_control)",
    ok:g==="allowed", detail:V?Z:void 0}, …]
```

要点是**每条检查自己带两个版本的句子**：通过版和失败版。没有「检查项名」这一层，
也就没有需要表头的两列结构。这一整组 `label` 字符串里**一个「Check/检查」动词都没有**——
`Connected`、`Signed in`、`Disabled`、`allows` 全是状态断言。

**3. `claude doctor` 是纯 `Key: value` 行，没有表头，且只列失败的项。**

`Ihi()`（@127958…，`cli_doctor` 命令）：

```js
l=["Claude Code doctor","",
   `Running: ${t.installationType} (${t.version})`,
   …`Commit: ${GIT_SHA.slice(0,12)}`,
   "Platform: win32-x64",
   …`Package manager: ${…}`,
   `Path: ${…}`, …`Invoked: ${…}`,
   `Config install method: ${…}`,
   `Search: ${t.ripgrepStatus.working?"OK":"Not working"} (…)`,
   `Auto-updates: ${…}`, `Auto-update channel: ${…}`, `Last update attempt: ${…}`]
```

- 第一行是标题 `Claude Code doctor`，**这是唯一的「表头」，而且它说的是工具名，不是列名**。
- 之后每行 `名字: 值`，**靠 `:` 分隔，不画对齐空格**（值直接跟冒号后一个空格）。
- 检查项只在**失败**时被单独列出：
  `for(let m of o.checks.filter((w)=>!w.ok)) l.push(u(`- ${m.label}${m.detail?` (${m.detail})`:""}`))`（@272951409）。
- 全部通过时只说一句：`No installation issues found.`（@272951791），**不逐项列举**。
  注意这句话是插在「Organization policy」行之后的**空行 + 一句**，不是一张全绿的表。

**4. 会话内的 `/doctor`（`/checkup` 别名）根本不是渲染器，是一段交给模型的 prompt。**

`Vo()` @264584700 注册 `name:"doctor", aliases:["checkup"]`，description 是
`"Health-check your setup and fix issues: …"`，`terminalOriented:!0`。
它的 `getPromptForCommand` 返回的是一整篇 markdown 指令（@264545552 起，`## Check 0` … `## Check 10`），
里面明确规定了报告的形态：

```
## Report format

1. **Plain-language summary first, and keep it SHORT** — 2-3 sentences …
   Then the detail table: | Component | Type | Scope | Uses (total since install) |
   Used in window? | Est. resident tokens | Verdict |.
2. **Proposed actions grouped by check** (0, 1, 2, 3, 4, 7, 8, 9), each item with
   exact file + exact edit …
3. **Warnings** (checks 5 and 6) — no actions, just findings.
```
（@264580013 起）

以及一句直接回答本次问题的规则：

> `If a check has no findings, say so in one line and move on. Keep the report tight — no padding, no restating these instructions.`
> （@264583023）

**五个关键点：**
- 表头是 `| Component | Type | Scope | Uses | Verdict |` —— **每一列都是数据名，没有一个「检查了什么」式的元描述**，而且这是 **markdown 表格语法**，由模型输出、终端 markdown 渲染器画的，不是 Ink 组件。
- **顺序是「先一句话结论，再细节表」**（`Plain-language summary first`），不是「先表头再数据」。
- **无发现的检查只写一行，不占一行表**。这就是它的「空状态」写法。
- 有 findigs 的检查分组列出，每条给**确切的文件 + 确切的改动**，不是给一个「→ 1 条」的计数。
- 报告结尾给**可撤销说明**（`you can ask me to undo it later`）。

**5. 最尖锐的一条：Claude Code 确实不画「系统正常」的灯，但它一画证据就画得比我们细。**

对比 TR2 的结论「健康会话静止时屏幕上只有对话 + 一条提示框横线 + 一行页脚，没有任何『系统正常』的灯」——
本次确认**这条结论是对的，而且推广到诊断场景**：

- 主屏**永远不画**状态块。`/status` 是用户敲命令才出现的一个对话框标签页（`pl` 的 `title:"Status"` @288644255），
  与 `Config` / `Usage` / `Stats` / `Gates` 并列（@288644542、@288644875、@288644998）。
- 关掉对话框，一切消失。**没有任何常驻的「我检查了 N 项，都正常」**。
- 但**一旦进入诊断场景**（`/doctor`、`claude doctor`、Remote Control 面板），它给的是
  **逐项自陈述句 + 每项的确切来源与确切修复**，粒度比我们那张四行表细得多。

所以：**我们的「空状态自证」设计方向没错，但形态学歪了两处**——
把自证做成了**常驻表头**（它从不这样做），且自证的**粒度是计数**（它的粒度是具体项）。

---

## 二、四个问题的逐条回答

### 2.1 它有没有类似的「状态说明」区块？有没有表头？

有，四形态见上表。**表头只有两次出现**，两次都不是我们要的那种：

1. **`claude doctor` 的首行 `Claude Code doctor`** —— 工具名，不是列名。
2. **`/status` 的 `Session` / `Environment` / `Internal` 三个分节标题**
   （`[{title:"Session",rows:t(m)},{title:"Environment",rows:t(c)},{title:"Internal",rows:t(S)}]`
   `.filter((e)=>e.rows.length>0)` @291867153）—— 这是**分节标签**，一个节下面是十几行键值，
   不是「检查项 / 结果」两列。

真正的表格组件（`Dp` = `Object.assign(P,{Row:L})` @279929822）**支持表头，但全库只有 7 处
`Dp,{columns:` 实例，其中 0 处使用表头**（`Dp.Row` 用了 25 次）。逐处枚举：

```
@280756598  Dp,{columns:so,forceWidth:oo,…}        // shell 详情（so = [{bold:!0},{width:{ratio:1}}]）
@288513644  Dp,{columns:x,…}                       // /status（x = [{bold:!0},{width:"fill"}]）
@288734816  Dp,{columns:[{bold:!0},{}],…}          // MCP 客户端详情（Status:/Issue:）
@288740105  Dp,{columns:[{bold:!0},{}],…}          // MCP HTTP 详情（Status:/Command:）
@289470018  Dp,{columns:[{bold:!0,width:8},{}],…}  // MCP 详情（Type:/URL:/Command:）
@289470459  Dp,{columns:[{bold:!0,width:8},{}],…}  // MCP 详情（Status:/Auth:）
@290156865  Dp,{columns:D,…}                       // hooks 详情（D = [{bold:!0},{}]）
```

全库字面量 `columns:[` 共 6 处，**没有一处含 `header:`**（正则扫描确认）。
变量型列定义共 3 个（`so` @280755328 = `[{bold:!0},{width:{ratio:1}}]`、
`x` @288513450 = `[{bold:!0},{width:"fill"}]`、`D` @290156134 = `[{bold:!0},{}]`），
与上面两种形状同构。

（另有一个完全不同的数据表组件在 @291958915，列名由数据键自动生成
`columns:[...(e[0]??[]).keys()].map((t)=>`column ${t+1}`)` —— 那是图表/指标渲染器，
不是键值面板，与本问题无关。）

`header` 字段的渲染分支在 `P()` 里（@279929408、@279929457）：

```js
let f=i.some(ie);                          // ie = de.header!==void 0
let V=G(i,m,f,c);                          // 量列宽
l=f&&e(W,{cells:i.map(le),columns:i,widths:V,isHeader:!0});   // 只有任一列有 header 才画表头行
u=m.map((se,X)=>e(W,{cells:se,columns:i,widths:V,isHeader:!1},…));
```

**这套机制它写好了，但自己不用。** `header` 只出现在别处（配置源名称 `Pf.userSettings.header="User Settings"`、
模态框标题 `header:"Secret scan"`、`header:"Model switch"`），与表格列无关。

对齐与分隔（`W()` @279927377 起，列宽算法 `G()` @279927694）：
- `A=2` —— **列间固定 2 空格，没有任何竖线或分隔符**。
- `TCt=12` —— 末列若声明 `width:"fill"`，最少留 12 列并允许折行（`t=a>0?"wrap":"nowrap"`）。
- 列宽按内容取最大值（`G()` 里 `u=Math.max(u,B(d[l]))`），**不是硬编码**。
- 标签列在 `Ye()` 里被拼成 `` `${de}:` ``（@288508160），**冒号是行内的一部分，不是分隔符**。

### 2.2 多行键值对怎么排？对齐吗？用什么分隔？表头写什么？

**`/status`（`G()` @288513450 起，行构造 `Ye()` @288507972）**：

```js
x=[{bold:!0},{width:"fill"}]                              // 两列，无表头
b=D.filter(Ve).flatMap(Ye)                                // 空数组的行被丢弃
I=r(s,{flexDirection:"column",gap:1,children:[T,e(Dp,{columns:x,children:b})]})
```

行渲染（`Ye()` @288507972）：

```js
ze.map((o,Fe)=>{let{label:de,value:Je}=o;return r(Dp.Row,{children:[
  e(Q,{children:de!==void 0?`${de}:`:""}),      // label 后加冒号，无 label 就整格空
  e(k,{value:Je})]}…)})
```

- **对齐**：靠 flex 列宽自动对齐（第一列取所有 label 的最宽值），不靠 `padEnd`。
- **分隔**：`:` 紧贴 label，之后一个空格；**行间 `gap:1`（一个空行）**。没有横线、没有竖线、没有缩进标记。
- **表头**：无。
- **空值行为**：`JCn()` @273163024 里 `if(i===null||i===""||i==="none")continue`
  ——**值为空 / `none` 的行整行不出现**。这是「不说废话」的机制化实现。

**`/stats`（`sp()` @288641274）**是唯一用硬对齐的地方，但它是**两对键值横排**：

```js
let D=(J,B,W,oe)=>{let de=(J+":").padEnd(18),        // 左键宽 18 列（含冒号）
  pe=de.length+B.length, ce=Math.max(2,40-pe),      // 左值撑到第 40 列
  ye=(W+":").padEnd(18);                             // 右键也 18 列
  return de+k(B)+" ".repeat(ce)+ye+k(oe)};
…
f.push(D("Favorite model",qo(U[0]),"Total tokens",bi(E)));
f.push(D("Sessions",bi(o.totalSessions),"Longest session",…));
f.push(D("Current streak",L,"Longest streak",K));
f.push(D("Active days",H,"Peak hour",Y));
```

- 对齐靠 `padEnd(18)` + `" ".repeat(ce)` 把左半压到 40 列；**这是硬编码的 18/40，不是自适应**。
- 仍然**没有表头**：`Favorite model` / `Total tokens` 自己就是标签。
- 后面一句灰色脚注说明数据窗口：`Stats from the last ${o.totalDays} days`（@288642205）
  —— **「数据多新」写在末尾一行，一句自然语言，不是表头列**。

**`claude doctor`**：`名字: 值` 单列，**完全不补空格**。值本身长短不齐。

### 2.3 健康检查 / 诊断输出的形态？动词是什么？失败怎么标？

三种输出，三种口径：

**(a) `claude doctor`（终端命令）** — `Ihi()` @127958…

- 首行 `Claude Code doctor`，第二行空行，第三行 `Running: <installType> (<version>)`。
- 全部检查结果以 `名字: 值` 罗列；**通过的项只体现在值里**（`Search: OK (bundled)`），
  **没有勾号、没有绿点**。
- 失败项**额外**用黄字分组列出：
  `he.yellow("Invalid settings")` → `- <file › path>: <message>` + `  Suggested fix: …`；
  `he.yellow("Environment variables")` → `- BASH_MAX_OUTPUT_LENGTH: <message>`；
  `he.yellow("Multiple installations found")` → `- <type> at <path>`；
  `he.yellow(`${n} warning(s) found`)` → `- <issue>` + `  Fix: <fix>`（@272951629、@272951736）。
- 末尾：`No installation issues found.` 或 `For a full setup checkup that can also fix issues, run /doctor in a Claude Code session.`
- **动词**：一个都没有。全是名词短语 + 状态值（`Search: OK`、`Auto-updates: Managed by package manager`）。
  唯一的动词在**建议**里（`Fix:`、`run`），不是检查名里。

**(b) 会话内 `/doctor`** — prompt 形态，规定模型输出：

- 顺序固定：**先 2-3 句人话总结**，再细节表，再按 check 分组的行动，再 warnings。
- 无发现：`say so in one line and move on`。
- 有发现：`exact file + exact edit`。
- 表格列名全是数据名（`Component | Type | Scope | Uses (total since install) | Used in window? | Est. resident tokens | Verdict`），
  **无发现时这一行根本不进表**。
- 检查项命名用 `## Check 0 — setup health (installation, settings, agent and skill definitions)`
  —— **`Check N —` 是章节序号，不是表格列**。

**(c) Remote Control 面板** — `vLo()` @252379662：

- 每条 `{label, ok, detail?}`，`label` 是**过去式/现在时的状态句**（见 §1.2 原文）。
- 渲染时只挑失败的：`for(let m of o.checks.filter((w)=>!w.ok)) l.push(u(`- ${m.label}${m.detail?` (${m.detail})`:""}`))`（@272951409）。
- **`ok:true` 的项在 UI 上完全不出现**，只在数据里存在。

**(d) 失败怎么标**：三种通道，没有一种是「红色 ✗ 放最右列」。

| 通道 | 失败标记 |
|---|---|
| `claude doctor` | 图出标题行（黄）+ `- ` 列表项；**通过的项不标** |
| `/doctor`（prompt） | 模型自拟，规范只要求「先一句话说结论」 |
| Remote Control 面板 | 只有失败项被打印，格式 `- <句子> (<detail>)` |
| `/status` 的 MCP 摘要 | `3 connected, 1 need auth, 2 failed` 一句话，颜色分档（`Xn("success"/"warning"/"error")`），**不是表格列**（@273164234 附近 `nss()`） |

### 2.4 空心状态 + 自证：它做不做？我们反其道而行吗？

**它的做法：常态绝不自证；一旦自证，就把「查了什么」当成内容本身，而不是当成一张表的表头。**

三条机制化证据：

1. **主屏零状态块。** `/status` 只在对话框里（`pl,{title:"Status"}` @288644255），与 Config/Usage/Stats 平级。
   关掉就没了。没有常驻的「N 项已检查」。
2. **空节整节消失。** `buildStatusSections` 结尾 `.filter((e)=>e.rows.length>0)`（@291867243）；
   `H()`（System diagnostics）开头 `if(i.length===0){return null}`（@288513759）；
   `JCn()` 丢掉空值行（@273163155）。
3. **全绿时只说一句自然语言**，不逐项列举：`No installation issues found.`（@272951791）；
   `/doctor` 规范：`If a check has no findings, say so in one line and move on.`（@264583023）。

**所以我们的设计方向是对的，而且比它更需要**——它监控对话框（用户在看着），我们监控看不见的后台进程。
但我们的**形态**有两处与它的做法正相反：

| 我们的做法 | 它的做法 | 判断 |
|---|---|---|
| 常驻「检查了什么 … 结论」表头 | 从不给这类元表头；有表头时列名是数据名（`Component / Uses / Verdict`） | **学歪了** |
| 四行固定结构，无发现也占一行（`→ 0 个`） | 无发现的检查只写一句，**不占表行**；`ok:true` 的项在 UI 上根本不出现 | **学歪了** |
| 「结论」列给出计数（`→ 3 个` / `→ 1 条`） | 给的是**具体项**：哪个文件、哪条命令、怎么改；计数只在汇总句里出现 | 需分场景取舍，见 §3 |
| 首屏第一块就是检查表 | 首屏是判决句；检查表要么在对话框里，要么在段落之后 | **学歪了（位置）** |

**关于「反其道而行是否合理」**：合理，但理由要写对。它不常驻自证，是因为
**对话框在场 + 用户随时可敲 `/status`**；我们的后台进程**不在场**，用户没有别的手段确认「它真的在跑」。
所以常驻是必要的。**但常驻的应该是「判决 + 唯一一句依据」，不是一张四行表。**

---

## 三、具体建议

### 3.1 表头：删掉，改成一句带数字的判决

**「检查了什么 / 结论」这对表头应该删。** 理由不是审美：

- 它是一次**元层描述**（描述「下面这些行是检查结果」），而下面的行本身已经说明了这件事。
  Claude Code 的 7 处表格实例中 0 处使用表头，就是为了省掉这一层。
- 它**占了首屏最贵的一行**，却零信息量。`等你回应 / 问了没答 / 声明对不上 / 后台监视` 四行
  一眼就能看出是检查项。
- 它的存在让空态看起来像「一张没填完的表」，而不是「一份声明」。这正是「突兀」的来源。

**改成什么**（推荐，按信息密度从高到低）：

```
✓ 4 项检查都正常 · 数据 12 秒前 · 监视在跑
```
或（有异常时，异常项顶上来，不再有表头）：
```
等你回应   3 个 · 问了没答 0 · 声明对不上 1 条 · 后台监视 ✗ 未运行
```
前者是它 `No installation issues found.` 的等价物；后者是它 `/status` 的 MCP 摘要句
（`3 connected, 1 need auth, 2 failed`）的等价物。

**如果一定要保留「四行结构」，就只保留一行一个检查项，每行以「句子」开头**，
照抄它的 `label` 双版本写法：

```
等你回应     3 个会话在等你（WAITING/BLOCKED/FAILED）… 
问了没答     没有会话问了没答
声明对不上   1 条完成声明无证据支持 · 6 存疑 · d 看证据
后台监视     监视未在跑（jobs 1.1d / probe 1.1d 未更新）· 先修这个
```

关键差别：**通过的项写成一句话，不用 `→ 0 个` 占位**。`→ 0 个` 是「表格的一格」，
`没有会话问了没答` 是「一句断言」。前者要求读者先把表头读进脑子才能解码，后者直接可读。

### 3.2 四行的排布：去掉列，改成「标签 + 一句断言」

现状是四列（标签 / 来源 / 结论 / 备注），**四列结构本身就是表**，一旦有表就必须有表头，
于是陷入「表头突兀 → 加说明 → 更突兀」的循环。

Claude Code 的 `/status` 只有 **2 列**（`{bold:!0}` + `{width:"fill"}`），列间 2 空格，
**label 自带冒号**。它的 `claude doctor` 更极端：**1 列**，`名字: 值`，不补齐。

三档建议，按侵入性从小到大：

**A. 最小改动**：删表头那一行，四行的「来源」列并进断言里。

```
 等你回应    3 个会话在等（WAITING / BLOCKED / FAILED）
 问了没答    没有
 声明对不上  1 条无证据支持 · 6 存疑 · d 看证据
 后台监视    未在跑 · jobs 1.1d / probe 1.1d 未更新 · 先修这个
```

- 标签列固定宽度（现在的 12 列够），**后面直接跟一句话，不补齐**。
- 「结论」不再单列一列。异常的严重度靠**颜色 + 行首字形**（`✗` / `·`），
  照抄它在无色终端下的分化表（`needsYou:"!"` / `failed:"×"` / `idle:"◦"`）。
- 无异常的项：写 `没有` / `正常`（**一个词，像 `No installation issues found.` 一样短**），
  或者整行不出现。

**B. 推荐**：无异常的项整行不出现，正常的检查汇总成一行。

```
 ✓ 4 项检查通过 · 数据 12 秒前
 声明对不上  1 条无证据支持 · 6 存疑 · d 看证据
 后台监视    未在跑 · jobs 1.1d / probe 1.1d 未更新 · 先修这个
```

这是它 `filter(rows.length>0)` + `No installation issues found.` 的直接移植：
**异常逐行列出给细节，正常压成一句给数字**。首屏从 5 行降到 3 行，且没有任何表头。

**C. 如果每天只看一两次、需要「一眼确认」，就学 `/status` 的对话框**：
把这四行挪进 `d`（证据）面板或一个 `/status` 等价的浮层，
主屏只留一行判决。**这与我们现在 `d 看证据` 的键位设计天然吻合**——
我们已经有了「详细证据在别处」的通道，没必要把两层的入口同时铺在首屏。

### 3.3 该保留的（我们的场景确实不同）

**必须保留，不要因为「它不这么做」就砍掉：**

1. **常驻性本身。** 它监控对话框（用户在看着，随时能敲 `/status`），我们监控后台进程
   （用户看不见，没有 `/status` 可敲）。**「我检查了」这句话必须一直在，不能靠命令召唤。**
   这是场景差异，不是设计缺陷。
2. **「数据多新」**（`数据 12 秒前`、`jobs 1.1d` 未更新）。它的 `Last update attempt: success → 2.1.308 (2026-10-22)`
   和 `Stats from the last N days` 是同一件事，但它只在诊断场景给；我们**必须常驻给**，
   否则用户无法区分「没事」和「扫描没跑」。这一条比它做得对。
3. **后台监视的存活状态**（`监视未在跑 · 先修这个`）。它的 Remote Control 检查里
   `Remote Control enabled for this account` / `availability could not be verified` 是同构的
   「自身可用性」检查，且**失败时给出 `detail` 说明原因**（`decided from your plan, feature flags are off`）。
   我们的「先修这个」比它更直接，保留。
4. **可执行的下一步**（`d 看证据`、`先修这个`）。它的 `/doctor` 给的是
   `- <file › path>: <message>` + `Suggested fix: …`，**粒度到具体文件和改法**；
   我们受限于终端宽度只能给一个键位提示，但**方向一致**：失败项必须带一条出路，不能只报数字。

**可以砍掉或改写的：**

5. **「结论」这一列的名字。** 「结论」对读者是零信息（结论当然是结论）。它用的词是
   `Verdict`（在 `/doctor` 的表头里）或干脆不给列名。若要保留列名，用 **`状态`** 或 **`结果`**，
   或者干脆并进断言里（见 3.2）。
6. **`→ 0 个` 这种零值占位。** 它的做法是「值为空 / `none` 的行不出现」`if(i===""||i==="none")continue`
   和「无发现写一句」。零值占位既占宽度又要求读者解码表头。
7. **「检查了什么」这个短语本身。** 它是**元描述**。若要表达「我查了这些」，直接列**查的对象**
   （`inbox` / `asked` / `verify-claims` / `health`，这也是现有 design 文档里的措辞），
   或者写成一句 `依据：inbox · asked · verify-claims · health`——
   后者是**数据源清单**，不是表头，去掉也不会迷路。

### 3.4 一条可直接照抄的写法（「无发现」标准句）

Claude Code 在三个地方用同一套路：**无发现 = 一句短的自然语言，不是一行全绿的表**。

| 出处 | 原文 |
|---|---|
| `claude doctor` 全绿 | `No installation issues found.`（@272951791） |
| `/doctor` 规范 | `If a check has no findings, say so in one line and move on.`（@264583023） |
| Remote Control 面板 | `ok:true` 的项不进列表（@272951409） |
| `buildStatusSections` | 空节整节不渲染（@291867243） |
| `/status` 行收集 | 空值行跳过（@273163155） |

**移植到我们这里**：`问了没答  没有`、`等你回应  没有会话在等`。
四个字胜过「→ 0 个」+ 一个表头。

---

## 四、证据附录

> 偏移针对 2.1.308 这一份构建。换版本必然失效。

| 偏移 | 内容 |
|---|---|
| 127,958,463 | `claude doctor` 命令注册 `.command("doctor").description("Check the health of your Claude Code installation. …")` |
| 127,958,712 | `No installation issues found.`（CLI 侧字符串） |
| 272,949,292 | `Search: ${t.ripgrepStatus.working?"OK":"Not working"} (${…"bundled"…})` |
| 272,949,696 | `Managed settings (remote): checking… (fetch in progress; re-run in a moment)` |
| 272,950,849 | `he.yellow("Environment variables")` |
| 272,950,996 | `he.yellow("Multiple installations found")` |
| 272,951,409 | `for(let m of o.checks.filter((w)=>!w.ok)) l.push(u(`- ${m.label}${m.detail?` (${m.detail})`:""}`))` |
| 272,951,629 | `he.yellow(`${t.warnings.length} ${O(…,"warning")} found`)` |
| 272,951,736 | `` l.push(`- ${u(o.issue)}`, `  Fix: ${u(o.fix)}`) `` |
| 272,951,791 | `l.push("","No installation issues found.")` |
| 272,951,834 | `For a full setup checkup that can also fix issues, run /doctor in a Claude Code session.` |
| 273,163,024 | `function JCn(o){let t=[];for(let u of o){…`（行收集器） |
| 273,163,155 | `if(i===null||i===""||i==="none")continue`（空值行跳过） |
| 288,507,972 | `function Ye(ze,U){…e(Q,{children:de!==void 0?`${de}:`:""}),e(k,{value:Je})…}`（label 自带冒号） |
| 288,508,221 | `function Xe(C,p){return r(s,{flexDirection:"row",gap:1,paddingX:1,children:[e(mt,{status:"warning"}),…`（诊断提示行） |
| 288,508,998 | `{label:"Version",value:…}`（`/status` Session 节首行） |
| 288,509,518 | `{label:"Session name",value:g}` |
| 288,509,664 | `{label:"Session kind",value:!Ht()?"interactive":ef()?"background job · unattended":"background job · attached"}` |
| 288,510,258 | `{label:"cwd",value:t}` |
| 288,513,642 | `e(Dp,{columns:x,children:b})`（`/status` 表格实例） |
| 288,513,450 | `x=[{bold:!0},{width:"fill"}]`（两列，**无 header**） |
| 280,755,328 | `so=[{bold:!0},{width:{ratio:1}}]`（shell 详情表列定义） |
| 290,156,134 | `D=[{bold:!0},{}]`（hooks 详情表列定义） |
| 288,513,759 | `if(i.length===0){return null}`（System diagnostics 空则整体不画） |
| 288,513,806 | `e(n,{bold:!0,children:"System diagnostics"})` |
| 288,641,245 | `M=18,T=40,v=18` 与 `de=(J+":").padEnd(18)`（`/stats` 硬对齐常量） |
| 288,641,274 | `let D=(J,B,W,oe)=>{let de=(J+":").padEnd(18),…`（`/stats` 两对键值横排） |
| 288,642,205 | `he.gray(`Stats from the last ${o.totalDays} days`)` |
| 288,644,255 | `pl,{title:"Status",children:e(mcr,{…})` （`/status` 是对话框标签页） |
| 288,644,542 | `pl,{title:"Config",…}`（同层标签页） |
| 288,644,875 | `pl,{title:"Usage",…}` |
| 288,644,998 | `pl,{title:"Stats",children:e(as,{onClose:u})},"stats"` |
| 288,668,827 | `let l=t==="stats"?"Stats":"Usage"`（`/stats` 与 `/usage` 共用同一对话框） |
| 291,867,153 | `[{title:"Session",rows:t(m)},{title:"Environment",rows:t(c)},{title:"Internal",rows:t(S)}].filter((e)=>e.rows.length>0)` |
| 291,867,171 | `t=(e)=>JCn(e??[]).map((r)=>({...r,value:yn(r.value).replace(JJr,"")}))` |
| 291,867,285 | `export{g as buildStatusSections}` |
| 279,929,822 | `var Dp=Object.assign(P,{Row:L})`（表格组件导出） |
| 279,927,377 | `A=2,TCt=12`（列间 2 空格；末列 `fill` 最少 12 列） |
| 279,929,408 | `let f=i.some(ie)`（`ie = header!==void 0`）/ `279,929,457` `l=f&&e(W,{…,isHeader:!0})`（**有 header 才画表头**） |
| 279,927,694 | `for(let d of i)u=Math.max(u,B(d[l]))`（按内容量列宽，非硬编码） |
| 252,379,662 | `z=[{label:n?"Connected to the Anthropic API (api.anthropic.com)":…, ok:n}, …]`（Remote Control 检查表，**双版本句子 + ok**） |
| 256,107,491 | `{type:"local-jsx",name:"status",description:"Show Claude Code status including version, model, account, API connectivity, and tool statuses",immediate:!0,requires:{ink:!0}}` |
| 256,566,588 | `{type:"local-jsx",name:"usage",aliases:["cost","stats"],description:"Show session cost, plan usage, and activity stats",…}` |
| 264,545,552 | `## Check 0 — setup health (installation, settings, agent and skill definitions)` |
| 264,549,295 | `Version currency is check 7's job — don't duplicate the lookup here. Runtime state only a live app can see … is out of scope` |
| 264,580,013 | `1. **Plain-language summary first, and keep it SHORT** — 2-3 sentences …` |
| 264,580,299 | `| Component | Type | Scope | Uses (total since install) | Used in window? | Est. resident tokens | Verdict |` |
| 264,583,023 | `If a check has no findings, say so in one line and move on. Keep the report tight — no padding, no restating these instructions.` |
| 264,584,700 | `function Vo(){Ai({name:"doctor",aliases:["checkup"],…,terminalOriented:!0,` `/doctor` 命令注册 |
| 264,536,670 | `Run every check read-only first and present the full report.` |

**复现方法**（不执行目标）：

```js
import fs from "node:fs";
const P = "<LOCALAPPDATA>/Claude-3p/claude-code/2.1.308/<hash>/claude.exe";
const s = fs.readFileSync(P).toString("latin1");
const at = (off, before = 200, after = 600) => s.slice(off - before, off + after)
  .replace(/[^\x20-\x7e\n]/g, "·");
console.log(at(288513450));   // x=[{bold:!0},{width:"fill"}]
```

---

## 五、没挖到 / 不确定的

1. **没运行目标**（任务要求静态分析），所以「`/status` 对话框在真终端里看起来多宽、换行在哪」
   全是源码参数推断，没有目视验证。关键未知：`{width:"fill"}` 那一列在窄终端下的实际折行行为。
2. **`/doctor` 的实际渲染没有渲染器**——它是一段 prompt，输出由模型生成、
   由 markdown 渲染器画。所以「它最终看起来什么样」取决于模型是否遵守 `Report format`。
   本次只确认了**规范怎么写**，没有确认**遵守率**。
3. **`ok:true` 的检查项在 Remote Control 面板上的完整渲染**没读全——
   `272,951,409` 是 `claude doctor` 的消费点；Remote Control 面板本身（`/status` 里的
   `vLo()` 结果）走的是 `pcr`/`fcr` 的行构造，`checks` 只贡献失败项。
   若存在「全部通过」时的正向措辞，未定位到。
4. **`/config` 的排布没读**。`pl,{title:"Config"}` @288,644,552 只确认了它是同层标签页；
   其内部 `xs()` 组件（@288,644,552 里 `e(xs,{mcpClients:M,…})`）的表格形态未展开。
   若要「设置列表怎么排」，还需一轮。
5. **表格的 7 处实例里有 3 处列定义是变量**（`so` @280755328、`x` @288513450、`D` @290156134），
   已逐个解出并确认无表头。另有一个独立的数据表组件在 @291958915
   （`columns:[...(e[0]??[]).keys()].map((t)=>`column ${t+1}`)`），属图表渲染器，未深挖。
6. **`claude doctor` 在 Windows 下的实际输出**未运行验证（任务禁止）。
   `Platform: win32-x64` 是写死的字符串，`Path:` / `Invoked:` 的实际值取决于安装方式。
