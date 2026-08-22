# Issue tracker: Local Markdown

本仓库的任务与 PRD 使用本地 Markdown,代码改动通过 GitHub PR 提交,不为每个任务创建 GitHub Issue。

## 约定

- 每项功能一个目录：`.scratch/<feature-slug>/`。
- PRD 为 `.scratch/<feature-slug>/PRD.md`。
- 实施任务为 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`,从 `01` 开始编号。
- 每个任务顶部记录 `Type`、`Status` 和 `Blocked by`。
- 状态使用 `docs/agents/triage-labels.md` 中的词汇。
- 讨论或补充信息追加到任务底部的 `## Comments`。

## 发布与读取

当 Skill 要求“发布到 issue tracker”时,在对应 `.scratch/<feature-slug>/` 下创建或更新 Markdown。读取任务时优先使用用户给出的文件路径或任务编号。

## 代码交付

任务文件只负责描述范围、阻塞关系和验收标准。真正的代码改动从 `codex/` 前缀分支开始,通过 GitHub PR 提交到 `ZhongBiao-zheng/game-atelier`。
