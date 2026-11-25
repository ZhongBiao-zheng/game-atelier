import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { ANNOTATION_COLORS, annotationUnitScale, distance, elementBounds, hitElement, serializeElements, simplifyPoints,
  translateElement, validElement, type AnnotationColor, type AnnotationElement, type AnnotationPoint,
  type AnnotationText, type AnnotationTool } from './annotationModel';
interface Preferences { tool: AnnotationTool; color: AnnotationColor; stroke_width: number; font_size: number; background: boolean }
const DEFAULTS: Preferences = { tool: 'rect', color: ANNOTATION_COLORS[0], stroke_width: 4, font_size: 18, background: false };
const KEY = 'atelier:annotation-tools';
function parsePreferences(raw: string | null): Preferences {
  try {
    const p = JSON.parse(raw ?? '{}');
    return { tool: ['select', 'rect', 'arrow', 'freedraw', 'text'].includes(p.tool) ? p.tool : DEFAULTS.tool,
      color: ANNOTATION_COLORS.includes(p.color) ? p.color : DEFAULTS.color,
      stroke_width: Math.min(24, Math.max(1, Number(p.stroke_width) || 4)),
      font_size: Math.min(72, Math.max(12, Number(p.font_size) || 18)), background: p.background === true };
  } catch { return DEFAULTS; }
}
function storedPreferences() { try { return localStorage.getItem(KEY); } catch { return null; } }
// Every node mounts its own editor; one shared store keeps tool and style in step across nodes.
let preferenceCache: { raw: string | null; value: Preferences } | null = null;
const preferenceListeners = new Set<() => void>();
function readPreferences() {
  const raw = storedPreferences();
  if (!preferenceCache || preferenceCache.raw !== raw) preferenceCache = { raw, value: parsePreferences(raw) };
  return preferenceCache.value;
}
function writePreferences(update: Preferences | ((current: Preferences) => Preferences)) {
  const value = typeof update === 'function' ? update(readPreferences()) : update;
  try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* local preference only */ }
  preferenceCache = { raw: storedPreferences(), value };
  preferenceListeners.forEach(listener => listener());
}
function subscribePreferences(listener: () => void) {
  preferenceListeners.add(listener);
  return () => { preferenceListeners.delete(listener); };
}
/** 跟着指针每帧变化的状态（拖动中的预览、悬停的标注、屏幕像素换算）放在节点外的小仓库里：
 *  只有标注层与工具条订阅，拖一笔不再让整张节点卡片（媒体、工具条、生成面板）跟着每帧重渲。 */
interface LiveState { preview: AnnotationElement[] | null; hoveredId: string | null; screenPixel: number }
function createLiveStore() {
  let value: LiveState = { preview: null, hoveredId: null, screenPixel: 1 };
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(patch: Partial<LiveState>) {
      const next = { ...value, ...patch };
      if (next.preview === value.preview && next.hoveredId === value.hoveredId && next.screenPixel === value.screenPixel) return;
      value = next;
      listeners.forEach(listener => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
/** 浏览器把一帧内的多次移动合并成一个事件；取回被合并掉的采样点（不支持时返回 null）。 */
function coalescedPoints(event: ReactPointerEvent<SVGSVGElement>): AnnotationPoint[] | null {
  const samples = typeof event.nativeEvent.getCoalescedEvents === 'function' ? event.nativeEvent.getCoalescedEvents() : [];
  const matrix = samples.length > 1 ? event.currentTarget.getScreenCTM() : null;
  if (!matrix) return null;
  const inverse = matrix.inverse();
  return samples.map(sample => {
    const point = new DOMPoint(sample.clientX, sample.clientY).matrixTransform(inverse);
    return [point.x, point.y] as AnnotationPoint;
  });
}
const WHEEL_STEP = 40;
const WHEEL_COMMIT_DELAY = 350;
interface Options {
  enabled: boolean; elements: AnnotationElement[]; width: number; height: number;
  onCommit: (elements: AnnotationElement[]) => void; onExit: () => void;
  undo: () => void; redo: () => void; onError: (message: string) => void;
}
export function useAnnotationEditor(options: Options) {
  const prefs = useSyncExternalStore(subscribePreferences, readPreferences);
  const setPrefs = writePreferences;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [live] = useState(createLiveStore);
  const wheelState = useRef<{ id: string; remainder: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [text, setText] = useState<AnnotationText | null>(null);
  const [panning, setPanning] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const gesture = useRef<{ start: AnnotationPoint; pixel: number; element: AnnotationElement; moving: boolean; changed: boolean; endpoint?: 'start' | 'end'; resize?: { corner: number[]; anchor: AnnotationPoint; vector: AnnotationPoint } } | null>(null);
  const latest = useRef({ options, prefs, selectedId, text });
  latest.current = { options, prefs, selectedId, text };
  const unit = annotationUnitScale(options.width, options.height);
  const setPreview = (preview: AnnotationElement[] | null) => live.set({ preview });
  const setHoveredId = (hoveredId: string | null) => live.set({ hoveredId });
  useEffect(() => {
    if (!options.enabled) {
      actions.current.flushWheel();
      live.set({ preview: null, hoveredId: null }); setText(null); setSelectedId(null); gesture.current = null;
    }
  }, [options.enabled, live]);
  function commit(next: AnnotationElement[]) {
    try { serializeElements(next); latest.current.options.onCommit(next); }
    catch (error) { latest.current.options.onError((error as Error).message); }
    setPreview(null);
  }
  function finishText(cancel = false) {
    const current = latest.current;
    if (!current.text) return;
    if (!cancel && current.text.text.trim()) {
      const others = current.options.elements.filter(element => element.id !== current.text!.id);
      commit([...others, { ...current.text, text: current.text.text.slice(0, 500) }]);
      setSelectedId(null);
    }
    setText(null);
    latest.current.text = null;
  }
  /** Commits a pending wheel adjustment so the next edit builds on it. */
  function flushWheel() {
    const pending = wheelState.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    wheelState.current = null;
    const preview = live.get().preview;
    if (preview) commit(preview);
  }
  function removeSelected() {
    flushWheel();
    const current = latest.current;
    if (current.selectedId) commit(current.options.elements.filter(element => element.id !== current.selectedId));
    setSelectedId(null);
  }
  function chooseTool(tool: AnnotationTool) { flushWheel(); finishText(); setPrefs(p => ({ ...p, tool })); setSelectedId(null); }
  function pickUp(element: AnnotationElement) {
    setSelectedId(element.id);
    setPrefs(p => ({ ...p, color: element.color, ...(element.type === 'text'
      ? { font_size: element.font_size, background: element.background } : { stroke_width: element.stroke_width }) }));
  }
  function changeStyle(patch: Partial<Omit<Preferences, 'tool'>>, transient = false) {
    flushWheel();
    setPrefs(p => ({ ...p, ...patch }));
    const current = latest.current;
    if (current.text) setText({ ...current.text, ...patch });
    if (!current.selectedId) return;
    const next = current.options.elements.map(element => {
      if (element.id !== current.selectedId) return element;
      return { ...element, color: patch.color ?? element.color,
        ...(element.type === 'text' ? { font_size: patch.font_size ?? element.font_size, background: patch.background ?? element.background }
          : { stroke_width: patch.stroke_width ?? element.stroke_width }) };
    });
    if (transient) setPreview(next); else commit(next);
  }
  function position(event: ReactPointerEvent<SVGSVGElement>) {
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const pixel = 1 / Math.max(.0001, Math.hypot(matrix.a, matrix.b));
    live.set({ screenPixel: pixel });
    return { point: [point.x, point.y] as AnnotationPoint, pixel };
  }
  function pointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (panning || event.button !== 0 || event.ctrlKey) return;
    const at = position(event); if (!at) return;
    event.stopPropagation(); event.preventDefault();
    if (text) { finishText(); return; }
    flushWheel();
    const { point, pixel } = at;
    const selected = (live.get().preview ?? options.elements).find(element => element.id === selectedId);
    const endpointHandle = event.target instanceof Element ? event.target.closest('[data-annotation-endpoint]') : null;
    const endpoint = endpointHandle?.getAttribute('data-annotation-endpoint');
    if (selected?.type === 'arrow' && (endpoint === 'start' || endpoint === 'end')) {
      gesture.current = { start: point, pixel, element: selected, moving: true, changed: false, endpoint };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const handle = event.target instanceof Element ? event.target.closest('[data-annotation-resize]') : null;
    if ((selected?.type === 'text' || selected?.type === 'rect') && handle) {
      const corner = handle.getAttribute('data-annotation-resize')!.split('-').map(Number);
      const box = elementBounds(selected, unit);
      const anchor: AnnotationPoint = [box.x + (1 - corner[0]) * box.width, box.y + (1 - corner[1]) * box.height];
      const vector: AnnotationPoint = [(corner[0] * 2 - 1) * box.width, (corner[1] * 2 - 1) * box.height];
      gesture.current = { start: point, pixel, element: selected, moving: true, changed: false, resize: { corner, anchor, vector } };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    // Like screenshot markup tools: pressing on an existing mark moves it whatever the tool; empty space draws.
    const hit = hitElement(options.elements, point, unit, pixel);
    if (hit) {
      pickUp(hit);
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { start: point, pixel, element: hit, moving: true, changed: false };
      return;
    }
    setSelectedId(null);
    if (prefs.tool === 'select') return;
    const id = crypto.randomUUID();
    if (prefs.tool === 'text') {
      setText({ id, type: 'text', color: prefs.color, x: point[0], y: point[1], text: '', font_size: prefs.font_size, background: prefs.background });
      return;
    }
    const base = { id, color: prefs.color, stroke_width: prefs.stroke_width };
    const element: AnnotationElement = prefs.tool === 'rect' ? { ...base, type: 'rect', x: point[0], y: point[1], width: 0, height: 0 }
      : prefs.tool === 'arrow' ? { ...base, type: 'arrow', start: point, end: point }
      : { ...base, type: 'freedraw', points: [point] };
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { start: point, pixel, element, moving: false, changed: false };
  }
  function hover(event: ReactPointerEvent<SVGSVGElement>) {
    const at = position(event); if (!at) return;
    const hit = hitElement(latest.current.options.elements, at.point, unit, at.pixel);
    setHoveredId(hit?.id ?? null);
  }
  /** Wheel or two-finger scroll over a mark changes its line width (or text size); pinch still zooms. */
  function wheel(event: WheelEvent, svg: SVGSVGElement) {
    if (event.ctrlKey || event.metaKey || latest.current.text || gesture.current) return;
    const matrix = svg.getScreenCTM(); if (!matrix) return;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const pixel = 1 / Math.max(.0001, Math.hypot(matrix.a, matrix.b));
    const current = live.get().preview ?? latest.current.options.elements;
    const target = hitElement(current, [p.x, p.y], unit, pixel);
    if (!target) return;
    event.preventDefault(); event.stopPropagation();
    const pending = wheelState.current;
    if (pending && pending.id !== target.id) flushWheel();
    const delta = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
    const remainder = (wheelState.current?.remainder ?? 0) - delta;
    const steps = Math.trunc(remainder / WHEEL_STEP);
    if (wheelState.current) clearTimeout(wheelState.current.timer);
    wheelState.current = { id: target.id, remainder: remainder - steps * WHEEL_STEP,
      timer: setTimeout(flushWheel, WHEEL_COMMIT_DELAY) };
    setSelectedId(target.id);
    if (!steps) return;
    const base = live.get().preview ?? latest.current.options.elements;
    const next = base.map(element => {
      if (element.id !== target.id) return element;
      if (element.type === 'text') return { ...element, font_size: Math.min(72, Math.max(12, element.font_size + steps * 2)) };
      return { ...element, stroke_width: Math.min(24, Math.max(1, element.stroke_width + steps)) };
    });
    const changed = next.find(element => element.id === target.id)!;
    setPrefs(prefs => ({ ...prefs, ...(changed.type === 'text' ? { font_size: changed.font_size } : { stroke_width: changed.stroke_width }) }));
    setPreview(next);
  }
  function pointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const g = gesture.current;
    if (!g) { if (!panning) hover(event); return; }
    const at = position(event);
    if (!at) return;
    event.stopPropagation();
    const p = at.point;
    let element = g.element;
    if (g.endpoint && element.type === 'arrow') {
      const original = element[g.endpoint];
      element = { ...element, [g.endpoint]: [original[0] + p[0] - g.start[0], original[1] + p[1] - g.start[1]] };
    } else if (g.resize && element.type === 'rect') {
      const { anchor, corner } = g.resize;
      const width = Math.max(4 * g.pixel, element.width + (corner[0] ? 1 : -1) * (p[0] - g.start[0]));
      const height = Math.max(4 * g.pixel, element.height + (corner[1] ? 1 : -1) * (p[1] - g.start[1]));
      element = { ...element, x: anchor[0] - (corner[0] ? 0 : width), y: anchor[1] - (corner[1] ? 0 : height), width, height };
    } else if (g.resize && element.type === 'text') {
      const { anchor, vector, corner } = g.resize;
      const factor = 1 + ((p[0] - g.start[0]) * vector[0] + (p[1] - g.start[1]) * vector[1]) / (vector[0] ** 2 + vector[1] ** 2 || 1);
      const font_size = Math.min(72, Math.max(12, Math.round(g.element.type === 'text' ? g.element.font_size * factor : 18)));
      const resized = { ...element, font_size };
      const bounds = elementBounds(resized, unit);
      element = { ...resized, x: anchor[0] - (1 - corner[0]) * bounds.width, y: anchor[1] - (1 - corner[1]) * bounds.height };
    } else if (g.moving) element = translateElement(g.element, p[0] - g.start[0], p[1] - g.start[1]);
    else if (element.type === 'rect') element = { ...element, x: Math.min(p[0], g.start[0]), y: Math.min(p[1], g.start[1]), width: Math.abs(p[0] - g.start[0]), height: Math.abs(p[1] - g.start[1]) };
    else if (element.type === 'arrow') element = { ...element, end: p };
    else if (element.type === 'freedraw') {
      // 快速划线时一帧只来一个事件，只取它会把曲线画成折线；把合并掉的采样点一起补进来。
      const samples = coalescedPoints(event) ?? [p];
      const points = [...element.points];
      for (const sample of samples) {
        if (points.length >= 10000) break;
        if (distance(sample, points[points.length - 1]) >= 1.5 * g.pixel) points.push(sample);
      }
      if (points.length === element.points.length) return;
      element = { ...element, points }; g.element = element;
    }
    g.changed = distance(p, g.start) > 0;
    const next = g.moving ? options.elements.map(item => item.id === element.id ? element : item) : [...options.elements, element];
    setPreview(next);
  }
  function pointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const g = gesture.current; if (!g) return;
    pointerMove(event);
    const next = live.get().preview;
    gesture.current = null;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const drawn = next?.find(element => element.id === g.element.id);
    if (next && g.changed && drawn && ((g.moving && !g.endpoint) || validElement(drawn, g.pixel))) {
      commit(next.map(element => element.id === g.element.id && element.type === 'freedraw'
        ? { ...element, points: simplifyPoints(element.points, .75 * g.pixel) } : element));
      setSelectedId(drawn.id);
    } else setPreview(null);
  }
  function doubleClick(event: React.MouseEvent<SVGSVGElement>) {
    event.stopPropagation();
    const matrix = event.currentTarget.getScreenCTM(); if (!matrix) return;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const hit = hitElement(options.elements, [p.x, p.y], unit, live.get().screenPixel);
    if (hit?.type === 'text') { setText(hit); setSelectedId(hit.id); }
  }
  const actions = useRef({ chooseTool, finishText, removeSelected, flushWheel });
  actions.current = { chooseTool, finishText, removeSelected, flushWheel };
  useEffect(() => {
    if (!options.enabled) return;
    function keyDown(event: KeyboardEvent) {
      const current = latest.current;
      const input = event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]');
      if (input || (event.key === 'Escape' && event.target instanceof Element && event.target.closest('[data-radix-popper-content-wrapper]'))) return;
      if (event.code === 'Space' || event.key === 'Control') { setPanning(true); return; }
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === 'z') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.shiftKey) current.options.redo(); else current.options.undo(); return;
      }
      const tool = ({ v: 'select', r: 'rect', a: 'arrow', p: 'freedraw', t: 'text' } as const)[key as 'v'];
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (tool || event.key === 'Escape' || event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (tool) actions.current.chooseTool(tool);
        else if (event.key === 'Escape') { if (current.text) actions.current.finishText(true); else current.options.onExit(); }
        else actions.current.removeSelected();
      }
    }
    const keyUp = (event: KeyboardEvent) => { if (event.code === 'Space' || event.key === 'Control') setPanning(false); };
    const blur = () => setPanning(false);
    function outside(event: PointerEvent) {
      if (!document.hasFocus() || composing.current || !latest.current.text || !(event.target instanceof Element)) return;
      if (event.target.closest('[data-annotation-controls],textarea[data-annotation-text]')) return;
      actions.current.finishText();
    }
    window.addEventListener('keydown', keyDown, true); window.addEventListener('keyup', keyUp, true);
    window.addEventListener('blur', blur); document.addEventListener('pointerdown', outside, true);
    return () => {
      window.removeEventListener('keydown', keyDown, true); window.removeEventListener('keyup', keyUp, true);
      window.removeEventListener('blur', blur); document.removeEventListener('pointerdown', outside, true);
    };
  }, [options.enabled]);
  return { enabled: options.enabled, committedElements: options.elements, live, prefs, selectedId, text, setText, composing,
    finishText, panning, svgRef, textareaRef, chooseTool, changeStyle, removeSelected,
    pointerDown, pointerMove, pointerUp, doubleClick, wheel,
    pointerLeave: () => setHoveredId(null),
    cancelGesture: () => { gesture.current = null; setPreview(null); } };
}
export type AnnotationEditor = ReturnType<typeof useAnnotationEditor>;
/** 标注层与工具条读当前要画的标注（拖动中是预览）、选中项与悬停项；只有调用它的组件随指针移动重渲。 */
export function useAnnotationView(editor: AnnotationEditor) {
  const live = useSyncExternalStore(editor.live.subscribe, editor.live.get);
  const elements = live.preview ?? editor.committedElements;
  return { elements, selected: elements.find(element => element.id === editor.selectedId),
    hoveredId: live.hoveredId, screenPixel: live.screenPixel };
}
