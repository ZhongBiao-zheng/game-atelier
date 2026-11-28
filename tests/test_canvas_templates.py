import io
import json

import pytest
from PIL import Image

from character_workflow.lib import canvas_projects as projects, canvas_templates as templates, trash
from character_workflow.lib.schemas import CanvasDocument
from tests.local_client import LocalTestClient
from tests.test_canvas_paste_routes import _png, _source_canvas
from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root):
    return LocalTestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def source_group():
    pid, image, text, vid = _source_canvas()
    doc = projects.read_canvas_document(pid)
    # Same image in a historical version. It must not acquire an entry in the template.
    _, doc, _ = projects.save_canvas_upload(pid, "old.png", ".png", _png(), "image", doc.revision)
    raw = doc.model_dump(mode="json")
    text["data"]["generation_draft"] = {"mode": "text", "prompt": "node-text", "updated_at": "now"}
    raw["nodes"] = [image, text, {**text, "id": "outside"}, {
        "id": "group", "type": "group", "title": "卡面组", "position": {"x": -24, "y": -40},
        "size": {"width": 640, "height": 300}, "data": {"member_node_ids": ["node-text", "node-image"]},
    }]
    raw["connections"] = [{"role": "input", "id": target, "source_node_id": "node-image",
                           "target_node_id": target} for target in ["outside", "node-text"]]
    projects.save_canvas_document(pid, CanvasDocument.model_validate(raw), doc.revision)
    return pid, vid


def test_snapshot_owns_only_current_media_and_internal_edges(client, isolated_data_root):
    pid, vid = source_group()
    api = "/api/library/templates"
    saved = client.post(api, json={"project_id": pid, "group_id": "group", "name": "卡面"}).json()
    directory = isolated_data_root / "library/templates" / saved["id"]
    assert saved["node_count"] == 2 and saved["revision"] == 1
    record = json.loads((directory / "template.json").read_text())
    payload = record["payload"]
    assert payload["schema_version"] == 1 and set(payload["content_versions"]) == {vid, "version-text"}
    assert (directory / payload["content_versions"][vid]["path"]).read_bytes() == _png()
    assert [e["target_node_id"] for e in payload["connections"]] == ["node-text"]
    assert Image.open(io.BytesIO(client.get(f"{api}/{saved['id']}/cover").content)).format == "WEBP"
    assert client.get(api).json()["items"] == [saved]


def test_rename_duplicate_delete_and_restore(client):
    pid, _ = source_group()
    api = "/api/library/templates"
    saved = templates.save_template(pid, "group", "卡面")
    path = f"{api}/{saved['id']}"
    assert client.patch(path, json={"name": "  "}).status_code == 422
    renamed = client.patch(path, json={"name": "新卡面"}).json()
    assert renamed["revision"] == 2
    copy = client.post(path + "/duplicate").json()
    assert copy["id"] != saved["id"] and copy["name"] == "新卡面 副本"
    removed = client.delete(path).json()["trash_id"]
    assert client.get(api).json()["items"] == [copy]
    assert client.get(f"{api}/{copy['id']}/cover").status_code == 200
    trash.restore(removed)
    assert client.get(path + "/cover").status_code == 200

