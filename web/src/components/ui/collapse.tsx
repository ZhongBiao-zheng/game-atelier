import { useRef, useState, type ReactNode } from 'react';

import { gsap, MOTION_DURATION, MOTION_EASE, prefersReducedMotion, useGSAP } from '@/lib/motion';

/** 高度 0 ↔ auto 的展开区。收起时等动画播完再卸载子树；首次挂载不播。 */
export function Collapse({ open, className, children }: { open: boolean; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef(open);
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  useGSAP(() => {
    if (previous.current === open) return;
    previous.current = open;
    const element = ref.current;
    if (prefersReducedMotion() || !element) {
      if (!open) setMounted(false);
      return;
    }
    if (open) {
      gsap.fromTo(
        element,
        { height: 0, opacity: 0, overflow: 'hidden' },
        {
          height: 'auto',
          opacity: 1,
          duration: MOTION_DURATION.slow,
          ease: MOTION_EASE.inOut,
          overwrite: true,
          clearProps: 'height,opacity,overflow',
        },
      );
    } else {
      gsap.to(element, {
        height: 0,
        opacity: 0,
        overflow: 'hidden',
        duration: MOTION_DURATION.base,
        ease: MOTION_EASE.inOut,
        overwrite: true,
        onComplete: () => setMounted(false),
      });
    }
  }, { dependencies: [open] });

  if (!mounted) return null;
  return <div ref={ref} className={className}>{children}</div>;
}
