import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import keys
from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root):
    return TestClient(build_app())


def _make_payload(alias: str = "lov") -> dict:
    return {
        "alias": alias, "provider": "seedream",
        "access_key": "ak", "secret_key": "sk",
        "capabilities": ["portrait"], "models": ["gpt_image_2"],
        "notes": "test", "created_at": "2026-05-22T00:00:00+08:00",
    }


def test_list_keys_returns_empty_initially(client):
    resp = client.get("/api/keys")
    assert resp.status_code == 200
    assert resp.json() == {"keys": [], "default_alias": None}


def test_create_then_list_masks_secrets(client):
    r1 = client.post("/api/keys", json=_make_payload())
    assert r1.status_code == 201, r1.text
    # POST response must NOT echo the secret back（无 Reveal 流程）。
    post_body = r1.json()
    assert "secret_revealed" not in post_body
    assert post_body["alias"] == "lov"
    body = client.get("/api/keys").json()
    assert len(body["keys"]) == 1
    k = body["keys"][0]
    assert k["alias"] == "lov"
    assert k["access_key"] != "ak"
    assert k["secret_key"] is None
    # GET response must NEVER leak the raw secret.
    for row in body["keys"]:
        assert "secret_revealed" not in row


def test_create_custom_key_persists_base_url_without_leaking_secret(client):
    payload = _make_payload("volc")
    payload.update({
        "provider": "custom",
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "access_key": "ark-secret",
        "secret_key": None,
    })
    r1 = client.post("/api/keys", json=payload)
    assert r1.status_code == 201, r1.text

    row = client.get("/api/keys").json()["keys"][0]
    assert row["base_url"] == "https://ark.cn-beijing.volces.com/api/v3"
    assert row["access_key"] != "ark-secret"
    assert row["secret_key"] is None


def test_create_key_persists_provider_metadata(client):
    payload = _make_payload("seedream-main")
    payload.update({
        "provider": "seedream",
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "access_key": "ark-secret",
        "secret_key": None,
        "homepage_url": "https://www.volcengine.com",
        "docs_url": "https://www.volcengine.com/docs",
        "api_key_url": "https://console.volcengine.com/ark",
        "modalities": ["image"],
        "notes": "",
    })

    r1 = client.post("/api/keys", json=payload)
    assert r1.status_code == 201, r1.text

    row = client.get("/api/keys").json()["keys"][0]
    assert row["homepage_url"] == "https://www.volcengine.com"
    assert row["docs_url"] == "https://www.volcengine.com/docs"
    assert row["api_key_url"] == "https://console.volcengine.com/ark"
    assert row["modalities"] == ["image"]
    assert row["notes"] == ""
    assert row["access_key"] != "ark-secret"


def test_create_custom_key_accepts_per_model_modality(client):
    """「分类 API」已删，改为模型级 modality 标注（image/video，未标注=兜底）。"""
    payload = _make_payload("zz-gpt")
    payload.update({
        "provider": "custom",
        "base_url": "https://api.aggregator.test",
        "access_key": "zz-secret",
        "secret_key": None,
        "models": [
            {"name": "GPT Image 2", "id": "gpt-image-2-all", "modality": "image"},
            {"name": "Sora 2", "id": "sora-2", "modality": "video"},
            {"name": "Nano Banana Pro", "id": "nano-banana-pro"},
        ],
        "modalities": ["image", "video"],
    })

    resp = client.post("/api/keys", json=payload)
    assert resp.status_code == 201, resp.text

    row = client.get("/api/keys").json()["keys"][0]
    assert row["provider"] == "custom"
    assert [m["modality"] for m in row["models"]] == ["image", "video", None]
    assert row["access_key"] != "zz-secret"


def test_create_key_persists_named_models(client):
    payload = _make_payload("volc")
    payload.update({
        "provider": "seedream",
        "access_key": "ark-test",
        "secret_key": None,
        "models": [
            {"name": "图片 5.0 Lite", "id": "doubao-seedream-5-0-260128"},
            {"name": "图片 4.7", "id": "doubao-seedream-4-5-251128"},
        ],
    })
    r1 = client.post("/api/keys", json=payload)
    assert r1.status_code == 201, r1.text

    row = client.get("/api/keys").json()["keys"][0]
    assert row["models"] == [
        {"name": "图片 5.0 Lite", "id": "doubao-seedream-5-0-260128", "modality": None, "protocol": None},
        {"name": "图片 4.7", "id": "doubao-seedream-4-5-251128", "modality": None, "protocol": None},
    ]


def test_create_duplicate_alias_409(client):
    client.post("/api/keys", json=_make_payload())
    r = client.post("/api/keys", json=_make_payload())
    assert r.status_code == 409


def test_patch_key_updates_notes(client):
    client.post("/api/keys", json=_make_payload())
    r = client.patch("/api/keys/lov", json={"notes": "updated"})
    assert r.status_code == 200
    found = next(k for k in client.get("/api/keys").json()["keys"] if k["alias"] == "lov")
    assert found["notes"] == "updated"


def test_patch_preserves_secret_when_not_provided(client):
    client.post("/api/keys", json=_make_payload())
    client.patch("/api/keys/lov", json={"notes": "x"})
    k = keys.find_by_alias("lov")
    assert k.access_key == "ak"
    assert k.secret_key == "sk"


def test_patch_missing_alias_404(client):
    r = client.patch("/api/keys/missing", json={"notes": "x"})
    assert r.status_code == 404


def test_delete_key(client):
    client.post("/api/keys", json=_make_payload())
    r = client.delete("/api/keys/lov")
    assert r.status_code == 204
    assert client.get("/api/keys").json()["keys"] == []


def test_models_preview_attaches_video_protocol_guess(tmp_path, monkeypatch):
    """视频模型附带 protocol guess；图片模型返回 None。"""
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    client = TestClient(build_app())

    upstream_models = [
        {"id": "doubao-seedance-2-0"},
        {"id": "happyhorse-1.0-t2v"},
        {"id": "gpt-image-2"},
    ]

    import unittest.mock as mock

    fake_resp = mock.MagicMock()
    fake_resp.status_code = 200
    fake_resp.json.return_value = {"data": upstream_models}

    with mock.patch("requests.get", return_value=fake_resp):
        r = client.post(
            "/api/keys/models-preview",
            json={
                "provider": "tokendance",
                "base_url": "https://tokendance.space/gateway/v1",
                "access_key": "x",
            },
        )

    assert r.status_code == 200, r.text
    by_id = {m["id"]: m for m in r.json()["models"]}

    assert by_id["doubao-seedance-2-0"]["protocol"] == "seedance"
    assert by_id["happyhorse-1.0-t2v"]["protocol"] == "dashscope"
    assert by_id["gpt-image-2"]["protocol"] is None  # 上游没标协议 → 留空，caller 端兜底


def test_models_preview_reads_image_protocol_from_upstream_annotation(tmp_path, monkeypatch):
    """图片协议直接取上游标注：只声明 ark 的必须走 Ark 端点，否则网关判 503 无可用端点。"""
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    client = TestClient(build_app())

    upstream_models = [
        # 只有 ark 图片协议（词元跳动 seedream-5.0-pro 的真实标注）
        {"id": "seedream-5.0-pro", "supported_protocols": ["ark:image-generations"]},
        # 双协议 → 走更通用的 OpenAI 兼容入口
        {
            "id": "seedream-5.0-lite",
            "supported_protocols": ["ark:image-generations", "openai:image-generations"],
        },
        # 非出图模型 → 不分类也不给协议
        {"id": "some-chat", "supported_protocols": ["openai:chat-completions"]},
    ]

    import unittest.mock as mock

    fake_resp = mock.MagicMock()
    fake_resp.status_code = 200
    fake_resp.json.return_value = {"data": upstream_models}

    with mock.patch("requests.get", return_value=fake_resp):
        r = client.post(
            "/api/keys/models-preview",
            json={
                "provider": "tokendance",
                "base_url": "https://tokendance.space/gateway/v1",
                "access_key": "x",
            },
        )

    assert r.status_code == 200, r.text
    by_id = {m["id"]: m for m in r.json()["models"]}

    assert by_id["seedream-5.0-pro"]["protocol"] == "ark"
    assert by_id["seedream-5.0-lite"]["protocol"] == "openai"
    assert by_id["some-chat"]["modality"] is None
    assert by_id["some-chat"]["protocol"] is None


def test_reveal_returns_stored_plaintext(client):
    """/reveal 是唯一回明文的接口：返回真实密钥，且与列表里的掩码不同。"""
    payload = _make_payload("lov")
    payload["access_key"] = "ak-plaintext-secret"
    client.post("/api/keys", json=payload)

    masked = client.get("/api/keys").json()["keys"][0]["access_key"]
    assert masked != "ak-plaintext-secret"  # 列表仍掩码

    r = client.get("/api/keys/lov/reveal")
    assert r.status_code == 200
    assert r.json()["access_key"] == "ak-plaintext-secret"


def test_reveal_unknown_alias_404(client):
    r = client.get("/api/keys/does-not-exist/reveal")
    assert r.status_code == 404


