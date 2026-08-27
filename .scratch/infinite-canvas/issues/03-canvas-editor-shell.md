# 03：沉浸式画布编辑器骨架

Type: feature

Status: ready-for-human

Blocked by: 02

## Scope

- 安装 `@xyflow/react`，实现 `/canvas/:id` 沉浸式编辑器。
- 实现左上项目切换器、左侧工具条、左下 MiniMap/viewport 控制。
- 建立领域文档与 React Flow 渲染态映射、串行自动保存和会话内撤销/重做。

## Acceptance

- 编辑器隐藏普通顶栏但保留明确的返回和切换项目路径。
- viewport、节点和来源连接刷新后完整恢复。
- React Flow 内部字段不进入持久化 JSON。
- 保存请求不会因异步乱序把画布回退到旧状态。

## Comments

- 2026-08-23：等待纠正版整体方案批准。
- 2026-08-23：纠正版方案已确认，可按 Scope 实施。
