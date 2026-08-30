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

export async function updateImageCreationAsset(
  assetId: string,
  input: { title: string; tags: string[]; file?: File },
): Promise<CreationAsset> {
  const form = new FormData();
  form.append('title', input.title);
  form.append('tags', JSON.stringify(input.tags));
  if (input.file) form.append('file', input.file);
  let response: Response;
  try {
    response = await fetch(
      `/api/creation-assets/${encodeURIComponent(assetId)}/image`,
      { method: 'PUT', body: form },
    );
  } catch (error) {
    throw new Error(`编辑图片资产失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 409) {
    const body = await response.clone().json().catch(() => null) as {
      detail?: { code?: string; asset_id?: string };
    } | null;
    if (body?.detail?.code === 'duplicate_asset' && body.detail.asset_id) {
      throw new DuplicateCreationAssetError(body.detail.asset_id);
    }
  }
  if (!response.ok) throw await apiError(response, '编辑图片资产');
  return response.json() as Promise<CreationAsset>;
}

export async function deleteCreationAsset(assetId: string): Promise<void> {
  const response = await fetch(`/api/creation-assets/${encodeURIComponent(assetId)}`, {
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

export function creationAssetImageUrl(assetId: string): string {
  return `/api/creation-assets/${encodeURIComponent(assetId)}/content`;
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
