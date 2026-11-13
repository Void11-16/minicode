# 分层规划真实评测：comprehensive-failed-layers-v1

2026-11-10 20:37:38—20:50:12（北京时间），耗时约12分34秒。使用`deepseek/deepseek-chat`、`travel-v29`、`comprehensive@2026.11.2`，重跑上次未通过的7例，启用strict。旧批次未覆盖，也未改写其判定。

- strict：**1/7通过**；上次v28为0/7。通过的是北京固定酒店。
- 保存要求的详细日期：**6/7例**，合计21/22天；上次为3/7例、合计14/22天。成都从3/3退回2/3。
- 所有日期都有基础分配：7/7例、22/22天；同时满足基础日期、必去和跨日去重条件的只有**3/7例**。
- 日内P0/P1清零：7/22天；不能替代整体验收及独立需求检查。
- 可行性层整日达标：所有案例均为0天。资料获取受阻、字段调用错误及基础层阻塞都仍存在，不能把“已查询工具”当作已核验。
- 执行：309轮 / 440次工具；4,350,261累计Token（含重复与缓存输入）；估算**¥3.8345**。上次为3,368,289 Token / ¥2.9945。

本次与v28均为单次真实联网运行，部分旅行日期、外部数据、模型输出和评分版本不同（v10→v11）。以下比较实际产物和错误，不把分数变化直接当作改造效果，也不据1次样本推断稳定通过率。

[原始可读报告](../eval/runs/comprehensive-failed-layers-v1/report.md) · [机器报告](../eval/runs/comprehensive-failed-layers-v1/report.json) · [批次清单](../eval/runs/comprehensive-failed-layers-v1/manifest.json) · [上次分析](comprehensive-failed-day-tasks-v1-analysis.md)

## 各案例结果

“基础分配/达标”中，前者只统计有具体景点的日期；后者还要求必去分配和跨日去重同时满足。“日内达标”不包含独立需求验收。

| 案例 | v28详细日期 | v29详细日期 | 基础分配 / 基础层达标 | 日内达标 | 本次P1 | strict |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| 杭州亲子 | 无产出 | 2/2 | 2/2 / 否 | 0/2 | 9 | 未通过 |
| 苏州长辈 | 2/3 | 3/3 | 3/3 / 是 | 2/3 | 3 | 未通过 |
| 成都全素 | 3/3 | 2/3 | 3/3 / 是 | 2/3 | 2 | 未通过 |
| 北京固定酒店 | 3/3 | 3/3 | 3/3 / 是 | 3/3 | 0 | 通过 |
| 赤峰远郊 | 4/5 | 5/5 | 5/5 / 否 | 0/5 | 22 | 未通过 |
| 杭州天气备选 | 2/2 | 2/2 | 2/2 / 否 | 0/2 | 7 | 未通过 |
| 福州慢逛 | 无产出 | 4/4 | 4/4 / 否 | 0/4 | 10 | 未通过 |

## 本轮暴露的主要问题

### 基础层把必去点匹配与其他日期推进绑定过紧

杭州亲子的“西湖”、赤峰的“乌兰布统”、天气备选的“浙江省博物馆”、福州的“烟台山”未被归属为有效的必去分配。这4例虽然有全部日期基础安排，`basic_complete`仍为false，日期分层任务累计尝试均为0。

当前`basicLayerActive`以基础层整体达标为解除条件，`basicLayerCallIssue`同时拦住开放、酒店、路线等后续查询；但仍允许`save_itinerary`提交详细days。由此出现“必去点身份未解决→后续取证被挡→继续保存缺证据的详细草稿”的循环。4例分别有23、24、18、24次基础层拦截。详细日期增多了，质量没有随之达标。这是本轮确认的调度耦合缺口，不能仅归因于模型预算不足。

应让无法识别的单个必去目标成为独立待解决任务：允许有针对性的身份/主子点/区域关系查询，其他日期和不依赖该目标的后续任务继续推进；同时明确基础层的保存范围，避免绕过阶段生成缺证据的细排。本次仅运行评测，未在运行途中改代码或调整验收来消除该失败。

### 工具参数和开放证据链仍不稳定

日志仍有旧字段`opening_hours/closed_on/duration`被传给参观工具、`place`写成`query`、行程条目缺name、`opening_hours`传成字符串、JSON截断等问题。更正：餐厅工具的city按当前契约表示搜索中心，region表示所在城市，因此把景点名填入city本身是有效写法，不归为参数错误。

北京7次实际开放查询中，请求19个字段，只提取1个可引用字段；HTTP遥测还记录百度、DuckDuckGo、360验证码及网络错误。查询受阻的未知字段未冒充事实，严格通过的北京仍保留9项P2。苏州、成都、北京的后续时间路线阶段已实际执行，但不能据此声称可行性证据齐全。

### 日期补齐有进展，草稿修复和需求闭环仍不足

北京P1从10降为0；苏州从2/3天变为3/3天，P1从6降为3。杭州亲子和福州从无文件变为完整日期，赤峰从4/5变为5/5。

但成都仍缺1天，开放时间冲突草稿未修好；苏州首日超过景点上限；赤峰交通过长、住宿未核实及转场窗口缺失；福州没有落实固定酒店。strict完整检查和独立需求检查继续将这些案例判为未通过。

以下是各案例完整错误入口。最终行程P0为0只说明违规草稿未进入最终版本，拒绝草稿中的真实冲突仍需查看。

## 杭州亲子（hangzhou-2d-family）

- 详细日期：无产出 → 2/2；strict：未通过；P0/P1/P2：0/9/16。
- 基础层未满足的必去目标：西湖；日期分层任务累计尝试0次；基础层拦截23次。
- 执行：33轮 / 43次工具，436,145 Token，估算¥0.4155。
- P1分类：`incomplete-day-end` ×2；`unverified-place-evidence` ×2；`uncertain-required-visit` ×1；`missing-route-leg` ×4。

[完整质量报告](../eval/runs/comprehensive-failed-layers-v1/cases/hangzhou-2d-family/attempt-1/plans/杭州两日亲子游.quality.md) · [最终行程](../eval/runs/comprehensive-failed-layers-v1/cases/hangzhou-2d-family/attempt-1/final-itinerary.json) · [Session](../eval/runs/comprehensive-failed-layers-v1/cases/hangzhou-2d-family/attempt-1/session.json) · [诊断](../eval/runs/comprehensive-failed-layers-v1/cases/hangzhou-2d-family/attempt-1/tool-diagnostics.json) · [attempt](../eval/runs/comprehensive-failed-layers-v1/cases/hangzhou-2d-family/attempt-1/attempt.json)

## 苏州长辈（suzhou-3d-senior）

- 详细日期：2/3 → 3/3；strict：未通过；P0/P1/P2：0/3/9。
- 基础层未满足的必去目标：无；日期分层任务累计尝试12次；基础层拦截0次。
- 执行：63轮 / 88次工具，937,339 Token，估算¥0.8048。
- P1分类：`missing-time` ×1；`missing-route-leg` ×2。
- 独立需求失败：`daily-visit-limit`：第 1 天游览 3 个主景点，上限 2。
- 首日仍有无时间条目，以及苏州博物馆→苏州恋爱博物馆、苏州恋爱博物馆→酒店两段真实路线缺失；首日3个主景点超出上限2。

[完整质量报告](../eval/runs/comprehensive-failed-layers-v1/cases/suzhou-3d-senior/attempt-1/plans/苏州三日亲子慢游两位70岁父母.quality.md) · [最终行程](../eval/runs/comprehensive-failed-layers-v1/cases/suzhou-3d-senior/attempt-1/final-itinerary.json) · [Session](../eval/runs/comprehensive-failed-layers-v1/cases/suzhou-3d-senior/attempt-1/session.json) · [诊断](../eval/runs/comprehensive-failed-layers-v1/cases/suzhou-3d-senior/attempt-1/tool-diagnostics.json) · [attempt](../eval/runs/comprehensive-failed-layers-v1/cases/suzhou-3d-senior/attempt-1/attempt.json)

## 成都全素（chengdu-3d-vegetarian）

- 详细日期：3/3 → 2/3；strict：未通过；P0/P1/P2：0/2/9。
- 基础层未满足的必去目标：无；日期分层任务累计尝试10次；基础层拦截2次。
- 执行：59轮 / 86次工具，902,985 Token，估算¥0.8212。
- P1分类：`title-day-mismatch` ×1；`unmaterialized-outline-day` ×1。
- 缺失日期为2026-11-12。对应拒绝草稿记录文殊院停留超出08:00—17:00，另有`opening_hours`被传为字符串的参数错误；后续日期已保存，说明不是前一天失败后所有日期都未获执行。失败草稿与最终行程分开保留。

[完整质量报告](../eval/runs/comprehensive-failed-layers-v1/cases/chengdu-3d-vegetarian/attempt-1/plans/成都三日全素人文游.quality.md) · [最终行程](../eval/runs/comprehensive-failed-layers-v1/cases/chengdu-3d-vegetarian/attempt-1/final-itinerary.json) · [Session](../eval/runs/comprehensive-failed-layers-v1/cases/chengdu-3d-vegetarian/attempt-1/session.json) · [诊断](../eval/runs/comprehensive-failed-layers-v1/cases/chengdu-3d-vegetarian/attempt-1/tool-diagnostics.json) · [attempt](../eval/runs/comprehensive-failed-layers-v1/cases/chengdu-3d-vegetarian/attempt-1/attempt.json)

[缺失日的最后拒绝草稿](../eval/runs/comprehensive-failed-layers-v1/cases/chengdu-3d-vegetarian/attempt-1/.minicode/day-tasks/bc23ab43bf8a7cb12620/rejected-draft.json)

## 北京固定酒店（beijing-3d-fixed-hotel）

- 详细日期：3/3 → 3/3；strict：通过；P0/P1/P2：0/0/9。
- 基础层未满足的必去目标：无；日期分层任务累计尝试11次；基础层拦截2次。
- 执行：51轮 / 80次工具，724,496 Token，估算¥0.6357。
- 通过表示现有strict和独立需求检查通过；P2及核验层未达标内容仍须显示，不能解读为所有开放资料已核实。

[完整质量报告](../eval/runs/comprehensive-failed-layers-v1/cases/beijing-3d-fixed-hotel/attempt-1/plans/北京三日游.quality.md) · [最终行程](../eval/runs/comprehensive-failed-layers-v1/cases/beijing-3d-fixed-hotel/attempt-1/final-itinerary.json) · [Session](../eval/runs/comprehensive-failed-layers-v1/cases/beijing-3d-fixed-hotel/attempt-1/session.json) · [诊断](../eval/runs/comprehensive-failed-layers-v1/cases/beijing-3d-fixed-hotel/attempt-1/tool-diagnostics.json) · [attempt](../eval/runs/comprehensive-failed-layers-v1/cases/beijing-3d-fixed-hotel/attempt-1/attempt.json)

## 赤峰远郊（chifeng-5d-remote-mix）

- 详细日期：4/5 → 5/5；strict：未通过；P0/P1/P2：0/22/41。
- 基础层未满足的必去目标：乌兰布统；日期分层任务累计尝试0次；基础层拦截24次。
- 执行：52轮 / 72次工具，705,256 Token，估算¥0.6175。
- P1分类：`timeline-gap` ×1；`long-transport` ×3；`unverified-place-evidence` ×4；`missing-day-window` ×3；`uncertain-required-visit` ×1；`missing-route-leg` ×3；`unverified-route` ×7。

[完整质量报告](../eval/runs/comprehensive-failed-layers-v1/cases/chifeng-5d-remote-mix/attempt-1/plans/赤峰五日自驾游.quality.md) · [最终行程](../eval/runs/comprehensive-failed-layers-v1/cases/chifeng-5d-remote-mix/attempt-1/final-itinerary.json) · [Session](../eval/runs/comprehensive-failed-layers-v1/cases/chifeng-5d-remote-mix/attempt-1/session.json) · [诊断](../eval/runs/comprehensive-failed-layers-v1/cases/chifeng-5d-remote-mix/attempt-1/tool-diagnostics.json) · [attempt](../eval/runs/comprehensive-failed-layers-v1/cases/chifeng-5d-remote-mix/attempt-1/attempt.json)

## 杭州天气备选（hangzhou-2d-weather-backup）

- 详细日期：2/2 → 2/2；strict：未通过；P0/P1/P2：0/7/8。
- 基础层未满足的必去目标：浙江省博物馆；日期分层任务累计尝试0次；基础层拦截18次。
- 执行：22轮 / 30次工具，274,739 Token，估算¥0.2151。
- P1分类：`timeline-gap` ×1；`missing-accommodation` ×2；`incomplete-day-end` ×1；`uncertain-required-visit` ×1；`missing-route-leg` ×2。

[完整质量报告](../eval/runs/comprehensive-failed-layers-v1/cases/hangzhou-2d-weather-backup/attempt-1/plans/杭州两日游.quality.md) · [最终行程](../eval/runs/comprehensive-failed-layers-v1/cases/hangzhou-2d-weather-backup/attempt-1/final-itinerary.json) · [Session](../eval/runs/comprehensive-failed-layers-v1/cases/hangzhou-2d-weather-backup/attempt-1/session.json) · [诊断](../eval/runs/comprehensive-failed-layers-v1/cases/hangzhou-2d-weather-backup/attempt-1/tool-diagnostics.json) · [attempt](../eval/runs/comprehensive-failed-layers-v1/cases/hangzhou-2d-weather-backup/attempt-1/attempt.json)

## 福州慢逛（fuzhou-4d-slow-exclusions）

- 详细日期：无产出 → 4/4；strict：未通过；P0/P1/P2：0/10/3。
- 基础层未满足的必去目标：烟台山；日期分层任务累计尝试0次；基础层拦截24次。
- 执行：29轮 / 41次工具，369,301 Token，估算¥0.3247。
- P1分类：`timeline-gap` ×1；`missing-accommodation` ×4；`incomplete-day-end` ×3；`uncertain-required-visit` ×1；`missing-route-leg` ×1。
- 独立需求失败：`fixed-stay`：全程固定同一酒店，且每个过夜日都有住宿锚点。

[完整质量报告](../eval/runs/comprehensive-failed-layers-v1/cases/fuzhou-4d-slow-exclusions/attempt-1/plans/福州四日慢游三坊七巷烟台山.quality.md) · [最终行程](../eval/runs/comprehensive-failed-layers-v1/cases/fuzhou-4d-slow-exclusions/attempt-1/final-itinerary.json) · [Session](../eval/runs/comprehensive-failed-layers-v1/cases/fuzhou-4d-slow-exclusions/attempt-1/session.json) · [诊断](../eval/runs/comprehensive-failed-layers-v1/cases/fuzhou-4d-slow-exclusions/attempt-1/tool-diagnostics.json) · [attempt](../eval/runs/comprehensive-failed-layers-v1/cases/fuzhou-4d-slow-exclusions/attempt-1/attempt.json)
