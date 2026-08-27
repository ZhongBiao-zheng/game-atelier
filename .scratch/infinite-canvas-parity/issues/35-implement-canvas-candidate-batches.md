# 35：补齐多候选结果节点与候选生命周期

> **2026-08-26 产品决定**：「按原设置重试」与「单槽位候选重试」已整体移除（UI、API、后端分支、
> `replaces_candidate_id` 字段全部删除）。重试只保留「按结果节点当前 Draft 整批重新提交」一条路径。
> 本票的验收条目属于历史记录，不要照它重新实现。


Type: implement

Status: completed

Blocked by: 34-implement-canvas-connected-mentions

## Goal

补齐 D17–D20：图片批量生成提交后立即在同一结果节点建立 N 个独立槽位；节点收起时显示堆叠，
展开后可查看各候选、切换主结果，并对失败或停止的单个槽位重试/删除；停止生成时保留已经完成的结果。

## Included

- 参考固定基线 `canvas-node.tsx` 的节点内批次模型：主结果留在原位，其余候选展开到节点周围。
- 候选展示按 `index` 合并后续单槽位重试；旧候选仍作为不可变历史保留。
- 图片结果节点的收起堆叠、候选数量入口、展开/收起、预览与设为主结果。
- 失败/停止候选的单槽位重试与隐藏；隐藏只写候选 tombstone，不删除 Job、Snapshot 或 Content Version。
- 单槽位重试成功时不覆盖已有成功主结果；用户明确“设为主结果”才切换。
- 停止请求保留已成功候选，将尚未完成槽位标记为停止，并按候选状态聚合 Run 终态。
- Python / TypeScript schema、API 契约、前后端命令与 UI 同步。

## Excluded

- 删除已经成功的候选或其不可变产物、自动清理输出文件。
- 将候选拆成多个用户可见 Job、跨 Run 拖拽重排候选索引。
- 复制候选为新节点、候选级下载按钮；沿用现有主结果预览和下载能力。
- 改造 Studio / Character 的批量生成行为。

## Exit gate

- `n=2..4` 的图片 Run 一提交便显示对应槽位，pending/succeeded/failed/canceled 可独立呈现。
- 收起时主结果带堆叠层与候选数；展开时其他当前候选在节点周围展示且不改变画布节点位置。
- 切换主结果可撤销并持久化；单槽位重试成功不抢占已有主结果。
- 失败/停止槽位可隐藏，刷新后仍隐藏，旧候选与产物仍可审计。
- 停止后已完成候选仍可预览，其余槽位进入 canceled，Run 为 partial/done/canceled 中的正确状态。
- 聚焦测试、设计守卫、生产构建、真实浏览器与双轴代码审查完成。

## Verification

- Web 聚焦测试 46/46、Python 聚焦测试 38/38、相关 Ruff 与设计守卫通过。
- 全量 Python：8 failed / 978 passed / 3 skipped；全量 Web：22 failed / 456 passed / 13 errors。失败均为既有 Canvas v1/旧 Key 基线，本阶段没有新增失败。
- Vite production build 与 dist 归一化通过；`pnpm build` 的源码类型阶段仍仅被既有 Canvas v1 测试类型错误阻塞。
- 真实浏览器验证三候选收起堆叠、展开、设主结果、失败槽位重试/隐藏及刷新持久化；临时项目与 Job 已清理，并回到用户原画布。
- Spec 与 Standards 双轴复审完成；首轮发现的成功槽位误重试、末槽位入口、文本 scope creep、项目切换竞态、z-index 与重复收尾均已修复，复审 P1/P2/P3 清零。
- D17–D20 parity gap 更新为 `none`。
