---
name: ui-page
description: |
  游戏 UI 单页、基准页与风格候选：读已批准策划锚、项目基线、方案规范和页面 brief，
  经工坊 MCP 准备生成，等待 Atelier 人工批准；一次只做一页。
  用于界面图、出基准页、结构锁定换风格或 /game-atelier:ui-page。
---

# UI 单页生成

先完整读取 [MCP 工作流](../../docs/references/workshop-mcp-workflow.md)、
[页面 brief 模板](../../docs/references/screen-brief-template.md)、
[style 模板](../../docs/references/style-template.md)。
页面 brief 是结构事实源，Prompt 是一次生成快照；不把模型参数写进 brief。

## 定页面与前置门

`workshop_list_projects`、`workshop_list_targets` 锁定项目、UI 方案、页面。
用户点名页面优先；没有点名时从 approved map 按依赖推荐一个 must-have 未生成页。
页面不在 PRD / map 中，先请求范围确认并同步文档，不能擅自加页。

新页面得到请求后通过 `workshop_create_target(type:"ui_screen")` 创建，带明确方案 ID；
保留返回的真实 target，在文档中映射原逻辑 screen-id，不靠名字猜真实 ID。

用 `workshop_get_context`、`workshop_read_document` 读取完整三锚、
`project_style / ui_style / screen_map / screen_brief`：

- 三锚缺失或未全部 approved，且无有效在案 design_waiver → 回 ui-anchor，不生图。
- 项目基线或方案规范缺失 → 回 ui 总控补规范，不生图。
- waiver 当前只读；口头“跳过”不能创造记录，截断或范围不符也不放行。

## 基准页 / 常规单页

1. brief 缺失时以 map 的对应 `screen.<id>` 为基础，或从 PRD 覆盖需求和 Interaction
   主流程 / 状态推导。确认布局分区和反向限制后，用 MCP 带 revision 写 screen_brief。
   已有 brief 仅在用户要求结构变更时改，状态用语沿用上游，零占位。
2. Prompt 顺序：项目基线 → 当前方案规范 → 页面结构 / 主操作 / 状态 → 必要限制。
   延展参考用当前登记的基准页 media ID，按 `media_ids` 顺序绑定；
   无可见素材先请用户在 Atelier 正式引用。
3. `workshop_list_models` 查询能力，按游戏横竖屏选 ratio / size，不保证模型不支持的尺寸。
   `workshop_prepare_generation` 为明确 ui target 准备一张图。
4. 请用户在 Atelier「待批准生成」人工批准，停在批准门。
   批准后用 `workshop_get_generation` 查同一请求和真实输出，不能用旧图充数。
5. 完成后 `workshop_read_media` 看预览并核对布局、主次操作、风格、文案可读性与异常态。
   不具备看图能力就说明未质检。map 中该页状态只在成功后推进 generated。

## 风格切换模式：结构不变，只换视觉语言

- 基准页结构经画师明确认可后才进入；读完整 brief 并冻结其布局 / 组件 / 状态。
- 请画师给 2–4 个方向，或依据 GDD 与世界观给少量方向供选择，不代定审美。
- 每个候选单独准备请求：`params.style_variant` 记录方向，
  `params.base_version` 仅使用媒体元数据提供的基准版本名（没有则省略，不能猜路径），
  用实际 media ID 绑定同一基准图。
- 每个候选都在 Atelier 单独人工批准；聊天一次“全出”不替代页面批准。
  相同结构才叫风格候选，改了 brief 就应重新确认基准页。
- 旧候选保留不删，画师在 Web 比较后选定 canonical，Skill 不代选、不直写 canonical。
- 把选定候选拆成可执行的 `ui.typography / ui.geometry / ui.states`，
  修改规范前按共享工作流列出受影响定稿并等待确认，
  经画师确认后用 MCP 写当前方案 ui_style 并标 approved。
  未回写规范不得宣称风格已定；不要改其他方案或项目基线。
- 更新 style 会让旧定稿指纹过期；请用户在 Web 重新确认定义新规范的同一图，
  刷新后再据 context 标 map 的 canonical。不能伪造已刷新。

失败或要新版本时准备新请求，重新页面批准，不自动再次扣费。
产物仍归当前方案页面目录；收尾按共享七件套报告当前阶段，不谎称整个 UI 流程已完成。
