"""最小内置工具：文件读写、目录列表、演示用大输出与失败工具。

对应 TS: src/tools/files.ts、src/tools/bash.ts（仅保留安全子集）
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .operations import OperationLedger
from .tools import Tool, ToolContext, ToolRegistry, workspace_path


def _read_file(args: dict[str, Any], context: ToolContext) -> str:
    path = workspace_path(context.workspace, str(args["path"]))
    return path.read_text(encoding="utf-8")


def _write_file(args: dict[str, Any], context: ToolContext) -> str:
    path = workspace_path(context.workspace, str(args["path"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    content = str(args["content"])
    path.write_text(content, encoding="utf-8")
    return f"已写入 {path.name}（{len(content)} 字符）"


def _list_files(args: dict[str, Any], context: ToolContext) -> str:
    path = workspace_path(context.workspace, str(args.get("path", ".")))
    if not path.exists():
        raise FileNotFoundError(f"目录不存在: {path}")
    entries = []
    for child in sorted(path.iterdir()):
        entries.append(f"{child.name}/" if child.is_dir() else child.name)
    return json.dumps(entries, ensure_ascii=False)


def _big_output(args: dict[str, Any], context: ToolContext) -> str:
    chars = int(args.get("chars", 9000))
    marker = str(args.get("marker", "A"))
    body = (marker * max(1, chars // len(marker) + 1))[:chars]
    return "important: 坐标=34.3,108.9 类型=景点\n" + body


def _fail(args: dict[str, Any], context: ToolContext) -> str:
    raise RuntimeError(str(args.get("message", "模拟工具失败")))


FILE_SCHEMAS = {
    "read_file": {
        "type": "object",
        "properties": {"path": {"type": "string", "minLength": 1}},
        "required": ["path"],
        "additionalProperties": False,
    },
    "write_file": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "minLength": 1},
            "content": {"type": "string"},
        },
        "required": ["path", "content"],
        "additionalProperties": False,
    },
    "list_files": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "additionalProperties": False,
    },
}


def create_default_registry(
    workspace: str,
    *,
    ledger: OperationLedger | None = None,
) -> ToolRegistry:
    registry = ToolRegistry(ledger=ledger)
    registry.register(
        Tool(
            name="read_file",
            description="读取工作区内的文本文件。",
            parameters=FILE_SCHEMAS["read_file"],
            execute=_read_file,
            output_kind="file",
        )
    )
    registry.register(
        Tool(
            name="write_file",
            description="把文本写入工作区文件；需要 path 和 content。",
            parameters=FILE_SCHEMAS["write_file"],
            execute=_write_file,
            effect="managed_write",
            workspace_edit=True,
            output_kind="file",
        )
    )
    registry.register(
        Tool(
            name="list_files",
            description="列出工作区目录内容。",
            parameters=FILE_SCHEMAS["list_files"],
            execute=_list_files,
            output_kind="file",
        )
    )
    return registry


def create_demo_registry(
    workspace: str,
    *,
    ledger: OperationLedger | None = None,
) -> ToolRegistry:
    registry = create_default_registry(workspace, ledger=ledger)
    registry.register(
        Tool(
            name="big_output",
            description="返回指定字符数的大文本，用于验证工具输出预算。",
            parameters={
                "type": "object",
                "properties": {
                    "chars": {"type": "integer", "minimum": 1, "maximum": 50_000},
                    "marker": {"type": "string"},
                },
                "additionalProperties": False,
            },
            execute=_big_output,
            output_kind="generic",
        )
    )
    registry.register(
        Tool(
            name="fail",
            description="总是失败，用于验证错误回传与熔断。",
            parameters={
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "additionalProperties": False,
            },
            execute=_fail,
            output_kind="error",
        )
    )
    return registry


def main() -> None:
    registry = create_default_registry(str(Path.cwd()))
    print(json.dumps(registry.definitions(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
