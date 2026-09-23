import { afterEach, describe, expect, it, vi } from 'vitest';

import { creationAssetInputUrl, fetchCreationAssetStaleness } from './creationAssets';

const fetchMock = vi.fn();
vi.mock('@/api/connection', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/connection')>();
  return { ...actual, connectionFetch: (...args: unknown[]) => fetchMock(...args) };
});
afterEach(() => fetchMock.mockReset());

describe('creationAssets api', () => {
  it('builds the recipe input url by order', () => {
    expect(creationAssetInputUrl('asset 1', 2)).toBe('/api/creation-assets/asset%201/inputs/2');
  });

  it('reads the adoption staleness status', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'stale' }), { status: 200 }));
    await expect(fetchCreationAssetStaleness('asset-1')).resolves.toBe('stale');
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/creation-assets/asset-1/staleness');
  });
});
