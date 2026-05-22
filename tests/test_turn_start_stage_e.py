"""Stage E 兜底 —— active_id 存在但 assignments 里缺失。"""
import json

import pytest


@pytest.fixture
def stage_e_setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("RUNTIME_DIR", str(tmp_path / ".runtime"))
    monkeypatch.setenv("CHARACTERS_DIR", str(tmp_path / "characters"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.chdir(tmp_path)

    (tmp_path / "characters" / "orphan-char").mkdir(parents=True)
    (tmp_path / "characters" / "orphan-char" / "spec.md").write_text("# Orphan\n", encoding="utf-8")

    runtime = tmp_path / ".runtime"
    runtime.mkdir()
    (runtime / "active-character.json").write_text(
        json.dumps({"active_id": "orphan-char", "updated_at": "2026-05-21T10:00:00+00:00"}),
        encoding="utf-8",
    )
    (runtime / "projects.json").write_text(
        json.dumps({
            "projects": [{"id": "p-1", "slug": "test-slug", "name": "Test", "created_at": "2026-05-21T00:00:00+00:00"}],
            "assignments": {},  # orphan-char 不在
        }),
        encoding="utf-8",
    )

    (tmp_path / "MEMORY.md").write_text(
        "# Workspace\n## character-workflow\n### Portrait\n- W1\n### Promo\n### Turnaround\n",
        encoding="utf-8",
    )
    (tmp_path / "home" / ".claude").mkdir(parents=True)
    (tmp_path / "home" / ".claude" / "MEMORY.md").write_text(
        "# Global\n## Skills Memory\n### character-workflow\n#### Portrait\n- G1\n#### Promo\n#### Turnaround\n",
        encoding="utf-8",
    )
    return tmp_path


def test_stage_e_when_orphan_active(stage_e_setup):
    from character_workflow.lib.turn_start import turn_start
    result = turn_start(kind="portrait", message="出图")
    assert result["stage"] == "E"


def test_stage_e_project_slug_is_none(stage_e_setup):
    from character_workflow.lib.turn_start import turn_start
    result = turn_start(kind="portrait", message="出图")
    assert result["project_slug"] is None
    assert result["project_id"] is None


def test_stage_e_recommend_action_is_ask(stage_e_setup):
    from character_workflow.lib.turn_start import turn_start
    result = turn_start(kind="portrait", message="出图")
    assert result["recommend_action"] == "ask"


def test_stage_e_lessons_global_loaded(stage_e_setup):
    from character_workflow.lib.turn_start import turn_start
    result = turn_start(kind="portrait", message="出图")
    assert "G1" in result["lessons_global"]


def test_stage_e_lessons_workspace_loaded(stage_e_setup):
    from character_workflow.lib.turn_start import turn_start
    result = turn_start(kind="portrait", message="出图")
    assert "W1" in result["lessons_workspace"]


def test_stage_e_lessons_project_empty(stage_e_setup):
    from character_workflow.lib.turn_start import turn_start
    result = turn_start(kind="portrait", message="出图")
    assert result["lessons_project"] == ""


def test_stage_e_worldview_project_empty(stage_e_setup):
    from character_workflow.lib.turn_start import turn_start
    result = turn_start(kind="portrait", message="出图")
    assert result["worldview_project"] == ""


def test_stage_d_with_assignment_has_project_slug(stage_e_setup):
    """对照组:把 assignments 补上后,stage 应该走 D 且 project_slug 有值。"""
    runtime = stage_e_setup / ".runtime"
    (runtime / "projects.json").write_text(
        json.dumps({
            "projects": [{"id": "p-1", "slug": "test-slug", "name": "Test", "created_at": "2026-05-21T00:00:00+00:00"}],
            "assignments": {"orphan-char": "p-1"},
        }),
        encoding="utf-8",
    )
    (stage_e_setup / "projects" / "test-slug").mkdir(parents=True)
    (stage_e_setup / "projects" / "test-slug" / "MEMORY.md").write_text(
        "# Proj\n## character-workflow\n### Portrait\n- PROJECT-P\n### Promo\n### Turnaround\n",
        encoding="utf-8",
    )
    (stage_e_setup / "projects" / "test-slug" / "worldview.md").write_text("PWV", encoding="utf-8")

    from character_workflow.lib.turn_start import turn_start
    result = turn_start(kind="portrait", message="出图")
    assert result["stage"] == "D"
    assert result["project_slug"] == "test-slug"
    assert result["project_id"] == "p-1"
    assert result["project_name"] == "Test"
    assert "PROJECT-P" in result["lessons_project"]
    assert result["worldview_project"] == "PWV"
