#!/usr/bin/env node
/**
 * verify-tui-negatives.mjs — 负向验证：把 TUI 重做的每一项关键特性关掉，测试必须变红。
 *
 * 为什么需要独立脚本：每处回退都要真正改文件、跑测试、再还原。人手动做这件事
 * 一定会漏，而且跑完 8 遍全量测试要十几分钟。这里把它变成一条命令。
 *
 * 与 `verify-bugfix-negatives.mjs` 的分工：那个文件管 2026-11-05 的六个缺陷
 * （三源合并、宽度表、光标身份）；本文件管 2026-11-10 的 TUI 重做
 * （判决行、检查表、分段、空状态、纯文本路径）。
 *
 * 用法：
 *   node scripts/verify-tui-negatives.mjs            # 跑全部回退
 *   node scripts/verify-tui-negatives.mjs --only v1  # 只跑某一处
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
 *   feature 它守的是哪条规格
 *   file    要回退的文件（相对仓库）
 *   find    原文片段（必须唯一）
 *   replace 回退成什么
 *   test    期望变红的测试文件 + 测试名片段
 */
export const MUTATIONS = [
  {
    id: 'v1-verdict',
    feature: 'AC1 判决行：第一行「N 件在等你」，不是「N 个会话」',
    desc: '把判决行改回「先报会话总数」——旧形态',
    file: 'scripts/tui-layout.mjs',
    find: '  return [\n    `${n} 件在等你`,\n    `${Math.max(0, runningCount | 0)} 个会话在跑`,\n    `${Math.max(0, stoppedCount | 0)} 个已停`,\n  ];',
    replace: '  return [\n    `${Math.max(0, runningCount | 0) + Math.max(0, stoppedCount | 0)} 会话`,\n    `${n} 件在等你`,\n  ];',
    test: ['tui-layout.test.mjs', 'verdictParts：「N 件在等你」必须排第一'],
  },
  {
    id: 'v2-checklist',
    feature: '裁决 R2：检查表 4 行一行不砍（四道独立数据源）',
    desc: '砍掉「问了没答」这一行（红队 R2 的原始提案）',
    file: 'scripts/tui-layout.mjs',
    find: "  rows.push({\n    kind: 'asked',\n    data: { n: asked },\n    label: '问了没答',\n    source: 'transcript 末条是问句',\n    verdict: `${asked} 个`,\n    note: '',\n    tone: asked > 0 ? 'warn' : 'ok',\n  });",
    replace: '  // 回退版：把这一行删掉，只留一行 \'空\' 的占位\n  rows.push({ kind: \'asked\', data: { n: asked }, label: \'\', source: \'\', verdict: \'\', note: \'\', tone: \'muted\' });',
    test: ['tui-layout.test.mjs', 'checklistRows：恒 4 行，一行不砍'],
  },
  {
    id: 'v3-source',
    feature: '检查表每行都写来源（否则全绿和漏检无法区分）',
    desc: '把来源列整列删掉',
    file: 'scripts/tui-layout.mjs',
    find: '    source: \'WAITING/BLOCKED/FAILED\',',
    replace: '    source: \'\',',
    test: ['tui-layout.test.mjs', 'checklistRows：每行都写来源'],
  },
  {
    id: 'v4-health',
    feature: '§2.6 监视没跑必须打 ✗ 并进第一屏（「空」不可信）',
    desc: '让体检失败也画成 ✓（退化成「一切正常」）',
    file: 'scripts/tui-layout.mjs',
    find: "    } else {\n      hVerdict = '✗';\n      hSource = `${parts.join(' / ')} 未运行`;\n      hNote = '先修这个';\n      hTone = 'bad';",
    replace: "    } else {\n      hVerdict = '✓';\n      hSource = `${parts.join(' / ')}`;\n      hNote = '';\n      hTone = 'ok';",
    test: ['tui-layout.test.mjs', 'checklistRows：监视在跑与没在跑必须打不同的标记'],
  },
  {
    id: 'v5-alert',
    feature: '§2.6 监视没跑时告警进第一屏，且不替换会话列表',
    desc: '不再生成 alert 行',
    file: 'scripts/oversight-tui.mjs',
    find: "    const alert = healthBad && this.data\n      ? [",
    replace: "    const alert = false\n      ? [",
    test: ['tui-redesign.test.mjs', '§2.6 监视没跑时，告警不替换会话列表'],
  },
  {
    id: 'v6-stopped',
    feature: '裁决 R1：「已停」默认压成一行，按 h 展开',
    desc: '默认就展开全部已停行（回到 29 行同质化的旧形态）',
    file: 'scripts/oversight-tui.mjs',
    find: '    this.stoppedExpanded = false;',
    replace: '    this.stoppedExpanded = true;',
    test: ['tui-redesign.test.mjs', '裁决 R1：「已停」默认压成一行'],
  },
  {
    id: 'v7-restate',
    feature: 'AC4 主屏不得出现 reason / novelty（字段矩阵）',
    desc: '把 reason 拼回列表行',
    file: 'scripts/tui-layout.mjs',
    find: '  cells.push({ text: \' \'.repeat(gapBeforeIdle), width: gapBeforeIdle });',
    replace: '  cells.push({ text: \' \'.repeat(gapBeforeIdle), width: gapBeforeIdle });\n  view = { ...view, title: `${view.title} ${view.row && view.row.reason ? view.row.reason : ""}` };\n  cells[1] = { text: padDisplay(view.title, titleW), width: titleW };',
    test: ['tui-redesign.test.mjs', 'AC4 主屏不得出现 reason'],
  },
  {
    id: 'v8-disclose',
    feature: '溢出可数披露：截断必须写「丢了多少」，不得静默',
    desc: '把可数披露换回裸截断',
    file: 'scripts/tui-layout.mjs',
    find: '  return { text: `${body}… (+${omitted} 列)`, omitted, truncated: true };',
    replace: '  return { text: `${body}…`, omitted, truncated: true };',
    test: ['tui-layout.test.mjs', 'truncateWithDisclosure：超宽时必须说出丢了多少列'],
  },
  {
    id: 'v9-plain',
    feature: '--plain 与交互屏同源：判决行 + 检查表 + 逐字 needs',
    desc: '纯文本路径退回「只印一句汇总」',
    file: 'scripts/oversight-tui.mjs',
    find: '  out.push(verdictParts({\n    actionCount: sections.action.length,\n    runningCount: sections.running.length,\n    stoppedCount: sections.stopped.length,\n  }).join(\' · \'));',
    replace: '  out.push(`汇总：${sections.all.length} 个会话`);',
    test: ['tui-redesign.test.mjs', '--plain 端到端：有判决行、检查表、逐字 needs'],
  },
  {
    id: 'v10-width',
    feature: 'AC2 整屏每行 ≤ cols（含 CJK）',
    desc: '让 composeListScreen 不再裁剪超宽行',
    file: 'scripts/tui-layout.mjs',
    find: '  return fixed.map((l) => (displayWidth(l) > cols ? truncateDisplay(l, cols) : l));',
    replace: '  return fixed;',
    test: ['tui-layout.test.mjs', 'composeListScreen：body 里的超宽行也被裁剪'],
  },
  {
    id: 'v11-binary',
    feature: '六态降二值：不认识的态不得被算成「在跑」或「需动作」',
    desc: '让未知状态的兜底分支返回 running（静默把「我不知道」算成「它活着」）',
    file: 'scripts/tui-layout.mjs',
    find: "  if (st === 'PRODUCING' || st === 'EXPLORING' || st === 'STALLED') return 'running';\n  return 'stopped';",
    replace: "  if (st === 'PRODUCING' || st === 'EXPLORING' || st === 'STALLED') return 'running';\n  return 'running';",
    test: ['tui-layout.test.mjs', 'binaryOf：六态降到二值'],
  },

  // ── 2026-11-11 两个新缺陷（陈年问句 / 剪贴板内容）───────────────
  //
  // 这两处回退直接复现用户看到的样子。基线绿、回退后必须红，
  // 是「修好了」唯一的证据形式（CHANGELOG 硬规则第 2 条）。
  {
    id: 'v12-age-waiting',
    feature: 'WAITING 必须有老化上限（33 天前问句曾被判成需动作）',
    desc: '把 WAITING 的老化上限删掉（回到只有 BLOCKED 有上限的旧形态）',
    file: 'scripts/tui-layout.mjs',
    find: '  WAITING: 24 * 3600,',
    replace: '  // WAITING 无上限（回退版）',
    test: ['tui-layout.test.mjs', 'ACTION_MAX_AGE_SEC：WAITING 有上限'],
  },
  {
    id: 'v13-age-partition',
    feature: '超龄的需动作事实降级进「已停」，不丢弃',
    desc: '让 partitionRows 无视 staleOf 的结论，超龄的照旧进需动作',
    file: 'scripts/tui-layout.mjs',
    find: '      const age = staleOf(row, nowMs);\n      if (age.stale) {\n        const downgraded = { ...row, stale: true, staleAgeSec: age.ageSec, staleLimitSec: age.limitSec };\n        aged.push(downgraded);\n        stopped.push(downgraded);\n        continue;\n      }',
    replace: '      const age = staleOf(row, nowMs);\n      if (false && age.stale) {\n        const downgraded = { ...row, stale: true, staleAgeSec: age.ageSec, staleLimitSec: age.limitSec };\n        aged.push(downgraded);\n        stopped.push(downgraded);\n        continue;\n      }',
    test: ['tui-layout.test.mjs', 'partitionRows：超龄的需动作事实降级进「已停」'],
  },
  {
    id: 'v14-age-drop',
    feature: '超龄的不丢弃（用户要求所有会话都显示）',
    desc: '把降级改成「直接丢掉」——比误报更糟的漏报',
    file: 'scripts/tui-layout.mjs',
    find: '        aged.push(downgraded);\n        stopped.push(downgraded);\n        continue;',
    replace: '        aged.push(downgraded);\n        continue;',
    test: ['tui-layout.test.mjs', 'partitionRows：超龄的需动作事实降级进「已停」'],
  },
  {
    id: 'v15-draft-needs',
    feature: '剪贴板只含可直接发送的正文，不含 needs 元注释',
    desc: '把 needs 那段「（目标会话受阻，在等：…）」塞回草稿（用户实测的那个 bug）',
    file: 'scripts/oversight-tui.mjs',
    find: '  if (staleOf(session, nowMs).stale) return null;\n  return reply;',
    replace: '  if (staleOf(session, nowMs).stale) return null;\n  const _needs = typeof session?.needs === \'string\' ? sanitize(session.needs).trim() : \'\';\n  return _needs ? `${reply}\\n\\n（目标会话受阻，在等：${_needs}）` : reply;',
    test: ['oversight-tui.test.mjs', '草稿里绝不能出现「目标会话」这类旁白'],
  },
  {
    id: 'v16-draft-stale',
    feature: '超龄等待的 suggestedReply 不给（33 天前猜的话不该被复制）',
    desc: '去掉 buildDraft 里的超龄判断，陈年 suggestedReply 照旧复制',
    file: 'scripts/oversight-tui.mjs',
    find: '  if (staleOf(session, nowMs).stale) return null;\n  return reply;',
    replace: '  return reply;',
    test: ['oversight-tui.test.mjs', '超龄的等待不给建议回复'],
  },
  {
    id: 'v17-draft-needs-only',
    feature: '没有 suggestedReply 时不给草稿（不给假按钮）',
    desc: '退回「有 needs 就拼一段旁白进剪贴板」的旧行为',
    file: 'scripts/oversight-tui.mjs',
    find: '  if (!reply) return null;\n  // 超龄的等待',
    replace: '  if (!reply) {\n    const _n = typeof session?.needs === \'string\' ? sanitize(session.needs).trim() : \'\';\n    return _n ? `（目标会话正在等待：${_n}）` : null;\n  }\n  // 超龄的等待',
    test: ['oversight-tui.test.mjs', '草稿只含可直接发送的正文，不含 needs 这类元注释'],
  },
  {
    id: 'v18-detail-explain',
    feature: '详情页必须解释「已超龄」与为什么不给建议回复',
    desc: '把详情页的超龄说明整段删掉（用户会以为界面上少了东西）',
    file: 'scripts/oversight-tui.mjs',
    find: '  if (age.stale) {\n    const limit = fmtSpan(age.limitSec);',
    replace: '  if (false && age.stale) {\n    const limit = fmtSpan(age.limitSec);',
    test: ['oversight-tui.test.mjs', '详情页：超龄的会话必须说清'],
  },
  {
    id: 'v19-stopped-count',
    feature: '「已停」行要数出超龄降级的条数',
    desc: '不再报「其中 N 条超龄」——降级就变成了静默消失',
    file: 'scripts/tui-layout.mjs',
    find: "  const agedBit = aged ? ` · 其中 ${aged} 条超龄` : '';",
    replace: "  const agedBit = '';",
    test: ['tui-layout.test.mjs', 'stoppedSummary：降级来的条目要能被数出来'],
  },

  // ── 2026-11-11 检查表重做（去表头 / 零值压行 / 全绿一句）──────────────
  //
  // 这三条守的是逆向报告的三条硬结论（`2026-11-11-claude-status-block-reverse.md`）：
  // ① 从不给元表头 ② 零值不占行 ③ 首屏是判决句。把改法放回去，必须变红。
  {
    id: 'v20-checklist-header',
    feature: '检查区不再有「检查了什么 / 结论」元表头（它 7 处表格实例 0 处用表头）',
    desc: '把元表头那一行加回 composeListScreen',
    file: 'scripts/tui-layout.mjs',
    find: '    const shown = checklistLines(p.checklist, { cols, layout, useColor, skipKinds }).lines;\n    if (shown.length) {',
    replace: "    push(' 检查了什么' + ' '.repeat(Math.max(1, cols - 13 - displayWidth('结论'))) + '结论');\n    const shown = checklistLines(p.checklist, { cols, layout, useColor, skipKinds }).lines;\n    if (shown.length) {",
    test: ['tui-layout.test.mjs', '呈现：不再有「检查了什么 / 结论」这类元表头'],
  },
  {
    id: 'v21-zero-rows',
    feature: '零值的检查项不占行（`if(i===""||i==="none")continue`），但被数进收尾句',
    desc: '退回「四行一律占行」，包括 `没有会话问了没答` 这类零值行',
    file: 'scripts/tui-layout.mjs',
    find: '  const problems = list.filter((r) => !isQuietRow(r));\n  const quietRows = list.filter((r) => isQuietRow(r));',
    replace: '  const problems = list; // 回退版：零值行照旧占行\n  const quietRows = [];',
    test: ['tui-layout.test.mjs', '呈现：零值的检查项不占行，但被数进收尾句'],
  },
  {
    id: 'v22-quiet-blank',
    feature: '四项全零时必须有一句判决，不能变成空白（「没查」与「全清白」不能同形）',
    desc: '让全绿态直接不画（回到「一块空白」）',
    file: 'scripts/tui-layout.mjs',
    find: '    return { lines: [checklistSummaryLine(list.length, { cols, useColor, extra: suffix })], hidden: list.length, quiet: true };',
    replace: '    return { lines: [], hidden: list.length, quiet: true }; // 回退版：全零 → 空白',
    test: ['tui-layout.test.mjs', '呈现：四项全零时压成一句判决'],
  },
  {
    id: 'v23-monitor-alive',
    feature: '健康时「监视在跑」必须逐字说出来（它最容易被计数吞掉）',
    desc: '把收尾句里的「监视在跑」删掉，只留项数',
    file: 'scripts/tui-layout.mjs',
    find: "    const alive = health && health.data && health.data.healthy ? '监视在跑' : '';",
    replace: "    const alive = '';",
    test: ['tui-layout.test.mjs', '呈现：四项全零时压成一句判决'],
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
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}

/** 某条测试在输出里是 pass 还是 fail。 */
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
  const list = only ? MUTATIONS.filter((m) => m.id === only) : MUTATIONS;
  if (!list.length) {
    console.error(`没有匹配的回退项：${only}`);
    process.exitCode = 2;
    return;
  }

  // 先确认基线是绿的：否则「变红」什么也证明不了
  const namespaces = [...new Set(list.map((m) => m.test[0]))];
  for (const ns of namespaces) {
    const baseline = runTest(ns);
    if (baseline.code !== 0) {
      console.error(`✗ 基线不是绿的（${ns}），负向验证没有意义。`);
      console.error(baseline.out.split('\n').filter((l) => l.includes('✖')).slice(0, 5).join('\n'));
      process.exitCode = 1;
      return;
    }
  }
  console.log(`基线：${namespaces.join(' / ')} 全绿 ✓\n`);

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
    console.log(`${icon} ${m.id.padEnd(13)} ${m.feature}`);
    console.log(`      ${m.desc}`);
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

const isDirect = process.argv[1] && /verify-tui-negatives\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isDirect) main(process.argv.slice(2));
