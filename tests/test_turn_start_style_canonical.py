"""A1/A2 turn-start 新字段：project_style + canonical。"""
import json

import pytest

from character_workflow.lib.schemas import TurnStartResult
from character_workflow.lib.turn_start import turn_start

STYLE = """---
project: test-slug
status: approved
updated: 2026-08-10
---

## style
- render: 卡通
"""


@pytest.fixture
def stage_d(isolated_data_root):
    root = isolated_data_root
    char = root / "characters" / "hero"
    (char / "portrait").mkdir(parents=True)
    (char / "spec.md").write_text("# Hero\n\n## visual_dna\n- style: 卡通\n", encoding="utf-8")
    (char / "portrait" / "v1.png").write_bytes(b"png")
    (root / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "hero", "updated_at": "2026-08-10T00:00:00+00:00"}),
        encoding="utf-8",
    )
    (root / ".runtime" / "projects.json").write_text(
        json.dumps({
            "projects": [{"id": "p-1", "slug": "test-slug", "name": "Test",
                          "created_at": "2026-08-10T00:00:00+00:00"}],
            "assignments": {"hero": "p-1"},
        }),
        encoding="utf-8",
    )
    return root


def test_project_style_empty_when_no_contract(stage_d):
    result = turn_start()
    assert result["stage"] == "D"
    assert result["project_style"] == ""


def test_project_style_returns_full_text(stage_d):
    proj = stage_d / "projects" / "test-slug"
    proj.mkdir(parents=True)
    (proj / "style.md").write_text(STYLE, encoding="utf-8")
    result = turn_start()
    assert "status: approved" in result["project_style"]
    assert "render: 卡通" in result["project_style"]


def test_canonical_empty_by_default(stage_d):
    result = turn_start()
    assert result["canonical"] == {"portrait": None, "promo": None, "turnaround": None}


def test_canonical_returns_active_char_entries(stage_d):
    from character_workflow.lib import canonical
    from character_workflow.lib.schemas import AssetSlot
    canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/portrait/v1.png")
    result = turn_start()
    assert result["canonical"]["portrait"]["path"] == "characters/hero/portrait/v1.png"


def test_result_validates_against_schema(stage_d):
    result = turn_start()
    validated = TurnStartResult.model_validate(result)
    assert validated.project_style == ""
    assert validated.canonical["portrait"] is None
