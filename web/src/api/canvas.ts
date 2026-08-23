import { requestJson } from './http';
import type { Job, JobKind, JobParams } from '@/schema/jobs';
import type {
  CanvasDocument,
  CanvasProject,
  CanvasProjectSummary,
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(document),
    },
  );
}

export async function uploadCanvasMedia(projectId: string, file: File): Promise<CanvasUpload> {
  const form = new FormData();
  form.append('file', file);
  return requestJson<CanvasUpload>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/uploads`,
    '上传画布资源',
    { method: 'POST', body: form },
  );
}

export function canvasMediaUrl(
  projectId: string,
  source: { path: string; job_id?: string | null },
): string {
  const query = new URLSearchParams({ path: source.path });
  if (source.job_id) query.set('job_id', source.job_id);
  return `/api/canvas/projects/${encodeURIComponent(projectId)}/media?${query.toString()}`;
}

export function createCanvasJob(
  projectId: string,
  body: { prompt: string; model: string; params: JobParams; alias?: string; kind?: JobKind },
): Promise<Job> {
  return requestJson<Job>(`/api/canvas/projects/${encodeURIComponent(projectId)}/jobs`, '创建画布生成任务', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function listCanvasJobs(projectId: string): Promise<Job[]> {
  return requestJson<Job[]>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/jobs`,
    '读取画布生成任务',
  );
}
