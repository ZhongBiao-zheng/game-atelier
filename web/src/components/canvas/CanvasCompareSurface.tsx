import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { canvasMediaUrl, canvasMediaUrlAtWidth } from '@/api/canvas';
import type { CanvasNormalizedFrame, CanvasSize } from '@/schema/canvas';
import { Button } from '@/components/ui/button';

const KEYBOARD_STEP = 5;

/** 前后对比：左侧 Before、右侧 After，拖动分界查看。
 *  frame 只在扩图结果对比它自己的原图时给出，其余组合两张图各自完整放进画框。
 *  bitmapWidth 为 null 时取原图（全屏查看）。 */
export function CanvasCompareSurface({ projectId, title, beforeVersionId, afterVersionId, afterSize, frame, bitmapWidth }: {
  projectId: string;
  title: string;
  beforeVersionId: string | null;
  afterVersionId: string | null;
  /** After 的像素尺寸：扩图对位时用它算出 After 在框里的实际显示区域。 */
  afterSize: CanvasSize | null;
  frame: CanvasNormalizedFrame | null;
  bitmapWidth: number | null;
}) {
  const [split, setSplit] = useState(50);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<CanvasSize | null>(null);
  useLayoutEffect(() => {
    const element = surfaceRef.current;
    if (!element || !frame) return;
    // 先同步量一次：ResizeObserver 的首次回调要等下一帧，后台标签页里可能迟迟不来。
    const rect = element.getBoundingClientRect();
    setBox({ width: rect.width, height: rect.height });
    const observer = new ResizeObserver(([entry]) => setBox({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame]);
  // 扩图对位：框和 After 比例不一致（全屏、拉伸过节点）时，After 是居中留边显示的，
  // 原图必须定位在 After 的实际显示区域里，而不是整个框里。
  const fitted = frame && afterSize && box ? containRect(afterSize, box) : null;
  const afterStyle: CSSProperties | undefined = fitted
    ? { left: fitted.x, top: fitted.y, width: fitted.width, height: fitted.height } : undefined;
  const beforeStyle: CSSProperties | undefined = frame && fitted ? {
    left: fitted.x + frame.x * fitted.width, top: fitted.y + frame.y * fitted.height,
    width: frame.width * fitted.width, height: frame.height * fitted.height,
  } : undefined;
  const src = (versionId: string) => bitmapWidth === null
    ? canvasMediaUrl(projectId, versionId)
    : canvasMediaUrlAtWidth(projectId, versionId, bitmapWidth);

  function moveTo(event: ReactPointerEvent) {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    setSplit(Math.min(100, Math.max(0, (event.clientX - rect.left) / rect.width * 100)));
  }

  return (
    <div ref={surfaceRef} className="relative size-full select-none overflow-hidden bg-background">
      {afterVersionId && <img src={src(afterVersionId)} alt={`${title} After`} draggable={false} decoding="async"
        className={`absolute ${afterStyle ? 'object-fill' : 'inset-0 size-full object-contain'}`} style={afterStyle} />}
      <div className={`absolute inset-0 bg-background ${frame ? 'edit-dot-grid-dense' : ''}`}
        style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
        {beforeVersionId && <img src={src(beforeVersionId)} alt={`${title} Before`} draggable={false} decoding="async"
          className={`absolute ${beforeStyle ? 'object-fill' : 'inset-0 size-full object-contain'}`}
          style={beforeStyle} />}
      </div>
      {(!beforeVersionId || !afterVersionId) && (
        <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-background/80 px-3 py-1.5 text-xs text-muted-foreground">
          连入两张图
        </span>
      )}
      <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/45 px-1.5 py-0.5 text-xs text-white/90">Before</span>
      <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/45 px-1.5 py-0.5 text-xs text-white/90">After</span>
      <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white" style={{ left: `${split}%` }} />
      <Button variant="bare" type="button" role="slider" aria-label={`${title} 对比分界`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(split)}
        className="nodrag nopan absolute top-1/2 flex h-7 w-11 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full bg-white text-neutral-900"
        style={{ left: `${split}%` }}
        onPointerDown={event => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveTo(event); }}
        onDoubleClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          event.stopPropagation();
          setSplit(value => Math.min(100, Math.max(0, value + (event.key === 'ArrowLeft' ? -KEYBOARD_STEP : KEYBOARD_STEP))));
        }}>
        <ChevronLeft size={14} strokeWidth={2.5} /><ChevronRight size={14} strokeWidth={2.5} className="-ml-1" />
      </Button>
    </div>
  );
}

function containRect(content: CanvasSize, box: CanvasSize) {
  const scale = Math.min(box.width / content.width, box.height / content.height);
  const width = content.width * scale;
  const height = content.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}
