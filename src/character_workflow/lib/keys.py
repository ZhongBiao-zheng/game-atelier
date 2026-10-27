"""keys.json CRUD + AI Key selection protocol.

Secrets never leave this module's read paths — REST API uses `keys_for_api()`
which strips secrets, and turn-start uses `keys_for_turn_start()` (same).
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_serializer, model_validator

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import _replace_with_retry
from character_workflow.lib.file_lock import file_lock

Provider = Literal[
    "chatgpt",
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
    "evolink",
    "custom",
    # 局域网 Atelier（ADR-0025）：base_url 是网关地址，access_key 是网关密钥。
    "atelier",
]
Kind = Literal["portrait", "promo", "turnaround"]
ModelModality = Literal["text", "image", "video", "audio"]
RouteMode = Literal["order", "cheap", "round_robin"]
ModelInputModality = Literal["text", "image", "video", "audio"]


class ViaMember(BaseModel):
    """网关供应商的模型背后、网关那边路由组的一个成员（快照，不含任何密钥）。"""
    alias: str
    provider: str
    base_url: str | None = None
    model_id: str
    name: str
    protocol: str | None = None
    billing_group: str | None = None


class ModelSpec(BaseModel):
    name: str
    id: str
    # None = 未标注：消费端按 key 级 modalities 兜底。
    modality: ModelModality | None = None
    # 调用协议 id —— 视频：seedance/kling/dashscope/openrouter；图片：ark/openai/evolink。
    # 权威值来自上游 /models 的协议标注（models-preview 解析后随模型一起存）；旧数据为
    # None，读时由 _backfill_model_protocols 按启发式回填（见 read_keys_db）。
    protocol: str | None = None
    # 模型可理解的输入模态。反推提示词等多模态文本能力只认明确声明，不按模型名猜。
    input_modalities: list[ModelInputModality] = Field(default_factory=list)
    # 只有局域网 Atelier 供应商有：网关那边的成员快照，能力取交集、估价取第一个（ADR-0025）。
    via: list[ViaMember] | None = None

    @model_serializer(mode="wrap")
    def _omit_empty_via(self, handler):
        # 普通 KEY 没有 via：不写进 keys.json / API，旧数据与旧断言保持原样。
        data = handler(self)
        if data.get("via") is None:
            data.pop("via", None)
        return data


class KeySpec(BaseModel):
    alias: str
    provider: Provider
    enabled: bool = True
    base_url: str | None = None
    # 聚合商可按账号分组采用不同价目；未配置时计价器必须保持未知，不能猜 default。
    billing_group: str | None = None
    access_key: str = ""
    auth_source: Literal["codex-cli"] | None = None
    secret_key: str | None = None
    capabilities: list[Kind] = Field(default_factory=list)
    models: list[ModelSpec] = Field(default_factory=list)
    homepage_url: str | None = None
    docs_url: str | None = None
    api_key_url: str | None = None
    modalities: list[str] = Field(default_factory=list)
    notes: str = ""
    created_at: str

    @model_validator(mode="after")
    def _subscription_contract(self):
        if self.provider != "chatgpt":
            if self.auth_source is not None:
                raise ValueError("只有 ChatGPT 订阅支持 Codex 登录")
            # 密钥非空只在 API 写入边界检查：这里读盘也会执行，旧版允许的空密钥记录不能拖垮整个 keys.json。
            return self
        if self.access_key or self.secret_key or self.base_url or self.billing_group:
            raise ValueError("ChatGPT 订阅读取 Codex 登录，不接受密钥或自定义地址")
        if self.auth_source != "codex-cli":
            raise ValueError("ChatGPT 订阅必须使用 Codex 登录")
        if any(model.id != "gpt-image-2" for model in self.models):
            raise ValueError("ChatGPT 订阅只支持 GPT Image")
        self.models = [ModelSpec(id="gpt-image-2", name="GPT Image", modality="image",
                                 input_modalities=["text", "image"])]
        self.modalities = ["image"]
        return self

    @model_serializer(mode="wrap")
    def _omit_empty_auth_source(self, handler):
        data = handler(self)
        if data.get("auth_source") is None:
            data.pop("auth_source", None)
        return data

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
    # 模型路由组内的供应商顺序覆盖：{模态: {路由 id: [alias, ...]}}，只存调整过的组。
    model_order: dict[str, dict[str, list[str]]] = Field(default_factory=dict)
    route_mode: dict[str, dict[str, RouteMode]] = Field(default_factory=dict)


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
    _backfill_model_protocols(db)
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


def model_modality(spec: ModelSpec, key: KeySpec) -> ModelModality:
    """模型级标注优先；未标注时按 key 级 modalities 兜底（与前端 modelModality 同义）。"""
    if spec.modality is not None:
        return spec.modality
    modalities = set(key.modalities)
    if modalities == {"video"}:
        return "video"
    if modalities == {"audio"}:
        return "audio"
    if modalities == {"llm"}:
        return "text"
    return "image"


def _is_video_model(spec: "ModelSpec", key: "KeySpec") -> bool:
    """与前端 web/src/api/keys.ts::modelModality 同义：模型级标注优先，
    未标注按 key 级 modalities 兜底（仅声明 video 视为视频）。"""
    if spec.modality:
        return spec.modality == "video"
    return "video" in key.modalities and "image" not in key.modalities


def _backfill_model_protocols(db: KeysDB) -> None:
    """读时内存回填：为可解析的模型补 protocol（不写盘，下次 write 才落）。

    视频走 video_registry.resolve_protocol，图片走 openai_image.resolve_image_protocol；
    两者都 lazy import，避免与 callers 包的加载顺序耦合（沿用 callers 既有习惯）。解析
    不命中保持 None——视频由前端守卫拦截 / 用户显式选，图片则表示走默认 OpenAI 兼容入口。
    """
    from character_workflow.lib.callers.openai_image import resolve_image_protocol
    from character_workflow.lib.callers.video_registry import resolve_protocol

    for key in db.keys:
        for spec in key.models:
            if spec.protocol is not None:
                continue
            if key.provider == "chatgpt":
                continue
            # 文本/音频没有图片协议回填；它们只接受上游明确标注或各 caller 自己的
            # 保守旧模型推断，不能因为共用 ModelSpec 就误走 image resolver。
            key_modalities = set(key.modalities)
            if spec.modality in {"text", "audio"} or (
                spec.modality is None and key_modalities in ({"llm"}, {"audio"})
            ):
                continue
            if _is_video_model(spec, key):
                spec.protocol = resolve_protocol(key.provider, key.base_url, spec.id)
            else:
                spec.protocol = resolve_image_protocol(key.provider, key.base_url, spec.id)


def keys_lock():
    """所有配置读改写共用 sidecar 锁；write_keys_db 不重复加锁。"""
    return file_lock(data_root.keys_file().with_suffix(".lock"))


def write_keys_db(db: KeysDB) -> None:
    path = data_root.keys_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    # mkstemp 创建时即为 0600，原子替换让不持锁的模型目录读取也只看到完整配置。
    fd, temporary = tempfile.mkstemp(prefix=".keys-", suffix=".tmp", dir=path.parent)
    tmp = Path(temporary)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(db.model_dump(), ensure_ascii=False, indent=2))
        _restrict_permissions(tmp)
        _replace_with_retry(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _restrict_permissions(path: Path) -> None:
    if sys.platform == "win32":
        try:
            from character_workflow.lib.win_acl import restrict_keys_file_windows  # type: ignore  # noqa: E501
            restrict_keys_file_windows(path)
        except ImportError:
            pass
    else:
        os.chmod(path, 0o600)


def size_channel(key: KeySpec, model: ModelSpec) -> tuple[KeySpec, ModelSpec]:
    """尺寸、能力按实际渠道判断：网关供应商取网关那边第一个成员，其余原样返回。

    网关端会按实际成员再归一一次；这里只决定接入端界面与提交时的参数形状。
    """
    via = model.via[0] if key.provider == "atelier" and model.via else None
    if via is None:
        return key, model
    channel_model = ModelSpec(id=via.model_id, name=via.name, modality=model.modality,
                              protocol=via.protocol)
    channel_key = key.model_copy(update={
        "provider": via.provider, "base_url": via.base_url, "billing_group": via.billing_group,
        "models": [channel_model],
    })
    return channel_key, channel_model


def find_by_alias(alias: str) -> KeySpec | None:
    for k in read_keys_db().keys:
        if k.alias == alias:
            return k
    return None


def add_key(spec: KeySpec) -> None:
    with keys_lock():
        db = read_keys_db()
        if any(k.alias == spec.alias for k in db.keys):
            raise DuplicateAliasError(spec.alias)
        db.keys.append(spec)
        write_keys_db(db)


def patch_key(alias: str, patch: dict) -> None:
    with keys_lock():
        db = read_keys_db()
        for i, k in enumerate(db.keys):
            if k.alias == alias:
                db.keys[i] = KeySpec.model_validate({**k.model_dump(), **patch})
                write_keys_db(db)
                return
        raise NoSuchAliasError(alias)


def delete_key(alias: str) -> None:
    with keys_lock():
        db = read_keys_db()
        db.keys = [k for k in db.keys if k.alias != alias]
        if db.default_alias == alias:
            db.default_alias = None
        db.model_order = {
            modality: kept
            for modality, routes in db.model_order.items()
            if (kept := {
                route_id: [item for item in aliases if item != alias]
                for route_id, aliases in routes.items()
                if any(item != alias for item in aliases)
            })
        }
        from character_workflow.lib.model_routes import _routes
        identities = db.model_copy(update={"keys": [
            key.model_copy(update={"enabled": True}) for key in db.keys
        ]})
        active = {(route.modality, route.id) for route in _routes(identities)}
        db.route_mode = {modality: modes for modality, routes in db.route_mode.items()
                         if (modes := {identifier: mode for identifier, mode in routes.items()
                                      if (modality, identifier) in active})}
        write_keys_db(db)


def set_default_alias(alias: str) -> None:
    with keys_lock():
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
            if k.enabled and k.alias == db.default_alias and kind in k.capabilities:
                return k.alias
    for k in db.keys:
        if k.enabled and kind in k.capabilities:
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
        for k in db.keys if k.enabled
    ]


def _mask(s: str | None) -> str | None:
    if not s:
        return None
    if len(s) <= 6:
        return "***"
    return f"{s[:3]}...{s[-3:]}"
