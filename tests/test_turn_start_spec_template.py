"""Tests for spec-template related turn-start field changes."""
from __future__ import annotations

import json
import pytest


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
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


def test_turn_start_returns_project_memory_field(project):
    """turn_start must return 'project_memory', not 'worldview_project'."""
    memory = "# 项目记忆\n\n## 世界观与设计语言\n三国麻将游戏\n"
    _setup_stage_d(project, memory)

    from character_workflow.lib.turn_start import turn_start
    result = turn_start("portrait", None)

    assert "project_memory" in result, "'project_memory' key must be present"
    assert "worldview_project" not in result, "'worldview_project' must be removed"


def test_project_memory_reads_full_memory_md(project):
    """project_memory should contain the full text of project MEMORY.md."""
    memory = "# 项目记忆\n\n## 世界观与设计语言\n精灵收集游戏\n\n## 项目规则\n品质皮肤系统规则\n"
    _setup_stage_d(project, memory)

    from character_workflow.lib.turn_start import turn_start
    result = turn_start("portrait", None)

    assert "精灵收集游戏" in result["project_memory"]
    assert "品质皮肤系统规则" in result["project_memory"]


def test_project_memory_empty_when_no_memory_file(project):
    """project_memory should be empty string when project MEMORY.md doesn't exist."""
    _setup_stage_d(project, memory_content="")

    from character_workflow.lib.turn_start import turn_start
    result = turn_start("portrait", None)

    assert result["project_memory"] == ""


def test_worldview_workspace_removed(project):
    """worldview_workspace field must be removed from turn_start return."""
    _setup_stage_d(project)

    from character_workflow.lib.turn_start import turn_start
    result = turn_start("portrait", None)

    assert "worldview_workspace" not in result
