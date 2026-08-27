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
