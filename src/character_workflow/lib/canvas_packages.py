"""Canvas project packages and permanent project lifecycle operations."""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import tempfile
import unicodedata
import zipfile
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.canvas_agent_sessions import canvas_agent_sessions_lock_path
from character_workflow.lib.canvas_projects import (
    _project_dir_unchecked,
    _read_canvas_document_unlocked,
    _recover_canvas_transactions_unlocked,
    canvas_project_dir,
    canvas_project_lock_path,
    canvas_projects_root,
    read_canvas_project,
)
from character_workflow.lib.canvas_thumbnails import discard_canvas_thumbnails
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.jobs import job_lock, new_job_id, read_job
from character_workflow.lib.schemas import (
    CanvasAgentSession,
    CanvasContentVersion,
    CanvasDocument,
    CanvasPluginState,
    CanvasProject,
    Job,
    JobStatus,
)


_FORMAT_VERSION = 1
_MAX_COMPRESSED_BYTES = 2 * 1024 * 1024 * 1024
_MAX_EXTRACTED_BYTES = 10 * 1024 * 1024 * 1024
_MAX_ENTRIES = 20_000
_MAX_COMPRESSION_RATIO = 100
_MAX_METADATA_BYTES = 25 * 1024 * 1024
_IMPORT_TTL = timedelta(minutes=30)
_SAFE_TOKEN = re.compile(r"^[a-z0-9-]{12,100}$")
_BLOB_PATH = re.compile(r"^blobs/sha256/([a-f0-9]{2})/([a-f0-9]{64})(\.[a-z0-9]+)$")
_EXECUTABLE_SUFFIXES = {
    ".app",
    ".bat",
    ".cmd",
    ".com",
    ".dll",
    ".dmg",
    ".exe",
    ".jar",
    ".js",
    ".msi",
    ".ps1",
    ".scr",
    ".sh",
}
_MEDIA_SUFFIXES = {
    ".aac",
    ".gif",
    ".jpeg",
    ".jpg",
    ".m4a",
    ".mov",
    ".mp3",
    ".mp4",
    ".ogg",
    ".png",
    ".wav",
    ".webm",
    ".webp",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_text() -> str:
    return _now().isoformat()


def _sha256_bytes(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class _ManifestEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    bytes: int = Field(ge=0)
    mime_type: str
    role: Literal["metadata", "blob"]


class _ManifestProject(BaseModel):
    model_config = ConfigDict(extra="forbid")
    package_project_id: str
    original_project_id: str
    entry_paths: list[str]


class _PackageManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    app: Literal["game-atelier"]
    kind: Literal["canvas-project-package"]
    format_version: Literal[1]
    package_id: str
    exported_at: str
    projects: list[_ManifestProject] = Field(min_length=1)
    entries: list[_ManifestEntry]


class CanvasPackageError(ValueError):
    """A user-facing package validation failure."""


class CanvasProjectBusyError(RuntimeError):
    """The project has an in-flight generation and cannot be moved."""


class CanvasPackageInspection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str
    package_id: str
    expires_at: str
    projects: list[CanvasProject]
    entry_count: int
    extracted_bytes: int


def _lifecycle_lock_path() -> Path:
    return data_root.runtime_dir() / "locks" / "canvas-project-lifecycle.lock"


def _package_transactions_root() -> Path:
    return data_root.runtime_dir() / "canvas-package-transactions"


def _delete_transactions_root() -> Path:
    return data_root.runtime_dir() / "canvas-delete-transactions"


def _import_claim_lock_path(token: str) -> Path:
    return data_root.runtime_dir() / "locks" / f"canvas-import-{token}.lock"


def _recover_delete_transactions_unlocked() -> None:
    root = _delete_transactions_root()
    if not root.exists():
        return
    for transaction in sorted(root.iterdir()):
        if not transaction.is_dir():
            continue
        journal_path = transaction / "transaction.json"
        if not journal_path.is_file():
            shutil.rmtree(transaction, ignore_errors=True)
            continue
        try:
            journal = json.loads(journal_path.read_text(encoding="utf-8"))
            project_id = str(journal["project_id"])
            job_ids = [str(item) for item in journal["job_ids"]]
        except (OSError, KeyError, TypeError, json.JSONDecodeError) as error:
            raise CanvasPackageError(f"删除事务记录损坏：{transaction.name}") from error
        live_project = _project_dir_unchecked(project_id)
        staged_project = transaction / "project"
        if live_project.exists() and not staged_project.exists():
            shutil.rmtree(transaction, ignore_errors=True)
            continue
        with ExitStack() as stack:
            for job_id in sorted(job_ids):
                stack.enter_context(job_lock(job_id))
            for job_id in job_ids:
                (data_root.runtime_dir() / "jobs" / f"{job_id}.json").unlink(missing_ok=True)
        shutil.rmtree(transaction, ignore_errors=True)


def _recover_import_transactions_unlocked() -> None:
    root = _package_transactions_root()
    if not root.exists():
        return
    for transaction in sorted(root.iterdir()):
        if not transaction.is_dir():
            continue
        journal_path = transaction / "transaction.json"
        if not journal_path.is_file():
            shutil.rmtree(transaction, ignore_errors=True)
            continue
        try:
            journal = json.loads(journal_path.read_text(encoding="utf-8"))
            state = journal["state"]
            project_ids = [str(item) for item in journal["project_ids"]]
            job_ids = [str(item) for item in journal["job_ids"]]
        except (OSError, KeyError, TypeError, json.JSONDecodeError) as error:
            raise CanvasPackageError(f"导入事务记录损坏：{transaction.name}") from error
        if state == "committing":
            with ExitStack() as stack:
                for project_id in sorted(project_ids):
                    project_path = _project_dir_unchecked(project_id)
                    if project_path.exists():
                        stack.enter_context(file_lock(project_path / ".canvas.lock"))
                for job_id in sorted(job_ids):
                    stack.enter_context(job_lock(job_id))
                for job_id in job_ids:
                    (data_root.runtime_dir() / "jobs" / f"{job_id}.json").unlink(missing_ok=True)
                for project_id in project_ids:
                    shutil.rmtree(_project_dir_unchecked(project_id), ignore_errors=True)
        elif state != "committed":
            raise CanvasPackageError(f"导入事务状态不合法：{transaction.name}")
        shutil.rmtree(transaction, ignore_errors=True)


def _recover_package_transactions_unlocked() -> None:
    _recover_delete_transactions_unlocked()
    _recover_import_transactions_unlocked()


def recover_canvas_package_transactions() -> None:
    """Rollback interrupted imports and finish interrupted permanent deletions."""
    with file_lock(_lifecycle_lock_path()):
        _recover_package_transactions_unlocked()


def maintain_canvas_package_lifecycle() -> None:
    """Recover abandoned package claims on startup and periodically."""
    recover_canvas_package_transactions()

    imports_root = data_root.runtime_dir() / "canvas-imports"
    claimed_imports = (
        sorted(imports_root.glob(".import-*.claimed-*")) if imports_root.exists() else []
    )
    for claimed in claimed_imports:
        try:
            inspection = json.loads((claimed / "inspection.json").read_text(encoding="utf-8"))
            token = str(inspection["token"])
        except (OSError, KeyError, TypeError, json.JSONDecodeError):
            shutil.rmtree(claimed, ignore_errors=True)
            continue
        if _SAFE_TOKEN.fullmatch(token) is None:
            shutil.rmtree(claimed, ignore_errors=True)
            continue
        with file_lock(_import_claim_lock_path(token)), file_lock(_lifecycle_lock_path()):
            if not claimed.exists():
                continue
            _recover_import_transactions_unlocked()
            try:
                claim = json.loads((claimed / "claim.json").read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                claim = {"state": "claimed", "project_ids": []}
            project_ids = [str(item) for item in claim.get("project_ids", [])]
            if (
                claim.get("state") == "imported"
                and project_ids
                and all(_project_dir_unchecked(project_id).exists() for project_id in project_ids)
            ):
                shutil.rmtree(claimed, ignore_errors=True)
                continue
            original = imports_root / token
            if _now() >= datetime.fromisoformat(inspection["expires_at"]):
                shutil.rmtree(claimed, ignore_errors=True)
            elif not original.exists():
                claimed.replace(original)
            else:
                shutil.rmtree(claimed, ignore_errors=True)

def _jobs_for_project(project_id: str) -> list[Job]:
    jobs: list[Job] = []
    jobs_root = data_root.runtime_dir() / "jobs"
    paths = sorted(jobs_root.glob("*.json")) if jobs_root.exists() else []
    for path in paths:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(raw, dict):
            continue
        if raw.get("namespace") != "canvas" or raw.get("canvas_project_id") != project_id:
            continue
        raw.pop("seed", None)
        try:
            job = Job.model_validate(raw)
        except ValidationError as error:
            raise CanvasPackageError(f"画布任务记录损坏：{path.name}") from error
        if path.stem != job.job_id:
            raise CanvasPackageError(f"画布任务文件名与 job_id 不一致：{path.name}")
        jobs.append(job)
    return sorted(jobs, key=lambda job: job.job_id)


def _assert_jobs_are_quiescent(jobs: list[Job]) -> None:
    active = [
        job.job_id for job in jobs if job.status in {JobStatus.PENDING, JobStatus.PENDING_CONFIRM}
    ]
    if active:
        raise CanvasProjectBusyError(
            f"画布仍有 {len(active)} 个生成任务在运行，请停止或等待完成后重试"
        )


def _output_versions_for_job(
    job: Job,
    document: CanvasDocument,
    *,
    origin_job_id: str | None = None,
) -> list[CanvasContentVersion]:
    if job.canvas_run is None:
        raise CanvasPackageError(f"画布任务 {job.job_id} 缺少运行快照")
    candidate_versions: list[CanvasContentVersion] = []
    for candidate in job.canvas_run.candidates:
        if candidate.version_id is None:
            continue
        version = document.content_versions.get(candidate.version_id)
        if version is None:
            raise CanvasPackageError(f"任务 {job.job_id} 的候选结果缺少内容版本")
        candidate_versions.append(version)

    result = job.params.layer_decomposition_result
    if not job.params.layer_decomposition or result is None:
        return candidate_versions

    owner_id = origin_job_id or job.job_id
    base = next(
        (
            version
            for version in candidate_versions
            if version.kind == "image" and version.origin.kind == "job_output"
        ),
        None,
    )
    layers_by_index = {
        version.origin.output_index: version
        for version in document.content_versions.values()
        if (
            version.kind == "image"
            and version.origin.kind == "layer_decomposition"
            and version.origin.job_id == owner_id
        )
    }
    ordered: list[CanvasContentVersion] = []
    for output in result.outputs:
        version = base if output.z_index == 0 else layers_by_index.get(output.output_index)
        if version is None:
            raise CanvasPackageError(
                f"任务 {job.job_id} 的图层输出 {output.output_index} 缺少内容版本"
            )
        ordered.append(version)
    return ordered


def _portable_job(job: Job, document: CanvasDocument) -> bytes:
    if job.canvas_run is None:
        raise CanvasPackageError(f"画布任务 {job.job_id} 缺少运行快照")
    versions = document.content_versions
    output_paths = [
        version.path
        for version in _output_versions_for_job(job, document)
        if version.kind != "text"
    ]

    references: dict[str, list[str]] = {"image": [], "video": [], "audio": []}
    for item in job.canvas_run.snapshot.inputs:
        version = versions.get(item.version_id)
        if version is None or version.kind != item.kind:
            raise CanvasPackageError(f"任务 {job.job_id} 的快照输入已损坏")
        if version.kind != "text":
            references[version.kind].append(version.path)
    mask_path: str | None = None
    if job.canvas_run.snapshot.mask_version_id is not None:
        mask = versions.get(job.canvas_run.snapshot.mask_version_id)
        if mask is None or mask.kind != "image" or mask.origin.kind != "user_mask":
            raise CanvasPackageError(f"任务 {job.job_id} 的遮罩版本已损坏")
        mask_path = mask.path
    params = job.params.model_copy(
        update={
            "reference_images": references["image"] or None,
            "reference_videos": references["video"] or None,
            "reference_audios": references["audio"] or None,
            "mask_image": mask_path,
        }
    )
    portable = job.model_copy(
        update={
            "params": params,
            "output_paths": output_paths,
            "source_image": None,
        }
    )
    return portable.model_dump_json(indent=2).encode("utf-8")


def _metadata_files(project_dir: Path) -> list[Path]:
    files: list[Path] = []
    project_root = project_dir.resolve()
    for pattern in ("agent/sessions/*.json", "plugins/*/state.json"):
        for path in sorted(project_dir.glob(pattern)):
            resolved = path.resolve()
            if (
                path.is_symlink()
                or not resolved.is_relative_to(project_root)
                or not resolved.is_file()
            ):
                raise CanvasPackageError(f"项目包含不允许的元数据文件：{path.name}")
            files.append(path)
    return files


def export_canvas_projects(
    project_ids: list[str],
    *,
    _project_lifecycle_locks_held: bool = False,
) -> tuple[Path, str]:
    """Create a complete, canonical package and return its temporary path and filename."""
    ordered_ids = list(dict.fromkeys(project_ids))
    if not ordered_ids:
        raise CanvasPackageError("至少选择一个画布项目")

    entries: dict[str, tuple[bytes | Path, str, Literal["metadata", "blob"]]] = {}
    project_rows: list[_ManifestProject] = []
    project_names: list[str] = []
    package_id = f"package-{secrets.token_hex(12)}"

    lifecycle_context = (
        ExitStack()
        if _project_lifecycle_locks_held
        else file_lock(_lifecycle_lock_path())
    )
    with lifecycle_context, ExitStack() as stack:
        if not _project_lifecycle_locks_held:
            for project_id in sorted(ordered_ids):
                stack.enter_context(file_lock(canvas_project_lock_path(project_id)))
            for project_id in sorted(ordered_ids):
                stack.enter_context(file_lock(canvas_agent_sessions_lock_path(project_id)))
        for project_id in ordered_ids:
            from character_workflow.lib.canvas_batches import assert_no_active_canvas_batch

            try:
                assert_no_active_canvas_batch(project_id)
            except ValueError as error:
                raise CanvasProjectBusyError(str(error)) from error
            _recover_canvas_transactions_unlocked(project_id)
            project = read_canvas_project(project_id)
            document = _read_canvas_document_unlocked(project_id)
            jobs = _jobs_for_project(project_id)
            _assert_jobs_are_quiescent(jobs)
            for job in jobs:
                stack.enter_context(job_lock(job.job_id))
            jobs = [read_job(job.job_id) for job in jobs]

            package_project_id = f"project-{secrets.token_hex(8)}"
            prefix = f"projects/{package_project_id}"
            paths: list[str] = []
            metadata = {
                f"{prefix}/project.json": project.model_dump_json(indent=2).encode("utf-8"),
                f"{prefix}/canvas.json": document.model_dump_json(indent=2).encode("utf-8"),
            }
            project_dir = canvas_project_dir(project_id)
            for job in jobs:
                metadata[f"{prefix}/jobs/{job.job_id}.json"] = _portable_job(job, document)
            for source in _metadata_files(project_dir):
                relative = source.relative_to(project_dir).as_posix()
                metadata[f"{prefix}/{relative}"] = source.read_bytes()
            for path, body in metadata.items():
                try:
                    payload = json.loads(body)
                except json.JSONDecodeError as error:
                    raise CanvasPackageError(f"项目元数据不是合法 JSON：{path}") from error
                if "/agent/sessions/" in path:
                    try:
                        session = CanvasAgentSession.model_validate(payload)
                    except ValidationError as error:
                        raise CanvasPackageError(f"Agent Session 不符合 schema：{path}") from error
                    if (
                        session.project_id != project_id
                        or session.session_id != PurePosixPath(path).stem
                    ):
                        raise CanvasPackageError(f"Agent Session 归属或文件名不一致：{path}")
                if "/plugins/" in path:
                    try:
                        plugin_state = CanvasPluginState.model_validate(payload)
                    except ValidationError as error:
                        raise CanvasPackageError(f"插件状态不符合 schema：{path}") from error
                    plugin_id = PurePosixPath(path).parts[-2]
                    if plugin_state.plugin_id != plugin_id:
                        raise CanvasPackageError(f"插件状态 plugin_id 与目录不一致：{path}")
                entries[path] = (body, "application/json", "metadata")
                paths.append(path)

            for version in document.content_versions.values():
                if version.kind == "text":
                    continue
                source = (project_dir / version.path).resolve()
                if not source.is_relative_to(project_dir.resolve()) or not source.is_file():
                    raise CanvasPackageError(f"内容版本 {version.version_id} 的媒体文件缺失")
                digest = _sha256_file(source)
                if digest != version.sha256 or source.stat().st_size != version.bytes:
                    raise CanvasPackageError(f"内容版本 {version.version_id} 的媒体摘要不一致")
                suffix = source.suffix.lower()
                if suffix not in _MEDIA_SUFFIXES:
                    raise CanvasPackageError(f"内容版本 {version.version_id} 的文件类型不允许导出")
                blob_path = f"blobs/sha256/{digest[:2]}/{digest}{suffix}"
                previous = entries.get(blob_path)
                if previous is not None and previous[0] != source:
                    previous_source = previous[0]
                    if (
                        not isinstance(previous_source, Path)
                        or _sha256_file(previous_source) != digest
                    ):
                        raise CanvasPackageError("项目媒体摘要发生冲突")
                entries[blob_path] = (source, version.mime_type, "blob")
                paths.append(blob_path)

            project_rows.append(
                _ManifestProject(
                    package_project_id=package_project_id,
                    original_project_id=project_id,
                    entry_paths=sorted(set(paths)),
                )
            )
            project_names.append(project.name)

        manifest_entries: list[_ManifestEntry] = []
        for path, (source, mime_type, role) in sorted(entries.items()):
            if isinstance(source, Path):
                digest = _sha256_file(source)
                size = source.stat().st_size
            else:
                digest = _sha256_bytes(source)
                size = len(source)
            manifest_entries.append(
                _ManifestEntry(
                    path=path,
                    sha256=digest,
                    bytes=size,
                    mime_type=mime_type,
                    role=role,
                )
            )
        manifest = _PackageManifest(
            app="game-atelier",
            kind="canvas-project-package",
            format_version=_FORMAT_VERSION,
            package_id=package_id,
            exported_at=_now_text(),
            projects=project_rows,
            entries=manifest_entries,
        )

        export_root = data_root.runtime_dir() / "canvas-exports"
        export_root.mkdir(parents=True, exist_ok=True)
        handle, raw_path = tempfile.mkstemp(prefix=f"{package_id}-", suffix=".zip", dir=export_root)
        os.close(handle)
        target = Path(raw_path)
        try:
            with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("manifest.json", manifest.model_dump_json(indent=2))
                for path, (source, _mime_type, _role) in sorted(entries.items()):
                    if isinstance(source, Path):
                        archive.write(source, path)
                    else:
                        archive.writestr(path, source)
        except BaseException:
            target.unlink(missing_ok=True)
            raise

    display = project_names[0] if len(project_names) == 1 else f"{len(project_names)}个画布项目"
    safe_name = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", display, flags=re.UNICODE).strip("-")
    return target, f"{safe_name or '画布项目'}.game-atelier-canvas.zip"


def _normalized_zip_path(raw: str) -> str:
    if "\\" in raw or raw.startswith("/") or raw.endswith("/"):
        raise CanvasPackageError(f"项目包包含非法路径：{raw}")
    path = PurePosixPath(raw)
    if not raw or any(part in {"", ".", ".."} for part in path.parts):
        raise CanvasPackageError(f"项目包包含非法路径：{raw}")
    return path.as_posix()


def _portable_path_key(path: str) -> str:
    return unicodedata.normalize("NFC", path).casefold()


def _validated_archive(zip_path: Path) -> tuple[_PackageManifest, int]:
    if not zip_path.is_file() or zip_path.stat().st_size > _MAX_COMPRESSED_BYTES:
        raise CanvasPackageError("项目包超过 2 GiB 上限")
    try:
        archive = zipfile.ZipFile(zip_path)
    except (OSError, zipfile.BadZipFile) as error:
        raise CanvasPackageError("选择的文件不是有效的 Canvas 项目包") from error
    with archive:
        infos = archive.infolist()
        if len(infos) > _MAX_ENTRIES:
            raise CanvasPackageError("项目包条目超过 20,000 个上限")
        info_by_path: dict[str, zipfile.ZipInfo] = {}
        casefold_paths: set[str] = set()
        extracted = 0
        for info in infos:
            path = _normalized_zip_path(info.filename)
            folded = _portable_path_key(path)
            if path in info_by_path or folded in casefold_paths:
                raise CanvasPackageError(f"项目包包含重复路径：{path}")
            casefold_paths.add(folded)
            if info.flag_bits & 1:
                raise CanvasPackageError(f"项目包包含加密条目：{path}")
            mode = info.external_attr >> 16
            file_type = stat.S_IFMT(mode)
            if stat.S_ISLNK(mode) or (file_type and not stat.S_ISREG(mode)):
                raise CanvasPackageError(f"项目包包含链接或特殊文件：{path}")
            if Path(path).suffix.lower() in _EXECUTABLE_SUFFIXES:
                raise CanvasPackageError(f"项目包包含可执行文件：{path}")
            extracted += info.file_size
            if extracted > _MAX_EXTRACTED_BYTES:
                raise CanvasPackageError("项目包解压后超过 10 GiB 上限")
            if info.file_size and (
                not info.compress_size
                or info.file_size / info.compress_size > _MAX_COMPRESSION_RATIO
            ):
                raise CanvasPackageError(f"项目包条目压缩比异常：{path}")
            info_by_path[path] = info
        manifest_info = info_by_path.get("manifest.json")
        if manifest_info is None or manifest_info.file_size > 5 * 1024 * 1024:
            raise CanvasPackageError("项目包缺少有效的 manifest.json")
        try:
            manifest = _PackageManifest.model_validate_json(archive.read(manifest_info))
        except (ValidationError, json.JSONDecodeError) as error:
            raise CanvasPackageError("项目包 manifest 不符合 format v1") from error
        entry_by_path = {entry.path: entry for entry in manifest.entries}
        if len(entry_by_path) != len(manifest.entries) or len(
            {_portable_path_key(path) for path in entry_by_path}
        ) != len(entry_by_path):
            raise CanvasPackageError("项目包 manifest 包含重复条目")
        if set(info_by_path) != {"manifest.json", *entry_by_path}:
            raise CanvasPackageError("项目包文件与 manifest 条目不一致")
        for entry in manifest.entries:
            if _normalized_zip_path(entry.path) != entry.path:
                raise CanvasPackageError(f"manifest 包含非法路径：{entry.path}")
            blob_match = _BLOB_PATH.fullmatch(entry.path)
            if entry.role == "blob":
                if blob_match is None:
                    raise CanvasPackageError(f"manifest blob 路径不合法：{entry.path}")
                if (
                    blob_match.group(1) != entry.sha256[:2]
                    or blob_match.group(2) != entry.sha256
                    or blob_match.group(3) not in _MEDIA_SUFFIXES
                ):
                    raise CanvasPackageError(
                        f"manifest blob 路径与摘要或媒体类型不一致：{entry.path}"
                    )
            elif entry.bytes > _MAX_METADATA_BYTES:
                raise CanvasPackageError(f"项目包元数据条目超过 25 MiB：{entry.path}")
            info = info_by_path[entry.path]
            if info.file_size != entry.bytes:
                raise CanvasPackageError(f"项目包条目大小不一致：{entry.path}")
            digest = hashlib.sha256()
            with archive.open(info) as handle:
                for block in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() != entry.sha256:
                raise CanvasPackageError(f"项目包条目摘要不一致：{entry.path}")
        _validate_project_metadata(archive, manifest)
        return manifest, extracted


def _validate_project_metadata(archive: zipfile.ZipFile, manifest: _PackageManifest) -> None:
    entry_by_path = {entry.path: entry for entry in manifest.entries}
    known_entries = set(entry_by_path)
    declared_paths = {path for row in manifest.projects for path in row.entry_paths}
    if declared_paths != known_entries:
        raise CanvasPackageError("项目包包含未归属或未登记的条目")
    declared_project_paths = {
        path
        for row in manifest.projects
        for path in row.entry_paths
        if path.startswith("projects/")
    }
    actual_project_paths = {path for path in known_entries if path.startswith("projects/")}
    if declared_project_paths != actual_project_paths:
        raise CanvasPackageError("项目包包含未归属或未登记的项目元数据")
    seen_package_ids: set[str] = set()
    seen_original_ids: set[str] = set()
    seen_job_ids: set[str] = set()
    seen_run_ids: set[str] = set()
    for row in manifest.projects:
        if (
            row.package_project_id in seen_package_ids
            or row.original_project_id in seen_original_ids
            or len(set(row.entry_paths)) != len(row.entry_paths)
        ):
            raise CanvasPackageError("项目包包含重复的项目 ID 或 entry_paths")
        seen_package_ids.add(row.package_project_id)
        seen_original_ids.add(row.original_project_id)
        prefix = f"projects/{row.package_project_id}"
        required = {
            f"{prefix}/project.json",
            f"{prefix}/canvas.json",
        }
        if not required.issubset(row.entry_paths) or not set(row.entry_paths).issubset(
            known_entries
        ):
            raise CanvasPackageError(f"项目 {row.package_project_id} 的 entry_paths 不完整")
        if any(
            path.startswith("projects/") and not path.startswith(f"{prefix}/")
            for path in row.entry_paths
        ):
            raise CanvasPackageError("项目 entry_paths 越过了项目命名空间")
        allowed_metadata = set(required)
        job_paths: set[str] = set()
        agent_paths: set[str] = set()
        plugin_paths: set[str] = set()
        for path in row.entry_paths:
            if not path.startswith(f"{prefix}/"):
                continue
            parts = PurePosixPath(path).relative_to(prefix).parts
            if len(parts) == 2 and parts[0] == "jobs" and parts[1].endswith(".json"):
                job_paths.add(path)
            elif (
                len(parts) == 3
                and parts[:2] == ("agent", "sessions")
                and parts[2].endswith(".json")
            ):
                agent_paths.add(path)
            elif len(parts) == 3 and parts[0] == "plugins" and parts[2] == "state.json":
                plugin_paths.add(path)
        allowed_metadata.update(job_paths | agent_paths | plugin_paths)
        project_metadata = {path for path in row.entry_paths if path.startswith(f"{prefix}/")}
        if project_metadata != allowed_metadata:
            raise CanvasPackageError(f"项目 {row.package_project_id} 包含未知元数据路径")
        if any(
            entry_by_path[path].role != "metadata"
            or entry_by_path[path].mime_type != "application/json"
            for path in project_metadata
        ):
            raise CanvasPackageError(f"项目 {row.package_project_id} 的元数据角色不正确")
        try:
            project = CanvasProject.model_validate_json(archive.read(f"{prefix}/project.json"))
            document = CanvasDocument.model_validate_json(archive.read(f"{prefix}/canvas.json"))
        except (ValidationError, json.JSONDecodeError, KeyError) as error:
            raise CanvasPackageError(f"项目 {row.package_project_id} 的元数据不合法") from error
        if (
            project.project_id != row.original_project_id
            or document.project_id != project.project_id
        ):
            raise CanvasPackageError("项目包 original_project_id 与文档不一致")

        jobs: list[Job] = []
        for path in row.entry_paths:
            if path in job_paths:
                try:
                    job = Job.model_validate_json(archive.read(path))
                except (ValidationError, json.JSONDecodeError, KeyError) as error:
                    raise CanvasPackageError(f"项目包任务记录不合法：{path}") from error
                if PurePosixPath(path).stem != job.job_id:
                    raise CanvasPackageError(f"项目包任务文件名与 job_id 不一致：{path}")
                jobs.append(job)
            elif path in agent_paths:
                try:
                    session = CanvasAgentSession.model_validate_json(archive.read(path))
                except (ValidationError, json.JSONDecodeError, KeyError) as error:
                    raise CanvasPackageError(f"Agent Session 不符合 schema：{path}") from error
                if (
                    session.project_id != project.project_id
                    or session.session_id != PurePosixPath(path).stem
                ):
                    raise CanvasPackageError(f"Agent Session 归属或文件名不一致：{path}")
            elif path in plugin_paths:
                try:
                    plugin_state = CanvasPluginState.model_validate_json(archive.read(path))
                except (ValidationError, json.JSONDecodeError, KeyError) as error:
                    raise CanvasPackageError(f"插件状态不符合 schema：{path}") from error
                plugin_id = PurePosixPath(path).parts[-2]
                if plugin_state.plugin_id != plugin_id:
                    raise CanvasPackageError(f"插件状态 plugin_id 与目录不一致：{path}")
        _assert_jobs_are_quiescent(jobs)
        job_ids = {job.job_id for job in jobs}
        run_ids = {job.canvas_run.run_id for job in jobs if job.canvas_run is not None}
        if len(job_ids) != len(jobs) or len(run_ids) != len(jobs):
            raise CanvasPackageError("项目包包含重复的 Canvas Job ID 或 Run ID")
        if seen_job_ids.intersection(job_ids) or seen_run_ids.intersection(run_ids):
            raise CanvasPackageError("项目包跨项目重复使用了 Canvas Job ID 或 Run ID")
        seen_job_ids.update(job_ids)
        seen_run_ids.update(run_ids)
        for job in jobs:
            if job.canvas_project_id != project.project_id:
                raise CanvasPackageError(f"任务 {job.job_id} 不属于项目 {project.project_id}")
            if job.retry_of is not None and job.retry_of not in job_ids:
                raise CanvasPackageError(f"任务 {job.job_id} 的 retry_of 无法解析")
            if job.canvas_run is None:
                raise CanvasPackageError(f"任务 {job.job_id} 缺少运行记录")
            for candidate in job.canvas_run.candidates:
                if (
                    candidate.version_id is not None
                    and candidate.version_id not in document.content_versions
                ):
                    raise CanvasPackageError(f"任务 {job.job_id} 的候选结果引用了不存在的内容版本")
            for item in job.canvas_run.snapshot.inputs:
                version = document.content_versions.get(item.version_id)
                if version is None or version.kind != item.kind:
                    raise CanvasPackageError(f"任务 {job.job_id} 的快照输入无法解析")
            snapshot = job.canvas_run.snapshot
            if job.canvas_run.result_node_id != snapshot.result_node_id:
                raise CanvasPackageError(f"任务 {job.job_id} 的结果节点快照不一致")
            if (
                snapshot.mask_version_id is not None
                and snapshot.mask_version_id not in document.content_versions
            ):
                raise CanvasPackageError(f"任务 {job.job_id} 的遮罩版本无法解析")
            candidate_ids = {candidate.candidate_id for candidate in job.canvas_run.candidates}
            if len(candidate_ids) != len(job.canvas_run.candidates):
                raise CanvasPackageError(f"任务 {job.job_id} 包含重复候选 ID")
        for node in document.nodes:
            active_run_id = getattr(node.data, "active_run_id", None)
            if active_run_id is not None and active_run_id not in run_ids:
                raise CanvasPackageError(f"节点 {node.id} 引用了不存在的运行记录")
        for edge in document.connections:
            if edge.role == "derivation" and edge.origin.kind == "generation_run":
                if edge.origin.run_id not in run_ids:
                    raise CanvasPackageError(f"连接 {edge.id} 引用了不存在的运行记录")
        blob_entries = [
            entry_by_path[path] for path in row.entry_paths if entry_by_path[path].role == "blob"
        ]
        jobs_by_id = {job.job_id: job for job in jobs}
        seen_layer_outputs: set[tuple[str, int]] = set()
        for version in document.content_versions.values():
            if version.origin.kind in {"user_mask", "local_tool"} and (
                version.origin.source_version_id not in document.content_versions
            ):
                raise CanvasPackageError(f"内容版本 {version.version_id} 的来源版本无法解析")
            if version.origin.kind == "job_output":
                owner = jobs_by_id.get(version.origin.job_id)
                candidate = None
                if owner is not None and owner.canvas_run is not None:
                    candidate = next(
                        (
                            item
                            for item in owner.canvas_run.candidates
                            if item.candidate_id == version.origin.candidate_id
                        ),
                        None,
                    )
                if candidate is None or candidate.version_id != version.version_id:
                    raise CanvasPackageError(
                        f"内容版本 {version.version_id} 的 Job candidate 血缘无法解析"
                    )
            if version.origin.kind == "layer_decomposition":
                owner = jobs_by_id.get(version.origin.job_id)
                result = None if owner is None else owner.params.layer_decomposition_result
                output = None if result is None else next(
                    (
                        item for item in result.outputs
                        if item.output_index == version.origin.output_index
                    ),
                    None,
                )
                lineage = (version.origin.job_id, version.origin.output_index)
                if (
                    owner is None
                    or not owner.params.layer_decomposition
                    or output is None
                    or output.z_index == 0
                    or version.origin.output_index >= len(owner.output_paths)
                    or owner.output_paths[version.origin.output_index] != version.path
                    or lineage in seen_layer_outputs
                ):
                    raise CanvasPackageError(
                        f"内容版本 {version.version_id} 的图层拆分血缘无法解析"
                    )
                seen_layer_outputs.add(lineage)
            if version.kind == "text":
                continue
            matches = [entry for entry in blob_entries if entry.sha256 == version.sha256]
            if not matches:
                raise CanvasPackageError(f"内容版本 {version.version_id} 缺少媒体 blob")
            if all(entry.mime_type != version.mime_type for entry in matches):
                raise CanvasPackageError(f"内容版本 {version.version_id} 的 blob MIME 不一致")
        expected_layer_outputs = {
            (job.job_id, output.output_index)
            for job in jobs
            if job.params.layer_decomposition_result is not None
            for output in job.params.layer_decomposition_result.outputs
            if output.z_index > 0
        }
        if seen_layer_outputs != expected_layer_outputs:
            raise CanvasPackageError("图层拆分任务的透明层内容版本不完整")


def inspect_canvas_package(zip_path: Path) -> CanvasPackageInspection:
    manifest, extracted = _validated_archive(zip_path)
    token = f"import-{secrets.token_hex(16)}"
    expires_at = _now() + _IMPORT_TTL
    stage = data_root.runtime_dir() / "canvas-imports" / token
    stage.mkdir(parents=True, exist_ok=False)
    target = stage / "package.zip"
    shutil.copy2(zip_path, target)
    atomic_write_json(
        stage / "inspection.json",
        {
            "token": token,
            "package_id": manifest.package_id,
            "expires_at": expires_at.isoformat(),
        },
    )
    with zipfile.ZipFile(target) as archive:
        projects = [
            CanvasProject.model_validate_json(
                archive.read(f"projects/{row.package_project_id}/project.json")
            )
            for row in manifest.projects
        ]
    return CanvasPackageInspection(
        token=token,
        package_id=manifest.package_id,
        expires_at=expires_at.isoformat(),
        projects=projects,
        entry_count=len(manifest.entries),
        extracted_bytes=extracted,
    )


def _inspection_package(token: str) -> Path:
    if _SAFE_TOKEN.fullmatch(token) is None:
        raise KeyError(token)
    stage = data_root.runtime_dir() / "canvas-imports" / token
    metadata_path = stage / "inspection.json"
    package_path = stage / "package.zip"
    if not metadata_path.is_file() or not package_path.is_file():
        raise KeyError(token)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if _now() >= datetime.fromisoformat(metadata["expires_at"]):
        shutil.rmtree(stage, ignore_errors=True)
        raise TimeoutError(token)
    return package_path


def _allocate_project_id() -> str:
    root = canvas_projects_root()
    root.mkdir(parents=True, exist_ok=True)
    for _attempt in range(20):
        project_id = f"canvas-{secrets.token_hex(6)}"
        if not (root / project_id).exists():
            return project_id
    raise RuntimeError("failed to allocate a unique canvas project id")


def _blob_index(manifest: _PackageManifest) -> dict[tuple[str, str], _ManifestEntry]:
    result: dict[tuple[str, str], _ManifestEntry] = {}
    for entry in manifest.entries:
        if entry.role == "blob":
            result.setdefault((entry.sha256, entry.mime_type), entry)
    return result


def _remap_document(
    document: CanvasDocument,
    project_id: str,
    job_ids: dict[str, str],
    run_ids: dict[str, str],
    blob_entries: dict[tuple[str, str], _ManifestEntry],
) -> CanvasDocument:
    raw = document.model_dump(mode="json")
    raw["project_id"] = project_id
    raw["updated_at"] = _now_text()
    for node in raw["nodes"]:
        active_run_id = node["data"].get("active_run_id")
        if active_run_id is not None:
            if active_run_id not in run_ids:
                raise CanvasPackageError(f"节点 {node['id']} 的 active_run_id 无法重写")
            node["data"]["active_run_id"] = run_ids[active_run_id]
    for edge in raw["connections"]:
        if edge["role"] == "derivation" and edge["origin"]["kind"] == "generation_run":
            old_run_id = edge["origin"]["run_id"]
            if old_run_id not in run_ids:
                raise CanvasPackageError(f"连接 {edge['id']} 的 run_id 无法重写")
            edge["origin"]["run_id"] = run_ids[old_run_id]
    for version in raw["content_versions"].values():
        origin = version["origin"]
        if origin["kind"] in {"job_output", "layer_decomposition"}:
            old_job_id = origin["job_id"]
            if old_job_id not in job_ids:
                raise CanvasPackageError(f"内容版本 {version['version_id']} 的 job_id 无法重写")
            origin["job_id"] = job_ids[old_job_id]
        if version["kind"] == "text":
            continue
        blob = blob_entries.get((version["sha256"], version["mime_type"]))
        if blob is None:
            raise CanvasPackageError(f"内容版本 {version['version_id']} 缺少 blob")
        suffix = PurePosixPath(blob.path).suffix
        if origin["kind"] in {"job_output", "layer_decomposition"}:
            version["path"] = f"outputs/{origin['job_id']}/{version['version_id']}{suffix}"
        elif origin["kind"] == "local_tool":
            version["path"] = f"derived/{origin['operation_id']}/{version['version_id']}{suffix}"
        elif origin["kind"] == "upload":
            version["path"] = f"uploads/{origin['upload_id']}{suffix}"
        else:
            version["path"] = f"uploads/import-{version['version_id']}{suffix}"
    return CanvasDocument.model_validate(raw)


def _remap_jobs(
    jobs: list[Job],
    project_id: str,
    document: CanvasDocument,
    job_ids: dict[str, str],
    run_ids: dict[str, str],
) -> list[Job]:
    remapped: list[Job] = []
    for job in jobs:
        if job.canvas_run is None:
            raise CanvasPackageError(f"任务 {job.job_id} 缺少运行快照")
        raw = job.model_dump(mode="json")
        old_job_id = job.job_id
        raw["job_id"] = job_ids[old_job_id]
        raw["canvas_project_id"] = project_id
        raw["canvas_run"]["run_id"] = run_ids[job.canvas_run.run_id]
        if job.retry_of is not None:
            if job.retry_of not in job_ids:
                raise CanvasPackageError(f"任务 {job.job_id} 的 retry_of 无法重写")
            raw["retry_of"] = job_ids[job.retry_of]

        references: dict[str, list[str]] = {"image": [], "video": [], "audio": []}
        for item in job.canvas_run.snapshot.inputs:
            version = document.content_versions[item.version_id]
            if version.kind != "text":
                references[version.kind].append(f"canvases/{project_id}/{version.path}")
        raw["params"]["reference_images"] = references["image"] or None
        raw["params"]["reference_videos"] = references["video"] or None
        raw["params"]["reference_audios"] = references["audio"] or None
        mask_version_id = job.canvas_run.snapshot.mask_version_id
        raw["params"]["mask_image"] = (
            f"canvases/{project_id}/{document.content_versions[mask_version_id].path}"
            if mask_version_id is not None
            else None
        )
        raw["output_paths"] = [
            f"canvases/{project_id}/{version.path}"
            for version in _output_versions_for_job(
                job,
                document,
                origin_job_id=raw["job_id"],
            )
            if version.kind != "text"
        ]
        raw["source_image"] = None
        remapped.append(Job.model_validate(raw))
    return remapped


def _import_project(
    archive: zipfile.ZipFile,
    manifest: _PackageManifest,
    row: _ManifestProject,
    transaction_root: Path,
    project_id: str,
) -> tuple[CanvasProject, Path, list[tuple[Job, Path]]]:
    prefix = f"projects/{row.package_project_id}"
    source_project = CanvasProject.model_validate_json(archive.read(f"{prefix}/project.json"))
    source_document = CanvasDocument.model_validate_json(archive.read(f"{prefix}/canvas.json"))
    jobs = [
        Job.model_validate_json(archive.read(path))
        for path in sorted(row.entry_paths)
        if path.startswith(f"{prefix}/jobs/")
    ]
    job_ids = {job.job_id: new_job_id() for job in jobs}
    run_ids = {
        job.canvas_run.run_id: f"run-{secrets.token_hex(12)}"
        for job in jobs
        if job.canvas_run is not None
    }
    if len(run_ids) != len(jobs):
        raise CanvasPackageError("项目包包含重复或缺失的 Canvas Run ID")

    target = transaction_root / "projects" / project_id
    target.mkdir(parents=True, exist_ok=False)
    timestamp = _now_text()
    project = source_project.model_copy(
        update={
            "project_id": project_id,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
    )
    document = _remap_document(
        source_document,
        project_id,
        job_ids,
        run_ids,
        _blob_index(manifest),
    )
    remapped_jobs = _remap_jobs(jobs, project_id, document, job_ids, run_ids)

    try:
        (target / "uploads").mkdir()
        (target / "outputs").mkdir()
        (target / "derived").mkdir()
        atomic_write_json(target / "project.json", project.model_dump(mode="json"))
        atomic_write_json(target / "canvas.json", document.model_dump(mode="json"))
        for path in sorted(row.entry_paths):
            if path.startswith(f"{prefix}/agent/"):
                relative = PurePosixPath(path).relative_to(prefix)
                destination = target.joinpath(*relative.parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                session = CanvasAgentSession.model_validate_json(archive.read(path))
                remapped_session = session.model_copy(update={"project_id": project_id})
                atomic_write_json(destination, remapped_session.model_dump(mode="json"))
            elif path.startswith(f"{prefix}/plugins/"):
                relative = PurePosixPath(path).relative_to(prefix)
                destination = target.joinpath(*relative.parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(archive.read(path))
        blobs = _blob_index(manifest)
        for version in document.content_versions.values():
            if version.kind == "text":
                continue
            destination = target / version.path
            destination.parent.mkdir(parents=True, exist_ok=True)
            with (
                archive.open(blobs[(version.sha256, version.mime_type)].path) as source,
                destination.open("wb") as output,
            ):
                shutil.copyfileobj(source, output, length=1024 * 1024)
            if _sha256_file(destination) != version.sha256:
                raise CanvasPackageError(f"写入内容版本 {version.version_id} 时摘要不一致")

        pending_jobs: list[tuple[Job, Path]] = []
        jobs_root = transaction_root / "jobs"
        jobs_root.mkdir(parents=True, exist_ok=True)
        for job in remapped_jobs:
            pending = jobs_root / f"{job.job_id}.json"
            pending.write_text(job.model_dump_json(indent=2), encoding="utf-8")
            pending_jobs.append((job, pending))
        return project, target, pending_jobs
    except BaseException:
        shutil.rmtree(target, ignore_errors=True)
        raise


def _commit_package(
    zip_path: Path,
    commit_hook: Callable[[list[CanvasProject]], None] | None = None,
) -> list[CanvasProject]:
    manifest, _extracted = _validated_archive(zip_path)
    staged: list[tuple[CanvasProject, Path, list[tuple[Job, Path]]]] = []
    committed_jobs: list[Path] = []
    committed_projects: list[Path] = []
    transaction_id = f"transaction-{secrets.token_hex(12)}"
    transaction_root = _package_transactions_root() / transaction_id
    with file_lock(_lifecycle_lock_path()), zipfile.ZipFile(zip_path) as archive:
        _recover_import_transactions_unlocked()
        transaction_root.mkdir(parents=True, exist_ok=False)
        try:
            reserved_project_ids: set[str] = set()
            for row in manifest.projects:
                project_id = _allocate_project_id()
                while project_id in reserved_project_ids:
                    project_id = _allocate_project_id()
                reserved_project_ids.add(project_id)
                staged.append(
                    _import_project(
                        archive,
                        manifest,
                        row,
                        transaction_root,
                        project_id,
                    )
                )
            all_jobs = [item for _project, _target, jobs in staged for item in jobs]
            journal = {
                "state": "committing",
                "project_ids": [project.project_id for project, _target, _jobs in staged],
                "job_ids": [job.job_id for job, _pending in all_jobs],
            }
            atomic_write_json(transaction_root / "transaction.json", journal)
            with ExitStack() as stack:
                for job, _pending in sorted(all_jobs, key=lambda item: item[0].job_id):
                    stack.enter_context(job_lock(job.job_id))
                for job, pending in all_jobs:
                    final = data_root.runtime_dir() / "jobs" / f"{job.job_id}.json"
                    pending.replace(final)
                    committed_jobs.append(final)
                for project, target, _jobs in staged:
                    final = _project_dir_unchecked(project.project_id)
                    target.replace(final)
                    committed_projects.append(final)
            projects = [project for project, _target, _jobs in staged]
            if commit_hook is not None:
                commit_hook(projects)
            atomic_write_json(
                transaction_root / "transaction.json",
                {**journal, "state": "committed"},
            )
            shutil.rmtree(transaction_root, ignore_errors=True)
            return projects
        except BaseException:
            for path in committed_jobs:
                path.unlink(missing_ok=True)
            for _project, _target, jobs in staged:
                for _job, pending in jobs:
                    pending.unlink(missing_ok=True)
            for path in committed_projects:
                shutil.rmtree(path, ignore_errors=True)
            shutil.rmtree(transaction_root, ignore_errors=True)
            raise


def commit_canvas_package(token: str) -> list[CanvasProject]:
    if _SAFE_TOKEN.fullmatch(token) is None:
        raise KeyError(token)
    with file_lock(_import_claim_lock_path(token)):
        with file_lock(_lifecycle_lock_path()):
            package_path = _inspection_package(token)
            stage = package_path.parent
            claimed = stage.with_name(f".{stage.name}.claimed-{secrets.token_hex(6)}")
            atomic_write_json(stage / "claim.json", {"state": "claimed", "project_ids": []})
            stage.replace(claimed)

        def record_import(projects: list[CanvasProject]) -> None:
            atomic_write_json(
                claimed / "claim.json",
                {
                    "state": "imported",
                    "project_ids": [project.project_id for project in projects],
                },
            )

        try:
            projects = _commit_package(claimed / "package.zip", commit_hook=record_import)
        except BaseException:
            with file_lock(_lifecycle_lock_path()):
                if not stage.exists() and claimed.exists():
                    claimed.replace(stage)
                (stage / "claim.json").unlink(missing_ok=True)
            raise
        with file_lock(_lifecycle_lock_path()):
            shutil.rmtree(claimed, ignore_errors=True)
        return projects


def delete_canvas_project(
    project_id: str,
    expected_revision: int,
) -> None:
    """Permanently delete a project and every Canvas job it owns."""
    transaction = _delete_transactions_root() / f"delete-{secrets.token_hex(12)}"
    with (
        file_lock(_lifecycle_lock_path()),
        file_lock(canvas_project_lock_path(project_id)),
        file_lock(canvas_agent_sessions_lock_path(project_id)),
    ):
        _recover_package_transactions_unlocked()
        _recover_canvas_transactions_unlocked(project_id)
        from character_workflow.lib.canvas_batches import assert_no_active_canvas_batch

        try:
            assert_no_active_canvas_batch(project_id)
        except ValueError as error:
            raise CanvasProjectBusyError(str(error)) from error
        current = _read_canvas_document_unlocked(project_id)
        if current.revision != expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        jobs = _jobs_for_project(project_id)
        with ExitStack() as stack:
            for job in jobs:
                stack.enter_context(job_lock(job.job_id))
            locked_jobs = [read_job(job.job_id) for job in jobs]
            _assert_jobs_are_quiescent(locked_jobs)
            moved_jobs: list[tuple[Path, Path]] = []
            moved_project: tuple[Path, Path] | None = None
            try:
                transaction.mkdir(parents=True, exist_ok=False)
                (transaction / "jobs").mkdir()
                atomic_write_json(
                    transaction / "transaction.json",
                    {
                        "project_id": project_id,
                        "job_ids": [job.job_id for job in locked_jobs],
                    },
                )
                source_project = canvas_project_dir(project_id)
                destination_project = transaction / "project"
                source_project.replace(destination_project)
                moved_project = (source_project, destination_project)
                for job in locked_jobs:
                    source = data_root.runtime_dir() / "jobs" / f"{job.job_id}.json"
                    destination = transaction / "jobs" / source.name
                    source.replace(destination)
                    moved_jobs.append((source, destination))
            except BaseException:
                for source, destination in reversed(moved_jobs):
                    if destination.exists():
                        destination.replace(source)
                if moved_project is not None and moved_project[1].exists():
                    moved_project[1].replace(moved_project[0])
                shutil.rmtree(transaction, ignore_errors=True)
                raise
    shutil.rmtree(transaction, ignore_errors=True)
    # 缩略图缓存放在 .runtime 下，不随项目目录一起被移走：删项目时得自己收。
    discard_canvas_thumbnails(project_id)
    from character_workflow.lib.creation_assets import remove_canvas_project_asset_relations
    remove_canvas_project_asset_relations(project_id)
