import { connectionFetch, mediaUrl } from '@/api/connection';
import { apiError, requestError, requestJson } from './http';
import type {
  TeamAssetAdoptResponse,
  TeamAssetKind,
  TeamLibraryAssetPage,
  TeamLibraryIndexEntry,
  TeamLibraryView,
  TeamRelatedEntry,
  TeamShareRequest,
  UserProfile,
} from '@/schema/teamLibrary';

/** 挂载团队库前必须先有显示名：服务端用它给分享的资产署名。 */
export class ProfileRequiredError extends Error {
  constructor() {
    super('先设置显示名');
    this.name = 'ProfileRequiredError';
  }
}

/** 参考内容合计超过服务端阈值；带 `allow_large: true` 重发才会写入。 */
export class TeamRefsTooLargeError extends Error {
  readonly bytes: number;

  constructor(bytes: number) {
    super(`参考内容共 ${Math.round(bytes / 1024 / 1024)} MB`);
    this.name = 'TeamRefsTooLargeError';
    this.bytes = bytes;
  }
}

/** 团队库里只有作者本人能编辑或撤回自己分享的资产。 */
export class TeamNotAuthorError extends Error {
  constructor() {
    super('只有作者能修改');
    this.name = 'TeamNotAuthorError';
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

/** 省略 projectId = 本机全部挂载（按库去重）。 */
export function listTeamLibraries(projectId?: string): Promise<TeamLibraryView[]> {
  const query = projectId !== undefined ? `?project_id=${encodeURIComponent(projectId)}` : '';
  return requestJson<TeamLibraryView[]>(`${base}${query}`, '读取团队库');
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

/** 媒体地址经 mediaUrl：托管页面要拼本机地址与媒体令牌（`<img>` / `<video>` 带不了 Authorization）。 */
export function teamAssetContentUrl(libraryId: string, entryId: string): string {
  return mediaUrl(`${lib(libraryId)}/assets/${encodeURIComponent(entryId)}/content`);
}

export function teamAssetThumbUrl(libraryId: string, entryId: string, width: number): string {
  return mediaUrl(`${lib(libraryId)}/assets/${encodeURIComponent(entryId)}/thumb?w=${width}`);
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

async function errorCode(response: Response): Promise<{ code?: string; bytes?: number } | null> {
  const body = await response.clone().json().catch(() => null) as {
    detail?: { code?: string; bytes?: number };
  } | null;
  return body?.detail ?? null;
}

/** 与 requestJson 同款兜底：响应体不是 JSON 时给中文报错，而不是抛 SyntaxError。 */
async function readJson<T>(response: Response, what: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`${what}失败：服务端返回的不是合法 JSON（HTTP ${response.status}）`);
  }
}

/** 分享 / 编辑 / 撤回共用的错误映射：先认稳定错误码，其余走通用中文报错。 */
async function teamWrite(url: string, what: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await connectionFetch(url, init);
  } catch (error) {
    throw requestError(error, what);
  }
  if (response.ok) return response;
  const detail = await errorCode(response);
  if (response.status === 409 && detail?.code === 'profile_required') throw new ProfileRequiredError();
  if (response.status === 413 && detail?.code === 'refs_too_large' && typeof detail.bytes === 'number') {
    throw new TeamRefsTooLargeError(detail.bytes);
  }
  if (response.status === 403 && detail?.code === 'not_author') throw new TeamNotAuthorError();
  throw await apiError(response, what);
}

export async function shareToTeamLibrary(
  libraryId: string,
  request: TeamShareRequest,
): Promise<TeamLibraryIndexEntry> {
  const response = await teamWrite(`${lib(libraryId)}/share`, '分享到团队库', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  return readJson<TeamLibraryIndexEntry>(response, '分享到团队库');
}

export async function updateTeamAsset(
  libraryId: string,
  assetId: string,
  body: { title: string; tags: string[] },
): Promise<TeamLibraryIndexEntry> {
  const response = await teamWrite(`${lib(libraryId)}/assets/${encodeURIComponent(assetId)}`, '编辑团队资产', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJson<TeamLibraryIndexEntry>(response, '编辑团队资产');
}

export async function withdrawTeamAsset(libraryId: string, assetId: string): Promise<void> {
  await teamWrite(`${lib(libraryId)}/assets/${encodeURIComponent(assetId)}`, '撤回团队资产', {
    method: 'DELETE',
  });
}

/** 给了 sha256 = 参考内容命中这份内容的配方（跨该画布全部可达库）；否则按画布项目列相关配方。 */
export function listRelatedTeamAssets(projectId: string, sha256?: string): Promise<TeamRelatedEntry[]> {
  const params = new URLSearchParams({ project_id: projectId });
  if (sha256) params.set('sha256', sha256);
  return requestJson<TeamRelatedEntry[]>(`${base}/related?${params.toString()}`, '读取相关配方');
}
