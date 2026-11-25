import { useRef, type ReactNode } from 'react';

import {
  animate,
  clearOnFinish,
  MOTION_DURATION,
  MOTION_EASE,
  MOTION_SPRING,
  useAnimateOnChange,
  type AnimationPlaybackControls,
} from '@/lib/motion';
import { cn } from '@/lib/utils';

/** 图标换态（播放/暂停、显示/隐藏、图标/加载中）时，新图标从略小处淡入放大。swapKey 是决定显示哪个图标的状态；首次挂载不播。
 *  variant="pop" 带一点回弹，只给正向确认（喜欢、复制成功、保存成功的勾）；功能开关一律用默认的平稳版，工具栏不显得轻浮。
 *  减弱动态效果时只淡入不缩放；连按时新一段接管，不叠加。 */
export function SwapIcon({ swapKey, variant = 'subtle', className, children }: {
  swapKey: string | number | boolean;
  variant?: 'subtle' | 'pop';
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const running = useRef<AnimationPlaybackControls | null>(null);
  useAnimateOnChange(swapKey, (_value, _previous, reduced) => {
    const element = ref.current;
    if (!element) return;
    running.current?.stop();
    const fade = { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle };
    const controls = reduced
      ? animate(element, { opacity: [0, 1] }, fade)
      : variant === 'pop'
        ? animate(element, { scale: [0.6, 1], opacity: [0, 1] }, { ...MOTION_SPRING.pop, opacity: fade })
        : animate(element, { scale: [0.85, 1], opacity: [0, 1] }, fade);
    running.current = clearOnFinish(controls, element);
  }, { keepWhenReduced: true });
  return <span ref={ref} className={cn('inline-grid shrink-0 place-items-center', className)}>{children}</span>;
}
