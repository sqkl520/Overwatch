#!/usr/bin/env node
/**
 * measure-interventions.mjs — 「人工介入次数」的测量器。
 *
 * 为什么存在：本项目唯一的成败判据是「人工介入次数变少」。
 * 没有基线，任何改进都无法被证伪。本脚本产出这个基线，且只读、不改任何文件。
 *
 * 核心难点不是数数，是**分母**和**误判**：
 *   - 用户每轮正常对话不算介入，否则「介入数」只是「对话轮数」的同义词。
 *   - 宿主自己写进 transcript 的合成记录（task-notification、命令回显、
 *     system-reminder）不是用户发的，必须排除，否则会凭空多出几千次「介入」。
 *
 * 判据全部来自实测，见 docs/research/2026-11-11-intervention-baseline.md。
 *
 * 用法：
 *   node scripts/measure-interventions.mjs                # 默认 30 天窗口
 *   node scripts/measure-interventions.mjs --days 7
 *   node scripts/measure-interventions.mjs --json
 *   node scripts/measure-interventions.mjs --root <dir>   # 指定 transcript 根
 *
 * 退出码：0 = 正常；2 = 找不到 transcript 根目录。
 */

import { openSync, readSync, closeSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

// ── 常量 ──────────────────────────────────────────────────────────────

/** 物理分块大小。1MB：实测 117MB transcript 全量扫描 1.2s（整文件读入需 1.4s 且峰值内存 300MB+）。 */
const CHUNK = 1 << 20;

/** 只有这些类型的记录会影响判定，其余直接跳过 JSON.parse。
 *  实测：全量 28k 行里只需解析 3.9k 行，省 65% 的解析开销。 */
const RELEVANT = ['"type":"user"', '"type":"assistant"', '"type":"queue-operation"'];

/** 宿主注入的合成消息前缀。这些出现在 message.content 里，但**不是用户打的字**。
 *
 *  实测依据（全量 260 个 transcript）：
 *    - task-notification 7129 条（后台任务完成回执）
 *    - command-name / local-command-stdout 423 条（斜杠命令回显）
 *    - ide_opened_file 67 条、system-reminder 10 条
 *  不排除的话，「介入」会被这些噪声淹没 3 倍以上。
 */
const SYNTHETIC_PREFIX = /^\s*<(task-notification|command-name|command-message|command-args|local-command-stdout|local-command-caveat|system-reminder|ide_opened_file|ide_selection|system_warning|parameter|create-pr-command|agent-message)\b/;

/** 上下文压缩后的续接提示。这是宿主写的，不是用户介入。 */
const CONTINUATION = 'This session is being continued from a previous conversation';

/** 打断标记。**有两种变体，实测都出现**：
 *    `[Request interrupted by user]`             195 次
 *    `[Request interrupted by user for tool use]`  20 次
 *  只匹配前者会让后 20 次漏进「插话」类（实测已发生 13 次误判）。 */
export const INTERRUPT_RE = /\[Request interrupted\b[^\]]*\]/;
export const INTERRUPT_MARKER = '[Request interrupted by user]';

/** 「催促」的判据：消息**以**推进词开头，且没有携带新的前提信息。
 *
 *  为什么不是「整条只有继续」：实测 80 次催促里 77 次是纯「继续」，
 *  剩下 3 次是「继续，并且检查agent状态」这类——用户仍是在推 AI 往前走，
 *  只是顺带交代了一件小事。按「整条等于继续」会把这 3 次漏进 P1。
 *  用长度上限兜住：超过这个长度就当作带了新需求。 */
const NUDGE = /^(继续|接着|接着做|继续做|继续吧|然后呢|go on|go ahead|continue|carry on|keep going)/i;
const NUDGE_MAX_LEN = 40;

/** 「重试」：命令失败后原样再发一次，属于环境/执行故障，不是新需求。 */
const RETRY = /^(try again|重试|再试一次|再试试|retry)[\s!！。.,，]*$/i;

/** 「纠正」的判据：含否定/回退语义。
 *  宁可少判不可多判——只认明显表层的词，不做语义猜测。
 *
 *  **长文档一律不看**。实测反例：一份 9361 字符的规格文档在第 1706 字符处含
 *  「退回 Planning Agent」，被误判成「用户纠正 AI」——那词描述的是文档内容，
 *  不是对 AI 的反馈。真实纠正消息都很短。 */
const CORRECTION = /(不对|不是这样|不是这个|搞错|弄错|错了|改回|退回|回滚|撤销|撤掉|别这样|不要这样|重新做|重做|不应该是|你搞|写反|反了|误解|理解错|说错|做错|撤回)/;

/** 超过这个长度视为「贴文档/贴日志」，不做纠正与催促判定。 */
export const MAX_CLASSIFY_LEN = 600;

/** 「答问」：AskUserQuestion 的 tool_result。宿主在结果里用固定句式。 */
const ASK_ANSWER = /Your questions have been answered|The user answered/;

// ── 逐行读取（限字节）───────────────────────────────────────────────

/**
 * 按块读文件、逐行回调。**永不把整个文件读进内存**。
 *
 * 用 StringDecoder 而不是 `buf.toString('utf8')`：后者在多字节字符跨块边界时
 * 会产生乱码字符（实测中文 transcript 上会把「继续」切成两半）。
 *
 * @param {string} path
 * @param {(line: string, byteOffset: number) => void} onLine
 */
export function eachLine(path, onLine) {
  const fd = openSync(path, 'r');
  const size = statSync(path).size;
  const buf = Buffer.allocUnsafe(CHUNK);
  const dec = new StringDecoder('utf8');
  let carry = '';
  let pos = 0;
  try {
    while (pos < size) {
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      const s = carry + dec.write(buf.subarray(0, n));
      let start = 0;
      let idx;
      while ((idx = s.indexOf('\n', start)) !== -1) {
        onLine(s.slice(start, idx), pos);
        start = idx + 1;
      }
      carry = s.slice(start);
    }
    carry += dec.end();
    if (carry) onLine(carry, pos);
  } finally {
    closeSync(fd);
  }
}

// ── 单条记录的抽取（纯函数，可测）──────────────────────────────────

/** 取一条 user 记录的可见文本；tool_result 记录返回 null（那是工具回执，不是人说的话）。 */
export function userText(record) {
  const c = record?.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return null;
  if (c.some((b) => b?.type === 'tool_result')) return null;
  return c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
}

/**
 * 判断一条 user 记录是不是「用户真的打了字」。
 *
 * 三道门，全部来自实测：
 *   1. 必须有可见文本（tool_result / image-only 不算）
 *   2. 不能是宿主合成的（SYNTHETIC_PREFIX）
 *   3. isMeta 的记录是宿主写的上下文，不是人打的
 *
 * 注意 `origin.kind` 不能作为必要条件：2.1.270 之前的版本不写这个字段，
 * 实测 380 条真实人类消息没有 origin。反过来，有 origin 且不是 human 的
 * （task-notification / peer）必须排除。
 *
 * @returns {string|null} 人类文本，或 null 表示「不是人类发言」
 */
export function humanTurnText(record) {
  if (!record || record.type !== 'user') return null;
  if (record.origin && record.origin.kind !== 'human') return null;
  if (record.isMeta) return null;
  const t = userText(record);
  if (t == null) return null;
  const trimmed = t.trim();
  if (!trimmed) return null;
  if (SYNTHETIC_PREFIX.test(trimmed)) return null;
  if (trimmed.startsWith(CONTINUATION)) return null;
  return t;
}

/** 该记录是否是打断标记。 */
export function isInterrupt(record) {
  const t = userText(record);
  return typeof t === 'string' && INTERRUPT_RE.test(t);
}

/**
 * 该 assistant 记录是否「主动停下来等用户」。
 *
 * stop_reason 语义（实测 260 个 transcript）：
 *   - `end_turn`      AI 说完了，正常交还控制权
 *   - `tool_use`      AI 还在干活
 *   - `stop_sequence` 实测 507 条全部是 API 错误/额度不足/模型不可用的兜底停——
 *                     这是失败，不是 AI 主动问。**不算介入。**
 *   - `max_tokens`    截断
 */
export function assistantStop(record) {
  if (!record || record.type !== 'assistant') return null;
  return record.message?.stop_reason ?? null;
}

/** 该 assistant 记录是否调用了 AskUserQuestion。 */
export function askedUser(record) {
  if (!record || record.type !== 'assistant') return false;
  const c = record.message?.content;
  if (!Array.isArray(c)) return false;
  return c.some((b) => b?.type === 'tool_use' && b.name === 'AskUserQuestion');
}

/** 该 tool_result 是否是 AskUserQuestion 的回答。 */
export function isAskAnswer(record) {
  if (!record || record.type !== 'user') return false;
  const c = record?.message?.content;
  if (!Array.isArray(c)) return false;
  for (const b of c) {
    if (b?.type !== 'tool_result') continue;
    const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
    if (ASK_ANSWER.test(txt) && !/tool_use_error/.test(txt)) return true;
  }
  return false;
}

// ── 分类（纯函数）──────────────────────────────────────────────────

/**
 * 把一次人类发言分类。**不做语义理解的猜测，只认表层判据。**
 *
 * 分类优先级（互斥）：
 *   nudge      整条消息只有推进语义 → 说明 AI 之前停了但活没干完
 *   correction 含否定/回退词 → 说明 AI 之前做错了
 *   normal     其余 → 新增需求/补充信息/开场请求，属于正常对话，不算介入
 *
 * 长度超过 MAX_CLASSIFY_LEN 的消息一律归 normal：那是贴文档/贴日志，
 * 里面出现的「不对」「退回」描述的是文档内容，不是对 AI 的反馈。
 *
 * @param {string} text
 * @returns {'nudge'|'correction'|'normal'}
 */
export function classifyHumanMessage(text) {
  const t = String(text ?? '').trim();
  if (t.length > MAX_CLASSIFY_LEN) return 'normal';
  // 纯重试不是「纠正」也不是「催促」，归环境故障（由 avoidabilityOf 判）
  if (RETRY.test(t)) return 'nudge';
  if (t.length <= NUDGE_MAX_LEN && NUDGE.test(t)) return 'nudge';
  if (CORRECTION.test(t)) return 'correction';
  return 'normal';
}

/**
 * 一次「AI 主动停止」是否依赖用户才能继续。
 *
 * 这里回答任务里的定义问题：「AI 停了 5 次等用户，算 5 次还是 1 次？」
 * 答案是 **5 次**。理由：每一停都是用户必须花注意力才能推进的一次阻塞，
 * 合并成一个「任务级」数字会把「一个长会话里被反复打断」的痛感抹平。
 * 但同时也输出「按会话」的数字，两种口径都给，由读者自己判断。
 */
export const COUNT_PER_STOP = true;

/**
 * 介入的「可避免性」分级——本测量的核心维度。
 *
 * 判据只看「这次介入发生时，AI 手上有没有本可以在开工前就问到的信息」，
 * 不看用户说了什么（那是主观猜测）。
 *
 *   P1  开工前可问清：需求/前提没定，AI 只能猜，猜错后用户纠正或补前提。
 *       → 唯一能被「开工前多问一句」系统性消除的类别。
 *   Q   已提问：AI 自己开口问了、用户作答。**这不是浪费，是提问机制正在生效**。
 *       它同时给出「提问通道的实际使用量」这个上限参考——
 *       每把一次 P1 提前问掉，就变成一次 Q。
 *   P2  过程信息缺口：AI 看不到用户眼前的界面/日志/真机表现，必须用户报案。
 *       → 无法靠「问」消除（开工时还不存在这个信息），只能靠更好的自检。
 *   P3  环境与执行故障：API 额度/模型不可用/命令格式错/被杀进程。
 *       → 与对话设计无关。
 *   P4  用户主动停手或误触：打断后没有再发指令或只说了「继续」。
 *       → 与 AI 行为无关。
 *   P5  推进信号：用户嫌慢、要求继续。
 *       → 反映的是节奏与信任，不是信息缺口。
 */
export const AVOIDABILITY = {
  P1: 'premise',       // 开工前可问清
  Q: 'asked',          // AI 已主动提问（机制生效中）
  P2: 'observation',   // 过程信息缺口（要用户看一眼）
  P3: 'environment',   // 环境/执行故障
  P4: 'user-stop',     // 用户主动停手/误触
  P5: 'pacing',        // 推进信号（嫌慢/催）
};

/** 用户报案的口吻：描述「我看到了什么」而不是「需求该是什么」。 */
const OBSERVATION_REPORT = /(我看|我测|试了|点击|界面|截图|报错|日志|不显示|没显示|闪退|崩溃|卡在|卡住|打不开|无反应|没反应|看不到|显示不|不生效|无效)/;

/** AI 侧的执行故障：命令格式错、额度不足、模型不可用。 */
const ENV_FAULT_RE = /(预扣费|额度|API Error|请运行 \/login|请运行 \/model|命令格式又出错|DSML|inference gateway|Not logged in)/;

/**
 * 给一次人类介入判可避免性。
 *
 * @param {{type:string, text:string, afterStop?:string|null}} event
 * @param {{nextHumanText?:string|null}} [ctx] 打断之后的下一句人类发言（用于区分误触）
 * @returns {'P1'|'P2'|'P3'|'P4'|'P5'}
 */
export function avoidabilityOf(event, ctx = {}) {
  const t = String(event.text ?? '');
  const { type } = event;

  // 打断：用户亲手按的停止。
  // 若之后没有再发任何指令 → 误触或主动收手，与 AI 行为无关（实测 60/162）。
  if (type === 'interrupt') {
    const src = ctx.nextHumanText !== undefined ? ctx.nextHumanText : event.nextHumanText;
    const next = src == null ? null : String(src).trim();
    if (!next) return 'P4';
    if (NUDGE.test(next)) return 'P4';                       // 停手看了看，然后放行
    if (OBSERVATION_REPORT.test(next)) return 'P2';          // 看到了现象
    return 'P1';
  }

  // 答问：AI 自己开口问了、用户作答。这是提问机制正在生效，不是被浪费的介入。
  if (type === 'answer') return 'Q';

  // 催促分四种成因，实测分布差异极大（365 次里 end_turn 202 / stop_sequence 143 / 其他 20）：
  //   ① AI 用散文问句请示（「要我继续吗？」）→ 用户答「继续」。**有问有答，机制正常**，
  //      但格式不对：该走结构化提问，不该耗一轮对话（实测 48 次）。归 Q。
  //   ② AI 直接宣称做完就收工，用户还得说「继续」→ 完成标准没定清，
  //      这是开工前就能问到的前提（实测 145 次）。归 P1。**这是最大的一块。**
  //   ③ AI 因 API/额度/模型故障停下 → 环境问题，归 P3。
  //   ④ 其余（AI 停在问句末尾、用户嫌慢）→ 节奏问题，归 P5。
  if (type === 'nudge') {
    if (event.afterStop === 'stop_sequence') return 'P3';
    if (RETRY.test(t.trim())) return 'P3';
    if (ENV_FAULT_RE.test(t)) return 'P3';
    if (event.afterStop === 'end_turn') {
      return event.proseQuestion ? 'Q' : 'P1';
    }
    return 'P5';
  }

  // 纠正：用户否定已有产出
  if (type === 'correction') {
    if (ENV_FAULT_RE.test(t)) return 'P3';
    if (OBSERVATION_REPORT.test(t)) return 'P2';
    return 'P1';
  }

  // 插话
  if (ENV_FAULT_RE.test(t)) return 'P3';
  if (OBSERVATION_REPORT.test(t)) return 'P2';
  if (NUDGE.test(t.trim())) return 'P5';
  return 'P1';
}

// ── 会话级聚合 ─────────────────────────────────────────────────────

/**
 * 分析单个 transcript，返回该会话的介入事件与分母。
 *
 * @param {string} path
 * @param {number} [sinceMs] 只统计此时间之后的人类发言
 * @returns {{
 *   path: string, sessionId: string|null, firstTs: string|null, lastTs: string|null,
 *   lastMtimeMs: number, humanTurns: number, assistantStops: number,
 *   events: Array<{type:string, ts:string|null, text:string, afterStop:string|null}>,
 *   askQuestions: number, askAnswered: number, counts: Record<string,number>,
 *   truncatedTail: boolean, bytes: number
 * }}
 */
export function analyzeTranscript(path, sinceMs) {
  const size = statSync(path).size;
  let sessionId = null;
  let firstTs = null;
  let lastTs = null;
  let humanTurns = 0;
  let assistantStops = 0;
  let askQuestions = 0;
  let askAnswered = 0;

  /** 上一条 assistant 的 stop_reason 和它是否是 AskUserQuestion。
   *  用来回答「用户这句话是在 AI 停之后说的，还是在 AI 干活时插进来的」。 */
  let prevStop = null;
  let prevAsked = false;
  /** 是否已见过 assistant（会话开头的人类发言没有「前一次停止」） */
  let sawAssistant = false;
  /** 已计过数的 assistant message.id。
   *
   *  必须去重：宿主把同一次 API 响应的每个 content block 拆成独立记录落盘，
   *  同一条 message.id 会重复 3~7 次（实测某会话 8318 条 assistant 记录
   *  只对应 2663 个 id，raw end_turn 890 次去重后只有 290 次）。
   *  不去重的话「AI 交还控制权次数」会被抬高约 3 倍。
   *
   *  且 `stop_reason` 只在**后几条**记录上才有值（前几条是 thinking/text，
   *  实测 2663 组里有 814 组出现 null + 具体值的混合），所以必须「最后一个
   *  非 null 值生效」，不能先见先算。 */
  const msgGroups = new Map();

  const events = [];
  const counts = { interrupt: 0, answer: 0, interject: 0, correction: 0, nudge: 0, normal: 0 };
  /** 最近一次打断在 events 中的下标；用于把「打断之后用户说了什么」回填上去。 */
  let pendingInterrupt = -1;

  const inWindow = (ts) => {
    if (!sinceMs) return true;
    if (!ts) return true;
    const t = Date.parse(ts);
    return Number.isFinite(t) ? t >= sinceMs : true;
  };

  /** 一条 API 响应的多个 block 记录已攒齐，立刻结算它对「AI 状态」的影响。
   *  必须在读到下一条 user 记录之前结算，否则 prevStop 会是错的。
   *
   *  去重按 message.id **全局**做，且用「是否已计入」而不是「是否已见过」：
   *  同一条响应的分片会被中间的 queue-operation 记录切成多段，前段的
   *  `stop_reason` 还可能是 null，只有后段才带上 `end_turn`。若用「见过就跳过」，
   *  这类响应会永久漏计（实测 2 个会话各漏 1 次）。 */
  let curMsg = null;
  const countedEndTurn = new Set();
  const countedAsk = new Set();
  /** 最后一条 assistant 的散文文本，用来判「这次停止是不是在请示」。
   *  实测：202 次「AI 说完就停、用户说继续」里，48 次末尾是「要我继续吗？」这类问句，
   *  145 次是直接宣称做完。前者是提问格式用错（该用 AskUserQuestion），
   *  后者是完成标准没定——两者要分开算。 */
  let lastAsstText = '';
  const flushAssistant = () => {
    if (!curMsg) return;
    const { id, stop, asked, text } = curMsg;
    curMsg = null;
    if (stop) prevStop = stop;
    prevAsked = asked;
    if (text) lastAsstText = text;
    const key = id ?? 'anon';
    if (asked && !countedAsk.has(key)) { countedAsk.add(key); askQuestions++; }
    if (stop === 'end_turn' && !countedEndTurn.has(key)) { countedEndTurn.add(key); assistantStops++; }
  };

  /** AI 交还控制权时，最后一句是不是在向用户请示。 */
  const endsWithProseQuestion = () => {
    const t = lastAsstText.trimEnd();
    if (!t) return false;
    if (/[？?]\s*$/.test(t)) return true;
    // 「要我…吗」这类没有问号但明显在请示的句式
    return /要(我|不要我)[^。？?]{0,25}[吗呢]/.test(t.slice(-80));
  };

  eachLine(path, (line) => {
    if (!line) return;
    // 预过滤：不含关键词的行不解析，实测省 65% 解析开销
    let hit = false;
    for (const k of RELEVANT) if (line.includes(k)) { hit = true; break; }
    if (!hit) return;

    let o;
    try { o = JSON.parse(line); } catch { return; }
    if (!o || typeof o !== 'object') return;

    if (o.sessionId) sessionId = o.sessionId;
    if (o.timestamp) {
      if (!firstTs) firstTs = o.timestamp;
      lastTs = o.timestamp;
    }

    if (o.type === 'assistant') {
      sawAssistant = true;
      const msgId = o.message?.id ?? null;
      if (!curMsg || curMsg.id !== msgId) {
        flushAssistant();
        curMsg = { id: msgId, stop: null, asked: false, text: '' };
      }
      // 最后一个非 null 的 stop_reason 生效
      const stop = assistantStop(o);
      if (stop) curMsg.stop = stop;
      if (askedUser(o)) curMsg.asked = true;
      const blocks = o.message?.content;
      if (Array.isArray(blocks)) {
        const txt = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
        if (txt.trim()) curMsg.text = txt;
      }
      return;
    }

    // 任何非 assistant 记录都意味着这条响应已经结束
    flushAssistant();

    if (o.type !== 'user') return;

    {
      if (isAskAnswer(o)) {
        askAnswered++;
        if (inWindow(o.timestamp)) {
          counts.answer++;
          events.push({ type: 'answer', ts: o.timestamp ?? null, text: '', afterStop: prevStop });
        }
        prevStop = null;
        prevAsked = false;
        return;
      }

      if (isInterrupt(o)) {
        if (inWindow(o.timestamp)) {
          counts.interrupt++;
          events.push({ type: 'interrupt', ts: o.timestamp ?? null, text: INTERRUPT_MARKER, afterStop: prevStop });
        }
        // 之后的第一个人类发言要回填到这个打断事件上（判「误触」还是「看到现象」）
        pendingInterrupt = events.length - 1;
        return;
      }

      const txt = humanTurnText(o);
      if (txt == null) return;
      humanTurns++;
      if (!inWindow(o.timestamp)) { prevStop = null; prevAsked = false; return; }

      // 回填：这是打断后的第一句人类发言
      if (pendingInterrupt >= 0 && events[pendingInterrupt]) {
        events[pendingInterrupt].nextHumanText = txt.slice(0, 200);
        pendingInterrupt = -1;
      }

      // 会话的第一条人类发言是「开新活」，不可能是「对 AI 的干预」——
      // 它之前没有任何 AI 行为可供干预。实测 6 条开场任务书被误判成
      // correction/interject（含一份 9361 字符的规格文档）。
      const working = sawAssistant && prevStop === 'tool_use';
      const kind = !sawAssistant ? 'normal'
        : working ? 'interject'
          : classifyHumanMessage(txt);
      counts[kind]++;
      events.push({
        type: kind,
        ts: o.timestamp ?? null,
        text: txt.slice(0, 200),
        afterStop: prevStop,
        proseQuestion: prevStop === 'end_turn' && endsWithProseQuestion(),
      });
      prevStop = null;
      prevAsked = false;
    }
  });

  // 文件末尾的最后一条 assistant 记录也要结算，否则以 AI 结束的会话会少算一次
  flushAssistant();

  // 给每个介入事件打上可避免性标签
  for (const e of events) {
    if (e.type === 'normal') continue;
    e.avoidability = avoidabilityOf(e, { nextHumanText: e.nextHumanText });
  }

  let lastMtimeMs = 0;
  try { lastMtimeMs = statSync(path).mtimeMs; } catch { /* ignore */ }

  return {
    path, sessionId, firstTs, lastTs, lastMtimeMs,
    humanTurns, assistantStops, askQuestions, askAnswered,
    events, counts, bytes: size,
  };
}

// ── 汇总（纯函数）──────────────────────────────────────────────────

/** 分位数，线性插值。输入已排序或未排序均可。 */
export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/**
 * 把多个会话聚合成基线。
 *
 * 分母的口径有三个，全部给出，因为「介入率」的分母定义会显著改变结论：
 *   - 按会话：每会话介入次数的分布（长会话权重低，适合衡量「开一个新活要打断几次」）
 *   - 按人类回合：介入数 / 人类发言数（衡量「每次说话有多少是救火」）
 *   - 按 AI 主动停止：介入数 / AI 交还控制权次数（衡量「AI 每次交还时用户是否必须出手」）
 *
 * @param {Array<ReturnType<typeof analyzeTranscript>>} sessions
 */
export function summarize(sessions) {
  const totals = {
    sessions: sessions.length,
    humanTurns: 0,
    assistantStops: 0,
    interventions: 0,
    byType: { interrupt: 0, answer: 0, interject: 0, correction: 0, nudge: 0, normal: 0 },
    /** 按可避免性分级统计（P1 是唯一能被「开工前问清」系统性消除的） */
    byAvoidability: { P1: 0, Q: 0, P2: 0, P3: 0, P4: 0, P5: 0 },
    bytes: 0,
  };
  const perSession = [];
  const allEvents = [];

  for (const s of sessions) {
    const iv = s.counts.interrupt + s.counts.answer + s.counts.interject
      + s.counts.correction + s.counts.nudge;
    totals.humanTurns += s.humanTurns;
    totals.assistantStops += s.assistantStops;
    totals.interventions += iv;
    totals.bytes += s.bytes;
    for (const k of Object.keys(totals.byType)) totals.byType[k] += s.counts[k];
    perSession.push({
      sessionId: s.sessionId,
      path: s.path,
      interventions: iv,
      normalTurns: s.counts.normal,
      humanTurns: s.humanTurns,
      assistantStops: s.assistantStops,
      askQuestions: s.askQuestions,
      askAnswered: s.askAnswered,
      lastTs: s.lastTs,
    });
    for (const e of s.events) {
      allEvents.push({ ...e, sessionId: s.sessionId });
      if (e.avoidability && totals.byAvoidability[e.avoidability] !== undefined) {
        totals.byAvoidability[e.avoidability]++;
      }
    }
  }

  const perSessionCounts = perSession.map((s) => s.interventions);
  // 只对「有实质工作」的会话算分位数：0 介入的空会话会把 p50 拉成 0，掩盖真实分布
  const active = perSession.filter((s) => s.assistantStops >= 1 || s.humanTurns >= 2);
  const activeCounts = active.map((s) => s.interventions);

  // 按任务（会话）聚合：把一个会话里连续的同类介入算作一次「用户不得不介入的场合」
  const episodes = perSession.filter((s) => s.interventions > 0).length;

  return {
    totals,
    distribution: {
      all: {
        n: perSessionCounts.length,
        p50: percentile(perSessionCounts, 0.5),
        p90: percentile(perSessionCounts, 0.9),
        max: perSessionCounts.length ? Math.max(...perSessionCounts) : null,
        mean: perSessionCounts.length
          ? perSessionCounts.reduce((a, b) => a + b, 0) / perSessionCounts.length : null,
      },
      active: {
        n: activeCounts.length,
        p50: percentile(activeCounts, 0.5),
        p90: percentile(activeCounts, 0.9),
        max: activeCounts.length ? Math.max(...activeCounts) : null,
        mean: activeCounts.length
          ? activeCounts.reduce((a, b) => a + b, 0) / activeCounts.length : null,
      },
    },
    rates: {
      perHumanTurn: totals.humanTurns ? totals.interventions / totals.humanTurns : null,
      perAssistantStop: totals.assistantStops ? totals.interventions / totals.assistantStops : null,
      perSession: totals.sessions ? totals.interventions / totals.sessions : null,
    },
    sessionsWithIntervention: episodes,
    perSession,
    events: allEvents,
  };
}

// ── 扫描入口 ────────────────────────────────────────────────────────

/** 定位 transcript 根目录。 */
export function defaultRoot() {
  return join(homedir(), '.claude', 'projects');
}

/**
 * 列出主 transcript。
 *
 * **只取 `<root>/<slug>/<sessionId>.jsonl` 两层**。`subagents/` 下的
 * 4850 个子 agent transcript 不计入：那是 AI 的分身内部对话，
 * 里面没有「人工介入」这回事，混进来会把分母撑大 20 倍。
 */
export function listTranscripts(root) {
  const out = [];
  if (!existsSync(root)) return out;
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    let files;
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(dir, f);
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* ignore */ }
    }
  }
  return out;
}

/** CLI 主流程。 */
export function run({ root = defaultRoot(), days = 30, json = false, nowMs = Date.now() } = {}) {
  const sinceMs = days > 0 ? nowMs - days * 86400e3 : 0;
  const files = listTranscripts(root).filter((f) => days <= 0 || f.mtimeMs >= sinceMs);
  const analyzed = [];
  for (const f of files) {
    let r;
    try { r = analyzeTranscript(f.path, sinceMs); } catch { continue; }
    // 窗口内没有任何人类活动也没有任何 AI 停止的会话不参与统计
    if (r.humanTurns === 0 && r.assistantStops === 0) continue;
    analyzed.push(r);
  }

  // 同一 sessionId 可能有多份落盘：宿主在某些情况下会把同一个会话写成两个文件
  // （实测 2 组，其中一组两个文件 98% 内容相同，是早期快照）。
  // 保留「人类发言最多、同等时字节最大」的那份，否则一个会话会被重复计入分母。
  const byId = new Map();
  const kept = [];
  for (const r of analyzed) {
    const key = r.sessionId ?? r.path;
    const prev = byId.get(key);
    if (!prev) { byId.set(key, r); continue; }
    const better = r.humanTurns > prev.humanTurns
      || (r.humanTurns === prev.humanTurns && r.bytes > prev.bytes);
    if (better) byId.set(key, r);
  }
  for (const r of byId.values()) kept.push(r);

  const summary = summarize(kept);
  return { root, days, sinceMs, summary, duplicateSessions: analyzed.length - kept.length };
}

// ── 输出 ────────────────────────────────────────────────────────────

const TYPE_LABEL = {
  interrupt: '打断',
  answer: '答问',
  interject: '插话',
  correction: '纠正',
  nudge: '催促',
  normal: '（非介入）正常对话',
};

export function formatReport(res) {
  const { summary: s, days, root } = res;
  const L = [];
  const f1 = (x) => (x == null ? '—' : (Math.round(x * 10) / 10).toString());
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

  L.push('');
  L.push(`人工介入基线 · 最近 ${days} 天 · ${root}`);
  L.push('='.repeat(64));
  L.push('');
  L.push(`会话数 ${s.totals.sessions}　人类发言 ${s.totals.humanTurns} 回合　AI 交还控制权 ${s.totals.assistantStops} 次`);
  L.push(`介入总数 ${s.totals.interventions}　每人类回合 ${f1(s.rates.perHumanTurn)}　每次交还 ${f1(s.rates.perAssistantStop)}`);
  L.push('');
  L.push('按类型：');
  for (const k of ['interrupt', 'answer', 'interject', 'correction', 'nudge']) {
    L.push(`  ${TYPE_LABEL[k].padEnd(4, '　')} ${String(s.totals.byType[k]).padStart(6)}   ${pct(s.totals.byType[k], s.totals.interventions)}`);
  }
  L.push(`  正常对话 ${String(s.totals.byType.normal).padStart(4)}（不计入介入）`);
  L.push('');
  L.push('每会话介入数分布：');
  for (const [name, label] of [['all', '全部会话'], ['active', '有实质工作的会话']]) {
    const d = s.distribution[name];
    L.push(`  ${label}（n=${d.n}）　p50 ${f1(d.p50)}　p90 ${f1(d.p90)}　max ${d.max ?? '—'}　mean ${f1(d.mean)}`);
  }
  L.push('');
  L.push(`发生过介入的会话：${s.sessionsWithIntervention} / ${s.totals.sessions}`);
  L.push('');
  L.push('按「能不能靠开工前问清楚避免」分级：');
  const AV_LABEL = {
    P1: 'P1 开工前可问清',
    Q: 'Q  AI 已主动提问（作答）',
    P2: 'P2 过程信息缺口',
    P3: 'P3 环境/执行故障',
    P4: 'P4 用户停手/误触',
    P5: 'P5 节奏催促',
  };
  for (const k of ['P1', 'Q', 'P2', 'P3', 'P4', 'P5']) {
    if (!s.totals.byAvoidability[k]) continue;
    L.push(`  ${AV_LABEL[k].padEnd(16, '　')} ${String(s.totals.byAvoidability[k]).padStart(5)}   ${pct(s.totals.byAvoidability[k], s.totals.interventions)}`);
  }
  L.push('');

  const top = [...s.perSession].sort((a, b) => b.interventions - a.interventions).slice(0, 8);
  if (top.length) {
    L.push('介入最多的会话：');
    for (const t of top) {
      L.push(`  ${String(t.interventions).padStart(4)} 次　${(t.sessionId ?? '?').slice(0, 8)}　发言 ${t.humanTurns}　交还 ${t.assistantStops}`);
    }
  }
  L.push('');
  return L.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { days: 30, json: false, root: defaultRoot() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a.startsWith('--days=')) out.days = Number(a.slice(7));
    else if (a === '--root') out.root = argv[++i];
    else if (a.startsWith('--root=')) out.root = a.slice(7);
  }
  if (!Number.isFinite(out.days)) out.days = 30;
  return out;
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('measure-interventions.mjs');

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.root)) {
    process.stderr.write(`找不到 transcript 根目录：${opts.root}\n`);
    process.exit(2);
  }
  const t0 = process.hrtime.bigint();
  const res = run(opts);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      days: res.days,
      root: res.root,
      elapsedMs: Math.round(ms),
      totals: res.summary.totals,
      distribution: res.summary.distribution,
      rates: res.summary.rates,
      sessionsWithIntervention: res.summary.sessionsWithIntervention,
      duplicateSessions: res.duplicateSessions,
      perSession: res.summary.perSession,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(formatReport(res));
    process.stdout.write(`耗时 ${ms.toFixed(0)} ms\n`);
  }
}
