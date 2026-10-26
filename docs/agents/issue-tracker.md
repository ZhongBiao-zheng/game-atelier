# Issue tracker: Local Markdown

任务与 PRD 在本地维护，代码日常提交到 `main`，按用户授权推 tag 发布，不为每项任务创建 GitHub Issue。

## 本地任务

- 每项功能一个目录：`.scratch/<feature-slug>/`，默认不提交到 Git。
- 需求草稿为 `PRD.md`；必要时用 `execution-log.md` 记录决策与遗留风险，不强制完整模板。
- 实施任务为 `issues/<NN>-<slug>.md`，从 `01` 编号，顶部记录 `Type`、`Status`、`Blocked by`。
- 状态词汇见 `docs/agents/triage-labels.md`；讨论追加到任务底部的 `## Comments`。

## 发布与读取

Skill 要求“发布到 issue tracker”时，在对应本地目录创建或更新 Markdown。
读取任务时优先使用用户提供的文件路径或编号。

## 代码交付

- 日常开发在 `main` 提交并推送，不默认创建功能分支。`main` 不是客户端更新渠道。
- 日常提交不 bump；发版提交集中更新版本与日志，通过验证、推送 main 后运行 `make release`。
- 推 tag 必须得到用户针对本次发布的明确授权；CI 门禁通过后才发布 Release 与同步 CNB。
- ADR-0029 首次过渡仍在 `dev` 实施，合入 main 与首个 tag 等用户确认；过渡后 dev 冻结保留，不删除，不吸收其他未合并工作。
- 共享资产与跨界面功能遵循 `docs/agents/product-feature-workflow.md`；长期结论随代码进入项目文档。
