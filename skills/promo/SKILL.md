---
name: promo
description: |
  角色宣传图、KV、海报工作流：以立绘、三视图或用户上传图锚定每个角色身份，
  对话确认叙事瞬间、光线、构图与画幅，经工坊 MCP 准备生成并等待本机人工批准。
  用户要美宣、宣传海报、双角色 KV 或调用 /game-atelier:promo 时使用；默认无字底图。
---

# 角色美宣

默认单张出图，优先把一张图的叙事和构图做好。

先完整读取 [MCP 工作流](../../docs/references/workshop-mcp-workflow.md)，再读
[统一 Prompt 规则](../../docs/references/art-prompt-system.md)、
[美宣 Prompt](references/prompt-promo-zh.md) 与
[模型选择](../../docs/references/model-routing.md)。不运行直接生成的 shell 或任意文件操作。

## 定目标与身份锚

通过 `workshop_list_projects`、`workshop_list_targets` 选择明确角色，
target 的 `asset_slot` 为 `promo`。读 `workshop_get_context` 和完整
`character_spec`、`project_style`、`worldview`；应用当前项目美宣经验和反馈。

每个出镜角色必须有 spec 中的身份约束及实际身份图：portrait、turnaround 或用户上传图
均可；不能因没有 portrait 就拦截已具备其他身份图的美宣。缺失的角色先补资料。
所有素材必须已在当前目标正式登记，跨角色素材由用户在 Atelier 归入 / 引用后再取媒体 ID。

用 `workshop_list_media` 和 `workshop_read_media` 看实际图，按定稿、当前自己的成果、
已冻结的派生来源选择。旧定稿有过期标记先告知；不能暗中换父角色后来更新的图。

## 对话与创作

先确定具体的 `narrative_beat`、画幅、用途和文案留白。缺叙事动作或画幅先问；
“凄美”是情绪，不是动作。决策顺序是光线 → 情绪 / 场景温度 → 服装应强调的细节。

默认无字底图。标题、标语、logo、中文名称留给排版；需要文案时只留空白区。
用户明确要求把文字画入，才记录原文和风险，在生成摘要中明确展示，不擅自加字。

参考图清单按 `media_ids` 顺序逐张描述：
角色身份锚在前，每个出镜角色至少一张；互补视角按需添加；场景参考图、构图 / 光线图在后。
每张原图独立引用，不预拼联系表，不因模型上限不足偷偷丢图；上限不足先请画师取舍。

五段 Prompt：主题声明与参考协议 → 具体情节 → 光线色彩 → 构图镜头 → 风格质感。
通常 230–320 字、每段 1–3 句。情节段不复述被身份图锁定的发瞳毛色和装备清单；
每张参考图的简短可见描述与用途留在开头。引导构图而不写精确坐标，
不堆“8k / 大师级 / 高质量”，默认无排除段。风格可强化戏剧光影，但不擅自跨基础画风。

画师要清稿时读取 [清稿模板](references/prompt-templates/image-cleanup-zh.md)，
只针对实际碎渣 / 噪点 / 线条问题修正，不附加无关美术改造。当前图作为登记参考，
保持其画幅，并核对模型支持的尺寸。

## 保存与生成

- 修改美宣记录通过 `workshop_read_document`、`workshop_write_document` 更新当前
  `character_spec`，记录全部 media ID、名称、用途和文本例外，不只记第一张来源。
- `workshop_list_models` 确认可用能力，默认一张；参数与参考顺序核对后，
  `workshop_prepare_generation` 准备请求。
- 请用户到本机 Atelier「待批准生成」人工批准，停在批准门；聊天确认不是付款授权。
- `workshop_get_generation` 查询同一个 request ID，不借重试自动再扣费。
  成功后读取本次媒体预览，核对角色身份、叙事情绪、焦点、光源与画幅；不能看图就说明。
- 用户在 Web 比较与定稿，Skill 不代选、不删除旧版。失败或不满意要新请求、新人工批准。
  反馈确实处理完才确认消费对应 ID。

产物仍归当前角色 promo/，不新增 MCP 资产目录。收尾采用共享七件套。
