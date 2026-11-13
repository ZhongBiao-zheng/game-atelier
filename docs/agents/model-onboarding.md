# 新增模型流程规范

适用于接入新模型、新版本（如 GPT Image 2.5 → 2.6）或模型新增参数 / 新产物格式。目标是让「用户在界面里能选到、参数真的发出去、产物能回来、价格和耗时有数、用户知道上线了」五件事一次做齐，不留无头管线。

每一步都有机械判据；「印象里做过」不算。过程记录放 `.scratch/<model-slug>/PLAN.md`，长期事实进项目文档。

## 0. 定范围

先写清三件事，再动代码：

- 模型 id 全集：官方 id、带日期快照、各聚合商的别名或 slug（`openai/...`）。
- 新增能力：哪些参数、哪些产物格式是这一版新的；哪些能力只在部分渠道有（按 `GET /models` 描述符定，不按文档）。
- 不做的部分和原因（写进 `docs/api-contract.md` 对应节）。

## 1. 搜集信息

| 来源 | 要拿到的 | 怎么核实 |
|---|---|---|
| 官方发布页 | 发布日期、定位（速度 / 质量）、宣传图 og:image | 浏览器打开，不信转述 |
| 官方 API reference | 参数名与枚举、尺寸规则（倍数 / 比例 / 像素上下限）、端点限制（如只在 generations） | 逐字抄参数名；guide 与 reference 冲突以 reference 为准并记下冲突 |
| 官方价格页 | 按 token 或按张的价格 | 只认官方页 |
| 本机各网关 | 是否已上架、是否配价 | `GET /v1/models` + 免费探针（缺 `prompt` 的 POST，看是 404 / 价格未配置 / 400 缺参） |
| OpenRouter | `GET /images/models` 的 `supported_parameters` | 描述符没有的参数不发（协议级限制，不是模型能力） |

免费探针和阈值探针的用法见 `~/.claude` 记忆 `gateway-endpoint-by-model-protocol`；被拒的请求也可能计费（Tuzi 实测），探针只发缺必填参数的请求。

## 2. 能力登记（代码清单）

能力按模型判，不按 provider；provider 只决定端点与协议。改完每一行都要有对应测试。

| 层 | 位置 | 内容 |
|---|---|---|
| 尺寸 AUTO 白名单 | `src/character_workflow/lib/image_size.py`（OpenAI / HK / Tuzi 三份）、`web/src/lib/imageControlCaps.ts` 同名三份 | 只收验证过或按同系推定并标注的 id |
| 渠道档位 | `src/character_workflow/lib/image_size_catalog.py`、`image_size_catalog.json`（OpenRouter 精确 slug） | 质量档、K 档、比例 |
| 模型族 / 能力判据 | `src/character_workflow/lib/callers/openai_image.py`（`image_family`、`supports_*`） | 新能力加 `supports_<能力>(model)`，前端 `web/src/lib/imageControlCaps.ts` 同判据；注意前端 `normalizedModelId` 不归一 `.` |
| caller 请求体 | 各 `callers/*.py` 的 payload 构造 | 「控制产物外观 / 容器」的参数显式发；官方默认值可不发但要写注释说明原因 |
| 参数契约 | `src/character_workflow/lib/schemas.py` `JobParams` + `web/src/schema/jobs.ts`；Canvas 的 `CANVAS_DRAFT_PARAM_FIELDS` 与 `CanvasImageDefaultParams`；网关 `gateway_tasks._IMAGE_PARAMS` | 双端声明，少一处前端拿不到类型或服务端 422 |
| 参数随模型清理 | `canvas_runs._normalized_image_preference_params`、`web/src/lib/imageSizeMode.normalizeImageSizeParams` | 换到不支持的模型时丢掉专属字段 |
| 计价 | `openai_hk_prices.estimate` 白名单、`generation_pricing.py`、`tests/fixtures/generation_cost_cases.json`、`web/src/lib/generationCost.ts` | 新 id 不进白名单就显示不了价格 |
| MCP 目录 | `canvas_model_catalog.py` capabilities | Agent 看得到新能力 |

### 新产物格式（GIF、SVG 等）额外清单

产物扩展名白名单散在各层，漏一处就是「厂商已计费、本地静默丢弃」。按数据流顺序：

1. `callers/image_output.py` 文件头签名
2. `job_runner.image_dimensions_from_bytes` 的 parser
3. `asset_versions._IMAGE_EXTENSIONS`
4. `canvas_runs._OUTPUT_MIME`
5. `viewer_server/routes.py` `_GALLERY_EXTS`、`viewer_server/watcher.py`
6. `gateway_tasks.allowed_suffixes`
7. 缩略图 / 转码对新格式的行为（`canvas_thumbnails`）

判据：`grep -rn '".webp"' src/` 列出的每一处都过一遍。

## 3. UI

- 模型目录 `web/src/lib/modelCatalog.ts`：名称、品牌、英文一句介绍、排名（数组顺序即热度），规则见 `.scratch/model-picker/PLAN.md` 与 `docs/design/components.md`。
- 控件：Studio（`PromptInput` 尺寸弹层）与 Canvas（`CanvasGenerationControls`）两处都要有；新控件抽成共用组件放 `web/src/components/studio/`。
- 回显：历史卡片 chip（`RoundList`）、画布摘要与元数据（`CanvasGenerationMetadata`）、再次生成回填（`studioJobConfig` / `studioParameterReuse`）。
- 偏好：画布生成偏好只记住「跨任务稳定」的参数（如质量、规划强度），当次选择（张数、GIF）不记。
- 真实页面验证：Studio 与画布各截一张图，换到旧模型确认控件消失。

## 4. 价格与耗时

- 费用预估来源按渠道：HK 单张快照白名单、Tuzi 计费表达式、TokenDance / OpenRouter 用量回传。新 id 进白名单后，网关配价即生效。
- 真实测试（计费，先按 `CLAUDE.md`「先问再做」取得授权；用户明确说「测」即可直接跑）：
  - 每个已上架渠道至少 1 张最低档文生图；
  - 每项新能力各 1 次（如 GIF 一次、新参数非默认值一次）；
  - 记录：渠道、参数、耗时（`submitted_at → completed_at`）、实际费用（`params.actual_cost_cny` 或账单）、产物格式是否符合预期（翻文件头，不翻文档）。
- 结果写 `docs/references/generation-pricing.md`（账单证据）与 `.scratch/<model-slug>/PLAN.md`；模型菜单的耗时中位数由 `/api/models/durations` 从成功任务自动算，至少 3 条才显示。

## 5. 公告与日志

- 公告存在 `src/character_workflow/data/announcements.json`，数组开头插一条：稳定 id、日期、`version`、标题、两行以内的摘要（定位 / 新能力 / 渠道与价格，显示宽度 ≤52 字：英文数字按半个算，有测试校验）、官方 og:image 外链（https）、`models[].ids` 列全官方 id 与聚合商 slug（「快速添加」靠它匹配）。
- 本机服务打包一份兜底，启动后（之后每 6 小时）从 CNB / GitHub 的 main 拉同一个文件；只返回 `version` 不高于本机版本的公告。同版本同一天的公告在弹窗里翻页。
- **要改代码才能用的模型**：公告与能力登记放同一个版本，`version` 填那一版；发版提交时在 `web/src/lib/changelog.ts` 开头加条目（有断言钉死）。不先发公告后补能力。
- **不用改代码的模型**（现有判据已覆盖，「快速添加」后直接能用）：只改 JSON 推 main，不 bump、不打 tag；`version` 填当时已发布的最新版本（`version` 必须在 changelog 里有条目，有测试校验）。推送后已安装的客户端最晚 6 小时内、或重启服务后看到。

## 6. 文档

- `docs/api-contract.md`：新参数、端点限制、不做的部分与原因。
- `docs/references/provider-config.md` / `generation-pricing.md`：渠道与价格证据。
- `CONTEXT.md` / `docs/adr/`：只在新增领域对象或不可逆决策时。

## 7. 验收清单

- [ ] 0 范围写清，不做的部分有原因
- [ ] 1 官方参数名逐字核对，各网关上架 / 配价状态有探针结果
- [ ] 2 能力登记每一行有测试；`make test` 全量绿（不是只跑自己的文件）
- [ ] 2 新产物格式：七处白名单逐一过
- [ ] 3 Studio + Canvas 控件、回显、偏好；真实页面截图；旧模型控件消失
- [ ] 4 每渠道 1 张 + 每项新能力 1 次真实请求，耗时与费用记录在案；产物文件头核对
- [ ] 5 公告置顶 + changelog（发版时）
- [ ] 6 文档同步
- [ ] `make verify` 通过，提交推送 `main`，daily memory 记录
