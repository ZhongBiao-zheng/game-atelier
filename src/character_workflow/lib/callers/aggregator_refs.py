from __future__ import annotations

import base64
import mimetypes
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import requests


@dataclass(frozen=True)
class FilePart:
    filename: str
    content_type: str
    data: bytes


def ref_to_file_part(ref: str | None) -> FilePart | None:
    value = str(ref or "").strip()
    if not value:
        return None
    if _is_data_url(value):
        return _data_url_to_file_part(value)
    if _is_remote_url(value):
        return _remote_url_to_file_part(value)

    path = Path(value)
    if not path.is_file():
        return None
    content_type = _guess_content_type(path.name)
    return FilePart(filename=path.name, content_type=content_type, data=path.read_bytes())


def ref_to_banana_image(ref: str | None) -> str | None:
    value = str(ref or "").strip()
    if not value:
        return None
    if _is_remote_url(value) or _is_data_url(value):
        return value

    part = ref_to_file_part(value)
    if part is None:
        return None
    data = base64.b64encode(part.data).decode("ascii")
    return f"data:{part.content_type};base64,{data}"


def upload_ref_to_aggregator(ref: str | None, api_key: str, base_url: str) -> str | None:
    part = ref_to_file_part(ref)
    if part is None:
        return None

    response = requests.post(
        f"{base_url.rstrip('/')}/v1/files",
        headers={"Authorization": f"Bearer {api_key}"},
        files={"file": (part.filename, part.data, part.content_type)},
        timeout=180,
    )
    response.raise_for_status()
    data = response.json()
    url = data.get("url")
    return url if isinstance(url, str) and url else None


def _is_data_url(value: str) -> bool:
    return value.startswith("data:image/") and ";base64," in value


def _is_remote_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _data_url_to_file_part(value: str) -> FilePart | None:
    header, encoded = value.split(",", 1)
    content_type = header.removeprefix("data:").split(";", 1)[0]
    try:
        data = base64.b64decode(encoded, validate=True)
    except ValueError:
        return None
    return FilePart(
        filename=f"reference{_extension_for_content_type(content_type)}",
        content_type=content_type,
        data=data,
    )


def _remote_url_to_file_part(value: str) -> FilePart:
    response = requests.get(value, timeout=180)
    response.raise_for_status()
    content_type = response.headers.get("content-type", "application/octet-stream").split(";", 1)[0]
    filename = _filename_from_url(value, content_type)
    return FilePart(filename=filename, content_type=content_type, data=response.content)


def _filename_from_url(value: str, content_type: str) -> str:
    name = Path(urlparse(value).path).name
    if name and Path(name).suffix:
        return name
    return f"reference{_extension_for_content_type(content_type)}"


def _guess_content_type(filename: str) -> str:
    return mimetypes.guess_type(filename)[0] or "application/octet-stream"


def _extension_for_content_type(content_type: str) -> str:
    if content_type == "image/jpeg":
        return ".jpg"
    return mimetypes.guess_extension(content_type) or ".bin"
