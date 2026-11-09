# 公开前的文档分拣清单

> 目的：把 `docs/` 下的每个 `.md`（含 `docs/research/`、`docs/spec/`、`docs/design/`、`docs/adr/`）
> 加上根目录的 `README.md`、`CLAUDE.md`，逐份判定**能否随本仓库推到公开 GitHub**。
> 判错的后果是本机敏感信息直接进入公开互联网，因此每条都写了理由，而不是只写档位。
>
> 三档定义（不设第四档）：
>
> | 档位 | 含义 |
> |---|---|
> | `PUBLIC` | 可以直接公开：方法论、实测结论、失败模式、设计推理 |
> | `SANITIZE` | 有公开价值但含本机信息，**已实际脱敏**后可以公开 |
> | `PRIVATE` | 不能公开；脱敏后也不剩价值，或整篇性质就是本机专有。**文件保留在磁盘上**，第一行加了 `<!-- PRIVATE: 不在公开范围内 -->`，路径写进 `.gitignore` |

判定日期：2026-11-02。判定依据：`CLAUDE.md`「禁止在可发布区出现本机绝对路径」+ 本任务给出的六类敏感项清单。

---

## 一、总表

| 文件 | 档位 | 理由 | 改了什么 / 为什么不能公开 |
|---|---|---|---|
| `README.md` | SANITIZE | 门面文档，能力边界与方法论可公开 | 上一轮已把 4 处真实项目替换成 `<session-A>` / `<repo>` 等占位符，并去掉参考项目的仓库 URL；本轮复核确认无残留 |
| `CLAUDE.md` | SANITIZE | 项目硬约束与目录归属，公开价值高 | 上一轮把 `Let's Learn English` 改成「一个同类项目」；本轮复核确认无残留 |
| `docs/CHANGELOG.md` | SANITIZE | 逐阶段改动流水账，实测数字与负向验证是全项目最有价值的部分 | 上一轮已批量替换会话 ID、项目 slug、`hwnd`/`pid`；本轮把 `hwnd 2886474 (pid 50184)` 改成 `<hwnd-a> (pid <pid-a>)`，`68210` 改 `<hwnd-b>`。保留 commit hash（本仓库自己的）与全部统计数字 |
| `docs/GUIDE.md` | SANITIZE | 使用手册，公开价值高 | 上一轮替换了会话名/项目名；本轮把残留的 `d//Server/<project-E>/Serv` 归一成 `<project-E-slug>`（前半段是真实盘符与项目名的残形）。第 364 行 `D:\...` 是**规则说明里的反例**，同行带「反例」二字，硬门按设计放行 |
| `docs/install-watcher.md` | SANITIZE | Windows 自启与 Toast 的实测踩坑，通用价值 | 上一轮把 `D--Projects-rea-Project-work-shapez` 与 session id 换成 `<project-C-slug>` / `<session-F>`；本轮复核确认无残留 |
| `docs/observe-period.md` | PUBLIC | 观察期判据与「宿主事实是稀疏事件」的推导，不含本机标识 | 未改。`%LOCALAPPDATA%` 是环境变量而非本机路径 |
| `docs/adr/0001-config-only.md` | SANITIZE | ADR，公开价值高 | 上一轮把 job id `070eb93f` 换成 `<job-D>`；`peerToken` / `messagingSocketPath` 只作为**字段名**出现（宿主的公开协议概念），不含实际值，可保留 |
| `docs/adr/0002-honest-degradation.md` | PUBLIC | 「诚实降级」的决策记录与三条被推翻的判据 | 未改。第 5 行 `决策者：sqcola` 是 GitHub 账号（`README.md` 的 clone URL 已公开它），非本机标识 |
| `docs/spec/state-model.md` | PUBLIC | 可执行判据的唯一真源 | 未改 |
| `docs/spec/dispatch-contract.md` | PUBLIC | 派发契约与角色白名单 | 未改 |
| `docs/spec/evidence-discipline.md` | PUBLIC | 证据纪律四件套 | 未改 |
| `docs/spec/relay-protocol.md` | SANITIZE | 接力协议本体可公开 | 上一轮把宿主给的 `needs` / `suggestedReply` 原文（「把实测单发给我」等，含用户业务语境）改成泛化措辞；本轮复核确认无残留 |
| `docs/spec/output-format.md` | PUBLIC | 输出格式与 ADHD 规则 | 未改 |
| `docs/spec/tui-visual.md` | PUBLIC | 三通道视觉语言与 Unicode 宽度实测 | 未改 |
| `docs/spec/original-design.md` | PUBLIC | 上游设计稿原文（被修正的对象），保留以供追溯 | 未改 |
| `docs/spec/2026-11-02-autorelay-acceptance.md` | SANITIZE | 预先声明的验收标准，方法论价值高 | 全文只写「T1–T4 证据分级」「V1–V12 否决项」，不含本机路径/令牌/会话 ID。它**引用**了 `docs/research/2026-11-02-path-a-ipc.md`（PRIVATE）作为已验证对象，但只引用文件名与结论，不复制其敏感内容——故本篇仍可公开 |
| `docs/design/README.md` | SANITIZE | 设计存档索引 | 上一轮新增了 `continuation-engine.md` 一行；本轮复核确认无本机信息 |
| `docs/design/hosted-mode.md` | SANITIZE | 托管模式设计，数据全为泛化统计 | 未改内容。含 `\\.\pipe\LOCAL\cc-msg-<32hex>` 这一协议形态描述（宿主的公开管道命名规则，非本机具体值），可保留 |
| `docs/design/frontend-and-shape.md` | SANITIZE | 前端三层形态与策略 schema | 未改内容。`messagingSocketPath` / `peerToken` 只作为字段名出现；实测数字（9 个会话、6/6、8/8）是泛化统计 |
| `docs/design/intent-contract.md` | SANITIZE | 方向约定设计（已裁决否决） | 上一轮把一条引用的用户原话从「提交并发布 1.2.1」改成「x.y.z」（去掉真实版本号），并修正错别字 |
| `docs/design/verdict-intent-contract.md` | PUBLIC | 三方裁决过程，方法论价值高 | 未改 |
| `docs/design/continuation-engine.md` | SANITIZE | 续接引擎设计，实测数字价值高 | **本轮修了真实泄漏**：§3.2 的 `file-history-delta` 样例里有 `<project-D>\FCL\src\main\java\...\LocaleUtils.java`，其中 `FCL` 是真实项目模块名 → 改成 `<project-D>\<module>\src\main\java\...`。另把 F-10 里的 `ow-inject-test`（本机临时目录名）改成 `<scratch-repo>` |
| `docs/research/2026-10-30-hosted-automation.md` | SANITIZE | 「能投递但标注改不掉」的核心调研 | 上一轮把 job id `070eb93f` 换成 `<job-D>`。第 58 行「`from-name` 实测写 `sqcola` 能过」保留——那是 GitHub 账号，README 已公开 |
| `docs/research/2026-10-30-stop-signals.md` | SANITIZE | 结构化停止信号的三条实测 | 上一轮把 `AskUserQuestion` 的真实问答原文（含「源码仓」「ea 快照仓库」「APK」等私有业务语境）改成泛化措辞；本轮复核确认无残留 |
| `docs/research/2026-10-31-first-production-metric.md` | SANITIZE | 第一个生产指标（可追溯率 0/5），方法论价值最高的一份 | 上一轮把 5 条 session 短 ID 换成 `<session-F>` / `<session-B>` / `<session-G>`；本轮复核确认无残留 |
| `docs/research/2026-10-31-online-classification.md` | PUBLIC | 在线分类的固有局限（68% vs 4.8%） | 未改 |
| `docs/research/2026-10-31-replay-observations.md` | PUBLIC | 回放观察期的方法论与建模偏差自述 | 未改。含语料规模（158 个 transcript / 1.04GB）与耗时，属通用实测 |
| `docs/research/2026-10-31-reverse-engineered-waiting-signal.md` | SANITIZE | 逆向 `waiting` 信号的发现过程，结论价值高 | **本轮修了一处安装路径**：第 4 行原写 `%LOCALAPPDATA%\Claude-3p\claude-code\2.1.270\2afb47ea1b1f\`（含本机构建哈希）→ 改成 `<ver>\<build-hash>`。上一轮已把项目名换成 `<project-D>` |
| `docs/research/2026-10-31-rollback-executed.md` | SANITIZE | 回滚决策与「理由被推翻却不回滚」的自我批评 | 上一轮把三个 session 短 ID 换成 `<session-F>` / `<session-B>` / `<session-G>` |
| `docs/research/2026-11-01-dispatch-chain-audit.md` | SANITIZE | 派发链路普查，两个断点的方法论 | 未改内容。含 `tasks/runs/2026-10-30-p0/task-graph.json` 这一 run id——它是台账路径而非会话 ID，且 `tasks/runs/` 已 gitignore，保留无害 |
| `docs/research/2026-11-01-ground-truth-first.md` | PUBLIC | 「停久了是常态」这个翻转性结论 | 未改 |
| `docs/research/2026-11-01-relay-delivery-probe.md` | SANITIZE | 投递探针（`auto` 模式被证伪的决定性证据） | 上一轮把 `PerfScope` 换成 `<project-B>`；**本轮**又把 `pid 14568` 换成 `<pid-01>`。`peerToken` 只作字段名出现，无实际值 |
| `docs/research/2026-11-02-deterministic-signals.md` | SANITIZE | 确定性判据能做到什么程度 | **本轮**把 §8 的 `AppData\Local\Programs` 具体应用清单（opencode / Lunar Client / Termius）与 GPU 型号（RTX 2070 SUPER）改成泛化描述——它们组合起来是本机指纹。`.tmp-analysis/*.mjs` 的脚本名保留（目录已 gitignore，脚本名本身不含信息） |
| `docs/research/2026-11-02-false-positive-diagnosis.md` | SANITIZE | 两条误报的根因诊断，全项目最扎实的一份排障记录 | **本轮修了两处**：①§二标题原为 `"hilltop village" 是哪个会话`——真实项目名直接写在标题里，改成「这条通知对应的是哪个会话」；②三处 `deepseek-v4.1-flash` 上游模型名改成 `<upstream-model>`。另把 `pid 14568`/`41192` 换 `<pid>`，`uuid=72285974-...` 换 `<uuid-A>` |
| `docs/research/2026-11-02-fix-asked.md` | SANITIZE | ASKED 误报修复记录，含 411 个样本的阈值推导 | 未改内容（复核确认无本机标识）。项目名已被上一轮换成 `<project-B>` / `<session-E>` |
| `docs/research/2026-11-02-fix-blocked.md` | SANITIZE | BLOCKED 误报修复记录，「一个字段用错编出精确假数字」 | 未改内容（复核确认无本机标识） |
| `docs/research/2026-11-02-independent-recount.md` | SANITIZE | 独立复算，方法论示范 | 三处 `deepseek-v4.1-flash` 里的两处随本轮改成 `<upstream-model>`；末段提到另一份文档的路径引用改为「另一份并行产出的调研文档（不在公开范围内）」 |
| `docs/research/2026-11-02-redteam-deterministic.md` | SANITIZE | 红队复核，全项目最诚实的一份自我批评 | **本轮修了一处**：§6.1 的 8 条真实 AI 原句里带 `sqcoola-archive/`（GitHub 账号 + 私有目录名）、`[MC Servers]`、`[Github]`、三处 `[rea]`（真实项目名缩写）→ 全部换成 `<project-X>` / `<project-Y>` / `<project-Z>` / `<archive-dir>` / `<audit-doc>`。原句的**结构**保留（这是它作为证据的价值） |
| `docs/research/2026-11-02-uia-driver.md` | SANITIZE | UIA 驱动实测（读可行、写不可安全自动化） | **本轮**把具体 `hwnd`/`pid` 值（2886474 / 50184 / 68210 / 700 / 6816554 / 56035526 / 68226）换成 `<hwnd-N>` / `<pid-N>`，并去掉窗口矩形像素。会话名与项目名已被上一轮换成占位符 |
| `docs/research/2026-11-02-host-interfaces.md` | **PRIVATE** | 宿主与桌面应用的可编程接口全表 | **不能公开**：①12 条通道逐条给出「协议 + 认证 + 实测可用性」，包括 23 个工具的 MCP 清单、asar 内 `index.chunk-*.js` 的调试开关黑名单与 Ed25519 签名校验逻辑、`scheduled-tasks.json` 的精确路径（写一条进去理论上能在无人值守时起会话）。② `host-creds-<acct>.json` 的字段结构与 ~1 小时租约机制。③ 这份文档等于一份「本机 Claude 桌面版有哪些口子」的地图，脱敏后剩下的全是地图本身，故整篇不公开。**已标 PRIVATE + 加入 `.gitignore`** |
| `docs/research/2026-11-02-path-a-ipc.md` | **PRIVATE** | 会话间命名管道（`cc-msg-*`）的逆向 + 实测 | **不能公开**：①完整的帧格式表（`auth`/`user`/`control`/回执四种），含 `user` 帧的**必填字段与两条硬校验的伪代码**——照此可以构造一条能通过认证的投递帧。②`peerToken`/`childToken` 的双 token 认证模型与 `sha256(管道路径)` 的 key 文件名推导式。③`crossSessionInbound` 的策略函数原文（`k()`）与 `fromMode` 绕过的讨论，属于**安全机制上的洞**。④「自己起一个 `--settings {"crossSessionInbound":"accept"}` 的会话」这一形态，等于给出一个无人审阅执行入口的配方。已标 PRIVATE + 加入 `.gitignore` |
| `docs/research/2026-11-02-path-a-recount.md` | **PRIVATE** | 对 path-a-ipc 的复核 | 同样不能公开：它虽在纠错，但逐段复述了 §1 的全部协议细节（帧 schema、`lVe()` 原文、`from_mode` 字段位置、字节偏移），并新增了「信封里带 `from-mode="bypass"` 能骗过对等检查」这条**利用路径**。**已标 PRIVATE + 加入 `.gitignore`** |
| `docs/research/2026-11-02-path-b-gateway.md` | **PRIVATE** | 本机第三方推理网关的端点与令牌位置 | **不能公开**：①端点级探针矩阵，明确指出 `POST /v1/messages` **完全免认证**即可推理——这是给攻击者的现成入口。②网关令牌的**固定前缀 + 32 hex** 格式、存在哪三个文件（`settings` 表 / `configLibrary` / `host-creds`）、**17 天不轮换**。③ACL 暴露面（`<sandbox-group>:(I)(RX)`）与「某沙箱进程能明文读到令牌」这一可被利用的本地权限事实。④`claude -p` 的绕过处方。已标 PRIVATE + 加入 `.gitignore` |
| `docs/research/2026-11-02-path-b-recount.md` | **PRIVATE** | 对 path-b-gateway 的复核 | 同一类：它把 ACL 暴露面**写得更宽**（列出全部 10 个备份、`settings.json`、`logs\`、`host-creds-*.json` 都继承 `(I)(RX)`），并给出沙箱组的成员构成与 SID 尾号。虽在纠错，但把敏感事实复述并扩大了。**已标 PRIVATE + 加入 `.gitignore`** |

**统计**：`PUBLIC` 12 份，`SANITIZE` 27 份，`PRIVATE` 5 份，合计 44 份（42 份 `docs/*.md` + 根目录 `README.md`、`CLAUDE.md`）。
本文件 `docs/PUBLISH-TRIAGE.md` 自身不在表内（它判 PUBLIC，见 §六.3）。

---

## 二、删掉的两个文件

仓库根目录曾有两个**路径拼接失败**的产物（文件名把 `<repo-root>\tasks\runs\...` 整条路径吃掉了，
连盘符一起变成了文件名）：

```
<root>-Projects-Overwatch-tasks-runs-2026-11-02-path-b-recountdbdump2.out.txt
<root>-Projects-Overwatch-tasks-runs-2026-11-02-path-b-recountlatency10.out.txt
```

（上文的 `<root>` 是盘符；原文是那种「盘符 + 项目名 + 子路径」直接粘成一个长文件名的形态。）

**先读后删**。两份内容都是 Node 的 `MODULE_NOT_FOUND` 栈：

```
Error: Cannot find module '<repo-root>\ProjectsOverwatchtasksruns2026-11-02-path-b-recountdbdump2.mjs'
    at Module._resolveFilename (node:internal/modules/cjs/loader:1603:15)
    ...
Node.js v26.12.1
```

**判定**：不含数据库输出、不含令牌、不含会话内容——只是报错栈。但它们**含本机绝对路径**（`<repo-root>`），一旦提交就同时违反「可发布区零盘符」与本次的脱敏要求；且作为 `.out.txt` 它本来就不该在仓库根目录。**已删除**，未保留副本（内容已在本节转录结构，可复现）。

> 顺带说明：`.tmp-analysis/` 目录里 **12 个 `r3/*.json` 与 4 个 `rt1-*.json` 含有会话 UUID 与真实项目 slug**（例如 `rt1-72.json` 里同时有 `"sid":"<session-uuid>"` 与 `"project":"D--Projects-Overwatch"`）。该目录原先**未被任何 `.gitignore` 规则覆盖**（`.gitignore` 只写了 `tmp/`，匹配不到 `.tmp-analysis/`）。本轮已把 `.tmp-analysis/` 与 `.tmp-*` 加入 `.gitignore`，因此这些文件**不会被提交**；但它们是磁盘上的本机数据，是否清理由用户决定，本次未删（属于其他 Agent 的在途产物）。

---

## 三、`.gitignore` 的改动

新增两段：

```gitignore
# ── 生成物与临时物 ────────────────────────────────────
.tmp-analysis/
.tmp-*

# ── 本机专有的研究方向文档（脱敏后仍不剩公开价值）──────────
docs/research/2026-11-02-host-interfaces.md
docs/research/2026-11-02-path-a-ipc.md
docs/research/2026-11-02-path-a-recount.md
docs/research/2026-11-02-path-b-gateway.md
docs/research/2026-11-02-path-b-recount.md
```

`.tmp-*` 同时覆盖了仓库根目录 4 个同名前缀的临时文件（`.tmp-b2.txt`、`.tmp-inst2.js`、`.tmp-reply.mjs`、`.tmp-sess.js`）——它们**已经是被跟踪的文件**，`.gitignore` 对已跟踪文件不生效，本次**未处理**（删除已提交文件属于 git 操作，超出本任务授权）。这四份内容抽查无敏感信息（是代码片段草稿），但不是本次判定的产物，留待决定。

---

## 四、复核方式

```bash
node scripts/check-structure.mjs     # ✓ 全部通过（含「可发布区零盘符」与「.gitignore 不得排掉产品本体」）
node --test scripts/*.test.mjs       # 418 / 418 通过
```

`.gitignore` 新增的 5 条**不排掉产品本体**：它们只命中 `docs/research/` 下的 5 个具体文件，
不命中 `docs/` 目录本身。`checkGitignoreSanity()` 的 6 个致命目录（`.claude` `rules` `docs`
`templates` `scripts` `tasks`）全部未受影响，硬门已验证。

---

## 五、为什么这 5 份是 PRIVATE 而别的研究文档不是

分界线不是「有没有本机细节」，而是**脱敏后剩下的是不是仍然是一张地图**。

一份研究文档只要满足以下任一，就判 PRIVATE：

1. **给出可执行的攻击面**：端点 + 认证方式 + 免认证旁路（path-b-gateway）。
2. **给出可构造的协议细节**：帧格式、必填字段、校验逻辑、绕过的字段（path-a-ipc / path-a-recount）。
3. **给出可被利用的权限事实**：某沙箱组能读某令牌、某文件的 ACL 是 `(I)(RX)`（path-b-gateway / path-b-recount）。
4. **给出本机宿主的口子清单**：调试端口黑名单怎么写的、签名怎么验的、有哪些配置面（host-interfaces）。

反过来，`docs/research/2026-11-02-deterministic-signals.md` 里写「本机没有任何本地推理运行时」——
这是**否定的**事实（没有这个东西），公开不增加任何攻击面，所以判 SANITIZE 而不是 PRIVATE。

`docs/spec/2026-11-02-autorelay-acceptance.md` 判 SANITIZE 的理由也在这里：它通篇是「什么算证据充分」
（T1–T4 分级、n 与断言值的换算、12 条否决项），**不含任何一条具体的通道或凭据**。它把五条路线
判成 `UNPROVEN`，这是**收紧**结论而不是放开，公开它对攻击者没有帮助。

---

## 六、遗留

1. **`tasks/runs/` 下的运行台账含本机绝对路径**（见上文那条 `D=` 前缀的脚本），
   但该目录已 gitignore，属私有区，硬门是按设计放行的。本次未处理。
2. **`.tmp-*` 四个根目录文件已被 git 跟踪**，`.gitignore` 对它们无效。需一次 `git rm --cached`
   才会真正不再进仓——这是 git 操作，本任务禁止，留给用户决定。
3. **`docs/PUBLISH-TRIAGE.md` 本身（本文件）判 PUBLIC**：它只写档位与理由，不含新增的本机信息；
   引用的敏感样例（模型名、项目名、令牌格式）均已在上文脱敏。

---

## 七、2026-11-04 批次（12 份新增文档）的判定与脱敏记录

判定日期：2026-11-09（分拣 Agent S3）。判定依据同上，另加一条本轮新用的尺度：

> **含本机标识 ≠ 必须 PRIVATE。** 判 PRIVATE 的门槛仍是 §五那四条（可执行攻击面 / 可构造的协议细节 /
> 可被利用的权限事实 / 本机宿主的口子清单）。一份文档只要脱敏后**仍是一份可复用的排障与设计推理**，
> 就判 SANITIZE，而不是因为出现了本机路径就整篇下架。

### 7.1 逐份判定

| 文件 | 档位 | 理由 | 改了什么 |
|---|---|---|---|
| `docs/research/2026-11-04-competitive-landscape.md` | **PUBLIC** | 竞品与失败案例调研。来源全部是公开官网、arXiv、HN Algolia、GitHub REST API，不含任何本机数据 | 未改。文中 `Agent E3` 是内部角色代号，非身份信息 |
| `docs/research/2026-11-04-dsh-superagent-analysis.md` | **PUBLIC** | 对 `deepseek-ai/dsh-superagent-prototype` 的公开仓库逐行阅读，全部是对方代码路径与行号 | 未改 |
| `docs/research/2026-11-04-external-harness-protocols.md` | **SANITIZE** | 协议调研，方法论与实测结论价值高；含一处本机 opencode 的 `session/new` 返回值 | 把那个**本机 opencode 会话 UUID** 换成 `<session-Y-uuid>`。其余（工具版本号、23 个 MCP 工具名）是公开协议事实 |
| `docs/research/2026-11-04-orchestration-patterns.md` | **PUBLIC** | 七个框架的机制清单，每条带公开出处（`ccsub.md:300`、`mast.txt:169` 等） | 未改 |
| `docs/research/2026-11-04-dedup-key-analysis.md` | **SANITIZE** | 去重键的五处产键点与变异实验，是全批**方法论最扎实**的一份；但通篇用真实会话键与真实项目目录做论据 | 会话短 ID → `<session-S/T/U/V/W>`；项目目录 slug → `<project-J-dir>`；`%LOCALAPPDATA%` 保留（环境变量，非路径）。**去重键的 16 位 hex 值保留**——它是 `sha256(sessionId|state|reasonClass|fingerprint)` 的前 16 位，会话 ID 已换、原值不可逆推，且这些值在已公开的 `docs/research/2026-11-02-*.md` 里也以同样形态存在 |
| `docs/research/2026-11-04-fix-notify-dedup.md` | **SANITIZE** | 修复报告，含 508 条测试、6 个变异、真实回放 14357 条记录 | 项目目录 slug → `<project-J-slug>`；会话 ID → `<session-S>`；守护进程 PID → `<pid-A>`；临时盘根目录 → `<盘符>` |
| `docs/research/2026-11-04-host-status-reliability.md` | **SANITIZE** | `waiting` 准确率 12% / 78% 的量化实测，结论价值极高；但含**一张 10 个真实会话名的表**（本批最大的集中泄漏） | 10 个会话显示名与 slug 全部换成 `<project-A…L>`；会话 ID → `<session-*>`；`AnthropicPBC.Claude_<pkg-hash>` 保留占位形态、抹掉真实包哈希 |
| `docs/research/2026-11-04-notification-system-critique.md` | **SANITIZE** | 「该重做而不是修」的设计批判，四条判据画像与存活曲线是全项目最有价值的方法论之一 | 会话 ID、项目 slug 换占位符；「真实项目 51 个，最多的是 `<project-A>` 13 / Overwatch 10 / `<project-H-dir>` 9」保留数字、去掉名字 |
| `docs/research/2026-11-04-redteam-notify-fix.md` | **SANITIZE** | 红队攻击，**本批泄漏最重的一份**：C2 那一段把 5 个真实项目名一次性列全，C3 的碰撞表还带 7 个本机临时目录名 | ①§0/C1 的 `name ↔ cwd` 对照表全部换占位符（`<project-B>` / `<project-J>` / `<project-I>` / `<project-E>` 等）；②C2 的「5 个不同项目」名单换成 `<project-A…E>`，那串 `C--Users-<user>-A…` 换 `<tmp-slug-prefix>`；③C3 的 4 组碰撞表逐条换（含 7 个 `ow-*` 临时目录 → `<scratch-dir-1…7>`）；④A3 的 `session <uuid> (<pid>.json)` 与 `cwd="…"` 换占位符；⑤§6 复现命令里的 `.tmp-rt2/` 保留（目录已 gitignore，名字本身不含信息） |
| `docs/research/2026-11-04-waiting-notification-diagnosis.md` | **SANITIZE** | 45 秒迟到那条事故的完整时间线，是验收标准 F1 的证据来源 | 会话快照的 `sessionId` / `hostSessionId` / `cwd` / `pid` / `pidDomain` 全部换占位符（`pidDomain` 原本含主机名）；日志行的 slug 换 `<project-J-slug>`；Toast 载荷里的项目名换占位符 |
| `docs/research/2026-11-04-watcher-silent-failure.md` | **SANITIZE** | 见 7.3 的专项说明——本批唯一一份**脱敏后仍值得公开**的本机诊断 | 用户目录下的 `AppData\Local\Overwatch` 绝对路径 → `<user-home>\AppData\Local\Overwatch`；仓库根绝对路径 → `<repo>`；MSIX 包哈希 → `<pkg-hash>`；进程链三个 PID → `<pid-A/B/C>`；NTFS 文件 ID → `<file-id-A>` |
| `docs/spec/2026-11-04-notify-fix-acceptance.md` | **SANITIZE** | 预先声明的验收标准，方法论价值最高（它自己的 §8 就有一份「污染披露」）。判 SANITIZE 而非 PRIVATE 的理由与 `2026-11-02-autorelay-acceptance.md` 相同：通篇是「什么算修好了」，不含任何通道或凭据 | 示例 slug / 中文会话名 / `cwd` 样例换占位符。**因为这份文件自带「不许事后改标准」的硬规则**，改动以 §7 的「修订 1」形式追加，明写「改的是示例取值、判定规则一字未动、发出时未看到修复结论」 |
| `docs/design/2026-11-04-next-phase-plan.md` | **SANITIZE** | 下一阶段规划的完整推演，含五个 Agent 的可用 prompt 骨架；用户原话已由作者抽象成「让工具中的 AI 能读到对话的具体内容…」这类非业务表述 | `%LOCALAPPDATA%\Overwatch\…` 保留（环境变量）；守护进程 PID → `<pid-A>`；一处会话显示名 → `<project-J-name>` |

**本批统计**：共 **13 份**（任务清单列了 12 份，另加 `docs/spec/2026-11-04-notify-fix-acceptance.md` —— 它也是本批新增、且是修复报告引用的验收标准，必须一并判定）。其中 `PUBLIC` 3 份，`SANITIZE` 10 份，`PRIVATE` **0 份**。

### 7.2 为什么本批没有 PRIVATE

上一批 5 份 PRIVATE 的共同点是**给出了可执行的东西**：帧格式、免认证端点、ACL 面、令牌位置、宿主口子清单。
本批 12 份没有一份具备其中任一条：

- 三份对手/协议调研的「对象」是公开仓库与公开文档，泄漏面为零。
- 其余九份的对象是**本仓库自己的守护进程逻辑**（`watch.mjs` 的探针、去重、派发、TTL）。
  这类内容的敏感度只有一层：**它引用了哪台机器上的哪些会话**。把这层换掉，剩下的就是
  「通知系统为什么会误报」这类任何做 cron 告警的人都能用上的推理。
- 唯一擦边的是 `watcher-silent-failure.md`：它详细写了 MSIX 虚拟化怎么骗过诊断工具。但它给的是
  **判别方法**（`\\?\` 前缀、WMI 起非虚拟化进程、fsutil 按文件 ID 反查），不是**攻击方法**——
  这三条都是微软公开文档里的常规排障手段，且它们的用途是「读到自己机器上的真实文件」，
  不是「读到别人机器上的文件」。所以判 SANITIZE。

### 7.3 `watcher-silent-failure` 的单独说明（任务里点名要求判断）

任务问「含本机路径的，要看脱敏后还剩多少价值」。答案是**剩得很多**，理由三条：

1. **它是一个可复用的排障范式**：现象（进程活着但文件不动）→ 三个候选根因 → 逐条判定 →
   一个 5 分钟可跑的判别实验。落在这类坑里的不只是 Overwatch，任何「在 Claude/Codex 会话里
   读 `%LOCALAPPDATA%` 的监控脚本」都会中招。
2. **它推翻了一个看起来很硬的结论**：主线程当时报的三条「已确认事实」全部不成立，
   而报告把「我前半段也在影子视角里取证」写在结论里，而不是藏起来。
3. **它的敏感部分是「这台机器有两个目录」这个事实**，而这个事实的本机指认（主机名、包哈希、
   文件 ID、PID 链）已经全部换成占位符。剩下的「MSIX 会重定向 `%LOCALAPPDATA%`」是微软公开行为。

代价是它读起来比原来费劲一点（占位符多了），但**技术结论、实测数字（41857 vs 606090 字节）、
实验步骤一个字未改**。

### 7.4 本轮实际替换的敏感项清单（复核用）

| 类别 | 实例（脱敏前的**形态**，具体取值不再转录） | 换成 |
|---|---|---|
| 绝对路径 | `<用户目录>\AppData\Local\Overwatch`、`<盘符>:\Projects\<repo>`、`<盘符>:\Projects\<某父目录>\…` | `<user-home>` / `<repo>` / `<盘符>:\\<project-J-parent>` |
| 机器/包指纹 | `AnthropicPBC.Claude_<15 位包哈希>`、NTFS `Parent FileRef#`（16 位 hex） | `<pkg-hash>`、`<file-id-A>` |
| 进程 ID | 守护进程、其父 `cmd`、`wscript`、会话宿主共 5 个 | `<pid-A>` … `<pid-E>` |
| 会话 UUID / 短 ID | 4 个完整 UUID（含一个 `local_` 前缀的宿主会话 ID）、5 个 8 位短 ID | `<session-S/T/Y-uuid>`、`<host-session-uuid>`、短 ID `<session-S…X>` |
| 真实项目名 | 12 个会话显示名 + 它们对应的目录名（含一个中文名、一个带感叹号的英文名、一个 `dsh-` 前缀名） | `<project-A…L>` 及其 `-name` / `-slug` / `-dir` 变体 |
| 临时目录名 | 7 个 `ow-*` / `*probe` 形态的盘根临时目录 | `<scratch-dir-1…7>` |
| 主机名 | `pidDomain` 字段里的 `win32:<主机名>` | 保留占位形态，主机名原值抹掉 |

> **这一节不再列出原值。** 上一节的「替换前」列原本按类别抄了实例，那本身就是二次泄漏——
> 同一批名字已经在被脱敏的文档里被清掉，没有理由在清单里再写一遍。
> 需要逐个核对原值时，查 `git show <这次提交之前的 HEAD>:docs/research/2026-11-04-*.md`（本机可读）。

**未替换、且有意保留的**：
- `%LOCALAPPDATA%` / `%TEMP%` / `%USERPROFILE%`——环境变量，不是本机路径。
- `OmniSight` / `Overwatch`——本仓库自己的名字，README 首行就有。
- `sqkl520`——GitHub 账号，clone URL 已公开。
- 去重键的 16 位 hex 与 `tool_use_id`——见 7.1 表格里 `dedup-key-analysis` 那行的理由。
- 各工具的版本号（`2.1.289` / `2.1.308` / `1.19.2` / `0.163.0`）——公开的版本标识，
  且它们是「这条实测是在哪版上做的」的必要限定语。

### 7.5 两个怪文件的复核

任务点名的两个根目录文件：

```
D:ProjectsOverwatchtasksruns2026-11-02-path-b-recountdbdump2.out.txt
D:ProjectsOverwatchtasksruns2026-11-02-path-b-recountlatency10.out.txt
```

**它们已经不在了。** 复核方式：`ls -1 | grep -i ProjectsOverwatch` 返回空；
`find . -maxdepth 2 -name '*.out.txt'` 在仓库根命中 0 个；`git ls-files | grep ProjectsOverwatch` 也返回空。
它们由上一轮（`§二`）删除，本轮确认删除状态仍然成立、没有被任何工具重新生成。

> 顺带核到一件更重要的事：`tasks/runs/2026-11-02-path-b-recount/` 里**同名的正常产物**
> （`dbdump2.out.txt` / `latency10.out.txt`）**含真敏感内容**——它们是第三方网关的探针矩阵，
> 带完整端点 URL、`providers` 表、认证失败原文。**该目录已 gitignore，本次不提交**，
> 但这一条值得写下来：上一轮删掉的只是「路径拼接失败」的垃圾，正主还在 `tasks/runs/` 里。

