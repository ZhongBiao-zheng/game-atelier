"""锁外读取被持锁原子替换的文件（批次 1b）。

Windows 上，写入方 os.replace 的那一刻，锁外打开同一文件会 PermissionError(13)。POSIX 碰不到这一刻，
所以这里用 atomic_io 的重试开关 + 打桩 Path.read_text 在任何平台上模拟它：
- 行为测试：前两次打开抛 PermissionError，读取方应重试成功，调用方拿到正常结果；
- 接线测试（后果轻的读取点）：断言读取经过 read_text_with_retry。
另有真实并发的压力用例（Windows CI 循环跑）与监听线程、后台循环的存活测试。
"""
from __future__ import annotations

import asyncio
import importlib
import threading
import time
from pathlib import Path

import pytest

from character_workflow.lib import atomic_io
from character_workflow.lib.jobs import save_job
from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus

ORIGIN = "http://127.0.0.1:5174"


def _job(job_id: str = "job-20261118000000abcd1234", status=JobStatus.PENDING) -> Job:
    return save_job(Job(
        job_id=job_id, character_id="studio", prompt="fox", submitted_at="2026-11-18T00:00:00+00:00",
        model="gpt-image-2", params=JobParams(size="1024x1024", n=1), output_paths=[],
        status=status, error=None, kind=JobKind.IMAGE, namespace="studio",
    ))


@pytest.fixture
def replacing(monkeypatch):
    """让指定文件的前 n 次打开撞上「正在被替换」。返回 arm(path, n)。"""
    monkeypatch.setattr(atomic_io, "_RETRY_PERMISSION_ERRORS", True)
    monkeypatch.setattr(atomic_io.time, "sleep", lambda _s: None)
    pending: dict[Path, list[type[OSError]]] = {}
    real_read = Path.read_text

    def flaky(self, *args, **kwargs):
        queue = pending.get(Path(self))
        if queue:
            error = queue.pop(0)
            raise error(13 if error is PermissionError else 2, "simulated replace")
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", flaky)

    def arm(path: Path, times: int = 2, error: type[OSError] = PermissionError) -> None:
        pending[Path(path)] = [error] * times

    return arm


# ---- 后果重的读取点：行为测试 ----

def test_read_job_retries_through_a_replace(isolated_data_root, replacing):
    from character_workflow.lib import jobs

    job = _job()
    replacing(jobs._path(job.job_id))
    assert jobs.read_job(job.job_id).job_id == job.job_id


def test_read_job_rides_out_the_moment_the_name_is_missing(isolated_data_root, replacing):
    # Windows CI 实测：替换进行中，目标名会短暂查不到。
    from character_workflow.lib import jobs

    job = _job()
    replacing(jobs._path(job.job_id), error=FileNotFoundError)
    assert jobs.read_job(job.job_id).job_id == job.job_id


def test_jobs_watcher_rides_out_the_moment_the_name_is_missing(isolated_data_root, replacing, monkeypatch):
    from character_workflow.lib import jobs
    from viewer_server import watcher

    sent: list[dict] = []
    monkeypatch.setattr(watcher.hub, "broadcast", lambda event, data: sent.append(data))
    job = _job()
    replacing(jobs._path(job.job_id), error=FileNotFoundError)
    watcher.JobsHandler()._emit(str(jobs._path(job.job_id)), False)
    assert sent == [{"job_id": job.job_id, "status": "pending"}]


def test_a_truly_missing_file_costs_only_one_short_second_look(tmp_path, monkeypatch):
    monkeypatch.setattr(atomic_io, "_RETRY_PERMISSION_ERRORS", True)
    slept: list[float] = []
    monkeypatch.setattr(atomic_io.time, "sleep", slept.append)
    with pytest.raises(FileNotFoundError):
        atomic_io.read_text_with_retry(tmp_path / "absent.json")
    assert slept == [atomic_io._MISSING_CONFIRM_DELAY]


def test_the_instant_both_names_are_absent_is_ridden_out(tmp_path, monkeypatch):
    """Windows CI 实测（run 44263665760）：改名瞬间临时文件和目标名都看不到，第二眼才出现。"""
    monkeypatch.setattr(atomic_io, "_RETRY_PERMISSION_ERRORS", True)
    target = tmp_path / "job-1.json"

    def sleep(_seconds):
        target.write_text('{"ok": true}', encoding="utf-8")  # 第二眼之前改名完成

    monkeypatch.setattr(atomic_io.time, "sleep", sleep)
    real_read = Path.read_text
    calls = {"n": 0}

    def vanishing(self, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise FileNotFoundError(2, "simulated rename instant")
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", vanishing)
    assert atomic_io.read_text_with_retry(target) == '{"ok": true}'


def test_a_missing_name_is_retried_only_while_a_replace_is_in_flight(tmp_path, monkeypatch):
    """Windows CI 实测：替换进行中目录里只剩 `<stem>.<hex>.tmp`，目标名消失 2–230 ms。"""
    monkeypatch.setattr(atomic_io, "_RETRY_PERMISSION_ERRORS", True)
    monkeypatch.setattr(atomic_io.time, "sleep", lambda _s: None)
    target = tmp_path / "job-1.json"
    staged = tmp_path / "job-1.0123abcd.tmp"
    staged.write_text("{}", encoding="utf-8")
    calls = {"n": 0}
    real_read = Path.read_text

    def vanishing(self, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] <= 3:
            raise FileNotFoundError(2, "simulated replace")
        target.write_text('{"ok": true}', encoding="utf-8")
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", vanishing)
    assert atomic_io.read_text_with_retry(target) == '{"ok": true}'
    assert calls["n"] == 4


def test_runner_cancel_check_does_not_fail_the_job_during_a_replace(isolated_data_root, replacing):
    from character_workflow.lib import job_runner, jobs

    job = _job()
    replacing(jobs._path(job.job_id))
    assert job_runner._cancel_checker(job)() is False


def test_job_list_keeps_a_job_that_is_being_replaced(isolated_data_root, replacing):
    from character_workflow.lib import jobs

    job = _job()
    replacing(jobs._path(job.job_id))
    assert [item.job_id for item in jobs.list_jobs()] == [job.job_id]


def test_job_endpoints_answer_during_a_replace(isolated_data_root, replacing, tmp_path):
    from character_workflow.lib import jobs
    from tests.local_client import LocalTestClient
    from viewer_server.server_app import build_app

    job = _job()
    local = LocalTestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN)
    replacing(jobs._path(job.job_id))
    assert local.get(f"/api/jobs/{job.job_id}").status_code == 200
    replacing(jobs._path(job.job_id))
    assert [item["job_id"] for item in local.get("/api/jobs").json()] == [job.job_id]


def test_jobs_watcher_still_broadcasts_during_a_replace(isolated_data_root, replacing, monkeypatch):
    from character_workflow.lib import jobs
    from viewer_server import watcher

    sent: list[dict] = []
    monkeypatch.setattr(watcher.hub, "broadcast", lambda event, data: sent.append(data))
    job = _job()
    replacing(jobs._path(job.job_id))
    watcher.JobsHandler()._emit(str(jobs._path(job.job_id)), False)
    assert sent == [{"job_id": job.job_id, "status": "pending"}]


def test_canvas_project_read_retries_through_a_replace(isolated_data_root, replacing):
    from character_workflow.lib import canvas_projects

    project = canvas_projects.create_canvas_project("p")
    replacing(canvas_projects._project_path(project.project_id))
    assert canvas_projects.read_canvas_project(project.project_id).project_id == project.project_id


def test_canvas_document_watcher_does_not_drop_the_event(isolated_data_root, replacing, monkeypatch):
    from character_workflow.lib import canvas_projects
    from viewer_server import watcher

    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(watcher.hub, "broadcast", lambda event, data: sent.append((event, data)))
    project = canvas_projects.create_canvas_project("p")
    document = canvas_projects.canvas_project_dir(project.project_id) / "canvas.json"
    replacing(document)
    watcher.CanvasDocumentsHandler()._emit(str(document), False)
    assert sent


# ---- 后果轻的读取点：经过带重试的读取 ----

def _call(module_name: str, attr: str, *args):
    return lambda: getattr(importlib.import_module(module_name), attr)(*args)


_LIB = "character_workflow.lib."
_PROJECT: dict[str, str] = {}


def _grants_file() -> Path:
    from character_workflow.lib import plugin_grants
    from character_workflow.lib.canvas_projects import create_canvas_project

    _PROJECT["id"] = create_canvas_project("p").project_id
    return plugin_grants._grants_path(_PROJECT["id"])
_LIGHT = {
    "routes._read_config": ("viewer_server.routes", lambda dr: dr.runtime_dir() / "config.json",
                            _call("viewer_server.routes", "_read_config")),
    "gallery-hidden": ("viewer_server.routes", lambda dr: dr.runtime_dir() / "gallery-hidden.json",
                       _call("viewer_server.routes", "_read_gallery_hidden_state")),
    "gallery-favorites": ("viewer_server.routes", lambda dr: dr.runtime_dir() / "gallery-favorites.json",
                          _call("viewer_server.routes", "_read_gallery_favorites")),
    "gallery-ratings": ("viewer_server.routes", lambda dr: dr.runtime_dir() / "gallery-ratings.json",
                        _call("viewer_server.routes", "_read_gallery_ratings")),
    "jobs.last_used_by_alias": (_LIB + "jobs", lambda dr: dr.runtime_dir() / "jobs" / "job-x.json",
                                _call(_LIB + "jobs", "last_used_by_alias")),
    "canvas_ui": (_LIB + "canvas_ui", lambda dr: dr.canvas_ui_file(),
                  _call(_LIB + "canvas_ui", "read_canvas_ui_preferences")),
    "plugin_grants": (_LIB + "plugin_grants", lambda dr: _grants_file(),
                      lambda: importlib.import_module(_LIB + "plugin_grants")._read_unlocked(_PROJECT["id"])),
    "team_library_index": (_LIB + "team_library_index",
                           lambda dr: importlib.import_module(_LIB + "team_library_index")._index_path("lib_" + "1" * 16),
                           _call(_LIB + "team_library_index", "read_index", "lib_" + "1" * 16)),
    "model_routes.member_statuses": (_LIB + "model_routes",
                                     lambda dr: importlib.import_module(_LIB + "model_routes")._status_file(),
                                     _call(_LIB + "model_routes", "member_statuses")),
    "tuzi_prices": (_LIB + "tuzi_prices", lambda dr: importlib.import_module(_LIB + "tuzi_prices").snapshot_path(),
                    _call(_LIB + "tuzi_prices", "load_snapshot")),
    "openai_hk_prices": (_LIB + "openai_hk_prices",
                         lambda dr: importlib.import_module(_LIB + "openai_hk_prices").snapshot_path(),
                         _call(_LIB + "openai_hk_prices", "load_snapshot")),
    "tokendance_prices": (_LIB + "tokendance_prices",
                          lambda dr: importlib.import_module(_LIB + "tokendance_prices").snapshot_path(),
                          _call(_LIB + "tokendance_prices", "load_snapshot")),
    "bundle_download": ("viewer_server.bundle_download", lambda dr: dr.runtime_dir() / "state.json",
                        lambda: importlib.import_module("viewer_server.bundle_download")._read_json(
                            importlib.import_module(_LIB + "data_root").runtime_dir() / "state.json")),
}


@pytest.mark.parametrize("name", sorted(_LIGHT))
def test_light_readers_go_through_the_retrying_read(isolated_data_root, monkeypatch, name):
    from character_workflow.lib import data_root

    module_name, target, call = _LIGHT[name]
    module = importlib.import_module(module_name)
    path = target(data_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}", encoding="utf-8")
    seen: list[Path] = []
    real = module.read_text_with_retry

    def spy(file, *args, **kwargs):
        seen.append(Path(file))
        return real(file, *args, **kwargs)

    monkeypatch.setattr(module, "read_text_with_retry", spy)
    try:
        call()
    except Exception:  # noqa: BLE001 —— 内容不合规时有的读取方会报损坏；这里只关心读取走了哪条路
        pass
    assert Path(path) in seen


# ---- 读→改→写持锁 ----

@pytest.mark.parametrize("kind", ["hidden", "favorites", "ratings", "config"])
def test_settings_read_modify_write_holds_its_lock(isolated_data_root, monkeypatch, tmp_path, kind):
    from character_workflow.lib.file_lock import try_file_lock
    from tests.local_client import LocalTestClient
    from viewer_server import routes
    from viewer_server.server_app import build_app

    files = {"hidden": routes._gallery_hidden_file(), "favorites": routes._gallery_favorites_file(),
             "ratings": routes._gallery_ratings_file(), "config": routes._runtime() / "config.json"}
    readers = {"hidden": "_read_gallery_hidden_state", "favorites": "_read_gallery_favorites",
               "ratings": "_read_gallery_ratings", "config": "_read_config"}
    held: list[bool] = []
    real = getattr(routes, readers[kind])

    def probe():
        def check():
            with try_file_lock(files[kind].with_suffix(".lock")) as acquired:
                held.append(not acquired)
        thread = threading.Thread(target=check)
        thread.start()
        thread.join()
        return real()

    monkeypatch.setattr(routes, readers[kind], probe)
    local = LocalTestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN)
    image = str(isolated_data_root / "a.png")
    body = {"hidden": {"path": image, "hidden": True}, "favorites": {"path": image, "favorite": True},
            "ratings": {"path": image, "rating": 3}, "config": {"show_canvas_on_home": False}}[kind]
    url = "/api/config" if kind == "config" else f"/api/gallery/{kind}"
    assert local.post(url, json=body).status_code == 200
    assert held and held[0] is True


# ---- 监听线程与后台循环 ----

def test_one_failing_event_does_not_stop_the_watchdog_dispatcher(tmp_path):
    from watchdog.observers import Observer

    from viewer_server.watcher import GuardedHandler

    seen: list[str] = []
    gate = threading.Event()

    class Flaky(GuardedHandler):
        def on_any_event(self, event):
            name = Path(event.src_path).name
            if event.is_directory or not name.endswith(".txt"):
                return
            seen.append(name)
            if name == "boom.txt":
                raise PermissionError(13, "Permission denied")
            if name == "after.txt":
                gate.set()

    observer = Observer()
    observer.schedule(Flaky(), str(tmp_path), recursive=False)
    observer.start()
    try:
        time.sleep(0.3)
        (tmp_path / "boom.txt").write_text("x", encoding="utf-8")
        time.sleep(0.5)
        (tmp_path / "after.txt").write_text("y", encoding="utf-8")
        assert gate.wait(10), f"监听线程在一次异常后停了，只收到 {seen}"
    finally:
        observer.stop()
        observer.join(5)


def _run_until(coro_factory, done, limit=500):
    async def run():
        task = asyncio.create_task(coro_factory())
        for _ in range(limit):
            await asyncio.sleep(0.005)
            if done():
                break
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run())


def test_periodic_maintenance_survives_a_failing_round():
    from viewer_server import server_app

    calls: list[int] = []

    def work():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("boom")

    _run_until(lambda: server_app._repeat_forever(0, work, "测试维护"), lambda: len(calls) >= 3)
    assert len(calls) >= 3


def test_share_sync_loop_survives_a_failing_round(monkeypatch):
    from character_workflow.lib import gateway_share_publisher as publisher

    calls: list[int] = []

    def schedule_all():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("boom")

    real_sleep = asyncio.sleep

    async def fast_sleep(seconds):
        await real_sleep(0 if seconds >= 1 else seconds)

    monkeypatch.setattr(publisher, "schedule_all", schedule_all)
    monkeypatch.setattr(publisher.asyncio, "sleep", fast_sleep)
    _run_until(publisher.run_periodic, lambda: len(calls) >= 3)
    assert len(calls) >= 3


def test_host_heartbeat_keeps_beating_after_errors(monkeypatch):
    from types import SimpleNamespace

    from character_workflow.lib import host_lifecycle
    from viewer_server import server_app

    beats: list[int] = []

    def record_start(**_kwargs):
        raise RuntimeError("disk gone")

    def heartbeat():
        beats.append(1)
        if len(beats) == 1:
            raise RuntimeError("once")

    monkeypatch.setattr(host_lifecycle, "record_start", record_start)
    monkeypatch.setattr(host_lifecycle, "heartbeat", heartbeat)
    monkeypatch.setattr(host_lifecycle, "HEARTBEAT_SECONDS", 0)
    app = SimpleNamespace(state=SimpleNamespace(connection_status=SimpleNamespace(instance_id="i")))
    _run_until(lambda: server_app._record_host_lifecycle(app), lambda: len(beats) >= 3)
    assert len(beats) >= 3


# ---- 取锁顺序 ----

def test_opposite_lock_orders_do_not_wait_on_each_other(isolated_data_root):
    """A 走 update_canvas_categories 的顺序（项目锁 → 目录锁），B 走旧画布库迁移（目录锁 → 项目锁）。

    修复前：B 持目录锁等项目锁，A 持项目锁等目录锁，互等。A 用非阻塞轮询取目录锁（最多 5 秒），
    所以修复前这条用例是超时失败、不会卡死；A 放掉项目锁后 B 也能走完。
    """
    from character_workflow.lib import project_reference_assets as creation_assets
    from character_workflow.lib.canvas_projects import canvas_project_lock_path, create_canvas_project
    from character_workflow.lib.file_lock import file_lock, try_file_lock

    project = create_canvas_project("p")
    a_has_project, a_got_catalog, b_done = threading.Event(), threading.Event(), threading.Event()

    def a_project_then_catalog():
        with file_lock(canvas_project_lock_path(project.project_id)):
            a_has_project.set()
            time.sleep(0.3)  # 让 B 先进到「持目录锁」
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                with try_file_lock(creation_assets._catalog_lock_path()) as acquired:
                    if acquired:
                        a_got_catalog.set()
                        return
                time.sleep(0.02)

    def b_catalog_then_project():
        creation_assets.migrate_legacy_canvas_libraries()
        b_done.set()

    first = threading.Thread(target=a_project_then_catalog)
    first.start()
    assert a_has_project.wait(5)
    second = threading.Thread(target=b_catalog_then_project)
    second.start()
    first.join(10)
    second.join(10)
    assert a_got_catalog.is_set(), "两条路径按相反顺序取锁，互相等待"
    assert b_done.is_set()
    # B 这一轮跳过了被占用的项目，下一次资产库读写补上。
    assert project.project_id not in creation_assets._read_catalog_unlocked().migrated_canvas_project_ids
    creation_assets.list_creation_assets()
    assert project.project_id in creation_assets._read_catalog_unlocked().migrated_canvas_project_ids


# ---- 真实并发（Windows CI 循环跑） ----

def test_concurrent_job_rewrites_never_break_unlocked_readers(isolated_data_root):
    from character_workflow.lib import jobs

    job = _job()
    errors: list[str] = []
    stop = threading.Event()

    import traceback

    def writer():
        try:
            for index in range(150):
                jobs.update_job_phase(job.job_id, f"queued:{index + 1}")
        except BaseException as error:  # noqa: BLE001
            errors.append("writer: " + "".join(traceback.format_exception(error)))
        finally:
            stop.set()

    def reader():
        # 读取之间让 1 ms：真实的读取方是轮询 / 文件事件，不会无间隔地一直占着文件。
        while not stop.is_set():
            try:
                jobs.read_job(job.job_id)
            except BaseException as error:  # noqa: BLE001
                errors.append("reader: " + "".join(traceback.format_exception(error)))
                return
            time.sleep(0.001)

    threads = [threading.Thread(target=writer), *(threading.Thread(target=reader) for _ in range(3))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60)
    assert not errors, "\n".join(errors)


def test_jobs_watcher_survives_concurrent_rewrites(isolated_data_root, monkeypatch):
    from watchdog.observers import Observer

    from character_workflow.lib import jobs
    from viewer_server import watcher

    seen: list[str] = []
    monkeypatch.setattr(watcher.hub, "broadcast", lambda event, data: seen.append(data.get("status")))
    job = _job()
    observer = Observer()
    observer.schedule(watcher.JobsHandler(), str(jobs._path(job.job_id).parent), recursive=False)
    observer.start()
    try:
        time.sleep(0.3)
        for index in range(150):
            jobs.update_job_phase(job.job_id, f"queued:{index + 1}")
        jobs.update_job_status(job.job_id, status=JobStatus.FAILED, error="done")
        deadline = time.monotonic() + 10
        while "failed" not in seen and time.monotonic() < deadline:
            time.sleep(0.05)
        assert "failed" in seen, "大量替换之后监听不再推送：分发线程可能已因一次读取失败退出"
    finally:
        observer.stop()
        observer.join(5)
