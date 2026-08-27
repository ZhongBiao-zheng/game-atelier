# 30：补齐节点运行状态与错误重试

> **2026-08-26 产品决定**：「按原设置重试」与「单槽位候选重试」已整体移除（UI、API、后端分支、
> `replaces_candidate_id` 字段全部删除）。重试只保留「按结果节点当前 Draft 整批重新提交」一条路径。
> 本票的验收条目属于历史记录，不要照它重新实现。


Type: implement

Status: completed

Blocked by: 29-implement-node-hover-toolbar

## Goal

补齐 C14/C15：把 Canvas Job 的真实状态映射到结果节点，并让失败节点可从跟随式工具条或空态主体按
不可变 Generation Snapshot 原样重试。

## Included

- 文本、图片、视频、音频结果节点从 `active_run_id` 对应 Job 派生
  `idle/loading/success/error`，不把展示状态写回 Canvas Document。
- `pending_confirm/pending → loading`、`done/partial → success`、`failed → error`、
  `canceled/无 Job → idle`；partial 单独标明“部分完成”，canceled 标明“已停止”。
- 有旧内容的 loading/error 节点继续呈现旧版本，仅叠加非破坏性状态提示；空节点显示加载或错误主体。
- failed 节点的跟随式工具条和空错误主体提供“按原设置重试”，调用现有 `retryRun(..., 'original')`；
  loading 节点工具条提供诚实的停止/正在停止状态。
- 配置、分组、插件节点没有真实 `result_node_id` Job 时保持 idle，不伪造运行记录。
- 节点通过 `data-canvas-node-status`、`aria-busy`、`role=status/alert` 暴露可访问状态。

## Excluded

- 生成面板重构（D01/I05）、右键菜单、批量选择工具条、改变 Job/Canvas schema。
- 把 `partial` 扩成新的节点枚举，或给配置/分组/插件节点创建第二套运行状态源。

## Exit gate

- 七类节点都有稳定的派生状态；四类内容节点覆盖空/有内容 × loading/error 的非破坏性呈现。
- failed 节点可从浮动工具条按原 Snapshot 重试；pending 节点可停止；无真实 Run 的节点不显示伪动作。
- 原设置重试继续创建新 Run/Job，缺失 Snapshot 引用仍由服务端明确报错。
- 聚焦测试、类型检查、设计守卫、构建、全量基线、真实浏览器与代码审查通过；不修改旧测试源。

## Verification

- 状态派生集中在独立模块，并要求 `active_run_id` 命中的 Job 同时满足
  `canvas_run.result_node_id === node.id`；toolbar、overlay、停止、重试与反推恢复共用该 validated Job。
- 四类内容节点的空/有内容 × loading/error、partial/canceled、cancel_requested、反推专用文案、
  wrong-result 负向路径与 pending→done→partial→canceled live-region 转移均有聚焦覆盖。
- 聚焦前端 22/22、设计守卫 8/8、Ruff、生产构建、dist 归一化与差异检查通过；真实 5174 页面完成态、
  节点内容、连接柄、上方工具条与下方独立 composer 无回归。
- 全量 Python 保持 13 failed、943 passed、3 skipped；全量 Web 为 4 failed files、40 passed files、
  22 failed tests、398 passed tests、13 errors。失败均为范围外既有 Canvas v1、keys 与 CLI 漂移；
  `pnpm exec tsc -b --noEmit` 也只保留同一批旧 Canvas v1 测试类型错误。
- Standards Review 与 Spec Review 最终 P1/P2/P3 全部清零。
