"""自定义接口：管理接口、keys 写入边界的绑定校验、旧数据兼容、路由 / 网关 / Canvas 目录隔离。"""
import copy
import json

import pytest

from character_workflow.lib import data_root, http_protocols, keys, model_routes
from tests.local_client import LocalTestClient as TestClient
from viewer_server.server_app import build_app

DOC = {
    "version": 1, "name": "同步出图", "kind": "image", "auth": {"type": "bearer"},
    "submit": {"path": "/v1/images/${model}", "body": {"prompt": "$prompt", "ratio": "$ratio",
                                                       "n": "$n", "image": "$image"}},
    "inputs": {"images": {"max": 3}},
    "options": {"ratio": ["1:1", "3:4"], "count": 2},
    "result": {"urls": ["data.*.url"]},
}


@pytest.fixture
def client(isolated_data_root):
    return TestClient(base_url="http://127.0.0.1", app=build_app())


def create(client, document=DOC) -> str:
    response = client.post("/api/http-protocols", json={"document": copy.deepcopy(document)})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def custom_key(client, identifier, *, provider="custom", modality=None, alias="vendor"):
    model = {"id": "m1", "name": "M1", "protocol": "declarative", "declarative_id": identifier}
    if modality:
        model["modality"] = modality
    return client.post("/api/keys", json={
        "alias": alias, "provider": provider, "base_url": "https://api.example.com",
        "access_key": "sk-secret-value", "models": [model],
    })


def test_crud_roundtrip_keeps_document_verbatim(client):
    identifier = create(client)
    assert http_protocols.valid_id(identifier)
    saved = json.loads((data_root.config_dir() / "http-protocols" / f"{identifier}.json")
                       .read_text(encoding="utf-8"))
    assert saved == DOC
    row = client.get("/api/http-protocols").json()["protocols"][0]
    assert row["name"] == "同步出图" and row["available"] and row["used_by"] == []
    assert row["declared"]["ratios"] == ["1:1", "3:4"] and row["declared"]["max_count"] == 2
    assert client.get(f"/api/http-protocols/{identifier}").json()["document"] == DOC
    renamed = {**DOC, "name": "改名"}
    assert client.put(f"/api/http-protocols/{identifier}",
                      json={"document": renamed}).json()["name"] == "改名"
    assert client.delete(f"/api/http-protocols/{identifier}").status_code == 204
    assert client.get(f"/api/http-protocols/{identifier}").status_code == 404


def test_invalid_document_is_rejected_with_a_message(client):
    response = client.post("/api/http-protocols",
                           json={"document": {**DOC, "submit": {"path": "https://x.example/a"}}})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "PROTOCOL_INVALID"
    assert "submit.path" in response.json()["detail"]["message"]
    assert not list(data_root.config_dir().glob("http-protocols/*.json"))


def test_unknown_ids_are_not_paths(client):
    assert client.get("/api/http-protocols/..%2Fkeys").status_code != 200
    assert client.get("/api/http-protocols/bogus").status_code == 404
    assert client.put("/api/http-protocols/hp-000000000000",
                      json={"document": DOC}).status_code == 404
    assert client.delete("/api/http-protocols/not-an-id").status_code == 404


def test_validate_previews_without_secret(client):
    result = client.post("/api/http-protocols/validate", json={
        "document": DOC, "base_url": "https://api.vendor.example/v2", "model": "flux/pro"}).json()
    assert result["valid"] and result["issues"] == []
    submit = result["preview"]["submit"]
    assert submit["url"] == "https://api.vendor.example/v2/v1/images/flux%2Fpro"
    assert submit["headers"]["Authorization"] == "Bearer ***"
    assert submit["body"] == {"prompt": "示例提示词", "ratio": "1:1", "n": 1, "image": "<图片1>"}
    bad = client.post("/api/http-protocols/validate",
                      json={"document": {**DOC, "options": {"count": 2}}}).json()
    assert not bad["valid"] and "options.ratio" in {i["path"] for i in bad["issues"]}


def test_validate_previews_poll_and_file_parts(client):
    document = {
        "version": 1, "name": "异步", "kind": "image", "auth": {"type": "header", "name": "X-Key"},
        "submit": {"path": "/tasks", "format": "multipart", "body": {"image": "$images"}},
        "inputs": {"images": {"max": 2, "encode": "file"}},
        "poll": {"path": "/tasks/${taskId}", "task_id": "id", "status": "status",
                 "success": ["done"], "result": {"urls": ["url"]}},
    }
    preview = client.post("/api/http-protocols/validate",
                          json={"document": document}).json()["preview"]
    assert preview["submit"]["body"] == {"image": ["<文件 图片1>", "<文件 图片2>"]}
    assert preview["submit"]["headers"]["X-Key"] == "***"
    assert preview["poll"]["url"].endswith("/tasks/%3Ctask-id%3E")


def test_keys_binding_is_checked_at_the_write_boundary(client):
    identifier = create(client)
    assert custom_key(client, identifier, provider="openai").status_code == 422
    assert custom_key(client, "hp-000000000000").status_code == 422
    assert custom_key(client, identifier, modality="video").status_code == 422
    assert custom_key(client, identifier).status_code == 201
    model = keys.find_by_alias("vendor").models[0]
    assert model.protocol == "declarative" and model.modality == "image"
    assert model.declarative_id == identifier
    response = client.patch("/api/keys/vendor", json={"models": [
        {"id": "m1", "name": "M1", "protocol": "declarative"}]})
    assert response.status_code == 422
    assert client.patch("/api/keys/vendor", json={"models": [
        {"id": "m1", "name": "M1"}]}).status_code == 200
    assert keys.find_by_alias("vendor").models[0].declarative_id is None


def test_in_use_template_cannot_be_deleted_or_change_kind(client):
    identifier = create(client)
    custom_key(client, identifier)
    assert client.delete(f"/api/http-protocols/{identifier}").status_code == 409
    video = {**DOC, "kind": "video", "options": {"ratio": ["16:9"]},
             "submit": {"path": "/v", "body": {"prompt": "$prompt", "ratio": "$ratio"}}}
    video.pop("inputs")
    assert client.put(f"/api/http-protocols/{identifier}",
                      json={"document": video}).status_code == 409
    row = client.get("/api/http-protocols").json()["protocols"][0]
    assert row["used_by"] == [{"alias": "vendor", "model": "m1"}]


def test_keys_api_carries_declared_only_for_bound_models(client):
    identifier = create(client)
    custom_key(client, identifier)
    client.post("/api/keys", json={"alias": "plain", "provider": "custom",
                                   "base_url": "https://x.example", "access_key": "k",
                                   "models": [{"id": "m2", "name": "M2"}]})
    rows = {row["alias"]: row for row in client.get("/api/keys").json()["keys"]}
    declared = rows["vendor"]["models"][0]["declared"]
    assert declared["available"] and declared["name"] == "同步出图"
    assert declared["reference_images"] == 1 and declared["max_count"] == 2
    assert "declared" not in rows["plain"]["models"][0]
    assert "declarative_id" not in rows["plain"]["models"][0]


def test_old_keys_json_roundtrips_unchanged():
    raw = {"version": 1, "default_alias": None, "keys": [{
        "alias": "hk", "provider": "custom", "enabled": True,
        "base_url": "https://api.openai-hk.com/v1", "billing_group": None,
        "access_key": "k", "secret_key": None, "capabilities": [],
        "models": [{"name": "GPT", "id": "gpt-image-2", "modality": "image",
                    "protocol": "openai", "input_modalities": []}],
        "homepage_url": None, "docs_url": None, "api_key_url": None, "modalities": [],
        "notes": "", "created_at": "2026-01-01T00:00:00Z"}],
        "oss": None, "model_order": {}, "route_mode": {}}
    path = data_root.keys_file()
    path.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    keys.write_keys_db(keys.read_keys_db())
    assert json.loads(path.read_text(encoding="utf-8")) == raw


def test_routes_and_gateway_keep_declarative_models_apart(client):
    from character_workflow.lib import gateway_access

    identifier = create(client)
    custom_key(client, identifier)
    client.post("/api/keys", json={"alias": "plain", "provider": "custom",
                                   "base_url": "https://x.example", "access_key": "k",
                                   "models": [{"id": "m1", "name": "M1", "modality": "image"}]})
    routes = {route.id: route for route in model_routes.list_routes("image")}
    assert set(routes) == {"m1", f"declarative:{identifier}:m1"}
    assert gateway_access._publishable(routes["m1"])
    assert not gateway_access._publishable(routes[f"declarative:{identifier}:m1"])


def test_canvas_catalog_uses_declared_capabilities(client):
    from character_workflow.lib.canvas_model_catalog import model_rows

    identifier = create(client)
    custom_key(client, identifier)
    row = next(r for r in model_rows("image") if r["model"] == "m1")
    assert row["protocol"] == "declarative" and row["price_basis"] == "未计价"
    assert row["capabilities"]["ratio"] == ["1:1", "3:4"]
    assert row["capabilities"]["count"] == {"min": 1, "max": 2}
    assert row["reference_limits"]["image"] == 1
    assert not model_rows("video")
