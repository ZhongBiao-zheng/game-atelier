import { useRef, type ReactNode } from 'react';

import { gsap, MOTION_DURATION, MOTION_EASE, useAnimateOnChange } from '@/lib/motion';
import { cn } from '@/lib/utils';

/** 图标换态（播放/暂停、显示/隐藏、复制/已复制、图标/加载中）时，新图标缩放弹入。
 *  swapKey 是决定显示哪个图标的状态；首次挂载不播。 */
export function SwapIcon({ swapKey, className, children }: {
  swapKey: string | number | boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useAnimateOnChange(swapKey, ref, () => {
    gsap.fromTo(
      ref.current,
      { scale: 0.6, opacity: 0 },
      { scale: 1, opacity: 1, duration: MOTION_DURATION.base, ease: MOTION_EASE.pop, clearProps: 'opacity,transform' },
    );
  });
  return <span ref={ref} className={cn('inline-grid shrink-0 place-items-center', className)}>{children}</span>;
}
