# 21：实现画布外观菜单与图片信息条

Type: implement

Status: completed

Blocked by: 03-design-schema-v2-and-cutover, 13-implement-read-only-media-tools

## Goal

让已经属于 Canvas Document 的背景与图片信息偏好真正可见、可编辑：外观入口提供明确选项，图片节点按
`show_image_info` 显示真实像素和文件体积，并继续使用现有 revision、autosave 与 undo/redo。

## Included

- 把左侧“切换画布背景”盲循环按钮改为画布工具栏外观菜单，明确选择空白、点阵或线框背景。
- 同一菜单控制“显示图片信息”；修改背景或开关都形成一个历史命令并保存进 `canvas.json.settings`。
- 有内容图片节点右下角显示当前不可变 Content Version 的真实宽高和体积；关闭后所有图片节点立即隐藏。
- 保留已有大图查看 Dialog 的来源、模型、格式、尺寸、体积、时间、版本、复制提示词和下载能力。
- 复用统一字节格式化，避免节点信息条与大图详情产生显示漂移。

## Excluded

- 新主题系统、浅色主题重设计、逐节点独立开关、视频/音频信息条和修改旧 Canvas v1 测试。

## Exit gate

- 三种背景和图片信息开关可从键盘访问，选择后菜单与画布状态一致。
- 图片信息来自当前 Version；替换、候选切换、undo/redo 后不保留旧尺寸或旧体积。
- reload 后设置仍在；关闭信息不影响大图详情入口和 metadata。
- 375/768/桌面真实页面核对菜单、信息条、焦点与无横向溢出。
- Ruff、Canvas TypeScript、设计守卫与生产构建通过；双轴审查 P1/P2 清零。

## Verification

- 真实 API Document revision 11 保存 `background: lines` 与 `show_image_info: true`；图片节点当前
  Version 为 2048 × 1152、860092 bytes，节点信息条显示 `2048 × 1152 · 839.9 KB`。
- 真实浏览器完成 375 × 780、768 × 900 与默认桌面核对；三背景互斥单选、Enter/方向键/Esc、焦点归还、
  undo/redo、reload 持久化均通过，无横向 UI 溢出，console logs 为空。
- 关闭图片信息后节点信息条立即消失；大图 Dialog 仍显示来源、尺寸、体积、MIME、时间、Version 与下载。
- `grid` 已从 Python/TypeScript schema、设计 proposal 和渲染分支删除，只保留三种正式背景值。
- `uv run ruff check src tests`、Canvas source-only TypeScript、设计守卫 8/8、Vite production build 通过；
  全量 Python 为 939 passed / 13 failed / 3 skipped，Web 为 381 passed / 22 failed / 13 errors，失败集合
  与 E12 基线一致，均属于本票明确排除的旧 Canvas v1、模型分类与用户脏工作项。
- Standards 与 Spec 双轴复审 P1/P2 均清零；通用菜单圆角改动已收回，仅本外观菜单应用 `rounded-xl`。
