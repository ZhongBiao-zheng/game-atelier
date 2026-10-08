import { useRef } from 'react';

import { gsap, MOTION_DURATION, useAnimateOnChange } from '@/lib/motion';

/** 按钮文案在两个状态间切换（保存 / 保存中…）。另一段文案用 CSS attr() 叠在同一格里占位，
 *  按钮宽度取两段中较宽的，切换时不跳；占位不进 DOM 文本，不影响读屏与按文字查找。新文案淡入，首次挂载不播。 */
export function SwapLabel({ active, on, off }: { active: boolean; on: string; off: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useAnimateOnChange(active, ref, () => {
    gsap.from(ref.current, { opacity: 0, duration: MOTION_DURATION.fast, clearProps: 'opacity' });
  });
  return (
    <span className="inline-grid justify-items-center">
      <span ref={ref} className="col-start-1 row-start-1">{active ? on : off}</span>
      <span
        aria-hidden="true"
        data-label={active ? off : on}
        className="invisible col-start-1 row-start-1 before:content-[attr(data-label)]"
      />
    </span>
  );
}
