"""Synthetic timestamp, rotation, VFR and AAC markers from the native encoder qualification."""
import json
import os
from pathlib import Path

import cv2
import numpy as np
import pytest

from character_workflow.lib.schemas import VideoTrim
from character_workflow.lib.video_encoder import command, metadata, resolve_encoder
from character_workflow.lib.video_render import encode


@pytest.fixture
def native():
    if not os.environ.get("ATELIER_VIDEO_ENCODER_DIR"):
        pytest.skip("requires packaged native video tools")
    return resolve_encoder()


async def sample(native, tmp_path, name):
    existing = os.environ.get("ATELIER_VIDEO_TEST_SAMPLES")
    if existing:
        return Path(existing) / (name + ".mp4")
    output = tmp_path / (name + ".mp4")
    if name == "rotation":
        wide = await sample(native, tmp_path, "wide")
        await command([native.ffmpeg, "-v", "error", "-display_rotation", "90", "-i", wide,
                       "-map", "0", "-c", "copy", output])
        return output
    inputs = ["-f", "lavfi", "-i", "testsrc2=size=320x192:rate=24:duration=3"]
    if name != "silent":
        inputs += ["-f", "lavfi", "-i",
                   r"aevalsrc=0.55*sin(2*PI*880*t)*between(t\,0.75\,1):s=48000:d=3,aformat=sample_fmts=s16"]
    stamp = ["drawbox=x=0:y=0:w=116:h=20:c=black:t=fill"]
    for bit in range(7):
        stamp.append(f"drawbox=x={bit * 16 + 2}:y=2:w=12:h=16:c=white:t=fill:"
                     f"enable='mod(floor(n/{2**bit}),2)'")
    if name == "vfr":
        stamp.append("select='lt(t,1.5)+not(mod(n,2))'")
    await command([native.ffmpeg, "-v", "error", *inputs, "-vf", ",".join(stamp), "-fps_mode", "vfr",
                   *native.codec(1800), "-c:a", "aac", output])
    return output


async def check_output(native, path, seconds, audio, size):
    streams = json.loads(await command([native.ffprobe, "-v", "error", "-show_streams",
                                         "-of", "json", path]))["streams"]
    video, *sound = streams
    assert (video["width"], video["height"]) == size
    assert (video["codec_name"], video["pix_fmt"]) == ("h264", "yuv420p")
    assert abs(int(video["nb_frames"]) - seconds * 24) <= 1
    assert all(abs(float(s["duration"]) - seconds) <= 1/24 + 0.00001 for s in streams)
    assert [s["codec_name"] for s in sound] == (["aac"] if audio else [])
    data = path.read_bytes()
    assert 0 < data.index(b"moov") < data.index(b"mdat")


@pytest.mark.parametrize("name", ["wide", "rotation", "silent", "vfr"])
async def test_trim_native(native, tmp_path, name):
    path = await sample(native, tmp_path, name)
    output = tmp_path / "剪辑 result.mp4"
    operation = VideoTrim(kind="video_trim", start_ms=500, end_ms=1500)
    await encode(native, path, output, await metadata(native, path), operation, lambda ms: None)
    await check_output(native, output, 1, name != "silent", (192, 320) if name == "rotation" else (320, 192))
    if name == "wide":
        cap = cv2.VideoCapture(str(output))
        try:
            codes = []
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                codes.append(sum(1 << i for i in range(7) if frame[10, 8+16*i].mean() > 128))
            assert codes == list(range(12, 36))
        finally:
            cap.release()
        pcm = np.frombuffer(await command([native.ffmpeg, "-v", "error", "-i", output,
                                           "-map", "0:a", "-ac", "1", "-ar", "48000",
                                           "-f", "s16le", "-"]), dtype="<i2")
        for time, loud in ((0.1, False), (0.3, True), (0.7, False)):
            segment = pcm[int(time*48000):int(time*48000)+960].astype(float)
            assert (np.sqrt(np.mean(segment**2)) > 700) == loud


@pytest.mark.parametrize("name,quality", [("rotation", "high"), ("silent", "small"),
                                           ("vfr", "standard"), ("wide", "small")])
async def test_compress_native(native, tmp_path, name, quality):
    from character_workflow.lib.schemas import VideoCompress

    path = await sample(native, tmp_path, name)
    output = tmp_path / "压缩.mp4"
    operation = VideoCompress(kind="video_compress", max_long_edge=160, quality=quality)
    await encode(native, path, output, await metadata(native, path), operation, lambda ms: None)
    await check_output(native, output, 3, name != "silent", (96, 160) if name == "rotation" else (160, 96))
    assert output.stat().st_size < path.stat().st_size
