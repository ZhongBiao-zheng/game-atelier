"""turn-start v4 tests — 覆盖设计稿 §8 全部 10 个验收场景。"""
from __future__ import annotations

import json

import pytest


@pytest.fixture
def project(tmp_path, monkeypatch):
    """搭一个干净的项目根 + .runtime + characters。"""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("RUNTIME_DIR", str(tmp_path / ".runtime"))
    monkeypatch.setenv("CHARACTERS_DIR", str(tmp_path / "characters"))
    return tmp_path


def test_stage_a_no_characters_dir(project):
    from skill.character_workflow.lib.turn_start import detect_stage
    stage, reason = detect_stage()
    assert stage == "A"
    assert "characters" in reason


def test_stage_b_empty_characters_dir(project):
    (project / "characters").mkdir()
    from skill.character_workflow.lib.turn_start import detect_stage
    stage, reason = detect_stage()
    assert stage == "B"
    assert "空" in reason or "empty" in reason.lower()


def test_stage_c_active_missing(project):
    (project / "characters" / "holy").mkdir(parents=True)
    (project / "characters" / "holy" / "spec.md").write_text("# 圣灵\n治愈系\n")
    from skill.character_workflow.lib.turn_start import detect_stage
    stage, reason = detect_stage()
    assert stage == "C"


def test_stage_c_active_invalid_id(project):
    (project / "characters" / "holy").mkdir(parents=True)
    (project / "characters" / "holy" / "spec.md").write_text("# 圣灵\n")
    (project / ".runtime").mkdir()
    (project / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "ghost-not-exists", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    from skill.character_workflow.lib.turn_start import detect_stage
    stage, _ = detect_stage()
    assert stage == "C"


def test_stage_c_active_spec_missing(project):
    """active 指向的角色目录在，但 spec.md 不存在 → 视为失效。"""
    (project / "characters" / "holy").mkdir(parents=True)
    (project / ".runtime").mkdir()
    (project / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    from skill.character_workflow.lib.turn_start import detect_stage
    stage, _ = detect_stage()
    assert stage == "C"


def test_stage_d_active_ok(project):
    (project / "characters" / "holy").mkdir(parents=True)
    (project / "characters" / "holy" / "spec.md").write_text("# 圣灵\n")
    (project / ".runtime").mkdir()
    (project / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    from skill.character_workflow.lib.turn_start import detect_stage
    stage, _ = detect_stage()
    assert stage == "D"
