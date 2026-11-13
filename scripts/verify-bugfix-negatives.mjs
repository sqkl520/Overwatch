#!/usr/bin/env node
/**
 * verify-bugfix-negatives.mjs — 负向验证：把每个修复回退，相关测试必须变红。
 *
 * 为什么需要独立脚本：`MUTATIONS` 里的每一处回退都要真正改文件、跑测试、再还原。
 * 人手动做这件事一定会漏（而且要重跑 6 次全量测试）。这里把它变成一条命令。
 *
 * 用法：
 *   node scripts/verify-bugfix-negatives.mjs            # 跑全部回退
 *   node scripts/verify-bugfix-negatives.mjs --only b1  # 只跑某一处
 *
 * 它**不修改 git 状态**：每处回退前把原文件内容读进内存，跑完立刻写回；
 * 任一环节抛错也会在 finally 里还原。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);

/**
 * 每项：
 *   id      简名
 *   file    要回退的文件（相对仓库）
 *   find    原文片段（必须唯一）
 *   replace 回退成什么（即修复前的代码）
 *   test    期望变红的测试文件 + 测试名片段
 */
export const MUTATIONS = [
  {
    id: 'b1-mtime',
    bug: 'Bug1',
    desc: '把 --days 的判据改回文件 mtime（应让 lastActivityOf 相关测试变红）',
    file: 'scripts/scan-sessions.mjs',
    find: 'export function lastActivityOf(records) {\n  for (let i = records.length - 1; i >= 0; i--) {\n    const rec = records[i];\n    if (!rec || typeof rec !== \'object\') continue;\n    const raw = rec.timestamp;\n    if (typeof raw !== \'string\') continue;\n    const ts = Date.parse(raw);\n    if (Number.isFinite(ts)) return ts;\n  }\n  return null;\n}',
    replace: 'export function lastActivityOf(records) {\n  // 回退版：取最后一条记录的时间戳（不跳过无 timestamp 的元数据记录）\n  for (let i = records.length - 1; i >= 0; i--) {\n    const rec = records[i];\n    if (!rec || typeof rec !== \'object\') continue;\n    const ts = Date.parse(rec.timestamp);\n    return Number.isFinite(ts) ? ts : null;\n  }\n  return null;\n}',
    test: ['tui-bugfixes.test.mjs', 'Bug1：lastActivity 取最后一条带 timestamp 的记录'],
  },
  {
    id: 'b2-table',
    bug: 'Bug2',
    desc: '把宽度表换回手抄的 20 段（应让 EAW 覆盖测试变红）',
    file: 'scripts/tui-theme.mjs',
    find: 'const WIDE_RANGES = mergeWide();',
    replace: 'const WIDE_RANGES = [[0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x20000, 0x2fffd]];',
    test: ['tui-bugfixes.test.mjs', 'Bug2：10 个代表性字符'],
  },
  {
    id: 'b2-grapheme',
    bug: 'Bug2',
    desc: '把 grapheme 聚类换回按码点累加（应让肤色修饰符测试变红）',
    file: 'scripts/tui-theme.mjs',
    find: '  if (SEGMENTER) {\n    for (const { segment } of SEGMENTER.segment(text)) {\n      units.push({ ansi: false, text: segment, width: clusterWidth(segment) });\n    }\n    return units;\n  }',
    replace: '  // 回退版：按码点逐个量，不做聚类\n  if (text) {\n    for (const ch of text) units.push({ ansi: false, text: ch, width: clusterWidth(ch) });\n    return units;\n  }',
    test: ['tui-bugfixes.test.mjs', 'Bug2：grapheme 聚类'],
  },
  {
    id: 'b2-quadratic',
    bug: 'Bug2',
    desc: '把 truncate 换回每字符重算前缀的 O(n²)（应让线性测试变红）',
    file: 'scripts/tui-theme.mjs',
    find: '  const units = measure(s);\n  let total = 0;\n  for (const u of units) total += u.width;\n  if (total <= max) return s;\n  if (max === 1) return \'…\';\n\n  const limit = max - 1;          // 留 1 列给省略号\n  let used = 0;\n  let sawAnsi = false;\n  let out = \'\';\n  for (const unit of units) {\n    if (unit.ansi) { out += unit.text; sawAnsi = true; continue; }\n    if (used + unit.width > limit) break;\n    out += unit.text;\n    used += unit.width;\n  }\n  return out + \'…\' + (sawAnsi ? RESET : \'\');',
    replace: '  // 回退版：每追加一个字符就重算整个前缀\n  if (displayWidth(s) <= max) return s;\n  if (max === 1) return \'…\';\n  let out = \'\';\n  let styled = false;\n  for (const ch of s) {\n    if (ch === \'\\x1b\') { styled = true; out += ch; continue; }\n    if (displayWidth(out + ch) > max - 1) break;\n    out += ch;\n  }\n  return out + \'…\' + (styled ? RESET : \'\');',
    test: ['tui-bugfixes.test.mjs', 'Bug2：truncateDisplay 是线性的'],
  },
  {
    id: 'b5-sgr',
    bug: 'Bug5',
    desc: '从 SGR 表里删掉 brightYellow（应让 WAITING 着色测试变红）',
    file: 'scripts/tui-theme.mjs',
    find: '  brightYellow: 93,',
    replace: '',
    test: ['tui-bugfixes.test.mjs', 'Bug5：WAITING 徽章必须带 SGR'],
  },
  {
    id: 'b5-silent',
    bug: 'Bug5',
    desc: '让 paint 对未定义色名重新静默降级（应让告警测试变红）',
    file: 'scripts/tui-theme.mjs',
    find: '  if (code === undefined) {\n    if (!UNKNOWN_COLORS.has(colorName)) {\n      UNKNOWN_COLORS.add(colorName);\n      try { colorWarn(colorName); } catch { /* 告警失败不影响渲染 */ }\n    }\n    return s;\n  }',
    replace: '  if (code === undefined) return s;',
    test: ['tui-bugfixes.test.mjs', 'Bug5：paint 遇到未定义色名必须告警'],
  },
  {
    id: 'b3-index',
    bug: 'Bug3',
    desc: '把光标改回按下标（应让排序翻转测试变红）',
    file: 'scripts/oversight-tui.mjs',
    find: '    if (this.selectedId !== null) {\n      const idx = sessions.findIndex((s) => sessionKey(s) === this.selectedId);\n      if (idx >= 0) return idx;',
    replace: '    if (false) {\n      const idx = -1;',
    test: ['tui-bugfixes.test.mjs', 'Bug3：排序翻转后光标仍指向原会话'],
  },
  {
    id: 'b4-jobs',
    bug: 'Bug4',
    desc: '不补宿主 job（应让 blocked job 测试变红）',
    file: 'scripts/scan-sessions.mjs',
    find: '  for (const job of jobs || []) {\n    if (!job || !job.sessionId) continue;',
    replace: '  for (const job of []) {\n    if (!job || !job.sessionId) continue;',
    test: ['tui-bugfixes.test.mjs', 'Bug4：mergeJobRows 不能重复加入'],
  },
  {
    id: 'b4-alias',
    bug: 'Bug4',
    desc: '去重只比 sessionId，丢掉别名（应让别名去重测试变红）',
    file: 'scripts/oversight-tui.mjs',
    find: '  for (const s of scanned) for (const id of rowIdentities(s)) have.add(id);',
    replace: '  for (const s of scanned) have.add(s.sessionId);',
    test: ['tui-bugfixes.test.mjs', 'Bug4：mergeLiveSessions 也按多身份去重'],
  },
  {
    id: 'b6-noabnormal',
    bug: 'Bug6',
    desc: '把「无异常」措辞加回去（应让状态行契约测试变红）',
    file: 'scripts/oversight-tui.mjs',
    find: '  if (counts) {\n    parts.push(counts);\n  } else if (sessions.length > 0) {',
    replace: '  if (true) {\n    parts.push(counts || \'无异常\');\n  } else if (sessions.length > 0) {',
    test: ['tui-bugfixes.test.mjs', 'Bug6：状态行不得把'],
  },
  {
    id: 'b6-empty',
    bug: 'Bug6',
    desc: '让「没事」与「没数据」重新说同一段话（应让 emptyLines 测试变红）',
    file: 'scripts/oversight-tui.mjs',
    find: '  if (seen === 0 && jobs === 0) {',
    replace: '  if (true) {',
    test: ['tui-bugfixes.test.mjs', 'Bug6：真空和「扫了但没认出来」必须说不同的话'],
  },
  {
    id: 'b4-days0',
    bug: 'Bug4',
    desc: '把 --days 的合法性判回 n > 0（应让 --all 解析测试变红）',
    file: 'scripts/oversight-tui.mjs',
    find: '      if (Number.isFinite(n) && n >= 0) { out.days = Math.min(365, Math.floor(n)); out.all = out.days === 0; }',
    replace: '      if (Number.isFinite(n) && n > 0) out.days = Math.min(365, Math.floor(n));',
    test: ['tui-bugfixes.test.mjs', 'Bug4：--days 0 与 --all 都表示不限窗口'],
  },
  {
    id: 'b4-outwin',
    bug: 'Bug4',
    desc: '不再提示「窗口外还有 N 个」（应让窗口外提示测试变红）',
    file: 'scripts/oversight-tui.mjs',
    find: '  const outWin = Number(app.data?.stats?.transcriptsOutsideWindow);\n  if (Number.isFinite(outWin) && outWin > 0) {\n    text += ` · 另有 ${outWin} 个在窗口外（--all 查看全部）`;\n  }',
    replace: '  const outWin = 0;',
    test: ['tui-bugfixes.test.mjs', 'Bug4：窗口外还有会话时'],
  },

  // ── 2026-11-10：时钟注入 + 跨层去重（docs/research/2026-11-05-fix-clock-and-crosslayer-dedup.md）──
  //
  // 这五项都是「删掉一行修复就复活一个缺陷」的类型。前两项是时钟，
  // 后三项是跨层去重。它们必须一起留在这里：单看某一项的测试可能仍然是绿的
  // （比如只回退 runTick 的传参，锚点在过去的用例才会红）。
  {
    id: 'b7-clock',
    bug: 'B7',
    desc: '把 loadState 的剪枝改回 Date.now()（注入时钟回退）',
    file: 'scripts/watch.mjs',
    find: '  const pruned = pruneNotified(state.notified, nowMs);',
    replace: '  const pruned = pruneNotified(state.notified, Date.now());',
    test: ['watch.test.mjs', 'loadState 必须用注入的 nowMs 剪枝'],
  },
  {
    id: 'b7-runtick',
    bug: 'B7',
    desc: 'runTick 不再把自己的 nowMs 传给 loadState（调用链回退）',
    file: 'scripts/watch.mjs',
    find: '  const { state, corrupt } = loadState(stateDir, { logger: log, nowMs });',
    replace: '  const { state, corrupt } = loadState(stateDir, { logger: log });',
    test: ['watch.test.mjs', '真正测去重：同一 WAITING 事件跨两个 tick 只发一条'],
  },
  {
    id: 'b8-passthrough',
    bug: 'B8',
    desc: 'candidatesFromScan 不再透传扫描行自带的 job: 指纹（跨层键回退）',
    file: 'scripts/watch.mjs',
    find: "    if (given.startsWith('job:') || given.startsWith('wait:')) {",
    replace: '    if (false) {',
    test: ['watch.test.mjs', 'jobs 与 scan 报同一事件时只发一条'],
  },
  {
    id: 'b8-scanfp',
    bug: 'B8',
    desc: 'scan-sessions 不再产出跨层指纹（同一次失败两个键）',
    file: 'scripts/scan-sessions.mjs',
    find: '  if (!Number.isFinite(ev.atMs)) return null;',
    replace: '  if (true) return null;',
    test: ['watch.test.mjs', '跨层去重（端到端）'],
  },
  {
    id: 'b8-hostfields',
    bug: 'B8',
    desc: 'scan 行不再带出宿主 statusUpdatedAt（WAITING 退化路径断裂）',
    file: 'scripts/scan-sessions.mjs',
    find: '        statusUpdatedAt: hostFields.statusUpdatedAt,',
    replace: '        statusUpdatedAt: null, void hostFields,',
    test: ['watch.test.mjs', '跨层去重：scan 行必须带出宿主'],
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

function runTest(namespace) {
  const r = spawnSync(process.execPath, ['--test', join(HERE, namespace)], {
    cwd: REPO, encoding: 'utf8', timeout: 300000,
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  return { code: r.status, out };
}

/** 某条测试在输出里是 pass 还是 fail。node --test 的 TAP/спец 格式都认这两种标记。 */
function testVerdict(out, namePart) {
  const lines = out.split('\n');
  for (const l of lines) {
    if (!l.includes(namePart)) continue;
    if (l.trim().startsWith('✖') || l.includes('not ok')) return 'fail';
    if (l.trim().startsWith('✔') || l.includes('ok ')) return 'pass';
  }
  return 'missing';
}

function main(argv) {
  const only = (() => {
    const i = argv.indexOf('--only');
    return i >= 0 ? argv[i + 1] : null;
  })();
  const list = only ? MUTATIONS.filter((m) => m.id === only || m.bug.toLowerCase() === only) : MUTATIONS;
  if (!list.length) {
    console.error(`没有匹配的回退项：${only}`);
    process.exitCode = 2;
    return;
  }

  // 先确认基线是绿的：否则「变红」什么也证明不了
  const baseline = runTest('tui-bugfixes.test.mjs');
  if (baseline.code !== 0) {
    console.error('✗ 基线不是绿的，负向验证没有意义。先让 tui-bugfixes.test.mjs 全绿。');
    console.error(baseline.out.split('\n').filter((l) => l.includes('✖')).slice(0, 5).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log('基线：tui-bugfixes.test.mjs 全绿 ✓\n');

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
          ? '测试仍然全绿——这条测试挡不住这个回退'
          : '测试报错了，但不是那条预期的测试变红';
      }
    } catch (e) {
      detail = e.message;
    } finally {
      if (restore) restore();
    }
    rows.push({ ...m, verdict, detail });
    const icon = verdict === 'fail' ? '✓' : '✗';
    console.log(`${icon} ${m.id.padEnd(14)} ${m.bug}  ${m.desc}`);
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

const isDirect = process.argv[1] && /verify-bugfix-negatives\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isDirect) main(process.argv.slice(2));
