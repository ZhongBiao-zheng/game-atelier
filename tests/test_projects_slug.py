"""create_project 自动生成 slug + 建项目目录骨架。"""
import pytest

from character_workflow.lib import projects


@pytest.fixture
def isolated_project(tmp_path, monkeypatch):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    monkeypatch.chdir(tmp_path)
    return tmp_path


def test_create_project_auto_slug(isolated_project):
    p = projects.create_project(name="宝可梦风格-精灵游戏")
    # pypinyin 真实输出是带 hyphen 的拼音 + 截断到 32 字符
    # 实测值: "bao-ke-meng-feng-ge-jing-ling-yo"
    assert p.slug.startswith("bao-ke-meng")
    assert len(p.slug) <= 32


def test_create_project_explicit_slug(isolated_project):
    p = projects.create_project(name="任意名字", slug="custom-slug")
    assert p.slug == "custom-slug"


def test_create_project_dedupe_slug(isolated_project):
    projects.create_project(name="测试内容")
    p2 = projects.create_project(name="测试内容")
    assert p2.slug.endswith("-2")


def test_create_project_creates_directory(isolated_project):
    p = projects.create_project(name="Hard Mecha")
    project_dir = isolated_project / "projects" / p.slug
    assert project_dir.is_dir()
    assert (project_dir / "MEMORY.md").exists()
    assert (project_dir / "worldview.md").exists()


def test_create_project_directory_contains_skeleton(isolated_project):
    p = projects.create_project(name="Hard Mecha")
    project_dir = isolated_project / "projects" / p.slug
    memory_text = (project_dir / "MEMORY.md").read_text(encoding="utf-8")
    assert "character-workflow" in memory_text
    assert "Portrait" in memory_text
    assert "Promo" in memory_text
    assert "Turnaround" in memory_text


def test_create_project_explicit_slug_collision_raises(isolated_project):
    projects.create_project(name="X", slug="taken")
    with pytest.raises(ValueError, match="already exists"):
        projects.create_project(name="Y", slug="taken")


def test_create_project_preserves_existing_files(isolated_project):
    """目录或 MEMORY.md 已存在时,create_project 不覆盖。"""
    proj_dir = isolated_project / "projects" / "preserved"
    proj_dir.mkdir(parents=True)
    (proj_dir / "MEMORY.md").write_text("EXISTING CONTENT", encoding="utf-8")
    (proj_dir / "worldview.md").write_text("EXISTING WV", encoding="utf-8")

    projects.create_project(name="X", slug="preserved")

    assert (proj_dir / "MEMORY.md").read_text(encoding="utf-8") == "EXISTING CONTENT"
    assert (proj_dir / "worldview.md").read_text(encoding="utf-8") == "EXISTING WV"
