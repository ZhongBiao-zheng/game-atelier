"""三层 lessons + 项目级 worldview 加载测试。"""
import pytest

from character_workflow.lib import context_loader


@pytest.fixture
def memory_tree(tmp_path, monkeypatch):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))

    (tmp_path / "home" / ".claude").mkdir(parents=True)
    (tmp_path / "home" / ".claude" / "MEMORY.md").write_text(
        "# Global\n## Skills Memory\n### character-workflow\n#### Portrait\n- GLOBAL-P\n#### Promo\n- GLOBAL-PROMO\n#### Turnaround\n",
        encoding="utf-8",
    )
    (tmp_path / "MEMORY.md").write_text(
        "# Workspace\n## character-workflow\n### Portrait\n- WORKSPACE-P\n### Promo\n- WORKSPACE-PROMO\n### Turnaround\n",
        encoding="utf-8",
    )
    (tmp_path / "projects" / "my-game").mkdir(parents=True)
    (tmp_path / "projects" / "my-game" / "MEMORY.md").write_text(
        "# Project\n## character-workflow\n### Portrait\n- PROJECT-P\n### Promo\n### Turnaround\n",
        encoding="utf-8",
    )
    (tmp_path / "projects" / "my-game" / "worldview.md").write_text(
        "PROJECT-WORLDVIEW", encoding="utf-8",
    )
    (tmp_path / "worldview.md").write_text("WORKSPACE-WORLDVIEW", encoding="utf-8")
    return tmp_path


def test_load_lessons_global_portrait(memory_tree):
    text = context_loader.load_lessons_global("portrait")
    assert "GLOBAL-P" in text
    assert "GLOBAL-PROMO" not in text


def test_load_lessons_workspace_portrait(memory_tree):
    text = context_loader.load_lessons_workspace("portrait")
    assert "WORKSPACE-P" in text


def test_load_lessons_project_portrait(memory_tree):
    text = context_loader.load_lessons_project("my-game", "portrait")
    assert "PROJECT-P" in text


def test_load_lessons_project_missing_slug_returns_empty(memory_tree):
    assert context_loader.load_lessons_project("nonexistent", "portrait") == ""


def test_load_lessons_project_none_slug_returns_empty(memory_tree):
    assert context_loader.load_lessons_project(None, "portrait") == ""


def test_load_project_worldview(memory_tree):
    assert context_loader.load_project_worldview("my-game") == "PROJECT-WORLDVIEW"


def test_load_project_worldview_missing(memory_tree):
    assert context_loader.load_project_worldview("nonexistent") == ""


def test_load_lessons_kind_validation():
    with pytest.raises(ValueError):
        context_loader.load_lessons_workspace("invalid-kind")
