import { requestJson } from './http';
import type { Job } from '@/schema/jobs';
import type {
  CanvasDocument,
  CanvasProject,
  CanvasProjectSummary,
  CanvasRun,
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
