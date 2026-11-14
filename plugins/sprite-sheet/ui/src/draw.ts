/** 画布绘制的小工具：颜色只取宿主下发的设计 token。 */
import { contentBox, type Layout, type Rect } from './layout';
import type { Frame } from './sheetState';

export const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();

/** 读原图像素算每帧的不透明包围盒，结果按帧区域缓存。 */
export function createBoxReader(bitmap: ImageBitmap): (frame: Frame) => Rect | null {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  const cache = new Map<string, Rect | null>();
  return frame => {
    const key = `${frame.x},${frame.y},${frame.w},${frame.h}`;
    if (!cache.has(key)) {
      const x = Math.max(0, Math.floor(frame.x)); const y = Math.max(0, Math.floor(frame.y));
      const w = Math.min(bitmap.width - x, Math.floor(frame.w)); const h = Math.min(bitmap.height - y, Math.floor(frame.h));
      cache.set(key, w > 0 && h > 0 ? contentBox(context.getImageData(x, y, w, h).data, w, h) : null);
    }
    return cache.get(key)!;
  };
}

/** 把一个格子画进 canvas：缩放到 fit 以内（小图按整数倍放大），偏移出界的部分裁掉。返回缩放倍数。 */
export function drawCell(canvas: HTMLCanvasElement, bitmap: ImageBitmap, layout: Layout, index: number,
  options: { fit: number; onion?: number | null; anchor?: [number, number] | null }): number {
  const { cellW, cellH } = layout;
  const raw = Math.min(options.fit / Math.max(1, cellW), options.fit / Math.max(1, cellH));
  const zoom = raw >= 1 ? Math.max(1, Math.floor(raw)) : raw;
  canvas.width = Math.max(1, Math.round(cellW * zoom));
  canvas.height = Math.max(1, Math.round(cellH * zoom));
  const context = canvas.getContext('2d')!;
  context.imageSmoothingEnabled = zoom < 1;
  context.save();
  context.scale(zoom, zoom);
  context.beginPath();
  context.rect(0, 0, cellW, cellH);
  context.clip();
  const paint = (at: number, alpha: number) => {
    const item = layout.items[at];
    if (!item) return;
    context.globalAlpha = alpha;
    const { source } = item;
    context.drawImage(bitmap, source.x, source.y, source.w, source.h, item.x, item.y, source.w, source.h);
  };
  if (options.onion !== null && options.onion !== undefined) paint(options.onion, 0.3);
  paint(index, 1);
  context.restore();
  if (options.anchor) {
    const [ax, ay] = options.anchor;
    const x = Math.round(ax * zoom) + 0.5; const y = Math.round(ay * zoom) + 0.5;
    context.strokeStyle = token('primary');
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x - 6, y); context.lineTo(x + 6, y);
    context.moveTo(x, y - 6); context.lineTo(x, y + 6);
    context.stroke();
  }
  return zoom;
}
