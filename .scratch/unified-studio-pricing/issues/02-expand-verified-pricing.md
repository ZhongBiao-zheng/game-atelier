# 02 — 扩展已核实渠道计价

- Type: feature
- Status: ready-for-human
- Blocked by: remaining provider pricing documents

## 已确认

- 美元固定按 `1 USD = ¥7` 折算人民币。
- OpenAI-HK 改为按图固定价格；只有 Nano Banana 2 区分基础 / 2K / 4K。
- Tuzi 按计费分组定价；当前用户使用 `default`。
- Tuzi `default` 已确认 GPT Image 2、Seedream 4.5、Seedream 5.0 Pro、Nano Banana Pro、Nano Banana 2。
- Tuzi“绘画”分组目前只确认 GPT Image 2 为 `¥0.21 / 张`。
- Tuzi Midjourney 固定 `¥0.1505 / 任务`，四张拆分结果不重复计费。
- TokenDance Seedream 5.0 Lite / Pro 按张计费：`¥0.22 / ¥0.30`。
- TokenDance Seedance 2.0 / Fast / Mini / 2.5 已按截图记录常规输出 Token 费率；火山方舟限时折扣按有效期自动参与计价。
- Seed 2.0 Lite 等文本模型暂不纳入计价范围。
- OpenRouter 图片与视频成功响应均返回美元 `usage.cost` 时，按 7 折算并保存实际人民币费用；缺失时才按官方图片 endpoint pricing / 视频 pricing_skus 估算。
- OpenRouter 当前 4 个图片模型与 4 个视频模型的官方 SKU 已记录到 PRD。

## 实现前置

- 给 Key 配置增加显式 `billing_group`；未配置或未知分组时不展示 Tuzi 价格。
- 核对 OpenAI-HK Nano Banana 2 与 Tuzi Nano Banana 系列的基础 / 2K / 4K 实际请求字段映射。
- TokenDance Job 必须能确定实际路由服务商，或在完成后读取实际服务商 / 用量；未知时不按最低价猜测。
- 核对 TokenDance 输出 Token 公式是否与现有 Seedance 公式一致：`duration × output_pixels × 24 / 1024`。
- 促销截止时间按北京时间 `2026-09-17 14:00` 处理；截止前用促销价，截止时刻起恢复常规价，并使用可注入时钟测试边界。
- 图片总价统一乘以生成张数；提交时写入 `estimated_cost_cny` 快照。
- 更新现有错误价格：OpenAI-HK GPT Image 2 应从旧规则改为固定 `¥0.08 / 张`。
- 对已经按旧规则回填的 7 条 OpenAI-HK 历史记录，在新规则落地时重新生成一次性修正清单并保留回滚备份。
- 给 Job 增加实际费用字段（或等价的明确来源字段）；历史优先实际费用、其次提交预计费用，不能把实际账单伪装成预计值。
- OpenRouter 图片 caller 保存响应 `usage.cost`；视频 caller 保存终态轮询响应 `usage.cost`。若响应缺失且无法唯一选择 SKU，则不计价。
- OpenRouter 官方价目属于动态数据：估算时应冻结当次 SKU 与抓取时间，不能用新价回算旧任务。

## 待用户提供

- Tuzi“绘画”等非 `default` 分组的其他模型。
- TokenDance Seedance 自动路由时应使用哪个服务商费率，以及 API 是否返回实际路由与输出 Token。
- TokenDance HappyHorse、Kling、MiniMax。
- 文本模型是否纳入创作台费用历史，以及对应输入 / 输出 Token 单价。

## Comments

- 2026-08-28：用户确认固定汇率、OpenAI-HK 固定图片价、Tuzi `default` 分组图片价；其余文档后续逐项补充。
- 2026-08-28：用户补充 Tuzi Midjourney 单任务价与 TokenDance Seedream / Seedance 费率截图；临时促销价与常规价分开记录。
- 2026-08-28：用户确认 TokenDance Seedream 图片价按张、文本模型暂不计价、促销按有效期自动生效；实际路由与输出 Token 留待真实调用探测。
- 2026-08-28：核对 OpenRouter 官方 Image / Video Models API；确定成功后优先使用响应 `usage.cost`，并记录当前项目 8 个媒体模型的官方 SKU。
- 2026-08-28：运行时代码已落地 OpenAI-HK、Tuzi 分组、TokenDance Seedream 图片价；OpenRouter 图片/视频实际费用回写，历史优先实际费用。TokenDance Seedance 继续等待真实路由探测。
