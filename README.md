# minicode

[![CI](https://github.com/Void11-16/minicode/actions/workflows/ci.yml/badge.svg)](https://github.com/Void11-16/minicode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个零运行时依赖、无构建步骤的 AI Agent 实现：使用 Node.js 原生 TypeScript，提供 CLI 与 Web 双端、24 个内置工具、MCP Server，以及可开关的旅行规划能力。

旅行规划不是唯一的定位，但它是当前最完整的垂直场景：从需求单、真实数据取数、逐日排程，到坐标核验、通勤复核、质量闸门、地图编辑和离线评测，形成了一条可验证的闭环。

## 当前状态

- Node.js 原生 TypeScript，运行时零依赖，无需打包
- 24 个内置工具，同时可通过 stdio MCP 暴露
- 48 个测试文件、410 个测试用例
- 6 份真实行程产出纳入离线质量基线
- Web 端支持邮箱账号、多会话、流式输出、地图、行程编辑与旅行者档案
- GitHub Actions CI 覆盖 Node.js 22.18 与 24，自动执行 lint、typecheck 和测试
- 使用 [MIT License](LICENSE) 开源

## 快速开始

需要 Node.js 22.18 或更高版本（推荐当前 LTS/Node 24）。

```bash
npm install       # 仅类型检查、lint 和测试需要；运行本身零依赖
npm run chat      # CLI 对话
npm run web       # Web 界面，默认 http://localhost:3000
```

未配置模型时会使用 Mock Provider，可以直接离线体验界面和工具流程。
首次打开 Web 端时注册本地邮箱账号；邮箱只作为唯一登录标识，当前阶段不会发送验证邮件。

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
/config set price_in 2
/config set price_cache_in 0.2
/config
```

配置保存在 `.minicode/config.json`，密钥在展示时会自动打码。多模型配置保存在 `.minicode/models.json`：

- CLI：`/models` 查看，`/model <序号|名称>` 切换，`/model add|edit|del` 管理
- Web：在设置中维护模型，在顶栏为当前会话选择
- 模型选择随会话持久化，不同会话可以使用不同模型

### 缓存计价

`price_in`、`price_cache_in`、`price_out` 的单位都是元/百万 token。模型 Profile 中的
`priceIn`、`priceCacheIn`、`priceOut` 优先于全局配置；Profile 字段为空时逐项回退全局价，
再回退默认价。

```text
估算成本 =
  缓存命中输入 token × price_cache_in
  + 未命中输入 token × price_in
  + 输出 token × price_out
```

未配置 `price_cache_in` 时，缓存命中部分按普通输入价计算，属于保守估算，不会把缓存价
误当成 0。CLI、Web 用量面板和 live 评测都会记录同一个价格口径。

## CLI 与 Web

### CLI

- 多轮对话、流式输出与工具调用
- `/travel on|off` 开关旅行规划能力（CLI 默认开启）
- `/approval` 切换审批模式
- `/sessions`、`/resume`、`/new`、`/rename`、`/delete` 管理会话
- 执行中输入默认为 steer，会在当前轮的工具边界注入；`/queue <内容>` 排到下一轮
- 每轮展示 token 用量、估算成本和上下文缓存命中情况

### Web

- 邮箱 + 密码注册、登录与持久登录；每个账号的会话、模型和行程独立保存
- 多会话并行执行，实时显示会话状态
- 旅游欢迎页、旅行意图快捷入口和响应式账号/设置界面，保留现有聊天与地图工作流
- 工具 chip：执行时显示 spinner，成功后淡出移除；失败或拒绝会保留原因
- 思考计时：只统计模型思考/生成时间，不包含工具执行和等待授权
- 历史消息回放不会重复展示成功的工具调用，只保留失败与拒绝
- 工具轮次耗尽时暂停并展示质量评估，由用户决定追加调用或按当前结果交付
- 修改 `src/web/index.html` 后刷新页面即可生效，无需重启服务
- 旅行地图：按天/全部切换、时间线侧栏、真实路线、住宿起终点、餐饮聚合与条目编辑
- POI 照片：只给景点、餐饮和住宿条目加载；交通、休整、自由活动、备注不会借用落脚点照片
- 旅行者档案：导入 `.docx`、`.xlsx`、`.md`、`.txt`，合并同行人的忌口、辣度与节奏约束

## 工具上下文与历史压缩

工具不再在每轮请求里全部展开：

- `find_tools`、`activate_tools`、`deactivate_tools` 构成工具目录；新会话第一轮只发送这三个
  目录工具的定义
- 模型按任务和分类激活需要的工具，完整参数定义从下一轮开始发送，每会话最多激活
  12 个可选工具
- 激活状态随会话持久化；未分类的第三方工具仍按常驻处理，保持扩展兼容
- 工具定义带 `outputKind`，结果以 `[tool-result type=<kind> chars=<n>]` 开头，模型无需
  解析时猜返回的是地点列表、路线、天气还是校验报告

工具结果进入上下文前会经过两层预算：

- 单条结果最多 3,000 字符
- 同一批工具结果合计最多 8,000 字符；并行调用较多时按剩余预算分配

超限结果原文写入
`.minicode/artifacts/<session>/<tool>-<call-id>.txt`（错误结果为 `.error`）。上下文只保留
类型头、字符数、artifact 路径和按工具类型提取的字段摘要；地点按候选绑定坐标、证据 ID、价格单位，
交通保留端点、时长、估算状态与路线 ID，校验优先保留 P0/P1，未知格式回退到首尾与关键行预览。
需要完整数据时用 `read_file` 的 `byte_offset=0` 开始按 UTF-8 字节分页，并按返回的游标续读；
字节模式支持超过 2MB 的文件和超长单行，每页最多 2,000 字节，不整文件加载。最近使用的 8 个 artifact 会以索引形式
注入请求。

bash 持续消费 stdout/stderr，各保留最多 15,000 字符的首尾，中间日志丢弃并明确标记；
大量输出不会持续增加日志缓冲，也不因达到预览上限中断命令。需要完整命令日志时应在命令中重定向到文件。
artifact 保存的是工具返回的文本，不包含 bash 在执行阶段已丢弃的日志；归档写入失败会明确提示，不能承诺原文可回读。

一批工具完成后，旧工具轮次会从后续模型请求中移除，普通任务最近一轮、旅行任务最近三轮保留完整调用参数以便精确修改；
完整审计副本仍保存在本地会话中。每次模型请求前会把系统提示词、工具定义、历史和临时状态统一计量，
超过默认 24,000 输入 token 预算时压缩为“摘要 + 最近安全边界”，摘要输入按用户约束、近期消息、质量问题和 artifact
路径加权，并严格受字符上限约束。

跨天规划不依赖反复读取全部历史。会话额外持久化一份紧凑的结构化旅行状态：

- 目的地、日期、人数、预算、节奏、必去、避开和口味约束
- 当前行程的天数、条目数、评分、P0/P1/P2、strict 状态和待修问题
- 已选地点的名称、条目类型、细分 `place_type`、日序、日期、坐标和来源

状态卡每轮以临时 system 消息注入，最多约 6,000 字符。跨天去重和“今天避免全是博物馆”
这类判断直接使用地点类型；修改行程时先
`load_itinerary({ title, summary: true })` 看索引，再按 `day=N` 读取受影响的一天。

这里不使用 RAG：旅行规划需要的是少量、精确、会随本轮决策更新的结构化事实。向量检索适合
大规模非结构化资料，但无法稳定保证“同名地点不重复”或“读取的坐标就是刚保存的版本”。
当前方案用确定性状态、结构化类型、artifact 和按需工具加载解决这些问题，成本更低，也更容易
为跨天去重写回归测试。

## 账号与本地数据

Web 账号模式默认启用。账号数据库位于 `.minicode/users.db`，密码使用随机盐的
`scrypt` 派生值保存；登录使用 30 天有效的 `HttpOnly; SameSite=Lax` Cookie，数据库只保存
Cookie token 的 SHA-256，不保存可直接使用的 token。

每个账号拥有独立的运行时和数据目录：

```text
.minicode/
├── users.db
├── config.json              # 新账号继承的本地默认配置
└── users/
    └── usr_<id>/
        ├── plans/
        └── .minicode/
            ├── sessions/
            ├── models.json
            ├── photo-cache.json
            ├── artifacts/
            └── config.json
```

账号模式不开放 `/api/workspace` 和 `/api/fs/dirs`，也不会代理通配 CORS 响应头。当前服务只监听
`127.0.0.1`，定位是本机可运行的账号原型，不是可直接公网部署的生产认证系统。

尚未包含：邮件验证、密码找回、登录限流、MFA/OAuth、CSRF token、账号注销与管理后台、
审计日志、HTTPS 和 `Secure` Cookie。若后续上线，需要先接入邮件服务和限流，给 Cookie 增加
`Secure`，校验 `Origin`/CSRF，并补齐备份、密钥管理与安全测试。

`startWebServer({ auth: false })` 仅用于测试或嵌入式单用户模式；该模式沿用本地工作区，
不提供账号隔离。

## 旅行规划

三日／五日实测对应的四项修复、验收口径与真实服务限制见 [旅行规划修复与验收](docs/travel-planning-fixes.md)。

旅行工具查询缓存有效期为 30 分钟，已采集证据保留采集时间，不随缓存到期而失效。
住宿参考价统一为人民币每房每晚；预算按房数、晚数和同行人数折算为人均，默认 2 人、每间 2 人，末日住宿锚点默认不再计一晚。

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
- 用完不会静默续期：暂停本轮，先重新评估已保存行程的质量
- 评估会列出评分、P0/P1/P2、主要缺口，以及哪些问题能靠工具补数据修复
- 由用户选择“追加轮次继续完善”（按需求缺口至少 15 轮）或“按当前结果交付”，绝对上限 150 轮
- Web 端等待 5 分钟无应答会自动按当前结果收尾，避免后台会话永久挂起

需求单尚未落盘时，会从会话文本中的“7 日游/七天”或日期区间估算天数。预算是上限而不是必须消耗的配额，短行程不会因为预算存在而多调用工具。

轮次耗尽时看到的质量报告来自重新读取本会话最近一次成功保存的 `plans/*.json` 并执行
`validateItinerary()`，不是模型自述。工具可修复项会标为 `tool`，重排/取舍类问题标为
`edit`，依赖预约状态或外部数据且不保证能解决的问题标为 `uncertain`；“理论上限”只表示
可修复项清零后的分数，不会把不可靠信息当作已核实。评估会单独标注 strict 是否已通过：
P2 提示会拉低完整度分，但 P0/P1 为 0 时已经满足 strict，继续调用只是可选完善，不是交付前置条件。

### 质量校验

`save_itinerary` 写入 JSON、Markdown 和质量报告；`validate_itinerary` 负责最终验收。

- P0：时间冲突、闭馆日等硬错误，保存与交付都会被拒绝
- P1：时间线空档、赶路不足、路线折返、游玩时长缺失等，`strict=true` 时拒绝交付
- P2：来源、置信度、开放时间、坐标待核实等提示
- 餐饮默认仅作建议，适用午晚餐每餐目标 2 家，不参与整体状态和评分；可按行程配置严格模式、数量与证据率
- 远郊日使用专用模板：1 个主景点，最多再加主景点 20 公里内的 1 个轻量活动；返程后不再叠加市区景点
- 支持按天 `merge=true` 保存与分日验收；跨天问题尽早发现、优先局部修复，最终仍对整份执行 strict 验收

校验覆盖时间线、餐段、停留时长、交通衔接、当日折返、跨天重复、开放时间、预算和坐标等规则。评分按实际检查对象归一化、按维度汇总后乘完整度；分数不替代 P0/P1 阻断，仍输出 `ok`、`needs_confirmation`、`needs_revision` 或 `invalid` 状态。

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

除下面 24 个业务工具外，还有 3 个不占业务工具名额的会话控制工具：
`find_tools`、`activate_tools`、`deactivate_tools`。

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

评测框架用于回答两个问题：“这轮提示词或工具改动，是提升还是削弱了生成质量”，
以及“某个失败案例修复后能否独立复跑并留下证据”。

```bash
npm run eval -- --suite core         # 离线检查旧 eval/out 产出
npm run eval:live -- --suite representative --run-id 20261026-representative
npm run eval:live -- --resume 20261026-representative
npm run eval:plans                   # 离线重评 plans/ 下的真实产出，零生成费用
npm run eval:plans -- --diff         # 与最新基线对比
npm run eval:plans -- --save [name]  # 保存本轮指标为基线
```

评测分为三层：

- **套件** 定义“测什么”。`eval/suites/core.json` 是完整回归集，
  `representative.json` 是北京三日、北京五日和赤峰七日三个代表案例；案例可用
  `--case`、`--tag`、`--limit` 筛选。
- **批次** 定义“何时、用什么配置测”。每批写入独立且不可覆盖的
  `eval/runs/<run-id>/`，保存套件快照、筛选条件、模型、提示词版本、静态/自定义
  提示词哈希、价格口径、动态预算策略和汇总报告。
- **attempt** 定义“每次实际生成”。失败后续跑只选择未通过案例，并为它们创建新的
  attempt；已通过案例不会重复消耗模型和地图额度。中断与失败历史不会被覆盖。

每个 attempt 都记录：

- 模型 Profile、Provider 和具体模型
- 提示词版本、静态哈希、自定义提示词哈希、渲染后哈希
- 模型工具轮数、单轮内工具调用次数、动态预算初始值/当前值/硬上限/续期记录
- 输入、输出、总 Token、请求数、缓存命中 Token
- 按配置单价估算的 CNY 成本、总耗时
- 失败阶段、失败原因和问题列表
- 质量指标、会话快照、最终行程副本

续跑要求模型、旅行提示词、自定义提示词和价格口径与原批次一致，避免把不可比较的配置
混进同一批次；配置已变化时应新建批次。生成过程中崩溃的 attempt 会标为 `interrupted`，
磁盘上已经创建但尚未写入清单的 attempt 目录也会占号，不会被下一次续跑覆盖。

同一 attempt 的 `plans/` 可能因分天保存保留多个标题相近的文件。评测只在当前 attempt
目录内选择产物：先找标题相关的候选，再优先符合案例期望天数的完整版本，随后比较标题
精确度、天数接近度和更新时间；损坏的 JSON 会被忽略，不会让同名旧文件冒充最终交付。

strict 通过标准是：实际天数与案例要求一致、存在有效指标、P0/P1 为 0。餐饮只有显式严格策略才参与阻断，目标取行程配置。报告写入
`eval/runs/<run-id>/report.json` 与 `report.md`，其中同时保留批次汇总和逐 attempt 明细。

质量指标包括：

- 推荐证据率：餐厅是否同时有评分和人均信息
- 餐段候选充足度
- 菜系与价位多样性
- 本地特色覆盖与游览密度
- 时间线最大空档与路线问题
- 人均花费与预算偏差

旧离线检查仍写入 `eval/out/`。基线只保存指标，不保存行程正文；重新评测时需要本机保留
对应的 `plans/` 文件，当前基线为 `eval/baselines/2026-10-15-initial.json`。

## 项目结构

```text
src/
├── cli/          终端入口、命令、交互 UI
├── web/          HTTP 服务、单文件前端、地图、坐标校准、照片缓存
├── auth/         本地邮箱账号、密码哈希与登录会话
├── agent/        对话与工具循环、结果裁剪、分层系统提示词
├── llm/          Provider 抽象、OpenAI 兼容、DeepSeek、Mock
├── runtime/      会话调度、steer/queue、动态工具预算
├── core/         会话、消息、token 估算、用量与结构化旅行状态
├── context/      Context Epoch 与有界历史摘要
├── service/      审批策略与会话服务
├── storage/      会话持久化
├── config/       应用配置与多模型
├── tools/        24 个工具、目录激活、质量校验与数据源适配
├── mcp/          stdio MCP Server
└── eval/         指标、基线、离线/真实产出评测

test/             48 个测试文件
plans/            本地行程、需求单与同行人档案（运行时数据，不入库）
eval/             评测样例、基线与报告
.minicode/        本地账号、配置、会话与缓存（不入库）
```

`plans/` 下只保留可复用的旅行者档案模板；生成的行程、需求单和导入的档案都属于用户数据，已加入 `.gitignore`。删除本地文件前仍应自行备份，因为这不会随仓库恢复。
账号模式下，这些用户数据实际写入 `.minicode/users/<userId>/plans/`。

## 开发验证

```bash
npm run lint
npm run typecheck
npm test
npm run eval:plans -- --diff
```

前三项由 GitHub Actions 在 Node.js 22.18 和 24 上自动执行。离线基线对比依赖本地 `plans/` 中的真实行程，不属于 CI 的必跑项。

贡献流程、提交规范和数据安全要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。


工具加载、按日上下文和统一执行预算的配置与验证说明见 [工具与上下文](docs/context-and-tools.md)。

当前餐饮策略、分日/整体验收、归一化评分与口径迁移见 [行程验收规则](docs/itinerary-validation.md)。
