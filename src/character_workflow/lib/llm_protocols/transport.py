"""给 openai SDK 用的协议转换 transport（ADR-0044 第 2 批）。

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

from character_workflow.lib.llm_protocols import ProtocolError, anthropic


class _TranslatedStream(httpx.AsyncByteStream):
    def __init__(self, upstream: httpx.Response, translator: anthropic.StreamTranslator) -> None:
        self._upstream = upstream
        self._translator = translator

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in self._upstream.stream:
            if data := self._translator.feed(chunk):
                yield data
        if tail := self._translator.finish():
            yield tail

    async def aclose(self) -> None:
        await self._upstream.aclose()


class ProtocolTransport(httpx.AsyncBaseTransport):
    """把 Chat Completions 请求转成 Anthropic Messages（目前唯一需要转换的对话协议）。

    `base_url` / `access_key` 是供应商的地址与密钥：SDK 带的 `Authorization: Bearer` 不往上游发，
    鉴权头按 Anthropic 重新给。其余路径原样交给内层。
    """

    def __init__(self, *, base_url: str, access_key: str,
                 inner: httpx.AsyncBaseTransport | None = None) -> None:
        self._base_url = base_url
        self._access_key = access_key
        self._inner = inner or httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.method != "POST" or not request.url.path.endswith("/chat/completions"):
            return await self._inner.handle_async_request(request)
        payload = json.loads(await request.aread())
        try:
            upstream = anthropic.to_upstream(payload)
        except ProtocolError as error:
            return httpx.Response(400, request=request, json={
                "error": {"message": str(error), "type": "invalid_request_error"}})
        stream = bool(payload.get("stream"))
        sent = httpx.Request(
            "POST", anthropic.messages_url(self._base_url),
            headers={**anthropic.headers(self._base_url, self._access_key),
                     "Accept": "text/event-stream" if stream else "application/json",
                     # 转换器直接读上游原始字节：不要压缩。
                     "Accept-Encoding": "identity"},
            content=json.dumps(upstream, ensure_ascii=False).encode("utf-8"),
            extensions=request.extensions,
        )
        response = await self._inner.handle_async_request(sent)
        if response.status_code >= 400:
            # 错误体原样给 SDK（Anthropic 的 {"type":"error","error":{…}} 里同样有 error.message）。
            body = await response.aread()
            await response.aclose()
            return httpx.Response(response.status_code, request=request, content=body,
                                  headers={"Content-Type": response.headers.get(
                                      "Content-Type", "application/json")})
        if not stream:
            body = await response.aread()
            await response.aclose()
            try:
                converted = anthropic.from_upstream(json.loads(body))
            except (ValueError, ProtocolError) as error:
                return httpx.Response(502, request=request, json={
                    "error": {"message": f"Anthropic 响应无法解析：{error}", "type": "api_error"}})
            return httpx.Response(200, request=request, json=converted)
        translator = anthropic.StreamTranslator(model=str(payload.get("model") or ""))
        return httpx.Response(200, request=request,
                              headers={"Content-Type": "text/event-stream"},
                              stream=_TranslatedStream(response, translator))

    async def aclose(self) -> None:
        await self._inner.aclose()
