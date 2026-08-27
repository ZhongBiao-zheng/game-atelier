# 38：补齐项目级 Agent Session 分域持久化

Type: implement

Status: completed

Blocked by: 11-implement-project-package-lifecycle, 23-implement-viewport-history-shortcuts

## Goal

关闭固定参考基线 A12 的剩余差异：viewport 与画布外观继续由 revision 化
`canvas.json` 承载，Agent 对话历史改为项目内 `agent/sessions/<session_id>.json` 文件真源，
不把会话和流式事件塞进画布交互热路径。

## Reference boundary

- 固定参考：`basketikun/infinite-canvas@9414048f9d0a099386aa15d81bedb5376b79ee61`。
- 学习 `CanvasProject.chatSessions/activeChatId` 的项目归属结果，不复制 IndexedDB 大对象存储。
- 遵守 Canvas Agent 已确认方案 A：会话属于 Canvas Project，viewer-server 是文件真源；
  本票不启动 Agent Host，不实现 Turn/审批/工具执行。

## Acceptance

1. Python / TypeScript 共有严格对称的 Session、Summary、Message、Reference 与 Token Usage schema；禁止额外字段、本地路径和媒体字节。
2. 新画布初始化 `agent/sessions/`；既有 v2 项目缺目录时按“无会话”处理，首次创建时原子落盘。
3. 提供项目内创建、列表、读取、删除 Session API；删除必须带 `If-Match`，冲突零写入。
4. Session 使用单文件 revision 和单调 sequence；内部消息追加原子加锁，一次追加同时增加 revision/sequence。
5. 一个损坏 Session 只在列表中进入 `corrupt_session_ids`，不阻断项目与其他会话；直接读取该 Session 返回可行动冲突诊断。
6. 项目包导出严格验证 Session schema/文件名/项目 ID；导入新项目时保留 session/message ID 与历史，重写 `project_id`。
7. A12 gap 归零；聚焦测试、TypeScript、Ruff、production build、API 真实请求和代码审查通过。

## Non-goals

- 不实现 Agent 右栏、Codex sidecar、SSE、Turn、Change Set、审批或 Skills。
- 不持久当前打开的会话、panel 宽度、选区、焦点或流式临时态。
- 不向 Session 写 API Key、token、环境变量、裸文件路径、data URL 或隐藏思维链。
- 不修改既有 Canvas v1 测试债或用户工作树文件。

## Rollback

回滚本票提交即可移除 Session schema/API/存储与项目包集成；`canvas.json`、媒体和 Job 均不受影响。

## Verification

- `uv run pytest -q tests/test_canvas_agent_sessions.py`：7 passed；覆盖创建/读取/删除、revision/sequence、并发单赢家、非法 UTF-8 隔离、非法 ID 零锁文件、隐私拒绝、项目包重映射及不等待 Canvas Document 热锁。
- `pnpm test -- src/api/canvasAgentSessions.test.ts`：1 passed；覆盖编码路由、创建请求与删除 `If-Match`。
- Canvas 生产源码 TypeScript 检查通过；`uv run ruff check src tests` 与 `git diff --check` 通过。
- `pnpm exec vite build` 与 dist normalize 通过；仅保留既有 bundle size warning。
- 全量 Python：8 failed / 994 passed / 3 skipped；全量 Web：4 failed files、22 failed / 464 passed、13 errors，均为本票前已有基线，未新增失败。
- 重启 viewer-server 后，真实 `GET /api/canvas/projects/<id>/agent/sessions` 返回 200；5174 画布实页正常渲染 React Flow、控制台零 warning/error。
- 标准与规格双轴审查完成；非法 UTF-8、敏感字段覆盖、锁路径 ID 校验、写端点契约及 Session 独立锁域问题已修复并复验。
