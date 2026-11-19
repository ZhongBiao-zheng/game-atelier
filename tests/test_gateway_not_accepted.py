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


# ---------------------------------------------------------------- 结局未知时「自动」也不换家
# 任务 1 提交回应丢失（主机已收到、在出图）；重新生成的任务 2 沿用这把键，主机连不上或正在更新时
# 不能换到成员本机 KEY：主机上的原单照常出图扣额度，本机 KEY 又出一张。


def _auto_canvas_project() -> str:
    """生成节点选「自动」（alias 为空：route_id = 模型，组内 Hub 在前、Local 在后）。"""
    from character_workflow.lib.canvas_projects import read_canvas_document, save_canvas_document
    from character_workflow.lib.schemas import CanvasDocument

    pid = _reattach_harness._canvas_project()
    current = read_canvas_document(pid)
    payload = current.model_dump(mode="json")
    for node in payload["nodes"]:
        if node["id"] == "config":
            node["data"]["generation_draft"]["alias"] = None
    save_canvas_document(pid, CanvasDocument.model_validate(payload), current.revision)
    return pid


def _canvas_attempt(pid):
    from character_workflow.lib.canvas_projects import read_canvas_document
    from character_workflow.lib.canvas_runs import run_canvas_job, submit_canvas_run

    job, _doc = submit_canvas_run(pid, "config", read_canvas_document(pid).revision)
    try:
        run_canvas_job(job.job_id)
    except Exception:  # noqa: BLE001 — 画布 runner 失败时可能抛出，下面看落盘结果
        pass
    return read_job(job.job_id)


def _host_settled(timeout=10.0):
    """主机上的任务都进终态（它们在别的线程里跑），再数上游调用。"""
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        tasks = _host_tasks()
        if tasks and all(task.status in ("done", "failed", "canceled") for task in tasks):
            return tasks
        time.sleep(0.05)
    raise AssertionError("主机任务没有在时限内结束")


def test_auto_canvas_never_fails_over_while_the_original_outcome_is_unknown(gateway, upstream,
                                                                           faults):
    pid = _auto_canvas_project()
    faults.lost_posts = 3  # 主机收到了，回应丢了
    task1 = _canvas_attempt(pid)
    assert task1.status == JobStatus.FAILED and task1.params.gateway_unconfirmed is True
    assert task1.params.route_id == "gpt-image-2" and task1.alias == "Hub"
    _host_settled()
    calls_after_task1 = len(upstream["calls"])

    faults.down_posts = 3  # 主机连不上
    task2 = _canvas_attempt(pid)
    assert task2.params.gateway_reattach_of == task1.job_id
    assert task2.status == JobStatus.FAILED and task2.alias == "Hub"  # 没有换家
    assert "未确认" in task2.error and "可改选其他供应商" in task2.error
    assert not task2.params.warnings  # 没有「已改用 …」
    assert len(upstream["calls"]) == calls_after_task1  # 成员本机 KEY 没有出图

    faults.down_posts = 0  # 主机恢复
    task3 = _canvas_attempt(pid)
    assert task3.status == JobStatus.DONE and task3.alias == "Hub"
    [host] = _host_settled()
    assert task3.params.provider_task_ids == [host.task_id] and len(upstream["calls"]) == 1


def test_auto_canvas_with_a_fresh_key_still_fails_over_when_not_accepted(gateway, upstream,
                                                                         faults):
    """Q2=A：新键、主机没收下（连不上）时「自动」照旧换家——上面的守卫没有误伤。"""
    pid = _auto_canvas_project()
    faults.down_posts = 1
    done = _canvas_attempt(pid)
    assert done.status == JobStatus.DONE and done.alias == "Local"
    assert any("连不上" in warning for warning in done.params.warnings or [])
    assert _host_tasks() == []


def test_failover_reason_refuses_when_the_key_outcome_is_unknown():
    not_accepted = atelier_gateway.GatewayNotAccepted("x", reason="updating")
    try:
        raise atelier_gateway.GatewayUnconfirmed("原任务结果未确认") from not_accepted
    except atelier_gateway.GatewayUnconfirmed as error:
        assert model_routes.failover_reason(error) is None
    assert model_routes.failover_reason(not_accepted) == "updating"


def test_switch_route_refuses_while_the_gateway_key_is_unconfirmed(gateway):
    job = _now_job("job-guard", gateway_unconfirmed=True)  # 自动路由
    error = atelier_gateway.GatewayNotAccepted("x", reason="unreachable")
    assert model_routes.failover_reason(error) == "unreachable"  # 单看错误是可以换家的
    assert job_runner._switch_route(job.job_id, error) is False
    assert read_job(job.job_id).alias == "Hub"
