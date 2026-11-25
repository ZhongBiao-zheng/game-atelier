import { useCallback, useRef } from 'react';

const FADE_PX = 24;

/** 给 .scroll-fade-y 容器写上下渐隐宽度：离顶 / 离底不足 24px 时按剩余距离收窄，滚到头正好收成 0。
 *  宽度跟着滚动连续变化，没有「到底那一下摘掉渐隐」的跳变。内容尺寸变了（展开、加载更多）也重新量。
 *  返回回调 ref：容器条件挂载（浮层打开才渲染）也能接上。 */
export function useScrollFade<T extends HTMLElement>() {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((element: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!element) return;
    const measure = () => {
      const below = element.scrollHeight - element.scrollTop - element.clientHeight;
      element.style.setProperty('--scroll-fade-top', `${clampFade(element.scrollTop)}px`);
      element.style.setProperty('--scroll-fade-bottom', `${clampFade(below)}px`);
    };
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const resizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resizes?.observe(element);
    for (const child of Array.from(element.children)) resizes?.observe(child);
    cleanup.current = () => {
      element.removeEventListener('scroll', measure);
      resizes?.disconnect();
    };
  }, []);
}

function clampFade(distance: number) {
  return Math.round(Math.max(0, Math.min(FADE_PX, distance)));
}
