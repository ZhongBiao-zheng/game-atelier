import { useState } from 'react';
import { createKey, type KeyCreatePayload } from '@/api/keys';

const PROVIDERS = ['lovart', 'openai', 'midjourney', 'nano_banana', 'seedream', 'custom'];
const CAPABILITIES = ['portrait', 'promo', 'turnaround'];

interface Props {
  initial?: Partial<KeyCreatePayload>;
  /** Called with the raw access_key after successful creation. */
  onCreated: (secret: string) => void;
  onCancel: () => void;
  submitLabel?: string;
}

export function KeyForm({ initial, onCreated, onCancel, submitLabel = '保存' }: Props) {
  const [alias, setAlias] = useState(initial?.alias ?? '');
  const [provider, setProvider] = useState(initial?.provider ?? 'lovart');
  const [accessKey, setAccessKey] = useState(initial?.access_key ?? '');
  const [secretKey, setSecretKey] = useState(initial?.secret_key ?? '');
  const [caps, setCaps] = useState<string[]>(
    initial?.capabilities ?? ['portrait', 'promo', 'turnaround'],
  );
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (c: string) =>
    setCaps(caps.includes(c) ? caps.filter(x => x !== c) : [...caps, c]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await createKey({
        alias,
        provider,
        access_key: accessKey,
        secret_key: secretKey || null,
        capabilities: caps,
        notes,
      });
      onCreated(result.secret_revealed);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 max-w-xl">
      <div>
        <label htmlFor="key-alias" className="block text-sm mb-1">别名（唯一）</label>
        <input
          id="key-alias"
          value={alias}
          onChange={e => setAlias(e.target.value)}
          className="w-full border rounded px-3 py-2"
          placeholder="my-lovart-primary"
        />
      </div>
      <div>
        <label htmlFor="key-provider" className="block text-sm mb-1">Provider</label>
        <select
          id="key-provider"
          value={provider}
          onChange={e => setProvider(e.target.value)}
          className="w-full border rounded px-3 py-2"
        >
          {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="key-access" className="block text-sm mb-1">Access Key</label>
        <input
          id="key-access"
          type="password"
          value={accessKey}
          onChange={e => setAccessKey(e.target.value)}
          className="w-full border rounded px-3 py-2"
          autoComplete="off"
        />
      </div>
      <div>
        <label htmlFor="key-secret" className="block text-sm mb-1">Secret Key（视 provider）</label>
        <input
          id="key-secret"
          type="password"
          value={secretKey ?? ''}
          onChange={e => setSecretKey(e.target.value)}
          className="w-full border rounded px-3 py-2"
          autoComplete="off"
        />
      </div>
      <div>
        <span className="block text-sm mb-1">图种能力</span>
        <div className="flex gap-4">
          {CAPABILITIES.map(c => (
            <label key={c} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={caps.includes(c)}
                onChange={() => toggle(c)}
              />
              {c}
            </label>
          ))}
        </div>
      </div>
      <div>
        <label htmlFor="key-notes" className="block text-sm mb-1">能力描述（自由文本）</label>
        <textarea
          id="key-notes"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          className="w-full border rounded px-3 py-2"
          rows={2}
        />
      </div>
      {error && <div className="text-red-600">{error}</div>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!alias || !accessKey || saving}
          className="px-4 py-2 bg-stone-900 text-white rounded disabled:opacity-50"
        >
          {saving ? '保存中...' : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 border rounded"
        >
          取消
        </button>
      </div>
    </div>
  );
}
