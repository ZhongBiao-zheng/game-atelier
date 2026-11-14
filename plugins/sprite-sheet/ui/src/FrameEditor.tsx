import { useEffect, useRef, type PointerEvent } from 'react';

import { drawCell } from './draw';
import { anchorPoint, type Layout } from './layout';

/** 当前帧：按输出格子画出来，叠上前一帧（洋葱皮）和锚点。点一下设锚点。 */
export function FrameEditor({ bitmap, layout, index, onion, anchor, onAnchor }: {
  bitmap: ImageBitmap;
  layout: Layout;
  index: number;
  onion: boolean;
  anchor: { x: number; y: number };
  onAnchor: (anchor: { x: number; y: number }) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const zoom = useRef(1);
  const count = layout.items.length;
  useEffect(() => {
    if (!ref.current || count === 0) return;
    zoom.current = drawCell(ref.current, bitmap, layout, index, {
      fit: 160, onion: onion && count > 1 ? (index - 1 + count) % count : null,
      anchor: anchorPoint(layout.cellW, layout.cellH, anchor),
    });
  }, [bitmap, layout, index, onion, anchor, count]);

  const place = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    // 吸附到整像素，再换回比例，保存的锚点与输出的像素一一对应。
    const px = Math.round(Math.min(1, Math.max(0, x)) * layout.cellW);
    const py = Math.round(Math.min(1, Math.max(0, y)) * layout.cellH);
    onAnchor({ x: layout.cellW ? px / layout.cellW : 0.5, y: layout.cellH ? py / layout.cellH : 1 });
  };
  return <div className="editor">
    {count > 0 && <canvas ref={ref} aria-label="当前帧，点击设置锚点" onPointerDown={place} />}
  </div>;
}
