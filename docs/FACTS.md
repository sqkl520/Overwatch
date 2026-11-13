# 事实清单：现在到底什么是真的

> **本文件是快照，不是承诺。** 实测时段 2026-11-12 16:30–19:20（UTC+8），本机、单账号、单宿主版本 2.1.289。
> 每一行数字都当场跑过；每一条都标了证据等级与复跑命令。
> **引用前请自己跑一遍命令。** 数字会漂，代码会改，语料在长。
>
> ⚠️ **日期口径**：本文件所有「最后验证时间」都取**系统时钟**（`date` 与 `Date.now()` 一致，均为 2026-11-12）。
> 仓库里同期文档落款是 2026-11-13，比系统时钟早一天。**我不知道哪个是笔误**，
> 但我没有为了对齐而改写自己实测的日期——那正是这份文档要防的事。

---

## 如何读这份文档

### 证据等级（沿用 `docs/spec/2026-11-02-autorelay-acceptance.md` §1.1）

| 级 | 形态 | 在这份文档里意味着什么 |
|---|---|---|
| **T0** | 断言 | 什么都不算。本文件**不含**任何 T0 条目——凡是只有说法的，都进了「未验证的假设」或「明确的未知」 |
| **T1** | 静态原文 | 代码/配置里的原文，附 `file:line`。你能读到同一段字节 |
| **T2** | 可重跑脚本 | 给了能直接复制的命令，别人跑一遍得到**同形态**输出（数字可以不同，形态必须相同） |
| **T3** | 端到端可观测 | 目标系统**自己**留下了变化记录（transcript 新增、文件真的被写、外部服务真的返回） |
| **T4** | 反向对照 | 改掉一个前提，结论**必然翻转**。用来区分「因果」与「巧合」 |

单条 T2 只能证明「跑得出来」，不能证明「结论对」。**看结论时优先看有没有 T3 / T4。**

### 三条使用规则

1. **数字会漂，引用前重跑。** 标了「快照」的条目尤其如此——扫描耗时、语料规模、断言条数都随时间线性增长。
2. **标了「稳定事实」的可以放心引用。** 那是代码结构或文件内容，除非有人改代码，否则不会变。
3. **本文件与任何报告冲突时，以本文件为准**，因为本文件是当场实测；但冲突本身会写在「已被推翻的结论」里，供你判断谁可信。

### 一个现场例证：本文件写了两小时，语料就长了一轮

写这份文档的过程中我重跑了几次 `verify-claims`：

| 时点 | transcript | 断言 | 含断言的会话 |
|---|---|---|---|
| 开写时 | 349 | 108 | 91 |
| 写完后 | **360** | **109** | **92** |

**`NO_EVIDENCE` 的拆分在两个时点完全一样**（48 会话 = 沙盒 45 + 真实 3；49 断言 = 沙盒 46 + 真实 3）。
这运气好——新长的 11 份 transcript 没带新的无证据断言。**下次未必。**
这就是为什么每条都要标时间和复跑命令：**「昨天是 49 条」和「今天是 49 条」是两句不同的话。**


### 哪些是快照，哪些是稳定

| 类别 | 性质 | 例 |
|---|---|---|
| 测试条数、扫描耗时、断言条数、介入次数、并发曲线 | **快照**，每次跑都变 | 「873 条」明天可能就是 900 |
| 某个文件的某一行写了什么、某个函数传了什么常量 | **稳定事实** | `stop-verify-hook.mjs:259` 传 `truncated: false` |
| 外部服务的行为（网关、npm 包、apt 源） | **随环境** | 网关能不能连，取决于本机代理有没有起来 |
| 「X 能用吗」 | **必须带条件** | 「能用」几乎总是「在这个环境、这个版本、这批环境变量下能用」 |

---

## 第一部分：已验证的技术事实

### 1.1 回归测试与硬门

**事实：全量回归测试 873 条，全部通过，耗时约 42 秒，来自 19 个测试文件。**
证据等级：T2 · 快照
```
node --test scripts/*.test.mjs
```
实测结果（2026-11-12）：
```
ℹ tests 873   ℹ pass 873   ℹ fail 0   ℹ duration_ms 41798
```
测试文件数：`ls scripts/*.test.mjs | wc -l` → **19**。
最后验证时间：2026-11-12

> ⚠️ 这个数字有硬门守着：`check-structure.mjs` 的 `checkTestCount()` 会数源码里 `^\s*test(` 的出现次数，
> 与 `README.md` / `CLAUDE.md` / `docs/GUIDE.md` / `.github/workflows/validate.yml` 四处的声明对账，写错直接 fail。
> **所以「873」现在是自洽的，但它明天就会变。**

**事实：结构硬门当前全绿。**
证据等级：T2 · 快照
```
node scripts/check-structure.mjs
```
实测结果：`✓ 结构检查全部通过`（exit 0）
最后验证时间：2026-11-12

---

### 1.2 「AI 说做完了」的核对（`verify-claims.mjs`）

**事实：全量 349 个主 transcript 里，91 个含可核对断言，共 108 条断言。四档分布是 41 / 10 / 0 / 49，另有 UNKNOWN 3、UNCHECKABLE 5。**
证据等级：T2 · 快照（**这个数字每天都在长**）
```
node scripts/verify-claims.mjs
```
实测结果（2026-11-12，读盘 0.58 GB，耗时 7.3 秒，35 个 transcript 被截断）：
```
合计 108 条可核对断言：41 SUPPORTED / 10 STALE_ONLY / 49 NO_EVIDENCE / 3 UNKNOWN / 5 UNCHECKABLE
覆盖 349 个 transcript，其中 91 个含可核对断言
```
退出码 **1**（存在 `NO_EVIDENCE` 时的默认行为）。
最后验证时间：2026-11-12

> **与 README 冲突**：`README.md:125` 写的是「228 个主 transcript、31 条断言：
> `SUPPORTED 26 / STALE_ONLY 1 / FAILED_ONLY 0 / NO_EVIDENCE 1 / UNKNOWN 3`」。
> 那是 2026-11-03 的快照，语料已从 228 长到 349，且 11-13 新增了 `vague-completion` 族
> （今天 30 条断言来自这一族），条数因此暴涨。**README 那行不是错的，是过期的。**

**事实：49 条 `NO_EVIDENCE` 里，46 条来自我们自己造的测试沙盒；真实语料只有 3 条，其中 2 条是同一份 transcript 的副本。**
证据等级：T3（按项目名逐个分类 + uuid 交集验证副本）

**第 1 步：分类。** 把下面这段存成任意文件跑（不依赖任何临时探针）：
```js
// node split.mjs
import { spawnSync } from 'node:child_process';
const r = spawnSync('node', ['scripts/verify-claims.mjs', '--json'], { encoding: 'utf8', maxBuffer: 1 << 28 });
const d = JSON.parse(r.stdout);                  // 注意：--json 在存在 NO_EVIDENCE 时 exit 1
const isSB = p => /hook-e2e-sandboxes|stop-hook-lab|hook-e2e-runs|tmp-analysis/.test(p);
const ne = d.summary.noEvidence;
const nClaims = rows => rows.reduce((a, r) => a + r.claims.length, 0);
const sb = ne.filter(r => isSB(r.project));
const real = ne.filter(r => !isSB(r.project));
console.log(`会话：${ne.length} = 沙盒 ${sb.length} + 真实 ${real.length}`);
console.log(`断言：${nClaims(ne)} = 沙盒 ${nClaims(sb)} + 真实 ${nClaims(real)}`);
console.log('真实项目：', [...new Set(real.map(r => r.project))]);
```
实测结果（2026-11-12，**在两个不同时点各跑一次，语料从 349 长到 360，拆分完全一致**）：
```
会话：48 = 沙盒 45 + 真实 3
断言：49 = 沙盒 46 + 真实 3
真实项目：['d--Server-MCServers-Server-plugin-Mentor-Express', 'D--Projects-rea']
```
- 46 条沙盒断言的来源目录：`Temp/hook-e2e-sandboxes/*`、`Temp/stop-hook-lab*`、`.tmp-analysis/hook-e2e-runs/*`。
- 3 条真实断言来自 2 个项目：`Mentor-Express`（1 条）、`D--Projects-rea`（2 条）。

**第 2 步：证明 `rea` 那 2 条是同一份 transcript 的副本。** 按 uuid 求交集：
```js
// node duprea.mjs —— 只在「同一项目目录下、文件名互为副本」的两个 sessionId 上求 uuid 交集
import fs from 'node:fs'; import path from 'node:path'; import { homedir } from 'node:os';
const dir = path.join(homedir(), '.claude', 'projects', 'D--Projects-rea');
const [A, B] = ['0a0e115c-b53d-42e9-8690-58ba1e70e1a7', 'f37b9290-fdf1-4272-aaa3-43a3a28fcf17']
  .map((id) => path.join(dir, id + '.jsonl'));
const uuids = (p) => {
  const s = new Set();
  for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { const o = JSON.parse(l); if (o.uuid) s.add(o.uuid); } catch {}
  }
  return s;
};
const a = uuids(A), b = uuids(B);
let inter = 0; for (const x of a) if (b.has(x)) inter++;
console.log('A', a.size, 'B', b.size, '交集', inter, '=', (inter / Math.min(a.size, b.size) * 100).toFixed(1) + '%');
```
实测结果：`A 2362  B 2359  交集 2356`（占 A 的 99.7%、占 B 的 99.9%），但两个文件里的 `sessionId` 不同。
→ **同一个会话被落盘两次，计了两条。**
→ **真实语料里干净的「说完成但无证据」实际是 2 条。**
最后验证时间：2026-11-12

> **这是「45 : 3」还是「43 : 3」的裁决**：两份报告分别写过 43 和 45。
> 差异来自「按会话数还是按断言数，以及沙盒目录名单覆盖到哪」。
> 今天实测：**按断言 46 : 3，按会话 45 : 3**。三个数都对，口径不同。

---

### 1.3 人工介入基线（`measure-interventions.mjs`）

**事实：最近 7 天共 117 次人工介入，分布在 144 个会话、951 个人类回合上。全域（`--days 0`）是 830 次 / 347 个会话。**
证据等级：T2 · 快照
```
node scripts/measure-interventions.mjs --days 7
node scripts/measure-interventions.mjs --days 0
```
实测结果（2026-11-12）：
```
--days 7 ：会话 144  人类回合 951   AI 交还 1781   介入 117
           打断 15 / 答问 27 / 插话 2 / 纠正 4 / 催促 69 / 正常对话 342
           P1 66(56.4%) / Q 36(30.8%) / P3 2 / P4 11 / P5 2
           每会话 p50=0 p90=2 max=17 mean=0.81
--days 0 ：会话 347  人类回合 2611  AI 交还 5583   介入 830
           P1 312(37.6%) / Q 234(28.2%) / P2 28 / P3 145 / P4 77 / P5 34
           有实质工作的会话（265 个）p50=1 p90=10 max=32 mean=3.1
```
最后验证时间：2026-11-12

> 早期报告写「798 次」「825 次」「828 次」。语料每次重跑都会变（新会话在产生），
> **只引比例与形状，不要引绝对次数。**

**事实：「开工前可问清」的介入占全量 37.6%（312/830），最近 7 天占 56.4%（66/117）。**
证据等级：T2 · 快照
```
node scripts/measure-interventions.mjs --days 0    # 看「P1 开工前可问清」一行
```
> ⚠️ 这两个比例差 **19 个百分点**，原因是 7 天窗口里「催促」类占比更高（59%），而「催促」多数被判 P1。
> **不要跨窗口混用比例。**
最后验证时间：2026-11-12

**事实：介入发生在「第一次写文件之前」的比例，最宽口径 7.8%，最严口径 4.5%。**
证据等级：T2 · 快照 · **四个口径都实测了**
口径说明：是否把 `Bash` 的写命令算「写操作」、是否把 `AskUserQuestion` 的作答算「介入」，各有一档。

复跑（复用仓库已有的导出函数，不依赖临时探针）：
```js
// node beforewrite.mjs   —— 用法：node beforewrite.mjs <bash:0|1> <answers:0|1>
import { listTranscripts, eachLine, humanTurnText, isInterrupt,
         classifyHumanMessage, isAskAnswer } from './scripts/measure-interventions.mjs';
import { join } from 'node:path'; import { homedir } from 'node:os';

const BASH = process.argv[2] === '1', ANSWERS = process.argv[3] === '1';
const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MUT = /(?:^|[\s;&|(])(?:sed\s+-i|perl\s+-i|git\s+apply\b|git\s+restore\b|tee\s|cat\s*>>?\s|cp\s|mv\s)|[^0-9&>]>>?\s*[^\s&|]/i;

function scan(path) {
  let n = 0, fw = -1; const ev = [];
  eachLine(path, (line) => {
    n++; let r; try { r = JSON.parse(line); } catch { return; }
    if (fw === -1 && r?.type === 'assistant' && Array.isArray(r?.message?.content)) {
      for (const b of r.message.content) {
        if (b?.type !== 'tool_use') continue;
        if (EDIT.has(b.name)) { fw = n; break; }
        if (BASH && b.name === 'Bash' && MUT.test(String(b.input?.command || ''))) { fw = n; break; }
      }
    }
    if (ANSWERS && isAskAnswer(r)) { ev.push({ i: n }); return; }
    const t = humanTurnText(r); if (t == null) return;
    if (isInterrupt(r)) { ev.push({ i: n }); return; }
    if (classifyHumanMessage(t) === 'normal') return;
    ev.push({ i: n });
  });
  return { fw, ev };
}

// 与 measure-interventions 的 run() 一样按文件名去重（同 sessionId 取最大的那份）
const seen = new Map();
for (const f of listTranscripts(join(homedir(), '.claude', 'projects'))) {
  const k = f.path.split(/[\\/]/).pop();
  const p = seen.get(k); if (!p || f.size > p.size) seen.set(k, f);
}
let before = 0, after = 0, noWrite = 0, total = 0;
for (const f of seen.values()) {
  const { fw, ev } = scan(f.path); if (!ev.length) continue;
  total += ev.length;
  if (fw === -1) { noWrite += ev.length; continue; }
  for (const e of ev) (e.i < fw ? before++ : after++);
}
const pct = (x) => (x / total * 100).toFixed(1) + '%';
console.log({ total, 写前: `${before} ${pct(before)}`, 写后: `${after} ${pct(after)}`, 无写操作: `${noWrite} ${pct(noWrite)}` });
```
实测结果（全量 351 份 transcript 去重后 344 个会话）：

| 口径（bash / answers） | 写前 | 写后 | 无写操作 | 总介入 |
|---|---|---|---|---|
| `0 0` 只算 Edit/Write，不算作答 | 6.9% | 87.2% | 5.9% | 595 |
| `0 1` 只算 Edit/Write，算作答 | **7.8%** | 87.7% | 4.5% | 783 |
| `1 0` Edit+Bash 写命令，不算作答 | 4.5% | 90.1% | 5.4% | 595 |
| `1 1` Edit+Bash 写命令，算作答 | **5.2%** | 90.7% | 4.1% | 783 |
最后验证时间：2026-11-12

> **与锐评报告的关系**：`2026-11-13-critique-question-layer-product.md` 写「写前 68 次（8.2%）」。
> 我复现不出 8.2%，复现得出 4.5%–7.8%。差异来自三处：①它把「写」只定义为 `Write/Edit/NotebookEdit`；
> ②它按 `timestamp` 比对而我是按记录顺序；③它多留了 2 个被脚本判重复的落盘。
> **方向完全一致（九成以上介入在动手之后），量级差 1–4 个百分点，结论不变。**

**事实：87% 的墙钟时间没有任何活跃会话。**
证据等级：T2 · 快照
```js
// node wallclock.mjs —— 按 gap>5min 切活跃段，重建全局并发曲线
import { listTranscripts, eachLine } from './scripts/measure-interventions.mjs';
import { join } from 'node:path'; import { homedir } from 'node:os';
const GAP = 5 * 60 * 1000, segs = [];
for (const f of listTranscripts(join(homedir(), '.claude', 'projects'))) {
  const ts = [];
  eachLine(f.path, (line) => {
    if (!line.includes('"timestamp"')) return;
    let r; try { r = JSON.parse(line); } catch { return; }
    const t = r?.timestamp ? Date.parse(r.timestamp) : NaN;
    if (Number.isFinite(t)) ts.push(t);
  });
  if (ts.length < 2) continue;
  ts.sort((a, b) => a - b);
  let s = ts[0];
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > GAP) { segs.push([s, ts[i - 1]]); s = ts[i]; }
  segs.push([s, ts[ts.length - 1]]);
}
const ev = segs.flatMap(([s, e]) => [[s, 1], [e, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
let cur = 0, prev = null, idle = 0, active = 0; const hist = new Map();
for (const [t, d] of ev) {
  if (prev !== null && t > prev) { const dt = t - prev; if (cur === 0) idle += dt; else { active += dt; hist.set(cur, (hist.get(cur) || 0) + dt); } }
  cur += d; prev = t;
}
const total = idle + active;
const pct = (x) => +(x / total * 100).toFixed(1);
console.log({ 段数: segs.length, 墙钟小时: +(total / 3600e3).toFixed(1), 无活跃: pct(idle),
              并发1: pct(hist.get(1) || 0), 并发2: pct(hist.get(2) || 0), 并发3: pct(hist.get(3) || 0),
              '并发>=5': pct([...hist].filter(([k]) => k >= 5).reduce((a, [, v]) => a + v, 0)) });
```
实测结果（2026-11-12，353 份 transcript、621,266 条记录、12,001 个活跃段、3,505.8 小时墙钟）：
```
无活跃会话：86.7%      有活跃：13.3%
并发=1：4.1%   并发=2：2.3%   并发=3：1.7%   并发≥5：3.8%
```
最后验证时间：2026-11-12

> **与锐评报告的关系**：`2026-11-13-critique-question-layer-product.md` 写「写前 68 次（8.2%）」。
> 我复现不出 8.2%，复现得出 4.5%–7.8%。差异来自三处：①它把「写」只定义为 `Write/Edit/NotebookEdit`；
> ②它按 `timestamp` 比对而我是按记录顺序；③它多留了 2 个被脚本判重复的落盘。
> **方向完全一致（九成以上介入在动手之后），量级差 1–4 个百分点，结论不变。**

> 原报告写「87.1% 墙钟无活跃（11,488 段）」，我重算 86.7%（12,001 段）。**同向、同量级，可放心引用「约 87%」。**

---

### 1.4 宿主与外部通道

**事实：Stop hook 的拦截路径有效——返回 `{"decision":"block","reason":...}` 时宿主会把它喂回模型。默认只记账不拦。**
证据等级：T3（真跑 hook 二进制，观察到 stdout 的 block 报文与 jsonl 账本两处变化）
```js
// node hookprobe.mjs —— 造一份「改了文件 + 说修好了 + 没跑验证」的 transcript，喂给 hook 两次
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const tmp = './hookprobe-sess.jsonl';
fs.writeFileSync(tmp, [
  { type:'user', message:{ role:'user', content:[{ type:'text', text:'fix the bug' }] }, timestamp:'2026-11-13T00:00:00Z' },
  { type:'assistant', message:{ role:'assistant', model:'x', content:[
      { type:'tool_use', id:'t1', name:'Edit', input:{ file_path:'a.mjs', old_string:'x', new_string:'y' } }] }, timestamp:'2026-11-13T00:01:00Z' },
  { type:'user', message:{ role:'user', content:[{ type:'tool_result', tool_use_id:'t1', content:'ok' }] }, timestamp:'2026-11-13T00:01:01Z' },
  { type:'assistant', message:{ role:'assistant', model:'x', content:[{ type:'text', text:'修好了。' }] },
    stop_reason:'end_turn', timestamp:'2026-11-13T00:02:00Z' },
].map(r => JSON.stringify(r)).join('\n') + '\n');

const input = JSON.stringify({
  session_id:'probe', transcript_path: tmp, cwd: process.cwd(), hook_event_name:'Stop',
  stop_hook_active:false, last_assistant_message:'修好了。',
  background_tasks:[], session_crons:[], permission_mode:'default', effort:'max',
});
for (const mode of ['off', 'block']) {
  const env = { ...process.env, OVERWATCH_STOP_VERIFY_LOG: './hookprobe.jsonl' };
  if (mode === 'block') env.OVERWATCH_STOP_VERIFY = 'block'; else delete env.OVERWATCH_STOP_VERIFY;
  const r = spawnSync('node', ['scripts/stop-verify-hook.mjs'], { input, env, encoding:'utf8', timeout:40000 });
  console.log(mode, '→ exit', r.status, 'stdout:', (r.stdout || '(empty = allow)').slice(0, 200));
}
console.log('账本最后两行：');
console.log(fs.readFileSync('./hookprobe.jsonl', 'utf8').trim().split('\n').slice(-2)
  .map(l => { const o = JSON.parse(l); return `${o.mode}: outcome=${o.outcome} action=${o.action}`; }).join('\n'));
```
实测结果（2026-11-12）：
- `mode=off`：exit 0，stdout 空（放行），但账本写 `outcome: "observed-only"`。
- `mode=block`：exit 0，**stdout 是 `{"decision":"block","reason":"【第 1 次拦截】…"}`**，账本写 `outcome: "blocked"`。
- 判定为 `NO_EVIDENCE`，理由文本里含原话、缺什么、该跑什么。
最后验证时间：2026-11-12

**事实：`stop-verify-hook.mjs:259` 仍然把 `truncated` 硬编码成 `false`——这是 T4 级别的可复现缺陷。**
证据等级：T4（改掉这一个前提，判定结果必然翻转）
```
sed -n '259p' scripts/stop-verify-hook.mjs
#   return classifyEvidence({ claim, evidence, truncated: false, records });
```
```js
// node trunc-t4.mjs —— 用一份 >9MB、真有一个成功测试在前段的 transcript 做对照
import { detectClaims, findEvidence, classifyEvidence, readTailRecords } from './scripts/verify-claims.mjs';
import fs from 'node:fs';

const p = './trunc.jsonl';
const out = fs.openSync(p, 'w');
const w = (o) => fs.writeSync(out, JSON.stringify(o) + '\n');
w({ type:'user', message:{ role:'user', content:[{ type:'text', text:'fix it' }] }, timestamp:'2026-11-13T00:00:00Z' });
w({ type:'assistant', message:{ role:'assistant', model:'x', content:[
     { type:'tool_use', id:'t1', name:'Edit', input:{ file_path:'a.mjs', old_string:'x', new_string:'y' } }] }, timestamp:'2026-11-13T00:01:00Z' });
w({ type:'assistant', message:{ role:'assistant', model:'x', content:[
     { type:'tool_use', id:'t2', name:'Bash', input:{ command:'node --test' } }] }, timestamp:'2026-11-13T00:02:00Z' });
w({ type:'user', message:{ role:'user', content:[
     { type:'tool_result', tool_use_id:'t2', content:'# pass 873\n# fail 0' }] }, timestamp:'2026-11-13T00:02:01Z' });
const filler = JSON.stringify({ type:'summary', summary:'x'.repeat(4000) });
for (let n = 0; n < 9.5 * 1024 * 1024; n += filler.length + 1) fs.writeSync(out, filler + '\n');
w({ type:'assistant', message:{ role:'assistant', model:'x', content:[{ type:'text', text:'873 个测试全绿。' }] },
    stop_reason:'end_turn', timestamp:'2026-11-13T01:00:00Z' });
fs.closeSync(out);

const loaded = readTailRecords(p, 8 * 1024 * 1024);
console.log('readTailRecords.truncated =', loaded.truncated);   // true
for (const c of detectClaims('873 个测试全绿。')) {
  const ev = findEvidence(loaded.records, c);
  console.log(c.family,
    '| truncated:false →', classifyEvidence({ claim:c, evidence:ev, truncated:false, records:loaded.records }).status,
    '| truncated:true  →', classifyEvidence({ claim:c, evidence:ev, truncated:true,  records:loaded.records }).status);
}
```
实测结果（2026-11-12）：
```
loaded.truncated = true    （9.5 MB 文件，只读了尾部 8 MB）
test-count | truncated:false → NO_EVIDENCE （拦）
           | truncated:true  → UNKNOWN     （放行，理由「窗口内没有…但只回溯了尾部一段」）
```
端到端也复现了：喂一份 9.5 MB、真有一个成功测试在前段的 transcript，hook 仍然输出
`「测试通过 —— 本会话里找不到对应证据（整个文件范围内没有任何「测试运行」调用）」`，
而账本同时记着 `transcriptTruncated: true`。**理由文本在撒谎，账本没撒谎。**
最后验证时间：2026-11-12 · 稳定事实（除非有人改这一行）

**事实：`claude mcp serve` 暴露 23 个工具，能真的执行工具调用。**
证据等级：T3（`tools/call` 返回了真实文件内容）
```js
// node mcpcall.mjs —— initialize → notifications/initialized → tools/list → tools/call Read
import { spawn } from 'node:child_process';
const p = spawn('claude', ['mcp', 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; p.stdout.on('data', (d) => { buf += d.toString(); });
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
send({ jsonrpc:'2.0', id:1, method:'initialize',
       params:{ protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{ name:'probe', version:'1' } } });
setTimeout(() => {
  send({ jsonrpc:'2.0', method:'notifications/initialized' });
  send({ jsonrpc:'2.0', id:2, method:'tools/list' });
  send({ jsonrpc:'2.0', id:3, method:'tools/call',
         params:{ name:'Read', arguments:{ file_path: 'README.md', limit: 3 } } });
}, 1500);
setTimeout(() => {
  for (const l of buf.split('\n').filter(Boolean)) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.id === 2) console.log('工具数', o.result.tools.length, ':', o.result.tools.map((t) => t.name).join(', '));
    if (o.id === 3) console.log('tools/call 返回:', String(o.result?.content?.[0]?.text || '').slice(0, 200));
  }
  p.kill();
}, 15000);
```
实测结果（2026-11-12，host 2.1.289）：
- `tools/list` → 23 个：`Agent, Glob, Grep, Read, Edit, Write, NotebookEdit, WebFetch, ReportFindings, WebSearch, TaskStop, Skill, DesignSync, EnterWorktree, ExitWorktree, SendMessage, ListAgents, Workflow, CronCreate, CronDelete, CronList, ScheduleWakeup, PowerShell`
- `tools/call` `Read(README.md, limit=3)` → 返回真实前 3 行内容。
最后验证时间：2026-11-12

**事实：ACP（`acpx`）能驱动 `opencode`，不能驱动 `claude`（卡在认证）。**
证据等级：T3（opencode 侧返回了模型输出；claude 侧返回了协议层错误）
```
# 任意目录下建一个提示文件
printf 'Reply with exactly: PONG\n' > /tmp/p.txt
acpx --format json --json-strict opencode exec --file /tmp/p.txt   # exit 0
acpx --format json --json-strict claude   exec --file /tmp/p.txt   # exit 1
```
实测结果（2026-11-12）：
- **opencode 成功**：`session/update` 里 `agent_message_chunk` 文本是 `PONG`，`stopReason: "end_turn"`，exit 0。
- **claude 失败**：`initialize` 与 `session/new` 都成功（返回了完整 slash 命令清单），
  `session/prompt` 返回 `{"code":-32000,"message":"Authentication required"}`，exit 1。
最后验证时间：2026-11-12

**事实：npm 上两个「同名」包的版本号并存——scoped 的有 0.104.1，无 scope 的最高 0.100.3。**
证据等级：T2 · 快照（会随发布变）
```
npm view @agentclientprotocol/claude-agent-acp version   # 0.106.0
npm view claude-agent-acp version                        # 0.100.3
npm view acpx version                                    # 0.22.0
```
最后验证时间：2026-11-12

**事实：`claude agents --json` 给 12 条会话，含 `blocked / busy / idle / waiting` 四种状态，但没有 token、novelty、idle 时长、failed。**
证据等级：T2 · 快照
```
claude agents --json
```
实测结果（2026-11-12）：12 条；`blocked 2 / busy 4 / idle 4 / waiting 2`；
字段只有 `id, cwd, kind, startedAt, sessionId, name, state, pid, status, waitingFor`。
**`failed` 字段不存在，token / novelty / idle 也都不存在。**
最后验证时间：2026-11-12

---

### 1.5 本机环境

**事实：网关的「模型列表」和「实际路由到哪个模型」是两回事。**
证据等级：T3（transcript 里每条 assistant 记录都写了 `message.model`，那是实际落库的模型名）
```
curl -s http://127.0.0.1:15721/v1/models        # 列出 2 个
```
```js
// node modeldist.mjs —— 最近 3 天所有 assistant 记录里 message.model 的真实分布
import { listTranscripts, eachLine } from './scripts/measure-interventions.mjs';
import { join } from 'node:path'; import { homedir } from 'node:os';
const dist = new Map(); let files = 0;
for (const f of listTranscripts(join(homedir(), '.claude', 'projects'))) {
  if (Date.now() - f.mtimeMs > 3 * 86400e3) continue;
  files++;
  eachLine(f.path, (line) => {
    if (!line.includes('"model"')) return;
    let r; try { r = JSON.parse(line); } catch { return; }
    const m = r?.message?.model; if (m) dist.set(m, (dist.get(m) || 0) + 1);
  });
}
console.log('扫描', files, '份；分布：', [...dist].sort((a, b) => b[1] - a[1]).slice(0, 15));
```
实测结果（2026-11-12）：
- `/v1/models` 只给 2 个：`MiniMax-M2.7-free`、`openai/gpt-5.6-luna`。
- 最近 3 天 136 份 transcript 的实际 model 分布：
  `SCNet-Max` **118,315** / `deepseek-ai/deepseek-v4.1-flash` 5,080 / `hy4-free` 1,095 / `deepseek-v4.1-flash` 106 / `mock` 94 / `<synthetic>` 71。
- 本会话（`ea4ef562`）5,242 条记录，model **全部是 `SCNet-Max`**（1837/1837）。
- **网关列表里没有 `SCNet-Max`。** 列表是上游 catalog 的残留，路由由 cc-switch 的 provider 配置决定。
最后验证时间：2026-11-12

**事实：网关不校验模型名——传一个假模型名不会在网关层被拒，会转发到上游再 503。**
证据等级：T3（拿到了上游的分组错误原文）
```js
// node gw2.mjs
const post = async (url, body) => {
  const r = await fetch(url, { method:'POST', headers:{ 'content-type':'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  return `${r.status} ${(await r.text()).slice(0, 260)}`;
};
console.log(await post('http://127.0.0.1:15721/v1/chat/completions',
  { model:'definitely-not-real-xyz', messages:[{ role:'user', content:'hi' }], max_tokens:8 }));
```
实测结果（2026-11-12）：
```
POST /v1/chat/completions  model=definitely-not-real-xyz  → 503
  {"error":{"message":"CC Switch local proxy failed … Provider: S3 AI; model: definitely-not-real-xyz;
   upstream_status: HTTP 503; cause: 分组 free 下模型 definitely-not-real-xyz 无可用渠道"}}
```
即：**「指定模型」这个动作是透传，不是校验**。它把名字原样送给上游，由上游决定认不认。
最后验证时间：2026-11-12

**事实：`claude -p` 在本机当前环境下不可用——无论是保留还是剥掉宿主环境变量，都拿不到输出。**
证据等级：T2（反复跑，形态一致：静默挂起或直接报未登录）· **这条推翻了研究索引里的「剥掉后 39.3 秒成功」**
```
# 保留宿主环境变量
claude -p --model haiku "say PONG"                    # → "Not logged in · Please run /login"，exit 1
# 按 P12 配方剥掉 7 个变量
env -u CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST -u CLAUDE_CODE_HOST_AUTH_ENV_VAR \
    -u CLAUDE_CODE_HOST_SESSION_ID -u CLAUDE_CODE_MESSAGING_TOKEN \
    -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDECODE -u ANTHROPIC_BASE_URL \
    claude -p --model haiku "say PONG"                # → 挂起，180s / 400s 两次超时，零输出
# 只剥认证相关变量、保留 ANTHROPIC_BASE_URL
env -u CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST -u CLAUDE_CODE_HOST_AUTH_ENV_VAR \
    -u CLAUDE_CODE_HOST_SESSION_ID -u CLAUDE_CODE_MESSAGING_TOKEN \
    -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDECODE \
    claude -p --model haiku "say PONG"
    # → {"error":"认证失败: Claude Desktop gateway 缺少 Authorization 头"}，exit 1
```
最后验证时间：2026-11-12

> **这条必须说清楚**：P12 的配方（剥掉变量后 39.3 秒返回 `PONG`）**今天不复现**。
> 最可能的原因是本机没有独立的 Anthropic 登录（`~/.claude.json` 里 `oauthAccount` 不存在，
> 认证由宿主进程以 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` 代管），剥掉变量后就既没有 key 也没有网关。
> **「claude -p 能不能用」不是一个是非题，是「在什么认证状态下能用」。** 今天的状态是：不能。

**事实：`api.anthropic.com` 从本机直连被挡在 403，「请求不被允许」。**
证据等级：T2
```
curl -s https://api.anthropic.com/v1/messages -H 'content-type: application/json' \
  -d '{"model":"x","max_tokens":1,"messages":[]}'
# → {"error":{"type":"forbidden","message":"Request not allowed"}}
```
最后验证时间：2026-11-12

**事实：MSIX 影子目录仍然存在，但它的形态是「目录枚举被冻在 2026-10-31」，不是「写入被重定向」。**
证据等级：T3 + 反向对照（两个路径看同一目录对象，写入互相可见，但列目录结果不同）
```js
// node shadow.mjs —— 列两个路径 + 用非虚拟化子进程复验
import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const LA = process.env.LOCALAPPDATA;
const REAL   = path.join(LA, 'Overwatch');
const SHADOW = path.join(LA, 'Packages', 'AnthropicPBC.Claude_fnn82j28hfe8t', 'LocalCache', 'Local', 'Overwatch');
const list = (d) => { try { return fs.readdirSync(d).sort(); } catch (e) { return ['ERR:' + e.code]; } };

const r = list(REAL), s = list(SHADOW);
console.log('真实', r.length, '项:', r.join(','));
console.log('影子', s.length, '项:', s.join(','));
console.log('只在真实路径里:', r.filter((x) => !s.includes(x)));

// 写入互通：往真实路径写一个新文件，看影子路径能不能看到
const n = 'probe-' + Date.now() + '.txt';
fs.writeFileSync(path.join(REAL, n), 'X');
console.log('写入真实路径', n, '→ 影子路径能看到:', fs.existsSync(path.join(SHADOW, n)));
try { fs.unlinkSync(path.join(REAL, n)); } catch {}

// 非虚拟化子进程复验（PowerShell 由 Node spawn，不带会话的虚拟化上下文）
const ps = (c) => (spawnSync('powershell', ['-NoProfile', '-Command', c], { encoding: 'utf8' }).stdout || '').trim();
console.log('非虚拟化子进程看到的真实路径项数:', ps(`(Get-ChildItem -LiteralPath '${REAL}').Count`));
console.log('非虚拟化子进程看到的影子路径项数:', ps(`(Get-ChildItem -LiteralPath '${SHADOW}').Count`));
```
实测结果（2026-11-12）：
```
真实路径 %LOCALAPPDATA%\Overwatch                        → 11 项（含 state.json / owner.json / 2 个轮转日志）
影子路径 %LOCALAPPDATA%\Packages\AnthropicPBC.Claude_...\LocalCache\Local\Overwatch → 7 项
只存在于真实路径的 4 项：owner.json, state.json, watch.2026-11-11T….log, watch.2026-11-12T….log
```
- 两个路径的 `fsutil file queryfileid` **返回同一个文件 ID**（`0x…18e14`）。
- 往影子路径写一个新文件，**真实路径立刻能看到**；反之亦然；同名文件互相覆盖，最后写的生效。
- 用 WMI/`Start-Process` 起的**非虚拟化子进程**看到的条目数与主进程一致（11 与 7）。
- 那 4 个缺失的文件**全部是 2026-10-31 之后才产生的**。
最后验证时间：2026-11-12

> **这条更正了上一次的结论。** `2026-11-04-watcher-silent-failure.md` 的诊断是
> 「Claude 会话里的进程读 `%LOCALAPPDATA%` 会被重定向到影子目录」。今天实测：**不会。**
> 今天在会话里读 `%LOCALAPPDATA%\Overwatch\state.json` 读到的是**活的**（mtime 每 15 秒更新）。
> 仍然成立的只有一半：**影子目录确实存在，且它的目录枚举是一份冻在 10-31 的旧快照**。
> 所以「先问你看的是哪个目录」这条教训依然对，但它防的是**列目录看到旧快照**，不是**写到错地方**。

**事实：守护进程活着，但它的日志已经 4 小时没长过了，而且最新一份日志恰好停在轮转阈值下沿。**
证据等级：T3（state.json 的 mtime 与内容都在变；日志文件 mtime 不动）· **根因未查明，但有一个强线索**
```js
// node liveness.mjs —— 每 8 秒读一次 state.json 与日志 mtime，然后把所有 watch*.log 的大小列出来
import fs from 'node:fs'; import path from 'node:path';
const d = path.join(process.env.LOCALAPPDATA, 'Overwatch');
const st = (p) => { try { return fs.statSync(p); } catch { return null; } };

for (let i = 0; i < 4; i++) {
  const s = st(path.join(d, 'state.json'));
  const j = JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'));
  console.log(`t${i}: state.json mtime=${s.mtime.toISOString()}  lastJobsScanAt=${j.lastJobsScanAt}`);
  await new Promise((r) => setTimeout(r, 8000));
}
for (const f of fs.readdirSync(d).filter((x) => x.startsWith('watch'))) {
  const s = st(path.join(d, f));
  console.log(f.padEnd(44), String(s.size).padStart(9), s.mtime.toISOString());
}
console.log('LOG_MAX_BYTES =', 1024 * 1024);   // 对照：日志是不是卡在阈值下沿
```
实测结果（2026-11-12）：
- `state.json` mtime 每 15 秒刷新一次，`lastJobsScanAt` 与当前时间差 < 20 秒 → **进程在跑**。
- `watch.log` 停在 2026-10-31 19:23:13，**41,857 字节，且尾部是 NUL 填零**（`validDataLength < size` 的老症状）。
- 最新轮转日志 `watch.2026-11-12T06-58-03-383Z.log` 停在 **06:55:55**，距今约 **4 小时**。
- 上一份 `watch.2026-11-11T17-52-33-329Z.log` 停在 11-11 17:51:21，也是 **1,048,517 字节**。
- 进程 `node scripts\watch.mjs`（PID 25456）从 11-11 20:33 起一直活着，累计 CPU 5,277 秒。
- `watch.log` **没有被独占锁**（能正常以 append 打开），也不是权限问题（同目录 state.json 在写）。
- 日志里**没有** `log-write-failed` 记录。

> **强线索**：`LOG_MAX_BYTES = 1024 * 1024 = 1,048,576`（`scripts/watch.mjs:71`）。
> 两份轮转日志的大小分别是 **1,048,517** 与 **1,048,522**——都只差 54–59 字节就到阈值。
> 也就是说，**日志恰好在「下一次写入就要触发轮转」的位置停住了**。
> 最可能的机制是：`rotateIfNeeded()` 的 `renameSync` 在目标文件仍被另一个进程（或本进程的旧句柄）持有时抛异常，
> 被内层 `catch {}` 吞掉，然后 `appendFileSync` 继续往那份「已经不该再写」的文件里写——
> 或者轮转成功了但新文件名的时间戳与某份旧文件冲突。
> **这是推断，不是实测。** 要证实需要 attach 到 PID 25456 看句柄，或做一次可控的轮转复现（见 §3.3）。
最后验证时间：2026-11-12 · **为什么日志停了，我没有查明**

> 这条不推翻「守护进程活着」（那条是对的），但补上一个新问题：
> **活着 ≠ 在留下可查的记录。** `watch.mjs --health` 读的是 state.json，所以它说「运行中」是真的；
> 但它不会告诉你日志已经静默了半天。

---

## 第二部分：已被推翻的结论

### 2.1 「15/24 是假报告」

- **曾经的结论**：15 个会话声称测试通过但实际没跑（`2026-11-02-redteam-deterministic.md`）。
- **为什么错**：测试命令正则写的是 `mvn\s+`，匹配不到本机实际用的 `mvn.cmd`；4 个真跑了测试的被算成「无调用」。
  另外 15/24 的分母口径在两份文档里不一致。
- **现在的正确说法**：全量 228 会话里 `NO_EVIDENCE` 只有 **1 条**（`2026-11-03-verify-claims.md`）。
  今天语料长到 349、断言识别族增加到 8 个，`NO_EVIDENCE` 是 49 条，但其中 **46 条来自测试沙盒**（见 §1.2）。
- **线索**：`docs/research/2026-11-03-verify-claims.md`；`docs/research/README.md`「已被推翻的结论」第 4 行。

### 2.2 「`claude -p` 不能用」

- **曾经的结论**：`claude -p` 静默失败，exit 0 + 空 stdout，3/3（`2026-11-11-build-own-framework-viability.md`）。
- **为什么错**：「不能用」是**结论**，但它其实是**一个环境状态**。反过来，P12 又测出「剥掉 4 个宿主变量后 39.3 秒成功」。
  两个结论都只对了一半，谁也没说「在什么认证状态下」。
- **现在的正确说法**：**今天在本机，两种剥法都失败**——保留变量报 `Not logged in`，全剥会挂起（>400 秒无输出），
  只剥认证保留 `ANTHROPIC_BASE_URL` 报「网关缺少 Authorization 头」。见 §1.5。
  所以准确的表述是：**`claude -p` 的可用性取决于宿主的认证代理是否在场，退出码不携带这个信息。**
- **线索**：`docs/research/README.md`「互相矛盾的地方」第 2 行；本文件 §1.5。

### 2.3 「`claude-agent-acp@0.104.1` 版本不存在」

- **曾经的结论**：审计报告称该版本在 npm 上不存在（`2026-11-13-consistency-audit.md` 🟡#22）。
- **为什么错**：**查错了包**。包名有两个，审计查的是无 scope 的那个。
- **现在的正确说法**：scoped 的 `@agentclientprotocol/claude-agent-acp` 有 0.104.1，最新 0.106.0；
  无 scope 的 `claude-agent-acp` 最高 0.100.3。见 §1.4。
  但「Windows 上全部正常」仍然不成立——`acpx claude exec` 卡在 `session/prompt` 的 `Authentication required`。
- **线索**：`docs/research/README.md`「已被推翻的结论」最后一行。

### 2.4 「`NO_EVIDENCE` 37 条是用户痛点」

- **曾经的结论**：全量 332 会话发现 37 条 `NO_EVIDENCE`，可作为「Stop hook 验证闸」的需求证据。
- **为什么错**：**94% 来自我们自己造的测试靶场**。锐评 Agent 复算：真实语料只有 3 条，其中 2 条是同一份 transcript 的副本。
- **现在的正确说法**：**按断言 46 : 3，按会话 45 : 3；扣掉重复落盘，真实独立的只有 2 条。**
  见 §1.2 的逐条复算。**用自己造的数据证明自己的需求，是本轮最严重的方法论错误。**
- **线索**：`docs/research/2026-11-13-critique-stop-hook-product.md` §1.2(a)；
  本文件 §1.2（我独立复算，口径与它略有差异但结论一致）。

### 2.5 「守护进程死了 7.75 天」

- **曾经的结论**：`watch.log` 停在 10-31、`state.json` 3406 字节全 NUL、`runner.log` 停在 11-01 → 守护进程死了 7.75 天。
- **为什么错**：看到的是一份 **MSIX 影子目录**里的冻结快照（`2026-11-04-watcher-silent-failure.md`）。
  真实目录里 `state.json` 每 15 秒更新，`watch.log` 有 60 万字节、4735+ 行 tick。
- **现在的正确说法**：**守护进程当时就活着，现在也活着**（PID 25456，11-11 20:33 起，累计 CPU 5,277 秒）。
  但**上一份报告的机制解释今天不复现**：会话内读 `%LOCALAPPDATA%` **不再**被重定向到影子目录，读到的就是活的。
  见 §1.5——影子目录还在，但它是「枚举被冻住的旧快照」，写入是通的。
  **并且今天有一个新的、独立的异常：日志从 06:58 起不再增长，原因未查明。**
- **线索**：`docs/research/2026-11-04-watcher-silent-failure.md`；`docs/research/README.md`「最该读的」第 1 条；
  本文件 §1.5（两条，一条确认活着，一条是新异常）。

### 2.6 「hooks 只有 8 个事件」/「`exit 2` 与 `decision:block` 等价」

- **曾经的结论**：`2026-11-04-external-harness-protocols.md` 说 hooks 共 8 个事件；
  `2026-11-11-untapped-capabilities.md` 说 `exit 2` 与 `{"decision":"block"}` 效果等价。
- **为什么错**：前者从二进制里读出的是 **33 个事件、5 种处理器类型**；
  后者在 2.1.289 与 2.1.308 上各测一次，`exit 2` 被记成 `Failed with non-blocking status code`，回合照常结束。
- **现在的正确说法**：hooks 有 33 个事件；**只有 `{"decision":"block"}` 能拦**。
  今天我用真实 hook 二进制复验了拦截路径（§1.4），`decision:block` 有效。
- **线索**：`docs/research/README.md`「已被推翻的结论」第 9/10 行。

### 2.7 「同时开 10+ 个会话是常态」

- **曾经的结论**：产品画像假设用户同时开 10 个以上会话。
- **为什么错**：按 gap>5min 切活跃段重建并发曲线，**87% 墙钟零活跃**；≥5 个只占 4.7%（`2026-11-11-blind-spots.md`）。
- **现在的正确说法**：**86.7%**（我今天独立重算，见 §1.3）。「10+ 是常态」在这台机器上是假画像。
- **线索**：`docs/research/2026-11-11-blind-spots.md`；本文件 §1.3。

---

## 第三部分：未验证的假设

### 3.1 断言判定的分族精度

- **假设**：`verify-claims` 对每一族断言（`test-count` / `build` / `vague-completion` …）的判准率都够做闸门。
- **为什么重要**：Stop hook 拦不拦、TUI 标不标「声明对不上」，全押在这个精度上。
  已知总精度 84.6%，但那是 **n=13 的人工抽检**，且没分族。
- **怎么验证**：随机抽 60 条断言 / 每族 ≥10 条，人工标注真值（标注在看到判定结果之前），算每族精度与置信下界。
  按 `2026-11-02-autorelay-acceptance.md` §1.3，声称 0.90 需要 n≥30 且 0 错误。
- **当前证据**：**无。** 只有一条 n=13 的总体精度，`docs/research/2026-11-11-blind-spots.md` §6 自己把这列为「最重要的缺口」。

### 3.2 通知抑制的真实准确率

- **假设**：现在只在真需要时才发通知。
- **为什么重要**：这是产品唯一的打扰面。误报一次，用户就关通知。
- **怎么验证**：需要人工标注「这条该不该发」的基准集；或做 A/B（一组开通知、一组只记账），比较用户响应时间。
- **当前证据**：**仅文档。** 已知两个口径（按状态翻转 12%、按实际发出的通知 77.8%），都对但分母不同。
  仓库自己承认「无自动测量手段」（README「已知局限」）。

### 3.3 「日志停在轮转阈值下沿」的根因

- **假设**：`createLogger` 的轮转路径在 `renameSync` 失败时静默吞掉异常，之后继续往旧文件 append；
  或轮转产生的新文件名与已存在文件冲突，导致「转了但没转成」。
- **为什么重要**：如果日志不再写，所有基于日志的排查（`--trace`、通知可追溯率、tick 健康度、`already=` 计数）
  都会读到旧数据而不自知。`watch.mjs --health` 读 state.json，**不会发现这个问题**。
- **怎么验证**：①`handle.exe` / Process Explorer 看 PID 25456 持有的文件句柄指向哪个路径；
  ②可控复现：把 `LOG_MAX_BYTES` 调到 1KB，连续写日志看轮转是否每次都成功、失败时留下什么。
- **当前证据**：**有强线索，无根因。** 两份轮转日志分别停在 1,048,517 / 1,048,522 字节，
  距阈值 1,048,576 只差 54–59 字节。这不像巧合。
  已排除：独占锁（能 append 打开）、权限（同目录在写）、日志里无 `log-write-failed`。

### 3.4 「多模型兼容」

- **假设**：判定逻辑在非 Claude 模型下同样成立。
- **为什么重要**：本机实际路由到 `SCNet-Max` / `deepseek-v4.1-flash`，不是 Claude。
- **怎么验证**：需要一个能在闸门层观测到的、稳定的多模型入口，并对同一批断言做 A/B。
- **当前证据**：**仅文档。** `2026-11-13-claim-detection-fixes-and-multimodel.md` 的结论是「在当前环境无法在闸门层验证」，
  这本身是个诚实的结论，不是验证。

### 3.5 「agent 角色定义能提升结果」

- **假设**：`.claude/agents/` 里那 12 份角色定义能让任务做得更好。
- **为什么重要**：这是仓库「多 Agent 对抗」整套方法论的地基。
- **怎么验证**：同一批任务，有/无角色定义各跑一遍，比较验收通过率。样本需 ≥30 对。
- **当前证据**：**反向证据更强。** README 自己引 MAST 论文（1600+ 轨迹）：改角色规格、增强协调两种干预「效果不充分」。
  `2026-11-10-agent-roles-audit.md` 另发现**无一份角色定义含 `Agent` 工具**，4 个角色缺 `Bash` 却要求跑命令。

---

## 第四部分：明确的未知

**问题：这台机器上「一次典型的 AI 使用」长什么样？**
- 为什么现在答不了：所有统计都是**行为痕迹反推**，没有一次用户访谈、没有 A/B、没有可用性测试。n=1 用户、1 台机器、约 5 个月。
- 需要什么才能答：至少一名真实用户的自述 + 一次对照实验。

**问题：`SCNet-Max` 到底是什么模型、上下文窗口多大、与 Claude 差多少？**
- 为什么现在答不了：网关只透传模型名，不返回模型元信息；`/v1/models` 里的 2 个和实际路由的不是同一批。
- 需要什么才能答：网关 provider 配置的明文（在 cc-switch 的 SQLite 库里），或上游的模型卡。

**问题：通知在真实等待场景下的召回率是多少？**
- 为什么现在答不了：没有「本该通知但没通知」的基准——那需要知道每一刻用户是否真的该被打扰。
- 需要什么才能答：人工逐条标注一段连续时间的全部候选事件，且标注者不看通知结果。

**问题：日志为什么静默（§3.3）？**
- 为什么现在答不了：需要 attach 到活着的进程看文件句柄；本轮只做了外部观测。
- 需要什么才能答：`handle.exe` / Process Explorer 对 PID 25456 的句柄快照，或一次可复现的轮转实验。

**问题：`claude -p` 在「有独立 Anthropic 登录」的机器上能不能用？**
- 为什么现在答不了：本机是宿主代管认证（`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`，无 `oauthAccount`），
  无法在本机制造出「独立登录」这个前提。
- 需要什么才能答：另一台做过 `/login` 的机器，或在本机显式登录后再跑一次 P12 配方。

**问题：`%LOCALAPPDATA%` 影子目录的成因与物化时刻。**
- 为什么现在答不了：能观测到现象（同一文件 ID、不同枚举结果），但拿不到重定向层的内核记录。
  `2026-11-04-watcher-silent-failure.md` 自己也承认「物化时刻我没有独立证据」。
- 需要什么才能答：Procmon 对目录访问的跟踪，或在影子目录上做一次能改变枚举结果的写入实验（风险：可能污染现场）。

---

## 附：复跑说明

**正文里凡是用代码块的复跑命令，都是自包含的**——直接复制、存成一个 `.mjs` 放仓库根目录跑即可，
只依赖仓库已有的 `scripts/*.mjs` 导出函数，不依赖任何一次性探针。这样即使临时文件被清理，命令仍然可复跑。

本轮我为了快速迭代，另在 `.tmp-analysis/`（已 gitignore）写了一批判定逻辑的固定版本；
**它们不是产品代码，也不是复跑的前提**——正文的代码块才是。

**本轮我实际跑了什么、没跑什么：**

| 跑了 | 规模 |
|---|---|
| 全量回归测试 | 873 条，2 次（开写时、收尾时） |
| 结构硬门 | 4 次（含最后一次改文档后） |
| `verify-claims` 全量 | 3 次 `--json`（语料 349→360，两次拆分一致） |
| `measure-interventions` | `--days 7` 与 `--days 0` 各 1 次 |
| 并发曲线重建 | 353 transcript / 62 万条记录 |
| 介入的写前/写后位置 | 4 种口径各 1 次 |
| Stop hook 真跑 | off / block 各 1 次 + 截断 T4 对照 1 次 |
| `claude mcp serve` | `tools/list` + 1 次 `tools/call` |
| ACP | opencode 1 次，claude 1 次 |
| `claude -p` | 3 种变量组合，共 5 次（含 2 次超时） |
| 网关探测 | `/v1/models`、`/v1/messages`、`/v1/chat/completions`、假模型名 |
| 模型分布 | 136 份 transcript 全量 |
| MSIX 影子目录 | 6 组实验 + 非虚拟化子进程对照 |

**没跑**：用户访谈、A/B、GPU/锁屏相关实验、跨机器复现、`claude agents` 的写操作（只做了只读 `--json`）。
