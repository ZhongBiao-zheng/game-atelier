# 22：实现小地图显隐与点击导航

Type: implement

Status: completed

Blocked by: 21-implement-canvas-appearance-image-info

## Goal

补齐 B17：复用 React Flow 已有 MiniMap 的平移/缩放能力，让画布作者在外观菜单中控制小地图显隐，
并可点击小地图位置快速导航；偏好继续属于当前 Canvas Document。

## Included

- `CanvasSettings` 新增 `show_minimap`，默认开启；Python、TypeScript 与 schema proposal 同步。
- 画布外观菜单增加“显示小地图”，修改形成一个历史命令并随 Document revision 自动保存。
- 小地图开启时保留拖拽平移与滚轮缩放；点击空白或节点区域把当前视口中心移动到对应画布坐标。
- 小地图导航产生的 viewport 继续走现有 `onMoveEnd` 保存，不引入第二套视口状态。
- 375px 仍强制隐藏小地图；768px 与桌面按项目设置显示，避免占用手机底部空间。

## Excluded

- 自定义小地图尺寸/位置/配色、手机端小地图、新缩放滑杆、重写 React Flow MiniMap 和修改旧 Canvas v1 测试。

## Exit gate

- 设置开关可键盘访问，关闭/开启立即生效，并支持 undo/redo 与 reload 持久化。
- 768px/桌面点击小地图后 viewport 中心与保存值同步；拖拽和滚轮能力仍开启。
- 375px 无论设置值都不渲染可见小地图，不与手机控制区抢空间。
- Ruff、Canvas TypeScript、设计守卫与 Vite production build 通过；双轴审查 P1/P2 清零。

## Verification

- 原 revision 11 的 Document 未显式保存新字段时，schema 默认返回 `show_minimap: true`；首次设置写入正常
  Document revision，不制造 sidecar 或第二套状态。
- 真实浏览器关闭后小地图立即消失，undo 恢复、redo 再次隐藏，随后开启并 reload 仍显示；revision 11→15。
- 默认桌面与 768 × 900 可访问树包含 `img "画布小地图"`；375 × 780 在设置仍为 true 时不包含可见
  小地图，外观菜单开关仍保持 checked。
- 用真实指针点击小地图右下与左上区域，保存 viewport 的 x 从 -1009.17 变为 -2.98，zoom 保持
  1.5889，Document revision 18→19；MiniMap 的 pannable/zoomable 继续启用。
- 浏览器 console logs 为空；Ruff、Canvas source-only TypeScript、设计守卫与 Vite production build 通过。
- 全量 Python 为 939 passed / 13 failed / 3 skipped，Web 为 381 passed / 22 failed / 13 errors，失败集合
  与 E21 基线一致；Standards 与 Spec 双轴审查 P1/P2 均清零。
