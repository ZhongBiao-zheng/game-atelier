"""watcher handlers — 原子写（tmp.replace）在 Linux/inotify 上发 moved 事件；
mac FSEvents 合并成 modified，开发机测不出，必须用单元事件回归。"""
import json
from pathlib import Path

import pytest
from watchdog.events import FileCreatedEvent, FileMovedEvent

from tests.test_team_library_index import scan_and_cache
from viewer_server import watcher


def _capture(monkeypatch):
    events = []
    monkeypatch.setattr(
        watcher.hub, "broadcast", lambda event, data: events.append((event, data))
    )
    return events


def test_jobs_handler_on_moved_broadcasts(tmp_path, monkeypatch):
    events = _capture(monkeypatch)
    dest = tmp_path / "j1.json"
    dest.write_text(json.dumps({"job_id": "j1", "status": "done"}))
    watcher.JobsHandler().on_moved(
        FileMovedEvent(str(tmp_path / "j1.json.tmp"), str(dest))
    )
    assert events == [("job-changed", {"job_id": "j1", "status": "done"})]


def test_canvas_documents_handler_broadcasts_project_and_revision(tmp_path, monkeypatch):
    """Agent 经 MCP 改画布只落 canvas.json，浏览器要靠这条事件才看得到（#92）。"""
    events = _capture(monkeypatch)
    project = tmp_path / "cp-abc123"
    project.mkdir()
    dest = project / "canvas.json"
    dest.write_text(json.dumps({"revision": 7, "nodes": []}))
    handler = watcher.CanvasDocumentsHandler()
    handler.on_moved(FileMovedEvent(str(project / "canvas.json.tmp"), str(dest)))
    handler.on_created(FileCreatedEvent(str(project / "upload.png")))
    assert events == [("canvas-document-changed", {"project_id": "cp-abc123", "revision": 7})]


def test_active_character_handler_on_moved_and_created(tmp_path, monkeypatch):
    events = _capture(monkeypatch)
    dest = tmp_path / "active-character.json"
    dest.write_text(json.dumps({"active_id": "c7"}))
    h = watcher.ActiveCharacterHandler()
    h.on_moved(FileMovedEvent(str(tmp_path / "active-character.json.tmp"), str(dest)))
    h.on_created(FileCreatedEvent(str(dest)))
    assert events == [
        ("active-character-changed", {"active_id": "c7"}),
        ("active-character-changed", {"active_id": "c7"}),
    ]


def test_start_watchers_creates_missing_characters_dir(isolated_data_root):
    # 全新安装：characters/ 尚不存在 → 必须先建好再 schedule，否则首个角色的
    # spec-changed 永远不广播，直到重启。
    chars = isolated_data_root / "characters"
    chars.rmdir()
    obs = watcher.start_watchers()
    try:
        assert chars.exists()
    finally:
        obs.stop()
        obs.join(timeout=5)


def test_team_library_handler_rescans_and_broadcasts_diff(isolated_data_root, tmp_path, monkeypatch):
    from character_workflow.lib import team_library as tl

    events = _capture(monkeypatch)
    folder = tmp_path / "lib"
    folder.mkdir()
    mount = tl.mount_library(project_id="p1", path=str(folder), name=None, created_by="我")
    handler = watcher.TeamLibraryHandler(mount, delay=0)
    handler.rescan()  # 首扫：空
    (folder / "a.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
    handler.rescan()
    assert events[-1][0] == "team-library-changed"
    assert events[-1][1]["change"] == "added" and events[-1][1]["kind"] == "raw"
    assert events[-1][1]["library_id"] == mount.library_id


def test_team_library_handler_ignores_hidden_paths(isolated_data_root, tmp_path, monkeypatch):
    """.svn / .git 里的写入不该触发重扫——活工作副本每次 update 都会改它们。"""
    from character_workflow.lib import team_library as tl

    _capture(monkeypatch)
    folder = tmp_path / "lib"
    (folder / ".svn" / "tmp").mkdir(parents=True)
    mount = tl.mount_library(project_id="p1", path=str(folder), name=None, created_by="我")
    handler = watcher.TeamLibraryHandler(mount, delay=0)
    rescans: list[int] = []
    monkeypatch.setattr(handler, "rescan", lambda: rescans.append(1))
    handler.on_any_event(FileCreatedEvent(str(folder / ".svn" / "tmp" / "entries")))
    assert handler._timer is None and rescans == []
    handler.on_any_event(FileCreatedEvent(str(folder / "a.png")))
    handler._timer.join(5)
    assert rescans == [1]


def test_team_library_handler_keeps_index_when_directory_goes_offline(
    isolated_data_root, tmp_path, monkeypatch
):
    """目录掉线不是「库空了」：build_index 对不存在的目录只会返回空索引，不抛 OSError。

    照扫就会清空缓存并广播一整轮 removed —— 网盘抖一下，画师的库在界面上就全没了。
    """
    import shutil

    from character_workflow.lib import team_library as tl
    from character_workflow.lib import team_library_index as idx

    folder = tmp_path / "lib"
    folder.mkdir()
    (folder / "a.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
    mount = tl.mount_library(project_id="p1", path=str(folder), name=None, created_by="我")
    handler = watcher.TeamLibraryHandler(mount, delay=0)
    handler.rescan()
    before = (idx.cache_dir(mount.library_id) / "index.json").read_text(encoding="utf-8")
    assert len(idx.read_index(mount.library_id).entries) == 1

    events = _capture(monkeypatch)
    shutil.rmtree(folder)
    handler.rescan()
    assert events == []
    assert (idx.cache_dir(mount.library_id) / "index.json").read_text(encoding="utf-8") == before


def test_team_library_cancel_drops_pending_rescan(isolated_data_root, tmp_path, monkeypatch):
    from character_workflow.lib import team_library as tl

    folder = tmp_path / "lib"
    folder.mkdir()
    mount = tl.mount_library(project_id="p1", path=str(folder), name=None, created_by="我")
    handler = watcher.TeamLibraryHandler(mount, delay=30)
    rescans: list[int] = []
    monkeypatch.setattr(handler, "rescan", lambda: rescans.append(1))
    handler.on_any_event(FileCreatedEvent(str(folder / "a.png")))
    pending = handler._timer
    assert pending is not None and pending.is_alive()
    handler.cancel()
    pending.join(5)
    assert handler._timer is None and not pending.is_alive() and rescans == []


def test_refresh_team_library_broadcasts_diff_and_returns_index(
    isolated_data_root, tmp_path, monkeypatch
):
    from character_workflow.lib import team_library as tl
    from character_workflow.lib import team_library_index as idx

    folder = tmp_path / "lib"
    folder.mkdir()
    mount = tl.mount_library(project_id="p1", path=str(folder), name=None, created_by="我")
    scan_and_cache(mount)
    events = _capture(monkeypatch)
    (folder / "a.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
    index = watcher.refresh_team_library(mount)
    assert [e.kind for e in index.entries] == ["raw"]
    assert idx.read_index(mount.library_id) == index
    assert events == [("team-library-changed", {
        "library_id": mount.library_id, "asset_id": index.entries[0].id, "kind": "raw",
        "author": None, "change": "added", "title": "a.png", "status": "ready",
        "mime_type": "image/png",
    })]
    assert watcher.refresh_team_library(mount).entries == index.entries
    assert len(events) == 1


def test_team_library_handler_rescan_goes_through_refresh(isolated_data_root, tmp_path, monkeypatch):
    from character_workflow.lib import team_library as tl

    folder = tmp_path / "lib"
    folder.mkdir()
    mount = tl.mount_library(project_id="p1", path=str(folder), name=None, created_by="我")
    calls: list[str] = []
    monkeypatch.setattr(watcher, "refresh_team_library", lambda m: calls.append(m.library_id))
    watcher.TeamLibraryHandler(mount, delay=0).rescan()
    assert calls == [mount.library_id]


def test_refresh_team_library_without_prior_index_broadcasts_nothing(
    isolated_data_root, tmp_path, monkeypatch
):
    """索引缓存丢了（或首扫）：整库都算 added，不能给每条都广播一次提醒。"""
    import shutil

    from character_workflow.lib import team_library as tl
    from character_workflow.lib import team_library_index as idx

    folder = tmp_path / "lib"
    folder.mkdir()
    (folder / "a.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
    mount = tl.mount_library(project_id="p1", path=str(folder), name=None, created_by="我")
    shutil.rmtree(idx.cache_dir(mount.library_id), ignore_errors=True)
    events = _capture(monkeypatch)
    index = watcher.refresh_team_library(mount)
    assert [e.kind for e in index.entries] == ["raw"] and events == []


def _png_bytes(tag: bytes = b"") -> bytes:
    return b"\x89PNG\r\n\x1a\n" + tag + b"\x00" * 16


def _rescan_and_join() -> None:
    for thread in watcher.rescan_team_libraries():
        thread.join(5)
        assert not thread.is_alive()


def test_startup_rescan_broadcasts_only_changes_since_cached_index(
    isolated_data_root, tmp_path, monkeypatch
):
    """停服期间库里多了东西：启动补扫对老缓存只发增量，不把整库再报一遍。"""
    from character_workflow.lib import team_library as tl
    from character_workflow.lib import team_library_index as idx

    folder = tmp_path / "lib"
    folder.mkdir()
    (folder / "old.png").write_bytes(_png_bytes(b"old"))
    mount = tl.mount_library(project_id="p1", path=str(folder), name=None, created_by="我")
    scan_and_cache(mount)
    (folder / "new.png").write_bytes(_png_bytes(b"new"))
    events = _capture(monkeypatch)
    _rescan_and_join()
    assert [(d["title"], d["change"]) for _, d in events] == [("new.png", "added")]
    assert {e.title for e in idx.read_index(mount.library_id).entries} == {"old.png", "new.png"}


def test_startup_rescan_without_cache_is_silent_and_skips_unreachable(
    isolated_data_root, tmp_path, monkeypatch
):
    import shutil

    from character_workflow.lib import team_library as tl
    from character_workflow.lib import team_library_index as idx

    fresh = tmp_path / "fresh"
    fresh.mkdir()
    (fresh / "a.png").write_bytes(_png_bytes())
    fresh_mount = tl.mount_library(project_id="p1", path=str(fresh), name=None, created_by="我")
    shutil.rmtree(idx.cache_dir(fresh_mount.library_id), ignore_errors=True)
    offline = tmp_path / "offline"
    offline.mkdir()
    (offline / "b.png").write_bytes(_png_bytes())
    offline_mount = tl.mount_library(
        project_id="p1", path=str(offline), name=None, created_by="我"
    )
    scan_and_cache(offline_mount)
    cached = (idx.cache_dir(offline_mount.library_id) / "index.json").read_text(encoding="utf-8")
    shutil.rmtree(offline)

    events = _capture(monkeypatch)
    _rescan_and_join()
    assert events == []
    assert [e.title for e in idx.read_index(fresh_mount.library_id).entries] == ["a.png"]
    after = (idx.cache_dir(offline_mount.library_id) / "index.json").read_text(encoding="utf-8")
    assert after == cached


def test_startup_rescan_failure_is_logged_and_other_libraries_continue(
    isolated_data_root, tmp_path, monkeypatch, caplog
):
    from character_workflow.lib import team_library as tl

    mounts = []
    for name in ("a", "b"):
        folder = tmp_path / name
        folder.mkdir()
        mounts.append(tl.mount_library(project_id="p1", path=str(folder), name=None, created_by="我"))
    refreshed: list[str] = []

    def flaky(mount):
        if mount.library_id == mounts[0].library_id:
            raise OSError("网盘掉线")
        refreshed.append(mount.library_id)

    monkeypatch.setattr(watcher, "refresh_team_library", flaky)
    with caplog.at_level("ERROR", logger=watcher.__name__):
        _rescan_and_join()
    assert refreshed == [mounts[1].library_id]
    assert mounts[0].library_id in caplog.text


def _mount_folders(tmp_path, names):
    from character_workflow.lib import team_library as tl

    mounts = []
    for name in names:
        folder = tmp_path / name
        folder.mkdir()
        mounts.append(tl.mount_library(project_id="p1", path=str(folder), name=None, created_by="我"))
    return mounts


@pytest.mark.parametrize("stuck_at", ["reachable", "refresh"])
def test_startup_rescan_one_stuck_library_does_not_hold_back_others(
    isolated_data_root, tmp_path, monkeypatch, stuck_at
):
    """死网盘上 is_dir() 也会挂住：每个库各自一条线程，挂住的那个不拖住别的，也不拖住调用方。"""
    import threading

    from character_workflow.lib import team_library as tl

    stuck, live = _mount_folders(tmp_path, ("stuck", "live"))
    for mount in (stuck, live):
        scan_and_cache(mount)
    (Path(live.mount_path) / "new.png").write_bytes(_png_bytes(b"new"))
    release = threading.Event()
    real_reachable, real_refresh = tl.library_reachable, watcher.refresh_team_library

    def reachable(mount):
        if stuck_at == "reachable" and mount.library_id == stuck.library_id:
            release.wait(10)
        return real_reachable(mount)

    def refresh(mount):
        if stuck_at == "refresh" and mount.library_id == stuck.library_id:
            release.wait(10)
        return real_refresh(mount)

    monkeypatch.setattr(tl, "library_reachable", reachable)
    monkeypatch.setattr(watcher, "refresh_team_library", refresh)
    events = _capture(monkeypatch)
    try:
        threads = {t.name: t for t in watcher.rescan_team_libraries()}
        live_thread = threads[f"team-library-rescan-{live.library_id}"]
        stuck_thread = threads[f"team-library-rescan-{stuck.library_id}"]
        live_thread.join(5)
        assert not live_thread.is_alive()
        assert [(d["library_id"], d["change"]) for _, d in events] == [(live.library_id, "added")]
        assert stuck_thread.is_alive() and stuck_thread.daemon
    finally:
        release.set()
    stuck_thread.join(5)
    assert not stuck_thread.is_alive()


def test_refresh_scans_outside_lock_so_second_refresh_is_not_blocked(
    isolated_data_root, tmp_path, monkeypatch
):
    """补扫在扫一个慢网盘时，分享路由写完后的刷新不能排在它后面等。"""
    import threading

    from character_workflow.lib import team_library_index as idx

    (mount,) = _mount_folders(tmp_path, ("lib",))
    scan_and_cache(mount)
    scanning, release = threading.Event(), threading.Event()
    real_build = idx.build_index
    slow_once = [True]

    def build(target):
        result = real_build(target)
        if slow_once[0]:  # 第一次：扫完了还没落盘就卡住，手里是写入前的目录
            slow_once[0] = False
            scanning.set()
            release.wait(10)
        return result

    monkeypatch.setattr(idx, "build_index", build)
    events = _capture(monkeypatch)
    slow = threading.Thread(target=watcher.refresh_team_library, args=(mount,), daemon=True)
    slow.start()
    try:
        assert scanning.wait(5)
        (Path(mount.mount_path) / "shared.png").write_bytes(_png_bytes(b"s"))
        index = watcher.refresh_team_library(mount)
        assert slow.is_alive()  # 没等慢的那次扫完就返回了
        assert [e.title for e in index.entries] == ["shared.png"]
    finally:
        release.set()
    slow.join(5)
    assert not slow.is_alive()
    # 先开扫、后扫完的那次看到的是写入前的目录：结果作废，不盖索引、不广播假 removed。
    assert [e.title for e in idx.read_index(mount.library_id).entries] == ["shared.png"]
    assert [(d["title"], d["change"]) for _, d in events] == [("shared.png", "added")]


def test_superseded_refresh_rescans_when_cache_is_gone(isolated_data_root, tmp_path, monkeypatch):
    """作废的旧结果绝不交给调用方：已落盘的那份恰好读不到（缓存被删）就重刷一次。"""
    import shutil
    import threading

    from character_workflow.lib import team_library_index as idx

    (mount,) = _mount_folders(tmp_path, ("lib",))
    scan_and_cache(mount)
    scanning, release = threading.Event(), threading.Event()
    real_build = idx.build_index
    slow_once = [True]

    def build(target):
        result = real_build(target)
        if slow_once[0]:
            slow_once[0] = False
            scanning.set()
            release.wait(10)
        return result

    monkeypatch.setattr(idx, "build_index", build)
    _capture(monkeypatch)
    returned: list = []
    slow = threading.Thread(
        target=lambda: returned.append(watcher.refresh_team_library(mount)), daemon=True
    )
    slow.start()
    assert scanning.wait(5)
    (Path(mount.mount_path) / "shared.png").write_bytes(_png_bytes(b"s"))
    watcher.refresh_team_library(mount)
    shutil.rmtree(idx.cache_dir(mount.library_id))
    release.set()
    slow.join(5)
    assert not slow.is_alive()
    assert [e.title for e in returned[0].entries] == ["shared.png"]


def test_startup_rescan_survives_broken_mount_table(isolated_data_root, monkeypatch, caplog):
    from character_workflow.lib import team_library as tl

    def broken(_project_id=None):
        raise ValueError("挂载表坏了")

    monkeypatch.setattr(tl, "list_mounts", broken)
    with caplog.at_level("WARNING", logger=watcher.__name__):
        watcher.rescan_team_libraries()
    assert "挂载表坏了" in caplog.text


def test_start_watchers_runs_startup_rescan(isolated_data_root, monkeypatch):
    """rescan_team_libraries 只读挂载表、每库起 daemon 线程就返回，start_watchers 直接调它。"""
    calls: list[str] = []
    monkeypatch.setattr(watcher, "rescan_team_libraries", lambda: calls.append("rescan") or [])
    obs = watcher.start_watchers()
    try:
        assert calls == ["rescan"]
    finally:
        obs.stop()
        obs.join(timeout=5)
