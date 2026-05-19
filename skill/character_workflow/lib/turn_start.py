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
import re
from pathlib import Path

# 设计稿 §4.4 关键词清单。本轮写死，后续扩展时再抽到 YAML。
_NEW_KEYWORDS = ("新建", "新角色", "另一个角色")
_SLASH_CMD_RE = re.compile(r"/character-workflow\s+([\w\-]+)")


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


def list_recent_chars(limit: int = 10) -> list[dict]:
    """List existing characters with taglines, sorted alphabetically by id.

    tagline = spec.md 首行非空、非标题 markdown 内容，截断到 30 字。
    spec.md 不存在 → tagline = ""。
    """
    chars = _characters_dir()
    if not chars.exists():
        return []
    out: list[dict] = []
    for sub in sorted(chars.iterdir()):
        if not sub.is_dir():
            continue
        spec = sub / "spec.md"
        tagline = ""
        if spec.exists():
            try:
                text = spec.read_text(encoding="utf-8")
            except OSError:
                text = ""
            for line in text.splitlines():
                stripped = line.strip()
                if not stripped:
                    continue
                if stripped.startswith("#"):
                    continue
                tagline = stripped[:30]
                break
        out.append({"id": sub.name, "tagline": tagline})
    return out[:limit]


def infer_intent(
    message: str | None,
    drafts: list[dict],
    active_id: str | None,
) -> tuple[str | None, str, bool]:
    """Return (intent, signal, conflict).

    设计稿 §4.4 规则：
    - drafts 非空 → revise
    - message 含 "新建/新角色/另一个角色" → create
    - message 含 "/character-workflow <name>" 且 name != active_id → switch
    - 都不匹配 → new（default）

    多信号同时命中 → conflict=True, intent=None。
    """
    signals: list[tuple[str, str]] = []

    if drafts:
        signals.append(("revise", "drafts_present"))

    if message:
        if any(kw in message for kw in _NEW_KEYWORDS):
            signals.append(("create", "new_keyword"))
        m = _SLASH_CMD_RE.search(message)
        if m and m.group(1) != active_id:
            signals.append(("switch", "switch_keyword"))

    if len(signals) > 1:
        return None, "conflict", True
    if signals:
        intent, signal = signals[0]
        return intent, signal, False
    return "new", "default", False
