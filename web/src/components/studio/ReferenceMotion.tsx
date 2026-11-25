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

/** 正在退场的参考素材副本：slot 是删除那一刻它在显示列表里的位置。 */
export interface LeavingRef<T> {
  slot: number;
  snapshot: T;
}

/** 删除参考素材的退场副本：业务引用由调用方当场移除（提交与 @ 编号立即生效），
 *  这里只保留缩略图副本在原位淡出缩小 150ms 再卸载，其余各张随后顺移。
 *  拿不到动画环境（jsdom）时不留副本，直接 release。 */
export function useLeavingRefs<T>(release: (snapshot: T) => void) {
  const [leaving, setLeaving] = useState<readonly LeavingRef<T>[]>([]);
  const latestRelease = useRef(release);
  latestRelease.current = release;
  const timers = useRef(new Set<number>());
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(timer => window.clearTimeout(timer));
  }, []);
  const keep = (entry: LeavingRef<T>) => {
    if (!motionAvailable()) {
      latestRelease.current(entry.snapshot);
      return;
    }
    setLeaving(current => [...current, entry]);
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setLeaving(current => current.filter(item => item !== entry));
      latestRelease.current(entry.snapshot);
    }, MOTION_DURATION.fast * 1000);
    timers.current.add(timer);
  };
  return [leaving, keep] as const;
}

/** 把退场副本按删除时的位置插回当前列表；位置越界时排到末尾。 */
export function withLeaving<T>(live: readonly T[], leaving: readonly LeavingRef<T>[]): T[] {
  const display = [...live];
  for (const entry of leaving) display.splice(Math.min(entry.slot, display.length), 0, entry.snapshot);
  return display;
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
