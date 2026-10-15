"""Native editing is tied to the exact output, credential and provider task."""
from types import SimpleNamespace

import pytest
import requests

from character_workflow.lib import canvas_image_edits as edits, keys
from character_workflow.lib.callers import mj_edit, mj_image
from character_workflow.lib.schemas import CanvasImageEditOptions, CanvasJobOutputOrigin
from tests.test_canvas_image_edits import setup_source


@pytest.fixture
def native_source(monkeypatch):
    from character_workflow.lib.canvas_runs import submit_mask_edit_run

    pid, version, doc = setup_source()
    job, _ = submit_mask_edit_run(pid, "source", doc.revision, 1, b"", CanvasImageEditOptions(
        mode="outpaint", source_version_id=version.version_id, width=1536, height=1024, x=256,
    ))
    key = keys.find_by_alias("openai").model_copy(update={"base_url": "https://mj.example/v1"})
    monkeypatch.setattr(keys, "find_by_alias", lambda _: key)
    job.model = "midjourney"
    job.params.mj_outputs = [{"task_id": "original-task", "image_index": 2, "single": False,
                              "sha256": version.sha256, "channel": mj_image.channel_fingerprint(key)}]
    source = version.model_copy(update={"origin": CanvasJobOutputOrigin(
        kind="job_output", job_id=job.job_id, candidate_id=job.canvas_run.candidates[0].candidate_id,
    )})
    monkeypatch.setattr(edits, "read_job", lambda _: job)
    return source, job, key


def test_native_source_preserves_exact_task_and_output(native_source):
    source, job, _ = native_source
    assert edits.mj_source(source) == {**job.params.mj_outputs[0], "alias": "openai", "model": "midjourney"}


@pytest.mark.parametrize("invalid", ["sha", "candidate", "outputs", "alias", "run", "key", "channel", "base_url"])
def test_native_source_rejects_changed_or_missing_affinity(native_source, monkeypatch, invalid):
    source, job, key = native_source
    if invalid == "sha":
        source = source.model_copy(update={"sha256": "changed"})
    elif invalid == "candidate":
        source.origin.candidate_id = "another-candidate"
    elif invalid == "outputs":
        job.params.mj_outputs = []
    elif invalid == "alias":
        job.alias = None
    elif invalid == "run":
        job.canvas_run = None
    elif invalid == "key":
        monkeypatch.setattr(keys, "find_by_alias", lambda _: None)
    elif invalid == "channel":
        key.access_key = "rotated-test-key"
    else:
        key.base_url = "invalid"
    assert edits.mj_source(source) is None


def test_native_source_rejects_deleted_job_and_uploaded_image(native_source, monkeypatch):
    source, _, _ = native_source
    def missing(_):
        raise FileNotFoundError("deleted")
    monkeypatch.setattr(edits, "read_job", missing)
    assert edits.mj_source(source) is None
    _, uploaded, _ = setup_source()
    assert edits.mj_source(uploaded) is None


@pytest.mark.parametrize("state", ["success", "expired", "network", "uploaded"])
def test_editor_capabilities_use_fetched_buttons_or_show_unavailability(monkeypatch, state):
    pid, version, _ = setup_source()
    source = {"alias": "mj", "model": "midjourney", "task_id": "task", "image_index": 2, "single": False}
    monkeypatch.setattr(edits, "mj_source", lambda _: None if state == "uploaded" else source)
    action = "MJ::JOB::upsample::2::task"
    calls = []
    def fetch(alias, task):
        calls.append((alias, task))
        if state == "network":
            raise requests.ConnectionError("offline")
        return {"status": "SUCCESS" if state == "success" else "FAILURE", "buttons": [
            {"customId": action, "label": "U2"}, {"customId": "MJ::JOB::upsample::1::task", "label": "U1"},
        ]}
    monkeypatch.setattr(mj_edit, "fetch_task", fetch)
    result = edits.editing_source(pid, "source")
    assert result["source_version_id"] == version.version_id
    if state == "success":
        assert result["mj"]["actions"] == [{"custom_id": action, "kind": "prepare", "label": "准备单图 U2"}]
        assert result["reason"] is None
    else:
        assert result["mj"] is None
        assert result["reason"] == {"network": "offline", "expired": "原 MJ 任务已不可用", "uploaded": None}[state]
    assert calls == ([] if state == "uploaded" else [("mj", "task")])
    with pytest.raises(ValueError, match="请选择已有图片"):
        edits.editing_source(pid, "missing-node")


def test_ratio_only_edit_sizes_reject_unsupported_geometry(monkeypatch):
    from character_workflow.lib import image_size_catalog

    key = SimpleNamespace(provider="openrouter", base_url="https://openrouter.ai/api/v1")
    assert edits.edit_size_params(key, "google/gemini-3-pro-image-preview", 2100, 900)["ratio"] == "21:9"
    with pytest.raises(ValueError, match="不支持这个画框比例"):
        edits.edit_size_params(key, "google/gemini-3-pro-image-preview", 100, 500)
    monkeypatch.setattr(image_size_catalog, "image_size_options", lambda *_: {"ratios": []})
    with pytest.raises(ValueError, match="未声明"):
        edits.edit_size_params(key, "google/gemini-3-pro-image-preview", 100, 100)


def test_edit_sizes_reject_provider_normalization_that_changes_ratio(monkeypatch):
    from character_workflow.lib import image_size

    key = SimpleNamespace(provider="openai")
    monkeypatch.setattr(image_size, "normalize_image_size_params", lambda *_: {"size": "1024x1024"})
    with pytest.raises(ValueError, match="无法匹配"):
        edits.edit_size_params(key, "gpt-image-1", 1536, 1024)


@pytest.mark.parametrize("model,options,state,ids,uncertain,expected", [
    ("gpt-image-1", {}, {}, ["id"], False, False),
    ("midjourney", {}, {}, ["id"], False, True),
    ("midjourney", {}, {}, ["id"], True, False),
    ("midjourney", {"mode": "inpaint"}, {"task_id": "id"}, [], False, True),
    ("midjourney", {"mode": "inpaint"}, {"task_id": "id", "uncertain": True}, [], False, False),
])
def test_resumability_requires_a_known_confirmed_mj_order(model, options, state, ids, uncertain, expected):
    params = SimpleNamespace(image_edit=options, mj_edit_state=state, mj_submission_ids=ids, mj_submit_uncertain=uncertain)
    assert edits.has_resumable_mj_task(SimpleNamespace(model=model, provider="custom", params=params)) is expected
