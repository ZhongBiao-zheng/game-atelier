---
status: accepted
---

# 画布输入关系与生成快照分离

Canvas 的可编辑连接不能同时充当历史来源真源。Canvas Domain v2 将连接分为当前输入资格的
`Input Connection` 与结果布局追溯的 `Derivation Connection`，并在每次提交时把最终 prompt、模型、
参数和具体内容版本冻结为与 Canvas Job 一一对应的 `Generation Snapshot`；只有 Snapshot 回答“实际
使用过什么”。React Flow 仍只负责机械层，连接不触发下游或整图执行；本 ADR 只替代 ADR-0006 中
“连接记录真实生成输入”的旧语义，保留其 React Flow、统一 Job Runner 和独立人工画布决定。

## Considered Options

- 照搬参考项目的无类型边：拒绝，因为删除边、替换节点或 Agent 编辑会改写历史含义。
- 把画布升级为强类型 DAG 执行器：拒绝，因为会破坏人工创作空间边界并引入拓扑调度。

## Consequences

- v2 落地时直接删除 v1 `generation` 节点类型与旧分支，只保留内容节点模型。
- 用户、Agent 与插件只能通过同一校验器创建 Input Connection；Derivation Connection 和 Snapshot
  只能由生成提交路径创建。
- Job/快照引用的内容版本必须在节点删除或替换后继续可读，物理保留策略由后续数据与资产决策确定。
