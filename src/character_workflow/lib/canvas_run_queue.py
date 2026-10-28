"""画布任务调度：每把 KEY、每个画布项目各最多 6 个同时执行，其余按提交顺序排队。

排队的任务不占线程：两边都有名额才起执行线程，执行完释放名额并启动下一个可执行的任务。
被名额卡住的任务不挡后面其他 KEY / 项目的任务。

原先每个任务先占一个 Web 线程池的线程，再阻塞在信号量上等名额；排队一多就占满线程池，
整个页面的接口一起卡住。
"""
from __future__ import annotations

import threading
from collections import Counter
from concurrent.futures import Future
from dataclasses import dataclass, field

from character_workflow.lib import canvas_runs
from character_workflow.lib.jobs import Job

MAX_RUNNING_PER_KEY = 6
MAX_RUNNING_PER_PROJECT = 6


@dataclass
class _Entry:
    job_id: str
    alias: str
    project_id: str
    future: Future[Job] = field(default_factory=Future)


_lock = threading.Lock()
_waiting: list[_Entry] = []
_running_keys: Counter[str] = Counter()
_running_projects: Counter[str] = Counter()


def submit(job_id: str) -> Future[Job]:
    """排进队列并立即返回；Future 在任务执行完时给出 run_canvas_job 的结果或异常。"""
    job = canvas_runs.read_job(job_id)
    entry = _Entry(job_id, job.alias or job.character_id, job.canvas_project_id)
    with _lock:
        _waiting.append(entry)
        _pump_locked()
    return entry.future


def _pump_locked() -> None:
    still_waiting: list[_Entry] = []
    for entry in _waiting:
        if (_running_keys[entry.alias] >= MAX_RUNNING_PER_KEY
                or _running_projects[entry.project_id] >= MAX_RUNNING_PER_PROJECT):
            still_waiting.append(entry)
            continue
        _running_keys[entry.alias] += 1
        _running_projects[entry.project_id] += 1
        threading.Thread(target=_execute, args=(entry,), daemon=True,
                         name=f"canvas-run-{entry.job_id[:8]}").start()
    _waiting[:] = still_waiting


def _execute(entry: _Entry) -> None:
    try:
        entry.future.set_result(canvas_runs.run_canvas_job(entry.job_id))
    except BaseException as error:  # noqa: BLE001 — 交给等待方处理
        entry.future.set_exception(error)
    finally:
        with _lock:
            _running_keys[entry.alias] -= 1
            _running_projects[entry.project_id] -= 1
            _pump_locked()
