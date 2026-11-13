"""Provider 抽象与确定性 ScriptedProvider。

对应 TS: src/llm/provider.ts、src/llm/mock.ts
真实项目通过 OpenAI/DeepSeek 适配器调用外部服务；这里用脚本化 Provider
把“模型行为”变成可重复的输入，便于逐步验证 Agent 机制。
"""

from __future__ import annotations

import asyncio
import json
import math
from dataclasses import dataclass, field
from typing import Any, Callable, Union

from .message import ToolCall
from .session import Usage


@dataclass
class LLMResult:
    type: str
    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    usage: Usage | None = None


ScriptItem = Union[LLMResult, str, Callable[[list[dict[str, Any]], list[dict[str, Any]]], LLMResult]]


def estimate_prompt_tokens(
    history: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    factor: float = 0.7,
) -> int:
    chars = 0
    for message in history:
        chars += len(str(message.get("content", "")))
        for call in message.get("tool_calls", []):
            function = call.get("function", {})
            chars += len(str(function.get("name", ""))) + len(str(function.get("arguments", ""))) + 16
    if tools:
        chars += len(json.dumps(tools, ensure_ascii=False))
    return math.ceil(chars * factor) + (len(history) + 1) * 4


class ScriptedProvider:
    """按顺序消费脚本；每个脚本项可以是 LLMResult、文本或回调。"""

    def __init__(self, script: list[ScriptItem], *, delay: float = 0.0, system_prompt: str = "You are a minimal tool-using agent."):
        self.script = list(script)
        self.delay = delay
        self.system_prompt = system_prompt
        self.requests: list[dict[str, Any]] = []

    async def chat_with_tools(
        self,
        history: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> LLMResult:
        self.requests.append({"history": history, "tools": tools})
        if self.delay:
            await asyncio.sleep(self.delay)
        result = self._next(history, tools)
        if result.usage is None:
            result.usage = self._usage(history, tools, result)
        return result

    async def chat_with_usage(self, history: list[dict[str, Any]]) -> LLMResult:
        self.requests.append({"history": history, "tools": []})
        if self.delay:
            await asyncio.sleep(self.delay)
        result = self._next(history, [])
        if result.usage is None:
            result.usage = self._usage(history, [], result)
        return result

    async def chat(self, history: list[dict[str, Any]]) -> str:
        result = await self.chat_with_usage(history)
        return result.content

    def _next(self, history: list[dict[str, Any]], tools: list[dict[str, Any]]) -> LLMResult:
        if not self.script:
            return LLMResult(type="text", content="（脚本已耗尽）")
        item = self.script.pop(0)
        if callable(item):
            result = item(history, tools)
        elif isinstance(item, str):
            result = LLMResult(type="text", content=item)
        else:
            result = item
        return result

    def _usage(
        self,
        history: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        result: LLMResult,
    ) -> Usage:
        prompt = estimate_prompt_tokens(history, tools)
        output_chars = len(result.content) + sum(len(call.arguments) + len(call.name) for call in result.tool_calls)
        completion = max(1, math.ceil(output_chars * 0.7))
        return Usage(
            prompt_tokens=prompt,
            completion_tokens=completion,
            total_tokens=prompt + completion,
            requests=1,
        )


def text(content: str) -> LLMResult:
    return LLMResult(type="text", content=content)


def tool_call(name: str, arguments: dict[str, Any] | str, call_id: str = "call_1") -> LLMResult:
    raw = arguments if isinstance(arguments, str) else json.dumps(arguments, ensure_ascii=False)
    return LLMResult(type="tool_calls", tool_calls=[ToolCall(id=call_id, name=name, arguments=raw)])
