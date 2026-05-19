"""turn-start v4 — file system stage probe + intent inference.

公共 API：
- detect_stage() → (stage, reason)：探测 file system 走 A/B/C/D 哪条路
- list_recent_chars() → [{"id","tagline"}, ...]：列已有角色 + tagline
- infer_intent(message, drafts, active_id) → (intent, signal, conflict)：stage D 意图推断
- turn_start(kind, message) → dict：编排器，组装 v4 JSON

文件路径走 PROJECT_ROOT / RUNTIME_DIR / CHARACTERS_DIR 三个环境变量，方便测试 monkeypatch。
"""
from __future__ import annotations

import json
import os
from pathlib import Path


def _project_root() -> Path:
    return Path(os.environ.get("PROJECT_ROOT", Path.cwd()))


def _runtime_dir() -> Path:
    return Path(os.environ.get("RUNTIME_DIR", ".runtime"))


def _characters_dir() -> Path:
    return Path(os.environ.get("CHARACTERS_DIR", "characters"))


def detect_stage() -> tuple[str, str]:
    """Return (stage, human-readable reason). Stage values: A/B/C/D."""
    chars = _characters_dir()
    if not chars.exists():
        return "A", "characters/ 目录不存在"
    subs = [p for p in chars.iterdir() if p.is_dir()]
    if not subs:
        return "B", "characters/ 为空"

    active_file = _runtime_dir() / "active-character.json"
    if not active_file.exists():
        return "C", "active-character.json 不存在"

    try:
        data = json.loads(active_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        return "C", f"active-character.json 损坏: {e}"

    active_id = data.get("active_id")
    if not active_id:
        return "C", "active_id 为空"

    char_dir = chars / active_id
    if not char_dir.is_dir():
        return "C", f"active_id={active_id!r} 对应目录不存在"
    if not (char_dir / "spec.md").exists():
        return "C", f"{active_id}/spec.md 不存在"

    return "D", "active 完整"
