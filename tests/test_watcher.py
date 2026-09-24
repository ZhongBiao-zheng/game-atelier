"""watcher handlers — 原子写（tmp.replace）在 Linux/inotify 上发 moved 事件；
mac FSEvents 合并成 modified，开发机测不出，必须用单元事件回归。"""
import json

from watchdog.events import FileCreatedEvent, FileMovedEvent

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
    """目录掉线不是「库空了」：scan_library 对不存在的目录只会返回空索引，不抛 OSError。

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
    idx.scan_library(mount)
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
