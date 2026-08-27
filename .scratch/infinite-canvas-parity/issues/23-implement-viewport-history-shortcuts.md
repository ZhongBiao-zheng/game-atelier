# 23：实现 viewport 历史与完整撤销快捷键

Type: implement

Status: completed

Blocked by: 22-implement-minimap-visibility-navigation

## Goal

补齐 B11/B12 的真实缺口：平移、缩放、适应全部和小地图导航进入同一 Document 历史；undo/redo 不只恢复
`canvas.json.viewport`，还立即同步 React Flow 视口；同时补齐 Cmd/Ctrl+Y 重做。

## Included

- viewport 手势开始时只记录一份历史快照，结束后继续走现有 Document autosave。
- toolbar Controls、适应全部和小地图点击导航均在变更前记录当前 Document；重复入口由同一快照去重。
- undo/redo 恢复 Document 后同步 React Flow viewport；同步过程不再写一条新历史、不清空 redo。
- 保留 Cmd/Ctrl+Z、Cmd/Ctrl+Shift+Z，并增加 Cmd/Ctrl+Y；输入框、选择框和可编辑元素内不劫持。
- 节点、连接、背景、图片信息、小地图显隐与 viewport 继续共用同一最多 50 条内存历史。

## Excluded

- Agent 会话历史（按已批准边界独立保存）、跨 reload 历史持久化、历史时间线 UI、修改旧 Canvas v1 测试。

## Exit gate

- 真实平移/缩放或小地图导航后，undo 同时恢复可见视口和保存 viewport；redo 再恢复目标视口。
- undo 触发的程序化 viewport 同步不清空 redo，不额外写无意义 revision。
- toolbar 按钮和 Cmd/Ctrl+Z、Shift+Z、Y 结果一致；可编辑控件内快捷键仍保留给控件。
- 背景/外观等非 viewport 命令 undo 时不会制造 viewport move。
- Ruff、Canvas TypeScript、设计守卫与 Vite production build 通过；双轴审查 P1/P2 清零。

## Verification

- 小地图真实指针导航把保存 viewport 从 A（x=-2.98）改为 B（x=-895.56），revision 19→20；toolbar undo
  以单次 revision 21 恢复 A 且 redo 仍可用，redo 以单次 revision 22 恢复 B。
- Cmd+Z / Cmd+Y 完成 revision 23→24 的 A/B 往返，Cmd+Z / Cmd+Shift+Z 完成 revision 25→26；
  项目选择框获得焦点时 Cmd+Y 不消费 redo，revision 保持 28。
- 背景改为点阵后 undo 只把背景恢复为线框，viewport 保持 B，redo 仍可用；程序化 viewport 同步未产生
  第二次 `onMoveEnd` revision。
- React Flow `Zoom In` 形成 revision 29 的 viewport 命令，undo revision 30 恢复 B；console logs 为空。
- 撤销后不等待、立即再次点击小地图，revision 31→33 正常写入新 viewport 且 undo 仍可用；再次 undo
  以 revision 34 恢复 B，证明程序化同步令牌不会吞掉紧随其后的真实手势。
- Canvas source-only TypeScript、设计守卫与 Vite production build 通过。
- 规格轴与工程轴复审均确认 P1/P2 清零；`git diff --check` 通过。
