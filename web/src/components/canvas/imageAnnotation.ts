import type { CanvasImageAnnotation } from '@/schema/canvas';

export type Point = [number, number];
export type AnnotationTool = 'shape' | 'line' | 'pen' | 'marker' | 'mosaic' | 'text' | 'eraser';
export type LineStyle = 'line' | 'arrow' | 'wide' | 'hollow';
export interface AnnotationElement {
  id: string;
  type: 'rectangle' | 'ellipse' | 'diamond' | 'line' | 'arrow' | 'freedraw' | 'marker' | 'mosaic' | 'erase' | 'text';
  x: number; y: number; width: number; height: number;
  strokeColor: string; strokeWidth: number; backgroundColor: string;
  points: Point[]; angle: number; opacity: number;
  lineStyle?: LineStyle; controls?: Point[]; region?: boolean;
  effect?: 'pixelate' | 'blur'; blockSize?: number;
  text?: string; fontFamily?: string | number; fontSize?: number;
  bold?: boolean; italic?: boolean; outline?: boolean;
}

export const ANNOTATION_COLOR = '#e03131ff';
export const ANNOTATION_PRESETS = ['#e03131ff', '#f08c00ff', '#ffd43bff', '#2f9e44ff', '#1971c2ff', '#6741d9ff', '#ffffffff', '#212529ff'];
export const ANNOTATION_FONTS = [['sans-serif', '黑体'], ['serif', '宋体'], ['monospace', '等宽'], ['cursive', '手写']] as const;
const TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'line', 'arrow', 'freedraw', 'marker', 'mosaic', 'erase', 'text']);
export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const finite = (value: unknown, defaultValue = 0) => typeof value === 'number' && Number.isFinite(value) ? value : defaultValue;

export function restoreAnnotation(annotation?: CanvasImageAnnotation | null): AnnotationElement[] {
  return (annotation?.elements ?? []).filter(e => TYPES.has(String(e.type)) && !e.isDeleted).map(e => ({
    id: String(e.id || crypto.randomUUID()), type: e.type as AnnotationElement['type'],
    x: finite(e.x), y: finite(e.y), width: finite(e.width), height: finite(e.height),
    strokeWidth: clamp(finite(e.strokeWidth, 3), 1, 200), strokeColor: typeof e.strokeColor === 'string' ? e.strokeColor : ANNOTATION_COLOR,
    backgroundColor: typeof e.backgroundColor === 'string' ? e.backgroundColor : 'transparent',
    points: readPoints(e.points), angle: finite(e.angle), opacity: clamp(finite(e.opacity, 100), 0, 100),
    ...(e.type === 'line' || e.type === 'arrow' ? { lineStyle: (['line', 'arrow', 'wide', 'hollow'].includes(String(e.lineStyle)) ? e.lineStyle : e.type === 'arrow' ? 'arrow' : 'line') as LineStyle, controls: readPoints(e.controls) } : {}),
    ...(e.type === 'mosaic' || e.type === 'erase' ? { region: !!e.region, effect: e.effect === 'blur' ? 'blur' as const : 'pixelate' as const, blockSize: clamp(finite(e.blockSize, 16), 2, 100) } : {}),
    ...(e.type === 'text' ? { text: String(e.text ?? ''), fontFamily: typeof e.fontFamily === 'string' ? e.fontFamily : 'sans-serif', fontSize: clamp(finite(e.fontSize, 28), 8, 300), bold: !!e.bold, italic: !!e.italic, outline: !!e.outline } : {}),
  }));
}

function readPoints(value: unknown): Point[] {
  return Array.isArray(value) ? value.filter(p => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && Number.isFinite(v))).map(p => [...p] as Point) : [];
}

export function serializeAnnotation(elements: AnnotationElement[]): CanvasImageAnnotation['elements'] {
  const json = JSON.stringify(elements);
  if (elements.length > 2000 || new TextEncoder().encode(json).length > 2 * 1024 * 1024) throw new Error('标注过多，请删除部分笔迹后再保存。');
  return JSON.parse(json) as CanvasImageAnnotation['elements'];
}

export async function loadAnnotationSource(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('源图片加载失败，请重新打开标注。');
  const blob = await response.blob(), urlObject = URL.createObjectURL(blob);
  try {
    const image = new Image(); image.src = urlObject; await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('无法读取图片尺寸。');
    return { image, width: image.naturalWidth, height: image.naturalHeight };
  } finally { URL.revokeObjectURL(urlObject); }
}

export function elementFont(e: AnnotationElement) {
  const family = typeof e.fontFamily === 'string' && ANNOTATION_FONTS.some(([value]) => value === e.fontFamily) ? e.fontFamily : 'sans-serif';
  return `${e.italic ? 'italic ' : ''}${e.bold ? 'bold ' : ''}${e.fontSize ?? 28}px ${family}`;
}

export function textBounds(e: AnnotationElement) {
  const ctx = document.createElement('canvas').getContext('2d')!; ctx.font = elementFont(e);
  return { width: Math.max(8, ...(e.text ?? '').split('\n').map(line => ctx.measureText(line).width)), height: Math.max(1, (e.text ?? '').split('\n').length) * (e.fontSize ?? 28) * 1.3 };
}

export function localPoints(e: AnnotationElement): Point[] { return e.points.length ? e.points : [[0, 0], [e.width, e.height]]; }

export function lineSamples(e: AnnotationElement): Point[] {
  const points = localPoints(e), result: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], c = e.controls?.[i - 1];
    if (!c) result.push(b);
    else for (let step = 1; step <= 24; step++) {
      const t = step / 24, s = 1 - t;
      result.push([s * s * a[0] + 2 * s * t * c[0] + t * t * b[0], s * s * a[1] + 2 * s * t * c[1] + t * t * b[1]]);
    }
  }
  return result;
}

function strokePath(ctx: CanvasRenderingContext2D, points: Point[], close = false) {
  ctx.beginPath(); ctx.moveTo(...points[0]);
  for (const p of points.slice(1)) ctx.lineTo(...p);
  if (points.length === 1) ctx.lineTo(points[0][0] + 0.01, points[0][1]);
  if (close) ctx.closePath();
}

function drawLine(ctx: CanvasRenderingContext2D, e: AnnotationElement) {
  const points = lineSamples(e), style = e.lineStyle ?? (e.type === 'arrow' ? 'arrow' : 'line');
  if (points.length < 2) return;
  const tip = points.at(-1)!, before = points.at(-2)!;
  const theta = Math.atan2(tip[1] - before[1], tip[0] - before[0]);
  const total = points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);
  const head = Math.min(total * 0.7, Math.max(12, e.strokeWidth * (style === 'arrow' ? 4 : 5)));
  if (style === 'wide' || style === 'hollow') {
    // Trim along the curve so the shaft ends at the arrowhead instead of overshooting it.
    const shaft = [...points]; let left = head;
    while (shaft.length > 1) {
      const b = shaft.at(-1)!, a = shaft.at(-2)!, length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length >= left && length > 0) { shaft[shaft.length - 1] = [b[0] + (a[0] - b[0]) * left / length, b[1] + (a[1] - b[1]) * left / length]; break; }
      left -= length; shaft.pop();
    }
    const end = shaft.at(-1)!, angle = Math.atan2(tip[1] - end[1], tip[0] - end[0]);
    const half = Math.max(3, e.strokeWidth * 1.5), headHalf = half * 2.2;
    const sides = (sign: number): Point[] => shaft.map((p, i) => {
      const a = shaft[Math.max(0, i - 1)], b = shaft[Math.min(shaft.length - 1, i + 1)];
      const direction = shaft.length > 1 ? Math.atan2(b[1] - a[1], b[0] - a[0]) : theta;
      return [p[0] - Math.sin(direction) * half * sign, p[1] + Math.cos(direction) * half * sign];
    });
    strokePath(ctx, [...sides(1), [end[0] - Math.sin(angle) * headHalf, end[1] + Math.cos(angle) * headHalf], tip,
      [end[0] + Math.sin(angle) * headHalf, end[1] - Math.cos(angle) * headHalf], ...sides(-1).reverse()], true);
    if (style === 'wide') { ctx.fillStyle = e.strokeColor; ctx.fill(); }
    else { ctx.lineWidth = Math.max(1, e.strokeWidth / 2); ctx.stroke(); }
  } else {
    strokePath(ctx, points); ctx.stroke();
    if (style === 'arrow') {
      strokePath(ctx, [[tip[0] - head * Math.cos(theta - Math.PI / 6), tip[1] - head * Math.sin(theta - Math.PI / 6)], tip,
        [tip[0] - head * Math.cos(theta + Math.PI / 6), tip[1] - head * Math.sin(theta + Math.PI / 6)]]); ctx.stroke();
    }
  }
}

function drawElement(ctx: CanvasRenderingContext2D, e: AnnotationElement) {
  ctx.save(); ctx.translate(e.x + e.width / 2, e.y + e.height / 2); ctx.rotate(e.angle); ctx.translate(-e.width / 2, -e.height / 2);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = e.strokeWidth;
  ctx.strokeStyle = e.strokeColor; ctx.fillStyle = e.backgroundColor; ctx.globalAlpha = e.opacity / 100;
  if (e.type === 'erase') ctx.globalCompositeOperation = 'destination-out';
  if (e.type === 'rectangle' || e.type === 'ellipse' || e.type === 'diamond' || e.region) {
    ctx.beginPath();
    if (e.type === 'ellipse') ctx.ellipse(e.width / 2, e.height / 2, Math.abs(e.width) / 2, Math.abs(e.height) / 2, 0, 0, Math.PI * 2);
    else if (e.type === 'diamond') strokePath(ctx, [[e.width / 2, 0], [e.width, e.height / 2], [e.width / 2, e.height], [0, e.height / 2]], true);
    else ctx.rect(0, 0, e.width, e.height);
    if (e.type === 'erase' || e.type === 'mosaic') { ctx.fillStyle = 'black'; ctx.fill(); }
    else { if (e.backgroundColor !== 'transparent') ctx.fill(); ctx.stroke(); }
  } else if (e.type === 'line' || e.type === 'arrow') drawLine(ctx, e);
  else if (e.type === 'text') {
    ctx.font = elementFont(e); ctx.textBaseline = 'top'; ctx.fillStyle = e.strokeColor;
    for (const [i, line] of (e.text ?? '').split('\n').entries()) {
      const y = i * (e.fontSize ?? 28) * 1.3;
      if (e.outline) { ctx.strokeStyle = 'white'; ctx.lineWidth = Math.max(2, (e.fontSize ?? 28) / 12); ctx.strokeText(line, 0, y); }
      ctx.fillText(line, 0, y);
    }
  } else {
    const fill = e.type === 'marker' && e.backgroundColor !== 'transparent';
    strokePath(ctx, localPoints(e), fill);
    if (e.type === 'erase' || e.type === 'mosaic') ctx.strokeStyle = 'black';
    if (fill) { ctx.fillStyle = e.strokeColor; ctx.fill(); }
    ctx.stroke();
  }
  ctx.restore();
}

function canvas(width: number, height: number) {
  const result = document.createElement('canvas'); result.width = Math.max(1, Math.round(width)); result.height = Math.max(1, Math.round(height)); return result;
}

/** Source and marks remain separate so erasing never cuts holes in the original. */
export function renderAnnotation(image: HTMLImageElement, elements: AnnotationElement[], target: HTMLCanvasElement, maxSize = Infinity) {
  const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale)), height = Math.max(1, Math.round(image.naturalHeight * scale));
  if (target.width !== width || target.height !== height) { target.width = width; target.height = height; }
  const ctx = target.getContext('2d')!; ctx.clearRect(0, 0, width, height); ctx.drawImage(image, 0, 0, width, height);
  const overlay = canvas(width, height), ink = overlay.getContext('2d')!; ink.scale(scale, scale);
  for (const e of elements) {
    if (e.type !== 'mosaic') { drawElement(ink, e); continue; }
    const composite = canvas(width, height), combined = composite.getContext('2d')!;
    combined.drawImage(image, 0, 0, width, height); combined.drawImage(overlay, 0, 0);
    const effect = canvas(width, height), effectCtx = effect.getContext('2d')!;
    const block = Math.max(1, (e.blockSize ?? 16) * scale);
    if (e.effect === 'blur') { effectCtx.filter = `blur(${block}px)`; effectCtx.drawImage(composite, 0, 0); }
    else {
      const small = canvas(width / block, height / block); small.getContext('2d')!.drawImage(composite, 0, 0, small.width, small.height);
      effectCtx.imageSmoothingEnabled = false; effectCtx.drawImage(small, 0, 0, width, height);
    }
    const mask = canvas(width, height), maskCtx = mask.getContext('2d')!; maskCtx.scale(scale, scale); drawElement(maskCtx, { ...e, opacity: 100 });
    effectCtx.filter = 'none'; effectCtx.globalCompositeOperation = 'destination-in'; effectCtx.drawImage(mask, 0, 0);
    ink.save(); ink.resetTransform(); ink.drawImage(effect, 0, 0); ink.restore();
  }
  ctx.drawImage(overlay, 0, 0);
}

export async function exportAnnotation(image: HTMLImageElement, elements: AnnotationElement[]) {
  const target = canvas(image.naturalWidth, image.naturalHeight); renderAnnotation(image, elements, target);
  return new Promise<Blob>((resolve, reject) => target.toBlob(blob => blob ? resolve(blob) : reject(new Error('导出标注图失败。')), 'image/png'));
}

export function bounds(e: AnnotationElement) {
  if (e.type === 'text') return { x: e.x, y: e.y, ...textBounds(e) };
  if (e.points.length && !e.region) {
    const points = [...e.points, ...(e.controls ?? [])], xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    return { x: e.x + Math.min(...xs), y: e.y + Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  return { x: Math.min(e.x, e.x + e.width), y: Math.min(e.y, e.y + e.height), width: Math.abs(e.width), height: Math.abs(e.height) };
}

export function hitElement(e: AnnotationElement, point: Point, tolerance: number) {
  if (e.type === 'erase' || e.type === 'mosaic') return false;
  const cx = e.x + e.width / 2, cy = e.y + e.height / 2, dx = point[0] - cx, dy = point[1] - cy;
  const local: Point = [dx * Math.cos(-e.angle) - dy * Math.sin(-e.angle) + e.width / 2, dx * Math.sin(-e.angle) + dy * Math.cos(-e.angle) + e.height / 2];
  if (['line', 'arrow', 'freedraw', 'marker'].includes(e.type)) {
    const points = e.type === 'line' || e.type === 'arrow' ? lineSamples(e) : localPoints(e), radius = tolerance + e.strokeWidth / 2;
    return points.some((b, i) => {
      const a = points[Math.max(0, i - 1)], vx = b[0] - a[0], vy = b[1] - a[1];
      const t = clamp(((local[0] - a[0]) * vx + (local[1] - a[1]) * vy) / (vx * vx + vy * vy || 1), 0, 1);
      return Math.hypot(local[0] - a[0] - t * vx, local[1] - a[1] - t * vy) <= radius;
    });
  }
  const size = e.type === 'text' ? textBounds(e) : e;
  return local[0] >= -tolerance && local[1] >= -tolerance && local[0] <= size.width + tolerance && local[1] <= size.height + tolerance;
}
