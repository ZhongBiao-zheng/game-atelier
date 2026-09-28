"""分享：把 Studio 结果、画布结果与创作资产写进团队库作者自己的目录。

只写 `shared/<author_dir_name(author)>/<asset_id>/`，别人的目录永远不碰（ADR-0020）。
新资产先在同级 `.tmp-<asset_id>/` 写完再整体改名；索引跳过点目录，读不到半成品。
Studio / 画布结果的配方来源（R6、参考路径闸门、参数白名单、按内容定类型）在 generation_recipe。
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import unicodedata
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError

from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.creation_assets import (
    _normalize_tags,
    _required_text,
    blob_path_for,
    get_creation_asset,
)
from character_workflow.lib.generation_recipe import (
    RecipeSource,
    RecipeSourceError,
    RecipeSourceNotFound,
    media_mime,
    recipe_from_canvas_result,
    recipe_from_job_output,
    recipe_params,
)
from character_workflow.lib.schemas import (
    MEDIA_SUFFIXES,
    TEAM_ASSET_ID_PATTERN,
    CreationAsset,
    CreationMediaAssetContent,
    GenerationRecipe,
    RecipeInputRole,
    TeamAssetAuthor,
    TeamAssetFile,
    TeamAssetMedia,
    TeamAssetOrigin,
    TeamAssetUpdateRequest,
    TeamGenerationSnapshot,
    TeamLibraryMount,
    TeamPromptContent,
    TeamRecipeInput,
)
from character_workflow.lib.team_library import new_ulid

logger = logging.getLogger(__name__)

LARGE_REFS_BYTES = 200 * 1024 * 1024
THUMB_MAX_EDGE = 512
AUTHOR_DIR_MAX = 60

_SUFFIX_MIMES = {suffix: mime for mime, suffix in MEDIA_SUFFIXES.items()} | {".jpeg": "image/jpeg"}
_RESERVED_NAMES = frozenset({"asset.json", "thumb.webp", "refs"})
_UNSAFE_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WINDOWS_RESERVED = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
)
_FILENAME_MAX_BYTES = 255
_SUFFIX_MAX_BYTES = 16
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


def _fit_filename_bytes(name: str) -> str:
    """UTF-8 超 255 字节时截断主名、保留扩展名（库目录会被 SVN 检出到任意文件系统）。"""
    if len(name.encode("utf-8")) <= _FILENAME_MAX_BYTES:
        return name
    suffix = Path(name).suffix
    if len(suffix.encode("utf-8")) > _SUFFIX_MAX_BYTES:
        suffix = ""
    stem = name[: len(name) - len(suffix)] if suffix else name
    budget = _FILENAME_MAX_BYTES - len(suffix.encode("utf-8"))
    while len(stem.encode("utf-8")) > budget:
        stem = stem[:-1]
    return f"{stem.rstrip(' .')}{suffix}"


def _media_filename(name: str) -> str:
    """成片在资产目录里的文件名：去分隔符与 Windows 非法字符 / 保留名，避开 asset.json /
    thumb.webp / refs，UTF-8 不超过 255 字节。"""
    suffix = Path(name).suffix.lower()
    cleaned = _UNSAFE_FILENAME_CHARS.sub("-", Path(name).name).strip(" .")
    if not cleaned or cleaned.lower() in _RESERVED_NAMES or cleaned.startswith("."):
        return f"media{suffix}" if len(suffix.encode("utf-8")) <= _SUFFIX_MAX_BYTES else "media"
    if cleaned.split(".", 1)[0].rstrip(" ").upper() in _WINDOWS_RESERVED:
        cleaned = f"media-{cleaned}"
    return _fit_filename_bytes(cleaned)


def _typed_filename(name: str, mime_type: str) -> str:
    """后缀已对应真实类型就原样保留（.jpeg / 大写都算），否则保留主名、换成真实类型的后缀。"""
    base = Path(name).name
    suffix = Path(base).suffix
    if _SUFFIX_MIMES.get(suffix.lower()) == mime_type:
        return base
    stem = base[: len(base) - len(suffix)] if suffix else base
    return f"{stem}{MEDIA_SUFFIXES[mime_type]}"


@contextmanager
def _share_errors() -> Iterator[None]:
    """配方来源的错误映射成分享原有的错误类型（路由按它们定状态码）。"""
    try:
        yield
    except RecipeSourceNotFound as error:
        raise TeamShareNotFound(*error.args) from error
    except RecipeSourceError as error:
        raise TeamShareError(error.code, str(error)) from error


def _mime_for(path: Path) -> str:
    with _share_errors():
        return media_mime(path)


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
    name = _media_filename(_typed_filename(filename, mime_type))
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


def _validated_author(author: str) -> TeamAssetAuthor:
    return TeamAssetAuthor(display_name=_required_text(author, "显示名"))


def validate_share_meta(
    title: str, tags: list[str], author: str
) -> tuple[str, list[str], TeamAssetAuthor]:
    """任何 I/O 之前校验标题 / 标签 / 显示名（含长度上限）：失败不建目录、不读源。"""
    request = TeamAssetUpdateRequest(
        title=_required_text(title, "标题"), tags=_normalize_tags(tags)
    )
    return request.title, request.tags, _validated_author(author)


# ------------------------------------------------------------- 生成结果（配方）


def _generation_stage(
    media_path: Path,
    media_filename: str,
    recipe: GenerationRecipe,
    input_paths: list[Path],
    allow_large: bool,
) -> Callable[[Path], dict[str, Any]]:
    """读源、定类型、查总量都在建临时目录之前做完；返回「把成片与参考拷进资产目录并给出
    asset.json 的 media / snapshot」的函数。参考的 sha 取拷进库的那份字节。"""
    output_mime = _mime_for(media_path)
    ref_mimes = [_mime_for(path) for path in input_paths]
    _check_refs_size(input_paths, allow_large)

    def stage(folder: Path) -> dict[str, Any]:
        media = _stage_media(media_path, output_mime, media_filename, folder)
        inputs = [
            _stage_input(path, row.order, row.role, mime, folder)
            for row, path, mime in zip(recipe.inputs, input_paths, ref_mimes, strict=True)
        ]
        snapshot = TeamGenerationSnapshot.model_validate({
            **recipe.model_dump(mode="json", exclude={"inputs", "params"}),
            "params": recipe_params(recipe.params),
            "inputs": [row.model_dump(mode="json") for row in inputs],
        })
        return {"kind": "generation", "media": media, "snapshot": snapshot}

    return stage


def _share_recipe_source(
    mount: TeamLibraryMount,
    source: RecipeSource,
    *,
    title: str,
    tags: list[str],
    author: TeamAssetAuthor,
    allow_large: bool,
) -> TeamAssetFile:
    payload_for = _generation_stage(
        source.media_path, source.media_filename, source.recipe, source.input_paths, allow_large
    )
    origin = TeamAssetOrigin(
        job_id=source.origin_job_id, canvas_project_id=source.origin_canvas_project_id
    )

    def stage(asset_id: str, folder: Path) -> TeamAssetFile:
        payload = payload_for(folder)
        timestamp = _now()
        return TeamAssetFile(
            asset_id=asset_id, title=title, tags=tags, author=author, shared_at=timestamp,
            updated_at=timestamp, origin=origin, **payload,
        )

    return _write_new_asset(mount, author.display_name, stage)


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
    clean_title, clean_tags, team_author = validate_share_meta(title, tags, author)
    with _share_errors():
        source = recipe_from_job_output(job_id, output_index)
    return _share_recipe_source(
        mount, source, title=clean_title, tags=clean_tags, author=team_author,
        allow_large=allow_large,
    )


def share_canvas_result(
    mount: TeamLibraryMount,
    *,
    canvas_project_id: str,
    node_id: str,
    version_id: str,
    title: str,
    tags: list[str],
    author: str,
    allow_large: bool = False,
) -> TeamAssetFile:
    clean_title, clean_tags, team_author = validate_share_meta(title, tags, author)
    with _share_errors():
        source = recipe_from_canvas_result(canvas_project_id, node_id, version_id)
    return _share_recipe_source(
        mount, source, title=clean_title, tags=clean_tags, author=team_author,
        allow_large=allow_large,
    )


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
        source_mime = _mime_for(source)
        return lambda folder: {
            "kind": "media",
            "media": _stage_media(source, source_mime, content.filename, folder),
        }
    recipe = content.snapshot
    ref_paths = []
    for row in recipe.inputs:
        path = blob_path_for(row.sha256, row.mime_type)
        if not path.is_file():
            raise TeamShareError("source_missing", f"本机找不到第 {row.order + 1} 份参考")
        ref_paths.append(path)
    return _generation_stage(
        _blob_file(content.media), content.media.filename, recipe, ref_paths, allow_large
    )


def share_creation_asset(
    mount: TeamLibraryMount,
    *,
    asset_id: str,
    title: str,
    tags: list[str],
    author: str,
    allow_large: bool = False,
) -> TeamAssetFile:
    clean_title, clean_tags, team_author = validate_share_meta(title, tags, author)
    try:
        asset = get_creation_asset(asset_id)
    except KeyError as error:
        raise TeamShareNotFound(asset_id) from error
    payload_for = _creation_stage(asset, allow_large)

    def stage(team_asset_id: str, folder: Path) -> TeamAssetFile:
        payload = payload_for(folder)
        timestamp = _now()
        return TeamAssetFile(
            asset_id=team_asset_id, title=clean_title, tags=clean_tags, author=team_author,
            shared_at=timestamp, updated_at=timestamp, **payload,
        )

    return _write_new_asset(mount, team_author.display_name, stage)


# ---------------------------------------------------------- update / withdraw


def _locate_own_asset(
    mount: TeamLibraryMount, asset_id: str, author: str
) -> tuple[Path, dict[str, Any]]:
    """只在 shared/<author_dir_name(author)>/<asset_id>/ 找本人的资产，返回 (目录, asset.json 原始 dict)。

    只在别的作者目录里有同 id → Forbidden；哪都没有 → NotFound。资产目录（或其上层）是
    symlink 时 resolve 后不再是这个路径 → Forbidden：不能借链接改到别处的文件。
    """
    if not re.fullmatch(TEAM_ASSET_ID_PATTERN, asset_id):
        raise TeamShareNotFound(asset_id)
    shared_root = Path(mount.mount_path).resolve() / "shared"
    own_slug = author_dir_name(author)
    folder = shared_root / own_slug / asset_id
    manifest = folder / "asset.json"
    if manifest.is_file():
        if folder.resolve() != folder:
            raise TeamShareForbidden(asset_id)
        try:
            raw = json.loads(manifest.read_text(encoding="utf-8"))
            asset = TeamAssetFile.model_validate(raw)
        except ValueError as error:
            raise TeamShareNotFound(asset_id) from error
        if asset.author.display_name != author:
            raise TeamShareForbidden(asset_id)
        return folder, raw
    try:
        others = [
            p for p in shared_root.iterdir()
            if p.is_dir() and not p.name.startswith(".") and p.name != own_slug
        ]
    except (FileNotFoundError, NotADirectoryError) as error:
        raise TeamShareNotFound(asset_id) from error
    if any((p / asset_id / "asset.json").is_file() for p in others):
        raise TeamShareForbidden(asset_id)
    raise TeamShareNotFound(asset_id)


def update_shared_asset(
    mount: TeamLibraryMount,
    *,
    asset_id: str,
    title: str,
    tags: list[str],
    author: str,
) -> TeamAssetFile:
    clean_title, clean_tags, team_author = validate_share_meta(title, tags, author)
    folder, raw = _locate_own_asset(mount, asset_id, team_author.display_name)
    # 改原始 dict 而不是重新 dump 模型：别的版本多写的字段（R1 读时忽略）原样保留。
    updated_raw = {**raw, "title": clean_title, "tags": clean_tags, "updated_at": _now()}
    updated = TeamAssetFile.model_validate(updated_raw)
    atomic_write_json(folder / "asset.json", updated_raw)
    return updated


def withdraw_shared_asset(mount: TeamLibraryMount, *, asset_id: str, author: str) -> None:
    team_author = _validated_author(author)
    folder, _ = _locate_own_asset(mount, asset_id, team_author.display_name)
    trash = folder.parent / f".tmp-del-{asset_id}"
    if trash.exists():
        shutil.rmtree(trash, ignore_errors=True)
    os.replace(folder, trash)
    # 改名成功即已撤回（索引跳过点目录）；删不干净只留一个点目录，不让撤回失败。
    try:
        shutil.rmtree(trash)
    except OSError:
        logger.warning("撤回 %s 后清理 %s 失败", asset_id, trash, exc_info=True)
