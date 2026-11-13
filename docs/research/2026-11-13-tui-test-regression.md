# TUI 非 TTY 测试回归：是夹具过时，不是显示逻辑坏了

- 日期：2026-11-13
- 作者：修复 Agent F8
- 产出形态：artifact（代码 + 测试）
- 涉及文件：`scripts/oversight-tui.mjs`、`scripts/oversight-tui.test.mjs`
- 红测：`scripts/oversight-tui.test.mjs:203` `main() 非 TTY 分支能产出输出（曾因契约变更整段失效）`

> **本文只写实测到的东西。** 凡未实测的，标「未实测」。

---

## 0. 结论先行

**这是测试过时，不是实现有 bug。但同时炸出了一个真的实现缺陷。**

三句话：

1. **红测的根因是夹具停在旧契约上。** `partitionRows`（`tui-layout.mjs:395`）判「在跑」的条件是
   **「出现在宿主 `live` 里且有 transcript」**。夹具只给了 `sessions`、没给 `live`，
   于是那条 `PRODUCING` 会话被判成**已停**；而「已停」在 `--plain` 里默认压成一行计数
   （`oversight-tui.mjs:1963`），项目名根本不进屏。显示逻辑没有坏，是数据没走那条路。
2. **「没有 cwd 会显示空」这个担心不成立。** `viewOf`（`oversight-tui.mjs:585`）的兜底链是
   `meta.cwd → row.cwd → row.project`，`project` 永远在，所以无 cwd 的会话照样有项目名。
   **实测 110/110 条 sessions 都没有 cwd**，所以这是常态路径，不是边角。
3. **顺手修了一个真 bug：列表页完全不净化外部文本。** 详情页净化了 `project` / `sessionId`，
   列表页与 `--plain` 没有 —— 把 OSC 52 塞进 `project` / `needs` / 建议回复，
   `--plain` 会让只读渲染器**改写系统剪贴板**。这是「两条展示路径各修一半」的第 N 次复发。

**为什么这条 bug 之前没被发现**：那条 OSC 测试（`oversight-tui.test.mjs:226`）当时是**假绿**——
它的夹具同样缺 `live`，会话掉进折叠的已停段，`project` / `needs` 一个字都没渲染，
「输出里没有 ESC」于是自动成立。它测的是「没画的东西里没有 ESC」。

---

## 1. 红测的完整因果链

```
夹具 baseSession = { project: 'p', state: 'PRODUCING', ... }   // 无 live
        │
        ▼
mergeLiveSessions(data)         // data.live 缺失 → 原样返回 sessions
        │
        ▼
partitionRows({sessions, live: []})        // tui-layout.mjs:395
        │  isAction = false（PRODUCING 不在 ACTION_STATES）
        │  alive    = false（liveIds 为空）
        ▼
stopped.push(row)               // ← 落进「已停」
        │
        ▼
buildSections → sections.stopped
        │
        ▼
printPlain（oversight-tui.mjs:1963）
   sections.stopped.length → 只画 stoppedSummary() 一行计数
   「已停 (1)  5s前 · h 展开」     ← 项目名 p 在这里不存在
```

判据是**三条同时成立**才算「在跑」：state 不是需动作态、出现在 `live` 里、有 transcript。
缺任何一条都落到「已停」或「需动作」。夹具只满足第三条。

`cwd` 与这条红测**无关**。我最初也按「新版 TUI 要 cwd」的方向查，方向是错的。
`cwd` 只影响标题/路径列的**形态**，不影响**是否显示项目名**。

---

## 2. `shortPath()` / `titleOf()` 在 `project='p'` 无 cwd 时的行为

实测（`node -e` 直接调，非推断）：

| 调用 | 结果 |
|---|---|
| `viewOf({project:'p', sessionId:'s', state:'PRODUCING', idleSec:5}, null)` | `title='p'`, `titleFallback=true`, `path=''` |
| `titleOf({path:'p', key:'s'})` | `{text:'p', fallback:true}` — `p` 不含分隔符，按整段当标题 |
| `shortPath('p')` | `'p'` — `real.length === 1`，返回该段本身 |

三条都不是空。`titleOf` 有三层兜底：`title` → 路径尾段 → `key.slice(0,8)` → `'(无标识)'`，
最后一层才可能出现非项目名文本，而它只在 `project` / `name` / `key` 全空时触发。

`viewOf` 的 `path` 字段对 `project='p'` 返回 `''`，是**故意的**：
`project` 在真实数据里是目录编码（`D--Projects-Overwatch`）或宿主写的名字，
**不是路径**。把它当路径画成 `D/Projects/Overwatch` 会造出不存在的层级
（`oversight-tui.mjs:595` 与 `dsh-TUI 分析 §2.4 末`）。`''` 让路径列空着，
标题列仍然有 `p` —— 这是「我们只知道这么多」的诚实形态，不是缺陷。

---

## 3. 真实数据实测

### 3.1 会话里到底有没有 cwd

```
node scripts/scan-sessions.mjs --json --days 3
  sessions: 110
  带 cwd:    0
  不带 cwd: 110     ← 全部

  live: 11
  带 cwd: 11 / 11   ← 全部
```

**`sessions` 行里没有 `cwd` 字段**（`scan-sessions.mjs` 的 `jobToRow` 与主扫描循环都不产出它；
只有 `readLiveSessions` / `readJobs` 读的原始对象里有，而它们被摊平成 `project`）。
`cwd` 从两条路进视图：

1. `liveToRow`（`oversight-tui.mjs:1073`）显式保留 `cwd` —— 只用于 `live` 补进来的那几类。
2. `metaOf(row)` → transcript 尾部记录里的 `cwd`（`tui-meta.mjs` 的 `lastCwd`）——
   需要能定位到 transcript 文件。

所以「没有 cwd」是 110/110 的常态，「有 cwd」是 11/11 的少数路径（live 与 transcript meta）。

### 3.2 项目名列长什么样

```
node scripts/oversight-tui.mjs --plain --days 3
```

改前改后项目名列**一致，都非空**：

```
在跑 (13)
 MC 自动化测试工具整合                        0s  …
 Let's learn English!                         0s  …
 PerfScope                                    0s  …
 OmniSight                                    1s  …
 shapez                                       11s …
 proj                                        39s  —
 proj                                        52s  …
 Hilltop Village 多agent工作流             20.3h  …
```

标题列取 `titleOf`：优先 transcript 里的 `custom-title` / `agent-name`（`metaOf` 读到的
`MC 自动化测试工具整合` 这类），没有就退到 `project` 尾段（`proj`、`shapez`）。
两行 `proj` 的「近」列一个是 `—` 一个是乱码 ID，那是 transcript 末条内容，不影响项目名。

**结论：真实数据里项目名从未为空。** 无 cwd 的会话走的是 `project` 兜底，一直在工作。

---

## 4. 顺手修的真 bug：列表页不净化

### 4.1 症状（实测复现）

```
project = 'p\x1b]52;c;eA==\x07x'      # OSC 52，写系统剪贴板
printPlain(...)
  → 输出含 ESC = true，含 '52;c' = true
```

同样的问题在 `needs` / `suggestedReply` / `meta.lastAssistant` / `detailLines` 的 cwd 上都有。
详情页的 `detailLines` 对 `project` / `sessionId` / `needs` 调了 `sanitize`，
**但 `whereRaw`（cwd）那一行漏了**，而列表页一个字都没净化。

### 4.2 修法：在 `viewOf` 这一个必经点净化

`viewOf`（`oversight-tui.mjs:580`）是列表页与纯文本页**唯一**的取数入口
（`buildSections` 里 `toView` 用它；`printPlain` 走 `buildSections`）。
在它里面净化，两条展示路径就不可能再分叉 —— 这正是 DF-012/DF-017 反复出问题的结构性原因。

净化字段与理由：

| 字段 | 为什么要净化 | 在哪上屏 |
|---|---|---|
| `title` | 来自 transcript 的 `custom-title`，外部数据 | 列表标题列、详情头 |
| `path` | 来自 `cwd` / `meta.cwd` | 列表路径列、详情身份行 |
| `needs` | **逐字上屏**（relay-protocol §5.1） | 纯文本「它在等：」、详情「它在等」 |
| `suggestedReply` | 同上 | 纯文本「建议回复（逐字）：」 |
| `meta.lastAssistant` | transcript 末条，外部数据 | 「近」列、详情「最近说」 |
| `meta.question` | 同上 | 「问了没答」计数（只判真值，但保持一致） |

`key` **不净化**：它是光标身份，必须与 `cursorKey` 逐字相等（两侧都走 `sessionKey()`），
且不进任何渲染路径。

另外补了 `detailLines` 里 `whereRaw` 那一处漏掉的 `sanitize`：
`opts.meta.cwd` 由 `buildDetailFrame` 从 `view.path` 传来，而 `App` 的 `view` 可能不是
`viewOf` 产的（证据面板等路径），所以这一层不能依赖上游已净化。

### 4.3 净化不等于丢弃

`stripAnsi` 只删转义序列，不删正文。新增断言钉住这一点：净化后
`'p'+OSC+'x'` → `'px'`、`'n'+OSC+'x'` → `'nx'`。删多了（把正文一起删）测试会红。

---

## 5. 改了哪些测试，为什么不算「削弱断言」

| 测试 | 改动 | 回归价值 |
|---|---|---|
| `main() 非 TTY 分支能产出输出` | 夹具补 `live: [{sessionId:'s', status:'busy'}]`；断言 `buf.includes('p')` → `buf.includes(' p ')` | **变强**。旧断言 `'p'` 能被「纯文本快照」里的字蒙对；带空格是列表行里的独立单元格。注释写清了 2026-11-13 为什么红过。 |
| `main() 非 TTY 输出不含任何 ANSI` | 夹具同上去掉后的 `live`（用 `session.sessionId` 匹配）；新增「必须进在跑段」「`px` 必须在屏」两条 | **变强**。它原来能靠「掉进折叠的已停段」假绿；现在必须证明字段真的渲染了，OSC 断言才有意义。注意用 `'在跑 ('` 而非 `'在跑'`，后者判决行里也有。 |
| 新增 `main() 非 TTY：需动作段的 needs / 建议回复也必须净化` | 新测试，`BLOCKED` + 带 OSC 的 `needs` / `suggestedReply` | 覆盖「逐字 needs 上屏」这条路（在跑段不画 needs）。 |
| 新增 `viewOf：没有 cwd 时项目名照样显示，且五种外部文本全部净化` | 新测试，纯函数层 | 钉住「无 cwd 有兜底」与「列表取数点净化」两件事，不依赖整屏渲染。 |

**没有一条断言被放松。** 全部四条改动都在收紧。

### 负向测试（把 bug 放回去，测试必须红）

把 `viewOf` 里的 `sanitize` 逐个撤掉（`title` / `path` / `needs` / `suggestedReply` / `meta` 五处）：

```
ℹ pass 43
ℹ fail 3
  ✖ main() 非 TTY 输出不含任何 ANSI 序列（含 OSC 52）
  ✖ main() 非 TTY：需动作段的 needs / 建议回复也必须净化
  ✖ viewOf：没有 cwd 时项目名照样显示，且五种外部文本全部净化
```

恢复后 46/46 全绿。三条测试确实盯着那个 bug，不是碰巧绿。

再单独验一次「夹具缺 `live` 就会红」：`renderPlain` 默认 `live = LIVE_BUSY` 之前，
那条主测试正是 790/791 里唯一红的。它守的确实是「项目名进屏」。

---

## 6. 验证

```
node --test scripts/*.test.mjs
  ℹ tests 793
  ℹ pass 793
  ℹ fail 0            （基线 791：+2 条新测试，0 条删除）

node scripts/check-structure.mjs
  ✓ 结构检查全部通过

node scripts/oversight-tui.mjs --plain --days 3
  项目名列全部非空（见 §3.2）
```

边界：未碰 git、未 commit；未碰 `scripts/watch.mjs` / `scripts/verify-claims.mjs` /
`scripts/stop-verify-hook.mjs`。

---

## 7. 留下的东西（不修，但要说）

- **`_tick` 与 `App` 的净化边界**：`App` 里的 `sessions` 存的是原始扫描行（不经过 `viewOf`），
  详情页用 `view` 而非原始行的场景已由 `detailLines` 自己的 `sanitize` 兜住。
  若将来新增渲染路径直接读 `App.sessions`，它**不会**被自动净化 —— 这类回归只有靠
  「所有展示都经 `buildSections`」这条纪律挡住。目前没有测试能机械地守住这条，
  `check-structure.mjs` 也不查。**未实测影响面**，只记录。
- **`project` 是目录编码时无法还原真实层级**：`D--Projects-Overwatch` 只能原样显示。
  这是 2026-11-05 dsh-TUI 分析 §2.4 末的既定裁决（反推会在项目名带连字符时造假），
  不是本次引入的问题。真实数据里 13 条在跑有 11 条走 `live` 的 `cwd`，只有
  `sessions` 独有的那两行才会看到编码目录名。
