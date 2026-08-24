"""Generation derivation undo/redo may restore only server-proven history."""
from __future__ import annotations

from character_workflow.lib.canvas_projects import _is_proven_generation_history_restore
from character_workflow.lib.jobs import save_job
from character_workflow.lib.schemas import CanvasDerivationConnection, CanvasDocument, Job


_NOW = "2026-08-25T00:00:00+00:00"
_PROJECT_ID = "canvas-proof-test"
_JOB_ID = "job-proof-test"
_RUN_ID = "run-proof-test"
_VERSION_ID = "version-proof-test"
_CANDIDATE_ID = "candidate-proof-test"


def _document(project_id: str = _PROJECT_ID) -> CanvasDocument:
    return CanvasDocument.model_validate({
        "project_id": project_id,
        "revision": 3,
        "updated_at": _NOW,
        "nodes": [
            {
                "id": "source",
                "title": "Source",
                "type": "text",
                "position": {"x": 0, "y": 0},
                "data": {
                    "current_version_id": None,
                    "generation_draft": None,
                    "active_run_id": None,
                },
            },
            {
                "id": "forged-source",
                "title": "Forged source",
                "type": "text",
                "position": {"x": 0, "y": 200},
                "data": {
                    "current_version_id": None,
                    "generation_draft": None,
                    "active_run_id": None,
                },
            },
            {
                "id": "target",
                "title": "Target",
                "type": "text",
                "position": {"x": 400, "y": 0},
                "data": {
                    "current_version_id": _VERSION_ID,
                    "generation_draft": None,
                    "active_run_id": None,
                },
            },
        ],
        "content_versions": {
            _VERSION_ID: {
                "version_id": _VERSION_ID,
                "kind": "text",
                "text": "generated",
                "created_at": _NOW,
                "sha256": "0" * 64,
                "origin": {
                    "kind": "job_output",
                    "job_id": _JOB_ID,
                    "candidate_id": _CANDIDATE_ID,
                },
            },
        },
    })


def _job(candidate_status: str = "succeeded") -> Job:
    return Job.model_validate({
        "job_id": _JOB_ID,
        "character_id": "canvas",
        "prompt": "generate",
        "submitted_at": _NOW,
        "model": "text-model",
        "params": {},
        "output_paths": [],
        "status": "done",
        "error": None,
        "asset_slot": "portrait",
        "kind": "text",
        "namespace": "canvas",
        "canvas_project_id": _PROJECT_ID,
        "canvas_run": {
            "run_id": _RUN_ID,
            "result_node_id": "target",
            "snapshot": {
                "surface_node_id": "source",
                "result_node_id": "target",
                "mode": "text",
                "final_prompt": "generate",
                "input_policy": "all_connected",
                "model": "text-model",
                "provider": "openai",
                "normalized_params": {},
                "inputs": [],
                "submitted_at": _NOW,
                "submitted_by": {"kind": "user"},
                "request_fingerprint": "a" * 64,
            },
            "candidates": [{
                "candidate_id": _CANDIDATE_ID,
                "index": 0,
                "status": candidate_status,
                "version_id": _VERSION_ID,
            }],
        },
    })


def _edge(source_node_id: str = "source") -> CanvasDerivationConnection:
    return CanvasDerivationConnection(
        id="connection-proof-test",
        role="derivation",
        source_node_id=source_node_id,
        target_node_id="target",
        origin={"kind": "generation_run", "run_id": _RUN_ID},
    )


def test_generation_history_restore_requires_matching_successful_candidate():
    current = _document()
    submitted = current.model_copy(update={"connections": [_edge()]})

    save_job(_job())
    assert _is_proven_generation_history_restore(current, submitted, _edge())

    save_job(_job("failed"))
    assert not _is_proven_generation_history_restore(current, submitted, _edge())


def test_generation_history_restore_rejects_forged_source_and_cross_project():
    save_job(_job())
    current = _document()
    submitted = current.model_copy(update={"connections": [_edge()]})

    assert not _is_proven_generation_history_restore(
        current,
        submitted,
        _edge("forged-source"),
    )

    other_project = _document("canvas-other-project")
    other_submission = other_project.model_copy(update={"connections": [_edge()]})
    assert not _is_proven_generation_history_restore(
        other_project,
        other_submission,
        _edge(),
    )
