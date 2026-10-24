import type { AnnotationElement, AnnotationPoint, AnnotationText } from '@/schema/canvas';
export type { AnnotationElement, AnnotationPoint, AnnotationColor, AnnotationText } from '@/schema/canvas';
export type AnnotationTool = 'select' | 'rect' | 'arrow' | 'freedraw' | 'text';
export const ANNOTATION_UNIT_BASE = 1024;
export const annotationUnitScale = (width: number, height: number) => Math.max(width, height) / ANNOTATION_UNIT_BASE;
export const ANNOTATION_COLORS = ['#F04438', '#FACC15', '#22C55E', '#3B82F6', '#FFFFFF'] as const;
export const ANNOTATION_COLOR_NAMES = ['红', '黄', '绿', '蓝', '白'];
export const ANNOTATION_FONT = '"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif';
export const ANNOTATION_DARK = '#0F0E0D';
export const ANNOTATION_INK = '#1B1917';
export const ANNOTATION_SELECTION = '#D4A574';
export const ANNOTATION_WHITE = '#FFFFFF';
export const STROKE_PRESETS = [2, 4, 8];
export const FONT_PRESETS = [14, 18, 28];
export const distance = (a: AnnotationPoint, b: AnnotationPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function segmentDistance(p: AnnotationPoint, a: AnnotationPoint, b: AnnotationPoint) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return distance(p, [a[0] + t * dx, a[1] + t * dy]);
}
export function simplifyPoints(points: AnnotationPoint[], epsilon: number): AnnotationPoint[] {
  if (points.length < 3) return points;
  const keep = new Set([0, points.length - 1]);
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let max = epsilon, index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = segmentDistance(points[i], points[start], points[end]);
      if (d > max) { max = d; index = i; }
    }
    if (index >= 0) { keep.add(index); stack.push([start, index], [index, end]); }
  }
  return [...keep].sort((a, b) => a - b).map(i => points[i]);
}
const textWidths = new Map<string, number>();
let measureContext: CanvasRenderingContext2D | null | undefined;
export function textBounds(element: AnnotationText, unit: number) {
  const font = element.font_size * unit;
  const key = `${font}:${element.text}`;
  let width = textWidths.get(key);
  if (width === undefined) {
    measureContext ??= document.createElement('canvas').getContext('2d');
    if (measureContext) measureContext.font = `600 ${font}px ${ANNOTATION_FONT}`;
    width = Math.max(...element.text.split('\n').map(line => measureContext?.measureText(line).width ?? line.length * font));
    if (textWidths.size > 1000) textWidths.clear();
    textWidths.set(key, width);
  }
  return { x: element.x, y: element.y, width: width + (element.background ? font : 0),
    height: element.text.split('\n').length * font * 1.3 + (element.background ? font * .5 : 0) };
}
export function elementBounds(element: AnnotationElement, unit: number) {
  if (element.type === 'text') return textBounds(element, unit);
  if (element.type === 'rect') return { x: element.x, y: element.y, width: element.width, height: element.height };
  const points = element.type === 'arrow' ? [element.start, element.end] : element.points;
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
export function hitElement(elements: AnnotationElement[], point: AnnotationPoint, unit: number, pixel: number) {
  return [...elements].reverse().find(element => {
    if (element.type === 'text') {
      const b = elementBounds(element, unit);
      return point[0] >= b.x && point[0] <= b.x + b.width && point[1] >= b.y && point[1] <= b.y + b.height;
    }
    // A box only answers on its outline, so marks inside it stay reachable and new boxes can start inside it.
    const points: AnnotationPoint[] = element.type === 'rect'
      ? [[element.x, element.y], [element.x + element.width, element.y], [element.x + element.width, element.y + element.height],
        [element.x, element.y + element.height], [element.x, element.y]]
      : element.type === 'arrow' ? [element.start, element.end] : element.points;
    return points.slice(1).some((p, i) => segmentDistance(point, points[i], p) <= element.stroke_width * unit * 1.5 + 6 * pixel);
  });
}
export function translateElement(element: AnnotationElement, dx: number, dy: number): AnnotationElement {
  const move = (p: AnnotationPoint): AnnotationPoint => [p[0] + dx, p[1] + dy];
  if (element.type === 'arrow') return { ...element, start: move(element.start), end: move(element.end) };
  if (element.type === 'freedraw') return { ...element, points: element.points.map(move) };
  return { ...element, x: element.x + dx, y: element.y + dy };
}
export function validElement(element: AnnotationElement, pixel = 1) {
  if (element.type === 'rect') return element.width >= 4 * pixel && element.height >= 4 * pixel;
  if (element.type === 'arrow') return distance(element.start, element.end) >= 6 * pixel;
  if (element.type === 'freedraw') return element.points.length >= 2 && element.points.some(p => distance(p, element.points[0]) > 0);
  return !!element.text.trim();
}
export function serializeElements(elements: AnnotationElement[]) {
  if (elements.length > 500) throw new Error('最多添加 500 个标注');
  const json = JSON.stringify(elements);
  if (new TextEncoder().encode(json).length > 2 * 1024 * 1024) throw new Error('标注内容超过 2 MiB');
  return json;
}
export function penPath(points: AnnotationPoint[]) {
  if (!points.length) return '';
  let path = `M ${points[0].join(' ')}`;
  for (let i = 1; i < points.length - 1; i++) {
    path += ` Q ${points[i].join(' ')} ${(points[i][0] + points[i + 1][0]) / 2} ${(points[i][1] + points[i + 1][1]) / 2}`;
  }
  return `${path} L ${points[points.length - 1].join(' ')}`;
}
