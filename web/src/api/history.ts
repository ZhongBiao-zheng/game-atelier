import { requestJson } from './http';

export type HistoryKind = 'image' | 'video' | 'audio' | 'text';

export interface HistoryItem {
  job_id: string;
  output_index: number;
  kind: HistoryKind;
  url: string;
  thumbnail_url: string;
  filename: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  text_preview: string | null;
  prompt: string;
  submitted_at: string;
}

export const historyKey = (item: HistoryItem) => `${item.job_id}/${item.output_index}`;

export function listHistory(kind: HistoryKind | 'all', q: string, cursor?: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ kind, q });
  if (cursor) params.set('cursor', cursor);
  return requestJson<{ items: HistoryItem[]; next_cursor: string | null }>(
    `/api/history?${params}`, '读取生成历史', { signal },
  );
}
