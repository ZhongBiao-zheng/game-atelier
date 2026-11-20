"""第 6 批 6-2(a)：停止后主机仍跑完并扣费，扣费回写到成员那条「已停止」任务；同一把幂等键只记一次（对称规则）。

谁先拿到主机终态谁记金额（gateway_charges 按幂等键原子登记），另一条不记、在 gateway_charged_on 指明记在哪条：
- 方向一：补发线程先回写原任务，之后「再次生成」接回的任务不记；
- 方向二：「再次生成」先接回成功并记了，补发线程之后回写原任务时不记；
- 并发：两边几乎同时，用量页对这把幂等键的合计等于主机 charged_cny，不多不少。
主机是真实回环网关（tests.test_gateway_client），按次估价打桩为 0.5 元；补发线程在本线程同步跑一轮（不起线程）。
"""
from __future__ import annotations

import threading
from datetime import datetime, timezone

import pytest

from character_workflow.lib import gateway_cancel_outbox, gateway_tasks, job_runner
from character_workflow.lib.jobs import read_job, save_job
from character_workflow.lib.schemas import JobStatus
from character_workflow.lib.usage_stats import mine_records
from tests import test_gateway_client as _member
from tests import test_gateway_reattach as _reattach
from tests.test_gateway_cancel_delivery import _key

gateway = _member.gateway
upstream = _member.upstream
faults = _reattach.faults
_fast = _member._fast

CHARGED = 0.5


@pytest.fixture
def priced(monkeypatch):
    monkeypatch.setattr(gateway_tasks, "_estimate", lambda *_args, **_kwargs: CHARGED)
    monkeypatch.setattr(gateway_cancel_outbox, "wake", lambda: None)  # 同步跑 deliver_once，不起线程


def _stop_after_upstream(job_id, monkeypatch):
    """主机已发上游时成员停止：本机立即停、主机跑完并按 0.5 元扣费。"""
    release = threading.Event()
    fast_render = _member.openai_image.render

    def slow_render(**kwargs):
        release.wait(10)
        return fast_render(**kwargs)

    monkeypatch.setattr(_member.openai_image, "render", slow_render)

    def should_cancel():
        tasks = gateway_tasks._all_tasks()
        return bool(tasks and tasks[0].sent_at)

    job = _reattach._now_job(job_id)
    with pytest.raises(job_runner.JobCanceled):
        job_runner.run_job(job.job_id, should_cancel=should_cancel)
    stopped = read_job(job_id)
    assert stopped.status == JobStatus.CANCELED and stopped.params.gateway_settlement == "pending"
    monkeypatch.setattr(_member.openai_image, "render", fast_render)
    release.set()
    [host_task] = _reattach._host_settled()
    assert host_task.status == "done" and host_task.charged_cny == CHARGED
    return stopped


def _usage_total(*job_ids):
    jobs = [read_job(job_id) for job_id in job_ids]
    return sum(row["cost_cny"] or 0 for row in mine_records(jobs, {}))


def test_stopped_job_settles_first_and_the_later_regenerate_records_nothing(gateway, upstream, faults,
                                                                             priced, monkeypatch):
    stopped = _stop_after_upstream("job-a", monkeypatch)
    assert gateway_cancel_outbox.deliver_once() is False
    settled = read_job("job-a")
    assert settled.params.actual_cost_cny == CHARGED and settled.params.gateway_settlement == "settled"
    assert settled.error.endswith(f"（已扣 ¥{CHARGED:g}）")
    assert settled.params.gateway_unconfirmed is True  # 出图成功：再次生成仍可接回取图

    again = _reattach._regenerate(stopped, "job-a2")
    assert again.status == JobStatus.DONE and again.params.gateway_reattach_of == "job-a"
    assert again.params.actual_cost_cny is None and again.params.gateway_charged_on == "job-a"
    assert _usage_total("job-a", "job-a2") == CHARGED


def test_regenerate_records_first_and_the_later_settlement_records_nothing(gateway, upstream, faults,
                                                                          priced, monkeypatch):
    stopped = _stop_after_upstream("job-b", monkeypatch)
    again = _reattach._regenerate(stopped, "job-b2")
    assert again.status == JobStatus.DONE and again.params.actual_cost_cny == CHARGED
    assert again.params.gateway_charged_on is None

    assert gateway_cancel_outbox.deliver_once() is False
    settled = read_job("job-b")
    assert settled.params.actual_cost_cny is None and settled.params.gateway_charged_on == "job-b2"
    assert settled.params.gateway_settlement == "settled"
    assert "费用记在再次生成的任务上" in settled.error
    assert _usage_total("job-b", "job-b2") == CHARGED


def _pair(index):
    """同一把幂等键的两条成员任务：原「已停止」那条（待结算）与再次生成接回的那条。"""
    key = _key(fill=format(index % 16, "x"))[:-4] + f"{index:04d}"
    common = dict(gateway_idempotency_key=key, gateway_unconfirmed=True,
                  provider_task_protocol="atelier_gateway")
    stopped = _reattach._now_job(f"job-c{index}", gateway_settlement="pending", **common)
    save_job(read_job(stopped.job_id).model_copy(update={
        "status": JobStatus.CANCELED, "error": job_runner.GATEWAY_CANCEL_CONTINUING}))
    again = _reattach._now_job(f"job-c{index}r", gateway_reattach_of=stopped.job_id, **common)
    save_job(read_job(again.job_id).model_copy(update={
        "status": JobStatus.DONE, "completed_at": datetime.now(timezone.utc).isoformat()}))
    return stopped.job_id, again.job_id


def test_concurrent_settlement_and_reattach_charge_exactly_once(isolated_data_root):
    body = {"cancel_outcome": "finished", "status": "done", "charged_cny": CHARGED}
    for index in range(30):
        stopped_id, again_id = _pair(index)
        params = read_job(again_id).params.model_dump(exclude_none=True)
        record = job_runner._actual_cost_recorder(again_id, params)
        barrier = threading.Barrier(2)
        errors = []

        def settle(sid=stopped_id):
            try:
                barrier.wait(5)
                gateway_cancel_outbox._apply(sid, body)
            except Exception as error:  # noqa: BLE001 — 记下来在主线程断言
                errors.append(error)

        def reattach():
            try:
                barrier.wait(5)
                record(CHARGED / job_runner.USD_TO_CNY)
            except Exception as error:  # noqa: BLE001
                errors.append(error)

        threads = [threading.Thread(target=settle), threading.Thread(target=reattach)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
        assert errors == []
        stopped, again = read_job(stopped_id), read_job(again_id)
        charged = [job for job in (stopped, again) if job.params.actual_cost_cny]
        assert len(charged) == 1 and charged[0].params.actual_cost_cny == pytest.approx(CHARGED)
        other = again if charged[0] is stopped else stopped
        assert other.params.gateway_charged_on == charged[0].job_id
        assert _usage_total(stopped_id, again_id) == pytest.approx(CHARGED)


@pytest.mark.parametrize(("body", "error", "cost", "unconfirmed"), [
    ({"cancel_outcome": "finished", "status": "failed", "charged_cny": 0}, "已停止", None, None),
    ({"cancel_outcome": "finished", "status": "failed", "charged_cny": 0.3}, "已停止（已扣 ¥0.3）", 0.3, None),
    ({"cancel_outcome": "finished", "status": "done", "charged_cny": 0},
     job_runner.GATEWAY_CANCEL_CONTINUING, None, True),
])
def test_host_terminal_states_settle_with_or_without_a_charge(isolated_data_root, body, error, cost,
                                                              unconfirmed):
    stopped_id, _again = _pair(90)
    gateway_cancel_outbox._apply(stopped_id, body)
    settled = read_job(stopped_id)
    assert settled.error == error and settled.params.actual_cost_cny == cost
    assert settled.params.gateway_settlement == "settled"
    assert settled.params.gateway_unconfirmed is unconfirmed
    # 已停止的任务只有回写了扣费才计入用量。
    assert _usage_total(stopped_id) == (cost or 0)
    assert [row["id"] for row in mine_records([settled], {})] == ([stopped_id] if cost else [])


def test_host_still_running_keeps_waiting_and_the_outbox_keeps_asking(isolated_data_root):
    stopped_id, _again = _pair(91)
    gateway_cancel_outbox._apply(stopped_id, {"cancel_outcome": "continuing", "status": "running"})
    waiting = read_job(stopped_id)
    assert waiting.params.gateway_settlement == "pending" and waiting.params.actual_cost_cny is None
    assert waiting.error == job_runner.GATEWAY_CANCEL_CONTINUING
    assert stopped_id in gateway_cancel_outbox.pending_job_ids()


def test_settlement_stops_asking_after_the_key_expires(isolated_data_root):
    stopped = _reattach._now_job("job-old", gateway_idempotency_key=_key(seconds_ago=21 * 3600),
                                 gateway_settlement="pending")
    save_job(read_job(stopped.job_id).model_copy(update={"status": JobStatus.CANCELED}))
    assert gateway_cancel_outbox.pending_job_ids() == []
