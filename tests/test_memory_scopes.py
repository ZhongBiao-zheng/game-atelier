"""append_memory 三 scope 测试。"""
import pytest

from skill.character_workflow.lib import lessons


@pytest.fixture
def memory_tree(tmp_path, monkeypatch):
    monkeypatch.setenv("PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.chdir(tmp_path)

    (tmp_path / "home" / ".claude").mkdir(parents=True)
    (tmp_path / "home" / ".claude" / "MEMORY.md").write_text(
        "# Global\n## Skills Memory\n### character-workflow\n#### Portrait\n#### Promo\n#### Turnaround\n",
        encoding="utf-8",
    )
    (tmp_path / "MEMORY.md").write_text(
        "# Workspace\n## character-workflow\n### Portrait\n### Promo\n### Turnaround\n",
        encoding="utf-8",
    )
    (tmp_path / "projects" / "my-game").mkdir(parents=True)
    (tmp_path / "projects" / "my-game" / "MEMORY.md").write_text(
        "# Project\n## character-workflow\n### Portrait\n### Promo\n### Turnaround\n",
        encoding="utf-8",
    )
    return tmp_path


def test_append_workspace_portrait(memory_tree):
    lessons.append_memory(kind="portrait", line="- W1", scope="workspace")
    text = (memory_tree / "MEMORY.md").read_text(encoding="utf-8")
    assert "- W1" in text
    # 落到 ### Portrait section 下,而不是 ### Promo
    portrait_idx = text.index("### Portrait")
    promo_idx = text.index("### Promo")
    w1_idx = text.index("- W1")
    assert portrait_idx < w1_idx < promo_idx


def test_append_project_portrait(memory_tree):
    lessons.append_memory(kind="portrait", line="- P1", scope="project", project_slug="my-game")
    text = (memory_tree / "projects" / "my-game" / "MEMORY.md").read_text(encoding="utf-8")
    assert "- P1" in text


def test_append_global_portrait(memory_tree):
    lessons.append_memory(kind="portrait", line="- G1", scope="global")
    text = (memory_tree / "home" / ".claude" / "MEMORY.md").read_text(encoding="utf-8")
    assert "- G1" in text
    # 落到 #### Portrait section(全局是 depth=4)
    portrait_idx = text.index("#### Portrait")
    promo_idx = text.index("#### Promo")
    g1_idx = text.index("- G1")
    assert portrait_idx < g1_idx < promo_idx


def test_append_project_requires_slug(memory_tree):
    with pytest.raises(ValueError, match="project_slug required"):
        lessons.append_memory(kind="portrait", line="- X", scope="project", project_slug=None)


def test_append_invalid_scope(memory_tree):
    with pytest.raises(ValueError, match="unknown scope"):
        lessons.append_memory(kind="portrait", line="- X", scope="invalid")


def test_append_newline_rejected(memory_tree):
    with pytest.raises(ValueError, match="single-line"):
        lessons.append_memory(kind="portrait", line="- a\nb", scope="workspace")


def test_append_lesson_alias_still_works(memory_tree):
    """旧 append_lesson 作 alias,默认 scope=project + 当前 active 解析。"""
    # 这条 alias 测试在 Task 9 把 alias 接好后再验证;此处只确认函数存在
    assert hasattr(lessons, "append_lesson")
