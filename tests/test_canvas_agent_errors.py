"""画布 Agent 对话模型报错的提示：只有上游明确说「不支持工具 / 不能看图」才提示换模型（并附原文），
其余工具、图片相关的错误原样显示（带状态码）。

每条样例标了来源：
- 真实报文：公开 issue / 论坛里用户贴出的上游原文（链接在注释里）
- 常见报错：社区里常见的写法，凭印象写下，没有逐字核对、没有链接
- 推测：没找到原文，按常见写法拟的；provider-protocols 会话给出真实报文后替换
- 协议会话：provider-protocols-HANDOFF-P5.md「工具相关 400 的样例报文」，括号里是它标的核对程度
  （它说明没有一条是本仓实测原文，所以判据只认特征句式、不依赖整句）
"""
from __future__ import annotations

import httpx
import pytest
from openai import APIStatusError

from character_workflow.lib import canvas_agent_runtime as runtime

TOOL_HINT = "该模型不支持工具调用，请换一个"
IMAGE_HINT = "该模型不能看图，请换一个支持图片输入的模型"


def _error(status: int, message: str, *, anthropic: bool = False) -> APIStatusError:
    """OpenAI 兼容：{"error": {"message"}}；Anthropic（经 llm_protocols.transport 原样透传）：
    {"type": "error", "error": {"type", "message"}}。"""
    detail = {"type": "invalid_request_error", "message": message}
    body = {"type": "error", "error": detail} if anthropic else {"error": detail}
    response = httpx.Response(status, request=httpx.Request("POST", "https://example.invalid/v1/chat"),
                              json=body)
    return APIStatusError(message, response=response, body=body)


# ── 明确说不支持：提示换模型，后面附原文 ────────────────────────────────────────────

NO_TOOL_SUPPORT = [
    # 真实报文：Ollama，https://www.betterclaw.io/tools/agent-error-decoder/ollama-does-not-support-tools
    pytest.param(400, "registry.ollama.ai/library/deepseek-r1:8b does not support tools", id="ollama"),
    # 真实报文：Gemini 微调模型，https://discuss.ai.google.dev/t/error-ai-apicallerror-function-calling-is-not-enabled-for-tunedmodels/60203
    pytest.param(400, "Function calling is not enabled for tunedModels/roryb-jgtp", id="gemini-tuned"),
    # 真实报文：OpenRouter（404），https://github.com/anomalyco/opencode/issues/1002
    pytest.param(404, "No endpoints found that support tool use. To learn more about provider routing, "
                      "visit: https://openrouter.ai/docs/provider-routing", id="openrouter"),
    # 推测：vLLM 没开 --enable-auto-tool-choice 时的报错，未逐字核对源码
    pytest.param(400, '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
                 id="vllm-guess"),
    # 推测：OpenAI 旧推理模型拒绝 tools 参数
    pytest.param(400, "Unsupported parameter: 'tools' is not supported with this model.", id="openai-guess"),
    # 推测：DeepSeek 推理模型
    pytest.param(400, "deepseek-reasoner does not support Function Calling", id="deepseek-guess"),
    # 推测：国内中转的中文报错
    pytest.param(400, "当前模型不支持工具调用", id="relay-zh-guess"),
    # 协议会话（OpenAI 兼容中转 / vLLM 类，未逐字核对）
    pytest.param(400, "tools is not supported", id="relay-tools-not-supported"),
    pytest.param(400, "this model does not support tools", id="relay-model-does-not-support"),
    # 协议会话（Gemini 旧模型，未逐字核对）
    pytest.param(400, "Function calling is not enabled for models/gemini-1.0-pro", id="gemini-old-model"),
]

NO_IMAGE_SUPPORT = [
    # 常见报错（未逐字核对，无链接）：OpenAI 不支持图片的模型收到 image_url
    pytest.param(400, "Invalid content type. image_url is only supported by certain models.", id="openai"),
    # 常见报错（未逐字核对，无链接）：DeepSeek 收到图片内容块
    pytest.param(422, "Failed to deserialize the JSON body into the target type: messages[0]: unknown variant "
                      "`image_url`, expected `text` at line 1 column 120", id="deepseek"),
    # 推测：通用英文写法
    pytest.param(400, "This model does not support image input", id="generic-guess"),
    # 推测：国内中转的中文报错
    pytest.param(400, "该模型不支持图片输入", id="relay-zh-guess"),
]


@pytest.mark.parametrize(("status", "message"), NO_TOOL_SUPPORT)
def test_tools_unsupported_suggests_another_model_and_keeps_the_original(status, message):
    text = runtime.friendly_error(_error(status, message))
    assert text == f"{TOOL_HINT}（原始报错：{status} {runtime.redact(message)[:300]}）"


@pytest.mark.parametrize(("status", "message"), NO_IMAGE_SUPPORT)
def test_images_unsupported_suggests_another_model_and_keeps_the_original(status, message):
    text = runtime.friendly_error(_error(status, message))
    assert text == f"{IMAGE_HINT}（原始报错：{status} {runtime.redact(message)[:300]}）"


# ── 工具 / 图片相关但不是模型能力问题：原样显示 ─────────────────────────────────────

SHOWN_AS_IS = [
    # 真实报文：Gemini 3 缺思考签名，https://discuss.ai.google.dev/t/gemini-3-thought-signature-is-not-valid-cant-do-multi-turn-tool-calling/119360
    pytest.param(400, "Function call is missing a thought_signature in functionCall parts. This is required for "
                      "tools to work correctly, and missing thought_signature may lead to degraded model "
                      "performance.", False, id="gemini-signature"),
    # 常见报错（未逐字核对，无链接；协议会话同样标未逐字核对）：Gemini 函数调用与结果数量不配对
    pytest.param(400, "Please ensure that the number of function response parts is equal to the number of "
                      "function call parts of the function call turn.", False, id="gemini-pairing"),
    # 常见报错（未逐字核对，无链接）：Gemini 工具定义里有不认识的字段
    pytest.param(400, "Invalid JSON payload received. Unknown name \"additionalProperties\" at "
                      "'tools[0].function_declarations[0].parameters': Cannot find field.", False,
                 id="gemini-schema"),
    # 真实报文：Anthropic tool_use.id 不合规，openai-agents-python#1147
    pytest.param(400, "messages.1.content.0.tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'",
                 True, id="anthropic-tool-use-id"),
    # 常见报错（未逐字核对，无链接；协议会话同样标未逐字核对）：Anthropic 工具调用后面没紧跟结果
    pytest.param(400, "messages.2: `tool_use` ids were found without `tool_result` blocks immediately after: "
                      "toolu_01A. Each `tool_use` block must have a corresponding `tool_result` block in the "
                      "next message.", True, id="anthropic-tool-result"),
    # 常见报错（未逐字核对；官方文档写了这条限制，报文原文没核对）：Anthropic 扩展思考与强制工具调用不能同时开
    pytest.param(400, "Thinking may not be enabled when tool_choice forces tool use.", True,
                 id="anthropic-thinking-tool-choice"),
    # 常见报错（未逐字核对，无链接）：Anthropic 图片超过 5 MB
    pytest.param(400, "messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 6291456 bytes > "
                      "5242880 bytes", True, id="anthropic-image-too-large"),
    # 常见报错（未逐字核对，无链接）：OpenAI 图片格式或大小不对
    pytest.param(400, "You uploaded an unsupported image. Please make sure your image is below 20 MB in size "
                      "and is of one the following formats: ['png', 'jpeg', 'gif', 'webp'].", False,
                 id="openai-image-format"),
    # 协议会话（Gemini 角色顺序，未逐字核对）
    pytest.param(400, "Please ensure that function call turn comes immediately after a user turn or after a "
                      "function response turn.", False, id="gemini-turn-order"),
    # 协议会话（Anthropic 结果找不到调用，未逐字核对）
    pytest.param(400, "messages.1.content.0: unexpected `tool_use_id` found in `tool_result` blocks: toolu_01A. "
                      "Each `tool_result` block must have a corresponding `tool_use` block in the previous "
                      "message.", True, id="anthropic-orphan-result"),
    # 协议会话（Anthropic Opus / Sonnet 5.5 拒绝强制工具；状态码有官方依据，原文是推测）
    pytest.param(400, "tool_choice.type: 'any' is not supported for this model", True,
                 id="anthropic-tool-choice-any-guess"),
    # 协议会话（OpenAI Chat 别家的长 id，有原文出处）
    pytest.param(400, "Invalid 'messages[3].tool_calls[0].id': string too long. Expected a string with maximum "
                      "length 40, but got a string with length 81 instead.", False, id="openai-id-too-long"),
    # 协议会话（OpenAI Chat 调用缺结果，未逐字核对）
    pytest.param(400, "An assistant message with 'tool_calls' must be followed by tool messages responding to "
                      "each 'tool_call_id'. The following tool_call_ids did not have response messages: call_A",
                 False, id="openai-missing-tool-messages"),
    # 常见报错（未逐字核对，无链接）：Gemini 处理不了这张图
    pytest.param(400, "Unable to process input image. Please retry or report in "
                      "https://developers.generativeai.google/guide/troubleshooting", False, id="gemini-image"),
]


@pytest.mark.parametrize(("status", "message", "anthropic"), SHOWN_AS_IS)
def test_tool_and_image_errors_that_are_not_about_the_model_are_shown_as_is(status, message, anthropic):
    text = runtime.friendly_error(_error(status, message, anthropic=anthropic))
    assert text == f"对话模型返回错误 {status}：{runtime.redact(message)[:300]}"
    assert TOOL_HINT not in text and IMAGE_HINT not in text


def test_original_text_still_goes_through_redact():
    path = "/Users/someone/game-atelier/.config/keys.json"
    text = runtime.friendly_error(_error(400, f"model does not support tools (config {path})"))
    assert text.startswith(f"{TOOL_HINT}（原始报错：400 ") and path not in text
    shown = runtime.friendly_error(_error(400, f"bad request, see {path}"))
    assert shown.startswith("对话模型返回错误 400：") and path not in shown
