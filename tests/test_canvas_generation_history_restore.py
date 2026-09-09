"""Editable input connections never own immutable generated history."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from character_workflow.lib.canvas_projects import (
    CanvasDocumentError, _normalized_web_document, create_canvas_project,
)
from character_workflow.lib.schemas import CanvasInputConnection, CanvasDocument, CanvasPluginNodeData


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


def test_input_changes_do_not_modify_generated_content_history():
    current = _document(create_canvas_project("输入历史").project_id)
    edge = CanvasInputConnection(
        id="connection-input", role="input", source_node_id="source", target_node_id="target",
    )
    submitted = current.model_copy(update={"connections": [edge]})
    connected = _normalized_web_document(current, submitted, _NOW)
    assert connected.connections == [edge]
    assert connected.content_versions == current.content_versions
    removed = _normalized_web_document(
        connected, connected.model_copy(update={"connections": []}), _NOW,
    )
    assert removed.connections == []
    assert removed.content_versions == current.content_versions


def test_input_edit_cannot_rewrite_generated_version_origin():
    current = _document(create_canvas_project("输入历史").project_id)
    versions = dict(current.content_versions)
    versions[_VERSION_ID] = versions[_VERSION_ID].model_copy(update={"text": "forged"})
    with pytest.raises(CanvasDocumentError, match="历史版本"):
        _normalized_web_document(
            current, current.model_copy(update={"content_versions": versions}), _NOW,
        )


def test_active_canvas_schema_rejects_non_input_connections():
    raw = _document().model_dump(mode="json")
    raw["connections"] = [{
        "id": "old-edge", "role": "derivation", "source_node_id": "source",
        "target_node_id": "target", "origin": {"kind": "generation_run", "run_id": _RUN_ID},
    }]
    with pytest.raises(ValidationError):
        CanvasDocument.model_validate(raw)


def test_removing_legacy_draft_defaults_preserves_plugin_payload_limit():
    with pytest.raises(ValidationError, match="256 KiB"):
        CanvasPluginNodeData(
            plugin_id="qa", node_type="qa", plugin_version="1", data_schema_version=1,
            payload={"text": "a" * (256 * 1024)},
        )
