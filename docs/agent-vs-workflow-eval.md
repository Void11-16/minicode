# Agent vs Workflow 评测

目标不是证明“Agent 更强”，而是回答：

> 在同一批需求、同一套工具、同一份数据、同一个校验器下，workflow 和 agent 各自在哪些案例上更好，代价是什么？

## W1 workflow 基线

`src/eval/workflow.ts` 实现 W1：

```text
结构化 brief
  -> search_attractions / search_stays
  -> get_place_visit_info
  -> 确定性分配日期和景点
  -> save_itinerary(outline)
  -> save_itinerary(schedule) 每天
  -> 加入住宿
  -> plan_day_routes + repair_routes
  -> validate_itinerary
```

特点：

- 复用与 Agent 完全相同的工具、证据仓库、行程 schema 和 validator
- 不经过 `ChatAgent` 循环，不调用模型
- 有界修复：日程冲突时先降低非必去景点时长，再减少候选，不无限重试
- 固定世界评测，无真实网络

当前 W1 使用固定世界案例里的结构化字段（日期、必去、预算）作为 brief。它是“结构化输入”的上界基线；下一版应替换为一次 LLM 需求抽取，并扩大到原始自由文本案例。

## 公平比较规则

1. **同环境**：固定世界快照，相同版本和哈希
2. **同输入**：同一 `EvalCase`
3. **同工具和 validator**：同一 `createDefaultRegistry`、同一 `computeItineraryMetrics`
4. **同预算口径**：记录工具调用、token、成本、耗时；Workflow 无模型成本单独标注
5. **多次运行**：LLM 有随机性，单次结果只能用于管线验证
6. **预定义成功标准**：天数完整、P0/P1=0、必去覆盖、requirements 通过
7. **失败分类**：generation / quality_gate / evaluation / provider / environment

## 运行

```bash
# Agent 固定世界
npm run eval:world -- --run-id agent-test-1

# W1 Workflow 固定世界
npm run eval:workflow -- --run-id wf-test-3

# 对照报告：JSON / Markdown / HTML
npm run eval:compare -- --agent agent-test-1 --workflow wf-test-3
```

报告目录：`eval/compare/<agent>__vs__<workflow>/`。

## 固定世界单案例结果

| 指标 | Agent | Workflow |
| --- | ---: | ---: |
| Strict 通过 | 否（P1=1） | 是 |
| 质量分 | 97 | 99 |
| 估算成本 | ¥0.2819 | ¥0 |
| 耗时 | 43.2s | 3.6s |
| 工具调用 | 43 | 23 |
| 工具轮次 | 34 | 9 |

结论只适用于这个固定、结构化的三日案例：

- Workflow 在稳定场景上明显更便宜、更快，质量也更高
- Agent 出现了一次工具参数错误（`search_restaurants` 传了未声明的 `city_center`）
- Agent 的成本和延迟来自 34 轮工具循环；这在需要动态修复时是优势，在稳定场景是开销

不能从这个单案例得出“workflow 普遍更好”。下一步需要覆盖：

- 模糊需求、冲突约束、临时改需求
- 外部数据缺失、限流、闭馆
- 多日、远郊、老人/亲子等边界案例
- 每个 case 跑 3 次，报告 pass@1、均值和方差

## 失败分类

建议在对照报告中固定使用：

| 阶段 | 含义 |
| --- | --- |
| `generation` | 未产出可评测行程、工具调用失败、schema 冲突 |
| `quality_gate` | 有行程，但天数/P0/P1/requirements 未通过 |
| `evaluation` | 行程无法解析或指标计算失败 |
| `provider` | 模型网络/限流/返回格式失败 |
| `environment` | 固定世界快照未覆盖请求 |

## 面试讲解

推荐的结论不是“Agent 赢了/输了”，而是：

> 我们用固定世界和同一套工具做了对照。W1 workflow 在结构化三日案例上 99 分、0 成本、3.6 秒；Agent 97 分、¥0.28、43 秒，并出现一次工具参数错误。下一步不是继续堆 Agent 功能，而是扩大到模糊需求、异常数据和冲突约束，找出 workflow 需要硬编码分支、Agent 能动态修复的区间。

这比“我的 Agent 很强”更可信，也直接展示评测设计、成本意识和架构取舍。
