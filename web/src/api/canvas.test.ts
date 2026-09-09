import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvasMediaUrl, downloadCanvasLayers } from './canvas';

const BASE = '/api/canvas/projects/canvas-1/versions/v-1/media';

function setDevicePixelRatio(value: number) {
  Object.defineProperty(window, 'devicePixelRatio', { value, configurable: true });
}

afterEach(() => setDevicePixelRatio(1));

it('downloads a named ZIP and does not create a download on server error', async () => {
  vi.useFakeTimers();
  const createUrl = vi.fn(() => 'blob:layers');
  const revokeUrl = vi.fn();
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = createUrl;
    static revokeObjectURL = revokeUrl;
  });
  const fetchMock = vi.fn().mockResolvedValue(new Response('zip-bytes', {
    headers: { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('拆分图层-全部图层.zip')}` },
  }));
  vi.stubGlobal('fetch', fetchMock);
  let downloadedName = '';
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloadedName = this.download;
    expect(this.isConnected).toBe(true);
  });
  try {
    await downloadCanvasLayers('canvas-1', 'layer/stack');
    expect(fetchMock.mock.calls[0][0]).toContain('/nodes/layer%2Fstack/layers/download');
    expect(downloadedName).toBe('拆分图层-全部图层.zip');
    expect(click).toHaveBeenCalledOnce();
    expect(revokeUrl).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeUrl).toHaveBeenCalledWith('blob:layers');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail: '图层文件缺失' }), { status: 404 }));
    await expect(downloadCanvasLayers('canvas-1', 'stack')).rejects.toThrow();
    expect(click).toHaveBeenCalledOnce();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

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
