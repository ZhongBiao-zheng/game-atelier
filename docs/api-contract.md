# API 契约

> 前后端形状的单一真值源。**改任一端先改这里**。厂商侧契约见 [references/provider-config.md](references/provider-config.md)。

## 开发中的扩展契约

### 服务端预计费用（5.116.0）

`POST /api/pricing/estimate`，本机会话授权；沿用本地POST路由规则，需持有编辑租约。
入参 `{alias: string, model: string, kind: "image" | "video", params: JobParams}`；
出参 `{estimated_cost_cny: number | null}`。渠道不存在返回404，非法参数返回422。
读取已配置渠道及价格，按提交时相同的尺寸归一化估价，不创建任务、不访问生成接口。
画布局部修改/扩图在参数变化300ms后请求，等待期间与失败时不展示旧金额。

Tuzi快照位于 `<data_root>/.runtime/prices/tuzi.json`，字段为 `synced_at`、
`usd_exchange_rate`、`group_ratio`、`billing_expr[group][model]`、
`models[model].{quota_type,model_price,enable_groups}`。启动及每6小时自动同步公开价格和状态接口，
仅保留已配置分组、模型及实际请求模型。失败保留旧快照。表达式仅服务端执行，
缺失价格、未核实函数/字段、MJ及动态拆层均返回null。固定价不额外乘n；
表达式output_image_count为n，input_image_count为参考图数。费用是预计值，不是实际账单。

OpenAI-HK快照（5.116.4）位于 `<data_root>/.runtime/prices/openai-hk.json`，字段为
`synced_at`、`group_ratio`、`models[model].{quota_type,model_price,model_ratio,completion_ratio,enable_groups}`。
启动及每6小时同步固定官网 `https://www.openai-hk.com/ccapi/pricing`，只留配置模型，失败保留旧快照。
估价接口仅对已核实五个型号的default单张请求按 `quota_type=1` 的 `model_price`（元）返回金额，
不乘分组倍率。Nano Banana 2、多张、其他型号/分组及按token计费返回null；前端不保存HK价格表。
文本（网关文本 / Agent 转发、主机本机结构化文本调用）另走 `openai_hk_prices.text_cost_cny`：仅 default 分组、`quota_type=0`，积分 = ⌈(输入 + 输出 × completion_ratio) × model_ratio × 2 × 分组倍率 ÷ 1e6 × 10000⌉，÷ 10000 为元；倍率缺失或其他情形返回null。

### 图片尺寸意图（5.42.0）

`JobParams`、`CanvasImageDefaultParams` 增加 `size_mode?: auto | ratio | custom`、
`custom_size?: string`。后者只是编辑器回切缓存；草稿允许暂不完整的数字输入，提交才严格验证。
缺模式保留既有比例行为，不根据近似像素反推用户意图，不迁移旧记录。
画布 Agent / MCP 的 `set_draft`（图片）未传 `size_mode` 时按写入的字段补齐：`size=auto`→auto，`size=WxH`→custom，有 `ratio` 或 `size` 含冒号→ratio；这是调用方显式写入的意图，不是对旧记录的反推。
5.42.2起，首页、Studio、Canvas新建草稿及服务端新建默认配置，在所有尺寸字段
（size_mode/size/ratio/resolution/custom_size）均未指定时，按当前模型能力默认AUTO；
不支持AUTO时使用受支持的默认比例。已有尺寸选择、历史任务和重试不重置。

- AUTO：服务端再次核对渠道+精确模型+协议，冻结 `size=auto`，移除 ratio/resolution。
  OpenRouter 出站为 `aspect_ratio=auto`，不是省略后隐含1:1；不改质量或数量。
- ratio：保留选中比例及当前模型支持的分辨率，计算提交尺寸。
- custom：size是唯一像素权威，去ratio/resolution；正整数边长≤100000，GPT长短边≤3:1。
  Blur/提交规范模型尺寸，HK先吸附其30项表，前端预览与后端规范一致。
- 所有冻结入口删除custom_size；Job、Snapshot、再次生成仅用生效参数，原图实际尺寸另记actual_size。
- Canvas/Studio/首页Studio共用尺寸字段；编辑宽高即选custom，聚焦不切换，恰好等于预设比例也不自动回切。
  AUTO不显示宽高，自定义不显示分辨率；摘要分别AUTO/比例/W×H。切模式保留自定义缓存，换模型不支持时短提示并回比例。

AUTO能力依据（2026-09-09）：[OpenAI Images](https://developers.openai.com/api/docs/guides/image-generation)、
[HK GPT Image](https://www.openai-hk.com/docs/openai/gpt-image.html)、
[OpenRouter图像API与模型能力](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)。
5.44.2起，OpenRouter的比例、AUTO、分辨率按共享
`src/character_workflow/image_size_catalog.json` 的精确型号描述读取；其他渠道AUTO仍由
`imageControlCaps.ts` 与 `image_size.py` 同步维护。尺寸核查范围与来源见
[图片尺寸能力核查](references/image-size-capabilities.md)。
Tuzi Nano的21:9、4:5、5:4在偏好与冻结Job中保留冒号，已有Images请求出站使用21x9等格式；
OpenRouter出站仍使用aspect_ratio冒号。OpenRouter新增分辨率档位默认不指定，只有显式选择才发送；
未声明尺寸能力的型号不发尺寸字段。各模型常用预设不等于连续像素模型的全部可能尺寸。
OpenRouter Sunburst（`openai/gpt-image-2.5-sunburst`）例外：经实测支持显式像素，提供2K/4K；
出站转换为`size`，不同时发送`aspect_ratio`或`resolution`。沿用GPT像素约束（16对齐、最长3840、最多8294400像素）；默认与AUTO不变。
5.42.1补齐Tuzi的精确型号 `gpt-image-2`、`gpt-image-1.5`、`gpt-image-1`：
[default文生图](https://tuzi-api.apifox.cn/343646952e0)、
[官方兼容文生图](https://tuzi-api.apifox.cn/448333922e0)、
[官方兼容编辑](https://tuzi-api.apifox.cn/448333992e0)均注明size=auto；
5.42.3修正调用层：通用异步包装已被上游410拒绝，停止使用 `/async/*` 和 `/get-async`。
VIP、固定1K等别名不由基础型号推断能力。Seedream/MJ/未知渠道暂不展示AUTO。
AUTO不承诺跟随参考图，不能据固定像素估价；保留真实账单或有依据的固定单价。

### 模型路由（5.90.0）

- `GET /api/models` → `{models: [{id, name, modality, mode, candidate_alias, members: [{alias, provider, base_url, billing_group, model_id, name, protocol, estimate_cny}]}]}`；`members` 按当前方式排序，`candidate_alias` 是跳过欠费/冷却后的实际候选（无可用成员为 null；仅短时冷却可兜底）。`mode` 为 `order | cheap | round_robin`。只有 cheap 返回默认参数的人民币预估，未知或其他方式为 null；实际提交按本次参数估价。列表预览不推进轮流游标。`billing_group` 同步进网关 `via`，能力和估价按成员分组判断。
- `PUT /api/models/order`，body `{modality, id, aliases}`：`aliases` 必须恰好是该组现有成员的一个排列，否则 422；组不存在 404。属管理权限。
- 创作台 `POST /api/studio/jobs`、画布草稿 / 生成偏好 `selection`、Agent `CanvasAgentModelRef`：`alias` 为空即「自动」，`model` 为路由 id；Job 与运行快照里的 `alias` 始终是实际使用的 KEY。
- `PUT /api/models/mode`，body `{modality, id, mode}`：返回更新后的路由对象；非法方式 422、组不存在 404。属管理权限。非默认方式存 `keys.json.route_mode[modality][id]`，order 删除覆盖；停用保留，删除最后一个成员才清理。
- `JobParams.route_id`：「自动」提交时由服务端写入（浏览器传入的会被覆盖）；`route_order`：本次自动选择冻结的候选 alias 顺序；`route_tried`：失败切换时换掉的别名。三项都由服务端写入并在通用参数编辑时保留；失败切换只沿快照实时过滤，不重新排序或消费轮流。运行快照的 `alias` 是提交时解析的那家，失败切换后以 Job 的 `alias` 为准。

### 局域网网关协议 v2（ADR-0025）

网关服务在独立端口（默认 5180）只提供下列接口；除 health 外全部要求 `Authorization: Bearer <网关密钥>`，不认 cookie；其他路径 404。

- `GET /gateway/v1/health` 无需密钥，只返回 `{ok: true, version: string}`，不包含任何配置或用量。

- `GET /gateway/v1/info` → `{name, version, protocol: 2}`。协议版本不一致时接入端直接报错，不做兼容。
- `GET /gateway/v1/models` → 返回 `{models: [{id, name, modality, members}]}`，成员为供应商公开信息，含全部模态；控制台专用的 `mode / candidate_alias / estimate_cny` 不属于此目录协议；按当前密钥的模型与 alias 权限过滤，排除 atelier 成员，视频成员保留 `protocol`。
- `GET /gateway/v1/me` → `{id, role, name, quota: {period, cap_cny, used_cny, reserved_cny, left_cny, resets_at} | null, limits: [...], month_charged_cny, month_calls}`，只读当前密钥。`quota.period` 为 day|week|month|none，none 时 `resets_at` 为 null。`limits` 是给第 7 批前成员的兼容层（与 quota 同一条，none 时为空列表，字段同 quota 但 period 只有 day|week|month），下次改 PROTOCOL_VERSION 时删（ADR-0025）。可选 `?call_tag=<标记>`（格式 `^[A-Za-z0-9:_-]{1,128}$`）时多回 `call_tag: {requests, charged_cny}`：近 40 天里这把密钥名下带这个标记的文本调用次数与结算额，别的密钥的行一律不算；格式不对当没带，不回该字段。
- `POST /gateway/v1/tasks`：multipart，字段 `request`（JSON：`kind`、`model` 路由 id、`prompt`、`n`、`size`、`params`）+ 素材文件。
  `kind` 为 image / image_edit / layer_split / video / audio；文件组 `ref_0`…`ref_15`、`mask`、
  `mj_sref_0`…`mj_sref_7` / `mj_cref_0`…`mj_cref_7` / `mj_oref_0`…`mj_oref_7`、
  `video_0`…`video_3`、`audio_0`…`audio_3`，各组编号连续且不允许重复字段。
  图片/蒙版/音频单文件 20 MiB，视频 200 MiB，请求体 400 MiB、最多 49 文件；
  请求头 `Idempotency-Key` 必填（同一把密钥下同一个 key 返回同一个任务）。返回 202 `{task_id}`。
  模型不存在 404、无权使用 403；`params` 只收白名单控制字段，出现路径类字段 422；金额窗口超限 429（`中转额度已用完`），`Retry-After` 为最晚重置时间距现在的秒数。编辑仅收 mode/x/y/width/height，inpaint/outpaint 都要求源图和蒙版，outpaint 必须给宽高；
  layer_split 要求 layer_decomposition=true 和一张源图。视频仅收 duration/resolution/ratio/mode/frame_mode/generate_audio/watermark；
  音频仅收 voice/speed/response_format/instructions。
- `GET /gateway/v1/tasks/{id}` → `{task_id, status: pending|running|done|failed|canceled, phase, member_alias,
  warnings, actual_size, actual_cost_cny, outputs: 产物数量, error, error_kind, kind, output_types: MIME[],
  extras: [{role, index}], layer_result}`。`error_kind`：`unavailable`（全部成员都因
  确定没执行的原因失败）、`unconfirmed`（网关重启等，可能已执行）、`failed`（其他）。
- `GET /gateway/v1/tasks/{id}/outputs/{i}` → 第 i 个产物的字节（对应 MIME）；`POST /gateway/v1/tasks/{id}/cancel` → 取消。
- `GET /gateway/v1/tasks/{id}/extras/{i}` → 编辑过程图；layer_result 为无路径的图层元数据，图层产物不按 n 截断。
- 视频上游订单号/提交诊断仅存在网关；已获订单号或提交未确认后禁止换供应商重发。
- 任务只对创建它的密钥可见（其他密钥 404）；已结束的任务与文件自创建起保留 24 小时，没结束的（排队、执行、待续查）不清理。
- 网关重启（2026-11-18 起）：从没发给上游的排队任务继续排队；执行中且有能续查订单的任务（Tuzi 异步图片、自定义接口异步、EvoLink MJ、MJ 任务代理、音潮音乐）改回排队，`phase="resuming"`，只用原来那一家凭已存订单轮询，不换家、不重新提交，出错按 `unconfirmed` 失败；其余执行中任务判 `unconfirmed` 失败、扣 0。续查任务在结束前一直占着额度预占，结束后按原结算规则扣费。续查状态存在任务文件的 `resume_params`。
- 视频续查（2026-11-19 起，逐协议接入）：视频 caller 每提交一单就回报续查状态（`on_resume_state`），网关存进 `resume_params.video` =
  `{protocol, tasks: [{id, poll_url?, url?}], sent?, act?, url?}`；续查时把它作为 `resume_video` 交回 caller，只轮询这些订单、不提交、不重新上传素材。
  已接入：EvoLink 可灵视频（`sent` 为提交时的回显过滤集合，原样存下，因为重建请求会重新上传、得到不同地址）、OpenRouter 视频
  （存上游给的 `polling_url`，结果走 `unsigned_urls`，不需要回显过滤）、Seedance（`sent` 原样存下，理由同 EvoLink：本地参考视频经 OSS 上传；
  提交响应已直出的那单存 `tasks[].url`，续查时直接下载）、可灵旧版（存端点 `act` 与 `sent`）、可灵新版（存任务地址 `url` 与 `sent`，
  本地参考视频同样经 OSS 上传）、Vidu（兔子统一 `/v1/videos`，存任务地址 `url` 与 `sent`）、DashScope（存 `sent`）。任一提交尝试为「未确认」的视频任务不续查，按 `unconfirmed` 失败。
  存下的 `protocol` 与这次按 KEY 算出的协议不同（停机期间 KEY 被改过）时不续查，按 `unconfirmed` 失败；续查时原路由已不存在或网关密钥已撤销，
  同样按 `unconfirmed` 失败（上游已有订单）。
  OpenRouter、可灵旧版、DashScope 视频提交后立即上报订单号，之后失败不再被当成「没执行」换别家重提。
- 应用内更新与网关任务（2026-11-19 起）：更新排空只等「执行中且重启后不能续查」的网关任务（`update_routes.gateway_work(update_drain=True)`）；
  排队中的重启后保持排队、能续查的（`gateway_tasks.resumable`）重启后凭已存订单接着查，都不拦更新。更新期间 `pump()` 不启动排队任务；
  更新取消或失败、留在原进程时接着调度。桌面外壳的 `/api/shell/active-work` 仍按全部非终态网关任务计数（外壳退出后服务不会自动起来）。
- 任务参数补充：`prompt` 最多 32,000 字符，除 layer_split 外不能为空；`n` 为 1–8。生成任务最多同时运行 8 个、每把密钥最多 4 个，剩余已受理任务排队。
  各类型允许的文件组：image 为 ref/mj_sref/mj_cref/mj_oref，image_edit 为 ref/mask，layer_split 为 ref，video 为 ref/video/audio，audio 不接受文件。
  图片控制字段白名单为 size/size_mode/custom_size/ratio/resolution/quality/background/complexity/output_format/frame_count/frame_duration_ms/steps/cfg_scale/requested_size、
  bot_type/mj_version/mj_stylize/mj_chaos/mj_weird/mj_seed/mj_no/mj_tile/mj_style_raw/mj_iw/mj_sref_code/mj_profile/mj_sw/mj_cw/mj_ow/mj_flags；
  image_edit 额外接收 image_edit 对象，layer_split 额外接收 layer_decomposition。未声明字段返回 422。
  `layer_result.outputs` 以 output_index 关联产物，包含 z_index、size、output_format 和前景 bounding_box（absolute 像素坐标 / normalized 千分坐标）；不含本机路径。
- 密钥策略（第 7 批）：`quota: {cap_cny, period: day|week|month|none, since} | null`（金额 >0 且 ≤1,000,000；since 由主机写，只改金额时保留、改周期时重置）；
  `scope: [{alias, models: [model_id] | null}] | null`：null 表示全部模型；条目 `models: null` 表示该供应商全部（含以后新增），列表是该供应商自己的 model id。
  同一 alias 只能出现一次；新保存不允许空范围（`[]` 或某条 `models: []` 返回 422），旧数据转换出的空范围照常读出。
  别名 1–120 字、模型 id 1–200 字、每条最多 500 个模型、最多 200 条，只在接口写入时查。`.config/gateway.json` 读写上限同为 2 MiB，修改会超限时返回 413 并不保存。旧 `limits` / `allowed_*` 读入时转换并写回（ADR-0025）。
  day / week / month 按网关本地日历零点、周一和月初重置，none 不重置、从 since 起累计；受理时按首个可选成员估价预占，与限额判断共用锁。
  终态优先结算实际费用，否则成功用估价、失败或取消记零；无价预占零。失败切换中各次已报告实际费用累加。
- 接入端接回原任务（2026-11-18 起）：第一次提交前生成幂等键并连同请求指纹（提示词、模型、发给主机的参数、素材字节的 sha256）
  落进 `params.gateway_idempotency_key` / `gateway_request_fingerprint`，之后所有重发都用这个键（主机按「成员密钥 + 幂等键」去重，
  不比较请求体）。幂等键形如 `<首次发出的 Unix 秒>-<32 位十六进制>`。`gateway_unconfirmed=true` 表示「这把键在主机上的结局还不知道」：主机受理后、提交三次都未确认、查询放弃、产物下载重试 4 次仍失败时记；沿用旧键发送（接回、上次未确认后重发）时发送前就记，连不上也不清（且不换本机 KEY）；只有主机给出这把键的终态（失败 / 取消）或结果已取回才清。新键第一次发送、连接都没建立的失败不记。
  「再次生成」：创作台失败轮次在 `POST /api/studio/jobs` 带 `reattach_job_id`，画布由服务端取同一节点最近一次任务；原任务是
  `gateway_unconfirmed` 的失败、同一供应商、这把幂等键首次发出不满 20 小时时（按键里的时间算，连续再次生成不会顺延），新任务继承幂等键与指纹并记 `gateway_reattach_of`。caller 按这次实际
  要发的内容重算指纹，相同才用原键重发（主机返回原任务，接回结果），不同就换新键下新单；接回的原任务在主机上已是失败或取消时，
  同一次运行里换新键重新下单。浏览器传来的 `gateway_*` 字段一律丢弃。
- 停止（2026-11-19，第 5 批 5-3，飙哥定「跑完并计费」）：主机 `POST /gateway/v1/tasks/{task_id}/cancel` 与新增的
  `POST /gateway/v1/tasks/cancel`（JSON `{"idempotency_key"}`，按成员密钥 + 幂等键找任务）都返回任务视图加
  `cancel_outcome`：`canceled`（还没发上游，已取消或马上取消，扣 0）/ `continuing`（已发上游，照常跑完并按成功规则计费，
  不设取消标记）/ `finished`（取消前已结束）。ComfyUI 例外：在主机本机执行、不计费、能中断，已发出的也取消。
  按幂等键取消时主机没有这把键：记一个「已取消」占位任务（`route_id` 为空、不写用量行），后到的同键提交直接拿到它；
  只接受格式合法且签发不满 20 小时的键（否则 422），每把网关密钥保留期内最多 200 个占位（否则 429）。
  接入端：轮询中停止且主机答 `continuing` / `finished` 时本机立即停，文案「已停止（已提交的任务仍会完成并计费）」，
  `gateway_unconfirmed` 保留，「再次生成」请求相同时接回取结果（接回条件放宽到「已停止」）；停止请求送不到主机时记
  `JobParams.gateway_cancel_pending`（后端独占），文案「已停止（网关上的任务可能仍在执行）」，由
  `gateway_cancel_outbox` 连上主机后按幂等键补发，主机答复后清掉并改文案；键超过 20 小时不再补发。旧主机没有按键取消的
  接口（404 / 405）时退回按任务号取消。
  结算（第 6 批，2026-11-20）：主机答「已发上游、会跑完」（含轮询中直接送达）时记 `JobParams.gateway_settlement="pending"`
  （后端独占），补发线程每轮按幂等键再问主机，主机到终态时置 `settled`：扣费 > 0 记 `actual_cost_cny` 并在文案末尾附
  「（已扣 ¥x）」，主机失败 / 取消的基础文案为「已停止」；同一把幂等键的主机扣费在接入端只记一次——谁先拿到主机终态谁记
  （`<data_root>/.runtime/gateway-charges/<幂等键>.json` 先到先登记），另一条（原「已停止」那条或「再次生成」接回的那条）
  不记金额，记 `JobParams.gateway_charged_on=<记了金额的任务 id>`，原任务文案为「（费用记在再次生成的任务上）」。
  用量页「我的」计入 `canceled` 且 `actual_cost_cny > 0` 的任务——不限网关：EvoLink 在下载产物前回报上游金额、
  OpenRouter 视频每完成一单累计回报，停止在这之后的任务也已经花了钱，以前不显示，现在按实际扣费计入（有意修正）；
  `actual_cost_cny` 为空或 0 的已停止任务照旧不计。任务表里这类行的状态显示「已取消 · 已扣费」并带说明。
  登记（`gateway_charges.claim`）永不抛异常：不支持硬链接的数据目录（exFAT / FAT32 外接盘、部分 SMB / 网盘同步目录）
  退回独占创建，仍先到先得；其他文件系统错误按「记在本任务」处理，宁可极端情况下重复记一笔，也不让已出图的任务失败。主机任务终态 `error_kind="unconfirmed"` 时接入端抛
  `GatewayHostUnconfirmed`（未确认类型，「自动」不换家，不挂「等待网关」）。
- 接入端等待网关（2026-11-19 起）：创作台任务由后台等待者（`_run_studio_job_safely`，创作台专用线程池，不在事件循环里）
  运行时，没拿到网关结果（`GatewayUnconfirmed`：提交未确认、查询放弃、下载失败、旧键连不上）且这把幂等键首次发出不满 20 小时，
  任务保持 `pending`、`progress_phase="waiting_gateway"`（界面显示「等待网关」），等待者约 30 秒一轮，先用 3 秒的健康检查探网关，
  连上才凭同一把键接回原任务；本机服务重启后同样续上。超过 20 小时（与「再次生成」接回同一判据，按键里的时间算）判失败
  「网关任务结果未确认：已超过 20 小时，不再等待」。轮询中网关暂时连不上时阶段先切到 `waiting_gateway`，恢复后改回；
  主机对任务号回 404 时判失败，不再等。画布任务没有后台等待者：在线程里最多等 30 分钟（`CANVAS_GATEWAY_POLL_GIVE_UP_SECONDS`），
  到期判失败并保留标记，「重新生成」时接回。CLI 等其他直接 `run_job` 的路径不进入等待，照旧判失败。
  停止：等待中、没有线程在跑的创作台任务立即落 `canceled`「已停止（网关上的任务可能仍在执行）」；正在轮询时网关连不上，
  停止请求送不到主机，本机立即停；两种情况主机上的原任务都可能照常完成并扣额度。
  本机服务关停不算停止：等待者跑的局域网 Atelier 任务正在轮询时，停下轮询、不向主机发取消，留在「等待网关」，下次启动（lifespan 开始时复位关停信号）接回；已在等待中的任务关停时保持 `pending`。
- 主机确定没收下的提交（2026-11-19 起）：主机更新排空时回 `503 {"detail","reason","code":"updating"}`，`code` 是结构化标记
  （请求在受理前被挡下，主机没建任务）；接入端按状态码 + `code` 判断，与连接都没建立一起抛 `GatewayNotAccepted`，原样重发不会重复下单。
  选「自动」的任务照旧换组内下一家（换家原因 `updating`「正在更新」或 `unreachable`）；明确选了网关的，创作台进上面的「等待网关」
  （用同一把幂等键重发，`gateway_unconfirmed` 置 true，同一套 20 小时期限与重启续上），画布在线程里每 10 秒用同一把键重发、最多 30 分钟。
  旧主机的 503 没有 `code`，接入端照旧判失败。CLI 等直接 `run_job` 的路径照旧判失败。
  这把幂等键在主机上的结局未知时（`gateway_unconfirmed` 为真，或错误链上有 `GatewayUnconfirmed`），即使选了「自动」也不换家：
  `failover_reason` 返回 null、`_switch_route` 不换，按「未确认」失败，文案「网关暂不可用，原任务结果未确认；可改选其他供应商重新生成」。
  原任务结局未知的 20 小时内（与接回同一期限）不会自动换家；明确改选别的供应商时别名不同，不接回，按新单出图。
- 接入端：`provider="atelier"` 的 KEY，`ModelSpec.via` 是网关成员快照；Job 用 `provider_task_protocol=atelier_gateway`
  与 `provider_task_ids` 记录网关任务 id，重启后只查询既有任务。caller 把网关结果映射为：401 → `gateway api 401`，
  403 → `gateway api 403`，429 → `gateway api 429`，`error_kind=unavailable` → `gateway api 503: unavailable`（均可触发接入端自动路由失败切换），
  其余不带状态码；`unconfirmed` 的文案含「未确认」。
- 接入端收到网关 429 时保留中文 detail，按 Retry-After 秒数冷却对应模态的 atelier alias；文本 OpenAI 前缀的 error.message 同样处理。
- `GET /api/gateway/providers/{alias}/me`：本机代查该 KEY 的本人额度，按地址和凭证缓存 30 秒（含失败）；失败返回 null，页面静默隐藏。
- `GET /api/gateway/tasks?scope=active|recent`（管理权限）：返回 `{tasks}`。active 含进行中的生成与文本调用；recent 为 24 小时内终态，倒序最多 200。
  字段 `task_id, kind, key_name, route_id, member_alias, member_trail, phase, status, created_at, updated_at, prompt, n, outputs, output_types, error`；文本 prompt 固定 null。
- `GET /api/gateway/tasks/{task_id}/outputs/{index}`：本机 cookie 会话预览，要求管理权限；无文件或任务返回 404。
- SSE `gateway_task` 携带同形快照，仅发给拥有本机管理入口的 local 会话，不发给 agent；任务落盘、文本登记和结束均通知。页面合并快照，有运行中任务时每 4 秒刷新，空闲时停轮询，重连后重新拉取。
  控制台复用 AppShell 现有 SSE 连接；文本结束事件只用于即时通知，文本调用不持久化为生成任务，刷新后的 recent 列表只含落盘的生成任务。
- 本机管理（管理权限）：`GET/PUT /api/gateway`（开关 / 端口 / 名称 + 运行状态）、`POST /api/gateway/keys`（返回明文 `token`）、
  `PATCH /api/gateway/keys/{id}`（名称、金额窗口、模型与 alias 权限）、`POST /api/gateway/keys/{id}/revoke`；使用记录见 `GET /api/usage?scope=team`。
  创建 body 为 `{name, role?, token?, quota, scope}`，PATCH 接受任意字段子集（省略保持原值，`quota` / `scope` 传 null 取消限制）。
  `GET /api/gateway/options` → `{providers: [{alias, provider, enabled, models: [{id, name, modality, route_id}]}]}`：按供应商列出可经网关提供的模型；停用的供应商 `enabled=false`、`route_id=null`。
  `GET /api/gateway/keys/{id}/token` → `{token}`，只允许本机会话管理权限，响应 `Cache-Control: no-store`；不存在或已撤销返回 404。网关端口及远程 admin 代理不提供此接口。
  `GET /api/gateway` 的密钥含 `quota_status`（同 /me 的 quota，未设额度为 null）、`month_charged_cny`、`month_calls`、`last_used_at`；列表、更新及审计不含明文或哈希。
  `GET /api/gateway` 另含 `quarantined_tasks`（损坏后移到 `.runtime/gateway/quarantine/` 的任务文件数）与 `config_error`
  （`.config/gateway.json` 读不出时的原因，否则 null）。配置读不出时返回 `enabled=false`、`keys=[]`，网关保持关闭；
  其余读写 `gateway.json` 的接口返回 500 并带同一原因，不覆盖、不重建该文件。
  `.config/gateway.json` 在仅当前系统用户可读写的文件内保存明文与 SHA-256；鉴权仍只比较 SHA-256。读取时在同一文件锁下为未撤销且缺少明文的旧记录重发密钥并原子写回，旧密钥立即失效；ID、名称、角色、额度和创建时间保持不变，已撤销记录不重发。
  `GET /api/gateway/options` → `{models: [{id, name, modality}], aliases: [{alias, provider, name}]}`，alias 排除 atelier。
  用量行新增 `kind`、`estimated_cny`、`charged_cny`、`input_tokens`、`output_tokens`、`duration`、`resolution`、`member_trail`；不存 prompt，前端直接汇总结算金额。
  结算（`charged_cny`）：成功任务有实付扣实付、没有按估价扣；失败 / 取消只扣上游回报的真实金额（`actual_cost_source="upstream"`，如 EvoLink / OpenRouter 的 `usage.cost`，含多任务中途失败前已完成的部分），按本机价格表算出的金额（`"price_table"`：语音字数、图层数、歌曲数）失败时扣 0。旧任务没有 `actual_cost_source`，沿用「有实付扣实付」。用量行同步记录 `actual_cost_source`。接入端在失败任务的 `charged_cny > 0` 时把这部分记为该任务实付。
  `GET /api/model-routes/member-status` → `{members: [{modality, alias, reason, since, next_probe_at, route_ids}], unavailable_routes: [{id, name, modality}]}`。
  欠费状态跨重启保留；`unavailable_routes` 只计非 atelier 成员且均在欠费冷却期的路由。
  `POST /api/model-routes/member-status/restore {modality, alias}` 清除该成员欠费及内存冷却，返回同一状态视图；两接口仅本机管理权限可用。
  接入端：`POST /api/gateway/check {base_url, access_key | alias}` → `{info, models}`（models 为带 `via` 的 ModelSpec）；
  `POST /api/gateway/providers/{alias}/sync` 整体替换该 KEY 的模型。新建 `provider="atelier"` 的 KEY 时排到所在每个路由组第一位，
  同步出的新模型同样排第一（已调整过顺序的组不动）。

### 网关文本透传（协议 v2）

- `GET /gateway/v1/openai/models` → OpenAI `{object: "list", data: [{id, object: "model", owned_by: "atelier", ...能力字段}]}`。只列获准的文本路由，能力取首个获准成员的上游 `/models`，取不到则声明 `supported_parameters: ["tools"]`。
- `POST /gateway/v1/openai/chat/completions`、`POST /gateway/v1/openai/responses`：Bearer 鉴权；JSON 请求体最多 32 MiB。model 为路由 id，上游改为实际成员 id；非流式响应的 model 改回路由 id，流式 SSE 字节不改写。
- 仅生成上游 Authorization、Content-Type、Accept 头，不转发接入端 cookie 或其他请求头。chat 流缺少 `stream_options.include_usage` 时自动设 true；旁路提取 chat 或 Responses 用量。
- 请求头 `X-Atelier-Call-Tag`（格式同上）：合法时只记在这一次调用的用量行上（`call_tag` 字段），不转给上游、不进任务文件和主机用量页；不合规当没带，照常中转。旧版本读用量行按整行字典解析，多出的键不影响。
- 按输入估算 token 和该密钥最近 50 次文本输出平均 token（无历史 1000）估价预占，取消/结束释放预占。输入估算：`url` / `image_url` 字段里的每张内嵌图片（`data:image/…`）按 3800 token 计（`gateway_text.IMAGE_INPUT_TOKENS_ESTIMATE`；原为 1600，按 Anthropic 视觉文档的 宽×高÷750 定，2026-11-20 付费实测 Tuzi / claude-sonnet-5-5 一张长边 1024 的联系表请求输入约 3400–3800 token，只估到一半，故上调；单一模型的一个样本，远高于公式的原因未查明），其余请求字节 / 3；以前图片也按 base64 字节 / 3，一张 1024px 的图会被估成几万 token。只影响预扣，结算照旧按上游用量；估值偏低时这一次调用可能略超额度，下一次准入时被拦。用量行 kind=text，不存 prompt；进行中调用在 gateway_live 登记。
- 文本计价（2026-11-18 起，价格见 `docs/references/generation-pricing.md`「文本按 token」）：按实际服务的成员 KEY 与模型计价。用量优先读 `prompt_tokens` / `completion_tokens`（chat/completions），没有时读 `input_tokens` / `output_tokens`（responses）；`*_tokens_details.cached_tokens` 为缓存命中部分。
- 文本结算：OpenRouter 回报 `usage.cost`（美元）时记为上游实付（`actual_cost_source="upstream"`），成功、失败都按它扣；其余按 token 同步价算出的金额记为 `"price_table"`，只在成功时扣，失败扣 0；无价扣 0。上游返回 2xx 却始终没有用量时，用量行记 `usage_missing: true`、扣 0，由主机承担（`gateway_stats` 单列条数）；从未被上游接受的调用不记 `usage_missing`。
- 只在发出首字节之前对确定可切换的错误换成员；已转发后的中断结束当前流、记 failed，不重发请求。流前错误形状统一为 `{error: {message, type, code}}`；全部成员不可用为 503 / gateway_unavailable，限额为 429 并带 Retry-After。上游可能已执行的错误为 503 / gateway_upstream_error，接入端不得切换本机 KEY 重发。
- 接入端 `key_api_root` 将 atelier 的文本/Agent URL 指向上述前缀；同步文本模型保留协议。文本 Job 收到 503 gateway_unavailable 时可按自动路由切回本机 KEY。

### 模型公告源

`GET /api/announcements` 返回 `{announcements: [...]}`，字段与 `src/character_workflow/data/announcements.json` 一致（`id`、`date`、`version`、`title`、`summary`、`imageUrl`、`models[{name, ids}]`，新的在前）。来源顺序：上次从 main 拉到并校验通过的缓存（`.runtime/announcements.json`）> 打包的那份；远程只认仓库自己的 CNB / GitHub raw 地址，校验失败不覆盖缓存，`imageUrl` 只收 https。只返回 `version` 不高于本机插件版本（ADR-0032 排序）的条目。

### 图层栈显示顺序（5.44.0）

`layer_stack.data.base_z_index` 默认 0，背景与 `layers[].z_index` 共用 0–99 范围（5.136.0 起随 Seedream 5.5 由 0–16 放宽）；存在背景时所有层级值必须唯一。
左侧合成按 z 升序绘制，右侧列表按 z 降序展示。拖拽后统一编号 0..N-1，通过原 Document 保存与撤销链路持久化。
层 id、version_id、bounding_box、可见性、material_node_id 不随排序改变；Job 中的原始输出层号仍表示不可变来源，不是编辑后的显示顺序。

### 对比节点（5.110.0）

`compare` 节点 `data` 为空对象；对比的两张图由两条 `role=input` 连线决定，`slot` 为 `before` / `after`，
来源必须是 image 节点，每个槽位最多一条，不能带 `annotated`。`before` / `after` 只能连进 compare 节点；
compare 节点不提供任何连线、不参与生成。显示的是来源节点**当前**版本。

前端在提交时统一收口：拖到 Before / After 接口带槽位；拖到节点身上、多选连线等不带槽位的按 before → after 填空位，
满了丢弃；同一来源只留最新一条，后来者顶替已占槽位。扩图结果对比它自己的原图时，按该结果生成快照的
`normalized_params.image_edit` 几何把原图放回原位（实时计算，不持久化）。

图片工具栏只在局部修改 / 扩图 / AI高清 结果上露出“对比”：原图取自生成快照；快照登记的原图节点仍显示该版本就直接连，
否则新建一张固定原图版本的图片节点再连。分界位置只是本地显示状态。

### Tuzi 图片任务（5.42.3）

- 精确 `gpt-image-2`、`gpt-image-2-vip`、`gpt-image-1.5`、`gpt-image-1` 普通出图走
  `POST /v1/videos` multipart；字段model/prompt/size，参考图重复input_reference，size保留auto或像素。
  每次提交一张，多张按槽独立提交；不传Images专用n/response_format。
- `GET /v1/videos/{id}` 的 completed.video_url 实为图片URL，复用图片下载和落盘。
  依据：[创建任务](https://tuzi-api.apifox.cn/472418522e0)、[查询任务](https://tuzi-api.apifox.cn/472418529e0)。
- 未列模型（含固定1K、Nano、Seedream）、蒙版、独立quality/background要求，预先选择原生兼容Images接口。
  不推断别名的异步支持，不换计费模型，不在请求失败后改路重提；蒙版等参数不静默丢弃。
- 新任务 `provider_task_protocol=tuzi_images`，首次获取ID立即保存provider_task_ids，恢复只查询既有订单。
  历史tuzi_async标签仅保留记录可读性，不再自动恢复、迁移ID或重提旧订单。
- 5.43.3：新建 `gpt-image-2` + `size=auto` 预先选择 Images：无参考图走
  `/v1/images/generations` JSON，有参考图走 `/v1/images/edits` multipart，原样发送 auto。
  本机实测两种请求均成功，异步 AUTO 订单持续 queued；不把 AUTO 改成固定像素或更换模型。
  已有 `tuzi_images` 订单仍只查询原接口。此 AUTO 路径收到 502/503/504 也不重提，避免不确定计费。
- 错误脱敏仅保留精确公开接口路径，本地路径和密钥继续隐藏。
- 5.43.1：Tuzi 每轮查询按已流逝时间设置 10 分钟调度预算（含传输重试），到期不再发起 GET。
  这不是严格的端到端传输截止：在途 GET 仍使用 Requests 的连接/读取空闲超时。
  Canvas 没有后台恢复等待者，
  超时或连续查询失败会结束本地等待、结算未完成候选并保留订单号及已完成素材，不提交后续候选。
  本地失败不等于厂商取消；提示核对订单、重新生成可能重复计费。Studio 保留既有只查询订单的恢复机制。
- 5.43.3：候选失败的非空原因去重后汇总到 Job.error；部分成功保留部分成功提示与具体原因，
  全部失败仅在缺少任何原因时使用“没有可登记的结果”，不覆盖真实厂商状态与订单号。

本机连接与外部 Agent 入口见 [本机连接](contracts/local-connection.md) 与
[画布 MCP](contracts/canvas-mcp.md)：状态、鉴权、Agent 授权、编辑租约与 typed 工具。
托管网站方案已弃用（ADR-0023），只有本机页面与本机 Agent 两种访问方式。

`GET /api/connection/agent`、`PUT /api/connection/agent`、`DELETE /api/connection/agent`
统一返回 `{enabled, connections, credential_path, clients, tools}`，仅本机管理会话可读。
`connections` 为各宿主本次进程内最近连接时间（宿主名见下）；`credential_path` 为适配器读取的凭据文件
`<data_root>/.config/connections/agent.json`（客户端配置里不放凭据）。
`clients` 按固定顺序列出 `claude-code / codex / cursor / claude-desktop / trae / workbuddy`，每项
`{ id, mode, path, written, snippet, warning }`：`mode` 为 `write`（可一键写入：codex、cursor、claude-desktop）、
`copy`（只给配置片段：claude-code、trae、workbuddy）或 `plugin`（Claude Code 已装 Atelier 插件，无需配置）；
`path` 为该客户端配置文件位置（`copy` 类为 null；codex 使用 `CODEX_HOME/config.toml` 或 `~/.codex/config.toml`，
cursor 为 `~/.cursor/mcp.json`，claude-desktop 为 macOS `~/Library/Application Support/Claude/claude_desktop_config.json`、
Windows `%APPDATA%\Claude\claude_desktop_config.json`）；`written` 表示配置里我们那一条已是本次服务的启动命令；
`warning` 为该客户端用不了这份配置的原因（目前只有 TRAE：官方要求 command 不含空格，路径含空格时为「安装路径含空格，TRAE 无法启动」），否则 null；
`snippet` 为可复制内容（claude-code 为 `claude mcp add -s user atelier -- …` 命令，codex 为 TOML，其余为
`{"mcpServers": {"atelier": {command, args}}}`）。启动命令只有一套判断：运行包经 `scripts/bootstrap.py --run`
启动适配器（包内解释器没有安装本项目），源码安装直接 `-m character_workflow.mcp`，参数末尾带 `--client <id>`。
`POST /api/connection/agent/client-config` `{client}` 把这一条写进该客户端配置：只增改我们那一条（Codex
`[mcp_servers.game-atelier]`，JSON 客户端 `mcpServers.atelier`，保留用户在这一条里加的其他键），写前备份为
`<文件名>.atelier-backup`、写后回读核对；开关未开 409 `AGENT_DISABLED`，`copy` 类客户端 422 `CLIENT_NOT_WRITABLE`，
配置目录不存在 404 `CLIENT_NOT_FOUND`，读不懂的配置 500 `CLIENT_CONFIG_INVALID` 且原文件不变。打开开关时仍顺手写 Codex
（装了才写）。开关打开时服务每次启动都把各可写客户端里已有的我们那一条改写成本次的启动命令，条目不存在不新建。
`POST /api/connection/agent-sessions` 的 `client` 接受上述六个宿主名。
`tools` 为 `{name: string, billable: boolean}[]`，与 MCP 注册共享工具元数据，使用真实的 `canvas_*` 工具名；
只有生成工具标为计费。该字段是展示信息，不改变授权机制：计费工具需先获得用户授权。
响应只返回路径和元数据，不包含凭据内容或 token。

`GET /api/connection/status` 返回 `{ service: "game-atelier", instance_id, app_version, protocol: "atelier-local/2" }`。
instance 是每次启动的 32 位小写十六进制标识，不是访问凭据；app_version 从插件 manifest 读取。
响应 `Cache-Control: no-store`，不读取用户配置或数据；不能据此跳过鉴权，旧 null 协议不被新前端继续使用。

P1b 对全部路由先校验实际监听 Host、精确 Origin 与浏览器 Fetch Metadata；地址不符返回 421
`HOST_DENIED`，来源不符返回 403 `ORIGIN_DENIED`。错误为
`{ error: { code, message, request_id } }`，不回显来源或密钥，并设置 `Cache-Control: no-store`。
当前鉴权覆盖业务 API、媒体、SSE 与内部文档；本地 cookie / Agent bearer 不得混用。

SSE（`GET /events`）事件：`job-changed` `image-added` `canvas-document-changed` `team-library-changed`。
`team-library-changed` 为 `TeamLibraryChangeEvent = {library_id, asset_id, kind, author, change, title, status,
mime_type}`，`change ∈ added | updated | removed`，`status ∈ ready | incomplete`；`removed` 事件的 `title` /
`status` / `mime_type` 为 `null`。`added` 的语义是「这条资产第一次可用」：新出现的条目，以及已有条目从
`incomplete` 变 `ready`（网盘 / SVN 分批同步，`asset.json` 先到、成片后到）都发 `added`；其余变化（改标题 /
标签、`ready` 退回 `incomplete`）发 `updated`。前端分享提醒只对 `added` 弹。由 watcher 盯挂载目录发出：任何变化触发 2 秒防抖后的全量重扫，再按索引 diff
逐条广播（隐藏目录不触发）；分享 / 编辑 / 撤回 / 重扫接口在同一请求内走同一个刷新（`refresh_team_library`），
不等防抖。**首扫静默**：没有上一份索引（挂载后首扫、缓存被删）时整库都会算成 added，此时不广播任何事件。
server 启动建好监听后对每个库各起一条后台线程补扫一次（可达判定也在该线程里，死网盘挂住只挂住它自己）：
有旧索引只广播停服期间的增量，没有就静默建索引；某个库挂住只挂住它自己的线程，失败记日志，都不影响其他库与启动。
同一个库的并发刷新只串行「读旧索引 → 写新索引 → 广播」，扫描本身不持锁；开扫更早的结果若晚于更晚开扫的
结果落盘则作废，不会覆盖索引或广播假 `removed`。
`canvas-document-changed` 由 watcher 盯
`canvases/<project_id>/canvas.json` 发出（`{project_id, revision}`），浏览器保存与 Agent 经 MCP 的
`canvas_apply_changes` / `canvas_import_media` / `canvas_run` 都会触发；画布编辑器按 `revision` 判断
忽略 / 直接重载 / 提示「重新载入（放弃本页改动）」，保存撞 409 走同一动作。
本地写入需要编辑租约（设置 / 授权管理除外），Agent 只可调用已授权的画布工具。
未知 API 默认 `CAPABILITY_DENIED`，未认证返回 `CONNECTION_REQUIRED`；不存在匿名原生业务旁路。
开发来源登记与导航例外见连接契约。

## 双端同步点

改左边必须同步右边，反之亦然。没有代码层共享，只有约定 + 守卫。

| 契约 | Python | TypeScript | 守卫 |
|---|---|---|---|
| LocalConnectionStatus | `viewer_server/connection_status.py` | `web/src/schema/connection.ts` | `tests/test_connection_status.py` |
| LocalConnectionBoundaryError | `viewer_server/request_boundary.py` | `web/src/schema/connection.ts` | `tests/test_local_request_boundary.py` + `api/http.test.ts` |
| 本地会话 / Agent grant / 编辑租约 | `viewer_server/connection_routes.py` | `web/src/api/connection.ts` + `api/agentGrants.ts` | `tests/test_local_connection_auth.py` + `api/connection.test.ts` |
| Job / JobParams | `lib/schemas.py` | `web/src/schema/jobs.ts` | 无 —— 靠人 |
| Key / ModelSpec | `lib/keys.py` | `web/src/api/keys.ts` | 无 —— 靠人 |
| ModelRoute | `lib/model_routes.py` | `web/src/api/models.ts` | `tests/test_model_routes.py` + `lib/modelRoutes.test.ts` |
| CanvasProject / CanvasDocument / CanvasJobContext | `lib/schemas.py` | `web/src/schema/canvas.ts` + `schema/jobs.ts` | `tests/test_canvas_projects.py` + `CanvasEditor.test.tsx` |
| CanvasUiPreferences | `lib/schemas.py` | `web/src/schema/canvas.ts` | issue 20 隔离 API/文件/浏览器契约核对（旧测试只读，不改） |
| CreationAsset / CreationAssetContent | `lib/schemas.py` | `web/src/schema/creationAssets.ts` | `tests/test_creation_assets.py` + `CreationAssetPanel.test.tsx` |
| 图像能力矩阵 | `callers/openai_image.py` | `lib/modelFamily.ts` `referenceLimits.ts` `studioSize.ts` | `tests/fixtures/capability-matrix.json`，两端各自断言 |
| 视频控件能力 | 各 `*_video.py` | `lib/videoControlCaps.ts` | 无 —— 靠人 |
| 插件清单 / 包锁文件 / 列表接口 | `lib/plugin_manifest.py` + `lib/plugin_registry.py` | `web/src/schema/plugins.ts` + `api/plugins.ts` | `tests/test_plugin_registry.py` + `PluginsPage.test.tsx`（后者直接读入库的 `manifest.lock.json`） |
| 插件包摘要算法 | `plugin_manifest.package_digest` | `web/scripts/build-plugins.mjs` 的 `canonical` | `scripts/check_product_plugins.py`（Python 复算入库产物的摘要） |

给序列化 model 加字段会打红全仓精确字典断言，改完立刻跑全量 pytest + vitest。

## Job 字段所有权

`WebEditableJobPatch` = `extra="forbid"`，只有两个字段：`prompt`、`params`。其余一律 Skill / job_runner 独占，Web 改不了也不该试：

- 状态机：`status` `error` `error_code` `submitted_at` `completed_at` `progress_phase`
- 产物：`output_paths`
- 归属：`character_id` `canvas_project_id` `namespace` `kind` `studio_agent_session_id` `studio_agent_turn_id`
- 路由：`alias` `provider` `model` —— 换模型只能新建 job（`POST /studio/jobs`），不能改已有的
- 血缘：`retry_of` `source_image`；创作台归档血缘写在 `params.archived_from_job_id / archived_from_path`

`error_code`（2026-11-25）是失败分类码，取值 `insufficient_balance` / `invalid_key` / `model_unavailable` / `content_rejected` / `timeout` / `submission_unconfirmed` / `network` / `bad_endpoint` / `service_unavailable` / `unknown`（`schemas.JobErrorCode` ↔ `schema/jobs.ts`）。`job_runner` 写 `error` 时同时写（`_fail` / `_error_code`：先看异常类型与 HTTP 状态，再按报文关键词），写别的 `error` 或清空 `error` 时一并清掉；`error` 为空时接口不返回它。落盘位置是 `params._error_code`（读盘时搬回顶层），不进项目包：旧版顶层拒收未知字段，数据须可被旧版读取（ADR-0030）。前端只用它选文案与修复动作（`lib/errorPresentation.ts` 的 `presentJobError`），不参与换家与重发判断。`service_unavailable` 只给前端连接层用，runner 不写。

`POST /api/studio/jobs` 手动提交图片或视频时，可传顶层字段 `studio_agent_session_id`，格式沿用 `CanvasAgentSessionId`。格式无效返回 422，指定的普通会话不存在返回 404。传入有效 ID 时保存会话归属，省略时会话字段留空，查询时计入默认会话。手动任务的 `studio_agent_turn_id` 始终为空。

`POST /api/studio/jobs` 可带 `client_request_id`（`<UTC YYYYmmddHHMMSS><8 位十六进制>`，一次提交意图一个，重试沿用）：任务 ID 取 `job-<client_request_id>`，同一 ID 再发返回已建的任务，不再下单、不再排运行。回包途中断开时前端先 `GET /api/studio/jobs/by-request/{client_request_id}` 核对（有则返回任务，没有 404），查到就接上原任务，绝不自动重发。`POST /api/studio/jobs/{job_id}/requery` 把上游已有任务号的失败任务放回 `pending` 续查（判据同服务重启后的续查 `is_resumable_studio_job`），没有可续查的任务号返回 409。

`run_job` 处理 Studio / Canvas 提交的任务。外部 Agent 仅通过 Canvas 工具访问已授权项目。

`JobParams` = `extra="allow"`（加字段不会被上游拒），但**双端仍要同步声明**，否则 TS 那边拿不到类型。Studio 在新建 Job 时可写 `estimated_cost_cny`，它是按当次 Key 渠道、模型与参数冻结的人民币预计总价；OpenRouter 等返回账单用量的 caller 可写 `actual_cost_cny`，历史优先实际费用、其次预计快照，缺失时不用当前 Key 重算。提交方没写预计时（画布、Agent、创作台「自动」），job_runner 在调用厂商前按实际渠道、模型与参数用 `generation_pricing.estimate_cost_cny` 补写；TokenDance 渠道的模型若不在价格快照里（运行中刚加到供应商），先补拉这个模型的价格再估；按字符计费的语音另写 `billed_characters`（上游回报的计费字符数，与朗读文本字数口径可能不同）；「自动」换供应商时清掉旧预计按新渠道重算。后端独占写入的还有 `actual_size`、`warnings`、`requested_size`、`provider_task_protocol`、`provider_task_ids`、`video_submission_attempts` —— 前端只读不写。任务 ID 必须在首次轮询前落盘；Tuzi 支持重启续查，Seedance（`provider_task_protocol=seedance`）保留订单供核对，不自动恢复或重新提交。

异步视频提交诊断位于 `params.video_submission_attempts`（每单最多四项；判据见 `callers/task_submission.py`，所有异步视频协议共用）：`attempt`、`method`、`url`（去掉凭证、query 与 fragment）、`started_at`（UTC）、`elapsed_ms`、`http_status`、`request_ids`（只取白名单响应头）、`error_type`（网络异常类名）、`outcome` 与可选的 `not_sent`。提交前记录 `submitting`，收到响应记录 `response`；连接建立后的网络中断、5xx、无法解析或取不到任务号的成功响应标为 `unconfirmed`（不换家）。连接都没建立（连接被拒、DNS 失败、连接超时）时 `outcome` 保持 `submitting` 并记 `not_sent: true`：请求确定没发出，「自动」可换下一家，无家可换按普通失败、扣 0（2026-11-19）。不给 `outcome` 加取值是为了让旧版仍能读这份记录（ADR-0030）。不保存请求正文、授权头、图片 Base64 或原始网络异常文本。504 等错误说明“提交结果未确认”，不自动重提。Windows 复测后提供数据目录 `.runtime/jobs/<job_id>.json` 即可核对记录；无须提供 `.config/keys.json`。这些诊断不进入复用配方，新订单不继承。

Canvas 节点媒体设置新增的显式参数也遵循同一契约：图片 `background` 只允许
`auto | opaque | transparent`，并只向已验证的 GPT Image 直连协议发送；Seedream 5.5 界面给
「背景：自动 / 透明」，只保留并发送 `transparent`（自动 = 不发，由提示词决定），火山直连、TokenDance、Tuzi 都发，
OpenRouter 的 `/images` 描述符没有该参数故不给开关，「自动」路由须每个成员都支持。2026-11-13 实测 `transparent`
不写提示词也出 RGBA，`opaque` 能压过提示词里的「透明背景」。视频 `watermark`
为 bool，只在 Seedance / HappyHorse capability 开启时写入 Snapshot 与厂商请求。

Midjourney 的 `mj_sref`、`mj_cref`、`mj_oref` 均为图片路径数组（每组最多 4 张），分别归属风格、角色、Omni 语义槽；垫图仍写入通用的 `reference_images`。编号式风格参考写入 `mj_sref_code`（只存数字），它与图片式 `mj_sref` 互斥且优先级更高。个性化 Profile code/ID 写入 `mj_profile`（1–64 位 ASCII 字母或数字），caller 统一拼为 `--profile <value>`。Web 创建 job，caller 只负责校验结构化参数、把本地路径转公网 URL 并拼接对应 flag。

`namespace` 含 studio / canvas / assist：前两者分别落在 `studio/<job_id>/` 和 `canvases/<canvas_project_id>/outputs/<job_id>/`，canvas 任务必须带项目与冻结执行上下文；assist 是「AI 帮我配置」的对话调用记录（`kind=text`、无产物、直接写成终态），只进用量（类别「接口配置」），不进创作台、画布与模型耗时统计。

## 端点

写操作按「谁有权」分组。全部前缀 `/api`，服务绑死 `127.0.0.1`。

生成历史（仅本机编辑器）：

- `GET /history?kind=all&q=&cursor=&limit=60` 返回 `{items,next_cursor}`。每个条目对应一份仍有原件的 Studio 或画布产物（DONE、PARTIAL），按提交时间降序、同轮产物原顺序排列。游标由服务端返回，最后一页为 null。按完整提示词搜索，沿用画廊的路径和项目隐藏设置。
- 条目包含 `job_id,output_index,kind,url,thumbnail_url,filename,width,height,duration,text_preview,prompt,submitted_at`。序号沿用任务稳定产物序号，时长单位为秒，未知元数据为空。提示词最多 120 字。
- `POST /history/download` 接受 `[{job_id,output_index}]`，单项返回原文件，多项返回 ZIP，同名文件加序号。
- `DELETE /history/{job_id}` 请求体为非空稳定序号数组。只回收所选产出，选中全部剩余产出时回收整轮并归档用量。画布项目继续持有原件和完整路径登记；整轮回收后，项目按归档的任务核验版本媒体和导出包的归属。返回 `{trash_id}`，撤销调用回收站还原接口。
- 图片缩略图 URL 带源文件的修改时间与大小版本，`width` 向上取 256、512、1024 档。版本匹配时允许浏览器私有长缓存。

`GET /gallery/recent` 的 Studio 作品以 Job 登记为准：仅收录 `namespace=studio`、
`kind=image`、状态为 `done` 或 `partial` 的 `output_paths`，且文件必须存在于 Studio
目录内并为支持的图片扩展名。目录残留文件不自动成为作品，也不从目录名推断任务链接。
部分成功任务保留成功产物；隐藏、收藏与评分规则继续生效，不依据图片颜色判定失败。

Studio 作品总是混入。画布作品由 `/config` 的 `show_canvas_on_home` 控制（默认 true，关掉后不混入）（`source: "canvas"`，带 `canvas_project_id`，`character_id / project_id / asset_slot` 为 null）：
只取画布上图片节点的**当前版本**且来源为生成任务（`origin.kind == "job_output"`）的图，
上传的素材、被换掉的候选、已删除节点的图都不算；`hidden`（打码）的节点不取，判据与画布项目封面一致。
`GET /gallery/image` 相应放行 `canvases/<project>/outputs/**` 下的图片扩展名，上传目录不放行。

**本机页面写入**
`POST /prompt/{job_id}` `POST /uploads` `POST /studio/jobs`

参考路径必须位于允许的数据根范围，否则返回 422。

`POST /keys` `PATCH /keys/{alias}` `DELETE /keys/{alias}` `POST /keys/models-preview`
`POST /config` `POST /gallery/{hidden,favorites,ratings}` `POST /data-root` `POST /folder-picker`
`POST /onboarding/events` `POST /onboarding/key-probe`
`POST /clipboard-attempt`
`POST /jobs/{id}/{confirm,cancel}` `DELETE /jobs/{id}` `DELETE /jobs/{id}/image`
`POST /canvas/projects` `PATCH /canvas/projects/{id}` `PUT /canvas/projects/{id}/document`
`POST /canvas/projects/{id}/agent/sessions` `DELETE /canvas/projects/{id}/agent/sessions/{session_id}`
`POST /canvas/projects/{id}/uploads` `POST /canvas/projects/{id}/media-operations`
`POST /canvas/projects/{id}/image-edits`
`POST /canvas/projects/{id}/runs` `POST /canvas/projects/{id}/runs/{reverse-prompt,text-revision,image-edit,angle,layer-decomposition}`
`POST /canvas/projects/{id}/runs/{run_id}/cancel`

`POST /canvas/projects/{id}/groups/{group_id}/run-plan` 返回按连线和位置排序的 `order`、`steps`（节点名、模型、数量、估价）、`total_cny`、`unpriced`、`quote_id` 和 `needs_confirmation`。`blocked` 列出不完整草稿及原因，`cycle_nodes` 只列成环节点。每个可执行草稿提交一次，张数按节点设置（MJ 固定 4）。整体执行把候选登记为原节点的版本，首个结果成为当前版本，下游提交时冻结上游当前版本。Job 快照的 `normalized_params.group_run` 记录组执行 ID 和执行前的版本 ID，供历史切换与界面同步。

`POST /canvas/projects/{id}/groups/{group_id}/group-runs` 接受 `order`、`total_cny` 和 `quote_id`，计划过期或已有同组执行返回 409。`GET /canvas/projects/{id}/group-runs` 读执行记录，按创建时间倒序。`POST /canvas/projects/{id}/group-runs/{run_id}/resume` 继续失败或中断的执行，`/cancel` 停止后续提交。进度落盘后 SSE 广播 `canvas-group-run-changed`（`project_id`、`run_id`）。
`POST /creation-assets/prompts` `POST /creation-assets/media/{upload,from-path}`
`POST /creation-assets/generation/{from-job,from-canvas}`
`PUT /creation-assets/{asset_id}/{prompt,media}`
`POST /creation-assets/{asset_id}/use` `POST /creation-assets/{asset_id}/readopt` `DELETE /creation-assets/{asset_id}`
`POST /canvas/projects/{id}/creation-assets/{asset_id}/{insert,reproduce}`
`PUT /profile`
`POST /team-libraries` `DELETE /team-libraries/{library_id}`
`POST /team-libraries/{library_id}/rescan`
`POST /team-libraries/{library_id}/assets/{entry_id}/adopt`
`POST /team-libraries/{library_id}/share`
`PUT /team-libraries/{library_id}/assets/{asset_id}` `DELETE /team-libraries/{library_id}/assets/{asset_id}`
`PUT /team-libraries/{library_id}/specs/{team,categories/{name}}`
`POST /canvas/projects/export` `POST /canvas/projects/import/{inspect,commit}`
`DELETE /canvas/projects/{id}`
`PUT /canvas/ui-preferences`
`PUT /accent-themes`
`PUT /ui-prefs/{key}`

**只读**
`GET /jobs` `/jobs/{id}` `/config` `/keys` `/onboarding/status` `/onboarding/metrics` `/data-root` `/ui-prefs`
`GET /gallery/{recent,hidden,favorites,ratings,image}` `GET /raw`
`GET /canvas/projects` `/canvas/project-options` `/canvas/projects/{id}/document` `/canvas/projects/{id}/jobs`
`GET /canvas/projects/{id}/versions/{version_id}/media`
`GET /canvas/projects/{id}/versions/{version_id}/download`
`GET /creation-assets?kind={prompt,media,generation}` `/creation-assets/{asset_id}/content`
`GET /creation-assets/{asset_id}/inputs/{order}` `GET /creation-assets/{asset_id}/staleness`
`POST /creation-assets/staleness`（只读：id 列表放不进查询串才用 POST，不需要编辑租约）
`GET /profile` `GET /team-libraries?project_id=` `GET /team-libraries/related?project_id=&sha256=`
`GET /team-libraries/{library_id}/assets?kind&author&tag&q&cursor&limit`
`GET /team-libraries/{library_id}/assets/{entry_id}/{content,thumb?w=}`
`GET /team-libraries/{library_id}/specs`
`GET /canvas/projects/{id}/agent/sessions` `/canvas/projects/{id}/agent/sessions/{session_id}`
`GET /canvas/ui-preferences`
`GET /accent-themes`

`GET /api/team-libraries?all_mounts=true` 返回全部 `TeamLibraryView` 挂载记录，不按库去重，
保留每条记录的 `project_id` 与 `mount_path`，供控制台按画布统计。默认 `all_mounts=false` 且省略
`project_id` 时继续按 library_id 去重；传入 `project_id` 时只返回该项目挂载（即使同时传 all_mounts）。
空字符串 project_id 仍为项目过滤，不扩大为全局查询；无效布尔值返回 422。

`GET /canvas/projects` 的 `CanvasProjectSummary` 在项目元数据之外返回派生的 `cover`、`node_count` 与
`connection_count`；这些字段不进入 `project.json`，必须与当前 `canvas.json` 一致。

`GET /canvas/project-options` 只返回 `CanvasProject` 基础元数据，供编辑器内项目切换器使用；它不会读取每个项目的
完整 `canvas.json`，避免打开画布时随其他大画布的体积产生额外解析开销。

### 人工画布契约

画布是 Web 用户人工创建、人工编排的独立创作空间，Skill 不创建项目、不填充节点，也不推进整张图。
文件系统真源为 schema v2 `canvases/<id>/project.json` 与 revision 化 `canvas.json`；资源字节放
`uploads/`，确定性工具产物放 `derived/<operation_id>/`，生成产物按 job 放 `outputs/<job_id>/`。

Canvas 媒体只按项目内不可变 `version_id` 读取，不接受裸路径：

- `GET /api/canvas/projects/{project_id}/versions/{version_id}/media`：同源内联预览，固定安全 MIME、
  `nosniff`，不可变私有缓存。可选 `?w=` 是**这张图会被显示成多宽**（已含设备像素比），不是想要的位图
  尺寸：服务端向上取到固定档位 256 / 512 / 1024 后返回缓存的 WebP 缩略图，`image/webp`。原图本身更小、
  是动图、非图片、或 `w` 超过最大档位时照发原图——缩略图纯属优化，不改变可见内容，也没有失败态。
  缓存落在 `.runtime/canvas-thumbnails/<project_id>/`，不进项目目录（导出包会按 `content_versions`
  逐一核对项目目录里的文件）；缓存键是不可变的 `version_id` 加档位，因此永不失效。
- `GET /api/canvas/projects/{project_id}/versions/{version_id}/download`：附件下载，服务端生成安全文件名。

旧的 `/content/{version_id}` 路径已删除，不保留兼容分支。

画布的错误响应统一走 `{code, message}`（message 中文，给画师看；code 稳定，给前端分支用）：
`CanvasRunCommandError` / `CanvasMediaReplaceError` / `CanvasDocumentError` 都是这个形状。
状态码的划分是**谁能修**：客户端提交的内容不合规 → 422；revision 被别处改过、刷新后重试有意义
→ 409；画布存档文件不见了或记着别的项目 ID（`CanvasStorageError`）→ **500**，因为这是服务端
数据完整性故障，重试永远不会成功，而前端的 409 文案写着「刷新后重试」。
`canvas_runs` 里那批英文断言是后台管线的内部不变式，不作为 HTTP detail 返回；它们经
`job_runner._friendly_error` 加一句中文前缀后落进 `job.error`，原文保留以便定位。
`CanvasDocument` 保存 viewport/settings、九类稳定节点、两类连接与不可变 `content_versions`。运行时只接受
`schema_version: 2`，不包含 v1 union、fallback 或 converter。
客户端在所有视口共用同一份 revision 化 Document；响应式面板、焦点、选择与媒体预览都是本地呈现状态，
不会进入 `canvas.json`。预览媒体仍只通过已登记 `version_id` 读取，不从节点或 Job 拼接裸路径。
文本节点的 `data.display.scale` 只接受 Atelier 字阶 token `xs/sm/base`，缺省为 `sm`；字号切换属于
Document 显示状态并参与 revision 与 undo/redo，不修改文本 Content Version。图片/视频继续使用
`data.display.fit/free_resize`；视频和音频播放进度、音量与控件焦点只属于浏览器呈现状态，不落盘。
图片节点可保存 `data.annotation = { version_id, elements, visible, rendered_version_id, markup_version_id }`，无提示词字段。
`version_id` 固定原图；`rendered_version_id`（合成图）与 `markup_version_id`（只含标注的透明 PNG 标注层）都可空，
非空时必须是本项目拥有且尺寸与原图一致的图片，标注层还必须是 `image/png`。两者由浏览器各自按需合成、各自独立失效。
`visible` 默认 true；显示还要求 `version_id == current_version_id`，切版本仅隐藏。标注修改使合成版本失效，
删除全部元素写 null。视频及其他节点不得带 annotation。原图不被覆盖，也不创建独立标注节点。
元素类型为 `rect/arrow/freedraw/text`，共用 `id`、`color`，拒绝未知字段。最多 500 个、JSON 不超过 2 MiB。
颜色限定 `#F04438/#FACC15/#22C55E/#3B82F6/#FFFFFF`。矩形保存 `x/y/width/height/stroke_width`，
箭头保存 `start/end/stroke_width`，画笔保存 `points/stroke_width`（2–10000 点），文字保存
`x/y/text/font_size/background`（1–500 字，background 默认 false）。坐标为有限原图像素，绝对值不超过 100000。
线宽 1–24、字号 12–72 使用基准单位：实际像素 = 值 × max(原图宽, 原图高) / 1024。
节点、全屏和 PNG 合成共用 SVG 渲染器，原尺寸原图从版本媒体接口读取，不把图片字节写入 JSON。
Input Connection 新增 `annotated: boolean = false`，仅允许图片来源且 `slot` 必须为空。
带标注输入默认解析为来源的 `annotation.rendered_version_id`（合成图），不同时发送原图；显隐不影响输入。
来源标注清空、切换到无标注版本或合成图缺失时拒绝提交。
目标 Draft 的模型支持 GPT Image 2.6 能力且渠道走官方 `/images/edits`（`canvas_runs.uses_annotation_markup`：
provider 为 openai/custom 且协议为 openai；OpenRouter、局域网网关、订阅都不透传）时改为「原图 + 标注层」：
输入解析为 `annotation.version_id`，Snapshot Input 记 `markup_version_id`，服务端把标注层绝对路径写进
`job.params.markup_image`（服务端独占路径字段，浏览器两个入口都丢弃，`/api/raw` 按 job 放行）。
带标注层的输入固定排到第一位（官方要求标注层与首张输入图同尺寸），且只允许一条；缺标注层或多于一条时拒绝提交。
发送形式记在连线上：Input Connection `annotation_delivery: "markup" | "composite" | null`，仅 `annotated` 连线可带；
缺省或 `markup` 在目标支持时发标注层，`composite` 固定发合成图。界面入口是生成面板里带标注参考图的角标菜单，
只在目标有 2.6 能力时出现；结果回连继承该值。提交前浏览器总是准备合成图，连线可能走标注层时再多准备一张标注层。普通输入仍解析当前版本，分组展开保持普通输入，
同一来源既直连又在组内时以直连标记为准。Snapshot Input 同样保存 annotated，结果回连接续标记。
「去改图」仅上传隐藏合成版本、创建图片生成节点与 annotated 输入，预填「按图中标注修改，输出不保留标注。」；
不提交 Job。普通和批量提交前自动重新合成失效标注；合成版本派生写入不占撤回历史。
跨画布粘贴同时复制并重映射 version_id/rendered_version_id，项目包保留两份图片与标注关系。
画布外观属于作者可撤销的项目设置：`settings.background` 明确选择空白、点阵或线框，
`settings.show_image_info` 控制图片节点是否展示当前不可变 Content Version 的真实宽高与文件体积。
`settings.show_minimap` 控制中等及桌面视口的小地图；手机端始终隐藏。三者随普通 Document revision 保存并
参与 Web undo/redo；图片详情 Dialog 始终保留完整 metadata，不受节点信息条开关影响。
媒体 Content Version 的 `path` 始终相对当前画布项目目录；资产库与提示词使用 revision 化 sidecar，插件
私有状态使用带 plugin id/version 的独立 envelope，不把这些业务对象塞回热路径 `canvas.json`。

Canvas Agent 会话属于画布项目，文件真源为
`canvases/<project_id>/agent/sessions/<session_id>.json`。每个 Session 使用独立 revision 与单调
sequence，只保存可见消息、reasoning summary、稳定 node/version 引用和非敏感 token usage；
不允许 API Key、token、环境变量、裸本地路径、data URL 或隐藏思维链。
`POST .../agent/sessions` 由用户创建空会话，GET 列表会隔离单个损坏文件并返回
`corrupt_session_ids`；`DELETE .../agent/sessions/{session_id}` 必须携带 Session `If-Match`，冲突零写入。
项目包导出严格验证 Session schema/文件名/项目归属；导入新项目保留 session/message ID
与会话历史，只重写 `project_id`。当前打开会话、panel 宽度、焦点和流式临时态属于浏览器呈现，
不进入 Session 或 `canvas.json`。

Agent 每次调对话模型都在 `.runtime/agent-usage/YYYY-MM.jsonl` 追加一行
`{ time, project_id, session_id, alias, model, provider, source, input_tokens, output_tokens, cached_tokens, cost_cny, cost_source }`（只有统计字段，不记提示词与对话内容），
按请求计价（`estimate_text_cost_cny`），`cost_cny: null` 为未计价；`cost_source` 为 `price_table` / `host` / null。经局域网网关（provider=atelier）的请求由主机结算，本机记 null、`source: "lan"`、`cost_source: "host"`；每轮对话带 `X-Atelier-Call-Tag: <session_id>:<会话 revision>`，轮次结束（含失败、停止）后台查 `/gateway/v1/me?call_tag=`，查到后追加一行 `kind: "host_settlement"`（token 记 0、`cost_cny` 为主机结算额），会话合计与用量页的经网关金额只取这些行。查不到（主机不可达、还没写完用量）的标记存在 `.runtime/agent-usage/pending-host.json`，下一轮结束或读会话用量时补查，超过 1 天放弃；旧主机不回 `call_tag` 字段时放弃补查，界面保持「主机结算」。
只追加不替换，追加在文件锁内一行写完；读取跳过解析不了的行并在日志里记跳过数。画布或会话删除后记录保留，用量页显示「已删除的项目」「Agent 对话：已删除的对话」。
不记成 Job（/api/jobs 每个任务文件约 60µs，随 Agent 使用线性变慢）。`GET .../agent/sessions/{session_id}/usage`
返回会话累计 `{ requests, input_tokens, output_tokens, cost_cny, unpriced, source }`，`cost_cny` 只合计有价格的请求；
`GET /api/usage?scope=mine` 与 `/api/usage/tasks` 把这些行按会话、日期、模型合成 `kind: "text"` 的记录。
`GET / PUT /api/canvas/agent/settings`（仅本机页面）读写 `{ confirm_above_cny }`（0–10000，默认 10，存 `.config/canvas-agent.json`）：
Agent 本次生成估价加上本轮已提交的估价超过它时，Auto 下也停在待确认；估价与界面模型菜单同源，未计价不拦。
`run_generation` 待确认摘要第二行为「模型 · 预计 X¥」或「模型 · 未计价」，超过时第三行写「超过确认金额 X¥」。
`run_generations`（批量，1–20 项、每项 1–4 张）在 Auto 下按本轮累计估价判断，未计价的项不计入合计、也不单独拦；
待确认摘要首行「批量生成 N 项，共 M 张」，每项一行「序号. 节点标题 · 模型 · 张数 · 预计 X¥ / 未计价」，
末行「合计预计 X¥（K 项未计价）」或「合计未计价」，超过时再加「超过确认金额 X¥」。这段文字只在逐项数据拿不到时整段显示（只能整条执行或拒绝），并作为待确认的摘要落盘。
`GET .../agent/sessions/{session_id}/approvals/{call_id}/items`（仅本机页面）返回 `{ confirm_above_cny, turn_estimate_cny?, items: [{ index, node_id, title, model | null, count, estimate_cny | null }] }`，只对会话当前待确认里的 `run_generations` 调用有效，否则 404；不落盘，每次请求按当时的 draft 与价格现算（同一批待确认的 set_draft 计入），等待期间 draft 改过时以现算为准。面板按勾选重算合计、未计价项数与是否超过确认金额。执行后面板的记录每项一行标「已提交 / 已拒绝 / 失败：原因」，末行「已提交项合计」用执行那一刻现算的估价，不复用卡片上的数。
`POST .../agent/sessions/{session_id}/approvals` 的每条决定可带 `items`（批量生成里勾选执行的下标，至少一项，
不带即全部执行；只对 `run_generations` 有效，否则 422）。工具结果逐项给 `status`：`submitted`（带 run_id）/
`rejected`（用户在确认卡上拒绝）/ `failed`（提交时出错，带 error；未预期异常也逐项记成 failed，已提交项的 run_id 照常返回），部分成功不回滚。同一 `surface_node_id` 在一批里只能出现一次：两次提交会落进同一个结果节点并发写入，所以整批按 `INVALID_PARAMETERS` 退回给模型、不弹确认卡（同一节点要多张用 count）。摘要里每项的节点标题与模型名去掉换行、各截到 40 字。网关额度在任务运行时按任务逐个准入，
已提交的项也可能在运行时因额度用完失败。
`POST .../approvals` 先认领再执行：在会话锁里把 awaiting_approval 改成 running、清空待确认后才执行，并发的第二个裁决返回 409（`SESSION_BUSY`），执行过的调用不会再执行。执行中出现未预期异常时，该调用的输出为「错误（UNEXPECTED）：执行时出现未预期错误（异常类型），这个操作可能已经部分生效……不要重试」（只写异常类型，不带异常原文；堆栈只进日志），面板显示「执行出错，可能已部分生效，请查看画布」，其余调用照常执行，会话照常 running 续跑；Auto 下同样不再让整轮失败。认领后进程退出的会话在下次读取时标成 interrupted，历史里没有输出的调用补上「服务中断，这个操作已中断、结果未知，可能已经部分生效……不要重试」。
一轮结束时模型最后一次响应既没有文字也没有工具调用（各协议的空结束：Chat 的 stop 空内容、Responses 只有 reasoning、Anthropic 的 end_turn 空内容）：末尾的空输出不写进历史；这一轮没执行过工具时会话落 `failed`，error 为「模型没有返回内容，可以重试或换个模型（别名 / 模型 · 输出 n token，其中思考 m）」，可直接再发消息继续；执行过工具（含确认后续跑时确认的那一步）时照常 `idle`，加一条 `role: "system"` 的面板消息「模型没有补充说明」，不进历史。都不自动重试。
`update_plan`（不改画布、不弹确认）：Agent 写本会话的待办，最多 12 条 `{ title（1–80 字）, status: pending | in_progress | completed }`，每次整份替换，存 `canvases/<project_id>/agent/plans/<session_id>.json`（`{ schema_version: 1, items, updated_at }`，不进 CanvasAgentSession，删会话时一起删，不随项目导出包），写完推 SSE `canvas-agent` 事件 `kind: "plan"`。`GET .../agent/sessions/{session_id}/plan`（仅本机页面）返回这份待办，没写过或文件读不出时为 null，会话不存在 404。
`wait_for_runs`（只读，1–20 个 run_id，去重后按给的顺序）一起等到终态，最长 240 秒；每项返回 run 视图并带 checks，查不到的 run 带 `lookup_error`，`counts` 按状态计数。附图最多 4 张：总数不超过 4 时全附，否则每个 run 只附第一张、取前 4 个 run，`note` 列出没附图的 run；视频联系表也只给前 4 个有产物的 run 做。

主题色是工作区应用级状态，文件真源为 `.config/accent-themes.json`（桌面版与浏览器共用；浏览器 localStorage
`atelier:accent` 只缓存一份镜像供首帧上色，以服务端为准）。`GET /api/accent-themes` 返回
`{ schema_version: 1, revision, active, overrides, custom, updated_at }`；文件不存在时返回 revision 0、`active: "lime"`
的默认值且不制造文件；损坏或不符合严格 schema 的文件返回 500，原字节保持不变（PUT 同样拒绝，不覆盖）。
`PUT /api/accent-themes` 请求为 `{ expected_revision, active, overrides, custom }`：`overrides` 键只能是 7 个内置主题 id
（lime / violet / orange / cyan / pink / yellow / blue），值为 `{ primary, brand2, brand3, brand4, name? }`（name 只在内置主题改过名时有值，否则为 null）；`custom` 为用户主题
`{ id, name, primary, brand2, brand3, brand4 }`，id 形如 `u-` + 8–32 位小写字母数字，最多 24 个；颜色一律 `#RRGGBB`；
名称去首尾空白后 1–12 字，所有主题的生效名称（内置主题取改后的名称或默认名）互不重名（忽略大小写）；`active` 必须是内置 id 或某个用户主题 id。
不合规 422；revision 不符 409 `{ code: "revision_conflict", current_revision }`。服务端在文件锁内校验 revision 并原子替换。

深浅色模式与品牌图标「黑白 / 彩色」只存在本机浏览器的 localStorage（`atelier:theme`、`atelier:brand-icons`），
不进 `.config/accent-themes.json`，没有服务端接口：按设备生效，桌面版与浏览器各记各的。`atelier:brand-icons` 取值
`mono` / `color`，缺省（含旧版本没有这个键）按 `mono`。彩色只换有彩色版的内置品牌（lobe-icons `*-color.svg`），
按人工判定的名单在对应主题下退回单色（亮色：openrouter；暗色：aws、baidu），另一主题照常彩色；名单与判定都在
`web/src/components/brandColors.ts`。上传的自定义图标与供应商遮罩图标不受这个选项影响。

画布界面与生成偏好是工作区应用级状态，文件真源为 `.config/canvas-ui.json`，不属于任何画布项目。
`GET /api/canvas/ui-preferences` 在文件不存在时返回 revision 0 的默认值且不制造文件；损坏或不符合严格
schema 的文件返回 409，原字节保持不变。`PUT /api/canvas/ui-preferences` 请求为
`{ expected_revision, image_toolbar, generation_defaults, upscale }`。`image_toolbar` 的工具 ID 必须来自固定枚举，
不允许重复但允许空清单；`generation_defaults` 严格包含 text/image/video/audio 四项，每项只保存可选的
`{ alias, model }` 与该模态白名单参数；`upscale` 为 AI高清偏好 `{ tiers: { 2K, 4K, 8K } }`，每档 `{ selection, quality, prompt }`：
selection 为 null 时服务端自动选模（只有 2K / 4K 有自动路线），quality 只对暴露质量档的模型生效，
prompt 留空保存即恢复内置提示词（服务端填回全文，GET 永远返回实际生效的提示词）；缺失的档位按默认值补齐。媒体引用、蒙版、本机路径、运行回写字段和跨模态参数一律 422。
服务端在独立文件锁内校验 revision 并原子替换，冲突返回当前 revision。生成偏好只影响后续新建 Draft；
模型保持自动选择时仍独立应用该模态默认参数。失效的显式模型回退首个 Runner 可路由
模型且不继承旧参数，已有节点、Run Snapshot 与 Job
保持不变。该偏好跨项目生效，但不进入 `CanvasDocument`、undo/redo、项目 revision、项目包 manifest/zip
或插件私有状态；凭证、Base URL 与模型目录仍只属于 Keys。

画布连接为 `role: input | material`，均以实线呈现。`Input Connection` 表示当前参考输入，不触发下游；只有 input 进入参考列表、输入解析和批量依赖。`Material Connection` 只含 `id / role / source_node_id / target_node_id`，两端须为图片节点，不带 slot，表达本地处理的素材来源，不自动追溯取图。两种角色可在同一对节点间共存。历史真源仍是 Job Snapshot 与 Content Version origin，不创建历史派生边。普通生成不引用节点自身的当前内容；基于本图生成通过下游节点与 input 明确输入。
生成面板仅展示当前素材、提示词和生成设置，不展示“原任务输入／本轮冻结输入”重复区块；删除展示不改变 Snapshot 与 Job 历史。
普通 `PUT document` 必须携带 `If-Match: <revision>`：服务端项目锁内校验后 revision + 1；冲突返回 409，不做自动合并。Web PUT 只能新增 `user_edit` 文本版本，不能写媒体版本、修改既有版本。输入连接可编辑，撤销/重做只改变画布节点与连接，必须保留全部已有内容版本；历史真实性不依赖当前连线。

上传接口使用 multipart `file + expected_revision`，服务端登记不可变媒体 Content Version 并返回更新后的
Document；扩展名只作入口白名单，文件类型、MIME、摘要、大小和图片尺寸均由服务端字节重算，伪扩展上传
直接拒绝。`canvas.json` 最大 25 MiB，单项目最多 10,000 节点 / 20,000 连接，单插件节点 payload 最大
256 KiB。媒体读取只收 `version_id`，不接受裸 path/job_id。Canvas Job 禁止通过通用 `/prompt/{job_id}`
修改快照、prompt 或参数。`POST /canvas/projects/{id}/runs` 只接受
`surface_node_id / expected_revision / requested_count`；服务端从已保存 Draft、连接与 Content Version
解析真实输入，冻结 `canvas_run.snapshot`，并用项目内短事务原子提交 Job、结果节点与实际输入连接。
Draft 的 `params` 两侧都按 mode 走白名单（`schemas.CANVAS_DRAFT_PARAM_FIELDS`）：`PUT .../document`
落盘前过一次，冻结 Snapshot 时再过一次，名单外的键一律丢弃。所有路径类字段
（`reference_images/videos/audios`、`mask_image`、`mj_sref/cref/oref`）与 caller 回写字段
（`actual_size`、`warnings`、`mj_flags`）都不在名单里 —— 浏览器不能提交路径，Canvas 的参考素材只能
来自不可变 Content Version。
整体执行逐个提交分组成员的生成草稿。分组整包连给生成节点时按目标模式过滤成员（图片生成只取文本与图片，音频生成只取文本），
`group.data` 只有 `member_node_ids`，一层显式成员关系保持不变。分组外框按成员显示边界派生，加载与实时合并使用同一规则；
`group.size` 为正有限数的 `CanvasGroupSize`，不受普通节点 `CanvasSize` 的 4000px 上限影响。
图片、视频等普通节点继续保留 4000px 尺寸上限。

- 节点 `active_run_id` 只在 run 进行中非空：finalize / failed / canceled 三条路径都清掉（内容节点与
  layer_stack 一致）。「最近一次生成」由 job 的 `canvas_run.result_node_id` 反查，不读该字段。

批量素材节点与批量执行（`batch-runs`）已删除。旧数据读取时按下列规则处理，不写回磁盘：
`batch_material` 节点按图片顺序换成普通图片节点（id 为 `<原id>-<序号>`，4 列网格、宽 320），原节点不在分组里时
再用沿用原 id 的同名分组装起来，在分组里时把分组成员换成这些图片节点；连到批量素材节点的连线删除；
内容节点的 `data.batch_result` 与 Job 的 `canvas_run.batch` 剥掉，带 `canvas_run.batch` 且尚未开始的 Job
记 `cancel_requested_at`，由 reconcile 取消，不在重启后提交。项目内 `.runtime/batch-plans/` 等文件不再读取。

图片节点的可选 `data.result_stack` 保存 `{run_id, member_node_ids}`：一次生成出多张时，本节点为封面，`member_node_ids` 是其余结果各自的图片节点（最多 64 个），`run_id` 是已拆成节点的那次生成。成员 id 不做文档级引用校验，读取方按存在过滤；跨画布粘贴时只保留一起粘贴的成员。

分镜节点是分镜插件（宿主插件，ADR-0038 / ADR-0039，默认关闭）的节点：`type: "plugin"`，`data.plugin_id = "storyboard"`，`data.node_type = "board"`，`data.payload = {ratio, style_prefix, entities[], shots[], script_node_ids[]}`。条目 `{id, kind: character|scene|prop, name, description, reference_node_id}`；镜头 `{id, scene, shot_size, camera, duration_s, visual, dialogue, entity_ids[], image_prompt, video_prompt, image_node_id, video_node_id}`。文档校验对 `payload` 只查 256 KiB 大小；形状由 `plugins/storyboard/server/storyboard.py` 的 `normalize_payload`（后端）与 `plugins/storyboard/host/canvasStoryboard.ts` 的 `normalizeStoryboardPayload`（前端）宽容读取，两端共用 `plugins/storyboard/tests/payload_cases.json`。插件关闭时节点显示占位，`payload` 原样保留。上限 120 镜、60 条目、每镜 20 个条目引用、8 个来源文本节点；时长夹到 1–60 秒。`payload` 里的节点 id 不做文档级引用校验，读取方只认当前文档内类型相符的节点。分镜节点不接连线。

时间线读取（给「视频时间线导出」用，纯函数，不是 HTTP 接口）：后端分镜插件服务端包里的 `storyboard.timeline(document, node)` 与前端 `storyboardTimeline(payload, findNode, resolveVersion)` 按镜头顺序返回 `[{shot_id, index, planned_duration_s, dialogue, video_node_id, video_version_id, duration_ms}]`。`video_version_id` 是镜头的 `video_node_id` 指向的视频节点的当前内容版本；节点不存在、类型不符或没有内容时为 `null`。`duration_ms` 取内容版本上登记的时长，生成出的视频目前不登记（为 `null`），需要调用方自己探测。两端共用夹具 `plugins/storyboard/tests/timeline_case.json`。

剧本解析（计费调用，只返回镜头草稿，不写画布）。三条都是插件路由 `POST /api/plugins/storyboard/routes/<path>`，请求体 `{project_id, params}`，成功时返回 `{result: ...}`；插件关闭时鉴权中间件按未声明路由拒绝（403），不加载插件代码：
- `/models`（read），`params = {}` → `{models: [{alias, model_id, name, max_cost_cny}]}`，候选是已启用密钥下的文本模型（含局域网网关提供的）；`max_cost_cny` 是解析一段的最高花费，没有价格时为 `null`。
- `/plan`（read），`params = {script_node_ids}`（1–8 个）→ `{total_chars, segments: [{index, chars, preview}]}`。不调模型；剧本只从已保存文档里的文本节点读，单段上限 8000 字，全文上限 120000 字。
- `/parse`（edit），`params = {script_node_ids, segment_index, segment_count, alias, model_id, entities: [{kind, name, description}], style_prefix}` → `{segment_index, segment_count, entities, shots, notices, usage: {input_tokens, output_tokens, cost_cny, job_id}}`。一次请求只解析一段，不带 tools；直连重发按 ADR-0044，整次操作只记一条用量；`segment_count` 与服务端按当前剧本算出的段数不一致时 409「剧本已变化」且不调模型。返回的 `entities` 只含新条目，`shots[].entities` 用名称引用；每段最多 80 镜。模型输出不可用时 422，上游失败 502，`detail = {message, code: "STORYBOARD_PARSE_FAILED", raw}`（`raw` 已遮掉密钥）。
- 每次调用（成功或失败）记一条 `namespace=assist, kind=text, output_paths=[]` 的任务，`prompt` 为「剧本解析 · N 字」，项目 id 记在 `params.assist_project_id`（`Job.canvas_project_id` 只给 `namespace=canvas` 用）；用量页据此归到该画布项目。

PS 联动插件（`ps-bridge`，宿主插件，ADR-0041，默认关闭，支持 macOS 与 Windows；Windows 常驻模式下不可用）。三条插件路由 `POST /api/plugins/ps-bridge/routes/<path>`，请求体 `{project_id, params}`（`/status` 可以不带 `project_id`，供设置页的状态区用）；`params` 只有下列字段（`extra=forbid`，不接受任何文件路径或脚本）。服务端让 Photoshop 执行插件里固定的 `server/atelier_ps.jsx`（macOS 经 `osascript` 的 `do javascript`，Windows 经 COM 的 `DoJavaScript`，只连已运行的 Photoshop），同一时刻只跑一个请求（第二个返回 409 `PS_BUSY`），超时写取消标记后返回 503 `PS_BUSY`：
- `/status`（read），`params = {probe?: bool}` → `{supported, unsupported_reason, installed, running, responsible_app, version, active_document}`。`probe` 为假时不和 Photoshop 说话（macOS 用 `lsappinfo`、Windows 用 COM `GetActiveObject` 判断是否运行，不触发自动化授权，也不启动 Photoshop）；为真且 Photoshop 在运行时读版本与活动文档名。`unsupported_reason` 在 `supported` 为假时给出原因（如「当前系统暂不支持 Photoshop 联动」、Windows 常驻模式下的「常驻模式下不能连接 Photoshop，请用桌面应用或启动器运行 Atelier」），否则为 null。`responsible_app` 是 macOS 自动化授权会记在其名下的应用，其他系统为 null。
- `/import`（edit），`params = {scope: "merged" | "layer"}` → `{node_id, title}`。取活动文档的合并可见内容或当前图层；有选区时按选区形状抠、裁到外接框，无选区取整张；落成普通图片节点，并在插件项目状态 `data.origins[<version_id>]` 记 `{document: {id, name, path, width, height}, bounds: [l, t, r, b], scope, layer, at}`（最多 500 条）。
- `/place`（read），`params = {node_id}` → `{document, layer, returned_to_origin}`。把图片节点置入 Photoshop 成为智能对象图层，图层名为节点标题；来源按顺序取：图片自己的 `origins` 记录 → 输入连线里恰好一张有记录的图片 → 无（放进活动文档中心，没有打开的文档时新建）。有来源时目标文档按名字与路径找，找不到返回 409 `PS_TARGET_NOT_OPEN`，不换文档。
- 第 2 批（ADR-0043）：`/settings`（edit，`params = {allow_scripts?: bool}` → `{allow_scripts}`，存 `.config/ps-bridge.json`，默认关）、`/execute-log`（read → `{entries: [{at, caller, project_id, document_id, code, ok, error, duration_ms}]}`，最近 20 条，新的在前）；只给 Agent 的 `/inspect`（read → 版本、文档列表、活动文档与最多 300 个图层）、`/preview`（read，`{document_id?}` → `{document, width, height, preview: {mime_type: "image/jpeg", data_base64}}`，长边 ≤ 1600、≤ 600 KB）、`/execute`（edit，`{code ≤ 3600 字, document_id?}` → `{value, documents, active_document, …}`；开关关着时 403 `PS_SCRIPTS_DISABLED`，每次记执行日志）。这三条清单里是 `agent_only`，浏览器经插件路由调不到。
- 错误码：`PS_NOT_RUNNING`（409）、`PS_NO_DOCUMENT`（409）、`PS_TARGET_NOT_OPEN`（409）、`PS_CANCELLED`（409）、`PS_BUSY`（409 / 503）、`PS_AUTOMATION_DENIED`（403）、`PS_BAD_IMAGE`（422）、`PS_TOO_LARGE`（413）、`PS_UNSUPPORTED`（501）、`PS_FAILED`（502）。

四模态均进入同一个 Job Runner：图片/视频沿用既有厂商协议；文本只接受明确可执行的
OpenAI-compatible `chat/completions` 或 `responses`，后者支持 `reasoning_effort`，其中 `auto` 只作为
Draft 选择且冻结/请求时省略；音频只接受 OpenAI-compatible `audio/speech`，冻结并发送白名单内的
voice/format、0.25–4 的 speed 与去除首尾空白后的非空 instructions。模型配置的 protocol 不匹配时明确
拒绝，不做伪兼容。所有连接输入按连接顺序冻结，`@[node:id]` 只引用、不筛选或重排，并在冻结前按
模型/协议校验媒体类型和数量。`@` 菜单只枚举当前 surface 的直接 incoming `Input Connection` 且已有
同模态 Content Version 的文本、图片、视频和音频；Draft 永远保存稳定 node token，不保存“图片1”等
显示标签或 Version/path。断开连接时 Web 同一事务删除对应 token，不展示失效引用；服务端仍拒绝绕过 Web
提交的异常 missing token，不能降级成普通文本。冻结后服务端按 Snapshot 实际输入顺序分别为文本、图片、视频、音频从 1 编号，重复 token 复用
同一编号；final prompt 的标签与 `reference_images/reference_videos/reference_audios` 各自数组顺序一致，
普通生成不存在隐式自身输入。专用编辑使用 `explicit_source` 标记明确的操作源；历史 `implicit_self` 仍可读取但不参与当前输入推断。非原生批量的图片候选按槽位执行，每个成功槽位立即通过短事务登记
Content Version、candidate 状态与首个成功主结果；Midjourney 原生四宫格仍保留单次请求再逐槽登记。

画布 Agent / MCP 的 `connect` 的 `slot` 还可为 `before` / `after`（仅对比节点）：未指定时先填 before 后填 after，指定已占用的一路则替换原连线。画布 Agent 的 `get_canvas` 在完整结果超过工具输出上限时返回概览（`overview: true`，按 `node_columns` 给出每个节点的 id/type/title/has_content/has_draft/group），仍超限时列出最新节点并给 `omitted_nodes`；可传 `node_ids`（1–20）读取指定节点的完整信息。

视频 Draft 的 `frame_mode=first|last|firstlast` 使用语义化 Input Connection：可选 `slot` 只能是
`first_frame` 或 `last_frame`，源节点必须是已有图片 Content Version，目标必须是视频生成节点，且同一
目标的每个槽位最多一条连接；同一图片允许同时占用首帧和尾帧。首尾帧模式拒绝普通素材连接，也禁止
`@[node:*]`；用户在提示词内输入 `@` 时，浏览器只在输入框内部给出简短提示，服务端再次拒绝；切换到
全能参考会删除槽位连接，服务端拒绝异常残留槽位，不能静默丢输入。提交时按实际槽位推导 wire `frame_mode` 和首尾图片顺序，不能由浏览器伪造媒体数组。
模型选择器只展示模型名；当前视频模式名后的帮助入口在 hover 时显示图片、视频、音频与混合上限。
素材区的 `+` 不打开候选菜单，而是进入画布点选状态，用户可移动画布并点击一个合法素材节点完成连接；
点选期间界面进入专注态：隐藏小地图/缩放、右上配置和底部主工具栏，在顶部显示“从画布选择参考”与退出
动作；合法素材节点 hover 时点亮边框，“选择 + 节点名”跟随光标移动，键盘聚焦时显示在节点起始位置。项目标题、节点、节点上方上传入口
与当前生成面板保持可用。点击空白画布不会退出，选择成功、按
`Esc` 或点击退出后恢复全部 Chrome。空媒体节点的唯一上传入口使用“上传附件”胶囊样式。
浏览器在选择阶段限制新增并阻止超限提交，服务端仍按模型协议重新核对单模态与混合总数。Canvas 不列出
只接受公网视频 URL、无法消费
项目内 Content Version 的 HappyHorse video-edit 模型。

批量候选逐个校验：全部成功为 `done`，部分成功为 `partial`，全部失败为 `failed`，
停止且没有有效产物为 `canceled`；部分失败不会抹掉已经成功的 Content Version。
失败后没有「按原任务重试」接口（2026-10-12 移除）：再次生成一律走 `POST .../runs`，使用当前草稿和实线。
新 Snapshot 同时冻结 `draft_prompt` 原始可编辑稿与 `final_prompt` 厂商提示词，仅作记录与复现用途。
`POST .../runs/{run_id}/cancel` 只持久化幂等 `cancel_requested_at`。Runner 尚未认领时不调用厂商并落为
`canceled`；同步厂商请求已发出时不伪装即时中断，UI 明示上游可能继续执行，有效返回仍登记，未返回候选
才标记 canceled。prepared 事务在下次项目访问或命令前完成/丢弃，不能从节点当前内容重造 Snapshot。
`POST .../runs/{run_id}/candidates/{candidate_id}/dismiss` 只允许隐藏 `failed/canceled` 槽位并写入
`dismissed_at` tombstone；Job、Snapshot、错误与既有 Content Version 均不删除，最新 tombstone 也不会让
同索引的旧失败槽位重新出现。
服务启动时先恢复全部项目事务，再核对孤儿 Job：`runner_started_at` 为空的持久任务尚未调用厂商，可安全
重新领取；已经领取但仍无终态的请求状态未知，明确标记失败且不自动重试，避免重复扣费。视频与
Midjourney 异步轮询会在每个间隔和下载前检查停止请求。进程内调度上限为同一密钥别名 6 个、同一画布
6 个，所有媒体类型共用这些上限，没有额外的视频串行或全局 4 个限制；HTTP 后台任务与重启恢复共用同一组门控。文本/图片允许候选批量，视频/音频固定单
结果。旧 `POST .../jobs` 已删除。

已有视频不再隐式成为输入，也不忽略用户实线。视频编辑使用显式视频来源连接，模型能力与首尾帧约束继续在提交前校验；结果不覆盖源视频。

`POST /canvas/projects/{id}/runs/reverse-prompt` 只接受 `surface_node_id + expected_revision`。服务端固定
`canvas.reverse_prompt` preset v1，优先全局 default Key、再按登记顺序选择首个 `modality=text`、
`input_modalities` 明确包含 image 且支持 OpenAI-compatible chat 的模型；浏览器不能传 preset、alias、
model 或媒体路径。Snapshot 冻结完整 preset 正文/版本、真实模型与唯一图片 Version，文本 caller 用
multimodal content 发送服务端解析的项目内图片。成功结果是独立文本节点及 实际输入连接，源图片
Draft 不读不改；停止复用普通 Run 生命周期。

`POST /canvas/projects/{id}/runs/text-revision` 接受 `surface_node_id + expected_revision + instruction`、
可选 `selection_start + selection_end`（Unicode 码点，必须成对且非空）与所选文本模型 `alias + model`（`alias`
为空 = 自动路由）。节点必须有非空正文且没有进行中的 Run。服务端把当前正文与指令冻结进 `final_prompt`，
Snapshot 记 `text_revision`（基准 Version、指令、选区）；结果节点 = 被改写的节点本身，不新建节点。有选区时
模型只返回片段，登记前拼回基准正文的选区位置，选区两端空白原样保留；登记时节点当前 Version 已不是基准
Version（改写期间被手改）则该候选失败、不覆盖。

普通文本 Run 可冻结并传输图片、视频和音频 Input Connection，但只认所选文本模型显式声明的
`input_modalities`，不按模型名称猜测能力。Chat Completions 在兼容端点分别使用 `image_url`、
`video_url` 与 `input_audio`；Ark-compatible Responses 分别使用 `input_image`、`input_video` 与
`input_audio`。本机媒体由 caller 编码后提交；模型虽声明能力但当前供应商协议没有对应传输格式时，
同样在创建 Run 前拒绝。两种拒绝都只显示一条短消息，不在画布增加常驻说明组件。
`POST .../runs/{run_id}/reverse-prompt-config` 在成功文本结果后幂等创建带生成设置的空图片节点（id `image-reverse-<结果节点>`）及文本→图片
Input Connection。图片模型优先使用仍可路由的画布图片生成偏好；偏好保持自动选择或显式模型失效时，
再按 default Key 优先、其余登记顺序选择。自动选择会应用已保存的默认参数，失效的显式模型不泄漏旧参数；
缺模型时保留反推文本且零写。重复请求即使携带旧 revision，也返回已经存在的同一配置，不重复创建节点或连接。

图片工具栏的“拆分图层”先在画布中创建一个 `layer_stack` 节点和一条图片输入连线，不调用厂商。未运行节点的
`source_version_id` 跟随唯一上游图片的当前 Version，替换或重新生成上游图片时同时更新节点预览与随源图比例计算的
初始尺寸；运行中及已完成节点冻结本次源 Version，历史产物不随上游变化。节点左侧展示源图，右侧保存用户选择的
`alias + model` 与可选提示词。`POST
/canvas/projects/{id}/runs/layer-decomposition` 只接受该节点的 `surface_node_id + expected_revision + alias + model`，
服务端还会核对请求选择与节点已保存设置完全一致。只接受火山直连或明确使用 Ark 协议的 Seedream 5.5 / 5.0 Pro / Flash，
绝不自动替换渠道或模型。比例固定为“智能”并继承输入图；分辨率默认 `auto`，可显式选择
`1K / 1.5K / 2K`。调用固定提交单张源图、`layer_decomposition=true`、节点保存的 `size`、
`output_format=png`、`response_format=b64_json` 与
`watermark=false`，不自动回退到其他渠道或普通生图。Seedream 5.5 另可在节点保存 `max_images`（含底图的最多输出张数，2–100，界面给 10 / 30 / 60 / 100，缺省由厂商默认 30），提交时冻结进 `params.layer_max_images`，caller 只对 5.5 发 `layer_decomposition_options.max_images`（Ark 文档：5.0 Pro / Flash 不支持）。提交与完成事务都复用原 `layer_stack` 节点；完成后把背景图
和全部透明 PNG（5.0 Pro / Flash 最多 16 张、5.5 最多 99 张）登记为不可变图片 Version，并保存厂商返回的 `z_index`、`name`、
`description`、`bounding_box`。底图使用普通 `job_output` 血缘，透明层使用带 `job_id + output_index` 的
`layer_decomposition` 血缘；媒体读取和项目包导入导出均校验该索引与 Job 输出一致。图层栈按绝对 bbox
重建原图，显隐只修改节点呈现状态，不改写产物字节或 Job 历史。

完成后的图层栈工具栏提供“下载全部图层”、“导出 PSD”和“展开图层到画布并分组”。三者均包含背景及隐藏图层，
顺序与右侧列表一致（按 `base_z_index` / `z_index` 自底向上），不包含原始源图或合成预览。前两者调用
`GET /canvas/projects/{id}/nodes/{node_id}/layers/download?format=zip|psd`（缺省 zip），复用本地会话与媒体归属校验。
ZIP 文件名带顺序号及安全化图层名，保留原始图片字节。PSD（5.49.0）以背景尺寸建 8 位 RGBA 画布，每层按
`bounding_box.absolute` 的左上角放置（图片尺寸与框不一致时缩放到框），图层名写入 Unicode 名块（旧式 MacRoman
名字段固定为 `layerN`），隐藏层写为不可见；PSD 由服务端重新编码像素，不保留原始字节。未完成返回 422，缺失节点/文件返回 404，
越权媒体返回 403，未知 format 返回 422；任一文件不可用时不输出缺图的文件。临时文件在响应完成后清理。
“展开”在一次可撤销的文档编辑中创建图层素材的图片编辑入口及一个 Group。普通素材默认按原尺寸
的三分之一等比展示，短边目标至少 48（不放大超过原图），高度上限 280、宽度上限 920；极端比例优先守上限。
最多四列、宽素材跨列并优先填充短列，排列在原节点右侧并避开已有内容。背景通过 `base_material_node_id`、
透明层通过 `layers[].material_node_id` 绑定图片节点；一个编辑入口只归属一个素材。
重复展开重新整理同一素材组并定位，不重复创建图片；布局一致时只定位，不新增编辑记录。
部分入口被删除后，再次展开复用剩余入口并补齐缺项。图片预览容器跟随节点高度，不施加额外最小高度；
高度不足 96 或宽度不足 160 的图片不叠加尺寸徽标，详情中仍保留原图参数。
图层素材归属从已有绑定派生只读实线，并保留父图层定位入口；不另存连接副本，绑定字段、共享版本与编辑同步保留，不参与生成输入或流程依赖。
素材替换、候选切换及单结果编辑（裁剪、抠图、放大、图片生成）同步更新父图层的版本和合成显示；
本地单结果编辑复用节点，响应 `created_node_ids` 此时返回被更新的节点 ID。多结果“切图”仍创建独立派生结果。
背景首次绑定时固定 `layout_size` 为原背景像素尺寸，后续素材按原 bbox 等比容纳，不改变合成坐标。
Version 不可变、历史保留；分组只管理布局。删除编辑入口保留父图层最后版本并清除绑定，删除父节点
不会删除素材图片。原图层显隐不影响编辑入口可见性，下载始终读取同步后的当前版本。

图片局部修改与扩图使用独立 `image_edit` 节点：原图 → 编辑节点 → 结果图片，均为 `material` 实线。
额外参考图只保存在编辑配置中，不增加画布连线；新节点在源图右侧避开已有节点排列。
它不是 Content Node，不参与普通参考输入解析或普通生成浮层，也不会隐式把原图传给下游。
`POST /canvas/projects/{id}/image-edits` 使用 multipart `payload` JSON + 可选 `mask_file` 保存配置，
返回 `{document,node_id}`。payload 包含 `expected_revision`、更新时的 `node_id`、创建时的
`source_node_id/source_version_id`、`generation_draft`、`options`、`editor_state` 和可选
`reference_node_id/reference_version_id`。保存允许未选择模型、未绘制选区，不创建 Job、不调用厂商。
节点固定源图/参考图 Version；原节点换版或删除不改变已保存内容，删除后关联节点 ID 可为空。
`editor_state` 保存源图像素坐标下的画笔/橡皮/矩形笔迹、画框与比例；不保存视图缩放和撤销栈。
`options` 保存模式（`inpaint` / `outpaint`）与扩框几何，不重复保存源版本。
蒙版为不可变项目 Version，内容相同时可复用；不传蒙版表示清空选区。不得传媒体绝对路径、凭证或订单状态。

`POST /canvas/projects/{id}/runs/image-edit` 使用 JSON `surface_node_id / expected_revision / requested_count`，
只从已保存的编辑节点冻结 Job 与 Snapshot。编辑必须指定渠道，不使用自动路由；空提示词采用自然修复/延展。
运行前重新校验选区、固定媒体版本与模型能力。局部修改和扩图均接受 EvoLink MJ 与兼容通用编辑模型，按渠道/协议/型号分流；不支持的模型返回 422。
每次生成新增结果节点，不覆盖旧结果。
运行中保存草稿不改已提交快照；`active_run_id` 为服务端独占。普通文档 PUT 不得伪造编辑运行状态或源版本绑定。
项目包包含尚未生成的编辑节点及全部源图/蒙版；跨画布粘贴复制固定媒体版本并重写蒙版来源，清空运行状态。
旧 `runs/mask-edit` 接口移除，不保留即时提交旁路。

局部蒙版为与 EXIF 归一后源图同尺寸的单帧 PNG，透明或灰度 0 表示编辑、255 保留，空选区拒绝。
扩图由服务端生成新区域蒙版，目标框必须完整包含原图，不把源图透明区域当作新增区域。
图片编辑任务完成后 `params.edit_inputs`（`role`: source / mask / guide / reference，`path`）记录实际发给厂商的图片，`params.edit_prompt` 记录完整提示词；两者只由服务端写，`/api/raw?job_id=` 放行这些路径。
扩图蒙版的 origin 标记 `expanded_canvas=true`，宽高不得小于源图；普通局部蒙版仍要求源图同尺寸。
归一蒙版登记为内部不可变 `user_mask` Version；Job、Snapshot、结果节点及编辑→结果素材实线在同一可恢复事务提交。
Snapshot 保存 `mask_version_id`、源版本、可选替换参考和 `normalized_params.image_edit` 几何参数。
结果始终另建节点（包括图层素材），不覆盖源版本，不创建蒙版节点或历史关系线。

通用编辑模型用于局部修改与扩图，按供应商/协议/型号筛选：支持独立 mask 协议的 GPT Image 使用 edits；兼容的 Seedream、Nano Banana
等使用干净底图与独立区域引导图，不伪装成原生 mask。局部修改引导图为白编辑/黑保留蒙版，扩图保持新增区域着色引导。
通用局部修改对选区做向内 1–8px（按源图短边自适应）的羽化，不扩大编辑范围；最终合成 PNG 保留保护区解码 RGBA；输出比例偏差超过
2% 拒绝，同一比例的分辨率差异等比映射。编辑尺寸以画框为准，禁止 AUTO 改变编辑边界；蒙版保护只能保证
改动范围，不能证明生成内容和接缝质量。2026-10-16 HK GPT 2.5 Flare 与 Tuzi Nano Banana Pro 各一个简单样例通过，
不能推断所有渠道/复杂场景均已验收。MJ 原生编辑不经过通用合成，不使用通用羽化策略。

#### EvoLink MJ V8.2

Key `provider=evolink`、模型 `mj-v8.2`、协议 `evolink`，API 根地址为 `https://api.evolink.ai/v1`。
普通生图使用 `POST /v1/images/generations`，固定 Fast / Standard，每次返回最多 4 张；不把派生动作 ID 当作普通模型。
画布编辑节点选择该模型时，使用 `mj-v8.2-upload-paint`，接受任意项目内原图，无需既有 MJ 订单。
不接收额外替换参考图；原图保持不变，输出登记为关联结果节点的候选版本。
源图经 EXIF 转正后通过 EvoLink 临时文件服务上传；源尺寸蒙版从内部白保留/黑编辑转换为不透明黑保留/白重绘 PNG data URI。
扩图用目标 `canvas` 和原图尺寸 `img_pos`，允许改变画布比例，不拉伸原图；内部仍保存源图尺寸的全白保留蒙版。
`evolink_state` 是 runner 独占状态，保存渠道指纹、提交不确定标记、订单、终态结果地址与查询暂停信息。
收费 POST 前先落盘 uncertain，取得 ID 后立即记录 `provider_task_protocol=evolink` / `provider_task_ids`。
不确定提交绝不自动重发；已知 ID 只续查 GET，已完成但下载失败只恢复下载。
查询暂停记录 `evolink_state.poll_paused`，结果节点显示“继续查询”：
`POST /canvas/projects/{id}/runs/{run_id}/resume-mj-edit` 接收 `expected_revision`，只续查已知订单，不重新下单。
新订单与配方复用必须去掉 `evolink_state`，浏览器不能伪造或改写。
`POST /canvas/projects/{id}/runs/{run_id}/resume-mj-edit` 接收 `expected_revision`，只恢复未取消、已有可靠订单 ID
且结果节点未改动的中断任务；复用原 Job/选区/动作，仅续查，不创建新订单。显式 CLI retry 则是新的待确认任务，
清空 MJ 订单、输出映射、不确定提交与续查状态。详情可按住对比原图，并按需显示选区。

`POST /canvas/projects/{id}/runs/angle` 只接受 `surface_node_id / expected_revision / requested_count` 与
`horizontal_angle(-60..60) / pitch_angle(-45..45) / camera_distance(1..10) / wide_angle`。服务端优先全局
default Key、再按登记顺序选择首个支持至少一张参考图的图片模型；浏览器不能传自由 prompt、alias、model
或媒体路径。服务端固定 `canvas.angle_edit` preset v1，把当前图片 Version 作为唯一 Snapshot input，完整
机位参数、preset、真实 provider/alias/model 和受控最终 prompt 一并冻结。结果始终是独立图片节点及一条
实际输入连接。

`POST /canvas/projects/{id}/runs/upscale` 只接受 `surface_node_id / expected_revision / target(2K|4K|8K)`。服务端先校验
源图长边小于目标长边（2048 / 4096 / 8192，否则 422 `canvas_upscale_not_needed`），再按 `ui-preferences.upscale.tiers[target]` 选模型：
固定了 selection 就只用它（可以是任何画布可运行、吃参考图的图片模型，MJ 除外），失效返回 422 `canvas_upscale_model_stale`；
未固定时只有 2K / 4K 有自动路线——在 quality 可调的 Nano Banana 基础型号里挑（默认 Key 优先、同一 Key 内 Pro 优先，
未设 quality 时 2K=medium、4K=high），8K 或无可用型号返回 422 `canvas_upscale_model_missing`。
分辨率按模型族取：Nano Banana / OpenRouter 用比例（取渠道支持列表中最接近源图的一档）加该档 quality 或分辨率档；
按像素出图的模型（gpt-image / seedream / standard）按档位长边等比算出 WxH 走自定义尺寸，再套模型自身上下限
（超出上限会被压回，如 seedream 8K 实际 4096²），比例不合法返回 422 `canvas_upscale_size_invalid`。提示词取该档
`prompt`（preset id 仍为 `canvas.upscale` v1），
把当前图片 Version 作为唯一 Snapshot input 冻结为 n=1 的图片 Run（`normalized_params.upscale_target` 记录档位）；结果是
独立图片节点及一条实际输入连接。浏览器不能传 prompt、alias、model 或其他参数。

`POST /canvas/projects/{id}/upscale/estimate` 是 AI高清菜单的纯估价：请求 `{ surface_node_id, targets: (2K|4K|8K)[] }`（1–3 档），
响应 `{ estimates: { [target]: number | null } }`（元，与 `/api/pricing/estimate` 同口径）。与 `runs/upscale` 共用
`_plan_upscale_unlocked`（源图作为一张参考图、档位尺寸、模型与自动路由解析），不建任务、不计费、不推进路由轮转；
某档提交会被 422 拒绝（无需放大、未配模型、尺寸不合法）或无价格时该档为 null，项目或节点不存在返回 404。

`POST /canvas/projects/{id}/media-operations` 只接受当前图片节点和不可变源 Version ID，并以
discriminated union 执行 `crop`、`split` 或本机模型 `remove_background`。服务端用 Pillow 校验真实格式、摘要、静态帧、
EXIF 方向与 64MP 上限，统一输出剥离元数据的 RGB/RGBA PNG；切图限制 2–12 行列且每块最短边至少 16px。旧文档里的 `upscale` origin 记录仍可读取，但浏览器不再能发起本地重采样放大。`remove_background`
无参数：固定用 BiRefNet-general-lite（MIT，onnxruntime CPU/CUDA/DirectML 按可用挑）在本机推理，源图透明度与
预测掩码相乘后输出 RGBA PNG，origin 记录 `model` id；模型文件由 `GET/POST /canvas/matting-model` 查询与
下载到 `<data_root>/.config/models/`（sha256 校验），未下载时操作返回 422 `canvas_matting_model_missing`；
onnxruntime 只在有 wheel 的平台安装（Intel Mac 排除），缺失时状态回 `available=false` + `message`，下载返回 422 `canvas_matting_unavailable`，
抠图的处理时限为 180s（其余操作 60s）。一次命令在
项目级串行、全局最多并发 2 个；全部输出先写 staging，校验总块数与体积后原子移动到
`derived/<operation_id>/` 并提交 Document。若进程在移动后中断，下一次项目访问按事务摘要完成提交；恢复不
重跑图片处理。冲突为零写，源文件永不覆盖；独立产物创建源图片到结果图片的 material 连接，图层素材原位编辑不创建自连接。一次 split 的结果节点和素材连接作为一个画布历史
命令撤销/重做，Content Version 与字节继续保留。裁剪/切图参数校验分别固定返回
`canvas_media_invalid_crop` / `canvas_media_invalid_split`，无法识别的请求或放大参数返回
`canvas_media_invalid_request`；解码、规模、源不一致、revision 冲突、处理资源与事务失败均返回带
`code/message` 的结构化错误。产物移动前的资源错误保证零提交；移动后的错误返回事务待恢复语义，
不谎报零变化，也不把 Pillow 或文件系统异常直接暴露为 500。

`POST /canvas/projects/{id}/nodes/{node_id}/replace` 允许 image/video/audio 节点用同模态文件填充或替换。
请求使用 multipart `file + expected_revision`；服务端校验真实 MIME、节点模态与 revision；已有内容时还要
校验当前 Version。命令创建新的不可变 upload Content Version，并只切换原节点 `current_version_id`。
空节点直接指向新 Version；已有节点的旧 Version 与字节继续保留，因此画布 undo/redo 只恢复指针，不重新
上传。跨模态、伪后缀、节点缺失、已有指针引用的 Version 缺失和 revision 冲突均为零写。
图片的 `display.free_resize=false` 让 React Flow resize 保持当前 Version 宽高比；切换只更新节点显示
状态，不修改 Content Version 的真实尺寸。

项目包使用 `game-atelier-canvas-v1.zip`：`manifest.json` 对每个 metadata/blob 记录 SHA-256、字节数、
MIME 与角色，项目内容放在 `projects/<package_project_id>/`，媒体放在
`blobs/sha256/<first2>/<sha256>.<ext>`。导入先调用 `inspect` 完成路径、链接、重复条目、压缩比、配额、
schema、摘要和项目内引用校验，再凭 30 分钟 token 调用 `commit`；commit 永远创建新项目，并重映射所有
全局 Canvas Job ID、Run ID、output path、retry/content origin 引用。node/version/connection
等项目内 ID 保留。包不包含凭证、全局 provider 配置、缓存、插件代码或运行中事务；存在 pending Job
时导出、导入和删除均返回 409。
导入与删除分别使用持久事务记录和固定锁序；服务启动时回滚中断的导入，并完成中断的永久删除。每 6 小时
维护一次过期或遗弃的导入 claim。

删除请求只携带当前 `expected_revision`。服务端在固定的 project→job 锁序下确认 revision 与 owned Job
均静止后，先把项目和 Job 原子移入 `.runtime/canvas-delete-transactions/` 的短期事务目录，再立即物理清除；
项目从索引消失后不可恢复。画布不提供回收区、撤销删除或恢复 API。

创作资产是应用级个人数据，真源为 `creation-assets/catalog.json` 与
`creation-assets/blobs/<sha256>.<ext>`，Studio 与所有 Canvas 共享同一资产身份。资产有 prompt / media
（media 覆盖图片 / 视频 / 音频）/ generation 三类，每个资产只维护一份当前内容；标题、标签、提示词正文/变量和媒体文件
均由同一个编辑入口原位更新。媒体按 SHA-256 去重，提示词重复只在 Web 提醒。提示词资产不携带模型或参数
（`recommendation` 已删除；创建 / 更新请求带它返回 422）。

`CreationAsset.use_count` 默认 0，0 时不序列化；每次 `mark_creation_asset_used` 在 catalog 锁内加一，
同时更新最近使用时间。`CreationMediaAssetContent.width/height` 是可选显示尺寸，图片入库时读取并计入
EXIF 旋转；未知时不输出字段，旧内容无须迁移，前端可按加载后的自然尺寸显示。视频尺寸不强求。

提示词效果图是 `CreationPromptAssetContent.preview_images` 的有序数组，第 0 张为封面；空数组不序列化。
每项为 `{file, mime_type, width, height, source_job_id?, source_model?, added_at}`，`file` 只允许
`[a-f0-9]{16}\.(png|jpg|webp|gif)`。文件独立保存到
`creation-assets/prompt-previews/<asset_id>/<file>`，不进入媒体资产或共享 blob。唯一写入者为
`creation_assets.py`，持 catalog 锁原子写入；内容哈希去重，删除提示词时清理全部效果图。

| 方法 | 路径（均带 `/api` 前缀） | 契约 |
|---|---|---|
| POST | `/creation-assets/{id}/previews` | multipart `files`，可多选；可选 `replace_file` 原子更换一张，满 8 张也可更换 |
| PUT | `/creation-assets/{id}/previews/order` | `{files: [...]}`，必须恰好包含全部现有文件、无重复 |
| DELETE | `/creation-assets/{id}/previews/{file}` | 删除元数据与文件 |
| GET | `/creation-assets/{id}/previews/{file}` | 读取当前 catalog 登记的独立原图 |
| GET | `/creation-assets/{id}/previews/{file}/thumb?w=` | 按 128/256/512 取档生成 WebP，运行时缓存放 `.runtime/thumbs/prompt-previews/` |

写入边界：最多 8 张、每张 ≤20 MiB、PNG/JPEG/WebP/GIF，校验真实图像格式与声明 MIME 一致。
不存在返回 404，不合规返回 422；这些接口要求本机会话，写操作要求编辑权限。图片响应为
`Cache-Control: private, max-age=31536000, immutable`，不扩展 `/api/raw` 白名单。
提示词文字编辑保留效果图；文件夹团队库分享和采用均复制独立效果图文件，见下文团队库契约。

生成资产 = 成片 + 自包含冻结快照：`content = {kind: "generation", media: CreationMediaAssetContent,
snapshot: GenerationRecipe}`。`GenerationRecipe = {mode, model, provider, alias, final_prompt, draft_prompt,
params, inputs, cost_cny, cost_basis, submitted_at}`；`cost_cny` 与 `cost_basis`（`actual | estimated`）同空同有。
`inputs[] = {order, role, kind, sha256, mime_type}`，`role ∈ reference | mask | mj_sref | mj_cref | mj_oref`，
`order` 按升序从 0 连续编号；参考本体同样按 sha256 进 blobs，不引用任何本机路径（不同于画布快照按
`version_id` 引用）。`GET /creation-assets/{asset_id}/content` 对生成资产返回成片；
`GET /creation-assets/{asset_id}/inputs/{order}` 返回第 `order` 份参考本体，prompt / media 资产、越界或 blob
缺失均为 404。生成资产插入 Canvas 只复制成片，快照不进画布。删除资产只清理不再被任何资产（含其他生成资产的
参考）引用的 blob。
上传上限按类型分档：图片 50 MiB、音频 100 MiB、视频 500 MiB；插入 Canvas 生成面板作参考素材仍只收
`image/*`。资产可物理删除，删除前必须显式确认，删除后不可恢复。

Canvas 的“本项目”是 CreationAsset 上的项目关系过滤，不是项目内第二套可编辑 sidecar。首次使用资产会
建立关系；删除画布会清理该项目关系。旧版
`library/assets.json` 与 `library/prompts.json` 在首次读取时幂等迁移，旧 HTTP library 端点已删除。

`POST .../creation-assets/{asset_id}/insert` 携带 Canvas Document 的 `If-Match`、目标坐标和可选变量值，
把资产当前内容复制为新的 Canvas Content Version；内容 origin 保存当时的资产标题快照，不保存可回写引用。Studio Job 的 `params.creation_asset_source_title` 同样只保存只读标题快照。
后续编辑或删除资产都不会改变既有节点、草稿或生成记录，也不存在更新引用 API。画布项目包只携带已复制
内容和来源标题，不携带个人资产库。

使用提示词资产时，变量保留为正文内的可填写槽位。槽位仅显示默认内容，不把变量名称加进可见占位文字；
名称保留为无障碍标签。用户未填写或仅填写空白时，生成使用资产默认内容；非空填写值优先。
草稿与 Canvas 文本版本的字符串使用 `@[variable:<encoded-json>]`；`encoded-json` 为
`encodeURIComponent(JSON.stringify({name, example, value}))`，三个字段均为字符串，`name` 非空，
`example` 是资产的 `default_value`，`value` 初始为空（插入 API 的显式 `variable_values` 可填写它）。
同名槽位的最终生效值必须一致。模板仍受 Canvas 字符串的 40,000 字符限制，编码槽位计入长度；超限拒绝，
不截断。此字符串随草稿/文本版本持久化，资产自身内容不变。

Studio 创建 Job 时仅对可选的 `prompt_template` 字段解析变量；未提供它时 `prompt` 是普通文本，
不按保留标记解析，确保已冻结 Job 再次生成不会递归解释用户字面量。提供模板时服务端以它的解析结果为准。
Canvas 合并草稿与上游参考文本并冻结生成快照时，服务端解析并单遍替换槽位，
只将填写值或默认内容作为 Job 提示词。填写值和默认内容均为空白、同名生效值冲突或格式损坏的保留标记
均返回 422，且不创建 Job。复制/导出正文同样使用填写值优先、默认内容兜底，不改写草稿或资产模板。
填写值本身不递归解释为槽位；Canvas 节点引用仍按原有编号规则冻结。前端可提前校验，但不能替代
服务端校验。

旧 schema v1 在 server 启动时一次性迁移到 v2：迁移前把完整 `creation-assets/` 和将被改写的 Job/
Canvas 文件复制到 `.runtime/backups/creation-assets/<UTC timestamp>/`；资产保留最新内容、恢复原归档项，
旧引用转成标题快照。Job 与 Canvas 分别在正式锁内完成完整 schema 校验后落盘；已被淘汰的旧图片版本
blob 只在备份完成后从活动目录清理。运行时永不读取该备份。

v2 / v3 在同一次启动中紧接着迁移到 v4（Skill CLI 等无 lifespan 的入口在读目录前补做同一步）：
v2→v3 资产种类 `image` 改名 `media`，v3→v4 删掉每条资产的 `recommendation` 键；内存里一次改写并按 v4
整表校验，通过才备份（`.runtime/backups/creation-assets/<UTC timestamp>/catalog.json`）并落盘，任何一条坏记录
都让原文原封不动。blob 文件不动。`image` 与 `recommendation` 均不保留兼容读法。

### 团队库契约

团队库是画师自己用 SVN / 网盘同步的共享目录，本机只读写目录、永不执行同步命令（ADR-0020）。

提示词团队条目的 `prompt.preview_images` 与索引 `preview_images` 均为有序效果图元数据，
缺省为空数组且空时不序列化；旧 `asset.json` 和旧索引不含此字段仍可读取、采用，无须迁移。
图片保存在该团队资产目录的 `previews/<内容哈希文件名>`，先写临时条目再整体改名发布。
索引扫描检查每张图都在该条目目录内，缺图或越界符号链接标记 `incomplete`；采用时重新校验
实际内容哈希、图片类型、尺寸、20 MiB / 8 张限制，旧 ready 索引不能绕过验证。
采用与重新采用由 `creation_assets.py` 在 catalog 锁内写入本机提示词独立目录；catalog 失败回滚新文件，
重新采用成功后清理不再引用的旧效果图，保持本机资产身份与项目关系。团队文件被删除不影响已采用副本。

`AdoptionOrigin.source_preview_fingerprint` 保存采用时来源效果图有序元数据的摘要，空值不序列化。
来源图片增删、换图、顺序或元数据变化均纳入 `stale` 判定，即使来源时间戳未变化；本机修改效果图
不会被误判为来源变化。旧采用记录缺少摘要时按原先无效果图处理。

`GET /api/team-libraries/{library_id}/assets/{entry_id}/previews/{file}/thumb?w=` 返回当前 manifest 登记
效果图的 WebP 缩略图（128/256/512 取档，缓存本机 runtime），要求本机会话与 read 权限；
`Cache-Control: private, max-age=300`。缺失、未登记或不完整条目返回 404；非法宽度返回 422。
团队卡片显示第一张封面，详情可切换多张图；提示词仍没有 `/content` 原文件接口。

挂载记录在 `.config/team-libraries.json`，显示名在 `.config/profile.json`；库内唯一会被写入的文件是
挂载时补的 `.atelier-library.json`（清单，含 `library_id`）。索引是本机缓存
（`.runtime/team-libraries/<library_id>/index.json` 与 `thumbs/`），可随时删除重建，绝不写进挂载目录。

提示词索引条目带可选 `prompt_text`（正文拼接，变量取默认值），供列表文字卡预览；
其他类型与旧缓存不带该字段，刷新索引后补齐提示词正文。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/profile` | — | `{display_name: string \| null}` |
| PUT | `/profile` | `UserProfile` | `UserProfile` |
| GET | `/team-libraries?project_id=` | — | `list[TeamLibraryView]`（`project_id` 可选） |
| POST | `/team-libraries` | `TeamLibraryMountRequest` | `TeamLibraryView` 201 |
| DELETE | `/team-libraries/{library_id}?project_id=` | — | 204 |
| POST | `/team-libraries/{library_id}/rescan` | — | `TeamLibraryView` |
| GET | `/team-libraries/{library_id}/assets?kind&author&tag&q&cursor&limit` | — | `TeamLibraryAssetPage` |
| GET | `/team-libraries/{library_id}/assets/{entry_id}/content` | — | 文件 |
| GET | `/team-libraries/{library_id}/assets/{entry_id}/thumb?w=` | — | `image/webp` |
| POST | `/team-libraries/{library_id}/assets/{entry_id}/adopt` | `TeamAssetAdoptRequest` | `TeamAssetAdoptResponse` |
| POST | `/team-libraries/{library_id}/share` | `TeamShareRequest` | `TeamLibraryIndexEntry` 201 |
| PUT | `/team-libraries/{library_id}/assets/{asset_id}` | `TeamAssetUpdateRequest` | `TeamLibraryIndexEntry` |
| DELETE | `/team-libraries/{library_id}/assets/{asset_id}` | — | 204 |
| GET | `/team-libraries/related?project_id=&sha256=` | — | `list[TeamRelatedEntry]`（`sha256` 可选） |
| GET | `/team-libraries/{library_id}/specs` | — | `{team: string, categories: Record<string, string>}` |
| PUT | `/team-libraries/{library_id}/specs/team` | `CanvasSpecUpdate` | `{saved: true}` |
| PUT | `/team-libraries/{library_id}/specs/categories/{name}` | `CanvasSpecUpdate` | `{saved: true}` |
| GET | `/creation-assets/{asset_id}/staleness` | — | `CreationAssetStaleness` |
| POST | `/creation-assets/staleness` | `CreationAssetStalenessBatchRequest` | `CreationAssetStalenessBatch` |
| POST | `/creation-assets/{asset_id}/readopt` | — | `CreationAsset` |
| POST | `/creation-assets/generation/from-job` | `CreationGenerationFromJob` | `CreationAsset` 201 |
| POST | `/creation-assets/generation/from-canvas` | `CreationGenerationFromCanvas` | `CreationAsset` 201 |
| POST | `/canvas/projects/{project_id}/creation-assets/{asset_id}/reproduce` | `CanvasReproduceRequest` + `If-Match` | `CanvasReproduceResponse` |

类别与团队规范（ADR-0031）：`TeamShareRequest` 与 `TeamAssetUpdateRequest` 带可选 `category`（1–24 字，
空 / 省略 = 不带类别；更新时省略即清掉），写进 `asset.json` 并出现在 `TeamLibraryIndexEntry.category`；
采用媒体与生成资产时副本沿用这个类别。团队规范读写挂载目录下的 `specs/`（格式见
`docs/team-library-format.md` §7），不设作者限制；库不可达 503，正文超 40000 字或类别名不合规 422，
目录写不进去 503。

`GET /team-libraries` 带 `project_id` 时只列该画布的挂载；不带时列本机全部挂载，按 `library_id` 去重，
每个库取库级端点选中的那条记录（见下）。分享对话框用不带参数的形式。

挂载（`POST /team-libraries`）与 `/folder-picker` 同属本机管理能力；列表、卸载、重扫、
读条目、采用照常按读 / 编辑能力放行。同一个库可以挂在多个画布上，库级端点取可达记录中最近挂载的那条
（全不可达时取最近挂载的），目录监听也跟着这条走。删画布时一并删掉它的挂载记录。

错误语义按「谁能修」分：没设显示名挂不了库，409 `{code: "profile_required"}`；显示名去掉首尾空白后为空，
422；挂载点不存在、或指向 data root / 其祖先 / 其内部任意目录，422；挂载目录当前不可达（清单读不到）503
`{code: "library_unreachable"}`，列表仍返回该库并标 `reachable: false`；这条资产现在不能采用
（没同步完整、内容与 `asset.json` 的 sha256 对不上、库内 `asset.json` 损坏）
409 `{code: "not_adoptable"}`；库 / 资产不存在 404。`limit` 由路由夹到 `[1, 200]`，非法 `cursor` 422。
挂载表自身损坏是磁盘状态故障，500 带上文件路径。本机创作资产库状态损坏（`CreationAssetStateError`：
目录数据坏了、blob 缺失）在全部接口——`/creation-assets` 各接口、保存为生成资产、画布复刻、团队库采用 /
重新采用 / 分享——一律 500 `{code: "asset_state_broken", message}`：服务端数据坏了，刷新重试修不好，
所以不用 409。

分享、编辑、撤回的错误码（`detail` 为对象时带 `code` 与 `message`）：

| 状态 | `code` | 场景 |
|---|---|---|
| 409 | `profile_required` | 本机没设显示名 |
| 503 | `library_unreachable` | 挂载目录当前不可达；或写到一半出 I/O 错误（磁盘满 / 没权限 / 掉线），`message` 带出错路径 |
| 404 | — | 库不存在；分享源（Studio job / 创作资产 / 画布项目、节点、版本）不存在或节点与版本对不上；编辑 / 撤回的资产不在库里 |
| 403 | `not_author` | 编辑 / 撤回别人的资产（作者 = `asset.json.author.display_name` 与本机显示名相同） |
| 413 | `refs_too_large` | 参考内容合计超过 200 MB，`detail.bytes` 为合计字节数；确认后带 `allow_large: true` 重发 |
| 422 | `not_shareable` | 源不可分享：非 Studio 记录、未完成、非图片 / 视频、`output_index` 越界；画布版本不是生成结果（`origin.kind != "job_output"`） |
| 422 | `source_missing` | 本机找不到成片或某份参考的文件 |
| 422 | `invalid` | 标题 / 显示名去空白后为空，或单个标签超过 40 字 |
| 422 | —（`detail` 为列表） | 请求体校验：标题超 120 字、标签超 20 个等长度 / 数量上限，FastAPI 标准格式 |
| 500 | `asset_state_broken` | 分享创作资产时本机资产库状态损坏（与 `/creation-assets` 接口同一映射） |
| 500 | `refresh_failed` | 已写入 / 已撤回，但重扫索引失败；`detail.asset_id` 指明是哪条，画师重新扫描即可 |

检查顺序为显示名 → 库存在 → 库可达 → 标题 / 标签 → 源。坏掉的 job 文件等本机数据故障不归入
`invalid`，按 500 报出。`TeamShareRequest.source` 为
`{kind: "job_output", job_id, output_index}`（`output_index` 是 `Job.output_paths` 的下标，只收
`namespace == "studio"`、`status ∈ done | partial`、`kind ∈ image | video`）或
`{kind: "creation_asset", asset_id}`（prompt / media / generation 三类都可分享）或
`{kind: "canvas_result", canvas_project_id, node_id, version_id}`（`version_id` 是该画布
`content_versions` 的键且必须挂在 `node_id` 上；版本 `origin.job_id` 指向的 Job 的 `canvas_run.snapshot`
是配方来源，参考只收媒体输入、蒙版记 `role: "mask"`，`origin.canvas_project_id` 记该画布）。成功后路由在同一请求内
重扫该库、按 diff 广播 `team-library-changed`，响应条目取自重扫后的索引（分享资产的条目 `id` 等于
`asset_id`，形如 `ta_<ULID>`）。编辑只改 `title` / `tags` / `updated_at`；撤回删掉整个资产目录，条目随之消失。

`GET /team-libraries/related` 是团队栏的「相关配方」：该画布挂载的全部可达库中 `kind == "generation"` 且
`status == "ready"` 的条目，跨库合并后按 `updated_at` 时刻降序取 20；不可达或尚未扫描的库直接跳过，
不报错。`TeamRelatedEntry = {library_id, library_name, entry}`，`library_name` 取该画布自己那条挂载的名字。
带 `sha256` 时（推荐 a：拖入团队原始文件、采用后用副本 `content.sha256` 查）只留 `entry.input_sha256`
含这份内容的配方，同样跨库合并、按时刻降序取 20。`input_sha256` 只有 generation 条目有值
（`snapshot.inputs[].sha256`，按 `order`），P3 之前的索引缓存由启动补扫 / 下一次重扫补上。

`GET /creation-assets/{asset_id}/staleness` 判断采用副本相对团队来源的状态：`fresh`（来源没变）、
`stale`（来源 `updated_at` 晚于采用时，或提示词来源效果图摘要变化；原始文件还要内容 sha256 真变了才算）、`withdrawn`（库可达、
已扫描但条目不在了）、`unknown`（不是采用来的、库没挂 / 不可达 / 没扫过、条目同步中）。资产不存在 404。
`POST /creation-assets/staleness` 是资产面板的批量版（`asset_ids` 1–200 个），每个来源库只读一次挂载与索引；
不存在的 id 不出现在 `statuses` 里。

`POST /creation-assets/{asset_id}/readopt` 用来源当前版本覆盖本机副本：内容、快照、标题、标签、`adopted_from`
跟来源走，`asset_id` / `created_at` / `project_ids` / `last_used_at` 保留，旧 blob 无人引用则删除。错误：

| 状态 | `code` | 场景 |
|---|---|---|
| 404 | — | 本机资产不存在 |
| 409 | `not_adopted` | 本机资产不是从团队库采用的 |
| 409 | `withdrawn` | 来源库可达、已扫描，但条目不在了 |
| 503 | `library_unreachable` | 来源库没挂载、不可达或还没扫过 |
| 409 | `duplicate_asset` | 新内容撞上另一条同来源 / 同内容的本机资产，`detail.asset_id` 指明是哪条 |
| 409 | `retry` | 写目录时新 blob 被并发删除，重试即可 |
| 409 | `not_adoptable` | 条目同步中、内容与 `asset.json` 对不上、库内 `asset.json` 损坏（与采用接口同一映射） |
| 500 | `asset_state_broken` | 本机资产库状态损坏（与 `/creation-assets` 接口同一映射） |

生成结果「保存为创作资产」存生成资产（带配方），与分享共用同一份配方来源规则（`generation_recipe`）：
`POST /creation-assets/generation/from-job` 收 Studio job 的 `output_index`（规则同 `job_output` 分享，
`project_id` 可选）；`POST /creation-assets/generation/from-canvas` 收画布结果版本（规则同 `canvas_result`
分享，`project_id` 取 `canvas_project_id`，请求体不收）。成片与参考按内容进 blobs。错误：来源不存在 404；
来源不可保存 422 `{code: "not_shareable" | "source_missing", message}`；标题去空白后为空 / 标签超 40 字
422 `{code: "invalid", message}`（在读来源之前校验）；本机资产库状态损坏 500 `{code: "asset_state_broken"}`；长度上限按
FastAPI 标准 422。坏掉的 job 文件、画布存档不见了（`{code: "canvas_document_missing"}` 等）是本机数据故障，
按 500 报出，不归入 `invalid`。

`POST /canvas/projects/{project_id}/creation-assets/{asset_id}/reproduce` 画布复刻：与 insert 同样携带
`If-Match`（缺失 428，非整数 422），一次画布锁内把生成资产展开成参考输入节点 + 带生成设置的空图片 / 视频节点 + 连线，
不自动 Run；响应 `CanvasReproduceResponse` = `CanvasDocument` 全部字段 + `warnings: list[str]`，并回
`ETag`。`warnings` 只在响应里，不落 `canvas.json`。只带 `role == "reference"` 的参考（`mask` / `mj_*`
跳过并写进 `warnings`）；视频配方 `frame_mode ∈ first | last | firstlast` 时图片参考按顺序接首帧 / 尾帧槽。
`model` 由前端匹配本机 key 后传入，传 `null` 时生成节点模型位留空。错误：revision 不符 409
`{code: "revision_conflict", current_revision}`；画布或资产不存在 404；非生成资产、配方拼不出合法草稿 422；
参考 blob 缺失 500 `{code: "asset_state_broken", message}`（本机数据完整性故障，重试无用）；画布存档本身坏了 500。

`GET /team-libraries/{library_id}/assets/{entry_id}/content` 与 `thumb` 同属媒体路由（缓存策略由路由自带）。

`TeamLibraryIndexEntry.kind` 为 `generation | media | prompt | raw`：前三种来自
`shared/<作者>/<asset_id>/asset.json`，`raw` 是库内直接摆着的媒体文件（`id` 为
`"raw_" + sha1(relative_path)[:24]`）。`prompt` 没有文件本体，`content` 与 `thumb` 一律 404。
`generation` 条目额外带 `model`（模型 id）与 `cost_cny`（快照里的花费，可空），其余种类两者为 `null`。
采用永远是拷贝——落进个人创作资产库并记 `adopted_from`，本机对象不依赖库内路径；
同一条团队资产重复采用返回既有资产且 `created: false`。`raw` 条目只按内容 sha256 去重（路径不变、
内容被同步更新后再采用会得到新副本），命中既有资产时把这次的 `project_id` 补进它的 `project_ids`。

分享资产的目录布局为 `shared/<作者目录>/<asset_id>/`：`asset.json`、成片本体、图片成片的
`thumb.webp`（最长边 ≤ 512，视频不生成）、`refs/NN-<sha256 前 12 位>.<ext>`（`NN = order + 1`）。
先写同级 `.tmp-<asset_id>/` 再整体改名，撤回先改名成 `.tmp-del-<asset_id>/` 再删；扫描跳过点目录。
`asset.json` 为 `TeamAssetFile`（`team_asset_version: 1`，读取时忽略未知字段，版本不是 1 的条目标
`incomplete`）；生成资产的 `snapshot` 结构：

```json
{
  "mode": "image | video",
  "model": "gpt-image-2",
  "provider": "tuzi",
  "alias": "tuzi-main",
  "final_prompt": "…",
  "draft_prompt": null,
  "params": {},
  "inputs": [
    {"order": 0, "role": "reference | mask | mj_sref | mj_cref | mj_oref",
     "kind": "image | video | audio", "sha256": "<64 hex>", "mime_type": "image/png",
     "path": "refs/01-<sha256 前 12 位>.png"}
  ],
  "cost_cny": 0.3,
  "cost_basis": "actual | estimated",
  "submitted_at": "2026-09-23T01:00:00Z"
}
```

`params` 只留 `JobParams` 的声明字段并去掉路径 / 费用 / 运行态字段；`inputs` 按 `order` 升序且恰为
`0..n-1`；`cost_basis` 与 `cost_cny` 同时为空或同时有值。`origin = {job_id?, canvas_project_id?}` 只作追溯。
采用时转成本机 `GenerationRecipe`（去掉 `inputs[].path`，参考内容按 sha256 进 blobs）。

### 几个要当心的

`GET /raw` 与 `GET /gallery/image`：路径不能随便给。`/raw` 带 `job_id` 时走该 Job 的白名单，只读
`output_paths`、`params` 的路径字段（`reference_{images,videos,audios}`、`mask_image`、MJ 三组参考素材）
与 Job 顶层 `source_image`，白名单里的 http(s) 直链不当本机路径解析；不带 `job_id` 时只放行
`.runtime/uploads/` 下的文件（目录本身不算），原来按 `image_storage_root` 回退放行已删。相对路径按数据根
解析；路径含 NUL 或文件名超长 → 400，不存在 → 404，不在白名单 → 403。
`gallery/image` 只放行 characters、projects screens、projects videos 的 `versions/` 资产以及 studio 子树；项目 brief / prompt 不对外暴露。加新产物目录要同步放行。

`POST /studio/jobs` 与 `POST /prompt/{job_id}` 的参考路径闸门：`params` 里的 `reference_images` /
`reference_videos` / `reference_audios` / `mj_sref` / `mj_cref` / `mj_oref` 与 extra 字段 `source_image`
（字符串或字符串数组）每一项都要过闸门：绝对路径或数据根相对路径，resolve（展开 symlink）后必须是数据根内
真实存在的文件，不能在 `.config/` 下，`.runtime/` 下只认 `uploads/`（大小写与 Windows 尾随点 / 空格不绕过）；
http(s) 直链（带 host）原样放行，供「再次生成」回传历史参考。任一项违规或文件不存在 → 422，
detail 形如 `params.<字段> 第 N 项：<原因>`，`/prompt` 违规时 job 文件不变。通过的本机路径落盘前改写成
resolve 后的绝对路径（落盘值就是闸门判过的那个）。`mask_image` 浏览器不能传：两个入口都先丢掉浏览器给的值
（`/prompt` 保留已有值），只由服务端（画布局部编辑）写。

`KeySpec.enabled` 为布尔值，默认 `true`；`POST /keys` 与 `PATCH /keys/{alias}` 接受该字段。
`GET /keys` 保留停用供应商及其模型供管理，模型选择器必须过滤 `enabled=false`。停用供应商不参与模型路由、默认选择、Canvas 与 Agent 模型目录；显式指定停用供应商提交生成返回 422「供应商已停用」。停用保留密钥、模型配置与历史任务。

`GET /keys/{alias}/reveal`：唯一回明文密钥的接口。按显式 alias、按需返回；列表接口一律掩码。

`POST /keys/models-preview`：形状与分类瀑布见 [references/provider-config.md](references/provider-config.md) 的「models-preview 契约」一节。两条硬约束——① 用存储密钥时 `base_url` 只能与存储值同 host；② 默认 `/models` 未必是全集（OpenRouter 的视频模型要额外拉 `?output_modalities=video`）。

## 不变式

- 同一时间只支持一个 Web tab，多 tab 行为未定义。
- job JSON 禁止手写：`/api/jobs` 全量 Pydantic 校验，一条 schema 错会让整个列表 500（表现为「角色里没内容」）。用 `lib/jobs.py` 的 `Job`/`save_job()` 生成。
- `params.warnings` 是数组不是字符串；`status`/`kind`/`asset_slot` 必须用 schema 枚举值。
- 改后端 lib 后 viewer-server 必须重启：长驻进程缓存旧模块，症状是「X object has no attribute Y」而 pytest 全绿。

### 模型路由成员状态

- `GET /api/model-routes/member-status`：仅限本机管理，返回 `ModelRouteMemberStatusResponse`。
  `members` 包含 modality、alias、reason、since、next_probe_at、route_ids；reason 为
  insufficient_balance（欠费）或 unavailable（临时不可用，since 为 null）。
  `unavailable_routes` 为所有本机成员欠费的路由（id、name、modality）。
- `POST /api/model-routes/member-status/restore`：请求 `{modality, alias}`，恢复后返回同一状态结构。

### 用量

`GET /api/pricing/tokendance` 返回 TokenDance 价格快照 `{synced_at: string | null, models: {model_id: pricing}}`，`pricing` 原样保存 TokenDance 公开模型接口的同名字段；规则见 [生成价格清单维护](references/generation-pricing.md)。

`GET /api/usage` 仅限本机管理会话（Agent 无权读取）。参数 scope=mine|team（默认 mine）、
range=today|7d|30d|90d|all（默认 30d）、source=all|local|lan（默认 all，仅 mine）、
member=网关密钥 ID（仅 team）。网关未开启时 team 返回 404。响应 `UsageResponse` 双端 schema
定义 totals、trend、rankings、sources、members；已删除 top。
mine 每条 image/video job 计一次，排除 pending_confirm/canceled，保留 pending 等进行中状态；actual 优先于 estimated，
failed 只计 actual。非失败且无价格的任务 `cost_cny=null`（未计价，含尚无估价的进行中任务），不计入金额，另计 `totals.unpriced` 与排行行 `unpriced`。team 以账本 charged_cny 为准。时间按本机时区，从 N 天前的日界线
（包含今天）至现在；previous 为紧邻的等长区间，all 时为 null。today/7d/30d 按日，其余周一分桶并补零。


`GET /api/usage/tasks` 同样只限本机管理会话，复用以上 scope/range/source/member 筛选，
增加 `status=all|done|failed|unpriced`（默认 all）、`offset>=0`（默认 0）、`limit=1..200`（默认 50）。
返回 `{rows: UsageTask[], total: number, next_offset: number | null}`；先筛选再分页，按提交/账本时间的真实时刻倒序、同刻按 id 升序，越界 offset 返回空 rows、原 total 和 null。
`all.total` 与同口径 `totals.count` 一致；unpriced 严格等于 cost_cny=null，不把真实 0 元或失败无账单视为未计价。

额外支持可选的 `project/model/alias/kind` 查询参数，空值表示不限；与已有条件取交集，在分页之前精确匹配。`project` 使用项目稳定 key；`kind` 使用汇总类别，`image` 同时匹配 `image/image_edit/layer_split`，其余类别精确匹配。
行字段为 `id, at, kind, model, label, source, cost_cny, alias, status, duration_s, project_key, member_key, project_label, member_label, thumb_url, href`，本机可带截断后的 prompt，团队不返回 prompt。
`project_key` 为 `canvas:<id>` 或 `studio`（创作台出图，团队为 null），`member_key` 为团队成员 ID（本机为 null）；筛选使用 key，不使用可能重名的显示名称。
status 保留真实状态（含 pending、done、failed，以及团队 canceled 等）；成功筛选只匹配 done，不把取消算成功。
本机 duration_s 为终态 completed_at−submitted_at 的秒数，未完成或无完成时间为 null；项目显示画布名称（项目已删除显示「已删除的项目」）或「创作台」，member_label=null。
团队 duration_s 取网关用量行的执行时长（开始执行→结束，没开始执行即结束的任务为 null；旧行无此字段为 null）。
网关用量行（`.runtime/gateway/usage/YYYY-MM.jsonl`）另记 `queued_at / started_at / finished_at`（ISO，带时区）与
`queue_s`（受理→开始，未开始则受理→结束）、`duration_s`；文本调用受理即开始。还记 `sent_to_upstream`、`sent_at`（第一次交给上游 caller 的时间）与 `upstream_task_ids`，只用于对账，不参与扣费。汇总脚本：
`uv run python -m character_workflow.lib.gateway_stats [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--days N] [--json]`（只读）。
输出另含 `watchdog.unresponsive_restarts`（常驻看护判定无应答、结束并重启服务的次数）；停止原因 `unresponsive` 的会话按 `unresponsive_since` 截止，无应答那段不计在线。
团队 project_label=null、member_label 为成员名，cost_cny 始终使用账本 charged_cny（空值按既有账务记 0）；旧账本无执行耗时则 duration_s=null，账本视频 duration 是素材时长，不能当作耗时。
任务表不为团队全量读取产物或 prompt。


## 图片定稿与项目类别（5.107.0）

- `CreationAsset.category: string | null`：单一应用级类别，去首尾空白、空串归 null、最长 24 字。不新增内容版本；关联项目共享类别与取消定稿。使用资产建立 `project_ids` 关系后，已定稿资产自动进入该项目参考库。
- `PATCH /api/creation-assets/{asset_id}`，JSON `{category: string | null}`，返回更新后的资产。仅 media/generation 可定稿；不存在返回 404，非法字段或类别返回 422。
- `POST /api/creation-assets/media/from-path` 增加可选 `category`。`allow_existing=true` 时按媒体 sha256 复用、合并项目关系；传非空类别时更新已有资产类别。
- `GET /api/creation-assets` 支持 `project_id` 过滤关联项目，以及 `has_category=true|false` 过滤类别是否非空。参考库还需限定 media/generation。
- `CanvasProject.categories: string[]`：默认六类，去首尾空白并去重，每项 1–24 字，最多 40 项。旧项目缺字段时读默认值。
- `PUT /api/canvas/projects/{project_id}/categories`，JSON `{categories: string[]}`，返回完整项目。项目锁与资产锁内检查使用数量、原子写入；删除仍被本项目资产使用的类别返回 409，detail 为 `{code: "category_in_use", message, count, usage: {类别: 数量}}`。
- 类别列表按项目维护，关联资产可携带其他项目的类别，不自动新增到可选类别列表。


## 参考库自动分类（5.108.0）

`POST /api/canvas/projects/{project_id}/classify` 接收 `{asset_ids: string[], model_alias?: string, model?: string}`。每次 1–48 个不重复的本项目图片资产，每 8 张调用一次模型，发送最长边 512 的缩略图。模型沿用前端 Agent 已记住的对话模型，显式传入别名与模型（Agent 未发首条消息时设置仅在浏览器中，故补充这两个请求字段）。模型必须配置图片输入。响应为 `[{asset_id, category: string | null, confidence: number}]`，置信度 0–1；仅给建议、不写资产。类别必须在项目列表中，非法 JSON、遗漏/重复/额外 ID、越界类别返回 502 `CLASSIFICATION_INVALID_RESPONSE`；模型失败返回 502 `CLASSIFICATION_MODEL_FAILED`。未配置模型、图片输入、项目类别分别返回 422 的 `CLASSIFICATION_MODEL_REQUIRED`、`CLASSIFICATION_VISION_REQUIRED`、`CLASSIFICATION_CATEGORIES_REQUIRED`。只由用户点击触发计费；待分类列表及建议为前端本次面板会话状态，确认后才逐项 PATCH category。

## 项目规范与经验（5.109.0）

`CanvasProject.category_spec_files` 记录类别到唯一 ASCII Markdown 文件名的映射，保留 `project.md`。规范位于 `specs/project.md` 与 `specs/<slug>.md`，每文件最多 40000 字符，项目锁内原子写入。项目包包含规范及 `agent/lessons.md`，校验 UTF-8、长度、清单 MIME 和映射文件完整性。

- `GET /api/canvas/projects/{project_id}/specs` → `{project: string, categories: Record<string,string>}`；未写类别返回空串。
- `PUT .../specs/project` 与 `PUT .../specs/categories/{name}` body `{text: string}` → `{saved:true}`。
- `GET .../lessons` → `{pending:string[], adopted:string[]}`；`POST .../lessons/{index}/adopt` 与 `DELETE .../lessons/{index}` 操作待审索引，返回更新后的列表。采纳追加至项目规范的 `## 项目经验`。
- Agent `read_spec(category)` 返回类别全文；`append_lesson(text)` 记录 1–300 字待审经验，审查模式需确认。每轮 instructions 追加项目规范，超过 8000 字截断并标注。
- 编辑器中文输入法组合期间不启保存计时；切页/关闭前完成保存，失败保留抽屉及本机草稿，意外卸载可恢复。

## Agent 项目参考（5.111.0）

- `CanvasCreationAssetSnapshotOrigin.asset_id?: string | null`：只读来源身份。新转入保留 ID，旧快照无 ID；内容仍冻结，资产更新/删除不改画布内容。项目包保留出处。
- 内置 Agent `search_library(category?, limit=12)`：limit 1–12，只读本项目已定稿图片资产，返回 `{assets:[{asset_id,title,category,width,height}], attach_images:[...]}`。不存在类别或空库返回空数组；缩略图在发模型时附加，不写对话历史。
- `apply_changes` 新增 `add_asset_node {asset_id,node_id,position?}`。只接受本项目参考库媒体/生成资产；以当前节点版本的只读 asset_id 去重，复用冻结内容。结果增加 `asset_nodes`（资产 ID → 真实节点 ID）与 `node_aliases`（请求 ID → 复用节点 ID），同批后续操作自动解析别名。
- 资产字节、版本、节点及同批连线整批验证后提交；失败不留下半成品。参考节点位于生成节点左侧一列；参考必须通过可见 input 连线参与生成。

## 工坊迁移来源（5.112.0）

`CanvasProject.migrated_from_workshop: string | null` 记录完成迁移的工坊 slug，普通新建项目为空，项目包保留此字段。

一次性迁移已完成，脚本随工坊代码退役；原工坊文件保留，详见 [ADR-0027](adr/0027-canvas-project-is-the-project.md)。


## 工坊退役（5.113.0）

旧工坊 API、workshop_* MCP 工具和 Skill 已移除。Job 的 asset_slot/project_id/ui_scheme_id/screen_id/production_id/workshop_request_id 字段已删除；历史工坊 job 在 jobs-archive/workshop 中保留，活动任务仅支持 studio/canvas。项目数据保留 migrated_from_workshop 作为迁移来源记录。

### 管理员中转接口（5.127.0）

`GatewayKeyRecord.role` 为 `member | admin`，默认 `member`。本机创建/修改成员同样支持角色；`GET /api/gateway/audit` 返回最近200条 `{entries}` 操作日志。日志含 time（带时区）、actor_id/name、action、target_id、summary，不含 token 或哈希。

`/gateway/v1/admin` 下所有端点每次请求校验有效 admin，成员403、无效凭据401。成员密钥管理（`/keys` 各端点与 `/options`）另要求请求头 `X-Atelier-Admin-Api: 2`（本机管理代理自动加），缺少或不一致返回 426「远程管理需要本机与主机是同一版本」；其余端点不查（第 7 批）。管理写入持锁复查；不能远程撤销/降级自己，最后管理员只能本机撤权。

| 方法与后缀 | 响应与作用 |
|---|---|
| GET /keys | `{keys}`，成员记录不含token_sha256 |
| POST /keys | 201 `{key, token}`，明文仅此次响应；输入name/role/quota/scope |
| PATCH /keys/{id} | 修改成员，返回脱敏记录 |
| POST /keys/{id}/revoke | 撤销，返回脱敏记录 |
| GET /options | 同本机 `/api/gateway/options`：按供应商分组的可授权模型 |
| GET /usage、/usage/tasks | 与本机用量结构一致，固定team；range/member筛选；tasks另支持status/offset/limit/project/model/alias/kind |
| GET /tasks | scope=active/recent，所有成员任务的安全快照 |
| GET /live | SSE task事件，4秒心跳；发送前复查权限，客户端另每4秒轮询tasks |
| GET /members | 上游alias欠费/暂不可用状态 |
| POST /members/{alias}/restore | 输入modality，恢复后返回状态 |
| GET /routes、PUT /routes/order | 返回`{models:[{id,name,modality,aliases}]}`；排序输入modality/id/aliases |
| GET /audit | `{entries}`，limit默认200最大1000 |

接入端仅通过 `/api/gateway/providers/{alias}/admin` 下对应白名单路由代理，全部注册 LOCAL_MANAGEMENT；服务器用已保存的中转密钥请求，不重定向，不接受任意转发目标。无上游凭据增删/查询、文件读取或本机设置接口。远程任务不提供本机产物链接。


## 应用内更新（本机管理会话）

仅新布局安装包可应用更新。网关端口和远程管理员凭据不提供这些接口；源码版只显示版本提示。

- `GET /api/update/state`：运行模式 source/bundle/legacy_bundle、current、准备状态 status（idle/checking/downloading/ready/blocked/error）、to/bytes/reason、maintenance/initializing、waiting/waiting_counts、phase（idle/waiting/restarting）、update_id、restart_started_at（Unix秒）、service_mode。
- `POST /api/update/check`：后台重新检查，允许重试被封禁版本；返回当前状态。
- `POST /api/update/apply`：ready 后接受，202 返回 update_id；重复、维护中或未准备好返回409，非安装包返回400。先拒绝新任务再等存量，最多10分钟。
- `POST /api/update/cancel`：仅等待阶段可取消，返回 status=cancelled；开始重启后409。
- `GET /api/update/result?id=…`：仅返回匹配ID的终态 succeeded/failed/cancelled，含 from/to/reason/finished_at（ISO时间）；未落盘或ID不匹配返回null。

维护期间新生成/Agent消息/网关生成返回503（响应体带 `code: "updating"`），已接入工作、审批与取消仍可完成。候选初始化期间仅放行本机会话建立、编辑租约及更新状态/结果，其他业务API暂时503。

## ChatGPT 订阅供应商

- `GET /api/subscriptions/chatgpt`：本机管理会话专用，响应 `{available:boolean,email:string|null,plan:string|null}`，`Cache-Control: no-store`。只读取登录状态，不刷新、不返回 token；不向网关管理员或 Agent 开放。
- `POST /api/keys` 的订阅配置使用 `provider="chatgpt"`、`auth_source="codex-cli"`；无需 `access_key`。禁止保存密钥、自定义地址、计费分组；固定唯一图片模型 `{id:"gpt-image-2",name:"GPT Image"}`。更新同样校验。普通供应商不接受 `auth_source`。
- 凭据源为 `$CODEX_HOME/auth.json`，未设时用 `~/.codex/auth.json`，仅支持文件中的 ChatGPT 登录。Token 不进入供应商配置、API 或 Job。过期刷新写回原文件；锁在数据目录 `.runtime`，只协调 Atelier 进程，不声称与 Codex CLI 共用锁。
- 出图收到 401 时最多恢复一次：重新读取登录，若 token 未被其他进程替换则持锁强制刷新；恢复后仍为 401 才提示重新登录。刷新请求携带 `scope="openid profile email"`。桌面进程无法执行 `codex --version` 时，请求头使用已验证的 `0.162.1`，不因此拒绝有效登录。
- 订阅任务保留 `provider="chatgpt"`，单次价格为 0 CNY。能力参数按实际验证白名单开放；未实测前只提供默认单张，不暴露比例、质量、背景、局部编辑或扩图。

2026-10-27 经用户授权实测（Codex CLI 0.162.1），文生图与单参考图编辑各 1 次成功，真实 Job 均为 DONE、实际记账 0 CNY。

| 能力 | 验证结果与开放范围 |
|---|---|
| 文生图 | `model=gpt-image-2`、`n=1`，其余参数省略；开放 |
| 图生图 | JSON `images:[{image_url:dataURL}]`，单参考图、单张输出；开放 |
| 比例 / size | 追加三次文生图探针表明指定尺寸未被遵守，保持不开放 |
| quality / background | 未验证；不开放控件 |
| 多张输出 / 多参考图 / mask / 局部编辑 / 扩图 / AI 高清 | 未验证；不开放 |

两次调用期间 auth.json 未改变，未触发刷新；真实刷新并发仍仅有隔离测试覆盖，不能用这两次调用证明与 CLI 同时刷新安全。

同日经用户追加授权，固定提示词 `white background, a red ball`，按次序只改变 size，读取 PNG IHDR 得到以下结果（共 3 次，无重试）：

| 请求 size | HTTP | 实际像素 | 耗时 |
|---|---|---|---|
| `1536x1024` | 200 | 1374×1145 | 18.26 秒 |
| `1024x1536` | 200 | 1254×1254 | 19.58 秒 |
| `auto` | 200 | 1254×1254 | 18.46 秒 |

请求成功不等于尺寸生效：目前无法据此提供可靠的比例选择。前后端能力保持无比例，caller 不发送 size；未测试其他像素、图生图尺寸、质量或背景。

## Tuzi GPT Image 2.5 / 2.6 图片质量

Tuzi GPT Image 2.5 与 2.6 系列在 Studio 与 Canvas 提供五档质量：低/中/高/超高/最高，分别传 `quality=low|medium|high|xhigh|max`。比例独立选择，不提供 K 分辨率档位，也不再将 resolution 转换为 quality。

## GPT Image 2.6：规划强度与 GIF 输出

`gpt-image-2.6-flare` / `gpt-image-2.6-sunburst`（2026-11-04 发布）独有两项能力，判据按模型 id（`supports_image_complexity` / `supports_gif_output`，前端 `supportsGptImage26`），不按 provider：

- `params.complexity`：`low | medium | high`，规划强度，与 `quality` 独立。`high` 是官方默认值，caller 不发；只有 `low | medium` 进请求体（Tuzi 对未知字段 400，少发一个字段少一条故障路径）。
- `params.output_format = "gif"` + `frame_count`（2–64，默认 9）+ `frame_duration_ms`（20–2000，默认 200，10ms 取整）：动图只走 `/images/generations`，带参考图或蒙版时 caller 直接拒绝（不计费）；前端带参考图时也不提交 GIF 字段。产物按文件头存成 `.gif`，`image_dimensions` 读 GIF 头，画布导入 mime 为 `image/gif`，缩略图接口对动图退回原图。
- 这四个字段在 `JobParams` 双端声明、进入 Canvas 浏览器可提交白名单与局域网网关图片白名单；换到不支持的模型时前端 `normalizeImageSizeParams` 与服务端 `_normalized_image_preference_params` 都会丢掉它们。Canvas 生成偏好只记住 `complexity`，GIF 是当次的选择。
- `markup` 标注层：官方 `/images/edits` 的 multipart 字段，与首张输入图同宽高的透明 PNG，各 ≤16,777,216 像素；不能与 `mask` 同用。caller 只对 `supports_image_complexity` 为真的模型发 `markup`，同时带 `mask_image` 时直接报错不计费；来源只有画布标注（见「画布标注」节的 `markup_version_id` / `params.markup_image`），Studio 没有入口。
- 不做：SVG 输出（官方 reference 要求 `svg.model` 与额外权限，网关不透传，产物管线按位图设计）。两家网关 2026-11-05 对 2.6 都回「价格未配置」，size=auto 放行按 2.5 同系推定，上架后复验；markup 的真实请求同样待上架后复验。
- Tuzi 实测（2026-11-05，`gpt-image-2.6-1k`，¥0.02/张，AUTO 出 508–1254²）：images 端点拒 `output_format=gif`（400「must be png, jpeg, or webp」），`complexity` 字段可发；GIF 走 `chat/completions`，提示词末尾加「生成gif，N 帧，每帧 M 毫秒」，帧数与帧间隔实测被遵守（6 帧 150ms → 6 帧 150ms），三次里一次回静态 PNG，caller 按文件头落盘并写 warning「网关返回了静态图」，不重试。另：提示词本身写了 looping animation 时，images 端点也会直接回 GIF 字节，管线按文件头存 .gif。Tuzi 的 `gpt-image-2.6-flare/-sunburst/-vip` 与 OpenAI-HK 的 2.6 截至当日仍未配价。
- OpenRouter 实测（2026-11-05，真打两次）：`complexity` 传非法值照样 200 出图 = 字段被 OpenRouter 剥离不透传；`output_format=gif` 被其 schema 400 拒（只认 png/jpeg/webp/svg）。所以 OpenRouter 渠道不暴露规划与 GIF，这是协议级限制。同渠道 2.6 Flare AUTO/低 一张 19s、¥0.19，AUTO 实际出 1312×1199。

### 模型菜单元数据（本机只读）

- `GET /api/models/durations` → `{ "<alias>:<model_id>": seconds }`。仅统计成功 Job；Studio 从 `submitted_at`、Canvas 从 `runner_started_at` 算至 `completed_at`，无有效起止时间跳过。每组按完成时间取最近 50 条，至少 3 条才返回中位数；`@auto:<route_id>` 合并成员记录后按同一规则计算。进程缓存有效期 60 秒，按 data root 隔离。
- `POST /api/pricing/estimate-batch` 请求 `{ kind: "image" | "video", params: JobParams, items: [{ alias, model }] }`（最多 500 项），响应 `{ "<alias>:<model>": number | null }`，单位 CNY。复用 `estimate_submission`；未知渠道、模型或无法计价返回 null。`@auto` 只预览当前路由成员，不消费轮询游标。菜单请求设 `n: 1`，视频携带当前时长与分辨率；参数变化防抖 300ms。
- 展示热度顺序由前端 `modelCatalog.ts` 管理，仅影响菜单及切换供应商的默认模型，不改变 `/api/models/order` 的路由优先级。Studio 的 Image/Video 标签滚动到同一列表内对应分段；Canvas 按节点模态展示供应商与模型两个控件。
## ComfyUI 本机工作流（A 批，2026-11-02）

- Provider 新增 `comfyui`：不需要密钥，base_url 默认 `http://127.0.0.1:8188`，
  只允许 localhost / 127.0.0.1 根地址。通用 Key API 不得直接修改其 models。
- ModelSpec / KeyModel 新增可选 `workflow_inputs: WorkflowInput[] | null`。
- 网关协议保持 v2；`GET /gateway/v1/models` 的 ComfyUI 路由额外返回 `workflow_inputs`，成员刷新时与 `via` 一起保存快照（包括空数组）。目录不包含原始 `api_workflow`，仍按成员权限过滤。
- 网关图片任务允许 `params.workflow_inputs` 声明值；参考图按 `ref_0…` 编号顺序上传，遮罩用 multipart `mask`，不接受本机路径或原始工作流。没有 prompt 声明的工作流允许空提示词，主机执行前按本地声明校验并补全默认值。
  null 时不序列化，空数组表示工作流没有暴露输入，普通模型响应保持原样。
- WorkflowInput：`id, label, type, node_id, class_type, field, default, min?, max?, step?,
  options: [{value,label}], required`。type 为 prompt / text / int / float / boolean /
  select / seed / image / mask；prompt 和 mask 最多一个，image 按声明顺序对应参考图。
- 本机 Studio 与画布由 runner 在 `params.comfyui_resume` 记输出前缀与本机地址，在 `provider_task_ids` 登记同一次运行的订单。它们只用于续查，不可由浏览器创建或修改，不进入配方或重试克隆。
- JobParams 新增 `workflow_inputs: Record<string, string | number | boolean | null>`，
  只允许普通参数和种子值；prompt、图片、mask 仍使用现有专用字段。seed 的 null 表示随机。
  未声明参数、越界值、错误类型和非法选项直接拒绝。固定种子要求 n=1。
- Job.progress_phase 扩展为 `sent | downloading | waiting_gateway | queued:<正整数> | null`（`waiting_gateway` 见网关一节的「等待网关」）。
  前端将 queued:N 显示为「排队第 N 位」。终态仍清空。

本机管理接口（需要本机会话和管理权限，未挂载到网关）：

| 方法 | 路径 | 内容 |
| --- | --- | --- |
| POST | `/api/comfyui/connection` | `{base_url}` → `{devices: [{name,vram_total}]}` |
| GET | `/api/comfyui/{alias}/workflows` | `{workflows: Workflow[]}` |
| POST | `/api/comfyui/{alias}/inspect` | `{api_workflow, previous_id?}` → `{inputs,candidates,tagged,warnings,unmapped}` |
| POST | `/api/comfyui/{alias}/workflows` | `{name,api_workflow,inputs,source_filename?,identifier?,timeout_seconds?}` → Workflow |
| DELETE | `/api/comfyui/{alias}/workflows/{identifier}` | 204 |

Workflow 包含 `id, alias, name, source_filename, imported_at, api_workflow, inputs,
timeout_seconds`；超时默认 1800 秒，允许 1–86400 秒。inspect 不写盘；无 in: 标题时
只给候选建议，由管理员选择后保存。重新导入按显示名、节点类型、字段匹配，未匹配项显式确认。

## 语音与音乐（2026-11-15）

- `JobParams` 语音字段：`voice`（音色 id，也接受模型允许的自定义 id）、`speed`、`response_format`、`instructions`（仅 OpenAI 兼容）；
  音乐字段：`lyrics`（≤5000 字，不填由模型作词）、`instrumental`、`n`（1–2）、`music_tracks`（厂商回报的每首 `{title, lyric}`，顺序同 `output_paths`）。
- `provider_task_protocol` 新增 `yinchao`：音潮任务号先落盘再轮询，服务重启后凭它续查（画布与创作台）。
- 能力表 `src/character_workflow/data/audio_caps.json` 前后端共用：协议 → 族（speech / music）、音色、语速范围、格式、上限。
  可执行协议：`openai-speech`、`minimax-t2a`、`ark-tts`、`yinchao-song`、`declarative`（音频模板）。
- 画布生成偏好 `generation_defaults` 新增 `music` 槽位，`params` 只收 `instrumental`；`audio` 槽位是语音，`voice` 为 1–200 字的字符串。
- 局域网网关音频任务参数白名单：`voice / speed / response_format / instructions / lyrics / instrumental`，首数走任务的 `n`。

## 自定义接口（ADR-0036）

自定义供应商（`provider=custom`）下的模型可绑定一份接口模板，由通用执行器发请求；已登记模型不变。
音频模板（`kind=audio`，2026-11-15）：`declared` 另含 `family / voices / custom_voice / speeds / formats / max_chars / lyrics / instrumental`；
`result.body = "binary"`（仅音频同步接口）表示响应体即音频，`result.hex` 读 hex 编码的音频。规则见 ADR-0036「2026-11-15 修订」。

- ModelSpec / KeyModel 新增可选 `declarative_id: string | null`（null 不序列化），配合
  `protocol = "declarative"`。只在 `POST/PATCH /api/keys` 校验：供应商必须是 custom、模板存在、
  模型 modality 与模板 kind 一致（未标注时按 kind 补齐）。
- `GET /api/keys` 对绑定模型额外返回只读 `declared`：
  `{available, error, name, kind, ratios, resolutions, durations, max_count, reference_images, frames}`。
  模板缺失或损坏时只有 `{available: false, error, name: null}`，模型不可选。控件只显示非 null 的项。
- `JobParams.provider_task_protocol` 新增 `declarative`：异步模板的任务号先落盘再轮询，
  创作台图片任务可续查；画布与 Tuzi 异步一致，停止等待后落 FAILED。
- 估价恒为 null（未计价），两端估价器在 `protocol == "declarative"` 时直接返回。
- 路由 id 为 `declarative:<模板 id>:<模型 id>`，不与内置渠道合组。
- 局域网网关（批次 4）：模板可用的路由照常发布。`/gateway/v1/models` 对这类路由多给只读 `declared`（能力，
  不含模板正文、模板 id、路径与鉴权），成员快照的 `base_url` 置空；模板损坏 / 被删 / 解绑时路由从
  成员列表、提交校验、`/api/gateway/options`、`/gateway/v1/admin/options` 同时消失。未计价路由对所有网关密钥可见、可用
  （2026-11-18 起，含设了金额上限的密钥）；密钥任一限额窗口「已用 + 预占 ≥ 上限」后，受理一律 429，
  包括未计价与扣 0 的渠道和文本。接入端把 `declared` 存进 `ModelSpec.declared_snapshot`（null 不序列化），
  `GET /api/keys` 以 `declared` 返回。任务状态里未计价任务的 `charged_cny` 为 null，两侧用量都计入「未计价」。
- 主机手设单价（2026-11-18）：`ModelSpec.per_call_cny`（元 / 次，0–10000，null 不序列化）只在没有同步价时
  用于估价（本机任务、模型菜单、网关受理预占与结算），同步价优先；按「每次调用」计，不乘张数。`GET /api/keys`
  对「至少有一种参数组合拿不到同步价」的模型给只读 `unpriced: true`（定价的不出现该字段；局域网 Atelier 供应商不给），
  供应商页据此显示单价框。图片 / 视频按代表性参数（图片默认尺寸、视频 5 秒 720p 16:9）加逐维变体探测：视频带参考视频
  （模型声明支持时）/ 生成音频，图片带参考图 / 图片编辑 / 图层拆分（模型支持时）；分辨率与时长不枚举。音频取单价，
  文本按 1000 / 1000 token 估一次（2026-11-19，第 5 批 5-5）。
- 文本模型手设单价（2026-11-19）：`ModelSpec.input_cny_per_m` / `output_cny_per_m`（元 / 百万 token，0–10000，
  null 不序列化），两个都填才生效，只在没有同步价时用；网关文本中转受理预占与结算、本机「AI 帮我配置」与分镜解析的
  花费都按它算（`generation_pricing.estimate_text_cost_cny` 一处兜底）。结算来源记 `price_table`：成功才扣，失败扣 0；
  上游没回用量（`usage_missing`）扣 0。文本模型不用 `per_call_cny`。
  接入端：网关失败任务若 `charged_cny > 0`，任务错误末尾附「（已扣 ¥x：上游已对完成的部分收费）」。

模板（版本 1，Pydantic `http_protocol_schema.HttpProtocol` ↔ TS `web/src/schema/httpProtocols.ts`，
共用夹具 `tests/fixtures/http_protocol_cases.json`）：

| 字段 | 说明 |
| --- | --- |
| `version` | 只接受 `1` |
| `name` / `kind` | 显示名（≤60）/ `image` \| `video` |
| `auth` | `{type: bearer\|header\|query\|none, name?, prefix?}`；header / query 需要 name |
| `submit` | `{path, format: json\|multipart, headers?, body}`；path 为以 `/` 开头的相对路径，只能内插 `${model}` |
| `inputs.images` | `{max: 1–16, encode: data_url\|base64\|file\|url}`；file 只用于 multipart 顶层字段；url 经对象存储中转成 24 小时签名直链，未配置 OSS 时保存与 validate 报错 |
| `options` | `{ratio?, resolution?, duration?, count: 1–4}`；用到对应占位符必须列出可选值 |
| `derive` | `{名称: {from: 占位符 \| [两个占位符], map}}`；两个来源的键用 `@` 连接，须覆盖全部组合 |
| `result` | `{urls: [路径], base64: [路径], error?}`；同步时至少一个取值路径 |
| `poll` | `{path, method: GET\|POST, body?, task_id, status, success, failure, interval_seconds: 1–60, timeout_seconds: 30–3600, result}` |
| `catalog` | 可选，目录发现：`{path, items?, id?: "id", name?, kind?: {field, map}}`；path 为静态相对路径（不能用占位符），items / id / name / kind.field 为取值路径，map 的值只能是 `image\|video\|text\|audio\|excluded`。由 `POST /api/keys/models-preview` 的 `protocol_id` 使用，只发一次 GET，价格字段不读 |

占位符：整值 `"$name"` 保留类型、取不到值时删除所在键；字符串内插写 `${name}`；字面量 `$` 写 `$$`。
内置名：`prompt model n ratio resolution images image`，视频另有 `duration durationText firstFrame lastFrame`，
轮询另有 `taskId`。取值路径为点分，`*` 遍历数组，数字为下标。单份 ≤64 KB、嵌套 ≤12 层、数组 ≤64 项。
multipart 里的数组值展开成同名重复字段。

执行：同步用 (30s, 300s) 超时，只对未送达与 502/503/504 重试；响应头到达后读体失败当场致命（请求可能已执行）。
异步（带 `poll`）的提交按统一判据（`callers/task_submission.py`）：只对未送达自动重试；5xx、重试用尽仍连不上、
读体失败、响应不是 JSON、取不到任务号都按「提交结果未确认」处理（`DeclarativeUnconfirmed`，不重发、不换家；
经网关时 `error_kind=unconfirmed`、扣 0）。
报错为 `custom api <状态码>: <厂商文字>`；query 鉴权的密钥不进报错文本与异常链。提交与轮询都不跟随重定向。
轮询遇 404 视为还查不到、继续等。结果下载只允许公网地址或与 base_url 同源；提交响应 ≤64 MB、
轮询响应 ≤2 MB（流式强制）、单张图片 ≤50 MB、视频 ≤1 GB、结果超过 8 个报错。
局部编辑 / 扩图对自定义接口由 runner 明确拒绝。不支持的情况见 ADR-0036。

本机管理接口（本机会话 + 管理权限，未挂载到网关）：

| 方法 | 路径 | 内容 |
| --- | --- | --- |
| GET | `/api/http-protocols` | `{protocols: [{id,name,kind,available,error,declared,catalog,used_by:[{alias,model}]}]}`；`catalog` 为模板是否写了目录 |
| GET | `/api/http-protocols/{id}` | 同上一行的条目 + `document` |
| POST | `/api/http-protocols` | `{document}` → 201；校验失败 422 `{message, code: "PROTOCOL_INVALID"}` |
| PUT | `/api/http-protocols/{id}` | `{document}`；仍被绑定时改 kind 返回 409 |
| DELETE | `/api/http-protocols/{id}` | 204；仍被绑定返回 409 |
| POST | `/api/http-protocols/validate` | `{document, base_url?, model?}` → `{valid, issues:[{path,message}], declared, preview}`；不写盘、不发请求，预览里密钥为 `***` |
| GET | `/api/http-protocols/assist/models` | 「AI 帮我配置」可用的对话模型：`{models:[{alias, model_id, name, max_cost_cny}]}`（启用的文本模型；`max_cost_cny` 按资料上限估，无价格为 null） |
| POST | `/api/http-protocols/assist` | 计费调用：`{kind, alias, model_id, text?, urls?≤3}` → `{document, notices, usage:{input_tokens, output_tokens, cost_cny, job_id}}`。只起草不保存；不收供应商密钥；网址走出站检查（只放行公网，≤2 MB，只收 html / plain / markdown / json）；资料单份 ≤60K、合计 ≤120K 字符；资料与输出里有明确密钥特征的值替换为 `<redacted>`，长串只提示；输出只保留模板顶层字段，`version` / `kind` 强制覆盖；请求不带 tools，直连重发按 ADR-0044，`max_tokens` 4096；抓取失败在调用前报错（502，不计费），模型失败 502、输出不是 JSON 422（都已记账）；后两种的 `detail` 为 `{message, code: "ASSIST_FAILED", raw}`：`message` 是中文原因（欠费 / 密钥或权限 / 限流 / 超时 / 连不上），`raw` 是遮掉密钥的上游原文 |

接入说明唯一来源是 `src/character_workflow/data/http_protocol_manual.md`：自定义接口编辑弹窗的「复制接入说明」整份复制（前端构建时 `?raw` 内联同一文件；浏览器不让写剪贴板时下载为 `.md`），「AI 帮我配置」的提示词只取其中「模板规范（版本 1）」一节。改模板规则时改这一份。

Agent 侧（Canvas MCP，ADR-0036，只认 Agent 会话、不挂项目；本机页面会话 403 `CAPABILITY_DENIED`，无会话 401）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/canvas-agent/protocol-manual` | `{}` → `{markdown}`：接入说明全文 |
| POST | `/api/canvas-agent/protocol-validate` | `{document}`（请求上限 200 KB，超出 413 `CONTENT_TOO_LARGE`；模板本身上限仍是 64 KB，超出时 `valid:false`）→ 与 `POST /api/http-protocols/validate` 同形状；预览用占位服务地址与 `model-id`；名字在 MCP 适配器禁止字段名单里的字段（`Authorization` 头、请求体或请求头里的 `api_key` / `access_key` 等，不分大小写）从预览里拿掉，路径列在该次调用的 `hidden_fields`（如 `headers.Authorization`、`body.api_key`）；查询串鉴权在 `url` 里，不受影响。不写盘、不发请求、不读已有模板与密钥 |

## 对话模型协议（ADR-0044）

- `ModelSpec.protocol` 的文本取值：`openai-chat`（旧值 `null` / `openai` / `chat-completions` 同义）、`openai-responses`、
  `anthropic-messages`、`gemini-generate-content`。协议表在 `lib/llm_protocols`，能否调用的唯一判据是 `openai_text.text_callable`。
- `GET /api/keys` 的文本模型、`GET /api/models` 的文本路由成员：不能调用时给只读 `text_unsupported: true`，能调用时不出现
  该字段。前端只读它，不另抄协议表。
- `KeySpec` / `KeyCreatePayload` 新增可选 `text_protocol`（`openai-chat` / `openai-responses` / `anthropic-messages` /
  `gemini-generate-content`，
  null 不序列化 = 自动）。只在 `POST/PATCH /api/keys` 校验：取值必须在上表里、供应商必须是 custom，否则 422。选了具体接口时，
  写入时把这把 KEY 的文本模型（`declarative` 除外）的 `protocol` 都改成它；PATCH 显式传 null 改回自动，各模型协议不动。
- `POST /api/keys/models-preview` 新增可选 `text_protocol`（不传时用已存的）。为 `anthropic-messages` 时改为
  `GET {根}/v1/models?limit=1000` + `x-api-key` + `anthropic-version`，不跟随重定向；文本模型的 `protocol` 返回
  `anthropic-messages`，`capabilities.image_input` 映射到 `input_modalities`。上游只声明 `anthropic:messages` 的模型
  分类为 text、协议 `anthropic-messages`；同时声明 OpenAI 格式的取 `openai-chat`。为 `gemini-generate-content` 时改为
  `GET {根}/v1beta/models?pageSize=1000` + `x-goog-api-key`，不跟随重定向；条目取 `models[].name`（去掉 `models/` 前缀）与
  `displayName`，`supportedGenerationMethods` 非空且不含 `generateContent` 的不列。
  - 自定义供应商、`text_protocol` 为自动（null）时先自动识别（ADR-0044 第 3 批）。
    - 响应多一个 `detected: {protocol, family, label}`：
      - `family` 取 `address`（只看地址定下）/ `new-api` / `anthropic` / `gemini` / `openrouter` / `openai`；
      - `protocol` 是这把 KEY 的默认对话协议；
      - `label` 只在 New API 且 `/api/status` 可读时给，形如「兔子API v0.9」，否则为 null。
    - New API 的文本模型按 `supported_endpoint_types` 逐个返回 `protocol`。
- `GET /api/keys` 的模型新增只读 `agent_unverified: true`，只在不进 Agent 时出现：自动识别成 `gemini-generate-content`、地址不是 `generativelanguage.googleapis.com`、`text_protocol` 也不是 Gemini。
  - 这类模型不出现在 `GET /api/canvas/agent/models`。
  - 用它构造 Agent 时报 422 `MODEL_UNAVAILABLE`，说明原因与改法。
    - 选了具体接口时不识别，响应里没有 `detected`。
    - 不跟随重定向的请求遇到 3xx 也按失败处理（502）。
- 一次性文本调用（画布文本节点、AI 帮我配置、分镜解析、分类）按模型协议发请求；Anthropic 走 `POST {根}/v1/messages`，
  Gemini 走 `POST {根}/v1beta/models/{id}:generateContent`，
  响应转回 Chat 形状，用量按「含缓存的总输入」归一。协议选错时 `job.error` / 失败原因提示到供应商里改「对话接口」，不自动换协议重试。
- `GET /api/canvas/agent/models` 先返回本地已启用的对话模型与已缓存的能力。若 `refresh_pending: true`，客户端继续读一次 `?wait=true`，等待同一次上游探测后更新列表。最终响应含 `refresh_pending: false`；供应商失败按别名列入 `errors`。
- 内置 Agent 接全部四种协议（Anthropic、Gemini 在 HTTP 层转换）；`GET /api/canvas/agent/models` 里这两种模型的
  `reasoning` 为 false。Agent 会话接口（创建、读取、修改、发消息、确认、停止）返回的 `history` 去掉
  `provider_data.thought_signature`；项目导出包里的会话同样去掉，落盘文件保留。
- 局域网网关的 Chat 入口可选 OpenAI Chat、Anthropic Messages 和 Gemini generateContent；Responses 入口只选 OpenAI Responses。所有选择都受成员密钥范围约束。
- `GET /gateway/v1/models` 的文本路由中，`members[].protocol` 是接入协议，只有可见成员全部使用 Responses 才返回 `openai-responses`，其余返回 `openai-chat`。`upstream_protocol` 可选，表示成员真实上游协议。主机确认某成员的工具调用未经验证时附 `agent_tools_unverified: true`，只有这把密钥可选的 Chat 成员全部带此标记，路由才因此对 Agent 不可用。非空 `tools` 请求只选择通过工具筛选的成员。
- 原生上游明确拒绝且已无可换成员时，网关返回 HTTP 503 和 `error.type=gateway_unavailable`，`error.upstream_status` 保留上游状态码，`error.message` 带脱敏诊断。
- 转换后的 Chat 响应和 SSE 使用量中，`prompt_tokens` 包含缓存读取与写入，明细分别为 `prompt_tokens_details.cached_tokens`、`cache_write_tokens`。主机文本用量行与本机 agent-usage 行记录可选的 `cache_write_tokens`。同步价缺缓存写入价时按输入价估算，可能低于实际账单。

## 供应商自定义图标（I1）

- `KeySpec` / `KeyCreatePayload` / `KeyPatchPayload` 新增可选 `icon`：`brand:<id>`（内置品牌，id 为小写字母、数字、连字符）或 `file:<sha256>`（已落盘的图片）；为 null 时不写盘，按默认规则显示。PATCH 显式传 null = 恢复默认，不传 = 不改。
- 只在 `POST/PATCH /api/keys` 写入边界校验；`file:` 引用的文件写入时必须存在，否则 422。读盘不校验：文件后来不在（手改配置、拷贝 keys.json 给同事、清理竞态）时 `/api/keys` 照常返回，界面退回首字母。
- `GET /api/provider-icons/{sha}`：sha 只收 64 位小写十六进制；只读 `<data_root>/.config/provider-icons/<sha>.png`；`image/png`、`nosniff`、`private, max-age=31536000, immutable`。不存在或不合规为 404。本地会话可读（网站会话也可读，模型菜单显示）；网关应用不挂这条路由。
- `POST /api/provider-icons`（multipart，字段 `file`，单文件）：校验、重新编码、落盘，返回 `{icon: "file:<sha256>"}`；不改任何 KEY，由表单保存时写进 `icon`。超过 1 MiB 为 413；SVG、HTML、伪装扩展名、截断、边长超过 2048 或长宽比超过 256:1 为 422。`detail` 只有一句原因：`图片超过 1 MB`、`图片尺寸超过 2048×2048`、`图片长宽比过大`、`不支持这种图片格式`、`图片无法识别`。属于供应商管理，只给本机页面。
- `POST /api/provider-icons/fetch` `{url}`：按网址取站点图标，返回 `{icon}`，同样不改 KEY。全部请求走 `outbound_guard.fetch_bounded`：只 http(s)、不带鉴权头与 Cookie、重定向最多 3 次且逐跳重查，15 秒总时限对每个请求的读取也生效（上游慢速滴流时按时结束）。地址检查：没有配代理时按 DNS 解析结果只连公网地址，并按校验过的 IP 建连；配了代理时交给代理解析，字面量私网 IP 与本机域名仍拒绝，用户亲手填的首个地址按 ADR-0036 既有规则，重定向目标与页面里解析出的候选只放行 https。首个地址按 1 MiB 读：本身是图片时直接用（超过 1 MiB 即失败）；是页面时读到上限为止，取前 512 KiB 解析 `<link rel=icon|apple-touch-icon>`，相对路径与 `<base>` 按重定向后的最终地址解析，按声明尺寸从大到小，再试 `/favicon.ico`；最多 4 个候选、每个 ≤1 MiB，主机名畸形、非图片响应、超限的候选跳过。请求一律带 `Accept-Encoding: identity`，上游仍回压缩内容时这个地址按不可用处理、不解压。读超时、半途断开、坏的分块都按连接失败；候选出错换下一个。网址超过 2048 字符回 `网址过长`。失败为 422，`detail` 只有一句原因：`不能使用本机或内网地址`、`没有找到图标`、`连接失败`、`网址过长`，或上传那一套；预料之外的异常记日志（带异常类型）后回 `连接失败`（上传回 `图片无法识别`），不出现英文的 500。属于供应商管理，只给本机页面。
- 局域网网关 `GET /gateway/v1/models` 的成员新增可选 `icon`，只在主机为该 KEY 选了内置品牌时出现（`brand:<id>`）；上传的图片（`file:`）是主机本地文件，不下发。成员端在读网关快照时（`atelier_gateway.gateway_models`）只留合法的 `brand:<id>`，其余（含非字符串）按没有处理，不让整次同步失败；`ViaMember` 不加读盘校验。
- 图片一律是重新编码后的 128×128 透明底 PNG，文件名为内容 sha256。每次写 `keys.json` 后清理没有引用、修改时间超过 1 小时的文件；清理失败只记日志，不影响保存供应商。

## 网关共享库（ADR-0034）

本机管理：`GET /api/team-library-gateway-share` 返回 `shared_library_ids` 与 `gateway_enabled`；
`PUT /api/team-library-gateway-share/{library_id}` 接收 `{enabled: boolean}`，只能开启已挂载库，网关关闭时开启返回 409。卸载自动停止共享。

网关接口均要求有效 Bearer 网关密钥，只有 GET；未共享或不可达的库统一 404：

- `/gateway/v1/libraries`：数组 `{id,name,owner_name,updated_at,counts}`。
- `/gateway/v1/libraries/{library_id}/assets`：数组 `{entry_id,kind,title,author?,mime_type?,width?,height?,duration_s?,tags,category?,prompt_text?,preview_count}`。当前无尺寸/时长的条目省略对应字段，客户端图片加载后测量。
- `/gateway/v1/libraries/{library_id}/assets/{entry_id}/thumb?w=512`。
- `/gateway/v1/libraries/{library_id}/assets/{entry_id}/previews/{n}/thumb?w=512`：效果图索引从 0 开始。

`entry_id` 按 `TEAM_ASSET_ID_PATTERN` 校验，普通文件用其内部身份的稳定哈希生成公开标识。
两类缩略图都为 WebP，`w` 范围 1–1024（当前取档上限 512），非图片返回 404。
没有原文件、采用或生成快照接口，不发布本机路径、参考图、模型或参数。

成员本机 `GET /api/gateway-libraries` 返回数组 `{gateway_alias,owner_name,unreachable,libraries}`，
每个 Atelier 渠道均保留，连接/读取超时 3 秒，失败时 `unreachable=true`、库列表为空。
`GET /api/gateway-libraries/{alias}/{library_id}/assets` 及对应 `/{entry_id}/thumb`、
`/{entry_id}/previews/{n}/thumb` 由本机带已保存凭据转发，不接收 URL 或路径。
缩略图不落盘，响应 `Cache-Control: private, max-age=60`；主机仍逐请求检查共享状态。


### 网关共享中转（ADR-0035）

- `PUT /gateway/v1/shares/{share_id}/manifest`：`SharedLibraryManifest`（extra forbid），响应 `{missing: sha256[]}`。`share_id=sh_[a-z0-9]{12}`，最多 10000 条，单文件不超过 500 MiB。
- `PUT .../blobs/{sha256}`：流式文件，摘要及大小必须与暂存清单一致；`POST .../commit` 校验完整后原子生效；缺文件 422 含 `missing`，保留旧清单。`DELETE /gateway/v1/shares/{share_id}` 停止本人共享。
- 清单字段：`share_id/name/owner_name/updated_at/entries`；条目只有 `entry_id/kind/title/author/mime_type/width/height/duration_s/tags/category/prompt_text/file/previews`，文件 `{sha256,size,filename}`、效果图 `{sha256,size}`。不接受 key_id、路径或生成快照。密钥决定归属；越权/停止 404、校验 422、超限 413、磁盘错误 503。
- `GET /gateway/v1/libraries` 合并主机与成员库，排除请求者自己的成员库；成员库 id 为 `ms_<key_id>_<share_id>`。资产列表增加 `has_content`；`.../assets/{entry_id}/content` 返回登记 MIME 的原文件 attachment。原文件代理 `/api/gateway-libraries/{alias}/{library_id}/assets/{entry_id}/content` 流式回传，不落盘。
- 本机 `/api/gateway-shares` GET 返回 `{libraries:[{id,name,owner_name,updated_at,counts,size_bytes}],size_bytes}`；DELETE `/{library_id}` 主机停止共享，旧 share_id 不可重新发布。`@host` 是本机存储浏览源的保留别名。
- `.config/team-library-gateway-share.json`：`{shared_library_ids,publishes:{[library_id]:{share_id,gateways:{[alias]:{synced_at,error,status,uploaded,total,delete_pending}}}}}`。status 为 pending/syncing/synced/failed/stopped。发布状态仅本机管理接口可见。
- 网关密钥创建请求新增可选 `token` 后缀（`[A-Za-z0-9_-]{16,64}`）；服务端加 `atg_`。与任何现存记录（含已撤销）重复时 422。POST `/api/gateway/keys/{key_id}/reset` 及对应管理员路由生成新密钥，旧密钥立即失效。

## 插件（ADR-0012 / ADR-0037）

只挂本机服务，不上局域网网关。Agent 会话不能访问。

- `GET /api/plugins`：`{app_version, plugins: PluginEntry[]}`。`PluginEntry = {id, availability, reason, enabled, manifest}`；`availability` 为 `ok`（可启用）/ `incompatible`（清单合法，但版本范围、SDK 版本、capability 或必需大文件当前不支持；`reason` 是给用户看的一句话）/ `invalid`（清单读不出，`manifest` 为 `null`，`reason` 是技术原因）。一个插件无效不影响列表里的其他项。`manifest` 是包锁文件全文。
- `POST /api/plugins/{plugin_id}/enable`、`.../disable`：本机管理类。返回与列表接口相同的结构。未知插件 404 `PLUGIN_NOT_FOUND`；不可用的插件启用时 409 `PLUGIN_UNAVAILABLE`，`message` 为不可用原因。停用任何状态的已知插件都允许。
- `GET /api/plugins/{plugin_id}/package/{file}`：已启用插件的包内文件，只放行锁文件 `files` 里登记的路径；未启用 404 `PLUGIN_DISABLED`，其他情况 404 `PLUGIN_FILE_NOT_FOUND`。响应 `application/octet-stream` + `nosniff` + `no-store`；宿主按 `files[].sha256` 核对后才放进沙箱。
- 错误体：`{detail: {message, code}}`。
- 除以上四条外，`/api/plugins/` 下的路径一律 403；插件服务端模块的路由要在清单 `contributes.server.routes` 里逐条声明后才可达。

`<data_root>/.config/plugins.json`：`{schema_version: 1, plugins: {[id]: {enabled, enabled_at?, digest?}}}`，`enabled_at` 为 UTC ISO 8601。整份文件损坏时按全部未启用处理，原文件改名为 `plugins.json.broken-<UTC 时间>` 保留；单条不合规只忽略该条；清单里已不存在的插件 id 原样保留。记录为启用但清单失效或不兼容的插件不算启用。

包锁文件 `plugins/<id>/package/manifest.lock.json`：源清单全部字段 + `files: [{path, sha256, bytes}]` + `source: "bundled"` + `digest`。`digest = "sha256:" + SHA-256(去掉 digest 键后，按键排序、无空白、非 ASCII 不转义的 JSON)`。清单字段见 `lib/plugin_manifest.py`；清单不接受未知字段。

### 项目批准与插件界面协议（B2）

- `GET /api/canvas/projects/{project_id}/plugin-grants`：`{grants: {[plugin_id]: {capabilities, granted_at}}}`，只列当前有效的批准——插件已启用，且它现在声明的能力都在批准过的范围内。插件更新后能力没有增加则沿用，增加了就不再出现在结果里，需要重新批准。
- `PUT .../plugin-grants/{plugin_id}`（编辑类）：按插件当前清单记录批准；插件未启用或不存在 409 `PLUGIN_DISABLED`。`DELETE` 撤销。未知项目 404 `PROJECT_NOT_FOUND`。
- 存储 `<data_root>/canvases/<project>/plugin-grants.json`：`{schema_version: 1, grants: {[plugin_id]: {digest, capabilities, granted_at}}}`。不进项目包。文件读不出按没有批准处理。
- 画布文档：`CanvasPluginNodeData` 增加可选 `package_digest`（`sha256:` + 64 位十六进制）。指向插件节点的输入连线必须无 slot、非标注；保存时只对**新增**的这类连线按清单核对（插件已启用、节点类型已声明、素材类型在 `input_modalities` 内、不超过 `max_inputs`），不通过 422 `canvas_plugin_connection_rejected`。已有连线与文档读取不依赖插件是否存在。
- 插件界面协议 `atelier-plugin/1`：类型在 `plugins/sdk/protocol.ts`，宿主实现在 `web/src/plugin-host/`。宿主在沙箱页面加载后向它发送握手消息并附带一个 `MessagePort`，此后只在该 port 上通信。插件在 port 上的第一条消息必须是 `{type: "atelier-plugin:ready", nonce}`，nonce 取自宿主前缀脚本放在 `window.__atelierPluginNonce` 的值；宿主收到正确的 nonce 之前不服务任何方法，收到别的消息即断开。方法：`node.readSelf`、`node.writeSelf`、`inputs.list`、`inputs.read`、`fonts.request`；事件：`theme.changed`、`node.changed`、`inputs.changed`。协议里没有节点、项目、路径参数；素材用只在本界面实例有效的句柄指代。

### 插件服务端路由与 Agent 工具（B3）

- 清单 `contributes.server.routes[]`：`{method: "POST", path, access: "read" | "edit", long_running}`。只有随应用发布的插件可以声明。
- `POST /api/plugins/{plugin_id}/routes/{path}`：请求体 `{project_id, node_id, inputs: version_id[], params: object}`（不接受其他字段），响应 `{result}`。鉴权能力取清单里该路由的 `access`；插件未启用或路由未声明时在鉴权层就是 403，不进入处理函数。
- 服务端独立校验（不依赖浏览器侧）：插件已启用 → 路由已声明 → 本项目的批准有效且含 `server.call` → `node_id` 是本项目里属于该插件的节点 → `inputs` 里每个版本都是此刻以输入连线连到该节点的图片的当前版本。错误码：`PLUGIN_NOT_GRANTED`、`CAPABILITY_DENIED`、`INVALID_TARGET`、`INVALID_HANDLE`（均 403），`BAD_REQUEST`（422，`message` 为处理函数给用户的原因），`PLUGIN_FAILED` / `PLUGIN_BROKEN`（500，不带细节），`DOCUMENT_CONFLICT`（409）。
- 服务端模块 `plugins/<id>/server/__init__.py` 导出 `register(api)`，用 `@api.route("POST", path)` 登记 `handler(ctx, params) -> dict`。模块在第一次调用时才 import，插件停用时卸载，包摘要变化后重新加载。`ctx.inputs` 是核对过的图片（含服务端路径，不回传界面）；`ctx.create_image(png, title)` 需要 `resource.create`，结果落成画布上的普通图片节点（`upload` 来源）；`ctx.image_of_node(node_id)` 只在 Agent 调用时可用。
- 插件界面协议增加方法 `server.call {path, params, inputs: handle[]}`（能力 `server.call`）与错误码 `SERVER_ERROR`（`message` 为服务端给用户的原因）。浏览器侧把句柄换成版本 id 后转发；路径必须符合清单的 path 格式。
- 内置 Agent：已启用插件的 `contributes.agent_tools[]` 以 `plugin_<id 下划线化>_<name>` 为名加入工具列表，每次组装 Agent 时读取一次。`read_only` 的工具不需确认，其余按当前权限模式；调用同样要求本项目已批准该插件。外部 MCP 的工具列表不变。

### 宿主插件（ADR-0039）

- 清单 `runtime: "sandbox" | "host"`，缺省 `sandbox`。是否为宿主插件以服务端白名单 `plugin_registry.HOST_PLUGIN_IDS` 为准：白名单外的包声明 `host`、或白名单里的包不声明 `host`，一律 `availability = "invalid"`，不能启用。宿主插件不声明 `ui`、`capabilities`、`agent_tools`。目前有 `storyboard`（分镜）与 `ps-bridge`（PS 联动）。
- 宿主插件的界面是宿主代码，编进 `web/dist/assets/<id>.js` 单独的分块，只在插件启用时由画布 import（前端白名单 `web/src/plugin-host/hostPlugins.ts`）；插件关闭时不加载这个分块，它的节点显示占位、`payload` 原样保留。
- 清单新增贡献点 `contributes.text_actions[]`：形状同 `image_actions`，按钮出现在文本节点工具栏。沙箱插件的 `create_node` 从文本节点连一条输入线到新节点，目标节点必须收 `text`；宿主插件不连线，把来源节点交给插件代码。
- `POST /api/plugins/{plugin_id}/routes/{path}` 的 `node_id` 改为可选：沙箱界面必须带；宿主插件走 `origin = "host"`，不检查项目批准与输入，其余（已启用、路由已声明、读写类别、结果大小）不变。沙箱插件不能走宿主入口（403 `CAPABILITY_DENIED`）。插件错误体可带 `raw`（遮掉密钥的上游原文）：`{detail: {message, code, raw?}}`。
- 服务端模块可用 `@api.agent_view(node_type)` 登记 `view(document, node) -> dict`，画布 Agent 的 `get_canvas` 把它合进该节点的行；只有宿主插件可以登记，插件关闭时不调用、不 import。

### 安全修复后的补充（B2 安全验收）

- 宿主页面（`index.html` 及所有回落到它的地址）响应头带 `Content-Security-Policy: frame-src 'none'`；`/assets/*` 不带。
- 批准记录绑定包摘要：记录里的 `digest` 与当前包一致才直接有效；不一致时仅 `source == "bundled"` 且能力未增加才沿用，并把记录回写为新摘要。
- 写入节点与调用服务端的数据只接受纯 JSON 且字符串必须是合规的 Unicode（不含孤立代理字符）；大小按 UTF-8 字节计，超限即拒。

### 编辑面板与帧数据（B4）

- 清单 `contributes.image_actions[]` 的 `create_node` 动作出现在图片工具栏「更多」菜单里：宿主在图片右侧建插件节点并连一条输入连线，`open_panel` 为真时在批准通过后打开编辑面板。
- 插件节点声明了 `panel` surface 时，双击节点打开编辑面板（宿主的对话框，内容是同一个界面包以 `surface: "panel"` 运行）。节点内容面不接收指针事件。
- 界面协议增加方法 `ui.close`（不需要能力）：请求宿主关闭面板。SDK 在面板里把 Esc 接到它。
- 服务端模块上下文增加 `ctx.create_text(text, title)`（需要 `resource.create`）：落成画布上的普通文本节点，走与 Agent 相同的变更集入口，正文上限 40000 字符。
- 精灵表调整的 `/repack` 接受 `frame_data: true`：把帧数据 JSON（`{frames:[{x,y,w,h,anchor_x,anchor_y}], meta:{size,columns,rows,cell}}`）落成文本节点，返回 `frame_data_node_id`；超过上限时返回 `frame_data_error`，图片照常生成。

### 精灵表的逐帧编辑（B4 补充）

- 节点数据（`payload`，版本 1，新字段都可缺省）：`frames[]` 每项 `{x, y, w, h, ox?, oy?, ax?, ay?}`，`ox` / `oy` 是逐帧偏移（像素，±512），`ax` / `ay` 是这一帧单独的锚点（0–1，两个都要有，省略时用整表锚点）；`grid {columns, rows, margin, spacing}`；`columns`、`spacing`、`margin`、`align`、`trim`（默认 true）、`anchor {x, y}`（0–1 比例，默认 0.5 / 1）、`fps`、`onion`。
- `/repack` 接受上述字段：每帧先按 `trim` 裁透明边，格子取所有帧最大宽高，按 `align` 放好后再加偏移，超出格子的部分裁掉。返回的每帧 `anchor_x/anchor_y` 按该帧的锚点（有单独锚点用它的，否则用整表的）算，`meta.anchor` 是整表锚点，都是 `floor(格宽 × x)`、`floor(格高 × y)`。
- 界面预览与服务端用同一套排布算法，两端都跑 `plugins/sprite-sheet/tests/layout_cases.json`。

### 视频素材、结果组与视频工具栏动作（序列帧 F0）

- 服务端模块的 `ctx.inputs` 是核对过的素材 `PluginMedia {kind, node_id, version_id, title, path, width, height, duration_ms}`，`kind` 为 `image` / `video` / `audio`。界面调用时，素材类型必须在该插件节点类型的 `input_modalities` 里（插件更新收窄了类型后，旧连线上的素材同样被拒，`INVALID_HANDLE`）。
- `ctx.media_of_node(node_id, kinds)` 按节点 id 取素材，只认 `kinds` 里的类型，只在 Agent 调用时可用；`ctx.image_of_node(node_id)` 等于 `kinds=("image",)`。
- `ctx.create_image_group(pngs, title, beside_node_id=None)`（需要 `resource.create`）：把 1–65 张 PNG（单张 ≤ 64 MiB，合计 ≤ 256 MiB）在**一次提交**里落成一个结果组：封面标题 `title`，成员 `title · 2` 起编号；封面的 `result_stack = {run_id: "plugin:<id>:<随机串>", member_node_ids}`；整组在插件节点右侧找一个不压其他节点的位置，成员与封面顶端对齐、间距 16。返回 `{node_id, member_node_ids}`。
- 清单新增 `contributes.video_actions[]`，形状与 `image_actions[]` 相同（两者在 schema 里同为 `PluginMediaAction`）。已启用插件声明了视频动作时，视频节点工具栏最右出现「更多」，点击 `create_node` 动作在视频右侧建插件节点并连一条输入线。`create_node` 的目标节点类型必须在 `input_modalities` 里收对应素材（图片动作收 `image`、视频动作收 `video`），否则清单无效。
- 插件界面读取素材（`inputs.read`）时，素材文件超过 256 MiB 直接拒绝（`PAYLOAD_TOO_LARGE`），不读入沙箱。

### 序列帧插件：视频抽帧（`plugins/frames`，F1）

- 节点类型 `extract`「视频抽帧」：收 1 个视频；视频工具栏「更多 → 抽帧」建节点并打开面板。
- 节点数据（`payload`，版本 1）：`{start, end, mode, count, step, rate, long_edge, sheet, columns, frame_data}`。`start` / `end` 是帧号（从 0 起，`end` 含在内，`null` 表示到最后一帧）；`mode` 为 `count`（区间内均匀取 `count` 帧，含首尾）、`step`（每隔 `step` 帧）、`rate`（每秒 `rate` 帧，间隔 = 视频帧率 / `rate`，不足 1 帧按 1 帧）；`long_edge` 为输出按长边缩放的像素（16–4096），`null` 为原尺寸。
- 抽帧计划的取整一律 `floor(x + 0.5)`，去重后升序，最多 65 帧；界面与服务端跑同一份 `plugins/frames/tests/plan_cases.json`。
- 路由：`POST /probe`（读）返回 `{width, height, fps, frame_count, duration_ms, title}`；`POST /preview`（读）返回 `{frames, size, fps, thumbnails}`，`thumbnails` 是长边 160 的 JPEG data URL，与 `frames` 一一对应；`POST /extract`（写）按帧号精确解码（顺序解码，不按时间跳转），落成结果组，返回 `{node_id, member_node_ids, frames, size}`，`sheet` 为真时另外拼一张精灵表（格间 2 像素全透明，帧数据与精灵表调整 `/repack` 同一格式）放在结果组右侧，返回 `sheet_node_id`，`frame_data` 为真时再返回 `frame_data_node_id`。
- Agent 工具：`plugin_frames_probe`（只读，参数 `video_node_id`）、`plugin_frames_extract`（参数 `video_node_id` 加上述抽帧、尺寸与输出字段）。

### 结果组作为插件输入（P3）与补间（`plugins/frames`，F2）

- 节点贡献新增 `expand_result_stack`（默认 false，要求 `input_modalities` 含 `image`）。为真时，连到该插件节点的结果组封面连同组内此刻存在的成员按组内顺序交给插件；`inputs.list` 的每项新增 `group`（同组素材为封面的句柄，否则 `null`）；同一版本只列一次。服务端核对同样把「连着的封面所在组的成员」算作已连接，成员被移出结果组后立即失效。
- 宿主转发插件的 `server.call` 前先把页面上未保存的编辑落盘（新建的插件节点要先存到服务端才能通过节点归属核对）；落盘失败时返回 `SERVER_ERROR`「画布还没保存好，请稍后重试」，不发请求。
- 节点类型 `tween`「补间」：收 2 张图片或 1 个结果组（`expand_result_stack`），图片工具栏「更多 → 补间」建节点并打开面板。节点数据（版本 1）：`{method: "flow"|"crossfade", between, output: "all"|"new", swap, sheet, columns, frame_data}`。帧序列：有结果组时用第一组（组内顺序），否则用两张图（`swap` 交换首尾）。
- 路由：`POST /tween_preview`（读，参数 `method`、`pair`、`t`，默认 0.5）返回 `{url, pairs}`，`url` 是长边 384 的中间帧 data URL；`POST /tween`（写）在每对相邻帧之间补 `between`（1–15）帧，`output` 为 `all` 时含原帧，总数最多 65；落成结果组（封面标题「<首帧标题> 补间」），返回 `{node_id, member_node_ids, frame_count}`，`sheet` / `frame_data` 与抽帧相同。第二帧尺寸不同时按第一帧等比缩放，宽高比差超过 1% 拒绝。
- 算法：交叉淡化按预乘 alpha 线性混合；光流为 OpenCV DIS（MEDIUM 预设）双向估计，两帧各按 t 反向变形后线性混合，光流在合成到中性灰底的 RGB 上计算，RGBA 四通道用同一组光流变形。
- Agent 工具 `plugin_frames_tween`：参数 `image_node_ids`（2–65 个，按播放顺序）加上述补间与输出字段。

### 生成草稿（P4）与首尾帧补间（`plugins/frames`，F3）

- 新能力 `generation.draft`（批准弹窗短语「准备生成任务」，「?」里说明「你点生成后才会计费」）。服务端模块 `ctx.create_generation_draft(prompt, first_node_id, last_node_id, title)` 用变更集一次提交：`add_surface`（video）+ `set_draft`（`frame_mode: "firstlast"` 加模型默认参数）+ 两条带 `slot` 的 `connect`。不创建 Job，不请求厂商。
- 模型选择：画布视频默认偏好里指定了供应商与模型且该模型能做首尾帧时用它，否则按供应商顺序（默认供应商在前）取第一个能做首尾帧的视频模型。能做首尾帧的判定与参数取自 `video_caps.first_last_video_defaults`，只覆盖前后端判断一致的协议：Seedance（1.0 最短 2 秒、比例取最接近首帧的固定比例；1.5 与 2.x 最短 4 秒、`adaptive`；均 480p、`watermark: false`）、可灵旧接口（5 秒、最接近的比例）、可灵 3/4 系（`max_frames == 2` 的型号，最短时长与最低分辨率）。其余协议（HappyHorse、OpenRouter、自定义接口等）不替用户选。
- 补间节点路由 `POST /tween_draft`（写，参数 `pair`、`prompt`）：对帧序列里第 `pair` 与 `pair+1` 帧建草稿，返回 `create_generation_draft` 的结果。

### 像素化插件（`plugins/pixel`，X1）

- 节点类型 `pixelate`「像素化」：收 1 张图片或 1 个结果组（`expand_result_stack`），图片工具栏「更多 → 像素化」建节点并打开面板。能力与精灵表调整相同，没有新增平台能力。
- 节点数据（版本 1）：`{size_mode: "long_edge"|"block", long_edge (8–512), block (2–64), downsample: "mode"|"average", palette: {kind: "auto", colors (2–64)}, shared_palette, alpha_threshold (1–255), upscale (1–16), keep_original_size}`。
- 算法只在服务端：目标网格按长边（不放大源图）或按块大小（四舍五入）；主色降采样取每格出现最多的调色板色，格内透明像素过半则该格透明；平均降采样按预乘 alpha 缩小后再量化；自动调色板为 Lab 空间 k-means（固定种子），只统计不透明像素，按亮度排序；映射走 5 位 RGB 查找表；输出 alpha 只有 0 / 255；放大为整数倍最近邻。
- 路由：`POST /palette`（读）返回 `{colors}`；`POST /preview`（读，加 `frame`）返回 `{url, size, colors}`，`url` 是实际像素尺寸的 PNG data URL；`POST /pixelate`（写）单张输出一个图片节点、多张输出结果组（标题「<首张标题> 像素」），`upscale > 1` 且 `keep_original_size` 时另出一份实际像素尺寸（「… 原尺寸」），返回 `{node_id, member_node_ids?, frame_count, size, colors, original_node_id?}`。
- Agent 工具 `plugin_pixel_pixelate`：参数 `image_node_ids`（1–65）加上述设置字段。

### 像素化插件：调色板与修饰（X2）

- 节点数据新增：`palette.kind` 为 `auto` / `preset` / `custom`，`palette.preset`（`pico-8` / `gameboy` / `db16` / `db32` / `endesga-32` / `nes`），`palette.custom`（`#RGB` 或 `#RRGGBB`，逗号、空白或换行分隔，2–256 色）；`dither: {kind: none|bayer2|bayer4|bayer8|floyd, strength 0–100}`；`cleanup: {isolated: 0|4|8, min_region: 0–16}`；`outline: {enabled, connectivity: 4|8, color: "darkest"|"#RRGGBB"}`。
- 预设调色板的色值随插件包入库：`plugins/pixel/server/palettes.json`，取自 Lospec 公开调色板库（每套带来源 url，2026-11-15 按 `.json` 原样复制，测试逐色核对 PICO-8）。Game Boy 用 Lospec 的「Nintendo Gameboy (bgb)」4 色；NES 为 55 色。面板只显示调色板名称与色块，色值只在服务端。
- 处理顺序：降采样与映射 → 抖动 → 清理 → 描边。抖动需要连续色调，开启后颜色取格内平均（即使选了主色）。Bayer 偏移量 = 矩阵值（归一化到 ±0.5）× 255/round(k^(1/3)) × 强度；Floyd–Steinberg 用 Pillow 实现（按 RGB 距离，不看强度）。去孤立像素：与四周不透明邻居都不同色的像素换成邻居里最多的颜色，四周全透明的单个不透明像素变透明。合并小色块按 4 连通、面积小于 `min_region` 的同色块并进周围最多的颜色。外描边在不透明区域外圈 1 像素，颜色默认取调色板里亮度最低的颜色。
- 新路由 `POST /presets`（读）返回 `{presets: [{id, name, colors}]}`。Agent 工具参数同步增加上述字段。

### 精灵表调整接收结果组（X3）

- 精灵表节点类型开启 `expand_result_stack`。帧新增可选字段 `src`（源图序号，省略为 0）；`/repack` 的源图是界面带来的全部图片（结果组按组内顺序），帧按 `src` 取图；界面带来多张图又没给 `frames` 时，每张图一帧（整张图，再按 `trim` 裁透明边）。`src` 越界或不是整数时返回 422「帧的来源图不对」。`/detect` 与手动网格仍只针对第一张图。
- Agent 工具 `plugin_sprite_sheet_repack` 新增 `image_node_ids`（1–65 个，按顺序，每张图一帧），与 `image_node_id` 二选一。
- 服务端 `sheet.repack(sources, frames, …)` 的第一个参数改为源图列表。

## 首次启动引导（2026-11-17）

- `GET /onboarding/status` 在 bootstrap 结果上多带 `onboarding_skipped: bool` 与 `keys_recovered: {backup, at} | null`：`needs_first_key` 且未跳过（或刚备份过损坏配置）时前端显示「连接一个模型」整页，跳过后进首页。服务端把 `needs_data_root` 静默补成默认目录 `~/game-atelier`、把 `needs_keys_repair` 的 keys.json 改名备份为 `keys.json.corrupt-<时间>` 后按 `needs_first_key` 返回，前端只见 `ready | needs_first_key`。更新信息只读缓存，源码版在后台联网刷新缓存。
- 首启遇到损坏的供应商 JSON 时，在 `keys.lock` 内复读确认后备份原始字节。对于可解析但版本或结构不受支持的配置，保留原件，`GET /onboarding/status` 及供应商读写接口返回 409。
- 新增或编辑供应商时遇到本机文件权限、文件占用或空间不足，接口返回 503 和相应的中文说明。表单可导出诊断日志。
- `GET /data-root` → `{data_root, move}`；`POST /data-root {path}` 更换数据目录（规格 D1）：目标与当前相同不动；目标不存在或为空 → 后台复制（跳过 `.venv/` 与 `.runtime/` 下本次服务的运行文件，JSON 里的旧目录绝对路径前缀改写为新目录）、逐文件校验后切换指针，原目录保留；目标已有 `.config/` 或 `canvases/` → 直接切换；其他非空目录、当前目录的上级或子目录 → 409。有进行中的生成时 409。`move = {phase: idle|copying|verifying|done|failed, mode: copy|switch|null, source, target, total_bytes, copied_bytes, total_files, copied_files, error, detail, started_at, finished_at}`；复制期间除 `/api/connection/*` 外的写请求一律 503 `code=moving_data_root`（未受理，可原样重发）。
- `GET /ui-prefs` → `{prefs}`；`PUT /ui-prefs/{key} {value}`（`value: null` 删除）。存 `.config/ui-prefs.json`，键名 `[a-z0-9][a-z0-9_.-]{0,63}`，整份 ≤ 64 KiB。当前用到 `announcements-seen: string[]`、`changelog-seen: string`；不随端口变化丢失。
- `POST /onboarding/events`（204）：本机度量，只收枚举。`event ∈ guide_opened | path_selected | step_opened | models_detected | key_probed | provider_saved | skipped | closed`；可选 `source ∈ first_run | model_chip | providers`、`path ∈ key | chatgpt | comfyui | gateway | other`、`vendor ∈ tuzi | tokendance`、`step ∈ signup | topup | key_page | key_form`、`count`（0–10000）、`result ∈ ok | invalid | unknown`。其他字段或取值返回 422。`skipped` 同时写入跳过时间。
- `GET /onboarding/metrics`：`first_seen_at`、`data_root_set_at`、`skipped_at`、`paths_tried`（`key:tuzi` 形式）、`completed_path`、`last_event`、`first_generation`（`.runtime/jobs/` 里 `completed_at ≥ data_root_set_at` 的第一条 DONE）、`seconds_to_first_generation`、`event_count`。
- 存储：`<data_root>/.runtime/onboarding.json`，事件最多 500 条，只存本机、不上报。`first_seen_at` 为服务进程首次回 `needs_data_root` 的时间，选定数据目录时落盘，复用旧目录不覆盖。
- `POST /onboarding/key-probe {preset, access_key}` → `{result: ok | invalid | unknown}`：只对服务端写死的厂商账户接口发一次请求（tuzi / openai-hk：`/v1/dashboard/billing/subscription`；openrouter：`/api/v1/key`；tokendance：`/portal/api/v1/user/balance`；seedream：Ark `/models`），不计费。401/403 或响应体带 `error` 为 invalid，网络失败与其他状态为 unknown。密钥只用于这一次请求，不落盘。结果只用于提示，不拦保存。

### Studio Agent

首次读取 `session-default-studio` 或列出会话时，服务端在会话锁内创建缺失的默认会话，初始标题为「默认会话」。`GET /api/studio/agent/sessions` 将它列在首位，其余会话按 `updated_at` 倒序。POST 创建普通会话（201，可同时提交模型和创作设置）。详情端点 `/api/studio/agent/sessions/{session_id}` 支持 GET、PATCH。默认会话沿用普通会话的设置、消息、附件和计划接口。删除默认会话返回 400，`detail` 为「默认会话不能删除」。

删除普通会话须在 `If-Match` 中提供客户端看到的 revision。缺失返回 428，版本过期返回 409，原轮次继续运行。匹配后，服务端阻止新的会话写入，停止后台轮次，待其退出后逐个锁定该会话的任务，同时清空会话与轮次字段。全部任务退回默认会话后，才清理会话、计划和附件并返回 204。任务读写失败返回 500，会话文件保留，重试只退回仍属于该会话的任务。已提交的 Studio Job 继续运行，产物和用量保留。会话、计划和附件分别位于数据目录的 `studio-agent/sessions`、`studio-agent/plans`、`studio-agent/uploads/{session_id}`。

公开会话返回 `turns`、`messages`、`pending_approvals` 与设置。每个轮次的 `steps` 记录稳定的 `step_id`、`tool`、面板可见的 `summary` 和 `status`（running / completed / failed / interrupted / rejected）。Studio 的助手正文以服务端收到该次模型回复的时间写入 `messages[].created_at`。同轮内工具调用前的说明、Job 的 `submitted_at`、工具调用后的总结依此排序，审批续跑沿用该轮。待确认项返回 `call_id`、`tool` 与摘要。原始工具参数、SDK history 和上传索引仅在服务端读取。`studio-agent` SSE 事件携带 `session_id`、`turn_id` 与 `kind`，包括 delta、tool、step、session、plan。step 携带同形步骤，按 `step_id` 更新。重连后可从详情读取完整轮次。

以下路径均接在会话详情端点后。

- `POST /attachments` 接收单个 multipart 图片并返回 attachment_id。`GET /attachments/{attachment_id}` 读取本会话已登记的图片。
- `POST /messages` 接收 `{client_message_id,text,skill?,attachment_ids?,asset_ids?}`，锁内认领轮次并返回 202。同一消息 ID 重放只执行一次。
- `POST /approvals` 沿用画布的 decisions 与逐项勾选。`GET /approvals/{call_id}/items` 返回批次估价明细。Studio 的逐项明细和确认摘要共用同一估价行，包含模型显示名、实际数量与脱敏提示词的前 40 字，超长以省略号结尾。`POST /cancel` 停止当前轮次。更新维护期间禁发新消息，已接入轮次仍可审批或停止。更新等待同时统计 Studio 的运行中和待审批会话。服务重启时将遗留的运行中轮次记为 interrupted，保留待审批轮次。
- `GET /jobs` 返回当前会话的 Studio 手动任务和 Agent 任务。默认会话同时包含显式指定默认 ID 的任务和会话字段为空的历史任务。普通会话只包含会话 ID 匹配的任务。Agent 的 `get_run` 与 `read_media` 读取任务时遵守同一归属规则。历史任务文件按原样保留。
- `GET /plan` 和 `GET /usage` 分别返回当前会话计划和累计对话用量。模型、技能、生成模型、确认金额共用已有 `/api/canvas/agent` 全局端点。

Studio Job 的 API 投影提供可选只读字段 `studio_agent_session_id` 与 `studio_agent_turn_id`。只有 studio 命名空间可有会话关联，turn_id 必须随 session_id。关联保存在 Job 文件的 `params._studio_agent` 扩展中，旧版可读取和回写同一任务文件。会话字段为空的 Job 省略此扩展。Agent 提交时写入会话与轮次，手动再次生成时按当次请求确定会话归属。生成用的参考媒体复制到 `.runtime/uploads` 后登记在普通 JobParams 中。每个生成项创建一个 Job，count 存入 n。批次 1–20 项，每项最多 4 份，声明式视频只支持 1 条。视频按实际提交条数乘单价估价，超出协议上限的请求在审批前退回。批次按规范化后的参考和控制参数估价，超过阈值先确认。同一轮内模型复用生成调用 ID 时，相同参数重放复用原 Job；更改生成参数产生新请求，重新估价并应用当前确认规则。提交期间部分成功的任务保留。

对话模型用量沿用 `.runtime/agent-usage/YYYY-MM.jsonl`。Studio 请求、待结算项和主机结算行都标记 `workspace=studio`、`project_id=null`，网关调用标记为 `studio:<session_id>:<revision>`。缺少 workspace 的旧行属于画布。读取单个 Studio 会话只结算该工作区、该会话的用量。

两个工作区共用的 Agent Skill 列表与导入结果含布尔字段 `builtin`。内置 Skill 同名导入返回 422，删除返回 403。工具 `load_skill({names})` 接受 1–3 个名称，按顺序返回 `skills`，每项含名称和带标签的正文或单项错误。

Auto 确认金额按最近一条用户消息之后已提交的生成估价累计。并行调用预占估价，批量只累计成功提交的项，未计价项不计金额。生成工具结果的可选字段 `submitted_estimate_cny` 供确认后恢复本轮合计。批量确认明细可带 `turn_estimate_cny`（此前已提交估价，元）。

## 回收站

删除项目、对话、已付费的一轮结果时，各功能的删除接口调 `lib/trash.py` 的 `move_to_trash(kind, label, paths, meta)`，把文件或目录整体移进 `<data_root>/.runtime/trash/<trash_id>/items/`，`manifest.json` 记数据目录相对原路径、`kind`（`project` / `conversation` / `round`）、`label`、`deleted_at` 与 `meta`。路径必须在数据目录内（段名按 casefold 比较），数据目录本身、`.config/`、`.runtime/` 顶层、回收站与锁目录不能移；任一步失败全部移回。保留 30 天，服务启动时清理过期条目（读不出清单的按目录修改时间算）。锁在 `.runtime/locks/trash.lock`，调用方的领域锁在外、回收站锁在内；还原需要领域锁或善后的类型用 `register_restore_handler(kind, handler)`。

只给本机页面（manage）：

- `GET /api/trash` → `{items: [{trash_id, kind, label, deleted_at, expires_at, days_left, meta}]}`，新删的在前。
- `POST /api/trash/{trash_id}/restore` → 还原后的同形条目；原路径被占用 409 `TRASH_CONFLICT`（message 指出哪一项），找不到 404 `TRASH_NOT_FOUND`。
- `DELETE /api/trash/{trash_id}` → `{ok: true}`，彻底删除。
- `DELETE /api/trash` → `{purged: n}`，清空。

## 局域网共享画布 v1

本机会话通过 `/api/collab/status`、`/api/collab/shares` 与 `/api/collab/peers` 读取监听状态、自有共享和发现列表。房主通过 `PUT /api/collab/shares/{project_id}` 设置权限和口令。省略口令保留原值，空串清除口令。`DELETE` 停止该画布共享。访客在本机的远端项目代理上调用 `auth`、`document` 和 `versions/{version_id}/media`。局域网端口仅提供协作协议，见 ADR-0045。

画布内容版本支持可选的 `frozen_generation`，表示来源生成快照 v1，含模态、提示词、模型 ID、平台名称和品牌图标、公开参数、按顺序存放的参考输入、费用与耗时。参考输入通过当前项目中的版本 ID 引用媒体，文本可内联。节点的可选 `created_by` 和 `created_by_client` 分别记录显示名与协作客户端身份。

ComfyUI 的 `params.workflow_inputs` 按来源模型声明的创作控件 ID 保存可公开的标量值。提示词和文件输入沿用各自的快照字段，私有配置与本机路径不进入控件映射。目标机器可以在尚未安装该工作流时保留映射，执行时按选中模型的控件声明校验。

复刻视频时，草稿保留 `params.seed`，0 是有效的固定种子。复刻 Midjourney 媒体时，风格、角色及全能参考的输入连线分别带有 `mj_role: "mj_sref" | "mj_cref" | "mj_oref"`，按原角色进入生成请求。普通垫图无需此字段。

`POST /api/collab/remote/{peer_key}/projects/{project_id}/copy-to-local` 接收 `node_ids`、`target_project_id` 和可选的 `document_revision`，返回更新后的本地画布。相同前缀的 `send-to-studio` 接收 `version_id`，返回本地上传路径及快照。`POST /api/studio/jobs/{job_id}/shared-canvas` 接收 `peer_key`、`project_id` 与 `output_index`，将结果与参考媒体作为一笔操作写入房主画布。

局域网和本机代理的项目端点均提供 `ws`、`uploads`、`image-edits`。本机房主使用项目的 owner WebSocket。房间通过 `hello_snapshot` 确认身份和初始版本，`presence_state` 更新成员与选区。`submit_op` 带 `op_id` 和 `base_revision`，服务端按会话确定作者。节点级增量按 `op_applied` 的基准版本应用，失配时重新读取完整文档。恢复操作通过 `undo_of` 引用本人已确认的操作。房主改权限即时通知，改口令或停止共享则关闭旧连接。

离线另存复用 `copy-to-local`。媒体的可选 `pending_shared_original` 保存房主、源项目和版本标识。缺原件时仍可显示已获取的缩略图，重新取得读取权限并验证 MIME、字节数和 SHA-256 后会清除标记。

插件清单 `contributes.nodes[].shared_fields` 可列出路径，例如 `["title", "shots.caption"]`。只复制命中的标量或标量数组。第三方插件在共享画布中只读。缺少匹配声明的投影带有 `shared_placeholder: true`，复制到本地后仍显示占位。

官方分镜的 `plugin_payload_update` 同时传入编辑前的公开 `base_payload` 与修改后的载荷。房主按条目 ID 和改动字段合并，保留原有私有字段。同一列表的结构变更发生冲突时，房主通过 `op_rejected` 提示重新编辑。

官方分镜的 `plugin_payload_update` 同时发送编辑前的公开 `base_payload` 与编辑后的 `patch.data.payload`。房主按条目和镜头的稳定 ID 合并发生变化的字段，保留本机原文与私有字段。直接改动含脱敏原文的字段、并发修改相同列表结构时返回 409。

### 共享画布生成

访客在本机项目代理调用 `POST runs/local`。请求携带 `surface_node_id`、`expected_revision`、访客本机模型与供应商别名，以及可选提示词、参数和候选数量。访客服务先在房主端 `POST runs/reserve`，之后每 10 秒向 `runs/{run_id}/heartbeat` 续期。房主端 `commit` 接受 multipart 成片、冻结快照、输入素材和图层，按事务落盘。`fail` 记录失败，超过 90 秒未续期则标记中断。

两条生成提交接口都要求 `request_id`（32 位小写十六进制）。同一次生成重试时沿用原始请求体及画布版本。并发提交或回执丢失后，服务返回已受理的同一任务；同一个标识换用不同生成参数返回 409。版本冲突后再次提交可更新预期版本，并沿用同一标识。用户确认发起下一次生成时分配新标识。

启用借用后，同一代理通过 `GET borrowable-models` 获取房主开放的直连模型与价格。房主仅公布渠道的不透明标识、模型、品牌和公开能力。访客通过 `POST runs/borrowed` 提交选中的 `channel_id` 与模型。房主在受理和实际调度前核对共享权限、渠道与模型。普通节点、局部修改、扩图和图层拆分复用房主现有 Canvas Run。

节点可选的 `collab_run` 存放任务编号、来源节点、执行渠道、发起人和状态。状态含 `pending`、`done`、`failed`、`interrupted`。用量按实际执行方记录。房主的画布任务记录 `JobParams.collab_guest_name` 和 `collab_guest_client`，访客本机执行的任务记录 `collab_source_canvas`。

访客生成完成但回传未获确认时，本机把成功的候选原件和冻结参数保存至「未回传的生成结果」画布。多张候选按原顺序组成可展开的结果组，任务部分成功时保留其中已生成的图片。


### 本机错误诊断导出

本机界面通过 `GET /api/diagnostics/export` 下载 UTF-8 JSON 附件，文件名为 `atelier-diagnostics-YYYYMMDD.json`。接口受本机浏览器会话保护。

报告包含 `schema_version`、UTC 导出时间 `exported_at`、导出时的应用版本 `app_version`、系统类别 `os` 和 `events`。每条事件包含 UTC 时间 `time` 与类别 `event`。其中 `traceback`、`key_read_failed` 和 `key_save_failed` 记录异常类型 `exception`、可能为空的 `errno` 和 `winerror`，以及最多 6 个产品源码相对位置 `locations: [{file, line}]`。报告从本机当前服务日志和最近 3 份按日轮转的日志读取，每个文件最多取末尾 1 MiB，共保留最后 100 条事件。没有匹配记录时返回空数组。

官方 Windows 和 macOS 桌面安装另外读取同一运行环境下固定 `shell.log` 的末尾 1 MiB。`desktop_renderer_gone` 记录已知异常退出原因 `reason` 和可用的数值 `exit_code`，旧版本缺少退出码时返回 `null`。`desktop_server_restart` 记录外壳检测到服务停止后尝试重启的时间。来源代码模式和便携包只导出服务诊断。
