"""出图产物按真实格式落盘：JPEG 存 .jpg、PNG 存 .png、WebP 存 .webp，内容原样不转码。"""
from __future__ import annotations

import io

import pytest
from PIL import Image

from character_workflow.lib.callers.image_output import write_image


def _encode(fmt: str) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (8, 6), "red").save(out, format=fmt)
    return out.getvalue()


@pytest.mark.parametrize(("fmt", "suffix"), [("JPEG", ".jpg"), ("PNG", ".png"), ("WEBP", ".webp")])
def test_extension_follows_real_format_and_bytes_are_untouched(tmp_path, fmt, suffix):
    data = _encode(fmt)
    path = write_image(tmp_path, "v1", data)
    assert path == tmp_path / f"v1{suffix}"
    assert path.read_bytes() == data


def test_unknown_bytes_keep_old_png_name(tmp_path):
    assert write_image(tmp_path, "v2", b"not an image").name == "v2.png"
