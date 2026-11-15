"""首尾帧补间的默认参数：只给前后端都认定能做首尾帧的模型，取最短时长与最低分辨率。"""
import pytest

from character_workflow.lib.video_caps import first_last_video_defaults


@pytest.mark.parametrize(("protocol", "model", "size", "expected"), [
    ("seedance", "doubao-seedance-1-5-pro-260428", (720, 1280), {"duration": 4, "resolution": "480p", "watermark": False, "ratio": "adaptive"}),
    ("seedance", "doubao-seedance-1-0-pro-250528", (720, 1280), {"duration": 2, "resolution": "480p", "watermark": False, "ratio": "9:16"}),
    ("seedance", "doubao-seedance-2-0-260128", (1024, 1024), {"duration": 4, "resolution": "480p", "watermark": False, "ratio": "adaptive"}),
    ("kling", "kling-v2-1", (1280, 720), {"duration": 5, "ratio": "16:9"}),
    ("klingai", "kling-v3", (1080, 1920), {"duration": 3, "resolution": "720p", "ratio": "9:16"}),
])
def test_cheapest_first_last_parameters(protocol, model, size, expected):
    assert first_last_video_defaults(protocol, model, *size) == expected


@pytest.mark.parametrize(("protocol", "model"), [
    ("klingai", "kling-v3-turbo"),        # 只支持首帧
    ("klingai", "kling-4.0-flash"),       # 只支持首帧
    ("dashscope", "happyhorse-1.0-i2v"),  # 只支持首帧
    ("openrouter", "some/video"),         # 能力随底层厂商，不替用户选
    ("declarative", "custom-video"),
    (None, "anything"),
])
def test_models_without_reliable_first_last_support_are_not_picked(protocol, model):
    assert first_last_video_defaults(protocol, model, 720, 1280) is None
