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
 * 用法：
 *   node scripts/verify-claims.mjs                 # 全量，人类可读
 *   node scripts/verify-claims.mjs --days 3        # 只扫最近 3 天有改动的
 *   node scripts/verify-claims.mjs --json          # 机器可读
 *   node scripts/verify-claims.mjs --limit 50      # 只扫最新的 50 个会话
 *   node scripts/verify-claims.mjs --backtrack-mb 8
 *   node scripts/verify-claims.mjs --include-subagents   # 连子 agent transcript 一起找证据
 *   node scripts/verify-claims.mjs --samples 12    # 打印 N 条「断言 + 判定」供人工抽检
 *
 * 零依赖，只读。**不会**执行任何命令，也不会碰被检查的项目。
 */

import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

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
]);

/** 「这句话不是在断言完成」的信号。命中就丢弃该句。
 *
 *  实测必要性：这是最难的一类错误。若不看否定，「我没跑测试」会被 test-count 当成
 *  「它在声称测试通过」，把检测器的结论反着写。 */
export const NEGATION_RE = /(?:没|没有|未|尚未|不曾|并未|从没|无法|不能|不再)[^\n，。；]{0,8}(?:跑|运行|执行|做|测试|验证|提交|推送|推|构建|编译|启动|监听|同步|通过|成功|完成|做完|证据|一致|匹配)|(?:测试|构建|编译|提交|推送|启动|验证|证据|结果|hash|指纹)[^\n，。；]{0,6}(?:没|未|失败|不通过|缺失|不一致|不匹配|有误)|(?:还有|仍有|剩下)[^\n，。；]{0,6}(?:待办|任务|未完成|遗留)|未通过|失败|报错|报失败|回滚|不一致|不匹配|undo|revert|\b(?:not|never|no|nothing|none|without|didn'?t|did\s+not|haven'?t|hasn'?t|wasn'?t|isn'?t|untested|unverified|failed|failure|failing)\b[^.\n]{0,24}\b(?:test|tests|run|ran|build|built|compile|commit|committed|push|pushed|verify|verified|pass|passed|green|start|started|listen|listening|sync)/i;

/** 句尾是问号，或句中有征询措辞 —— 那是在问，不是在报完成。 */
export const INTERROGATIVE_RE = /[？?]\s*$|(?:要不要|是否|需不需要|有没有|用不用)[^\n]{0,20}(?:吗|呢|？|\?)/;

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

/** 去掉 fenced code block 与 blockquote。返回 { text, strippedCode, strippedQuote }。 */
export function stripQuoted(text) {
  const src = String(text || '');
  let strippedCode = 0, strippedQuote = 0;
  let out = src.replace(FENCED_CODE_RE, () => { strippedCode++; return '\n'; });
  out = out.replace(BLOCKQUOTE_LINE_RE, () => { strippedQuote++; return ''; });
  // 行内代码（`./gradlew test`、`git commit -m ...`）是命令/标识符，不是完成声明。
  // 实测误报样本：「两种编译通过的实现绕过」里的 `if(false)` 让 build 族命中；
  // 把反引号内容整段挖掉，这类噪声才不会变成断言。
  out = out.replace(/`[^`\n]*`/g, ' ');
  return { text: out, strippedCode, strippedQuote };
}

/** 切句。分隔符本身被丢弃，所以「问号收尾」要在切之前记下来。 */
export function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[。！？!?；;])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
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

/**
 * 从最后一条 assistant 文本里认出可核对的完成性断言。
 *
 * 返回 `[{ family, familyLabel, checkable, quote, index }]`，同一句里命中同一族只记一条。
 * 不做去重聚合：同一族出现两句不同的原话时，两句都要留 —— 逐条核对才有意义。
 */
export function detectClaims(text) {
  const { text: cleaned } = stripQuoted(text);
  const out = [];
  for (const sentence of splitSentences(cleaned)) {
    if (isNegated(sentence)) continue;
    if (isInterrogative(sentence)) continue;
    if (isSpeculative(sentence)) continue;
    for (const fam of CLAIM_FAMILIES) {
      if (!fam.re.test(sentence)) continue;
      if (fam.guard && !fam.guard.test(sentence)) continue;
      out.push({
        family: fam.id,
        familyLabel: fam.label,
        checkable: fam.checkable,
        quote: sentence.length > 160 ? sentence.slice(0, 157) + '…' : sentence,
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
  if (family === 'file-count') {
    // file-count 的证据有三类，取**最大**的那一个：
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

  const succ = Array.isArray(ev.successIndexes) ? ev.successIndexes : [];
  const fail = Array.isArray(ev.failureIndexes) ? ev.failureIndexes : [];
  const inconclusive = (Array.isArray(ev.attempts) ? ev.attempts : [])
    .filter((a) => a.inconclusive).map((a) => a.index);
  const succAfter = succ.filter(after);
  const failAfter = fail.filter(after);
  const kind = {
    'test-count': '测试运行', build: '构建', commit: '提交',
    'push-remote': '推送', 'pr-ci': 'CI 查询', 'runtime-probe': '探活',
  }[fam] || fam;

  if (succAfter.length) {
    return { status: 'SUPPORTED', reason: `最后一次编辑之后有 ${succAfter.length} 次成功的${kind}` };
  }
  if (succ.length) {
    return { status: 'STALE_ONLY', reason: `有 ${succ.length} 次成功的${kind}，但都发生在最后一次编辑之前（编辑后没重跑）` };
  }
  if (fail.length) {
    return {
      status: 'FAILED_ONLY',
      reason: `只有失败的${kind}（${fail.length} 次，其中编辑后 ${failAfter.length} 次）`,
      mayHideOlderSuccess: truncated,
    };
  }
  // 只有「丢到后台去了」的调用：既不是成功也不是失败。判 UNKNOWN 是对的 ——
  // 我们确实没拿到退出码，说它失败是编的，说它成功也是编的。
  if (inconclusive.length) {
    return { status: 'UNKNOWN', reason: `有 ${inconclusive.length} 次${kind}被转到后台执行，前台没拿到退出码` };
  }
  if (truncated) {
    return { status: 'UNKNOWN', reason: `窗口内没有任何${kind}调用，但只回溯了尾部一段，更早的部分没读到` };
  }
  return { status: 'NO_EVIDENCE', reason: `整个文件范围内没有任何${kind}调用` };
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
  const claims = text ? detectClaims(text) : [];
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
    row.results.push({ claim, evidence, ...verdict });
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
  let claims = 0, truncatedSessions = 0, bytesRead = 0;

  for (const r of list) {
    bytesRead += r.bytesRead || 0;
    if (r.truncated) truncatedSessions++;
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
    noEvidence,
    unknown,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { days: 0, json: false, limit: 0, backtrackMB: DEFAULT_BACKTRACK_BYTES / 1024 / 1024, includeSubagents: false, samples: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--include-subagents') out.includeSubagents = true;
    else if (a === '--days') out.days = Number(argv[++i]) || 0;
    else if (a === '--limit') out.limit = Number(argv[++i]) || 0;
    else if (a === '--backtrack-mb') out.backtrackMB = Number(argv[++i]) || out.backtrackMB;
    else if (a === '--samples') out.samples = Number(argv[++i]) || 0;
  }
  return out;
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');

function main(argv) {
  const opts = parseArgs(argv);
  const projectsRoot = join(homedir(), '.claude', 'projects');
  const t0 = Date.now();
  let sessions = listSessions(projectsRoot, { days: opts.days });
  if (opts.limit > 0) sessions = sessions.slice(0, opts.limit);

  const rows = [];
  const backtrack = Math.max(1, opts.backtrackMB) * 1024 * 1024;
  for (const s of sessions) {
    let row;
    try {
      row = scanSession(s, { backtrack, includeSubagents: opts.includeSubagents });
    } catch (e) {
      row = { sessionId: s.sessionId, project: s.project, sizeMB: Number((s.size / 1e6).toFixed(2)), mtimeMs: s.mtimeMs, claims: [], results: [], truncated: false, bytesRead: 0, error: String(e && e.message || e) };
    }
    rows.push(row);
  }
  const elapsed = Date.now() - t0;
  const summary = summarizeClaims(rows);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      generatedAt: new Date().toISOString(),
      projectsRoot,
      days: opts.days,
      elapsedMs: elapsed,
      backtrackMB: opts.backtrackMB,
      includeSubagents: opts.includeSubagents,
      summary,
      rows,
    }, null, 2) + '\n');
    return 0;
  }

  console.log(`verify-claims · ${summary.sessions} 个主 transcript，${summary.sessionsWithClaims} 个含可核对断言（${elapsed} ms）`);
  console.log(`回溯上限 ${opts.backtrackMB} MB · 累计读盘 ${(summary.bytesRead / 1e9).toFixed(2)} GB · 截断 ${summary.truncatedSessions} 个会话`);
  console.log('');
  console.log(`可核对断言 ${summary.claims - (summary.byStatus.UNCHECKABLE || 0)} 条，另有 UNCHECKABLE ${summary.byStatus.UNCHECKABLE || 0} 条（不参与四档比例）`);
  console.log('');
  console.log('断言级分布：');
  const totalChecked = summary.claims - (summary.byStatus.UNCHECKABLE || 0);
  for (const st of EVIDENCE_STATUS) {
    const n = summary.byStatus[st] || 0;
    if (!n) continue;
    console.log(`  ${st.padEnd(14)} ${String(n).padStart(5)}  ${pct(n, totalChecked).padStart(7)}`);
  }
  console.log('');
  console.log('断言族分布：');
  for (const [k, v] of Object.entries(summary.byFamily).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(14)} ${String(v).padStart(5)}`);
  }
  console.log('');
  console.log(`NO_EVIDENCE（整个文件范围内没有任何相关调用）：${summary.noEvidence.length} 个会话`);
  for (const s of summary.noEvidence) {
    console.log(`  [${s.project}] ${s.sessionId}  ${s.sizeMB}MB  subagents=${s.subagentCount ?? 'n/a'}`);
    for (const c of s.claims) console.log(`      · ${c.slice(0, 140)}`);
  }
  if (summary.unknown.length) {
    console.log('');
    console.log(`UNKNOWN（证据可能在被截断的部分，不能当「没有」）：${summary.unknown.length} 个会话`);
    for (const s of summary.unknown.slice(0, 12)) {
      console.log(`  [${s.project}] ${s.sessionId}  ${s.sizeMB}MB  truncated=${s.truncated}  subagents=${s.subagentCount ?? 'n/a'}`);
    }
  }
  if (opts.samples > 0) {
    console.log('');
    console.log(`── 抽样 ${opts.samples} 条（断言 + 判定 + 原因）──`);
    let n = 0;
    for (const r of rows) {
      for (const res of r.results || []) {
        if (n++ >= opts.samples) break;
        console.log(`  [${r.project}/${r.sessionId.slice(0, 8)}] ${res.status}  ${res.claim.family}`);
        console.log(`      原话：${res.claim.quote.slice(0, 120)}`);
        console.log(`      理由：${res.reason}`);
      }
      if (n >= opts.samples) break;
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}

void ROOT;
