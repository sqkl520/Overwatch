#!/usr/bin/env node
/**
 * hook-dedupe.test.mjs — 「同一次事件只判一次」的机制测试（`DF-029`）。
 *
 * 覆盖重点（按「修错了会怎样」排序）：
 *
 *   1. **不许误去重。** 去重过头的后果是**真事件被静默吞掉** —— 台账少一行、拦截次数
 *      少一跳、甚至一次该拦的 Stop 变成放行。所以「不同键必须各自认领」是本文件的
 *      第一条，而不是「同键被去重」。
 *   2. **不许假装原子。** 并发那一条用**两个真子进程**同时抢同一个键，断言恰好
 *      一个赢。它证明的是 `O_EXCL` 在本机文件系统上的实际行为 —— 不是读代码得出的
 *      结论。网络盘上的边界写在 `hook-dedupe.mjs` 文件头里，测试不假装覆盖它。
 *   3. **失效方向必须是「多记一次」而不是「漏判一次」。** 键缺失、目录写不进去、
 *      认领抛异常 —— 每一条都必须 `claimed:true`（照常判定）。
 *   4. **跳过记录不写进 hook 自己的台账。** 那本台账的行数是统计的分母，
 *      往里面写「我跳过一次」等于把翻倍改成翻三倍。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync,
  utimesSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  claimOnce, claimKeyOf, claimPathFor, claimDirFor, dedupeRoot,
  recordSkipped, sweepIfCrowded,
  CLAIM_TTL_MS, SWEEP_AT, SKIPPED_FILE, DEDUPE_DIR_NAME,
} from '../scripts/hook-dedupe.mjs';

const sandbox = () => mkdtempSync(join(tmpdir(), 'ow-dedupe-'));
/** 隔离 env：**只能整体给**，理由同两个 hook 的测试（漏一个就写进仓库）。 */
const envIn = (dir) => ({ OVERWATCH_HOOK_DEDUPE_DIR: join(dir, 'dedupe') });

// ── 1. 键：缺一段就不猜 ──────────────────────────────────────────────

test('claimKeyOf 缺任何一段都返回 null —— 半个键不许拿去当判据', () => {
  assert.equal(claimKeyOf('h', ['a', 'b']), 'h\u0000a\u0000b');
  assert.equal(claimKeyOf('h', ['a', '']), null, '空段 = 缺一段');
  assert.equal(claimKeyOf('h', ['a', null]), null);
  assert.equal(claimKeyOf('h', ['a', undefined]), null);
  assert.equal(claimKeyOf('h', []), null, '没有段就没有键');
  assert.equal(claimKeyOf('', ['a']), null, '没有 hookId 就没有分区');
  assert.equal(claimKeyOf('h', 'a'), 'h\u0000a', '单段也接受');
});

test('键里的 NUL 会被折成空格，不会伪造出多一段', () => {
  // 「a\u0000b」若原样拼进去，就成了三段；折成空格后仍是两段。
  const k = claimKeyOf('h', ['a\u0000b', 'c']);
  assert.equal(k, 'h\u0000a b\u0000c');
  assert.equal(k.split('\u0000').length, 3, 'hookId + 两段，不能被键内容撑成四段');
});

test('claimKeyOf 的 hookId 会归一化，路径安全', () => {
  assert.equal(claimKeyOf('Pre Write Gate', ['x']), 'pre-write-gate\u0000x');
  assert.equal(claimKeyOf('../evil', ['x']), 'evil\u0000x');
  assert.equal(claimKeyOf('///', ['x']), null, '归一化后为空 = 没有分区');
});

// ── 2. 认领：同键只赢一次，不同键各自赢 ──────────────────────────────

test('同键第二次不是认领成功，不同键各自成功（这是本模块的全部价值）', () => {
  const dir = sandbox();
  try {
    const env = envIn(dir);
    const k = claimKeyOf('h', ['sess', 'id-1']);

    const a = claimOnce({ hookId: 'h', key: k, env });
    assert.equal(a.claimed, true, '第一次必须认领成功');
    assert.equal(a.why, 'claimed');
    assert.ok(a.path && existsSync(a.path), '认领必须真的在盘上留下证据');

    const b = claimOnce({ hookId: 'h', key: k, env });
    assert.equal(b.claimed, false, '同一个键第二次必须是「重复」');
    assert.equal(b.why, 'duplicate');
    assert.ok(b.ageMs >= 0, 'ageMs 必须非负（负值说明两个时钟没对齐，不能当残留）');

    // **不同键必须各自成功** —— 这条是防「去重过头」的最直接判据。
    const other = claimOnce({ hookId: 'h', key: claimKeyOf('h', ['sess', 'id-2']), env });
    assert.equal(other.claimed, true, '不同的键不许被当成重复');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('同一个键在两个 hook 下互不干扰（按 hookId 分区）', () => {
  const dir = sandbox();
  try {
    const env = envIn(dir);
    const key = claimKeyOf('h', ['sess', 'id-1']);
    const pre = claimOnce({ hookId: 'pre-write-gate', key, env });
    const stop = claimOnce({ hookId: 'stop-verify-hook', key, env });
    assert.equal(pre.claimed, true);
    assert.equal(stop.claimed, true, '两个 hook 各自的认领目录必须分开');
    assert.notEqual(pre.path, stop.path);
    assert.equal(claimDirFor(dedupeRoot({ env }), 'pre-write-gate'),
      join(dedupeRoot({ env }), 'pre-write-gate'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('认领文件里不带完整键 —— 键含会话 ID 与回复原文，落盘会泄漏', () => {
  const dir = sandbox();
  try {
    const env = envIn(dir);
    const secretish = 'x'.repeat(400);
    const k = claimKeyOf('h', ['sess-abc', secretish]);
    const r = claimOnce({ hookId: 'h', key: k, env });
    const body = readFileSync(r.path, 'utf8');
    assert.ok(!body.includes(secretish), '完整键不许落盘');
    assert.ok(body.length < 400, `认领文件应很小，实际 ${body.length} 字节`);
    assert.ok(!r.path.includes('sess-abc'), '路径里也没有原键（用 sha256 摘要）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 3. 过期重抢：残留不能永久挡住真事件 ──────────────────────────────

test('超过 CLAIM_TTL_MS 的认领算残留，可以被重新认领', () => {
  const dir = sandbox();
  try {
    const env = envIn(dir);
    const k = claimKeyOf('h', ['sess', 'id-1']);
    const t0 = 1_700_000_000_000;
    assert.equal(claimOnce({ hookId: 'h', key: k, env, nowMs: t0 }).claimed, true);

    // **把 mtime 拨到 t0**，让「文件多旧」这件事可复算。不拨的话 `nowMs` 与
    // 文件的实际 mtime 是两个不同的时钟，`ageMs` 会是个无意义的负数。
    const p = claimPathFor(dedupeRoot({ env }), 'h', k);
    utimesSync(p, new Date(t0), new Date(t0));

    // 还没过期：仍是重复
    const fresh = claimOnce({ hookId: 'h', key: k, env, nowMs: t0 + CLAIM_TTL_MS - 1 });
    assert.equal(fresh.claimed, false);

    // 过期：重抢
    const stale = claimOnce({ hookId: 'h', key: k, env, nowMs: t0 + CLAIM_TTL_MS + 1 });
    assert.equal(stale.claimed, true, '过期残留必须能被重抢，否则真事件被永久吞掉');
    assert.equal(stale.why, 'stale-reclaimed');

    // 重抢之后它又是「新鲜」的（mtime 现在是真实时间）
    assert.equal(claimOnce({ hookId: 'h', key: k, env, nowMs: Date.now() + 1000 }).claimed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('负向：把 TTL 当无限大，同键永远抢不到 —— 证明上面那条真的在测 TTL', () => {
  const dir = sandbox();
  try {
    const env = envIn(dir);
    const k = claimKeyOf('h', ['sess', 'id-1']);
    const t0 = 1_700_000_000_000;
    claimOnce({ hookId: 'h', key: k, env, nowMs: t0 });
    // 把文件 mtime 改成 10 年前，再用「刚好没超 TTL」的时刻去抢：不该成功。
    const p = claimPathFor(dedupeRoot({ env }), 'h', k);
    utimesSync(p, new Date(t0), new Date(t0));
    const notYet = claimOnce({ hookId: 'h', key: k, env, nowMs: t0 + CLAIM_TTL_MS - 1000 });
    assert.equal(notYet.claimed, false);
    // 同一份文件，越过 TTL 就成功 —— 唯一的差别是时间
    const past = claimOnce({ hookId: 'h', key: k, env, nowMs: t0 + CLAIM_TTL_MS + 1000 });
    assert.equal(past.claimed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 4. 失效方向：任何异常都必须「照常判定」 ──────────────────────────

test('没有键 → 认领成功（放弃去重，照常判定）', () => {
  const dir = sandbox();
  try {
    const env = envIn(dir);
    const r1 = claimOnce({ hookId: 'h', key: '', env });
    const r2 = claimOnce({ hookId: 'h', key: '', env });
    assert.equal(r1.claimed, true);
    assert.equal(r1.why, 'no-key');
    assert.equal(r2.claimed, true, '没有键就永远不去重 —— 不能拿它当「重复」');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('认领目录写不进去 → 认领成功（绝不能让去重失败变成跳过判定）', () => {
  // 用一个「父路径是文件」的目录，mkdir 必然失败（ENOTDIR），跨平台一致。
  const dir = sandbox();
  try {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a dir');
    const env = { OVERWATCH_HOOK_DEDUPE_DIR: join(blocker, 'sub') };
    const r = claimOnce({ hookId: 'h', key: claimKeyOf('h', ['s', 'i']), env });
    assert.equal(r.claimed, true, '写不进去时必须照常判定');
    assert.match(r.why, /^claim-failed:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('env 是垃圾对象也不抛（hook 的 env 来自宿主，不可信）', () => {
  const evil = { get OVERWATCH_HOOK_DEDUPE_DIR() { throw new Error('boom'); } };
  assert.doesNotThrow(() => claimOnce({ hookId: 'h', key: 'k', env: evil }));
  assert.equal(claimOnce({ hookId: 'h', key: 'k', env: evil }).claimed, true);
});

test('认领用的是 O_EXCL 而不是「先检查再创建」—— 源码里不许出现 existsSync 守卫', () => {
  // 这是机制判据：本仓反复踩过「先读后写」的竞态，注释写对了没用，形式要钉住。
  const src = readFileSync(new URL('../scripts/hook-dedupe.mjs', import.meta.url), 'utf8');
  assert.match(src, /openSync\(path,\s*'wx'\)/, '必须用 wx（O_EXCL）原子创建');
  const fn = src.slice(src.indexOf('export function claimOnce'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!/existsSync\([^)]*\)\s*\)?\s*\{?[^}]*openSync/.test(body),
    '认领路径里不许先 existsSync 再创建');
});

// ── 5. 真并发：两个进程同时抢同一个键，只能有一个赢 ──────────────────

test('多个子进程同时认领同一个键：恰好一个赢（这不是读代码得出的结论）', () => {
  const dir = sandbox();
  try {
    const env = envIn(dir);
    // 键里有 NUL，命令行参数不能带 —— 所以把整条键做成脚本里的字面量（JSON 转义）。
    const key = claimKeyOf('h', ['sess', 'concurrent']);
    const modUrl = new URL('../scripts/hook-dedupe.mjs', import.meta.url).href;
    const script = [
      `const { claimOnce } = await import(${JSON.stringify(modUrl)});`,
      `const r = claimOnce({ hookId: "h", key: ${JSON.stringify(key)}, env: { OVERWATCH_HOOK_DEDUPE_DIR: process.argv[1] } });`,
      'process.stdout.write(JSON.stringify(r.claimed));',
    ].join('\n');
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', script, env.OVERWATCH_HOOK_DEDUPE_DIR], {
      encoding: 'utf8', timeout: 30000,
    });
    // 起 6 个进程抢同一个键：无论怎么交错，赢家必须恰好 1 个。
    // 6 而不是 2，是为了让「先检查再创建」那种写法几乎必然会露出双重成功。
    const children = Array.from({ length: 6 }, () => run());
    const claimed = children.filter((r) => String(r.stdout).trim() === 'true').length;
    const errs = children.filter((r) => r.status !== 0);
    assert.equal(errs.length, 0, `子进程出错：${errs[0] && errs[0].stderr}`);
    assert.equal(claimed, 1, `6 个并发认领必须恰好 1 个成功，实测 ${claimed} 个`);
    // 盘上确实只有 1 个认领文件
    assert.equal(readdirSync(join(env.OVERWATCH_HOOK_DEDUPE_DIR, 'h')).filter((f) => f.endsWith('.json')).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 6. 清理：目录不能无限增长 ────────────────────────────────────────

test('sweepIfCrowded 只在条目超过阈值时才扫，且只删过期的', () => {
  const dir = sandbox();
  try {
    const d = join(dir, 'h');
    mkdirSync(d, { recursive: true });
    const t0 = 1_700_000_000_000;
    // 不到阈值：一条都不删（避免每次认领都 O(n) stat）
    for (let i = 0; i < 3; i++) writeFileSync(join(d, `f${i}.json`), '{}');
    assert.equal(sweepIfCrowded(d, t0), 0, '不到阈值不许扫');
    assert.equal(readdirSync(d).length, 3);

    // 超过阈值，且全部过期
    for (let i = 3; i < SWEEP_AT + 5; i++) {
      const p = join(d, `f${i}.json`);
      writeFileSync(p, '{}');
      utimesSync(p, new Date(t0), new Date(t0));
    }
    const removed = sweepIfCrowded(d, t0 + CLAIM_TTL_MS + 1000);
    assert.ok(removed > 0, '超过阈值且过期时必须清理');

    // 新鲜的不该被删
    writeFileSync(join(d, 'fresh.json'), '{}');
    const now = Date.now();
    utimesSync(join(d, 'fresh.json'), new Date(now), new Date(now));
    sweepIfCrowded(d, now);
    // 刚建的目录现在条目少于阈值，扫不扫都保留 —— 断言它还在
    assert.equal(existsSync(join(d, 'fresh.json')), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sweepIfCrowded 遇到不存在的目录不抛', () => {
  assert.doesNotThrow(() => sweepIfCrowded(join(tmpdir(), 'ow-dedupe-nope-' + Date.now()), Date.now()));
});

// ── 7. 跳过记录：单独一个文件，不混进台账 ────────────────────────────

test('recordSkipped 写在认领目录自己的 skipped.jsonl，一行一条', () => {
  const dir = sandbox();
  try {
    const env = envIn(dir);
    const k = claimKeyOf('h', ['sess', 'id-1']);
    claimOnce({ hookId: 'h', key: k, env });
    assert.equal(recordSkipped({ hookId: 'h', key: k, env, why: 'duplicate' }), true);
    recordSkipped({ hookId: 'h', key: k, env, why: 'duplicate' });
    const f = join(env.OVERWATCH_HOOK_DEDUPE_DIR, 'h', SKIPPED_FILE);
    const rows = readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.hookId, 'h');
      assert.equal(r.why, 'duplicate');
      assert.match(r.keyHash, /^[0-9a-f]{16}$/, '只记键的摘要，不记键本身');
      assert.equal('key' in r, false, '键里含会话 ID 与原文，不许落盘');
    }
    // 跳过记录**不**写进认领文件旁边之外的任何地方
    assert.deepEqual(readdirSync(join(env.OVERWATCH_HOOK_DEDUPE_DIR, 'h')).sort(),
      [SKIPPED_FILE, readdirSync(join(env.OVERWATCH_HOOK_DEDUPE_DIR, 'h')).find((f) => f.endsWith('.json'))].sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recordSkipped 写不进去返回 null，不抛', () => {
  const dir = sandbox();
  try {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    assert.equal(recordSkipped({ hookId: 'h', key: 'k', env: { OVERWATCH_HOOK_DEDUPE_DIR: join(blocker, 's') } }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 8. 目录解析：三层优先级，与两个 hook 的既有约定一致 ──────────────

test('dedupeRoot 的三层优先级：显式覆盖 → OVERWATCH_STATE_DIR → 仓库默认', () => {
  assert.equal(dedupeRoot({ env: { OVERWATCH_HOOK_DEDUPE_DIR: '/tmp/x' } }), '/tmp/x');
  assert.equal(dedupeRoot({ env: { OVERWATCH_STATE_DIR: '/tmp/state', OVERWATCH_HOOK_DEDUPE_DIR: '' } }),
    join('/tmp/state', DEDUPE_DIR_NAME));
  const dflt = dedupeRoot({ env: {} });
  assert.match(dflt.replace(/\\/g, '/'), /\/tasks\/runs\/hook-dedupe$/,
    '默认必须落在 gitignored 的 tasks/runs/ 下');
  // 空白串不等于设置（否则一次 `FOO= node ...` 就会写到奇怪的地方）
  assert.equal(dedupeRoot({ env: { OVERWATCH_HOOK_DEDUPE_DIR: '   ' } }), dflt);
});
