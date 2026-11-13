"""执行预算：轮次、调用次数、token 三个硬计数器。

对应 TS: src/core/execution-budget.ts
简化点：不包含费用估算、本地任务额度、续期钩子。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ExecutionBudget:
    max_rounds: int = 5
    max_calls: int = 30
    max_tokens: int = 200_000
    rounds: int = 0
    calls: int = 0
    tokens: int = 0

    def exhausted(self) -> bool:
        return (
            self.rounds >= self.max_rounds
            or self.calls >= self.max_calls
            or self.tokens >= self.max_tokens
        )

    def reason(self) -> str:
        if self.rounds >= self.max_rounds:
            return f"工具轮次达到上限 {self.max_rounds}"
        if self.calls >= self.max_calls:
            return f"工具调用达到上限 {self.max_calls}"
        return f"token 估算达到上限 {self.max_tokens}"

    def to_data(self) -> dict[str, int]:
        return {
            "max_rounds": self.max_rounds,
            "max_calls": self.max_calls,
            "max_tokens": self.max_tokens,
            "rounds": self.rounds,
            "calls": self.calls,
            "tokens": self.tokens,
        }
