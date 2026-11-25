import { useLayoutEffect, useRef } from 'react';

import { animate, MOTION_SPRING, prefersReducedMotion, type AnimationPlaybackControls } from '@/lib/motion';
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
    let running: AnimationPlaybackControls | null = null;
    // 选中项变化时滑过去（弹簧，连点时带速度接上）；容器尺寸变化只是重新对齐，直接到位，不追着跑。
    const place = (glide: boolean) => {
      const target = group.querySelector<HTMLElement>(SELECTED);
      const offset = target ? offsetWithin(target, group) : null;
      // 不先 stop：新动画接管同一组值时，motion 会沿用正在跑的速度。
      if (!target || !offset) {
        running = animate(highlight, { opacity: 0 }, { duration: 0 });
        placed = false;
        return;
      }
      const vars = { x: offset.x, y: offset.y, width: target.offsetWidth, height: target.offsetHeight, opacity: 1 };
      const instant = !placed || !glide || prefersReducedMotion();
      running = animate(highlight, vars, instant ? { duration: 0 } : MOTION_SPRING.snappy);
      placed = true;
    };
    place(false);
    const mutations = new MutationObserver(() => place(true));
    mutations.observe(group, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-selected', 'aria-pressed', 'aria-checked'],
    });
    const resizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place(false));
    resizes?.observe(group);
    return () => {
      mutations.disconnect();
      resizes?.disconnect();
      running?.stop();
    };
  }, []);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cn('pointer-events-none absolute left-0 top-0 -z-10 rounded-md bg-secondary opacity-0 ring-1 ring-inset ring-primary/60', className)}
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
