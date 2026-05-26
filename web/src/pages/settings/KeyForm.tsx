import { useState } from 'react';
import { createKey, type KeyCreatePayload, type KeyModel } from '@/api/keys';

const PROVIDERS = [
  { value: 'lovart', label: 'Lovart' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'midjourney', label: 'Midjourney' },
  { value: 'nano_banana', label: 'Nano Banana' },
  { value: 'seedream', label: 'Seedream' },
  { value: 'custom', label: '自定义' },
];

const DEFAULT_MODELS: Record<string, KeyModel[]> = {
  lovart: [{ name: 'GPT Image 2', id: 'gpt-image-2' }],
  openai: [{ name: 'GPT Image 2', id: 'gpt-image-2' }],
  midjourney: [{ name: 'Midjourney', id: 'midjourney' }],
  nano_banana: [{ name: 'Nano Banana', id: 'nano-banana' }],
  seedream: [{ name: 'Seedream', id: 'doubao-seedream-5-0-260128' }],
  custom: [{ name: '', id: '' }],
};

const fieldClass = 'w-full rounded-2xl border border-input/80 bg-background/40 px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/60';

interface Props {
  initial?: Partial<KeyCreatePayload>;
  /** Called with the raw access_key after successful creation. */
  onCreated: (secret: string) => void;
  onCancel: () => void;
  submitLabel?: string;
}

export function KeyForm({ initial, onCreated, onCancel, submitLabel = '保存' }: Props) {
  const [alias, setAlias] = useState(initial?.alias ?? initial?.provider ?? 'lovart');
  const [provider, setProvider] = useState(initial?.provider ?? 'lovart');
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? '');
  const [homepage, setHomepage] = useState('');
  const [accessKey, setAccessKey] = useState(initial?.access_key ?? '');
  const [models, setModels] = useState<KeyModel[]>(initial?.models?.length ? initial.models : DEFAULT_MODELS[initial?.provider ?? 'lovart']);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [urlTest, setUrlTest] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeProvider = (nextProvider: string) => {
    setProvider(nextProvider);
    setAlias(nextProvider === 'custom' ? '' : nextProvider);
    setModels(DEFAULT_MODELS[nextProvider] ?? [{ name: '', id: '' }]);
    setUrlTest(null);
  };

  const testBaseUrl = () => {
    try {
      const parsed = new URL(baseUrl.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
      setUrlTest({ kind: 'ok', message: '地址格式可用' });
    } catch {
      setUrlTest({ kind: 'error', message: '请输入完整的 HTTP(S) API 请求地址' });
    }
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const cleanNotes = notes.trim();
      const cleanHomepage = homepage.trim();
      const result = await createKey({
        alias: provider === 'custom' ? alias.trim() : provider,
        provider,
        base_url: provider === 'custom' ? baseUrl.trim() || null : null,
        access_key: accessKey,
        secret_key: null,
        capabilities: ['portrait', 'promo', 'turnaround'],
        models: models
          .map((model) => ({ name: model.name.trim(), id: model.id.trim() }))
          .filter((model) => model.name && model.id),
        notes: provider === 'custom' && cleanHomepage
          ? `${cleanNotes}\n官网：${cleanHomepage}`.trim()
          : cleanNotes,
      });
      onCreated(result.secret_revealed);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const canSubmit = Boolean(
    accessKey.trim()
    && (provider !== 'custom' || (alias.trim() && baseUrl.trim()))
    && !saving,
  );

  return (
    <div className="max-w-[780px] mx-auto rounded-[2rem] border border-input/80 bg-card/80 p-4 sm:p-6 shadow-2xl shadow-black/20 backdrop-blur-xl">
      <div className="space-y-5">
        <div>
          <label htmlFor="key-provider" className="block text-sm mb-2 text-muted-foreground">供应商选择</label>
          <select
            id="key-provider"
            value={provider}
            onChange={e => changeProvider(e.target.value)}
            className={fieldClass}
          >
            {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        {provider === 'custom' && (
          <>
            <div>
              <label htmlFor="key-provider-name" className="block text-sm mb-2 text-muted-foreground">供应商名称</label>
              <input
                id="key-provider-name"
                value={alias}
                onChange={e => setAlias(e.target.value)}
                className={fieldClass}
                placeholder="my-image-provider"
              />
            </div>
            <div>
              <label htmlFor="key-notes" className="block text-sm mb-2 text-muted-foreground">备注</label>
              <textarea
                id="key-notes"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className={`${fieldClass} resize-none`}
                rows={2}
                placeholder="用途、额度、支持能力..."
              />
            </div>
            <div>
              <label htmlFor="key-homepage" className="block text-sm mb-2 text-muted-foreground">官网链接</label>
              <input
                id="key-homepage"
                value={homepage}
                onChange={e => setHomepage(e.target.value)}
                className={fieldClass}
                placeholder="https://example.com"
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="key-base-url" className="block text-sm mb-2 text-muted-foreground">API 请求地址</label>
              <div className="flex gap-2">
                <input
                  id="key-base-url"
                  value={baseUrl}
                  onChange={e => {
                    setBaseUrl(e.target.value);
                    setUrlTest(null);
                  }}
                  className={fieldClass}
                  placeholder="https://ark.cn-beijing.volces.com/api/v3"
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={testBaseUrl}
                  className="shrink-0 rounded-2xl border border-border bg-background/30 px-4 py-3 text-sm text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  测试
                </button>
              </div>
              {urlTest && (
                <div className={`mt-2 text-sm ${urlTest.kind === 'ok' ? 'text-emerald-600' : 'text-destructive'}`}>
                  {urlTest.message}
                </div>
              )}
            </div>
          </>
        )}
        <div>
          <label htmlFor="key-access" className="block text-sm mb-2 text-muted-foreground">API Key</label>
          <input
            id="key-access"
            type="password"
            value={accessKey}
            onChange={e => setAccessKey(e.target.value)}
            className={fieldClass}
            autoComplete="off"
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="block text-sm text-muted-foreground">模型</span>
            <button
              type="button"
              onClick={() => setModels([...models, { name: '', id: '' }])}
              className="rounded-xl border border-border bg-background/30 px-3 py-2 text-sm text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
                  className={fieldClass}
                  placeholder="图片 5.0 Lite"
                />
                <label className="sr-only" htmlFor={`key-model-id-${index}`}>模型 ID {index + 1}</label>
                <input
                  id={`key-model-id-${index}`}
                  aria-label={`模型 ID ${index + 1}`}
                  value={model.id}
                  onChange={e => setModels(models.map((m, i) => i === index ? { ...m, id: e.target.value } : m))}
                  className={`${fieldClass} font-mono`}
                  placeholder="doubao-seedream-5-0-260128"
                />
                <button
                  type="button"
                  onClick={() => setModels(models.filter((_, i) => i !== index))}
                  disabled={models.length === 1}
                  aria-label={`删除模型 ${index + 1}`}
                  className="rounded-2xl border border-border bg-background/30 px-3 py-2 text-sm disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        </div>
        {error && <div className="text-red-600">{error}</div>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-2xl bg-primary px-5 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {saving ? '保存中...' : submitLabel}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-2xl border border-border bg-background/30 px-5 py-3 text-sm hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
