"""Reject foreign browser requests before routing or consuming upload bodies.

This is the local-only transport boundary, not session authentication. Native
clients remain supported until the connection/session slice replaces that path.
"""
from __future__ import annotations

import os
import uuid
from urllib.parse import urlsplit

from starlette.responses import JSONResponse, RedirectResponse
from starlette.types import ASGIApp, Receive, Scope, Send


DEV_ORIGIN_ENV = "GAME_ATELIER_DEV_ORIGIN"


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
    def __init__(self, app: ASGIApp, *, dev_origin: str | None = None) -> None:
        self.app = app
        self.dev_origin = dev_origin

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
            if origin is not None and origin not in allowed_origins:
                await self._deny(scope, receive, send, "ORIGIN_DENIED", "此来源尚未获准连接本机")
                return
            # Same-site is insufficient: another localhost port is a different application.
            if metadata_names and site != "same-origin" and not _public_navigation(scope, mode, dest):
                await self._deny(scope, receive, send, "ORIGIN_DENIED", "请从本机页面访问工坊")
                return
        except ValueError:
            await self._deny(scope, receive, send, "ORIGIN_DENIED", "请求来源信息无效")
            return
        await self.app(scope, receive, send)

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
