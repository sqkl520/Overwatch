#!/usr/bin/env node
/**
 * redteam-gate-evidence.mjs — 红队取数：闸门认的「读证据」质量如何。
 *
 * 只读。三个指标，全部在真实语料上跑：
 *
 *   ① **失败的读也算数**：`Read` 的 `tool_result.is_error === true`（文件不存在 / 权限 /
 *      超限）仍旧被 `readTranscriptReads()` 计成一个「读过的不同文件」。
 *   ② **读到 cwd 之外**：证据路径不以会话 `cwd` 开头。闸门不校验「是不是这个项目」。
 *   ③ **伪路径**：`head -n 20 a.mjs` 抽出的 `20`、`-n` 之类，纯数字 / 纯选项。
 *
 * 用法：
 *   node scripts/redteam-gate-evidence.mjs
 *   node scripts/redteam-gate-evidence.mjs --json
 */

import { listTranscripts, dedupeForks, analyzeOne, isSandbox, eachLineOffset, gateReadsOf } from './observe-reality-check.mjs';
import { pathKeyOf } from './pre-write-gate.mjs';
import { gateReadsFixed, tailText } from './redteam-gate-widening.mjs';

const PSEUDO = /^[\d.,:+-]+$|^-[A-Za-z]/;

/** 全语料：读调用的成败分布。只看 Read 与 shell 整份读动词。 */
export function readOutcomes(root) {
  let readUses = 0, readFailed = 0, bashReadVerbs = 0, bashFailed = 0;
  const failedSamples = [];
  for (const m of listTranscripts(root)) {
    const pending = new Map();
    eachLineOffset(m.path, (line) => {
      let o; try { o = JSON.parse(line); } catch { return; }
      if (o.type === 'assistant') {
        for (const b of o.message?.content ?? []) {
          if (b?.type !== 'tool_use') continue;
          const nm = String(b.name || '');
          if (nm === 'Read' || nm === 'NotebookRead') { pending.set(b.id, 'read'); readUses++; }
          else if (nm === 'Bash' || nm === 'PowerShell') {
            const c = String(b.input?.command || b.input?.script || '');
            if (/(^|[;&|]\s*)(cat|head|tail|type|get-content|gc|more)\b/i.test(c)) { pending.set(b.id, 'shell'); bashReadVerbs++; }
          }
        }
        return;
      }
      if (o.type !== 'user') return;
      for (const b of o.message?.content ?? []) {
        if (b?.type !== 'tool_result') continue;
        const kind = pending.get(b.tool_use_id);
        if (!kind) continue;
        pending.delete(b.tool_use_id);
        if (b.is_error === true) {
          if (kind === 'read') { readFailed++; if (failedSamples.length < 5) failedSamples.push('Read'); }
          else bashFailed++;
        }
      }
    });
  }
  return { readUses, readFailed, bashReadVerbs, bashFailed, failedSamples };
}

/** 被拦会话（阈值 3）里，证据路径落在 cwd 之外的比例，以及伪路径条数。 */
export function evidenceQuality(root, { threshold = 3 } = {}) {
  const parsed = [];
  for (const m of listTranscripts(root)) { try { parsed.push(analyzeOne(m, { order: 'file' })); } catch { /* skip */ } }
  const { kept } = dedupeForks(parsed);
  const real = kept.filter((s) => !isSandbox(s)).filter((s) => s.firstWrite);
  const denied = real.filter((s) => s.gateReads < threshold);
  const rows = [];
  let totalEv = 0, outsideEv = 0, pseudoEv = 0;
  for (const s of denied) {
    const cwd = pathKeyOf(s.cwd || '');
    const set = new Set((s.readPathsWindow || []).map(pathKeyOf));
    let outside = 0, pseudo = 0;
    for (const p of set) {
      if (cwd && !p.startsWith(cwd + '/')) outside++;
      if (PSEUDO.test(p)) pseudo++;
    }
    // 修掉解析缺陷后还剩哪些「伪路径」被抽出来
    const fixed = new Set();
    for (const line of tailText(s.path, s.firstWrite.off).split('\n')) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!o || o.type !== 'assistant') continue;
      for (const b of o.message?.content ?? []) {
        if (!b || b.type !== 'tool_use') continue;
        for (const x of gateReadsFixed(String(b.name || ''), b.input || {})) { const k = pathKeyOf(x); if (k) fixed.add(k); }
      }
    }
    totalEv += set.size; outsideEv += outside; pseudoEv += pseudo;
    rows.push({ sessionId: s.sessionId.slice(0, 8), cls: s.gateReads, evidence: set.size, outside, pseudo, afterFix: fixed.size });
  }
  return { denied: denied.length, totalEv, outsideEv, pseudoEv, rows };
}

export function report(root) {
  const o = readOutcomes(root);
  const q = evidenceQuality(root);
  return { outcomes: o, quality: q };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('redteam-gate-evidence.mjs')) {
  const rep = report();
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(rep, null, 2) + '\n');
  else {
    const o = rep.outcomes; const q = rep.quality;
    console.log(`Read/NotebookRead 调用 ${o.readUses}，其中 tool_result.is_error=true ${o.readFailed}（${(o.readFailed / o.readUses * 100).toFixed(1)}%）`);
    console.log(`Bash/PowerShell 里含整份读动词的命令 ${o.bashReadVerbs}，其中 is_error ${o.bashFailed}（${(o.bashFailed / o.bashReadVerbs * 100).toFixed(1)}%）`);
    console.log(`被拦 ${q.denied} 个会话，窗口内证据共 ${q.totalEv} 条：cwd 之外 ${q.outsideEv}，伪路径 ${q.pseudoEv}`);
  }
}
