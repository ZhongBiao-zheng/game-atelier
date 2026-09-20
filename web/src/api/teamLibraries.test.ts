import { afterEach, describe, expect, it, vi } from 'vitest';

import { adoptTeamAsset, listTeamAssets, mountTeamLibrary, ProfileRequiredError, teamAssetThumbUrl } from './teamLibraries';

const fetchMock = vi.fn();
vi.mock('@/api/connection', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/connection')>();
  return { ...actual, connectionFetch: (...args: unknown[]) => fetchMock(...args) };
});
afterEach(() => fetchMock.mockReset());

describe('teamLibraries api', () => {
  it('lists assets with filters as query params', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ entries: [], next_cursor: null }), { status: 200 }));
    await listTeamAssets('lib_0123456789abcdef', { kind: 'raw', q: '龙' });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/team-libraries/lib_0123456789abcdef/assets?');
    expect(url).toContain('kind=raw');
    expect(url).toContain('q=%E9%BE%99');
  });

  it('throws ProfileRequiredError on 409 profile_required', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ detail: { code: 'profile_required' } }), { status: 409 }));
    await expect(mountTeamLibrary({ projectId: 'p1', path: '/tmp/lib' })).rejects.toBeInstanceOf(ProfileRequiredError);
  });

  it('adopt posts project id and returns created flag', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ asset: { asset_id: 'a' }, created: false }), { status: 200 }));
    const result = await adoptTeamAsset('lib_0123456789abcdef', 'ta_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'p1');
    expect(result.created).toBe(false);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ project_id: 'p1' });
  });

  it('thumb url carries width', () => {
    expect(teamAssetThumbUrl('lib_x', 'raw_abc', 256)).toBe('/api/team-libraries/lib_x/assets/raw_abc/thumb?w=256');
  });
});
