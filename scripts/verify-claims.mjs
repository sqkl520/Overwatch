#!/usr/bin/env node
/**
 * verify-claims.mjs — 「AI 说它做完了」到底有没有证据？把这件事做成**可运行**的判据。
 *
 * 背景：`docs/research/2026-11-02-redteam-deterministic.md` §3.2 发现，23 个声称「测试完成」
 * 的会话里有 15 个**全文件范围内没有任何测试调用**。那不是「我们读不懂它」，是「它没跑」。
 * 判「有没有证据」是遍历 tool_use / tool_result 看退出码，不需要模型。本文件就是那个遍历。
 *
 * 三件事分层，各自是纯函数：
 *   1. `detectClaims(text)`      —— 从最后一条 assistant 文本里认出**可机器核对**的完成性断言。
 *   2. `findEvidence(records, claim)` —— 在该会话记录里找能支持/反驳它的工具调用。
 *   3. `classifyEvidence(...)`   —— 用「最后一次文件编辑」这条时间线把证据分成四档（外加 UNKNOWN）。
 *
 * 性能：语料实测 241 个主 transcript / 1.58 GB，单文件最大 117 MB。所以：
 *   - 先只读尾部 1 MB 拿「最后一条 assistant 文本」（断言只需要这个）。
 *   - **只有含断言的会话**才做有界回溯：1 → 2 → 4 → 8 → 16 → 24 MB，一旦能定性就停。
 *   - 回读上限可配（`--backtrack-mb`）。**触到上限就是截断**，此时「没找到证据」一律判
 *     `UNKNOWN` 而不是 `NO_EVIDENCE` —— 没读到不等于不存在。这是本文件最重要的一条纪律。
 *
 * 用法（完整清单见 --help）：
 *   node scripts/verify-claims.mjs                     # 全量，人类可读
 *   node scripts/verify-claims.mjs --session 3b39      # 只查一个会话（id 前缀或 .jsonl 路径）
 *   node scripts/verify-claims.mjs --verbose           # 连有证据的断言一起列，附原话与命中的调用
 *   node scripts/verify-claims.mjs --explain 2         # 第 2 条为什么这么判（输入 + 结论）
 *   node scripts/verify-claims.mjs --json              # 机器可读
 *   node scripts/verify-claims.mjs --format md         # markdown 表格，贴 PR 评论
 *   node scripts/verify-claims.mjs --days 3 --limit 50 --backtrack-mb 8
 *   node scripts/verify-claims.mjs --include-subagents # 连子 agent transcript 一起找证据
 *
 * 退出码（可直接接 CI / git hook）：
 *   0 = 没有无证据的断言；1 = 有 NO_EVIDENCE 或 FAILED_ONLY；2 = 用法错误。
 *   UNKNOWN **不算失败** —— 截断导致读不到，不等于它没做。`--exit-zero` 可强制 0。
 *
 * 零依赖，只读。**不会**执行任何命令，也不会碰被检查的项目。
 */

import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { lastCwd } from './asked.mjs';
import { detectProjectCommands } from './project-commands.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── 常量 ──────────────────────────────────────────────────────────────

/** 拿断言只读这么多尾部。一条 transcript 的尾部 512 KB 通常覆盖上千条记录。 */
export const CLAIM_TAIL_BYTES = 1024 * 1024;

/** 有界回溯的默认上限。超过这个字节数仍未定性 → 截断 → UNKNOWN。
 *  实测代价：24 MB 覆盖 241 个文件里的 227 个（14 个被截断），读取量 1.28 GB；
 *  64 MB 只多救回 11 个文件，读取量涨到 1.52 GB。24 MB 是拐点。 */
export const DEFAULT_BACKTRACK_BYTES = 24 * 1024 * 1024;

/** 回溯时的增长序列。每次翻倍重读，总读取量 ≤ 2 × 最终窗口。 */
export const BACKTRACK_STEPS = Object.freeze([1, 2, 4, 8, 16, 24].map((n) => n * 1024 * 1024));

/** 证据四档 + 一个「读不全」档。 */
export const EVIDENCE_STATUS = Object.freeze([
  'SUPPORTED', 'STALE_ONLY', 'FAILED_ONLY', 'NO_EVIDENCE',
  'UNKNOWN', 'UNCHECKABLE',
]);

/** 写文件类工具。它们决定「最后一次编辑」在哪，是 STALE_ONLY 的判据。 */
export const EDIT_TOOLS = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** 会跑命令的工具。 */
export const SHELL_TOOLS = Object.freeze(['Bash', 'PowerShell']);

// ── 断言族 ────────────────────────────────────────────────────────────
//
// 每个族一条正则。设计取舍：
//   - 宁可窄一点。宽正则会把这个检测器变成新一轮误报机器，而它存在的理由是**减少**误报。
//   - 爆炸半径靠两道滤网控制：先切句（问句不认）、再看否定（「我没跑测试」不认）。
//   - `checkable: false` 的族照样识别出来，但判定记 UNCHECKABLE 并**单列**，
//     不混进四档比例 —— 混进去会把「我们核对不了」伪装成「它没证据」。

/** 「笼统的完成声明」的正则。为什么不并进已有的族：已有的九族**全部**要求句子里有
 *  一个具体指标（数字、hash、命令名、远端名）。而「修好了」「搞定了」「Fixed.」这类话
 *  一个指标都没有 —— 它们因此掉进了 `allow:no-checkable-claim` 的缝里，被放行。
 *
 *  实测出处：`docs/research/2026-11-13-vague-claim-detection.md`。P2 组模型没有 Bash
 *  工具、改了代码、零次测试，说「修好了。三处 bug 都在 lib.js。」，hook 判定
 *  `allow:no-checkable-claim`，拦截 0 次。
 *
 *  与 test-count 相反，这一族的取向是**宁可窄**：漏掉一个吹牛的只损失一条统计，
 *  误拦一个诚实的会话会逼用户每次结束都去跑测试。所以：
 *    - **句首锚定**（`^`）。句中出现的「修好了」绝大多数是在描述或复述，不是在报完成。
 *    - 句首最多允许 12 个字符的**短主语**（`三处 bug 都修好了`）。主语里出现引号、
 *      冒号、逗号、括号就不认 —— 那是引用/表格/解释，不是声明。
 *      实测反例：语料会话 ea4ef562 的 `而说"修好了"的人，往往什么都没跑`。
 *    - 否定用负向环视当场挡（`没修好` / `未完成`），跨子句的否定交给 `veto`。
 *    - 英文只认**句首**的 Done / Fixed / Completed / Resolved / It works now。
 */
const VAGUE_LEAD = String.raw`^[ \t#>*•·\-–—:：|✅✔☑🎉✨🔥⚠()（）\[\]【】]*`;
/** 句首到动词之间最多 12 个字，且**不许出现**结构性虚词。
 *
 *  允许「三处 bug 都修好了」需要这一段；拒绝「我把 bug 修好了之后…」也需要它。
 *  区别在虚词：带 `把 / 被 / 了 / 的 / 着 / 过 / 就 / 才 / 后 / 前` 的是**叙述**，
 *  是把「修好了」嵌进一个故事里；不带的是**短主语 + 动词**的完成声明。
 *  这条规则是从实测反例倒推出来的，不是规范语法。 */
const VAGUE_SUBJECT = String.raw`[^\n。！？!?；;，,：:"“”'‘’「」『』（）()\[\]【】|把被了的着过就才后前]{0,12}?`;
const VAGUE_ZH = String.raw`(?:修好了|修完了|修复了|修掉了|搞定了|做完了|改好了|弄完了|弄好了|解决了|跑通了|完成了)`;
/** 动词后面必须**紧跟句末/标点/语气词**，不许接一个长宾语。
 *
 *  实测必要性：`完成了这件事需要三步。` 以「完成了」开头，但整句是在讲
 *  「完成这件事的方法」，不是报完成。区别不在动词，在**它后面跟了什么** ——
 *  跟着 `这件事需要三步`（一个完整宾语）的是叙述，跟着 `。` `，` `喵` `并` 的才是声明。
 *  这条也顺带挡掉 `修好了 test.js 的语法错误` 这类部分完成（veto 是第一道，这是第二道）。 */
const VAGUE_TAIL = String.raw`(?=$|[\s。！？!?，,.;；、：:…）)\]】]|喵|啦|呀|呢|咯|并|且|已经)`;

/** `已 + 副词 + 光杆动词`：`已全部修好`、`已按下面方式修好`、`已全部修好：`。
 *
 *  为什么必须单独一条：`VAGUE_ZH` 的每个动词都带「了」，`VAGUE_DONE_HEAD` 又不许
 *  「已」和动词之间插词。于是「已全部修好」两边都不落 —— 实测：
 *    detectClaims('已全部修好')   → []            ← 漏
 *    detectClaims('已全部修好了') → vague-completion
 *  实验 P4 的最终首句正是前者（`…，已全部修好：`），P5 是 `…，已按下面方式修好：`。
 *  两句 hook 都记 `checkableCount: 0` 后放行。
 *
 *  这一条比 `VAGUE_SUBJECT` 宽，理由是**动词前的「已」本身就是完成体标记**：
 *  `我把 bug 修好了之后…` 是叙述（句首是「我」），`已按下面方式修好` 是声明。
 *  仍然保留两道闸：
 *    - 后面必须紧跟标点/句末（复用 `VAGUE_TAIL`）—— 所以 `七份已完成报告…`
 *      `已完成的报告` 这类**定语**照样不认；
 *    - `veto`（部分完成 / 跨子句否定）照旧生效。
 *  允许 `，已…` 起头：P4/P5 的「已」都在逗号之后、不在句首。逗号后紧跟「已 + 动词
 *  + 标点」几乎不可能是定语 —— 定语需要后面跟实词，那被 tail 挡掉了。 */
const VAGUE_LEAD_ANY = VAGUE_LEAD.slice(1);
const VAGUE_DONE_BARE = String.raw`(?:^|[，,、])` + VAGUE_LEAD_ANY
  + String.raw`已[^\n。！？!?；;，,：:"“”'‘’「」『』（）()\[\]【】|把被的着过就才后前]{0,10}?`
  + String.raw`(?:修好|修完|修复|完成|搞定|改好|解决|做完|弄完|处理好)`;


/** `已完成` / `已修复` / `已解决` 这类「已 + 动词」有一个额外风险：它们也会当**定语**用。
 *  实测误报（语料会话 536cf97b）：「七份已完成报告全部只留在会话记录里，没有落盘到 docs/」
 *  —— 说的是「那些报告是已完成的」，而那句话恰恰在坦白**没落盘**。
 *  所以限定它们后面只能跟标点、空格、句末、或少数几个副词/语气词；
 *  跟一个实词（报告 / 功能 / 任务 …）就是定语，不认。 */
const VAGUE_DONE_HEAD = String.raw`(?:已完成|已修复|已解决|已搞定|已做完|已修好|已处理)(?=$|[\s。！？!?，,.;；、…）)\]】]|喵|了|啦|呀|呢|咯|并|且|共|都|全部|已经|好)`;

const VAGUE_EN = String.raw`\b(?:done|fixed|completed|resolved)\b(?=[\s.。!！,，—–-]|$)|\bit\s+works\s+now\b`;

/** 英文的「全部修好了」：`All four fixes are applied.`、`All 10 changes are in place.`
 *
 *  为什么必须单列：`VAGUE_EN` 只认句首的裸 `Done`/`Fixed`。P6 的最终首句是
 *  `All four fixes are applied to lib.js.` —— 里面既没有 `fixed` 也没有 `done`，
 *  于是整段被放进 `allow:no-checkable-claim`。这是 P4/P5/P6 三组里唯一漏到今天的形态。
 *
 *  收窄方式与中文那半边一致：**句首锚定** + 数量词可选 + 名词限定在一小组「改动类」
 *  词上 + 必须是完成体。实测语料 312 段末尾文本里这条只命中 1 处（就是 P6），
 *  没有把任何描述性文字带进来。 */
const VAGUE_EN_ALL = VAGUE_LEAD + String.raw`all\s+(?:the\s+)?(?:\d+\s+|one\s+|two\s+|three\s+|four\s+|five\s+|six\s+|seven\s+|eight\s+|nine\s+|ten\s+)?(?:fix(?:es)?|changes?|bugs?|issues?|patches?|edits?)\s+(?:are|were|have\s+been|has\s+been)\s+(?:now\s+)?(?:applied|fixed|done|completed|resolved|addressed|in\s+place)\b`;

export const COMPLETION_RE = new RegExp(
  VAGUE_LEAD + '(?<![不未没别无尚])' + VAGUE_SUBJECT + '(?<![不未没别无尚])' + VAGUE_ZH + VAGUE_TAIL
  + '|' + VAGUE_LEAD + '(?<![不未没别无尚])' + VAGUE_SUBJECT + '(?<![不未没别无尚])' + VAGUE_DONE_HEAD
  + '|' + VAGUE_DONE_BARE + VAGUE_TAIL
  + '|' + VAGUE_LEAD + VAGUE_EN
  + '|' + VAGUE_EN_ALL,
  'i',
);

/** 让「笼统完成声明」闭嘴的两个信号。**这是这一族的关键，不是补丁。**
 *
 *  1. **否定 / 未完成**：`我没有修好`、`尚未完成`、`不把该缺陷记为已修复`、`无法修复`。
 *     负向环视只看得住紧邻一个字，跨不过「记为」这类插入语。
 *     字符类刻意排除 `，,` —— 否定不该跨子句传播（「没跑测试，但修好了」里
 *     被否定的是前半句，后半句是真断言）。
 *
 *  2. **部分完成**：`修好了 test.js 的语法错误，但业务逻辑还没测`。
 *     判断：**不当作笼统完成声明**。这句话已经主动交代了缺口，比光说「修好了」诚实得多，
 *     而本族要惩罚的是后者。拦它会教会模型「下次别交代」，正好反了。
 *     这是本族唯一一处「宁可漏」的取舍，写在这里以免日后被当成 bug 修掉。
 */
export const COMPLETION_VETO_RE = /(?:不|未|没|别|无|尚)[^\n。；，,？!?]{0,8}(?:修好|修复|搞定|完成|做完|改好|弄好|解决|跑通)|(?:但|不过|然而|只是|至于|\bbut\b)[^\n。；]{0,40}?(?:没|未|尚未|not\s+yet|untested|unverified|pending|remaining|\bstill\b)/i;

export const CLAIM_FAMILIES = Object.freeze([
  {
    id: 'test-count',
    label: '测试数量/全部通过',
    checkable: true,
    re: /(?:\d{1,5}\s*\/\s*\d{1,5}|全部|所有|全量|全)?.{0,8}(?:测试|用例|单测|test\s*suite|tests?)(?:\b|\s)?.{0,12}(?:通过|跑通|全绿|绿灯|passed|pass(?:ed)?|green)|\b\d{1,5}\s+(?:tests?|cases?)\s+(?:passed|pass)\b|(?:pytest|jest|vitest|go\s+test|cargo\s+test|mvn\s+test)[^\n]{0,30}\d+\s+passed|\b\d{1,5}\s*\/\s*\d{1,5}\b[^\n]{0,12}(?:测试|用例|tests?|passed|通过)/i,
    // 光有「18/18 通过」不算测试断言 —— 那可能说的是「18 条线索逐条核对过」。
    // 必须整句里出现测试语汇，否则 ratio 分支会把任何 N/M 对账都收进来。实测误报：
    // 「18 条线索全部机械比对：18/18 通过，0 条编造」（会话 356e31e9）。
    guard: /测试|用例|单测|test|spec|pytest|jest|vitest|全绿|绿了/i,
  },
  {
    id: 'build',
    label: '构建/编译成功',
    checkable: true,
    re: /(?:构建|编译|打包|build|compile)[^\n]{0,12}(?:成功|通过|无误|succeed(?:ed)?|success(?:ful)?|passed|(?<![-\w])clean\b)|\bBUILD\s+SUCCESS(?:FUL)?\b|\bcompiled?\s+(?:successfully|without\s+errors?)\b/i,
  },
  {
    id: 'file-count',
    label: 'N 个文件已同步/改动',
    checkable: true,
    re: /\b\d{1,4}\s*(?:个|份|处)?\s*(?:文件|文档|files?\b)[^\n]{0,20}(?:同步|修改|改动|更新|生成|创建|写入|added|changed|updated|created|modified|synced|written)|\b\d{1,4}\s+files?\s+(?:changed|updated|created|modified|synced|written)\b/i,
  },
  {
    id: 'artifact-hash',
    label: '具体 hash / 版本号',
    checkable: true,
    re: /(?:sha256|sha|hash|指纹|checksum|commit)\s*[:：=]?\s*(?:是|为)?\s*`?[0-9a-f]{7,40}\b|\b[0-9a-f]{40}\b/i,
  },
  {
    id: 'todos',
    label: '待办清空 / 全部完成',
    checkable: false,
    re: /(?:没有|无|零|清空)(?:任何)?(?:待办|遗留|剩余任务|未完成项)|\b(?:no\s+(?:remaining\s+)?(?:todos?|tasks?)|nothing\s+left|all\s+(?:tasks?\s+)?(?:done|complete(?:d)?))\b|全部完成|全部做完|收尾完成/i,
  },
  {
    id: 'commit',
    label: '已提交',
    checkable: true,
    re: /(?:已|已经)(?:提交|commit)|\bcommit(?:ted)?\s+(?:as\s+)?`?[0-9a-f]{7,40}\b|\bcommitted\b[^\n]{0,12}[0-9a-f]{7}/i,
  },
  {
    id: 'push-remote',
    label: '已推到远端',
    checkable: true,
    re: /(?:已|已经)(?:推送|push)|推送到远端|推到远端|远端(?:已|都)?(?:同步|更新)|\bpushed\s+to\s+(?:origin|remote|github)\b|\bremote\s+(?:is\s+)?(?:in\s+sync|up\s+to\s+date)\b/i,
  },
  {
    id: 'pr-ci',
    label: 'CI / PR 检查通过',
    checkable: true,
    re: /\bCI\b[^\n]{0,12}(?:通过|绿|passed|green|success)|(?<![-\w])(?:checks?|workflow|流水线|actions|job)(?![-\w])[^\n]{0,12}(?:通过|全绿|绿了|passed|green|success)|\bPR\s*#?\d+[^\n]{0,24}(?:merged|已合并|通过)|\ball\s+\d+\s+checks?\s+passed\b|\bci\s+(?:is\s+)?green\b/i,
  },
  {
    id: 'runtime-probe',
    label: '服务已启动 / 端口在听',
    checkable: true,
    re: /(?:服务|端口|server|port|进程)[^\n]{0,14}(?:已启动|已在监听|正在监听|运行中|listening|is\s+up|started)|\b(?:service|server)\s+(?:started|is\s+running|is\s+up)\b/i,
  },
  {
    id: 'vague-completion',
    label: '笼统的完成声明（无任何指标）',
    checkable: true,
    re: COMPLETION_RE,
    veto: COMPLETION_VETO_RE,
  },
]);

/** 「这句话不是在断言完成」的信号。命中就丢弃该句。
 *
 *  实测必要性：这是最难的一类错误。若不看否定，「我没跑测试」会被 test-count 当成
 *  「它在声称测试通过」，把检测器的结论反着写。 */
export const NEGATION_RE = /(?:没|没有|未|尚未|不曾|并未|从没|无法|不能|不再)[^\n，。；]{0,8}(?:跑|运行|执行|做|测试|验证|提交|推送|推|构建|编译|启动|监听|同步|通过|成功|完成|做完|证据|一致|匹配)|(?:测试|构建|编译|提交|推送|启动|验证|证据|结果|hash|指纹)[^\n，。；]{0,6}(?:没|未|失败|不通过|缺失|不一致|不匹配|有误)|(?:还有|仍有|剩下)[^\n，。；]{0,6}(?:待办|任务|未完成|遗留)|未通过|失败|报错|报失败|回滚|不一致|不匹配|undo|revert|\b(?:not|never|no|nothing|none|without|didn'?t|did\s+not|haven'?t|hasn'?t|wasn'?t|isn'?t|untested|unverified|failed|failure|failing)\b[^.\n]{0,24}\b(?:test|tests|run|ran|build|built|compile|commit|committed|push|pushed|verify|verified|pass|passed|green|start|started|listen|listening|sync)/i;

/** 句尾是问号，或句中有征询措辞 —— 那是在问，不是在报完成。 */
export const INTERROGATIVE_RE = /[？?]\s*$|(?:要不要|是否|需不需要|有没有|用不用)[^\n]{0,20}(?:吗|呢|？|\?)/;

/** 「这一段是不是被假设/条件/间接疑问**管着**」。**按命中片段判，不按整句判。**
 *
 *  实测误报（P1，真语料）：`Whether tests pass matters here.` 被判成 `test-count`，
 *  hook 因此拦了一次本来诚实的会话。`NEGATION_RE` 管不了它 —— 那里既没有否定，
 *  也没有失败的措辞，只有一个**间接疑问**：句子在讨论「测试是否通过」这件事，
 *  而不是断言「测试通过了」。同族形态：`I wonder whether tests pass.`、
 *  `It depends on whether tests pass.`、
 *  `That matters because this task is about whether tests pass`。
 *
 *  中文同族：`测试是否通过还不确定。`、`无论测试是否通过，都要提交。`、
 *  `我要走了，如果测试通过的话。`
 *
 *  为什么必须在**片段级**判、不能简单地给整句加一条 veto：
 *  `我检查了测试是否通过，结果是 18/18 通过。` 前半句是间接疑问、后半句是真断言。
 *  整句否决会把这条真断言一起丢掉 —— 那是拿假阴性换假阳性。所以两个入口：
 *    1. `HYPOTHETICAL_LEAD_RE` / `HYPOTHETICAL_BEFORE_RE`：命中片段本身以假设词开头，
 *       或紧邻的前文是假设词；
 *    2. `test-count` 的桥接段用「剔除式点号」，不许 `是否 / 有没有 / 能否` 插在
 *       名词和动词之间 —— 那样「测试是否通过」根本不会产生命中，后半句的
 *       `18/18 通过` 照旧命中。 */
export const HYPOTHETICAL_LEAD_RE = /^(?:whether(?:\s+or\s+not)?|if|unless|suppose|assuming|无论|不管|不论|如果|假如|倘若|万一|要是|是否|有没有|能否|可否|取决于)/i;
/** 英文倒装疑问：`Does the test pass`（没写问号时也要认出来）。 */
export const INVERSION_QUESTION_RE = /^(?:does|do|did|is|are|was|were|can|could|should|would|will|has|have)\s+\S/i;
/** 「这一子句是不是被假设/条件/间接疑问管着」的标记词。
 *
 *  **按子句判，不按整句判。** 整句判会犯两类错，实测各一例：
 *    - 丢掉真断言：`我检查了测试是否通过，结果是 18/18 通过。` —— 前半句是间接疑问，
 *      后半句是真话。整句否决等于拿假阴性换假阳性。
 *    - 放过假设：`我要走了，如果测试通过的话。` —— 假设词在**后一个**子句里，
 *      而命中在前一个子句。只有把它们放进同一个作用域才判得对。
 *  子句划分沿用 `splitSentences` 之后的那一层：`，` `,` `；` `;` `、`。 */
export const HYPOTHETICAL_MARK_RE = /(?:whether(?:\s+or\s+not)?|\bif\b|unless|suppose|assuming|wonder|depends?\s+on|question\s+(?:is|was)|无论|不管|不论|如果|假如|倘若|万一|要是|是否|有没有|能否|可否|的话)/i;
/** 命中片段**内部**的桥接：`测试是否通过` / `tests, if any, passed`。
 *  子句级判据已经覆盖它，这里保留是因为它更精确 —— 能把
 *  `关于测试是否通过这件事，我已确认全绿。` 的第一个子句判死、第二个子句放行。 */
export const HYPOTHETICAL_BRIDGE_RE = /(?:测试|用例|单测|test(?:s)?|spec|构建|编译|build|compile|推送|提交|commit|push)[^\n]{0,3}?(?:是否|有没有|能否|可否|whether|if)[^\n]{0,6}?(?:通过|成功|绿|passed|pass|succeed|green)/i;

/** 命中所在的子句。子句边界与 `splitSentences` 同源，只是多切一层逗号。 */
export function clauseAt(sentence, index) {
  const s = String(sentence || '');
  const i = Number.isInteger(index) ? index : 0;
  let start = 0;
  for (let k = Math.min(i, s.length) - 1; k >= 0; k--) {
    if ('，,；;、'.includes(s[k])) { start = k + 1; break; }
  }
  let end = s.length;
  for (let k = Math.max(0, i); k < s.length; k++) {
    if ('，,；;、'.includes(s[k])) { end = k; break; }
  }
  return { clause: s.slice(start, end), start, end };
}

/** 这段文本**这一处命中**是不是假设 / 条件 / 间接疑问。
 *
 *  判定作用域是**命中片段末尾所在的那个子句**，不是整句、也不是命中的第一个字符。
 *  两个反例都是实测的：
 *    - `我要走了，如果测试通过的话。` —— 这一族的正则从「我要走了」一路吞到「测试通过」，
 *      按命中**开头**取子句会落在「我要走了」上，看不见后面的「如果」→ 漏拦假设句。
 *    - `Not sure whether it works, but tests pass.` —— 按命中开头取子句会落在
 *      「Not sure whether it works」上，把后面那半句真断言一起否掉。
 *  取末尾子句恰好同时解决这两处：假设词必须在**谓词所在的那个子句**里才算数。 */
export function isHypotheticalMatch(sentence, match) {
  if (!match) return false;
  const text = String(match[0] || '');
  const start = Number.isInteger(match.index) ? match.index : 0;
  const end = start + Math.max(0, text.length - 1);
  const { clause } = clauseAt(sentence, end);
  const scope = clause.trim();
  if (HYPOTHETICAL_LEAD_RE.test(text.trim())) return true;
  if (INVERSION_QUESTION_RE.test(scope)) return true;
  if (HYPOTHETICAL_BRIDGE_RE.test(text)) return true;
  return HYPOTHETICAL_MARK_RE.test(scope);
}

/** 把一条族正则的所有命中都列出来。用于「只要有一处不是假设就算断言」这条判断，
 *  以及让 `isHypotheticalMatch` 能看到**每一处**命中而不是只看第一处。
 *  正则在族表里不带 `g`，这里克隆一份带 `g` 的并缓存，避免每句都重新编译。 */
const GLOBAL_RE_CACHE = new Map();
export function matchesOf(re, sentence) {
  let g = GLOBAL_RE_CACHE.get(re);
  if (!g) {
    g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    GLOBAL_RE_CACHE.set(re, g);
  }
  g.lastIndex = 0;
  const out = [];
  const s = String(sentence || '');
  let m;
  while ((m = g.exec(s))) {
    out.push(m);
    if (m.index === g.lastIndex) g.lastIndex++;
    if (out.length >= 64) break;
  }
  return out;
}

/** 每个断言族的**中文人话名称**。给模型看的文案一律走这里，不许把内部族 ID
 *  （`vague-completion` / `test-count`）拼进句子 —— 模型读到「没有任何 vague-completion
 *  调用」只会困惑，那不是它能执行的指令。 */
export const FAMILY_NAMES = Object.freeze({
  'test-count': '测试通过',
  build: '构建成功',
  'file-count': '文件改动数量',
  'artifact-hash': 'hash / 版本号',
  todos: '待办清空',
  commit: '已提交',
  'push-remote': '已推送',
  'pr-ci': 'CI 通过',
  'runtime-probe': '服务在运行',
  'vague-completion': '「做完了」这类笼统声明',
});

/** 族 ID → 中文名称。**未知族不许把 ID 原样返回**，否则文案里又会混进英文族名；
 *  退回一句通用的人话，让模型至少知道「哪一类话」缺证据。 */
export function familyName(id) {
  return FAMILY_NAMES[id] || '完成性断言';
}

/** 族 ID → 「这一族在找的那种动作」的中文名，用于 `classifyEvidence` 拼 reason。
 *  与 `FAMILY_NAMES` 的区别是语感：族名是名词短语（`测试通过`），这里要能接在
 *  「没有任何 ___ 调用」里，所以是动名词（`测试运行`）。 */
export const ACTIVITY_NAMES = Object.freeze({
  'test-count': '测试运行',
  build: '构建',
  'file-count': '文件写入',
  'artifact-hash': 'hash 比对',
  todos: '待办核对',
  commit: '提交',
  'push-remote': '推送',
  'pr-ci': 'CI 查询',
  'runtime-probe': '探活',
  'vague-completion': '验证',
});

export function activityName(id) {
  return ACTIVITY_NAMES[id] || '相关';
}

/** 「还没发生 / 只是假设 / 在说一种可能性」的句子。命中就不认成断言。
 *
 *  实测误报样本（真语料）：`两种编译通过的实现绕过` 里含「编译通过」，但那是
 *  「可以被绕过的一种写法」，不是「这次构建成功了」。还有 `./build.sh 全量回归 |
 *  后台跑着`，那是进行中。把这类句子当完成声明，会凭空造出 NO_EVIDENCE。 */
export const SPECULATIVE_RE = /^\s*(?:如果|假如|假设|倘若|万一|一旦|若|要是|除非|准备|计划|打算|拟|正在|后台|稍后|接下来|下一步|回头|之后|待|还没|尚未|需要|得先|先|再|请|让|建议|考虑|希望|争取|尽量|等|TODO|未完成|待验证|待确认|待跑|待办)|\b(?:if|unless|suppose|assuming|could|would|might|may|can|will|going\s+to|about\s+to|should|plan(?:ning)?|in\s+progress|pending|not\s+yet|TODO)\b|(?:绕过|规避|欺骗|假阳性|误报|反例|漏洞|隐患|风险|缺陷)|(?:编译|构建|打包)(?:通过|成功)的(?:实现|版本|方案|代码|写法)/i;

/** 引用的内容不是断言：整段 blockquote、fenced code block。
 *  它们通常是「我贴给你的日志/文档」，把里面的 `N/N 测试通过` 当成本会话的完成声明会误判。 */
export const FENCED_CODE_RE = /```[\s\S]*?(?:```|$)/g;
export const BLOCKQUOTE_LINE_RE = /^[ \t]*>[^\n]*$/gm;

// ── 证据命令的模式 ────────────────────────────────────────────────────

// 注意：`/a/ || /b/` 在 JS 里只会留下第一个正则（对象恒真），所以下面把
// 全部判据合成**一个** alternation，不是几个正则用 || 拼起来。
// maven / gradle 的动词可能离可执行文件很远
//（`mvn.cmd -f "D:/很长/路径/pom.xml" clean verify`），需要 160 字的窗口。
export const TEST_CMD_RE = /\b(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|npx\s+(?:jest|vitest)|node\s+--test|bun\s+test|vitest|jest|pytest|python\d?\s+-m\s+(?:pytest|unittest)|go\s+test|cargo\s+test|dotnet\s+test|ctest|phpunit|rspec|bats|make\s+test|run-tests\.(?:sh|ps1)|(?:^|(?:[;&|]|\bthen|\bdo|\bexec|\btime|\bsudo|\bnpx|\bnode|\bsh|\bbash|\bpwsh|\bpowershell)\s+)(?:self-?test|selftest|test-all|run-all|verify-handbook|check-i18n)(?:\.\w+)?\b|mvn(?:w)?(?:\.cmd)?[^\n;&|]{0,160}\b(?:test|verify)\b|gradlew(?:\.bat)?\b[^\n;&|]{0,160}\b(?:test\w*|check\w*)\b|\bgradle\s+[^\n;&|]{0,120}\b(?:test|check)\b)/i;

export const BUILD_CMD_RE = /\b(?:npm\s+run\s+build|pnpm\s+(?:run\s+)?build|yarn\s+(?:run\s+)?build|npx\s+tsc|tsc\b|go\s+build|cargo\s+build|dotnet\s+(?:build|publish)|cmake\s+--build|make\s+(?:all|build|jar|test)|build[\w-]*\.(?:sh|ps1|cmd)|build\.py|mvn(?:w)?(?:\.cmd)?[^\n;&|]{0,160}\b(?:package|install|compile|verify)\b|gradlew(?:\.bat)?\b[^\n;&|]{0,160}\b(?:assemble|build|compile\w+|process\w*Resources)\b)/i;

export const COMMIT_CMD_RE = /\b(?:git|ws-git(?:\.cmd)?)\b[^\n]{0,60}\bcommit\b/i;

/** 这些 git 子命令的输出里也会出现 "commit" 字样，但它们不是提交动作。
 *  在判 commit 证据前先把它们从命令行里挖掉 —— 否则
 *  `git status --short && git add -A && git commit -m x` 会因为含 `git status` 被整条丢掉，
 *  实测这漏掉了本语料里真实存在的提交（会话 2f9f2b39）。 */
export const GIT_READONLY_RE = /\bgit\s+(?:log|show|status|diff|config|rev-parse|branch|remote)\b[^\n;&|]*/g;

/** push 不只看 `git push`：这个语料里有 `./ws-git.cmd push`、`gh repo sync` 这类包装。 */
/** push 必须是 git 的**子命令**，不能是提交信息里的一个词。
 *  实测误报：`git commit -m "fix: 不要 push 到 main"` 被当成了 push，
 *  让 84419879 的「已推送」拿到 3 次根本不存在的成功证据。
 *  所以这里只允许 `git <flag>* push` 这种紧邻结构，中间不许隔任意文本。 */
export const PUSH_CMD_RE = /\b(?:git|ws-git(?:\.cmd)?)\s+(?:-[cC]\s+\S+\s+)*(?:-\S+\s+)*push\b|\bgh\s+repo\s+sync\b/i;

export const CI_CMD_RE = /\bgh\s+(?:pr\s+checks|run\s+(?:list|view|watch)|workflow\s+(?:run|view))\b|\bglab\s+ci\b|\bactions\/|\bgh\s+api\b[^\n]{0,80}(?:check-runs|actions\/runs)/i;

/** 本机特有的「CI 等价物」：仓库自己的同步/一致性脚本。`check-sync` 这类命令
 *  不是 CI 服务，但它对「两仓一致」这个断言是**直接证据**，把它排除在外只会制造假 NO_EVIDENCE。 */
export const SYNC_CHECK_CMD_RE = /\b(?:check-sync|sync-check|check-i18n|verify-handbook|validate-links)\b/i;

export const RUNTIME_CMD_RE = /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|Test-NetConnection|netstat|lsof\s+-i|ss\s+-lnt?p?|nc\s+-z|npm\s+start|node\s+\S*server|python\d?\s+-m\s+http\.server|tasklist|Get-Process)\b/i;

/** 输出里出现这些，说明命令**失败**，哪怕 is_error 是 false（很多 runner 失败也退 0）。
 *
 *  刻意不收裸 `\bFAILED\b`：成功输出里常有 `0 FAILED`、`failures 0`，收进来会把
 *  一次成功的测试判成 FAILED_ONLY。 */
// 「N failures」只有在 N > 0 时才是失败。旧正则 `\b[1-9]\d*\s+(?:failing|failed|failures?|errors?)\b`
// 会把 `tests=29 failures=0` 里的「29 failures」读成 29 个失败（实测 36b92630），
// 让一次真的 BUILD SUCCESS 被记成失败调用。加 `(?![=\s]*0\b)` 让「=0 / : 0 / 0 个」不算。
// 「0 failed」「0 个失败」本来就不匹配（前面是 0 不是 [1-9]），保持原样。
export const FAIL_OUTPUT_RE = /\bBUILD\s+FAILURE\b|\b[1-9]\d*\s+(?:failing|failed|failures?|errors?)\b(?![=:\s]*0\b)|\bFAIL(?:ED|URE)\b[:\s!]|\bTests?\s+run:\s*\d+,\s*Failures:\s*[1-9]|npm\s+ERR!|Traceback\s+\(most\s+recent\s+call|error\s+TS\d+|exit\s+code\s+[1-9]|Command\s+failed/i;

/** git commit 成功的形态：`[main abc1234] msg` 或 `create mode`。 */
export const COMMIT_OK_RE = /\[[^\]\n]{1,60}\s+[0-9a-f]{7,40}\]|\bcreate\s+mode\b|\b\d+\s+files?\s+changed\b/i;
/** git push 成功的形态：`abc..def  main -> main` 或 `Everything up-to-date`。
 *  `[rejected]` / `!` 开头的行是失败，要排除 —— 它同样含 `->`。 */
export const PUSH_OK_RE = /Everything\s+up-to-date|up\s+to\s+date|^\s*[0-9a-f.]+\.\.[0-9a-f.]+\s+\S+\s+->\s+\S+/im;
export const PUSH_REJECT_RE = /\[rejected\]|rejected\s|error:\s*failed\s+to\s+push|non-fast-forward|fetch\s+first/i;

/** 这条命令是不是「跳过测试的构建」。`mvn package -DskipTests` 里也有 "Tests" 字样，
 *  但它是**故意不跑测试**——把它当测试证据是本检测器最讽刺的一种误判。 */
export const SKIP_TESTS_RE = /-DskipTests\b|-Dmaven\.test\.skip\b|--skip-tests\b|-x\s+test\b|--no-run\b/i;

/** 把一条 shell 命令归一成「它实际执行了什么」，再去匹配测试/构建动词。
 *
 *  为什么必须做：实测两类假阳性都来自**命令里的文本而不是命令本身**——
 *  - `echo "=== gradlew.bat 使用 ==="`（只是打印一个标题，没跑 gradle）
 *  - `cat > run-tests.sh <<'EOF' ... EOF`（在**写**一个脚本，没执行它）
 *  归一化做三件事：剥掉 heredoc 正文、剥掉 echo/printf 的实参、把引号里的路径
 *  压成 basename（`"<sdk>/bin/mvn.cmd"` → `mvn.cmd`，保留可执行名，丢掉很长的前缀）。
 */
export function normalizeCommand(cmd) {
  let s = String(cmd || '');
  // 1. 剥 heredoc 正文（`<<'EOF' ... EOF` / `<<-"EOF"`）
  s = s.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, ' ');
  // 2. 剥 echo / printf 的实参（到下一个分隔符为止）
  s = s.replace(/(?:^|[;&|]\s*)(?:echo|Write-Output|printf)\b[^;&|\n]*/g, ' ');
  // 3. 引号里如果是**路径**，压成 basename（保留可执行名，丢掉很长的本机路径）；
  //    如果不是路径（比如 `powershell -Command "npm test"` 里的命令串），原样保留 ——
  //    把它一起挖掉会制造假的 NO_EVIDENCE。
  s = s.replace(/"([^"\n]*)"|'([^'\n]*)'/g, (_m, a, b) => {
    const v = String(a ?? b ?? '');
    if (!/[\\/]/.test(v)) return ` ${v} `;
    const base = v.split(/[\\/]/).filter(Boolean).pop() || '';
    return base ? ` ${base} ` : ' ';
  });
  return s.replace(/\s+/g, ' ');
}

/** 这条命令是不是真的跑了测试（排除 skip-tests 的构建）。 */
export function isTestCommand(cmd) {
  const c = normalizeCommand(cmd);
  if (!TEST_CMD_RE.test(c)) return false;
  if (SKIP_TESTS_RE.test(c)) return false;
  return true;
}

/** 这条命令是不是真的构建了。 */
export function isBuildCommand(cmd) {
  const c = normalizeCommand(cmd);
  return BUILD_CMD_RE.test(c);
}

/** 「任何形式的检查」：跑过测试、构建、lint、类型检查、语法检查，都算。
 *
 *  为什么 `vague-completion` 用这个而不是单个 `TEST_CMD_RE`：说「修好了」的人
 *  只要**做过一次检查**，这话就有了最低限度的支撑 —— 他可能是跑了 lint、
 *  `node --check`、`npx tsc --noEmit`，或者手工 `curl` 了一下。
 *  本族要抓的是「一次检查都没做」，不是「没跑我以为该跑的那个测试」。
 *  把标准定成「必须跑测试」会让几乎每个纯前端/纯文档会话都被拦，
 *  而那正是本族最需要避开的误伤。
 *
 *  刻意**不收**的：`ls` / `cat` / `grep` / `git status` / `git diff` 这类**只读观测**。
 *  它们能证明「文件存在」，不能证明「改动有效」。把它们算成验证，本族就形同虚设 ——
 *  任何会话都会有一堆 Read/Bash 观测，于是永远 SUPPORTED。 */
export const VERIFY_CMD_RE = /\b(?:npm\s+(?:run\s+)?(?:test|build|lint)|pnpm\s+(?:run\s+)?(?:test|build|lint)|yarn\s+(?:run\s+)?(?:test|build|lint)|npx\s+(?:jest|vitest|tsc|eslint)|node\s+--test|node\s+--check|node\s+-c\b|bun\s+test|vitest|jest|pytest|python\d?\s+-m\s+(?:pytest|unittest|py_compile)|go\s+(?:test|build|vet)|cargo\s+(?:test|build|check|clippy)|dotnet\s+(?:test|build)|ctest|phpunit|rspec|bats|make\s+(?:test|check|all|build)|tsc\b|eslint|ruff|flake8|mypy|pylint|golangci-lint|shellcheck|mvn(?:w)?(?:\.cmd)?[^\n;&|]{0,160}\b(?:test|verify|package|compile|install)\b|gradlew(?:\.bat)?\b[^\n;&|]{0,160}\b(?:test\w*|check\w*|assemble|build|compile\w*)\b|\bgradle\s+[^\n;&|]{0,120}\b(?:test|check|build)\b|(?:self-?test|selftest|test-all|run-all|verify-handbook|check-i18n|check-structure|check-sync|validate-links|build[\w-]*\.(?:sh|ps1|cmd)|run-tests\.(?:sh|ps1)|check[\w-]*\.(?:sh|ps1|mjs|js))\b)/i;

/** 这条命令是不是「做过某种检查」。skip-tests 的构建不算 —— 它恰好什么都没验证。 */
export function isVerificationCommand(cmd) {
  const c = normalizeCommand(cmd);
  if (!VERIFY_CMD_RE.test(c)) return false;
  if (SKIP_TESTS_RE.test(c)) return false;
  return true;
}

/** 源码类扩展名。**只有它们会作废「测试通过」**——改一份 CHANGELOG.md 不会让昨天
 *  的测试结果失效，但很多会话最后一步恰恰是写文档，若不区分，STALE_ONLY 会虚高。
 *  实测：52ea643c 最后一次真编辑是 `pom.xml` 之后又跑了 mvn verify；而很多会话
 *  最后一步是 `Edit CHANGELOG.md`，把测试判成 STALE 是冤枉的。 */
export const CODE_EXTS = Object.freeze([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'java', 'kt', 'kts', 'py', 'go', 'rs',
  'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'scala', 'swift', 'sh', 'ps1',
  'gradle', 'xml', 'toml', 'lock', 'sql',
]);
export const DOC_EXTS = Object.freeze(['md', 'markdown', 'txt', 'rst', 'adoc', 'log']);

/** 仓库配置点文件：改它们不改变被测代码的行为，因而不作废已跑过的测试。
 *  它们的「扩展名」其实是文件名的一部分（`.gitignore` → `gitignore`），
 *  不加这一条就会落到 `unknown`，而 `unknown` 在时间线里被当成源码改动 ——
 *  实测把一次真的 SUPPORTED 判成了 STALE_ONLY（会话 9daa6a00 的 `.gitignore`）。 */
export const NON_SOURCE_FILES = Object.freeze([
  '.gitignore', '.gitattributes', '.gitmodules', '.gitkeep', '.editorconfig',
  '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc', '.eslintignore', '.dockerignore',
  '.mailmap', '.git-blame-ignore-revs',
]);

/** 按路径判它是源码还是文档。无扩展名（如 Makefile）当源码。 */
export function editKindOf(path) {
  const p = String(path || '');
  if (!p) return 'unknown';
  const base = p.toLowerCase().split(/[\\/]/).pop();
  if (NON_SOURCE_FILES.includes(base)) return 'doc';
  const m = base.match(/\.([a-z0-9]+)$/);
  if (!m) return 'code';
  const ext = m[1];
  if (DOC_EXTS.includes(ext)) return 'doc';
  if (CODE_EXTS.includes(ext)) return 'code';
  return 'unknown';
}

/** 用 shell 写文件的命令。语料里大量会话不用 Edit 工具，而是 `sed -i` / `cat >` / `git apply`。
 *  它们同样是「改动了工作区」，必须进时间线 —— 否则 lastEditIndex 停在 -1，
 *  所有历史测试证据都会被判成「在最后一次编辑之后」，STALE_ONLY 永远判不出来。
 *
 *  噪声控制（每一条都是实测踩出来的）：
 *  - `cp a.jar /tmp/`、`rm -rf .ci-artifacts`、`cat > /tmp/msg.txt` 都是**产物搬运**，
 *    不是源码改动。把它们算进时间线，会让几乎所有会话都变成 STALE_ONLY。
 *  - 只认**明确写文件**的动作：sed -i / perl -i / git apply / patch / checkout -- /
 *    restore / 重定向到非临时路径 / 从 /tmp 还原。
 */
export const BASH_MUTATION_RE = /(?:^|[\s;&|(])(?:sed\s+-i|perl\s+-i|patch\s+(?:-p\d+\s+)?\S|git\s+apply\b|git\s+checkout\s+--|git\s+restore\b|tee\s|cat\s*>>?\s|cp\s|mv\s)|[^0-9&>]>>?\s*[^\s&|]/i;

/** 临时区 / 产物区。写到这里的目标不算工作区改动。 */
const TEMP_TARGET_RE = /^(?:\/tmp\/|\/var\/tmp\/|\/dev\/|\.ci-artifacts|\.win-pkg|dist\/|target\/|build\/|output\/|\.work\/|backups?\/|versions\/)/i;

/** 提取 `cp`/`mv`/`>` 的目标路径，用于判定目标是不是临时区。 */
function mutationTargets(cmd) {
  const s = String(cmd || '');
  const targets = [];
  for (const m of s.matchAll(/(?:>>?|tee\s+)\s*("[^"]+"|'[^']+'|\S+)/g)) targets.push(m[1]);
  for (const m of s.matchAll(/(?:^|[\s;&|(])(?:cp|mv)\s+(?:-\S+\s+)*("[^"]+"|'[^']+'|\S+)\s+("[^"]+"|'[^']+'|\S+)/g)) targets.push(m[2]);
  return targets.map((t) => t.replace(/^["']|["']$/g, ''));
}

/** shell 写入的目标里有没有源码、有没有文档。用来给 shell 编辑定 kind。 */
function mutationKinds(cmd) {
  const c = String(cmd || '');
  // 这几类命令天生就是「按路径改仓库文件」，不必解析目标：看它打到的路径是不是源码。
  const direct = /(?:^|[\s;&|(])(?:sed\s+-i|perl\s+-i|git\s+apply\b|git\s+checkout\s+--|git\s+restore\b|patch\s+(?:-\S+\s+)*\S)/i.test(c);
  const raw = direct ? [...mutationTargets(c), ...c.split(/\s+/)] : mutationTargets(c);
  const kinds = new Set();
  for (const t of raw) {
    const clean = String(t).replace(/^["']|["']$/g, '');
    if (!clean || TEMP_TARGET_RE.test(clean)) continue;
    if (!/\.[a-z0-9]+$/i.test(clean)) continue;
    kinds.add(editKindOf(clean));
  }
  return kinds;
}

/** shell 编辑的 kind：**有已知源码扩展名才算源码**。
 *
 *  早先这里写的是 `/\.(?:[a-z0-9]+)\b/i.test(cmd) ? 'unknown' : 'code'` —— 那个三元式
 *  两边都不会给出 `'doc'`，而时间线把「不是 doc」一律当源码，于是**任何**被
 *  `isMutatingCommand` 放行的 shell 写入（包括 `cp *.jar backups/`、`cp a.md b.md`）
 *  都会作废掉之前的测试证据。实测把两次真的 SUPPORTED 判成 STALE_ONLY
 *  （bdf7a413 的 jar 归档、9daa6a00 的 .gitignore）。判不出来时按文档处理：
 *  宁可少报一次「证据过期」，也不要冤枉一次「测试确实跑在改动之后」。 */
function shellEditKind(cmd) {
  const kinds = mutationKinds(cmd);
  if (kinds.has('code')) return 'code';
  return 'doc';
}

/** 这条 shell 命令是否改动了**工作区里的源码/文档**。
 *
 *  判据刻意收紧到「目标路径带已知源码/文档扩展名」。早先只要求「目标不出现在
 *  临时区且带扩展名」，结果 `cp *.jar backups/...` 这类产物归档被当成源码改动，
 *  把一次真的 SUPPORTED 判成了 STALE_ONLY（实测：bdf7a413 的 `cp versions/*.jar`）。 */
export function isMutatingCommand(cmd) {
  const c = String(cmd || '');
  // 这几类命令天生就是「按路径改仓库文件」，不必解析目标：只看它打到的路径是不是源码。
  const direct = /(?:^|[\s;&|(])(?:sed\s+-i|perl\s+-i|git\s+apply\b|git\s+checkout\s+--|git\s+restore\b|patch\s+(?:-\S+\s+)*\S)/i.test(c);
  const targets = mutationTargets(c);
  const extOf = (t) => {
    const m = t.toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  };
  const isSourcey = (t) => {
    const e = extOf(t);
    return Boolean(e) && (CODE_EXTS.includes(e) || DOC_EXTS.includes(e));
  };
  if (direct) {
    // `sed -i ... src/A.java` / `git apply ../x.patch`：看命令里出现的路径里有没有源码
    return [...targets, ...c.split(/\s+/)].some((t) => isSourcey(t.replace(/^["']|["']$/g, '')));
  }
  if (!BASH_MUTATION_RE.test(c)) return false;
  if (!targets.length) return false;
  return targets.some((t) => !TEMP_TARGET_RE.test(t) && isSourcey(t));
}

// ── 文本处理 ──────────────────────────────────────────────────────────

/** 切句用的分隔符。切点**紧跟在**句末标点之后，或吃掉一整段换行。
 *
 *  单独提出来是因为切句现在要同时给出「每句在文本里的 `[start, end)`」，
 *  而那需要一个能自己走位置的分割器（见 `splitSentenceSpans`）。 */
const SENTENCE_SPLIT_RE = /(?<=[。！？!?；;])|\n+/;

/** 这一趟剥离：把 `text` 里所有 `re` 的命中换成 `makeOut(m)` 的结果，
 *  同时把输入的下标映射（`map`）原样搬到输出上。
 *
 *  早先这里是三条 `String.replace`，能得出正确的清洗结果，但**丢掉了「这段清洗后
 *  的文本对应原文哪一段」**。展示层需要后者：`quote` 必须是用户/AI 真正写下的话，
 *  不能是检测器内部清洗过的样子。 */
function applyStrip(text, map, re, makeOut) {
  const out = [];
  const outMap = [];
  const spans = [];
  let last = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    for (let i = last; i < start; i++) { out.push(text[i]); outMap.push(map[i]); }
    const repl = makeOut(m);
    // 每个被替换的字都指向该区段的起点：清洗后的文本里它只占一格，但原文里它
    // 可能是几十个字。截断与还原都以「区段起点」为准才不会切出半截引用。
    for (let k = 0; k < repl.length; k++) { out.push(repl[k]); outMap.push(map[start]); }
    if (m[0].length === 0) re.lastIndex++;  // 零宽命中：兜底推进，否则死循环
    if (end > start) spans.push([map[start], map[end - 1] + 1]);
    last = end;
  }
  for (let i = last; i < text.length; i++) { out.push(text[i]); outMap.push(map[i]); }
  return { text: out.join(''), map: outMap, spans };
}

/** 去掉 fenced code block、blockquote 与行内代码。
 *
 *  返回 `{ text, strippedCode, strippedQuote, map, codeSpans }`：
 *    - `text`：清洗后的文本，**检测只在这一份上做**；
 *    - `map[i]`：`text[i]` 在**原文**里的下标（严格递增）；
 *    - `codeSpans`：每个被挖掉的行内代码在原文里的 `[start, end)`。
 *
 *  为什么清洗本身不能去掉：行内代码（`./gradlew test`、`git commit -m ...`）是命令/
 *  标识符，不是完成声明。实测误报样本：「两种编译通过的实现绕过」里的 `if(false)`
 *  让 build 族命中；把反引号内容整段挖掉，这类噪声才不会变成断言。
 *
 *  为什么必须同时给出 `map`：`detectClaims` 展示的 `quote` 曾经直接取清洗后的句子，
 *  于是原话里的路径 / 文件名 / 目录被替换成空格，输出成了
 *  「正式版导出只剩  。」—— 「AI 说了什么」被检测器的实现细节改写，
 *  而这正是本模块的核心卖点。检测仍走 `text`，展示走 `map` 还原出的原文。 */
export function stripQuoted(text) {
  const src = String(text || '');
  let strippedCode = 0, strippedQuote = 0;
  let map = new Array(src.length);
  for (let i = 0; i < src.length; i++) map[i] = i;
  let cur = src;

  const a = applyStrip(cur, map, FENCED_CODE_RE, () => { strippedCode++; return '\n'; });
  cur = a.text; map = a.map;
  const b = applyStrip(cur, map, BLOCKQUOTE_LINE_RE, () => { strippedQuote++; return ''; });
  cur = b.text; map = b.map;
  // 行内代码用模块级的这一份（带 g），建在手边是为了不与并发调用共享 lastIndex。
  const c = applyStrip(cur, map, /`[^`\n]*`/g, () => ' ');
  return {
    text: c.text,
    strippedCode,
    strippedQuote,
    map: c.map,
    codeSpans: c.spans,
  };
}

/** 切句，并给出每句在 `text` 里的 `[start, end)`。
 *
 *  切法与 `String.split(SENTENCE_SPLIT_RE)` 逐字节等价：这里借 `split` 的捕获组拿到
 *  分隔符本身，再按「段 + 分隔符」交替走位置。分隔符**不进**任何区间 ——
 *  句号、换行在 `quote` 里本来就不出现（旧行为如此，改动不扩大它）。
 *
 *  返回的 `text` 是 `trim()` 之后的句子，`start` / `end` 已经跟上 trim 的偏移，
 *  所以直接拿 `text.slice(start, end)` 就是这一句。 */
export function splitSentenceSpans(text) {
  const s = String(text || '');
  const parts = s.split(new RegExp('(' + SENTENCE_SPLIT_RE.source + ')'));
  const out = [];
  let pos = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const raw = parts[i];
    const base = pos;
    pos += raw.length;
    if (i + 1 < parts.length) pos += parts[i + 1].length;
    const trimmed = raw.trim();
    if (trimmed.length < 2) continue;
    const lead = raw.length - raw.replace(/^\s+/, '').length;
    out.push({ text: trimmed, start: base + lead, end: base + lead + trimmed.length });
  }
  return out;
}

/** 切句。分隔符本身被丢弃，所以「问号收尾」要在切之前记下来。 */
export function splitSentences(text) {
  return splitSentenceSpans(text).map((s) => s.text);
}

/** 取一段原话并截到 160 字（超长时是 157 + `…`），**不切半个行内代码**。
 *
 *  只切前半截会让「`npm run test -- --grep foo` 全绿」变成
 *  「`npm run test -- --grep fo…」—— 那是一条无法核对的原话。命中区间时退到反引号前面。 */
export function truncateQuote(quote, spans = [], limit = 160) {
  const q = String(quote || '');
  if (q.length <= limit) return q;
  let cut = limit - 3;
  for (const [a, b] of spans) {
    // `a > 0` 是必要的：区间从第 0 格开始时退到 0 会得到一句只有 `…` 的「原话」，
    // 那比切半个反引号更没用。
    if (a > 0 && a < cut && cut < b) { cut = a; break; }
  }
  return q.slice(0, Math.max(0, cut)) + '…';
}

/** 这一段是不是「否定/失败」陈述。 */
export function isNegated(segment) {
  return NEGATION_RE.test(String(segment || ''));
}

/** 这一段是不是提问（不是在报完成）。 */
export function isInterrogative(segment) {
  return INTERROGATIVE_RE.test(String(segment || ''));
}

/** 这一段是不是「还没发生 / 只是假设 / 在说可能性」。 */
export function isSpeculative(segment) {
  return SPECULATIVE_RE.test(String(segment || ''));
}

/** 一句话在**原文**里的区间。`faithful=false` 表示还原失败，调用方该退回 cleaned 句子。
 *
 *  判据用「原文区间里有没有换行」而不是「长度比」：`stripQuoted` 的两次替换
 *  **都保留换行**（fenced → `\n`，blockquote 只删行内内容、行尾的 `\n` 还在），
 *  而行内代码 `[^`\n]*` 本身不含换行。所以「一句 cleaned 文本的原文区间不含换行」
 *  是**恒真的结构不变量**，一旦被破坏就说明剥离规则与切句对不上了。
 *  实测 210,956 句真实语料，误报 0。
 *
 *  刻意**不**用「原文区间 > cleaned 句子长度 × 8」（最初的设想）：那条在真实语料上
 *  误报 1,526 次 —— 一句里塞几个绝对路径（`- \`skill/.../index.ts:168\` —`）比例能到
 *  51 倍，那是**正常的行内代码**，退回去等于把它们重新挖空。阈值型判据在这里注定
 *  两边不讨好。
 *
 *  抽成导出函数是为了让「退化」这条分支能被直接测到：它由构造保证**不会**在真实
 *  输入上触发，所以只能对着函数本身验，否则那段保险就是死代码。 */
export function quoteRangeOf(src, seg, map) {
  const from = map && Number.isInteger(seg.start) ? map[seg.start] : undefined;
  const to = map && Number.isInteger(seg.end) ? map[seg.end - 1] + 1 : undefined;
  const faithful = Number.isInteger(from) && Number.isInteger(to) && to > from
    && !String(src).slice(from, to).includes('\n');
  return { from, to, faithful };
}

/**
 * 从最后一条 assistant 文本里认出可核对的完成性断言。
 *
 * 返回 `[{ family, familyLabel, checkable, quote, index }]`，同一句里命中同一族只记一条。
 * 不做去重聚合：同一族出现两句不同的原话时，两句都要留 —— 逐条核对才有意义。
 *
 * **检测与展示走两份文本。** 检测在 `stripQuoted()` 的 `text`（已挖掉行内代码 /
 * 代码块 / 引用块）上做，一字不改；`quote` 则用 `map` 还原出这一句在**原文**里的区间。
 * 早先两者是同一条字符串，后果是原话里的路径、文件名、目录被替换成空格 ——
 * 输出成了「正式版导出只剩  。」。那不是 AI 说的话，是检测器实现细节的泄漏，
 * 而「AI 说了什么」正是本模块要摆到台面上的东西。
 *
 * 切句时句末标点（`。！？；`）留在句子尾部，与被切分处**之后**的换行一起被丢掉 ——
 * 与旧 `splitSentences` 完全一致，所以 `quote` 除了补回被挖空的内容，形状不变。
 */
export function detectClaims(text, stats = null) {
  const src = String(text || '');
  const { text: cleaned, map, codeSpans } = stripQuoted(src);
  const out = [];
  for (const seg of splitSentenceSpans(cleaned)) {
    const sentence = seg.text;
    if (isNegated(sentence)) continue;
    if (isInterrogative(sentence)) continue;
    if (isSpeculative(sentence)) continue;
    // 句子在原文里的区间。说明与取舍见 `quoteRangeOf`。
    const { from, to, faithful } = quoteRangeOf(src, seg, map);
    if (!faithful && stats) stats.quoteFallbacks = (stats.quoteFallbacks || 0) + 1;
    const quoteText = faithful ? src.slice(from, to) : sentence;
    // 行内代码区间换算到 quoteText 自己的坐标，供截断时避免切半个反引号。
    const quoteSpans = faithful
      ? codeSpans.filter(([a, b]) => a >= from && b <= to).map(([a, b]) => [a - from, b - from])
      : [];
    for (const fam of CLAIM_FAMILIES) {
      if (!fam.re.test(sentence)) continue;
      if (fam.guard && !fam.guard.test(sentence)) continue;
      // 族自己的否决条件（`veto`）。目前只有 vague-completion 用：它要挡的是
      // 「部分完成」这类跨子句的结构，句子级的 NEGATION_RE 看不出来。
      if (fam.veto && fam.veto.test(sentence)) continue;
      // 假设 / 条件 / 间接疑问。**逐处命中判**，不是整句否决：
      // `我检查了测试是否通过，结果是 18/18 通过。` 前半句是间接疑问，
      // 后半句是真断言 —— 整句否掉就丢了真的那一半。
      // 只在「每一处命中都被假设词管着」时才丢弃这一族。
      const hits = matchesOf(fam.re, sentence);
      if (hits.length && hits.every((m) => isHypotheticalMatch(sentence, m))) continue;
      out.push({
        family: fam.id,
        familyLabel: fam.label,
        checkable: fam.checkable,
        quote: truncateQuote(quoteText, quoteSpans, 160),
        index: out.length,
      });
    }
  }
  return out;
}

// ── 读取 ──────────────────────────────────────────────────────────────

/** 按偏移读一段。不整读文件——最大的单个 transcript 有 117 MB。 */
export function readSlice(path, offset, length) {
  let size;
  try { size = statSync(path).size; } catch { return { text: '', truncated: false, size: 0 }; }
  const n = Math.max(0, Math.min(length, size - offset));
  if (n <= 0) return { text: '', truncated: false, size };
  const buf = Buffer.allocUnsafe(n);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, n, offset); } finally { closeSync(fd); }
  return { text: buf.toString('utf8'), truncated: n < size, size };
}

/** 解析 JSONL。坏行丢弃 —— 一条坏行不该让整个会话判不了。 */
export function parseLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 截断或坏行 */ }
  }
  return out;
}

/** 读尾部记录（末行可能是半条，要按行边界裁）。 */
export function readTailRecords(path, maxBytes = CLAIM_TAIL_BYTES) {
  let size;
  try { size = statSync(path).size; } catch { return { records: [], truncated: false, size: 0 }; }
  const offset = Math.max(0, size - maxBytes);
  const { text, truncated } = readSlice(path, offset, maxBytes);
  const body = truncated ? text.slice(text.indexOf('\n') + 1) : text;
  return { records: parseLines(body), truncated, size };
}

/**
 * 有界回溯读。steps 是「读尾部多少字节」的递增序列，一旦 `enough(records)` 为真就停。
 *
 * 返回 `{ records, bytesRead, windowBytes, truncated, size }`。`truncated` 只表示
 * 「窗口没覆盖到文件开头」，**不代表会话被截断**。判 UNKNOWN 的唯一依据是它。
 */
export function readBack(path, { steps = BACKTRACK_STEPS, enough = null } = {}) {
  let size;
  try { size = statSync(path).size; } catch { return { records: [], bytesRead: 0, windowBytes: 0, truncated: false, size: 0 }; }
  let bytesRead = 0, last = null;
  for (const step of steps) {
    if (step >= size) {
      // 这一步就能读完整个文件，别再多读一遍
      const r = readTailRecords(path, size);
      bytesRead += size;
      last = { records: r.records, windowBytes: size, truncated: false, size };
      if (!enough || enough(last.records)) return { ...last, bytesRead };
      return { ...last, bytesRead };
    }
    const r = readTailRecords(path, step);
    bytesRead += step;
    last = { records: r.records, windowBytes: step, truncated: true, size };
    if (enough && enough(last.records)) return { ...last, bytesRead };
  }
  return { ...last, bytesRead };
}

/** 一条会话的最后一条 assistant 文本。找不到时 text 为空串。 */
export function lastAssistantText(records) {
  const arr = Array.isArray(records) ? records : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const rec = arr[i];
    if (!rec || rec.type !== 'assistant') continue;
    const blocks = Array.isArray(rec.message && rec.message.content) ? rec.message.content : [];
    const text = blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('').trim();
    if (text) return text;
  }
  return '';
}

// ── 证据索引 ──────────────────────────────────────────────────────────

const INDEX_CACHE = new WeakMap();

/** 字符串化 tool_result 的内容（可能是 string，也可能是 block 数组）。 */
export function resultText(block) {
  if (!block) return '';
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((x) => (typeof x === 'string' ? x : String((x && (x.text || x.content)) || ''))).join('\n');
  }
  if (c && typeof c === 'object') return String(c.text || c.content || JSON.stringify(c));
  return '';
}

/**
 * 一遍扫完记录，建出所有族都要用的索引。
 *
 * 记录顺序就是时间顺序（transcript 是追加写的），所以下标即时间。这一点是整个
 * STALE_ONLY 判定的基础：不需要时间戳，只需要「谁在后」。
 */
export function buildEvidenceIndex(records) {
  const arr = Array.isArray(records) ? records : [];
  const cached = INDEX_CACHE.get(arr);
  if (cached) return cached;

  const pending = new Map();       // tool_use_id -> { name, cmd, index }
  const shell = [];                // { index, name, cmd, ok, output }
  const edits = [];                // { index, name, path }
  const writes = new Map();        // path -> index（首次出现）
  const resultTexts = [];          // { index, text } —— artifact-hash 用

  for (let i = 0; i < arr.length; i++) {
    const rec = arr[i];
    if (!rec) continue;
    if (rec.type === 'assistant') {
      const blocks = Array.isArray(rec.message && rec.message.content) ? rec.message.content : [];
      for (const b of blocks) {
        if (!b || b.type !== 'tool_use') continue;
        const name = String(b.name || '');
        const input = b.input || {};
        const cmd = String(input.command || input.cmd || '');
        pending.set(b.id, { name, cmd, index: i });
        if (EDIT_TOOLS.includes(name)) {
          const p = String(input.file_path || input.path || input.notebook_path || '');
          edits.push({ index: i, name, path: p, kind: editKindOf(p) });
          if (p && !writes.has(p)) writes.set(p, i);
        }
      }
    } else if (rec.type === 'user') {
      const blocks = Array.isArray(rec.message && rec.message.content) ? rec.message.content : [];
      for (const b of blocks) {
        if (!b || b.type !== 'tool_result') continue;
        const use = pending.get(b.tool_use_id);
        if (!use) continue;
        const text = resultText(b);
        resultTexts.push({ index: use.index, text });
        if (SHELL_TOOLS.includes(use.name) || use.cmd) {
          const err = b.is_error === true;
          // 「丢到后台去了」不等于成功。实测：`bash ./build.sh -o clean test` 被 Bash 工具
          // 转成后台任务（结果里只有 "Command running in background with ID"），前台没有任何
          // 退出码，把它算成一次成功测试就是本检测器自己说谎。
          const backgrounded = /running in background with ID|Output is being written to/i.test(text);
          const ok = !err && !backgrounded && !FAIL_OUTPUT_RE.test(text);
          shell.push({ index: use.index, name: use.name, cmd: use.cmd, ok, error: err, backgrounded, output: text });
          // shell 命令也可能改动工作区（sed -i / cp / patch / git apply）。
          // 它们计入时间线，否则「编辑后有没有重跑」根本无从判断。
          // kind 必须按**实际写入的目标**判：写 .jar / .md / .gitignore 不作废测试证据。
          if (ok && isMutatingCommand(use.cmd)) {
            edits.push({ index: use.index, name: use.name, path: '', via: 'shell', kind: shellEditKind(use.cmd) });
          }
        }
        pending.delete(b.tool_use_id);
      }
    }
  }

  // 最后一次**源码**改动：时间线上最靠后的那个。改文档不算作废测试证据。
  // 没有源码改动时退回到「任何改动」再退回到 -1。
  let lastEditIndex = -1, lastCodeIndex = -1;
  for (const e of edits) {
    if (e.index > lastEditIndex) lastEditIndex = e.index;
    if (e.kind !== 'doc' && e.index > lastCodeIndex) lastCodeIndex = e.index;
  }

  const idx = { shell, edits, writes, resultTexts, lastEditIndex, lastCodeIndex, records: arr };
  INDEX_CACHE.set(arr, idx);
  return idx;
}

/** 在 shell 调用里按命令模式筛出「本族的尝试」。 */
function attempts(index, re) {
  return index.shell.filter((c) => re.test(c.cmd));
}

/** 本族相关的尝试（已应用 skip-tests 之类的语义过滤）。 */
function attemptsOf(index, family) {
  if (family === 'test-count') return index.shell.filter((c) => isTestCommand(c.cmd));
  if (family === 'build') return index.shell.filter((c) => isBuildCommand(c.cmd));
  if (family === 'vague-completion') return index.shell.filter((c) => isVerificationCommand(c.cmd));
  return attempts(index, {
    'commit': COMMIT_CMD_RE, 'push-remote': PUSH_CMD_RE,
    'pr-ci': CI_CMD_RE, 'runtime-probe': RUNTIME_CMD_RE,
  }[family] || /$^/);
}

/** 对某族断言找证据。返回结构化结果，不下结论（结论在 classifyEvidence 里）。 */
export function findEvidence(records, claim) {
  const index = buildEvidenceIndex(records);
  const family = typeof claim === 'string' ? claim : (claim && claim.family) || '';
  // 「最后一次编辑」口径：**只算源码类改动**（`lastCodeIndex`）。改一份 CHANGELOG/README
  // 不会让刚才的测试结果失效，若把它算进来，几乎每个会话都会变成 STALE_ONLY。
  //
  // 窗口被截断时 lastCodeIndex 为 -1 是安全的：任何更早的源码改动都在**窗口内成功证据
  // 之前**，不影响「证据之后有没有改动」这个判断。窗口是文件后缀，这点由 readBack 保证。
  const lastEditIndex = index.lastCodeIndex;
  const base = { family, lastEditIndex, anyEditIndex: index.lastEditIndex, attempts: [], successIndexes: [], failureIndexes: [], detail: null };
  const tag = (list) => list.map((c) => ({ index: c.index, cmd: c.cmd.slice(0, 160), ok: c.ok, inconclusive: c.backgrounded === true }));

  if (family === 'test-count') {
    const a = attemptsOf(index, 'test-count');
    base.attempts = tag(a);
    base.successIndexes = a.filter((c) => c.ok).map((c) => c.index);
    base.failureIndexes = a.filter((c) => !c.ok && !c.backgrounded).map((c) => c.index);
    base.detail = { testRuns: a.length, testPassed: base.successIndexes.length };
    return base;
  }
  if (family === 'build') {
    const a = attemptsOf(index, 'build');
    base.attempts = tag(a);
    base.successIndexes = a.filter((c) => c.ok).map((c) => c.index);
    base.failureIndexes = a.filter((c) => !c.ok && !c.backgrounded).map((c) => c.index);
    base.detail = { buildRuns: a.length, buildPassed: base.successIndexes.length };
    return base;
  }
  if (family === 'commit') {
    // 先把只读的 git 子命令挖掉，再问「这条命令有没有真的提交」。
    const a = attempts(index, COMMIT_CMD_RE).filter((c) => {
      const actionable = c.cmd.replace(GIT_READONLY_RE, ' ');
      return COMMIT_CMD_RE.test(actionable);
    });
    base.attempts = tag(a);
    // `git commit -q -F -` 成功时**不打印任何东西**，靠输出形状判会把真提交判成没有。
    // 退回到退出码：git 在「没东西可提交」或 hook 失败时返回非 0，`is_error` 会为 true。
    // 这一点在 2f9f2b39 上实测过：它有 4 次真提交（6c3c7c3 / 4f9d7a4 等），
    // 但 `-q` 让输出为空，旧判据把它们全判成了失败。
    const ok = a.filter((c) => c.ok);
    base.successIndexes = ok.map((c) => c.index);
    base.failureIndexes = a.filter((c) => !c.ok && !c.backgrounded).map((c) => c.index);
    base.detail = { commitRuns: a.length, commitOk: ok.length, withSha: ok.filter((c) => COMMIT_OK_RE.test(c.output)).length };
    return base;
  }
  if (family === 'push-remote') {
    const a = attemptsOf(index, 'push-remote');
    base.attempts = tag(a);
    // `git push -q` 成功时什么都不打印。和 commit 一样，退回到退出码：
    // git 在 rejected / non-fast-forward 时返回非 0，is_error 会是 true。
    //
    // 「空输出 + 退出码 0」不能无条件当成功：只有命令里带静默开关（-q / --quiet）、
    // 或输出里出现了推送成功的形状，才认。
    const ok = a.filter((c) => c.ok && !PUSH_REJECT_RE.test(c.output)
      && (PUSH_OK_RE.test(c.output) || /(?:^|\s)(?:-q|--quiet)\b/.test(c.cmd)));
    base.successIndexes = ok.map((c) => c.index);
    base.failureIndexes = a.filter((c) => !ok.includes(c) && !c.backgrounded).map((c) => c.index);
    base.detail = { pushRuns: a.length, pushOk: ok.length };
    return base;
  }
  if (family === 'pr-ci') {
    // 「CI 通过」的证据有两类：真的查过 CI 服务，或跑了本仓自带的一致性闸门
    // （check-sync / check-i18n 这类）。只认前者会让 8db92679 那种「check-sync 全绿」
    // 变成假 NO_EVIDENCE —— 它的证据是存在的，只是不叫 CI。
    const a = index.shell.filter((c) => CI_CMD_RE.test(c.cmd) || SYNC_CHECK_CMD_RE.test(c.cmd));
    base.attempts = tag(a);
    const ok = a.filter((c) => c.ok && !/\b(fail|failing|failure|red)\b/i.test(c.output));
    base.successIndexes = ok.map((c) => c.index);
    base.failureIndexes = a.filter((c) => !ok.includes(c) && !c.backgrounded).map((c) => c.index);
    base.detail = { ciRuns: a.length, ciOk: ok.length };
    return base;
  }
  if (family === 'runtime-probe') {
    const a = attempts(index, RUNTIME_CMD_RE);
    base.attempts = tag(a);
    base.successIndexes = a.filter((c) => c.ok).map((c) => c.index);
    base.failureIndexes = a.filter((c) => !c.ok && !c.backgrounded).map((c) => c.index);
    base.detail = { probes: a.length, probeOk: base.successIndexes.length };
    return base;
  }
  if (family === 'vague-completion') {
    // 证据标准对「笼统声明」要**更严**，不是更宽 —— 但也只在「有没有做过任何检查」
    // 这一个维度上严。见 VERIFY_CMD_RE 的注释：只读观测（ls/cat/git status）不算。
    const a = attemptsOf(index, 'vague-completion');
    base.attempts = tag(a);
    base.successIndexes = a.filter((c) => c.ok).map((c) => c.index);
    base.failureIndexes = a.filter((c) => !c.ok && !c.backgrounded).map((c) => c.index);
    base.detail = { verifyRuns: a.length, verifyPassed: base.successIndexes.length };
    return base;
  }
  if (family === 'file-count') {
    //   1. Edit/Write 实际动过的 distinct 路径；
    //   2. git commit 输出的 `N files changed`；
    //   3. `git status --short` 输出里的行数（未跟踪 + 已修改）。
    // 只数 (1) 会严重低估：语料里有会话用 `sed -i`/`cat >>` 批量改文件，
    // 那种改动走的是 Bash 而不是 Edit 工具，实测把 26 个文件的断言判成了「只写入 3 个」。
    const paths = [...index.writes.keys()];
    let commitFiles = 0, statusFiles = 0;
    for (const c of index.shell) {
      if (!c.ok) continue;
      const m = c.output.match(/\b(\d{1,5})\s+files?\s+changed\b/i);
      if (m) commitFiles = Math.max(commitFiles, Number(m[1]));
      if (/\bgit\b[^\n]{0,40}\bstatus\b[-\s]*\w*/.test(c.cmd) && /^\s*(?:[MADRCU?!]{1,2}\s+\S|\?\?\s+\S)/m.test(c.output)) {
        const lines = c.output.split('\n').filter((l) => /^\s*(?:[MADRCU?!]{1,2}\s+\S|\?\?\s+\S)/.test(l)).length;
        statusFiles = Math.max(statusFiles, lines);
      }
    }
    const distinct = Math.max(paths.length, commitFiles, statusFiles);
    base.detail = {
      distinctFiles: distinct,
      editedFiles: paths.length,
      commitFiles,
      statusFiles,
      lastWriteIndex: paths.length ? Math.max(...[...index.writes.values()]) : -1,
    };
    base.successIndexes = [];
    base.failureIndexes = [];
    return base;
  }
  if (family === 'artifact-hash') {
    const quote = String((claim && claim.quote) || '');
    const hash = (quote.match(/\b[0-9a-f]{7,40}\b/i) || [])[0];
    base.detail = {
      resultBlocks: index.resultTexts.length,
      hits: hash ? index.resultTexts.filter((r) => r.text.includes(hash)).map((r) => r.index) : [],
    };
    return base;
  }
  base.detail = { uncheckable: true };
  return base;
}

/** 断言里声明的数量（file-count / test-count 用）。数不出来返回 null。 */
export function claimedCount(quote) {
  const q = String(quote || '');
  const frac = q.match(/(\d{1,5})\s*\/\s*(\d{1,5})/);
  if (frac) return Number(frac[2]);
  const n = q.match(/(\d{1,5})\s*(?:个|份|处)?\s*(?:文件|文档|files?)/i);
  if (n) return Number(n[1]);
  const t = q.match(/(\d{1,5})\s*(?:个|条|项)?\s*(?:测试|用例|tests?)/i);
  if (t) return Number(t[1]);
  return null;
}

/**
 * 判四档。这是整个文件的结论点，所以规则写死在这里，不在 CLI 里。
 *
 * 时间线取「最后一次文件编辑」（任一 Edit/Write）。注意一个**反直觉但成立**的点：
 * 成功证据落在窗口内、且窗口内它之后再没有任何编辑 —— 就可以判 SUPPORTED，
 * **即使文件被截断**。因为任何「在它之后的编辑」也必然在它之后，必然仍在窗口内。
 * 截断只影响「什么都没找到」这一种情况。这就是 UNKNOWN 只在空档出现的原因。
 */
export function classifyEvidence({ claim, evidence, truncated = false, records = null } = {}) {
  const fam = claim && claim.family;
  const checkable = claim && claim.checkable !== false;
  const ev = evidence || {};
  const after = (i) => i > (ev.lastEditIndex ?? -1);

  if (!checkable) {
    return { status: 'UNCHECKABLE', reason: '该族没有确定性证据源（例如「待办清空」在本机 transcript 里没有对应工具调用）' };
  }

  if (fam === 'file-count') {
    const claimed = claimedCount(claim.quote);
    const distinct = (ev.detail && ev.detail.distinctFiles) || 0;
    if (!distinct) {
      return truncated
        ? { status: 'UNKNOWN', reason: '窗口内没有任何 Edit/Write 记录，更早的部分没读到' }
        : { status: 'NO_EVIDENCE', reason: '整个文件范围内没有任何 Edit/Write 记录' };
    }
    if (claimed === null) return { status: 'SUPPORTED', reason: `有 ${distinct} 个实际写入的文件` };
    if (distinct >= claimed) return { status: 'SUPPORTED', reason: `实际写入 ${distinct} 个文件 ≥ 声称的 ${claimed} 个` };
    // 「少于声称数」只在**能确定它说的是我改了几个文件**时才判失败。
    // 「N 个文件」在真实语料里有三种含义：我改了几个 / 目录里有几个 / 同步了几个。
    // 只有第一种能和 Edit 记录对得上。实测误报：a495f754 说「这个目录 209 个文件」，
    // 被当成「我改了 209 个」判成 FAILED_ONLY —— 那是冤枉。
    const editish = /(?:改动|修改|变更|新增|删除|写入|created|changed|modified|added|updated|written|edited)/i.test(claim.quote);
    if (!editish) {
      return {
        status: 'UNKNOWN',
        reason: `只观测到 ${distinct} 个写入文件 < 声称的 ${claimed} 个，但这句话说的是「文件数量」还是「我改了几个」无法从原话确定`,
      };
    }
    return { status: 'FAILED_ONLY', reason: `实际只改动 ${distinct} 个文件 < 声称的 ${claimed} 个` };
  }

  if (fam === 'artifact-hash') {
    const quote = String((claim && claim.quote) || '');
    const hash = (quote.match(/\b[0-9a-f]{7,40}\b/i) || [])[0];
    if (!hash) return { status: 'UNCHECKABLE', reason: '断言里取不出可比的 hash' };
    const hits = (ev.detail && ev.detail.hits) || [];
    if (hits.length) return { status: 'SUPPORTED', reason: `工具输出里出现 ${hash}` };
    return truncated
      ? { status: 'UNKNOWN', reason: `窗口内工具输出里没有 ${hash}，更早的部分没读到` }
      : { status: 'NO_EVIDENCE', reason: `整个文件的工具输出里都没有 ${hash}` };
  }

  if (fam === 'todos') {
    return { status: 'UNCHECKABLE', reason: '本机没有 TodoWrite 类工具调用可对账' };
  }

  if (fam === 'vague-completion') {
    // 纯对话场景不拦：一个字都没改、也没跑过命令，那「完成了」说的是「我把话说完
    // 了 / 这件事不需要改」这类意思，不是「我改了代码」。判 UNCHECKABLE，不参与
    // 四档，也不进 BLOCKING_STATUS —— 这类会话每天有几打的量，拦它等于把闸门变成
    // 「每次结束都要跑测试」，用户会直接把 hook 关掉。
    //
    // 第二个出口是**只改了文档**：`lastCodeIndex < 0` 表示整个窗口里没有源码改动。
    // 写了两份 markdown 然后说「两件事都做完了」，没有任何测试能验证它 ——
    // 要求它跑测试是把「无解」说成「没做」。实测出处：会话 0a0e115c / f37b9290
    // （79 个 Write 全是 `_study/prompts/*.md`，说「两件事都做完了」）。
    // 这一条**只在没有任何成功的验证调用时**生效：真跑过 lint 的文档会话走正常四档。
    if ((ev.anyEditIndex ?? -1) < 0 && (ev.attempts || []).length === 0) {
      return truncated
        ? { status: 'UNKNOWN', reason: '窗口内没有任何改动或检查记录，更早的部分没读到' }
        : { status: 'UNCHECKABLE', reason: '整个会话没有任何文件改动，也没有任何检查调用 —— 这不是一条关于改动的声明' };
    }
    if ((ev.lastEditIndex ?? -1) < 0 && !(ev.successIndexes || []).length) {
      return { status: 'UNCHECKABLE', reason: '本会话只改动了文档，没有任何源码改动 —— 没有能验证它的检查' };
    }
  }

  const succ = Array.isArray(ev.successIndexes) ? ev.successIndexes : [];
  const fail = Array.isArray(ev.failureIndexes) ? ev.failureIndexes : [];
  const inconclusive = (Array.isArray(ev.attempts) ? ev.attempts : [])
    .filter((a) => a.inconclusive).map((a) => a.index);
  const succAfter = succ.filter(after);
  const failAfter = fail.filter(after);
  // 「这一族在找什么动作」的中文名。**不许回退到 `fam`** —— 那会把 `vague-completion`
  // 这类内部 ID 拼进给模型看的句子（实测缺陷：拦截文案里出现「没有任何
  // vague-completion 调用」，模型读到的是一条它无法执行的指令）。
  const kind = activityName(fam);

  if (succAfter.length) {
    return { status: 'SUPPORTED', reason: `最后一次编辑之后有 ${succAfter.length} 次成功的「${kind}」` };
  }
  if (succ.length) {
    return { status: 'STALE_ONLY', reason: `有 ${succ.length} 次成功的「${kind}」，但都发生在最后一次编辑之前（编辑后没重跑）` };
  }
  if (fail.length) {
    return {
      status: 'FAILED_ONLY',
      reason: `只有失败的「${kind}」（${fail.length} 次，其中编辑后 ${failAfter.length} 次）`,
      mayHideOlderSuccess: truncated,
    };
  }
  // 只有「丢到后台去了」的调用：既不是成功也不是失败。判 UNKNOWN 是对的 ——
  // 我们确实没拿到退出码，说它失败是编的，说它成功也是编的。
  if (inconclusive.length) {
    return { status: 'UNKNOWN', reason: `有 ${inconclusive.length} 次「${kind}」被转到后台执行，前台没拿到退出码` };
  }
  if (truncated) {
    return { status: 'UNKNOWN', reason: `窗口内没有任何「${kind}」调用，但只回溯了尾部一段，更早的部分没读到` };
  }
  return { status: 'NO_EVIDENCE', reason: `整个文件范围内没有任何「${kind}」调用` };
}

// ── 会话级 ────────────────────────────────────────────────────────────

/** 列举主 transcript。--days 按 mtime 过滤。 */
export function listSessions(projectsRoot, { days = 0, nowMs = Date.now() } = {}) {
  const out = [];
  let dirs;
  try { dirs = readdirSync(projectsRoot); } catch { return out; }
  const cutoff = days > 0 ? nowMs - days * 86_400_000 : -Infinity;
  for (const d of dirs) {
    const dp = join(projectsRoot, d);
    let st;
    try { st = statSync(dp); } catch { continue; }
    if (!st.isDirectory()) continue;
    let entries;
    try { entries = readdirSync(dp); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue;
      const p = join(dp, e);
      let fs2;
      try { fs2 = statSync(p); } catch { continue; }
      if (fs2.mtimeMs < cutoff) continue;
      out.push({ path: p, project: d, sessionId: basename(e, '.jsonl'), mtimeMs: fs2.mtimeMs, size: fs2.size });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** 一个会话的子 agent transcript 列表（只 stat，不读）。 */
export function subagentFiles(session) {
  const dir = join(session.path.slice(0, -'.jsonl'.length), 'subagents');
  try {
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f));
  } catch { return []; }
}

/** 这条断言在窗口里是否已经找到「成功」证据。用来决定能不能提前结束回溯。 */
export function evidenceSufficient(index, cl) {
  if (!cl || cl.checkable === false) return true;
  const fam = cl.family;
  if (fam === 'file-count') return index.writes.size > 0;
  if (fam === 'artifact-hash') {
    const hash = (String(cl.quote || '').match(/\b[0-9a-f]{7,40}\b/i) || [])[0];
    return !hash || findEvidence(index.records, cl).detail.hits.length > 0;
  }
  return findEvidence(index.records, cl).successIndexes.length > 0;
}

/** 会话级回溯停机条件：**每条**可核对断言都已经找到成功证据。
 *
 *  曾经用「任一族找到成功就停」，结果同一会话里 `26 测试全绿`（test-count SUPPORTED）
 *  会让 `BUILD SUCCESS`（build）在 1 MB 窗口就停止回溯，被错判成 UNKNOWN。
 *  这是实测出来的，见 `docs/research/2026-11-03-verify-claims.md`。 */
export function enoughForClaims(records, claims) {
  const index = buildEvidenceIndex(records);
  const list = Array.isArray(claims) ? claims : [];
  return list.every((c) => evidenceSufficient(index, c));
}

/** 回溯是否已经够定性了：窗口里已经出现一次**成功的**相关调用（单条断言口径）。
 *
 *  为什么「成功就停」是安全的：窗口是文件的**后缀**。成功证据落在窗口内，说明它之后
 *  的所有记录也都在窗口内 —— 包含任何「之后的编辑」。所以「最后一次编辑是否在它之前」
 *  可以纯靠窗口内数据判定，不需要读到文件开头。找不到成功证据时才必须一路回读到上限。
 *  多断言会话请用 `enoughForClaims`，它会等**每一条**都有成功证据。 */
export function enoughForClaim(records) {
  const index = buildEvidenceIndex(records);
  for (const c of index.shell) {
    if (!c.ok) continue;
    if (TEST_CMD_RE.test(c.cmd) || BUILD_CMD_RE.test(c.cmd) || COMMIT_CMD_RE.test(c.cmd) ||
        PUSH_CMD_RE.test(c.cmd) || CI_CMD_RE.test(c.cmd) || RUNTIME_CMD_RE.test(c.cmd)) return true;
  }
  return false;
}

/**
 * 扫一个会话：先读尾部拿断言，只有存在可核对断言时才做有界回溯。
 * 返回的行结构直接进 CLI 汇总，也直接是 --json 的单元。
 */
export function scanSession(session, {
  backtrack = DEFAULT_BACKTRACK_BYTES,
  steps = null,
  includeSubagents = false,
} = {}) {
  const tail = readTailRecords(session.path, CLAIM_TAIL_BYTES);
  const text = lastAssistantText(tail.records);
  // `quoteStats` 只统计「原话还原退化成 cleaned 句子」的次数，由汇总层打印。
  // 不传它时行为完全不变 —— `detectClaims` 的第二参数是可选的。
  const quoteStats = {};
  const claims = text ? detectClaims(text, quoteStats) : [];
  const checkable = claims.filter((c) => c.checkable);
  const row = {
    sessionId: session.sessionId,
    project: session.project,
    sizeMB: Number((session.size / 1e6).toFixed(2)),
    mtimeMs: session.mtimeMs,
    claims,
    results: [],
    truncated: false,
    bytesRead: CLAIM_TAIL_BYTES,
    windowBytes: CLAIM_TAIL_BYTES,
    quoteFallbacks: quoteStats.quoteFallbacks || 0,
    // 子 agent 的数量**永远**要数出来，哪怕不读内容：前序研究「15 个会话 0 个子 agent」
    // 这条结论全靠这个数字，而数目录是 241 次 stat，成本可忽略。
    subagentCount: checkable.length ? subagentFiles(session).length : null,
  };
  if (!checkable.length) return row;

  const bounded = steps || [1, 2, 4, 8, 16]
    .map((n) => n * 1024 * 1024)
    .filter((n) => n <= backtrack)
    .concat(backtrack);
  let back = readBack(session.path, {
    steps: [...new Set(bounded)].sort((a, b) => a - b),
    enough: (recs) => enoughForClaims(recs, checkable),
  });
  // 没找到成功证据时会一路读到上限。若截断，说明更早的部分里可能有证据。
  row.backtracked = true;
  row.bytesRead += back.bytesRead;
  row.windowBytes = back.windowBytes;
  row.truncated = back.truncated;
  let records = back.records;

  let subHit = null;
  if (includeSubagents && row.subagentCount) {
    const subs = subagentFiles(session);
    if (subs.length) {
      // 子 agent 只读尾部 2 MB：它们的证据通常就在最近一次调用附近，且体积合计近 5 GB。
      const texts = [];
      for (const f of subs) {
        const r = readTailRecords(f, 2 * 1024 * 1024);
        texts.push(...r.records);
      }
      if (texts.length) {
        // 子 agent 的调用与结果拼在一起当作「同一时间线之外的旁证」：只用来把
        // NO_EVIDENCE 降级成 UNKNOWN，不用来判 SUPPORTED —— 我们不知道它发生在编辑前后。
        subHit = buildEvidenceIndex(texts);
      }
    }
  }

  for (const claim of checkable) {
    const evidence = findEvidence(records, claim);
    // artifact-hash 的「证据」是工具输出里出现该 hash
    if (claim.family === 'artifact-hash') {
      const h = (claim.quote.match(/\b[0-9a-f]{7,40}\b/i) || [])[0];
      evidence.detail = evidence.detail || {};
      evidence.detail.hits = h
        ? buildEvidenceIndex(records).resultTexts.filter((r) => r.text.includes(h)).map((r) => r.index)
        : [];
    }
    let verdict = classifyEvidence({ claim, evidence, truncated: row.truncated, records });
    if (subHit && (verdict.status === 'NO_EVIDENCE' || verdict.status === 'UNKNOWN')) {
      // 证据可能在子 agent 里。这里**不**判 SUPPORTED：子 agent 的工具调用不在主时间线上，
      // 我们无法确认它发生在本次编辑之后。降级成 UNKNOWN 是诚实的做法。
      const subEv = findEvidence(subHit.records, claim);
      const subHas = (subEv.successIndexes && subEv.successIndexes.length) ||
                     (claim.family === 'artifact-hash' && subEv.detail && subEv.detail.hits && subEv.detail.hits.length) ||
                     (claim.family === 'file-count' && subEv.detail && subEv.detail.distinctFiles);
      if (subHas) verdict = { status: 'UNKNOWN', reason: '主 transcript 无证据，但子 agent transcript 里有可疑证据；时间先后无法确定' };
    }
    // 时间线只为渲染服务（「最后一次编辑在 14:32」），**不参与判定**。
    // 判定只用 index 顺序，这些毫秒时间戳是从同一条记录的 timestamp 读出来的。
    row.results.push({ claim, evidence, ...verdict, timeline: evidenceTimeline(evidence, records) });
  }
  return row;
}

// ── 汇总 ──────────────────────────────────────────────────────────────

/** 把逐会话的结果压成统计。纯函数，便于测试与复算。 */
export function summarizeClaims(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byStatus = {};
  for (const s of EVIDENCE_STATUS) byStatus[s] = 0;
  const byFamily = {};
  const sessionsWithClaims = new Set();
  const sessionsByStatus = {};
  for (const s of EVIDENCE_STATUS) sessionsByStatus[s] = 0;
  const noEvidence = [];
  const unknown = [];
  let claims = 0, truncatedSessions = 0, bytesRead = 0, quoteFallbacks = 0;

  for (const r of list) {
    bytesRead += r.bytesRead || 0;
    if (r.truncated) truncatedSessions++;
    quoteFallbacks += r.quoteFallbacks || 0;
    if (!r.results || !r.results.length) continue;
    sessionsWithClaims.add(r.sessionId);
    const seen = new Set();
    for (const res of r.results) {
      claims++;
      byStatus[res.status] = (byStatus[res.status] || 0) + 1;
      byFamily[res.claim.family] = (byFamily[res.claim.family] || 0) + 1;
      // 会话级取「最需要看的那一档」：UNKNOWN > NO_EVIDENCE > FAILED_ONLY > STALE_ONLY > UNCHECKABLE > SUPPORTED
      if (!seen.has(res.status)) { seen.add(res.status); sessionsByStatus[res.status]++; }
    }
    const worst = ['UNKNOWN', 'NO_EVIDENCE', 'FAILED_ONLY', 'STALE_ONLY', 'UNCHECKABLE', 'SUPPORTED']
      .find((st) => r.results.some((x) => x.status === st));
    const bucket = worst === 'NO_EVIDENCE' ? noEvidence : worst === 'UNKNOWN' ? unknown : null;
    if (bucket) {
      bucket.push({
        sessionId: r.sessionId.slice(0, 8),
        project: r.project,
        sizeMB: r.sizeMB,
        status: worst,
        truncated: r.truncated,
        subagentCount: r.subagentCount,
        claims: r.results.filter((x) => x.status === worst).map((x) => `${x.claim.family}: ${x.claim.quote}`),
      });
    }
  }

  return {
    sessions: list.length,
    sessionsWithClaims: sessionsWithClaims.size,
    claims,
    byStatus,
    byFamily,
    sessionsByStatus,
    truncatedSessions,
    bytesRead,
    // 「原话还原退化成 cleaned 句子」的次数。恒为 0 才是常态；非 0 说明 `map`
    // 与切句对不上，展示的是清洗后的文本 —— 这项要能被看到，不能静默。
    quoteFallbacks,
    noEvidence,
    unknown,
  };
}


// ── 时间线（只用于展示） ──────────────────────────────────────────────
//
// 判定从不看时间戳：它只看**下标顺序**（transcript 是追加写的）。
// 这里把下标翻成人能读的钟点，纯粹是为了让输出能说「最后一次编辑在 14:32」。
// 读不到 timestamp 就返回 null，渲染层会退回到「最后一次源码编辑之后」这种说法，
// 不会编一个时间出来。

/** 第 i 条记录的 ISO 时间戳，没有就 null。 */
export function timeOf(records, i) {
  const arr = Array.isArray(records) ? records : [];
  if (!Number.isInteger(i) || i < 0 || i >= arr.length) return null;
  const rec = arr[i];
  const ts = rec && (rec.timestamp || (rec.message && rec.message.timestamp));
  return typeof ts === 'string' && ts ? ts : null;
}

/** 取 evidence 里 attempts 的时间戳。attempts 只存了 index，时间要回原记录里读。 */
export function attemptTimes(records, attempts) {
  const arr = Array.isArray(records) ? records : [];
  const list = Array.isArray(attempts) ? attempts : [];
  return list.map((a) => ({ index: a.index, at: timeOf(arr, a.index) }));
}

/** 把 evidence 对象翻成「哪个时刻、改了哪个文件、成功证据在哪个时刻」。 */
export function evidenceTimeline(evidence, records) {
  const ev = evidence || {};
  const arr = Array.isArray(records) ? records : [];
  const index = buildEvidenceIndex(arr);
  const succ = Array.isArray(ev.successIndexes) ? ev.successIndexes : [];
  const fail = Array.isArray(ev.failureIndexes) ? ev.failureIndexes : [];
  const attempts = Array.isArray(ev.attempts) ? ev.attempts : [];
  const lastSuccessIndex = succ.length ? Math.max(...succ) : null;
  const lastFailIndex = fail.length ? Math.max(...fail) : null;
  const lastAttempt = attempts.length ? attempts[attempts.length - 1] : null;
  const edit = index.edits.find((e) => e.index === ev.lastEditIndex) || null;
  return {
    lastEditIndex: ev.lastEditIndex ?? -1,
    lastEditAt: timeOf(arr, ev.lastEditIndex),
    lastEditPath: edit ? (edit.path || (edit.via ? 'shell:' + edit.name : '')) : null,
    lastSuccessIndex,
    lastSuccessAt: timeOf(arr, lastSuccessIndex),
    lastFailIndex,
    lastFailAt: timeOf(arr, lastFailIndex),
    lastAttemptIndex: lastAttempt ? lastAttempt.index : null,
    lastAttemptAt: lastAttempt ? timeOf(arr, lastAttempt.index) : null,
    attemptTimes: attemptTimes(arr, attempts),
    // 会话工作目录。**只给「建议」用**：认不出该跑什么命令时，拿它去读
    // 仓库根的 package.json / pom.xml。它不参与任何判定（EF-013）。
    cwd: lastCwd(arr),
    windowRecords: arr.length,
  };
}

/** 本族「这一族」的命令匹配器。与 `attemptsOf()` 同一套语义，只是作用在原始命令串上。 */
function commandMatcherFor(family) {
  if (family === 'test-count') return (c) => isTestCommand(c);
  if (family === 'build') return (c) => isBuildCommand(c);
  if (family === 'vague-completion') return (c) => isVerificationCommand(c);
  if (family === 'commit') return (c) => COMMIT_CMD_RE.test(normalizeCommand(c));
  if (family === 'push-remote') return (c) => PUSH_CMD_RE.test(normalizeCommand(c));
  if (family === 'pr-ci') {
    return (c) => CI_CMD_RE.test(normalizeCommand(c)) || SYNC_CHECK_CMD_RE.test(normalizeCommand(c));
  }
  if (family === 'runtime-probe') return (c) => RUNTIME_CMD_RE.test(normalizeCommand(c));
  return null;
}

/** 从一条可能很长的复合命令里挑出「真正干活的那一段」。
 *
 *  实测形态：`export JAVA_HOME="/d/j" && "D:/maven/apache-maven-3.9.9/bin/mvn.cmd"
 *  -f "D:/a/b/pom.xml" clean verify`。整条贴给用户是噪声，他真正要重跑的只有后半段。
 *  做法：按 `&&` / `||` / `;` / 换行切段，取**最后一段命中该族匹配器的**；
 *  一段都不命中就原样返回第一行（宁可不裁剪，也不要剪出一个跑不起来的命令）。 */
export function shortenCommand(cmd, matcher) {
  const s = String(cmd || '');
  if (!matcher) return s.split('\n')[0].trim();
  const parts = s.split(/&&|\|\||;|\n/).map((p) => p.trim()).filter(Boolean);
  const hits = parts.filter((p) => matcher(p));
  // 原样返回那一段，**不做 normalizeCommand**：归一化会把引号里的路径压成 basename
  // （`-f "D:/a/pom.xml"` → `-f pom.xml`），那条命令就不再能直接跑。这里要的是
  // 「他能复制粘贴出去跑」的命令，不是「判断用的规范化形式」。
  if (hits.length) return hits[hits.length - 1];
  return s.split('\n')[0].trim();
}

/** 这个会话**实际跑过**的本族命令。用来替掉过去写死的 `npm test`。
 *
 *  优先取「成功的最后一次」：失败的调用可能是拼错的命令，让用户照抄它是二次伤害。
 *  取不到返回 null —— 调用方据此退回项目探测，再退回通用措辞。 */
export function actualCommandFor(evidence, family) {
  const attempts = Array.isArray(evidence && evidence.attempts) ? evidence.attempts : [];
  const matcher = commandMatcherFor(family);
  if (!matcher) return null;
  const usable = attempts.filter((a) => a && typeof a.cmd === 'string' && matcher(a.cmd));
  if (!usable.length) return null;
  const ok = usable.filter((a) => a.ok);
  const pick = (ok.length ? ok[ok.length - 1] : usable[usable.length - 1]);
  const out = shortenCommand(pick.cmd, matcher);
  return out || null;
}

/** 「该重跑什么」的唯一出处：先看会话自己跑过的，再看项目配置，最后才说不知道。
 *
 *  这个顺序是按可靠性排的，不是按方便排的：
 *    1. transcript 里有成功的本族调用 → 那是**这台机器上真实跑通过**的命令；
 *    2. 项目根有标志文件 → 读出来的是**这个项目**声明的命令（Maven 项目绝不说 npm）；
 *    3. 都没有 → 直说认不出，把「编一个」这条路堵死。
 *
 *  第三档是这条链的重点：建议给错比不给更糟 —— 用户会照着跑，得到
 *  `npm ERR! ENOENT package.json`，然后合理地怀疑整个闸门是坏的。 */
export function recoveryCommandFor(res) {
  const fam = (res && res.claim && res.claim.family) || '';
  if (fam === 'file-count' || fam === 'artifact-hash' || fam === 'todos') {
    return { cmd: null, source: null, fam };
  }
  const actual = actualCommandFor(res && res.evidence, fam);
  if (actual) return { cmd: actual, source: 'transcript', fam };
  const cwd = res && res.timeline && res.timeline.cwd;
  if (cwd) {
    const proj = detectProjectCommands(cwd);
    // 构建族只认 build 命令。`npm run test` 不是构建 —— 拿它充当构建命令同样是「编」，
    // 只是编得更隐蔽。
    const picked = fam === 'build' ? proj.build : proj.test;
    if (picked) return { cmd: picked, source: 'project', project: proj, fam };
  }
  return { cmd: null, source: null, fam };
}

/** 把 `recoveryCommandFor` 的结论说成一句「重跑 …」。
 *
 *  **三个来源必须说得出区别**：用户看到「重跑 X」时有资格知道 X 是从哪来的 ——
 *  是他自己在那个会话里跑过的，还是我从仓库配置里读出来的。 */
function rerunPhrase(res) {
  const r = recoveryCommandFor(res);
  if (r.source === 'transcript') return '重跑 `' + r.cmd + '`（该会话里跑通过的就是这条）';
  if (r.source === 'project') {
    const src = (r.project && r.project.source) || '项目配置';
    return '重跑 `' + r.cmd + '`（依据 ' + src + '）';
  }
  const what = activityName((res && res.claim && res.claim.family) || '');
  return '重跑你实际用的「' + what + '」命令 —— 本会话没留下这类调用，项目根也没有能认出的'
    + '标志文件（package.json / pom.xml / build.gradle / Cargo.toml / go.mod），所以我不编一个';
}

// ── 展示层 ────────────────────────────────────────────────────────────
//
// 这一段唯一的职责是「把已经判好的结论说成人话」。它**不许改变结论**：
// 拿到的 status 是什么就说什么，没有任何一个分支自己重判。
//
// 族名一律走 `ACTIVITY_NAMES` / `FAMILY_NAMES`（定义在断言族旁边），不在这里再抄一份。
// 抄两份的后果是实测过的：`classifyEvidence` 里那份漏了族，退回 `fam`，
// 于是给模型的文案里出现「没有任何 vague-completion 调用」。

const STATUS_ICON = Object.freeze({
  NO_EVIDENCE: '✗', FAILED_ONLY: '✗', STALE_ONLY: '⚠',
  UNKNOWN: '?', SUPPORTED: '✓', UNCHECKABLE: '·',
});

/** 需要人看一眼的档位。SUPPORTED 默认不渲染。 */
export const ALERT_STATUS = Object.freeze([
  'NO_EVIDENCE', 'FAILED_ONLY', 'STALE_ONLY', 'UNKNOWN', 'UNCHECKABLE',
]);

/** ISO → 本地时间。同一天只说 `HH:MM:SS`，跨天带上 `MM-DD`。
 *  一个会话可以横跨好几天；只印钟点会让「08:43 成功、之后的 22:36 失败」
 *  看起来像是同一天里倒退。解析不了返回 null（不编时间）。 */
export function fmtClock(iso, nowMs = Date.now()) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  const sameDay = new Date(nowMs).toDateString() === d.toDateString();
  return sameDay
    ? p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    : p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export function verdictIcon(status) {
  return STATUS_ICON[status] || '·';
}

/** 「证据」那一行：说清看到了什么、什么时候。用的都是 evidence 里已有的字段。 */
export function evidenceSentence(res) {
  const claim = (res && res.claim) || {};
  const ev = (res && res.evidence) || {};
  const d = ev.detail || {};
  const t = (res && res.timeline) || {};
  const status = res && res.status;
  // 中文动作名，不是族 ID。`activityName` 保证未知族也给一句人话。
  const kind = activityName(claim.family);
  const fam = claim.family;
  const when = (iso) => fmtClock(iso);

  if (fam === 'file-count') {
    const claimed = claimedCount(claim.quote);
    const got = d.distinctFiles || 0;
    const bits = [claimed === null
      ? '实际写入 ' + got + ' 个文件'
      : '实际写入 ' + got + ' 个文件，原话声称 ' + claimed + ' 个'];
    if (d.commitFiles) bits.push('git 报告 ' + d.commitFiles + ' 个变更');
    if (when(t.lastEditAt)) bits.push('最后一次写入在 ' + when(t.lastEditAt));
    return bits.join('；');
  }
  if (fam === 'artifact-hash') {
    const hash = (String(claim.quote || '').match(/\b[0-9a-f]{7,40}\b/i) || [])[0];
    const hits = (d.hits || []).length;
    const tail = hits ? '出现在 ' + hits + ' 处工具输出里' : '读到的窗口里一次都没出现';
    return (hash || '该 hash') + ' ' + tail;
  }
  if (fam === 'todos') return '本机 transcript 里没有 TodoWrite 类工具调用可对账';

  const runs = d.testRuns ?? d.buildRuns ?? d.commitRuns ?? d.pushRuns ?? d.ciRuns ?? d.probes ?? d.verifyRuns ?? null;
  const okN = d.testPassed ?? d.buildPassed ?? d.commitOk ?? d.pushOk ?? d.ciOk ?? d.verifyPassed ?? null;
  const bits = [];
  if (runs !== null) bits.push(kind + '调用 ' + runs + ' 次' + (okN !== null ? '（成功 ' + okN + ' 次）' : ''));

  if (status === 'NO_EVIDENCE') {
    bits.push(when(t.lastEditAt)
      ? '最后一次源码编辑在 ' + when(t.lastEditAt) + '，之后没再' + kind + '过'
      : '整个会话范围内没有任何' + kind + '调用');
  } else if (status === 'STALE_ONLY') {
    const succAt = when(t.lastSuccessAt);
    const editAt = when(t.lastEditAt);
    if (succAt && editAt && succAt === editAt) {
      // 同一秒：说不出先后，就别假装能说。判定的依据是下标，不是时间。
      bits.push('最近一次成功和最后一次源码编辑都落在 ' + succAt + '（同一秒，按记录顺序编辑在后）');
    } else {
      if (succAt) bits.push('最近一次成功在 ' + succAt);
      if (editAt) bits.push('之后 ' + editAt + ' 又改了源码');
    }
  } else if (status === 'SUPPORTED') {
    if (when(t.lastSuccessAt)) bits.push('最近一次成功在 ' + when(t.lastSuccessAt));
    if (when(t.lastEditAt)) bits.push('在最后一次源码编辑（' + when(t.lastEditAt) + '）之后');
  } else if (status === 'FAILED_ONLY') {
    if (when(t.lastFailAt)) bits.push('最后一次失败在 ' + when(t.lastFailAt));
  } else if (status === 'UNKNOWN') {
    // UNKNOWN 有三个来源：截断、后台执行拿不到退出码、子 agent 里有可疑证据。
    // 说错来源等于把「我们没读到」说成「它没做」，所以这里直接引用判定给的 reason，
    // 只补时间线，不自己猜是哪一个。若计数那句已经涵盖了，就不重复。
    if (!/(没有任何|后台|不确定)/.test(bits.join(''))) bits.unshift(res.reason || '原因不明');
    if (when(t.lastSuccessAt)) bits.push('最近一次成功在 ' + when(t.lastSuccessAt));
  } else if (status === 'UNCHECKABLE') {
    bits.push('该族没有确定性证据源');
  }
  return bits.length ? bits.join('；') : (res.reason || '没有可展开的证据明细');
}

/** 与项目无关的族：命令由族的语义直接决定，不需要探测，也不会因项目而变。
 *  `test-count` / `build` / `vague-completion` **不在**此列 —— 它们要跑的是
 *  「这个项目里实际能验证它的那条命令」，只能从会话或仓库配置里读。 */
const INTRINSIC_CMD = Object.freeze({
  'commit': 'git commit',
  'push-remote': 'git push，再用 git status 确认 ahead 为 0',
  'pr-ci': 'gh pr checks 或本仓自带的一致性脚本',
  'runtime-probe': '重新探活（curl / netstat）',
  'file-count': 'git status --short 数一下实际改了几个文件',
});

/** 具体补救建议。按「用户下一步能做什么」写，不按错误分类写。
 *
 *  **这一层不改结论**，只把「重跑什么」说对。测试与构建命令一律走
 *  `recoveryCommandFor()`：会话里跑过的 > 仓库配置里读出的 > 直说不知道。 */
export function adviceFor(res) {
  const claim = (res && res.claim) || {};
  const fam = claim.family;
  const t = (res && res.timeline) || {};
  const d = (res && res.evidence && res.evidence.detail) || {};
  const status = res && res.status;
  const rerun = (fam === 'test-count' || fam === 'build' || fam === 'vague-completion')
    ? rerunPhrase(res)
    : '重跑 ' + (INTRINSIC_CMD[fam] || '重新核对');

  if (status === 'NO_EVIDENCE') {
    if (fam === 'test-count') {
      return t.lastEditAt
        ? '最后一次源码编辑在 ' + (fmtClock(t.lastEditAt) || '编辑之后') + '，之后没有任何测试调用。'
          + rerun + ' 确认；若确实在子 agent 里跑过，加 --include-subagents 再查一次'
        : '整个会话没有测试调用。' + rerun + '，并且让它落在同一个会话里 —— 不要在子 agent 里跑完、只在主会话里声称';
    }
    // 笼统声明缺的是「任何一次检查」。说清这一点，否则用户会以为要跑的是某个特定测试。
    if (fam === 'vague-completion') {
      return '这句「做完了」在整个会话里没有任何验证调用 —— 测试、构建、lint、语法检查一次都没有。'
        + rerun + ' 一次，或者把这句话改成「改了但没验证」';
    }
    return '没有任何' + activityName(fam) + '证据。' + rerun + '，让证据落进同一会话';
  }
  if (status === 'STALE_ONLY') {
    return '成功结果在源码改动之后就失效了。' + rerun + '，补上最后一次编辑之后的证据';
  }
  if (status === 'FAILED_ONLY') {
    return '只找到失败的调用。先修掉失败原因，再' + rerun + '；不要只改输出不改代码';
  }
  if (status === 'UNKNOWN') {
    // 后台执行的 UNKNOWN 与截断的 UNKNOWN 补救方式不同：前者要等任务结束或前台重跑，
    // 后者要读更多。给错建议比不给更糟 —— 用户会照着做然后什么都没变。
    if (/后台/.test(String(res.reason || ''))) {
      const rc = recoveryCommandFor(res);
      return '命令被转到后台，前台没拿到退出码。等它结束后在前台重跑一次，这样退出码才有记录'
        + (rc.cmd ? '（就是 `' + rc.cmd + '`）' : '');
    }
    return t.lastSuccessAt
      ? '窗口里有成功证据，但时间先后不确定。加 --include-subagents，或用 --session 单独深查这一个'
      : fam === 'file-count'
        ? '只数到 ' + (d.distinctFiles || 0) + ' 个写入文件，更早的部分没读到。用 --session 单独深查，或加大 --backtrack-mb'
        : '证据可能在更早的部分。加大回溯（如 --backtrack-mb 64），或用 --session 单独深查这一个';
  }
  if (status === 'UNCHECKABLE') return '这一族本机没有确定性证据源，只能人工确认';
  return '';
}

/** 一个会话的告警块（人类可读）。只渲染需要看的档位。
 *  同一会话有多条断言时，表头只印一次 —— 重复印 8 行一样的项目名是噪声。 */
export function renderSessionBlock(row, { verbose = false } = {}) {
  const results = (row && row.results) || [];
  const wanted = verbose ? [...ALERT_STATUS, 'SUPPORTED'] : ALERT_STATUS;
  const pick = results.filter((r) => wanted.includes(r.status));
  if (!pick.length) return '';

  const head = [(row.project || '?') + ' · ' + String(row.sessionId || '').slice(0, 8), row.sizeMB + 'MB'];
  if (row.truncated) head.push('truncated');
  if (row.subagentCount != null) head.push('subagents=' + row.subagentCount);
  const lines = [];

  // 会话头单独一行：同一会话的多条断言共享它，只印一次。
  const worst = ALERT_STATUS.concat('SUPPORTED').find((st) => pick.some((r) => r.status === st));
  lines.push(verdictIcon(worst) + ' ' + head.join(' · '));

  for (const r of pick) {
    lines.push('  AI 说：「' + String((r.claim && r.claim.quote) || '').slice(0, 150) + '」');
    lines.push('  证据：' + evidenceSentence(r));
    lines.push('  判定：' + r.status + '（' + ((r.claim && r.claim.familyLabel) || (r.claim && r.claim.family) || '?') + '）');
    const adv = adviceFor(r);
    if (adv) lines.push('  建议：' + adv);
    if (verbose) {
      // 命中的调用可能几十条。全列会把输出淹掉，只留最后几次 + 失败的那几次。
      const all = (r.evidence && r.evidence.attempts) || [];
      const fails = all.filter((a) => !a.ok && !a.inconclusive);
      const tail = all.slice(-5);
      const shown = all.length > 8 ? [...new Set([...fails.slice(-3), ...tail])] : all;
      for (const a of shown) {
        const mark = a.ok ? '成功' : a.inconclusive ? '后台/无退出码' : '失败';
        const at = fmtClock(attemptTime(r, a.index));
        lines.push('      ↳ [' + mark + ']' + (at ? ' ' + at : '') + '  ' + String(a.cmd || '').split('\n')[0].slice(0, 120));
      }
      if (shown.length < all.length) lines.push('      ↳ …共 ' + all.length + ' 次调用，只列失败项与最后 5 次');
      if (r.evidence && r.evidence.lastEditIndex >= 0) {
        const p = r.timeline && r.timeline.lastEditPath;
        const at = fmtClock(r.timeline && r.timeline.lastEditAt);
        lines.push('      ↳ 最后一次源码编辑：第 ' + r.evidence.lastEditIndex + ' 条' + (at ? '（' + at + '）' : '') + (p ? ' → ' + p : ''));
      }
      if (r.reason) lines.push('      ↳ 判定理由：' + r.reason);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** attempts 里只存了 index；时间从 timeline.attemptTimes 里查。查不到返回 null。 */
export function attemptTime(res, index) {
  const t = (res && res.timeline) || {};
  for (const a of t.attemptTimes || []) if (a.index === index) return a.at;
  if (t.lastAttemptIndex === index) return t.lastAttemptAt;
  return null;
}

/** markdown 表格：一行一条断言，方便贴 PR 评论。 */
export function renderMarkdown(rows, { verbose = false } = {}) {
  const flat = [];
  for (const row of rows || []) {
    for (const r of (row.results || [])) {
      if (!verbose && r.status === 'SUPPORTED') continue;
      flat.push({ row, r });
    }
  }
  const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const out = ['| 状态 | 会话 | 断言族 | AI 说 | 证据 |', '|---|---|---|---|---|'];
  if (!flat.length) out.push('| ✓ | — | — | 没有需要核对的断言 | — |');
  for (const { row, r } of flat) {
    const sess = esc(row.project) + ' `' + String(row.sessionId || '').slice(0, 8) + '`';
    out.push('| ' + r.status + ' | ' + sess + ' | ' + esc(r.claim && r.claim.family) + ' | '
      + esc(String((r.claim && r.claim.quote) || '').slice(0, 120)) + ' | ' + esc(evidenceSentence(r)) + ' |');
  }
  return out.join('\n') + '\n';
}

/** 退出码：发现问题才非零。UNKNOWN **不算失败** —— 读不到不等于没做。 */
export function exitCodeFor(summary) {
  const by = (summary && summary.byStatus) || {};
  return (by.NO_EVIDENCE || 0) + (by.FAILED_ONLY || 0) > 0 ? 1 : 0;
}

/** 汇总统计（排版用）。它不重算判定。 */
export function renderSummary(summary, opts = {}) {
  const totalChecked = (summary.claims || 0) - ((summary.byStatus && summary.byStatus.UNCHECKABLE) || 0);
  const lines = [];
  const dist = EVIDENCE_STATUS
    .filter((st) => summary.byStatus && summary.byStatus[st] > 0)
    .map((st) => summary.byStatus[st] + ' ' + st)
    .join(' / ');
  lines.push('合计 ' + (summary.claims || 0) + ' 条可核对断言：' + (dist || '无'));
  lines.push('覆盖 ' + (summary.sessions || 0) + ' 个 transcript，其中 ' + (summary.sessionsWithClaims || 0)
    + ' 个含可核对断言；读盘 ' + (((summary.bytesRead || 0) / 1e9).toFixed(2)) + ' GB · 截断 '
    + (summary.truncatedSessions || 0) + ' 个' + (opts.elapsedMs != null ? ' · ' + opts.elapsedMs + ' ms' : ''));
  // 只在真发生退化时才提一句：全绿时多印一行是噪声，真退化时不说则是隐瞒。
  if (summary.quoteFallbacks > 0) {
    lines.push('（有 ' + summary.quoteFallbacks + ' 条断言的原话还原失败，已退回清洗后的句子 —— 见 --verbose）');
  }
  if (totalChecked > 0) {
    lines.push('（四档比例按 ' + totalChecked + ' 条计：SUPPORTED ' + pct(summary.byStatus.SUPPORTED || 0, totalChecked) + '）');
  }
  return lines.join('\n');
}

/** 单条断言的完整明细（--explain 与 --samples 共用）。 */
export function renderDetail(row, res, n = null) {
  const lines = [];
  lines.push((n != null ? '#' + n + ' ' : '') + row.project + ' · ' + String(row.sessionId || '').slice(0, 8) + ' · ' + res.claim.family);
  lines.push('  原话：' + res.claim.quote);
  lines.push('  判定：' + res.status);
  lines.push('  理由：' + res.reason);
  lines.push('  证据：' + evidenceSentence(res));
  const t = res.timeline || {};
  if (t.lastEditIndex >= 0) {
    const clock = fmtClock(t.lastEditAt);
    lines.push('  最后一次源码编辑：第 ' + t.lastEditIndex + ' 条' + (clock ? '（' + clock + '）' : '')
      + (t.lastEditPath ? ' → ' + t.lastEditPath : ''));
  }
  // 命中的调用可能几十条，命令本身也可能带换行（heredoc）。这里只取第一行：
  // 一屏能扫完比「完整还原命令」重要，完整命令用 --json 取。
  const attempts = (res.evidence && res.evidence.attempts) || [];
  for (const a of attempts) {
    const mark = a.ok ? '成功' : a.inconclusive ? '后台/无退出码' : '失败';
    const clock = fmtClock(attemptTime(res, a.index));
    const cmd = String(a.cmd || '').split('\n')[0].slice(0, 140);
    lines.push('  · [' + mark + '] 第 ' + a.index + ' 条' + (clock ? ' ' + clock : '') + '  ' + cmd);
  }
  if (res.evidence && res.evidence.detail && typeof res.evidence.detail === 'object') {
    const d = Object.entries(res.evidence.detail)
      .filter(([, v]) => typeof v === 'number' || typeof v === 'boolean')
      .map(([k, v]) => k + '=' + v).join(' ');
    if (d) lines.push('  计数：' + d);
  }
  const adv = adviceFor(res);
  if (adv) lines.push('  建议：' + adv);
  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────

export const HELP_TEXT = [
  'verify-claims — 「AI 说它做完了」到底有没有证据',
  '',
  '它读 Claude Code 的会话 transcript，从最后一条 assistant 文本里认出可核对的完成性',
  '断言（测试通过 / 构建成功 / 已提交 / 已推送 / 文件数 / hash / CI / 探活 / 笼统的',
  '「修好了」），再去 tool_use / tool_result 里找能支持它的调用。判四档：',
  '',
  '  SUPPORTED    最后一次源码编辑之后，有成功的相关调用',
  '  STALE_ONLY   有成功的调用，但都发生在最后一次源码编辑之前（改完没重跑）',
  '  FAILED_ONLY  只有失败的调用',
  '  NO_EVIDENCE  整个会话范围内没有任何相关调用',
  '  UNKNOWN      只读到会话尾部（截断），更早的部分没读到 —— 不等于「没有」',
  '  UNCHECKABLE  该族没有确定性证据源，不参与四档比例',
  '',
  '用法：',
  '  node scripts/verify-claims.mjs                    全量扫描，人类可读',
  '  node scripts/verify-claims.mjs --session 3b39     只查一个会话（id 前缀 / 会话路径）',
  '  node scripts/verify-claims.mjs --verbose          连 SUPPORTED 一起列，附原话与命中的调用',
  '  node scripts/verify-claims.mjs --explain 3        解释第 3 条为什么这么判',
  '  node scripts/verify-claims.mjs --json             机器可读',
  '  node scripts/verify-claims.mjs --format md        输出 markdown 表格，贴 PR 评论',
  '',
  '参数：',
  '  --session <id|path>     只查一个会话。会话 id 前缀（≥4 字符）或 .jsonl 路径',
  '  --days <n>              只看最近 n 天有改动的会话（默认全部）',
  '  --limit <n>             只看最新的 n 个会话',
  '  --backtrack-mb <n>      回溯上限，单位 MB（默认 ' + (DEFAULT_BACKTRACK_BYTES / 1024 / 1024)
    + '）。触到上限判 UNKNOWN，不判 NO_EVIDENCE',
  '  --include-subagents     连子 agent transcript 一起找证据（只会把 NO_EVIDENCE 降级成 UNKNOWN）',
  '  --verbose, -v           显示有证据的断言和命中的命令',
  '  --explain <n>           解释第 n 条断言（按输出顺序，从 1 开始）',
  '  --json                  JSON 输出',
  '  --format <text|md>      输出格式（默认 text）',
  '  --samples <n>           额外打印 n 条抽样（旧参数，保留兼容）',
  '  --exit-zero             无论结果如何都退出 0（默认发现问题退回 1）',
  '  --help, -h              显示这份帮助（不会扫描任何文件）',
  '',
  '退出码：',
  '  0  没有 NO_EVIDENCE / FAILED_ONLY',
  '  1  存在 NO_EVIDENCE 或 FAILED_ONLY —— 可直接接 CI 或 git hook',
  '  2  用法错误（未知参数、--session 找不到或前缀有歧义、--explain 越界）',
  '',
  'JSON 结构：',
  '  { generatedAt, projectsRoot, days, session, elapsedMs, backtrackMB,',
  '    includeSubagents, exitCode, summary, rows }',
  '  summary = { sessions, sessionsWithClaims, claims, byStatus, byFamily,',
  '              sessionsByStatus, truncatedSessions, bytesRead, noEvidence, unknown }',
  '  rows[]  = { sessionId, project, sizeMB, mtimeMs, claims, results,',
  '              truncated, bytesRead, windowBytes, subagentCount }',
  '  results[] = { claim, evidence, status, reason, timeline }',
  '',
  '零依赖，只读。不执行任何命令，不碰被检查的项目。',
  '',
].join('\n');

export function parseArgs(argv) {
  const out = {
    days: 0, json: false, limit: 0, backtrackMB: DEFAULT_BACKTRACK_BYTES / 1024 / 1024,
    includeSubagents: false, samples: 0, verbose: false, explain: 0,
    session: null, format: 'text', exitZero: false, help: false, unknown: null, badFormat: null,
  };
  const list = Array.isArray(argv) ? argv : [];
  const num = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return NaN;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--include-subagents') out.includeSubagents = true;
    else if (a === '--exit-zero') out.exitZero = true;
    else if (a === '--days') out.days = num(list[++i]);
    else if (a === '--limit') out.limit = num(list[++i]);
    else if (a === '--backtrack-mb') {
      const n = num(list[++i]);
      if (Number.isFinite(n) && n > 0) out.backtrackMB = n;
    } else if (a === '--samples') out.samples = num(list[++i]);
    else if (a === '--explain') out.explain = num(list[++i]);
    else if (a === '--session') out.session = String(list[++i] ?? '').trim() || null;
    else if (a === '--format') {
      const f = String(list[++i] ?? '').toLowerCase();
      if (f === 'md' || f === 'markdown') out.format = 'md';
      else if (f === 'text' || f === 'plain') out.format = 'text';
      else out.badFormat = f || '(空)';
    } else {
      out.unknown = a;
    }
  }
  for (const k of ['days', 'limit', 'samples', 'explain']) {
    if (!Number.isFinite(out[k])) out[k] = 0;
  }
  return out;
}

/** `--session` 的解析：.jsonl 路径优先，其次 id 前缀。
 *  返回 `{ session }`，或 `{ error, candidates, ambiguous }`。 */
export function resolveSession(projectsRoot, spec) {
  const want = String(spec || '').trim();
  if (!want) return { error: '没有给 --session 的值' };

  if (/\.jsonl$/i.test(want)) {
    const p = resolve(want);
    let st;
    try { st = statSync(p); } catch { return { error: '找不到这个 transcript：' + want }; }
    if (!st.isFile()) return { error: '不是文件：' + want };
    return {
      session: {
        path: p,
        project: basename(dirname(p)),
        sessionId: basename(p, '.jsonl'),
        mtimeMs: st.mtimeMs,
        size: st.size,
      },
    };
  }

  // id 前缀：全量列举，不按 --days 过滤 —— 点名要看一个会话，就不该被时间窗吃掉。
  const all = listSessions(projectsRoot, { days: 0 });
  const lower = want.toLowerCase();
  const hits = all.filter((s) => s.sessionId.toLowerCase().startsWith(lower));
  if (!hits.length) {
    const near = all.filter((s) => s.sessionId.toLowerCase().includes(lower)).slice(0, 5);
    return {
      error: near.length
        ? '没有以「' + want + '」开头的会话；可能是这几个：'
        : '没有匹配「' + want + '」的会话（共 ' + all.length + ' 个 transcript）',
      candidates: near,
    };
  }
  if (hits.length > 1) {
    return {
      error: '前缀「' + want + '」匹配到 ' + hits.length + ' 个会话，请写长一点：',
      ambiguous: true,
      candidates: hits.slice(0, 10),
    };
  }
  return { session: hits[0] };
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : 'n/a');

/** flatten：所有会话的 (row, result)，顺序就是 --explain 的编号顺序。 */
export function flattenResults(rows) {
  const out = [];
  for (const row of rows || []) for (const r of (row.results || [])) out.push({ row, r });
  return out;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (opts.unknown) {
    process.stderr.write('未知参数：' + opts.unknown + '\n试试 --help\n');
    return 2;
  }
  if (opts.badFormat) {
    process.stderr.write('不认识的输出格式：' + opts.badFormat + '（可用 text / md）\n');
    return 2;
  }

  const projectsRoot = join(homedir(), '.claude', 'projects');
  const t0 = Date.now();
  let sessions;
  let target = null;

  if (opts.session) {
    const found = resolveSession(projectsRoot, opts.session);
    if (!found.session) {
      process.stderr.write(found.error + '\n');
      for (const c of found.candidates || []) {
        process.stderr.write('  ' + c.sessionId + '  [' + c.project + ']  ' + (c.size / 1e6).toFixed(2) + 'MB\n');
      }
      return 2;
    }
    target = found.session;
    sessions = [target];
  } else {
    sessions = listSessions(projectsRoot, { days: opts.days });
    if (opts.limit > 0) sessions = sessions.slice(0, opts.limit);
  }

  const rows = [];
  const backtrack = Math.max(1, opts.backtrackMB) * 1024 * 1024;
  for (const s of sessions) {
    let row;
    try {
      row = scanSession(s, { backtrack, includeSubagents: opts.includeSubagents });
    } catch (e) {
      row = {
        sessionId: s.sessionId, project: s.project, sizeMB: Number((s.size / 1e6).toFixed(2)),
        mtimeMs: s.mtimeMs, claims: [], results: [], truncated: false, bytesRead: 0,
        error: String((e && e.message) || e),
      };
    }
    rows.push(row);
  }
  const elapsed = Date.now() - t0;
  const summary = summarizeClaims(rows);
  let code = exitCodeFor(summary);
  if (opts.exitZero) code = 0;

  if (opts.explain > 0) {
    const flat = flattenResults(rows);
    if (opts.explain > flat.length) {
      process.stderr.write('--explain ' + opts.explain + ' 越界：本次只有 ' + flat.length + ' 条断言\n');
      return 2;
    }
    const hit = flat[opts.explain - 1];
    process.stdout.write(renderDetail(hit.row, hit.r, opts.explain) + '\n');
    return code;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      generatedAt: new Date().toISOString(),
      projectsRoot,
      days: opts.days,
      session: target ? { sessionId: target.sessionId, project: target.project, path: target.path } : null,
      elapsedMs: elapsed,
      backtrackMB: opts.backtrackMB,
      includeSubagents: opts.includeSubagents,
      exitCode: code,
      summary,
      rows,
    }, null, 2) + '\n');
    return code;
  }

  if (opts.format === 'md') {
    process.stdout.write(renderMarkdown(rows, { verbose: opts.verbose }));
    return code;
  }

  if (opts.session) {
    const row = rows[0];
    const flags = (row.truncated ? ' truncated' : '')
      + (row.subagentCount != null ? ' subagents=' + row.subagentCount : '');
    console.log('verify-claims · ' + row.project + ' · ' + row.sessionId + '  ' + row.sizeMB + 'MB' + flags + '（' + elapsed + ' ms）');
    console.log('');
    if (!row.results || !row.results.length) {
      console.log('这个会话没有可核对的完成性断言 —— 最后一条 assistant 文本里没认出「测试通过 / 构建成功 / 已提交」这类话。');
      return code;
    }
    const block = renderSessionBlock(row, { verbose: opts.verbose });
    console.log(block ? block.trimEnd() : '(全部 SUPPORTED，加 --verbose 可看细节)');
    console.log('');
    console.log(renderSummary(summary, { elapsedMs: elapsed }));
    return code;
  }

  const blocks = [];
  for (const row of rows) {
    const b = renderSessionBlock(row, { verbose: opts.verbose });
    if (b) blocks.push(b.trimEnd());
  }
  if (blocks.length) {
    console.log(blocks.join('\n\n'));
    console.log('');
  } else {
    console.log('没有需要看的断言（全部 SUPPORTED 或没有可核对断言）。加 --verbose 可看全部。');
    console.log('');
  }
  console.log(renderSummary(summary, { elapsedMs: elapsed }));
  if (opts.samples > 0) {
    const flat = flattenResults(rows);
    const n = Math.min(opts.samples, flat.length);
    // 没有可抽的就不印「抽样 0 条」—— 那只是噪声。
    if (n > 0) {
      console.log('');
      console.log('── 抽样 ' + n + ' 条（断言 + 判定 + 原因）──');
      for (let i = 0; i < n; i++) {
        console.log(renderDetail(flat[i].row, flat[i].r, i + 1));
        console.log('');
      }
    }
  }
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}

void ROOT;
