#!/usr/bin/env node
/**
 * measure-checklist-coverage.mjs — 清单机制在**真实使用**中覆盖多少。
 *
 * 为什么存在：产品要做「把任务拆成带 outputs 的清单，收工时机械核对每一项是否落地」。
 * 这个机制已经建好了（`claim-ledger.mjs` + `validate-run.mjs` 的必需 `outputs` +
 * `SKILL.md` §4.5 的三步流程）。但在决定要不要给它加闸之前，必须先回答一个
 * 比「怎么判」更靠前的问题：**它覆盖得到真实使用吗？**
 *
 * 如果绝大多数会话根本不写 `task-graph.json`，那么在这上面加闸只会加给
 * 少数已经守规矩的人 —— 而那批人本来就不太需要它。
 *
 * ── 三个数，缺一不可 ──────────────────────────────────────────────────
 *
 *   分母      窗口内有多少份 transcript
 *   派发率    其中多少份**真的调用过 `Agent` 工具**
 *   清单率    其中多少份提到 `task-graph.json`
 *
 * 只有「派发率」高而「清单率」低，才说明「大家在派发但不走清单」，
 * 那才支持「把清单机制做得更省事」。两个都低就说明这个机制在解决一个
 * 没人遇到的问题。
 *
 * ── 必须排除沙箱 ──────────────────────────────────────────────────────
 *
 * 本机 `~/.claude/projects/` 下大量目录是**这个仓库自己的测试沙箱**
 * （`*-Temp-*`、`*-tmp-analysis-*`、`*-hook-e2e-*` …）。它们由测试脚本创建，
 * 里面有大量 `Agent` 调用。不排除的话会把「派发率」算成 90%+ ——
 * 那是测量工具在数自己，不是用户行为。实测：全量 596 份里沙箱占 501 份。
 *
 * 排除规则写成**可核对的名单 + 正则**，并且**分开报两个数**（含沙箱 / 不含沙箱），
 * 让读的人自己看见差距，而不是只相信一个过滤后的结论。
 *
 * 用法：
 *   node scripts/measure-checklist-coverage.mjs
 *   node scripts/measure-checklist-coverage.mjs --days 7
 *   node scripts/measure-checklist-coverage.mjs --json
 *   node scripts/measure-checklist-coverage.mjs --root <dir>
 *
 * 退出码：0 = 正常；2 = 找不到 transcript 根。
 */

import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** 沙箱目录名特征。**只匹配目录名，不看内容** —— 依据是这些目录全由测试脚本
 *  在系统临时目录下创建，名字里带 Temp 或本仓测试前缀。 */
const SANDBOX_RE = /(?:^|[-_/])(?:Temp|tmp-analysis|tmp-qa|hook-e2e|launch-redteam|payload-redteam)(?:$|[-_/])|(?:^|-)(?:ow|ptu-lab|acpprobe|sandbox|stranger|myproj|cleanproj|collproj|dualrole)[-_]?/i;

/** 真正调用 Agent 工具的判据：transcript 的 JSON 里出现 `"name":"Agent"`。
 *  **不是**搜 `Agent` 这个词 —— 那样会把「我打算调用 Agent」也算进去。 */
const AGENT_CALL_RE = /\\?"name\\?"\s*:\s*\\?"Agent\\?"/;

/** 清单机制被用过的判据：提到 task-graph.json。 */
const GRAPH_RE = /task-graph\.json/;

function parseArgs(argv) {
  const out = { days: 7, json: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') out.days = Number(argv[++i]) || out.days;
    else if (a === '--json') out.json = true;
    else if (a === '--root') out.root = argv[++i] || null;
    else if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

/** 默认 transcript 根。与 `scan-sessions.mjs` / `watch.mjs` 保持一致。 */
function defaultRoot() {
  return join(homedir(), '.claude', 'projects');
}

/** 扫一遍。返回逐项目聚合，**不做任何过滤** —— 过滤发生在报告层，
 *  这样同一份数据能同时给出「含沙箱 / 不含沙箱」两个数。 */
function collect(root, cutoffMs) {
  const projects = [];
  let dirs;
  try { dirs = readdirSync(root); } catch { return null; }

  for (const proj of dirs) {
    let files;
    try { files = readdirSync(join(root, proj)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    let n = 0;
    let withAgent = 0;
    let withGraph = 0;
    for (const f of files) {
      const p = join(root, proj, f);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.mtimeMs < cutoffMs) continue;
      let txt = '';
      try { txt = readFileSync(p, 'utf8'); } catch { continue; }
      n++;
      if (AGENT_CALL_RE.test(txt)) withAgent++;
      if (GRAPH_RE.test(txt)) withGraph++;
    }
    if (n) projects.push({ project: proj, sandbox: SANDBOX_RE.test(proj), n, withAgent, withGraph });
  }
  return projects;
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function summarize(list) {
  const s = list.reduce((acc, p) => ({
    n: acc.n + p.n, withAgent: acc.withAgent + p.withAgent, withGraph: acc.withGraph + p.withGraph,
  }), { n: 0, withAgent: 0, withGraph: 0 });
  return {
    transcripts: s.n,
    withAgentCall: s.withAgent,
    agentRatePct: pct(s.withAgent, s.n),
    withTaskGraph: s.withGraph,
    graphRatePct: pct(s.withGraph, s.n),
  };
}

/** CLI 入口。**必须走入口守卫**（见文件末）：本脚本此前在模块顶层执行并打印，
 * 而 check-structure.mjs 的「导出是否登记」那一项会 import 每个脚本 ——
 * 于是每次跑硬门都真的把这份测量跑一遍，并把中文打到那个子进程的 stdout 上，
 * 导致它的 JSON.parse 失败后**静默放弃整项检查**（与 DF-031 同一种失效：
 * 静默跳过与通过的表现一模一样）。收进函数 + 入口守卫之后，import 不再有行为。 */
export function main(argv = process.argv.slice(2), log = console.log) {
  const opt = parseArgs(argv);

  if (opt.help) {
    console.log('用法：node scripts/measure-checklist-coverage.mjs [--days 7] [--json] [--root <dir>]');
    console.log('只读。报「派发率」与「清单率」，并分开报含沙箱 / 不含沙箱两个口径。');
    return 0;
  }

  const root = opt.root || defaultRoot();
  if (!existsSync(root)) {
    console.error(`找不到 transcript 根：${root}`);
    return 2;
  }

  const cutoff = Date.now() - opt.days * 864e5;
  const all = collect(root, cutoff);
  if (!all) {
    console.error(`目录不可读：${root}`);
    return 2;
  }

  const real = all.filter((p) => !p.sandbox);
  const sandbox = all.filter((p) => p.sandbox);

  const result = {
    root,
    days: opt.days,
    all: summarize(all),
    real: summarize(real),
    sandbox: summarize(sandbox),
    topReal: real.sort((a, b) => b.n - a.n).slice(0, 8)
      .map((p) => ({ project: p.project, transcripts: p.n, withAgentCall: p.withAgent, withTaskGraph: p.withGraph })),
  };

  if (opt.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  const row = (label, s) => `  ${label.padEnd(12)} ${String(s.transcripts).padStart(5)} 份`
    + ` | 派发 ${String(s.withAgentCall).padStart(4)} (${s.agentRatePct ?? '-'}%)`
    + ` | 清单 ${String(s.withTaskGraph).padStart(3)} (${s.graphRatePct ?? '-'}%)`;

  console.log(`清单机制覆盖率 · 窗口 ${opt.days} 天 · 根 ${root}`);
  console.log('');
  console.log('口径（两个都报，差距本身就是结论）：');
  console.log(row('含沙箱', result.all));
  console.log(row('不含沙箱', result.real));
  console.log(row('  其中沙箱', result.sandbox));
  console.log('');
  console.log('怎么读这组数：');
  console.log('  · 派发率高、清单率低 → 大家在派发，但不走清单流程。清单机制做得再严也只覆盖那一小撮。');
  console.log('  · 两个都低           → 这个机制在解决一个没人遇到的问题。');
  console.log('  · 两个都高           → 加闸是有意义的，覆盖面撑得住成本。');
  console.log('');
  console.log('沙箱目录由本仓库自己的测试脚本创建，里面有大量 Agent 调用。');
  console.log('不排除会把派发率算成 90%+ —— 那是工具在数自己，不是用户行为。');

  return 0;
}

/** 「我是不是被直接执行」——比的是**真实路径**（理由见 stop-verify-hook.mjs 的同名逻辑）：
 *  resolve() 不解析符号链接，经 npm link / pnpm 执行时两边必然不等，程序会静默 exit 0。 */
const realOrResolve = (p) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};
if (process.argv[1] && realOrResolve(process.argv[1]) === realOrResolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
