"""Derived project gallery and project-index read models."""
from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from character_workflow.lib import data_root
from character_workflow.lib.character_derivatives import character_display_name
from character_workflow.lib.jobs import list_jobs
from character_workflow.lib.projects import read_projects, resolve_project
from character_workflow.lib.schemas import (
    AssetSlot,
    GalleryArtTarget,
    GalleryMedia,
    GalleryTarget,
    GalleryUiTarget,
    GalleryVideoTarget,
    JobStatus,
    ProjectGalleryResponse,
    ProjectIndexItem,
    ProjectIndexResponse,
)
from character_workflow.lib.ui_schemes import read_schemes, scheme_screens_dir
from character_workflow.lib.video_jobs import list_productions


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_EXTENSIONS = {".mp4"}
GALLERY_CATEGORIES = {"all", "art", "ui", "video"}
SLOT_LABELS = {
    AssetSlot.PORTRAIT: "立绘",
    AssetSlot.PROMO: "美宣",
    AssetSlot.TURNAROUND: "三视图",
}


@dataclass(frozen=True)
class _MediaRecord:
    media: GalleryMedia
    mtime: float


def read_gallery_hidden() -> list[str]:
    path = data_root.runtime_dir() / "gallery-hidden.json"
    if not path.is_file():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    paths = payload.get("paths") if isinstance(payload, dict) else None
    if not isinstance(paths, list):
        return []
    return [value for value in paths if isinstance(value, str)]


def gallery_job_ids_by_path(*, done_only: bool = False) -> dict[str, str]:
    root = data_root.resolve_data_root()
    result: dict[str, str] = {}
    try:
        jobs = list_jobs()
    except Exception:
        return result
    for job in jobs:
        if done_only and job.status is not JobStatus.DONE:
            continue
        for raw_path in job.output_paths:
            path = Path(raw_path)
            absolute = path if path.is_absolute() else root / path
            try:
                relative = absolute.resolve().relative_to(root).as_posix()
            except ValueError:
                continue
            result.setdefault(relative, job.job_id)
            result.setdefault(str(absolute.resolve()), job.job_id)
    return result


def gallery_failed_paths() -> set[str]:
    root = data_root.resolve_data_root()
    done_paths = set(gallery_job_ids_by_path(done_only=True))
    failed_paths: set[str] = set()
    try:
        jobs = list_jobs()
    except Exception:
        return failed_paths
    for job in jobs:
        if job.status is JobStatus.DONE:
            continue
        for raw_path in job.output_paths:
            path = Path(raw_path)
            absolute = path if path.is_absolute() else root / path
            try:
                relative = absolute.resolve().relative_to(root).as_posix()
            except ValueError:
                continue
            if relative not in done_paths and str(absolute.resolve()) not in done_paths:
                failed_paths.add(relative)
    return failed_paths


def project_gallery(
    project_id: str,
    *,
    category: str = "all",
    limit: int = 40,
    cursor: str | None = None,
) -> ProjectGalleryResponse:
    if category not in GALLERY_CATEGORIES:
        raise ValueError(f"unknown gallery category: {category}")
    project = resolve_project(project_id)
    hidden = set(read_gallery_hidden())
    job_ids = gallery_job_ids_by_path(done_only=True)
    failed = gallery_failed_paths()
    records: list[_MediaRecord] = []
    records.extend(_project_records(project.id, category, hidden, job_ids, failed))
    records.sort(key=_sort_key)

    if cursor:
        cursor_key = _decode_cursor(cursor)
        records = [record for record in records if _sort_key(record) > cursor_key]

    page = records[:limit]
    next_cursor = None
    if len(records) > limit and page:
        last = page[-1]
        next_cursor = _encode_cursor(last.mtime, last.media.path)
    return ProjectGalleryResponse(
        items=[record.media for record in page],
        next_cursor=next_cursor,
    )


def project_index() -> ProjectIndexResponse:
    projects = read_projects()
    hidden = set(read_gallery_hidden())
    job_ids = gallery_job_ids_by_path(done_only=True)
    failed = gallery_failed_paths()
    items: list[ProjectIndexItem] = []
    for project in projects.projects:
        records = _project_records(
            project.id,
            "all",
            hidden,
            job_ids,
            failed,
        )
        records.sort(key=_sort_key)
        cover_paths = [
            record.media.path
            for record in records
            if record.media.media_type == "image"
        ][:4]
        items.append(ProjectIndexItem(
            project=project,
            cover_paths=cover_paths,
            activity_at=_iso(project_activity_mtime(project.id)),
        ))
    items.sort(key=lambda item: item.activity_at, reverse=True)
    return ProjectIndexResponse(items=items)


def project_gallery_media(project_id: str, path: str) -> GalleryMedia:
    project = resolve_project(project_id)
    records = _project_records(
        project.id,
        "all",
        set(read_gallery_hidden()),
        gallery_job_ids_by_path(done_only=True),
        gallery_failed_paths(),
    )
    match = next((record.media for record in records if record.media.path == path), None)
    if match is None:
        raise KeyError(path)
    return match


def project_gallery_items(project_id: str, category: str = "all") -> list[GalleryMedia]:
    """Return the complete derived media set for internal aggregate read models."""
    if category not in GALLERY_CATEGORIES:
        raise ValueError(f"unknown gallery category: {category}")
    project = resolve_project(project_id)
    records = _project_records(
        project.id,
        category,
        set(read_gallery_hidden()),
        gallery_job_ids_by_path(done_only=True),
        gallery_failed_paths(),
    )
    records.sort(key=_sort_key)
    return [record.media for record in records]


def _project_records(
    project_id: str,
    category: str,
    hidden: set[str],
    job_ids: dict[str, str],
    failed: set[str],
) -> list[_MediaRecord]:
    records: list[_MediaRecord] = []
    if category in {"all", "art"}:
        records.extend(_art_records(project_id, hidden, job_ids, failed))
    if category in {"all", "ui"}:
        records.extend(_ui_records(project_id, hidden, job_ids, failed))
    if category in {"all", "video"}:
        records.extend(_video_records(project_id, hidden, job_ids, failed))
    return records


def project_activity_mtime(project_id: str) -> float:
    project = resolve_project(project_id)
    try:
        fallback = datetime.fromisoformat(project.created_at).timestamp()
    except ValueError:
        fallback = 0.0
    latest = _tree_mtime(
        data_root.projects_dir() / project.slug,
        fallback,
        ignored_names={"folders.json"},
    )
    assignments = read_projects().assignments
    assigned_characters = {
        character_id
        for character_id, owner_id in assignments.items()
        if owner_id == project.id
    }
    for character_id, owner_id in assignments.items():
        if owner_id == project.id:
            latest = max(
                latest,
                _tree_mtime(data_root.characters_dir() / character_id, fallback),
            )
    try:
        jobs = list_jobs()
    except Exception:
        jobs = []
    for job in jobs:
        if job.project_id != project.id and job.character_id not in assigned_characters:
            continue
        job_path = data_root.runtime_dir() / "jobs" / f"{job.job_id}.json"
        try:
            latest = max(latest, job_path.stat().st_mtime)
        except OSError:
            continue
    return latest


def project_id_for_media_path(path: str) -> str | None:
    parts = Path(path).parts
    projects = read_projects()
    if len(parts) >= 2 and parts[0] == "characters":
        return projects.assignments.get(parts[1])
    if len(parts) >= 3 and parts[0] == "projects":
        project = next((item for item in projects.projects if item.slug == parts[1]), None)
        return project.id if project else None
    return None


def _art_records(
    project_id: str,
    hidden: set[str],
    job_ids: dict[str, str],
    failed: set[str],
) -> list[_MediaRecord]:
    assignments = read_projects().assignments
    records: list[_MediaRecord] = []
    for character_id, owner_id in assignments.items():
        if owner_id != project_id:
            continue
        character_name = character_display_name(character_id)
        for slot in AssetSlot:
            root = data_root.characters_dir() / character_id / slot.value
            for path in _files(root, IMAGE_EXTENSIONS):
                relative = _relative(path)
                if relative in hidden or relative in failed:
                    continue
                records.append(_record(
                    path,
                    media_type="image",
                    title=character_name,
                    detail=SLOT_LABELS[slot],
                    job_id=job_ids.get(relative),
                    target=GalleryArtTarget(character_id=character_id, asset_slot=slot),
                ))
    return records


def _ui_records(
    project_id: str,
    hidden: set[str],
    job_ids: dict[str, str],
    failed: set[str],
) -> list[_MediaRecord]:
    project = resolve_project(project_id)
    records: list[_MediaRecord] = []
    for scheme in read_schemes(project.id).schemes:
        screens_root = scheme_screens_dir(project, scheme.id)
        if not screens_root.is_dir():
            continue
        for screen_dir in sorted(path for path in screens_root.iterdir() if path.is_dir()):
            for path in _files(screen_dir, IMAGE_EXTENSIONS):
                relative = _relative(path)
                if relative in hidden or relative in failed:
                    continue
                records.append(_record(
                    path,
                    media_type="image",
                    title=screen_dir.name,
                    detail=f"{scheme.name} · UI 页面",
                    job_id=job_ids.get(relative),
                    target=GalleryUiTarget(
                        scheme_id=scheme.id,
                        screen_id=screen_dir.name,
                    ),
                ))
    return records


def _video_records(
    project_id: str,
    hidden: set[str],
    job_ids: dict[str, str],
    failed: set[str],
) -> list[_MediaRecord]:
    records: list[_MediaRecord] = []
    root = data_root.resolve_data_root()
    for production in list_productions(project_id):
        for relative in production.versions:
            if relative in hidden or relative in failed:
                continue
            path = root / relative
            if path.suffix.lower() not in VIDEO_EXTENSIONS or not path.is_file():
                continue
            records.append(_record(
                path,
                media_type="video",
                title=production.title,
                detail="完整视频",
                job_id=job_ids.get(relative),
                target=GalleryVideoTarget(
                    production_id=production.production_id,
                ),
            ))
    return records


def _files(root: Path, extensions: set[str]) -> list[Path]:
    if not root.is_dir():
        return []
    return [
        path for path in root.iterdir()
        if path.is_file() and path.suffix.lower() in extensions
    ]


def _record(
    path: Path,
    *,
    media_type: Literal["image", "video"],
    title: str,
    detail: str,
    job_id: str | None,
    target: GalleryTarget,
) -> _MediaRecord:
    mtime = path.stat().st_mtime
    return _MediaRecord(
        media=GalleryMedia(
            path=_relative(path),
            media_type=media_type,
            produced_at=_iso(mtime),
            title=title,
            detail=detail,
            job_id=job_id,
            target=target,
        ),
        mtime=mtime,
    )


def _relative(path: Path) -> str:
    return path.resolve().relative_to(data_root.resolve_data_root().resolve()).as_posix()


def _sort_key(record: _MediaRecord) -> tuple[float, str]:
    return (-record.mtime, record.media.path)


def _encode_cursor(mtime: float, path: str) -> str:
    raw = json.dumps([mtime, path], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[float, str]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        value = json.loads(base64.urlsafe_b64decode(padded).decode())
        if (
            not isinstance(value, list)
            or len(value) != 2
            or not isinstance(value[0], (int, float))
            or not isinstance(value[1], str)
        ):
            raise ValueError
        return (-float(value[0]), value[1])
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("invalid gallery cursor") from error


def _tree_mtime(
    root: Path,
    fallback: float,
    ignored_names: set[str] | None = None,
) -> float:
    if not root.exists():
        return fallback
    latest = fallback
    ignored = ignored_names or set()
    for directory, _, filenames in os.walk(root):
        directory_path = Path(directory)
        try:
            latest = max(latest, directory_path.stat().st_mtime)
        except OSError:
            continue
        for filename in filenames:
            if filename in ignored:
                continue
            try:
                latest = max(latest, (directory_path / filename).stat().st_mtime)
            except OSError:
                continue
    return latest


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
