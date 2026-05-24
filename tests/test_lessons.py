"""Legacy append_lesson tests — superseded by test_memory_scopes.py."""
import pytest

pytest.skip(
    "legacy append_lesson tests — superseded by test_memory_scopes.py",
    allow_module_level=True,
)

from character_workflow.lib import lessons  # noqa: E402


@pytest.fixture
def lessons_dir(tmp_path, monkeypatch):
    fake_skill_root = tmp_path / "_skill"
    fake_skill_root.mkdir()
    monkeypatch.setattr(
        lessons, "_lessons_path",
        lambda kind: fake_skill_root / "references" / "lessons" / f"{kind}.md",
    )
    return fake_skill_root / "references" / "lessons"


def test_append_creates_file_on_first_write(lessons_dir):
    path = lessons.append_lesson("portrait", "- 2026-05-19 holy · 金白 · prompt：`x`")
    assert path.exists()
    assert path.read_text(encoding="utf-8") == "- 2026-05-19 holy · 金白 · prompt：`x`\n"


def test_append_two_lessons_keeps_order(lessons_dir):
    lessons.append_lesson("portrait", "- a")
    lessons.append_lesson("portrait", "- b")
    path = lessons._lessons_path("portrait")
    assert path.read_text(encoding="utf-8") == "- a\n- b\n"


def test_append_rejects_newline_in_line(lessons_dir):
    with pytest.raises(ValueError, match="single-line"):
        lessons.append_lesson("portrait", "- a\n- b")


def test_append_rejects_oversized_line(lessons_dir):
    huge = "- " + "x" * 5000
    with pytest.raises(ValueError, match="too long"):
        lessons.append_lesson("portrait", huge)


def test_append_unknown_kind_raises():
    with pytest.raises(ValueError, match="unknown lessons kind"):
        # Note: we hit the validation in _lessons_path before monkeypatch replaces it.
        # 不走 fixture，因为 monkeypatch 把 _lessons_path 整个替换了，绕过校验。
        from character_workflow.lib import lessons as raw
        raw._lessons_path("video")
