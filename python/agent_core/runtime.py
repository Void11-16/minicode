"""AgentRuntime: 会话调度、并发隔离与 steer 注入。

对应 TS: src/runtime/runtime.ts、src/runtime/scheduler.ts
保留：
- 不同 session 并发执行
- 同一 session 串行（asyncio.Lock）
- steer 在当前轮的工具边界注入，空闲时等同 queue
- 每轮完整上下文压缩由 Runtime 持有
简化：
- 不做跨进程队列、续期回调、质量评估、消息持久化策略
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from .agent import ChatAgent, RunOptions, TurnAbortedError
from .budget import ExecutionBudget
from .context import ContextEpochManager, Summarizer, simple_summarizer
from .store import SessionStore

STEERED_NOTE = "↪ 已注入当前执行轮"


@dataclass
class AgentRuntime:
    compactor: ContextEpochManager
    store: SessionStore | None = None
    budget_factory: Callable[[], ExecutionBudget] = field(
        default=lambda: ExecutionBudget(max_rounds=30, max_calls=100)
    )
    agents: dict[str, ChatAgent] = field(default_factory=dict)
    locks: dict[str, asyncio.Lock] = field(default_factory=dict)
    steer_buffers: dict[str, list[str]] = field(default_factory=dict)
    active_turns: set[str] = field(default_factory=set)
    on_event: Callable[[str, dict], None] | None = None
    on_permission: Callable[[dict], bool | Awaitable[bool]] | None = None
    on_turn_aborted: Callable[[str], None] | None = None
    followup_leftover_steer: bool = False

    def register_agent(self, session_id: str, agent: ChatAgent) -> None:
        self.agents[session_id] = agent

    def has_active_turn(self, session_id: str) -> bool:
        return session_id in self.active_turns

    def abort_active_turn(self, session_id: str) -> bool:
        if session_id not in self.active_turns:
            return False
        agent = self.agents.get(session_id)
        if agent is None:
            return False
        agent.abort()
        return True

    async def send(self, session_id: str, input_text: str, mode: str = "queue") -> str:
        trimmed = input_text.strip()
        if not trimmed:
            raise ValueError("输入不能为空")

        if mode == "steer" and session_id in self.active_turns:
            self.steer_buffers.setdefault(session_id, []).append(trimmed)
            return STEERED_NOTE

        lock = self.locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            return await self._run_turn(session_id, trimmed)

    async def _run_turn(self, session_id: str, input_text: str) -> str:
        agent = self.agents.get(session_id)
        if agent is None:
            raise KeyError(f"会话 {session_id} 未注册 Agent")

        self.active_turns.add(session_id)
        try:
            options = RunOptions(
                budget=self.budget_factory(),
                on_checkpoint=self._checkpoint(agent),
                on_event=(lambda event: self.on_event(session_id, event)) if self.on_event else None,
                on_permission=self.on_permission,
                take_steered_messages=lambda: self._drain_steered(session_id),
                max_prompt_tokens=self.compactor.max_prompt_tokens,
            )
            reply = await agent.run(input_text, options)
            leftover = self._drain_steered(session_id)
            if leftover and self.followup_leftover_steer:
                asyncio.create_task(self.send(session_id, "\n".join(leftover)))
            return reply
        except TurnAbortedError:
            self._drain_steered(session_id)
            if self.on_turn_aborted is not None:
                self.on_turn_aborted(session_id)
            raise
        finally:
            self.active_turns.discard(session_id)

    def _checkpoint(self, agent: ChatAgent) -> Callable[[], None]:
        def checkpoint() -> None:
            if self.store is not None:
                self.store.save(agent.session)
        return checkpoint

    def _drain_steered(self, session_id: str) -> list[str]:
        buffer = self.steer_buffers.get(session_id)
        if not buffer:
            return []
        drained = list(buffer)
        buffer.clear()
        return drained


def create_runtime(
    *,
    summarize: Summarizer | None = None,
    max_prompt_tokens: int = 24_000,
    keep_recent: int = 8,
    store: SessionStore | None = None,
) -> AgentRuntime:
    compactor = ContextEpochManager(
        summarize=summarize or simple_summarizer,
        max_prompt_tokens=max_prompt_tokens,
        keep_recent=keep_recent,
    )
    return AgentRuntime(compactor=compactor, store=store)
