"""对话模型的调用协议（ADR-0044）。

内部统一用 OpenAI Chat Completions 的请求 / 响应形状；发请求前、收响应后按模型的协议转换。
协议 id 存在 `ModelSpec.protocol`（自由字符串，旧版读到新值不会报错）。
"""
from __future__ import annotations

OPENAI_CHAT = "openai-chat"
OPENAI_RESPONSES = "openai-responses"
ANTHROPIC_MESSAGES = "anthropic-messages"

# 走 OpenAI 线路格式的协议；None = 未标注，按 Chat 处理；另两个是旧数据里出现过的写法。
OPENAI_WIRE: frozenset[str | None] = frozenset({
    None, "openai", OPENAI_CHAT, "chat-completions", OPENAI_RESPONSES,
})
TEXT_PROTOCOLS: frozenset[str | None] = OPENAI_WIRE | {ANTHROPIC_MESSAGES}

# 供应商级「对话接口」可以手动选的值（`KeySpec.text_protocol`）；None = 自动。
MANUAL_CHOICES: tuple[str, ...] = (OPENAI_CHAT, OPENAI_RESPONSES, ANTHROPIC_MESSAGES)

LABELS = {
    OPENAI_CHAT: "OpenAI Chat",
    OPENAI_RESPONSES: "OpenAI Responses",
    ANTHROPIC_MESSAGES: "Anthropic",
}


def speaks_openai(protocol: str | None) -> bool:
    """按 OpenAI 格式（Chat / Responses）收发，不需要转换。局域网网关与内置 Agent 目前只接这类。"""
    return protocol in OPENAI_WIRE


class ProtocolError(ValueError):
    """请求内容无法用这个协议表达（例如 Anthropic 不收视频）。"""


# 「接口选错了」的典型报文（全部小写比对）：
# - OpenAI 官方收到不认识的路径：`Invalid URL (POST /v1/messages)`；
# - One API 等 Gin 服务没有这个路由：`404 page not found`；
# - New API 不能把这种格式转给这条渠道：`convert_request_failed` / `not implemented`；
# - 只能用 Responses 的模型被按 Chat 调：`only supported in v1/responses`。
_RESPONSES_ONLY = ("only supported in v1/responses", "not supported in v1/chat/completions")
_WRONG_ENDPOINT = ("invalid url", "404 page not found", "convert_request_failed",
                   "not implemented", "unsupported endpoint")
SWITCH_TO_RESPONSES = "这个模型只能用 OpenAI Responses 接口调用：到「设置 → 供应商」把这个供应商的「对话接口」改成 OpenAI Responses 后重试"
SWITCH_INTERFACE = "供应商不支持当前的调用接口：到「设置 → 供应商」把这个供应商的「对话接口」换成 OpenAI Chat、OpenAI Responses 或 Anthropic 后重试"
NOT_AN_API = "供应商地址返回的不是接口数据：检查请求地址，或到「设置 → 供应商」换一种「对话接口」后重试"


def mismatch_hint(raw: str) -> str | None:
    """报错像是「协议选错了」时给出改「接口」的提示；不像就返回 None。

    不自动换协议重试：换一种协议再发一次可能重复计费（ADR-0044）。"""
    low = raw.lower()
    if any(word in low for word in _RESPONSES_ONLY):
        return SWITCH_TO_RESPONSES
    if any(word in low for word in _WRONG_ENDPOINT):
        return SWITCH_INTERFACE
    if "response is not json" in low:
        return NOT_AN_API
    return None
