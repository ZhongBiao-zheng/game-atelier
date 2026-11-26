"""keys.json CRUD + AI Key selection protocol.

Secrets never leave this module's read paths — REST API uses `keys_for_api()`
which strips secrets, and turn-start uses `keys_for_turn_start()` (same).
"""
from __future__ import annotations

import json
import logging
import os
import sys
import tempfile
from datetime import datetime
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, ValidationError, field_validator, model_serializer, model_validator

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import _replace_with_retry, atomic_write_json, read_text_with_retry
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.comfyui_schema import WorkflowInput, local_base_url

Provider = Literal[
    "comfyui",
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
    upstream_protocol: str | None = None
    agent_tools_unverified: bool = False
    billing_group: str | None = None
    # 主机为这个成员选的内置品牌（I1）。只有 brand: 形式，在读网关快照时过滤（atelier_gateway）。
    icon: str | None = None

    @model_serializer(mode="wrap")
    def _omit_empty_icon(self, handler):
        # 没有图标时不写进快照：旧数据与精确比对的断言保持原样。
        data = handler(self)
        if data.get("icon") is None:
            data.pop("icon", None)
        if data.get("upstream_protocol") is None:
            data.pop("upstream_protocol", None)
        if not data.get("agent_tools_unverified"):
            data.pop("agent_tools_unverified", None)
        return data


class ModelSpec(BaseModel):
    name: str
    id: str
    # None = 未标注：消费端按 key 级 modalities 兜底。
    modality: ModelModality | None = None
    # 调用协议 id —— 视频：seedance/kling/klingai/dashscope/openrouter；图片：ark/openai/evolink。
    # 权威值来自上游 /models 的协议标注（models-preview 解析后随模型一起存）；旧数据为
    # None，读时由 _backfill_model_protocols 按启发式回填（见 read_keys_db）。
    protocol: str | None = None
    # 模型可理解的输入模态。反推提示词等多模态文本能力只认明确声明，不按模型名猜。
    input_modalities: list[ModelInputModality] = Field(default_factory=list)
    # 只有局域网 Atelier 供应商有：网关那边的成员快照，能力取交集、估价取第一个（ADR-0025）。
    via: list[ViaMember] | None = None
    workflow_inputs: list[WorkflowInput] | None = None
    # 自定义接口模板 id（protocol == "declarative" 时有效，ADR-0036）。只在 API 写入边界校验。
    declarative_id: str | None = None
    # 局域网网关上自定义接口模型的能力快照（只含能力，不含模板与密钥），由同步网关写入。
    declared_snapshot: dict | None = None
    # 主机手设的每次调用价格（元 / 次）：只在没有同步价时用于估价与网关扣费（第三批，2026-11-18）。
    per_call_cny: float | None = Field(default=None, ge=0, le=10_000, allow_inf_nan=False)
    # 文本模型的手设单价（元 / 百万 token，输入、输出各一个）：只在没有同步价时用（第 5 批 5-5，2026-11-19）。
    input_cny_per_m: float | None = Field(default=None, ge=0, le=10_000, allow_inf_nan=False)
    output_cny_per_m: float | None = Field(default=None, ge=0, le=10_000, allow_inf_nan=False)

    @model_serializer(mode="wrap")
    def _omit_empty_via(self, handler):
        # 普通 KEY 没有 via：不写进 keys.json / API，旧数据与旧断言保持原样。
        data = handler(self)
        for field in ("via", "workflow_inputs", "declarative_id", "declared_snapshot", "per_call_cny",
                      "input_cny_per_m", "output_cny_per_m"):
            if data.get(field) is None:
                data.pop(field, None)
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
    # 用户手动选的对话接口（ADR-0044）；None = 自动。取值只在 API 写入边界检查，读盘不校验。
    text_protocol: str | None = None
    # 自定义图标（I1）：`brand:<id>` 或 `file:<sha256>`；None = 按默认规则显示。只在 API 写入边界校验。
    icon: str | None = None

    @model_validator(mode="after")
    def _subscription_contract(self):
        if self.provider == "comfyui":
            self.base_url = local_base_url(self.base_url)
            if self.access_key or self.secret_key or self.auth_source or self.billing_group:
                raise ValueError("ComfyUI 不接受密钥、订阅或计费分组")
            if any(not m.id.startswith("comfyui-") for m in self.models):
                raise ValueError("ComfyUI 模型必须通过工作流导入")
            self.modalities = ["image"]
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
        # 没设的可选字段不写进 keys.json / API：旧数据与精确比对的断言保持原样。
        for field in ("auth_source", "text_protocol", "icon"):
            if data.get(field) is None:
                data.pop(field, None)
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


RECOVERED_MARKER = "keys-recovered.json"


def _recovered_marker() -> Path:
    return data_root.config_dir() / RECOVERED_MARKER


class KeysConfigError(ValueError):
    """读取供应商配置失败；提示不得包含 Pydantic 错误中的密钥。"""


class _UnreadableKeysJSON(KeysConfigError):
    """只有损坏的 JSON 文本才由首启流程备份。"""


def read_keys_for_onboarding() -> KeysDB:
    """显示首次配置或备份损坏文件前，持供应商写锁复核一次。"""
    from uuid import uuid4

    try:
        db = read_keys_db()
        if db.keys:
            return db
    except _UnreadableKeysJSON:
        pass
    with keys_lock():
        try:
            return read_keys_db()
        except _UnreadableKeysJSON:
            pass
        path = data_root.keys_file()
        now = datetime.now()
        backup = path.with_name(f"{path.name}.corrupt-{now:%Y%m%d-%H%M%S}-{uuid4().hex}")
        # 先记下备份名：进程突然退出时，原文件仍在，或已有提示能找到移走的原文件。
        marker = path.with_name(RECOVERED_MARKER)
        atomic_write_json(marker, {"backup": backup.name, "at": now.isoformat(timespec="seconds")},
                          durable=True)
        try:
            _replace_with_retry(path, backup)
        except OSError:
            marker.unlink(missing_ok=True)
            raise
        return KeysDB()


def keys_recovery_notice() -> dict | None:
    """最近一次自动备份损坏配置的记录；界面据此提示重新添加供应商。"""
    try:
        value = json.loads(read_text_with_retry(_recovered_marker()))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def read_keys_db() -> KeysDB:
    path = data_root.keys_file()
    try:
        raw = json.loads(read_text_with_retry(path))
    except FileNotFoundError:
        return KeysDB()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise _UnreadableKeysJSON("供应商配置内容损坏，请重新打开 Atelier 以备份原文件。") from None
    invalid_structure = "供应商配置格式无法识别，原文件已保留。请检查数据目录中的 .config/keys.json。"
    if not isinstance(raw, dict) or "keys" not in raw:
        raise KeysConfigError(invalid_structure)
    _migrate_legacy_providers(raw)
    try:
        db = KeysDB.model_validate(raw)
    except ValidationError:
        raise KeysConfigError(invalid_structure) from None
    if db.version != 1:
        raise KeysConfigError(invalid_structure)
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
            if key.provider in {"chatgpt", "comfyui"}:
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
    fd, temporary = tempfile.mkstemp(prefix="keys.", suffix=".tmp", dir=path.parent)
    tmp = Path(temporary)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            _restrict_permissions(tmp)
            stream.write(json.dumps(db.model_dump(), ensure_ascii=False, indent=2))
            stream.flush()
            os.fsync(stream.fileno())
        try:
            _replace_with_retry(tmp, path)
        except PermissionError as error:
            if sys.platform != "win32" or getattr(error, "winerror", None) != 5 or not path.is_file():
                raise
            from character_workflow.lib.win_acl import repair_legacy_keys_acl
            if not repair_legacy_keys_acl(path):
                raise
            _replace_with_retry(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    try:
        _recovered_marker().unlink(missing_ok=True)
    except OSError:
        logging.getLogger(__name__).warning("供应商配置已保存，旧恢复提示暂时无法清理")
    # 引用集合只在这里变：每次写完顺手清掉没人引用、过了宽限期的图标文件（调用方已持 keys_lock）。
    from character_workflow.lib import provider_icons
    provider_icons.prune(provider_icons.referenced_shas([k.icon for k in db.keys]))


def _restrict_permissions(path: Path) -> None:
    if sys.platform == "win32":
        from character_workflow.lib.win_acl import restrict_keys_file_windows
        restrict_keys_file_windows(path)
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
                              protocol=via.protocol, workflow_inputs=model.workflow_inputs,
                              declared_snapshot=model.declared_snapshot)
    channel_key = key.model_copy(update={
        "provider": via.provider, "base_url": via.base_url, "billing_group": via.billing_group,
        "models": [channel_model],
    })
    return channel_key, channel_model


_bound_key: ContextVar[KeySpec | None] = ContextVar("bound_provider_key", default=None)


@contextmanager
def pin_provider_key(key: KeySpec):
    """Use one validated key across dispatch and all adapter lookups for this execution."""
    token = _bound_key.set(key)
    try:
        yield
    finally:
        _bound_key.reset(token)


def find_by_alias(alias: str) -> KeySpec | None:
    bound = _bound_key.get()
    if bound is not None and bound.alias == alias:
        return bound
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


def keys_for_api(db: KeysDB | None = None) -> list[dict]:
    from character_workflow.lib import generation_pricing
    from character_workflow.lib.callers.openai_text import text_callable
    from character_workflow.lib.http_protocols import declared_for
    from character_workflow.lib.llm_protocols import detect

    if db is None:
        db = read_keys_db()
    out = []
    for k in db.keys:
        d = k.model_dump()
        for spec, row in zip(k.models, d["models"]):
            if (declared := declared_for(spec)) is not None:
                row["declared"] = declared
            if model_modality(spec, k) == "text" and not text_callable(k.provider, spec.protocol):
                row["text_unsupported"] = True  # 只在不能调用时出现：前端据此判断，不另抄协议表
            if detect.agent_tools_unverified(k, spec):
                row["agent_unverified"] = True  # 只在不进 Agent 时出现：表单据此提示，判据只在 detect 一处
            if generation_pricing.has_no_synced_price(k, spec):
                row["unpriced"] = True  # 只在未定价时出现：供应商页据此显示「单价」框
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
