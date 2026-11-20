#!/usr/bin/env node
/**
 * link-check.mjs — 「文档里的相对链接指向不存在的文件」的唯一判据。
 *
 * 从 `check-links.mjs` 与 `check-structure.mjs` 的 `checkLinks()` 里抽出来，理由与
 * `published-paths.mjs`（`DF-039`）完全一样：**判据原来写在两个地方、其中一个是硬门
 * 脚本，而硬门脚本一被 import 就跑完全部门禁并 `process.exit()`，所以这条判据一条
 * 测试都写不了**。没有测试的判据守不住任何命题。
 *
 * 抽出的第二个理由更直接（`DF-040`）：两份实现都**用一份手写的文件清单**决定扫什么。
 *
 *   check-links.mjs      `['README.md', 'CLAUDE.md']` + `walk('docs')`
 *   check-structure.mjs  `['README.md', 'CLAUDE.md']` + `walkMd('docs')`
 *
 * 于是根目录的 `CONTRIBUTING.md` / `CONTRIBUTING-EN.md` / `SECURITY.md` / `SECURITY-EN.md`
 * 一份都不在扫描范围内，而两边都报「0 断链」。手写清单的失效方式是结构性的：
 * 下一次再加一份根级文档，它照样不在名单里，而门照样绿。所以这里**问 git**
 * （`git ls-files '*.md'`），和 `checkAbsolutePaths()` 判「会不会发出去」用的是同一个依据。
 *
 * 为什么不是「扫根目录所有 `.md`」或「walk 整个仓库」：工作区里有 `.scratch/`、
 * `.tmp-analysis/`、`docs/research/` 下五份 gitignored 的私有报告 —— 实测磁盘上
 * 839 份 `.md`，而**会随仓库发出去**的只有 170 份。按目录扫会把这 669 份也当成
 * 被守护的对象，报出一堆与产品无关的断链（`.tmp-analysis/` 里是别人的克隆）。
 * 判据要守的命题是「发出去的东西里链接不悬空」，那就只该扫会发出去的那些。
 *
 * 全部导出都是纯函数：给一段 markdown / 一个文件列表，答「哪些链接解析不到」。
 * 只有 `markdownFiles()` 会 spawn 一次 `git`（和 `checkAbsolutePaths()` 一样）。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';

// ── 代码块剥离 ────────────────────────────────────────────────────────
//
// **必须先剥代码块，否则判据会对着示例报错。** 文档里到处是「这条命令的输出长这样」
// 的围栏块，里面有形如 `[x](y)` 的示例（`docs/CHANGELOG.md` 就原样引用了一段
// `AI 说：「… [skill/output/](skill/output/) …」`）。GitHub 不把它们当链接，
// 判据也不该。行内代码（反引号）同理：`[x](y)` 在反引号里只是讲 markdown 语法。
//
// 围栏状态沿行推进、整块替换成空行 —— 保持行号不变，报错里才能给行号。
// 支持 `> ```` 这类引用块内的围栏（CommonMark 允许），以及 ``` / ~~~ 两种定界符。

/** @param {string} markdown @returns {string} 行数不变、代码内容被清空的文本 */
export function stripCode(markdown) {
  const out = [];
  let fence = null;                      // null = 不在围栏里；否则是围栏定界符
  for (const line of String(markdown || '').split('\n')) {
    const m = line.match(/^\s{0,3}(?:>\s*)*(`{3,}|~{3,})/);
    if (m) {
      const mark = m[1][0];
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;   // 只有同种定界符才闭合
      out.push('');
      continue;
    }
    out.push(fence ? '' : line.replace(/`[^`\n]*`/g, ''));
  }
  return out.join('\n');
}

// ── 标题锚点 ──────────────────────────────────────────────────────────
//
// GitHub 的 anchor 规则（实测对照 README.md / README-EN.md 的 4 条锚点链接反推）：
//   1. 小写；
//   2. 删掉所有标点与符号 —— **含 emoji**（`## 🚀 30 秒上手` → `-30-秒上手`，
//      emoji 被删、紧随的空格变成连字符，所以开头有一个 `-`）；
//   3. 空格变连字符；保留汉字、字母、数字、下划线与已有的连字符；
//   4. 同名标题第 2 次出现追加 `-1`，第 3 次 `-2`（`dedupe` 的语义）。
//
// 不剥标题里反引号的内容：`### 用 \`foo()\`` 的 slug 是 `用-foo`（括号被删、反引号被删），
// 与去掉整个 code span 的结果不同。

/** @param {string} heading 标题原文（不含 `#`） @returns {string} */
export function slugifyAnchor(heading) {
  return String(heading || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '')
    .replace(/ /g, '-');
}

/** 一份文档里全部可跳转的锚点（已处理重名）。 @param {string} markdown @returns {Set<string>} */
export function anchorsOf(markdown) {
  const seen = new Map();
  const out = new Set();
  for (const line of stripCode(markdown).split('\n')) {
    // `## 标题 ##` 的收尾井号不是标题文字的一部分。
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const base = slugifyAnchor(m[1]);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

// ── 链接提取 ──────────────────────────────────────────────────────────

/** 链接是外部地址（`https:` / `mailto:` / 协议相对 `//host`）时为 true。
 *  判据不能去解析 `[^)\s]+` 之外的东西，所以先按协议头整类排除 —— 否则
 *  `https://x/a.md` 会被当成仓库内的相对路径去核。 */
export function isExternalLink(link) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(String(link || ''));
}

/**
 * 抽出全部行内链接（含 `![](img.png)` 图片），带 1-based 行号。
 * 代码块与行内代码已剥离 —— 里面的示例不是链接。
 * 参考式链接（`[x]: url`）本仓库一篇都没有（实测：0 条），故不实现；真要有人用了，
 * 它们不会被这里看见，也不会被误报 —— 报假比漏报好，但漏报在这里不会让门变绿而看不见，
 * 因为这个仓库的链接一律是行内式，`checkDocReferences()` 另有按路径的正则兜着。
 * @param {string} markdown @returns {{link:string, line:number}[]}
 */
export function linkOccurrences(markdown) {
  const out = [];
  const stripped = stripCode(markdown);
  stripped.split('\n').forEach((line, i) => {
    // 目标里允许一个可选的 `"title"`；`<...>` 尖括号写法也接受（本仓当前 0 条）。
    for (const m of line.matchAll(/\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
      const raw = m[1].startsWith('<') ? m[1].slice(1, -1) : m[1];
      out.push({ link: raw, line: i + 1 });
    }
  });
  return out;
}

// ── 扫描范围 ──────────────────────────────────────────────────────────

/** 会随仓库发出去的 `.md`：`git ls-files`（已跟踪）+ `--others --exclude-standard`
 *  （未跟踪但**没被忽略**）。后者是必要的：新写的文档在 `git add` 之前也得被核，
 *  否则「写完没提交」这一段恰好是没有任何门看着的。被忽略的（`docs/research/`
 *  下五份私有报告、`.scratch/`、`.tmp-analysis/`）不扫。
 *
 *  git 不可用时（解压后的发布包）回落到目录遍历：根级 + docs/ + templates/ + tasks/。
 *  回落**只覆盖已知目录**，不是「整个仓库」—— 理由见文件头（工作区里有 669 份
 *  别人的、被忽略的 `.md`）。
 * @param {string} root @returns {string[]} 仓库相对路径（`/` 分隔），已排序
 */
export function markdownFiles(root) {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '*.md'],
    { cwd: root, encoding: 'utf8', timeout: 20000 });
  if (r.status === 0) {
    return r.stdout.split('\0').filter(Boolean).map((p) => p.split(sep).join('/')).sort();
  }
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = resolve(root, dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(relative(root, p).split(sep).join('/'));
    }
  };
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.md')) out.push(e.name);
  }
  for (const d of ['docs', 'templates', 'tasks']) walk(d);
  return [...new Set(out)].sort();
}

/** 「这个仓库相对的路径会不会随仓库发出去」—— 判据与 `markdownFiles()` 同一来源。
 *  给 `null` 表示无法判定（git 不可用），调用方跳过这半条检查。
 *  @param {string} root @returns {Set<string>|null} */
export function publishableFiles(root) {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) return null;
  return new Set(r.stdout.split('\0').filter(Boolean).map((p) => p.split(sep).join('/')));
}

// ── 判据主体 ──────────────────────────────────────────────────────────

/**
 * 逐条核一份文档里的相对链接。
 *
 * @param {object} o
 * @param {string} o.root  仓库根（绝对路径）
 * @param {string} o.file  被扫文件的仓库相对路径
 * @param {string} o.text  文件内容
 * @param {Set<string>|null} [o.publishable] 会随仓库发出去的路径集；null = 不判这半条
 * @param {(p:string)=>string} [o.repoPath] 目标绝对路径 → 仓库相对路径（`/` 分隔）
 * @returns {{link:string, line:number, kind:'MISSING'|'ANCHOR'|'UNPUBLISHED'}[]}
 */
export function checkFileLinks({ root, file, text, publishable = null, repoPath }) {
  const bad = [];
  const fileDir = dirname(resolve(root, file));
  const relOf = repoPath || ((abs) => relative(root, abs).split(sep).join('/'));

  for (const { link, line } of linkOccurrences(text)) {
    if (isExternalLink(link)) continue;
    const [rawPath, rawHash] = link.split('#');
    let target = resolve(root, file);          // 纯锚点链接：目标是本文件
    let decodedPath = rawPath;
    if (rawPath) {
      // 百分号编码是合法的 `[x](a%20b.md)`；解不开就按原样用 —— 宁可报 MISSING，
      // 也不要在判据里 try/catch 吞掉一个真错误。
      try { decodedPath = decodeURIComponent(rawPath); } catch { /* 保持原样 */ }
      target = resolve(fileDir, decodedPath);
      if (!existsSync(target)) { bad.push({ link, line, kind: 'MISSING' }); continue; }
      // 目录链接（`[ADR](adr/)`）只要目录存在即可，GitHub 会列目录内容。
      if (!statSync(target).isFile()) continue;
      // 存在但不会发出去 = 干净 clone 上必然断。`docs/research/` 下五份私有报告
      // 就是这一类：链上去在本机绿、在 GitHub 红。
      if (publishable && !publishable.has(relOf(target))) {
        bad.push({ link, line, kind: 'UNPUBLISHED' });
        continue;
      }
    }
    if (!rawHash) continue;
    let want = rawHash;
    try { want = decodeURIComponent(rawHash); } catch { /* 保持原样 */ }
    let targetText;
    try { targetText = readFileSync(target, 'utf8'); } catch { continue; }
    if (!anchorsOf(targetText).has(want.toLowerCase())) bad.push({ link, line, kind: 'ANCHOR' });
  }
  return bad;
}

/** 扫一批文件，返回 `{checked, broken[](含 file), files}`。
 *  @param {object} o
 *  @param {string} o.root
 *  @param {string[]} [o.files] 不给则用 `markdownFiles(root)`
 *  @param {boolean} [o.checkPublishable] 是否核「目标会不会发出去」（默认 true）
 */
export function scanLinks({ root, files, checkPublishable = true }) {
  const list = files || markdownFiles(root);
  const publishable = checkPublishable ? publishableFiles(root) : null;
  let checked = 0;
  const broken = [];
  for (const file of list) {
    let text;
    try { text = readFileSync(resolve(root, file), 'utf8'); } catch { continue; }
    const bad = checkFileLinks({ root, file, text, publishable });
    broken.push(...bad.map((b) => ({ ...b, file })));
    // 计数口径：本次实际核过的相对链接数（外部地址、代码块内示例不计）。
    checked += linkOccurrences(text).filter((o) => !isExternalLink(o.link)).length;
  }
  return { checked, broken, files: list.length };
}

/** 三类断链面向人的说明。`check-structure.mjs` 也用它拼违规文本 —— 两个入口
 *  说同一件事，措辞不该漂移。 */
export const KIND_TEXT = {
  MISSING: '指向不存在的文件',
  ANCHOR: '锚点在该文件里不存在',
  UNPUBLISHED: '目标文件被 gitignore 忽略（干净 clone 上必然断）',
};

/** 面向人的一行描述。 @param {{file:string,link:string,line:number,kind:string}} b */
export function describeBroken(b) {
  return `死链  ${b.file}:${b.line}  →  ${b.link}  （${KIND_TEXT[b.kind] || b.kind}）`;
}
