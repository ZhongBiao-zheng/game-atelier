import { requestJson } from './http';

export type ProjectFolderItemKind = 'character' | 'ui_scheme' | 'ui_screen' | 'video_production';

export interface ProjectFolderItem {
  kind: ProjectFolderItemKind;
  asset_id: string;
  scheme_id?: string | null;
}

export interface ProjectFolder {
  id: string;
  name: string;
  note: string;
  created_at: string;
  items: ProjectFolderItem[];
}

export interface ProjectFoldersFile {
  folders: ProjectFolder[];
}

const changedEvent = 'atelier:project-folders-changed';

function base(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/folders`;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function notifyProjectFoldersChanged(projectId: string): void {
  window.dispatchEvent(new CustomEvent(changedEvent, { detail: projectId }));
}

export function listenForProjectFoldersChanged(
  projectId: string,
  listener: () => void,
): () => void {
  const handler = (event: Event) => {
    if ((event as CustomEvent<string>).detail === projectId) listener();
  };
  window.addEventListener(changedEvent, handler);
  return () => window.removeEventListener(changedEvent, handler);
}

export async function fetchProjectFolders(projectId: string): Promise<ProjectFoldersFile> {
  const data = await requestJson<{ folders?: unknown }>(base(projectId), '读取项目文件夹');
  return { folders: Array.isArray(data.folders) ? data.folders as ProjectFolder[] : [] };
}

export function createProjectFolder(
  projectId: string,
  name: string,
  note = '',
): Promise<ProjectFoldersFile> {
  return requestJson(base(projectId), '新建项目文件夹', jsonInit('POST', { name, note }));
}

export function updateProjectFolder(
  projectId: string,
  folderId: string,
  name: string,
  note: string,
): Promise<ProjectFoldersFile> {
  return requestJson(
    `${base(projectId)}/${encodeURIComponent(folderId)}`,
    '保存项目文件夹',
    jsonInit('POST', { name, note }),
  );
}

export function reorderProjectFolders(
  projectId: string,
  orderedIds: string[],
): Promise<ProjectFoldersFile> {
  return requestJson(
    `${base(projectId)}/reorder`,
    '调整项目文件夹顺序',
    jsonInit('POST', { ordered_ids: orderedIds }),
  );
}

export function deleteProjectFolder(
  projectId: string,
  folderId: string,
): Promise<ProjectFoldersFile> {
  return requestJson(
    `${base(projectId)}/${encodeURIComponent(folderId)}`,
    '删除项目文件夹',
    { method: 'DELETE' },
  );
}

export function addProjectFolderItem(
  projectId: string,
  folderId: string,
  item: ProjectFolderItem,
): Promise<ProjectFoldersFile> {
  return requestJson(
    `${base(projectId)}/${encodeURIComponent(folderId)}/items`,
    '加入文件夹',
    jsonInit('POST', item),
  );
}

export function removeProjectFolderItem(
  projectId: string,
  folderId: string,
  item: ProjectFolderItem,
): Promise<ProjectFoldersFile> {
  const query = new URLSearchParams({ kind: item.kind, asset_id: item.asset_id });
  if (item.scheme_id) query.set('scheme_id', item.scheme_id);
  return requestJson(
    `${base(projectId)}/${encodeURIComponent(folderId)}/items?${query}`,
    '从文件夹移除',
    { method: 'DELETE' },
  );
}
