# dsh-TUI 参考实现分析：它是什么、哪些能抄、零依赖要不要破

- 日期：2026-11-05（克隆与逐文件核实执行于 2026-11-10）
- 角色：检索 Agent TR1。产出形态：**exploration**（参考实现分析，不是设计稿）
- 对象：`https://github.com/ccch1mneyyy/dsh-TUI`（v0.19.0，MIT，7,312 star / 351 fork，2026-08 创建）
- 方法：`git clone --depth 1` 到 `.tmp-analysis/dsh-tui`（已 gitignore），读 `src/` 全部 1,823 个 ts/tsx 中的关键路径、
  `docs/`（interaction / user-guide / themes / architecture）、559 个 `scripts/verify-*` 回归中的 3 个样本、`theme.ts` 全量、
  `package.json` / `pnpm-lock.yaml` / `THIRD_PARTY_LICENSES`。另外把 `preview-zh.svg`（真实终端录制的 SVG 快照）
  按 y 坐标还原成逐行文本，用它核对第一屏的真实版面。
  **未修改 Overwatch 任何代码，未碰 git。** 所有数字都是本机实测。

---

## 零、结论先行

| 问题 | 结论 |
|---|---|
| 它是什么 | **一个 coding agent 的完整终端客户端**（DeepSeek Harness 的前端）。不是监控面板：`src/screens/Chat.tsx` 单文件 **7,707 行**，transcript / Markdown / Mermaid / MathJax / Sixel 图片 / 多内核（DSH / Claude / Codex）全在里面。 |
| 技术栈 | **React 19 + 自家 fork 的 Ink + 纯 TS 移植的 Yoga**。`package.json` 里**没有 `ink` 依赖** —— 他们把 Ink 整套搬进了 `src/ink/`（132 文件 **36,470 行**），又用 2 文件 **3,303 行**重写了 flexbox 引擎。真依赖 31 个 npm 包（含 `react`/`react-reconciler`/`chalk`/`highlight.js`/`marked`/`sixel`/`ws`/`zod`），pnpm-lock 展开后上千个包。 |
| 规模 | 跟踪文件 3,260 个；`src/` 1,823 文件 **246,935 行**；`scripts/` 671 个脚本，其中 `verify-*` **559 个**；`docs/` 49 篇（中英双语）+ `guide/` 23 篇。 |
| 和 Overwatch 的相同点 | 都是「一屏列出多个 AI 会话 + 每行一个实时状态」。它的 `/resume` 屏（`src/screens/SessionSupervisor.tsx`，1,010 行）与我们的列表页是**同一个信息架构问题**。 |
| 和 Overwatch 的不同点 | 它是**交互客户端**（你要进去说话），我们是**只读告警面板**（你只需要知道谁在等你）。它有写权限、有 transcript 渲染、有会话生命周期；我们两样都没有，也不该有。**它没有「无异常」这个界面概念**——这不是遗漏，是产品形态差异，见 §2.3。 |
| 最值得抄的三样 | ① **布局数学全是无依赖纯函数**（`listWindow.ts` 49 + `format.ts` 375 + `launchpadLayout.ts` 261 = 685 行，其中截断/居中/窗口化/降级阶梯各自是独立可测函数）——这正是我们最缺的东西，且**搬得动**。② **每行固定列宽的纪律**（状态格恒 2 列、钉选格恒 2 列，空着也占位；选中是绿色文字、悬停是蓝色底，两者永不共用同一个视觉通道）。③ **光标是 ID 不是下标** + 「筛选后光标绝不落到创建/破坏性那一行」。 |
| 零依赖要不要破 | **不破。** 理由见 §7：它真正需要重依赖才能做到的是「60fps 单元格差分重绘 + flexbox + 鼠标」，而我们 30 行输出、1Hz 刷新的场景一条都用不上；真正可抄的那几百行纯函数**一行依赖都不需要**。唯一值得破例的是**测试期**一个 `devDependency`（`@xterm/headless`），不进产物。 |
| 决定性发现 | **我们现在的 `displayWidth` 宽度表是坏的**，22 个抽样里 9 个错：`⚓ ⚪ 🟡 🟢 🟣 ✅ ⚡ ⌚` 全部量成 1 列（实际画 2 列），`👍🏻` 量成 4 列（实际画 2 列）。而 `watch.mjs` 的通知文本里已经在用 `⚠ ✋ ❓ ✖ 📋`。dsh-TUI 用三个 npm 包解决同一问题，**我们用 EastAsianWidth.txt 的 W/F 表 + Node 内置 `Intl.Segmenter` 就能解决，不需要任何依赖**。 |

---

## 1. 它是什么

### 1.1 定位

`dsh-TUI` 是 DeepSeek Harness（DSH）这个 coding agent 的**官方首推 TUI 插件**。它的第一屏（落地页）是一个输入框 + 像素鲸鱼 + 参数行；输入一句话就进对话页；`/resume` 进会话管理屏。

对本任务有用的不是它的对话页，是下面这四块：

| 文件 | 行数 | 为什么和我们有关 |
|---|---|---|
| `src/screens/SessionSupervisor.tsx` | 1,010 | 左栏工作区 + 右栏会话列表 + 每行实时状态。**这就是我们列表页的同构问题。** |
| `src/components/sessions/SessionListRow.tsx` | 242 | 一个会话行怎么排：两行、固定列宽、截断预算、悬停浮层。 |
| `src/components/workspaces/HomeWorkspaceRow.tsx` | 136 | 一个工作区行怎么在 24–38 列里放下「选中环 + 名字 + 计数徽章」。 |
| `src/components/design-system/` | 12 文件 1,270 | 它自己的 design system：`ListItem` / `Divider` / `HintLine` / `Byline` / `StatusIcon` / `ProgressBar` / `Pane` / `LoadingState` / `ThemedBox` / `ThemedText` / `ThemeProvider` / `InputCaret`。 |
| `src/screens/SessionTree.tsx` | 886 | 树形列表 + 三级「座位」（tree / menu / confirm）+ 宽窄两套预览布局。 |
| `src/components/launchpadLayout.ts` | 261 | **纵向降级阶梯的教科书**：6 档，明确排出「先撤什么」。 |
| `src/components/listWindow.ts` | 49 | 焦点居中窗口化。文件头注释里写着两次真机翻车。 |

### 1.2 代码规模与结构（实测）

```text
src/                     1,823 files   246,935 lines
├── ink/                   132 files    36,470 lines   移植的 Ink（渲染器/事件/终端协议/选择）
├── native-ts/yoga-layout    2 files     3,303 lines   纯 TS flexbox（API 兼容 yoga-layout/load）
├── screens/                20 files    20,091 lines   Chat 7,707 / Settings 1,779 / Onboarding 1,613 / Launchpad 1,441 / StatusLine 1,188 / SessionSupervisor 1,010 / SessionTree 886
├── components/            201 files    43,946 lines
├── dsh-adapter/           245 files    63,407 lines   宿主接缝、会话列表、主题、设置
└── ...（theme.ts 1,503 / i18n.ts 3,193 / PromptInput.tsx 4,933）
scripts/verify-*          559 files                 每个行为一支回归脚本
```

**渲染器是自持的**：`src/ink/` 就是 Ink，改过的。`package.json` 里 `"ink"` 不存在（我 grep 过），`src/ink/renderer.ts`、`screen.ts`（2,247 行）、`log-update.ts`（1,248 行）、`ink.tsx`（3,191 行）都是仓库自己的代码。`src/native-ts/yoga-layout/index.ts` 开头明说这是「Pure-TypeScript port of yoga-layout」。

这个事实决定了 §7 的结论：**它给出的「零闪烁、全中文、逐格对齐」不是配置出来的，是自建渲染器的能力。**

### 1.3 解决的问题 vs Overwatch

| 维度 | dsh-TUI | Overwatch |
|---|---|---|
| 用户动作 | 进入会话、说话、审批、打断 | 看谁说「我需要你」，复制草稿 |
| 数据源 | 自己的内核（进程内），事件流式推送 | 别人的 transcript + 宿主 `sessions/*.json`（只读，轮询） |
| 行源可靠性 | 自己写的，权威 | 推断的，且**已知会漏**（见 `docs/research/2026-11-05-multisession-ux-research.md`） |
| 一屏信息量 | 要显示对话全文 | 一屏 20–40 行状态摘要 |
| 刷新 | 流式，60fps 节流 | 8 秒轮询，首次扫描 ~26 秒 |
| 可写性 | 可写主题/设置/钉选到 `~/.dsh-tui/` | 承诺「只读」 |
| 「空」的含义 | 没有会话 → 教你新建 | **可能是「真的没事」也可能是「我们没扫到」** |

最后一行是本文最要紧的一条差异，见 §2.3。

---

## 2. 信息架构（最重要）

### 2.1 主界面第一眼显示什么

我把 `docs/assets/readme/preview-zh.svg`（110×42 的真实终端录制）按 y 坐标还原成行。落地页第一屏（节选，删掉装饰）：

```text
✦ dsh-TUI v0.10.2
      [像素鲸鱼 13 行]
deepseek-flash · Max effort
        欢迎使用 dsh-TUI · 从这里开始
  提示：minimal preset 下 /compact 与问卷不可用 · /tips 更多技巧

        探索未至之境！

  ❯ |（输入框，圆角边框，单行）
    deepseek-flash · max · 权限名        ← 参数行（模型·思考深度·预设·权限）
                [继续「…」] [会话与工作区] [设置] [内核 · DSH] [帮助]
                    ● Tips：<一句轮换提示>
  工作目录:分支                                     dsh-tui v0.19.0
                                                   ▸ DSH · dsh-core v…
                                                   Claude · claude-code v…
```

会话管理屏（`SessionSupervisor`）第一眼：

```text
 ▣ 会话管理  本终端托管多个会话 · 切换不中断              DSH │ Claude Code │ Codex
────────────────────────────────────────────────────────────────────────────────
 ~/Projects/Overwatch/src
 工作区 (3)          │   Overwatch 的会话        0 运行中 · 0 个活跃 · 共 12
                     │   ⌕ 过滤…
 ❯ ▣ Overwatch     3 │ ❯ ＋ 新建会话
   ▢ dsh-TUI       7 │      在「Overwatch」新建一个会话
   ▢ 仅历史 · old  1 │   ⋯
                     │   （会话行：两行一条）
                     │
 ←/→ 切换栏位 · Enter 进入会话 · Ctrl+N 新建 · Ctrl+X 停止 · Esc 返回
```

要点，按重要性排：

1. **标题行右侧是「来源标签条」**，不是设置入口；宽了就把尾部折成 `+N`，**但当前所在的那个标签永不折叠**（`layoutSourceTabs`，`SourceTabs.tsx:52`）。
2. **两栏的宽度是算出来的，不是 flex 分的**：`columns >= 84` 才显示左栏；左栏 `clamp(24, columns*0.3, 38)`，右栏 `columns - rail - 1`（`useSessionSupervisor.ts:552-556`）。窄了**整块撤掉左栏**，不是压缩它。
3. **选中目录的完整路径单独占一行**（在分割线和两栏之上），因为它「有整屏宽度可用」，而不是在每个工作区名下面重复一个被截断的路径。路径按显示宽度换行，最多 `min(4, rows/4)` 行，超了最后一行加 `…`，完整路径走悬停浮层（`SessionSupervisor.tsx:566-580`）。
4. **列表区自上而下的固定顺序**：标题 → 计数 → 筛选框 → 新建卡片（永久第 0 行）→ 滚动窗口 → 提示槽（永久占位）→ 按键提示行。
5. **一行只有一个 `❯`**。左栏和右栏都能持有键盘，`←/→` 是唯一的所有权切换键，所以屏幕上永远只有一个光标（`SessionSupervisor.tsx:382-384` 的注释：「There is exactly one `❯` on screen because exactly one column owns the keyboard」）。

### 2.2 怎么组织多个条目

**分组**：两级，物理固定。左栏 = 工作区（= 一个目录），右栏 = 选中工作区里的会话。没有第三种分组。

**排序**（`useSessionSupervisor.ts:499-511`）：

```ts
.sort((left, right) => {
  const leftLive = liveStateOf(left.id)?.live === true ? 1 : 0
  const rightLive = liveStateOf(right.id)?.live === true ? 1 : 0
  return rightLive - leftLive || right.updatedAt - left.updatedAt
})
```

即「本终端正在跑的」> 「按更新时间倒序」。**没有按状态排序**（它是对话客户端，没有「异常」这个概念）。工作区的排序也是「本终端启动目录置顶，其余按活跃度」（`src/dsh-adapter/sessions/list.ts:196`）。

**钉选不改变位置**（实测）：`pins` 只用于两个地方 —— 行内 `★/☆` 的绘制、点击时切换。我 grep 过整个 `useSessionSupervisor.ts`，`pins.has()` 只在 `SessionListRow` 的 `pinned=` 出现。**钉选是标记，不是排序键。** 这是一个我们可能要故意做得不一样的决定（见 §6）。

**过滤**：`sessionMatchesQuery` 对 `title.text + label + cwd + branch + model` 做小写子串匹配（`sessionSupervisor/model.ts:122-132`）。**没有独立输入模式**：直接打字就是筛选，`Backspace` 退格，`Esc` 清空（`SessionSupervisor.tsx:408-412` 的注释明写：「filtering adds no separate input mode」）。`Esc` 是三层：先关提示 → 再清筛选 → 再离开本屏（`SessionSupervisor.tsx:355-368`）。

**行高**：会话行恒 2 行（`SESSION_ROW_LINES = 2`），工作区行恒 1 行（`WORKSPACE_ROW_LINES = 1`）。**行高是常量，窗口按行而不是按项算**。`listWindow.ts` 的文件头解释了这个为什么是硬要求：

> 按**行**而非项数预算：ListItem 带 description 时占两行……只数项数会把焦点裁出屏外（二次审查实证：每项一行描述时索引 0 仍不可见）。

### 2.3 「没有异常」的时候界面长什么样 —— **它没有这个界面**

这是最该说清楚的一条。

**dsh-TUI 里不存在「一切正常」这个状态。** 我 grep 过 `src/i18n.ts` 全部 3,193 行的 zh 文案，没有任何「全部正常 / 无异常 / all clear / everything is fine」的键。它有的是四种**具体的空**：

| 情形 | 文案（zh） | 位置 |
|---|---|---|
| 没有工作区 | `还没有工作区 · 在任意目录启动 dsh-tui 即可自动加入` | `i18n.ts:573` |
| 工作区里没有会话 | `这个工作区还没有会话 · Enter 新建一个` | `i18n.ts:575` |
| 筛选没有命中 | `没有匹配的会话 · Esc 清空筛选` | `i18n.ts:599` |
| 树里没条目 | `没有可显示的条目` | `i18n.ts:326` |

四条都遵守同一个句式：**「事实 + 你现在能按什么」**，而不是「没问题」。

**计数行永远在，且永远由数据算出来**（`i18n.ts:607`）：

```text
{{working}} 运行中 · {{live}} 个活跃 · 共 {{total}}
```

三个数都是 0 的时候它就写 `0 运行中 · 0 个活跃 · 共 0`，**不会退化成一个形容词**。（窄于 84 列、左栏被撤时这一行只剩总数 `0`，见 `SessionSupervisor.tsx:728-734` 的三元分支——那也是事实，不是判词。）

**它还有一条我们没有机制：永久提示槽。** 列表区和按键提示行之间有一行恒占位（`SessionSupervisor.tsx:836-840`）：

```tsx
<Box flexShrink={0} flexDirection="column" height={noticeRows.length} overflow="hidden">
  {noticeRows.map((line, index) => (
    <Text key={index} color={notice?.tone === 'error' ? 'error' : 'success'}>{` ${line}`}</Text>
  ))}
</Box>
```

`SessionTree.tsx:627` 同款，注释写得更直白：「**Permanent notice slot (blank while quiet)** with a toast glyph — a rewind/fork report must never shift the tree by arriving.」也就是说：**报告到达时不能让版面动**。

#### 对我们的一句硬批评

我们现在的状态行（`scripts/oversight-tui.mjs:478-494`）是：

```js
const parts = [
  `${sessions.length} 会话`,
  counts || '无异常',
  refresh,
  `每 ${app.intervalSec}s 轮询`,
];
```

`counts` 来自 `stateCounts()`，而 `stateCounts()` 只统计 `STATE_ORDER.includes(st)` 的行。实测：

```text
empty      : 0 会话 · 无异常
unknown st : 2 会话 · 无异常     ← 两行状态都不在枚举内，于是「无异常」
all fine   : 1 会话 · PRODUCING=1
```

**`无异常` 同时覆盖了「0 个会话」和「2 个会话但我们一个都没认出」**。这正是 README 里警告的那类假信号：屏幕告诉你没事，而事实上是「我们不知道」。dsh-TUI 的解法不是「写得更好听的形容词」，是**根本不印全局判词**——只印可以逐个核对的计数，空状态写「下一步能按什么」。

这条可直接落地：把 `counts || '无异常'` 换成「枚举内计数 + 枚举外计数」两段，例如 `WAITING=1 BLOCKED=0 · 未识别 2`；`无识别行 + 0 行` 时写「本窗口没有会话」，不写「无异常」。

### 2.4 「项目名过长」这种现实问题

它用了**五种**手段，各有分工：

**① 宽度预算先扣掉所有固定列，再截断**（`SessionListRow.tsx:150-152`）：

```ts
const titleBudget = body - 2 - (mark === undefined ? 0 : 2) - 2
  - stringWidth(occupiedText) - stringWidth(currentText)
const shownTitle = truncateWidth(titleText, Math.max(4, titleBudget))
```

注意 `stringWidth` 而不是 `.length`——注释里写得很清楚：`SpreadRow` 的文档说「in Chinese a character is two columns wide — arithmetic on `.length` overstates the gap by the width of the text itself, so the row overflows and the terminal either wraps it (shifting every region below it down a line) or clips it (silently eating the right-hand segment). **Both failures are invisible to an English-only test.**」

**② 截断必须显式带省略号，且不能让 Ink 自己截**。`truncateWidth`（`sessions/format.ts:31`）的注释：

> Ink's own `wrap="truncate"` appends its ellipsis as soon as content is as wide as its box rather than wider, which silently eats the last character of a row laid out at its natural width.

也就是说：**恰好等宽时 Ink 会多截一个字符**。所以他们自己实现，且 `truncateToWidth`（`ink/truncateToWidth.ts`）按码点走，`truncateWidth` 按显示宽度走，两个都在。

**③ 被截断的内容一定要有出口：悬停浮层**（`SessionListRow.tsx:153-164`）：

```ts
const titleTooltip = useTooltip(() => {
  const parts: string[] = []
  if (occupied) parts.push(t('session-mount-occupied-short', { pid: occupiedPid }))
  if (shownTitle !== titleText) parts.push(titleText)     // 只有真被截断才放全文
  parts.push(formatAbsolute(session.updatedAt))
  if (session.cwd !== '') parts.push(session.cwd)
  const size = formatBytes(session.bytes)
  ...
  return parts.join('\n')
})
```

`Tooltip.tsx:20` 的契约：**只给真的被隐藏的文本挂浮层**；重复指针旁边已经看得见的内容是噪音。600ms 停留才弹。

**④ 路径用「中截断」而不是尾截断**（`utils/truncateMiddle.ts`）：保留头（盘符/根）和尾（文件名），中间换 `…`。落地页的双角铭牌用 Ink 原生的 `wrap="truncate-middle"`。

**⑤ 徽章宽度会谈判**（`HomeWorkspaceRow.tsx:60-72`）：

```ts
const missingBadge = `${t('home-workspace-missing')} · ${count}`
const compactMissingBadge = `${t('home-workspace-missing')} ${count}`
const minimumName = stringWidth(`${ring} ${historyOnly ? `${shortHistory} ` : ''}界…`)
const fits = (value) => stringWidth(value) + 1 + minimumName <= body
const badge = present ? count : fits(missingBadge) ? missingBadge : fits(compactMissingBadge) ? compactMissingBadge : `! ${count}`
```

三级降级：`缺失 · 3` → `缺失 3` → `! 3`。**先保名字可辨识，徽章让位**。

**⑥ 树形前缀从尾部保**（`SessionTree.tsx:126-133`）：

```ts
function clampPrefix(prefix, budget) {
  if (stringWidth(prefix) <= budget) return prefix
  if (budget <= 1) return '…'
  return `…${tailWidth(prefix, budget - 1)}`   // 窄屏牺牲最老的祖先，不牺牲紧邻条目的分支几何
}
```

#### 我们现在的实现（实测）

```text
D--Projects-Overwatch                                   ->  Projects/Overwatch
D--Projects-overwatch-tui                                ->  Projects/overwatch/tui     ← 「-tui」变成了子目录
C--Users-me-src-my-agent-thing                           ->  Users/me/src/my/agent/t…
```

`projectLabel()`（`oversight-tui.mjs:156-160`）干的是 `.replace(/^[A-Za-z]--/, '').replace(/-/g, '/')`——**把 Claude Code 的目录编码当成路径分隔符还原**。这在本机看起来对（因为 `D--Projects-Overwatch` 恰好对应 `D:` + `Projects` + `Overwatch` 三段），但项目名里本来就带连字符时（`my-agent-thing`）会画出**不存在的层级**。这是一个真实的、可复现的错误显示，不是审美问题。

正解不需要抄 dsh-TUI：`~/.claude/projects/<编码>/` 旁边的 `sessions/*.json` 里有原始 `cwd`，scan 也在读它（`liveToRow` 已经用 `live.cwd`）。**别从编码反推路径。**

### 2.5 详情视图

三套不同的详情形态，都值得看：

**A. 整屏 early-return 屏，不是模态栈。** `Chat.tsx` 里 Settings / SessionSupervisor / SessionTree / SubagentDetail / Trajectory 都是「整屏盖住」，`Esc` 返回，返回时**草稿、参数、焦点原样保留**（`docs/user-guide.md:68-71`）。

**B. 内部分「座位」而不是弹窗**（`SessionTree.tsx`）：`type Seat = 'tree' | 'menu' | 'confirm'`。选一个节点 → 同一个屏下半部分长出菜单；选一个危险动作 → 再长出确认行。**没有浮层、没有背景变暗、没有焦点陷阱**，因为终端没有这些。`MANDATORY_LINES = 6` 保证树、规则线、提示行在极矮终端也能排下，`RULE_PRIORITY = [2]` 说明装饰线是「第一个被矮屏撤掉的」。

**C. 分页 + 记忆**（`SubagentDetailScene.tsx`）：

- 头部（身份 + 统计）固定，正文分页：`summary` / `output` / `transcript` / `tools`。
- `←/→` 换页，**页面列表按能力生成**（没有 transcript 源就没有 Transcript 页）。
- 离开再回来时**恢复页码与滚动位置**，按 agentId 存 LRU 16 条（`subagentDetailMemory.ts`）；但「常规返回 Dashboard」会 `clear()`——只有主屏往返才恢复。

**D. 预览窗显示对话的「尾部」不是开头**（`SessionPreview.tsx:14-24`）：

> It shows the END of the conversation, not the beginning... The title already carries the beginning — it is usually the first prompt — so repeating it would spend the pane on something the list already said. And the question a person asks at this moment is "is this the one I was in the middle of", which only the last exchange answers.
> It is also the reason the pane costs nothing: the tail of a log is exactly what a bounded read already has in hand.

**这条对 Overwatch 是直接可用的**：我们的详情页现在把 `needs` / `suggestedReply` 放最上面，但在列表页里，**`needs` 的开头几个字才是判据**（「要我现在就把实测单交给你」vs「API 503」），而全文放在详情。反过来：详情页应该把 `needs` 的**尾部**也显示出来（很多 `needs` 结尾才是问题本身）。

**宽窄两套布局**（`SessionTree.tsx:151-153`）：`SPLIT_MIN_COLUMNS = 100`，≥100 列预览在右侧（宽度 `min(52, columns*0.38)`），<100 列预览变成底部 5 行。

---

## 3. 视觉语言

### 3.1 配色：语义角色 token，不是颜色名

`src/theme.ts` 1,503 行，`Theme` 类型有 **81 个键**，全是角色而不是颜色：`accent` / `text` / `inactive` / `subtle` / `suggestion` / `remember` / `success` / `error` / `warning` / `planMode` / `autoAccept` / `toolCardBackground` / `diffAdded` / `syntaxKeyword` / `contextBarPrompt` …

组件里写 `<Text color="suggestion">`，绝不写 `#ABC2EC`（`ThemedText.tsx:29-41` 负责解析）。

**dark 主题实测色值**（`theme.ts:325` 起）：

| 角色 | 值 | 用途 |
|---|---|---|
| `accent` | `#7DA1DE` | 品牌蓝（雾蓝家族） |
| `text` | `#E8E6E0` | 正文（暖白，不是纯白） |
| `inactive` | `#8D95A6` | 次要文字 / `dimColor` |
| `subtle` | `#5E6673` | 更暗的辅助（提示行、空状态） |
| `suggestion` | `#ABC2EC` | **焦点/悬停**（浅蓝） |
| `remember` | `#ABC2EC` | 焦点角色别名 |
| `success` | `#82B89D` | 雾绿（**选中**、完成） |
| `error` | `#DA8A93` | 柔玫瑰（**不是正红**，深色底上不刺眼） |
| `warning` | `#D8B270` | 柔琥珀 |
| `planMode` | `#7FAE99` | 灰鼠尾草绿 |
| `autoAccept` | `#B3A0D4` | 柔紫 |
| `toolCardBackground` | `#242B3A` | 卡片衬底 |
| `toolCardBackgroundDim` | `#1C2330` | 更深衬底 |

**light 主题**：`accent #3F6CC4` / `text #343945` / `inactive #8991A0` / `subtle #A6ADBA`。

**关键设计决定（`SessionListRow.tsx:179-183`，值得原样抄）：**

> Hover is the BLUE prompt — pointer feedback and nothing else. Selection is green and never blue: a row the keyboard cursor is on must not look like a row the mouse happens to be over, so the two never share a background and a selected row keeps its own colour while hovered.

也就是三条独立通道：
- **蓝 = 鼠标在这儿**（背景块）
- **绿 = 键盘选中的那一行**（前景文字 + `❯`）
- **dim = 非焦点**

我们现在的 TUI 用 `\x1b[7m`（反显）做选中——反显在浅色/深色终端上语义不稳定，而且和「悬停」共用同一个视觉通道（虽然我们还没有鼠标）。**至少应该把「选中」和「严重度」拆成两个通道**：现在 `FAILED` 是红色文字，选中是反显，两者叠在一起时用户看到的是「红字反显」——严重度和光标位置纠缠在同一个像素上。

**信号色刻意不用纯色**：`error` 是 `#DA8A93` 而不是 `#FF0000`。原因在 `theme.ts` 的注释里没写，但从整套色板看是一致的：深色底上的高饱和红会显得刺眼且丧失可读性，柔化后仍然语义明确。

### 3.2 字形：纯 Unicode 符号，**没有 Nerd Font**

我 grep 了整个 `src/` 的私用区（U+E000–U+F8FF）：**0 命中**。全部是普通 BMP 符号。

| 用途 | 字符 | 码位 | EAW |
|---|---|---|---|
| 焦点指针 | `❯` | U+276F | N（1 列） |
| 钉选 / 未钉选 | `★` `☆` | U+2605/2606 | A（1 列） |
| 工作 / 待输入 / 完成 / 失败 / 空闲 | `✽` `✻` `✓` `✕` `∙` | U+273D/273B/2713/2715/2219 | N/A/N/N/N |
| 被别的终端占用 | `⊘` | U+2298 | N |
| 子 agent / 分叉 | `⑂` `⑃` | U+2442/2443 | N |
| 选中 / 未选中环 | `▣` `▢` | U+25A3/25A2 | A/N |
| 分隔线 | `─` | U+2500 | 1 |
| 中缝 | `│` | U+2502 | 1 |
| 进度条 | `█` `▏▎▍▌▋▊▉` | U+2588 / 0x258F.. | A |
| 思考 spinner | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | U+280B… | N |
| **默认** spinner | `·` `•` `●`（4 帧呼吸） | U+00B7/2022/25CF | A/A/A |
| 状态图标 | `✔` `✘` `⚠` `ℹ` `◯` | 来自 `figures` 包 | — |
| 会话种类 | `user: ` / `assistant: ` / `[compact] ` | 纯文本前缀 | — |

`src/terminal-utils/figures.ts` 只放「有活跃消费者」的符号，注释：「Keep this module limited to symbols with active consumers so each visual mark has one clear meaning.」

**默认 spinner 是 `['·','•','●','•']` 而不是 braille**（`Spinner/spinnerUtils.ts:12-16`）：

> A calm breathing dot: every frame is one display cell, including in narrow CJK terminals, and no platform-specific glyph set is needed.

**这对我们是直接可用的**：我们现在的 `●`（PRODUCING）和 `○`（EXPLORING）在灰度下靠实/空区分，但 `●` 正好被 dsh-TUI 用做动画帧——**同一个字形在不同上下文里语义不同，这是它们的债；我们不必学**。

**它踩过的坑值得抄（我们已经在 `tui-visual.md` §3.1 踩过同一次）**：
- `✕`（U+2715）与 `◐`（U+25D0）在 conhost 下是豆腐块 → 换成 `×` 与 `○`。
- `⚓`（U+2693，Terracotta 的 thinking 完成标记）**EAW=W**，是 2 列，而 `✳`/`⚠` 这类 **EAW=N（1 列）** 被 `emoji-regex` 匹配到并被错误地算 2 列。`stringWidth.ts:126-140` 的注释：

> Text-default emoji (✳ U+2733, ⚠ U+26A0, ❤ U+2764, ❄ U+2744, ✂ U+2702 …) render width 1 in terminals (ghostty/kitty/iTerm2/xterm.js all agree) unless VS16 forces emoji presentation. emoji-regex matches BOTH categories, so counting every match as 2 desyncs the layout from the terminal: the spinner glyph ✳ measured 2 but painted 1, shifting the whole spinner row 1 column every time the animation cycle hit it.

**它们的解法的量级**：`stringWidth.ts` 266 行，内含一张手抄的 `Emoji_Presentation=Yes` 区间表（约 60 行，二分查找）。见 §5.3。

### 3.3 间距与对齐

| 规则 | 值 | 证据 |
|---|---|---|
| 页边距 | 左右 2 列 / 上下 1 行（`normal`，可配 `none`/`slim`/`normal`/`roomy`/`NxM`） | `tuiDisplayPrefs.ts:236-243` |
| 行内固定格 | 焦点标记 2 列、钉选 2 列（`★/☆`）、状态 2 列 | `SessionListRow.tsx:186-193` |
| 行内间隙 | `gap={1}`（`ListItem`）/ `' · '`（`Byline`） | `ListItem.tsx:140` |
| 树缩进 | 每级 3 格（`│  ` / `├─ ` / `└─ `） | `SessionTree.tsx:107-124` |
| 会话行第二行缩进 | `indent + 2`（与标题列对齐） | `SessionListRow.tsx:237` |
| 面板内边距 | `paddingX={2}` | `Pane.tsx` |
| 卡片/浮层 | `borderStyle="round"` + `borderColor="permission"` | `SessionSupervisor.tsx:906-910` |

**「恒 2 列」是最重要的一条**（`SessionListRow.tsx:136-140`）：

> The state cell holds EXACTLY two columns on every row, occupied or not, for the same reason the pin slot does: a column that appears only when a session is busy would shift every title on screen each time one starts or stops working.

对照我们：状态列 `padEnd(9)` + 项目列 `fitWidth(..., 24)`——**宽度是固定的**，但同时最多只显示 3 个字段（`cols>=44/56/66/78` 逐级加），而且 `fitWidth` 在表里按 `displayWidth(cut)` 补空格。**这一块其实做得不错**，问题在宽度函数本身（§5.3）。

### 3.4 视觉层次

四层，靠**字重 + 颜色 + 缩进**同时区分：

| 层 | 表现 | 例 |
|---|---|---|
| 屏标题 | `bold` + `remember`（蓝） | ` ▣ 会话管理` |
| 区块标题 | `bold` + `remember` | ` Overwatch 的会话` |
| 计数/元数据 | 默认色 / `dimColor` | `0 运行中 · 0 个活跃 · 共 12` |
| 提示/空状态 | `dimColor` + `italic` | `这个工作区还没有会话 · Enter 新建一个` |
| 按键提示 | `dimColor` + `italic` + 主键 `bold` | `←/→ 切换栏位 · **Enter** 进入会话 · Esc 返回` |

最后一行是 `HintLine` 的 `**` 强调约定（`HintLine.tsx`，20 行）：

```tsx
const parts = text.split('**')
if (parts.length < 3) return <>{text}</>
return <>{parts.map((part, index) => index % 2 === 1 ? <Text key={index} bold>{part}</Text> : part)}</>
```

**文案在 i18n 字典里而不是组件里**，所以「主键加粗」是翻译者能控制的。这是零依赖也能做的一件事：把 `**Enter** 详情` 这种写法搬进我们的 `HINT_LIST` 常量即可（约 8 行代码）。

**标题颜色按「知道多少」分级**（`sessions/format.ts:251-260`）：

```ts
export function titleColor(source: TitleSource, focused: boolean): keyof Theme {
  if (focused) return 'success'
  if (source === 'fallback') return 'subtle'   // 只有目录名可读，最暗
  if (source === 'prompt') return 'inactive'   // 首句 prompt 摘录
  return 'text'                                 // 真实标题
}
```

「这条会话的名字有多可信」被编码成了颜色。对我们的 `reason` 字段（宿主事实 vs 推断）**同构可用**。

---

## 4. 交互模型

### 4.1 键位（会话管理屏全量，`SessionSupervisor.tsx:248-479`）

| 键 | 行为 | 备注 |
|---|---|---|
| `←` | 键盘交左栏 | 一个 `❯` 的规则 |
| `→` | 键盘交右栏 | |
| `↑` / `↓` / 滚轮 | 当前栏上/下移 | 滚轮等同方向键 |
| `PgUp` / `PgDn` | 翻页（等同上下 1 格，因为行高 2） | |
| 任意可打印字符 | **直接进入筛选并追加** | 无独立模式 |
| `Backspace` / `Delete` | 退格；从非筛选态按也直接进筛选 | |
| `Enter` | 右栏：第 0 行 = 新建，其余 = 打开；左栏：打开工作区菜单 | |
| `Ctrl/Cmd+Enter` | 在左栏 = 在该工作区新建 | |
| `Tab` / `Shift+Tab` | 切来源标签（DSH / Claude Code / Codex） | 切标签会清筛选 |
| `Ctrl+N` | 在当前工作区新建会话 | |
| `Ctrl+L` | 重读列表（重扫） | |
| `Ctrl+X` | 停掉光标所在的**后台**会话 | 当前终端在用的停不了 |
| `Ctrl+R` / `Ctrl+D` | 非 DSH 后端：重命名 / 删除 | 走该后端的 catalog |
| `Esc` | 三层：关提示 → 清筛选 → 离开本屏 | |
| `q` / `Ctrl+C` | 退出 | |

**模态层优先级的写法值得抄**（`SessionSupervisor.tsx:249-353`）：`useInput` 里按「渲染顺序」依次短路——

```ts
if (renaming !== undefined) { ...; return }
if (confirmDelete !== undefined) { ...; return }
if (rename !== undefined) { ...; return }
if (confirmRemove !== undefined) { ...; return }
if (menuRef.current !== undefined) { ...; return }
if (tabMenuRef.current !== undefined) { ...; return }
// 到这里才是主屏
```

**注意 `menuRef.current` 而不是 `menu`**：注释说「keystrokes that arrive in one batch (typing, then Enter) must commit everything typed, not the last render」。这是 React 状态在终端 raw-mode 下的真实竞态。

### 4.2 导航模型：平铺 + 单一所有权，不是层级栈

- **屏之间是替换关系**（`Chat` 的 early-return），不是栈。`Esc` 回上一层，但不保留中间态（除了草稿）。
- **屏内是「唯一焦点 + 显式所有权转移」**：`activePane: 'rail' | 'list'`，`←/→` 改它，屏幕上永远只有一个 `❯`。
- **屏内的菜单是「座位」不是浮层**：`SessionTree` 的 tree/menu/confirm 三态。

**为什么这对我们是关键**：我们现在的列表/详情/帮助是 `mode` 字符串，`Esc` 从 detail 回 list。这是同一套思路，只是**缺一个「屏内座位」概念**——我们把「会话列表」和「某个会话的详情」做成了两屏，而 dsh-TUI 把「列表 + 该行的操作菜单」做成一屏的两个座位。后者少一次跳转、少一次状态保存。

### 4.3 搜索/过滤

- **实时、无模式、子串**，跨 `title/label/cwd/branch/model`。
- 筛选态下**按键提示会换**（`supervisor-hint-filter`：「输入过滤会话 · Enter 进入 · Esc 清空」）。
- 筛选无命中时不隐藏「新建会话」卡片——**它永远是第 0 行**（`SessionSupervisor.tsx:757-765` 的注释）：

> It is also the only affordance that works when the pane is EMPTY, which is exactly when the list has nothing to offer. It sits above the scroll window on purpose, so it never scrolls away.

- **光标 ID 化 + 筛选后不落到危险行**（`useSessionSupervisor.ts:520-530`）：

```ts
const byId = visibleSessions.findIndex(session => session.id === focusSessionId)
if (byId >= 0) return byId + 1
// The focused session is not on screen (the filter removed it). The cursor
// must still stand on a REAL row, because Enter acts on whatever it stands
// on: landing on the card would turn "search, then Enter" into "start a new
// session" — an action the user never asked for.
return visibleSessions.length === 0 ? 0 : 1
```

**这条是我们的一个现成 bug**：我们的 `this.selected` 是**下标**（`oversight-tui.mjs:728 / 886 / 910 / 973`），而行序每次渲染都重排。实测：

```text
t0: 选中下标 0 → 指向 "b"（idle=400）
t1: 新数据下来，a 的 idle 涨到 500 → 排序变成 [a, b]，下标 0 现在指向 "a"
```

如果此时按 `c`（复制草稿）或 `Enter`，**复制的是另一条会话的草稿**。这个 bug 在 8 秒轮询下会稳定复现。

### 4.4 实时刷新

**两套节奏，刻意分开**（`useSessionSupervisor.ts:333-346`）：

```ts
React.useEffect(() => {
  const timer = setInterval(() => setPulse(value => value + 1), 2000)
  return () => clearInterval(timer)
}, [])
```

> One cheap tick that re-derives live status and cross-process occupancy. **Deliberately NOT a re-listing**: the listing is the expensive part (a stat per session and a revision-keyed digest), while status and occupancy are two in-memory reads over data the process already holds.

- **2 秒**：重算「谁在跑 / 谁被别的终端占了」——纯内存读，不碰磁盘。
- **重列表**：只在打开、`Ctrl+L`、会话切换时。**不自动**。

**列表本身是渐进式的**（`dsh-adapter/sessions/list.ts:362-368`）：

```ts
if (records.length % 32 === 0 || (records.length === workspace.size && records.length < listed.length)) {
  if (listingVersions.get(identity) === version) onPartial?.(records.map(summaryOf).sort(compareSummaries))
  await new Promise<void>(resolve => setImmediate(resolve))
  signal?.throwIfAborted()
}
```

每 32 条让出事件循环一次，把当前结果推给 UI（当前工作区先推）。注释：「A small workspace must paint before we touch another project's logs.」

**首帧来自快照而不是占位符**（`useSessionSupervisor.ts:117-131`）：`cachedSessions()` 同步读上一次的持久化快照，所以重启后第一帧就是真数据；`loading` 只在**真的没有快照**时为 true。

**但我们这边的情况正相反**：`defaultScan` 是 `execFile` 一次性拿全量 stdout（`oversight-tui.mjs:232-267`），扫描期间只有 `pendingLines()` 的静态文案 + 每秒重绘的「已等待 Ns」。**26 秒的空白屏**。

**这一条是 dsh-TUI 给出的最有价值的一条，且与依赖无关**：把「长任务」拆成「可先画的一部分 + 增量推送」，第一帧必须有内容。我们的 scan 已经在遍历目录，把每扫完一个 project 目录就往 stderr 打一行 JSON，TUI 边读边画——**零依赖，`spawn` + `stdio: ['ignore','pipe','inherit']` 就够**。

---

## 5. 实现细节（可抄的）

### 5.1 终端 resize

**同步处理，明确禁用 debounce**（`ink/ink.tsx:454-460`）：

> NOT debounced. A debounce opens a window where stdout.columns is NEW but this.terminalColumns/Yoga are OLD — any scheduleRender during that window (spinner, clock) makes log-update detect a width change and clear the screen, then the debounce fires and clears again (**double blank→paint flicker**).

`handleResize` 做的事，按顺序：

1. 尺寸没变（ConPTY 最大化会重建 alt buffer 但不改网格）→ 只在 win32/WT 打一次 `needsSurfaceRepaint`。
2. 尺寸变了 → `noteFrameCause('resize')`。
3. `clearHovered(this.hoveredNodes)` + `resetPointerState()` —— **先触发 hover 的 leave 回调再清集合**，否则被跨过的行会永久停在 `hovered=true`（stuck highlight）。
4. `renderGeneration++`，`scheduleRender.cancel?.()`，清 drain timer —— 作废所有按旧尺寸排队的工作，否则「按旧宽度算的一帧」会在 resize 之后画出来（混合宽度行）。
5. `dom.markTreeDirty(this.rootNode)` —— **显式把整棵树标脏**。注释解释得很准确：这里没有任何节点「在 reconciler 意义上脏了」（props 没变），但每个缓存的测量值都是按旧宽度算的；`markDirty` 是从变动节点向上走的，而这里的变动是**所有节点共享的约束**。
6. `scheduleRender()`。

**给我们的一点观察**：我们每次 `render()` 都按当前 `width()/height()` 全量重画 30 行（`\x1b[H` + 每行 `\x1b[K` + 末尾 `\x1b[J`，`oversight-tui.mjs:947-955`），所以**我们没有缓存失效问题**——resize 天然正确。代价是全量重绘，但 30 行 × 1Hz 完全付得起。**这一块我们不需要抄，抄了反而更糟。**

顺便一条**实测**：`truncateToWidth`（`oversight-tui.mjs:87`）对每一层循环都调 `displayWidth(out + cp)`，也就是**每次追加都重算整个前缀**，复杂度是 O(n²)。实测 100/400/1600/6400 个中文字符分别 **0.60 / 0.33 / 0.66 / 1.49 ms/call**（100 那条受 JIT 冷启动影响，看趋势）。长 `needs` 或长 `reason` 在 40 列终端上每帧被截断一次，6400 字要 1.5 ms——1Hz 无所谓，但如果按 dsh-TUI 那样做 60fps 就会成为瓶颈。**修法是累加而不是重算**（dsh-TUI 的 `truncateToWidth` 就是这么写的：`for (const char of text) { const w = stringWidth(char); if (width + w > max) break; width += w }`）。这是一处**零风险、10 行**的改进。

### 5.2 无闪烁重绘

它的三层机制，从底到顶：

**① 单元格缓冲 + 逐格差分**（`src/ink/screen.ts`，2,247 行）。
`Screen` 是 `Int32Array`，每个单元格两个 int：`(styleId, charId|width)`；字符池与风格池做 intern，所以比较是**整数比较**：

```ts
function findNextDiff(a: Int32Array, b: Int32Array, w0: number, count: number): number {
  for (let i = 0; i < count; i++, w0 += 2) {
    const w1 = w0 | 1
    if (a[w0] !== b[w0] || a[w1] !== b[w1]) return i
  }
  return count
}
```

`diffEach` 还带 **damage rect**（只扫上一帧/这一帧声明变动过的矩形），以及宽高变化时的 `diffDifferentWidth` 分支。

**② patch 合并/抵消**（`src/ink/optimizer.ts`，95 行，纯函数）。规则写在文件头：删空 stdout、合并连续 cursorMove、删 (0,0) cursorMove、拼接相邻 styleStr、去掉重复 hyperlink、**成对的 cursorHide/cursorShow 互相抵消**、删 count=0 的 clear。

**③ 原子帧**（`isSynchronizedOutputSupported()`，`terminal.ts:131`）：
终端支持 DEC 2026（BSU/ESU）时，整帧包在 `\x1b[?2026h ... \x1b[?2026l` 里，终端要么全画要么不画。能力表是手写的 env 白名单（iTerm2 / WezTerm / Warp / ghostty / contour / vscode / alacritty / kitty / foot / Zed / WT / VTE≥0.68 / JetBrains），**tmux 下主动关闭**（tmux 会切块转字节，原子性已破）。有 `DSH_TUI_TMUX_TRUECOLOR` 之类的逃生开关。

**④ 16ms 节流**（`ink/constants.ts:2`）：
```ts
export const FRAME_INTERVAL_MS = 16
```

`throttle(deferredRender, FRAME_INTERVAL_MS, { leading: true, trailing: true })`。

**⑤ 降级路径**（`frame.ts:138`）：`shouldClearScreen` 只在三种情况允许整屏清：resize、当前帧溢出视口、上一帧溢出视口。其余一律走差分。

**我们能抄的是 ③ 的一个子集，而且是零依赖的**：

```js
// 一帧写完再让终端刷，避免「画了一半」被看见
const SYNC = process.env.TMUX ? '' : '\x1b[?2026h';
const SYNC_END = process.env.TMUX ? '' : '\x1b[?2026l';
```

**但说实话：我们现在 1Hz 全量重绘 30 行，肉眼看不到闪烁。这一条优先级最低。**

**真正值得抄的是 ② 的思路的反面**：dsh-TUI 花 2,247 行做差分，是因为它要做 60fps 流式对话。**我们的场景里，「慢刷新但完整」比「快刷新但有残影」重要**。我们现在的 `fitLine` 会把每行补到 `width`，然后 `\x1b[K` 再清一次——这是冗余的但无害。

### 5.3 中文字符宽度（**最重要的一条**）

**它的问题定义**（`ink/stringWidth.ts:1-20`）：

> This is a more accurate alternative to the string-width package that correctly handles characters like ⚠ (U+26A0) which string-width incorrectly reports as width 2.
> The implementation uses eastAsianWidth directly with **`ambiguousAsWide: false`**, which correctly treats ambiguous-width characters as narrow (width 1) as recommended by the Unicode standard for Western contexts.

**它的实现**（266 行，五个分支）：

1. 纯 ASCII 快路径（逐 `charCodeAt`，`> 0x1f` 计数）。**这是性能关键**：15 行英文列表 90% 走这里。
2. 含 `\x1b` → `stripAnsi`。
3. 不含 emoji/VS/ZWJ → 逐码点 `eastAsianWidth(cp, {ambiguousAsWide:false})`。
4. 否则 → `Intl.Segmenter` 按 grapheme 切，emoji 用 `getEmojiWidth`：
   - 区域指示符（国旗）：单个 1，成对 2。
   - keycap 不完整（digit+VS16 无 U+20E3）：1。
   - **单码点无 VS16 且不在 `Emoji_Presentation=Yes` 区间表里 → 1**（这就是 `⚠` / `✳` / `✂` 的正确宽度）。
   - 其余 2。
5. 零宽：C0/C1、软连字符、ZWSP/ZWJ、BOM、变体选择符、组合附加符、印度系组合符、泰/老挝组合符、阿拉伯格式符、代理区、tag 字符。

**关联的截断函数**（`ink/truncateToWidth.ts`，18 行）：

```ts
export function truncateToWidth(text: string, maxWidth: number): string {
  let width = 0
  let out = ''
  for (const char of text) {          // 按码点迭代 → CJK 不会被劈开
    const charWidth = stringWidth(char)
    if (width + charWidth > maxWidth) break
    width += charWidth
    out += char
  }
  return out
}
```

加上 `sessions/format.ts:31` 的 `truncateWidth`（保留 `…` 的 1 列预算）、`:100` 的 `tailWidth`（保留尾部）、`utils/truncateMiddle.ts`（保留头尾）、`wrapPathWidth`（按 grapheme 换行）。

---

#### **我们的现状：实测 22 例，9 例错**

我把 `scripts/tui-theme.mjs` 的 `displayWidth` 拉出来，跟 Unicode `EastAsianWidth.txt`（我下了 `ucd/latest`）逐个对：

```text
BAD  ⚓ U+2693  got=1 exp=2     ← EAW=W
BAD  ⚪ U+26AA  got=1 exp=2     ← EAW=W
BAD  🟡 U+1F7E1 got=1 exp=2     ← EAW=W
BAD  🟢 U+1F7E2 got=1 exp=2     ← EAW=W
BAD  🟣 U+1F7E3 got=1 exp=2     ← EAW=W
BAD  ✅ U+2705  got=1 exp=2     ← EAW=W
BAD  ⚡ U+26A1  got=1 exp=2     ← EAW=W
BAD  ⌚ U+231A  got=1 exp=2     ← EAW=W
BAD  👍🏻 U+1F44D U+1F3FB got=4 exp=2   ← 把「肤色修饰符」当成独立 2 列
ok   ★ ✕ ▲ ● ○ ❯ ⠋ 🔵 😀 👨‍👩‍👧 1️⃣ 🇨🇳 🔟
```

**根因两条：**

1. `WIDE` 区间表（`tui-theme.mjs:143-166`）只有 **20** 段，`U+1F300–1F64F` / `1F680–1F6FF` / `1F900–1F9FF` / `1FA70–1FAFF` 这些**大区间被整段算 2**，但 `1F7E0–1F7EB`（圆形色块）根本不在表里 → `🟡🟢🟣` 落到 1。`26AA–26AB`、`2300–23FF` 的 W 项（`⌚⚡` 在 `231A`、`26A1`）也没覆盖。
2. **没有 grapheme 聚类**：`measure()` 逐个码点走，`👍🏻` 变成 `1F44D`(2) + `1F3FB`(2) = 4，而终端按 emoji 序列画 2 列。`👨‍👩‍👧` 靠 ZWJ 逻辑碰巧对了，`e\u0301` 靠组合符区间对了，但肤色/发色修饰符（`1F3FB–1F3FF`，EAW=W）没有这条逻辑。

**这已经在生产代码里造成可见问题**：`watch.mjs` 的通知文本有 `⚠ ✋ ❓ ✖ 📋`，其中 `📋`（U+1F4CB，EAW=W）算 2 是对的，其余算 1 也是对的——**侥幸**。但 `padDisplay` 一旦碰到 `⚓`（dsh-TUI 用它做思考完成标记，我们可能也想用）就会多补 1 格空格，右边界推歪。`watch.test.mjs` 的 `⚠` 用例测不到这个，因为它恰好落在对的一侧。

**修法（零依赖）：**

1. **宽度表换成 EAW 的 W/F 全集**，不要手抄「WIDE 区间」。`EastAsianWidth.txt` 里 W/F 类共 **298 段**（我数过），压缩成不重叠区间表约 300 行——它是一个**数据文件**，可以生成后入库，不必每次手写。现有 `WIDE` 表只有 **20 段**。dsh-TUI 用的是 `get-east-asian-width`（MIT，14.7 KB），我们**可以用同一份 UCD 数据，自己生成表**，功能等价。
2. **加 grapheme 聚类**：`Intl.Segmenter('en', {granularity:'grapheme'})` 是 **Node 内置**（本机 Node 26 实测可用；它在 V8 里，Node 18+ 全系都有，但请在你的最低 Node 版本上跑一次 `typeof Intl.Segmenter` 再拍板）。按 cluster 算宽度：
   - cluster 里含 ZWJ 或 VS16 → 2；
   - cluster 是「基字符 + 修饰符（`1F3FB–1F3FF` / `FE00–FE0F` / `20E3`）」→ 按基字字符算；
   - 其余按码点累加。
3. **emoji 表**：把 dsh-TUI 的 `EMOJI_PRESENTATION_RANGES`（`stringWidth.ts:151-171`，**21 行**、约 90 个区间、纯数据）抄过来，或从 UCD `emoji-data.txt` 生成。这张表的存在意义是：`emoji-regex` 会匹配 `✳ ⚠ ✂ ❤ ❄` 这些**文本默认**符号，把它们算 2 列是错的。

**为什么不直接抄 `stringWidth.ts` 本体**：它 `import emojiRegex from 'emoji-regex'` + `import { eastAsianWidth } from 'get-east-asian-width'` + `import stripAnsi from 'strip-ansi'` —— 三个 npm 包。**逻辑可抄，import 不可抄**：`emoji-regex` 换成静态区间表，`get-east-asian-width` 换成生成好的表，`strip-ansi` 我们已经有自己的 `ANSI_RE`。

**已有证据支持「改」而不是「不改」**：`docs/spec/tui-visual.md` §5.4 自己写了「该宽度表……**不是完整的 `wcwidth` 实现**」，并承认「未处理印度系等复杂文字的连字簇（可能少算）」。这是一条**已声明的偏差**，但 `⚓🟡⚪` 这类**整数错误**不是偏差，是 bug。

### 5.4 降级

它有四层降级，**顺序是明确的**：

**① 非 TTY**：`resolveTuiHostMode()`（`dsh-adapter/plugin.ts:196-207`）：

```ts
export function resolveTuiHostMode(stdoutIsTTY = process.stdout.isTTY === true, env = process.env): TuiHostMode {
  if (stdoutIsTTY) return 'interactive'
  const explicitTuiLaunch = env.DSH_TUI_LAUNCHER_VERSION !== undefined || isStandaloneRuntime()
  return explicitTuiLaunch ? 'invalid-explicit-launch' : 'headless-host'
}
```

- **显式启动但非 TTY** → **抛错**（`dsh-tui requires an interactive terminal (stdout must be a TTY).`）。**不静默降级。**
- **被宿主当作插件加载、非 TTY** → **静默跳过挂载**，记一条 log，让宿主继续启动。
- 渲染器内部还有第三套：`log-update.ts:192` 在 `!isTTY` 时走 `renderFullFrame`（不差分，直接全量字符串）——但这条路在插件层已经被挡住了。

**这条对我们是直接可抄的纪律**：两种「非 TTY」语义完全不同 —— **用户主动跑了命令却没终端** → 应该报错（我们已经是 `printPlain` 快照，这更好）；**被别的程序顺带加载** → 应该安静跳过。我们现在的 `main()` 是在 `!stdout.isTTY` 时打快照退出（`oversight-tui.mjs:1146+`），属于第一类，正确。

**② 无颜色**：走 chalk 的检测 + `colorize.ts` 的两个特例修正：
- **xterm.js 宿主（VS Code / Cursor）不设 `COLORTERM=truecolor`**，chalk 落到 256 色，`rgb(215,119,87)` 被渲成 `rgb(215,135,135)` —— 「washed-out salmon」。修法是检测 `TERM_PROGRAM=vscode || WT_SESSION` 时把 `chalk.level` 从 2 提到 3。
- **tmux 会解析 truecolor 但不转发**，除非用户配了 `terminal-overrides :Tc`。默认**钳到 256 色**（`\x1b[48;5;Nm`），有 `DSH_TUI_TMUX_TRUECOLOR` 逃生。

再看主题层：`dark-ansi` 是一个**完整的 16 色回退色板**（`theme.ts:880` 起，81 个键全部映射到 `ansi:xxx`），不是「去掉颜色」。也就是说：**降级是换一套色值，不是丢掉语义**。

对照我们的 `colorEnabled()`（`tui-theme.mjs` §4）：`!isTTY` / `NO_COLOR` / `TERM=dumb` 三条件。**我们的三条件跟它的判断一致**，但我们只有 8 色 + 灰（`SGR` 表 6 项），没有 16 色回退——因为我们的目标色板本来就是 8 色。**这一块不需要改。**

**③ 极窄终端**：两套独立的阶梯，**都是纯函数、都能被单测钉住**。

横向（`StatusLine` 插件字段）：`minColumns` 逐字段声明，`columns >= field.minColumns` 才画。

纵向（`launchpadLayout.ts`，261 行）——**这是最值得抄的一份**。它把「先撤什么」写成了一张表：

```ts
const stages = [
  { stage: 'full', breath: true,  gap: true,  rows: core + HERO_TO_CARD_GAP + gapRows + HINTS_ROWS + TIP_BLOCK_ROWS },
  { stage: 'full', breath: false, gap: true,  rows: ... },
  { stage: 'full', breath: true,  gap: false, rows: ... },
  { stage: 'full', breath: false, gap: false, rows: ... },
  { stage: 'no-tip',  ... },   // 撤 Tips 行（最可省的一句闲话）
  { stage: 'no-tip',  ... },
  { stage: 'no-tip',  ... },
  { stage: 'no-hints', ... },  // 撤键帽行
  { stage: 'no-art',  ... },   // 撤 13 行立绘
  { stage: 'input-only', ... } // 只留标题 + 输入框 + 双角铭牌
]
for (const candidate of stages) if (candidate.rows <= rows) return candidate
return 'input-only'   // 连它都放不下：宁可溢出也不把输入框藏起来
```

注释里有两句话是整个文件的价值所在：

> - **留白是刻意的呼吸感，不是遗漏**；所有留白永远排在 Tips/入口行之前撤。
> - 默认落到最省的那一档……**宁可溢出也不把输入框藏起来**——这一屏存在的理由就是能敲进去第一句。

**「宁可溢出，也不藏掉这一屏存在的理由」**——我们的列表屏的存在理由是「看见谁在等我」。极窄/极矮时该撤的是项目名、时间、novelty，**不是状态或 needs 的第一句**。

**④ 极简 UI 模式**：一个进程级布尔 `isMinimalUiMode()`（`src/minimalUiMode.ts`，44 行），关掉 splash / emoji 状态字形 / 非工具的文字颜色 / 状态栏附加项。**保留**代码高亮与工具名颜色。

对照我们：`tui-visual.md` 的三通道原则（字形 / 颜色 / 文字标签）其实**比 dsh-TUI 更严格**——我们要求任何一条通道失效后另两条仍可区分。dsh-TUI 没有这条约束，它的 `🟡🟢🔴` 状态球**只靠颜色**（`SubagentCard.tsx:31-37`），关色后全变成 `·`/`○`/`◇`/`…`/`×`（minimalUi 分支）——也就是说它靠**两套并行的字形表**来解决问题，不是靠「同一字形多通道」。**我们应该保留自己的原则，不抄它的状态球。**

### 5.5 依赖：能不能接受

| 包 | 版本 | 用途 | 我们能接受吗 |
|---|---|---|---|
| `react` + `react-reconciler` | 19.2 / 0.34 | 组件模型 | **不能**。为 30 行只读输出引入 reconciler 是数量级错配。 |
| `chalk` | 6 | 颜色 + 能力检测 | **不需要**。我们已有 `paint()` + `colorEnabled()`，6 行。 |
| `@alcalzone/ansi-tokenize` | 0.3 | 解析/差分 ANSI 码 | **不需要**。我们不差分。 |
| `wrap-ansi` | 10 | 按显示宽度折行 | **不需要**。我们自己有 `wrapToWidth`。 |
| `get-east-asian-width` | 1 | EAW 查询 | **不需要，但需要它的数据**。见 §5.3。 |
| `emoji-regex` | 11 | emoji 识别 | **不需要**。用 `Emoji_Presentation` 区间表。 |
| `strip-ansi` | 7 | 去 ANSI | **已有**（`tui-theme.mjs` 的 `ANSI_RE`，同时处理 CSI 与 OSC）。 |
| `figures` | 6 | 状态符号 + Windows 回退 | **不需要**。我们 5 个状态字形已经定死了。 |
| `cli-boxes` | 4 | 边框字符集 | **不需要**。我们用 `┌─┐│└┘`。 |
| `cli-highlight` / `highlight.js` / `marked` / `lovely-mermaid` | — | Markdown/代码高亮/Mermaid | 完全不适用。 |
| `sixel` / 终端图像协议 | 0.16 | 图片 | 完全不适用。 |
| `ws` / `zod` / `semver` / `yaml` / `lodash-es` / `diff` / `signal-exit` / `auto-bind` / `bidi-js` / `stack-utils` / `supports-hyperlinks` / `type-fest` / `usehooks-ts` / `code-excerpt` / `indent-string` | — | 各自服务于「完整客户端」的某一块 | 完全不适用。 |
| `@xterm/headless` | 6（**devDependency**） | 内存终端，用于回归里读「画出来的格子」 | **值得破例**。见 §7。 |

---

## 6. 明确回答：能抄什么

| 特性 | 它能用吗 | 我们能抄吗 | 为什么 |
|---|---|---|---|
| **布局数学纯函数化**（`listWindow` 49 行 / `spreadRow` 30 行 / `truncateWidth` 25 行 / `tailWidth` 20 行 / `fitHint` / `resolveLaunchpadLayout` 261 行） | ✅ 生产核心 | ✅ **整段可抄** | 零依赖、纯函数、有单测。这正是我们最缺的一层：我们现在把「宽度、截断、居中」写在 `buildFrame()` 里面，**无法单测**。 |
| **固定列宽 + 空着也占位**（状态格恒 2 列、钉选格恒 2 列） | ✅ | ✅ **必抄** | 一条会「出现/消失」的列会让整屏标题每次状态变化都抖一下。我们的事件行也有这个问题（`calls/nov/novelty` 按 `cols>=44/56/66/78` 整块出现），但那是整字段不是单列，影响小。 |
| **光标是 ID 不是下标**（`selectedId` / `focusSessionId`） | ✅ | ✅ **必抄（修 bug）** | 我们的 `this.selected` 是下标，重排后指向另一条会话。按 `c` 会复制错人的草稿（§4.3 已实测）。 |
| **筛选后光标不落到创建/破坏行** | ✅ | ✅ **必抄** | 「搜索然后回车」绝不能变成「新建会话」。 |
| **`Esc` 三层**（关提示 → 清筛选 → 离开） | ✅ | ✅ **可抄** | 我们目前 `Esc` 是「detail → list → 退出」。「清筛选」我们还没有筛选，将来加时照抄。 |
| **蓝=悬停 / 绿=选中，永不共用通道** | ✅ | ✅ **可抄** | 我们现在「选中 = 反显」，效果上还行，但跟我们「三通道」原则冲突：反显把**颜色**和**位置**绑在同一个像素上。改成「选中 = 绿色 `❯` + 绿色文字」更稳。 |
| **永久提示槽**（一行恒占位，静默时空白） | ✅ | ✅ **可抄** | 我们的 `showNotice()` 目前是覆盖状态行的一个字段——**通知到达时状态行会变长/变短，整屏行号跟着变**。改成独立恒占位行可以消除这个抖动。 |
| **提示行 `**主键**` 加粗** | ✅ | ✅ **可抄** | 20 行实现。 |
| **纵向降级阶梯表**（6 档，明确排「先撤什么」） | ✅ | ✅ **可抄** | 我们目前没有「终端变矮怎么办」——固定 30 行输出，矮了就滚出屏幕。 |
| **标题色 = 可信度分级** | ✅ | ✅ **可抄** | 我们的 `reason` 分「宿主事实 / 推断」，可以对应成两档颜色。 |
| **预览显示尾部而非开头** | ✅ | ✅ **可抄** | 详情页应该同时显示 `needs` 的头和尾。 |
| **渐进式列表（每 32 条 yield + partial 回调）** | ✅ | ✅ **可抄** | 我们 26 秒首扫是当前最大的体验缺陷。零依赖可做。 |
| **快照首帧**（先画上次的持久化结果） | ✅ | ✅ **可抄** | 我们有 `tasks/runs/`；可以把上次 scan 的 JSON 存成快照，打开即画。 |
| **两套刷新节奏**（2s 算状态不重列表 / 重列表只在显式动作） | ✅ | ✅ **可抄** | 我们现在 8s 一次全量重扫。**改法和它的不同**：我们的 scan 是子进程，重扫必须付 26 秒，所以「只算状态」对我们更有价值。 |
| **非 TTY 两种语义分流** | ✅ | ⚠️ **部分可抄** | 我们已经打快照退出，比它更诚实。缺的是「被别的程序加载时静默」——我们现在不提供这个用法。 |
| **16 色 ANSI 回退色板** | ✅ | ⚠️ **不抄** | 我们的目标色板本来就是 8 色。 |
| **单元格差分 + patch 合并**（`screen.ts` 2,247 + `optimizer.ts` 95） | ✅ | ❌ **不抄** | 30 行 × 1Hz，全量重绘的字节数比差分逻辑的复杂度便宜得多。 |
| **BSU/ESU 原子帧**（DEC 2026） | ✅ | ⚠️ **可选，优先级最低** | 2 行代码，但我们 1Hz 全量重绘肉眼看不出闪烁。 |
| **自建 Ink + yoga 移植**（39,773 行） | ✅ | ❌ **绝不能抄** | 那是「做一个 TUI 框架」的工程量，不是「做一个 TUI」的。 |
| **React + reconciler** | ✅ | ❌ **不抄** | 见 §7。 |
| **状态球 `🟡🟢🔴`** | ✅ | ❌ **不抄** | **只靠颜色**，违反我们自己的三通道原则。 |
| **钉选改变显示但不改变排序** | ✅ | ❌ **故意不抄** | 我们是告警面板，「我关心的那条」应该能置顶。它的选择来自「对话客户端」的语境（会话本来就按时间排）。 |
| **`无异常` 类全局判词** | ❌ **它没有这个概念** | — | 见 §2.3：它刻意不印判词。**这一条是我们的问题，不是它的可抄项**，但它给出了正确形态：只印可核对计数 + 空状态写「下一步能按什么」。 |
| **`projectLabel()` 的连字符还原** | — | ❌ **反例** | 它把 `D--Projects-Overwatch` 的 `-` 全换成 `/`（那是 **Claude Code** 的目录编码，不是 dsh 的）；dsh-TUI 没有这个问题，是**我们的** bug。修法见 §2.4 末。 |
| **`displayWidth` 的 EAW 表** | ✅（用 3 个包） | ✅ **逻辑抄、数据自己生成** | 见 §5.3：我们 22 例 9 错。 |

---

## 7. 零依赖要不要破：**不破**

### 7.1 先说结论的理由链

**① 我们真正要解决的问题，它没有在「依赖」这一侧解决。**
dsh-TUI 花 39,773 行自建渲染器 + 引入 React，是为了三件事：60fps 流式对话、flexbox 任意嵌套、鼠标/图片/选择。**这三件事我们一件都不需要**：我们是 30 行、1Hz、只读、无鼠标。它在这三件事之外的成果 —— 布局数学、截断策略、降级阶梯、固定列宽纪律 —— **全部在 `src/` 里以零依赖纯函数的形式存在**，而且都在 `src/screens/` 和 `src/sessions/` 里，不在 `src/ink/` 里。

换句话说：**它用重依赖买到的东西，恰好是我们不需要的那部分；我们需要的部分，它本来就是零依赖写的。**

**② 零依赖在这台机器上是已被验证的运维事实，不是审美。**
`README.md:5`：「零 npm 依赖（仓库里没有 `package.json`），只要 Node ≥ 18。不安装、不登录、不配置。」
`check-structure.mjs` 的 `checkImportable()` 会 spawn 一个干净 Node，`import` 每个 `scripts/*.mjs` 并调用其导出——**一旦引入 npm 包，这条硬门需要一个 `node_modules/` 才能过**，而它的设计前提正好是「不需要安装」。

**③ 我们的使用者是「clone 下来直接跑」的人。**
它是 npm 全局安装的 CLI（`npm i -g @deepseek-harness-tui/dsh-tui`），走安装器是自然的。我们是 `git clone && node scripts/oversight-tui.mjs`。加一条 `npm install` 就多一个失败点，而这个项目的核心承诺是「你不需要安装任何东西就能看见你的会话」。

**④ 引入 React 会让「可发布区」从「配置库」变成「Node 应用」。**
`docs/adr/0001-config-only.md:9` 明写「纯 Claude Code 配置库……不包含常驻进程、不包含数据库、不包含守护循环」。加 `package.json` + `node_modules` 会实质改变这个形态（虽然它有 `watch.mjs` 常驻，但那是外部调度器拉起的短进程）。**这条 ADR 的边界不该因为「TUI 想好看点」而移动。**

### 7.2 唯一值得破的一次：`@xterm/headless` 作为 **devDependency**

它是我看到的**最有价值的单件资产**，而且**不进产物**：

```js
// scripts/verify-session-supervisor.tsx:106-110
const xterm = await import('@xterm/headless')
const { Terminal: XTerm } = xterm
// 把 render 的输出喂给内存终端，读「真正画出来的格子」
```

配套的 `scripts/lib/term-test.mjs` 里三个 helper 把「TUI 怎么测」这件事讲清楚了：

> - `settled(pred)` 取代「sleep 后断言」与「settle 后断言」：轮询到谓词为真后返回谓词终值，调用方把返回值直接交给 check —— **等待条件与断言条件是同一个表达式**，「settle 等到 A、断言却要 B」这类分叉在写法上不可能出现。
> - `viewportLines()` 取代 `getLine(0..ROWS) 直扫`：inline 模式有 scrollback 时直扫读的是缓冲区开头。

**这套东西能解决我们一个真实的薄弱点**：`oversight-tui.test.mjs` 现在是 42 个 `test()`，测的是纯函数（`truncateToWidth` / `sanitize` / `buildDraft` / `listRow`），**没有一条测「按 40 列运行 3 秒后屏幕上第 3 行是什么」**。而我们的错位 bug（宽度表错 → 右边界推歪）**恰好只能这样测出来**。

**但即使这一条，我建议先不做**：我们可以用「纯函数 + 断言字符串等宽」覆盖 90% 的风险（`padDisplay` 的输出 `displayWidth` 必须等于目标宽度，对 200 个抽样字符跑一遍），成本是 20 行、零依赖。**只有当出现「布局数学正确但终端画错」这类我们目前没有的 bug 时，再考虑引入 `@xterm/headless`。**

### 7.3 如果将来非破不可，划一条线

| 允许 | 不允许 |
|---|---|
| `devDependencies`（测试期，不进产物） | `dependencies`（运行时） |
| 单文件、无传递依赖、MIT | 有传递依赖树 |
| 数据/算法（EAW 表、grapheme 切分） | 框架（React、Ink、blessed） |
| 有 `node:` 内置等价物的优先用内置（`Intl.Segmenter` vs `grapheme-splitter`） | 有内置等价物却引包 |

按这条线过一遍：31 个 npm 依赖里，**0 个**符合「运行时」条件。这就是答案。

---

## 8. 覆盖声明与没做到的事

**实际读了原文的**：`src/` 里 40+ 个关键文件全文（含 `SessionSupervisor.tsx` 1,010 行、`SessionListRow.tsx`、`HomeWorkspaceRow.tsx`、`listWindow.ts`、`format.ts`、`truncateMiddle.ts`、`stringWidth.ts`、`truncateToWidth.ts`、`optimizer.ts`、`frame.ts`、`log-update.ts` 前 300 行、`ink.tsx` 的 resize/schedule 段、`screen.ts` 的 diffEach 段、`terminal.ts` 的能力检测段、`theme.ts` 全部 1,503 行、`design-system/` 全部 12 个文件、`launchpadLayout.ts`、`launchpadParams.ts` 头 100 行、`SubagentCard.tsx`、`SubagentDashboard.tsx`、`SubagentDetailScene.tsx` 头 70 行、`SourceTabs.tsx`、`Tooltip.tsx` 头 70 行、`SearchBox.tsx` 头 80 行）；`docs/interaction.md` 944 行、`docs/user-guide.md` 相关段、`docs/themes.md`、`docs/architecture.md`；`package.json` / `pnpm-lock.yaml` / `THIRD_PARTY_LICENSES`；`scripts/verify-session-supervisor.tsx` 头 110 行 + `scripts/lib/term-test.mjs` 头 60 行；`docs/assets/readme/preview-zh.svg` 按 y 坐标还原成逐行文本。

**本机实测的**：`scripts/tui-theme.mjs` 的 `displayWidth` / `padDisplay` / `truncateToWidth` / `wrapToWidth` 对 40+ 个字符的宽度断言、对 `listRow` 的 6 种项目名、`stateCounts` 的空/未识别分支、`mergeLiveSessions` 的排序抖动、`truncateToWidth` 的复杂度曲线（100/400/1600/6400 字符 → 0.60/0.33/0.66/1.49 ms/call，**超线性**）；`npm view` 查了 8 个候选包的 license 与 unpackedSize；`npm pack` 解开了 `figures@6.1.0` 与 `is-unicode-supported@2.1.0` 看回退表；下载了 `unicode.org/Public/UCD/latest/ucd/EastAsianWidth.txt` 做逐字符核对。

**没做到的**：
- **没有真的跑起来**。它是 npm 全局安装的宿主插件，需要 DSH 内核 + profile，本机没有。所有关于「界面上看起来如何」的结论来自 (a) 源码里的 JSX 结构、(b) `preview-zh.svg` 这个**真实终端录制**的还原、(c) `docs/` 的正文。**我没有见过它的运行时**。
- **没读 `src/ink/` 全部 36,470 行**，只读了与本任务相关的 6 个文件的要害段。差分渲染器的正确性我不评价。
- **没跑它的 559 个 `verify-*`**（需要 `pnpm install` + build，且依赖 DSH 内核）。
- **没核对像素层面的色值实际观感**。色值是源码字面量，精度到 `#RRGGBB`，但我没有在真终端里比过。
- **`preview-zh.svg` 的还原有损**：它把同一 y 坐标的 `text` 元素拼接，重叠的动画帧会重复字符（我在还原结果里看到 `/（（（`这种叠字）。所以那个还原只能用来核对**版面结构**，不能用来核对文案细节。

---

## 附：一句话总结

**它是一台完整 TUI 客户端，我们是一个只读告警面板——但它在「一个会话行怎么排」这件事上的所有决定，都是在零依赖的纯函数里做的；我们要的是那些决定，不是那台机器。**
