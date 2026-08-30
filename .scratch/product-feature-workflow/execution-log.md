# 产品功能开发闭环 execution log

## Decisions

- 2026-08-30：复用仓库现有 `.scratch`、ADR、Vitest 和 CI，不引入第二套任务系统。
- 2026-08-30：第一阶段只建立产品契约、风险关卡、分支隔离、PR 模板和本地验证；视觉回归框架后置。
- 2026-08-30：范围守卫采用 Agent 明确检查与 PR 自检，不用脚本猜测业务语义。

## Deviations

- None.

## Review fixes

- 补齐 Complexity Budget 模板字段，避免工作流要求与模板不一致。
- 把范围术语统一为 `No-gos`，PR 模板不再制造第二套产品事实名称。
- PR 的界面验证改为 UI change / N/A 二选一，非 UI 变更不再留下无法完成的检查项。

## Remaining risks

- 人工 Scope isolation 仍依赖 Agent 遵守；若再次出现跨域 PR，再考虑机器可读的 PRD scope manifest。

## Verification

- `uv run pytest -q tests/test_product_feature_workflow.py`：4 passed。
- `make verify`：ruff、1082 项 Python 测试、605 项前端测试、lint、clean build、插件与路径检查通过。
