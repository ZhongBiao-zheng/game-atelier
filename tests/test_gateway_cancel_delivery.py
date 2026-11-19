"""第 5 批 5-3：成员点停止送到主机（飙哥定 Q3-1=B「跑完并计费」）。

主机：没发上游的取消、扣 0；已发上游的跑完并按成功规则扣，取消回应带 `cancel_outcome`；按幂等键取消，
主机没收到这把键时记「已取消」占位，后到的同键提交不会执行。
成员：停止请求没送到时记在任务上，恢复连接后补发；主机答「继续执行」时本机立即停，再次生成请求相同时接回取结果。
"""
from __future__ import annotations

import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import callers, gateway_cancel_outbox, gateway_keys, gateway_tasks, job_runner
from character_workflow.lib.callers import atelier_gateway
from character_workflow.lib.jobs import gateway_reattach_params, read_job, save_job, update_job_phase
from character_workflow.lib.schemas import JobStatus
from tests import test_gateway as _host
from tests import test_gateway_client as _member
from tests import test_gateway_reattach as _reattach
from viewer_server.gateway_app import create_gateway_app

_fast = _member._fast
gateway = _member.gateway
upstream = _member.upstream
faults = _reattach.faults


def _key(seconds_ago: float = 0, fill: str = "c") -> str:
    return f"{int(time.time() - seconds_ago)}-{fill * 32}"


# ---------------------------------------------------------------- 主机


@pytest.fixture
def host(isolated_data_root, monkeypatch):
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    _host._seed_keys()
    record, token = gateway_keys.create_key("小王", None)
    client = TestClient(create_gateway_app())
    client.headers["Authorization"] = f"Bearer {token}"
    client.record = record  # type: ignore[attr-defined]
    calls: list[dict] = []
    monkeypatch.setattr(callers, "dispatch", _host._dispatch(calls))
    return client, calls


def _submit(client, key):
    body = {"kind": "image", "model": "gpt-image-2", "prompt": "一只猫", "n": 1, "params": {}}
    return client.post("/gateway/v1/tasks", data={"request": json.dumps(body)},
                       headers={"Idempotency-Key": key}).json()["task_id"]


def _usage_count():
    return len(gateway_tasks.read_usage(gateway_tasks._now().astimezone().strftime("%Y-%m")))


def test_cancel_before_upstream_is_canceled_and_free(host):
    client, calls = host
    task_id = _submit(client, _key())
    gateway_tasks._update(task_id, status="running")  # 开始执行、还没发出
    view = client.post(f"/gateway/v1/tasks/{task_id}/cancel").json()
    assert view["cancel_outcome"] == "canceled"
    done = gateway_tasks.run_task(gateway_tasks.get_task(client.record.id, task_id))
    assert done.status == "canceled" and done.charged_cny == 0 and calls == []


def test_cancel_after_upstream_keeps_running_and_charges_on_success(host):
    client, calls = host
    task_id = _submit(client, _key())
    gateway_tasks._update(task_id, status="running", sent_at=gateway_tasks._now().isoformat())
    view = client.post(f"/gateway/v1/tasks/{task_id}/cancel").json()
    assert view["cancel_outcome"] == "continuing" and view["status"] == "running"
    assert gateway_tasks.get_task(client.record.id, task_id).cancel_requested is False
    done = gateway_tasks.run_task(gateway_tasks.get_task(client.record.id, task_id))
    assert done.status == "done" and done.charged_cny == done.estimated_cny and len(calls) == 1


def test_cancel_by_key_reaches_the_task_the_member_never_got_an_id_for(host):
    client, _calls = host
    key = _key()
    task_id = _submit(client, key)
    view = client.post("/gateway/v1/tasks/cancel", json={"idempotency_key": key}).json()
    assert view["task_id"] == task_id and view["cancel_outcome"] == "canceled"
    assert gateway_tasks.get_task(client.record.id, task_id).status == "canceled"


def test_cancel_by_key_before_the_host_got_it_blocks_the_late_submit(host):
    client, calls = host
    key = _key()
    rows_before = _usage_count()
    view = client.post("/gateway/v1/tasks/cancel", json={"idempotency_key": key}).json()
    assert view["status"] == "canceled" and view["cancel_outcome"] == "canceled"
    late = _submit(client, key)  # 成员读超时放弃后，主机才收完那次提交
    assert late == view["task_id"]
    assert gateway_tasks.get_task(client.record.id, late).status == "canceled" and calls == []
    assert _usage_count() == rows_before  # 占位不写用量行


def test_cancel_by_key_rejects_bad_or_old_keys_and_caps_placeholders(host, monkeypatch):
    client, _calls = host
    assert client.post("/gateway/v1/tasks/cancel", json={"idempotency_key": "abc"}).status_code == 422
    old = _key(seconds_ago=21 * 3600)
    assert client.post("/gateway/v1/tasks/cancel", json={"idempotency_key": old}).status_code == 422
    monkeypatch.setattr(gateway_tasks, "TOMBSTONE_LIMIT", 1)
    assert client.post("/gateway/v1/tasks/cancel",
                       json={"idempotency_key": _key(fill="d")}).status_code == 200
    assert client.post("/gateway/v1/tasks/cancel",
                       json={"idempotency_key": _key(fill="e")}).status_code == 429


# ---------------------------------------------------------------- 成员


@pytest.fixture
def no_thread(monkeypatch):
    """测试里同步调用 deliver_once，不起补发线程。"""
    monkeypatch.setattr(gateway_cancel_outbox, "wake", lambda: None)


def _host_submit(gateway, key):
    """经真实回环网关提交一个主机任务（不经成员端 run_job）。"""
    session = atelier_gateway._session()
    headers = {"Authorization": f"Bearer {gateway['token']}"}
    return atelier_gateway._submit(session, gateway["base"], headers, alias="Hub", kind="image",
                                   model="gpt-image-2", prompt="一只猫", n=1, params={},
                                   uploads={}, idempotency_key=key)


def _stop_via_route(job_id):
    from tests.local_client import LocalTestClient
    from viewer_server.server_app import build_app

    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app())
    return client.post(f"/api/jobs/{job_id}/cancel").json()


def test_stop_of_a_waiting_job_is_delivered_and_the_host_cancels(gateway, upstream, faults,
                                                                 no_thread, monkeypatch):
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)  # 主机任务留在排队中
    key = _key()
    host_task = _host_submit(gateway, key)
    job = _reattach._now_job("job-stop-1", gateway_idempotency_key=key, gateway_unconfirmed=True,
                             provider_task_protocol="atelier_gateway", provider_task_ids=[host_task])
    update_job_phase(job.job_id, "waiting_gateway")
    assert _stop_via_route(job.job_id)["status"] == "canceled"
    assert read_job(job.job_id).params.gateway_cancel_pending is True
    assert gateway_cancel_outbox.deliver_once() is False
    stopped = read_job(job.job_id)
    assert stopped.params.gateway_cancel_pending is None and stopped.error == "已停止"
    assert gateway_tasks._read(host_task).status == "canceled"
    assert upstream["calls"] == []


def test_undelivered_stop_survives_a_failed_retry_then_lands(gateway, upstream, no_thread,
                                                             monkeypatch):
    """三步：停止时网关连不上（记下）→ 补发时又连不上（保留）→ 恢复后送达（清除）。"""
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    key = _key()
    host_task = _host_submit(gateway, key)
    job = _reattach._now_job("job-stop-2", gateway_idempotency_key=key, gateway_unconfirmed=True,
                             gateway_cancel_pending=True, provider_task_protocol="atelier_gateway",
                             provider_task_ids=[host_task])
    save_job(read_job(job.job_id).model_copy(update={
        "status": JobStatus.CANCELED, "error": job_runner.GATEWAY_CANCEL_UNDELIVERED}))
    real = atelier_gateway.cancel_by_key

    def down(*_args, **_kwargs):
        raise atelier_gateway.requests.ConnectionError("gateway down")

    monkeypatch.setattr(atelier_gateway, "cancel_by_key", down)
    assert gateway_cancel_outbox.deliver_once() is True
    assert read_job(job.job_id).params.gateway_cancel_pending is True
    monkeypatch.setattr(atelier_gateway, "cancel_by_key", real)
    assert gateway_cancel_outbox.deliver_once() is False
    landed = read_job(job.job_id)
    assert landed.params.gateway_cancel_pending is None and landed.error == "已停止"
    assert gateway_tasks._read(host_task).status == "canceled"


def test_stop_after_upstream_stops_at_once_and_regenerate_takes_the_result(gateway, upstream,
                                                                           faults, no_thread,
                                                                           monkeypatch):
    """主机已发上游：成员停止后本机立即停（不等出图），主机跑完并扣费；再次生成请求相同时接回取结果。"""
    release = threading.Event()
    fast_render = _member.openai_image.render

    def slow_render(**kwargs):
        release.wait(10)
        return fast_render(**kwargs)

    monkeypatch.setattr(_member.openai_image, "render", slow_render)

    def should_cancel():
        tasks = gateway_tasks._all_tasks()
        return bool(tasks and tasks[0].sent_at)

    job = _reattach._now_job("job-stop-3")
    started = time.monotonic()
    with pytest.raises(job_runner.JobCanceled):
        job_runner.run_job(job.job_id, should_cancel=should_cancel)
    assert time.monotonic() - started < 5  # 没等上游出图
    stopped = read_job(job.job_id)
    assert stopped.status == JobStatus.CANCELED
    assert stopped.error == job_runner.GATEWAY_CANCEL_CONTINUING
    assert stopped.params.gateway_unconfirmed is True and stopped.params.gateway_cancel_pending is None
    release.set()
    [host_task] = _reattach._host_settled()
    # 按成功规则结算（夹具里上游无同步价，估价为空、扣 0；有价时扣估价，见主机侧用例）。
    assert host_task.status == "done" and host_task.charged_cny == (host_task.estimated_cny or 0)

    monkeypatch.setattr(_member.openai_image, "render", fast_render)
    again = _reattach._regenerate(stopped, "job-stop-3b")
    assert again.status == JobStatus.DONE and again.params.gateway_reattach_of == stopped.job_id
    assert len(_reattach._host_tasks()) == 1


def test_only_stopped_rounds_whose_host_task_may_still_finish_are_reattached():
    from character_workflow.lib.schemas import Job, JobKind, JobParams

    stopped = Job(job_id="s1", character_id="A", prompt="猫", submitted_at="2026-11-19T00:00:00+00:00",
                  model="gpt-image-2", params=JobParams(gateway_idempotency_key=_key(),
                                                        gateway_request_fingerprint="f" * 64,
                                                        gateway_unconfirmed=True),
                  output_paths=[], status=JobStatus.CANCELED, error="已停止", kind=JobKind.IMAGE,
                  namespace="studio", alias="Hub", provider="atelier")
    assert gateway_reattach_params(stopped, "Hub")["gateway_reattach_of"] == "s1"
    confirmed = stopped.model_copy(update={"params": stopped.params.model_copy(
        update={"gateway_unconfirmed": None})})
    assert gateway_reattach_params(confirmed, "Hub") == {}  # 主机已确认取消的不接回


def test_old_host_without_cancel_by_key_falls_back_to_the_task_id(monkeypatch):
    from types import SimpleNamespace

    sent: list[str] = []

    class _Session:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def post(self, url, **_kwargs):
            sent.append(url)
            status = 405 if url.endswith("/tasks/cancel") else 200
            return SimpleNamespace(status_code=status, json=lambda: {"status": "canceled"})

    monkeypatch.setattr(atelier_gateway, "_session", _Session)
    monkeypatch.setattr(atelier_gateway, "_raise_for_status", lambda _response: None)
    key = SimpleNamespace(base_url="http://hub", access_key="t")
    body = atelier_gateway.cancel_by_key(key, _key(), task_ids=["t-1"])
    assert sent == ["http://hub/gateway/v1/tasks/cancel", "http://hub/gateway/v1/tasks/t-1/cancel"]
    assert body["cancel_outcome"] == "canceled"


def test_outbox_thread_exits_when_nothing_is_pending(isolated_data_root):
    gateway_cancel_outbox.wake()
    thread = gateway_cancel_outbox._thread
    thread.join(5)
    assert not thread.is_alive()


def test_expired_stops_are_no_longer_retried(isolated_data_root):
    job = _reattach._now_job("job-stop-old", gateway_idempotency_key=_key(seconds_ago=21 * 3600),
                             gateway_cancel_pending=True)
    save_job(read_job(job.job_id).model_copy(update={"status": JobStatus.CANCELED}))
    assert gateway_cancel_outbox.pending_job_ids() == []


@pytest.mark.parametrize(("base_url", "expected"), [
    ("http://127.0.0.1:8188", "canceled"),          # 主机本机 ComfyUI：真的取消、扣 0
    ("https://www.runninghub.cn", "continuing"),    # 非本机地址：不在例外里，按「跑完并计费」
])
def test_only_comfyui_running_on_this_host_is_really_canceled_after_sending(host, base_url,
                                                                           expected):
    client, _calls = host
    task_id = _submit(client, _key())
    gateway_tasks._update(task_id, status="running", sent_at=gateway_tasks._now().isoformat(),
                          member_provider="comfyui", member_base_url=base_url)
    view = client.post(f"/gateway/v1/tasks/{task_id}/cancel").json()
    assert view["cancel_outcome"] == expected
    assert gateway_tasks.get_task(client.record.id, task_id).cancel_requested is (expected == "canceled")
