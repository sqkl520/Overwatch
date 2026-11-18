/**
 * replay-stop-gate.mjs — 「把 Stop 闸从 observe 改成 block，会拦多少个真实会话」。
 *
 * ── 为什么必须先量这个再开闸 ──────────────────────────────────────────
 * `stop-verify-hook.mjs` 默认 observe：只记账、永不放拦。要它真的挡人，得设
 * `OVERWATCH_STOP_VERIFY=block`。但在真实语料上跑一遍之前，「会拦多少」是未知数。
 *
 * 已知的两个相反事实：
 *   · 一篇实测说「真模型上很少有机会拦」（`2026-11-12-stop-hook-e2e-validation.md`）
 *   · 另一篇说「拦得住」（`2026-11-12-stop-hook-prototype.md`）
 * 两个都对，只是样本不同。而这个闸的失效代价极不对称：
 *   **误拦一次会让用户无法结束回合**（`brake:halt` 直接终止），比放过一个假完成更糟。
 *   所以不能靠「应该很少」来开闸。
 *
 * ── 它怎么回放 ────────────────────────────────────────────────────────
 * 对每个 transcript，取**每一条 assistant 文本**（不是只取最后一条）当作一次
 * 「这里可能结束回合」的时刻，用它前面的工具调用序列当证据，调 `decide()`。
 *
 * 取每条而不是只取最后一条，理由：真实的 Stop 事件发生在**模型认为自己做完了**的时候，
 * 而那种时刻在 transcript 里表现为一段有完成语义的收尾文本。只看最后一条会把
 * 中途那些「我先改 A，再改 B」的进度汇报也当成收尾 —— 那会**高估**拦截数。
 * 所以这里两种都算，分开报：
 *   strict  只算会话最后一条 assistant 文本（最接近真实 Stop）
 *   loose   算每一条含完成语义的文本（上界）
 *
 * 两个数一起看：strict 是「实际会拦」，loose 是「闸有多爱管闲事」。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   node scripts/replay-stop-gate.mjs
 *   node scripts/replay-stop-gate.mjs --days 7 --json
 *   node scripts/replay-stop-gate.mjs --root <dir>
 *
 * 退出码：0 正常；2 找不到 transcript 根。
 */

import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { decide, modeOf } from './stop-verify-hook.mjs';

const SANDBOX_RE = /(?:^|[-_/])(?:Temp|tmp-analysis|tmp-qa|hook-e2e|launch-redteam|payload-redteam)(?:$|[-_/])|(?:^|-)(?:ow|ptu-lab|acpprobe|sandbox|stranger|myproj|cleanproj|collproj|dualrole)[-_]?/i;

/** 子 agent 的 transcript 放在 `<project>/<parent-session>/subagents/*.jsonl`。
 *
 *  **它们不产生 Stop 事件** —— Stop 是「宿主准备结束回合」时触发的，
 *  而子 agent 的回合不经过那个入口。所以拿它们算「闸门会拦多少次」是**虚数**。
 *
 *  实测（2026-11-18，1 天窗口、非沙箱）：140 份子 agent transcript 里 28 份会「拦」，
 *  而真实主会话只有 16 份、其中 2 份会拦。也就是说**九成的「拦截」来自
 *  根本不会跑闸的文件**。第一版没排除它们，报出 19.6%，比真实值高约 7 倍。
 *
 *  这不是精度问题，是**分母错了**：用一份永远不会被调用的语料去论证「开闸会拦多少」，
 *  结论的方向都可能是错的。 */
const SUBAGENT_RE = /[\\/]subagents[\\/]/;

function parseArgs(argv) {
  const out = { days: 30, json: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') out.days = Number(argv[++i]) || out.days;
    else if (a === '--json') out.json = true;
    else if (a === '--root') out.root = argv[++i] || null;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/** 把一份 transcript 解析成 `{ records, texts }`。
 *
 *  `records` **必须是原始 transcript 行数组**，不能重排成自定义形状 ——
 *  `stop-verify-hook.decide()` 把它交给 `findEvidence()` / `buildEvidenceIndex()`，
 *  那两个函数认的是宿主的行格式（`type:"assistant"` + `message.content[]` 里的
 *  `tool_use` / `tool_result`）。换成扁平结构等于用另一套判据复现，
 *  得到的数字对不上真实闸门的行为。 */
function parseTranscript(text) {
  const records = [];
  const texts = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    records.push(rec);
    if (rec.type !== 'assistant') continue;
    const content = rec && rec.message && rec.message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item && item.type === 'text' && typeof item.text === 'string') texts.push(item.text);
    }
  }
  return { records, texts };
}

/** 对一个会话跑两种口径。返回 `{ strict, loose }` 各自是否会被拦。 */
function evaluate(parsed, project) {
  const { records, texts } = parsed;
  if (!texts.length) return { strict: null, loose: 0 };

  const base = { records, project, mode: 'block' };

  // strict：只把最后一条 assistant 文本当作收尾
  const lastText = texts[texts.length - 1];
  const strictDec = decide({ ...base, input: { hook_event_name: 'Stop', last_assistant_message: lastText, background_tasks: [], session_crons: [], cwd: '/x' } });

  // loose：每一条文本都当成可能的收尾
  let looseBlocks = 0;
  for (const t of texts) {
    const d = decide({ ...base, input: { hook_event_name: 'Stop', last_assistant_message: t, background_tasks: [], session_crons: [], cwd: '/x' } });
    if (d.action === 'block') looseBlocks++;
  }
  return { strict: strictDec.action === 'block' ? strictDec : null, loose: looseBlocks };
}

function walk(root, cutoff, out) {
  let ents;
  try { ents = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(root, e.name);
    if (e.isDirectory()) { walk(p, cutoff, out); continue; }
    if (!e.name.endsWith('.jsonl')) continue;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;
    let txt;
    try { txt = readFileSync(p, 'utf8'); } catch { continue; }
    out.push({
      path: p,
      project: e.name,
      sandbox: SANDBOX_RE.test(p),
      subagent: SUBAGENT_RE.test(p),
      content: txt,
    });
  }
}

/** CLI 入口。**必须走入口守卫**：结构硬门会 import 每个脚本去核对导出，
 *  若本文件在模块顶层执行，那次 import 就会真的跑一遍全量回放（几十秒）、
 *  并把中文写到那个子进程的 stdout 上 —— 硬门那一步会因此拿不到 JSON 而**静默放弃**。
 *  这与 DF-027 里 measure-checklist-coverage 的毛病是同一个，已一并修。 */
export function main(argv = process.argv.slice(2)) {
  const opt = parseArgs(argv);
  if (opt.help) {
    console.log('用法：node scripts/replay-stop-gate.mjs [--days 30] [--json] [--root <dir>]');
    console.log('只读。报 strict（只算末条文本）= 实际会拦，与 loose（每条文本）= 上界。');
    process.exit(0);
  }

  const root = opt.root || join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) {
    console.error(`找不到 transcript 根：${root}`);
    process.exit(2);
  }

  const files = [];
  walk(root, Date.now() - opt.days * 864e5, files);

  const buckets = {
    all: { n: 0, strictBlock: 0, looseBlockSessions: 0, looseBlocks: 0, reasons: {} },
    real: { n: 0, strictBlock: 0, looseBlockSessions: 0, looseBlocks: 0, reasons: {} },
    // **唯一有意义的那一档**：真实项目 + 主会话（会真的触发 Stop）。
    live: { n: 0, strictBlock: 0, looseBlockSessions: 0, looseBlocks: 0, reasons: {} },
  };

  for (const f of files) {
    const targets = [buckets.all];
    if (!f.sandbox) targets.push(buckets.real);
    // 子 agent 不产生 Stop 事件 —— 它们不进 `live` 这一档。
    if (!f.sandbox && !f.subagent) targets.push(buckets.live);

    const parsed = parseTranscript(f.content);
    const r = evaluate(parsed, { kind: 'node', test: 'npm run test', build: null, source: 'package.json' });

    for (const b of targets) {
      b.n++;
      if (r.strict) {
        b.strictBlock++;
        // `blocking[]` 的元素是 `{ claim, verdict }`，族名在 `claim.family` 上。
        // 第一版读 `.family` 于是一律落进 `unknown` —— 那个「30 条 unknown」看着像
        // 数据，实际是读错字段。这类错误不会报错，只会让分布图变成一根柱子。
        const blk = (r.strict.blocking && r.strict.blocking[0]) || {};
        const fam = (blk.claim && blk.claim.family) || 'unknown';
        b.reasons[fam] = (b.reasons[fam] || 0) + 1;
      }
      if (r.loose > 0) b.looseBlockSessions++;
      b.looseBlocks += r.loose;
    }
  }

  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const fmt = (b) => ({
    transcripts: b.n,
    strictBlocks: b.strictBlock,
    strictPct: pct(b.strictBlock, b.n),
    looseBlockSessions: b.looseBlockSessions,
    loosePct: pct(b.looseBlockSessions, b.n),
    looseBlockEvents: b.looseBlocks,
    byFamily: b.reasons,
  });

  const result = { root, days: opt.days, all: fmt(buckets.all), real: fmt(buckets.real), live: fmt(buckets.live), mode: modeOf({ OVERWATCH_STOP_VERIFY: 'block' }) };

  if (opt.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  console.log(`Stop 闸开 block 后的拦截量 · 窗口 ${opt.days} 天 · 根 ${root}`);
  console.log('');
  console.log(`  全部     ${String(result.all.transcripts).padStart(5)} 份 | strict 拦 ${String(result.all.strictBlocks).padStart(4)} (${result.all.strictPct}%) | loose 涉及 ${String(result.all.looseBlockSessions).padStart(4)} 份 (${result.all.loosePct}%)`);
  console.log(`  非沙箱   ${String(result.real.transcripts).padStart(5)} 份 | strict 拦 ${String(result.real.strictBlocks).padStart(4)} (${result.real.strictPct}%) | loose 涉及 ${String(result.real.looseBlockSessions).padStart(4)} 份 (${result.real.loosePct}%)`);
  console.log(`  ★ 会真的跑闸 ${String(result.live.transcripts).padStart(3)} 份 | strict 拦 ${String(result.live.strictBlocks).padStart(4)} (${result.live.strictPct}%) | loose 涉及 ${String(result.live.looseBlockSessions).padStart(4)} 份 (${result.live.loosePct}%)`);
  console.log('');
  console.log('  ★ = 真实项目 + 主会话。**只有这一行能用来判断「开闸会拦多少」。**');
  console.log('    中间那行含子 agent transcript —— 它们**不产生 Stop 事件**，');
  console.log('    拿它们算拦截率是虚数（实测虚高约 7 倍，见 SUBAGENT_RE 的注释）。');
  console.log('');
  console.log('strict = 只把会话最后一条 assistant 文本当收尾（最接近真实 Stop 事件）');
  console.log('loose  = 每条含完成语义的文本都算一次收尾（上界，高估）');
  if (Object.keys(result.live.byFamily).length) {
    console.log('');
    console.log('★ 档 strict 拦截按断言族：', JSON.stringify(result.live.byFamily));
  }

}

/** 入口守卫必须用 `realpathSync`，不能用 `resolve`。
 *
 *  `resolve()` 只规范化路径、**不解析符号链接**，而 `fileURLToPath(import.meta.url)`
 *  已被 Node 解析成真实路径。经目录符号链接执行（`npm link`、pnpm 的存储布局）时
 *  两边必然不等 —— 程序什么都不做、exit 0、零输出。本仓 17 个入口都踩过这个坑，
 *  `entry-symlink.test.mjs` 专门守它。 */
function realOrResolve(p) {
  try { return realpathSync(p); } catch { return resolve(p); }
}

if (process.argv[1] && realOrResolve(process.argv[1]) === realOrResolve(fileURLToPath(import.meta.url))) {
  main();
}
