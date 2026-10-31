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
  mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, utimesSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  dedupeKey, reasonClass, canNotify, recordSent, emptyState, loadState, saveState,
  probeJobs, probeMtime, diffProbe, foldProbe, candidatesFromScan,
  createLogger, dispatchCandidates, runTick, defaultStateDir, __internals,
  pruneNotified, NOTIFIED_TTL_HOURS, notifyTitle, NOTIFY_STATES,
  findStopPoint, readTranscriptTail, classifyCandidate, createObservationLog,
  observationStats, formatStats, readObservationRows, NOTIFY_KINDS, unclassifiableMinIdleSec, tooRecentToNotify,
  traceability, readJobStates, probeWaiting, readLiveSessionStates, witnessPath, writeWitness, readWitness, checkStateIntegrity, HOST_FACT_STATES,
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

test('AC7 日志：单文件上限 1MB，超出时归档而不是覆盖', () => {
  const dir = tmp();
  try {
    const logger = createLogger(dir, { maxBytes: 2000 });
    const line = 'x'.repeat(100);
    for (let i = 0; i < 100; i++) { logger.info(line); }

    const f = join(dir, 'watch.log');
    assert.ok(existsSync(f), 'watch.log 必须存在');
    assert.ok(statSync(f).size <= 2000, `当前日志不得超过上限，实际 ${statSync(f).size}`);

    // 旧实现只留一个 watch.log.1，两天就会把更早的日志永久删掉。
    // 现在每次轮转另存带时间戳的归档，**永不覆盖**。
    const archives = readdirSync(dir).filter((n) => /^watch..+.log$/.test(n));
    assert.ok(archives.length >= 1, `必须有归档，实际目录：${readdirSync(dir).join(',')}`);
    const total = archives.reduce((a, n) => a + statSync(join(dir, n)).size, 0);
    assert.ok(total > 0, '归档必须有内容');
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

test('AC3 层调度：L-full 只在 --full 时跑，常驻路径不再全量扫描', async () => {
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
    assert.equal(fullRuns, 0, '常驻首轮不再跑全量——L-fast 的探针已经覆盖全部候选来源');

    // 30 秒后：三层都没到期
    now += 30_000;
    await runTick({ dir, claudeDir: claude, logger, notifier, scan, nowMs: now });
    assert.equal(fullRuns, 0);

    // 2 分钟后：只有 L-fast 到期。它跑两个探针——jobs（过去失败过）
    // 与 sessions（此刻在等你）。两者都便宜（纯读小 JSON）。
    now += 2 * MIN;
    const s2 = await runTick({ dir, claudeDir: claude, logger, notifier, scan, nowMs: now });
    assert.deepEqual(s2.ran, ['jobs', 'waiting'], '2 分钟后应只跑 L-fast 的两个探针');
    assert.equal(fullRuns, 0);

    // 再 4 分钟（累计 6 分钟）：L-mid 到期，但没变化 → 不起增量扫描
    now += 4 * MIN;
    const s3 = await runTick({ dir, claudeDir: claude, logger, notifier, scan, nowMs: now });
    assert.ok(s3.ran.includes('probe'));
    assert.equal(incRuns, 0, '没有变化不得起增量扫描');

    // 31 分钟后：**仍然不跑全量**。这是本次改动的核心断言。
    // 旧行为是每 30 分钟烧 19–28 秒，产出恒为 0 个候选（实测三次 full=28159/21543/19106ms）。
    now += 31 * MIN;
    await runTick({ dir, claudeDir: claude, logger, notifier, scan, nowMs: now });
    assert.equal(fullRuns, 0, '常驻路径永不自动全量');

    // 但 --full 仍然可用：它是排查工具
    now += MIN;
    const s4 = await runTick({ dir, claudeDir: claude, logger, notifier, scan, nowMs: now, forceFull: true });
    assert.equal(fullRuns, 1, '--full 必须仍然执行全量');
    assert.ok(s4.ran.includes('full'));
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

test('只把活跃窗口内的 FAILED/BLOCKED 转成候选（STALLED 已移除）', () => {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const sessions = [
    { sessionId: 'a', state: 'FAILED', reason: 'r', lastActivity: iso(60_000) },
    { sessionId: 'b', state: 'STALLED', reason: 'r', lastActivity: iso(60_000) },
    { sessionId: 'c', state: 'PRODUCING', reason: 'r', lastActivity: iso(60_000) },
    { sessionId: 'd', state: 'EXPLORING', reason: 'r', lastActivity: iso(60_000) },
    { sessionId: 'e', state: 'BLOCKED', reason: 'r', lastActivity: iso(48 * 3600_000) },
    { sessionId: 'f', state: 'BLOCKED', reason: 'r', lastActivity: iso(60_000) },
  ];
  const c = candidatesFromScan(sessions, { nowMs: now });
  // STALLED（b）已从 NOTIFY_STATES 移除：它从未在真实语料里触发过。
  // 陈旧的 BLOCKED（e）超出 24h 活跃窗口。
  assert.deepEqual(c.map((x) => x.sessionId).sort(), ['a', 'f'], '只有活跃的 FAILED/BLOCKED 该通知');
});

test('STALLED 不再是可通知状态', () => {
  assert.ok(!NOTIFY_STATES.includes('STALLED'), 'STALLED 从未在真实语料触发，不该保留在通知状态里');
  assert.ok(NOTIFY_STATES.includes('FAILED'));
  assert.ok(NOTIFY_STATES.includes('BLOCKED'));
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
    // 走 dispatchCandidates 而不是 runTick：jobs 的 failed 现在是宿主事实，
    // 按设计跳过分类门，端到端已经测不到「WAITING_SUBAGENT 被抑制」这条路径。
    // 分类器本身仍在运行（供观察日志与 P1 使用），所以要单独钉住它的行为。
    const r = await dispatchCandidates([{
      sessionId: sid, state: 'EXPLORING', reason: 'read-only', project: 'proj-a',
      idleSec: 0, lastActivity: new Date(now).toISOString(), evidenceFingerprint: '1',
    }], {
      state: emptyState(), nowMs: now, notifier: async () => { n++; },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      classify: (c) => classifyCandidate(c, { projectsRoot: join(root, 'projects'), nowMs: now, logger: { info: () => {}, warn: () => {}, error: () => {} } }),
      observations: createObservationLog(join(root, 'state')),
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
    assert.equal(o.state, 'EXPLORING');
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

test('时间门：非宿主事实的 UNCLASSIFIABLE 刚停下仍被抑制（端到端）', async () => {
  const root = tmp();
  try {
    const sid = 'sess-recent';
    mkdirSync(join(root, 'projects', 'proj-e'), { recursive: true });
    writeFileSync(join(root, 'projects', 'proj-e', `${sid}.jsonl`), [
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: '随便一句' }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const now = Date.now();

    // 直接测 dispatchCandidates：runTick 的候选现在只来自宿主事实状态，
    // 它们按设计跳过时间门，端到端已经测不到这条路径了。
    // 时间门仍然被 watch 用于任何**将来重新引入的推断状态**，所以要单独钉住。
    const r = await dispatchCandidates([{
      sessionId: sid, state: 'EXPLORING', reason: 'read-only', project: 'proj-e',
      idleSec: 10, lastActivity: new Date(now - 10_000).toISOString(), evidenceFingerprint: '1',
    }], {
      state: emptyState(), nowMs: now, notifier: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      classify: (c) => classifyCandidate(c, { projectsRoot: join(root, 'projects'), nowMs: now, logger: { info: () => {}, warn: () => {}, error: () => {} } }),
    });
    assert.equal(r.sent.length, 0, '刚停 10 秒的 UNCLASSIFIABLE 不得通知');
    assert.equal(r.suppressed[0].why, 'unclassifiable-too-recent');
    assert.equal(r.suppressed[0].idleSec, 10, 'idleSec 必须透传进抑制记录');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('宿主事实（WAITING/FAILED/BLOCKED）跳过分类门与时间门——它们是确定信号', async () => {
  const now = Date.now();
  // 分类器说什么都不该影响这三个状态。
  const hostile = () => ({
    ts: new Date(now).toISOString(), sessionId: 's', state: 'WAITING', idleSec: 0,
    kind: 'WAITING_SUBAGENT', autoAnswerable: false, reason: 'x', confidence: null,
    notified: false, classify: 'ok',
  });
  for (const st of HOST_FACT_STATES) {
    const r = await dispatchCandidates([{
      sessionId: `s-${st}`, state: st, reason: 'host', project: 'p',
      idleSec: 0, lastActivity: new Date(now).toISOString(), evidenceFingerprint: '1',
    }], {
      state: emptyState(), nowMs: now, notifier: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      classify: hostile,
    });
    assert.equal(r.sent.length, 1,
      `${st} 不该被 kind 门抑制——它是宿主写的，不是推断出来的`);
    assert.equal(r.suppressed.length, 0, `${st} 也不该被时间门抑制`);
  }
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

    // 直接测 dispatchCandidates 而不是 runTick。
    // 走 runTick 已经测不到分类门了：候选只能来自宿主事实状态
    // （WAITING / FAILED / BLOCKED），而这几个按设计**跳过**分类门。
    // 分类器本身仍然被 watch 调用（用于观察日志与 P1 数据），
    // 所以这条测试改为直接对一个非宿主事实候选断言分类行为。
    const r = await dispatchCandidates([{
      sessionId: sid, state: 'FAILED', reason: 'host-reported-failed', project: 'proj-c',
      idleSec: 0, lastActivity: new Date(now).toISOString(), evidenceFingerprint: '1',
      // 显式覆盖 state，让这条候选走分类门：HOST_FACT_STATES 之外的状态
    }].map((c) => ({ ...c, state: 'EXPLORING', reason: 'read-only' })), {
      state: emptyState(), nowMs: now, notifier: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      classify: (c) => classifyCandidate(c, { projectsRoot: join(root, 'projects'), nowMs: now, logger: { info: () => {}, warn: () => {}, error: () => {} } }),
    });
    assert.equal(r.sent.length, 0, '完成汇报不催');
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

test('观察日志：超限时归档而不是覆盖，一行都不丢', () => {
  const dir = tmp();
  try {
    const log = createObservationLog(dir, { maxBytes: 500 });
    const N = 40;
    for (let i = 0; i < N; i++) {
      log.append({ sessionId: `s${i}`, state: 'STALLED', kind: 'UNCLASSIFIABLE', why: 'notifyable', pad: 'x'.repeat(40) });
    }
    // 旧实现「轮转到 .1，只留一份」会永久丢掉更早的数据。这条测试真正要保证的是
    // **一条都不丢**——旧版本的名字这么写，但只检查了 .1 存在，从没验证过内容完整。
    const archived = readdirSync(dir).filter((n) => /^observations..+.jsonl$/.test(n));
    assert.ok(archived.length >= 1, '必须产生归档');
    const all = readObservationRows(dir);
    assert.equal(all.length, N, `40 条写入后必须能全部读回，实际 ${all.length}`);
    const ids = new Set(all.map((r) => r.sessionId));
    for (let i = 0; i < N; i++) assert.ok(ids.has(`s${i}`), `丢了 s${i}`);
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

// ── 已通知条目的 TTL（防止 state.json 无限膨胀）──────────────────────
//
// 实测：跑一晚攒下 10 条已通知条目，其中一半指向已被清理的 transcript。
// 那些条目再也不会被匹配到，只会让状态文件一路变大。

test('pruneNotified 删除超过 24h 的条目', () => {
  const now = Date.now();
  const notified = {
    fresh: { firstSeenAt: new Date(now - 2 * 3600_000).toISOString() },
    stale: { firstSeenAt: new Date(now - 30 * 3600_000).toISOString() },
  };
  const r = pruneNotified(notified, now);
  assert.equal(r.removed, 1);
  assert.ok(notified.fresh, '24h 内的必须保留');
  assert.equal(notified.stale, undefined, '超期的必须删除');
});

test('pruneNotified 删除时间不可解析的坏条目', () => {
  const now = Date.now();
  const notified = {
    broken: { firstSeenAt: 'not-a-date' },
    missing: {},
    noTime: null,
  };
  const r = pruneNotified(notified, now);
  assert.equal(r.removed, 3, '坏条目一律清掉，不该永久占位');
});

test('pruneNotified 对空输入不抛', () => {
  assert.equal(pruneNotified({}, Date.now()).removed, 0);
  assert.equal(pruneNotified(null, Date.now()).removed, 0);
  assert.equal(pruneNotified(undefined, Date.now()).removed, 0);
});

test('loadState 读入时会清理过期条目', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      version: 1,
      notified: {
        old: { firstSeenAt: new Date(now - 48 * 3600_000).toISOString(), sessionId: 'x', state: 'FAILED' },
        recent: { firstSeenAt: new Date(now - 3600_000).toISOString(), sessionId: 'y', state: 'FAILED' },
      },
      budget: { day: null, sent: 0, sentLog: [], perSession: {} },
    }));
    const { state } = loadState(dir);
    assert.equal(Object.keys(state.notified).length, 1, '只应留下未过期的');
    assert.ok(state.notified.recent, '保留的必须是 recent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 通知标题必须让不确定性可见 ────────────────────────────────────────
//
// 回放实测 66 条通知里 64 条是 UNCLASSIFIABLE（97%）。
// 原标题是 `${state} · 项目名`，用户会以为是确认卡住了。
// Windows toast 默认只显示标题，所以分类结果必须在标题里。

test('notifyTitle：UNCLASSIFIABLE 必须明确标注「判不出类型」', () => {
  const t = notifyTitle({ state: 'STALLED', project: 'foo', kind: 'UNCLASSIFIABLE' });
  assert.ok(t.includes('判不出类型'), `标题未体现不确定性: ${t}`);
  assert.ok(!t.startsWith('STALLED'), '不能以确定的 state 开头');
});

test('notifyTitle：确定信号用各自的措辞', () => {
  // 宿主事实优先：BLOCKED 现在直接说「受阻」，不再被 kind 覆盖。
  assert.ok(notifyTitle({ state: 'BLOCKED', project: 'a', kind: 'EXTERNAL_BLOCKED' }).includes('受阻'));
  // 分类措辞仍然作用于非宿主事实的候选（将来若重新引入推断状态，这条路还在）
  assert.ok(notifyTitle({ state: 'EXPLORING', project: 'b', kind: 'WAITING_APPROVAL' }).includes('等你批准'));
  assert.ok(notifyTitle({ state: 'EXPLORING', project: 'c', kind: 'ASKED_UNANSWERED' }).includes('问了没答'));
  assert.ok(notifyTitle({ state: 'EXPLORING', project: 'd', kind: 'PLAN_SUBMITTED' }).includes('计划待批'));
});

test('notifyTitle：没有分类结果时标注「未分类」', () => {
  // FAILED 现在是宿主事实，有自己的措辞；未分类的兜底用在非宿主事实上。
  const t = notifyTitle({ state: 'EXPLORING', project: 'x', kind: null });
  assert.ok(t.includes('未分类'), `未标注未分类: ${t}`);
  assert.ok(t.includes('EXPLORING'));
});

test('notifyTitle：没有 project 时用 sessionId 前 8 位', () => {
  const t = notifyTitle({ state: 'STALLED', project: null, sessionId: 'abcdef1234567890', kind: 'UNCLASSIFIABLE' });
  assert.ok(t.includes('abcdef12'));
  assert.ok(!t.includes('null'));
});

// ── 多实例与 state.json 争用（2026-10-31 实测故障）──────────────���────

test('dry-run 不写 state.json——否则会和真身抢锁', async () => {
  const dir = tmp();
  const claude = tmp();
  try {
    const now = Date.now();
    mkdirSync(join(claude, 'jobs', 'j1'), { recursive: true });
    writeFileSync(join(claude, 'jobs', 'j1', 'state.json'), JSON.stringify({
      state: 'failed', sessionId: 's1', updatedAt: new Date(now).toISOString(), cwd: 'D:\P\demo',
    }));
    mkdirSync(join(claude, 'projects'), { recursive: true });
    await runTick({
      dir, claudeDir: claude, nowMs: now, dryRun: true,
      notifier: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      scan: async () => ({ sessions: [], elapsedMs: 1, exitCode: 0 }),
    });
    assert.equal(existsSync(join(dir, 'state.json')), false,
      'dry-run 落盘会与真身争 rename，Windows 上抛 EPERM');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
  }
});

test('saveState 能覆盖已存在文件，且失败时不留下 tmp 残片', () => {
  const dir = tmp();
  try {
    saveState(dir, emptyState());
    const second = emptyState();
    second.lastProbeAt = '2026-10-31T00:00:00.000Z';
    saveState(dir, second);
    assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).lastProbeAt,
      '2026-10-31T00:00:00.000Z');
    const { readdirSync } = process.getBuiltinModule('node:fs');
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, [], `不该留下 tmp 文件：${leftovers}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 通知可追溯率（第一个生产指标）────────────────────────────────────

test('traceability：通知能追到宿主 failed/blocked 时算可追溯', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'watch.log'),
      '2026-10-31T01:00:00Z [INFO] notified FAILED demo kind=- key=abc session=s1\n');
    const r = traceability(dir, [{ sessionId: 's1', state: 'failed' }]);
    assert.equal(r.total, 1);
    assert.equal(r.traced, 1);
    assert.equal(r.ratio, 1);
    assert.deepEqual(r.failures, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('traceability：宿主没有该会话的记录 → 不可追溯（旧的 hb_gap 推断就是这样）', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'watch.log'),
      '2026-10-31T01:00:00Z [INFO] notified FAILED demo kind=- key=abc session=ghost\n');
    const r = traceability(dir, [{ sessionId: 's1', state: 'failed' }]);
    assert.equal(r.ratio, 0);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].hostState, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('traceability：宿主记录为 done/stopped 不算可追溯——必须是 failed 或 blocked', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'watch.log'),
      '2026-10-31T01:00:00Z [INFO] notified FAILED demo kind=- key=abc session=s1\n');
    for (const st of ['done', 'stopped']) {
      const r = traceability(dir, [{ sessionId: 's1', state: st }]);
      assert.equal(r.ratio, 0, `state=${st} 不该被视为可追溯`);
      assert.equal(r.failures[0].hostState, st);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('traceability：没有通知时返回 ratio=null，不能算通过', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'watch.log'), '2026-10-31T01:00:00Z [INFO] tick candidates=0 sent=0\n');
    const r = traceability(dir, []);
    assert.equal(r.total, 0);
    assert.equal(r.ratio, null, '空样本必须是 null，不是 1.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readJobStates 读得出 needs/suggestedReply，坏文件不抛', () => {
  const claude = tmp();
  try {
    mkdirSync(join(claude, 'jobs', 'a'), { recursive: true });
    writeFileSync(join(claude, 'jobs', 'a', 'state.json'),
      JSON.stringify({ sessionId: 's1', state: 'blocked', needs: '选哪个？', suggestedReply: 'A' }));
    mkdirSync(join(claude, 'jobs', 'b'), { recursive: true });
    writeFileSync(join(claude, 'jobs', 'b', 'state.json'), '{not json');
    const out = readJobStates(claude);
    assert.equal(out.length, 1);
    assert.equal(out[0].state, 'blocked');
    assert.equal(out[0].needs, '选哪个？');
    assert.equal(out[0].suggestedReply, 'A');
  } finally {
    rmSync(claude, { recursive: true, force: true });
  }
});

// ── probeWaiting：宿主实时 waiting 信号 ──────────────────────────────

const mkSession = (dir, pid, obj) => writeFileSync(join(dir, `${pid}.json`), JSON.stringify(obj));

test('probeWaiting：waiting 会话被抓成候选，带 waitingFor', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    mkSession(dir, 1, {
      pid: 1, sessionId: 's-wait', status: 'waiting', waitingFor: 'input needed',
      statusUpdatedAt: now - 5000, cwd: 'D:\\P\\demo', name: 'demo',
    });
    const r = probeWaiting(dir, { nowMs: now });
    assert.equal(r.found.length, 1);
    assert.equal(r.found[0].state, 'WAITING');
    assert.equal(r.found[0].reason, 'waiting:input needed');
    assert.equal(r.found[0].project, 'demo');
    assert.equal(r.found[0].source, 'sessions');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probeWaiting：busy / idle 不产生候选', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    for (const [i, st] of ['busy', 'idle'].entries()) {
      mkSession(dir, i + 1, { pid: i + 1, sessionId: `s${i}`, status: st, statusUpdatedAt: now });
    }
    assert.equal(probeWaiting(dir, { nowMs: now }).found.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probeWaiting：waiting 太久（超出活跃窗口）不算——20 天前的等待不是新闻', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    mkSession(dir, 1, {
      pid: 1, sessionId: 'old', status: 'waiting', waitingFor: 'input needed',
      statusUpdatedAt: now - 20 * 86400_000,
    });
    assert.equal(probeWaiting(dir, { nowMs: now }).found.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probeWaiting：缺 waitingFor 仍算候选，reason 用兜底值', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    mkSession(dir, 1, { pid: 1, sessionId: 's', status: 'waiting', statusUpdatedAt: now });
    const r = probeWaiting(dir, { nowMs: now });
    assert.equal(r.found[0].reason, 'host-reported-waiting');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probeWaiting：坏 JSON 与无 sessionId 的文件被跳过，不抛', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    writeFileSync(join(dir, 'bad.json'), '{oops');
    mkSession(dir, 2, { pid: 2, status: 'waiting', statusUpdatedAt: now }); // 无 sessionId
    const r = probeWaiting(dir, { nowMs: now });
    assert.equal(r.found.length, 0);
    assert.ok(r.skipped >= 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probeWaiting：WAITING 在 NOTIFY_STATES 里——它是唯一会高频触发的状态', () => {
  assert.ok(NOTIFY_STATES.includes('WAITING'));
});

// ── 状态完整性：目录消失必须能被发现（DF-020）──────────────────────

test('witnessPath 是状态目录的兄弟，不是公共父目录', () => {
  const a = witnessPath('/tmp/x/Overwatch');
  const b = witnessPath('/tmp/y/Overwatch');
  assert.notEqual(a, b, '不同状态目录不得共用一个见证文件');
  assert.ok(a.startsWith('/tmp/x/Overwatch'), `见证应在目录旁边：${a}`);
});

test('checkStateIntegrity：首次运行不算丢失', () => {
  const dir = tmp();
  try {
    const r = checkStateIntegrity(dir);
    assert.equal(r.lost, false);
    assert.equal(r.firstRun, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('checkStateIntegrity：见证在、state.json 没了 → 判定丢失', () => {
  const dir = tmp();
  try {
    mkdirSync(dir, { recursive: true });
    saveState(dir, emptyState());
    writeWitness(dir, { nowMs: Date.now() });
    // 模拟目录被清空
    rmSync(join(dir, 'state.json'));
    const r = checkStateIntegrity(dir);
    assert.equal(r.lost, true, '见证记录过保存，但 state.json 不见了');
    assert.ok(r.previousSaves >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(witnessPath(dir), { force: true });
  }
});

test('checkStateIntegrity：目录整个被删也能判定丢失（见证在目录外）', () => {
  const dir = tmp();
  try {
    mkdirSync(dir, { recursive: true });
    saveState(dir, emptyState());
    writeWitness(dir, { nowMs: Date.now() });
    rmSync(dir, { recursive: true, force: true });   // 整个目录消失，正是 10-31 的情形
    const r = checkStateIntegrity(dir);
    assert.equal(r.lost, true, '目录整个没了，见证文件仍在，必须报丢失');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(witnessPath(dir), { force: true });
  }
});

test('丢失时 runTick 发一条告警，且不阻止继续运行', async () => {
  const dir = tmp();
  const claude = tmp();
  try {
    const now = Date.now();
    mkdirSync(join(claude, 'projects'), { recursive: true });
    mkdirSync(dir, { recursive: true });
    saveState(dir, emptyState());
    writeWitness(dir, { nowMs: now });
    rmSync(join(dir, 'state.json'));

    const calls = [];
    const r = await runTick({
      dir, claudeDir: claude, nowMs: now,
      notifier: async (n) => { calls.push(n); },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      scan: async () => ({ sessions: [], elapsedMs: 1, exitCode: 0 }),
    });
    assert.equal(calls.length, 1, '应当发一条状态丢失告警');
    assert.ok(/丢失/.test(calls[0].title), `告警标题应说明丢失：${calls[0].title}`);
    assert.ok(r, '告警后仍要正常运行，不能退出');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
    rmSync(witnessPath(dir), { force: true });
  }
});

test('dry-run 下丢失只记日志、不发通知（试跑契约同样适用）', async () => {
  const dir = tmp();
  const claude = tmp();
  try {
    const now = Date.now();
    mkdirSync(join(claude, 'projects'), { recursive: true });
    mkdirSync(dir, { recursive: true });
    saveState(dir, emptyState());
    writeWitness(dir, { nowMs: now });
    rmSync(join(dir, 'state.json'));

    let n = 0;
    const errors = [];
    await runTick({
      dir, claudeDir: claude, nowMs: now, dryRun: true,
      notifier: async () => { n++; },
      logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
      scan: async () => ({ sessions: [], elapsedMs: 1, exitCode: 0 }),
    });
    assert.equal(n, 0, 'dry-run 不得发通知');
    assert.ok(errors.some((e) => /state-lost/.test(e)), '但必须在日志里留下 state-lost');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
    rmSync(witnessPath(dir), { force: true });
  }
});

test('runTick 每次成功保存都推进见证时间——否则丢失告警会报错误的时间', async () => {
  const dir = tmp();
  const claude = tmp();
  try {
    const t1 = Date.now() - 60_000;
    mkdirSync(join(claude, 'projects'), { recursive: true });
    await runTick({
      dir, claudeDir: claude, nowMs: t1,
      notifier: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      scan: async () => ({ sessions: [], elapsedMs: 1, exitCode: 0 }),
    });
    const w1 = readWitness(dir);
    assert.ok(w1, 'runTick 必须建立见证文件');
    assert.equal(w1.lastSavedAt, new Date(t1).toISOString());

    const t2 = t1 + 30_000;
    await runTick({
      dir, claudeDir: claude, nowMs: t2, forceFull: true,
      notifier: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      scan: async () => ({ sessions: [], elapsedMs: 1, exitCode: 0 }),
    });
    const w2 = readWitness(dir);
    assert.equal(w2.lastSavedAt, new Date(t2).toISOString(), '每次保存都要推进');
    assert.ok(w2.saves > w1.saves, `saves 应递增：${w1.saves} → ${w2.saves}`);
    assert.equal(w2.firstSeenAt, w1.firstSeenAt, 'firstSeenAt 不得被覆盖');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
    rmSync(witnessPath(dir), { force: true });
  }
});

// ── 标题必须是「正在等你」，不能被分类器降级成「判不出类型」────────

test('notifyTitle：WAITING 说「正在等你」，即使分类器给了 UNCLASSIFIABLE', () => {
  // 端到端跑真实 WAITING 候选时暴露的：分类器对 sessions/ 候选返回 UNCLASSIFIABLE，
  // 旧版先看 kind，于是把确定的等待印成了「疑似停滞（判不出类型）」。
  const t = notifyTitle({
    state: 'WAITING', reason: 'waiting:input needed', project: 'demo',
    sessionId: 'abcdef123456', kind: 'UNCLASSIFIABLE',
  });
  assert.ok(t.includes('正在等你'), `标题应说正在等你：${t}`);
  assert.ok(t.includes('input needed'), `应带上在等什么：${t}`);
  assert.ok(!t.includes('判不出类型'), '确定的等待不得被说成猜测');
  assert.ok(!t.includes('未分类'));
});

test('notifyTitle：WAITING 没有 waitingFor 时也能出完整标题', () => {
  const t = notifyTitle({ state: 'WAITING', reason: 'host-reported-waiting', project: 'demo' });
  assert.ok(t.includes('正在等你'));
  assert.ok(!t.includes('undefined'));
  assert.ok(!t.includes('waiting:'));
});

test('notifyTitle：FAILED / BLOCKED 走宿主事实措辞', () => {
  assert.ok(notifyTitle({ state: 'FAILED', project: 'x', kind: 'UNCLASSIFIABLE' }).includes('宿主报失败'));
  assert.ok(notifyTitle({ state: 'BLOCKED', project: 'x' }).includes('受阻'));
});

test('traceability：WAITING 不计入可追溯率——它是瞬时状态，事后必然查不到', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'watch.log'),
      '2026-10-31T01:00:00Z [INFO] notified WAITING demo kind=- key=k1 session=w1\n');
    // 会话现在早已 busy（用户回过话了）——若把 WAITING 计入，就会误判为不可追溯
    const r = traceability(dir, [], [{ sessionId: 'w1', status: 'busy' }]);
    assert.equal(r.total, 1);
    assert.equal(r.unverifiable, 1);
    assert.equal(r.verifiable, 0);
    assert.equal(r.ratio, null, '没有可验证样本时必须是 null，不是 0 也不是 1');
    assert.deepEqual(r.failures, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('traceability：FAILED 仍必须能追到 jobs 的 failed/blocked', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'watch.log'),
      '2026-10-31T01:00:00Z [INFO] notified FAILED demo kind=- key=k1 session=f1\n');
    assert.equal(traceability(dir, [{ sessionId: 'f1', state: 'failed' }], []).ratio, 1);
    assert.equal(traceability(dir, [{ sessionId: 'f1', state: 'done' }], []).ratio, 0);
    assert.equal(traceability(dir, [], []).ratio, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readLiveSessionStates 返回全部状态，不只是 waiting', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'sessions'), { recursive: true });
    const now = Date.now();
    for (const [i, st] of ['busy', 'idle', 'waiting'].entries()) {
      writeFileSync(join(root, 'sessions', `${i}.json`),
        JSON.stringify({ sessionId: `s${i}`, status: st, statusUpdatedAt: now }));
    }
    const out = readLiveSessionStates(root);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((o) => o.status).sort(), ['busy', 'idle', 'waiting']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
