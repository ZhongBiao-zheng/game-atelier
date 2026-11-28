import { downloadResponse } from '@/lib/downloadResponse';
import { request, requestJson } from './http';

export type HistoryKind = 'image' | 'video' | 'audio' | 'text';

export interface HistoryItem {
  job_id: string;
  output_index: number;
  kind: HistoryKind;
  url: string;
  thumbnail_url: string;
  filename: string;
  title?: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  text_preview: string | null;
  prompt: string;
  submitted_at: string;
}

export interface HistoryReference {
  kind: HistoryKind;
  read: () => Promise<File>;
}

export const historyKey = (item: HistoryItem) => `${item.job_id}/${item.output_index}`;

export function listHistory(kind: HistoryKind | 'all', q: string, cursor?: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ kind, q });
  if (cursor) params.set('cursor', cursor);
  return requestJson<{ items: HistoryItem[]; next_cursor: string | null }>(
    `/api/history?${params}`, '读取生成历史', { signal },
  );
}

export async function downloadHistory(items: HistoryItem[]) {
  const response = await request('/api/history/download', '下载', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(items.map(({ job_id, output_index }) => ({ job_id, output_index }))),
  });
  await downloadResponse(response, items.length === 1 ? items[0].filename : 'history.zip');
}

export function deleteHistoryOutputs(id: string, slots: number[]) {
  return requestJson<{ trash_id: string }>(`/api/history/${encodeURIComponent(id)}`, '删除', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(slots),
  });
}

export const HISTORY_CHANGED = 'atelier:history-changed';
