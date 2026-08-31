---
name: game-atelier
description: |
  game-atelier 工坊总控：通过已授权 MCP 诊断项目、角色、UI 与视频管线进度，
  路由到既有阶段 Skill 并编排人工门禁。用于不知道下一步、跨管线资产流程、
  从零起游戏项目、问工坊进度或 /game-atelier:game-atelier；代码与发版不归本总控。
---

# 工坊总控

先完整读取 [MCP 工作流](../../docs/references/workshop-mcp-workflow.md)。
总控只诊断、路由、编排，不写 spec / Prompt、不准备生成、不修改 approved 文档。
子 Skill 的门禁是执行依据；总控建议不构成任何批准。

## 诊断

1. 确认 MCP 工具可见；未连接 / 撤销 / 权限不足时指回本机「连接 / Agent 授权」
   与 [配置说明](../../docs/mcp-local-client.md)，不以 shell 或直接读文件绕开权限。
2. `workshop_list_projects` 列授权项目；无项目时请用户在 Atelier 创建并授权，
   不擅自创建项目，不把授权为空说成本机无数据。
3. `workshop_list_targets` 分页找当前项目的角色、UI 方案 / 页面、视频企划；
   不扫目录、不猜 ID、不跟随全局 active 切换目标。
4. 用 project target 的 `workshop_get_context` 读项目基线、世界观、三锚；
   对用户关注的具体目标读上下文、canonical、过期标记与媒体摘要。
   截断、未授权或未翻完页的资料写“尚未核实”，不能写“未建立”。

进度卡只报已经核对的内容：

```text
项目：
连接：已连接 / 需要本机授权
角色：当前目标与立绘 / 美宣 / 三视图状态
UI：三锚批准情况、当前方案、页面进度
视频：当前企划、完整版本与选版情况
建议下一步：只给一个具体建议
你可以直接说：1–3 条可复制的需求
```

只有实际查询到完整计数才能报告项目总数 / 版本总数；未核实的维度不从别的维度推断。

## 路由

| 请求 | 去处 |
| --- | --- |
| 新角色、立绘、换皮肤 | character |
| 美宣 / KV / 海报 | promo：spec 与每个角色身份图须就绪，portrait / turnaround / 用户上传图均可 |
| 正侧背 / 工程设定图 | turnaround：完整 spec 与身份基准，服从该 Skill 门禁 |
| UI 锚、规范、页面、风格、延展 | ui 总控；用户明确点名 ui-anchor / ui-page / ui-screens 时直达 |
| 正式项目视频、完整多镜头 Prompt、整片选版 | video |
| 显式请求启动、重启、打开本机界面 | viewer-server |
| 新建项目、供应商 Key、Agent 权限 | Atelier 对应管理页面，用户自行核对 |
| 项目世界观 / 经验 | Atelier「项目经验」，本总控不代写 |
| 排 bug / 代码 / 测试 / PR / 发版 / 纯问答 | 不触发创作流程 |

建议链路是“建项目 → 身份锚 → 美宣 / 三视图 / UI / 视频”，不是强制串行。
UI 可先建立项目基线再做角色；单一明确需求直接用最小充分子 Skill。
美宣不因缺 portrait 拦住已有 turnaround 或用户上传身份图的用户。

无项目归属不能把自由 Studio 结果冒充工坊资产。设计门禁与生成批准分开：
策划 / 设定批准在相应 Skill；付费生成必须在 Atelier「待批准生成」页面人工批准。
每次只推进当前获准阶段，不拿“建议下一步”冒充已执行。

纯诊断用进度卡；实际路由或门禁停下时用共享七件套。未实现能力如实说明，不虚构工具。
