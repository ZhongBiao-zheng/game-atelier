import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveImageReferencePaths } from './studio';

afterEach(() => vi.unstubAllGlobals());

describe('resolveImageReferencePaths', () => {
  it('sref 编号生效时不上传也不复用图片式 sref', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ path: '/runtime/uploads/uploaded.png' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const style = new File(['style'], 'style.png', { type: 'image/png' });

    const result = await resolveImageReferencePaths({
      midjourney: true,
      referenceImages: [],
      mjRefs: { image: [], sref: [style], cref: [], oref: [] },
      overrideMjRefPaths: { sref: ['/runtime/uploads/old-style.png'] },
      srefCodeActive: true,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.mjRefPaths).not.toHaveProperty('sref');
  });
});
