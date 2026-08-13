# API Key / 厂商配置参考

> 配置 key、设计出图/出视频参数、排错时只看这份。汇总自官方文档与实测，2026-06-11 起持续更新（最近一次 2026-08-13）。
> Skill 按任务挑模型、按模型族写提示词 → [model-routing.md](model-routing.md)。

## 配置在哪

- 唯一存储 `<data_root>/.config/keys.json`（默认 `~/game-atelier/.config/keys.json`），Web 与 Skill 经 `lib/keys.py` 读同一份，`.config/` 始终 gitignore。
- 字段：`alias`（唯一标识）/ `provider`（路由依据）/ `base_url` / `access_key` / `capabilities`（portrait/promo/turnaround）/ `models[]`（`{name, id, modality}`，modality 决定 Studio 图/视频模式可见性）。
- 配置入口：设置页 →「+ 新建供应商」；拉模型列表 `POST /api/keys/models-preview`。

### models-preview 契约（前后端唯一形状来源）

请求：`{ alias?, provider?, base_url?, access_key?, include_all? }`。
**安全边界**：传了 `alias` 而不带 `access_key` 时会取出存储的**明文密钥**，所以此时请求体里的
`base_url` 只允许与存储值同 host（换域名要自带密钥）——否则等于让调用方指定「把密钥发到哪」。

响应：`{ models: [{ id, name, modality, category, protocol }], total, excluded }`

| 字段 | 取值 | 含义 |
|---|---|---|
| `category` | `image` / `video` / `unknown` / `excluded` | 分类结果。`excluded` 只在 `include_all: true` 时出现在 `models` 里 |
| `modality` | `image` / `video` / `null` | 只有前两类给值；`unknown` 一律 `null`，由画师在 picker 里显式二选一（**不再静默兜底成 image**）|
| `protocol` | 见上方各厂契约 / `null` | 视频=seedance·kling·dashscope·openrouter；图片=ark·openai |
| `total` / `excluded` | 数字 | 上游去重后的总数 / 被判「明确非视觉」而未返回的条数，前端据此显示「上游 78 个 · 已过滤 61 个」+ 逃生舱 |

分类是四级瀑布（`routes.py::_classify_model`）：协议标注判视觉 → 协议**全部**是非视觉动词才判
`excluded` → 读 `architecture.output_modalities`（OpenRouter 的权威字段）→ id 关键词（**词边界**
匹配，裸子串会把 `inkling` 判成 kling 视频、`wanx` 判成视频）→ `unknown`。

**认不出一律 `unknown` 留着，绝不丢**：协议词汇是各厂自造的（实测同一份词元跳动数据里就有
`zai:layout-parsing` / `bocha:web-search` / `unifuncs:web-reader`），词表永远追不完，「认不出就
丢」会让某个网关的模型列表整片消失且用户看不出原因。实测:词元跳动 78 → 排除 61 / 图 2 / 视频 15
（17 个视觉模型逐条核对无误伤）；OpenRouter 409 → 排除 398 / 图 11。
- 手改 JSON 后必验：`curl -sS http://127.0.0.1:5174/api/keys >/dev/null`，任何 schema 错都会 500。

## 当前已接厂商

| alias | provider | base_url | 已挂模型 | 状态 |
|---|---|---|---|---|
| `seedream` | seedream | `https://ark.cn-beijing.volces.com/api/v3` | doubao-seedream-5-0 / 4-5 | 图生图实测通 |
| `OpenAI-HK` | custom | `https://api.openai-hk.com` | gpt-image-2、nano-banana / -2 / -hd | 实测通；kling caller 已写、模型未挂 key |
| `tokendance` | tokendance | `https://tokendance.space/gateway/v1` | seedream-5.0-lite / -pro（图）、seedance-2.0 系 + happyhorse 系（视频） | 2026-08-13 出图实测通（pro 走 Ark 端点，960² 约 88s）|
| `Tuzi` | custom | `https://api.tu-zi.com` | gpt-image-2、doubao-seedream-4-5、nano-banana-pro / -2 系 | **当前 default_alias** —— Skill 不指定 alias 时默认走这把。出图实测通；注意它对畸形请求**不快速失败**（实测缺 prompt / 不存在的模型 id 都挂满读超时不返回，服务本身是活的：`GET /v1/models` 2s 回 474 个模型）|
| `OpenRouter` | openrouter | `https://openrouter.ai/api/v1` | gpt-image-2、seedream-4.5、gemini-3-pro-image、flux.2-pro（图）+ veo / sora / seedance / kling（视频，手填）| 实测通。契约与国内聚合商不同族，见 [openrouter-pricing.md](openrouter-pricing.md)：专用 `/images`（回 b64_json）+ 异步 `/videos` job；`/models` 里**没有视频模型**，视频侧只能手填 |

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
- 无参考图 `POST /v1/images/generations`。有参考图**按族分流**：
  - `gpt-image` 族 → `POST /v1/images/edits`（multipart，重复 `image` 文件部件）
  - `nano-banana` 族 → 仍走 `generations`，参考图放 `image` 字段。它是 Gemini 多模态，聚合商对其 `/images/edits` 一律 **403**（openresty 网关层拒未实现路由），别按 gpt-image 那条路设计。
- 单次恒回 1 张，n>1 靠补足循环逐张补发。
- gpt-image：`quality` low/medium/high/auto。`size` 官方约束是「双边 16 倍数、最大边 3840、宽高比 ≤3:1」，但 **HK 只认一张 30 项的固定尺寸表**，表外值会被出成正方形 —— caller 会把任意 WxH **吸附**到表内最近值（先比例最近、再像素最近，见 `openai_image._snap_hk_gpt_image_size`），吸附结果写进 `params.warnings`。所以同一个 `gpt-image-2` 在 HK key 上会被 snap、在 Tuzi key 上原样发送。
- nano-banana：`size` = 比例字符串原样发（`"16:9"`）；`quality` low/medium/high。

### 词元跳动图片（provider=tokendance）

- `GET /gateway/v1/models` 免鉴权，返回 `data[]` 含 `supported_protocols[]`——既是 models-preview 的模态判定依据，**也是图片调用协议的判定依据**。
- **网关按协议挂端点，打错入口报 503 `no_endpoints_available`**（「模型 X 下无可用端点」）。协议标注决定端点：

  | 模型 | supported_protocols | 走哪个端点 |
  |---|---|---|
  | `seedream-5.0-lite` | `ark:` + `openai:image-generations` | `/gateway/v1/images/generations` |
  | `seedream-5.0-pro` | **仅** `ark:image-generations` | `/gateway/ark/v3/images/generations` |

  2026-08-13 实测：全网关 78 个模型里 pro 是唯一「只有 ark 图片协议」的。协议随模型存进 `ModelSpec.protocol`（models-preview 解析），旧 key 由 `keys._backfill_model_protocols` 读时回填；caller 端 `openai_image._effective_image_protocol` 取值，只有 `"ark"` 换 URL。
- **最小像素下限是模型属性，与协议路径无关**（两条路径实测同一下限）：`seedream-5.0-lite` / `doubao-seedream-4-5` 要 3686400，`seedream-5.0-pro` 只要 921600。见 `openai_image._min_pixels_for_seedream`。
- watermark / `sequential_image_generation` 只对火山直连与 custom 聚合商下的 seedream 发；**pro 明确拒收 sequential**（400），词元跳动网关的默认值未实测，故不发。

### 图像四族参数表

按**模型族**判断，不按 provider——HK 一个 key 下挂多族，同一个模型走直连还是走聚合商能力一样。
族判定：取最后一个 `/` 之后的尾段 → lower() → `_` 归一为 `-` → 子串匹配（覆盖 `openai/gpt-image-2` 这类 slug、`GPT-Image-2` 大小写、`nano_banana_pro` 下划线）。

| 族 | id 子串 | size 语义 | 比例 | 质量 | 分辨率切换 | 参考图上限 | 最小像素 |
|---|---|---|---|---|---|---|---|
| nano-banana | `nano-banana` | 比例字符串 | 1:1 4:3 3:4 16:9 9:16 2:3 3:2 | low/medium/high | 无 | 3（官方建议 ≤2） | — |
| gpt-image | `gpt-image` | 像素 WxH | 八档含 21:9 | 四档含 auto | 无 | 16 | — |
| seedream | `seedream` / `seededit` | 像素 WxH | 八档含 21:9 | 无 | 2K/4K | 10 | pro 921600、其余 3686400 |
| standard | 其余 | 像素 WxH | 八档含 21:9 | 无 | 2K/4K | 4 | — |

**真值源是 `tests/fixtures/capability-matrix.json`** —— Python 与 vitest 各自实现、共同对着它断言。改任一端的判据前先改那张表，两端测试会同时挡住漂移。2026-08-13 之前这四项在前后端各判各的（前端按 provider 判 seedream 尺寸、后端按 provider 判 quality 与参考图上限），后果是大量静默改写：Tuzi 下的 seedream 参考图被砍到 4 张、词元跳动上选的 quality 被后端丢弃。

后端做过的改写（尺寸放大 / HK 档位吸附 / 参考图截断 / 出图张数不足）一律写进 `params.warnings`，由图卡展示——不再静默。

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

契约源 `help.aliyun.com/zh/model-studio/happyhorse-api-reference`。**已接通**：`video_registry` 的 `dashscope` 适配器 → `happyhorse_video.render_video`，四模式全实现，`tokendance` key 下已挂 4 个模型。

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

**视频早已不按 provider 路由，改成按协议走注册表**（`callers/__init__.py::dispatch_video` →
`_effective_protocol` → `video_registry.VIDEO_ADAPTERS`）。协议值存在 `ModelSpec.protocol` 里
（models-preview 从上游解析，旧 key 由 `keys._backfill_model_protocols` 读时回填），解析不出
→ `WrongProviderError`，不再有「按 provider 名分流」这回事。

```
图片 dispatch：
  provider openrouter                      → openrouter_image.render（专用 /images，回 b64_json）
  provider openai/seedream/tokendance/custom → openai_image.render
    protocol == "ark"（词元跳动的 seedream 系）→ {gateway}/ark/v3/images/generations
    base 含 openai-hk                        → 强制同步通道（gpt-image 发 ?async=true 会 404）
    HK 上的非 gpt-image / nano-banana 族      → 回落 /chat/completions 抽图

视频 dispatch_video：按 ModelSpec.protocol 查 VIDEO_ADAPTERS，四个协议
  seedance   → volcengine_video   （Ark 直连 / 词元跳动改写任务 URL）
  dashscope  → happyhorse_video   （阿里百炼 / 词元跳动转发）
  kling      → kling_video        （HK 聚合，挂站点根）
  openrouter → openrouter_video   （异步 /videos job）
  protocol 为 None → WrongProviderError「无法识别视频模型的接口协议」
```

注意:上游模型列表里能拉到、但 `resolve_protocol` 认不出协议的视频模型（如词元跳动的
`kling-3.0` / `minimax-h3`）目前仍可被勾选保存，要到真出图时才报错。

帧语义（前端→caller）：双帧 = firstlast、仅首 = first、仅尾 = last、全空 = 文生视频；多余图片作 `reference_image`。

## 官方能力 vs 当前实装差距

设计配置功能时按这张表补：

| 维度 | 官方 | 当前实装 |
|---|---|---|
| seedance duration | 2.0 支持 4-15 任意整数秒 + `-1` 智能 | **已实装**全档（`videoControlCaps.ts` durationRange：2.0 4-15 / 1.5pro 4-12 / 1.0pro 2-12）；`-1` 智能未实装 |
| seedance ratio | 七档含 3:4、adaptive | **已实装**七档（1.0pro 按代际过滤 adaptive）|
| seedance 参考素材上限 | 图 1-9、视频 ≤3、音频 ≤3 | **已按上限截断**（caller 图 [:9] / 视频 [:3] / 音频 [:3]，前端同值）|
| seedance frames / callback_url / return_last_frame / service_tier / priority / tools | 有 | 未实装 |
| seedance 视频编辑 / 延长（2.0） | 参考素材 + 提示词表达 | 无入口 |
| happyhorse 四模式（t2v/i2v/r2v/video-edit） | 有 | **已接通**四模式；`parameters.audio_setting`（edit 保留原声）未实装；video-edit 的输入视频只收公网直链、**没有 OSS 中转兜底**（seedance 那条有），前端却放行本地上传 → 该模型从 UI 走必失败 |
| kling | — | caller 已写，模型未挂 HK key；UI 从不给 kling 开「全能参考」（能力总览表里那格是官方能力，不是实装）|

改前端控件 → `videoControlCaps.ts` + 对应 caller + `dispatch_video` 路由分支；改图像参考图上限 → `referenceLimits.ts` ↔ `openai_image._max_reference_images` 两端同步；改完验证 `cd web && pnpm lint && pnpm test`、`.venv/bin/python -m pytest`、`make build` + 重启 server。

## 已知坑

- HK 上游 `GET /models` 404，模型只能手填；TokenDance / Ark / Tuzi / OpenRouter 的 `/models` 可拉。
- HK `nano-banana-hd` 对不合它意的请求**不报错**：实测缺 prompt 时跑满 28s 回 `{"data":[{"revised_prompt":"NO_IMAGE"}]}`（有响应、没图，很可能已计费）。`_friendly_error` 已把这类翻成中文。
- Tuzi 对畸形请求**挂起不返回**（缺 prompt / 不存在的模型 id 实测都挂满读超时），而它是当前 default_alias；读超时不再重试后单次失败最长 = 读超时 300s。
- HK `/images/edits` multipart 已实测可用（仅 gpt-image 族；nano-banana 走 generations，其 edits 被 403）。
- kling-video-o1 omni 端点 image 字段命名待验证；caller 目前对 o1 也会发 `mode: std`（官方只给 t2v/i2v 描述了 mode），越界的 duration / ratio 未在 caller 侧 clamp，Skill 直写 job JSON 时会把非法值发到上游。
- TokenDance key 已充值并出图实测通（2026-08-13）；模型单价全部挂登录后台（`/portal/api/models/{slug}` 匿名 401）。
- TokenDance happyhorse 请求体两套字段（网关 quickstart 写 `input.img_url` + `parameters.size`，阿里官方写 `input.media[]` + `parameters.resolution`）——caller 按**官方**实现，网关实际吃哪套仍未验；已知提交阶段不校验参数(先回 200 + task_id，参数错要轮询才看到 FAILED，实测未计费)。
- TokenDance `:save` 后缀变体（seedance-2.0:save 等）含义全站无说明。
- 产物 URL 全员短命：seedance video_url 24h（任务 ID 7 天）、happyhorse task_id/video_url 24h——出片后立即落盘。
- seedance 参考视频仅公网直链：base64 被上游显式拒（`reference_video must be provided as a web url`，2026-06-12 经 TokenDance 网关实测）；本地参考视频由 `oss_upload.py` 中转阿里云 OSS（私有桶 + presigned 24h GET，配置在 keys.json `oss` 字段，同日真实上传冒烟通过）；参考音频 base64 内联可用（同日实测任务进 running），单段 ≤15MB（`_video_payload_url` / `_audio_payload_url`）。
