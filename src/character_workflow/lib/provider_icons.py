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
import time
from io import BytesIO
from pathlib import Path

from PIL import Image

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_bytes

logger = logging.getLogger(__name__)

MAX_BYTES = 1 << 20
# 供应商图标用不到更大的图；4000×4000 归一一次要多占约 150 MB 内存。
MAX_SIDE = 2048
# 再扁就缩不进 128 的画布（短边不足 1 像素）。
MAX_ASPECT = 256
OUTPUT_SIDE = 128
# 上传后、表单保存前，别的 KEY 写入会触发清理：一小时内的未引用文件不删，保存后引用不会悬空。
GRACE_SECONDS = 3600
UNREADABLE = "图片无法识别"
TOO_LARGE = "图片超过 1 MB"
TOO_BIG = f"图片尺寸超过 {MAX_SIDE}×{MAX_SIDE}"
UNSUPPORTED = "不支持这种图片格式"
TOO_NARROW = "图片长宽比过大"

_SHA = re.compile(r"[0-9a-f]{64}")
_BRAND = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
# atomic_write_bytes 的临时文件：<sha>.<uuid>.tmp
_LEFTOVER = re.compile(r"[0-9a-f]{64}\.[0-9a-f]{32}\.tmp")
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


def is_image(raw: bytes) -> bool:
    return _format(raw) is not None


def _check_dims(width: int, height: int) -> None:
    if width <= 0 or height <= 0:
        raise IconRejected(UNREADABLE)
    if width > MAX_SIDE or height > MAX_SIDE:
        raise IconRejected(TOO_BIG)
    if max(width, height) > MAX_ASPECT * min(width, height):
        raise IconRejected(TOO_NARROW)


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


def _fit(image: Image.Image) -> Image.Image:
    """等比缩放到长边 128；短边至少 1 像素（256:1 时按四舍五入会变成 0）。"""
    scale = OUTPUT_SIDE / max(image.size)
    size = tuple(max(1, round(side * scale)) for side in image.size)
    return image.resize(size, Image.Resampling.LANCZOS)


def normalize(raw: bytes) -> bytes:
    """校验并重新编码成 128×128 透明底 PNG。

    - 原始字节超过 1 MiB 拒绝；只认 PNG、JPEG、WebP、GIF、ICO（SVG、HTML 等一律拒绝）。
    - 解码前按文件头核对尺寸：宽或高超过 2048 拒绝（挡住解压炸弹）；长宽比超过 256:1 拒绝。
    - 动图（GIF、WebP）取第一帧；ICO 取最大的一张。
    - 完整解码后等比缩放进 128×128 透明画布；EXIF、ICC 与附加数据都不保留。
    """
    if len(raw) > MAX_BYTES:
        raise IconRejected(TOO_LARGE)
    kind = _format(raw)
    if kind is None:
        raise IconRejected(UNSUPPORTED)
    ico_size = _ico_largest(raw) if kind == "ICO" else None
    try:
        with Image.open(BytesIO(raw), formats=[kind]) as image:
            if ico_size is not None:
                image.size = ico_size
            _check_dims(*image.size)
            image.seek(0)
            image.load()
            frame = _fit(image.convert("RGBA"))
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
    target = icons_dir() / f"{sha}.png"
    try:
        os.utime(target)
    except FileNotFoundError:
        # 新图，或旧文件刚被清理掉：按新文件写入。
        atomic_write_bytes(target, png)
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


def brand_icon(value: object) -> str | None:
    """`brand:<id>` 原样返回，其余（含非字符串）一律 None：网关快照里的 icon 来自另一台主机。"""
    if isinstance(value, str) and value.startswith("brand:") and _BRAND.fullmatch(value[6:]):
        return value
    return None


def referenced_shas(icons: list[str | None]) -> set[str]:
    return {icon[5:] for icon in icons if icon and icon.startswith("file:")}


def prune(referenced: set[str], now: float | None = None) -> None:
    """删除没有 KEY 引用、且超过宽限期的图标文件。调用方持 keys_lock。

    keys.json 此时已经替换完成：清理的任何失败都只记日志，不能让调用方以为没写成而回滚。"""
    try:
        _prune(referenced, (time.time() if now is None else now) - GRACE_SECONDS)
    except Exception:  # noqa: BLE001 —— 目录不可读、权限变化等都不影响保存供应商
        logger.warning("清理供应商图标失败", exc_info=True)


def _prune(referenced: set[str], cutoff: float) -> None:
    folder = icons_dir()
    if not folder.is_dir():
        return
    for path in folder.iterdir():
        stem = path.name.removesuffix(".png")
        ours = (path.suffix == ".png" and _SHA.fullmatch(stem)) or _LEFTOVER.fullmatch(path.name)
        if not ours or stem in referenced:
            continue
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except OSError as error:
            logger.warning("清理供应商图标 %s 失败：%s", path.name, error)
