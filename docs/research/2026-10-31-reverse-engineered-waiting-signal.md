# 逆向 Claude Code 的「等待用户」信号

- 日期：2026-10-31
- 目标：`claude.exe` 2.1.270（本机安装目录下的 `<ver>\<build-hash>\claude.exe`，227 MB，Bun 打包）
- 方法：字符串扫描 + 上下文转储（`readSync` 分块 + `indexOf`），未反编译字节码
- 结论：**宿主一直有一个明确的 `waiting` 状态，而我此前完全没读它**

## 一、为什么要逆向

`watch.mjs` 的通知触发率是 **0.117 条/天**——约 8 天一次。原因是它的候选只来自
`~/.claude/jobs/*/state.json` 的 `failed` / `blocked`，而宿主很少写这两个值
（25.6 天、16 个 job 文件里只有 3 个）。

我一直在**猜**还有什么信号可用：novelty、心跳间隔、停止分类。三者都被实测推翻：

| 猜的信号 | 实测结果 |
|---|---|
| novelty < 0.2 判停滞 | 全语料 0.018% 命中，末态 0 次 |
| 心跳间隔超 p95 判失败 | 5 条通知 5 条误报，已删除 |
| 停止分类 | 在线 95.4% 判 `UNCLASSIFIABLE` |

问题在于**这三个都是我造的信号**。宿主自己怎么知道「该叫用户了」——我从没去看过。

## 二、三个状态的真相

`claude.exe` 内 offset 213164340 处的源码：

```js
var wS = { running: "busy", requires_action: "waiting", idle: "idle" };
```

**是三个状态，不是两个。** 而我 `readLiveSessions()` 的注释曾写死：

> `status: o.status,  // busy / idle`

**这条注释是错的，并且正是它让我一直没去找 `waitingFor`。**

## 三、`waitingFor` 是怎么判出来的

同一区域，紧接着的 `bg()`：

```js
function bg(e) {
  let n;
  return (r, s) => {{
    let d = wS[r],                                    // running/requires_action/idle → busy/waiting/idle
        T = d !== "waiting" ? void 0
          : s?.tool_name === ks || s?.tool_name.startsWith("dialog:")
            ? "input needed"
            : "permission prompt",
        D = `${d}.${T ?? ""}`;
    ...
    tue({ status: d, waitingFor: T }, e)              // ← 写进 sessions/*.json
  }}
}
```

更完整的判定在 offset 215545994，一个专门的函数：

```js
function bVo(w) {
  if (w.queuedElicitation)                          return "input needed";
  if (w.topDialogWaitingFor !== void 0)             return w.topDialogWaitingFor;
  if (w.pendingWorkerRequest)                       return "worker request";
  if (w.pendingSandboxRequest)                      return "sandbox request";
  if (w.isShowingLocalJSXCommand && !w.isResponseStreaming && !w.delegatedActive)
                                                    return "dialog open";
  // 都不满足 → undefined，状态退回 busy/idle
}

function iYe(w) {
  let I = bVo(w);
  if (I !== void 0) return { status: "waiting", waitingFor: I, working: false };
  return { status: w.isLoading || w.delegatedActive ? "busy" : "idle", waitingFor: void 0, ... };
}
```

**`waitingFor` 的全部取值**（offset 215514078 的 dialog 注册表汇总）：

| `waitingFor` | 含义 |
|---|---|
| `input needed` | 有 elicititation（MCP 要求用户输入）排队 |
| `dialog open` | 本地对话框打开中（`isShowingLocalJSXCommand` 且未在流式输出） |
| `permission prompt` | 工具调用等待权限批准 |
| `worker request` | 有 worker 请求待处理 |
| `sandbox request` | 有 sandbox 请求待处理 |
| `goal proposal` | Claude 提出了会话目标，待确认 |

## 四、更高层的分类（本地拿不到）

宿主还维护一套三级分类，用于向远端汇报每轮总结：

```js
const i = new Map([["blocked","blocked"], ["done","completed"], ["working","review_ready"]]);

function wDr(e, r) {
  if (e.recap) return {
    status_category: e.state === "failed" ? "failed" : i.get(e.state) ?? "review_ready",
    status_detail: e.recap.headline,
    needs_action: e.state === "blocked" ? e.recap.needs : "",
    recent_action: e.recap.needsYou,
    description: e.recap.happened,
    reply: e.recap.reply,
  };
  return { status_category: i.get(e.state) ?? "review_ready", ... };
}

function vDr(e, r) {
  ...
  let s = e.tool_name.startsWith("dialog:")
    ? { status_category: "blocked", status_detail: "Waiting on a user dialog", needs_action: e.action_description }
    : { status_category: "blocked", status_detail: `Waiting on permission: ${e.tool_name}`,
        needs_action: `Approve or deny ${e.tool_name}` };
  r?.notifyMetadataChanged({ post_turn_summary: s });
}
```

**这套信息更丰富（有 headline、needs_action、reply），但本地读不到。** 验证：

```
grep post_turn_summary 全部 transcript → 只在 2 条 user 记录里出现，且都是工具返回内容，
不是 {type:"system", subtype:"post_turn_summary"} 记录。
```

代码里它只走 `reportMetadata` / `notifyMetadataChanged`（远端桥接），**不落本地盘**。

所以本地可用的最高层信号就是 `sessions/*.json` 的 `status` + `waitingFor`。

## 五、这个 bug 造成过什么

2026-10-31 实测抓到一次：

```json
{ "status": "waiting", "waitingFor": "input needed", "statusUpdatedAt": 1793451144381,
  "name": "<project-D>" }
```

而 `scan-sessions.mjs` 把它判成：

```
[EXPLORING] <project-D> ... idle=326.9h dormant
```

**它已经等了 23 天，系统输出「它只是休眠了，不干预」。**

根因是判定顺序：`judgeState` 里 `DORMANT_MS`（1 小时无活动 → dormant）排在所有宿主信号之后，
但 `waiting` **根本不在传入的 `sessionState` 里**——它从来就没被读出来过。

## 六、修复

1. `readLiveSessions()` 读 `waitingFor`（`scan-sessions.mjs`）。
2. `judgeState` 新增 `WAITING` 状态，排在 `dormant` **之前**：
   dormant 是「没在做事」，waiting 是「在等你」，后者信息量更大且可行动。
3. `watch.mjs` 新增 `probeWaiting()`，在 L-fast（1 分钟）层与 `probeJobs` 并行。
4. `NOTIFY_STATES = ['WAITING', 'FAILED', 'BLOCKED']`。
5. TUI 主题新增 `WAITING` 字形 `!`（brightYellow）。
6. 列表页 waiting 行尾直接显示 `← 正在等你（input needed）`。

## 七、这个信号好在哪

| 维度 | 旧的 hb_gap 推断 | 新的 waiting |
|---|---|---|
| 来源 | 我造的心跳间隔 | 宿主自己算的 |
| 语义 | 「它歇了一会儿」 | 「它在等你」 |
| 时效 | 事后重建 | 实时，用户一回话就消失 |
| 误报 | 5/5 | 待测 |
| 触发频率 | 每天数次 | 每次等待一次 |

**它是唯一一个「动作方向明确」的信号**：`failed` 告诉你该重跑，`waiting` 告诉你该回话。
其余所有状态都只是描述。

## 八、诚实的边界

1. **未反编译字节码。** 结论来自字符串上下文，是**读出来的实现**，不是反编译验证过的语义。
   个别函数名（`bVo`、`iYe`、`wS`）是 minify 后的标识符，但代码逻辑是完整的。
2. **只验证了 2.1.270 一个版本。** 升级后字段名可能变；`probeWaiting` 对未知 `status` 值
   会跳过而不崩溃，但不会告警。
3. **`waiting` 的触发频率我还没测到。** 抓到的那个样本在 1 小时内就被用户回答掉了
   （`status` 变回 `busy`），说明它是**实时**而非滞留的——这正是它作为通知源的价值，
   但也意味着很难在事后回放里统计它。
4. **`needs` 在 sessions/*.json 里不存在**，只有 `waitingFor`（一个短标签）。
   想要「它在等什么」的详细内容，仍然只有 jobs 的 `needs` 字段。
