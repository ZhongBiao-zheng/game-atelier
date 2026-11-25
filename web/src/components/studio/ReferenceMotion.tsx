import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import { animate, clearOnFinish, MOTION_DURATION, MOTION_EASE, MOTION_SPRING, motionAvailable, prefersReducedMotion } from '@/lib/motion';
import { cn } from '@/lib/utils';

/** 参考素材的稳定 key：同一个 File 从加入到删除始终是同一个 key，删掉中间一张时其余各张不重挂。 */
export function useFileKeys() {
  const keys = useRef(new WeakMap<File, string>());
  const next = useRef(0);
  return (file: File) => {
    let key = keys.current.get(file);
    if (!key) {
      next.current += 1;
      key = `ref-${next.current}`;
      keys.current.set(file, key);
    }
    return key;
  };
}

/** 这一帧新出现的 key（首次渲染不算）。只在挂载时读一次，之后的重渲染不会再判成新的。 */
export function useArrivingKeys(keys: readonly string[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const known = seen.current;
  const arriving = new Set(known ? keys.filter(key => !known.has(key)) : []);
  useEffect(() => {
    const nextSeen = seen.current ?? new Set<string>();
    for (const key of keys) nextSeen.add(key);
    seen.current = nextSeen;
  });
  return arriving;
}

/** 删除参考素材：被删的那张先淡出缩小 150ms，再真正移除，其余各张随后顺移。
 *  拿不到动画环境（jsdom）时当场删除。删除时按 File 身份找，等待期间别的素材增删不会删错。 */
export function useLeavingFiles(remove: (file: File) => void) {
  const [leaving, setLeaving] = useState<ReadonlySet<File>>(() => new Set());
  const latestRemove = useRef(remove);
  latestRemove.current = remove;
  const removeAfterFade = (file: File) => {
    if (!motionAvailable()) {
      remove(file);
      return;
    }
    setLeaving(current => new Set(current).add(file));
    window.setTimeout(() => {
      latestRemove.current(file);
      setLeaving(current => {
        const nextLeaving = new Set(current);
        nextLeaving.delete(file);
        return nextLeaving;
      });
    }, MOTION_DURATION.fast * 1000);
  };
  return [leaving, removeAfterFade] as const;
}

/** 删掉或加入一张后，同一行里其余各张从原位置滑到新位置（FLIP，snappy 弹簧）。
 *  按 offsetLeft 比，量的是行内位置：输入壳整体升降不会被当成移动。resetKey 变化（换筛选页签）只记位置不播。 */
export function useSlideOnReorder(container: RefObject<HTMLElement | null>, keys: readonly string[], resetKey: string) {
  const previous = useRef<{ resetKey: string; offsets: Map<string, number> } | null>(null);
  const signature = keys.join('|');
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) {
      previous.current = null;
      return;
    }
    const items = Array.from(element.querySelectorAll<HTMLElement>('[data-ref-key]'));
    const offsets = new Map(items.map(item => [item.dataset.refKey!, item.offsetLeft]));
    const last = previous.current;
    previous.current = { resetKey, offsets };
    if (!last || last.resetKey !== resetKey || !motionAvailable() || prefersReducedMotion()) return;
    for (const item of items) {
      const before = last.offsets.get(item.dataset.refKey!);
      const after = offsets.get(item.dataset.refKey!);
      if (before == null || after == null || before === after) continue;
      clearOnFinish(animate(item, { x: [before - after, 0] }, MOTION_SPRING.snappy), item, ['transform']);
    }
  }, [container, signature, resetKey]);
}

/** 一张参考素材的内层：新加入时淡入并从 90% 放大（200ms out），离开时淡出缩小（150ms subtle）。
 *  外层负责定位与扇形排布的 transform，这一层只动自己的透明度与缩放，两者不打架。 */
export function ReferenceItemMotion({ appear, leaving, className, children }: {
  appear: boolean;
  leaving: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const appearOnMount = useRef(appear);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!appearOnMount.current || !element || !motionAvailable()) return;
    const controls = prefersReducedMotion()
      ? animate(element, { opacity: [0, 1] }, { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle })
      : animate(element, { opacity: [0, 1], scale: [0.9, 1] }, { duration: MOTION_DURATION.base, ease: MOTION_EASE.out });
    clearOnFinish(controls, element);
    return () => controls.stop();
  }, []);
  return (
    <div
      ref={ref}
      className={cn('h-full w-full transition-[opacity,scale] duration-150', leaving && 'pointer-events-none opacity-0 motion-safe:scale-90', className)}
    >
      {children}
    </div>
  );
}
