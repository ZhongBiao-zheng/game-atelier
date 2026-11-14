/**
 * 帧在输出格子里的排布。与服务端 server/sheet.py 的 placements / anchor_point 是同一套算法，
 * 两边都跑 tests/layout_cases.json：界面里看到的预览就是「放到画布」排出来的样子。
 */
import type { Align, Frame } from './sheetState';

export const ALPHA_THRESHOLD = 8;
export interface Rect { x: number; y: number; w: number; h: number }
export interface Layout {
  cellW: number;
  cellH: number;
  /** 每帧：取图的区域（裁过透明边）与它在格内的位置。 */
  items: Array<{ source: Rect; x: number; y: number }>;
}

export function placements(sizes: ReadonlyArray<readonly [number, number]>,
  offsets: ReadonlyArray<readonly [number, number]>, align: Align) {
  const cellW = Math.max(0, ...sizes.map(([w]) => w));
  const cellH = Math.max(0, ...sizes.map(([, h]) => h));
  const positions = sizes.map(([w, h], index) => {
    const [ox, oy] = offsets[index];
    if (align === 'top-left') return [ox, oy] as const;
    const dx = Math.floor((cellW - w) / 2);
    const dy = align === 'center' ? Math.floor((cellH - h) / 2) : cellH - h;
    return [dx + ox, dy + oy] as const;
  });
  return { cellW, cellH, positions };
}

export function anchorPoint(cellW: number, cellH: number, anchor: { x: number; y: number }): [number, number] {
  return [Math.floor(cellW * anchor.x), Math.floor(cellH * anchor.y)];
}

/** 一块像素里不透明内容的包围盒（相对这块像素的左上角）；全透明返回 null。 */
export function contentBox(data: Uint8ClampedArray, width: number, height: number): Rect | null {
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= ALPHA_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function layoutFrames(frames: readonly Frame[], box: (frame: Frame) => Rect | null,
  options: { align: Align; trim: boolean }): Layout {
  const sources = frames.map(frame => {
    if (!options.trim) return { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
    const found = box(frame);
    // 与服务端一致：全透明的帧当成 1×1。
    return found ? { x: frame.x + found.x, y: frame.y + found.y, w: found.w, h: found.h } : { x: frame.x, y: frame.y, w: 1, h: 1 };
  });
  const { cellW, cellH, positions } = placements(
    sources.map(source => [source.w, source.h] as const),
    frames.map(frame => [frame.ox ?? 0, frame.oy ?? 0] as const), options.align);
  return { cellW, cellH, items: sources.map((source, index) => ({ source, x: positions[index][0], y: positions[index][1] })) };
}
