"""分享：把 Studio 结果与创作资产写进团队库作者自己的目录。

只写 `shared/<author_dir_name(author)>/<asset_id>/`，别人的目录永远不碰（ADR-0020）。
新资产先在同级 `.tmp-<asset_id>/` 写完再整体改名；索引跳过点目录，读不到半成品。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import unicodedata
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.creation_assets import (
    _normalize_tags,
    _required_text,
    blob_path_for,
    get_creation_asset,
)
from character_workflow.lib.jobs import read_job
from character_workflow.lib.schemas import (
    MEDIA_SUFFIXES,
    TEAM_ASSET_ID_PATTERN,
    CreationAsset,
    CreationMediaAssetContent,
    Job,
    JobKind,
    JobStatus,
    RecipeInputRole,
    TeamAssetAuthor,
    TeamAssetFile,
    TeamAssetMedia,
    TeamAssetOrigin,
    TeamGenerationSnapshot,
    TeamLibraryMount,
    TeamPromptContent,
    TeamRecipeInput,
)
from character_workflow.lib.team_library import new_ulid

LARGE_REFS_BYTES = 200 * 1024 * 1024
THUMB_MAX_EDGE = 512
AUTHOR_DIR_MAX = 60

# 快照 params 不带的字段：本机路径（参考本体已进 refs/）、费用（进 cost_cny）、
# 运行后由 caller / runner 回写的状态、指回本机对象的来源记录。
RECIPE_PARAM_EXCLUDE = frozenset({
    # 本机文件路径
    "reference_images", "reference_videos", "reference_audios", "mask_image",
    "mj_sref", "mj_cref", "mj_oref", "archived_from_path",
    # 费用
    "estimated_cost_cny", "actual_cost_cny",
    # 运行后回写
    "warnings", "requested_size", "actual_size", "provider_task_protocol",
    "provider_task_ids", "layer_decomposition_result", "mj_flags",
    # 本机来源记录
    "creation_asset_source_title", "archived_from_job_id",
})

# 参考在快照里的顺序（order 全局递增）；首尾帧靠 params.frame_mode 解释 reference_images 顺序。
_JOB_REF_FIELDS: tuple[tuple[str, RecipeInputRole], ...] = (
    ("reference_images", "reference"),
    ("reference_videos", "reference"),
    ("reference_audios", "reference"),
    ("mask_image", "mask"),
    ("mj_sref", "mj_sref"),
    ("mj_cref", "mj_cref"),
    ("mj_oref", "mj_oref"),
)
_SHAREABLE_STATUSES = frozenset({JobStatus.DONE, JobStatus.PARTIAL})
_SHAREABLE_KINDS = frozenset({JobKind.IMAGE, JobKind.VIDEO})
_SUFFIX_MIMES = {suffix: mime for mime, suffix in MEDIA_SUFFIXES.items()} | {".jpeg": "image/jpeg"}
_RESERVED_NAMES = frozenset({"asset.json", "thumb.webp", "refs"})
_UNSAFE_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_AUTHOR_UNSAFE_CHARS = re.compile(r"[^\w-]")
_COPY_CHUNK = 1024 * 1024


class TeamShareError(ValueError):
    """这个源现在不能分享：code = "not_shareable" | "source_missing"。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class TeamShareNotFound(LookupError):
    """源 job / 创作资产 / 库内资产不存在。"""


class TeamShareForbidden(PermissionError):
    """库内资产不是本人分享的。"""


class TeamShareTooLarge(ValueError):
    """参考内容合计超过 LARGE_REFS_BYTES，需要用户确认后带 allow_large 重发。"""

    def __init__(self, total_bytes: int):
        super().__init__(f"参考内容合计 {total_bytes} 字节，超过上限")
        self.bytes = total_bytes


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def author_dir_name(display_name: str) -> str:
    normalized = unicodedata.normalize("NFC", display_name)
    slug = _AUTHOR_UNSAFE_CHARS.sub("-", normalized).strip("-")
    slug = slug[:AUTHOR_DIR_MAX].strip("-")
    return slug or "author"


# ------------------------------------------------------------------ 文件工具


def _media_filename(name: str) -> str:
    """成片在资产目录里的文件名：去分隔符与 Windows 非法字符，避开 asset.json / thumb.webp / refs。"""
    cleaned = _UNSAFE_FILENAME_CHARS.sub("-", Path(name).name).strip(" .")
    if not cleaned or cleaned.lower() in _RESERVED_NAMES or cleaned.startswith("."):
        return f"media{Path(name).suffix.lower()}"
    return cleaned


def _mime_for(path: Path) -> str:
    mime = _SUFFIX_MIMES.get(path.suffix.lower())
    if mime is None:
        raise TeamShareError("not_shareable", f"不支持分享这种文件格式：{path.suffix or '无扩展名'}")
    return mime


def _local_file(value: str) -> Path:
    """job 里登记的路径：绝对路径或数据根相对路径（与 /api/raw 白名单同一解析）。"""
    if value.startswith(("http://", "https://")):
        raise TeamShareError("not_shareable", "网络地址的参考无法打包进团队库")
    raw = Path(value)
    path = (raw if raw.is_absolute() else data_root.resolve_data_root() / raw).resolve()
    if not path.is_file():
        raise TeamShareError("source_missing", f"本机找不到文件：{path.name}")
    return path


def _copy_hashed(source: Path, folder: Path, name_for: Callable[[str], str]) -> tuple[str, int, str]:
    """边拷边算 sha256（哈希的是库里那份字节），再按 sha 定文件名。返回 (sha256, bytes, 相对名)。"""
    staging = folder / f".staging-{uuid.uuid4().hex}"
    digest = hashlib.sha256()
    size = 0
    try:
        with source.open("rb") as src, staging.open("wb") as dst:
            for chunk in iter(lambda: src.read(_COPY_CHUNK), b""):
                digest.update(chunk)
                dst.write(chunk)
                size += len(chunk)
    except FileNotFoundError as error:
        staging.unlink(missing_ok=True)
        raise TeamShareError("source_missing", f"本机找不到文件：{source.name}") from error
    sha = digest.hexdigest()
    relative = name_for(sha)
    target = folder / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    staging.rename(target)
    return sha, size, relative


def _write_thumbnail(source: Path, target: Path) -> None:
    """图片成片的 ≤ 512px webp；Pillow 读不了就不写（索引会按需自己生成）。"""
    try:
        with Image.open(source) as opened:
            image = ImageOps.exif_transpose(opened) or opened
            image.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE))
            mode = "RGBA" if image.mode in {"RGBA", "LA", "P"} else "RGB"
            image.convert(mode).save(target, "WEBP", quality=80)
    except (OSError, UnidentifiedImageError, ValueError, Image.DecompressionBombError):
        target.unlink(missing_ok=True)


def _check_refs_size(paths: list[Path], allow_large: bool) -> None:
    total = sum(path.stat().st_size for path in paths)
    if total > LARGE_REFS_BYTES and not allow_large:
        raise TeamShareTooLarge(total)


# ------------------------------------------------------------------ 写目录


def _dump(asset: TeamAssetFile) -> dict[str, Any]:
    return asset.model_dump(mode="json", exclude_none=True)


def _write_new_asset(
    mount: TeamLibraryMount,
    author: str,
    stage: Callable[[str, Path], TeamAssetFile],
) -> TeamAssetFile:
    """stage(asset_id, tmp_dir) 把文件拷进 tmp_dir 并返回 asset.json 内容；完成后整体改名。"""
    root = Path(mount.mount_path)
    if not root.is_dir():
        raise FileNotFoundError(mount.mount_path)
    author_root = root / "shared" / author_dir_name(author)
    author_root.mkdir(parents=True, exist_ok=True)
    asset_id = f"ta_{new_ulid()}"
    tmp = author_root / f".tmp-{asset_id}"
    try:
        tmp.mkdir()
        asset = stage(asset_id, tmp)
        (tmp / "asset.json").write_text(
            json.dumps(_dump(asset), ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.replace(tmp, author_root / asset_id)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return asset


def _stage_media(source: Path, mime_type: str, filename: str, folder: Path) -> TeamAssetMedia:
    name = _media_filename(filename)
    sha, size, _ = _copy_hashed(source, folder, lambda _sha: name)
    if mime_type.startswith("image/"):
        _write_thumbnail(folder / name, folder / "thumb.webp")
    return TeamAssetMedia(filename=name, mime_type=mime_type, bytes=size, sha256=sha)


def _stage_input(
    source: Path, order: int, role: RecipeInputRole, mime_type: str, folder: Path
) -> TeamRecipeInput:
    suffix = MEDIA_SUFFIXES[mime_type]
    sha, _, relative = _copy_hashed(
        source, folder, lambda digest: f"refs/{order + 1:02d}-{digest[:12]}{suffix}"
    )
    return TeamRecipeInput(
        order=order, role=role, kind=mime_type.split("/", 1)[0], sha256=sha,
        mime_type=mime_type, path=relative,
    )


def _recipe_params(params: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in params.items() if k not in RECIPE_PARAM_EXCLUDE and v is not None}


# ------------------------------------------------------------------ job_output


def _read_studio_job(job_id: str) -> Job:
    if Path(job_id).name != job_id or job_id.startswith("."):
        raise TeamShareNotFound(job_id)
    try:
        return read_job(job_id)
    except FileNotFoundError as error:
        raise TeamShareNotFound(job_id) from error


def _job_output(job: Job, output_index: int) -> Path:
    if job.namespace != "studio":
        raise TeamShareError("not_shareable", "只有 Studio 记录可以分享")
    if job.status not in _SHAREABLE_STATUSES:
        raise TeamShareError("not_shareable", "只有已完成的记录可以分享")
    if job.kind not in _SHAREABLE_KINDS:
        raise TeamShareError("not_shareable", "只有图片与视频结果可以分享")
    if not 0 <= output_index < len(job.output_paths):
        raise TeamShareError("not_shareable", "这条记录没有这张结果")
    root = data_root.resolve_data_root().resolve()
    raw = Path(job.output_paths[output_index])
    path = (raw if raw.is_absolute() else root / raw).resolve()
    studio_dir = (root / "studio" / job.job_id).resolve()
    if path.parent != studio_dir:
        raise TeamShareError("not_shareable", "Studio 记录的产物路径不在自己的输出目录")
    if not path.is_file():
        raise TeamShareError("source_missing", f"本机找不到结果文件：{path.name}")
    return path


def _job_refs(job: Job) -> list[tuple[RecipeInputRole, Path, str]]:
    refs: list[tuple[RecipeInputRole, Path, str]] = []
    for field, role in _JOB_REF_FIELDS:
        value = getattr(job.params, field)
        values = [value] if isinstance(value, str) else list(value or [])
        for item in values:
            path = _local_file(item)
            refs.append((role, path, _mime_for(path)))
    return refs


def _job_cost(job: Job) -> tuple[float | None, str | None]:
    if job.params.actual_cost_cny is not None:
        return job.params.actual_cost_cny, "actual"
    if job.params.estimated_cost_cny is not None:
        return job.params.estimated_cost_cny, "estimated"
    return None, None


def share_job_output(
    mount: TeamLibraryMount,
    *,
    job_id: str,
    output_index: int,
    title: str,
    tags: list[str],
    author: str,
    allow_large: bool = False,
) -> TeamAssetFile:
    job = _read_studio_job(job_id)
    output = _job_output(job, output_index)
    output_mime = _mime_for(output)
    refs = _job_refs(job)
    _check_refs_size([path for _, path, _ in refs], allow_large)
    clean_title, clean_tags = _required_text(title, "标题"), _normalize_tags(tags)
    cost_cny, cost_basis = _job_cost(job)

    def stage(asset_id: str, folder: Path) -> TeamAssetFile:
        media = _stage_media(output, output_mime, output.name, folder)
        inputs = [
            _stage_input(path, order, role, mime, folder)
            for order, (role, path, mime) in enumerate(refs)
        ]
        snapshot = TeamGenerationSnapshot(
            mode=job.kind.value, model=job.model, provider=job.provider, alias=job.alias,
            final_prompt=job.prompt, draft_prompt=None,
            params=_recipe_params(job.params.model_dump(mode="json", exclude_none=True)),
            inputs=inputs, cost_cny=cost_cny, cost_basis=cost_basis,
            submitted_at=job.submitted_at,
        )
        timestamp = _now()
        return TeamAssetFile(
            asset_id=asset_id, kind="generation", title=clean_title, tags=clean_tags,
            author=TeamAssetAuthor(display_name=author), shared_at=timestamp,
            updated_at=timestamp, media=media, snapshot=snapshot,
            origin=TeamAssetOrigin(job_id=job.job_id),
        )

    return _write_new_asset(mount, author, stage)


# ------------------------------------------------------------ creation_asset


def _blob_file(content: CreationMediaAssetContent) -> Path:
    path = blob_path_for(content.sha256, content.mime_type)
    if not path.is_file():
        raise TeamShareError("source_missing", f"本机找不到资产文件：{content.filename}")
    return path


def _creation_stage(asset: CreationAsset, allow_large: bool) -> Callable[[Path], dict[str, Any]]:
    """按资产种类返回「把本体拷进资产目录并给出 asset.json 载荷字段」的函数。"""
    content = asset.content
    if content.kind == "prompt":
        prompt = TeamPromptContent.model_validate(content.model_dump(mode="json"))
        return lambda _folder: {"kind": "prompt", "prompt": prompt}
    if content.kind == "media":
        source = _blob_file(content)
        return lambda folder: {
            "kind": "media",
            "media": _stage_media(source, content.mime_type, content.filename, folder),
        }
    output = _blob_file(content.media)
    recipe = content.snapshot
    ref_paths = []
    for row in recipe.inputs:
        path = blob_path_for(row.sha256, row.mime_type)
        if not path.is_file():
            raise TeamShareError("source_missing", f"本机找不到第 {row.order + 1} 份参考")
        ref_paths.append(path)
    _check_refs_size(ref_paths, allow_large)

    def stage(folder: Path) -> dict[str, Any]:
        media = _stage_media(output, content.media.mime_type, content.media.filename, folder)
        inputs = [
            _stage_input(path, row.order, row.role, row.mime_type, folder)
            for row, path in zip(recipe.inputs, ref_paths)
        ]
        snapshot = TeamGenerationSnapshot.model_validate({
            **recipe.model_dump(mode="json", exclude={"inputs", "params"}),
            "params": _recipe_params(recipe.params),
            "inputs": [row.model_dump(mode="json") for row in inputs],
        })
        return {"kind": "generation", "media": media, "snapshot": snapshot}

    return stage


def share_creation_asset(
    mount: TeamLibraryMount,
    *,
    asset_id: str,
    title: str,
    tags: list[str],
    author: str,
    allow_large: bool = False,
) -> TeamAssetFile:
    try:
        asset = get_creation_asset(asset_id)
    except KeyError as error:
        raise TeamShareNotFound(asset_id) from error
    payload_for = _creation_stage(asset, allow_large)
    clean_title, clean_tags = _required_text(title, "标题"), _normalize_tags(tags)

    def stage(team_asset_id: str, folder: Path) -> TeamAssetFile:
        payload = payload_for(folder)
        timestamp = _now()
        return TeamAssetFile(
            asset_id=team_asset_id, title=clean_title, tags=clean_tags,
            author=TeamAssetAuthor(display_name=author), shared_at=timestamp,
            updated_at=timestamp, **payload,
        )

    return _write_new_asset(mount, author, stage)


# ---------------------------------------------------------- update / withdraw


def _locate_own_asset(
    mount: TeamLibraryMount, asset_id: str, author: str
) -> tuple[Path, TeamAssetFile]:
    """在 shared/*/<asset_id>/ 找资产：找不到 → NotFound；作者不是本人 → Forbidden。"""
    if not re.fullmatch(TEAM_ASSET_ID_PATTERN, asset_id):
        raise TeamShareNotFound(asset_id)
    shared_root = Path(mount.mount_path) / "shared"
    try:
        author_dirs = sorted(
            p for p in shared_root.iterdir() if p.is_dir() and not p.name.startswith(".")
        )
    except (FileNotFoundError, NotADirectoryError) as error:
        raise TeamShareNotFound(asset_id) from error
    for author_dir in author_dirs:
        folder = author_dir / asset_id
        manifest = folder / "asset.json"
        if not manifest.is_file():
            continue
        try:
            asset = TeamAssetFile.model_validate_json(manifest.read_text(encoding="utf-8"))
        except ValueError:
            continue
        if asset.author.display_name != author:
            raise TeamShareForbidden(asset_id)
        return folder, asset
    raise TeamShareNotFound(asset_id)


def update_shared_asset(
    mount: TeamLibraryMount,
    *,
    asset_id: str,
    title: str,
    tags: list[str],
    author: str,
) -> TeamAssetFile:
    folder, current = _locate_own_asset(mount, asset_id, author)
    # model_validate 而非 model_copy：新标题 / 标签要过同一套校验再落盘。
    updated = TeamAssetFile.model_validate({
        **_dump(current),
        "title": _required_text(title, "标题"),
        "tags": _normalize_tags(tags),
        "updated_at": _now(),
    })
    atomic_write_json(folder / "asset.json", _dump(updated))
    return updated


def withdraw_shared_asset(mount: TeamLibraryMount, *, asset_id: str, author: str) -> None:
    folder, _ = _locate_own_asset(mount, asset_id, author)
    trash = folder.parent / f".tmp-del-{asset_id}"
    if trash.exists():
        shutil.rmtree(trash)
    os.replace(folder, trash)
    shutil.rmtree(trash)
