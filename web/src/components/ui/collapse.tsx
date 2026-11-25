import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { animate, MOTION_DURATION, MOTION_EASE, prefersReducedMotion, type AnimationPlaybackControls } from '@/lib/motion';

/** 高度 0 ↔ auto 的展开区。收起时等动画播完再卸载子树；首次挂载默认不播，appear 时挂载即从 0 展开
 *  （新到达、需要交代「从这里长出来」的内容，比如刚出现的报错条、确认卡明细）。
 *  keepMounted：收起后子树留在 DOM 里、只是不显示（同原生 <details>），表单字段的值不丢。
 *  收起途中再展开（或反过来）从当前高度接着走，不归零重来。
 *  收起那一刻内容就 inert（不能聚焦、点击、读屏），只留视觉退场；焦点原在里面时调 onFocusEscape 交给调用方接回
 *  （通常是触发器），不传则由浏览器落回 body。 */
export function Collapse({ open, appear = false, keepMounted = false, onFocusEscape, className, children }: {
  open: boolean;
  appear?: boolean;
  keepMounted?: boolean;
  onFocusEscape?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef(appear ? false : open);
  const lastElement = useRef<HTMLDivElement | null>(null);
  const running = useRef<AnimationPlaybackControls | null>(null);
  const latestFocusEscape = useRef(onFocusEscape);
  latestFocusEscape.current = onFocusEscape;
  const [mounted, setMounted] = useState(open || keepMounted);
  const [hidden, setHidden] = useState(!open);
  // 上一次提交时是否藏着：从 hidden 恢复的元素和刚挂上的一样，从 0 高度长出来。
  const wasHidden = useRef(!open);
  if (open && !mounted) setMounted(true);
  if (open && hidden) setHidden(false);

  useLayoutEffect(() => {
    const element = ref.current;
    // 刚从卸载态挂上的元素，起点是 0 高度（layout effect 在绘制前跑，这一帧不会闪出整块内容）。
    const freshlyMounted = element !== lastElement.current || wasHidden.current;
    lastElement.current = element;
    wasHidden.current = false;
    if (element) {
      // inert 前先看焦点在不在里面：inert 之后浏览器会把焦点扔回 body。
      const hadFocus = !open && element.contains(document.activeElement);
      element.inert = !open;
      if (hadFocus) latestFocusEscape.current?.();
    }
    if (previous.current === open) return;
    previous.current = open;
    running.current?.stop();
    const settleClosed = () => {
      if (keepMounted) {
        wasHidden.current = true;
        setHidden(true);
      } else setMounted(false);
    };
    if (prefersReducedMotion() || !element) {
      if (!open) settleClosed();
      else clearInline(element);
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
        if (running.current === controls) clearInline(element);
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
      // keepMounted 时内联的 0 高度留着（藏起前不闪回原高度），下次展开会重新量。
      if (running.current === controls) settleClosed();
    });
  }, [open, mounted, keepMounted]);

  if (!mounted) return null;
  // 收起后用 display:none（hidden! 类）而不是 hidden 属性：与原生 <details> 一样，收着的字段仍在 DOM 里可查。
  const collapsed = keepMounted && hidden && !open;
  return <div ref={ref} data-collapsed={collapsed || undefined} className={collapsed ? `${className ?? ''} hidden!` : className}>{children}</div>;
}

function clearInline(element: HTMLElement | null) {
  element?.style.removeProperty('height');
  element?.style.removeProperty('opacity');
  element?.style.removeProperty('overflow');
}
