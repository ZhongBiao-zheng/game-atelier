from io import BytesIO
from zipfile import ZipFile

import pytest
from PIL import Image

from character_workflow.lib.canvas_layer_exports import export_canvas_layers
from character_workflow.lib.canvas_media_operations import execute_canvas_media_operation
from character_workflow.lib.canvas_projects import (
    CanvasMediaReplaceError, canvas_output_dir, read_canvas_document,
    replace_canvas_node_media, save_canvas_document,
)
from character_workflow.lib.canvas_runs import _commit_frozen_run, finalize_canvas_run
from character_workflow.lib.keys import KeySpec, ModelSpec
from character_workflow.lib.jobs import save_job
from character_workflow.lib.schemas import (
    CanvasDocument, CanvasImageNode, CanvasMediaNodeData, CanvasPoint, CanvasSize,
    CanvasMaterialConnection, CanvasMediaOperationRequest, CanvasSnapshotInput,
    JobKind, JobParams, JobStatus,
)
from tests.test_canvas_layer_exports import _completed_stack
from tests.local_client import LocalTestClient
from viewer_server.server_app import build_app


def _bound_stack():
    project, document, _ = _completed_stack()
    stack = document.nodes[1]
    material = CanvasImageNode(
        id="material", title="标题", type="image", position=CanvasPoint(x=900, y=40),
        size=CanvasSize(width=280, height=280), z_index=0,
        data=CanvasMediaNodeData(current_version_id=stack.data.layers[0].version_id),
    )
    stack = stack.model_copy(update={"data": stack.data.model_copy(update={
        "layers": [stack.data.layers[0].model_copy(update={"material_node_id": material.id}),
                   stack.data.layers[1]],
    })})
    document = save_canvas_document(project.project_id, document.model_copy(update={
        "nodes": [document.nodes[0], stack, material],
    }), document.revision)
    return project, document


def _png(width=80, height=40):
    buffer = BytesIO()
    Image.new("RGBA", (width, height), (255, 0, 0, 128)).save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.mark.parametrize("base_z_index", [0, 1, 2])
def test_layer_order_persists_background_position_without_changing_material_bindings(base_z_index):
    project, document = _bound_stack()
    stack = document.nodes[1]
    base_material = document.nodes[0].model_copy(update={"id": "base-material"})
    stack = stack.model_copy(update={"data": stack.data.model_copy(update={
        "base_material_node_id": base_material.id,
    })})
    document = save_canvas_document(project.project_id, document.model_copy(update={
        "nodes": [document.nodes[0], stack, document.nodes[2], base_material],
    }), document.revision)
    original = document.nodes[1].data
    ranks = [rank for rank in range(3) if rank != base_z_index]
    reordered = original.model_copy(update={
        "base_z_index": base_z_index,
        "layers": [layer.model_copy(update={"z_index": rank})
                   for layer, rank in zip(original.layers, ranks, strict=True)],
    })
    saved = save_canvas_document(project.project_id, document.model_copy(update={
        "nodes": [node.model_copy(update={"data": reordered}) if node.id == "layer-stack"
                  else node for node in document.nodes],
    }), document.revision)
    restored = read_canvas_document(project.project_id)
    actual = restored.nodes[1].data
    assert actual.base_z_index == base_z_index
    assert actual.base_version_id == original.base_version_id
    assert actual.base_material_node_id == original.base_material_node_id
    assert actual.base_visible == original.base_visible
    assert [layer.z_index for layer in actual.layers] == ranks
    assert [layer.model_dump(exclude={"z_index"}) for layer in actual.layers] == [
        layer.model_dump(exclude={"z_index"}) for layer in original.layers
    ]
    assert restored.content_versions == document.content_versions
    assert restored.connections == document.connections
    assert restored.nodes[2:] == document.nodes[2:]
    assert restored.revision == saved.revision


@pytest.mark.parametrize("base_z_index, ranks", [(1, [1, 2]), (0, [1, 1])])
def test_layer_stack_rejects_conflicting_background_or_layer_order(base_z_index, ranks):
    project, document = _bound_stack()
    original = document.nodes[1]
    changed = original.model_copy(update={"data": original.data.model_copy(update={
        "base_z_index": base_z_index,
        "layers": [layer.model_copy(update={"z_index": rank})
                   for layer, rank in zip(original.data.layers, ranks, strict=True)],
    })})
    response = LocalTestClient(build_app(), base_url="http://127.0.0.1").put(
        f"/api/canvas/projects/{project.project_id}/document",
        json=document.model_copy(update={
            "nodes": [document.nodes[0], changed, document.nodes[2]],
        }).model_dump(mode="json"),
        headers={"If-Match": str(document.revision)},
    )
    assert response.status_code == 422
    assert "layer stack layers must be unique" in response.text
    assert read_canvas_document(project.project_id) == document


@pytest.mark.parametrize("field, rank", [("base", -1), ("base", 17), ("layer", -1), ("layer", 17)])
def test_layer_stack_order_is_bounded(field, rank):
    _, document = _bound_stack()
    payload = document.model_dump(mode="json")
    data = payload["nodes"][1]["data"]
    if field == "base":
        data["base_z_index"] = rank
    else:
        data["layers"][0]["z_index"] = rank
    with pytest.raises(ValueError, match="greater than or equal|less than or equal"):
        CanvasDocument.model_validate(payload)


def test_stack_without_background_allows_a_foreground_layer_at_zero():
    _, document = _bound_stack()
    payload = document.model_dump(mode="json")
    data = payload["nodes"][1]["data"]
    data["base_version_id"] = None
    data["layers"][0]["z_index"] = 0
    restored = CanvasDocument.model_validate(payload)
    assert restored.nodes[1].data.base_z_index == 0
    assert restored.nodes[1].data.layers[0].z_index == 0


def test_replacement_syncs_parent_download_and_deleting_view_keeps_last_image():
    project, document = _bound_stack()
    original_layer = document.nodes[1].data.layers[0]
    version, document, _ = replace_canvas_node_media(
        project.project_id, "material", "red.png", ".png", _png(), "image", document.revision,
    )
    layer = document.nodes[1].data.layers[0]
    assert layer.version_id == version.version_id
    assert layer.bounding_box == original_layer.bounding_box
    assert layer.visible is False
    assert document.nodes[2].size == CanvasSize(width=280, height=140)
    archive_path, _ = export_canvas_layers(project.project_id, "layer-stack")
    try:
        with ZipFile(archive_path) as archive:
            assert archive.read("002-标题.png") == _png()
    finally:
        archive_path.unlink()
    saved = save_canvas_document(project.project_id, document.model_copy(update={
        "nodes": document.nodes[:2],
    }), document.revision)
    layer = read_canvas_document(project.project_id).nodes[1].data.layers[0]
    assert layer.material_node_id is None
    assert layer.version_id == version.version_id
    # Undo restores the same material identity and old version, not a new asset.
    restored = save_canvas_document(project.project_id, document.model_copy(update={
        "revision": saved.revision,
    }), saved.revision)
    assert restored.nodes[1].data.layers[0].material_node_id == "material"


def test_local_crop_updates_owned_node_in_place_and_survives_reload():
    project, document = _bound_stack()
    version, document, _ = replace_canvas_node_media(
        project.project_id, "material", "red.png", ".png", _png(), "image", document.revision,
    )
    result = execute_canvas_media_operation(project.project_id, CanvasMediaOperationRequest(
        expected_revision=document.revision, source_node_id="material",
        source_version_id=version.version_id,
        operation={"kind": "crop", "rect": {"x": 0, "y": 0, "width": 0.5, "height": 1}},
    ))
    assert result.created_node_ids == ["material"]
    assert len(result.document.nodes) == len(document.nodes)
    assert result.document.connections == document.connections
    saved = read_canvas_document(project.project_id)
    assert saved.nodes[1].data.layers[0].version_id == result.created_version_ids[0]
    assert saved.nodes[2].data.current_version_id == result.created_version_ids[0]
    assert saved.nodes[2].size == CanvasSize(width=280, height=280)
    assert version.version_id in saved.content_versions


def test_retry_owned_material_preserves_material_relationship_and_restores_input():
    project, document = _bound_stack()
    source = document.nodes[0]
    edge = CanvasMaterialConnection(
        id="material-relation", role="material", source_node_id=source.id, target_node_id="material",
    )
    document = save_canvas_document(project.project_id, document.model_copy(update={
        "connections": [edge],
    }), document.revision)
    key = KeySpec(alias="test", provider="openai", access_key="test-only", models=[],
                  created_at=document.updated_at)
    model = ModelSpec(id="gpt-image-1", name="Test", modality="image")
    _, submitted = _commit_frozen_run(
        project.project_id, document, document.nodes[2], key, model, JobKind.IMAGE,
        mode="image", final_prompt="调整素材", input_policy="all_connected", normalized={},
        job_params=JobParams(n=1), inputs=[CanvasSnapshotInput(
            order=0, source="input_connection", node_id=source.id,
            version_id=source.data.current_version_id, kind="image",
        )], requested_count=1, result_title="编辑", result_draft=None,
        allow_surface_reuse=False, transaction_kind="submit", retry_of="original-job",
    )
    assert edge in submitted.connections
    assert [(item.source_node_id, item.target_node_id) for item in submitted.connections
            if item.role == "input"] == [(source.id, "material")]


def test_material_ownership_rejects_multiple_parents_and_empty_or_nonimage_nodes():
    _, document = _bound_stack()
    payload = document.model_dump(mode="json")
    payload["nodes"][1]["data"]["base_material_node_id"] = "material"
    with pytest.raises(ValueError, match="uniquely owned"):
        CanvasDocument.model_validate(payload)
    payload["nodes"][1]["data"]["base_material_node_id"] = None
    payload["nodes"][2]["data"]["current_version_id"] = None
    with pytest.raises(ValueError, match="populated image"):
        CanvasDocument.model_validate(payload)


@pytest.mark.parametrize("success", [True, False])
def test_generated_edit_reuses_material_updates_parent_only_on_success_and_allows_next_edit(success):
    project, document = _bound_stack()
    previous = document.nodes[2].data.current_version_id
    key = KeySpec(alias="test", provider="openai", access_key="test-only", models=[],
                  created_at=document.updated_at)
    model = ModelSpec(id="gpt-image-1", name="Test", modality="image")
    job, submitted = _commit_frozen_run(
        project.project_id, document, document.nodes[2], key, model, JobKind.IMAGE,
        mode="image", final_prompt="调整素材", input_policy="all_connected", normalized={},
        job_params=JobParams(n=1), inputs=[], requested_count=1, result_title="编辑",
        result_draft=None, allow_surface_reuse=False, transaction_kind="submit",
    )
    assert job.canvas_run.result_node_id == "material"
    assert len(submitted.nodes) == len(document.nodes)
    assert submitted.nodes[1].data.layers[0].version_id == previous
    output = canvas_output_dir(project.project_id, job.job_id) / "result.png"
    output.write_bytes(_png())
    save_job(job.model_copy(update={
        "status": JobStatus.DONE if success else JobStatus.FAILED,
        "output_paths": [str(output)] if success else [],
        "error": None if success else "test failure",
    }))
    # Runner status is terminal before candidate finalization: edits must still wait.
    with pytest.raises(CanvasMediaReplaceError, match="正在生成"):
        replace_canvas_node_media(project.project_id, "material", "racing.png", ".png",
                                  _png(), "image", submitted.revision)
    finalize_canvas_run(project.project_id, job.job_id)
    current = read_canvas_document(project.project_id)
    assert (current.nodes[1].data.layers[0].version_id != previous) is success
    assert current.nodes[1].data.layers[0].version_id == current.nodes[2].data.current_version_id
    # A completed run may remain selected for candidates, but must not lock later edits.
    version, current, _ = replace_canvas_node_media(
        project.project_id, "material", "next.png", ".png", _png(40, 40), "image", current.revision,
    )
    assert current.nodes[1].data.layers[0].version_id == version.version_id
