import copy

import pytest
from pydantic import ValidationError

from character_workflow.lib.schemas import CanvasDocument, CanvasImageAnnotation


ELEMENTS = [
    dict(id="rect", type="rect", color="#F04438", x=0, y=0,
         width=100, height=80, stroke_width=4),
    dict(id="arrow", type="arrow", color="#FACC15", start=[0, 0], end=[80, 90], stroke_width=4),
    dict(id="pen", type="freedraw", color="#22C55E", points=[[0, 0], [5, 8]], stroke_width=4),
    dict(id="text", type="text", color="#FFFFFF", x=0, y=0, text="改成红色", font_size=18),
]


def annotation_document():
    versions = {
        key: dict(version_id=key, kind="image", path=f"uploads/{key}.png", mime_type="image/png",
                  bytes=100, width=1024, height=768, sha256="a" * 64,
                  created_at="2026-10-24T00:00:00Z", origin={"kind": "upload", "upload_id": key})
        for key in ["original", "rendered", "other"]
    }
    return dict(project_id="canvas-annotation", updated_at="2026-10-24T00:00:00Z",
                content_versions=versions, nodes=[
                    dict(id="source", type="image", title="原图", position={"x": 0, "y": 0},
                         data=dict(current_version_id="original", annotation=dict(
                             version_id="original", rendered_version_id="rendered", elements=ELEMENTS))),
                    dict(id="target", type="image", title="改图", position={"x": 400, "y": 0},
                         data={}),
                ], connections=[dict(id="input", role="input", source_node_id="source",
                                     target_node_id="target", annotated=True)])


def test_annotation_schema_and_version_switch():
    document = annotation_document()
    document["nodes"][0]["data"]["current_version_id"] = "other"
    parsed = CanvasDocument.model_validate(document)
    assert parsed.nodes[0].data.annotation.visible
    assert len(parsed.nodes[0].data.annotation.elements) == 4
    assert parsed.connections[0].annotated


@pytest.mark.parametrize("index,patch", [
    (0, {"type": "ellipse"}), (0, {"color": "red"}), (0, {"stroke_width": 25}),
    (0, {"width": float("nan")}), (1, {"start": [float("inf"), 0]}),
    (2, {"points": [[0, 0]]}), (3, {"text": ""}), (3, {"font_size": 73}),
])
def test_annotation_rejects_invalid_elements(index, patch):
    element = {**ELEMENTS[index], **patch}
    with pytest.raises(ValidationError):
        CanvasImageAnnotation(version_id="original", elements=[element])


def test_annotation_bounds_scene_size():
    with pytest.raises(ValidationError):
        CanvasImageAnnotation(version_id="original", elements=[ELEMENTS[0]] * 501)
    large = {**ELEMENTS[2], "points": [[12345.6789, 12345.6789]] * 10000}
    with pytest.raises(ValidationError, match="2 MiB"):
        CanvasImageAnnotation(version_id="original", elements=[large] * 10)


@pytest.mark.parametrize("case", ["missing", "rendered_size", "video", "slot", "source_type"])
def test_annotation_document_rejects_invalid_references(case):
    document = copy.deepcopy(annotation_document())
    source = document["nodes"][0]
    if case == "missing":
        source["data"]["annotation"]["version_id"] = "missing"
    elif case == "rendered_size":
        document["content_versions"]["rendered"]["width"] = 50
    elif case == "video":
        source["type"] = "video"
        source["data"]["current_version_id"] = None
    elif case == "slot":
        document["connections"][0]["slot"] = "first_frame"
    else:
        source["type"] = "text"
        source["data"] = {}
    with pytest.raises(ValidationError):
        CanvasDocument.model_validate(document)
