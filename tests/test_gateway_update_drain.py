"""第 4 批 4-3：应用内更新排空只等「执行中且重启后不能续查」的网关任务；更新期间不启动排队任务。

全部本机：网关任务直接落盘构造，不执行上游（`_execute` 换成记录器）。
"""
from __future__ import annotations

import threading

import pytest

from character_workflow.lib import gateway_keys, gateway_quota, gateway_tasks, keys, model_routes


@pytest.fixture(autouse=True)
def isolated(isolated_data_root, monkeypatch):
    model_routes._cooldowns.clear()
    gateway_quota._inflight.clear()
    gateway_tasks._running.clear()
    started = []
    ran = threading.Event()

    def execute(task_id):
        started.append(task_id)
        ran.set()
        with gateway_tasks._lock:
            gateway_tasks._running.pop(task_id, None)

    monkeypatch.setattr(gateway_tasks, "_execute", execute)
    yield {"started": started, "ran": ran}
    gateway_tasks._running.clear()
    _set_updating(False)


def _set_updating(on: bool) -> None:
    from viewer_server.update_routes import admission

    gate = admission()
    with gate.lock:
        gate.maintenance = on


def _owner():
    keys.add_key(keys.KeySpec(alias="Local", provider="openai", access_key="fake-test-secret",
                              base_url="https://api.example/v1", created_at="test",
                              models=[keys.ModelSpec(id="gpt-image-2", name="gpt-image-2",
                                                     modality="image")]))
    return gateway_keys.create_key("小王")[0]


def _task(owner, key, **changes):
    task = gateway_tasks.submit(owner, idempotency_key=key, model="gpt-image-2", prompt="猫", n=1,
                                size=None, params={}, files={}, kind="image")
    return gateway_tasks._update(task.task_id, **changes) if changes else task


def _tasks(isolated):
    """排队 1、执行中不可续查 1、执行中可续查 1、已结束 1。"""
    _set_updating(True)  # 构造期间不让 pump 把排队任务启动
    owner = _owner()
    queued = _task(owner, "q")
    plain = _task(owner, "p", status="running")
    resumable = _task(owner, "r", status="running", resume_params={
        "provider_task_protocol": "tuzi_images", "provider_task_ids": ["tuzi-1"]})
    _task(owner, "d", status="done")
    _set_updating(False)
    return queued, plain, resumable


def test_update_drain_only_waits_for_running_tasks_that_cannot_resume(isolated):
    from viewer_server.update_routes import active_work

    _queued, plain, resumable = _tasks(isolated)
    assert gateway_tasks.resumable(gateway_tasks._read(resumable.task_id))
    assert not gateway_tasks.resumable(gateway_tasks._read(plain.task_id))
    assert active_work()["gateway"] == 1


def test_desktop_shell_still_counts_every_unfinished_gateway_task(isolated):
    """外壳退出后服务不会自动起来：排队中、能续查的也算（与更新排空不同）。"""
    from viewer_server.shell_control import shell_active_work

    _tasks(isolated)
    assert shell_active_work()["gateway"] == 3


def test_queued_tasks_do_not_start_while_the_host_updates(isolated):
    owner = _owner()
    _set_updating(True)
    queued = _task(owner, "q")
    gateway_tasks.pump()
    assert isolated["started"] == [] and gateway_tasks._read(queued.task_id).status == "pending"

    _set_updating(False)
    gateway_tasks.pump()
    assert isolated["started"] == [queued.task_id]


def test_cancelled_update_resumes_the_queue(isolated, tmp_path):
    """更新取消或失败、留在原进程时：排队任务接着调度。"""
    from viewer_server.server_app import build_app

    controller = build_app(dist_dir=tmp_path / "web").state.update_controller
    owner = _owner()
    _set_updating(True)
    queued = _task(owner, "q")
    controller.update_id = "u1"
    controller.finish("cancelled")
    assert isolated["ran"].wait(5)
    assert isolated["started"] == [queued.task_id]
