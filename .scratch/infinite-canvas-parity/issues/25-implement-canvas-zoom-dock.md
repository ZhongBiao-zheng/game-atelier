# 25：实现画布百分比缩放控制

Type: implement

Status: completed

Blocked by: 24-implement-canvas-clipboard-shortcut-help

## Goal

补齐 B01 最后一个用户可见缺口：在画布底部提供参考项目同类的百分比缩放、精确滑杆与 100% 复位，
并与 React Flow viewport、Document 历史和现有适应全部入口保持同一真源。

## Included

- 桌面/中屏底部显示缩小、8%–250% 滑杆、当前百分比、放大和复位到 100%。
- 触控手机继续使用双指平移/捏合缩放，不用精确滑杆挤占画布。
- 按钮、滑杆、触控板、捏合、小地图、适应全部都更新同一 `viewport.zoom`。
- 一次滑杆拖动或连续键盘调整只产生一条历史快照与一次最终 Document 提交；undo/redo 恢复可见缩放。
- 小地图随新 dock 上移，避免重叠；沿用 Atelier 玻璃配方和设计 token。

## Excluded

- 生成组件的“1x/候选数”概念、任意超出 React Flow 8%–250% 边界的缩放、手机常驻滑杆、修改旧 Canvas v1 测试。

## Exit gate

- 滑杆、加减按钮、100% 复位与适应全部显示正确百分比并持久化；reload 一致。
- 滑杆从 pointer down 到 pointer up 只写一条 revision，键盘调整同理；undo/redo 可见视口同步且 redo 不被清空。
- 375 不出现 dock；768 与桌面 dock、小地图、工具坞和 Inspector 不重叠。
- 输入 range 有可访问名称、键盘可调，按钮有明确 label；console 无 error/warn。
- Ruff、Canvas source-only TypeScript、设计守卫与 Vite production build 通过；双轴审查 P1/P2 清零。

## Verification

- 真实页面初始 47%，放大按钮保存为 revision 218 / 57%，100% 复位 revision 219；undo revision 220
  恢复 57% 且 redo 可用，redo revision 221 再回 100%。
- 重启加载最新后端 schema 后从 revision 221 再测：放大为 revision 222 / 120%，复位后 undo revision
  224 恢复 120%，redo revision 225 回 100%；百分比与可见 viewport 同步。
- range 无 Pointer 的可访问性变更使用 120ms 合并提交；Pointer/键盘结束等待最后一个 `zoomTo`，并有
  250ms 兜底。所有 150ms 视口命令串行执行，支持手势中断和 300ms 兜底，不会阻塞离开或切项目。
- revision 252 / 75% 时点击放大并立即返回项目列表，离开流程等待动画和保存，revision 253 持久化为
  90%；重新进入后状态一致。
- 适应全部得到 50%，放大为 61%，undo 回 50% 且 redo 可用；再次点击无变化的适应全部后 redo 仍可用，
  redo 正常回到 61%。连续放大最终停在 250% 且放大按钮禁用，无保存冲突；最终复位保存为 revision
  261 / 100%。
- 375×780 时 dock 隐藏且 `scrollWidth === clientWidth === 375`；640×900 时 dock 隐藏且无横向溢出；
  768×900 时 dock 显示，并与小地图、右侧 Inspector 均无重叠。
- 真实 console error/warn 为空；Canvas source-only TypeScript、设计守卫 8/8、Vite production build、
  Ruff 与 `git diff --check` 通过；规格/工程双轴审查 P1/P2 清零。
