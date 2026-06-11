import { useState } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { createKey, patchKey, modelModality, previewModels, type KeyCreatePayload, type KeyModel, type ModelModality, type RemoteModel } from '@/api/keys';

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
  { value: 'tokendance', label: '词元跳动', kind: 'official', modalities: ['image', 'video'], homepageUrl: 'https://tokendance.space', docsUrl: 'https://tokendance.space/docs/quickstart', apiKeyUrl: 'https://tokendance.space/keys', defaultBaseUrl: 'https://tokendance.space/gateway/v1', defaultModels: [{ name: 'Seedream 5.0 Lite', id: 'seedream-5.0-lite', modality: 'image' }, { name: 'Seedance 2.0', id: 'seedance-2.0', modality: 'video' }] },
  { value: 'custom', label: '自定义', kind: 'custom', modalities: ['image'], defaultBaseUrl: '', defaultModels: [{ name: '', id: '' }] },
];

const KIND_LABELS: Record<ProviderKind, string> = {
  official: '官方',
  third_party: '第三方',
  custom: '自定义',
};

const providerByValue = (value: string) =>
  PROVIDER_PRESETS.find((preset) => preset.value === value) ?? PROVIDER_PRESETS[0];

const usesNamedAlias = (provider: string) => provider === 'custom';

const fieldClass = 'w-full rounded-md border border-input bg-background/35 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/50';
const capLabelClass = 'block text-xs uppercase tracking-label text-muted-foreground/70 mb-2';
const ghostButtonClass = 'rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

type PickerFilter = 'all' | 'image' | 'video' | 'other';

interface Props {
  initial?: Partial<KeyCreatePayload>;
  onCreated: () => void;
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
  const [fetched, setFetched] = useState<RemoteModel[] | null>(null);
  const [fetchedChecked, setFetchedChecked] = useState<Set<string>>(new Set());
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [pickerFilter, setPickerFilter] = useState<PickerFilter>('all');
  const [pickerQuery, setPickerQuery] = useState('');
  const editing = mode === 'edit';
  const preset = providerByValue(provider);

  const changeProvider = (nextProvider: string) => {
    if (editing) return;
    const nextPreset = providerByValue(nextProvider);
    setProvider(nextProvider);
    setAlias(usesNamedAlias(nextProvider) ? '' : nextPreset.label);
    setBaseUrl(nextPreset.defaultBaseUrl ?? '');
    setHomepage(nextPreset.homepageUrl ?? '');
    setModels(nextPreset.defaultModels);
    setUrlTest(null);
    setFetched(null);
    setFetchError(null);
  };

  // 模型映射：服务端代理拉上游 /models（CORS + 编辑态前端只有掩码密钥，见 models-preview）。
  const fetchModelsBaseUrl = baseUrl.trim() || providerByValue(provider).defaultBaseUrl || '';
  const fetchModels = async () => {
    setFetching(true);
    setFetchError(null);
    try {
      // 编辑态密钥框是掩码回显，未改动就不当真实密钥发，改由服务端按 alias 取存储密钥。
      const keyChanged = accessKey.trim() && accessKey !== initial?.access_key;
      const { models: remote } = await previewModels({
        alias: editing ? initial?.alias ?? null : null,
        base_url: fetchModelsBaseUrl || null,
        access_key: !editing || keyChanged ? accessKey.trim() || null : null,
      });
      const order = (m: RemoteModel) => (m.modality === 'image' ? 0 : m.modality === 'video' ? 1 : 2);
      const sorted = [...remote].sort((a, b) => order(a) - order(b));
      const enabledIds = new Set(models.map((m) => m.id.trim()).filter(Boolean));
      setPickerFilter('all');
      setPickerQuery('');
      setFetched(sorted);
      setFetchedChecked(new Set(sorted.filter((m) => enabledIds.has(m.id)).map((m) => m.id)));
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  };

  /** 勾选状态同步回模型行：新勾的加入、列表内被取消勾选的移除、手填且不在列表的不动。 */
  const applyFetchedSelection = () => {
    if (!fetched) return;
    const fetchedIds = new Set(fetched.map((m) => m.id));
    const kept = models.filter((m) => !fetchedIds.has(m.id.trim()) || fetchedChecked.has(m.id.trim()));
    const keptIds = new Set(kept.map((m) => m.id.trim()));
    const added = fetched
      .filter((m) => fetchedChecked.has(m.id) && !keptIds.has(m.id))
      .map((m) => ({ name: m.name, id: m.id, modality: m.modality ?? 'image' as ModelModality }));
    const next = [...kept, ...added];
    setModels(next.length ? next : [{ name: '', id: '' }]);
    setFetched(null);
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
      } else {
        await createKey(payload);
      }
      onCreated();
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

  const pickerCounts = (filter: PickerFilter) => {
    if (!fetched) return 0;
    if (filter === 'all') return fetched.length;
    if (filter === 'other') return fetched.filter((m) => !m.modality).length;
    return fetched.filter((m) => m.modality === filter).length;
  };

  const pickerVisible = (fetched ?? []).filter((m) => {
    if (pickerFilter === 'image' || pickerFilter === 'video') {
      if (m.modality !== pickerFilter) return false;
    } else if (pickerFilter === 'other' && m.modality) {
      return false;
    }
    const q = pickerQuery.trim().toLowerCase();
    return !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
  });

  const linkRow = [
    preset.homepageUrl ? { label: '官网', url: preset.homepageUrl } : null,
    preset.docsUrl ? { label: '文档', url: preset.docsUrl } : null,
    preset.apiKeyUrl ? { label: '获取 Key', url: preset.apiKeyUrl } : null,
  ].filter((l): l is { label: string; url: string } => l !== null);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={editing ? '编辑供应商' : '新增供应商'}
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-glass p-4"
      onClick={() => { if (!saving) onCancel(); }}
    >
      {fetched ? (
        /* —— 模型选择子视图：独占整个弹窗，列表拿全高，brass 只有「启用所选」一处 —— */
        <div
          className="flex h-[min(640px,86vh)] w-[860px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-card"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="space-y-3 px-6 pb-3 pt-5">
            <button
              type="button"
              onClick={() => setFetched(null)}
              className="inline-flex items-center gap-1.5 rounded-md py-1 pr-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <ArrowLeft size={14} aria-hidden />
              返回表单
            </button>
            <div className="truncate font-mono text-xs text-muted-foreground">
              GET {fetchModelsBaseUrl}/models · {fetched.length} 个模型
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(['all', 'image', 'video', 'other'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setPickerFilter(f)}
                  className={`rounded-full px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    pickerFilter === f
                      ? 'bg-secondary text-foreground ring-1 ring-primary/60'
                      : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                  }`}
                >
                  {f === 'all' ? '全部' : f === 'image' ? '图片' : f === 'video' ? '视频' : '其他'} {pickerCounts(f)}
                </button>
              ))}
              <input
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder="搜索模型名或 ID"
                aria-label="搜索模型"
                className={`${fieldClass} ml-auto w-56`}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto border-t border-border px-3 py-2">
            {pickerVisible.map((m) => (
              <label
                key={m.id}
                className={`flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 ${
                  fetchedChecked.has(m.id) ? 'bg-secondary/40' : 'hover:bg-secondary/60'
                }`}
              >
                <input
                  type="checkbox"
                  checked={fetchedChecked.has(m.id)}
                  onChange={(e) => {
                    const next = new Set(fetchedChecked);
                    if (e.target.checked) next.add(m.id); else next.delete(m.id);
                    setFetchedChecked(next);
                  }}
                  className="shrink-0 accent-primary"
                />
                <span className="min-w-0 truncate text-sm text-foreground">{m.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{m.id}</span>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${
                    m.modality === 'image'
                      ? 'border-primary/40 text-primary'
                      : m.modality === 'video'
                        ? 'border-border text-foreground'
                        : 'border-border text-muted-foreground'
                  }`}
                >
                  {m.modality === 'image' ? '图片' : m.modality === 'video' ? '视频' : '其他'}
                </span>
              </label>
            ))}
            {pickerVisible.length === 0 && (
              <div className="px-2 py-8 text-center text-sm text-muted-foreground">没有匹配的模型</div>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-border px-6 py-3">
            <span className="text-xs text-muted-foreground">已选 {fetchedChecked.size} 个模型</span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setFetched(null)} className={ghostButtonClass}>
                取消
              </button>
              <button
                type="button"
                onClick={applyFetchedSelection}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                启用所选（{fetchedChecked.size}）
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* —— 表单主视图：左轨供应商选项列表（不透明 popover 轨道），右 pane 字段 —— */
        <div
          className="grid max-h-[86vh] w-[860px] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-card md:grid-cols-[240px_1fr]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 左轨在 md 以下隐藏，由 body 顶部的下拉兜底（同一 changeProvider 路径） */}
          <div className="hidden flex-col gap-1 overflow-y-auto border-r border-border bg-popover p-3 md:flex" role="group" aria-label="供应商列表">
            <div className="px-3 pb-1 pt-2 text-xs uppercase tracking-label text-muted-foreground/70">供应商</div>
            {PROVIDER_PRESETS.map((p) => {
              const selected = provider === p.value;
              return (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => changeProvider(p.value)}
                  disabled={editing && !selected}
                  aria-pressed={selected}
                  className={`flex items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40 ${
                    selected
                      ? 'bg-secondary text-foreground ring-1 ring-primary/60'
                      : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                  }`}
                >
                  <span className="truncate">{p.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground/70">{KIND_LABELS[p.kind]}</span>
                </button>
              );
            })}
          </div>
          <div className="flex min-h-0 flex-col">
            <div className="flex items-start justify-between gap-4 px-6 pb-4 pt-5">
              <div className="min-w-0 space-y-1">
                <h2 className="font-display italic text-base text-foreground">
                  {editing ? '编辑供应商' : '新增供应商'}
                </h2>
                {linkRow.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                    {linkRow.map((l) => (
                      <a key={l.label} href={l.url} target="_blank" rel="noreferrer" className="hover:text-primary">
                        {l.label} ↗
                      </a>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={onCancel}
                aria-label="关闭"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-5">
              <div className="md:hidden">
                <label htmlFor="key-provider" className={capLabelClass}>供应商选择</label>
                <select
                  id="key-provider"
                  value={provider}
                  onChange={(e) => changeProvider(e.target.value)}
                  className={fieldClass}
                  disabled={editing}
                >
                  {PROVIDER_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              {provider === 'custom' && (
                <>
                  <div>
                    <label htmlFor="key-provider-name" className={capLabelClass}>配置名称</label>
                    <input
                      id="key-provider-name"
                      value={alias}
                      onChange={(e) => setAlias(e.target.value)}
                      className={fieldClass}
                      placeholder="例如：openrouter-image-main"
                      readOnly={editing}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      自定义供应商可以创建多个配置，请用不同配置名称区分额度、用途或上游。
                    </p>
                  </div>
                  <div>
                    <label htmlFor="key-homepage" className={capLabelClass}>官网链接</label>
                    <input
                      id="key-homepage"
                      value={homepage}
                      onChange={(e) => setHomepage(e.target.value)}
                      className={fieldClass}
                      placeholder="例如：https://platform.openai.com"
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <label htmlFor="key-base-url" className={capLabelClass}>API 请求地址</label>
                    <div className="flex gap-2">
                      <input
                        id="key-base-url"
                        value={baseUrl}
                        onChange={(e) => {
                          setBaseUrl(e.target.value);
                          setUrlTest(null);
                        }}
                        className={fieldClass}
                        placeholder="例如：https://ark.cn-beijing.volces.com/api/v3"
                        autoComplete="off"
                      />
                      <button type="button" onClick={testBaseUrl} className={`${ghostButtonClass} shrink-0`}>
                        测试
                      </button>
                    </div>
                    {urlTest && (
                      <div className={`mt-2 flex items-center gap-2 text-sm ${urlTest.kind === 'ok' ? 'text-muted-foreground' : 'text-destructive'}`}>
                        {urlTest.kind === 'ok' && (
                          <span className="size-1.5 rounded-full bg-[color:var(--status-done)]" aria-hidden />
                        )}
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
                <label htmlFor="key-access" className={capLabelClass}>API Key</label>
                <input
                  id="key-access"
                  type="password"
                  value={accessKey}
                  onChange={(e) => setAccessKey(e.target.value)}
                  className={`${fieldClass} font-mono`}
                  placeholder={editing ? '留空或保持原值表示不修改密钥' : '粘贴 API Key，例如 sk-...'}
                  autoComplete="off"
                />
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className={`${capLabelClass} mb-0`}>模型</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={fetchModels}
                      disabled={!fetchModelsBaseUrl || fetching}
                      className={ghostButtonClass}
                    >
                      {fetching ? '获取中...' : '获取模型列表'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setModels([...models, { name: '', id: '' }])}
                      className={ghostButtonClass}
                    >
                      添加模型
                    </button>
                  </div>
                </div>
                {fetchError && <div className="mb-2 text-sm text-destructive">{fetchError}</div>}
                <div className="mb-2 grid grid-cols-[1fr_1fr_auto_auto] gap-2 text-xs text-muted-foreground">
                  <span>模型别名</span>
                  <span>模型 ID</span>
                  <span>分类</span>
                  <span className="sr-only">操作</span>
                </div>
                <div className="space-y-2">
                  {models.map((model, index) => (
                    <div key={index} className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2">
                      <label className="sr-only" htmlFor={`key-model-name-${index}`}>模型名称 {index + 1}</label>
                      <input
                        id={`key-model-name-${index}`}
                        aria-label={`模型名称 ${index + 1}`}
                        value={model.name}
                        onChange={(e) => setModels(models.map((m, i) => i === index ? { ...m, name: e.target.value } : m))}
                        className={fieldClass}
                        placeholder="给人看的名字，例如：图片 5.0"
                      />
                      <label className="sr-only" htmlFor={`key-model-id-${index}`}>模型 ID {index + 1}</label>
                      <input
                        id={`key-model-id-${index}`}
                        aria-label={`模型 ID ${index + 1}`}
                        value={model.id}
                        onChange={(e) => setModels(models.map((m, i) => i === index ? { ...m, id: e.target.value } : m))}
                        className={`${fieldClass} font-mono`}
                        placeholder="请求里使用的 ID，例如：doubao-seedream-5-0-260128"
                      />
                      <div
                        role="group"
                        aria-label={`模型分类 ${index + 1}`}
                        className="flex items-center rounded-md border border-border p-0.5"
                      >
                        {(['image', 'video'] as const).map((mod) => {
                          const active = (model.modality ?? 'image') === mod;
                          return (
                            <button
                              key={mod}
                              type="button"
                              aria-pressed={active}
                              onClick={() => setModels(models.map((m, i) => i === index ? { ...m, modality: mod } : m))}
                              className={`rounded-sm px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                                active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              {mod === 'image' ? '图片' : '视频'}
                            </button>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        onClick={() => setModels(models.filter((_, i) => i !== index))}
                        disabled={models.length === 1}
                        aria-label={`删除模型 ${index + 1}`}
                        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-destructive disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                      >
                        <X size={14} aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 border-t border-border px-6 py-4">
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {saving ? '保存中...' : submitLabel}
              </button>
              <button type="button" onClick={onCancel} className={ghostButtonClass}>
                取消
              </button>
              {error && <div className="min-w-0 truncate text-sm text-destructive">{error}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
