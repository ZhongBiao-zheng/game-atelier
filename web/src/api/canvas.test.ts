import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvasMediaUrl, downloadCanvasLayers, reproduceIntoCanvas, saveCanvasImageEdit, submitCanvasImageEdit } from './canvas';

const BASE = '/api/canvas/projects/canvas-1/versions/v-1/media';

function setDevicePixelRatio(value: number) {
  Object.defineProperty(window, 'devicePixelRatio', { value, configurable: true });
}

afterEach(() => setDevicePixelRatio(1));

it('separates local image-edit saves from runs and omits cleared masks', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const payload = { expected_revision: 7, node_id: 'edit', generation_draft: null,
      options: { mode: 'inpaint' as const }, reference_node_id: null, reference_version_id: null,
      editor_state: { strokes: [], frame_ratio: '', frame: { width: 100, height: 100, x: 0, y: 0 } } };
    await saveCanvasImageEdit('p', payload, null);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/canvas/projects/p/image-edits');
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(JSON.parse(String(form.get('payload')))).toEqual(payload);
    expect(form.has('mask_file')).toBe(false);
    await saveCanvasImageEdit('p', payload, new Blob(['mask'], { type: 'image/png' }));
    expect((fetchMock.mock.calls[1][1].body as FormData).has('mask_file')).toBe(true);
    await submitCanvasImageEdit('p', 'edit', 8, 4);
    expect(fetchMock.mock.calls[2][0]).toBe('/api/canvas/projects/p/runs/image-edit');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ surface_node_id: 'edit', expected_revision: 8, requested_count: 4 });
  } finally { vi.unstubAllGlobals(); }
});

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
    expect(fetchMock.mock.calls[0][0]).toContain('/nodes/layer%2Fstack/layers/download?format=zip');
    expect(downloadedName).toBe('拆分图层-全部图层.zip');
    expect(click).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(new Response('psd-bytes'));
    await downloadCanvasLayers('canvas-1', 'stack', 'psd');
    expect(fetchMock.mock.calls[1][0]).toContain('/nodes/stack/layers/download?format=psd');
    expect(downloadedName).toBe('图层.psd');
    expect(click).toHaveBeenCalledTimes(2);
    expect(revokeUrl).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeUrl).toHaveBeenCalledWith('blob:layers');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail: '图层文件缺失' }), { status: 404 }));
    await expect(downloadCanvasLayers('canvas-1', 'stack')).rejects.toThrow();
    expect(click).toHaveBeenCalledTimes(2);
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

describe('reproduceIntoCanvas', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the reproduce request with the document revision and returns warnings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ revision: 8, nodes: [], edges: [], warnings: ['蒙版没有带过来'] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const result = await reproduceIntoCanvas({
      projectId: 'canvas 1',
      assetId: 'asset/1',
      position: { x: 10, y: 20 },
      alias: 'hk',
      model: 'gpt-image-1',
      documentRevision: 7,
    });
    expect(result.warnings).toEqual(['蒙版没有带过来']);
    expect(result.revision).toBe(8);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/canvas/projects/canvas%201/creation-assets/asset%2F1/reproduce');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('If-Match')).toBe('7');
    expect(JSON.parse(String(init.body))).toEqual({ position: { x: 10, y: 20 }, alias: 'hk', model: 'gpt-image-1' });
  });

  it('sends null model and alias when the recipe model is not available locally', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ warnings: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await reproduceIntoCanvas({
      projectId: 'c', assetId: 'a', position: { x: 0, y: 0 }, alias: null, model: null, documentRevision: 1,
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ position: { x: 0, y: 0 }, alias: null, model: null });
  });

  it('maps a revision conflict to a Chinese error with its code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ detail: { code: 'revision_conflict', message: '画布已在别处改动' } }), { status: 409 },
    )));
    await expect(reproduceIntoCanvas({
      projectId: 'c', assetId: 'a', position: { x: 0, y: 0 }, alias: null, model: null, documentRevision: 1,
    })).rejects.toMatchObject({ status: 409, code: 'revision_conflict' });
  });
});
