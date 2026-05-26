"""OpenAI-compatible image generation caller for seedream/custom providers."""
from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_SEEDREAM_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"


class OpenAIImageError(RuntimeError):
    pass


def render(
    *,
    prompt: str,
    model: str,
    alias: str,
    output_dir: Path | str,
    n: int = 1,
    timeout: float = 600.0,
    **kwargs: Any,
) -> list[str]:
    from character_workflow.lib import keys as _keys

    key = _keys.find_by_alias(alias)
    if key is None:
        raise ValueError(f"alias not found: {alias}")
    if key.provider not in ("seedream", "custom"):
        raise ValueError(f"alias {alias!r} has provider {key.provider!r}, expected seedream/custom")

    base_url = (key.base_url or "").strip()
    if not base_url and key.provider == "seedream":
        base_url = DEFAULT_SEEDREAM_BASE_URL
    if not base_url:
        raise OpenAIImageError("custom provider requires base_url")

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "model": model,
        "prompt": prompt,
        "size": kwargs.get("size") or kwargs.get("requested_size") or kwargs.get("params", {}).get("size"),
        "response_format": "url",
        "stream": False,
        "watermark": True,
    }
    if n > 1:
        payload["sequential_image_generation"] = "auto"
        payload["sequential_image_generation_options"] = {"max_images": n}
    payload = {k: v for k, v in payload.items() if v is not None}
    data = _post_json(_image_url(base_url), key.access_key, payload, timeout=timeout)
    return _write_outputs(data, out_dir)


def _image_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/images/generations"):
        return base
    return f"{base}/images/generations"


def _post_json(url: str, api_key: str, payload: dict, *, timeout: float) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise OpenAIImageError(f"image api {e.code}: {body[:500]}") from e
    except Exception as e:
        raise OpenAIImageError(str(e)) from e


def _write_outputs(payload: dict, output_dir: Path) -> list[str]:
    items = payload.get("data")
    if not isinstance(items, list) or not items:
        raise OpenAIImageError(f"image api response missing data: {payload!r}")

    paths: list[str] = []
    for i, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue
        target = output_dir / f"v{i}.png"
        if isinstance(item.get("b64_json"), str):
            target.write_bytes(base64.b64decode(item["b64_json"]))
            paths.append(str(target))
            continue
        if isinstance(item.get("url"), str):
            with urllib.request.urlopen(item["url"], timeout=180.0) as resp:
                target.write_bytes(resp.read())
            paths.append(str(target))
    if not paths:
        raise OpenAIImageError(f"image api returned no downloadable image: {payload!r}")
    return paths
