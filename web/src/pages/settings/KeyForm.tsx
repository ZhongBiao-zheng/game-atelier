import { useState } from 'react';
import { createKey, type KeyCreatePayload, type KeyModel } from '@/api/keys';

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
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? '');
  const [homepage, setHomepage] = useState('');
  const [accessKey, setAccessKey] = useState(initial?.access_key ?? '');
  const [secretKey, setSecretKey] = useState(initial?.secret_key ?? '');
  const [models, setModels] = useState<KeyModel[]>(initial?.models?.length ? initial.models : [{ name: '', id: '' }]);
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
        base_url: provider === 'custom' ? baseUrl.trim() || null : null,
        access_key: accessKey,
        secret_key: secretKey || null,
        capabilities: caps,
        models: models
          .map((model) => ({ name: model.name.trim(), id: model.id.trim() }))
          .filter((model) => model.name && model.id),
        notes: provider === 'custom' && homepage.trim()
          ? `${notes.trim()}\n官网：${homepage.trim()}`.trim()
          : notes,
      });
      onCreated(result.secret_revealed);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5 max-w-2xl">
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
      {provider === 'custom' && (
        <>
          <div>
            <label htmlFor="key-provider-name" className="block text-sm mb-1">供应商名称</label>
            <input
              id="key-provider-name"
              value={alias}
              onChange={e => setAlias(e.target.value)}
              className="w-full border rounded px-3 py-2"
              placeholder="my-image-provider"
            />
          </div>
          <div>
            <label htmlFor="key-homepage" className="block text-sm mb-1">官网链接</label>
            <input
              id="key-homepage"
              value={homepage}
              onChange={e => setHomepage(e.target.value)}
              className="w-full border rounded px-3 py-2"
              placeholder="https://example.com"
              autoComplete="off"
            />
          </div>
          <div>
            <label htmlFor="key-base-url" className="block text-sm mb-1">API 请求地址</label>
            <div className="flex gap-2">
              <input
                id="key-base-url"
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                className="w-full border rounded px-3 py-2"
                placeholder="https://ark.cn-beijing.volces.com/api/v3"
                autoComplete="off"
              />
              <button
                type="button"
                className="shrink-0 px-3 py-2 border rounded text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                测试
              </button>
            </div>
          </div>
        </>
      )}
      <div>
        <label htmlFor="key-access" className="block text-sm mb-1">API Key</label>
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
        <div className="flex items-center justify-between mb-2">
          <span className="block text-sm">模型名称</span>
          <button
            type="button"
            onClick={() => setModels([...models, { name: '', id: '' }])}
            className="text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
          >
            添加模型
          </button>
        </div>
        <div className="space-y-2">
          {models.map((model, index) => (
            <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <label className="sr-only" htmlFor={`key-model-name-${index}`}>模型名称 {index + 1}</label>
              <input
                id={`key-model-name-${index}`}
                aria-label={`模型名称 ${index + 1}`}
                value={model.name}
                onChange={e => setModels(models.map((m, i) => i === index ? { ...m, name: e.target.value } : m))}
                className="w-full border rounded px-3 py-2"
                placeholder="图片 5.0 Lite"
              />
              <label className="sr-only" htmlFor={`key-model-id-${index}`}>模型 ID {index + 1}</label>
              <input
                id={`key-model-id-${index}`}
                aria-label={`模型 ID ${index + 1}`}
                value={model.id}
                onChange={e => setModels(models.map((m, i) => i === index ? { ...m, id: e.target.value } : m))}
                className="w-full border rounded px-3 py-2 font-mono text-sm"
                placeholder="doubao-seedream-5-0-260128"
              />
              <button
                type="button"
                onClick={() => setModels(models.filter((_, i) => i !== index))}
                disabled={models.length === 1}
                aria-label={`删除模型 ${index + 1}`}
                className="px-3 py-2 border rounded text-sm disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                删除
              </button>
            </div>
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
          disabled={!alias || !accessKey || (provider === 'custom' && !baseUrl.trim()) || saving}
          className="px-4 py-2 bg-stone-900 text-white rounded disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {saving ? '保存中...' : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 border rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          取消
        </button>
      </div>
    </div>
  );
}
