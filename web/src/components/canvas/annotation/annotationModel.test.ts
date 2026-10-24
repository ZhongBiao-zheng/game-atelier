import { beforeEach, describe, expect, it, vi } from 'vitest';
import { annotationUnitScale, hitElement, simplifyPoints, translateElement, validElement, serializeElements, type AnnotationElement } from './annotationModel';
export const elements: AnnotationElement[] = [
  { id: 'r', type: 'rect', color: '#F04438', x: 10, y: 10, width: 50, height: 30, stroke_width: 4 },
  { id: 'a', type: 'arrow', color: '#FACC15', start: [100, 100], end: [150, 100], stroke_width: 4 },
  { id: 'p', type: 'freedraw', color: '#22C55E', points: [[200, 200], [250, 210]], stroke_width: 4 },
  { id: 't', type: 'text', color: '#FFFFFF', x: 300, y: 300, text: '改色', font_size: 18, background: false },
];
describe('annotation geometry', () => {
  it('uses image units and hits all four types, from top to bottom', () => {
    expect(annotationUnitScale(2048, 1024)).toBe(2);
    for (const [index, point] of [[0, [10, 20]], [1, [120, 103]], [2, [225, 205]], [3, [301, 301]]] as const) {
      expect(hitElement(elements, [...point], 1, 1)?.id).toBe(elements[index].id);
    }
    expect(hitElement(elements, [999, 999], 1, 1)).toBeUndefined();
    expect(hitElement(elements, [35, 25], 1, 1)).toBeUndefined();
    expect(translateElement(elements[1], 10, 20)).toMatchObject({ start: [110, 120], end: [160, 120] });
  });
  it('simplifies sampled points and rejects tiny shapes', () => {
    expect(simplifyPoints([[0, 0], [1, .1], [2, 0], [3, 0]], .75)).toEqual([[0, 0], [3, 0]]);
    expect(validElement({ ...elements[0], type: 'rect', x: 0, y: 0, width: 1, height: 10, stroke_width: 4 })).toBe(false);
    expect(validElement({ ...elements[1], type: 'arrow', start: [0, 0], end: [1, 0], stroke_width: 4 })).toBe(false);
  });
  it('bounds serialized content and element count', () => {
    expect(() => serializeElements(Array(501).fill(elements[0]))).toThrow('500');
    expect(() => serializeElements([{ ...elements[3], text: 'a'.repeat(2 * 1024 * 1024) } as AnnotationElement])).toThrow('2 MiB');
  });
});

beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: () => ({ width: 40 }) } as unknown as CanvasRenderingContext2D); });
