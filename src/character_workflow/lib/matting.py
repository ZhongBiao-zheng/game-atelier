"""本地抠图：BiRefNet-general-lite（MIT）+ onnxruntime，模型按需下载到 <data_root>/.config/models/。

选型与实测（2026-09-04，M1 Pro，1024² 输入）：CPU fp32 约 9.5s；fp16 在 CPU 上更慢（内核先转回
fp32）；CoreML EP 编译要么失败（ASPP 空洞卷积缺 pad）要么比 CPU 慢 3-13 倍。所以只发 fp32 文件，
执行后端按 onnxruntime 实际可用的 provider 挑：CUDA / DirectML 装了就用，否则 CPU。
"""
from __future__ import annotations

import hashlib
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import requests
from PIL import Image

from character_workflow.lib import data_root, net_env

MODEL_ID = "birefnet-general-lite"
_MODEL_FILENAME = "birefnet-general-lite-fp32.onnx"
_MODEL_BYTES = 224_005_088
_MODEL_SHA256 = "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333"
# 同一份文件两个源：hf-mirror 给国内直连，huggingface.co 兜底。
_MODEL_URLS = (
    "https://hf-mirror.com/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx",
    "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx",
)
_INPUT_SIZE = 1024
_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
# 顺序即优先级；onnxruntime 只报告当前安装包里编译进去的 provider。
_PROVIDER_PREFERENCE = (
    "CUDAExecutionProvider",
    "DmlExecutionProvider",
    "CPUExecutionProvider",
)

_session_lock = threading.Lock()
_session: Any = None


class MattingModelMissing(RuntimeError):
    """模型文件还没下载；调用方决定是提示下载还是直接失败。"""


@dataclass(frozen=True)
class MattingModelStatus:
    model_id: str
    ready: bool
    bytes: int
    provider: str
    available: bool
    message: str | None


UNAVAILABLE_MESSAGE = "本机抠图需要 onnxruntime，当前平台（如 Intel Mac）没有对应安装包。"


def runtime_available() -> bool:
    """onnxruntime 按平台条件安装（见 pyproject）；缺失时抠图整体不可用，其余功能不受影响。"""
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        return False
    return True


def models_dir() -> Path:
    return data_root.config_dir() / "models"


def model_path() -> Path:
    return models_dir() / _MODEL_FILENAME


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def selected_provider() -> str:
    if not runtime_available():
        return "unavailable"
    import onnxruntime as ort

    available = set(ort.get_available_providers())
    return next(
        (name for name in _PROVIDER_PREFERENCE if name in available),
        "CPUExecutionProvider",
    )


def model_status() -> MattingModelStatus:
    path = model_path()
    available = runtime_available()
    return MattingModelStatus(
        model_id=MODEL_ID,
        ready=available and path.is_file() and path.stat().st_size == _MODEL_BYTES,
        bytes=_MODEL_BYTES,
        provider=selected_provider(),
        available=available,
        message=None if available else UNAVAILABLE_MESSAGE,
    )


def ensure_model() -> Path:
    """下载并校验模型；已存在且完整就直接返回。流式写 tmp，sha256 对上才 replace 到位。"""
    if not runtime_available():
        raise RuntimeError(UNAVAILABLE_MESSAGE)
    path = model_path()
    if path.is_file() and path.stat().st_size == _MODEL_BYTES:
        return path
    net_env.configure_proxy_bypass()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    last_error: Exception | None = None
    for url in _MODEL_URLS:
        try:
            with requests.get(url, stream=True, timeout=(30.0, 120.0)) as response:
                response.raise_for_status()
                with tmp.open("wb") as handle:
                    for chunk in response.iter_content(chunk_size=4 * 1024 * 1024):
                        handle.write(chunk)
            if tmp.stat().st_size != _MODEL_BYTES or _file_sha256(tmp) != _MODEL_SHA256:
                raise RuntimeError("downloaded model failed integrity check")
            os.replace(tmp, path)
            return path
        except (requests.RequestException, RuntimeError, OSError) as error:
            last_error = error
            tmp.unlink(missing_ok=True)
    raise RuntimeError(f"抠图模型下载失败：{last_error}")


def _get_session() -> Any:
    global _session
    with _session_lock:
        if _session is None:
            if not runtime_available():
                raise MattingModelMissing(UNAVAILABLE_MESSAGE)
            path = model_path()
            if not (path.is_file() and path.stat().st_size == _MODEL_BYTES):
                raise MattingModelMissing("抠图模型尚未下载")
            import onnxruntime as ort

            options = ort.SessionOptions()
            options.log_severity_level = 3
            _session = ort.InferenceSession(
                str(path), options, providers=[selected_provider()],
            )
        return _session


def remove_background(image: Image.Image) -> Image.Image:
    """返回 RGBA；源图自带的透明度与预测出的前景掩码相乘，不会把已透明区域补回来。"""
    session = _get_session()
    rgba = image.convert("RGBA")
    # 透明区域喂黑色会被模型当成实体前景（实测），先合成到白底。
    flat = Image.alpha_composite(Image.new("RGBA", rgba.size, (255, 255, 255, 255)), rgba)
    resized = flat.convert("RGB").resize((_INPUT_SIZE, _INPUT_SIZE), Image.Resampling.BILINEAR)
    array = np.asarray(resized, dtype=np.float32) / 255.0
    tensor = ((array - _MEAN) / _STD).transpose(2, 0, 1)[None]
    logits = session.run(None, {session.get_inputs()[0].name: tensor})[0]
    alpha = 1.0 / (1.0 + np.exp(-logits.astype(np.float32)[0, 0]))
    # sigmoid 在实体前景上只到 0.98-0.99（实测输出 alpha 停在 252-254，整张图带 1% 半透明雾）；
    # 两端各留 2% 拉伸到 [0, 1]，前景归满 255、背景归 0，边缘过渡带保留。
    alpha = np.clip((alpha - 0.02) / 0.96, 0.0, 1.0)
    mask = Image.fromarray(np.rint(alpha * 255).astype(np.uint8), "L").resize(
        rgba.size, Image.Resampling.BILINEAR,
    )
    combined = np.asarray(mask, dtype=np.float32) * np.asarray(rgba.split()[3], dtype=np.float32)
    rgba.putalpha(Image.fromarray(np.rint(combined / 255).astype(np.uint8), "L"))
    return rgba
