# 上次失败案例重跑：comprehensive-failed-day-tasks-v1

本次使用 `deepseek/deepseek-chat`、提示词 `travel-v28`，重跑 `comprehensive-full-v1` 未通过的7例；套件仍为 `comprehensive@2026.11.2`。真实联网生成，旧批次保留。

- strict通过：**0/7**。
- 保存要求天数：**3/7**；旧批次对应案例为 **3/7**。
- 模型累计Token：3,368,289（含各轮重复输入与缓存输入）；估算费用：¥2.9945。
- 旧提示词为travel-v25；新旧均使用真实外部服务且日期有所变化，每例只运行一次，不是固定世界A/B。评分版本也有变化，以下优先比较实际天数和具体错误，不将分数变化直接归功于本次改造。

[原始可读报告](../eval/runs/comprehensive-failed-day-tasks-v1/report.md) · [机器报告](../eval/runs/comprehensive-failed-day-tasks-v1/report.json)

| 案例 | 上次天数 | 本次天数 | 本次strict | P0/P1 |
| --- | ---: | ---: | --- | ---: |
| 杭州亲子 | 0/2 | 无产出 | 未通过 | — |
| 苏州长辈 | 3/3 | 2/3 | 未通过 | 0/6 |
| 成都全素 | 2/3 | 3/3 | 未通过 | 0/4 |
| 北京固定酒店 | 0/3 | 3/3 | 未通过 | 0/10 |
| 赤峰远郊 | 2/5 | 4/5 | 未通过 | 0/13 |
| 杭州天气备选 | 2/2 | 2/2 | 未通过 | 0/7 |
| 福州慢逛 | 4/4 | 无产出 | 未通过 | — |

## 本次确认的改进和缺口

1. 日期隔离实际生效：成都由2/3补到3/3，北京由0/3补到3/3，赤峰由2/5补到4/5。苏州的首日失败后，后两天仍保存成功，之后再回到首日重试。完整保存案例总数仍为3/7，且苏州和福州退步，不能据此宣称整体交付已改善。
2. 冻结门槛过早：当前实现以成功保存有效游览判定该日saved，未要求日内基本P1处理完成。成都、北京等已保存日仍有未核验路线、缺交通段等P1，冻结后不再自动修订。需要把“保存了草稿”和“当天已完成、可固定”进一步区分，避免为了补天留下不可交付的固定日期。
3. 粗排前仍有全局空转：杭州亲子没有保存过outline或days，停在景点结果读取和重查，随后触发12轮停滞；日期任务尚未启动，自动续跑也未产生新工具调用。按日调度不能覆盖这个启动阶段。
4. 参数校验被误分类为副作用不明：福州将avoid传成字符串 `"[\"鼓山\"]"`，正确类型应为字符串数组。`save_travel_brief`在parseBrief阶段、进入runManagedOperation写入前就抛出“avoid需要字符串数组”，执行状态却是effect_status=unknown，导致整个工具批次停止、后续search_stays未执行，续跑也直接停止。这是输入错误恢复链路的缺口，不能归为预算不足或真实旅行条件无法满足。
5. 苏州有窗口语义误伤的可能：失败首日草稿的08:30—09:00是“酒店早餐，09:00出发”，用户要求是09:00前不出发；该住宿条目被outside-day-window硬拒绝。需要复核酒店内部活动与实际出发的边界，保留真实交通和游览时间检查。本次没有因此修改评分或把失败改成通过。
6. 模型工具参数仍不稳定：苏州两次save参数末尾多出一个右花括号，成都多次把参观资料参数place写成name、字段名写成旧格式。已有单元回归不能替代这些真实输出的契约测试。

## 逐案例错误与执行状态

### 杭州亲子（hangzhou-2d-family）

状态：`generation_failed`；实际 0/2 天。
执行：16轮 / 20次工具；估算¥0.1744。

失败说明：生成结束但未找到行程文件

未进入独立日期任务阶段。

[Session](../eval/runs/comprehensive-failed-day-tasks-v1/cases/hangzhou-2d-family/attempt-1/session.json) · [诊断](../eval/runs/comprehensive-failed-day-tasks-v1/cases/hangzhou-2d-family/attempt-1/tool-diagnostics.json) · [attempt](../eval/runs/comprehensive-failed-day-tasks-v1/cases/hangzhou-2d-family/attempt-1/attempt.json)

### 苏州长辈（suzhou-3d-senior）

状态：`quality_failed`；实际 2/3 天。
执行：36轮 / 45次工具；估算¥0.5794。

失败说明：行程天数 2/3，未达到案例要求；P0 0 / P1 6（missing-opening-hours, missing-source, title-day-mismatch, incomplete-day-end, unmaterialized-outline-day, missing-required-visit, unverified-route, missing-route-leg, expected-day-count-mismatch）

- [P1] title-day-mismatch：标题为3日游，实际仅排了 2 天：请补齐缺失日期；若用户已明确缩短行程，再同步修改标题
- [P1] unmaterialized-outline-day：粗排 2026-11-13 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐
- [P1] missing-required-visit：必去「拙政园」仅在 2026-11-13 预留，尚未保存有效游览时间；请落实对应条目
- [P1] unverified-route / Day 2：宜必思·尚品酒店(苏州体育中心三香路店) → 寒山寺：宜必思·尚品酒店(苏州体育中心三香路店) → 寒山寺 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"苏州","stops":["宜必思·尚品酒店(苏州体育中心三香路店)","寒山寺"],"mode":"transit"})，引用返回ID后重新保存；宜必思·尚品酒店(苏州体育中心三香路店) → 寒山寺 缺少已核验的交通段；该时段现有交通为「宜必思·尚品酒店(苏州体育中心三香路店) → 寒山寺 / transit」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"苏州","stops":["宜必思·尚品酒店(苏州体育中心三香路店)","寒山寺"],"mode":"transit"})，引用返回ID后重新保存
- [P1] unverified-route / Day 2：寒山寺 → 苏州市运河体育公园：寒山寺 → 苏州市运河体育公园 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"苏州","stops":["寒山寺","苏州市运河体育公园"],"mode":"walking"})，引用返回ID后重新保存；寒山寺 → 苏州市运河体育公园 缺少已核验的交通段；该时段现有交通为「寒山寺 → 苏州市运河体育公园 / walking」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"苏州","stops":["寒山寺","苏州市运河体育公园"],"mode":"walking"})，引用返回ID后重新保存
- [P1] unverified-route / Day 2：苏州市运河体育公园 → 宜必思·尚品酒店(苏州体育中心三香路店)：苏州市运河体育公园 → 宜必思·尚品酒店(苏州体育中心三香路店) 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"苏州","stops":["苏州市运河体育公园","宜必思·尚品酒店(苏州体育中心三香路店)"],"mode":"walking"})，引用返回ID后重新保存；苏州市运河体育公园 → 宜必思·尚品酒店(苏州体育中心三香路店) 缺少已核验的交通段；该时段现有交通为「苏州市运河体育公园 → 宜必思·尚品酒店(苏州体育中心三香路店) / walking」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"苏州","stops":["苏州市运河体育公园","宜必思·尚品酒店(苏州体育中心三香路店)"],"mode":"walking"})，引用返回ID后重新保存

日期任务：

- 2026-11-13：blocked，2次尝试，19轮/22次工具；最近错误：连续3轮只有重复调用、无新资料或修改，已停止重复循环；未通过的条件仍须如实列出。
- 2026-11-14：saved，1次尝试，9轮/11次工具
- 2026-11-15：saved，1次尝试，2轮/3次工具

失败草稿 2026-11-13：[原始参数与完整拒绝原因](../eval/runs/comprehensive-failed-day-tasks-v1/cases/suzhou-3d-senior/attempt-1/.minicode/day-tasks/eba96b6b47f5518d6f7b/rejected-draft.json)

- Day 1 · item-e0bfd84be7947112ca90: 宜必思·尚品酒店(苏州体育中心三香路店) 超出当天已知可用时间（outside-day-window）
- Day 1 · item-cea177c9073a1e3367c2: [资料待确认] 苏州博物馆(本馆) 缺少开放时间（missing-opening-hours）
- Day 1 · 当天重复安排 香遇江南·传承苏帮菜·评弹表演(拙政园店)（duplicate-place）
- Day 1 · 当天重复安排 姑苏小院·老灶(园外苑店)（duplicate-place）

[Session](../eval/runs/comprehensive-failed-day-tasks-v1/cases/suzhou-3d-senior/attempt-1/session.json) · [诊断](../eval/runs/comprehensive-failed-day-tasks-v1/cases/suzhou-3d-senior/attempt-1/tool-diagnostics.json) · [attempt](../eval/runs/comprehensive-failed-day-tasks-v1/cases/suzhou-3d-senior/attempt-1/attempt.json) · [最终行程](../eval/runs/comprehensive-failed-day-tasks-v1/cases/suzhou-3d-senior/attempt-1/final-itinerary.json)

### 成都全素（chengdu-3d-vegetarian）

状态：`quality_failed`；实际 3/3 天。
执行：28轮 / 47次工具；估算¥0.3627。

失败说明：P0 0 / P1 4（missing-source, missing-confidence, missing-opening-hours, unverified-closure, missing-route-leg, unverified-route）

- [P1] missing-route-leg / Day 1：宽窄巷子景区 → 成都锦都嘉玺酒店(演艺中心SKP环球中心店) 缺少已核验的交通段。请调用 plan_day_routes({"city":"成都","stops":["宽窄巷子景区","成都锦都嘉玺酒店(演艺中心SKP环球中心店)"],"mode":"transit"})，引用返回ID后重新保存
- [P1] unverified-route / Day 2：成都锦都嘉玺酒店(演艺中心SKP环球中心店) → 青羊宫：成都锦都嘉玺酒店(演艺中心SKP环球中心店) → 青羊宫 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"成都","stops":["成都锦都嘉玺酒店(演艺中心SKP环球中心店)","青羊宫"],"mode":"transit"})，引用返回ID后重新保存
- [P1] unverified-route / Day 2：成都蜀锦织绣博物馆 → 成都锦都嘉玺酒店(演艺中心SKP环球中心店)：成都蜀锦织绣博物馆 → 成都锦都嘉玺酒店(演艺中心SKP环球中心店) 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"成都","stops":["成都蜀锦织绣博物馆","成都锦都嘉玺酒店(演艺中心SKP环球中心店)"],"mode":"transit"})，引用返回ID后重新保存；成都蜀锦织绣博物馆 → 成都锦都嘉玺酒店(演艺中心SKP环球中心店) 缺少已核验的交通段；该时段现有交通为「成都蜀锦织绣博物馆 → 成都锦都嘉玺酒店(演艺中心SKP环球中心店) / transit」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"成都","stops":["成都蜀锦织绣博物馆","成都锦都嘉玺酒店(演艺中心SKP环球中心店)"],"mode":"transit"})，引用返回ID后重新保存
- [P1] missing-route-leg / Day 2：文化公园 → 成都蜀锦织绣博物馆 缺少已核验的交通段。请调用 plan_day_routes({"city":"成都","stops":["文化公园","成都蜀锦织绣博物馆"],"mode":"transit"})，引用返回ID后重新保存

日期任务：

- 2026-11-11：saved，1次尝试，5轮/9次工具
- 2026-11-12：saved，1次尝试，5轮/8次工具
- 2026-11-13：saved，1次尝试，10轮/8次工具

[Session](../eval/runs/comprehensive-failed-day-tasks-v1/cases/chengdu-3d-vegetarian/attempt-1/session.json) · [诊断](../eval/runs/comprehensive-failed-day-tasks-v1/cases/chengdu-3d-vegetarian/attempt-1/tool-diagnostics.json) · [attempt](../eval/runs/comprehensive-failed-day-tasks-v1/cases/chengdu-3d-vegetarian/attempt-1/attempt.json) · [最终行程](../eval/runs/comprehensive-failed-day-tasks-v1/cases/chengdu-3d-vegetarian/attempt-1/final-itinerary.json)

### 北京固定酒店（beijing-3d-fixed-hotel）

状态：`quality_failed`；实际 3/3 天。
执行：44轮 / 64次工具；估算¥0.6010。

失败说明：P0 0 / P1 10（missing-time, missing-source, missing-confidence, long-transport, missing-opening-hours, reservation-required, incomplete-day-end, unverified-closure, unverified-route, missing-route-leg）

- [P1] missing-time / Day 1：存在缺少 time 的条目（餐饮候选除外），无法完整核验时间线
- [P1] unverified-route / Day 1：颐和园 → 圆明园博物馆：颐和园 → 圆明园博物馆 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"北京","stops":["颐和园","圆明园博物馆"],"mode":"transit"})，引用返回ID后重新保存；颐和园 → 圆明园博物馆 缺少已核验的交通段；该时段现有交通为「颐和园 → 圆明园博物馆 / 方式未填」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"北京","stops":["颐和园","圆明园博物馆"],"mode":"transit"})，引用返回ID后重新保存
- [P1] unverified-route / Day 1：圆明园博物馆 → 首都宾馆B座：圆明园博物馆 → 首都宾馆B座 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"北京","stops":["圆明园博物馆","首都宾馆B座"],"mode":"transit"})，引用返回ID后重新保存
- [P1] unverified-route / Day 2：太庙 → 首都宾馆B座：太庙 → 首都宾馆B座 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"北京","stops":["太庙","首都宾馆B座"],"mode":"walking"})，引用返回ID后重新保存；太庙 → 首都宾馆B座 缺少已核验的交通段；该时段现有交通为「太庙 → 首都宾馆B座 / walking」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"北京","stops":["太庙","首都宾馆B座"],"mode":"walking"})，引用返回ID后重新保存
- [P1] missing-route-leg / Day 2：天安门广场 → 太庙 缺少已核验的交通段。请调用 plan_day_routes({"city":"北京","stops":["天安门广场","太庙"],"mode":"transit"})，引用返回ID后重新保存
- [P1] unverified-route / Day 3：首都宾馆B座 → 中国国家博物馆：首都宾馆B座 → 中国国家博物馆 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"北京","stops":["首都宾馆B座","中国国家博物馆"],"mode":"walking"})，引用返回ID后重新保存；首都宾馆B座 → 中国国家博物馆 缺少已核验的交通段；该时段现有交通为「首都宾馆B座 → 中国国家博物馆 / walking」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"北京","stops":["首都宾馆B座","中国国家博物馆"],"mode":"walking"})，引用返回ID后重新保存
- [P1] unverified-route / Day 3：中国国家博物馆 → 中国铁道博物馆正阳门馆：中国国家博物馆 → 中国铁道博物馆正阳门馆 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"北京","stops":["中国国家博物馆","中国铁道博物馆正阳门馆"],"mode":"walking"})，引用返回ID后重新保存；中国国家博物馆 → 中国铁道博物馆正阳门馆 缺少已核验的交通段；该时段现有交通为「中国国家博物馆 → 中国铁道博物馆正阳门馆 / walking」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"北京","stops":["中国国家博物馆","中国铁道博物馆正阳门馆"],"mode":"walking"})，引用返回ID后重新保存
- [P1] unverified-route / Day 3：中国铁道博物馆正阳门馆 → 菖蒲河公园：中国铁道博物馆正阳门馆 → 菖蒲河公园 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"北京","stops":["中国铁道博物馆正阳门馆","菖蒲河公园"],"mode":"walking"})，引用返回ID后重新保存；中国铁道博物馆正阳门馆 → 菖蒲河公园 缺少已核验的交通段；该时段现有交通为「中国铁道博物馆正阳门馆 → 菖蒲河公园 / walking」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"北京","stops":["中国铁道博物馆正阳门馆","菖蒲河公园"],"mode":"walking"})，引用返回ID后重新保存
- [P1] unverified-route / Day 3：菖蒲河公园 → 首都宾馆B座：菖蒲河公园 → 首都宾馆B座 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"北京","stops":["菖蒲河公园","首都宾馆B座"],"mode":"walking"})，引用返回ID后重新保存；菖蒲河公园 → 首都宾馆B座 缺少已核验的交通段；该时段现有交通为「菖蒲河公园 → 首都宾馆B座 / walking」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"北京","stops":["菖蒲河公园","首都宾馆B座"],"mode":"walking"})，引用返回ID后重新保存
- [P1] unverified-route / Day 3：首都宾馆B座 → 首都宾馆B座：首都宾馆B座 → 首都宾馆B座 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"北京","stops":["首都宾馆B座","首都宾馆B座"],"mode":"walking"})，引用返回ID后重新保存

日期任务：

- 2026-11-11：saved，1次尝试，6轮/10次工具
- 2026-11-12：saved，2次尝试，21轮/25次工具
- 2026-11-13：saved，2次尝试，9轮/13次工具

[Session](../eval/runs/comprehensive-failed-day-tasks-v1/cases/beijing-3d-fixed-hotel/attempt-1/session.json) · [诊断](../eval/runs/comprehensive-failed-day-tasks-v1/cases/beijing-3d-fixed-hotel/attempt-1/tool-diagnostics.json) · [attempt](../eval/runs/comprehensive-failed-day-tasks-v1/cases/beijing-3d-fixed-hotel/attempt-1/attempt.json) · [最终行程](../eval/runs/comprehensive-failed-day-tasks-v1/cases/beijing-3d-fixed-hotel/attempt-1/final-itinerary.json)

### 赤峰远郊（chifeng-5d-remote-mix）

状态：`quality_failed`；实际 4/5 天。
执行：75轮 / 113次工具；估算¥1.0124。

失败说明：行程天数 4/5，未达到案例要求；P0 0 / P1 13（missing-opening-hours, long-transport, day-too-long, missing-source, missing-confidence, remote-day-overpacked, missing-time, title-day-mismatch, missing-requested-date, unverified-closure, unverified-place-evidence, unmaterialized-outline-day, missing-route-leg, unverified-route, expected-day-count-mismatch）

- [P1] missing-time / Day 4：存在缺少 time 的条目（餐饮候选除外），无法完整核验时间线
- [P1] title-day-mismatch：标题为5日游，实际仅排了 4 天：请补齐缺失日期；若用户已明确缩短行程，再同步修改标题
- [P1] missing-requested-date：缺少需求单指定日期 2026-11-20
- [P1] unverified-place-evidence / Day 2：乌兰布统镇住宿（当地民宿/酒店，具体名称与房价待核实） 缺少对应城市的工具地点证据
- [P1] unverified-place-evidence / Day 3：乌兰布统镇住宿（当地民宿/酒店，具体名称与房价待核实） 缺少对应城市的工具地点证据
- [P1] unverified-place-evidence / Day 3：经棚镇住宿（克什克腾旗驻地，具体酒店名称与房价待核实） 缺少对应城市的工具地点证据
- [P1] unverified-place-evidence / Day 4：德林酒店(克什克腾旗经棚镇店) 缺少对应城市的工具地点证据
- [P1] unverified-place-evidence / Day 4：德林酒店(克什克腾旗经棚镇店) 缺少对应城市的工具地点证据
- [P1] unmaterialized-outline-day：粗排 2026-11-20 尚未保存有效行程；预留景点不计完成天数，请按该日期补齐
- [P1] missing-route-leg / Day 2：乌兰布统超级盛宴机车公园 → 乌兰布统镇住宿（当地民宿/酒店，具体名称与房价待核实） 缺少已核验的交通段。请调用 plan_day_routes({"city":"赤峰","stops":["乌兰布统超级盛宴机车公园","乌兰布统镇住宿（当地民宿/酒店，具体名称与房价待核实）"],"mode":"transit"})，引用返回ID后重新保存
- [P1] unverified-route / Day 3：乌兰布统镇住宿（当地民宿/酒店，具体名称与房价待核实） → 乌兰布统影视基地：乌兰布统镇住宿（当地民宿/酒店，具体名称与房价待核实） → 乌兰布统影视基地 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"赤峰","stops":["乌兰布统镇住宿（当地民宿/酒店，具体名称与房价待核实）","乌兰布统影视基地"],"mode":"driving"})，引用返回ID后重新保存；乌兰布统镇住宿（当地民宿/酒店，具体名称与房价待核实） → 乌兰布统影视基地 缺少已核验的交通段；该时段现有交通为「乌兰布统镇住宿（当地民宿/酒店，具体名称与房价待核实） → 乌兰布统影视基地 / driving」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"赤峰","stops":["乌兰布统镇住宿（当地民宿/酒店，具体名称与房价待核实）","乌兰布统影视基地"],"mode":"driving"})，引用返回ID后重新保存
- [P1] unverified-route / Day 3：贡格尔草原 → 经棚镇住宿（克什克腾旗驻地，具体酒店名称与房价待核实）：贡格尔草原 → 经棚镇住宿（克什克腾旗驻地，具体酒店名称与房价待核实） 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"赤峰","stops":["贡格尔草原","经棚镇住宿（克什克腾旗驻地，具体酒店名称与房价待核实）"],"mode":"driving"})，引用返回ID后重新保存；贡格尔草原 → 经棚镇住宿（克什克腾旗驻地，具体酒店名称与房价待核实） 缺少已核验的交通段；该时段现有交通为「贡格尔草原 → 经棚镇住宿（克什克腾旗驻地，具体酒店名称与房价待核实） / driving」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"赤峰","stops":["贡格尔草原","经棚镇住宿（克什克腾旗驻地，具体酒店名称与房价待核实）"],"mode":"driving"})，引用返回ID后重新保存
- [P1] unverified-route / Day 4：达里湖景区 → 德林酒店(克什克腾旗经棚镇店)：达里湖景区 → 德林酒店(克什克腾旗经棚镇店) 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"赤峰","stops":["达里湖景区","德林酒店(克什克腾旗经棚镇店)"],"mode":"driving"})，引用返回ID后重新保存；达里湖景区 → 德林酒店(克什克腾旗经棚镇店) 缺少已核验的交通段；该时段现有交通为「达里湖景区 → 德林酒店(克什克腾旗经棚镇店) / driving」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"赤峰","stops":["达里湖景区","德林酒店(克什克腾旗经棚镇店)"],"mode":"driving"})，引用返回ID后重新保存

日期任务：

- 2026-11-16：saved，1次尝试，5轮/7次工具
- 2026-11-17：saved，2次尝试，21轮/31次工具
- 2026-11-18：saved，1次尝试，5轮/6次工具
- 2026-11-19：saved，2次尝试，17轮/19次工具
- 2026-11-20：blocked，2次尝试，14轮/15次工具；最近错误：该日期达到单次软额度，先处理其他日期，再按独立额度重试

失败草稿 2026-11-20：[原始参数与完整拒绝原因](../eval/runs/comprehensive-failed-day-tasks-v1/cases/chifeng-5d-remote-mix/attempt-1/.minicode/day-tasks/01b85e3f3ee0ac9e0894/rejected-draft.json)


[Session](../eval/runs/comprehensive-failed-day-tasks-v1/cases/chifeng-5d-remote-mix/attempt-1/session.json) · [诊断](../eval/runs/comprehensive-failed-day-tasks-v1/cases/chifeng-5d-remote-mix/attempt-1/tool-diagnostics.json) · [attempt](../eval/runs/comprehensive-failed-day-tasks-v1/cases/chifeng-5d-remote-mix/attempt-1/attempt.json) · [最终行程](../eval/runs/comprehensive-failed-day-tasks-v1/cases/chifeng-5d-remote-mix/attempt-1/final-itinerary.json)

### 杭州天气备选（hangzhou-2d-weather-backup）

状态：`quality_failed`；实际 2/2 天。
执行：21轮 / 36次工具；估算¥0.2392。

失败说明：P0 0 / P1 7（long-transport, missing-opening-hours, missing-source, missing-confidence, missing-location, unverified-closure, unverified-place-evidence, incomplete-day-end, uncertain-required-visit, missing-route-leg, unverified-route）；daily-visit-limit: 第 1 天游览 3 个主景点，上限 2

- [P1] unverified-place-evidence / Day 1：钱江新城城市阳台 缺少对应城市的工具地点证据
- [P1] incomplete-day-end / Day 2：当天结束早于参考 18:00，缺口超过参考窗口的25%或没有有效活动，请确认是否缺少安排
- [P1] uncertain-required-visit：必去「浙江省博物馆」仅在 2026-11-14 预留，尚未保存有效游览时间；请落实对应条目
- [P1] missing-route-leg / Day 1：桔子水晶杭州钱江新城市民中心酒店 → 钱江新城城市阳台 缺少已核验的交通段。请调用 plan_day_routes({"city":"杭州","stops":["桔子水晶杭州钱江新城市民中心酒店","钱江新城城市阳台"],"mode":"transit"})，引用返回ID后重新保存
- [P1] unverified-route / Day 2：瓜寓公寓(钱江新城来福士店) → 杭州西湖博物馆总馆：瓜寓公寓(钱江新城来福士店) → 杭州西湖博物馆总馆 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"杭州","stops":["瓜寓公寓(钱江新城来福士店)","杭州西湖博物馆总馆"],"mode":"transit"})，引用返回ID后重新保存；瓜寓公寓(钱江新城来福士店) → 杭州西湖博物馆总馆 缺少已核验的交通段；该时段现有交通为「瓜寓公寓(钱江新城来福士店) → 杭州西湖博物馆总馆 / transit」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"杭州","stops":["瓜寓公寓(钱江新城来福士店)","杭州西湖博物馆总馆"],"mode":"transit"})，引用返回ID后重新保存
- [P1] unverified-route / Day 2：杭州西湖博物馆总馆 → 杭州西湖风景名胜区-岳王庙：杭州西湖博物馆总馆 → 杭州西湖风景名胜区-岳王庙 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"杭州","stops":["杭州西湖博物馆总馆","杭州西湖风景名胜区-岳王庙"],"mode":"walking"})，引用返回ID后重新保存；杭州西湖博物馆总馆 → 杭州西湖风景名胜区-岳王庙 缺少已核验的交通段；该时段现有交通为「杭州西湖博物馆总馆 → 杭州西湖风景名胜区-岳王庙 / walking」，请核对变化后的相邻地点。请调用 plan_day_routes({"city":"杭州","stops":["杭州西湖博物馆总馆","杭州西湖风景名胜区-岳王庙"],"mode":"walking"})，引用返回ID后重新保存
- [P1] unverified-route / Day 2：杭州西湖风景名胜区-岳王庙 → 瓜寓公寓(钱江新城来福士店)：杭州西湖风景名胜区-岳王庙 → 瓜寓公寓(钱江新城来福士店) 缺少当前端点的真实证据。请调用 plan_day_routes({"city":"杭州","stops":["杭州西湖风景名胜区-岳王庙","瓜寓公寓(钱江新城来福士店)"],"mode":"transit"})，引用返回ID后重新保存

- 独立需求验收失败：第 1 天游览 3 个主景点，上限 2

日期任务：

- 2026-11-14：saved，1次尝试，4轮/7次工具
- 2026-11-15：saved，1次尝试，12轮/13次工具

[Session](../eval/runs/comprehensive-failed-day-tasks-v1/cases/hangzhou-2d-weather-backup/attempt-1/session.json) · [诊断](../eval/runs/comprehensive-failed-day-tasks-v1/cases/hangzhou-2d-weather-backup/attempt-1/tool-diagnostics.json) · [attempt](../eval/runs/comprehensive-failed-day-tasks-v1/cases/hangzhou-2d-weather-backup/attempt-1/attempt.json) · [最终行程](../eval/runs/comprehensive-failed-day-tasks-v1/cases/hangzhou-2d-weather-backup/attempt-1/final-itinerary.json)

### 福州慢逛（fuzhou-4d-slow-exclusions）

状态：`generation_failed`；实际 0/4 天。
执行：2轮 / 3次工具；估算¥0.0254。

失败说明：生成结束但未找到行程文件

未进入独立日期任务阶段。

[Session](../eval/runs/comprehensive-failed-day-tasks-v1/cases/fuzhou-4d-slow-exclusions/attempt-1/session.json) · [诊断](../eval/runs/comprehensive-failed-day-tasks-v1/cases/fuzhou-4d-slow-exclusions/attempt-1/tool-diagnostics.json) · [attempt](../eval/runs/comprehensive-failed-day-tasks-v1/cases/fuzhou-4d-slow-exclusions/attempt-1/attempt.json)

## 解释边界

日期任务的saved只表示成功保存有效日程，不代表日内P1全部清零。已保存日期会固定，因此未核验路线等问题可能留在最终报告中。真实缺失、路线问题或用户窗口违反均继续使strict失败，没有修改失败标签或评分来使本次通过。
本报告是对这次原始运行结果的整理；未在批次运行中修改源代码、案例、评分规则或历史产物。
