# API Key / 厂商配置参考

> 配置 key、设计出图/出视频参数、排错时只看这份。汇总自官方文档与实测，2026-06-11。
> Skill 按任务挑模型、按模型族写提示词 → [model-routing.md](model-routing.md)。

## 配置在哪

- 唯一存储 `<data_root>/.config/keys.json`（默认 `~/game-atelier/.config/keys.json`），Web 与 Skill 经 `lib/keys.py` 读同一份，`.config/` 始终 gitignore。
- 字段：`alias`（唯一标识）/ `provider`（路由依据）/ `base_url` / `access_key` / `capabilities`（portrait/promo/turnaround）/ `models[]`（`{name, id, modality}`，modality 决定 Studio 图/视频模式可见性）。
- 配置入口：设置页 →「+ 新建供应商」；拉模型列表 `POST /api/keys/models-preview`。
- 手改 JSON 后必验：`curl -sS http://127.0.0.1:5174/api/keys >/dev/null`，任何 schema 错都会 500。

## 当前已接厂商

| alias | provider | base_url | 已挂模型 | 状态 |
|---|---|---|---|---|
| `seedream` | seedream | `https://ark.cn-beijing.volces.com/api/v3` | doubao-seedream-5-0 / 4-5 | 图生图实测通 |
| `OpenAI-HK` | custom | `https://api.openai-hk.com` | gpt-image-2、nano-banana / -2 / -hd | 实测通；kling caller 已写、模型未挂 key |
| `tokendance` | tokendance | `https://tokendance.space/gateway/v1` | seedream-5.0-lite（图）、seedance-2.0 系 + happyhorse 系（视频） | key 未充值待实测 |

密钥获取：火山 `console.volcengine.com/ark`、词元跳动 `tokendance.space/keys`、HK `open-hk.com` 控制台。

## 生成模式总览

图像各族统一两种模式：文生图、图生图（带参考图），差异只在参数（见图像三族表）。视频按模型族：

| 模型族 | 文生 | 图生首帧 | 首尾帧 | 全能参考 | 视频编辑/延长 | 音频 |
|---|---|---|---|---|---|---|
| Seedance 2.0 / 2.0-fast | ✓ | ✓ | ✓ | ✓ 图1-9 + 视频0-3 + 音频0-3 | ✓（参考素材+提示词表达，无独立端点） | ✓ 音画同生 |
| Seedance 1.5 pro | ✓ | ✓ | ✓ | — | — | ✓ |
| Seedance 1.0 pro | ✓ | ✓ | ✓ | — | — | — |
| HappyHorse 1.0 | ✓ t2v | ✓ i2v（仅首帧，无尾帧） | — | ✓ r2v 图1-9 | ✓ video-edit 视频1 + 图0-5 | 仅 edit 可保留原声 |
| kling（HK 聚合） | ✓ | ✓ | ✓ | o1 omni | — | 仅 v2-6 |

## 图像契约

### 火山 Ark 直连（provider=seedream）

- `POST {base}/images/generations`，Bearer `ark-…` key，同步返回。
- 发送：`size`（WxH 像素）、`watermark: true`、n>1 时 `sequential_image_generation: auto`；**不发 quality**（发了可能被拒）。
- 图生图 `image` 字段：URL 或 base64 data-url，单张 str、多张 list，上限 10。

### OpenAI-HK 聚合（provider=custom，base 含 `openai-hk.com`）

- `keys.is_openai_hk()` 强制走同步通道——对 gpt-image 发 `?async=true` 会 404。
- 无参考图 `POST /v1/images/generations`；有参考图 `POST /v1/images/edits`（multipart，重复 `image` 文件部件）。单次恒回 1 张，n>1 靠 backfill 补发。
- gpt-image：`size` = 像素 WxH（双边 16 倍数、最大边 3840、宽高比 ≤3:1）；`quality` low/medium/high/auto。
- nano-banana：`size` = 比例字符串原样发（`"16:9"`）；`quality` low/medium/high。

### 词元跳动图片（provider=tokendance）

- OpenAI 兼容入口 `/gateway/v1`，走 `openai_image` 同步通道（standard 族控件）。
- `GET /gateway/v1/models` 免鉴权，返回 `data[]` 含 `supported_protocols[]`（models-preview 模态判定依据）。
- 对 Ark 系协议参数透传。

### 图像三族参数表

按**模型族（id 前缀）**判断，不按 provider——HK 一个 key 下挂多族。前端 `imageControlCaps.ts`，后端 `openai_image.py`。

| 族 | id 前缀 | size 语义 | 比例 | 质量 | 分辨率切换 | 参考图上限 |
|---|---|---|---|---|---|---|
| nano-banana | `nano-banana` | 比例字符串 | 1:1 4:3 3:4 16:9 9:16 2:3 3:2 | low/medium/high | 无 | 3（官方建议 ≤2） |
| gpt-image | `gpt-image` | 像素 WxH | 八档含 21:9 | 四档含 auto | 无 | 16 |
| standard（seedream 等） | 其余 | 像素 WxH | 八档含 21:9 | 无 | 2K/4K | seedream 10，未知 4 |

### OpenAI-HK 价目（积分，10000 积分 = 1 元）

| 模型 | low | medium | high |
|---|---|---|---|
| gpt-image-2 | 600 | 1200 | 2400 |
| nano-banana | 2000 | — | — |
| nano-banana-2 | 4800 | 9600 | — |
| nano-banana-hd | 3200 | — | — |

没测过价的档位不入 `creditCost.ts::HK_CREDIT_TABLE` → 前端不显示消耗提示。

## 视频契约 — Seedance（火山 Ark / TokenDance 转发）

契约源 `volcengine.com/docs/82379/1520757`。TokenDance 同构转发，仅换任务 URL。

| 操作 | Ark 直连 | TokenDance 转发 |
|---|---|---|
| 提交 | `POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks` | `POST https://tokendance.space/gateway/ark/v3/generations/tasks` |
| 轮询 | 同路径 `GET …/tasks/{id}` | 同路径 `GET …/tasks/{id}` |

- 鉴权 `Authorization: Bearer <key>`。异步：任务 ID 存 7 天、video_url 有效 24h，出片后立即落盘。
- 状态枚举：`queued / running / succeeded / failed / cancelled / expired`；可选 `callback_url` 推送同构体。
- TokenDance 模型 id：`seedance-2.0`、`seedance-2.0-fast`（另有 `:save` 后缀变体，含义全站无说明）。
- 请求体 = `model` + `content[]` + 顶层控制参数。顶层传参强校验（推荐）；旧式 prompt 尾拼 `--rs 720p --rt 16:9 --dur 5 --seed 11 --cf false --wm true` 弱校验。
- 开通 Ark 2.0 系列需账户余额 ≥200 元；2.0 禁真人人脸参考图/视频。

### content[] 元素与 role

| type | 载体 | role | 限制 |
|---|---|---|---|
| `text` | `text` | — | 中文建议 ≤500 字 / 英文 ≤1000 词 |
| `image_url` | `image_url.url`（URL / base64 data-url） | `first_frame`（单图可省）/ `last_frame` / `reference_image` | 首帧、首尾帧、参考三场景互斥；首尾帧比例不一致以首帧为主 |
| `video_url` | `video_url.url`（仅 URL，不支持 base64） | `reference_video` | 仅 2.0 系列 |
| `audio_url` | `audio_url.url`（URL / base64） | `reference_audio` | 仅 2.0 系列；不可单独输入，须配图或视频 |

### 生成参数（顶层字段）

| 参数 | 取值 | 默认 | 备注 |
|---|---|---|---|
| `resolution` | `480p` / `720p` / `1080p` | 2.0/1.5pro `720p`；1.0pro `1080p` | 2.0-fast 无 1080p |
| `ratio` | `16:9` `4:3` `1:1` `3:4` `9:16` `21:9` `adaptive` | 2.0/1.5pro `adaptive`；其余文生 `16:9`、图生 `adaptive` | adaptive 全场景仅 2.0/1.5pro |
| `duration` | 整数秒：2.0 [4,15]；1.5pro [4,12]；1.0pro [2,12]；`-1`=智能选时长（仅 2.0/1.5pro） | 5 | 与 frames 二选一，frames 优先 |
| `frames` | [29,289] 且满足 25+4n | — | 小数秒专用；2.0/1.5pro 不支持 |
| `seed` | [-1, 2^32-1] | -1 随机 | 同 seed 近似、不保证一致 |
| `generate_audio` | bool | **true** | 仅 2.0 系列、1.5pro；单声道；对话放双引号内 |
| `camera_fixed` | bool | false | 2.0 系列与参考图场景不支持 |
| `watermark` | bool | false | |
| `callback_url` | URL | — | succeeded/failed 发送失败重试 3 次 |
| `return_last_frame` | bool | false | 查询时回无水印尾帧 png |
| `service_tier` | `default` / `flex`（离线半价） | default | 2.0 仅在线 |
| `priority` / `tools` | 0-9 / `[{"type":"web_search"}]` | 0 / — | 仅 2.0 系列 |

帧率固定 24fps，无 fps 参数。

### 比例 → 输出像素（官方映射）

| 分辨率 | 比例 | Seedance 1.0 系 | 1.5 pro / 2.0 系 |
|---|---|---|---|
| 480p | 16:9 | 864×480 | 864×496 |
| | 4:3 | 736×544 | 752×560 |
| | 1:1 | 640×640 | 640×640 |
| | 3:4 | 544×736 | 560×752 |
| | 9:16 | 480×864 | 496×864 |
| | 21:9 | 960×416 | 992×432 |
| 720p | 16:9 | 1248×704 | 1280×720 |
| | 4:3 | 1120×832 | 1112×834 |
| | 1:1 | 960×960 | 960×960 |
| | 3:4 | 832×1120 | 834×1112 |
| | 9:16 | 704×1248 | 720×1280 |
| | 21:9 | 1504×640 | 1470×630 |
| 1080p | 16:9 | 1920×1088 | 1920×1080 |
| | 4:3 | 1664×1248 | 1664×1248 |
| | 1:1 | 1440×1440 | 1440×1440 |
| | 3:4 | 1248×1664 | 1248×1664 |
| | 9:16 | 1088×1920 | 1080×1920 |
| | 21:9 | 2176×928 | 2206×946 |

图生视频时所选比例与图片不一致 → 居中裁剪。

### 输入素材限制

| 素材 | 格式 | 尺寸/比例 | 数量 | 大小 |
|---|---|---|---|---|
| 图片 | jpeg/png/webp/bmp/tiff/gif（2.0/1.5pro 加 heic/heif） | 宽高比 (0.4, 2.5)，边长 (300, 6000)px | 首帧 1 / 首尾帧 2 / 参考 1-9 | 单张 <30MB，请求体 ≤64MB |
| 视频（仅 2.0） | mp4/mov，H.264/H.265，音轨 AAC/MP3 | 比例同上，总像素 [409600, 2086876]，fps [24,60] | ≤3 个，单个 2-15s、总 ≤15s | 单个 ≤50MB |
| 音频（仅 2.0） | wav/mp3 | — | ≤3 段，单段 2-15s、总 ≤15s | 单个 ≤15MB |

### 计价（Ark 在线推理，元/百万输出 token）

| 模型 | 单价 | 720p·16:9·5s 估算 |
|---|---|---|
| seedance-2.0 | 输入不含视频 46 / 含视频 28（1080p：51/31） | ≈4.97 元 |
| seedance-2.0-fast | 不含视频 37 / 含视频 22 | ≈4.00 元 |
| seedance-1.5-pro | 有声 16 / 无声 8（离线半价） | 有声 1.73 / 无声 0.86 元 |
| seedance-1.0-pro | 15（离线 7.5） | — |

token 估算 `(输入视频秒+输出秒)×宽×高×24/1024`，准确以 `usage.completion_tokens`；仅成功计费。限流：2.0 个人版 RPM 180 / 并发 3。TokenDance 按输出 token 计费，单价挂登录后台（匿名 401）。

## 视频契约 — HappyHorse（阿里百炼 / TokenDance 转发）

契约源 `help.aliyun.com/zh/model-studio/happyhorse-api-reference`。**当前 dispatch_video 未接通，调用报 WrongProviderError**。

| 操作 | 百炼直连 | TokenDance 转发 |
|---|---|---|
| 提交 | `POST https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis` | `POST https://tokendance.space/gateway/alibaba/happyhorse/v1/video-synthesis` |
| 轮询 | `GET https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}` | `GET https://tokendance.space/gateway/alibaba/happyhorse/v1/tasks/{task_id}` |

- Header 必带 `X-DashScope-Async: enable`（缺了直接报错）+ `Authorization: Bearer <key>`。
- 请求体 = `model` + `input{prompt, media[]}` + `parameters{}`。
- 状态：`PENDING / RUNNING / SUCCEEDED / FAILED / CANCELED / UNKNOWN`；task_id 与 video_url 均 24h 过期；查询 RPS 20，建议 15s 间隔轮询。

### 四模式参数矩阵

| 参数 | t2v 文生 | i2v 图生首帧 | r2v 全能参考 | video-edit 编辑 |
|---|---|---|---|---|
| `model` | `happyhorse-1.0-t2v` | `happyhorse-1.0-i2v` | `happyhorse-1.0-r2v` | `happyhorse-1.0-video-edit` |
| `input.prompt` | 必填 | 可选 | 必填，用 `[Image 1]` 按序指代参考图 | 必填，描述编辑意图 |
| `input.media[]`（type） | — | `first_frame` ×1 | `reference_image` ×1-9 | `video` ×1 + `reference_image` ×0-5 |
| `parameters.resolution` | `720P` / `1080P`，默认 `1080P`（大写 P） | 同左，输出比例随首帧自动缩放 | 同左 | 同左 |
| `parameters.ratio` | 九档：16:9 9:16 1:1 4:3 3:4 4:5 5:4 9:21 21:9，默认 16:9 | 无（随首帧） | 同 t2v 九档 | 无（随输入视频） |
| `parameters.duration` | [3,15] 整数秒，默认 5 | 同左 | 同左 | 无；输出随输入，>15s 截前 15s |
| `parameters.watermark` | 默认 **true**，右下角 "Happy Horse" 文案 | 同 | 同 | 同 |
| `parameters.seed` | [0, 2147483647] | 同 | 同 | 同 |
| `parameters.audio_setting` | — | — | — | `auto` / `origin`（保留原声） |

prompt 上限 5000 非中文字符 / 2500 中文字符，超出自动截断。无 negative_prompt / prompt_extend / fps 参数。

### 输入素材限制

| 素材 | 格式 | 尺寸/比例 | 大小 | 备注 |
|---|---|---|---|---|
| 首帧图（i2v） | JPEG/JPG/PNG/WEBP | 宽高 ≥300px，比例 1:2.5~2.5:1 | ≤20MB | URL 或 base64 |
| 参考图（r2v） | 同上 | 短边 ≥400px，推荐 720P 以上 | ≤20MB | URL 或 base64 |
| 参考图（edit） | 同上 | 宽高 ≥300px，比例同上 | ≤20MB | |
| 输入视频（edit） | MP4/MOV，建议 H.264 | 长边 ≤4096px、短边 ≥360px，比例同上，fps >8 | ≤100MB | **仅公网 URL**；时长 3-60s |

### 计价

四模型同价：720P 0.9 元/秒、1080P 1.6 元/秒，仅输出计费（video-edit 例外：输入+输出秒数都计费）；失败不计费。TokenDance 按输出视频秒计费，单价挂登录后台。

### TokenDance 转发坑

TokenDance quickstart 的请求体与阿里官方**不一致**：它写 `input.img_url` / `input.ref_images_url` / `input.video_url` + `parameters.size: "1280*720"`；官方是 `input.media[]`（type/url）+ `parameters.resolution: "720P"`。网关实际接受哪套未实测——接入前先发最小请求验证。

## 视频契约 — kling（OpenAI-HK 聚合）

契约源 `openai-hk.com/docs/lab/kling.html`。挂站点根（非 /v1）。

- `POST /kling/v1/videos/{text2video|image2video|omni-video}`，提交拿 `data.task_id` 轮询。
- `mode` std/pro（v2-master 不发、v2-6 固定 pro）；`sound` 仅 v2-6；`duration` "5"/"10"；`aspect_ratio` 七档（o1 仅 16:9/9:16/1:1）。
- 帧映射：首帧 `image`、尾帧 `image_tail`。

## 路由现状

```
图片 dispatch：provider openai/seedream/tokendance/custom → openai_image.render
  base 含 openai-hk → 强制同步通道（gpt-image 发 ?async=true 会 404）
视频 dispatch_video：
  provider seedance                    → volcengine_video（Ark 直连）
  provider tokendance + id 含 seedance → volcengine_video（任务 URL 改写）
  id 前缀 kling + HK base              → kling_video
  其余（happyhorse / vidu）            → WrongProviderError
```

帧语义（前端→caller）：双帧 = firstlast、仅首 = first、仅尾 = last、全空 = 文生视频；多余图片作 `reference_image`。

## 官方能力 vs 当前实装差距

设计配置功能时按这张表补：

| 维度 | 官方 | 当前实装 |
|---|---|---|
| seedance duration | 2.0 支持 4-15 任意整数秒 + `-1` 智能 | 仅 5/10 两档（`videoControlCaps.ts`） |
| seedance ratio | 七档含 3:4、adaptive | 五档，缺 3:4 / adaptive |
| seedance 参考素材上限 | 图 1-9、视频 ≤3、音频 ≤3 | 未按官方上限校验 |
| seedance frames / callback_url / return_last_frame / service_tier / priority / tools | 有 | 未实装 |
| seedance 视频编辑 / 延长（2.0） | 参考素材 + 提示词表达 | 无入口 |
| happyhorse 四模式（t2v/i2v/r2v/video-edit） | 有 | dispatch_video 未接通 |
| kling | — | caller 已写，模型未挂 HK key |

改前端控件 → `videoControlCaps.ts` + 对应 caller + `dispatch_video` 路由分支；改图像参考图上限 → `referenceLimits.ts` ↔ `openai_image._max_reference_images` 两端同步；改完验证 `cd web && pnpm lint && pnpm test`、`.venv/bin/python -m pytest`、`make build` + 重启 server。

## 已知坑

- HK 上游 `GET /models` 404，模型只能手填；TokenDance / Ark 的 `/models` 可拉。
- HK `/images/edits` multipart 未真机实测。
- kling-video-o1 omni 端点 image 字段命名待验证。
- TokenDance key 待充值；模型单价全部挂登录后台（`/portal/api/models/{slug}` 匿名 401）。
- TokenDance happyhorse 请求体两套字段（见上），先实测再接。
- TokenDance `:save` 后缀变体（seedance-2.0:save 等）含义全站无说明。
- 产物 URL 全员短命：seedance video_url 24h（任务 ID 7 天）、happyhorse task_id/video_url 24h——出片后立即落盘。
- seedance 参考视频仅公网直链：base64 被上游显式拒（`reference_video must be provided as a web url`，2026-06-12 经 TokenDance 网关实测）；本地参考视频由 `oss_upload.py` 中转阿里云 OSS（私有桶 + presigned 24h GET，配置在 keys.json `oss` 字段，同日真实上传冒烟通过）；参考音频 base64 内联可用（同日实测任务进 running），单段 ≤15MB（`_video_payload_url` / `_audio_payload_url`）。
