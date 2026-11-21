"""给 openai SDK 用的协议转换 transport（ADR-0044 第 2 批；第 5 批加 Gemini）。

内置 Agent 用 openai-agents 的 `OpenAIChatCompletionsModel`，SDK 只会发 Chat Completions。把这个 transport 装进
`AsyncOpenAI(http_client=DefaultAsyncHttpxClient(transport=...))`：它拦下 `POST …/chat/completions`，按上游协议改写
请求，再把响应（含流式）转回 Chat 形状。SDK 一行不改，一次性调用与网关用的是同一份转换。

两条约束：
- 必须用 `httpx2`（openai 3.x 自带的 httpx 分支）：用普通 httpx 写的 transport 在第一个请求就断言失败。
- 与局域网网关的 `UpdatingAwareTransport` 叠加时，本 transport 在外层、等待重发在内层：先转换，再对转换后的
  请求做「主机确定没收下才重发」。接入端经网关时始终按 OpenAI 格式发（主机转换，第 4 批），本 transport 不装。
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
import httpx2 as httpx
from httpx2._utils import URLPattern, get_environment_proxies

from character_workflow.lib.llm_protocols import (
    ANTHROPIC_MESSAGES, GEMINI_GENERATE_CONTENT, ProtocolError, anthropic, gemini, translated_chunks,
)

_LABELS = {ANTHROPIC_MESSAGES: "Anthropic", GEMINI_GENERATE_CONTENT: "Gemini"}


# 上游错误响应里 SDK 用来决定重发的头（openai SDK 的 `_should_retry`）。
_RETRY_HEADERS = ("x-should-retry", "retry-after", "retry-after-ms")


class _TranslatedStream(httpx.AsyncByteStream):
    def __init__(self, upstream: httpx.Response,
                 translator: anthropic.StreamTranslator | gemini.StreamTranslator) -> None:
        self._upstream = upstream
        self._translator = translator

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in translated_chunks(self._upstream.stream, self._translator):
            yield chunk

    async def aclose(self) -> None:
        await self._upstream.aclose()


def environment_proxy_for(url: str) -> str | None:
    """SDK 默认客户端（`trust_env=True`）对这个地址会用的代理；`None` = 直连。

    直接用 httpx2 自己的两段逻辑：`get_environment_proxies`（http / https / all 三个变量与 NO_PROXY，系统代理经
    `urllib.request.getproxies`）与客户端选挂载点的规则（`URLPattern` 排序后取第一个匹配的）。不自己拼，
    才能与 SDK 默认行为一致（如只设 `ALL_PROXY`、`https_proxy` 优先于 `all_proxy`、NO_PROXY 的域名后缀匹配）。"""
    target = httpx.URL(url)
    mounts = sorted((URLPattern(key), proxy) for key, proxy in get_environment_proxies().items())
    return next((proxy for pattern, proxy in mounts if pattern.matches(target)), None)


def direct_or_proxied(url: str) -> httpx.AsyncHTTPTransport:
    """连上游用的内层 transport，代理按 `environment_proxy_for` 选。

    装了本 transport 的客户端必须 `trust_env=False`：否则 httpx 按环境代理把请求直接交给代理的 transport，
    绕过协议转换（OpenAI 格式的请求原样打到上游）。代理改在这里按上游地址选。socks5 / socks5h 由 socksio 处理。"""
    return httpx.AsyncHTTPTransport(proxy=environment_proxy_for(url))


class ProtocolTransport(httpx.AsyncBaseTransport):
    """把 Chat Completions 请求转成 `protocol` 的上游格式（Anthropic Messages 或 Gemini generateContent）。

    `base_url` / `access_key` 是供应商的地址与密钥：SDK 带的 `Authorization: Bearer` 不往上游发，
    鉴权头按上游协议重新给。其余路径原样交给内层。
    """

    def __init__(self, *, protocol: str, base_url: str, access_key: str,
                 inner: httpx.AsyncBaseTransport | None = None) -> None:
        if protocol not in _LABELS:
            raise ValueError(f"不需要转换的协议：{protocol}")
        self._protocol = protocol
        self._base_url = base_url
        self._access_key = access_key
        root = anthropic.api_root(base_url) if protocol == ANTHROPIC_MESSAGES else gemini.api_root(base_url)
        self._inner = inner or direct_or_proxied(root)

    def _target(self, model: str, stream: bool) -> tuple[str, dict[str, str]]:
        if self._protocol == ANTHROPIC_MESSAGES:
            return (anthropic.messages_url(self._base_url),
                    anthropic.headers(self._base_url, self._access_key))
        return (gemini.generate_url(self._base_url, model, stream=stream),
                gemini.headers(self._access_key))

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.method != "POST" or not request.url.path.endswith("/chat/completions"):
            return await self._inner.handle_async_request(request)
        payload = json.loads(await request.aread())
        adapter = anthropic if self._protocol == ANTHROPIC_MESSAGES else gemini
        model = str(payload.get("model") or "")
        try:
            upstream = adapter.to_upstream(payload)
        except ProtocolError as error:
            return httpx.Response(400, request=request, json={
                "error": {"message": str(error), "type": "invalid_request_error"}})
        stream = bool(payload.get("stream"))
        url, auth = self._target(model, stream)
        sent = httpx.Request(
            "POST", url,
            headers={**auth,
                     "Accept": "text/event-stream" if stream else "application/json",
                     # 转换器直接读上游原始字节：不要压缩。
                     "Accept-Encoding": "identity"},
            content=json.dumps(upstream, ensure_ascii=False).encode("utf-8"),
            extensions=request.extensions,
        )
        response = await self._inner.handle_async_request(sent)
        if response.status_code >= 400:
            # 错误体原样给 SDK（Anthropic 的 {"type":"error","error":{…}}、Gemini 的 {"error":{…}} 里都有
            # error.message）。
            # 重试相关的头一起带上：SDK 按 x-should-retry / retry-after 决定要不要重发。
            body = await response.aread()
            await response.aclose()
            headers = {"Content-Type": response.headers.get("Content-Type", "application/json")}
            headers.update({name: response.headers[name] for name in _RETRY_HEADERS
                            if name in response.headers})
            return httpx.Response(response.status_code, request=request, content=body, headers=headers)
        if not stream:
            body = await response.aread()
            await response.aclose()
            try:
                body = json.loads(body)
                converted = (anthropic.from_upstream(body) if adapter is anthropic
                             else gemini.from_upstream(body, model))
            except (ValueError, ProtocolError) as error:
                # 上游已经按 200 收下（已计费）：不让 SDK 按 5xx 重发。
                return httpx.Response(502, request=request, headers={"x-should-retry": "false"}, json={
                    "error": {"message": f"{_LABELS[self._protocol]} 响应无法解析：{error}",
                              "type": "api_error"}})
            return httpx.Response(200, request=request, json=converted)
        translator = adapter.StreamTranslator(model=model)
        return httpx.Response(200, request=request,
                              headers={"Content-Type": "text/event-stream"},
                              stream=_TranslatedStream(response, translator))

    async def aclose(self) -> None:
        await self._inner.aclose()
