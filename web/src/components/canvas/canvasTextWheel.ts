import { useCallback, useRef } from 'react';

interface WheelGesture { ctrlKey: boolean; deltaX: number; deltaY: number }
interface ScrollBox { scrollHeight: number; clientHeight: number }

/** 指针在文本节点正文上时，滚轮滚正文而不是画布（飙哥 2026-11-27 定，不论节点是否选中）。
 *  三种情况仍交给画布：捏合（ctrl+滚轮）缩放、横向为主的手势平移、正文放得下没东西可滚。 */
export function textPreviewOwnsWheel(gesture: WheelGesture, box: ScrollBox): boolean {
  if (gesture.ctrlKey) return false;
  if (Math.abs(gesture.deltaX) > Math.abs(gesture.deltaY)) return false;
  return box.scrollHeight > box.clientHeight;
}

const LINE_PX = 16;

/** 回调 ref：挂到文本节点的滚动容器上。不用 xyflow 的 nowheel——它会连捏合缩放一起拦掉。 */
export function useTextPreviewWheel<T extends HTMLElement>() {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((element: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!textPreviewOwnsWheel(event, element)) return;
      // 停在冒泡阶段：画布的缩放 / 平移监听挂在祖先上，收不到这次滚动。
      event.preventDefault();
      event.stopPropagation();
      const unit = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? element.clientHeight : 1;
      element.scrollTop += event.deltaY * unit;
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    cleanup.current = () => element.removeEventListener('wheel', onWheel);
  }, []);
}
