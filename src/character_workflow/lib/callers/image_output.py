"""出图产物按真实格式落盘：厂商回 JPEG 就存 .jpg，回 PNG 就存 .png，回 WebP 就存 .webp。

各厂商返回的格式不一（Seedream / Tuzi 常回 JPEG），下游（上传校验、导出、按扩展名判 MIME）都按
扩展名信任内容，所以扩展名必须和文件头一致。不转码：转成 PNG 会让 2048² 的图从约 0.2MB 涨到 5MB。
认不出的内容维持旧行为写成 .png，不新增失败路径。
"""
from __future__ import annotations

from pathlib import Path

_SIGNATURES: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
)


def image_extension(data: bytes) -> str:
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return next((ext for signature, ext in _SIGNATURES if data.startswith(signature)), ".png")


def write_image(output_dir: Path, stem: str, data: bytes) -> Path:
    """Write data as <output_dir>/<stem><real extension>; returns the written path."""
    target = output_dir / f"{stem}{image_extension(data)}"
    target.write_bytes(data)
    return target
