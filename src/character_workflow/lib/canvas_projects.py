"""User-created canvas projects: filesystem truth, validation, and media ownership."""
from __future__ import annotations

import json
import hashlib
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_bytes, atomic_write_json
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.job_runner import image_dimensions_from_bytes
from character_workflow.lib.jobs import read_job
from character_workflow.lib.schemas import (
    CanvasDerivationConnection,
    CanvasDocument,
    CanvasImageNode,
    CanvasMediaVersion,
    CanvasLibraryAsset,
    CanvasPrompt,
    CanvasProject,
    CanvasProjectCover,
    CanvasProjectSummary,
    CanvasUploadOrigin,
    RevisionedSidecar,
)


_PROJECT_ID = re.compile(r"^canvas-[a-z0-9-]{8,64}$")
_MEDIA_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
}


def _sniff_media_mime(body: bytes) -> str | None:
    if body.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if body.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(body) >= 12 and body.startswith(b"RIFF") and body[8:12] == b"WEBP":
        return "image/webp"
    if len(body) >= 12 and body.startswith(b"RIFF") and body[8:12] == b"WAVE":
        return "audio/wav"
    if body.startswith(b"\x1aE\xdf\xa3") and b"webm" in body[:4096].lower():
        return "video/webm"
    if body.startswith(b"ID3") or (
        len(body) >= 2 and body[0] == 0xFF and body[1] & 0xE0 == 0xE0 and body[1] & 0x06
    ):
        return "audio/mpeg"
    if len(body) >= 2 and body[0] == 0xFF and body[1] & 0xF6 == 0xF0:
        return "audio/aac"
    if len(body) >= 12 and body[4:8] == b"ftyp":
        major_brand = body[8:12]
        has_video_track = b"vide" in body
        has_audio_track = b"soun" in body
        if has_video_track:
            return "video/quicktime" if major_brand == b"qt  " else "video/mp4"
        if has_audio_track:
            return "audio/mp4"
    return None


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


def _canvas_lock_path(project_id: str) -> Path:
    return canvas_project_dir(project_id) / ".canvas.lock"


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
        schema_version=2,
        project_id=project_id,
        name=name,
        created_at=timestamp,
        updated_at=timestamp,
    )
    document = CanvasDocument(project_id=project_id, revision=0, updated_at=timestamp)
    # project.json 是项目存在标记，最后写；中途失败的半成品目录不会被列表或读取识别。
    atomic_write_json(target / "canvas.json", document.model_dump(mode="json"))
    (target / "uploads").mkdir()
    (target / "outputs").mkdir()
    (target / "derived").mkdir()
    (target / "library").mkdir()
    assets = RevisionedSidecar[CanvasLibraryAsset](updated_at=timestamp)
    prompts = RevisionedSidecar[CanvasPrompt](updated_at=timestamp)
    atomic_write_json(target / "library" / "assets.json", assets.model_dump(mode="json"))
    atomic_write_json(target / "library" / "prompts.json", prompts.model_dump(mode="json"))
    atomic_write_json(target / "project.json", project.model_dump(mode="json"))
    return project


def read_canvas_project(project_id: str) -> CanvasProject:
    return CanvasProject.model_validate_json(_project_path(project_id).read_text(encoding="utf-8"))


def rename_canvas_project(project_id: str, name: str) -> CanvasProject:
    with file_lock(_canvas_lock_path(project_id)):
        project = read_canvas_project(project_id)
        updated = project.model_copy(update={"name": name, "updated_at": _now()})
        atomic_write_json(_project_path(project_id), updated.model_dump(mode="json"))
        return updated


def _read_canvas_document_unlocked(project_id: str) -> CanvasDocument:
    path = _document_path(project_id)
    if not path.exists():
        raise ValueError("canvas document is missing")
    document = CanvasDocument.model_validate_json(path.read_text(encoding="utf-8"))
    if document.project_id != project_id:
        raise ValueError("canvas document project_id does not match its directory")
    return document


def _recover_canvas_transactions_unlocked(project_id: str) -> None:
    from character_workflow.lib.canvas_runs import recover_canvas_transactions_unlocked
    from character_workflow.lib.canvas_media_operations import (
        recover_canvas_media_operations_unlocked,
    )

    recover_canvas_transactions_unlocked(project_id)
    recover_canvas_media_operations_unlocked(project_id)


def read_canvas_document(project_id: str) -> CanvasDocument:
    with file_lock(_canvas_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        return _read_canvas_document_unlocked(project_id)


def _normalized_web_document(
    current: CanvasDocument,
    submitted: CanvasDocument,
    timestamp: str,
) -> CanvasDocument:
    if submitted.project_id != current.project_id:
        raise ValueError("canvas document project_id does not match its directory")
    if submitted.revision != current.revision:
        raise RuntimeError(f"revision_conflict:{current.revision}")

    versions = dict(submitted.content_versions)
    for version_id, existing in current.content_versions.items():
        if versions.get(version_id) != existing:
            raise ValueError("existing canvas content versions are immutable")
    for version_id, candidate in list(versions.items()):
        if version_id in current.content_versions:
            continue
        if candidate.kind != "text" or candidate.origin.kind != "user_edit":
            raise ValueError("document save can only create user-edited text versions")
        versions[version_id] = candidate.model_copy(
            update={
                "created_at": timestamp,
                "sha256": hashlib.sha256(candidate.text.encode("utf-8")).hexdigest(),
            }
        )

    current_derivations = {
        edge.id: edge for edge in current.connections if edge.role == "derivation"
    }
    submitted_derivations = {
        edge.id: edge for edge in submitted.connections if edge.role == "derivation"
    }
    for edge_id, edge in submitted_derivations.items():
        if current_derivations.get(edge_id) == edge:
            continue
        if not _is_proven_local_tool_history_restore(current, submitted, edge):
            raise ValueError("document save cannot create or modify derivation connections")

    return submitted.model_copy(update={
        "revision": current.revision + 1,
        "updated_at": timestamp,
        "content_versions": versions,
    })


def _is_proven_local_tool_history_restore(
    current: CanvasDocument,
    submitted: CanvasDocument,
    edge: CanvasDerivationConnection,
) -> bool:
    """Allow redo to restore an exact, already-committed local-tool derivation.

    The browser still cannot mint provenance: the target version and its immutable origin must
    already exist in the server document, and both submitted nodes must point at the exact source
    and result versions recorded by that origin.
    """
    if edge.origin.kind != "local_tool":
        return False
    source = next((node for node in submitted.nodes if node.id == edge.source_node_id), None)
    target = next((node for node in submitted.nodes if node.id == edge.target_node_id), None)
    if not isinstance(source, CanvasImageNode) or not isinstance(target, CanvasImageNode):
        return False
    target_version_id = target.data.current_version_id
    source_version_id = source.data.current_version_id
    if not target_version_id or not source_version_id:
        return False
    target_version = current.content_versions.get(target_version_id)
    if not isinstance(target_version, CanvasMediaVersion):
        return False
    origin = target_version.origin
    return (
        origin.kind == "local_tool"
        and origin.operation_id == edge.origin.operation_id
        and origin.source_version_id == source_version_id
    )


def save_canvas_document(
    project_id: str,
    document: CanvasDocument,
    expected_revision: int,
) -> CanvasDocument:
    with file_lock(_canvas_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        project = read_canvas_project(project_id)
        current = _read_canvas_document_unlocked(project_id)
        if expected_revision != document.revision:
            raise ValueError("If-Match must equal the submitted document revision")
        timestamp = _now()
        updated = _normalized_web_document(current, document, timestamp)
        touched = project.model_copy(update={"updated_at": timestamp})
        atomic_write_json(_project_path(project_id), touched.model_dump(mode="json"))
        atomic_write_json(_document_path(project_id), updated.model_dump(mode="json"))
        return updated


def canvas_output_dir(project_id: str, job_id: str) -> Path:
    target = canvas_project_dir(project_id) / "outputs" / job_id
    target.mkdir(parents=True, exist_ok=True)
    return target


def save_canvas_upload(
    project_id: str,
    raw_name: str,
    ext: str,
    body: bytes,
    media_kind: str,
    expected_revision: int,
) -> tuple[CanvasMediaVersion, CanvasDocument, str]:
    with file_lock(_canvas_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        project = read_canvas_project(project_id)
        current = _read_canvas_document_unlocked(project_id)
        if current.revision != expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        upload_id = secrets.token_hex(16)
        version_id = f"version-{secrets.token_hex(12)}"
        target = canvas_project_dir(project_id) / "uploads" / f"{upload_id}{ext}"
        timestamp = _now()
        detected_mime = _sniff_media_mime(body)
        if detected_mime is None or detected_mime != _MEDIA_MIME[ext]:
            raise ValueError("canvas upload content does not match its file extension")
        width: int | None = None
        height: int | None = None
        if media_kind == "image":
            dimensions = image_dimensions_from_bytes(body)
            if dimensions is None:
                raise ValueError("canvas image bytes do not match a supported image format")
            width, height = dimensions
        version = CanvasMediaVersion(
            version_id=version_id,
            created_at=timestamp,
            sha256=hashlib.sha256(body).hexdigest(),
            origin=CanvasUploadOrigin(kind="upload", upload_id=upload_id),
            kind=media_kind,
            path=target.relative_to(canvas_project_dir(project_id)).as_posix(),
            mime_type=detected_mime,
            bytes=len(body),
            width=width,
            height=height,
        )
        updated = current.model_copy(update={
            "revision": current.revision + 1,
            "updated_at": timestamp,
            "content_versions": {**current.content_versions, version_id: version},
        })
        try:
            atomic_write_bytes(target, body)
            atomic_write_json(
                _project_path(project_id),
                project.model_copy(update={"updated_at": timestamp}).model_dump(mode="json"),
            )
            # canvas.json 是命令提交点；它最后落盘，避免出现引用尚未登记文件的版本。
            atomic_write_json(_document_path(project_id), updated.model_dump(mode="json"))
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        return version, updated, _display_filename(raw_name)


def _display_filename(raw_name: str) -> str:
    filename = raw_name.replace("\\", "/").rsplit("/", 1)[-1].strip() or "upload"
    if len(filename) <= 120:
        return filename
    suffix = Path(filename).suffix
    stem_limit = max(1, 120 - len(suffix))
    return f"{filename[:-len(suffix)][:stem_limit]}{suffix}" if suffix else filename[:120]


def _path_for_media(project_id: str, path: str) -> Path:
    raw = Path(path)
    project_dir = canvas_project_dir(project_id).resolve()
    if raw.is_absolute():
        raise PermissionError("canvas media path must be project-relative")
    target = (project_dir / raw).resolve()
    if not target.is_relative_to(project_dir):
        raise PermissionError("media path is outside this canvas project")
    return target


def _version_belongs_to_other_canvas(project_id: str, version_id: str) -> bool:
    root = canvas_projects_root()
    if not root.exists():
        return False
    for project_path in root.glob("*/project.json"):
        if project_path.parent.name == project_id:
            continue
        try:
            document = CanvasDocument.model_validate_json(
                (project_path.parent / "canvas.json").read_text(encoding="utf-8")
            )
        except (OSError, ValidationError, json.JSONDecodeError):
            continue
        if version_id in document.content_versions:
            return True
    return False


def resolve_canvas_media(project_id: str, version_id: str) -> tuple[Path, CanvasMediaVersion]:
    document = read_canvas_document(project_id)
    version = document.content_versions.get(version_id)
    if version is None:
        if _version_belongs_to_other_canvas(project_id, version_id):
            raise PermissionError("canvas media version belongs to another project")
        raise FileNotFoundError(version_id)
    if version.kind == "text":
        raise FileNotFoundError(version_id)
    target = _path_for_media(project_id, version.path)
    project_dir = canvas_project_dir(project_id).resolve()
    uploads = (project_dir / "uploads").resolve()
    outputs = (project_dir / "outputs").resolve()
    derived = (project_dir / "derived").resolve()
    if target.is_relative_to(uploads):
        if not target.is_file():
            raise FileNotFoundError(version_id)
        return target, version
    if target.is_relative_to(derived) and version.origin.kind == "local_tool":
        if not target.is_file():
            raise FileNotFoundError(version_id)
        return target, version
    if not target.is_relative_to(outputs) or version.origin.kind != "job_output":
        raise PermissionError("canvas media version has an invalid owned path")
    try:
        job = read_job(version.origin.job_id)
    except FileNotFoundError as error:
        raise FileNotFoundError(version.origin.job_id) from error
    if job.namespace != "canvas" or job.canvas_project_id != project_id:
        raise PermissionError("job does not belong to this canvas project")
    normalized = {
        str((Path(item) if Path(item).is_absolute() else data_root.resolve_data_root() / item).resolve())
        for item in job.output_paths
    }
    if str(target) not in normalized:
        raise PermissionError("media path is not registered on this canvas job")
    if not target.is_file():
        raise FileNotFoundError(version_id)
    return target, version


def canvas_media_response_metadata(version: CanvasMediaVersion) -> tuple[str, str]:
    suffix = Path(version.path).suffix.lower()
    media_type = _MEDIA_MIME.get(suffix)
    if media_type is None or not media_type.startswith(f"{version.kind}/"):
        raise PermissionError("canvas media version has an invalid media type")
    stem = re.sub(r"[^a-zA-Z0-9._-]+", "-", version.version_id).strip(".-")[:96]
    return media_type, f"{stem or 'canvas-media'}{suffix}"


def _cover_for_project(project_id: str) -> CanvasProjectCover | None:
    try:
        document = read_canvas_document(project_id)
    except (OSError, ValueError, ValidationError, json.JSONDecodeError):
        return None
    for node in reversed(document.nodes):
        if node.type != "image" or node.data.current_version_id is None:
            continue
        version = document.content_versions.get(node.data.current_version_id)
        if version is None or version.kind != "image":
            continue
        try:
            target, _version = resolve_canvas_media(project_id, version.version_id)
        except (KeyError, OSError, PermissionError, ValueError):
            continue
        if target.is_file():
            return CanvasProjectCover(version_id=version.version_id)
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
