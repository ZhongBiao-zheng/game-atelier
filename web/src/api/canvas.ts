import { request, requestJson } from './http';
import type { Job } from '@/schema/jobs';
import type {
  CanvasDocument,
  CanvasPackageImport,
  CanvasPackageInspection,
  CanvasProject,
  CanvasProjectSummary,
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

export function canvasMediaUrl(
  projectId: string,
  versionId: string,
): string {
  return `/api/canvas/projects/${encodeURIComponent(projectId)}/content/${encodeURIComponent(versionId)}`;
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
