"""自定义接口的目录发现：按模板的 `catalog` 发一次 GET，读出模型 id / 名称 / 类别（ADR-0036）。

只发目录请求，不发任何生成请求。出站规则与执行器一致：base_url 先过 outbound_guard，拼接后核对
源未变，不跟随重定向，响应流式限长，报错遮掉 query 密钥且异常不带原始链。价格类字段一律不读：
本机价格只来自价格同步来源。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import requests

from character_workflow.lib import outbound_guard
from character_workflow.lib.callers.declarative import authorized, redact, safe_url
from character_workflow.lib.http_protocol_render import first_value, resolve_path
from character_workflow.lib.http_protocol_schema import Catalog, HttpProtocol

RESPONSE_LIMIT = 2 * 1024 * 1024
TIMEOUT = 20.0
MAX_ENTRIES = 2000


class CatalogError(RuntimeError):
    pass


@dataclass(frozen=True)
class CatalogEntry:
    id: str
    name: str
    # 模板 kind.map 命中的类别；None 表示由调用方按现有规则判断。
    kind: str | None
    item: dict[str, Any]


def _kind(item: Any, catalog: Catalog) -> str | None:
    if catalog.kind is None:
        return None
    value = first_value(item, catalog.kind.field)
    for candidate in value if isinstance(value, list) else [value]:
        if isinstance(candidate, (str, int)) and str(candidate) in catalog.kind.map:
            return catalog.kind.map[str(candidate)]
    return None


def entries(payload: Any, catalog: Catalog) -> list[CatalogEntry]:
    rows: Any = payload
    if catalog.items:
        # 带 * 的路径本身就展开成条目；否则必须恰好指到一个数组。
        found = resolve_path(payload, catalog.items)
        rows = found if "*" in catalog.items else first_value(payload, catalog.items)
    if not isinstance(rows, list):
        where = catalog.items or "响应根"
        raise CatalogError(f"目录响应里 {where} 不是数组，请检查 catalog.items")
    out: list[CatalogEntry] = []
    seen: set[str] = set()
    for item in rows:
        raw = first_value(item, catalog.id)
        if isinstance(raw, bool) or not isinstance(raw, (str, int)) or not str(raw).strip():
            continue
        model_id = str(raw).strip()
        if model_id in seen:
            continue
        seen.add(model_id)
        name = first_value(item, catalog.name) if catalog.name else None
        label = str(name).strip() if isinstance(name, (str, int)) else ""
        out.append(CatalogEntry(id=model_id, name=label or model_id, kind=_kind(item, catalog),
                                item=item if isinstance(item, dict) else {}))
        if len(out) >= MAX_ENTRIES:
            break
    return out


def fetch_catalog(base_url: str, access_key: str, protocol: HttpProtocol) -> list[CatalogEntry]:
    catalog = protocol.catalog
    if catalog is None:
        raise CatalogError(f"自定义接口「{protocol.name}」没有填写模型目录（catalog）")
    try:
        base = outbound_guard.check_base_url(base_url)
    except outbound_guard.OutboundError as error:
        raise CatalogError(str(error)) from None
    url = base.geturl().rstrip("/") + catalog.path
    if outbound_guard.origin(urlsplit(url)) != outbound_guard.origin(base):
        raise CatalogError("目录地址拼接后离开了服务地址")
    call = authorized("GET", url, protocol, access_key)
    try:
        response = requests.get(call.url, headers=call.headers, timeout=TIMEOUT,
                                stream=True, allow_redirects=False)
    except requests.RequestException as error:
        raise CatalogError(f"请求目录失败（{safe_url(call)}）：{redact(call, str(error))}") from None
    with response:
        status = response.status_code
        try:
            raw = outbound_guard.read_limited(response, RESPONSE_LIMIT)
        except outbound_guard.OutboundError as error:
            raise CatalogError(f"目录响应过大：{error}") from None
        except requests.RequestException as error:
            raise CatalogError(f"读取目录失败：{redact(call, str(error))}") from None
    if 300 <= status < 400:
        raise CatalogError(f"目录 {status}：接口返回了重定向，自定义接口不跟随重定向")
    text = redact(call, raw[:200].decode("utf-8", "replace"))
    if status >= 400:
        raise CatalogError(f"目录 {status}：{text}")
    try:
        payload = json.loads(raw)
    except ValueError:
        raise CatalogError(f"目录响应不是 JSON：{text}") from None
    return entries(payload, catalog)
