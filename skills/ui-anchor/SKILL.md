---
name: ui-anchor
description: |
  游戏 UI 策划锚：对话生成或增量补全 GDD、PRD、交互逻辑，交叉检查后等待画师批准。
  通过工坊 MCP 保存到当前项目，三文档 approved 是 UI 生图门禁。
  用户要写策划、PRD、交互逻辑、准备 UI 需求或调用 /game-atelier:ui-anchor 时使用。
---

# UI 策划锚

先完整读取 [MCP 工作流](../../docs/references/workshop-mcp-workflow.md)。
本 Skill 只写文档，不出图，不需要供应商 Key；也不自行启动服务或直接写文件。

正式门禁：三锚全部 approved 才能进入 UI 生图；仅有效且范围匹配的在案豁免例外。
`design_waiver` 对应项目 `design/waiver.md`，当前只读，不接受口头豁免。

## 定项目与现状

用 `workshop_list_projects` 明确已授权项目，以 `{type:"project",project_id}`
为文档目标；新项目不需要先有角色或页面。没有授权项目请用户到 Atelier 创建 / 授权。
`workshop_get_context` 查看基线，再 `workshop_read_document` 读完整
`worldview / project_style / gdd / prd / interaction`。不能拿截断摘要覆盖全文。

三文档齐且 approved 时先说明已就绪，用户要修订再按指定范围改；批准过的内容变更后回 draft
重新审阅。已有外部 GDD 只补经确认的缺节，不重写已有内容；部分存在则从缺的文档继续。

## 文档顺序

先分别完整读取 [GDD 模板](../../docs/references/gdd-template.md)、
[PRD 模板](../../docs/references/prd-template.md)、
[交互模板](../../docs/references/interaction-template.md)。

1. GDD：定位、核心体验、循环、系统优先级、世界观最小集。
2. PRD：由循环推导需求、页面范围、信息架构、边界异常。每条 P0 都有承接页面。
3. Interaction：对 must-have 页面写主流程、控件行为、状态机与跨页链路。
   状态名一经批准是下游契约，brief / Prompt 不另起近义名。

每轮问 1–3 个决定性问题，Worldview 已有的定位 / 调性直接引用，未定字段省略，
不写问号占位、TBD、“待定”。每份内容从 draft 起步，以
`workshop_write_document` 完整保存并带最新 revision、幂等键。

页面逻辑名称和真实目标 ID 要明确映射；未创建的页面可先在文档中定义稳定逻辑 screen-id，
创建后记录工具返回的实际 ID，不能假称某个逻辑名已是可调用目标。

## 交叉检查与批准门

把三项检查结果展示给画师，不通过先修再查：

- GDD 核心循环每个主要界面都在 PRD 页面范围中。
- PRD 每条 P0 的对应页面都在范围表中。
- 每个 must-have 页面在 Interaction 有同名 `screen.<id>` 节，拼写、状态、流程一致。

通过后每份文档给三行内摘要，请画师审阅，停下等真实回答。
明确“批准 / 定了”后，重新读最新文档并通过 MCP 把 frontmatter 改为 approved、更新日期。
这只批准设计，不批准任何付费生成。

既有 `design_waiver` 在上下文中可读；只在范围与当前任务匹配且未截断时据它放行。
当前 MCP 不支持新增 waiver，不能凭用户一句“跳过”伪造在案记录或用 shell 代写；
要新豁免须说明入口限制，不能继续生图。不主动建议绕过策划。

产物仍属项目 design/ 三锚。收尾按共享七件套，三文档未 approved 不宣称策划锚已就绪。
