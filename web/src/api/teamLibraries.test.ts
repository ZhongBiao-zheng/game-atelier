import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  adoptTeamAsset,
  listRelatedTeamAssets,
  listTeamAssets,
  listTeamLibraries,
  mountTeamLibrary,
  ProfileRequiredError,
  shareToTeamLibrary,
  TeamNotAuthorError,
  TeamRefsTooLargeError,
  teamAssetThumbUrl,
  updateTeamAsset,
  withdrawTeamAsset,
} from './teamLibraries';

const LIB = 'lib_0123456789abcdef';
const ASSET = 'ta_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });

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

  it('lists all mounted libraries without a project_id query', async () => {
    fetchMock.mockResolvedValue(json([], 200));
    await listTeamLibraries();
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/team-libraries');
  });

  it('lists libraries of one canvas project', async () => {
    fetchMock.mockResolvedValue(json([], 200));
    await listTeamLibraries('canvas-a');
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/team-libraries?project_id=canvas-a');
  });

  it('shares a job output and returns the index entry', async () => {
    fetchMock.mockResolvedValue(json({ id: ASSET }, 201));
    const request = { source: { kind: 'job_output' as const, job_id: 'job-1', output_index: 0 }, title: '白犬', tags: ['角色'] };
    const entry = await shareToTeamLibrary(LIB, request);
    expect(entry.id).toBe(ASSET);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/team-libraries/${LIB}/share`);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(request);
  });

  it('share throws ProfileRequiredError on 409 profile_required', async () => {
    fetchMock.mockResolvedValue(json({ detail: { code: 'profile_required' } }, 409));
    await expect(shareToTeamLibrary(LIB, {
      source: { kind: 'creation_asset', asset_id: 'asset-1' }, title: 't', tags: [],
    })).rejects.toBeInstanceOf(ProfileRequiredError);
  });

  it('share throws TeamRefsTooLargeError carrying bytes on 413', async () => {
    fetchMock.mockResolvedValue(json({ detail: { code: 'refs_too_large', bytes: 314572800 } }, 413));
    const error = await shareToTeamLibrary(LIB, {
      source: { kind: 'creation_asset', asset_id: 'asset-1' }, title: 't', tags: [],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TeamRefsTooLargeError);
    expect((error as TeamRefsTooLargeError).bytes).toBe(314572800);
  });

  it('updates title and tags with PUT', async () => {
    fetchMock.mockResolvedValue(json({ id: ASSET, title: '新' }, 200));
    const entry = await updateTeamAsset(LIB, ASSET, { title: '新', tags: [] });
    expect(entry.title).toBe('新');
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/team-libraries/${LIB}/assets/${ASSET}`);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PUT');
  });

  it('update throws TeamNotAuthorError on 403', async () => {
    fetchMock.mockResolvedValue(json({ detail: { code: 'not_author' } }, 403));
    await expect(updateTeamAsset(LIB, ASSET, { title: '新', tags: [] })).rejects.toBeInstanceOf(TeamNotAuthorError);
  });

  it('withdraw sends DELETE and resolves on 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(withdrawTeamAsset(LIB, ASSET)).resolves.toBeUndefined();
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/team-libraries/${LIB}/assets/${ASSET}`);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });

  it('withdraw throws TeamNotAuthorError on 403', async () => {
    fetchMock.mockResolvedValue(json({ detail: { code: 'not_author' } }, 403));
    await expect(withdrawTeamAsset(LIB, ASSET)).rejects.toBeInstanceOf(TeamNotAuthorError);
  });

  it('withdraw throws ProfileRequiredError on 409 profile_required', async () => {
    fetchMock.mockResolvedValue(json({ detail: { code: 'profile_required' } }, 409));
    await expect(withdrawTeamAsset(LIB, ASSET)).rejects.toBeInstanceOf(ProfileRequiredError);
  });

  it('lists related generation assets of a canvas project', async () => {
    fetchMock.mockResolvedValue(json([{ library_id: LIB, library_name: '美术组', entry: { id: ASSET } }], 200));
    const related = await listRelatedTeamAssets('canvas-a');
    expect(related[0].library_name).toBe('美术组');
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/team-libraries/related?project_id=canvas-a');
  });
});
