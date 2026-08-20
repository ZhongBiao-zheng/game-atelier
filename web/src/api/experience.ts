import { request, requestJson } from './http';
// web/src/api/experience.ts
export interface ProjectExperience {
  project: { id: string; slug: string; name: string; created_at: string; character_count: number };
  worldview_md: string;
}

export async function fetchExperience(projectId: string): Promise<ProjectExperience> {
  return requestJson<ProjectExperience>(
    `/api/experience?project=${encodeURIComponent(projectId)}`,
    '读取项目世界观',
  );
}

export async function saveExperience(projectId: string, worldviewMd: string): Promise<void> {
  await request('/api/experience', '保存项目世界观', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: projectId, worldview_md: worldviewMd }),
  });
}
