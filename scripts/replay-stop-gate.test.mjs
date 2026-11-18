#!/usr/bin/env node
/**
 * replay-stop-gate.test.mjs — 「开闸会拦多少」这个数字的分母必须是对的。
 *
 * 这个工具的**唯一用途**是回答「把 Stop 闸从 observe 改成 block，会拦多少个真实会话」，
 * 它是一个开闸决策的依据。而它出过一次**分母错**：第一版没排除子 agent 的 transcript，
 * 报出 19.6%，真实值是 4.8% —— 高估约 4 倍。
 *
 * 为什么子 agent 不该算：Stop 是「宿主准备结束回合」时触发的，子 agent 的回合
 * 不经过那个入口。拿它们算拦截率，等于用一份永远不会被调用的语料论证开闸代价。
 *
 * 这类错误**不会报错**，只会给出一个看起来合理的百分数。所以这里用构造语料
 * 把三个档位的分界钉死。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, 'replay-stop-gate.mjs');

/** 一份最小 transcript：一次源码编辑 + 一条完成声明，中间没有测试运行。
 *  这样的会话在 block 模式下**一定**会被拦（NO_EVIDENCE），正好当探针。 */
const BLOCKING_TRANSCRIPT = [
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: '改完了。' },
        { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/x/a.mjs' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] },
  }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '全部测试通过，336/336。' }] },
  }),
].join('\n');

/** 一份不会被拦的：完成声明 + 之后还跑过测试。 */
const CLEAN_TRANSCRIPT = [
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/x/a.mjs' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm run test' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: false }] },
  }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '全部测试通过，336/336。' }] },
  }),
].join('\n');

function fixture(layout) {
  const root = mkdtempSync(join(tmpdir(), 'ow-replay-'));
  for (const [rel, content] of Object.entries(layout)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

const run = (root) => {
  const r = spawnSync(process.execPath, [CLI, '--root', root, '--json'], {
    encoding: 'utf8', timeout: 60000,
  });
  return { status: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
};

test('主会话被拦时，live 与 real 都计入', () => {
  const root = fixture({ 'proj/main-session.jsonl': BLOCKING_TRANSCRIPT });
  try {
    const { status, json } = run(root);
    assert.equal(status, 0);
    assert.equal(json.live.transcripts, 1);
    assert.equal(json.live.strictBlocks, 1, '这份语料在 block 模式下必被拦');
    assert.equal(json.real.transcripts, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('子 agent transcript 计入 real，但**绝不**计入 live —— 这是本工具的核心判据', () => {
  const root = fixture({
    'proj/main-session.jsonl': CLEAN_TRANSCRIPT,
    'proj/parent-sess/subagents/agent-1.jsonl': BLOCKING_TRANSCRIPT,
  });
  try {
    const { json } = run(root);

    assert.equal(json.real.transcripts, 2, '非沙箱口径两份都算');
    assert.equal(json.real.strictBlocks, 1, '子 agent 那份确实会被判拦');

    assert.equal(json.live.transcripts, 1, 'live 只算主会话');
    assert.equal(json.live.strictBlocks, 0, '主会话是干净的，不该被拦');

    // 这一条是负向的：如果 SUBAGENT_RE 失效，live 会变成 transcripts=2 / blocks=1，
    // 拦截率从 0% 跳到 50%。那是「用不会跑闸的语料论证开闸代价」。
    assert.notEqual(json.live.transcripts, 2, '子 agent 混进 live 就是分母错了');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('沙箱目录既不算 real 也不算 live', () => {
  const root = fixture({
    'proj/main.jsonl': CLEAN_TRANSCRIPT,
    'C--Users-X-AppData-Local-Temp-hook-e2e-proj/s1.jsonl': BLOCKING_TRANSCRIPT,
  });
  try {
    const { json } = run(root);
    assert.equal(json.all.transcripts, 2, '含沙箱口径看得到全部');
    assert.equal(json.real.transcripts, 1, '沙箱不进 real');
    assert.equal(json.live.transcripts, 1, '沙箱也不进 live');
    assert.equal(json.live.strictBlocks, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('根目录不存在时退出码 2，不伪造全零报告', () => {
  const r = spawnSync(process.execPath, [CLI, '--root', join(tmpdir(), 'definitely-not-here-ow-r')], {
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal(r.status, 2);
  assert.match(String(r.stderr), /找不到 transcript 根/);
});
