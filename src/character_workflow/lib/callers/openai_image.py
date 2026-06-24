"""OpenAI-compatible image generation caller for openai/seedream/custom providers."""
from __future__ import annotations

import base64
from collections.abc import Mapping
from http.client import IncompleteRead
import json
import math
import re
import subprocess
import urllib.error
import urllib.request
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests

from character_workflow.lib import net_env

DEFAULT_SEEDREAM_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
DEFAULT_TOKENDANCE_BASE_URL = "https://tokendance.space/gateway/v1"
_KNOWN_ENDPOINT_SUFFIXES = (
    "/images/generations",
    "/images/edits",
    "/chat/completions",
    "/completions",
    "/embeddings",
    "/moderations",
)


class OpenAIImageError(RuntimeError):
    pass


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
    if key.provider not in ("openai", "seedream", "tokendance", "custom"):
        raise ValueError(
            f"alias {alias!r} has provider {key.provider!r}, "
            "expected openai/seedream/tokendance/custom"
        )

    base_url = (key.base_url or "").strip()
    if not base_url:
        if key.provider == "openai":
            base_url = DEFAULT_OPENAI_BASE_URL
        elif key.provider == "seedream":
            base_url = DEFAULT_SEEDREAM_BASE_URL
        elif key.provider == "tokendance":
            base_url = DEFAULT_TOKENDANCE_BASE_URL
    if not base_url:
        raise OpenAIImageError("custom provider requires base_url")

    requested_size = _normalize_size_for_provider(
        kwargs.get("size") or kwargs.get("requested_size") or kwargs.get("params", {}).get("size"),
        key.provider,
    )

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    is_hk = _is_openai_hk(base_url)
    requested = max(1, int(n or 1))

    # HK gpt-image 只认尺寸表的精确 WxH；表外值（如立绘常用的 1024x1536）会被出成正方形。
    # snap 到表内最近值，让 skill 立绘 / Studio 两条路径都拿到正确竖图。nano-banana 收比例串，不碰。
    if is_hk and model.startswith("gpt-image"):
        requested_size = _snap_hk_gpt_image_size(requested_size)

    # OpenAI-HK 的非图像模型回退 chat 模式（从 markdown/url 提取图）。
    # gpt-image / nano-banana 走真正的 images 端点，size 与 quality 才会生效。
    if is_hk and not _hk_image_model(model):
        image_paths: list[str] = []
        source_image = kwargs.get("source_image") or (kwargs.get("params") or {}).get("source_image")
        if source_image:
            image_paths.append(str(source_image))
        for ref in (kwargs.get("reference_images") or (kwargs.get("params") or {}).get("reference_images") or []):
            if str(ref) not in image_paths:
                image_paths.append(str(ref))
        image_paths = image_paths[: _max_reference_images(key.provider, model)]

        paths: list[str] = []
        for _ in range(requested):
            data = _post_json(
                _chat_image_url(base_url),
                key.access_key,
                _chat_image_payload(
                    prompt=prompt,
                    model=model,
                    size=requested_size,
                    image_paths=image_paths or None,
                ),
                timeout=timeout,
            )
            paths.extend(_write_outputs(data, out_dir, start_index=len(paths) + 1))
            if len(paths) >= requested:
                break
        return paths[:requested]

    family = image_family(model)
    # custom 走 family 判定补诚实；命名 provider(openai/seedream/tokendance/HK) 分支不动。
    custom_img = key.provider == "custom" and family in ("gpt-image", "nano-banana")
    is_seedream = key.provider == "seedream" or (key.provider == "custom" and family == "seedream")
    is_hk_image = is_hk and _hk_image_model(model)
    # quality 仅对支持它的模型发送：OpenAI / OpenAI-HK 的 gpt-image・nano-banana / custom 同族；
    # seedream 没有 quality 概念，发了可能被拒。
    wants_quality = key.provider == "openai" or is_hk_image or custom_img
    quality = _quality_param(kwargs) if wants_quality else None
    ref_paths = _collect_ref_paths(kwargs, key.provider, model)

    # 图生图端点按族分流：gpt-image 族走官方同步 /images/edits（multipart，OpenAI/HK 实现）。
    # nano-banana 是 Gemini 多模态，OpenAI-HK / 聚合商对其 /images/edits 一律 403（openresty
    # 网关层拒未实现路由），必须走 generations 的 image 字段（实测 OpenAI-HK 可用）——
    # 故 edits 仅限 gpt-image，nano-banana 落到下方 generations+image 兜底。
    # 不用 generations+image 做 gpt-image（那是 Ark/seedream 路子），更绝不加 ?async=true。
    if (is_hk_image or custom_img) and family == "gpt-image" and ref_paths:
        paths: list[str] = []
        for _ in range(requested):
            data = _post_multipart(
                _edits_url(base_url),
                key.access_key,
                fields=_hk_edits_fields(
                    model=model, prompt=prompt, size=requested_size, quality=quality, n=1
                ),
                files=_ref_file_parts(ref_paths),
                timeout=timeout,
            )
            paths.extend(_write_outputs(data, out_dir, start_index=len(paths) + 1))
            if len(paths) >= requested:
                break
        return paths[:requested]

    ref_image = _reference_image_param(kwargs, key.provider, model)

    def _gen_payload(num: int) -> dict:
        return _image_generation_payload(
            model=model,
            prompt=prompt,
            size=requested_size,
            n=num,
            image=ref_image,
            quality=quality,
            watermark=is_seedream,
            sequential=is_seedream,
        )

    data = _post_json(_image_url(base_url), key.access_key, _gen_payload(requested), timeout=timeout)
    paths = _write_outputs(data, out_dir)
    # seedream / gpt-image・nano-banana（含 custom 同族）：单次可能只回 1 张，循环补足。
    if is_seedream or is_hk_image or custom_img:
        while len(paths) < requested:
            data = _post_json(_image_url(base_url), key.access_key, _gen_payload(1), timeout=timeout)
            paths.extend(_write_outputs(data, out_dir, start_index=len(paths) + 1))
    return paths[:requested]


def _image_url(base_url: str) -> str:
    return f"{_api_root(base_url)}/images/generations"


def _edits_url(base_url: str) -> str:
    return f"{_api_root(base_url)}/images/edits"


def _guess_mime(path: str) -> str:
    ext = Path(path).suffix.lstrip(".").lower() or "png"
    return "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"


def _ref_file_parts(paths: list[str]) -> list[tuple]:
    """multipart 文件部件列表；多张参考图重复 `image` 字段名（OpenAI-HK edits 约定）。"""
    parts: list[tuple] = []
    for p in paths:
        parts.append(("image", (Path(p).name, Path(p).read_bytes(), _guess_mime(p))))
    return parts


def _hk_edits_fields(
    *, model: str, prompt: str, size: object, quality: str | None, n: int = 1
) -> dict:
    fields: dict[str, str] = {"model": model, "prompt": prompt, "n": str(max(1, n))}
    if size:
        fields["size"] = str(size)
    if quality:
        fields["quality"] = quality
    return fields


def _post_multipart(
    url: str, api_key: str, *, fields: dict, files: list, timeout: float | tuple[float, float]
) -> dict:
    # 不手动设 Content-Type，让 requests 生成 multipart boundary。
    headers = {"Authorization": f"Bearer {api_key}"}
    resp = requests.post(url, headers=headers, data=fields, files=files, timeout=timeout)
    if resp.status_code >= 400:
        raise OpenAIImageError(f"image edits api {resp.status_code}: {resp.text[:500]}")
    return resp.json()


def _chat_image_url(base_url: str) -> str:
    return f"{_api_root(base_url)}/chat/completions"


def _image_generation_payload(
    *,
    model: str,
    prompt: str,
    size: object,
    n: int,
    image: str | list[str] | None = None,
    quality: str | None = None,
    watermark: bool = False,
    sequential: bool = False,
) -> dict:
    payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "n": n,
        "size": size,
        "response_format": "b64_json",
        "stream": False,
    }
    if watermark:  # seedream / Ark 专有
        payload["watermark"] = True
    if quality:  # gpt-image / nano-banana：low/medium/high/auto
        payload["quality"] = quality
    # Seedream / Ark 图生图：image 接受 URL 或 base64 data-url，单张为 str、多张为 list。
    if image:
        payload["image"] = image
    if sequential and n > 1:  # seedream 组图
        payload["sequential_image_generation"] = "auto"
        payload["sequential_image_generation_options"] = {"max_images": n}
    return {k: v for k, v in payload.items() if v is not None}


def image_family(model: str) -> str:
    """模型族判定（镜像前端 imageControlCaps）：决定 quality/官方 edits/seedream 参数。"""
    m = (model or "").lower()
    if m.startswith("gpt-image"):
        return "gpt-image"
    if m.startswith("nano-banana"):
        return "nano-banana"
    if m.startswith("seedream") or m.startswith("seededit"):
        return "seedream"
    return "standard"


def _hk_image_model(model: str) -> bool:
    """OpenAI-HK 上走 images 端点（支持 size+quality）的模型族。"""
    return bool(model) and (model.startswith("gpt-image") or model.startswith("nano-banana"))


def _quality_param(kwargs: dict) -> str | None:
    params = kwargs.get("params") or {}
    q = kwargs.get("quality") or params.get("quality")
    return q if q in ("low", "medium", "high", "auto") else None


def _max_reference_images(provider: str, model: str) -> int:
    """每个厂商/模型对参考图（图生图输入）的数量上限；超出按"取前 N 张"截断。

    - seedream（火山引擎）：图生图最多 10 张参考图。
    - gpt-image（OpenAI / OpenAI-HK）：最多 16 张。
    - nano-banana：官方建议 ≤2 张效果更佳，放宽到 3。
    - 其它/未知：保守 4 张。
    与前端 `web/src/lib/referenceLimits.ts::maxReferenceImages` 保持一致。
    """
    if provider == "seedream":
        return 10
    if model.startswith("nano-banana"):
        return 3
    if provider == "openai" or model.startswith("gpt-image"):
        return 16
    return 4


def _collect_ref_paths(kwargs: dict, provider: str, model: str) -> list[str]:
    """source_image + reference_images → 去重 + 按厂商/模型上限截断的本地路径列表。"""
    params = kwargs.get("params") or {}
    paths: list[str] = []
    source_image = kwargs.get("source_image") or params.get("source_image")
    if source_image:
        paths.append(str(source_image))
    for ref in (kwargs.get("reference_images") or params.get("reference_images") or []):
        if str(ref) not in paths:
            paths.append(str(ref))
    return paths[: _max_reference_images(provider, model)]


def _reference_image_param(
    kwargs: dict, provider: str, model: str
) -> str | list[str] | None:
    """参考图 → base64 data-url(s)，用于 generations 的 `image` 字段（Ark/seedream 图生图）。

    单张返回 str、多张返回 list、无返回 None。
    """
    urls = [_image_data_url(p) for p in _collect_ref_paths(kwargs, provider, model)]
    if not urls:
        return None
    return urls[0] if len(urls) == 1 else urls


def _image_data_url(path: str) -> str:
    raw = Path(path).read_bytes()
    b64 = base64.b64encode(raw).decode()
    ext = Path(path).suffix.lstrip(".").lower() or "png"
    mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
    return f"data:{mime};base64,{b64}"


def _api_root(base_url: str) -> str:
    base = base_url.rstrip("/")
    for suffix in _KNOWN_ENDPOINT_SUFFIXES:
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    parts = urlsplit(base)
    path = parts.path.rstrip("/")
    if not path or path == "/":
        path = "/v1"
    base = urlunsplit((parts.scheme, parts.netloc, path, "", ""))
    return base.rstrip("/")


def _post_json(url: str, api_key: str, payload: dict, *, timeout: float | tuple[float, float]) -> dict:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    last_error: BaseException | None = None
    for attempt in range(3):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=timeout)
            if resp.status_code >= 400:
                raise OpenAIImageError(f"image api {resp.status_code}: {resp.text[:500]}")
            return resp.json()
        except OpenAIImageError:
            raise
        except (requests.RequestException, ValueError) as e:
            last_error = e
            if attempt < 2:
                time.sleep(1 + attempt)

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    # urllib 只接受单个 float 超时；timeout 是 (连接, 读取) 元组时取读取分量。
    _urllib_timeout = timeout[1] if isinstance(timeout, (tuple, list)) else timeout
    try:
        with urllib.request.urlopen(req, timeout=_urllib_timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise OpenAIImageError(f"image api {e.code}: {body[:500]}") from e
    except Exception as e:
        raise OpenAIImageError(str(e)) from (last_error or e)


def _write_outputs(payload: dict, output_dir: Path, *, start_index: int = 1) -> list[str]:
    if "choices" in payload:
        payload = _chat_payload_to_image_payload(payload)
    items = payload.get("data")
    if not isinstance(items, list) or not items:
        raise OpenAIImageError(f"image api response missing data: {payload!r}")

    paths: list[str] = []
    for i, item in enumerate(items, start=start_index):
        if not isinstance(item, dict):
            continue
        target = output_dir / f"v{i}.png"
        if isinstance(item.get("b64_json"), str):
            target.write_bytes(_decode_b64_image(item["b64_json"]))
            paths.append(str(target))
            continue
        if isinstance(item.get("url"), str):
            target.write_bytes(_download_image_url(_clean_image_url(item["url"])))
            paths.append(str(target))
    if not paths:
        raise OpenAIImageError(f"image api returned no downloadable image: {payload!r}")
    return paths


def _decode_b64_image(value: str) -> bytes:
    if "," in value and value.lstrip().startswith("data:"):
        value = value.split(",", 1)[1]
    return base64.b64decode(value)


def _is_openai_hk(base_url: str) -> bool:
    return "openai-hk.com" in urlsplit(base_url).netloc.lower()


# HK gpt-image 只接受尺寸表里的精确 WxH；表外值（如 1024x1536）会被按总像素出成
# 正方形（1024×1536=1,572,864 → 1254²）。表来自 openai-hk.com/docs/openai/gpt-image。
# 注意：这是 HK 专有表，真 OpenAI 的 gpt-image 枚举不同，不要套用；nano-banana 收的是
# 比例串（9x16），也不走这里。
_HK_GPT_IMAGE_SIZES: tuple[tuple[int, int], ...] = (
    (1024, 1024), (2048, 2048), (2880, 2880),  # 1:1
    (1280, 720), (2048, 1152), (3840, 2160),  # 16:9
    (720, 1280), (1152, 2048), (2160, 3840),  # 9:16
    (1040, 832), (2080, 1664), (3200, 2560),  # 5:4
    (832, 1040), (1664, 2080), (2560, 3200),  # 4:5
    (1024, 768), (2048, 1536), (3264, 2448),  # 4:3
    (768, 1024), (1536, 2048), (2448, 3264),  # 3:4
    (1008, 672), (2064, 1376), (3504, 2336),  # 3:2
    (672, 1008), (1376, 2064), (2336, 3504),  # 2:3
    (1344, 576), (2016, 864), (3808, 1632),  # 21:9
)


def _snap_hk_gpt_image_size(size: object) -> object:
    """把任意 WxH 吸附到 HK gpt-image 支持的精确尺寸：先比例最近、再像素最近。

    HK gpt-image 表外值会被出成正方形，故必须 snap。`auto` 与非 WxH 串原样返回；
    已在表内的精确值不动。
    """
    if not isinstance(size, str):
        return size
    s = size.strip()
    if s.lower() == "auto" or not re.fullmatch(r"\d+x\d+", s):
        return size
    rw, rh = (int(v) for v in s.split("x"))
    if rw <= 0 or rh <= 0:
        return size
    if (rw, rh) in _HK_GPT_IMAGE_SIZES:
        return s
    req_logratio = math.log(rw / rh)
    req_logpx = math.log(rw * rh)
    best = min(
        _HK_GPT_IMAGE_SIZES,
        key=lambda wh: (
            round(abs(math.log(wh[0] / wh[1]) - req_logratio), 6),  # 比例最近（容忍浮点噪声）
            abs(math.log(wh[0] * wh[1]) - req_logpx),  # 同比例内取像素最近
        ),
    )
    return f"{best[0]}x{best[1]}"


def _normalize_size_for_provider(size: object, provider: str) -> object:
    if provider != "seedream" or not isinstance(size, str):
        return size
    match = re.fullmatch(r"(\d+)x(\d+)", size.strip())
    if not match:
        return size
    width = int(match.group(1))
    height = int(match.group(2))
    min_pixels = 3_686_400
    if width * height >= min_pixels:
        return size
    scale = (min_pixels / max(1, width * height)) ** 0.5
    return f"{int(width * scale + 0.999999)}x{int(height * scale + 0.999999)}"


def _chat_image_payload(
    *,
    prompt: str,
    model: str,
    size: str | None,
    image_paths: list[str] | None = None,
) -> dict:
    text = prompt
    if size:
        text = f"{text}\n\nImage size: {size}"
    if image_paths:
        content: object = []
        for p in image_paths:
            content.append({"type": "image_url", "image_url": {"url": _image_data_url(p)}})
        content.append({"type": "text", "text": text})
    else:
        content = text
    return {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "stream": False,
    }


def _chat_payload_to_image_payload(payload: dict) -> dict:
    data: list[dict[str, str]] = []
    for choice in payload.get("choices") or []:
        if not isinstance(choice, dict):
            continue
        message = choice.get("message")
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, str):
            data.extend(_image_items_from_text(content))
        elif isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                text = part.get("text")
                if isinstance(text, str):
                    data.extend(_image_items_from_text(text))
                image_url = part.get("image_url")
                if isinstance(image_url, dict) and isinstance(image_url.get("url"), str):
                    data.append({"url": image_url["url"]})
    if data:
        return {"data": data}
    raise OpenAIImageError(f"chat image response missing image content: {payload!r}")


def _image_items_from_text(text: str) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for value in re.findall(r"!\[[^\]]*\]\(([^)]+)\)", text):
        items.append(_image_item_from_value(value))
    for value in re.findall(r"https?://[^\s)\"']+", text):
        url = _clean_image_url(value)
        if not any(url == item.get("url") for item in items):
            items.append({"url": url})
    for value in re.findall(r"data:image/[^;\s]+;base64,[A-Za-z0-9+/=\n\r]+", text):
        items.append({"b64_json": value})
    return items


def _image_item_from_value(value: str) -> dict[str, str]:
    if value.startswith("data:image/"):
        return {"b64_json": value}
    return {"url": _clean_image_url(value)}


def _clean_image_url(value: str) -> str:
    url = value.strip().strip("<>")
    if "](" in url:
        url = url.split("](", 1)[0]
    match = re.match(r"https?://[^\s\]\)\"'<>]+", url)
    if match:
        url = match.group(0)
    return url.rstrip(".,;")


def _download_image_url(url: str) -> bytes:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0.0.0 Safari/537.36"
        ),
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    }
    last_error: BaseException | None = None

    try:
        resp = requests.get(url, headers=headers, timeout=180.0, stream=False)
        if resp.status_code >= 400:
            raise OpenAIImageError(f"download image {resp.status_code}: {url}")
        data = resp.content
        if data:
            return data
    except OpenAIImageError:
        raise
    except (IncompleteRead, requests.RequestException) as e:
        last_error = e

    content = bytearray()
    expected_total: int | None = None
    for _ in range(5):
        resume_offset = len(content)
        request_headers = dict(headers)
        if content:
            request_headers["Range"] = f"bytes={resume_offset}-"
        try:
            with requests.get(
                url,
                headers=request_headers,
                timeout=180.0,
                stream=True,
            ) as resp:
                if resp.status_code >= 400:
                    raise OpenAIImageError(f"download image {resp.status_code}: {url}")
                if content and not _response_matches_range(resp.status_code, resp.headers, resume_offset):
                    content.clear()
                expected_total = _expected_download_size(resp.headers, expected_total)
                for chunk in resp.iter_content(chunk_size=64 * 1024):
                    if chunk:
                        content.extend(chunk)
                if content and (expected_total is None or len(content) >= expected_total):
                    return bytes(content)
        except OpenAIImageError:
            raise
        except (IncompleteRead, requests.RequestException) as e:
            partial = _incomplete_read_partial(e)
            if partial:
                content.extend(partial)
            last_error = e
    fallback = _curl_download_image_url(url, headers)
    if fallback is not None:
        return fallback
    if content and expected_total is None and _looks_like_image(content):
        return bytes(content)
    raise OpenAIImageError("download image failed after retries") from last_error


def _incomplete_read_partial(error: BaseException) -> bytes:
    if isinstance(error, IncompleteRead) and isinstance(error.partial, bytes):
        return error.partial
    for arg in getattr(error, "args", ()):
        if isinstance(arg, BaseException):
            partial = _incomplete_read_partial(arg)
            if partial:
                return partial
    return b""


def _curl_download_image_url(url: str, headers: Mapping[str, str]) -> bytes | None:
    try:
        result = subprocess.run(
            [
                "curl",
                "-sS",
                "-L",
                "--fail",
                "--retry",
                "5",
                "--max-time",
                "180",
                "-A",
                headers["User-Agent"],
                "-H",
                f"Accept: {headers['Accept']}",
                url,
            ],
            check=True,
            capture_output=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None
    if _looks_like_image(bytearray(result.stdout)):
        return result.stdout
    return None


def _expected_download_size(
    headers: Mapping[str, str],
    fallback: int | None,
) -> int | None:
    content_range = headers.get("Content-Range")
    if content_range and "/" in content_range:
        total = content_range.rsplit("/", 1)[1]
        if total.isdigit():
            return int(total)
    content_length = headers.get("Content-Length")
    if content_length and content_length.isdigit() and not content_range:
        return int(content_length)
    return fallback


def _response_matches_range(
    status_code: int,
    headers: Mapping[str, str],
    resume_offset: int,
) -> bool:
    if resume_offset == 0:
        return True
    content_range = headers.get("Content-Range")
    if status_code != 206 or not content_range:
        return False
    unit, _, remainder = content_range.partition(" ")
    if unit.lower() != "bytes" or "-" not in remainder:
        return False
    start = remainder.split("-", 1)[0]
    return start.isdigit() and int(start) == resume_offset


def _looks_like_image(content: bytearray) -> bool:
    return (
        content.startswith(b"\x89PNG\r\n\x1a\n")
        or content.startswith(b"\xff\xd8\xff")
        or content.startswith(b"GIF87a")
        or content.startswith(b"GIF89a")
        or content.startswith(b"RIFF")
    )
