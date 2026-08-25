# 39：补齐 Canvas 浅色 / 深色主题

Type: implement

Status: completed

Blocked by: 21-implement-canvas-appearance-image-info

## Goal

关闭固定参考基线 B19 与 I07 的主题差异：沉浸式 Canvas 的外观菜单直接提供浅色/深色选择，
复用 Atelier 全局 token 与 `atelier:theme` 偏好，让画布平面、背景纹样、框选、节点、连线、
MiniMap 和全部 chrome 在两种主题下保持清晰。

## Reference boundary

- 固定参考：`basketikun/infinite-canvas@9414048f9d0a099386aa15d81bedb5376b79ee61`。
- 学习 `canvas-theme.ts`、`use-theme-store.ts` 与外观菜单的“工作区级浅/深选择”结果；
  不复制其 Zustand、Ant Design、硬编码颜色和动画切换器。
- 遵守 `DESIGN.md`：暗色默认，浅色由 `<html class="light">` + `tokens.css` 单点覆盖；
  组件禁止 `dark:` / `light:` 分叉。

## Acceptance

1. `atelier:theme` 是唯一主题偏好；无值或非法值回落暗色，不新增项目字段、后端文件或第二份状态源。
2. Canvas 外观菜单在背景选项之前提供可访问的浅色/深色单选组；选择后立即更新 `<html>` 并持久化，当前项可感知。
3. AppShell 与 Canvas 共用可订阅主题状态；同页切换与其他 tab 的合法 storage 变化都能同步，非法值回落暗色。
4. React Flow 平面、点阵/线框、框选、连接、MiniMap、节点和玻璃 chrome 只消费语义 token；浅色下线框不能落回 React Flow 默认 `#eee`。
5. 项目 Document 的背景、图片信息与 MiniMap 设置保持原有 revision/undo/redo；切主题不得保存项目或制造历史。
6. 主题选择支持键盘焦点、明确 label、radio checked 状态和 Atelier 聚焦环；不引入硬编码颜色、主题变体类或内联阴影。
7. 聚焦测试、源码 TypeScript、设计守卫、production build、浅/深真实页面与代码审查通过；B19/I07 gap 归零。

## Non-goals

- 不实现跟随系统、定时主题、第三套配色或每项目主题。
- 不复制参考项目的精确色值、Zustand、Ant Design 或圆形扩散动画。
- 不顺手修复既有 Canvas v1 测试债或用户工作树文件。

## Rollback

回滚本票提交即可移除 Canvas 主题入口与订阅层；现有 `tokens.css` 双主题值、项目 Document 和媒体不受影响。

## Verification

- `pnpm exec vitest run src/components/canvas/CanvasThemeSelector.test.tsx src/components/AppShell.test.tsx src/test/designDrift.test.ts`：24/24 通过（既有 `act(...)` warning 不变）。
- `pnpm exec tsc -p /tmp/tsconfig.canvas-e37.json --noEmit`：通过。
- `pnpm exec vite build`：通过；构建产物已规范化。
- 全量 Web：467/489 通过，22 个既有失败仍位于 4 个历史测试文件，未新增失败。
- 真实 `127.0.0.1:5174`：浅/深主题、语义背景/卡片/纹样、radio checked 状态通过；切换前后均为 `已保存 · v381`，项目 revision 未变化，原深色偏好已恢复。
- 双轴审查：Spec 仅要求同步矩阵；Standards 的 `focus-visible`、唯一公开写入口与选项轨道间距问题已修复并复测。
