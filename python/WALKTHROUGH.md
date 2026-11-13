# 逐步验证 Agent Core

这份文档配合 `demo_walkthrough.py` 使用。每一步都给出：

- 观察什么
- 代码走哪条路径
- 对应的 TypeScript 实现
- 一个可以自己改参数做的小实验

## 0. 准备

```bash
cd python
python3 --version        # 3.9+，实测 3.9.6 与 3.14.7
python3 demo_walkthrough.py
```

一次运行会依次执行 8 个场景。下面按输出顺序解释。

---

## 1. 纯对话降级

**观察**

```text
回复: 你好，我是最小 Agent。
历史: ['user', 'assistant']
usage: {'prompt_tokens': 10, ..., 'requests': 1}
```

**路径**

1. `ChatAgent.run` 先 `session.add("user", ...)`
2. 检测到没有注册工具，走 `_plain_chat`
3. Provider 返回文本，写入 assistant 消息
4. 记录 usage

**对应 TS**：`ChatAgent.send` 的无工具路径。

**小实验**：给 `ChatAgent` 传入一个空 `ToolRegistry`，行为不变；
传入有工具的 registry 后，必须提供支持 `chat_with_tools` 的 Provider。

---

## 2. 工具调用往返

**观察**

```text
事件: tool_start write_file
事件: tool_end   write_file
事件: tool_start read_file
事件: tool_end   read_file
历史: user, assistant(tool_calls), tool, assistant(tool_calls), tool, assistant
```

**路径**

1. Provider 返回 `type="tool_calls"`
2. Agent 先写入 `assistant(tool_calls)` 并 checkpoint
3. `ToolRegistry.execute` 解析 JSON、按 schema 校验、执行工具
4. 工具结果先进入 `compact_tool_results`
5. 每个结果以 `tool` 消息回填，且 `tool_call_id` 与调用配对
6. 下一轮 Provider 看到完整协议，返回最终文本

**对应 TS**：`src/agent/agent.ts` 的工具批次执行段。

**关键点**：工具结果不是追加到同一条消息，而是每个调用一条 `tool` 消息；
顺序和 id 必须严格配对，否则真实模型 API 会拒绝请求。

---

## 3. 参数校验与结构化错误

**观察**

```text
{"error": "invalid_tool_arguments",
 "issues": [{"path": "/content", "message": "缺少必填参数 content",
             "hint": "补齐该参数后重试；不要传空对象或省略字段。"}]}
```

模型第二次提交正确参数后成功写入。

**路径**

1. `parse_tool_input` 拒绝非法 JSON / 非对象
2. `validate_schema` 返回带 JSON Pointer 的 issue 列表
3. `ToolValidationError.feedback()` 变成模型可读的 JSON
4. Agent 把它作为 `tool` 消息回传，而不是抛给宿主
5. 相同错误连续出现时注入修正提示，5 次后熔断

**对应 TS**：`src/tools/tool-contract.ts` 的 Ajv 校验与
`ToolValidationError`。

**小实验**：删掉 `write_file` schema 里的 `"required": ["content"]`，
第一次调用就会成功，说明拦截来自 schema 而不是工具实现。

---

## 4. 工具输出预算与 artifact

**观察**

```text
进入上下文的工具消息长度: 254 字符
归档路径: .minicode-py/artifacts/s4/big_output-big.txt
归档原文长度: 9031 字符
```

**路径**

1. 单条预算 3,000 字符，批次预算 8,000 字符
2. 超限原文写入 artifact 文件
3. 上下文只保留：类型头、字符数、artifact 路径、关键行预览
4. 多个并行结果按剩余预算动态分配

**对应 TS**：`src/agent/tool-output.ts`。

**小实验**：把 `TOOL_RESULT_MAX_CHARS` 改成 200，观察预览变短但
artifact 仍是完整原文。

---

## 5. Context Epoch 压缩

**观察**

```text
压缩前历史 token 估算: 13724
压缩事件: 移除 25 条, epoch=1, tokens 14255 -> 710
压缩后请求估算: 1242 tokens
历史首条: 【上下文摘要 | 第 1 纪元】...
```

**路径**

1. 每次请求前 `measure_request_context` 计算完整输入：
   system + history + transient + tool definitions
2. 超过 `max_prompt_tokens` 时调用 `ContextEpochManager.maybe_compact`
3. 压缩边界向前回退，避免把 `tool` 消息和它的 `assistant(tool_calls)` 拆开
4. 旧消息交给摘要器，最近消息保留；历史整体替换，epoch+1
5. 重新计量，仍超限则抛 `ContextInputLimitError`

**对应 TS**：`src/context/request.ts`、`src/context/epoch.ts`。

**小实验**：把 `keep_recent` 调到 20，压缩后保留更多原文，但 token 也更高。

---

## 6. 预算耗尽与熔断

**观察**

```text
-- 6a. 轮次预算耗尽 --
回复: 预算收尾
rounds=2, calls=2, tool 消息数=2
收尾请求注入: 已达到执行预算（工具轮次达到上限 2）...

-- 6b. 相同错误连续 5 次触发熔断 --
回复: 熔断收尾
rounds=5, calls=5
收尾请求注入: 相同工具错误连续出现 5 次，已熔断...
```

**路径**

1. 每轮开始检查 `rounds/calls/tokens` 三个硬计数器
2. 预算耗尽后不再请求工具，改用一次纯文本收尾
3. 相同错误连续 2 次注入修正提示，5 次熔断当前工具循环
4. 未执行的调用也要补一条 `tool` 结果，保持协议完整

**对应 TS**：`src/core/execution-budget.ts`、`agent.ts` 的失败熔断逻辑。

**小实验**：把熔断阈值从 5 改成 3，观察 6b 的 `rounds` 变成 3。

---

## 7. Runtime 调度与 steer

**观察**

```text
7a. 不同会话并发: 两个 0.15s 请求总耗时约 0.15s
7b. 同一会话串行: 两个 0.08s 请求总耗时约 0.16s
7c. steer 返回: ↪ 已注入当前执行轮
    第二次请求里是否包含 steer 消息: True
```

**路径**

1. `AgentRuntime.locks[session_id]` 保证同会话串行
2. 不同 session 使用不同锁，因此可以并发
3. `mode="steer"` 且当前会话有活动轮次时，消息进入 buffer
4. Agent 在每次模型请求前调用 `take_steered_messages` 排干 buffer
5. steer 消息作为新的 user 消息进入下一轮请求

**对应 TS**：`src/runtime/runtime.ts`、`scheduler.ts`。

**小实验**：把 `mode` 改成 `"queue"`，steer 会等待当前轮完全结束，
第二次请求里就不会立即出现该消息。

---

## 8. 持久化与恢复

**观察**

```text
会话文件: .../sessions/persist.json
恢复后 id=persist, 消息数=2, usage={...}
最后一条: assistant: 已经保存
```

**路径**

1. 每个安全边界调用 `checkpoint`：用户消息后、工具批次后、最终回答后
2. `SessionStore.save` 先写 `.tmp`，再 `os.replace` 原子替换
3. `Session.from_data` 恢复消息、工具调用、用量和 epoch

**对应 TS**：`src/storage/session-store.ts`。

**小实验**：在 `SessionStore.save` 里打印 `session.to_data()`，
观察 assistant 的 `tool_calls` 参数也被持久化。

---

## 9. checkpoint 与中断恢复

**观察（9a：提交后崩溃）**

```text
checkpoint 已写入 2 次；磁盘历史角色: ['user', 'assistant']
恢复新增 1 条 tool 回执
  副作用状态: committed
  恢复动作: none
  文件内容: 'once'（没有重复执行）
下一轮模型请求包含 recovery tool 消息: True
```

**观察（9b：提交前中断）**

```text
副作用状态=not_committed, 动作=retry
文件是否被创建: False
```

**观察（9c：用户中断）**

```text
捕获 TurnAbortedError
中断后磁盘历史角色: ['user', 'assistant', 'tool']
是否出现被中断的最终回复: False
```

**检查点边界**

`ChatAgent.run` 只在历史一致的位置调用 checkpoint：

1. 用户消息写入后
2. `assistant(tool_calls)` 写入后（意图已落盘）
3. 一批工具结果全部回填后
4. 最终回答写入后

崩溃发生在 2 和 3 之间时，磁盘上是：

```text
user -> assistant(tool_calls)   # 没有 tool 结果
```

**恢复路径**

1. `recover_interrupted_tool_calls` 扫描 assistant 批次，收集紧随其后的
   `tool_call_id`
2. 找出没有结果的调用，用 `sessionId:messageId:callId` 查操作账本
3. `OperationLedger.reconcile` 比较 before/after 哈希：
   - `current == after_hash` → committed，补回执，不重放
   - `current == before_hash` → not_committed，标记 retry
   - 其他 → unknown，有副作用时 manual_review
4. 补一条 `tool` 消息，让后续模型请求协议完整

**用户 abort**

工具批次会先执行完、结果回填、checkpoint，然后才抛 `TurnAbortedError`。
Runtime 捕获后丢弃残留 steer，主动调用 `on_turn_aborted`。
这样磁盘历史不会停在“半个工具批次”。

**对应 TS**

- `src/agent/tool-recovery.ts`
- `src/storage/managed-operation.ts`
- `src/core/execution-state.ts`
- `src/agent/agent.ts` 的 checkpoint / TurnAbortedError 路径

**小实验**：在 9a 里把 `registry.execute` 换成只调用 `ledger.begin`，
恢复结果会从 committed 变成 not_committed。

## 10. 跑测试

```bash
cd python
python3 -m unittest discover -s tests -v
```

29 个用例覆盖：

- schema 校验与不做类型强转
- 非法 JSON / 缺少必填字段的结构化错误
- 工作区路径逃逸拦截
- 工具往返、权限拒绝、参数修正
- 大输出归档
- Epoch 压缩与工具组边界
- 预算耗尽收尾
- 相同错误熔断
- 同会话串行 / 跨会话并发 / steer
- 持久化恢复
- checkpoint 边界与落盘失败不中断
- abort 保留完整工具批次
- committed / not_committed / unknown 三种恢复回执
- 重复 call id 的批次隔离
