import { useLayoutEffect, useRef } from 'react';

import { animate, MOTION_SPRING, prefersReducedMotion, type AnimationPlaybackControls } from '@/lib/motion';
import { cn } from '@/lib/utils';

const SELECTED = '[aria-selected="true"], [aria-pressed="true"], [aria-checked="true"], [aria-current="page"], [aria-current="true"]';
const UNDERLINE_HEIGHT = 2;

/** 单选组的选中指示。放进组容器（容器需 relative isolate），跟随带 aria-selected / pressed / checked / current
 *  的子项，换选中时从旧位置滑到新位置；子项自身不再画选中底色。
 *  variant="fill" 是铺满选中项的底色；"underline" 是贴在选中项底边的 2px 下划线（线型页签）。
 *  位置用 offset 链而不是 getBoundingClientRect：画布缩放的 transform 不会让指示错位。 */
export function SelectionHighlight({ className, variant = 'fill' }: { className?: string; variant?: 'fill' | 'underline' }) {
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
      const underline = variant === 'underline';
      const vars = {
        x: offset.x,
        y: underline ? offset.y + target.offsetHeight - UNDERLINE_HEIGHT : offset.y,
        width: target.offsetWidth,
        height: underline ? UNDERLINE_HEIGHT : target.offsetHeight,
        opacity: 1,
      };
      const instant = !placed || !glide || prefersReducedMotion();
      running = animate(highlight, vars, instant ? { duration: 0 } : MOTION_SPRING.snappy);
      placed = true;
    };
    place(false);
    // 组本身与直接子块的尺寸变化（分组里异步长出一项、换行）只是重新对齐，直接到位。
    const resizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place(false));
    // 只接新出现的子块：重复 observe 同一元素会立刻再报一次尺寸，把正在滑的指示打断成瞬移。
    const observed = new WeakSet<Element>();
    const observeSizes = () => {
      for (const element of [group, ...Array.from(group.children)]) {
        if (element === highlight || observed.has(element)) continue;
        observed.add(element);
        resizes?.observe(element);
      }
    };
    observeSizes();
    const mutations = new MutationObserver(() => { observeSizes(); place(true); });
    mutations.observe(group, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-selected', 'aria-pressed', 'aria-checked', 'aria-current'],
    });
    return () => {
      mutations.disconnect();
      resizes?.disconnect();
      running?.stop();
    };
  }, [variant]);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute left-0 top-0 -z-10 opacity-0',
        variant === 'underline' ? 'rounded-full bg-primary' : 'rounded-md bg-secondary ring-1 ring-inset ring-primary/60',
        className,
      )}
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
