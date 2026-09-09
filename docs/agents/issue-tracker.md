# Issue tracker: Local Markdown

任务与 PRD 在本地维护，代码日常提交到 `dev`，同步 `main` 时通过 GitHub PR 交付，不为每项任务创建 GitHub Issue。

## 本地任务

- 每项功能一个目录：`.scratch/<feature-slug>/`，默认不提交到 Git。
- 需求草稿为 `PRD.md`；必要时用 `execution-log.md` 记录决策与遗留风险，不强制完整模板。
- 实施任务为 `issues/<NN>-<slug>.md`，从 `01` 编号，顶部记录 `Type`、`Status`、`Blocked by`。
- 状态词汇见 `docs/agents/triage-labels.md`；讨论追加到任务底部的 `## Comments`。

## 发布与读取

Skill 要求“发布到 issue tracker”时，在对应本地目录创建或更新 Markdown。
读取任务时优先使用用户提供的文件路径或编号。

## 代码交付

- 日常开发统一在长期 `dev` 分支提交并推送，不默认创建功能分支、不直接更新 `main`。
- 用户明确说“同步”时，从 `dev` 向 `main` 提交 PR；用户指定某个 PR 合入 `main` 只授权该次操作。
- PR 必须包含独立可读的范围和验证结果，不能只引用本地任务文件。
- 同步前确认范围与 CI，同步后保留 `dev` / `main`；已有其他未合并工作不自动并入。
- 共享资产与跨界面功能遵循 `docs/agents/product-feature-workflow.md`；长期结论随代码进入项目文档。
