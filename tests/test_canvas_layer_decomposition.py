from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib.canvas_projects import (
    canvas_output_dir,
    create_canvas_project,
    read_canvas_document,
    replace_canvas_node_media,
    resolve_canvas_media,
    save_canvas_document,
)
from character_workflow.lib.canvas_packages import (
    commit_canvas_package,
    export_canvas_projects,
    inspect_canvas_package,
)
from character_workflow.lib.canvas_runs import (
    CanvasRunCommandError,
    finalize_canvas_run,
    submit_layer_decomposition_run,
)
from character_workflow.lib.jobs import save_job
from character_workflow.lib.keys import KeySpec, KeysDB, ModelSpec, write_keys_db
from character_workflow.lib.schemas import (
    CanvasImageNode,
    CanvasInputConnection,
    CanvasLayerStackData,
    CanvasLayerStackNode,
    JobParams,
    CanvasMediaDisplay,
    CanvasMediaNodeData,
    CanvasPoint,
    CanvasSize,
    JobStatus,
)
from viewer_server.server_app import build_app


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def _project_with_source_image():
    project = create_canvas_project("图层拆分")
    current = read_canvas_document(project.project_id)
    source = CanvasImageNode(
        id="source-image",
        title="源图",
        type="image",
        position=CanvasPoint(x=20, y=40),
        z_index=0,
        data=CanvasMediaNodeData(
            current_version_id=None,
            generation_draft=None,
            active_run_id=None,
            display=CanvasMediaDisplay(),
        ),
    )
    saved = save_canvas_document(
        project.project_id,
        current.model_copy(update={"nodes": [source]}),
        current.revision,
    )
    version, saved, _name = replace_canvas_node_media(
        project.project_id,
        source.id,
        "source.png",
        ".png",
        PNG,
        "image",
        saved.revision,
    )
    return project, saved, version


def _configure_seedream() -> None:
    write_keys_db(KeysDB(default_alias="ark", keys=[KeySpec(
        alias="ark",
        provider="seedream",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
        access_key="secret",
        created_at="2026-09-03T00:00:00Z",
        models=[ModelSpec(
            name="Seedream 5.0 Pro",
            id="doubao-seedream-5-0-pro-260628",
            modality="image",
        )],
    )]))


def _project_with_decomposition_node(
    *,
    alias: str = "ark",
    model: str = "doubao-seedream-5-0-pro-260628",
    prompt: str = "",
    resolution: str = "auto",
):
    project, current, version = _project_with_source_image()
    stack = CanvasLayerStackNode(
        id="layer-stack",
        title="拆分图层",
        type="layer_stack",
        position=CanvasPoint(x=420, y=40),
        size=CanvasSize(width=760, height=480),
        z_index=0,
        data=CanvasLayerStackData(
            source_version_id=version.version_id,
            alias=alias,
            model=model,
            prompt=prompt,
            resolution=resolution,
        ),
    )
    edge = CanvasInputConnection(
        id="source-to-layer-stack",
        role="input",
        source_node_id="source-image",
        target_node_id=stack.id,
    )
    saved = save_canvas_document(
        project.project_id,
        current.model_copy(update={
            "nodes": [*current.nodes, stack],
            "connections": [*current.connections, edge],
        }),
        current.revision,
    )
    return project, saved, version


def test_layer_decomposition_runs_existing_stack_and_registers_every_output(isolated_data_root):
    _configure_seedream()
    project, current, source_version = _project_with_decomposition_node(
        prompt="拆出主体",
        resolution="1.5K",
    )

    job, submitted = submit_layer_decomposition_run(
        project.project_id,
        "layer-stack",
        current.revision,
        "ark",
        "doubao-seedream-5-0-pro-260628",
    )

    result_node = next(node for node in submitted.nodes if node.id == job.canvas_run.result_node_id)
    assert result_node.type == "layer_stack"
    assert result_node.data.source_version_id == source_version.version_id
    assert result_node.data.active_run_id == job.canvas_run.run_id
    assert result_node.data.error is None
    assert len(submitted.nodes) == len(current.nodes)
    assert job.prompt == "拆出主体"
    assert job.canvas_run.snapshot.final_prompt == "拆出主体"
    assert job.provider == "seedream"
    assert job.params.layer_decomposition is True
    assert job.params.size == "1.5K"
    assert job.canvas_run.snapshot.normalized_params["size"] == "1.5K"
    assert job.params.reference_images and len(job.params.reference_images) == 1

    output_dir = canvas_output_dir(project.project_id, job.job_id)
    base_path = output_dir / "v1.png"
    layer_path = output_dir / "v2.png"
    base_path.write_bytes(PNG)
    layer_path.write_bytes(PNG)
    finished = job.model_copy(update={
        "status": JobStatus.DONE,
        "output_paths": [str(base_path), str(layer_path)],
        "params": JobParams.model_validate({
            **job.params.model_dump(mode="json"),
            "layer_decomposition_result": {
                "outputs": [
                    {
                        "output_index": 0,
                        "z_index": 0,
                        "size": "1x1",
                        "output_format": "png",
                        "name": "",
                        "description": "",
                        "bounding_box": None,
                    },
                    {
                        "output_index": 1,
                        "z_index": 1,
                        "size": "1x1",
                        "output_format": "png",
                        "name": "主体",
                        "description": "透明主体图层",
                        "bounding_box": {
                            "absolute": [0, 0, 1, 1],
                            "normalized": [0, 0, 1000, 1000],
                        },
                    },
                ],
                "usage": {
                    "input_images": 1,
                    "generated_images": 2,
                    "output_tokens": 2,
                    "total_tokens": 2,
                },
            },
        }),
    })
    save_job(finished)

    finalized, document = finalize_canvas_run(project.project_id, job.job_id)

    assert finalized.status == JobStatus.DONE
    assert finalized.canvas_run.candidates[0].status == "succeeded"
    assert document is not None
    result_node = next(node for node in document.nodes if node.id == job.canvas_run.result_node_id)
    assert result_node.type == "layer_stack"
    assert result_node.data.active_run_id is None
    assert result_node.data.base_version_id in document.content_versions
    assert len(result_node.data.layers) == 1
    assert result_node.data.layers[0].name == "主体"
    assert result_node.data.layers[0].bounding_box.absolute == (0, 0, 1, 1)
    assert result_node.data.layers[0].version_id in document.content_versions
    assert len(document.content_versions) == 3  # source + base + transparent layer

    resolved_path, resolved = resolve_canvas_media(
        project.project_id,
        result_node.data.layers[0].version_id,
    )
    assert resolved_path == layer_path
    assert resolved.origin.kind == "layer_decomposition"
    assert resolved.origin.output_index == 1

    package_path, _filename = export_canvas_projects([project.project_id])
    try:
        inspection = inspect_canvas_package(package_path)
    finally:
        package_path.unlink(missing_ok=True)
    imported_project = commit_canvas_package(inspection.token)[0]
    imported_document = read_canvas_document(imported_project.project_id)
    imported_stack = next(node for node in imported_document.nodes if node.type == "layer_stack")
    imported_layer_path, imported_layer = resolve_canvas_media(
        imported_project.project_id,
        imported_stack.data.layers[0].version_id,
    )
    assert imported_layer_path.is_file()
    assert imported_layer.origin.kind == "layer_decomposition"
    assert imported_layer.origin.output_index == 1


def test_layer_stack_rejects_dangling_image_versions(isolated_data_root):
    _configure_seedream()
    project, current, _source_version = _project_with_source_image()
    payload = current.model_dump(mode="json")
    payload["nodes"].append({
        "id": "broken-stack",
        "title": "坏图层",
        "type": "layer_stack",
        "position": {"x": 400, "y": 40},
        "z_index": 0,
        "data": {
            "source_version_id": next(iter(current.content_versions)),
            "base_version_id": "missing",
            "base_visible": True,
            "layers": [],
            "active_run_id": None,
        },
    })

    with pytest.raises(ValueError, match="base image version"):
        type(current).model_validate(payload)


def test_failed_layer_decomposition_releases_node_and_persists_error(isolated_data_root):
    _configure_seedream()
    project, current, _source_version = _project_with_decomposition_node()
    job, _submitted = submit_layer_decomposition_run(
        project.project_id,
        "layer-stack",
        current.revision,
        "ark",
        "doubao-seedream-5-0-pro-260628",
    )
    save_job(job.model_copy(update={
        "status": JobStatus.FAILED,
        "error": "upstream failed",
    }))

    finalized, document = finalize_canvas_run(project.project_id, job.job_id)

    assert finalized.status == JobStatus.FAILED
    assert finalized.canvas_run.candidates[0].status == "failed"
    assert document is not None
    node = next(item for item in document.nodes if item.id == job.canvas_run.result_node_id)
    assert node.data.active_run_id is None
    assert node.data.error == "upstream failed"


def test_layer_decomposition_uses_the_explicitly_selected_ark_model(isolated_data_root):
    write_keys_db(KeysDB(default_alias="ark", keys=[
        KeySpec(
            alias="ark",
            provider="seedream",
            base_url="https://ark.cn-beijing.volces.com/api/v3",
            access_key="secret",
            created_at="2026-09-03T00:00:00Z",
            models=[ModelSpec(
                name="Seedream 5.0 Pro",
                id="doubao-seedream-5-0-pro-260628",
                modality="image",
            )],
        ),
        KeySpec(
            alias="tokendance",
            provider="tokendance",
            base_url="https://tokendance.space/gateway/v1",
            access_key="secret",
            created_at="2026-09-03T00:00:00Z",
            models=[ModelSpec(
                name="Seedream 5.0 Pro",
                id="seedream-5.0-pro",
                modality="image",
                protocol="ark",
            )],
        ),
    ]))
    invalid_project, invalid_current, _source_version = _project_with_decomposition_node(
        alias="missing",
        model="seedream-5.0-pro",
    )

    with pytest.raises(CanvasRunCommandError, match="重新选择"):
        submit_layer_decomposition_run(
            invalid_project.project_id,
            "layer-stack",
            invalid_current.revision,
            "missing",
            "seedream-5.0-pro",
        )

    project, current, _source_version = _project_with_decomposition_node(
        alias="tokendance",
        model="seedream-5.0-pro",
    )
    job, _submitted = submit_layer_decomposition_run(
        project.project_id,
        "layer-stack",
        current.revision,
        "tokendance",
        "seedream-5.0-pro",
    )

    assert job.alias == "tokendance"
    assert job.provider == "tokendance"
    assert job.model == "seedream-5.0-pro"


def test_layer_decomposition_endpoint_schedules_the_canvas_job(
    isolated_data_root,
    monkeypatch,
):
    _configure_seedream()
    project, current, _source_version = _project_with_decomposition_node()
    scheduled: list[str] = []
    from viewer_server import routes as routes_module

    monkeypatch.setattr(
        routes_module,
        "_run_canvas_job_safely",
        lambda job_id: scheduled.append(job_id),
    )
    client = TestClient(build_app(dist_dir=isolated_data_root / "dist"))

    response = client.post(
        f"/api/canvas/projects/{project.project_id}/runs/layer-decomposition",
        json={
            "surface_node_id": "layer-stack",
            "expected_revision": current.revision,
            "alias": "ark",
            "model": "doubao-seedream-5-0-pro-260628",
        },
    )

    assert response.status_code == 201, response.json()
    payload = response.json()
    assert scheduled == [payload["job"]["job_id"]]
    assert payload["job"]["params"]["size"] == "auto"
    assert payload["job"]["canvas_run"]["snapshot"]["normalized_params"]["size"] == "auto"
    stack = next(node for node in payload["document"]["nodes"] if node["id"] == "layer-stack")
    assert stack["data"]["active_run_id"] == payload["job"]["canvas_run"]["run_id"]
