"""GIF 上传时转成 PNG（只取第一帧）。

库里的图片只存 png / jpg / webp：参考图要原样发给厂商，gpt-image 等接口不收 GIF。和 HEIC 一样
在上传入口一次转换，之后的预览、参考图、导出全都按普通图片走。按内容认 GIF：微信下载的表情图
常是 GIF 内容配 .jpg 后缀。GIF 是调色板图，转 PNG 无损，体积也在同一量级。
"""
from __future__ import annotations

import io
from pathlib import Path

GIF_UPLOAD_EXTS = frozenset({".gif"})


class GifConversionError(ValueError):
    """GIF 文件解不开（损坏或截断）。给画师看的中文原因。"""


def is_gif_content(body: bytes) -> bool:
    return body.startswith((b"GIF87a", b"GIF89a"))


def convert_gif_to_png(filename: str, body: bytes) -> tuple[str, bytes]:
    """返回 (改成 .png 的文件名, 第一帧 PNG 字节)。CPU 密集，调用方放进线程池。"""
    from PIL import Image

    try:
        with Image.open(io.BytesIO(body)) as image:
            image.seek(0)
            frame = image.convert("RGBA")
    except Exception as error:  # Pillow 的解码错误类型不统一
        raise GifConversionError(
            f"「{filename}」无法读取为 GIF 图片（文件可能损坏），没有上传。"
        ) from error
    output = io.BytesIO()
    frame.save(output, "PNG", optimize=True)
    return f"{Path(filename).stem or 'image'}.png", output.getvalue()
