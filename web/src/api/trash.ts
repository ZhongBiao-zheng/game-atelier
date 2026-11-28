import { requestJson } from '@/api/http';

/** 回收站条目类型 — 与 lib/trash.py `TrashKind` 同步。 */
export type TrashKind = 'project' | 'conversation' | 'round' | 'template';

export interface TrashEntry {
  trash_id: string;
  kind: TrashKind;
  label: string;
  deleted_at: string;
  expires_at: string;
  days_left: number;
  /** 移入时调用方附带的信息（如 project_id），还原后用来跳转或刷新。 */
  meta: Record<string, unknown>;
}

export const TRASH_KIND_LABEL: Record<TrashKind, string> = {
  project: '项目',
  conversation: '对话',
  round: '生成结果',
  template: '模板',
};

export async function listTrash(): Promise<TrashEntry[]> {
  const body = await requestJson<{ items?: unknown }>('/api/trash', '读取回收站');
  return Array.isArray(body.items) ? (body.items as TrashEntry[]) : [];
}

/** 还原到原位置；原位置被占用时抛 409（ApiError.reason 说明是哪一项）。 */
export async function restoreTrash(trashId: string): Promise<TrashEntry> {
  return requestJson<TrashEntry>(`/api/trash/${encodeURIComponent(trashId)}/restore`, '还原', { method: 'POST' });
}

/** 彻底删除一项，不可恢复。 */
export async function purgeTrash(trashId: string): Promise<void> {
  await requestJson(`/api/trash/${encodeURIComponent(trashId)}`, '彻底删除', { method: 'DELETE' });
}

/** 清空回收站，返回删掉的条目数。 */
export async function emptyTrash(): Promise<number> {
  const body = await requestJson<{ purged?: number }>('/api/trash', '清空回收站', { method: 'DELETE' });
  return body.purged ?? 0;
}
