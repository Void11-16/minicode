"""SessionStore: 原子写入与恢复。

对应 TS: src/storage/session-store.ts
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from .session import Session


class SessionStore:
    def __init__(self, root: str):
        self.root = Path(root).resolve()
        self.sessions_dir = self.root / "sessions"
        self.sessions_dir.mkdir(parents=True, exist_ok=True)

    def save(self, session: Session) -> Path:
        path = self.sessions_dir / f"{self._safe(session.id)}.json"
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(session.to_data(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(tmp, path)
        return path

    def load(self, session_id: str) -> Session:
        path = self.sessions_dir / f"{self._safe(session_id)}.json"
        return Session.from_data(json.loads(path.read_text(encoding="utf-8")))

    @staticmethod
    def _safe(value: str) -> str:
        safe = re.sub(r"[^A-Za-z0-9_-]+", "_", value).strip("_")[:100]
        return safe or "session"
