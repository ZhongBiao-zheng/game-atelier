"""watchdog FSEvents handler — 监听 .runtime/jobs/ / characters/ / 图片目录 → SSE 广播。
macOS 用 FSEvents（默认）；Linux 用 inotify；显式不用 PollingObserver。
"""
from __future__ import annotations

import json
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from character_workflow.lib import data_root
from viewer_server.sse import hub


class JobsHandler(FileSystemEventHandler):
    def on_modified(self, event: FileSystemEvent) -> None:
        self._emit(event)

    def on_created(self, event: FileSystemEvent) -> None:
        self._emit(event)

    def _emit(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        p = Path(event.src_path)
        if p.suffix != ".json" or p.name.endswith(".tmp"):
            return
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return
        hub.broadcast("job-changed", {
            "job_id": data.get("job_id"),
            "status": data.get("status"),
        })


class CharactersHandler(FileSystemEventHandler):
    # Skill / routes 用 atomic replace（tmp.replace），FSEvents 可能只发
    # on_moved 或 on_created，不补全这两个 hook 就会漏掉 spec 改动。
    def on_modified(self, event: FileSystemEvent) -> None:
        self._emit(event.src_path, event.is_directory)

    def on_created(self, event: FileSystemEvent) -> None:
        self._emit(event.src_path, event.is_directory)

    def on_moved(self, event: FileSystemEvent) -> None:
        dest = getattr(event, "dest_path", "") or event.src_path
        self._emit(dest, event.is_directory)

    def _emit(self, raw_path: str, is_dir: bool) -> None:
        if is_dir:
            return
        p = Path(raw_path)
        if p.name != "spec.md":
            return
        hub.broadcast("spec-changed", {"character_id": p.parent.name})


class ProjectsHandler(FileSystemEventHandler):
    def on_modified(self, event: FileSystemEvent) -> None:
        self._emit(event.src_path)

    def on_created(self, event: FileSystemEvent) -> None:
        self._emit(event.src_path)

    def on_moved(self, event: FileSystemEvent) -> None:
        dest = getattr(event, "dest_path", "") or event.src_path
        self._emit(dest)

    def _emit(self, raw_path: str) -> None:
        if Path(raw_path).name != "projects.json":
            return
        hub.broadcast("projects-changed", {})


class ActiveCharacterHandler(FileSystemEventHandler):
    def on_modified(self, event: FileSystemEvent) -> None:
        p = Path(event.src_path)
        if p.name != "active-character.json":
            return
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return
        hub.broadcast("active-character-changed", {"active_id": data.get("active_id")})


class ImagesHandler(FileSystemEventHandler):
    def __init__(self, character_resolver):
        self._resolve = character_resolver

    def on_created(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        p = Path(event.src_path)
        if p.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            return
        cid = self._resolve(p)
        hub.broadcast("image-added", {"character_id": cid, "path": str(p)})


def start_watchers() -> Observer:
    runtime = data_root.runtime_dir()
    project_root = data_root.resolve_data_root()

    observer = Observer()

    jobs_dir = runtime / "jobs"
    jobs_dir.mkdir(parents=True, exist_ok=True)
    observer.schedule(JobsHandler(), str(jobs_dir), recursive=False)

    runtime.mkdir(parents=True, exist_ok=True)
    observer.schedule(ActiveCharacterHandler(), str(runtime), recursive=False)
    observer.schedule(ProjectsHandler(), str(runtime), recursive=False)

    chars_dir = project_root / "characters"
    if chars_dir.exists():
        # recursive=True: spec.md 现在嵌在 characters/<id>/ 下，FSEvents 不递归看不见。
        observer.schedule(CharactersHandler(), str(chars_dir), recursive=True)

    cfg_path = runtime / "config.json"
    if cfg_path.exists():
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        image_root = cfg.get("image_storage_root", "")
        if image_root and Path(image_root).exists():
            observer.schedule(
                ImagesHandler(lambda p: p.parent.name),
                image_root, recursive=True,
            )

    observer.start()
    return observer
