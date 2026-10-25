"""Runtime sessions and persistent, project-scoped Agent grants."""
from __future__ import annotations

import hashlib
import os
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

AGENT_CAPABILITIES = frozenset({
    "canvas_read", "canvas_edit", "canvas_generate",
})
SESSION_LIMIT = 64
COOKIE_NAME = "atelier_local_session"
PrincipalKind = Literal["local", "agent"]


def iso_time(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def digest(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


class ConnectionError(Exception):
    def __init__(self, code: str, message: str, status: int = 403):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


def _credential_store_error(action: str, error: Exception) -> ConnectionError:
    """凭据文件读写失败（Windows ACL / pywin32 缺失 / 磁盘不支持权限）要带原因回给页面。

    后台服务的 stderr 进 DEVNULL，裸 500 等于把原因扔掉；用户只能报「创建授权失败 500」。
    异常文本来自 OS / pywin32，不含令牌本体。
    """
    return ConnectionError(
        "CREDENTIAL_STORE_FAILED",
        f"{action}失败：{type(error).__name__}: {error}。请检查 data root 所在磁盘是否支持文件权限"
        "（NTFS / 非同步盘），以及依赖是否装全（Windows 需要 pywin32）。",
        500,
    )


@dataclass(frozen=True)
class ConnectionPrincipal:
    kind: PrincipalKind
    session_id: str
    grant_id: str | None = None
    capabilities: frozenset[str] = AGENT_CAPABILITIES


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
        # grant_id → {客户端: 最近一次换到会话的时间}：页面据此显示「已连接」，服务重启即清空。
        self.agent_connections: dict[str, dict[str, float]] = {}
        self.lock = threading.RLock()
        self._attempts: list[float] = []
        # 热路径不碰磁盘：authenticate 走在事件循环上、SSE 每 0.5s 刷一次，
        # 授权文件与 data-root 配置都按 stat 结果缓存，只在文件变化时重读。
        self._root_key: tuple[str | None, int | None] | None = None
        self._grants_key: tuple[int, int, int] | None = None
        self._grants_cache: dict = {}

    def _resolve_root(self) -> Path:
        env = os.environ.get(data_root._ENV_VAR)
        mtime = None
        if env is None:
            # 环境变量优先于配置文件；有它就别碰 platformdirs（测试替换 sys.platform 时它会抛 NotImplementedError）。
            try:
                mtime = data_root._global_config_file().stat().st_mtime_ns
            except OSError:
                mtime = None
        key = (env, mtime)
        if key != self._root_key or self.root is None:
            self._root_key = key
            return data_root.resolve_data_root()
        assert self.root is not None
        return self.root

    def _refresh(self) -> None:
        root = self._resolve_root()
        if root != self.root:
            self._grants_key, self._grants_cache = None, {}
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
        self, kind: PrincipalKind, origin: str | None, expires_at: float,
        *, name: str, grant_id: str | None = None,
        capabilities: frozenset[str] = AGENT_CAPABILITIES,
    ) -> tuple[Session, str]:
        self._refresh()
        if len(self.sessions) >= SESSION_LIMIT:
            raise ConnectionError("CONNECTION_RATE_LIMITED", "连接数量已达上限，请先断开旧连接", 429)
        token = secrets.token_urlsafe(32)
        principal = ConnectionPrincipal(kind, uuid.uuid4().hex, grant_id, capabilities)
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

    def _throttle_attempt(self, now: float) -> None:
        self._attempts = [timestamp for timestamp in self._attempts if timestamp > now - 60]
        if len(self._attempts) >= 30:
            raise ConnectionError("CONNECTION_RATE_LIMITED", "连接尝试过于频繁，请稍后再试", 429)
        self._attempts.append(now)

    def _grants_path(self) -> Path:
        assert self.root is not None
        # 旧版 grants.json（多条、按项目限范围的授权）整体作废，升级后在设置里重新打开一次开关。
        return self.root / ".config" / "connections" / "agent-grant.json"

    def _read_grants(self) -> dict:
        """按 (inode, size, mtime) 缓存；命中时零文件读取，也不跑 Windows ACL 校验。"""
        path = self._grants_path()
        try:
            stat = path.stat()
        except FileNotFoundError:
            with self.lock:
                self._grants_key, self._grants_cache = None, {}
            return {}
        key = (stat.st_ino, stat.st_size, stat.st_mtime_ns)
        with self.lock:
            if key == self._grants_key:
                return self._grants_cache
        try:
            grants = read_private_json(path, 128 * 1024)
        except (OSError, ImportError, ValueError) as error:
            raise _credential_store_error("读取 Agent 授权记录", error) from error
        with self.lock:
            self._grants_key, self._grants_cache = key, grants
        return grants

    def agent_status(self) -> dict:
        with self.lock:
            self._refresh()
            grant = next(iter(self._read_grants().values()), None)
            connections = self.agent_connections.get(grant["grant_id"], {}) if grant else {}
            return {
                "enabled": grant is not None,
                "connections": {client: iso_time(at) for client, at in connections.items()},
            }

    # Agent 授权只有一条、覆盖全部项目与画布（含以后新建的），不设有效期，撤销是唯一的失效方式。
    def is_grant_active(self, grant_id: str) -> bool:
        with self.lock:
            self._refresh()
            return grant_id in self._read_grants()

    def grant_allows(self, grant_id: str, project_id: str, capability: str) -> bool:
        return self.is_grant_active(grant_id) and capability in AGENT_CAPABILITIES

    def enable_agent(self, base_url: str) -> None:
        """打开开关：签一份新凭据写到固定位置，替换旧授权；已注册的 Agent 下一次调用自动换用。"""
        # 磁盘读写与 flock 都在 store.lock 之外：这把锁被事件循环上的 authenticate 与 SSE 刷新共用，
        # 持锁做文件 I/O（Windows 上还有 ACL 调用）会把整条事件循环拖停。
        with self.lock:
            self._refresh()
            path = self._grants_path()
        with file_lock(path.with_suffix(".lock")):
            replaced = set(self._read_grants())
            grant_id, token = uuid.uuid4().hex, secrets.token_urlsafe(32)
            credential_path = path.parent / data_root.AGENT_CREDENTIAL_NAME
            try:
                write_private_json(credential_path, {
                    "service": "game-atelier", "base_url": base_url, "grant_id": grant_id,
                    "grant_token": token,
                })
                write_private_json(path, {grant_id: {"grant_id": grant_id, "token_hash": digest(token)}})
            except (OSError, ImportError) as error:
                raise _credential_store_error("写入 Agent 凭据文件", error) from error
        self._revoke_grant_sessions(replaced)

    def disable_agent(self) -> None:
        with self.lock:
            self._refresh()
            path = self._grants_path()
        with file_lock(path.with_suffix(".lock")):
            revoked = set(self._read_grants())
            if revoked:
                # 凭据文件留着：撤销以授权记录为准，持有文件不等于有权。
                write_private_json(path, {})
        self._revoke_grant_sessions(revoked)

    def _revoke_grant_sessions(self, grant_ids: set[str]) -> None:
        with self.lock:
            for session in self.sessions.values():
                if session.principal.grant_id in grant_ids:
                    session.revoked.set()

    def agent_session(
        self, grant_id: str, token: str, instance_id: str, client: str | None = None,
    ) -> tuple[Session, str]:
        with self.lock:
            self._refresh()
            now = time.time()
            self._throttle_attempt(now)
            if instance_id != self.instance_id:
                raise ConnectionError("INSTANCE_CHANGED", "本机服务已变化，请重新连接", 409)
            grant = self._read_grants().get(grant_id)
            if not grant or not secrets.compare_digest(grant["token_hash"], digest(token)):
                raise ConnectionError("SESSION_REVOKED", "Agent 授权无效或已撤销")
            if client is not None:
                self.agent_connections.setdefault(grant_id, {})[client] = now
            return self._new_session("agent", None, now + 2 * 3600, name="本机 Agent", grant_id=grant_id)
