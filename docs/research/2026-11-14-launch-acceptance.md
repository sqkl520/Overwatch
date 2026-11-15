# 验收（复核）：`overwatch launch`（commit `1474f6d`）

- 日期：2026-11-15
- 作者：验收 Agent **V1-r**（一票否决权；除本报告与 README 登记外不改任何仓库文件）
- 产出形态：`exploration`（结论报告，零行改实现）
- 实测环境：Windows 11 / Git Bash / Node v26.12.1 / `claude` CLI 2.1.308
- 本机登录态：`claude auth status --json` → `{"loggedIn":false,"authMethod":"none"}`，退出码 1
- 证据等级：T2/T3（本机实跑；假宿主全部放在 `%TEMP%`，跑完已清理）
- 判据：任务书**预先声明**的 AC1–AC10，逐条实测。**未被告知任何此前结论**，独立判定。

> **结论先行：不通过。** 最严重的是 **AC2**：`--verify` 的期望清单与「宿主实际列出什么」
> 是同一份本机 `readdirSync` 结果，挪走 1 个 agent 后它报「11 个角色，逐个对上」，exit 0。
> 次严重是 **AC3**：真宿主对无效凭据的原话 `Failed to authenticate. API Error: 401 认证失败: …`
> **不在** `AUTH_RE` 里，该文本 + exit 0 被判 **0**；AC8 也 FAIL（台账的 `judge.detail`
> 原样带出未遮的绝对路径与宿主输出里的 UUID）。

---

## §0 十行裁定

```
AC1   PASS      exit 0；假宿主 spy 日志在对照组出现、在 --dry-run 下不存在（证明没起子进程）；未写文件
AC2   FAIL      期望清单来自本机 .claude/agents/ 的 readdirSync；挪走 1 个 → 「11 个，逐个对上」exit 0
AC3   FAIL      主路 exit 6 正确；但 AUTH_RE 不含 Failed to authenticate / 401 / 认证失败，该文本 + exit 0 → 0
AC4   PASS      假宿主 exit 0 + 空输出 → exit 7（judge.kind=silent-empty）；--host-bin 可用，无需绕路
AC5   PASS      settings 顶层键只有 hooks（落盘文件与 --dry-run 打印的 JSON 都核过）
AC6   PASS      非 TTY 无参数 → exit 5，打印四条可选路，不静默降级
AC7   PASS      人类输出明说「只影响调度，不影响挂载」；--json 与台账都有 roster.applied=false
AC8   FAIL      judge.detail 未过 maskPath：verify 失败时台账里出现 --host-bin 的完整绝对路径；宿主文本里的 UUID 也进台账
AC9   PASS      check-structure exit 0；node --test 1537 条 0 fail；build-payload --verify-self exit 0
AC10  FAIL      三处文档与实现不符：exit 1 被用于环境错误 / print 模式超时判据不可达 / 干净 clone 粘贴即失败；另输出里的台账路径与实际路径不一致
```

---

## §1 AC1：`--dry-run` 真的不起任何子进程 —— **PASS**

**实测 1：exit 0 + 完整命令行**

```
$ node scripts/overwatch.mjs launch --dry-run
...
要执行的命令行（逐字，可直接复制粘贴；本次没有执行任何东西）：
  claude --plugin-dir '<repo>\.claude' --settings '<repo>\tasks\runs\launch\settings-336225b3.json'
EXIT=0
```

**实测 2：spy 假宿主（写 spawn 日志）做 A/B**

```
$ SPY_LOG=<tmp>/spy2.log node scripts/overwatch.mjs launch --print --host-bin <tmp>/spy.mjs "hi"
EXIT=7
$ cat <tmp>/spy2.log
SPAWNED ["--plugin-dir","<repo>\\.claude","--settings",...,"-p","hi"]

$ rm <tmp>/spy2.log
$ SPY_LOG=<tmp>/spy2.log node scripts/overwatch.mjs launch --dry-run --host-bin <tmp>/spy.mjs
EXIT=0
$ ls <tmp>/spy2.log
ls: cannot access ... No such file or directory
```

对照组证明 spy 真的会在 spawn 时写日志；`--dry-run` 下日志不存在 ⇒ 没起子进程。

**实测 3：不写文件**

```
$ OVERWATCH_RUNS_DIR=<tmp>/freshruns node scripts/overwatch.mjs launch --dry-run
EXIT=0
$ ls <tmp>/freshruns
ls: cannot access ... No such file or directory
```

第三条（「可直接复制粘贴」）在**干净 clone** 下不成立 —— 归入 AC10。

---

## §2 AC2：`--verify` 的证据必须来自宿主 + 独立期望清单 —— **FAIL**

**读源码定判据**：`scripts/launch.mjs:246`

```js
for (const f of readdirSync(join(dir, 'agents'))) { if (f.endsWith('.md')) agents.push(...) }
```

期望清单 = 本机 `.claude/agents/` 的 `readdirSync`。`runVerify()`（同文件 696 行）的判据是
`p.payload.agents.filter((a) => !body.includes(a))` —— 整段输出的**子串扫描**。
全仓 `grep "Agents ("` 只命中一条注释，**没有任何一处解析宿主的 `Agents (N)`**。
这正是任务书预先判为自我认证的形态：分母与「应有」同源。

**负向实测（任务书必做项）**

```
$ node scripts/overwatch.mjs launch --verify
载荷挂对了：宿主自己列出 12 个角色，逐个对上（不需要推理与认证）
EXIT=0

$ mv .claude/agents/oversight-safety.md <tmp>/
$ node scripts/overwatch.mjs launch --verify
载荷挂对了：宿主自己列出 11 个角色，逐个对上（不需要推理与认证）
EXIT=0          ← 必须非 0，实际 0
$ mv <tmp>/oversight-safety.md .claude/agents/    # 已恢复，git status 对该目录干净
```

**补充反证：假宿主声称 0 个 agent、把 12 个名字当普通文本印出来**

```
$ node scripts/overwatch.mjs launch --verify --host-bin <tmp>/counter.mjs
载荷挂对了：宿主自己列出 12 个角色，逐个对上（不需要推理与认证）     # 该宿主第一行是 "Agents (0)"
EXIT=0
```

⇒ `--verify` 在载荷少一半、甚至宿主说「0 个」时都能通过。**判 FAIL。**

---

## §3 AC3：认证失败必须 exit 6 —— **FAIL**

**主路正确**

```
$ node scripts/overwatch.mjs launch --print "x"
Not logged in · Please run /login
...（stderr 三条可操作命令 + 一条自检）
EXIT=6
```

**不会因为 `subtype: success` 判成功**

```
$ node scripts/overwatch.mjs launch --print --host-bin <tmp>/liar.mjs "x"
{"type":"result","subtype":"success","is_error":true,"result":"boom"}
宿主失败（is-error-true）：...
EXIT=7
```

**`AUTH_RE` 逐条检查**（`scripts/launch.mjs:331`）

```js
/Not logged in|Please run \/login|authentication_failed|Invalid API key|OAuth token (?:has )?expired/i
```

```
$ node -e '...'
AUTH_RE.test("Failed to authenticate. API Error: 401 认证失败: Claude Desktop gateway authentication failed") = false
contains "Failed to authenticate": false
contains "401": false
contains "认证失败": false
```

**该文本确实来自本机宿主**（真宿主，无效凭据，`--output-format json`）：

```
$ ANTHROPIC_AUTH_TOKEN=bogus-token claude -p "hi" --output-format json
{"result":"Failed to authenticate. API Error: 401 认证失败: Claude Desktop gateway authentication failed",
 "is_error":true,"subtype":"success",...}          exit 1
```

**负向：该文本 + exit 0 被判成 0**

```
$ node scripts/overwatch.mjs launch --print --host-bin <tmp>/gw0.mjs "x"
Failed to authenticate. API Error: 401 认证失败: Claude Desktop gateway 缺少 Authorization 头
EXIT=0
```

`docs/research/2026-11-14-observe-mode-reality-check.md` 记录过同一文本以 **exit 0** 结束的形态，
所以「文本 + exit 0」不是合成的极端。**后果**：上游网关认证失败在上层看起来是一次成功运行，
台账写 `exitCode:0 / judge.failed:false` —— 正是本命令存在的理由（把 exit 0 的假成功纠正过来）
在这一形态上失效。走真宿主时它当前给 exit 1，于是被兜到 **7**（「宿主失败」）而不是 6，
用户会去读宿主输出而不是去修凭据。**判 FAIL。**

---

## §4 AC4：静默失败必须 7 —— **PASS**

```
$ cat <tmp>/silent.mjs
process.exit(0);

$ node scripts/overwatch.mjs launch --print --host-bin <tmp>/silent.mjs "x"
宿主 exit 0 但什么都没输出 —— 本命令判它**失败**（exit 7），不是成功。
...
EXIT=7
```

`--host-bin` 是公开选项且**可用**：`.mjs` 会以 `process.execPath` 为前缀 spawn（Windows 上
直接 spawn `.mjs` 会 `spawn EFTYPE`），实测无 EINVAL/EFTYPE，不需另找注入方式。

---

## §5 AC5：`--settings` 只含 hooks 键 —— **PASS**

```
$ cat tasks/runs/launch/settings-336225b3.json
{ "hooks": { "PreToolUse": [ ... ], "Stop": [ ... ] } }

$ node -e "console.log(Object.keys(require('.../settings-336225b3.json')))"
[ 'hooks' ]
```

`--dry-run` 打印的 JSON 全文同样只有 `hooks`；无 `model`、无 `permissions`、无 `env`。
（settings 里的 command 含仓库绝对路径，是 hook 脚本定位所必需，不是权限/模型键。）

---

## §6 AC6：非 TTY 拒绝启动 —— **PASS**

```
$ node scripts/overwatch.mjs launch            # stdout 非终端
launch 默认起交互式会话，但这里的 stdout/stdin 不是终端。
宿主在非 TTY 下不会报错 —— 它会静默切成 --print 然后等 stdin（实测），
那就不是「用户在里面干活的会话」了。请显式挑一个：
  --dry-run / --print / --verify / --interactive ...
EXIT=5
```

四条路都是**可直接敲的 flag**，且解释了为什么拒绝。不静默降级。
（附带：`--interactive` 在非 TTY 下照做，随后被认证预检拦成 exit 6，与 spec §7 表述一致。）

---

## §7 AC7：roster 的真相 —— **PASS**

```
$ node scripts/overwatch.mjs launch --dry-run
  roster     oversight-planner, oversight-executor, oversight-acceptor —— 来自 overwatch.config.json
             ⚠ **只影响调度，不影响挂载**：--plugin-dir 的单位是目录，没有「只挂一部分」的开关。
               本次整目录挂载，12 个角色全部可见；没被 roster 启用的 9 个是：...

$ node scripts/overwatch.mjs launch --dry-run --json | ...
roster = { "configured": [...], "applied": false, "note": "--plugin-dir 只认目录：整目录挂载，roster 只影响调度" }
```

`applied: false` 是**数据字段**，不是散文；台账同字段同值。命令行里只有一个 `--plugin-dir`
且指向整目录。无任何一处暗示 roster 生效。

---

## §8 AC8：台账不泄漏 —— **FAIL**

maskPath 只作用于 `hostBin` / `hostResolved` / `hostArgv` / `cwd` / `payload.dir` / `settings`；
**`judge.detail` 与 `note` 原样写入**。`judge.detail` 里有两类未遮内容：

1. `runVerify` 的 spawn 失败分支直接拼 `p.hostBin`；
2. 失败分支拼宿主输出的首行（可含绝对路径、可含 UUID）。

```
$ OVERWATCH_RUNS_DIR=<tmp>/leakY node scripts/overwatch.mjs launch --verify \
    --host-bin D:/work/nope.exe --no-hooks
$ cat <tmp>/leakY/launch/<日期>.jsonl
... "judge":{"failed":true,"kind":"verify-failed","detail":"宿主跑不起来（ENOENT）：D:/work/nope.exe"}

# 台账里有仓库根绝对路径（同样成立，用真实仓库路径重跑过）：
ledger has repo abs path: true
ledger has drive path: true

# 宿主文本里的 UUID 也进台账：
$ ... --host-bin <tmp>/vuuid.mjs        # 该宿主打印 "Error: duplicate session <一个 UUID 占位串>"
uuid in ledger: true
```

仓库里现存的 `tasks/runs/launch/2026-11-14.jsonl` 第 10 行已经躺了一条
`Z:/nope/none.exe`（盘符路径），说明这不是推演。

**为什么测试没抓到**：`launch.test.mjs`「台账不含盘符路径」那条只跑 `FAKE_MODE: 'ok'`
（成功路径，`judge.detail` 里没有路径）。**判 FAIL。**

---

## §9 AC9：三道门 —— **PASS**

```
$ node scripts/check-structure.mjs
✓ 结构检查全部通过
⚠ 1 项提示（不阻塞）：[scripts/build-payload.mjs] 导出 "verifyPluginRoot" 未登记
STRUCT_EXIT=0

$ node --test scripts/
ℹ tests 1537 / pass 1535 / fail 0 / skipped 2
TEST_EXIT=0

$ node scripts/build-payload.mjs --verify-self
✔ .claude 是合法的 plugin 根 · 12 个 agent · 1 个 skill
VERIFY_SELF_EXIT=0
```

（`1533` 是硬门按 `^\s*test\(` 数的源码条数；runner 报 1537 是含子测试与 skipped 的计数口径。
两者不是同一个数，硬门只对账前者，本条不构成 FAIL，但两者口径不同这件事值得记下。）

---

## §10 AC10：文档与实现一致 —— **FAIL**

**(a) 退出码表：exit 1 的语义**。spec §9 写「1 = `launch.mjs` **自己**出了意外（bug），
stderr 会写明「这是 bug」」。实测环境错误也返回 1：

```
$ OVERWATCH_RUNS_DIR=<tmp>/blocker/runs node scripts/overwatch.mjs launch --verify
写不了 hooks 的 settings 文件：ENOTDIR: not a directory, mkdir '<tmp>/blocker/runs/launch'
（要关掉 hooks 请加 --no-hooks）
EXIT=1
```

stderr 里没有「这是 bug」。用户按表去报告 bug，实际只需要换个目录/加 `--no-hooks`。

**(b) 「超时 → 7」在 print 模式不可达**。`judgeHostRun` 唯一的调用点（850 行）写死
`timedOut: false`，且 print 分支的 `spawn` 不带任何 timeout：

```
$ timeout 25 node scripts/overwatch.mjs launch --print --host-bin <tmp>/hang.mjs "x"
宿主失败（host-exit）：宿主退出码 143
EXIT=124          ← 外层 timeout 杀了它；launch 自己没有超时
```

`host-timeout` / `silent-empty` 之外的那条判据分支至今没有活的调用方。
（`--verify` 有 60 秒超时，实测 `ETIMEDOUT` → 7，但文案说「宿主跑不起来（ETIMEDOUT）」，
把「超时」说成「跑不起来」，与 spec §2 的判据分层不符。）

**(c) 干净 clone 上 `--dry-run` 打印的命令行原样粘贴跑不起来**

```
$ git clone . <tmp>/storepo && cd <tmp>/storepo
$ node scripts/overwatch.mjs launch --dry-run
  claude --plugin-dir '<tmp>/storepo\.claude' --settings '<tmp>/storepo\tasks\runs\launch\settings-3a5502c4.json'
$ claude --plugin-dir '...' --settings '...'
Error: Settings file not found: ...\settings-3a5502c4.json
EXIT=1
```

`--dry-run` 承诺不写任何文件（AC1 已核为真），但打印的 `--settings` 指向一个**只有真跑时才会写**
的文件。spec §6 把「逐字可执行」列为自己钉住的承诺，测试的判据却只是「那一段里含
`--plugin-dir <repo>/.claude`」，所以这条测不到粘贴失败。

**(d) 输出里的台账路径与实际不符**（附带发现，属同一类）

```
$ node scripts/overwatch.mjs launch --dry-run       → 台账  <repo>\tasks\runs\<日期>.jsonl
$ node scripts/overwatch.mjs launch --dry-run --json → "ledger": "<repo>\tasks\runs\<日期>.jsonl"
$ ls tasks/runs/launch/                             → 2026-11-15.jsonl     （多一层 launch/）
```

spec §8 写的是 `tasks/runs/launch/<日期>.jsonl`（与实际一致），**输出的却是错的路径**。
按输出去找台账的人会找不到。

---

## §11 方法论：全绿测试与 FAIL 共存

`launch.test.mjs`（28 条）与本次 FAIL 的四条并存，原因可指：

| AC | 测试怎么写 | 所以测不到什么 |
|---|---|---|
| AC2 | verify 负向用 `FAKE_MODE: plugin-partial`，即**假宿主少印名字**；`realAgents()` 也从真目录读 | 测的是「子串扫描能发现缺失」，不是「期望清单不来自本机」。挪走真文件 → 期望清单同步缩水 |
| AC3 | 两个「未登录」夹具用的是 `Not logged in` / `Invalid API key` 字样 | 从没有一条用真宿主原话 `Failed to authenticate. API Error: 401 认证失败:` |
| AC8 | 只跑 `FAKE_MODE:'ok'` 再扫台账 | 成功路径的 `judge.detail` 里本来就没有路径 |
| AC10 | 「逐字」判据 = 那一段里含 `--plugin-dir <repo>/.claude` | 「字符串在」不等于「粘贴能跑」 |

---

## §12 复现清单（全部已清理）

| 用例 | 注入方式 |
|---|---|
| spy / silent / liar / gw0 / gwj / gw401 / counter / hang / vuuid | `%TEMP%/acc-r/*.mjs` + `--host-bin`（真宿主同一条路径） |
| 干净 clone | `git clone . %TEMP%/acc-r/storepo` |
| 真宿主 401 | `ANTHROPIC_AUTH_TOKEN=bogus claude -p …` / `env -u ANTHROPIC_BASE_URL` |
| 负向挪文件 | `mv .claude/agents/oversight-safety.md` → 测 → 挪回；`git status` 对该目录干净 |

诚实边界：AC3 的「文本 + exit 0 → 0」用假宿主固定 exit 0 复现，真宿主在本机对同一文本给 exit 1；
该 exit-0 形态的出处是 `2026-11-14-observe-mode-reality-check.md` §2.1 记录的实测，不是本轮新造的。
