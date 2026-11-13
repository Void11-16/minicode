"""逐步验证 Python Agent Core 的行为。

运行：
    cd python
    python3 demo_walkthrough.py

每一步都只依赖确定性 ScriptedProvider，不访问网络、不调用真实模型。
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import tempfile
import time
from pathlib import Path

from agent_core import (
    ChatAgent,
    ContextEpochManager,
    ExecutionBudget,
    OperationLedger,
    RunOptions,
    ScriptedProvider,
    Session,
    SessionStore,
    Tool,
    ToolContext,
    ToolRegistry,
    TurnAbortedError,
    create_runtime,
    recover_interrupted_tool_calls,
    simple_summarizer,
    text,
    tool_call,
)
from agent_core.builtin_tools import create_default_registry, create_demo_registry


def section(title: str) -> None:
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def show_history(session: Session) -> None:
    for index, message in enumerate(session.history):
        kind = "tool_call" if message.tool_calls else message.role
        preview = " ".join(message.content.split())[:90]
        print(f"  [{index}] {kind:<10} {preview}")


async def step_1_plain_chat(workspace: str) -> None:
    section("步骤 1：无工具时降级为纯对话")
    session = Session(id="s1", workspace=workspace)
    provider = ScriptedProvider([text("你好，我是最小 Agent。")])
    agent = ChatAgent(session, provider)
    reply = await agent.run("你好")
    print(f"回复: {reply}")
    print(f"历史: {[message.role for message in session.history]}")
    print(f"usage: {session.usage.to_data()}")


async def step_2_tool_round_trip(workspace: str) -> None:
    section("步骤 2：工具调用往返（写文件 → 读文件 → 最终回答）")
    session = Session(id="s2", workspace=workspace, approval_mode="trust")
    provider = ScriptedProvider(
        [
            tool_call("write_file", {"path": "notes.txt", "content": "hello agent"}, "c1"),
            tool_call("read_file", {"path": "notes.txt"}, "c2"),
            text("已写入并读回 notes.txt"),
        ]
    )
    agent = ChatAgent(session, provider, create_default_registry(workspace))

    def on_event(event: dict) -> None:
        if event["type"] in ("tool_start", "tool_end", "tool_error"):
            print(f"  事件: {event['type']:<10} {event['name']}")

    reply = await agent.run("写一个文件再读回来", RunOptions(on_event=on_event))
    print(f"回复: {reply}")
    print(f"文件内容: {(Path(workspace) / 'notes.txt').read_text()!r}")
    show_history(session)


async def step_3_schema_validation(workspace: str) -> None:
    section("步骤 3：非法工具参数在执行前被拦截，错误结构化回传")
    session = Session(id="s3", workspace=workspace, approval_mode="trust")
    provider = ScriptedProvider(
        [
            tool_call("write_file", {"path": "validated.txt"}, "bad"),
            tool_call("write_file", {"path": "validated.txt", "content": "fixed"}, "good"),
            text("修正后写入成功"),
        ]
    )
    agent = ChatAgent(session, provider, create_default_registry(workspace))
    reply = await agent.run("写文件")
    first_tool = next(message for message in session.history if message.role == "tool")
    print("第一次工具调用的返回（节选）:")
    print("  " + first_tool.content[:360].replace("\n", "\n  "))
    print(f"最终回复: {reply}")
    print(f"文件内容: {(Path(workspace) / 'validated.txt').read_text()!r}")


async def step_4_output_budget(workspace: str) -> None:
    section("步骤 4：工具输出超过单条预算 → 原文归档 + 关键行预览")
    session = Session(id="s4", workspace=workspace, approval_mode="trust")
    provider = ScriptedProvider(
        [tool_call("big_output", {"chars": 9000}, "big"), text("大输出处理完成")]
    )
    agent = ChatAgent(session, provider, create_demo_registry(workspace))
    reply = await agent.run("返回大文本")

    tool_message = next(message for message in session.history if message.role == "tool")
    match = re.search(r"artifact=([^\n]+)", tool_message.content)
    artifact = Path(workspace) / match.group(1).strip()
    print(f"回复: {reply}")
    print(f"进入上下文的工具消息长度: {len(tool_message.content)} 字符")
    print(f"归档路径: {match.group(1).strip()}")
    print(f"归档原文长度: {len(artifact.read_text(encoding='utf-8'))} 字符")
    print("上下文预览（前 220 字符）:")
    print("  " + tool_message.content[:220].replace("\n", "\n  "))


async def step_5_epoch_compaction(workspace: str) -> None:
    section("步骤 5：请求超过 token 预算 → Context Epoch 压缩")
    session = Session(id="s5", workspace=workspace, approval_mode="trust")
    for index in range(24):
        session.add("user", f"旧消息 {index}: " + "x" * 800)
    for index in range(6):
        session.add("assistant", f"最近消息 {index}")

    provider = ScriptedProvider([text("压缩后继续回答")])
    manager = ContextEpochManager(
        summarize=simple_summarizer,
        max_prompt_tokens=4_000,
        keep_recent=6,
    )
    agent = ChatAgent(
        session,
        provider,
        create_default_registry(workspace),
        compactor=manager,
    )
    events: list[dict] = []
    before_tokens = session.estimate_history_tokens()
    reply = await agent.run("继续", RunOptions(max_prompt_tokens=4_000, on_event=events.append))

    compact = next(event for event in events if event["type"] == "compact")
    request = next(event for event in events if event["type"] == "request")
    print(f"压缩前历史 token 估算: {before_tokens}")
    print(f"压缩事件: 移除 {compact['removed']} 条, epoch={compact['epoch']}, "
          f"tokens {compact['tokens_before']} -> {compact['tokens_after']}")
    print(f"压缩后请求估算: {request['metrics'].estimated_input_tokens} tokens")
    print(f"历史首条: {session.history[0].content.splitlines()[0]}")
    print(f"回复: {reply}")


async def step_6_budget_and_circuit(workspace: str) -> None:
    section("步骤 6：预算耗尽与重复失败熔断")
    print("-- 6a. 轮次预算耗尽 --")
    session = Session(id="s6a", workspace=workspace, approval_mode="trust")
    provider = ScriptedProvider(
        [
            tool_call("list_files", {}, "b1"),
            tool_call("list_files", {}, "b2"),
            text("预算收尾"),
        ]
    )
    agent = ChatAgent(session, provider, create_default_registry(workspace))
    budget = ExecutionBudget(max_rounds=2, max_calls=10)
    reply = await agent.run("列目录", RunOptions(budget=budget))
    print(f"回复: {reply}")
    print(f"rounds={budget.rounds}, calls={budget.calls}, "
          f"tool 消息数={sum(1 for m in session.history if m.role == 'tool')}")
    print(f"收尾请求注入: {provider.requests[-1]['history'][-1]['content'][:120]}")

    print("\n-- 6b. 相同错误连续 5 次触发熔断 --")
    session = Session(id="s6b", workspace=workspace, approval_mode="trust")
    provider = ScriptedProvider(
        [tool_call("fail", {"message": "same"}, f"f{index}") for index in range(5)]
        + [text("熔断收尾")]
    )
    agent = ChatAgent(session, provider, create_demo_registry(workspace))
    budget = ExecutionBudget(max_rounds=10, max_calls=20)
    reply = await agent.run("重复失败", RunOptions(budget=budget))
    print(f"回复: {reply}")
    print(f"rounds={budget.rounds}, calls={budget.calls}")
    print(f"收尾请求注入: {provider.requests[-1]['history'][-1]['content']}")


async def step_7_runtime(workspace: str) -> None:
    section("步骤 7：Runtime 并发、同会话串行与 steer")
    print("-- 7a. 不同会话并发 --")
    runtime = create_runtime(max_prompt_tokens=24_000)
    for name in ("a", "b"):
        session = Session(id=name, workspace=workspace, approval_mode="trust")
        provider = ScriptedProvider([text(f"回复-{name}")], delay=0.15)
        runtime.register_agent(name, ChatAgent(session, provider, create_default_registry(workspace)))
    start = time.monotonic()
    replies = await asyncio.gather(runtime.send("a", "问 A"), runtime.send("b", "问 B"))
    elapsed = time.monotonic() - start
    print(f"回复: {replies}, 耗时={elapsed:.3f}s（两个 0.15s 请求重叠）")

    print("\n-- 7b. 同一会话串行 --")
    session = Session(id="same", workspace=workspace, approval_mode="trust")
    provider = ScriptedProvider([text("第一次"), text("第二次")], delay=0.08)
    runtime.register_agent("same", ChatAgent(session, provider, create_default_registry(workspace)))
    start = time.monotonic()
    replies = await asyncio.gather(runtime.send("same", "一"), runtime.send("same", "二"))
    elapsed = time.monotonic() - start
    print(f"回复: {replies}, 耗时={elapsed:.3f}s（0.08s 请求串行执行）")

    print("\n-- 7c. steer 在下一轮模型请求前注入 --")
    session = Session(id="steer", workspace=workspace, approval_mode="trust")
    provider = ScriptedProvider(
        [tool_call("list_files", {}, "c1"), text("已按转向处理")],
        delay=0.08,
    )
    runtime.register_agent("steer", ChatAgent(session, provider, create_default_registry(workspace)))
    task = asyncio.create_task(runtime.send("steer", "先看看目录"))
    await asyncio.sleep(0.02)
    note = await runtime.send("steer", "改看 notes.txt", mode="steer")
    reply = await task
    second_request = provider.requests[-1]["history"]
    print(f"steer 返回: {note}")
    print(f"最终回复: {reply}")
    print(f"第二次请求里是否包含 steer 消息: "
          f"{any(item.get('content') == '改看 notes.txt' for item in second_request)}")


async def step_8_persistence(workspace: str) -> None:
    section("步骤 8：安全边界持久化与恢复")
    session = Session(id="persist", workspace=workspace, approval_mode="trust")
    provider = ScriptedProvider([text("已经保存")])
    agent = ChatAgent(session, provider, create_default_registry(workspace))
    await agent.run("你好", RunOptions())
    store = SessionStore(workspace)
    path = store.save(session)
    loaded = store.load("persist")
    print(f"会话文件: {path}")
    print(f"文件大小: {path.stat().st_size} bytes")
    print(f"恢复后 id={loaded.id}, 消息数={len(loaded.history)}, "
          f"usage={loaded.usage.to_data()}")
    print(f"最后一条: {loaded.history[-1].role}: {loaded.history[-1].content}")


async def step_9_recovery(workspace: str) -> None:
    section("步骤 9：checkpoint 与任务中断恢复")

    print("-- 9a. 提交后崩溃：补齐回执，不重复执行 --")
    ledger = OperationLedger(workspace)
    registry = create_default_registry(workspace, ledger=ledger)
    session = Session(id="s9a", workspace=workspace, approval_mode="trust")
    store = SessionStore(workspace)
    session.add("user", "写 recover.txt")
    store.save(session)  # checkpoint 1: 用户消息后

    args = json.dumps({"path": "recover.txt", "content": "once"})
    batch = session.add(
        "assistant",
        "",
        tool_calls=[tool_call("write_file", json.loads(args), "c1").tool_calls[0]],
    )
    store.save(session)  # checkpoint 2: assistant(tool_calls) 已落盘
    operation_id = f"{session.id}:{batch.id}:c1"
    await registry.execute(
        "write_file",
        args,
        ToolContext(workspace, session.id, operation_id=operation_id),
    )
    print("模拟崩溃：tool 结果尚未回填，会话文件停在 assistant(tool_calls)")
    print(f"checkpoint 已写入 2 次；磁盘历史角色: "
          f"{[message.role for message in store.load('s9a').history]}")

    loaded = store.load("s9a")
    added = await recover_interrupted_tool_calls(loaded, registry, ledger)
    receipt = json.loads(loaded.history[-1].content)
    print(f"恢复新增 {added} 条 tool 回执")
    print(f"  副作用状态: {receipt['execution_state']['effect_status']}")
    print(f"  恢复动作: {receipt['execution_state']['recovery_action']}")
    print(f"  文件内容: {(Path(workspace) / 'recover.txt').read_text()!r}（没有重复执行）")

    provider = ScriptedProvider([text("已看到恢复回执，继续处理")])
    agent = ChatAgent(loaded, provider, registry)
    reply = await agent.run("继续")
    last_request = provider.requests[-1]["history"]
    has_recovery = any(
        '"recovered": true' in str(item.get("content"))
        for item in last_request
    )
    print(f"下一轮模型请求包含 recovery tool 消息: {has_recovery}")
    print(f"回复: {reply}")

    print("\n-- 9b. 提交前中断：核对为未提交，允许重试 --")
    session2 = Session(id="s9b", workspace=workspace)
    session2.add("user", "写 pending.txt")
    batch2 = session2.add(
        "assistant",
        "",
        tool_calls=[tool_call("write_file", {"path": "pending.txt", "content": "x"}, "c1").tool_calls[0]],
    )
    operation_id2 = f"{session2.id}:{batch2.id}:c1"
    ledger.begin(
        operation_id2,
        "write_file",
        str(Path(workspace) / "pending.txt"),
        kind="replace",
    )
    added2 = await recover_interrupted_tool_calls(session2, None, ledger)
    receipt2 = json.loads(session2.history[-1].content)
    print(f"恢复新增 {added2} 条；副作用状态={receipt2['execution_state']['effect_status']}, "
          f"动作={receipt2['execution_state']['recovery_action']}")
    print(f"文件是否被创建: {(Path(workspace) / 'pending.txt').exists()}")

    print("\n-- 9c. 用户中断：完成当前批次后抛 TurnAbortedError --")
    session3 = Session(id="s9c", workspace=workspace, approval_mode="trust")
    registry3 = ToolRegistry()
    holder: dict[str, ChatAgent] = {}

    def slow(args: dict, context: ToolContext) -> str:
        holder["agent"].abort()
        return "工具已执行"

    registry3.register(
        Tool(
            name="slow_tool",
            description="执行中触发中断",
            parameters={"type": "object", "properties": {}},
            execute=slow,
        )
    )
    provider3 = ScriptedProvider(
        [tool_call("slow_tool", {}, "c1"), text("不应到达")]
    )
    agent3 = ChatAgent(session3, provider3, registry3)
    holder["agent"] = agent3

    def checkpoint() -> None:
        store.save(session3)

    try:
        await agent3.run("测试中断", RunOptions(on_checkpoint=checkpoint))
    except TurnAbortedError:
        print("捕获 TurnAbortedError")
    persisted = store.load("s9c")
    print(f"中断后磁盘历史角色: {[message.role for message in persisted.history]}")
    print(f"是否出现被中断的最终回复: "
          f"{any(message.content == '不应到达' for message in persisted.history)}")


async def main() -> None:
    workspace = tempfile.mkdtemp(prefix="agent-core-demo-")
    print(f"临时工作区: {workspace}")
    print(
        "调用链: user -> Session.add -> Runtime(queue/steer) -> ChatAgent.run\n"
        "        -> 上下文计量 -> Epoch 压缩 -> Provider -> ToolRegistry(schema)\n"
        "        -> 工具执行 -> 结果预算/归档 -> tool 消息 -> 下一轮 -> 最终回答 -> checkpoint"
    )
    try:
        await step_1_plain_chat(workspace)
        await step_2_tool_round_trip(workspace)
        await step_3_schema_validation(workspace)
        await step_4_output_budget(workspace)
        await step_5_epoch_compaction(workspace)
        await step_6_budget_and_circuit(workspace)
        await step_7_runtime(workspace)
        await step_8_persistence(workspace)
        await step_9_recovery(workspace)
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
