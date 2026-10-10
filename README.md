# minicode

一个 opencode 风格的最小 AI 助手实现 —— **CLI + Web 双端**，零运行时依赖（依赖 Node 原生 TypeScript 支持，无构建步骤）。

**旅行规划是内置的可开关能力**（Web 右上角勾选「🗺️ 旅行规划」开启，CLI 默认开启），而不是唯一定位；天气查询、地点搜索、路线规划、文件与命令操作等工具在通用模式下同样可用。

## 特性亮点

- **双端体验**：CLI REPL 与 Web 应用（多会话并行、SSE 流式输出、会话管理、steer 注入）
- **多模型**：任意 OpenAI 兼容服务（DeepSeek / OpenAI / Ollama / vLLM…），**每个会话可独立选模型**，随会话持久化
- **旅行规划模块**：需求单 → 工具链取数 → 结构化行程（严格质量闸门）→ 地图可视化
- **22 个内置工具**：高德 POI/通勤、四引擎口碑抓取、免费兜底数据源（OSM/OSRM/Open-Meteo）、文件与 shell 操作
- **行程质量校验器**：P0/P1/P2 三级规则（时间线空档、赶路时间、路线折返、餐食候选、坐标遮挡、低分场馆……），strict 模式拒绝交付不合规行程
- **地图体验**：左侧时间线侧边栏（点击定位）、真实道路路径、POI 照片（缩略图 + 大图浮层）、餐厅候选低缩放聚合
- **工程化**：审批权限（CLI/Web 共享策略）、同会话串行 / 跨会话并发调度、上下文压缩（epoch）、token 成本统计、离线评测框架、MCP Server 出口

## 快速开始

```bash
# 需要 Node.js ≥ 22.18（原生 TypeScript 支持，实测 24；无需构建步骤）
npm install        # 可选：仅 typecheck / lint 需要（运行时零依赖）

npm run chat       # CLI：终端对话
npm run web        # Web：http://localhost:3000
npm test           # 测试（35 个文件 / 256 个用例）
npm run typecheck  # 类型检查
npm run lint       # oxlint
```

默认使用 Mock Provider（无需 API Key，可离线体验）。

### 接入真实模型

```bash
export DEEPSEEK_API_KEY="sk-..."      # DeepSeek（优先级最高）
export DEEPSEEK_MODEL="deepseek-chat" # 或 deepseek-reasoner
export LLM_API_KEY="sk-..."           # 其他 OpenAI 兼容服务
export LLM_BASE_URL="https://api.openai.com/v1"
export LLM_MODEL="gpt-4o-mini"
npm run chat
```

推荐方式：对话内 `/config set` 一次配置、永久生效（保存到 `.minicode/config.json`）：

```
/config set deepseek_api_key sk-...          # 配置一次，之后每次启动直接可用
/config set amap_api_key <高德Web服务Key>     # 可选：国内定位/POI/通勤质量大幅提升（免费配额）
/config set taste_preferences 不吃辣、人均100以内、想尝试本地特色
/config                                       # 查看当前配置（Key 自动打码）
/config clear deepseek_api_key                # 清除
```

多模型（CLI 与 Web 共享 `.minicode/models.json`）：

- **Web**：⚙️ 里配置多个 API（DeepSeek / OpenAI 兼容 / Mock），顶栏下拉为当前会话选择
- **CLI**：`/models` 查看列表，`/model <序号|名称关键词>` 切换当前会话的模型；
  `/model add` 交互式添加、`/model edit <序号>` 编辑（回车保留旧值）、
  `/model del <序号>` 删除（二次确认）、`/model default <序号>` 设为默认
- 不同会话可以用不同模型，选择随会话持久化（`/resume` 后保持）
- `/travel on|off` 开关旅行规划能力（off = 通用助手，CLI 默认开启）

## Web 版

- 聊天：SSE 流式输出；左侧会话列表（多任务并行，实时显示运行状态）；执行中可 steer 注入
- **🗺️ 行程地图**（旅行模块）：
  - 顶栏选择行程、按天/全部切换；显示**质量分与更新时间**（一眼核验"声称的更新"是否真的落盘）
  - 左侧**时间线侧边栏**：时间 / 时长 / 类型 / 备注，跟地图编号一一对应；点击条目定位标记并打开详情
  - 景点按全局路线顺序编号；**餐厅候选在低缩放时自动聚合**（点击放大展开），「🍜 美食」开关控制侧边栏显示
  - 真实道路路径（高德方向 API；失败平滑降级为虚线）与住宿起点/终点
  - **POI 照片**：弹窗照片条 + 侧边栏缩略图，点击进入大图浮层（←/→ 翻页，Esc 关闭）
  - **条目编辑**（不用找 AI 也能改）：侧栏每条右侧 ✏️ —— 替换（附近推荐横拉卡片 / 手输名称，自动取坐标）+ 上移/下移（时间槽跟随）+ 删除；改完自动重算路线并重生成 Markdown 与质量报告
  - **旅行者档案**（右上角 👥）：把《旅行者档案填写表》（`plans/profiles/模板/`，docx/xlsx）发给同行人填写，回来在页面导入（支持 .docx/.xlsx/.md/.txt 零依赖解析）→ 确认/编辑 → 保存；需求单里勾选同行人后，规划会自动合并约束（忌口取并集、辣度/节奏取最保守）
- **坐标自动校准**：模型写入的近似坐标会按地点名 + 邻域用高德 POI 重解析（带"同名异地"防护：搜索以条目自身为邻域、偏差过大直接拒绝），修一次永久标记

## 旅行规划模块

工作流：

```
需求文本 → save_travel_brief（需求单）→ search_attractions / search_restaurants / search_stays（取数）
→ get_place_reviews（口碑过滤）→ plan_day_routes（通勤实测）→ save_itinerary（strict 校验闸门）
→ validate_itinerary（复核）→ Web 地图可视化
```

### 行程质量校验

`save_itinerary` 保存前核验：**P0**（时间倒序/重叠等硬错误）直接拒绝；**P1/P2** 写入 `<行程名>.quality.md`；`strict: true` 时 P0/P1 全部拒绝。模型被要求交付前必须 `validate_itinerary({ strict: true })` 通过。

**餐饮与行程分开校验**：状态与评分只由行程类问题决定；餐饮项单列「餐饮参考」（如某餐段没有推荐、候选合并成一条、与景点坐标重合等），仅供取舍参考，不拦截交付——餐厅选哪家看当天想法，日程以景点/通勤/休整块为准，餐饮候选不参与时间线与路线核验。

规则集（节选）：

- **时间线**：时间倒序/重叠、缺少时间、时间线空档（餐饮候选不占时间线，但落在空档内的餐段候选视为已安排）
- **时长与节奏**：景点必须有游玩时长（P1）、时间线空档 >1.5 小时（P1）、相邻停留点赶路时间不足（P1）、单段交通 >60 分钟、全天活动 >10 小时
- **路线效率**：当日折返检测（首尾固定穷举最优顺序，给出聚类重排建议）、跨天重复景点（P1）
- **数据质量**：坐标缺失、低分博物馆/纪念馆提示（P2）、开放时间与闭馆日、预算、来源与置信度
- **餐饮参考（不参与评分）**：某餐段没有推荐、候选数量过少、多家餐厅合并成一条、餐标记与景点坐标重合、早餐候选离当天起点 >1.2km、用餐时间不在常规餐段
- **大行程支持**：`merge=true` 按天分批保存（避免一次性输出超出模型上限），每批仍走完整校验

### 口碑（get_place_reviews）

免费方案：直接抓取 **Bing / 百度 / 360 / DuckDuckGo** 的结果页，做**相关性过滤**（剔除百科/词典噪声、搜索页回显、同名异地），多引擎聚合凑够相关结果；任何引擎失效自动降级。找不到可靠口碑时，诚实返回"数据不足，请以评分/人均等结构化数据为准，不要臆测好坏"，而不是硬凑结果。可选升级：接入搜索 API（博查 / Tavily 等）可显著提升冷门商户覆盖。

顺带从摘要/页面文本中提取**「游玩时长参考」**（如"一般游玩 2-4 小时"，命中地点名的句子优先、排队/停车/营业时间等噪声剔除；`aspect=游玩时长` 可专项查询）——给景点排时间时优先采用，无数据才退回按类型经验值。

## 支持的数据源

| 数据 | 来源 | Key |
|------|------|-----|
| 景点 / 餐厅 / 住宿 / 通勤 / 照片 / 坐标校准 | 高德 Web 服务（主）+ OSM 兜底 | 需要（免费配额） |
| 口碑摘要 | Bing + 百度 + 360 + DuckDuckGo 结果页抓取 | 不需要 |
| 天气 | Open-Meteo | 不需要 |
| 地理编码兜底 | Photon（komoot）/ Open-Meteo | 不需要 |
| 驾车路线兜底 | OSRM 公共服务器 | 不需要 |
| 公共设施（OSM） | Overpass API 镜像 | 不需要 |

## 工具系统（22 个）

Agent 会自动决定何时调用工具，调用过程以 `⚡ 工具名(参数)` 实时显示：

| 工具 | 数据源 | 说明 |
|------|--------|------|
| `get_weather` | Open-Meteo（免费） | 未来 1-7 天天气预报 |
| `geocode` | **高德（需Key，主）** + Photon + Open-Meteo 兜底 | 地名 → 坐标；国内地址精度最好，规避 OSM 同名歧义 |
| `reverse_geocode` | Photon | 坐标 → 地名 |
| `calculate_distance` | 本地计算 | 两点直线距离 |
| `get_route` | OSRM（免费） | 驾车/步行/骑行路线距离与耗时 |
| `plan_day_routes` | **高德公交（需Key）** + OSRM 驾车兜底 | 相邻地点通勤方式与耗时、全天合计，标记过长路段 |
| `search_attractions` | **高德（需Key，主）** + OSM 兜底 | 国内景点更全更准（名称/类型/距离/地址/评分） |
| `search_restaurants` | **高德（需Key）** | 多因子综合分排序（评分40%+就近30%+价格20%+本地特色10%），支持人均上限与菜系排除 |
| `search_stays` | **高德（需Key，主）** + OSM 兜底 | 真实评分与参考价格；OSM 降级时含电话/官网 |
| `get_place_reviews` | Bing + 百度 + 360 + DuckDuckGo | 抓取网络评价摘要并过滤噪声，做口碑筛选；附带提取「游玩时长参考」；无数据时明确告知 |
| `list_traveler_profiles` / `load_traveler_profile` | 本地 `plans/profiles/` | 读取同行人档案（导入与管理在 Web 页面 👥 完成；需求单勾选后规划自动合并约束） |
| `save_itinerary` / `load_itinerary` / `list_itineraries` | 本地文件 | 结构化行程单（时间/类型/位置/耗时/费用/来源/置信度），保存 JSON + Markdown + 质量报告；支持 `merge=true` 按天分批保存 |
| `validate_itinerary` | 本地规则引擎 | 核验时间线、餐段、时长、空档、赶路、折返、开放时间、预算等（见上） |
| `save_travel_brief` / `load_travel_brief` | 本地文件 | 旅行需求单：目的地/日期/人数/预算/口味一次解析，后续工具参数全部取自需求单 |
| `read_file` / `write_file` / `edit_file` | 本地文件 | 带行号读取（支持分段）、写入、精确替换编辑（唯一命中校验）；限工作区内 |
| `list_files` / `grep` | 本地文件 | 浏览工作区结构（glob 过滤）与正则搜索内容（`文件:行号:` 输出）；只读免确认 |
| `bash` | 本地 shell | 在工作区执行命令；只读命令自动放行，变更类命令逐条确认（支持命令前缀记忆） |

新增工具：实现 `Tool` 接口（name/description/parameters/execute）并注册到 `ToolRegistry` 即可，LLM 端自动可用。

## MCP 接入（ChatGPT / Codex 等客户端）

22 个内置工具全部封装为 stdio MCP Server（零运行时依赖，手写 JSON-RPC）：

```bash
node src/mcp/main.ts
```

- **ChatGPT 桌面版**：开启 Developer mode 后，在 设置 → 连接器 → 高级 里添加本地连接器，命令填
  `node /绝对路径/minicode/src/mcp/main.ts`
- **Codex**：在 `~/.codex/config.toml` 添加：

```toml
[mcp_servers.minicode]
command = "node"
args = ["/绝对路径/minicode/src/mcp/main.ts"]
```

配置说明：与 CLI 共享 `.minicode/config.json`（配置 `amap_api_key` 后地理编码/POI 走高德，未配置自动降级 OSM）；`save_itinerary` 生成的行程单写入项目 `plans/` 目录；文件类工具与 bash 以项目目录为工作区。

## 架构

```text
CLI (src/cli) ─────────────┐
                            ▼
浏览器 ⇄ Web (src/web) → runtime（同会话串行 / 跨会话并发）→ agent（对话+工具循环）
                            │                                     │
                            │                                     ▼
                            │                        llm（DeepSeek / OpenAI 兼容 / Mock）
                            ▼
                     tools（22 个）→ 高德 / 口碑抓取 / OSM 等外部数据源
       支撑：core（会话/消息）· context（压缩）· storage（持久化）· service（审批策略）· config
```

| 模块 | 职责 |
|------|------|
| `core` | 消息与会话数据模型、token 估算与校准、用量统计（零依赖） |
| `llm` | ChatProvider 抽象：OpenAI 兼容实现（流式 + 工具调用）、DeepSeek、Mock |
| `agent` | 对话编排循环（LLM ↔ 工具执行）与分层系统提示词（基础人设 + 旅行模块） |
| `cli` | 终端应用：入口 / 命令路由 / 行队列 / 交互 UI |
| `web` | HTTP 服务 + 单文件前端（聊天、地图、侧边栏、照片浮层）；坐标校准、照片缓存 |
| `runtime` | 多会话运行时与调度：同会话串行合并、跨会话并发；steer / queue 投递 |
| `context` | Context Epoch：超阈值压缩历史为摘要（边界不拆散工具调用组） |
| `storage` / `service` | 会话持久化与归档；审批策略（CLI / Web 共享同一份判断逻辑） |
| `config` | 应用配置与多模型 profiles |
| `mcp` | stdio MCP Server（对外暴露全部工具） |
| `tools` | 22 个工具实现 + 工具注册表（`all.ts`） |
| `eval` | 离线评测：金标准样例 × 真实生成 × 质量指标报告 |

## 行程质量评测（eval）

金标准样例 + 离线评测，用于量化「提示词/工具改动后行程质量是变好还是变差」：

```bash
npm run eval                              # 评测 eval/out 下已有产出（无 API 费用）
npm run eval:live                         # 先用真实模型为样例生成行程，再评测（消耗 API 费用）
npm run eval -- --case quzhou-3d-couple   # 只评测单个样例
npm run eval -- --strict                  # 质量闸门：P0/P1=0、推荐证据率≥80%、全部样例有产出（失败退出码 1）
```

样例定义在 `eval/cases.json`（城市 × 天数 × 预算 × 口味 × 原始需求）；`--live` 的生成产物落在 `eval/out/<样例id>/plans/`，报告写入 `eval/out/report.md`（可读）与 `eval/out/report.json`（机器可读）。

评测指标（在 validate 硬校验之上，专测「推荐是否有依据」）：

- **推荐证据率**：餐厅 note 里同时有评分与人均价格才算有依据
- **候选充足度**：午餐/晚餐时段 ≥4 个候选的达标数
- **多样性**：每时段覆盖的菜系数与价位档数（经济/中档/高档）
- **本地特色覆盖**、**游览密度**、**时间线最大空档**、**路线问题数**、**人均 vs 预算**

## 权限确认

三种审批模式（会话级，Web 头部选择器 / CLI `/approval` 切换）：

| 模式 | 行为 |
|------|------|
| 🔒 逐条确认 (ask) | 文件写入与命令都需批准 |
| ✏️ 自动编辑 (edits，默认) | 工作区内文件写入免确认；命令仍需批准（带命令记忆） |
| ⚡ 信任会话 (trust) | 全部免确认，仅本会话有效（重启/恢复会话后重置） |

命令记忆：bash 变更命令批准时可选「总是允许 `npm test`」——按命令前缀记忆（`npm run build` 记三级、`git commit` 记两级），此后同前缀命令本会话免确认。

```
🔒 权限请求: bash —— 执行命令: npm test
允许执行? (y=本次 / a=总是允许「npm test」 / n=拒绝)
```

- 拒绝后模型会收到"用户未授权"，自动调整方案（不会崩溃或死循环）
- 只读操作全部免确认：文件读取/搜索、bash 的只读命令（ls/cat/git status 等）

审批的**策略**（模式优先级、命令记忆、免确认规则）由 `src/service/permission-policy.ts` 统一实现，CLI 与 Web 共享同一份判断逻辑，只有「怎么问」不同（终端提问 / 页面弹窗）；审批记忆按会话保存，切换会话再回来仍然有效。两端唯一有意的机制差异：CLI 只有前台会话能弹审批（后台请求自动拒绝），Web 支持多会话并发审批。

## 并发运行时与投递模式

```
不同 session → 并发执行，各自 Agent/Session 完全隔离
同一 session → 串行合并执行（排队），历史写入不会交错损坏
```

两种投递模式（本轮执行期间输入内容即 steer）：

| 模式 | 行为 |
|------|------|
| `steer` | 注入当前正在执行的轮次 —— 在工具轮之间被模型看到，实时改变方向；若到达太晚（模型已给最终回复）自动转为下一轮 |
| `/queue <内容>` | 排队到当前会话的下一轮，本轮结束后自动执行 |

执行中提示符变为 `steer>`。

## Context Epoch（上下文纪元）

防止历史随对话变长导致每次请求 token 暴涨：

- 每轮开始前估算历史 token，超过阈值（默认 24000）时把旧消息压缩成 LLM 生成的摘要，只保留最近 8 条
- 压缩边界不会拆散「assistant 工具调用 + tool 结果」组（避免恢复会话时被 API 判为孤儿消息）
- 压缩后开启新纪元（epoch+1，随会话持久化），新前缀保持稳定 → DeepSeek 服务端前缀缓存可命中（命中部分计费大幅下降）
- 用量行显示当前纪元与缓存命中率：`📊 ... 缓存命中 86% | 纪元 0`

## Token 用量与成本

每轮对话后显示累计用量（随会话持久化，`/resume` 后继续累计）：

```
📊 tokens: 输入 3134 / 输出 154 / 共 3288（2 次请求），估算成本 ¥0.0067
```

成本按单价估算，可用 `/config` 调整：

```
/config set price_in 2     # 输入单价（元/百万 tokens）
/config set price_out 3    # 输出单价（元/百万 tokens）
```

## 会话持久化

每轮对话自动保存到 `.minicode/sessions/<会话id>.json`，重启程序后历史不丢失：

```
/sessions        # 列出所有已保存会话（编号 + 标题 + 消息数 + 时间）
/resume 2        # 按序号恢复
/resume 杭州     # 按标题关键词恢复（多个匹配时列出候选）
/new             # 开始新会话
/rename 新标题   # 重命名当前会话（立即持久化）
/delete 2        # 删除会话（二次确认，连带清理归档；不能删当前会话）
```

注意：LLM API（包括 DeepSeek）是无状态的——服务端不保存对话，每次请求由客户端带上完整历史。持久化解决的是「重启不丢上下文」；要完全脱离云端 API，可用 Ollama 本地部署模型，再把 `LLM_BASE_URL` 指向 `http://localhost:11434/v1`。

## 项目结构

```text
minicode/
├── src/
│   ├── cli/          # 终端应用（入口/命令/UI）
│   ├── web/          # HTTP 服务 + 单文件前端 + 坐标校准 + 照片缓存
│   ├── agent/        # 对话编排与系统提示词
│   ├── llm/          # Provider 抽象与实现
│   ├── runtime/      # 多会话运行时与调度
│   ├── core/ context/ storage/ service/ config/ util/
│   ├── tools/        # 22 个工具 + 注册表
│   ├── mcp/          # stdio MCP Server
│   └── eval/         # 离线评测框架
├── test/             # 256 个测试用例（node --test）
├── plans/            # 行程产物（json / md / quality）+ briefs/ 需求单
├── eval/             # 评测样例与报告
└── .minicode/        # 运行时数据（会话/配置/模型/照片缓存；已被 gitignore）
```

## 测试

```bash
npm test           # 全部用例
npm run typecheck  # 类型检查
npm run lint       # oxlint
```
