# 27：补齐节点标题原地改名

Type: implement

Status: completed

Blocked by: 26-implement-project-card-metadata-rename

## Goal

补齐 C08，并收口 I03 的节点外标题交互：文本、图片、视频、音频、配置、分组和插件七类节点都能直接在
卡片外标题处原地改名，不必依赖只覆盖内容节点的 Inspector。

## Included

- 双击节点外标题进入跟随节点的原地输入；Enter 保存、Escape 取消、blur 保存。
- 标题输入沿用 Canvas v2 `1..120` 字符约束；首尾空白裁掉，空白提交恢复原标题。
- 标题按钮支持键盘 Enter/Space/F2 进入编辑；编辑退出后按触发方式正确归还或保留焦点。
- 一次改名只写一次 Canvas Document 历史，支持 undo/redo、自动保存和重载。
- Inspector 现有标题入口保留，并补齐与服务端一致的 120 字符上限。

## Excluded

- 节点正文编辑、节点类型转换、批量改名、项目改名、旧 Canvas v1 测试。

## Exit gate

- 七类节点共享同一标题组件和 Document 命令；改名不改变节点 ID、位置、内容 Version、连接或 Job。
- 双击标题不触发节点预览、拖动或创建连接；编辑输入可正常选择文本。
- Enter/blur 持久化，Escape/纯空白零写；一次 undo/redo 完整往返并在 reload 后保留。
- 375/768/桌面缩放下输入不遮挡连接柄或下方 composer，键盘与焦点路径可用。
- 源码类型、设计守卫、生产 dist、Ruff（如涉及 Python）、差异检查与双轴审查通过；不修改旧测试源。

## Verification

- 七类节点共用 `CanvasNodeCard` 标题入口；文本、图片、视频实机进入验证，音频、配置、分组、插件由同一渲染路径覆盖。
- 文本节点完成 Enter 保存、blur 保存、Escape 取消、纯空白零写、undo/redo 与 reload 持久化往返；最终恢复原标题，节点 ID、位置、Version 与 6 条连接保持不变。
- 未选中节点标题双击连续 3 次均进入原地输入，不选中节点、不打开预览；输入框自动聚焦并全选，编辑态双击保留原生选词。
- 375、768 与桌面视口检查无横向溢出；触控/窄屏仍可从键盘入口与 Inspector 改名。
- Canvas 源码 `tsc` 通过；设计漂移 8/8；直接 Vite production build 与 dist normalization 通过；`git diff --check` 通过。
- 全量基线保持不变：Python `13 failed, 939 passed, 3 skipped`；Web `4 failed / 37 passed`、`22 failed / 381 passed`、`13 errors`，均为既有旧 Canvas v1 / 模型分类测试。
- 规格与工程双轴复核均 P1/P2/P3 清零；未修改测试源。
