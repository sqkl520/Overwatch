#!/usr/bin/env node
/**
 * job-event-time.mjs — 从宿主 job 记录里解析「这次终态发生在什么时候」。
 *
 * 这是**跨层去重的地基**：`probeJobs`（watch.mjs）与 `candidatesFromScan`
 * （scan-sessions.mjs 的输出 → watch.mjs）描述的是同一个宿主事件，
 * 只要两边从同一份文件算出同一个时刻，`dedupeKey` 的第四个参数就必然相等。
 *
 * 以前这段逻辑只存在于 watch.mjs，scan 侧另用 `lastActivity` 凑了一个指纹，
 * 于是同一次失败跨层得到两个键。生产 `state.json` 里能看到实际的重复发送
 * （见 `docs/research/2026-11-05-dedup-test-failure.md` §5）。
 *
 * 零依赖、无副作用、不读全局时钟：只读传入的路径。
 */

import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

/** `timeline.jsonl` 只读尾部这么多字节。实测本机最长 141 KB（e461a939），256 KB 覆盖全文件。
 *  被截断且尾部找不到同状态记录时按「事件时间无法确定」处理（fail-closed）。 */
export const TIMELINE_TAIL_BYTES = 256 * 1024;

/** 从 `detail` 文本里解析分布式请求 id 里的时间戳，形如 `20261005155700`（UTC）。
 *
 *  这是**唯一由错误本身携带**的时间：宿主写 503 的正文时把 id 一起写下了，
 *  之后无论记录被重写多少次，这个串都不变。返回 ms；解析不出返回 null。 */
export function requestIdTime(text) {
  const m = String(text || '').match(/request id:\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  // Date.UTC 的月份从 0 起；逐段验回读，挡住 20261332259900 这种看起来合法的乱码
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (!Number.isFinite(ms)) return null;
  const back = new Date(ms);
  if (back.getUTCFullYear() !== +y || back.getUTCMonth() !== +mo - 1 || back.getUTCDate() !== +d) return null;
  return ms;
}

/** 读 `timeline.jsonl` 尾部，返回**最后一条** `state === terminal` 记录的 `at`（ms）。
 *
 *  为什么只认同状态的记录：一个 job 可能先 failed 后 blocked。最后一条 blocked
 *  才是「这次阻塞何时发生」，取任意最后一条会让先失败后阻塞的记录时刻被失败时刻顶替。
 *
 *  被截断（文件大于尾部预算）且尾部找不到同状态记录时返回 null —— 此时**不能**断言
 *  「没有这条事件」，只能说「尾部没有」。调用方按 fail-closed 处理。 */
export function lastTimelineStateTime(jobsDir, terminal, maxBytes = TIMELINE_TAIL_BYTES) {
  const p = join(String(jobsDir), 'timeline.jsonl');
  let raw;
  let truncated = false;
  try {
    const size = statSync(p).size;
    const n = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : TIMELINE_TAIL_BYTES;
    if (size > n) {
      const buf = Buffer.allocUnsafe(n);
      const fd = openSync(p, 'r');
      try { readSync(fd, buf, 0, n, size - n); } finally { closeSync(fd); }
      raw = buf.toString('utf8');
      const firstNl = raw.indexOf('\n');
      if (firstNl >= 0) raw = raw.slice(firstNl + 1);
      truncated = true;
    } else {
      raw = readFileSync(p, 'utf8');
    }
  } catch {
    return { atMs: null, truncated: false, found: false };
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; } // 坏行不影响其余记录
    if (!rec || rec.state !== terminal) continue;
    const at = Date.parse(rec.at || '');
    return { atMs: Number.isFinite(at) ? at : null, truncated, found: true };
  }
  return { atMs: null, truncated, found: false };
}

/** 判定一条宿主终态记录的**事件时刻**，返回 `{ atMs, source, why }`。
 *
 *  ⚠ 绝不能拿 `job.updatedAt` 当事件时刻。它是**文件元数据时间**：宿主在启动、
 *  补写 `respawnFlags` / `name` / `providerEnv` 时都会重写这个 json，把它刷新到当下。
 *  2026-11-02 实测的假阳性正是这么来的（`a9fa4c62`）：
 *
 *      state: "blocked"，detail 里的 request id 是 2026-10-05T15:57:00Z
 *      timeline.jsonl 末条  {"at":"2026-10-05T15:57:02.483Z","state":"blocked"}
 *      updatedAt:            "2026-11-01T18:41:21.066Z"   ← 重写记录的时刻
 *
 *  **差 27.8 天。** 判定器把 27 天前的 503 当成新鲜阻塞，还据此算出 idle=916m
 *  写进通知正文——那个数字是编造的。
 *
 *  取数优先级（越靠前越接近「事件发生」）：
 *    1. `timeline.jsonl` 末条同状态记录的 `at` —— 宿主自己的事件流水，最强的证据
 *    2. `detail` 里 request id 的时间戳      —— 由那次错误本身携带，不会被重写
 *    3. `firstTerminalAt`                    —— 宿主写的「首次进入终态」，只在下两条都没有时兜底
 *  三者都拿不到 → `atMs: null`，调用方 **fail-closed 不通知**。
 *  不退回 `updatedAt`：宁可漏报一条无法定时的旧记录，也不把重写时刻当事件时刻。
 *
 *  两条都用时取**更旧**的那条。理由：两者都是真实事件时刻，更旧的那条离「现在」更远，
 *  按它判过期只会少发不会多发。取新的会把一条其实早就死掉的记录续命。 */
export function resolveJobEventTime(job, jobsDir) {
  const terminal = job && job.state === 'failed' ? 'failed' : 'blocked';
  const candidates = [];

  const tl = lastTimelineStateTime(jobsDir, terminal);
  if (Number.isFinite(tl.atMs)) candidates.push({ atMs: tl.atMs, source: 'timeline' });

  const rid = requestIdTime(job && (job.detail || job.needs));
  if (Number.isFinite(rid)) candidates.push({ atMs: rid, source: 'request-id' });

  if (!candidates.length) {
    const ft = Date.parse(job && job.firstTerminalAt || '');
    // firstTerminalAt 是「首次进入终态」——它可能早于这次终态（先 failed 后 blocked），
    // 所以只在没有更强证据时用，且它偏旧，只会让判过期更保守。
    if (Number.isFinite(ft)) candidates.push({ atMs: ft, source: 'first-terminal' });
  }

  if (!candidates.length) {
    return {
      atMs: null,
      source: null,
      why: tl.truncated ? 'timeline-truncated-no-match' : 'no-event-time',
    };
  }
  candidates.sort((a, b) => a.atMs - b.atMs);
  return { atMs: candidates[0].atMs, source: candidates[0].source, why: null };
}
