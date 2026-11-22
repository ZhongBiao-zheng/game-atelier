"""Gemini generateContent ↔ Chat Completions 转换（ADR-0044 第 5 批）。

契约出处：https://aistudio.google.com/api-reference/generate-content.md 、
https://aistudio.google.com/docs/function-calling.md?generate-content=true 、
https://aistudio.google.com/docs/thought-signatures.md?generate-content=true
- 路径 `{root}/v1beta/models/{model}:generateContent`；流式 `:streamGenerateContent?alt=sse`，每个 data 是一个
  完整的 GenerateContentResponse 片段。模型名在路径里，不在请求体里。
- 鉴权只发 `x-goog-api-key`，不用 `?key=`（密钥不进 URL 与日志）。
- 系统提示放 `systemInstruction`；角色只有 user / model；函数调用是 model 的 `functionCall` part，结果是 user 的
  `functionResponse` part（同一步的多个结果放在同一条 content 里）。
- 图片只收 `inlineData`（base64）；`fileData` 只认上传文件与 GCS，http 地址不支持。
"""
from __future__ import annotations

import json
import logging
import re
import secrets
import time
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

from character_workflow.lib.llm_protocols import ProtocolError
from character_workflow.lib.llm_protocols.usage import from_gemini, to_chat

_ENDPOINTS = ("/chat/completions", "/responses", "/messages", "/models")
_SUFFIXES = ("/v1beta/openai", "/v1beta", "/v1")
_FINISH = {
    "STOP": "stop", "MAX_TOKENS": "length",
    "SAFETY": "content_filter", "RECITATION": "content_filter", "BLOCKLIST": "content_filter",
    "PROHIBITED_CONTENT": "content_filter", "SPII": "content_filter",
    "IMAGE_SAFETY": "content_filter",
}
_TOOL_CHOICE = {"auto": "AUTO", "none": "NONE", "required": "ANY"}

logger = logging.getLogger(__name__)

# ── thought signature（P5-points「签名与 tool_call id 的设计」） ───────────────────────────
# 签名不进 id：OpenAI Chat 的 tool_call id 上限 40、Anthropic 字符集 [A-Za-z0-9_-] 且 ≤ 64，换模型后
# 历史里的 id 会原样发给它们。id 一律是短 id：`g` + 签名状态 + 来源 + `_` + 尾巴（≤ 40 个字符）。
# 签名状态：s 有签名（进了会话）、n Gemini 没给签名、x 签名超过上限没进会话。
# 来源：u 尾巴是 Gemini 自己给的 functionCall.id（要原样带回 functionResponse.id），r 尾巴是随机的。
SIGNED, UNSIGNED, OVERSIZED = "s", "n", "x"
_CALL_ID = re.compile(r"^g([snx])([ur])_([A-Za-z0-9_-]{1,36})$")
# 单个签名超过上限不进会话（会话文件每次读改写都是整份；出图模型有 1.4 MB 的报告），按缺签名处理。
MAX_SIGNATURE_CHARS = 256 * 1024
# 官方给的占位值：不是 Gemini 产生的历史可用它跳过签名校验。只用于三种情况（见 `_signature_for`）。
PLACEHOLDER_SIGNATURE = "skip_thought_signature_validator"


def _new_call_id(state: str, upstream_id: Any = None) -> str:
    if isinstance(upstream_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,36}", upstream_id):
        return f"g{state}u_{upstream_id}"
    return f"g{state}r_{secrets.token_hex(12)}"  # 4 + 24 = 28 个字符


def _parse_call_id(call_id: str) -> tuple[str | None, str | None]:
    """(签名状态, Gemini 自己给的 id)；不是 Gemini 转换产生的 id 返回 (None, None)。"""
    match = _CALL_ID.match(call_id)
    if match is None:
        return None, None
    return match.group(1), match.group(3) if match.group(2) == "u" else None


# 下面两个函数是对 openai-agents 内部行为的全部依赖：它把 Chat 响应里 tool_call 的
# `extra_content.google.thought_signature`（Google 官方 OpenAI 兼容入口的格式）存进会话条目的
# `provider_data.thought_signature`，只在模型名含 "gemini" 时原样放回请求（openai-agents 0.23.1：
# chatcmpl_converter.py、chatcmpl_stream_handler.py）。升级 openai-agents 后跑
# tests/test_llm_protocols_gemini_agent.py 里名字带 openai_agents 的用例。
def signature_of(tool_call: dict) -> str | None:
    """请求里一个 tool_call 带回来的签名（SDK 从会话的 provider_data 放回）。"""
    google = ((tool_call.get("extra_content") or {}).get("google") or {})
    value = google.get("thought_signature")
    return value if isinstance(value, str) and value else None


def with_signature(tool_call: dict, signature: str) -> dict:
    """响应里给 tool_call 挂上签名，SDK 会把它存进会话。"""
    return {**tool_call, "extra_content": {"google": {"thought_signature": signature}}}


def mark_signatures_dropped(value: Any) -> Any:
    """导出包去掉签名后，把 id 里的签名状态 s 改成 x（没保留），id 在会话里出现的每一处一起改。

    否则在「等确认」时导出、导入后批准续跑：已确认的工具（可能是计费生成）已经执行，下一次请求却因
    「签名丢失」报错。改成 x 后按「签名没进会话」处理，填官方占位值。"""
    if isinstance(value, dict):
        return {key: mark_signatures_dropped(item) for key, item in value.items()}
    if isinstance(value, list):
        return [mark_signatures_dropped(item) for item in value]
    if isinstance(value, str) and (match := _CALL_ID.match(value)) and match.group(1) == SIGNED:
        return f"g{OVERSIZED}{value[2:]}"
    return value


def drop_signatures(items: list[dict]) -> list[dict]:
    """会话历史出本机（会话接口的响应、项目导出包）前去掉签名；落盘的会话文件保留。"""
    out = []
    for item in items:
        data = item.get("provider_data") if isinstance(item, dict) else None
        if isinstance(data, dict) and "thought_signature" in data:
            rest = {k: v for k, v in data.items() if k != "thought_signature"}
            item = {k: v for k, v in item.items() if k != "provider_data"}
            if rest:
                item["provider_data"] = rest
        out.append(item)
    return out


def api_root(base_url: str) -> str:
    """`{origin}{前缀}/v1beta`：去掉末尾的 `/v1beta/openai`、`/v1beta`、`/v1`（Gemini 的 OpenAI 兼容地址、
    原生地址、New API 习惯写的 `/v1` 都能填），再补 `/v1beta`。"""
    parts = urlsplit(base_url.strip())
    path = parts.path.rstrip("/")
    for endpoint in _ENDPOINTS:  # 填了完整端点地址（如 OpenAI 兼容的 …/chat/completions）也能用
        if path.endswith(endpoint):
            path = path[: -len(endpoint)].rstrip("/")
            break
    for suffix in _SUFFIXES:
        if path.endswith(suffix):
            path = path[: -len(suffix)].rstrip("/")
            break
    return urlunsplit((parts.scheme, parts.netloc, f"{path}/v1beta", "", ""))


def _model_path(model: str) -> str:
    return quote(model.removeprefix("models/"), safe="-._~")


def generate_url(base_url: str, model: str, *, stream: bool = False) -> str:
    action = "streamGenerateContent?alt=sse" if stream else "generateContent"
    return f"{api_root(base_url)}/models/{_model_path(model)}:{action}"


def can_generate_content(item: dict) -> bool:
    methods = item.get("supportedGenerationMethods") or []
    return not methods or "generateContent" in methods


def models_url(base_url: str) -> str:
    return f"{api_root(base_url)}/models"


def headers(access_key: str) -> dict[str, str]:
    return {"x-goog-api-key": access_key, "Content-Type": "application/json"}


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(str(part.get("text") or "") for part in content
                       if isinstance(part, dict) and part.get("type") in ("text", None))
    return ""


def _image_part(part: dict) -> dict:
    value = part.get("image_url")
    url = value.get("url") if isinstance(value, dict) else value
    if not isinstance(url, str) or not url:
        raise ProtocolError("图片缺少地址")
    if not url.startswith("data:"):
        raise ProtocolError("Gemini 接口只收 base64 图片，不收图片网址")
    header, _, data = url.partition(",")
    mime_type = header[5:].split(";", 1)[0]
    if ";base64" not in header or not mime_type or not data:
        raise ProtocolError("图片的 data URL 不是 base64 格式")
    return {"inlineData": {"mimeType": mime_type, "data": data}}


def _parts(content: Any) -> list[dict]:
    if content is None:
        return []
    if isinstance(content, str):
        return [{"text": content}] if content else []
    parts: list[dict] = []
    for part in content:
        kind = part.get("type") if isinstance(part, dict) else None
        if kind == "text":
            if part.get("text"):
                parts.append({"text": part["text"]})
        elif kind == "image_url":
            parts.append(_image_part(part))
        elif kind in ("input_audio", "audio_url"):
            raise ProtocolError("Gemini 接口暂不支持音频输入")
        elif kind == "video_url":
            raise ProtocolError("Gemini 接口暂不支持视频输入")
        else:
            raise ProtocolError(f"Gemini 接口不支持这种输入：{kind}")
    return parts


def _append(contents: list[dict], role: str, parts: list[dict]) -> None:
    """相邻同角色合并：同一步的多个 functionResponse 必须落在同一条 user content 里。"""
    if not parts:
        return
    if contents and contents[-1]["role"] == role:
        contents[-1]["parts"].extend(parts)
    else:
        contents.append({"role": role, "parts": list(parts)})


def _arguments(call: dict) -> dict:
    raw = (call.get("function") or {}).get("arguments") or "{}"
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError as error:
        raise ProtocolError("工具调用的参数不是 JSON") from error
    return value if isinstance(value, dict) else {}


def _response_value(content: Any) -> dict:
    """functionResponse.response 必须是对象：工具结果是 JSON 对象就原样给，否则包成 {"result": 文本}。"""
    text = _text_of(content)
    try:
        value = json.loads(text)
    except ValueError:
        return {"result": text}
    return value if isinstance(value, dict) else {"result": value}


def _signature_for(call: dict, *, current_turn: bool, model: str,
                   signatures: dict[str, str] | None = None) -> str | None:
    """一步里第一个 functionCall 发回上游时带的签名。

    有签名就带原值。当前轮缺签名时只在三种情况填官方占位值，其余报错（掩盖转换的 bug 比 400 更糟）：
    1. 模型名不含 "gemini"：openai-agents 不往回放签名；
    2. 签名超过上限没进会话（OVERSIZED）；
    3. 不是 Gemini 产生的调用（等确认时换成了 Gemini）。
    Gemini 本来就没给签名的调用（UNSIGNED，如不思考的模型）原样不带。更早的轮次不校验，缺了也不填。
    模型被改名时，原生 Gemini 调用按短 id 优先取转换器保留的签名；取不到则填占位值。
    这一步不依赖 user 消息位置，因为工具附图会插入一条 user 消息。含 gemini 的模型仍由 SDK 回放。"""
    if signature := signature_of(call):
        return signature
    call_id = str(call.get("id") or "")
    state, _ = _parse_call_id(call_id)
    if "gemini" not in model.lower() and state in (SIGNED, OVERSIZED):
        return (signatures or {}).get(call_id) or PLACEHOLDER_SIGNATURE
    if not current_turn:
        return None
    if state == UNSIGNED:
        return None
    if state in (OVERSIZED, None):
        return PLACEHOLDER_SIGNATURE
    if "gemini" not in model.lower():
        return PLACEHOLDER_SIGNATURE
    raise ProtocolError("Gemini 工具调用的签名丢失，无法继续这一轮")


def to_upstream(payload: dict, *, signatures: dict[str, str] | None = None) -> dict:
    """Chat Completions 请求 → Gemini generateContent 请求体（模型名与是否流式在 URL 里）。"""
    system: list[str] = []
    contents: list[dict] = []
    names: dict[str, str] = {}  # tool_call id → 函数名（functionResponse 要带名字）
    upstream_ids: dict[str, str] = {}  # tool_call id → Gemini 自己给的 functionCall.id
    # 上一步的调用（按顺序）与已收到的结果：结果要按调用的顺序发（审查模式下需确认的那个结果最后才到，
    # 同名调用又没有 id 时 Gemini 按顺序配对），缺一个都不发。
    pending: list[str] = []
    results: dict[str, dict] = {}

    def flush_results() -> None:
        if missing := [names[call_id] for call_id in pending if call_id not in results]:
            raise ProtocolError(f"工具调用缺少结果：{'、'.join(missing)}")
        _append(contents, "user", [results[call_id] for call_id in pending])
        pending.clear()
        results.clear()
    messages = payload.get("messages") or []
    model = str(payload.get("model") or "")
    # 当前轮：最后一条 user 消息（带文本或图片的那种；工具结果是 role:tool）之后的部分。看图时 Agent 在工具结果后
    # 插入的图片消息也是 user 消息，所以那之前的调用都算更早的轮次（与官方「最近一条带普通内容的 user 消息开始
    # 当前轮」一致）。
    turn_start = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=-1)
    for position, message in enumerate(messages):
        role = message.get("role")
        content = message.get("content")
        if role != "tool" and pending:
            flush_results()
        if role in ("system", "developer"):
            if text := _text_of(content):
                system.append(text)
        elif role == "user":
            _append(contents, "user", _parts(content))
        elif role == "assistant":
            parts = _parts(content)
            for index, call in enumerate(message.get("tool_calls") or []):
                name = (call.get("function") or {}).get("name") or ""
                names[str(call.get("id"))] = name
                part: dict[str, Any] = {"functionCall": {"name": name, "args": _arguments(call)}}
                if upstream_id := _parse_call_id(str(call.get("id") or ""))[1]:
                    part["functionCall"]["id"] = upstream_id
                    upstream_ids[str(call.get("id"))] = upstream_id
                # 并行调用只有第一个带签名（官方规则）。
                if index == 0 and (signature := _signature_for(
                        call, current_turn=position > turn_start, model=model, signatures=signatures)):
                    part["thoughtSignature"] = signature
                parts.append(part)
                pending.append(str(call.get("id")))
            _append(contents, "model", parts)
        elif role == "tool":
            call_id = str(message.get("tool_call_id"))
            if call_id not in pending:
                raise ProtocolError("工具结果找不到对应的调用")
            response: dict[str, Any] = {"name": names[call_id], "response": _response_value(content)}
            if call_id in upstream_ids:
                response["id"] = upstream_ids[call_id]
            results[call_id] = {"functionResponse": response}
        else:
            raise ProtocolError(f"Gemini 接口不认识这种消息角色：{role}")
    if pending:
        flush_results()
    body: dict[str, Any] = {"contents": contents}
    if system:
        body["systemInstruction"] = {"parts": [{"text": "\n\n".join(system)}]}
    config: dict[str, Any] = {}
    if limit := payload.get("max_tokens") or payload.get("max_completion_tokens"):
        config["maxOutputTokens"] = limit
    if payload.get("temperature") is not None:
        config["temperature"] = payload["temperature"]  # Gemini 的范围是 0–2，与 OpenAI 相同
    if payload.get("top_p") is not None:
        config["topP"] = payload["top_p"]
    if stop := payload.get("stop"):
        config["stopSequences"] = [stop] if isinstance(stop, str) else list(stop)
    if (payload.get("response_format") or {}).get("type") in ("json_object", "json_schema"):
        config["responseMimeType"] = "application/json"
    if config:
        body["generationConfig"] = config
    if tools := [tool for tool in payload.get("tools") or [] if tool.get("type") == "function"]:
        body["tools"] = [{"functionDeclarations": [{
            "name": tool["function"]["name"],
            "description": tool["function"].get("description") or "",
            # JSON Schema 原样给（parametersJsonSchema）；`parameters` 只收 OpenAPI 子集。
            "parametersJsonSchema": tool["function"].get("parameters")
            or {"type": "object", "properties": {}},
        } for tool in tools]}]
    if body.get("tools") and (config := _tool_config(payload.get("tool_choice"))):
        body["toolConfig"] = {"functionCallingConfig": config}
    return body


def _tool_config(choice: Any) -> dict | None:
    """`tool_choice`：auto / none / required → AUTO / NONE / ANY；指定一个函数 → ANY + allowedFunctionNames。"""
    if isinstance(choice, str):
        return {"mode": _TOOL_CHOICE[choice]} if choice in _TOOL_CHOICE else None
    if isinstance(choice, dict) and choice.get("type") == "function":
        name = (choice.get("function") or {}).get("name")
        if isinstance(name, str) and name:
            return {"mode": "ANY", "allowedFunctionNames": [name]}
    return None


def _blocked(body: dict) -> ProtocolError:
    reason = (body.get("promptFeedback") or {}).get("blockReason")
    if reason:
        return ProtocolError(f"Gemini 拒绝了这次请求（{reason}）")
    return ProtocolError("Gemini 没有返回内容")


def _upstream_error(body: dict) -> ProtocolError | None:
    """HTTP 200 但内容是错误（OpenAI-HK 等中转站余额不足时就这样回）：把上游原文带出来。"""
    error = body.get("error")
    if error is None:
        return None
    message = error.get("message") if isinstance(error, dict) else error
    return ProtocolError(f"上游返回错误：{message or json.dumps(error, ensure_ascii=False)[:300]}")


def _empty_finish(candidate: dict) -> ProtocolError:
    """没有文本也没有调用、又不是正常结束（如 MALFORMED_FUNCTION_CALL、SAFETY、MAX_TOKENS 被思考用完）：
    当错误报，不能当成「回答了空字符串」。"""
    reason = candidate.get("finishReason")
    detail = candidate.get("finishMessage")
    return ProtocolError(f"Gemini 没有生成内容（{reason}）" + (f"：{detail}" if detail else ""))


def from_upstream(body: Any, model: str = "", *, signatures: dict[str, str] | None = None) -> dict:
    """generateContent 非流式响应 → Chat Completions 响应（用量已按含缓存的总输入归一）。"""
    if not isinstance(body, dict):
        raise ProtocolError("Gemini 接口返回的不是 JSON 对象")
    if error := _upstream_error(body):
        raise error
    candidates = body.get("candidates") if isinstance(body.get("candidates"), list) else []
    if not candidates:
        raise _blocked(body)
    candidate = candidates[0] if isinstance(candidates[0], dict) else {}
    parts = (candidate.get("content") or {}).get("parts") or []
    text = "".join(str(part.get("text") or "") for part in parts
                   if isinstance(part, dict) and "text" in part and not part.get("thought"))
    calls = _function_calls([part for part in parts if isinstance(part, dict)], signatures)
    if not text and not calls and candidate.get("finishReason") not in (None, "STOP"):
        raise _empty_finish(candidate)
    message: dict[str, Any] = {"role": "assistant", "content": text or None}
    if calls:  # 非流式的 tool_calls 没有 index
        message["tool_calls"] = [{k: v for k, v in call.items() if k != "index"} for call in calls]
    finish = "tool_calls" if calls else _FINISH.get(candidate.get("finishReason"), "stop")
    result: dict[str, Any] = {
        "id": body.get("responseId"), "object": "chat.completion",
        "model": body.get("modelVersion") or model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
    }
    if (usage := from_gemini(body.get("usageMetadata"))) is not None:
        result["usage"] = to_chat(usage)
    return result


def _part_signature(part: dict) -> str | None:
    value = part.get("thoughtSignature") or part.get("thought_signature")  # 官方文档两种拼法都出现过
    return value if isinstance(value, str) and value else None


def _tool_call(function_call: dict, index: int, signature: str | None) -> dict:
    """一个 functionCall → Chat 的 tool_call：短 id，签名（只有一步里的第一个调用有）挂在 extra_content。"""
    call = {"index": index, "type": "function", "function": {
        "name": function_call.get("name") or "",
        "arguments": json.dumps(function_call.get("args") or {}, ensure_ascii=False)}}
    if signature is None:
        return {**call, "id": _new_call_id(UNSIGNED, function_call.get("id"))}
    if len(signature) > MAX_SIGNATURE_CHARS:
        logger.warning("gemini thought signature over limit, not kept: %d chars", len(signature))
        return {**call, "id": _new_call_id(OVERSIZED, function_call.get("id"))}
    return with_signature({**call, "id": _new_call_id(SIGNED, function_call.get("id"))}, signature)


def _function_calls(parts: list[dict], signatures: dict[str, str] | None = None) -> list[dict]:
    """一步里的 functionCall → tool_calls。签名取第一个调用自己的；没有时取它之后某个非调用 part 上的
    （流式时签名可能单独出现在一个空文本 part 里）。后面的调用一律不带签名。"""
    calls: list[dict] = []
    signature: str | None = None
    for part in parts:
        if isinstance(part.get("functionCall"), dict):
            calls.append(part["functionCall"])
            if len(calls) == 1:
                signature = _part_signature(part)
        elif calls and signature is None and not part.get("text"):
            signature = _part_signature(part)  # 只认空文本 part 上的；有文本的签名属于那段文本
    converted = [_tool_call(call, index, signature if index == 0 else None)
                 for index, call in enumerate(calls)]
    if signatures is not None:
        for call in converted:
            if value := signature_of(call):
                signatures[call["id"]] = value
        # 缓存只活在一个 SDK 客户端里，不跨会话、供应商或模型；过期条目走占位值。
        while len(signatures) > 128:
            signatures.pop(next(iter(signatures)))
    return converted


class StreamTranslator:
    """`streamGenerateContent?alt=sse` → Chat Completions 流式块（SSE 字节）。带状态，逐块喂。

    - 每个 data 是一个完整的 GenerateContentResponse 片段：text 是增量，按块转发（`thought: true` 不转）。
    - functionCall 整块到达，但签名可能在之后的空文本 part 上：先攒着，本条 candidate 有 `finishReason` 时
      一起发出，再发 finish 块。
    - 用量在 `usageMetadata`，取最后一次；上游流结束时发 usage 块与 `[DONE]`。没收到 `finishReason`
      就断了按错误处理；`{"error": …}` 数据块转成错误块。
    """

    def __init__(self, model: str, *, signatures: dict[str, str] | None = None) -> None:
        self._model = model
        self._signatures = signatures
        self._id = ""
        self._created = int(time.time())
        self._buffer = b""
        self._parts: list[dict] = []  # 本步攒下的 functionCall 与签名 part
        self._usage: dict | None = None
        self._finish: str | None = None
        self._started = False
        self._text = False  # 这一步已经发出过正文
        self._other = b""  # 不是 SSE 的内容（200 + JSON 错误体），收尾时读出上游原文
        self.finished = False

    def feed(self, chunk: bytes) -> bytes:
        self._buffer += chunk
        *lines, self._buffer = self._buffer.split(b"\n")
        return b"".join(self._line(raw) for raw in lines)

    def _line(self, raw: bytes) -> bytes:
        line = raw.rstrip(b"\r")
        if self.finished:
            return b""
        if not line.startswith(b"data:"):
            if len(self._other) < 65536:
                self._other += line + b"\n"
            return b""
        try:
            event = json.loads(line[5:].strip())
        except ValueError:
            return b""
        return b"".join(self._handle(event)) if isinstance(event, dict) else b""

    def finish(self) -> bytes:
        # 最后一行没有换行结尾也要处理。
        head = self._line(self._buffer) if self._buffer.strip() else b""
        self._buffer = b""
        if self.finished:
            return head
        self.finished = True
        if self._finish is None:
            return head + _sse({"error": self._unfinished_error()})
        out = [head]
        if (usage := from_gemini(self._usage)) is not None:
            out.append(_sse({"id": self._id, "object": "chat.completion.chunk", "created": self._created,
                             "model": self._model, "choices": [], "usage": to_chat(usage)}))
        out.append(b"data: [DONE]\n\n")
        return b"".join(out)

    def _unfinished_error(self) -> dict:
        """没收到 finishReason：上游回的若是 JSON 错误体（HTTP 200），把原文带出来；否则是中途断了。"""
        raw = self._other.decode("utf-8", "replace").strip()
        if not self._started and raw:
            try:
                body = json.loads(raw)
            except ValueError:
                return {"message": f"Gemini 返回的不是流式数据：{raw[:300]}", "type": "api_error"}
            if isinstance(body, dict) and (error := _upstream_error(body)):
                return {"message": str(error), "type": "api_error"}
            return {"message": f"Gemini 返回的不是流式数据：{raw[:300]}", "type": "api_error"}
        return {"message": "Gemini 流式响应中途结束", "type": "incomplete_stream"}

    def _chunk(self, delta: dict, finish: str | None = None) -> bytes:
        return _sse({"id": self._id, "object": "chat.completion.chunk", "created": self._created,
                     "model": self._model,
                     "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})

    def _handle(self, event: dict) -> list[bytes]:
        if isinstance(event.get("error"), dict):
            self.finished = True
            error = event["error"]
            return [_sse({"error": {"message": error.get("message") or "Gemini 返回错误",
                                    "type": str(error.get("status") or "api_error")}})]
        self._id = self._id or str(event.get("responseId") or "")
        if isinstance(event.get("usageMetadata"), dict):
            self._usage = event["usageMetadata"]
        out: list[bytes] = []
        if not self._started:
            self._started = True
            out.append(self._chunk({"role": "assistant", "content": ""}))
        candidates = event.get("candidates") if isinstance(event.get("candidates"), list) else []
        if not candidates:
            if (event.get("promptFeedback") or {}).get("blockReason"):
                self.finished = True
                out.append(_sse({"error": {"message": str(_blocked(event)), "type": "blocked"}}))
            return out
        candidate = candidates[0] if isinstance(candidates[0], dict) else {}
        for part in (candidate.get("content") or {}).get("parts") or []:
            if not isinstance(part, dict):
                continue
            if "functionCall" in part or (self._parts and _part_signature(part) and not part.get("text")):
                self._parts.append(part)
            elif part.get("text") and not part.get("thought"):
                self._text = True
                out.append(self._chunk({"content": part["text"]}))
        if reason := candidate.get("finishReason"):
            calls = _function_calls(self._parts, self._signatures)
            self._parts = []
            if not calls and not self._text and reason != "STOP":
                self.finished = True
                out.append(_sse({"error": {"message": str(_empty_finish(candidate)),
                                           "type": str(reason)}}))
                return out
            if calls:
                out.append(self._chunk({"tool_calls": calls}))
            self._finish = "tool_calls" if calls else _FINISH.get(reason, "stop")
            out.append(self._chunk({}, self._finish))
        return out


def _sse(payload: dict) -> bytes:
    return b"data: " + json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n\n"
