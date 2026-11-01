#!/usr/bin/env node
/**
 * probe-relay.mjs — 验证「跨会话投递」到底能不能自动完成。
 *
 * 这个脚本回答一个决定整个 auto 模式值不值得做的问题：
 * **消息发过去，接收方会执行吗，还是会被扣住等人批准？**
 *
 * 从 claude.exe 2.1.270 逆向出的协议事实（2026-11-01）：
 *
 *   - 会话注册 `messagingSocketPath`（Windows 命名管道）
 *   - 认证：`peerToken`（32 位 hex），来自 `<pid>.<sha256>.key`
 *   - 消息要有 `type` 字段，否则被丢：「Ignoring message without valid type field」
 *   - **送达状态有四种**（`Ce()` 函数原文）：
 *       delivered → 直接进对方会话
 *       held      → 「held for the recipient user's approval ... (permission-mode parity)」
 *       denied    → 「The recipient user declined your message」
 *       expired   → 扣留超时
 *   - 触发 held 的条件是 **permission-mode parity**：发送方与接收方的权限模式不匹配
 *   - 接收方的 `crossSessionInbound` 设置：`accept` / `hold` / `refuse`
 *
 * **所以「全自动接力」的可行性完全取决于：默认配置下是 delivered 还是 held。**
 * 这个脚本就是测这个。
 *
 * 用法：
 *   node scripts/probe-relay.mjs                 # 列出所有会话与它们的可投递性
 *   node scripts/probe-relay.mjs --send <pid>    # 真的发一条测试消息
 *   node scripts/probe-relay.mjs --send <pid> --dry
 *
 * 退出码：0 = 完成（无论结论）；1 = 环境不允许；2 = 参数错误。
 *
 * 零依赖。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SESSIONS = join(homedir(), '.claude', 'sessions');

/** 读所有活跃会话的注册信息。 */
export function listSessions(dir = SESSIONS) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let j;
    try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    if (!j.sessionId) continue;
    out.push({
      pid: j.pid,
      sessionId: j.sessionId,
      name: j.name || null,
      status: j.status || null,
      waitingFor: j.waitingFor || null,
      socketPath: j.messagingSocketPath || null,
      permissionMode: j.permissionMode || null,
      peerProtocol: j.peerProtocol ?? null,
      peerFeatures: j.peerFeatures || [],
      version: j.version || null,
      entrypoint: j.entrypoint || null,
      cwd: j.cwd || null,
    });
  }
  return out;
}

/** 找某个 pid 的 peerToken。文件名形如 `<pid>.<64位hex>.key`。 */
export function readPeerToken(pid, dir = SESSIONS) {
  if (!existsSync(dir)) return null;
  const prefix = `${pid}.`;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(prefix)) continue;
    if (!/^\d+\.[0-9a-f]{64}\.key$/.test(f)) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (typeof j.peerToken === 'string' && /^[0-9a-f]{32}$/.test(j.peerToken)) {
        return { token: j.peerToken, file: join(dir, f) };
      }
    } catch { /* 坏文件跳过 */ }
  }
  return null;
}

/** 只测能不能连上，不发任何数据。 */
export function canConnect(socketPath, timeoutMs = 3000) {
  return new Promise((done) => {
    if (!socketPath) { done({ ok: false, why: '没有 messagingSocketPath' }); return; }
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => { sock.destroy(); done({ ok: false, why: 'timeout' }); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); sock.destroy(); done({ ok: true }); });
    sock.once('error', (e) => { clearTimeout(timer); done({ ok: false, why: e.code || e.message }); });
  });
}

/** 构造一条投递帧。
 *
 *  字段名来自逆向：`type`、`content`、`session_id`、`peerToken`、
 *  `msg_id`、`file_attachments`、`reply_to`。
 *  **不要凭猜**——`type` 缺失会被明确丢掉。 */
export function buildFrame({ type = 'user', content, sessionId, peerToken, msgId = null }) {
  return {
    type,
    msg_id: msgId || createHash('sha256').update(randomBytes(16)).digest('hex').slice(0, 16),
    session_id: sessionId,
    peerToken,
    content,
  };
}

/** 发送一帧并等对方的响应（或超时）。
 *
 *  宿主的返回是换行分隔 JSON。**必须读回音**——不然无法区分
 *  「发出去了」和「被扣住了」。 */
export function sendFrame(socketPath, frame, { timeoutMs = 8000 } = {}) {
  return new Promise((done) => {
    const replies = [];
    let buf = '';
    let settled = false;
    const finish = (why) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      done({ replies, why });
    };
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    sock.on('connect', () => {
      sock.write(JSON.stringify(frame) + '\n');
    });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try { replies.push(JSON.parse(line)); } catch { replies.push({ raw: line }); }
      }
      // 收到明确的状态就收工
      if (replies.some((r) => r && (r.status || r.error || r.type === 'peer_message_status'))) {
        clearTimeout(timer);
        finish('got-status');
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); done({ replies, why: `error:${e.code || e.message}` }); settled = true; });
    sock.on('close', () => { clearTimeout(timer); if (!settled) { settled = true; done({ replies, why: 'closed' }); } });
  });
}

/** 从回音里判送达结果。对应逆向出的四种状态。 */
export function interpretReply(replies) {
  const text = JSON.stringify(replies || []);
  if (/permission-mode parity/.test(text)) {
    return { delivery: 'held', why: '权限模式不匹配，被扣住等对方批准' };
  }
  if (/declined your message/.test(text)) {
    return { delivery: 'denied', why: '对方拒绝了' };
  }
  if (/"status"\s*:\s*"delivered"|approved and released/.test(text)) {
    return { delivery: 'delivered', why: '直接送达' };
  }
  if (/expired/.test(text)) return { delivery: 'expired', why: '扣留超时' };
  if (!replies || !replies.length) return { delivery: 'unknown', why: '没有任何回音' };
  return { delivery: 'unknown', why: '回音无法解读' };
}

// ── CLI ───────────────────────────────────────────────────────────────

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node scripts/probe-relay.mjs [--send <pid>] [--dry] [--json]');
    console.log('  验证跨会话投递能否自动送达。不写任何状态，不改任何文件。');
    console.log('  --send <pid>  真的发一条测试消息给该会话');
    console.log('  --dry         只构造帧，不发送');
    return 0;
  }

  const sessions = listSessions();
  if (!sessions.length) {
    console.error('没有活跃会话（~/.claude/sessions 为空）。');
    return 1;
  }

  // 连通性
  const withConn = [];
  for (const s of sessions) {
    const c = await canConnect(s.socketPath);
    const tok = readPeerToken(s.pid);
    withConn.push({ ...s, connect: c, hasToken: Boolean(tok) });
  }

  const sendIdx = argv.indexOf('--send');
  const targetPid = sendIdx >= 0 ? Number(argv[sendIdx + 1]) : null;

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ sessions: withConn }, null, 2));
    return 0;
  }

  console.log(`活跃会话 ${withConn.length} 个：\n`);
  for (const s of withConn) {
    const conn = s.connect.ok ? '✓ 可连' : `✗ ${s.connect.why}`;
    const tok = s.hasToken ? '✓ token' : '✗ 无 token';
    console.log(`  pid=${String(s.pid).padEnd(7)} ${(s.name || '').slice(0, 18).padEnd(20)} ` +
      `${String(s.status).padEnd(7)} ${conn}  ${tok}  协议v${s.peerProtocol}`);
  }

  if (targetPid == null) {
    console.log('\n只测了连通性。要验证投递，加 --send <pid>。');
    return 0;
  }

  const target = withConn.find((s) => s.pid === targetPid);
  if (!target) { console.error(`\n找不到 pid=${targetPid}`); return 2; }
  if (!target.connect.ok) { console.error(`\npid=${targetPid} 连不上：${target.connect.why}`); return 1; }
  const tok = readPeerToken(target.pid);
  if (!tok) { console.error(`\npid=${targetPid} 没有 peerToken`); return 1; }

  const frame = buildFrame({
    content: '[overwatch-probe] 这是一条投递能力测试消息，请忽略内容并回一句「收到」即可。',
    sessionId: target.sessionId,
    peerToken: tok.token,
  });

  console.log(`\n目标：${target.name} (pid=${target.pid})`);
  console.log('帧：', JSON.stringify(frame, null, 1));

  if (argv.includes('--dry')) { console.log('\n--dry：没有真的发送。'); return 0; }

  console.log('\n发送中…');
  const r = await sendFrame(target.socketPath, frame);
  const verdict = interpretReply(r.replies);
  console.log('回音：', JSON.stringify(r.replies, null, 1));
  console.log(`\n判定：${verdict.delivery} —— ${verdict.why}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}

void basename; void statSync;
