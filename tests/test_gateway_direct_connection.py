"""局域网网关的文本 / Agent 请求与图片 caller 一样直连，不读本机代理环境。"""
from types import SimpleNamespace

import pytest

from character_workflow.lib import canvas_agent_models, canvas_agent_runtime, keys
from character_workflow.lib.callers import openai_text
from character_workflow.lib.callers.atelier_gateway import DIRECT_PROXIES


class _Response:
    status_code = 200

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return {"data": []}


def _gateway_key() -> keys.KeySpec:
    key = keys.KeySpec(alias="Hub", provider="atelier", access_key="atg_test",
                       base_url="http://192.168.0.2:5180", modalities=["text"],
                       models=[keys.ModelSpec(id="chat", name="chat", modality="text")],
                       created_at="test")
    keys.add_key(key)
    return key


def _capture(monkeypatch, target, name: str) -> dict:
    seen: dict = {}

    def fake(*_args, **kwargs):
        seen.update(kwargs)
        return _Response()

    monkeypatch.setattr(target.requests, name, fake)
    return seen


@pytest.mark.parametrize("gateway_alias,proxies", [("Hub", DIRECT_PROXIES), (None, None)])
def test_text_post_bypasses_proxy_only_for_gateway(isolated_data_root, monkeypatch,
                                                   gateway_alias, proxies):
    seen = _capture(monkeypatch, openai_text, "post")
    openai_text._post_json(url="http://192.168.0.2:5180/gateway/v1/openai/chat/completions",
                           access_key="atg_test", payload={}, timeout=1,
                           gateway_alias=gateway_alias)
    assert seen.get("proxies") == proxies


def test_agent_model_probe_bypasses_proxy_for_gateway(isolated_data_root, monkeypatch):
    seen = _capture(monkeypatch, canvas_agent_models, "get")
    canvas_agent_models._fetch(_gateway_key())
    assert seen["proxies"] == DIRECT_PROXIES


def test_agent_client_ignores_proxy_environment_for_gateway(isolated_data_root, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:7890")
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:7890")
    _gateway_key()
    agent = canvas_agent_runtime.build_agent(SimpleNamespace(
        model_alias="Hub", model="chat", effort=None, creation_mode="all"))
    http_client = agent.model._client._client
    assert http_client._trust_env is False
