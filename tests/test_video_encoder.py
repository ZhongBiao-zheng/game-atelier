import os
from pathlib import Path

import pytest

from character_workflow.lib import video_encoder as video


def test_missing_or_tampered_binary(tmp_path, monkeypatch):
    monkeypatch.setattr(video.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(video.platform, "machine", lambda: "arm64")
    monkeypatch.setenv("ATELIER_VIDEO_ENCODER_DIR", str(tmp_path))
    with pytest.raises(video.VideoError, match="找不到"):
        video.resolve_encoder()
    (tmp_path / "SHA256SUMS").write_text("wrong  ffmpeg\n")
    (tmp_path / "ffmpeg").touch()
    with pytest.raises(video.VideoError, match="校验失败"):
        video.resolve_encoder()


@pytest.mark.parametrize("failure, expected", [
    ("binary_launch", "binary_launch"), ("codec_failed", "system_encoder"), ("storage", "storage"),
    ("invalid_output", "corrupt_output"),
])
async def test_availability_errors(tmp_path, monkeypatch, failure, expected):
    async def command(args):
        if failure == "invalid_output":
            return b"{}"
        raise video.VideoError(failure, failure)

    monkeypatch.setattr(video, "command", command)
    with pytest.raises(video.VideoError) as exc:
        await video.smoke(video.Encoder(tmp_path, tmp_path, True), tmp_path)
    assert exc.value.code == expected
    if expected == "system_encoder":
        assert str(exc.value) == "系统 H.264 编码器不可用，请检查媒体组件；Windows N 版请安装媒体功能包并重启后重试。"


async def test_real_availability(tmp_path):
    if not os.environ.get("ATELIER_VIDEO_ENCODER_DIR"):
        pytest.skip("requires packaged native video tools")
    await video.smoke(video.resolve_encoder(), tmp_path)


async def test_unsupported_codec(monkeypatch):
    async def prores(args):
        return b'{"streams":[{"codec_type":"video","codec_name":"prores"}]}'

    monkeypatch.setattr(video, "command", prores)
    with pytest.raises(video.VideoError, match="^不支持这种视频编码$"):
        await video.metadata(video.Encoder(Path("ffmpeg"), Path("ffprobe"), False), Path("clip"))

