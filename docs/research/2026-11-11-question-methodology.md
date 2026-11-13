# 怎么问才准：提问方法论的研究现状

> 日期：2026-11-11
> 角色：研究 Agent Q1 · 产出形态：**exploration**（方法论调研，不是实施计划）
> 命题来源：[`docs/design/2026-11-11-question-protocol-thesis.md`](../design/2026-11-11-question-protocol-thesis.md)
> **未修改 Overwatch 任何代码，未碰 git，未跑全量测试。**

---

## 覆盖声明

### 实际读到一手全文的

| 来源 | 读了什么 | 取用方式 |
|---|---|---|
| **HumanEvalComm**（arXiv:2406.00215v3） | arxiv.org/html 全文，约 148k 字符。读了 §2.1 缺陷分类与构造准则、§2.2 指标定义、§3.4 Okanagan 三轮结构、§4.2 结果、§5.3 prompt 敏感性、Table 3/4 | 逐段读过 |
| **ClarifyCodeBench**（arXiv:2607.00711v2） | 全文，约 64k 字符。读了 §3.1 交互协议、§3.2 歧义标注流程、**Table 2 十类歧义 taxonomy**、§3.3 TKQR/ORA 公式、§5 Table 4 实际轮数 | 逐段读过 |
| **CONTRA**（arXiv:2610.01769v1） | 全文，约 49k 字符。读了 §3 三阶段方法（发现/资格判定/自适应选择）、Table 1/2、§4.3–4.5 消融、§5.2 与 Claude Code / OpenHands 的对照（含 FPR） | 逐段读过 |
| **ReqClarifyBench**（arXiv:2610.13022v1） | 全文，约 83k 字符。读了 §4.2 三种用户 persona 的来源（SWE-chat）、§4.3 EQR/AvgClarified/ReqAlign 定义、§5.1–5.2 停止轮数分析 | 逐段读过 |
| **Ask or Assume?**（arXiv:2603.26233v3） | 全文，约 72k 字符。读了 UA-Single / UA-Multi 结构、69.40% resolve rate 的对照、每任务平均提问数（3.06 / 8.71） | 逐段读过 |
| **Is That Clear?**（arXiv:2611.01087v1） | 全文，约 90k 字符。读了 N=180 的 2×3 设计、复查时长、未修改接受率、CQ-adjacent 违规的接受差异 | 逐段读过 |
| **Knowing but Not Showing**（arXiv:2605.25284v1） | 全文，约 46k 字符。读了三种设置（QA / 歧义判断 / 行为分类）与"检索上下文反而降低提问率"的结论 | 逐段读过 |
| **An Empirical Study of Clarifying Question-Based Systems**（arXiv:2008.00279v1） | 全文，约 29k 字符。读了 RQ1 的实际答题数分布、停止原因、答案正确性 | 逐段读过 |
| **AskBench**（arXiv:2602.11199v2） | 全文。读了 rubric 化奖励、3 轮固定预算、Hard 两轮协议 | 节选 |
| **Pinning Decisions Before Failure**（arXiv:2610.03237） | 摘要全文（HTML 版只拿到 landing page）。42.7% / 92.5% / 85–90% / 96–97% 等数字全部来自摘要原文 | 摘要全文 |
| **QuestBench**（arXiv:2503.22674）、**STaR-GATE**（2403.19154）、**Modeling Future Conversation Turns**（2410.13788）、**Can LLMs Ask Good Questions?**（2501.03491）、**Disambiguation Survey**（2505.12543）、**CLAM**（2212.07769）、**iSNEAK**（2310.19125）、**Learning to Clarify**（2406.00222） | arXiv 元数据 API 取的摘要全文 | 摘要 |
| **INVEST**（Bill Wake，xp123，2003-08-17） | 原页面正文全文，逐条读了 Independent / Negotiable / Valuable / Estimable / Small / Testable | 原文 |
| **Essential XP: Card, Conversation, Confirmation**（Ron Jeffries，2001） | 原页面正文 | 原文 |
| **Kiro 官方文档**（kiro.dev/docs/specs、/feature-specs） | 读了 requirements.md 的 EARS 写法（`WHEN [condition/event] THE SYSTEM SHALL [expected behavior]`）与三阶段流程 | 原文 |
| **Wikipedia**：Requirements elicitation、User story、Socratic questioning、Scrum（DoR 锚点）、Expected value of perfect information | `action=raw` 取全文 | 原文 |
| **Claude Code 2.1.308 二进制**（本机安装，直接扫描 `claude.exe` 字符串） | AskUserQuestion 的 schema 与 steering 文本：`questions.min(1).max(4)`、`options.min(2).max(4)`、`header` 上限 12 字符、自动提供 `Other`、单一选项的拒绝提示、`kind: text/number` 扩展字段 | 一手，非文档 |

### 尝试过但失败的

- **Carrizo/Dieste/Juristo《Systematic Review and Aggregation of Empirical Studies on Elicitation Techniques》**（IEEE TSE 2010，DOI 10.1109/TSE.2010.33）：Semantic Scholar 返回元数据但**摘要被出版社 elide 掉**，全文封闭。**我没有读到它的结论**，因此本文不引用它的任何具体发现——只在 §2.0 提它存在。
- **ISO/IEC/IEEE 29148** 正文：requirements.com 的页面是通用营销文章，不含特征表。**特征清单来自二手转述一致的多处引用，未见标准原文**，本文按"未核实"处理。
- **Definition of Ready 的原始出处**：xp123 的 `ready-ready` 系列 URL 全部 404；PMI 页面 403；scrum.org 403；Fowler bliki 404。**"Bill Wake 2008 提出 DoR"这个说法我没能核实**，本文只按"概念在敏捷社区广泛使用"处理。
- **《The Mom Test》原文**：所有搜索均返回无关结果，**没读到**，因此不引用。
- **Krosnick 的 satisficing / "don't know" 选项文献**：搜索无结果，**没读到**。
- **Socratic 六类问句的原始出处**（Paul & Binker 1990 的 *The Thinker's Guide to the Art of Socratic Questioning*）：archive.org PDF 超时未下到。只用 Wikipedia 的转述版本。
- **INCOSE Guide to Writing Requirements**：PDF 403。
- **"多 Agent / 工业界多问导致失败"的第一手复盘**：HN Algolia 两组查询、WebSearch 多组查询均无匹配。见 §5.6。

### 方法学限制（先说）

- **arXiv API 必须走 `https://`**：`http://export.arxiv.org` 返回 301 且 0 字节，静默失败过一次。凡本文说"查不到"，都是 https 下重跑过的。
- arXiv 的 `search_query` 对未加引号的短语极不可靠（`all:unnecessary+clarifying+questions` 返回 0 条，而 `all:"unnecessary questions"` 返回 9 条）。本文的"没有相关论文"结论只在**加引号短语 + ti: 前缀**两种查法都为空时才下。
- 2026 年这批论文（2607 / 2610 / 2611 等）都是本机时间线上的近期预印本，**我没有独立复现它们的实验**。所有数字是"论文自报"，不是"我验过的"。
- **没有做任何实验**：没跑过 ClarifyCodeBench，没装 CONTRA 的 Claude Code 插件，没搭 Okanagan。所有"能/不能"的判断来自论文文本与 schema 语义。

---

## 一、结论先行

**1. 三十年需求工程给的是一套"缺陷分类学 + 填写模板"，不是一套"提问流程"；能直接抄的正是前者。**
最硬的证据是 HumanEvalComm 直接把 RE 领域的 **inconsistency / ambiguity / incompleteness** 三分搬进代码生成评测，并对 164 道 HumanEval 题逐题人工构造三种缺陷（两位有 10 年 / 15 年经验的工程师，构造 100 小时 + 复核讨论 30 小时）。ClarifyCodeBench 进一步把它细分成 **10 类**并给每类配了示例问句。这两份 taxonomy 合起来就是"问题从哪来"的现成清单，不需要我们自创。见 §2.1、§2.2。

**2. "问几个合适"有实测数字，但那个数字不能直接搬——它测的是"零思考成本的选项题"。**
唯一一个真人在线实验（arXiv:2008.00279，商品推荐场景）给出：用户实际平均答 **11.4** 个问题、中位数 **7**、**70.3%** 的人答 4–12 个；退出问卷里 50% 自称愿答 6–10 个。但同一实验里 **12–17% 的答案是错的（与目标商品描述相反）**，且"答案不完美"条件下 **34% 的人因疲劳停止**、**22% 因问题不相关停止**。代码任务的每题思考成本高一个量级，**11.4 不能照抄**。见 §3。

**3. "问对了"有可机械检验的判据，但只到"局部可判定"，到不了"全局完备"。**
可机械化的有三类，可靠性依次递减：
- **(a) 执行判据（最强，无需标注）**：CONTRA 的做法——对每个候选问题，用两个"只在这一问上不同"的答案各生成一份程序，找一个输入让两份程序**行为不同**；不同才留下。Pinning Decisions 把它推进一步，直接产出"decision pin"（点名 + 可区分输入 + 人选的值），703 份独立实现上与基准分类 **96–97%** 一致。**这是本文认为最该抄的一条。**
- **(b) 命中判据（需要 gold question 标注）**：precision / recall / F1 / TKQR / ORA / EQR。这些只在有"标准问题集"时可用，而标准问题集本身要靠人工构造。
- **(c) 滞后判据**：返工率、首次通过率、Pass@1 落差。**返工率不是唯一指标，但它是最诚实的一个**——因为它不依赖任何标注，只需要"同一需求做几遍"的记录。

**全局"需求问全了没有"没有可机械检验的判据。** 这不是"还没人做"，是问题本身的性质：完备性是相对于"用户真实意图"的，而意图不在题面里，也不在任何可执行产物里。HumanEvalComm / ClarifyCodeBench 都是**先人工删掉信息、再把"删掉的那条"当标准答案**——这是构造出来的可判定性，不是自然场景里能拿到的。**如实说：拿不到。**

**4. 最强的反面证据有两条，而且方向相反，两条都必须进设计约束。**
- **多问了会变差**：HumanEvalComm 的 Okanagan 在**本来不需要问**的原始 HumanEval 上，Pass@1 从 ChatGPT 单轮的 **65.58% 掉到 27.45%**。论文自己把这条写成 limitation："tends to still ask questions that appear to be unnecessary"。这就是"问题本身成为失败点"的直接实测。
- **问过之后人会更不设防**：2026 年的 N=180 对照实验（arXiv:2611.01087）发现，回答过 2 个澄清问题的被试**复查时间更短**、**未修改直接接受的比例从 46% 升到 60%**，而且**对"问题问到的那部分"里的违规更容易放过**（CQ-adjacent 违规比 nonadjacent 更常被接受）。也就是说：**提问会制造"我已经对齐过了"的错觉，反而降低用户对后续产出的审查强度。**

这两条合起来的意思是：**"必须问"这条硬约束是对的，但"必须问"不能等于"尽量多问"，也不能等于"问完就算对齐了"。**

**5. "用户答不上来"没有成熟做法，但有可用的分层，而且成本很低。**
ReqClarifyBench 用 SWE-chat 里三种真实用户类型建模（Expert Nitpicker 精确详尽 / Vague Requester 只说大概 / Mind Changer 中途改需求，三者覆盖约 80%），结果同一模型在 Expert 下 EQR **0.448**、Vague 下 **0.177**、Mind Changer 下 **0.208**。工程上的落点是：**把"答不上来 / 答得含糊 / 答了又改"当成三种正常答案类型，而不是异常路径**。具体形态见 §2.12 与 §4.4。

---

## 二、可抄的提问框架

### 2.0 先说一个"看起来最像答案但不是答案"的

Carrizo / Dieste / Juristo 的 IEEE TSE 2010 系统综述（30 项实证研究、43 种 elicitation 技术、50 种对照）**是这一领域最权威的汇总，但我读不到它的结论**（出版商 elide 了摘要，全文封闭）。所以下面没有任何一条引自它。若后续要买全文，它是唯一值得买的一篇。

### 2.1 需求缺陷三分法 —— `inconsistency / ambiguity / incompleteness`

**出处**：HumanEvalComm（arXiv:2406.00215）§2.1，直接沿用 RE 领域定义。

**结构**（论文给的判据，逐条可复用）：

| 类 | 判据 | 论文里的构造方法 |
|---|---|---|
| **Ambiguity** | 同一句话可被读成多种意思 | 把确定量换成不定量（"incremented by 1" → "incremented by a number"）。**注意论文的实测发现：单纯加歧义常常不足以触发提问**，因为函数签名和样例会补回信息。论文的解法是"歧义 + 一定程度的错误"才稳定触发 |
| **Inconsistency** | 题面内部自相矛盾（文字与样例冲突、样例之间冲突） | 有意义地改样例输出，制造与文字的冲突 |
| **Incompleteness** | 缺了生成正确代码必需的信息 | 删掉一段，并验证"删掉后不问就写不出正确代码" |

**为什么能抄**：这三类**正好对应三种不同的问法**——歧义问"你指的是哪个意思"，矛盾问"以哪个为准"，缺失问"这个值是多少"。这比"你觉得还有什么要补充的吗"强得多。

**能直接用的局限**：论文里"歧义"这一类是**人工构造**的，自然需求里的歧义不会这么干净。而且论文承认，人工构造花费 130 人时 / 164 题。

### 2.2 十类歧义 taxonomy + 每类一个示例问句（**最该直接抄的一份清单**）

**出处**：ClarifyCodeBench（arXiv:2607.00711）Table 2。原文按"clarity / completeness / verifiability"三条原则实例化到代码生成。

| 类型 | 含义 | 示例问句（原文直译） |
|---|---|---|
| **Terminology** 术语 | 领域词/动作/状态未定义、重载、或多解 | "网格里的 `#`、`.`、`?` 各代表什么？" |
| **Behavior** 行为 | 功能、目的或副作用未指定，行为不唯一 | "这个操作应该改原对象，还是返回新对象？" |
| **Edge Cases** 边界 | 边界或异常条件未指定 | "没有有效解时返回什么？" |
| **Indices & Ranges** 下标与区间 | 下标基、区间端点、开闭未指定 | "端点是闭区间吗？下标从 0 还是 1 开始？" |
| **Ordering & Atomicity** 顺序与原子性 | 时序、同时性、不可分割性不明 | "这些更新是逐条处理，还是原子应用？" |
| **Output Format** 输出格式 | 输出结构、排版、呈现规则缺失 | "每个答案单独一行打印吗？" |
| **Comparison Rules** 比较规则 | 比较键、平局规则、稳定性未指定 | "两个条目分数相同时怎么破平？" |
| **Units** 单位 | 有量无单位、无尺度、无量纲约定 | "结果用秒、分，还是别的单位？" |
| **Collection Semantics** 集合语义 | 容器/状态对象的成员资格、更新规则、访问语义未指定 | "元素处于什么状态算 active？怎么取？" |
| **Numerical Precision** 数值精度 | 精度、舍入、容差、错误处理不明 | "打印几位小数？" |

**论文实测的难度分布，比清单本身更有用**：
- **容易**：Units（三个模型 66.7%）、Numerical Precision（三个模型 100%）
- **难**：Collection Semantics（所有模型 ≤16.7%）、Comparison Rules（最好 12.5%）、Ordering & Atomicity（只有 2/5 模型能做，其余 0%）

**结论**：**"显式局部约束"类的问题（单位、精度、格式）现有模型基本能问到；"需要推断隐藏行为逻辑"的问题（集合语义、比较规则、执行顺序）基本问不到。** 这条直接告诉我们：**靠模型自己发现问题是靠不住的，必须给清单。**

### 2.3 EARS 模板 —— 把答案写成可执行断言

**出处**：Kiro 官方文档（kiro.dev/docs/specs/feature-specs），`requirements.md` 强制使用；原始方法来自 Mavin 等 2009 的 EARS。**我只读到 Kiro 的用法，没读到 Mavin 原文。**

**Kiro 里实际用的最小形式**：

```
WHEN [condition/event]
THE SYSTEM SHALL [expected behavior]
```

例：`WHEN a user submits a form with invalid data / THE SYSTEM SHALL display validation errors next to the relevant fields`

**Kiro 文档自陈的四条收益**（原文）：Clarity（无歧义）、Testability（每条可直接翻译成测试用例）、Traceability（可追踪）、**Completeness（格式迫使你想遍所有条件与行为）**。

**为什么对本项目关键**：EARS 的完整版有五种模式——Ubiquitous（`THE <system> SHALL ...`）、Event-driven（`WHEN ...`）、State-driven（`WHILE ...`）、Optional（`WHERE ...`）、Unwanted behaviour（`IF ... THEN ...`）。**这五种模式本身就是五个提问槽位**："触发条件是什么"、"状态前提是什么"、"可选特性开不开"、"出错了怎么办"。问完之后答案**必须落进某个槽位**，落不进去就说明还没问清。

**局限（必须说）**：EARS 是为"系统需求"设计的，主语是 `THE SYSTEM`。**我们的场景里主语常常是"用户"或"这个仓库"**，直接套会别扭。可抄的是**槽位结构**，不是句式。

### 2.4 ISO/IEC/IEEE 29148 的 requirement 特征表 —— 完备性检查清单

**出处**：ISO/IEC/IEEE 29148:2018（前身 IEEE 830-1998）。**⚠ 我没读到标准原文**，以下是多份二手转述一致的版本，按"未核实"标注。

特征：necessary / unambiguous / complete / singular / feasible / verifiable / correct / conforming / understandable / able to be validated / traceable / allocated / design-independent。

**可用的部分**：把它当**逐条自检的 checklist**，尤其 `singular`（一条只说一件事）和 `verifiable`（能写出判定方法）这两条，是"问题问得对不对"最省事的自检——**如果一个问题问完，答案无法写成一条可判定的断言，那这个问题就是白问的。**

**不可用的部分**：这套特征是**评价一条已写好的需求**，不是**指导怎么问出来**。它没有给"缺了哪条该问什么"。

### 2.5 用户故事三问 + 3C

**出处**：Ron Jeffries《Essential XP: Card, Conversation, Confirmation》(2001) —— **原文读到**；Connextra 模板见 Wikipedia User story 条目（引 Lucassen 2016 等）。

**Jeffries 的原话结构**（三要素）：
- **Card**：卡片本身只装"刚好够识别这条需求"的文字，不是需求全文
- **Conversation**：需求本身是通过**对话**传递的，"a meeting of thoughts, opinions, and feelings"，发生在估算时和迭代计划时
- **Confirmation**：**"The best supplements are examples; the best examples are executable."**

**Connextra 模板**：`As a <role> I can <capability>, so that <receive benefit>`（Mike Cohn 认为 `so that` 可省但通常有用）。

**对我们最有价值的是 Jeffries 那句**：**确认靠可执行的例子，不靠描述**。这与 §2.9 的 execution-based 判据是同一个思想的两种表述，而且早了 25 年。

**三问的形式**（业界通用，Wikipedia 收录的变体）：谁（who）/ 要什么（what）/ 为什么（why）。第三问是最容易被跳过、也是最能改行为的一问——**"为什么"决定了当"要什么"做不到时的替代方案**。

### 2.6 INVEST —— 判"这条能不能开工"

**出处**：Bill Wake, "INVEST in Good Stories, and SMART Tasks", xp123, 2003-08-17。**原文逐条读到。**

六条与 Wake 的定义：
- **Independent**：不与别的故事在概念上重叠，能任意顺序排期实现
- **Negotiable**：不是"特性的明确合同"，细节由客户与程序员在开发中共同创造；好故事抓的是**本质不是细节**
- **Valuable**：必须对**客户**有价值
- **Estimable**：可估算
- **Small**：小
- **Testable**：可测

**Wake 在原文里另外给了两条对我们直接有用的判断**：
- 故事是 **pidgin language**（洋泾浜）——"我们并不期待客户和程序员用同样的方式看系统；故事是一种双方能足够有效协作的简化语言"。**这意味着提问的目标不是"让用户说出规格"，而是"让双方达成足够用的共识"。**
- 拆分故事时不要按技术分层切（"网络层 / 持久层 / 逻辑层 / 表现层"），要按**价值的层次**切。

**可抄的落点**：INVEST 的六条里，**Testable 是唯一能当硬门禁的**（其余五条都是主观判断）。当一个问题问完、答案仍然写不出可测的判据时，说明**问题问错了层次**。

### 2.7 Definition of Ready —— 概念确认，出处未核实

**确认到的**：Wikipedia（Scrum 条目）把它定义为"a checklist of what needs to be completed before starting work on an item"，并引 PMI Disciplined Agile 页面为源。**它不在 Scrum Guide 里**（Scrum Guide 只定义 Definition of Done），是社区实践。

**没确认到的**：谁先提出。xp123 的候选 URL 全部 404，PMI / scrum.org 403，Fowler bliki 404。**"Bill Wake 2008" 这个说法我没能核实，不写成事实。**

**可抄的落点**：DoR 的**形状**（开工前一组 yes/no 判据，全 yes 才开工）与我们"开工前问准"的定位完全同构。**这是本项目最该认领的既有概念。** 它的已知批评（"waterfall-esque"、"big design up front"）也正是我们要预先回答的质疑——区别在于：**DoR 要求人工把条目写到 ready，我们要求 AI 在开工前把不确定性问掉。**

### 2.8 Socratic 六类问句 —— 问不准时换角度

**出处**：Wikipedia "Socratic questioning"（引 Paul & Binker 1990）。**原始 PDF 未下到。**

六类（每条带示例问句，原文）：
1. **澄清思考与其来源** — "Why do you say that?" / "Could you explain further?"
2. **挑战假设** — "Is this always the case?" / "Why do you think that this assumption holds here?"
3. **要求证据** — "Why do you say that?" / "Is there reason to doubt this evidence?"
4. **发现替代观点与冲突** — "What is the counter-argument?" / "Can/did anyone see this another way?"
5. **推演含义与后果** — "But if this happened, what else would result?" / "How does it affect this?"
6. **质疑问题本身** — "Why do you think that I asked that question?" / "Which of your questions turned out to be the most useful?"

**可抄的落点**：第 2 类（挑战假设）和第 5 类（推演后果）**是代码任务里最缺的两类**。我们的问题清单里绝大多数是"这个值是多少"（第 1 类），几乎没有"如果这里错了，下游会怎样"（第 5 类）——而后者恰恰是"一次做完"最需要的。

### 2.9 CONTRA 的三段式：发现 → 资格判定 → 自适应选择（**最该抄的机制**）

**出处**：CONTRA（arXiv:2610.01769）§3。training-free，无标注。

**三段结构**：

1. **Question Discovery（宽发现）**：从需求生成一大批候选问题，每问附两个"可信答案"（requirement completion）。每轮同时做"带上下文的生成"和"只看需求的独立生成"，然后去重合并。停止条件是**连续两轮没有新问题**或到达轮数上限。
2. **Question Qualification（窄过滤）**：三个判据取交集
   - `Rel(q)`：与要求的行为相关
   - `Unres(q)`：**尚未被需求或历史回答解决**（去重判据）
   - `Diff(q)`：**行为差异判据**——用两个 completion 各生成一份程序，在同一批输入上执行，**行为必须稳定不同**才保留
3. **Adaptive Question Selection**：用交互历史重新评估"哪些问题已经被答案解决或变得不必要了"，选一个或停止。

**关键数据**（论文自报）：
- 发现阶段 recall 很快饱和，**约 4 轮就能找回大部分 gold question**，但 precision 随候选集增大而下降 → **"先宽后窄"是对的，"只想一遍"是错的**
- 只看 discovery：macro TKQR 19.03%；加完 qualification：**32.52%**——**过滤本身把关键问题提前了**
- 加自适应选择：precision 21.57% → **45.42%**
- 与 Claude Code 同 LLM（Qwen3.8-27B）、同预算、同协议对照：F1 **19.86% vs 9.63%**，recall **20.73% vs 6.26%**，TKQR **18.79% vs 6.59%**；precision 略低（19.05% vs 20.86%）；**两家在"完全指定的题"上的误问率（FPR）都是 5.00%**（OpenHands 是 32.50%）

**为什么这是最该抄的一条**：`Diff(q)` 是**唯一不需要标注、纯执行就能判"这问题值不值得问"的判据**。它把"问得准不准"从主观判断降级成"跑两个程序看输出是否不同"。这正好落在本仓已有的 `verify-claims.mjs`（断言 vs 证据）与 `evidence-discipline.md`（可复现）的形状上。

**已知边界**：`Diff(q)` 只能判"这一问**会改变行为**"，判不了"这一问**用户会不会有意见**"。而且它要求能自动生成两份可执行程序——在纯文档 / 纯配置类任务上不适用。

### 2.10 Pinning Decisions（decision pin）—— 把"问对了"变成可执行记录

**出处**：arXiv:2610.03237 摘要（全文未取到）。

**三步**：
1. **点名枚举**需求里所有 underspecified point
2. 对每个点，构造**两个只在这一点上不同**的一次性实现，找**一个能让两者输出不同的输入**（separating input）
3. 记录成 **decision pin**：点名 + 确认过的输入 + 人在这两个展示结果之间选的值。此后既用它约束生成，也用它**通过执行判合规**

**数据**（摘要原文）：
- 600 份生成测试套件里 **42.7% 不含任何能区分两种读法的测试** → **"写了测试"不等于"测到了歧义"**
- 40 任务基准上，**92.5%** 的决策点能拿到 separating input；**85–90%** 的 pin 能确认出预期决策
- 703 份独立实现上，pin 与基准分类一致率 **96–97%**
- **一个关键负面发现**：所有"散文规则"下的合规失败，**都来自模型自己去决定规则的适用范围**；有一例甚至静默推翻了另一条已记录的决策，而**文本级对账没抓到，重跑记录的输入才抓到**

**可抄的落点**：这是我们"问准 → 做完"闭环最接近的现成形态。**答案不存成一句话，存成一个可重放的输入 + 期望输出。**

### 2.11 Claude Code `AskUserQuestion` 的实际设计约束（一手，来自二进制）

**来源**：本机 `claude.exe` 2.1.308 的字符串与 schema。**这不是文档，是代码里的硬约束，比文档更可信。**

| 约束 | 值 / 行为 |
|---|---|
| 每次调用问题数 | `min(1).max(4)`，硬 schema。"do not exceed them even if the user requests more — split into multiple calls instead" |
| 每个问题的选项数 | `min(2).max(4)`，**多选也适用**（"this cap applies to multiSelect too — group or split"） |
| `Other` | **不要自己提供**，"that will be provided automatically" |
| `Skip` | 同样自动提供（"the form lets the user type their own answer or leave a question unanswered"） |
| `header` | 上限 **12 字符**，显示成 chip/tag |
| 单选时选项 | 必须互斥 |
| 只给 1 个选项 | **整个调用被拒绝，用户看不到**。steering 文本："A question with a single option has no decision in it. Do not retry this call and do not invent a filler second option. Instead, state the one path you were going to offer as the approach you are taking, then continue with the task." |
| 问题文本 | 必须唯一；同一问题内选项 label 必须唯一 |
| 扩展形态（新版本） | `kind: "choice" \| "text" \| "number"`；`number` 需要 min/max 且 min<max，可带 step / defaultValue / unit |
| 用户可"再问一轮" | 有 `followUp` 字段：用户可以选择"再问一轮"而不是回答——**这是"答不上来"的一种真实表达形式** |
| 空闲自动收尾 | 用户离开键盘一段时间后对话框自动 resolved，返回值里标明毫秒数 |
| 系统提示里的默认倾向 | "It is best to be proactive with your own work when you have enough information to do so… only bother them when you know you need them!"（`uqs` 常量） |

**为什么是"选项 + Other"而不是纯开放**：
- 硬理由是**可校验**：选项 label 可去重、可判互斥、可统计；自由文本不能
- 软理由在 steering 文本里：**"Ask a question only when the person has at least two genuinely distinct choices"** —— 这条把"提问"重新定义成"**呈现一个真实的二选一（或 N 选一）**"，而不是"索要信息"。**这是 Anthropic 对"什么算一个好问题"的显式立场：好问题 = 一个真实的决策点。**

**这条立场与本项目的关系**：我们的四形态（选项 + 后果 + 推荐 + 开放式）里，"开放式"是必要的（用户答不上来时要有出口），但**不能替代选项形态**——因为只有选项形态能带"后果"和"推荐"。

### 2.12 用户分层（"答不上来"的可用处理）

**出处**：ReqClarifyBench（arXiv:2610.13022）§4.2，persona 来自 SWE-chat（真实开发者与 coding agent 的多轮对话数据集）。

| Persona | 行为特征 | 实测 EQR | 实测 AvgClarified |
|---|---|---|---|
| **Expert Nitpicker** | 回答精确详尽、目标稳定 | **0.448** | **2.384** |
| **Vague Requester** | 只说大概，大量细节不指定 | **0.177** | **0.549** |
| **Mind Changer** | 交互中途修改需求 | **0.208** | **0.610** |

（未加权前两者覆盖约 80%。盲评识别 persona 的准确率 95.8%，Cohen's κ=0.892。）

**停止轮数的实测分布（同论文 Figure 5）**：Expert 下模型 2–3 轮就停；Mind Changer 下 6 轮左右；Vague 下 14–15 轮，部分逼近上限。**"需求越模糊 → 问得越多"是模型的自然行为，而且这个行为在 Vague 下几乎不收敛。**

**可抄的落点**：**先判用户类型，再决定问法**。
- Expert → 少问、问深（一次问清一个点）
- Vague → 不开放式发问，**给选项**（"A 还是 B"比"你想要什么"有效）
- Mind Changer → **问完就落 pin**（把答案固化成可重放的输入），否则后面的改动会把前面的答案冲掉

### 2.13 一个反直觉的发现：模型"看得出歧义"但"不会问"

**出处**：arXiv:2605.25284（Knowing but Not Showing）。

- 显式让模型判"这题有没有歧义"时，模型**常常能识别**
- 直接给它题目让它答时，**绝大多数直接作答**
- **给了检索上下文之后，提问率进一步下降**（因为上下文提高了"可答性"）

**对设计的直接含义**：**不能靠"让模型自己意识到该问"来保证问**。必须有一条独立的、与执行分离的"歧义检测"环节。Ask or Assume?（2603.26233）的做法正是如此——把 `Intent Agent` 与执行分离，UA-Multi 达到 **69.40%** resolve rate，显著优于单 agent，并逼近"给全信息"的自主 agent；而未分离的 UA-Single 只有 61.20%。

---

## 三、提问数量的实证：有没有数据支撑"问几个合适"

### 3.1 唯一一个真人在线实验

**arXiv:2008.00279**（商品推荐场景，部署在线的 question-based 系统）：

| 指标 | 值 |
|---|---|
| 实际平均答题数（每目标商品） | **11.4** |
| 中位数 | **7** |
| 答 4–12 题的用户占比 | **70.3%** |
| 最少 / 最多 | 2 / 48 |
| 退出问卷中自称愿答 | 50% 说 **6–10** |
| 停止原因（oracle 答案条件） | 找到目标 77%、**疲劳 14%**、问题不相关 7% |
| 停止原因（答案不完美条件） | 找到目标 38%、**疲劳 34%**、**问题不相关 22%** |
| 答案与目标商品描述**相反**的比例 | **12–17%** |
| 认为系统有帮助的用户 | 66–84% |

**怎么读这组数**：
- **"用户愿意答 11 个"和"用户答对 11 个"是两件事**：同一批数据里 12–17% 的答案是错的
- **疲劳和不相关是主要流失原因**，而且"答案不完美"时疲劳从 14% 涨到 34% —— **用户答得越差，越容易烦**
- 论文自己的批评："大多数算法评估都假设用户愿意回答系统生成的任意数量的问题，并且总能答对"——**这个假设被实测证伪了**

**不能照搬的理由**：选项式、零思考成本、有即时反馈（每答一题看到新候选）。代码任务里每个问题都要用户想。

### 3.2 代码任务上的"应有轮数"，是用标注算出来的

**ClarifyCodeBench**：419 题，其中 199 题 1 个歧义点、169 题 2 个、51 题 3 个。**理想轮数定义为 `K = |标准问题数| + 1`**（+1 是最后那轮"不问了，去写代码"）。

**实际轮数（Table 4）**：

| 模型 | 平均提问轮数 | 与理想轮数之差 |
|---|---|---|
| GPT-4o | 1.26 | −0.38 |
| Claude-Sonnet-4.5 | **0.29** | **−1.36** |
| Gemini-2.5-Flash | 2.22 | +0.57 |
| DeepSeek-V3.2 | 1.54 | −0.10 |
| Qwen3-235B | 0.46 | −1.18 |
| Claude-Sonnet-4.5 (thinking) | **0.24** | **−1.41** |
| GPT-5 | 0.70 | −0.94 |

**结论（论文的 Finding 5）**：**现有模型问得远远不够**，而且 **thinking 让它们问得更少**——"thinking mainly strengthens internal reasoning after a model commits to an interpretation, rather than encouraging it to request missing information"。

**这是本节最重要的发现，也是对我们命题最有利的一条证据**：**主流模型的默认行为是"少问、自己猜"，而且"更聪明"会加剧这个倾向。** 所以"必须问"作为硬约束有真实的问题背景，不是凭空立的。

### 3.3 别的协议里用的预算

| 系统 | 提问预算 | 依据 |
|---|---|---|
| CONTRA | **最多 5 问**（与所有 baseline 同预算） | 对标实验设置 |
| AskBench | **3 轮**，Hard 协议 **2 轮** | 评测设置 |
| Ask or Assume (UA-Multi) | 无硬预算，模型自决 | Claude Sonnet 4.5 平均 **3.06** 问/任务；Kimi K2.6 平均 **8.71** 问/任务 |
| ReqClarifyBench | 有上限，模型自决 | Expert 2–3 轮 / Vague 14–15 轮 |
| HumanEvalComm (Okanagan) | **3 轮**（可配置） | 默认参数 |
| Claude Code AskUserQuestion | 每次调用 **1–4 问** | 硬 schema |

**合起来**：
- **单次交互的合理批量是 1–4**（Anthropic 的硬约束，也是 AskBench/ClarifyCodeBench 的实验设置）
- **整个任务的合理总量没有普适阈值**：3 问（Ask or Assume）和 5 问（CONTRA）都是实验里定出来的，不是从数据推出的
- **唯一有真人数据的 11.4 不适用于代码任务**

### 3.4 提问顺序：查不到直接证据

**我做了这些查询，全部为空**：
- arXiv `all:"question ordering" AND all:clarif` → 0
- arXiv `all:"clarification questions" AND all:"order"` → 0
- WebSearch 调查方法学里的 order effect → 有大量结果（primacy / recency，Miller & Campbell 1959），但**全部是问卷设计领域，与"AI 澄清提问的顺序"不是同一问题**

**间接可用的只有两条**：
- **ClarifyCodeBench 的 TKQR 设计本身就是"顺序有影响"的假设**：它对第 i 轮命中的关键问题按 `1/log2(i+1)` 折价。**这是论文作者认定"早问比晚问值钱"，但我没找到他们验证这个折价函数合理的实验。**
- **CONTRA 的消融显示"过滤会改变顺序"**："qualification checks only remove candidates and preserve the relative order of the remaining questions. Removing unnecessary questions allows key questions to appear earlier"——**删掉废问题等于把好问题提前**。这是"顺序"唯一有数据支撑的机制。

**如实说：没有研究直接测过"同一组问题，换个顺序问，结果会不会不同"。**

---

## 四、怎么知道问对了

### 4.1 需要"标准问题集"才能算的（依赖人工标注）

| 指标 | 定义 | 出处 | 前提 |
|---|---|---|---|
| **Communication Rate** | 初始回复中**不含代码**的比例 | HumanEvalComm | **无需标注**，只需判有没有代码块 |
| **Good Question Rate** | 被 LLM 评判为 Good 的比例 | HumanEvalComm | 需 LLM judge（论文承认不可靠） |
| **TKQR** | 折价累积增益，奖励早问关键问题 | ClarifyCodeBench | 需 gold question |
| **ORA** | 实际轮数与理想轮数 `K+1` 的高斯贴合度 | ClarifyCodeBench | 需 gold question 数 |
| **Precision / Recall / F1** | 问题与 gold 的匹配率 | CONTRA | 需 gold；precision 的**分母含"完全指定题上问的问题"**，这是它能惩罚过度提问的原因 |
| **FPR** | 在**完全指定**的题上至少问了一个问题的比例 | CONTRA | 需"完全指定"对照组 |
| **EQR** | 至少澄清了一条原子需求的问题占比 | ReqClarifyBench | 需预分解的原子需求 |
| **AvgClarified** | 每问平均澄清的原子需求数 | ReqClarifyBench | 同上 |
| **ReqAlign** | 原子需求级 covered/omitted/violated 打分均值（−1..1） | ReqClarifyBench | 同上 |

**这套指标的通病**：全部依赖"有人先写出了标准答案"。在真实场景里，**标准答案就是我们要问出来的东西**——所以它们只能用于**离线评测我们的提问器**（可以自建一个内部基准），不能用于**线上判断这一次问得对不对**。

### 4.2 不需要标注的（可在线用）

**(a) 行为差异判据 `Diff(q)`** —— CONTRA
- 用两个候选答案各生成一份程序，找共享输入执行，**输出必须不同**
- 不需要 gold question，不需要人工
- 局限：要求任务能自动生成可执行产物。文档 / 配置类任务不适用

**(b) Decision pin 的 separating input** —— arXiv:2610.03237
- 与 (a) 同源，但把结果**持久化成记录**：点名 + 输入 + 人选的值
- 副产品是最强的一条：**它同时是"问题问对了"的证据和"实现做对了"的判据**
- 数据：92.5% 的决策点能拿到 separating input；703 份实现上与基准分类 96–97% 一致

**(c) 去重判据 `Unres(q)`** —— CONTRA
- 问题是否已被**原话**或**历史回答**解决
- 这是最便宜的一条，应该无条件先跑

**(d) 返工率 / 首次通过率** —— 工程指标
- **返工率不是唯一可用指标，但它是唯一不需要标注、不需要可执行产物的指标**
- 它的致命弱点是**滞后**：要等做完才知道
- **必须配对使用**：只看返工率会奖励"多问"，因为多问通常降返工。必须同时看**用户干预次数 / 每题耗时**

### 4.3 "需求完备性"能不能机械检验：**不能**

**三个层次的答案**：

1. **全局完备性不可判定。** "用户想要的是否都问到了"需要一个"用户真实意图"的 oracle，而这个 oracle 在问题之外不存在。HumanEvalComm 和 ClarifyCodeBench 的做法是**人工先删掉信息、再把删掉的那条当标准**——这是**构造出来的可判定性**，只在基准里成立。原题本身没有"标准问题集"。

2. **局部可判定性是有的，而且够用。** 上面 (a)(b) 给出的判据回答的不是"问全了没有"，而是"**这一问会不会改变结果**"。这是一个**更弱但可判定**的性质。CONTRA 的实测（macro F1 41.20%，比最好 baseline 高 13.88pp；Claude Code 在同样协议下 9.63%）说明这个更弱的性质**确实能区分好坏**。

3. **"漏了哪个问题"可以事后定位，不能事前保证。** ReqClarifyBench 的 ReqAlign 能算出"哪条原子需求被 omitted"，但前提是有人先写出原子需求清单。**这与本仓 `verify-claims.mjs` 的处境完全一样：能判"断言有没有证据支撑"，不能判"断言本身对不对"。**

### 4.4 一条来自实测的负面提醒：问完不等于对齐了

**arXiv:2611.01087（N=180，6 个日常决策场景，被试随机进入"有 2 个前置澄清问题"或"没有"两个条件）**：

| 观测 | 无 CQ | 有 CQ |
|---|---|---|
| 复查响应耗时（均） | — | **55.0 秒**（更短） |
| **未修改直接接受** | **46%** | **60%**（p=.024, d=0.38） |
| 含违规的响应被接受 | 基线 | 更高，**且 CQ-adjacent 违规 > nonadjacent 违规** |
| 自评"理解到位" / 满意度 | 较低 | 更高 |
| 一般信任 | 无变化 | 无变化 |

**论文的结论原话**："pre-answer CQs reduce subsequent engagement and increase unchanged acceptance of LLM responses, including erroneous ones"。

**对我们的设计约束**：**"问过了"不能当验收证据。** 用户答过问题 → 更信任 → 更少复查 → 更容易放过错误。这正好撞上本仓"验收 Agent 一票否决"的硬约束——**验收不能因为"开工前问过了"而放松，反而应该更严**，因为提问已经消耗了用户的审查预算。

---

## 五、反面证据

### 5.1 多问了会变差（直接实测，最硬）

**HumanEvalComm 的 Okanagan**：在**原始 HumanEval**（题面完整，不需要问）上：

| | Pass@1 | Test Pass Rate |
|---|---|---|
| ChatGPT 单轮 | **65.58%** | **76.42%** |
| Okanagan（ChatGPT 底座） | **27.45%** | **33.45%** |

论文原话："Okanagan sometimes still asks questions that appear to be unnecessary, since the original problem is known as complete… This is a valid limitation"。

**为什么这条重要**：这不是"用户嫌烦"，这是**分数掉了一半**。机制是"问 → 拿到（模拟的）答案 → 基于答案重写代码"，而原本正确的解读被答案污染了。

### 5.2 问完人会更不设防

见 §4.4。这是**问对了**也有代价的证据——不是问错了才有代价。

### 5.3 提问器会产生大量废问题

**CONTRA 对 ClarifyGPT 的批评（有数据）**：ClarifyGPT 用"采样程序之间行为不一致"来发现问题，而**行为不一致也可能只是实现 bug**，所以"asks many unnecessary questions"。GPT-5-mini 下 ClarifyGPT 的 precision 只有 **13.58%**（recall 37.37%）。

**同一个表里，其他 baseline 也都不平衡**：
| 方法 | P | R | F1 |
|---|---|---|---|
| Direct Prompting | 41.61 | 19.28 | 25.30 |
| Ask-or-Assume | 33.02 | 23.60 | 27.32 |
| ClarifyGPT | 16.59 | 28.29 | 20.37 |
| CONTRA | **45.42** | **38.01** | **41.20** |

**读法**：**"让模型自己决定问不问"（Direct Prompting）precision 最高但 recall 极低——漏问严重；"用行为不一致当信号"（ClarifyGPT）recall 高但 precision 极低——废问严重。两者都不够好，最好的方法也只有 41% F1。** 这个领域远未解决。

### 5.4 用户会在答不出时给出错误答案

**arXiv:2008.00279**：**12–17% 的答案是"与目标商品描述相反"的**。用户不是拒绝回答，是**答错了**。

**含义**：提问不是"取信息"，是"取可能带噪的信息"。**"用户答了"和"答案是对的"之间有一道 12–17% 的漏损。**

### 5.5 用户疲劳是真实的主要流失原因

同一实验，"答案不完美"条件下 **34% 因疲劳停止**、**22% 因问题不相关停止**——合计 **56%**，超过"找到目标"的 38%。

**含义**：一旦用户答得不准，后续问题的边际价值骤降，而疲劳骤升。**"问不准"是会自我强化的。**

### 5.6 我没找到的：工业界的"多问导致失败"复盘

我查了：
- HN Algolia：`agent asks too many questions clarify`、`"clarifying questions" LLM coding agent` —— 返回的都是无关帖（YC 产品发布、模型评论）
- WebSearch 多组查询 —— 无第一手复盘

**如实说：没有找到"某个 code agent 因为问太多而失败"的公开复盘。** 这不代表不存在，只代表我查不到。§5.1 的 Okanagan 是能找到的最接近的实证。

### 5.7 提问本身成为失败点的四种已知形态

把上面的证据归并，**"提问"会以四种方式自己变成 bug**：

| 形态 | 证据 | 检测方式 |
|---|---|---|
| **问不该问的**（题面已完整） | Okanagan Pass@1 65.58→27.45 | FPR（CONTRA 的做法：拿"完全指定"的题当对照组） |
| **问不改变行为的**（问了等于没问） | ClarifyGPT precision 13.58% | `Diff(q)` 行为差异判据 |
| **问已经答过的**（重复） | CONTRA 的 `Unres(q)` 判据存在本身就说明这是常见失效 | 历史去重 |
| **问完降低审查**（隐性代价） | N=180 实验，未修改接受 46%→60% | 无法自动检测；只能设计上补偿（验收不放松） |

---

## 六、对 Overwatch 的落点（不做设计，只标方向）

按上面的证据，最该认领的三件事：

1. **问题清单不靠模型即兴生成，靠 taxonomy 驱动。** ClarifyCodeBench 的十类 + HumanEvalComm 的三类是最直接的候选。尤其**十类里"模型做得差的四类"（Collection Semantics / Comparison Rules / Ordering & Atomicity / 部分 Edge Cases）应该做成硬性检查项**，而不是等模型自己想起来。
2. **"问对了"的在线判据用执行差异，不用 LLM judge。** `Diff(q)` + decision pin 的形状与本仓 `evidence-discipline.md`（可复现）和 `verify-claims.mjs`（断言 vs 证据）同构，可以直接沿用同一套纪律。
3. **"必须问"必须配"不许白问"。** 否则就是 Okanagan：问得越多，分数越低。配套的硬门禁应该是 CONTRA 的 FPR——**在"本来就清楚"的任务上，一个问题都不该问。**

未回答、留给下一轮的三条：
- **提问顺序**：没有直接研究，只能靠自建 A/B。
- **多 agent 下问题怎么合并**（命题文档第 5 问）：本次没查。唯一相关的间接证据是 Ask or Assume 的"检测与执行分离"优于合一（69.40% vs 61.20%），说明**问的人应该独立于做的人**——这支持"独立问询 Agent"的形态，但没回答"5 个手下各问 3 个怎么压成 1 个包"。
- **开放式问题的评价**：所有可机械检验的判据都建立在"选项式 / 有 gold question"的前提上。**自由文本答案的质量怎么判，本次没找到任何可用方法。**

---

## 参考文献（全部为本次实际访问过的 URL）

**代码生成 × 澄清提问**
- HumanEvalComm — https://arxiv.org/abs/2406.00215 （全文 https://arxiv.org/html/2406.00215v3）
- ClarifyGPT — https://arxiv.org/abs/2310.10996
- CONTRA — https://arxiv.org/abs/2610.01769 （全文 https://arxiv.org/html/2610.01769v1）
- ClarifyCodeBench — https://arxiv.org/abs/2607.00711 （全文 https://arxiv.org/html/2607.00711v2）
- ReqClarifyBench（Don't Guess, Just Ask） — https://arxiv.org/abs/2610.13022
- Ask or Assume? — https://arxiv.org/abs/2603.26233
- Pinning Decisions Before Failure — https://arxiv.org/abs/2610.03237
- Asuka-Bench — https://arxiv.org/abs/2606.05920
- UnderSpecBench（Coding Agents Are Guessing） — https://arxiv.org/abs/2607.02294
- HumanEvalComm 作者前作（position paper） — https://arxiv.org/abs/2308.13507

**澄清提问的一般研究**
- An Empirical Study of Clarifying Question-Based Systems — https://arxiv.org/abs/2008.00279
- Is That Clear? — https://arxiv.org/abs/2611.01087
- Knowing but Not Showing — https://arxiv.org/abs/2605.25284
- AskBench（When and What to Ask） — https://arxiv.org/abs/2602.11199
- QuestBench — https://arxiv.org/abs/2503.22674
- STaR-GATE — https://arxiv.org/abs/2403.19154
- TO-GATE — https://arxiv.org/abs/2506.02827
- Modeling Future Conversation Turns — https://arxiv.org/abs/2410.13788
- Can LLMs Ask Good Questions? — https://arxiv.org/abs/2501.03491
- Disambiguation in CQA: A Survey — https://arxiv.org/abs/2505.12543
- Qulac — https://arxiv.org/abs/1907.06554
- CLAM — https://arxiv.org/abs/2212.07769
- Learning to Clarify (ACT) — https://arxiv.org/abs/2406.00222
- Estimating Usefulness of CQs — https://arxiv.org/abs/2401.11463
- Deciding Whether to Ask CQs in SLU — https://arxiv.org/abs/2109.12451
- When to Ask, When to Answer — https://arxiv.org/abs/2611.05517
- iSNEAK — https://arxiv.org/abs/2310.19125

**需求工程**
- Requirements elicitation（概览，含"无法靠问就确保拿全"的表述） — https://en.wikipedia.org/wiki/Requirements_elicitation
- Carrizo/Dieste/Juristo 2010（**只确认存在，未读到结论**） — https://doi.org/10.1109/TSE.2010.33
- INVEST（Bill Wake, 2003，**原文**） — https://xp123.com/articles/invest-in-good-stories-and-smart-tasks/
- Card, Conversation, Confirmation（Ron Jeffries, 2001，**原文**） — http://ronjeffries.com/xprog/articles/expcardconversationconfirmation/
- User story（含 Connextra 模板与 3C） — https://en.wikipedia.org/wiki/User_story
- Socratic questioning（六类问句，转述 Paul & Binker 1990） — https://en.wikipedia.org/wiki/Socratic_questioning
- Definition of Ready（概念出处，**未核实原始提出者**） — https://en.wikipedia.org/wiki/Scrum_(project_management)#Definition_of_ready
- Expected value of perfect information（"问的价值上限 = 决策损失"的形式化） — https://en.wikipedia.org/wiki/Expected_value_of_perfect_information

**产品 / 工具**
- Kiro Specs（EARS 用法） — https://kiro.dev/docs/specs/ 、https://kiro.dev/docs/specs/feature-specs/
- Claude Code `AskUserQuestion` 约束（**一手：本机 2.1.308 二进制字符串**，非公开文档；公开文档页未提到该工具）
