import { useLayoutEffect, useRef, useState } from 'react';
import { AnnotationLayer } from './AnnotationLayer';
import type { AnnotationEditor } from './useAnnotationEditor';
import { ANNOTATION_FONT, ANNOTATION_COLORS, ANNOTATION_WHITE, ANNOTATION_INK, ANNOTATION_DARK, annotationUnitScale } from './annotationModel';
export function AnnotationEditingLayer({ editor, width, height, fit }: {
  editor: AnnotationEditor; width: number; height: number; fit: 'contain' | 'cover' | 'fill';
}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = host.current; if (!element) return;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element); setSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);
  const textId = editor.text?.id;
  const textareaRef = editor.textareaRef;
  useLayoutEffect(() => { if (textId) textareaRef.current?.focus(); }, [textId, textareaRef]);
  const wheel = useRef(editor.wheel);
  wheel.current = editor.wheel;
  useLayoutEffect(() => {
    const element = host.current; if (!element) return;
    // React registers wheel as passive; a native listener can claim the scroll before the canvas zooms.
    const listener = (event: WheelEvent) => {
      const svg = element.querySelector<SVGSVGElement>(':scope > svg');
      if (svg && event.target instanceof Element && svg.contains(event.target)) wheel.current(event, svg);
    };
    element.addEventListener('wheel', listener, { passive: false });
    return () => element.removeEventListener('wheel', listener);
  }, []);
  const cursor = editor.hoveredId ? 'move' : editor.prefs.tool === 'text' ? 'text' : editor.prefs.tool === 'select' ? 'default' : 'crosshair';
  const sx = size.width / width, sy = size.height / height;
  const scale = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  const xscale = fit === 'fill' ? sx : scale, yscale = fit === 'fill' ? sy : scale;
  const text = editor.text;
  return <div ref={host} className="pointer-events-none absolute inset-0" data-annotation-surface>
    <AnnotationLayer elements={editor.elements.filter(item => item.id !== text?.id)}
      imageWidth={width} imageHeight={height} fit={fit} selectedId={editor.selectedId} screenPixel={editor.screenPixel}
      className="nodrag nopan absolute inset-0 size-full"
      style={{ pointerEvents: editor.panning ? 'none' : 'auto', cursor, touchAction: 'none' }}
      onPointerDown={editor.pointerDown} onPointerMove={editor.pointerMove} onPointerUp={editor.pointerUp}
      onPointerLeave={editor.pointerLeave}
      onPointerCancel={editor.cancelGesture} onDoubleClick={editor.doubleClick} onClick={event => event.stopPropagation()} />
    {text && <textarea data-annotation-text ref={editor.textareaRef} value={text.text} maxLength={500}
      aria-label="标注文字" wrap="off" className="nodrag nopan pointer-events-auto absolute min-w-32 resize-none border-0 bg-transparent p-0 outline-none"
      style={{ left: (size.width - width * xscale) / 2 + text.x * xscale,
        top: (size.height - height * yscale) / 2 + text.y * yscale,
        color: text.background ? (text.color === ANNOTATION_WHITE || text.color === ANNOTATION_COLORS[1] ? ANNOTATION_INK : ANNOTATION_WHITE) : text.color,
        backgroundColor: text.background ? text.color : undefined,
        padding: text.background ? `${text.font_size * annotationUnitScale(width, height) * yscale * .25}px ${text.font_size * annotationUnitScale(width, height) * xscale * .5}px` : 0,
        WebkitTextStroke: text.background ? undefined : `${text.font_size * annotationUnitScale(width, height) * yscale * .18}px ${ANNOTATION_DARK}`,
        paintOrder: 'stroke', fontFamily: ANNOTATION_FONT, fontWeight: 600,
        fontSize: text.font_size * annotationUnitScale(width, height) * yscale, lineHeight: 1.3,
        width: Math.max(160, (text.text.length + 2) * text.font_size * annotationUnitScale(width, height) * xscale),
        height: Math.max(40, (text.text.split('\n').length + 1) * text.font_size * annotationUnitScale(width, height) * yscale * 1.3) }}
      onChange={event => editor.setText({ ...text, text: event.target.value })}
      onPointerDown={event => event.stopPropagation()}
      onCompositionStart={() => { editor.composing.current = true; }}
      onCompositionEnd={() => { editor.composing.current = false; }}
      onKeyDown={event => {
        event.stopPropagation();
        if (editor.composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); editor.finishText(true); }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); editor.finishText(); }
      }} />}
  </div>;
}
