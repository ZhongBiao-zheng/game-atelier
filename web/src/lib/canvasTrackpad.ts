export interface CanvasWheelGesture {
  ctrlKey: boolean;
  deltaX: number;
  deltaY: number;
}

/**
 * Safari and Chromium can interpret an unclaimed horizontal trackpad gesture as
 * browser history navigation. React Flow already owns gestures over the pane,
 * but controls and nodes marked `nowheel` deliberately bypass its wheel handler.
 */
export function shouldPreventCanvasHistoryNavigation(gesture: CanvasWheelGesture) {
  if (gesture.ctrlKey) return false;
  const horizontalDistance = Math.abs(gesture.deltaX);
  return horizontalDistance >= 1 && horizontalDistance > Math.abs(gesture.deltaY);
}

/**
 * 滚轮语义必须按输入设备分：鼠标滚轮要缩放，触控板双指滑动要平移。两者用的是同一个 wheel
 * 事件、deltaMode 也都是 0，运行时区分不了，所以只能按平台近似（macOS 触控板优先，其余鼠标
 * 优先）。捏合（浏览器发 ctrlKey 滚轮）在两个平台上都是缩放。
 */
export const WHEEL_ZOOMS_BY_DEFAULT = !/Mac/i.test(navigator.userAgent);

/** 不经 xyflow 的缩放面（大图查看器）用同一套判别：捏合缩放；macOS 上双指滑动平移，
 *  其余平台纵向滚轮缩放、横向为主（Shift + 滚轮、横滚）平移。 */
export function wheelGestureZooms(gesture: CanvasWheelGesture) {
  if (gesture.ctrlKey) return true;
  return WHEEL_ZOOMS_BY_DEFAULT && Math.abs(gesture.deltaY) >= Math.abs(gesture.deltaX);
}
