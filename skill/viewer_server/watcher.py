"""watchdog FSEvents handler — 监听 .runtime/jobs/ / characters/ / 图片目录 → SSE 广播。
macOS 用 FSEvents（默认）；Linux 用 inotify；显式不用 PollingObserver。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from skill.viewer_server.sse import hub


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
    def on_modified(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        p = Path(event.src_path)
        if p.suffix != ".md":
            return
        hub.broadcast("spec-changed", {"character_id": p.stem})


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
    runtime = Path(os.environ.get("RUNTIME_DIR", ".runtime"))
    project_root = Path.cwd()

    observer = Observer()

    jobs_dir = runtime / "jobs"
    jobs_dir.mkdir(parents=True, exist_ok=True)
    observer.schedule(JobsHandler(), str(jobs_dir), recursive=False)

    runtime.mkdir(parents=True, exist_ok=True)
    observer.schedule(ActiveCharacterHandler(), str(runtime), recursive=False)

    chars_dir = project_root / "characters"
    if chars_dir.exists():
        observer.schedule(CharactersHandler(), str(chars_dir), recursive=False)

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
