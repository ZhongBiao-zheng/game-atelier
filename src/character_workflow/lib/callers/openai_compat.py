"""Small shared helpers for OpenAI-compatible generation endpoints."""
from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit


_KNOWN_SUFFIXES = (
    "/images/generations",
    "/images/edits",
    "/chat/completions",
    "/audio/speech",
    "/responses",
    "/models",
)


def api_root(base_url: str) -> str:
    base = base_url.rstrip("/")
    for suffix in _KNOWN_SUFFIXES:
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    parts = urlsplit(base)
    path = parts.path.rstrip("/")
    if not path or path == "/":
        path = "/v1"
    return urlunsplit((parts.scheme, parts.netloc, path, "", "")).rstrip("/")


def key_api_root(key) -> str:
    if key.provider == "atelier":
        return (key.base_url or "").rstrip("/") + "/gateway/v1/openai"
    return api_root(key.base_url or "https://api.openai.com/v1")
