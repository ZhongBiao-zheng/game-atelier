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
from character_workflow.lib.canvas_packages import delete_canvas_project
from character_workflow.lib.creation_assets import (
    CreationAssetDuplicateError,
    archive_creation_asset,
    create_image_asset_from_bytes,
    create_prompt_asset,
    create_prompt_version,
    list_creation_assets,
    mark_creation_asset_used,
    migrate_legacy_canvas_libraries,
    patch_creation_asset_metadata,
    render_prompt_segments,
    relate_imported_canvas_creation_assets,
    remove_creation_asset_from_project,
    restore_creation_asset,
    restore_creation_asset_version,
)
from character_workflow.lib.schemas import (
    CanvasGenerationDraft,
    CanvasImageNode,
    CanvasLibraryAsset,
    CanvasMediaVersion,
    CanvasMediaNodeData,
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


def test_prompt_assets_render_variables_and_keep_versions_immutable():
    created = create_prompt_asset("地狱犬角色", _segments(), ["角色", "角色", "像素风"])
    assert created.kind == "prompt"
    assert created.tags == ["角色", "像素风"]
    assert render_prompt_segments(created.versions[0].segments, {}) == "一只白色三头犬站在火山口中。"
    assert render_prompt_segments(
        created.versions[0].segments,
        {"主体": "机械犬", "场景": "月面"},
    ) == "一只机械犬站在月面中。"

    metadata_only = patch_creation_asset_metadata(created.asset_id, title="地狱犬模板", tags=["角色"])
    assert metadata_only.latest_version_id == created.latest_version_id
    assert len(metadata_only.versions) == 1

    updated = create_prompt_version(created.asset_id, _segments("毛绒三头犬"))
    assert len(updated.versions) == 2
    assert updated.latest_version_id != created.latest_version_id
    assert render_prompt_segments(updated.versions[0].segments, {}) == "一只白色三头犬站在火山口中。"

    restored = restore_creation_asset_version(created.asset_id, created.latest_version_id)
    assert len(restored.versions) == 3
    assert restored.latest_version_id not in {created.latest_version_id, updated.latest_version_id}
    assert render_prompt_segments(restored.versions[-1].segments, {}) == "一只白色三头犬站在火山口中。"


def test_archive_project_scope_and_recent_use_sorting():
    first = create_prompt_asset("先创建", _segments(), ["角色"])
    second = create_prompt_asset("后创建", _segments("狐狸"), ["角色"], project_id="canvas-alpha1234")

    mark_creation_asset_used(first.asset_id, project_id="canvas-alpha1234")
    rows = list_creation_assets(scope="project", project_id="canvas-alpha1234")
    assert [row.asset_id for row in rows.assets] == [first.asset_id, second.asset_id]

    archive_creation_asset(first.asset_id)
    assert [row.asset_id for row in list_creation_assets().assets] == [second.asset_id]
    assert [row.asset_id for row in list_creation_assets(archived=True).assets] == [first.asset_id]

    restored = restore_creation_asset(first.asset_id)
    assert restored.archived_at is None


def test_canvas_project_relations_follow_imported_references_and_project_deletion(
    client: TestClient,
):
    project = create_canvas_project("关系画布")
    asset = create_prompt_asset("镜头", _segments(), [], project_id=project.project_id)
    inserted = client.post(
        f"/api/canvas/projects/{project.project_id}/creation-assets/{asset.asset_id}/insert",
        headers={"If-Match": "0"},
        json={"position": {"x": 0, "y": 0}},
    )
    assert inserted.status_code == 200

    remove_creation_asset_from_project(asset.asset_id, project.project_id)
    relate_imported_canvas_creation_assets(project.project_id)
    related = list_creation_assets(scope="project", project_id=project.project_id).assets
    assert [row.asset_id for row in related] == [asset.asset_id]

    delete_canvas_project(project.project_id, expected_revision=1)
    remaining = list_creation_assets().assets
    assert next(row for row in remaining if row.asset_id == asset.asset_id).project_ids == []


def test_image_assets_are_deduplicated_by_content():
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

    reused = create_image_asset_from_bytes(
        title="不会覆盖原标题",
        body=_PNG,
        filename="copy.png",
        mime_type="image/png",
        tags=[],
        allow_existing=True,
        project_id="canvas-alpha1234",
    )
    assert reused.asset_id == created.asset_id
    assert reused.title == "测试图"
    assert reused.project_ids == ["canvas-alpha1234"]


def test_image_replacement_creates_an_immutable_version(client: TestClient):
    created = create_image_asset_from_bytes(
        title="角色图",
        body=_PNG,
        filename="first.png",
        mime_type="image/png",
        tags=[],
    )
    replacement = client.post(
        f"/api/creation-assets/{created.asset_id}/versions/image",
        files={"file": ("second.png", _PNG + b"different", "image/png")},
    )
    assert replacement.status_code == 201, replacement.json()
    updated = replacement.json()
    assert len(updated["versions"]) == 2
    assert updated["versions"][0]["version_id"] == created.latest_version_id
    assert updated["latest_version_id"] == updated["versions"][1]["version_id"]


def test_legacy_canvas_prompts_and_images_migrate_once(isolated_data_root):
    project = create_canvas_project("旧画布")
    project_id = project.project_id
    document = read_canvas_document(project_id)
    image_path = isolated_data_root / "canvases" / project_id / "uploads" / "legacy.png"
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
    updated_document = document.model_copy(update={
        "content_versions": {version.version_id: version},
    })
    atomic_write_json(_document_path(project_id), updated_document.model_dump(mode="json"))
    legacy_library = isolated_data_root / "canvases" / project_id / "library"
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
    save_canvas_asset(project_id, version.version_id, "旧图片", ["旧资产"], 0)
    create_canvas_prompt(project_id, "旧提示词", "旧画布提示词正文", ["旧资产"], 0)

    migrated = migrate_legacy_canvas_libraries()
    assert migrated == 2
    assets = list_creation_assets(scope="project", project_id=project_id).assets
    assert {(asset.kind, asset.title) for asset in assets} == {
        ("image", "旧图片"),
        ("prompt", "旧提示词"),
    }
    assert migrate_legacy_canvas_libraries() == 0


def test_creation_asset_http_api(client: TestClient):
    created = client.post("/api/creation-assets/prompts", json={
        "title": "镜头模板",
        "segments": _segments(),
        "tags": ["镜头"],
    })
    assert created.status_code == 201, created.json()
    prompt = created.json()

    listed = client.get("/api/creation-assets", params={"kind": "prompt"})
    assert listed.status_code == 200
    assert [asset["asset_id"] for asset in listed.json()["assets"]] == [prompt["asset_id"]]

    metadata = client.patch(
        f"/api/creation-assets/{prompt['asset_id']}",
        json={"title": "镜头资产", "tags": ["镜头", "构图"]},
    )
    assert metadata.status_code == 200
    assert metadata.json()["latest_version_id"] == prompt["latest_version_id"]

    image = client.post(
        "/api/creation-assets/images/upload",
        files={"file": ("dog.png", _PNG, "image/png")},
        data={"title": "地狱犬", "tags": '["角色"]'},
    )
    assert image.status_code == 201, image.json()
    image_asset = image.json()
    version_id = image_asset["latest_version_id"]
    content = client.get(
        f"/api/creation-assets/{image_asset['asset_id']}/versions/{version_id}/content"
    )
    assert content.status_code == 200
    assert content.content == _PNG

    duplicate = client.post(
        "/api/creation-assets/images/upload",
        files={"file": ("copy.png", _PNG, "image/png")},
        data={"title": "重复", "tags": "[]"},
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["asset_id"] == image_asset["asset_id"]


def test_creation_assets_pin_immutable_versions_into_canvas(client: TestClient):
    project = create_canvas_project("资产画布")
    prompt = create_prompt_asset("镜头", _segments(), ["镜头"])
    image = create_image_asset_from_bytes(
        title="角色图",
        body=_PNG,
        filename="dog.png",
        mime_type="image/png",
        tags=["角色"],
    )

    prompt_insert = client.post(
        f"/api/canvas/projects/{project.project_id}/creation-assets/{prompt.asset_id}/insert",
        headers={"If-Match": "0"},
        json={"position": {"x": 10, "y": 20}, "variable_values": {"主体": "机械犬"}},
    )
    assert prompt_insert.status_code == 200, prompt_insert.json()
    prompt_document = prompt_insert.json()
    prompt_node = prompt_document["nodes"][0]
    prompt_version = prompt_document["content_versions"][prompt_node["data"]["current_version_id"]]
    assert prompt_version["text"] == "一只机械犬站在火山口中。"
    assert prompt_version["origin"] == {
        "kind": "creation_asset",
        "asset_id": prompt.asset_id,
        "asset_version_id": prompt.latest_version_id,
        "variable_values": {"主体": "机械犬"},
    }

    image_insert = client.post(
        f"/api/canvas/projects/{project.project_id}/creation-assets/{image.asset_id}/insert",
        headers={"If-Match": "1"},
        json={"position": {"x": 100, "y": 120}},
    )
    assert image_insert.status_code == 200, image_insert.json()
    image_document = image_insert.json()
    image_node = image_document["nodes"][1]
    image_version = image_document["content_versions"][image_node["data"]["current_version_id"]]
    assert image_version["origin"]["asset_id"] == image.asset_id
    assert image_version["path"].startswith("uploads/creation-asset-")


def test_image_asset_becomes_reference_for_active_canvas_generation(client: TestClient):
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
    assert document["connections"] == [{
        "id": document["connections"][0]["id"],
        "role": "input",
        "source_node_id": inserted["id"],
        "target_node_id": target.id,
        "slot": None,
    }]


def test_canvas_asset_references_update_only_when_explicit_and_keep_variable_values(
    client: TestClient,
):
    project = create_canvas_project("版本画布")
    prompt = create_prompt_asset("角色", _segments(), [])
    first = client.post(
        f"/api/canvas/projects/{project.project_id}/creation-assets/{prompt.asset_id}/insert",
        headers={"If-Match": "0"},
        json={
            "position": {"x": 0, "y": 0},
            "variable_values": {"主体": "机械犬", "场景": "月面", "无关字段": "丢弃"},
        },
    ).json()
    first_node_id = first["nodes"][0]["id"]
    second = client.post(
        f"/api/canvas/projects/{project.project_id}/creation-assets/{prompt.asset_id}/insert",
        headers={"If-Match": "1"},
        json={
            "position": {"x": 300, "y": 0},
            "variable_values": {"主体": "火焰犬", "场景": "雪原"},
        },
    ).json()
    second_node_id = second["nodes"][1]["id"]
    stored = read_canvas_document(project.project_id)
    draft_node = CanvasImageNode(
        id="draft-reference",
        title="生成草稿",
        type="image",
        position=CanvasPoint(x=600, y=0),
        z_index=0,
        data=CanvasMediaNodeData(
            generation_draft=CanvasGenerationDraft(
                mode="image",
                prompt="一只水晶犬站在森林中。",
                model="gpt-image-2",
                params={
                    "creation_prompt_asset_id": prompt.asset_id,
                    "creation_prompt_version_id": prompt.latest_version_id,
                    "creation_prompt_variable_values": {
                        "主体": "水晶犬",
                        "场景": "森林",
                    },
                },
                updated_at="2026-08-29T00:00:00+00:00",
            ),
        ),
    )
    atomic_write_json(
        _document_path(project.project_id),
        stored.model_copy(update={"nodes": [*stored.nodes, draft_node]}).model_dump(mode="json"),
    )

    latest = create_prompt_version(prompt.asset_id, [
        {"kind": "variable", "name": "主体", "default_value": "白犬"},
        {"kind": "text", "text": "，"},
        {"kind": "variable", "name": "风格", "default_value": "像素风"},
    ])
    unchanged = read_canvas_document(project.project_id)
    assert all(
        unchanged.content_versions[node.data.current_version_id].origin.asset_version_id
        == prompt.latest_version_id
        for node in unchanged.nodes
        if getattr(node.data, "current_version_id", None)
    )

    current_only = client.post(
        f"/api/canvas/projects/{project.project_id}/creation-assets/{prompt.asset_id}/update-references",
        headers={"If-Match": "2"},
        json={"node_id": first_node_id, "scope": "current"},
    )
    assert current_only.status_code == 200, current_only.json()
    current_document = current_only.json()
    first_node = next(node for node in current_document["nodes"] if node["id"] == first_node_id)
    second_node = next(node for node in current_document["nodes"] if node["id"] == second_node_id)
    first_version = current_document["content_versions"][first_node["data"]["current_version_id"]]
    second_version = current_document["content_versions"][second_node["data"]["current_version_id"]]
    assert first_version["text"] == "机械犬，像素风"
    assert first_version["origin"]["asset_version_id"] == latest.latest_version_id
    assert first_version["origin"]["variable_values"] == {"主体": "机械犬"}
    assert second_version["origin"]["asset_version_id"] == prompt.latest_version_id

    update_all = client.post(
        f"/api/canvas/projects/{project.project_id}/creation-assets/{prompt.asset_id}/update-references",
        headers={"If-Match": "3"},
        json={"node_id": first_node_id, "scope": "all"},
    )
    assert update_all.status_code == 200, update_all.json()
    all_document = update_all.json()
    second_node = next(node for node in all_document["nodes"] if node["id"] == second_node_id)
    second_version = all_document["content_versions"][second_node["data"]["current_version_id"]]
    assert second_version["text"] == "火焰犬，像素风"
    assert second_version["origin"]["asset_version_id"] == latest.latest_version_id
    updated_draft = next(
        node for node in all_document["nodes"] if node["id"] == "draft-reference"
    )["data"]["generation_draft"]
    assert updated_draft["prompt"] == "水晶犬，像素风"
    assert updated_draft["params"]["creation_prompt_version_id"] == latest.latest_version_id
    assert updated_draft["params"]["creation_prompt_variable_values"] == {"主体": "水晶犬"}
