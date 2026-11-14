"""自定义接口模板的存储、绑定与能力声明。

一份模板一个文件：`<data_root>/.config/http-protocols/<id>.json`，内容是用户提交并通过校验的
模板正文原样（导出即这份文件）。读盘时重新校验，失败只让这一份不可用。
模型通过 `ModelSpec.protocol == "declarative"` + `declarative_id` 绑定模板，只允许自定义供应商。
"""
from __future__ import annotations

import json
import re
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.http_protocol_schema import (
    HttpProtocol, Issue, ProtocolInvalidError, declared_capabilities, parse_protocol,
)

PROTOCOL = "declarative"
_ID = re.compile(r"^hp-[0-9a-f]{12}$")


class ProtocolUnavailableError(ValueError):
    """模板不存在或已损坏：只影响绑定它的模型。"""


class ProtocolInUseError(ValueError):
    pass


@dataclass(frozen=True)
class StoredProtocol:
    id: str
    document: dict[str, Any] | None
    protocol: HttpProtocol | None
    error: str | None


def protocols_dir() -> Path:
    return data_root.config_dir() / "http-protocols"


def _lock():
    return file_lock(data_root.config_dir() / "http-protocols.lock")


def valid_id(identifier: str) -> bool:
    return bool(_ID.match(identifier or ""))


def _path(identifier: str) -> Path:
    if not valid_id(identifier):
        raise ProtocolUnavailableError("自定义接口不存在")
    return protocols_dir() / f"{identifier}.json"


def read_stored(identifier: str) -> StoredProtocol:
    if not valid_id(identifier) or not _path(identifier).exists():
        return StoredProtocol(identifier, None, None, "自定义接口不存在")
    broken = "自定义接口已损坏，请在设置里重新保存"
    try:
        document = json.loads(_path(identifier).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return StoredProtocol(identifier, None, None, broken)
    try:
        protocol = parse_protocol(document)
    except ProtocolInvalidError:
        return StoredProtocol(identifier, document if isinstance(document, dict) else None,
                              None, broken)
    return StoredProtocol(identifier, document, protocol, None)


def read_protocol(identifier: str) -> HttpProtocol:
    stored = read_stored(identifier)
    if stored.protocol is None:
        raise ProtocolUnavailableError(stored.error or "自定义接口不可用")
    return stored.protocol


def list_protocols() -> list[StoredProtocol]:
    directory = protocols_dir()
    if not directory.exists():
        return []
    ids = sorted(p.stem for p in directory.glob("hp-*.json") if valid_id(p.stem))
    return [read_stored(identifier) for identifier in ids]


def environment_issues(protocol: HttpProtocol) -> list[Issue]:
    """依赖本机环境的检查：模板结构合法，但这台机器跑不了。只在写入边界与 validate 里用。"""
    images = protocol.inputs.images
    if images is not None and images.encode == "url":
        from character_workflow.lib import keys

        if keys.read_keys_db().oss is None:
            return [Issue(path="inputs.images.encode", message=(
                "参考图按公网地址发送需要先配置对象存储（.config/keys.json 的 oss 字段）："
                "本机图片没有公网地址，要先上传到对象存储再把直链发给厂商"))]
    return []


def save_protocol(document: Any, identifier: str | None = None) -> StoredProtocol:
    protocol = parse_protocol(document)
    issues = environment_issues(protocol)
    if issues:
        raise ProtocolInvalidError(issues)
    with _lock():
        if identifier is None:
            identifier = "hp-" + secrets.token_hex(6)
            while _path(identifier).exists():
                identifier = "hp-" + secrets.token_hex(6)
        else:
            if not _path(identifier).exists():
                raise ProtocolUnavailableError("自定义接口不存在")
            previous = read_stored(identifier).protocol
            if previous and previous.kind != protocol.kind and bindings(identifier):
                raise ProtocolInUseError("已有模型在使用这个接口，不能改类型")
        atomic_write_json(_path(identifier), document)
    return StoredProtocol(identifier, document, protocol, None)


def delete_protocol(identifier: str) -> None:
    from character_workflow.lib import keys

    path = _path(identifier)
    with keys.keys_lock(), _lock():
        if bindings(identifier):
            raise ProtocolInUseError("还有模型在使用这个接口，先在供应商里换掉再删除")
        path.unlink(missing_ok=True)


def bindings(identifier: str) -> list[tuple[str, str]]:
    from character_workflow.lib import keys

    return [(key.alias, model.id) for key in keys.read_keys_db().keys for model in key.models
            if model.protocol == PROTOCOL and model.declarative_id == identifier]


def is_declarative(model: Any) -> bool:
    return getattr(model, "protocol", None) == PROTOCOL


def declared_for(model: Any) -> dict[str, Any] | None:
    """随模型返回给前端的只读能力声明；模板不可用时带 error，模型不可选。"""
    if not is_declarative(model):
        return None
    stored = read_stored(model.declarative_id or "")
    if stored.protocol is None:
        return {"available": False, "error": stored.error, "name": None}
    return {"available": True, "error": None, "name": stored.protocol.name,
            **declared_capabilities(stored.protocol)}


def normalize_bindings(provider: str, models: list[Any]) -> list[Any]:
    """API 写入边界：校验并规整模型绑定。只在这里拒绝，读盘时不校验（旧数据不能被拖垮）。"""
    out = []
    for model in models:
        if model.protocol != PROTOCOL and not model.declarative_id:
            out.append(model)
            continue
        label = model.name or model.id
        if provider != "custom":
            raise ValueError("只有自定义供应商可以使用自定义接口")
        if not model.declarative_id:
            raise ValueError(f"模型「{label}」没有选择自定义接口")
        protocol = read_protocol(model.declarative_id)
        if model.modality is not None and model.modality != protocol.kind:
            raise ValueError(f"模型「{label}」的类型与自定义接口「{protocol.name}」不一致")
        out.append(model.model_copy(update={"protocol": PROTOCOL, "modality": protocol.kind}))
    return out
