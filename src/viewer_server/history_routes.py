"""Local generation history. Pagination and deletion address stable output slots."""
from __future__ import annotations

import json
import shutil
import tempfile
import wave
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import PureWindowsPath
from typing import Annotated, Literal
from urllib.parse import urlencode
from zipfile import ZipFile

from fastapi import APIRouter, Body, HTTPException, Path, Query
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from character_workflow.lib import data_root, trash
from character_workflow.lib.canvas_thumbnails import cached_image_thumbnail, snap_thumbnail_width
from character_workflow.lib.library_subjects import display_prompt
from character_workflow.lib.jobs import list_jobs, output_slots, read_job, trash_studio_job
from character_workflow.lib.schemas import JobStatus
from character_workflow.lib.team_library_share import _media_filename
from viewer_server.routes import _read_gallery_hidden_state

router = APIRouter(prefix="/api/history")
JobId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
Kind = Literal["all", "image", "video", "audio", "text"]


class OutputRef(BaseModel):
    job_id: JobId
    output_index: int = Field(ge=0)


def _visible_job(job, hidden_projects):
    return (job.namespace in {"studio", "canvas"} and job.status in (JobStatus.DONE, JobStatus.PARTIAL)
            and job.canvas_project_id not in hidden_projects)


def _visible_file(raw, hidden_paths):
    root = data_root.resolve_data_root().resolve()
    path = (root / raw).resolve()
    if path.is_relative_to(root) and path.relative_to(root).as_posix() not in hidden_paths and path.is_file():
        return path
    return None


def _lookup(ref, hidden_paths, hidden_projects):
    try:
        job = read_job(ref.job_id)
    except FileNotFoundError:
        raise HTTPException(404, "找不到生成记录") from None
    if _visible_job(job, hidden_projects):
        for slot, raw in output_slots(job):
            if slot == ref.output_index and (path := _visible_file(raw, hidden_paths)):
                return job, path
    raise HTTPException(404, "找不到生成结果")


def output_title(job, slot, path):
    prompt = " ".join(display_prompt(job).split())[:16]
    if not prompt:
        return path.name
    multiple = slot > 0 or len(job.output_paths) > 1 or (job.params.n or 1) > 1
    return f"{prompt} · {slot + 1}" if multiple else prompt


def _download_name(path):
    # Match web/lib/pathName on both hosts, then apply the shared Windows filename rules.
    return _media_filename(PureWindowsPath(path).name)


@lru_cache(maxsize=512)
def _metadata(path, kind, mtime_ns, size):
    from PIL import Image

    # File identity is part of the cache key, including when a restored path is reused.
    try:
        if kind == "image":
            with Image.open(path) as image:
                return *image.size, None, None
        if kind == "video":
            from character_workflow.lib.canvas_agent_video import probe
            info = probe(path)
            return info["width"], info["height"], info["duration_ms"] / 1000, None
        if kind == "audio" and path.suffix.lower() == ".wav":
            with wave.open(str(path), "rb") as stream:
                return None, None, stream.getnframes() / stream.getframerate(), None
        if kind == "text":
            with path.open(encoding="utf-8", errors="replace") as file:
                return None, None, None, file.read(1024)
    except (OSError, ValueError, EOFError, wave.Error, Image.DecompressionBombError):
        pass
    return None, None, None, None


def _timestamp(value):
    try:
        return datetime.fromisoformat(value).astimezone(timezone.utc).isoformat()
    except ValueError:
        return ""


@router.get("")
def history(kind: Kind = "all", q: str = "", cursor: str | None = None,
            limit: int = Query(60, ge=1, le=200)):
    after = None
    if cursor:
        try:
            stamp, job_id, slot = json.loads(cursor)
            if not isinstance(stamp, str) or not isinstance(job_id, str) or type(slot) is not int:
                raise ValueError
            after = (stamp, job_id, slot)
        except (ValueError, TypeError):
            raise HTTPException(422, "分页位置无效") from None
    hidden_paths, hidden_projects = map(set, _read_gallery_hidden_state())
    query = q.strip().casefold()
    jobs = sorted(((_timestamp(job.submitted_at), job) for job in list_jobs()
                   if _visible_job(job, hidden_projects) and kind in ("all", job.kind)
                   and query in display_prompt(job).casefold()), key=lambda row: (row[0], row[1].job_id), reverse=True)
    items = []
    last = None
    for stamp, job in jobs:
        for slot, raw in output_slots(job):
            key = (stamp, job.job_id, -slot)
            if after and key >= after:
                continue
            path = _visible_file(raw, hidden_paths)
            if path is None:
                continue
            if len(items) == limit:
                return {"items": items, "next_cursor": json.dumps(last)}
            try:
                stat = path.stat()
            except FileNotFoundError:
                continue
            width, height, duration, preview = _metadata(path, job.kind, stat.st_mtime_ns, stat.st_size)
            url = "/api/raw?" + urlencode({"job_id": job.job_id, "path": raw})
            version = f"{stat.st_mtime_ns}-{stat.st_size}"
            thumb = f"/api/history/{job.job_id}/{slot}/thumb?v={version}" if job.kind == "image" else url
            items.append(dict(job_id=job.job_id, output_index=slot, kind=job.kind, url=url,
                              thumbnail_url=thumb, width=width, height=height,
                              duration=duration if duration is not None else job.params.duration, text_preview=preview,
                              filename=_download_name(raw), title=output_title(job, slot, path), prompt=display_prompt(job)[:120],
                              submitted_at=job.submitted_at))
            last = key
    return {"items": items, "next_cursor": None}


def _thumbnail_dir(job_id, slot):
    return data_root.runtime_dir() / "history-thumbnails" / job_id / str(slot)


@router.get("/{job_id}/{output_index}/thumb")
def thumbnail(job_id: JobId, output_index: Annotated[int, Path(ge=0)],
              width: int = Query(256, ge=1), v: str | None = None):
    job, path = _lookup(OutputRef(job_id=job_id, output_index=output_index),
                        *map(set, _read_gallery_hidden_state()))
    if job.kind != "image":
        raise HTTPException(404)
    stat = path.stat()
    version = f"{stat.st_mtime_ns}-{stat.st_size}"
    headers = {"Cache-Control": "private, max-age=31536000, immutable" if v == version else "no-store"}
    target = snap_thumbnail_width(width)
    if target is not None:
        cached = _thumbnail_dir(job_id, output_index) / f"{version}-{target}.webp"
        try:
            thumb = cached_image_thumbnail(cached, path, target)
        except OSError:
            thumb = None
        if thumb:
            return FileResponse(thumb, media_type="image/webp", headers=headers)
    return FileResponse(path, headers=headers)


@router.post("/download")
def download(refs: Annotated[list[OutputRef], Body(min_length=1)]):
    hidden = tuple(map(set, _read_gallery_hidden_state()))
    paths = [_lookup(ref, *hidden)[1] for ref in refs]
    names = [_download_name(path) for path in paths]
    if len(paths) == 1:
        return FileResponse(paths[0], filename=names[0])
    archive = tempfile.TemporaryFile()
    used = set()
    try:
        with ZipFile(archive, "w") as zipped:
            for path, name in zip(paths, names):
                candidate = name
                number = 1
                while candidate.casefold() in used:
                    number += 1
                    candidate = _media_filename(f"{number}-{name}")
                zipped.write(path, candidate)
                used.add(candidate.casefold())
        archive.seek(0)
    except BaseException:
        archive.close()
        raise

    def chunks():
        with archive:
            while chunk := archive.read(256 * 1024):
                yield chunk

    return StreamingResponse(chunks(), media_type="application/zip",
                             headers={"Content-Disposition": 'attachment; filename="history.zip"'})


@router.delete("/{job_id}")
def remove(job_id: JobId, slots: Annotated[list[Annotated[int, Field(ge=0)]], Body(min_length=1)]):
    try:
        selected = set(slots)
        trash_id = trash_studio_job(job_id, history_slots=selected)
        for slot in selected:
            shutil.rmtree(_thumbnail_dir(job_id, slot), ignore_errors=True)
        return {"trash_id": trash_id}
    except (FileNotFoundError, LookupError):
        raise HTTPException(404, "找不到生成结果") from None
    except (ValueError, trash.TrashError) as error:
        raise HTTPException(409, str(error)) from error
