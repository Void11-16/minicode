"""Tool / ToolRegistry: 参数契约、执行入口与 schema 导出。

对应 TS: src/tools/tool.ts、src/tools/tool-contract.ts
保留：
- 工具不存在、非法 JSON、schema 不匹配都在执行前失败
- 结构化错误回传给模型，而不是抛给宿主
- 同一份 schema 同时用于 Agent 与直接调用
移除：
- 旅行工具、证据仓库、缓存、操作账本、MCP
"""

from __future__ import annotations

import inspect
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from .operations import OperationLedger
from .schema import ValidationIssue, validate_schema


class ToolValidationError(Exception):
    def __init__(self, issues: list[ValidationIssue]):
        super().__init__("invalid tool arguments")
        self.issues = issues

    def feedback(self) -> str:
        return json.dumps(
            {
                "error": "invalid_tool_arguments",
                "issues": [
                    {"path": issue.path, "message": issue.message, "hint": issue.hint}
                    for issue in self.issues[:12]
                ],
                "hint": "只修改指出的参数路径后重试；工具未执行。",
            },
            ensure_ascii=False,
        )


@dataclass
class ToolContext:
    workspace: str
    session_id: str
    operation_id: str | None = None
    is_aborted: Callable[[], bool] = lambda: False


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    execute: Callable[[dict[str, Any], ToolContext], str | Awaitable[str]]
    effect: str = "query"
    requires_confirmation: bool = False
    workspace_edit: bool = False
    output_kind: str = "generic"


def parse_tool_input(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except json.JSONDecodeError:
        raise ToolValidationError(
            [
                ValidationIssue(
                    "",
                    "参数不是合法 JSON，工具未执行",
                    "按工具 schema 重建完整 JSON；不自动补括号或猜测截断内容。",
                )
            ]
        )
    if not isinstance(value, dict):
        raise ToolValidationError(
            [
                ValidationIssue(
                    "",
                    "参数必须是 JSON 对象",
                    "传入对象，不要传入数组、null 或 JSON 字符串。",
                )
            ]
        )
    return value


@dataclass
class ToolRegistry:
    tools: dict[str, Tool] = field(default_factory=dict)
    ledger: OperationLedger | None = None

    def register(self, tool: Tool) -> "ToolRegistry":
        if tool.name in self.tools:
            raise ValueError(f"工具重复注册: {tool.name}")
        self.tools[tool.name] = tool
        return self

    def get(self, name: str) -> Tool | None:
        return self.tools.get(name)

    @property
    def size(self) -> int:
        return len(self.tools)

    def definitions(self) -> list[dict[str, Any]]:
        return [
            {"name": tool.name, "description": tool.description, "parameters": tool.parameters}
            for tool in self.tools.values()
        ]

    async def execute(self, name: str, args_json: str, context: ToolContext) -> str:
        tool = self.tools.get(name)
        if tool is None:
            available = ", ".join(self.tools)
            raise ToolValidationError(
                [ValidationIssue("", f"工具不存在: {name}（可用: {available}）")]
            )
        args = parse_tool_input(args_json)
        issues = validate_schema(tool.parameters, args)
        if issues:
            raise ToolValidationError(issues)
        if context.is_aborted():
            raise RuntimeError("工具执行已取消")

        tracked = (
            self.ledger is not None
            and context.operation_id is not None
            and tool.effect in ("managed_write", "command")
        )
        resource = _operation_resource(tool, args, context) if tracked else None
        kind = "command" if tool.effect == "command" else "replace"
        if tracked:
            self.ledger.begin(context.operation_id, tool.name, resource, kind=kind)
        try:
            result = tool.execute(args, context)
            if inspect.isawaitable(result):
                result = await result
        except Exception as error:
            if tracked:
                self.ledger.fail(context.operation_id, str(error))
            raise
        if tracked:
            self.ledger.commit(context.operation_id, result, resource)
        return result


def _operation_resource(tool: Tool, args: dict[str, Any], context: ToolContext) -> str | None:
    if tool.effect == "command":
        return str(Path(context.workspace).resolve() / ".minicode-py" / "commands" / tool.name)
    path = args.get("path")
    if isinstance(path, str) and path:
        return str(workspace_path(context.workspace, path))
    return None


def workspace_path(workspace: str, relative: str) -> Path:
    root = Path(workspace).resolve()
    candidate = (root / relative).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"安全限制: 只能访问 {root} 目录内的路径")
    return candidate
