import { useState } from 'react';
import { createKey, patchKey, modelModality, type KeyCreatePayload, type KeyModel, type ModelModality } from '@/api/keys';

type ProviderKind = 'official' | 'third_party' | 'custom';
type ApiModality = 'image' | 'video' | 'audio' | 'llm';

interface ProviderPreset {
  value: string;
  label: string;
  kind: ProviderKind;
  modalities: ApiModality[];
  homepageUrl?: string;
  docsUrl?: string;
  apiKeyUrl?: string;
  defaultBaseUrl?: string | null;
  defaultModels: KeyModel[];
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  { value: 'openai', label: 'OpenAI', kind: 'official', modalities: ['image', 'llm'], homepageUrl: 'https://platform.openai.com', docsUrl: 'https://platform.openai.com/docs', apiKeyUrl: 'https://platform.openai.com/api-keys', defaultBaseUrl: 'https://api.openai.com/v1', defaultModels: [{ name: 'GPT Image 1', id: 'gpt-image-1' }] },
  { value: 'seedream', label: '火山引擎', kind: 'official', modalities: ['image'], homepageUrl: 'https://www.volcengine.com', docsUrl: 'https://www.volcengine.com/docs/82379/1399008', apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModels: [{ name: '图片 5.0', id: 'doubao-seedream-5-0-260128' }] },
  { value: 'midjourney', label: 'Midjourney', kind: 'third_party', modalities: ['image'], homepageUrl: 'https://www.midjourney.com', defaultBaseUrl: null, defaultModels: [{ name: 'Midjourney', id: 'midjourney' }] },
  { value: 'nano_banana', label: 'Nano Banana', kind: 'third_party', modalities: ['image'], defaultBaseUrl: null, defaultModels: [{ name: 'Nano Banana', id: 'nano-banana' }, { name: 'Nano Banana HD', id: 'nano-banana-hd' }] },
  { value: 'custom', label: '自定义', kind: 'custom', modalities: ['image'], defaultBaseUrl: '', defaultModels: [{ name: '', id: '' }] },
];

const providerByValue = (value: string) =>
  PROVIDER_PRESETS.find((preset) => preset.value === value) ?? PROVIDER_PRESETS[0];

const usesNamedAlias = (provider: string) => provider === 'custom';

const fieldClass = 'w-full rounded-2xl border border-input/70 bg-background/35 px-4 py-3 text-sm text-foreground shadow-inner shadow-black/5 placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/50';

interface Props {
  initial?: Partial<KeyCreatePayload>;
  /** Called with the raw access_key after successful creation. */
  onCreated: (secret: string) => void;
  onCancel: () => void;
  submitLabel?: string;
  mode?: 'create' | 'edit';
}

export function KeyForm({ initial, onCreated, onCancel, submitLabel = '保存', mode = 'create' }: Props) {
  const [alias, setAlias] = useState(initial?.alias ?? (initial?.provider ? providerByValue(initial.provider).label : 'OpenAI'));
  const [provider, setProvider] = useState(initial?.provider ?? 'openai');
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? '');
  const [homepage, setHomepage] = useState(initial?.homepage_url ?? providerByValue(initial?.provider ?? 'openai').homepageUrl ?? '');
  const [accessKey, setAccessKey] = useState(initial?.access_key ?? '');
  // 编辑旧 Key 时模型可能没标注分类——载入即用 key 级 modalities 兜底值固化进每行，
  // 保存后 key 级 modalities 改为由模型标注派生，老 key 的视频可见性不丢。
  const [models, setModels] = useState<KeyModel[]>(
    initial?.models?.length
      ? initial.models.map((m) => ({ ...m, modality: modelModality(m, initial) }))
      : providerByValue(initial?.provider ?? 'openai').defaultModels,
  );
  const [urlTest, setUrlTest] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = mode === 'edit';

  const changeProvider = (nextProvider: string) => {
    const preset = providerByValue(nextProvider);
    setProvider(nextProvider);
    setAlias(usesNamedAlias(nextProvider) ? '' : preset.label);
    setBaseUrl(preset.defaultBaseUrl ?? '');
    setHomepage(preset.homepageUrl ?? '');
    setModels(preset.defaultModels);
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
      const preset = providerByValue(provider);
      const cleanModels = models
        .map((model) => ({ name: model.name.trim(), id: model.id.trim(), modality: model.modality ?? 'image' as ModelModality }))
        .filter((model) => model.name && model.id);
      // key 级 modalities 由模型标注派生（key 级仅作摘要/兜底），preset 的 llm 等附加能力保留。
      const derivedModalities = Array.from(new Set([
        ...preset.modalities.filter((m) => m !== 'image' && m !== 'video'),
        ...cleanModels.map((m) => m.modality),
      ]));
      const payload: KeyCreatePayload = {
        alias: usesNamedAlias(provider) ? alias.trim() : provider,
        provider,
        base_url: baseUrl.trim() || null,
        access_key: accessKey.trim(),
        secret_key: null,
        capabilities: ['portrait', 'promo', 'turnaround'],
        models: cleanModels,
        homepage_url: homepage.trim() || preset.homepageUrl || null,
        docs_url: preset.docsUrl ?? null,
        api_key_url: preset.apiKeyUrl ?? null,
        modalities: derivedModalities,
        notes: '',
      };
      if (editing && initial?.alias) {
        const patch: Partial<KeyCreatePayload> = {
          base_url: payload.base_url,
          access_key: payload.access_key,
          secret_key: payload.secret_key,
          capabilities: payload.capabilities,
          models: payload.models,
          homepage_url: payload.homepage_url,
          docs_url: payload.docs_url,
          api_key_url: payload.api_key_url,
          modalities: payload.modalities,
          notes: payload.notes,
        };
        if (!accessKey.trim() || accessKey === initial.access_key) delete patch.access_key;
        await patchKey(initial.alias, patch);
        onCreated('');
      } else {
        const result = await createKey(payload);
        onCreated(result.secret_revealed);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const canSubmit = Boolean(
    (editing || accessKey.trim())
    && (!usesNamedAlias(provider) || alias.trim())
    && (provider !== 'custom' || baseUrl.trim())
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
            disabled={editing}
          >
            {PROVIDER_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        {provider === 'custom' && (
          <>
            <div>
              <label htmlFor="key-provider-name" className="block text-sm mb-2 text-muted-foreground">配置名称</label>
              <input
                id="key-provider-name"
                value={alias}
                onChange={e => setAlias(e.target.value)}
                className={fieldClass}
                placeholder="例如：openrouter-image-main"
                readOnly={editing}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                自定义供应商可以创建多个配置，请用不同配置名称区分额度、用途或上游。
              </p>
            </div>
            <div>
              <label htmlFor="key-homepage" className="block text-sm mb-2 text-muted-foreground">官网链接</label>
              <input
                id="key-homepage"
                value={homepage}
                onChange={e => setHomepage(e.target.value)}
                className={fieldClass}
                placeholder="例如：https://platform.openai.com"
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
                  placeholder="例如：https://ark.cn-beijing.volces.com/api/v3"
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
              <p className="mt-2 text-xs text-muted-foreground">
                请求时会自动拼接图片接口；根域名会补 /v1/images/generations，填完整路径也会直接使用。
              </p>
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
            className={`${fieldClass} font-mono`}
            placeholder={editing ? '留空或保持原值表示不修改密钥' : '粘贴 API Key，例如 sk-...'}
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
          <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 text-xs text-muted-foreground mb-2">
            <span>模型别名</span>
            <span>模型 ID</span>
            <span>分类</span>
            <span className="sr-only">操作</span>
          </div>
          <div className="space-y-2">
            {models.map((model, index) => (
              <div key={index} className="grid grid-cols-[1fr_1fr_auto_auto] gap-2">
                <label className="sr-only" htmlFor={`key-model-name-${index}`}>模型名称 {index + 1}</label>
                <input
                  id={`key-model-name-${index}`}
                  aria-label={`模型名称 ${index + 1}`}
                  value={model.name}
                  onChange={e => setModels(models.map((m, i) => i === index ? { ...m, name: e.target.value } : m))}
                  className={fieldClass}
                  placeholder="给人看的名字，例如：图片 5.0"
                />
                <label className="sr-only" htmlFor={`key-model-id-${index}`}>模型 ID {index + 1}</label>
                <input
                  id={`key-model-id-${index}`}
                  aria-label={`模型 ID ${index + 1}`}
                  value={model.id}
                  onChange={e => setModels(models.map((m, i) => i === index ? { ...m, id: e.target.value } : m))}
                  className={`${fieldClass} font-mono`}
                  placeholder="请求里使用的 ID，例如：doubao-seedream-5-0-260128"
                />
                <label className="sr-only" htmlFor={`key-model-modality-${index}`}>模型分类 {index + 1}</label>
                <select
                  id={`key-model-modality-${index}`}
                  aria-label={`模型分类 ${index + 1}`}
                  value={model.modality ?? 'image'}
                  onChange={e => setModels(models.map((m, i) => i === index ? { ...m, modality: e.target.value as ModelModality } : m))}
                  className={`${fieldClass} w-auto`}
                >
                  <option value="image">图片</option>
                  <option value="video">视频</option>
                </select>
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
