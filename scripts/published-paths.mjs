#!/usr/bin/env node
/**
 * published-paths.mjs — 「可发布区出现过本机绝对路径」的唯一判据。
 *
 * 从 `check-structure.mjs` 抽出来，只为了**能单测**：硬门脚本一被 import 就会跑完
 * 全部门禁并 `process.exit()`，所以它的判据以前一条测试都没有 —— 这正是本源缺陷
 * （`DF-039`）能活下来的原因：正则只认 7 个固定前缀，凡是不在这 7 个里的目录
 * 全部漏过，而硬门一直报绿。具体漏过的字面量写在 `published-paths.test.mjs` 里
 * （测试文件本身被 `PATH_EXEMPT` 豁免，可以写真实形态；本文件在可发布区，不能）。
 *
 * 抽出的判据全部是**纯函数**：给一段文本，答「哪些子串像本机绝对路径」以及
 * 「它们是不是合法的占位符/示例」。不做 IO，不看平台，不认路径是否存在。
 */

// ── 盘符绝对路径 ──────────────────────────────────────────────────────
//
// 演进：原判据是
//   /[A-Za-z]:[\\/](?:Users|Projects|Server|Java|maven|Nodejs|Git)[^\s)"'`]*/g
// **只认 7 个前缀**，而这 7 个恰好是作者本机装过东西的目录名。于是判据实际守的是
// 「作者这台机器上那 7 个目录没被写进文档」，而不是「可发布区没有本机绝对路径」。
// 真实漏过的三种形态（负向用例逐条钉住）：
//   · 非已知前缀的目录树        `D:\<app>\<sub>\<file>`
//   · 目录名含空格的应用安装位  `D:\<App Name>\<app>.exe`
//   · 任意伪造目录              `D:\<made-up-dir>\<file>`
//
// 现在认**任意盘符**。三个细节各自有代价，写在这里：
//
//  1. `(?<![A-Za-z0-9])`：防止把 URL 里的 `http://x` 认成 `p:/`。
//     代价是 `fooD:\x` 这种紧贴在字母后的路径会漏 —— 现实里没有这种写法。
//  2. 结束符里包含**全角标点**（`（）、。，；：！？`）：中文行文里路径后面紧跟着
//     就是 `（…）` 或 `。`，不排除的话匹配会把整句吞进来。代价：路径本身含全角
//     标点时会被截断 —— 但截断后的前缀**照样触发违规**，只是提示变短。
//  3. 允许**单个空格**，条件是空格后面的第一个字符能作为路径的下一段。
//     这条规则被自己的用例打回过一次：两条相邻路径曾被粘成一条（第二段的盘符
//     字母恰好是 ASCII 字母，通过了「下一段」的判断）。现在的写法在空格后
//     **再排除**「盘符 + 分隔符」这个开头，用例 `§4` 钉住它。
//     `<drive>:\<App Name>\<app>.exe` 这类安装路径真实存在（程序目录名带空格很常见），
//     不允许空格就只会报出前半截。代价：中文行文里的 `D:\<repo> 里的文件` 不会被
//     多吞（中文不是 ASCII 单词字符），命令行里的 `D:/work/<x>.exe --no-hooks`
//     也不会把参数吞进路径（`-` 不算单词字符）。
export const WIN_ABS_RE =
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?:[^\s"'`()<>|{}[\]（）、。，；：！？#]| (?=[A-Za-z0-9_.])(?![A-Za-z]:[\\/]))*/g;
// ── POSIX 家目录绝对路径 ──────────────────────────────────────────────
//
// 「本机绝对路径」不只是盘符。本仓库有跨平台面（CI 在 Linux 上跑、`docs/` 里大量
// 讨论 POSIX 行为），而 `~/code/x`、`<macOS home>/<name>/x` 泄露的信息与
// `<drive>:\Users\<name>\x` 同类：用户名 + 目录结构。所以一并认。
//
// **只认家目录下带用户名的那一类**（`/home/<name>`、`/Users/<name>`、`/root/<name>`），
// 不认 `/tmp`、`/var/tmp`、`/opt`：那些是系统公共目录，出现在示例里不含本机身份，
// 全认只会制造噪声。也不认裸的 `/home/`、`/Users/`、`/root/`（无名可泄漏）。
export const POSIX_ABS_RE = /(?<![A-Za-z0-9:./\\])\/(?:home|Users|root)\/[^\s"'`()<>|{}[\]（）、。，；：！？#]+/g;

/** 命中里允许出现的「占位符用户名」。不是白名单目录，是这个**用户名本身**就是假的。 */
const PLACEHOLDER_USERS = new Set(['alice', 'bob', 'user', 'username', 'u', 'me', 'you', 'your-name', 'someone', 'example']);

/** 归一化：反斜杠转正斜杠、折叠重复分隔符、去掉尾部标点与分隔符。
 *  **不折大小写** —— 归一化只该做「同一个写法」的事，大小写是比对时的语义，
 *  放在 `pathKeyOf()` 里做（见下）。混在一起会让 `normalizePathHit` 的输出
 *  连调试时都读不出原样。 */
export function normalizePathHit(hit) {
  let s = String(hit || '').trim();
  s = s.replace(/[.,;]+$/, '');           // 行文里的 "…\x." 尾部句点
  s = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!/^[A-Za-z]:\/$/.test(s)) s = s.replace(/\/$/, '');
  return s;
}

/** 白名单比对用的键：归一化 + 折小写。
 *  Windows 路径不区分大小写，`C:\Windows` 与 `c:/windows` 在磁盘上是同一个目录——
 *  白名单若区分大小写，它守的就不是「这条路径是否本机私有」。 */
export const pathKeyOf = (hit) => normalizePathHit(hit).toLowerCase();

/**
 * 已审阅的**合成示例**路径（归一化后精确匹配，不做前缀匹配）。
 *
 * 每一条都是「这句话在讲 Windows 路径长什么样」，不是某台机器的真实位置。
 * 清单要短、要可读：它是「人确认过这些是假的」的记录，不是过滤器。
 *
 * **不在这里的东西**（有意）：任何看起来像真项目/真安装位置的路径。它们是本机事实，
 * 要么脱敏成 `<repo>` / `<app-home>` / `D:\…`，要么留在 `tasks/` 私有区。
 * 白名单只收「作者本人能一眼认定是假的」那几条，宁可少收 —— 往白名单里加一条
 * 真路径，等于把「泄漏」改写成「已审阅」。
 */
export const PLACEHOLDER_LITERALS = new Set([
  // ── 语法示例：教学用的最少字符（`D:\x`、`C:\repo\a.md` 这类）────────────
  'c:/tmp',
  'd:/x',
  'c:/a.md',
  'c:/repo/a.md',
  'd:/repo/work/a.md',
  'd:/repo/1',
  'd:/foo',
  'd:/c/x',
  // ── 判据测试/演示用的假项目（`nope`、`a`/`b` 对比）───────────────────
  'z:/nope/none.exe',
  'd:/work/nope.exe',
  'd:/a',
  'd:/a/b',
  'd:/a/pom.xml',
  'd:/a/b/pom.xml',
  // `D:/a/b-c` 与 `D:/a/b/c` 是「slug 编码不可逆、有真碰撞」的**构造**对照：
  // 两个不同的路径必须编成同一个 slug 才能演示碰撞，所以它只能是单字母假路径。
  'd:/a/b-c',
  'd:/a/b/c',
  'd:/a-b',
  'd:/a b',
  // 讲「判据对任意 cwd 都成立」时的示范：`anywhere` 是字面意义上的「随便哪儿」。
  'd:/anywhere/.claude/.ow-anything',
  // 讲 sed 参数解析时用的假仓库根与假脚本名。
  'd:/repo/1,30p',
  // 中文占位符：字面意思就是「你的项目」/「很长/路径」，不是任何一台机器的真实位置。
  'd:/你的项目',
  'd:/很长/路径/pom.xml',
  // ── 泛化例子 ────────────────────────────────────────────────────────
  //  讲「路径可以出现在任意盘符」时用的单字母路径，指的是字母本身。
  'a:/b',
  // ── Windows 自带目录：不是本机标识（每台 Windows 都有）──────────────
  //  `scripts/notify.mjs` 与 `scripts/install-watcher.mjs` 里 `'C:\Windows'` 是
  //  `process.env.SystemRoot` 取不到时的回落值，属于代码而非本机信息。
  'c:/windows',
  'c:/program files',
  'c:/programdata',
]);

// **关于本仓库自己的路径（`<drive>:\\Projects\\Overwatch`）—— 判为「不加白名单」。**
//
// 实测（2026-11-20，改完新正则第一次跑）：非豁免区（= 除 `*.test.mjs` 之外的可发布区）
// **一条都没有**。它只出现在 `scripts/*.test.mjs` 里，而那类文件本来就被 `PATH_EXEMPT`
// 豁免（测试必须写真实的盘符形态才能验判据）。
//
// 既然没有任何文档需要引用自己的本机路径，给它开一条前缀白名单就是凭空开洞：
// 那会把「`<仓库根>/.tmp-analysis/x`」这类**本机临时目录布局**一并放行，
// 而那正是本判据该抓的东西。脱敏成本是零（写 `<repo>` 即可），所以不开。
//
// 反过来说：如果将来某份文档真的需要写自己的 clone 路径，先加**那一条精确字面量**，
// 不要加前缀 —— 逐条加会有人核对，前缀不会。

/**
 * 判一条命中是不是「合法的占位符 / 示例」。
 * @param {string} hit 正则命中的原文
 * @param {string} [nextChar] 命中后紧跟的那个字符（用来识别 `D:\Projects\<A>` 这类）
 */
export function isPlaceholderPath(hit, nextChar = '') {
  const raw = String(hit || '');
  // 省略号：`D:\…`、`C:\...\proj`、`D:\\…\\testharness`。占位符最常用形态。
  // 这一条**必须在归一化之前**判：归一化会把 `\` 折成正斜杠，`\...` 就变成 `/...`，
  // 但 `D:\…` 里的 `…` 仍在 —— 两个写法都在原文里查更直接。
  if (raw.includes('\u2026')) return true;          // …
  if (/\.\.\./.test(raw)) return true;              // ...

  // 紧跟 `<`：`D:\Projects\<A>` —— 规范化已经换成尖括号占位符了，路径本身是示意。
  // 这一条让「脱敏做对了」的文档天然通过，不必再往白名单里加一条。
  // 注意 must-fail 的一侧：`D:\Projects\<A>` 的命中止于 `\`（`<` 是结束符），
  // 所以 `nextChar` 才是 `<`，不是路径里含 `<`。
  if (nextChar === '<') return true;

  const n = normalizePathHit(raw);

  // 裸盘符根：`C:\`、`C:/`、`A:\`，以及只剩盘符的 `C:` —— 讲「什么算绝对路径」
  // 时的例子，无信息量。
  if (/^[A-Za-z]:\/?$/.test(n)) return true;

  const key = pathKeyOf(n);
  if (PLACEHOLDER_LITERALS.has(key)) return true;

  // POSIX：用户名本身是占位符（`/home/alice/code/repo`）。
  const m = key.match(/^\/(?:home|users|root)\/([^/]+)/);
  if (m && PLACEHOLDER_USERS.has(m[1])) return true;

  return false;
}

/** 扫一段文本，返回全部「本机绝对路径」命中（不过滤占位符）。
 *  @returns {{path:string, index:number, nextChar:string}[]} */
export function findAbsolutePaths(text) {
  const s = String(text || '');
  const out = [];
  for (const re of [WIN_ABS_RE, POSIX_ABS_RE]) {
    // 每个正则各跑一遍：`g` 标志的正则有 lastIndex 状态，用 matchAll 才不会串味。
    for (const m of s.matchAll(new RegExp(re.source, re.flags))) {
      out.push({ path: m[0], index: m.index, nextChar: s[m.index + m[0].length] || '' });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** 面向硬门的结果：只留**需要人处理**的命中，带行号。
 *  同一行同一路径只报一次（避免一个文件里同一句重复十遍）。
 *  @returns {{line:number, path:string}[]} */
export function publishedPathViolations(text) {
  const s = String(text || '');
  const lineOf = lineIndexer(s);

  const seen = new Set();
  const out = [];
  for (const h of findAbsolutePaths(s)) {
    if (isPlaceholderPath(h.path, h.nextChar)) continue;
    const line = lineOf(h.index);
    const key = `${line}\u0000${h.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line, path: h.path });
  }
  return out;
}

/** 字符下标 → 1-based 行号的二分查找。两处判据共用，避免各写一份写歪。 */
function lineIndexer(s) {
  const lineStarts = [0];
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') lineStarts.push(i + 1);
  return (idx) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ── 已知本机标识符（散列黑名单）────────────────────────────────────────
//
// **为什么需要第二个判据**：`WIN_ABS_RE` 只认「盘符 + 分隔符」开头的路径。
// 2026-11-21 漏掉的那一处**没有盘符前缀**：TUI 截图的「路径副行」列里只印了目录名
// （`tui-layout.mjs` 的 `shortPath()` 会剥掉盘符与父目录），于是一个真实的中文项目名
// 裸露在 `docs/research/` 里，而硬门一直是绿的。判据守的命题是「可发布区没有本机
// 事实」，盘符只是它的一种形态 —— 所以缺的这一条不是「正则再宽一点」，而是另一类输入。
//
// **为什么存散列而不是名字**：这本书是**公开**仓库。把「已知真实项目名」以明文写进
// 判据文件，等于把泄漏从一份文件搬到另一份（本仓已经踩过一次：把 8 条原文抄进
// CHANGELOG，硬门立刻多报 10 项）。散列让判据可执行而不可读回。
//
// **代价（说清楚，别假装免费）**：
//  1. 这是**黑名单**：只抓登记过的那几个名字。没登记的真实名字照样漏 —— 与
//     `verify-claims.mjs` 里那句「那种黑名单永远漏词」是同一个局限。它的价值不在
//     「覆盖所有泄漏」，而在「同一条泄漏不会第二次悄悄回来」。
//  2. 登记一条要**知道原文**（作者本机才知道），所以清单没法在仓内自证。
//     验证办法（只在作者机器上跑）：
//       node --input-type=module -e "import {knownIdentifierKeyOf} from
//       './scripts/published-paths.mjs'; console.log(JSON.stringify(
//       knownIdentifierKeyOf('<真实名字>')))"
//     输出必须与下表条目逐字相同。真实名字不得写进仓内任何文件。
//  3. 每次跑硬门多一遍全文滑窗扫描：实测 4.5 MB 可发布区 **约 130 ms**
//     （每个长度一遍；条目越多越慢，所以清单要短）。
const ID_BASES = [131, 977];

function identHashOf(s, base) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * base + s.charCodeAt(i)) | 0;
  return h;
}

/** 把一个名字换成可安全入库的键（长度 + 两个不同基的多项式散列）。
 *  导出的目的是**手工登记与复核**：它不读盘、不比较，只做算术。 */
export function knownIdentifierKeyOf(name) {
  const s = String(name || '');
  return { len: s.length, hashes: ID_BASES.map((b) => identHashOf(s, b)) };
}

/** 已登记的本机标识符。**只放散列，永远不要放名字。**
 *
 *  加条目的唯一场合：某条真实本机事实泄漏被修掉之后。加之前先确认它在修正后的
 *  可发布区**一条都搜不到**，否则硬门会立刻红 —— 那正是它该有的行为。
 */
export const KNOWN_LOCAL_IDENTIFIERS = Object.freeze([
  Object.freeze({
    len: 6,
    hashes: Object.freeze([-773214593, 1740706537]),
    note: 'DF-039 第二轮：一个本机中文项目名。2026-11-21 在 TUI 截图里裸奔（无盘符前缀），'
      + '路径正则抓不到；同一名字已在 research 论文与脚本注释里脱敏',
  }),
]);

/** 扫出「已知本机标识符」出现的位置，只报行号（不回报原文，回报就又是泄漏）。
 *
 *  不用分词，直接对全文滑窗：本判据的输入是「任意上下文里出现这串字」，
 *  而分词会把「紧贴路径分隔符的那一形态」切开。代价是窗口数 ≈ 字节数，
 *  实测 4.5 MB 约 130 ms。
 *
 *  @param {string} text
 *  @param {readonly {len:number, hashes:number[], note?:string}[]} [list]
 *  @returns {{line:number, note:string}[]} 同一行同一条目只报一次 */
export function findKnownIdentifiers(text, list = KNOWN_LOCAL_IDENTIFIERS) {
  const s = String(text || '');
  const entries = (list || []).filter((e) => e && Number.isInteger(e.len) && e.len > 0
    && Array.isArray(e.hashes) && e.hashes.length === ID_BASES.length);
  if (!s.length || !entries.length) return [];

  const byLen = new Map();
  for (const e of entries) {
    if (!byLen.has(e.len)) byLen.set(e.len, []);
    byLen.get(e.len).push(e);
  }

  const lineOf = lineIndexer(s);
  const hitLines = new Map();                 // `${line}\u0000${note}` → 去重
  for (const [len, group] of byLen) {
    if (s.length < len) continue;
    const pow = ID_BASES.map((B) => {
      let p = 1;
      for (let i = 0; i < len - 1; i++) p = (p * B) | 0;
      return p;
    });
    const h = ID_BASES.map((B) => {
      let x = 0;
      for (let i = 0; i < len; i++) x = (x * B + s.charCodeAt(i)) | 0;
      return x;
    });
    const check = (endIdx) => {
      for (const e of group) {
        if (e.hashes[0] !== h[0] || e.hashes[1] !== h[1]) continue;
        const line = lineOf(endIdx - len);
        const key = `${line}\u0000${e.note || ''}`;
        if (!hitLines.has(key)) hitLines.set(key, { line, note: e.note || '' });
      }
    };
    check(len);
    for (let i = len; i < s.length; i++) {
      const c = s.charCodeAt(i);
      for (let k = 0; k < ID_BASES.length; k++) {
        h[k] = (((h[k] - s.charCodeAt(i - len) * pow[k]) | 0) * ID_BASES[k] + c) | 0;
      }
      check(i + 1);
    }
  }
  return [...hitLines.values()].sort((a, b) => a.line - b.line);
}
