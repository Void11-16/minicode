"""Message / ToolCall: 本地完整消息与发给模型的协议投影。

对应 TS: src/core/message.ts
- 本地消息保留 id、时间、tool_call_id、tool_name 等审计信息
- to_prompt_view() 只输出模型协议需要的字段
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from itertools import count
from typing import Any

_ids = count(1)


def new_message_id() -> str:
    return f"msg_{next(_ids)}"


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: str


@dataclass
class Message:
    role: str
    content: str
    id: str = field(default_factory=new_message_id)
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_call_id: str | None = None
    tool_name: str | None = None

    def prompt_view(self) -> dict[str, Any]:
        view: dict[str, Any] = {"role": self.role, "content": self.content}
        if self.tool_calls:
            view["tool_calls"] = [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": call.arguments},
                }
                for call in self.tool_calls
            ]
        if self.tool_call_id is not None:
            view["tool_call_id"] = self.tool_call_id
        return view

    def to_data(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "role": self.role,
            "content": self.content,
            "created_at": self.created_at,
            "tool_calls": [
                {"id": call.id, "name": call.name, "arguments": call.arguments}
                for call in self.tool_calls
            ],
            "tool_call_id": self.tool_call_id,
            "tool_name": self.tool_name,
        }

    @classmethod
    def from_data(cls, data: dict[str, Any]) -> "Message":
        return cls(
            id=data["id"],
            role=data["role"],
            content=data["content"],
            created_at=data["created_at"],
            tool_calls=[
                ToolCall(id=call["id"], name=call["name"], arguments=call["arguments"])
                for call in data.get("tool_calls", [])
            ],
            tool_call_id=data.get("tool_call_id"),
            tool_name=data.get("tool_name"),
        )
