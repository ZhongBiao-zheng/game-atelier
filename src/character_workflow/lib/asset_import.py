"""Import existing character art into the managed data-root asset slots."""
from __future__ import annotations

import hashlib
import re
import shutil
from pathlib import Path
from typing import Any

from character_workflow.lib import data_root
from character_workflow.lib.asset_versions import asset_output_lock, next_asset_path
from character_workflow.lib.jobs import list_jobs, new_job_id, update_job_status, write_job
from character_workflow.lib.schemas import AssetSlot, JobStatus


_IMPORTABLE_SLOTS = {AssetSlot.PORTRAIT, AssetSlot.TURNAROUND}
_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
_VERSIONED_IMAGE = re.compile(r"^v[1-9]\d*\.(?:png|jpe?g|webp)$", re.IGNORECASE)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_once(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if _sha256(target) != _sha256(source):
            raise ValueError(f"目标文件已存在但内容不同: {target}")
        return
    shutil.copy2(source, target)


def _relative_to_data_root(path: Path) -> str:
    return path.resolve().relative_to(data_root.resolve_data_root().resolve()).as_posix()


def _existing_job_for_path(character_id: str, slot: AssetSlot, path: Path):
    resolved = path.resolve()
    for job in list_jobs():
        if (
            job.namespace == "character"
            and job.character_id == character_id
            and job.asset_slot == slot
            and job.status == JobStatus.DONE
            and any(
                (data_root.resolve_data_root() / output).resolve() == resolved
                if not Path(output).is_absolute()
                else Path(output).resolve() == resolved
                for output in job.output_paths
            )
        ):
            return job
    return None


def _existing_import_job(character_id: str, slot: AssetSlot, digest: str):
    for job in list_jobs():
        if (
            job.namespace == "character"
            and job.character_id == character_id
            and job.asset_slot == slot
            and job.status == JobStatus.DONE
            and getattr(job.params, "import_kind", None) == "external_output"
            and getattr(job.params, "imported_sha256", None) == digest
            and job.output_paths
        ):
            output = Path(job.output_paths[0])
            if not output.is_absolute():
                output = data_root.resolve_data_root() / output
            if output.is_file():
                return job, output.resolve()
    return None


def _register_done_job(
    *,
    character_id: str,
    slot: AssetSlot,
    output_path: Path,
    source_image: Path,
    model: str,
    prompt: str,
    params: dict[str, Any],
    alias: str,
):
    existing = _existing_job_for_path(character_id, slot, output_path)
    if existing is not None:
        return existing

    job_id = new_job_id()
    write_job(
        job_id=job_id,
        character_id=character_id,
        prompt=prompt,
        model=model,
        params=params,
        status=JobStatus.PENDING,
        asset_slot=slot,
        source_image=str(source_image.resolve()),
        alias=alias,
    )
    return update_job_status(
        job_id,
        status=JobStatus.DONE,
        output_paths=[_relative_to_data_root(output_path)],
    )


def import_reference(
    character_id: str,
    source_path: str | Path,
    slot: AssetSlot,
) -> dict[str, str | bool]:
    """Back up one existing image and register it in a typed asset slot.

    Imported files deliberately do not update canonical.json: canonical selection
    remains a separate, explicit artist decision.
    """
    if slot not in _IMPORTABLE_SLOTS:
        raise ValueError("参考素材只能归档到 portrait 或 turnaround")

    characters_dir = data_root.characters_dir().resolve()
    character_dir = (characters_dir / character_id).resolve()
    if character_dir.parent != characters_dir or not character_dir.is_dir():
        raise FileNotFoundError(f"角色目录不存在: {character_id}")

    source = Path(source_path).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(f"参考图不存在: {source}")
    if source.stat().st_size == 0:
        raise ValueError(f"参考图是空文件: {source}")
    suffix = source.suffix.lower()
    if suffix not in _IMAGE_SUFFIXES:
        raise ValueError(f"不支持的参考图格式: {suffix or '无扩展名'}")

    digest = _sha256(source)
    filename = f"reference-{digest[:12]}{suffix}"
    backup = character_dir / "source" / filename
    registered = character_dir / slot.value / filename
    _copy_once(source, backup)
    _copy_once(source, registered)

    existing = _existing_job_for_path(character_id, slot, registered)
    job = existing or _register_done_job(
        character_id=character_id,
        slot=slot,
        output_path=registered,
        source_image=backup,
        model="reference-import",
        prompt="用户提供的角色参考图",
        params={
            "vendor": "local import",
            "reference_images": [str(backup.resolve())],
            "import_kind": "reference",
            "imported_sha256": digest,
        },
        alias="reference-import",
    )

    return {
        "character_id": character_id,
        "slot": slot.value,
        "source_path": _relative_to_data_root(backup),
        "slot_path": _relative_to_data_root(registered),
        "job_id": job.job_id,
    }


def import_output(
    character_id: str,
    source_path: str | Path,
    slot: AssetSlot,
    *,
    model: str = "external",
    prompt: str = "外部生成图片导入",
    reference_images: list[str | Path] | None = None,
) -> dict[str, str | bool]:
    """Import an externally generated image and register it as a visible DONE job.

    A versioned image already inside its target slot is registered in place. Other
    sources are copied to the next vN path. Canonical selection remains explicit.
    """
    characters_dir = data_root.characters_dir().resolve()
    character_dir = (characters_dir / character_id).resolve()
    if character_dir.parent != characters_dir or not character_dir.is_dir():
        raise FileNotFoundError(f"角色目录不存在: {character_id}")

    source = Path(source_path).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(f"外部成图不存在: {source}")
    if source.stat().st_size == 0:
        raise ValueError(f"外部成图是空文件: {source}")
    suffix = source.suffix.lower()
    if suffix not in _IMAGE_SUFFIXES:
        raise ValueError(f"不支持的图片格式: {suffix or '无扩展名'}")
    digest = _sha256(source)

    resolved_references: list[str] = []
    for raw in reference_images or []:
        reference = Path(raw).expanduser().resolve()
        if not reference.is_file():
            raise FileNotFoundError(f"参考图不存在: {reference}")
        value = str(reference)
        if value not in resolved_references:
            resolved_references.append(value)

    prior_import = _existing_import_job(character_id, slot, digest)
    if prior_import is not None:
        job, output = prior_import
        return {
            "character_id": character_id,
            "slot": slot.value,
            "slot_path": _relative_to_data_root(output),
            "job_id": job.job_id,
            "reused": True,
        }

    output_dir = character_dir / slot.value
    source_is_versioned_output = (
        source.parent == output_dir.resolve()
        and _VERSIONED_IMAGE.fullmatch(source.name) is not None
    )
    created_copy = False
    if source_is_versioned_output:
        output = source
    else:
        with asset_output_lock(output_dir):
            output = next_asset_path(output_dir, suffix)
            shutil.copy2(source, output)
            created_copy = True

    existing = _existing_job_for_path(character_id, slot, output)
    try:
        job = existing or _register_done_job(
            character_id=character_id,
            slot=slot,
            output_path=output,
            source_image=source,
            model=model,
            prompt=prompt.strip() or "外部生成图片导入",
            params={
                "vendor": "external import",
                "reference_images": resolved_references,
                "import_kind": "external_output",
                "imported_sha256": digest,
            },
            alias="external-import",
        )
    except Exception:
        if created_copy:
            output.unlink(missing_ok=True)
        raise

    return {
        "character_id": character_id,
        "slot": slot.value,
        "slot_path": _relative_to_data_root(output),
        "job_id": job.job_id,
        "reused": existing is not None,
    }
