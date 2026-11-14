import { afterEach, describe, expect, it, vi } from 'vitest';

import { getStudioJob, listStudioJobs, resolveImageReferencePaths } from './studio';

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

describe('creation timeline scope', () => {
  it('keeps studio and archived records but drops canvas and interface-assist jobs', async () => {
    const jobs = [
      { job_id: 'a', namespace: 'studio' }, { job_id: 'b' }, { job_id: 'c', namespace: 'ui' },
      { job_id: 'd', namespace: 'canvas' }, { job_id: 'e', namespace: 'assist' },
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => url.endsWith('/api/jobs') ? jobs : jobs[4],
      text: async () => JSON.stringify(url.endsWith('/api/jobs') ? jobs : jobs[4]),
    })));
    expect((await listStudioJobs()).map(job => job.job_id)).toEqual(['a', 'b', 'c']);
    expect(await getStudioJob('e')).toBeNull();
  });
});
