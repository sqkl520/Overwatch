#!/usr/bin/env node
/**
 * asked.test.mjs — 「未回答的问题」信号的回归测试。
 *
 * 这个信号的判据全部来自实测分布，测试守的是那些区分：
 *   - 只有末尾是问句才算（正文中间的是修辞）
 *   - 开场客套必须排除（实测 18 个里有 7 个是「今天想做什么呢喵？」）
 *   - 刚问完的不能催（人可能正在看）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  lastAssistantText, endsWithQuestion, classifyQuestion,
  inspectTranscript, scanAll, formatResult, GREETING, DEFAULT_MIN_HOURS,
} from './asked.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ow-asked-'));
const HOUR = 3600e3;

const writeTranscript = (dir, name, records) => {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p;
};

const assistant = (text, ts) => ({
  type: 'assistant', timestamp: new Date(ts).toISOString(),
  message: { content: [{ type: 'text', text }] },
});

test('lastAssistantText 取最后一条有文字的 assistant，跳过工具调用', () => {
  const recs = [
    assistant('第一句', 1000),
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
    assistant('最后一句', 2000),
    { type: 'user', message: { content: '人说的话' } },
  ];
  const r = lastAssistantText(recs);
  assert.equal(r.text, '最后一句');
});

test('endsWithQuestion 只看末尾——正文中间的问号是修辞', () => {
  assert.equal(endsWithQuestion('要我做这个吗？'), true);
  assert.equal(endsWithQuestion('这是什么？反正做完了。'), false, '中间的问号不算');
  assert.equal(endsWithQuestion('已完成，工作区干净'), false);
  assert.equal(endsWithQuestion(''), false);
});

test('classifyQuestion：开场客套被单独识别', () => {
  // 实测 18 个问句结尾的会话里 7 个是这类，永远不会有人回
  for (const g of ['今天想做点什么呢喵？', '想从哪里开始呢？', '有什么需要帮忙的尽管说']) {
    assert.equal(classifyQuestion(g), 'greeting', `应判为客套：${g}`);
  }
});

test('classifyQuestion：带具体选项或动作的才是待决策', () => {
  assert.equal(classifyQuestion('Q3 — 你更想先看到哪个？\n- (a) 真跑一次\n- (b) 直接做宏'), 'decision');
  assert.equal(classifyQuestion('要我把新 JAR 发你测吗？'), 'decision');
  assert.equal(classifyQuestion('要我把它加进 .gitignore 吗？'), 'decision');
});

test('inspectTranscript：问句 + 够久 → 报出来', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    // 真实的待决策问句：问号在结尾。原文里那句「大约 400 行」是问句之前的说明。
    const p = writeTranscript(dir, 'a', [assistant('这个我没做过，大约 400 行。要不要我做这个？', now - 5 * HOUR)]);
    const r = inspectTranscript(p, { nowMs: now, minHours: 1 });
    assert.ok(r && !r.skipped);
    assert.equal(r.kind, 'decision');
    assert.equal(r.hours, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inspectTranscript：刚问完的跳过——人可能正在看', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    const p = writeTranscript(dir, 'b', [assistant('要我做这个吗？', now - 10 * 60e3)]);
    const r = inspectTranscript(p, { nowMs: now, minHours: 1 });
    assert.equal(r.skipped, 'too-recent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inspectTranscript：开场客套跳过', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    const p = writeTranscript(dir, 'c', [assistant('今天想做点什么呢喵？', now - 100 * HOUR)]);
    const r = inspectTranscript(p, { nowMs: now, minHours: 1 });
    assert.equal(r.skipped, 'greeting');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inspectTranscript：不以问句结尾的不报', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    const p = writeTranscript(dir, 'd', [assistant('已完成，工作区干净。', now - 100 * HOUR)]);
    assert.equal(inspectTranscript(p, { nowMs: now, minHours: 1 }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanAll：跳过 subagents 目录，按新旧排序', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    writeTranscript(join(dir, 'proj-a'), 'old', [assistant('要不要先做 A？', now - 50 * HOUR)]);
    writeTranscript(join(dir, 'proj-b'), 'new', [assistant('要不要先做 B？', now - 5 * HOUR)]);
    // subagents 必须被跳过：那是子 agent，不是人的会话
    writeTranscript(join(dir, 'proj-a', 'subagents'), 'sub', [assistant('要我做吗？', now - 99 * HOUR)]);
    const r = scanAll({ projectsRoot: dir, nowMs: now, minHours: 1 });
    assert.equal(r.found.length, 2, `不应扫到 subagents：${r.found.map((x) => x.filePath)}`);
    assert.ok(r.found[0].hours < r.found[1].hours, '最近的排前面');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('formatResult：空结果说明排除了多少，不是光说「没有」', () => {
  const out = formatResult({ found: [], scanned: 10, skipped: { greeting: 3, tooRecent: 2 } });
  assert.ok(out.includes('没有待回答'));
  assert.ok(out.includes('3'), '应报出排除了多少客套');
});

test('formatResult：有结果时按会话列出，带等待时长', () => {
  const out = formatResult({
    found: [{ project: 'demo', hours: 10, kind: 'decision', question: '要做吗？' }],
    scanned: 5, skipped: { greeting: 0, tooRecent: 0 },
  });
  assert.ok(out.includes('demo'));
  assert.ok(out.includes('10 小时前'));
  assert.ok(out.includes('待决策'));
});

test('DEFAULT_MIN_HOURS 是 1——刚问完不该催', () => {
  assert.equal(DEFAULT_MIN_HOURS, 1);
});

test('GREETING 不误伤真问题', () => {
  // 客套模式里有「需要我做什么」，别把它套到「需要我删掉旧包吗」上
  assert.equal(GREETING.test('需要我把旧三个删掉腾空间吗？'), false);
});
