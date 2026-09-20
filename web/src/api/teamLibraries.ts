import { connectionFetch } from '@/api/connection';
import { apiError, requestJson } from './http';
import type {
  TeamAssetAdoptResponse,
  TeamAssetKind,
  TeamLibraryAssetPage,
  TeamLibraryView,
  UserProfile,
} from '@/schema/teamLibrary';

/** 挂载团队库前必须先有显示名：服务端用它给分享的资产署名。 */
export class ProfileRequiredError extends Error {
  constructor() {
    super('先设置显示名');
    this.name = 'ProfileRequiredError';
  }
}

const base = '/api/team-libraries';
const lib = (id: string) => `${base}/${encodeURIComponent(id)}`;

export function fetchProfile(): Promise<UserProfile> {
  return requestJson<UserProfile>('/api/profile', '读取显示名');
}

export function saveProfile(displayName: string): Promise<UserProfile> {
  return requestJson<UserProfile>('/api/profile', '保存显示名', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ display_name: displayName }),
  });
}

export function listTeamLibraries(projectId: string): Promise<TeamLibraryView[]> {
  return requestJson<TeamLibraryView[]>(
    `${base}?project_id=${encodeURIComponent(projectId)}`,
    '读取团队库',
  );
}

export async function mountTeamLibrary(input: {
  projectId: string;
  path: string;
  name?: string;
}): Promise<TeamLibraryView> {
  const response = await connectionFetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: input.projectId, path: input.path, name: input.name ?? null }),
  });
  if (response.status === 409) {
    const body = await response.clone().json().catch(() => null) as { detail?: { code?: string } } | null;
    if (body?.detail?.code === 'profile_required') throw new ProfileRequiredError();
  }
  if (!response.ok) throw await apiError(response, '挂载团队库');
  return response.json() as Promise<TeamLibraryView>;
}

export async function unmountTeamLibrary(libraryId: string, projectId: string): Promise<void> {
  const response = await connectionFetch(
    `${lib(libraryId)}?project_id=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) throw await apiError(response, '卸载团队库');
}

export function rescanTeamLibrary(libraryId: string): Promise<TeamLibraryView> {
  return requestJson<TeamLibraryView>(`${lib(libraryId)}/rescan`, '重新扫描', { method: 'POST' });
}

export function listTeamAssets(
  libraryId: string,
  filters: {
    kind?: TeamAssetKind;
    author?: string;
    tag?: string;
    q?: string;
    cursor?: string;
  } = {},
): Promise<TeamLibraryAssetPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const query = params.size ? `?${params.toString()}` : '';
  return requestJson<TeamLibraryAssetPage>(`${lib(libraryId)}/assets${query}`, '读取团队资产');
}

export function teamAssetContentUrl(libraryId: string, entryId: string): string {
  return `${lib(libraryId)}/assets/${encodeURIComponent(entryId)}/content`;
}

export function teamAssetThumbUrl(libraryId: string, entryId: string, width: number): string {
  return `${lib(libraryId)}/assets/${encodeURIComponent(entryId)}/thumb?w=${width}`;
}

export function adoptTeamAsset(
  libraryId: string,
  entryId: string,
  projectId?: string,
): Promise<TeamAssetAdoptResponse> {
  return requestJson<TeamAssetAdoptResponse>(
    `${lib(libraryId)}/assets/${encodeURIComponent(entryId)}/adopt`,
    '采用团队资产',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId ?? null }),
    },
  );
}
