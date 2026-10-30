# 停止类型的可观测信号（2026-10-30 补测）

> 补 `docs/research/2026-10-30-hosted-automation.md` 第六节「未解决」里的第一个空白：
> 权限确认型 / 等用户决策型停止，在 transcript 里到底有没有痕迹。
>
> 结论：**有，而且有三条结构化信号，不依赖文本正则。**

## 一、结论先行

原先判断「权限确认型停止在本语料里 0 例」，是**搜索方式错了**，不是数据缺失。

我用 `permission|approval|approve` 等关键词扫全文，命中的 233 条全是 skill 描述里的误命中（`skill_listing` 的正文写着 "requested permissions"）。`denied` 那 1930 条也全是**工具执行失败**（`error: failed to delete ...`），不是权限拒绝。

改用**结构化字段**搜索后，找到三类信号，覆盖率都不低：

| 信号 | 记录形态 | 真实调用 | 含义 |
|---|---|---|---|
| `type: "permission-mode"` | 独立事件，非每条记录 | 16 个会话 | 会话权限模式，**可中途切换** |
| `AskUserQuestion` 的 `tool_result` | `The user answered: "问题"="答案"` | **66 次调用 / 33 次有回答** | AI 主动提问并拿到结构化回答 |
| `ExitPlanMode` + `plan_mode_exit` | 工具调用 + attachment | **11 次真实调用** | plan 模式提交，等用户批准 |

> **这两个数字我第一次都数错了。** 用 `grep -l` 数「含该字符串的文件」得到 145，用 `grep -o` 数「字符串出现次数」得到 2845，但解析 JSON 后 `type === 'tool_use'` 的真实调用只有 **11 次**。中间那些是 skill 描述、文档正文、以及工具说明里的文字提及。详见第八节。

## 二、`permission-mode` 是事件流，不是静态属性

**关键事实：一个会话可以在中途切换权限模式。**

实测 16 个带 `type: "permission-mode"` 事件的会话，分布：

| 模式序列 | 会话数 |
|---|---|
| `bypassPermissions` | 7 |
| `auto` | 2 |
| `bypassPermissions → auto` | 5 |
| `bypassPermissions → acceptEdits` | 1 |
| `auto → acceptEdits → bypassPermissions → plan` | 1 |

有个会话的模式序列长达 200+ 次切换（`auto ↹ acceptEdits ↹ bypassPermissions → plan ×10 → bypassPermissions`）。

### 2.1 更正：`permissionMode` 字段在每个 transcript 里都能读到

**我第一次统计错了。** 我只看了 `type === "permission-mode"` 这种独立事件（1443 条），得结论「3220 个 transcript 里只有 16 个带该事件，取不到时不能假设」。

复核后的事实：

| 指标 | 值 |
|---|---|
| transcript 文件总数 | 154（`*/**` 一级目录下的主 transcript） |
| 含 `permissionMode` 字段的文件 | **154（100%）** |
| 该字段出现的记录类型 | `user`（4520 条）、`permission-mode`（1443 条） |
| 带该字段的记录占比 | 5962 / 357550 = 1.7% |

**所以：不是「取不到」，是「不是每条都带」。** 判定时取**最后一条**带 `permissionMode` 的记录即可，不需要标 `unknown`。

**对判据的影响**：原先担心的「16/3220 覆盖率不足」不成立。真正的约束只是「不能取第一条，要取最后一条」。

## 三、`AskUserQuestion` 的回答是结构化的

AI 调用 `AskUserQuestion` 时，用户的回答以 **`user` 类型的 `tool_result`** 落盘，格式：

```
The user answered: "源码仓的提交要现在推到 GitHub 吗？"="先不推",
                   "手机用的 ea 快照仓库里的文档要不要一起同步？"="ea现在变成只同步工作区内除源码文件以外的所有文件了…"
```

**统计**：66 次调用，33 次拿到回答，涉及 28 个会话。

### 3.1 为什么这条信号重要

它把「AI 问、用户答」变成了**可解析的结构化数据**，不需要从自然语言里猜。而且：

- 问题与答案成对出现，可以直接建立「问题类型 → 用户选择」的对应
- **答案里藏着危险**：第一条样本就是 `"要现在推到 GitHub 吗？"="先不推"`

**`先不推` 是明确的否定。** 如果 Overwatch 把「用户回复了」当成「用户授权继续」的通用信号，就会在这个场景下误判为可以推送。

### 3.2 33/66 的缺口说明什么

一半的调用没有拿到回答。可能原因：会话中途结束、用户切走了、或者回答走了 UI 没落盘。**具体原因未查**。

但这意味着：**看到 `AskUserQuestion` 调用不等于用户会回答**。判据里必须区分「问了」和「答了」。

## 四、`ExitPlanMode` 是最干净的「等批准」信号

**真实调用 11 次，分布在少量会话里。**（我第一次用 `grep -l` 数出 145 个「文件提及」，那是错的。）

形态：

```
assistant: [tool_use ExitPlanMode]
user:      [tool_result]
assistant: [thinking]
attachment: {"type":"plan_mode_exit","planFilePath":"...\\plans\\xxx.md","plan...":...}
```

这是「AI 写完计划，交给用户批准」的出口。`plan_mode_exit` attachment 带 `planFilePath`，指向计划文件本身。

**为什么它是最佳信号**：

1. **结构化**，不需要正则
2. **语义明确**：只在 plan 模式下出现，天然表示「要人批准」
3. **语义最明确**：只在 plan 模式下出现，但真实调用只有 11 次，覆盖率低
4. 附带计划文件路径，Overwatch 可以直接读来生成接力草稿

## 五、可以给出的判据草案

按可靠性排序：

| 序 | 信号 | 判定 | 可代决策？ |
|---|---|---|---|
| 1 | 下一句是 `task-notification` | 等子 Agent | **不介入**（68.3%） |
| 2 | `ExitPlanMode` 后无后续 | 等用户批准计划 | **不可代**。这是产品方向决策 |
| 3 | `AskUserQuestion` 的 `tool_result` 存在 | 用户已答 | 按答案内容判断，**不能一律当授权** |
| 4 | `AskUserQuestion` 调用后无 `tool_result` | 问了但没答 | 可代的情况：问题是**程序性**的（如「要不要继续」）；**方向性**的不可代 |
| 5 | 最后一条 `permission-mode` 为 `default` / `plan` | 严格模式 | 提高警惕，不做高风险动作 |
| 6 | 其余（无结构化信号） | 文本判断 | 保守处理 |

### 5.1 新增的硬边界

**「用户回复了」≠「用户授权了」。** 实测样本 `"要现在推到 GitHub 吗？"="先不推"` 证明回复可以是否定。判据必须解析答案**内容**，不能只看「有没有回复」。

**`ExitPlanMode` 后的停止一律不可代。** 计划批准是产品方向决策，属于 research 文档第四节列的第 7 类硬边界。即使用户把策略开到最高，这类也应当保留人工。

## 六、仍然缺的数据

1. ~~`permission-mode` 事件只在模式变化时写，绝大多数会话取不到模式~~ —— **已更正，见 §2.1**。`permissionMode` 字段在 100% 的 transcript 里都能读到，只是不在每条记录上。取最后一条即可。
2. **权限拒绝（用户点了「拒绝」）在 transcript 里仍然没有痕迹**。搜到的 `denied` 全是工具执行失败。这类事件可能完全走 UI。**如果确实不进 transcript，Overwatch 无法观测「用户刚拒绝过某个操作」**，这是判据的盲区。
3. **33/66 的回答缺口原因未查**。
4. 本次只看了 1 个 plan 会话的完整切换史，**样本偏少**。

## 七、对设计的影响

1. 分类器**必须优先用结构化信号**（`ExitPlanMode` / `AskUserQuestion` / `permission-mode`），文本正则只能兜底。research 文档实测的文本信号精度（`你测/你验` 45%）说明正则不可靠。
2. **`permission-mode` 要取最后一条**，不能取第一条。
3. **`ExitPlanMode` 后必须停**，写进硬边界。
4. `AskUserQuestion` 的答案要**解析内容**，特别是识别否定（`不`/`别`/`先不`/`暂不`）。

## 八、取数方式

**注意**：`grep -c 'AskUserQuestion'` 会数出 4568 次，但真正的 `tool_use` 调用只有 **66 次**——其余 4502 次是 skill 描述和文档正文里的字符串提及。**文字出现 ≠ 实际调用，必须解析 JSON 后看 `type === 'tool_use'`。**

```bash
# permission-mode 事件（16 个会话）
grep -l '"type":"permission-mode"' ~/.claude/projects/*/*.jsonl | wc -l
```

**但 `ExitPlanMode` 和 `AskUserQuestion` 不能这样数。** 它们的数字是：

| 方式 | ExitPlanMode | AskUserQuestion |
|---|---|---|
| `grep -l`（含该串的文件） | 145 | 138 |
| `grep -o`（字符串出现次数） | 2845 | 4568 |
| **解析 JSON 后的 `tool_use`** | **11** | **66** |

差两个数量级。所以只有下面的写法可信：

```js
// 真实调用数（AskUserQuestion 66 / ExitPlanMode 11），必须解析 JSON
let calls = 0;
for (const line of raw.split('\n')) {
  const o = JSON.parse(line);
  const c = o.message?.content;
  if (Array.isArray(c) && c.some(b => b.type === 'tool_use' && ['AskUserQuestion','ExitPlanMode'].includes(b.name))) calls++;
}
```

**教训**：做语料统计时，`grep` 只能用来粗筛文件，计数必须解析结构。本次差了两个数量级。
