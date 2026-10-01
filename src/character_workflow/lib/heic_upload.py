"""HEIC / HEIF（iPhone 照片、实况图的静态帧）上传时转成 JPEG。

浏览器（Chrome / Edge）解不了 HEIC，厂商接口也不收，所以不把它存进库：在上传入口一次转成
JPEG，之后的预览、参考图、导出全都按普通图片走。转换时按 EXIF 方向摆正像素，元数据
（含 GPS）不带过去。照片类内容存 JPEG 而不是 PNG：同尺寸 PNG 大 5–10 倍，会顶到图片上传上限。
"""
from __future__ import annotations

import io
from pathlib import Path

HEIC_UPLOAD_EXTS = frozenset({".heic", ".heif"})
_JPEG_QUALITY = 92


class HeicConversionError(ValueError):
    """HEIC 文件解不开（损坏、加密或不是 HEIF 容器）。给画师看的中文原因。"""


def is_heic_upload(filename: str) -> bool:
    return Path(filename).suffix.lower() in HEIC_UPLOAD_EXTS


def convert_heic_to_jpeg(filename: str, body: bytes) -> tuple[str, bytes]:
    """返回 (改成 .jpg 的文件名, JPEG 字节)。CPU 密集，调用方放进线程池。"""
    from PIL import Image, ImageOps
    from pillow_heif import register_heif_opener

    register_heif_opener()
    try:
        with Image.open(io.BytesIO(body)) as image:
            upright = ImageOps.exif_transpose(image).convert("RGB")
    except Exception as error:  # Pillow / libheif 的解码错误类型不统一
        raise HeicConversionError(
            f"「{filename}」无法读取为 HEIC 图片（文件可能损坏），没有上传。"
        ) from error
    output = io.BytesIO()
    upright.save(output, "JPEG", quality=_JPEG_QUALITY, optimize=True)
    return f"{Path(filename).stem or 'photo'}.jpg", output.getvalue()
