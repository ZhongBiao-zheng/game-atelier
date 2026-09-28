"""跨画布粘贴：源画布的媒体版本复制进目标画布 uploads/，节点里的版本引用整体换新。"""
from __future__ import annotations

import io

import pytest
from PIL import Image
from tests.local_client import LocalTestClient as TestClient

from character_workflow.lib.canvas_projects import (
    canvas_project_dir,
    create_canvas_project,
    read_canvas_document,
    save_canvas_document,
    save_canvas_upload,
)
from character_workflow.lib.schemas import (
    CanvasImageNode,
    CanvasMediaNodeData,
    CanvasPoint,
    CanvasTextNode,
    CanvasTextNodeData,
    CanvasTextVersion,
    CanvasUserEditOrigin,
)
from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root):
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def _png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (6, 4), (10, 200, 10)).save(buffer, format="PNG")
    return buffer.getvalue()


def _source_canvas() -> tuple[str, dict, dict, str]:
    """源画布：一张上传图 + 一段文本，返回 (project_id, image_node, text_node, media_version_id)。"""
    project = create_canvas_project("源")
    document = read_canvas_document(project.project_id)
    version, document, _ = save_canvas_upload(
        project.project_id, "card.png", ".png", _png(), "image", document.revision,
    )
    text_version = CanvasTextVersion(
        version_id="version-text", created_at=document.updated_at, sha256="0" * 64,
        origin=CanvasUserEditOrigin(kind="user_edit"), kind="text", text="一段说明",
    )
    image = CanvasImageNode(
        id="node-image", type="image", title="卡面", position=CanvasPoint(x=0, y=0),
        data=CanvasMediaNodeData(current_version_id=version.version_id),
    )
    text = CanvasTextNode(
        id="node-text", type="text", title="说明", position=CanvasPoint(x=300, y=0),
        data=CanvasTextNodeData(current_version_id=text_version.version_id),
    )
    save_canvas_document(project.project_id, document.model_copy(update={
        "nodes": [image, text],
        "content_versions": {**document.content_versions, text_version.version_id: text_version},
    }), document.revision)
    return (
        project.project_id,
        image.model_dump(mode="json"),
        text.model_dump(mode="json"),
        version.version_id,
    )


def _paste(client, target: str, body: dict, revision: int | None = 0):
    headers = {} if revision is None else {"If-Match": f'"{revision}"'}
    return client.post(f"/api/canvas/projects/{target}/paste", json=body, headers=headers)


def test_paste_copies_media_into_target_and_rewrites_version_references(client):
    source_id, image, text, media_version = _source_canvas()
    target = create_canvas_project("目标")
    pasted_image = {**image, "id": "pasted-image", "position": {"x": 40, "y": 40}}
    pasted_text = {**text, "id": "pasted-text"}

    resp = _paste(client, target.project_id, {
        "source_project_id": source_id,
        "nodes": [pasted_image, pasted_text],
        "connections": [{
            "id": "pasted-link", "role": "input",
            "source_node_id": "pasted-image", "target_node_id": "pasted-text",
        }],
    })

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["revision"] == 1 and resp.headers["ETag"] == '"1"'
    assert [node["id"] for node in body["nodes"]] == ["pasted-image", "pasted-text"]
    new_media = body["nodes"][0]["data"]["current_version_id"]
    new_text = body["nodes"][1]["data"]["current_version_id"]
    assert new_media != media_version and new_media in body["content_versions"]
    assert new_text != "version-text" and body["content_versions"][new_text]["text"] == "一段说明"
    copied = body["content_versions"][new_media]
    assert copied["origin"]["kind"] == "upload" and copied["width"] == 6 and copied["height"] == 4
    assert (canvas_project_dir(target.project_id) / copied["path"]).read_bytes() == _png()
    assert body["connections"][0]["id"] == "pasted-link"
    # 目标画布能按自己的版本 id 出图；源画布不受影响。
    media = client.get(f"/api/canvas/projects/{target.project_id}/versions/{new_media}/media")
    assert media.status_code == 200
    assert len(read_canvas_document(source_id).nodes) == 2


def test_paste_rejects_same_canvas_stale_revision_and_missing_source(client):
    source_id, image, _text, _version = _source_canvas()
    target = create_canvas_project("目标")
    body = {"source_project_id": source_id, "nodes": [{**image, "id": "p"}], "connections": []}

    assert _paste(client, target.project_id, body, revision=None).status_code == 428
    conflict = _paste(client, target.project_id, body, revision=7)
    assert conflict.status_code == 409 and conflict.json()["detail"]["code"] == "revision_conflict"
    same = _paste(client, source_id, body)
    assert same.status_code == 422
    missing = _paste(client, target.project_id, {**body, "source_project_id": "canvas-nope"})
    assert missing.status_code == 404


def test_paste_rejects_node_ids_already_in_target(client):
    source_id, image, _text, _version = _source_canvas()
    target = create_canvas_project("目标")
    document = read_canvas_document(target.project_id)
    existing = CanvasImageNode(
        id="taken", type="image", title="已有", position=CanvasPoint(x=0, y=0),
        data=CanvasMediaNodeData(),
    )
    save_canvas_document(target.project_id, document.model_copy(update={"nodes": [existing]}), 0)

    resp = _paste(client, target.project_id, {
        "source_project_id": source_id, "nodes": [{**image, "id": "taken"}], "connections": [],
    }, revision=1)

    assert resp.status_code == 422
