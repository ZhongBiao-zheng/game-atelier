"""只读盒结构探媒体像素尺寸，不解码。出片（canvas_runs）与画布上传（canvas_projects）共用。"""
from __future__ import annotations

from pathlib import Path


def mp4_track_dimensions(data: bytes) -> tuple[int, int] | None:
    """扫 ISO BMFF（mp4 / mov）的 moov→trak→tkhd，取第一条有像素尺寸的轨。

    tkhd 里宽高是 16.16 定点数；只读盒结构不解码，几十 KB 的头就够（moov 在文件头或尾，
    调用方把整个文件给进来也没事）。认不出返回 None，由调用方按请求的比例兜底。
    """
    def boxes(start: int, end: int):
        offset = start
        while offset + 8 <= end:
            size = int.from_bytes(data[offset:offset + 4], "big")
            kind = data[offset + 4:offset + 8]
            header = 8
            if size == 1 and offset + 16 <= end:
                size = int.from_bytes(data[offset + 8:offset + 16], "big")
                header = 16
            elif size == 0:
                size = end - offset
            if size < header:
                return
            yield kind, offset + header, min(offset + size, end)
            offset += size

    def find(kind: bytes, start: int, end: int):
        for box_kind, body_start, body_end in boxes(start, end):
            if box_kind == kind:
                yield body_start, body_end

    for moov_start, moov_end in find(b"moov", 0, len(data)):
        for trak_start, trak_end in find(b"trak", moov_start, moov_end):
            for tkhd_start, tkhd_end in find(b"tkhd", trak_start, trak_end):
                version = data[tkhd_start] if tkhd_start < tkhd_end else 0
                # v0: 4 flags + 4×5 fields + 8 reserved + 2+2 layer/group + 2 volume + 2 reserved + 36 matrix = 76
                # v1: creation/modification/duration 各多 4 字节 = 88
                width_at = tkhd_start + (88 if version == 1 else 76)
                if width_at + 8 > tkhd_end:
                    continue
                width = int.from_bytes(data[width_at:width_at + 4], "big") >> 16
                height = int.from_bytes(data[width_at + 4:width_at + 8], "big") >> 16
                if width > 0 and height > 0:
                    return width, height
    return None


def video_dimensions(path: Path) -> tuple[int, int] | None:
    """mp4 / mov → (宽, 高)；webm 等其它容器返回 None。"""
    if not path.exists() or path.stat().st_size <= 0:
        return None
    data = path.read_bytes()
    return mp4_track_dimensions(data)
