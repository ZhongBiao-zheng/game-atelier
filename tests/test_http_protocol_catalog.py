"""目录发现：按自定义接口模板的 catalog 经 models-preview 拉模型列表（ADR-0036）。"""
import copy

import pytest

from character_workflow.lib import http_protocols, keys
from tests.fake_http_vendor import FakeVendor
from tests.local_client import LocalTestClient as TestClient
from viewer_server.server_app import build_app

SECRET = "sk-catalog-secret-0123"
DOC = {
    "version": 1, "name": "目录接口", "kind": "image",
    "auth": {"type": "query", "name": "key"},
    "submit": {"path": "/api/gen", "headers": {"X-Api-Version": "2"},
               "body": {"model": "$model", "prompt": "$prompt"}},
    "result": {"urls": ["data.*.url"]},
    "catalog": {"path": "/api/models/list", "items": "result.items", "id": "model_name",
                "name": "display", "kind": {"field": "tags",
                                            "map": {"t2i": "image", "embed": "excluded"}}},
}
LISTING = {"result": {"items": [
    {"model_name": "painter-v2", "display": "Painter V2", "tags": ["new", "t2i"],
     "pricing": {"per_image": 0.5}},
    {"model_name": "painter-v2", "display": "dup"},
    {"model_name": "embedder", "tags": "embed"},
    {"model_name": "mystery-x", "tags": ["other"]},
    {"display": "no id"},
]}}


@pytest.fixture
def client(isolated_data_root):
    return TestClient(base_url="http://127.0.0.1", app=build_app())


@pytest.fixture
def vendor():
    with FakeVendor() as server:
        yield server


def protocol_id(document=DOC) -> str:
    return http_protocols.save_protocol(copy.deepcopy(document)).id


def preview(client, vendor, identifier, **extra):
    return client.post("/api/keys/models-preview", json={
        "provider": "custom", "base_url": vendor.url, "access_key": SECRET,
        "protocol_id": identifier, **extra,
    })


def test_discovers_models_with_template_auth_items_and_kind_map(client, vendor):
    vendor.on("GET", "/api/models/list", LISTING)
    response = preview(client, vendor, protocol_id())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["discovered"] is True and body["total"] == 3 and body["excluded"] == 1
    assert [(m["id"], m["name"], m["category"], m["modality"], m["protocol"])
            for m in body["models"]] == [
        ("painter-v2", "Painter V2", "image", "image", None),
        ("mystery-x", "mystery-x", "unknown", None, None),
    ]
    assert "pricing" not in str(body) and "0.5" not in str(body)  # 价格字段不读
    [call] = vendor.received
    assert call.method == "GET" and call.query == f"key={SECRET}"
    assert call.headers["X-Api-Version"] == "2" and call.body == b""


def test_include_all_keeps_excluded_rows(client, vendor):
    vendor.on("GET", "/api/models/list", LISTING)
    body = preview(client, vendor, protocol_id(), include_all=True).json()
    assert [m["category"] for m in body["models"]] == ["image", "excluded", "unknown"]


def test_falls_back_to_existing_classifier_without_kind(client, vendor):
    document = copy.deepcopy(DOC)
    document["catalog"] = {"path": "/models"}
    vendor.on("GET", "/models", [{"id": "seedream-5"}, {"id": "kling-video-2"}])
    body = preview(client, vendor, protocol_id(document)).json()
    assert [(m["id"], m["category"]) for m in body["models"]] == [
        ("seedream-5", "image"), ("kling-video-2", "video")]


@pytest.mark.parametrize("status, payload, expected", [
    (302, {}, "不跟随重定向"),
    (401, {"error": "bad key " + SECRET}, "目录 401"),
    (200, {"result": {"items": {"a": 1}}}, "不是数组"),
    (200, b"<html>", "不是 JSON"),
])
def test_errors_are_reported_without_leaking_the_key(client, vendor, status, payload, expected):
    headers = {"Location": "https://evil.example/"} if status == 302 else {}
    vendor.on("GET", "/api/models/list", (status, payload, headers))
    response = preview(client, vendor, protocol_id())
    assert response.status_code == 502
    assert expected in response.json()["detail"]
    assert SECRET not in response.text
    assert len(vendor.received) == 1  # 不跟随重定向，也不重试


def test_oversized_catalog_is_rejected(client, vendor, monkeypatch):
    from character_workflow.lib import http_protocol_catalog

    monkeypatch.setattr(http_protocol_catalog, "RESPONSE_LIMIT", 100)
    vendor.on("GET", "/api/models/list", LISTING)
    response = preview(client, vendor, protocol_id())
    assert response.status_code == 502 and "过大" in response.json()["detail"]


def test_base_url_goes_through_the_outbound_guard(client):
    response = client.post("/api/keys/models-preview", json={
        "provider": "custom", "base_url": "http://169.254.169.254", "access_key": SECRET,
        "protocol_id": protocol_id(),
    })
    assert response.status_code == 502
    assert SECRET not in response.text


def test_template_without_catalog_or_missing_is_422(client, vendor):
    document = copy.deepcopy(DOC)
    del document["catalog"]
    response = preview(client, vendor, protocol_id(document))
    assert response.status_code == 422 and "catalog" in response.json()["detail"]
    assert preview(client, vendor, "hp-000000000000").status_code == 422
    assert vendor.received == []


def test_only_custom_providers_can_discover_by_template(client, vendor):
    response = preview(client, vendor, protocol_id(), provider="openrouter")
    assert response.status_code == 400
    assert vendor.received == []


def test_stored_key_is_used_without_sending_it_from_the_browser(client, vendor):
    identifier = protocol_id()
    keys.add_key(keys.KeySpec(alias="vendor", provider="custom", base_url=vendor.url,
                              access_key=SECRET, models=[], created_at="test"))
    vendor.on("GET", "/api/models/list", LISTING)
    response = client.post("/api/keys/models-preview",
                           json={"alias": "vendor", "protocol_id": identifier})
    assert response.status_code == 200, response.text
    assert vendor.received[0].query == f"key={SECRET}"


def test_listing_marks_templates_with_a_catalog(client):
    with_catalog = protocol_id()
    document = copy.deepcopy(DOC)
    del document["catalog"]
    without = protocol_id(document)
    rows = {row["id"]: row["catalog"]
            for row in client.get("/api/http-protocols").json()["protocols"]}
    assert rows == {with_catalog: True, without: False}
