import { useLayoutEffect, useRef } from 'react';
import { animate, stagger, type AnimationPlaybackControls, type Transition } from 'motion/react';

/** 时长三档（秒）。与 tokens.css 的 --motion-fast/base/slow 同值；Tailwind 类侧对应 duration-150/200/300。 */
export const MOTION_DURATION = { fast: 0.15, base: 0.2, slow: 0.3 } as const;

/** 缓动，与 tokens.css 的 --ease-atelier-* 同值。
 *  out：200–300ms 的空间进场；subtle：150ms 的颜色、透明度、微位移，以及所有退场；inOut：屏上位移、展开收起。 */
export const MOTION_EASE = {
  out: [0.22, 1, 0.36, 1],
  subtle: [0.2, 0, 0, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const;

/** 弹簧。snappy：选中滑块、布局移动、拖拽让位，无回弹，中途打断时带着当前速度接上；
 *  pop：只给 24px 以内的正向确认图标（勾、心、复制成功）。 */
export const MOTION_SPRING = {
  snappy: { type: 'spring', visualDuration: 0.25, bounce: 0 },
  pop: { type: 'spring', visualDuration: 0.28, bounce: 0.18 },
} as const satisfies Record<string, Transition>;

/** 错峰出场的间隔（秒）。 */
export const MOTION_STAGGER = 0.05;

/** 动效只是空间提示，不携带信息：系统要求减弱动效时一律不播。
 *  没有 matchMedia 的环境（jsdom）按不播处理，测试里元素不会停在动画起点的透明态。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** value 变化时（首次挂载与 StrictMode 重跑都不算）跑一次 run。
 *  减弱动态效果时默认跳过；只动透明度的动画传 keepWhenReduced，由 run 按第三个参数去掉位移与缩放。 */
export function useAnimateOnChange<T>(
  value: T,
  run: (value: T, previous: T, reduced: boolean) => void,
  { keepWhenReduced = false }: { keepWhenReduced?: boolean } = {},
) {
  const previous = useRef(value);
  const latestRun = useRef(run);
  latestRun.current = run;
  useLayoutEffect(() => {
    const last = previous.current;
    if (Object.is(last, value)) return;
    previous.current = value;
    // 没有 matchMedia 的环境（jsdom）一律不播，测试里元素不会停在透明的起点。
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const reduced = prefersReducedMotion();
    if (reduced && !keepWhenReduced) return;
    latestRun.current(value, last, reduced);
  }, [value, keepWhenReduced]);
}

/** 动画播完后摘掉写在元素上的内联样式，让样式表重新接管（等同 GSAP 的 clearProps）。 */
export function clearOnFinish(
  controls: AnimationPlaybackControls,
  elements: Element | Iterable<Element>,
  properties: readonly string[] = ['opacity', 'transform'],
) {
  const list = elements instanceof Element ? [elements] : Array.from(elements);
  void controls.finished.then(() => {
    for (const element of list) {
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
      for (const property of properties) element.style.removeProperty(property);
    }
  });
  return controls;
}

export { animate, stagger };
export type { AnimationPlaybackControls };
