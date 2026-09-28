import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  creationAssetInputUrl,
  fetchCreationAssetStaleness,
  fetchCreationAssetStalenessBatch,
  readoptCreationAsset,
  saveGenerationFromCanvas,
  saveGenerationFromJob,
  TeamSourceWithdrawnError,
} from './creationAssets';
import { ApiError } from './http';

const fetchMock = vi.fn();
vi.mock('@/api/connection', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/connection')>();
  return { ...actual, connectionFetch: (...args: unknown[]) => fetchMock(...args) };
});
afterEach(() => fetchMock.mockReset());

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });
const call = (index = 0) => ({
  url: String(fetchMock.mock.calls[index][0]),
  init: fetchMock.mock.calls[index][1] as RequestInit,
});

describe('creationAssets api', () => {
  it('builds the recipe input url by order', () => {
    expect(creationAssetInputUrl('asset 1', 2)).toBe('/api/creation-assets/asset%201/inputs/2');
  });

  it('reads the adoption staleness status', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'stale' }), { status: 200 }));
    await expect(fetchCreationAssetStaleness('asset-1')).resolves.toBe('stale');
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/creation-assets/asset-1/staleness');
  });

  it('saves a Studio job output as a generation asset', async () => {
    fetchMock.mockResolvedValue(json({ asset_id: 'a1', kind: 'generation' }, 201));
    const body = { job_id: 'job-1', output_index: 1, title: '白犬', tags: ['角色'], project_id: 'p1' };
    const asset = await saveGenerationFromJob(body);
    expect(asset.asset_id).toBe('a1');
    expect(call().url).toBe('/api/creation-assets/generation/from-job');
    expect(call().init.method).toBe('POST');
    expect(JSON.parse(String(call().init.body))).toEqual(body);
  });

  it('saves a canvas result as a generation asset', async () => {
    fetchMock.mockResolvedValue(json({ asset_id: 'a2' }, 201));
    const body = { canvas_project_id: 'c1', node_id: 'n1', version_id: 'v1', title: '白犬', tags: [] };
    await saveGenerationFromCanvas(body);
    expect(call().url).toBe('/api/creation-assets/generation/from-canvas');
    expect(call().init.method).toBe('POST');
    expect(JSON.parse(String(call().init.body))).toEqual(body);
  });

  it('surfaces the stable error code when a job output cannot become a generation asset', async () => {
    fetchMock.mockResolvedValue(json({ detail: { code: 'not_shareable', message: '不是生成结果' } }, 422));
    const error = await saveGenerationFromJob({ job_id: 'j', output_index: 0, title: 't', tags: [] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('not_shareable');
    expect((error as ApiError).message).toContain('不是生成结果');
  });

  it('reads staleness of many assets in one request', async () => {
    fetchMock.mockResolvedValue(json({ statuses: { a1: 'stale', a2: 'withdrawn' } }, 200));
    await expect(fetchCreationAssetStalenessBatch(['a1', 'a2'])).resolves.toEqual({ a1: 'stale', a2: 'withdrawn' });
    expect(call().url).toBe('/api/creation-assets/staleness');
    expect(call().init.method).toBe('POST');
    expect(JSON.parse(String(call().init.body))).toEqual({ asset_ids: ['a1', 'a2'] });
  });

  it('skips the request when there is nothing to check', async () => {
    await expect(fetchCreationAssetStalenessBatch([])).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('splits more than 200 ids into server-sized batches and merges the results', async () => {
    const ids = Array.from({ length: 450 }, (_, index) => `a${index}`);
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const { asset_ids } = JSON.parse(String(init.body)) as { asset_ids: string[] };
      return json({ statuses: Object.fromEntries(asset_ids.map(id => [id, 'fresh'])) }, 200);
    });
    const statuses = await fetchCreationAssetStalenessBatch(ids);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).asset_ids.length))
      .toEqual([200, 200, 50]);
    expect(Object.keys(statuses)).toHaveLength(450);
  });

  it('readopts an adopted asset', async () => {
    fetchMock.mockResolvedValue(json({ asset_id: 'asset 1', title: '新' }, 200));
    const asset = await readoptCreationAsset('asset 1');
    expect(asset.title).toBe('新');
    expect(call().url).toBe('/api/creation-assets/asset%201/readopt');
    expect(call().init.method).toBe('POST');
  });

  it('throws TeamSourceWithdrawnError when the source was withdrawn', async () => {
    fetchMock.mockResolvedValue(json({ detail: { code: 'withdrawn', message: '来源已撤回' } }, 409));
    await expect(readoptCreationAsset('a1')).rejects.toBeInstanceOf(TeamSourceWithdrawnError);
  });

  it('keeps other readopt conflicts as ApiError with their code', async () => {
    fetchMock.mockResolvedValue(json({ detail: { code: 'not_adopted', message: '不是采用来的资产' } }, 409));
    const error = await readoptCreationAsset('a1').catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(TeamSourceWithdrawnError);
    expect((error as ApiError).code).toBe('not_adopted');
  });

  it('reports an unreachable library on 503', async () => {
    fetchMock.mockResolvedValue(json({ detail: { code: 'library_unreachable', message: '团队库不可达' } }, 503));
    const error = await readoptCreationAsset('a1').catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(503);
    expect((error as ApiError).code).toBe('library_unreachable');
  });
});
