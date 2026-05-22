"""Logging filter that masks access_key / secret_key in log records."""
from __future__ import annotations

import logging
import re

_PATTERNS = [
    re.compile(r"(access_key)[=:\s'\"]+([A-Za-z0-9_\-]+)"),
    re.compile(r"(secret_key)[=:\s'\"]+([A-Za-z0-9_\-]+)"),
]


def _redact(text: str) -> str:
    for pat in _PATTERNS:
        text = pat.sub(r"\1=***", text)
    return text


class SecretRedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        redacted = _redact(msg)
        if redacted != msg:
            record.msg = redacted
            record.args = ()
        return True
