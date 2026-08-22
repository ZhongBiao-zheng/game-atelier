# 04：删除残留并完成人工验收准备

Type: task

Status: completed

Blocked by: 02, 03

## What to build

清理旧文件夹与皮肤语义的全部残留，完成自动化和真实视口验证，并把可测试版本推送到现有 PR。

## Acceptance

- 源码、API 契约、领域文档和当前发布日志不存在仍可触发的旧功能或旧文案。
- 后端、前端、Ruff、TypeScript、设计漂移和生产构建全部通过。
- 375、768、1440 下创建衍生 Dialog、项目导航和首页阅读区可用。
- 插件版本、构建产物、票据状态和 PR 说明同步更新。
- PR #56 保持打开且不合并，等待人工测试。

## Verification

- `uv run pytest`：940 passed，3 skipped。
- `pnpm test`：368 passed；包含设计漂移守卫。
- `pnpm lint`、`uv run ruff check src tests`、`pnpm build`：通过。
- 真实浏览器 375×812、768×1024、1440×900：项目首页和衍生 Dialog 无横向溢出；取消后焦点返回触发按钮。
