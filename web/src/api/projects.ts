import { requestJson } from '@/api/http';
import type { ProjectsFile } from '@/schema/jobs';

export function fetchProjects(): Promise<ProjectsFile> {
  return requestJson<ProjectsFile>('/api/projects', '读取项目');
}

export function createProject(name: string): Promise<ProjectsFile> {
  return requestJson<ProjectsFile>('/api/projects', `新建项目「${name}」`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function renameProject(projectId: string, name: string): Promise<ProjectsFile> {
  return requestJson<ProjectsFile>(
    `/api/projects/${encodeURIComponent(projectId)}/rename`,
    `把项目改名为「${name}」`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
  );
}

export function deleteProject(projectId: string): Promise<ProjectsFile> {
  return requestJson<ProjectsFile>(
    `/api/projects/${encodeURIComponent(projectId)}`,
    '删除项目',
    { method: 'DELETE' },
  );
}
