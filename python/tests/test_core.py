from __future__ import annotations

import asyncio
import json
import re
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent_core import (
    ChatAgent,
    ContextEpochManager,
    ExecutionBudget,
    LLMResult,
    Message,
    OperationLedger,
    PermissionPolicy,
    RunOptions,
    ScriptedProvider,
    Session,
    SessionStore,
    Tool,
    ToolCall,
    ToolValidationError,
    TurnAbortedError,
    recover_interrupted_tool_calls,
    compact_tool_results,
    create_runtime,
    estimate_history_tokens,
    measure_request_context,
    simple_summarizer,
    text,
    tool_call,
)
from agent_core.builtin_tools import create_default_registry, create_demo_registry
from agent_core.output import ToolResult
from agent_core.schema import validate_schema
from agent_core.tools import ToolContext, ToolRegistry, parse_tool_input


class WorkspaceCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.workspace = tempfile.mkdtemp(prefix="agent-core-test-")
        self.addCleanup(shutil.rmtree, self.workspace, True)


class SchemaTests(unittest.TestCase):
    def test_missing_required_and_wrong_type(self) -> None:
        schema = {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "count": {"type": "integer"},
            },
            "required": ["path", "count"],
            "additionalProperties": False,
        }
        issues = validate_schema(schema, {"count": "x", "extra": 1})
        paths = {issue.path for issue in issues}
        self.assertIn("/path", paths)
        self.assertIn("/count", paths)
        self.assertIn("/extra", paths)

    def test_no_coercion(self) -> None:
        issues = validate_schema({"type": "integer"}, "1")
        self.assertEqual(len(issues), 1)
        self.assertIn("integer", issues[0].message)


class RegistryTests(WorkspaceCase):
    async def test_invalid_json_and_schema_are_structured_errors(self) -> None:
        registry = create_default_registry(self.workspace)
        ctx = ToolContext(self.workspace, "s1")
        with self.assertRaises(ToolValidationError) as invalid_json:
            await registry.execute("write_file", "{not json", ctx)
        self.assertIn("invalid_tool_arguments", invalid_json.exception.feedback())

        with self.assertRaises(ToolValidationError) as missing:
            await registry.execute("write_file", '{"path":"a.txt"}', ctx)
        feedback = json.loads(missing.exception.feedback())
        self.assertEqual(feedback["error"], "invalid_tool_arguments")
        self.assertEqual(feedback["issues"][0]["path"], "/content")

    async def test_workspace_sandbox(self) -> None:
        registry = create_default_registry(self.workspace)
        ctx = ToolContext(self.workspace, "s1")
        with self.assertRaises(ValueError):
            await registry.execute("read_file", '{"path":"../outside.txt"}', ctx)


class AgentLoopTests(WorkspaceCase):
    def session(self, *, mode: str = "trust") -> Session:
        return Session(id="s1", workspace=self.workspace, approval_mode=mode)

    def test_parse_tool_input(self) -> None:
        self.assertEqual(parse_tool_input(""), {})
        with self.assertRaises(ToolValidationError):
            parse_tool_input("[]")

    async def test_tool_round_trip(self) -> None:
        session = self.session()
        provider = ScriptedProvider(
            [
                tool_call("write_file", {"path": "notes.txt", "content": "hello agent"}, "c1"),
                tool_call("read_file", {"path": "notes.txt"}, "c2"),
                text("已写入并读回 notes.txt"),
            ]
        )
        agent = ChatAgent(session, provider, create_default_registry(self.workspace))
        events: list[dict] = []
        reply = await agent.run("写一个文件再读回来", RunOptions(on_event=events.append))

        self.assertEqual(reply, "已写入并读回 notes.txt")
        self.assertEqual((Path(self.workspace) / "notes.txt").read_text(), "hello agent")
        roles = [message.role for message in session.history]
        self.assertEqual(roles, ["user", "assistant", "tool", "assistant", "tool", "assistant"])
        self.assertTrue(any(event["type"] == "tool_start" for event in events))
        self.assertTrue(any(event["type"] == "tool_end" for event in events))

    async def test_schema_error_is_returned_to_model_then_corrected(self) -> None:
        session = self.session()
        provider = ScriptedProvider(
            [
                tool_call("write_file", {"path": "x.txt"}, "bad"),
                tool_call("write_file", {"path": "x.txt", "content": "fixed"}, "good"),
                text("修正后写入成功"),
            ]
        )
        agent = ChatAgent(session, provider, create_default_registry(self.workspace))
        reply = await agent.run("写文件", RunOptions())

        self.assertEqual(reply, "修正后写入成功")
        tool_messages = [message for message in session.history if message.role == "tool"]
        self.assertIn("invalid_tool_arguments", tool_messages[0].content)
        self.assertIn("/content", tool_messages[0].content)
        self.assertEqual((Path(self.workspace) / "x.txt").read_text(), "fixed")

    async def test_permission_denied_becomes_tool_message(self) -> None:
        session = self.session(mode="ask")
        provider = ScriptedProvider(
            [
                tool_call("write_file", {"path": "blocked.txt", "content": "x"}, "c1"),
                text("已停止写入"),
            ]
        )
        agent = ChatAgent(session, provider, create_default_registry(self.workspace))
        reply = await agent.run(
            "写文件",
            RunOptions(on_permission=lambda request: False),
        )
        self.assertEqual(reply, "已停止写入")
        self.assertFalse((Path(self.workspace) / "blocked.txt").exists())
        self.assertIn("拒绝", session.history[2].content)

    async def test_tool_output_is_archived_and_previewed(self) -> None:
        session = self.session()
        provider = ScriptedProvider(
            [
                tool_call("big_output", {"chars": 9000}, "big"),
                text("完成"),
            ]
        )
        registry = create_demo_registry(self.workspace)
        agent = ChatAgent(session, provider, registry)
        await agent.run("输出大文本", RunOptions())

        tool_message = next(message for message in session.history if message.role == "tool")
        self.assertIn("truncated=true", tool_message.content)
        self.assertLess(len(tool_message.content), 3000)
        match = re.search(r"artifact=([^\n]+)", tool_message.content)
        self.assertIsNotNone(match)
        artifact = Path(self.workspace) / match.group(1).strip()
        self.assertTrue(artifact.exists())
        self.assertGreaterEqual(len(artifact.read_text(encoding="utf-8")), 9000)

    async def test_budget_exhaustion_finalizes_without_tools(self) -> None:
        session = self.session()
        provider = ScriptedProvider(
            [
                tool_call("list_files", {}, "c1"),
                tool_call("list_files", {}, "c2"),
                text("预算收尾"),
            ]
        )
        agent = ChatAgent(session, provider, create_default_registry(self.workspace))
        budget = ExecutionBudget(max_rounds=2, max_calls=10)
        reply = await agent.run("列目录", RunOptions(budget=budget))

        self.assertEqual(reply, "预算收尾")
        self.assertEqual(budget.rounds, 2)
        self.assertEqual(sum(1 for message in session.history if message.role == "tool"), 2)
        last_request = provider.requests[-1]["history"]
        self.assertIn("执行预算", last_request[-1]["content"])

    async def test_repeated_failure_opens_circuit(self) -> None:
        session = self.session()
        provider = ScriptedProvider(
            [
                tool_call("fail", {"message": "same"}, f"c{index}")
                for index in range(5)
            ]
            + [text("熔断收尾")]
        )
        agent = ChatAgent(session, provider, create_demo_registry(self.workspace))
        budget = ExecutionBudget(max_rounds=10, max_calls=20)
        reply = await agent.run("重复失败", RunOptions(budget=budget))

        self.assertEqual(reply, "熔断收尾")
        self.assertEqual(budget.rounds, 5)
        self.assertIn("熔断", provider.requests[-1]["history"][-1]["content"])


class ContextTests(WorkspaceCase):

    def test_measure_request_context(self) -> None:
        history = [{"role": "user", "content": "x" * 100}]
        tools = [{"name": "read_file", "description": "read", "parameters": {"type": "object"}}]
        metrics = measure_request_context("sys", history, [{"role": "system", "content": "hint"}], tools)
        self.assertGreater(metrics.estimated_input_tokens, 0)
        self.assertEqual(metrics.input_limit, 24_000)

    async def test_epoch_compaction(self) -> None:
        session = Session(id="s1", workspace=self.workspace)
        for index in range(24):
            session.add("user", f"old-{index}-" + "x" * 800)
        for index in range(6):
            session.add("assistant", f"recent-{index}")

        manager = ContextEpochManager(summarize=simple_summarizer, max_prompt_tokens=4_000, keep_recent=6)
        before = session.estimate_history_tokens()
        info = await manager.maybe_compact(session, request_tokens=20_000)

        self.assertIsNotNone(info)
        self.assertEqual(session.epoch, 1)
        self.assertIn("上下文摘要", session.history[0].content)
        self.assertLess(len(session.history), 30)
        self.assertLess(estimate_history_tokens(session.history), before)

    async def test_compaction_does_not_split_tool_group(self) -> None:
        session = Session(id="s1", workspace=self.workspace)
        for index in range(5):
            session.add("user", f"old-{index}-" + "x" * 600)
        session.add(
            "assistant",
            "",
            tool_calls=[tool_call("read_file", {}).tool_calls[0]],
        )
        session.add("tool", "tool result", tool_call_id="call_1", tool_name="read_file")
        for index in range(3):
            session.add("assistant", f"tail-{index}")

        manager = ContextEpochManager(summarize=simple_summarizer, max_prompt_tokens=100, keep_recent=4)
        await manager.maybe_compact(session, request_tokens=50_000)

        first_kept = session.history[1]
        self.assertEqual(first_kept.role, "assistant")
        self.assertEqual(session.history[2].role, "tool")
        self.assertEqual(session.history[2].tool_call_id, "call_1")

    async def test_agent_auto_compacts_before_request(self) -> None:
        session = Session(id="s1", workspace=self.workspace, approval_mode="trust")
        for index in range(24):
            session.add("user", f"old-{index}-" + "x" * 800)
        for index in range(6):
            session.add("assistant", f"recent-{index}")

        provider = ScriptedProvider([text("压缩后继续")])
        manager = ContextEpochManager(summarize=simple_summarizer, max_prompt_tokens=4_000, keep_recent=6)
        agent = ChatAgent(session, provider, create_default_registry(self.workspace), compactor=manager)
        reply = await agent.run("继续", RunOptions(max_prompt_tokens=4_000))

        self.assertEqual(reply, "压缩后继续")
        self.assertEqual(session.epoch, 1)
        self.assertIn("上下文摘要", session.history[0].content)


class OutputTests(WorkspaceCase):
    async def test_batch_budget_is_shared(self) -> None:
        results = [
            ToolResult(call_id=f"c{index}", tool_name="big_output", output="x" * 5_000)
            for index in range(3)
        ]
        compacted = await compact_tool_results(results, workspace=self.workspace, session_id="s1")
        self.assertEqual(len(compacted), 3)
        total = sum(len(item.text) for item in compacted)
        self.assertLessEqual(total, 8_000)
        self.assertTrue(all(item.truncated for item in compacted))


class PersistenceTests(WorkspaceCase):
    async def test_save_and_load_round_trip(self) -> None:
        session = Session(id="persist", workspace=self.workspace)
        provider = ScriptedProvider([text("第一次回复")])
        agent = ChatAgent(session, provider, create_default_registry(self.workspace))
        await agent.run("你好", RunOptions())

        store = SessionStore(self.workspace)
        path = store.save(session)
        self.assertTrue(path.exists())
        loaded = store.load("persist")

        self.assertEqual(loaded.id, session.id)
        self.assertEqual(len(loaded.history), len(session.history))
        self.assertEqual(loaded.history[-1].content, "第一次回复")
        self.assertEqual(loaded.usage.total_tokens, session.usage.total_tokens)


class RuntimeTests(WorkspaceCase):
    async def test_same_session_serializes(self) -> None:
        runtime = create_runtime(max_prompt_tokens=24_000)
        session = Session(id="same", workspace=self.workspace, approval_mode="trust")
        provider = ScriptedProvider([text("一"), text("二")], delay=0.1)
        runtime.register_agent("same", ChatAgent(session, provider, create_default_registry(self.workspace)))

        start = time.monotonic()
        replies = await asyncio.gather(
            runtime.send("same", "第一个"),
            runtime.send("same", "第二个"),
        )
        elapsed = time.monotonic() - start

        self.assertEqual(replies, ["一", "二"])
        self.assertGreaterEqual(elapsed, 0.18)

    async def test_different_sessions_run_concurrently(self) -> None:
        runtime = create_runtime(max_prompt_tokens=24_000)
        for name in ("a", "b"):
            session = Session(id=name, workspace=self.workspace, approval_mode="trust")
            provider = ScriptedProvider([text(f"回复-{name}")], delay=0.15)
            runtime.register_agent(name, ChatAgent(session, provider, create_default_registry(self.workspace)))

        start = time.monotonic()
        replies = await asyncio.gather(
            runtime.send("a", "问 A"),
            runtime.send("b", "问 B"),
        )
        elapsed = time.monotonic() - start

        self.assertEqual(replies, ["回复-a", "回复-b"])
        self.assertLess(elapsed, 0.28)

    async def test_steer_is_injected_before_next_request(self) -> None:
        runtime = create_runtime(max_prompt_tokens=24_000)
        session = Session(id="steer", workspace=self.workspace, approval_mode="trust")
        provider = ScriptedProvider(
            [tool_call("list_files", {}, "c1"), text("已按转向处理")],
            delay=0.08,
        )
        runtime.register_agent("steer", ChatAgent(session, provider, create_default_registry(self.workspace)))

        task = asyncio.create_task(runtime.send("steer", "先看看目录"))
        await asyncio.sleep(0.02)
        note = await runtime.send("steer", "改看 notes.txt", mode="steer")
        reply = await task

        self.assertEqual(note, "↪ 已注入当前执行轮")
        self.assertEqual(reply, "已按转向处理")
        second_request = provider.requests[-1]["history"]
        self.assertTrue(any(item.get("content") == "改看 notes.txt" for item in second_request))


if __name__ == "__main__":
    unittest.main()


class RecoveryTests(WorkspaceCase):
    def _arguments(self, path: str, content: str) -> str:
        return json.dumps({"path": path, "content": content})

    def _append_tool(self, registry: ToolRegistry, counter: dict[str, int]) -> None:
        def execute(args, context):
            counter["n"] += 1
            path = Path(self.workspace) / str(args["path"])
            path.write_text("x" * counter["n"], encoding="utf-8")
            return f"写入第 {counter['n']} 次"

        registry.register(
            Tool(
                name="append_once",
                description="每次执行都会追加计数的写工具",
                parameters={
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                    "additionalProperties": False,
                },
                execute=execute,
                effect="managed_write",
                workspace_edit=True,
            )
        )

    async def test_checkpoint_at_safe_boundaries(self) -> None:
        session = Session(id="cp", workspace=self.workspace, approval_mode="trust")
        store = SessionStore(self.workspace)
        checkpoints: list[int] = []

        def checkpoint() -> None:
            checkpoints.append(len(session.history))
            store.save(session)

        provider = ScriptedProvider(
            [
                tool_call("write_file", {"path": "cp.txt", "content": "ok"}, "c1"),
                text("完成"),
            ]
        )
        agent = ChatAgent(session, provider, create_default_registry(self.workspace))
        reply = await agent.run("写文件", RunOptions(on_checkpoint=checkpoint))

        self.assertEqual(reply, "完成")
        self.assertEqual(len(checkpoints), 4)
        loaded = store.load("cp")
        self.assertEqual([message.role for message in loaded.history], ["user", "assistant", "tool", "assistant"])

    async def test_checkpoint_failure_does_not_interrupt(self) -> None:
        session = Session(id="cp-fail", workspace=self.workspace, approval_mode="trust")
        provider = ScriptedProvider([text("仍然完成")])
        agent = ChatAgent(session, provider, create_default_registry(self.workspace))

        def broken_checkpoint() -> None:
            raise OSError("disk full")

        reply = await agent.run("你好", RunOptions(on_checkpoint=broken_checkpoint))
        self.assertEqual(reply, "仍然完成")

    async def test_abort_during_tool_keeps_completed_batch(self) -> None:
        session = Session(id="abort", workspace=self.workspace, approval_mode="trust")
        provider = ScriptedProvider(
            [tool_call("slow_tool", {}, "c1"), text("不应到达")]
        )
        registry = ToolRegistry()
        holder: dict[str, ChatAgent] = {}

        def slow(args, context):
            holder["agent"].abort()
            return "工具已执行"

        registry.register(
            Tool(
                name="slow_tool",
                description="执行中触发中断",
                parameters={"type": "object", "properties": {}},
                execute=slow,
            )
        )
        agent = ChatAgent(session, provider, registry)
        holder["agent"] = agent

        with self.assertRaises(TurnAbortedError):
            await agent.run("测试中断")

        self.assertEqual(
            [message.role for message in session.history],
            ["user", "assistant", "tool"],
        )
        self.assertFalse(any(message.content == "不应到达" for message in session.history))

    async def test_runtime_abort_persists_batch_and_discards_steer(self) -> None:
        store = SessionStore(self.workspace)
        runtime = create_runtime(max_prompt_tokens=24_000, store=store)
        aborted: list[str] = []
        runtime.on_turn_aborted = aborted.append
        session = Session(id="runtime-abort", workspace=self.workspace, approval_mode="trust")
        registry = ToolRegistry()

        def slow(args, context):
            runtime.abort_active_turn("runtime-abort")
            return "工具已执行"

        registry.register(
            Tool(
                name="slow_tool",
                description="执行中触发中断",
                parameters={"type": "object", "properties": {}},
                execute=slow,
            )
        )
        provider = ScriptedProvider([tool_call("slow_tool", {}, "c1"), text("不应到达")])
        runtime.register_agent("runtime-abort", ChatAgent(session, provider, registry))

        with self.assertRaises(TurnAbortedError):
            await runtime.send("runtime-abort", "测试中断")

        self.assertEqual(aborted, ["runtime-abort"])
        loaded = store.load("runtime-abort")
        self.assertEqual(
            [message.role for message in loaded.history],
            ["user", "assistant", "tool"],
        )

    async def test_recovery_committed_write_does_not_replay(self) -> None:
        ledger = OperationLedger(self.workspace)
        counter = {"n": 0}
        registry = ToolRegistry(ledger=ledger)
        self._append_tool(registry, counter)

        session = Session(id="recover-committed", workspace=self.workspace)
        session.add("user", "写文件")
        args = json.dumps({"path": "once.txt"})
        batch = session.add(
            "assistant",
            "",
            tool_calls=[ToolCall("c1", "append_once", args)],
        )
        operation_id = f"{session.id}:{batch.id}:c1"
        await registry.execute(
            "append_once",
            args,
            ToolContext(self.workspace, session.id, operation_id=operation_id),
        )
        self.assertEqual(counter["n"], 1)

        store = SessionStore(self.workspace)
        store.save(session)
        loaded = store.load("recover-committed")
        added = await recover_interrupted_tool_calls(loaded, registry, ledger)

        self.assertEqual(added, 1)
        receipt = json.loads(loaded.history[-1].content)
        self.assertTrue(receipt["recovered"])
        self.assertEqual(receipt["execution_state"]["effect_status"], "committed")
        self.assertEqual(counter["n"], 1)
        self.assertEqual((Path(self.workspace) / "once.txt").read_text(), "x")

    async def test_recovery_not_committed_marks_retry(self) -> None:
        ledger = OperationLedger(self.workspace)
        session = Session(id="recover-pending", workspace=self.workspace)
        session.add("user", "写文件")
        batch = session.add(
            "assistant",
            "",
            tool_calls=[ToolCall("c1", "write_file", self._arguments("pending.txt", "x"))],
        )
        operation_id = f"{session.id}:{batch.id}:c1"
        ledger.begin(
            operation_id,
            "write_file",
            str(Path(self.workspace) / "pending.txt"),
            kind="replace",
        )

        added = await recover_interrupted_tool_calls(
            session,
            create_default_registry(self.workspace, ledger=ledger),
            ledger,
        )

        self.assertEqual(added, 1)
        receipt = json.loads(session.history[-1].content)
        self.assertEqual(receipt["execution_state"]["effect_status"], "not_committed")
        self.assertEqual(receipt["execution_state"]["recovery_action"], "retry")
        self.assertFalse((Path(self.workspace) / "pending.txt").exists())

    async def test_recovery_command_is_unknown_and_not_replayed(self) -> None:
        ledger = OperationLedger(self.workspace)
        session = Session(id="recover-command", workspace=self.workspace)
        session.add("user", "运行命令")
        batch = session.add(
            "assistant",
            "",
            tool_calls=[ToolCall("c1", "bash", json.dumps({"command": "touch side.txt"}))],
        )
        operation_id = f"{session.id}:{batch.id}:c1"
        ledger.begin(operation_id, "bash", None, kind="command")

        added = await recover_interrupted_tool_calls(session, None, ledger)

        self.assertEqual(added, 1)
        receipt = json.loads(session.history[-1].content)
        self.assertEqual(receipt["execution_state"]["effect_status"], "unknown")
        self.assertEqual(receipt["execution_state"]["recovery_action"], "manual_review")
        self.assertFalse((Path(self.workspace) / "side.txt").exists())

    async def test_recovery_leaves_complete_history_unchanged(self) -> None:
        session = Session(id="recover-complete", workspace=self.workspace, approval_mode="trust")
        provider = ScriptedProvider(
            [
                tool_call("write_file", {"path": "done.txt", "content": "ok"}, "c1"),
                text("完成"),
            ]
        )
        agent = ChatAgent(session, provider, create_default_registry(self.workspace))
        await agent.run("写文件")
        before = [message.content for message in session.history]

        added = await recover_interrupted_tool_calls(session, None, None)
        self.assertEqual(added, 0)
        self.assertEqual([message.content for message in session.history], before)

    async def test_duplicate_call_id_across_batches(self) -> None:
        session = Session(id="dup", workspace=self.workspace)
        session.add("assistant", "", tool_calls=[ToolCall("c1", "read_file", json.dumps({"path": "a"}))])
        session.add("tool", "旧批次结果", tool_call_id="c1", tool_name="read_file")
        second = session.add("assistant", "", tool_calls=[ToolCall("c1", "read_file", json.dumps({"path": "b"}))])

        added = await recover_interrupted_tool_calls(session, None, None)

        self.assertEqual(added, 1)
        receipts = [message for message in session.history if message.tool_call_id == "c1"]
        self.assertEqual(len(receipts), 2)
        self.assertIn("recovered", receipts[-1].content)
        self.assertTrue(second.id)
