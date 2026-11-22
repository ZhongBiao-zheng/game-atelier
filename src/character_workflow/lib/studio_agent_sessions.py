"""Studio 对话及其附件。会话锁位于目录外，可在 Windows 上持锁删除附件。"""

from __future__ import annotations

import secrets
import shutil
from datetime import datetime, timezone
from pathlib import Path

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json, read_text_with_retry
from character_workflow.lib.canvas_agent_sessions import _validate_session_id
from character_workflow.lib.canvas_tool_common import CanvasToolError
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import StudioAgentSession


def root() -> Path:
    return data_root.resolve_data_root() / "studio-agent"


def lock(sid):
    return file_lock(
        data_root.runtime_dir() / "locks" / f"studio-agent-{_validate_session_id(sid)}.lock"
    )


def session_path(sid):
    return root() / "sessions" / f"{_validate_session_id(sid)}.json"


def plan_path(sid):
    return root() / "plans" / f"{_validate_session_id(sid)}.json"


def upload_dir(sid):
    return root() / "uploads" / _validate_session_id(sid)


def now():
    return datetime.now(timezone.utc).isoformat()


def create(settings):
    sid = "session-" + secrets.token_hex(12)
    timestamp = now()
    session = StudioAgentSession(
        session_id=sid,
        created_at=timestamp,
        updated_at=timestamp,
        **({"title": "新对话"} | settings),
    )
    with lock(sid):
        _save(session)
    return session


def _save(session):
    path = session_path(session.session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(path, session.model_dump(mode="json"))


def read(sid):
    try:
        session = StudioAgentSession.model_validate_json(read_text_with_retry(session_path(sid)))
    except FileNotFoundError:
        raise CanvasToolError("NOT_FOUND", "找不到这个对话", 404) from None
    if session.session_id != sid:
        raise ValueError("会话文件与标识不符")
    return session


def summaries():
    sessions = []
    for path in (root() / "sessions").glob("session-*.json"):
        try:
            row = read(path.stem)
        except (ValueError, OSError, CanvasToolError):
            continue
        sessions.append(
            row.model_dump(include={"session_id", "title", "updated_at", "status", "revision"})
        )
    return sorted(sessions, key=lambda row: row["updated_at"], reverse=True)


def mutate(sid, update):
    with lock(sid):
        current = read(sid)
        timestamp = now()
        fields = update(current, timestamp)
        if not fields:
            return current
        updated = StudioAgentSession.model_validate(
            current.model_dump()
            | fields
            | {
                "revision": current.revision + 1,
                "updated_at": timestamp,
            }
        )
        _save(updated)
        return updated


def delete(sid, revision):
    with lock(sid):
        session = read(sid)
        if session.revision != revision:
            raise CanvasToolError("REVISION_CONFLICT", "对话已更新", 409)
        directory = upload_dir(sid)
        try:
            if directory.exists():
                shutil.rmtree(directory)
            plan_path(sid).unlink(missing_ok=True)
            session_path(sid).unlink()
        except PermissionError:
            # Windows 可能仍有附件正在读取。保留会话入口让用户能重试清理。
            raise CanvasToolError("SESSION_BUSY", "附件正在使用，请稍后重试", 409) from None


def public(session):
    return session.model_dump(
        exclude={"history": True, "uploads": True, "pending_approvals": {"__all__": {"arguments"}}}
    )
