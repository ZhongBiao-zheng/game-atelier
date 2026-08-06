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
    "openai",
    "midjourney",
    "nano_banana",
    "seedream",
    "runway",
    "kling",
    "veo",
    "seedance",
    "tokendance",
    "openrouter",
    "custom",
]
Kind = Literal["portrait", "promo", "turnaround"]
ModelModality = Literal["image", "video"]


class ModelSpec(BaseModel):
    name: str
    id: str
    # None = 未标注：消费端按 key 级 modalities 兜底（含 video 且不含 image → video）。
    modality: ModelModality | None = None
    # 视频协议 id（seedance/kling/dashscope）；图片模型与旧数据为 None。
    # 读时由 _backfill_video_protocols 对可解析的视频模型回填（见 read_keys_db）。
    protocol: str | None = None


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


class OssConfig(BaseModel):
    """对象存储配置（参考视频中转用）。与生成类 Key 分开存：不参与模型选择。"""
    provider: Literal["aliyun"] = "aliyun"
    access_key_id: str
    access_key_secret: str
    bucket: str
    endpoint: str  # 如 oss-cn-beijing.aliyuncs.com


class KeysDB(BaseModel):
    version: int = 1
    default_alias: str | None = None
    keys: list[KeySpec] = Field(default_factory=list)
    oss: OssConfig | None = None


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
    db = KeysDB.model_validate(raw)
    _backfill_video_protocols(db)
    return db


def _migrate_legacy_providers(raw: object) -> None:
    if not isinstance(raw, dict):
        return
    rows = raw.get("keys")
    if not isinstance(rows, list):
        return
    for row in rows:
        if isinstance(row, dict) and row.get("provider") == "zhenzhen":
            row["provider"] = "custom"


def _is_video_model(spec: "ModelSpec", key: "KeySpec") -> bool:
    """与前端 web/src/api/keys.ts::modelModality 同义：模型级标注优先，
    未标注按 key 级 modalities 兜底（仅声明 video 视为视频）。"""
    if spec.modality:
        return spec.modality == "video"
    return "video" in key.modalities and "image" not in key.modalities


def _backfill_video_protocols(db: KeysDB) -> None:
    """读时内存回填：为可解析的视频模型补 protocol（不写盘，下次 write 才落）。

    resolve_protocol 走 lazy import 避免与 callers 包的加载顺序耦合（沿用 callers 既有
    lazy-import 习惯）；resolve 不命中的视频模型保持 None，由前端守卫拦截 / 用户显式选。
    """
    from character_workflow.lib.callers.video_registry import resolve_protocol

    for key in db.keys:
        for spec in key.models:
            if spec.protocol is None and _is_video_model(spec, key):
                spec.protocol = resolve_protocol(key.provider, key.base_url, spec.id)


def write_keys_db(db: KeysDB) -> None:
    path = data_root.keys_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    # O_CREAT 直接带 0o600 创建，堵住「先 write 后 chmod」首次落盘的 umask 窗口。
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps(db.model_dump(), ensure_ascii=False, indent=2))
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


def is_openai_hk(base_url: str | None) -> bool:
    """OpenAI-HK 是同步 OpenAI 兼容厂商，出图走 openai_image 的同步 images 端点。"""
    return bool(base_url) and "openai-hk.com" in base_url.lower()


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
            "models": [m.model_dump() for m in k.models],
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
