# 复核：8 条可复算的数字断言

- 日期：2026-11-15
- 作者：复核 Agent **N1**（除本报告与索引登记外不改任何仓库文件）
- 产出形态：`exploration`（逐条实跑，零行改实现）
- 实测环境：Windows 11 / Git Bash / Node v26.12.1
- 证据等级：T2（本机实跑，命令与输出摘录均在下文；临时 JSON 落在仓根 dotfile 名，跑完已删）
- 判据：**任务书预先声明的 8 条断言原文**。**未被告知任何此前结论**，逐条独立判定。

> **结论先行：2 条成立（#1、#3），1 条方向成立而精确值不成立（#5），
> 1 条部分成立（#7：只有 A 复现），3 条不成立（#4、#6、以及 #5/#7 的精确值），1 条成立（#8）。**
> 最要紧的一条是 **#4**：`118 UNCHECKABLE / 4 NO_EVIDENCE / 3 UNKNOWN` 这组数
> **在任何 day 窗口、任何语料规模下都不出现**——`NO_EVIDENCE` 在最近 3 天内恒为 **0**。

---

## §0 八行裁定

```
#1  成立        lint.cjs → true；deploy.mjs → false（build.mjs / vercel.mjs / deploy.sh 同样 false）
#2  成立        grep -c "idle=-" = 0；JSON 里 526 条 idleSec 最小值 2，负数 0 条
#3  成立        --days abc → exit 2
#4  不成立      实测 155 UNCHECKABLE / 0 NO_EVIDENCE / 2 UNKNOWN（163 条断言 / 528 会话）
#5  近似成立    宽口径先读后问 41/43 = 95.3%（声称 95.2%，差 0.1pp）
#6  不成立      实测 331 个有工具调用会话；零提问 287；写文件且零提问 240（声称 295 / 210）
#7  部分成立    A 0.0353（复现）；B 0.0203（声称 0.019）；C 0.0137（声称 0.017）
#8  成立        伪造/篡改/无签名/无密钥的 auto 标记全部 valid:false，只有正确签名才 true
```

---

## §1 #1 验证命令识别：`lint.cjs` 认，`deploy.mjs` 不认 —— 成立

```
$ node -e "const { isVerificationCommand } = await import('./scripts/verify-claims.mjs'); ..."
"node scripts/lint.cjs"          => true
"node scripts/deploy.mjs"        => false
"node scripts/lint.mjs"          => true
"npm run lint"                   => true
"node scripts/check-structure.mjs" => true
"node scripts/build.mjs"         => false
"node scripts/vercel.mjs"        => false
"node scripts/deploy.sh"         => false
```

边界与代码注释一致：白名单由两张表合成，`VERIFY_CMD_RE`（已知工具）+
`SCRIPT_VERIFY_NAME_WORDS`（脚本名整词）。`lint` 在词表里，`deploy` / `build` / `vercel` 不在。
**刻意不收 `build`** 写在 `verify-claims.mjs:565` 的注释里，与实测一致。

## §2 #2 负数 idle 已修 —— 成立

```
$ node scripts/scan-sessions.mjs --days 3 | grep -c "idle=-"
0                                  # 533 行带 idle=，无一条负数
$ node scripts/scan-sessions.mjs --days 3 --json | <数 idleSec>
numeric idle fields: 526   min 2   neg 0
```

人类可读与机器可读两条路都对得上。`idleSec` 的最小值是 **2 秒**，没有 0 也没有负数。

## §3 #3 `--days abc` exit 2 —— 成立

```
$ node scripts/scan-sessions.mjs --days abc >/dev/null 2>&1; echo $?
2
```

同样口径在 `question-audit.mjs` 里也有历史注释（曾静默回落成 7 天），此处未复测。

## §4 #4 `118 UNCHECKABLE / 4 NO_EVIDENCE / 3 UNKNOWN` —— 不成立

```
$ node scripts/verify-claims.mjs --days 3 | grep -oE "判定：[A-Z_]+" | sort | uniq -c
    155 判定：UNCHECKABLE
      2 判定：UNKNOWN
$ node scripts/verify-claims.mjs --days 3 --json   # summary
sessions 528 / sessionsWithClaims 160 / claims 163
byStatus: SUPPORTED 6 / STALE_ONLY 0 / FAILED_ONLY 0 / NO_EVIDENCE 0 / UNKNOWN 2 / UNCHECKABLE 155
```

**三处都不对**，且不是语料漂移能解释的：

| day 窗口 | claims | UNCHECKABLE | NO_EVIDENCE | UNKNOWN |
|---|---|---|---|---|
| 1 | 122 | 121 | 0 | 0 |
| 2 | 160 | 155 | 0 | 2 |
| **3** | **163** | **155** | **0** | **2** |
| 5 | 220 | 159 | 46 | 2 |
| 7 | 236 | 159 | 47 | 3 |
| 10 / 14 | 262 | 160 | 48 | 3 |
| 全量 | 264 | 160 | 49 | 3 |

- **118 UNCHECKABLE 在任何窗口都不出现**（最近的 121 是 `--days 1`，其余 ≥155）。
- **NO_EVIDENCE = 4 在任何窗口都不出现**：3 天内恒 0，要放宽到 5 天才开始出现（46 条）。
- 只有 **UNKNOWN = 3** 能在 `--days ≥ 7` 或全量上复现。
- 三天的口径本身要对上一处小差：人类输出写 `合计 162 条可核对断言：5 SUPPORTED / 2 UNKNOWN /
  155 UNCHECKABLE`，JSON 的 `claims` 是 **163**、`SUPPORTED` 是 **6**。
  差 1 条的原因我没有查（不在 8 条范围内），但**两种统计下 UNCHECKABLE 都是 155、NO_EVIDENCE 都是 0**，
  所以它不影响本条的判定。

> 参考：全量（866 会话 / 264 条断言）是 `42 SUPPORTED / 10 STALE_ONLY / 0 FAILED_ONLY /
> 49 NO_EVIDENCE / 3 UNKNOWN / 160 UNCHECKABLE`。声称的 118/4/3 与这组、与任何一档都不像。

## §5 #5 提问层 95.2% 先读后问 —— 近似成立（精确值不成立）

```
$ node scripts/question-audit.mjs | sed -n '/宽口径/,+4p'
  提问会话  43 个（占 13.0%）
  宽口径（含结构性探索）：
    先读后问：41 个（95.3%）
    先问后读：0 个（0.0%）
    证据在子 agent 里：2 个（4.7%）
  窄口径（只认读了文件内容，更严）：
    先读后问：40 个（93.0%）  先问后读：3 个（7.0%）
```

41/43 = 95.348% → **95.3%**，不是 95.2%。「宽口径 0 个先问后读」这个结构性结论成立。
（`docs/spec/2026-11-14-question-audit.md:251` 记的是 39/41 = 95.1%，说明这个数确实随语料漂；
引用前必须重跑，不能引任何写死的百分比。）

## §6 #6 295 个有工具调用会话里 210 个零提问 —— 不成立

```
$ node scripts/question-audit.mjs --json | <summary>
sessions 331 / withAsk 43 / askCalls 174 / wroteWithoutAsk 240
verdicts: read-first 41 / ask-first 0 / unattributable 2 / no-ask 288
$ <按 rows 直接数>
{ withTools: 331, noAsk: 287, wroteNoAsk: 240, withAsk: 44 }
```

- 分母对不上：实测 **331** 个有工具调用的会话（语料 865–866 份主 transcript），不是 295。
- 分子对不上，两种口径都不是 210：**零提问会话 287**（`AskUserQuestion` 计数 0），
  **写了文件却零提问 240**（C4a 代理指标）。
- 也不是窗口问题：`--days` 逐档实测 171 / 234 / 235 / 257 / 272 / 274 / 277 / 283 / 298（d=1..20），
  零提问 143 / 193 / 194 / 209 / 215 / 215 / 215 / 217 / 224 —— 没有 295，也没有 210。
- 历史文档记的是另一组：`docs/spec/2026-11-14-question-audit.md` 写 **230 个有工具调用 / 153 个零提问**。
  三个版本（230/153、295/210、331/240）互不相同，说明这组数被引用时没有一起带走语料规模。

## §7 #7 新主指标 A 0.035 / B 0.019 / C 0.017 —— 部分成立

```
$ node scripts/measure-ask-vs-tell.mjs --real-only | sed -n '/新主指标/,+4p'
  组           n     工作量   纠正  新密度   二档(+)   无纠正会话     旧:纠正/中断   旧:一次性
  A 开工前问       7     5666      2    0.035     0.353          5/7=71.4%          1.20%       0.0%
  B 开工后问      35    63923     13     0.02      0.43        28/35=80.0%          1.06%       0.0%
  C 从不问       44    36284      5    0.014     0.358        41/44=93.2%          0.92%       2.3%
```

JSON 精确值：A `0.03530`（2/5666）· B `0.02033`（13/63957）· C `0.01377`（5/36452）。

- **A 复现**（0.035）。
- **B 是 0.020 不是 0.019**；**C 是 0.014 不是 0.017**。
  文档 `2026-11-14-ask-vs-tell-metric.md:121-122` 是 B n=33/58854/11 → 0.019、C n=45/35438/6 → 0.017，
  即 **C 组少了 1 次纠正（6→5）且分了 1 个会话出去（45→44）**，分母反而变大。
- **同一次实测里数字自己在动**：我在几分钟内跑了两遍，
  B 的 work 从 63923 变 64138、C 从 36284 变 36452（本会话自己还在往 transcript 里写）。
  结论：这三个数**只能连语料规模一起引**，单引三位小数是把漂移当事实。
- 方向性结论（「A 不比 B/C 好」，p=0.47 / 0.12）不受影响：A 的点估计仍最高。

## §8 #8 伪造 `satisfied_by:"auto"` 会被拒 —— 成立

`markerValidity()`（`pre-write-gate.mjs:683`）先判会话，再 `markerSigCheck()`：
`satisfied_by` 只认 `auto` / `claim` 两个值，`auto` 必须过 `verifyMarkerSig()`（HMAC-SHA256 + `timingSafeEqual`）。
逐条负向实测（`secret='k'`）：

```
forged sig            valid:false  why:auto-bad-signature
no sig at all         valid:false  why:auto-unsigned
no secret             valid:false  why:auto-no-secret
signature kept, reads tampered 99   valid:false  why:auto-bad-signature
correctly signed      valid:true   why:same-session
claim, unsigned       valid:true   why:same-session
unknown satisfied_by  valid:false  why:unknown-satisfied-by
other session (sig 合法)  valid:false  why:other-session
```

签名覆盖 `version / session_id / at / reads / verified_at / reads_sample / prompt_id`
（`markerSigOf`），所以「签过一次再把 `reads` 改大」也过不去。`claim` 不签是刻意的：
它本来就是自述，签名会让它看起来像验过的。

---

## §9 方法边界

1. **只核 8 条，不核这 8 条背后的主张。** 例如 #8 只证明「签名校验存在且有效」，
   不证明「闸门默认开」——它的默认模式是 `observe`（只记账不拦），与本条无关但容易被顺带误读。
2. **#4 / #6 / #7 的不成立有两种性质**，本报告未进一步区分：
   ①数字写错/写旧；②口径没写清（分母含不含沙箱、含不含 fork 副本、含不含子 agent）。
   要区分得拿到原始任务书的原文，我没有。
3. **语料是活的。** `measure-ask-vs-tell` 两次跑之间 B/C 的工作量就在变；
   `verify-claims --days 3` 的会话数从 528 起也会涨。所有数字带 2026-11-15 的时间戳。
4. **临时文件已删。** 用到的 JSON 都落在仓根 dotfile 名（`.vc3.json` / `.qa.json` / `.scan.json`），
   跑完即删，`git status` 无残留。
5. **本次复核期间仓里还有别的 Agent 在改代码**（`scripts/launch*.mjs` 有未提交改动），
   所以两道门的状态不能当本次改动的判据：`check-structure` 报 4 项「回归测试数 1533 vs 源码 1537」
   （四份文档同步项，与本研究无关），`node --test scripts/` 一次跑到 **1541 条 / 1539 pass / 0 fail / 2 skip**。
   这些数字在我写报告时仍在动——**与 §5 指出的同一个问题：本仓任何写死的计数都会漂。**
