"""Tests for skill.character_workflow.lib.context_loader.

覆盖 plan §11.4 列出的 edge case：文件不存在 / UTF-8 BOM / 空 / 超长 /
未知 kind / 组合接口 / token 告警触发。
"""
import pytest

from skill.character_workflow.lib import context_loader as cl


@pytest.fixture
def project(tmp_path, monkeypatch):
    """切到一个干净的 tmp_path 作为 PROJECT_ROOT。"""
    monkeypatch.setenv("PROJECT_ROOT", str(tmp_path))
    monkeypatch.chdir(tmp_path)
    return tmp_path


@pytest.fixture
def lessons_dir(monkeypatch, tmp_path):
    """把 lessons 也指到 tmp 下，避免污染真实 references/lessons/。"""
    fake_skill_root = tmp_path / "_skill"
    fake_skill_root.mkdir()
    (fake_skill_root / "references" / "lessons").mkdir(parents=True)
    monkeypatch.setattr(cl, "_skill_root", lambda: fake_skill_root)
    return fake_skill_root / "references" / "lessons"


# ── load_worldview ───────────────────────────────────────────────────

def test_load_worldview_missing_returns_empty(project, capsys):
    assert cl.load_worldview() == ""
    err = capsys.readouterr().err
    assert "worldview.md missing" in err


def test_load_worldview_reads_utf8(project, capsys):
    (project / "worldview.md").write_text("游戏世界观：东方仙侠", encoding="utf-8")
    text = cl.load_worldview()
    assert "东方仙侠" in text
    err = capsys.readouterr().err
    assert "chars" in err


def test_load_worldview_strips_utf8_bom(project):
    (project / "worldview.md").write_bytes("﻿正文".encode("utf-8"))
    text = cl.load_worldview()
    assert text == "正文"
    assert not text.startswith("﻿")


def test_load_worldview_warns_on_soft_limit(project, capsys):
    big = "字" * (cl.WORLDVIEW_SOFT_LIMIT_CHARS + 100)
    (project / "worldview.md").write_text(big, encoding="utf-8")
    cl.load_worldview()
    err = capsys.readouterr().err
    assert "exceeds soft limit" in err


# ── load_lessons ─────────────────────────────────────────────────────

def test_load_lessons_unknown_kind_raises(project, lessons_dir):
    with pytest.raises(ValueError, match="unknown lessons kind"):
        cl.load_lessons("video")


def test_load_lessons_missing_returns_empty(project, lessons_dir):
    assert cl.load_lessons("portrait") == ""


def test_load_lessons_reads_entries(project, lessons_dir, capsys):
    body = "# header\n\n- 2026-05-19 holy · 金白配色 · prompt：`金白祭祀袍`\n- 2026-05-19 holy · 兜帽阴影 · prompt：`兜帽低垂`\n"
    (lessons_dir / "portrait.md").write_text(body, encoding="utf-8")
    text = cl.load_lessons("portrait")
    assert "金白配色" in text
    err = capsys.readouterr().err
    assert "2 entries" in err


def test_load_lessons_warns_on_entry_overflow(project, lessons_dir, capsys):
    lines = "\n".join(f"- 2026-05-19 c · note {i} · prompt：`x`" for i in range(cl.LESSONS_SOFT_LIMIT_ENTRIES + 5))
    (lessons_dir / "portrait.md").write_text(lines, encoding="utf-8")
    cl.load_lessons("portrait")
    err = capsys.readouterr().err
    assert "exceeds soft limit" in err


# ── load_spec ────────────────────────────────────────────────────────

def test_load_spec_reads_from_nested_dir(project):
    chars = project / "characters" / "holy"
    chars.mkdir(parents=True)
    (chars / "spec.md").write_text("# 圣灵", encoding="utf-8")
    text = cl.load_spec("holy")
    assert "圣灵" in text


def test_load_spec_missing_raises(project):
    with pytest.raises(FileNotFoundError):
        cl.load_spec("nope")


def test_load_spec_empty_id_returns_empty_str(project):
    assert cl.load_spec("") == ""


# ── load_character_context ───────────────────────────────────────────

def test_load_character_context_combines_three(project, lessons_dir):
    (project / "worldview.md").write_text("世界观", encoding="utf-8")
    (lessons_dir / "portrait.md").write_text("- a · b · `c`", encoding="utf-8")
    chars = project / "characters" / "holy"
    chars.mkdir(parents=True)
    (chars / "spec.md").write_text("# 圣灵", encoding="utf-8")

    ctx = cl.load_character_context("holy", "portrait")
    assert ctx["worldview"] == "世界观"
    assert "a · b" in ctx["lessons"]
    assert "圣灵" in ctx["spec"]
    assert ctx["character_id"] == "holy"
