"""OpenRouter 图片 caller（专用 Image API，非 OpenAI 兼容）。

契约源 openrouter.ai/docs/guides/overview/multimodal/image-generation：
POST {base}/images，参数用 aspect_ratio / resolution / quality / n /
input_references（参考图，image_url 对象数组，收 http(s) 或 base64 data-url），
响应恒为 data[].b64_json（无 url 分支）。

与 openai_image 的关键差异：
- 端点是 /images（不是 /images/generations），无 /images/edits——图生图走
  input_references，文生图/图生图同一端点。
- 尺寸语义：aspect_ratio 收比例串（"16:9"），resolution 收档位（1K/2K/4K）；
  size 收显式 WxH 但与前两者互斥（同发 400）。Studio 对 openrouter 模型按
  ratio 语义发 size（见前端 imageControlCaps），像素串则透传 size。
- quality 仅 gpt-image 族支持（auto/low/medium/high），其余族不发。
"""
from __future__ import annotations

import base64
import re
from pathlib import Path
from typing import Any

from character_workflow.lib import net_env

from .openai_image import OpenAIImageError, _post_json

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"

_PIXEL_SIZE = re.compile(r"\d+x\d+")
_RATIO = re.compile(r"\d+(?:\.\d+)?:\d+(?:\.\d+)?")


def render(
    *,
    prompt: str,
    model: str,
    alias: str,
    output_dir: Path | str,
    n: int = 1,
    timeout: float | tuple[float, float] = net_env.DEFAULT_TIMEOUT,
    **kwargs: Any,
) -> list[str]:
    from character_workflow.lib import keys as _keys

    key = _keys.find_by_alias(alias)
    if key is None:
        raise ValueError(f"alias not found: {alias}")
    if key.provider != "openrouter":
        raise ValueError(f"alias {alias!r} has provider {key.provider!r}, expected openrouter")

    base = (key.base_url or "").strip().rstrip("/") or DEFAULT_BASE_URL
    url = f"{base}/images"
    requested = max(1, int(n or 1))

    def _payload(num: int) -> dict:
        return _image_payload(prompt=prompt, model=model, n=num, kwargs=kwargs)

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    data = _post_json(url, key.access_key, _payload(requested), timeout=timeout)
    paths = _write_outputs(data, out_dir)
    # 部分模型忽略 n 只回 1 张，循环补足（与 openai_image 同策略）。
    while len(paths) < requested:
        data = _post_json(url, key.access_key, _payload(1), timeout=timeout)
        paths.extend(_write_outputs(data, out_dir, start_index=len(paths) + 1))
    return paths[:requested]


def _image_payload(*, prompt: str, model: str, n: int, kwargs: dict) -> dict:
    params = kwargs.get("params") or {}
    payload: dict[str, Any] = {"model": model, "prompt": prompt, "n": n}

    size = kwargs.get("size") or params.get("size")
    ratio = params.get("ratio")
    if isinstance(size, str) and _PIXEL_SIZE.fullmatch(size.strip()):
        # 显式像素是权威值，与 aspect_ratio/resolution 互斥（同发 400）。
        payload["size"] = size.strip()
    else:
        if isinstance(size, str) and _RATIO.fullmatch(size.strip()):
            payload["aspect_ratio"] = size.strip()
        elif isinstance(ratio, str) and _RATIO.fullmatch(ratio.strip()):
            payload["aspect_ratio"] = ratio.strip()
        resolution = params.get("resolution")
        if isinstance(resolution, str) and resolution.strip():
            payload["resolution"] = resolution.strip().upper()

    quality = kwargs.get("quality") or params.get("quality")
    if _is_gpt_image(model) and quality in ("low", "medium", "high", "auto"):
        payload["quality"] = quality

    refs = _reference_urls(kwargs, params)
    if refs:
        payload["input_references"] = [
            {"type": "image_url", "image_url": {"url": u}} for u in refs
        ]
    return payload


def _is_gpt_image(model: str) -> bool:
    # OpenRouter slug 形如 openai/gpt-image-2，按尾段判族。
    return (model or "").lower().rsplit("/", 1)[-1].startswith("gpt-image")


def _reference_urls(kwargs: dict, params: dict) -> list[str]:
    paths: list[str] = []
    source_image = kwargs.get("source_image") or params.get("source_image")
    if source_image:
        paths.append(str(source_image))
    for ref in (kwargs.get("reference_images") or params.get("reference_images") or []):
        if str(ref) not in paths:
            paths.append(str(ref))
    return [_as_payload_url(p) for p in paths]


def _as_payload_url(path_or_url: str) -> str:
    s = str(path_or_url).strip()
    if s.startswith(("http://", "https://", "data:")):
        return s
    raw = Path(s).read_bytes()
    ext = Path(s).suffix.lstrip(".").lower() or "png"
    mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


def _write_outputs(payload: dict, output_dir: Path, *, start_index: int = 1) -> list[str]:
    items = payload.get("data")
    if not isinstance(items, list) or not items:
        raise OpenAIImageError(f"openrouter image response missing data: {payload!r}")
    paths: list[str] = []
    for i, item in enumerate(items, start=start_index):
        if not isinstance(item, dict):
            continue
        b64 = item.get("b64_json")
        if not (isinstance(b64, str) and b64):
            continue
        target = output_dir / f"v{i}.png"
        target.write_bytes(base64.b64decode(b64))
        paths.append(str(target))
    if not paths:
        raise OpenAIImageError(f"openrouter image response has no b64_json: {payload!r}")
    return paths
