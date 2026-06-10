export type ApiModality = 'image' | 'video' | 'audio' | 'llm' | string;
export type ModelModality = 'image' | 'video';

export interface KeyView {
  alias: string;
  provider: string;
  base_url: string | null;
  access_key: string; // masked
  secret_key: null;
  capabilities: string[];
  models: KeyModel[];
  homepage_url?: string | null;
  docs_url?: string | null;
  api_key_url?: string | null;
  modalities?: ApiModality[];
  notes: string;
  created_at: string;
  is_default: boolean;
}

export interface KeyCreatePayload {
  alias: string;
  provider: string;
  base_url?: string | null;
  access_key: string;
  secret_key?: string | null;
  capabilities: string[];
  models?: KeyModel[];
  homepage_url?: string | null;
  docs_url?: string | null;
  api_key_url?: string | null;
  modalities?: ApiModality[];
  notes?: string;
}

export interface KeyModel {
  name: string;
  id: string;
  /** 模型级图片/视频分类；缺省时按 key 级 modalities 兜底（见 modelModality）。 */
  modality?: ModelModality | null;
}

/** 模型分类的统一判定：模型级标注优先，未标注按 key 级 modalities 兜底
 *（仅声明 video 的 key 视为视频模型，其余一律图片）。 */
export function modelModality(
  model: Pick<KeyModel, 'modality'> | undefined,
  key: { modalities?: ApiModality[] } | undefined,
): ModelModality {
  if (model?.modality) return model.modality;
  const km = key?.modalities ?? [];
  return km.includes('video') && !km.includes('image') ? 'video' : 'image';
}

export async function listKeys(): Promise<{ keys: KeyView[]; default_alias: string | null }> {
  const r = await fetch('/api/keys');
  if (!r.ok) throw new Error(`listKeys: ${r.status}`);
  return r.json();
}

/** Returns the raw access_key for one-time reveal. */
export async function createKey(payload: KeyCreatePayload): Promise<{ secret_revealed: string }> {
  const r = await fetch('/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`createKey ${r.status}: ${body}`);
  }
  return r.json();
}

export async function patchKey(alias: string, patch: Partial<KeyCreatePayload>): Promise<void> {
  const r = await fetch(`/api/keys/${encodeURIComponent(alias)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`patchKey ${r.status}`);
}

export async function deleteKey(alias: string): Promise<void> {
  const r = await fetch(`/api/keys/${encodeURIComponent(alias)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`deleteKey ${r.status}`);
}

export async function setDefaultKey(alias: string): Promise<void> {
  const r = await fetch(`/api/keys/${encodeURIComponent(alias)}/default`, { method: 'POST' });
  if (!r.ok) throw new Error(`setDefault ${r.status}`);
}
