#!/usr/bin/env node
/**
 * published-paths.test.mjs — 「可发布区零盘符」判据的回归测试。
 *
 * 这个判据以前**一条测试都没有**，因为它写在 `check-structure.mjs` 里，而那个文件
 * 一被 import 就跑完全部门禁并 `process.exit()`。代价是：一个只认 7 个固定前缀的
 * 正则在那里活了很久，凡是不在那 7 个前缀下的本机路径全部漏过，硬门照绿（`DF-039`）。
 *
 * 所以这个文件的第一职责不是「证明现在能抓」，而是**证明旧写法会红**：
 * 下面第一组用例（§1）逐条对应审计里实测漏过的三种形态，把旧正则换回去必须挂。
 *
 * 注意：本文件被 `PATH_EXEMPT` 豁免（`scripts/*.test.mjs`），所以可以写真实的盘符
 * 形态——测试就得写真实形态，写占位符等于没测。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WIN_ABS_RE, POSIX_ABS_RE, PLACEHOLDER_LITERALS,
  normalizePathHit, pathKeyOf, isPlaceholderPath,
  findAbsolutePaths, publishedPathViolations,
  KNOWN_LOCAL_IDENTIFIERS, knownIdentifierKeyOf, findKnownIdentifiers,
} from './published-paths.mjs';

const B = String.fromCharCode(92);           // 反斜杠，避免在模板串里反复转义
const win = (...segs) => segs.join(B);       // win('D:', 'x', 'y') → D:\x\y

/** 抓到的路径（原文），用来断言「抓没抓到」。 */
const caught = (text) => findAbsolutePaths(text).map((h) => h.path);
/** 需要人处理的违规（已过滤占位符）。 */
const violated = (text) => publishedPathViolations(text).map((v) => v.path);

// ── §1 旧正则漏过的形态：新判据必须抓到 ────────────────────────────────
//
// 三条都是审计实测的原文。旧正则 `[A-Za-z]:[\\/](?:Users|Projects|Server|Java|maven|
// Nodejs|Git)[^\s)"'`]*` 对它们全部返回 null —— 换成旧正则，本节四条用例全红。

test('抓到非已知前缀的本机路径（旧正则的七前缀之外）', () => {
  assert.deepEqual(caught(win('D:', 'dsh', 'dshd', 'x')), [win('D:', 'dsh', 'dshd', 'x')]);
});

test('抓到目录名带空格的安装路径（旧正则只报到空格前）', () => {
  const p = win('D:', 'App Name', 'app.exe');
  assert.deepEqual(caught(p), [p], '带空格的路径必须整条抓到，不能停在 "D:\\App"');
});

test('抓到任意伪造目录，不要求目录真实存在', () => {
  const p = win('D:', 'nonexistent-dir-ow', 'x');
  assert.deepEqual(caught(p), [p], '判据不碰磁盘：存在与否不是它的输入');
});

test('抓到旧前缀仍能抓到的形态（防止新正则整体退化成恒空）', () => {
  assert.deepEqual(caught(win('D:', 'Java', 'jdk')), [win('D:', 'Java', 'jdk')]);
});

// ── §2 白名单决策：本仓库自己的路径 ───────────────────────────────────
//
// **决策：不加白名单，判为违规。** 理由（见 `published-paths.mjs` 末尾的长注释）：
// 非豁免区实测一条都没有，加白名单只会把 `<仓库根>/.tmp-analysis/x` 这类本机
// 临时目录布局一并放行。这条测试钉住的就是「决策被悄悄改成放行」这件事。

test('本仓库自己的盘符路径**不在**白名单里（脱敏成 <repo> 成本为零）', () => {
  const p = win('D:', 'Projects', 'Overwatch');
  assert.deepEqual(violated(p), [p], '若哪天给它开了白名单，这条会红——请先读 published-paths.mjs 的决策注释');
});

test('仓库根 + 本机临时子目录同样违规（这正是前缀白名单会放行的东西）', () => {
  const p = win('D:', 'Projects', 'Overwatch', '.tmp-analysis', 'x');
  assert.deepEqual(violated(p), [p]);
});

// ── §3 占位符形态：不抓 ───────────────────────────────────────────────
//
// 白名单不是「给已知路径开后门」，而是「这些字面量本身就是假的」。每条都写理由。

test('省略号形态的占位符不抓', () => {
  for (const p of [win('D:', '\u2026'), win('D:', '...', 'x'), win('D:', 'a', '\u2026', 'b')]) {
    assert.deepEqual(violated(p), [], `占位符被误判为泄漏：${p}`);
  }
});

test('尖括号占位符不抓（脱敏做对了的文档天然通过）', () => {
  // `D:\Projects\<A>` 的命中止于 `<`（`<` 是结束符），所以 nextChar 是 `<`。
  assert.deepEqual(violated(win('D:', 'Projects') + B + '<A>'), []);
});

test('中文占位符不抓', () => {
  assert.deepEqual(violated(win('D:', '你的项目')), []);
});

test('裸盘符根不抓（讲「什么算绝对路径」时的例子）', () => {
  for (const p of ['C:' + B, 'C:/', 'D:' + B]) {
    assert.deepEqual(violated(p), [], `裸盘符根被误判：${JSON.stringify(p)}`);
  }
});

test('Windows 自带目录不抓（每台机器都有，不含身份）', () => {
  assert.deepEqual(violated(win('C:', 'Windows')), []);
  assert.deepEqual(violated(win('C:', 'Program Files')), []);
});

test('白名单里每一条都能被自己的判据认出来（防止清单腐烂成死字面量）', () => {
  for (const k of PLACEHOLDER_LITERALS) {
    if (k.endsWith('/')) continue;              // 裸盘符根由另一条规则覆盖
    // 白名单键是归一化后的表单；用 `\` 变体喂回去必须仍然命中白名单。
    const backslash = k.replace(/\//g, B);
    const hit = findAbsolutePaths(backslash).map((h) => h.path)[0];
    assert.ok(hit, `白名单条目 "${k}" 连自己都匹配不到——它已经是死数据`);
    assert.equal(isPlaceholderPath(hit, ''), true, `白名单条目 "${k}" 被判成了泄漏`);
  }
});

// ── §4 误报边界：不能把正常文字吞进来 ─────────────────────────────────

test('URL 不会被当成盘符路径', () => {
  assert.deepEqual(caught('https://example.com/a 与 http://127.0.0.1:8080/x'), []);
});

test('中文行文里的全角标点会截断路径，不会把整句吞进来', () => {
  const paths = caught(win('D:', 'x', 'y') + '（说明）');
  assert.deepEqual(paths, [win('D:', 'x', 'y')]);
});

test('命令行里的参数不会被吞进路径', () => {
  assert.deepEqual(caught(win('D:', 'work', 'nope.exe') + ' --no-hooks'), [win('D:', 'work', 'nope.exe')]);
});

test('紧跟中文的路径不会被吞掉后缀（中文不是 ASCII 单词字符）', () => {
  assert.deepEqual(caught(win('D:', 'repo') + ' 里的文件'), [win('D:', 'repo')]);
});

// ── §5 POSIX ──────────────────────────────────────────────────────────
//
// 决策：**抓**。本仓库有跨平台面（CI 在 Linux 上跑），`docs/` 里大量讨论 POSIX 行为，
// 而家目录路径泄露的信息（用户名 + 目录结构）与盘符路径同类。
// 边界：只认 `/home|Users|root/<名字>`，不认 `/tmp`、`/var/tmp`、`/opt`（系统公共目录）；
// 用户名本身是占位符（user/alice/me/...）时放行。

test('POSIX 家目录路径被抓到', () => {
  assert.deepEqual(caught('/home/hilltop/code/repo'), ['/home/hilltop/code/repo']);
  assert.deepEqual(caught('/Users/hilltop/src/app-x'), ['/Users/hilltop/src/app-x']);
  assert.deepEqual(caught('/root/D--Projects-X/abc.jsonl'), ['/root/D--Projects-X/abc.jsonl']);
});

test('占位符用户名放行（/home/user/x 是教科书写法，不是本机路径）', () => {
  for (const p of ['/home/user/x', '/home/alice/x', '/Users/me/src/app-x', '/home/u/x']) {
    assert.deepEqual(violated(p), [], `占位符用户名被误判：${p}`);
  }
});

test('系统公共目录不抓（/tmp、/var/tmp、/opt 不含本机身份）', () => {
  for (const p of ['/tmp/x', '/var/tmp/x', '/opt/homebrew/bin/x']) {
    assert.deepEqual(caught(p), [], `公共目录被误判：${p}`);
  }
});

test('裸的 /home/ 与 /Users/ 不抓（没有用户名可泄漏）', () => {
  assert.deepEqual(caught('/home/ 与 /Users/ 都指家目录'), []);
});

test('URL 里的 POSIX 段不会被当成家目录路径', () => {
  assert.deepEqual(caught('https://host/home/hilltop/x'), []);
});

// ── §6 归一化与行号 ───────────────────────────────────────────────────

test('归一化统一反斜杠、折叠重复分隔符、去掉尾部标点', () => {
  assert.equal(normalizePathHit(win('D:', 'a', '', 'b') + '.'), 'D:/a/b');
  assert.equal(normalizePathHit('d:\\a\\b'), 'd:/a/b', '归一化不折大小写（折小写在 pathKeyOf）');
  assert.equal(normalizePathHit('C:' + B), 'C:/', '裸盘符根保留尾部斜杠');
});

test('pathKeyOf 折小写（Windows 路径不区分大小写）', () => {
  assert.equal(pathKeyOf(win('D:', 'Projects')), pathKeyOf('d:/projects'));
});

test('违规带行号，且同一行同一路径只报一次', () => {
  const text = [
    '第一行没有路径',
    win('D:', 'dsh', 'x') + ' 与 ' + win('D:', 'dsh', 'x') + ' 重复',
    '第三行 ' + win('D:', 'other', 'y'),
  ].join('\n');
  assert.deepEqual(publishedPathViolations(text), [
    { line: 2, path: win('D:', 'dsh', 'x') },
    { line: 3, path: win('D:', 'other', 'y') },
  ]);
});

test('空输入与不含路径的文本返回空数组（探针会实际走这条分支）', () => {
  for (const t of ['', 'no paths here', null, undefined]) {
    assert.deepEqual(publishedPathViolations(t), []);
    assert.deepEqual(findAbsolutePaths(t), []);
  }
});

test('两个正则都是 g 标志且没有共享 lastIndex 状态（连续调用结果稳定）', () => {
  assert.equal(WIN_ABS_RE.flags.includes('g'), true);
  assert.equal(POSIX_ABS_RE.flags.includes('g'), true);
  const t = win('D:', 'a', 'b') + ' ' + win('E:', 'c', 'd');
  assert.deepEqual(caught(t), caught(t), '同一段文本连续两次必须一致');
  assert.deepEqual(caught(t), ['D:' + '/a/b'.replace(/\//g, B), win('E:', 'c', 'd')]);
});

// ── §7 无盘符前缀的本机标识符（散列黑名单）────────────────────────────
//
// 来源：`DF-039` 第二轮。`WIN_ABS_RE` 认的是「盘符 + 分隔符」，而 TUI 截图的
// **路径副行**只印目录尾段（`shortPath()` 会剥掉盘符与父目录）—— 于是一个真实中文
// 项目名整串裸奔在 `docs/research/` 里，硬门照绿。这不是「正则再宽一点」能解决的，
// 是另一类输入：没有路径，只有名字。
//
// 这些用例**用假名字**（不写真名）：测试文件虽被 `PATH_EXEMPT` 豁免、硬门不扫它，
// 但「测试里可以写真的」这条豁免是为了验「盘符形态」，不是为了把真名存进仓里。

const FAKE = '某本机项目名';                        // 6 个汉字，与真实条目同长度
const FAKE_LIST = Object.freeze([Object.freeze({
  ...knownIdentifierKeyOf(FAKE), note: '假条目（测试用）',
})]);

test('没有盘符前缀的已知标识符会被抓到（路径正则对它是瞎的）', () => {
  const text = '在跑 (10)  某本机项目名   57s 数据基本齐全了';
  assert.deepEqual(violated(text), [], '前置：路径判据确实抓不到它');
  assert.deepEqual(findKnownIdentifiers(text, FAKE_LIST).map((h) => h.line), [1]);
});

test('紧贴路径分隔符与盘符也能抓到（不依赖分词）', () => {
  for (const t of [`…/${FAKE}`, win('C:', FAKE), `x${FAKE}y`]) {
    assert.equal(findKnownIdentifiers(t, FAKE_LIST).length, 1, `漏了：${t}`);
  }
});

test('同一行同一条目只报一次，不同行各报一次', () => {
  const text = `${FAKE} 与 ${FAKE}\n中间一行\n${FAKE}`;
  assert.deepEqual(findKnownIdentifiers(text, FAKE_LIST).map((h) => h.line), [1, 3]);
});

test('命中结果里不含原文（回报原文等于把泄漏重复进 CI 日志）', () => {
  const out = findKnownIdentifiers(`x ${FAKE} y`, FAKE_LIST);
  assert.equal(out.length, 1);
  const dumped = JSON.stringify(out);
  assert.equal(dumped.includes(FAKE), false, '命中结果把异常原文带出来了');
  assert.deepEqual(Object.keys(out[0]).sort(), ['line', 'note']);
});

test('空文本、空名单、坏条目都安全返回（探针走的就是这条分支）', () => {
  for (const t of ['', 'no identifiers here', null, undefined]) {
    assert.deepEqual(findKnownIdentifiers(t, FAKE_LIST), []);
  }
  assert.deepEqual(findKnownIdentifiers(FAKE, []), []);
  assert.deepEqual(findKnownIdentifiers(FAKE, null), []);
  assert.deepEqual(findKnownIdentifiers(FAKE, [null, {}, { len: 0, hashes: [1, 2] }, { len: 6 }]), []);
});

test('knownIdentifierKeyOf 是确定性的，且两个基真的不同（单基会放大碰撞）', () => {
  const a = knownIdentifierKeyOf(FAKE);
  assert.deepEqual(a, knownIdentifierKeyOf(FAKE));
  assert.equal(a.len, FAKE.length);
  assert.equal(a.hashes.length, 2);
  assert.notEqual(a.hashes[0], a.hashes[1]);
  assert.deepEqual(knownIdentifierKeyOf(''), { len: 0, hashes: [0, 0] });
});

test('登记的每条本机标识符都是散列形态，没有一条能把名字读回来', () => {
  assert.ok(KNOWN_LOCAL_IDENTIFIERS.length > 0, '清单空了 —— 那条泄漏会重新变得无人看守');
  for (const e of KNOWN_LOCAL_IDENTIFIERS) {
    assert.equal(Number.isInteger(e.len) && e.len > 0, true, '缺 len');
    assert.equal(e.hashes.length, 2, '必须两个基；单基会放大碰撞');
    // 关键的一条：条目的任何字符串字段都不得是「中文且长度等于 len」——
    // 那正是「有人图省事把名字直接写进来」的形态。
    for (const v of Object.values(e)) {
      if (typeof v !== 'string') continue;
      assert.equal(/^[^\x00-\x7F]+$/.test(v) && [...v].length === e.len, false,
        '条目里出现了一个长度与 len 完全相同的中文串 —— 疑似直接写了原文而不是散列');
    }
  }
});
