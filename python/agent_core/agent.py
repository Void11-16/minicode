"""ChatAgent: 一次任务的核心循环。

对应 TS: src/agent/agent.ts 的 ChatAgent.run
保留的 Agent 主机制：
- user -> LLM -> [tool_calls -> 执行 -> 结果回传 -> LLM ...] -> 最终文字
- 每轮检查轮次/调用/token 预算
- 每次请求前做完整上下文计量，超限时触发压缩
- steer 消息在下一轮模型请求前注入
- 工具参数错误结构化回传；相同错误连续出现时提示并熔断
- 权限拒绝、工具不存在、工具执行异常都变成 tool 消息继续对话
- 安全边界 checkpoint
移除：旅行阶段/日期任务/证据仓库/路线修复/质量闸门
"""

from __future__ import annotations

import inspect
import json
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Union

from .budget import ExecutionBudget
from .context import (
    ContextEpochManager,
    ContextInputLimitError,
    RequestMetrics,
    measure_request_context,
)
from .message import ToolCall
from .output import ToolResult, compact_tool_results
from .permissions import PermissionPolicy
from .provider import LLMResult, ScriptedProvider
from .recovery import recover_interrupted_tool_calls
from .session import Session
from .tools import ToolContext, ToolRegistry, ToolValidationError

WRAP_UP_HINT_ROUNDS = 3
REPEATED_FAILURE_GUIDANCE_AT = 2
REPEATED_FAILURE_CIRCUIT_AT = 5

EventCallback = Callable[[dict[str, Any]], None]
CheckpointCallback = Callable[[], Union[None, Awaitable[None]]]
PermissionCallback = Callable[[dict[str, Any]], Union[bool, Awaitable[bool]]]
SteerCallback = Callable[[], list[str]]


@dataclass
class RunOptions:
    budget: ExecutionBudget | None = None
    max_rounds: int = 5
    max_calls: int = 30
    max_prompt_tokens: int = 24_000
    on_event: EventCallback | None = None
    on_checkpoint: CheckpointCallback | None = None
    on_permission: PermissionCallback | None = None
    on_compact: Callable[[Any], None] | None = None
    take_steered_messages: SteerCallback | None = None


class TurnAbortedError(Exception):
    def __init__(self) -> None:
        super().__init__("已中断当前轮")
        self.name = "TurnAbortedError"


class ChatAgent:
    def __init__(
        self,
        session: Session,
        provider: ScriptedProvider,
        registry: ToolRegistry | None = None,
        *,
        permissions: PermissionPolicy | None = None,
        compactor: ContextEpochManager | None = None,
    ):
        self.session = session
        self.provider = provider
        self.registry = registry
        self.permissions = permissions or PermissionPolicy(session.approval_mode)
        self.compactor = compactor
        self._abort_requested = False

    def abort(self) -> None:
        self._abort_requested = True

    async def run(self, user_input: str, options: RunOptions | None = None) -> str:
        options = options or RunOptions()
        trimmed = user_input.strip()
        if not trimmed:
            raise ValueError("输入不能为空")

        self._abort_requested = False
        if self.registry is not None:
            recovered = await recover_interrupted_tool_calls(
                self.session,
                self.registry,
                self.registry.ledger,
            )
            if recovered:
                await self._checkpoint(options)

        self.session.add("user", trimmed)
        await self._checkpoint(options)

        if (
            self.registry is None
            or self.registry.size == 0
            or not hasattr(self.provider, "chat_with_tools")
        ):
            reply = await self._plain_chat(options)
            await self._checkpoint(options)
            return reply

        budget = options.budget or ExecutionBudget(
            max_rounds=options.max_rounds,
            max_calls=options.max_calls,
        )
        if budget.rounds >= budget.max_rounds or budget.calls >= budget.max_calls:
            reply = f"已达到执行预算（{budget.reason()}），本次未发送新的模型请求。"
            self.session.add("assistant", reply)
            await self._checkpoint(options)
            return reply

        guidance: str | None = None
        failure_key = ""
        failure_count = 0
        circuit_reason: str | None = None

        while True:
            if self._abort_requested:
                raise TurnAbortedError()
            if budget.exhausted():
                guidance = f"已达到执行预算（{budget.reason()}）；请按当前结果收尾，不要继续请求工具。"
                break

            steered = options.take_steered_messages() if options.take_steered_messages else []
            for message in steered:
                self.session.add("user", message)
                failure_key = ""
                failure_count = 0

            remaining = budget.max_rounds - budget.rounds - 1
            transient: list[dict[str, Any]] = []
            if guidance:
                transient.append({"role": "system", "content": guidance})
            if remaining < WRAP_UP_HINT_ROUNDS:
                transient.append(
                    {
                        "role": "system",
                        "content": f"仅剩 {max(0, remaining)} 轮工具调用；优先完成目标并给出最终答复。",
                    }
                )

            history, tools, metrics = self._build_request(options, transient)
            if metrics.estimated_input_tokens > metrics.input_limit and self.compactor is not None:
                compacted = await self.compactor.maybe_compact(
                    self.session, metrics.estimated_input_tokens
                )
                if compacted is not None:
                    self._emit(
                        options,
                        {
                            "type": "compact",
                            "epoch": compacted.next_epoch,
                            "removed": compacted.removed_messages,
                            "tokens_before": compacted.tokens_before,
                            "tokens_after": compacted.tokens_after,
                        },
                    )
                    if options.on_compact is not None:
                        options.on_compact(compacted)
                    history, tools, metrics = self._build_request(options, transient)
            if metrics.estimated_input_tokens > metrics.input_limit:
                raise ContextInputLimitError(metrics)

            self._emit(options, {"type": "request", "metrics": metrics})
            result = await self.provider.chat_with_tools(history + transient, tools)

            if result.usage is not None:
                self.session.usage.add(result.usage)
                budget.tokens += result.usage.total_tokens
                if metrics.total_chars >= 3000:
                    self.session.calibrate(result.usage.prompt_tokens, metrics.total_chars)

            if result.type == "text" or not result.tool_calls:
                reply = result.content
                self.session.add("assistant", reply)
                await self._checkpoint(options)
                return reply

            batch = self.session.add("assistant", "", tool_calls=result.tool_calls)
            await self._checkpoint(options)

            pending: list[ToolResult] = []
            stop_batch = False
            for index, call in enumerate(result.tool_calls):
                if budget.calls >= budget.max_calls:
                    pending.append(
                        self._error_result(
                            call,
                            "已达到累计工具调用上限，本次调用未执行。",
                        )
                    )
                    continue

                tool = self.registry.get(call.name)
                if tool is None:
                    text = f"工具不存在: {call.name}"
                    pending.append(self._error_result(call, text))
                    failure_key, failure_count = self._track_failure(
                        call, text, failure_key, failure_count
                    )
                    if failure_count >= REPEATED_FAILURE_CIRCUIT_AT:
                        circuit_reason = (
                            f"相同工具错误连续出现 {failure_count} 次，已熔断当前工具循环；"
                            "保留已获得的结果并给出最终答复。"
                        )
                        stop_batch = True
                        for skipped in result.tool_calls[index + 1 :]:
                            pending.append(
                                self._error_result(
                                    skipped,
                                    "前序工具连续失败，本批后续调用未执行。",
                                )
                            )
                        break
                    continue

                if self.permissions.requires_confirmation(tool):
                    allowed = True
                    if options.on_permission is not None:
                        allowed = await _maybe_await(
                            options.on_permission(
                                {
                                    "tool": tool.name,
                                    "arguments": call.arguments,
                                    "message": tool.description,
                                }
                            )
                        )
                    if not allowed:
                        text = "用户拒绝授权执行此工具。请调整方案或改用其他方式。"
                        pending.append(self._error_result(call, text))
                        self._emit(options, {"type": "tool_denied", "name": call.name})
                        failure_key, failure_count = self._track_failure(
                            call, text, failure_key, failure_count
                        )
                        if failure_count >= REPEATED_FAILURE_CIRCUIT_AT:
                            circuit_reason = (
                                f"相同工具错误连续出现 {failure_count} 次，已熔断当前工具循环；"
                                "保留已获得的结果并给出最终答复。"
                            )
                            stop_batch = True
                            for skipped in result.tool_calls[index + 1 :]:
                                pending.append(
                                    self._error_result(
                                        skipped,
                                        "前序工具连续失败，本批后续调用未执行。",
                                    )
                                )
                            break
                        continue

                budget.calls += 1
                self._emit(
                    options,
                    {"type": "tool_start", "name": call.name, "arguments": call.arguments},
                )
                try:
                    output = await self.registry.execute(
                        call.name,
                        call.arguments,
                        ToolContext(
                            workspace=self.session.workspace,
                            session_id=self.session.id,
                            operation_id=f"{self.session.id}:{batch.id}:{call.id}",
                            is_aborted=lambda: self._abort_requested,
                        ),
                    )
                    pending.append(
                        ToolResult(
                            call_id=call.id,
                            tool_name=call.name,
                            output=output,
                            output_kind=tool.output_kind,
                        )
                    )
                    self._emit(
                        options,
                        {"type": "tool_end", "name": call.name, "output": output},
                    )
                    failure_key, failure_count = "", 0
                    if guidance and guidance.startswith("相同工具错误"):
                        guidance = None
                except ToolValidationError as error:
                    text = error.feedback()
                    pending.append(self._error_result(call, text))
                    self._emit(
                        options,
                        {"type": "tool_error", "name": call.name, "error": text},
                    )
                    failure_key, failure_count = self._track_failure(
                        call, text, failure_key, failure_count
                    )
                except Exception as error:  # noqa: BLE001 - 工具失败要回传给模型
                    text = f"工具执行失败: {error}"
                    pending.append(self._error_result(call, text))
                    self._emit(
                        options,
                        {"type": "tool_error", "name": call.name, "error": text},
                    )
                    failure_key, failure_count = self._track_failure(
                        call, text, failure_key, failure_count
                    )

                if failure_count >= REPEATED_FAILURE_CIRCUIT_AT:
                    circuit_reason = (
                        f"相同工具错误连续出现 {failure_count} 次，已熔断当前工具循环；"
                        "保留已获得的结果并给出最终答复。"
                    )
                    stop_batch = True

                if stop_batch:
                    for skipped in result.tool_calls[index + 1 :]:
                        pending.append(
                            self._error_result(
                                skipped,
                                "前序工具连续失败，本批后续调用未执行。",
                            )
                        )
                    break

            compacted = await compact_tool_results(
                pending,
                workspace=self.session.workspace,
                session_id=self.session.id,
            )
            for item in compacted:
                self.session.add(
                    "tool",
                    item.text,
                    tool_call_id=item.call_id,
                    tool_name=item.tool_name,
                )

            budget.rounds += 1
            await self._checkpoint(options)
            if self._abort_requested:
                raise TurnAbortedError()

            if circuit_reason:
                guidance = circuit_reason
                break

            if (
                failure_count >= REPEATED_FAILURE_GUIDANCE_AT
                and failure_key
                and guidance is None
            ):
                guidance = (
                    f"相同工具错误已连续出现 {failure_count} 次。"
                    "不要重复原参数；根据错误路径修正，或改用其他可行方案。"
                )

        return await self._finalize(guidance, options)

    def _build_request(
        self,
        options: RunOptions,
        transient: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], RequestMetrics]:
        history = self.session.to_prompt()
        tools = self.registry.definitions() if self.registry is not None else []
        metrics = measure_request_context(
            self.provider.system_prompt,
            history,
            transient,
            tools,
            factor=self.session.calibration_factor,
            input_limit=options.max_prompt_tokens,
        )
        return history, tools, metrics

    async def _plain_chat(self, options: RunOptions) -> str:
        history = self.session.to_prompt()
        if hasattr(self.provider, "chat_with_usage"):
            result = await self.provider.chat_with_usage(history)
            if result.usage is not None:
                self.session.usage.add(result.usage)
            reply = result.content
        else:
            reply = await self.provider.chat(history)
        self.session.add("assistant", reply)
        return reply

    async def _finalize(self, guidance: str | None, options: RunOptions) -> str:
        history = self.session.to_prompt()
        if guidance:
            history.append({"role": "system", "content": guidance})
        fallback = "本轮已停止：" + (guidance or "执行预算已用尽")
        try:
            if hasattr(self.provider, "chat_with_usage"):
                result = await self.provider.chat_with_usage(history)
                if result.usage is not None:
                    self.session.usage.add(result.usage)
                reply = result.content
            else:
                reply = await self.provider.chat(history)
        except Exception:  # noqa: BLE001 - 收尾失败不应吞掉已保存状态
            reply = ""
        if not reply.strip():
            reply = fallback
        self.session.add("assistant", reply)
        await self._checkpoint(options)
        return reply

    async def _checkpoint(self, options: RunOptions) -> None:
        if options.on_checkpoint is None:
            return
        try:
            await _maybe_await(options.on_checkpoint())
        except Exception as error:  # noqa: BLE001 - 落盘失败只丢快照，不打断对话
            self._emit(options, {"type": "checkpoint_error", "error": str(error)})

    def _emit(self, options: RunOptions, event: dict[str, Any]) -> None:
        if options.on_event is not None:
            try:
                options.on_event(event)
            except Exception:  # noqa: BLE001 - 事件回调失败不中断 Agent
                pass

    def _error_result(self, call: ToolCall, text: str) -> ToolResult:
        return ToolResult(
            call_id=call.id,
            tool_name=call.name,
            output=text,
            output_kind="error",
            error=text,
        )

    def _track_failure(
        self,
        call: ToolCall,
        text: str,
        failure_key: str,
        failure_count: int,
    ) -> tuple[str, int]:
        key = f"{call.name}:{text}"
        if key == failure_key:
            return failure_key, failure_count + 1
        return key, 1


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value
