"""审批策略：只保留 ask / edits / trust 三种模式的核心判断。

对应 TS: src/service/permission-policy.ts
"""

from __future__ import annotations

from dataclasses import dataclass

from .tools import Tool


@dataclass
class PermissionPolicy:
    mode: str = "edits"

    def requires_confirmation(self, tool: Tool) -> bool:
        if self.mode == "trust":
            return False
        if tool.effect == "query":
            return False
        if tool.effect == "command":
            return True
        if tool.effect == "managed_write":
            return self.mode == "ask"
        if tool.workspace_edit:
            return self.mode == "ask"
        return tool.requires_confirmation
