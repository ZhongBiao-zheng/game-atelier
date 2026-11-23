"""Decode isolated provider outputs before publishing any bytes to a report."""

import hashlib
import math
from pathlib import Path
import tempfile

from PIL import Image, ImageOps


def video_contact_sheet(path):
    import cv2

    # Results are local media, never a URL playlist or decoder script.
    with path.open("rb") as file:
        header = file.read(16)
    if header[4:8] not in (b"ftyp", b"moov", b"wide", b"free", b"mdat") and not (
        header.startswith(b"\x1a\x45\xdf\xa3") or header[:4] == b"RIFF" and header[8:12] == b"AVI "
    ):
        raise ValueError("未知视频容器")
    capture = cv2.VideoCapture(str(path))
    try:
        frame_count = capture.get(cv2.CAP_PROP_FRAME_COUNT)
        count = int(frame_count) if math.isfinite(frame_count) and frame_count > 0 else 0
        fps = capture.get(cv2.CAP_PROP_FPS)
        duration_s = count / fps if count and math.isfinite(fps) and fps > 0 else None
        positions = sorted({round(max(count - 1, 0) * n / 5) for n in range(6)})
        frames = []
        for position in positions:
            capture.set(cv2.CAP_PROP_POS_FRAMES, position)
            ok, raw = capture.read()
            if ok:
                frame = Image.fromarray(cv2.cvtColor(raw, cv2.COLOR_BGR2RGB))
                if not frames:
                    size = frame.size
                frame.thumbnail((768, 512), Image.Resampling.LANCZOS)
                frames.append(frame)
        if not frames:
            raise ValueError("无法解码视频")
        w, h = frames[0].size
        columns = min(len(frames), 3)
        sheet = Image.new("RGB", (columns * w, math.ceil(len(frames) / columns) * h))
        for i, frame in enumerate(frames):
            sheet.paste(frame, (i % columns * w, i // columns * h))
        return sheet, size, duration_s
    finally:
        capture.release()


def save_output(response, scratch, directory, stem, kind):
    # Never write the source bytes into the report. Error pages, PNG comments, EXIF,
    # ICC profiles and video metadata can all contain provider credentials or signed URLs.
    with tempfile.TemporaryDirectory(dir=scratch) as work:
        source = Path(work) / "provider-output"
        source_hash = hashlib.sha256()
        with source.open("wb") as dest:
            for part in response.iter_content(1024 * 1024):
                source_hash.update(part)
                dest.write(part)
        source_sha256 = source_hash.hexdigest()
        if kind == "video":
            sheet, size, duration_s = video_contact_sheet(source)
            path = directory / f"{stem}-contact.jpg"
            sheet.save(path, quality=90)
            return {
                "path": path.name,
                "kind": kind,
                "artifact": "contact_sheet",
                "source_width": size[0],
                "source_height": size[1],
                "source_sha256": source_sha256,
                "duration_s": duration_s,
            }
        if kind != "image":
            raise ValueError("未知结果类型")
        with Image.open(
            source, formats=("PNG", "JPEG", "WEBP", "BMP", "TIFF", "GIF", "AVIF")
        ) as image:
            pixels = ImageOps.exif_transpose(image)
            if (
                pixels.mode not in ("1", "L", "LA", "RGB", "RGBA", "I;16")
                or "transparency" in pixels.info
            ):
                pixels = pixels.convert("RGBA" if pixels.has_transparency_data else "RGB")
            # Start with a fresh pixel buffer; copying Image.info or EXIF reintroduces metadata.
            clean = Image.new(pixels.mode, pixels.size)
            clean.paste(pixels)
            path = directory / f"{stem}.png"
            clean.save(path, format="PNG")
        return {"path": path.name, "kind": kind, "source_sha256": source_sha256}
