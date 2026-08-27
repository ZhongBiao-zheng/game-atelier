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
