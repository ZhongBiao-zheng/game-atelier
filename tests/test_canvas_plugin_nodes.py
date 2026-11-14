"""画布文档里的插件节点：连线规则，以及插件停用后文档照常读写。"""
from __future__ import annotations

import json

import pytest

from character_workflow.lib import plugin_registry
from character_workflow.lib.schemas import CanvasDocument
from tests.local_client import LocalTestClient as TestClient
from tests.plugin_fixtures import manifest, use_plugins_root, write_plugin
from viewer_server.server_app import build_app

NODE = manifest()["contributes"]["nodes"][0]


def demo_plugin(root, **node_overrides):
    write_plugin(root, contributes={"nodes": [{**NODE, "input_modalities": ["text"], **node_overrides}]})


@pytest.fixture
def root(tmp_path, monkeypatch):
    path = tmp_path / "plugins"
    use_plugins_root(monkeypatch, path)
    return path


@pytest.fixture
def client(root, tmp_path):
    return TestClient(app=build_app(dist_dir=tmp_path / "dist"), base_url="http://127.0.0.1")


def text_node(node_id: str) -> dict:
    return {
        "id": node_id, "title": node_id, "type": "text", "position": {"x": 0, "y": 0}, "z_index": 0,
        "data": {"current_version_id": None, "generation_draft": None, "active_run_id": None,
                 "display": {"scale": "sm"}},
    }


def plugin_node(node_id: str = "sheet-1", **data) -> dict:
    return {
        "id": node_id, "title": "演示", "type": "plugin", "position": {"x": 400, "y": 0}, "z_index": 0,
        "size": {"width": 320, "height": 240},
        "data": {"plugin_id": "demo", "node_type": "demo", "plugin_version": "1.0.0",
                 "data_schema_version": 1, "payload": {"frames": 4}, "generation_draft": None, **data},
    }


def edge(source: str, target: str = "sheet-1", **extra) -> dict:
    return {"id": f"{source}-{target}", "role": "input", "source_node_id": source,
            "target_node_id": target, **extra}


def new_project(client) -> dict:
    project = client.post("/api/canvas/projects", json={"name": "插件测试"}).json()
    return client.get(f"/api/canvas/projects/{project['project_id']}/document").json()


def save(client, document: dict, **changes):
    payload = {**document, **changes}
    return client.put(f"/api/canvas/projects/{document['project_id']}/document", json=payload,
                      headers={"If-Match": str(document["revision"])})


def test_plugin_node_without_digest_still_validates():
    document = {
        "schema_version": 2, "project_id": "p", "revision": 1, "updated_at": "2026-08-23T00:00:00+00:00",
        "nodes": [plugin_node()], "connections": [], "content_versions": {},
    }
    parsed = CanvasDocument.model_validate(document)
    assert parsed.nodes[0].data.package_digest is None
    with pytest.raises(ValueError):
        CanvasDocument.model_validate({**document, "nodes": [plugin_node(package_digest="not-a-digest")]})


def test_enabled_plugin_accepts_a_declared_input(client, root):
    demo_plugin(root)
    plugin_registry.set_enabled("demo", True)
    document = new_project(client)
    response = save(client, document, nodes=[text_node("t1"), plugin_node()], connections=[edge("t1")])
    assert response.status_code == 200, response.text
    assert len(response.json()["connections"]) == 1


def test_disabled_plugin_rejects_new_connections_but_keeps_the_node(client, root):
    demo_plugin(root)
    document = new_project(client)
    saved = save(client, document, nodes=[text_node("t1"), plugin_node()])
    assert saved.status_code == 200, saved.text
    rejected = save(client, saved.json(), connections=[edge("t1")])
    assert rejected.status_code == 422
    assert rejected.json()["detail"]["code"] == "canvas_plugin_connection_rejected"


def test_document_with_plugin_node_survives_disabling_and_removing_the_plugin(client, root):
    demo_plugin(root)
    plugin_registry.set_enabled("demo", True)
    document = new_project(client)
    saved = save(client, document, nodes=[text_node("t1"), plugin_node()], connections=[edge("t1")]).json()

    plugin_registry.set_enabled("demo", False)
    reopened = client.get(f"/api/canvas/projects/{saved['project_id']}/document")
    assert reopened.status_code == 200
    moved = [{**node, "position": {"x": 900, "y": 50}} if node["type"] == "plugin" else node
             for node in reopened.json()["nodes"]]
    resaved = save(client, reopened.json(), nodes=moved)
    assert resaved.status_code == 200, resaved.text
    kept = next(node for node in resaved.json()["nodes"] if node["type"] == "plugin")
    assert kept["data"]["payload"] == {"frames": 4} and kept["position"]["x"] == 900
    assert len(resaved.json()["connections"]) == 1

    # 插件目录整个不在了（换机器、旧版本）：同样读得出、存得回。
    (root / "demo" / "package" / "manifest.lock.json").unlink()
    gone = client.get(f"/api/canvas/projects/{saved['project_id']}/document")
    assert gone.status_code == 200
    assert save(client, gone.json(), nodes=gone.json()["nodes"]).status_code == 200


def test_input_must_match_declared_modalities(client, root):
    demo_plugin(root, input_modalities=["image"])
    plugin_registry.set_enabled("demo", True)
    document = new_project(client)
    response = save(client, document, nodes=[text_node("t1"), plugin_node()], connections=[edge("t1")])
    assert response.status_code == 422
    assert "不接收这种素材" in response.json()["detail"]["message"]


def test_max_inputs_is_enforced_for_new_connections(client, root):
    demo_plugin(root, max_inputs=1)
    plugin_registry.set_enabled("demo", True)
    document = new_project(client)
    nodes = [text_node("t1"), text_node("t2"), plugin_node()]
    first = save(client, document, nodes=nodes, connections=[edge("t1")])
    assert first.status_code == 200, first.text
    second = save(client, first.json(), connections=[edge("t1"), edge("t2")])
    assert second.status_code == 422 and "最多连接 1 个素材" in second.json()["detail"]["message"]


def test_unknown_node_type_of_enabled_plugin_rejects_connections(client, root):
    demo_plugin(root)
    plugin_registry.set_enabled("demo", True)
    document = new_project(client)
    response = save(client, document, nodes=[text_node("t1"), plugin_node(node_type="ghost")],
                    connections=[edge("t1")])
    assert response.status_code == 422


@pytest.mark.parametrize("extra", [{"slot": "first_frame"}, {"annotated": True}])
def test_plugin_inputs_are_plain_connections_only(client, root, extra):
    demo_plugin(root)
    plugin_registry.set_enabled("demo", True)
    document = new_project(client)
    response = save(client, document, nodes=[text_node("t1"), plugin_node()], connections=[edge("t1", **extra)])
    assert response.status_code == 422


def test_plugin_node_cannot_be_an_input_source(client, root):
    demo_plugin(root)
    plugin_registry.set_enabled("demo", True)
    document = new_project(client)
    response = save(client, document, nodes=[text_node("t1"), plugin_node()],
                    connections=[edge("sheet-1", "t1")])
    assert response.status_code == 422


def test_oversized_payload_is_rejected_without_touching_the_saved_document(client, root):
    demo_plugin(root)
    document = new_project(client)
    saved = save(client, document, nodes=[plugin_node()]).json()
    huge = plugin_node(payload={"blob": "x" * (256 * 1024)})
    assert save(client, saved, nodes=[huge]).status_code == 422
    stored = client.get(f"/api/canvas/projects/{saved['project_id']}/document").json()
    assert json.dumps(stored["nodes"][0]["data"]["payload"]) == '{"frames": 4}'
