# 生成价格清单维护

**唯一单价源：[generationPrices.ts](../../web/src/lib/generationPrices.ts)。**
它是一份按渠道与计费单位分组的数据表，界面估价直接引用，不需要再维护一份副本。
`generationCost.ts` 仅负责渠道、分组、型号和参数匹配，以及按张数／时长／token 计算总价。

## 价格表索引

| 渠道 | 表项 | 单位 |
|---|---|---|
| OpenAI-HK | `OPENAI_HK_FIXED_YUAN_PER_IMAGE`、`OPENAI_HK_NANO_BANANA_2_YUAN` | 元 / 张 |
| Tuzi default 香蕉 Pro | `TUZI_GEMINI_3_PRO_YUAN_PER_IMAGE`，按 1k / 2k / 4k | 元 / 次（一张） |
| Tuzi default GPT Image 2 | `TUZI_GPT_IMAGE_2_YUAN_PER_IMAGE`，按最终 size 的最大边分 1k / 2k / 4k | 元 / 次（一张） |
| Tuzi 其他已核实型号／分组 | `TUZI_GROUP_YUAN_PER_IMAGE` | 元 / 张 |
| Tuzi default Midjourney | `TUZI_MIDJOURNEY_YUAN_PER_TASK` | 元 / 任务，拆成四张仍只计一次 |
| TokenDance Seedream | `TOKEN_DANCE_YUAN_PER_IMAGE` | 元 / 张 |
| 火山 Ark Seedream | `ARK_SEEDREAM_YUAN_PER_IMAGE` | 元 / 张 |
| 火山 Ark Seedance | `ARK_SEEDANCE_YUAN_PER_MILLION_TOKENS` | 元 / 百万输出 token |
| 阿里 DashScope HappyHorse | `HAPPYHORSE_1_0_YUAN_PER_SECOND`、`HAPPYHORSE_1_1_YUAN_PER_SECOND` | 元 / 秒 |

## Tuzi 香蕉 Pro：2026-08-31 更新

来源为用户在本次任务提供的 Tuzi 调价公告：`gemini-3-pro-image` 与
`gemini-3-pro-image-preview` 是同一模型，已由统一每张计价改为 1K / 2K / 4K 三档。
具体金额只维护在上表对应的数据项，不在本文复制。

- 仅用于 `tu-zi.com` 及其子域名、明确配置 `billing_group=default` 的 Key。
- 工坊的 `nano-banana-pro` 展示别名共用该表；`quality=low/medium/high` 分别对应 1K/2K/4K。
- `nano-banana-pro-2k` / `nano-banana-pro-4k` 按型号固定档位，忽略残留 quality。
- 无 quality 或 auto 时沿用 caller 的 1K 默认值；不从其他模型遗留的 resolution 推断。
- VIP、HD、其他分组与未知后缀没有核实价格，不能自动套用该公告。
- 其他型号与渠道沿用原有核价；提取为独立表不代表重新核实了全部厂商价格。

## Tuzi GPT Image 2：2026-09-03 更新

来源为用户提供的 Tuzi 调价公告：default 分组按请求参数分流，1K 于 2026-09-03 再次
下调，2K 与 4K 继续合并为同一单价。Tuzi 的[图像 API 文档](https://api.tu-zi.com/docs/api/images)要求记录请求的
`size` 与 `quality`；模型页同时注明 default 分组可指定 `size`、`quality` 不保证可靠。因此：

- 仅对 `tu-zi.com` 及其子域名、`billing_group=default`、精确型号 `gpt-image-2` 生效。
- 按最终提交并冻结到 Job 的像素 `size` 判档：最大边 ≤1024 为 1K，1025–2048 为 2K，
  >2048 为 4K；横图、竖图与自定义尺寸使用同一规则。
- `quality` 不参与计价；缺失或非法 size 不展示估价，避免误报 1K 低价。
- 公告另列 Tier 5 账号的 1K 优惠价为 ¥0.024 / 张；当前 Key 配置没有账号等级字段，
  估价器不自动套用该优惠，仍按普通 default 单价计算。
- `绘画` 分组仍使用自己的固定单价；OpenAI-HK 与其他渠道不套用这张表。
- 这次只记录 Tuzi 在服务端按参数选择内部渠道的事实；工坊仍把最终 size 原样发给 Tuzi，
  不在本地复制其内部路由。

## 下次调价

1. 核对渠道、分组、模型、档位和单位；同一模型的别名共用单价，不重复填数。
2. 在 `generationPrices.ts` 改对应数字，并更新附近的日期与来源说明。
3. 更新已有 `generationCost.test.ts` 中对应价格断言。新增计费维度或模型路由时，才需改计算逻辑。
4. 清理并重建前端（`make build`），暂存预期的 `web/dist`，运行 `make verify`；发布后刷新页面。

调价仅影响新提交的 `params.estimated_cost_cny`。历史只读取提交时快照；有
`actual_cost_cny` 时优先实际扣费，不因现价更新重算。OpenRouter 使用响应里的实际费用，
不维护推测单价。完整费用语义见 [provider-config.md](provider-config.md#已核实媒体价目)。
