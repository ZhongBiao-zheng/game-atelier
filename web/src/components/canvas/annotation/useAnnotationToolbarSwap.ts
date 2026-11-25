import { useEffect, useState } from 'react';
import { motionAvailable } from '@/lib/motion';
import { cn } from '@/lib/utils';

/** 进入 / 退出标注时，节点工具条从节点上方换到下方（或反过来）。不在两个位置之间瞬移：
 *  旧工具条在原位 150ms 淡出，换成新工具条、新位置，再 200ms 淡入。
 *  返回「屏上该画哪一种」与加在工具条外层的透明度类（只动透明度，不碰 xyflow 写的定位 transform）。
 *  减弱动态效果照样淡变（只有透明度）；jsdom 没有 matchMedia，直接换。 */
export function useAnnotationToolbarSwap(annotating: boolean) {
  const [shown, setShown] = useState(annotating);
  const [phase, setPhase] = useState<'idle' | 'out' | 'in'>('idle');
  useEffect(() => {
    if (annotating === shown) {
      // 淡出途中又切了回来：停在原位重新显示。
      setPhase(current => current === 'out' ? 'idle' : current);
      return;
    }
    if (!motionAvailable()) { setShown(annotating); return; }
    setPhase('out');
    const timer = window.setTimeout(() => { setShown(annotating); setPhase('in'); }, 150);
    return () => window.clearTimeout(timer);
  }, [annotating, shown]);
  useEffect(() => {
    if (phase !== 'in') return;
    // 新工具条先以透明态画出一帧，再撤掉透明，过渡才有起点。
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setPhase('idle')); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [phase]);
  return {
    annotating: shown,
    className: cn(
      phase === 'out' && 'pointer-events-none opacity-0 transition-opacity duration-150',
      phase === 'in' && 'pointer-events-none opacity-0',
      phase === 'idle' && 'transition-opacity duration-200 ease-out',
    ),
  };
}
