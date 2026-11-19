"""第 4 批 4-1：主机确定没收下的提交（更新排空的 503、连接前失败）——等待并用同一把幂等键重发。

主机是真实回环网关（B1 / B2 的夹具），全部本机，不发计费请求。
选「自动」的任务照旧换组内下一家；明确选了网关的，创作台进「等待网关」，画布在线程里重试。
"""
from __future__ import annotations

import threading
from contextlib import contextmanager

import pytest

from character_workflow.lib import job_runner, model_routes
from character_workflow.lib.callers import atelier_gateway
from character_workflow.lib.jobs import is_resumable_studio_job, read_job
from character_workflow.lib.schemas import JobStatus
from tests import test_gateway_client as _client_harness
from tests import test_gateway_reattach as _reattach_harness
from tests import test_gateway_waiting as _waiting_harness

_fast = _client_harness._fast
gateway = _client_harness.gateway
upstream = _client_harness.upstream
faults = _reattach_harness.faults
_host_tasks = _reattach_harness._host_tasks
_now_job = _reattach_harness._now_job
_studio_run = _waiting_harness._studio_run
_studio_waiter_running = _waiting_harness._studio_waiter_running


@contextmanager
def _host_updating():
    from viewer_server.update_routes import admission

    gate = admission()
    with gate.lock:
        gate.maintenance = True
    try:
        yield gate
    finally:
        with gate.lock:
            gate.maintenance = False


def _set_updating(on: bool) -> None:
    from viewer_server.update_routes import admission

    gate = admission()
    with gate.lock:
        gate.maintenance = on


def test_update_drain_503_carries_the_structured_code(gateway):
    session = atelier_gateway._session()
    with _host_updating():
        response = session.post(f"{gateway['base']}/gateway/v1/tasks", timeout=5,
                                headers={"Authorization": f"Bearer {gateway['token']}"})
    assert response.status_code == 503 and response.json()["code"] == "updating"


def test_studio_waits_while_the_host_updates_and_resends_with_the_same_key(gateway, upstream):
    job_id = _now_job("job-upd", route_id=None).job_id  # 明确选了网关
    with _host_updating():
        assert _studio_run(job_id) is True  # 等待者会接着重跑
    waiting = read_job(job_id)
    assert waiting.status == JobStatus.PENDING and waiting.progress_phase == "waiting_gateway"
    assert waiting.params.gateway_unconfirmed is True and is_resumable_studio_job(waiting)
    assert _host_tasks() == []  # 主机没收下
    key = waiting.params.gateway_idempotency_key

    assert _studio_run(job_id) is False  # 更新结束：同一把键重发
    done = read_job(job_id)
    assert done.status == JobStatus.DONE and done.params.gateway_idempotency_key == key
    [host] = _host_tasks()
    assert host.idempotency_key == key and len(upstream["calls"]) == 1


def test_studio_waits_when_the_host_cannot_be_reached(gateway, upstream, faults):
    job_id = _now_job("job-down", route_id=None).job_id
    faults.down_posts = 1  # 连接都没建立
    assert _studio_run(job_id) is True
    waiting = read_job(job_id)
    assert waiting.status == JobStatus.PENDING and waiting.progress_phase == "waiting_gateway"
    assert _studio_run(job_id) is False
    assert read_job(job_id).status == JobStatus.DONE and len(_host_tasks()) == 1


def test_auto_route_still_switches_to_the_members_own_key(gateway, upstream):
    """Q2=A：选「自动」时照旧先换本机 KEY，不等主机。"""
    job_id = _now_job("job-auto").job_id  # route_id=gpt-image-2：组内 Hub → Local
    with _host_updating():
        assert _studio_run(job_id) is False
    done = read_job(job_id)
    assert done.status == JobStatus.DONE and done.alias == "Local"
    assert any("正在更新" in warning for warning in done.params.warnings or [])
    assert _host_tasks() == []
    assert model_routes.failover_reason(
        atelier_gateway.GatewayNotAccepted("x", reason="updating")) == "updating"


def test_old_host_without_the_code_keeps_failing_as_before(gateway, upstream, monkeypatch):
    from viewer_server import update_routes

    monkeypatch.setattr(update_routes, "UPDATING_CODE", None)  # 旧主机：503 不带 code
    job_id = _now_job("job-old", route_id=None).job_id
    with _host_updating():
        assert _studio_run(job_id) is False
    failed = read_job(job_id)
    assert failed.status == JobStatus.FAILED and "正在更新" in failed.error


def test_canvas_retries_in_thread_until_the_update_is_over(gateway, upstream, monkeypatch):
    from character_workflow.lib.canvas_projects import read_canvas_document
    from character_workflow.lib.canvas_runs import run_canvas_job, submit_canvas_run

    monkeypatch.setattr(atelier_gateway, "SUBMIT_RETRY_SECONDS", 0.05)
    phases = []
    real = job_runner.update_job_phase
    monkeypatch.setattr(job_runner, "update_job_phase",
                        lambda job_id, phase: phases.append(phase) or real(job_id, phase))
    pid = _reattach_harness._canvas_project()
    job, _doc = submit_canvas_run(pid, "config", read_canvas_document(pid).revision)
    _set_updating(True)
    timer = threading.Timer(0.5, _set_updating, args=(False,))
    timer.start()
    try:
        run_canvas_job(job.job_id)
    finally:
        timer.cancel()
        _set_updating(False)
    done = read_job(job.job_id)
    assert done.status == JobStatus.DONE and "waiting_gateway" in phases
    assert len(_host_tasks()) == 1 and len(upstream["calls"]) == 1


def test_canvas_waits_only_when_the_gateway_was_chosen_explicitly(gateway):
    explicit = _now_job("job-canvas-x", route_id=None).model_copy(update={"namespace": "canvas"})
    auto = _now_job("job-canvas-a").model_copy(update={"namespace": "canvas"})
    assert job_runner._gateway_kwargs(explicit)["gateway_submit_wait"] == 1800
    assert "gateway_submit_wait" not in job_runner._gateway_kwargs(auto)


def test_direct_run_job_without_the_studio_waiter_still_fails(gateway, upstream):
    job_id = _now_job("job-cli", route_id=None).job_id
    with _host_updating(), pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job(job_id)
    assert read_job(job_id).status == JobStatus.FAILED
