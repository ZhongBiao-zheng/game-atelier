# 生成价格清单维护

**唯一单价源：[generationPrices.ts](../../web/src/lib/generationPrices.ts)。**
它是一份按渠道与计费单位分组的数据表，界面估价直接引用，不需要再维护一份副本。
`generationCost.ts` 仅负责渠道、分组、型号和参数匹配，以及按张数／时长／token 计算总价。

## 价格表索引

| 渠道 | 表项 | 单位 |
|---|---|---|
| OpenAI-HK | `OPENAI_HK_FIXED_YUAN_PER_IMAGE`、`OPENAI_HK_NANO_BANANA_2_YUAN` | 元 / 张 |
| Tuzi default 香蕉 Pro | `TUZI_GEMINI_3_PRO_YUAN_PER_IMAGE`，按 1k / 2k / 4k | 元 / 次（一张） |
| Tuzi default GPT Image 2 | `TUZI_GPT_IMAGE_2_YUAN_PER_IMAGE`，按最终 size 的精确白名单与总像素分 1k / 2k / 4k | 元 / 次（一张） |
| Tuzi default GPT Image 2 固定 1K 型号 | `TUZI_GPT_IMAGE_2_1K_YUAN_PER_IMAGE` | 元 / 张 |
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

## Tuzi GPT Image 2：2026-09-04 更新

来源为用户提供的 Tuzi 调价公告，并核对了 Tuzi [公开价表 API](https://api.tu-zi.com/api/pricing)
的 `group_model_pricing.default.billing_expr["gpt-image-2"]`。2K 下调，1K 与 4K 保持不变，
另增独立固定价型号 `gpt-image-2-1k`；具体金额只维护在对应数据项。

- 仅对 `tu-zi.com` 及其子域名、`billing_group=default`、精确型号 `gpt-image-2` 生效。
- 最终提交并冻结到 Job 的 `size` 精确命中 `TUZI_GPT_IMAGE_2_1K_SIZES` 中 11 个尺寸时按 1K
  计费（`x` 大小写不敏感）：`1254x1254`、`1024x1536` / `1536x1024`、`1086x1448` /
  `1448x1086`、`1122x1402` / `1402x1122`、`1672x941` / `941x1672`、`1915x821` / `821x1915`。
- 其他尺寸按**总像素数**：≤1,048,576 为 1K，≤4,194,304 为 2K，再大为 4K。
  不再按最长边，也不能把 11 个精确尺寸扩展成邻近尺寸范围或统一的约 157 万像素阈值。
- 界面现有 `quality=low/medium/high/auto` 不参与该分组计价；缺失或非法 size 不展示估价。
  上游计费表达式还支持原始 `quality=1K/2K/4K` 或 `generationConfig.imageConfig.imageSize`
  优先指定档位，工坊当前的 GPT Image 参数不发送这些值，不能把 high 猜成 4K。
- 界面的 GPT Image 自定义尺寸仍按 16 的倍数对齐；按对齐后的最终 size 计价。例如输入
  `1254x1254` 会变成 `1248x1248`，不再命中精确白名单，应算 2K。
- 同渠道、同 default 分组的精确型号 `gpt-image-2-1k` 按独立固定价 × 张数估算，不看 size
  或 quality；提交时保留该型号 ID，厂商负责映射到最近比例的 1K 尺寸，不保证请求的 2K/4K 输出。
  此次不自动修改用户的 Key 模型列表，可在设置中拉取或添加该模型。
- 公告另列 Tier 5 账号的 1K 优惠价为 ¥0.024 / 张；当前 Key 配置没有账号等级字段，
  估价器不自动套用该优惠，仍按普通 default 单价计算。
- `绘画` 分组仍使用自己的固定单价；OpenAI-HK 与其他渠道不套用这张表。
- 这次只记录 Tuzi 在服务端按参数选择内部渠道的事实；工坊仍把最终 size 原样发给 Tuzi，
  不在本地复制其内部路由。

核对时公开模型描述中出现“表外即使小于 1K 也按 2K”的冲突文字；实际计费表达式与用户公告
均把 ≤1,048,576 像素归为 1K，因此采用计费表达式，不采用该冲突描述。

## 下次调价

1. 核对渠道、分组、模型、档位和单位；同一模型的别名共用单价，不重复填数。
2. 在 `generationPrices.ts` 改对应数字，并更新附近的日期与来源说明。
3. 更新已有 `generationCost.test.ts` 中对应价格断言。新增计费维度或模型路由时，才需改计算逻辑。
4. 清理并重建前端（`make build`），暂存预期的 `web/dist`，运行 `make verify`；发布后刷新页面。

调价仅影响新提交的 `params.estimated_cost_cny`。历史只读取提交时快照；有
`actual_cost_cny` 时优先实际扣费，不因现价更新重算。OpenRouter 使用响应里的实际费用，
不维护推测单价。完整费用语义见 [provider-config.md](provider-config.md#已核实媒体价目)。
