"""第 6 批 6-1：Tuzi 异步图片提交对齐统一判据（管理会话定 Q6-1=A）。

对齐前：连上后断开 / 读超时、5xx、2xx 非 JSON、2xx 无任务号都是普通失败、可再次生成，5xx 带「不可用」标记
主机还会换家 —— 上游可能已建单，重复计费。对齐后这些都是「未确认」（不重发、不换家、扣 0），
连接没建立仍「未送达、换家」，4xx 仍是拒绝。真实套接字产生报错，套件与参数表见 test_caller_submission_types。
"""
from __future__ import annotations

import pytest
import requests

from character_workflow.lib import gateway_keys, gateway_tasks, keys, model_routes
from character_workflow.lib.callers import task_submission, tuzi_async
from tests.test_caller_submission_types import (  # noqa: F401  (isolated 是 autouse 夹具)
    FAULTS, _closed_base, _http, _route_posts, _Stop, _Upstream, isolated,
)

TUZI = "https://api.tu-zi.com"
# (主机 error_kind 或 switch, 本机分类)
EXPECTED = {
    "refused": ("switch", "network"), "close": ("unconfirmed", "unconfirmed"),
    "silent": ("unconfirmed", "unconfirmed"), "5xx": ("unconfirmed", "unconfirmed"),
    "2xx_not_json": ("unconfirmed", "unconfirmed"), "2xx_no_id": ("unconfirmed", "unconfirmed"),
    "4xx": ("failed", "rejected"),
}
REPLIES = {
    "5xx": _http(503, '{"error": {"message": "busy"}}'),
    "2xx_not_json": _http(200, "<html>ok</html>", "text/html"),
    "2xx_no_id": _http(200, '{"status": "queued"}'),
    "4xx": _http(400, '{"error": {"message": "bad size"}}'),
}


def _upstream(fault):
    if fault == "refused":
        return None
    if fault in ("close", "silent"):
        return _Upstream(mode=fault)
    return _Upstream(reply=REPLIES[fault])


@pytest.mark.parametrize("fault", FAULTS)
def test_local_submit_is_classified_by_type(monkeypatch, fault):
    upstream = _upstream(fault)
    sent = _route_posts(monkeypatch, {"first": upstream.base if upstream else _closed_base()})
    expected = EXPECTED[fault][1]
    raised = requests.RequestException if expected == "network" else tuzi_async.TuziAsyncError
    try:
        with pytest.raises(raised) as error:
            tuzi_async.execute_json(url=f"{TUZI}/v1/images/generations", api_key="first-test-secret",
                                    payload={"model": "gpt-image-2", "prompt": "海边的灯塔"})
    finally:
        if upstream:
            upstream.close()
    assert sent == ["first"]
    assert task_submission.is_unconfirmed(error.value) is (expected == "unconfirmed")
    if expected == "network":
        assert task_submission.network_outcome(error.value) == "not_sent"
    if expected == "unconfirmed":
        assert "未确认" in str(error.value)


def _two_tuzi_keys():
    for alias in ("first", "second"):
        keys.add_key(keys.KeySpec(
            alias=alias, provider="custom", access_key=f"{alias}-test-secret", base_url=TUZI,
            modalities=["image"], created_at="test",
            models=[keys.ModelSpec(id="gpt-image-2", name="gpt-image-2", modality="image")]))
    owner = gateway_keys.create_key("小王")[0]
    route = next(r for r in model_routes.list_routes("image") if len(r.members) == 2)
    task = gateway_tasks.submit(owner, idempotency_key="k1", model=route.id, prompt="海边的灯塔",
                                n=1, size="1024x1024", params={}, files={}, kind="image")
    return gateway_tasks._update(task.task_id, status="running")


def _run(monkeypatch, first_reply_or_mode):
    if first_reply_or_mode == "refused":
        first = None
    elif first_reply_or_mode in ("close", "silent"):
        first = _Upstream(mode=first_reply_or_mode)
    else:
        first = _Upstream(reply=first_reply_or_mode)
    ok = _Upstream(reply=_http(200, '{"id": "paid-1", "status": "queued"}'))
    sent = _route_posts(monkeypatch, {"first": first.base if first else _closed_base(), "second": ok.base})
    task = _two_tuzi_keys()
    return task, sent, [server for server in (first, ok) if server]


@pytest.mark.parametrize("fault", FAULTS)
def test_through_the_gateway_follows_the_unified_rule(monkeypatch, fault):
    task, sent, servers = _run(monkeypatch, REPLIES.get(fault, fault))
    host_kind = EXPECTED[fault][0]
    try:
        if host_kind == "switch":
            with pytest.raises(_Stop):  # 第二把 KEY 提交成功、进了轮询
                gateway_tasks.run_task(task)
        else:
            finished = gateway_tasks.run_task(task)
            assert finished.status == "failed" and finished.error_kind == host_kind
            assert finished.charged_cny == 0
    finally:
        for server in servers:
            server.close()
    assert sent == (["first", "second"] if host_kind == "switch" else ["first"])


def test_5xx_saying_no_channel_no_longer_fails_over(monkeypatch):
    """对齐前：503 正文带「无可用渠道」被判「不可用」、直接换第二把 KEY，可能两家各下一单。"""
    task, sent, servers = _run(monkeypatch, _http(503, '{"error": {"message": "无可用渠道（distributor）"}}'))
    try:
        finished = gateway_tasks.run_task(task)
    finally:
        for server in servers:
            server.close()
    assert sent == ["first"]  # 第二把 KEY 提交 0 次
    assert finished.status == "failed" and finished.error_kind == "unconfirmed"
    assert finished.charged_cny == 0
    assert "无可用渠道" in finished.error  # 原文案保留
