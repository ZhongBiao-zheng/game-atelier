# 28：补齐有向连接交互与视觉关系

Type: implement

Status: completed

Blocked by: 27-implement-node-title-inline-rename

## Goal

补齐 C10/I06，并修正连接机械层的两个真实缺口：无效节点落点不能误打开空白创建菜单；用户删除后
撤销的已证明 Generation Derivation 必须能重新持久化。

## Included

- 左右连接柄沿用 React Flow，改为参考项目的小圆点视觉和 48px 命中区；默认隐藏，节点 hover、
  focus、selected 或正在拖线时显示。
- 拖线使用低对比贝塞尔曲线与虚线预览；input 与 derivation 以实线/虚线区分，hover/单选节点时
  高亮直接相关边。
- 前端用同一条校验规则阻止自连、重复 input、无内容 source、group/plugin endpoint；环路仍允许。
- 只在真正落到画布空白时打开带连接创建菜单，落到无效节点不弹菜单。
- 删除 input/derivation、undo/redo、自动保存与 reload 闭环；Generation Derivation 的恢复必须由
  既有 Job/Snapshot/Candidate/Version 证据证明，浏览器仍不能伪造派生边。

## Excluded

- ComfyUI 式端口类型、DAG/整图执行、连接重排、Agent/插件伪造 derivation、节点右键菜单。

## Exit gate

- source→target 正常创建且只写一条历史；同向重复、自连、group/plugin endpoint 均零写。
- 反向环路可保存；拖到空白保留带连接创建，拖到无效节点无误弹窗。
- input 和 derivation 视觉可辨，连接柄在 20%–250% 缩放及 375/768/桌面仍可命中。
- 删除与 undo/redo 完整往返并在 reload 后保留；派生恢复必须通过服务端权威证据校验。
- 前后端定向测试、源码类型、Ruff、设计守卫、生产 dist、全量基线、差异检查与代码审查通过；
  不修改旧测试源。

## Verification

- 连接柄采用屏幕恒定 48px 命中区与 12px 圆点，默认隐藏；节点 hover、focus、selected 与拖线过程显示。
  桌面、768 和 375 视口均无横向溢出；20% 缩放实测命中区仍约 48×48px、圆点约 12×12px。
- 实机完成 source→target、从 target 反向拖入、允许环路、节点附近吸附与画布空白创建；同向重复和
  无效节点落点均零写且不误弹空白创建菜单。最终项目保持 7 个节点、6 条正式连接，无测试边残留。
- input 使用低对比实线、derivation 使用虚线；选中或 hover 节点会高亮直接相关边，边提供方向化
  aria-label 与 16px 交互宽度。
- 空内容节点不暴露可访问、可交互的 source handle；对早期版本已保存的空-source边仅保留隐藏几何锚点，
  最终构建实测 7 个节点、6 条持久化边完整显示，只有 2 个有内容节点可发起连接。
- 新建连接完成保存、undo、redo、reload 往返；Generation Derivation 的恢复由既有
  Job/Snapshot/Candidate/Version 联合证明，伪造来源仍被服务端拒绝。
- 新增前端 4 条连接策略测试与后端 2 条派生历史恢复测试，覆盖环路、重复/无效端点、空 source、
  左右外沿与上下真空白、反向创建菜单、成功/失败 Candidate、伪造源节点与跨项目拒绝。
- Canvas 源码 `tsc`、Ruff、设计漂移 8/8、`git diff --check`、Vite production build 与 dist
  normalization 均通过。
- 全量基线保持原有失败集合：Python `13 failed, 941 passed, 3 skipped`；Web `4 failed / 38 passed`、
  `22 failed / 385 passed`、`13 errors`，新增 6 条定向测试全部通过，失败均为既有旧 Canvas v1 / keys / CLI 测试。
- 规格与工程双轴复核均 P1/P2/P3 清零；未修改旧测试源。
