"""Validation and normalization for user-authored Canvas image masks."""
from __future__ import annotations

import hashlib
import io
import warnings
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from character_workflow.lib.schemas import CanvasMediaVersion


_MAX_MASK_BYTES = 25 * 1024 * 1024
_MAX_PIXELS = 64_000_000


class CanvasMaskError(ValueError):
    """Stable validation failure returned by the mask-edit command."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class NormalizedCanvasMask:
    body: bytes
    width: int
    height: int
    sha256: str


def normalize_canvas_mask(
    source_path: Path,
    source_version: CanvasMediaVersion,
    body: bytes,
) -> NormalizedCanvasMask:
    """Return a same-size, single-channel PNG where 0 means edit and 255 preserve."""
    if not body or len(body) > _MAX_MASK_BYTES:
        raise CanvasMaskError(
            "canvas_mask_invalid",
            "蒙版文件为空或超过 25 MiB，请重新绘制。",
        )
    source_size = _source_display_size(source_path, source_version)
    mask = _decode_mask(body)
    try:
        if mask.size != source_size:
            raise CanvasMaskError(
                "canvas_mask_size_mismatch",
                f"蒙版必须与源图保持同尺寸（{source_size[0]} × {source_size[1]}）。",
            )
        extrema = mask.getextrema()
        if not isinstance(extrema, tuple) or extrema[0] >= 255:
            raise CanvasMaskError(
                "canvas_mask_empty",
                "蒙版中还没有需要编辑的区域。",
            )
        output = io.BytesIO()
        mask.save(output, format="PNG", optimize=True)
        normalized = output.getvalue()
        return NormalizedCanvasMask(
            body=normalized,
            width=mask.width,
            height=mask.height,
            sha256=hashlib.sha256(normalized).hexdigest(),
        )
    finally:
        mask.close()


def _source_display_size(path: Path, version: CanvasMediaVersion) -> tuple[int, int]:
    if not path.is_file():
        raise CanvasMaskError(
            "canvas_mask_source_missing",
            "源图片文件不存在，无法创建局部编辑。",
        )
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != version.sha256:
        raise CanvasMaskError(
            "canvas_mask_source_changed",
            "源图片文件已经变化，请重新导入后再编辑。",
        )
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as opened:
                if getattr(opened, "is_animated", False) or getattr(opened, "n_frames", 1) != 1:
                    raise CanvasMaskError(
                        "canvas_mask_source_invalid",
                        "局部编辑只支持静态图片。",
                    )
                opened.load()
                oriented = ImageOps.exif_transpose(opened)
                width, height = oriented.size
    except CanvasMaskError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise CanvasMaskError(
            "canvas_mask_source_too_large",
            "源图片解码规模超过 6400 万像素上限。",
        ) from error
    except (OSError, UnidentifiedImageError, ValueError) as error:
        raise CanvasMaskError(
            "canvas_mask_source_invalid",
            "源文件不是可读取的静态图片。",
        ) from error
    if width <= 0 or height <= 0 or width * height > _MAX_PIXELS:
        raise CanvasMaskError(
            "canvas_mask_source_too_large",
            "源图片超过 6400 万像素上限。",
        )
    if version.width is not None and version.height is not None:
        if (width, height) != (version.width, version.height):
            raise CanvasMaskError(
                "canvas_mask_source_changed",
                "源图片尺寸与登记版本不一致，请重新导入。",
            )
    return width, height


def _decode_mask(body: bytes) -> Image.Image:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(body)) as opened:
                if opened.format != "PNG":
                    raise CanvasMaskError("canvas_mask_invalid", "蒙版必须是 PNG 文件。")
                if getattr(opened, "is_animated", False) or getattr(opened, "n_frames", 1) != 1:
                    raise CanvasMaskError("canvas_mask_invalid", "蒙版不能是多帧图片。")
                width, height = opened.size
                if width <= 0 or height <= 0 or width * height > _MAX_PIXELS:
                    raise CanvasMaskError(
                        "canvas_mask_invalid",
                        "蒙版尺寸无效或超过 6400 万像素上限。",
                    )
                opened.load()
                if "A" in opened.getbands() or "transparency" in opened.info:
                    return opened.convert("RGBA").getchannel("A")
                if opened.mode in {"1", "L"}:
                    return opened.convert("L")
                raise CanvasMaskError(
                    "canvas_mask_invalid",
                    "蒙版必须包含透明通道，或使用单通道灰度 PNG。",
                )
    except CanvasMaskError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise CanvasMaskError(
            "canvas_mask_invalid",
            "蒙版解码规模超过安全上限。",
        ) from error
    except (OSError, UnidentifiedImageError, ValueError) as error:
        raise CanvasMaskError(
            "canvas_mask_invalid",
            "蒙版不是有效的 PNG 文件。",
        ) from error
