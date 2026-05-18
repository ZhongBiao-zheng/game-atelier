import pytest
from pydantic import ValidationError
from skill.character_workflow.lib.schemas import (
    Job, JobStatus, WebEditableJobPatch, SpecPatch, FeedbackPost, ClipboardAttempt,
)


def test_job_status_enum_strict():
    with pytest.raises(ValidationError):
        Job(
            job_id="j-1", character_id="c", prompt="p",
            submitted_at="2026-05-18T10:00:00Z", model="gpt-image-2",
            params={}, seed=None, output_paths=[], status="not-a-status", error=None,
        )


def test_web_editable_patch_rejects_unknown_field():
    with pytest.raises(ValidationError):
        WebEditableJobPatch(prompt="ok", character_id="hijack")


def test_feedback_post_rejects_empty():
    with pytest.raises(ValidationError):
        FeedbackPost(text="")


def test_clipboard_attempt_success_field_required():
    with pytest.raises(ValidationError):
        ClipboardAttempt(ts="2026-05-18T10:00:00Z")


def test_spec_patch_accepts_partial():
    patch = SpecPatch(content="# 角色: 暗影刺客\n年龄: 24")
    assert patch.content.startswith("# 角色")


_ = JobStatus  # silence unused import
