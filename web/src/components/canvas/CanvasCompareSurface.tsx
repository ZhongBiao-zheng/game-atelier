import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { canvasMediaUrlAtWidth } from '@/api/canvas';
import type { CanvasCompareNode } from '@/schema/canvas';

const KEYBOARD_STEP = 5;

export function CanvasCompareSurface({ node, projectId, bitmapWidth }: {
  node: CanvasCompareNode; projectId: string; bitmapWidth: number | null;
}) {
  const [split, setSplit] = useState(50);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const frame = node.data.before_frame;

  function moveTo(event: ReactPointerEvent) {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    setSplit(Math.min(100, Math.max(0, (event.clientX - rect.left) / rect.width * 100)));
  }

  return (
    <div ref={surfaceRef} className="relative size-full select-none overflow-hidden">
      <img src={canvasMediaUrlAtWidth(projectId, node.data.after_version_id, bitmapWidth)} alt={`${node.title} After`}
        draggable={false} decoding="async" className="absolute inset-0 size-full object-fill" />
      <div className={`absolute inset-0 ${frame ? 'edit-dot-grid-dense bg-background' : ''}`}
        style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
        <img src={canvasMediaUrlAtWidth(projectId, node.data.before_version_id, bitmapWidth)} alt={`${node.title} Before`}
          draggable={false} decoding="async" className="absolute object-fill"
          style={frame
            ? { left: `${frame.x * 100}%`, top: `${frame.y * 100}%`, width: `${frame.width * 100}%`, height: `${frame.height * 100}%` }
            : { inset: 0, width: '100%', height: '100%' }} />
      </div>
      <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/45 px-1.5 py-0.5 text-xs text-white/90">Before</span>
      <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/45 px-1.5 py-0.5 text-xs text-white/90">After</span>
      <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white" style={{ left: `${split}%` }} />
      <button type="button" role="slider" aria-label={`${node.title} 对比分界`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(split)}
        className="nodrag nopan absolute top-1/2 flex h-7 w-11 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full bg-white text-neutral-900"
        style={{ left: `${split}%` }}
        onPointerDown={event => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveTo(event); }}
        onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          event.stopPropagation();
          setSplit(value => Math.min(100, Math.max(0, value + (event.key === 'ArrowLeft' ? -KEYBOARD_STEP : KEYBOARD_STEP))));
        }}>
        <ChevronLeft size={14} strokeWidth={2.5} /><ChevronRight size={14} strokeWidth={2.5} className="-ml-1" />
      </button>
    </div>
  );
}
