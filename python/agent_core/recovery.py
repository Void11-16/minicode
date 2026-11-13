"""中断恢复：补齐丢失的 tool 结果，核对提交事实，不重放未知副作用。

对应 TS: src/agent/tool-recovery.ts

恢复的是“消息协议 + 提交事实”，不是任意执行现场：
- 检查点停在 assistant(tool_calls) 时，为该批次每个未返回的调用补一条 tool 回执
- 有操作账本时先核对 committed / not_committed / unknown
- 只读调用标记 retry；有副作用的调用标记 manual_review，绝不自动重放
"""

from __future__ import annotations

import json
from typing import Any

from .message import Message, ToolCall
from .operations import OperationLedger, ToolExecutionState
from .session import Session
from .tools import ToolRegistry


def _is_compacted_arguments(arguments: str) -> bool:
    if "_truncated" in arguments:
        return True
    try:
        value = json.loads(arguments)
    except json.JSONDecodeError:
        return False
    return isinstance(value, dict) and value.get("_truncated") is True


def _tool_receipt(
    session: Session,
    message: Message,
    call: ToolCall,
    registry: ToolRegistry | None,
    ledger: OperationLedger | None,
) -> str:
    operation_id = f"{session.id}:{message.id}:{call.id}"
    record = ledger.reconcile(operation_id) if ledger is not None else None
    tool = registry.get(call.name) if registry is not None else None
    risky = (
        tool is None
        or tool.effect in ("managed_write", "command")
        or tool.requires_confirmation
    )

    if record is not None and record.get("state") is not None:
        state = ToolExecutionState(**record["state"])
    else:
        state = ToolExecutionState(
            operation_id=operation_id,
            execution_status="failed",
            effect_status="unknown" if risky else "none",
            recovery_action="manual_review" if risky else "retry",
            code="TOOL_INTERRUPTED",
        )

    if state.effect_status == "committed":
        message_text = "已从主文件核对提交结果，未重新执行该修改。"
    elif state.effect_status == "not_committed":
        message_text = "上次调用在结果回填前中断，已核对未提交；可以重新执行。"
    elif state.effect_status == "none":
        message_text = "上次只读调用在结果回填前中断，没有产生副作用；可以重新查询。"
    else:
        message_text = "上次调用在结果回填前中断，副作用状态未知；未自动重放，请先核对实际状态。"

    payload: dict[str, Any] = {
        "recovered": True,
        "execution_state": state.to_data(),
        "message": message_text,
    }
    if record is not None and record.get("output"):
        payload["output"] = record["output"]
    return json.dumps(payload, ensure_ascii=False)


async def recover_interrupted_tool_calls(
    session: Session,
    registry: ToolRegistry | None = None,
    ledger: OperationLedger | None = None,
) -> int:
    history = session.history
    restored: list[Message] = []
    recovered = 0

    for index, message in enumerate(history):
        restored.append(message)
        if not message.tool_calls:
            continue

        returned: set[str] = set()
        cursor = index + 1
        while cursor < len(history) and history[cursor].role == "tool":
            tool_call_id = history[cursor].tool_call_id
            if tool_call_id is not None:
                returned.add(tool_call_id)
            cursor += 1

        for call in message.tool_calls:
            if call.id in returned or _is_compacted_arguments(call.arguments):
                continue
            content = _tool_receipt(session, message, call, registry, ledger)
            restored.append(
                Message(
                    role="tool",
                    content=content,
                    tool_call_id=call.id,
                    tool_name=call.name,
                )
            )
            recovered += 1

    if recovered:
        session.replace_history(restored, session.epoch)
    return recovered
