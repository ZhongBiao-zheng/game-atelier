---
name: character
description: |
  游戏角色立绘工作流：对话完善角色设定、风格和视觉锚点，经已授权工坊 MCP 准备生成，
  由画师在本机 Atelier 批准后出图并迭代。用于新角色、立绘、换装换色、品质皮肤和角色反馈；
  美宣、三视图分别交 promo、turnaround。调用 /game-atelier:character 时使用。
---

# 角色立绘

先完整读取 [MCP 工作流](../../docs/references/workshop-mcp-workflow.md)，本 Skill 不提供
shell / 文件直写 / 供应商调用的第二条执行路线。项目资料用 MCP，Read 仅用于插件参考文件。

## 进入当前角色

1. 用 `workshop_list_projects`、`workshop_list_targets` 定位用户指定项目和角色，
   锁定 `{type:"character", project_id, character_id, asset_slot:"portrait"}`。
2. 新角色得到用户明确请求后，`workshop_create_target` 创建角色；没有项目时请用户先在
   Atelier 创建并授权。生成的 ID 原样使用，不能静默改名或为整理 Web 创建角色批量改 ID。
3. `workshop_get_context` 读角色 spec、项目风格、世界观、当前项目立绘经验、反馈、
   定稿与过期标记、派生来源。不猜全局 active，不读取无关角色或代理私人记忆。
4. 只处理当前角色；`workshop_read_document(kind:"character_spec")` 取完整设定后再修改。
   读取项目基线 `project_style` 与 `worldview`，其中已经明确的风格与定位不要重复提问。

已有画作建档时，先让用户在 Atelier 上传并归入当前角色：参考原图归 source/，
已经认可的立绘 / 三视图分别归 portrait / turnaround；上传不自动定稿。
再通过 `workshop_list_media`、`workshop_read_media` 确认实际登记结果，不能仅凭聊天附件
路径宣称导入成功。当前工具没有导入和改 ID 操作；界面没有对应入口时明确说明限制。

## 设定：先问关键缺口，再保存

必读 [spec 模板](../../docs/references/spec-template.md) 和
[设定对话协议](references/spec-protocol.md)。`character_spec` 是角色事实源，不另存平行设定。

- first_gen 先确认风格 / 参考 IP 或参考图、头身比、核心配色、服装与道具、全身或半身、
  镜头和画幅。缺少风格、身份锚或头身比时先问，不带未知设定盲出。
- 用户已有成熟原稿时先看图提取，不再从零问完整问卷。图中看不清的结构标为未确认，
  不装作已理解；已确认设定逐项继承。
- 风格、发色、瞳色、服装主色是锚；未请求变更的部分不可顺手重设计。
- 只保存已确认内容，不写问号占位、TBD 或“待定”。用户尚未回答的字段省略，
  而不是替用户拍板；已有内容不因模板缺节被整篇覆盖。
- 修改经 `workshop_write_document` 完成，带刚读取的 revision；保存后核对返回结果。
  反馈真正处理完再确认对应 feedback ID；只看过不等于处理完。

Claude Code 用 AskUserQuestion；Codex 在可用时用 request_user_input。
复杂选项采用“两级选择”：先大方向后细节；工具不可用则问一个文本问题等待，
不能伪造用户回答。对话批准设定不等于批准付费生成。

## 生成模式与参考图清单

必读 [统一 Prompt 规则](../../docs/references/art-prompt-system.md)、
[立绘 Prompt](references/prompt-zh.md)、[模型选择](../../docs/references/model-routing.md)。

| 模式 | 用途 | 固定边界 |
| --- | --- | --- |
| first_gen | 首张视觉身份基准 | 默认全身正面直立、浅纯色背景、柔光；缺风格与头身比先问 |
| variation | 动作、构图或表现变化 | 角色身份与未变更锚冻结；实际选定立绘作为有序参考 |
| refinement | 换装换色、品质皮肤、局部修正 | 只描述本次改动，不重复整套外观，未指定的动作与道具不变 |

已有定稿优先读 `canonical.portrait.media_id`；否则由实际媒体清单选图并向用户明示。
过期标记存在时先解释 spec / style 已变化，不把旧图当新规范。派生角色优先自己的成果，
没有时用 `derivative_source_media_ids` 冻结来源，不追随父角色“最新图”。

参考图清单逐张记录序号、简短可见描述和用途，顺序就是 `media_ids` 顺序。
立绘风格图只贡献笔触、材质和影调，不借用别人的身份；姿势图不能改变既定角色。
换皮肤用短编辑 Prompt：参考负责“是谁”，文字负责“改什么”，通常 1–3 段、120–260 字。
绿色品质以换色 / 局部变化为主，蓝色品质才扩展服装饰品；不擅加武器、特效、动作。
首次生成一般 3–4 段自然中文，具体描述而非质量词堆叠。

## 准备、批准、查看

1. `workshop_list_models` 查询当前目标实际可用模型及参数能力；用户点名优先，
   不可用要说明，不偷偷换供应商。默认一张，明确画幅和质量。
2. 自检身份锚、头身比、背景、风格和参考图顺序。符合后用
   `workshop_prepare_generation` 准备当前 portrait 请求。
3. 告知 request ID、模型、内容、素材和费用状态，请用户在 Atelier「待批准生成」
   **人工批准**；这一步停下。聊天里的“出图”不是页面批准，也不能自动重试付费请求。
4. 批准后 `workshop_get_generation` 查询同一请求；完成后通过 `workshop_read_media`
   看本次实际产物，不能按最新文件或旧图冒充本轮输出。
5. 有视觉输入能力时检查锚点漂移、手脸崩坏、服装道具、头身比、轮廓、背景；
   无法看图就明示未做视觉质检。让画师在 Web 对比并选择定稿，Skill 不代选。
6. 下一轮围绕实际反馈修正，保存确认的 spec，再准备新的待批准请求。失败返回原因，
   未经新的页面批准不再调用供应商。

项目风格基线变更会影响下游美宣 / 三视图；按共享工作流先列出受影响定稿，再经确认修改。
MCP 只提供当前目标上下文，不能声称已扫描全项目所有过期资产。经验总结可以先给建议，
但没有写项目经验工具时不能宣称已沉淀入库。

收尾按共享工作流七件套，清楚区分“文档已保存”“待人工批准”“处理中”“已生成”。
