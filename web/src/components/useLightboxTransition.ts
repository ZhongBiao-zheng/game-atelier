import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { animate, clearOnFinish, motionAvailable, MOTION_DURATION, MOTION_EASE, prefersReducedMotion } from '@/lib/motion';

function visible(rect?: DOMRect | null) {
  return rect && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
    rect.left < window.innerWidth && rect.top < window.innerHeight;
}

/** The flying copy can cross the edge of the clipped zoom viewport. */
export function useLightboxTransition(image: RefObject<HTMLImageElement>, viewport: RefObject<HTMLDivElement>, sourceRect: DOMRect | null | undefined, src: string) {
  const source = useRef(sourceRect);
  source.current = sourceRect;
  const active = useRef<{ element: HTMLElement; cancel: () => void } | null>(null);
  const cancel = useCallback(() => active.current?.cancel(), []);
  useEffect(() => cancel, [cancel, src]);
  const transition = useCallback((closing: boolean) => {
    const img = image.current;
    const last = active.current?.element.getBoundingClientRect();
    active.current?.cancel();
    if (!img || !motionAvailable() || prefersReducedMotion()) return;
    const duration = closing ? MOTION_DURATION.fast : MOTION_DURATION.base;
    const ease = closing ? MOTION_EASE.subtle : MOTION_EASE.out;
    const target = img.getBoundingClientRect();
    const origin = source.current;
    const stage = closing ? viewport.current?.getBoundingClientRect() : null;
    // A body-level copy would reveal the pixels currently clipped by the stage.
    const clipped = closing && (!stage || target.left < stage.left || target.right > stage.right ||
      target.top < stage.top || target.bottom > stage.bottom);
    if (clipped || !origin || !visible(origin) || !visible(target)) {
      const animation = clearOnFinish(animate(img, { scale: closing ? [1, .96] : [.96, 1] }, { duration, ease }), img, ['transform']);
      const running = { element: img, cancel: () => { animation.stop(); img.style.removeProperty('transform'); active.current = null; } };
      active.current = running;
      void animation.finished.then(() => { if (active.current === running) active.current = null; });
      return;
    }
    const from = closing ? last ?? target : origin, to = closing ? origin : target;
    const copy = img.cloneNode(false) as HTMLImageElement;
    copy.alt = '';
    copy.setAttribute('aria-hidden', 'true');
    copy.className = 'media-checker pointer-events-none fixed z-[60] max-w-none rounded-lg';
    Object.assign(copy.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px`, transformOrigin: 'top left' });
    document.body.append(copy);
    img.style.visibility = 'hidden';
    const animation = animate(copy, { x: [from.left - to.left, 0], y: [from.top - to.top, 0],
      scaleX: [from.width / to.width, 1], scaleY: [from.height / to.height, 1],
      opacity: closing ? [1, 0] : [1, 1] }, { duration, ease });
    const cancel = () => { animation.stop(); copy.remove(); img.style.removeProperty('visibility'); active.current = null; };
    const running = { element: copy, cancel };
    active.current = running;
    void animation.finished.then(() => { if (active.current === running) { copy.remove(); if (!closing) img.style.removeProperty('visibility'); active.current = null; } });
  }, [image, viewport]);
  return { transition, cancel };
}
