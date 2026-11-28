import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent, type TransitionEvent } from 'react';
import { wheelGestureZooms } from '@/lib/canvasTrackpad';
import { prefersReducedMotion } from '@/lib/motion';

export const LIGHTBOX_ZOOM_STEP = 1.12;
/** 缩放栏 − / + 的离散档位；键盘 + / - 与滚轮仍按连续倍率走。 */
const LIGHTBOX_ZOOM_LEVELS = [.25, .5, .75, 1, 1.5, 2, 3, 4];
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
// 离散缩放（预设、键盘、双击）是屏上 A→B 的位移：slow + in-out。跟手的滚轮、拖动不加过渡。
const ZOOM_TRANSITION = 'transform var(--motion-slow) var(--ease-atelier-in-out)';

/** 过渡中途平面实际所在的位置：computed transform 是 matrix() 或 matrix3d()。 */
function visualTransform(element: HTMLElement) {
  const value = getComputedStyle(element).transform;
  if (!value || value === 'none') return null;
  const n = value.slice(value.indexOf('(') + 1, -1).split(',').map(Number);
  if (n.length === 6) return { scale: n[0], x: n[4], y: n[5] };
  if (n.length === 16) return { scale: n[0], x: n[12], y: n[13] };
  return null;
}

export function useLightboxZoom(src: string) {
  const viewport = useRef<HTMLDivElement>(null);
  const plane = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const view = useRef({ scale: null as number | null, x: 0, y: 0 });
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const animating = useRef(false);
  const [preset, setPreset] = useState<null | 1 | 2 | 'custom'>(null);
  const [percent, setPercent] = useState(100);
  // 整张图在原尺寸下就放得下（fit 封顶为 1）：「适配」与「100%」画面相同。
  const [fitsWhole, setFitsWhole] = useState(false);
  const reported = useRef(100);

  const measure = useCallback(() => {
    const stage = viewport.current, img = image.current;
    if (!stage || !img?.naturalWidth || !img.naturalHeight) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const fit = Math.min(1, rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    return { rect, fit, width: img.naturalWidth, height: img.naturalHeight };
  }, []);

  const geometry = useRef<ReturnType<typeof measure>>();
  const paint = useCallback((size = measure(), animated = false) => {
    geometry.current = size;
    const state = view.current;
    if (!size || !plane.current || !viewport.current) return;
    const scale = state.scale ?? size.fit;
    const mx = Math.max(0, (size.width * scale - size.rect.width) / 2);
    const my = Math.max(0, (size.height * scale - size.rect.height) / 2);
    state.x = clamp(state.x, -mx, mx);
    state.y = clamp(state.y, -my, my);
    // 过渡进行中再换目标，浏览器从当前视觉位置接着过渡。
    if (animated && !prefersReducedMotion()) {
      plane.current.style.transition = ZOOM_TRANSITION;
      animating.current = true;
    }
    plane.current.style.transform = `translate3d(${state.x}px,${state.y}px,0) scale(${scale / size.fit})`;
    viewport.current.dataset.pannable = String(Boolean(mx || my));
    setFitsWhole(size.fit >= 1);
    const rounded = Math.round(scale * 100);
    if (reported.current !== rounded) {
      reported.current = rounded;
      setPercent(rounded);
    }
  }, [measure]);

  /** 跟手操作（滚轮、捏合、拖动）开始：去掉过渡，从平面当前的视觉位置接上，不先跳到上一次过渡的终点。 */
  const settle = useCallback(() => {
    const el = plane.current;
    if (!animating.current || !el) return;
    animating.current = false;
    const size = geometry.current;
    const visual = visualTransform(el);
    el.style.removeProperty('transition');
    if (!size || !visual) return;
    const state = view.current;
    const scale = visual.scale * size.fit;
    if (Math.abs(scale - (state.scale ?? size.fit)) > 1e-3) {
      state.scale = scale;
      setPreset('custom');
    }
    state.x = visual.x;
    state.y = visual.y;
    paint(size);
  }, [paint]);

  /** 现在能不能拖：过渡途中按画面实际大小判断（缩回适配时终点已不可拖，画面却还比视口大）。 */
  const canPan = useCallback((element: HTMLElement) => {
    if (element.dataset.pannable === 'true') return true;
    const size = geometry.current;
    const visual = animating.current && plane.current ? visualTransform(plane.current) : null;
    if (!size || !visual) return false;
    const scale = visual.scale * size.fit;
    return size.width * scale > size.rect.width + .5 || size.height * scale > size.rect.height + .5;
  }, []);

  const zoomTo = useCallback((next: number | null, point?: { x: number; y: number }, animated = true) => {
    const size = measure();
    if (!size) return;
    const state = view.current;
    const scale = next === null ? null : clamp(next, .25, 4);
    setPreset(scale === null || scale === 1 || scale === 2 ? scale : 'custom');
    const factor = (scale ?? size.fit) / (state.scale ?? size.fit);
    const x = point ? point.x - size.rect.left - size.rect.width / 2 : 0;
    const y = point ? point.y - size.rect.top - size.rect.height / 2 : 0;
    view.current = { scale, x: scale === null ? 0 : x - factor * (x - state.x),
      y: scale === null ? 0 : y - factor * (y - state.y) };
    paint(size, animated);
  }, [measure, paint]);
  const zoomBy = useCallback((factor: number, point?: { x: number; y: number }, animated = true) => {
    const scale = view.current.scale ?? measure()?.fit;
    if (scale) zoomTo(scale * factor, point, animated);
  }, [measure, zoomTo]);

  const zoomStep = useCallback((direction: 1 | -1) => {
    const current = view.current.scale ?? measure()?.fit;
    if (!current) return;
    const next = direction > 0
      ? LIGHTBOX_ZOOM_LEVELS.find(level => level > current + 1e-3)
      : [...LIGHTBOX_ZOOM_LEVELS].reverse().find(level => level < current - 1e-3);
    if (next) zoomTo(next);
  }, [measure, zoomTo]);

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    view.current = { scale: null, x: 0, y: 0 };
    drag.current = null;
    animating.current = false;
    delete el.dataset.dragging;
    if (plane.current) {
      plane.current.style.removeProperty('transform');
      plane.current.style.removeProperty('transition');
    }
    setPreset(null);
    reported.current = 100;
    setPercent(100);
    paint();
    const observer = new ResizeObserver(() => paint());
    observer.observe(el);
    // 鼠标、触控板与画布同一套判别（lib/canvasTrackpad）：捏合缩放；触控板双指滑动平移。
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      settle();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1;
      if (!wheelGestureZooms(event)) {
        view.current.x -= event.deltaX * unit;
        view.current.y -= event.deltaY * unit;
        paint(geometry.current);
        return;
      }
      if (!event.deltaY) return;
      const delta = event.deltaY * unit;
      zoomBy(event.ctrlKey ? Math.exp(-delta / 100) : LIGHTBOX_ZOOM_STEP ** (-delta / 100),
        { x: event.clientX, y: event.clientY }, false);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => { el.removeEventListener('wheel', wheel); observer.disconnect(); };
  }, [src, paint, zoomBy, settle]);

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    delete event.currentTarget.dataset.dragging;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return { viewport, plane, image, percent, preset, fitsWhole, paint, zoomTo, zoomBy, zoomStep, handlers: {
    onClick: (event: React.MouseEvent<HTMLDivElement>) => { if (canPan(event.currentTarget)) event.stopPropagation(); },
    // 朝双击处放大：想看的那块细节留在指针下。
    onDoubleClick: (event: React.MouseEvent<HTMLDivElement>) =>
      zoomTo(view.current.scale === 1 ? null : 1, { x: event.clientX, y: event.clientY }),
    onTransitionEnd: (event: TransitionEvent<HTMLDivElement>) => {
      if (event.target !== plane.current || event.propertyName !== 'transform') return;
      animating.current = false;
      plane.current.style.removeProperty('transition');
    },
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !canPan(event.currentTarget) || drag.current) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset.dragging = 'true';
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const previous = drag.current;
      if (previous?.id !== event.pointerId) return;
      // 真动起来才打断过渡：双击的两次按下不算拖动。
      settle();
      view.current.x += event.clientX - previous.x;
      view.current.y += event.clientY - previous.y;
      previous.x = event.clientX;
      previous.y = event.clientY;
      paint(geometry.current);
    },
    onPointerUp: endDrag, onPointerCancel: endDrag, onLostPointerCapture: endDrag,
  } };
}
