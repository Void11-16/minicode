"""受控操作账本：先记录意图，再提交，再核对结果。

对应 TS: src/storage/managed-operation.ts、src/core/execution-state.ts
本移植只处理两种效果：
- replace: 覆盖写单个文件（write_file 演示）
- command: 任意命令（只记录事实，中断后不重放）

关键原则：
- 执行状态（succeeded/failed/cancelled）与副作用状态（none/not_committed/
  committed/unknown）分开
- 进程中断后，不自动重放未知副作用
- 通过 before/after 哈希核对主文件是否已经提交
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _hash_file(path: str | None) -> str | None:
    if path is None:
        return None
    file = Path(path)
    if not file.exists():
        return None
    return hashlib.sha256(file.read_bytes()).hexdigest()


@dataclass
class ToolExecutionState:
    operation_id: str
    execution_status: str
    effect_status: str
    recovery_action: str = "none"
    code: str | None = None
    message: str | None = None
    replayed: bool = False

    def to_data(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "operation_id": self.operation_id,
            "execution_status": self.execution_status,
            "effect_status": self.effect_status,
            "recovery_action": self.recovery_action,
        }
        if self.code is not None:
            data["code"] = self.code
        if self.message is not None:
            data["message"] = self.message
        if self.replayed:
            data["replayed"] = True
        return data


class OperationLedger:
    def __init__(self, root: str):
        self.root = Path(root).resolve()
        self.directory = self.root / ".minicode-py" / "operations"
        self.directory.mkdir(parents=True, exist_ok=True)

    def _record_path(self, operation_id: str) -> Path:
        return self.directory / f"{_digest(operation_id)}.json"

    def _read(self, operation_id: str) -> dict[str, Any] | None:
        path = self._record_path(operation_id)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def _write(self, record: dict[str, Any]) -> None:
        path = self._record_path(record["operation_id"])
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)

    def begin(
        self,
        operation_id: str,
        tool: str,
        resource: str | None,
        *,
        kind: str = "replace",
    ) -> dict[str, Any]:
        existing = self._read(operation_id)
        if existing is not None and existing["phase"] != "finished":
            return self.reconcile(operation_id) or existing
        before = _hash_file(resource) if kind == "replace" else None
        record = {
            "schema_version": 1,
            "operation_id": operation_id,
            "tool": tool,
            "kind": kind,
            "resource": resource,
            "phase": "running",
            "started_at": time.time(),
            "before_hash": before,
        }
        self._write(record)
        return record

    def commit(self, operation_id: str, output: str, resource: str | None) -> dict[str, Any]:
        record = self._read(operation_id)
        if record is None:
            record = {
                "schema_version": 1,
                "operation_id": operation_id,
                "tool": "unknown",
                "kind": "replace",
                "resource": resource,
                "started_at": time.time(),
                "before_hash": _hash_file(resource),
            }
        record["after_hash"] = _hash_file(resource)
        record["output"] = output
        record["phase"] = "finished"
        record["finished_at"] = time.time()
        record["state"] = ToolExecutionState(
            operation_id=operation_id,
            execution_status="succeeded",
            effect_status="committed",
            recovery_action="none",
        ).to_data()
        self._write(record)
        return record

    def fail(self, operation_id: str, error: str) -> dict[str, Any] | None:
        record = self._read(operation_id)
        if record is None:
            return None
        reconciled = self.reconcile(operation_id) or record
        state = reconciled.get("state")
        if state is None or state.get("effect_status") == "committed":
            state = ToolExecutionState(
                operation_id=operation_id,
                execution_status="failed",
                effect_status="unknown",
                recovery_action="manual_review",
                code="TOOL_EXECUTION_FAILED",
                message=error,
            ).to_data()
        else:
            state["execution_status"] = "failed"
            state["message"] = error
        reconciled["phase"] = "finished"
        reconciled["state"] = state
        self._write(reconciled)
        return reconciled

    def reconcile(self, operation_id: str) -> dict[str, Any] | None:
        record = self._read(operation_id)
        if record is None:
            return None
        if record.get("phase") == "finished" and record.get("state") is not None:
            return record

        if record.get("kind") == "command":
            state = ToolExecutionState(
                operation_id=operation_id,
                execution_status="failed",
                effect_status="unknown",
                recovery_action="manual_review",
                code="COMMAND_INTERRUPTED_UNKNOWN",
            )
        else:
            current = _hash_file(record.get("resource"))
            if record.get("after_hash") is not None and current == record["after_hash"]:
                state = ToolExecutionState(
                    operation_id=operation_id,
                    execution_status="succeeded",
                    effect_status="committed",
                    recovery_action="none",
                )
            elif current == record.get("before_hash"):
                state = ToolExecutionState(
                    operation_id=operation_id,
                    execution_status="failed",
                    effect_status="not_committed",
                    recovery_action="retry",
                    code="OPERATION_INTERRUPTED_NOT_COMMITTED",
                )
            else:
                state = ToolExecutionState(
                    operation_id=operation_id,
                    execution_status="failed",
                    effect_status="unknown",
                    recovery_action="manual_review",
                    code="OPERATION_COMMIT_UNKNOWN",
                )

        record["phase"] = "finished"
        record["finished_at"] = time.time()
        record["state"] = state.to_data()
        self._write(record)
        return record

    def find(self, operation_id: str) -> dict[str, Any] | None:
        return self._read(operation_id)
