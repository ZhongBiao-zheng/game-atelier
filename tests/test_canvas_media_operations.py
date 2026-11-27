import json
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from character_workflow.lib.canvas_media_operations import execute_canvas_media_operation
from character_workflow.lib.canvas_projects import (
    create_canvas_project, read_canvas_document, save_canvas_document, save_canvas_upload,
)
from character_workflow.lib.schemas import (
    CanvasImageNode, CanvasMediaNodeData, CanvasMediaOperationRequest, CanvasPoint, CanvasSize,
)

CASES = json.loads((Path(__file__).parent / "fixtures/canvas_split_layout.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_split_nodes_match_shared_layout(case):
    project_id = create_canvas_project("切分坐标").project_id
    doc = read_canvas_document(project_id)
    stream = BytesIO()
    Image.new("RGB", case["pixels"]).save(stream, format="PNG")
    version, doc, _ = save_canvas_upload(
        project_id, "grid.png", ".png", stream.getvalue(), "image", doc.revision,
    )
    width, height = case["sourceSize"]
    source = CanvasImageNode(
        id="source", type="image", title="原图", position=CanvasPoint(x=32.25, y=43.5),
        size=CanvasSize(width=width, height=height),
        data=CanvasMediaNodeData(current_version_id=version.version_id),
    )
    blockers = [
        CanvasImageNode(id=f"blocker-{i}", type="image", title="遮挡", position=CanvasPoint(x=x, y=y),
                        size=CanvasSize(width=w, height=h), data=CanvasMediaNodeData())
        for i, (x, y, w, h) in enumerate(case["blockers"])
    ]
    doc = save_canvas_document(project_id, doc.model_copy(update={"nodes": [source, *blockers]}),
                               doc.revision)
    result = execute_canvas_media_operation(project_id, CanvasMediaOperationRequest(
        expected_revision=doc.revision, source_node_id=source.id, source_version_id=version.version_id,
        operation={"kind": "split", "horizontal_lines": case["horizontal"], "vertical_lines": case["vertical"]},
    ))
    by_id = {node.id: node for node in result.document.nodes}
    actual = []
    for node_id in result.created_node_ids:
        node = by_id[node_id]
        piece = result.document.content_versions[node.data.current_version_id]
        actual.append([node.position.x, node.position.y, node.size.width, node.size.height,
                       piece.width, piece.height])
    assert actual == case["pieces"]
