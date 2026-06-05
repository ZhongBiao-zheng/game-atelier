"""append_memory 三 scope 测试。"""
import pytest

from character_workflow.lib import lessons


@pytest.fixture
def memory_tree(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.chdir(tmp_path)

    (tmp_path / "MEMORY.md").write_text(
        "# Workspace\n## game-atelier\n### Portrait\n### Promo\n### Turnaround\n",
        encoding="utf-8",
    )
    (tmp_path / "projects" / "my-game").mkdir(parents=True)
    (tmp_path / "projects" / "my-game" / "MEMORY.md").write_text(
        "# Project\n## game-atelier\n### Portrait\n### Promo\n### Turnaround\n",
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


def test_append_global_scope_rejected(memory_tree):
    """global 层已移除：scope='global' 视为未知 scope 报错。"""
    with pytest.raises(ValueError, match="unknown scope"):
        lessons.append_memory(kind="portrait", line="- G1", scope="global")


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


def test_append_consecutive_lessons_stay_in_order(memory_tree):
    """同 section 连续 append,两行都在且按顺序。"""
    lessons.append_memory(kind="portrait", line="- A1", scope="workspace")
    lessons.append_memory(kind="portrait", line="- A2", scope="workspace")
    text = (memory_tree / "MEMORY.md").read_text(encoding="utf-8")
    a1_idx = text.index("- A1")
    a2_idx = text.index("- A2")
    promo_idx = text.index("### Promo")
    assert a1_idx < a2_idx < promo_idx


def test_append_creates_file_from_scratch(tmp_path, monkeypatch):
    """目标 MEMORY.md 不存在时,append_memory 从零建文件 + headers。"""
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    monkeypatch.chdir(tmp_path)
    # 不预先建 MEMORY.md
    lessons.append_memory(kind="portrait", line="- FRESH", scope="workspace")
    text = (tmp_path / "MEMORY.md").read_text(encoding="utf-8")
    assert "## game-atelier" in text
    assert "### Portrait" in text
    assert "- FRESH" in text


def test_append_header_collision_in_content(memory_tree):
    """lessons 内容里出现 header 字面,不应误导 _ensure_section 跳过补 header。"""
    # 先把假 header 字符串注入到一个 line 里
    lessons.append_memory(
        kind="portrait",
        line="- 改进 prompt 用 ### Promo 风格 · 备注",
        scope="workspace",
    )
    # 现在 workspace MEMORY.md 已经有 "### Promo" 字串(在 fixture 里就有真 header,但这条 lesson 也含字面)
    # 接着 append 到 promo section
    lessons.append_memory(kind="promo", line="- REAL-PROMO", scope="workspace")
    text = (memory_tree / "MEMORY.md").read_text(encoding="utf-8")
    # 真 ### Promo header 必须只有一个(在 fixture 已写的位置),不能多出假 header
    # count 行匹配的次数
    import re
    real_header_count = len(re.findall(r'^### Promo\s*$', text, re.MULTILINE))
    assert real_header_count == 1, f"expected 1 real '### Promo' header, got {real_header_count}\n---\n{text}"
    assert "- REAL-PROMO" in text
