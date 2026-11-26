"""Persist LAN canvas shares and manual peers. Access tokens stay in memory."""
from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.file_lock import file_lock

COLLAB_PROTOCOL_VERSION = 1
DEFAULT_PORT = 5181


class ShareSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["edit", "view"] = "edit"
    allow_borrow_provider: bool = False
    passcode: str | None = Field(default=None, max_length=200)


class SharedCanvasEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: str
    enabled: bool = True
    mode: Literal["edit", "view"] = "edit"
    passcode_salt: str | None = None
    passcode_hash: str | None = None
    passcode_version: int = 1
    allow_borrow_provider: bool = False
    shared_at: str
    updated_at: str


class Config(BaseModel):
    model_config = ConfigDict(extra="forbid")
    host_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    preferred_port: int = Field(default=DEFAULT_PORT, ge=5181, le=5200)
    shares: dict[str, SharedCanvasEntry] = Field(default_factory=dict)
    manual_peers: list[str] = Field(default_factory=list, max_length=100)
    revision: int = 0


def _update(change=None) -> Config:
    path = data_root.config_dir() / "collab-shares.json"
    with file_lock(data_root.runtime_dir() / "locks" / "collab-shares.lock"):
        exists = path.exists()
        config = Config.model_validate_json(path.read_bytes()) if exists else Config()
        if change and change(config):
            config.revision += 1
        elif exists:
            return config
        atomic_write_json(path, config.model_dump(mode="json"), durable=True)
        return config


def read_config() -> Config:
    return _update()


def _hash(salt: str, passcode: str) -> str:
    return hashlib.sha256((salt + passcode).encode()).hexdigest()


def verify_passcode(entry: SharedCanvasEntry, passcode: str) -> bool:
    return not entry.passcode_hash or hmac.compare_digest(
        entry.passcode_hash, _hash(entry.passcode_salt or "", passcode)
    )


def enable_share(project_id: str, settings: ShareSettings) -> SharedCanvasEntry:
    def change(config):
        now = datetime.now(timezone.utc).isoformat()
        entry = config.shares.get(project_id) or SharedCanvasEntry(
            project_id=project_id, shared_at=now, updated_at=now,
            # Monotonic across stop and re-share (existing tokens remain revoked).
            passcode_version=config.revision + 1,
        )
        if settings.passcode is not None:
            entry.passcode_version = config.revision + 1
            entry.passcode_salt = secrets.token_hex(16) if settings.passcode else None
            entry.passcode_hash = _hash(entry.passcode_salt, settings.passcode) if entry.passcode_salt else None
        entry.mode = settings.mode
        entry.allow_borrow_provider = settings.allow_borrow_provider
        entry.updated_at = now
        config.shares[project_id] = entry
        return True
    return _update(change).shares[project_id]


def disable_share(project_id: str | None = None) -> bool:
    if not (data_root.config_dir() / "collab-shares.json").exists():
        return False
    changed = False

    def change(config):
        nonlocal changed
        if project_id is None:
            changed = bool(config.shares)
            config.shares.clear()
        else:
            changed = config.shares.pop(project_id, None) is not None
        return changed
    _update(change)
    return changed


def set_manual_peer(address: str, *, enabled: bool) -> None:
    def change(config):
        if enabled and address not in config.manual_peers:
            if len(config.manual_peers) >= 100:
                raise ValueError("最多保存 100 个手动连接地址")
            config.manual_peers.append(address)
            return True
        if not enabled and address in config.manual_peers:
            config.manual_peers.remove(address)
            return True
        return False
    _update(change)
