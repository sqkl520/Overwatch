# Claude 桌面版 GUI 风格规格（逆向，供自建监控 UI 复刻）

> 状态：**Proposed / 逆向产物**。这不是设计推演，是从已安装产物的 CSS/JS 里量出来的数值。
> 目标：**照着这份规格就能重写出风格一致的界面，不需要再打开桌面版。**
> 抄风格，不抄代码。文中所有类名/token 名只是**取证坐标**（说明"从哪看到的"），
> 不是让你复用它们的实现。

## 0. 取证来源与可信度

| 代号 | 路径（`%ProgramFiles%` = `C:\Program Files`） | 可信度 |
|---|---|---|
| **[A]** | `%ProgramFiles%\WindowsApps\AnthropicPBC.Claude_3.6556.2.0_x64__fnn82j28hfe8t\app\resources\app.asar` → `.vite/renderer/main_window/assets/MainWindowPage-BjVtjJFx.css`（237 KB，Tailwind v4.3.3 + `@ant/cds`） | **精确**：这是桌面壳与 CDS 设计系统的编译产物 |
| **[B]** | `%ProgramFiles%\WindowsApps\Claude_2.19675.0.0_x64__pzs8sxrjxfjjc\app\resources\ion-dist\assets\v1\`（Web 应用本体，1.5 MB `c6a992d55-D4kZGt22.css` + 68 KB `shared-styles-DhpxeH1-.css` + 3599 个文件） | **精确**：这是 claude.ai 前端的离线副本，含侧边栏/对话/工具块的真实实现 |
| **[C]** | 同 [A] 的 `.vite/renderer/main_window/index.html`、`local_exec_consent/localExecConsent.html` | 精确（手写 CSS，非生成） |
| **[D]** | 同 [B] 的 `c4038fd41-D9LFIgjS.js`（Todo 组件）、`cc1aae219-BJqUj5_d.js`（TurnStatus/状态行）、`c4e63a189-B2GA0Xvg.js`（工具行） | 精确（渲染逻辑与类名原文） |

**关键事实**：主窗口 HTML 里写着 `<!-- this is the html for app title bar and error UI. everything else gets loaded from claude.ai -->`，而 [B] 是那份远程前端在磁盘上的完整副本。**两处独立来源互相印证**（例如侧边栏 288px、行高 32px 在两处一致），所以下面的数值不是猜的。

凡本文没给出的，都在 §9「未获取」里列了，**没有编造**。

---

## 1. 布局系统

### 1.1 主结构：悬浮侧边栏 + 单一内容栏

| 项 | 值 | 来源 |
|---|---|---|
| 侧边栏宽度 | **288px** | [A] `build__index.chunk-B7K6kkCQ.js` `{sidebarWidth:288,...}`；[B] `--df-sidebar-width:288px` |
| 侧边栏底色 | **亮色 `#ffffff` / 暗色 `#262626`**（`hsl(0 0% 14.9%)`）。base token 是 `--cds-gray-10` / `gray-850`，但 `.dframe-root .dframe-sidebar` 把它覆盖成 `white` / `--df-z2`。**所以侧边栏比页面底更亮/更浅，这是"浮起"的关键** | [B] `.dframe-root .dframe-sidebar{--df-sidebar-bg:white}` 与 `[data-mode=dark] … {--df-sidebar-bg:hsl(var(--df-z2))}` |
| 侧边栏定位 | `position:absolute`，**四边都内缩**：`top: calc(8px + chromeBarHeight)`，`left: 8px`，`bottom: 8px`，`width: 288px` | [B] `.dframe-sidebar` |
| 侧边栏圆角 | **8px**（`--df-radius-card`） | [B] `.dframe-sidebar{border-radius:var(--df-radius-card)}` |
| 侧边栏描边 | **1px** 外描边（不是 border，是 `box-shadow` 第 2 层） | [B] `--df-shadow-card`：`inset 0 0 0 0 transparent, 0 0 0 1px <6% 黑>, 0 4px 24px <4% 黑>` |
| 侧边栏与内容区之间 | **无缝**：不画分割线，靠侧边栏自己的圆角和投影"浮"在页面底色上 | [B] 同上；[A] `index.html` 的 `--boot-placeholder-seam` 是 `rgba(11,11,11,.1)` 只在首帧占位时用 |
| 窄窗口阈值 | **700px**：`window.innerWidth / zoom <= 700` 时侧边栏折叠 | [A] `narrowViewportMaxWidth:700` |
| 折叠后 | 侧边栏整体不显示，左上角留一个 28–32px 的圆形触发按钮，`left: 8px` | [B] `--df-collapsed-left:8px`、`--df-pill-size:28px/32px` |
| 对话栏宽度 | **`--chat-column-measure: 40rem`（640px）** 为默认；另有 `720px` 和 `850px` 两个变体（概览页用 850） | [B] `c6a992d55` 里 `[--chat-column-measure:40rem]` 等工具类 |
| 对话栏左右留白 | `--chat-gutter: 32px` 为默认；密集模式 0–16px | [B] `--chat-column-gutter-start/end` 的 fallback 链 |
| 顶栏高度 | **48px** | [B] `--df-header-h:48px`；`--df-chrome-bar-height:0px`（无 WCO 时）/`36px`（有） |

**复刻要点**：不要做"左侧固定栏 + 竖分割线"那种传统布局。Claude 的形态是
**页面底色 → 上面浮一张 8px 圆角的侧边栏卡片 → 右边一大片空白 + 居中 640px 的对话栏**。
这个"浮"的观感全部来自 `0 0 0 1px` 描边 + `0 4px 24px` 微投影 + 8px 四边留白。

### 1.2 侧边栏内部几何（两档密度）

侧边栏的**所有**尺寸都由 `--df-*` 变量驱动，通过 `[data-density]` 整体切换：

| 变量 | `data-density=compact`（默认） | `data-density=comfortable` |
|---|---|---|
| `--df-row-h` 行高 | **26px** | **32px** |
| `--df-row-ctl` 行内控件高 | 20px | 24px |
| `--df-row-px` 行左右内缩 | 2px | 2px |
| `--df-row-gap` | 4px | 8px |
| `--df-row-font` | 13px | 14px |
| `--df-group-font`（分组标题/描述） | 12px | 13px |
| `--df-icon-size` | 16px | 20px |
| `--df-leading-slot`（图标槽宽） | 24px | 28px |
| `--df-new-circle-size` / glyph | 18px / 13px | 22px / 16px |
| `--df-group-pt`（分组上间距） | 12px | 16px |
| `--df-radius-pill`（行圆角） | **6px** | **8px** |
| `--df-chrome-icon-size` | 16px | 16px |
| `--df-footer-btn-size` | 24px | 32px |
| `--df-footer-gap` | 3px | 6px |
| `--df-content-gutter` | 0px | 8px |

手机/触屏另有 `--df-row-h: 44px`、`--df-row-ctl: 36px` 一档（`[data-phone-sheet]`）。

来源：[B] `shared-styles-DhpxeH1-.css` `.dframe-root{...}` 与
`.dframe-sidebar[data-density=comfortable]{...}`。**桌面主窗口用的是 `comfortable`**
（[A] `index.html` 的 `<html data-density="comfortable">`）。

### 1.3 一条侧边栏行的结构（照这个搭）

```html
<li class="row"                      <!-- h: var(--df-row-h); 圆角 var(--df-radius-pill) -->
    style="padding-inline: var(--df-row-px);
           padding-right: var(--df-row-px);">
  <span class="leading-slot"></span>  <!-- w: var(--df-leading-slot); 图标 16/20px 居中 -->
  <span class="label">…</span>        <!-- flex:1; min-width:0; truncate -->
</li>
```
- 行间距：`gap: var(--df-row-gap)`（comfortable 档 8px）
- 行文字：`font-size: var(--df-row-font)`（comfortable 档 14px），`line-height: 1.5`
- 悬停底色：`background: var(--df-hover)` = `--cds-alpha-1`（**前景色 5%**）
- 选中底色：`background: var(--df-selected)` = `--cds-alpha-2`（**前景色 10%**）
- 行左边距随层级缩进：`padding-left: calc(var(--df-row-px) + var(--df-row-indent))`，
  会话列表缩进 `--df-row-indent: calc(var(--df-group-indent,0px) + 20px)`
- 两行式行（标题 + 描述）：
  `padding-block: calc((var(--df-row-h) - var(--df-row-ctl)) / 2 + 4px - 2px)`，行内 `row-gap: 2px`，
  描述行高固定 16px、字号 `--df-group-font`、`line-height:16px`

来源：[B] `shared-styles-DhpxeH1-.css` 的 `.df-described-row` / `.df-row-description` / `.df-meta-line`，
以及 [B] `shared-27-CB1PCCyy.js` 里的行模板字符串
`"flex h-[var(--df-row-h)] w-full shrink-0 items-center gap-[var(--df-row-gap)] rounded-[var(--df-radius-pill)] pl-[var(--df-row-px)] …"`。

### 1.4 侧边栏固定结构（从上到下）

1. **顶栏 48px**（`--df-header-h`）：搜索框 / 折叠按钮 / 新会话
2. **搜索框**：`box-shadow: inset 0 0 0 1px var(--cds-ring-color)` + `0 1px 2px 0 #0000000d`；
   hover 换成 `inset 0 0 0 1px var(--cds-fill-secondary-ring)`；**快捷键提示（如 `Ctrl+K`）
   平时 `opacity:0`，hover 或 focus 才 `opacity:1`**（[B] `.df-search-field-keys`）
3. **固定项区**（新会话 / 项目 / 任务…），行式，无分组标题
4. **分组标题**：高 `calc(var(--df-row-ctl) + 4px)`，上间距 `--df-group-pt`，
   字色 `--cds-text-primary`，字号 `--df-row-font`
5. **会话列表**：可折叠的树，缩进 20px
6. **滚动遮罩**：`mask-image: linear-gradient(#0000 0, #000 12px)` —— 一旦滚动，
   顶部 12px 渐隐（[B] `.dframe-nav-scroll[data-scrolled]`）
7. **底部**：用户菜单 + 工具按钮行，按钮 32px（comfortable），间距 6px

---

## 2. 视觉语言（具体色值）

### 2.1 中性灰阶（**这是整套配色的骨架**）

不是纯灰，是**带极轻暖黄调**的灰（`#fcfcfb` 而非 `#fff`）。这是 Claude 观感的来源。

| token | 亮色 | token | 暗色 |
|---|---|---|---|
| `gray-0` | `#ffffff` | `gray-800` | `#20201f` |
| `gray-10` | `#fcfcfb` | `gray-810` | `#1e1e1d` |
| `gray-20` | `#f9f9f7` | `gray-820` | `#1c1c1b` |
| `gray-30` | `#f6f6f4` | `gray-830` | `#1a1a19` |
| `gray-40` | `#f3f3f0` | `gray-840` | `#181817` |
| `gray-50` | `#f0efec` | `gray-850` | `#151515` |
| `gray-60` | `#edece8` | `gray-860` | `#131313` |
| `gray-70` | `#eae9e4` | `gray-870` | `#111111` |
| `gray-80` | `#e7e6e1` | `gray-880` | `#0f0f0f` |
| `gray-90` | `#e4e3dd` | `gray-890` | `#0d0d0d` |
| `gray-100` | `#e1e0d9` | `gray-900` | `#0b0b0b` |
| `gray-150` | `#d2d1c7` | | |
| `gray-200` | `#c3c2b7` | | |
| `gray-250` | `#b4b3a8` | | |
| `gray-300` | `#a5a49a` | | |
| `gray-350` | `#97958d` | | |
| `gray-400` | `#898781` | | |
| `gray-450` | `#7b7974` | | |
| `gray-500` | `#6d6b67` | | |
| `gray-550` | `#5f5e5a` | | |
| `gray-600` | `#52514e` | | |
| `gray-650` | `#454442` | | |
| `gray-700` | `#383835` | | |
| `gray-750` | `#2c2c2a` | | |

来源：[A] `MainWindowPage-BjVtjJFx.css` 的 `--cds-gray-*` 定义。

### 2.2 语义层 → 灰阶的映射（**直接抄这张表**）

亮色主题定义在 `.cds-root`，暗色在 `[data-mode=dark]`，二者靠 `--cds-neutral-*` 反向编号实现
（`neutral-0` 在亮色下 = `gray-0`，在暗色下 = `gray-900`）。所以**只需要记住一套语义名**。

| 语义 | 亮色取值 | 暗色取值 | 用途 |
|---|---|---|---|
| `surface-0`（页面底） | `gray-20` = `#f9f9f7` | `gray-900` = `#0b0b0b` | 整个窗口的背景 |
| `surface-1`（卡片/侧边栏） | `gray-10` = `#fcfcfb` | `gray-850` = `#151515` | 侧边栏、卡片 |
| **侧边栏实际底色**（应用内有覆盖） | **`#ffffff`（纯白）** | **`hsl(0 0% 14.9%)` = `#262626`** | 见下方说明 |
| `surface-2`（面板） | `gray-0` = `#ffffff` | `gray-830` = `#1a1a19` | 浮层面板 |
| `surface-3`（浮层/弹窗） | `gray-0` = `#ffffff` | `gray-800` = `#20201f` | popover、菜单、composer |
| `page-bg` | `= surface-0` | `= surface-0` | |
| `text-primary` | `neutral-900` = `#0b0b0b` | `gray-50` = `#f0efec` | 正文、标题 |
| `text-secondary` | `neutral-600` = `#52514e` | `gray-200` = `#c3c2b7` | 次要文字 |
| `text-muted` | `neutral-400` = `#7b7974` | `gray-400` = `#898781` | 弱文字、元信息 |
| `border`（默认） | `alpha-2` = 前景 10% | 同 | 分割线、控件描边 |
| `border-strong` | `alpha-3` = 前景 20% | 同 | 强调描边 |
| `border-stronger` | 前景 40% | 同 | |
| `fill-field`（输入框底） | `#ffffff80`（50% 白） | `alpha-1` = 前景 5% | composer 输入区 |
| `fill-ghost-hover` | `alpha-1`（5%） | 前景 7.5% | 悬停 |
| `fill-ghost-selected` | `alpha-2`（10%） | 前景 15% | 选中 |
| `fill-secondary` | `#ffffff1a` | `alpha-2` | 次级按钮底 |
| `fill-disabled` | `alpha-1` | 同 | |
| `backdrop` | — | `#00000080` | 模态遮罩 |

**`alpha-N` 阶梯**（前景色叠加，亮暗通用，这是"层级感"的真正来源）：

| token | 不透明度 |
|---|---|
| `alpha-0` | 0% |
| `alpha-1` | **5%** |
| `alpha-2` | **10%** |
| `alpha-3` | **20%** |
| `alpha-4` | **35%** |
| `alpha-5` | 50% |
| `alpha-6` | 60% |
| `alpha-7` | 70% |
| `alpha-8` | 85% |
| `alpha-9` | 95% |

### 2.3 品牌色与强调色

| token | 值 | 说明 |
|---|---|---|
| `clay`（品牌主色） | **`#d97757`** | Claude 的橙，只用于品牌标识、状态点、focus ring |
| `clay-emphasized` | `#c6613f` | 深一档，用于 `fill-brand` |
| `heather` | `#cbcadb` | 辅助 |
| `plum` | `#827dbd` | 辅助 |
| `cactus` | `#bcd1ca` | 辅助 |
| `mineral` | `#629987` | 辅助 |
| **accent（功能蓝）** | `blue-450` = **`#2a78d6`**（fill）/ `blue-600` = `#184f95`（亮色文字）/ `blue-300` = `#6da7ec`（暗色文字） | 链接、选中态、焦点 |
| accent 背景块 | 亮 `blue-100` = `#cde2fb` / 暗 `blue-800` = `#032042` | |

### 2.4 状态色（成功/警告/错误）—— **注意：用的是低饱和版本**

| 语义 | 亮色 fill / text | 暗色 fill / text | 原始色 |
|---|---|---|---|
| success | `green-450` `#009300` / `green-600` `#006300` | `green-450` / `green-400` `#0ca30c` | 绿色是**纯绿，没有偏黄** |
| warning | `yellow-200` `#fab219` / `yellow-600` `#734500` | `yellow-200` / `yellow-300` `#db9300` | 琥珀 |
| danger | `red-450` `#d03b3b` / `red-600` `#8e2626` | `red-450` / `red-300` `#ec7e7e` | |
| pro（紫） | `violet-450` `#7161e0` / `violet-600` `#4a3aa7` | `violet-450` / `violet-300` `#a096eb` | Pro 计划标识 |

**状态背景块**（chip/banner 底色）：亮色用 `*-100`（例如 `#fad6d6` 红、`#caeac7` 绿、`#f9dca4` 黄），
暗色用 `*-800`（例如 `#3c0e0e` 红、`#11260f` 绿、`#311a00` 黄）。

完整色阶（每族 0/10/20/…/900，共 33 档）在 [A] 里有，本文只抄了会用到的：
blue `#cde2fb`→`#032042`、red `#fad6d6`→`#3c0e0e`、green `#caeac7`→`#11260f`、
yellow `#f9dca4`→`#311a00`、violet `#dfdbfd`→`#1d1649`、orange、aqua、magenta。
**需要精确值时从 [A] 用 `grep -o '--cds-<family>-<n>:<value>'` 取。**

### 2.5 字体

| 项 | 值 |
|---|---|
| 正文族 | **`anthropic-sans`**（可变字体，`font-weight: 300 800`，`font-display: swap`，`font-feature-settings: "dlig" 0`） |
| 衬线族 | `anthropic-serif`（同上，用于标题的 voice 场景） |
| 等宽族 | `ui-monospace, "SF Mono", Menlo, Consolas, monospace` |
| 系统回退 | `ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", …` |
| 字重档 | **regular 400 / medium 500 / semibold 580 / bold 600** |
| 可变字重轴 | regular `"wght" 360` / medium `460` / semibold `540` / bold `560` |
| 基础行高 | `1.5`（`html` 层） |
| 抗锯齿 | `-webkit-font-smoothing: antialiased`；`text-rendering: optimizeLegibility` |

> **字重是关键**：Anthropic 用的是 **580 而不是 600** 做 semibold，正文可变轴只到 **360 而不是 400**。
> 这就是为什么 Claude 的字看起来"比正常细一点但标题有分量"。复刻时若只有静态字重，
> 正文用 400、标题用 600，并接受略微偏粗。

### 2.6 字号阶梯（两档）

| role | compact | comfortable | 行高（compact） | 行高（comfortable） |
|---|---|---|---|---|
| caption | **11px** | **12px** | 17px | 17px |
| footnote | **12px** | **13px** | 15px | 17px |
| body | **13px** | **14px** | 19px | 20px |
| prose（对话正文） | **14px** | **16px** | 20px | 24px |
| heading | **14px** | **15px** | 18px | 20px |
| title | **20px** | **22px** | 25px | 28px |
| code | 12px | 13px | 17px | 19px |

对话正文另有 `data-text-size` 三档（sm/md/lg）：
sm → body 13px / prose 13px；md → body 14px / prose 14px；lg → body 15px / prose 15px，prose-lg 16px。

另有 `data-step="1..5"` 五档整体字号（prose 依次 13/14/15/16/18px）。

来源：[A] `.cds-root` 与 `.cds-root[data-density=comfortable]` 的 `--cds-font-size-*` / `--cds-leading-*`
（已逐条实测核对，见 §9 的复核说明）。

### 2.7 圆角

| token | 值 | 用途 |
|---|---|---|
| `radius` | 8px（comfortable）/ 6px（compact） | 通用 |
| `radius-sm` | 7px / 5px | |
| `radius-xs` | 5–6px | |
| `radius-composer` | **14px**（comfortable）/ 12px（compact） | 输入框 |
| `panel-radius` | 12px / 10px | 面板 |
| `message-bubble-radius` | **`calc(radius + 4px)` = 12px（comfortable）/ 10px（compact）** | 消息气泡 |
| `checkbox-radius` | 5px | |
| keycap | 4px | 快捷键帽 |

### 2.8 阴影与描边（**这套"描边优先于阴影"的做法要抄**）

亮色：
```
shadow-sm:      0 1px 2px hsl(0,0%,4%, /6%), 0 2px 8px  <8% 黑>
shadow-md:      0 2px 4px hsl(.../7%),       0 6px 16px <8% 黑>
shadow-lg:      0 4px 8px hsl(.../8%),       0 12px 28px -2px <8% 黑>
shadow-popover: 0 8px 24px #0000001f,        0 2px 6px #00000014
ring-outer: 1px ; ring-inner: 0px ; ring-color: var(--cds-border)
```
暗色：
```
shadow-color: #0000003d
shadow-popover: 0 8px 24px #00000052, 0 2px 6px #0003
ring-outer: 0px ; ring-inner: 1px ; ring-color: var(--cds-alpha-2)
```

> **亮暗两套 ring 的翻转是精髓**：亮色用**外**描边 1px（元素边缘一圈），
> 暗色用**内**描边 1px（内阴影）。因为亮色下外部描边更清晰，暗色下内部描边才不会被背景吃掉。
> 复刻时按这个规则做，不要两边都用 border。

`shadow-panel` 的组合式：
`inset 0 0 0 <ring-inner> <ring-color>, 0 0 0 <ring-outer> <ring-color>, <shadow-popover>`

**Composer 专用阴影**（[B] `.shadow-composer`）：
```
常态: 0 4px 20px <3.5% 黑>,  inset 0 0 0 <ring-inner> <ring-color>, 0 0 0 <ring-outer> <ring-color>
hover: 同尺寸
focus: 0 4px 20px <7.5% 黑>, inset 0 0 0 <ring-inner> var(--cds-border-strong), 0 0 0 <ring-outer> var(--cds-border-strong)
```

侧边栏卡片阴影（[B] `--df-shadow-card`，亮色）：
```
inset 0 0 0 0 transparent,
0 0 0 1px  color-mix(in oklab, #0b0b0b 6%, transparent),
0 4px 24px color-mix(in oklab, #0b0b0b 4%, transparent)
```

焦点环（[A] `--cds-focus-shadow`）：
```
亮: inset 0 0 0 1px <页面底>, 0 0 0 1px <accent>, 0 0 6px 1px <accent-chip 底>
暗: inset 0 0 0 1px <页面底>, 0 0 0 1px <accent>, 0 0 0 6px 1px accent-600 @60%
```

---

## 3. 组件形态

### 3.1 任务清单（`○` 待办项）—— **这是最该抄的组件**

有两套实现，**主线用"进度轨"那套**（[B] `c4038fd41-D9LFIgjS.js`）。

**结构**：每行 = `[轨道槽 20px] [正文 flex:1] [悬停操作区]`

| 项 | 值 |
|---|---|
| 行容器 | `display:flex; align-items:stretch; gap: 10px`（`gap-2.5` = 0.25rem×2.5）；`padding-block: 6px`（`py-1.5`）；`padding-right: 24px`（`pr-6`，留给悬停按钮） |
| 轨道槽宽 | **20px**（`w-5`），行首固定 |
| 轨道线 | 绝对定位，`left: 50%`，`width: 2px`（`w-0.5`），`transform: translateX(-50%)`，颜色 `alpha-2`；**已走过的段叠一层 `alpha-3`** |
| 轨道线纵向延伸 | 首行 `top: 0`，中间行 `top: -6px`，末行 `bottom: 0`，其余 `bottom: -6px`（让线连成一条） |
| **状态点（in_progress）** | **直径 7px**（`size-[7px]`）圆点，`background: currentColor`，`text-muted`；外面套 **`box-shadow: 0 0 0 2px <卡片底色>`** 把轨道线"挖断" |
| **进度点（clay 态）** | 直径 **8px** 圆点，用 clay 色的图形组件（非纯色） |
| **完成态勾** | `CheckCircleFilled` 图标，size `sm`，色 `text-secondary`，套同样的 `0 0 0 2px <卡片底色>` |
| 定位 | 圆点/勾统一 `left:50%; top:10px; translate(-50%,-50%)` |
| 正文（pending） | `font-size: var(--body); color: text-secondary` |
| 正文（in_progress） | `color: text-primary`，暗色下 `dark:text-secondary`；**且带 shimmer 文字扫光** |
| 正文（completed） | `color: text-muted`；**注意：轨道视图不加删除线**（另一种列表视图 `K` 才加 `line-through`） |
| wrinkle：新项高亮 | 新完成的项套 `inset-x:-4px; inset-y:0; border-radius: 8px`，播 **1.4s** 的 `background: alpha-1 → transparent` 衰减动画（前 55% 保持 alpha-1） |

**折叠（"N 个更早的步骤"）**：
- 折叠按钮：左边 20px 宽轨道槽，里面画 **1–4 条逐渐变细变短的横杠**：
  `bottom:2px/h:6px`、`bottom:10px/h:4px`、`bottom:16px/h:3px`、`bottom:21px/h:2px`，
  宽度统一 2px，透明度依次 `1 / .7 / .45 / .25`，超出 4 条时第 4 条降到 `.1`
- 文字：`text-caption`（12px），`text-muted`，hover 变 `text-secondary`
- 文案：`Hide earlier steps` / `{n} earlier steps`（单复数）
- 右侧 caret 图标：默认 `opacity:0`，hover 才出现，展开时 `rotate 180°`
- 展开动画：`grid-template-rows: 0fr → 1fr`，`duration: 200ms ease-out`；同时 opacity `0→1`，`duration: 120ms`

**shimmer 轨道**（活着的迹象）：
`absolute; inset-y:6px; left:10px; width:2px; translateX(-50%)`
`::after` 一条从 `transparent 25% → surface-1 50% → transparent 75%` 的竖向渐变，
`1.6s ease-in-out infinite` 从 `translateY(-100%)` 滑到 `translateY(100%)`，
所有 todo 都是 pending 时启用（`opacity: .75`）。

**无障碍文案**（值得抄进我们自己的实现）：
每行末尾有个 `sr-only` 的 `", Done" / ", In progress" / ", Not started" / ", Stopped"`。

### 3.2 工具调用块（`Check current C drive capacity ›`）

| 项 | 值 | 来源 |
|---|---|---|
| 行容器 | `display:flex; align-items:center; gap: 8px`；`padding: 8px 12px`（comfortable：`py-sm` + `px-md`） | [B] `c4e63a189` 工具行 |
| 行负外边距 | `margin-inline: -12px`（让 hover 底色比正文宽出一圈） | 同上 `-mx-pad-md` |
| 文字 | `font-size: var(--body)`（14px）；**`font-weight: medium(500)`**；`color: text-primary` | `"block text-body font-medium text-primary"` |
| 折叠箭头 | `CaretRight`，size `sm`；默认 `text-muted`，激活时 `text-primary` | 同上 |
| 悬停底色 | `background: var(--cds-fill-ghost-hover)`（前景 5%）；行圆角 `var(--cds-radius)`（8px） | `rounded bg-fill-ghost-hover` |
| 悬停操作按钮 | `opacity:0` → `group-has-[:focus-visible]/tool:opacity-100`；绝对定位 `end:36px; top:50%; translateY(-50%)` | `"absolute end-9 top-1/2 -translate-y-1/2"` |
| 工具图标 | 通常 16px，色 `text-muted` | |

**状态行（`33s · 1.4k tokens`）**（[B] `cc1aae219` `Wz`/状态簇）：

| 项 | 值 |
|---|---|
| 容器 | `display:flex; align-items:center; gap: 8px`；`padding-block: 4px`（`py-1`） |
| 文字 | `font-size: 14px`（`text-sm`） |
| 颜色（静息） | `text-text-500`（≈ `text-muted`） |
| 颜色（工作中/不带 dots） | `text-text-300`（≈ `text-secondary`） |
| 时长格式 | `{h}h {m}m {s}s` / `{m}m {s}s` / `{s}s` —— 纯秒数时不补零 |
| 时长出现阈值 | **≥ 5 秒才显示**（`Lz=5`） |
| 时长样式 | `font-variant-numeric: tabular-nums`；**`opacity: 0.65`**（比正文更弱一档） |
| token 计数 | `Intl.NumberFormat('en',{notation:'compact',compactDisplay:'short',maximumFractionDigits:1})` → `1.4k` |
| 分隔点 | 正文用 `·`（中点），前后 `gap: 4px` |
| 等待态 | 三个点 `dframe-dot`：**2px 直径**，`background: text-muted`，`1.8s linear infinite` 脉冲，第 2/3 个 `animation-delay: .2s / .4s`；透明度关键帧 `0%: .3 → 15-25%: 1 → 65%: .3` |
| 工作中闪烁 | `status-dot[data-kind=running]`：**6px 直径**，`1.2s ease-in-out infinite` 在 `.3 ↔ 1` 之间闪 |
| caret | 尾随，`opacity:0`，hover 出现；展开时 `rotate(-90deg)` → 收起 |

### 3.3 消息气泡

| 项 | 值 | 来源 |
|---|---|---|
| 用户消息 / 气泡型 AI 消息 | `[data-cds=UserMessage]` 和 `[data-cds=AssistantMessage][data-variant=bubble]` 共用一套 | [A] |
| 宽度 | `max-width: 85%`（`--cds-message-bubble-measure`），`width: fit-content` | 同上 |
| 内边距 | `padding: var(--pad-md) var(--pad-lg)` = **12px 16px**（comfortable） | 同上 |
| 圆角 | `calc(var(--cds-radius) + .25rem)` = **12px** | 同上 |
| 底色 | `var(--cds-bg-user-message)` = `--cds-bg-neutral` = `--cds-alpha-1`（前景 5%） | 同上 |
| 气泡内多段间距 | `--cds-message-bubble-stack-gap: 2px` | 同上 |
| **AI 常规消息** | **无气泡**：直接排在页面上，只有 `padding-inline: var(--pad-lg)`（16px）作为文字缩进（`--cds-assistant-message-text-inset`） | 同上 |
| 消息间距 | `--chat-item-gap: 6px`；回合间距 `--chat-turn-gap: 5px` | [B] `qw=5, Jw=6` |
| 行内 code | `background: var(--fill-ghost-hover)`（5%）；`border-radius: 4px`；`padding: 1px 4px` | [A] |
| 消息操作按钮 | `--cds-message-actions-opacity` 默认 `0`；延迟 `.1s` 淡入，`duration: 120ms`，`ease-snap`，`transform-origin: top` | [A] |

**用户 vs AI 的区别方式**（重要）：
用户消息 = 有底色的 85% 宽气泡；AI 消息 = **无底色、无边框**，直接是 640px 栏内的正文。
靠"有没有底色"区分角色，不靠左右对齐。

### 3.4 输入框（Composer）

| 项 | 值 | 来源 |
|---|---|---|
| 圆角 | `var(--cds-radius-composer)` = **14px**（comfortable）/ 12px（compact） | [A] |
| 底色 | `var(--cds-fill-field)` = 亮色 **`#ffffff80`**（50% 白）/ 暗色 `alpha-1` | [A] |
| 描边 | 不画 border，用 `box-shadow` 的 ring 层（见 §2.8） | [B] `.shadow-composer` |
| 阴影像 | 见 §2.8 composer 三段 | [B] |
| 外层套壳 | 实际是 `radius-composer + 0.375rem` ≈ 20px 的容器包一层（有 `-1px` 内缩的变体） | [B] `calc(var(--cds-radius-composer)+0.375rem)` |
| 输入区最小值 | `min-height: 1.5rem`（单行）；`sm: min-height: calc(2lh + 6px)` | [B] |
| 控件高 | `--cds-h-control: 32px`（comfortable）/ 28px | [A] |
| 占位符 | `color: color-mix(in oklab, currentcolor 50%, transparent)`（= 文字色 50%） | [A] `::placeholder` |
| 聚焦 | 换成 `shadow-composer-focus`（更深投影 + `border-strong` ring） | [B] |

> **placeholder 文案未获取**：主 compose 框的占位文字由服务端下发/本地化，本地包里没有稳定字面量。
> 已确认的只有"占位符颜色 = 文字色 50%"这一条。

### 3.5 侧边栏会话列表行

见 §1.3 的完整结构。补充：

- 选中态：`background: var(--df-selected)`；**未选中的列表行文字是 `text-secondary`，
  选中的才是 `text-primary`**（[B] `.df-session-list[data-list-section] [data-row-main-button]:not([data-selected=focused]){color:var(--cds-text-secondary)}`）
- 分组标题：高 `--df-row-ctl + 4px`，字色 `text-primary`，字号 `--df-row-font`
- 时间/元信息行：`--df-group-font`，`line-height:16px`，
  右侧 24px 渐隐遮罩 `mask-image: linear-gradient(90deg, #000 calc(100% - 24px), #0000)`
- 拖拽预览：`cursor: grab` / `cursor: grabbing`
- 右侧状态点见 §5.3

---

## 4. 间距节奏

### 4.1 基础单位

| 体系 | 基数 | 说明 |
|---|---|---|
| **CDS padding/gap** | **不严格 4px 网格**，是**具名档位** | 见下表 |
| Tailwind `--spacing` | **`0.25rem` = 4px** | 工具类（`gap-2.5` = 10px、`py-1.5` = 6px）按 4px 倍数走 |

`--cds-pad-*` / `--cds-gap-*`（**已逐条实测**）：

| token | compact | comfortable |
|---|---|---|
| `pad-xs` | 4px | 6px |
| `pad-sm` | 6px | 8px |
| `pad-md` | 8px | **12px** |
| `pad-lg` | 12px | **16px** |
| `pad-xl` | 20px | **24px** |
| `gap-xs` | 6px | 8px |
| `gap-sm` | 8px | 12px |
| `gap-md` | 12px | **16px** |
| `gap-lg` | 20px | **28px** |
| `gap-xl` | 32px | **40px** |
| `h-control`（控件高） | 24px | **32px** |
| `icon` | 16px | 20px |
| `radius` | 6px | 8px |
| `radius-composer` | 12px | **14px** |
| `panel-radius` | 10px | 12px |

> 注意 `pad-*` 和 `gap-*` 是**两套不同的档**：`pad-md`=12px 而 `gap-md`=16px。
> 复刻时不要合并成一个 scale。

**全部尺寸都可被 `--cds-rem-scale` 整体缩放**（`calc(.75rem * var(--cds-rem-scale,1))`）。
这是"界面缩放"功能的实现方式——改一个变量，全站等比缩放。**这个机制值得直接抄。**

### 4.2 垂直节奏（实测值）

| 关系 | 值 |
|---|---|
| 消息之间 | 6px |
| 回合之间 | 5px |
| 待办行内上下 | 6px |
| 待办行左间距 | 10px |
| 工具行内上下 | 8px |
| 工具行左右 | 12px |
| 状态行上下 | 4px |
| 状态行元素间 | 8px |
| 侧边栏分组顶部 | 12px（compact）/ 16px（comfortable） |
| 侧边栏底部按钮间 | 3px / 6px |
| 气泡内多段 | 2px |
| 侧边栏卡片四边留白 | 8px |

### 4.3 分隔方式

Claude **几乎不用 1px 实线分割**。区块分隔靠三种手段：
1. **留白**（主要手段）——例如消息之间只有 6px，但靠气泡底色区分
2. **描边 ring**（`0 0 0 1px` 的 box-shadow）——不是 border
3. **顶部渐隐 mask**（滚动时 `linear-gradient(#0000 0, #000 12px)`）

真正用到 `divide-y` 的只有 Accordion（`font-sans divide-y divide`，[B]）。

---

## 5. 交互模式

### 5.1 展开 / 折叠

| 场景 | 行为 |
|---|---|
| 工具调用 | 默认折叠，只显示 `工具名 › `；点击展开显示结果；caret 默认 `text-muted`，展开后 `text-primary` |
| 工具状态行 | 默认收起；hover 才显示 caret |
| 待办折叠 | 连续完成超过 2 个（`k=2`）之前的步骤折叠成"N 个更早的步骤" |
| Accordion | `grid-template-rows: 0fr→1fr` + opacity，200ms/120ms |
| 侧边栏树 | 点击箭头或整行切换；`chevron` 与 `row` 两种触发源分别计事件 |

### 5.2 悬停 / 选中反馈

| 状态 | 亮色表现 |
|---|---|
| 行悬停 | 底色 `alpha-1`（5%） |
| 行选中 | 底色 `alpha-2`（10%），文字从 secondary 升到 primary |
| 工具行悬停 | 底色 5%，且**负外边距让底色比文字宽 24px** |
| 悬停才出现的元素 | caret、操作按钮、快捷键提示（`opacity: 0 → 1`） |
| 过渡时长 | `--cds-dur-snap: 120ms`、`--cds-dur-base: 200ms`、`--cds-dur-fast: 60ms`、`--cds-dur-sheet: 300ms`、`--cds-dur-slow: 450ms` |
| 缓动 | `ease-out: cubic-bezier(.165,.84,.44,1)`、`snap: cubic-bezier(.32,.72,0,1)`、`overshoot: cubic-bezier(.34,1.3,.64,1)` |
| 侧边栏专用缓动 | `--df-ease-out: cubic-bezier(.32,.72,0,1)`、`--df-ease-out-fast: cubic-bezier(.2,0,0,1)`、`--df-dur-fast:.12s`、`--df-dur-slow:.3s` |
| 按钮按下 | `hover: scale-y(1.015) scale-x(1.005)` + 一个从底部来向的径向渐变高光（主按钮） |

### 5.3 快捷键提示位置

- 搜索框右侧，`opacity: 0`，hover/focus 才显示（`.df-search-field-keys`）
- 键盘帽样式：`height: calc(1em + 6px)`；`min-width: calc(1em + 6px)`；`padding-inline: 3px`；
  `border-radius: 4px`；`border: 1px solid var(--cds-shortcut-cap-line)`（= `currentColor`）；
  背景 `transparent`；字色 `currentColor`；组合键之间 `padding-inline: 2px` 放 `+`
- 全局快捷键：`Ctrl/Cmd+K` 打开命令面板（[A] `build__index.chunk-B7K6kkCQ.js`）

---

## 6. 「没有异常」时界面长什么样 —— **这是本规格最重要的一节**

Claude 的答案很干脆：**什么都不显示。** 这不是疏忽，是显式设计，代码里能读到证据。

### 6.1 状态点的语义是"异常才有"

[B] `c2771e1f6-B5G2bj85.js` 里的状态映射：

```js
// 三态 → 提示元素；其余一律 null
error    → { kind: null,  live: true,  label: "Error" }
awaiting → { kind: "awaiting", live: true,  label: "Needs attention" }
running  → { kind: "running",  live: true,  label: "Running" }
ready    → { kind: "ready",    live: false, label: "Unread" }
其他     → null            // ← 不渲染任何东西
```

渲染侧（同文件）：
```js
g.kind
  ? <span aria-hidden className="flex shrink-0 items-center"><StatusDot kind={g.kind}/></span>
  : <Icon name="Warning" size="xs" className="shrink-0 text-warning"/>,
<span className="sr-only" role={g.live ? "status" : undefined}>{g.label}</span>
```

**要点**：
1. **正常/空闲 = 只有 `sr-only` 文本，屏幕上没有任何像素**。没有"✓ 一切正常"、没有绿点。
2. 唯一"非点"的视觉是 `kind === null` 但状态存在（如 error）时显示一个 **Warning 图标**（`text-warning`）。
3. 重要信息全部由一个 `role="status"` 的 `sr-only` span 承载 —— **屏幕阅读器永远读得到，视觉上永远不占位置**。
4. 点的大小只有 **6px**，安静状态的提示强度极低。

### 6.2 状态点的颜色与动效对照表（**直接抄**）

| `data-kind` | 底色 | 尺寸 | 动效 | 语义 |
|---|---|---|---|---|
| `ready` | `--cds-fill-accent`（**蓝 `#2a78d6`**） | 6px | 无 | 未读 |
| `awaiting` | `--cds-fill-warning`（**黄 `#fab219`**） | 6px | 无 | 等你 |
| `running` | `--cds-text-muted`（**灰**） | 6px | `1.2s` 在 `.3 ↔ 1` 呼吸 | 在跑 |
| `error` | `--cds-fill-danger`（**红 `#d03b3b`**） | 6px | 无 | 出错 |
| `clay` | 图片填充（`--cds-clay` 图形） | 可变 | `3s` `brightness(.96→1.06)` + `scale(.86→1)` 呼吸 | 品牌/特殊 |
| **（无）** | — | — | — | **正常，不渲染** |

> **注意 `ready` 是蓝色而不是绿色**。绿色在 Claude 的状态语言里几乎不用。
> "一切正常"没有颜色，因为"一切正常"没有点。

### 6.3 运行中的"活着"提示只有一个

三个 **2px** 的点，`1.8s linear infinite`，依次错开 `.2s`，透明度 `.3 → 1 → .3`（`dframe-dot`）。
这是全站唯一的"还在工作"动画，且**极小、极暗**。

### 6.4 对我们监控工具的启示（显式写给实现者）

Claude 的做法隐含一条判据：**只有当"用户应该做点什么"或"系统出问题了"才占用像素。**
展开成可实现的规则：

| 系统状态 | 屏幕表现 |
|---|---|
| 一切正常、无待办 | 什么都不加。不要加 "All systems normal"、不要加绿点、不要加对勾 |
| 工作中 | 一个 6px 灰点呼吸，或三个 2px 点脉冲 |
| 需要人介入 | 6px 黄点（`#fab219`） |
| 失败/阻塞 | 6px 红点（`#d03b3b`），或一个 14px 的 Warning 图标 |
| 有未读结果 | 6px 蓝点（`#2a78d6`） |

并且：**每一项都同时写一份 `role="status"` 的 sr-only 文本**。
这样"屏幕上看不出异常"和"机器/无障碍可读"不矛盾。

---

## 7. 直接可用的 CSS 变量块（照抄起点）

```css
:root {
  /* 亮色 */
  --bg-page: #f9f9f7;
  --bg-surface-1: #fcfcfb;
  --bg-surface-2: #ffffff;
  --bg-surface-3: #ffffff;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #7b7974;
  --fg-rgb: 11 11 11;                    /* alpha 层靠它 */

  --alpha-1: rgb(var(--fg-rgb) / 5%);
  --alpha-2: rgb(var(--fg-rgb) / 10%);
  --alpha-3: rgb(var(--fg-rgb) / 20%);
  --alpha-4: rgb(var(--fg-rgb) / 35%);

  --border: var(--alpha-2);
  --border-strong: var(--alpha-3);
  --fill-field: #ffffff80;
  --hover: var(--alpha-1);
  --selected: var(--alpha-2);

  --clay: #d97757;
  --brand: #c6613f;
  --accent: #2a78d6;
  --accent-chip: #cde2fb;
  --success: #009300;
  --warning: #fab219;
  --danger: #d03b3b;

  --sidebar-w: 288px;
  --sidebar-inset: 8px;
  --sidebar-radius: 8px;
  --sidebar-bg: #ffffff;                 /* 注意：比 --bg-page 更亮，见 §8.2 */
  --row-h: 32px;
  --row-font: 14px;
  --row-gap: 8px;
  --row-px: 2px;
  --pill-radius: 8px;

  --pad-xs: 6px;  --pad-sm: 8px;  --pad-md: 12px; --pad-lg: 16px; --pad-xl: 24px;
  --gap-xs: 8px;  --gap-sm: 12px; --gap-md: 16px; --gap-lg: 28px; --gap-xl: 40px;

  --radius: 8px;
  --radius-composer: 14px;
  --radius-panel: 12px;
  --radius-bubble: 12px;

  --font-sans: "anthropic-sans", ui-sans-serif, -apple-system, "Segoe UI",
               "PingFang SC", "Noto Sans SC", sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;

  --fs-caption: 12px;  --lh-caption: 17px;
  --fs-footnote: 13px; --lh-footnote: 17px;
  --fs-body: 14px;     --lh-body: 20px;
  --fs-prose: 16px;    --lh-prose: 24px;
  --fs-title: 22px;    --lh-title: 28px;

  --dur-fast: 60ms; --dur-snap: 120ms; --dur-base: 200ms; --dur-sheet: 300ms;
  --ease-out: cubic-bezier(.165,.84,.44,1);
  --ease-snap: cubic-bezier(.32,.72,0,1);

  --ring-outer: 1px; --ring-inner: 0px;
  --ring-color: var(--border);
  --shadow-card: 0 0 0 1px rgb(11 11 11 / 6%), 0 4px 24px rgb(11 11 11 / 4%);
  --shadow-popover: 0 8px 24px #0000001f, 0 2px 6px #00000014;
  --shadow-composer: 0 4px 20px rgb(0 0 0 / 3.5%),
                     inset 0 0 0 var(--ring-inner) var(--ring-color),
                     0 0 0 var(--ring-outer) var(--ring-color);
  --focus-shadow: inset 0 0 0 1px var(--bg-page), 0 0 0 1px var(--accent),
                  0 0 6px 1px var(--accent-chip);
}

:root[data-mode="dark"] {
  --bg-page: #0b0b0b;
  --bg-surface-1: #151515;
  --bg-surface-2: #1a1a19;
  --bg-surface-3: #20201f;
  --sidebar-bg: #262626;
  --text-primary: #f0efec;
  --text-secondary: #c3c2b7;
  --text-muted: #898781;
  --fg-rgb: 240 239 236;                 /* 前景 = 浅色，alpha 层自动反相 */
  --fill-field: rgb(var(--fg-rgb) / 5%);
  --hover: rgb(var(--fg-rgb) / 7.5%);
  --selected: rgb(var(--fg-rgb) / 15%);
  --accent: #6da7ec;
  --accent-chip: #032042;
  --success: #0ca30c;
  --warning: #fab219;
  --danger: #ec7e7e;
  --ring-outer: 0px; --ring-inner: 1px;
  --ring-color: var(--alpha-2);
  --shadow-card: inset 0 0 0 1px #ffffff0f, 0 4px 24px rgb(0 0 0 / 24%);
  --shadow-popover: 0 8px 24px #00000052, 0 2px 6px #0003;
}
```

### 关键结构骨架

```css
.app        { display: flex; height: 100%; background: var(--bg-page); }
.sidebar    { position: absolute; top: 8px; left: 8px; bottom: 8px; width: var(--sidebar-w);
              border-radius: var(--sidebar-radius); background: var(--sidebar-bg);
              box-shadow: var(--shadow-card); display: flex; flex-direction: column; }
.content    { flex: 1; display: flex; justify-content: center; }
.chat       { width: 100%; max-width: 40rem; padding-inline: 32px; }
```

```css
/* 状态点 */
.status-dot { width: 6px; height: 6px; border-radius: 50%; display: block; }
.status-dot[data-kind="running"] { background: var(--text-muted);
                                   animation: dot-blink 1.2s ease-in-out infinite; }
@keyframes dot-blink { 0%, 100% { opacity: .3 } 50% { opacity: 1 } }
/* 正常状态：不渲染 */
```

---

## 8. 复刻时的三条"最容易做错"

1. **不要用 `border` 画边框**。Claude 全站用 `box-shadow: 0 0 0 1px` 画描边，
   且亮色用外描边、暗色用内描边。用 `border` 会让元素尺寸变化、并对不齐 4px 网格。
2. **不要用纯灰和纯白**（内容区）。页面底色是 `#f9f9f7`（带暖调的纸白），
   但**侧边栏是纯白 `#ffffff`**（暗色下侧边栏 `#262626` 比页面 `#0b0b0b` 亮得多）——
   侧边栏永远比页面**更亮**。这不是写错了，是"浮起来"的观感来源。
3. **不要在正常状态显示任何东西**。见 §6。我们做的是监控工具，最容易犯的错就是
   "没事也要显示个绿色的正常" —— 那会让真正的黄点/红点失去对比度。

---

## 9. 未获取 / 明确不知道的部分

| 项 | 状态 | 试过什么 |
|---|---|---|
| **主 compose 框的 placeholder 文案** | **未获取** | 全量 grep [B] 的 `defaultMessage` / `placeholder`，只有 /path/to/folder、cron 等表单字段的字面量；主输入框文案由服务端/本地化下发 |
| **侧边栏会话行的完整 JSX** | **部分**：拿到了类名模板字符串与 CSS，没拿到完整组件源码 | [B] 的 `shared-27-CB1PCCyy.js` 有行模板片段，但组件树被多个 chunk 拆分 |
| **`Cmd/Ctrl+Enter` 之类的具体键位绑定表** | **未获取** | 只确认了 `Ctrl/Cmd+K`；其余绑定在远程前端并可能按平台分支 |
| **动画 `progress-step-in` / `progress-rail-grow` / `progress-knob-in` 的关键帧定义** | **未获取**（只拿到类名，关键帧不在这两个文件里） | 已确认 todo 组件引用了它们；`@keyframes` 定义应在别的 CSS chunk |
| **图标集（Anthropicons）的完整字形表** | **未获取**，只确认它是**可变字体 ligature 图标**（`anthropicons-variable-cvFTkbeX.woff2`，102 KB，`font-feature-settings: "liga" 0`，`width/height: 1em`），已见名字：`CaretRight` `CaretDown` `CaretUp` `Check` `CheckCircleFilled` `Warning` `Spinner` `Menu` `ChatAdd` `DotsHorizontal` `Pin` `Trash` `Link` `Globe` `Cursor` `Trust` | 解析了 woff2 引用与图标组件用法；字形表未展开 |
| **精确的 `--cds-rem-scale` 取值范围** | 未获取（只知它存在并参与全站 `calc`） | — |
| **浏览器/Electron 版本对应的 Tailwind 与 CDS 版本** | 已知 Tailwind **v4.3.3**；`@ant/cds` 版本号未获取 | [A] CSS 首行注释 |
| **`clawdQuestEngine` 的配色** | 拿到但**不建议用**：它是 easter-egg 小游戏的独立主题（`--cq-bg:#171717` 等），与主界面无关 | 已读 [A] `clawdQuestEngine-C2Z1JudX.css` |
| **本地 `Cache/` 里的 CSS** | **未获取**：Chromium 缓存是压缩块，`strings` 无法还原 | 试过 `strings` + 按大小筛 + grep `cds-surface-0`，均为 0 命中 |

**没有做的验证**：未启动 GUI（按任务约束）、未截图、未做像素比对。
所有数值来自磁盘上的编译产物，不是从屏幕上量的。

**已做的复核**：本文成稿后对 6 组关键数值做了逐条重测并**修正了 3 处错读**——
字号阶梯（prose 实为 14/16px，原写 13/15px）、`pad-*` compact 档（实为 4/6/8/12/20，原写大了 2px）、
侧边栏底色（实为 `#ffffff`/`#262626`，原误用 base token `gray-10`）。
复核命令模式：按 token 名 `grep -o '--cds-<name>:[^;}]*'` 后逐个比对所在选择器
（`.cds-root` = compact，`.cds-root[data-density=comfortable]` = comfortable）。
**若本文还有与视觉不符处，优先怀疑我读错了选择器，按此路径可复核。**
