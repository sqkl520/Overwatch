#!/usr/bin/env node
/**
 * verify-claim-fix-negatives.mjs — 2026-11-13 三个断言识别缺陷的**负向验证**。
 *
 * 为什么单独一个脚本：`verify-bugfix-negatives.mjs` 只跑 `tui-bugfixes.test.mjs`，
 * 而这批修复的守卫在 `verify-claims.test.mjs`。混进去会让那个脚本没法干净地指出
 * 「哪一条回退让哪一条测试变红」。
 *
 * 做法与它一致：每处回退前把原文件读进内存，跑完立刻写回（finally 保证）。
 * **不改 git 状态**，也不需要先提交。
 *
 * 三处回退：
 *   n1  去掉 `已 + 插词 + 光杆动词` 分支   → P4/P5 的原话必须重新掉回「认不出」
 *   n2  去掉假设/间接疑问判据              → `Whether tests pass matters here.` 必须重新变成 test-count
 *   n3  让族名回退成 ID                    → 拦截文案必须重新混进英文族名
 *   n4  去掉英文 `All N fixes are applied` → P6 的原话必须重新掉回「认不出」
 *   n5  把假设判据改成「整句否决」          → 同句后半段的真断言必须被一起误杀
 *
 * 用法：
 *   node scripts/verify-claim-fix-negatives.mjs            # 跑全部
 *   node scripts/verify-claim-fix-negatives.mjs --only n2  # 只跑某一处
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const TEST_FILE = 'verify-claims.test.mjs';

/** 每处回退：改哪个文件、把什么换成什么、期望哪条测试变红。 */
export const MUTATIONS = [
  {
    id: 'n1-bare-done',
    defect: '缺陷1',
    desc: '去掉「已 + 插词 + 光杆动词」分支（应让 P4/P5 的原话重新漏检）',
    file: 'scripts/verify-claims.mjs',
    find: "  + '|' + VAGUE_DONE_BARE + VAGUE_TAIL\n",
    replace: '',
    test: ['verify-claims.test.mjs', '缺陷1：`已+全部/按…+动词` 不带「了」也要能认出'],
  },
  {
    id: 'n2-hypothetical',
    defect: '缺陷2',
    desc: '去掉假设/间接疑问判据（应让 `Whether tests pass matters here.` 重新变成 test-count）',
    file: 'scripts/verify-claims.mjs',
    find: '      const hits = matchesOf(fam.re, sentence);\n'
      + '      if (hits.length && hits.every((m) => isHypotheticalMatch(sentence, m))) continue;\n',
    replace: '',
    test: ['verify-claims.test.mjs', '缺陷2：假设 / 条件 / 间接疑问不认成断言'],
  },
  {
    id: 'n3-family-name',
    defect: '缺陷3',
    desc: '让中文名回退成族 ID（应让拦截文案里重新出现英文族名）',
    file: 'scripts/verify-claims.mjs',
    find: 'export function familyName(id) {\n  return FAMILY_NAMES[id] || \'完成性断言\';\n}',
    replace: 'export function familyName(id) {\n  return id;\n}',
    test: ['verify-claims.test.mjs', '缺陷3：每个族都有人话名称；未知族也不许回吐 ID'],
  },
  {
    id: 'n4-en-all',
    defect: 'P6',
    desc: '去掉英文「All N fixes are applied」那一条（应让 P6 的原话重新漏检）',
    // 不能只删 `+ '|' + VAGUE_EN_ALL,` —— 它是 COMPLETION_RE 的最后一项，单删会让
    // 文件语法错误（缺逗号/多一行）。那样测试确实报错，但报的是 SyntaxError，
    // 证明不了任何判据上的事。所以连上一行一起换掉，保持表达式合法。
    file: 'scripts/verify-claims.mjs',
    find: "  + '|' + VAGUE_LEAD + VAGUE_EN\n  + '|' + VAGUE_EN_ALL,",
    replace: "  + '|' + VAGUE_LEAD + VAGUE_EN,",
    test: ['verify-claims.test.mjs', 'P6：英文「All four fixes are applied」必须认出'],
  },
  {
    id: 'n5-whole-sentence',
    defect: '缺陷2 过度收紧',
    desc: '把假设判据改成「整句否决」（应让同句后半段的真断言被一起误杀）',
    file: 'scripts/verify-claims.mjs',
    find: '      if (hits.length && hits.every((m) => isHypotheticalMatch(sentence, m))) continue;',
    replace: '      if (hits.length && hits.some((m) => isHypotheticalMatch(sentence, m))) continue;',
    test: ['verify-claims.test.mjs', '缺陷2 防误伤：同一句里假设在前、真断言在后'],
  },
];

/** 应用一次回退，返回还原函数。 */
function applyMutation(m) {
  const path = join(REPO, m.file);
  const original = readFileSync(path, 'utf8');
  if (!original.includes(m.find)) {
    throw new Error(`${m.id}: 在 ${m.file} 里找不到要回退的片段（文件已改动？）`);
  }
  if (original.split(m.find).length > 2) {
    throw new Error(`${m.id}: 片段在 ${m.file} 里不唯一`);
  }
  writeFileSync(path, original.replace(m.find, m.replace), 'utf8');
  return () => writeFileSync(path, original, 'utf8');
}

function runTest(file) {
  const r = spawnSync(process.execPath, ['--test', join(HERE, file)], {
    cwd: REPO, encoding: 'utf8', timeout: 300000,
  });
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}

/** 那条测试在输出里是 pass 还是 fail。 */
function testVerdict(out, namePart) {
  for (const l of out.split('\n')) {
    if (!l.includes(namePart)) continue;
    if (l.trim().startsWith('✖') || l.includes('not ok')) return 'fail';
    if (l.trim().startsWith('✔') || l.includes('ok ')) return 'pass';
  }
  return 'missing';
}

function main(argv) {
  const i = argv.indexOf('--only');
  const only = i >= 0 ? argv[i + 1] : null;
  const list = only
    ? MUTATIONS.filter((m) => m.id === only || m.id.startsWith(only + '-'))
    : MUTATIONS;
  if (!list.length) {
    console.error(`没有匹配的回退项：${only}`);
    process.exitCode = 2;
    return;
  }

  const baseline = runTest(TEST_FILE);
  if (baseline.code !== 0) {
    console.error(`✗ 基线不是绿的，负向验证没有意义。先让 ${TEST_FILE} 全绿。`);
    console.error(baseline.out.split('\n').filter((l) => l.includes('✖')).slice(0, 5).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`基线：${TEST_FILE} 全绿 ✓\n`);

  const rows = [];
  for (const m of list) {
    let restore = null;
    let verdict = 'error';
    let detail = '';
    try {
      restore = applyMutation(m);
      const [file, namePart] = m.test;
      const r = runTest(file);
      verdict = testVerdict(r.out, namePart);
      if (verdict !== 'fail') {
        detail = r.code === 0
          ? '测试仍然全绿 —— 这条回退没被任何测试挡住'
          : '测试报错了，但不是那条预期的测试变红';
      }
    } catch (e) {
      detail = e.message;
    } finally {
      if (restore) restore();
    }
    rows.push({ ...m, verdict, detail });
    const icon = verdict === 'fail' ? '✓' : '✗';
    console.log(`${icon} ${m.id.padEnd(18)} ${m.defect.padEnd(12)} ${m.desc}`);
    if (verdict === 'fail') console.log(`      → 预期测试变红：${m.test[1]}`);
    else console.log(`      → 问题：${detail}`);
  }

  const bad = rows.filter((r) => r.verdict !== 'fail');
  console.log('');
  if (bad.length) {
    console.log(`✗ ${bad.length}/${rows.length} 处回退没有被测试挡住`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${rows.length}/${rows.length} 处回退都让预期测试变红`);
  }
}

const isDirect = process.argv[1] && /verify-claim-fix-negatives\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isDirect) main(process.argv.slice(2));
