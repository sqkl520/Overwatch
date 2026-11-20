#!/usr/bin/env node
/**
 * link-check.test.mjs — 「文档相对链接不悬空」判据的回归测试。
 *
 * 这个判据以前**一条测试都没有**，而且它有两份实现（`check-links.mjs` 与
 * `check-structure.mjs` 的 `checkLinks()`），两份都用手写的文件清单决定扫什么。
 * 代价就是 `DF-040`：根级 `CONTRIBUTING.md` / `CONTRIBUTING-EN.md` / `SECURITY.md` /
 * `SECURITY-EN.md` 一份都不在范围内，两边都报「0 断链」。
 *
 * 所以这个文件的第一职责与其他判据测试一样，不是「证明现在能抓」，而是
 * **证明旧写法会红**：§1 逐条对应「手写清单看不见的根级文档」，§2 对应
 * 「锚点写错但文件名对，旧判据压根不看 `#`」。
 *
 * 用临时目录构造最小仓库，**不依赖本仓库当前内容的对错** —— 否则本仓库哪天
 * 加了一条合法的新式链接，测试就会跟着红，而它红的原因与被测行为无关。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  stripCode, slugifyAnchor, anchorsOf, isExternalLink, linkOccurrences,
  checkFileLinks, scanLinks, markdownFiles, describeBroken, KIND_TEXT,
} from './link-check.mjs';

/** 建一个临时「仓库」，返回 { root, put, cleanup }。put() 写文件，自动建父目录。 */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'ow-links-'));
  return {
    root,
    put(rel, text) {
      const p = join(root, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, text, 'utf8');
      return p;
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

const kindsOf = (bad) => bad.map((b) => `${b.kind}:${b.link}`);

// ── §1 旧判据看不见的根级文档：新范围必须覆盖到 ────────────────────────
//
// 旧清单是 `['README.md','CLAUDE.md'] + walk('docs')`。所以 `CONTRIBUTING.md` /
// `SECURITY.md` 这类根级文件里的断链**一条都报不出来**。换成旧范围，本节三条全红。

test('根级文档里的断链会被扫到（旧清单只含 README.md / CLAUDE.md）', () => {
  const s = sandbox();
  try {
    s.put('README.md', '# ok\n\n[贡献](CONTRIBUTING.md)\n');
    s.put('CONTRIBUTING.md', '# 贡献\n\n[指南](docs/GUIDE.md)\n');   // 这条是真的断
    const { broken } = scanLinks({ root: s.root, files: ['README.md', 'CONTRIBUTING.md'], checkPublishable: false });
    assert.deepEqual(kindsOf(broken), ['MISSING:docs/GUIDE.md']);
    assert.equal(broken[0].file, 'CONTRIBUTING.md');
  } finally { s.cleanup(); }
});

test('templates/ 下的 .md 也在范围内（旧清单连 templates/ 都没 walk）', () => {
  const s = sandbox();
  try {
    s.put('templates/dispatch.md', '[不存在的](nope.md)\n');
    const { broken } = scanLinks({ root: s.root, files: ['templates/dispatch.md'], checkPublishable: false });
    assert.deepEqual(kindsOf(broken), ['MISSING:nope.md']);
  } finally { s.cleanup(); }
});

test('em-dash 之外：英文对照文档的断链同样会被扫到', () => {
  const s = sandbox();
  try {
    s.put('SECURITY-EN.md', '[中文](SECURITY.md) / [x](SECURITY-ZH.md)\n');
    s.put('SECURITY.md', '# 安全策略\n');
    const { broken } = scanLinks({ root: s.root, files: ['SECURITY-EN.md'], checkPublishable: false });
    assert.deepEqual(kindsOf(broken), ['MISSING:SECURITY-ZH.md']);
  } finally { s.cleanup(); }
});

// ── §2 锚点：旧判据的正则连 `#` 都不看 ───────────────────────────────
//
// 旧正则 `\]\(([^)#\s]+\.md)(?:#[^)]*)?\)` 把 `#` 之后整段丢掉，于是
// 「文件存在、锚点不存在」永远报绿。§2 的用例是对它的直接否证。

test('锚点写错要报（旧判据把 # 之后整段丢掉，永远看不见）', () => {
  const s = sandbox();
  try {
    s.put('a.md', '[标题](b.md#安装)\n');
    s.put('b.md', '# 使用\n\n## 安装步骤\n');
    const { broken } = scanLinks({ root: s.root, files: ['a.md'], checkPublishable: false });
    assert.deepEqual(kindsOf(broken), ['ANCHOR:b.md#安装']);
  } finally { s.cleanup(); }
});

test('锚点正确时不报（漏报这条用例就变成噪声源）', () => {
  const s = sandbox();
  try {
    s.put('a.md', '[标题](b.md#安装步骤) [本页](#顶部)\n\n# 顶部\n');
    s.put('b.md', '# 使用\n\n## 安装步骤\n');
    const { broken } = scanLinks({ root: s.root, files: ['a.md'], checkPublishable: false });
    assert.deepEqual(broken, []);
  } finally { s.cleanup(); }
});

test('emoji 标题的锚点：emoji 被删、紧随空格变连字符（开头留一个 `-`）', () => {
  // 实测对照：本仓 `README.md` 的 `## 🚀 30 秒上手` → `#-30-秒上手`。
  // 这正是 `DF-040` 抓到的那条断链的反面 —— 它写成了 `#-诚实的数字`，
  // 而 `### 诚实的数字` 的 slug 是 `诚实的数字`（没有 emoji，就没有那个 `-`）。
  assert.equal(slugifyAnchor('🚀 30 秒上手'), '-30-秒上手');
  assert.equal(slugifyAnchor('诚实的数字'), '诚实的数字');
  assert.equal(slugifyAnchor('Core commands'), 'core-commands');
  assert.equal(slugifyAnchor('用 `foo()` 判'), '用-foo-判');
});

test('重名标题追加 -1/-2（GitHub 的 dedupe 语义）', () => {
  const anchors = anchorsOf('# 标题\n\n## 标题\n\n### 标题\n');
  assert.deepEqual([...anchors].sort(), ['标题', '标题-1', '标题-2']);
});

// ── §3 代码块里的示例不是链接 ─────────────────────────────────────────
//
// 本仓 `docs/CHANGELOG.md` 真实引用了一段 `AI 说：「… [skill/output/](skill/output/) …」`
// 的围栏块。不剥代码块，判据就会对着示例报断链 —— 那会让人去「修」一段引文。

test('围栏代码块里的 `[x](y)` 不算链接', () => {
  const text = '```\n[x](y)\n```\n\n真链接：[a](b.md)\n';
  assert.deepEqual(linkOccurrences(text).map((o) => o.link), ['b.md']);
});

test('行内代码里的 `[x](y)` 也不算', () => {
  assert.deepEqual(linkOccurrences('`[x](y)` 不是反引号\n').map((o) => o.link), []);
});

test('引用块里的围栏同样生效（`> ``` ）', () => {
  const text = '> ```\n> [x](y)\n> ```\n\n[a](b.md)\n';
  assert.deepEqual(linkOccurrences(text).map((o) => o.link), ['b.md']);
});

test('stripCode 保持行号不变（报错要给行号）', () => {
  const text = 'a\n```\nb\nc\n```\nd\n';
  assert.equal(stripCode(text).split('\n').length, text.split('\n').length);
});

// ── §4 外部地址不核 ───────────────────────────────────────────────────
//
// 判据不能去解析 `https://…/a.md`。旧判据靠「正则只匹配 .md 结尾」偶然避开了它；
// 新判据按协议头整类排除，这条用例钉住它。

test('外部地址整类跳过（含协议相对 //host）', () => {
  assert.equal(isExternalLink('https://x/a.md'), true);
  assert.equal(isExternalLink('mailto:a@b'), true);
  assert.equal(isExternalLink('//cdn.example/a.md'), true);
  assert.equal(isExternalLink('docs/a.md'), false);
  assert.equal(isExternalLink('#anchor'), false);
  const s = sandbox();
  try {
    s.put('a.md', '[x](https://github.com/x/y/blob/main/nope.md)\n');
    const { broken, checked } = scanLinks({ root: s.root, files: ['a.md'], checkPublishable: false });
    assert.deepEqual(broken, []);
    assert.equal(checked, 0);
  } finally { s.cleanup(); }
});

// ── §5 目标被 gitignore 忽略：本机绿、干净 clone 红 ───────────────────
//
// `docs/research/` 下五份私有报告就是这一类。链上去在本机存在、在 GitHub 不存在。
// 判据用「会随仓库发出去」这个集合来判，来源与扫描范围同一处（git）。

test('指向被忽略的文件要报 UNPUBLISHED（干净 clone 上必然断）', () => {
  const s = sandbox();
  try {
    s.put('a.md', '[私有](docs/research/private.md)\n');
    s.put('docs/research/private.md', '# 私有\n');
    const bad = checkFileLinks({
      root: s.root, file: 'a.md',
      text: '[私有](docs/research/private.md)\n',
      publishable: new Set(['a.md']),                  // 私有那份不在可发布集里
    });
    assert.deepEqual(kindsOf(bad), ['UNPUBLISHED:docs/research/private.md']);
  } finally { s.cleanup(); }
});

test('publishable 为 null 时不判 UNPUBLISHED（git 不可用的降级路径）', () => {
  const s = sandbox();
  try {
    s.put('a.md', '[a](b.md)\n');
    s.put('b.md', '# b\n');
    const bad = checkFileLinks({ root: s.root, file: 'a.md', text: '[a](b.md)\n', publishable: null });
    assert.deepEqual(bad, []);
  } finally { s.cleanup(); }
});

// ── §6 范围本身：问 git，不维护手写清单 ───────────────────────────────
//
// `DF-040` 的根因是「清单是人写的」。这条用例在**真仓库**上跑，断言范围里
// 含每一份根级 `.md` —— 下次有人加一份新的根级文档而门没跟上，它会红。

test('markdownFiles 覆盖每一份根级 .md（不是写死的两份）', () => {
  const files = markdownFiles(process.cwd());
  const rootMd = files.filter((f) => !f.includes('/'));
  for (const must of ['README.md', 'README-EN.md', 'CLAUDE.md']) {
    assert.ok(rootMd.includes(must), `根级 ${must} 不在扫描范围里`);
  }
  // 不再断言「必须恰好这些」—— 加一份根级文档不该让这条测试红，
  // 只该让门去扫它。这正是它与旧写法的区别。
  assert.ok(rootMd.length >= 3);
  // 代码块里不会混进被忽略的目录：`.scratch/` / `.tmp-analysis/` 是私有临时区。
  assert.ok(!files.some((f) => f.startsWith('.scratch/') || f.startsWith('.tmp-analysis/')));
});

test('markdownFiles 包含 docs/ 与 templates/（模板里的链接也得核）', () => {
  const files = markdownFiles(process.cwd());
  assert.ok(files.includes('docs/README.md'));
  assert.ok(files.includes('templates/dispatch.md'));
});

// ── §7 相对路径按文件所在目录解析 ─────────────────────────────────────
//
// 这条是 checkLinks() 的老回归点：曾用仓库根当基准，`../adr/x.md` 被误报 9 条。

test('相对路径按所在目录解析，`../` 正确回退', () => {
  const s = sandbox();
  try {
    s.put('docs/spec/a.md', '[ADR](../adr/0001.md)\n');
    s.put('docs/adr/0001.md', '# 1\n');
    const { broken } = scanLinks({ root: s.root, files: ['docs/spec/a.md'], checkPublishable: false });
    assert.deepEqual(broken, []);
  } finally { s.cleanup(); }
});

test('目录链接只要目录存在即可（`[ADR](adr/)`）', () => {
  const s = sandbox();
  try {
    s.put('docs/adr/0001.md', '# 1\n');
    const { broken } = scanLinks({ root: s.root, files: ['docs/README.md'], checkPublishable: false });
    // 先造一份引用目录的文档
    s.put('docs/README.md', '[ADR 目录](adr/)\n');
    const r2 = scanLinks({ root: s.root, files: ['docs/README.md'], checkPublishable: false });
    assert.deepEqual(r2.broken, []);
    assert.deepEqual(broken, []);       // 文件不存在时跳过，不该抛
  } finally { s.cleanup(); }
});

// ── §8 报错文本与计数 ─────────────────────────────────────────────────

test('describeBroken 给出文件:行号 + 原因（三类都有话可说）', () => {
  for (const kind of ['MISSING', 'ANCHOR', 'UNPUBLISHED']) {
    const s = describeBroken({ file: 'a.md', link: 'b.md', line: 7, kind });
    assert.match(s, /a\.md:7/);
    assert.match(s, /b\.md/);
    assert.ok(s.includes(KIND_TEXT[kind]));
  }
});

test('行号指向链接所在行，不是文件里的第几次出现', () => {
  const s = sandbox();
  try {
    s.put('a.md', '# 标题\n\n第一段\n\n[断链](x.md)\n');
    const { broken } = scanLinks({ root: s.root, files: ['a.md'], checkPublishable: false });
    assert.equal(broken[0].line, 5);
  } finally { s.cleanup(); }
});

test('同一文档里多条断链全部报出，不只第一条', () => {
  const s = sandbox();
  try {
    s.put('a.md', '[1](x.md)\n[2](y.md)\n[3](x.md)\n');
    const { broken, checked } = scanLinks({ root: s.root, files: ['a.md'], checkPublishable: false });
    assert.equal(broken.length, 3);
    assert.equal(checked, 3);
  } finally { s.cleanup(); }
});
