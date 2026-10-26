import pytest
from pydantic import ValidationError
from character_workflow.lib.schemas import (
    Job, JobStatus, WebEditableJobPatch, ClipboardAttempt,
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




def test_clipboard_attempt_success_field_required():
    with pytest.raises(ValidationError):
        ClipboardAttempt(ts="2026-05-18T10:00:00Z")




_ = JobStatus  # silence unused import
