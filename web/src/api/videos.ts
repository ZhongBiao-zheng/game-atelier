import { requestJson } from './http';
import type { JobParams, JobStatus } from '@/schema/jobs';

export interface ProjectVideoJobRecord {
  job_id: string;
  submitted_at: string;
  completed_at: string | null;
  status: JobStatus;
  prompt: string;
  model: string;
  params: JobParams;
}

export interface ProjectVideoReferenceCandidate {
  kind: 'character' | 'ui_screen';
  asset_id: string;
  scheme_id: string | null;
  label: string;
  detail: string;
  path: string;
  stale: boolean;
}

export interface ProjectVideoProduction {
  production_id: string;
  title: string;
  type: string;
  status: string;
  brief: {
    goal: string;
    platform: string;
    ratio: string;
    duration: string;
    sound: string;
  };
  prompt: string;
  versions: string[];
  selected: string | null;
  planned_reference_images: string[];
  history: ProjectVideoJobRecord[];
}

export async function fetchProjectVideos(projectId: string): Promise<ProjectVideoProduction[]> {
  const data = await requestJson<{ productions?: unknown }>(
    `/api/projects/${encodeURIComponent(projectId)}/videos`,
    '读取项目视频',
  );
  return Array.isArray(data.productions) ? data.productions as ProjectVideoProduction[] : [];
}

export async function fetchProjectVideoReferences(
  projectId: string,
): Promise<ProjectVideoReferenceCandidate[]> {
  const data = await requestJson<{ candidates?: unknown }>(
    `/api/projects/${encodeURIComponent(projectId)}/video-references`,
    '读取视频参考素材',
  );
  return Array.isArray(data.candidates)
    ? data.candidates as ProjectVideoReferenceCandidate[]
    : [];
}

export async function setProjectVideoReferences(
  projectId: string,
  productionId: string,
  paths: string[],
): Promise<string[]> {
  const data = await requestJson<{ paths: string[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/videos/${encodeURIComponent(productionId)}/references`,
    '保存视频参考素材',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    },
  );
  return data.paths;
}

export async function setProjectVideoSelected(
  projectId: string,
  productionId: string,
  path: string | null,
): Promise<string | null> {
  const data = await requestJson<{ path: string | null }>(
    `/api/projects/${encodeURIComponent(projectId)}/videos/${encodeURIComponent(productionId)}/selected`,
    path ? '选定视频版本' : '取消视频选定',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    },
  );
  return data.path;
}
