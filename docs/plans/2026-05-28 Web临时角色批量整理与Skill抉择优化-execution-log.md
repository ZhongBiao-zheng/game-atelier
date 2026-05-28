# Web 临时角色批量整理与 Skill 抉择优化执行日志

## 15:42

- 采用 Subagent-Driven 方式执行；主线负责实现和验证，子 agent 先做只读侦察，重点检查 active/projects/jobs/schema 复用点和 rename 路径字段风险。
- 当前 dirty worktree 只有两份未跟踪 plan 文件，本轮不把原始 plan 纳入实现提交。

## 15:55

- 子 agent 侦察确认现有 Job 持久路径字段仅需覆盖 `output_paths`、`source_image`、`params.reference_images`、`params.lovart_attachments`；`JobParams` 虽允许 extra，但当前代码没有其他明确本地角色路径字段。
- 偏离原计划：`identity.py` 未 import `turn_start._spec_status`，改为本地轻量判定，避免 `turn_start -> identity -> turn_start` 循环导入。
- 额外收口：rename 时 `character_id` 只更新 `namespace == "character"` 的 job；路径替换同时覆盖 POSIX 与 Windows 风格 `characters/<id>` 片段。
- 本计划只提供 CLI 与 Skill 抉择协议，不执行真实批量整理；推荐 slug 批量整理必须等用户在 Skill 流程里确认。
