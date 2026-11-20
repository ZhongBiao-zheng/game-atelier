"""供应商自定义图标（PLAN §8，I1）：校验、重新编码、按内容寻址落盘、清理未引用的文件。

图片存 `<data_root>/.config/provider-icons/<sha256>.png`，KEY 里只记 `file:<sha256>`。
上传与按网址获取共用 `normalize`：只按文件头认格式，先查尺寸再解码，一律重新编码成
128×128 透明底 PNG，原始字节不落盘。
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import struct
import tempfile
import time
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import _replace_with_retry

logger = logging.getLogger(__name__)

MAX_BYTES = 1 << 20
MAX_SIDE = 4096
MAX_PIXELS = 16_000_000
OUTPUT_SIDE = 128
# 上传后、表单保存前，别的 KEY 写入会触发清理：一小时内的未引用文件不删，保存后引用不会悬空。
GRACE_SECONDS = 3600
UNREADABLE = "图片无法识别"

_SHA = re.compile(r"[0-9a-f]{64}")
_BRAND = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
_PNG = b"\x89PNG\r\n\x1a\n"


class IconRejected(ValueError):
    """图片不能用作图标；消息直接给用户看。"""


def icons_dir() -> Path:
    return data_root.config_dir() / "provider-icons"


def _format(raw: bytes) -> str | None:
    """只按文件头认五种位图；扩展名、文件名与 Content-Type 一概不看。"""
    if raw.startswith(_PNG):
        return "PNG"
    if raw.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "GIF"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "WEBP"
    if raw[:4] == b"\x00\x00\x01\x00":
        return "ICO"
    return None


def _check_dims(width: int, height: int) -> None:
    if width <= 0 or height <= 0:
        raise IconRejected(UNREADABLE)
    if width > MAX_SIDE or height > MAX_SIDE or width * height > MAX_PIXELS:
        raise IconRejected(f"图片尺寸 {width}×{height} 过大，长边不超过 {MAX_SIDE}")


def _ico_largest(raw: bytes) -> tuple[int, int]:
    """ICO 打开时 Pillow 会直接解码一张：先自己读目录，核对每张的真实尺寸，返回最大的一张。

    目录项里的宽高只有一个字节，内嵌 PNG 与 DIB 的真实尺寸要读它们自己的头。"""
    try:
        (count,) = struct.unpack_from("<H", raw, 4)
        if not 0 < count <= 64:
            raise IconRejected(UNREADABLE)
        best = (0, 0)
        for index in range(count):
            size, offset = struct.unpack_from("<II", raw, 6 + 16 * index + 8)
            body = raw[offset:offset + size]
            if body.startswith(_PNG):
                width, height = struct.unpack_from(">II", body, 16)
            else:
                width, doubled = struct.unpack_from("<ii", body, 4)
                height = abs(doubled) // 2
            _check_dims(width, height)
            if width * height > best[0] * best[1]:
                best = (width, height)
        return best
    except struct.error:
        raise IconRejected(UNREADABLE) from None


def normalize(raw: bytes) -> bytes:
    """校验并重新编码成 128×128 透明底 PNG。

    - 原始字节超过 1 MiB 拒绝；只认 PNG、JPEG、WebP、GIF、ICO（SVG、HTML 等一律拒绝）。
    - 解码前按文件头核对尺寸：宽或高超过 4096、或像素超过 1600 万拒绝（挡住解压炸弹）。
    - 动图（GIF、WebP）取第一帧；ICO 取最大的一张。
    - 完整解码后等比缩放进 128×128 透明画布；EXIF、ICC 与附加数据都不保留。
    """
    if len(raw) > MAX_BYTES:
        raise IconRejected("图片超过 1 MB")
    kind = _format(raw)
    if kind is None:
        raise IconRejected("只支持 PNG、JPEG、WebP、GIF、ICO 图片")
    ico_size = _ico_largest(raw) if kind == "ICO" else None
    try:
        with Image.open(BytesIO(raw), formats=[kind]) as image:
            if ico_size is not None:
                image.size = ico_size
            _check_dims(*image.size)
            image.seek(0)
            image.load()
            frame = ImageOps.contain(image.convert("RGBA"), (OUTPUT_SIDE, OUTPUT_SIDE),
                                     Image.Resampling.LANCZOS)
    except IconRejected:
        raise
    except (OSError, ValueError, SyntaxError, EOFError, Image.DecompressionBombError):
        raise IconRejected(UNREADABLE) from None
    canvas = Image.new("RGBA", (OUTPUT_SIDE, OUTPUT_SIDE), (0, 0, 0, 0))
    canvas.paste(frame, ((OUTPUT_SIDE - frame.width) // 2, (OUTPUT_SIDE - frame.height) // 2))
    out = BytesIO()
    canvas.save(out, "PNG", optimize=True)
    return out.getvalue()


def store(raw: bytes) -> str:
    """校验、重新编码并落盘，返回 `file:<sha256>`。同一张图只存一份；再次存入会刷新宽限期。"""
    png = normalize(raw)
    sha = hashlib.sha256(png).hexdigest()
    folder = icons_dir()
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{sha}.png"
    if target.exists():
        os.utime(target)
        return f"file:{sha}"
    fd, temporary = tempfile.mkstemp(prefix=".icon-", suffix=".tmp", dir=folder)
    tmp = Path(temporary)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(png)
        _replace_with_retry(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)
    return f"file:{sha}"


def file_path(sha: str) -> Path | None:
    """sha 只收 64 位小写十六进制；文件不存在（手改配置、拷贝 keys.json、清理竞态）返回 None。"""
    if not _SHA.fullmatch(sha):
        return None
    path = icons_dir() / f"{sha}.png"
    return path if path.is_file() else None


def checked_icon(value: str | None) -> str | None:
    """`KeySpec.icon` 只在 API 写入边界校验：`brand:<id>` 或已落盘的 `file:<sha256>`。"""
    if value is None:
        return None
    kind, _, ident = value.partition(":")
    if kind == "brand" and _BRAND.fullmatch(ident):
        return value
    if kind == "file" and _SHA.fullmatch(ident):
        if file_path(ident) is None:
            raise IconRejected("图标文件不存在，请重新上传")
        return value
    raise IconRejected("图标格式无效")


def referenced_shas(icons: list[str | None]) -> set[str]:
    return {icon[5:] for icon in icons if icon and icon.startswith("file:")}


def prune(referenced: set[str], now: float | None = None) -> None:
    """删除没有 KEY 引用、且超过宽限期的图标文件。调用方持 keys_lock；失败只记日志，不影响 KEY 写入。"""
    folder = icons_dir()
    if not folder.is_dir():
        return
    cutoff = (time.time() if now is None else now) - GRACE_SECONDS
    for path in folder.iterdir():
        stem = path.name.removesuffix(".png")
        ours = (path.suffix == ".png" and _SHA.fullmatch(stem)) or path.name.startswith(".icon-")
        if not ours or stem in referenced:
            continue
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except OSError as error:
            logger.warning("清理供应商图标 %s 失败：%s", path.name, error)
