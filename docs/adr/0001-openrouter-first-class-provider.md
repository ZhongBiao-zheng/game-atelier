# OpenRouter 作为一等 provider,不塞进 custom

OpenRouter 的图片 API 是专用 `POST /v1/images`（参数 aspect_ratio/resolution/input_references,非 OpenAI 的 `/images/generations`）,视频是异步 job（提交→轮询→下载）,与现有 custom→openai_image 同步通道和 seedance/kling/dashscope 三个视频协议都不兼容。故新增 `provider: "openrouter"` + 专用 caller（`openrouter_image.py` / `openrouter_video.py`）+ 视频协议 `"openrouter"`,而不是在 openai_image 里按 base_url 嗅探分流——协议差异是真实的领域边界,host-sniffing 只省前端枚举一处改动,省不掉核心工作量（2026-08-06,grilling 会话 D2 决策）。

顺带的领域约定:OpenRouter 模型 id 是 `vendor/model` 斜杠 slug（如 `openai/gpt-image-2`）,现有各厂商 id 均无斜杠——前端 `imageControlCaps` 以「id 含 `/`」识别 openrouter 族,按尾段判 gpt-image 等子族。
