import { useRef, type RefObject } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);

/** 时长三档（秒）。与 tokens.css 的 --motion-fast/base/slow 同值；Tailwind 类侧对应 duration-150/200/300。 */
export const MOTION_DURATION = { fast: 0.15, base: 0.2, slow: 0.3 } as const;

/** 进场 power2.out（= --ease-atelier-out），退场 power2.in（= --ease-atelier-in），高度往返 power2.inOut；
 *  pop 是小图标换态的轻微回弹，只给 16px 级别的元素用。 */
export const MOTION_EASE = { out: 'power2.out', in: 'power2.in', inOut: 'power2.inOut', pop: 'back.out(1.6)' } as const;

/** 错峰出场的间隔（秒）。 */
export const MOTION_STAGGER = 0.05;

gsap.defaults({ duration: MOTION_DURATION.base, ease: MOTION_EASE.out });

/** 动效只是空间提示，不携带信息：系统要求减弱动效时一律不播。
 *  没有 matchMedia 的环境（jsdom）按不播处理，测试里元素不会停在动画起点的透明态。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** value 变化时（首次挂载与 StrictMode 重跑都不算）在 scope 内跑一次 animate。 */
export function useAnimateOnChange<T>(
  value: T,
  scope: RefObject<HTMLElement | null>,
  animate: (value: T, previous: T) => void,
) {
  const previous = useRef(value);
  useGSAP(() => {
    const last = previous.current;
    if (Object.is(last, value)) return;
    previous.current = value;
    if (prefersReducedMotion()) return;
    animate(value, last);
  }, { dependencies: [value], scope });
}

export { gsap, useGSAP };
