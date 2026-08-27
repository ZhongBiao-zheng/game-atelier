# 06：裁定 Canvas Agent 的人工边界

Type: wayfinder:grilling

Status: ready-for-agent

Blocked by: 01-freeze-reference-baseline, 02-resolve-canvas-domain-v2

## Question

如何复刻参考项目的 Agent 读取、结构化操作、会话、审批、权限、诊断和 Skills，同时不违反
“画布只能由用户人工创建和推进，Skill 不创建、不填充、不运行画布”的已确认规则？

## Decisions required

- Agent 是建议者、用户确认后的操作者，还是拥有部分自动编辑权限。
- 读/写节点、边、viewport、文件、Job 的逐项 capability 与审批粒度。
- 每个操作如何进入 undo/redo、审计日志和多标签隔离。
- 复用当前 Codex/Skill 运行环境还是新增受限 MCP sidecar。

## Deliverable

- Agent 权限矩阵、信任边界图、确认交互和失败恢复规范。
- 与“Skill 不推进画布”规则无矛盾的最终措辞；若规则演化，明确记录为产品变更。

## Proposal

- 权限、信任边界、审批、撤销、会话、Skills 与 sidecar：`../canvas-agent-boundary-proposal.md`
- proposed ADR：`../../../docs/adr/0011-restrict-canvas-agent-to-approved-change-sets.md`
- 推荐方案 A：受限 Canvas Agent Host 复用 Codex 登录/模型但无文件、shell、任意网络工具权限；模型只读或
  提出 typed Change Set，viewer-server 在项目 revision 与用户审批下执行。

## Decision

2026-08-23 用户确认方案 A。“人工创作”允许用户主动发起 Canvas Agent Turn，并批准其项目内变更提案；
Workflow Skill 禁令不变，Canvas Agent Skill 仅作为下一 Turn 指令模板。生成、删除、Transfer、
Publication 和远端刷新始终逐次确认。
