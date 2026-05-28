"""turn-start v4 tests — 覆盖设计稿 §8 全部 10 个验收场景。"""
from __future__ import annotations

import json

import pytest


@pytest.fixture
def project(tmp_path, monkeypatch):
    """搭一个干净的项目根 + .runtime + characters。"""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    return tmp_path


def test_stage_a_no_characters_dir(project):
    from character_workflow.lib.turn_start import detect_stage
    stage, reason = detect_stage()
    assert stage == "A"
    assert "characters" in reason


def test_stage_b_empty_characters_dir(project):
    (project / "characters").mkdir()
    from character_workflow.lib.turn_start import detect_stage
    stage, reason = detect_stage()
    assert stage == "B"
    assert "空" in reason or "empty" in reason.lower()


def test_stage_c_active_missing(project):
    (project / "characters" / "holy").mkdir(parents=True)
    (project / "characters" / "holy" / "spec.md").write_text("# 圣灵\n治愈系\n")
    from character_workflow.lib.turn_start import detect_stage
    stage, reason = detect_stage()
    assert stage == "C"


def test_stage_c_active_invalid_id(project):
    (project / "characters" / "holy").mkdir(parents=True)
    (project / "characters" / "holy" / "spec.md").write_text("# 圣灵\n")
    (project / ".runtime").mkdir()
    (project / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "ghost-not-exists", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    from character_workflow.lib.turn_start import detect_stage
    stage, _ = detect_stage()
    assert stage == "C"


def test_stage_c_active_spec_missing(project):
    """active 指向的角色目录在，但 spec.md 不存在 → 视为失效。"""
    (project / "characters" / "holy").mkdir(parents=True)
    (project / ".runtime").mkdir()
    (project / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    from character_workflow.lib.turn_start import detect_stage
    stage, _ = detect_stage()
    assert stage == "C"


def test_stage_d_active_ok(project):
    (project / "characters" / "holy").mkdir(parents=True)
    (project / "characters" / "holy" / "spec.md").write_text("# 圣灵\n")
    (project / ".runtime").mkdir()
    (project / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    (project / ".runtime" / "projects.json").write_text(
        json.dumps({
            "projects": [{"id": "p-1", "slug": "test-proj", "name": "Test", "created_at": "2026-05-19T00:00:00+00:00"}],
            "assignments": {"holy": "p-1"},
        })
    )
    from character_workflow.lib.turn_start import detect_stage
    stage, _ = detect_stage()
    assert stage == "D"


def test_list_recent_chars_empty(project):
    from character_workflow.lib.turn_start import list_recent_chars
    assert list_recent_chars() == []


def test_list_recent_chars_skips_non_dirs(project):
    chars = project / "characters"
    chars.mkdir()
    (chars / "a-file.txt").write_text("noise")
    from character_workflow.lib.turn_start import list_recent_chars
    assert list_recent_chars() == []


def test_list_recent_chars_extracts_tagline(project):
    chars = project / "characters"
    (chars / "holy").mkdir(parents=True)
    (chars / "holy" / "spec.md").write_text(
        "# 圣灵祭祀\n\n治愈系女性祭祀，金白配色，兜帽低垂遮眼\n## 风格\n..."
    )
    from character_workflow.lib.turn_start import list_recent_chars
    result = list_recent_chars()
    assert len(result) == 1
    assert result[0]["id"] == "holy"
    assert "治愈系" in result[0]["tagline"]
    assert len(result[0]["tagline"]) <= 30


def test_list_recent_chars_no_spec(project):
    chars = project / "characters"
    (chars / "ghost").mkdir(parents=True)
    from character_workflow.lib.turn_start import list_recent_chars
    result = list_recent_chars()
    assert result == [{"id": "ghost", "tagline": ""}]


def test_list_recent_chars_sorted(project):
    chars = project / "characters"
    for name in ("zelda", "alex", "mira"):
        (chars / name).mkdir(parents=True)
        (chars / name / "spec.md").write_text(f"# {name}\n短描述-{name}\n")
    from character_workflow.lib.turn_start import list_recent_chars
    result = list_recent_chars()
    assert [r["id"] for r in result] == ["alex", "mira", "zelda"]


def test_intent_default_no_drafts_no_message():
    from character_workflow.lib.turn_start import infer_intent
    intent, signal, conflict = infer_intent(message=None, drafts=[], active_id="holy")
    assert intent == "new"
    assert signal == "default"
    assert conflict is False


def test_intent_revise_when_drafts_nonempty():
    from character_workflow.lib.turn_start import infer_intent
    intent, signal, conflict = infer_intent(
        message=None,
        drafts=[{"path": "x.md", "text": "调色"}],
        active_id="holy",
    )
    assert intent == "revise"
    assert signal == "drafts_present"
    assert conflict is False


def test_intent_create_when_keyword_in_message():
    from character_workflow.lib.turn_start import infer_intent
    for msg in ("新建一个角色叫光辉骑士", "我想做个新角色", "另一个角色"):
        intent, signal, _ = infer_intent(message=msg, drafts=[], active_id="holy")
        assert intent == "create", f"msg={msg!r}"
        assert signal == "new_keyword"


def test_intent_switch_when_slash_command_different_id():
    from character_workflow.lib.turn_start import infer_intent
    intent, signal, _ = infer_intent(
        message="/character-workflow ghost-knight 继续",
        drafts=[],
        active_id="holy",
    )
    assert intent == "switch"
    assert signal == "switch_keyword"


def test_intent_switch_same_id_falls_back_to_new():
    """/character-workflow holy 但 active 已经是 holy → 不算 switch。"""
    from character_workflow.lib.turn_start import infer_intent
    intent, signal, _ = infer_intent(
        message="/character-workflow holy",
        drafts=[],
        active_id="holy",
    )
    assert intent == "new"
    assert signal == "default"


def test_intent_conflict_drafts_plus_new_keyword():
    from character_workflow.lib.turn_start import infer_intent
    intent, signal, conflict = infer_intent(
        message="新建一个角色",
        drafts=[{"path": "x.md", "text": "改 holy 的色"}],
        active_id="holy",
    )
    assert conflict is True
    assert intent is None


def test_turn_start_stage_a_payload(project):
    from character_workflow.lib.turn_start import turn_start
    r = turn_start(kind="portrait", message=None)
    assert r["stage"] == "A"
    assert r["intent"] is None
    assert r["active_id"] is None
    assert r["spec"] is None
    assert r["recent_chars"] == []


def test_turn_start_stage_b_payload(project):
    (project / "characters").mkdir()
    from character_workflow.lib.turn_start import turn_start
    r = turn_start(kind="portrait", message=None)
    assert r["stage"] == "B"
    assert r["intent"] is None
    assert r["active_id"] is None
    assert r["recent_chars"] == []


def test_turn_start_stage_c_payload(project):
    chars = project / "characters"
    (chars / "holy").mkdir(parents=True)
    (chars / "holy" / "spec.md").write_text("# 圣灵\n治愈系祭祀\n")
    (chars / "alex").mkdir()
    (chars / "alex" / "spec.md").write_text("# 亚历克斯\n剑士定位\n")
    from character_workflow.lib.turn_start import turn_start
    r = turn_start(kind="portrait", message=None)
    assert r["stage"] == "C"
    assert r["intent"] is None
    assert len(r["recent_chars"]) == 2
    ids = sorted(c["id"] for c in r["recent_chars"])
    assert ids == ["alex", "holy"]


def test_turn_start_stage_d_default_new(project):
    chars = project / "characters"
    (chars / "holy").mkdir(parents=True)
    (chars / "holy" / "spec.md").write_text("# 圣灵\n治愈系\n")
    runtime = project / ".runtime"
    runtime.mkdir()
    (runtime / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    (runtime / "projects.json").write_text(
        json.dumps({
            "projects": [{"id": "p-1", "slug": "test-proj", "name": "Test", "created_at": "2026-05-19T00:00:00+00:00"}],
            "assignments": {"holy": "p-1"},
        })
    )
    from character_workflow.lib.turn_start import turn_start
    r = turn_start(kind="portrait", message=None)
    assert r["stage"] == "D"
    assert r["intent"] == "new"
    assert r["intent_signal"] == "default"
    assert r["intent_conflict"] is False
    assert r["active_id"] == "holy"
    assert "圣灵" in r["spec"]


def test_turn_start_stage_d_with_drafts(project):
    chars = project / "characters"
    (chars / "holy").mkdir(parents=True)
    (chars / "holy" / "spec.md").write_text("# 圣灵\n")
    runtime = project / ".runtime"
    runtime.mkdir()
    (runtime / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    (runtime / "projects.json").write_text(
        json.dumps({
            "projects": [{"id": "p-1", "slug": "test-proj", "name": "Test", "created_at": "2026-05-19T00:00:00+00:00"}],
            "assignments": {"holy": "p-1"},
        })
    )
    draft_dir = runtime / "draft"
    draft_dir.mkdir()
    (draft_dir / "holy-2026.md").write_text("color: more golden\n")
    from character_workflow.lib.turn_start import turn_start
    r = turn_start(kind="portrait", message=None)
    assert r["stage"] == "D"
    assert r["intent"] == "revise"
    assert r["intent_signal"] == "drafts_present"


def test_turn_start_stage_d_conflict(project):
    chars = project / "characters"
    (chars / "holy").mkdir(parents=True)
    (chars / "holy" / "spec.md").write_text("# 圣灵\n")
    runtime = project / ".runtime"
    runtime.mkdir()
    (runtime / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    (runtime / "projects.json").write_text(
        json.dumps({
            "projects": [{"id": "p-1", "slug": "test-proj", "name": "Test", "created_at": "2026-05-19T00:00:00+00:00"}],
            "assignments": {"holy": "p-1"},
        })
    )
    draft_dir = runtime / "draft"
    draft_dir.mkdir()
    (draft_dir / "holy-2026.md").write_text("调色\n")
    from character_workflow.lib.turn_start import turn_start
    r = turn_start(kind="portrait", message="新建一个光辉骑士")
    assert r["stage"] == "D"
    assert r["intent"] is None
    assert r["intent_conflict"] is True


def test_turn_start_schema_validates(project):
    """编排器返回的 dict 必须能通过 TurnStartResult Pydantic 校验。"""
    from character_workflow.lib.schemas import TurnStartResult
    from character_workflow.lib.turn_start import turn_start
    r = turn_start(kind="portrait", message=None)
    parsed = TurnStartResult.model_validate(r)
    assert parsed.stage.value == "A"


def test_cli_turn_start_stage_a(project, capsys):
    from character_workflow.__main__ import main
    rc = main(["turn-start"])
    assert rc == 0
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert payload["stage"] == "A"
    assert payload["intent"] is None


def test_cli_turn_start_with_message(project, capsys):
    chars = project / "characters"
    (chars / "holy").mkdir(parents=True)
    (chars / "holy" / "spec.md").write_text("# 圣灵\n")
    runtime = project / ".runtime"
    runtime.mkdir()
    (runtime / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    (runtime / "projects.json").write_text(
        json.dumps({
            "projects": [{"id": "p-1", "slug": "test-proj", "name": "Test", "created_at": "2026-05-19T00:00:00+00:00"}],
            "assignments": {"holy": "p-1"},
        })
    )
    from character_workflow.__main__ import main
    rc = main(["turn-start", "--message", "新建一个光辉骑士"])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["stage"] == "D"
    assert payload["intent"] == "create"
    assert payload["intent_signal"] == "new_keyword"


def test_cli_turn_start_no_message_defaults_to_new(project, capsys):
    chars = project / "characters"
    (chars / "holy").mkdir(parents=True)
    (chars / "holy" / "spec.md").write_text("# 圣灵\n")
    runtime = project / ".runtime"
    runtime.mkdir()
    (runtime / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    (runtime / "projects.json").write_text(
        json.dumps({
            "projects": [{"id": "p-1", "slug": "test-proj", "name": "Test", "created_at": "2026-05-19T00:00:00+00:00"}],
            "assignments": {"holy": "p-1"},
        })
    )
    from character_workflow.__main__ import main
    rc = main(["turn-start"])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["intent"] == "new"
