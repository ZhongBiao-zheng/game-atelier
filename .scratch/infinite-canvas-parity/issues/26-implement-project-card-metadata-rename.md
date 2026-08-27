# 26：补齐项目卡片统计与原地改名

Type: implement

Status: completed

Blocked by: 25-implement-canvas-zoom-dock

## Goal

补齐项目层 A01/A04/A10：项目列表继续使用 Atelier 卡片墙，但卡片必须显示节点数、连线数与最后编辑时间，
并支持在项目卡片和画布顶部直接双击项目名改名，不必绕到独立 Dialog。

## Included

- `GET /canvas/projects` 的严格 summary 同步返回 `node_count`、`connection_count` 与派生封面。
- 项目卡片显示节点/连线统计和最后编辑时间；加载、空态与既有管理菜单保持可用。
- 双击项目卡片标题进入原地输入；Enter/blur 保存、Escape 取消，失败保留输入与明确错误。
- 画布顶部项目选择区支持双击或明确按钮进入原地改名；保存后选择器和编辑器 aria label 同步。
- 改名只更新 `project.json` 元数据，不进入 Canvas Document 历史，不改变 viewport、节点或 Job。

## Excluded

- 节点标题双击改名（单列 C08 后续处理）、项目复制、排序算法、主题切换和旧 Canvas v1 测试。

## Exit gate

- 空项目为 0 节点 / 0 连线；真实项目统计与 `canvas.json` 一致，损坏项目仍按既有策略隔离跳过。
- 卡片与画布内两条改名路径都持久化；空名/超长名沿用服务端 schema 拒绝且不丢草稿。
- 双击不会误打开项目；键盘入口、焦点归还和移动端布局可用。
- Python/TypeScript schema、API contract、production dist 同步；定向测试、源码类型、设计守卫、构建、
  Ruff 与双轴审查通过，且不修改旧测试源。

## Verification

- 真实 API 返回当前项目 `7` 个节点、`6` 条连线，空项目由严格 summary 返回 `0/0`；列表读取在项目锁内校验目录 ID，损坏元数据或恢复事务按项目隔离。
- 真实页面完成卡片双击改名、Enter/blur 保存、Escape 取消、画布顶部改名与持久化验证，最终项目名恢复为“新画布”；双击标题不导航，封面即时打开。
- 375×780 下统计、原地输入和顶部输入无横向溢出；退出后焦点归还，控制台无 warning/error。
- `tests/test_canvas_projects.py::test_canvas_project_create_list_rename_and_empty_document`、Canvas 源码 TypeScript、设计守卫 8/8、Ruff、`git diff --check`、Vite production build 与 dist normalize 通过。
- 仓库 `pnpm build` 仍被既有 Canvas v1 测试源码的旧导出与旧 schema 类型错误阻断；未修改旧测试源，E26 源码与生产产物已独立验证。
- 规格与工程双轴复核最终均为 P1=0、P2=0。
