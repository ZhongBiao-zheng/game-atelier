import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ANNOTATION_COLORS, annotationUnitScale, distance, elementBounds, hitElement, serializeElements, simplifyPoints,
  translateElement, validElement, type AnnotationColor, type AnnotationElement, type AnnotationPoint,
  type AnnotationText, type AnnotationTool } from './annotationModel';
interface Preferences { tool: AnnotationTool; color: AnnotationColor; stroke_width: number; font_size: number; background: boolean }
const DEFAULTS: Preferences = { tool: 'rect', color: ANNOTATION_COLORS[0], stroke_width: 4, font_size: 18, background: false };
const KEY = 'atelier:annotation-tools';
function preferences(): Preferences {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { tool: ['select', 'rect', 'arrow', 'freedraw', 'text'].includes(p.tool) ? p.tool : DEFAULTS.tool,
      color: ANNOTATION_COLORS.includes(p.color) ? p.color : DEFAULTS.color,
      stroke_width: Math.min(24, Math.max(1, Number(p.stroke_width) || 4)),
      font_size: Math.min(72, Math.max(12, Number(p.font_size) || 18)), background: p.background === true };
  } catch { return DEFAULTS; }
}
interface Options {
  enabled: boolean; elements: AnnotationElement[]; width: number; height: number;
  onCommit: (elements: AnnotationElement[]) => void; onExit: () => void;
  undo: () => void; redo: () => void; onError: (message: string) => void;
}
export function useAnnotationEditor(options: Options) {
  const [prefs, setPrefs] = useState(preferences);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<AnnotationElement[] | null>(null);
  const [text, setText] = useState<AnnotationText | null>(null);
  const [panning, setPanning] = useState(false);
  const [screenPixel, setScreenPixel] = useState(1);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const gesture = useRef<{ start: AnnotationPoint; pixel: number; element: AnnotationElement; moving: boolean; changed: boolean; resize?: { corner: number[]; anchor: AnnotationPoint; vector: AnnotationPoint } } | null>(null);
  const latest = useRef({ options, prefs, selectedId, preview, text });
  latest.current = { options, prefs, selectedId, preview, text };
  const unit = annotationUnitScale(options.width, options.height);
  const elements = preview ?? options.elements;
  const selected = elements.find(element => element.id === selectedId);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* local preference only */ } }, [prefs]);
  useEffect(() => {
    if (!options.enabled) { setPreview(null); setText(null); setSelectedId(null); gesture.current = null; }
  }, [options.enabled]);
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
      setPrefs(p => ({ ...p, tool: 'select' }));
      setSelectedId(null);
    }
    setText(null);
    latest.current.text = null;
  }
  function removeSelected() {
    const current = latest.current;
    if (current.selectedId) commit(current.options.elements.filter(element => element.id !== current.selectedId));
    setSelectedId(null);
  }
  function chooseTool(tool: AnnotationTool) { finishText(); setPrefs(p => ({ ...p, tool })); setSelectedId(null); }
  function changeStyle(patch: Partial<Omit<Preferences, 'tool'>>, transient = false) {
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
    setScreenPixel(pixel);
    return { point: [point.x, point.y] as AnnotationPoint, pixel };
  }
  function pointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (panning || event.button !== 0 || event.ctrlKey) return;
    const at = position(event); if (!at) return;
    event.stopPropagation(); event.preventDefault();
    if (text) { finishText(); return; }
    const { point, pixel } = at;
    const handle = event.target instanceof Element ? event.target.closest('[data-annotation-resize]') : null;
    if (selected?.type === 'text' && handle) {
      const corner = handle.getAttribute('data-annotation-resize')!.split('-').map(Number);
      const box = elementBounds(selected, unit);
      const anchor: AnnotationPoint = [box.x + (1 - corner[0]) * box.width, box.y + (1 - corner[1]) * box.height];
      const vector: AnnotationPoint = [(corner[0] * 2 - 1) * box.width, (corner[1] * 2 - 1) * box.height];
      gesture.current = { start: point, pixel, element: selected, moving: true, changed: false, resize: { corner, anchor, vector } };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const id = crypto.randomUUID();
    if (prefs.tool === 'text') {
      setText({ id, type: 'text', color: prefs.color, x: point[0], y: point[1], text: '', font_size: prefs.font_size, background: prefs.background });
      return;
    }
    let element: AnnotationElement;
    if (prefs.tool === 'select') {
      const hit = hitElement(options.elements, point, unit, pixel);
      setSelectedId(hit?.id ?? null);
      if (!hit) return;
      element = hit;
      setPrefs(p => ({ ...p, color: hit.color, ...(hit.type === 'text' ? { font_size: hit.font_size, background: hit.background } : { stroke_width: hit.stroke_width }) }));
    } else {
      setSelectedId(null);
      const base = { id, color: prefs.color, stroke_width: prefs.stroke_width };
      element = prefs.tool === 'rect' ? { ...base, type: 'rect', x: point[0], y: point[1], width: 0, height: 0 }
        : prefs.tool === 'arrow' ? { ...base, type: 'arrow', start: point, end: point }
        : { ...base, type: 'freedraw', points: [point] };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { start: point, pixel, element, moving: prefs.tool === 'select', changed: false };
  }
  function pointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const g = gesture.current, at = position(event);
    if (!g || !at) return;
    event.stopPropagation();
    const p = at.point;
    let element = g.element;
    if (g.resize && element.type === 'text') {
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
      if (distance(p, element.points[element.points.length - 1]) < 1.5 * g.pixel || element.points.length >= 10000) return;
      element = { ...element, points: [...element.points, p] }; g.element = element;
    }
    g.changed = distance(p, g.start) > 0;
    const next = g.moving ? options.elements.map(item => item.id === element.id ? element : item) : [...options.elements, element];
    latest.current.preview = next; setPreview(next);
  }
  function pointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const g = gesture.current; if (!g) return;
    pointerMove(event);
    const next = latest.current.preview;
    gesture.current = null;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const drawn = next?.find(element => element.id === g.element.id);
    if (next && g.changed && drawn && (g.moving || validElement(drawn, g.pixel))) {
      commit(next.map(element => element.id === g.element.id && element.type === 'freedraw'
        ? { ...element, points: simplifyPoints(element.points, .75 * g.pixel) } : element));
      setSelectedId(drawn.id);
      setPrefs(p => ({ ...p, tool: 'select', ...(drawn.type === 'text' ? { font_size: drawn.font_size } : { stroke_width: drawn.stroke_width }) }));
    } else setPreview(null);
  }
  function doubleClick(event: React.MouseEvent<SVGSVGElement>) {
    event.stopPropagation();
    if (prefs.tool !== 'select') return;
    const matrix = event.currentTarget.getScreenCTM(); if (!matrix) return;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const hit = hitElement(options.elements, [p.x, p.y], unit, screenPixel);
    if (hit?.type === 'text') { setText(hit); setSelectedId(hit.id); }
  }
  const actions = useRef({ chooseTool, finishText, removeSelected });
  actions.current = { chooseTool, finishText, removeSelected };
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
  return { prefs, elements, selected, selectedId, text, setText, composing, finishText, panning, screenPixel,
    svgRef, textareaRef, chooseTool, changeStyle, removeSelected,
    pointerDown, pointerMove, pointerUp, doubleClick,
    cancelGesture: () => { gesture.current = null; setPreview(null); } };
}
export type AnnotationEditor = ReturnType<typeof useAnnotationEditor>;
