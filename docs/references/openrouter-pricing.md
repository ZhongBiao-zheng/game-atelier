# OpenRouter 精选模型价格表

> 数据来源：`GET /api/v1/images/models/{id}/endpoints` 与 `GET /api/v1/videos/models` 官方实时接口，
> 抓取日期 **2026-08-06**。价格随厂商调整会变，测算成本前建议重抓核对。
> 计费货币均为 USD。响应的 `usage.cost` 字段回报每次调用的真实扣费——精确成本以它为准。

## 图片（POST /api/v1/images）

| 模型 | 计费方式 | 单价 | 一张典型成本 |
|---|---|---|---|
| `openai/gpt-image-2` | 按 token | 输出图 $30/M tok；输入文本 $5/M tok；输入图 $8/M tok | 官方示例：16:9 high ≈ **$0.13**；文档示例 cost=0.04（低档）。quality 越高输出 token 越多 |
| `bytedance-seed/seedream-4.5` | 按张 | **$0.04/张**（1K-4K 同价） | $0.04 |
| `google/gemini-3-pro-image` | 按 token | 输出图 $120/M tok；输入图 $2/M tok | 1K/2K ≈ **$0.13-0.15**；4K 档更高（google-ai-studio 通道才有 4K） |
| `black-forest-labs/flux.2-pro` | 按百万像素 | **$0.03/MP** | 1024² (1MP) ≈ $0.03；2048² (4MP) ≈ $0.12 |

## 视频（POST /api/v1/videos，异步 job）

| 模型 | 计费方式 | 单价 | 5 秒一条典型成本 |
|---|---|---|---|
| `google/veo-3.1` | 按秒 | 带音频 $0.40/s（4K $0.60/s）；无音频 $0.20/s（4K $0.40/s） | 带音频 **$2.00**；无音频 $1.00 |
| `openai/sora-2-pro` | 按秒 | 720p $0.30/s；1080p $0.50/s | 720p **$1.50**；1080p $2.50 |
| `bytedance/seedance-2.0` | 按 video token | $0.000007/tok（Ark 公式 tokens ≈ 宽×高×FPS×秒 ÷ 1024） | 720p 24fps ≈ 10.8 万 tok ≈ **$0.76** |
| `kwaivgi/kling-v3.0-std` | 按秒 | 无音频 $0.084/s；带音频 $0.126/s | 无音频 **$0.42**（仅 720p） |

## 额度备忘

- 当前 key 限额 **$5**，2026-11-04 过期（`GET /api/v1/key` 可随时查 usage/limit_remaining）。
- 试水期主要验证图片链路；视频一条 veo/sora 就吃掉额度一半，慎点。

## 契约速查（接入实现对应 `callers/openrouter_{image,video}.py`）

- 图片：`POST {base}/images`，参数 `aspect_ratio`（比例串）/`resolution`（1K/2K/4K）/`size`（显式 WxH，与前两者互斥）/`quality`（仅 gpt-image 族）/`n`/`input_references`（图生图参考，image_url 对象，收 http(s) 或 base64 data-url）。响应恒为 `data[].b64_json`。
- 视频：`POST {base}/videos` → 202 `{id, polling_url}` → `GET polling_url` 轮询 `status`（pending/in_progress/completed/failed）→ `unsigned_urls[0]`（= `{base}/videos/{id}/content`，仍需 Bearer）下载 mp4。参考图：`frame_images`（首尾帧，带 `frame_type`）优先于 `input_references`（风格参考）。
- 模型可用性：全量模型对任意有效 key 开放（无 Tuzi 式分组开通），限制只在余额。
- 网络：openrouter.ai 是海外站，**不进** `net_env.DIRECT_HOST_SUFFIXES` 直连白名单（与国产聚合商规则相反，走系统代理）。
