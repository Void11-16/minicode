"""Session: 历史、用量、工作区、审批模式与持久化。

对应 TS: src/core/session.ts、src/core/usage.ts
简化点：
- 不包含旅行状态、工具激活状态、请求计量明细
- 只保留 Agent 主循环需要的字段
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Iterable

from .message import Message, ToolCall


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    requests: int = 0

    def add(self, other: "Usage") -> None:
        self.prompt_tokens += other.prompt_tokens
        self.completion_tokens += other.completion_tokens
        self.total_tokens += other.total_tokens
        self.requests += other.requests

    def to_data(self) -> dict[str, int]:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
            "requests": self.requests,
        }

    @classmethod
    def from_data(cls, data: dict[str, int]) -> "Usage":
        return cls(
            prompt_tokens=data.get("prompt_tokens", 0),
            completion_tokens=data.get("completion_tokens", 0),
            total_tokens=data.get("total_tokens", 0),
            requests=data.get("requests", 0),
        )


def estimate_tokens(text: str, factor: float = 0.7) -> int:
    return math.ceil(len(text) * factor)


def estimate_history_tokens(messages: Iterable[Message], factor: float = 0.7) -> int:
    total = 0
    for message in messages:
        call_chars = sum(
            len(call.id) + len(call.name) + len(call.arguments) + 16
            for call in message.tool_calls
        )
        total += estimate_tokens(message.content, factor)
        total += math.ceil(call_chars * factor)
        total += 4
    return total


def prompt_char_count(messages: Iterable[Message]) -> int:
    total = 0
    for message in messages:
        total += len(message.content)
        for call in message.tool_calls:
            total += len(call.id) + len(call.name) + len(call.arguments) + 16
    return total


@dataclass
class Session:
    id: str
    workspace: str = "."
    approval_mode: str = "edits"
    history: list[Message] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)
    epoch: int = 0
    calibration_factor: float = 0.7

    def add(
        self,
        role: str,
        content: str,
        *,
        tool_calls: list[ToolCall] | None = None,
        tool_call_id: str | None = None,
        tool_name: str | None = None,
    ) -> Message:
        message = Message(
            role=role,
            content=content,
            tool_calls=tool_calls or [],
            tool_call_id=tool_call_id,
            tool_name=tool_name,
        )
        self.history.append(message)
        return message

    def to_prompt(self) -> list[dict[str, Any]]:
        return [message.prompt_view() for message in self.history]

    def replace_history(self, messages: list[Message], next_epoch: int | None = None) -> None:
        self.history = messages
        if next_epoch is not None:
            self.epoch = next_epoch

    def estimate_history_tokens(self) -> int:
        return estimate_history_tokens(self.history, self.calibration_factor)

    def prompt_char_count(self, messages: Iterable[Message] | None = None) -> int:
        return prompt_char_count(self.history if messages is None else messages)

    def calibrate(self, prompt_tokens: int, request_chars: int) -> None:
        if request_chars <= 0:
            return
        observed = prompt_tokens / request_chars
        self.calibration_factor = (self.calibration_factor + observed) / 2

    def to_data(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "workspace": self.workspace,
            "approval_mode": self.approval_mode,
            "epoch": self.epoch,
            "calibration_factor": self.calibration_factor,
            "usage": self.usage.to_data(),
            "history": [message.to_data() for message in self.history],
        }

    @classmethod
    def from_data(cls, data: dict[str, Any]) -> "Session":
        return cls(
            id=data["id"],
            workspace=data.get("workspace", "."),
            approval_mode=data.get("approval_mode", "edits"),
            epoch=data.get("epoch", 0),
            calibration_factor=data.get("calibration_factor", 0.7),
            usage=Usage.from_data(data.get("usage", {})),
            history=[Message.from_data(item) for item in data.get("history", [])],
        )
