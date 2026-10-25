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
- 图层拆分（seedream-5.0-pro，`layer_decomposition`）拆前不知道层数，不做预估；完成时按厂商回传的 `usage` 与每层 `size` 结算写入 `actual_cost_cny`：每层按自身输出千像素选档计一张生成图，另加 `input_images` × 输入图单价（`generation_pricing.layer_decomposition_cost_cny`）。2026-10-25 按此规则回填了此前 7 次成功拆分（合计 ¥24.44）。

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
例外：Nano Banana 系列（实际请求 Gemini 3 Pro 等）一次只回 1 张，caller 按张补请求；Tuzi 账单（2026-10-25 只读核对 44 条）显示每次 generations 请求按表达式扣 1 次、`quantity=1`、与张数无关，因此表达式不含 `output_image_count` 时按 n 次请求计。GPT Image 2 一次请求能否回多张未核实，仍按一次请求计。
请求参数沿用caller的质量及型号转换；局部修改与扩图通过 `POST /api/pricing/estimate` 获取费用。
创作台的Tuzi前端估价返回null，由runner执行前冻结，历史费用不重算。

解释器使用分词器和递归下降解析，只执行核实过的函数和运算。上游
[源码](https://github.com/QuantumNous/new-api/blob/9823ebc7ea4ac7102d5d8478d395c7d7eaf6c285/pkg/billingexpr/run.go)
核实了tier、param、has及时间函数；时区由表达式参数指定，周日为0。
Tuzi扩展已由[官方定价计算器源码](https://api.tu-zi.com/assets/index-DMNydVyD.js)
（2026-10-25，tF / nF / sF）核实并接入：

- `imagePixels`：1K / 2K / 4K 分别为 1024² / 2048² / 4096²；尺寸用 X、*、× 分隔，
  两边按 Number 转为正整数后相乘；缺失、AUTO、非法尺寸返回0。
- `imageSizeTier`：同样识别三档名称；尺寸两边按 parseInt 读取，最长边达到
  1024 / 2048 / 3840 分别为1K / 2K / 4K，否则default。
- upper / lower 对缺失值返回空串，对字符串先去首尾空格；非法时区不估价。

现有样本108种尺寸输入与官方纯函数逐项一致；仅在本地对照官方纯函数，未发起生成。
未知变量、未核实参数、缺失快照或不支持协议同样不估价。

2026-10-25 对账结论（公开样本，不发起收费生成）：

- `nano-banana-pro` 实际发出 `gemini-3-pro-image-preview`，样本1K公式为0.142×0.7=0.0994；
  别名公式的0.1197不适用于该请求；现已按实际请求公式估价。
- GPT Image 2样本2K上界为3,686,400像素，旧文档为4,194,304；2048²按样本公式推算由0.12变0.21。
  图片函数核实后采用该公开公式。
- `mj_imagine`为0.5×0.7=0.35；`mj_fast_imagine`为0.215×0.7=0.1505。
  只读 `/api/log/token` 查到56条已有成功扣费：日志型号仍为 `mj_imagine`，
  `billing_detail.mode=mj_per_call`，每请求USD 0.215（展示系数0.7后为¥0.1505）。
  公开文档与任务查询未提供请求模式到计费SKU的确定映射，不能把历史单价当作当前通用价。
  MJ继续未计价，待官方确认默认模式及Fast / Relax / Turbo映射后接入；生成路由不变。
- 共享用例179组、近30天77条任务去重41组，合计220组逐条对账记录在本地任务日志。
  额外差异按用户裁决记录，已知公式采用公开快照，未核实表达式保留未计价。

## OpenAI-HK GPT Image 2.5：2026-09-09 补录

来源为用户确认的厂商消耗：`gpt-image-2.5-sunburst` 和 `gpt-image-2.5-flare`
均为每张 2400 积分，即 ¥0.24。金额维护于 `OPENAI_HK_FIXED_YUAN_PER_IMAGE`，
仅匹配 `openai-hk.com` 及其子域名与这两个精确型号，按张数计算，不随 quality 分档。
不套用到其他渠道、相近后缀或历史任务；旧型号价格不变。

## 下次调价

Tuzi已支持规则内的单价、系数与阈值调整会在下次同步生效，无须发版；新增函数或请求模式
需要先核实并更新解释器。同步失败保留旧快照。以下手工步骤仅适用于静态价格渠道。

1. 核对渠道、分组、模型、档位和单位；同一模型的别名共用单价，不重复填数。
2. 只在 `generation_prices.json` 改对应数字，并在本文更新日期与来源说明。前后端共同读取此文件；两端估价公式由共享用例校验。
3. 更新已有 `generationCost.test.ts` 中对应价格断言。新增计费维度或模型路由时，才需改计算逻辑。
4. 清理并重建前端（`make build`），暂存预期的 `web/dist`，运行 `make verify`；发布后刷新页面。

调价仅影响新提交的 `params.estimated_cost_cny`。历史只读取提交时快照；有
`actual_cost_cny` 时优先实际扣费，不因现价更新重算。OpenRouter 使用响应里的实际费用，
不维护推测单价。完整费用语义见 [provider-config.md](provider-config.md#已核实媒体价目)。
