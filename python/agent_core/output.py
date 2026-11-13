"""工具结果进入上下文前的预算与原文归档。

对应 TS: src/agent/tool-output.ts
- 单条结果最多 3,000 字符
- 同一批结果合计最多 8,000 字符，按剩余预算动态分配
- 超限原文写入 .minicode-py/artifacts/<session>/<tool>-<call>.txt
- 上下文只保留类型头、字符数、artifact 路径和关键行预览
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path

TOOL_RESULT_MAX_CHARS = 3_000
TOOL_RESULT_BATCH_MAX_CHARS = 8_000


@dataclass
class ToolResult:
    call_id: str
    tool_name: str
    output: str
    output_kind: str = "generic"
    error: str | None = None


@dataclass
class CompactedToolResult:
    call_id: str
    tool_name: str
    text: str
    truncated: bool
    artifact_path: str | None = None


async def compact_tool_results(
    results: list[ToolResult],
    *,
    workspace: str,
    session_id: str,
    max_chars: int = TOOL_RESULT_MAX_CHARS,
    batch_max_chars: int = TOOL_RESULT_BATCH_MAX_CHARS,
) -> list[CompactedToolResult]:
    remaining = batch_max_chars
    compacted: list[CompactedToolResult] = []
    for index, result in enumerate(results):
        remaining_calls = len(results) - index
        allocation = min(max_chars, remaining // max(1, remaining_calls))
        if allocation == 0:
            allocation = min(80, max_chars)
        item = _compact_one(
            result,
            max_chars=allocation,
            workspace=workspace,
            session_id=session_id,
        )
        compacted.append(item)
        remaining = max(0, remaining - len(item.text))
    return compacted


def _compact_one(
    result: ToolResult,
    *,
    max_chars: int,
    workspace: str,
    session_id: str,
) -> CompactedToolResult:
    kind = "error" if result.error is not None else result.output_kind
    header = f"[tool-result type={kind} chars={len(result.output)}]"
    if len(result.output) + len(header) + 1 <= max_chars:
        return CompactedToolResult(
            call_id=result.call_id,
            tool_name=result.tool_name,
            text=f"{header}\n{result.output}",
            truncated=False,
        )

    artifact = _artifact_file(workspace, session_id, result, kind)
    artifact_path: str | None = None
    try:
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_text(result.output, encoding="utf-8")
        artifact_path = str(artifact.relative_to(Path(workspace).resolve()))
    except OSError:
        artifact_path = None

    prefix = (
        f"{header} truncated=true artifact=unavailable\n"
        "原文落盘失败；以下仅保留按重要字段裁剪的预览，请不要假设存在完整归档：\n"
        if artifact_path is None
        else f"{header} truncated=true artifact={artifact_path}\n"
        "原文已落盘；确需完整数据时按 artifact 路径分页读取。以下仅为预览：\n"
    )
    budget = max(0, max_chars - len(prefix))
    body = preview(result.output, budget) if budget > 0 else ""
    text = (prefix + body)[:max_chars]
    return CompactedToolResult(
        call_id=result.call_id,
        tool_name=result.tool_name,
        text=text,
        truncated=True,
        artifact_path=artifact_path,
    )


def _artifact_file(workspace: str, session_id: str, result: ToolResult, kind: str) -> Path:
    suffix = "error" if kind == "error" else "txt"
    return (
        Path(workspace).resolve()
        / ".minicode-py"
        / "artifacts"
        / _safe_segment(session_id)
        / f"{_safe_segment(result.tool_name)}-{_safe_segment(result.call_id)}.{suffix}"
    )


def _safe_segment(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", value).strip("_")[:100]
    return safe or "item"


def preview(text: str, budget: int) -> str:
    if budget <= 0:
        return ""
    if len(text) <= budget:
        return text
    lines = text.splitlines()
    important = [
        line
        for line in lines
        if re.search(r"坐标|类型|景点|餐厅|酒店|评分|P0|P1|P2|错误|失败|日期|时间|预算|开放|闭馆", line)
    ]
    head = lines[: min(12, len(lines))]
    tail = lines[max(0, len(lines) - 10) :]
    sections = [("开头", head), ("关键行", important), ("结尾", tail)]
    weights = [0.32, 0.42, 0.26]
    pieces: list[str] = []
    for (label, section_lines), weight in zip(sections, weights):
        if not section_lines:
            continue
        section_budget = max(0, math.floor(budget * weight) - len(label) - 4)
        if section_budget == 0:
            continue
        body = _clip_lines(section_lines, section_budget)
        if body:
            pieces.append(f"【{label}】\n{body}")
    joined = "\n".join(pieces)
    if len(joined) <= budget:
        return joined
    return joined[: max(0, budget - 1)] + "…"


def _clip_lines(lines: list[str], budget: int) -> str:
    result = ""
    for line in lines:
        candidate = line if not result else f"{result}\n{line}"
        if len(candidate) <= budget:
            result = candidate
            continue
        if not result:
            return line[: max(0, budget - 1)] + "…"
        break
    return result
