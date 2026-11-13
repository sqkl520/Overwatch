#!/usr/bin/env node
/**
 * claim-ledger.mjs — 产出对账。把「子 agent 说它产出了什么」换成「磁盘与 transcript 上的痕迹」。
 *
 * 为什么需要它：现在的交付靠子 agent 在返回里写一段文本（`docs/spec/dispatch-contract.md` §6
 * 的三元组），主线程读了就当它产出过。**没有任何东西核对这段文本与磁盘是否一致。**
 * 于是同一种失败反复出现：活干完了但主线程不知道（重复派活 / 等一个早已完成的活 / 拿不到结果）。
 *
 * 本文件不修 prompt，它做三件可离线计算的事：
 *
 *   1. **派发时登记期望**（`declare`）：这个任务应当产出哪几个文件。期望是数据，不是预测。
 *   2. **收活时对账**（`verify`）：期望 vs 自述（`claim`） vs 磁盘 vs transcript 痕迹，
 *      四方交叉。任何一方对不上都指名是哪一方。
 *   3. **换个来源看产出**（`observe`）：从子 agent 自己的 transcript 里抽出写入痕迹——
 *      `Write`/`Edit` 工具，以及**路径可确定解析的 Bash 写入**（重定向 / heredoc / `tee` / `cp` / `mv`，
 *      配合命令里的字面量 `cd`）。判不出的一律跳过并计数，见 `bashWriteScan`。
 *      这条路径**不需要子 agent 配合**——它没报告，痕迹照样在。
 *
 * ── 三种证据，可信度不同 ─────────────────────────────────────────
 *
 * | 来源 | 怎么来 | 能证明什么 | 不能证明什么 |
 * |---|---|---|---|
 * | 自述 `claim` | 子 agent 自己跑 `claim` 追加 | 它认为它写了哪个文件 | 文件真的在、内容没变 |
 * | 磁盘 `stat` | 对账时现场 stat/hash | 文件此刻在、字节数、sha256 | 是谁写的、什么时候写的 |
 * | transcript `observe` | 读 `subagents/agent-*.jsonl` 的 tool_use | 该 agent **确实调用过**写入（Write/Edit，或路径可判定的 Bash 写命令） | 调用成功与否要看 tool_result（已一并读） |
 *
 * 三方全对得上才判 `COMPLETE`。**只有自述**的产出判不了完成——那正是当前机制的缺陷所在。
 *
 * ── 这一条不能反过来用 ───────────────────────────────────────────
 *
 * 产出静默（`silentMin` 很大）**不是失败判据**。`docs/spec/state-model.md` §2.0.1 已经把
 * 「间隔大 ⇒ 失败」这条推断删掉了：实测 6,308 次大间隔里 94.8% 之后仍有工具调用。
 * 所以本文件把静默标成 `quiet`（描述），**永不**变成 `FAILED`（判据）。
 * 你要用它决定「要不要催」，不要用它决定「重跑」。
 *
 * ── 用法 ─────────────────────────────────────────────────────────
 *
 *   # 派活前：登记这个任务该产出什么（打印一个 nonce，拼进 prompt）
 *   node scripts/claim-ledger.mjs declare --run 2026-11-13-x --task ST1 \
 *     --paths docs/a.md,scripts/b.mjs --role executor
 *
 *   # 收活前：从子 agent transcript 抽痕迹（不需要它配合）
 *   node scripts/claim-ledger.mjs observe --run 2026-11-13-x --session <session-dir>
 *
 *   # 对账
 *   node scripts/claim-ledger.mjs verify --run 2026-11-13-x
 *   node scripts/claim-ledger.mjs verify --run 2026-11-13-x --json
 *
 *   # 认领（主线程崩溃重启后）
 *   node scripts/claim-ledger.mjs adopt --run 2026-11-13-x
 *
 * 退出码：0 = 全部 COMPLETE 且已认领；1 = 有缺陷；2 = 用法错误 / run 不存在。
 *
 * 零依赖，只读（除 `declare` / `claim` / `consume` / `observe` 追加台账本身）。
 */

import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  openSync, readSync, closeSync, statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readTailRecords } from './verify-claims.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ── 常量 ──────────────────────────────────────────────────────────────

export const LEDGER_VERSION = 1;

/** 台账文件名。放在 `tasks/runs/<run-id>/` 下 —— 那个目录已经 gitignore，
 *  且已经是 run 的既有落点（`state.json` / `task-graph.json` 都在那里）。 */
export const LEDGER_FILE = 'claims.jsonl';

/** 算 sha256 的上限。超过就只做「字节数 + mtime」的弱比对，并标 `hashTruncated`。
 *  为什么不硬算：一个 run 可能产出几百 MB 的日志与构建产物，对账要能在亚秒级完成。
 *  为什么不悄悄截断：那会让「hash 不同」变成一个说不清原因的判据。 */
export const HASH_MAX_BYTES = 4 * 1024 * 1024;

/** 找 nonce 只读子 agent transcript 的头部这么多字节。nonce 由派发方写在 prompt 里，
 *  一定出现在最前面的 user 消息中。 */
export const SUBAGENT_HEAD_BYTES = 64 * 1024;

/** 抽 Write/Edit 只读尾部这么多字节。子 agent 的产出几乎总在它生命的后半段。 */
export const OBSERVE_TAIL_BYTES = 8 * 1024 * 1024;

/** 视为「产出一个文件」的工具。Bash 是另一个通道，走 `bashWrites` 解析 —— 见 observedWriteScan。 */
export const WRITE_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** 单项判定。顺序即严重度：后面的比前面的更坏。 */
export const ITEM_STATUS = Object.freeze([
  'OK',            // 有自述、文件在、hash 对得上
  'OK_WEAK',       // 有自述、文件在，但双方任一侧的 hash 被截断，只比了字节数
  'UNREPORTED',    // 文件在（或 transcript 有 Write 痕迹），但没有任何自述
  'ABSENT',        // 期望里有，磁盘上没有，也没人说过它
  'DRIFTED',       // 自述说写了，文件在，但内容已经不是当时那份
  'MISSING',       // 自述说写了，磁盘上没有
  'EXTRA',         // 不在期望里，但从 transcript 看确实被这个 agent 写过（信息项，不算缺陷）
]);

/** 任务级结论。`PARTIAL` 专指「一部分落地、一部分没落地」——它和 `EMPTY` 必须分开：
 *  前者是干到一半，后者是没开工，两者的处置完全不同。 */
export const TASK_VERDICT = Object.freeze([
  'COMPLETE', 'PARTIAL', 'EMPTY', 'UNREPORTED', 'DRIFTED', 'MISSING',
  'CONFLICT', 'NO-EXPECTATION',
]);

/** 判定为缺陷的结论。`NO-EXPECTATION` 也在内：CLAUDE.md 硬约束 8 说未声明产出形态
 *  视为规划缺陷；这里把「未声明产出路径」按同一类处理。 */
export const FAILING_VERDICTS = Object.freeze([
  'PARTIAL', 'EMPTY', 'UNREPORTED', 'DRIFTED', 'MISSING', 'CONFLICT', 'NO-EXPECTATION',
]);

// ── 台账读写 ──────────────────────────────────────────────────────────

export function ledgerPath(runsDir, run) {
  return join(runsDir, String(run), LEDGER_FILE);
}

/** 读台账。坏行不丢、不抛：一行写坏不该让整个对账失败，但它必须被计数并报出来。 */
export function readLedger(file) {
  const rows = [];
  const badLines = [];
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return { rows, badLines, exists: false }; }
  text.split('\n').forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    let r;
    try { r = JSON.parse(s); } catch { badLines.push({ line: i + 1, raw: s.slice(0, 120) }); return; }
    if (!r || typeof r !== 'object' || typeof r.kind !== 'string') {
      badLines.push({ line: i + 1, raw: s.slice(0, 120) });
      return;
    }
    rows.push(r);
  });
  return { rows, badLines, exists: true };
}

/** 追加若干行。台账是 append-only：没有任何「修改」操作，所以崩溃只会丢掉最后几行，
 *  不会把已记录的事实改坏。 */
export function appendRows(file, rows, { nowMs = Date.now() } = {}) {
  if (!rows || !rows.length) return 0;
  mkdirSync(dirname(file), { recursive: true });
  const body = rows.map((r) => JSON.stringify({ v: LEDGER_VERSION, ts: new Date(nowMs).toISOString(), ...r })).join('\n');
  appendFileSync(file, body + '\n', 'utf8');
  return rows.length;
}

// ── 记录构造 ──────────────────────────────────────────────────────────

/** 8 位十六进制 nonce。它只有一个用途：把一份 transcript 归属到某个任务。
 *  为什么不用 agent 名字：12 个角色名是复用的，同一次 run 里会有两个 `executor`。 */
export function makeNonce(random = Math.random) {
  let s = '';
  while (s.length < 8) s += Math.floor(random() * 16).toString(16);
  return s.slice(0, 8);
}

export function makeExpect({ run, task, role = null, paths, nonce = null, timeoutMin = null, nowMs = Date.now() }) {
  return {
    kind: 'expect', run: String(run), task: String(task), role,
    paths: (paths || []).map(String), nonce, timeoutMin,
  };
}

export function makeClaim({ run, task, agent = null, path, disk = null, source = 'self', evidence = null }) {
  const row = { kind: 'claim', run: String(run), task: String(task), agent, path: String(path), source };
  if (disk && disk.exists) {
    row.bytes = disk.size;
    row.mtimeMs = Math.round(disk.mtimeMs);
    if (disk.sha256) row.sha256 = disk.sha256;
    if (disk.hashTruncated) row.hashTruncated = true;
  }
  if (evidence) row.evidence = evidence;
  return row;
}

/** 一条 transcript 写入痕迹。`source` 区分它是**哪个通道**留下的：
 *  `write-tool`（Write/Edit/NotebookEdit，路径由工具参数给出，可信）
 *  `bash`（从命令行解析出来的，只在路径可确定时才有这一条）。
 *
 *  为什么要记通道：两者的可信度不同（Bash 那条经过一次解析），事后统计准确率时
 *  必须能分开看；混成一个数字会让「Bash 解析有没有误判」永远无法回答。 */
export function makeObserve({ run, task, agent = null, path, evidence = null, failed = false, source = 'write-tool' }) {
  return {
    kind: 'observe', run: String(run), task: String(task), agent,
    path: String(path), source: source === 'bash' ? 'bash' : 'write-tool',
    failed: failed === true, evidence,
  };
}

export function makeConsume({ run, task, path = null, by = 'main' }) {
  return { kind: 'consume', run: String(run), task: String(task), path, by };
}

// ── 磁盘探测 ──────────────────────────────────────────────────────────

/** 读文件算 sha256，超过 HASH_MAX_BYTES 就只读前面那一截并标 truncated。
 *  截断时**照样算 hash**：前 4 MiB 的 hash 对「内容改没改」依然有判别力，
 *  只是它不再是整文件的 hash —— 所以调用方必须看 `hashTruncated` 决定比对强度。 */
export function sha256File(path, { maxBytes = HASH_MAX_BYTES } = {}) {
  const h = createHash('sha256');
  const buf = Buffer.allocUnsafe(64 * 1024);
  let fd;
  let read = 0;
  let truncated = false;
  try {
    fd = openSync(path, 'r');
    for (;;) {
      const want = Math.min(buf.length, maxBytes - read);
      if (want <= 0) { truncated = statSync(path).size > maxBytes; break; }
      const n = readSync(fd, buf, 0, want, read);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      read += n;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
  return { sha256: h.digest('hex'), hashTruncated: truncated, bytesHashed: read };
}

/** 台账里记的路径**原样保存**（相对或绝对），但探测磁盘时必须有一个确定的基准。
 *
 *  基准是**仓库根**，不是进程 cwd：`claim` 由子 agent 跑，它的 cwd 可能是任意目录
 *  （实测子 agent 常在不同目录下写文件）；`verify` 由主线程跑，cwd 又是另一个。
 *  用 cwd 会让同一份台账在两次对账里指向不同文件——那是「看起来精确、实际不可复算」。
 *
 *  绝对路径不重写：台账里已经是绝对路径时，基准无从谈起，也不该被改写。 */
export function resolvePath(p, base = ROOT) {
  const s = String(p);
  // 用 `resolve` 而不是 `join`：`join` 只做字符串拼接，不带盘符的绝对路径
  // （Windows 上的 `/x/y`）拼出来仍是 `/x/y`，比出来与真正 stat 的路径不一致。
  // `resolve` 按平台规则补全成完整路径，两边形态才对得上。
  // 也不用自己写正则判「绝对」：盘符、UNC、`C:foo`（驱动器相对）各平台语义不同，
  // 自己判必然漏一处。让平台定义。
  return isAbsolute(s) ? resolve(s) : resolve(base, s);
}

/** 比较用的规范化键。
 *
 *  为什么必须有它：`work/a.md`、`./work/a.md`、`D:\repo\work\a.md` 是**同一个文件**，
 *  而子 agent 与主线程给出的字符串形态几乎不会是同一种（子 agent 常用绝对路径，
 *  派发方常用仓库相对路径）。不归一化，对账会把「同一个文件」判成「期望没落地 +
 *  额外产出」，两边都错。
 *
 *  规则：相对路径按 base 展开 → 反斜杠转正斜杠 → Windows 下小写（NTFS 大小写不敏感）。
 *  **只在比较时用**。台账里保存原样，报告里打印原样 —— 否则人就认不出自己给的路径了。 */
export function pathKey(p, base = ROOT) {
  let s = resolvePath(p, base).replace(/\\/g, '/');
  // 折叠 `/./` 与重复斜杠，去掉末尾斜杠（目录形式不该与文件形式相等，但这里只做无害规整）
  s = s.replace(/\/{2,}/g, '/').replace(/\/\.\//g, '/');
  s = s.replace(/\/+$/, '');
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

/** 这个路径此刻是不是一个目录。只给 `observe` 收账时用（不是纯函数的一部分）。
 *  见过的形态：`cp src dst` 里 `dst` 已是目录，真正的产出是 `dst/<basename>`。 */
function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** 对账用的默认探测器。返回形状固定，测试可以整只替换掉。
 *  `path` 可以是绝对路径 —— 台账里记的路径就是派发时给的路径，本函数不猜基准目录。 */
export function probeDisk(path, base = ROOT) {
  const target = resolvePath(path, base);
  let st;
  try { st = statSync(target); } catch { return { exists: false }; }
  if (!st.isFile()) return { exists: false, notFile: true };
  const h = sha256File(target);
  return {
    exists: true,
    size: st.size,
    mtimeMs: st.mtimeMs,
    sha256: h ? h.sha256 : null,
    hashTruncated: h ? h.hashTruncated : true,
  };
}

// ── Bash 写入识别 ─────────────────────────────────────────────────────
//
// 背景（2026-11-13 实测）：抽样 200 份真实子 agent transcript，
//   有 Write/Edit 工具的 30 份（15.0%），有 Bash 写操作迹象的 32 份（16.0%）。
//   两者比例接近 —— 「只用 Write 才算产出」会漏掉一半。但同一批样本里，
//   那 32 份的写命令大量是 `/tmp` 里的探针（编译单文件、`cat > /tmp/x.java`），
//   **写到临时目录 ≠ 任务产出**。
//
// 所以这里不做「猜」，只做「解析」：
//   · 目标路径必须是字面量（不含 `$`、反引号、`*`、`?`、`[]`、`{}`、`~`）
//   · 相对路径必须有一个**可确定的**工作目录（命令里的字面量 `cd` + transcript 的 cwd）
//   · 任何一步判不出，就整条放弃并计数 —— 放弃是可数的，猜测是不可信的
//
// 能确定解析的形态：
//   重定向 `>` `>>` `2>` `&>`（`2>&1` 是 fd 复制，不是文件）
//   heredoc `cat > p <<'EOF' … EOF`（heredoc 正文不会被当成命令）
//   `tee p` / `cp src dst` / `mv src dst`
// 识别到但**不算产出**（计数，不进结果）：
//   `mkdir`（目录不是文件：probeDisk 拒收目录，写进期望会永远 ABSENT）
//   `/tmp`、`/dev/null` 等临时位置（判得出，但那是探针不是交付物）
//   `sed -i`（原地改写 + 可能留备份文件，语义与「产出一个新文件」不同）
//
// 刻意不认：`find -exec`、`xargs`、`sh -c "…"`、`eval`（路径在动态命令里）、
// `cd $VAR`（工作目录不可知 → 整条命令放弃）。

/** 写入类动词 → 目标参数位置由 `writeTargets` 决定。 */
const BASH_WRITE_VERBS = Object.freeze(['tee', 'cp', 'mv']);

/** 这些命令是「把参数当命令再跑一遍」，我们看不见里面写了什么。 */
const BASH_OPAQUE_VERBS = Object.freeze(['sh', 'bash', 'zsh', 'dash', 'eval', 'source', '.', 'xargs', 'parallel']);

/** 判定为「临时位置」的路径前缀。写入它们**判得出**，但不算任务产出。
 *  实测依据：200 份样本里 Bash 写操作的主流形态就是 `/tmp` 探针。 */
const TEMP_PREFIXES = Object.freeze([
  '/tmp/', '/var/tmp/', '/private/tmp/', '/dev/', '/proc/',
]);

/** 路径里出现任何一个字符，就说明它不是字面量（要展开才知道是什么）。 */
const DYNAMIC_PATH_CHARS = Object.freeze(['$', '`', '*', '?', '[', ']', '{', '}', '~', '!']);

/** Windows 上的 git-bash 把 `D:\x` 写成 `/d/x`（MSYS 的盘符挂载）。
 *  只在 win32、且形如 `/单字母/…`（后面还有内容）时转换。
 *
 *  为什么要求「后面还有内容」：`/a` 这种裸的单字母段在 MSYS 里指的是
 *  `<msys 根>/a`，不是 `A:\`——两者只有在 A: 盘存在时才恰好同义。
 *  少转一条只是漏检，多转一条会编出一个不存在的盘符路径。 */
function msysToNative(p) {
  if (process.platform !== 'win32') return p;
  const m = /^\/([a-zA-Z])\/(.+)$/.exec(p);
  if (!m) return p;
  return `${m[1].toUpperCase()}:/${m[2]}`;
}

function isTempPath(p) {
  const s = String(p).replace(/\\/g, '/');
  if (s === '/dev/null' || s === '/dev/stdout' || s === '/dev/stderr' || s === '/dev/tty') return true;
  if (/^nul$/i.test(s)) return true;
  const low = s.toLowerCase();
  if (TEMP_PREFIXES.some((pre) => low.startsWith(pre))) return true;
  // Windows 的 %TEMP% 落在 …\AppData\Local\Temp 下
  return /^[a-z]:\/(users\/[^/]+\/)?appdata\/local\/temp\//.test(low);
}

/** 一条命令的分段：按 `;` `&&` `||` `|` `&` 换行切开，重定向保留在段内。 */
const SEGMENT_OPS = Object.freeze([';', ';;', '&&', '||', '|', '|&', '&', '\n']);

/** 输出重定向算子。`<` 系列是输入，不算写入。 */
const OUT_REDIRECT_OPS = Object.freeze(['>', '>>', '>|', '&>', '>&']);

/** 词法切分：引号、转义、算子、heredoc 正文。
 *
 *  为什么要自己切而不是正则：`"a > b"` 里的 `>` 不是重定向，`cat > f <<'EOF'`
 *  的正文里可能有任意 shell 文本。正则在这两处必然出错，而出错的形式是
 *  **编造一个不存在的产出路径**。
 *
 *  返回 `[{t:'word'|'op', v, quoted}]`；heredoc 正文在这里被整段丢弃。 */
function tokenizeShell(text) {
  const toks = [];
  const src = String(text);
  const n = src.length;
  let i = 0;
  let word = '';
  let started = false;
  let quotedAny = false;
  // 待处理的 heredoc。定界符在它出现的那一个词处就地登记——不能等到切分结束，
  // 因为正文跳行发生在换行符处，那时定界符必须已经知道。
  let heredocs = [];

  const pushWord = () => {
    if (!started) return;
    const w = { t: 'word', v: word, quoted: quotedAny };
    toks.push(w);
    for (const h of heredocs) if (h.delim === null) { h.delim = word; break; }
    word = '';
    started = false;
    quotedAny = false;
  };

  while (i < n) {
    const ch = src[i];

    if (ch === '\'') {
      started = true; quotedAny = true; i++;
      let s = '';
      while (i < n && src[i] !== '\'') { s += src[i]; i++; }
      word += s; i++;
      continue;
    }
    if (ch === '"') {
      started = true; quotedAny = true; i++;
      while (i < n && src[i] !== '"') {
        // `$(…)` 在双引号内照样会执行。整段收进这个词，并留下 `$` 让它被判为动态。
        if (src[i] === '$' && src[i + 1] === '(') {
          const end = matchParen(src, i + 1);
          word += src.slice(i, end);
          i = end;
          continue;
        }
        if (src[i] === '\\' && i + 1 < n && '"\\$`'.includes(src[i + 1])) { word += src[i + 1]; i += 2; continue; }
        word += src[i]; i++;
      }
      i++;
      continue;
    }
    if (ch === '\\') {
      started = true;
      if (i + 1 < n) word += src[i + 1];
      i += 2;
      continue;
    }
    // 命令替换：整段吞掉，并把这个词标成动态（含 `$`）。
    // 为什么要吞而不是切：`echo x > test_$(date).txt` 的目标确实判不出，
    // 但把它当算子会让**整条**命令（包括同一行里别的确定写入）一起作废。
    if (ch === '$' && src[i + 1] === '(') {
      started = true;
      const end = matchParen(src, i + 1);
      word += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '`') {
      started = true;
      let j = i + 1;
      while (j < n && src[j] !== '`') { if (src[j] === '\\') j++; j++; }
      word += '`' + src.slice(i + 1, j) + '`';
      i = Math.min(j + 1, n);
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { pushWord(); i++; continue; }
    if (ch === '\n') {
      pushWord();
      toks.push({ t: 'op', v: '\n' });
      i++;
      // heredoc 正文：从下一行开始，逐行比对定界符（`<<-` 允许前导 tab）。
      // 正文整体丢弃——它里面的 `>` `EOF` 都不是命令。
      const live = heredocs.filter((h) => h.delim !== null);
      if (live.length) {
        let p = i;
        for (const h of live) {
          while (p <= n) {
            let e = src.indexOf('\n', p);
            if (e < 0) e = n;
            const line = src.slice(p, e);
            p = Math.min(e + 1, n);
            const cmp = h.stripTabs ? line.replace(/^\t+/, '') : line;
            if (cmp === h.delim || e >= n) break;
          }
        }
        i = p;
        heredocs = [];
      }
      continue;
    }

    if (ch === ';' || ch === '|' || ch === '&' || ch === '>' || ch === '<'
      || ch === '(' || ch === ')') {
      // `2>` 里的 `2` 是 fd，不是参数
      let fd = null;
      if (started && /^\d{1,2}$/.test(word) && (ch === '>' || ch === '<')) { fd = word; word = ''; started = false; }
      else pushWord();
      if (ch === '(' || ch === ')') {
        toks.push({ t: 'op', v: ch });
        i++;
        continue;
      }
      const three = src.slice(i, i + 3);
      const two = src.slice(i, i + 2);
      let op;
      if (three === '<<-') { op = '<<-'; i += 3; }
      else if (three === '<<<') { op = '<<<'; i += 3; }
      else if (['&&', '||', ';;', '|&', '>>', '>|', '>&', '<<', '&>', '<&'].includes(two)) { op = two; i += 2; }
      else { op = ch; i += 1; }
      toks.push({ t: 'op', v: op, fd });
      if (op === '<<' || op === '<<-') {
        heredocs.push({ delim: null, stripTabs: op === '<<-' });
      }
      continue;
    }

    started = true;
    word += ch;
    i++;
  }
  pushWord();
  return { tokens: toks, heredocs: heredocs.filter((h) => h.delim !== null) };
}

/** `src[open]` 是 `(`，返回与之配对的 `)` 的**后一位**下标。
 *  配不上就返回字符串长度（把这半截当成动态词，而不是当成算式）。 */
function matchParen(src, open) {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '(') depth++;
    else if (src[k] === ')') { depth--; if (depth === 0) return k + 1; }
  }
  return src.length;
}

/** 一段路径字面量 → `{ ok, path }` 或 `{ ok:false, reason }`。
 *  这里是最保守的一环：任何需要展开才能知道值的东西一律不认。 */
function resolveBashTarget(raw, cwd) {
  const s = String(raw);
  if (!s) return { ok: false, reason: 'empty' };
  if (s === '-' || s === '/dev/null') return { ok: false, reason: 'temp' };
  if (/[\u0000-\u001f]/.test(s)) return { ok: false, reason: 'control' };
  for (const c of DYNAMIC_PATH_CHARS) if (s.includes(c)) return { ok: false, reason: 'dynamic' };
  // `x/` 结尾：目标是目录，真正的文件名取决于源 basename —— 不猜
  if (/[\\/]$/.test(s)) return { ok: false, reason: 'dir-target' };

  const native = msysToNative(s);
  if (isTempPath(native)) return { ok: false, reason: 'temp' };

  if (isAbsolute(native)) return { ok: true, path: resolve(native) };
  // 相对路径必须有确定的 cwd。没有就放弃 —— 这正是「相对路径但工作目录不明」那条。
  if (!cwd) return { ok: false, reason: 'no-cwd' };
  return { ok: true, path: resolve(msysToNative(String(cwd)), native) };
}

/** 一条 Bash 命令 → 可确定的产出路径。
 *
 *  `cwd` 是子 agent 的工作目录（transcript 每条记录都带 `cwd` 字段；任务上下文也可给）。
 *  返回空数组 = 这条命令判不出产出，**不是**「它没写文件」。
 *
 *  纯函数：不读盘、不查环境、不依赖进程 cwd。 */
export function bashWrites(cmd, cwd) {
  return bashWriteScan(cmd, cwd).writes.map((w) => w.path);
}

/** `bashWrites` 的完整版：除了路径，还给出「哪些判不出」的计数。
 *
 *  为什么要有计数：只报「找到 3 个」会让人以为这就是全部。**看不见的部分必须可数**，
 *  否则「没有产出」和「没看」长得一模一样 —— 这正是本文件开头点名的病。 */
export function bashWriteScan(cmd, cwd) {
  const scan = {
    writes: [], unresolved: 0, temp: 0, dirs: 0, inPlaceEdits: 0,
    commands: 0, abortedForCwd: false, abortedSubshell: false,
  };
  const text = typeof cmd === 'string' ? cmd : '';
  if (!text.trim()) return scan;

  const { tokens } = tokenizeShell(text);

  // 子 shell / 命令替换让「哪一段在哪个目录下执行」不再可判。
  // `(cd /a && echo x > y)` 与 `echo x > $(mktemp)` 都属于这类：整体放弃并计数。
  if (tokens.some((tk) => tk.t === 'op' && (tk.v === '(' || tk.v === ')'))) {
    scan.unresolved++;
    scan.abortedSubshell = true;
    return scan;
  }

  const segments = [];
  let cur = [];
  for (const tk of tokens) {
    if (tk.t === 'op' && SEGMENT_OPS.includes(tk.v)) {
      if (cur.length) segments.push(cur);
      cur = [];
      continue;
    }
    cur.push(tk);
  }
  if (cur.length) segments.push(cur);

  let cwdNow = cwd ? String(cwd) : null;
  const seen = new Set();
  const pushPath = (p) => {
    const key = pathKey(p);
    if (seen.has(key)) return;
    seen.add(key);
    scan.writes.push({ path: p, source: 'bash' });
  };

  for (const seg of segments) {
    const words = seg.filter((x) => x.t === 'word');
    const ops = seg.filter((x) => x.t === 'op');
    if (!words.length && !ops.length) continue;
    scan.commands++;

    // 1) 重定向：按出现顺序消费紧随其后的词
    const positional = [];
    for (let k = 0; k < seg.length; k++) {
      const tk = seg[k];
      if (tk.t === 'op') {
        const next = seg[k + 1];
        if (!next || next.t !== 'word') continue;
        if (OUT_REDIRECT_OPS.includes(tk.v)) {
          // `2>&1` / `>&2` 是 fd 复制，不是写文件
          if (tk.v === '>&' && (/^\d+$/.test(next.v) || next.v === '-')) { k++; continue; }
          const r = resolveBashTarget(next.v, cwdNow);
          if (r.ok) pushPath(r.path);
          else if (r.reason === 'temp') scan.temp++;
          else scan.unresolved++;
          k++;
          continue;
        }
        // 输入重定向：目标不是产出，但它也不是位置参数
        if (['<', '<<', '<<-', '<<<', '<&'].includes(tk.v)) { k++; continue; }
        continue;
      }
      positional.push(tk);
    }

    // 2) 去掉赋值前缀，找命令词
    let ai = 0;
    while (ai < positional.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(positional[ai].v)) ai++;
    const argv = positional.slice(ai).map((x) => x.v);
    const verb = argv.length ? basename(argv[0]).toLowerCase() : '';
    const args = argv.slice(1);

    // 3) cd：更新 cwdNow；判不出就**整条命令**放弃。
    //    为什么要连已找到的写入一起丢：`cd /a && echo x > y.txt && cd /b && echo z > w.txt`
    //    里，一旦某一步 cwd 不可知，后面所有相对路径都不再可信；只丢掉后半段会
    //    留下一个「看起来精确、实际基准错误」的结果，比漏检更坏。
    if (verb === 'cd' || verb === 'pushd' || verb === 'popd') {
      const r = verb === 'cd' && args.length === 1 && args[0]
        ? resolveBashTarget(args[0], cwdNow) : { ok: false };
      if (!r.ok) {
        scan.abortedForCwd = true;
        scan.unresolved++;
        scan.writes = [];
        seen.clear();
        return scan;
      }
      cwdNow = r.path;
      continue;
    }

    // 4) 显式目标参数
    if (BASH_WRITE_VERBS.includes(verb)) {
      const targets = writeTargets(verb, args);
      if (targets === null) { scan.unresolved++; continue; }
      for (const t of targets) {
        const r = resolveBashTarget(t, cwdNow);
        if (r.ok) pushPath(r.path);
        else if (r.reason === 'temp') scan.temp++;
        else scan.unresolved++;
      }
      continue;
    }

    if (verb === 'mkdir') { scan.dirs++; continue; }
    if (verb === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a))) { scan.inPlaceEdits++; continue; }
    if (verb === 'perl' && args.some((a) => /^-[a-zA-Z]*i/.test(a))) { scan.inPlaceEdits++; continue; }
    if (verb === 'find' && args.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a))) { scan.unresolved++; continue; }
    if (BASH_OPAQUE_VERBS.includes(verb)) {
      // 参数里再跑一条命令（`sh -c "…"`、`xargs rm`、`eval`）：里面写了什么看不见。
      // 一律计数——「没看」必须和「没写」区分开。
      scan.unresolved++;
      continue;
    }
  }

  return scan;
}

/** `cp` / `mv` 的目标参数。返回 `null` 表示「判不出」。
 *  `tee` 的每个位置参数都是目标。 */
function writeTargets(verb, args) {
  if (verb === 'tee') {
    const out = args.filter((a) => !a.startsWith('-'));
    return out.length ? out : null;
  }
  // cp / mv：`-t DIR` 把 DIR 当目标目录，真正写的是 DIR/<basename> —— 不猜
  if (args.some((a) => a === '-t' || a.startsWith('--target-directory'))) return null;
  const pos = [];
  let endOfFlags = false;
  for (const a of args) {
    if (!endOfFlags && a === '--') { endOfFlags = true; continue; }
    if (!endOfFlags && a.startsWith('-') && a !== '-') continue;
    pos.push(a);
  }
  if (pos.length !== 2) return null; // 多个源 / 缺目标：目标究竟是文件还是目录判不出
  return [pos[1]];
}

// ── transcript 痕迹 ───────────────────────────────────────────────────

/** 从一组 transcript 记录里抽出「写过哪些文件」。
 *
 *  两条来源，合并返回：
 *    · `Write` / `Edit` / `MultiEdit` / `NotebookEdit` → `source: 'write-tool'`
 *    · `Bash` → `source: 'bash'`，路径由 `bashWriteScan` 解析（只在可确定时）
 *
 *  Bash 通道默认**开**，可用 `{ bash: false }` 关掉以回到 2026-11-13 之前的行为
 *  （排查「是不是 Bash 解析误判」时用）。没有 cwd 时相对路径一律判不出，
 *  只有绝对路径会被认出来 —— 这是保守的方向，不是漏洞。
 *
 *  返回 `[{ path, tool, callId, index, failed, source, verb? }]`。`failed` 来自成对的
 *  tool_result 的 `is_error` —— 一次失败的写入不构成产出。 */
export function observedWrites(records, opts = {}) {
  return observedWriteScan(records, opts).writes;
}

/** `observedWrites` 的完整版：多给出「判不出」的计数，供 `observe` 报告。
 *
 *  `records` 每条记录的 `cwd` 字段优先于 `opts.cwd` —— transcript 逐条记录了
 *  当时的 cwd，比外部传进来的更接近事实。 */
export function observedWriteScan(records, { cwd = null, bash = true } = {}) {
  const arr = Array.isArray(records) ? records : [];
  // callId → 这次调用产出的**全部**条目。一条 Bash 命令可以写多个文件
  // （`cat > a <<E … E; cp x b`），失败的标记必须落到每一个上。
  const pending = new Map();
  const out = [];
  const scan = { unresolved: 0, temp: 0, dirs: 0, inPlaceEdits: 0, commands: 0 };
  for (let i = 0; i < arr.length; i++) {
    const rec = arr[i];
    if (!rec) continue;
    const blocks = Array.isArray(rec.message && rec.message.content) ? rec.message.content : [];
    if (rec.type === 'assistant') {
      for (const b of blocks) {
        if (!b || b.type !== 'tool_use') continue;
        if (WRITE_TOOLS.includes(b.name)) {
          const p = String((b.input && (b.input.file_path || b.input.path || b.input.notebook_path)) || '');
          if (!p) continue;
          const item = { path: p, tool: b.name, callId: b.id || null, index: i, failed: false, source: 'write-tool' };
          pending.set(b.id, [item]);
          out.push(item);
          continue;
        }
        if (bash && b.name === 'Bash' && b.input && typeof b.input.command === 'string') {
          const r = bashWriteScan(b.input.command, rec.cwd || cwd || null);
          scan.unresolved += r.unresolved;
          scan.temp += r.temp;
          scan.dirs += r.dirs;
          scan.inPlaceEdits += r.inPlaceEdits;
          scan.commands += r.commands;
          const items = r.writes.map((w) => ({
            path: w.path, tool: 'Bash', callId: b.id || null, index: i,
            failed: false, source: 'bash', verb: bashVerbOf(b.input.command),
          }));
          if (items.length) pending.set(b.id, items);
          for (const it of items) out.push(it);
        }
      }
    } else if (rec.type === 'user') {
      for (const b of blocks) {
        if (!b || b.type !== 'tool_result') continue;
        for (const item of pending.get(b.tool_use_id) || []) item.failed = b.is_error === true;
      }
    }
  }
  return { writes: out, ...scan };
}

/** 只用于证据串：这条命令的大致形态，人读得懂即可。 */
function bashVerbOf(cmd) {
  const s = String(cmd).trim();
  const m = /^(?:[\w.-]+\s*=\s*\S+\s+)*([\w./-]+)/.exec(s);
  return m ? basename(m[1]).toLowerCase() : 'bash';
}

/** 读文件开头 N 字节。用于在子 agent prompt 里找 nonce。 */
export function readHeadText(path, maxBytes = SUBAGENT_HEAD_BYTES) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, Math.max(0, n)).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 在文本里找一个已知 nonce。返回命中的 nonce 或 null。
 *  用「非十六进制字符」做边界，避免 nonce `a1b2` 命中 `a1b2c3d4` 的前缀。 */
export function findNonce(text, nonces) {
  if (!text) return null;
  const s = String(text);
  for (const n of nonces || []) {
    if (!n) continue;
    const re = new RegExp(`(^|[^0-9a-f])${n}([^0-9a-f]|$)`, 'i');
    if (re.test(s)) return n;
  }
  return null;
}

/** 递归找子 agent transcript。与 `scan-sessions.mjs` 的 `collectSubagentFiles` 同形：
 *  实测存在 `subagents/workflows/wf_<id>/` 这一层嵌套，只扫一层会漏。 */
export function collectSubagentTranscripts(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) collectSubagentTranscripts(full, out, depth + 1);
    else if (e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/** 给定一个会话目录（`~/.claude/projects/<slug>/<session-id>/`）或主 transcript 路径，
 *  返回其中所有子 agent transcript 的绝对路径。
 *
 *  两种路径形态都必须支持，因为调用方手里有的可能是任意一种：
 *  `<session-id>.jsonl` 旁的 `<session-id>/subagents/`，或直接给那个目录。
 *  `main transcript` 的相邻目录优先——那是扫描器的实际落盘形态。 */
export function subagentTranscriptsOf(sessionPath) {
  const p = String(sessionPath);
  const candidates = [];
  if (p.endsWith('.jsonl')) {
    candidates.push(p.slice(0, -'.jsonl'.length));
    candidates.push(dirname(p));
  } else {
    candidates.push(p);
  }
  for (const dir of candidates) {
    const sub = join(dir, 'subagents');
    if (!existsSync(sub)) continue;
    return collectSubagentTranscripts(sub).filter((f) => basename(f).startsWith('agent-'));
  }
  return [];
}

/** nonce → 任务 的归属表，以及重复的 nonce。
 *
 *  重复是**安静的错误**：一次 observe 会把痕迹记到「最后一个用这个 nonce 的任务」名下，
 *  不报错、不对账失败，只是结果错位。所以把它做成显式的返回值，调用方必须处理。 */
export function nonceOwners(tasks) {
  const map = new Map();
  const duplicates = [];
  for (const e of tasks || []) {
    if (!e || !e.nonce) continue;
    if (map.has(e.nonce)) duplicates.push(e.nonce);
    map.set(e.nonce, e.task);
  }
  return { map, duplicates: [...new Set(duplicates)] };
}

// ── 对账 ──────────────────────────────────────────────────────────────

/** 把台账行压成「每个任务一份期望 + 每个路径一份最新自述」。
 *  自述取**最后一条**：同一路径被同一个 agent 重写过两次，最后一次才是当前事实。
 *
 *  路径一律按 `pathKey` 归一化后再作 map 的键 —— 见 pathKey 的注释。
 *  行里保留原样的 `path`，报告打印的是人给出的那个字符串，不是归一化后的。 */
export function foldRows(rows, { base = ROOT } = {}) {
  const tasks = new Map();
  const claimsByTask = new Map();
  const observesByTask = new Map();
  const consumeByTask = new Map();

  const taskOf = (id) => {
    if (!tasks.has(id)) tasks.set(id, { task: id, role: null, nonce: null, timeoutMin: null, paths: [], firstAt: null });
    return tasks.get(id);
  };

  for (const r of rows || []) {
    const t = String(r.task || '');
    if (!t) continue;
    if (r.kind === 'expect') {
      const e = taskOf(t);
      if (r.role) e.role = r.role;
      if (r.nonce) e.nonce = r.nonce;
      if (Number.isFinite(r.timeoutMin)) e.timeoutMin = r.timeoutMin;
      for (const p of r.paths || []) {
        if (!e.paths.some((x) => pathKey(x, base) === pathKey(p, base))) e.paths.push(p);
      }
      if (!e.firstAt || r.ts < e.firstAt) e.firstAt = r.ts;
    } else if (r.kind === 'claim') {
      const m = claimsByTask.get(t) || new Map();
      m.set(pathKey(r.path, base), r);
      claimsByTask.set(t, m);
    } else if (r.kind === 'observe') {
      const m = observesByTask.get(t) || new Map();
      const k = pathKey(r.path, base);
      const prev = m.get(k);
      // 只要有一条成功记录就算「有这个痕迹」；失败记录单独留作证据
      if (!prev || prev.failed) m.set(k, r);
      observesByTask.set(t, m);
    } else if (r.kind === 'consume') {
      const s = consumeByTask.get(t) || new Set();
      s.add(r.path == null ? '*' : pathKey(r.path, base));
      consumeByTask.set(t, s);
    }
  }
  return { tasks, claimsByTask, observesByTask, consumeByTask };
}

/** 判断一次自述与磁盘是否一致。返回 `{ ok, weak, why }`。
 *
 *  弱比对的触发条件是**任一侧** hash 被截断：claim 记的是前 4 MiB 的 hash，
 *  磁盘侧也只算前 4 MiB，两者仍是可比的（同一段字节）；但如果文件在 claim 之后
 *  变成超过 4 MiB，尾部变化就看不见了。这种情况只判 `OK_WEAK`，不判 `DRIFTED` ——
 *  「没看出差异」不等于「没有差异」。 */
export function compareClaim(claim, disk) {
  if (!claim) return { ok: false, weak: false, why: '无自述' };
  if (!disk || !disk.exists) return { ok: false, weak: false, why: '自述说写了，磁盘上没有' };
  if (!claim.sha256) {
    // 自述里没有 hash（claim 时文件还不在，或 hash 读失败）→ 只能比字节数与时间
    if (Number.isFinite(claim.bytes) && claim.bytes !== disk.size) {
      return { ok: false, weak: false, why: `自述字节数 ${claim.bytes}，磁盘 ${disk.size}` };
    }
    return { ok: true, weak: true, why: '自述未带 hash，只比了字节数' };
  }
  if (!disk.sha256) return { ok: false, weak: false, why: '磁盘侧算不出 hash' };
  if (claim.sha256 !== disk.sha256) {
    return { ok: false, weak: false, why: 'hash 与自述不一致（文件在自述之后被改过）' };
  }
  const weak = claim.hashTruncated === true || disk.hashTruncated === true;
  return { ok: true, weak, why: weak ? 'hash 一致（双方均截断比对）' : 'hash 一致' };
}

/** 核心：四方对账。**纯函数**，磁盘状态由 `probe(path)` 注入。
 *
 *  输入：`rows`（台账全部行）、`probe`（`path => {exists,size,mtimeMs,sha256,hashTruncated}`）、
 *        `nowMs`。
 *  输出：`{ tasks, conflicts, extras, summary }`。
 *
 *  判定顺序（任务级）：
 *    1. 冲突：同一路径被 ≥2 个任务声明或自述 → `CONFLICT`（先于一切：两个都「成功」才是最坏）
 *    2. 无期望 → `NO-EXPECTATION`（规划缺陷）
 *    3. 全部 OK → `COMPLETE`
 *    4. 全部 ABSENT → `EMPTY`（没开工，和干到一半不是一回事）
 *    5. 有 OK 也有非 OK → `PARTIAL`（干到一半就停了）
 *    6. 其余按 MISSING > DRIFTED > UNREPORTED 取最坏 */
export function reconcile({ rows, probe = probeDisk, nowMs = Date.now(), base = ROOT } = {}) {
  const { tasks, claimsByTask, observesByTask, consumeByTask } = foldRows(rows, { base });

  // 路径 → 声明过它的任务集合。用于发现「两个 agent 写同一个文件」。
  // 键是 pathKey（归一化后的），值里保留原样路径供报告使用。
  const declaredBy = new Map();
  const display = new Map();
  const note = (p, task) => {
    const k = pathKey(p, base);
    const s = declaredBy.get(k) || new Set();
    s.add(task);
    declaredBy.set(k, s);
    if (!display.has(k)) display.set(k, p);
  };
  for (const e of tasks.values()) for (const p of e.paths) note(p, e.task);
  for (const [task, m] of claimsByTask) for (const row of m.values()) note(row.path, task);

  const conflicts = [];
  for (const [k, set] of declaredBy) {
    if (set.size > 1) conflicts.push({ path: display.get(k) || k, key: k, tasks: [...set].sort() });
  }
  const conflictKeysOf = (task) => new Set(conflicts.filter((c) => c.tasks.includes(task)).map((c) => c.key));

  const out = [];
  const extras = [];
  for (const e of tasks.values()) {
    const claims = claimsByTask.get(e.task) || new Map();
    const observes = observesByTask.get(e.task) || new Map();
    const consumed = consumeByTask.get(e.task) || new Set();
    const cKeys = conflictKeysOf(e.task);

    const items = [];
    for (const p of e.paths) {
      const k = pathKey(p, base);
      const claim = claims.get(k) || null;
      const observed = observes.get(k) || null;
      const disk = probe(p);
      let status;
      let why;
      if (claim) {
        const cmp = compareClaim(claim, disk);
        if (cmp.ok) { status = cmp.weak ? 'OK_WEAK' : 'OK'; why = cmp.why; }
        else if (!disk.exists) { status = 'MISSING'; why = cmp.why; }
        else { status = 'DRIFTED'; why = cmp.why; }
      } else if (disk.exists) {
        status = 'UNREPORTED';
        why = observed ? '文件在，transcript 有写它的调用，但没人自述' : '文件在，但没有人自述产出过它';
      } else {
        status = 'ABSENT';
        why = observed ? '有写它的调用，但文件不在——可能失败或被删' : '期望里有，磁盘没有';
      }
      if (observed && observed.failed) why += '（该写入调用报了错）';
      items.push({
        path: p, status, why,
        conflictWith: cKeys.has(k) ? conflicts.find((c) => c.key === k).tasks.filter((x) => x !== e.task) : null,
        claimedAt: claim ? claim.ts : null,
        claimAgent: claim ? claim.agent : null,
        observedAt: observed ? observed.ts : null,
        observedEvidence: observed ? observed.evidence : null,
        disk: disk.exists
          ? { size: disk.size, mtimeMs: Number.isFinite(disk.mtimeMs) ? Math.round(disk.mtimeMs) : null }
          : null,
      });
    }

    // transcript 里写过、但既不在期望里也没人自述的路径 —— 信息项。
    for (const [k, observed] of observes) {
      if (e.paths.some((p) => pathKey(p, base) === k) || claims.has(k)) continue;
      extras.push({
        task: e.task, path: observed.path, observedAt: observed.ts,
        evidence: observed.evidence, source: observed.source || 'write-tool',
      });
    }

    const okCount = items.filter((i) => i.status === 'OK' || i.status === 'OK_WEAK').length;
    let verdict;
    if (cKeys.size) verdict = 'CONFLICT';
    else if (!e.paths.length) verdict = 'NO-EXPECTATION';
    else if (okCount === items.length) verdict = 'COMPLETE';
    else if (items.every((i) => i.status === 'ABSENT')) verdict = 'EMPTY';
    else if (okCount > 0) verdict = 'PARTIAL';
    else if (items.some((i) => i.status === 'MISSING')) verdict = 'MISSING';
    else if (items.some((i) => i.status === 'DRIFTED')) verdict = 'DRIFTED';
    else verdict = 'UNREPORTED';

    // 「已认领」：每个期望路径都有一条 consume（或整任务的 `*`）。
    const allConsumed = e.paths.length > 0
      && (consumed.has('*') || e.paths.every((p) => consumed.has(pathKey(p, base))));

    // 最后一条产出证据的时间。**只用于展示静默时长**，不参与判定。
    const stamps = [
      ...items.map((i) => i.claimedAt),
      ...items.map((i) => i.observedAt),
      ...items.map((i) => i.disk && i.disk.mtimeMs != null ? new Date(i.disk.mtimeMs).toISOString() : null),
    ].filter(Boolean).sort();
    const lastEvidenceAt = stamps.length ? stamps[stamps.length - 1] : null;
    const silentMin = lastEvidenceAt ? Math.max(0, Math.round((nowMs - Date.parse(lastEvidenceAt)) / 60000)) : null;

    out.push({
      task: e.task, role: e.role, nonce: e.nonce, timeoutMin: e.timeoutMin,
      paths: e.paths, items, verdict, consumed: allConsumed,
      lastEvidenceAt, silentMin,
      // 静默超过声明的时间窗：描述，不是判据。见文件头。
      quiet: e.timeoutMin != null && silentMin != null && silentMin > e.timeoutMin,
    });
  }

  out.sort((a, b) => a.task.localeCompare(b.task));
  const failing = out.filter((t) => FAILING_VERDICTS.includes(t.verdict) || !t.consumed);
  return {
    tasks: out, conflicts, extras,
    summary: {
      total: out.length,
      complete: out.filter((t) => t.verdict === 'COMPLETE').length,
      failing: failing.length,
      unclaimed: out.filter((t) => !t.consumed).length,
      ok: out.length > 0 && failing.length === 0,
    },
  };
}

// ── 渲染 ──────────────────────────────────────────────────────────────

const VERDICT_MARK = {
  COMPLETE: '✓', PARTIAL: '◐', EMPTY: '·', UNREPORTED: '?',
  DRIFTED: '~', MISSING: '✗', CONFLICT: '‼', 'NO-EXPECTATION': '⚠',
};

export function formatReport(result, { nowMs = Date.now() } = {}) {
  void nowMs;
  const lines = [];
  const s = result.summary;
  if (!s.total) {
    lines.push('没有可对账的任务：台账里没有任何 expect 记录。');
    lines.push('这不是「全部完成」——是「从没登记过期望」。派活前先跑 declare。');
    return lines.join('\n');
  }
  lines.push(s.ok
    ? `对账通过：${s.total} 个任务的产出全部落地、与自述一致、且已被认领。`
    : `对账未通过：${s.total} 个任务里 ${s.failing} 个有缺陷（${s.unclaimed} 个未认领）。`);

  for (const t of result.tasks) {
    const mark = VERDICT_MARK[t.verdict] || '?';
    const bits = [`${mark} ${t.task}`, t.verdict];
    if (t.role) bits.push(t.role);
    if (t.lastEvidenceAt) bits.push(`末次产出 ${t.silentMin} 分钟前`);
    else bits.push('无任何产出痕迹');
    if (!t.consumed) bits.push('未认领');
    if (t.quiet) bits.push('（静默，非失败）');
    lines.push('  ' + bits.join(' · '));
    for (const it of t.items) {
      if (it.status === 'OK' && !it.conflictWith) continue;
      if (it.status === 'OK_WEAK' && !it.conflictWith) continue;
      const tail = [`[${it.status}]`, it.path, `— ${it.why}`];
      if (it.conflictWith) tail.push(`与 ${it.conflictWith.join(' / ')} 撞车`);
      if (it.observedEvidence) tail.push(`痕迹：${it.observedEvidence}`);
      lines.push('      ' + tail.join(' '));
    }
  }
  if (result.conflicts.length) {
    lines.push('');
    lines.push('冲突（同一文件被多个任务认领）：');
    for (const c of result.conflicts) lines.push(`  ‼ ${c.path} — ${c.tasks.join(' / ')}`);
  }
  if (result.extras.length) {
    lines.push('');
    lines.push('期望之外的写入（从 transcript 看到，信息项，不算缺陷）：');
    for (const x of result.extras) {
      const src = x.source === 'bash' ? ' [Bash]' : '';
      lines.push(`  + ${x.task} 写了 ${x.path}${src}${x.evidence ? `（${x.evidence}）` : ''}`);
    }
  }
  lines.push('');
  lines.push('注意：静默时长**不是失败判据**（state-model §2.0.1）。它只回答「要不要催」，不回答「要不要重跑」。');
  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i++;
  }
  return out;
}

const HELP = `claim-ledger — 产出对账

用法：
  node scripts/claim-ledger.mjs declare --run <id> --task <ST1> --paths a.md,b.mjs [--role executor] [--timeout-min 8]
  node scripts/claim-ledger.mjs claim   --run <id> --task <ST1> --path a.md [--agent <id>]
  node scripts/claim-ledger.mjs consume --run <id> --task <ST1> [--path a.md]
  node scripts/claim-ledger.mjs observe --run <id> --session <会话目录或主 transcript>
  node scripts/claim-ledger.mjs verify  --run <id> [--json]
  node scripts/claim-ledger.mjs adopt   --run <id>

说明：
  declare  派活前登记「这个任务该产出哪几个文件」。会打印一个 nonce，拼进 prompt。
  claim    子 agent 每落一个文件就追加一条自述（可选：没有它也能靠 observe 发现）。
  observe  从子 agent transcript 抽写入痕迹（Write/Edit + **路径可确定解析的 Bash 写入**）。
           **不需要子 agent 配合**。判不出的 Bash 命令会按类计数打印，不静默跳过。
           --no-bash 关掉 Bash 通道；--cwd <dir> 给没有逐条 cwd 的旧 transcript 一个兜底基准。
  verify   四方对账：期望 / 自述 / 磁盘 / transcript。
  adopt    列出「有产出但未被认领」的任务，供主线程崩溃重启后恢复。

退出码：0 通过 / 1 有缺陷 / 2 用法错误。
`;

function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0] || 'help';
  const runsDir = resolve(String(args['runs-dir'] || join(ROOT, 'tasks', 'runs')));
  const base = resolve(String(args.root || ROOT));
  const run = args.run ? String(args.run) : null;

  if (cmd === 'help' || args.help) { console.log(HELP); return 0; }
  if (!run) { console.error('缺少 --run <id>'); console.error(HELP); return 2; }
  const file = ledgerPath(runsDir, run);

  if (cmd === 'declare') {
    const task = args.task ? String(args.task) : null;
    if (!task) { console.error('缺少 --task'); return 2; }
    const paths = String(args.paths || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!paths.length) { console.error('缺少 --paths（逗号分隔）'); return 2; }
    const nonce = args.nonce ? String(args.nonce) : makeNonce();
    // 同一个 nonce 给两个任务，observe 时无法区分它们写的东西 —— 这属于派发缺陷，
    // 挡在写之前，比让对账结果错位之后再查便宜。
    const { rows: existing } = readLedger(file);
    const { duplicates, map } = nonceOwners([...foldRows(existing).tasks.values()]);
    void duplicates;
    if (map.has(nonce) && map.get(nonce) !== task) {
      console.error(`nonce ${nonce} 已属于任务 ${map.get(nonce)}，不能再给 ${task}。`);
      console.error('不要手写 --nonce，除非是在重跑同一个任务。');
      return 2;
    }
    const row = makeExpect({
      run, task, role: args.role ? String(args.role) : null, paths, nonce,
      timeoutMin: args['timeout-min'] ? Number(args['timeout-min']) : null,
    });
    appendRows(file, [row]);
    console.log(`已登记期望：${task} → ${paths.length} 个文件`);
    console.log(`nonce: ${nonce}`);
    console.log('把它拼进派发 prompt（例如 `nonce: ' + nonce + '`），observe 才能把 transcript 归属到这个任务。');
    return 0;
  }

  if (cmd === 'claim') {
    const task = args.task ? String(args.task) : null;
    const p = args.path ? String(args.path) : null;
    if (!task || !p) { console.error('claim 需要 --task 与 --path'); return 2; }
    // 基准与 verify 一致（默认仓库根，可用 --root 覆盖），否则两边会指向不同的文件。
    const disk = probeDisk(resolvePath(p, base));
    appendRows(file, [makeClaim({ run, task, agent: args.agent ? String(args.agent) : null, path: p, disk })]);
    console.log(`已记录自述：${task} → ${p}${disk.exists ? `（${disk.size} B）` : '（文件此刻不存在，已如实记录）'}`);
    return 0;
  }

  if (cmd === 'consume') {
    const task = args.task ? String(args.task) : null;
    if (!task) { console.error('consume 需要 --task'); return 2; }
    appendRows(file, [makeConsume({ run, task, path: args.path ? String(args.path) : null })]);
    console.log(`已认领：${task}${args.path ? ` → ${args.path}` : '（全部路径）'}`);
    return 0;
  }

  if (cmd === 'observe') {
    const session = args.session ? String(args.session) : null;
    if (!session) { console.error('observe 需要 --session <会话目录或主 transcript>'); return 2; }
    const { rows } = readLedger(file);
    const { tasks } = foldRows(rows);
    const { map: byNonce, duplicates: dupNonce } = nonceOwners([...tasks.values()]);
    // nonce 重复 = 归属塌陷：一次 observe 会把痕迹记到最后一个用这个 nonce 的任务名下。
    // 这不会报错，只会让对账结果悄悄错位，所以必须当面说。
    if (dupNonce.length) {
      console.error(`⚠ nonce 重复：${dupNonce.join(', ')} —— 这些任务会被混为一谈。`);
      console.error('  每个任务的 nonce 必须唯一。重跑 declare 时不要手写 --nonce，让脚本生成。');
      return 2;
    }
    const nonces = [...byNonce.keys()];
    const files = subagentTranscriptsOf(resolve(session));
    if (!files.length) {
      console.error(`没有找到子 agent transcript（查了 ${join(resolve(session).replace(/\.jsonl$/, ''), 'subagents')}）。`);
      console.error('这不是「没有产出」——是「看不到」。空结果不能当通过。');
      return 1;
    }
    const newRows = [];
    let attributed = 0;
    // Bash 通道默认开、可用 `--no-bash` 关。关掉之后行为与 2026-11-13 之前完全一致，
    // 保留开关是为了「怀疑 Bash 解析误判时能立刻排除它」，而不是为了常关。
    const useBash = args['no-bash'] !== true;
    const fallbackCwd = args.cwd ? String(args.cwd) : null;
    const skipped = { unresolved: 0, temp: 0, dirs: 0, inPlaceEdits: 0, dirTargets: 0 };
    for (const f of files) {
      const head = readHeadText(f);
      const nonce = findNonce(head, nonces);
      const task = nonce ? byNonce.get(nonce) : (args.task ? String(args.task) : null);
      if (!task) continue;
      attributed++;
      const { records } = readTailRecords(f, OBSERVE_TAIL_BYTES);
      const scan = observedWriteScan(records, { cwd: fallbackCwd, bash: useBash });
      for (const k of Object.keys(skipped)) skipped[k] += scan[k] || 0;
      for (const w of scan.writes) {
        // `cp a dst` 里 dst 是不是目录，命令行判不出（纯函数不许读盘）。
        // 磁盘能判：是目录就说明真正的产出是 `dst/<basename>`，而我们没解析它 ——
        // 记成目录路径会让 probeDisk 永远判 ABSENT。这类不写，改为计数。
        if (w.source === 'bash' && isDirectory(w.path)) { skipped.dirTargets++; continue; }
        newRows.push(makeObserve({
          run, task, agent: basename(f).replace(/^agent-/, '').replace(/\.jsonl$/, ''),
          path: w.path,
          evidence: `${basename(f)}#${w.index}${w.failed ? '（失败）' : ''}`
            + (w.source === 'bash' ? `（bash ${w.verb || 'cmd'} → ${w.path}）` : ''),
          failed: w.failed,
          source: w.source,
        }));
      }
    }
    if (!newRows.length) {
      console.error(`扫了 ${files.length} 份子 agent transcript，没有一份能归属到任务（nonce 对不上，也没有 --task）。`);
      console.error('归属不了就不写：把它们记到某个任务名下会让对账结果变成假的。');
      return 1;
    }
    appendRows(file, newRows);
    const bashCount = newRows.filter((r) => r.source === 'bash').length;
    console.log(`已记录 ${newRows.length} 条 transcript 痕迹，来自 ${attributed}/${files.length} 份子 agent transcript。`);
    if (useBash) {
      console.log(`  其中 ${bashCount} 条来自 Bash 命令解析（写工具 ${newRows.length - bashCount} 条）。`);
      // 看不见的部分必须可数：这些是「判不出」的，不是「没写」的。
      console.log(`  判不出、已跳过：动态路径 ${skipped.unresolved} 条 · 临时位置 ${skipped.temp} 条`
        + ` · 目录(非文件) ${skipped.dirs} 条 · 原地改写 ${skipped.inPlaceEdits} 条`
        + ` · 目标是已有目录 ${skipped.dirTargets} 条。`);
    }
    return 0;
  }

  if (cmd === 'verify') {
    if (!existsSync(file)) {
      console.error(`没有台账：${file}`);
      console.error('这不是「全部完成」——是「从没登记过期望」。');
      return 1;
    }
    const { rows, badLines } = readLedger(file);
    const result = reconcile({ rows, base, probe: (p) => probeDisk(p, base) });
    result.badLines = badLines;
    if (args.json) { console.log(JSON.stringify(result, null, 2)); }
    else {
      console.log(formatReport(result));
      if (badLines.length) {
        console.log('');
        console.log(`⚠ 台账里有 ${badLines.length} 行读不懂（已跳过，未计入对账）：`);
        for (const b of badLines.slice(0, 5)) console.log(`  第 ${b.line} 行：${b.raw}`);
      }
    }
    return result.summary.ok ? 0 : 1;
  }

  if (cmd === 'adopt') {
    if (!existsSync(file)) { console.error(`没有台账：${file}`); return 1; }
    const { rows } = readLedger(file);
    const result = reconcile({ rows, base, probe: (p) => probeDisk(p, base) });
    const pending = result.tasks.filter((t) => !t.consumed);
    if (!pending.length) { console.log('没有待认领的产出。'); return 0; }
    console.log(`待认领：${pending.length} 个任务`);
    for (const t of pending) {
      console.log('');
      console.log(`## ${t.task}（${t.verdict}）${t.lastEvidenceAt ? ` 末次产出 ${t.silentMin} 分钟前` : ''}`);
      for (const it of t.items) console.log(`  [${it.status}] ${it.path}`);
      console.log(`  认领：node scripts/claim-ledger.mjs consume --run ${run} --task ${t.task}`);
    }
    return 1;
  }

  console.error(`未知子命令：${cmd}`);
  console.error(HELP);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
