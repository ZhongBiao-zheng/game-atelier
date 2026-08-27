import { afterEach, describe, expect, it } from 'vitest';
import { canvasMediaUrl } from './canvas';

const BASE = '/api/canvas/projects/canvas-1/versions/v-1/media';

function setDevicePixelRatio(value: number) {
  Object.defineProperty(window, 'devicePixelRatio', { value, configurable: true });
}

afterEach(() => setDevicePixelRatio(1));

describe('canvasMediaUrl', () => {
  it('asks for the original when no display width is given', () => {
    expect(canvasMediaUrl('canvas-1', 'v-1')).toBe(BASE);
  });

  it('picks the tier above the display width, scaled by the device pixel ratio', () => {
    expect(canvasMediaUrl('canvas-1', 'v-1', 56)).toBe(`${BASE}?w=256`);
    expect(canvasMediaUrl('canvas-1', 'v-1', 320)).toBe(`${BASE}?w=512`);
    setDevicePixelRatio(2);
    expect(canvasMediaUrl('canvas-1', 'v-1', 56)).toBe(`${BASE}?w=256`);
    expect(canvasMediaUrl('canvas-1', 'v-1', 320)).toBe(`${BASE}?w=1024`);
  });

  it('falls back to the original above the top tier', () => {
    expect(canvasMediaUrl('canvas-1', 'v-1', 2000)).toBe(BASE);
  });

  it('keeps one URL across a whole range of widths so resizing does not refetch', () => {
    // 拖节点边框时宽度每一帧都在变。URL 只有几个取值，浏览器才不会把同一张图重拉几十遍。
    const urls = new Set([260, 300, 400, 511, 512].map(width => canvasMediaUrl('canvas-1', 'v-1', width)));
    expect([...urls]).toEqual([`${BASE}?w=512`]);
  });
});
