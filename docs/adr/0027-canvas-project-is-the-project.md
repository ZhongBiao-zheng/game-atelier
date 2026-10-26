---
status: accepted
---

# 项目统一到画布

工坊与画布原有两套项目模型。项目规范、经验与定稿参考现已归入画布，继续保留角色、UI、视频工作区会产生重复归属和维护路径。

项目由原 CanvasProject 承担，数据保存在 `canvases/<project_id>/`。Studio 保留独立创作入口，生成资产与项目通过项目关系关联。外部 MCP 只提供 `canvas_*` 工具，保留 `canvas_read`、`canvas_edit`、`canvas_generate` 授权；计费生成仍须人工确认。

工坊 UI、API、专属 Skill、MCP 和生成请求管线退役。画布共用的错误、严格输入类型和模型列表抽到独立模块；Job Runner、媒体 caller、网关和创作台保留。Job namespace 仅支持 studio/canvas，kind 保留 text/image/video/audio；移除 asset_slot 以及工坊项目、页面、视频企划和批准请求字段。

迁移已先在数据副本验证，再经用户确认执行真实迁移：五个项目复制为五个画布，规范与经验一并导入；归属缺失或旧 slug 未登记的五个角色跳过。原 `characters/`、`projects/` 文件保留，可由用户手动归档。`migrated_from_workshop` 仅记录迁移来源。

149 条工坊 job 经单独确认移至 `.runtime/jobs-archive/workshop/`。329 条保留 job 经补充确认，先备份到 `.runtime/backups/p5b-job-fields-20261025/`，再持锁原子删除六项工坊旧键；其余数据不变。删除旧 schema 不引入兼容分支。一次性工坊迁移脚本随退役代码删除。

本决策替代此前 ADR 中的工坊项目、角色/UI/视频工作区、Studio 归档到工坊和 workshop_* 接入范围；ADR-0014 的不可变内容快照与只读资产 ID、项目规范与参考库规则继续有效。历史 ADR 保留为决策记录，不作为恢复旧功能的依据。
