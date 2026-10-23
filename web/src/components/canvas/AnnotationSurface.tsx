import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { bounds, clamp, elementFont, hitElement, localPoints, renderAnnotation, textBounds, type AnnotationElement, type AnnotationTool, type LineStyle, type Point } from './imageAnnotation';

export interface AnnotationSettings {
  strokeWidth: number; color: string; fill: boolean; shape: 'rectangle' | 'ellipse';
  lineStyle: LineStyle; curved: boolean; region: boolean; effect: 'pixelate' | 'blur'; blockSize: number;
  fontFamily: string; fontSize: number; bold: boolean; italic: boolean; outline: boolean;
}
export interface AnnotationSurfaceHandle { finish(): void; fit(): void }

export function applySettings(e: AnnotationElement, settings: AnnotationSettings): AnnotationElement {
  return { ...e, strokeColor: settings.color, strokeWidth: settings.strokeWidth,
    backgroundColor: settings.fill ? settings.color : 'transparent',
    ...(e.type === 'rectangle' || e.type === 'ellipse' ? { type: settings.shape } : {}),
    ...(e.type === 'line' || e.type === 'arrow' ? { lineStyle: settings.lineStyle, controls: settings.curved ? localPoints(e).slice(1).map((p, i) => e.controls?.[i] ?? [(p[0] + localPoints(e)[i][0]) / 2, (p[1] + localPoints(e)[i][1]) / 2 - 40] as Point) : [] } : {}),
    ...(e.type === 'text' ? { fontFamily: settings.fontFamily, fontSize: settings.fontSize, bold: settings.bold, italic: settings.italic, outline: settings.outline } : {}),
  };
}

interface Props {
  image: HTMLImageElement; elements: AnnotationElement[]; tool: AnnotationTool; settings: AnnotationSettings;
  selected: string | null; onSelect: (id: string | null) => void;
  onCommit: (elements: AnnotationElement[]) => void; onSize: (delta: number) => void;
  disabled: boolean;
}
type Gesture = { mode: 'draw' | 'move' | 'point' | 'control' | 'resize' | 'pan'; start: Point; element: AnnotationElement; index: number; moved: boolean; offset: Point };

export const AnnotationSurface = forwardRef<AnnotationSurfaceHandle, Props>(function AnnotationSurface({ image, elements, tool, settings, selected, onSelect, onCommit, onSize, disabled }, ref) {
  const stage = useRef<HTMLDivElement>(null), output = useRef<HTMLCanvasElement>(null), textInput = useRef<HTMLTextAreaElement>(null);
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const [zoom, setZoom] = useState(1), [offset, setOffset] = useState<Point>([0, 0]);
  const [draft, setDraftState] = useState<AnnotationElement | null>(null), draftRef = useRef<AnnotationElement | null>(null);
  const [editingText, setEditingText] = useState(false), editingRef = useRef(false);
  const [polyline, setPolyline] = useState(false), polyRef = useRef(false);
  const [cursor, setCursor] = useState<Point | null>(null);
  const gesture = useRef<Gesture | null>(null), space = useRef(false), sizeCallback = useRef(onSize);
  sizeCallback.current = onSize;
  const elementRef = useRef(elements); elementRef.current = elements;
  const fitScale = Math.min((viewport.width - 48) / image.naturalWidth, (viewport.height - 48) / image.naturalHeight, 1);
  const scale = Math.max(0.01, fitScale) * zoom;
  const left = (viewport.width - image.naturalWidth * scale) / 2 + offset[0], top = (viewport.height - image.naturalHeight * scale) / 2 + offset[1];
  const active = draft ?? elements.find(e => e.id === selected);
  const box = active ? bounds(active) : null;
  const isLine = active?.type === 'line' || active?.type === 'arrow';
  const canResize = active && ['rectangle', 'ellipse', 'diamond'].includes(active.type);

  function setDraft(value: AnnotationElement | null) { draftRef.current = value; setDraftState(value); }
  function finish() {
    let e = draftRef.current;
    if (e && editingRef.current && !e.text?.trim()) {
      onCommit(elementRef.current.filter(item => item.id !== e!.id)); onSelect(null); e = null;
    }
    if (e && polyRef.current && e.points.length > 2) e = { ...e, points: e.points.slice(0, -1), controls: e.controls?.slice(0, -1) };
    if (e && (e.type === 'line' || e.type === 'arrow')) {
      const points: Point[] = [], controls: Point[] = [];
      e.points.forEach((p, i) => {
        if (!points.length || Math.hypot(p[0] - points.at(-1)![0], p[1] - points.at(-1)![1]) > 0.1) {
          points.push(p); if (i && e?.controls?.[i - 1]) controls.push(e.controls[i - 1]);
        }
      });
      e = points.length > 1 ? { ...e, points, controls } : null;
    }
    if (e) {
      if (e.type === 'text') e = { ...e, ...textBounds(e) };
      const next = elementRef.current.some(item => item.id === e!.id) ? elementRef.current.map(item => item.id === e!.id ? e! : item) : [...elementRef.current, e];
      onCommit(next); onSelect(['freedraw', 'marker', 'erase', 'mosaic'].includes(e.type) ? null : e.id);
    }
    setDraft(null); editingRef.current = false; setEditingText(false); polyRef.current = false; setPolyline(false); gesture.current = null;
  }
  useImperativeHandle(ref, () => ({ finish, fit: () => { setZoom(1); setOffset([0, 0]); } }));
  useLayoutEffect(() => {
    const host = stage.current!;
    const observer = new ResizeObserver(([entry]) => setViewport({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(host); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const host = stage.current!;
    const wheel = (event: WheelEvent) => {
      if (disabled || editingRef.current) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) setZoom(value => clamp(value * (event.deltaY < 0 ? 1.1 : 1 / 1.1), 0.25, 8));
      else sizeCallback.current(event.deltaY < 0 ? 1 : -1);
    };
    const release = () => { space.current = false; };
    host.addEventListener('wheel', wheel, { passive: false }); window.addEventListener('blur', release);
    return () => { host.removeEventListener('wheel', wheel); window.removeEventListener('blur', release); };
  }, [disabled]);
  useEffect(() => {
    const canvas = output.current;
    if (!canvas) return;
    const frame = requestAnimationFrame(() => {
      const scene = draft ? elements.some(e => e.id === draft.id)
        ? elements.flatMap(e => e.id === draft.id ? editingText ? [] : [draft] : [e])
        : [...elements, ...(editingText ? [] : [draft])] : elements;
      renderAnnotation(image, scene, canvas, 2400);
    });
    return () => cancelAnimationFrame(frame);
  }, [image, elements, draft, editingText]);
  useEffect(() => { if (editingText) textInput.current?.focus(); }, [editingText]);

  function point(event: ReactPointerEvent): Point {
    const rect = stage.current!.getBoundingClientRect();
    return [(event.clientX - rect.left - left) / scale, (event.clientY - rect.top - top) / scale];
  }
  function startText(e: AnnotationElement) { setDraft(e); editingRef.current = true; setEditingText(true); onSelect(e.id); }
  function down(event: ReactPointerEvent<HTMLDivElement>) {
    if (disabled || event.button !== 0 && event.button !== 1 || (event.target as HTMLElement).closest('textarea,button')) return;
    event.preventDefault(); stage.current?.focus();
    if (editingRef.current) { finish(); return; }
    const p = point(event), dummy = { id: '', x: 0, y: 0 } as AnnotationElement;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (space.current || event.button === 1) { gesture.current = { mode: 'pan', start: [event.clientX, event.clientY], element: dummy, index: 0, moved: false, offset }; return; }
    if (polyRef.current && draftRef.current) {
      const e = draftRef.current, points = [...e.points]; points[points.length - 1] = [p[0] - e.x, p[1] - e.y]; points.push(points.at(-1)!);
      setDraft(applySettings({ ...e, points, controls: e.controls?.slice(0, -1) }, settings)); return;
    }
    if (active && !draft) {
      const handle = (points: Point[]) => points.findIndex(q => Math.hypot(p[0] - active.x - q[0], p[1] - active.y - q[1]) * scale < 10);
      const vertex = isLine ? handle(localPoints(active)) : -1, control = isLine ? handle(active.controls ?? []) : -1;
      const resize = canResize && box && Math.hypot(p[0] - box.x - box.width, p[1] - box.y - box.height) * scale < 10;
      if (vertex >= 0 || control >= 0 || resize) {
        gesture.current = { mode: resize ? 'resize' : vertex >= 0 ? 'point' : 'control', start: p, element: active, index: vertex >= 0 ? vertex : control, moved: false, offset };
        setDraft(active); return;
      }
    }
    const hit = [...elements].reverse().find(e => (event.altKey ||
      tool === 'text' && e.type === 'text' || tool === 'shape' && ['rectangle', 'ellipse', 'diamond'].includes(e.type) ||
      tool === 'line' && (e.type === 'line' || e.type === 'arrow')) && hitElement(e, p, 5 / scale));
    if (hit && (event.altKey || ['shape', 'line', 'text'].includes(tool))) {
      onSelect(hit.id); gesture.current = { mode: 'move', start: p, element: hit, index: 0, moved: false, offset }; setDraft(hit); return;
    }
    onSelect(null);
    if (p[0] < 0 || p[1] < 0 || p[0] > image.naturalWidth || p[1] > image.naturalHeight) return;
    const type = { shape: settings.shape, line: 'line', pen: 'freedraw', marker: 'marker', mosaic: 'mosaic', text: 'text', eraser: 'erase' }[tool] as AnnotationElement['type'];
    const e = applySettings({ id: crypto.randomUUID(), type, x: p[0], y: p[1], width: 0, height: 0, points: [[0, 0]], strokeColor: settings.color, strokeWidth: settings.strokeWidth, backgroundColor: 'transparent', angle: 0, opacity: tool === 'marker' ? 35 : 100,
      ...(tool === 'mosaic' || tool === 'eraser' ? { region: settings.region, effect: settings.effect, blockSize: settings.blockSize } : {}),
      ...(tool === 'text' ? { text: '' } : {}) }, settings);
    if (tool === 'text') { startText(e); return; }
    if (tool === 'line') e.points.push([0, 0]);
    setDraft(e); gesture.current = { mode: 'draw', start: p, element: e, index: 0, moved: false, offset };
  }
  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const p = point(event); setCursor(p);
    if (disabled) return;
    const g = gesture.current, current = draftRef.current;
    if (polyRef.current && current && !g) {
      const points = [...current.points]; points[points.length - 1] = [p[0] - current.x, p[1] - current.y];
      setDraft(applySettings({ ...current, points, controls: current.controls?.slice(0, -1) }, settings)); return;
    }
    if (!g) return;
    if (g.mode === 'pan') { setOffset([g.offset[0] + event.clientX - g.start[0], g.offset[1] + event.clientY - g.start[1]]); return; }
    const dx = p[0] - g.start[0], dy = p[1] - g.start[1];
    g.moved ||= Math.hypot(dx, dy) * scale > 3;
    const e = g.element;
    if (g.mode === 'move') { setDraft({ ...e, x: e.x + dx, y: e.y + dy }); return; }
    if (g.mode === 'point' || g.mode === 'control') {
      const key = g.mode === 'point' ? 'points' : 'controls', points = [...(e[key] ?? [])]; points[g.index] = [p[0] - e.x, p[1] - e.y]; setDraft({ ...e, [key]: points }); return;
    }
    if (g.mode === 'resize') { setDraft({ ...e, width: Math.max(1, e.width + dx), height: Math.max(1, e.height + dy) }); return; }
    if (tool === 'shape' || e.region) {
      const w = event.shiftKey ? Math.max(Math.abs(dx), Math.abs(dy)) * Math.sign(dx || 1) : dx, h = event.shiftKey ? Math.max(Math.abs(dx), Math.abs(dy)) * Math.sign(dy || 1) : dy;
      setDraft({ ...e, x: e.x + Math.min(0, w), y: e.y + Math.min(0, h), width: Math.abs(w), height: Math.abs(h), points: [] });
    } else if (tool === 'line') {
      let end: Point = [dx, dy];
      if (event.shiftKey) { const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, length = Math.hypot(dx, dy); end = [Math.cos(angle) * length, Math.sin(angle) * length]; }
      setDraft(applySettings({ ...e, points: [[0, 0], end] }, settings));
    } else if (current && Math.hypot(p[0] - e.x - current.points.at(-1)![0], p[1] - e.y - current.points.at(-1)![1]) * scale >= 1) {
      setDraft({ ...current, points: [...current.points, [p[0] - e.x, p[1] - e.y]] });
    }
  }
  function up(event: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current; if (!g) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (g.mode === 'pan') { gesture.current = null; return; }
    if (g.mode === 'draw' && tool === 'line' && !g.moved) { gesture.current = null; polyRef.current = true; setPolyline(true); return; }
    if (g.mode === 'draw' && (tool === 'shape' || g.element.region) && !g.moved) { gesture.current = null; setDraft(null); return; }
    if (g.mode !== 'draw' && !g.moved) { gesture.current = null; setDraft(null); return; }
    finish();
  }

  return <div ref={stage} tabIndex={0} aria-label="图片标注画布" className="annotation-stage relative min-h-0 flex-1 touch-none overflow-hidden outline-none" style={{ cursor: editingText ? 'text' : 'crosshair' }}
    onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { gesture.current = null; setDraft(null); polyRef.current = false; setPolyline(false); }} onPointerLeave={() => setCursor(null)}
    onDoubleClick={event => {
      if (polyRef.current) { finish(); return; }
      const p: Point = [(event.clientX - stage.current!.getBoundingClientRect().left - left) / scale, (event.clientY - stage.current!.getBoundingClientRect().top - top) / scale];
      const text = [...elements].reverse().find(e => e.type === 'text' && hitElement(e, p, 4 / scale)); if (text) startText(text);
    }}
    onKeyDown={event => {
      if ((event.target as HTMLElement).tagName === 'TEXTAREA') return;
      if (event.code === 'Space') { event.preventDefault(); space.current = true; }
      if (event.key === 'Enter') { event.preventDefault(); finish(); }
      if (event.key === 'Escape') { event.preventDefault(); setDraft(null); gesture.current = null; polyRef.current = false; setPolyline(false); onSelect(null); }
      if ((event.key === 'Backspace' || event.key === 'Delete') && selected) { event.preventDefault(); onCommit(elements.filter(e => e.id !== selected)); onSelect(null); }
    }} onKeyUp={event => { if (event.code === 'Space') space.current = false; }} onContextMenu={event => { event.preventDefault(); if (polyRef.current) finish(); }}>
    <div className="absolute origin-top-left" style={{ left, top, width: image.naturalWidth * scale, height: image.naturalHeight * scale }}>
      <canvas ref={output} className="pointer-events-none block h-full w-full" />
      {box && !editingText && active && <svg className="pointer-events-none absolute left-0 top-0 h-full w-full overflow-visible" viewBox={`0 0 ${image.naturalWidth} ${image.naturalHeight}`}>
        {isLine ? <>
          {active.controls?.map((p, i) => <g key={`c${i}`}><path d={`M${localPoints(active)[i][0] + active.x},${localPoints(active)[i][1] + active.y} L${p[0] + active.x},${p[1] + active.y} L${localPoints(active)[i + 1][0] + active.x},${localPoints(active)[i + 1][1] + active.y}`} className="annotation-control-line" strokeWidth={1 / scale} /><circle cx={p[0] + active.x} cy={p[1] + active.y} r={5 / scale} className="annotation-control" strokeWidth={1 / scale} /></g>)}
          {localPoints(active).map((p, i) => <rect key={i} x={p[0] + active.x - 4 / scale} y={p[1] + active.y - 4 / scale} width={8 / scale} height={8 / scale} className="annotation-handle" strokeWidth={1 / scale} />)}
        </> : <><rect x={box.x - 4 / scale} y={box.y - 4 / scale} width={box.width + 8 / scale} height={box.height + 8 / scale} className="annotation-selection" strokeWidth={1 / scale} />
          {canResize && <rect x={box.x + box.width - 4 / scale} y={box.y + box.height - 4 / scale} width={8 / scale} height={8 / scale} className="annotation-handle" strokeWidth={1 / scale} />}</>}
      </svg>}
      {editingText && draft && <textarea ref={textInput} aria-label="标注文字" value={draft.text ?? ''} maxLength={4000} onChange={event => setDraft({ ...draft, text: event.target.value })}
        onBlur={() => finish()} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' || event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); finish(); stage.current?.focus(); } }}
        className="absolute min-w-24 resize-none border border-primary bg-card/80 p-0 outline-none" style={{ left: draft.x * scale, top: draft.y * scale, width: Math.max(160, (textBounds(draft).width + 24) * scale), height: Math.max(48, (textBounds(draft).height + 16) * scale), font: elementFont({ ...draft, fontSize: (draft.fontSize ?? 28) * scale }), lineHeight: 1.3, color: draft.strokeColor }} />}
    </div>
    {cursor && !editingText && ['pen', 'marker', 'mosaic', 'eraser'].includes(tool) && !settings.region && <span className="annotation-brush-cursor pointer-events-none absolute rounded-full" style={{ left: left + cursor[0] * scale, top: top + cursor[1] * scale, width: Math.max(2, settings.strokeWidth * scale), height: Math.max(2, settings.strokeWidth * scale) }} />}
    <div className="pointer-events-none absolute bottom-3 left-4 right-4 flex items-center justify-between gap-3 text-xs text-muted-foreground"><span className="hidden sm:inline">{polyline ? '单击添加端点 · 双击或 Enter 完成' : tool === 'line' ? '拖动线段 · 连续单击画折线' : tool === 'text' ? '单击输入 · 双击编辑文字' : '滚轮调粗细 · Ctrl / ⌘ 滚轮缩放 · 空格拖动画布'}</span><span className="ml-auto tabular-nums">{Math.round(scale * 100)}%</span></div>
  </div>;
});
