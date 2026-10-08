import { useLayoutEffect, useRef } from 'react';

import { gsap, MOTION_DURATION, MOTION_EASE, prefersReducedMotion } from '@/lib/motion';
import { cn } from '@/lib/utils';

const SELECTED = '[aria-selected="true"], [aria-pressed="true"], [aria-checked="true"]';

/** 单选组的选中底色。放进组容器（容器需 relative isolate），跟随带 aria-selected / pressed / checked
 *  为 true 的子按钮，换选中时从旧位置滑到新位置；子按钮自身不再画选中底色。
 *  位置用 offset 链而不是 getBoundingClientRect：画布缩放的 transform 不会让底色错位。 */
export function SelectionHighlight({ className }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const highlight = ref.current;
    const group = highlight?.parentElement;
    if (!highlight || !group) return;
    let placed = false;
    const place = () => {
      const target = group.querySelector<HTMLElement>(SELECTED);
      const offset = target ? offsetWithin(target, group) : null;
      if (!target || !offset) {
        gsap.set(highlight, { opacity: 0 });
        placed = false;
        return;
      }
      const vars = { x: offset.x, y: offset.y, width: target.offsetWidth, height: target.offsetHeight, opacity: 1 };
      if (!placed || prefersReducedMotion()) {
        gsap.set(highlight, vars);
        placed = true;
        return;
      }
      gsap.to(highlight, { ...vars, duration: MOTION_DURATION.base, ease: MOTION_EASE.out, overwrite: true });
    };
    place();
    const mutations = new MutationObserver(place);
    mutations.observe(group, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-selected', 'aria-pressed', 'aria-checked'],
    });
    const resizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    resizes?.observe(group);
    return () => {
      mutations.disconnect();
      resizes?.disconnect();
      gsap.killTweensOf(highlight);
    };
  }, []);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cn('pointer-events-none absolute left-0 top-0 -z-10 rounded-md bg-secondary opacity-0 ring-1 ring-primary/60', className)}
    />
  );
}

function offsetWithin(element: HTMLElement, container: HTMLElement) {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = element;
  while (node && node !== container) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return node === container ? { x, y } : null;
}
