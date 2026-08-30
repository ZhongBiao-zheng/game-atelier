# Issue tracker: Local Markdown

本仓库的任务与 PRD 使用本地 Markdown,代码改动通过 GitHub PR 提交,不为每个任务创建 GitHub Issue。

## 约定

- 每项功能一个目录：`.scratch/<feature-slug>/`。
- PRD 为 `.scratch/<feature-slug>/PRD.md`；重要产品功能从
  `docs/agents/templates/feature-prd.md` 建立，并遵循 `docs/agents/product-feature-workflow.md`。
- 实现日志为 `.scratch/<feature-slug>/execution-log.md`，模板见
  `docs/agents/templates/feature-execution-log.md`。
- 实施任务为 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`,从 `01` 开始编号。
- 每个任务顶部记录 `Type`、`Status` 和 `Blocked by`。
- 状态使用 `docs/agents/triage-labels.md` 中的词汇。
- 讨论或补充信息追加到任务底部的 `## Comments`。
- Issue 优先描述一个可运行、可验证的纵向切片，不按“后端 / 前端”机械拆分。
- `Contract status` 未确认前，Issue 不得进入生产 Schema、迁移或完整业务实现。

## 分支范围

- 功能分支只承载对应 PRD 的 Included 范围。
- 新请求属于 No-gos 或其他产品域时，从 `origin/main` 建新分支或 worktree。
- 规则变化先写入 PRD 的 Decision Changes；不得只改代码或只改 PR 描述。
- 大功能可以使用 stacked PR 降低批次，但未经用户明确授权不得合并。

## 发布与读取

当 Skill 要求“发布到 issue tracker”时,在对应 `.scratch/<feature-slug>/` 下创建或更新 Markdown。读取任务时优先使用用户给出的文件路径或任务编号。

## 代码交付

任务文件只负责描述范围、阻塞关系和验收标准。真正的代码改动从 `codex/` 前缀分支开始,通过 GitHub PR 提交到 `ZhongBiao-zheng/game-atelier`。
交付前运行 `make verify`，并确认 PR 描述仍与当前 PRD 和 ADR 一致。
