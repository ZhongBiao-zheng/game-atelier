"""第 5 批 5-1c：自定义接口的异步提交（带 poll 的模板）按 task_submission 的统一判据。

5xx 不再自动重发、算未确认；读体失败、响应不是 JSON、取不到任务号都是未确认（按类型）。
经网关时主机按类型判 `unconfirmed`、扣 0、不换到同路由的另一把 KEY。同步模板的 502/503/504 重发不变。
假厂商是本机 FakeVendor；不替换 time.sleep。
"""
from __future__ import annotations

import copy

import pytest

from character_workflow.lib import gateway_keys, gateway_quota, gateway_tasks, http_protocols, keys
from character_workflow.lib import model_routes
from character_workflow.lib.callers import declarative, dispatch, task_submission
from tests.fake_http_vendor import FakeVendor, png_bytes
from tests.test_declarative_caller import ASYNC, SYNC, _StallingServer

SECRET = "sk-test-secret-0123456789"


@pytest.fixture(autouse=True)
def isolated(isolated_data_root, monkeypatch):
    model_routes._cooldowns.clear()
    gateway_quota._inflight.clear()
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    yield
    model_routes._cooldowns.clear()


@pytest.fixture
def vendor():
    with FakeVendor() as server:
        server.on("GET", "/files/a.png", png_bytes())
        yield server


def _bind(server_url, document, aliases=("vendor",)):
    stored = http_protocols.save_protocol(copy.deepcopy(document))
    for alias in aliases:
        keys.add_key(keys.KeySpec(
            alias=alias, provider="custom", base_url=server_url, access_key=SECRET,
            models=[keys.ModelSpec(id="m1", name="m1", modality=document["kind"],
                                   protocol="declarative", declarative_id=stored.id)],
            created_at="2026-11-19T00:00:00Z"))
    return stored.id


def _run(tmp_path, alias="vendor"):
    return dispatch(prompt="一只猫", model="m1", alias=alias, output_dir=tmp_path / "out", n=1,
                    params={})


ANSWERS = {
    "503_no_channel": (503, {"error": {"message": "无可用渠道"}}),
    "502": (502, {"error": "upstream"}),
    "2xx_not_json": (200, b"<html>ok</html>"),
    "2xx_no_task_id": (200, {"data": {"status": "QUEUED"}}),
}


@pytest.mark.parametrize("answer", list(ANSWERS))
def test_unsure_async_submission_is_unconfirmed_and_not_resent(vendor, tmp_path, answer):
    _bind(vendor.url, ASYNC)
    vendor.on("POST", "/v1/tasks", ANSWERS[answer])
    with pytest.raises(declarative.DeclarativeUnconfirmed) as error:
        _run(tmp_path)
    assert task_submission.is_unconfirmed(error.value)
    assert isinstance(error.value, declarative.DeclarativeError)
    assert len(vendor.calls("POST", "/v1/tasks")) == 1
    assert SECRET not in str(error.value)


def test_async_4xx_is_a_plain_rejection(vendor, tmp_path):
    _bind(vendor.url, ASYNC)
    vendor.on("POST", "/v1/tasks", (400, {"error": "bad prompt"}))
    with pytest.raises(declarative.DeclarativeError) as error:
        _run(tmp_path)
    assert not task_submission.is_unconfirmed(error.value)
    assert len(vendor.calls("POST", "/v1/tasks")) == 1


def test_async_body_read_failure_is_unconfirmed(tmp_path, monkeypatch):
    stalling = _StallingServer()
    try:
        _bind(stalling.url, ASYNC)
        monkeypatch.setattr(declarative, "ASYNC_SUBMIT_TIMEOUT", (1.0, 1.0))
        with pytest.raises(declarative.DeclarativeUnconfirmed, match="可能已经执行"):
            _run(tmp_path)
        assert stalling.connections == 1
    finally:
        stalling.close()


def test_sync_template_still_resends_transient_5xx(vendor, tmp_path, monkeypatch):
    """同步模板维持 ADR-0036 的 502/503/504 重发（只替换 declarative 自己的退避等待）。"""
    _bind(vendor.url, SYNC)
    vendor.on("POST", "/v1/images/generations", (502, {"error": "upstream"}),
              {"data": [{"url": vendor.url + "/files/a.png"}]})
    monkeypatch.setattr(declarative, "_backoff", lambda _attempt: None)
    assert _run(tmp_path)
    assert len(vendor.calls("POST", "/v1/images/generations")) == 2


def test_gateway_marks_it_unconfirmed_and_keeps_the_other_key_idle(vendor):
    protocol_id = _bind(vendor.url, ASYNC, aliases=("first", "second"))
    vendor.on("POST", "/v1/tasks", (503, {"error": {"message": "无可用渠道"}}))
    owner = gateway_keys.create_key("小王")[0]
    task = gateway_tasks.submit(owner, idempotency_key="k1", model=f"declarative:{protocol_id}:m1",
                                prompt="一只猫", n=1, size=None, params={}, files={}, kind="image")
    failed = gateway_tasks.run_task(gateway_tasks._update(task.task_id, status="running"))
    assert (failed.status, failed.error_kind) == ("failed", "unconfirmed"), failed.error
    assert failed.charged_cny == 0
    assert len(vendor.calls("POST", "/v1/tasks")) == 1


def test_async_refused_connection_retries_then_is_unconfirmed(tmp_path, monkeypatch):
    """连接建立前的失败：先按原规则自动重试（确定没送达），用尽后按 Q1-1=A 算未确认。"""
    import socket

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()  # 端口关着：连接被拒
    _bind(f"http://127.0.0.1:{port}", ASYNC)
    backoffs: list[int] = []
    monkeypatch.setattr(declarative, "_backoff", backoffs.append)
    with pytest.raises(declarative.DeclarativeUnconfirmed):
        _run(tmp_path)
    assert backoffs == [0, 1]
