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
