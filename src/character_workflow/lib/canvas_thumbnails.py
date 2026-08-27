"""按需生成、落盘缓存的画布图片缩略图。

节点卡在画布上通常只有两三百像素宽，但一直在下发原图：缩放到能看见几十上百个节点时，
浏览器要同时解码同样多张全分辨率原图——一张 2048² 的 PNG 解出来是 16 MB 位图。

缓存放 `.runtime/canvas-thumbnails/<project_id>/<version_id>-<width>.webp`，不放项目目录：
项目目录的文件会被导出包按 content_versions 逐一核对，多出来的派生文件会让校验失败。
缓存键只有 version_id 和宽度，两者都不可变（Content Version 一经写入不再改动），
所以缓存永不失效，接口也就能发 immutable 的 Cache-Control。
"""
from __future__ import annotations

import re
import shutil
import warnings
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_bytes
from character_workflow.lib.schemas import CanvasMediaVersion


# 固定档位。开放任意宽度等于让调用方无限制地往磁盘上写派生文件，
# 而且每多一个宽度就多一份解码开销——请求的宽度一律向上取到最近的档位。
CANVAS_THUMBNAIL_WIDTHS = (256, 512, 1024)
_MAX_PIXELS = 64_000_000
_THUMBNAIL_QUALITY = 82
_SAFE_ID = re.compile(r"[^a-zA-Z0-9._-]+")


def snap_thumbnail_width(width: int) -> int | None:
    """向上取到最近的档位；超过最大档位说明要的就是原图。"""
    for candidate in CANVAS_THUMBNAIL_WIDTHS:
        if width <= candidate:
            return candidate
    return None


def canvas_thumbnails_dir(project_id: str) -> Path:
    return data_root.runtime_dir() / "canvas-thumbnails" / _SAFE_ID.sub("-", project_id)


def discard_canvas_thumbnails(project_id: str) -> None:
    """项目被删除时一并丢掉它的缩略图缓存。"""
    shutil.rmtree(canvas_thumbnails_dir(project_id), ignore_errors=True)


def resolve_canvas_thumbnail(
    project_id: str,
    version: CanvasMediaVersion,
    source: Path,
    width: int,
) -> Path | None:
    """返回缓存好的缩略图；返回 None 表示这一份就该发原图。

    发原图的情形：不是图片、原图本来就不比缩略图大、动图（缩了会变成静止的一帧）、
    以及任何解码失败。缩略图是纯优化，失败时退回原图而不是报错——画师看到的还是图。
    """
    if version.kind != "image":
        return None
    target_width = snap_thumbnail_width(width)
    if target_width is None:
        return None
    if version.width is not None and version.width <= target_width:
        return None

    cached = canvas_thumbnails_dir(project_id) / f"{_SAFE_ID.sub('-', version.version_id)}-{target_width}.webp"
    if cached.is_file():
        return cached
    try:
        encoded = _render_thumbnail(source, target_width)
    except (
        OSError,
        UnidentifiedImageError,
        ValueError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ):
        return None
    if encoded is None:
        return None
    atomic_write_bytes(cached, encoded)
    return cached


def _render_thumbnail(source: Path, target_width: int) -> bytes | None:
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(source) as opened:
            if getattr(opened, "is_animated", False) or getattr(opened, "n_frames", 1) != 1:
                return None
            if opened.size[0] * opened.size[1] > _MAX_PIXELS:
                return None
            opened.load()
            oriented = ImageOps.exif_transpose(opened) or opened
            if oriented.width <= target_width:
                return None
            height = max(1, round(oriented.height * target_width / oriented.width))
            has_alpha = "A" in oriented.getbands() or "transparency" in opened.info
            resized = oriented.convert("RGBA" if has_alpha else "RGB").resize(
                (target_width, height), Image.Resampling.LANCZOS
            )
            buffer = BytesIO()
            resized.save(buffer, format="WEBP", quality=_THUMBNAIL_QUALITY, method=4)
            return buffer.getvalue()
