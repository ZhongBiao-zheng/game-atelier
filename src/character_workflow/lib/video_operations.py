"""A host FIFO of local Canvas edits. Canvas publication and cancel share the project lock."""
from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass
import hashlib
import json
import logging
from pathlib import Path
import re
import shutil
from typing import Annotated, Awaitable, Callable

from pydantic import BaseModel, ConfigDict, Field

from .atomic_io import atomic_write_json
from .canvas_media_operations import (
    _display_size, _file_sha256, _node_display_size, _now, _placement_shift,
    _write_project_state_unlocked,
)
from .canvas_projects import (
    _read_canvas_document_unlocked, _recover_canvas_transactions_unlocked, canvas_project_dir,
    canvas_project_lock_path, canvas_projects_root, resolve_canvas_media,
)
from .file_lock import file_lock
from .schemas import (
    CanvasLocalToolOrigin, CanvasMaterialConnection, CanvasMediaNodeData, CanvasMediaVersion,
    CanvasPoint, CanvasVideoNode, VideoCompress, VideoTrim,
)
from .video_encoder import VideoError


class Submit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=160)
    version_id: str = Field(min_length=1, max_length=160)
    operation: Annotated[VideoTrim | VideoCompress, Field(discriminator="kind")]


def source(project: str, version: str):
    path, media = resolve_canvas_media(project, version)
    if media.kind != "video":
        raise VideoError("invalid_input", "请选择项目内已保存的视频版本")
    return path, media


TERMINAL = {"succeeded", "failed", "canceled"}
ID = re.compile(r"video-[0-9a-f]{32}")


@dataclass(frozen=True)
class Record:
    project: str
    id: str

    def __post_init__(self):
        if not ID.fullmatch(self.id):
            raise KeyError("invalid operation id")

    @property
    def root(self):
        return self.owned(".runtime", "video-operations")

    @property
    def file(self):
        return self.root / (self.id + ".json")

    @property
    def stage(self):
        return self.root / self.id

    @property
    def output(self):
        return self.owned("derived", self.id)

    def owned(self, *parts):
        path = canvas_project_dir(self.project).joinpath(*parts)
        if path != path.resolve():
            raise PermissionError("视频操作目录不能经过符号链接")
        return path

    def prepare(self):
        self.stage.mkdir(exist_ok=False)
        return self.stage / "result.mp4"

    def clean(self):
        shutil.rmtree(self.stage, ignore_errors=True)

    def read(self):
        return json.loads(self.file.read_text(encoding="utf-8"))

    def write(self, record, status, **fields):
        record = {**record, "status": status, "updated_at": _now(), **fields}
        atomic_write_json(self.file, record)
        return record

    def transition(self, status, **fields):
        with file_lock(canvas_project_lock_path(self.project)):
            current = self.read()
            if current["status"] in TERMINAL:
                return current
            if status == "canceled" and current["status"] == "committing":
                doc = _read_canvas_document_unlocked(self.project)
                version = doc.content_versions.get("version-" + self.id)
                if version and version.origin.kind == "local_tool" and version.origin.operation_id == self.id:
                    return self.write(current, "succeeded", version_id=version.version_id,
                                      node_id=self.id, encoded_bytes=version.bytes)
            return self.write(current, status, **fields)

    def register(self, body: Submit):
        if self.file.exists():
            existing = self.read()
            if existing["request"] != body.model_dump():
                raise VideoError("request_conflict", "同一请求号已经使用了其他参数")
            return existing, False
        source(self.project, body.version_id)
        if isinstance(body.operation, VideoTrim) and body.operation.end_ms <= body.operation.start_ms:
            raise VideoError("invalid_range", "终点必须晚于起点")
        self.root.mkdir(parents=True, exist_ok=True)
        return self.write({"operation_id": self.id, "project_id": self.project,
                           "request": body.model_dump(), "created_at": _now()}, "queued"), True

    def commit(self, body: Submit, info: dict):
        path = self.stage / "result.mp4"
        digest, length = _file_sha256(path), path.stat().st_size
        with file_lock(canvas_project_lock_path(self.project)):
            current = self.read()
            if current["status"] != "committing":
                return current
            _recover_canvas_transactions_unlocked(self.project)
            doc = _read_canvas_document_unlocked(self.project)
            original = doc.content_versions.get(body.version_id)
            if original is None or original.kind != "video":
                raise VideoError("source_missing", "源视频版本已移除")
            if isinstance(body.operation, VideoCompress) and length >= original.bytes:
                return self.write(current, "succeeded", message="压缩结果没有变小，已保留原件。",
                                  original_bytes=original.bytes, encoded_bytes=length)
            origin = CanvasLocalToolOrigin(kind="local_tool", operation_id=self.id,
                                           source_version_id=body.version_id, operation=body.operation)
            stamp = _now()
            version = CanvasMediaVersion(
                version_id="version-" + self.id, kind="video", created_at=stamp, sha256=digest,
                origin=origin, path=f"derived/{self.id}/result.mp4", mime_type="video/mp4",
                bytes=length, width=info["width"], height=info["height"], duration_ms=info["duration_ms"],
            )
            parent = next((n for n in doc.nodes if n.type == "video"
                           and n.data.current_version_id == body.version_id), None)
            point = CanvasPoint(x=parent.position.x + _node_display_size(parent).width + 96,
                                y=parent.position.y) if parent else CanvasPoint(x=0, y=0)
            size = _display_size(version.width, version.height, 320)
            point.y += _placement_shift([point], [size], doc.nodes)
            node = CanvasVideoNode(id=self.id, type="video", position=point, size=size,
                                   title="裁剪结果" if isinstance(body.operation, VideoTrim) else "压缩结果",
                                   data=CanvasMediaNodeData(current_version_id=version.version_id))
            if parent:
                doc.connections.append(CanvasMaterialConnection(
                    id="connection-" + self.id, role="material", source_node_id=parent.id,
                    target_node_id=node.id,
                ))
            doc.content_versions[version.version_id] = version
            doc.nodes.append(node)
            doc.revision += 1
            doc.updated_at = stamp
            self.stage.rename(self.output)
            try:
                _write_project_state_unlocked(self.project, doc)
            except Exception:
                shutil.rmtree(self.output)
                raise
            return self.write(current, "succeeded", version_id=version.version_id, node_id=node.id,
                              original_bytes=original.bytes, encoded_bytes=length)

    def reconcile(self, code="interrupted", message="视频处理因服务中断而停止"):
        with file_lock(canvas_project_lock_path(self.project)):
            record = self.read()
            if record["status"] not in TERMINAL:
                doc = _read_canvas_document_unlocked(self.project)
                version = doc.content_versions.get("version-" + self.id)
                if version and version.origin.kind == "local_tool" and version.origin.operation_id == self.id:
                    self.write(record, "succeeded", version_id=version.version_id, node_id=self.id,
                               encoded_bytes=version.bytes)
                else:
                    # The deterministic destination belongs to this record only after preparation.
                    if record["status"] == "committing" and self.output.is_dir():
                        shutil.rmtree(self.output)
                    self.write(record, "failed", error_code=code, message=message)
            if self.stage.is_dir():
                shutil.rmtree(self.stage)


def recover():
    for path in canvas_projects_root().glob("*/.runtime/video-operations/video-*.json"):
        project = path.parents[2].name
        if ID.fullmatch(path.stem) and (path.parents[2] / "project.json").is_file():
            record = Record(project, path.stem)
            try:
                if record.file == path and not path.is_symlink():
                    if record.stage.exists() or record.read()["status"] not in TERMINAL:
                        record.reconcile()
            except (ValueError, KeyError, OSError):
                logging.getLogger(__name__).warning("Skipping unreadable video record %s", path.stem)


Render = Callable[[str, Submit, Path, Callable[[int], None]], Awaitable[dict]]


class VideoQueue:
    def __init__(self, render: Render):
        self.render = render
        self.pending = deque()
        self.submit_lock = asyncio.Lock()
        self.worker = None
        self.active = None
        self.render_task = None
        self.progress_ms = 0
        self.ready = False
        self.closing = False

    async def initialize(self):
        async with self.submit_lock:
            if not self.ready:
                await asyncio.to_thread(recover)
                self.ready = True

    async def submit(self, project: str, body: Submit):
        await self.initialize()
        key = hashlib.sha256((project + "\0" + body.request_id).encode()).hexdigest()[:32]
        ref = Record(project, "video-" + key)
        async with self.submit_lock:
            if self.closing:
                raise VideoError("interrupted", "服务正在停止")
            row, new = await asyncio.to_thread(ref.register, body)
            if new:
                self.pending.append((ref, body))
                if self.worker is None or self.worker.done():
                    self.worker = asyncio.create_task(self._drain())
            return row

    async def get(self, ref):
        await self.initialize()
        row = await asyncio.to_thread(ref.read)
        if self.active == ref and row["status"] == "running":
            row["processed_ms"] = self.progress_ms
        return row

    async def cancel(self, ref):
        await self.initialize()
        async with self.submit_lock:
            row = await asyncio.to_thread(ref.transition, "canceled")
            if row["status"] == "canceled":
                self.pending = deque(pair for pair in self.pending if pair[0] != ref)
                if self.active == ref and self.render_task is not None:
                    self.render_task.cancel()
                    await asyncio.gather(self.render_task, return_exceptions=True)
                await asyncio.to_thread(ref.reconcile)
            return row

    async def close(self):
        async with self.submit_lock:
            self.closing = True
            self.pending.clear()
            if self.render_task:
                self.render_task.cancel()
        if self.worker:
            await self.worker
        await asyncio.to_thread(recover)

    def _progress(self, ms):
        self.progress_ms = ms

    async def _drain(self):
        while self.pending:
            ref, body = self.pending.popleft()
            self.active, self.progress_ms = ref, 0
            try:
                async with self.submit_lock:
                    if self.closing:
                        continue
                    row = await asyncio.to_thread(ref.transition, "running")
                    if row["status"] != "running":
                        continue
                    path = await asyncio.to_thread(ref.prepare)
                    self.render_task = asyncio.create_task(self.render(ref.project, body, path, self._progress))
                info = await self.render_task
                self.render_task = None
                row = await asyncio.to_thread(ref.transition, "committing")
                if row["status"] == "committing":
                    await asyncio.to_thread(ref.commit, body, info)
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                code = exc.code if isinstance(exc, VideoError) else "processing_failed"
                message = str(exc) if isinstance(exc, VideoError) else "视频处理失败，请检查素材和磁盘空间"
                try:
                    await asyncio.to_thread(ref.reconcile, code, message)
                except (KeyError, OSError):
                    logging.getLogger(__name__).exception("Could not reconcile video operation %s", ref.id)
            finally:
                self.active = self.render_task = None
                try:
                    await asyncio.to_thread(ref.clean)
                except KeyError:
                    pass  # The project was removed while encoding.
