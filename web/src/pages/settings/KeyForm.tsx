import { ProviderBrandIcon } from '@/components/ProviderBrandIcon';
import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, X } from 'lucide-react';
import { getChatGPTSubscription, type ChatGPTSubscriptionStatus, createKey, patchKey, modelModality, previewModels, revealKey, type KeyCreatePayload, type KeyModel, type ModelCategory, type ModelInputModality, type ModelModality, type ModelsPreview, type RemoteModel } from '@/api/keys';
import { SwapIcon } from '@/components/ui/swap-icon';
import { checkGateway } from '@/api/gateway';
import { ApiError } from '@/api/http';

import { PROVIDER_PRESETS, providerPresetId, type ProviderKind } from './providerPresets';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
const GATEWAY_PROVIDER = 'atelier';

const KIND_LABELS: Record<ProviderKind, string> = {
  official: '官方',
  relay: '中转',
  custom: '自定义',
  team: '团队',
  subscription: '订阅',
};

const providerByValue = (value: string) =>
  PROVIDER_PRESETS.find((preset) => preset.id === value) ?? PROVIDER_PRESETS[0];

const usesNamedAlias = (provider: string) => provider === 'custom' || provider === GATEWAY_PROVIDER;

const fieldClass = 'w-full rounded-md border border-input bg-background/35 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50';
const capLabelClass = 'block text-xs text-muted-foreground mb-2';
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
  presetId?: string;
  onCreated: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  submitLabel?: string;
  mode?: 'create' | 'edit';
}

export function KeyForm({ initial, presetId, onCreated, onCancel, onDelete, submitLabel = '保存', mode = 'create' }: Props) {
  const initialPreset = PROVIDER_PRESETS.find(p => p.id === presetId) ?? providerByValue(providerPresetId(initial ?? { provider: 'openai' }));
  const [activePresetId, setActivePresetId] = useState(initialPreset.id);
  const [enabled, setEnabled] = useState(initial?.enabled !== false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [manualId, setManualId] = useState('');
  const [manualType, setManualType] = useState<ModelModality>('image');
  const [testing, setTesting] = useState(false);
  const [connectionTest, setConnectionTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [alias, setAlias] = useState(initial?.alias ?? initialPreset.label);
  const [provider, setProvider] = useState(initial?.provider ?? initialPreset.value);
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? initialPreset.defaultBaseUrl ?? '');
  const [billingGroup, setBillingGroup] = useState(initial?.billing_group ?? '');
  const [homepage, setHomepage] = useState(initial?.homepage_url ?? initialPreset.homepageUrl ?? '');
  const [accessKey, setAccessKey] = useState(initial?.access_key ?? '');
  // 编辑旧 Key 时模型可能没标注分类——载入即用 key 级 modalities 兜底值固化进每行，
  // 保存后 key 级 modalities 改为由模型标注派生，老 key 的视频可见性不丢。
  // 编辑态打开时已存在的行打 _locked，分类锁死为只读；新增行不带标记，仍可选分类。
  const [models, setModels] = useState<EditableModel[]>(
    initial?.models !== undefined
      ? initial.models.map((m) => ({ ...m, modality: modelModality(m, initial), _locked: mode === 'edit' }))
      : initialPreset.defaultModels,
  );
  const pendingModelFocus = useRef<number | null>(null);
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
  const preset = providerByValue(activePresetId);
  const isGateway = provider === GATEWAY_PROVIDER;
  const isSubscription = provider === 'chatgpt';
  const [subscription, setSubscription] = useState<ChatGPTSubscriptionStatus | null>(null);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  useEffect(() => {
    if (!isSubscription) return;
    let active = true;
    setSubscription(null);
    setSubscriptionError(null);
    void getChatGPTSubscription().then(status => { if (active) setSubscription(status); })
      .catch(error => { if (active) setSubscriptionError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [isSubscription]);
  // 网关供应商的模型只来自网关（带 via 成员快照），不手填。
  const [gatewayModels, setGatewayModels] = useState<KeyModel[]>(
    initial?.provider === GATEWAY_PROVIDER ? initial.models ?? [] : [],
  );
  const [gatewayInfo, setGatewayInfo] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [gatewayError, setGatewayError] = useState<string | null>(null);

  const connectGateway = async () => {
    setConnecting(true);
    setGatewayError(null);
    try {
      const keyChanged = accessKey.trim() && accessKey !== initial?.access_key;
      const result = await checkGateway({
        base_url: baseUrl.trim(),
        ...(keyChanged ? { access_key: accessKey.trim() } : {}),
        ...(editing && initial?.alias ? { alias: initial.alias } : {}),
      });
      setGatewayModels(result.models);
      setGatewayInfo(`${result.info.name} · ${result.info.version}`);
    } catch (e) {
      // 服务端已给出能照着做的原因，不再附带「（HTTP 502）」这类状态码。
      setGatewayError(e instanceof ApiError && e.reason ? `连接网关失败：${e.reason}` : e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };
  const isLocked = (model: EditableModel) => model._locked === true;

  const changeProvider = (nextProvider: string) => {
    if (editing) return;
    const nextPreset = providerByValue(nextProvider);
    setActivePresetId(nextProvider);
    setProvider(nextPreset.value);
    setAlias(nextPreset.kind === 'custom' || nextPreset.kind === 'team' ? '' : nextPreset.label);
    setBaseUrl(nextPreset.defaultBaseUrl ?? '');
    setBillingGroup('');
    setHomepage(nextPreset.homepageUrl ?? '');
    setModels(nextPreset.defaultModels);
    setUrlTest(null);
    setPreview(null);
    setModalityPick({});
    setFetchError(null);
    setGatewayModels([]);
    setGatewayInfo(null);
    setGatewayError(null);
    setConnectionTest(null);
  };

  // 模型映射：服务端代理拉上游 /models（CORS + 编辑态前端只有掩码密钥，见 models-preview）。
  const fetchModelsBaseUrl = baseUrl.trim() || preset.defaultBaseUrl || '';
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
        sorted.filter((m) => preview ? carried.includes(m.id) : enabledIds.has(m.id)).map((m) => m.id),
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
  const mergedModels = (): EditableModel[] => {
    if (!preview) return models;
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
          input_modalities: hit.input_modalities ?? m.input_modalities,
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
      .map((m): EditableModel => {
        const stored = editing ? initial?.models?.find(model => model.id === m.id) : undefined;
        return stored ? { ...stored, _locked: true, modality: modelModality(stored, initial),
          protocol: m.protocol, input_modalities: stored.input_modalities ?? m.input_modalities }
          : { name: m.name, id: m.id, modality: resolvedModality(m) as ModelModality,
            protocol: m.protocol, input_modalities: m.input_modalities };
      });
    return [...kept, ...added];
  };

  const applyFetchedSelection = () => {
    if (unresolvedChecked.length) return;
    setModels(mergedModels());
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
    if (unresolvedChecked.length) return;
    setSaving(true);
    setError(null);
    try {
      const cleanModels = isGateway ? gatewayModels : mergedModels()
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
        ...cleanModels.map((m) => m.modality === 'text' ? 'llm' : m.modality ?? 'image'),
      ]));
      const payload: KeyCreatePayload = {
        alias: usesNamedAlias(provider) ? alias.trim() : provider,
        provider,
        enabled,
        base_url: baseUrl.trim() || null,
        billing_group: billingGroup.trim() || null,
        access_key: isSubscription ? '' : accessKey.trim(),
        ...(isSubscription ? { auth_source: 'codex-cli' as const } : {}),
        secret_key: null,
        capabilities: ['portrait', 'promo', 'turnaround'],
        models: cleanModels,
        homepage_url: homepage.trim() || preset.homepageUrl || null,
        docs_url: initial?.docs_url ?? preset.docsUrl ?? null,
        api_key_url: initial?.api_key_url ?? preset.apiKeyUrl ?? null,
        modalities: derivedModalities,
        notes: '',
      };
      if (editing && initial?.alias) {
        const patch: Partial<KeyCreatePayload> = {
          enabled: payload.enabled,
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
    (isSubscription ? (editing || subscription?.available) : (editing || accessKey.trim()))
    && (!usesNamedAlias(provider) || alias.trim())
    && (provider !== 'custom' || baseUrl.trim())
    && (!isGateway || (baseUrl.trim() && gatewayModels.length > 0))
    && unresolvedChecked.length === 0
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

  const testConnection = async () => {
    setTesting(true);
    setConnectionTest(null);
    const started = performance.now();
    try {
      try {
        const parsed = new URL(fetchModelsBaseUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
      } catch { throw new Error('请输入完整的 HTTP(S) API 请求地址'); }
      const keyChanged = accessKey.trim() && accessKey !== initial?.access_key;
      await previewModels({ alias: editing ? initial?.alias ?? null : null, provider,
        base_url: fetchModelsBaseUrl, access_key: !editing || keyChanged ? accessKey.trim() || null : null,
        include_all: false });
      setConnectionTest({ ok: true, message: `可用 · ${Math.round(performance.now() - started)} ms` });
    } catch (error) {
      setConnectionTest({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally { setTesting(false); }
  };
  const typeDot = (modality?: ModelModality | null) => ({ image: 'bg-brand-2', video: 'bg-brand-3', text: 'bg-brand-4', audio: 'bg-muted-foreground' }[modality ?? 'image']);
  const title = editing ? `编辑 ${usesNamedAlias(provider) ? alias : (PROVIDER_PRESETS.find(p => p.value === provider)?.label ?? alias)}` : preset.label;
  const addManualModel = () => {
    const id = manualId.trim();
    if (!id || models.some(model => model.id === id)) return;
    setModels([...models.filter(model => model.id.trim()), { name: id, id, modality: manualType }]);
    if (preview?.models.some(model => model.id === id)) {
      setFetchedChecked(new Set([...fetchedChecked, id]));
      setModalityPick({ ...modalityPick, [id]: manualType });
    }
    setManualId('');
  };

  return (
    <Dialog open onOpenChange={open => { if (!open && !saving) onCancel(); }}>
      <DialogContent hideClose aria-describedby={undefined} className="flex max-h-[90dvh] max-w-[680px] flex-col gap-0 overflow-hidden p-0">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-4">
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-xs"><ProviderBrandIcon provider={{ provider: preset.value, base_url: preset.defaultBaseUrl }} /></span>
          <DialogTitle className="min-w-0 flex-1 truncate">{title}</DialogTitle>
          {homepage && <a href={homepage} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:text-primary">官网 ↗</a>}
          <Switch compact checked={enabled} onChange={setEnabled} label={`启用 ${alias || preset.label}`} />
        </header>
        <div className="min-h-0 overflow-y-auto px-4 py-5 sm:px-6">
          {!editing && !presetId && <div className="mb-5 space-y-2">
            <label htmlFor="key-provider" className={capLabelClass}>供应商选择</label>
            <select id="key-provider" value={activePresetId} disabled={fetching || testing || connecting} onChange={e => changeProvider(e.target.value)} className={fieldClass}>
              {PROVIDER_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label} · {KIND_LABELS[p.kind]}</option>)}
            </select>
          </div>}
          <div className="grid grid-cols-1 items-start gap-x-4 gap-y-3 sm:grid-cols-[88px_minmax(0,1fr)]">
            <label htmlFor="key-provider-name" className="pt-2 text-xs text-muted-foreground">名称</label>
            <input autoComplete="off" data-1p-ignore="" data-lpignore="true" data-form-type="other" id="key-provider-name" placeholder={provider === 'custom' ? '例如：openrouter-image-main' : undefined} value={alias} readOnly={editing || !usesNamedAlias(provider)} onChange={e => setAlias(e.target.value)} className={fieldClass} />
            {isGateway && <>
              <label htmlFor="key-gateway-url" className="pt-2 text-xs text-muted-foreground">网关地址</label>
              <input autoComplete="off" data-1p-ignore="" data-lpignore="true" data-form-type="other" id="key-gateway-url" value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setGatewayModels([]); setGatewayInfo(null); }} className={`${fieldClass} font-mono`} placeholder="http://192.168.1.20:5180" />
            </>}
            {isSubscription ? <>
              <span className="pt-2 text-xs text-muted-foreground">账号</span>
              <div className="py-2 text-sm">{subscriptionError ? <p role="alert" className="text-destructive">{subscriptionError}</p> : !subscription ? <p role="status" className="text-muted-foreground">读取中…</p> : subscription.available ? <><p>{subscription.email}</p>{subscription.plan && <p className="mt-1 text-xs text-muted-foreground">{subscription.plan}</p>}</> : <p role="status" className="text-muted-foreground">请先在 Codex 里用 ChatGPT 登录</p>}</div>
            </> : <>
            <label htmlFor="key-access" className="pt-2 text-xs text-muted-foreground">{isGateway ? '网关密钥' : 'API 密钥'}</label>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1">
                {/* 不用 type="password"：Chrome 会把上一栏（网关地址）当用户名、弹出保存密码，autoComplete="off" 对密码框无效。用文本框 + text-security 遮挡。 */}
                <input id="key-access" type="text" value={accessKey} onChange={e => { setAccessKey(e.target.value); setKeyRevealed(true); setConnectionTest(null); }} autoComplete="off" spellCheck={false} data-1p-ignore="" data-lpignore="true" data-form-type="other" className={`${fieldClass} pr-10 font-mono ${showKey ? '' : '[-webkit-text-security:disc]'}`} placeholder={editing ? '留空则保留原密钥' : '粘贴密钥'} />
                <button type="button" aria-label={showKey ? '隐藏密钥' : '显示密钥'} disabled={revealing} onClick={toggleShowKey} className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-md text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary">
                  <SwapIcon swapKey={showKey}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</SwapIcon>
                </button>
              </div>
              {(initial?.api_key_url || preset.apiKeyUrl) && <a href={initial?.api_key_url || preset.apiKeyUrl} target="_blank" rel="noreferrer" className="whitespace-nowrap text-xs text-primary">获取密钥 ↗</a>}
            </div>
            </>}
            <span className="pt-2 text-xs text-muted-foreground">模型</span>
            <div className="min-w-0 space-y-3">
              {isSubscription ? <p className="py-2 text-sm">GPT Image</p> : isGateway ? <>
                <button type="button" onClick={connectGateway} disabled={!baseUrl.trim() || (!editing && !accessKey.trim()) || connecting} className={ghostButtonClass}>{connecting ? '连接中...' : gatewayModels.length ? '重新同步' : '连接网关'}</button>
                {gatewayInfo && <p role="status" className="text-sm text-muted-foreground">{gatewayInfo}</p>}
                {gatewayError && <p role="alert" className="text-sm text-destructive">{gatewayError}</p>}
                <ul aria-label="网关模型" className="flex flex-wrap gap-2">{gatewayModels.map(model => <li key={model.id} className="rounded-full border border-border px-3 py-1 text-xs">{model.name}<span className="ml-2 text-muted-foreground">{(model.via ?? []).map(item => item.alias).join(' · ')}</span></li>)}</ul>
              </> : <>
                <div className="flex flex-wrap items-center gap-2">
                  <div role="group" aria-label="模型范围" className="flex shrink-0 rounded-md border border-border p-0.5">
                    <button type="button" aria-pressed={!preview} disabled={unresolvedChecked.length > 0} onClick={applyFetchedSelection} className={`rounded-sm px-3 py-1 text-xs ${!preview ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`}>已选 {mergedModels().filter(m => m.id.trim()).length}</button>
                    <button type="button" aria-pressed={Boolean(preview)} onClick={() => void fetchModels()} className={`rounded-sm px-3 py-1 text-xs ${preview ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`}>全部</button>
                  </div>
                  {!preview && <input autoComplete="off" data-1p-ignore="" data-lpignore="true" data-form-type="other" aria-label="筛选模型" placeholder="筛选模型" value={modelQuery} onChange={e => setModelQuery(e.target.value)} className={`${fieldClass} min-w-0 flex-1 basis-28`} />}
                  <button type="button" disabled={fetching || !fetchModelsBaseUrl} onClick={() => void fetchModels()} className={ghostButtonClass}>{fetching ? '获取中...' : '重新获取'}</button>
                </div>
                {fetchError && <p role="alert" className="text-sm text-destructive">{fetchError}</p>}
                {preview ? <div className="min-w-0 space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>上游 {preview.total} 个模型</span>
                    {(preview.excluded > 0 || preview.includeAll) && <>
                      <span>{preview.includeAll ? '已显示全部，含不可生成模型' : `已过滤 ${preview.excluded} 个不可生成模型`}</span>
                      <button type="button" disabled={fetching} onClick={() => fetchModels(!preview.includeAll)} className={textActionClass}>{preview.includeAll ? '只看可生成模型' : '显示全部'}</button>
                    </>}
                  </div>
                  <input autoComplete="off" data-1p-ignore="" data-lpignore="true" data-form-type="other" aria-label="搜索模型" placeholder="筛选模型" value={pickerQuery} onChange={e => setPickerQuery(e.target.value)} className={fieldClass} />
                  <div className="flex flex-wrap gap-1">
                    {pickerFilters.map(filter => <button type="button" key={filter} aria-pressed={pickerFilter === filter} onClick={() => setPickerFilter(filter)} className={`rounded-md px-2 py-1 text-xs ${pickerFilter === filter ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`}>{filter === 'all' ? '全部' : CATEGORY_LABELS[filter]} {pickerCounts(filter)}</button>)}
                  </div>
                  <div className="flex max-h-56 flex-wrap content-start items-start gap-2 overflow-auto">
                    {pickerVisible.map(model => <div key={model.id} className="max-w-full space-y-2">
                      <button type="button" role="checkbox" aria-checked={fetchedChecked.has(model.id)} aria-label={`${model.name} ${model.id}`} title={model.name} onClick={() => {
                        const next = new Set(fetchedChecked);
                        if (next.has(model.id)) next.delete(model.id); else next.add(model.id);
                        setFetchedChecked(next);
                      }} className={`flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-xs ${fetchedChecked.has(model.id) ? 'border-primary/40 bg-secondary text-foreground' : 'border-border text-muted-foreground'}`}>
                        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${typeDot(resolvedModality(model))}`} /><span className="truncate">{model.id}</span>
                      </button>
                      {!model.modality && fetchedChecked.has(model.id) && <div role="group" aria-label={`分类 ${model.id}`} className="flex flex-wrap gap-1">
                        {GENERATION_MODALITIES.map(modality => <button type="button" key={modality} aria-pressed={modalityPick[model.id] === modality} onClick={() => setModalityPick({ ...modalityPick, [model.id]: modality })} className={`rounded-sm px-2 py-1 text-xs ${modalityPick[model.id] === modality ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`}>{CATEGORY_LABELS[modality]}</button>)}
                      </div>}
                    </div>)}
                    {pickerVisible.length === 0 && <p className="text-xs text-muted-foreground">没有匹配的模型</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>已选 {fetchedChecked.size} 个模型</span>
                    <button type="button" onClick={selectAllVisible} disabled={!pickerVisible.length} className={textActionClass}>全选当前 {pickerVisible.length} 个</button>
                    <button type="button" onClick={() => setFetchedChecked(new Set())} disabled={!fetchedChecked.size} className={textActionClass}>清空选择</button>
                    <button type="button" onClick={applyFetchedSelection} disabled={unresolvedChecked.length > 0} className={textActionClass}>启用所选（{fetchedChecked.size}）</button>
                    {unresolvedChecked.length > 0 && <span className="text-destructive">{unresolvedChecked.length} 个未识别模型待指定分类</span>}
                  </div>
                </div> : <div className="flex max-h-56 flex-wrap gap-2 overflow-auto">
                  {models.filter(m => m.id.trim() && `${m.id} ${m.name}`.toLowerCase().includes(modelQuery.toLowerCase())).map((model, index) => <button key={`${model.id}-${index}`} type="button" aria-pressed="true" onClick={() => setModels(models.filter(m => m !== model))} className="flex max-w-full items-center gap-2 rounded-full border border-primary/40 bg-secondary px-3 py-1.5 font-mono text-xs">
                    <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${typeDot(model.modality)}`} /><span className="truncate">{model.id}</span><X size={12} aria-hidden />
                  </button>)}
                </div>}
                {provider === 'custom' && <div className="flex flex-wrap gap-2">
                  <input autoComplete="off" data-1p-ignore="" data-lpignore="true" data-form-type="other" aria-label="添加模型 ID" placeholder="添加模型 ID" value={manualId} onChange={e => setManualId(e.target.value)} className={`${fieldClass} min-w-0 flex-1 basis-28 font-mono`} />
                  <select aria-label="新增模型类型" value={manualType} onChange={e => setManualType(e.target.value as ModelModality)} className="rounded-md border border-input bg-transparent px-2 text-xs">{GENERATION_MODALITIES.map(type => <option key={type} value={type}>{CATEGORY_LABELS[type]}</option>)}</select>
                  <button type="button" disabled={!manualId.trim() || models.some(m => m.id === manualId.trim())} onClick={addManualModel} className={ghostButtonClass}>添加</button>
                </div>}
                <details open={detailsOpen} onToggle={e => setDetailsOpen(e.currentTarget.open)}>
                  <summary className="cursor-pointer text-xs text-muted-foreground">模型详情</summary>
                  <div className="mt-3 space-y-3">
                    <button type="button" onClick={() => { setDetailsOpen(true); pendingModelFocus.current = models.length; setModels([...models, { name: '', id: '' }]); }} className={ghostButtonClass}>添加模型</button>
                <div className="mb-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <span>模型别名</span>
                  <span>模型 ID</span>
                  <span>分类 / 输入</span>
                  <span className="sr-only">操作</span>
                </div>
                <div className="space-y-2">
                  {models.map((model, index) => (
                    <div key={index} className="grid grid-cols-2 items-start gap-2">
                      <label className="sr-only" htmlFor={`key-model-name-${index}`}>模型名称 {index + 1}</label>
                      <input autoComplete="off" data-1p-ignore="" data-lpignore="true" data-form-type="other"
                        ref={(input) => {
                          if (!input || pendingModelFocus.current !== index) return;
                          pendingModelFocus.current = null;
                          input.focus({ preventScroll: true });
                          input.scrollIntoView({ block: 'center', behavior: 'instant' });
                        }}
                        id={`key-model-name-${index}`}
                        aria-label={`模型名称 ${index + 1}`}
                        value={model.name}
                        onChange={(e) => setModels(models.map((m, i) => i === index ? { ...m, name: e.target.value } : m))}
                        className={fieldClass}
                        placeholder="给人看的名字，例如：图片 5.0"
                      />
                      <label className="sr-only" htmlFor={`key-model-id-${index}`}>模型 ID {index + 1}</label>
                      <input autoComplete="off" data-1p-ignore="" data-lpignore="true" data-form-type="other"
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
                                <input autoComplete="off" data-1p-ignore="" data-lpignore="true" data-form-type="other"
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
                </details>
              </>}
            </div>
            {!isGateway && !isSubscription && <>
              <span className="pt-2 text-xs text-muted-foreground">连接</span>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={testConnection} disabled={testing || !fetchModelsBaseUrl || (!editing && !accessKey.trim())} className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50">{testing ? '测试中...' : '测试连接'}</button>
                {connectionTest && <span role={connectionTest.ok ? 'status' : 'alert'} className={`text-xs ${connectionTest.ok ? 'text-[color:var(--status-done)]' : 'text-destructive'}`}>{connectionTest.message}</span>}
              </div>
              <details className="col-span-full border-t border-border pt-3">
                <summary className="cursor-pointer text-xs text-muted-foreground">高级：请求地址 · 计费分组</summary>
                <div className="mt-3 grid grid-cols-1 items-center gap-3 sm:grid-cols-[88px_minmax(0,1fr)]">
                  <label htmlFor="key-base-url" className="text-xs text-muted-foreground">API 请求地址</label>
                  <div className="flex gap-2"><input autoComplete="off" data-1p-ignore="" data-lpignore="true" data-form-type="other" id="key-base-url" value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setUrlTest(null); setConnectionTest(null); }} className={`${fieldClass} font-mono`} /><button type="button" onClick={testBaseUrl} className={ghostButtonClass}>测试</button></div>
                  {urlTest && <p className="col-span-full text-xs text-muted-foreground">{urlTest.message}</p>}
                  <label htmlFor="key-billing-group" className="text-xs text-muted-foreground">计费分组（可选）</label>
                  <input autoComplete="off" data-1p-ignore="" data-lpignore="true" data-form-type="other" id="key-billing-group" value={billingGroup} onChange={e => setBillingGroup(e.target.value)} className={fieldClass} placeholder="default" />
                  {provider === 'custom' && <><p className="col-span-full text-xs text-muted-foreground">自定义供应商可以创建多个配置，请用不同配置名称区分额度、用途或上游。</p><label htmlFor="key-homepage" className="text-xs text-muted-foreground">官网链接</label><input autoComplete="off" data-1p-ignore="" data-lpignore="true" data-form-type="other" id="key-homepage" value={homepage} onChange={e => setHomepage(e.target.value)} className={fieldClass} /></>}
                </div>
              </details>
            </>}
          </div>
        </div>
        {error && <p role="alert" className="px-6 pb-3 text-sm text-destructive">{error}</p>}
        <footer className="flex shrink-0 items-center gap-2 border-t border-border px-6 py-4">
          {onDelete && <button type="button" onClick={onDelete} disabled={saving} className="rounded-md px-3 py-2 text-sm text-destructive">删除</button>}
          <span className="flex-1" />
          <button type="button" onClick={onCancel} disabled={saving} className={ghostButtonClass}>取消</button>
          <button type="button" onClick={submit} disabled={!canSubmit} className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{saving ? '保存中...' : submitLabel}</button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
