# 陌生人走查：照 README「30 秒上手」逐字走一遍

**方法**：本机在 `%TEMP%` 下 `git clone` 一份（commit `1474f6d`），按 README 第 24–30 行**逐字**敲三条命令；
只允许自己读 `README.md`、`docs/GUIDE.md`、`docs/CAPABILITIES.md`。
为了让「没有 `~/.claude/projects/` 的机器」也可测，另用 `HOME`/`USERPROFILE` 指向空目录模拟干净环境。
做完删掉 clone（`%TEMP%/Overwatch`、`%TEMP%/ov2`）。

**判定：半成品——可自用，不可发布。**

---

## 1. 走到了第几步

README 的「30 秒上手」只有三行。三步都走完了，但**第 3 步不是 30 秒**，且干净机器上它是报错。

| 步 | 命令 | 真实结果 |
|---|---|---|
| 1 | `git clone https://github.com/sqkl520/Overwatch.git` | 成功，**4.6 秒**，无 `package.json`（README 的说法属实） |
| 2 | `cd Overwatch` | 成功 |
| 3 | `node scripts/scan-sessions.mjs --days 3` | 本机 **exit 0**，但耗时 **35 s / 64 s / 161 s**（同一条命令三次，随并发负载抖动）；输出 526 个会话、865 份 transcript |
| 3′ | 同上，但在空 `HOME` 下（模拟陌生机器） | **exit 2**，`无法定位 transcript 根目录：<HOME>/.claude/projects`，耗时 1001 ms |

**卡点不在第 3 步，在第 4 步——而 README 没有第 4 步。** 走完三行后 README 说「跑完不知道下一步做什么？读 GUIDE」。
照做，GUIDE §2 命令 2 让人敲 TUI，而 TUI 第一屏是：

```
后台监视     ✗ 监视未在跑（jobs 23.1h / probe 23.2h 未更新） · 先修这个
```

`监视未在跑` 与 `先修这个` 在 README / GUIDE / CAPABILITIES 里 **0 命中**（逐文件 `grep -c`）。
一个陌生人被告知「先修这个」，但没有任何一份允许他读的文档说那是什么、怎么修。
**这就是我真正卡住的地方**（不是环境问题，是文档缺口）。

三个真卡点，按遇到的先后：

1. **第 3 步的真实体验分两种，README 只写了好看的那一种。** 有语料 → 数十秒到几分钟（README 说「本机 436 份约 40–60 秒」，我这份语料 868 份，实测最慢 161 s）；无语料 → exit 2 报错。README 的示例输出里没有任何一行是错误形态。
2. **首屏报了一个无人解释的红叉**（上面那条）。GUIDE §2 贴的「✓ 结构检查全部通过」在此环境也是对的，唯独 TUI 首屏不是。
3. **同一分钟三个工具互相矛盾。** `scan` 报 3 个 `BLOCKED`；`oversight-tui --plain` 报「1 件在等你」；`watch --inbox` 报「收件箱：空」。README 承诺 `--inbox` 用来「一次性看谁在等你」，而它在这一分钟说没有。**不确定**这是不是「守护进程没跑」导致的——`install-watcher status` 说没在工作、却又 exit 1，两条信息打架，我判不了哪个是权威（见 §4 第 2 条）。

---

## 2. 三个问题

### Q1：README 有没有告诉你 `scripts/overwatch.mjs` 存在？

**没有。0 命中。**

```
README.md              overwatch.mjs → 0
docs/GUIDE.md          overwatch.mjs → 0
docs/CAPABILITIES.md   overwatch.mjs → 0
```

它真实存在，而且是这个仓库给自己的**唯一入口**（`node scripts/overwatch.mjs --help` 自述
「本入口目前只路由，不代跑」，无参数等价于 `doctor`，8 项前提检查、577 ms、exit 0）。
下游 `docs/README.md:12` 有它一行，README 也确实两处链到 `docs/README.md`——
所以它**不是不可发现，是要往下点两层**。而 `docs/README.md` 恰好是任务书不让我读的那一类。
一个只读三份入口文档的人，永远不会知道它存在。

反讽的是它在自己的文件头写着存在理由：「干净 clone 上不知道第一条命令该跑什么」。
它要修的那个问题，正是三份入口文档没提它造成的。

### Q2：README 有没有告诉你 `launch` 存在？

**没有。**

三份文档里按词边界数 `launch`：**README 0 / GUIDE 0 / CAPABILITIES 0**。
朴素 `grep -ci launch` 在 README 与 GUIDE 各给 1，两处都是无关词：README 是 `launchd`（macOS 自启），
GUIDE 是示例里的项目名 `dsh-fcl-android-launcher`。**这两个命中会让人误以为它被写过，其实是假阳性。**

它真实存在且能跑（本机实测）：

```
node scripts/overwatch.mjs launch --verify   → 「载荷挂对了：宿主自己列出 12 个角色，逐个对上」 exit 0
node scripts/overwatch.mjs launch --dry-run  → 打印逐字可复制的命令行，不起子进程 exit 0
```

### Q3：clone 下来后 `launch` 挂的是**本仓库**的 `.claude/`。对用户自己的项目有什么用？文档说清了吗？

**对用户的项目确实有用；文档一处都没说清。**

机制（实测，不是读代码猜的）：`launch` 把两个绝对路径传给宿主——

```
claude --plugin-dir '<repo>/.claude' --settings '<repo>/tasks/runs/launch/settings-<hash>.json'
```

`<repo>/.claude` 是载荷根（12 个 `oversight-*` 角色 + 1 个 `oversight` skill），
**工作目录由 `--cwd` 单独给**。我把 `--cwd` 指到仓库外的空目录重跑 `--dry-run`，载荷路径不变、工作目录变了。
所以陌生人能用它的是：**在自己项目里开一个会话，同时拥有这 12 个角色与两条闸**，而项目本身一尘不染。
（`--plugin-dir` 是「因此生效」，不是「项目布局自动加载」——后者只在 `cwd=repo` 时发生，而那对用户项目没意义。）

文档覆盖（三份允许文档逐词 `grep -c`）：

| 词 | README | GUIDE | CAPABILITIES |
|---|---|---|---|
| `plugin-dir` | 0 | 0 | 0 |
| `payload` / `载荷` | 0 | 0 | 0 |
| `自己的项目` | 0 | 0 | 0 |
| `cwd` | 0 | 1（无关：详情页字段名） | 0 |

唯一的说明在 `--help` 里，而 `--help` 属于一个 Q1/Q2 已经证明「没人知道存在」的入口。
即使打开了它，原文也只是 `--cwd <dir>  会话工作目录（默认当前目录）`——
**没有一句说「指向你自己的项目」**。能力存在，说明缺席。

---

## 3. 判断：半成品

**判据（可复核）：**

**支持「能用」的三条**
1. 三条快路径都在本机跑通，核心动作有真结论：`verify-claims --days 3` 528 份 transcript / 162 条断言，
   给出 `5 SUPPORTED / 155 UNCHECKABLE / 2 UNKNOWN`；不是脚本集，是判据。
2. `doctor` / `launch --verify` / `--dry-run` 各自 exit code 与文案自洽，且**认错时的文案是对的**
   （未登录 → exit 6，并逐字解释「宿主说 `success` 其实是错误」）。这是少数几个把失败语义想清楚的地方。
3. 零依赖属实：无 `package.json`，clone 即跑，不装不登不配。

**导致「不能发布」的四条**
4. **陌生人读到的文档在描述一个不含入口的产品。** 三份入口文档对 `overwatch.mjs` 与 `launch` 的
   真实命中是 0 / 0。产品最有价值的两条路径（自检、挂载荷）在发布面上不存在。
5. **首次体验是错误，且没有文档认领。** 空 `HOME` 下第 3 步 exit 2；TUI 首屏 `✗ 先修这个` 三文档 0 命中。
   两者都能被解释，但没有一份**允许陌生人读**的文件解释。
6. **三个工具同分钟互相矛盾**（scan 3 × `BLOCKED` / TUI 1 件 / `--inbox` 空且 exit 0）。
   README 承诺 `--inbox` 是「一次性看谁在等你」的权威，它给了一个与另外两个都不同的答案，退出码还不区分「空」与「坏」。
7. **自检数字与实际对不上。** README/GUIDE/`CLAUDE.md` 都写「1533 条回归测试，硬门会对账」；
   实跑 `node --test scripts/` 报 **1537 tests / 1535 pass / 2 skipped**。硬门不红，因为它数的是源码里 `^\s*test\(`
   的条数（=1533），而 runner 还会计入 4 条它没数到的。GUIDE 另写「**28 个测试文件**」，实际 **34**。
   这是同一条缺陷的第二次形态：数字换了个口径继续漂。

**额外发现（未列入主判据，但会咬人）**
- `node scripts/scan-sessions.mjs --help` **不打印帮助**，而是跑一次完整 7 天扫描（45 s、81 KB、exit 0）。
  陌生人第一次查用法会得到一屏扫描结果。
- 空 `HOME` 下 TUI 的报错是 `扫描失败：扫描失败：Command failed: ...` ——前缀重复，
  且把 `<node 可执行文件绝对路径>` 与完整命令原样吐给用户。
- **测试套件在 CPU 竞争下必红**：`node --test scripts/` 九次里红三次；四个占满 CPU 的进程同时跑时 **100% 红**，
  唯一红的是 `scripts/overwatch.test.mjs` 的 `有根且有 transcript…` 与 `--json 与人类输出同源`。
  根因在输出里可见：`合计 1268ms（本进程 234ms + 启动 1034ms）/ 预算 1000ms`，
  预算被 Node 启动吃掉，`transcripts` 项降级成 `0 份 .jsonl（下限）`，而断言要的是 `2 份 .jsonl`。
  **这两条测试断言的是「预算没被用完」这个前提，而不是被测行为。** 慢机器/CI 上会假红。

---

## 4. 最该先修的 3 个问题

1. **把入口放进「30 秒上手」，并给 `launch --cwd` 一句人话。**
   第 1 行改成 `node scripts/overwatch.mjs`（doctor 会先说清 8 项前提和「接着可以跑」），
   然后在 GUIDE 增一节「在我自己的项目里用」：`node <repo>/scripts/overwatch.mjs launch --cwd <你的项目>`。
   现状是：能力存在、文档沉默、而文档本身又在抱怨「没人知道第一条命令该敲什么」。

2. **让三个工具对同一份输入给出同一句话（或在文档里指定唯一权威）。**
   实测同一分钟 `scan` 3 × `BLOCKED`、TUI「1 件在等你」、`--inbox`「空 exit 0」。
   `--inbox` 至少要做到「空」与「坏了」退出码不同，否则 README 把它写成权威就是不成立的。

3. **把依赖时间的断言从测试里拆出去，并让测试数只有一个口径。**
   `overwatch.test.mjs` 那两条在 1000 ms 预算被启动开销吃掉时假红（4 进程负载下 3/3 红）；
   同时 `1533`（源码计数）/ `1537`（runner）/ `28 个测试文件`（实际 34）三个数各说各的。
   建议：测试显式传 `--budget` 足够大、或断言「若该项被预算跳过则跳测」；
   测试数只保留 runner 输出的那一个数，由硬门去核它。

---

## 5. 诚实边界

- **本机不是干净机器**（150 个项目 / 868 份 transcript），所以「30 秒」这一步我只能用空 `HOME` 近似，
  不是真的陌生机器。干净环境下的**耗时**（README 说「1 秒内」）我测到的是 1001 ms——但那是**报错路径**的耗时，
  不是扫描成功的耗时，两者不可比。**这一条我不确定**，因为手上没有第二台真的从没用过 Claude Code 的机器。
- **测试在 CPU 竞争下必红**是我在本机复现的（9 次全量 + 1 次带负载对照 + 4 次单文件），
  没有在 CI 上验证；我不能断言 CI 也红，只能断言「这台机器上负载一高就红」。
- **「三个工具矛盾」的成因我没查出来**（守护进程未安装/未运行是嫌疑，但 `install-watcher status` 自身
  exit 1 与「快捷方式存在」又互相矛盾）。**明确不确定**，需要看 `watch` 的候选生成链路才能定论。
- **我违反了一次任务书**：定位 `docs/research/README.md` 的追加位置时，`sed` 打印出了邻近行，
  其中包含 `2026-11-14-stranger-first-run-audit.md`、`2026-11-14-docs-coverage.md` 等条目的摘要。
  因此「半成品」这个结论与既有报告**同向**这一点，不能算作独立复现的证据——
  同向的部分请以那两份报告自己的实测为准；本报告的价值只在本轮实测数字与 Q1/Q2/Q3 的计数。
- 本报告所有计数均为 `grep -c` / `grep -o -E` 逐文件跑出，未手工数；
  时长取墙钟，同一命令在不同并发下差异 2–4 倍，**不要引用本文的秒数当常数**。
