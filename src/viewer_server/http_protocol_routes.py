"""自定义接口模板的管理接口（只给本机页面，不挂在局域网网关上；ADR-0036）。"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib import http_protocols as store
from character_workflow.lib.callers import declarative
from character_workflow.lib.http_protocol_schema import (
    HttpProtocol, ProtocolInvalidError, declared_capabilities, parse_protocol,
)

router = APIRouter(prefix="/api/http-protocols")
_PREVIEW_BASE = "https://api.example.com"
_MASK = "***"


class _Document(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document: dict[str, Any]


class _Validate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document: Any
    base_url: str | None = Field(default=None, max_length=2048)
    model: str | None = Field(default=None, max_length=200)


def _row(stored: store.StoredProtocol, used_by: list[tuple[str, str]]) -> dict[str, Any]:
    protocol = stored.protocol
    document = stored.document or {}
    return {
        "id": stored.id,
        "name": protocol.name if protocol else str(document.get("name") or stored.id),
        "kind": protocol.kind if protocol else document.get("kind"),
        "available": protocol is not None, "error": stored.error,
        "declared": declared_capabilities(protocol) if protocol else None,
        "used_by": [{"alias": alias, "model": model} for alias, model in used_by],
    }


def _invalid(error: ProtocolInvalidError) -> HTTPException:
    return HTTPException(422, {"message": str(error), "code": "PROTOCOL_INVALID"})


@router.get("")
def listing() -> dict:
    return {"protocols": [_row(item, store.bindings(item.id)) for item in store.list_protocols()]}


@router.post("/validate")
def validate(body: _Validate) -> dict:
    """校验 + 请求预览，不发请求、不写盘。设置页与后续的「AI 帮我配置」共用这一个入口。"""
    try:
        protocol = parse_protocol(body.document)
    except ProtocolInvalidError as error:
        return {"valid": False, "issues": [i.model_dump() for i in error.issues],
                "declared": None, "preview": None}
    environment = store.environment_issues(protocol)
    if environment:
        return {"valid": False, "issues": [i.model_dump() for i in environment],
                "declared": declared_capabilities(protocol), "preview": None}
    try:
        preview = _preview(protocol, body.base_url or _PREVIEW_BASE, body.model or "model-id")
    except (declarative.DeclarativeError, ValueError) as error:
        return {"valid": False, "issues": [{"path": "(预览)", "message": str(error)}],
                "declared": declared_capabilities(protocol), "preview": None}
    return {"valid": True, "issues": [], "declared": declared_capabilities(protocol),
            "preview": preview}


@router.get("/{identifier}")
def detail(identifier: str) -> dict:
    stored = store.read_stored(identifier)
    if stored.document is None:
        raise HTTPException(404, stored.error or "自定义接口不存在")
    return {**_row(stored, store.bindings(identifier)), "document": stored.document}


@router.post("", status_code=201)
def create(body: _Document) -> dict:
    try:
        stored = store.save_protocol(body.document)
    except ProtocolInvalidError as error:
        raise _invalid(error) from None
    return {**_row(stored, []), "document": stored.document}


@router.put("/{identifier}")
def update(identifier: str, body: _Document) -> dict:
    try:
        stored = store.save_protocol(body.document, identifier)
    except ProtocolInvalidError as error:
        raise _invalid(error) from None
    except store.ProtocolUnavailableError as error:
        raise HTTPException(404, str(error)) from None
    except store.ProtocolInUseError as error:
        raise HTTPException(409, str(error)) from None
    return {**_row(stored, store.bindings(identifier)), "document": stored.document}


@router.delete("/{identifier}", status_code=204)
def delete(identifier: str) -> None:
    try:
        store.delete_protocol(identifier)
    except store.ProtocolUnavailableError as error:
        raise HTTPException(404, str(error)) from None
    except store.ProtocolInUseError as error:
        raise HTTPException(409, str(error)) from None


def _preview_encoder(_path: str, encode: str, label: str) -> str:
    if encode == "file":
        return f"<文件 {label}>"
    return f"<{label} 公网地址>" if encode == "url" else f"<{label}>"


def _call_view(call: declarative.PreparedCall) -> dict[str, Any]:
    body: Any = call.json_body
    if call.parts:
        grouped: dict[str, list[Any]] = {}
        for name, (_filename, value, _mime) in call.parts:
            grouped.setdefault(name, []).append(value)
        body = {name: values[0] if len(values) == 1 else values
                for name, values in grouped.items()}
    return {"method": call.method, "url": call.url, "headers": call.headers, "body": body}


def _preview(protocol: HttpProtocol, base_url: str, model: str) -> dict[str, Any]:
    base = urlsplit(base_url.strip())
    if base.scheme not in ("http", "https") or not base.hostname:
        raise ValueError("服务地址需要是 http(s) 地址")
    caps = declared_capabilities(protocol)
    sample = caps["frames"] or caps["reference_images"]
    params = {"reference_images": [f"sample-{i}" for i in range(1, sample + 1)],
              "frame_mode": "firstlast" if caps["frames"] else "auto"}
    context = declarative.build_context(protocol, prompt="示例提示词", model=model,
                                        params=params, encoder=_preview_encoder)
    view: dict[str, Any] = {"submit": _call_view(
        declarative.prepare(base, _MASK, protocol, context))}
    if protocol.poll is not None:
        view["poll"] = _call_view(declarative.prepare(
            base, _MASK, protocol, {**context, "taskId": "<task-id>"}, poll=True))
    return view
