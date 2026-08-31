---
name: ui-screens
description: |
  游戏 UI 页面延展：按玩家旅程八步审计推导带优先级和依赖的页面清单，
  画师批准范围后通过工坊 MCP 保存当前方案 screen-map，每页有结构契约。
  只产页面地图不生图；用于页面清单、屏幕地图、审计缺页或 /game-atelier:ui-screens。
---

# UI 页面地图

先完整读取 [MCP 工作流](../../docs/references/workshop-mcp-workflow.md)、
[玩家旅程审计](../../docs/references/screen-taxonomy.md)、
[页面地图模板](../../docs/references/screen-map-template.md)。
本 Skill 只产 screen-map，逐页生图交 ui-page。

## 定方案与门禁

用 `workshop_list_projects`、`workshop_list_targets` 明确项目与方案。
以 ui_scheme target 读 `workshop_get_context`，再读完整项目三锚和
`project_style / ui_style / screen_map`。无方案时经请求用 create-target 创建，不能造目录。

三锚未全部 approved 且无有效在案 waiver → 回 ui-anchor。
当前方案 ui_style 缺失、ui.* 不完整或未 approved → 回 ui-page 风格阶段。
不能让未定风格的页面批量漂移；只读 waiver 不可由聊天口头代替。

## 推导、批准、保存

1. 从 GDD 循环和 Interaction 写出“首次进入 → 核心循环 → 日常回流”。
   依次审计启动、核心玩法、成长、经济、活动、社交竞争、策略表达、支持设置八步。
2. 放入 PRD 范围中已有页面，找真正断点；只为断点补候选，不把 taxonomy 全量搬入。
   每页问为何需要、首要动作、是否首版必需、能否合并、适用哪些空 / 锁定 / 失败态。
3. 标分类、must-have / genre-specific / optional、生成依赖。
   列 id、名称、优先级、理由；新增页单独标出，让画师删、合并或降级后批准范围。
4. 新增与删改先回写 PRD，再写 screen-map；页面范围以 PRD 为准。
   已批准文档的改动只限用户本次批准范围。相关 Interaction 同步后交叉核对。
5. 经 `workshop_read_document` + `workshop_write_document` 带 revision 保存整份 map：
   页面表 + 每页 `screen.<id>` 契约（purpose、旅程、布局、组件、状态）。
   状态名沿用 Interaction，不加 data_needs 等开发实现字段。
6. 用户确认后 map 标 approved。已有生成 / canonical 状态只据真实上下文填写；
   不把“已规划”写成“已生成”。先基准页、再高复用页、最后运营页。
7. 交 ui-page 按 approved map 逐页生成。这里不准备付费请求、不批量创建占位页面。

逻辑 screen-id 与实际目标 ID 保持明确映射，不能直接把文档候选名用于未创建的工具目标。
修改 approved map 要重新得到明确范围批准。收尾采用共享七件套。
