# 生成价格清单维护

静态渠道的单价维护在 [generation_prices.json](../../src/character_workflow/data/generation_prices.json)。
Tuzi 与 TokenDance 使用本机同步快照；Tuzi 表达式仅在服务端执行，前端不保存第二套公式。

## 价格表索引

| 渠道 | 表项 | 单位 |
|---|---|---|
| OpenAI-HK | `OPENAI_HK_FIXED_YUAN_PER_IMAGE`、`OPENAI_HK_NANO_BANANA_2_YUAN` | 元 / 张 |
| EvoLink Midjourney V8.2 | `EVOLINK_MIDJOURNEY_USD_PER_REQUEST` | 美元 / 请求，最多四张结果仍只计一次 |
| Tuzi | `.runtime/prices/tuzi.json` | 公开表达式或固定请求价，经人民币系数换算 |
| TokenDance（全部模型） | 不入价格表，见下方「TokenDance 实时同步」 | 按其接口：元 / 张、元 / 百万输出 token、元 / 秒 |
| 火山 Ark Seedream | `ARK_SEEDREAM_YUAN_PER_IMAGE` | 元 / 张 |
| 火山 Ark Seedance | `ARK_SEEDANCE_YUAN_PER_MILLION_TOKENS` | 元 / 百万输出 token |
| 阿里 DashScope HappyHorse | `HAPPYHORSE_1_0_YUAN_PER_SECOND`、`HAPPYHORSE_1_1_YUAN_PER_SECOND` | 元 / 秒 |

## TokenDance 实时同步：2026-10-25 起

TokenDance 的价格不进 `generation_prices.json`。viewer-server 启动时（之后每 6 小时）对 keys 里配置的
TokenDance 模型请求公开接口 `GET https://tokendance.space/portal/api/models/{slug}`（`a:b` 变体按冒号前的 slug 查），
把返回的 `pricing` 存成 `<data_root>/.runtime/prices/tokendance.json`；单个模型拉取失败保留旧价格。
前端经 `GET /api/pricing/tokendance` 读同一份快照，服务端估价（`generation_pricing._tokendance`）与界面估价
（`generationCost.ts`）解析规则相同：

- 图片：`*generated_images` / `*:images` 项按张计价；带 `range` 的按输出千像素分段，不知道输出尺寸且各档不同价时不估。
  输入图片的附加费（如 seedream-5.0-pro 每张参考图 0.02）不计入预计。
- 视频：`skus` 按 `resolution`（`*` 为通配，指定分辨率优先）与 `has_video`（有参考视频为 true）匹配；
  `unit=seconds` 按时长，`unit=millionTokens` 按 `时长 × 宽 × 高 × 24 / 1024` 输出 token，宽高沿用方舟 Seedance 尺寸表。
- 接口不标币种；不含视频的 Seedance 档与火山方舟官方价一致，按人民币处理。
- 没有快照的模型返回 null（未计价）。任务的预计在执行前冻结，快照之后变化不影响历史。

## EvoLink Midjourney V8.2：2026-10-15 核实

来源为 EvoLink [Midjourney V8.2 模型页](https://evolink.ai/zh/midjourney-v8-2)。
本次仅接入 `mj-v8.2`：普通生成固定 Fast / Standard，外图局部编辑由
`params.image_edit` 切换到 `mj-v8.2-upload-paint`，固定 Fast。具体美元金额维护于价格表，
对应 5.4 / 8.1 credits；两条路由都按请求计费，一次最多四张，`n` 不参与费用倍乘。

估价仅匹配 EvoLink 官方 API 地址及精确模型，沿用现有 USD × 7 的人民币展示规则，
该换算仅为估算。EvoLink 不使用 Tuzi `billing_group`。其他 EvoLink 型号、HD、Draft
及尚未接入的派生操作不在本次价格承诺内。实际费用和历史快照仍遵循下文规则。

## Tuzi 实时同步：2026-10-25 起

服务启动及每6小时请求 [公开价格接口](https://api.tu-zi.com/api/pricing) 与
[状态接口](https://api.tu-zi.com/api/status)。仅保留已配置的Tuzi分组、模型及caller转换后的实际请求模型，
写入 `.runtime/prices/tuzi.json`。任一接口失败或人民币系数无效时保留旧快照。

按实际请求模型查分组表达式，计算后乘 `usd_exchange_rate`；无表达式时仅接受
`quota_type=0` 且 `model_price>0`，按 `model_price × group_ratio × usd_exchange_rate` 计算。
固定价按方案以一次请求计，不额外乘 n；表达式中的 `output_image_count` 使用请求 n，
`input_image_count` 使用参考图数量。不估计重试、补图与动态拆层的额外费用。
请求参数沿用caller的质量及型号转换；局部修改与扩图通过 `POST /api/pricing/estimate` 获取费用。
创作台的Tuzi前端估价返回null，由runner执行前冻结，历史费用不重算。

解释器使用分词器和递归下降解析，只执行核实过的函数和运算。上游
[源码](https://github.com/QuantumNous/new-api/blob/9823ebc7ea4ac7102d5d8478d395c7d7eaf6c285/pkg/billingexpr/run.go)
核实了tier、param、has及时间函数；时区由表达式参数指定，周日为0。
Tuzi扩展 `imageSizeTier` / `imagePixels` 未找到定义，用户裁决为：含这些函数的整个表达式
返回未计价并在同步日志报警，不猜尺寸算法。因此当前多种GPT Image及香蕉模型暂不显示预计费用。
未知变量、未核实参数、缺失快照或不支持协议同样不估价。

2026-10-25 对账结论（公开样本，不发起收费生成）：

- `nano-banana-pro` 实际发出 `gemini-3-pro-image-preview`，样本1K公式为0.142×0.7=0.0994；
  别名公式的0.1197不适用于该请求。因表达式含未核实函数，当前返回未计价。
- GPT Image 2样本2K上界为3,686,400像素，旧文档为4,194,304；2048²按样本公式推算由0.12变0.21。
  这是价表差异记录，不代表已经验证通用图片函数。
- `mj_imagine`为0.5×0.7=0.35；`mj_fast_imagine`为0.215×0.7=0.1505。
  两者不能混用。用户裁决：MJ暂未计价，生成路由不变。
- 共享用例179组、近30天77条任务去重41组，合计220组逐条对账记录在本地任务日志。
  额外差异按用户裁决记录，已知公式采用公开快照，未核实表达式保留未计价。

## OpenAI-HK GPT Image 2.5：2026-09-09 补录

来源为用户确认的厂商消耗：`gpt-image-2.5-sunburst` 和 `gpt-image-2.5-flare`
均为每张 2400 积分，即 ¥0.24。金额维护于 `OPENAI_HK_FIXED_YUAN_PER_IMAGE`，
仅匹配 `openai-hk.com` 及其子域名与这两个精确型号，按张数计算，不随 quality 分档。
不套用到其他渠道、相近后缀或历史任务；旧型号价格不变。

## 下次调价

1. 核对渠道、分组、模型、档位和单位；同一模型的别名共用单价，不重复填数。
2. 只在 `generation_prices.json` 改对应数字，并在本文更新日期与来源说明。前后端共同读取此文件；两端估价公式由共享用例校验。
3. 更新已有 `generationCost.test.ts` 中对应价格断言。新增计费维度或模型路由时，才需改计算逻辑。
4. 清理并重建前端（`make build`），暂存预期的 `web/dist`，运行 `make verify`；发布后刷新页面。

调价仅影响新提交的 `params.estimated_cost_cny`。历史只读取提交时快照；有
`actual_cost_cny` 时优先实际扣费，不因现价更新重算。OpenRouter 使用响应里的实际费用，
不维护推测单价。完整费用语义见 [provider-config.md](provider-config.md#已核实媒体价目)。
