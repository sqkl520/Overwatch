# 验收标准（预先声明）

> 本文件必须在**派发执行 Agent 之前**写完。
> 事后增补标准无效——验收 Agent 只能判定这里已有的条目。

## 元信息

```
run_id: 
subtree: 
declared_at: 
declared_by: oversight-planner
```

## 判定项

> 格式约束：
> - `criterion` 必须是**可观测事实**，不能是「质量良好」这类判断
> - `evidence` 必须是可引用的形式（`file:line` / 命令输出 / 原文引述）
> - `fail_if` 必须写明「什么情况直接否决」，没有否决条件的标准等于没有

### AC1

```yaml
criterion: 
evidence: 
fail_if: 
```

### AC2

```yaml
criterion: 
evidence: 
fail_if: 
```

### AC3

```yaml
criterion: 
evidence: 
fail_if: 
```

## 产出形态

```yaml
shape: artifact | exploration | hybrid
token_budget_pct: 
timeout_min: 
```

## 反例：什么不算合格的验收标准

| 不合格 | 为什么 | 改成 |
|---|---|---|
| 「代码质量良好」 | 无法观测 | 「所有公开函数有类型标注，`tsc --noEmit` 无错误」 |
| 「功能正常」 | 无法观测 | 「运行 `npm test`，全部用例通过，输出含 `pass 19`」 |
| 「文档完整」 | 无法观测 | 「`README.md` 含安装、使用、限制三节，每节至少一句话」 |
| 「性能可接受」 | 无法观测 | 「`scan-sessions.mjs` 扫描 100 个会话耗时 < 3 秒（实测）」 |
