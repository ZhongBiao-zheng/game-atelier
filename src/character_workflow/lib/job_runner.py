"""Job runner — turns PENDING_CONFIRM JSON jobs into durable image assets."""
from __future__ import annotations

import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from character_workflow.lib import lovart_caller
from character_workflow.lib.active_character import read_active
from character_workflow.lib.jobs import (
    job_output_dir,
    list_jobs,
    read_job,
    save_job,
    update_job_status,
)
from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus


class JobRunnerError(RuntimeError):
    pass


def _project_root() -> Path:
    return Path(os.environ.get("PROJECT_ROOT", Path.cwd())).resolve()


def _params(job: Job) -> dict[str, Any]:
    return job.params.model_dump()


def _save_params(job: Job, params: dict[str, Any]) -> Job:
    return save_job(job.model_copy(update={"params": JobParams(**params)}))


def _normalize_reference_images(job: Job) -> Job:
    params = _params(job)
    refs = list(params.get("reference_images") or [])
    if job.source_image and job.source_image not in refs:
        refs.append(job.source_image)
    params["reference_images"] = refs
    if params.get("requested_size") is None and params.get("size"):
        params["requested_size"] = params["size"]
    return _save_params(job, params)


def _png_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def _jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) < 4 or not data.startswith(b"\xff\xd8"):
        return None
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB):
            height = int.from_bytes(data[i + 5:i + 7], "big")
            width = int.from_bytes(data[i + 7:i + 9], "big")
            return width, height
        size = int.from_bytes(data[i + 2:i + 4], "big")
        if size < 2:
            return None
        i += 2 + size
    return None


def _webp_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) < 30 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None
    kind = data[12:16]
    if kind == b"VP8X" and len(data) >= 30:
        width = int.from_bytes(data[24:27], "little") + 1
        height = int.from_bytes(data[27:30], "little") + 1
        return width, height
    if kind == b"VP8 " and len(data) >= 30:
        width = int.from_bytes(data[26:28], "little") & 0x3FFF
        height = int.from_bytes(data[28:30], "little") & 0x3FFF
        return width, height
    return None


def image_dimensions(path: Path) -> tuple[int, int] | None:
    if not path.exists() or path.stat().st_size <= 0:
        return None
    data = path.read_bytes()[:4096]
    for parser in (_png_dimensions, _jpeg_dimensions, _webp_dimensions):
        dims = parser(data)
        if dims and dims[0] > 0 and dims[1] > 0:
            return dims
    return None


def is_valid_image(path: Path) -> bool:
    return image_dimensions(path) is not None


def _candidate_paths(result: lovart_caller.LovartResult) -> list[Path]:
    downloaded = result.raw_json.get("downloaded") or []
    new_paths = [
        Path(item["local_path"])
        for item in downloaded
        if (
            isinstance(item, dict)
            and item.get("type", "image") == "image"
            and item.get("new") is True
            and isinstance(item.get("local_path"), str)
        )
    ]
    if new_paths:
        return new_paths
    downloaded_paths = [
        Path(item["local_path"])
        for item in downloaded
        if (
            isinstance(item, dict)
            and item.get("type", "image") == "image"
            and isinstance(item.get("local_path"), str)
        )
    ]
    return downloaded_paths or [Path(p) for p in result.output_paths]


def _next_asset_path(output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    n = 1
    while True:
        path = output_dir / f"v{n}.png"
        if not path.exists():
            return path
        n += 1


def _write_sidecar(path: Path, job: Job, params: dict[str, Any]) -> None:
    created_at = datetime.now(timezone.utc).isoformat()
    lines = [
        f"# {path.stem}",
        "",
        f"- kind: {job.kind.value}",
        f"- job_id: {job.job_id}",
        f"- created_at: {created_at}",
        f"- source_image: {job.source_image or ''}",
        f"- requested_size: {params.get('requested_size') or params.get('size') or ''}",
        f"- actual_size: {params.get('actual_size') or ''}",
        f"- model: {job.model}",
    ]
    path.with_suffix(".md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _select_valid_outputs(
    result: lovart_caller.LovartResult,
    *,
    limit: int,
) -> list[tuple[Path, tuple[int, int]]]:
    selected: list[tuple[Path, tuple[int, int]]] = []
    for path in _candidate_paths(result):
        dims = image_dimensions(path)
        if dims is None:
            continue
        selected.append((path, dims))
        if len(selected) >= limit:
            break
    return selected


def run_job(job_id: str) -> Job:
    job = read_job(job_id)
    if job.status != JobStatus.PENDING_CONFIRM:
        raise JobRunnerError(f"job not in pending_confirm (current: {job.status.value})")

    job = _normalize_reference_images(job)
    params = _params(job)
    refs = list(params.get("reference_images") or [])

    try:
        attachments = lovart_caller.upload_files(refs) if refs else []
        params["lovart_attachments"] = attachments
        job = _save_params(job, params)
        update_job_status(job.job_id, status=JobStatus.PENDING, error=None)

        with tempfile.TemporaryDirectory(prefix=f"{job.job_id}-lovart-") as tmp:
            result = lovart_caller.submit_and_wait(
                prompt=job.prompt,
                model=job.model,
                output_dir=Path(tmp),
                n=params.get("n") or 1,
                attachments=attachments,
            )
            selected = _select_valid_outputs(result, limit=max(1, int(params.get("n") or 1)))
            if not selected:
                raise JobRunnerError("lovart returned no valid image artifacts")

            output_dir = job_output_dir(job.character_id, job.kind, _project_root())
            output_paths: list[str] = []
            first_dims: tuple[int, int] | None = None
            for src, dims in selected:
                target = _next_asset_path(output_dir)
                shutil.move(str(src), target)
                output_paths.append(str(target))
                first_dims = first_dims or dims

            params = _params(read_job(job.job_id))
            params["lovart_thread_id"] = result.raw_json.get("thread_id")
            params["lovart_final_status"] = result.raw_json.get("final_status")
            if first_dims:
                params["actual_size"] = f"{first_dims[0]}x{first_dims[1]}"
            warnings = list(params.get("warnings") or [])
            final_status = result.raw_json.get("final_status")
            if final_status and final_status != "done":
                warnings.append(
                    f"final_status {final_status} but {len(output_paths)} valid artifact selected"
                )
            if warnings:
                params["warnings"] = warnings
            job = _save_params(read_job(job.job_id), params)
            for output_path in output_paths:
                _write_sidecar(Path(output_path), job, params)
            return update_job_status(
                job.job_id,
                status=JobStatus.DONE,
                output_paths=output_paths,
                error=None,
            )
    except Exception as e:
        update_job_status(job.job_id, status=JobStatus.FAILED, error=str(e))
        if isinstance(e, JobRunnerError):
            raise
        raise JobRunnerError(str(e)) from e


def run_latest(
    *,
    kind: JobKind | None = None,
    character_id: str | None = None,
) -> Job:
    if character_id is None:
        active = read_active()
        character_id = active.active_id
    if not character_id:
        raise JobRunnerError("no active character")

    candidates = [
        job for job in list_jobs()
        if (
            job.character_id == character_id
            and job.status == JobStatus.PENDING_CONFIRM
            and (kind is None or job.kind == kind)
        )
    ]
    if not candidates:
        suffix = f" kind={kind.value}" if kind else ""
        raise JobRunnerError(f"no pending_confirm job for {character_id}{suffix}")
    candidates.sort(key=lambda j: (j.submitted_at, j.job_id))
    return run_job(candidates[-1].job_id)
