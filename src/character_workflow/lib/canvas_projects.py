"""User-created canvas projects: filesystem truth, validation, and media ownership."""
from __future__ import annotations

import json
import hashlib
import re
import secrets
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from PIL import Image, UnidentifiedImageError
from pydantic import ValidationError

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_bytes, atomic_write_json
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.jobs import read_job
from character_workflow.lib.schemas import (
    CanvasNode,
    CanvasAudioNode,
    CanvasDerivationConnection,
    CanvasDocument,
    CanvasImageNode,
    CanvasMediaVersion,
    CanvasProject,
    CanvasProjectCover,
    CanvasProjectSummary,
    CanvasTextNode,
    CanvasTextVersion,
    CanvasUploadOrigin,
    CanvasVideoNode,
    JobParams,
    canvas_allowed_draft_params,
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
    ".flac": "audio/flac",
    ".opus": "audio/ogg",
    ".pcm": "audio/pcm",
}


class CanvasMediaReplaceError(Exception):
    """Expected, user-facing rejection from the media replacement command."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class CanvasDocumentError(ValueError):
    """预期内的、给画师看的拒绝：提交上来的画布内容不合规。

    继承 `ValueError` 是刻意的：库里和路由里已有多处 `except ValueError`（项目列表扫描靠它跳过
    坏项目），继承下来行为一律不变，只是 detail 从英文断言变成中文 `{code, message}`——
    与同批路径的 `CanvasRunCommandError` / `CanvasMediaReplaceError` 一个形状。
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class CanvasStorageError(CanvasDocumentError):
    """画布存档文件本身不见了或坏了 —— 服务端数据完整性故障。

    单独分出来只为一件事：它**不能**被翻成 409。409 的含义是「资源被别处改过了，刷新后重试」，
    而对着一个不存在的 canvas.json 重试永远不会成功；前端的 409 文案正好写着「刷新后重试」，
    画师会照着刷一整天。这类一律 500，让人去看服务端日志和数据目录。
    """


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


def canvas_project_lock_path(project_id: str) -> Path:
    """画布项目的自动保存锁。**不能放进项目目录里。**

    `file_lock` 在整个临界区里一直持着这个文件的句柄，而 `delete_canvas_project` 要在同一个
    临界区里把项目目录整体 rename 到删除事务目录下。Windows 不允许 rename 一个内部还有打开
    句柄的目录：锁文件放在项目目录里，删项目就是 PermissionError WinError 5。POSIX 上 rename
    带着打开的文件一起走，没事——所以这个 bug 只有 Windows 会犯，而删项目路由在此之前没有
    任何测试覆盖。放 `.runtime/locks/` 下，与 `canvas_agent_sessions_lock_path` 一致。

    这个路径原来在四个模块里各写了一份（canvas_projects / canvas_packages /
    canvas_media_operations / canvas_runs），跨进程互斥全靠四份拷贝恰好一致；现在只有这一处。
    """
    canvas_project_dir(project_id)  # 只为校验 project_id 与项目存在，与 agent sessions 锁同款
    return data_root.runtime_dir() / "locks" / f"canvas-project-{project_id}.lock"


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
    (target / "agent" / "sessions").mkdir(parents=True)
    atomic_write_json(target / "project.json", project.model_dump(mode="json"))
    return project


def read_canvas_project(project_id: str) -> CanvasProject:
    return CanvasProject.model_validate_json(_project_path(project_id).read_text(encoding="utf-8"))


def rename_canvas_project(project_id: str, name: str) -> CanvasProject:
    with file_lock(canvas_project_lock_path(project_id)):
        project = read_canvas_project(project_id)
        updated = project.model_copy(update={"name": name, "updated_at": _now()})
        atomic_write_json(_project_path(project_id), updated.model_dump(mode="json"))
        return updated


def _read_canvas_document_unlocked(project_id: str) -> CanvasDocument:
    path = _document_path(project_id)
    if not path.exists():
        raise CanvasStorageError(
            "canvas_document_missing",
            "这个画布的存档文件（canvas.json）不见了，服务端读不出内容。"
            "请检查数据目录后再打开——反复刷新不会让它回来。",
        )
    document = CanvasDocument.model_validate_json(path.read_text(encoding="utf-8"))
    if document.project_id != project_id:
        raise CanvasStorageError(
            "canvas_document_project_mismatch",
            "这个画布的存档文件记着另一个项目的 ID，服务端拒绝按当前项目读取。请检查数据目录。",
        )
    return document


def _recover_canvas_transactions_unlocked(project_id: str) -> None:
    from character_workflow.lib.canvas_runs import recover_canvas_transactions_unlocked
    from character_workflow.lib.canvas_media_operations import (
        recover_canvas_media_operations_unlocked,
    )

    recover_canvas_transactions_unlocked(project_id)
    recover_canvas_media_operations_unlocked(project_id)


def read_canvas_document(project_id: str) -> CanvasDocument:
    with file_lock(canvas_project_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        return _read_canvas_document_unlocked(project_id)


def _draft_sanitized_nodes(nodes: list[CanvasNode]) -> list[CanvasNode]:
    """Strip params no browser may submit from every Draft on the submitted document.

    第二道闸。第一道在 canvas_runs._normalized_params（冻结 Snapshot 时）。两道都要：写入侧保证
    磁盘上不留服务端独占字段，冻结侧保证即使磁盘上有历史残留也进不了 job.params。
    """
    sanitized: list[CanvasNode] = []
    for node in nodes:
        data = node.data
        for field in ("generation_draft", "draft"):
            draft = getattr(data, field, None)
            if draft is None:
                continue
            allowed = JobParams(**canvas_allowed_draft_params(draft.mode, draft.params))
            data = data.model_copy(update={field: draft.model_copy(update={"params": allowed})})
        sanitized.append(node if data is node.data else node.model_copy(update={"data": data}))
    return sanitized


def _normalized_web_document(
    current: CanvasDocument,
    submitted: CanvasDocument,
    timestamp: str,
) -> CanvasDocument:
    if submitted.project_id != current.project_id:
        raise CanvasDocumentError(
            "canvas_document_project_mismatch",
            "提交的画布内容属于另一个项目，没有保存。",
        )
    if submitted.revision != current.revision:
        raise RuntimeError(f"revision_conflict:{current.revision}")

    from character_workflow.lib.canvas_batches import assert_batch_document_change

    assert_batch_document_change(current, submitted)

    versions = dict(submitted.content_versions)
    for version_id, existing in current.content_versions.items():
        if versions.get(version_id) != existing:
            raise CanvasDocumentError(
                "canvas_version_immutable",
                "已存在的内容版本不可改动，这次保存动到了历史版本，没有保存。",
            )
    for version_id, candidate in list(versions.items()):
        if version_id in current.content_versions:
            continue
        if candidate.kind != "text" or candidate.origin.kind != "user_edit":
            raise CanvasDocumentError(
                "canvas_version_not_user_text",
                "保存只能新建手动编辑的文本版本；生成产物由服务端写入，没有保存。",
            )
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
        if not (
            _is_proven_local_tool_history_restore(current, submitted, edge)
            or _is_proven_generation_history_restore(current, submitted, edge)
        ):
            raise CanvasDocumentError(
                "canvas_derivation_readonly",
                "派生连线由服务端在生成时写入，保存请求不能新建或改动它，没有保存。",
            )

    return submitted.model_copy(update={
        "revision": current.revision + 1,
        "updated_at": timestamp,
        "content_versions": versions,
        "nodes": _draft_sanitized_nodes(submitted.nodes),
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


def _is_proven_generation_history_restore(
    current: CanvasDocument,
    submitted: CanvasDocument,
    edge: CanvasDerivationConnection,
) -> bool:
    if edge.origin.kind != "generation_run":
        return False
    target = next((node for node in submitted.nodes if node.id == edge.target_node_id), None)
    if not isinstance(target, (CanvasTextNode, CanvasImageNode, CanvasVideoNode, CanvasAudioNode)):
        return False
    target_version_id = target.data.current_version_id
    target_version = current.content_versions.get(target_version_id or "")
    if not isinstance(target_version, (CanvasTextVersion, CanvasMediaVersion)):
        return False
    origin = target_version.origin
    if origin.kind != "job_output":
        return False
    try:
        job = read_job(origin.job_id)
    except (FileNotFoundError, json.JSONDecodeError, ValidationError):
        return False
    run = job.canvas_run
    if (
        job.namespace != "canvas"
        or job.canvas_project_id != current.project_id
        or run is None
        or run.run_id != edge.origin.run_id
        or run.snapshot.surface_node_id != edge.source_node_id
        or run.result_node_id != edge.target_node_id
    ):
        return False
    return any(
        candidate.status == "succeeded"
        and candidate.candidate_id == origin.candidate_id
        and candidate.version_id == target_version_id
        for candidate in run.candidates
    )


def save_canvas_document(
    project_id: str,
    document: CanvasDocument,
    expected_revision: int,
) -> CanvasDocument:
    with file_lock(canvas_project_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        project = read_canvas_project(project_id)
        current = _read_canvas_document_unlocked(project_id)
        if expected_revision != document.revision:
            raise CanvasDocumentError(
                "canvas_if_match_mismatch",
                "If-Match 的 revision 和提交内容里的 revision 不一致，没有保存。",
            )
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
    with file_lock(canvas_project_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        project = read_canvas_project(project_id)
        current = _read_canvas_document_unlocked(project_id)
        if current.revision != expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        timestamp = _now()
        version, target = _new_upload_version(project_id, ext, body, media_kind, timestamp)
        updated = current.model_copy(update={
            "revision": current.revision + 1,
            "updated_at": timestamp,
            "content_versions": {**current.content_versions, version.version_id: version},
        })
        _commit_canvas_upload(project_id, project, updated, target, body, timestamp)
        return version, updated, _display_filename(raw_name)


def replace_canvas_node_media(
    project_id: str,
    node_id: str,
    raw_name: str,
    ext: str,
    body: bytes,
    media_kind: str,
    expected_revision: int,
) -> tuple[CanvasMediaVersion, CanvasDocument, str]:
    """Create an immutable upload version and point one same-kind media node at it."""
    with file_lock(canvas_project_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        project = read_canvas_project(project_id)
        current = _read_canvas_document_unlocked(project_id)
        if current.revision != expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")

        node = next((candidate for candidate in current.nodes if candidate.id == node_id), None)
        if not isinstance(node, (CanvasImageNode, CanvasVideoNode, CanvasAudioNode)):
            raise CanvasMediaReplaceError(
                "canvas_media_node_missing",
                "找不到可替换的媒体节点。",
            )
        current_version_id = node.data.current_version_id
        current_version = (
            current.content_versions.get(current_version_id) if current_version_id else None
        )
        if current_version_id and not isinstance(current_version, CanvasMediaVersion):
            raise CanvasMediaReplaceError(
                "canvas_media_node_missing",
                "这个节点引用的媒体内容不存在。",
            )
        if (
            isinstance(current_version, CanvasMediaVersion)
            and current_version.kind != node.type
        ) or media_kind != node.type:
            raise CanvasMediaReplaceError(
                "canvas_media_replace_kind_mismatch",
                "上传文件必须与节点的媒体类型一致。",
            )

        timestamp = _now()
        try:
            version, target = _new_upload_version(
                project_id, ext, body, media_kind, timestamp
            )
        except ValueError as error:
            raise CanvasMediaReplaceError(
                "canvas_media_decode_failed",
                "文件内容与扩展名不匹配，或媒体格式无法识别。",
            ) from error

        replaced_node = node.model_copy(update={
            "data": node.data.model_copy(update={"current_version_id": version.version_id}),
        })
        updated = current.model_copy(update={
            "revision": current.revision + 1,
            "updated_at": timestamp,
            "nodes": [replaced_node if candidate.id == node_id else candidate for candidate in current.nodes],
            "content_versions": {**current.content_versions, version.version_id: version},
        })
        _commit_canvas_upload(project_id, project, updated, target, body, timestamp)
        return version, updated, _display_filename(raw_name)


def _new_upload_version(
    project_id: str,
    ext: str,
    body: bytes,
    media_kind: str,
    timestamp: str,
) -> tuple[CanvasMediaVersion, Path]:
    upload_id = secrets.token_hex(16)
    target = canvas_project_dir(project_id) / "uploads" / f"{upload_id}{ext}"
    detected_mime = _sniff_media_mime(body)
    if detected_mime is None or detected_mime != _MEDIA_MIME[ext]:
        raise CanvasDocumentError(
            "canvas_upload_ext_mismatch",
            "文件的实际内容和扩展名不一致（按魔术字节判定），没有上传。",
        )
    width: int | None = None
    height: int | None = None
    if media_kind == "image":
        width, height = _display_image_dimensions(body)
    version = CanvasMediaVersion(
        version_id=f"version-{secrets.token_hex(12)}",
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
    return version, target


def _commit_canvas_upload(
    project_id: str,
    project: CanvasProject,
    document: CanvasDocument,
    target: Path,
    body: bytes,
    timestamp: str,
) -> None:
    """Commit upload bytes and metadata before the canvas document reference."""
    try:
        atomic_write_bytes(target, body)
        atomic_write_json(
            _project_path(project_id),
            project.model_copy(update={"updated_at": timestamp}).model_dump(mode="json"),
        )
        # canvas.json is the command commit point; referenced bytes and metadata land first.
        atomic_write_json(_document_path(project_id), document.model_dump(mode="json"))
    except BaseException:
        target.unlink(missing_ok=True)
        raise


def _display_image_dimensions(body: bytes) -> tuple[int, int]:
    """Read the browser-visible size, including EXIF rotations, without rewriting upload bytes."""
    try:
        with Image.open(BytesIO(body)) as image:
            width, height = image.size
            orientation = image.getexif().get(274, 1)
    except (OSError, UnidentifiedImageError, ValueError) as error:
        raise CanvasDocumentError(
            "canvas_image_decode_failed",
            "这个文件不是能识别的图片格式，或者图片已经损坏。",
        ) from error
    if orientation in {5, 6, 7, 8}:
        width, height = height, width
    if width <= 0 or height <= 0:
        raise CanvasDocumentError(
            "canvas_image_size_invalid",
            "读不出有效的图片尺寸（宽或高为 0）。",
        )
    return width, height


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


def _resolve_canvas_media_version(
    project_id: str,
    version: CanvasMediaVersion,
) -> tuple[Path, CanvasMediaVersion]:
    if version.kind == "text":
        raise FileNotFoundError(version.version_id)
    target = _path_for_media(project_id, version.path)
    project_dir = canvas_project_dir(project_id).resolve()
    uploads = (project_dir / "uploads").resolve()
    outputs = (project_dir / "outputs").resolve()
    derived = (project_dir / "derived").resolve()
    if target.is_relative_to(uploads):
        if not target.is_file():
            raise FileNotFoundError(version.version_id)
        return target, version
    if target.is_relative_to(derived) and version.origin.kind == "local_tool":
        if not target.is_file():
            raise FileNotFoundError(version.version_id)
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
        raise FileNotFoundError(version.version_id)
    return target, version


def resolve_canvas_media(project_id: str, version_id: str) -> tuple[Path, CanvasMediaVersion]:
    document = read_canvas_document(project_id)
    version = document.content_versions.get(version_id)
    if version is None:
        if _version_belongs_to_other_canvas(project_id, version_id):
            raise PermissionError("canvas media version belongs to another project")
        raise FileNotFoundError(version_id)
    return _resolve_canvas_media_version(project_id, version)


def canvas_media_response_metadata(version: CanvasMediaVersion) -> tuple[str, str]:
    suffix = Path(version.path).suffix.lower()
    media_type = _MEDIA_MIME.get(suffix)
    if media_type is None or not media_type.startswith(f"{version.kind}/"):
        raise PermissionError("canvas media version has an invalid media type")
    stem = re.sub(r"[^a-zA-Z0-9._-]+", "-", version.version_id).strip(".-")[:96]
    return media_type, f"{stem or 'canvas-media'}{suffix}"


def _cover_for_project(
    project_id: str,
    document: CanvasDocument,
) -> CanvasProjectCover | None:
    for node in reversed(document.nodes):
        if node.type != "image" or node.data.current_version_id is None:
            continue
        version = document.content_versions.get(node.data.current_version_id)
        if version is None or version.kind != "image":
            continue
        try:
            target, _version = _resolve_canvas_media_version(project_id, version)
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
        project_id = path.parent.name
        try:
            with file_lock(canvas_project_lock_path(project_id)):
                _recover_canvas_transactions_unlocked(project_id)
                project = CanvasProject.model_validate_json(path.read_text(encoding="utf-8"))
                if project.project_id != project_id:
                    # 故意留英文裸 ValueError：这条不给用户看，它是下面那个 except 的
                    # 「跳过这个坏项目」信号，列表接口不能因为一个坏目录整体失败。
                    raise ValueError("canvas project_id does not match its directory")
                document = _read_canvas_document_unlocked(project_id)
                projects.append(
                    CanvasProjectSummary(
                        **project.model_dump(),
                        cover=_cover_for_project(project_id, document),
                        node_count=len(document.nodes),
                        connection_count=len(document.connections),
                    )
                )
        except (OSError, RuntimeError, ValueError, ValidationError, json.JSONDecodeError, KeyError):
            continue
    return sorted(projects, key=lambda item: (item.updated_at, item.project_id), reverse=True)


def list_canvas_project_options() -> list[CanvasProject]:
    """List lightweight project switcher rows without parsing every canvas document."""
    root = canvas_projects_root()
    if not root.exists():
        return []
    projects: list[CanvasProject] = []
    for path in root.glob("*/project.json"):
        project_id = path.parent.name
        try:
            with file_lock(canvas_project_lock_path(project_id)):
                _recover_canvas_transactions_unlocked(project_id)
                project = CanvasProject.model_validate_json(path.read_text(encoding="utf-8"))
                if project.project_id != project_id:
                    # 故意留英文裸 ValueError：这条不给用户看，它是下面那个 except 的
                    # 「跳过这个坏项目」信号，列表接口不能因为一个坏目录整体失败。
                    raise ValueError("canvas project_id does not match its directory")
                projects.append(project)
        except (OSError, RuntimeError, ValueError, ValidationError, json.JSONDecodeError, KeyError):
            continue
    return sorted(projects, key=lambda item: (item.updated_at, item.project_id), reverse=True)
