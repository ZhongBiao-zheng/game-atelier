import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { animate, MOTION_DURATION, MOTION_EASE, prefersReducedMotion, type AnimationPlaybackControls } from '@/lib/motion';

/** 高度 0 ↔ auto 的展开区。收起时等动画播完再卸载子树；首次挂载默认不播，appear 时挂载即从 0 展开
 *  （新到达、需要交代「从这里长出来」的内容，比如刚出现的报错条、确认卡明细）。
 *  收起途中再展开（或反过来）从当前高度接着走，不归零重来。 */
export function Collapse({ open, appear = false, className, children }: {
  open: boolean;
  appear?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef(appear ? false : open);
  const lastElement = useRef<HTMLDivElement | null>(null);
  const running = useRef<AnimationPlaybackControls | null>(null);
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  useLayoutEffect(() => {
    const element = ref.current;
    // 刚从卸载态挂上的元素，起点是 0 高度（layout effect 在绘制前跑，这一帧不会闪出整块内容）。
    const freshlyMounted = element !== lastElement.current;
    lastElement.current = element;
    if (previous.current === open) return;
    previous.current = open;
    running.current?.stop();
    if (prefersReducedMotion() || !element) {
      if (!open) setMounted(false);
      return;
    }
    const from = freshlyMounted ? 0 : element.getBoundingClientRect().height;
    element.style.overflow = 'hidden';
    if (open) {
      element.style.height = 'auto';
      const to = element.scrollHeight;
      element.style.height = `${from}px`;
      const controls = animate(
        element,
        { height: [from, to], opacity: [freshlyMounted ? 0 : Number(getComputedStyle(element).opacity), 1] },
        { duration: MOTION_DURATION.slow, ease: MOTION_EASE.inOut },
      );
      running.current = controls;
      void controls.finished.then(() => {
        if (running.current !== controls) return;
        element.style.removeProperty('height');
        element.style.removeProperty('opacity');
        element.style.removeProperty('overflow');
      });
      return;
    }
    const controls = animate(
      element,
      { height: [from, 0], opacity: 0 },
      { duration: MOTION_DURATION.base, ease: MOTION_EASE.inOut },
    );
    running.current = controls;
    void controls.finished.then(() => {
      if (running.current === controls) setMounted(false);
    });
  }, [open, mounted]);

  if (!mounted) return null;
  return <div ref={ref} className={className}>{children}</div>;
}
