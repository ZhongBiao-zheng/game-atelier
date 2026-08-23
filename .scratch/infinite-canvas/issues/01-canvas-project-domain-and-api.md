# 01：画布项目领域、存储与 API

Type: feature

Status: ready-for-human

Blocked by: none

## Scope

- 定义 CanvasProject、CanvasDocument 与节点双端 schema。
- 建立 `canvases/<id>/project.json|canvas.json|uploads|outputs` 文件真源。
- 新增项目列表/创建/重命名、文档读写、上传与安全媒体端点。
- 扩展 Job `namespace="canvas"`、`canvas_project_id` 和 runner 输出路由。

## Acceptance

- 画布项目与 Studio/工坊项目无身份或目录耦合。
- 项目只能由 Web 的明确用户请求创建，Skill 无创建或更新入口。
- Job 输出只落当前画布项目，客户端不能写状态和归属字段。
- 文档原子保存，媒体读取不能越出当前项目目录。

## Comments

- 2026-08-23：等待纠正版整体方案批准。
- 2026-08-23：纠正版方案已确认，可按 Scope 实施。
