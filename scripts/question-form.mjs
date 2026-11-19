#!/usr/bin/env node
/**
 * question-form.mjs — 「一次提问的参数长什么样」的唯一解析处。零依赖、无副作用。
 *
 * **为什么单独一个文件**（2026-11-19）：这两个函数原先住在 `question-audit.mjs` 里，
 * 而写前闸（`pre-write-gate.mjs`）现在也要数「问过几个问题」。如果闸门直接
 * `import './question-audit.mjs'`，就形成环：
 *
 *   pre-write-gate → question-audit → pre-write-gate                （直接环）
 *                  → question-audit → observe-reality-check → pre-write-gate
 *
 * 而 `observe-reality-check.mjs` 在**模块顶层**就写
 * `export const GATE_READ_VERBS = GATE_SHELL_READ_VERBS;` —— 环一旦存在，
 * 那一行会在 `pre-write-gate` 还没求值到 `GATE_SHELL_READ_VERBS` 时执行，
 * 于是 `import` 直接 TDZ ReferenceError（不是静默降级，是整条链路起不来）。
 *
 * 所以判据被**搬**到这里，而不是抄第二份：本仓库立过「判据只能有一份」的规矩
 * （`observe-reality-check.mjs` 曾复制一份动词表，改一边不生效）。
 * `question-audit.mjs` 仍然导出同名的两个函数（转出口），它的测试与调用方一行不用改。
 *
 * ── 两个实测教训（原样搬过来，不要丢）──────────────────────────────
 *
 *   ① **`input.questions` 不总是数组**。实测 197 次去重调用里 **6 次是 JSON 字符串**，
 *      而这 6 条字符串**全部 JSON.parse 失败**（模型把引号写坏了）。
 *      把它们当「问了 0 件事」是错的，当「问了 1 件」也错。所以返回的是**形态**，
 *      由调用方决定「不知道」怎么处理。
 *   ② **`tool_use` 行会被宿主重写**（同一 id 两行：一行带 timestamp、一行不带；
 *      实测全语料 33,090 行）。**按 id 去重**是调用方的责任，不在本文件里做 ——
 *      本文件只解析**一次**调用的参数。
 */

/** 一次 `AskUserQuestion` 的 `questions` 字段有三种实测形态：数组、JSON 字符串、
 *  坏掉的 JSON 字符串。**返回形态，不猜内容**。
 *
 *  实测（257 个有工具调用的会话 / 197 次去重调用）：
 *    array 191、unparsable-string 6、absent 0
 *  6 条坏 JSON 全部来自「选项里带 `preview` 多行文本」的调用，模型把引号写坏了。
 *  它们的问题数是**不知道**，不是 0。 */
export function questionsOfAsk(input) {
  const qs = input && typeof input === 'object' ? input.questions : undefined;
  if (Array.isArray(qs)) {
    const out = qs
      .filter((q) => q && typeof q === 'object')
      .map((q) => ({
        question: typeof q.question === 'string' ? q.question : '',
        header: typeof q.header === 'string' ? q.header : '',
        multiSelect: q.multiSelect === true,
        options: Array.isArray(q.options)
          ? q.options.map((o) => (o && typeof o.label === 'string' ? o.label : '')).filter(Boolean)
          : [],
      }))
      .filter((q) => q.question);
    return { questions: out, form: 'array', unknown: false };
  }
  if (typeof qs === 'string') {
    try {
      const parsed = JSON.parse(qs);
      if (Array.isArray(parsed)) {
        // 字符串形态但能解析：等价于数组形态，只是宿主/模型多绕了一层编码。
        const out = parsed
          .filter((q) => q && typeof q === 'object')
          .map((q) => ({
            question: typeof q.question === 'string' ? q.question : '',
            header: typeof q.header === 'string' ? q.header : '',
            multiSelect: q.multiSelect === true,
            options: Array.isArray(q.options)
              ? q.options.map((o) => (o && typeof o.label === 'string' ? o.label : '')).filter(Boolean)
              : [],
          }))
          .filter((q) => q.question);
        return { questions: out, form: 'json-string', unknown: false };
      }
    } catch { /* 落到 unknown */ }
    return { questions: [], form: 'unparsable-string', unknown: true };
  }
  if (qs === undefined || qs === null) return { questions: [], form: 'absent', unknown: true };
  return { questions: [], form: 'other', form_raw: typeof qs, unknown: true };
}

/** 归一化问题文本：去空白、去标点、小写。
 *  与 `classify-stop.mjs` 的 bigram 归一化同一口径（去标点后再比），
 *  但不复用它的 `bigrams()`——那会多导出一个只在这里用的函数。
 *
 *  写前闸用它做「同一个问题问两遍只算一个」的比较键：归一化后逐字相等才算重复。
 *  用字面相等而不是相似度，是因为闸门要判的是**能不能放行**，误判方向必须明确：
 *  这里宁可把「换了个说法的同一个问题」算成两个（宽松），也不要用阈值把
 *  两个真不同的问题折成一个（那会变成拦一个已经按规矩做了的会话）。 */
export function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s，。、；：！？,.;:!?"'“”‘’（）()[\]{}<>《》〈〉—\-_/\\|~`·…]+/g, '');
}
