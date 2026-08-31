# Issue tracker: Local Markdown

任务与 PRD 在本地维护，代码通过 GitHub PR 交付，不为每项任务创建 GitHub Issue。

## 本地任务

- 每项功能一个目录：`.scratch/<feature-slug>/`，默认不提交到 Git。
- 需求草稿为 `PRD.md`；必要时用 `execution-log.md` 记录决策与遗留风险，不强制完整模板。
- 实施任务为 `issues/<NN>-<slug>.md`，从 `01` 编号，顶部记录 `Type`、`Status`、`Blocked by`。
- 状态词汇见 `docs/agents/triage-labels.md`；讨论追加到任务底部的 `## Comments`。

## 发布与读取

Skill 要求“发布到 issue tracker”时，在对应本地目录创建或更新 Markdown。
读取任务时优先使用用户提供的文件路径或编号。

## 代码交付

- 从 `codex/` 前缀功能分支向 `ZhongBiao-zheng/game-atelier` 提交 PR。
- PR 必须包含独立可读的范围和验证结果，不能只引用本地任务文件。
- 共享资产与跨界面功能遵循 `docs/agents/product-feature-workflow.md`；长期结论随代码进入项目文档。
