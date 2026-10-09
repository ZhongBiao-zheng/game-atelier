"""出图产物一律落成真 PNG。

各厂商返回的格式不一（Seedream / Tuzi 常回 JPEG，也有 WebP），而产物文件名统一是 `.png`，
下游（上传校验、导出、扩展名判类型）都按扩展名信任内容。名实不符的文件会在别处被拒或误判，
所以写盘前把非 PNG 解码再存成 PNG：已经是 PNG 的原样写，不重复编码；解不开的内容原样写。
"""
from __future__ import annotations

import io
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def as_png(data: bytes) -> bytes:
    if data.startswith(PNG_SIGNATURE):
        return data
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            # JPEG 的方向写在 EXIF 里，PNG 不带 EXIF：先摆正，画面才和原图一致。
            converted = ImageOps.exif_transpose(image)
            if converted.mode not in {"RGB", "RGBA", "L", "LA", "P"}:
                converted = converted.convert("RGBA" if "A" in converted.mode else "RGB")
            out = io.BytesIO()
            converted.save(out, format="PNG")
            return out.getvalue()
    except (UnidentifiedImageError, OSError):
        # 认不出的内容维持旧行为原样写盘：转码只修「是图但格式不对」，不新增失败路径。
        return data


def write_png(path: Path, data: bytes) -> None:
    path.write_bytes(as_png(data))
