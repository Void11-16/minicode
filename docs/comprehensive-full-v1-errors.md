# comprehensive-full-v1 具体错误报告

本文件逐项摘录原始批次的失败原因、质量问题、独立需求验收失败及执行错误。历史分数与状态保持原样；本次未重新调用模型或改写批次。

- 自动结果：5/12 通过，7 未通过。
- 模型：deepseek/deepseek-chat；提示词：travel-v25；套件：comprehensive@2026.11.2。
- 原始汇总：[report.md](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/report.md) · [report.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/report.json)。
- “最终质量问题”来自保存的 .quality.json；“独立验收”来自 attempt 指标，两者不是同一份检查。例如福州通用 P1 为 0，但用户时间窗验收失败。
- 执行错误示例保留 Session 中实际可见的原文；历史会话经过压缩，可见错误条数可能与完整工具诊断计数不同。

## 未通过案例索引

| 案例 | 天数 | P0/P1/P2 | 原始质量报告 | 原始执行记录 |
| --- | --- | --- | --- | --- |
| 杭州两日游亲子版 | 0/2 | 0/4/0 | [质量明细](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/hangzhou-2d-family/attempt-1/plans/杭州亲子两日游.quality.md) | [Session](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/hangzhou-2d-family/attempt-1/session.json) · [诊断](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/hangzhou-2d-family/attempt-1/tool-diagnostics.json) |
| 苏州三日游长辈版 | 3/3 | 0/1/9 | [质量明细](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/suzhou-3d-senior/attempt-1/plans/苏州三日慢游携70岁父母.quality.md) | [Session](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/suzhou-3d-senior/attempt-1/session.json) · [诊断](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/suzhou-3d-senior/attempt-1/tool-diagnostics.json) |
| 成都三日游素食版 | 2/3 | 0/4/10 | [质量明细](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chengdu-3d-vegetarian/attempt-1/plans/成都三日人文街区素食之旅.quality.md) | [Session](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chengdu-3d-vegetarian/attempt-1/session.json) · [诊断](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chengdu-3d-vegetarian/attempt-1/tool-diagnostics.json) |
| 北京三日游固定住宿版 | 0/3 | 0/6/0 | [质量明细](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/beijing-3d-fixed-hotel/attempt-1/plans/北京三日游.quality.md) | [Session](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/beijing-3d-fixed-hotel/attempt-1/session.json) · [诊断](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/beijing-3d-fixed-hotel/attempt-1/tool-diagnostics.json) |
| 赤峰五日游远郊混排版 | 2/5 | 0/13/14 | [质量明细](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chifeng-5d-remote-mix/attempt-1/plans/赤峰五日自驾游.quality.md) | [Session](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chifeng-5d-remote-mix/attempt-1/session.json) · [诊断](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chifeng-5d-remote-mix/attempt-1/tool-diagnostics.json) |
| 杭州两日游天气备选版 | 2/2 | 0/3/14 | [质量明细](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/hangzhou-2d-weather-backup/attempt-1/plans/杭州两日游.quality.md) | [Session](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/hangzhou-2d-weather-backup/attempt-1/session.json) · [诊断](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/hangzhou-2d-weather-backup/attempt-1/tool-diagnostics.json) |
| 福州四日游慢逛避雷版 | 4/4 | 0/0/4 | [质量明细](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/fuzhou-4d-slow-exclusions/attempt-1/plans/福州四日慢游.quality.md) | [Session](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/fuzhou-4d-slow-exclusions/attempt-1/session.json) · [诊断](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/fuzhou-4d-slow-exclusions/attempt-1/tool-diagnostics.json) |

## 1. 杭州两日游亲子版（hangzhou-2d-family）

- 自动状态：quality_failed；质量状态：needs_revision；分数 0；保存 0/2 天。
- 工具调用 40 次，诊断错误 17 次；Session 可见错误 17 条。
- 原始记录：[attempt.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/hangzhou-2d-family/attempt-1/attempt.json) · [session.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/hangzhou-2d-family/attempt-1/session.json) · [tool-diagnostics.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/hangzhou-2d-family/attempt-1/tool-diagnostics.json)。
- 原始产物：[质量报告](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/hangzhou-2d-family/attempt-1/plans/杭州亲子两日游.quality.md) · [final-itinerary.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/hangzhou-2d-family/attempt-1/final-itinerary.json)。

### 批次原始失败原因

- 行程天数 0/2，未达到案例要求
- P0 0 / P1 4（title-day-mismatch, unmaterialized-outline-day, missing-required-visit, expected-day-count-mismatch）
- room-count: 每晚房数应为 1；未安排住宿

### 独立需求验收失败

- **room-count**：每晚房数应为 1；未安排住宿

### 最终保存版本的全部质量问题

| 等级 | 类型 | 日期/条目 | 错误码 | 原文 |
| --- | --- | --- | --- | --- |
| P1 | 错误 | 全程 | title-day-mismatch | 标题为2日游，实际仅排了 0 天：请补齐缺失日期；若用户已明确缩短行程，再同步修改标题 |
| P1 | 错误 | 全程 | unmaterialized-outline-day | 粗排 2026-11-14 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐 |
| P1 | 错误 | 全程 | unmaterialized-outline-day | 粗排 2026-11-15 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐 |
| P1 | 错误 | 全程 | missing-required-visit | 缺少必去景点「西湖」，请补充游览安排 |

### 执行过程中实际发生的错误（原文示例）

**首个可见错误**（get_place_reviews；call_01_dyfGDUhDRKTQasIbr6NZ5725）

````text
[tool-result type=error chars=171]
工具执行失败: fields必须为hours/closure/last_admission/sessions/notices的非空数组
execution_state: {"execution_status":"failed","effect_status":"none","recovery_action":"manual_review"}
````

**最后一个可见错误**（save_itinerary；call_00_CImxzmgVJiro1Ck9P1Li3496）

````text
[tool-result type=error chars=1488]
工具执行失败: 行程质量校验未通过；未提交任何修改，仍为版本1。路线修复不突破开放/可用时间；已有路线证据保留，只调整报告中的冲突条目，再按单日期repair_routes保存，不要重复查询已有路线。
# 行程质量报告: 杭州亲子两日游

- 状态: 不可用
- 评分: 40 / 100（opportunity-v9，按检查对象归一化）
- 完整度: 50%
- 时间安排: 66.7 分，1/3 个检查对象有问题
- 交通衔接: 83.3 分，1/3 个检查对象有问题
- 资料核验: 96.7 分，1/3 个检查对象有问题
- 行程一致性: 83.3 分，1/3 个检查对象有问题
- 分日验收: D1 待修改
- 建议局部修复日期: 1
- 餐饮策略: 仅建议，不阻断整体；每个适用午晚餐时段目标 2 家，评分及价格证据目标 80%
- 行程问题: P0 1 / P1 4 / P2 1

## P0
- Day 1 · item-f8d5b8d98201193323a4: 杭州西湖风景名胜区 与 杭州西湖风景名胜区 → 桔子水晶杭州钱江新城市民中心酒店 时间重叠（time-overlap）

## P1
- Day 1 · item-50ec8675e89be8302d84: 当天重复安排 杭州西湖风景名胜区（duplicate-place）
- 标题为2日游，实际仅排了 1 天：请补齐缺失日期；若用户已明确缩短行程，再同步修改标题（title-day-mismatch）
- 粗排 2026-11-15 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐（unmaterialized-outline-day）
- Day 1 · item-26d61796c514aba3569f: 杭州西湖风景名胜区 → 桔子水晶杭州钱江新城市民中心酒店 缺少已核验的交通段。请调用 plan_day_routes({"city":"杭州","stops":["杭州西湖风景名胜区","桔子水晶杭州钱江新城市民中心酒店"],"mode":"transit"})，引用返回ID后重新保存；杭州西湖风景名胜区 → 桔子水晶杭州钱江新城市民中心酒店：杭州西湖风景名胜区 → 桔子水晶杭州钱江新城市民中心酒店 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"杭州","stops":["杭州西湖风景名胜区","桔子水晶杭州钱江新城市民中心酒店"],"mode":"walking"})，引用返回ID后重新保存（missing-route-leg；关联检查 missing-route-leg,unverified-route）

## P2
- Day 1 · item-f8d5b8d98201193323a4: [资料待确认] 杭州西湖风景名胜区 → 桔子水晶杭州钱江新城市民中心酒店 缺少数据来源（missing-source）
execution_state: {"operation_id":"sess_1794221746868_47f9f1d4:msg_1794221901815_95:call_00_CImxzmgVJiro1Ck9P1Li3496","execution_status":"failed","effect_status":"not_committed","recovery_action":"fix_arguments","code":"OPERATION_FAILED_NOT_COMMITTED"}
````

### 人工复核项（未自动判定）

- 4岁儿童的午休、厕所和用餐是否方便
- 一间房是否允许两位成人和一名儿童入住

## 2. 苏州三日游长辈版（suzhou-3d-senior）

- 自动状态：quality_failed；质量状态：needs_revision；分数 97；保存 3/3 天。
- 工具调用 46 次，诊断错误 7 次；Session 可见错误 7 条。
- 原始记录：[attempt.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/suzhou-3d-senior/attempt-1/attempt.json) · [session.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/suzhou-3d-senior/attempt-1/session.json) · [tool-diagnostics.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/suzhou-3d-senior/attempt-1/tool-diagnostics.json)。
- 原始产物：[质量报告](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/suzhou-3d-senior/attempt-1/plans/苏州三日慢游携70岁父母.quality.md) · [final-itinerary.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/suzhou-3d-senior/attempt-1/final-itinerary.json)。

### 批次原始失败原因

- P0 0 / P1 1（missing-opening-hours, incomplete-day-end, unverified-closure）

### 独立需求验收失败

本案例已执行的独立需求检查均通过。此结论不涵盖后面的人工复核项。

### 最终保存版本的全部质量问题

| 等级 | 类型 | 日期/条目 | 错误码 | 原文 |
| --- | --- | --- | --- | --- |
| P2 | 待确认 | 第 1 天 2026-11-10 · 拙政园 | missing-opening-hours | 拙政园 缺少开放时间 |
| P2 | 待确认 | 第 1 天 2026-11-10 · 苏州博物馆(本馆) | missing-opening-hours | 苏州博物馆(本馆) 缺少开放时间 |
| P2 | 待确认 | 第 2 天 2026-11-11 · 耦园 | missing-opening-hours | 耦园 缺少开放时间 |
| P2 | 待确认 | 第 2 天 2026-11-11 · 苏州丝绸博物馆 | missing-opening-hours | 苏州丝绸博物馆 缺少开放时间 |
| P2 | 待确认 | 第 3 天 2026-11-12 · 留园 | missing-opening-hours | 留园 缺少开放时间 |
| P2 | 建议 | 第 1 天 2026-11-10 | incomplete-day-end | 当天结束早于参考 18:00；允许提前返店，节奏提示不扣分、不阻断 |
| P2 | 待确认 | 第 1 天 2026-11-10 · 苏州博物馆(本馆) | unverified-closure | 苏州博物馆(本馆) 尚无可核验的闭馆规则，请出发前确认；此项不扣规划分 |
| P2 | 建议 | 第 2 天 2026-11-11 | incomplete-day-end | 当天结束早于参考 18:00；允许提前返店，节奏提示不扣分、不阻断 |
| P2 | 待确认 | 第 2 天 2026-11-11 · 苏州丝绸博物馆 | unverified-closure | 苏州丝绸博物馆 尚无可核验的闭馆规则，请出发前确认；此项不扣规划分 |
| P1 | 错误 | 第 3 天 2026-11-12 | incomplete-day-end | 当天结束早于参考 18:00，缺口超过参考窗口的25%或没有有效活动，请确认是否缺少安排 |

### 执行过程中实际发生的错误（原文示例）

**首个可见错误**（plan_day_routes；call_02_eIGDUadZNvxIpV65SpS14444）

````text
[tool-result type=error chars=143]
工具执行失败: leg_modes 必须为 stops数量减1 个有效交通方式
execution_state: {"execution_status":"failed","effect_status":"none","recovery_action":"manual_review"}
````

**最后一个可见错误**（save_itinerary；call_00_6wjx8QvL4dqxTHvFIjVa8894）

````text
[tool-result type=error chars=1923]
工具执行失败: 行程质量校验未通过；未提交任何修改，仍为版本7。路线修复不突破开放/可用时间；已有路线证据保留，只调整报告中的冲突条目，再按单日期repair_routes保存，不要重复查询已有路线。
# 行程质量报告: 苏州三日慢游（携70岁父母）

- 状态: 不可用
- 评分: 95 / 100（opportunity-v9，按检查对象归一化）
- 完整度: 100%
- 时间安排: 91.7 分，1/12 个检查对象有问题
- 交通衔接: 100 分，0/9 个检查对象有问题
- 资料核验: 95 分，6/12 个检查对象有问题
- 行程一致性: 100 分，0/10 个检查对象有问题
- 分日验收: D1 通过；D2 通过；D3 待修改
- 建议局部修复日期: 3
- 餐饮策略: 仅建议，不阻断整体；每个适用午晚餐时段目标 2 家，评分及价格证据目标 80%
- 行程问题: P0 1 / P1 1 / P2 11
- 餐饮建议: 2 条（仅供参考，不影响状态/评分）

## P0
- Day 3 · item-e22144288f22105ab8d5: 公寓周边散步 与 晚饭休整 · 公寓周边候选餐厅自选 时间重叠（time-overlap）

## P1
- Day 3 · 当天结束早于参考 18:00，缺口超过参考窗口的25%或没有有效活动，请确认是否缺少安排（incomplete-day-end）

## P2
- Day 1 · item-f048c08fac232faacbeb: [资料待确认] 拙政园 缺少开放时间（missing-opening-hours）
- Day 1 · item-ab8412cf4a27ed5157ce: [资料待确认] 苏州博物馆(本馆) 缺少开放时间（missing-opening-hours）
- Day 2 · item-c3b98d3c5c2703c1c854: [资料待确认] 耦园 缺少开放时间（missing-opening-hours）
- Day 2 · item-83a54f993ee01429950c: [资料待确认] 苏州丝绸博物馆 缺少开放时间（missing-opening-hours）
- Day 3 · item-ec99d4a00a5bae1cb0f2: [资料待确认] 留园 缺少开放时间（missing-opening-hours）
- Day 3 · item-db186d3b04942cb248db: [资料待确认] 回公寓休息 缺少数据来源（missing-source）
- Day 3 · item-db186d3b04942cb248db: [资料待确认] 回公寓休息 缺少置信度（missing-confidence）
- Day 1 · 当天结束早于参考 18:00；允许提前返店，节奏提示不扣分、不阻断（incomplete-day-end）
- Day 1 · item-ab8412cf4a27ed5157ce: [资料待确认] 苏州博物馆(本馆) 尚无可核验的闭馆规则，请出发前确认；此项不扣规划分（unverified-closure）
- Day 2 · 当天结束早于参考 18:00；允许提前返店，节奏提示不扣分、不阻断（incomplete-day-end）
- Day 2 · item-83a54f993ee01429950c: [资料待确认] 苏州丝绸博物馆 尚无可核验的闭馆规则，请出发前确认；此项不扣规划分（unverified-closure）

## 餐饮参考（不参与评分）
- Day 2 · 早餐候选最近的也在 5.5 公里外（当天起点：苏州博物馆(本馆) 附近），请补充起点附近的早餐店，或调整时间线先到候选店再出发（breakfast-far-from-start）
- Day 1 · 晚餐候选 0/2（recommendation-slot-coverage）
execution_state: {"operation_id":"sess_1794221901911_37e65f1b:msg_1794222016355_169:call_00_6wjx8QvL4dqxTHvFIjVa8894","execution_status":"failed","effect_status":"not_committed","recovery_action":"fix_arguments","code":"OPERATION_FAILED_NOT_COMMITTED"}
````

### 人工复核项（未自动判定）

- 两位70岁长辈的连续步行、台阶和休息安排
- 两间房的住宿费用是否正确分摊给三人

## 3. 成都三日游素食版（chengdu-3d-vegetarian）

- 自动状态：quality_failed；质量状态：needs_revision；分数 63；保存 2/3 天。
- 工具调用 63 次，诊断错误 1 次；Session 可见错误 1 条。
- 原始记录：[attempt.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chengdu-3d-vegetarian/attempt-1/attempt.json) · [session.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chengdu-3d-vegetarian/attempt-1/session.json) · [tool-diagnostics.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chengdu-3d-vegetarian/attempt-1/tool-diagnostics.json)。
- 原始产物：[质量报告](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chengdu-3d-vegetarian/attempt-1/plans/成都三日人文街区素食之旅.quality.md) · [final-itinerary.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chengdu-3d-vegetarian/attempt-1/final-itinerary.json)。

### 批次原始失败原因

- 行程天数 2/3，未达到案例要求
- P0 0 / P1 4（missing-time, missing-source, missing-confidence, title-day-mismatch, unmaterialized-outline-day, expected-day-count-mismatch）

### 独立需求验收失败

本案例已执行的独立需求检查均通过。此结论不涵盖后面的人工复核项。

### 最终保存版本的全部质量问题

| 等级 | 类型 | 日期/条目 | 错误码 | 原文 |
| --- | --- | --- | --- | --- |
| P1 | 错误 | 第 1 天 2026-11-12 | missing-time | 存在缺少 time 的条目（餐饮候选除外），无法完整核验时间线 |
| P2 | 待确认 | 第 1 天 2026-11-12 · 午餐休整 · 素食候选餐厅自选（说明无蛋奶、不辣、无高汤） | missing-source | 午餐休整 · 素食候选餐厅自选（说明无蛋奶、不辣、无高汤） 缺少数据来源 |
| P2 | 待确认 | 第 1 天 2026-11-12 · 午餐休整 · 素食候选餐厅自选（说明无蛋奶、不辣、无高汤） | missing-confidence | 午餐休整 · 素食候选餐厅自选（说明无蛋奶、不辣、无高汤） 缺少置信度 |
| P2 | 待确认 | 第 1 天 2026-11-12 · 宽窄巷子周边茶馆歇脚 / 选购伴手礼 | missing-source | 宽窄巷子周边茶馆歇脚 / 选购伴手礼 缺少数据来源 |
| P2 | 待确认 | 第 1 天 2026-11-12 · 宽窄巷子周边茶馆歇脚 / 选购伴手礼 | missing-confidence | 宽窄巷子周边茶馆歇脚 / 选购伴手礼 缺少置信度 |
| P2 | 待确认 | 第 1 天 2026-11-12 · 晚餐休整 · 素食候选餐厅自选 | missing-source | 晚餐休整 · 素食候选餐厅自选 缺少数据来源 |
| P2 | 待确认 | 第 1 天 2026-11-12 · 晚餐休整 · 素食候选餐厅自选 | missing-confidence | 晚餐休整 · 素食候选餐厅自选 缺少置信度 |
| P1 | 错误 | 第 2 天 2026-11-13 | missing-time | 存在缺少 time 的条目（餐饮候选除外），无法完整核验时间线 |
| P2 | 待确认 | 第 2 天 2026-11-13 · 午餐休整 · 文殊坊素食/素斋候选自选 | missing-source | 午餐休整 · 文殊坊素食/素斋候选自选 缺少数据来源 |
| P2 | 待确认 | 第 2 天 2026-11-13 · 午餐休整 · 文殊坊素食/素斋候选自选 | missing-confidence | 午餐休整 · 文殊坊素食/素斋候选自选 缺少置信度 |
| P2 | 待确认 | 第 2 天 2026-11-13 · 晚餐休整 · 太古里—春熙路一带素食候选自选 | missing-source | 晚餐休整 · 太古里—春熙路一带素食候选自选 缺少数据来源 |
| P2 | 待确认 | 第 2 天 2026-11-13 · 晚餐休整 · 太古里—春熙路一带素食候选自选 | missing-confidence | 晚餐休整 · 太古里—春熙路一带素食候选自选 缺少置信度 |
| P1 | 错误 | 全程 | title-day-mismatch | 标题为3日游，实际仅排了 2 天：请补齐缺失日期；若用户已明确缩短行程，再同步修改标题 |
| P1 | 错误 | 全程 | unmaterialized-outline-day | 粗排 2026-11-14 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐 |

### 执行过程中实际发生的错误（原文示例）

**可见错误**（plan_day_routes；call_01_7VXrkGck8XviFKAF2Aur0700）

````text
[tool-result type=error chars=143]
工具执行失败: leg_modes 必须为 stops数量减1 个有效交通方式
execution_state: {"execution_status":"failed","effect_status":"none","recovery_action":"manual_review"}
````

### 人工复核项（未自动判定）

- 每餐有实际可用的全素且不辣选择，核实动物高汤和蛋奶
- 不能把缺少菜单证据的餐厅写成已经确认可用

## 4. 北京三日游固定住宿版（beijing-3d-fixed-hotel）

- 自动状态：quality_failed；质量状态：needs_revision；分数 0；保存 0/3 天。
- 工具调用 47 次，诊断错误 21 次；Session 可见错误 5 条。
- 原始记录：[attempt.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/beijing-3d-fixed-hotel/attempt-1/attempt.json) · [session.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/beijing-3d-fixed-hotel/attempt-1/session.json) · [tool-diagnostics.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/beijing-3d-fixed-hotel/attempt-1/tool-diagnostics.json)。
- 原始产物：[质量报告](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/beijing-3d-fixed-hotel/attempt-1/plans/北京三日游.quality.md) · [final-itinerary.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/beijing-3d-fixed-hotel/attempt-1/final-itinerary.json)。

### 批次原始失败原因

- 行程天数 0/3，未达到案例要求
- P0 0 / P1 6（title-day-mismatch, unmaterialized-outline-day, missing-required-visit, expected-day-count-mismatch）
- room-count: 每晚房数应为 1；未安排住宿
- fixed-stay: 全程固定同一酒店，且每个过夜日都有住宿锚点

### 独立需求验收失败

- **room-count**：每晚房数应为 1；未安排住宿
- **fixed-stay**：全程固定同一酒店，且每个过夜日都有住宿锚点

### 最终保存版本的全部质量问题

| 等级 | 类型 | 日期/条目 | 错误码 | 原文 |
| --- | --- | --- | --- | --- |
| P1 | 错误 | 全程 | title-day-mismatch | 标题为3日游，实际仅排了 0 天：请补齐缺失日期；若用户已明确缩短行程，再同步修改标题 |
| P1 | 错误 | 全程 | unmaterialized-outline-day | 粗排 2026-11-20 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐 |
| P1 | 错误 | 全程 | unmaterialized-outline-day | 粗排 2026-11-21 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐 |
| P1 | 错误 | 全程 | unmaterialized-outline-day | 粗排 2026-11-22 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐 |
| P1 | 错误 | 全程 | missing-required-visit | 缺少必去景点「颐和园」，请补充游览安排 |
| P1 | 错误 | 全程 | missing-required-visit | 缺少必去景点「天坛」，请补充游览安排 |

### 执行过程中实际发生的错误（原文示例）

**首个可见错误**（save_itinerary；call_00_lN0BL8R6x0DKJ8IHmzIy9526）

````text
[tool-result type=error chars=1181]
工具执行失败: 行程质量校验未通过；未提交任何修改，仍为版本1。路线修复不突破开放/可用时间；已有路线证据保留，只调整报告中的冲突条目，再按单日期repair_routes保存，不要重复查询已有路线。
# 行程质量报告: 北京三日游

- 状态: 需修改
- 评分: 31 / 100（opportunity-v9，按检查对象归一化）
- 完整度: 33%
- 时间安排: 90 分，1/5 个检查对象有问题
- 交通衔接: 100 分，0/4 个检查对象有问题
- 资料核验: 100 分，0/5 个检查对象有问题
- 行程一致性: 90 分，1/5 个检查对象有问题
- 分日验收: D1 待修改
- 建议局部修复日期: 1
- 餐饮策略: 仅建议，不阻断整体；每个适用午晚餐时段目标 2 家，评分及价格证据目标 80%
- 行程问题: P0 0 / P1 5 / P2 0
- 餐饮建议: 2 条（仅供参考，不影响状态/评分）

## P1
- Day 1 · item-79ce2e7ee3f58a1b1403: 天坛公园 的完整停留时段不在 06:30-19:00 内（outside-opening-hours）
- 标题为3日游，实际仅排了 1 天：请补齐缺失日期；若用户已明确缩短行程，再同步修改标题（title-day-mismatch）
- 粗排 2026-11-21 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐（unmaterialized-outline-day）
- 粗排 2026-11-22 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐（unmaterialized-outline-day）
- 缺少必去景点「颐和园」，请补充游览安排（missing-required-visit）

## 餐饮参考（不参与评分）
- Day 1 · 早餐候选最近的也在 2.1 公里外（当天起点：天坛公园 附近），请补充起点附近的早餐店，或调整时间线先到候选店再出发（breakfast-far-from-start）
- Day 1 · 午餐候选 1/2（recommendation-slot-coverage）
execution_state: {"operation_id":"sess_1794222361766_9b7e2241:msg_1794222516224_498:call_00_lN0BL8R6x0DKJ8IHmzIy9526","execution_status":"failed","effect_status":"not_committed","recovery_action":"fix_arguments","code":"OPERATION_FAILED_NOT_COMMITTED"}
````

**最后一个可见错误**（save_itinerary；call_00_9yTmmJGJcW3C7laTPusa1035）

````text
[tool-result type=error chars=1954]
工具执行失败: 行程质量校验未通过；未提交任何修改，仍为版本1。路线修复不突破开放/可用时间；已有路线证据保留，只调整报告中的冲突条目，再按单日期repair_routes保存，不要重复查询已有路线。
# 行程质量报告: 北京三日游

- 状态: 需修改
- 评分: 29 / 100（opportunity-v9，按检查对象归一化）
- 完整度: 33%
- 时间安排: 90 分，1/5 个检查对象有问题
- 交通衔接: 75 分，2/4 个检查对象有问题
- 资料核验: 96 分，2/5 个检查对象有问题
- 行程一致性: 90 分，1/5 个检查对象有问题
- 分日验收: D1 待修改
- 建议局部修复日期: 1
- 餐饮策略: 仅建议，不阻断整体；每个适用午晚餐时段目标 2 家，评分及价格证据目标 80%
- 行程问题: P0 0 / P1 7 / P2 3
- 餐饮建议: 1 条（仅供参考，不影响状态/评分）

## P1
- Day 1 · item-c907348174f97ceb7867: 天坛公园 的完整停留时段不在 06:30-19:00 内（outside-opening-hours）
- 标题为3日游，实际仅排了 1 天：请补齐缺失日期；若用户已明确缩短行程，再同步修改标题（title-day-mismatch）
- 粗排 2026-11-21 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐（unmaterialized-outline-day）
- 粗排 2026-11-22 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐（unmaterialized-outline-day）
- 缺少必去景点「颐和园」，请补充游览安排（missing-required-visit）
- Day 1 · item-55bbedc4494f370264bd: [资料待确认] 首都宾馆B座 → 天坛公园：首都宾馆B座 → 天坛公园 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"北京","stops":["首都宾馆B座","天坛公园"],"mode":"transit"})，引用返回ID后重新保存；首都宾馆B座 → 天坛公园 缺少已核验的交通段；该时段现有交通为「首都宾馆B座 → 天坛公园 / transit」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"北京","stops":["首都宾馆B座","天坛公园"],"mode":"transit"})，引用返回ID后重新保存（unverified-route；关联检查 unverified-route,missing-route-leg）
- Day 1 · item-f5c7b652c95c5b3bb691: [资料待确认] 天安门广场 → 首都宾馆B座：天安门广场 → 首都宾馆B座 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"北京","stops":["天安门广场","首都宾馆B座"],"mode":"walking"})，引用返回ID后重新保存（unverified-route；关联检查 unverified-route）

## P2
- Day 1 · item-55bbedc4494f370264bd: [资料待确认] 首都宾馆B座 → 天坛公园 缺少数据来源（missing-source）
- Day 1 · item-e622b143509aac98306e: [资料待确认] 中国国家博物馆 需要预约，出发前应确认（reservation-required）
- Day 1 · item-f5c7b652c95c5b3bb691: [资料待确认] 天安门广场 → 首都宾馆B座 缺少数据来源（missing-source）

## 餐饮参考（不参与评分）
- Day 1 · 午餐候选 0/2（recommendation-slot-coverage）
execution_state: {"operation_id":"sess_1794222361766_9b7e2241:msg_1794222554882_507:call_00_9yTmmJGJcW3C7laTPusa1035","execution_status":"failed","effect_status":"not_committed","recovery_action":"fix_arguments","code":"OPERATION_FAILED_NOT_COMMITTED"}
````

### 人工复核项（未自动判定）

- 同一酒店跨天出现时不重复收取同一晚房费
- 所有日程均考虑返回固定酒店的通勤

## 5. 赤峰五日游远郊混排版（chifeng-5d-remote-mix）

- 自动状态：quality_failed；质量状态：needs_revision；分数 33；保存 2/5 天。
- 工具调用 71 次，诊断错误 3 次；Session 可见错误 3 条。
- 原始记录：[attempt.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chifeng-5d-remote-mix/attempt-1/attempt.json) · [session.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chifeng-5d-remote-mix/attempt-1/session.json) · [tool-diagnostics.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chifeng-5d-remote-mix/attempt-1/tool-diagnostics.json)。
- 原始产物：[质量报告](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chifeng-5d-remote-mix/attempt-1/plans/赤峰五日自驾游.quality.md) · [final-itinerary.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chifeng-5d-remote-mix/attempt-1/final-itinerary.json)。

### 批次原始失败原因

- 行程天数 2/5，未达到案例要求
- P0 0 / P1 13（missing-opening-hours, missing-source, long-transport, missing-location, missing-confidence, title-day-mismatch, missing-day-window, incomplete-day-end, unverified-closure, unverified-place-evidence, unmaterialized-outline-day, missing-required-visit, unverified-route, missing-route-leg, expected-day-count-mismatch）

### 独立需求验收失败

本案例已执行的独立需求检查均通过。此结论不涵盖后面的人工复核项。

### 最终保存版本的全部质量问题

| 等级 | 类型 | 日期/条目 | 错误码 | 原文 |
| --- | --- | --- | --- | --- |
| P2 | 待确认 | 第 1 天 2027-05-10 · 红山文化博物馆 | missing-opening-hours | 红山文化博物馆 缺少开放时间 |
| P2 | 待确认 | 第 1 天 2027-05-10 · 辽代历史文化博物馆 | missing-opening-hours | 辽代历史文化博物馆 缺少开放时间 |
| P2 | 待确认 | 第 2 天 2027-05-11 · 赤峰市区（红山区） → 乌兰布统旅游景区 | missing-source | 赤峰市区（红山区） → 乌兰布统旅游景区 缺少数据来源 |
| P2 | 建议 | 第 2 天 2027-05-11 · 赤峰市区（红山区） → 乌兰布统旅游景区 | long-transport | 交通耗时 210 分钟，属于远郊/跨区长距离移动：请确认当天已预留缓冲（超过 60 分钟会提示，但不阻断交付） |
| P2 | 待确认 | 第 2 天 2027-05-11 · 乌兰布统旅游景区 | missing-location | 乌兰布统旅游景区 缺少 location，无法做空间核验 |
| P2 | 待确认 | 第 2 天 2027-05-11 · 乌兰布统旅游景区 | missing-opening-hours | 乌兰布统旅游景区 缺少开放时间 |
| P2 | 待确认 | 第 2 天 2027-05-11 · 午餐休整 · 乌兰布统镇餐饮自选 | missing-source | 午餐休整 · 乌兰布统镇餐饮自选 缺少数据来源 |
| P2 | 待确认 | 第 2 天 2027-05-11 · 午餐休整 · 乌兰布统镇餐饮自选 | missing-confidence | 午餐休整 · 乌兰布统镇餐饮自选 缺少置信度 |
| P2 | 待确认 | 第 2 天 2027-05-11 · 乌兰布统旅游景区（继续游览） | missing-location | 乌兰布统旅游景区（继续游览） 缺少 location，无法做空间核验 |
| P2 | 待确认 | 第 2 天 2027-05-11 · 乌兰布统旅游景区（继续游览） | missing-opening-hours | 乌兰布统旅游景区（继续游览） 缺少开放时间 |
| P2 | 待确认 | 第 2 天 2027-05-11 · 晚餐休整 · 乌兰布统镇餐饮自选 | missing-source | 晚餐休整 · 乌兰布统镇餐饮自选 缺少数据来源 |
| P2 | 待确认 | 第 2 天 2027-05-11 · 晚餐休整 · 乌兰布统镇餐饮自选 | missing-confidence | 晚餐休整 · 乌兰布统镇餐饮自选 缺少置信度 |
| P1 | 错误 | 全程 | title-day-mismatch | 标题为5日游，实际仅排了 2 天：请补齐缺失日期；若用户已明确缩短行程，再同步修改标题 |
| P1 | 错误 | 第 1 天 2027-05-10 | missing-day-window | 非完整游玩日需要明确可用时间，不能只改日期类型规避检查 |
| P1 | 错误 | 第 1 天 2027-05-10 | incomplete-day-end | 当天结束早于参考 18:00，缺口超过参考窗口的25%或没有有效活动，请确认是否缺少安排 |
| P2 | 待确认 | 第 1 天 2027-05-10 · 红山文化博物馆 | unverified-closure | 红山文化博物馆 尚无可核验的闭馆规则，请出发前确认；此项不扣规划分 |
| P2 | 待确认 | 第 1 天 2027-05-10 · 辽代历史文化博物馆 | unverified-closure | 辽代历史文化博物馆 尚无可核验的闭馆规则，请出发前确认；此项不扣规划分 |
| P1 | 待确认 | 第 2 天 2027-05-11 · 乌兰布统旅游景区 | unverified-place-evidence | 乌兰布统旅游景区 缺少对应城市的工具地点证据 |
| P1 | 待确认 | 第 2 天 2027-05-11 · 乌兰布统旅游景区（继续游览） | unverified-place-evidence | 乌兰布统旅游景区（继续游览） 缺少对应城市的工具地点证据 |
| P1 | 待确认 | 第 2 天 2027-05-11 · 入住乌兰布统当地酒店 | unverified-place-evidence | 入住乌兰布统当地酒店 缺少对应城市的工具地点证据 |
| P1 | 错误 | 全程 | unmaterialized-outline-day | 粗排 2027-05-12 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐 |
| P1 | 错误 | 全程 | unmaterialized-outline-day | 粗排 2027-05-13 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐 |
| P1 | 错误 | 全程 | unmaterialized-outline-day | 粗排 2027-05-14 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐 |
| P1 | 错误 | 全程 | missing-required-visit | 缺少必去景点「达里湖」，请补充游览安排 |
| P1 | 待确认 | 第 2 天 2027-05-11 · 赤峰市区（红山区） → 乌兰布统旅游景区 | unverified-route | 赤峰市区（红山区） → 乌兰布统旅游景区：赤峰市区（红山区） → 乌兰布统旅游景区 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"赤峰","stops":["赤峰市区（红山区）","乌兰布统旅游景区"],"mode":"driving"})，引用返回ID后重新保存 |
| P1 | 错误 | 第 2 天 2027-05-11 · 乌兰布统旅游景区（继续游览） | missing-route-leg | 乌兰布统旅游景区 → 乌兰布统旅游景区（继续游览） 缺少已核验的交通段。请调用 plan_day_routes({"city":"赤峰","stops":["乌兰布统旅游景区","乌兰布统旅游景区（继续游览）"],"mode":"transit"})，引用返回ID后重新保存 |
| P1 | 错误 | 第 2 天 2027-05-11 · 入住乌兰布统当地酒店 | missing-route-leg | 乌兰布统旅游景区（继续游览） → 入住乌兰布统当地酒店 缺少已核验的交通段。请调用 plan_day_routes({"city":"赤峰","stops":["乌兰布统旅游景区（继续游览）","入住乌兰布统当地酒店"],"mode":"transit"})，引用返回ID后重新保存 |

### 执行过程中实际发生的错误（原文示例）

**首个可见错误**（read_file；call_00_uozsMGqAErae0YIel0En5459）

````text
[tool-result type=error chars=291]
工具执行失败: 文件不存在: /Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chifeng-5d-remote-mix/attempt-1/.minicode/artifacts/sess_1794222670897_cb892890/search_stays-call_00.txt
execution_state: {"execution_status":"failed","effect_status":"none","recovery_action":"manual_review"}
````

**最后一个可见错误**（read_file；call_00_BCBYzoSwzHmSy2IxJaT71992）

````text
[tool-result type=error chars=310]
工具执行失败: 文件不存在: /Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/chifeng-5d-remote-mix/attempt-1/.minicode/artifacts/sess_1794222670897_cb892890/search_stays-call_00_hotel_search_batch.txt
execution_state: {"execution_status":"failed","effect_status":"none","recovery_action":"manual_review"}
````

### 人工复核项（未自动判定）

- 远郊主景区需足够停留时间，不能用内部子点凑景点数
- 逐日自驾通勤、换宿和远程数据稀缺时的说明是否合理

## 6. 杭州两日游天气备选版（hangzhou-2d-weather-backup）

- 自动状态：quality_failed；质量状态：needs_confirmation；分数 93；保存 2/2 天。
- 工具调用 53 次，诊断错误 5 次；Session 可见错误 5 条。
- 原始记录：[attempt.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/hangzhou-2d-weather-backup/attempt-1/attempt.json) · [session.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/hangzhou-2d-weather-backup/attempt-1/session.json) · [tool-diagnostics.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/hangzhou-2d-weather-backup/attempt-1/tool-diagnostics.json)。
- 原始产物：[质量报告](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/hangzhou-2d-weather-backup/attempt-1/plans/杭州两日游.quality.md) · [final-itinerary.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/hangzhou-2d-weather-backup/attempt-1/final-itinerary.json)。

### 批次原始失败原因

- P0 0 / P1 3（missing-source, long-transport, missing-opening-hours, missing-confidence, unverified-place-evidence, unverified-closure, unverified-route, missing-route-leg）

### 独立需求验收失败

本案例已执行的独立需求检查均通过。此结论不涵盖后面的人工复核项。

### 最终保存版本的全部质量问题

| 等级 | 类型 | 日期/条目 | 错误码 | 原文 |
| --- | --- | --- | --- | --- |
| P2 | 待确认 | 第 1 天 2026-11-14 · 静奈·杭州 → 浙江省博物馆 | missing-source | 静奈·杭州 → 浙江省博物馆 缺少数据来源 |
| P2 | 建议 | 第 1 天 2026-11-14 · 静奈·杭州 → 浙江省博物馆 | long-transport | 交通耗时 75 分钟，属于远郊/跨区长距离移动：请确认当天已预留缓冲（超过 60 分钟会提示，但不阻断交付） |
| P2 | 待确认 | 第 1 天 2026-11-14 · 浙江省博物馆 → 杭州西湖风景名胜区-岳王庙 | missing-source | 浙江省博物馆 → 杭州西湖风景名胜区-岳王庙 缺少数据来源 |
| P2 | 待确认 | 第 1 天 2026-11-14 · 杭州西湖风景名胜区-岳王庙 | missing-opening-hours | 杭州西湖风景名胜区-岳王庙 缺少开放时间 |
| P2 | 建议 | 第 1 天 2026-11-14 · 杭州西湖风景名胜区-岳王庙 → 静奈·杭州 | long-transport | 交通耗时 70 分钟，属于远郊/跨区长距离移动：请确认当天已预留缓冲（超过 60 分钟会提示，但不阻断交付） |
| P2 | 待确认 | 第 2 天 2026-11-15 · 中国丝绸博物馆 | missing-opening-hours | 中国丝绸博物馆 缺少开放时间 |
| P2 | 待确认 | 第 2 天 2026-11-15 · 午餐休整 · 南山路/雷峰塔一带自选 | missing-source | 午餐休整 · 南山路/雷峰塔一带自选 缺少数据来源 |
| P2 | 待确认 | 第 2 天 2026-11-15 · 午餐休整 · 南山路/雷峰塔一带自选 | missing-confidence | 午餐休整 · 南山路/雷峰塔一带自选 缺少置信度 |
| P2 | 待确认 | 第 2 天 2026-11-15 · 雷峰塔景区 | missing-opening-hours | 雷峰塔景区 缺少开放时间 |
| P2 | 待确认 | 第 2 天 2026-11-15 · 晚餐休整 · 住处周边自选 | missing-source | 晚餐休整 · 住处周边自选 缺少数据来源 |
| P2 | 待确认 | 第 2 天 2026-11-15 · 晚餐休整 · 住处周边自选 | missing-confidence | 晚餐休整 · 住处周边自选 缺少置信度 |
| P2 | 待确认 | 第 2 天 2026-11-15 · 湖滨街区夜逛（可选） | missing-source | 湖滨街区夜逛（可选） 缺少数据来源 |
| P2 | 待确认 | 第 2 天 2026-11-15 · 湖滨街区夜逛（可选） | missing-confidence | 湖滨街区夜逛（可选） 缺少置信度 |
| P1 | 待确认 | 第 1 天 2026-11-14 · 浙江省博物馆 | unverified-place-evidence | 浙江省博物馆 缺少对应城市的工具地点证据 |
| P2 | 待确认 | 第 2 天 2026-11-15 · 中国丝绸博物馆 | unverified-closure | 中国丝绸博物馆 尚无可核验的闭馆规则，请出发前确认；此项不扣规划分 |
| P1 | 待确认 | 第 1 天 2026-11-14 · 静奈·杭州 → 浙江省博物馆 | unverified-route, missing-route-leg | 静奈·杭州 → 浙江省博物馆：静奈·杭州 → 浙江省博物馆 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"杭州","stops":["静奈·杭州","浙江省博物馆"],"mode":"transit"})，引用返回ID后重新保存；静奈·杭州 → 浙江省博物馆 缺少已核验的交通段；该时段现有交通为「静奈·杭州 → 浙江省博物馆 / transit」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"杭州","stops":["静奈·杭州","浙江省博物馆"],"mode":"transit"})，引用返回ID后重新保存 |
| P1 | 待确认 | 第 1 天 2026-11-14 · 浙江省博物馆 → 杭州西湖风景名胜区-岳王庙 | unverified-route, missing-route-leg | 浙江省博物馆 → 杭州西湖风景名胜区-岳王庙：浙江省博物馆 → 杭州西湖风景名胜区-岳王庙 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"杭州","stops":["浙江省博物馆","杭州西湖风景名胜区-岳王庙"],"mode":"transit"})，引用返回ID后重新保存；浙江省博物馆 → 杭州西湖风景名胜区-岳王庙 缺少已核验的交通段；该时段现有交通为「浙江省博物馆 → 杭州西湖风景名胜区-岳王庙 / transit」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"杭州","stops":["浙江省博物馆","杭州西湖风景名胜区-岳王庙"],"mode":"transit"})，引用返回ID后重新保存 |

### 执行过程中实际发生的错误（原文示例）

**首个可见错误**（save_itinerary；call_00_WWiasLDPPIlvPUPGOsyF3058）

````text
[tool-result type=error chars=1109]
工具执行失败: 行程质量校验未通过；未提交任何修改，尚未保存。未经用户授权的景点重复或主子点拆分不能保存；repeat_reason只是说明。请仅调整冲突条目，主子点保留主条目并将子点放recommended_spots，不重写其他已通过日期。
# 行程质量报告: 杭州两日游

- 状态: 需修改
- 评分: 0 / 100（opportunity-v9，按检查对象归一化）
- 完整度: 0%
- 时间安排: 100 分，0/0 个检查对象有问题
- 交通衔接: 100 分，0/0 个检查对象有问题
- 资料核验: 100 分，0/0 个检查对象有问题
- 行程一致性: 50 分，1/1 个检查对象有问题
- 分日验收: 
- 餐饮策略: 仅建议，不阻断整体；每个适用午晚餐时段目标 2 家，评分及价格证据目标 80%
- 行程问题: P0 0 / P1 7 / P2 0

## P1
- 标题为2日游，实际仅排了 0 天：请补齐缺失日期；若用户已明确缩短行程，再同步修改标题（title-day-mismatch）
- 缺少需求单指定日期 2026-11-14（missing-requested-date）
- 缺少需求单指定日期 2026-11-15（missing-requested-date）
- 「浙江省博物馆(之江馆区)」在 2026-11-14、2026-11-15 重复占用，请只修改冲突条目或显式移动；repeat_reason不是用户授权（visit-allocation-conflict）
- 粗排 2026-11-14 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐（unmaterialized-outline-day）
- 粗排 2026-11-15 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐（unmaterialized-outline-day）
- 缺少必去景点「浙江省博物馆」，请补充游览安排（missing-required-visit）
execution_state: {"operation_id":"sess_1794222763069_e1014de1:msg_1794222778442_719:call_00_WWiasLDPPIlvPUPGOsyF3058","execution_status":"failed","effect_status":"not_committed","recovery_action":"fix_arguments","code":"OPERATION_FAILED_NOT_COMMITTED"}
````

**最后一个可见错误**（save_itinerary；call_00_H2NVppWWrcHuojp7Quif3857）

````text
[tool-result type=error chars=337]
工具执行失败: 每个行程条目必须有非空 name
execution_state: {"operation_id":"sess_1794222763069_e1014de1:msg_1794222817517_754:call_00_H2NVppWWrcHuojp7Quif3857","execution_status":"failed","effect_status":"not_committed","recovery_action":"manual_review","code":"OPERATION_FAILED_NOT_COMMITTED"}

【防循环】同一工具和错误已连续出现 2 次。不要原样重发这组参数；先重新读取当前数据、缩小修改范围，或改用其他工具。
````

### 人工复核项（未自动判定）

- 先查指定日期天气，再决定室内外顺序
- 有雨时提供有依据的室内备选；无雨时不虚构降雨
- 预报取不到时明确不确定性

## 7. 福州四日游慢逛避雷版（fuzhou-4d-slow-exclusions）

- 自动状态：quality_failed；质量状态：needs_confirmation；分数 99；保存 4/4 天。
- 工具调用 79 次，诊断错误 16 次；Session 可见错误 16 条。
- 原始记录：[attempt.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/fuzhou-4d-slow-exclusions/attempt-1/attempt.json) · [session.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/fuzhou-4d-slow-exclusions/attempt-1/session.json) · [tool-diagnostics.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/fuzhou-4d-slow-exclusions/attempt-1/tool-diagnostics.json)。
- 原始产物：[质量报告](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/fuzhou-4d-slow-exclusions/attempt-1/plans/福州四日慢游.quality.md) · [final-itinerary.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/fuzhou-4d-slow-exclusions/attempt-1/final-itinerary.json)。

### 批次原始失败原因

- activity-window: 第 1 天活动限 10:00—20:00；越界或缺少有效起止时间：福州三坊七巷南门兜地铁站亚朵酒店 → 三坊七巷

### 独立需求验收失败

- **activity-window**：第 1 天活动限 10:00—20:00；越界或缺少有效起止时间：福州三坊七巷南门兜地铁站亚朵酒店 → 三坊七巷

### 最终保存版本的全部质量问题

| 等级 | 类型 | 日期/条目 | 错误码 | 原文 |
| --- | --- | --- | --- | --- |
| P2 | 待确认 | 第 2 天 2026-11-12 · 镇海楼 | missing-opening-hours | 镇海楼 缺少开放时间 |
| P2 | 待确认 | 第 3 天 2026-11-13 · 烟台山 | missing-opening-hours | 烟台山 缺少开放时间 |
| P2 | 待确认 | 第 2 天 2026-11-12 · 福建博物院 | unverified-closure | 福建博物院 尚无可核验的闭馆规则，请出发前确认；此项不扣规划分 |
| P2 | 待确认 | 第 4 天 2026-11-14 · 可可主角·福州巧克力博览馆 | unverified-closure | 可可主角·福州巧克力博览馆 尚无可核验的闭馆规则，请出发前确认；此项不扣规划分 |

### 执行过程中实际发生的错误（原文示例）

**首个可见错误**（save_itinerary；call_00_Jcpkq1I8O68p6NbgsXbs9253）

````text
[tool-result type=error chars=2451]
工具执行失败: 行程质量校验未通过；未提交任何修改，仍为版本1。路线修复不突破开放/可用时间；已有路线证据保留，只调整报告中的冲突条目，再按单日期repair_routes保存，不要重复查询已有路线。
# 行程质量报告: 福州四日慢游

- 状态: 需修改
- 评分: 22 / 100（opportunity-v9，按检查对象归一化）
- 完整度: 25%
- 时间安排: 83.3 分，1/3 个检查对象有问题
- 交通衔接: 96.7 分，1/3 个检查对象有问题
- 资料核验: 93.3 分，2/3 个检查对象有问题
- 行程一致性: 83.3 分，1/3 个检查对象有问题
- 分日验收: D1 待修改
- 建议局部修复日期: 1
- 餐饮策略: 仅建议，不阻断整体；每个适用午晚餐时段目标 2 家，评分及价格证据目标 80%
- 行程问题: P0 0 / P1 6 / P2 10
- 餐饮建议: 6 条（仅供参考，不影响状态/评分）

## P1
- 标题为4日游，实际仅排了 1 天：请补齐缺失日期；若用户已明确缩短行程，再同步修改标题（title-day-mismatch）
- Day 1 · item-b34945758de8dfe41993: 福州三坊七巷南门兜地铁站亚朵酒店 超出当天已知可用时间（outside-day-window）
- 粗排 2026-11-11 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐（unmaterialized-outline-day）
- 粗排 2026-11-12 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐（unmaterialized-outline-day）
- 粗排 2026-11-13 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐（unmaterialized-outline-day）
- 缺少必去景点「三坊七巷」，请补充游览安排（missing-required-visit）

## P2
- Day 1 · item-419c8f9afc5020f25029: [资料待确认] 烟台山 缺少开放时间（missing-opening-hours）
- Day 1 · item-9536a6a1228456140bb7: [资料待确认] 午餐休整 · 烟台山周边候选餐厅自选 缺少数据来源（missing-source）
- Day 1 · item-9536a6a1228456140bb7: [资料待确认] 午餐休整 · 烟台山周边候选餐厅自选 缺少置信度（missing-confidence）
- Day 1 · item-e39ffb3ab2451c9022c9: 交通耗时 62 分钟，属于远郊/跨区长距离移动：请确认当天已预留缓冲（超过 60 分钟会提示，但不阻断交付）（long-transport）
- Day 1 · item-ced69e9af7942753b6e5: [资料待确认] 回酒店休整（慢节奏，避开下午赶场） 缺少数据来源（missing-source）
- Day 1 · item-ced69e9af7942753b6e5: [资料待确认] 回酒店休整（慢节奏，避开下午赶场） 缺少置信度（missing-confidence）
- Day 1 · item-deb009aeb26f39f0b199: [资料待确认] 南门兜一带甜品小吃闲逛 缺少数据来源（missing-source）
- Day 1 · item-deb009aeb26f39f0b199: [资料待确认] 南门兜一带甜品小吃闲逛 缺少置信度（missing-confidence）
- Day 1 · item-9a98d44dc9563be5ef2b: [资料待确认] 晚餐休整 · 酒店周边候选餐厅自选 缺少数据来源（missing-source）
- Day 1 · item-9a98d44dc9563be5ef2b: [资料待确认] 晚餐休整 · 酒店周边候选餐厅自选 缺少置信度（missing-confidence）

## 餐饮参考（不参与评分）
- Day 1 · 全一鲜汤包 缺少 end_time 或 planned_duration_min（missing-duration）
- Day 1 · 小有财气·粥底火锅(烟台山店) 缺少 end_time 或 planned_duration_min（missing-duration）
- Day 1 · 友欣荣椰子鸡火锅·椰子糖水铺 缺少 end_time 或 planned_duration_min（missing-duration）
- Day 1 · 鸿运面馆 缺少 end_time 或 planned_duration_min（missing-duration）
- Day 1 · 绣球披萨(烟台山店) 缺少 end_time 或 planned_duration_min（missing-duration）
- Day 1 · 老马扎市井小火锅(福州烟台山商业漫步街店) 缺少 end_time 或 planned_duration_min（missing-duration）
execution_state: {"operation_id":"sess_1794222989295_fd9ae90c:msg_1794223036757_901:call_00_Jcpkq1I8O68p6NbgsXbs9253","execution_status":"failed","effect_status":"not_committed","recovery_action":"fix_arguments","code":"OPERATION_FAILED_NOT_COMMITTED"}
````

**最后一个可见错误**（get_place_reviews；call_01_S3MdKjDij2oE9rmRJjtv5374）

````text
[tool-result type=error chars=203]
工具执行失败: 缺少或非法参数 place（需要非空字符串）
execution_state: {"execution_status":"failed","effect_status":"not_committed","recovery_action":"fix_arguments"}

【防循环】同一工具和错误已连续出现 2 次。不要原样重发这组参数；先重新读取当前数据、缩小修改范围，或改用其他工具。
````

### 人工复核项（未自动判定）

- 慢节奏应有停留和休息，不能只把活动起止时间拉长
- 甜品与小吃有可用来源，不能把泛街区当成餐厅

## 8. 北京一日游晚到版（beijing-1d-late-arrival）

- 自动状态：passed；质量状态：needs_confirmation；分数 98；保存 1/1 天。
- 工具调用 14 次，诊断错误 0 次；Session 可见错误 0 条。
- 原始记录：[attempt.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/beijing-1d-late-arrival/attempt-1/attempt.json) · [session.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/beijing-1d-late-arrival/attempt-1/session.json) · [tool-diagnostics.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/beijing-1d-late-arrival/attempt-1/tool-diagnostics.json)。
- 原始产物：[质量报告](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/beijing-1d-late-arrival/attempt-1/plans/北京一日游天坛-1300-2000.quality.md) · [final-itinerary.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/beijing-1d-late-arrival/attempt-1/final-itinerary.json)。

### 批次原始失败原因

本案例通过自动闸门；下列 P2 与人工复核事项仍需处理。

### 独立需求验收失败

本案例已执行的独立需求检查均通过。此结论不涵盖后面的人工复核项。

### 最终保存版本的全部质量问题

| 等级 | 类型 | 日期/条目 | 错误码 | 原文 |
| --- | --- | --- | --- | --- |
| P2 | 待确认 | 第 1 天 2026-11-14 · 天坛公园 | missing-opening-hours | 天坛公园 缺少开放时间 |
| P2 | 待确认 | 第 1 天 2026-11-14 · 先农坛 | missing-opening-hours | 先农坛 缺少开放时间 |

### 执行过程中实际发生的错误（原文示例）

Session 中没有可见的工具错误原文；完整调用情况见工具诊断。
### 人工复核项（未自动判定）

- 抵达车站到首个景点、末个景点到返程车站是否预留通勤和进站时间

## 9. 上海两日游省钱版（shanghai-2d-low-budget）

- 自动状态：passed；质量状态：needs_confirmation；分数 99；保存 2/2 天。
- 工具调用 36 次，诊断错误 2 次；Session 可见错误 2 条。
- 原始记录：[attempt.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/shanghai-2d-low-budget/attempt-1/attempt.json) · [session.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/shanghai-2d-low-budget/attempt-1/session.json) · [tool-diagnostics.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/shanghai-2d-low-budget/attempt-1/tool-diagnostics.json)。
- 原始产物：[质量报告](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/shanghai-2d-low-budget/attempt-1/plans/上海两日穷游公共交通免费景点.quality.md) · [final-itinerary.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/shanghai-2d-low-budget/attempt-1/final-itinerary.json)。

### 批次原始失败原因

本案例通过自动闸门；下列 P2 与人工复核事项仍需处理。

### 独立需求验收失败

本案例已执行的独立需求检查均通过。此结论不涵盖后面的人工复核项。

### 最终保存版本的全部质量问题

| 等级 | 类型 | 日期/条目 | 错误码 | 原文 |
| --- | --- | --- | --- | --- |
| P2 | 待确认 | 第 1 天 2026-11-10 · 上海四行仓库抗战纪念馆 | missing-opening-hours | 上海四行仓库抗战纪念馆 缺少开放时间 |
| P2 | 待确认 | 第 1 天 2026-11-10 · 上海市历史博物馆 | unverified-closure | 上海市历史博物馆 尚无可核验的闭馆规则，请出发前确认；此项不扣规划分 |
| P2 | 建议 | 第 2 天 2026-11-11 | incomplete-day-end | 当天结束早于参考 18:00；允许提前返店，节奏提示不扣分、不阻断 |
| P2 | 待确认 | 第 2 天 2026-11-11 · 上海观复博物馆 | unverified-closure | 上海观复博物馆 尚无可核验的闭馆规则，请出发前确认；此项不扣规划分 |

### 执行过程中实际发生的错误（原文示例）

**首个可见错误**（save_itinerary；call_00_efkTsXN0hvbxk49MA1wW4998）

````text
[tool-result type=error chars=334]
工具执行失败: 参数不是合法 JSON: {"title": "上海两日穷游（公共交通+免费景点）", "days": [{"date": "2026-11-11", "day_type": "departure", "items": [{"type": "accommodation", "name": "OPARTMENT远东饭店", "evidence_id": "de8cf833f5aaf95dba83", "time": "08:
execution_state: {"execution_status":"failed","effect_status":"not_committed","recovery_action":"fix_arguments"}
````

**最后一个可见错误**（save_itinerary；call_00_PT5GUuoau9sanYsm2d7P2025）

````text
[tool-result type=error chars=269]
工具执行失败: 字段必须是字符串
execution_state: {"operation_id":"sess_1794222023892_61edea64:msg_1794222108594_226:call_00_PT5GUuoau9sanYsm2d7P2025","execution_status":"failed","effect_status":"not_committed","recovery_action":"manual_review","code":"OPERATION_FAILED_NOT_COMMITTED"}
````

### 人工复核项（未自动判定）

- 600元是否覆盖餐饮、住宿、市内交通和门票，避免漏项形成假低价
- 市内交通以公交地铁为主

## 10. 西安三日游周一闭馆版（xian-3d-monday-closure）

- 自动状态：passed；质量状态：needs_confirmation；分数 98；保存 3/3 天。
- 工具调用 40 次，诊断错误 2 次；Session 可见错误 2 条。
- 原始记录：[attempt.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/xian-3d-monday-closure/attempt-1/attempt.json) · [session.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/xian-3d-monday-closure/attempt-1/session.json) · [tool-diagnostics.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/xian-3d-monday-closure/attempt-1/tool-diagnostics.json)。
- 原始产物：[质量报告](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/xian-3d-monday-closure/attempt-1/plans/西安三日游2026-11-16-至-11-18.quality.md) · [final-itinerary.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/xian-3d-monday-closure/attempt-1/final-itinerary.json)。

### 批次原始失败原因

本案例通过自动闸门；下列 P2 与人工复核事项仍需处理。

### 独立需求验收失败

本案例已执行的独立需求检查均通过。此结论不涵盖后面的人工复核项。

### 最终保存版本的全部质量问题

| 等级 | 类型 | 日期/条目 | 错误码 | 原文 |
| --- | --- | --- | --- | --- |
| P2 | 待确认 | 第 1 天 2026-11-16 · 西安钟楼 | missing-opening-hours | 西安钟楼 缺少开放时间 |
| P2 | 待确认 | 第 1 天 2026-11-16 · 西安鼓楼 | missing-opening-hours | 西安鼓楼 缺少开放时间 |
| P2 | 待确认 | 第 1 天 2026-11-16 · 午餐休整 · 候选餐厅自选（回均/钟楼区域） | missing-source | 午餐休整 · 候选餐厅自选（回均/钟楼区域） 缺少数据来源 |
| P2 | 待确认 | 第 1 天 2026-11-16 · 午餐休整 · 候选餐厅自选（回均/钟楼区域） | missing-confidence | 午餐休整 · 候选餐厅自选（回均/钟楼区域） 缺少置信度 |
| P2 | 待确认 | 第 1 天 2026-11-16 · 晚餐休整 · 候选餐厅自选（钟楼东木头市/回均） | missing-source | 晚餐休整 · 候选餐厅自选（钟楼东木头市/回均） 缺少数据来源 |
| P2 | 待确认 | 第 1 天 2026-11-16 · 晚餐休整 · 候选餐厅自选（钟楼东木头市/回均） | missing-confidence | 晚餐休整 · 候选餐厅自选（钟楼东木头市/回均） 缺少置信度 |
| P2 | 待确认 | 第 2 天 2026-11-17 · 陕西历史博物馆 | reservation-required | 陕西历史博物馆 需要预约，出发前应确认 |
| P2 | 待确认 | 第 2 天 2026-11-17 · 午餐休整 · 候选餐厅自选（陕历博/小寨东路区域） | missing-source | 午餐休整 · 候选餐厅自选（陕历博/小寨东路区域） 缺少数据来源 |
| P2 | 待确认 | 第 2 天 2026-11-17 · 午餐休整 · 候选餐厅自选（陕历博/小寨东路区域） | missing-confidence | 午餐休整 · 候选餐厅自选（陕历博/小寨东路区域） 缺少置信度 |
| P2 | 待确认 | 第 2 天 2026-11-17 · 晚餐休整 · 候选餐厅自选（大雁塔/小寨区域） | missing-source | 晚餐休整 · 候选餐厅自选（大雁塔/小寨区域） 缺少数据来源 |
| P2 | 待确认 | 第 2 天 2026-11-17 · 晚餐休整 · 候选餐厅自选（大雁塔/小寨区域） | missing-confidence | 晚餐休整 · 候选餐厅自选（大雁塔/小寨区域） 缺少置信度 |
| P2 | 建议 | 第 3 天 2026-11-18 · 回民街西安钟楼地铁站舒与酒店 → 秦始皇帝陵博物院 | long-transport | 交通耗时 112 分钟，属于远郊/跨区长距离移动：请确认当天已预留缓冲（超过 60 分钟会提示，但不阻断交付） |
| P2 | 待确认 | 第 3 天 2026-11-18 · 秦始皇帝陵博物院 | reservation-required | 秦始皇帝陵博物院 需要预约，出发前应确认 |
| P2 | 待确认 | 第 3 天 2026-11-18 · 午餐休整 · 候选餐厅自选（兵马俑景区/临潼区域） | missing-source | 午餐休整 · 候选餐厅自选（兵马俑景区/临潼区域） 缺少数据来源 |
| P2 | 待确认 | 第 3 天 2026-11-18 · 午餐休整 · 候选餐厅自选（兵马俑景区/临潼区域） | missing-confidence | 午餐休整 · 候选餐厅自选（兵马俑景区/临潼区域） 缺少置信度 |
| P2 | 建议 | 第 3 天 2026-11-18 · 秦始皇帝陵博物院 → 回民街西安钟楼地铁站舒与酒店 | long-transport | 交通耗时 110 分钟，属于远郊/跨区长距离移动：请确认当天已预留缓冲（超过 60 分钟会提示，但不阻断交付） |
| P2 | 待确认 | 第 3 天 2026-11-18 · 晚餐休整 · 候选餐厅自选（钟楼/回民街区域） | missing-source | 晚餐休整 · 候选餐厅自选（钟楼/回民街区域） 缺少数据来源 |
| P2 | 待确认 | 第 3 天 2026-11-18 · 晚餐休整 · 候选餐厅自选（钟楼/回民街区域） | missing-confidence | 晚餐休整 · 候选餐厅自选（钟楼/回民街区域） 缺少置信度 |
| P2 | 待确认 | 第 3 天 2026-11-18 · 自由活动 · 钟楼夜景 / 回民街伴手礼采买（可视体力与返程车次提前结束） | missing-source | 自由活动 · 钟楼夜景 / 回民街伴手礼采买（可视体力与返程车次提前结束） 缺少数据来源 |
| P2 | 待确认 | 第 3 天 2026-11-18 · 自由活动 · 钟楼夜景 / 回民街伴手礼采买（可视体力与返程车次提前结束） | missing-confidence | 自由活动 · 钟楼夜景 / 回民街伴手礼采买（可视体力与返程车次提前结束） 缺少置信度 |
| P2 | 建议 | 第 1 天 2026-11-16 | incomplete-day-end | 当天结束早于参考 18:00；允许提前返店，节奏提示不扣分、不阻断 |
| P2 | 待确认 | 第 3 天 2026-11-18 · 秦始皇帝陵博物院 | unverified-closure | 秦始皇帝陵博物院 尚无可核验的闭馆规则，请出发前确认；此项不扣规划分 |

### 执行过程中实际发生的错误（原文示例）

**首个可见错误**（save_itinerary；call_00_id3QhXY1vV5W9TcDFL7H5495）

````text
[tool-result type=error chars=334]
工具执行失败: 参数不是合法 JSON: {"title": "西安三日游（2026-11-16 至 11-18）", "days": [{"date": "2026-11-16", "theme": "钟鼓楼·城墙碑林老城线（周一陕历博闭馆，调整到周二）", "day_type": "full", "items": [{"type": "accommodation", "name": "回民街西安钟楼地铁站舒与酒店", "activit
execution_state: {"execution_status":"failed","effect_status":"not_committed","recovery_action":"fix_arguments"}
````

**最后一个可见错误**（save_itinerary；call_00_vXS7k3kKeXO9f2XOqH5p0963）

````text
[tool-result type=error chars=334]
工具执行失败: 参数不是合法 JSON: {"title": "西安三日游（2026-11-16 至 11-18）", "budget_per_person_yuan": 2000, "days": [{"date": "2026-11-17", "day_type": "full", "theme": "陕历博（周二开放）·大雁塔线，雁塔区深度一日", "items": [{"type": "transport", "from": "回
execution_state: {"execution_status":"failed","effect_status":"not_committed","recovery_action":"fix_arguments"}
````

### 人工复核项（未自动判定）

- 从可信来源核实闭馆和预约要求，避免照抄常见开放时间
- 兵马俑主景区与坑馆不重复算多个主景点

## 11. 衢州两日游首尾半天版（quzhou-2d-arrival-departure）

- 自动状态：passed；质量状态：needs_confirmation；分数 99；保存 2/2 天。
- 工具调用 35 次，诊断错误 10 次；Session 可见错误 10 条。
- 原始记录：[attempt.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/quzhou-2d-arrival-departure/attempt-1/attempt.json) · [session.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/quzhou-2d-arrival-departure/attempt-1/session.json) · [tool-diagnostics.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/quzhou-2d-arrival-departure/attempt-1/tool-diagnostics.json)。
- 原始产物：[质量报告](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/quzhou-2d-arrival-departure/attempt-1/plans/衢州两日游11月14日15日.quality.md) · [final-itinerary.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/quzhou-2d-arrival-departure/attempt-1/final-itinerary.json)。

### 批次原始失败原因

本案例通过自动闸门；下列 P2 与人工复核事项仍需处理。

### 独立需求验收失败

本案例已执行的独立需求检查均通过。此结论不涵盖后面的人工复核项。

### 最终保存版本的全部质量问题

| 等级 | 类型 | 日期/条目 | 错误码 | 原文 |
| --- | --- | --- | --- | --- |
| P2 | 建议 | 第 1 天 2026-11-14 · 衢州站 → 衢州东方桥庵里精品酒店 | long-transport | 交通耗时 65 分钟，属于远郊/跨区长距离移动：请确认当天已预留缓冲（超过 60 分钟会提示，但不阻断交付） |
| P2 | 待确认 | 第 2 天 2026-11-15 · 衢州古城文化旅游区衢州博物馆 | missing-opening-hours | 衢州古城文化旅游区衢州博物馆 缺少开放时间 |
| P2 | 建议 | 第 2 天 2026-11-15 | incomplete-day-end | 当天结束早于参考 15:00；允许提前返店，节奏提示不扣分、不阻断 |
| P2 | 待确认 | 第 2 天 2026-11-15 · 衢州古城文化旅游区衢州博物馆 | unverified-closure | 衢州古城文化旅游区衢州博物馆 尚无可核验的闭馆规则，请出发前确认；此项不扣规划分 |

### 执行过程中实际发生的错误（原文示例）

**首个可见错误**（save_itinerary；call_00_O4ASp9M1IeESAg7XkPxG0602）

````text
[tool-result type=error chars=329]
工具执行失败: end_time 必须晚于 time（条目: 20:00晚餐结束后步行返回酒店休息（水亭门→桥庵里岛约1.3km，需自行安排返程交通））
execution_state: {"operation_id":"sess_1794222554987_9524947c:msg_1794222588381_533:call_00_O4ASp9M1IeESAg7XkPxG0602","execution_status":"failed","effect_status":"not_committed","recovery_action":"manual_review","code":"OPERATION_FAILED_NOT_COMMITTED"}
````

**最后一个可见错误**（save_itinerary；call_00_odD2GX83uhJDhmOnfbaH9791）

````text
[tool-result type=error chars=891]
工具执行失败: 参数中的条目ID「5a2f1e39fdf1fec326b8」在日期「2026-11-15」不存在，不能作为局部补丁；当前可用ID：1541e6ac6ea6b7402bd5(衢州东方桥庵里精品酒店)、item-dae186eae30c6f12c9b5(衢州东方桥庵里精品酒店 → 衢州古城文化旅游区衢州博物馆)、item-1b52c688ce7e316f82a3(衢州古城文化旅游区衢州博物馆)、item-c8b818299a5cb3ca32b5(衢州古城文化旅游区衢州博物馆 → 衢州味道主题街区)、item-a557aa85311ef2642fcd(衢州味道主题街区)、item-8dc94942e82eee86e986(衢州味道.衢味记(新华巷店))、item-7475c5680a3f375c3e1b(小西门外卖(北门街历史文化街区店))、item-7af1088e22c3b5713157(好灶头儒文化餐厅(水亭门店))、item-23bb0fd119cb8be55712(杨爱珍大排档(水亭门店))、item-4b3eb8741f46496735c4(午餐休整 · 衢州味道街区候选餐厅自选)、item-5a2f1e39fdf1fec326b8(衢州古城文化旅游区水亭门历史文化街区)、item-ab5813e0bdb04724a69a(衢州古城文化旅游区水亭门历史文化街区 → 衢州站)。新增条目需要完整name/type，不要猜测ID或重读整天。
execution_state: {"operation_id":"sess_1794222554987_9524947c:msg_1794222668401_574:call_00_odD2GX83uhJDhmOnfbaH9791","execution_status":"failed","effect_status":"not_committed","recovery_action":"fix_arguments","code":"OPERATION_FAILED_NOT_COMMITTED"}
````

### 人工复核项（未自动判定）

- 首尾两天不能按完整游玩日硬塞活动
- 返程车站的通勤与进站缓冲是否实际可行

## 12. 上海两日游无障碍版（shanghai-2d-accessible）

- 自动状态：passed；质量状态：needs_confirmation；分数 99；保存 2/2 天。
- 工具调用 36 次，诊断错误 10 次；Session 可见错误 10 条。
- 原始记录：[attempt.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/shanghai-2d-accessible/attempt-1/attempt.json) · [session.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/shanghai-2d-accessible/attempt-1/session.json) · [tool-diagnostics.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/shanghai-2d-accessible/attempt-1/tool-diagnostics.json)。
- 原始产物：[质量报告](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/shanghai-2d-accessible/attempt-1/plans/上海无障碍两日游.quality.md) · [final-itinerary.json](/Users/coolbloodfrog/minicode/eval/runs/comprehensive-full-v1/cases/shanghai-2d-accessible/attempt-1/final-itinerary.json)。

### 批次原始失败原因

本案例通过自动闸门；下列 P2 与人工复核事项仍需处理。

### 独立需求验收失败

本案例已执行的独立需求检查均通过。此结论不涵盖后面的人工复核项。

### 最终保存版本的全部质量问题

| 等级 | 类型 | 日期/条目 | 错误码 | 原文 |
| --- | --- | --- | --- | --- |
| P2 | 待确认 | 第 2 天 2026-11-11 · 上海邮政博物馆 | missing-opening-hours | 上海邮政博物馆 缺少开放时间 |
| P2 | 建议 | 第 1 天 2026-11-10 | incomplete-day-end | 当天结束早于参考 18:00；允许提前返店，节奏提示不扣分、不阻断 |
| P2 | 建议 | 第 2 天 2026-11-11 | incomplete-day-end | 当天结束早于参考 18:00；允许提前返店，节奏提示不扣分、不阻断 |
| P2 | 待确认 | 第 2 天 2026-11-11 · 上海邮政博物馆 | unverified-closure | 上海邮政博物馆 尚无可核验的闭馆规则，请出发前确认；此项不扣规划分 |

### 执行过程中实际发生的错误（原文示例）

**首个可见错误**（get_place_reviews；call_00_YCkBKGCBc9B5zEmafVF27943）

````text
[tool-result type=error chars=143]
工具执行失败: 缺少或非法参数 place（需要非空字符串）
execution_state: {"execution_status":"failed","effect_status":"not_committed","recovery_action":"fix_arguments"}
````

**最后一个可见错误**（save_itinerary；call_00_xDU99iBbTwPFAc9C1hZK3280）

````text
[tool-result type=error chars=301]
工具执行失败: end_time 必须晚于 time（条目: 上海外滩南京路步行街建国铂萃酒店）
execution_state: {"operation_id":"sess_1794222873484_c17ad890:msg_1794222978688_857:call_00_xDU99iBbTwPFAc9C1hZK3280","execution_status":"failed","effect_status":"not_committed","recovery_action":"manual_review","code":"OPERATION_FAILED_NOT_COMMITTED"}
````

### 人工复核项（未自动判定）

- 轮椅可达入口、电梯、洗手间、无障碍房需要具体证据
- 未核实的无障碍设施不得写成已确认
- 交通接驳不能默认所有站点出口都有电梯

## 人工审阅发现的漏检（不属于原自动错误码）

- 上海低预算：最终酒店没有 room_price_per_night 或住宿 cost_per_person；自动花费为 ¥57.33/人，不能证明包含住宿的 ¥600 总预算达成。
- 上海无障碍：酒店备注出现“已订1间无障碍房（2人1间）”，但用户请求未提供已订信息，执行轨迹没有预订动作；无障碍设施仍多为待确认。
- 苏州长辈：第三天实际包含至 18:20 的休息/散步/晚饭，唯一 P1 却认作 15:30 后结束太早，需复核规则口径。
- 4 个缺天案例的自动续跑消息之后均没有新增工具调用；completion_retries=1 不等于实际执行了有效恢复。

原因分析与优先级见 [批次分析](/Users/coolbloodfrog/minicode/docs/comprehensive-full-v1-analysis.md)。
