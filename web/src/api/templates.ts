import { requestJson } from './http';
import type { CanvasDocument, CanvasPoint } from '@/schema/canvas';

export interface CanvasTemplate {
  id: string;
  name: string;
  node_count: number;
  cover: string | null;
}

const base = '/api/library/templates';
const path = (id: string) => base + '/' + encodeURIComponent(id);
const json = { 'Content-Type': 'application/json' };
export const templateCoverUrl = (id: string) => path(id) + '/cover';
export const listTemplates = () => requestJson<{ items: CanvasTemplate[] }>(base, '读取模板');
export const saveTemplate = (project_id: string, group_id: string, name: string) =>
  requestJson<CanvasTemplate>(base, '存为模板', { method: 'POST', headers: json, body: JSON.stringify({ project_id, group_id, name }) });
export const renameTemplate = (id: string, name: string) =>
  requestJson<CanvasTemplate>(path(id), '重命名模板', { method: 'PATCH', headers: json, body: JSON.stringify({ name }) });
export const duplicateTemplate = (id: string) =>
  requestJson<CanvasTemplate>(path(id) + '/duplicate', '创建副本', { method: 'POST', headers: json });
export const deleteTemplate = (id: string) =>
  requestJson<{ trash_id: string }>(path(id), '删除模板', { method: 'DELETE', headers: json });
export function pasteTemplate(projectId: string, templateId: string, center: CanvasPoint, revision: number) {
  return requestJson<{ group_id: string; document: CanvasDocument }>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/templates/${encodeURIComponent(templateId)}/paste`,
    '添加到画布', { method: 'POST', headers: { ...json, 'If-Match': String(revision) }, body: JSON.stringify(center) },
  );
}
