"""OpenAI-compatible image generation caller for openai/seedream/custom providers."""
from __future__ import annotations

import base64
from collections.abc import Mapping
from http.client import IncompleteRead
import json
import re
import subprocess
import urllib.error
import urllib.request
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests

DEFAULT_SEEDREAM_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
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
    timeout: float = 600.0,
    **kwargs: Any,
) -> list[str]:
    from character_workflow.lib import keys as _keys

    key = _keys.find_by_alias(alias)
    if key is None:
        raise ValueError(f"alias not found: {alias}")
    if key.provider not in ("openai", "seedream", "custom"):
        raise ValueError(
            f"alias {alias!r} has provider {key.provider!r}, expected openai/seedream/custom"
        )

    base_url = (key.base_url or "").strip()
    if not base_url:
        if key.provider == "openai":
            base_url = DEFAULT_OPENAI_BASE_URL
        elif key.provider == "seedream":
            base_url = DEFAULT_SEEDREAM_BASE_URL
    if not base_url:
        raise OpenAIImageError("custom provider requires base_url")

    requested_size = _normalize_size_for_provider(
        kwargs.get("size") or kwargs.get("requested_size") or kwargs.get("params", {}).get("size"),
        key.provider,
    )

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    if _is_openai_hk(base_url):
        image_paths: list[str] = []
        source_image = kwargs.get("source_image") or (kwargs.get("params") or {}).get("source_image")
        if source_image:
            image_paths.append(str(source_image))
        for ref in (kwargs.get("reference_images") or (kwargs.get("params") or {}).get("reference_images") or []):
            if str(ref) not in image_paths:
                image_paths.append(str(ref))

        paths: list[str] = []
        requested = max(1, int(n or 1))
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

    requested = max(1, int(n or 1))
    payload = _image_generation_payload(
        model=model,
        prompt=prompt,
        size=requested_size,
        n=requested,
    )
    data = _post_json(_image_url(base_url), key.access_key, payload, timeout=timeout)
    paths = _write_outputs(data, out_dir)
    if key.provider == "seedream":
        while len(paths) < requested:
            data = _post_json(
                _image_url(base_url),
                key.access_key,
                _image_generation_payload(
                    model=model,
                    prompt=prompt,
                    size=requested_size,
                    n=1,
                ),
                timeout=timeout,
            )
            paths.extend(_write_outputs(data, out_dir, start_index=len(paths) + 1))
    return paths[:requested]


def _image_url(base_url: str) -> str:
    return f"{_api_root(base_url)}/images/generations"


def _chat_image_url(base_url: str) -> str:
    return f"{_api_root(base_url)}/chat/completions"


def _image_generation_payload(
    *,
    model: str,
    prompt: str,
    size: object,
    n: int,
) -> dict:
    payload = {
        "model": model,
        "prompt": prompt,
        "n": n,
        "size": size,
        "response_format": "b64_json",
        "stream": False,
        "watermark": True,
    }
    if n > 1:
        payload["sequential_image_generation"] = "auto"
        payload["sequential_image_generation_options"] = {"max_images": n}
    return {k: v for k, v in payload.items() if v is not None}


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


def _post_json(url: str, api_key: str, payload: dict, *, timeout: float) -> dict:
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
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
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
            raw = Path(p).read_bytes()
            b64 = base64.b64encode(raw).decode()
            ext = Path(p).suffix.lstrip(".").lower() or "png"
            mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
            content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
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
