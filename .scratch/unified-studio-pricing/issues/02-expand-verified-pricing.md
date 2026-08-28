# 02 — 扩展已核实渠道计价

- Type: feature
- Status: in-progress
- Blocked by: remaining provider pricing documents

## 已确认

- 美元固定按 `1 USD = ¥7` 折算人民币。
- OpenAI-HK 改为按图固定价格；只有 Nano Banana 2 区分基础 / 2K / 4K。
- Tuzi 按计费分组定价；当前用户使用 `default`。
- Tuzi `default` 已确认 GPT Image 2、Seedream 4.5、Seedream 5.0 Pro、Nano Banana Pro、Nano Banana 2。
- Tuzi“绘画”分组目前只确认 GPT Image 2 为 `¥0.21 / 张`。
- Tuzi Midjourney 固定 `¥0.1505 / 任务`，四张拆分结果不重复计费。
- TokenDance Seedream 5.0 Lite / Pro 已记录 `¥0.22 / ¥0.30`，计费单位待最终确认。
- TokenDance Seedance 2.0 / Fast / Mini / 2.5 已按截图记录常规输出 Token 费率；限时折扣单独记录，不进入长期静态规则。

## 实现前置

- 给 Key 配置增加显式 `billing_group`；未配置或未知分组时不展示 Tuzi 价格。
- 核对 OpenAI-HK Nano Banana 2 与 Tuzi Nano Banana 系列的基础 / 2K / 4K 实际请求字段映射。
- TokenDance Job 必须能确定实际路由服务商，或在完成后读取实际服务商 / 用量；未知时不按最低价猜测。
- 核对 TokenDance 输出 Token 公式是否与现有 Seedance 公式一致：`duration × output_pixels × 24 / 1024`。
- 图片总价统一乘以生成张数；提交时写入 `estimated_cost_cny` 快照。
- 更新现有错误价格：OpenAI-HK GPT Image 2 应从旧规则改为固定 `¥0.08 / 张`。
- 对已经按旧规则回填的 7 条 OpenAI-HK 历史记录，在新规则落地时重新生成一次性修正清单并保留回滚备份。

## 待用户提供

- Tuzi“绘画”等非 `default` 分组的其他模型。
- TokenDance Seedream 5.0 Lite / Pro 的计费单位，Seed 2.0 Lite 的单价与模态。
- TokenDance Seedance 自动路由时应使用哪个服务商费率，以及 API 是否返回实际路由与输出 Token。
- TokenDance HappyHorse、Kling、MiniMax。
- OpenRouter 图片与视频。
- 文本模型是否纳入创作台费用历史，以及对应输入 / 输出 Token 单价。

## Comments

- 2026-08-28：用户确认固定汇率、OpenAI-HK 固定图片价、Tuzi `default` 分组图片价；其余文档后续逐项补充。
- 2026-08-28：用户补充 Tuzi Midjourney 单任务价与 TokenDance Seedream / Seedance 费率截图；临时促销价与常规价分开记录。
