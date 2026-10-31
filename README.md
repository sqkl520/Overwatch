# Overwatch · OmniSight

> **Omni（全）+ Sight（看见），双关 Oversight（监督）。**
> 它看见的不是一个会话，而是所有 AI 对话的全景。
> **Oversight —— 无处不在的监督，而不是无处不在的干预。**

---

## ⚠ 能力边界（先读这一段）

**本库不能自动接力。**

Relay 会产出接力草稿，但**需要你复制并发送**。原因是宿主的注入语义：

> `claude --help` 中 `--bg --resume <session-id>` 的原文：
> continues that session in the background under the same ID, **or starts a copy and says so when the session is already running**

目标会话正在运行时，注入落到副本上，你的窗口里不会出现任何东西。宿主虽有跨会话消息通道（本机 8 个交互会话全部注册了 `messagingSocketPath`），但投递必须标注来源，无法做到「无痕模仿用户」。

**因此本库无法独立满足原始设计稿 §1「会话写入不可降级」的要求。** 我们选择如实声明，而不是假装满足。完整推演见 [ADR-0001](docs/adr/0001-config-only.md) 与 [ADR-0002](docs/adr/0002-honest-degradation.md)。

### 它实际能做什么

| 能 | 不能 |
|---|---|
| 扫描所有会话，重建它们的真实状态 | 实时干预运行中的会话 |
| 判定 `PRODUCING` / `EXPLORING` / `STALLED` / `FAILED` | 强制 Agent 遵守判定（判定靠约定，无运行时强制） |
| 发现停滞并生成带具体下一步的接力草稿 | 自动把草稿发进目标会话 |
| 用四状态模型避免「误判 → 全量重跑 → 再误判」死循环 | 实时上报心跳（只能事后重建） |

---

## 30 秒上手

```bash
git clone https://github.com/sqcola/Overwatch.git
cd Overwatch
node scripts/scan-sessions.mjs --days 3
```

输出示例：

```
OmniSight 会话扫描 · 最近 3 天 · 12 个有活动的会话
liveness: reconstructed（事后重建，非实时上报）

宿主注册的活跃会话 8 个：
  idle  Let's learn English!               可投递(带来源标注)
  busy  OmniSight 跨对话监督调度                可投递(带来源标注)

[PRODUCING] Projects/Overwatch   calls=  440 sub= 6 depth=1 novelty=0.93 hb=7s/120s   idle=2s   persistent-change-in-window
[EXPLORING] Projects/dsh/fcl     calls= 1155 sub=11 depth=1 novelty=1.00 hb=0s/120s   idle=41s  read-only
```

零依赖，只需 Node ≥ 18。

---

## 目录地图

```
Overwatch/
├─ .claude/
│  ├─ agents/          12 个角色定义（唯一真源，宿主直接加载）
│  └─ skills/oversight/  调度入口 /oversight
├─ docs/
│  ├─ GUIDE.md         使用手册：你会看到什么、该做什么
│  ├─ CHANGELOG.md     改了什么，按工作阶段记录
│  ├─ spec/            六份规格：四态模型 / 派发契约 / 证据纪律 / 接力协议 / 输出格式 / TUI 视觉
│  └─ adr/             两个决策记录：为什么纯配置库、为什么诚实降级
├─ scripts/
│  ├─ scan-sessions.mjs    「眼睛」：扫描会话并判定四态
│  ├─ oversight-tui.mjs    终端界面：列表 / 详情 / 帮助 / 草稿
│  ├─ tui-theme.mjs        四态字形与配色（单一真源）
│  ├─ check-structure.mjs  结构硬门
│  └─ *.test.mjs           189 条回归测试
├─ tasks/
│  ├─ dev-findings.md      范围外发现（不许自行修）
│  └─ accepted-deviations.md  已知不修（不计入判定）
└─ templates/          派发 / 验收标准 / 接力消息 / findings 模板
```

**每个目录都有真实内容，没有占位目录。** `scripts/check-structure.mjs` 会验证这一点。

---

## 三个脚本

| 命令 | 用途 |
|---|---|
| `node scripts/oversight-tui.mjs` | **主界面**。列表 → `Enter` 详情 → `c` 复制接力草稿。非 TTY 自动降级纯文本 |
| `node scripts/scan-sessions.mjs --days 3` | 一次性快照，输出纯文本或 `--json` |
| `node scripts/scan-sessions.mjs --recalibrate --days 7` | 重算 novelty 权重（换机器或工作方式变了就跑一次） |

完整说明见 **[docs/GUIDE.md](docs/GUIDE.md)**。

---

## 核心概念

### 四态模型

不是「成功 / 失败」二分。把「没有交付物」和「没有报错」混为一谈，会让正常探索期被判失败，进而全量重跑，再被误判——死循环。

| 状态 | 判据 | 处置 |
|---|---|---|
| `PRODUCING` | 窗口内有**持久化变更**（Write/Edit，或 Bash 写命令） | 不干预，等验收 |
| `EXPLORING` | 只读工具且轨迹新颖 | **不干预**，只做预算管理 |
| `STALLED` | 连续 3 窗 novelty < 0.2 且无变更 | 探针 → 收窄 → 重新拆解 |
| `FAILED` | 心跳超自适应阈值 / 工具报错 / 预算耗尽零增益 | 全量重跑（**唯一允许重跑的状态**） |

判定是**有序互斥**的，首个命中即返回。完整定义见 [docs/spec/state-model.md](docs/spec/state-model.md)。

### 为什么阈值不是固定值

实测本机 2021 个 transcript、239,549 次调用（2026-10-30）：

- 至少一次 >180s 间隔的会话占 **63.1%**
- 全部间隔中 >180s 占 **9.72%**，p99 = 1444s

按固定 180s 判 FAILED，六成以上会话会被判死至少一次。所以阈值改为**每个会话自身的 p95**（夹在 120s–900s 之间）。

---

## 设计原则

1. **主线程只做三件事**：拆解、派发、汇总。不亲自检索、分析、编码、写作。
2. **锐评与验收是两道独立的门**：锐评管「好不好」，验收管「过不过」。混了就变成一个人的左右手。
3. **只读靠工具白名单，不靠 prompt**：`acceptor` / `review` / `redteam` / `critic` / `safety` / `probe` 的 `tools` 中没有 `Edit`。`check-structure.mjs` 会验证。
4. **禁止静默共识**：多个 Agent 结论相同时，必须至少一个被要求找反面证据。找不到反面证据 ≠ 结论正确。
5. **token 充足不意味着可以跳过辩论**，只意味着辩论可以更深、更狠。
6. **「看见它在读文件」就算活着** —— 除非它读的是同一个文件第 4 次。

---

## 参考与致谢

目录结构的组织方式参考了 [Let's Learn English](https://github.com/sqkl520/Minecraft-server-plugin-Let-s-learn-English) 的双层工作区模式，但**刻意不照搬**：

- **借鉴**：控制层与发布层分离、四件套证据纪律、两本台账、机器可读的验收标准、agent 工具白名单限制写权限。
- **丢弃**：`versions/` 提交二进制、`tasks/` 占 42% 跟踪文件、`agent-memory` 多份分叉副本、硬编码本机路径、单版本 449 行的 CHANGELOG。
- **警惕**：那个项目的 `.gitignore` 忽略了 `.claude/`、`rules/`、`tasks/`——对它是正确的（只发布 `src/`），对**本仓库是致命的**，照抄会让 `git add -A` 静默什么都不加。`check-structure.mjs` 专门检查这条。

---

## License

MIT
