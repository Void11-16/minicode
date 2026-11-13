# Python Agent Core（minicode 教学移植）

从仓库的 TypeScript 实现中剥离旅行规划、Web、MCP、账号、外部数据源与评测，
只保留 Agent 的主机制，并用标准库 Python 重写为可运行、可测试的最小版本。

- 运行时依赖：无（Python 3.9+，实测 3.9.6 与 3.14.7）
- 模型：确定性 `ScriptedProvider`，不访问网络
- 持久化：JSON 文件 + 原子替换
- 调度：`asyncio`，同会话串行、跨会话并发

## 目录

```text
python/
├── agent_core/
│   ├── agent.py          # ChatAgent.run 主循环
│   ├── runtime.py        # 会话调度、并发、steer
│   ├── context.py        # 请求计量、Epoch 压缩
│   ├── output.py         # 工具结果预算与 artifact
│   ├── tools.py          # ToolRegistry、参数校验入口
│   ├── schema.py         # 最小 JSON Schema 校验器（Ajv 的角色）
│   ├── permissions.py    # ask / edits / trust
│   ├── provider.py       # Provider 抽象与 ScriptedProvider
│   ├── session.py        # 历史、用量、token 估算
│   ├── message.py        # Message / ToolCall / Prompt 投影
│   ├── budget.py         # 轮次/调用/token 预算
│   ├── operations.py     # 受控操作账本与副作用状态
│   ├── recovery.py       # 中断后补齐 tool 回执，不重放副作用
│   ├── store.py          # 会话持久化
│   └── builtin_tools.py  # read_file / write_file / list_files / 演示工具
├── tests/test_core.py    # 29 个 unittest 用例
├── demo_walkthrough.py   # 9 个逐步验证场景
└── README.md
```

## 运行

```bash
cd python

# 逐步验证 Agent 行为
python3 demo_walkthrough.py

# 运行所有测试
python3 -m unittest discover -s tests -v
```

逐步解释与实验建议见 [WALKTHROUGH.md](WALKTHROUGH.md)。

## 保留的机制与对应 TS 代码

| 机制 | Python | TypeScript |
|---|---|---|
| Agent 主循环 | `agent.py` | `src/agent/agent.ts` |
| 会话队列/并发/steer | `runtime.py` | `src/runtime/runtime.ts`、`scheduler.ts` |
| 请求计量与 Epoch 压缩 | `context.py` | `src/context/request.ts`、`epoch.ts` |
| 工具输出预算与归档 | `output.py` | `src/agent/tool-output.ts` |
| 工具注册与参数契约 | `tools.py`、`schema.py` | `src/tools/tool.ts`、`tool-contract.ts` |
| 审批策略 | `permissions.py` | `src/service/permission-policy.ts` |
| 消息/会话/用量 | `message.py`、`session.py` | `src/core/message.ts`、`session.ts` |
| 执行预算 | `budget.py` | `src/core/execution-budget.ts` |
| 持久化 | `store.py` | `src/storage/session-store.ts` |
| 操作账本与副作用状态 | `operations.py` | `src/storage/managed-operation.ts`、`core/execution-state.ts` |
| 中断恢复 | `recovery.py` | `src/agent/tool-recovery.ts` |
| Provider 抽象 | `provider.py` | `src/llm/provider.ts`、`mock.ts` |

## 已移除的范围

- 旅行规划：需求单、排程、坐标、路线、质量校验、日期任务
- Web 服务、CLI 交互、MCP Server、账号认证
- OpenAI/DeepSeek/Ollama 真实 Provider 与流式输出
- 工具目录激活（find/activate/deactivate_tools）、缓存、证据仓库
- 完整操作账本（只保留文件写入/命令的最小记录与哈希核对）
- 复杂导出重建、费用估算、自动续期、评测框架

## 有意保留的简化

| 真实实现 | 本移植 |
|---|---|
| LLM 生成摘要 | `simple_summarizer` 确定性规则 |
| OpenAI/DeepSeek Provider | `ScriptedProvider` 顺序脚本 |
| Promise 调度 | `asyncio` + 每会话 `Lock` |
| 完整 JSON Schema / Ajv | 常用关键字子集，不做类型强转 |
| 旅行状态注入 | 只保留 transient system 消息机制 |
| 多轮预算续期 | 预算耗尽后一次收尾调用 |
| 完整操作账本/导出重建 | 只核对单文件哈希与命令未知状态 |

## 9 个验证场景

`demo_walkthrough.py` 会依次打印：

1. 无工具时降级纯对话
2. 工具调用往返：写文件 → 读文件 → 最终回答
3. 非法参数被 schema 拦截，错误结构化回传后模型修正
4. 超长工具输出归档，上下文只保留预览
5. 请求超预算触发 Epoch 压缩，epoch+1
6. 轮次预算耗尽收尾；相同错误 5 次触发熔断
7. Runtime 跨会话并发、同会话串行、steer 注入
8. 会话落盘与恢复
9. checkpoint 边界、提交后崩溃恢复、提交前中断、用户 abort

## checkpoint 与中断恢复

检查点只在“历史一致”的安全边界落盘：

1. 用户消息写入后
2. `assistant(tool_calls)` 写入后（调用意图已持久化）
3. 一批工具结果全部回填后
4. 最终回答写入后

如果进程在 `assistant(tool_calls)` 之后、tool 结果回填之前崩溃，磁盘历史会留下
悬空调用。下一次 `ChatAgent.run` 开始时：

1. `recover_interrupted_tool_calls` 扫描每个 assistant 批次，找出没有对应
   `tool_call_id` 的调用
2. 用 `sessionId:messageId:callId` 查操作账本
3. 通过 before/after 哈希核对主文件：
   - 已提交：补 `effect_status=committed` 回执，不重复执行
   - 未提交：补 `not_committed`，只读/可重试操作标记 `retry`
   - 未知：补 `unknown`，有副作用标记 `manual_review`
4. 补齐的 `tool` 消息让下一轮模型请求满足协议，不会因孤立 tool_call 报错

用户主动 abort 时，当前工具批次会先完成、回填并 checkpoint，然后才抛
`TurnAbortedError`；残留 steer 被丢弃，磁盘历史保持可用状态。

## 面试讲解建议

把这份代码当作“架构索引”，只深入讲三条线：

1. **执行控制**：`ChatAgent.run` 如何推进一轮、如何检查预算、如何收尾
2. **上下文工程**：`measure_request_context` → `ContextEpochManager` → `output.py`
3. **工具可靠性**：`schema.py` → `ToolRegistry` → 结构化错误 → 熔断

旅行业务在原项目中是这些机制的压测场景，不是讲解主线。
