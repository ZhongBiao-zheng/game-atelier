import pytest
from pydantic import ValidationError

from character_workflow.lib.schemas import CanvasDocument


def _document(source_type="image", target_type="image"):
    return {
        "project_id": "canvas-material", "updated_at": "2026-09-09T00:00:00Z",
        "nodes": [
            {"id": node_id, "type": kind, "title": node_id,
             "position": {"x": 0, "y": 0}, "data": {"current_version_id": None}}
            for node_id, kind in [("source", source_type), ("result", target_type)]
        ],
        "connections": [{"id": "material", "role": "material",
                         "source_node_id": "source", "target_node_id": "result"}],
    }


def test_material_connection_is_distinct_from_an_explicit_input_between_same_images():
    payload = _document()
    payload["connections"].append({"id": "input", "role": "input",
                                   "source_node_id": "source", "target_node_id": "result"})
    document = CanvasDocument.model_validate(payload)
    assert [edge.role for edge in document.connections] == ["material", "input"]


@pytest.mark.parametrize("source_type,target_type", [("text", "image"), ("image", "text")])
def test_processing_material_connections_require_image_endpoints(source_type, target_type):
    with pytest.raises(ValidationError, match="material connections require image nodes"):
        CanvasDocument.model_validate(_document(source_type, target_type))


def test_material_connection_cannot_be_given_a_generation_frame_slot():
    payload = _document()
    payload["connections"][0]["slot"] = "first_frame"
    with pytest.raises(ValidationError, match="Extra inputs"):
        CanvasDocument.model_validate(payload)
