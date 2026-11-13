# TUI 视觉语言

> 实现见 [`scripts/tui-theme.mjs`](../../scripts/tui-theme.mjs)。状态判定见 [`state-model.md`](./state-model.md) §2。
> 本文件只规定**怎么显示**，不规定**怎么判定**。TUI 不得自行计算状态（ADR-0001）。

## 1. 三通道

每个状态同时用三条独立通道编码：

| 通道 | 载体 | 谁失效时会丢 |
|---|---|---|
| 字形 | `?` `×` `▲` `●` `○` | 字体缺字时 |
| 颜色 | yellow / red / magenta / green / cyan | 色盲、灰度终端、`NO_COLOR`、管道 |
| 文字 | `BLOCKED` `FAILED` … | 几乎不会失效（只在极窄宽度被截断） |

### 1.1 为什么必须三通道

**WCAG 2.1 成功准则 1.4.1「Use of Color」** 要求颜色不得作为传达信息的唯一视觉手段。这条准则不是排版洁癖：约 8% 的男性有红绿色觉障碍，而本表里 `FAILED`（红）与 `PRODUCING`（绿）恰好是红绿对——这正是最典型的一对混淆色。只靠颜色的 TUI，对这部分用户等于没有状态区分。

颜色通道在终端里还格外脆弱：管道、日志重定向、CI、`TERM=dumb`、截图转灰度、录屏压缩，任何一种都会让它消失。**颜色是装饰，不是信息载体。**

因此 `badge()` 永远同时产出字形与标签；`paint()` 只负责把它染上颜色。关闭颜色时信息量**不减少**，只是少了冗余的一层。

## 2. 状态字形总表

| 字形 | 码位 | 颜色 | 含义 | 处置 |
|---|---|---|---|---|
| `BLOCKED` | `?` | U+003F | yellow | 宿主报告正在等输入（`needs` / `suggestedReply`） | 人回复或明确放弃 |
| `WAITING` | `!` | U+0021 | **brightYellow**（SGR 93） | 宿主报告此刻正在等用户（`waitingFor`），是实时信号 | 人回应 |
| `FAILED` | `×` | U+00D7 | red | **仅**宿主报 failed（心跳推断已删除，见 `state-model.md` §2.0.1） | **唯一允许全量重跑** |
| `STALLED` | `▲` | U+25B2 | magenta | 连续 3 窗 novelty < 0.2 且无持久化变更、派生树零增益 | L2 探针 → L3 收窄 → L4 重拆 |
| `PRODUCING` | `●` | U+25CF | green | 窗口内有持久化变更 | 不干预，等验收 |
| `EXPLORING` | `○` | U+25CB | cyan | 只读探索、novelty 达标、冷启动、或已休眠 | 不干预，**严禁重跑** |

> **颜色名必须在 SGR 表里存在。** 2026-11-05 实测：`badge('WAITING', true)` 返回 **0 个 ESC**，
> 因为 SGR 表里没有 `brightYellow`，`paint()` 静默降级。这是「此刻正在等你」的状态，
> 六个状态里最该亮的那个，反而是唯一没颜色的。现在 `paint()` 遇到未定义色名会
> **记录并告警**（`unknownColors()` / `setColorWarn()`），不再沉默——
> 一个静默降级的着色器，会让这类缺陷永远只是「界面好像有点不对」。

`BLOCKED` 与 `WAITING` 都是宿主直接报告的事实，优先级高于一切推断。**参与通知的是四个状态**（`WAITING` / `BLOCKED` / `FAILED` / `ASKED`，见 `watch.mjs` 的 `NOTIFY_STATES`）；
其中前三个来自宿主文件，`ASKED` 是从 transcript 文本推的、走另一套更严的门（`watch.mjs` §`canNotify`）。
`STALLED` / `PRODUCING` / `EXPLORING` 是描述性的，仅用于显示，不产生通知。

> **`STALLED` 实际命中率 0.018%**（56,809 个滑窗里 10 次），且从未出现在会话末态。
> 字形保留是为了完整性，不要指望在界面上常常见到 `▲`。

**未识别状态**渲染为 `… UNKNOWN(<原值>)`（灰），不静默映射到六态之一。契约漂移必须在屏幕上可见。

## 3. 灰度下的可区分性

去掉颜色后，五个字形靠**形状**区分。这是本套设计的核心约束，也是选字形的唯一硬标准。

| 字形 | 形状特征 | 与相邻字形的差别 |
|---|---|---|
| `?` | 开放的钩形曲线，左侧封闭 | 唯一带曲线且不对称的字形 |
| `×` | 两条对角直线交叉，四角开口 | 唯一纯直线交叉，上下左右都不闭合 |
| `▲` | 实心三角，底边水平 | 唯一有**水平直边**的字形；重心偏下 |
| `●` | 实心圆 | 与 `▲` 同为实心但无任何直边；与 `○` 同为圆但填满 |
| `○` | 空心圆 | 唯一的空心圆环；与 `●` 靠实/空区分 |

差异矩阵（✅ = 形状可区分）：

| | `?` | `×` | `▲` | `●` | `○` |
|---|---|---|---|---|---|
| `?` | — | ✅ | ✅ | ✅ | ✅ |
| `×` | ✅ | — | ✅ | ✅ | ✅ |
| `▲` | ✅ | ✅ | — | ✅（实心 vs 直边）| ✅ |
| `●` | ✅ | ✅ | ✅（实心 vs 直边）| — | ✅（实/空）|
| `○` | ✅ | ✅ | ✅ | ✅（实/空）| — |

所有字符宽度均为 **1 列**（已用终端光标位置报告实测，见 §6），所以六态混排不会错位。

### 3.1 字形选择被实测推翻过一次

最初按任务图用 `✕`（U+2715 BALLOT X）与 `◐`（U+25D0 CIRCLE WITH LEFT HALF BLACK）。实测发现：

- **Windows Terminal / Git Bash (mintty)**：正常显示，各占 1 列。
- **conhost（PowerShell 的默认控制台宿主）**：两者都渲染成**豆腐块**。GDI 度量显示 `✕` 在 Cascadia Mono 下被替换成 1.4 个字符宽的回退字形。

原因可查：Consolas、Lucida Console、Cascadia Mono、Cascadia Code 的 `cmap` 表里**都没有** U+2715 与 U+25D0。WT 能显示是因为它启用了字体回退（fallback）到 Segoe UI Symbol/MS Gothic；conhost 对这类字符更多落到方框。

`×`（U+00D7）与 `○`（U+25CB）在四款等宽字体的 `cmap` 里都**原生存在**，且 conhost / WT / mintty 三处实测均正常、均占 1 列。这是一个被证据修正的设计决定，不是审美偏好。

**规则**：新增字形前，必须同时验证（1）目标字体 `cmap` 覆盖；（2）真实终端里的渲染、非豆腐块；（3）列宽为 1。缺一项不算通过。

## 4. 颜色关闭的三个触发条件

`colorEnabled(stream)` 在以下任一成立时返回 `false`，`paint()` 随即原样返回文本、**不产生任何 ESC 字节**：

| # | 条件 | 原因 |
|---|---|---|
| 1 | `stream.isTTY !== true` | 管道、重定向、CI 捕获。此时 ANSI 码不是颜色，是垃圾字节，会污染 `grep` 与日志 |
| 2 | `NO_COLOR` 存在且非空 | [no-color.org](https://no-color.org) 约定。**空串不算设置**——`NO_COLOR=` 视为未设置 |
| 3 | `TERM=dumb` | 明确声明无颜色能力的终端 |

判断依据是**流**而不是进程：`stdout` 是管道但 `stderr` 是终端时，两者应分别判断。不要缓存这个结果——TTY 状态可能在运行中改变（例如被重定向）。

关闭后 `badge('FAILED', false)` 返回 `"× FAILED"`（0 个 ESC），开启时返回 `"\x1b[31m× FAILED\x1b[0m"`（2 个 ESC）。

## 5. CJK 宽度处理

### 5.1 问题

终端列宽不等于字符数：CJK 汉字、假名、全角标点占 **2 列**，组合符与 ZWJ 序列占 0 或合并。用 `String.length` 对齐表格，中文项目名会把右边界推歪。

### 5.2 规则

`displayWidth(str)` 按**显示列数**计数。**宽度表不是手抄的**：它由
`scripts/gen-width-table.mjs` 从 `scripts/data/` 下的 Unicode 官方数据编译成
`scripts/width-table.mjs`，`--check` 校验表与数据一致（手改表会变红）。

| 数据源 | 用途 | 规模（Unicode 18.0） |
|---|---|---|
| `EastAsianWidth.txt` | East_Asian_Width ∈ {W, F} → 2 列 | 298 段 / 183,866 码点（合并后 126 段） |
| `emoji-data.txt` | Emoji_Presentation = Yes → 2 列 | 302 段 / 1,228 码点（合并后 80 段） |

两张表合并后查表；`Emoji_Presentation` 补上了 EAW 未标记的 26 个码点
（区域指示符 U+1F1E6–U+1F1FF 是典型——国旗的两个字母）。

| 类别 | 宽度 | 判定方式 |
|---|---|---|
| 零宽 | 0 | Unicode 属性转义 `\p{Mn}\p{Me}\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Cs}`，加 U+0000 |
| 宽字符 | 2 | 命中上面两张表的任一区间 |
| 组合符特例 | 0 | **即使 EAW=W 也计 0**：U+302A–302D（CJK 组合用声调符号）是 Mn，叠在前一字上 |
| grapheme 簇 | 取簇内最大 | 见下 |
| ANSI 控制序列 | 0 | CSI 与 OSC，从宽度中完全剔除 |
| 其余 | 1 | ASCII、拉丁、希腊、西里尔、多数符号 |

**grapheme 聚类**用 Node 内置 `Intl.Segmenter`（`granularity: 'grapheme'`），零依赖不变。
簇宽度取**簇内码点的最大宽度**，不是求和——这一条规则同时覆盖三类情况：

- ZWJ 序列（`👨‍👩‍👧` = 2 列）
- 区域指示符对（`🇨🇳` = 2 列；单个区域指示符也是 2 列）
- 肤色修饰符（`👍🏻` = 2 列，**不是 4 列**——修复前实测就是 4）

含 VS16（U+FE0F）时至少 2 列（`♥️` = U+2665 U+FE0F 从 1 提到 2）；含 VS15（U+FE0E）不提升。

> **为什么改写成生成表**：旧版手抄 20 段 W/F，而 Unicode 有 298 段。实测 10 个代表性字符
> （`⚓ ⚪ 🟡 🟢 🟣 ✅ ⚡ ⌚ × ▲`）**错 8 个**，全部量成 1 列。手抄一张 298 段的表不可能保证不漏，
> 也没法证明它对应哪个 Unicode 版本。

### 5.3 截断

`padDisplay(str, width)` 与 `truncateDisplay(str, width)`：

- 不足则右侧补空格到目标宽度；
- 超出则截到 `width-1` 列并补 `…`，**明确表示被切过**；
- **不切开宽字符**：边界只剩 1 列时宁可留空格；
- **ANSI 安全**：控制码原样保留；发生截断时补一个 `RESET`，防止颜色漏到下一行；
- 恰好等宽时原样返回，不动原字符串。

`displayWidth` / `padDisplay` / `truncateDisplay` 共用同一个 measure 函数，保证
「量出来的宽度」与「切在哪里」永远一致——这是三者不会互相打架的前提。
截断必须**按簇累加**，不能每追加一个字符就重算整个前缀：后者是 O(n²)，
实测 6400 字 **321ms/call**，而列表每行的 reason 列都要截一次。

### 5.4 边界诚实

宽度规则覆盖全部 EAW-W/F 与 Emoji_Presentation，但仍不是完整的 `wcwidth`：

- 未处理终端自身的 `ambiguous` 宽度设置（`EastAsianWidth=Ambiguous` 时部分符号可能占 2 列）；
- `Intl.Segmenter` 缺失时退回按码点量宽，`segmenterAvailable()` 会返回 false，
  此时修饰符不聚合（行为退化但不会崩）；
- 极端情况下（终端字体对某码点回退到不同的宽度）仍可能错位。

遇到未覆盖的情况，宁可**多留空格**也不重叠——TUI 里重叠的代价远高于右侧多几个空格。

## 6. 实测记录

以下结论均在本机实跑，非推断：

| 检查 | 环境 | 结果 |
|---|---|---|
| 五字形列宽 | Windows Terminal + node CPR 探针 | `?` `×` `▲` `●` `○` 均 advance=1；`中`=2 |
| 五字形渲染 | Windows Terminal（Cascadia Mono 默认） | 全部正常，无豆腐块 |
| 五字形渲染 | Git Bash / mintty（Git for Windows 自带） | 全部正常，无豆腐块 |
| 五字形渲染 | conhost + PowerShell（Consolas） | 全部正常，无豆腐块 |
| `✕` U+2715 | conhost + PowerShell | **豆腐块**（已被替换为 `×`）|
| `◐` U+25D0 | conhost + PowerShell | **豆腐块**（已被替换为 `○`）|
| 字体 `cmap` 覆盖 | Consolas / Lucida Console / Cascadia Mono / Cascadia Code | `?` `×` `▲` `●` `○` 四款均含；U+2715、U+25D0 四款均缺 |

`displayWidth` 断言（6 项，全部通过）：

| 用例 | 输入 | 期望 | 实测 |
|---|---|---|---|
| 纯 ASCII | `FAILED` | 6 | 6 |
| 纯中文 | `会话扫描` | 8 | 8 |
| 中英混排 | `ST2 执行 Agent` | 14 | 14 |
| emoji | `🔥` | 2 | 2 |
| 全角标点 | `Hello，World！` | 14 | 14 |
| 空串 | `""` | 0 | 0 |

### 6.1 宽度回归（2026-11-05）

修复前后对比，同一台机器、同一个 Node（v26.12.1）：

| 用例 | 修复前 | 修复后 | Unicode 18.0 基准 |
|---|---|---|---|
| `⚓` U+2693 | 1 | 2 | EAW=W |
| `⚪` U+26AA | 1 | 2 | EAW=W |
| `🟡` U+1F7E1 | 1 | 2 | EAW=W |
| `🟢` U+1F7E2 | 1 | 2 | EAW=W |
| `🟣` U+1F7EB | 1 | 2 | EAW=W |
| `✅` U+2705 | 1 | 2 | EAW=W |
| `⚡` U+26A1 | 1 | 2 | EAW=W |
| `⌚` U+231A | 1 | 2 | EAW=W |
| `×` U+00D7 / `▲` U+25B2 | 1 | 1 | EAW=Na（字形依赖） |
| `👍🏻` | 4 | 2 | 1 个 grapheme 簇 |
| `👨‍👩‍👧` | 2 | 2 | ZWJ 序列 |
| `🇨🇳` | 2 | 2 | 区域指示符对 |

**错误率 8/10 → 0/10。**

`truncateToWidth` 性能（`process.hrtime` 进程内计时，已排除 5.6s 冷启动）：

| 输入长度 | 修复前 | 修复后 |
|---|---|---|
| 800 字 | 9.0 ms/call | 2.6 ms/call |
| 1600 字 | 33.3 ms/call | 1.3 ms/call |
| 3200 字 | 95.1 ms/call | 3.6 ms/call |
| 6400 字 | **321.3 ms/call** | **8.1 ms/call** |

## 7. 使用方式

```js
import { badge, displayWidth, padDisplay, colorEnabled, STATES } from './tui-theme.mjs';

const on = colorEnabled(process.stdout);
const NAME_COL = 24;

for (const s of sessions) {
  const b = padDisplay(badge(s.state, on), 12);   // 徽章列对齐
  const name = padDisplay(s.project, NAME_COL);    // 中文项目名不会推歪右边界
  console.log(`${b} ${name} ${STATES[s.state]?.meaning ? '' : '… unknown'}${s.reason}`);
}
```

**不要**自己拼 `\x1b[31m`——颜色必须经过 `paint()`，否则 `NO_COLOR` 会漏。
