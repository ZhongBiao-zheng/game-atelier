"""第 2 批 B2：创作台「等待网关」、后台接回、20 小时期限、画布线程内等 30 分钟。

主机是真实回环网关，成员端网络故障沿用 B1 的可注入故障 Session。全部本机，不发计费请求。
"""
from __future__ import annotations

import asyncio
import time

import pytest

from character_workflow.lib import job_runner
from character_workflow.lib.callers import atelier_gateway
from character_workflow.lib.jobs import (
    fail_orphan_studio_jobs, is_resumable_studio_job, read_job, save_job,
)
from character_workflow.lib.schemas import JobStatus
from tests import test_gateway_client as _client_harness
from tests import test_gateway_reattach as _reattach_harness
from tests.test_gateway_client import _job

_fast = _client_harness._fast
gateway = _client_harness.gateway
upstream = _client_harness.upstream
faults = _reattach_harness.faults
_host_tasks = _reattach_harness._host_tasks


@pytest.fixture(autouse=True)
def _studio_waiter_running():
    """同一个进程里别的用例关掉过应用时，创作台等待者的关停信号会留着：每条用例前复位。"""
    from viewer_server import routes

    routes._reset_studio_recovery_workers()
    yield
    routes._reset_studio_recovery_workers()


def _studio_run(job_id):
    from viewer_server import routes

    return routes._run_studio_job_once(job_id)


def _park(job_id, faults):
    """提交三次回应都丢了（主机已收到）：创作台任务进入「等待网关」。"""
    faults.lost_posts = 3
    assert _studio_run(job_id) is True  # 等待者会接着重跑
    waiting = read_job(job_id)
    assert waiting.status == JobStatus.PENDING and waiting.progress_phase == "waiting_gateway"
    assert waiting.params.gateway_unconfirmed is True
    return waiting


def _age_key(job_id, hours):
    job = read_job(job_id)
    key = job.params.gateway_idempotency_key
    aged = f"{int(time.time() - hours * 3600)}-{key.split('-')[1]}"
    save_job(job.model_copy(update={"params": job.params.model_copy(update={
        "gateway_idempotency_key": aged})}))


def test_studio_waits_for_the_gateway_and_reattaches_when_it_is_back(gateway, upstream, faults):
    job_id = _job("job-wait").job_id
    _park(job_id, faults)
    assert is_resumable_studio_job(read_job(job_id))
    assert _studio_run(job_id) is False  # 网关恢复：同一把键接回原任务
    done = read_job(job_id)
    assert done.status == JobStatus.DONE and not done.params.gateway_unconfirmed
    assert len(_host_tasks()) == 1 and len(upstream["calls"]) == 1


def test_waiting_job_is_only_probed_while_the_gateway_is_down(gateway, upstream, faults,
                                                              monkeypatch):
    job_id = _job("job-probe").job_id
    _park(job_id, faults)
    gateway["server"].stop()
    sent = []
    monkeypatch.setattr(atelier_gateway, "_submit", lambda *a, **k: sent.append(1))
    assert _studio_run(job_id) is True
    assert sent == [] and read_job(job_id).progress_phase == "waiting_gateway"


def test_poll_outage_shows_waiting_then_parks(gateway, upstream, faults, monkeypatch):
    phases = []
    real = job_runner.update_job_phase
    monkeypatch.setattr(job_runner, "update_job_phase",
                        lambda job_id, phase: phases.append(phase) or real(job_id, phase))
    monkeypatch.setattr(atelier_gateway, "POLL_GIVE_UP_SECONDS", 0.3)
    faults.down_gets = 10_000
    job_id = _job("job-poll").job_id
    assert _studio_run(job_id) is True
    assert "waiting_gateway" in phases
    assert read_job(job_id).progress_phase == "waiting_gateway"
    faults.down_gets = 0
    assert _studio_run(job_id) is False
    assert read_job(job_id).status == JobStatus.DONE and len(_host_tasks()) == 1


def test_short_poll_outage_recovers_in_the_same_run(gateway, upstream, faults, monkeypatch):
    phases = []
    real = job_runner.update_job_phase
    monkeypatch.setattr(job_runner, "update_job_phase",
                        lambda job_id, phase: phases.append(phase) or real(job_id, phase))
    faults.down_gets = 2
    job_id = _job("job-blip").job_id
    assert _studio_run(job_id) is False
    assert read_job(job_id).status == JobStatus.DONE
    waiting_at = phases.index("waiting_gateway")
    assert "sent" in phases[waiting_at + 1:]  # 恢复后阶段改回来


def test_waiting_expires_twenty_hours_after_the_key_was_issued(gateway, upstream, faults,
                                                               monkeypatch):
    job_id = _job("job-expire").job_id
    _park(job_id, faults)
    _age_key(job_id, 21)
    sent = []
    monkeypatch.setattr(atelier_gateway, "_submit", lambda *a, **k: sent.append(1))
    assert _studio_run(job_id) is False
    expired = read_job(job_id)
    assert expired.status == JobStatus.FAILED and "20 小时" in expired.error and sent == []
    assert not is_resumable_studio_job(expired)


def test_restart_keeps_waiting_jobs(gateway, upstream, faults):
    job_id = _job("job-restart").job_id
    _park(job_id, faults)
    assert job_id not in fail_orphan_studio_jobs()
    assert read_job(job_id).status == JobStatus.PENDING


def test_stopping_a_waiting_job_ends_it_at_once(gateway, upstream, faults):
    from tests.local_client import LocalTestClient
    from viewer_server.server_app import build_app

    job_id = _job("job-stop").job_id
    _park(job_id, faults)
    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app())
    assert client.post(f"/api/jobs/{job_id}/cancel").json()["status"] == "canceled"
    stopped = read_job(job_id)
    assert stopped.status == JobStatus.CANCELED and "网关" in stopped.error
    assert _studio_run(job_id) is False  # 等待者随后退出


def test_waiter_keeps_going_after_one_round_raises(monkeypatch):
    from viewer_server import routes

    rounds = []

    def flaky(job_id):
        rounds.append(job_id)
        if len(rounds) == 1:
            raise RuntimeError("boom")
        return False

    monkeypatch.setattr(routes, "_run_studio_job_once", flaky)
    monkeypatch.setattr(routes, "_STUDIO_RECOVERY_DELAY_SECONDS", 0)
    asyncio.run(routes._run_studio_job_safely("job-x"))
    assert rounds == ["job-x", "job-x"]


def test_task_gone_on_the_host_fails_instead_of_waiting(gateway, upstream, faults):
    job_id = _job("job-gone", provider_task_protocol="atelier_gateway",
                  provider_task_ids=["0" * 32]).job_id
    assert _studio_run(job_id) is False
    gone = read_job(job_id)
    assert gone.status == JobStatus.FAILED and "找不到任务" in gone.error


def test_canvas_waits_thirty_minutes_in_thread_then_fails_unconfirmed(gateway, upstream, faults,
                                                                      monkeypatch):
    from character_workflow.lib.canvas_projects import read_canvas_document
    from character_workflow.lib.canvas_runs import run_canvas_job, submit_canvas_run

    seen = []

    def give_up_now(*_args, give_up, **_kwargs):
        seen.append(give_up)
        raise atelier_gateway.GatewayUnconfirmed("网关任务结果未确认（查询失败）")

    monkeypatch.setattr(atelier_gateway, "_poll", give_up_now)
    pid = _reattach_harness._canvas_project()
    job, _doc = submit_canvas_run(pid, "config", read_canvas_document(pid).revision)
    try:
        run_canvas_job(job.job_id)
    except Exception:  # noqa: BLE001 — 画布 runner 失败时可能抛出，下面看落盘结果
        pass
    failed = read_job(job.job_id)
    assert seen == [job_runner.CANVAS_GATEWAY_POLL_GIVE_UP_SECONDS] == [1800]
    # 画布没有等待网关的后台接回：到期判失败、保留标记，「重新生成」时接回（B1）。
    assert failed.status == JobStatus.FAILED and failed.params.gateway_unconfirmed is True


def test_direct_run_job_without_the_studio_waiter_still_fails(gateway, upstream, faults):
    faults.lost_posts = 3
    job_id = _job("job-cli").job_id
    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job(job_id)
    assert read_job(job_id).status == JobStatus.FAILED


def test_stop_while_the_gateway_is_unreachable_ends_the_run_now(gateway, upstream, faults,
                                                                monkeypatch):
    """线程里还在轮询（画布等 30 分钟）时用户停止、网关又连不上：本机立刻停，不等到期。"""
    from character_workflow.lib.jobs import request_job_cancel

    faults.down_gets = 10_000
    monkeypatch.setattr(atelier_gateway, "POLL_GIVE_UP_SECONDS", 600)
    real = job_runner.update_job_phase

    def phase_then_stop(job_id, phase):
        result = real(job_id, phase)
        if phase == "waiting_gateway":
            request_job_cancel(job_id)
        return result

    monkeypatch.setattr(job_runner, "update_job_phase", phase_then_stop)
    job_id = _job("job-stop-live").job_id
    started = time.monotonic()
    with pytest.raises(job_runner.JobCanceled):
        job_runner.run_job(job_id)
    assert time.monotonic() - started < 30
    assert read_job(job_id).status == JobStatus.CANCELED


def test_shutdown_while_polling_parks_instead_of_canceling(gateway, upstream, faults, monkeypatch):
    """本机服务关停不是用户停止：不向主机发取消、不落「已停止」，留在等待网关，下次启动接回。"""
    import threading

    from character_workflow.lib.callers import openai_image
    from viewer_server import routes

    release = threading.Event()
    real_render = openai_image.render

    def slow_render(**kwargs):
        release.wait(10)  # 主机上的任务还在跑
        return real_render(**kwargs)

    monkeypatch.setattr(openai_image, "render", slow_render)
    job_id = _job("job-shutdown").job_id
    threading.Timer(0.5, routes._stop_studio_recovery_workers).start()
    assert _studio_run(job_id) is True  # 关停：停下轮询，任务仍可续查
    parked = read_job(job_id)
    assert parked.status == JobStatus.PENDING and parked.progress_phase == "waiting_gateway"
    [host] = _host_tasks()
    assert host.status in ("pending", "running") and not host.cancel_requested

    routes._reset_studio_recovery_workers()  # 下次启动（lifespan 开始时复位）
    release.set()
    assert _studio_run(job_id) is False
    assert read_job(job_id).status == JobStatus.DONE
    assert len(_host_tasks()) == 1 and len(upstream["calls"]) == 1


def test_shutdown_leaves_a_parked_job_pending(gateway, upstream, faults):
    from viewer_server import routes

    job_id = _job("job-parked-shutdown").job_id
    _park(job_id, faults)
    routes._stop_studio_recovery_workers()
    still = read_job(job_id)
    assert still.status == JobStatus.PENDING and still.progress_phase == "waiting_gateway"
    assert is_resumable_studio_job(still)
