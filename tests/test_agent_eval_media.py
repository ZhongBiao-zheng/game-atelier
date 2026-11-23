import hashlib
import io
from pathlib import Path

import pytest
from PIL import Image, PngImagePlugin

from scripts.agent_eval.media_artifacts import save_output
from scripts.agent_eval.report import write_report


class Body:
    def __init__(self, content):
        self.content = content

    def iter_content(self, size):
        yield self.content[:11]
        yield self.content[11:]


def test_artifacts_contain_only_decoded_pixels(tmp_path):
    secret = b"synthetic-private-token-to-strip"
    image = Image.new("RGBA", (32, 48), (130, 61, 0, 142))
    info = PngImagePlugin.PngInfo()
    info.add_text("request", "https://provider.invalid/signed?key=" + secret.decode())
    buf = io.BytesIO()
    image.save(buf, format="PNG", pnginfo=info)
    scratch, outputs = tmp_path / "isolated", tmp_path / "reports"
    scratch.mkdir()
    outputs.mkdir()
    item = save_output(Body(buf.getvalue()), scratch, outputs, "generation-01", "image")
    assert item["source_sha256"] == hashlib.sha256(buf.getvalue()).hexdigest()
    assert (
        item["source_sha256"] != hashlib.sha256((outputs / item["path"]).read_bytes()).hexdigest()
    )
    with Image.open(outputs / item["path"]) as clean:
        assert not clean.info and clean.tobytes() == image.tobytes() and clean.size == image.size
    assert secret not in (outputs / item["path"]).read_bytes() and not list(scratch.iterdir())
    with pytest.raises(OSError):
        save_output(
            Body(b'{"Authorization":"Bearer ' + secret + b'"}'),
            scratch,
            outputs,
            "generation-02",
            "image",
        )
    assert [p.name for p in outputs.iterdir()] == [item["path"]] and not list(scratch.iterdir())


def test_video_report_keeps_only_contact_sheet_and_original_frame_dimensions(tmp_path):
    from tests.test_agent_eval_report import _row

    entry = _row()
    directory = tmp_path / entry["directory"]
    scratch = tmp_path / "isolated"
    directory.mkdir()
    scratch.mkdir()
    data = (Path(__file__).parent / "fixtures/video/h264-24f.mp4").read_bytes()
    # MP4 readers ignore trailing data; a faithful raw copy would leak this synthetic value.
    secret = b"secret-url-in-trailing-video-data"
    item = save_output(Body(data + secret), scratch, directory, "generation-01", "video")
    assert item["source_sha256"] == hashlib.sha256(data + secret).hexdigest()
    assert item["duration_s"] == pytest.approx(1.0)  # Fixture has 24 frames at 24 fps.
    entry["generations"][0].update(kind="video", outputs=[item])
    write_report(tmp_path, [entry])
    with Image.open(directory / item["path"]) as sheet:
        assert sheet.size != (item["width"], item["height"])
        assert (item["width"], item["height"]) == (item["source_width"], item["source_height"])
    assert not list(directory.glob("*.mp4"))
    assert all(secret not in p.read_bytes() for p in tmp_path.rglob("*") if p.is_file())
    assert item["path"] in (tmp_path / "index.html").read_text()


def test_video_without_timing_is_still_visible_but_duration_is_unknown(tmp_path, monkeypatch):
    import cv2
    import numpy as np

    class UntimedVideo:
        def get(self, prop):
            return 1 if prop == cv2.CAP_PROP_FRAME_COUNT else float("nan")

        def read(self):
            return True, np.zeros((4, 6, 3), dtype=np.uint8)

        def set(self, *args):
            pass

        def release(self):
            pass

    monkeypatch.setattr(cv2, "VideoCapture", lambda *_: UntimedVideo())
    item = save_output(Body(b"\0\0\0\x10ftypisom"), tmp_path, tmp_path, "untimed", "video")
    assert item["duration_s"] is None and (tmp_path / item["path"]).is_file()
