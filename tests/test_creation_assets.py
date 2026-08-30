from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.canvas_library import create_canvas_prompt, save_canvas_asset
from character_workflow.lib.canvas_projects import (
    _document_path,
    create_canvas_project,
    read_canvas_document,
)
from character_workflow.lib.creation_assets import (
    CreationAssetDuplicateError,
    create_image_asset_from_bytes,
    create_prompt_asset,
    creation_asset_image_path,
    delete_creation_asset,
    list_creation_assets,
    mark_creation_asset_used,
    migrate_legacy_canvas_libraries,
    render_prompt_segments,
    update_image_asset_from_bytes,
    update_prompt_asset,
)
from character_workflow.lib.schemas import (
    CanvasGenerationDraft,
    CanvasImageNode,
    CanvasLibraryAsset,
    CanvasMediaNodeData,
    CanvasMediaVersion,
    CanvasPoint,
    CanvasPrompt,
    CanvasUploadOrigin,
    RevisionedSidecar,
)
from viewer_server.server_app import build_app


_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


@pytest.fixture
def client(isolated_data_root):
    return TestClient(build_app(dist_dir=isolated_data_root / "dist"))


def _segments(subject: str = "白色三头犬") -> list[dict[str, str]]:
    return [
        {"kind": "text", "text": "一只"},
        {"kind": "variable", "name": "主体", "default_value": subject},
        {"kind": "text", "text": "站在"},
        {"kind": "variable", "name": "场景", "default_value": "火山口"},
        {"kind": "text", "text": "中。"},
    ]


def test_prompt_asset_has_one_mutable_content_and_renders_variables():
    created = create_prompt_asset("地狱犬角色", _segments(), ["角色", "角色", "像素风"])
    assert created.kind == "prompt"
    assert created.tags == ["角色", "像素风"]
    assert created.model_dump().keys() >= {"asset_id", "content"}
    assert "versions" not in created.model_dump()
    assert render_prompt_segments(created.content.segments, {}) == "一只白色三头犬站在火山口中。"
    assert render_prompt_segments(
        created.content.segments,
        {"主体": "机械犬", "场景": "月面"},
    ) == "一只机械犬站在月面中。"

    updated = update_prompt_asset(
        created.asset_id,
        title="地狱犬模板",
        segments=_segments("毛绒三头犬"),
        tags=["角色"],
    )
    assert updated.asset_id == created.asset_id
    assert updated.title == "地狱犬模板"
    assert render_prompt_segments(updated.content.segments, {}) == "一只毛绒三头犬站在火山口中。"


def test_project_scope_uses_last_used_sorting():
    first = create_prompt_asset("先创建", _segments(), ["角色"])
    second = create_prompt_asset("后创建", _segments("狐狸"), ["角色"], project_id="canvas-a")

    mark_creation_asset_used(first.asset_id, project_id="canvas-a")
    rows = list_creation_assets(scope="project", project_id="canvas-a")
    assert [row.asset_id for row in rows.assets] == [first.asset_id, second.asset_id]


def test_image_assets_are_deduplicated_and_edit_in_place():
    created = create_image_asset_from_bytes(
        title="测试图",
        body=_PNG,
        filename="test.png",
        mime_type="image/png",
        tags=["测试"],
    )
    with pytest.raises(CreationAssetDuplicateError) as duplicate:
        create_image_asset_from_bytes(
            title="另一个名字",
            body=_PNG,
            filename="copy.png",
            mime_type="image/png",
            tags=[],
        )
    assert duplicate.value.asset_id == created.asset_id

    updated = update_image_asset_from_bytes(
        created.asset_id,
        title="改名后的图",
        tags=["新标签"],
    )
    assert updated.asset_id == created.asset_id
    assert updated.content == created.content
    assert updated.title == "改名后的图"

    old_blob = creation_asset_image_path(created.asset_id)
    replaced = update_image_asset_from_bytes(
        created.asset_id,
        title="替换后的图",
        tags=["新标签"],
        body=_PNG + b"replacement",
        filename="replacement.png",
        mime_type="image/png",
    )
    assert replaced.asset_id == created.asset_id
    assert creation_asset_image_path(created.asset_id).is_file()
    assert not old_blob.exists()


def test_physical_delete_removes_catalog_entry_and_orphan_blob():
    created = create_image_asset_from_bytes(
        title="待删除",
        body=_PNG,
        filename="delete.png",
        mime_type="image/png",
        tags=[],
    )
    blob = creation_asset_image_path(created.asset_id)
    assert blob.is_file()

    delete_creation_asset(created.asset_id)

    assert list_creation_assets().assets == []
    assert not blob.exists()


def test_legacy_canvas_prompts_and_images_migrate_once(isolated_data_root):
    project = create_canvas_project("旧画布")
    document = read_canvas_document(project.project_id)
    image_path = isolated_data_root / "canvases" / project.project_id / "uploads" / "legacy.png"
    image_path.write_bytes(_PNG)
    version = CanvasMediaVersion(
        version_id="version-legacy-image",
        created_at="2026-08-29T00:00:00+00:00",
        sha256="0" * 64,
        origin=CanvasUploadOrigin(kind="upload", upload_id="legacy"),
        kind="image",
        path="uploads/legacy.png",
        mime_type="image/png",
        bytes=len(_PNG),
        width=1,
        height=1,
    )
    atomic_write_json(
        _document_path(project.project_id),
        document.model_copy(update={"content_versions": {version.version_id: version}}).model_dump(
            mode="json"
        ),
    )
    legacy_library = isolated_data_root / "canvases" / project.project_id / "library"
    legacy_library.mkdir(parents=True)
    atomic_write_json(
        legacy_library / "assets.json",
        RevisionedSidecar[CanvasLibraryAsset](
            updated_at="2026-08-29T00:00:00+00:00",
        ).model_dump(mode="json"),
    )
    atomic_write_json(
        legacy_library / "prompts.json",
        RevisionedSidecar[CanvasPrompt](
            updated_at="2026-08-29T00:00:00+00:00",
        ).model_dump(mode="json"),
    )
    save_canvas_asset(project.project_id, version.version_id, "旧图片", ["旧资产"], 0)
    create_canvas_prompt(project.project_id, "旧提示词", "旧画布提示词正文", ["旧资产"], 0)

    assert migrate_legacy_canvas_libraries() == 2
    assets = list_creation_assets(scope="project", project_id=project.project_id).assets
    assert {(asset.kind, asset.title) for asset in assets} == {
        ("image", "旧图片"),
        ("prompt", "旧提示词"),
    }
    assert migrate_legacy_canvas_libraries() == 0


def test_creation_asset_http_api_exposes_single_content_edit_and_delete(client: TestClient):
    created = client.post("/api/creation-assets/prompts", json={
        "title": "镜头模板",
        "segments": _segments(),
        "tags": ["镜头"],
    })
    assert created.status_code == 201, created.json()
    prompt = created.json()

    updated = client.put(
        f"/api/creation-assets/{prompt['asset_id']}/prompt",
        json={"title": "镜头资产", "segments": _segments("机械犬"), "tags": ["构图"]},
    )
    assert updated.status_code == 200, updated.json()
    assert updated.json()["asset_id"] == prompt["asset_id"]
    assert "versions" not in updated.json()

    image = client.post(
        "/api/creation-assets/images/upload",
        files={"file": ("dog.png", _PNG, "image/png")},
        data={"title": "地狱犬", "tags": '["角色"]'},
    )
    assert image.status_code == 201, image.json()
    image_asset = image.json()
    content = client.get(f"/api/creation-assets/{image_asset['asset_id']}/content")
    assert content.status_code == 200
    assert content.content == _PNG

    assert client.post(f"/api/creation-assets/{prompt['asset_id']}/archive").status_code == 405
    deleted = client.delete(f"/api/creation-assets/{prompt['asset_id']}")
    assert deleted.status_code == 204


def test_canvas_receives_disconnected_content_and_title_snapshot(client: TestClient):
    project = create_canvas_project("资产画布")
    prompt = create_prompt_asset("镜头", _segments(), ["镜头"])

    inserted = client.post(
        f"/api/canvas/projects/{project.project_id}/creation-assets/{prompt.asset_id}/insert",
        headers={"If-Match": "0"},
        json={"position": {"x": 10, "y": 20}, "variable_values": {"主体": "机械犬"}},
    )
    assert inserted.status_code == 200, inserted.json()
    document = inserted.json()
    node = document["nodes"][0]
    frozen = document["content_versions"][node["data"]["current_version_id"]]
    assert frozen["text"] == "一只机械犬站在火山口中。"
    assert frozen["origin"] == {"kind": "creation_asset_snapshot", "title": "镜头"}

    update_prompt_asset(
        prompt.asset_id,
        title="改名后的资产",
        segments=_segments("狐狸"),
        tags=[],
    )
    delete_creation_asset(prompt.asset_id)
    unchanged = read_canvas_document(project.project_id)
    assert unchanged.content_versions[node["data"]["current_version_id"]].text == frozen["text"]
    assert unchanged.content_versions[node["data"]["current_version_id"]].origin.title == "镜头"


def test_image_asset_can_become_reference_for_active_canvas_generation(client: TestClient):
    project = create_canvas_project("生成画布")
    current = read_canvas_document(project.project_id)
    target = CanvasImageNode(
        id="image-target",
        title="待生成",
        type="image",
        position=CanvasPoint(x=0, y=0),
        z_index=0,
        data=CanvasMediaNodeData(
            generation_draft=CanvasGenerationDraft(
                mode="image",
                prompt="",
                model="gpt-image-2",
                updated_at="2026-08-29T00:00:00+00:00",
            ),
        ),
    )
    atomic_write_json(
        _document_path(project.project_id),
        current.model_copy(update={"nodes": [target]}).model_dump(mode="json"),
    )
    asset = create_image_asset_from_bytes(
        title="参考图",
        body=_PNG,
        filename="reference.png",
        mime_type="image/png",
        tags=[],
    )

    response = client.post(
        f"/api/canvas/projects/{project.project_id}/creation-assets/{asset.asset_id}/insert",
        headers={"If-Match": "0"},
        json={"position": {"x": 30, "y": 40}, "target_node_id": target.id},
    )
    assert response.status_code == 200, response.json()
    document = response.json()
    inserted = next(node for node in document["nodes"] if node["id"] != target.id)
    assert document["connections"][0]["source_node_id"] == inserted["id"]
    version = document["content_versions"][inserted["data"]["current_version_id"]]
    assert version["origin"] == {"kind": "creation_asset_snapshot", "title": "参考图"}
