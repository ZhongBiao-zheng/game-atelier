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

## 实现前置

- 给 Key 配置增加显式 `billing_group`；未配置或未知分组时不展示 Tuzi 价格。
- 核对 OpenAI-HK Nano Banana 2 与 Tuzi Nano Banana 系列的基础 / 2K / 4K 实际请求字段映射。
- 图片总价统一乘以生成张数；提交时写入 `estimated_cost_cny` 快照。
- 更新现有错误价格：OpenAI-HK GPT Image 2 应从旧规则改为固定 `¥0.08 / 张`。
- 对已经按旧规则回填的 7 条 OpenAI-HK 历史记录，在新规则落地时重新生成一次性修正清单并保留回滚备份。

## 待用户提供

- Tuzi Midjourney，以及“绘画”等非 `default` 分组的其他模型。
- TokenDance 图片、Seedance、HappyHorse、Kling、MiniMax。
- OpenRouter 图片与视频。
- 文本模型是否纳入创作台费用历史，以及对应输入 / 输出 Token 单价。

## Comments

- 2026-08-28：用户确认固定汇率、OpenAI-HK 固定图片价、Tuzi `default` 分组图片价；其余文档后续逐项补充。
