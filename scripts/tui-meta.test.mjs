#!/usr/bin/env node
/**
 * tui-meta.test.mjs — 标题 / 末条 assistant / 「问了没答」的读取与缓存。
 *
 * 这些是列表页新增的两列（规划 §2.5）：标题替代被截断到 24 列的目录名，
 * 「近」列替代同义反复的 `reason`。两条都不能靠猜：读不到要说读不到。
 *
 * 用法：node --test scripts/tui-meta.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  META_TAIL_BYTES, createMetaCache, metaFromRecords, readTailRecords,
  transcriptPathFor, lastSpeakerOf, pendingQuestionOf,
} from './tui-meta.mjs';

// ── transcriptPathFor ─────────────────────────────────────────────────

test('transcriptPathFor：优先用 transcriptId，其次 sessionId', () => {
  const p = transcriptPathFor({ project: 'D--Projects-X', transcriptId: 'abc', sessionId: 'def' }, '/root');
  assert.equal(p.replace(/\\/g, '/'), '/root/D--Projects-X/abc.jsonl');
  const q = transcriptPathFor({ project: 'D--Projects-X', sessionId: 'def' }, '/root');
  assert.equal(q.replace(/\\/g, '/'), '/root/D--Projects-X/def.jsonl');
});

test('transcriptPathFor：缺 project 或 id 时返回 null，不拼一个不存在的路径', () => {
  assert.equal(transcriptPathFor({ sessionId: 'a' }, '/root'), null);
  assert.equal(transcriptPathFor({ project: 'p' }, '/root'), null);
  assert.equal(transcriptPathFor(null, '/root'), null);
});

// ── metaFromRecords（纯函数）─────────────────────────────────────────

const rec = (o) => o;

test('metaFromRecords：取最后一条 custom-title（后写的赢）', () => {
  const records = [
    rec({ type: 'custom-title', customTitle: '旧标题' }),
    rec({ type: 'custom-title', customTitle: '新标题' }),
  ];
  assert.equal(metaFromRecords(records).title, '新标题');
});

test('metaFromRecords：没有 custom-title 时退回 agent-name', () => {
  const records = [rec({ type: 'agent-name', agentName: '子 agent 名' })];
  assert.equal(metaFromRecords(records).title, '子 agent 名');
});

test('metaFromRecords：两个都没有时返回 null —— 不拿目录名伪装成标题', () => {
  assert.equal(metaFromRecords([rec({ type: 'user', message: {} })]).title, null);
  assert.equal(metaFromRecords([]).title, null);
  assert.equal(metaFromRecords(null).title, null);
});

test('metaFromRecords：取最后一条 assistant 的文本', () => {
  const records = [
    rec({ type: 'assistant', timestamp: '2026-11-10T00:00:00Z', message: { content: [{ type: 'text', text: '第一条' }] } }),
    rec({ type: 'assistant', timestamp: '2026-11-10T00:01:00Z', message: { content: [{ type: 'text', text: '最后一条' }] } }),
  ];
  const m = metaFromRecords(records);
  assert.equal(m.lastAssistant, '最后一条');
  assert.equal(m.lastAssistantAt, '2026-11-10T00:01:00Z');
});

test('metaFromRecords：assistant 只有 tool_use 没有文本时不产出「近」内容', () => {
  const records = [
    rec({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
  ];
  assert.equal(metaFromRecords(records).lastAssistant, '');
});

test('metaFromRecords：cwd 取最后一条带 cwd 的记录（会话中途可能 chdir）', () => {
  const records = [
    rec({ type: 'user', cwd: '/a' }),
    rec({ type: 'assistant', cwd: '/a/PerfScope' }),
  ];
  assert.equal(metaFromRecords(records).cwd, '/a/PerfScope');
});

// ── lastSpeakerOf / pendingQuestionOf ────────────────────────────────

test('lastSpeakerOf：区分助手结尾与真人结尾（轮到谁说话）', () => {
  assert.equal(lastSpeakerOf([
    rec({ type: 'user', message: { content: [{ type: 'text', text: '做完了吗？' }] } }),
  ]), 'human');
  assert.equal(lastSpeakerOf([
    rec({ type: 'assistant', message: { content: [{ type: 'text', text: '完成。' }] } }),
  ]), 'assistant');
});

test('lastSpeakerOf：tool_result 也算 user 记录，但它不是「人说话了」', () => {
  assert.equal(lastSpeakerOf([
    rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }),
    rec({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
  ]), 'assistant', 'tool_result 不该被当成真人接话');
});

test('pendingQuestionOf：只有「助手问、之后没人说话」才算问了没答', () => {
  const ask = rec({ type: 'assistant', message: { content: [{ type: 'text', text: '要我现在就把实测单交给你，还是你先看报告？' }] } });
  const answered = rec({ type: 'user', message: { content: [{ type: 'text', text: '先看报告' }] } });
  const done = rec({ type: 'assistant', message: { content: [{ type: 'text', text: '全部完成。' }] } });

  assert.ok(pendingQuestionOf([ask], { text: '要我现在就把实测单交给你，还是你先看报告？' }), '应该判成未答');
  assert.equal(pendingQuestionOf([ask, answered], { text: ask.message.content[0].text }), null,
    '人已经回了，不该再报');
  assert.equal(pendingQuestionOf([done], { text: '全部完成。' }), null, '不是问句');
  assert.equal(pendingQuestionOf([ask], { text: '' }), null, '空文本');
});

test('metaFromRecords：question 字段与 lastSpeaker 一致（助手问句才填）', () => {
  const ask = rec({ type: 'assistant', message: { content: [{ type: 'text', text: '继续吗？' }] } });
  assert.ok(metaFromRecords([ask]).question, '助手问句应被识别');
  const back = rec({ type: 'user', message: { content: [{ type: 'text', text: '继续吗？' }] } });
  assert.equal(metaFromRecords([back]).question, null, '真人问句不该算「它在等我回答」');
});

// ── readTailRecords（真实临时文件）──────────────────────────────────

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ow-tui-meta-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('readTailRecords：读到尾部记录，坏行被丢弃而不是让整份失败', () => {
  withTempDir((dir) => {
    const p = join(dir, 'a.jsonl');
    writeFileSync(p, [
      JSON.stringify({ type: 'custom-title', customTitle: '标题' }),
      '{ 坏行',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '好' }] } }),
    ].join('\n') + '\n', 'utf8');
    const r = readTailRecords(p);
    assert.equal(r.records.length, 2, `坏行应被跳过，实际 ${r.records.length}`);
    assert.equal(metaFromRecords(r.records).title, '标题');
  });
});

test('readTailRecords：不存在的文件返回空记录，不抛', () => {
  const r = readTailRecords('/definitely/not/here.jsonl');
  assert.deepEqual(r.records, []);
  assert.equal(r.size, 0);
});

test('readTailRecords：超长文件只读尾部，且不把半截行当成记录', () => {
  withTempDir((dir) => {
    const p = join(dir, 'big.jsonl');
    // 每条 ~120 字节；写 2000 条 = ~240KB，超过 128KB 窗口
    const lines = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(JSON.stringify({ type: 'assistant', n: i, message: { content: [{ type: 'text', text: `第 ${i} 条` }] } }));
    }
    writeFileSync(p, lines.join('\n') + '\n', 'utf8');
    const r = readTailRecords(p);
    assert.equal(r.truncated, true, '应标记为截断');
    assert.ok(r.records.length > 0);
    assert.ok(r.records.length < 2000, '不该读整份文件');
    // 最后一条必须是真的最后一条（半截行已被丢弃）
    assert.equal(metaFromRecords(r.records).lastAssistant, '第 1999 条');
  });
});

test('META_TAIL_BYTES：128 KB，与规划里的实测窗口一致', () => {
  assert.equal(META_TAIL_BYTES, 128 * 1024);
});

// ── 缓存 ──────────────────────────────────────────────────────────────

test('createMetaCache：mtime 不变时不重读（8 秒轮询不能每轮读全量）', () => {
  let reads = 0;
  const cache = createMetaCache({
    read: () => {
      reads++;
      return { records: [{ type: 'custom-title', customTitle: 'T' }] };
    },
  });
  cache.get('/x', { mtimeMs: 100 });
  cache.get('/x', { mtimeMs: 100 });
  cache.get('/x', { mtimeMs: 100 });
  assert.equal(reads, 1, `应只读 1 次，实际 ${reads}`);
  assert.equal(cache.stats().reads, 1);
});

test('createMetaCache：mtime 变化时重读（transcript 追加了新内容）', () => {
  let n = 0;
  const cache = createMetaCache({
    read: () => {
      n++;
      return { records: [{ type: 'custom-title', customTitle: `T${n}` }] };
    },
  });
  assert.equal(cache.get('/x', { mtimeMs: 100 }).title, 'T1');
  assert.equal(cache.get('/x', { mtimeMs: 200 }).title, 'T2');
  assert.equal(n, 2);
});

test('createMetaCache：条目数有上限，超出时丢最旧的', () => {
  const cache = createMetaCache({ maxEntries: 3, read: () => ({ records: [] }) });
  for (const k of ['a', 'b', 'c', 'd']) cache.get(`/${k}`, { mtimeMs: 1 });
  assert.equal(cache.stats().entries, 3);
  // 'a' 已被挤出：再取它会触发一次新的读
  const before = cache.stats().reads;
  cache.get('/a', { mtimeMs: 1 });
  assert.equal(cache.stats().reads, before + 1, '最旧的条目应已被丢弃');
});

test('createMetaCache：file 为 null / 空时返回空结果，不进缓存', () => {
  const cache = createMetaCache({ read: () => { throw new Error('不该被调用'); } });
  assert.deepEqual(cache.get(null), { title: null, lastAssistant: '', lastAssistantAt: null, mtimeMs: null });
  assert.equal(cache.stats().entries, 0);
});

test('createMetaCache：读失败的那一次不缓存「成功」', () => {
  // 文件被删 / 读不动时返回空记录。下一次 mtime 变化要能重新试。
  let calls = 0;
  const cache = createMetaCache({
    read: (p) => {
      calls++;
      if (p === '/bad') return { records: [], size: 0, truncated: false };
      return { records: [{ type: 'custom-title', customTitle: 'ok' }] };
    },
  });
  assert.equal(cache.get('/bad', { mtimeMs: 1 }).title, null);
  assert.equal(cache.get('/good', { mtimeMs: 1 }).title, 'ok');
  assert.equal(calls, 2);
});

test('createMetaCache：clear() 清空', () => {
  const cache = createMetaCache({ read: () => ({ records: [] }) });
  cache.get('/x', { mtimeMs: 1 });
  cache.clear();
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().reads, 0);
});
