# 托管模式设计：策略 schema、停止分类、投递、通知

> 状态：**Proposed**（未实现，未提交用户批准）
> 依据标注：`[R§x.y]` = [`docs/research/2026-10-30-hosted-automation.md`](../research/2026-10-30-hosted-automation.md) 对应小节；
> `[M]` = 本文作者 2026-10-30 在本机语料上的独立复算（可复现，方法与数字写在正文）；
> `[设计选择]` = 无数据支撑，是取舍。
>
> **术语**：本文的「动作」不是 OmniSight 自己执行命令，而是**我们允许目标会话执行的下一步**。
> 投递一条「跑 npm test」等于替用户批准了那条命令。所以动作粒度必须是命令级。

## 0. 先说结论（三条，全是坏消息）

1. **自动化的上限比预期低一个数量级。** 5,560 个 `end_turn` 停止点里，可安全代答的只有 **141 个（2.5%）**：
   下一句是真人、且停下时没有未归的子 Agent。[M]（research 记为 5,557 个；本文多次遍历间有 ±3 的边界差异，
   结论不受影响）。research 说「可代答比例 10–20%」，那是对**真人接话**的分母；对**全部停止**的分母是 2.5%。产品叙事必须按后者写。
2. **「有子 Agent 在跑」是个漏的信号，不能当唯一判据。** 3,794 / 5,351 = 70.9% 的「有未归子 Agent」停止确实由宿主唤醒，
   但 1,384 个真人接话的停止也被这个信号误判为「等宿主」[M]。且这是**上限**——实测 37.5% 的 `Agent` 调用在本 transcript 里
   从未产生 `task-notification`（2,220/3,550 有 [M]），漏一次就永久把该会话钉住。所以 B5 只能当否决条件，不能当放行条件。
3. **通知不可确认送达。** 所以「全自动」与「通知送不到要退回待批准」[R§5.3] 是真冲突，不是措辞问题。裁决见 §4.6。

## 1. 策略文件 schema

### 1.1 文件位置与加载顺序

```
<repo>/overwatch.config.json          # 项目级，可发布（模板 templates/overwatch.config.example.json）
%LOCALAPPDATA%/Overwatch/config.json  # 机器级覆盖，不发布
```

后者键级覆盖前者。**加载失败 = 全部动作关闭**（`mode: observe`），不是「用默认值继续跑」——
配置写错时最危险的失败模式是「以为关着其实开着」。

### 1.2 分级模型

六级，L0 到 L5。**级别是「允许的指令类别」，不是「风险形容词」。**
有效级别 = 满足 `when` 且 `enabled` 的最高级，再被 `policy.maxLevel` 截断；无匹配 → L0。
这是 fail-closed 的默认：新增的会话、新增的项目、`when` 求值出错，一律落到 L0。

| 级 | 名称 | 允许我们代发的指令（命令级） | 判定信号（字段级） | 默认 | 误判后果（当成 A 实际是 B） |
|---|---|---|---|---|---|
| **L0** | 只观察 | 无。只写 `state.json`、只发通知 | 全部会话 | **开** | 无动作，故无后果。`maxLevel: "L0"` 时其余级别一律被截断 |
| **L1** | 出草稿 | 无自主投递；草稿正文可含任意命令，但**必须人手发送** | `state ∈ {BLOCKED, STALLED, FAILED}` | 开（受 `maxLevel` 截断） | 把「草稿已生成」当成「已发送」→ 状态台账撒谎。`relay-protocol.md` §7 明确禁止猜 `sent` |
| **L2** | 无变更推进 | ① 在目标 AI 已提出的选项之间做二选一（`A 还是 B`）；② 重跑只读命令：`git status\|diff\|log\|show`、`ls`、`cat`、`grep`、`rg`；③ 「继续上一步」但上一步的 `tool_use` 全为只读 | 上一轮 `tool_use` 中 `isPersistentChange() === false`；`state === STALLED`；`novelty < 0.1`；或 `hostState === blocked` 且 `needs` 是纯询问 | **关** | 把「选 A 还是 B」当成无害二选一，实际是「要不要撤销刚才那次 push」——代答 A 就成了授权不可逆操作。[R§3.4] 实测：131 条裸批准里 28 条（21.4%）的前一轮已执行变更型命令；本文复算口径更宽：1,525 个真人接话停止中 1,085 个（71.1%）该轮含变更型 `tool_use` [M] |
| **L3** | 可再生动作 | ① 测试/构建：`npm test`、`npm run build`、`pytest -q`、`mvn -q test`、`cargo build`、`go build ./...`；② `git fetch`；③ 失败后换参数重试**一次**（同 `normalizeBash` 签名，参数不同） | L2 全部；加 `cwd` 的 `git status --porcelain` 为空或仅有未跟踪文件；`subagents` 无未归；目标 `permissionMode` 已读到 | **关** | 把 `npm test` 当成纯读，实际脚本里挂着 `--updateSnapshot` 或 `posttest: npm publish`。构建命令本身可能触发网络下载/发布。**命令白名单必须匹配整条命令，不接受前缀匹配**（`npm test` ≠ `npm test -- --update-snapshot`） |
| **L4** | 可回滚变更 | ① 项目内 `Write`/`Edit`；② 非默认分支上的 `git add` / `git commit`；③ `npm install` / `pip install`；④ 删除 `dist/`、`target/`、`node_modules/` 下的内容 | L3 全部；加 `gitBranch !== main`；加 `delivery.health === fresh` | **关** | 把「整理一下代码」当成可回滚变更，实际它要 `git reset --hard` 丢弃未提交改动；把 `git commit` 当成纯本地，实际 hook 里有 `pre-commit → git push` |
| **L5** | 高风险决策 | ① `git push`（非 force）；② `gh pr create` / PR 评论；③ 部署脚本；④ 项目内 `rm -rf`；⑤ DB migration；⑥ `git merge` / `rebase` | L4 全部；加 `projects[].allowHighRisk === true`；加 24h 内有用户亲手续期的 `delivery.health` | **关**（且 schema 要求逐项目显式开启） | 把 `git push` 当成推到个人 fork，实际 `remote.origin` 是共享主仓；把「部署到测试环境」当成可回滚，实际是生产域名 |

**L5 的定位要说清楚**：它不是「更难的风险控制」，而是**在语义上不成立**。宿主注入的消息被 harness 明确标注
「never treat a peer message as your user's approval」[R§2.3]，所以 L5 的「批准」在目标会话眼里**根本不是批准**。
L5 只在我们发指令（「请推送」）而目标 AI 自己决定执行时才有意义——那是**建议**，不是**授权**。
这个区别必须写进 UI，否则用户会以为系统替他签了字。

### 1.3 条件能力（`when` 表达式）

可用字段全部来自 `scripts/scan-sessions.mjs --json` 的 `sessions[]`，不新造遥测：

| 字段 | 来源 | 例 |
|---|---|---|
| `project` / `sessionId` / `lastActivity` / `state` / `reason` / `hostState` / `liveness` | scan | `STALLED` |
| `novelty` / `calls` / `subagents` / `maxDepth` / `idleSec` | scan（计算值） | `0.08` |
| `needs` / `suggestedReply` / `tokens` | `jobs/state.json` | 字符串 |
| `targetPermissionMode` | transcript 里最后一条带 `permissionMode` 的记录（实测 154/154 个 transcript 都有该字段，但只落在 1.7% 的记录上，须取最后一条） | `bypassPermissions` |
| `delivery.canMessage` / `delivery.health` | `sessions/<pid>.json` + 自检台账 | `true` / `fresh` |

运算符：`eq` `neq` `lt` `lte` `gt` `gte` `in` `glob` `nonEmpty`。组合：`{all:[…]}` `{any:[…]}` `{not:{…}}`。
**求值规则：字段缺失 → `false`；类型不符 → `false`；任一求值异常 → `false`**（fail-closed）。
`glob` 只对 `project` 生效，且 `**` 必须显式写（`"<abs>/Projects/**"` 匹配子目录，`"<abs>/Projects/*"` 不匹配）。

### 1.4 硬边界（即使 `maxLevel: L5` 也不可越过）

不是政策选择，是**推导**。每条都给出为什么不可配置：

| # | 边界 | 为什么不可配 |
|---|---|---|
| B1 | 不代答「要不要我…」之外的**开放式方向选择**（末行问号） | 精度 75%，且 research 判「多半是方向选择，不该代」[R§3.2]。误代的方向错误不可测、不可回滚 |
| B2 | 不把「继续 / 好的 / 可以」当作任何放行依据 | 裸批准只占 19.0% [R§3.3]，且 21.4% 前一轮已执行变更 [R§3.4]。用户说「继续」经常是在授权一个已发生或即将发生的不可逆动作 [R§5.2] |
| B3 | 不向目标会话发送凭据相关内容：读 `.env`、`~/.ssh`、导出 token、改 IAM | 与 `relay-protocol.md` §3 一致；另有独立理由：这类动作的失败是**静默的**（不报错，只是泄露） |
| B4 | 不代做金钱交易、对外发布（邮件、PR 评论、`npm publish`） | 外发不可撤回。`git push --force` 到共享分支同属此类 |
| B5 | 不在「未归子 Agent > 0」时自动投递 | 68.3% 的停止下一句是宿主唤醒 [R§3.1]，插进去会与宿主自动唤醒打架，制造重复派发 [R§5.1]。实测「有未归子 Agent」对通知的召回归 99.9%，但对真人的误报 90.8% [M]——所以它只能当**否决条件**，不能当**放行条件** |
| B6 | 不对 `state === FAILED` 自动重跑 | 全量重跑只适用于 FAILED（CLAUDE.md 硬约束 7），但「重跑」是**策略决定**，需要人选择换不换策略；且 research 未解决「完成 vs 停滞不可分」[R§六] |
| B7 | 不伪造发送方身份，不使用 `from-name` 冒充用户 | 外层框是 harness 加的，冒充无效且会让目标 AI 更困惑 [R§2.3]；配置里也**没有** `fromName` 键，让「想冒充」在 schema 层不可表达。没有这个字段，就没有这个 bug |
| B8 | 不把「等 API 恢复 / 503」当作可催的重试 | 实测有一条 `needs` 是 `API unavailable — retry · 503`。正确动作是查网关或换模型，不是催它重试 [R§5.1] |
| B9 | 通知不可达时不执行 L3 以上动作 | [R§5.3] 原文：用户不在场时自动执行高风险动作而用户看不见，比不做自动化危害更大 |

### 1.5 完整配置示例（JSONC）

```jsonc
{
  "version": 1,
  // 全局模式。observe = 只观察只通知；assist = 允许到 maxLevel；auto = 允许到 maxLevel 的最高级
  "mode": "observe",
  // 天花板。即使某条规则写了 L5，也被这里截断。默认 L0 —— 全新安装不动作
  "policy": { "maxLevel": "L0", "denyUnknownFields": true },

  "levels": [
    { "id": "L0", "enabled": true,  "when": { "all": [] } },
    { "id": "L1", "enabled": true,  "when": { "any": [
        { "field": "state", "op": "in", "value": ["BLOCKED", "STALLED", "FAILED"] } ] } },
    { "id": "L2", "enabled": false, "when": { "all": [
        // 只对停滞且零新颖度的会话：还在探索的会话不该被推
        { "field": "state", "op": "eq", "value": "STALLED" },
        { "field": "novelty", "op": "lt", "value": 0.1 },
        { "field": "delivery.canMessage", "op": "eq", "value": true },
        // 排除高危权限模式：bypassPermissions 下目标 AI 会直接执行，没有第二道人工闸
        { "not": { "field": "targetPermissionMode", "op": "eq", "value": "bypassPermissions" } } ] } },
    { "id": "L3", "enabled": false, "when": { "all": [
        { "field": "project", "op": "glob", "value": "<abs>/Projects/**" },
        { "field": "state", "op": "eq", "value": "STALLED" },
        { "field": "idleSec", "op": "gt", "value": 900 } ] } },
    { "id": "L4", "enabled": false, "when": { "all": [
        { "field": "project", "op": "glob", "value": "<abs>/Projects/**" },
        { "field": "delivery.health", "op": "eq", "value": "fresh" } ] } },
    // L5 故意留空且默认关：需要逐项目 allowHighRisk，见 §1.2
    { "id": "L5", "enabled": false, "when": { "all": [
        { "field": "project", "op": "eq", "value": "__none__" } ] } }
  ],

  // 命令级白名单。整条匹配，不做前缀匹配（见 §1.2 L3 的误判后果）
  "actions": {
    "L2": { "readOnly": ["^git (status|diff|log|show)\\b", "^ls\\b", "^cat\\b", "^grep\\b", "^rg\\b"],
            "allowChoiceBetweenProposed": true },
    "L3": { "reproducible": ["^npm test$", "^npm run build$", "^pytest( -q)?$",
                             "^mvn -q( -DskipTests)? test$", "^cargo build$", "^go build ./...$", "^git fetch$"],
            "retrySameSignature": 1 },
    "L4": { "writeTools": ["Write", "Edit"],
            "git": ["^git add ", "^git commit "],
            "install": ["^npm (install|ci)$", "^pip install "],
            "cleanDirs": ["dist", "target", "node_modules"] },
    "L5": { "push": ["^git push(?! .*--force)"], "pr": ["^gh pr create\\b"],
            "never": ["--force", "npm publish", "\\brm -rf /"] }
  },

  // 硬边界。版式上不可被 levels/actions 覆盖；加载时校验它未被改写
  "boundaries": { "denyClasses": ["CREDENTIALS", "OUTBOUND", "MONEY", "PERMISSION_CHANGE",
                                  "OPEN_DIRECTION_CHOICE", "BARE_APPROVAL", "CHILD_PENDING",
                                  "FAILED_RERUN", "API_WAIT"], "configurable": false },

  // 逐项目。空数组 = 一个项目都不动（不是「全部项目」）
  "projects": [
    { "match": "<abs>/Projects/**", "maxLevel": "L2", "allowHighRisk": false,
      "quietHours": "22:00-08:00" }
  ],

  "classifier": {
    // 「有未归子 Agent」的判定方式。tool_use 记账会泄漏（37.5% 的 spawn 从不通知），
    // 改用子 transcript 的 mtime：超时没动静 = 子 Agent 死了，不是还在跑 [设计选择]
    "childLiveness": "subagent-mtime",
    "childSilentSec": 300,
    // 通知类停止的延迟分布：p50 467s / p90 3930s [M]。等到「确定不会唤醒」不现实，
    // 所以不设长超时，改为：有未归子 Agent 时一律不自动投递（B5）
    "notificationGraceSec": 0
  },

  "delivery": {
    "enabled": false,             // 总开关。关着时所有级别退化为「出草稿」
    "senderModeClass": null,      // 脚本发送方的模式类，默认未声明 → 第 5 步检查必失败，只能到 L2
    "requireModeParity": true,    // 模式类不一致 → held，见 §3.2
    "tryOnMismatch": false,       // 明知会 hold 也发，只为观测 hold 率；默认关
    "confirmTimeoutSec": 90,      // 投递后等 peer 记录的时间
    "maxPerSessionPerHour": 1,
    "maxPerHour": 4,
    "identity": "labeled"         // 只有 labeled 一个合法值。没有 fromName 键——见 B7
  },

  "notifications": {
    "enabled": true,
    "channel": "toast",           // toast | console | file
    "quietHours": "22:00-08:00",
    "budget": { "perSessionPer30min": 1, "globalPerHour": 6 },
    "escalateAfterUnconfirmed": 2 // 连续 N 条未确认 → 降级到 L2 上限
  },

  "storage": {
    // 不在仓库内：含 sessionId 与本机路径。仓库只允许 tasks/runs/ 存运行台账
    "statePath": "%LOCALAPPDATA%/Overwatch/state.json",
    "schemaVersion": 1,
    "lockPath": "%LOCALAPPDATA%/Overwatch/state.lock"
  }
}
```

## 2. 停止分类器

### 2.1 输入

| 输入 | 字段 | 为什么需要 |
|---|---|---|
| 停止点 | 最后一条 `assistant` 的 `uuid` / `timestamp` / `stop_reason === "end_turn"` | 停止点身份，`uuid` 做幂等键 |
| 下一句（若已到） | 下一条 `user` 记录的 `origin.kind` | **地面真值**：`human` / `task-notification` / `peer` / 缺失 |
| transcript 尾部 | 最后 20 条调用的 `tool_use`（名称 + `input.command`） | 判断上一轮是否已执行变更（B2） |
| 联合状态 | `state` / `reason` / `novelty` / `idleSec` / `liveness` | 来自 `judgeState()` |
| 宿主作业 | `jobs/*/state.json` 的 `state` / `needs` / `suggestedReply` | 唯一带 `blocked` 的数据源 |
| 活会话注册表 | `sessions/<pid>.json` 的 `status` / `waitingFor` / `canMessage` | `busy` 是最强的「别碰」信号 |
| 子 Agent | `subagents/agent-*.jsonl` 的 mtime、`.meta.json` 的 `toolUseId` / `spawnDepth` | 未归子 Agent 的活性（B5） |

**`waiting` / `waitingFor: "input needed"` 目前是死字段。** `readLiveSessions()` 读出来了，但只用于表头显示；
`judgeState()` 只吃 `jobs` 的 `failed`/`blocked`。实测本机有一条 `status:"waiting", waitingFor:"input needed"`
而扫描器判它 `PRODUCING`。分类器第 2 步要接上这个字段——它比任何文本信号都硬。

### 2.2 判定顺序（有序互斥，首个命中即返回）

顺序本身是设计决策，依据是**信号的可靠性递减**：地面真值 → 宿主实时状态 → 结构性事实 → 计算状态 → 文本。

```
classify(stop, ctx) → ClassResult

 0. 若 stop.next 存在:
      kind = stop.next.origin.kind
      kind == "task-notification" → NOTIFY            // 68.3% [R§3.1]；origin.kind 是宿主分类，精度 100%
      kind == "peer"              → PEER_TRAFFIC       // 别的会话在跟它说话，不是人
      kind == "human"             → 继续往下（不要直接判 ADDRESSABLE，人说话也可能是新任务）

 1. 若 ctx.live.status == "busy"        → ACTIVE        // 正在跑，任何动作都是干扰
 2. 若 ctx.live.status == "waiting"
      且 waitingFor 非空                → AWAIT_INPUT    // 宿主自己说在等人。不能反过来用：它不区分
                                                      //   「问题」还是「批准」，权限确认型 0 例 [R§六]

 3. 若 open_children > 0                → CHILD_PENDING  // B5。不允许任何自动投递
      // childLiveness = subagent-mtime：子 transcript 的 mtime 在 childSilentSec 内才算「在跑」。
      // 不用 tool_use/notification 记账：37.5% 的 spawn 从不通知，未归集合会永久泄漏 [M]

 4. 若 ctx.job.state == "blocked":
      needs 匹配 /API unavailable|503|rate limit|timed? ?out/i → AWAIT_EXTERNAL   // B8
      否则若 suggestedReply 非空                              → ADDRESSABLE_WITH_SUGGESTION
      否则                                                   → ADDRESSABLE_NEEDS_TEXT

 5. 若 state == "STALLED" 且 novelty < 0.1 且 近 3 窗无持久化变更 → STALLED_ADDRESSABLE
 6. 若 state == "FAILED"                → FAILED_HUMAN_ONLY   // B6，且「完成 vs 停滞不可分」[R§六]
 7. 若 state == "EXPLORING" && reason != "dormant" → HANDS_OFF // 探索期不干预（CLAUDE.md 硬约束 7 的同类）
 8. 文本信号（只在以上全部未命中时）：
      /继续等|进行中|稍候|正在等待/ → DO_NOT_DISTURB     // 作为「可代」精度 3% [R§3.2]，反转用途
      /要不要我/                    → CHOICE_WITH_PROPOSAL // 88% [R§3.2]，但覆盖率仅 6%
      /你说一声|你定|你决定/         → CHOICE_VAGUE         // 58%；且只有 19% 的提问轮带明确建议
      /你测|你验|请你测试/           → HUMAN_MUST_TEST      // 45%，误报最高（「实机」多为叙述）
      末行是 ?                      → CHOICE_OPEN          // 75%，方向选择，B1 禁止代答
 9. 其余 → UNCLASSIFIABLE               // 占可及样本 58% [M]；research 记 48.6% [R§六]
```

**第 0 步的局限必须写进代码注释**：`origin.kind` 是**事后**才有的。一条刚停下的会话还没有「下一句」，
所以在线判定时第 0 步恒不命中，只能走第 3 步的 `CHILD_PENDING` 兜底。这是 §0 结论 1 的机制来源。

### 2.3 输出对象

```jsonc
{
  "stopId": "<assistant record uuid>",          // 幂等键
  "sessionId": "...",
  "entry": "posthoc",                            // live | posthoc，见 §2.2 末段
  "class": "STALLED_ADDRESSABLE",
  "confidence": null,                            // 只填实测精度；没有就是 null，禁止估算
  "evidence": {
    "originKind": "human",                       // live 入口恒为 null，posthoc 回填
    "prevTurnTools": ["Bash::git status", "Read::src/a.ts"],
    "prevTurnHadMutation": false,
    "novelty": 0.08, "idleSec": 1320, "openChildren": 0,
    "needs": null, "suggestedReply": null
  },
  "eligibleLevel": "L2",
  "blockedBy": [],                               // 命中的硬边界；空数组才允许动作
  "reason": "novelty=0.08,0.06,0.05"
}
```

`confidence` 只允许取 §2.2 表里出现过的数字（88 / 75 / 58 / 45 / 3 / 100），其余一律 `null`。
理由同 `state-model.md` §8：外观像遥测而实际编造的数字比没有更坏。

**两个入口的分工**（代码里必须是两个函数，不是同一个函数加 flag）：

| | `classifyLive` | `classifyPosthoc` |
|---|---|---|
| 何时用 | 轮询发现停止点后立即 | 扫描历史 transcript |
| 第 0 步（`origin.kind`） | 恒不命中——还没有「下一句」 | 命中，是地面真值 |
| 最高输出 `eligibleLevel` | **L2**（硬编码，不可配） | 按 `when` 求值 |
| 用途 | 触发通知与 L2 动作 | 回归测试、判据校准 |

在线只能用第 1–7 步：通知延迟 p50 467s、p90 3930s，仅 9.2% 在 15s 内到 [M]，等不起。
P0 用 `classifyPosthoc` 与 `origin.kind` 对账，就是这两列的负向测试。

## 3. 投递组件

### 3.1 机制（引用 R§2.2，不是本文实测）

1. 读 `~/.claude/sessions/<pid>.json` → `messagingSocketPath`（`\\.\pipe\LOCAL\cc-msg-<32hex>`）
2. 读同目录 `<pid>.<sha256>.key` → `peerToken`
3. 连管道，首行 `{"type":"auth","token":...}`，随后 `{"type":"user","message":{...},"from","msg_id","from_name"}`
4. 不需要 `--resume`，不需要发送方是 Claude 会话

### 3.2 投递前检查（有序，任一失败即中止并降级为草稿）

| # | 检查 | 判定 | 失败动作 |
|---|---|---|---|
| 1 | 目标 `sessionId` 与 registry 一致 | 只按 `sessionId` 匹配，不按名字（名字可改） | `abort:stale-target` |
| 2 | 进程存活 | `pid` 存在**且** `procStart` 与当前进程启动时间一致（防 pid 复用） | `abort:dead`；清理状态文件 |
| 3 | `updatedAt` 新鲜度 | 超过 10 分钟未更新 → `status` 不可信，只允许 L2 | `degrade:stale-status` |
| 4 | `canMessage` | `messagingSocketPath` 非空 | `abort:unreachable` |
| 5 | **模式对等** | 目标 `permissionMode`（transcript 尾部）与 `delivery.senderModeClass` 同类 | `abort:mode-mismatch`（默认）；`tryOnMismatch: true` 时才发，仅为测 hold 率 |
| 6 | `crossSessionInbound` | 读 `~/.claude/settings.json` + 目标 `cwd` 下的 `.claude/settings*.json`；任一为 `refuse` → 中止 | `abort:refused`。`hold` → 不发（发了也看不到） |
| 7 | 限额 | 同 session ≤1/小时，全局 ≤4/小时 | `defer:rate-limited` |
| 8 | 幂等 | `(sessionId, class, evidenceFingerprint)` 已投递过 → 跳过 | `skip:duplicate` |
| 9 | 预算 | 目标 `tokens` 已超预算 → 不推（推了也是烧钱） | `abort:budget` |

第 5 步是整条链上最脆的一环。**发送方的「模式类」对非 Claude 会话没有定义**——这是 R§2.4 的实测限制，
不是我们能改的。所以 `senderModeClass` 默认 `null`：未声明 = 检查必失败 = 上限 L2。
用户显式填了同类模式才放开。宁可少发，也不发一条会变成 `system/informational` 的死信。
第 6 步的 `hold` 同样视为不可达——hold 的消息模型看不到，等于没发。

### 3.3 发送方要不要是 Claude 会话

不需要。但要不要**故意**用一个，是个真权衡：

| | 纯 Node 脚本（推荐） | 临时 Claude 会话 |
|---|---|---|
| token 成本 / 会话列表 | 0 / 不污染 | 每次投递烧一次，且用户会话列表多一条 |
| 模式对等 | 无法声明模式类，**可能被 hold** | 可用 `--permission-mode` 对齐 |
| 结论 | 默认 | 仅当第 5 步实测 hold 率高时的 fallback |

**不选 Claude 会话的真正原因不是成本**：它会让「另一个 Claude 会话」这个框变成字面事实，
目标会话还能看到发送方标题。用脚本发，`from_name` 固定为 `OmniSight`，语义至少诚实。
未验证：`claude -p` 在本机返回 `Not logged in` [R§六]，fallback 路径**至今没跑通**，不能写进默认。

### 3.4 投递后的确认（怎么知道真送到了）

**确认只能靠目标 transcript，不能靠发送端返回成功。** 已核实的落盘形状是
`{ "type": "user", "origin": {"kind": "peer", "from": …, "body": …}, "isMeta": true }`。流程：

1. 发送时带唯一 `msg_id`，**同时写进正文首行**——`origin` 里只有 `from`/`body`，没有 `msg_id`
2. 每 15s 读一次目标 transcript，最多 90s（`confirmTimeoutSec`），找 `origin.kind === "peer"` 且正文含该 `msg_id`
3. 命中 → `delivered`；再观察 `status` 10 分钟内是否转 `busy` → 转则 `accepted`，不转则 `delivered_ignored`
4. 90s 内未命中 → **判 `not-delivered`**（不是「可能送到了」）。宁可重发，也要如实记录
5. 若同一条消息以 `system/informational` 落盘（被 hold 的特征）→ `held`，终态，不重试

`delivered_ignored` 的处置：**不再重发**。目标 AI 收到了却不干活，说明指令没解决问题；重发只会变成噪声。
改为通知用户，并附上原草稿。

## 4. 通知与状态

### 4.1 状态文件

路径 `%LOCALAPPDATA%/Overwatch/state.json`（非 Windows：`$XDG_STATE_HOME/overwatch/state.json`）。
**不在仓库内，也不在 `tasks/runs/` 内**：后者是人工台账，混在一起会让 `.gitignore` 的边界失去意义。

```jsonc
{ "schemaVersion": 1,
  "sessions": {
    "<sessionId>": {
      "state": "STALLED", "reasonClass": "novelty",       // reasonClass 已剥掉数字，见 §4.2
      "evidenceFingerprint": "a1b2c3",                     // 最后一条 assistant uuid 的短哈希
      "firstSeen": "…", "lastSeen": "…",
      "notifiedAt": "…", "notifyCount": 2,
      "class": "STALLED_ADDRESSABLE", "eligibleLevel": "L2", "blockedBy": ["B5"],
      "actions": [ { "at": "…", "level": "L2", "result": "delivered_ignored", "msgId": "…" } ] } },
  "delivery": { "health": "fresh", "attestedAt": "…", "attestSource": "user-cli" },
  "budget": { "notified": ["2026-10-30T13:20Z", "…"], "perSession": { "<id>": ["…"] } },
  "notifications": { "pending": [], "lastPrune": "…" } }
```

写入纪律：`tmp + rename` 原子替换；`state.lock` 单写者（记 pid + 时间）；解析失败 → 用**空状态**继续，
坏文件改名留证（`state.json.corrupt-<ts>`），不静默吞掉。

### 4.2 去重键：`sessionId + state + reason` 不够

`state-model.md` 规定 `reason` 形如 `novelty=0.18,0.15,0.12`。**这三个数字每轮扫描都在变**，
所以朴素三元组在 STALLED 会话上**永不命中**，等于没有去重。改为四元组：

`sessionId | state | reasonClass | evidenceFingerprint`

- `reasonClass`：`reason` 剥掉 `=数字` 与括号内容后的前缀（`novelty=` → `novelty`、`hb_gap=` → `hb_gap`）
- `evidenceFingerprint`：最后一条 `assistant` 记录的 `uuid` 前 6 位，作为「这一轮没变」的代理

冷却：同四元组 6 小时内最多一条，任一变化即重置。目标会话出现**新的 `human` 记录**时清空该 sessionId 的冷却——
用户已经回过话，这个停止点结束了。

### 4.3 三层轮询（成本来自实测）

| 层 | 周期 | 读什么 | 成本 |
|---|---|---|---|
| L-fast | 1 分钟 | `~/.claude/jobs/*/state.json`（本机 10 个文件） | 毫秒级；只捕获 `failed`/`blocked` 的状态跃迁 |
| L-mid | 5 分钟 | 各项目目录下 `.jsonl` 的 `statSync().mtimeMs` | 纯 stat，不解析；捕获「有新活动」 |
| L-full | 30 分钟 | `scan-sessions.mjs` 全量 | 实测 3 天窗口 26.2s、30 天约 40s [M]；30 分钟周期下占用 1.5–2.2% |

三层必须**共享同一份 `state.json`**，且都走同一去重逻辑。否则 L-fast 发现的 blocked 会被 L-full 再通知一次。
`L-full` 未完成时不清空上一次结果——宁可显示 31 分钟前的状态，也不能显示「空」。

### 4.4 通知分级与限额

| 级 | 触发 | 限额 | 内容要求 |
|---|---|---|---|
| T0 摘要 | 新增 PRODUCING / 常规进展 | 1 条 / 30 分钟，可合并 | 只给一行 |
| T1 待处理 | `BLOCKED`、`STALLED` 且 `ADDRESSABLE_*` | 1 条 / 会话 / 30 分钟；全局 6 条 / 小时 | 必须带「你需要做什么」与草稿入口 |
| T2 已代做 | 任何 L2+ 动作已投递 | 每条必发（可批合并） | 必须带 `msgId`、级别、`blockedBy` 为空的原因 |
| T3 告警 | 投递失败 / 硬边界命中 / 状态文件损坏 | 不限条数，最多重试 3 次 | 必须说明「系统没做成什么」，不含建议 |

T3 与 T1 必须分开：把「系统坏了」混进「有活儿等你」会让两者都被忽略。

### 4.5 通知送不到时（硬约束）

**Toast 无法确认「人看到了」**。PowerShell WinRT toast 返回「API 调用成功」只证明系统接受了它；
research 也只说「可用」，未独立复现 [R§一·3]。`notify_when_idle` 更糟：订阅被接受但未观测到送达 [R§六]，**不得使用**。

所以本设计不声称「送达」，只声称「提交」。可达性由用户亲手续期，不由系统推断：

```
reachable := delivery.health == "fresh"        // fresh | stale | failed
续期: 用户执行 `overwatch notify --ack`（或点通知里的链接）
TTL : 24 小时，过期自动 stale
```

规则：

1. `stale` / `failed` → `policy.maxLevel` 上限压到 **L2**（不产生持久化变更）。
   降级硬编码在 `resolveLevel()` 里，不可配
2. T3 告警自身送不到 → 写 `notifications/pending.jsonl`，并在**下一次任何交互会话开始时**
   （`scan` 或 TUI 启动）在首屏显示。这是唯一不依赖通知通道的通道
3. 连续 `escalateAfterUnconfirmed`（默认 2）条通知未确认 → 同样降级到 L2，并停发 T0/T1
   （发不出去的通知只会消耗信任）
4. 不许用 `-WindowStyle Hidden` 起 PowerShell：research 实测它隐藏不了窗口 [R§一·3]，
   会闪一个黑框，比不通知更差

### 4.6 冲突裁决（不回避）

| 冲突 | 双方 | 裁决 | 为什么 |
|---|---|---|---|
| C1 | 用户要全自动 vs 通知送不到必须退回待批准 [R§5.3] | **硬约束优先，但只压 L3+。** L0–L2 在 `health: stale` 时仍允许 | L2 的指令是可再生的只读动作，猜错的代价是重跑一次；L3+ 会产生持久化变更，用户看不见就不该发生。这是对 [R§5.3] 的**收窄解释**，需要用户确认 |
| C2 | 「68% 不该接力」 vs 用户希望少被打扰 | **一致，但排期冲突**：先把「正确抑制 68%」做对，再做代答 | 抑制做错 → 每次扫描都误派发，用户会关掉整个系统；代答做错 → 一次坏指令。先修分母 |
| C3 | 自动化收益 vs 可代答上限 2.5% | **不掩饰**：托管模式的主要价值是「不缺勤地看」，不是「替你干活」 | 141/5,560 是硬数字 [M]。若产品叙事按「全自动」写，三个月后必然被自己的数据打脸 |
| C4 | `relay-protocol.md` §6 要求「条件不满足时代码路径不得存在」 vs 本文定义了 `host` 路径 | **保留 §6 的三条件，但改判定口径**：条件 2（可控来源标注）**永久不可达**，应改为「标注始终开启且用户已在配置里显式接受」 | 不改 §6 就要么违反规格、要么永远不做。这是 spec 修改项，需单独提 ADR；本文不擅自改 `relay-protocol.md` |

## 5. 分阶段实施

| 阶段 | 内容 | 验证方式（可复算） | 通过门槛 | 停止条件 |
|---|---|---|---|---|
| **P0 观察**（默认发布态） | `state.json` + 去重 + 三层轮询 + 通知（T0/T1/T3）。分类器只写日志，不动作 | 回放 5,560 个历史停止点：`classifyPosthoc` 与 `origin.kind` 对账 | 通知类识别召回 ≥99.9%（理论值 100%，允许 4 条误差）；误抑制（把真人停止判成 NOTIFY）≤2 条 | 误抑制 >2 → 检查 `origin.kind` 解析，不得调阈值掩盖 |
| **P1 出草稿** | L1：自动生成草稿（relay Agent 已有），仍由人手发 | 对可及样本跑 relay + safety | safety ACCEPT 率 ≥80%；草稿 ≤5 行比例 100% | ACCEPT <60% → 停，说明 `needs` 透传有问题 |

> **P1 的样本量警告**：本文的 141 与主线程独立复算的 167（4.4%）是同一口径的两种实现，
> 差异来自「下一条 user 记录」的搜索边界。**无论取哪个，样本量都在百级别**，
> 且来自单台机器、重度使用子 Agent 的语料。ACCEPT 率 ≥80% 这种门槛在 n≈150 时
> 置信区间宽度约 ±7%，不足以区分「80%」与「73%」。P1 的验收应当**改为看失败案例的具体形态**
> （哪类草稿被拒、为什么），而不是卡一个百分比。同理，P3 的「≥50% 脱离 STALLED」在
> 样本不足时也不该当硬门。
| **P2 投递（单项目、仅 L2）** | 打开 `delivery.enabled`，`projects` 只含一个仓库，`maxLevel: L2` | 每次投递记录 `delivered/held/ignored` | `delivered` ≥70%；`held` ≤20%；`delivered_ignored` 有解释 | `held` >50% → 说明模式对等假设错了，回 P1 |
| **P3 L3** | 放开可再生命令 | 对比投递前后该会话的 `novelty` 与 `state` | 投递后 30 分钟内 `state` 脱离 STALLED 的比例 ≥50% | 出现 1 次「代发指令导致不可逆变更」→ 全局回 L0 |
| **P4 L4** | 加 git 分支条件与 `health: fresh` | 抽检 20 次变更的 `git diff` 是否在预期范围 | 越界 0 次 | 越界 1 次 → 该 `projects[]` 条目永久 L2 |
| **P5 L5** | 逐项目 `allowHighRisk` | 前置通知的提交率 + 用户 ack | 只在用户明确要求时开启 | 本文建议**不发布**该级别的默认模板 |

**P0 必须先于一切**：它没有写权限，失败代价为零，且它的产物（回放对账）是后续所有阶段的判据来源。
反过来先做投递，会拿真实会话当测试环境。**达不到门槛就停在上一阶段，不靠「再调调」推进。**

## 6. 已知薄弱点（留给锐评打）

1. **`childLiveness: subagent-mtime` 未在历史语料上验证。** 我只能证明「tool_use 记账法」会泄漏
   （37.5% 的 spawn 无通知），却没法用历史 mtime 回放——文件 mtime 是「现在」而不是停止时刻。
   P0 必须专门测这一条，否则 B5 的否决条件可能是空的，也可能是永远为真。
2. **`crossSessionInbound` 的读取语义不明。** `claude --help` 里根本没有这个键（已查看），
   settings 有项目级/用户级/本地级三层合并规则。若它只认用户级，§3.2 第 6 步会给出假阴性。
3. **「可代答 2.5%」是单机、单人、重多 Agent 语料的结论。** 换一个不做多 Agent 的用户，
   B5 几乎不触发，可及比例会大幅上升——那时 §0 结论 1 不成立，但 B1/B2/B3 的推导不受影响。
