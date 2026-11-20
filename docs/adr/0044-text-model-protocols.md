---
status: accepted
---

# 对话模型按协议调用：内部统一 Chat Completions 形状，在 HTTP 边界转换

2026-11-20 定。起因是飙哥要求「添加供应商里应该兼容都是齐全的：OpenAI 兼容、OpenAI Responses、Anthropic 兼容、
Gemini 兼容、One API / New API 等等，还要有检测协议」。方案与调研在共享笔记 `provider-protocols-PLAN.md`
（不入库）；本 ADR 记录长期规则，第 1 批（Anthropic Messages 用于一次性文本调用）同时落地。

## 决策

- **协议挂在模型上**：对话模型的调用协议存 `ModelSpec.protocol`。取值 `openai-chat`（含旧值 `None` / `openai` /
  `chat-completions`）、`openai-responses`、`anthropic-messages`；Gemini 首选 Google 官方的 OpenAI 兼容入口
  （即 `openai-chat` + `…/v1beta/openai`），同时做原生 generateContent 适配（飙哥 2026-11-20 定，排在 Agent 流式之后）。协议表只有一份：
  `lib/llm_protocols`；能不能调用只有一个判据：`openai_text.text_callable`。前端不抄协议表，读服务端给的
  `text_unsupported`（只在不能调用时出现，`/api/keys` 的模型与 `/api/models` 的路由成员都带）。
- **内部统一用 OpenAI Chat Completions 的请求 / 响应形状**，发请求前、收响应后按协议转换（`llm_protocols.anthropic`
  的 `to_upstream` / `from_upstream`）。同一份转换给三处用：一次性文本调用（画布文本节点、AI 帮我配置、分镜解析、
  分类）、内置 Agent（第 2 批：给 `AsyncOpenAI` 换一个做转换的 transport，SDK 不变）、局域网网关主机端（第 4 批）。
  不引入 LiteLLM 等转换库：依赖大，2026 年其 PyPI 包两次被投毒，且网关与一次性调用仍要自己的转换。
- **用量归一**：`llm_protocols.usage.Usage` 的输入总量含缓存命中与缓存写入（Anthropic 的 `input_tokens` 不含缓存，
  要加上 `cache_read_input_tokens` 与 `cache_creation_input_tokens`；Gemini 的 `promptTokenCount` 已含缓存、输出要加
  `thoughtsTokenCount`）。转回 Chat 形状时缓存写入放在 `prompt_tokens_details.cache_write_tokens`（与 OpenAI
  Responses 的字段同名）。价格表还没有缓存写入价，按输入价算——**已知偏差，方向偏低**（Anthropic 缓存写入价高于输入价）。
- **不自动换协议重试**：协议选错时报错，不换一种协议再发一次（再发一次可能重复计费）。报错按典型报文
  （`Invalid URL (POST …)`、`404 page not found`、`convert_request_failed`、`not implemented`、
  `only supported in v1/responses`）给出「到供应商里改『对话接口』」的提示（`llm_protocols.mismatch_hint`）。
- **供应商级「对话接口」**：`KeySpec.text_protocol`（可选；`None` = 自动），只有 `provider = "custom"` 能选，取值只在
  `POST/PATCH /api/keys` 写入边界校验，读盘不校验。选了具体接口时，这把 KEY 的文本模型在写入时都改成这个协议；
  改回自动不动各模型已存的协议。只存用户手动选的值，自动识别的结果只写进各模型的 `protocol`。
- **不新增 `Provider` 取值**：`Provider` 是 Literal，旧版读到新值会让整个 `keys.json` 读不出来（违反 ADR-0030）。
  新厂商一律 `provider = "custom"` + 按域名识别的预置（如 `api.anthropic.com` → Anthropic）。新字段只加不改，
  `KeySpec` / `ModelSpec` 不设 `extra = "forbid"`，旧版读到 `text_protocol` 会忽略；旧版写回一次配置会丢掉它，
  回到自动，不影响已存的模型协议。
- **鉴权与地址**：Anthropic 发 `x-api-key` + `anthropic-version: 2023-06-01`（OpenRouter 用 Bearer），路径
  `{根}/v1/messages`，根地址归一见 `anthropic.api_root`；`max_tokens` 必填，调用方没给时用 8192。`temperature` 范围是 0–1（OpenAI 是 0–2），超出的按 1 发（画布「发散」档 1.3）。按 Anthropic 列模型
  时带 `limit=1000`，带着密钥的请求不跟随重定向。
- **转换接上之前的临时边界**：局域网网关与内置 Agent 只按 OpenAI 格式收发。在它们接上转换之前，`anthropic-messages`
  成员不进网关的路由列表、成员快照与选成员（`gateway_access.member_relayable`，四处共用），不进 Agent 的模型列表，
  直接构造 Agent 时报「该模型的接口暂不支持 Agent」（`canvas_agent_models.agent_can_use`）。**Agent 的边界在第 2 批、
  网关的边界在第 4 批完成后移除**，对应用例改成断言转换后的行为，不删。成员端始终用 OpenAI 格式打网关，主机按成员
  上游协议转换。
- **协议检测只发不计费的 GET**（第 3 批）：先看地址，再看 `GET /models` 的返回形状，必要时对用户填的同一个 origin
  换鉴权头再 GET；不发任何 POST（「校验类 400 不计费」没有官方依据），不跟随重定向。检测不出时按 OpenAI Chat，
  保留手动选择。One API / New API 不做单独的供应商类型：由「自定义供应商」入口识别，按 `/v1/models` 的
  `supported_endpoint_types` 给每个模型定协议。

## 与自定义接口（ADR-0036）的分工

对话类协议（本 ADR）由代码实现几种标准协议；图片、视频、音频的任意 HTTP 接口仍由自定义接口模板描述。两者都落在
`ModelSpec.protocol`，自定义接口不处理文本，文本模型不能绑定自定义接口。

## 不做

Azure OpenAI、Vertex AI、AWS Bedrock、Gemini Interactions API、TypeSafe System One 决策 API、Responses 内置工具；
出错后自动换协议重试；对任意 New API 站点自动同步价格（各站换算口径不同）。
