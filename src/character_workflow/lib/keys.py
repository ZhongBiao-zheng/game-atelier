"""keys.json CRUD + AI Key selection protocol.

Secrets never leave this module's read paths — REST API uses `keys_for_api()`
which strips secrets, and turn-start uses `keys_for_turn_start()` (same).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from character_workflow.lib import data_root

Provider = Literal[
    "lovart",
    "openai",
    "midjourney",
    "nano_banana",
    "seedream",
    "runway",
    "kling",
    "veo",
    "seedance",
    "custom",
]
Kind = Literal["portrait", "promo", "turnaround"]
RoutingScope = Literal["general", "classified"]
RoutingCategory = Literal[
    "gpt_image",
    "nano_banana",
    "mj",
    "veo",
    "grok",
    "seedance",
    "suno",
]


class ModelSpec(BaseModel):
    name: str
    id: str


class KeySpec(BaseModel):
    alias: str
    provider: Provider
    base_url: str | None = None
    access_key: str
    secret_key: str | None = None
    capabilities: list[Kind] = Field(default_factory=list)
    models: list[ModelSpec] = Field(default_factory=list)
    homepage_url: str | None = None
    docs_url: str | None = None
    api_key_url: str | None = None
    modalities: list[str] = Field(default_factory=list)
    routing_scope: RoutingScope = "general"
    routing_category: RoutingCategory | None = None
    routing_hints: list[str] = Field(default_factory=list)
    notes: str = ""
    created_at: str

    @field_validator("models", mode="before")
    @classmethod
    def _normalize_models(cls, value: object) -> object:
        if isinstance(value, list):
            return [
                {"name": item, "id": item} if isinstance(item, str) else item
                for item in value
            ]
        return value


class KeysDB(BaseModel):
    version: int = 1
    default_alias: str | None = None
    keys: list[KeySpec] = Field(default_factory=list)


class DuplicateAliasError(Exception):
    ...


class NoSuchAliasError(Exception):
    ...


class KeysFileCorruptedError(Exception):
    ...


def read_keys_db() -> KeysDB:
    path = data_root.keys_file()
    if not path.exists():
        return KeysDB()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise KeysFileCorruptedError(f"{path}: {e}") from e
    _migrate_legacy_providers(raw)
    return KeysDB.model_validate(raw)


def _migrate_legacy_providers(raw: object) -> None:
    if not isinstance(raw, dict):
        return
    rows = raw.get("keys")
    if not isinstance(rows, list):
        return
    for row in rows:
        if isinstance(row, dict) and row.get("provider") == "zhenzhen":
            row["provider"] = "custom"


def write_keys_db(db: KeysDB) -> None:
    path = data_root.keys_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(db.model_dump(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    _restrict_permissions(path)


def _restrict_permissions(path: Path) -> None:
    if sys.platform == "win32":
        try:
            from character_workflow.lib.win_acl import restrict_keys_file_windows  # type: ignore  # noqa: E501
            restrict_keys_file_windows(path)
        except ImportError:
            pass
    else:
        os.chmod(path, 0o600)


def find_by_alias(alias: str) -> KeySpec | None:
    for k in read_keys_db().keys:
        if k.alias == alias:
            return k
    return None


def add_key(spec: KeySpec) -> None:
    db = read_keys_db()
    if any(k.alias == spec.alias for k in db.keys):
        raise DuplicateAliasError(spec.alias)
    db.keys.append(spec)
    write_keys_db(db)


def patch_key(alias: str, patch: dict) -> None:
    db = read_keys_db()
    for i, k in enumerate(db.keys):
        if k.alias == alias:
            db.keys[i] = k.model_copy(update=patch)
            write_keys_db(db)
            return
    raise NoSuchAliasError(alias)


def delete_key(alias: str) -> None:
    db = read_keys_db()
    db.keys = [k for k in db.keys if k.alias != alias]
    if db.default_alias == alias:
        db.default_alias = None
    write_keys_db(db)


def set_default_alias(alias: str) -> None:
    db = read_keys_db()
    if not any(k.alias == alias for k in db.keys):
        raise NoSuchAliasError(alias)
    db.default_alias = alias
    write_keys_db(db)


def preferred_alias_for_kind(kind: Kind) -> str | None:
    db = read_keys_db()
    if db.default_alias:
        for k in db.keys:
            if k.alias == db.default_alias and kind in k.capabilities:
                return k.alias
    for k in db.keys:
        if kind in k.capabilities:
            return k.alias
    return None


def keys_for_api() -> list[dict]:
    db = read_keys_db()
    out = []
    for k in db.keys:
        d = k.model_dump()
        d["access_key"] = _mask(d.get("access_key"))
        d["secret_key"] = None
        d["is_default"] = (k.alias == db.default_alias)
        out.append(d)
    return out


def keys_for_turn_start() -> list[dict]:
    db = read_keys_db()
    return [
        {
            "alias": k.alias,
            "provider": k.provider,
            "capabilities": k.capabilities,
            "models": k.models,
            "notes": k.notes,
            "is_default": k.alias == db.default_alias,
        }
        for k in db.keys
    ]


def _mask(s: str | None) -> str | None:
    if not s:
        return None
    if len(s) <= 6:
        return "***"
    return f"{s[:3]}...{s[-3:]}"
