import pytest
from pydantic import ValidationError
from character_workflow.lib.schemas import (
    Job, JobStatus, WebEditableJobPatch, SpecPatch, FeedbackPost, ClipboardAttempt,
)


def test_job_status_enum_strict():
    with pytest.raises(ValidationError):
        Job(
            job_id="j-1", character_id="c", prompt="p",
            submitted_at="2026-05-18T10:00:00Z", model="gpt-image-2",
            params={}, output_paths=[], status="not-a-status", error=None,
        )


def test_web_editable_patch_rejects_unknown_field():
    with pytest.raises(ValidationError):
        WebEditableJobPatch(prompt="ok", character_id="hijack")


def test_feedback_post_rejects_empty():
    with pytest.raises(ValidationError):
        FeedbackPost(text="", character_id="shadow")
    with pytest.raises(ValidationError):
        FeedbackPost(text="valid")


def test_clipboard_attempt_success_field_required():
    with pytest.raises(ValidationError):
        ClipboardAttempt(ts="2026-05-18T10:00:00Z")


def test_spec_patch_requires_revision_for_conflict_safe_save():
    patch = SpecPatch(content="# 角色: 暗影刺客\n年龄: 24", expected_revision="a" * 64)
    assert patch.content.startswith("# 角色")
    with pytest.raises(ValidationError):
        SpecPatch(content="不能省略已读取的修订")


_ = JobStatus  # silence unused import


def test_turn_stage_enum_values():
    from character_workflow.lib.schemas import TurnStage
    assert TurnStage.A.value == "A"
    assert TurnStage.B.value == "B"
    assert TurnStage.C.value == "C"
    assert TurnStage.D.value == "D"
    assert TurnStage.E.value == "E"


def test_intent_kind_enum_values():
    from character_workflow.lib.schemas import IntentKind
    assert IntentKind.NEW.value == "new"
    assert IntentKind.REVISE.value == "revise"
    assert IntentKind.CREATE.value == "create"
    assert IntentKind.SWITCH.value == "switch"


def test_turn_start_result_minimal():
    from character_workflow.lib.schemas import (
        RecommendAction, TurnStage, TurnStartResult,
    )
    r = TurnStartResult(
        stage=TurnStage.A,
        stage_reason="characters/ 目录不存在",
        intent=None,
        intent_signal="default",
        intent_conflict=False,
        recommend_action=RecommendAction.ASK,
        recommend_reason="stage A: 前置未齐",
        active_age_minutes=None,
        recent_chars=[],
        drafts=[],
        active_id=None,
        active_updated_at="",
        spec=None,
        pending_identity_normalizations=[],
        project_id=None,
        project_slug=None,
        project_name=None,
        lessons_workspace="",
        lessons_project="",
        lessons_kind="portrait",
    )
    assert r.stage == TurnStage.A
    assert r.intent is None
    assert r.recommend_action == RecommendAction.ASK


def test_turn_start_result_full_stage_d():
    from character_workflow.lib.schemas import (
        IntentKind, RecentCharacter, RecommendAction, TurnStage, TurnStartResult,
    )
    r = TurnStartResult(
        stage=TurnStage.D,
        stage_reason="active 完整且已归属",
        intent=IntentKind.REVISE,
        intent_signal="drafts_present",
        intent_conflict=False,
        recommend_action=RecommendAction.RENDER_CARD,
        recommend_reason="revise: drafts 中有 1 条反馈",
        active_age_minutes=10,
        recent_chars=[RecentCharacter(id="holy", tagline="治愈系祭祀")],
        drafts=[{"path": "holy-1.md", "text": "调色"}],
        active_id="holy",
        active_updated_at="2026-05-19T08:00:00+00:00",
        spec="# 圣灵祭祀\n",
        pending_identity_normalizations=[],
        project_id="p-1",
        project_slug="test-proj",
        project_name="Test",
        lessons_workspace="- 2026-05-19 holy",
        lessons_project="",
        lessons_kind="portrait",
    )
    assert r.intent == IntentKind.REVISE
    assert r.recent_chars[0].id == "holy"
    assert r.recommend_action == RecommendAction.RENDER_CARD


def test_recommend_action_enum_values():
    from character_workflow.lib.schemas import RecommendAction
    assert RecommendAction.RENDER_CARD.value == "render_card"
    assert RecommendAction.ASK.value == "ask"
    assert RecommendAction.SWITCH.value == "switch"
    assert RecommendAction.NOOP.value == "noop"


def test_project_has_slug_field():
    from character_workflow.lib.schemas import Project
    p = Project(id="p-x", slug="my-game", name="名字", created_at="2026-05-21T00:00:00+00:00")
    assert p.slug == "my-game"


def test_project_slug_required():
    import pytest
    from pydantic import ValidationError
    from character_workflow.lib.schemas import Project
    with pytest.raises(ValidationError):
        Project(id="p-x", name="名字", created_at="2026-05-21T00:00:00+00:00")
