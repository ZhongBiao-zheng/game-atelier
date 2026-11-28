import { request, requestJson } from './http';
import type { HistoryItem, HistoryKind } from './history';
import { downloadResponse } from '@/lib/downloadResponse';

export interface LibraryItem {
  id: string; title: string; kind: HistoryKind; created_at: string; revision: number;
  width?: number; height?: number; file: string; text_preview?: string;
}
export interface LibraryFolder { id: string; name: string; item_ids: string[]; parent_id: string | null; system?: string }
export interface LibrarySubject {
  id: string; revision: number; name: string; handle: string; description: string; item_ids: string[]; cover_item_id: string | null;
}
export interface LibraryCatalog { folders: LibraryFolder[]; subjects: LibrarySubject[]; items: Record<string, LibraryItem> }
export const LIBRARY_CHANGED = 'atelier:library-changed';
export const OPEN_FOLDER = 'atelier:library-open';
export function listLibrary(signal?: AbortSignal) {
  return requestJson<LibraryCatalog>('/api/library', '读取素材库', { signal });
}
export const itemUrl = (id: string) => `/api/library/${encodeURIComponent(id)}/content`;
export async function libraryWrite<T>(path: string, value?: unknown, method = 'POST') {
  const result = await requestJson<T>(`/api/library/${path}`, '保存素材库', {
    method, headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value),
  });
  window.dispatchEvent(new Event(LIBRARY_CHANGED));
  return result;
}
export async function uploadItem(owner: string, file: File) {
  const body = new FormData();
  body.append('file', file);
  const item = await requestJson<LibraryItem>(`/api/library/${owner}/upload`, '上传素材', { method: 'POST', body });
  window.dispatchEvent(new Event(LIBRARY_CHANGED));
  return item;
}
export async function downloadLibrary(ids: string[], name: string) {
  if (ids.length === 1 && ids[0].startsWith('itm_')) {
    return downloadResponse(await request(itemUrl(ids[0]) + '?download=true', '下载'), name);
  }
  const response = await request('/api/library/download', '下载', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ids) });
  return downloadResponse(response, name + '.zip');
}
export function itemCard(item: LibraryItem): HistoryItem {
  const url = itemUrl(item.id);
  return { job_id: item.id, output_index: 0, kind: item.kind, submitted_at: item.created_at,
    filename: item.title, prompt: item.title, url, thumbnail_url: url + '?v=' + item.revision,
    width: item.width ?? null, height: item.height ?? null, duration: null, text_preview: item.text_preview ?? null };
}
export function subjectToken(s: Pick<LibrarySubject, 'name' | 'id'>) {
  return `@[subject:${s.id}:${encodeURIComponent(s.name)}]`;
}
