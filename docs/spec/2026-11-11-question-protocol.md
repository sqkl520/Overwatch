# 提问协议（Question Protocol）

> **状态：Proposed。零行实现。**
> 本文件把 [`../design/2026-11-11-question-protocol-thesis.md`](../design/2026-11-11-question-protocol-thesis.md)
> 的四条设计约束（形态 / 主体 / 时机 / 风险分级）变成可实现的规格。
> 它描述**应该怎么实现**，不描述现在已经实现了什么。当前能力以 [`../../README.md`](../../README.md) 为准。
>
> **一句话**：把「问问题」从一句 prompt 里的礼貌用语，变成一份**带 schema、带校验器、带事后审计**的产物。

---

## 0. 依据与边界

**读了**（本仓）：`README.md`、`CLAUDE.md`、`docs/spec/evidence-discipline.md`、`docs/spec/dispatch-contract.md`、
`docs/spec/output-format.md`、`docs/spec/state-model.md`、`docs/spec/relay-protocol.md`、
`docs/design/2026-11-11-question-protocol-thesis.md`、`docs/design/continuation-engine.md` §3.2、
`docs/design/intent-contract.md` §2.3–§2.4、`docs/adr/0001-config-only.md`、
`.claude/agents/*.md` 全部 12 份的「输出」小节、`.claude/skills/oversight/SKILL.md`、
`scripts/validate-run.mjs`（`CAPABILITIES` / `SHAPES` / `VAGUE` / `validateGraph`）、
`scripts/classify-stop.mjs`（全文）、`scripts/asked.mjs`（全文）、
`scripts/verify-claims.mjs` 的头部与 `EVIDENCE_STATUS` / `CLAIM_FAMILIES` / 命令正则族、
`scripts/check-structure.mjs`（全文）、`templates/dispatch.md`、`templates/acceptance-criteria.md`。

**实测过的**：本仓 12 个角色定义里，「## 输出」下的标题**没有一个重复**（12 种模板）。
这就是 §8 要求「问题必须是一种数据，不是又一种散文模板」的直接理由。

**没做的**：本文件**没有**在任何真实 run 上跑过；没有验证宿主的 `AskUserQuestion` 在中文长选项下的渲染宽度；
没有测过「5 个问题一包」在真实用户手里的完成率。本文所有默认值都标了 `[设计选择]`，
**凡是没有实测支撑的数字，都不许当成实测结论引用**。

### 0.1 本文不做什么

| 不做 | 归属 |
|---|---|
| 不判断「问得对不对」（这只能靠返工率事后统计） | 本文只保证「问了」「问的形状合规」「答案被记录」 |
| 不实现运行时拦截（宿主不允许） | 见 §6.4 的能力边界，引 ADR-0001 §1 |
| 不定义问题从哪生成（从代码？从 transcript？） | 本文只定义**问题的形状**和**来源必须可指认** |
| 不改任何现有代码或规格 | 本文是新增文档；对接点写在 §7 |

---

## 1. 数据结构

### 1.1 总览

三层，各自独立可校验：

```
QuestionPolicy   一份策略（策略：什么时候问、问几档、超了怎么办）
      ↓ 产出
QuestionPack     一个包（≤5 个问题 + 溢出登记 + 覆盖自证 + 交付记录）
      ↓ 交付后
Answer           一条答案（逐字原文 + 指向 transcript 记录的引用 + 授权结论）
```

**规范形式是 JSON。** 类型定义用 TypeScript 语法书写（便于人读），JSON Schema 由它机械生成，
**类型定义是唯一真源**——手写第二份 schema 必然漂移，这是本项目已经踩过的坑
（`validate-run.mjs` 存在的理由：schema 写在 agent 定义里，从来没人检查产物符不符合它）。

字段命名用 `snake_case`，与 `task-graph.json` 保持一致。

### 1.2 `Question`

```ts
interface Question {
  id: string;                  // "Q-<run-id>-<nn>"，包内唯一、稳定；答案靠它回指
  subject: string;             // 归一化主题键，如 "branch-strategy" / "src/auth/login.ts#session-store"
                               // 去重与冲突检测都靠它，见 §5.1
  ask: string;                 // 一句话问题，≤ 120 字符
  context: string;             // 为什么问这句（≤ 3 行）。给用户看的，须引用具体事实
  kind: 'choice' | 'multi' | 'confirm' | 'rank' | 'open';

  options: Option[];           // kind !== 'open' 时 ≥ 2 个；kind === 'open' 时可为 []
  recommended: Recommendation | null;   // kind === 'open' 时必须为 null；否则必填
  open_entry: OpenEntry;       // 四种形态之一，**恒存在**（用户随时可以自由回答）

  risk: Risk;
  source: Source;
  urgency: Urgency;

  default_if_unanswered: DefaultAction | null;  // risk.level === 3 时必须为 null
  proposer: Proposer;          // 谁提的（多 Agent 场景下的追责锚点）
  answered: Answer | null;     // 交付后回填；draft 阶段为 null
}
```

#### 1.2.1 `Option` —— 选项必须自带代价

「选项」不等于「几个词」。一个没有后果说明的选项，是把决策成本推回给用户。

```ts
interface Option {
  id: string;                  // "A"/"B"/... 包内唯一；答案按 id 回指，不按顺序
  label: string;               // 显示文本，≤ 40 半角 / 20 全角显示宽度
  consequence: string;         // **选了这个之后会发生什么**，可观测、具体。见下方禁止清单
  capabilities: string[];      // 受控词表，见 §3.4。决定这个选项要不要问、能不能问
  reversible: 'yes' | 'costly' | 'no';
  blast_radius: 'run' | 'repo' | 'remote' | 'external';
  undo: string | null;         // 怎么撤销；reversible === 'no' 时**必须为 null**（没有撤销办法）
  estimated_cost: {
    minutes: number | null;    // null = 不知道，不许编
    money: number | null;      // 同上
    tokens_est: number | null; // 必须带 est 语义，见 state-model.md §7
  };
  detectable: boolean;         // 选错了，事后能不能看出来（假 = 风险 +1 档，见 §3.3）
  excludes: string[];          // 互斥声明 "<question_id>:<option_id>"，见 §5.3
  evidence: EvidenceRef[];     // 这个选项凭什么存在（读过的 file:line / 规格 / 用户原话）
}
```

**`consequence` 的禁止写法**（校验器按 `validate-run.mjs` 的 `VAGUE` 同一套规则拦）：

```
视情况而定 / 按需 / 酌情 / 看情况 / 可能有影响 / 建议进一步评估 / 无
```

理由与 `templates/acceptance-criteria.md` 的反例表一致：**不可判定的条目等于没有**。
一个写「视情况」的选项，用户选了也不知道自己同意了什么事。

#### 1.2.2 `Recommendation` —— 推荐必须自带反驳条件

```ts
interface Recommendation {
  option_id: string;
  why: string;                 // 为什么推荐。必须引用可核查事实，不许「我觉得」
  confidence: 'high' | 'medium' | 'low';
  falsifier: string;           // **什么情况下这个推荐作废**。必填，不许留空
  based_on: EvidenceRef[];     // ≥ 1 条
}
```

`falsifier` 是硬约束 5（禁止静默共识）在单个问题上的落地：
一个说不出「什么情况下我就不该这么推荐」的推荐，不是推荐，是断言。

#### 1.2.3 `OpenEntry` —— 开放式入口始终在场

```ts
interface OpenEntry {
  enabled: boolean;            // 默认 true
  hint: string;                // 提示用户可以在哪里自由回答，如「上面 A/B 都不对，直接说你想要什么」
  on_freeform: 'verbatim' | 'interpret_with_review';
  // verbatim            = 自由文本原样作为答案，不做解释（默认）
  // interpret_with_review = 允许解释，但解释必须写进 ledger 并标 inferred，且据此执行前还需一次确认
  disabled_because: string | null;  // enabled === false 时必填（如通道不支持输入）
}
```

「四种形态并存」在这里的实现方式是：**`options` + `consequence` + `recommended` + `open_entry` 四个字段缺一不可**，
不是四种互斥的问题类型。用户永远可以不走选项，直接说人话。

#### 1.2.4 `Risk` —— 见 §3，此处只给形状

```ts
interface Risk {
  level: 0 | 1 | 2 | 3;        // 声明值（由轴计算得出，见 §3.3）
  effective: 0 | 1 | 2 | 3;    // 计算值（含不可检出抬升与 capability 下限）
  axes: { reversible: string; blast_radius: string; cost: string; detectable: boolean };
  hard_forbidden: boolean;     // 该问题是否触及不可经本协议授权的动作，见 §3.5
  reason: string;              // 一句话，必须引用是哪条轴顶上去的
}
```

**校验器会重算 `level` 与 `effective`。** 手填对不上直接拒绝——这是这套分级里唯一「不可商量」的机械约束。

#### 1.2.5 `Source` —— 问题从哪来

```ts
interface Source {
  kind: 'user-words' | 'ambiguity' | 'code' | 'transcript' | 'spec-gap' | 'conflict' | 'agent-proposal';
  ref: string;                 // file:line | 消息 uuid | 规格 §x | 派发单 id
  verbatim: string | null;     // 用户原话片段。kind === 'user-words' 或 'ambiguity' 时必填
  anchor: string | null;       // 「用户原话里的哪个词」/「代码里的哪个位置」，一句话
  derived: boolean;            // 是否由推断得到。true 时 ref 必须能追到一条 verbatim 或 file:line
}
```

对应用户原话「问问题是一个很重要的环节」的反面：**问题不能凭空产生**。
一条说不出自己从哪个词、哪一行、哪条规格冒出来的问题，是噪声。

#### 1.2.6 `Urgency` —— 不回答会不会阻塞

```ts
interface Urgency {
  blocks: 'now' | 'later' | 'never';
  blocking: string[];          // 被阻塞的 subtree id（task-graph.json 的 subtrees[].id）
  deadline: string | null;     // ISO 时间；到点后的行为由 pack.on_timeout 决定，不由问题自己决定
}
```

`blocks: 'now'` 的问题排进包的前面（§5.2）；`'never'` 的问题不进包，直接进 `coverage.decisions_dropped` 并写理由。

#### 1.2.7 `DefaultAction` —— 没人回答会怎样

```ts
interface DefaultAction {
  kind: 'proceed' | 'skip' | 'abort';
  what: string;                // 具体做什么，可观测
  risk_of_default: 0 | 1 | 2 | 3;   // 这个默认动作本身的风险档
  reversible: 'yes' | 'costly' | 'no';
  announced: boolean;          // 是否会在用户可见输出里声明「我按 X 默认做了」
}
```

两条硬不变量（校验器强制执行）：

1. `risk.level >= 3` → `default_if_unanswered` **必须为 null**。不可逆的事没有默认值。
2. `default_if_unanswered.risk_of_default < risk.level`。默认动作必须**严格低于**问题本身的风险档——
   否则「默认」就是在替用户冒险。

#### 1.2.8 `Proposer`

```ts
interface Proposer {
  capability: string;          // 受控词表内的角色 id（executor / research / critic / ...）
  subtree: string;             // task-graph.json 的 subtree id
  at: string;                  // ISO
}
```

规则：**提议者不得回答自己提的问题**（`proposer.capability` 不得出现在该问题的 `answered.by` 里）。
这与 `dispatch-contract.md` §3 的独立性约束同源：自己提、自己答，等于没问。

### 1.3 `QuestionPack`

```ts
interface QuestionPack {
  schema_version: 1;
  pack_id: string;             // "P-<run-id>-<n>"
  run_id: string;
  created_at: string;
  policy: PolicySnapshot;      // 生成本包时生效的策略快照（不是引用——策略会变，快照不会）
  questions: Question[];       // ≤ pack_cap（默认 5）
  overflow: OverflowRecord[];  // **不许丢**。没进包的问题逐条登记，见 §4.4
  coverage: Coverage;          // 自证：为什么包里只有这些
  deliveries: Delivery[];      // 物理交付记录（一个包可以分多次交付）
  on_timeout: 'block' | 'proceed_with_defaults' | 'abort_run';
  state: 'draft' | 'delivered' | 'partially_answered' | 'answered' | 'expired' | 'superseded';
}
```

#### 1.3.1 `Coverage` —— 「问少了」的自证

这是整个协议里最能挡「跳过提问」的字段。它把「不问」变成一笔必须记账的账。

```ts
interface Coverage {
  decisions_seen: number;             // 本轮识别出的待决策点总数
  decisions_asked: number;            // 进包的
  decided_by_guess: GuessedDecision[];  // 按 §3.2 允许直接猜的，逐条登记假设
  decisions_dropped: DroppedDecision[]; // 主动不做的，必须写理由
  no_open_questions_why: string | null; // questions 为空时必填
  basis: string;                      // 怎么数出来的（读了哪些输入、用了什么判据）
}

interface GuessedDecision {
  subject: string;
  assumed: string;            // 假设的具体内容
  risk: 0 | 1 | 2 | 3;        // 必须 ≤ 2，且必须低于会触发提问的档位
  why_no_ask: string;         // 为什么这一条可以直接猜
  reversible: 'yes' | 'costly' | 'no';
  announced: boolean;         // 是否在用户可见输出里说了
}

interface DroppedDecision {
  subject: string;
  why_dropped: string;        // 为什么这一条不值得问
}
```

**算术不变量**（校验器执行，`PACK_ARITHMETIC`）：

```
decisions_seen === decisions_asked + decided_by_guess.length + decisions_dropped.length
```

对不上即拒绝。这条把「我看了很多，实际只问了一个」这种失效变成了一道除法。

#### 1.3.2 `Delivery`

一个包（逻辑）可以分多次交付（物理）——宿主单次调用能装几个问题是有上限的，
这个上限**以运行时探测为准，不得在规格里写死**。

```ts
interface Delivery {
  delivery_id: string;
  channel: 'ask_user_question' | 'markdown' | 'cli';
  at: string;
  question_ids: string[];
  capacity_used: number;       // 本次实际装了几个；超过探测到的容量即违规
  capacity_observed: number;   // 本次探测到的通道容量
  acknowledged_at: string | null;  // 宿主确认用户看到/交互过。null = 未确认，不计入「已问」
  failure: string | null;      // 通道失败原因；不为 null 时必须走 §2.8 的降级路径
}
```

#### 1.3.3 `OverflowRecord`

```ts
interface OverflowRecord {
  subject: string;
  question_draft: Pick<Question, 'ask' | 'risk' | 'source'>;
  disposition: 'next_pack' | 'guessed' | 'dropped' | 'run_aborted';
  reason: string;
}
```

`disposition: 'guessed'` 时该条必须同时出现在 `coverage.decided_by_guess` 里（同一 subject），
否则校验器报 `PACK_ARITHMETIC`。

### 1.4 `Answer`

```ts
interface Answer {
  question_id: string;
  at: string;
  kind: 'option' | 'freeform' | 'unknown' | 'timeout' | 'waived';
  option_ids: string[];        // kind === 'option' 时必填（multi 可多个）
  text: string | null;         // kind === 'freeform' 时逐字原文
  raw: string;                 // 宿主落盘原文，**不加工、不摘要、不转述**
  evidence: EvidenceRef;       // 指向 transcript 的那一条记录（file:line 或 uuid）
  by: string;                  // 来源：'human' | 'timeout' | 'policy'
  authorization: Authorization | null;  // 见 §7.2
}
```

**`raw` 是硬要求。** `evidence-discipline.md` §1 要求「真实原文，不许转述」——
这条对 AI 产出适用，对**用户回答**同样适用。摘要过的答案无法判断用户到底同意了什么。

### 1.5 `EvidenceRef`

```ts
interface EvidenceRef {
  kind: 'file-line' | 'transcript' | 'command' | 'user-words' | 'spec';
  ref: string;                 // "scripts/asked.mjs:131" | "<uuid>" | 命令 + 退出码 | 规格 §x
  quote: string | null;        // 原文片段（kind 为 user-words / spec 时必填）
}
```

### 1.6 完整示例（一个真实形状的包，节选 1 个问题）

```json
{
  "schema_version": 1,
  "pack_id": "P-run-2026-11-11-a-1",
  "run_id": "run-2026-11-11-a",
  "created_at": "2026-11-11T09:12:00Z",
  "policy": {
    "schema_version": 1,
    "strategy": "upfront", "gates": null, "pack_cap": 5,
    "max_packs_per_run": 3, "defer_ceiling": 0,
    "on_timeout": "block", "delivery_capacity": null,
    "allow_agent_proposals": true
  },
  "questions": [
    {
      "id": "Q-run-2026-11-11-a-01",
      "subject": "state-file-location",
      "ask": "新的问题包 JSON 存哪里？",
      "context": "tasks/runs/ 已被 .gitignore 排除（check-structure.mjs 强制），存这里不进版本库。",
      "kind": "choice",
      "options": [
        {
          "id": "A",
          "label": "tasks/runs/<id>/questions/",
          "consequence": "不发布，含会话 ID；check-structure 已保证该目录被忽略",
          "capabilities": ["doc_edit"],
          "reversible": "yes", "blast_radius": "run", "undo": "删目录",
          "estimated_cost": { "minutes": 0, "money": null, "tokens_est": null },
          "detectable": true,
          "excludes": [],
          "evidence": [{ "kind": "file-line", "ref": "scripts/check-structure.mjs:30", "quote": "PRIVATE_PATHS = ['tasks/runs', ...]" }]
        },
        {
          "id": "B",
          "label": "docs/spec/questions/",
          "consequence": "会进版本库，问题文本可能含项目内细节，需人工脱敏",
          "capabilities": ["doc_edit"],
          "reversible": "costly", "blast_radius": "repo", "undo": "git revert，但已推送的提交要改写历史",
          "estimated_cost": { "minutes": 5, "money": null, "tokens_est": null },
          "detectable": true,
          "excludes": [],
          "evidence": [{ "kind": "spec", "ref": "CLAUDE.md 目录归属表", "quote": "运行台账 tasks/runs/ 不发布" }]
        }
      ],
      "recommended": {
        "option_id": "B",
        "why": "问题包是产物的一部分，应当可审查；A 目录已被排除，clone 后不存在，别人看不到",
        "confidence": "medium",
        "falsifier": "若问题文本里出现会话 ID 或本机路径，则 B 不成立——那时只能退回 A 或先做脱敏规则",
        "based_on": [
          { "kind": "file-line", "ref": "scripts/check-structure.mjs:30", "quote": "tasks/runs" }
        ]
      },
      "open_entry": { "enabled": true, "hint": "都不对就直接说存哪", "on_freeform": "verbatim", "disabled_because": null },
      "risk": {
        "level": 1, "effective": 1,
        "axes": { "reversible": "costly", "blast_radius": "repo", "cost": "minutes", "detectable": true },
        "hard_forbidden": false,
        "reason": "影响面 repo，且一旦推送，改目录要改写历史"
      },
      "source": {
        "kind": "spec-gap", "ref": "docs/spec/dispatch-contract.md §6",
        "verbatim": null, "anchor": "派发契约规定了返回格式，没规定问题包存哪", "derived": true
      },
      "urgency": { "blocks": "now", "blocking": ["S1"], "deadline": null },
      "default_if_unanswered": {
        "kind": "proceed", "what": "用 A（tasks/runs 下，不发布）",
        "risk_of_default": 0, "reversible": "yes", "announced": true
      },
      "proposer": { "capability": "planner", "subtree": "S1", "at": "2026-11-11T09:10:00Z" },
      "answered": null
    }
  ],
  "overflow": [],
  "coverage": {
    "decisions_seen": 4,
    "decisions_asked": 1,
    "decided_by_guess": [
      { "subject": "json-vs-yaml", "assumed": "JSON", "risk": 1, "why_no_ask": "可逆且有先例：task-graph.json 就是 JSON", "reversible": "yes", "announced": true }
    ],
    "decisions_dropped": [
      { "subject": "字段命名风格", "why_dropped": "snake_case 已是全仓惯例，问它是噪声" }
    ],
    "no_open_questions_why": null,
    "basis": "读 CLAUDE.md / dispatch-contract.md / check-structure.mjs 后列出的 4 个待定点"
  },
  "deliveries": [],
  "on_timeout": "block",
  "state": "draft"
}
```

注意这个例子里 `coverage` 的算术：`4 = 1 + 1 + 2`，对得上。
另外注意推荐了 B，但默认动作是 A —— **默认动作可以不是推荐项**，条件是默认更安全（`risk_of_default < risk.level`）。

---

## 2. 三种触发时机

「什么时候问」可配置，但**不是任意配置**。合法的配置空间由本节闭合，超出即校验失败。

### 2.1 `QuestionPolicy`

```ts
interface QuestionPolicy {
  schema_version: 1;
  strategy: 'upfront' | 'gated' | 'deferred';
  gates: Gate[] | null;            // strategy === 'gated' 时必填且非空
  pack_cap: number;                // 默认 5
  max_packs_per_run: number;       // 默认 3
  defer_ceiling: 0 | 1 | 2;        // 仅 deferred 有效：允许延后的最高风险档
  on_timeout: 'block' | 'proceed_with_defaults' | 'abort_run';
  delivery_capacity: number | null; // null = 运行时探测（默认）
  allow_agent_proposals: boolean;  // 是否允许子 Agent 提问题
}

interface Gate {
  id: string;
  when: string;                    // 见 §2.5，必须是可求值的谓词
  admits: (0 | 1 | 2 | 3)[];       // 这一 gate 允许问的风险档
}
```

**加载顺序**：运行级 `tasks/runs/<run-id>/question-policy.json` > 项目级 `<repo>/question-policy.json` > 内置默认。
项目级可发布（不得含本机路径，`check-structure.mjs` 会拦）。

**解析失败 = 最严配置**，不是「用默认值继续跑」：

```
strategy: 'upfront'
on_timeout: 'block'
defer_ceiling: 0
pack_cap: 5
max_packs_per_run: 3
```

理由（与 `intent-contract.md` §2.2 同一取舍）：最危险的失败模式是「以为它是宽松的，其实是坏的」。
解析失败时**必须**在用户可见输出里写明「策略文件读不了，已按最严配置执行」。

### 2.2 `upfront` —— 开工前一次问完

| 项 | 规格 |
|---|---|
| **怎么配置** | `strategy: "upfront"`（默认） |
| **何时真正触发** | 在**第一个** `shape === 'artifact'` 的 subtree 派发之前。`validate-run.mjs` 的扩展检查拒绝放行一个 `needs_upfront_pack: true` 但 `pack.state !== 'answered'` 的拆解图 |
| **覆盖范围** | 只为**已知的**待决点提问。运行中才出现的 R2/R3 问题，转入 §2.6 的「中途升级」通道——**upfront 不等于之后不再问** |
| **失败怎么办** | 见 §2.8 |

`upfront` 的诚实声明：它只能问「派发前就能看见的」问题。声称 `upfront` 能一次问完所有事，
就是把「我没想到」包装成「没问题」。中途出现新问题属正常，走 §2.6。

### 2.3 `gated` —— 到某个 gate 才问

| 项 | 规格 |
|---|---|
| **怎么配置** | `strategy: "gated"` + `gates: [...]` |
| **何时真正触发** | 每次 `gate.when` 由 false 变 true 的那一刻（**边沿触发**，不是电平触发——否则每个 tick 都会重问一次）。gate 求值发生在轮内派发之前，与 `watch.mjs` 的 `runTick` 同一位置 |
| **覆盖范围** | 只问 `risk.level ∈ gate.admits` 的问题；超出的档位必须留给更晚的 gate，或立即升级 |
| **失败怎么办** | gate 谓词求值失败（读不到输入）→ **按 true 处理**（fail-closed：宁可多问一次，不可漏问），并在 pack 的 `coverage.basis` 里写明「谓词不可求值，按 true 处理」；交付失败见 §2.8 |

### 2.4 `deferred` —— 做完汇总，不打断

这是三种里唯一有安全风险的，所以约束最硬。

| 项 | 规格 |
|---|---|
| **怎么配置** | `strategy: "deferred"` + `defer_ceiling: 0\|1\|2`（**不允许 3**，校验器拒绝 `defer_ceiling: 3`） |
| **何时真正触发** | 全部 subtree 返回之后，或用户主动要求汇总时 |
| **什么可以延后** | 只有 `risk.effective <= defer_ceiling` 的问题 |
| **什么绝对不能延后** | `risk.effective === 3` 的**任何**问题。发现即**撤销延后**：立即中断正常流程，走 §2.6 升级 |
| **失败怎么办** | 中途出现高于 ceiling 的问题 → §2.6；交付失败 → §2.8 |

`defer_ceiling` 的语义是「我允许自己在达到这个风险之前先猜着做」。
默认 `0`（只允许猜无痕可逆的操作）。调高它是用户显式的风险偏好，不是系统默认。

### 2.5 `Gate.when` 的合法形态

只允许三种语法。**不接受自由文本谓词**——那等于把判定交给模型心情。

```
phase:<A..F>            该阶段开始时触发
before:<capability>     第一次执行某个 capability 之前触发
after:<subtree-id>      指定 subtree 返回后触发
```

组合用 `&`（全部成立）。例：`phase:B & before:push`。

为什么要限制语法：`state-model.md` §8 已经写过同一个教训——
「外观像遥测、实际由语言模型编出的数字，比没有更糟」。**可求值的判据才叫判据。**

### 2.6 中途升级（三种策略共用的逃生通道）

运行中出现 `risk.effective === 3` 的问题，且当前策略不允许在这个时点问：

```
1. 立即把包状态置 'superseded'（不是删除）
2. 生成新包（P-<run>-<n+1>），只装这一个/这一批升级问题
3. 受影响 subtree 置 BLOCKED，等答案
4. 若 on_timeout === 'abort_run' 或升级问题在 deadline 前未答 → 整个 run 停在当前进度，
   写一份「未完成报告」，列明卡在哪、还差什么答案
```

**`deferred` 策略下这条是常态，不是异常。** 一个声称「做完汇总」却在中途悄悄做了不可逆操作的 run，
按 §5.2 判 `SKIPPED_ASK` 缺陷。

### 2.7 非法组合（校验器直接拒绝）

| 组合 | 错误码 | 为什么非法 |
|---|---|---|
| `strategy: 'gated'` 且 `gates` 为空 | `POLICY_GATES` | 没有 gate 就没有触发点，等于永不问 |
| `defer_ceiling: 3` | `POLICY_CEILING` | 允许延后不可逆操作 = 允许猜不可逆操作 |
| `on_timeout: 'proceed_with_defaults'` 且包内含 R3 问题 | `POLICY_TIMEOUT` | R3 没有默认值（§1.2.7 不变量 1） |
| `defer_ceiling: 2` 且 `on_timeout: 'abort_run'` | `POLICY_CONTRADICTION` | 又不许延后又不许中止，配置自相矛盾 |
| `strategy: 'upfront'` 且 `max_packs_per_run > 1` | 警告，不阻塞 | 允许，因为 §2.6 会生成第二包 |

### 2.8 交付失败怎么办（三种策略共用）

「问了」的前提是「送得到」。交付失败分三种，处置不同：

| 失败 | 判据 | 处置 | 包状态 |
|---|---|---|---|
| **通道不可用** | `delivery.failure` 非空（如 `AskUserQuestion` 在 `dontAsk` 权限模式下被拒） | 降级到下一通道：`ask_user_question` → `markdown` → `cli`。每次降级都写一条 `Delivery` | `partially_answered` |
| **全部通道失败** | 所有 `Delivery` 的 `failure` 均非空 | **不许当作已问。** 按 `on_timeout` 处理，并在用户可见输出里逐字写出「问题没送到，原因：…」 | `expired` |
| **送到但未被确认** | `acknowledged_at === null` 且无失败 | 按 `urgency.blocks` 决定：`now` → 阻塞并重投一次；`later` → 留待下一轮 | `delivered` |

**「发了但没确认」不等于「问了」。** 这条与 `notify.mjs` 已有的一句注释同一立场：
Toast 只保证「提交给系统」，不保证「用户看到了」（`docs/spec/2026-11-04-notify-fix-acceptance.md` F9）。
问题包同理——**宿主接受了调用，不等于用户看见了问题**。

**降级到 `markdown` / `cli` 时的诚实标注**：这两种通道拿不到宿主的 `acknowledged_at`，
所以它们的 `Answer.evidence` 只能是用户后续在真人消息里的回复（§5.1 第 2 种形态），
`delivery.acknowledged_at` 在拿到那条消息之前**必须为 null**。

---

## 3. 风险分级

用户的原话是「按风险分级」，含义是「可逆操作猜、不可逆操作问」。
本节把这句话变成四个维度、四个档位、一张下限表。

### 3.1 四个维度

| 轴 | 取值 | 秩 | 判据（怎么机械判定） |
|---|---|---|---|
| **可逆性** `reversible` | `yes` | 0 | 一条命令即回到原状，且不需要重做工作 |
| | `costly` | 1 | 能回到原状，但要重做工作 / 重下依赖 / 重跑长任务 |
| | `no` | 2 | 回不到原状（已发出的消息、已删的数据、已推送的历史） |
| **影响面** `blast_radius` | `run` | 0 | 只影响本次运行的产物 |
| | `repo` | 1 | 影响工作区，未提交 |
| | `remote` | 2 | 影响远端 / 其他仓库 / CI / 共享分支 |
| | `external` | 3 | 影响仓库之外：已发出的对外消息、已花的钱、第三方系统 |
| **代价** `cost` | `seconds` | 0 | 撤销/重做在秒级 |
| | `minutes` | 1 | 分钟级 |
| | `hours` | 2 | 小时级 |
| | `permanent` | 3 | 不可挽回（含金钱、声誉、他人时间） |
| **可检出** `detectable` | `true` / `false` | 0 / +1 | 猜错了，事后能不能从 transcript / 磁盘状态看出来 |

**为什么要有「可检出」这一轴**：猜错但看得见，可以立刻改；猜错且看不见，会一直错下去。
后者比前者危险，但现有的可逆性 / 影响面 / 代价三轴都表达不了这件事。

### 3.2 四档与每档的处置

| 档 | 名字 | 典型动作 | 处置 |
|---|---|---|---|
| **R0** | 无痕 | Read / Grep / Glob / `git status` / 只读探针 | **不问。** 不登记，不声明 |
| **R1** | 可逆有痕 | 项目内 `Write` / `Edit` / 跑测试 / 派子 Agent | **可以猜。** 但假设必须写进 `coverage.decided_by_guess`，并在下一轮用户可见输出里声明 |
| **R2** | 有代价可逆 | `tidy`（移动/删除生成物）/ `local_commit` / `install_deps` / 改配置或 CI | **进问题包。** 未答时可按 `default_if_unanswered` 推进（默认值本身须 < R2），并记 waiver |
| **R3** | 不可逆 / 出仓库 | `push` / `release` / `deploy` / `delete_local` / 删用户数据 / 对外发送 | **必须答。** 无默认值，未答即阻塞 |

用户「按风险分级」的落点就是这张表：**R0/R1 猜，R2 问但可默认，R3 问且不可默认。**

### 3.3 分档怎么算（校验器重算，手填无效）

```
axes_level      = max(rank(reversible), rank(blast_radius), rank(cost))
undetectable    = detectable ? 0 : 1
capability_floor= CAPABILITY_FLOOR[option.capabilities] 的逐项最大值，见 §3.4
effective       = min(3, max(axes_level + undetectable, capability_floor))
level           = min(3, max(axes_level, capability_floor))
```

一个问题的 `risk.level` 取其**所有选项**中最大的那个（因为用户可能选任何一项）。

两条实测过的工作量权衡（引 `validate-run.mjs` 的教训：schema 不检查就会漂移）：

1. 校验器**必须重算** `level` 与 `effective`，与声明值不等即 `PACK_RISK_MISMATCH`。
2. `risk.reason` 必须指明是哪条轴 / 哪个 capability 顶上去的。写「综合评估」即 `PACK_VAGUE`。

### 3.4 受控词表与下限表

词表沿用 `intent-contract.md` §2.3 的 `capability` id——**不是为了复活那份被否决的方案**，
是因为「同一件事在全仓只有一个名字」这件事本身有价值：`relay-protocol.md` 的红线清单、
`verify-claims.mjs` 的命令正则、本文件的提问下限，三者指向同一组名字，才能互相校验。

| capability | 下限档 | 说明 |
|---|---|---|
| `read_only` | 0 | `git status/diff/log`、`ls`、`cat`、`grep`、`Read`、`Grep`、`Glob` |
| `doc_edit` | 1 | 项目内 `.md` 的 `Write` / `Edit` |
| `code_edit` | 1 | 项目内非 `.md` 的 `Write` / `Edit` |
| `test_run` | 1 | 只读测试 / 构建命令 |
| `agent_spawn` | 1 | 派子 Agent |
| `tidy` | 2 | 项目内移动 / 归档 / 建目录（含删生成物） |
| `local_commit` | 2 | `git add` / `git commit` |
| `install_deps` | 2 | `npm install` 等（会改 lockfile） |
| `config_edit` | 2 | 改 `settings.json` / CI 配置 / 启动项 |
| `delete_local` | **3** | 项目内 `rm` |
| `push` | **3** | `git push` |
| `release` | **3** | `git tag` / `gh release create` / 改版本号 |
| `deploy` | **3** | 部署脚本、发布到服务器 |
| `rewrite_history` | **禁** | `--force`、`filter-branch`、重写共享分支 |
| `credential` | **禁** | 读 `.env` / `~/.ssh`、导出 token、改 IAM |
| `outbound` | **禁** | 邮件、PR 评论、`npm publish`、对外消息 |
| `money` | **禁** | 任何支付 / 订阅 / 额度购买 |

「下限」的意思是：轴算出来的档位**不能低于**它。例如 `npm install` 的轴分可能是 R1
（`costly/repo/minutes`），但 `capability_floor = 2`，最终按 R2 处理。

### 3.5 绝对不能猜的四类（`hard_forbidden`）

`rewrite_history` / `credential` / `outbound` / `money`。

**它们不仅「必须问」，而且本协议拒绝承载它们的授权。** 具体表现：

- 一个选项的 `capabilities` 含上述任一 id → 校验器报 `PACK_FORBIDDEN`，包不能交付；
- 问题本身**可以**问，但选项只能是「我不做，你自己做」这一族 + 开放式入口。

```
合法： "要我把 release notes 写好给你，你自己发吗？"   options = [写/不写]，都不含 outbound
非法： "要我直接发 Release 吗？"                        options 含 outbound → PACK_FORBIDDEN
```

这条与 `relay-protocol.md` §3 的红线清单是同一条线：某些动作**不做**，不是**问一句就能做**。
把它做成「问一句就能做」，等于把安全边界降级成一个按钮。

### 3.6 举例：对「哪些操作绝对不能猜」的完整回答

| 操作 | 档 | 能不能猜 | 能不能经本协议授权 |
|---|---|---|---|
| 读文件 / grep | R0 | 能，且不必登记 | 不适用 |
| 改文档、改代码（工作区） | R1 | 能，须声明假设 | 不适用 |
| `npm install` | R2 | 未答可按默认，默认须声明 | 能 |
| `git commit`（本地） | R2 | 同上 | 能 |
| 删项目内生成物 | R2 | 同上 | 能 |
| `git push` | R3 | **不能** | 能（需逐次授权，不认一次性放行） |
| 打 tag / 发 Release | R3 | **不能** | 能（同上） |
| 部署到服务器 | R3 | **不能** | 能（同上） |
| 删用户数据 / `rm` 工作区 | R3 | **不能** | 能（同上） |
| 改 CI / 启动项 / settings | R2 | 未答可按默认 | 能 |
| 改共享分支历史 | 禁 | **不能** | **不能**（协议拒绝承载） |
| 读/导出凭据 | 禁 | **不能** | **不能** |
| 对外发消息 / PR 评论 | 禁 | **不能** | **不能** |
| 花钱 / 下单 | 禁 | **不能** | **不能** |

「R3 需逐次授权，不认一次性放行」这一条要紧：用户在第一个包里说「以后 push 不用问」，
**不构成**对后续每次 push 的授权——这与 README「跨会话消息永远不算你的同意」同源（§7.3）。

---

## 4. 问题合并（多 Agent 场景）

5 个手下各提 3 个问题 = 15 个。本节定义怎么压成 1 个包。

### 4.1 去重

**去重键**：`subject` + 排序后的 `capabilities` 集合。

```
sameKey(a, b) = a.subject === b.subject &&
                sort(a.options.flatMap(o => o.capabilities)).join(',') ===
                sort(b.options.flatMap(o => o.capabilities)).join(',')
```

同键合并规则：

| 项 | 合并方式 |
|---|---|
| `options` | 并集（按 `id` 去重；`id` 冲突时按 `option.evidence` 更多者为准） |
| `risk.level` | 取**最大**（保守方向） |
| `proposer` | 全部保留，变成 `proposers: Proposer[]` |
| `source` | 全部保留，主 source 取 `kind` 优先级最高的那个（§4.2 第 4 条） |
| `ask` 文本 | 取最短的一条；差异写进 `context` |

**不去重的情况**：同一个 `subject` 但 `options` 集合差异很大（交集 < 50%）——
那不是重复，是两个不同的决策被错误地用了同一个 subject。此时保留两条，并在报告里标
`subject_collision`，要求提议者改名。

### 4.2 排序（确定性，同输入同输出）

按以下键依次比较，先比出的胜：

```
1. urgency.blocks         now > later > never
2. risk.effective         3 > 2 > 1 > 0
3. 不可逆选项数量          reversible === 'no' 的选项越多的越靠前
4. source.kind 权威序     user-words > ambiguity > conflict > spec-gap > code > transcript > agent-proposal
5. id                     字典序（只为确定性，无业务含义）
```

**第 4 条的道理**：用户自己说过的 > 用户说过但有歧义的 > 两个来源打架的 > 规格没写的 >
代码里看出来的 > 历史记录里的 > 某个 Agent 想出来的。越靠前，用户回答的性价比越高。

### 4.3 冲突检测

两类冲突，都必须在**交付给用户之前**解决。

**（a）显式互斥**：`option.excludes` 声明。

```
Q1 推荐 A，而 A.excludes 含 "Q2:B"；Q2 推荐 B
→ PACK_CONFLICT：两条推荐互斥，用户无法同时选
```

处置（按顺序尝试，第一个可行的即采用）：

1. 合成一条更高层的问题（`kind: 'rank'`，让用户排序）；
2. 保留风险更高的那条，另一条进 `coverage.decisions_dropped` 并写理由；
3. 两条都保留，但把互斥选项从各自的 `options` 中删掉，并在 `context` 里说明为什么删。

**（b）隐式互斥**：同 `subject` 但推荐相反（见 §4.1 `subject_collision`）。
处置：一律合成一条，不保留两条——同一个主题问两遍，用户会认为这个系统没在思考。

**反例**：检测不到冲突就交付，让用户选出一个自相矛盾的组合，然后执行时才发现。
那比不问更糟：用户以为自己做了决定。

### 4.4 上限与溢出

| 参数 | 默认 | 依据 |
|---|---|---|
| `pack_cap`（一个包最多几个问题） | **5** | `output-format.md` §1 硬规则 5「列表不超过 5 条」，超出则分组。问题列表也受同一条约束 `[设计选择]` |
| `delivery_capacity`（一次交付最多几个） | 运行时探测 | 宿主通道容量随版本变化，**写死即过期** |
| `max_packs_per_run` | **3** | `[设计选择]`，无实测支撑 |

**溢出处理**（按顺序，前一步消化不掉才走下一步）：

```
1. risk.effective ≤ 1  → 移出包，进 coverage.decided_by_guess（必须写假设 + 声明）
2. risk.effective === 2 且 default_if_unanswered 合法 → 留在 overflow，标 disposition: 'guessed'
3. 其余 → disposition: 'next_pack'，生成 P-<run>-<n+1>
4. 超过 max_packs_per_run 仍有 R2/R3 问题 → 整个 run 停在规划阶段，
   输出一份「需求过宽」报告：按 §4.2 排序的全部问题 + 建议怎么拆
```

第 4 步是产品决策而不是技术限制：**一个需要问 20 个问题才能开工的需求，本身就该先拆需求，而不是先问 20 个问题。**
把这句话变成一条路径，比让系统默默问 20 个问题诚实。

**任何情况下都不许「因为太多所以不问了」。** 溢出必须有 `OverflowRecord`，且 §1.3.1 的算术不变量会拦住丢件。

### 4.5 多 Agent 的独立性

| 规则 | 校验点 |
|---|---|
| 提议者不得回答自己的问题 | `answer.by` 不得等于 `proposer.capability` → `PACK_PROPOSER_ANSWERED` |
| 子 Agent 只能**提议**，不能**交付**问题给用户 | 只有主线程能生成 `QuestionPack`；子 Agent 的产出是 `questions/proposed-<subtree>.jsonl` |
| 提议必须带 `source` | 没有 `source.verbatim` / `source.ref` 的提议直接丢弃，并计入 `coverage.decisions_dropped` |
| 合并者不知道谁提的（可选） | `allow_agent_proposals: true` 且需要防锚定时，合并前剥离 `proposer`，合并后回填——防止「这是执行 Agent 提的所以更可信」 |

最后一条的理由与 `dispatch-contract.md` §3 一致：**独立性靠不提供信息实现，不靠 prompt 里写「请保持独立」。**

---

## 5. 「必须问」的强制机制

用户说「必须问问题」。本节回答：怎么做到不可绕过。

**先说结论，再说办法**：

> 在纯配置库的约束下（ADR-0001），**运行时强制不可能**。
> 能做的是三件事：**(a) 事前结构门 (b) 交付可验证 (c) 事后审计**。
> 三者合起来把「跳过提问」从「没人会发现」变成「一次可复现的审计失败」。
> 这是提高伪造成本，不是消除。**这是已知的、被接受的缺陷**（与 `state-model.md` §2.2 同一立场）。

### 5.1 什么算「问了」

三级，只有第三级才算数：

| 级 | 判据 | 计不计入「已问」 |
|---|---|---|
| **declared** | `pack.state === 'draft'` 或 `'delivered'`，`deliveries` 为空 | **不算**。只写不交付 = 没问 |
| **delivered** | `deliveries[].acknowledged_at` 为 null，但有 `channel` 记录 | **不算**。标 `unverified` |
| **acknowledged** | 满足下列任一，且 `acknowledged_at` 非 null | **算** |

`acknowledged` 的两种可核实形态：

1. **工具通道**：transcript 里有 `AskUserQuestion` 的 `tool_use`，其 `input.questions[].question`
   与包内 `ask` 归一化后**逐条匹配**（去空白、去标点后相等），且有对应的 `tool_result`。
   判定可直接复用 `classify-stop.mjs` 的 `openWaitingToolUseIds()` 与 `parseAskAnswers()`。
2. **文本通道**：用户在真人消息里引用了 `pack_id`（如「P-xxx 里第 2 个选 B」），
   该消息 `origin.kind === 'human'`。判定复用 `asked.mjs` 的 `origin.kind` 口径。

**匹配必须逐条**。只匹配到一部分，就是 `partially_delivered`，未匹配的问题按「没问」处理。

### 5.2 什么算「该问但没问」（缺陷）

三个错误码，都可离线复现：

| 错误码 | 定义 | 检测方式 |
|---|---|---|
| `SKIPPED_ASK` | 一个 `risk.effective === 3` 的动作被执行，且在其**时间之前**没有任何 `acknowledged` 的、授权覆盖它的答案或有效 waiver | 见 §5.3 第 2 步 |
| `ZERO_ASK` | 一个 `shape === 'artifact'` 的 run 全程 `pack.questions.length === 0`，且 `coverage.no_open_questions_why` 为空 | 读 run 目录 + `coverage` |
| `UNAUTHORIZED_BRANCH` | 用户选了 A，但执行的是 B 的 `capabilities`，且 B 未被授权 | 比对 `answer.option_ids` 的 capabilities 与实际 tool_use |

`ZERO_ASK` 是「必须问」最主要的落点。它**允许**不问，但要求**证明为什么不必问**：
`no_open_questions_why` 必须逐条列出「本轮识别出的决策点 → 为什么每一条都不需要用户拍板」，
且条数必须等于 `coverage.decisions_seen`（为 0 时也要写「本轮无待决点，依据：…」）。

**一个空字符串报错的 `why`，比 5 个问题更能暴露「它没想」**。

### 5.3 怎么检测（可机械检验吗？能）

新增 `scripts/question-audit.mjs`（**本文不实现，只定义**）。它与 `verify-claims.mjs` 是**同一形状**：

```
verify-claims：  断言("测试通过")  → 找 supporting tool_use → 按时间线判四档
question-audit： 动作(push)        → 找 authorizing Answer  → 按时间线判三档
```

一个查「说了没做」，一个查「做了没被允许」。共用 `verify-claims.mjs` 已有的能力分类正则
（`isMutatingCommand` / `PUSH_CMD_RE` / `COMMIT_CMD_RE` / `BASH_MUTATION_RE`），不另起一套词表。

判定流程（全部只读、确定性、无模型）：

```
1. 列出 run 目录下全部 pack-*.json，加载全部 Answer
2. 从 transcript 抽出全部 tool_use，用既有正则归入 capability id
   只保留 capability_floor >= 2 的那些（R0/R1 不需要授权）
3. 对每个这样的动作 a，找 authorizing answer：
     answer.at < a.at
     且 a 的 capability ∈ answer.authorization.granted
     且 answer.authorization.expires_at 为 null 或 > a.at
     且 (answer.authorization.scope 覆盖 a 的目标路径/分支)
   找到 → OK
   找不到，但存在 coverage.decided_by_guess 里 subject 匹配且 announced 的条目 → WAIVED
   都找不到 → SKIPPED_ASK（出缺陷）
4. 判定三档：AUTHORIZED / WAIVED / UNAUTHORIZED
   退出码：0 = 全部 AUTHORIZED 或 WAIVED；1 = 存在 UNAUTHORIZED；2 = 读不全
```

**`UNKNOWN` 的处理沿用 `verify-claims.mjs` 的纪律**：transcript 截断导致读不全时判 `UNKNOWN`，
**不算缺陷**——「没读到」不等于「没有」。这是本仓库已经立过的一条规矩，不许在这里退回去。

### 5.4 强制机制的三个柱子（以及它们各自能挡什么）

| 柱子 | 实施方式 | 挡的是什么 | 挡不住什么 |
|---|---|---|---|
| **事前结构门** | `validate-run.mjs` 扩展：`needs_upfront_pack` 的拆解图，`pack.state !== 'answered'` 直接拒绝派发 | 「计划里根本没打算问」 | 执行中绕过计划的动作 |
| **交付可验证** | §5.1 三级判据；`deferred` 策略下 pack 必须 `delivered` 才能宣称「在做」 | 「写了包没发出去」 | 用户扫了一眼没答，系统当作答了 |
| **事后审计** | §5.3 的 AUTHORIZED / WAIVED / UNAUTHORIZED | 「不该做的做了」 | 审计器读不到的部分（transcript 截断、动作在别的会话里做） |

**三个柱子都挡不住的**：子 Agent 在自己的 Bash 里做了一件事，而它的 transcript 没被主线程读到。
这是 ADR-0001 §1「没有强制力」的直接后果，本文件不假装解决它。

### 5.5 waiver 的合法性

「waiver」= 用户或策略明确允许「这个问题不问」。合法形态只有两种：

1. **用户直接说**：`answer.kind === 'waived'`，`raw` 里是用户原话。
2. **策略默认**：`coverage.decided_by_guess` 里的一条，且 `risk ≤ 2`，且 `announced === true`。

**不合法的 waiver**：
- 「上次用户说过类似的」——跨实例的放行不成立（§3.6 末条）；
- 「这个操作可逆」——可逆性不是豁免理由，它只决定档位；
- 「问了用户会烦」——用户烦不烦由用户决定，不由系统替用户决定。

第三条是这条协议存在的理由。**系统能优化的是「问得准」，不是「问得少」。**

### 5.6 噪声检测：只提示，不判定

「必须问」的副作用是可能问太多。所以要有一个反向指标，但它**不能变成一道拦截门**——
一旦「问得重复」可以阻止提问，系统就有动机把问题判成重复。

| 代号 | 定义 | 判据 | 处置 |
|---|---|---|---|
| `REDUNDANT_ASK` | 本包的问题与**本 run 内**已答问题高度重合 | `ask` 文本归一化后的字符二元组重合系数 ≥ 0.6（复用 `classify-stop.mjs` 的 `relevanceOf`） | 只写进 `ledger.json` 的 `warnings`，不阻塞交付 |
| `USER_BURDEN` | `pack.questions.length > 3` | 计数 | 渲染时额外显示「这次问得有点多，可以直接说‘先做 A’」 |

`REDUNDANT_ASK` **不跨 run 判定**。上一轮问过、这一轮又问，可能是合理的（情况变了）。
跨 run 的「问过又问」不构成噪声证据。

---

## 6. 与现有资产的对接

### 6.1 证据分级：答案为「需求轴」加一级 E0

`continuation-engine.md` §3.2 的 E1–E5 判的是「**任务做完了没有**」。问题协议判的是「**用户要什么**」。
两者是正交的两条轴，不能混用——`2026-11-02-autorelay-acceptance.md` §3 已经立过同一条规矩
（「这套分级与 E1–E5 不是一套东西……混用两套分级视为判定错误」）。

本文件新增一级，只用于需求轴：

| 级 | 证据 | 从哪来 | 能证明什么 | 不能证明什么 |
|---|---|---|---|---|
| **E0** | 人类原始断言（宿主记录的真人输入） | transcript 里 `origin.kind === 'human'` 的 `user` 记录；`AskUserQuestion` 的 `tool_result` | 用户**说过这句话** | 用户**同意了什么**；事情做对了没有 |

三条使用规则：

1. **E0 在「做完了没有」这条轴上无效。** 用户说「做完了」不构成 `MET`，与 `E4` 同级处理。
   `MET` 仍需 E1/E2/E3。
2. **E0 是需求轴的最高级。** 任何需求条目，若无法追到一条 E0（或一条 E5 宿主 intent），
   必须标 `inferred`。`inferred` 的需求不得被用来判 `UNMET`——这正是
   `continuation-engine.md` §3.3 规则 2「不猜测用户的验收标准」。
3. **E0 的降级是 E0-null，不是 E4。** 有记录但读不全 → `E0-null`（不知道），不等于 AI 自述。

### 6.2 用户选的选项能不能当「用户授权」的证据

**有条件能。** 三个条件同时成立才构成授权：

| # | 条件 | 机械判据 | 不满足时 |
|---|---|---|---|
| 1 | 问题**显式**列出了这个 capability 及其后果 | 该选项的 `capabilities` 含该 capability，且 `consequence` 非空非模糊 | 只是「用户说了句话」，不授权 |
| 2 | 用户选的是**那个选项** | `answer.kind === 'option'` 且 `option_ids` 含该 option | 开放式回答**不自动**等于选了推荐项 |
| 3 | 答案是**肯定极性** | 复用 `classify-stop.mjs` 的 `answerIsNegative()`：命中 `RETRACTION_RE` 即不授权 | 否定答案授权为空 |

条件 3 是有实测支撑的：`classify-stop.mjs` 的注释记着实测样本
`"要现在推到 GitHub 吗？"="先不推"`——把「有回复」当「同意」是本仓库已经踩过的坑。

`Authorization` 的形状：

```ts
interface Authorization {
  granted: string[];         // capability id
  scope: string;             // "branch:!main" / "path:docs/**" / "*"
  expires_at: string | null; // 默认 null = 只对本次动作有效
  conditions: string[];      // 用户在答案里附加的条件，逐字
}
```

**`expires_at` 默认 null 的含义：一次授权只对一次动作有效。**
「以后 push 都别问我」这类一次性放行，必须由用户显式填 `expires_at` 或 `scope`，
且**不得**自动推断——推断出来的放行不叫放行。

### 6.3 与 `verify-claims.mjs` 的关系

| 维度 | `verify-claims.mjs` | `question-audit.mjs`（待建） |
|---|---|---|
| 输入 | 最后一条 assistant 文本 | run 目录 + transcript |
| 断言 | 「测试通过 / 已提交 / 已推送」 | 「用户授权了 push」 |
| 找什么 | supporting `tool_use` / `tool_result` | `acknowledged` 的 `Answer` |
| 时间线 | 以「最后一次源码编辑」为界 | 以「答案时刻」为界 |
| 判定 | SUPPORTED / STALE_ONLY / FAILED_ONLY / NO_EVIDENCE / UNKNOWN | AUTHORIZED / WAIVED / UNAUTHORIZED / UNKNOWN |
| 读不全 | `UNKNOWN`，不算失败 | 同 |
| 精度 | 84.6%（抽检 13 条） | 未测 |

两者共享同一条纪律：**「没找到证据」≠「没发生」**。这条已经在 `verify-claims.mjs` 里写死
（触到回溯上限即判 `UNKNOWN`），`question-audit.mjs` 必须照抄。

### 6.4 与 README「跨会话消息永远不算你的同意」的协调

README 那条讲的是**来源通道**：来自另一个会话的消息，不是用户打的字，所以不能当同意。
本协议不与之冲突，因为判据是同一条——**看这条记录是谁写的，不看它的内容像不像同意**。

由此推出三条硬规则：

1. **`Answer` 的 `by` 必须是 `'human'`。** peer message（`origin.kind === 'peer'` 或含
   `<cross-session-message>`）**永远**不是 E0，无论内容多像「好的，推吧」。
2. **Overwatch 自己投递的东西永远不能成为问题包的来源。** `relay` 产出的草稿不得进入
   `pack.questions`，也不得被当作 `delivery.channel`。理由：一旦允许，系统就能自己问、
   自己投、自己把投递结果当选中——这就是伪造同意。
3. **「用户转发了 AI 的草稿」也不行**：草稿被用户复制粘贴进目标会话后产生的那条
   `user` 记录，`origin.kind` 是 `human`（是用户按的回车），但内容来自 AI。
   这类记录的授权效力 = **仅限「用户执行了这一步」**，不等于「用户同意草稿里写的每个动作」。
   判据：`Answer.raw` 若与本 run 产出的任一 relay 草稿逐字重合度 > 0.8，标
   `origin: 'relayed'`，`authorization.granted` 清空，只保留「用户点了发送」这一事实。

第 3 条是这一节最容易漏、后果最严重的一条。**「用户按了回车」和「用户同意」之间隔着一次阅读。**

### 6.5 跨会话消息的合法用途

它可以当问题的**来源**，不能当**答案**：

```
合法： 收件箱里有 "<cross-session-message> 目标会话在问：要我把旧三个删掉腾空间吗？"
       → 转成一条 Question 问用户，source.kind = 'transcript'，source.ref = 该消息 uuid
非法： 把 `suggestedReply` 直接当作 Answer 填进 answers.jsonl
```

两者在数据上完全可区分：前者是 `Question`，后者是 `Answer`。校验器只接受 `by: 'human'` 的 `Answer`。

---

## 7. 输出格式

### 7.1 唯一真源是 JSON，散文是渲染结果

这条针对的是本仓已经存在的具体问题：**12 个角色定义，「## 输出」下的标题没有一个重复。**
再加一个「提问 agent」就会变成第 13 种模板。所以：

> **问题不是一种输出模板，是一种数据。** 任何角色都不在返回里内联问题文本，
> 只引用 `question_id`。

三条规则：

1. `QuestionPack` / `Answer` / `QuestionPolicy` 的**唯一真源是 JSON 文件**，见 §7.2 的路径约定。
2. Markdown / TUI 视图由 `renderPack()` **渲染**生成。渲染器不允许产生 JSON 里没有的信息。
3. **手写的问题包视为不合格**：`schema_version` 缺失、或 `deliveries` 与 `acknowledged_at`
   在没有任何工具调用痕迹的情况下被填写 → `PACK_HANDWRITTEN`。

### 7.2 文件路径约定

```
question-policy.json                              项目级策略（可发布，无本机路径）
tasks/runs/<run-id>/question-policy.json          运行级策略覆盖（不发布）
tasks/runs/<run-id>/questions/pack-<n>.json       问题包（唯一真源）
tasks/runs/<run-id>/questions/answers.jsonl       答案，一行一条，只追加不改写
tasks/runs/<run-id>/questions/proposed-<subtree>.jsonl   子 Agent 的提议（合并前）
tasks/runs/<run-id>/questions/ledger.json         审计结论（question-audit 产出）
```

`answers.jsonl` **只追加**。撤销一条答案不是删行，是追加一条 `kind: 'superseded'` 并让新条
`supersedes: "<原 answer 的 at>"`。理由与 `intent-contract.md` §2.1「只加行、不删行」同源：
历史不可丢，否则无法回答「用户当时到底说了什么」。

### 7.3 用户可见的渲染格式

一个包渲染出来必须是这个形状（`output-format.md` 的七条硬规则全部适用）：

```
3 个问题需要你拍板（P-run-2026-11-11-a-1 · 开工前一次问完）

1/3 新的问题包 JSON 存哪里？
    为什么问：tasks/runs/ 已被 .gitignore 排除，存这里不进版本库。

    A  tasks/runs/<id>/questions/
       后果：不发布，含会话 ID；check-structure 已保证该目录被忽略
       可逆：能，删目录即撤销

    B  docs/spec/questions/                      ← 推荐
       后果：会进版本库，问题文本可能含项目内细节，需人工脱敏
       可逆：代价中等，git revert 可以，但已推送的提交要改写历史

    推荐 B，因为问题包是产物的一部分，应当可审查；A 目录 clone 后不存在，别人看不到。
    什么情况下不推荐：若问题文本里出现会话 ID 或本机路径，则 B 不成立。

    都不对？直接说你想存哪。

    不回答会怎样：用 A（tasks/runs 下，不发布）——这个默认不会碰发布区。
```

六段必须齐：**编号 / 问题 / 为什么问 / 选项（标签 + 后果 + 可逆性）/ 推荐（含作废条件）/ 不回答会怎样**。
缺任一即 `PACK_RENDER_INCOMPLETE`。

为什么「怎么作废」要给用户看：用户是唯一能提供「你不知道的事实」的人。
只给推荐不给反驳条件，等于要求用户要么服从要么从头想。

### 7.4 渲染宽度

沿用 `tui-layout.mjs` 的 `truncateToWidth` / `wrapToWidth`，**不自己写换行**。
理由：全仓已经因为宽度表出过一次真实缺陷（`docs/spec/tui-visual.md` 的宽度修复），
问题包的渲染没有理由重踩。

`label` ≤ 20 全角 / 40 半角；`consequence` ≤ 60 全角 / 120 半角，超出走 `wrapToWidth`。
截断必须带省略标记并保留完整文本在 JSON 里——**显示可以截，数据不许截**。

---

## 8. 怎么被测试

每条规格都要能对应一个会变红的测试。下表规定 **fixture + 断言 + 负向变异**。
实现时放 `scripts/question-protocol.test.mjs` + `scripts/validate-questions.mjs` 的测试。

### 8.1 校验器错误码（`validate-questions.mjs`，待建）

| 错误码 | 触发条件 | 负向变异（把正确 fixture 改成错的） |
|---|---|---|
| `PACK_SCHEMA` | 字段缺失 / 类型错 / 未知 `kind` | 删掉 `coverage` |
| `PACK_VAGUE` | `consequence` 或 `risk.reason` 命中模糊词表 | 把 `consequence` 改成「视情况而定」 |
| `PACK_RISK_MISMATCH` | 声明 `level`/`effective` ≠ 重算值 | 把 `deploy` 选项的 `level` 改成 1 |
| `PACK_RISK_DEFAULT` | `level === 3` 却有默认值，或 `risk_of_default >= level` | 给 push 问题加 `default_if_unanswered` |
| `PACK_FORBIDDEN` | 选项的 `capabilities` 含四个禁项之一 | 加一个 `outbound` 选项 |
| `PACK_CONFLICT` | `excludes` 与推荐矛盾 | 让 Q1 推荐项 exclude 掉 Q2 的推荐项 |
| `PACK_ARITHMETIC` | `coverage` 三项加和 ≠ `decisions_seen` | 把 `decisions_seen` 加 1 |
| `PACK_CAP` | `questions.length > pack_cap` | 塞第 6 个问题 |
| `PACK_NO_WHY` | 0 个问题且 `no_open_questions_why` 为空 | 清空该字段 |
| `PACK_PROPOSER_ANSWERED` | `answer.by === proposer.capability` | 让 planner 提、planner 答 |
| `PACK_HANDWRITTEN` | 无 `schema_version` / 交付记录无痕迹 | 手写一份 markdown 冒充 |
| `POLICY_GATES` / `POLICY_CEILING` / `POLICY_TIMEOUT` / `POLICY_CONTRADICTION` | §2.7 的非法组合 | 各造一份非法 policy |
| `PACK_RENDER_INCOMPLETE` | 渲染结果缺六段之一 | 从渲染器里删掉「不回答会怎样」 |

### 8.2 规格条目 → 测试用例

| 规格 | 测试 | 断言 |
|---|---|---|
| §1.2.1 选项必须带后果 | 构造 `consequence: ''` 的选项 | `PACK_SCHEMA` |
| §1.2.2 推荐必须带反驳条件 | `falsifier: ''` | `PACK_SCHEMA` |
| §1.2.3 开放式入口恒存在 | 删 `open_entry` | `PACK_SCHEMA` |
| §1.2.7 默认动作严格低于问题档 | `level: 2` + `risk_of_default: 2` | `PACK_RISK_DEFAULT` |
| §3.3 分档可重算 | 同一组轴值算两次 | 结果相同；改任一轴，`effective` 按表变化 |
| §3.4 下限表生效 | `install_deps`，轴算 R1 | `effective === 2` |
| §3.5 禁项不可承载 | `push` 问题合法，`outbound` 问题非法 | 前者通过，后者 `PACK_FORBIDDEN` |
| §4.1 去重键 | 两条同 subject 同 capability 的问题 | 合并为 1 条，`options` 为并集 |
| §4.2 排序确定性 | 打乱输入顺序跑 5 次 | 输出顺序恒等 |
| §4.3 冲突检测 | 构造互斥推荐 | `PACK_CONFLICT` |
| §4.4 溢出必登记 | 8 个 R2 问题、`pack_cap: 5` | 包内 5 条 + `overflow` 3 条 + 算术成立 |
| §5.1 三级「已问」 | `delivered` 但 `acknowledged_at: null` | 不计入已问 |
| §5.3 审计判定 | 造一份 transcript：push 在 answer 之前发生 | `UNAUTHORIZED`，退出码 1 |
| §5.3 读不全 | transcript 被截断 | `UNKNOWN`，退出码 2，**不算缺陷** |
| §6.2 授权三条件 | 开放式回答被解释成同意 | 授权为空 |
| §6.2 否定答案 | 答案含「先不推」 | 复用 `answerIsNegative` 判 true，授权为空 |
| §6.4 中转草稿 | `Answer.raw` 与 relay 草稿重合度 > 0.8 | `origin: 'relayed'`，`granted` 为空 |
| §7.3 渲染六段 | 渲染任一包 | 六段标题全部出现 |
| §7.4 宽度 | 长中文 `consequence` | 不超宽，JSON 里原文完整 |

### 8.3 负向测试的强制

本仓库已有 `verify-bugfix-negatives.mjs` / `verify-tui-negatives.mjs` 的做法：**把 bug 装回去，测试必须变红**。
提问协议同样适用：上表每一行的「负向变异」都必须真的让测试变红一次，否则那条测试只是装饰。

---

## 9. 已知局限与未解决

| # | 局限 | 为什么现在不解决 |
|---|---|---|
| L1 | **没有运行时强制。** 子 Agent 可以绕过问题包直接执行 | ADR-0001 §1 已裁决：纯配置库没有强制力。三个柱子只提高成本 |
| L2 | **「问得对不对」无法机械检验** | 只能靠返工率事后统计。本文只保证「问了 / 形状合规 / 答案被记下」 |
| L3 | **`pack_cap = 5` / `max_packs_per_run = 3` 是设计选择，不是实测** | 没有真实使用数据。首次实测后应按「用户实际答完率」重估 |
| L4 | **`delivery_capacity` 必须运行时探测** | 宿主通道容量随版本变化。写死即过期，而写死一个过期数字比不写更坏 |
| L5 | **「问题是噪声」的检测只有启发式** | §5.6 的 `REDUNDANT_ASK` 靠字符重合度，精度未测。当前只做提示，不做判定 |
| L6 | **多 Agent 提议阶段的 `subject` 归一化靠人** | 两个 Agent 可能用 `branch-strategy` 和 `branching` 指同一件事。当前只报 `subject_collision`，不自动合并 |
| L7 | **`E0` 与 `E5` 的优先级未在真实语料上验证** | 宿主 `intent` 覆盖率实测 89%（`continuation-engine.md` §3.2），但「用户原话 vs 宿主转录」哪个更可信，没有对照实验 |
| L8 | **`deferred` 策略的安全性依赖「中途升级」被真的触发** | 升级逻辑本身如果被跳过，`deferred` 就退化成「先干了再问」。这需要 §5.3 的审计真的跑起来才有意义 |

**最该先测的三件事**（按性价比排序）：

1. `question-audit.mjs` 在历史语料上的假阳性率——没有它，§5 全部是纸面纪律。
2. 用户实际答完率随问题数的变化——决定 `pack_cap` 该是 5 还是 3。
3. `REDUNDANT_ASK` 的重合度阈值——现在借的是 `classify-stop.mjs` 的 0.20/0.30 经验值，**未在本场景标定**。

---

## 10. 一页速查

```
问题 = id + subject + ask + context + kind
      + options[]  （每个带 consequence / capabilities / reversible / blast_radius / undo / detectable / excludes）
      + recommended （带 why + falsifier + based_on）
      + open_entry （恒存在）
      + risk （level/effective 由轴重算，禁项标 hard_forbidden）
      + source （kind + ref [+ verbatim]，说不出出处的问题作废）
      + urgency （now/later/never + blocking）
      + default_if_unanswered （R3 必须 null；默认档必须 < 问题档）
      + proposer

包 = ≤5 个问题 + overflow（不许丢）+ coverage（算术必须配平）+ deliveries + on_timeout
策略 = upfront | gated | deferred（defer_ceiling ≤ 2）
风险 = R0 猜不问 / R1 猜并声明 / R2 问但可默认 / R3 问且必须答 / 禁项不可授权
强制 = 事前结构门 + 交付可验证 + 事后审计（不是运行时拦截）
证据 = 答案是 E0（需求轴最高级），不构成 E1/E2/E3（完成轴无效）
```

**如果你只从这份文件里记住一句话**：

> 判断「问了没有」不看有没有写问题，看**有没有一条被宿主记录的用户输入，能对上那条问题的原文**。
> 其余的（包、策略、分级）都是为了让这句话可核实。
