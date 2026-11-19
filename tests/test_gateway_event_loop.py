"""第 4 批 4-5：网关文本中转不在网关事件循环里抢锁、读盘。

同 `test_route_event_loop_offloading.py` 的判据：被调用时当前线程有没有在跑事件循环。
另有一条行为用例：`gateway_tasks._lock` 被别的线程占着（图片任务调度 / 结算）时，文本请求在等锁，
同一个网关端口的健康检查照样立即应答。全部本机：回环网关 + httpx MockTransport 假上游。
"""
from __future__ import annotations

import asyncio
import threading
import time

import httpx
import pytest
import requests

from character_workflow.lib import gateway_tasks, gateway_text, keys
from tests import test_gateway_client as _client_harness
from viewer_server import gateway_openai

_fast = _client_harness._fast
gateway = _client_harness.gateway
upstream = _client_harness.upstream
TEXT = "gpt-4.1-nano"


@pytest.fixture
def text_gateway(gateway, monkeypatch):
    keys.add_key(keys.KeySpec(alias="TextUp", provider="custom", access_key="fake-test-secret",
                              base_url="https://text.example/v1", created_at="test",
                              models=[keys.ModelSpec(id=TEXT, name=TEXT, modality="text")]))
    monkeypatch.setattr(gateway_openai, "_client", lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={
            "choices": [], "usage": {"prompt_tokens": 3, "completion_tokens": 1}}))))
    return gateway


def _post(gateway, timeout=10):
    session = requests.Session()
    session.trust_env = False
    return session.post(f"{gateway['base']}/gateway/v1/openai/chat/completions", timeout=timeout,
                        headers={"Authorization": f"Bearer {gateway['token']}"},
                        json={"model": TEXT, "messages": [{"role": "user", "content": "hi"}]})


def _recorder(monkeypatch, owner, name):
    original = getattr(owner, name)
    on_loop: list[bool] = []

    def wrapped(*args, **kwargs):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            on_loop.append(False)
        else:
            on_loop.append(True)
        return original(*args, **kwargs)

    monkeypatch.setattr(owner, name, wrapped)
    return on_loop


def test_text_relay_admission_selection_and_settlement_run_off_the_loop(text_gateway, monkeypatch):
    picks = _recorder(monkeypatch, gateway_openai, "_pick")
    admissions = _recorder(monkeypatch, gateway_text.TextCall, "__init__")
    settlements = _recorder(monkeypatch, gateway_text.TextCall, "finish")
    listings = _recorder(monkeypatch, gateway_openai, "_visible_members")

    assert _post(text_gateway).status_code == 200
    session = requests.Session()
    session.trust_env = False
    models = session.get(f"{text_gateway['base']}/gateway/v1/openai/models", timeout=10,
                         headers={"Authorization": f"Bearer {text_gateway['token']}"})
    assert models.status_code == 200
    assert picks == [False] and admissions == [False] and listings == [False]
    assert settlements and not any(settlements)


def test_health_answers_while_a_text_call_waits_for_the_task_lock(text_gateway):
    held = threading.Event()
    release = threading.Event()

    def hold_lock():
        with gateway_tasks._lock:  # 图片任务的调度 / 结算正占着锁
            held.set()
            release.wait(5)

    holder = threading.Thread(target=hold_lock)
    holder.start()
    held.wait(5)
    result: dict = {}
    caller = threading.Thread(target=lambda: result.setdefault("response", _post(text_gateway)))
    caller.start()
    time.sleep(0.3)  # 文本请求已进来、在等锁
    try:
        session = requests.Session()
        session.trust_env = False
        started = time.monotonic()
        health = session.get(f"{text_gateway['base']}/gateway/v1/health", timeout=2)
        assert health.status_code == 200 and time.monotonic() - started < 1
    finally:
        release.set()
        holder.join(5)
        caller.join(10)
    assert result["response"].status_code == 200
