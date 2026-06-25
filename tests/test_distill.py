# tests/test_distill.py
"""distill: 检测「高分/喜欢且未沉淀」的角色资产图 + 幂等标记已沉。"""
from __future__ import annotations

import json
from pathlib import Path

from character_workflow.lib import data_root, distill


def _runtime() -> Path:
    p = data_root.runtime_dir()
    p.mkdir(parents=True, exist_ok=True)
    return p


def _write(name: str, obj: dict) -> None:
    (_runtime() / name).write_text(json.dumps(obj), encoding="utf-8")


def test_pending_picks_high_rated_character_image():
    _write("gallery-ratings.json", {"ratings": {"characters/c1/portrait/v2.png": 4.5}})
    out = distill.pending_for_character("c1")
    assert [x["path"] for x in out] == ["characters/c1/portrait/v2.png"]
    assert out[0]["rating"] == 4.5
    assert out[0]["kind"] == "portrait"


def test_pending_picks_favorited_even_if_unrated():
    _write("gallery-favorites.json", {"paths": ["characters/c1/promo/v1.png"]})
    out = distill.pending_for_character("c1")
    assert [x["path"] for x in out] == ["characters/c1/promo/v1.png"]
    assert out[0]["kind"] == "promo"


def test_pending_excludes_low_rating_not_favorited():
    _write("gallery-ratings.json", {"ratings": {"characters/c1/portrait/v2.png": 3.5}})
    assert distill.pending_for_character("c1") == []


def test_pending_excludes_other_character_and_non_asset_paths():
    _write("gallery-ratings.json", {"ratings": {
        "characters/c2/portrait/v1.png": 5,        # 别的角色
        "studio/anything/v1.png": 5,               # 非角色资产
        "characters/c1/source/up.png": 5,          # 非 portrait/promo/turnaround 槽
    }})
    assert distill.pending_for_character("c1") == []


def test_pending_excludes_already_distilled():
    _write("gallery-ratings.json", {"ratings": {"characters/c1/portrait/v2.png": 5}})
    _write("gallery-distilled.json", {"distilled": ["characters/c1/portrait/v2.png"]})
    assert distill.pending_for_character("c1") == []


def test_mark_distilled_is_idempotent():
    distill.mark_distilled("characters/c1/portrait/v2.png")
    distill.mark_distilled("characters/c1/portrait/v2.png")
    assert distill.read_distilled() == ["characters/c1/portrait/v2.png"]


def test_threshold_boundary():
    _write("gallery-ratings.json", {"ratings": {
        "characters/c1/portrait/a.png": 4.0,   # 命中
        "characters/c1/portrait/b.png": 3.5,   # 不命中
    }})
    paths = {x["path"] for x in distill.pending_for_character("c1")}
    assert paths == {"characters/c1/portrait/a.png"}
