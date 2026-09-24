from __future__ import annotations

import pytest
from pydantic import ValidationError

from character_workflow.lib.schemas import (
    CanvasDocument,
    CanvasReproduceRequest,
    CanvasReproduceResponse,
    CreationAssetStalenessBatch,
    CreationAssetStalenessBatchRequest,
    CreationGenerationFromCanvas,
    CreationGenerationFromJob,
    TeamLibraryChangeEvent,
    TeamLibraryIndexEntry,
    TeamShareCanvasResult,
    TeamShareRequest,
)

SHA_A = "a" * 64
SHA_B = "b" * 64


def _entry_payload(**overrides):
    payload = {
        "id": "ta_01J00000000000000000000000",
        "kind": "generation",
        "title": "封面",
        "bytes": 10,
        "relative_path": "ta_01J00000000000000000000000",
        "updated_at": "2026-09-24T00:00:00Z",
        "reproducible": True,
        "status": "ready",
    }
    return {**payload, **overrides}


def test_share_request_parses_canvas_result_source():
    request = TeamShareRequest.model_validate({
        "source": {
            "kind": "canvas_result",
            "canvas_project_id": "cp_1",
            "node_id": "node_1",
            "version_id": "ver_1",
        },
        "title": "画布结果",
    })

    assert isinstance(request.source, TeamShareCanvasResult)
    assert request.source.version_id == "ver_1"


@pytest.mark.parametrize("field", ["canvas_project_id", "node_id", "version_id"])
def test_canvas_result_source_bounds_ids(field):
    base = {"kind": "canvas_result", "canvas_project_id": "p", "node_id": "n", "version_id": "v"}
    with pytest.raises(ValidationError):
        TeamShareCanvasResult.model_validate({**base, field: ""})
    with pytest.raises(ValidationError):
        TeamShareCanvasResult.model_validate({**base, field: "x" * 161})
    with pytest.raises(ValidationError):
        TeamShareCanvasResult.model_validate({**base, "extra": 1})


def test_index_entry_reads_old_cache_without_input_sha256():
    entry = TeamLibraryIndexEntry.model_validate(_entry_payload())

    assert entry.input_sha256 == []


def test_index_entry_keeps_input_sha256_order():
    entry = TeamLibraryIndexEntry.model_validate(_entry_payload(input_sha256=[SHA_B, SHA_A]))

    assert entry.input_sha256 == [SHA_B, SHA_A]


def test_change_event_removed_leaves_display_fields_none():
    event = TeamLibraryChangeEvent(
        library_id="lib_0123456789abcdef", asset_id="ta_x", kind="media",
        author=None, change="removed",
    )

    assert event.model_dump(mode="json") == {
        "library_id": "lib_0123456789abcdef",
        "asset_id": "ta_x",
        "kind": "media",
        "author": None,
        "change": "removed",
        "title": None,
        "status": None,
        "mime_type": None,
    }


def test_change_event_rejects_unknown_change_and_status():
    base = {"library_id": "lib_0123456789abcdef", "asset_id": "ta_x", "kind": "media",
            "author": "阿飙", "change": "added"}
    with pytest.raises(ValidationError):
        TeamLibraryChangeEvent.model_validate({**base, "change": "renamed"})
    with pytest.raises(ValidationError):
        TeamLibraryChangeEvent.model_validate({**base, "status": "broken"})


def test_generation_from_job_bounds_and_forbids_extra():
    ok = CreationGenerationFromJob(job_id="j1", output_index=0, title="封面")
    assert ok.tags == []
    assert ok.project_id is None

    with pytest.raises(ValidationError):
        CreationGenerationFromJob(job_id="j1", output_index=-1, title="封面")
    with pytest.raises(ValidationError):
        CreationGenerationFromJob(job_id="", output_index=0, title="封面")
    with pytest.raises(ValidationError):
        CreationGenerationFromJob(job_id="j" * 161, output_index=0, title="封面")
    with pytest.raises(ValidationError):
        CreationGenerationFromJob(job_id="j1", output_index=0, title="")
    with pytest.raises(ValidationError):
        CreationGenerationFromJob(job_id="j1", output_index=0, title="t" * 121)
    with pytest.raises(ValidationError):
        CreationGenerationFromJob(job_id="j1", output_index=0, title="封面", tags=["t"] * 21)
    with pytest.raises(ValidationError):
        CreationGenerationFromJob.model_validate(
            {"job_id": "j1", "output_index": 0, "title": "封面", "character_id": "x"}
        )


def test_generation_from_canvas_bounds_and_forbids_extra():
    ok = CreationGenerationFromCanvas(
        canvas_project_id="cp", node_id="n", version_id="v", title="封面"
    )
    assert ok.tags == []

    base = {"canvas_project_id": "cp", "node_id": "n", "version_id": "v", "title": "封面"}
    for field in ("canvas_project_id", "node_id", "version_id"):
        with pytest.raises(ValidationError):
            CreationGenerationFromCanvas.model_validate({**base, field: ""})
        with pytest.raises(ValidationError):
            CreationGenerationFromCanvas.model_validate({**base, field: "x" * 161})
    with pytest.raises(ValidationError):
        CreationGenerationFromCanvas.model_validate({**base, "title": "t" * 121})
    with pytest.raises(ValidationError):
        CreationGenerationFromCanvas.model_validate({**base, "tags": ["t"] * 21})
    # project_id 取 canvas_project_id，请求里不收。
    with pytest.raises(ValidationError):
        CreationGenerationFromCanvas.model_validate({**base, "project_id": "cp"})


def test_staleness_batch_request_bounds():
    assert CreationAssetStalenessBatchRequest(asset_ids=["a"]).asset_ids == ["a"]
    assert len(CreationAssetStalenessBatchRequest(asset_ids=["a"] * 200).asset_ids) == 200

    with pytest.raises(ValidationError):
        CreationAssetStalenessBatchRequest(asset_ids=[])
    with pytest.raises(ValidationError):
        CreationAssetStalenessBatchRequest(asset_ids=["a"] * 201)
    with pytest.raises(ValidationError):
        CreationAssetStalenessBatchRequest.model_validate({"asset_ids": ["a"], "extra": 1})


def test_staleness_batch_only_accepts_known_statuses():
    batch = CreationAssetStalenessBatch(statuses={"a": "fresh", "b": "stale",
                                                  "c": "withdrawn", "d": "unknown"})
    assert batch.statuses["b"] == "stale"

    with pytest.raises(ValidationError):
        CreationAssetStalenessBatch(statuses={"a": "expired"})


def test_reproduce_request_defaults_and_forbids_extra():
    request = CanvasReproduceRequest.model_validate({"position": {"x": 10, "y": 20}})
    assert request.position.x == 10
    assert request.alias is None
    assert request.model is None

    with pytest.raises(ValidationError):
        CanvasReproduceRequest.model_validate({})
    with pytest.raises(ValidationError):
        CanvasReproduceRequest.model_validate({"position": {"x": 0, "y": 0}, "extra": 1})


def test_reproduce_response_has_every_insert_response_field_plus_warnings():
    insert_fields = set(CanvasDocument.model_fields)

    assert set(CanvasReproduceResponse.model_fields) == insert_fields | {"warnings"}

    document = CanvasDocument(project_id="cp", updated_at="2026-09-24T00:00:00Z")
    response = CanvasReproduceResponse.model_validate(
        {**document.model_dump(mode="json"), "warnings": ["遮罩参考未带入"]}
    )
    dumped = response.model_dump(mode="json")
    assert {key: dumped[key] for key in insert_fields} == document.model_dump(mode="json")
    assert dumped["warnings"] == ["遮罩参考未带入"]


def test_reproduce_response_warnings_default_empty():
    response = CanvasReproduceResponse(project_id="cp", updated_at="2026-09-24T00:00:00Z")

    assert response.warnings == []
