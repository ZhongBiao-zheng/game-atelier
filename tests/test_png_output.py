"""出图产物落盘成真 PNG：JPEG / WebP 转码，PNG 原样，认不出的内容原样。"""
from __future__ import annotations

import io

from PIL import Image

from character_workflow.lib.callers.png_output import PNG_SIGNATURE, as_png


def _encode(fmt: str, mode: str = "RGB") -> bytes:
    out = io.BytesIO()
    Image.new(mode, (8, 6), "red").save(out, format=fmt)
    return out.getvalue()


def test_jpeg_and_webp_become_png_with_same_size():
    for fmt in ("JPEG", "WEBP"):
        png = as_png(_encode(fmt))
        assert png.startswith(PNG_SIGNATURE)
        assert Image.open(io.BytesIO(png)).size == (8, 6)


def test_png_and_unknown_bytes_pass_through():
    original = _encode("PNG", "RGBA")
    assert as_png(original) is original
    assert as_png(b"not an image") == b"not an image"
