import { apiError, requestJson } from './http';
import type {
  CreationAsset,
  CreationAssetKind,
  CreationAssetList,
  CreationPromptSegment,
} from '@/schema/creationAssets';
import type { CanvasDocument, CanvasPoint } from '@/schema/canvas';

export class DuplicateCreationAssetError extends Error {
  readonly assetId: string;

  constructor(assetId: string) {
    super('这张图片已经在资产库中');
    this.name = 'DuplicateCreationAssetError';
    this.assetId = assetId;
  }
}

export function listCreationAssets(options: {
  kind?: CreationAssetKind;
  scope?: 'all' | 'project';
  projectId?: string;
  archived?: boolean;
} = {}): Promise<CreationAssetList> {
  const params = new URLSearchParams();
  if (options.kind) params.set('kind', options.kind);
  if (options.scope) params.set('scope', options.scope);
  if (options.projectId) params.set('project_id', options.projectId);
  if (options.archived) params.set('archived', 'true');
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

export async function uploadImageCreationAsset(input: {
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
    response = await fetch('/api/creation-assets/images/upload', { method: 'POST', body: form });
  } catch (error) {
    throw new Error(`保存图片资产失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 409) {
    const body = await response.clone().json().catch(() => null) as {
      detail?: { code?: string; asset_id?: string };
    } | null;
    if (body?.detail?.code === 'duplicate_asset' && body.detail.asset_id) {
      throw new DuplicateCreationAssetError(body.detail.asset_id);
    }
  }
  if (!response.ok) throw await apiError(response, '保存图片资产');
  return response.json() as Promise<CreationAsset>;
}

export async function saveImageCreationAssetFromPath(input: {
  sourcePath: string;
  title: string;
  tags: string[];
  projectId?: string;
  allowExisting?: boolean;
}): Promise<CreationAsset> {
  let response: Response;
  try {
    response = await fetch('/api/creation-assets/images/from-path', {
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
    throw new Error(`保存图片资产失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 409) {
    const body = await response.clone().json().catch(() => null) as {
      detail?: { code?: string; asset_id?: string };
    } | null;
    if (body?.detail?.code === 'duplicate_asset' && body.detail.asset_id) {
      throw new DuplicateCreationAssetError(body.detail.asset_id);
    }
  }
  if (!response.ok) throw await apiError(response, '保存图片资产');
  return response.json() as Promise<CreationAsset>;
}

export function updateCreationAssetMetadata(
  assetId: string,
  patch: { title?: string; tags?: string[] },
): Promise<CreationAsset> {
  return requestJson<CreationAsset>(
    `/api/creation-assets/${encodeURIComponent(assetId)}`,
    '更新创作资产',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    },
  );
}

export function createPromptCreationAssetVersion(
  assetId: string,
  segments: CreationPromptSegment[],
): Promise<CreationAsset> {
  return requestJson<CreationAsset>(
    `/api/creation-assets/${encodeURIComponent(assetId)}/versions/prompt`,
    '保存提示词新版本',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ segments }),
    },
  );
}

export async function createImageCreationAssetVersion(
  assetId: string,
  file: File,
): Promise<CreationAsset> {
  const form = new FormData();
  form.append('file', file);
  let response: Response;
  try {
    response = await fetch(
      `/api/creation-assets/${encodeURIComponent(assetId)}/versions/image`,
      { method: 'POST', body: form },
    );
  } catch (error) {
    throw new Error(`保存图片新版本失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 409) {
    const body = await response.clone().json().catch(() => null) as {
      detail?: { code?: string; asset_id?: string };
    } | null;
    if (body?.detail?.code === 'duplicate_asset' && body.detail.asset_id) {
      throw new DuplicateCreationAssetError(body.detail.asset_id);
    }
  }
  if (!response.ok) throw await apiError(response, '保存图片新版本');
  return response.json() as Promise<CreationAsset>;
}

export function archiveCreationAsset(assetId: string): Promise<CreationAsset> {
  return requestJson<CreationAsset>(
    `/api/creation-assets/${encodeURIComponent(assetId)}/archive`,
    '归档创作资产',
    { method: 'POST' },
  );
}

export function restoreCreationAsset(assetId: string): Promise<CreationAsset> {
  return requestJson<CreationAsset>(
    `/api/creation-assets/${encodeURIComponent(assetId)}/restore`,
    '恢复创作资产',
    { method: 'POST' },
  );
}

export function restoreCreationAssetVersion(
  assetId: string,
  versionId: string,
): Promise<CreationAsset> {
  return requestJson<CreationAsset>(
    `/api/creation-assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(versionId)}/restore`,
    '恢复资产版本',
    { method: 'POST' },
  );
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

export function removeCreationAssetFromProject(
  assetId: string,
  projectId: string,
): Promise<CreationAsset> {
  return requestJson<CreationAsset>(
    `/api/creation-assets/${encodeURIComponent(assetId)}/projects/${encodeURIComponent(projectId)}`,
    '移出本项目',
    { method: 'DELETE' },
  );
}

export function creationAssetImageUrl(assetId: string, versionId: string): string {
  return `/api/creation-assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(versionId)}/content`;
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

export function updateCreationAssetReferencesInCanvas(input: {
  projectId: string;
  assetId: string;
  nodeId: string;
  scope: 'current' | 'all';
  documentRevision: number;
}): Promise<CanvasDocument> {
  return requestJson<CanvasDocument>(
    `/api/canvas/projects/${encodeURIComponent(input.projectId)}/creation-assets/${encodeURIComponent(input.assetId)}/update-references`,
    '更新画布中的创作资产引用',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'If-Match': String(input.documentRevision),
      },
      body: JSON.stringify({ node_id: input.nodeId, scope: input.scope }),
    },
  );
}
