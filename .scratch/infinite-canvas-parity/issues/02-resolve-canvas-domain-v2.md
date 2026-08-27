# 02：裁定 Canvas Domain v2

Type: wayfinder:grilling

Status: ready-for-agent

Blocked by: 01-freeze-reference-baseline

## Question

在不引入整图执行器的前提下，`Canvas Connection`、`@` 显式引用、配置节点、分组、
Resolved Input 和不可变 Generation Snapshot 各自表达什么，谁才是“真实使用过的输入”真源？

## Decisions required

- 文本、图片、视频、音频、配置、分组、生成结果和插件节点的身份与允许转换。
- 空节点被首个结果原位填充、多个结果创建下游节点、已有内容作为参考时的统一规则。
- 删除/替换源节点后，历史生成和重试如何保持可追溯。
- 结构边是否有方向、类型和端口约束，以及 Agent/插件是否可以创建它。

## Deliverable

- 更新后的 `CONTEXT.md` 术语提案和状态机/不变量清单。
- 一份决策记录，明确修改 `docs/adr/0006-*` 的内容。

## Proposal

- 领域提案：`../canvas-domain-v2-proposal.md`
- proposed ADR：`../../../docs/adr/0007-canvas-inputs-and-generation-snapshots.md`
- 推荐方案：稳定内容节点、Input/Derivation 两类有向连接、Generation Draft、Resolved Input、
  与 Canvas Job 一一对应的不可变 Generation Snapshot。

## Comments

- 2026-08-23：用户确认方案 A；`CONTEXT.md` 已更新，ADR-0007 已接受。
