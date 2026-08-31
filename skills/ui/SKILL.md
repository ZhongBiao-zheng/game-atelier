---
name: ui
description: |
  游戏 UI 设计总控：按请求路由策划锚、UI 视觉规范、页面生成、风格切换和页面延展，
  通过已授权工坊 MCP 管理项目与方案，保留各阶段人工门禁。
  用户要做游戏界面、HUD、弹窗、完整 UI 流程或调用 /game-atelier:ui 时使用。
---

# 游戏 UI 总控

先完整读取 [MCP 工作流](../../docs/references/workshop-mcp-workflow.md)。
只编排当前所需阶段，不强迫用户走全链路；不运行 shell 生成、不直接操作项目文件。

## 初始化与路由

`workshop_list_projects` 定项目，`workshop_list_targets` 找明确 UI 方案 / 页面，
`workshop_get_context` 读取现状。新项目在 Atelier 创建并授权；新方案得到请求后
用 `workshop_create_target(type:"ui_scheme")` 创建，保存返回 ID，不凭名字造目录。
项目文档用 project target，方案规范用 ui_scheme target，单页生成用 ui target；
不得为了读取 GDD 创建占位角色或页面。

| 请求 | 去处 |
| --- | --- |
| GDD / PRD / 交互逻辑 / 策划锚 | ui-anchor |
| 字体、色板、组件状态、统一 UI 语言 | 本总控的 UI 规范阶段 |
| 单页 / 基准页 / 界面图 | ui-page |
| 结构锁定的风格候选对比 | ui-page 风格切换模式 |
| 页面清单 / 屏幕地图 / 审计缺页 | ui-screens |
| 角色立绘 / 美宣 / 三视图 | character / promo / turnaround |

完整建议链路：三锚文档 → UI 规范 → 基准页 → 风格定稿 → 页面延展 → 逐页生成。
阶段 Skill 可独立调用；它们的门禁是执行判据，总控的建议不是批准。
未上线能力如实说明，不以任意文件操作或自由 Studio 出图冒充工坊产物。

## 人工门禁

- 三锚 `gdd / prd / interaction` 未全部 approved 且无有效在案 waiver，
  不进入 UI 生图；交 ui-anchor。waiver 当前只读，不能口头创造豁免。
- 基准页结构未确认，不开始结构锁定的风格候选。
- 当前方案 `ui_style` 未 approved，不批量推页面延展。
- 页面范围未批准，停在 screen-map，不代替用户批准范围。
- 生成请求另需 Atelier 页面的人工批准，设计文档批准不能代替付费批准。

## UI 规范阶段

必读 [style 模板](../../docs/references/style-template.md)。用
`workshop_read_document` 读完整 `project_style`、`gdd`、`interaction`、
当前方案 `ui_style`。项目基线与方案规范分开，不把某方案审美覆盖整个项目。

从项目定位与交互原则推导字体气质、几何 / 描边 / 材质、组件状态，
逐项请画师确认，然后 `workshop_write_document` 写当前方案 `ui_style` 的
`ui.typography / ui.geometry / ui.states`，带完整内容与 expected_revision。
方案规范缺失时从项目基线派生；项目基线缺失先问清并独立保存。

修改 approved 的规范按共享工作流先列出受影响定稿，解释当前方案旧定稿可能过期，经确认再写；
仅凭当前上下文不能声称已审计所有方案。新增视觉决策需要批准，不静默替换。
确认后的规范是后续页面的事实源，不只留在聊天里。

总控不直接生成图片。实质推进或门禁阻挡后用共享七件套，明确下一步条件与一句可复制指令。
代码、测试、发版与纯问答不触发本创作流程。
