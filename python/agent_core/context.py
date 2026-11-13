"""上下文构造、token 估算与 Context Epoch 压缩。

对应 TS: src/context/request.ts、src/context/epoch.ts
保留：
- 完整请求计量：system + history + transient + tool definitions
- 超过预算时把旧历史压缩成摘要，保留最近消息
- 压缩边界不拆散 tool_call/tool_result 组
- 压缩前归档、压缩后 epoch+1
简化：
- 摘要器默认用确定性规则，真实项目由 LLM 完成
- 不含旅行状态注入、artifact 索引、日历任务边界
"""

from __future__ import annotations

import inspect
import json
import math
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Iterable, Union

from .message import Message, ToolCall
from .session import Session, estimate_tokens

DEFAULT_MAX_INPUT_TOKENS = 24_000
KEPT_TOOL_MAX_CHARS = 3_000
KEPT_TOOL_CALL_ARG_MAX_CHARS = 2_000


@dataclass(frozen=True)
class RequestMetrics:
    system_chars: int
    history_chars: int
    transient_chars: int
    tool_definition_chars: int
    total_chars: int
    estimated_input_tokens: int
    input_limit: int


class ContextInputLimitError(Exception):
    def __init__(self, metrics: RequestMetrics):
        super().__init__(
            f"完整请求估算 {metrics.estimated_input_tokens} tokens，"
            f"超过输入预算 {metrics.input_limit}；压缩后仍过大。"
        )
        self.metrics = metrics


def measure_request_context(
    system_prompt: str | None,
    history: list[dict[str, Any]],
    transient: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    *,
    factor: float = 0.7,
    input_limit: int = DEFAULT_MAX_INPUT_TOKENS,
) -> RequestMetrics:
    system_chars = len(system_prompt or "")
    history_chars = _prompt_char_count(history)
    transient_chars = _prompt_char_count(transient)
    tool_chars = (
        len(json.dumps([{"type": "function", "function": tool} for tool in tools], ensure_ascii=False))
        if tools
        else 0
    )
    total_chars = system_chars + history_chars + transient_chars + tool_chars
    estimated = (
        math.ceil(total_chars * factor)
        + (len(history) + len(transient) + (1 if system_chars else 0)) * 4
    )
    return RequestMetrics(
        system_chars=system_chars,
        history_chars=history_chars,
        transient_chars=transient_chars,
        tool_definition_chars=tool_chars,
        total_chars=total_chars,
        estimated_input_tokens=estimated,
        input_limit=input_limit,
    )


def _prompt_char_count(messages: Iterable[dict[str, Any]]) -> int:
    total = 0
    for message in messages:
        total += len(str(message.get("content", "")))
        for call in message.get("tool_calls", []):
            function = call.get("function", {})
            total += len(str(function.get("name", ""))) + len(str(function.get("arguments", ""))) + 16
    return total


@dataclass(frozen=True)
class CompactInfo:
    removed_messages: int
    tokens_before: int
    tokens_after: int
    next_epoch: int


Summarizer = Callable[[list[Message]], Union[str, Awaitable[str]]]
Archiver = Callable[[Session, int], Union[None, Awaitable[None]]]


def simple_summarizer(messages: list[Message]) -> str:
    roles: dict[str, int] = {}
    for message in messages:
        roles[message.role] = roles.get(message.role, 0) + 1
    lines = [
        f"共 {len(messages)} 条旧消息："
        + "，".join(f"{role}={count}" for role, count in sorted(roles.items()))
    ]
    for message in messages[-6:]:
        snippet = " ".join(message.content.split())[:160]
        if snippet:
            lines.append(f"- {message.role}: {snippet}")
    return "\n".join(lines)


class ContextEpochManager:
    def __init__(
        self,
        *,
        summarize: Summarizer = simple_summarizer,
        max_prompt_tokens: int = DEFAULT_MAX_INPUT_TOKENS,
        keep_recent: int = 8,
        archive: Archiver | None = None,
    ):
        self.summarize = summarize
        self.max_prompt_tokens = max_prompt_tokens
        self.keep_recent = keep_recent
        self.archive = archive

    async def maybe_compact(
        self,
        session: Session,
        request_tokens: int | None = None,
    ) -> CompactInfo | None:
        history_tokens = session.estimate_history_tokens()
        tokens_before = request_tokens if request_tokens is not None else history_tokens
        if tokens_before <= self.max_prompt_tokens:
            return None
        if len(session.history) <= self.keep_recent:
            return None

        keep_from = len(session.history) - self.keep_recent
        while keep_from > 0 and session.history[keep_from].role == "tool":
            keep_from -= 1
        if keep_from == 0:
            return None

        old_messages = session.history[:keep_from]
        recent = [compact_historical_message(message) for message in session.history[keep_from:]]
        next_epoch = session.epoch + 1

        if self.archive is not None:
            await _maybe_await(self.archive(session, next_epoch))
        summary = await _maybe_await(self.summarize(old_messages))
        summary_message = Message(
            role="system",
            content=(
                f"【上下文摘要 | 第 {next_epoch} 纪元】"
                f"以下是对本会话较早对话的压缩摘要，代替原始消息：\n{summary}"
            ),
        )
        session.replace_history([summary_message, *recent], next_epoch)
        return CompactInfo(
            removed_messages=len(old_messages),
            tokens_before=tokens_before,
            tokens_after=session.estimate_history_tokens(),
            next_epoch=next_epoch,
        )


def compact_historical_message(message: Message) -> Message:
    content = message.content
    if len(content) > KEPT_TOOL_MAX_CHARS:
        content = content[: KEPT_TOOL_MAX_CHARS - 1] + "…"
    calls = [
        ToolCall(
            id=call.id,
            name=call.name,
            arguments=(
                call.arguments
                if len(call.arguments) <= KEPT_TOOL_CALL_ARG_MAX_CHARS
                else call.arguments[: KEPT_TOOL_CALL_ARG_MAX_CHARS - 1] + "…"
            ),
        )
        for call in message.tool_calls
    ]
    return Message(
        role=message.role,
        content=content,
        tool_calls=calls,
        tool_call_id=message.tool_call_id,
        tool_name=message.tool_name,
    )


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def estimate_tool_definition_tokens(tools: list[dict[str, Any]], factor: float = 0.7) -> int:
    if not tools:
        return 0
    return estimate_tokens(
        json.dumps([{"type": "function", "function": tool} for tool in tools], ensure_ascii=False),
        factor,
    )
