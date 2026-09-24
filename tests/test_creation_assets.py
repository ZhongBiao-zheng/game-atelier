from __future__ import annotations

import base64
import re

import pytest
from tests.local_client import LocalTestClient as TestClient

from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.canvas_library import create_canvas_prompt, save_canvas_asset
from character_workflow.lib.canvas_projects import (
    _document_path,
    create_canvas_project,
    read_canvas_document,
)
from character_workflow.lib.creation_assets import (
    CreationAssetDuplicateError,
    create_adopted_asset,
    create_media_asset_from_bytes,
    create_prompt_asset,
    creation_asset_media_path,
    delete_creation_asset,
    get_creation_asset,
    find_adopted_asset,
    find_media_asset_by_sha256,
    insert_creation_asset_into_canvas,
    new_creation_asset_id,
    store_media_blob,
    list_creation_assets,
    mark_creation_asset_used,
    migrate_legacy_canvas_libraries,
    render_prompt_segments,
    update_media_asset_from_bytes,
    update_prompt_asset,
)
from character_workflow.lib.schemas import (
    TEAM_ASSET_ID_PATTERN,
    AdoptionOrigin,
    CanvasGenerationDraft,
    CanvasImageNode,
    CanvasLibraryAsset,
    CanvasMediaNodeData,
    CanvasMediaVersion,
    CanvasPoint,
    CanvasPrompt,
    CanvasUploadOrigin,
    CreationAsset,
    RevisionedSidecar,
    TeamAssetAuthor,
)
from character_workflow.lib.prompt_variables import build_prompt_variable_template
from viewer_server.server_app import build_app


_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


@pytest.fixture
def client(isolated_data_root):
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


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


def test_media_assets_are_deduplicated_and_edit_in_place():
    created = create_media_asset_from_bytes(
        title="测试图",
        body=_PNG,
        filename="test.png",
        mime_type="image/png",
        tags=["测试"],
    )
    with pytest.raises(CreationAssetDuplicateError) as duplicate:
        create_media_asset_from_bytes(
            title="另一个名字",
            body=_PNG,
            filename="copy.png",
            mime_type="image/png",
            tags=[],
        )
    assert duplicate.value.asset_id == created.asset_id

    updated = update_media_asset_from_bytes(
        created.asset_id,
        title="改名后的图",
        tags=["新标签"],
    )
    assert updated.asset_id == created.asset_id
    assert updated.content == created.content
    assert updated.title == "改名后的图"

    old_blob = creation_asset_media_path(created.asset_id)
    replaced = update_media_asset_from_bytes(
        created.asset_id,
        title="替换后的图",
        tags=["新标签"],
        body=_PNG + b"replacement",
        filename="replacement.png",
        mime_type="image/png",
    )
    assert replaced.asset_id == created.asset_id
    assert creation_asset_media_path(created.asset_id).is_file()
    assert not old_blob.exists()


def test_physical_delete_removes_catalog_entry_and_orphan_blob():
    created = create_media_asset_from_bytes(
        title="待删除",
        body=_PNG,
        filename="delete.png",
        mime_type="image/png",
        tags=[],
    )
    blob = creation_asset_media_path(created.asset_id)
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
        ("media", "旧图片"),
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
        "/api/creation-assets/media/upload",
        files={"file": ("dog.png", _PNG, "image/png")},
        data={"title": "地狱犬", "tags": '["角色"]'},
    )
    assert image.status_code == 201, image.json()
    image_asset = image.json()
    content = client.get(f"/api/creation-assets/{image_asset['asset_id']}/content")
    assert content.status_code == 200
    assert content.content == _PNG

    obsolete = client.post(f"/api/creation-assets/{prompt['asset_id']}/archive")
    assert obsolete.status_code == 403
    assert obsolete.json()["error"]["code"] == "CAPABILITY_DENIED"
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
    assert frozen["text"] == build_prompt_variable_template(
        prompt.content.segments, {"主体": "机械犬"},
    )
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


def test_media_asset_can_become_reference_for_active_canvas_generation(client: TestClient):
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
    asset = create_media_asset_from_bytes(
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


def test_media_asset_accepts_mp4(client):
    body = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 64
    response = client.post("/api/creation-assets/media/upload",
        files={"file": ("clip.mp4", body, "video/mp4")}, data={"title": "片段", "tags": "[]"})
    assert response.status_code == 201, response.text
    assert response.json()["content"]["mime_type"] == "video/mp4"


# 最小的合法 ISO BMFF：ftyp + 带 tkhd 的 moov，tkhd 里宽高是 16.16 定点数。
def _mp4_bytes(width: int = 640, height: int = 360) -> bytes:
    import struct
    tkhd_body = (
        b"\x00" + b"\x00" * 3          # version 0 + flags
        + b"\x00" * 4 * 4              # created / modified / track_id / reserved
        + b"\x00" * 4                  # duration
        + b"\x00" * 8                  # reserved
        + b"\x00" * 2 * 4              # layer / alternate_group / volume / reserved
        + b"\x00" * 36                 # matrix
        + struct.pack(">II", width << 16, height << 16)
    )
    tkhd = struct.pack(">I", 8 + len(tkhd_body)) + b"tkhd" + tkhd_body
    trak = struct.pack(">I", 8 + len(tkhd)) + b"trak" + tkhd
    moov = struct.pack(">I", 8 + len(trak)) + b"moov" + trak
    ftyp = b"ftypisom\x00\x00\x02\x00"
    return struct.pack(">I", 4 + len(ftyp)) + ftyp + moov


_MP3 = b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\x00" * 64


def test_mp4_asset_inserts_into_canvas_as_a_video_node():
    project = create_canvas_project("视频画布")
    asset = create_media_asset_from_bytes(
        title="片段", body=_mp4_bytes(), filename="clip.mp4", mime_type="video/mp4", tags=[],
    )

    document = insert_creation_asset_into_canvas(
        project_id=project.project_id,
        asset_id=asset.asset_id,
        position=CanvasPoint(x=0, y=0),
        expected_revision=0,
    )

    node = document.nodes[0]
    version = document.content_versions[node.data.current_version_id]
    assert node.type == "video"
    assert version.kind == "video"
    assert version.mime_type == "video/mp4"
    assert (version.width, version.height) == (640, 360)


def test_mp3_asset_inserts_into_canvas_as_an_audio_node():
    project = create_canvas_project("音频画布")
    asset = create_media_asset_from_bytes(
        title="配乐", body=_MP3, filename="bgm.mp3", mime_type="audio/mpeg", tags=[],
    )

    document = insert_creation_asset_into_canvas(
        project_id=project.project_id,
        asset_id=asset.asset_id,
        position=CanvasPoint(x=0, y=0),
        expected_revision=0,
    )

    node = document.nodes[0]
    version = document.content_versions[node.data.current_version_id]
    assert node.type == "audio"
    assert version.kind == "audio"
    assert version.mime_type == "audio/mpeg"
    assert version.width is None and version.height is None


def test_non_image_media_cannot_feed_a_generation_panel(client: TestClient):
    project = create_canvas_project("生成画布")
    current = read_canvas_document(project.project_id)
    target = CanvasImageNode(
        id="image-target", title="待生成", type="image", position=CanvasPoint(x=0, y=0), z_index=0,
        data=CanvasMediaNodeData(generation_draft=CanvasGenerationDraft(
            mode="image", prompt="", model="gpt-image-2", updated_at="2026-08-29T00:00:00+00:00",
        )),
    )
    atomic_write_json(
        _document_path(project.project_id),
        current.model_copy(update={"nodes": [target]}).model_dump(mode="json"),
    )
    asset = create_media_asset_from_bytes(
        title="片段", body=_mp4_bytes(), filename="clip.mp4", mime_type="video/mp4", tags=[],
    )

    response = client.post(
        f"/api/canvas/projects/{project.project_id}/creation-assets/{asset.asset_id}/insert",
        headers={"If-Match": "0"},
        json={"position": {"x": 30, "y": 40}, "target_node_id": target.id},
    )
    assert response.status_code == 422, response.text


def test_m4a_trusts_the_declared_audio_mime_for_a_plain_mp4_brand():
    asset = create_media_asset_from_bytes(
        title="人声", body=_mp4_bytes(), filename="voice.m4a", mime_type="audio/mp4", tags=[],
    )
    assert asset.content.mime_type == "audio/mp4"
    assert asset.content.path.endswith(".m4a")


def test_adopted_assets_round_trip_through_the_catalog():
    origin = AdoptionOrigin(
        library_id="lib_" + "a" * 16,
        asset_id="ta_" + "0" * 26,
        source_updated_at="2026-09-20T00:00:00Z",
        raw_path=None,
    )
    asset_id = new_creation_asset_id()
    assert asset_id.startswith("creation-asset-")
    assert asset_id != new_creation_asset_id()

    content = store_media_blob(_PNG, "adopted.png", "image/png")
    adopted = create_adopted_asset(CreationAsset(
        asset_id=asset_id,
        kind="media",
        title="团队图",
        tags=["团队"],
        created_at="2026-09-20T00:00:00Z",
        updated_at="2026-09-20T00:00:00Z",
        content=content,
        adopted_from=origin,
    ))

    assert find_adopted_asset(origin.library_id, origin.asset_id).asset_id == adopted.asset_id
    assert find_adopted_asset(origin.library_id, "ta_" + "1" * 26) is None
    assert find_adopted_asset("lib_" + "b" * 16, origin.asset_id) is None
    assert find_media_asset_by_sha256(content.sha256).asset_id == adopted.asset_id
    assert find_media_asset_by_sha256("f" * 64) is None
    with pytest.raises(ValueError, match="already exists"):
        create_adopted_asset(adopted)


def test_team_asset_id_pattern_accepts_crockford_ulid_only():
    base = "ta_" + "0" * 26
    AdoptionOrigin(library_id="lib_" + "a" * 16, asset_id=base, source_updated_at="t")
    TeamAssetAuthor(display_name="飙哥")
    assert re.fullmatch(TEAM_ASSET_ID_PATTERN, base)
    assert re.fullmatch(TEAM_ASSET_ID_PATTERN, "ta_01JZ9KHVTPQRSXYZABCDEFGHJK")
    for bad in ("ta_" + "0" * 25, "ta_" + "I" * 26, "ta_" + "l" * 26, "ta_" + "u" * 26):
        assert re.fullmatch(TEAM_ASSET_ID_PATTERN, bad) is None


# ---- 重新采用：覆盖本机副本 ----

def _png_of(color) -> bytes:
    from io import BytesIO

    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (2, 2), color).save(buffer, format="PNG")
    return buffer.getvalue()


def _adopted_media(body: bytes, *, raw_path: str | None = None, **overrides) -> CreationAsset:
    origin = AdoptionOrigin(
        library_id="lib_" + "a" * 16,
        asset_id="raw_1" if raw_path else "ta_" + "0" * 26,
        source_updated_at="2026-09-20T00:00:00Z",
        raw_path=raw_path,
    )
    return create_adopted_asset(CreationAsset(**{
        "asset_id": new_creation_asset_id(),
        "kind": "media",
        "title": "团队图",
        "tags": ["团队"],
        "created_at": "2026-09-20T00:00:00Z",
        "updated_at": "2026-09-20T00:00:00Z",
        "content": store_media_blob(body, "a.png", "image/png"),
        "project_ids": ["p1"],
        "adopted_from": origin,
        **overrides,
    }))


def _newer_origin(asset: CreationAsset) -> AdoptionOrigin:
    return asset.adopted_from.model_copy(update={"source_updated_at": "2026-09-21T00:00:00Z"})


def test_replace_adopted_asset_overwrites_content_and_keeps_identity(isolated_data_root):
    from character_workflow.lib.creation_assets import replace_adopted_asset

    old_body, new_body = _png_of((1, 2, 3)), _png_of((4, 5, 6))
    asset = mark_creation_asset_used(_adopted_media(old_body).asset_id, "p2")
    old_path = creation_asset_media_path(asset.asset_id)
    content = store_media_blob(new_body, "b.png", "image/png")
    replaced = replace_adopted_asset(
        asset.asset_id, title="  新图 ", tags=["新", "新"], content=content,
        adopted_from=_newer_origin(asset),
    )
    assert replaced.asset_id == asset.asset_id and replaced.created_at == asset.created_at
    assert replaced.project_ids == ["p1", "p2"] and replaced.last_used_at == asset.last_used_at
    assert replaced.title == "新图" and replaced.tags == ["新"]
    assert replaced.content == content
    assert replaced.adopted_from.source_updated_at == "2026-09-21T00:00:00Z"
    assert replaced.updated_at != asset.updated_at
    assert list_creation_assets().assets == [replaced]
    assert not old_path.exists()
    assert creation_asset_media_path(asset.asset_id).read_bytes() == new_body


def test_replace_adopted_asset_keeps_blob_still_used_elsewhere(isolated_data_root):
    from character_workflow.lib.creation_assets import replace_adopted_asset

    shared = _png_of((7, 8, 9))
    from character_workflow.lib.creation_assets import create_generation_asset
    from character_workflow.lib.schemas import GenerationRecipe

    asset = _adopted_media(shared)
    old_path = creation_asset_media_path(asset.asset_id)
    # 另一条生成资产的参考也用着这份 blob：不能当孤儿删。
    output = store_media_blob(_png_of((0, 0, 0)), "out.png", "image/png")
    create_generation_asset(
        title="生成", tags=[], media=output,
        snapshot=GenerationRecipe(
            mode="image", model="m", final_prompt="p", submitted_at="2026-09-20T00:00:00Z",
            inputs=[{"order": 0, "role": "reference", "kind": "image",
                     "sha256": asset.content.sha256, "mime_type": "image/png"}],
        ),
    )
    replace_adopted_asset(
        asset.asset_id, title="团队图", tags=[],
        content=store_media_blob(_png_of((9, 9, 9)), "c.png", "image/png"),
        adopted_from=_newer_origin(asset),
    )
    assert old_path.is_file()


def test_replace_adopted_asset_rejects_local_missing_and_blobless(isolated_data_root):
    from character_workflow.lib.creation_assets import replace_adopted_asset

    local = create_media_asset_from_bytes(
        title="本机", body=_png_of((1, 1, 1)), filename="l.png", mime_type="image/png", tags=[],
    )
    adopted = _adopted_media(_png_of((2, 2, 2)))
    content = store_media_blob(_png_of((3, 3, 3)), "n.png", "image/png")
    with pytest.raises(ValueError):
        replace_adopted_asset(
            local.asset_id, title="x", tags=[], content=content,
            adopted_from=adopted.adopted_from,
        )
    with pytest.raises(KeyError):
        replace_adopted_asset(
            "creation-asset-missing", title="x", tags=[], content=content,
            adopted_from=adopted.adopted_from,
        )
    ghost = content.model_copy(update={
        "sha256": "e" * 64, "path": f"creation-assets/blobs/{'e' * 64}.png",
    })
    with pytest.raises(FileNotFoundError):
        replace_adopted_asset(
            adopted.asset_id, title="x", tags=[], content=ghost,
            adopted_from=adopted.adopted_from,
        )
    assert get_creation_asset(adopted.asset_id) == adopted


def test_replace_adopted_raw_asset_rejects_content_already_in_library(isolated_data_root):
    """原始文件按内容去重：新内容已是另一条媒体资产，就不能再覆盖出第二份。"""
    from character_workflow.lib.creation_assets import replace_adopted_asset

    taken = _png_of((5, 5, 5))
    existing = create_media_asset_from_bytes(
        title="已有", body=taken, filename="t.png", mime_type="image/png", tags=[],
    )
    asset = _adopted_media(_png_of((6, 6, 6)), raw_path="concept/castle.png")
    with pytest.raises(CreationAssetDuplicateError) as caught:
        replace_adopted_asset(
            asset.asset_id, title="castle.png", tags=[],
            content=store_media_blob(taken, "castle.png", "image/png"),
            adopted_from=_newer_origin(asset),
        )
    assert caught.value.asset_id == existing.asset_id
