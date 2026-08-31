import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import keys
from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root):
    return TestClient(base_url="http://127.0.0.1", app=build_app())


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
        "billing_group": "default",
        "access_key": "ark-secret",
        "secret_key": None,
    })
    r1 = client.post("/api/keys", json=payload)
    assert r1.status_code == 201, r1.text

    row = client.get("/api/keys").json()["keys"][0]
    assert row["base_url"] == "https://ark.cn-beijing.volces.com/api/v3"
    assert row["billing_group"] == "default"
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
        {
            "name": "图片 5.0 Lite",
            "id": "doubao-seedream-5-0-260128",
            "modality": None,
            "protocol": None,
            "input_modalities": [],
        },
        {
            "name": "图片 4.7",
            "id": "doubao-seedream-4-5-251128",
            "modality": None,
            "protocol": None,
            "input_modalities": [],
        },
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


def test_patch_key_updates_billing_group(client):
    client.post("/api/keys", json=_make_payload())
    assert client.patch("/api/keys/lov", json={"billing_group": "绘画"}).status_code == 200
    found = client.get("/api/keys").json()["keys"][0]
    assert found["billing_group"] == "绘画"


def test_patch_key_clears_billing_group(client):
    payload = _make_payload()
    payload["billing_group"] = "default"
    client.post("/api/keys", json=payload)

    assert client.patch("/api/keys/lov", json={"billing_group": None}).status_code == 200
    found = client.get("/api/keys").json()["keys"][0]
    assert found["billing_group"] is None


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
    client = TestClient(base_url="http://127.0.0.1", app=build_app())

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
    client = TestClient(base_url="http://127.0.0.1", app=build_app())

    upstream_models = [
        # 只有 ark 图片协议（词元跳动 seedream-5.0-pro 的真实标注）
        {"id": "seedream-5.0-pro", "supported_protocols": ["ark:image-generations"]},
        # 双协议 → 走更通用的 OpenAI 兼容入口
        {
            "id": "seedream-5.0-lite",
            "supported_protocols": ["ark:image-generations", "openai:image-generations"],
        },
        # 文本模型 → 作为 Canvas 文本生成模型返回
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
    assert by_id["some-chat"]["modality"] == "text"
    assert by_id["some-chat"]["protocol"] == "openai-chat"
    assert r.json()["excluded"] == 0


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




# --- models-preview 的密钥外发边界 ---

def _stub_models_get(monkeypatch_ctx, seen: dict):
    import unittest.mock as mock

    fake = mock.MagicMock()
    fake.status_code = 200
    fake.json.return_value = {"data": [{"id": "m1"}]}

    def _get(url, headers=None, timeout=None):
        seen["url"] = url
        seen["auth"] = (headers or {}).get("Authorization", "")
        return fake

    return mock.patch("requests.get", side_effect=_get)


def _make_key(client, alias="td", base_url="https://tokendance.space/gateway/v1"):
    r = client.post("/api/keys", json={
        "alias": alias, "provider": "tokendance", "base_url": base_url,
        "access_key": "secret-stored-key", "capabilities": [],
    })
    assert r.status_code in (200, 201), r.text


def test_models_preview_refuses_stored_key_to_a_different_host(tmp_path, monkeypatch):
    """存储的是明文密钥：不许调用方指定把它发去哪个域名（DNS rebinding 可从本机页面触发）。"""
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    client = TestClient(base_url="http://127.0.0.1", app=build_app())
    _make_key(client)
    seen: dict = {}
    with _stub_models_get(monkeypatch, seen):
        r = client.post("/api/keys/models-preview",
                        json={"alias": "td", "base_url": "https://attacker.tld/v1"})
    assert r.status_code == 400
    assert "密钥" in r.json()["detail"]
    assert seen == {}  # 一个出站请求都没发


def test_models_preview_allows_same_host_path_change_with_stored_key(tmp_path, monkeypatch):
    """同 host 换路径是正常编辑行为，照常用存储密钥。"""
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    client = TestClient(base_url="http://127.0.0.1", app=build_app())
    _make_key(client)
    seen: dict = {}
    with _stub_models_get(monkeypatch, seen):
        r = client.post("/api/keys/models-preview",
                        json={"alias": "td", "base_url": "https://tokendance.space/gateway/v2"})
    assert r.status_code == 200, r.text
    assert seen["url"] == "https://tokendance.space/gateway/v2/models"
    assert seen["auth"] == "Bearer secret-stored-key"


def test_models_preview_allows_any_host_when_caller_brings_its_own_key(tmp_path, monkeypatch):
    """自带密钥时地址随它——泄露面止于调用方自己刚输入的密钥。"""
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    client = TestClient(base_url="http://127.0.0.1", app=build_app())
    _make_key(client)
    seen: dict = {}
    with _stub_models_get(monkeypatch, seen):
        r = client.post("/api/keys/models-preview", json={
            "alias": "td", "base_url": "https://other.example/v1", "access_key": "caller-key",
        })
    assert r.status_code == 200, r.text
    assert seen["auth"] == "Bearer caller-key"


# --- 模型列表分类：只丢明确的非视觉模型 ---

def test_classify_model_uses_protocol_annotation():
    from viewer_server.routes import _classify_model, _text_protocol
    assert _classify_model({"id": "a", "supported_protocols": ["ark:image-generations"]}) == "image"
    assert _classify_model({"id": "b", "supported_protocols": ["seedance:generations"]}) == "video"
    assert _classify_model({"id": "c", "supported_protocols": ["openai:chat-completions"]}) == "text"
    assert _classify_model({
        "id": "d", "supported_protocols": ["openai:chat-completions", "anthropic:messages"],
    }) == "text"
    # 已知可执行协议优先于同一模型的未知附加协议。
    assert _classify_model({
        "id": "e", "supported_protocols": ["openai:chat-completions", "acme:mystery-thing"],
    }) == "text"
    assert _classify_model({
        "id": "f", "supported_protocols": ["openai:responses"],
    }) == "text"
    assert _text_protocol({
        "id": "f", "supported_protocols": ["openai:responses"],
    }) == "openai-responses"


def test_classify_model_does_not_short_circuit_on_unknown_protocols():
    """旧版 `if protocols: return None` 会让协议词表不认识的网关整片判空。

    协议词汇是各厂自造的（实测同一份数据里就有 zai:layout-parsing / bocha:web-search），
    认不出来必须落到 id 关键词兜底，而不是早退。
    """
    from viewer_server.routes import _classify_model
    item = {"id": "acme-seedream-x", "supported_protocols": ["acme:brand-new-verb"]}
    assert _classify_model(item) == "image"


def test_classify_model_reads_output_modalities_before_guessing_id():
    """OpenRouter 409 个模型全都没有 supported_protocols，但都有这个权威字段。"""
    from viewer_server.routes import _classify_model
    assert _classify_model({
        "id": "openrouter/auto", "architecture": {"output_modalities": ["text", "image"]},
    }) == "image"
    assert _classify_model({
        "id": "thinkingmachines/inkling", "architecture": {"output_modalities": ["text"]},
    }) == "text"
    # 音频输出但不是明确 TTS：保守留作 unknown，不能包装成可执行语音模型。
    assert _classify_model({
        "id": "google/lyria-3-pro", "architecture": {"output_modalities": ["audio"]},
    }) == "unknown"


def test_id_keyword_match_respects_word_boundaries():
    """裸子串会把 inkling 判成 kling 视频、把 wanx（通义万相，图像）判成视频。"""
    from viewer_server.routes import _classify_model
    assert _classify_model({"id": "thinkingmachines/inkling"}) == "unknown"
    assert _classify_model({"id": "kwaivgi/kling-v3.0-std"}) == "video"
    assert _classify_model({"id": "wanx-v1"}) == "unknown"
    # seededit 是真图生图模型，image_family 早就认它，此前 _IMAGE_ID_HINTS 漏了
    assert _classify_model({"id": "doubao-seededit-3-0-i2i"}) == "image"


def test_classify_model_recognizes_doubao_conversation_without_misclassifying_media():
    from viewer_server.routes import _classify_model

    assert _classify_model({"id": "doubao-seed-1-8-251228"}) == "text"
    assert _classify_model({"id": "doubao-seed-1-6-vision-250815"}) == "text"
    assert _classify_model({"id": "doubao-embedding-text-240715"}) == "unknown"
    assert _classify_model({"id": "doubao-seed3d-2-0-260328"}) == "unknown"
    assert _classify_model({"id": "doubao-future-media-260101"}) == "unknown"


def _preview_with_upstream(client, rows, **payload):
    import unittest.mock as mock
    fake = mock.MagicMock()
    fake.status_code = 200
    fake.json.return_value = {"data": rows}
    with mock.patch("requests.get", return_value=fake):
        return client.post("/api/keys/models-preview", json={
            "provider": "tokendance", "base_url": "https://tokendance.space/gateway/v1",
            "access_key": "x", **payload,
        })


def test_models_preview_filters_non_visual_and_reports_counts(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    client = TestClient(base_url="http://127.0.0.1", app=build_app())
    rows = [
        {"id": "seedream-5.0-pro", "supported_protocols": ["ark:image-generations"]},
        {"id": "seedance-2.0", "supported_protocols": ["seedance:generations"]},
        {"id": "glm-4.7", "supported_protocols": ["openai:chat-completions"]},
        {"id": "text-embed", "supported_protocols": ["openai:embeddings"]},
        {"id": "mystery-model"},
    ]
    body = _preview_with_upstream(client, rows).json()
    ids = [m["id"] for m in body["models"]]

    assert "glm-4.7" in ids and "text-embed" not in ids
    assert body["excluded"] == 1
    assert body["total"] == 5
    # unknown 留在列表里，标成 category=unknown 让画师自己确认（不是「其他垃圾」）
    assert [m["category"] for m in body["models"] if m["id"] == "mystery-model"] == ["unknown"]
    assert [m["modality"] for m in body["models"] if m["id"] == "mystery-model"] == [None]
    assert [m["protocol"] for m in body["models"] if m["id"] == "glm-4.7"] == ["openai-chat"]


def test_models_preview_include_all_is_the_escape_hatch(tmp_path, monkeypatch):
    """deny 词表判过头时，画师要能自己看到全量，不能变成死路。"""
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    client = TestClient(base_url="http://127.0.0.1", app=build_app())
    rows = [{"id": "glm-4.7", "supported_protocols": ["openai:chat-completions"]}]
    body = _preview_with_upstream(client, rows, include_all=True).json()
    assert [m["id"] for m in body["models"]] == ["glm-4.7"]
    assert body["excluded"] == 0


def test_models_preview_dedupes_upstream_ids(tmp_path, monkeypatch):
    """聚合商常给同一模型挂多个别名条目，重复 id 会让前端 key 冲突。"""
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    client = TestClient(base_url="http://127.0.0.1", app=build_app())
    rows = [
        {"id": "seedream-5.0-pro", "supported_protocols": ["ark:image-generations"]},
        {"id": "seedream-5.0-pro", "supported_protocols": ["ark:image-generations"]},
    ]
    body = _preview_with_upstream(client, rows).json()
    assert [m["id"] for m in body["models"]] == ["seedream-5.0-pro"]
    assert body["total"] == 1


def test_models_preview_pulls_openrouter_video_list_separately(tmp_path, monkeypatch):
    """OpenRouter 的视频模型不在默认 /models 里 —— 不额外拉一次，用户永远只能手填 id。

    实测 2026-08-13：`GET /api/v1/models` 409 条里一个视频模型都没有，23 个 veo / sora /
    kling / seedance 只在 `?output_modalities=video` 下列出。
    """
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    client = TestClient(base_url="http://127.0.0.1", app=build_app())
    import unittest.mock as mock

    def fake_get(url, headers=None, timeout=None):
        resp = mock.MagicMock()
        resp.status_code = 200
        if "output_modalities=video" in url:
            resp.json.return_value = {"data": [
                {"id": "google/veo-3.1", "architecture": {"output_modalities": ["video"]}},
            ]}
        else:
            resp.json.return_value = {"data": [
                {"id": "openai/gpt-image-2", "architecture": {"output_modalities": ["image"]}},
                {"id": "some/chat", "architecture": {"output_modalities": ["text"]}},
            ]}
        return resp

    with mock.patch("requests.get", side_effect=fake_get):
        r = client.post("/api/keys/models-preview", json={
            "provider": "openrouter", "base_url": "https://openrouter.ai/api/v1",
            "access_key": "x",
        })

    body = r.json()
    by_id = {m["id"]: m for m in body["models"]}
    assert "google/veo-3.1" in by_id, "视频模型必须被合并进来"
    assert by_id["google/veo-3.1"]["modality"] == "video"
    assert by_id["google/veo-3.1"]["protocol"] == "openrouter"  # 可路由，不是留空
    assert body["total"] == 3  # 两个列表合并后的去重总数
    assert by_id["some/chat"]["modality"] == "text"
    assert body["excluded"] == 0


def test_models_preview_survives_missing_extra_video_list(tmp_path, monkeypatch):
    """额外列表拉不到时降级成「只有图片模型」，不能让整个功能报错。"""
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    client = TestClient(base_url="http://127.0.0.1", app=build_app())
    import unittest.mock as mock

    def fake_get(url, headers=None, timeout=None):
        resp = mock.MagicMock()
        if "output_modalities=video" in url:
            resp.status_code = 500
            resp.text = "boom"
            return resp
        resp.status_code = 200
        resp.json.return_value = {"data": [
            {"id": "openai/gpt-image-2", "architecture": {"output_modalities": ["image"]}},
        ]}
        return resp

    with mock.patch("requests.get", side_effect=fake_get):
        r = client.post("/api/keys/models-preview", json={
            "provider": "openrouter", "base_url": "https://openrouter.ai/api/v1",
            "access_key": "x",
        })

    assert r.status_code == 200, r.text
    assert [m["id"] for m in r.json()["models"]] == ["openai/gpt-image-2"]


def test_extra_model_list_urls_only_for_openrouter():
    from viewer_server.routes import _extra_model_list_urls
    assert _extra_model_list_urls("https://openrouter.ai/api/v1/models", "openrouter") == [
        "https://openrouter.ai/api/v1/models?output_modalities=video"
    ]
    # host 判定优先，配成 custom 也认
    assert _extra_model_list_urls("https://openrouter.ai/api/v1/models", "custom")
    assert _extra_model_list_urls("https://tokendance.space/gateway/v1/models", "tokendance") == []
