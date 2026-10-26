"""OpenAI-compatible text relay, isolated to the authenticated LAN gateway app."""
from __future__ import annotations

import asyncio
import json
from contextlib import AsyncExitStack

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse

from character_workflow.lib import gateway_access, gateway_tasks, model_routes
from character_workflow.lib.callers.openai_compat import key_api_root
from character_workflow.lib.gateway_text import TextCall

MAX_BODY_BYTES = 32 * 1024 * 1024
_CAPABILITIES = ("supported_parameters", "architecture", "supported_endpoint_types",
                 "supported_protocols")


class _UpstreamFailure(gateway_tasks.GatewayRequestError):
    """The upstream may have executed; clients must not fail over to a local key."""


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(300, connect=30), trust_env=True)


class _RelayStream(StreamingResponse):
    def __init__(self, content, call, stack):
        super().__init__(content, media_type="text/event-stream")
        self.call, self.stack = call, stack

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            # Also covers disconnects before the body iterator starts.
            self.call.finish("failed")
            await asyncio.shield(self.stack.aclose())


def error_response(error: gateway_tasks.GatewayRequestError) -> JSONResponse:
    message = gateway_tasks._safe_error(error)
    kind = "gateway_upstream_error" if isinstance(error, _UpstreamFailure) else (
        "gateway_unavailable" if error.status == 503 else "gateway_error"
    )
    headers = {"Retry-After": str(error.retry_after)} if error.retry_after is not None else None
    return JSONResponse({"error": {"message": message, "type": kind, "code": error.status}},
                        status_code=error.status, headers=headers)


def _pick(owner, route_id, tried, *, params=None, route_order=None, freeze_order=None, consume=False):
    gateway_access.check_route(owner, "text", route_id)
    picked = gateway_tasks._pick_member(route_id, tried, owner, "text", params=params,
                                        route_order=route_order, freeze_order=freeze_order,
                                        consume=consume)
    if picked is None:
        raise gateway_tasks.GatewayRequestError(503, "网关的供应商都不可用")
    return picked


def _reason(error):
    if isinstance(error, (httpx.ConnectError, httpx.ConnectTimeout, httpx.ProxyError)):
        return "unreachable"
    return model_routes.failover_reason(error)


class _UsageScanner:
    """Bounded side-channel SSE reader; forwarded bytes are never modified."""
    def __init__(self, call):
        self.call = call
        self.buffer = b""
        self.dropping = False
        self.failed = False

    def feed(self, chunk):
        for segment in chunk.splitlines(keepends=True):
            ended = segment.endswith((b"\n", b"\r"))
            if not self.dropping:
                self.buffer += segment
                if len(self.buffer) > 1024 * 1024:
                    self.buffer = b""
                    self.dropping = True
            if ended:
                if not self.dropping:
                    self.line(self.buffer)
                self.buffer = b""
                self.dropping = False

    def line(self, line):
        if not line.startswith(b"data:"):
            return
        try:
            payload = json.loads(line[5:].strip())
        except (ValueError, UnicodeDecodeError):
            return
        self.call.usage(payload)
        if isinstance(payload, dict) and (payload.get("error") or payload.get("type") in (
            "error", "response.failed", "response.incomplete",
        )):
            self.failed = True


async def _body(request):
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > MAX_BODY_BYTES:
        raise gateway_tasks.GatewayRequestError(413, "请求体过大")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_BODY_BYTES:
            raise gateway_tasks.GatewayRequestError(413, "请求体过大")
    try:
        payload = json.loads(data)
    except (ValueError, UnicodeDecodeError) as error:
        raise gateway_tasks.GatewayRequestError(422, "请求体不是合法 JSON") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("model"), str):
        raise gateway_tasks.GatewayRequestError(422, "缺少模型或请求格式不对")
    if "stream" in payload and not isinstance(payload["stream"], bool):
        raise gateway_tasks.GatewayRequestError(422, "stream 必须是布尔值")
    if "stream_options" in payload and not isinstance(payload["stream_options"], dict):
        raise gateway_tasks.GatewayRequestError(422, "stream_options 必须是对象")
    _check_media_urls(payload)
    return payload, len(data)


def _check_media_urls(value):
    # Only API media references, not prompt text or tool-call argument strings.
    if isinstance(value, dict):
        for key, item in value.items():
            if key in ("url", "image_url", "video_url", "audio_url", "file_url"):
                if isinstance(item, str) and not item.startswith(("https://", "http://", "data:")):
                    raise gateway_tasks.GatewayRequestError(422, "素材必须内嵌或使用 HTTP 地址，不能传本机路径")
            _check_media_urls(item)
    elif isinstance(value, list):
        for item in value:
            _check_media_urls(item)


async def _relay(request, owner, endpoint):
    payload, body_size = await _body(request)
    route_id, streaming = payload["model"], payload.get("stream", False)
    route_order: list[str] = []
    picked = _pick(owner, route_id, [], params=payload, freeze_order=route_order, consume=True)
    call = TextCall(owner, route_id, picked, body_size, streaming, route_order=route_order)
    if streaming and endpoint == "chat/completions":
        payload["stream_options"] = {"include_usage": True, **payload.get("stream_options", {})}
    handed_off = False
    try:
        while True:
            key, model = picked
            call.member(key, model)
            stack = AsyncExitStack()
            try:
                client = await stack.enter_async_context(_client())
                response = await stack.enter_async_context(client.stream(
                    "POST", f"{key_api_root(key)}/{endpoint}",
                    headers={"Authorization": f"Bearer {key.access_key}",
                             "Content-Type": "application/json",
                             "Accept": "text/event-stream" if streaming else "application/json"},
                    json={**payload, "model": model.id},
                ))
                if not 200 <= response.status_code < 300:
                    detail = bytearray()
                    async for chunk in response.aiter_bytes():
                        detail.extend(chunk[:65536 - len(detail)])
                        if len(detail) >= 65536:
                            break
                    raise RuntimeError(f"text api {response.status_code}: "
                                       + detail.decode("utf-8", errors="replace"))
                if not streaming:
                    raw = await response.aread()
                    result = json.loads(raw)
                    if not isinstance(result, dict):
                        raise ValueError("上游响应格式不对")
                    call.usage(result)
                    if result.get("error"):
                        raise ValueError("上游返回错误响应")
                    result["model"] = route_id
                    model_routes.mark_healthy("text", key.alias)
                    call.finish("done")
                    await stack.aclose()
                    return JSONResponse(result)
                # Prime before sending headers: connection failures before any byte may fail over.
                iterator = response.aiter_bytes()
                first = await anext(iterator, None)
                if first is None:
                    raise ValueError("上游返回空流")
            except Exception as error:
                await stack.aclose()
                reason = _reason(error)
                if reason is None:
                    raise _UpstreamFailure(
                        503, gateway_tasks._safe_error(error),
                    ) from error
                model_routes.cool_down("text", key.alias, reason)
                picked = _pick(owner, route_id, call.task.route_tried, route_order=route_order, params=payload)
                continue
            except BaseException:
                await stack.aclose()
                raise
            if streaming:
                handed_off = True

                async def stream():
                    scanner = _UsageScanner(call)
                    status = "failed"
                    try:
                        scanner.feed(first)
                        yield first
                        async for chunk in iterator:
                            scanner.feed(chunk)
                            yield chunk
                        if scanner.buffer:
                            scanner.line(scanner.buffer)
                        if not scanner.failed:
                            status = "done"
                            model_routes.mark_healthy("text", key.alias)
                    except (httpx.HTTPError, OSError):
                        # Headers/bytes are already sent. Do not retry or inject a fake SSE event.
                        pass
                    finally:
                        call.finish(status)
                        await asyncio.shield(stack.aclose())

                return _RelayStream(stream(), call, stack)
            await stack.aclose()
    finally:
        if not handed_off:
            call.finish("failed")


def create_router(require_key):
    router = APIRouter(prefix="/gateway/v1/openai")

    @router.get("/models")
    async def models(owner=Depends(require_key)):
        rows = []
        upstreams = {}
        async with _client() as client:
            for route in model_routes.list_routes("text"):
                if not gateway_access.route_visible(owner, route):
                    continue
                member = next(m for m in route.members if m.provider != "atelier"
                              and gateway_access.member_allowed(owner, m.alias))
                key, model = model_routes._member_key_and_model(member)
                if key.alias not in upstreams:
                    try:
                        response = await client.get(
                            f"{key_api_root(key)}/models",
                            headers={"Authorization": f"Bearer {key.access_key}"}, timeout=10,
                        )
                        response.raise_for_status()
                        data = response.json().get("data", [])
                        upstreams[key.alias] = {r["id"]: r for r in data
                                                if isinstance(r, dict) and r.get("id")}
                    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
                        upstreams[key.alias] = {}
                info = upstreams[key.alias].get(model.id)
                capabilities = {name: info[name] for name in _CAPABILITIES if name in info} if info else {
                    "supported_parameters": ["tools"],
                }
                rows.append({"id": route.id, "object": "model", "owned_by": "atelier",
                             **capabilities})
        return {"object": "list", "data": rows}

    @router.post("/chat/completions")
    async def chat(request: Request, owner=Depends(require_key)):
        return await _relay(request, owner, "chat/completions")

    @router.post("/responses")
    async def responses(request: Request, owner=Depends(require_key)):
        return await _relay(request, owner, "responses")

    return router
