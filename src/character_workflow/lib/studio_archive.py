"""把 Studio 自由试验产物复制为项目正式资产版本。"""
from __future__ import annotations

import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from character_workflow.lib import data_root
from character_workflow.lib.asset_versions import asset_output_lock, next_asset_path
from character_workflow.lib.character_derivatives import character_display_name
from character_workflow.lib.jobs import new_job_id, read_job, save_job
from character_workflow.lib.projects import read_projects, resolve_project
from character_workflow.lib.schemas import AssetSlot, Job, JobKind, JobParams, JobStatus
from character_workflow.lib.ui_jobs import screen_output_dir
from character_workflow.lib.ui_schemes import read_schemes, scheme_screens_dir
from character_workflow.lib.video_jobs import (
    list_productions,
    production_output_dir,
    require_production,
)
from character_workflow.lib.workspace_summary import project_workspace_summary


_SLOT_LABELS = {
    AssetSlot.PORTRAIT: "立绘",
    AssetSlot.PROMO: "美宣",
    AssetSlot.TURNAROUND: "三视图",
}
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
_VIDEO_EXTENSIONS = {".mp4"}


def list_archive_targets(project_id: str, media_kind: JobKind) -> list[dict[str, Any]]:
    project = resolve_project(project_id)
    if media_kind is JobKind.VIDEO:
        return [
            {
                "kind": "video",
                "label": production.title,
                "detail": "完整视频企划",
                "production_id": production.production_id,
            }
            for production in list_productions(project.id)
        ]

    targets: list[dict[str, Any]] = []
    assignments = read_projects().assignments
    character_ids = sorted(
        character_id
        for character_id, owner_id in assignments.items()
        if owner_id == project.id and (data_root.characters_dir() / character_id).is_dir()
    )
    for character_id in character_ids:
        name = character_display_name(character_id)
        for slot, label in _SLOT_LABELS.items():
            targets.append({
                "kind": "character",
                "label": f"{name} · {label}",
                "detail": "角色资产",
                "character_id": character_id,
                "asset_slot": slot.value,
            })

    for scheme in read_schemes(project.id).schemes:
        summary = project_workspace_summary(project.id, scheme.id)
        names = {item.screen_id: item.name for item in summary.ui.screen_items}
        screens_root = scheme_screens_dir(project, scheme.id)
        directory_ids = {
            path.name for path in screens_root.iterdir() if path.is_dir()
        } if screens_root.is_dir() else set()
        for screen_id in sorted(directory_ids | names.keys()):
            targets.append({
                "kind": "ui",
                "label": f"{scheme.name} · {names.get(screen_id, screen_id)}",
                "detail": f"UI 页面 · {screen_id}",
                "ui_scheme_id": scheme.id,
                "screen_id": screen_id,
            })
    return targets


def archive_studio_output(
    job_id: str,
    source_path: str,
    project_id: str,
    target: dict[str, Any],
) -> Job:
    source_job = read_job(job_id)
    if source_job.namespace != "studio" or source_job.status is not JobStatus.DONE:
        raise ValueError("只有已完成的 Studio 记录可以归档")
    source = _source_output(source_job, source_path)
    project = resolve_project(project_id)
    output_dir, ownership = _resolve_target(project.id, source_job.kind, target)
    _validate_extension(source_job.kind, source.suffix.lower())

    with asset_output_lock(output_dir):
        destination = next_asset_path(output_dir, source.suffix)
        _copy_atomic(source, destination)
        try:
            archived = _archived_job(source_job, source, destination, ownership)
            return save_job(archived)
        except Exception:
            destination.unlink(missing_ok=True)
            raise


def _source_output(job: Job, source_path: str) -> Path:
    root = data_root.resolve_data_root().resolve()
    requested = Path(source_path)
    requested = (requested if requested.is_absolute() else root / requested).resolve()
    allowed = {
        (Path(path) if Path(path).is_absolute() else root / path).resolve()
        for path in job.output_paths
    }
    if requested not in allowed:
        raise ValueError("所选文件不属于这条 Studio 记录")
    studio_root = (root / "studio").resolve()
    expected_dir = (studio_root / job.job_id).resolve()
    if expected_dir.parent != studio_root or requested.parent != expected_dir:
        raise ValueError("Studio 记录的产物路径不在自己的输出目录")
    if not requested.is_file():
        raise FileNotFoundError(f"Studio 产物不存在: {requested}")
    return requested


def _resolve_target(
    project_id: str,
    media_kind: JobKind,
    target: dict[str, Any],
) -> tuple[Path, dict[str, Any]]:
    kind = target["kind"]
    if kind == "character":
        if media_kind is not JobKind.IMAGE:
            raise ValueError("视频不能归档到角色资产")
        character_id = target["character_id"]
        if (
            read_projects().assignments.get(character_id) != project_id
            or not (data_root.characters_dir() / character_id).is_dir()
        ):
            raise ValueError("角色不存在或不属于所选项目")
        slot = AssetSlot(target["asset_slot"])
        return (
            data_root.characters_dir() / character_id / slot.value,
            {
                "namespace": "character",
                "character_id": character_id,
                "asset_slot": slot,
                "project_id": None,
                "ui_scheme_id": None,
                "screen_id": None,
                "production_id": None,
            },
        )
    if kind == "ui":
        if media_kind is not JobKind.IMAGE:
            raise ValueError("视频不能归档到 UI 页面")
        scheme_id = target["ui_scheme_id"]
        screen_id = target["screen_id"]
        _require_ui_screen(project_id, scheme_id, screen_id)
        return (
            screen_output_dir(project_id, scheme_id, screen_id),
            {
                "namespace": "ui",
                "character_id": "",
                "project_id": project_id,
                "ui_scheme_id": scheme_id,
                "screen_id": screen_id,
                "production_id": None,
            },
        )
    if media_kind is not JobKind.VIDEO:
        raise ValueError("图片不能归档到视频企划")
    production_id = target["production_id"]
    from character_workflow.lib.video_jobs import production_dir

    production = production_dir(project_id, production_id)
    require_production(production, production_id)
    return (
        production_output_dir(project_id, production_id),
        {
            "namespace": "video",
            "character_id": "",
            "project_id": project_id,
            "ui_scheme_id": None,
            "screen_id": None,
            "production_id": production_id,
        },
    )


def _require_ui_screen(project_id: str, scheme_id: str, screen_id: str) -> None:
    project = resolve_project(project_id)
    scheme = next(
        (item for item in read_schemes(project.id).schemes if item.id == scheme_id),
        None,
    )
    if scheme is None:
        raise ValueError("UI 方案不存在或不属于所选项目")
    screens_root = scheme_screens_dir(project, scheme.id)
    directory_ids = {
        path.name for path in screens_root.iterdir() if path.is_dir()
    } if screens_root.is_dir() else set()
    planned_ids = {
        item.screen_id
        for item in project_workspace_summary(project.id, scheme.id).ui.screen_items
    }
    if screen_id not in directory_ids | planned_ids:
        raise ValueError("UI 页面不存在或不属于所选方案")


def _validate_extension(kind: JobKind, extension: str) -> None:
    allowed = _IMAGE_EXTENSIONS if kind is JobKind.IMAGE else _VIDEO_EXTENSIONS
    if extension not in allowed:
        raise ValueError(f"不支持归档这种文件格式: {extension or '无扩展名'}")


def _copy_atomic(source: Path, destination: Path) -> None:
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def _archived_job(
    source: Job,
    source_path: Path,
    destination: Path,
    ownership: dict[str, Any],
) -> Job:
    now = datetime.now(timezone.utc).isoformat()
    params = JobParams.model_validate({
        **source.params.model_dump(),
        "archived_from_job_id": source.job_id,
        "archived_from_path": str(source_path),
    })
    data = source.model_dump()
    data.update({
        "job_id": new_job_id(),
        "submitted_at": now,
        "completed_at": now,
        "params": params,
        "output_paths": [str(destination.resolve())],
        "status": JobStatus.DONE,
        "error": None,
        "retry_of": None,
        "progress_phase": None,
        **ownership,
    })
    return Job.model_validate(data)
