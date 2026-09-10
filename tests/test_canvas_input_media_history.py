"""Local-tool material relationships are portable but never generation inputs."""
from io import BytesIO

import pytest
from PIL import Image

from character_workflow.lib import canvas_batches, canvas_runs
from character_workflow.lib.canvas_media_operations import execute_canvas_media_operation
from character_workflow.lib.canvas_packages import (
    commit_canvas_package, export_canvas_projects, inspect_canvas_package,
)
from character_workflow.lib.canvas_projects import (
    canvas_project_dir, create_canvas_project, read_canvas_document,
    save_canvas_document, save_canvas_upload,
)
from character_workflow.lib.keys import KeySpec, KeysDB, ModelSpec, write_keys_db
from character_workflow.lib.schemas import (
    CanvasGenerationDraft, CanvasImageNode, CanvasInputConnection, CanvasMaterialConnection,
    CanvasMediaNodeData, CanvasMediaOperationRequest, CanvasPoint,
)


def _cropped_project(operation=None):
    project = create_canvas_project("显式工具输入")
    document = read_canvas_document(project.project_id)
    stream = BytesIO()
    Image.new("RGB", (40, 40), "red").save(stream, format="PNG")
    version, document, _ = save_canvas_upload(
        project.project_id, "source.png", ".png", stream.getvalue(), "image", document.revision,
    )
    source = CanvasImageNode(
        id="source", type="image", title="源图", position=CanvasPoint(x=0, y=0),
        data=CanvasMediaNodeData(current_version_id=version.version_id),
    )
    document = save_canvas_document(project.project_id, document.model_copy(update={
        "nodes": [source],
    }), document.revision)
    result = execute_canvas_media_operation(project.project_id, CanvasMediaOperationRequest(
        expected_revision=document.revision, source_node_id=source.id,
        source_version_id=version.version_id,
        operation=operation or {
            "kind": "crop", "rect": {"x": 0, "y": 0, "width": 0.5, "height": 1},
        },
    ))
    return project, document, result


@pytest.mark.parametrize("operation,count", [
    ({"kind": "remove_background"}, 1),
    ({"kind": "split", "horizontal_lines": [0.5], "vertical_lines": [0.5]}, 4),
])
def test_independent_media_outputs_only_create_material_relationships(monkeypatch, operation, count):
    from character_workflow.lib import matting

    monkeypatch.setattr(matting, "remove_background", lambda source: source.convert("RGBA"))
    project, before, result = _cropped_project(operation)
    assert len(result.created_node_ids) == count
    assert [(edge.role, edge.source_node_id, edge.target_node_id)
            for edge in result.document.connections] == [
        ("material", "source", node_id) for node_id in result.created_node_ids
    ]
    assert len(result.document.nodes) == len(before.nodes) + count
    assert read_canvas_document(project.project_id).connections == result.document.connections


def test_local_tool_creates_material_relationship_and_undo_redo_preserves_versions():
    project, before, result = _cropped_project()
    assert len(result.document.connections) == 1
    edge = result.document.connections[0]
    assert edge.role == "material"
    assert edge.source_node_id == "source"
    assert edge.target_node_id == result.created_node_ids[0]
    version = result.document.content_versions[result.created_version_ids[0]]
    assert version.origin.kind == "local_tool"
    assert version.origin.source_version_id == before.nodes[0].data.current_version_id
    undone = save_canvas_document(project.project_id, result.document.model_copy(update={
        "nodes": before.nodes, "connections": [],
    }), result.document.revision)
    assert version.version_id in undone.content_versions
    restored = save_canvas_document(project.project_id, result.document.model_copy(update={
        "revision": undone.revision,
    }), undone.revision)
    assert restored.connections == result.document.connections
    assert restored.content_versions == result.document.content_versions


@pytest.mark.parametrize("keep_relationship", [True, False])
def test_project_package_keeps_material_relationship_and_history(keep_relationship):
    project, _, result = _cropped_project()
    saved = save_canvas_document(project.project_id, result.document.model_copy(update={
        "connections": result.document.connections if keep_relationship else [],
    }), result.document.revision)
    package_path, _ = export_canvas_projects([project.project_id])
    try:
        inspection = inspect_canvas_package(package_path)
        imported = commit_canvas_package(inspection.token)
    finally:
        package_path.unlink()
    restored = read_canvas_document(imported[0].project_id)
    assert len(restored.connections) == int(keep_relationship)
    if keep_relationship:
        edge = restored.connections[0]
        assert edge.role == "material"
        assert edge.model_dump(exclude={"id", "source_node_id", "target_node_id"}) == {
            "role": "material",
        }
        assert edge.source_node_id in {node.id for node in restored.nodes}
        assert edge.target_node_id in {node.id for node in restored.nodes}
    assert len(restored.content_versions) == len(saved.content_versions)
    histories = [v for v in restored.content_versions.values() if v.origin.kind == "local_tool"]
    assert len(histories) == 1
    assert histories[0].origin.source_version_id in restored.content_versions


def test_only_direct_inputs_are_resolved_alongside_material_relationships(monkeypatch):
    from character_workflow.lib import matting

    monkeypatch.setattr(matting, "remove_background", lambda source: source.convert("RGBA"))
    project, _, result = _cropped_project({"kind": "remove_background"})
    draft = CanvasGenerationDraft(
        mode="image", prompt="细化", model="gpt-image-1", alias="test",
        updated_at=result.document.updated_at,
    )
    derived = result.document.nodes[-1]
    target = CanvasImageNode(
        id="target", type="image", title="结果", position=CanvasPoint(x=800, y=0),
        data=CanvasMediaNodeData(generation_draft=draft),
    )
    document = save_canvas_document(project.project_id, result.document.model_copy(update={
        "nodes": [*result.document.nodes, target],
        "connections": [*result.document.connections,
            CanvasMaterialConnection(id="source-material", role="material", source_node_id="source",
                                     target_node_id=target.id),
            CanvasMaterialConnection(id="derived-material", role="material", source_node_id=derived.id,
                                     target_node_id=target.id),
            CanvasInputConnection(id="derived-input", role="input", source_node_id=derived.id,
                                  target_node_id=target.id),
        ],
    }), result.document.revision)
    inputs = canvas_runs._resolve_inputs(document, target, draft)
    assert [(item.node_id, item.version_id) for item in inputs] == [
        (derived.id, derived.data.current_version_id),
    ]
    assert canvas_batches._sources(document, target) == [derived.id]
    assert canvas_runs._resolve_inputs(document, derived, draft) == []
    assert canvas_batches._sources(document, derived) == []
    write_keys_db(KeysDB(keys=[KeySpec(
        alias="test", provider="openai", access_key="test-only", created_at=document.updated_at,
        models=[ModelSpec(id="gpt-image-1", name="Test", modality="image")],
    )]))
    prepared = canvas_runs.prepare_canvas_generation(project.project_id, document, target)
    assert prepared.inputs == inputs
    assert prepared.job_params.reference_images == [str(
        canvas_project_dir(project.project_id)
        / document.content_versions[derived.data.current_version_id].path
    )]
    assert read_canvas_document(project.project_id).connections == document.connections
