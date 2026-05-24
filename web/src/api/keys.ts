export interface KeyView {
  alias: string;
  provider: string;
  access_key: string; // masked
  secret_key: null;
  capabilities: string[];
  models: string[];
  notes: string;
  created_at: string;
  is_default: boolean;
}

export interface KeyCreatePayload {
  alias: string;
  provider: string;
  access_key: string;
  secret_key?: string | null;
  capabilities: string[];
  models?: string[];
  notes?: string;
}

export async function listKeys(): Promise<{ keys: KeyView[]; default_alias: string | null }> {
  const r = await fetch('/api/keys');
  if (!r.ok) throw new Error(`listKeys: ${r.status}`);
  return r.json();
}

export async function createKey(payload: KeyCreatePayload): Promise<void> {
  const r = await fetch('/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`createKey ${r.status}: ${body}`);
  }
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
