"""Authenticate before body reads, then authorize an explicit route capability."""
from __future__ import annotations

import re
import uuid
from http.cookies import CookieError, SimpleCookie

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from viewer_server.connection_auth import COOKIE_NAME, ConnectionError, ConnectionStore
from viewer_server.connection_capabilities import (
    CANVAS_TOOLS, WORKSHOP_TOOLS, is_media_route, local_capability,
)
from viewer_server.request_boundary import _authority, _header

_CONTROL_ROUTES = {
    ("POST", "/api/connection/local-session"),
    ("POST", "/api/connection/agent-sessions"),
    ("POST", "/api/connection/editor-lease"),
    ("DELETE", "/api/connection/editor-lease"),
    ("GET", "/api/connection/sessions"),
    ("GET", "/api/connection/agent-grants"),
    ("POST", "/api/connection/agent-grants"),
}


def _cookie(scope: Scope) -> str | None:
    raw = _header(scope, b"cookie")
    if not raw:
        return None
    if len(re.findall(r"(?:^|;)\s*" + COOKIE_NAME + r"\s*=", raw)) > 1:
        raise ConnectionError("CONNECTION_REQUIRED", "连接凭据无效", 401)
    cookies = SimpleCookie()
    cookies.load(raw)
    return cookies[COOKIE_NAME].value if COOKIE_NAME in cookies else None


def _private_path(path: str) -> bool:
    return (
        path == "/api" or path.startswith("/api/") or path == "/events"
        or path.startswith("/events/") or path in {"/docs", "/redoc", "/openapi.json"}
        or path.startswith("/docs/")
    )


def connection_error(error: ConnectionError) -> JSONResponse:
    return JSONResponse(
        {"error": {"code": error.code, "message": error.message, "request_id": uuid.uuid4().hex}},
        status_code=error.status,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                 "Referrer-Policy": "no-referrer", **({"Retry-After": "60"} if error.status == 429 else {})},
    )


class ConnectionMiddleware:
    def __init__(self, app: ASGIApp, *, store: ConnectionStore, dev_origin: str | None = None):
        self.app, self.store, self.dev_origin = app, store, dev_origin

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path, method = scope["path"], scope["method"]
        state = scope.setdefault("state", {})
        try:
            authority = _authority(scope)
            state["connection_base_url"] = f"http://{authority}"
            origin = _header(scope, b"origin")
            site = _header(scope, b"sec-fetch-site")
            authorization = _header(scope, b"authorization")
            cookie = _cookie(scope)
            if cookie and authorization:
                raise ConnectionError("CAPABILITY_DENIED", "不能混用两种连接凭据")
            control = (method, path) in _CONTROL_ROUTES or (
                method == "DELETE" and bool(re.fullmatch(
                    r"/api/connection/(?:sessions|agent-grants)/[a-f0-9]{32}", path,
                ))
            )
            bootstrap = method == "POST" and path == "/api/connection/local-session"
            agent_bootstrap = method == "POST" and path == "/api/connection/agent-sessions"
            if bootstrap:
                if origin is None or site != "same-origin" or authorization:
                    raise ConnectionError("ORIGIN_DENIED", "请从本地页面建立连接")
            elif agent_bootstrap:
                if origin or site or cookie or authorization:
                    raise ConnectionError("CAPABILITY_DENIED", "此入口仅用于已授权的本地 Agent")
            elif _private_path(path) and path != "/api/connection/status":
                if authorization:
                    if not authorization.startswith("Bearer ") or origin or site:
                        raise ConnectionError("CAPABILITY_DENIED", "Agent 连接凭据无效")
                    session = self.store.authenticate(authorization[7:], kind="agent", origin=None)
                elif cookie:
                    session = self.store.authenticate(cookie, kind="local", origin=origin)
                else:
                    raise ConnectionError("CONNECTION_REQUIRED", "请先连接本机工坊", 401)
                state["connection_session"] = session
                state["connection_principal"] = session.principal
                tool = method == "POST" and (
                    path.removeprefix("/api/workshop/") in WORKSHOP_TOOLS
                    or path.removeprefix("/api/canvas-agent/") in CANVAS_TOOLS
                )
                approval = method == "POST" and bool(re.fullmatch(
                    r"/api/workshop/requests/[A-Za-z0-9_-]+/approve", path,
                ))
                requests = method == "GET" and path == "/api/workshop/requests"
                if session.principal.kind == "agent":
                    if not tool:
                        raise ConnectionError("CAPABILITY_DENIED", "此 Agent 仅可使用授权工坊工具")
                elif not control:
                    capability = local_capability(method, path)
                    if tool or approval:
                        capability = "edit"
                    elif requests:
                        capability = "read"
                    if capability is None:
                        raise ConnectionError("CAPABILITY_DENIED", "此入口未授权")
                    if capability == "edit":
                        self.store.require_editor(session, _header(scope, b"x-atelier-client"))
            if method not in {"GET", "HEAD", "OPTIONS"} and _private_path(path):
                content_type = (_header(scope, b"content-type") or "").split(";", 1)[0]
                if content_type not in {"application/json", "multipart/form-data"} or (
                    (control or path.startswith(("/api/workshop/", "/api/canvas-agent/")))
                    and content_type != "application/json"
                ):
                    raise ConnectionError("CONTENT_TYPE_DENIED", "请使用正确的请求格式", 415)
                session = state.get("connection_session")
                if not agent_bootstrap and (not session or session.principal.kind == "local"):
                    if origin is None:
                        raise ConnectionError("ORIGIN_DENIED", "本地修改需要页面来源信息")
            body_limit = 16 * 1024 if control else (
                1024 * 1024
                if path.startswith(("/api/workshop/", "/api/canvas-agent/")) and method == "POST"
                else None
            )
            if body_limit is not None:
                content_length = _header(scope, b"content-length")
                if content_length is not None and int(content_length) > body_limit:
                    raise ConnectionError("REQUEST_TOO_LARGE", "请求内容过大", 413)
                chunks = []
                size = 0
                while True:
                    chunk = await receive()
                    if chunk["type"] != "http.request":
                        return
                    size += len(chunk.get("body", b""))
                    if size > body_limit:
                        raise ConnectionError("REQUEST_TOO_LARGE", "请求内容过大", 413)
                    chunks.append(chunk)
                    if not chunk.get("more_body", False):
                        break
                incoming = iter(chunks)
                original_receive = receive

                async def replay() -> dict:
                    try:
                        return next(incoming)
                    except StopIteration:
                        return await original_receive()

                receive = replay
        except (ValueError, TypeError, CookieError):
            await connection_error(ConnectionError(
                "CONNECTION_REQUIRED", "连接凭据无效", 401,
            ))(scope, receive, send)
            return
        except ConnectionError as error:
            await connection_error(error)(scope, receive, send)
            return

        keep_cache_header = is_media_route(path)

        async def private_send(message: dict) -> None:
            if message["type"] == "http.response.start":
                raw_headers = message.get("headers", [])
                # 媒体路由（缩略图 / 原图）按 URL 维度不可变，路由自己给的 Cache-Control 是契约的一部分。
                has_cache = keep_cache_header and any(k.lower() == b"cache-control" for k, _ in raw_headers)
                dropped = {b"referrer-policy"} | (set() if has_cache else {b"cache-control"})
                headers = [(key, value) for key, value in raw_headers if key.lower() not in dropped]
                headers.append((b"referrer-policy", b"no-referrer"))
                if not has_cache:
                    headers.append((b"cache-control", b"no-store" if _private_path(path) else b"no-cache"))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, private_send)
