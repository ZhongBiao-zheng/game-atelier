"""Host-issued guest identities scoped to one active share and credential generation."""
from __future__ import annotations

import hmac
import secrets
import threading
import time
from pathlib import Path
from collections import OrderedDict
from dataclasses import dataclass

from fastapi import HTTPException, Request

from character_workflow.lib import collab_config, data_root
from character_workflow.lib.canvas_projects import canvas_project_dir


@dataclass
class GuestSession:
    project_id: str
    passcode_version: int
    client_id: str
    display_name: str
    last_seen: float
    root: Path


_lock = threading.Lock()
_sessions: OrderedDict[str, GuestSession] = OrderedDict()


def share_entry(project_id: str) -> collab_config.SharedCanvasEntry:
    entry = collab_config.read_config().shares.get(project_id)
    if entry and entry.enabled:
        try:
            canvas_project_dir(project_id)
            return entry
        except KeyError:
            pass
    raise HTTPException(404, "这张画布未共享")


def authenticate(project_id: str, passcode: str, display_name: str, proof: str | None = None,
                 resume_proof: str | None = None) -> dict:
    root = data_root.resolve_data_root()
    entry = share_entry(project_id)
    credential = collab_config.identity_hash(
        f"resume/{project_id}/{entry.passcode_version}/{proof}/{display_name}"
    ) if proof else None
    if resume_proof is not None:
        if not credential or not hmac.compare_digest(credential, resume_proof):
            raise HTTPException(403, "共享访问权限已变更，请重新进入")
    elif not collab_config.verify_passcode(entry, passcode):
        raise HTTPException(401, "访问口令不正确")
    token = secrets.token_urlsafe(32)
    client = collab_config.identity_hash(f"guest/{project_id}/{proof}") if proof else secrets.token_hex(16)
    session = GuestSession(project_id, entry.passcode_version, client,
                           display_name, time.monotonic(), root)
    with _lock:
        if len(_sessions) >= 4096:
            _sessions.popitem(last=False)
        _sessions[token] = session
    return {"collab_token": token, "client_id": session.client_id, "display_name": display_name,
            "resume_proof": credential, "access_epoch": entry.passcode_version}


def require_guest(request: Request, project_id: str, *, edit: bool = False) -> GuestSession:
    entry = share_entry(project_id)
    header = request.headers.get("authorization", "")
    token = header[7:] if header.startswith("Bearer ") else ""
    with _lock:
        session = _sessions.get(token)
        if (not session or session.root != data_root.resolve_data_root() or session.project_id != project_id
                or session.passcode_version != entry.passcode_version):
            raise HTTPException(401, "请重新进入共享画布")
        session.last_seen = time.monotonic()
        _sessions.move_to_end(token)
    if edit and entry.mode != "edit":
        raise HTTPException(403, "这张画布仅可查看")
    return session


def online_count(entry: collab_config.SharedCanvasEntry) -> int:
    since = time.monotonic() - 30
    with _lock:
        return len({s.client_id for s in _sessions.values() if s.project_id == entry.project_id
                    and s.passcode_version == entry.passcode_version and s.last_seen >= since})


def reset_sessions() -> None:
    with _lock:
        _sessions.clear()
