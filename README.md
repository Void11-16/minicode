# minicode

一个零运行时依赖、无构建步骤的 AI Agent 实现：使用 Node.js 原生 TypeScript，提供 CLI 与 Web 双端、24 个内置工具、MCP Server，以及可开关的旅行规划能力。

旅行规划不是唯一的定位，但它是当前最完整的垂直场景：从需求单、真实数据取数、逐日排程，到坐标核验、通勤复核、质量闸门、地图编辑和离线评测，形成了一条可验证的闭环。

## 当前状态

- Node.js 原生 TypeScript，运行时零依赖，无需打包
- 24 个内置工具，同时可通过 stdio MCP 暴露
- 38 个测试文件、312 个测试用例
- 6 份真实行程产出纳入离线质量基线
- Web 端支持多会话、流式输出、地图、行程编辑与旅行者档案
- 尚未配置 CI；推送前需要在本地执行 lint、typecheck 和测试
- 尚未声明 LICENSE，默认版权保留

## 快速开始

需要 Node.js 22.18 或更高版本（推荐当前 LTS/Node 24）。

```bash
npm install       # 仅类型检查、lint 和测试需要；运行本身零依赖
npm run chat      # CLI 对话
npm run web       # Web 界面，默认 http://localhost:3000
```

未配置模型时会使用 Mock Provider，可以直接离线体验界面和工具流程。

### 接入模型

支持任意 OpenAI 兼容接口，也可以使用 DeepSeek 或本地 Ollama。

```bash
export DEEPSEEK_API_KEY="sk-..."
export DEEPSEEK_MODEL="deepseek-chat"

# 或使用其他 OpenAI 兼容服务
export LLM_API_KEY="sk-..."
export LLM_BASE_URL="https://api.openai.com/v1"
export LLM_MODEL="gpt-4o-mini"
```

推荐在对话中保存配置：

```text
/config set deepseek_api_key sk-...
/config set amap_api_key <高德 Web 服务 Key>
/config set taste_preferences 不吃辣、人均 100 以内、想尝试本地特色
/config
```

配置保存在 `.minicode/config.json`，密钥在展示时会自动打码。多模型配置保存在 `.minicode/models.json`：

- CLI：`/models` 查看，`/model <序号|名称>` 切换，`/model add|edit|del` 管理
- Web：在设置中维护模型，在顶栏为当前会话选择
- 模型选择随会话持久化，不同会话可以使用不同模型

## CLI 与 Web

### CLI

- 多轮对话、流式输出与工具调用
- `/travel on|off` 开关旅行规划能力（CLI 默认开启）
- `/approval` 切换审批模式
- `/sessions`、`/resume`、`/new`、`/rename`、`/delete` 管理会话
- 执行中输入默认为 steer，会在当前轮的工具边界注入；`/queue <内容>` 排到下一轮
- 每轮展示 token 用量、估算成本和上下文缓存命中情况

### Web

- 多会话并行执行，实时显示会话状态
- 工具 chip：执行时显示 spinner，成功后淡出移除；失败或拒绝会保留原因
- 思考计时：只统计模型思考/生成时间，不包含工具执行和等待授权
- 历史消息回放不会重复展示成功的工具调用，只保留失败与拒绝
- 修改 `src/web/index.html` 后刷新页面即可生效，无需重启服务
- 旅行地图：按天/全部切换、时间线侧栏、真实路线、住宿起终点、餐饮聚合与条目编辑
- POI 照片：只给景点、餐饮和住宿条目加载；交通、休整、自由活动、备注不会借用落脚点照片
- 旅行者档案：导入 `.docx`、`.xlsx`、`.md`、`.txt`，合并同行人的忌口、辣度与节奏约束

## 旅行规划

主流程：

```text
用户需求
  -> save_travel_brief（结构化需求单）
  -> search_attractions / search_restaurants / search_stays
  -> get_place_reviews（口碑与游玩时长）
  -> get_weather（按行程日期查询）
  -> plan_day_routes（相邻停留点通勤）
  -> save_itinerary（可逐日 merge）
  -> validate_itinerary(strict=true)（整份验收）
  -> Web 地图与可编辑时间线
```

### 工具轮次预算

工具轮数按本次工作量动态计算，而不是固定 30 轮：

- 基础公式：`10 + 6 × 行程天数`
- 紧凑节奏 `+8`，慢节奏 `-4`
- 自驾、包车、远郊、长线、徒步等备注 `+6`
- 每个必去地点 `+2`，最多累计 `+8`
- 初始预算夹在 `[12, 120]`
- 用完最多续期 3 次，每次 15 轮，绝对上限 150

需求单尚未落盘时，会从会话文本中的“7 日游/七天”或日期区间估算天数。预算是上限而不是必须消耗的配额，短行程不会因为预算存在而多调用工具。

### 质量校验

`save_itinerary` 写入 JSON、Markdown 和质量报告；`validate_itinerary` 负责最终验收。

- P0：时间冲突、闭馆日等硬错误，保存与交付都会被拒绝
- P1：时间线空档、赶路不足、路线折返、游玩时长缺失等，`strict=true` 时拒绝交付
- P2：来源、置信度、开放时间、坐标待核实等提示
- 餐饮问题单独作为“餐饮参考”，不参与行程状态和评分，也不会单独阻断交付
- 支持按天 `merge=true` 分批保存，每批都走校验，最终对整份行程执行 strict 验收

校验覆盖时间线、餐段、停留时长、交通衔接、当日折返、跨天重复、开放时间、预算和坐标等规则。质量为 `100 - 20×P0 - 7×P1 - 2×P2`，并输出 `ok`、`needs_confirmation`、`needs_revision` 或 `invalid` 状态。

### 坐标与照片

- 首选逐字复制搜索工具返回的 POI 名称与坐标
- 单独核验时调用 `geocode` 并传入 `city`；工具会校验省/市字段，避免“北海公园”命中外地同名地点
- 会过滤停车场、厕所等噪声 POI
- 无法可靠核验时不返回坐标；行程条目不带经纬度，并在 note 标记“坐标待核实”
- 质量报告将这类条目记为 `unverified-coordinates`（P2），而不是逼迫模型猜坐标
- 地图照片缓存键包含天数与条目，避免同一 id 在不同日期串用照片

## 数据源与降级

| 数据 | 主来源 | 兜底/说明 |
|------|--------|-----------|
| 景点、餐厅、住宿、通勤、照片、坐标 | 高德 Web 服务 | OSM/Overpass、OSRM 等按能力降级 |
| 地理编码 | 高德 | Photon、Open-Meteo |
| 天气 | Open-Meteo | 免费、无 Key |
| 驾车路线 | 高德/OSRM | 失败时平滑降级 |
| 网络口碑 | Bing、百度、360、DuckDuckGo | 结果页抓取并过滤同名异地与百科噪声 |
| 公共设施 | Overpass 镜像 | 免费、无 Key |

可靠性处理：

- 高德请求全局串行，最小间隔 250ms；遇到 `10021`（并发/QPS 超限）退避并最多重试两次
- Overpass 依次尝试多个镜像；单次 8 秒超时、总预算 20 秒；失败镜像冷却 5 分钟；相同查询缓存 10 分钟
- 高德与 OSM 同时失败时，会分别说明两个数据源的原因，避免把限流误报成 OSM 故障
- 天气默认查未来 3 天，最多 16 天，支持 `start_date`/`end_date`
- 第 8 天起标记“参考性低”，第 11 天起标记“仅供趋势参考”
- 超出 16 天、服务失败或数据缺失时必须明确告知，不允许编造

## 内置工具（24 个）

**工作区与命令**

`read_file`、`write_file`、`edit_file`、`list_files`、`grep`、`bash`

**天气、地理与路线**

`get_weather`、`geocode`、`reverse_geocode`、`calculate_distance`、`get_route`、`plan_day_routes`

**旅行数据**

`search_attractions`、`search_restaurants`、`search_stays`、`get_place_reviews`

**行程与需求**

`save_travel_brief`、`load_travel_brief`、`save_itinerary`、`load_itinerary`、`list_itineraries`、`validate_itinerary`

**旅行者档案**

`list_traveler_profiles`、`load_traveler_profile`

新增工具只需实现 `Tool` 接口并注册到 `ToolRegistry`，Agent 与 MCP Server 会自动发现。

## MCP Server

24 个工具通过 stdio MCP Server 暴露，使用手写 JSON-RPC，无运行时依赖。

```bash
node src/mcp/main.ts
```

Codex 配置示例：

```toml
[mcp_servers.minicode]
command = "node"
args = ["/绝对路径/minicode/src/mcp/main.ts"]
```

MCP 与 CLI/Web 共享 `.minicode/config.json`。行程与需求单写入项目 `plans/`，文件工具和 `bash` 以项目目录为工作区。

## 权限与运行时

审批模式：

| 模式 | 行为 |
|------|------|
| `ask` | 文件写入和命令都需确认 |
| `edits`（默认） | 工作区文件写入免确认，命令仍需确认 |
| `trust` | 当前会话全部免确认，恢复后重置 |

审批规则统一由 `src/service/permission-policy.ts` 实现，CLI 与 Web 共用策略，只改变询问界面。只读命令自动放行；变更命令支持按命令前缀记忆授权。

运行时保证：

- 不同会话并发，同会话串行合并
- `steer` 在当前轮的工具边界注入；`queue` 等到下一轮
- 会话历史在安全边界落盘
- Context Epoch 在上下文过大时压缩旧消息，压缩边界不会拆散工具调用组
- 压缩使用被压缩会话自己的 provider，不串用其他会话的模型
- token 用量、估算成本和缓存命中率随会话持久化

## 离线评测与基线

评测框架用于回答“这轮提示词或工具改动，是提升还是削弱了生成质量”。

```bash
npm run eval                         # 评测 eval/out 中已有产出
npm run eval:live                    # 用真实模型重新生成，再评测（会产生 API 费用）
npm run eval:plans                   # 离线重评 plans/ 下的真实产出，零生成费用
npm run eval:plans -- --diff         # 与最新基线对比
npm run eval:plans -- --save [name]  # 保存本轮指标为基线
```

当前基线为 `eval/baselines/2026-10-15-initial.json`，记录了 6 份真实产出的指标，没有缺失样本。基线只保存评分、问题数、问题码、推荐证据率、餐饮覆盖、游览密度、最大空档、路线问题和人均花费等指标，不保存行程正文；重新评测时需要本机保留对应的 `plans/` 文件。

评测指标包括：

- 推荐证据率：餐厅是否同时有评分和人均信息
- 餐段候选充足度
- 菜系与价位多样性
- 本地特色覆盖与游览密度
- 时间线最大空档与路线问题
- 人均花费与预算偏差

报告写入 `eval/out/plans-report.json` 和 `eval/out/plans-report.md`，可直接审阅指标变化。

## 项目结构

```text
src/
├── cli/          终端入口、命令、交互 UI
├── web/          HTTP 服务、单文件前端、地图、坐标校准、照片缓存
├── agent/        对话与工具循环、分层系统提示词
├── llm/          Provider 抽象、OpenAI 兼容、DeepSeek、Mock
├── runtime/      会话调度、steer/queue、动态工具预算
├── core/         会话、消息、token 估算与用量
├── context/      Context Epoch 与历史压缩
├── service/      审批策略与会话服务
├── storage/      会话持久化
├── config/       应用配置与多模型
├── tools/        24 个工具、质量校验与数据源适配
├── mcp/          stdio MCP Server
└── eval/         指标、基线、离线/真实产出评测

test/             38 个测试文件
plans/            本地行程、需求单与同行人档案（运行时数据，不入库）
eval/             评测样例、基线与报告
.minicode/        本地配置、会话与缓存（不入库）
```

`plans/` 下只保留可复用的旅行者档案模板；生成的行程、需求单和导入的档案都属于用户数据，已加入 `.gitignore`。删除本地文件前仍应自行备份，因为这不会随仓库恢复。

## 开发验证

```bash
npm run lint
npm run typecheck
npm test
npm run eval:plans -- --diff
```

本次工作区状态：lint、typecheck 通过，312/312 测试通过，离线基线对比无回归。

当前仓库没有 CI，因此 push 不会自动触发这些检查；当前仓库也没有 LICENSE，默认保留所有权利。若准备接受外部复用，应单独选择并添加许可证。
