"""User-created canvas projects: filesystem truth, validation, and media ownership."""
from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_bytes, atomic_write_json
from character_workflow.lib.jobs import list_jobs, read_job
from character_workflow.lib.schemas import (
    CanvasDocument,
    CanvasGenerationNode,
    CanvasProject,
    CanvasProjectCover,
    CanvasProjectSummary,
    CanvasResourceNode,
    JobStatus,
)


_PROJECT_ID = re.compile(r"^canvas-[a-z0-9-]{8,64}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def canvas_projects_root() -> Path:
    return data_root.canvases_dir()


def _project_dir_unchecked(project_id: str) -> Path:
    if not _PROJECT_ID.fullmatch(project_id):
        raise KeyError(project_id)
    root = canvas_projects_root().resolve()
    target = (root / project_id).resolve()
    if target.parent != root:
        raise KeyError(project_id)
    return target


def canvas_project_dir(project_id: str) -> Path:
    target = _project_dir_unchecked(project_id)
    if not (target / "project.json").is_file():
        raise KeyError(project_id)
    return target


def _project_path(project_id: str) -> Path:
    return canvas_project_dir(project_id) / "project.json"


def _document_path(project_id: str) -> Path:
    return canvas_project_dir(project_id) / "canvas.json"


def create_canvas_project(name: str) -> CanvasProject:
    root = canvas_projects_root()
    root.mkdir(parents=True, exist_ok=True)
    for _attempt in range(10):
        project_id = f"canvas-{secrets.token_hex(6)}"
        target = root / project_id
        try:
            target.mkdir()
            break
        except FileExistsError:
            continue
    else:  # pragma: no cover - cryptographic collision guard
        raise RuntimeError("failed to allocate a unique canvas project id")

    timestamp = _now()
    project = CanvasProject(
        project_id=project_id,
        name=name,
        created_at=timestamp,
        updated_at=timestamp,
    )
    document = CanvasDocument(project_id=project_id, updated_at=timestamp)
    # project.json 是项目存在标记，最后写；中途失败的半成品目录不会被列表或读取识别。
    atomic_write_json(target / "canvas.json", document.model_dump(mode="json"))
    (target / "uploads").mkdir()
    (target / "outputs").mkdir()
    atomic_write_json(target / "project.json", project.model_dump(mode="json"))
    return project


def read_canvas_project(project_id: str) -> CanvasProject:
    return CanvasProject.model_validate_json(_project_path(project_id).read_text(encoding="utf-8"))


def rename_canvas_project(project_id: str, name: str) -> CanvasProject:
    project = read_canvas_project(project_id)
    updated = project.model_copy(update={"name": name, "updated_at": _now()})
    atomic_write_json(_project_path(project_id), updated.model_dump(mode="json"))
    return updated


def read_canvas_document(project_id: str) -> CanvasDocument:
    path = _document_path(project_id)
    if not path.exists():
        raise ValueError("canvas document is missing")
    document = CanvasDocument.model_validate_json(path.read_text(encoding="utf-8"))
    if document.project_id != project_id:
        raise ValueError("canvas document project_id does not match its directory")
    return document


def _validate_resource_paths(project_id: str, document: CanvasDocument) -> None:
    uploads = (canvas_project_dir(project_id) / "uploads").resolve()
    root = data_root.resolve_data_root()
    for node in document.nodes:
        if not isinstance(node, CanvasResourceNode):
            continue
        raw = Path(node.data.path)
        target = (raw if raw.is_absolute() else root / raw).resolve()
        if not target.is_relative_to(uploads):
            raise ValueError(f"resource node path is outside canvas uploads: {node.id}")


def save_canvas_document(project_id: str, document: CanvasDocument) -> CanvasDocument:
    project = read_canvas_project(project_id)
    timestamp = _now()
    updated = document.model_copy(update={"project_id": project_id, "updated_at": timestamp})
    _validate_resource_paths(project_id, updated)
    atomic_write_json(_document_path(project_id), updated.model_dump(mode="json"))
    touched = project.model_copy(update={"updated_at": timestamp})
    atomic_write_json(_project_path(project_id), touched.model_dump(mode="json"))
    return updated


def canvas_output_dir(project_id: str, job_id: str) -> Path:
    target = canvas_project_dir(project_id) / "outputs" / job_id
    target.mkdir(parents=True, exist_ok=True)
    return target


def save_canvas_upload(project_id: str, raw_name: str, ext: str, body: bytes) -> tuple[str, str]:
    target = canvas_project_dir(project_id) / "uploads" / f"{secrets.token_hex(16)}{ext}"
    atomic_write_bytes(target, body)
    relative = target.relative_to(data_root.resolve_data_root()).as_posix()
    return relative, raw_name


def _path_for_media(project_id: str, path: str) -> Path:
    root = data_root.resolve_data_root()
    raw = Path(path)
    target = (raw if raw.is_absolute() else root / raw).resolve()
    project_dir = canvas_project_dir(project_id).resolve()
    if not target.is_relative_to(project_dir):
        raise PermissionError("media path is outside this canvas project")
    return target


def resolve_canvas_media(project_id: str, path: str, job_id: str | None = None) -> Path:
    target = _path_for_media(project_id, path)
    project_dir = canvas_project_dir(project_id).resolve()
    uploads = (project_dir / "uploads").resolve()
    outputs = (project_dir / "outputs").resolve()
    if target.is_relative_to(uploads):
        if not target.is_file():
            raise FileNotFoundError(path)
        return target
    if not target.is_relative_to(outputs) or job_id is None:
        raise PermissionError("canvas output requires its job id")
    try:
        job = read_job(job_id)
    except FileNotFoundError as error:
        raise FileNotFoundError(job_id) from error
    if job.namespace != "canvas" or job.canvas_project_id != project_id:
        raise PermissionError("job does not belong to this canvas project")
    normalized = {
        str((Path(item) if Path(item).is_absolute() else data_root.resolve_data_root() / item).resolve())
        for item in job.output_paths
    }
    if str(target) not in normalized:
        raise PermissionError("media path is not registered on this canvas job")
    if not target.is_file():
        raise FileNotFoundError(path)
    return target


def validate_canvas_reference_paths(project_id: str, paths: list[str]) -> None:
    """Reject references that are not owned by this canvas project."""
    project_dir = canvas_project_dir(project_id).resolve()
    uploads = (project_dir / "uploads").resolve()
    outputs = (project_dir / "outputs").resolve()
    registered_outputs: set[str] = set()
    for job in list_jobs():
        if job.namespace != "canvas" or job.canvas_project_id != project_id:
            continue
        registered_outputs.update(
            str((Path(item) if Path(item).is_absolute() else data_root.resolve_data_root() / item).resolve())
            for item in job.output_paths
        )
    for path in paths:
        target = _path_for_media(project_id, path)
        if target.is_relative_to(uploads) and target.is_file():
            continue
        if target.is_relative_to(outputs) and str(target) in registered_outputs and target.is_file():
            continue
        raise PermissionError("canvas reference is not owned by this project")


def _cover_for_project(project_id: str) -> CanvasProjectCover | None:
    try:
        document = read_canvas_document(project_id)
    except (OSError, ValueError, ValidationError, json.JSONDecodeError):
        return None
    for node in reversed(document.nodes):
        if isinstance(node, CanvasResourceNode) and node.data.media_kind == "image":
            try:
                target = _path_for_media(project_id, node.data.path)
            except (KeyError, PermissionError):
                continue
            if target.is_file():
                return CanvasProjectCover(path=node.data.path)
        if not isinstance(node, CanvasGenerationNode) or node.data.media_kind != "image":
            continue
        job_id = node.data.active_job_id or (node.data.job_ids[-1] if node.data.job_ids else None)
        if job_id is None:
            continue
        try:
            job = read_job(job_id)
        except (OSError, ValidationError, json.JSONDecodeError):
            continue
        if (
            job.namespace != "canvas"
            or job.canvas_project_id != project_id
            or job.status is not JobStatus.DONE
            or not job.output_paths
        ):
            continue
        index = node.data.selected_output_index or 0
        if 0 <= index < len(job.output_paths):
            return CanvasProjectCover(path=job.output_paths[index], job_id=job_id)
    return None


def list_canvas_projects() -> list[CanvasProjectSummary]:
    root = canvas_projects_root()
    if not root.exists():
        return []
    projects: list[CanvasProjectSummary] = []
    for path in root.glob("*/project.json"):
        try:
            project = CanvasProject.model_validate_json(path.read_text(encoding="utf-8"))
            projects.append(
                CanvasProjectSummary(**project.model_dump(), cover=_cover_for_project(project.project_id))
            )
        except (OSError, ValidationError, json.JSONDecodeError, KeyError):
            continue
    return sorted(projects, key=lambda item: (item.updated_at, item.project_id), reverse=True)
