# src/character_workflow/lib/distill.py
"""沉淀检测——哪些高分/喜欢的角色资产图还没沉淀过出图经验。

判定（v1 只角色资产图）：path 形如 characters/<character_id>/{portrait,promo,turnaround}/...
  且 (favorited 或 rating >= DISTILL_RATING_THRESHOLD)
  且 path 不在 gallery-distilled.json。

读 routes.py 写的 sidecar（data_root 相对路径键）：gallery-ratings.json / gallery-favorites.json。
gallery-distilled.json 由本 lib 读写。全部锚定 data_root.runtime_dir()。
"""
from __future__ import annotations

import json
from pathlib import Path

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json

DISTILL_RATING_THRESHOLD = 4.0
_KIND_SEGMENTS = ("portrait", "promo", "turnaround")


def _ratings_file() -> Path:
    return data_root.runtime_dir() / "gallery-ratings.json"


def _favorites_file() -> Path:
    return data_root.runtime_dir() / "gallery-favorites.json"


def _distilled_file() -> Path:
    return data_root.runtime_dir() / "gallery-distilled.json"


def _read_paths(p: Path, key: str) -> list[str]:
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    v = data.get(key) if isinstance(data, dict) else None
    return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []


def _read_ratings() -> dict[str, float]:
    p = _ratings_file()
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    ratings = data.get("ratings") if isinstance(data, dict) else None
    if not isinstance(ratings, dict):
        return {}
    out: dict[str, float] = {}
    for k, val in ratings.items():
        if isinstance(k, str) and isinstance(val, (int, float)) and 0 < float(val) <= 5:
            out[k] = float(val)
    return out


def read_distilled() -> list[str]:
    return _read_paths(_distilled_file(), "distilled")


def mark_distilled(path: str) -> None:
    """把 path 加入 gallery-distilled.json（幂等）。沉淀确认或画师忽略时调。"""
    current = read_distilled()
    if path in current:
        return
    current.append(path)
    atomic_write_json(_distilled_file(), {"distilled": current})


def _kind_of(path: str, character_id: str) -> str | None:
    """path = characters/<id>/<slot>/<file> → 返回 slot；不属该角色 / 非资产槽 → None。"""
    parts = Path(path).as_posix().split("/")
    if len(parts) < 4 or parts[0] != "characters" or parts[1] != character_id:
        return None
    return parts[2] if parts[2] in _KIND_SEGMENTS else None


def pending_for_character(character_id: str) -> list[dict]:
    """该角色名下「值得沉淀但还没沉过」的图，按评分降序（同分按路径升序，保证确定性）。每条 {path, rating, kind}。"""
    ratings = _read_ratings()
    favorites = set(_read_paths(_favorites_file(), "paths"))
    distilled = set(read_distilled())
    out: list[dict] = []
    for path in set(ratings) | favorites:
        if path in distilled:
            continue
        kind = _kind_of(path, character_id)
        if kind is None:
            continue
        rating = ratings.get(path, 0.0)
        if not (path in favorites or rating >= DISTILL_RATING_THRESHOLD):
            continue
        out.append({"path": path, "rating": rating, "kind": kind})
    out.sort(key=lambda x: (-x["rating"], x["path"]))
    return out
