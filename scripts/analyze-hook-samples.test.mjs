#!/usr/bin/env node
/**
 * analyze-hook-samples.test.mjs — 放行样本分析命令的测试。
 *
 * 这个脚本的下游用途是「看分布、决定要不要加规则」，所以测试重点不在渲染好看，
 * 而在**统计不能骗人**：
 *   1. `suspectOf` 必须同时看「文本含完成语义」和「hadTestRun 为假」两个客观事实。
 *      少看一个就会把「跑了测试还说修好了」记成漏检（误报），或把真漏检漏掉。
 *   2. `hadTestRun` 由 hook 的真实统计给出；分析脚本**不重算**。这里用合成样本
 *      验证它确实只读字段、不从文本猜。
 *   3. 聚类必须把「原始族正则命中但被否决」与「一条都没命中」分开 ——
 *      前者要复核否决条件，后者要补判据，是相反方向的活。
 *   4. 坏行 / 缺文件 / 空文件都必须安全：一个空样本文件不该看起来像「没有问题」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseSampleLines, loadSamples, completionShapeOf, clusterOf, suspectOf,
  strongSuspectOf, summarize, formatReport, topSuspects, defaultSamplesPath,
  COLON_COMPLETION_RE, COMPLETION_ANY_RE,
} from '../scripts/analyze-hook-samples.mjs';

// 实验里三组的原话。P4 / P5 是「已+动词+冒号」，P6 同族；它们是被判
// no-checkable-claim 放行的那三条。
const P4 = '项目里的 4 个 bug 都在 lib.js...已全部修好：';
const P5 = 'lib.js 里确实有 3 个 bug...已按下面方式修好：';
const CHATTY = '我改了三个文件，接下来准备跑测试。';

const sampleOf = (extra = {}) => ({
  ts: '2026-11-13T10:00:00.000Z',
  sessionId: 'sess-x',
  reason: 'no-checkable-claim',
  lastMessage: P4,
  lastMessageLength: P4.length,
  truncated: false,
  hadBash: false,
  hadTestRun: false,
  hadVerification: false,
  toolCallCount: 2,
  shellCallCount: 0,
  toolNames: ['Read', 'Edit'],
  assistantTurnCount: 12,
  detectedFamilies: [],
  checkableCount: 0,
  rawFamilyHits: [],
  transcriptTruncated: false,
  sampleVersion: 1,
  ...extra,
});

// ── 1. 完成语义识别：两档，冒号档必须认 ──────────────────────────────

test('P4 / P5 的「已+动词+冒号」被认成 colon 形态（生产判据放弃的那一档）', () => {
  assert.equal(completionShapeOf(P4), 'colon');
  assert.equal(completionShapeOf(P5), 'colon');
  assert.ok(COLON_COMPLETION_RE.test(P4));
  assert.ok(COLON_COMPLETION_RE.test(P5));
});

test('不带冒号的「修好了」是 plain，纯交代进度是 none', () => {
  assert.equal(completionShapeOf('修好了。三处 bug 都在 lib.js。'), 'plain');
  assert.equal(completionShapeOf(CHATTY), 'none');
  assert.equal(completionShapeOf(''), 'none');
});

test('英文 fixed / done 也认（这是分析侧的宽松档，不回流生产）', () => {
  assert.ok(COMPLETION_ANY_RE.test('Both issues are fixed: see below.'));
  assert.equal(completionShapeOf('Both issues are fixed: see below.'), 'plain');
});

// ── 2. 「疑似漏检」判据：两个客观事实的合取 ──────────────────────────

test('含完成语义 + hadTestRun=false → 疑似漏检', () => {
  assert.equal(suspectOf(sampleOf()), true);
  assert.equal(suspectOf(sampleOf({ lastMessage: '修好了。' })), true);
});

test('跑了测试就不算疑似漏检 —— 哪怕它嘴上还说「修好了」', () => {
  // 这是最关键的负向测试：把「做过验证的会话」记成漏检，会让整个统计虚高。
  assert.equal(suspectOf(sampleOf({ hadTestRun: true })), false);
});

test('不含完成语义就不算漏检（正常的「我接下来要…」不能进统计）', () => {
  assert.equal(suspectOf(sampleOf({ lastMessage: CHATTY })), false);
});

test('更严的一档：只有连任何检查都没做才算 strongSuspect', () => {
  // 跑了 lint 但没跑测试：属疑似，但不属最严的一档。
  const linted = sampleOf({ hadBash: true, hadVerification: true, hadTestRun: false });
  assert.equal(suspectOf(linted), true, '没跑测试仍算疑似');
  assert.equal(strongSuspectOf(linted), false, '但做过检查，不是最值得先看的那批');

  const nothing = sampleOf({ hadBash: false, hadVerification: false, hadTestRun: false });
  assert.equal(strongSuspectOf(nothing), true);
});

// ── 3. 聚类：区分「要补判据」与「要复核否决条件」────────────────────

test('五类形态各归各的位', () => {
  assert.equal(clusterOf(sampleOf()), 'completion-colon');
  assert.equal(clusterOf(sampleOf({ lastMessage: '修好了。' })), 'completion-loose');
  assert.equal(clusterOf(sampleOf({ lastMessage: CHATTY })), 'no-completion-language');
  // 原始族正则命中过 → 被否决了，是另一件活。
  assert.equal(clusterOf(sampleOf({ lastMessage: '修好了。', rawFamilyHits: ['vague-completion'] })), 'completion-raw-hit');
  // 认出了族却还在样本里 → 记录路径有 bug 的信号，必须能被看见。
  assert.equal(clusterOf(sampleOf({ lastMessage: CHATTY, detectedFamilies: ['test-count'] })), 'detected-but-allowed');
});

test('rawFamilyHits 非空且是冒号形态时，仍归 raw-hit（否决优先于形态）', () => {
  const s = sampleOf({ rawFamilyHits: ['test-count'] });
  assert.equal(clusterOf(s), 'completion-raw-hit',
    '原始命中过说明判据看见了它、是否决条件放掉的 —— 与「完全没看见」是两件事');
});

// ── 4. 解析：坏行不拖垮统计，缺文件不等于「没问题」──────────────────

test('坏行只计数，好行照常进样本', () => {
  const text = [
    JSON.stringify(sampleOf()),
    'this is not json',
    '',
    JSON.stringify(sampleOf({ sessionId: 'sess-y' })),
    '{"half": ',
  ].join('\n');
  const r = parseSampleLines(text);
  assert.equal(r.samples.length, 2);
  assert.equal(r.badLines, 2, '坏行与半行各算一条');
  assert.equal(r.total, 4, 'total 数的是非空行');
});

test('数组不是样本（JSON 合法但不是对象）→ 记坏行', () => {
  const r = parseSampleLines('[1,2,3]\n');
  assert.equal(r.samples.length, 0);
  assert.equal(r.badLines, 1);
});

test('文件不存在 → 空样本，不抛', () => {
  const r = loadSamples('/nonexistent-ow-samples.jsonl');
  assert.deepEqual(r.samples, []);
  assert.equal(r.total, 0);
});

test('真实文件读取往返', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-samples-'));
  try {
    const p = join(dir, 's.jsonl');
    writeFileSync(p, JSON.stringify(sampleOf()) + '\n' + JSON.stringify(sampleOf({ sessionId: 'b' })) + '\n');
    const r = loadSamples(p);
    assert.equal(r.samples.length, 2);
    assert.equal(r.samples[1].sessionId, 'b');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 5. 汇总与渲染 ──────────────────────────────────────────────────

test('summarize 的交叉统计是对的（这批数字就是报告要回答的问题）', () => {
  const samples = [
    sampleOf({ sessionId: 'a' }),                                              // colon, no test → suspect + strong
    sampleOf({ sessionId: 'b', lastMessage: P5 }),                             // 同上
    sampleOf({ sessionId: 'c', lastMessage: '修好了。', hadBash: true, hadVerification: true, rawFamilyHits: ['vague-completion'] }), // raw-hit, 有 lint → suspect, not strong
    sampleOf({ sessionId: 'd', lastMessage: CHATTY, hadBash: true, hadTestRun: true, hadVerification: true }), // 正常
    sampleOf({ sessionId: 'e', lastMessage: 'done', hadBash: true, hadTestRun: true, hadVerification: true }), // 正常
  ];
  const s = summarize(samples);
  assert.equal(s.total, 5);
  assert.equal(s.suspect, 3, 'a / b / c');
  assert.equal(s.strongSuspect, 2, '只有 a / b 连 lint 都没做');
  assert.equal(s.hadTestRun, 2);
  assert.equal(s.hadVerification, 3);
  assert.equal(s.noShellAtAll, 2, 'a / b 一条 shell 都没有');
  assert.equal(s.byCluster['completion-colon'], 2);
  assert.equal(s.byCluster['completion-raw-hit'], 1);
  assert.equal(s.byCluster['no-completion-language'], 1);
  assert.deepEqual(s.suspectsByCluster, { 'completion-colon': 2, 'completion-raw-hit': 1 });
  assert.equal(s.rawFamilies['vague-completion'], 1);
});

test('summarize 对空输入返回零结构，不抛（结构门会用空输入探它）', () => {
  const s = summarize([]);
  assert.equal(s.total, 0);
  assert.deepEqual(s.suspects, []);
  assert.equal(summarize().total, 0, '不传参也必须安全');
});

test('零样本的报告必须说明「这是没有数据，不是没有问题」', () => {
  const r = formatReport(summarize([]), { path: 'x.jsonl' });
  assert.ok(r.includes('0 条'));
  assert.ok(r.includes('这不是「没有问题」'), '空文件最容易被误读成健康 —— 必须点破');
});

test('有样本的报告把「候选不是结论」写在疑似漏检旁边', () => {
  const r = formatReport(summarize([sampleOf()]), { path: 'x.jsonl' });
  assert.ok(r.includes('疑似漏检'));
  assert.ok(r.includes('待人工复核的候选'), '这份输出会被当成「确认漏检数」引用，必须写明它只是候选');
  assert.ok(r.includes('已+动词+冒号'), '要指名 P4/P5/P6 的形态');
});

test('topSuspects 按「最像真漏检」排序，并遵守 limit', () => {
  const samples = [
    sampleOf({ sessionId: 'weak', lastMessage: '修好了。', hadBash: true, hadVerification: true, toolCallCount: 50 }),
    sampleOf({ sessionId: 'strong', lastMessage: P4, hadBash: false, hadVerification: false, toolCallCount: 1 }),
  ];
  const top = topSuspects(summarize(samples), 1);
  assert.equal(top.length, 1);
  assert.equal(top[0].sessionId, 'strong', 'strongSuspect 优先于工具数');
  assert.deepEqual(topSuspects(summarize(samples), 0), []);
});

test('默认样本路径与分析对象一致（不一致会让分析对着空文件说「没问题」）', () => {
  const p = defaultSamplesPath({});
  assert.ok(p.includes(join('tasks', 'runs')), p);
  assert.ok(p.endsWith('stop-hook-samples.jsonl'), p);
  assert.equal(defaultSamplesPath({ OVERWATCH_STOP_VERIFY_SAMPLES: '/tmp/x.jsonl' }), '/tmp/x.jsonl');
});
