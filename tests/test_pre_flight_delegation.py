"""第 5 批 5-1e：`openai_image._is_pre_flight_failure` 委托给 `connect_failure.never_sent`。

认不出的连接错误（这里用 `ConnectionError("reset")` 代表）以前默认当成「没送达」，会自动重试 / 换家；
现在按「可能已送达」处理。对照组用真实对象：本机没人监听的端口（确定没送达），行为与以前相同。
等待只替换被测模块自己的入口（openai_image._retry_pause、declarative._backoff），不碰全局 time.sleep。
"""
from __future__ import annotations

import socket
from types import SimpleNamespace

import pytest
import requests

from character_workflow.lib.callers import openai_image

UNKNOWN = "reset"


def _closed_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch):
    from character_workflow.lib.callers import declarative

    monkeypatch.setattr(openai_image, "_retry_pause", lambda _attempt: None)
    monkeypatch.setattr(declarative, "_backoff", lambda _attempt: None)


def _counting_post(monkeypatch, module, raise_unknown: bool):
    calls: list[str] = []
    real = requests.post

    def post(url, *args, **kwargs):
        calls.append(url)
        if raise_unknown:
            raise requests.ConnectionError(UNKNOWN)
        return real(url, *args, **kwargs)

    monkeypatch.setattr(module.requests, "post", post)
    return calls


# ---------------------------------------------------------------- 同步出图


def test_sync_image_does_not_retry_an_unrecognised_connection_error(monkeypatch):
    calls = _counting_post(monkeypatch, openai_image, raise_unknown=True)
    with pytest.raises(openai_image.OpenAIImageError):
        openai_image._post_json("https://vendor.test/v1/images/generations", "k", {}, timeout=(1, 1))
    assert len(calls) == 1


def test_sync_image_still_retries_when_nothing_was_listening(monkeypatch):
    calls = _counting_post(monkeypatch, openai_image, raise_unknown=False)
    with pytest.raises(openai_image.OpenAIImageError):
        openai_image._post_json(f"http://127.0.0.1:{_closed_port()}/v1/images/generations", "k", {},
                                timeout=(1, 1))
    assert len(calls) == 3


def test_sync_image_behind_a_dead_local_proxy_retries_and_keeps_its_message(monkeypatch):
    """本机代理挂了（Clash / VPN 端口关着）：请求没离开本机，照旧重试；报错仍翻成「连不上本机代理」那句。"""
    from character_workflow.lib.job_runner import _friendly_error

    for name in ("NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    proxy = f"http://127.0.0.1:{_closed_port()}"
    monkeypatch.setenv("HTTPS_PROXY", proxy)
    monkeypatch.setenv("https_proxy", proxy)
    calls = _counting_post(monkeypatch, openai_image, raise_unknown=False)
    with pytest.raises(openai_image.OpenAIImageError) as error:
        openai_image._post_json("https://vendor.test/v1/images/generations", "k", {}, timeout=(1, 1))
    assert len(calls) == 3
    assert "连不上本机代理（VPN / Clash 等）" in _friendly_error(error.value)


# ---------------------------------------------------------------- ChatGPT 订阅


def _chatgpt(monkeypatch):
    from character_workflow.lib.callers import chatgpt_image

    monkeypatch.setattr(chatgpt_image, "_codex_version", lambda: "0.0.0")
    monkeypatch.setattr(chatgpt_image, "_retry_pause", lambda _attempt: None)
    monkeypatch.setattr(chatgpt_image.chatgpt_auth, "get_credentials",
                        lambda **_k: SimpleNamespace(access_token="t", account_id="a"))
    return chatgpt_image


def test_chatgpt_subscription_does_not_retry_an_unrecognised_connection_error(monkeypatch):
    chatgpt_image = _chatgpt(monkeypatch)
    calls = _counting_post(monkeypatch, chatgpt_image, raise_unknown=True)
    with pytest.raises(openai_image.OpenAIImageError):
        chatgpt_image._post("https://chatgpt.test/backend-api/codex/responses", {}, (1, 1))
    assert len(calls) == 1


def test_chatgpt_subscription_still_retries_when_nothing_was_listening(monkeypatch):
    chatgpt_image = _chatgpt(monkeypatch)
    calls = _counting_post(monkeypatch, chatgpt_image, raise_unknown=False)
    with pytest.raises(openai_image.OpenAIImageError):
        chatgpt_image._post(f"http://127.0.0.1:{_closed_port()}/backend-api/codex/responses", {},
                            (1, 1))
    assert len(calls) == 3


# ---------------------------------------------------------------- 自定义接口（同步模板）


def _declarative_call(url: str):
    from character_workflow.lib.callers import declarative

    return declarative.PreparedCall(method="POST", url=url, headers={}, json_body={})


def test_declarative_does_not_retry_an_unrecognised_connection_error(monkeypatch):
    from character_workflow.lib.callers import declarative

    calls: list[str] = []

    def request(method, url, **_kwargs):
        calls.append(url)
        raise requests.ConnectionError(UNKNOWN)

    monkeypatch.setattr(declarative.requests, "request", request)
    with pytest.raises(declarative.DeclarativeError):
        declarative.send(_declarative_call("https://vendor.test/v1/images"), timeout=(1, 1),
                         error_path=None)
    assert len(calls) == 1


def test_declarative_still_retries_when_nothing_was_listening(monkeypatch):
    from character_workflow.lib.callers import declarative

    calls: list[str] = []
    real = requests.request

    def request(method, url, **kwargs):
        calls.append(url)
        return real(method, url, **kwargs)

    monkeypatch.setattr(declarative.requests, "request", request)
    with pytest.raises(declarative.DeclarativeError):
        declarative.send(_declarative_call(f"http://127.0.0.1:{_closed_port()}/v1/images"),
                         timeout=(1, 1), error_path=None)
    assert len(calls) == 3


# ---------------------------------------------------------------- 「自动」换家


def _wrapped(cause: BaseException) -> openai_image.OpenAIImageError:
    try:
        raise openai_image.OpenAIImageError(str(cause)) from cause
    except openai_image.OpenAIImageError as error:
        return error


def test_failover_does_not_switch_on_an_unrecognised_connection_error():
    from character_workflow.lib.model_routes import failover_reason

    assert failover_reason(_wrapped(requests.ConnectionError(UNKNOWN))) is None


def test_failover_still_switches_when_nothing_was_listening():
    from character_workflow.lib.model_routes import failover_reason

    with pytest.raises(requests.ConnectionError) as error:
        requests.post(f"http://127.0.0.1:{_closed_port()}/x", timeout=(1, 1))
    assert failover_reason(_wrapped(error.value)) == "unreachable"


# ---------------------------------------------------------------- ComfyUI 提交


def test_comfyui_prompt_with_an_unrecognised_error_counts_as_started(monkeypatch):
    from character_workflow.lib.comfyui_client import ComfyUIClient, ComfyUIUnavailableError

    client = ComfyUIClient(f"http://127.0.0.1:{_closed_port()}")

    def request(*_args, **_kwargs):
        raise requests.ConnectionError(UNKNOWN)

    monkeypatch.setattr(client.session, "request", request)
    with pytest.raises(ComfyUIUnavailableError) as error:
        client.request("POST", "/prompt", json={})
    assert error.value.execution_started is True


def test_comfyui_prompt_that_could_not_connect_is_not_started():
    from character_workflow.lib.comfyui_client import ComfyUIClient, ComfyUIUnavailableError

    with pytest.raises(ComfyUIUnavailableError) as error:
        ComfyUIClient(f"http://127.0.0.1:{_closed_port()}").request("POST", "/prompt", json={})
    assert error.value.execution_started is False


# ---------------------------------------------------------------- 成员端提交到局域网网关

KEY = "1763545562-" + "a" * 32


class _Session:
    def __init__(self, post):
        self.post = post


def test_member_submit_with_unrecognised_errors_is_unconfirmed_with_one_key():
    from character_workflow.lib.callers import atelier_gateway

    keys_sent: list[str] = []

    def post(url, headers=None, **_kwargs):
        keys_sent.append(headers["Idempotency-Key"])
        raise requests.ConnectionError(UNKNOWN)

    with pytest.raises(atelier_gateway.GatewayUnconfirmed):
        atelier_gateway._submit(_Session(post), "http://hub.test", {"Authorization": "Bearer t"},
                                alias="Hub", kind="image", model="m", prompt="p", n=1, params={},
                                uploads={}, idempotency_key=KEY)
    assert len(keys_sent) == atelier_gateway.SUBMIT_ATTEMPTS
    assert set(keys_sent) == {KEY}  # 幂等键不变：之后接回时主机只会认原来那一单


def test_member_submit_that_could_not_connect_is_not_accepted():
    from character_workflow.lib.callers import atelier_gateway

    session = requests.Session()
    session.trust_env = False
    with pytest.raises(atelier_gateway.GatewayNotAccepted):
        atelier_gateway._submit(session, f"http://127.0.0.1:{_closed_port()}",
                                {"Authorization": "Bearer t"}, alias="Hub", kind="image", model="m",
                                prompt="p", n=1, params={}, uploads={}, idempotency_key=KEY)
