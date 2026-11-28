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



def test_paste_twice_after_source_deletion_keeps_media_draft_and_internal_edges(client):
    from character_workflow.lib.canvas_packages import delete_canvas_project
    pid, _ = source_group()
    saved = templates.save_template(pid, "group", "卡面")
    delete_canvas_project(pid, projects.read_canvas_document(pid).revision)
    target = projects.create_canvas_project("目标").project_id
    path = f"/api/canvas/projects/{target}/templates/{saved['id']}/paste"
    center = {"x": 50, "y": 80}
    groups, node_ids, version_ids, edges, files = set(), set(), set(), set(), set()
    for revision in range(2):
        res = client.post(path, json=center, headers={"If-Match": str(revision)})
        assert res.status_code == 200, res.text
        result = res.json()
        doc = result["document"]
        group = next(n for n in doc["nodes"] if n["id"] == result["group_id"])
        members = set(group["data"]["member_node_ids"])
        assert len(members) == 2 and members.isdisjoint(node_ids)
        assert group["id"] not in groups
        image, = [n for n in doc["nodes"] if n["id"] in members and n["type"] == "image"]
        text, = [n for n in doc["nodes"] if n["id"] in members and n["type"] == "text"]
        assert text["data"]["generation_draft"]["prompt"] == "node-text"
        version = doc["content_versions"][image["data"]["current_version_id"]]
        assert version["path"] not in files and version["version_id"] not in version_ids
        assert (projects.canvas_project_dir(target) / version["path"]).read_bytes() == _png()
        edge, = [e for e in doc["connections"] if e["source_node_id"] == image["id"]]
        assert edge["target_node_id"] == text["id"] and edge["id"] not in edges
        groups.add(group["id"])
        node_ids.update(members)
        files.add(version["path"])
        version_ids.add(version["version_id"])
        edges.add(edge["id"])
    assert client.post(path, json=center, headers={"If-Match": "0"}).status_code == 409
    assert len(projects.read_canvas_document(target).nodes) == 6


def test_agent_lists_and_adds_a_template_through_registered_tools():
    import asyncio
    from types import SimpleNamespace
    from character_workflow.lib import canvas_agent_runtime as agent

    source, _ = source_group()
    saved = templates.save_template(source, "group", "卡面")
    target = projects.create_canvas_project("目标").project_id
    ctx = SimpleNamespace(context=agent.TurnContext(target, "review"), tool_call_id="templates")
    tools = {tool.name: tool for tool in agent.build_tools()}
    listing, add = tools["list_templates"], tools["add_template"]
    assert listing.needs_approval is False
    items = json.loads(asyncio.run(listing.on_invoke_tool(ctx, "{}")))["templates"]
    assert items == [{"id": saved["id"], "name": "卡面", "owner": "mine", "online": True, "node_count": 2}]
    args = {"template_id": saved["id"]}
    assert asyncio.run(add.needs_approval(ctx, args, "templates"))
    result = json.loads(asyncio.run(add.on_invoke_tool(ctx, json.dumps(args))))
    group = next(n for n in projects.read_canvas_document(target).nodes if n.id == result["group_id"])
    assert ctx.context.created_node_ids == {group.id, *group.data.member_node_ids}


def test_list_keeps_creation_order_and_skips_unreadable_records(isolated_data_root, caplog, monkeypatch):
    times = iter(["2026-11-01", "2026-11-02", "2026-11-03"])
    monkeypatch.setattr(templates, "_now", lambda: next(times))
    source, _ = source_group()
    first = templates.save_template(source, "group", "第一张")
    second = templates.duplicate_template(first["id"])
    templates.rename_template(first["id"], "新名字")
    for i, content in enumerate(["{", "{}"]):
        directory = isolated_data_root / "library/templates" / f"tpl_{i:024x}"
        directory.mkdir()
        (directory / "template.json").write_text(content)
    assert [row["id"] for row in templates.list_templates()] == [second["id"], first["id"]]
    assert caplog.text.count("跳过无法读取的模板") == 2


def test_add_template_approval_summary_uses_the_saved_name():
    from character_workflow.lib.canvas_agent_runtime import summarize_call

    source, _ = source_group()
    saved = templates.save_template(source, "group", "海岸分镜")
    assert summarize_call("add_template", {"template_id": saved["id"]}) == "添加模板「海岸分镜」"
