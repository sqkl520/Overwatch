# Claude Code CLI 的 TUI 逆向：界面设计有什么可学的

- 日期：2026-11-05（检索执行于 2026-11-09）
- 作者：检索 Agent TR2
- 产出形态：exploration（逆向分析）
- 目标：Claude Code CLI 2.1.308，Windows x64 单文件可执行，297,376,928 字节，
  SHA-256 `c9796ba22a9221586b36371b36f5b66198d66eb4badf6a4cf4a5f7b07becea53`
  （同机另有 2.1.270 副本，作交叉核对用，本次未逐条比对）

## 方法与手段（如实声明）

**用了什么**：只做静态分析，未执行目标。手段是「字节级切片 + 正则定位」：
把整个 exe 以 `latin1` 一次性读入内存（Node），用 `indexOf` / 正则定位字符串与
函数体，再按偏移切片打印上下文；对 UTF-16LE 区域单独用 `utf16le` 视图检索。
所有结论附字节偏移，可复现。

**rea 用了，但它在这台机器上做不了这件事**：用户提供的 rea 工具目录（rea-agents 6.5.0）。
`rea inspect-artifact` 能跑通（能算出上面那个 SHA-256、识别 `format: pe`），
但 `inspect-binary-layout` / `analyze` / `search` 全部拒绝：
前者报 `unsupported_provider`（"pwntools artifact profile supports Linux x64 only"），
后者报 `provider_unavailable`，`rea doctor` 显示 ghidra / hopper / ida / jadx 四个原生
provider 都是 `missing_analysis_engine`。**所以本报告没有反汇编，只有字符串与
打包后 JS 的静态阅读。** 结论止于「代码在做什么」，不含「编译器生成了什么指令」。

**为什么字符串就够**：这个 exe 是 Bun 的单文件编译产物（`bun/1.4.4` 标记 8 处），
**2507 个 `// @bun @bytecode` 分块**，未压缩的 JS 源码直接以明文躺在可执行段的尾部
（第一处 license header 在偏移 245,030,106，最后一处在 293,288,753）。也就是说
TUI 的全部逻辑都是可读的源码文本，不需要反汇编。这是本次能给出量化结论的前提。

**未挖到 / 未能确证的**（详见第九节）：实际渲染帧的像素级效果（没有运行）、
动态配色在真终端下的观感、`Bun.ant.CellSegmenter` 的内部实现（在 Bun 运行时里，
不在 JS 侧）、部分压缩后单字母函数的具体调用点（同名变量在不同 chunk 里重名）。

---

## 一、结论先行

**1. 它不是「从零写 ANSI」，也不是直接用 npm 上的 ink；是 React 19 + 一个深度魔改的
自研 Ink 分叉 + 自己重写的 JS flexbox 布局引擎。**
证据：`reconcilerVersion` 与 `19.2.0` 同段（@128,011,xxx 附近）、
`createRoot` 22 处、`useSyncExternalStore` 7 处、`Fiber` / `currentDispatcherRef` /
`onCommitFiberRoot` / `findAllNodes` / `data-testname` 等整套 DevTools 协议字段；
节点名是 ink 家族的 `ink-root` / `ink-box` / `ink-text` / `ink-virtual-text` /
`ink-link` / `ink-raw-ansi` / `ink-progress`；
还有 `FocusManager`（30 处）、"Raw mode is not supported on the stdin provided to Ink.
Read about how to prevent this error on https://github.com/vadimdemedes/ink/..."
这段只有 ink 才有的报错文案，以及 ink 特有的 `measureElement` / `useStdout`。
**没有第三人称 TUI 库的痕迹**：`blessed` 10 处全部是 HTML 脚本校验文案里的
`script-not-blessed`（与本 UI 无关）；`chalk` 4 处是内部变量名
`chalkGeneration`（风格池的代际号，说明原本用 chalk，现在换成了自建的
stylePool）；`boxen` / `cli-boxes` / `string-width` / `wrap-ansi` /
`slice-ansi` / `is-fullwidth-code-point` / `ansi-escapes` / `cli-cursor` 全部 0 处。
**结论：依赖全部被内联 + 改名，只剩 ink 的命名与报错文案没改。**
**布局引擎是重点**：`yogaNode` 是内部字段名，但没有任何 wasm 痕迹
（`yoga.wasm` / `YGNode` / `instantiateWasm` 均 0 处），而是有一个纯 JS 的
`class` 实现了 Yoga 的整套 API——`calculateLayout(w,h,dir)`、`insertChild`、
`setMeasureFunc`、`getComputedLeft/Top/Width/Height/Border/Padding`、
`markDirty`、`freeRecursive`，内部用 `Int32Array` 存多槽布局缓存
（`_cIn/_cOut/_lc/_mc`），config 上还挂了 `nodesVisited` / `measureCalls` /
`measureCacheHits` / `cacheHits` / `liveNodes` 五个计数器。**这是「自己写了一个
够用的 flexbox 子集」**，不是引 yoga-layout。

**2. 渲染层是双缓冲单元格 diff + 可选的 DECSTBM 滚动区，两套显示模式。**
`frontFrame` / `backFrame` / `pendingClears` / `damage` / `clips` /
`absoluteRectsPrev` / `absoluteRectsCur` / `skipSelfBlit`；
有完整的 `DECSTBM`（set scrolling region）、`SCOSC/SCORC`、`DECSCUSR`（光标形状）、
SGR、CUU/CUD/CUF/CUB、ECH/IL/ICH/DCH 指令名表；模式二选一：
classic（行内追加）与 fullscreen（`/tui fullscreen`，alt-screen，`\x1b[?1049h`），
且 fullscreen **连续启动失败会自动关掉**（"fullscreen was turned off on this machine
after it repeatedly failed to start; /tui fullscreen retries"）。

**3. 配色是「6 套语义调色板 × 每个颜色都有一个 shimmer 孪生色」，不是随手挑的颜色。**
6 套：`dark`（默认）/ `light` / `dark-ansi` / `light-ansi` / `dark-daltonized` /
`light-daltonized`（`TW()` 的 switch 原文可读）。语义名约 60 个，
关键值见第三节。**shimmer 孪生色是整套动画语言的基础**：`claude` / `claudeShimmer`、
`permission` / `permissionShimmer`、`promptBorder` / `promptBorderShimmer`、
`warning` / `warningShimmer`、`inactive` / `inactiveShimmer`、`fastMode` /
`fastModeShimmer`、`autoAccept` / `autoAcceptShimmer`、7 组 `rainbow_*` 各带 shimmer。
动画不是「加一个动画库」，而是**在基准色和 shimmer 色之间按余弦插值出一个颜色，
只给一个字符上色**（`(1-cos(2πt/T))/2` 缓动，颜色量化步长 1/8）。一行文字里
只有 1 个字符在闪，其余不动——这是它看起来「安静」的技术原因。

**4. 状态表达的核心是「单表驱动 + 三档降级」，而「没有异常」的答案是「什么都不显示」。**
一张 `status → (icon, color, ariaLabel)` 表覆盖 13 个状态；一张 4 项
`colorless` 字形表在无色终端下把彩色圆点换成互不相同的 ASCII 近似字形；
装饰性图标一律 `aria-hidden` 配 `aria-label`。
**没有任务时不画空面板、不画 "0 tasks"、不画 idle 提示**——页脚计数器
只在 `count > 0` 时 push 一项；`needsYou` 是
`some(task => dot(task)==="needsYou")` 的布尔值，全都不需要你时它就是 `false`，
页脚自然短一截。异常才升级，正常就沉默。

**5. 溢出从不静默。** 这是我认为最该抄的一条纪律：所有截断点都带**可数的披露**——
`… (+141 chars NOT SHOWN)`、`(+12 more lines)`、`[42 lines elided]`、
`Removed 3 invisible characters`、`… (1 idle agent)`。不是「截断就截断」。

---

## 二、它用什么做 TUI

| 层 | 实现 | 证据（偏移 / 原文） |
|---|---|---|
| 运行时 | Bun 1.4.4 单文件编译，JS 明文嵌在可执行段尾部 | `bun/1.4.4` 8 处；license header 首尾 245,030,106 … 293,288,753；`// @bun @bytecode` 2507 处 |
| 视图层 | React 19.2.0 + 自研 Ink 分叉 | `reconcilerVersion` 紧邻 `19.2.0`（@128,011,xxx 段）；`createRoot` 22 处；`useSyncExternalStore` 7 处；`ink-root` `ink-box` `ink-text` `ink-virtual-text` `ink-link` `ink-raw-ansi` `ink-progress` 节点名 |
| 布局 | **自研纯 JS flexbox**，API 仿 Yoga，无 wasm | `calculateLayout(n,u,f){…}` @261,457,846；`class` 体 @261,449,000 起，含 `_cIn/_cOut` Int32Array 缓存、`nodesVisited/measureCalls/cacheHits` 计数；`yoga.wasm`/`YGNode`/`instantiateWasm` 各 0 处 |
| 渲染 | 双缓冲单元格 diff + 可选 DECSTBM | `frontFrame`/`backFrame`/`pendingClears`/`skipSelfBlit` @128,0xx；指令名表含 `DECSTBM` `SCOSC` `DECSCUSR` `ECH` `IL` `ICH` `DCH`（@128,011,308） |
| 宽度 | `Bun.stringWidth(s,{ambiguousIsNarrow:true})` + `Bun.ant.CellSegmenter` | @245,848,744；@253,533,418 |
| 造色 | 自建 ANSI 层（`rgbToAnsi256` / `hexToAnsi` / `ansi16m`），无 chalk | @253,527,xxx 内的 `codes`/`rgbToAnsi256`/`ansi256ToAnsi` 表 |
| 帧节拍 | 全局 tick 16 ms（终端失焦时翻倍到 32 ms） | `var Zg=16,Sds=50,wds=4,vds=16384,Keo=250` @261,296,772；`T=Zg*2`、`t.setTickInterval(n?Zg:T)` @261,298,948 |

补充：**它连「盒模型」也是自己的**。`ink-text` / `ink-virtual-text` / `ink-link` /
`ink-progress` 这些节点名不是共享的——`n!=="ink-virtual-text" && n!=="ink-link" &&
n!=="ink-progress" ? Node.create(u) : void 0` ——意思是**文本节点也带 yogaNode**，
只有这三种虚拟节点才跳过。边框样式表是一张 `boxen` 风格的表，
键名 `single` / `double` / `round` / `bold` / `singleDouble` / `doubleSingle` /
`classic` / `arrow` / `dashed` / `quote`（原文见 @248,970,9xx）。实际使用统计：
`borderStyle:"round"` 20 处、`"single"` 14 处、`"quote"` 4 处、`"dashed"` 0 处、
`"bold"` 0 处。**结论：实际只用了 `round`（提示框/面板）、`single`（少量）、
`quote`（引用块的左侧竖条 `▎`）三种。**

---

## 三、视觉规格（可量化）

### 3.1 配色

三套「真彩」调色板的逐值抓取（用 `[,{]name:"value"` 在每套对象内单独抽取，
已核对每个对象在源码里的变量名与 `TW()` 的 switch 分支）：

| 语义 | dark（默认 `p`） | light（`U`） | dark-daltonized（`P`） | light-daltonized（`W`） |
|---|---|---|---|---|
| `text` | `rgb(255,255,255)` | `rgb(0,0,0)` | `rgb(255,255,255)` | `rgb(0,0,0)` |
| `inverseText` | `rgb(0,0,0)` | `rgb(255,255,255)` | `rgb(0,0,0)` | `rgb(255,255,255)` |
| `claude`（主色/助手） | `rgb(215,119,87)` | `rgb(215,119,87)` | `rgb(255,153,51)` | `rgb(255,153,51)` |
| `claudeShimmer` | `rgb(235,159,127)` | `rgb(245,149,117)` | `rgb(255,183,101)` | `rgb(255,183,101)` |
| `permission` / `suggestion` | `rgb(177,185,249)` | `rgb(87,105,247)` | `rgb(153,204,255)` | `rgb(51,102,255)` |
| `planMode` | `rgb(72,150,140)` | `rgb(0,102,102)` | `rgb(102,153,153)` | `rgb(51,102,102)` |
| `autoAccept` | `rgb(175,135,255)` | `rgb(135,0,255)` | `rgb(175,135,255)` | `rgb(135,0,255)` |
| `bashBorder` | `rgb(253,93,177)` | `rgb(255,0,135)` | `rgb(51,153,255)` | `rgb(0,102,204)` |
| `inactive` | `rgb(153,153,153)` | `rgb(102,102,102)` | `rgb(153,153,153)` | `rgb(102,102,102)` |
| `subtle` | `rgb(80,80,80)` | `rgb(175,175,175)` | `rgb(80,80,80)` | `rgb(175,175,175)` |
| `success` | `rgb(78,186,101)` | `rgb(44,122,57)` | `rgb(51,153,255)` | `rgb(0,102,153)` |
| `error` | `rgb(255,107,128)` | `rgb(171,43,63)` | `rgb(255,102,102)` | `rgb(204,0,0)` |
| `warning` | `rgb(255,193,7)` | `rgb(150,108,30)` | `rgb(255,204,0)` | `rgb(255,153,0)` |
| `diffAdded` | `rgb(34,92,43)` | `rgb(105,219,124)` | `rgb(0,68,102)` | `rgb(153,204,255)` |
| `diffAddedDimmed` | `rgb(71,88,74)` | `rgb(199,225,203)` | `rgb(62,81,91)` | `rgb(209,231,253)` |
| `diffAddedWord` | `rgb(56,166,96)` | `rgb(47,157,68)` | `rgb(0,119,179)` | `rgb(51,102,204)` |
| `diffRemoved` | `rgb(122,41,54)` | `rgb(255,168,180)` | `rgb(102,0,0)` | `rgb(255,204,204)` |
| `promptBorder` | `rgb(136,136,136)` | `rgb(138,138,138)` | `rgb(136,136,136)` | `rgb(138,138,138)` |
| `promptBorderShimmer` | `rgb(166,166,166)` | `rgb(183,183,183)` | `rgb(166,166,166)` | `rgb(183,183,183)` |
| `claudeBlue_FOR_SYSTEM_SPINNER` | `rgb(147,165,255)` | `rgb(87,105,247)` | `rgb(153,204,255)` | `rgb(51,102,255)` |
| `merged` | `rgb(175,135,255)` | `rgb(135,0,255)` | `rgb(175,135,255)` | `rgb(135,0,255)` |
| `background` | `rgb(0,204,204)` | `rgb(0,153,153)` | `rgb(0,204,204)` | `rgb(0,153,153)` |
| `ide` | `rgb(71,130,200)` | `rgb(71,130,200)` | `rgb(71,130,200)` | `rgb(71,130,200)` |

四条可读出来的规律：

1. **主色 `claude` 在 dark / light 两套里完全相同（`rgb(215,119,87)`）**，
   只在 daltonized 套里换成 `rgb(255,153,51)`。**品牌色不随明暗漂移**，
   明暗差异全部让给前景色（`text` / `inactive` / `subtle`）。
2. **shimmer 不是简单的「更亮」，是有意的偏离**：dark 的 `claude` 是
   `(215,119,87)`，shimmer 是 `(235,159,127)`（R+20 G+40 B+40，明显偏白）；
   light 的 shimmer `(245,149,117)` 相对 `claude` 是 R+30 G+30 B+30。
   **两个方向的 shimmer 都是「往白里走」，不是往亮里走。**
3. **`ide` 是唯一四个套系完全一致的颜色**（`rgb(71,130,200)`）——
   因为它是给外部 IDE 的识别色，不属于本 UI 配色体系。
4. **`inactive` 与 `subtle` 在 dark 里是「灰得下去」的（153 / 80），
   在 light 里是「灰得上去」的（102 / 175）**。两者都不是「半透明黑/白」，
   是显式给定的两个灰阶——三档文字层级（`text` → `inactive` → `subtle`）完全靠这三个值。

ANSI 降级口径（`dark-ansi` / `light-ansi`）不发明新色，只映射到 16 色：
`claude→ansi:redBright`、`permission→ansi:blue`、
`planMode→ansi:cyan`、`autoAccept→ansi:magenta`、
`bashBorder→ansi:magenta`、`success→ansi:green`、`error→ansi:red`、
`warning→ansi:yellow`、`diffAdded→ansi:green`、`diffRemoved→ansi:red`。

**三个观察值得记**：
1. **状态色是三档而非一档**。`diffAdded` / `diffAddedDimmed` / `diffAddedWord`
   分别是「整行底色」「弱化行底色」「词级高亮」——同一个语义给三档明度，
   用在同一屏里区分层级，而不是加新色相。
2. **`red/blue/green/yellow/purple/orange/pink/cyan_FOR_SUBAGENTS_ONLY`**：
   8 个子 agent 专属色，名字里大写写着「只给子 agent 用」。这是配色纪律的极端形式——
   **用命名约束用途**，而不是写文档要求大家别乱用。
3. `fastMode: rgb(255,120,20)`、`effortUltra: rgb(175,135,255)` 这类「功能色」
   独立成 key，不借用 `warning` / `merged`。

### 3.2 字形

状态/结构字形（多为 `\uXXXX` 转义，已解码）：

| 用途 | 字形 | 码位 | 备注 |
|---|---|---|---|
| 助手消息项目符号 | `●` | 25CF | **非 macOS** |
| 同上 | `⏺` | 23FA | **macOS 专用**：`$t=I()==="macos"?"\u23FA":"\u25CF"` |
| 工具结果分支前缀 | `⎿` | 23BF | 后面接两个空格：`"${f}${Qti}  "` |
| 引用块左竖条 | `▎` | 258E | `borderStyle:"quote"` 的 `left` |
| 工作动画星 | `✻` | 273B | 另有 `✢`(2722) `✳`(2733) `✶`(2736) `✽`(273D) |
| 错误/重试星 | `✻` | 273B | 旋转器「卡住」时用 error 色画同一颗星 |
| accept-edits / auto 模式 | `⏵⏵` | 23F5 ×2 | |
| plan 模式 | `⏸` | 23F8 | |
| 面板/工件前缀 | `⧉` | 29C9 | 组成 `"⧉ 3"` |
| 说明性标记 | `✦` `※` `⚠` `∴` `∵` `∷` `∙` `›` `․` | 2726 203B 26A0 2234 2235 2237 2219 203A 2024 | |
| 方向/流程 | `↑` `↓` `↳` `←` `→` `↵` `↯` `↻` | 2191 2193 21B3 2190 2192 23CE 21AF 21BB | |
| 圆族（进度） | `◐` `◉` `◈` `◎` `◌` `◯` `◇` `◆` | 25D0 25C9 25C8 25CE 25CC 25EF 25C7 25C6 | 任务面板用 ◻/◼ |
| Braille 旋转 | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | 280B…280F | 备用旋转；另有单帧 `⠿`(283F) |
| ASCII 旋转（无 Unicode 终端） | `·|·` `·/·` `·—·` `·\·` | | `gnr` 数组，**加字面竖线/斜杠** |
| 省略号 | `…` | 2026 | 全文统一 U+2026，**没有一处用 `..`** |
| 分隔符 | ` · ` | B7 | 页脚各项之间，宽度 `ae(" · ")` 参与排版 |

`figures` 风格图标表（两张：Unicode 与 ASCII 兜底）：

```
Unicode: tick ✔(2714) info ℹ(2139) warning ⚠(26A0) cross ✘(2718)
         squareSmall ◻(25FB) squareSmallFilled ◼(25FC) circle ◯(25EF)
         circleFilled ◉ radioOn ◉ radioOff ◯ checkboxOn ☒(2612) checkboxOff ☐(2610)
         pointer ❯(276F) triangleRight ▶(25B6) star ★(2605) …
ASCII:   tick √(221A) info "i" warning ‼(203C) cross ×(D7)
         squareSmall □(25A1) squareSmallFilled ■(25A0)
         circle "( )" circleFilled "(*)" circleDotted "( )" circlePipe "(│)"
         checkboxOn "[×]" checkboxOff "[ ]" pointer ">" triangleRight "►"
         hamburger "≡" star "✶" mustache "┌─┐" oneSeventh "1/7" …
```

选哪张由 `r()` 决定（原文）：

```js
function r(){ let {env:e}=process, {TERM:i, TERM_PROGRAM:l}=e;
  if (process.platform !== "win32") return i !== "linux";   // 保守：linux 控制台视为不支持
  return Boolean(e.WT_SESSION) || Boolean(e.TERMINUS_SUBLIME)
      || e.ConEmuTask==="{cmd::Cmder}" || l==="Terminus-Sublime" || l==="vscode"
      || i==="xterm-256color" || i==="alacritty" || i==="rxvt-unicode"
      || i==="rxvt-unicode-256color" || e.TERMINAL_EMULATOR==="JetBrains-JediTerm"; }
```

**注意「非 win32 平台只要不是 `TERM=linux` 就认为支持 Unicode」这条**：
不是白名单，是黑名单。这与 Windows 侧的白名单正好相反——
Windows 的终端能力太碎，只能白名单；类 Unix 太杂，只能黑名单。

### 3.3 间距

**消息左侧有个 2 列的「排水槽」（gutter）**，这是整个界面最稳定的对齐轴：

```js
e(s,{minWidth:2, children: e(n,{"aria-hidden":!0, color:"text", children:So})})   // ●
e(Qu,{fromLeftEdge:!0, minWidth:2, children: e(n,{"aria-label":"claude:", color:"text", children:So})})
```

`minWidth:2` 出现 28 处，`fromLeftEdge` 18 处——**所有消息/工具/提示行的首列
都是固定 2 列宽**，字形（`●` / `✻` / `⎿` / `◦` / `×` / `▲`）占第 1 列，
第 2 列是空格，正文从第 3 列起。**这意味着无论行首是单宽还是双宽字形，
正文的起始列都不变。** 这比「按字形宽度动态缩进」稳得多，也是它看起来整齐的主因。

- 面板/提示框：`borderStyle:"round"` + `paddingX:1`；**只画上边框**
  （`borderLeft:!1, borderRight:!1, borderBottom:!1, marginTop:1`）——
  这是「一条横线 + 两个圆角」的分节手法，不是四边框。
- 页脚各项之间固定 `" · "`（3 列宽，参与宽度预算）。
- 状态图标列宽**不是硬编码**：`qst()` = 所有状态图标显示宽度的最大值，
  `VRn()` = `qst()+1`。所以换图标集时对齐自动成立。
- 工具结果缩进：`"${indent}  "` 两格；结果行前缀 `"${indent}${⎿}  "`，
  续行用 `" ".repeat(ae(prefix))` —— **按显示宽度补齐**，不是按字符数。
- 任务面板：`marginTop:1, marginLeft:2`。
- 旋转器行：`marginTop:1, width:"100%"`。

### 3.4 截断规则

统一 `…`（U+2026），三个方向 + 一套宽度安全算法：

```js
var pSe="\u2026";
function Nr(n,u,f){ let m=Bun.sliceAnsi(n,u,f);
  while(f>u && ae(m)>f-u) f--, m=Bun.sliceAnsi(n,u,f);  // 宽度回退，防切一半宽字符
  return m; }
function u6t(n,u,f){                     // 返回 head/tail
  n=AHe(n); let m=ae(n); if(m<=u) return null;
  if(u===1) return {head:"",tail:""};
  if(f==="start")  return {head:"",tail:Nr(n,m-u+1,m)};
  if(f==="middle"){ let p=Uy(n,m,u), g=ae(p.head)+1+ae(p.tail);
                    return g<u ? Uy(n,m,g) : p; }      // 迭代收紧到刚好 <= u
  return {head:Nr(n,0,u-1),tail:""};
}
function Uy(n,u,f){ let m=Nr(n,0,Math.floor(f/2));     // 中点切，两半各取一半
  let p=Nr(n,u-(f-1-ae(m)),u); return {head:Nr(n,0,f-1-ae(p)),tail:p}; }
function Jx(n,u,f){ if(u<1) return ""; let m=AHe(n);
  let p=u6t(m,u,f); return p===null?m:p.head+pSe+p.tail; }
```

- **`middle` 模式的口径**：前半取 `floor((u-1)/2)` 列，后半取剩余，中间 1 列给 `…`；
  因为宽字符可能差 1 列，所以要做一次「收紧重算」循环。
- `wrap` 模式有 5 个值：`wrap` / `wrap-trim` / `wrap-stream` / `end`（=truncate-end）/
  `middle` / `truncate-start`；`truncate` 与 `truncate-end` 同义。
- **路径截断是单独的**：`truncatePathMiddle` 先找最后一个路径分隔符，
  **保留文件名不动、只截目录**——文件名才是人要看的部分。
- **宽度/行数预算常量**（原文）：
  `Ue=8, ze=40`（旋转器消息至少留 40 列，再留 8 列给计数）；
  `e4t=24`（工件名截 24 列）；
  `Rn=3, _n=100, Cl=12, Tl=6`（@279,944,625）：任务面板默认只显示 **3** 行
  （展开后上限 **100** 行）、工具字段最多 **12** 行、工具结果最多 **6** 行；
  `rl=64, wh=160, Ch=400`（@246,115,398）：三档字符串上限（64 用于标识符、
  160 用于普通串、400 用于长串）。
  任务面板被裁时给出的是**分类计数**而不是行数：
  `… +3 in progress, 2 pending, 5 completed`（`In()` 函数原文）。
- 拿不到显示宽度的兜底：`Hr()` 里 `Math.max(逐字符宽度和, stringWidth(整串))` ——
  **取两者较大值**，宁可多留一格也不写字溢出。

### 3.5 溢出披露（我认为最值得抄的一条）

不是「截断 + 省略号」就完事，而是**告诉你丢了多少**：

| 原文 | 出处 |
|---|---|
| `… (+${N} chars NOT SHOWN)` | `Rl()` @246,115,398 |
| `(+${N} more lines)` | 差异面板 @127,467,885 |
| `(+${N} more lines (` + … | 同上，带后续说明 |
| `[${N} lines elided]` | 子进程输出（`Waiting for N other script(s)` 附近） |
| `Removed 1 invisible character` / `Removed ${N} invisible characters` | 粘贴净化 @133,766,672 |
| `… ${N} more lines` | 滚动提示 |
| `${N} idle agent` / `${N} idle agents` | 代理计数 @126,667,250 |
| `[unreadable text]` / `[unreadable]` / `[?]` | 选宽度放得下的那个 @261,582,229 |

最后一条尤其巧：**占位符本身有三档长度**（17 / 12 / 3 列），
`qC.find(M => Hr(M) <= u) ?? "?"` —— 先试最长的，装不下退短的。

---

## 四、状态怎么表达（重点）

### 4.1 一张表定义 13 个状态

```js
  success : {icon:te.tick,    color:"success",    ariaLabel:"done:"},
  error   : {icon:te.cross,   color:"error",      ariaLabel:"failed:"},
  warning : {icon:te.warning, color:"warning",    ariaLabel:"warning:"},
  info    : {icon:te.info,    color:"suggestion", ariaLabel:"note:"},
  pending : {icon:te.circle,  color:void 0,       ariaLabel:"pending:"},
  loading : {icon:"\u2026",   color:void 0,       ariaLabel:"loading:"},
  running : {icon:So,         color:void 0,       ariaLabel:"running:"},
  on      : {icon:te.tick,    color:"success",    ariaLabel:"on:"},
  off     : {icon:te.circle,  color:void 0,       ariaLabel:"off:"},
  working : {icon:xvt,        color:void 0,       ariaLabel:"working:"},
  needsYou: {icon:xvt,        color:"warning",    ariaLabel:"needs you:"},
  idle    : {icon:xvt,        color:void 0,       ariaLabel:"idle:"},
  failed  : {icon:xvt,        color:"error",      ariaLabel:"error:"},
};
```

要点：
- **`icon` 的表里，`working`/`needsYou`/`idle`/`failed` 四个共用同一个字形 `xvt`（`•`），
  区分全靠 `color`。** 也就是说**彩色终端下状态靠颜色，不靠形状**；
  形状只在无色终端才分化（见下）。
- **`ariaLabel` 和视觉分开**：`✓` 念作 "done:"、`✘` 念作 "failed:"、
  `⚠` 念作 "warning:"、`•` 念作 "idle:"。屏幕阅读器听到的和眼睛看到的不是同一套词汇。
  `slot==="trailing"` 时把 `idle:` 削成 `idle`（`xy(t.ariaLabel,":")`）——
  **句末不念冒号**。

### 4.2 无色终端的第二张表

```js
var I = { working:"•", needsYou:"!", idle:"\u25E6", failed:"\xD7" };   // • ! ◦ ×
```

```js
let g = he.level>=2 && subtle!==null && inactive!==null;
const k = g ? xvt : I[i];       // 有彩色 → 统一 •；无彩色 → 分化的 ASCII 近似
```

**这是本次最重要的设计。** `needsYou` 在无色模式下变成 `!`——一个**语义直给的形状**，
不需要颜色也能一眼看出「它在等你」。`idle` 是空心小圆 `◦`，`failed` 是 `×`。
换句话说：**颜色被剥夺时，状态信息不能跟着消失，必须换一个维度重新编码。**

### 4.3 「我在干活」：旋转器

旋转器的状态枚举（`switch(d.kind)` 原文）：

| kind | 文案 | 颜色 |
|---|---|---|
| `thinking` | 渐进式标签：`thinking` → 兜底 `deep in thought` / `thinking some more` / `thinking more` / `still thinking` | 随强度渐变到 `warning` |
| `tool-running` | `running tool for ${ln(ms)}` | — |
| `tool-done` | `ran tool for ${ln(ms)}` | dim |
| `thought-for` | `thought for ${Xn(ms)}` | — |
| `recovering` | `to(recovery)` | — |
| `none` | `null`（什么都不画） | — |

旋转帧（`vHe()` 原文，6 帧）：`["\xB7","\u2722","\u2733","\u2736","\u273B","\u273B"]`
（`· ✢ ✳ ✶ ✻ ✻`），
ghostty 终端用另一套 `["\xB7","✢","✳","✶","✻","✽"]`，
无 Unicode 终端用 `["\xB7","\u2722","*","\u2736","\u273B","\u273D"]` ——
**UI 里 `✻` 是主体，`*` 是它的 ASCII 替身**。
所有帧都包在 `{"aria-hidden":!0, flexWrap:"wrap", height:1, width:2}` 里
——**宽度锁 2 列，高度锁 1 行，屏幕阅读器忽略**。旋转器不会因为帧宽变化而抖。

思考的「闪」是颜色插值不是换字：`io={153,153,153}` → `so={185,185,185}`，
余弦缓动 3 秒周期（`Qe=3000, ao=2`）；
`reducedMotion` 打开时整段跳过，退化成静态 `●` + 余弦明暗（周期 2s）。
**卡住时**：`{"Waiting for API response"}`（error 色）+ dim 的
` · will retry in Ns · check your network`；低优先级等待是
warning 色的星 + ` · next try in Ns · attempt N · esc to interrupt`。

### 4.4 「我在等你」：模态与页脚

- 权限询问正文固定一句 `Do you want to proceed?`（唯一的 yes/no 问句模板）。
- 三种权限模式的横幅是**一张 4 行表**（原文 @284,456,6xx）：

```js
var X=[{label:"default",       symbol:"",      color:"text"},
       {label:"accept edits on", symbol:Ovt,   color:"autoAccept"},   // ⏵⏵ 洋红
       {label:"plan mode on",   symbol:ORe,   color:"planMode"},     // ⏸ 青
       {label:"auto mode on",   symbol:Ovt,   color:"warning"}];     // ⏵⏵ 黄
```

  模式切换时有个 1400ms 的彩屑动画（`L=16` 行 × `Pe=100` 列，
  `Q=1400`，`reducedMotion` 时跳过）——**只在状态转换的瞬间庆祝，不停留在常态**。
- 页脚提示是**按优先级降级**的（见 4.6），且 `showHint` 只在特定条件下为真：
  看 teammate 时提示 `esc`/`return to team lead`；加载中提示 `esc`/`interrupt`；
  否则提示 `shift+tab`/`cycle`。

### 4.5 「我出错了」

分两条不同的通道，注意别混：

- **`cSe.failed` 的图标是 `xvt`（`•`），颜色 `error`，`ariaLabel:"error:"`。**
  彩色终端下，一个错误行和 idle 行**形状完全一样**，只有颜色不同。
  但它在**无色**终端下换成 `I.failed = "×"`——形状只在失去颜色时才承载信息。
- **旋转器/重试通道**用 `eA`（`✻`）配 `color:"error"`：
  `e(n,{color:"error",children:eA})` ——「卡住」不是画一个叉，
  而是**同一颗星换成错误色**（@272,616,6xx 的 `stalled` 分支）。
  理由推测：同一位置换色比换形更少视觉噪声（**推测**，未找到注释）。
- **任务行里的 `failed` 是第三种**：`lo("failed")` 返回 `{glyph:te.cross, color:"error"}`，
  即 `✘`（U+2718）。所以**同一个「失败」在三个通道里有三种画法**：
  消息状态 `•`+红、旋转器 `✻`+红、任务行 `✘`+红。
  这一点如果照抄要特别小心——它不是统一的，是历史分层的。
- 权限模式的 `bypassPermissions` 用 `error` 色渲染（`N==="bypassPermissions"?"error":void 0`）
  ——**最危险的模式用最刺眼的颜色**，而它不在那张 4 行表里（走的是 `default` 那一行的
  降级路径）。

### 4.6 「没有异常」——它怎么处理

这是任务里问得最尖锐的一条。答案分四层：

1. **不画空态。** 页脚里的背景任务计数、工件计数，都是
   `if(x>0){ …push({key:"background", …}) }` —— 为 0 时**这一项根本不存在**，
   不是显示 "0 bg"。工件同理 `if(ee!==null)`。
2. **`needsYou` 是布尔聚合，全健康即 `false`。**
   `Dt = Q2e!==null && Object.values(Te).some(ro => qbe(ro) && Q2e.backgroundTaskDot(ro)==="needsYou")`
   ——只有**至少一个任务**需要你时才为真。
3. **旋转器是唯一常驻的活动指示，而它随本轮结束消失。**
   `kind==="none"` 时返回 `null`；`if(!T&&A===null&&p) return <Zt tone:"dim" …/>`
   ——压缩提示也是一行 dim，不是面板。
4. **页脚自己会瘦身。** 宽度不够时按优先级阶梯砍项（下一条）。

**合起来就是「安静」。** 一个健康会话静止时，屏幕上只有：对话、一条提示框横线、
一行页脚（模式名 + `? for shortcuts`）。没有任何「系统运行正常」的灯。

### 4.7 页脚优先级阶梯（原文，值得整段抄）

```js
function t4t({pill:h, sparse:x, dense:D, hint:N, width:ee}){
  if(N!==null){ let be=[...D,h,N].filter(y=>y!==null);
                if(CA(be)<=ee) return be; }           // ① 完整 + 提示
  let ne = [[...x,h],                                 // ② 稀疏 + 模式
            [...D,h],                                 // ③ 完整 + 模式
            ...(h===null?[]:
               [D.filter(be=>be.key!=="artifacts").concat(h),  // ④ 砍工件
                [h]])]                                // ⑤ 只剩模式
           ].map(be=>be.filter(y=>y!==null));
  return ne.find(be=>CA(be)<=ee) ?? (h===null?ne[0]:ne.at(-1)) ?? [];
}
```

即：**准备 5 套布局，从信息最全到最简，第一套装得下的赢；一套都装不下就退到最后一套
（宁可溢出也不显示空）**。`CA()` 负责把 `" · "` 分隔符也算进宽度。
**这是「窄终端」的正解——不是省略号，是换布局。**

### 4.8 另外三处状态技巧

- **OSC 9;4 进度序列**（`terminalProgressBarEnabled`，默认需 opt-in）：
  「Emit OSC 9;4 progress sequences during long operations」——
  **把进度推给终端自己的标签页/任务栏，而不是在界面里再画一根进度条。**
  权限白名单也印证：hook 只能发 `OSC 0/1/2/9/99/777 和 BEL`，
  且「OSC 9 的 body 不得以数字开头，除非是 9;4 进度形式」。
- **轮次耗时标签用确定性动词**：`bg=["Baked","Brewed","Churned","Cogitated",
  "Cooked","Crunched","Sautéed","Worked"]`，
  `Rg(m) = bg[hash(m)>>>0 % 8] ?? "Worked"` ——
  **同一条消息永远同一个动词**（可复现），不是随机。
  默认关（`showTurnDuration`），文案是 `Cooked for 2m 5s`。
- **旋转器动词约 100 个**，按字母序排（`Baking`…`Zigzagging`），
  含 `Sautéing`、`Tomfoolering`、`Topsy-turvying`、`Whatchamacalliting`。
  这是「等的时候给一点人格」，成本极低。

### 4.9 第二张状态表：任务/代理的 8 态（对 Overwatch 最直接相关）

后台任务另有一张表，比 `cSe` 更接近我们关心的语义（@279,949,143 原文）：

```js
function Pt(o,l){
  if(o.state==="done") return "done";
  if(o.state==="error"){ if(o.skipped) return "skipped";
                         if(o.blocked) return "blocked";
                         return "failed"; }
  if(!l) return "interrupted";
  return o.queuedAt!=null && o.startedAt==null ? "queued" : "running";
}
function lo(o){ switch(o){
  case "done"        : return {glyph:te.tick,  color:"success"};     // ✔
  case "failed"      : return {glyph:te.cross, color:"error"};       // ✘
  case "skipped"     : return {glyph:te.cross, color:"subtle"};      // ✘ 但弱化
  case "blocked"     : return {glyph:te.cross, color:"permission"};  // ✘ 但蓝色
  case "queued":
  case "interrupted" : return {glyph:PKr,      color:"subtle"};      // ◌
  case "running"     : return {glyph:So,       color:"subtle"};      // ●
}}
var Jt=["all","running","queued","failed","done","skipped","blocked","interrupted"];
```

**三条可以直接搬的做法**：

1. **`failed` / `skipped` / `blocked` 三个都是 `✘`，靠颜色区分**——
   `failed` 红、`skipped` 灰、`blocked` 蓝。**「被挡住」不是「出错」，
   所以不给它红色。** 这与 Overwatch 的 `BLOCKED` 语义完全对得上：
   它是「等人」，不是「坏了」。
2. **状态是从 (state, skipped, blocked, 是否仍在跑, 有无 queuedAt/startedAt)
   推导出来的，不是存储的**。派生函数 `Pt()` 是唯一入口，界面只认 8 个词。
   这避免了「同一个状态在不同地方叫不同名字」。
3. **`interrupted` 是一个独立状态，不和 `failed` 合并**——
   `if(!l) return "interrupted"`（l = 是否仍在管理中存在）。
   中断是「人叫停的」，失败是「系统坏了」，两者用户要做的事完全不同。

再叠一层：整批任务的概览是**一句话**而不是一堆图标：

```js
["<b>", tasks.length, "</b> tasks (",
 "<b>", G, "</b> done, ",
 q>0 && ["<b>", q, "</b> in progress, "],
 "<b>", D, "</b> open)"]
// 渲染成：5 tasks (2 done, 1 in progress, 2 open)
```

且**只有 `in progress > 0` 时才出现那一段**（`q>0&&[...]`）——
又是「正常就不说」。

---

## 五、中文 / 宽字符处理

### 5.1 宽度怎么算

**主力**：`Bun.stringWidth(s, {ambiguousIsNarrow:true})`，
外面包一层模块导出 `ae`（@245,848,744，整个模块只有 3 行）：

```js
var n={ambiguousIsNarrow:!0};
function ae(t){ return Bun.stringWidth(t,n); }
```

`ambiguousIsNarrow:true` = **East Asian Ambiguous 按 1 列算**。
这意味着 `→ ← ★ ✓ ●` 这类字符在 CJK 环境下有的终端画 2 列，
它按 1 列算——**会有一格错位**。这是一个明确的取舍：宁可对不齐，
也不要为了少数终端全局多留格子。**这是它对这个问题的答案：接受不确定性，不追求完美对齐。**

**第二套宽度函数**（在 markdown/代理文本层，@261,582,265）用 `ambiguousIsNarrow:false`，
并补了三条：

```js
var VC="[unreadable text]", qC=[VC,"[unreadable]","[?]"],
    XC=/^[\p{M}\p{Cc}\p{Cf}]?$/u,      // 只有组合记号/控制符/格式符的片段
    Qb={ambiguousIsNarrow:!1},
    QC=/[\p{Cn}\p{Emoji}]/u;            // 未分配码位 + Emoji
function Hr(n){ let u=0;
  for(let f of n){ let m=f.codePointAt(0)??0;
    u += m>127 && QC.test(f) ? 2 : Math.max(1, Bun.stringWidth(m>=55296&&m<=57343?"\uFFFD":f, Qb)); }
  return Math.max(u, Bun.stringWidth(n,Qb)); }   // ← 取较大值
```

- **未分配码位（`\p{Cn}`）和 Emoji 一律按 2 列**，不管 Bun 怎么说；
- **孤立代理项先替换成 `\uFFFD` 再量**（`m>=55296 && m<=57343`）；
- **每字符至少 1 列**（`Math.max(1, …)`）——组合记号不占 0 列；
- 最后与整串度量取 `max`。**四重保险，方向一致：宁宽勿窄。**

**单元格级**：`Bun.ant.CellSegmenter({ambiguousIsNarrow:true, substitute, screen})`
（@253,533,418）。这是 Anthropic 私有 Bun 补丁提供的 API，把一行切成
cell + style-run，内部有 `narrow / wide / spacerTail / spacerHead / empty` 等掩码概念
（错误文案里泄漏的字段名：`widthMask`、`narrow`、`wide`、`spacerTail`、
`spacerHead`、`emptyCharIndex`、`spacerCharIndex`、`emptyWord`、`tabWidth`、
`screenWidth`、`cells`、`order`、`charMap`、`runWord`、`paint`）。
`Bun.ant.CellSegmenter` 不存在时**直接抛错**：

> "This runtime has no Bun.ant.CellSegmenter. Run Claude Code on the
> @anthropic-ai/bun-internal version pinned in package.json."

——**不降级，硬失败**。理由推测：宽字符切错会整屏错位，不如启动就报（**推测**）。

**wcwidth 风格的兜底表**（`CDs()` 里，@253,530,7xx）：

```js
function B(e){ return e===12288 || e>=65281&&e<=65376 || e>=65504&&e<=65510; }
function E(e){ return e>=4352&&e<=4447 || … /* 一大串东亚宽 + Emoji 区间 */ 
                    || e>=131072&&e<=196605 || e>=196608&&e<=262141; }  // CJK 扩展 B..F
function h(e){ return Number.isInteger(e) && (B(e)||E(e)); }
```

区间覆盖：`12288`（全角空格）、`65281–65376`（全角 ASCII 变体 + 半角片假名之外的）、
`65504–65510`（全角符号）、`4352–4447`（Jamo）、`11904–…`（CJK 部首/汉字）、
`44032–55203`（Hangul 音节）、`131072–262141`（CJK 扩展 B–F）。

### 5.2 截断怎么保证不切坏宽字符

**三重保证**：

1. **先按 grapheme 切**：`Na() = new Intl.Segmenter(undefined,{granularity:"grapheme"})`。
   所有截断函数（`ft` / `V0` / `rG`）都是
   `for(const {segment:r} of Na().segment(e)) { 累加 ae(r); 超了就 break }`
   ——**以字素簇为最小单位**，emoji 的 ZWJ 序列、CJK 后面的变体选择符都不会被劈开。
2. **再按列宽回退**：`Nr()` 用 `Bun.sliceAnsi` 切完还要
   `while(f>u && ae(m)>f-u) f--` ——ANSI 序列透明、宽字符边界回退。
3. **ANSI 感知**：`CDs()` 逐码位分类为 `{type:"ansi",code,endCode}` 或
   `{type:"char",value,fullWidth}`，累计列数到 `t` 截止。

### 5.3 CJK 排版（换行 / 加空格）

- **脚本分类**：`\p{Script=Han}` / `Hiragana` / `Katakana` / `Hangul` / `Thai` /
  `Lao` / `Khmer` / `Myanmar`（另有带 `Tibetan` 的变体）。用途在 markdown 渲染层：
  `glueProse`（粘连散文）——**决定两个 token 之间要不要插空格**。
  汉字之间不插空格，汉字与拉丁之间按需插。
- **`Katakana` 额外带上 `\u30fc`（长音符）和 `\uff70`（半角长音符）**，
  否则「データ」会被当成三个不同类别。
- **阿拉伯/希伯来/叙利亚文**有专门分支：`\p{Script=Arabic|Hebrew|Syriac|Thaana|Nko|…}`
  用于决定 `ZWJ`/`ZWNJ`/`RTL mark`（8206/8207）是否「有意义的不可见字符」——
  在粘贴净化时**保留**它们，而在其它语境下删掉。
- **粘贴净化**：`Removed N invisible characters`。被移除的类别是
  `\p{Cf}`（格式符）/ `\p{Cs}`（代理）/ `\p{Zl}` / `\p{Zp}` / `\p{Variation_Selector}`；
  但 `\u200C\u200D\uFE0E\uFE0F` 在特定前文下会**保留**（`EWo = new Set([8204,8205,65038,65039])`）。
  还有 `\p{Script=Khmer|Thai|Lao|Myanmar}` 这类「组合记号密集的文字」的 16 位环形缓冲
  （`ring:Array(16).fill(0)`）来判断一个 `ZWSP` 是否必要——
  **这是我能找到的最复杂的一段 CJK/东南亚文字逻辑。**
- **换行**：`wrap` 系列用 `hard:true` 强制按列硬换行（CJK 没有空格可断），
  与西文的「按空格断 + 超长词硬断」是两条路径（`Qc(n,u,{trim,hard})`）。
  代码里未找到 kinsoku（禁则处理）实现——**这是一个明确的缺口**。

### 5.4 一个具体例子：会话名

`truncateStartToWidth` + `truncatePathMiddle` 都是**为 CJK 场景准备的**：
中文标题往往前几个字就足以辨识，但结尾的扩展名/路径段才关键。
`Kd(e,t)`（路径截断）原文：

```js
function Kd(e,t){ if(ae(e)<=t) return e;
  if(t<=0) return "\u2026"; if(t<5) return ft(e,t);
  let n=e.lastIndexOf("/"), s=n>=0?n:e.lastIndexOf("\\"),
      r=s>=0?e.slice(s):e, u=s>=0?e.slice(0,s):"", o=ae(r);
  if(o>=t-1) return V0(e,t);            // 文件名本身太长 → 改截开头（保留尾部）
  let l=t-1-o; return rG(u,l)+"\u2026"+r; }   // 否则截目录、留文件名
```

**优先级：文件名 > 目录名。** 留不下文件名时改留**尾部**（`V0`），
因为扩展名/文件尾比路径头更有辨识度。

---

## 六、降级策略

| 场景 | 行为 | 证据 |
|---|---|---|
| 非 TTY（管道/重定向） | 进 print 模式（`Art()` = `-p`/`--print`/`--sdk-url`/`!stdout.isTTY`）；布局改用 `setWidthAuto()`，量完再 clamp 到 `Ys=8192` | @126,1xx；@261,632,048 |
| 拿不到终端宽度 | `Math.floor(n)`，非有限/<1 → **兜底 80 列**；> `zv=8192` 列或 > `Fv=2048` 行 → **clamp 到上限**；两条路径都打日志（"garbage dimension" / "absurd dimension"） | `js()` @261,620,295 |
| 无色（`he.level===0`） | 页脚不用颜色改用**反显**（`{inverse:!0}`）；状态图标切 ASCII 表 `I`；`dim()` 退化 | `sN()` @280,831,627；`I` 表 @265,545,469 |
| 只有 16/256 色（level 1–2） | `shimmer` 关闭（`he.level>=2` 才启用）；图片协议要求 `level>=2`，真彩才给宽 ID | @265,546,8xx；`Ee={indexed:2,truecolor:3}` |
| `TERM=dumb` | 颜色深度退到环境猜测值（`if(s.TERM==="dumb") return i`），不硬编码 0 | `X()` @246,952,605 |
| `NO_COLOR` / `FORCE_COLOR` | 标准 precedence：`FORCE_COLOR` 覆盖 `NO_COLOR`；`NO_COLOR` 非空即禁用；`--no-color`/`--color=never` 等参数优先 | 同上 |
| CI 环境 | `GITHUB_ACTIONS`/`GITEA_ACTIONS`/`CIRCLECI` → 3（真彩）；`TRAVIS`/`APPVEYOR`/`GITLAB_CI`/`BUILDKITE`/`DRONE` → 1 | 同上 |
| Windows 老系统 | 按 `os.release()` 判断：build ≥ 14931 → 真彩，≥ 10586 → 256 色，否则 16 色 | 同上 |
| 无 Unicode 终端 | 图标表切 ASCII；旋转帧用 `["·","✢","*","✶","✻","✽"]`；框线仍用 `─`（`a6="\u2500"`） | `r()`/`gnv` @253,705,600 |
| 窄终端 | 页脚 5 套布局阶梯（4.7）；旋转器文案 `Math.max(10, columns-2-w-2)`；工具行 `Math.max(15, width-15)` | `t4t()`/`t4t` @280,8xx |
| 减少动效 | `prefersReducedMotion` 设置 + 探测；旋转器退化成静态 `●` + 2s 余弦明暗；彩屑/提示闪全关 | `cpe()` @266,169,318 |
| 屏幕阅读器 | `CLAUDE_CODE_ACCESSIBILITY` / `CLAUDE_AX_SCREEN_READER`；装饰图标 `aria-hidden`，语义 `aria-label`；另有线性化渲染 `renderNodeToScreenReaderOutput` | @128,006,166；@261,612,375 |
| 全屏启动反复失败 | **自动关掉 fullscreen**，下次启动回 classic，并提示 `/tui fullscreen` 可重试 | `crash_auto_off` @126,767,481 |
| 终端能力未知 | 开机探测：`DECRQM 2026`（同步刷新）、`DECRPM 1016`（像素鼠标）、`XTVERSION`、`DECSTBM`，结果写进 `caps` 并随 attach 传来；探测不到就不启用对应特性 | `fr()` @261,703,344 |
| 一键关特性（逃生舱） | `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` / `_DISABLE_MOUSE` / `_DISABLE_MOUSE_CLICKS` / `_DISABLE_VIRTUAL_SCROLL` / `_NO_FLICKER` / `_DECSTBM` / `_NATIVE_CURSOR` | @245,954,738 |
| 终端报的尺寸荒谬 | 不是崩，是 **clamp + 记日志**（"falling back to 80" / "clamping to 8192"） | `js()` |

**值得注意的两条**：
1. **「荒谬尺寸」是被当正常情况处理的**。不是在边界做断言，而是
   `clamp` 之后继续跑，把异常降级成一条日志。UI 永不因为终端撒谎而白屏。
2. **能力探测结果会被序列化传给别人**。`caps` 对象里含 `colorLevel`、
   `syncOutput`、`systemTheme`、`mux`、`hyperlinks`、`progressReporting`、
   `printsUnknownSequences`、`keyDialect`、`browser`、`tmuxSocket`…
   后台会话被 attach 时，这些 caps 会先送过来，**再用对方的配色渲染一帧缓存画面**
   （`pt(transcript, cols, rows, {colorLevel: caps.colorLevel, theme: caps.systemTheme})`）
   ——attach 的瞬间不会闪一下错色。

---

## 七、最值得抄的 3 个（以及 3 个次选）

### 首选 1：状态单表 + 无色降级表（`cSe` + `I`）

一张 `status → (icon, color, ariaLabel)` 表是唯一真相；
另有一张 4 项 `{working:"•", needsYou:"!", idle:"◦", failed:"×"}` 供无色终端使用。
**收益**：状态语义只有一个定义点；加状态时自然强迫你想清楚三件事——形状、颜色、
读屏念法。**对我们的直接意义**：Overwatch 的 `FAILED` / `BLOCKED` / 其它
如果走同一张表，就不会出现「每个面板各自画一套图标」的漂移。

### 首选 2：溢出必须可数披露，不许静默截断

`… (+141 chars NOT SHOWN)` / `(+12 more lines)` / `[42 lines elided]` /
`Removed 3 invisible characters`。**收益**：读者永远知道「这里少了东西、少了多少」，
不会把删节误读成完整。**这是一条纪律，不是技术。** 成本极低（一个模板串），
收益是可信度。

### 首选 3：页脚优先级阶梯（`t4t`）+ 宽度锁定装饰

窄屏不是「省略号」，是**换一套布局**：准备 5 套从全到简的项组合，第一套装得下的赢。
配合旋转器的 `{height:1, width:2, aria-hidden}` 宽度锁定——
**动画不会引起重排**。**收益**：窄终端下信息密度自动最优，且永不抖动。

### 次选（同样值得记）

- **shimmer 孪生色**：每个语义色预置一个约 +30 亮度的孪生色，
  动画 = 余弦插值 + 单字符上色。不需要动画库，也不引起重排。
- **`ariaLabel` 与视觉分离**：`✓`→"done:"、`•`→"idle:"，
  且尾随位去掉冒号。读屏体验是设计的一部分，不是事后补的。
- **确定性动词哈希**：`bg[hash(msg) % 8]` 而非随机——
  「Cooked for 2m 5s」同一条消息永远同一个词，重绘不跳变。

---

## 八、证据附录（字节偏移，可在同一构建上复现）

> 偏移针对 2.1.308 这一份构建（SHA-256 见文首）。换版本必然失效。

| 偏移 | 内容 |
|---|---|
| 245,030,106 | 第一处 `// Claude Code is a Beta product…` license header（JS 明文区起点附近） |
| 293,288,753 | 最后一处 `// @bun @bytecode`（JS 明文区终点） |
| 252,620,715 | `var U={autoAccept:"rgb(135,0,255)", …}` 调色板起点 |
| 252,630,316 | `var p={autoAccept:"rgb(175,135,255)", …}`（**dark 默认**，`text:"rgb(255,255,255)"`） |
| 252,632,790 | `var P={…}`（dark-daltonized） |
| 252,635,xxx | `function TW(r){switch(r){case"light":return U; case"light-ansi":return I; case"dark-ansi":return x; case"light-daltonized":return W; case"dark-daltonized":return P; default:return p}}` |
| 245,958,473 | 字形常量块：`$t=I()==="macos"?"\u23FA":"\u25CF"`、`eA="\u273B"`、`Qti="\u23BF"`、`ORe="\u23F8"`、`Ovt="\u23F5\u23F5"`、`a6="\u2500"`、`iYo="\u2503"`、`gb={branch:"\u251C",last:"\u2514",pipe:"\u2502"}`、`fm=[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]` |
| 248,970,9xx | boxen 风格边框表：`single`/`double`/`round`/`bold`/`singleDouble`/`doubleSingle`/`classic`/`arrow` + `dashed`/`quote` |
| 253,530,7xx | `B(e)`/`E(e)`/`h(e)` 全角判定表；`CDs()` ANSI 感知切分 |
| 253,533,418 | `OGn()` = `new Bun.ant.CellSegmenter({ambiguousIsNarrow:!0, substitute, screen})` |
| 245,848,744 | `var n={ambiguousIsNarrow:!0}; function ae(t){return Bun.stringWidth(t,n)}` |
| 261,582,265 | `Hr()` 第二套宽度函数（`ambiguousIsNarrow:!1` + Cn/Emoji 记 2 列 + 取 max） |
| 261,582,229 | `qC=[VC,"[unreadable]","[?]"]`、`XC=/^[\p{M}\p{Cc}\p{Cf}]?$/u`、`QC=/[\p{Cn}\p{Emoji}]/u` |
| 265,545,469 | `var cSe={success:…, needsYou:{icon:xvt,color:"warning",ariaLabel:"needs you:"}, …}` 与 `I={working:"•",needsYou:"!",idle:"◦",failed:"×"}` |
| 265,546,300 | 状态徽章渲染：`const k=g?xvt:I[i]`（`g = he.level>=2 && subtle && inactive`） |
| 280,853,991 | 页脚：`Dt=Z(()=>…some(ro=>…backgroundTaskDot(ro)==="needsYou"))`、`xo={backgroundCount,needsYou,frameCount,activeFrameName,colorless:he.level===0}` |
| 280,831,627 | `pfe=ae(" \xB7 ")`、`sN(h,x,D)`（`colorless → {inverse:!0}`）、`t4t` 调用点、`CA()` 求和 |
| 280,8xx | `t4t({pill,sparse,dense,hint,width})` 5 套布局阶梯 |
| 265,472,061 | 旋转帧：`l=["\xB7","\u2722","\u2733","\u2736","\u273B","\u273B"]`、`p=[…"*"…]`、`vHe()/KRn()`；`bA(r)=Math.round(r*8)/8`；`kHe(r,t)=(1-cos(2πr/t))/2` |
| 265,470,800 | 旋转器 hooks：`let a=800`（tip 间隔）、`Q6(…,t=a)` 去抖 |
| 266,169,318 | `var LCt="\u25CF",M=2000,P={r:171,g:43,b:63}`；`cpe()` reducedMotion 分支 |
| 272,610,500 | 旋转器逻辑：`d.kind` switch、`io={r:153,g:153,b:153}`→`so={r:185,g:185,b:185}`、`Qe=3000,ao=2` |
| 127,562,000 | 思考标签与等待文案：`deep in thought` / `thinking some more` / `thinking more` / `still thinking` / `thought for ` / `Waiting for API response` / ` · esc to interrupt` |
| 128,001,900 | 旋转器动词表（`Baking`…`Zigzagging`，约 100 词） |
| 127,414,592 | `bg=["Baked","Brewed","Churned","Cogitated","Cooked","Crunched","Saut\xE9ed","Worked"]`，`_O="Worked"` |
| 284,456,682 | 模式表 `X=[{label:"default",symbol:"",color:"text"},{label:"accept edits on",symbol:Ovt,color:"autoAccept"},{label:"plan mode on",symbol:ORe,color:"planMode"},{label:"auto mode on",symbol:Ovt,color:"warning"}]` + 彩屑参数 `G=80,ze=60,Q=1400,L=16,Ke=60,Pe=100` |
| 261,457,846 | `calculateLayout(n,u,f){…}` 自研布局引擎 |
| 261,449,000 | `class ul{…}`：`insertChild`/`setMeasureFunc`/`getComputed*`/`_cIn/_cOut` 缓存；`var ex=ny()` config |
| 261,632,048 | `calculateYogaLayout(n)`：TTY 用 `columns`，非 TTY `setWidthAuto()` 后 clamp 到 `Ys=8192` |
| 261,620,295 | `js()` winsize 校验；`sAn()` = `{cols: js(n.columns, 80, 8192, "clamp"), rows: js(n.rows, 24, 2048, "clamp")}` |
| 261,482,690 | `pSe="\u2026"`、`Nr()`、`u6t()`、`Uy()`、`Jx()` 截断全家桶；`var pSe` |
| 246,436,445 | `Kd()` 路径截断、`ft()`/`V0()`/`rG()` 字素级截断、`Ue=8,ze=40` |
| 246,421,667 | `Na()` = `new Intl.Segmenter(void 0,{granularity:"grapheme"})` |
| 246,115,398 | `Rl(e,n)` = `${e.slice(0,n)}\u2026 (+${…} chars NOT SHOWN)`；`rl=64,wh=160,Ch=400,Ph=256,sl=180,il=60` |
| 279,944,625 | 面板/工具行数上限：`var Rn=3,_n=100,Cl=12,Tl=6`；任务面板裁剪文案 `… +${N} in progress, ${N} pending, ${N} completed` |
| 127,467,885 | `(+${N} more lines)` |
| 133,766,672 | `Removed 1 invisible character` / `… invisible characters` / ` · review and press … to send` |
| 126,667,250 | `1 idle agent` / ` idle agents!`；`adminTierEnvView` 附近 |
| 127,429,112 | `Waiting for ` / ` to finish` / ` · done ` / ` still running` / `hidden (/focus to show)` / `dynamic workflows` |
| 128,032,213 | 渲染器内部字段：`pendingClears`/`damage`/`clip`/`skipSelfBlit`/`absolutePaintCut`/`stringWidth`/`packSoftWrap: start column` |
| 128,011,308 | 终端指令名表：`DECSTBM`/`SCOSC`/`SCORC`/`DECSCUSR`/`ECH`/`IL`/`ICH`/`DCH`/`CUU`/`CUP`/`HVP` |
| 128,045,704 | 能力探测日志：`probe: DECRPM 1016`、`DECRQM 2026 not asked`、`XTVERSION not replied`、`DECSTBM:` |
| 261,703,344 | `fr()` 返回 caps：`imark/terminal/mux/ssh/wheelFlood/hyperlinks/progressReporting/printsUnknownSequences/wtSession/isVscodeTerm/keyDialect/browser/colorLevel/syncOutput/editor/systemTheme/tmuxSocket` |
| 126,767,481 | `/tui fullscreen` 文案与 `crash_auto_off`（"fullscreen was turned off on this machine after it repeatedly failed to start"） |
| 245,954,738 | 环境变量白名单：`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` / `_DISABLE_MOUSE` / `_NO_FLICKER` / `_NATIVE_CURSOR` / `CLAUDE_AX_SCREEN_READER` / `CLAUDE_CODE_ACCESSIBILITY` |
| 246,952,605 | 颜色深度探测：`FORCE_COLOR` → `NO_COLOR` → `TERM=dumb` → win32 build → CI 名单 |
| 253,705,600 | `r()` Unicode 支持探测（与原始 `figures` 的 `isUnicodeSupported` 是同一思路的内联版本） |
| 253,711,435 | Unicode 图标表 `f={tick:"\u2714", …}` 与 ASCII 表 `h={tick:"\u221A", …}` |
| 245,539,768 | 内部环境变量表：`CLAUDE_AX_ANNOUNCEMENT_HOLD_MS` / `CLAUDE_AX_PREPARK_MS` / `CLAUDE_AX_SCREEN_READER` / `CLAUDE_CODE_ACCESSIBILITY` |
| 246,065,421 | 设置项说明：`Show "Cooked for Nm Ns" after each assistant turn`、`Emit OSC 9;4 progress sequences during long operations`、`Enable the todo / task tracking panel` |
| 132,401,507 | hook terminalSequence 白名单：`OSC 0/1/2/9/99/777 和 BEL`，`OSC 9 不得以数字开头，除非 9;4 进度形式` |
| 127,179,660 | 模式横幅：`accept edits on` / `plan mode on` / `auto mode on` |
| 261,296,772 | 帧节拍常量：`var Zg=16,Sds=50,wds=4,vds=16384,Keo=250`（`Sds=50` 与 `Keo=250` 未定位用途） |
| 261,298,948 | tick 使用者：`T=Zg*2`、`t.setTickInterval(n?Zg:T)`（`hc()` = 终端聚焦，失焦降频到 32 ms） |

复现方法（不执行目标）：

```js
const fs = require("node:fs");
const b = fs.readFileSync(path, "latin1");          // 整体读入
const s = b.slice(offset - 400, offset + 400);      // 定点切片
for (const ch of s) process.stdout.write(
  ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127 ? ch : "·");
// UTF-16LE 区域改用 Buffer.toString("utf16le")
```

---

## 九、挖不到 / 不确定 / 明确缺口

**能力层面的限制**
1. **没有反汇编。** rea 的四个原生 provider 全不可用，本机也没有 `strings` 命令
   （Git Bash 环境缺 binutils）。所以「它为什么这么写」只能从源码读，
   不能从编译产物反推（例如：那个 JS flexbox 是否由 C++ Yoga 转译而来，无法判断）。
2. **没有运行目标**（任务要求静态分析），所以像素级效果、真终端下的观感、
   色差、帧率都无法实测。所有「看起来如何」的判断都来自源码参数，未经目视验证。

**具体没挖到的点**
3. `Bun.ant.CellSegmenter` 的实现不在 JS 侧（在 Bun 运行时里、闭源补丁），
   只能看到它的字段名与错误文案。它对 CJK/emoji 的实际切分行为**未验证**。
4. 旋转器帧间隔没能确定。`qn`（在 `let J = l==="requesting" ? 50 : qn` 处）
   是跨 chunk 导入的符号，同一 chunk 里还有多个同名 `qn`（分别是
   micromark 版本号、hook 映射表、promise 工具），**无法唯一定位**。
   只确证了全局 tick = 16 ms（`Zg=16`，终端聚焦时；失焦时 `Zg*2`=32 ms）
   这一条，以及旋转器另有自己的间隔变量（`l==="requesting"?50:qn`），
   两者关系未能确认。
5. **没有 kinsoku（禁则处理）。** 搜遍 `kinsoku` / `lineBreak` / `breakOpportunity`
   均无实现。CJK 换行靠「按列硬断」，意味着**行首可能出现 `，` `。` `）`**。
   这是一个真实的排版缺陷，未找到补偿逻辑。
6. **`ambiguousIsNarrow:true` 会导致 CJK 环境下的对不齐**（见 5.1），
   且我在代码里**没有找到针对「终端在 CJK locale 下把 ambiguous 画 2 列」的探测或补偿**。
   推测作者接受这个不确定性（**推测**）。
7. 「`bypassPermissions` 用 error 色」的实现确认了，但为什么它不进那张 4 行模式表
   （而是走 `default` 行的降级路径），只有调用点、没有注释，**原因未知**。
8. 「同一个『失败』在三条通道里有三种画法」（消息状态 `•`+红 / 旋转器 `✻`+红 /
   任务行 `✘`+红）：**只有代码，没有注释**。是分层演进还是刻意，无法判断。
9. 2.1.270 与 2.1.308 的差异没有逐条比对（时间预算），
   所以无法判断这些设计里哪些是**新加的**、哪些是**一贯的**。
   如果要做「设计演化」分析，需要两版对照，这值得单独一轮。

**给下一轮的建议**
- 若要补「实际观感」，需要**运行**目标（本次被禁止），或者找一台装了
  ghidra/hopper 的机器做反汇编，验证 JS flexbox 与 Yoga 的等价度。
- 若要做跨版本对照，只需跑 `diff` 两版的字符串区，
  重点看调色板值、字形常量表、状态表 `cSe` 是否有变化——这三处最稳定、
  也最能说明「设计意图是否改了」。
