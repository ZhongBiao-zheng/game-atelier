"""Input edges may change without losing local-tool content or portable history."""
from io import BytesIO

from PIL import Image

from character_workflow.lib.canvas_media_operations import execute_canvas_media_operation
from character_workflow.lib.canvas_packages import (
    commit_canvas_package, export_canvas_projects, inspect_canvas_package,
)
from character_workflow.lib.canvas_projects import (
    create_canvas_project, read_canvas_document, save_canvas_document, save_canvas_upload,
)
from character_workflow.lib.schemas import (
    CanvasImageNode, CanvasMediaNodeData, CanvasMediaOperationRequest, CanvasPoint,
)


def _cropped_project():
    project = create_canvas_project("显式工具输入")
    document = read_canvas_document(project.project_id)
    stream = BytesIO()
    Image.new("RGB", (20, 20), "red").save(stream, format="PNG")
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
        operation={"kind": "crop", "rect": {"x": 0, "y": 0, "width": 0.5, "height": 1}},
    ))
    return project, document, result


def test_local_tool_creates_real_input_and_undo_redo_preserves_versions():
    project, before, result = _cropped_project()
    assert len(result.document.connections) == 1
    edge = result.document.connections[0]
    assert edge.role == "input"
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


def test_project_package_keeps_history_after_all_input_lines_are_removed():
    project, _, result = _cropped_project()
    saved = save_canvas_document(project.project_id, result.document.model_copy(update={
        "connections": [],
    }), result.document.revision)
    package_path, _ = export_canvas_projects([project.project_id])
    try:
        inspection = inspect_canvas_package(package_path)
        imported = commit_canvas_package(inspection.token)
    finally:
        package_path.unlink()
    restored = read_canvas_document(imported[0].project_id)
    assert restored.connections == []
    assert len(restored.content_versions) == len(saved.content_versions)
    histories = [v for v in restored.content_versions.values() if v.origin.kind == "local_tool"]
    assert len(histories) == 1
    assert histories[0].origin.source_version_id in restored.content_versions
