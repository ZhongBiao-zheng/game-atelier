import { request, requestJson } from './http';
import type { Job } from '@/schema/jobs';
import type {
  CanvasDocument,
  CanvasLibraryAsset,
  CanvasMediaOperation,
  CanvasMediaOperationResult,
  CanvasPackageImport,
  CanvasPackageInspection,
  CanvasProject,
  CanvasProjectSummary,
  CanvasPrompt,
  CanvasPoint,
  RevisionedSidecar,
  CanvasRun,
  CanvasTrashEntry,
  CanvasUpload,
} from '@/schema/canvas';

export async function listCanvasProjects(): Promise<CanvasProjectSummary[]> {
  const data = await requestJson<{ projects: CanvasProjectSummary[] }>(
    '/api/canvas/projects',
    '读取画布项目',
  );
  return data.projects;
}

export function createCanvasProject(name: string): Promise<CanvasProject> {
  return requestJson<CanvasProject>('/api/canvas/projects', '创建画布项目', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function renameCanvasProject(projectId: string, name: string): Promise<CanvasProject> {
  return requestJson<CanvasProject>(`/api/canvas/projects/${encodeURIComponent(projectId)}`, '重命名画布项目', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function exportCanvasProjects(projectIds: string[]): Promise<void> {
  const response = await request('/api/canvas/projects/export', '导出画布项目', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_ids: projectIds }),
  });
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  const filename = encodedName
    ? decodeURIComponent(encodedName)
    : plainName ?? '画布项目.game-atelier-canvas.zip';
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function inspectCanvasPackage(file: File): Promise<CanvasPackageInspection> {
  const form = new FormData();
  form.append('file', file);
  return requestJson<CanvasPackageInspection>(
    '/api/canvas/projects/import/inspect',
    '校验 Canvas 项目包',
    { method: 'POST', body: form },
  );
}

export function commitCanvasPackage(token: string): Promise<CanvasPackageImport> {
  return requestJson<CanvasPackageImport>(
    '/api/canvas/projects/import/commit',
    '导入 Canvas 项目包',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    },
  );
}

export function deleteCanvasProject(
  projectId: string,
  expectedRevision: number,
  confirmName: string,
): Promise<CanvasTrashEntry> {
  return requestJson<CanvasTrashEntry>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}`,
    '删除画布项目',
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: expectedRevision, confirm_name: confirmName }),
    },
  );
}

export function restoreCanvasProject(trashId: string): Promise<CanvasProject> {
  return requestJson<CanvasProject>(
    `/api/canvas/trash/${encodeURIComponent(trashId)}/restore`,
    '恢复画布项目',
    { method: 'POST' },
  );
}

export async function listCanvasTrash(): Promise<CanvasTrashEntry[]> {
  const data = await requestJson<{ entries: CanvasTrashEntry[] }>(
    '/api/canvas/trash',
    '读取画布回收区',
  );
  return data.entries;
}

export function getCanvasDocument(projectId: string): Promise<CanvasDocument> {
  return requestJson<CanvasDocument>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/document`,
    '读取画布',
  );
}

export function getCanvasAssets(projectId: string): Promise<RevisionedSidecar<CanvasLibraryAsset>> {
  return requestJson<RevisionedSidecar<CanvasLibraryAsset>>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/library/assets`,
    '读取画布资产库',
  );
}

export function saveCanvasAsset(
  projectId: string,
  versionId: string,
  title: string,
  tags: string[],
  revision: number,
): Promise<RevisionedSidecar<CanvasLibraryAsset>> {
  return requestJson<RevisionedSidecar<CanvasLibraryAsset>>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/library/assets`,
    '保存到画布资产库',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'If-Match': String(revision) },
      body: JSON.stringify({ version_id: versionId, title, tags }),
    },
  );
}

export function updateCanvasAsset(
  projectId: string,
  assetId: string,
  patch: { title?: string; tags?: string[] },
  revision: number,
): Promise<RevisionedSidecar<CanvasLibraryAsset>> {
  return requestJson<RevisionedSidecar<CanvasLibraryAsset>>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/library/assets/${encodeURIComponent(assetId)}`,
    '更新画布资产',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'If-Match': String(revision) },
      body: JSON.stringify(patch),
    },
  );
}

export function deleteCanvasAsset(
  projectId: string,
  assetId: string,
  revision: number,
): Promise<RevisionedSidecar<CanvasLibraryAsset>> {
  return requestJson<RevisionedSidecar<CanvasLibraryAsset>>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/library/assets/${encodeURIComponent(assetId)}`,
    '移出画布资产库',
    { method: 'DELETE', headers: { 'If-Match': String(revision) } },
  );
}

export function insertCanvasAsset(
  projectId: string,
  assetId: string,
  position: CanvasPoint,
  documentRevision: number,
): Promise<CanvasDocument> {
  return requestJson<CanvasDocument>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/library/assets/${encodeURIComponent(assetId)}/insert`,
    '插入画布资产',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'If-Match': String(documentRevision) },
      body: JSON.stringify({ position }),
    },
  );
}

export function getCanvasPrompts(projectId: string): Promise<RevisionedSidecar<CanvasPrompt>> {
  return requestJson<RevisionedSidecar<CanvasPrompt>>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/library/prompts`,
    '读取画布提示词库',
  );
}

export function createCanvasPrompt(
  projectId: string,
  input: { title: string; content: string; tags: string[] },
  revision: number,
): Promise<RevisionedSidecar<CanvasPrompt>> {
  return requestJson<RevisionedSidecar<CanvasPrompt>>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/library/prompts`,
    '新建画布提示词',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'If-Match': String(revision) },
      body: JSON.stringify(input),
    },
  );
}

export function updateCanvasPrompt(
  projectId: string,
  promptId: string,
  patch: { title?: string; content?: string; tags?: string[] },
  revision: number,
): Promise<RevisionedSidecar<CanvasPrompt>> {
  return requestJson<RevisionedSidecar<CanvasPrompt>>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/library/prompts/${encodeURIComponent(promptId)}`,
    '更新画布提示词',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'If-Match': String(revision) },
      body: JSON.stringify(patch),
    },
  );
}

export function deleteCanvasPrompt(
  projectId: string,
  promptId: string,
  revision: number,
): Promise<RevisionedSidecar<CanvasPrompt>> {
  return requestJson<RevisionedSidecar<CanvasPrompt>>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/library/prompts/${encodeURIComponent(promptId)}`,
    '删除画布提示词',
    { method: 'DELETE', headers: { 'If-Match': String(revision) } },
  );
}

export function insertCanvasPrompt(
  projectId: string,
  promptId: string,
  position: CanvasPoint,
  documentRevision: number,
): Promise<CanvasDocument> {
  return requestJson<CanvasDocument>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/library/prompts/${encodeURIComponent(promptId)}/insert`,
    '将提示词插入画布',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'If-Match': String(documentRevision) },
      body: JSON.stringify({ position }),
    },
  );
}

export function saveCanvasDocument(projectId: string, document: CanvasDocument): Promise<CanvasDocument> {
  return requestJson<CanvasDocument>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/document`,
    '保存画布',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'If-Match': String(document.revision) },
      body: JSON.stringify(document),
    },
  );
}

export async function uploadCanvasMedia(
  projectId: string,
  file: File,
  expectedRevision: number,
): Promise<CanvasUpload> {
  const form = new FormData();
  form.append('file', file);
  form.append('expected_revision', String(expectedRevision));
  return requestJson<CanvasUpload>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/uploads`,
    '上传画布资源',
    { method: 'POST', body: form },
  );
}

export async function replaceCanvasNodeMedia(
  projectId: string,
  nodeId: string,
  file: File,
  expectedRevision: number,
): Promise<CanvasUpload> {
  const form = new FormData();
  form.append('file', file);
  form.append('expected_revision', String(expectedRevision));
  return requestJson<CanvasUpload>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/replace`,
    '替换画布媒体',
    { method: 'POST', body: form },
  );
}

export function canvasMediaUrl(
  projectId: string,
  versionId: string,
): string {
  return `/api/canvas/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/media`;
}

export function canvasDownloadUrl(
  projectId: string,
  versionId: string,
): string {
  return `/api/canvas/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/download`;
}

export function runCanvasMediaOperation(
  projectId: string,
  sourceNodeId: string,
  sourceVersionId: string,
  expectedRevision: number,
  operation: CanvasMediaOperation,
): Promise<CanvasMediaOperationResult> {
  return requestJson<CanvasMediaOperationResult>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/media-operations`,
    '处理画布图片',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expected_revision: expectedRevision,
        source_node_id: sourceNodeId,
        source_version_id: sourceVersionId,
        operation,
      }),
    },
  );
}

export function listCanvasJobs(projectId: string): Promise<Job[]> {
  return requestJson<Job[]>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/jobs`,
    '读取画布生成任务',
  );
}

export function submitCanvasRun(
  projectId: string,
  surfaceNodeId: string,
  expectedRevision: number,
  requestedCount: number,
): Promise<CanvasRun> {
  return requestJson<CanvasRun>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/runs`,
    '提交画布生成',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        surface_node_id: surfaceNodeId,
        expected_revision: expectedRevision,
        requested_count: requestedCount,
      }),
    },
  );
}

export function submitCanvasReversePrompt(
  projectId: string,
  surfaceNodeId: string,
  expectedRevision: number,
): Promise<CanvasRun> {
  return requestJson<CanvasRun>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/runs/reverse-prompt`,
    '反推图片提示词',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        surface_node_id: surfaceNodeId,
        expected_revision: expectedRevision,
      }),
    },
  );
}

export function createCanvasReversePromptConfig(
  projectId: string,
  runId: string,
  expectedRevision: number,
): Promise<CanvasDocument> {
  return requestJson<CanvasDocument>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/reverse-prompt-config`,
    '创建反推图片配置',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: expectedRevision }),
    },
  );
}

export function retryCanvasRun(
  projectId: string,
  runId: string,
  mode: 'original' | 'current',
  expectedRevision: number,
  candidateId?: string,
): Promise<CanvasRun> {
  return requestJson<CanvasRun>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/retry`,
    mode === 'original' ? '按原设置重试' : '按当前设置再次生成',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode,
        expected_revision: expectedRevision,
        ...(candidateId ? { candidate_id: candidateId } : {}),
      }),
    },
  );
}

export function cancelCanvasRun(projectId: string, runId: string): Promise<Job> {
  return requestJson<Job>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cancel`,
    '停止画布生成',
    { method: 'POST' },
  );
}
