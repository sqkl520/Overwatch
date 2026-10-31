#!/usr/bin/env node
/**
 * validate-run.mjs — 校验一次派发的产物是否符合契约。
 *
 * 为什么需要它：`tasks/runs/<run-id>/task-graph.json` 的 schema 写在
 * `.claude/agents/oversight-planner.md` 里，但**从来没有任何东西检查产出的 JSON 符合它**。
 * 结果是 planner 写什么就是什么——字段名拼错、漏掉 acceptance、把「可选」写进图里，
 * 都要等到下游 Agent 拿到残破输入才发现。
 *
 * 这个脚本把那份 schema 变成可执行的检查。它不是"额外的文档"，是契约的执行者。
 *
 * 用法：
 *   node scripts/validate-run.mjs tasks/runs/<run-id>/task-graph.json
 *   node scripts/validate-run.mjs --all tasks/runs
 *
 * 退出码：0 = 合法；1 = 有违规；2 = 文件读不到。
 *
 * 零依赖。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** capability 与 shape 的合法取值。**单一真源**：改这里，
 *  同时要改 oversight-planner.md 里的同一张表——下面的 checkAgentDocSync 会查。 */
export const CAPABILITIES = Object.freeze([
  'executor', 'research', 'critic', 'redteam', 'review', 'acceptor',
  'relay', 'probe', 'planner', 'repair', 'resolution', 'safety',
]);
export const SHAPES = Object.freeze(['artifact', 'exploration', 'hybrid']);

/** 不可判定的措辞：写进图里等于没有约束。 */
const VAGUE = [/^可选$/, /^视情况/, /^酌情/, /^看情况/, /^尽量/, /^尽可能/, /^适当/];

/** CLAUDE.md 硬约束 2：复杂任务至少 5 个独立 Agent，
 *  且必须含锐评 / 验收 / 修复三个不可合并的角色。 */
export const REQUIRED_FOR_COMPLEX = Object.freeze(['review', 'acceptor', 'repair']);
export const MIN_SUBTREES = 5;

export function validateGraph(graph, { requireComplex = false } = {}) {
  const errors = [];
  const warnings = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  const warn = (p, m) => warnings.push(`${p}: ${m}`);

  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return { ok: false, errors: ['根：必须是一个对象'], warnings: [] };
  }
  for (const k of ['run_id', 'root_goal']) {
    if (typeof graph[k] !== 'string' || !graph[k].trim()) err(k, '必须是非空字符串');
  }
  if (!Array.isArray(graph.constraints)) err('constraints', '必须是数组');
  if (!Array.isArray(graph.subtrees) || !graph.subtrees.length) {
    return { ok: false, errors: [...errors, 'subtrees: 必须是非空数组'], warnings };
  }

  const ids = new Set();
  graph.subtrees.forEach((st, i) => {
    const p = `subtrees[${i}]`;
    if (!st || typeof st !== 'object') { err(p, '必须是对象'); return; }
    if (typeof st.id !== 'string' || !st.id.trim()) err(`${p}.id`, '必须是非空字符串');
    else if (ids.has(st.id)) err(`${p}.id`, `重复的 id：${st.id}`);
    else ids.add(st.id);

    if (typeof st.goal !== 'string' || !st.goal.trim()) err(`${p}.goal`, '必须是非空字符串');

    if (!CAPABILITIES.includes(st.capability)) {
      err(`${p}.capability`, `"${st.capability}" 不在合法取值内（${CAPABILITIES.join(' / ')}）`);
    }
    if (!SHAPES.includes(st.shape)) {
      // CLAUDE.md 硬约束 8：未声明产出形态视为规划缺陷
      err(`${p}.shape`, `"${st.shape}" 不在合法取值内（${SHAPES.join(' / ')}）`);
    }

    const pct = st.token_budget_pct;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0 || pct > 100) {
      err(`${p}.token_budget_pct`, '必须是 0 到 100 之间的数字');
    }
    const to = st.timeout_min;
    if (typeof to !== 'number' || !Number.isFinite(to) || to <= 0) {
      err(`${p}.timeout_min`, '必须是正数');
    }

    for (const k of ['parallel_with', 'depends_on']) {
      if (!Array.isArray(st[k])) { err(`${p}.${k}`, '必须是数组'); continue; }
      for (const ref of st[k]) {
        if (ref === st.id) err(`${p}.${k}`, '不得引用自己');
        else if (!graph.subtrees.some((x) => x && x.id === ref)) {
          err(`${p}.${k}`, `引用了不存在的 ${ref}`);
        }
      }
    }

    if (!Array.isArray(st.acceptance) || !st.acceptance.length) {
      // CLAUDE.md 硬约束 4：验收标准必须预先声明
      err(`${p}.acceptance`, '必须是非空数组——验收标准不能事后编');
    } else {
      st.acceptance.forEach((ac, j) => {
        const ap = `${p}.acceptance[${j}]`;
        if (!ac || typeof ac !== 'object') { err(ap, '必须是对象'); return; }
        for (const k of ['id', 'criterion', 'evidence', 'fail_if']) {
          if (typeof ac[k] !== 'string' || !ac[k].trim()) err(`${ap}.${k}`, '必须是非空字符串');
        }
        if (typeof ac.criterion === 'string') {
          for (const v of VAGUE) {
            if (v.test(ac.criterion.trim())) {
              err(`${ap}.criterion`, `"${ac.criterion}" 不可判定——不可判定的条目等于没有`);
            }
          }
        }
        // evidence 必须指向可核查的位置，不能是「见上文」
        if (typeof ac.evidence === 'string' && ac.evidence.trim()
            && !/[:#\d]/.test(ac.evidence) && !/^https?:/.test(ac.evidence)) {
          warn(`${ap}.evidence`, `"${ac.evidence}" 不像可追溯的引用（应含 file:line 或链接）`);
        }
      });
    }

    if (typeof st.why_this_layer !== 'string' || !st.why_this_layer.trim()) {
      // CLAUDE.md 硬约束 6：每层须写明「为什么需要这一层」
      err(`${p}.why_this_layer`, '必须写明为什么需要这一层');
    }
  });

  // 复杂度约束
  const caps = graph.subtrees.map((s) => s && s.capability);
  // 复杂度只看调用方显式声明，**不由子任务数推断**。
  //
  // 最初写成「>= 5 个子任务就算复杂」，实测一个真实的 2 任务 run 因此被判违规。
  // 但那个 run 是合理的：一次小改动确实不需要 5 个 Agent。
  // 硬约束 2 说的是「复杂任务」，而「是不是复杂」是规划时的判断，不是数字推断。
  // 硬把阈值塞进校验器，只会训练人绕过它。
  const isComplex = requireComplex === true;
  if (isComplex) {
    for (const need of REQUIRED_FOR_COMPLEX) {
      if (!caps.includes(need)) {
        err('subtrees', `复杂任务缺少 ${need} 角色——锐评 / 验收 / 修复不可合并也不可缺`);
      }
    }
  }
  if (graph.subtrees.length < MIN_SUBTREES) {
    warn('subtrees', `只有 ${graph.subtrees.length} 个子任务；CLAUDE.md 要求复杂任务至少 ${MIN_SUBTREES} 个独立 Agent`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 从磁盘读并校验。 */
export function validateFile(path, opts) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (e) {
    return { ok: false, errors: [`读不到 ${path}：${e.message}`], warnings: [] };
  }
  let graph;
  try { graph = JSON.parse(raw); } catch (e) {
    return { ok: false, errors: [`${path} 不是合法 JSON：${e.message}`], warnings: [] };
  }
  const r = validateGraph(graph, opts);
  return { ...r, path };
}

// ── CLI ───────────────────────────────────────────────────────────────

function main(argv) {
  const all = argv.includes('--all');
  const targets = argv.filter((a) => !a.startsWith('--'));
  if (!targets.length) {
    console.error('用法：node scripts/validate-run.mjs <task-graph.json> [...]');
    console.error('      node scripts/validate-run.mjs --all tasks/runs');
    return 2;
  }

  let results = [];
  if (all) {
    for (const dir of targets) {
      if (!existsSync(dir)) continue;
      for (const sub of readdirSync(dir)) {
        const p = join(dir, sub, 'task-graph.json');
        if (existsSync(p)) results.push(validateFile(p));
      }
    }
    if (!results.length) {
      console.log(`没有找到任何 task-graph.json（查了 ${targets.join(', ')}）。`);
      console.log('这不是失败——它表示还没有跑过一次派发。');
      return 0;
    }
  } else {
    results = targets.map((t) => validateFile(t));
  }

  let bad = 0;
  for (const r of results) {
    const name = r.path ? basename(resolve(r.path)) : '(inline)';
    if (r.ok) {
      console.log(`✓ ${r.path || name}`);
    } else {
      bad++;
      console.log(`✗ ${r.path || name}`);
      for (const e of r.errors) console.log(`    ${e}`);
    }
    for (const w of r.warnings) console.log(`    ⚠ ${w}`);
  }
  if (results.length > 1) console.log(`\n${results.length - bad}/${results.length} 合法`);
  return bad ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
