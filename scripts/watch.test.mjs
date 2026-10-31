#!/usr/bin/env node
/**
 * watch.test.mjs — 三层轮询、去重、限额、状态文件、日志轮转的回归测试。
 *
 * 运行：node --test scripts/watch.test.mjs
 *
 * 全部用 mkdtemp 临时目录，**不碰真实的 %LOCALAPPDATA%**：
 * 每个用例都显式传 dir，不用 defaultStateDir()。
 * 通知一律注入假 notifier，不会真的弹窗。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  dedupeKey, reasonClass, canNotify, recordSent, emptyState, loadState, saveState,
  probeJobs, probeMtime, diffProbe, foldProbe, candidatesFromScan,
  createLogger, dispatchCandidates, runTick, defaultStateDir, __internals,
  findStopPoint, readTranscriptTail, classifyCandidate, createObservationLog,
  observationStats, formatStats, NOTIFY_KINDS, unclassifiableMinIdleSec, tooRecentToNotify,
} from './watch.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ow-watch-test-'));
const MIN = 60_000;

// ── 去重（AC2）────────────────────────────────────────────────────────

test('AC2 去重：同一个键只通知一次，喂 3 次相同状态只出 1 条', async () => {
  const dir = tmp();
  try {
    const calls = [];
    const notifier = async (n) => { calls.push(n); };
    const state = emptyState();
    const candidate = {
      sessionId: 'sess-1', state: 'STALLED',
      reason: 'novelty=0.18,0.15,0.12', project: 'demo', source: 'scan',
    };

    // 三轮，每轮间隔 11 分钟（跨过全局 10 分钟间隔，确保不是限额在挡）
    let now = Date.now();
    for (let i = 0; i < 3; i++) {
      await dispatchCandidates([candidate], { state, logger: null, notifier, nowMs: now });
      now += 11 * MIN;
    }
    assert.equal(calls.length, 1, '相同键必须只发一次');
    const key = dedupeKey('sess-1', 'STALLED', 'novelty=0.18,0.15,0.12');
    assert.equal(state.notified[key].notifyCount, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC2 去重：reason 变化视为新事件', async () => {
  const dir = tmp();
  try {
    const calls = [];
    const notifier = async (n) => { calls.push(n); };
    const state = emptyState();
    let now = Date.now();

    await dispatchCandidates([{ sessionId: 's', state: 'STALLED', reason: 'novelty=0.2', project: 'p' }],
      { state, notifier, nowMs: now });
    now += 11 * MIN;
    // 原因变了：novelty → hb_gap
    await dispatchCandidates([{ sessionId: 's', state: 'STALLED', reason: 'hb_gap=400s > p95=120s', project: 'p' }],
      { state, notifier, nowMs: now });

    assert.equal(calls.length, 2, 'reason 变化必须再发一条');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC2 去重键：sessionId | state | reasonClass | evidenceFingerprint 的 sha256 前 16 位', () => {
  const k = dedupeKey('abc', 'STALLED', 'novelty=0.1', 'fp1');
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(k, dedupeKey('abc', 'STALLED', 'novelty=0.1', 'fp1'), '同参数必须同键');

  // novelty 的数字每轮都漂，必须归为同一类，否则去重退化成限流
  assert.equal(
    dedupeKey('abc', 'STALLED', 'novelty=0.18,0.15,0.12', 'fp1'),
    dedupeKey('abc', 'STALLED', 'novelty=0.01,0.02,0.03', 'fp1'),
    'novelty 数字不同但同类，键必须相同',
  );

  // 但这些维度变化时必须换键
  assert.notEqual(k, dedupeKey('abc', 'FAILED', 'novelty=0.1', 'fp1'), 'state 变 → 新键');
  assert.notEqual(k, dedupeKey('abc', 'STALLED', 'hb_gap=1240s', 'fp1'), 'reason 类别变 → 新键');
  assert.notEqual(k, dedupeKey('abd', 'STALLED', 'novelty=0.1', 'fp1'), 'sessionId 变 → 新键');
  assert.notEqual(k, dedupeKey('abc', 'STALLED', 'novelty=0.1', 'fp2'), '证据指纹变（卡在别处）→ 新键');
});

test('reasonClass 剥掉会漂移的数字与括号', () => {
  assert.equal(reasonClass('novelty=0.18,0.15,0.12'), 'novelty');
  assert.equal(reasonClass('hb_gap=1240s > p95=620s'), 'hb_gap');
  assert.equal(reasonClass('dormant'), 'dormant');
  assert.equal(reasonClass('host-reported-blocked'), 'host-reported-blocked');
  assert.equal(reasonClass(''), 'unknown');
  assert.equal(reasonClass(null), 'unknown');
});

// ── 限额（AC6）────────────────────────────────────────────────────────

test('AC6 限额：每会话 24h 不超过 2 条', async () => {
  const dir = tmp();
  try {
    let n = 0;
    const notifier = async () => { n++; };
    const state = emptyState();
    let now = Date.now();
    // 5 个不同 **reason 类别**，同一会话，间隔 11 分钟。
    // 注意不能用 novelty=0.0/0.1/… —— 那几个剥掉数字后是同一个类，按设计只算一次。
    const reasons = ['novelty=0.1', 'hb_gap=600s', 'host-reported-failed', 'dormant', 'read-only'];
    for (const r of reasons) {
      await dispatchCandidates([{ sessionId: 'same', state: 'STALLED', reason: r, project: 'p' }],
        { state, notifier, nowMs: now });
      now += 11 * MIN;
    }
    assert.equal(n, 2, '同一会话 24h 内最多 2 条');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC6 限额：全局 24h 不超过 8 条', async () => {
  const dir = tmp();
  try {
    let n = 0;
    const notifier = async () => { n++; };
    const state = emptyState();
    let now = Date.now();
    for (let i = 0; i < 14; i++) {
      // 每 11 分钟一条，跨过 10 分钟间隔；会话各不相同，避开单会话限额
      await dispatchCandidates([{ sessionId: `s${i}`, state: 'FAILED', reason: 'host-reported-failed', project: 'p' }],
        { state, notifier, nowMs: now });
      now += 11 * MIN;
    }
    assert.equal(n, 8, '全局 24h 内最多 8 条');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC6 限额：全局 10 分钟内最多 1 条（突发合并）', async () => {
  const dir = tmp();
  try {
    let n = 0;
    const notifier = async () => { n++; };
    const state = emptyState();
    const now = Date.now();
    // 同一时刻 5 个不同会话同时 FAILED
    const burst = Array.from({ length: 5 }, (_, i) => ({
      sessionId: `b${i}`, state: 'FAILED', reason: 'host-reported-failed', project: 'p',
    }));
    const r = await dispatchCandidates(burst, { state, notifier, nowMs: now });
    assert.equal(n, 1, '突发只能发 1 条');
    assert.equal(r.suppressed.length, 4, '其余进 suppressed，不丢弃记录');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('限额：muteUntil 生效', async () => {
  const state = emptyState();
  const now = Date.now();
  state.muteUntil = new Date(now + 3600_000).toISOString();
  assert.equal(canNotify(state, 's', now).ok, false);
  assert.equal(canNotify(state, 's', now).why, 'muted');
});

test('限额：10 分钟窗口过后可再发', () => {
  const state = emptyState();
  const now = Date.now();
  recordSent(state, 'a', now);
  assert.equal(canNotify(state, 'b', now + 5 * MIN).ok, false);
  assert.equal(canNotify(state, 'b', now + 11 * MIN).ok, true);
});

// ── AC5 失败必须退回「仅记录」────────────────────────────────────────

test('AC5 notify 抛错时退回仅记录：写 ERROR 日志，不重试，不中断其它候选', async () => {
  const dir = tmp();
  try {
    const logs = [];
    const logger = {
      info: (m) => logs.push(['INFO', m]),
      warn: (m) => logs.push(['WARN', m]),
      error: (m) => logs.push(['ERROR', m]),
    };
    let attempts = 0;
    const notifier = async () => { attempts++; throw new Error('wscript 不见了'); };
    const state = emptyState();
    const now = Date.now();

    const r = await dispatchCandidates(
      [{ sessionId: 'x', state: 'FAILED', reason: 'host-reported-failed', project: 'p' }],
      { state, logger, notifier, nowMs: now },
    );

    assert.equal(r.failed.length, 1, '失败必须上报');
    assert.equal(r.failed[0].error, 'wscript 不见了');
    assert.ok(logs.some(([lvl, m]) => lvl === 'ERROR' && m.includes('notify-failed')));
    const key = dedupeKey('x', 'FAILED', 'host-reported-failed');
    assert.equal(state.notified[key].delivery, 'failed');
    assert.equal(attempts, 1, '不得静默重试');

    // 下一轮：不再重发（delivery=failed 的边沿不再触发）
    await dispatchCandidates(
      [{ sessionId: 'x', state: 'FAILED', reason: 'host-reported-failed', project: 'p' }],
      { state, logger, notifier, nowMs: now + 11 * MIN },
    );
    assert.equal(attempts, 1, '失败后不得重试');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 状态文件（AC1）───────────────────────────────────────────────────

test('AC1/状态格式：写出的 JSON 含文档要求的全部字段', () => {
  const dir = tmp();
  try {
    const state = emptyState();
    state.lastJobsScanAt = '2026-10-30T21:00:00.000Z';
    state.lastProbeAt = '2026-10-30T21:00:00.000Z';
    state.lastFullScanAt = '2026-10-30T21:00:00.000Z';
    const key = dedupeKey('s', 'FAILED', 'r');
    state.notified[key] = {
      sessionId: 's', state: 'FAILED', reason: 'r',
      firstSeenAt: '2026-10-30T21:00:00.000Z', lastNotifiedAt: '2026-10-30T21:00:00.000Z',
      notifyCount: 1, ackAt: null,
    };
    recordSent(state, 's', Date.now());
    saveState(dir, state);

    const raw = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.equal(raw.version, 1);
    for (const f of ['lastJobsScanAt', 'lastProbeAt', 'lastFullScanAt', 'notified', 'budget', 'muteUntil']) {
      assert.ok(f in raw, `缺字段 ${f}`);
    }
    const entry = raw.notified[key];
    for (const f of ['sessionId', 'state', 'reason', 'firstSeenAt', 'lastNotifiedAt', 'notifyCount', 'ackAt']) {
      assert.ok(f in entry, `notified 条目缺字段 ${f}`);
    }
    assert.equal(entry.ackAt, null);
    assert.ok('day' in raw.budget && 'sent' in raw.budget);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC1：状态文件路径不在仓库内，可由 OVERWATCH_STATE_DIR 改道', () => {
  const custom = join(tmpdir(), 'ow-dir-check');
  assert.equal(defaultStateDir({ OVERWATCH_STATE_DIR: custom, LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }), custom);
  const real = defaultStateDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' });
  assert.ok(!real.toLowerCase().includes('projects\\overwatch'), '不得落在仓库内');
});

test('状态损坏：改名留证并从空状态起步，不静默吞', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'state.json'), '{ this is not json');
    const logs = [];
    const logger = { info: () => {}, warn: () => {}, error: (m) => logs.push(m) };
    const { state, corrupt } = loadState(dir, { logger });
    assert.equal(corrupt, true);
    assert.equal(state.notified && Object.keys(state.notified).length, 0);
    assert.ok(logs.some((m) => m.includes('corrupt')), '必须留下 ERROR 日志');
    assert.ok(!existsSync(join(dir, 'state.json')), '坏文件必须被移走');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── AC7 日志轮转 ─────────────────────────────────────────────────────

test('AC7 日志：单文件上限 1MB，超出轮转到 .log.1', () => {
  const dir = tmp();
  try {
    const logger = createLogger(dir, { maxBytes: 2000 });
    const line = 'x'.repeat(100);
    let written = 0;
    for (let i = 0; i < 100; i++) { logger.info(line); written++; }

    const f = join(dir, 'watch.log');
    const r = join(dir, 'watch.log.1');
    assert.ok(existsSync(f), 'watch.log 必须存在');
    assert.ok(existsSync(r), '超出上限必须轮转到 watch.log.1');
    assert.ok(statSync(f).size <= 2000, `当前日志不得超过上限，实际 ${statSync(f).size}`);
    assert.ok(statSync(r).size > 0, '轮转文件必须有内容');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC7 日志：行格式为 ISO-[LEVEL]-消息', () => {
  const dir = tmp();
  try {
    const logger = createLogger(dir);
    logger.info('probe=48ms changed=0 skipped=1');
    const line = readFileSync(join(dir, 'watch.log'), 'utf8').trim().split('\n')[0];
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \[INFO\] probe=48ms changed=0 skipped=1$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 三层轮询（AC3）───────────────────────────────────────────────────

test('AC3 L-fast：从 jobs 目录识别 failed/blocked，且不读 claude agents', () => {
  const root = tmp();
  try {
    const now = Date.now();
    const mk = (name, body) => {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, 'state.json'), JSON.stringify(body));
    };
    mk('a', { state: 'failed', sessionId: 'sa', updatedAt: new Date(now).toISOString(), cwd: 'D:\\Projects\\X' });
    mk('b', { state: 'blocked', sessionId: 'sb', updatedAt: new Date(now).toISOString(), cwd: 'D:\\Projects\\Y', needs: '等授权' });
    mk('c', { state: 'done', sessionId: 'sc', updatedAt: new Date(now).toISOString() });
    mk('d', { state: 'failed', sessionId: 'sd', updatedAt: new Date(now - 48 * 3600_000).toISOString() });
    mkdirSync(join(root, 'broken'), { recursive: true });
    writeFileSync(join(root, 'broken', 'state.json'), '{half');

    const r = probeJobs(root);
    const ids = r.found.map((f) => f.sessionId).sort();
    assert.deepEqual(ids, ['sa', 'sb'], '只报活跃窗口内的 failed/blocked');
    assert.equal(r.found.find((f) => f.sessionId === 'sa').state, 'FAILED');
    assert.equal(r.found.find((f) => f.sessionId === 'sb').state, 'BLOCKED');
    assert.ok(r.elapsedMs >= 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC3 L-mid：mtime 探针不递归子目录，diff 只报变化的项目', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'proj-a'), { recursive: true });
    mkdirSync(join(root, 'proj-b'), { recursive: true });
    // 子目录里的 jsonl 不得被算进来（递归会让 50ms 涨到 ~1s）
    mkdirSync(join(root, 'proj-a', 'sub'), { recursive: true });
    writeFileSync(join(root, 'proj-a', 'sub', 'deep.jsonl'), '{}');
    writeFileSync(join(root, 'proj-b', 'sub2.jsonl'), '{}\n');
    writeFileSync(join(root, 'proj-a', 's1.jsonl'), '{}\n');

    const p1 = probeMtime(root);
    assert.deepEqual(p1.projects.map((p) => p.project).sort(), ['proj-a', 'proj-b']);
    assert.equal(p1.projects.find((p) => p.project === 'proj-a').fileCount, 1, '不得递归');

    // 反证：只动子目录里的文件，探针必须看不见 —— 否则说明递归了
    const prev = foldProbe({}, p1);
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(join(root, 'proj-a', 'sub', 'deep.jsonl'), future, future);
    assert.deepEqual(diffProbe(prev, probeMtime(root)), [], '子目录变化不得影响顶层 mtime');

    // 正证：动顶层文件必须被探测到
    utimesSync(join(root, 'proj-a', 's1.jsonl'), future, future);
    assert.deepEqual(diffProbe(prev, probeMtime(root)), ['proj-a'], '顶层变化必须被探测到');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC3 层调度：第二轮不会重跑全量（L-full 只在 30 分钟到期时跑）', async () => {
  const dir = tmp();
  const claude = tmp();
  try {
    mkdirSync(join(claude, 'jobs'), { recursive: true });
    mkdirSync(join(claude, 'projects'), { recursive: true });
    let fullRuns = 0;
    let incRuns = 0;
    const scan = async ({ project }) => {
      if (project) incRuns++; else fullRuns++;
      return { sessions: [], elapsedMs: 1, exitCode: 0 };
    };
    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const notifier = async () => {};

    let now = Date.now();
    await runTick({ dir, claudeDir: claude, logger, notifier, scan, nowMs: now });
    assert.equal(fullRuns, 1, '首轮应跑一次全量');

    // 30 秒后：三层都没到期（1min / 5min / 30min）
    now += 30_000;
    await runTick({ dir, claudeDir: claude, logger, notifier, scan, nowMs: now });
    assert.equal(fullRuns, 1, '30 秒后不得重跑全量');

    // 2 分钟后：只有 L-fast 到期
    now += 2 * MIN;
    const s2 = await runTick({ dir, claudeDir: claude, logger, notifier, scan, nowMs: now });
    assert.deepEqual(s2.ran, ['jobs'], '2 分钟后只应跑 jobs');
    assert.equal(fullRuns, 1);

    // 再 4 分钟（累计 6 分钟）：L-mid 到期，但没变化 → 不起增量扫描
    now += 4 * MIN;
    const s3 = await runTick({ dir, claudeDir: claude, logger, notifier, scan, nowMs: now });
    assert.ok(s3.ran.includes('probe'));
    assert.equal(incRuns, 0, '没有变化不得起增量扫描');
    assert.equal(fullRuns, 1, '全量仍不得重跑');

    // 31 分钟后：L-full 到期
    now += 31 * MIN;
    await runTick({ dir, claudeDir: claude, logger, notifier, scan, nowMs: now });
    assert.equal(fullRuns, 2, '31 分钟后应再跑一次全量');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
  }
});

test('AC3 层调度：projects 有变化时只对变化的项目跑增量', async () => {
  const dir = tmp();
  const claude = tmp();
  try {
    mkdirSync(join(claude, 'jobs'), { recursive: true });
    mkdirSync(join(claude, 'projects', 'proj-x'), { recursive: true });
    mkdirSync(join(claude, 'projects', 'proj-y'), { recursive: true });
    writeFileSync(join(claude, 'projects', 'proj-x', 'a.jsonl'), '{}\n');
    writeFileSync(join(claude, 'projects', 'proj-y', 'b.jsonl'), '{}\n');

    const scanned = [];
    const scan = async ({ project }) => {
      if (project) scanned.push(project);
      return { sessions: [], elapsedMs: 1, exitCode: 0 };
    };
    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const now = Date.now();
    // 首轮（会全量扫一次）之后记下基线
    await runTick({ dir, claudeDir: claude, logger, notifier: async () => {}, scan, nowMs: now, forceFull: false });

    // 改一个项目，跳 6 分钟让 L-mid 到期
    const later = new Date(Date.now() + 60_000);
    writeFileSync(join(claude, 'projects', 'proj-x', 'a.jsonl'), '{}\n{}\n');
    // 显式把 mtime 顶到未来，避免文件系统时间精度导致探测不到
    utimesSync(join(claude, 'projects', 'proj-x', 'a.jsonl'), later, later);

    scanned.length = 0;
    await runTick({ dir, claudeDir: claude, logger, notifier: async () => {}, scan, nowMs: now + 6 * MIN });
    assert.deepEqual(scanned, ['proj-x'], '只扫变化的项目');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
  }
});

// ── 候选筛选 ─────────────────────────────────────────────────────────

test('只把活跃窗口内的 FAILED/BLOCKED/STALLED 转成候选', () => {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const sessions = [
    { sessionId: 'a', state: 'FAILED', reason: 'r', lastActivity: iso(60_000) },
    { sessionId: 'b', state: 'STALLED', reason: 'r', lastActivity: iso(60_000) },
    { sessionId: 'c', state: 'PRODUCING', reason: 'r', lastActivity: iso(60_000) },
    { sessionId: 'd', state: 'EXPLORING', reason: 'r', lastActivity: iso(60_000) },
    { sessionId: 'e', state: 'BLOCKED', reason: 'r', lastActivity: iso(48 * 3600_000) },
  ];
  const c = candidatesFromScan(sessions, { nowMs: now });
  assert.deepEqual(c.map((x) => x.sessionId).sort(), ['a', 'b'], 'PRODUCING/EXPLORING/陈旧会话不得通知');
});

test('runTick 的 dry-run 会算出候选但不发通知', async () => {
  const dir = tmp();
  const claude = tmp();
  try {
    const now = Date.now();
    mkdirSync(join(claude, 'jobs', 'j1'), { recursive: true });
    writeFileSync(join(claude, 'jobs', 'j1', 'state.json'), JSON.stringify({
      state: 'failed', sessionId: 's1', updatedAt: new Date(now).toISOString(), cwd: 'D:\\P\\demo',
    }));
    mkdirSync(join(claude, 'projects'), { recursive: true });
    let notified = 0;
    const r = await runTick({
      dir, claudeDir: claude, nowMs: now, dryRun: true,
      notifier: async () => { notified++; },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      scan: async () => ({ sessions: [], elapsedMs: 1, exitCode: 0 }),
    });
    assert.equal(notified, 0, 'dry-run 不得发通知');
    assert.equal(r.sent.length, 1, 'dry-run 仍应算出 1 条候选');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
  }
});

test('L-fast 与 L-full 报同一事件时只发一条（三层共享去重）', async () => {
  const dir = tmp();
  const claude = tmp();
  try {
    const now = Date.now();
    mkdirSync(join(claude, 'jobs', 'j1'), { recursive: true });
    writeFileSync(join(claude, 'jobs', 'j1', 'state.json'), JSON.stringify({
      state: 'failed', sessionId: 'dup', updatedAt: new Date(now).toISOString(), cwd: 'D:\\P\\demo',
    }));
    mkdirSync(join(claude, 'projects'), { recursive: true });

    let n = 0;
    const r = await runTick({
      dir, claudeDir: claude, nowMs: now, forceFull: true,
      notifier: async () => { n++; },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      // 全量扫描也报同一个会话同一个 reason —— 这正是「两层都发现」的真实情况
      scan: async () => ({
        sessions: [{ sessionId: 'dup', state: 'FAILED', reason: 'host-reported-failed', lastActivity: new Date(now).toISOString() }],
        elapsedMs: 1, exitCode: 1,
      }),
    });
    assert.equal(n, 1, '同一事件只能发一条');
    assert.equal(r.already + r.sent.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
  }
});

test('限额常量与规格一致', () => {
  assert.equal(__internals.PER_SESSION_MAX_24H, 2);
  assert.equal(__internals.GLOBAL_MAX_24H, 8);
  assert.equal(__internals.GLOBAL_MIN_GAP, 10 * MIN);
  assert.equal(__internals.JOBS_INTERVAL, 1 * MIN);
  assert.equal(__internals.PROBE_INTERVAL, 5 * MIN);
  assert.equal(__internals.FULL_INTERVAL, 30 * MIN);
  assert.equal(__internals.LOG_MAX_BYTES, 1024 * 1024);
});

// ── 停止分类接入 ─────────────────────────────────────────────────────

/** 造一个 transcript：一轮干净结束，下一句是 task-notification（68% 的真实形态）。 */
function writeWaitingSubagent(path, sessionId) {
  const recs = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: '跑一下测试' }, permissionMode: 'default' },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '好' }] } },
    { type: 'user', uuid: 'u2', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>done</task-notification>' } },
  ];
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  void sessionId;
}

test('分类：findStopPoint 定位最后一条 assistant，并切出 afterRecords', () => {
  const stop = findStopPoint([
    { type: 'user', uuid: 'u1' },
    { type: 'assistant', uuid: 'a1', message: { stop_reason: 'tool_use' } },
    { type: 'user', uuid: 'u2' },
    { type: 'assistant', uuid: 'a2', message: { stop_reason: 'tool_use' } },
    { type: 'user', uuid: 'u3' },
  ]);
  assert.equal(stop.stopRecord.uuid, 'a2', '停止点必须是最后一条 assistant');
  assert.equal(stop.afterRecords.length, 1);
  assert.equal(stop.afterRecords[0].uuid, 'u3');
  assert.equal(stop.history.length, 4, 'history 含停止点本身');
  assert.equal(findStopPoint([{ type: 'user' }]), null);
  assert.equal(findStopPoint([]), null);
});

test('分类：WAITING_SUBAGENT 被抑制，不发通知，但写进观察日志', async () => {
  const root = tmp();
  try {
    const sid = 'sess-wait';
    mkdirSync(join(root, 'projects', 'proj-a'), { recursive: true });
    mkdirSync(join(root, 'jobs', 'j1'), { recursive: true });
    const now = Date.now();
    writeFileSync(join(root, 'jobs', 'j1', 'state.json'), JSON.stringify({
      state: 'failed', sessionId: sid, updatedAt: new Date(now).toISOString(), cwd: 'D:\\Projects\\proj-a',
    }));
    writeWaitingSubagent(join(root, 'projects', 'proj-a', `${sid}.jsonl`));
    let n = 0;
    const r = await runTick({
      dir: join(root, 'state'), claudeDir: root, nowMs: now, forceFull: true,
      notifier: async () => { n++; },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      scan: async () => ({ sessions: [], elapsedMs: 1, exitCode: 0 }),
    });
    assert.equal(n, 0, '等子 Agent 的停止不得发通知');
    assert.equal(r.sent.length, 0);
    assert.equal(r.suppressed.length, 1);
    assert.equal(r.suppressed[0].kind, 'WAITING_SUBAGENT');

    const raw = readFileSync(join(root, 'state', 'observations.jsonl'), 'utf8').trim().split('\n');
    assert.equal(raw.length, 1, '被抑制的也必须进观察日志');
    const o = JSON.parse(raw[0]);
    assert.equal(o.kind, 'WAITING_SUBAGENT');
    assert.equal(o.notified, false);
    assert.equal(o.why, 'waiting-subagent-suppressed');
    assert.equal(o.state, 'FAILED');
    for (const f of ['ts', 'sessionId', 'state', 'kind', 'autoAnswerable', 'reason', 'confidence', 'notified', 'why']) {
      assert.ok(f in o, `观察行缺字段 ${f}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('分类：UNCLASSIFIABLE 停够 5 分钟才放行（判不了就当需要注意，但先给时间）', async () => {
  const root = tmp();
  try {
    const sid = 'sess-unk';
    mkdirSync(join(root, 'projects', 'proj-b'), { recursive: true });
    const now = Date.now();
    writeFileSync(join(root, 'projects', 'proj-b', `${sid}.jsonl`), [
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: '随便一句' }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    mkdirSync(join(root, 'jobs', 'j1'), { recursive: true });
    // 10 分钟前就失败了：过了时间门槛，必须放行
    writeFileSync(join(root, 'jobs', 'j1', 'state.json'), JSON.stringify({
      state: 'failed', sessionId: sid, updatedAt: new Date(now - 600_000).toISOString(), cwd: 'D:\\Projects\\proj-b',
    }));

    let n = 0;
    await runTick({
      dir: join(root, 'state'), claudeDir: root, nowMs: now, forceFull: true,
      notifier: async () => { n++; },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      scan: async () => ({ sessions: [], elapsedMs: 1, exitCode: 0 }),
    });
    assert.equal(n, 1, '停了 600s 的 UNCLASSIFIABLE 必须放行');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('时间门槛：UNCLASSIFIABLE idleSec=60 抑制，why=unclassifiable-too-recent', async () => {
  const calls = [];
  const r = await dispatchCandidates(
    [{ sessionId: 'u1', state: 'STALLED', reason: 'novelty=0.8', project: 'p', idleSec: 60, evidenceFingerprint: 'fp' }],
    {
      state: emptyState(), notifier: async (x) => { calls.push(x); }, nowMs: Date.now(),
      classify: (c) => ({ ts: new Date().toISOString(), sessionId: c.sessionId, state: c.state, kind: 'UNCLASSIFIABLE', autoAnswerable: false, reason: '判不了', confidence: null, notified: false, why: 'notifyable', classify: 'ok' }),
      env: {},
    },
  );
  assert.equal(calls.length, 0, '刚停 60s 不得通知');
  assert.equal(r.suppressed.length, 1);
  assert.equal(r.suppressed[0].why, 'unclassifiable-too-recent');
  assert.equal(r.observations[0].why, 'unclassifiable-too-recent', '不得复用 unclassifiable-suppressed');
  assert.equal(r.observations[0].notified, false);
});

test('时间门槛：UNCLASSIFIABLE idleSec=600 通知', async () => {
  const calls = [];
  const r = await dispatchCandidates(
    [{ sessionId: 'u2', state: 'STALLED', reason: 'novelty=0.8', project: 'p', idleSec: 600, evidenceFingerprint: 'fp' }],
    {
      state: emptyState(), notifier: async (x) => { calls.push(x); }, nowMs: Date.now(),
      classify: (c) => ({ ts: new Date().toISOString(), sessionId: c.sessionId, state: c.state, kind: 'UNCLASSIFIABLE', autoAnswerable: false, reason: '判不了', confidence: null, notified: false, why: 'notifyable', classify: 'ok' }),
      env: {},
    },
  );
  assert.equal(calls.length, 1, '停够 600s 必须通知');
  assert.equal(r.sent.length, 1);
  assert.equal(r.observations[0].notified, true);
});

test('时间门槛：OVERWATCH_UNCLASSIFIABLE_MIN_IDLE 覆盖默认值', async () => {
  assert.equal(unclassifiableMinIdleSec({}), 300);
  assert.equal(unclassifiableMinIdleSec({ OVERWATCH_UNCLASSIFIABLE_MIN_IDLE: '30' }), 30);
  assert.equal(unclassifiableMinIdleSec({ OVERWATCH_UNCLASSIFIABLE_MIN_IDLE: '0' }), 0, '0 是合法值，不能退回默认');
  assert.equal(unclassifiableMinIdleSec({ OVERWATCH_UNCLASSIFIABLE_MIN_IDLE: 'abc' }), 300, '坏值退回默认');
  assert.equal(unclassifiableMinIdleSec({ OVERWATCH_UNCLASSIFIABLE_MIN_IDLE: '-5' }), 300);

  const mk = (idleSec) => [{ sessionId: 'e1', state: 'STALLED', reason: 'novelty=0.8', project: 'p', idleSec, evidenceFingerprint: 'fp' }];
  const classify = (c) => ({ ts: new Date().toISOString(), sessionId: c.sessionId, state: c.state, kind: 'UNCLASSIFIABLE', autoAnswerable: false, reason: '判不了', confidence: null, notified: false, why: 'notifyable', classify: 'ok' });

  // 门槛降到 30s：60s 的候选必须放行（默认 300s 下它会被挡）
  let calls = 0;
  await dispatchCandidates(mk(60), {
    state: emptyState(), notifier: async () => { calls++; }, nowMs: Date.now(), classify,
    env: { OVERWATCH_UNCLASSIFIABLE_MIN_IDLE: '30' },
  });
  assert.equal(calls, 1, '环境变量必须生效');

  // 门槛抬到 900s：600s 的候选必须被挡
  calls = 0;
  const r = await dispatchCandidates(mk(600), {
    state: emptyState(), notifier: async () => { calls++; }, nowMs: Date.now(), classify,
    env: { OVERWATCH_UNCLASSIFIABLE_MIN_IDLE: '900' },
  });
  assert.equal(calls, 0);
  assert.equal(r.suppressed[0].why, 'unclassifiable-too-recent');

  // 0 = 关闭门槛
  calls = 0;
  await dispatchCandidates(mk(0), {
    state: emptyState(), notifier: async () => { calls++; }, nowMs: Date.now(), classify,
    env: { OVERWATCH_UNCLASSIFIABLE_MIN_IDLE: '0' },
  });
  assert.equal(calls, 1, '门槛为 0 时不得抑制');
});

test('时间门槛：EXTERNAL_BLOCKED 等确定信号不设门槛（idleSec=10 仍通知）', async () => {
  const calls = [];
  const r = await dispatchCandidates(
    [{
      sessionId: 'b1', state: 'BLOCKED', reason: 'host-reported-blocked', project: 'p',
      idleSec: 10, needs: '等授权', evidenceFingerprint: 'fp', source: 'jobs',
    }],
    {
      state: emptyState(), notifier: async (x) => { calls.push(x); }, nowMs: Date.now(),
      classify: (c) => ({ ts: new Date().toISOString(), sessionId: c.sessionId, state: c.state, kind: 'EXTERNAL_BLOCKED', autoAnswerable: false, reason: '宿主报 blocked', confidence: 1, notified: false, why: 'notifyable', classify: 'ok' }),
      env: {},
    },
  );
  assert.equal(calls.length, 1, 'jobs 的 blocked 是确定信号，不得被时间门槛吞掉');
  assert.equal(r.sent.length, 1);
  assert.equal(tooRecentToNotify('EXTERNAL_BLOCKED', 0, 300), false);
  assert.equal(tooRecentToNotify('WAITING_APPROVAL', 0, 300), false);
  assert.equal(tooRecentToNotify('PLAN_SUBMITTED', 0, 300), false);
  assert.equal(tooRecentToNotify('UNCLASSIFIABLE', 0, 300), true);
  assert.equal(tooRecentToNotify('UNCLASSIFIABLE', null, 300), false, 'idleSec 缺失不得变成永久不通知');
});

test('时间门槛：观察日志记录 idleSec / notified / why', async () => {
  const dir = tmp();
  try {
    const obs = createObservationLog(dir);
    await dispatchCandidates(
      [{ sessionId: 'o1', state: 'STALLED', reason: 'novelty=0.8', project: 'p', idleSec: 120, evidenceFingerprint: 'fp' }],
      {
        state: emptyState(), notifier: async () => {}, nowMs: new Date('2026-10-31T05:00:00Z').getTime(),
        observations: obs, env: {},
        classify: (c) => ({ ts: '2026-10-31T05:00:00Z', sessionId: c.sessionId, state: c.state, kind: 'UNCLASSIFIABLE', autoAnswerable: false, reason: '判不了', confidence: null, notified: false, why: 'notifyable', classify: 'ok' }),
      },
    );
    const row = JSON.parse(readFileSync(join(dir, 'observations.jsonl'), 'utf8').trim());
    assert.equal(row.idleSec, 120, '观察行必须带当时的 idleSec');
    assert.equal(row.notified, false);
    assert.equal(row.why, 'unclassifiable-too-recent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('时间门槛：jobs 候选带 idleSec（来自 updatedAt），端到端抑制 10 秒前的停止', async () => {
  const root = tmp();
  try {
    const sid = 'sess-recent';
    mkdirSync(join(root, 'projects', 'proj-e'), { recursive: true });
    writeFileSync(join(root, 'projects', 'proj-e', `${sid}.jsonl`), [
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: '随便一句' }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const now = Date.now();
    mkdirSync(join(root, 'jobs', 'j1'), { recursive: true });
    writeFileSync(join(root, 'jobs', 'j1', 'state.json'), JSON.stringify({
      state: 'failed', sessionId: sid, updatedAt: new Date(now - 10_000).toISOString(), cwd: 'D:\\Projects\\proj-e',
    }));

    let n = 0;
    const r = await runTick({
      dir: join(root, 'state'), claudeDir: root, nowMs: now, forceFull: true,
      notifier: async () => { n++; },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      scan: async () => ({ sessions: [], elapsedMs: 1, exitCode: 0 }),
    });
    assert.equal(n, 0, '刚停 10 秒的 UNCLASSIFIABLE 不得通知');
    assert.equal(r.suppressed[0].why, 'unclassifiable-too-recent');
    const row = JSON.parse(readFileSync(join(root, 'state', 'observations.jsonl'), 'utf8').trim());
    assert.ok(row.idleSec >= 10 && row.idleSec < 20, `jobs 候选的 idleSec 必须来自 updatedAt，实际 ${row.idleSec}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--stats：UNCLASSIFIABLE 按 idle 分桶，并标出每个桶的通知情况', () => {
  const dir = tmp();
  try {
    const log = createObservationLog(dir);
    log.append([
      { ts: '2026-10-31T01:00:00Z', sessionId: 'a', state: 'STALLED', kind: 'UNCLASSIFIABLE', idleSec: 10, notified: false, why: 'unclassifiable-too-recent' },
      { ts: '2026-10-31T01:10:00Z', sessionId: 'b', state: 'STALLED', kind: 'UNCLASSIFIABLE', idleSec: 120, notified: false, why: 'unclassifiable-too-recent' },
      { ts: '2026-10-31T01:20:00Z', sessionId: 'c', state: 'FAILED', kind: 'UNCLASSIFIABLE', idleSec: 600, notified: true, why: null },
      { ts: '2026-10-31T01:30:00Z', sessionId: 'd', state: 'STALLED', kind: 'EXTERNAL_BLOCKED', idleSec: 5, notified: true, why: null },
    ]);
    const st = observationStats(dir);
    assert.equal(st.unclassifiableIdle.total, 3);
    assert.equal(st.unclassifiableIdle.withoutIdleSec, 0);
    const b = Object.fromEntries(st.unclassifiableIdle.buckets.map((x) => [x.label, x]));
    assert.equal(b['<60s'].n, 1);
    assert.equal(b['60-300s'].n, 1);
    assert.equal(b['300-900s'].n, 1);
    assert.equal(b['>900s'].n, 0);

    const text = formatStats(st, { minIdleSec: 300 });
    assert.match(text, /UNCLASSIFIABLE 按 idle 分布（门槛 300s，共 3 条）/);
    assert.match(text, /<60s\s+1\s+33\.3%\s+（全部抑制）/);
    assert.match(text, /300-900s\s+1\s+33\.3%\s+（全部通知）/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('分类：COMPLETION_REPORT 被抑制', async () => {
  const root = tmp();
  try {
    const sid = 'sess-done';
    mkdirSync(join(root, 'projects', 'proj-c'), { recursive: true });
    const now = Date.now();
    writeFileSync(join(root, 'projects', 'proj-c', `${sid}.jsonl`), [
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: '已完成，工作区干净' }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    mkdirSync(join(root, 'jobs', 'j1'), { recursive: true });
    writeFileSync(join(root, 'jobs', 'j1', 'state.json'), JSON.stringify({
      state: 'failed', sessionId: sid, updatedAt: new Date(now).toISOString(), cwd: 'D:\\Projects\\proj-c',
    }));

    let n = 0;
    const r = await runTick({
      dir: join(root, 'state'), claudeDir: root, nowMs: now, forceFull: true,
      notifier: async () => { n++; },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      scan: async () => ({ sessions: [], elapsedMs: 1, exitCode: 0 }),
    });
    assert.equal(n, 0, '完成汇报不催');
    assert.equal(r.suppressed[0].kind, 'COMPLETION_REPORT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('分类失败：找不到 transcript 时退回按 state 通知，且标 classify=error 不静默', async () => {
  const root = tmp();
  try {
    const now = Date.now();
    mkdirSync(join(root, 'projects'), { recursive: true });
    mkdirSync(join(root, 'jobs', 'j1'), { recursive: true });
    writeFileSync(join(root, 'jobs', 'j1', 'state.json'), JSON.stringify({
      state: 'failed', sessionId: 'no-transcript', updatedAt: new Date(now).toISOString(), cwd: 'D:\\Projects\\nope',
    }));

    const logs = [];
    let n = 0;
    const r = await runTick({
      dir: join(root, 'state'), claudeDir: root, nowMs: now, forceFull: true,
      notifier: async () => { n++; },
      logger: { info: () => {}, warn: (m) => logs.push(m), error: (m) => logs.push(m) },
      scan: async () => ({ sessions: [], elapsedMs: 1, exitCode: 0 }),
    });
    assert.equal(n, 1, '分类失败必须保持接入前的行为：仍按 state 通知');
    const o = JSON.parse(readFileSync(join(root, 'state', 'observations.jsonl'), 'utf8').trim());
    assert.equal(o.classify, 'error');
    assert.equal(o.notified, true);
    void r; void logs;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('分类：mtime 未变时复用缓存，不再读文件', async () => {
  const root = tmp();
  try {
    const sid = 'sess-cache';
    const p = join(root, 'proj-d');
    mkdirSync(p, { recursive: true });
    writeWaitingSubagent(join(p, `${sid}.jsonl`));
    const cache = new Map();
    const a = classifyCandidate({ sessionId: sid, state: 'STALLED', project: 'proj-d' },
      { projectsRoot: root, nowMs: Date.now(), cache });
    assert.equal(a.kind, 'WAITING_SUBAGENT');
    assert.equal(cache.size, 1, '判定结果必须入缓存');

    // 第二次命中的是同一个对象（引用相同 = 走了缓存分支，没有重新构造 verdict）
    const cachedVerdict = cache.get(join(p, `${sid}.jsonl`)).verdict;
    const b = classifyCandidate({ sessionId: sid, state: 'STALLED', project: 'proj-d' },
      { projectsRoot: root, nowMs: Date.now(), cache });
    assert.equal(cache.get(join(p, `${sid}.jsonl`)).verdict, cachedVerdict);
    assert.equal(b.kind, a.kind);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('观察日志：追加写、不覆盖，同一停止事件进程内只写一行', () => {
  const dir = tmp();
  try {
    const log = createObservationLog(dir);
    log.append({ sessionId: 's', state: 'STALLED', kind: 'WAITING_SUBAGENT', why: 'waiting-subagent-suppressed', fingerprint: '1' });
    log.append({ sessionId: 's', state: 'STALLED', kind: 'WAITING_SUBAGENT', why: 'waiting-subagent-suppressed', fingerprint: '1' });
    log.append({ sessionId: 's', state: 'STALLED', kind: 'ASKED_UNANSWERED', why: 'notifyable', fingerprint: '2' });
    const lines = readFileSync(join(dir, 'observations.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, '重复事件不得刷行；新事件必须写');
    assert.equal(JSON.parse(lines[0]).kind, 'WAITING_SUBAGENT');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('观察日志：超过 5MB 轮转到 .1，旧内容不丢', () => {
  const dir = tmp();
  try {
    const log = createObservationLog(dir, { maxBytes: 500 });
    for (let i = 0; i < 40; i++) {
      log.append({ sessionId: `s${i}`, state: 'STALLED', kind: 'UNCLASSIFIABLE', why: 'notifyable', pad: 'x'.repeat(40) });
    }
    assert.ok(existsSync(join(dir, 'observations.jsonl.1')), '必须轮转');
    assert.ok(statSync(join(dir, 'observations.jsonl')).size <= 500);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--stats：分类分布、通知/抑制、按 state 交叉', () => {
  const dir = tmp();
  try {
    const log = createObservationLog(dir);
    log.append([
      { ts: '2026-10-31T01:00:00Z', sessionId: 'a', state: 'STALLED', kind: 'WAITING_SUBAGENT', notified: false },
      { ts: '2026-10-31T02:00:00Z', sessionId: 'b', state: 'STALLED', kind: 'WAITING_SUBAGENT', notified: false, x: 1 },
      { ts: '2026-10-31T03:00:00Z', sessionId: 'c', state: 'BLOCKED', kind: 'EXTERNAL_BLOCKED', notified: true, x: 2 },
      { ts: '2026-10-31T04:00:00Z', sessionId: 'd', state: 'FAILED', kind: 'UNCLASSIFIABLE', notified: true, x: 3 },
    ]);
    const st = observationStats(dir);
    assert.equal(st.total, 4);
    assert.equal(st.notified, 2);
    assert.equal(st.suppressed, 2);
    assert.equal(st.firstTs, '2026-10-31T01:00:00Z');
    assert.equal(st.kinds[0].kind, 'WAITING_SUBAGENT');
    assert.equal(st.kinds[0].n, 2);
    assert.equal(st.kinds[0].pct, 50);

    const text = formatStats(st);
    assert.match(text, /观察样本：4 条（2026-10-31 ~ 2026-10-31）/);
    assert.match(text, /WAITING_SUBAGENT\s+2\s+50\.0%/);
    assert.match(text, /通知：发了 2 条，抑制 2 条/);
    assert.match(text, /STALLED → WAITING_SUBAGENT 2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readTranscriptTail：大文件只读尾部，且丢掉被截断的首行', () => {
  const dir = tmp();
  try {
    const p = join(dir, 'big.jsonl');
    const recs = [];
    for (let i = 0; i < 2000; i++) recs.push({ i, pad: 'y'.repeat(60) });
    writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const { records, truncated } = readTranscriptTail(p, 4096);
    assert.equal(truncated, true);
    assert.ok(records.length > 0);
    assert.equal(records[records.length - 1].i, 1999, '必须读到真正的末行');
    assert.ok(records.every((r) => typeof r.i === 'number'), '首行被截断时必须丢弃');
    assert.deepEqual(readTranscriptTail(join(dir, 'missing.jsonl')).records, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
