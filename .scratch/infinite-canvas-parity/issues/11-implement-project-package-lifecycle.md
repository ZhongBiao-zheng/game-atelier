# Issue 11 — 实现 Canvas Project Package 与可恢复删除

Type: feature
Status: done
Blocked by: Issue 10

## Scope

- 单项目/多项目共用 `game-atelier-canvas-v1.zip` 规范导出器。
- `inspect` → `commit` 两阶段导入，导入始终创建新 Canvas Project。
- 重映射全局 Canvas Job ID、Run ID、output path、retry/derivation/content origin 引用。
- 删除项目、owned Job 与完整恢复包进入 30 天回收区；恢复分配新项目 ID。
- 项目索引接入导入、导出、确认删除、即时撤销与持久回收区。

## Guardrails

- 不把 API Key、provider/WebDAV 配置、缓存、插件代码或运行中事务装入项目包。
- 拒绝路径逃逸、链接/特殊文件、重复规范路径、可执行文件、异常压缩比、配额超限、摘要与 schema 不符。
- pending Canvas Job 存在时拒绝导出、导入和删除。
- 不修改旧测试；已知 v1 测试债保持原状。

## Verification

- 临时 data root：真实 PNG 导出 → inspect → commit → delete → restore。
- 临时 data root：文本 Canvas Job/Run/active_run/content origin 全链重映射。
- FastAPI TestClient：export/inspect/commit/delete/trash/restore 全端点闭环。
- 375/768/1440 视口无横向溢出；项目菜单、回收区空状态和 Escape 关闭可访问。
