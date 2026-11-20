---
status: accepted
---

# 对话模型按协议调用：内部统一 Chat Completions 形状，在 HTTP 边界转换

2026-11-20 定。起因是飙哥要求「添加供应商里应该兼容都是齐全的：OpenAI 兼容、OpenAI Responses、Anthropic 兼容、
Gemini 兼容、One API / New API 等等，还要有检测协议」。方案与调研在共享笔记 `provider-protocols-PLAN.md`
（不入库）；本 ADR 记录长期规则，第 1 批（Anthropic Messages 用于一次性文本调用）同时落地。

## 决策

- **协议挂在模型上**：对话模型的调用协议存 `ModelSpec.protocol`。取值 `openai-chat`（含旧值 `None` / `openai` /
  `chat-completions`）、`openai-responses`、`anthropic-messages`、`gemini-generate-content`（第 5 批，原生
  generateContent）；Gemini 也可以走 Google 官方的 OpenAI 兼容入口（`openai-chat` + `…/v1beta/openai`）。协议表只有一份：
  `lib/llm_protocols`；能不能调用只有一个判据：`openai_text.text_callable`。前端不抄协议表，读服务端给的
  `text_unsupported`（只在不能调用时出现，`/api/keys` 的模型与 `/api/models` 的路由成员都带）。
- **内部统一用 OpenAI Chat Completions 的请求 / 响应形状**，发请求前、收响应后按协议转换（`llm_protocols.anthropic`
  的 `to_upstream` / `from_upstream`）。同一份转换给三处用：一次性文本调用（画布文本节点、AI 帮我配置、分镜解析、
  分类）、内置 Agent（第 2 批：给 `AsyncOpenAI` 换一个做转换的 transport，SDK 不变）、局域网网关主机端（第 4 批）。
  不引入 LiteLLM 等转换库：依赖大，2026 年其 PyPI 包两次被投毒，且网关与一次性调用仍要自己的转换。
- **Agent 的转换在 HTTP 层**（第 2 批）：`llm_protocols.transport.ProtocolTransport` 装进 `AsyncOpenAI` 的
  `DefaultAsyncHttpxClient`，拦下 `POST …/chat/completions` 改写成上游协议，响应与流式转回 Chat 形状；必须用 openai
  3.x 自带的 `httpx2`。与局域网网关的 `UpdatingAwareTransport` 叠加时转换在外层、等待重发在内层（重发的是转换后的
  同一个请求）。流式里 Anthropic `message_delta` 的用量是累计值，取最后一次；`error` 事件转成 `{"error": …}` 数据块，
  流没收到 `message_stop` 就断了按错误处理。装了这个 transport 的客户端必须 `trust_env=False`：否则 httpx 按环境代理
  把请求直接交给代理的 transport，绕过转换；代理改由内层按上游地址选（`transport.environment_proxy_for`，直接用 httpx2
  的 `get_environment_proxies` 与挂载点匹配规则，与 SDK 默认客户端一致：http / https / all 与 `NO_PROXY`；socks
  代理需要 `socksio`，本项目没装，两条路径都在构造客户端时报 ImportError）。Anthropic 没有默认地址，KEY 没填
  `base_url` 时构造 Agent 就报「供应商缺少 API 地址」（与一次性调用一致）。SDK 重试沿用 OpenAI 路径（2 次）：
  上游错误响应的 `x-should-retry` / `retry-after` 原样透传；上游 200 但响应读不出时返回 502 并带
  `x-should-retry: false`，不让 SDK 重发已计费的请求。`openai-responses` 模型用 SDK 的 `OpenAIResponsesModel`，不经转换。
  Anthropic 首版不开思考（飙哥定），Agent 列表里这类模型不显示思考档位；Agent 列模型时按 Anthropic 的鉴权头拉。
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
  时带 `limit=1000`，带着密钥的请求不跟随重定向。一次性调用里用自定义鉴权头（`x-api-key`、`x-goog-api-key`）的请求
  同样不跟随重定向，3xx 当错误报：requests 跨主机只去掉 `Authorization`，这两个头会原样带到第二跳。
- **Gemini generateContent**（第 5 批）：`llm_protocols.gemini`，一次性调用与 Agent（同一个 `ProtocolTransport`，
  按协议选转换）共用。路径 `{根}/v1beta/models/{id}:generateContent`、流式 `:streamGenerateContent?alt=sse`，根地址
  去掉末尾的 `/v1beta/openai`、`/v1beta`、`/v1` 再补 `/v1beta`；鉴权只发 `x-goog-api-key`，不用 `?key=`。工具定义用
  `parametersJsonSchema`（JSON Schema 原样）；图片只收 base64；首版不开思考控制。用量：输入含缓存与
  `toolUsePromptTokenCount`，输出含 `thoughtsTokenCount`。
  - **thought signature 不进 tool_call id**：换模型后历史里的 id 会原样发给别家，OpenAI Chat 的 id 上限 40、Anthropic
    只收 `[A-Za-z0-9_-]` 且 ≤ 64（服务端报错原文，官方文档无明文），签名放不下。id 一律是短 id
    `g{签名状态 s/n/x}{来源 u/r}_{尾巴}`（≤ 40）：Gemini 给了 `functionCall.id` 且合规时尾巴用它并原样带回
    `functionResponse.id`。签名走 openai-agents 0.23 自带的通道：tool_call 的 `extra_content.google.thought_signature`
    → 会话条目的 `provider_data.thought_signature`，模型名含 "gemini" 时 SDK 原样放回；对它的依赖只在
    `gemini.signature_of` / `with_signature` 两个函数里，升级 openai-agents 先跑 `test_llm_protocols_gemini_agent.py`。
  - **缺签名**：只校验「当前轮」（最后一条 user 消息之后）的每一步第一个 functionCall。只在三种情况填官方占位值
    `skip_thought_signature_validator`：模型名不含 gemini（SDK 不回放）、不是 Gemini 产生的调用（等确认时换成了
    Gemini）、签名超过 256 KB 没进会话（只记长度的日志）。其余缺签名报错，不静默填占位值。更早的轮次不填也不报错。
    注意「当前轮」从最后一条 user 消息算起，而看图时 Agent 在工具结果后插入的图片消息（`canvas_agent_vision.
    with_attached_images`）也是 user 消息：它之前的调用都算更早的轮次，即使模型名不含 gemini 也既不带签名、也不填
    占位值（与官方「最近一条带普通内容的 user 消息开始当前轮」的规则一致；Gemini 3 是否接受以计费实测为准）。
  - **签名不出本机**：会话接口的响应（`canvas_agent_sessions.public_session`）与项目导出包去掉签名，落盘的会话文件保留。
    导出包同时把 id 的签名状态 s 改成 x（`gemini.mark_signatures_dropped`）：在等确认时导出、导入后批准续跑，按
    「签名没保留」填占位值，不因「签名丢失」让已执行的工具白跑。
  - **转换的硬规则**：同一步的工具结果按调用顺序发（等确认的那个结果最后才到，同名又没有 id 时 Gemini 按顺序配对），
    缺任何一个结果就报错，不发出去等上游 400；结束原因不是 STOP、又没有文本和调用（如 `MALFORMED_FUNCTION_CALL`、
    `SAFETY`、思考用完 `MAX_TOKENS`）时报错并带上 `finishMessage`，不当成空回答；HTTP 200 但内容是
    `{"error": …}`（中转站余额不足常这样回）时把上游原文报出来；流式最后一行没有换行结尾也照常处理。
- **转换接上之前的临时边界**：局域网网关只按 OpenAI 格式收发。在它接上转换之前，`anthropic-messages`、
  `gemini-generate-content` 成员不进网关的路由列表、成员快照与选成员（`gateway_access.member_relayable`，四处共用）。**网关的边界在第 4 批
  完成后移除**，对应用例改成断言转换后的行为，不删。成员端始终用 OpenAI 格式打网关，主机按成员上游协议转换；
  Gemini 成员的 `extra_content`（签名）要原样穿过主机。
  Agent 的边界已在第 2 批移除：`canvas_agent_models.agent_can_use` 改为「协议在 `TEXT_PROTOCOLS` 里」，原样存下的
  未知标注（如 `anthropic:messages`）仍报「该模型的接口暂不支持 Agent」。
- **协议检测只发不计费的 GET**（第 3 批）：先看地址，再看 `GET /models` 的返回形状，必要时对用户填的同一个 origin
  换鉴权头再 GET；不发任何 POST（「校验类 400 不计费」没有官方依据），不跟随重定向。检测不出时按 OpenAI Chat，
  保留手动选择。One API / New API 不做单独的供应商类型：由「自定义供应商」入口识别，按 `/v1/models` 的
  `supported_endpoint_types` 给每个模型定协议。
  - 实现（第 3 批）：纯函数在 `llm_protocols.detect`。发请求的是 `models-preview`，只在自定义供应商、「对话接口」为自动时执行：
    1. 先看地址：端点后缀、`/anthropic`、`/v1beta/openai`，以及官方域名 api.anthropic.com、
       generativelanguage.googleapis.com、api.openai.com、openrouter.ai。
    2. 再用 Bearer 拉 `/models` 看形状。
    3. Bearer 失败、地址又定不下时，对同一个 origin 依次换 `x-api-key` 与 `x-goog-api-key` 各 GET 一次（不跟随重定向，3xx 算失败）。
    4. 认出 New API 时，另 GET 公开的 `/api/status`（不带密钥）取站点名与版本，只用于显示。
    - 识别结果只写进各模型的 `protocol` 与预览响应的 `detected`，不存进 KEY（重开表单按模型协议显示）。
  - `supported_endpoint_types` 大小写不敏感、只认已知值（`openai` / `openai-chat`、`openai-response`、`anthropic`、
    `gemini` / `gemini generateContent`）。一个模型声明多种时按 Chat > Anthropic > Responses > Gemini 取：
    同时有 OpenAI 与 Gemini 格式的取 Chat。
  - **只有 gemini 端点的模型，经中转站走原生格式时工具调用未经验证**：2026-11-20 实测，Tuzi 的 Gemini 格式入口
    在内部转成 OpenAI Chat（响应里 `billing_usage.source = "oai_chat"`），两次都没有函数调用、没有签名。
    - 这类模型**不进 Agent**（2026-11-20 管理会话定）：自动识别成 `gemini-generate-content`、地址又不是 Google 官方时，Agent 模型列表不列。
    - 已有会话正选着它、或直接构造 Agent 时，`build_agent` 报明确原因，并说明去哪里改：把「对话接口」改成 OpenAI Chat，或确认该中转站支持工具调用后手动选 Gemini。
    - 手动选了 Gemini（`KeySpec.text_protocol`）或官方地址照常可用；一次性文本调用不受影响。
    - 判据只在 `detect.agent_tools_unverified` 一处：Agent 列表、`build_agent`、`/api/keys` 模型上的 `agent_unverified` 标记（表单据此在模型行显示「不进 Agent」）都读它。
    - 官方域名与地址识别用同一个 `detect.GOOGLE_HOST`。

## 与自定义接口（ADR-0036）的分工

对话类协议（本 ADR）由代码实现几种标准协议；图片、视频、音频的任意 HTTP 接口仍由自定义接口模板描述。两者都落在
`ModelSpec.protocol`，自定义接口不处理文本，文本模型不能绑定自定义接口。

## 不做

Azure OpenAI、Vertex AI、AWS Bedrock、Gemini Interactions API、TypeSafe System One 决策 API、Responses 内置工具；
出错后自动换协议重试；对任意 New API 站点自动同步价格（各站换算口径不同）。
