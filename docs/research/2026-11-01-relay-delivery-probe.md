# 跨会话投递验证结果

- 日期：2026-11-01
- 目的：验证「全自动接力」是否可行
- 方法：逆向 `claude.exe` 2.1.270 + 真实投递测试
- **结论：默认配置下不可行。消息会被扣住，不送达。**

## 一、能做的部分（已实测）

| 事实 | 证据 |
|---|---|
| 8 个会话全部注册 `messagingSocketPath` | `~/.claude/sessions/*.json` |
| Windows 命名管道 **8/8 连接成功** | `scripts/probe-relay.mjs` |
| `peerToken` 全部可读（32 位 hex） | `<pid>.<sha256>.key` |
| 协议版本全部是 v1 | `peerProtocol: 1` |

**投递通道本身是通的。**

## 二、做不了的部分（真实投递实测）

向 idle 会话 `PerfScope`（pid 14568）发了一条测试消息：

```
发送中…
回音： []
判定：unknown —— 没有任何回音
```

**没有任何回音，接收方 status 也没变**（仍停在 32 分钟前）。

### 为什么

从二进制里挖出的完整拒绝原因列表：

```
The recipient session is not accepting cross-session messages
  (the feature is off there, or a setting or policy there refuses them)

Your message is held for the recipient user's approval before it reaches
  their Claude session (permission-mode parity).

The recipient user declined your message.

Your held message expired without approval.
```

以及默认策略的原文：

```
Your "crossSessionInbound" setting is "hold";
set it to "accept" to deliver held messages.
```

**默认是 `hold`：所有入站消息被扣住等人批准，不送达会话。**

## 三、更硬的限制：权限类必须一致

逆向里还有一句：

```
[that session runs in the same permission class as this one (or is ...)]
```

**只有收发双方处于同一权限类，消息才可能直接送达。**
而 `permissionMode` **不在 `sessions/*.json` 里**（实测 8 个会话全部无此字段），
所以发送方**无法从外部判断**能不能送达。

这不是「改一个设置」能解决的——即使把 `crossSessionInbound` 设成 `accept`，
权限类不匹配的消息仍然会被扣住。

## 四、对本项目意味着什么

原计划的三条路线，实际可行性：

| 路线 | 可行性 | 原因 |
|---|---|---|
| **全自动投递** | **不可行**（默认配置下） | 消息被 `hold`，且权限类检查从外部不可判 |
| **一键确认** | **可行** | 你按一次 → 你的会话作为**用户**发出，不经过跨会话通道 |
| **按风险分级** | 分级本身可行，但 `auto` 那一半不可行 | 同上 |

**所以规格里的 `auto` 必须降级。**

## 五、修正后的设计

`policy.jsonc` 的 `auto` 语义改为：

```jsonc
{ "action": "auto" }   // ❌ 删掉：技术上做不到
{ "action": "confirm" } // ✓ 保留：一键确认
{ "action": "never" }   // ✓ 保留：只通知
```

**新增一个真正可行的 `auto` 替代**：

```jsonc
{ "action": "prefill" }
```

语义：**把草稿预填进目标会话的输入框**（不是发送）。你切过去按回车即可。
但这需要宿主提供「预填」接口——**目前没有**，所以也做不到。

**结论：`auto` 一栏在当前宿主能力下应当移除，只保留 `confirm` 与 `never`。**

## 六、如果将来宿主支持了

切换条件是（写进规格，避免重蹈「看起来支持其实不支持」）：

1. `crossSessionInbound` 默认 `accept`，或可被发送方检测
2. 权限类可从 `sessions/*.json` 外部读取
3. 投递有明确的送达回执（现在没有回音）

**三者同时满足才能做 `auto`。缺一条就不做。**

## 七、诚实的边界

1. **只测了一个会话**（PerfScope，idle）。不同权限模式下的行为可能不同，但我无法从外部判断权限模式。
2. **没有任何回音**这件事本身也可能意味着我的帧格式不对，而不是策略拦截。
   但逆向文本明确写了 `hold` 是默认行为，所以更可能是后者。
3. **没有改 `crossSessionInbound` 去试**。那需要改全局设置并重启所有会话，
   影响面太大，且 §3 的权限类限制仍然存在——改了大概率也没用。
