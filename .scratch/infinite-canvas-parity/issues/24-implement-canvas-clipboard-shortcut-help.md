# 24：实现画布剪贴板与快捷键帮助

Type: implement

Status: completed

Blocked by: 23-implement-viewport-history-shortcuts

## Goal

把参考基线快捷键弹窗中的画布机械能力落到生产页：用户可发现且可真实执行全选、同项目节点复制粘贴、
系统文本/图片粘贴、删除和 Escape 收拢；Space / Control 临时平移继续适配 Mac 两指平移、单指框选。

## Included

- 画布工具坞增加快捷键入口，Dialog 只展示当前真实可执行的操作与 Mac/Windows 对应按键。
- Cmd/Ctrl+A 全选节点；Cmd/Ctrl+C/V 复制粘贴所选节点及所选节点之间的 input 连接；不伪造
  Generation Run 的 derivation 来源。
- 节点副本复用不可变 Content Version，但清除运行中指针；重复粘贴逐次错位并进入统一 Document 历史。
- 副本 Draft 的已复制 `@[node:id]` mention 重映射到新节点；未复制来源的 mention 移除，避免悬空引用。
- 自定义节点剪贴板仅允许同一项目使用，不静默跨项目复制媒体所有权。
- 系统剪贴板纯文本粘贴为人工文本节点，图片文件复用现有服务端上传与不可变 Version 流程。
- 上传型粘贴与其他新命令一样清空 redo 分支，并保持最多 50 条内存历史。
- Delete/Backspace 一次删除节点、边及节点关联连接；输入控件不劫持。
- Esc 按最上层优先关闭快捷键 Dialog、节点菜单、连接菜单、创作库，再清选择；Dialog 交由 Radix 收口。
- React Flow 使用 Space / Control 作为临时平移激活键，不改变两指平移、单指框选默认行为。

## Excluded

- 跨项目隐式粘贴、操作系统级富媒体导出、剪切、剪贴板历史、修改旧 Canvas v1 测试。

## Exit gate

- 节点与内部 input 连接复制后生成新 ID、位置错开、源节点不变；undo/redo 只产生一次 Document 命令。
- 跨项目旧节点剪贴板不落入新项目；系统文本/图片仍可粘贴。
- 输入框内 A/C/V/Delete/Backspace 不被画布消费。
- Esc 每次只关闭最上层浮层，最终清空节点与边选择并把焦点还给画布。
- 快捷键 Dialog 在桌面、768 与 375 宽度无溢出，键盘可开关并归还焦点。
- Ruff、Canvas source-only TypeScript、设计守卫与 Vite production build 通过；双轴审查 P1/P2 清零。

## Verification

- 真实项目 revision 204 上 Cmd+A/C/V 复制 6 个节点与其 5 条内部连接：新节点与连接 ID 全部重建、
  位置统一偏移 28、`active_run_id` 清空，单次保存为 revision 205；undo/redo 分别为 206/207。
- 浏览器剪贴板纯文本创建 `粘贴文本` 人工 Version 并保存为 revision 208；1×1 PNG 通过现有 upload
  生成 `clipboard.png` 节点与不可变上传 Version，无 console error/warn。
- 提示词输入框内 Cmd+A 与 Backspace 只编辑输入值，节点数量不变；未通过浏览器删除真实项目节点。
- 同时打开创作库与添加菜单后连续三次 Esc，依次关闭添加菜单、创作库、节点选择；快捷键 Dialog
  Escape 关闭后焦点回到触发按钮。
- 点击画布空白后焦点回到编辑器 region；随后 Cmd+A 真实选择 14 个节点，工具按钮焦点也不再阻断
  非输入类画布快捷键。
- 375×780 下页面 `scrollWidth === clientWidth === 375`，Dialog 位于 x=16..359 且内部纵向滚动；
  默认桌面布局通过。
- Canvas source-only TypeScript、设计守卫 8/8 与 Vite production build 通过。
- 双轴复审发现并清除重复粘贴周期重叠、derivation 伪造、旧 mention、图片粘贴 redo 分叉与旧剪贴板
  fallback 风险；最终 P1/P2 清零，Ruff 与 `git diff --check` 通过。
