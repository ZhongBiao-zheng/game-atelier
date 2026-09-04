"""Minimal local runtime identity; never read project/configuration data to probe a server."""
from __future__ import annotations

import http.client
import json
import os
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, StringConstraints


INSTANCE_ENV = "GAME_ATELIER_SERVER_INSTANCE"
STATUS_PATH = "/api/connection/status"
_MAX_STATUS_BYTES = 4096
InstanceId = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{32}$", strict=True)]


class LocalConnectionStatus(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    service: Literal["game-atelier"]
    instance_id: InstanceId
    app_version: Annotated[str, StringConstraints(min_length=1, max_length=80, strict=True)]
    # Protocol capability is not authorization; cross-origin pairing remains separately gated.
    protocol: Literal["atelier-local/1"]


def new_instance_id() -> str:
    return uuid.uuid4().hex


def create_connection_status(instance_id: str | None = None) -> LocalConnectionStatus:
    manifest = Path(__file__).resolve().parents[2] / ".claude-plugin" / "plugin.json"
    version = json.loads(manifest.read_text(encoding="utf-8"))["version"]
    identity = instance_id if instance_id is not None else os.environ.get(INSTANCE_ENV)
    return LocalConnectionStatus(
        service="game-atelier",
        instance_id=identity if identity is not None else new_instance_id(),
        app_version=version,
        protocol="atelier-local/1",
    )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe_connection_status(port: int) -> LocalConnectionStatus | None:
    """Read only a bounded loopback response, without proxies or redirected requests."""
    if type(port) is not int or not 1 <= port <= 65535:
        return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{STATUS_PATH}", headers={"Accept": "application/json"},
    )
    try:
        with opener.open(request, timeout=0.5) as response:
            if response.status != 200 or response.headers.get_content_type() != "application/json":
                return None
            raw = response.read(_MAX_STATUS_BYTES + 1)
        if len(raw) > _MAX_STATUS_BYTES:
            return None
        return LocalConnectionStatus.model_validate_json(raw)
    except (OSError, urllib.error.URLError, ValueError, http.client.HTTPException):
        return None
