import { useEffect, useRef, useState, type PointerEvent } from 'react';

import type { Frame } from './sheetState';

/** 帧列表：点选一帧，按住拖动换顺序。 */
export function FrameStrip({ bitmap, frames, selected, onSelect, onMove }: {
  bitmap: ImageBitmap;
  frames: readonly Frame[];
  selected: number;
  onSelect: (index: number) => void;
  onMove: (from: number, to: number) => void;
}) {
  const thumbs = useRef<Array<HTMLDivElement | null>>([]);
  const [drag, setDrag] = useState<{ from: number; to: number; startX: number; moved: boolean } | null>(null);

  const targetAt = (clientX: number) => {
    let target = frames.length - 1;
    thumbs.current.slice(0, frames.length).some((element, index) => {
      const rect = element?.getBoundingClientRect();
      if (rect && clientX < rect.left + rect.width / 2) { target = index; return true; }
      return false;
    });
    return target;
  };
  const down = (index: number) => (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ from: index, to: index, startX: event.clientX, moved: false });
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const moved = drag.moved || Math.abs(event.clientX - drag.startX) > 4;
    setDrag({ ...drag, moved, to: moved ? targetAt(event.clientX) : drag.from });
  };
  const up = () => {
    if (!drag) return;
    if (drag.moved && drag.to !== drag.from) onMove(drag.from, drag.to);
    else onSelect(drag.from);
    setDrag(null);
  };

  return <div className="strip-frames" role="listbox" aria-label="帧" aria-orientation="horizontal">
    {frames.map((frame, index) => (
      <div key={index} ref={element => { thumbs.current[index] = element; }} role="option" aria-selected={index === selected}
        aria-label={`第 ${index + 1} 帧`} tabIndex={index === selected ? 0 : -1}
        className={['thumb', index === selected ? 'selected' : '', drag?.moved && drag.from === index ? 'dragging' : '',
          drag?.moved && drag.to === index && drag.from !== index ? 'drop' : ''].join(' ')}
        onPointerDown={down(index)} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)}>
        <span className="index">{index + 1}</span>
        <Thumb bitmap={bitmap} frame={frame} />
      </div>
    ))}
  </div>;
}

function Thumb({ bitmap, frame }: { bitmap: ImageBitmap; frame: Frame }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = Math.max(1, Math.round(frame.w));
    canvas.height = Math.max(1, Math.round(frame.h));
    const context = canvas.getContext('2d')!;
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
  }, [bitmap, frame]);
  return <canvas ref={ref} />;
}
