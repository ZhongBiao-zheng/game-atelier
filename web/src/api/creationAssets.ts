import { connectionFetch } from '@/api/connection';
import { apiError, ApiError, requestJson } from './http';
import type {
  CreationAsset,
  CreationAssetKind,
  CreationAssetList,
  CreationAssetStaleness,
  CreationGenerationFromCanvas,
  CreationGenerationFromJob,
  CreationPromptSegment,
} from '@/schema/creationAssets';
import type { CanvasDocument, CanvasPoint } from '@/schema/canvas';

export type { CreationAssetStaleness };

/** 服务端一次最多查 200 条（CreationAssetStalenessBatchRequest.asset_ids 上限）。 */
const STALENESS_BATCH_LIMIT = 200;

/** 团队库里的来源已被作者撤回，重新采用无从谈起。 */
export class TeamSourceWithdrawnError extends Error {
  constructor() {
    super('来源已撤回');
    this.name = 'TeamSourceWithdrawnError';
  }
}

export class DuplicateCreationAssetError extends Error {
  readonly assetId: string;

  constructor(assetId: string) {
    super('这个文件已经在资产库中');
    this.name = 'DuplicateCreationAssetError';
    this.assetId = assetId;
  }
}

export function listCreationAssets(options: {
  kind?: CreationAssetKind;
  scope?: 'all' | 'project';
  projectId?: string;
} = {}): Promise<CreationAssetList> {
  const params = new URLSearchParams();
  if (options.kind) params.set('kind', options.kind);
  if (options.scope) params.set('scope', options.scope);
  if (options.projectId) params.set('project_id', options.projectId);
  const query = params.size ? `?${params.toString()}` : '';
  return requestJson<CreationAssetList>(`/api/creation-assets${query}`, '读取创作资产');
}

export function createPromptCreationAsset(input: {
  title: string;
  segments: CreationPromptSegment[];
  tags: string[];
  projectId?: string;
}): Promise<CreationAsset> {
  return requestJson<CreationAsset>('/api/creation-assets/prompts', '保存提示词资产', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: input.title,
      segments: input.segments,
      tags: input.tags,
      project_id: input.projectId,
    }),
  });
}

export async function uploadMediaCreationAsset(input: {
  file: File;
  title: string;
  tags: string[];
  projectId?: string;
  allowExisting?: boolean;
}): Promise<CreationAsset> {
  const form = new FormData();
  form.append('file', input.file);
  form.append('title', input.title);
  form.append('tags', JSON.stringify(input.tags));
  if (input.projectId) form.append('project_id', input.projectId);
  if (input.allowExisting) form.append('allow_existing', 'true');
  let response: Response;
  try {
    response = await connectionFetch('/api/creation-assets/media/upload', { method: 'POST', body: form });
  } catch (error) {
    throw new Error(`保存媒体资产失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 409) {
    const body = await response.clone().json().catch(() => null) as {
      detail?: { code?: string; asset_id?: string };
    } | null;
    if (body?.detail?.code === 'duplicate_asset' && body.detail.asset_id) {
      throw new DuplicateCreationAssetError(body.detail.asset_id);
    }
  }
  if (!response.ok) throw await apiError(response, '保存媒体资产');
  return response.json() as Promise<CreationAsset>;
}

export async function saveMediaCreationAssetFromPath(input: {
  sourcePath: string;
  title: string;
  tags: string[];
  projectId?: string;
  allowExisting?: boolean;
}): Promise<CreationAsset> {
  let response: Response;
  try {
    response = await connectionFetch('/api/creation-assets/media/from-path', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: input.title,
        source_path: input.sourcePath,
        tags: input.tags,
        project_id: input.projectId,
        allow_existing: Boolean(input.allowExisting),
      }),
    });
  } catch (error) {
    throw new Error(`保存媒体资产失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 409) {
    const body = await response.clone().json().catch(() => null) as {
      detail?: { code?: string; asset_id?: string };
    } | null;
    if (body?.detail?.code === 'duplicate_asset' && body.detail.asset_id) {
      throw new DuplicateCreationAssetError(body.detail.asset_id);
    }
  }
  if (!response.ok) throw await apiError(response, '保存媒体资产');
  return response.json() as Promise<CreationAsset>;
}

export function updatePromptCreationAsset(
  assetId: string,
  input: { title: string; segments: CreationPromptSegment[]; tags: string[] },
): Promise<CreationAsset> {
  return requestJson<CreationAsset>(
    `/api/creation-assets/${encodeURIComponent(assetId)}/prompt`,
    '编辑提示词资产',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

export async function updateMediaCreationAsset(
  assetId: string,
  input: { title: string; tags: string[]; file?: File },
): Promise<CreationAsset> {
  const form = new FormData();
  form.append('title', input.title);
  form.append('tags', JSON.stringify(input.tags));
  if (input.file) form.append('file', input.file);
  let response: Response;
  try {
    response = await connectionFetch(
      `/api/creation-assets/${encodeURIComponent(assetId)}/media`,
      { method: 'PUT', body: form },
    );
  } catch (error) {
    throw new Error(`编辑媒体资产失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 409) {
    const body = await response.clone().json().catch(() => null) as {
      detail?: { code?: string; asset_id?: string };
    } | null;
    if (body?.detail?.code === 'duplicate_asset' && body.detail.asset_id) {
      throw new DuplicateCreationAssetError(body.detail.asset_id);
    }
  }
  if (!response.ok) throw await apiError(response, '编辑媒体资产');
  return response.json() as Promise<CreationAsset>;
}

export async function deleteCreationAsset(assetId: string): Promise<void> {
  const response = await connectionFetch(`/api/creation-assets/${encodeURIComponent(assetId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw await apiError(response, '删除创作资产');
}

export function markCreationAssetUsed(
  assetId: string,
  projectId?: string,
): Promise<CreationAsset> {
  return requestJson<CreationAsset>(
    `/api/creation-assets/${encodeURIComponent(assetId)}/use`,
    '使用创作资产',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId }),
    },
  );
}

export function creationAssetMediaUrl(assetId: string): string {
  return `/api/creation-assets/${encodeURIComponent(assetId)}/content`;
}

/** 生成资产冻结快照里第 order 份参考内容。 */
export function creationAssetInputUrl(assetId: string, order: number): string {
  return `/api/creation-assets/${encodeURIComponent(assetId)}/inputs/${order}`;
}

export async function fetchCreationAssetStaleness(assetId: string): Promise<CreationAssetStaleness> {
  const body = await requestJson<{ status: CreationAssetStaleness }>(
    `/api/creation-assets/${encodeURIComponent(assetId)}/staleness`,
    '检查资产是否过时',
  );
  return body.status;
}

/** 批量查采用来的资产是否过时；不存在的 id 不出现在结果里。 */
export async function fetchCreationAssetStalenessBatch(
  assetIds: string[],
): Promise<Record<string, CreationAssetStaleness>> {
  const chunks: string[][] = [];
  for (let start = 0; start < assetIds.length; start += STALENESS_BATCH_LIMIT) {
    chunks.push(assetIds.slice(start, start + STALENESS_BATCH_LIMIT));
  }
  const results = await Promise.all(chunks.map(ids => requestJson<{
    statuses: Record<string, CreationAssetStaleness>;
  }>('/api/creation-assets/staleness', '检查资产是否过时', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ asset_ids: ids }),
  })));
  return Object.assign({}, ...results.map(result => result.statuses));
}

/** 用团队库来源的当前版本覆盖本机副本（内容、快照、标题、标签都跟来源走）。 */
export async function readoptCreationAsset(assetId: string): Promise<CreationAsset> {
  try {
    return await requestJson<CreationAsset>(
      `/api/creation-assets/${encodeURIComponent(assetId)}/readopt`,
      '重新采用',
      { method: 'POST' },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.code === 'withdrawn') {
      throw new TeamSourceWithdrawnError();
    }
    throw error;
  }
}

/** 生成结果存成带配方的生成资产（Studio 出图）。 */
export function saveGenerationFromJob(body: CreationGenerationFromJob): Promise<CreationAsset> {
  return requestJson<CreationAsset>('/api/creation-assets/generation/from-job', '保存生成资产', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 生成结果存成带配方的生成资产（画布节点版本）。 */
export function saveGenerationFromCanvas(body: CreationGenerationFromCanvas): Promise<CreationAsset> {
  return requestJson<CreationAsset>('/api/creation-assets/generation/from-canvas', '保存生成资产', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function insertCreationAssetIntoCanvas(input: {
  projectId: string;
  assetId: string;
  position: CanvasPoint;
  documentRevision: number;
  variableValues?: Record<string, string>;
  targetNodeId?: string;
}): Promise<CanvasDocument> {
  return requestJson<CanvasDocument>(
    `/api/canvas/projects/${encodeURIComponent(input.projectId)}/creation-assets/${encodeURIComponent(input.assetId)}/insert`,
    '将创作资产插入画布',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'If-Match': String(input.documentRevision),
      },
      body: JSON.stringify({
        position: input.position,
        variable_values: input.variableValues ?? {},
        target_node_id: input.targetNodeId,
      }),
    },
  );
}
