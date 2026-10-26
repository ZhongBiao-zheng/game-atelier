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


def parsed_document():
    from character_workflow.lib.schemas import CanvasGenerationDraft
    document = CanvasDocument.model_validate(annotation_document())
    document.nodes[1].data.generation_draft = CanvasGenerationDraft(
        mode="image", prompt="按图中标注修改，输出不保留标注。", model="gpt-image-2",
        updated_at=document.updated_at,
    )
    return document


def test_annotated_inputs_use_only_composite_and_direct_connection_wins():
    from character_workflow.lib.canvas_runs import _resolve_inputs
    from character_workflow.lib.schemas import CanvasGroupNode, CanvasInputConnection
    document = parsed_document()
    target = document.nodes[1]
    document.nodes[0].data.annotation.visible = False
    document.nodes.append(CanvasGroupNode.model_validate(dict(
        id="group", type="group", title="分组", position={"x": 0, "y": 0},
        data={"member_node_ids": ["source"]})))
    document.connections.insert(0, CanvasInputConnection(
        id="group-edge", role="input", source_node_id="group", target_node_id="target"))
    inputs = _resolve_inputs(document, target, target.data.generation_draft)
    assert [(item.version_id, item.annotated, item.source) for item in inputs] == [
        ("rendered", True, "input_connection")]
    document.connections[1].annotated = False
    assert _resolve_inputs(document, target, target.data.generation_draft)[0].version_id == "original"


@pytest.mark.parametrize("case,message", [
    ("cleared", "标注已被清除"), ("empty", "标注已被清除"),
    ("switched", "当前版本没有标注"), ("unrendered", "标注图还没生成"),
    ("missing_render", "标注图还没生成"),
])
def test_annotated_input_errors(case, message):
    from character_workflow.lib.canvas_runs import _resolve_inputs
    document = parsed_document()
    source, target = document.nodes
    if case == "cleared":
        source.data.annotation = None
    elif case == "empty":
        source.data.annotation.elements = []
    elif case == "switched":
        source.data.current_version_id = "other"
    elif case == "unrendered":
        source.data.annotation.rendered_version_id = None
    else:
        del document.content_versions["rendered"]
    with pytest.raises(ValueError, match=message):
        _resolve_inputs(document, target, target.data.generation_draft)


def test_annotation_result_connection_inherits_snapshot(monkeypatch):
    from character_workflow.lib import canvas_runs
    from character_workflow.lib.keys import KeySpec, ModelSpec
    from character_workflow.lib.schemas import JobKind, JobParams
    document = parsed_document()
    surface = document.nodes[1]
    draft = surface.data.generation_draft
    inputs = canvas_runs._resolve_inputs(document, surface, draft)
    monkeypatch.setattr(canvas_runs, "_commit_transaction_unlocked", lambda *args, **kwargs: None)
    job, updated = canvas_runs._commit_frozen_run(
        document.project_id, document, surface,
        KeySpec(alias="test", provider="openai", access_key="test", models=[],
                created_at=document.updated_at),
        ModelSpec(name="Image", id="gpt-image-2"), JobKind.IMAGE,
        mode="image", final_prompt=draft.prompt, input_policy=draft.input_policy,
        normalized={}, job_params=JobParams(), inputs=inputs, requested_count=1,
        result_title="生成图片", result_draft=draft, allow_surface_reuse=False,
        transaction_kind="submit", run_id="run-annotation")
    edge = next(edge for edge in updated.connections
                if edge.target_node_id == job.canvas_run.result_node_id)
    assert edge.annotated
    assert job.canvas_run.snapshot.inputs[0].version_id == "rendered"


def saved_annotation():
    from character_workflow.lib.canvas_projects import (
        read_canvas_document, save_canvas_document, save_canvas_upload,
    )
    from tests.test_canvas_paste_routes import _source_canvas, _png
    project_id, _, _, original = _source_canvas()
    document = read_canvas_document(project_id)
    rendered, document, _ = save_canvas_upload(
        project_id, "annotation.png", ".png", _png(), "image", document.revision)
    image = document.nodes[0]
    image.data.annotation = CanvasImageAnnotation(
        version_id=original, rendered_version_id=rendered.version_id, elements=ELEMENTS)
    save_canvas_document(project_id, document, document.revision)
    return project_id, image


def test_annotation_versions_follow_cross_canvas_paste():
    from character_workflow.lib.canvas_paste import paste_nodes_into_canvas
    from character_workflow.lib.canvas_projects import create_canvas_project, resolve_canvas_media
    from character_workflow.lib.schemas import CanvasPasteRequest
    source, image = saved_annotation()
    target = create_canvas_project("标注副本")
    data = image.model_dump(mode="json")
    data["id"] = "pasted"
    payload = CanvasPasteRequest(source_project_id=source, nodes=[data], connections=[])
    copied = paste_nodes_into_canvas(project_id=target.project_id, source_project_id=source,
                                     nodes=payload.nodes, connections=[], document_revision=0)
    annotation = copied.nodes[0].data.annotation
    for field in ("version_id", "rendered_version_id"):
        old, new = getattr(image.data.annotation, field), getattr(annotation, field)
        assert old != new and new in copied.content_versions
        assert resolve_canvas_media(source, old)[0].read_bytes() == resolve_canvas_media(
            target.project_id, new)[0].read_bytes()
    assert copied.nodes[0].data.current_version_id == annotation.version_id


def test_annotation_versions_follow_project_package():
    from character_workflow.lib.canvas_packages import (
        export_canvas_projects, inspect_canvas_package, commit_canvas_package,
    )
    from character_workflow.lib.canvas_projects import read_canvas_document, resolve_canvas_media
    source, image = saved_annotation()
    archive, _ = export_canvas_projects([source])
    imported = commit_canvas_package(inspect_canvas_package(archive).token)[0]
    restored = read_canvas_document(imported.project_id)
    annotation = restored.nodes[0].data.annotation
    assert annotation == image.data.annotation
    for field in ("version_id", "rendered_version_id"):
        version_id = getattr(annotation, field)
        assert resolve_canvas_media(source, version_id)[0].read_bytes() == resolve_canvas_media(
            imported.project_id, version_id)[0].read_bytes()
