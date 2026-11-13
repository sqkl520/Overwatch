# Stop hook 验证闸：原型报告

- 日期：2026-11-12
- 作者：执行 Agent H1
- 产出形态：artifact（可运行原型 + 真实拦截证据）
- 上游依据：`docs/research/2026-11-11-untapped-capabilities.md` §1（含二进制偏移证据）
- 代码：`scripts/stop-verify-hook.mjs`（闸门）、`scripts/project-commands.mjs`（项目命令探测）
- 测试：`scripts/stop-verify-hook.test.mjs`（35 条）
- 注册模板：`templates/stop-verify-hook.settings.json`

> **本文只写实测到的东西。** 凡未实测的，标「未实测」；凡与上游文档冲突的，直接写冲突在哪。

---

## 0. 结论先行

**拦住了。** 不是理论上能拦 —— 是在真实的 `claude` 二进制里跑通了「模型想结束 → hook 拒绝 → reason 喂回模型 → 模型继续 → 再结束 → 再拒」的完整循环，并且有宿主自己写下的 `stop_hook_summary` 记录作为旁证。

四个必须记住的实测结论：

1. **`{"decision":"block","reason":"..."}` 有效；`exit 2` 在 2.1.289 和 2.1.308 上都不拦截。**
   上游文档 `hooks.md:2903` 说两者等价。**我们的实测不支持这个说法** —— exit 2 被宿主记成
   `Failed with non-blocking status code`，回合照常结束。见 §2.2。这是本次唯一推翻上游文档的点。

2. **`hookSpecificOutput.additionalContext` 不是「温和版拦截」，它是无限循环。**
   模型每轮都会收到同一段上下文、再结束一次，直到撞上宿主的强制放行上限。
   见 §2.3。想「只提醒不拦」的话这个变体不能用。

3. **宿主默认上限是 9 次，不是 8 次。** `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 生效，且是
   「拦截 N 次后放行」还是「放行第 N+1 次」需要按实测读：`cap=3` → 拦 4 次后放行。见 §2.4。

4. **子 agent 旁证是准确率的分水岭。** 80 个真实会话里 15 个含可核对断言，其中 **14 个有子 agent
   transcript**。不查子 agent，闸门对这套工作流的绝大多数会话都会误报「没证据」。见 §4.1。

---

## 1. 交付物

| 文件 | 作用 |
|---|---|
| `scripts/stop-verify-hook.mjs` | Stop hook 本体。读宿主 stdin 的 JSON，复用 `verify-claims.mjs` 判定，写 `reason`，记 JSONL |
| `scripts/project-commands.mjs` | 从仓库根的标志文件认出「该跑什么测试命令」，替掉硬编码的 `npm test` |
| `scripts/stop-verify-hook.test.mjs` | 35 条测试。重点在「不误拦」与「fail-open」的负向用例 |
| `templates/stop-verify-hook.settings.json` | 注册片段 + 启用说明。**不含**任何真实生效的 hook |
| `scripts/check-structure.mjs` | 新增约 40 条导出登记（PROBE_ARGS），让新模块进硬门 |

**没有动的东西**：`~/.claude/settings.json`（全局）、`.claude/settings.json`（仓库级）、git。

---

## 2. 真实拦截证据

### 2.1 实验装置

本机的 `claude` CLI 走一个本地网关（`ANTHROPIC_BASE_URL=http://127.0.0.1:15721`），
没有可直接复用的凭据。所以实验用一个**本地 mock Messages API**（`createServer` +
SSE，约 60 行）顶替上游：模型每轮固定回同一句话
`全部测试通过，336/336，可以结束了。` —— 一句含 `test-count` 断言的回复。

这样做的价值：跑的是**真的 `claude.exe`**（`2.1.308`，宿主同款），真的走
hooks 注册 → stdin JSON → 判定 → 输出 → 下一轮，唯一被替换的是模型那一端。
**局限要说清**：模型是假的，所以「模型收到 reason 之后会不会真的去跑测试」这件事
本次**未实测** —— 它需要的是一次真实上游调用。见 §6。

### 2.2 证据 A：最小区块验证 —— block 有效，exit 2 无效

hook 依次返回 `block #1`、`block #2`、`block #3`，第 4 次返回 `approve`。
用 `--output-format stream-json` 跑，逐帧看：

```
--- assistant turn 1 ---
全部测试通过，336/336，可以结束了。
--- fed back to model ---
Stop hook feedback:
BLOCKED#1 你声称测试通过但没跑。请运行 echo ok 再结束。
--- assistant turn 2 ---
全部测试通过，336/336，可以结束了。
--- fed back to model ---
Stop hook feedback:
BLOCKED#2 你声称测试通过但没跑。请运行 echo ok 再结束。
--- assistant turn 3 ---
全部测试通过，336/336，可以结束了。
--- fed back to model ---
Stop hook feedback:
BLOCKED#3 你声称测试通过但没跑。请运行 echo ok 再结束。
--- assistant turn 4 ---
全部测试通过，336/336，可以结束了。
=== session 1f515967-68d2-4616-ade9-d49eb5712bee num_turns 4 terminal completed
```

模型侧的原始 `message` 是 `user` 类型、正文以 `Stop hook feedback:\n` 开头
（不是 `tool_result`，也不是普通用户消息）。宿主同时在 transcript 里写
`system/stop_hook_summary`：

```json
{
  "type": "system", "subtype": "stop_hook_summary", "hookCount": 1,
  "hookInfos": [{"command": "node \".../hook.cjs\""}],
  "hookErrors": ["BLOCKED#1 你声称测试通过但没跑。请运行 echo ok 再结束。"],
  "preventedContinuation": false, "hasOutput": true
}
```

**`exit 2` 的实测（两次独立运行，2.1.289 与 2.1.308 各一次）**：

```json
{
  "type": "system", "subtype": "stop_hook_summary",
  "hookErrors": ["Failed with non-blocking status code: EXIT2-REASON"],
  "preventedContinuation": false, "hasOutput": true
}
```
`num_turns=1`，回合直接结束。**所以原型只用 `decision:block`，不用 exit 2。**
上游文档这句要改。

### 2.3 证据 B：`additionalContext` 会无限循环

返回 `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"CTX-NOTE"}}`，
宿主既不结束也不报错，模型每轮重新生成同一句话、再次触发 hook。
实测跑到**第 9 轮**才被宿主以
`stop-hook-block-cap: A hook blocked the turn from ending 9 consecutive times — overriding and ending turn`
强制放行。

结论：`additionalContext` 的语义是「继续对话」，不是「提个醒」。要温和就必须
**自己判断本轮已提醒过**，否则它是一个必然撞上限的循环。

### 2.4 证据 C：拦截上限

| 实验 | 结果 |
|---|---|
| 恒 block，不设 env | 第 **9** 次后强制放行（"9 consecutive times"） |
| `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=3` | 拦 4 次后放行 |
| `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=1` | 拦 2 次后放行 |

即：上限值 = 允许的拦截次数，**放行发生在第 N+1 次**。上游文档说「连续 8 次拦截后被强制放行」，
实测默认是 9 次 —— 差一次，写清楚以免我们自己的软上限算错。

### 2.5 证据 D：真实闸门（`stop-verify-hook.mjs`）在同一个装置里

把 hook 换成真脚本，项目根放 `package.json`：

```
turns: 7, feedbackCount: 6
stop-hook-block-cap: ... 7 consecutive times ...
```

日志（`OVERWATCH_STOP_VERIFY_LOG` 指到临时目录）真实一行：

```json
{"at":"2026-11-10T22:58:13.938Z","sessionId":"0e8fe641-...","mode":"block",
 "hookEventName":"Stop","stopHookActive":false,"permissionMode":"default",
 "cwd":"C:\\...\\proj6","project":{"kind":"node","test":"npm run test","source":"package.json"},
 "transcriptBytesRead":213703,"transcriptTruncated":false,
 "checkableCount":1,"claimFamilies":["test-count"],
 "action":"block","allowReason":null,"blockCount":0,
 "blocking":[{"family":"test-count","quote":"全部测试通过，336/336，可以结束了。",
              "status":"NO_EVIDENCE","why":"整个文件范围内没有任何测试运行调用"}],
 "reason":"【第 1 次拦截】…请在本会话里运行 `npm run test`（依据 package.json 的配置）…",
 "outcome":"blocked"}
```

Maven 项目（根放 `pom.xml`）同一装置上产出的 reason 里是
``请在本会话里运行 `mvn -q clean verify`（依据 pom.xml 的配置）`` ——
**硬编码 `npm test` 的问题在真实链路上被绕过了**，不是只在单测里成立。

### 2.6 证据 E：`-p` 模式下生效；`--bare` 下不生效

| 调用 | hook 被调用次数 |
|---|---|
| `claude -p ... --setting-sources=project` | 2（拦一次、放行一次各一次） |
| 同上 + `--bare` | 0 |

`-p` 下 transcript 在 hook 运行**之前**已落盘：hook 里读 `transcript_path`，
拿到的最后一条 assistant 文本与 stdin 的 `last_assistant_message` **逐字相同**
（实测 `match: true`，`recordCount: 22`）。这让「优先用 stdin、退回读盘」的双路设计是安全的。

---

## 3. hook 输入长什么样（实测，非文档）

```json
{
  "session_id": "1f515967-...",
  "transcript_path": "C:\\Users\\...\\1f515967-....jsonl",
  "cwd": "C:\\...\\proj",
  "prompt_id": "95f5ea99-...",
  "permission_mode": "auto",
  "effort": { "level": "max" },
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "全部测试通过，336/336，可以结束了。",
  "background_tasks": [],
  "session_crons": []
}
```

`stop_hook_active` 在第 2 轮起变成 `true`（第 1 轮 `false`），与文档一致。
`CLAUDE_PROJECT_DIR` 在 hook 进程里**可用**，且等于**被 hook 的那个项目根**，
不是 overwatch 仓库根 —— 所以注册模板里必须写绝对路径，不能用这个变量。

---

## 4. 判定逻辑

### 4.1 核心判据（完全复用 `verify-claims.mjs`）

```
last_assistant_message
  → detectClaims()            认出 test-count / build / commit / push / pr-ci / …
  → findEvidence() + classifyEvidence()   逐条定档
  → NO_EVIDENCE / STALE_ONLY / FAILED_ONLY → block
```

**不拦的档位**：`UNKNOWN`（读不到 / 后台执行拿不到退出码）、`UNCHECKABLE`（该族没有确定性证据源）。

这一条是刻意的。`verify-claims.mjs` 的注释里已经写明「没读到不等于不存在」；Stop hook
把这条推到了更高的赌注上 —— 它拦的是**用户的回合结束**，误拦的直接后果是用户被卡在会话里。
所以只在三个确定性档位上动手。

### 4.2 子 agent 旁证（实测驱动的设计）

抽 80 个真实 transcript（排除实验目录）：

```
scanned 80 | withCheckableClaim 15 | block 8 | allow 7 | err 0
其中含可核对断言的 15 个会话里，14 个有 subagents/ 目录
```

即：**执行 Agent 把测试跑在子 agent 里、主会话只贴结论，是这套工作流的常态。**
只看主 transcript，闸门会把绝大部分真实会话误报成「没证据」。

所以 `decide()` 加了一步：**主 transcript 判为要拦之后**，才去读子 agent 的尾部 2 MB。
子 agent 里有同样的成功证据 → 放行，理由记 `evidence-only-in-subagents`。
**代价只在我们本来就要拦的时候付**，因为读子 agent 是全流程里最贵的操作。

放行而不是判 SUPPORTED，理由与 `verify-claims.mjs` 一致：子 agent 的调用不在主时间线上，
无法确认它发生在最后一次编辑之后。**宁可放过，不可错拦。**

### 4.3 实测的一个真阳性

在真实语料上拦下的一条（会话 `50ec242b`，overwatch 自己的）：

- 断言：`**497 条测试全绿，但改好了一个核心 bug 它还是全绿。`
- 主 transcript：260 次 shell 调用，最后一次断言前后**没有任何测试调用**；
  最后一次源码编辑在 index **21402**，最后一次测试调用在 **20725** —— 测试在编辑之前。
- 全量（主 + 67 个子 agent）：`node --test` 调用 638 次、成功 585 次 —— 它确实跑过测试，
  只是**跑完之后又改了源码，然后声称全绿**。

这正是 `STALE_ONLY` 要抓的东西，也是 `verify-claims` 在事后报告里抓不到的
（事后你会看到一堆历史成功调用，很容易以为证据成立）。**事前闸门在这里是净增量。**

### 4.4 reason 的写法

`reason` 必须是**下一轮可执行的指令**，不是分类名。每条包含四样：

1. 它自己写的原话（让它认出这是它刚写的）
2. 缺的是什么（时间线，不是档位代号）
3. 具体跑什么命令（从项目配置读，不是硬编码）
4. 第几次拦截（到阈值后如实说明宿主的上限，并给一条「说真话」的退路）

真实产出：

```
【第 1 次拦截】你准备结束，但下面这些完成性断言缺少证据。

· 你写的是：「全部测试通过，336/336，可以结束了。」
  测试通过 —— 本会话里找不到对应证据（整个文件范围内没有任何测试运行调用）

请在本会话里运行 `mvn -q clean verify`（依据 pom.xml 的配置），把输出贴出来再结束。

拿到证据就贴出来再结束；如果拿不到，请把上面那句话改成如实的描述（例如「未运行测试」）。
```

第 4 次起改成：

```
【第 4 次拦截】宿主在连续多次拦截后会强制放行本轮。如果你确实无法拿到证据
（例如测试环境不可用），请在回复里**明说你没跑**，不要继续声称完成。
```

**最后那句「明说你没跑」不是客气话**：没有这条退路，模型在第 4–9 次拦截里能做的只有
两种 —— 编一个证据，或者原地重复。给它第三条路，是让闸门不制造谎言。

`reason` 硬截断在 4000 字符（宿主上限 10,000，留足余量；截断的指令比没有更糟）。

---

## 5. 边界情况：怎么处理的

| 边界 | 处理 | 依据 |
|---|---|---|
| `background_tasks` / `session_crons` 非空 | **放行**，理由 `background-tasks-running` | 它在等活干完，「结束回合」是正常行为。拦它等于让人在电梯里按关门键 |
| 连续拦截次数 | 第 4 次起升级语气；**我们自己的上限是 6 次**，到顶主动放行 | 不依赖宿主的 `BLOCK_CAP`：那是实现细节（实测默认 9），会随版本变；锁死用户是不可接受后果 |
| 计数归零 | 放行一次即清零；超过 10 分钟没有新拦截也归零 | 用户去泡杯咖啡回来，不该看到「第 5 次拦截」 |
| hook 自身失败 | **三层 fail-open**：`main()` 吞异常、`runHook()` 自己 try/catch、`appendLog` 永不抛 | hook 崩了必须放行。挡死一个会话比放过一百条未验证断言严重得多 |
| 输入不是 JSON / 是数组 | `parseHookInput` 返回 null → 记账 `unparsable-input` → 放行 | 数组也是合法 JSON，但 hook 输入永远是对象；认错会在后面静默变成「没有 last_assistant_message」 |
| transcript 读不到 | 没有可核对断言 → 放行 | 「没读到」≠「它没做」 |
| `last_assistant_message` 为空 | 退回读 transcript 尾部；两路都空 → 放行 | 纯工具轮没有文本 |
| 超时 | 自设预算 20 秒（`OVERWATCH_STOP_VERIFY_BUDGET_MS`），超时放行并记 `hook-budget-exceeded` | 不赌宿主默认值 |
| `-p` 模式 | 生效。实测 transcript 在 hook 前已落盘 | 见 §2.6 |
| `--bare` | 不生效（宿主自己跳过 hooks） | 见 §2.6 |
| 默认行为 | **off：只记账，永远 exit 0** | 用户不显式开启就不该被拦 |

### 5.1 性能

实测（含 129 MB 的真实 transcript）：

| 场景 | 墙钟 |
|---|---|
| 真闸门，`package.json` 项目，transcript 23 MB | 0.5–1.4 s（3 次） |
| 真闸门，transcript **128.6 MB** | 0.54–1.49 s（3 次） |

`readBack` 有界回溯（默认 8 MB）是这里的全部原因：它不整读文件。
所以注册模板里的 `timeout` 给 60 秒 —— 实测 1.5 秒，但要留出「磁盘很慢 / 子 agent 很多」的余量。

**踩过的坑**：`timeout: 5` 时 hook 被宿主**静默 kill**，`hookInfos.durationMs` 显示
`7871`（说明它跑完了）但 `hasOutput: false`、`hookErrors: []` —— 表现为「hook 跑了但没生效」。
这个失败模式极难从现象反推原因。模板里写 60 秒并把这条写进注释。

---

## 6. 已知限制（按严重度）

1. **模型收到 reason 之后会不会真去跑测试 —— 未实测。**
   本次装置里模型是 mock，它只会重复同一句话。所以「闸门能否让模型改行为」这个
   最关键的问题，本次只能证明**前半段**（拦截 + reason 送达）。后半段需要一次真实上游调用。
   **这是本报告最大的空洞。**

2. **误拦风险仍在，只是被压窄。** 实测 15 个含断言的会话里拦了 8 个。
   抽样看的那个（§4.3）是真阳性。但 8 个里剩下 7 个没有逐条人工复核 —— 它们大概率也是真的
   （`STALE_ONLY` 是「改完代码没重跑」，`NO_EVIDENCE` 是「主+子都没有测试调用」），
   但**「大概率」不是「核对过」**。

3. **子 agent 只读尾部 2 MB。** 一次会话可能有 67 个子 agent（实测）。证据若在更早的部分，
   仍会漏。这是有意的取舍：全读在真实语料是 5 GB 量级，不能放在回合结束点上做。

4. **计数依赖我们自己写的 `state.json`。** 进程崩溃 / 用户清 `tasks/runs/` 会丢计数。
   后果只是语气降级（不知道是第几次），不是安全问题。

5. **Windows 路径陷阱。** hook 的 `command` 里不能用 `/tmp/...`：宿主 spawn 的是
   Windows 原生进程，`/tmp` 会被解析成 `C:\tmp`。本次第一次实验就撞上，
   表现为 `stop-hook-error` + 脚本 ENOENT。**模板用绝对路径就是为了这个。**

6. **`UNKNOWN` 放行意味着「后台执行测试」这类会话永远不会被拦。**
   这是刻意的（拿不到退出码就不该替它下结论），但它是可被利用的：把测试丢到后台
   再声称通过，闸门不拦。**闸门挡的是「忘了跑」，不是「刻意绕过」。**

7. **`--bare` 下不生效**，且项目级 settings 里的 hook 对**所有**在本仓库打开的会话生效。
   如果这个仓库被别的项目当依赖 clone，不会有影响（hooks 只从被打开项目的 settings 读），
   但同一个仓库里开两个会话，两个都会被拦。

---

## 7. 如何启用（默认不启用）

**默认是观测模式**：不设环境变量时，hook 只往 `tasks/runs/stop-hook/<日期>.jsonl` 记账，
永远 `exit 0`，**不会拦住任何会话**。这是「装上之后会话结束不了」这个灾难的防线。

三步：

1. **合并注册片段。** 把 `templates/stop-verify-hook.settings.json` 的 `hooks` 键
   合并进 `.claude/settings.local.json`（gitignored，本机私有）或
   `.claude/settings.json`（可提交，本仓库所有会话生效）。
   **把 `<OVERWATCH_ROOT>` 换成绝对路径** —— 不能用 `${CLAUDE_PROJECT_DIR}`，
   因为它在 hook 进程里指向被 hook 的项目根，不是本仓库（实测）。
   **不要动 `~/.claude/settings.json`。**

2. **先跑观测模式一周。** 不设 `OVERWATCH_STOP_VERIFY`，正常干活，然后看
   `tasks/runs/stop-hook/*.jsonl` 里的 `action` / `outcome` / `blocking`：
   - `outcome: "observed-only"` 的行 = 如果开了闸，会被拦的那些
   - 逐条看一眼 `blocking[].quote`，判断是「它真没跑」还是「我们没认出来」
   - **只有在观测期误报率可接受之后**才进第 3 步

3. **开启拦截。** 在 shell 环境里设 `OVERWATCH_STOP_VERIFY=block`
   （**不要**写进 settings 的 `env` —— 那样改起来太容易忘，而且会让「默认安全」这条失效）。

回滚：从 settings 里删掉那个 `Stop` 条目即可，不用重启（文件监听会自动重载，
上游文档 `hooks.md:736` 有说明；本次未实测热重载）。

---

## 8. 可观测数据

每次**判定**都追加一行 JSON Lines 到 `tasks/runs/stop-hook/YYYY-MM-DD.jsonl`
（`tasks/runs/` 已在 `.gitignore`，含会话 ID，不外发）。字段：

| 字段 | 用途 |
|---|---|
| `at` / `sessionId` / `cwd` | 定位 |
| `mode` | `off` / `block` |
| `project` | 认出的项目类型 + 测试命令 + 依据文件 |
| `transcriptBytesRead` / `transcriptTruncated` | 读够了没有 |
| `checkableCount` / `claimFamilies` | 这一轮认出了几条什么断言 |
| `blocking[].quote` / `.status` / `.why` | **被拦的断言原文 + 档位 + 原因** |
| `reason` | 实际喂回模型的文本 |
| `blockCount` | 第几次拦截 |
| `subagentRecords` / `seenInSubagents` | 子 agent 旁证情况 |
| `action` / `allowReason` / `outcome` | **最终是否放行、放行原因** |

`allowReason` 的取值是一个封闭集，便于统计：
`no-checkable-claim` / `background-tasks-running` / `all-claims-supported` /
`evidence-only-in-subagents` / `hook-budget-exceeded` / `unparsable-input` / `hook-internal-error`。

**这是验证「闸门是否有效」的唯一数据来源**：没有 `outcome` 分布，就无法区分
「闸门很准」与「闸门什么都没做」。观测模式的 `observed-only` 行是最有价值的 ——
它是「假设开了闸会拦什么」的免费样本，不用真的打扰任何人。

---

## 9. 测试与硬门

```
node --test scripts/*.test.mjs      → 791 tests, 791 pass, 0 fail  （原 756，新增 35）
node scripts/check-structure.mjs    → exit 0，0 提示
```

测试的重点不是「正面能拦」，而是这些负向用例：

- 默认模式（不设 env）下 `runHook` 必须返回 null（**最重要的一条**）
- 输入是垃圾 / transcript 读不到 / 判定抛异常 / 日志写不进去 → 四条 fail-open 路径各一条
- `UNKNOWN` 与 `UNCHECKABLE` 不进拦（断言 `BLOCKING_STATUS` 恰好是三个档位）
- Maven 项目的 reason 里**不能出现 `npm test`**
- 认不出项目类型时不编造命令
- 到自己的 `MAX_BLOCKS` 后主动放行（不依赖宿主）
- 放行一次后计数清零；超时归零
- `readCapped` 只读前 1024 字节（真写一个 400 KB 文件验证）

硬门这边，新增模块的约 40 个导出全部登记进 `check-structure.mjs` 的 `PROBE_ARGS`，
参数一律取「不存在的路径 / 空对象」。记账函数在结构门里只会走到「读完发现没东西就返回」，
**不会把 state 写进用户的 `%LOCALAPPDATA%`**。

---

## 10. 与上游文档的差异（要回写的那几条）

`docs/research/2026-11-11-untapped-capabilities.md` §1.1 引的 `hooks.md` 有几处需要更正：

| 上游文档说 | 实测 |
|---|---|
| `exit 2` 与 `decision:block` 等价 | **不等价**。exit 2 在 2.1.289 / 2.1.308 上都是 `non-blocking status code`，回合照常结束 |
| 连续 8 次拦截后强制放行 | 默认 **9** 次；`BLOCK_CAP=N` → 拦 N 次后放行 |
| `additionalContext` = 「继续对话但不报错」 | 它会让模型**每轮重复触发**，直到撞上限。不是温和版拦截 |
| hook 的 `timeout` 单位是秒 | 是秒，但低于实际耗时时是**静默 kill**（`durationMs` 有值、`hasOutput:false`、`hookErrors:[]`），极难诊断 |

这几条建议由主线程决定是否回写进 `docs/research/2026-11-11-untapped-capabilities.md`
与 `tasks/dev-findings.md`。**本 Agent 不改别人的调研文档。**

---

## 11. 下一步（如果主线程要继续）

1. **补上 §6 第 1 条**：用真实上游跑一次「模型拿到 reason 后是否真去跑测试」。
   这是唯一还空着的关键问题，且只需要一次真实调用。
2. **观测模式跑一周**，用 `observed-only` 的真实分布定误报率，再决定默认是否开启。
3. **`STALE_ONLY` 的 reason 可以更具体**：现在只说了时间线，没说「你 14:32 改的文件，
   13:58 跑的测试」。`verify-claims.mjs` 的 `evidenceTimeline()` 已经有这些时间戳，
   接上即可 —— 本次没做，因为 reason 已经够长。
