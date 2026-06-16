"""Active character state shared between Skill and Web.
T3: Skill turn 起始读 / 处理角色时写；Web 左栏读取并高亮。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json


@dataclass
class ActiveCharacter:
    active_id: str | None
    updated_at: str


def _runtime_dir() -> Path:
    return data_root.runtime_dir()


def _path() -> Path:
    return _runtime_dir() / "active-character.json"


def read_active() -> ActiveCharacter:
    p = _path()
    if not p.exists():
        return ActiveCharacter(active_id=None, updated_at="")
    data = json.loads(p.read_text(encoding="utf-8"))
    return ActiveCharacter(
        active_id=data.get("active_id"),
        updated_at=data.get("updated_at", ""),
    )


def write_active(active_id: str | None) -> ActiveCharacter:
    p = _path()
    payload = {
        "active_id": active_id,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    atomic_write_json(p, payload)
    return ActiveCharacter(**payload)
