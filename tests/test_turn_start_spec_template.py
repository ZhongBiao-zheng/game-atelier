"""Tests for spec-template related turn-start field changes."""
from __future__ import annotations

import json
import pytest


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    return tmp_path


def _setup_stage_d(project, memory_content: str = "") -> None:
    """Set up minimal Stage D environment."""
    (project / "characters" / "hero").mkdir(parents=True)
    (project / "characters" / "hero" / "spec.md").write_text(
        "---\nid: hero\nname: 英雄\n---\n\n## identity\n- role: 测试角色\n"
    )
    (project / ".runtime").mkdir()
    (project / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "hero", "updated_at": "2026-05-29T00:00:00+00:00"})
    )
    (project / ".runtime" / "projects.json").write_text(
        json.dumps({
            "projects": [{"id": "p1", "name": "测试项目", "slug": "test-proj", "created_at": "2026-05-29T00:00:00+00:00"}],
            "assignments": {"hero": "p1"},
        })
    )
    (project / "projects" / "test-proj").mkdir(parents=True)
    if memory_content:
        (project / "projects" / "test-proj" / "MEMORY.md").write_text(memory_content)


def test_turn_start_returns_project_worldview_not_project_memory(project):
    """项目级经验改由 project_worldview（worldview.md）承载；project_memory 已移除。"""
    _setup_stage_d(project)

    from character_workflow.lib.turn_start import turn_start
    result = turn_start("portrait", None)

    assert "project_worldview" in result, "'project_worldview' key must be present"
    assert "project_memory" not in result, "'project_memory' must be removed"
    assert "worldview_project" not in result


def test_worldview_workspace_removed(project):
    """worldview_workspace field must be removed from turn_start return."""
    _setup_stage_d(project)

    from character_workflow.lib.turn_start import turn_start
    result = turn_start("portrait", None)

    assert "worldview_workspace" not in result
