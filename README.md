# minicode

一个 opencode 风格的最小 AI 助手实现 —— CLI + Web 双端。**旅行规划是内置的可开关能力**（Web 右上角勾选「🗺️ 旅行规划」开启），而不是唯一定位；天气查询、地点搜索、路线规划、文档读写等工具在通用模式下同样可用。

## 运行

```powershell
cd minicode
npm run chat
npm run chat -- --debug    # 调试日志写入 .minicode/debug.log
npm run web                # 浏览器版：http://localhost:3000（通用 AI 助手，右上角可开启 🗺️ 旅行规划模式）

多模型支持（CLI 与 Web 共享 `.minicode/models.json`）：
- **Web**：⚙️ 里配置多个 API（DeepSeek / OpenAI 兼容 / Mock），顶栏下拉为当前会话选择
- **CLI**：`/models` 查看列表，`/model <序号|名称关键词>` 切换当前会话的模型；
  `/model add` 交互式添加、`/model edit <序号>` 编辑（回车保留旧值）、
  `/model del <序号>` 删除（二次确认）、`/model default <序号>` 设为默认
- 不同会话可以用不同模型，选择随会话持久化（/resume 后保持）
- `/travel on|off` 开关旅行规划能力（off = 通用助手，CLI 默认开启）
npm test && npm run typecheck && npm run lint
```

默认使用 Mock Provider（无需 API Key）。接入真实模型：

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."                    # DeepSeek（优先级最高）
$env:DEEPSEEK_MODEL   = "deepseek-chat"             # 或 deepseek-reasoner
$env:LLM_API_KEY      = "sk-..."                    # 其他 OpenAI 兼容服务
$env:LLM_BASE_URL     = "https://api.openai.com/v1"
$env:LLM_MODEL        = "gpt-4o-mini"
npm run chat
```

### 推荐方式：配置一次，永久生效（无需环境变量）

启动后在对话里直接设置，保存到 `.minicode/config.json`，下次启动自动读取：

```
/config set amap_api_key <你的Key>   # 可选：高德「Web服务」Key（免费），国内定位/POI 质量大幅提升
/config set taste_preferences 不吃辣、人均100以内、想尝试本地特色   # 可选：口味偏好，餐饮推荐参考
```

配置高德后 geocode / search_attractions / search_stays 优先走高德（国内门牌级定位、POI 评分价格），失败或海外地点自动降级 OSM。

```
/config set deepseek_api_key sk-...          # 配置一次，之后每次打开直接可用
/config set deepseek_model deepseek-reasoner # 可选：切换推理模型
/config                                      # 查看当前配置（Key 自动打码）
/config clear deepseek_api_key               # 清除
```

也可接其他服务（OpenAI / vLLM / Ollama 等）：

```
/config set llm_api_key sk-...
/config set llm_base_url http://localhost:11434/v1   # 本地 Ollama 示例
/config set llm_model gpt-4o-mini
```

## 支持的服务

| 服务 | 环境变量 | 说明 |
|------|----------|------|
| DeepSeek | `DEEPSEEK_API_KEY`（或 `DS_API_KEY`） | 默认 `deepseek-chat`，`DEEPSEEK_MODEL` 可切 `deepseek-reasoner` |
| OpenAI 兼容 | `LLM_API_KEY`（或 `OPENAI_API_KEY`） | 通过 `LLM_BASE_URL` 接任意兼容服务（OpenAI / vLLM / Ollama 等） |
| Mock | 无 Key 时自动启用 | 无网络、无成本，用于开发测试 |

```powershell
$env:LLM_API_KEY = "sk-..."
$env:LLM_BASE_URL = "https://api.openai.com/v1"   # 任意 OpenAI 兼容服务
$env:LLM_MODEL = "gpt-4o-mini"
npm run chat
```

## MCP 接入（ChatGPT / Codex 等客户端）

18 个旅行工具已封装为 stdio MCP Server（零运行时依赖，手写 JSON-RPC）：

```bash
node src/mcp/main.ts
```

接入方式：

- **ChatGPT 桌面版**：开启 Developer mode 后，在 设置 → 连接器 → 高级 里添加本地连接器，命令填
  `node /绝对路径/minicode/src/mcp/main.ts`
- **Codex**：在 `~/.codex/config.toml` 添加：

```toml
[mcp_servers.minicode]
command = "node"
args = ["/绝对路径/minicode/src/mcp/main.ts"]
```

配置说明：与 CLI 共享 `.minicode/config.json`（配置 `amap_api_key` 后地理编码/POI 走高德，未配置自动降级 OSM）；
`write_document` 生成的行程单固定写入项目 `plans/` 目录。

## 架构

```text
cli -> agent -> llm(provider)
 |       |                |
 +-------+-> core(session/message)
```

| 模块 | 职责 |
|------|------|
| `core` | 消息与会话的纯数据模型，零依赖 |
| `llm` | ChatProvider 接口 + Mock / OpenAI 兼容实现 |
| `agent` | 对话编排循环（未来扩展工具调用） |
| `cli` | 终端 REPL 交互 |
| `runtime` | 多会话并发调度 + steer/queue 投递 |
| `context` | Context Epoch 上下文压缩管理 |

CLI 内部分层：`chat.ts`(入口) → `app.ts`(装配+主循环) → `commands.ts`(命令路由) + `ui.ts`(展示)。可 `npm link` 后全局使用 `minicode` 命令。

## 工具系统（旅行规划场景）

Agent 会自动决定何时调用工具，调用过程以 `⚡ 工具名(参数)` 实时显示：

| 工具 | 数据源 | 说明 |
|------|--------|------|
| `get_weather` | Open-Meteo（免费） | 未来 1-7 天天气预报 |
| `geocode` | **高德（需Key，主）** + Photon + Open-Meteo 兜底 | 地名 → 坐标；国内地址精度最好，规避 OSM 同名歧义 |
| `reverse_geocode` | Photon | 坐标 → 地名 |
| `calculate_distance` | 本地计算 | 两点直线距离 |
| `get_route` | OSRM（免费） | 驾车/步行/骑行路线距离与耗时 |
| `plan_day_routes` | **高德公交（需Key）** + OSRM 驾车兜底 | 相邻地点通勤方式与耗时、全天合计，标记过长路段 |
| `search_stays` | **高德（需Key，主）** + OSM 兜底 | 真实评分与参考价格；OSM 降级时含电话/官网 |
| `search_restaurants` | **高德（需Key）** | 多因子综合分排序（评分40%+就近30%+价格20%+本地特色10%），支持人均上限与菜系排除 |
| `read_document` | 本地文件 | 解析行程单/攻略（txt/md/csv/json） |
| `write_document` | 本地文件 | 导出 Markdown 行程单（限当前目录内，防注入） |
| `save_itinerary` / `load_itinerary` / `list_itineraries` | 本地文件 | 结构化行程单（时间/类型/位置/耗时/费用/来源/置信度），保存 JSON+Markdown+质量报告，支持增量修改 |
| `validate_itinerary` | 本地规则引擎 | 核验时间冲突、餐段、过长交通、当日时长、重复地点、开放时间、闭馆日、预算与数据缺口 |
| `save_travel_brief` / `load_travel_brief` | 本地文件 | 旅行需求单：目的地/日期/人数/预算/口味一次解析，后续工具参数全部取自需求单 |
| `search_attractions` | **高德（需Key，主）** + OSM 兜底 | 国内景点更全更准（名称/类型/距离/地址） |
| `get_place_reviews` | Bing + DuckDuckGo | 抓取景点网络评价摘要，做口碑筛选 |

新增工具：实现 `Tool` 接口（name/description/parameters/execute）并注册到 `ToolRegistry` 即可，LLM 端自动可用。

## 行程质量核验

`save_itinerary` 保存前会执行基础核验：P0（时间倒序/重叠等硬错误）拒绝保存；P1/P2 写入
`<行程名>.quality.md` 供模型和用户查看。`strict: true` 时 P0/P1 都会拒绝。

生成或修改行程后应调用：

```text
validate_itinerary({ title: "杭州两日游", strict: true, budget_per_person_yuan: 2000 })
```

核验包括：

- 时间顺序、重叠、缺少时间
- 午餐/晚餐是否安排、是否落在常规餐段
- 单段交通是否超过 60 分钟
- 全天活动是否超过 10 小时
- 当天是否重复安排同一地点/餐厅
- 条目开始时间是否在开放时间内、日期是否命中闭馆/闭店日
- 人均预算是否超标
- 位置、来源、置信度、耗时等数据是否缺失

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

## 权限确认

有副作用的工具（写文件/读本地文件）执行前会请求确认：

```
🔒 权限请求: write_document —— 写入文件 plans/hangzhou.md
允许执行? (y=本次 / a=本次会话总是 / n=拒绝)
```

- 拒绝后模型会收到"用户未授权"，自动调整方案（不会崩溃或死循环）
- 网络类工具（天气/搜索等只读操作）默认放行

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
- 压缩后开启新纪元（epoch+1，随会话持久化），新前缀保持稳定 → DeepSeek 服务端前缀缓存可命中（命中部分计费大幅下降）
- 用量行显示当前纪元与缓存命中率：`📊 ... 缓存命中 86% | 纪元 0`

## 测试

```powershell
npm test
```

## 会话持久化

每轮对话自动保存到 `.minicode/sessions/<会话id>.json`，重启程序后历史不丢失：

```
/sessions        # 列出所有已保存会话（编号 + 标题 + 消息数 + 时间）
/resume 2        # 按序号恢复
/resume 杭州     # 按标题关键词恢复（多个匹配时列出候选）
/resume <会话id> # 兼容旧方式
/new             # 开始新会话
/rename 新标题   # 重命名当前会话（立即持久化）
/delete 2        # 删除会话（二次确认，连带清理归档；不能删当前会话）
```

注意：LLM API（包括 DeepSeek）是无状态的——服务端不保存对话，每次请求由客户端带上完整历史。持久化解决的是「重启不丢上下文」；要完全脱离 API，可用 Ollama 本地部署模型，再把 `LLM_BASE_URL` 指向 `http://localhost:11434/v1`。
