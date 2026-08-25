"""Project-scoped Canvas Agent session files.

The session directory is a cold sidecar domain: it never participates in Canvas
Document autosave and each session owns its own revision and lock.
"""
from __future__ import annotations

import json
import logging
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.canvas_projects import (
    canvas_project_dir,
)
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import (
    CanvasAgentMessage,
    CanvasAgentMessageCreate,
    CanvasAgentSession,
    CanvasAgentSessionList,
    CanvasAgentSessionSummary,
)


logger = logging.getLogger(__name__)

_SESSION_ID = re.compile(r"^session-[a-z0-9-]{8,64}$")


class CanvasAgentSessionStateError(ValueError):
    """A single session file exists but cannot be trusted."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sessions_dir(project_id: str) -> Path:
    return canvas_project_dir(project_id) / "agent" / "sessions"


def _validate_session_id(session_id: str) -> str:
    if _SESSION_ID.fullmatch(session_id) is None:
        raise KeyError(session_id)
    return session_id


def _session_path(project_id: str, session_id: str) -> Path:
    _validate_session_id(session_id)
    return _sessions_dir(project_id) / f"{session_id}.json"


def _session_lock_path(project_id: str, session_id: str) -> Path:
    _validate_session_id(session_id)
    return (
        data_root.runtime_dir()
        / "locks"
        / f"canvas-agent-{project_id}-{session_id}.lock"
    )


def canvas_agent_sessions_lock_path(project_id: str) -> Path:
    """Return the cold-sidecar domain lock, separate from Canvas autosave."""
    canvas_project_dir(project_id)
    return data_root.runtime_dir() / "locks" / f"canvas-agent-{project_id}.lock"


def _read_session_unlocked(project_id: str, session_id: str) -> CanvasAgentSession:
    path = _session_path(project_id, session_id)
    if not path.is_file():
        raise KeyError(session_id)
    try:
        session = CanvasAgentSession.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValidationError) as error:
        raise CanvasAgentSessionStateError(session_id) from error
    if session.session_id != session_id or session.project_id != project_id:
        raise CanvasAgentSessionStateError(session_id)
    return session


def read_canvas_agent_session(project_id: str, session_id: str) -> CanvasAgentSession:
    _validate_session_id(session_id)
    with file_lock(canvas_agent_sessions_lock_path(project_id)):
        with file_lock(_session_lock_path(project_id, session_id)):
            return _read_session_unlocked(project_id, session_id)


def list_canvas_agent_sessions(project_id: str) -> CanvasAgentSessionList:
    with file_lock(canvas_agent_sessions_lock_path(project_id)):
        directory = _sessions_dir(project_id)
        if not directory.exists():
            return CanvasAgentSessionList(sessions=[], corrupt_session_ids=[])
        sessions: list[CanvasAgentSession] = []
        corrupt_ids: list[str] = []
        for path in sorted(directory.glob("session-*.json")):
            session_id = path.stem
            if _SESSION_ID.fullmatch(session_id) is None:
                logger.warning("skipping invalid Canvas Agent session filename: %s", path.name)
                continue
            try:
                with file_lock(_session_lock_path(project_id, session_id)):
                    sessions.append(_read_session_unlocked(project_id, session_id))
            except CanvasAgentSessionStateError:
                logger.warning("isolating corrupt Canvas Agent session: %s", session_id)
                corrupt_ids.append(session_id)
    summaries = [
        CanvasAgentSessionSummary(
            session_id=session.session_id,
            project_id=session.project_id,
            title=session.title,
            status=session.status,
            revision=session.revision,
            sequence=session.sequence,
            message_count=len(session.messages),
            created_at=session.created_at,
            updated_at=session.updated_at,
        )
        for session in sorted(sessions, key=lambda item: item.updated_at, reverse=True)
    ]
    return CanvasAgentSessionList(sessions=summaries, corrupt_session_ids=sorted(corrupt_ids))


def create_canvas_agent_session(project_id: str, title: str) -> CanvasAgentSession:
    with file_lock(canvas_agent_sessions_lock_path(project_id)):
        directory = _sessions_dir(project_id)
        directory.mkdir(parents=True, exist_ok=True)
        for _attempt in range(20):
            session_id = f"session-{secrets.token_hex(8)}"
            path = _session_path(project_id, session_id)
            if not path.exists():
                break
        else:  # pragma: no cover - cryptographic collision guard
            raise RuntimeError("failed to allocate a unique Canvas Agent session id")
        timestamp = _now()
        session = CanvasAgentSession(
            session_id=session_id,
            project_id=project_id,
            title=title,
            created_at=timestamp,
            updated_at=timestamp,
        )
        with file_lock(_session_lock_path(project_id, session_id)):
            if path.exists():  # pragma: no cover - collision after allocation
                raise RuntimeError("Canvas Agent session id was claimed concurrently")
            atomic_write_json(path, session.model_dump(mode="json"))
        return session


def append_canvas_agent_message(
    project_id: str,
    session_id: str,
    payload: CanvasAgentMessageCreate,
    expected_revision: int,
) -> CanvasAgentSession:
    _validate_session_id(session_id)
    timestamp = _now()
    with file_lock(canvas_agent_sessions_lock_path(project_id)):
        with file_lock(_session_lock_path(project_id, session_id)):
            current = _read_session_unlocked(project_id, session_id)
            if current.revision != expected_revision:
                raise RuntimeError(f"revision_conflict:{current.revision}")
            message = CanvasAgentMessage(
                **payload.model_dump(mode="python"),
                message_id=f"message-{secrets.token_hex(8)}",
                sequence=current.sequence + 1,
                created_at=timestamp,
            )
            updated = current.model_copy(update={
                "revision": current.revision + 1,
                "sequence": message.sequence,
                "messages": [*current.messages, message],
                "updated_at": timestamp,
            })
            # model_copy does not revalidate nested invariants; validate before writing.
            updated = CanvasAgentSession.model_validate(updated.model_dump(mode="python"))
            atomic_write_json(
                _session_path(project_id, session_id),
                updated.model_dump(mode="json"),
            )
        return updated


def delete_canvas_agent_session(
    project_id: str,
    session_id: str,
    expected_revision: int,
) -> None:
    _validate_session_id(session_id)
    with file_lock(canvas_agent_sessions_lock_path(project_id)):
        with file_lock(_session_lock_path(project_id, session_id)):
            current = _read_session_unlocked(project_id, session_id)
            if current.revision != expected_revision:
                raise RuntimeError(f"revision_conflict:{current.revision}")
            _session_path(project_id, session_id).unlink()
