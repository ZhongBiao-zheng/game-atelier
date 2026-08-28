import { useState } from 'react';
import { ArrowLeft, Eye, EyeOff, X } from 'lucide-react';
import { createKey, patchKey, modelModality, previewModels, revealKey, type KeyCreatePayload, type KeyModel, type ModelCategory, type ModelInputModality, type ModelModality, type ModelsPreview, type RemoteModel } from '@/api/keys';

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
  { value: 'openai', label: 'OpenAI', kind: 'official', modalities: ['image', 'llm'], homepageUrl: 'https://platform.openai.com', docsUrl: 'https://platform.openai.com/docs', apiKeyUrl: 'https://platform.openai.com/api-keys', defaultBaseUrl: 'https://api.openai.com/v1', defaultModels: [{ name: 'GPT Image 1', id: 'gpt-image-1' }, { name: 'GPT 5', id: 'gpt-5', modality: 'text', protocol: 'openai-responses', input_modalities: ['text'] }] },
  { value: 'seedream', label: '火山引擎', kind: 'official', modalities: ['image', 'llm'], homepageUrl: 'https://www.volcengine.com', docsUrl: 'https://www.volcengine.com/docs/82379/1399008', apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModels: [{ name: '图片 5.0', id: 'doubao-seedream-5-0-260128' }, { name: '豆包 Seed 1.8', id: 'doubao-seed-1-8-251228', modality: 'text', protocol: 'openai-chat', input_modalities: ['text'] }] },
  { value: 'tokendance', label: '词元跳动', kind: 'official', modalities: ['image', 'video'], homepageUrl: 'https://tokendance.space', docsUrl: 'https://tokendance.space/docs/quickstart', apiKeyUrl: 'https://tokendance.space/keys', defaultBaseUrl: 'https://tokendance.space/gateway/v1', defaultModels: [{ name: 'Seedream 5.0 Lite', id: 'seedream-5.0-lite', modality: 'image', protocol: 'openai' }, { name: 'Seedream 5.0 Pro', id: 'seedream-5.0-pro', modality: 'image', protocol: 'ark' }, { name: 'Seedance 2.0', id: 'seedance-2.0', modality: 'video', protocol: 'seedance' }] },
  { value: 'openrouter', label: 'OpenRouter', kind: 'official', modalities: ['image', 'video'], homepageUrl: 'https://openrouter.ai', docsUrl: 'https://openrouter.ai/docs/quickstart', apiKeyUrl: 'https://openrouter.ai/settings/keys', defaultBaseUrl: 'https://openrouter.ai/api/v1', defaultModels: [{ name: 'GPT Image 2', id: 'openai/gpt-image-2', modality: 'image' }, { name: 'Google: Veo 3.1', id: 'google/veo-3.1', modality: 'video' }] },
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
// 次要文本操作（全选 / 清空 / 显示全部）：不占黄铜，也不做成方块按钮抢主操作的戏。
const textActionClass = 'rounded-sm text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-40 disabled:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

type PickerFilter = 'all' | ModelCategory;

// 「未识别」不是「其他垃圾」——上游协议词汇各厂自造、词表追不完，认不出的条目要画师自己确认。
const CATEGORY_LABELS: Record<ModelCategory, string> = {
  text: '对话',
  image: '图片',
  video: '视频',
  audio: '音频',
  unknown: '未识别',
  excluded: '不可生成',
};

const GENERATION_MODALITIES = ['text', 'image', 'video', 'audio'] as const;
const TEXT_INPUT_MODALITIES = [
  ['image', '图片'],
  ['video', '视频'],
  ['audio', '音频'],
] as const;

// 仅前端的行级标记：编辑态「打开表单时已存在的模型」分类锁死为只读，新增行不带此标记。
// _locked 随 spread 在每次 setModels 中传递，增删行都不会错乱（不依赖 id 值或行下标）。
type EditableModel = KeyModel & { _locked?: boolean };

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
  const [billingGroup, setBillingGroup] = useState(initial?.billing_group ?? '');
  const [homepage, setHomepage] = useState(initial?.homepage_url ?? providerByValue(initial?.provider ?? 'openai').homepageUrl ?? '');
  const [accessKey, setAccessKey] = useState(initial?.access_key ?? '');
  // 编辑旧 Key 时模型可能没标注分类——载入即用 key 级 modalities 兜底值固化进每行，
  // 保存后 key 级 modalities 改为由模型标注派生，老 key 的视频可见性不丢。
  // 编辑态打开时已存在的行打 _locked，分类锁死为只读；新增行不带标记，仍可选分类。
  const [models, setModels] = useState<EditableModel[]>(
    initial?.models?.length
      ? initial.models.map((m) => ({ ...m, modality: modelModality(m, initial), _locked: mode === 'edit' }))
      : providerByValue(initial?.provider ?? 'openai').defaultModels,
  );
  const [urlTest, setUrlTest] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // preview 存整份响应（models + total + excluded），头部才能诚实说清「上游多少、过滤了多少」。
  const [preview, setPreview] = useState<(ModelsPreview & { includeAll: boolean }) | null>(null);
  const [fetchedChecked, setFetchedChecked] = useState<Set<string>>(new Set());
  // 上游没判出分类的行（unknown / excluded）在 picker 里的显式二选一结果，按模型 id 存。
  const [modalityPick, setModalityPick] = useState<Record<string, ModelModality>>({});
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [pickerFilter, setPickerFilter] = useState<PickerFilter>('all');
  const [pickerQuery, setPickerQuery] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [revealing, setRevealing] = useState(false);
  // 编辑态打开时密钥框是掩码（前端只有掩码）；create 态字段值即用户实输的真值。
  const [keyRevealed, setKeyRevealed] = useState(mode !== 'edit');
  const editing = mode === 'edit';
  const preset = providerByValue(provider);
  const isLocked = (model: EditableModel) => model._locked === true;

  const changeProvider = (nextProvider: string) => {
    if (editing) return;
    const nextPreset = providerByValue(nextProvider);
    setProvider(nextProvider);
    setAlias(usesNamedAlias(nextProvider) ? '' : nextPreset.label);
    setBaseUrl(nextPreset.defaultBaseUrl ?? '');
    setBillingGroup('');
    setHomepage(nextPreset.homepageUrl ?? '');
    setModels(nextPreset.defaultModels);
    setUrlTest(null);
    setPreview(null);
    setModalityPick({});
    setFetchError(null);
  };

  // 模型映射：服务端代理拉上游 /models（CORS + 编辑态前端只有掩码密钥，见 models-preview）。
  const fetchModelsBaseUrl = baseUrl.trim() || providerByValue(provider).defaultBaseUrl || '';
  /** includeAll = 逃生舱重拉：把后端判定「不可生成」的条目也一并列出来。 */
  const fetchModels = async (includeAll = false) => {
    setFetching(true);
    setFetchError(null);
    try {
      // 编辑态密钥框是掩码回显，未改动就不当真实密钥发，改由服务端按 alias 取存储密钥。
      const keyChanged = accessKey.trim() && accessKey !== initial?.access_key;
      const remote = await previewModels({
        alias: editing ? initial?.alias ?? null : null,
        provider: provider || null,
        base_url: fetchModelsBaseUrl || null,
        access_key: !editing || keyChanged ? accessKey.trim() || null : null,
        include_all: includeAll,
      });
      const order = (m: RemoteModel) => ['text', 'image', 'video', 'audio', 'unknown', 'excluded'].indexOf(m.category);
      const sorted = [...remote.models].sort((a, b) => order(a) - order(b));
      const enabledIds = new Set(models.map((m) => m.id.trim()).filter(Boolean));
      // 逃生舱重拉发生在 picker 内部：已勾选的和已指定的分类都要留着，否则「看一眼全量」
      // 的代价是把刚点完的十几个勾全清掉。首次打开（preview 为 null）只按已启用模型预勾。
      const carried = preview ? [...fetchedChecked] : [];
      const enabledPicks = Object.fromEntries(
        models.filter((m) => m.id.trim() && m.modality).map((m) => [m.id.trim(), m.modality as ModelModality]),
      );
      setPickerFilter('all');
      setPickerQuery('');
      setPreview({ ...remote, models: sorted, includeAll });
      setFetchedChecked(new Set(
        sorted.filter((m) => enabledIds.has(m.id) || carried.includes(m.id)).map((m) => m.id),
      ));
      setModalityPick({ ...enabledPicks, ...(preview ? modalityPick : {}) });
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  };

  /** 上游没判出分类的行必须由画师明确二选一——静默按图片处理会让一个聊天模型以图片模型
   *  身份进 Studio 图片下拉，出图时把它的 id 发给 /images/generations。 */
  const resolvedModality = (m: RemoteModel): ModelModality | null => m.modality ?? modalityPick[m.id] ?? null;
  const unresolvedChecked = (preview?.models ?? []).filter((m) => fetchedChecked.has(m.id) && !resolvedModality(m));

  /** 勾选状态同步回模型行：新勾的加入、列表内被取消勾选的移除、手填且不在列表的不动。 */
  const applyFetchedSelection = () => {
    if (!preview || unresolvedChecked.length) return; // 按钮已禁用，这里是双保险
    const upstream = new Map(preview.models.map((m) => [m.id, m]));
    const kept = models
      .filter((m) => !upstream.has(m.id.trim()) || fetchedChecked.has(m.id.trim()))
      .map((m) => {
        const hit = upstream.get(m.id.trim());
        if (!hit) return m;
        return {
          ...m,
          // 「重拉一次列表来修协议」必须真的有效：protocol 是纯机器字段（表单里没有输入口），
          // 命中上游就用上游值覆盖，否则存错 / 存空的行永远修不回来。
          protocol: hit.protocol,
          input_modalities: hit.input_modalities,
          // name 有输入框、可能被改成自己的叫法，只在空着或还等于 id 时补上游名。
          name: !m.name.trim() || m.name.trim() === m.id.trim() ? hit.name : m.name,
          // 分类归表单管（编辑态已存行是只读徽标）；只有未识别行的显式二选一才回写。
          modality: !m._locked && !hit.modality && modalityPick[hit.id] ? modalityPick[hit.id] : m.modality,
        };
      });
    const keptIds = new Set(kept.map((m) => m.id.trim()));
    const added = preview.models
      .filter((m) => fetchedChecked.has(m.id) && !keptIds.has(m.id))
      // protocol 必须随模型一起存：它是上游协议标注的解析结果（图片 ark/openai、视频
      // seedance/kling/…），丢了就得靠 caller 端启发式猜端点。
      .map((m) => ({ name: m.name, id: m.id, modality: resolvedModality(m) as ModelModality, protocol: m.protocol, input_modalities: m.input_modalities }));
    const next = [...kept, ...added];
    setModels(next.length ? next : [{ name: '', id: '' }]);
    setPreview(null);
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

  const toggleShowKey = async () => {
    // 编辑态首次「显示」要先向后端取真实密钥（前端只持有掩码）；取到后回填并切明文。
    if (!showKey && editing && !keyRevealed && initial?.alias) {
      setRevealing(true);
      setError(null);
      try {
        const { access_key } = await revealKey(initial.alias);
        setAccessKey(access_key);
        setKeyRevealed(true);
        setShowKey(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRevealing(false);
      }
      return;
    }
    setShowKey((s) => !s);
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const cleanModels = models
        .map((model) => {
          const modality = model.modality ?? 'image' as ModelModality;
          const inputModalities = modality === 'text'
            ? Array.from(new Set<ModelInputModality>(['text', ...(model.input_modalities ?? [])]))
            : model.input_modalities ?? [];
          return {
            name: model.name.trim(),
            id: model.id.trim(),
            modality,
            protocol: model.protocol ?? null,
            input_modalities: inputModalities,
          };
        })
        .filter((model) => model.name && model.id);
      // key 级 modalities 由模型标注派生；存量契约用 llm 表示文本生成能力。
      const derivedModalities = Array.from(new Set([
        ...cleanModels.map((m) => m.modality === 'text' ? 'llm' : m.modality),
      ]));
      const payload: KeyCreatePayload = {
        alias: usesNamedAlias(provider) ? alias.trim() : provider,
        provider,
        base_url: baseUrl.trim() || null,
        billing_group: billingGroup.trim() || null,
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
          billing_group: payload.billing_group,
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

  // chip 计数与列表同源：都先过搜索词。否则搜 "seedream" 后列表只剩 2 行、chip 还写着「全部 78」。
  const pickerSearched = (preview?.models ?? []).filter((m) => {
    const q = pickerQuery.trim().toLowerCase();
    return !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
  });
  const pickerCounts = (filter: PickerFilter) =>
    filter === 'all' ? pickerSearched.length : pickerSearched.filter((m) => m.category === filter).length;
  const pickerVisible = pickerFilter === 'all'
    ? pickerSearched
    : pickerSearched.filter((m) => m.category === pickerFilter);
  // 「不可生成」chip 只在逃生舱把它们拉进来时出现。
  const pickerFilters: PickerFilter[] = [
    'all', 'text', 'image', 'video', 'audio', 'unknown',
    ...((preview?.models ?? []).some((m) => m.category === 'excluded') ? (['excluded'] as const) : []),
  ];

  const selectAllVisible = () => {
    const next = new Set(fetchedChecked);
    pickerVisible.forEach((m) => next.add(m.id));
    setFetchedChecked(next);
  };

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
      {preview ? (
        /* —— 模型选择子视图：独占整个弹窗，列表拿全高，brass 只有「启用所选」一处 —— */
        <div
          className="flex h-[min(640px,86vh)] w-[860px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-card"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="space-y-3 px-6 pb-3 pt-5">
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="inline-flex items-center gap-1.5 rounded-md py-1 pr-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <ArrowLeft size={14} aria-hidden />
              返回表单
            </button>
            <div className="truncate font-mono text-xs text-muted-foreground">
              GET {fetchModelsBaseUrl}/models · 上游 {preview.total} 个
            </div>
            {/* 过滤情况诚实上墙 + 逃生舱：deny 词表哪天判过头，画师能自己看到全量。
                一条都没过滤（且没在全量态）时这段是纯噪音，不渲染。 */}
            {(preview.excluded > 0 || preview.includeAll) && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {preview.includeAll
                    ? '已显示全部，含不可生成模型'
                    : `已过滤 ${preview.excluded} 个不可生成模型`}
                </span>
                <button
                  type="button"
                  onClick={() => fetchModels(!preview.includeAll)}
                  disabled={fetching}
                  className={textActionClass}
                >
                  {fetching ? '获取中...' : preview.includeAll ? '只看可生成模型' : '显示全部'}
                </button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {pickerFilters.map((f) => (
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
                  {f === 'all' ? '全部' : CATEGORY_LABELS[f]} {pickerCounts(f)}
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
              <div
                key={m.id}
                className={`flex items-center gap-3 rounded-md px-2 py-1.5 ${
                  fetchedChecked.has(m.id) ? 'bg-secondary/40' : 'hover:bg-secondary/60'
                }`}
              >
                {/* label 只包住勾选区——分类二选一是按钮，被 label 激活行为顺带切勾选就乱了。 */}
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
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
                </label>
                {m.modality ? (
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${
                      m.modality === 'image' ? 'border-primary/40 text-primary' : 'border-border text-foreground'
                    }`}
                  >
                    {CATEGORY_LABELS[m.modality]}
                  </span>
                ) : (
                  /* 上游认不出分类的行：就地选择四模态，不做静默兜底。 */
                  <div role="group" aria-label={`分类 ${m.id}`} className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted-foreground">{CATEGORY_LABELS[m.category]}</span>
                    <div className="flex items-center rounded-md border border-border p-0.5">
                      {GENERATION_MODALITIES.map((mod) => {
                        const active = modalityPick[m.id] === mod;
                        return (
                          <button
                            key={mod}
                            type="button"
                            aria-pressed={active}
                            onClick={() => setModalityPick({ ...modalityPick, [m.id]: mod })}
                            className={`rounded-sm px-2 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                              active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {CATEGORY_LABELS[mod]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {pickerVisible.length === 0 && (
              <div className="px-2 py-8 text-center text-sm text-muted-foreground">没有匹配的模型</div>
            )}
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-border px-6 py-3">
            {/* 78 条里挑 15 个视频要点 15 次 checkbox——批量入口跟「已选」计数放一起。 */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-xs text-muted-foreground">已选 {fetchedChecked.size} 个模型</span>
              <button
                type="button"
                onClick={selectAllVisible}
                disabled={pickerVisible.length === 0}
                className={textActionClass}
              >
                全选当前 {pickerVisible.length} 个
              </button>
              <button
                type="button"
                onClick={() => setFetchedChecked(new Set())}
                disabled={fetchedChecked.size === 0}
                className={textActionClass}
              >
                清空选择
              </button>
              {unresolvedChecked.length > 0 && (
                <span className="text-xs text-destructive">
                  {unresolvedChecked.length} 个未识别模型待指定分类
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" onClick={() => setPreview(null)} className={ghostButtonClass}>
                取消
              </button>
              <button
                type="button"
                onClick={applyFetchedSelection}
                disabled={unresolvedChecked.length > 0}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                启用所选（{fetchedChecked.size}）
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* —— 表单主视图：左轨供应商选项列表（不透明 popover 轨道），右 pane 字段 —— */
        <div
          className={`grid max-h-[86vh] w-[860px] max-w-[92vw] grid-rows-[minmax(0,1fr)] overflow-hidden rounded-xl border border-border bg-card ${editing ? '' : 'md:grid-cols-[240px_1fr]'}`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 左轨仅新建态出现——编辑态只聚焦当前供应商，不再渲染选择列表（避免误导性 hover）。
              左轨在 md 以下隐藏，由 body 顶部的下拉兜底（同一 changeProvider 路径）。 */}
          {!editing && (
            <div className="hidden flex-col gap-1 overflow-y-auto border-r border-border bg-popover p-3 md:flex" role="group" aria-label="供应商列表">
              <div className="px-3 pb-1 pt-2 text-xs uppercase tracking-label text-muted-foreground/70">供应商</div>
              {PROVIDER_PRESETS.map((p) => {
                const selected = provider === p.value;
                return (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => changeProvider(p.value)}
                    aria-pressed={selected}
                    className={`flex items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
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
          )}
          <div className="flex min-h-0 flex-col">
            <div className="flex items-start justify-between gap-4 px-6 pb-4 pt-5">
              <div className="min-w-0 space-y-1">
                <h2 className="font-display italic text-base text-foreground">
                  {/* 非预设供应商（kling/veo 等后端允许但前端无 preset）回落到 alias，
                      避免 providerByValue 静默回落 OpenAI 把标题误标成「编辑 OpenAI」。 */}
                  {editing
                    ? `编辑 ${usesNamedAlias(provider) ? alias : (PROVIDER_PRESETS.find((p) => p.value === provider)?.label ?? alias)}`
                    : '新增供应商'}
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
              {!editing && (
                <div className="md:hidden">
                  <label htmlFor="key-provider" className={capLabelClass}>供应商选择</label>
                  <select
                    id="key-provider"
                    value={provider}
                    onChange={(e) => changeProvider(e.target.value)}
                    className={fieldClass}
                  >
                    {PROVIDER_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </div>
              )}
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
                  <div>
                    <label htmlFor="key-billing-group" className={capLabelClass}>计费分组（可选）</label>
                    <input
                      id="key-billing-group"
                      value={billingGroup}
                      onChange={(e) => setBillingGroup(e.target.value)}
                      className={fieldClass}
                      placeholder="例如：default"
                      autoComplete="off"
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      仅用于按账号分组定价的聚合商；留空时不显示无法确认的价格。
                    </p>
                  </div>
                </>
              )}
              <div>
                <label htmlFor="key-access" className={capLabelClass}>API Key</label>
                <div className="relative">
                  <input
                    id="key-access"
                    type={showKey ? 'text' : 'password'}
                    value={accessKey}
                    onChange={(e) => { setAccessKey(e.target.value); setKeyRevealed(true); }}
                    className={`${fieldClass} pr-10 font-mono`}
                    placeholder={editing ? '留空或保持原值表示不修改密钥' : '粘贴 API Key，例如 sk-...'}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={toggleShowKey}
                    disabled={revealing}
                    aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                    className="absolute inset-y-0 right-0 inline-flex w-10 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    {showKey ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                  </button>
                </div>
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className={`${capLabelClass} mb-0`}>模型</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => fetchModels()}
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
                <div className="mb-2 grid grid-cols-[1fr_1fr_15rem_auto] gap-2 text-xs text-muted-foreground">
                  <span>模型别名</span>
                  <span>模型 ID</span>
                  <span>分类 / 输入</span>
                  <span className="sr-only">操作</span>
                </div>
                <div className="space-y-2">
                  {models.map((model, index) => (
                    <div key={index} className="grid grid-cols-[1fr_1fr_15rem_auto] items-center gap-2">
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
                      <div className="space-y-1.5">
                        {isLocked(model) ? (
                          /* 已存在的模型分类固化为只读徽标——添加完成后不允许再调分类。 */
                          <div role="group" aria-label={`模型分类 ${index + 1}`} className="flex items-center">
                            <span
                              className={`rounded-full border px-2 py-0.5 text-xs ${
                                (model.modality ?? 'image') === 'video'
                                  ? 'border-border text-foreground'
                                  : 'border-primary/40 text-primary'
                              }`}
                            >
                              {CATEGORY_LABELS[model.modality ?? 'image']}
                            </span>
                          </div>
                        ) : (
                          <div
                            role="group"
                            aria-label={`模型分类 ${index + 1}`}
                            className="flex items-center rounded-md border border-border p-0.5"
                          >
                            {GENERATION_MODALITIES.map((mod) => {
                              const active = (model.modality ?? 'image') === mod;
                              return (
                                <button
                                  key={mod}
                                  type="button"
                                  aria-pressed={active}
                                  onClick={() => setModels(models.map((m, i) => i === index ? {
                                    ...m,
                                    modality: mod,
                                    input_modalities: mod === 'text' ? ['text'] : [],
                                  } : m))}
                                  className={`rounded-sm px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                                    active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                                  }`}
                                >
                                  {CATEGORY_LABELS[mod]}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        {(model.modality ?? 'image') === 'text' && (
                          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                            <span>理解输入</span>
                            {TEXT_INPUT_MODALITIES.map(([inputModality, label]) => (
                              <label key={inputModality} className="flex items-center gap-1.5">
                                <input
                                  type="checkbox"
                                  checked={(model.input_modalities ?? []).includes(inputModality)}
                                  onChange={(event) => setModels(models.map((current, i) => {
                                    if (i !== index) return current;
                                    const currentInputs = new Set<ModelInputModality>(
                                      current.input_modalities ?? ['text'],
                                    );
                                    currentInputs.add('text');
                                    if (event.target.checked) currentInputs.add(inputModality);
                                    else currentInputs.delete(inputModality);
                                    return { ...current, input_modalities: Array.from(currentInputs) };
                                  }))}
                                  className="size-3.5 accent-[color:var(--primary)]"
                                />
                                {label}
                              </label>
                            ))}
                          </div>
                        )}
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
