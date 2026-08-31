---
status: proposed
---

# 外部工坊 MCP 与受限画布 Agent 分开授权，共用 Job 执行

外部 Codex / Claude 使用 Workflow Skill，通过 stdio MCP 访问显式授权的工坊项目；它不是
ADR-0011 的 Canvas Agent，不继承画布授权，也不取得任意文件、shell 或供应商凭证能力。
Skill 保留创作方法，MCP 承载类型化操作，viewer-server 拥有权限校验与批准，Job Runner 仍是唯一生成入口。

选择官方 SDK 的窄适配器，而不是复制业务到第二个本地后端或提供万能 HTTP / CLI 工具。
付费任务先冻结输入，由人在 Atelier 页面批准，再由服务端调度；工具不能用布尔参数替人批准。
代价是第一版外部 Agent 出图仍需要 Atelier 确认页面，不能完全无人值守，但可阻止协议入口绕过批准
和重复付费。已有 CLI / Skill 生成路径须同步收敛，不保留接受待确认 Job 的执行旁路。

用户已同意建设 MCP + Skill 入口；本文及[工坊契约](../contracts/workshop-mcp.md)记录拟定权限设计，
随实现 PR 评审，且不取代 ADR-0011。
