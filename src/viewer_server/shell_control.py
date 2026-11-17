"""Desktop shell control channel (docs/contracts/desktop-shell.md).

The server writes an owner-only token next to its PID records; only a local process that can
read `.runtime` (and could therefore stop the server anyway) can ask what is still running.
"""
from __future__ import annotations

import hmac
import secrets
from pathlib import Path

from fastapi import APIRouter

from character_workflow.lib.private_json import write_private_json

CONTROL_FILE = "shell-control.json"
ACTIVE_WORK_PATH = "/api/shell/active-work"


class ShellControl:
    """Issued when the server finishes initializing; until then the channel rejects everything."""

    def __init__(self) -> None:
        self.token: str | None = None

    def issue(self, runtime: Path, instance_id: str) -> None:
        token = secrets.token_urlsafe(32)
        write_private_json(runtime / CONTROL_FILE, {"instance_id": instance_id, "token": token})
        self.token = token

    def accepts(self, authorization: str | None) -> bool:
        if self.token is None or not authorization or not authorization.startswith("Bearer "):
            return False
        return hmac.compare_digest(authorization[7:].encode(), self.token.encode())


router = APIRouter()


@router.get(ACTIVE_WORK_PATH)
def shell_active_work() -> dict[str, int]:
    from viewer_server.update_routes import active_work
    return active_work()
