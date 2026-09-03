"""Runtime sessions and persistent, project-scoped Agent grants."""
from __future__ import annotations

import hashlib
import secrets
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from character_workflow.lib import data_root
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.private_json import read_private_json, write_private_json
from character_workflow.lib.projects import read_projects

AGENT_CAPABILITIES = frozenset({
    "read", "edit_documents", "create_targets", "prepare_generation", "execute_generation",
    "canvas_read", "canvas_edit", "canvas_generate",
})
SESSION_LIMIT = 64
GRANT_LIMIT = 32
COOKIE_NAME = "atelier_local_session"


def iso_time(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def digest(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


class ConnectionError(Exception):
    def __init__(self, code: str, message: str, status: int = 403):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


@dataclass(frozen=True)
class ConnectionPrincipal:
    kind: Literal["local", "agent"]
    session_id: str
    grant_id: str | None = None
    project_ids: frozenset[str] = frozenset()
    capabilities: frozenset[str] = AGENT_CAPABILITIES
    canvas_project_ids: frozenset[str] = frozenset()


@dataclass
class Session:
    principal: ConnectionPrincipal
    token_hash: str
    origin: str | None
    expires_at: float
    name: str
    revoked: threading.Event = field(default_factory=threading.Event)
    event_connections: int = 0


class ConnectionStore:
    def __init__(self, instance_id: str):
        self.instance_id = instance_id
        # Discovery is public and must not resolve or read user configuration.
        self.root: Path | None = None
        self.sessions: dict[str, Session] = {}
        self.lease: tuple[str, str, float] | None = None
        self.lock = threading.RLock()
        self._attempts: list[float] = []

    def _refresh(self) -> None:
        root = data_root.resolve_data_root()
        if root != self.root:
            for session in self.sessions.values():
                session.revoked.set()
            self.sessions.clear()
            self.lease = None
            self.root = root
        now = time.time()
        for key, session in list(self.sessions.items()):
            if session.expires_at <= now or session.revoked.is_set():
                session.revoked.set()
                del self.sessions[key]
        if self.lease and self.lease[2] <= now:
            self.lease = None

    def _new_session(
        self, kind: Literal["local", "agent"], origin: str | None, expires_at: float,
        *, name: str, grant_id: str | None = None, project_ids: frozenset[str] = frozenset(),
        capabilities: frozenset[str] = AGENT_CAPABILITIES,
        canvas_project_ids: frozenset[str] = frozenset(),
    ) -> tuple[Session, str]:
        self._refresh()
        if len(self.sessions) >= SESSION_LIMIT:
            raise ConnectionError("CONNECTION_RATE_LIMITED", "连接数量已达上限，请先断开旧连接", 429)
        token = secrets.token_urlsafe(32)
        principal = ConnectionPrincipal(kind, uuid.uuid4().hex, grant_id, project_ids, capabilities,
                                        canvas_project_ids)
        session = Session(principal, digest(token), origin, expires_at, name)
        self.sessions[principal.session_id] = session
        return session, token

    def authenticate(self, token: str, *, kind: str, origin: str | None) -> Session:
        with self.lock:
            self._refresh()
            hashed = digest(token)
            for session in self.sessions.values():
                if secrets.compare_digest(session.token_hash, hashed):
                    if session.principal.kind != kind or (
                        origin is not None and session.origin != origin
                    ):
                        raise ConnectionError("CAPABILITY_DENIED", "此连接不能使用该入口")
                    if session.principal.grant_id and not self.is_grant_active(
                        session.principal.grant_id,
                    ):
                        session.revoked.set()
                        raise ConnectionError("SESSION_REVOKED", "Agent 授权已失效")
                    return session
        raise ConnectionError("SESSION_EXPIRED", "连接已过期，请重新连接", 401)

    def local_session(self, origin: str, token: str | None) -> tuple[Session, str | None]:
        with self.lock:
            if token:
                try:
                    return self.authenticate(token, kind="local", origin=origin), None
                except ConnectionError:
                    pass
            return self._new_session("local", origin, time.time() + 12 * 3600, name="本地页面")

    def editor_lease(self, session: Session, client_id: str, *, takeover: bool = False) -> dict:
        with self.lock:
            self._refresh()
            if session.revoked.is_set() or session.principal.kind != "local":
                raise ConnectionError("CAPABILITY_DENIED", "此连接不能编辑页面")
            identity = (session.principal.session_id, client_id)
            if self.lease and self.lease[:2] != identity and not takeover:
                raise ConnectionError("EDITOR_IN_USE", "另一页面正在编辑，当前草稿已保留", 409)
            self.lease = (*identity, time.time() + 30)
            return {"client_id": client_id, "expires_at": iso_time(self.lease[2])}

    def require_editor(self, session: Session, client_id: str | None) -> None:
        with self.lock:
            self._refresh()
            if not self.lease or self.lease[:2] != (session.principal.session_id, client_id):
                raise ConnectionError("EDITOR_IN_USE", "当前页面没有编辑权，草稿已保留", 409)

    def release_editor(self, session: Session, client_id: str) -> None:
        with self.lock:
            if self.lease and self.lease[:2] == (session.principal.session_id, client_id):
                self.lease = None

    def revoke_session(self, session_id: str) -> None:
        with self.lock:
            if session := self.sessions.pop(session_id, None):
                session.revoked.set()
            if self.lease and self.lease[0] == session_id:
                self.lease = None

    def _grants_path(self) -> Path:
        assert self.root is not None
        return self.root / ".config" / "connections" / "grants.json"

    def _read_grants(self) -> dict:
        path = self._grants_path()
        return read_private_json(path, 128 * 1024) if path.exists() else {}

    def list_grants(self) -> list[dict]:
        with self.lock:
            self._refresh()
            return [self._public_grant(value) for value in self._read_grants().values()]

    @staticmethod
    def _public_grant(value: dict) -> dict:
        return {key: item for key, item in value.items() if key != "token_hash"}

    def is_grant_active(self, grant_id: str) -> bool:
        with self.lock:
            self._refresh()
            grant = self._read_grants().get(grant_id)
            return bool(grant and datetime.fromisoformat(grant["expires_at"]).timestamp() > time.time())

    def grant_allows(self, grant_id: str, project_id: str, capability: str) -> bool:
        with self.lock:
            self._refresh()
            grant = self._read_grants().get(grant_id)
            scope = "canvas_project_ids" if capability.startswith("canvas_") else "project_ids"
            return bool(
                grant and datetime.fromisoformat(grant["expires_at"]).timestamp() > time.time()
                and project_id in grant.get(scope, []) and capability in grant["capabilities"]
            )

    def create_grant(
        self, *, name: str, project_ids: list[str], capabilities: list[str], days: int,
        base_url: str, canvas_project_ids: list[str] | None = None,
    ) -> dict:
        canvas_project_ids = list(canvas_project_ids or [])
        with self.lock:
            self._refresh()
            known = {project.id for project in read_projects().projects}
            if not set(project_ids) <= known:
                raise ConnectionError("TARGET_NOT_AUTHORIZED", "请选择现有工坊项目")
            if canvas_project_ids:
                from character_workflow.lib.canvas_projects import list_canvas_project_options
                known_canvas = {p.project_id for p in list_canvas_project_options()}
                if not set(canvas_project_ids) <= known_canvas:
                    raise ConnectionError("TARGET_NOT_AUTHORIZED", "请选择现有画布项目")
            if not project_ids and not canvas_project_ids:
                raise ConnectionError("TARGET_NOT_AUTHORIZED", "请至少选择一个工坊项目或画布")
            if not set(capabilities) <= AGENT_CAPABILITIES:
                raise ConnectionError("CAPABILITY_DENIED", "Agent 授权包含未知能力")
            if project_ids and "read" not in capabilities:
                raise ConnectionError("CAPABILITY_DENIED", "工坊授权需要读取能力")
            if canvas_project_ids and "canvas_read" not in capabilities:
                raise ConnectionError("CAPABILITY_DENIED", "画布授权需要画布读取能力")
            path = self._grants_path()
            with file_lock(path.with_suffix(".lock")):
                grants = self._read_grants()
                if len(grants) >= GRANT_LIMIT:
                    raise ConnectionError("CONNECTION_RATE_LIMITED", "授权数量已达上限，请撤销旧授权", 429)
                grant_id, token = uuid.uuid4().hex, secrets.token_urlsafe(32)
                credential_path = path.parent / f"{grant_id}.json"
                grant = {
                    "grant_id": grant_id, "name": name,
                    "project_ids": sorted(set(project_ids)), "capabilities": sorted(set(capabilities)),
                    "canvas_project_ids": sorted(set(canvas_project_ids)),
                    "expires_at": iso_time(time.time() + days * 86400),
                    "credential_path": str(credential_path), "token_hash": digest(token),
                }
                write_private_json(credential_path, {
                    "service": "game-atelier", "base_url": base_url, "grant_id": grant_id,
                    "grant_token": token, "expires_at": grant["expires_at"],
                })
                grants[grant_id] = grant
                write_private_json(path, grants)
                return self._public_grant(grant)

    def revoke_grant(self, grant_id: str) -> None:
        with self.lock:
            self._refresh()
            path = self._grants_path()
            with file_lock(path.with_suffix(".lock")):
                grants = self._read_grants()
                grant = grants.pop(grant_id, None)
                if grant is not None:
                    write_private_json(path, grants)
                    # Keep the revoked credential file: revocation, not possession, is authoritative.
            for session in self.sessions.values():
                if session.principal.grant_id == grant_id:
                    session.revoked.set()

    def agent_session(self, grant_id: str, token: str, instance_id: str) -> tuple[Session, str]:
        with self.lock:
            self._refresh()
            now = time.time()
            self._attempts = [timestamp for timestamp in self._attempts if timestamp > now - 60]
            if len(self._attempts) >= 30:
                raise ConnectionError("CONNECTION_RATE_LIMITED", "连接尝试过于频繁，请稍后再试", 429)
            self._attempts.append(now)
            if instance_id != self.instance_id:
                raise ConnectionError("INSTANCE_CHANGED", "本机服务已变化，请重新连接", 409)
            grant = self._read_grants().get(grant_id)
            if not grant or not secrets.compare_digest(grant["token_hash"], digest(token)):
                raise ConnectionError("SESSION_REVOKED", "Agent 授权无效或已撤销")
            expiry = datetime.fromisoformat(grant["expires_at"]).timestamp()
            if expiry <= now:
                raise ConnectionError("SESSION_REVOKED", "Agent 授权已到期")
            return self._new_session(
                "agent", None, min(now + 2 * 3600, expiry), name=grant["name"], grant_id=grant_id,
                project_ids=frozenset(grant["project_ids"]),
                capabilities=frozenset(grant["capabilities"]),
                canvas_project_ids=frozenset(grant.get("canvas_project_ids", [])),
            )
