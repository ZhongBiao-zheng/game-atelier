import { expect, it, vi } from 'vitest';
import { composeAnnotatedImage } from './composeAnnotatedImage';
it('draws original pixels then the shared SVG at the original size', async () => {
  const drawImage = vi.fn();
  let canvas: HTMLCanvasElement;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) {
    canvas = this; return { drawImage } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['png'], { type: 'image/png' })));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['original']) }));
  const urls: Blob[] = [];
  vi.stubGlobal('Image', class { src = ''; decode = async () => undefined; });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn() });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { urls.push(blob as Blob); return `blob:${urls.length}`; });
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  const file = await composeAnnotatedImage('/original', [{ id: 'r', type: 'rect', color: '#F04438', x: 0, y: 0, width: 10, height: 10, stroke_width: 4 }], 2048, 1024);
  expect(canvas!.width).toBe(2048); expect(canvas!.height).toBe(1024);
  expect(drawImage.mock.calls.map(args => [args[0].src, ...args.slice(1)])).toEqual([
    ['blob:1', 0, 0, 2048, 1024], ['blob:2', 0, 0, 2048, 1024],
  ]);
  expect(urls[1].type).toContain('image/svg+xml'); expect(file.type).toBe('image/png');
  expect(revoke).toHaveBeenCalledTimes(2);
});
