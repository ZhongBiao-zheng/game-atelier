"""Reject foreign browser requests before routing or consuming upload bodies.

This is the local-only transport boundary, not session authentication. Native
clients remain supported until the connection/session slice replaces that path.
"""
from __future__ import annotations

import os
import uuid
from typing import Callable
from urllib.parse import parse_qs, urlsplit

from starlette.responses import JSONResponse, RedirectResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send

from viewer_server.connection_capabilities import is_media_route


DEV_ORIGIN_ENV = "GAME_ATELIER_DEV_ORIGIN"
MEDIA_TOKEN_PARAM = "media_token"
_CORS_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE"
_CORS_HEADERS = "Authorization, Content-Type, X-Atelier-Client, Accept, Range"
_CORS_EXPOSE = "Content-Disposition, Content-Length, Content-Range, Accept-Ranges, Retry-After"


def development_origin() -> str | None:
    origin = os.environ.get(DEV_ORIGIN_ENV)
    if origin is None:
        return None
    try:
        url = urlsplit(origin)
        valid = (
            url.scheme == "http"
            and url.hostname in {"localhost", "127.0.0.1"}
            and url.port is not None
            and 1 <= url.port <= 65535
            and origin == f"http://{url.hostname}:{url.port}"
        )
    except ValueError:
        valid = False
    if not valid:
        raise ValueError(f"{DEV_ORIGIN_ENV} must be an exact loopback HTTP origin with a port")
    return origin


def _header(scope: Scope, name: bytes) -> str | None:
    values = [value for key, value in scope.get("headers", []) if key.lower() == name]
    if len(values) > 1:
        raise ValueError("duplicate security header")
    return values[0].decode("latin-1") if values else None


def _authority(scope: Scope) -> str | None:
    # The socket's server address, not Host / Forwarded, is the trust anchor.
    server = scope.get("server")
    if not server or server[0] != "127.0.0.1" or not 1 <= server[1] <= 65535:
        return None
    return "127.0.0.1" if server[1] == 80 else f"127.0.0.1:{server[1]}"


def media_token_param(scope: Scope) -> str | None:
    """媒体令牌只从 query 取；重复出现按无效处理。"""
    values = parse_qs(scope.get("query_string", b"").decode("latin-1"), keep_blank_values=True)
    tokens = values.get(MEDIA_TOKEN_PARAM)
    if not tokens:
        return None
    if len(tokens) > 1:
        raise ValueError("duplicate media token")
    return tokens[0]


def _tokened_media_read(scope: Scope) -> bool:
    """网站的 <img>/<video>/下载不带 Origin，只带 cross-site 元数据；放行到中间件由令牌鉴权。"""
    return (
        scope.get("method") in {"GET", "HEAD"}
        and is_media_route(scope.get("path", ""))
        and media_token_param(scope) is not None
    )


def _public_navigation(scope: Scope, mode: str | None, dest: str | None) -> bool:
    path = scope.get("path", "")
    private = (
        path == "/api" or path.startswith("/api/")
        or path == "/events" or path.startswith("/events/")
        or path in {"/docs", "/redoc", "/openapi.json"} or path.startswith("/docs/")
    )
    return (
        not private
        and scope.get("method") == "GET"
        and mode == "navigate"
        and dest == "document"
    )


class LocalRequestBoundary:
    def __init__(
        self, app: ASGIApp, *, dev_origin: str | None = None,
        site_origins: Callable[[], frozenset[str]] | None = None,
    ) -> None:
        self.app = app
        self.dev_origin = dev_origin
        # 已登记（待配对 / 已配对）的网站来源由 ConnectionStore 提供；边界层不自己记 Origin。
        self.site_origins = site_origins or (lambda: frozenset())

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            # No WebSocket route is part of the local connection contract.
            await send({"type": "websocket.close", "code": 1008})
            return
        try:
            authority = _authority(scope)
            host = _header(scope, b"host")
            if authority is None or host != authority:
                # Trigger: 用户手输 / 收藏了 http://localhost:<port>，顶层文档导航
                # Why: 连接已经落在 127.0.0.1 的 socket 上，回跳只是换个拼法，不放行任何 API
                # Outcome: 307 到 127.0.0.1 同路径；其余 Host 不匹配照旧 421
                if (
                    authority is not None and host == authority.replace("127.0.0.1", "localhost")
                    and _public_navigation(scope, _header(scope, b"sec-fetch-mode"),
                                           _header(scope, b"sec-fetch-dest"))
                ):
                    target = f"http://{authority}{scope.get('raw_path', b'/').decode('latin-1')}"
                    if scope.get("query_string"):
                        target += "?" + scope["query_string"].decode("latin-1")
                    await RedirectResponse(target, status_code=307)(scope, receive, send)
                    return
                await self._deny(scope, receive, send, "HOST_DENIED", "本机服务地址不匹配", 421)
                return
            origin = _header(scope, b"origin")
            site = _header(scope, b"sec-fetch-site")
            mode = _header(scope, b"sec-fetch-mode")
            dest = _header(scope, b"sec-fetch-dest")
            metadata_names = {
                key.lower() for key, _ in scope.get("headers", [])
                if key.lower().startswith(b"sec-fetch-")
            }
            for name in metadata_names:
                _header(scope, name)
            allowed_origins = {f"http://{authority}"}
            if self.dev_origin is not None:
                allowed_origins.add(self.dev_origin)
            site_origin = origin if origin is not None and origin in self.site_origins() else None
            if site_origin is not None:
                if scope["method"] == "OPTIONS" and _header(scope, b"access-control-request-method"):
                    await self._preflight(scope, receive, send, site_origin)
                    return
                await self.app(scope, receive, self._cors_send(send, site_origin))
                return
            if origin is not None and origin not in allowed_origins:
                await self._deny(scope, receive, send, "ORIGIN_DENIED", "此来源尚未获准连接本机")
                return
            # Same-site is insufficient: another localhost port is a different application.
            if (
                metadata_names and site != "same-origin"
                and not _public_navigation(scope, mode, dest) and not _tokened_media_read(scope)
            ):
                await self._deny(scope, receive, send, "ORIGIN_DENIED", "请从本机页面访问工坊")
                return
        except ValueError:
            await self._deny(scope, receive, send, "ORIGIN_DENIED", "请求来源信息无效")
            return
        await self.app(scope, receive, send)

    @staticmethod
    async def _preflight(scope: Scope, receive: Receive, send: Send, origin: str) -> None:
        headers = {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": _CORS_METHODS,
            "Access-Control-Allow-Headers": _CORS_HEADERS,
            "Access-Control-Max-Age": "600",
            "Vary": "Origin",
            "Cache-Control": "no-store",
        }
        # 旧版 Chrome 的 Private Network Access 预检；新版走本地网络权限弹窗，此头无害。
        if _header(scope, b"access-control-request-private-network") == "true":
            headers["Access-Control-Allow-Private-Network"] = "true"
        await Response(status_code=204, headers=headers)(scope, receive, send)

    @staticmethod
    def _cors_send(send: Send, origin: str) -> Send:
        async def cors_send(message: dict) -> None:
            if message["type"] == "http.response.start":
                raw = [(k, v) for k, v in message.get("headers", [])
                       if k.lower() not in {b"access-control-allow-origin", b"vary"}]
                vary = [v.decode("latin-1") for k, v in message.get("headers", [])
                        if k.lower() == b"vary"]
                raw.extend([
                    (b"access-control-allow-origin", origin.encode("latin-1")),
                    (b"access-control-expose-headers", _CORS_EXPOSE.encode("latin-1")),
                    (b"vary", ", ".join([*vary, "Origin"]).encode("latin-1")),
                ])
                message["headers"] = raw
            await send(message)
        return cors_send

    @staticmethod
    async def _deny(
        scope: Scope, receive: Receive, send: Send, code: str, message: str, status: int = 403,
    ) -> None:
        response = JSONResponse(
            {"error": {"code": code, "message": message, "request_id": uuid.uuid4().hex}},
            status_code=status,
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )
        await response(scope, receive, send)
