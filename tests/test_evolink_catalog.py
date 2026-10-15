from unittest.mock import Mock

import pytest

from character_workflow.lib import keys, net_env
from character_workflow.lib.callers.openai_image import image_family, resolve_image_protocol
from character_workflow.lib.image_size import normalize_image_size_params
from tests.local_client import LocalTestClient
from viewer_server.server_app import build_app


def _key():
    return keys.KeySpec(
        alias="evolink", provider="evolink", base_url="https://api.evolink.ai/v1",
        access_key="test-only", created_at="2026-10-15T00:00:00Z",
        models=[keys.ModelSpec(name="Midjourney V8.2", id="mj-v8.2", modality="image")],
    )


def test_evolink_key_roundtrip_registers_exact_model_protocol():
    keys.add_key(_key())
    stored = keys.read_keys_db().keys[0]
    assert stored.provider == "evolink"
    assert stored.models[0].protocol == "evolink"
    assert image_family(stored.models[0].id) == "midjourney"
    for model in ("mj-v8.1", "mj-v8.2-upload-paint", "gpt-image-2", "seedream-5.0-pro"):
        assert resolve_image_protocol("evolink", stored.base_url, model) is None
    assert resolve_image_protocol("custom", stored.base_url, "mj-v8.2") is None


@pytest.mark.parametrize("include_all", [False, True])
def test_evolink_discovery_only_exposes_implemented_base_model(monkeypatch, include_all):
    rows = [
        {"id": "mj-v8.2", "name": "Midjourney V8.2"},
        {"id": "mj-v8.2"},
        *({"id": f"mj-v8.2-{action}", "supported_protocols": ["openai:image-generations"]}
          for action in ("edit", "upload-paint", "variation", "remix", "retexture", "remove-bg")),
        {"id": "mj-v8.1"},
        {"id": "gpt-image-2", "architecture": {"output_modalities": ["image"]}},
    ]
    response = Mock(status_code=200)
    response.json.return_value = {"data": rows}
    request = Mock(return_value=response)
    monkeypatch.setattr("requests.get", request)
    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app())
    result = client.post("/api/keys/models-preview", json={
        "provider": "evolink", "base_url": "https://api.evolink.ai/v1",
        "access_key": "test-only", "include_all": include_all,
    })
    assert result.status_code == 200, result.text
    assert result.json() == {
        "models": [{"id": "mj-v8.2", "name": "Midjourney V8.2", "modality": "image",
                    "category": "image", "protocol": "evolink", "input_modalities": []}],
        "total": 9, "excluded": 8,
    }
    assert request.call_args.args[0] == "https://api.evolink.ai/v1/models"


def test_evolink_ratio_drops_stale_pixel_size_and_resolution():
    assert normalize_image_size_params(_key(), "mj-v8.2", {
        "size_mode": "ratio", "ratio": "16:9", "size": "2048x1152", "resolution": "4K",
        "n": 4,
    }) == {"size_mode": "ratio", "ratio": "16:9", "n": 4}


def test_evolink_native_auto_drops_stale_ratio_without_resolving_pixels():
    assert normalize_image_size_params(_key(), "mj-v8.2", {
        "size_mode": "auto", "size": "2048x1152", "ratio": "16:9", "resolution": "4K",
    }) == {"size_mode": "auto", "size": "auto"}


def test_evolink_rejects_custom_pixel_dimensions():
    with pytest.raises(ValueError, match="不支持自定义"):
        normalize_image_size_params(_key(), "mj-v8.2", {"size_mode": "custom", "size": "1024x1024"})


def test_evolink_api_upload_and_cdn_hosts_bypass_proxies(monkeypatch):
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.delenv("no_proxy", raising=False)
    net_env.configure_proxy_bypass()
    from requests.utils import should_bypass_proxies

    for host in ("api.evolink.ai", "files-api.evolink.ai", "cdn.evolink.ai"):
        assert should_bypass_proxies(f"https://{host}", no_proxy=None)
