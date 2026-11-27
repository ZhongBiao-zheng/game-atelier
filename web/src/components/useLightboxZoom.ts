import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';

export const LIGHTBOX_ZOOM_STEP = 1.12;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function useLightboxZoom(src: string) {
  const viewport = useRef<HTMLDivElement>(null);
  const plane = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const view = useRef({ scale: null as number | null, x: 0, y: 0 });
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [percent, setPercent] = useState(100);
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
  const paint = useCallback((size = measure()) => {
    geometry.current = size;
    const state = view.current;
    if (!size || !plane.current || !viewport.current) return;
    const scale = state.scale ?? size.fit;
    const mx = Math.max(0, (size.width * scale - size.rect.width) / 2);
    const my = Math.max(0, (size.height * scale - size.rect.height) / 2);
    state.x = clamp(state.x, -mx, mx);
    state.y = clamp(state.y, -my, my);
    plane.current.style.transform = `translate3d(${state.x}px,${state.y}px,0) scale(${scale / size.fit})`;
    viewport.current.dataset.pannable = String(Boolean(mx || my));
    const rounded = Math.round(scale * 100);
    if (reported.current !== rounded) {
      reported.current = rounded;
      setPercent(rounded);
    }
  }, [measure]);

  const zoomTo = useCallback((next: number | null, point?: { x: number; y: number }) => {
    const size = measure();
    if (!size) return;
    const state = view.current;
    const scale = next === null ? null : clamp(next, .25, 4);
    const factor = (scale ?? size.fit) / (state.scale ?? size.fit);
    const x = point ? point.x - size.rect.left - size.rect.width / 2 : 0;
    const y = point ? point.y - size.rect.top - size.rect.height / 2 : 0;
    view.current = { scale, x: scale === null ? 0 : x - factor * (x - state.x),
      y: scale === null ? 0 : y - factor * (y - state.y) };
    paint(size);
  }, [measure, paint]);
  const zoomBy = useCallback((factor: number, point?: { x: number; y: number }) => {
    const scale = view.current.scale ?? measure()?.fit;
    if (scale) zoomTo(scale * factor, point);
  }, [measure, zoomTo]);

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    view.current = { scale: null, x: 0, y: 0 };
    drag.current = null;
    delete el.dataset.dragging;
    if (plane.current) plane.current.style.removeProperty('transform');
    reported.current = 100;
    setPercent(100);
    paint();
    const observer = new ResizeObserver(() => paint());
    observer.observe(el);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!event.deltaY) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1;
      const delta = event.deltaY * unit;
      zoomBy(event.ctrlKey ? Math.exp(-delta / 100) : LIGHTBOX_ZOOM_STEP ** (-delta / 100),
        { x: event.clientX, y: event.clientY });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => { el.removeEventListener('wheel', wheel); observer.disconnect(); };
  }, [src, paint, zoomBy]);

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    delete event.currentTarget.dataset.dragging;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return { viewport, plane, image, percent, paint, zoomTo, zoomBy, handlers: {
    onClick: (event: React.MouseEvent<HTMLDivElement>) => { if (event.currentTarget.dataset.pannable === 'true') event.stopPropagation(); },
    onDoubleClick: () => zoomTo(view.current.scale === 1 ? null : 1),
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || event.currentTarget.dataset.pannable !== 'true' || drag.current) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset.dragging = 'true';
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const previous = drag.current;
      if (previous?.id !== event.pointerId) return;
      view.current.x += event.clientX - previous.x;
      view.current.y += event.clientY - previous.y;
      previous.x = event.clientX;
      previous.y = event.clientY;
      paint(geometry.current);
    },
    onPointerUp: endDrag, onPointerCancel: endDrag, onLostPointerCapture: endDrag,
  } };
}
