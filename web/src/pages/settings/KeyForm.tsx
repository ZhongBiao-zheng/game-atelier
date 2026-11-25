import { checkComfyUI } from '@/api/comfyui';
import { ComfyWorkflows } from './ComfyWorkflows';
import { ProviderIconPicker } from '@/components/keys/ProviderIconPicker';
import { defaultIconUrl } from '@/api/providerIcons';
import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from 'react';
import { CheckIcon, CloseIcon, ErrorIcon, HelpIcon, HideIcon, LoadingIcon, ShowIcon } from '@/components/ui/icons';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { getChatGPTSubscription, type ChatGPTSubscriptionStatus, createKey, patchKey, modelModality, previewModels, revealKey, type KeyCreatePayload, type KeyModel, type ModelCategory, type ModelInputModality, type ModelModality, type ModelsPreview, type RemoteModel } from '@/api/keys';
import { SwapIcon } from '@/components/ui/swap-icon';
import { SwapLabel } from '@/components/ui/swap-label';
import { Collapse } from '@/components/ui/collapse';
import { Disclosure } from '@/components/ui/disclosure';
import { useRetained, useRetainedSession } from '@/components/ui/retained';
import { revealInvalidField } from '@/components/ui/invalid-field';
import { checkGateway } from '@/api/gateway';
import { errorText } from '@/lib/errorText';
import { parseGatewayInvite } from './lan-sharing/invite';
import { listHttpProtocols } from '@/api/httpProtocols';
import type { HttpProtocolKind, HttpProtocolRow } from '@/schema/httpProtocols';
import { CustomInterfaceDialog } from './CustomInterfaceDialog';
import { probeKey, recordOnboardingEvent, type KeyProbeResult } from '@/api/onboarding';
import { modelCatalog } from '@/lib/modelCatalog';
import { MOTION_DURATION } from '@/lib/motion';
import { cn } from '@/lib/utils';

import { PROVIDER_PRESETS, providerPresetId, type ProviderKind } from './providerPresets';
import { aliasTaken, defaultAliasBase, nextFreeAlias, type FormIssue, toIssue } from './keyFormNaming';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SecretInput } from '@/components/ui/secret-input';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
const GATEWAY_PROVIDER = 'atelier';

const KIND_LABELS: Record<ProviderKind, string> = {
  official: '官方',
  relay: '中转',
  custom: '自定义',
  team: '团队网关',
  subscription: '订阅',
  local: '本机',
};

const providerByValue = (value: string) =>
  PROVIDER_PRESETS.find((preset) => preset.id === value) ?? PROVIDER_PRESETS[0];

const usesNamedAlias = (provider: string) => provider === 'custom' || provider === 'comfyui' || provider === GATEWAY_PROVIDER;

const isHttpUrl = (value: string) => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
};

/** 站点 = 请求地址的 origin。密钥只属于填它时的供应商与站点；地址还不完整时按原文比较。 */
const siteOf = (value: string) => {
  try { return new URL(value.trim()).origin; } catch { return value.trim(); }
};
/** 请求地址的精确写法（忽略末尾斜杠）；不是合法地址时为 null。 */
const exactUrl = (value: string) => {
  try {
    const url = new URL(value.trim());
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}${url.hash}`;
  } catch { return null; }
};

const capLabelClass = 'block text-xs text-muted-foreground mb-2';
// 次要文本操作（全选 / 清空 / 显示全部）：不占黄铜，也不做成方块按钮抢主操作的戏。

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
// _rowId：行的稳定身份，作 React key；删掉中间一行时后面的行不重挂，输入框不串值、不丢焦点。
type EditableModel = KeyModel & { _locked?: boolean; _price?: string; _priceIn?: string; _priceOut?: string; _rowId?: number };
let nextRowId = 0;
/** 给还没有身份的行补 _rowId；已有的沿用（随 spread 传下去）。 */
const withRowIds = (rows: EditableModel[]) => rows.some(row => row._rowId == null)
  ? rows.map(row => (row._rowId == null ? { ...row, _rowId: ++nextRowId } : row))
  : rows;

const PRICE_HELP = '没有同步价时按此价估算，并计入团队网关额度；留空为未计价';
// 输入中的文本优先（允许「0.」这类中间态），否则回显已存的单价。
const priceText = (model: EditableModel) => model._price ?? (model.per_call_cny != null ? String(model.per_call_cny) : '');
const TEXT_PRICE_HELP = '没有同步价时按此价估算，并计入团队网关额度；输入、输出都填才生效，留空为未计价';
const priceInText = (model: EditableModel) => model._priceIn ?? (model.input_cny_per_m != null ? String(model.input_cny_per_m) : '');
const priceOutText = (model: EditableModel) => model._priceOut ?? (model.output_cny_per_m != null ? String(model.output_cny_per_m) : '');
function parsePrice(text: string): number | null | undefined {
  const value = text.trim();
  if (!value) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 10000 ? number : undefined;
}

interface Props {
  /** 受控弹窗：调用方关闭时传 false，弹窗带着原内容播完退场；不传即打开。 */
  open?: boolean;
  initial?: Partial<KeyCreatePayload>;
  presetId?: string;
  /** 保存成功，带回供应商名称（别名）。 */
  onCreated: (alias: string) => void;
  onCancel: () => void;
  onDelete?: () => void;
  submitLabel?: string;
  mode?: 'create' | 'edit';
  /** 粘贴密钥后自动校验（免费探针）并拉模型：新建时预选本仓认得的图片 / 视频模型；
   *  编辑时只在改了密钥后校验，不动已选模型。结果原地显示，不拦保存。 */
  autoDetect?: boolean;
  /** 首启引导的精简表单：只露密钥框（自定义供应商另露请求地址），名称与模型自动定；记录引导漏斗事件。 */
  guided?: boolean;
  /** 已有供应商的名称：新建时据此给同一预置的第二把密钥自动编号（D15）、提前拦下重名。 */
  existingAliases?: readonly string[];
  /** 从用量页「未计价」进来：展开模型详情，把这个模型的单价框带到眼前。 */
  focusPriceModel?: string;
}

/** 只有文本模型的预置（如 Anthropic），手动添加的模型默认就是文本。 */
const defaultManualType = (preset: { modalities: readonly string[] }): ModelModality =>
  preset.modalities.length === 1 && preset.modalities[0] === 'llm' ? 'text' : 'image';

const AUTO_INTERFACE = 'auto';
const INTERFACE_OPTIONS: [string, string][] = [
  [AUTO_INTERFACE, '自动'], ['openai-chat', 'OpenAI Chat'], ['openai-responses', 'OpenAI Responses'],
  ['anthropic-messages', 'Anthropic'], ['gemini-generate-content', 'Gemini'],
];
const INTERFACE_HELP = '对话模型的调用格式，按供应商文档选。自动：按地址与模型列表识别，识别不出按 OpenAI Chat 调用。经中转站走 Gemini 格式时不进 Agent，手动选 Gemini 后可用。';
const INTERFACE_LABELS = new Map(INTERFACE_OPTIONS);

/** 「自动」后面跟的识别结果：本次检测到的优先，否则按已存模型的协议汇总（识别结果不存进 KEY）。 */
export function autoInterfaceText(detected: ModelsPreview['detected'] | null, models: { modality?: string | null; protocol?: string | null }[]): string {
  if (detected) {
    if (detected.family === 'new-api') return detected.label ? `New API（${detected.label}）` : 'New API';
    return INTERFACE_LABELS.get(detected.protocol ?? 'openai-chat') ?? '';
  }
  const protocols = new Set(models.filter(m => m.modality === 'text' && m.protocol !== 'declarative')
    .map(m => (m.protocol && INTERFACE_LABELS.has(m.protocol) ? m.protocol : 'openai-chat')));
  if (protocols.size === 0) return '';
  return protocols.size === 1 ? INTERFACE_LABELS.get([...protocols][0]) ?? '' : '逐模型';
}

const AGENT_UNVERIFIED_HELP = '经中转站走 Gemini 格式时工具调用未经验证，不进 Agent。把「对话接口」改成 OpenAI Chat，或确认该中转站支持工具调用后手动选 Gemini。';

/** 粘贴后停顿多久再自动检测，避免逐字输入时连发。 */
const AUTO_DETECT_DELAY_MS = 500;
const MIN_KEY_LENGTH = 8;

export function KeyForm({ open = true, initial, presetId, onCreated, onCancel, onDelete, submitLabel = '保存', mode = 'create', autoDetect = false, guided = false, existingAliases, focusPriceModel }: Props) {
  const initialPreset = PROVIDER_PRESETS.find(p => p.id === presetId) ?? providerByValue(providerPresetId(initial ?? { provider: 'openai' }));
  const [activePresetId, setActivePresetId] = useState(initialPreset.id);
  const [enabled, setEnabled] = useState(initial?.enabled !== false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [manualId, setManualId] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualType, setManualType] = useState<ModelModality>(defaultManualType(initialPreset));
  const [pendingRequest, setPendingRequest] = useState<'list' | 'test' | null>(null);
  const testing = pendingRequest === 'test';
  const fetching = pendingRequest === 'list';
  const listRun = useRef(0);
  const [connectionTest, setConnectionTest] = useState<{ ok: boolean; message: string; raw?: string | null } | null>(null);
  // 名称：没动过就跟着默认名走（预置名 / 地址识别出的品牌或 host / 网关名，被占用时自动编号，D15）；动过就用输入值。
  const [aliasInput, setAliasInput] = useState(initial?.alias ?? initialPreset.label);
  const [aliasEdited, setAliasEdited] = useState(mode === 'edit');
  const takenAliases = useMemo(() => new Set(existingAliases ?? []), [existingAliases]);
  const [provider, setProvider] = useState(initial?.provider ?? initialPreset.value);
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? initialPreset.defaultBaseUrl ?? '');
  const [billingGroup, setBillingGroup] = useState(initial?.billing_group ?? '');
  const [homepage, setHomepage] = useState(initial?.homepage_url ?? initialPreset.homepageUrl ?? '');
  const [accessKey, setAccessKey] = useState(initial?.access_key ?? '');
  // 对话接口（ADR-0044）：null = 自动。只有用户填地址的自定义供应商能改；对话接口固定的预置随预置带。
  const [textProtocol, setTextProtocol] = useState<string | null>(initial?.text_protocol ?? initialPreset.textProtocol ?? null);
  const [icon, setIcon] = useState<string | null>(initial?.icon ?? null);
  const [detected, setDetected] = useState<ModelsPreview['detected'] | null>(null);
  // 编辑旧 Key 时模型可能没标注分类——载入即用 key 级 modalities 兜底值固化进每行，
  // 保存后 key 级 modalities 改为由模型标注派生，老 key 的视频可见性不丢。
  // 编辑态打开时已存在的行打 _locked，分类锁死为只读；新增行不带标记，仍可选分类。
  const [models, setModelRows] = useState<EditableModel[]>(() => withRowIds(
    initial?.models !== undefined
      ? initial.models.map((m) => ({ ...m, modality: modelModality(m, initial), _locked: mode === 'edit' }))
      : initialPreset.defaultModels,
  ));
  const setModels = (next: EditableModel[] | ((current: EditableModel[]) => EditableModel[])) =>
    setModelRows(current => withRowIds(typeof next === 'function' ? next(current) : next));
  const pendingModelFocus = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<FormIssue | null>(null);
  const shownError = useRetained(error);
  const formBodyRef = useRef<HTMLDivElement>(null);
  // preview 存整份响应（models + total + excluded），头部才能诚实说清「上游多少、过滤了多少」。
  const [preview, setPreview] = useState<(ModelsPreview & { includeAll: boolean; protocolId: string | null }) | null>(null);
  const [fetchedChecked, setFetchedChecked] = useState<Set<string>>(new Set());
  // 上游没判出分类的行（unknown / excluded）在 picker 里的显式二选一结果，按模型 id 存。
  const [modalityPick, setModalityPick] = useState<Record<string, ModelModality>>({});
  const [fetchError, setFetchError] = useState<FormIssue | null>(null);
  const shownFetchError = useRetained(fetchError);
  useEffect(() => { if (fetchError) setManualOpen(true); }, [fetchError]);
  const [pickerFilter, setPickerFilter] = useState<PickerFilter>('all');
  const [pickerQuery, setPickerQuery] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [revealing, setRevealing] = useState(false);
  // 编辑态打开时密钥框是掩码（前端只有掩码）；create 态字段值即用户实输的真值。
  const [keyRevealed, setKeyRevealed] = useState(mode !== 'edit');
  // 「显示密钥」取回的存储原值：把掩码换成它不算编辑。
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const editing = mode === 'edit';
  // 自定义接口（ADR-0036）：只有自定义供应商的图片 / 视频模型可以绑定。
  const [interfaces, setInterfaces] = useState<HttpProtocolRow[]>([]);
  const [interfaceEditor, setInterfaceEditor] = useState<{ index: number; identifier: string | null; kind: HttpProtocolKind } | null>(null);
  const shownInterfaceEditor = useRetainedSession(interfaceEditor);
  const reloadInterfaces = () => listHttpProtocols().then(result => setInterfaces(result.protocols));
  // 目录来源：空 = 默认 GET /models；否则按这份自定义接口的 catalog 发现（ADR-0036）。
  const [catalogSource, setCatalogSource] = useState('');
  const catalogInterfaces = provider === 'custom' ? interfaces.filter(item => item.available && item.catalog) : [];
  const catalogProtocolId = catalogInterfaces.some(item => item.id === catalogSource) ? catalogSource : null;
  useEffect(() => {
    if (provider !== 'custom') return;
    listHttpProtocols().then(result => setInterfaces(result.protocols)).catch(() => setInterfaces([]));
  }, [provider]);
  const preset = providerByValue(activePresetId);
  // 模型映射：服务端代理拉上游 /models（CORS + 编辑态前端只有掩码密钥，见 models-preview）。
  const fetchModelsBaseUrl = baseUrl.trim() || preset.defaultBaseUrl || '';
  // 这次填的密钥：新建时是框里的值；编辑时不含掩码回显与「显示密钥」取回的原值。
  const keyEdited = Boolean(accessKey.trim())
    && (!editing || (accessKey !== initial?.access_key && accessKey !== revealedKey));
  // 编辑态没重填密钥时，存储的密钥只能用在它原来的站点；换了站点要重填。
  const storedKeyUsable = editing
    && siteOf(fetchModelsBaseUrl) === siteOf(initial?.base_url || initialPreset.defaultBaseUrl || '');
  const keyMissing = !accessKey.trim() && !storedKeyUsable;
  /** 换了站点：之前的密钥不属于新站点，清空要求重填，自动校验也不会把它发过去。 */
  const changeBaseUrl = (next: string) => {
    const effective = (value: string) => value.trim() || preset.defaultBaseUrl || '';
    if (accessKey && siteOf(effective(next)) !== siteOf(effective(baseUrl))) {
      setAccessKey('');
      setKeyRevealed(true);
      setShowKey(false);
    }
    setBaseUrl(next);
  };
  const isGateway = provider === GATEWAY_PROVIDER;
  const isComfy = provider === 'comfyui';
  const isSubscription = provider === 'chatgpt';
  const [subscription, setSubscription] = useState<ChatGPTSubscriptionStatus | null>(null);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  useEffect(() => {
    if (!isSubscription) return;
    let active = true;
    setSubscription(null);
    setSubscriptionError(null);
    void getChatGPTSubscription().then(status => { if (active) setSubscription(status); })
      .catch(error => { if (active) setSubscriptionError(errorText(error)); });
    return () => { active = false; };
  }, [isSubscription]);
  // 网关供应商的模型只来自网关（带 via 成员快照），不手填。
  const [gatewayModels, setGatewayModels] = useState<KeyModel[]>(
    initial?.provider === GATEWAY_PROVIDER ? initial.models ?? [] : [],
  );
  const [gatewayInfo, setGatewayInfo] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [gatewayName, setGatewayName] = useState<string | null>(null);
  const [gatewayError, setGatewayError] = useState<FormIssue | null>(null);
  // 同一组地址 + 密钥只自动连一次；手动「重新同步」不受限。
  const gatewayAttempted = useRef('');
  const gatewayRun = useRef(0);

  const connectGateway = async () => {
    const url = baseUrl;
    const key = accessKey;
    const run = ++gatewayRun.current;
    gatewayAttempted.current = `${url.trim()}\n${key.trim()}`;
    setConnecting(true);
    setGatewayError(null);
    try {
      const result = await checkGateway({
        base_url: url.trim(),
        ...(keyEdited ? { access_key: key.trim() } : {}),
        ...(editing && initial?.alias ? { alias: initial.alias } : {}),
      });
      if (run !== gatewayRun.current) return;
      setGatewayModels(result.models);
      setGatewayInfo(`${result.info.name} · ${result.info.version}`);
      setGatewayName(result.info.name);
    } catch (e) {
      // 服务端已给出能照着做的原因，不再附带「（HTTP 502）」这类状态码。
      if (run === gatewayRun.current) setGatewayError(toIssue(e));
    } finally {
      if (run === gatewayRun.current) setConnecting(false);
    }
  };
  // 地址和密钥都齐了就自动连一次（停顿后），不必再点「连接」。
  useEffect(() => {
    if (!isGateway) return;
    const url = baseUrl.trim();
    const key = accessKey.trim();
    if (!url || (!editing && !key) || gatewayAttempted.current === `${url}\n${key}`) return;
    // 编辑态没重填密钥：只在同站点改了地址时用存储的密钥重连，换站点要先重填。
    if (editing && !keyEdited && (!storedKeyUsable || url === (initial?.base_url ?? ''))) return;
    const timer = window.setTimeout(() => { void connectGateway(); }, AUTO_DETECT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isGateway, baseUrl, accessKey]); // eslint-disable-line react-hooks/exhaustive-deps
  /** 在任一框里粘贴主机给的邀请（地址 + 密钥一段文字）：拆进两个字段。 */
  const pasteInvite = (event: ReactClipboardEvent) => {
    if (!isGateway) return;
    const invite = parseGatewayInvite(event.clipboardData.getData('text'));
    if (!invite) return;
    event.preventDefault();
    setBaseUrl(invite.baseUrl);
    setAccessKey(invite.token);
    setKeyRevealed(true);
    setGatewayModels([]);
    setGatewayInfo(null);
  };
  const isLocked = (model: EditableModel) => model._locked === true;

  const [probe, setProbe] = useState<KeyProbeResult | null>(null);
  // 粘贴密钥后的自动校验：发出到返回之间显示「校验中…」，结果原位换图标。
  const [probing, setProbing] = useState(false);
  // 切换凭证、地址或目录后，旧请求的结果和 finally 都不能改变当前表单。
  useEffect(() => {
    setPendingRequest(null);
    return () => { listRun.current += 1; };
  }, [accessKey, baseUrl, activePresetId, textProtocol, catalogProtocolId]);
  // 自动校验只对填密钥的供应商做；ComfyUI、订阅、团队网关各有自己的连接方式。
  const detectable = autoDetect && !isGateway && !isComfy && !isSubscription;
  useEffect(() => {
    if (!detectable) return;
    const key = accessKey.trim();
    setProbe(null);
    setProbing(false);
    // 只校验这次填的密钥：编辑态的掩码回显、「显示密钥」取回的原值都不算编辑。
    if (key.length < MIN_KEY_LENGTH || !keyEdited) return;
    // 固定探针只收发往该预置默认地址的密钥；自定义地址只走它自己的 GET /models。
    const defaultUrl = exactUrl(preset.defaultBaseUrl ?? '');
    const probeApplies = defaultUrl !== null && exactUrl(fetchModelsBaseUrl) === defaultUrl;
    const run = listRun.current;
    let active = true;
    const timer = setTimeout(() => {
      if (editing && !probeApplies && fetchModelsBaseUrl) {
        // 编辑态：用这个地址自己的模型列表核对新密钥，只看 401 / 403，不动已选模型。
        setProbing(true);
        previewModels({ alias: null, provider: provider || null, base_url: fetchModelsBaseUrl, access_key: key, include_all: false, text_protocol: textProtocol })
          .then(() => undefined, e => { if (active && toIssue(e).code === 'invalid_key') setProbe('invalid'); })
          .finally(() => { if (active) setProbing(false); });
      }
      // 新建时顺手拉模型并预选；地址还没填（自定义供应商）就先只校验密钥。
      if (!editing && fetchModelsBaseUrl && run === listRun.current) {
        const defaultIds = new Set(preset.defaultModels.map(model => model.id));
        setPendingRequest('list');
        setFetchError(null);
        previewModels({ alias: null, provider: provider || null, base_url: fetchModelsBaseUrl, access_key: key, include_all: false, text_protocol: textProtocol })
          .then(remote => {
            if (run !== listRun.current) return;
            setDetected(remote.detected ?? null);
            const picked = remote.models.filter(m => (m.modality === 'image' || m.modality === 'video')
              && (modelCatalog(m.id) !== undefined || defaultIds.has(m.id)));
            if (picked.length > 0) {
              setModels(picked.map((m): EditableModel => ({ name: m.name, id: m.id, modality: m.modality, protocol: m.protocol, input_modalities: m.input_modalities })));
            }
            setPreview(null);
            if (guided) void recordOnboardingEvent({ event: 'models_detected', count: picked.length });
          })
          .catch(e => {
            if (run !== listRun.current) return;
            const issue = toIssue(e);
            setFetchError(issue);
            // 没有免费探针的供应商：列表接口回 401 / 403 就是密钥不对。
            if (issue.code === 'invalid_key' && active) setProbe(current => current ?? 'invalid');
          })
          .finally(() => { if (run === listRun.current) setPendingRequest(null); });
      }
      if (!probeApplies) return;
      setProbing(true);
      void probeKey(activePresetId, key, fetchModelsBaseUrl).then(result => {
        if (!active) return;
        setProbing(false);
        setProbe(current => (result === 'unknown' ? current : result));
        if (guided) void recordOnboardingEvent({ event: 'key_probed', result });
      });
    }, AUTO_DETECT_DELAY_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [accessKey, detectable, fetchModelsBaseUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // 只有用户自己填地址的自定义供应商要选接口；预置的接口是确定的。
  const showInterface = provider === 'custom' && activePresetId === 'custom';
  // 用户自己填地址的自定义供应商：请求地址是必填主字段，放在密钥上面；预置的地址收在「高级」里。
  const userBaseUrl = showInterface;
  // 首启引导只露密钥框（和必填的请求地址），名称与模型自动定。
  const compact = guided && !editing;
  const autoText = showInterface ? autoInterfaceText(detected, models) : '';
  const changeInterface = (value: string) => {
    const next = value === AUTO_INTERFACE ? null : value;
    setTextProtocol(next);
    // 选了具体接口：已有的文本模型都按它调用（与服务端写入时一致）；改回自动不动各模型。
    if (next) setModels(current => current.map(model => (model.modality === 'text' && model.protocol !== 'declarative'
      ? { ...model, protocol: next } : model)));
    setPreview(null);
    setConnectionTest(null);
  };
  const changeProvider = (nextProvider: string) => {
    if (editing) return;
    const nextPreset = providerByValue(nextProvider);
    setActivePresetId(nextProvider);
    setProvider(nextPreset.value);
    setAliasInput(nextPreset.kind === 'custom' || nextPreset.kind === 'team' ? '' : nextPreset.label);
    setAliasEdited(false);
    setBaseUrl(nextPreset.defaultBaseUrl ?? '');
    // 密钥属于上一家：换供应商就清空，要求重填。
    setAccessKey('');
    setShowKey(false);
    setProbe(null);
    setProbing(false);
    setBillingGroup('');
    setHomepage(nextPreset.homepageUrl ?? '');
    setTextProtocol(nextPreset.textProtocol ?? null);
    setManualType(defaultManualType(nextPreset));
    setManualOpen(false);
    setModels(nextPreset.defaultModels);
    setPreview(null);
    setModalityPick({});
    setFetchError(null);
    setGatewayModels([]);
    setGatewayInfo(null);
    setGatewayName(null);
    setGatewayError(null);
    setConnectionTest(null);
  };

  // 请求完成时读取最新勾选；重拉期间继续点选，也不能被旧闭包覆盖。
  const currentSelection = useRef(() => models);
  const acceptPreview = (remote: ModelsPreview, includeAll: boolean) => {
    const selected = currentSelection.current();
    const enabledIds = new Set(selected.map(m => m.id.trim()).filter(Boolean));
    const order = (m: RemoteModel) => ['text', 'image', 'video', 'audio', 'unknown', 'excluded'].indexOf(m.category);
    const sorted = [...remote.models].sort((a, b) => order(a) - order(b));
    setDetected(remote.detected ?? null);
    setFetchError(null);
    // 手填行和预置行省略分类时默认为图片；选择器用 null 标记待分类的勾选。
    const rows = selected.filter(model => model.modality !== null);
    setModels(rows);
    setPickerFilter('all');
    setPickerQuery('');
    setPreview({ ...remote, models: sorted, includeAll, protocolId: catalogProtocolId });
    setFetchedChecked(new Set(sorted.filter(m => enabledIds.has(m.id)).map(m => m.id)));
    setModalityPick(Object.fromEntries(rows.filter(m => m.id.trim())
      .map(m => [m.id.trim(), m.modality ?? 'image'])));
  };
  /** includeAll = 逃生舱重拉：把后端判定「不可生成」的条目也一并列出来。 */
  const fetchModels = async (includeAll = false, connectionRun?: number) => {
    const run = connectionRun ?? ++listRun.current;
    if (connectionRun === undefined) setPendingRequest('list');
    setFetchError(null);
    try {
      // 编辑态没重填密钥（掩码或「显示密钥」取回的原值）就不当真实密钥发，改由服务端按 alias 取存储密钥。
      const remote = await previewModels({
        alias: editing ? initial?.alias ?? null : null,
        provider: provider || null,
        base_url: fetchModelsBaseUrl || null,
        access_key: keyEdited ? accessKey.trim() : null,
        include_all: includeAll,
        protocol_id: catalogProtocolId,
        text_protocol: textProtocol,
      });
      if (run === listRun.current) acceptPreview(remote, includeAll);
    } catch (e) {
      if (run === listRun.current) setFetchError(toIssue(e));
    } finally {
      if (connectionRun === undefined && run === listRun.current) setPendingRequest(null);
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
    // 按自定义接口目录发现的行：分类与该接口一致的绑定它；目录不提供内置协议，已有行的协议保持不变。
    const boundKind = interfaces.find(item => item.id === preview.protocolId)?.kind;
    const discoveredBinding = (modality: ModelModality | null | undefined): Partial<EditableModel> =>
      preview.protocolId && modality === boundKind ? { protocol: 'declarative', declarative_id: preview.protocolId } : {};
    const kept = models
      .filter((m) => !upstream.has(m.id.trim()) || fetchedChecked.has(m.id.trim()))
      .map((m) => {
        const hit = upstream.get(m.id.trim());
        if (!hit) return m;
        return {
          ...m,
          // 「重拉一次列表来修协议」必须真的有效：protocol 是纯机器字段（表单里没有输入口），
          // 命中上游就用上游值覆盖，否则存错 / 存空的行永远修不回来。绑定了自定义接口的行除外。
          protocol: m.protocol === 'declarative' || preview.protocolId ? m.protocol : hit.protocol,
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
          protocol: preview.protocolId ? stored.protocol : m.protocol, input_modalities: stored.input_modalities ?? m.input_modalities }
          : { name: m.name, id: m.id, modality: resolvedModality(m),
            protocol: m.protocol, input_modalities: m.input_modalities, ...discoveredBinding(resolvedModality(m)) };
      });
    return [...kept, ...added];
  };

  useEffect(() => { currentSelection.current = mergedModels; });

  const applyFetchedSelection = () => {
    if (unresolvedChecked.length) return;
    setModels(mergedModels());
    setPreview(null);
  };

  // 地址格式在输入时内联校验（原来的「测试」按钮只查格式、又和「测试连接」重名，已去掉）。
  const baseUrlInvalid = Boolean(baseUrl.trim()) && !isHttpUrl(baseUrl.trim());

  const toggleShowKey = async () => {
    // 编辑态首次「显示」要先向后端取真实密钥（前端只持有掩码）；取到后回填并切明文。
    if (!showKey && editing && !keyRevealed && initial?.alias) {
      setRevealing(true);
      setError(null);
      try {
        const { access_key } = await revealKey(initial.alias);
        setAccessKey(access_key);
        setRevealedKey(access_key);
        setKeyRevealed(true);
        setShowKey(true);
      } catch (e) {
        setError(toIssue(e));
      } finally {
        setRevealing(false);
      }
      return;
    }
    setShowKey((s) => !s);
  };

  const submit = async () => {
    if (unresolvedChecked.length) return;
    if (models.some(model => [priceText(model), priceInText(model), priceOutText(model)]
      .some(text => parsePrice(text) === undefined))) {
      setError({ message: '单价请填 0 到 10000 之间的数字', raw: null, code: null });
      // 单价在「模型详情」里：收着就先展开，等展开动画走完再把第一个填错的框带到眼前。
      const wasOpen = detailsOpen;
      setDetailsOpen(true);
      window.setTimeout(() => revealInvalidField(formBodyRef.current?.querySelector<HTMLElement>('input[aria-invalid="true"]') ?? null),
        wasOpen ? 0 : MOTION_DURATION.slow * 1000);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const cleanModels = isComfy ? [] : isGateway ? gatewayModels : mergedModels()
        .map((model) => {
          const modality = model.modality ?? 'image' as ModelModality;
          const inputModalities = modality === 'text'
            ? Array.from(new Set<ModelInputModality>(['text', ...(model.input_modalities ?? [])]))
            : model.input_modalities ?? [];
          const bound = provider === 'custom' && model.protocol === 'declarative' && model.declarative_id;
          return {
            name: model.name.trim(),
            id: model.id.trim(),
            modality,
            protocol: bound ? 'declarative' : model.protocol === 'declarative' ? null : model.protocol ?? null,
            input_modalities: inputModalities,
            ...(bound ? { declarative_id: model.declarative_id } : {}),
            ...(modality !== 'text' && parsePrice(priceText(model)) != null ? { per_call_cny: parsePrice(priceText(model)) } : {}),
            ...(modality === 'text' && parsePrice(priceInText(model)) != null ? { input_cny_per_m: parsePrice(priceInText(model)) } : {}),
            ...(modality === 'text' && parsePrice(priceOutText(model)) != null ? { output_cny_per_m: parsePrice(priceOutText(model)) } : {}),
          };
        })
        .filter((model) => model.name && model.id);
      // key 级 modalities 由模型标注派生；存量契约用 llm 表示文本生成能力。
      const derivedModalities = Array.from(new Set([
        ...cleanModels.map((m) => m.modality === 'text' ? 'llm' : m.modality ?? 'image'),
      ]));
      const payload: KeyCreatePayload = {
        alias: submitAlias,
        provider,
        enabled,
        base_url: baseUrl.trim() || null,
        billing_group: billingGroup.trim() || null,
        access_key: isSubscription || isComfy ? '' : accessKey.trim(),
        ...(isSubscription ? { auth_source: 'codex-cli' as const } : {}),
        secret_key: null,
        capabilities: ['portrait', 'promo', 'turnaround'],
        models: cleanModels,
        homepage_url: homepage.trim() || preset.homepageUrl || null,
        docs_url: initial?.docs_url ?? preset.docsUrl ?? null,
        api_key_url: initial?.api_key_url ?? preset.apiKeyUrl ?? null,
        modalities: derivedModalities,
        notes: '',
        ...(textProtocol ? { text_protocol: textProtocol } : {}),
        ...(icon ? { icon } : {}),
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
        if (textProtocol !== (initial.text_protocol ?? null)) patch.text_protocol = textProtocol;
        if (icon !== (initial.icon ?? null)) patch.icon = icon;
        if (!keyEdited) delete patch.access_key;
        if (isComfy) delete patch.models;
        await patchKey(initial.alias, patch);
        onCreated(initial.alias);
      } else {
        const created = await createKey(payload);
        onCreated(created?.alias ?? payload.alias);
      }
    } catch (e) {
      setError(toIssue(e));
    } finally {
      setSaving(false);
    }
  };

  const reserved = usesNamedAlias(provider) ? undefined : { label: preset.label, provider };
  const autoAlias = nextFreeAlias(isGateway ? gatewayName?.trim() || '团队网关'
    : defaultAliasBase({ presetId: activePresetId, presetLabel: preset.label, baseUrl: baseUrl.trim() }), takenAliases, reserved);
  const displayAlias = aliasEdited ? aliasInput : autoAlias;
  const submitAlias = (() => {
    const name = displayAlias.trim();
    if (editing) return initial?.alias ?? name;
    if (isSubscription) return provider;
    if (usesNamedAlias(provider)) return name;
    // 自带 provider 的预置：第一把沿用 provider 作别名（路由、用量里已有的写法），再加的按名称存。
    return name.toLowerCase() === preset.label.toLowerCase() && !aliasTaken(provider, takenAliases) ? provider : name;
  })();
  // 保存禁用时，第一项缺什么写在按钮旁（规格：禁用要说明原因）。
  const blockedReason = (() => {
    if (saving) return null;
    if (isComfy) return baseUrl.trim() ? null : '填写 ComfyUI 地址';
    if (isSubscription) return editing || subscription?.available ? null : subscription ? '先在 Codex 里用 ChatGPT 登录' : null;
    if ((provider === 'custom' || isGateway) && !baseUrl.trim()) return isGateway ? '填写团队网关地址' : '填写请求地址';
    if (baseUrlInvalid) return '请求地址要以 http:// 或 https:// 开头';
    if (keyMissing) return isGateway ? '填写网关密钥' : '填写密钥';
    if (!editing && !displayAlias.trim()) return '填写名称';
    if (!editing && aliasTaken(submitAlias, takenAliases, reserved)) return `名称「${displayAlias.trim()}」已被使用`;
    if (isGateway) {
      if (connecting) return null;
      if (gatewayInfo && gatewayModels.length === 0) return '这把密钥当前没有可用模型';
      if (gatewayModels.length === 0) return gatewayError ? '连接失败，检查地址和密钥' : '连接后才能保存';
    }
    return null;
  })();
  const canSubmit = !saving && !blockedReason && !(isGateway && connecting) && unresolvedChecked.length === 0
    && !(isSubscription && !editing && !subscription?.available);

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
    const run = ++listRun.current;
    setPendingRequest('test');
    setConnectionTest(null);
    const started = performance.now();
    try {
      if (!isHttpUrl(fetchModelsBaseUrl)) throw new Error('请求地址要以 http:// 或 https:// 开头');
      if (isComfy) {
        const result = await checkComfyUI(baseUrl);
        if (run !== listRun.current) return;
        setConnectionTest({ ok: true, message: result.devices.map(device => `${device.name} · ${(device.vram_total / 1024 ** 3).toFixed(1)} GB`).join('、') || '已连接' });
        return;
      }
      const remote = await previewModels({ alias: editing ? initial?.alias ?? null : null, provider,
        base_url: fetchModelsBaseUrl, access_key: keyEdited ? accessKey.trim() : null,
        include_all: false, text_protocol: textProtocol });
      if (run !== listRun.current) return;
      setDetected(remote.detected ?? null);
      setConnectionTest({ ok: true, message: `可用 · ${Math.round(performance.now() - started)} ms` });
      // 普通目录复用连接检测已经拿到的列表；自定义目录仍走其免费 catalog 请求。
      if (catalogProtocolId) await fetchModels(false, run);
      else acceptPreview(remote, false);
    } catch (error) {
      if (run !== listRun.current) return;
      const issue = toIssue(error);
      setConnectionTest({ ok: false, message: issue.message, raw: issue.raw });
      setManualOpen(true);
    } finally { if (run === listRun.current) setPendingRequest(null); }
  };
  // 有未保存的输入时点外面不关、Esc 先问（规格 2.1）；只有「取消」直接放弃。
  // 「显示密钥」取回的原值不算改动：按原来的掩码记入快照。
  const keyForSnapshot = revealedKey !== null && accessKey === revealedKey ? (initial?.access_key ?? '') : accessKey;
  const formSnapshot = JSON.stringify([aliasEdited ? aliasInput : '', baseUrl, billingGroup, homepage, keyForSnapshot,
    textProtocol, icon, enabled, activePresetId, models, preview ? [...fetchedChecked] : null, modalityPick]);
  const initialSnapshot = useRef(formSnapshot);
  const dirty = !saving && formSnapshot !== initialSnapshot.current;
  useEffect(() => {
    const index = focusPriceModel ? models.findIndex(model => model.id === focusPriceModel) : -1;
    if (index < 0) return;
    setDetailsOpen(true);
    const timer = window.setTimeout(() => {
      const field = formBodyRef.current?.querySelector<HTMLElement>(`[aria-label="单价 ${index + 1}"], [aria-label="输入单价 ${index + 1}"]`);
      field?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      field?.focus({ preventScroll: true });
    }, MOTION_DURATION.slow * 1000);
    return () => window.clearTimeout(timer);
  }, [focusPriceModel]); // eslint-disable-line react-hooks/exhaustive-deps
  const typeDot = (modality?: ModelModality | null) => ({ image: 'bg-brand-2', video: 'bg-brand-3', text: 'bg-brand-4', audio: 'bg-muted-foreground' }[modality ?? 'image']);
  const title = editing ? `编辑 ${initial?.alias && initial.alias !== provider ? initial.alias : (PROVIDER_PRESETS.find(p => p.value === provider)?.label ?? initial?.alias ?? '')}` : preset.label;
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
    <Dialog open={open} onOpenChange={next => { if (!next && !saving) onCancel(); }}>
      <DialogContent hideClose dirty={dirty} aria-describedby={undefined} className="flex max-h-[90dvh] max-w-[680px] flex-col gap-0 overflow-hidden p-0">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-4">
          <ProviderIconPicker icon={icon} onChange={setIcon} defaultUrl={defaultIconUrl(homepage || preset.homepageUrl, baseUrl || preset.defaultBaseUrl)}
            display={{ provider, base_url: baseUrl.trim() || preset.defaultBaseUrl, alias: displayAlias.trim() || preset.label }} />
          <DialogTitle className="min-w-0 flex-1 truncate">{title}</DialogTitle>
          {homepage && <a href={homepage} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:text-primary">官网 ↗</a>}
          <Switch size="sm" checked={enabled} onCheckedChange={setEnabled} aria-label={`启用 ${displayAlias || preset.label}`} />
        </header>
        <div ref={formBodyRef} className="min-h-0 overflow-y-auto px-4 py-5 sm:px-6">
          {!editing && !presetId && <div className="mb-5 space-y-2">
            <Label htmlFor="key-provider" className={capLabelClass}>供应商选择</Label>
            <Select value={activePresetId} disabled={fetching || testing || connecting} onValueChange={changeProvider}>
              <SelectTrigger id="key-provider"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PROVIDER_PRESETS.map(p => <SelectItem key={p.id} value={p.id}>{p.kind === 'team' ? p.label : `${p.label} · ${KIND_LABELS[p.kind]}`}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>}
          <div className="grid grid-cols-1 items-start gap-x-4 gap-y-3 sm:grid-cols-[88px_minmax(0,1fr)]">
            {!compact && <>
              <Label htmlFor="key-provider-name" className="pt-2 text-xs text-muted-foreground">名称</Label>
              <Input id="key-provider-name" placeholder={autoAlias || (provider === 'custom' ? '例如：openrouter-image-main' : undefined)}
                value={aliasEdited ? aliasInput : autoAlias} readOnly={editing || isSubscription} onPaste={pasteInvite}
                onChange={e => { setAliasInput(e.target.value); setAliasEdited(true); }} />
            </>}
            {isGateway && <>
              <Label htmlFor="key-gateway-url" className="pt-2 text-xs text-muted-foreground">团队网关地址</Label>
              <Input id="key-gateway-url" value={baseUrl} onPaste={pasteInvite} onChange={e => { changeBaseUrl(e.target.value); setGatewayModels([]); setGatewayInfo(null); }} className="font-mono" placeholder="http://192.168.1.20:5180" />
            </>}
            {userBaseUrl && <>
              <Label htmlFor="key-base-url" className="pt-2 text-xs text-muted-foreground">请求地址</Label>
              <div className="space-y-1">
                <Input id="key-base-url" value={baseUrl} aria-invalid={baseUrlInvalid || undefined} placeholder="https://api.example.com/v1"
                  onChange={e => { changeBaseUrl(e.target.value); setConnectionTest(null); }} className="font-mono" />
                {baseUrlInvalid && <p className="text-xs text-destructive">要以 http:// 或 https:// 开头</p>}
              </div>
            </>}
            {isComfy ? <>
              <Label htmlFor="comfy-address" className="pt-2 text-xs text-muted-foreground">ComfyUI 地址</Label>
              <Input id="comfy-address" value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setConnectionTest(null); }} />
              <span />
              <div className="space-y-2"><Button variant="outline" disabled={testing} onClick={testConnection}><SwapLabel active={testing} on="测试中…" off="测试连接" /></Button>
                {connectionTest && <p key={connectionTest.message} role={connectionTest.ok ? 'status' : 'alert'} className="content-swap-in text-xs text-muted-foreground">{connectionTest.message}</p>}
              </div>
            </> : isSubscription ? <>
              <span className="pt-2 text-xs text-muted-foreground">账号</span>
              <div className="py-2 text-sm">{subscriptionError ? <p role="alert" className="text-destructive">{subscriptionError}</p> : !subscription ? <p role="status" className="text-muted-foreground">加载中…</p> : subscription.available ? <><p>{subscription.email}</p>{subscription.plan && <p className="mt-1 text-xs text-muted-foreground">{subscription.plan}</p>}</> : <p role="status" className="text-muted-foreground">请先在 Codex 里用 ChatGPT 登录</p>}</div>
            </> : <>
            <Label htmlFor="key-access" className="pt-2 text-xs text-muted-foreground">{isGateway ? '网关密钥' : '密钥'}</Label>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <SecretInput id="key-access" revealed={showKey} value={accessKey} onPaste={pasteInvite} onChange={e => { setAccessKey(e.target.value); setKeyRevealed(true); setConnectionTest(null); }} className="pr-10 font-mono" placeholder={editing ? '留空则保留原密钥' : '粘贴密钥'} />
                <Button variant="bare" type="button" aria-label={showKey ? '隐藏密钥' : '显示密钥'} disabled={revealing} onClick={toggleShowKey} className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-md text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary">
                  <SwapIcon swapKey={showKey}>{showKey ? <HideIcon /> : <ShowIcon />}</SwapIcon>
                </Button>
              </div>
              {(initial?.api_key_url || preset.apiKeyUrl) && <a href={initial?.api_key_url || preset.apiKeyUrl} target="_blank" rel="noreferrer" className="whitespace-nowrap text-xs text-primary">获取密钥 ↗</a>}
              <Collapse open={probing || probe === 'ok' || probe === 'invalid'} className="basis-full">
                <p role={probe === 'invalid' ? 'alert' : 'status'} className={`flex items-center gap-1.5 text-xs ${probe === 'ok' ? 'text-[color:var(--status-done)]' : probe === 'invalid' ? 'text-destructive' : 'text-muted-foreground'}`}>
                  <SwapIcon swapKey={probing ? 'probing' : probe ?? 'none'} variant={probe === 'ok' && !probing ? 'pop' : 'subtle'}>
                    {probing ? <LoadingIcon size="sm" className="animate-spin" aria-hidden /> : probe === 'invalid' ? <ErrorIcon size="sm" aria-hidden /> : <CheckIcon size="sm" aria-hidden />}
                  </SwapIcon>
                  {probing ? '校验中…' : probe === 'invalid' ? '密钥无效' : '密钥有效'}
                </p>
              </Collapse>
            </div>
            </>}
            {showInterface && !compact && <>
              <Label htmlFor="key-text-protocol" className="pt-2 text-xs text-muted-foreground">对话接口</Label>
              <div className="flex items-center gap-2">
                <Select value={textProtocol ?? AUTO_INTERFACE} onValueChange={changeInterface}>
                  {/* 选项文字不变；只有选中「自动」时，显示值后面跟识别结果。 */}
                  <SelectTrigger id="key-text-protocol" className="w-56"><SelectValue>{!textProtocol && autoText ? `自动 · ${autoText}` : undefined}</SelectValue></SelectTrigger>
                  <SelectContent>
                    {INTERFACE_OPTIONS.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Hint label={INTERFACE_HELP}><span tabIndex={0} aria-label="对话接口说明" className="text-muted-foreground"><HelpIcon size="sm" /></span></Hint>
              </div>
            </>}
            {!(compact && !isGateway && !isComfy) && <>
            <span className="pt-2 text-xs text-muted-foreground">{isComfy ? '工作流' : '模型'}</span>
            <div className="min-w-0 space-y-3">
              {isComfy ? (editing ? <ComfyWorkflows alias={initial!.alias!} /> : <p className="py-2 text-sm text-muted-foreground">保存后导入工作流</p>) : isSubscription ? <p className="py-2 text-sm">GPT Image</p> : isGateway ? <>
                {/* 地址和密钥齐了自动连接；连过之后才留一个「重新同步」。 */}
                {connecting && !gatewayInfo && !gatewayError && <p role="status" className="py-2 text-sm text-muted-foreground">连接中…</p>}
                {(gatewayInfo || gatewayError) && <Button variant="ghost" size="sm" type="button" onClick={() => void connectGateway()} disabled={!baseUrl.trim() || connecting}><SwapLabel active={connecting} on="连接中…" off={gatewayModels.length ? '重新同步' : '重新连接'} /></Button>}
                {gatewayInfo && <p role="status" className="text-sm text-muted-foreground">{gatewayInfo}</p>}
                <IssueText issue={gatewayError} />
                <ul aria-label="团队网关模型" className="flex flex-wrap gap-2">{gatewayModels.map(model => <li key={model.id} className="rounded-full border border-border px-3 py-1 text-xs">{model.name}<span className="ml-2 text-muted-foreground">{(model.via ?? []).map(item => item.alias).join(' · ')}</span></li>)}</ul>
              </> : <>
                <div className="flex flex-wrap items-center gap-2">
                  <ToggleGroup type="single" size="sm" variant="outline" sliding aria-label="模型范围" className="shrink-0" value={preview ? 'all' : 'selected'}
                    onValueChange={value => { if (value === 'selected') applyFetchedSelection(); else if (value === 'all') void fetchModels(); }}>
                    <ToggleGroupItem value="selected" disabled={unresolvedChecked.length > 0}>已选 {mergedModels().filter(m => m.id.trim()).length}</ToggleGroupItem>
                    <ToggleGroupItem value="all" disabled={fetching || testing}>全部</ToggleGroupItem>
                  </ToggleGroup>
                  {!preview && <Input aria-label="筛选模型" placeholder="筛选模型" value={modelQuery} onChange={e => setModelQuery(e.target.value)} className="min-w-0 flex-1 basis-28" />}
                  {catalogInterfaces.length > 0 && <Select value={catalogProtocolId ?? DEFAULT_CATALOG} onValueChange={value => setCatalogSource(value === DEFAULT_CATALOG ? '' : value)}>
                    <SelectTrigger size="sm" aria-label="模型目录" className="w-auto"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_CATALOG}>/models</SelectItem>
                      {catalogInterfaces.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
                    </SelectContent>
                  </Select>}
                  <Button variant="ghost" size="sm" type="button" disabled={fetching || testing || !fetchModelsBaseUrl} onClick={() => void fetchModels()}><SwapLabel active={fetching} on="获取中…" off="重新获取" /></Button>
                </div>
                <Collapse open={Boolean(fetchError)}><IssueText issue={shownFetchError} /></Collapse>
                {preview ? <div className="min-w-0 space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>上游 {preview.total} 个模型</span>
                    {preview.discovered && <span>已发现不代表可用</span>}
                    {(preview.excluded > 0 || preview.includeAll) && <>
                      <span>{preview.includeAll ? '已显示全部，含不可生成模型' : `已过滤 ${preview.excluded} 个不可生成模型`}</span>
                      <Button variant="link" size="sm" type="button" disabled={fetching || testing} onClick={() => fetchModels(!preview.includeAll)} className="h-auto px-0 text-xs text-muted-foreground hover:text-foreground">{preview.includeAll ? '只看可生成模型' : '显示全部'}</Button>
                    </>}
                  </div>
                  <Input aria-label="搜索模型" placeholder="筛选模型" value={pickerQuery} onChange={e => setPickerQuery(e.target.value)} />
                  <ToggleGroup type="single" size="sm" sliding aria-label="模型类型筛选" className="flex-wrap" value={pickerFilter}
                    onValueChange={value => { if (value) setPickerFilter(value as typeof pickerFilter); }}>
                    {pickerFilters.map(filter => <ToggleGroupItem key={filter} value={filter}>{filter === 'all' ? '全部' : CATEGORY_LABELS[filter]} {pickerCounts(filter)}</ToggleGroupItem>)}
                  </ToggleGroup>
                  <div className="flex max-h-56 flex-wrap content-start items-start gap-2 overflow-auto">
                    {pickerVisible.map(model => <div key={model.id} className="max-w-full space-y-2">
                      <Hint label={model.name}><Toggle size="sm" variant="outline" pressed={fetchedChecked.has(model.id)} aria-label={`${model.name} ${model.id}`} onPressedChange={() => {
                        const next = new Set(fetchedChecked);
                        if (next.has(model.id)) next.delete(model.id); else next.add(model.id);
                        setFetchedChecked(next);
                      }} className="max-w-full rounded-full px-3 font-mono font-normal aria-pressed:border-primary/40 aria-pressed:bg-primary/10 aria-pressed:text-foreground">
                        {/* 勾与类型圆点占同一个 16px 槽位：勾选时标签宽度不变，旁边的标签不跟着挪。 */}
                        <SwapIcon swapKey={fetchedChecked.has(model.id)} variant="pop" className="size-4">
                          {fetchedChecked.has(model.id) ? <CheckIcon size="sm" aria-hidden /> : <span aria-hidden className={`size-1.5 rounded-full ${typeDot(resolvedModality(model))}`} />}
                        </SwapIcon><span className="truncate">{model.id}</span>
                      </Toggle></Hint>
                      {!model.modality && fetchedChecked.has(model.id) && <ToggleGroup type="single" size="sm" aria-label={`分类 ${model.id}`} className="flex-wrap"
                        value={modalityPick[model.id] ?? ''}
                        onValueChange={value => { if (value) setModalityPick({ ...modalityPick, [model.id]: value as ModelModality }); }}>
                        {GENERATION_MODALITIES.map(modality => <ToggleGroupItem key={modality} value={modality}>{CATEGORY_LABELS[modality]}</ToggleGroupItem>)}
                      </ToggleGroup>}
                    </div>)}
                    {pickerVisible.length === 0 && <p className="text-xs text-muted-foreground">没有匹配的模型</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>已选 {fetchedChecked.size} 个模型</span>
                    <Button variant="link" size="sm" className="h-auto px-0 text-xs text-muted-foreground hover:text-foreground" type="button" onClick={selectAllVisible} disabled={!pickerVisible.length}>全选当前 {pickerVisible.length} 个</Button>
                    <Button variant="link" size="sm" type="button" onClick={() => setFetchedChecked(new Set())} disabled={!fetchedChecked.size} className="h-auto px-0 text-xs text-muted-foreground hover:text-foreground">清空选择</Button>
                    <Button variant="link" size="sm" type="button" onClick={applyFetchedSelection} disabled={unresolvedChecked.length > 0} className="h-auto px-0 text-xs text-muted-foreground hover:text-foreground">启用所选（{fetchedChecked.size}）</Button>
                    {unresolvedChecked.length > 0 && <span className="text-destructive">{unresolvedChecked.length} 个未识别模型待指定分类</span>}
                  </div>
                </div> : <div className="flex max-h-56 flex-wrap gap-2 overflow-auto">
                  {models.filter(m => m.id.trim() && `${m.id} ${m.name}`.toLowerCase().includes(modelQuery.toLowerCase())).map((model, index) => <Button variant="bare" key={`${model.id}-${index}`} type="button" aria-pressed="true" onClick={() => setModels(models.filter(m => m !== model))} className="flex max-w-full items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-xs">
                    <CheckIcon size="sm" aria-hidden /><span className="truncate">{model.id}</span><CloseIcon size="sm" aria-hidden />
                  </Button>)}
                </div>}
                {provider === 'custom' && <Disclosure summary="手动添加模型" open={manualOpen} onOpenChange={setManualOpen}>
                  <div className="mt-3 flex flex-wrap gap-2">
                  <Input aria-label="添加模型 ID" placeholder="添加模型 ID" value={manualId} onChange={e => setManualId(e.target.value)} className="min-w-0 flex-1 basis-28 font-mono" />
                  <Select value={manualType} onValueChange={value => setManualType(value as ModelModality)}>
                    <SelectTrigger aria-label="新增模型类型" className="w-auto"><SelectValue /></SelectTrigger>
                    <SelectContent>{GENERATION_MODALITIES.map(type => <SelectItem key={type} value={type}>{CATEGORY_LABELS[type]}</SelectItem>)}</SelectContent>
                  </Select>
                  <Button variant="ghost" size="sm" type="button" disabled={!manualId.trim() || models.some(m => m.id === manualId.trim())} onClick={addManualModel}>添加</Button>
                  </div>
                </Disclosure>}
                <Disclosure summary="模型详情" open={detailsOpen} onOpenChange={setDetailsOpen}>
                  <div className="mt-3 space-y-3">
                    <Button variant="ghost" size="sm" type="button" onClick={() => { setDetailsOpen(true); pendingModelFocus.current = models.length; setModels([...models, { name: '', id: '' }]); }}>添加模型</Button>
                <div className="mb-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <span>模型别名</span>
                  <span>模型 ID</span>
                </div>
                <div className="space-y-2">
                  {models.map((model, index) => (
                    <div key={model._rowId} className="grid grid-cols-2 items-start gap-2">
                      <Label className="sr-only" htmlFor={`key-model-name-${index}`}>模型名称 {index + 1}</Label>
                      <Input
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

                        placeholder="给人看的名字，例如：图片 5.0"
                      />
                      <Label className="sr-only" htmlFor={`key-model-id-${index}`}>模型 ID {index + 1}</Label>
                      <Input
                        id={`key-model-id-${index}`}
                        aria-label={`模型 ID ${index + 1}`}
                        value={model.id}
                        onChange={(e) => setModels(models.map((m, i) => i === index ? { ...m, id: e.target.value } : m))}
                        className="font-mono"
                        placeholder="请求里使用的 ID，例如：doubao-seedream-5-0-260128"
                      />
                      <div className="space-y-1.5">
                        {isLocked(model) ? (
                          /* 已存在的模型分类固化为只读徽标——添加完成后不允许再调分类。 */
                          <div role="group" aria-label={`模型分类 ${index + 1}`} className="flex items-center">
                            {/* 各分类同一种外观，靠与上方模型标签相同的类型圆点区分。 */}
                            <span className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-foreground">
                              <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${typeDot(model.modality)}`} />
                              {CATEGORY_LABELS[model.modality ?? 'image']}
                            </span>
                          </div>
                        ) : (
                          <ToggleGroup type="single" size="sm" variant="outline" aria-label={`模型分类 ${index + 1}`}
                            value={model.modality ?? 'image'}
                            onValueChange={value => {
                              if (!value) return;
                              const mod = value as ModelModality;
                              setModels(models.map((m, i) => i === index ? {
                                ...m,
                                modality: mod,
                                input_modalities: mod === 'text' ? ['text'] : [],
                                // 换了分类，原来绑定的自定义接口类型就对不上了。
                                ...(m.protocol === 'declarative' ? { protocol: null, declarative_id: null } : {}),
                              } : m));
                            }}
                          >
                            {GENERATION_MODALITIES.map((mod) => <ToggleGroupItem key={mod} value={mod}>{CATEGORY_LABELS[mod]}</ToggleGroupItem>)}
                          </ToggleGroup>
                        )}
                        {provider === 'custom' && (model.modality === 'image' || model.modality === 'video') && (
                          <InterfacePicker
                            index={index}
                            model={model}
                            interfaces={interfaces}
                            onBind={(identifier) => setModels(models.map((m, i) => i === index
                              ? { ...m, protocol: identifier ? 'declarative' : null, declarative_id: identifier } : m))}
                            onEdit={(identifier) => setInterfaceEditor({ index, identifier, kind: model.modality as HttpProtocolKind })}
                          />
                        )}
                        {(model.modality ?? 'image') === 'text' && (
                          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                            <span>理解输入</span>
                            {TEXT_INPUT_MODALITIES.map(([inputModality, label]) => (
                              <Label key={inputModality} className="flex items-center gap-1.5">
                                <Checkbox
                                  checked={(model.input_modalities ?? []).includes(inputModality)}
                                  onCheckedChange={(checked) => setModels(models.map((current, i) => {
                                    if (i !== index) return current;
                                    const currentInputs = new Set<ModelInputModality>(
                                      current.input_modalities ?? ['text'],
                                    );
                                    currentInputs.add('text');
                                    if (checked === true) currentInputs.add(inputModality);
                                    else currentInputs.delete(inputModality);
                                    return { ...current, input_modalities: Array.from(currentInputs) };
                                  }))}
                                />
                                {label}
                              </Label>
                            ))}
                          </div>
                        )}
                        {model.unpriced && (model.modality ?? 'image') === 'text' && (
                          <div className="flex items-center gap-1.5">
                            <Input
                              aria-label={`输入单价 ${index + 1}`}
                              aria-invalid={parsePrice(priceInText(model)) === undefined || undefined}
                              inputMode="decimal"
                              value={priceInText(model)}
                              onChange={(e) => setModels(models.map((m, i) => i === index ? { ...m, _priceIn: e.target.value } : m))}
                              placeholder="输入"
                              className="h-7 w-16 text-xs"
                            />
                            <Input
                              aria-label={`输出单价 ${index + 1}`}
                              aria-invalid={parsePrice(priceOutText(model)) === undefined || undefined}
                              inputMode="decimal"
                              value={priceOutText(model)}
                              onChange={(e) => setModels(models.map((m, i) => i === index ? { ...m, _priceOut: e.target.value } : m))}
                              placeholder="输出"
                              className="h-7 w-16 text-xs"
                            />
                            <span className="text-xs text-muted-foreground">元/百万 token</span>
                            <Hint label={TEXT_PRICE_HELP}><span tabIndex={0} aria-label="单价说明" className="text-muted-foreground"><HelpIcon size="sm" /></span></Hint>
                          </div>
                        )}
                        {model.unpriced && (model.modality ?? 'image') !== 'text' && (
                          <div className="flex items-center gap-1.5">
                            <Input
                              aria-label={`单价 ${index + 1}`}
                              aria-invalid={parsePrice(priceText(model)) === undefined || undefined}
                              inputMode="decimal"
                              value={priceText(model)}
                              onChange={(e) => setModels(models.map((m, i) => i === index ? { ...m, _price: e.target.value } : m))}
                              placeholder="单价"
                              className="h-7 w-20 text-xs"
                            />
                            <span className="text-xs text-muted-foreground">元/次</span>
                            <Hint label={PRICE_HELP}><span tabIndex={0} aria-label="单价说明" className="text-muted-foreground"><HelpIcon size="sm" /></span></Hint>
                          </div>
                        )}
                        {showInterface && !textProtocol && (model.modality ?? 'image') === 'text' && model.protocol
                          && model.protocol !== 'declarative' && model.protocol !== (detected?.protocol ?? 'openai-chat') && (
                          <div className="text-xs text-muted-foreground">对话接口：{INTERFACE_LABELS.get(model.protocol) ?? model.protocol}</div>
                        )}
                        {model.agent_unverified && (
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            不进 Agent
                            <Hint label={AGENT_UNVERIFIED_HELP}><span tabIndex={0} aria-label="不进 Agent 说明" className="text-muted-foreground"><HelpIcon size="sm" /></span></Hint>
                          </div>
                        )}
                      </div>
                      <Button variant="bare"
                        type="button"
                        onClick={() => setModels(models.filter((_, i) => i !== index))}
                        disabled={models.length === 1}
                        aria-label={`删除模型 ${index + 1}`}
                        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-destructive disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                      >
                        <CloseIcon size="sm" aria-hidden />
                      </Button>
                    </div>
                  ))}
                </div>

                  </div>
                </Disclosure>
              </>}
            </div>
            </>}
            {!isGateway && !isSubscription && !isComfy && !compact && <>
              <span className="pt-2 text-xs text-muted-foreground">连接</span>
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="outline" type="button" onClick={testConnection} disabled={testing || fetching || !fetchModelsBaseUrl || baseUrlInvalid || keyMissing}><SwapLabel active={testing} on="测试中…" off="测试连接" /></Button>
                  {connectionTest?.ok && <span key={connectionTest.message} role="status" className="content-swap-in text-xs text-[color:var(--status-done)]">{connectionTest.message}</span>}
                </div>
                {connectionTest && !connectionTest.ok && <IssueText key={connectionTest.message} className="content-swap-in text-xs" issue={{ message: connectionTest.message, raw: connectionTest.raw ?? null, code: null }} />}
              </div>
              <Disclosure summary={userBaseUrl ? '高级：计费分组 · 官网' : '高级：请求地址 · 计费分组'} className="col-span-full border-t border-border pt-3">
                <div className="mt-3 grid grid-cols-1 items-center gap-3 sm:grid-cols-[88px_minmax(0,1fr)]">
                  {!userBaseUrl && <>
                    <Label htmlFor="key-base-url" className="text-xs text-muted-foreground">请求地址</Label>
                    <div className="space-y-1">
                      <Input id="key-base-url" value={baseUrl} aria-invalid={baseUrlInvalid || undefined} onChange={e => { changeBaseUrl(e.target.value); setConnectionTest(null); }} className="font-mono" />
                      {baseUrlInvalid && <p className="text-xs text-destructive">要以 http:// 或 https:// 开头</p>}
                    </div>
                  </>}
                  <Label htmlFor="key-billing-group" className="text-xs text-muted-foreground">计费分组（可选）</Label>
                  <Input id="key-billing-group" value={billingGroup} onChange={e => setBillingGroup(e.target.value)} placeholder="default" />
                  {provider === 'custom' && <><Label htmlFor="key-homepage" className="text-xs text-muted-foreground">官网链接</Label><Input id="key-homepage" value={homepage} onChange={e => setHomepage(e.target.value)} /></>}
                </div>
              </Disclosure>
            </>}
          </div>
        </div>
        {shownInterfaceEditor && <CustomInterfaceDialog
          key={shownInterfaceEditor.session}
          open={Boolean(interfaceEditor)}
          identifier={shownInterfaceEditor.value.identifier}
          kind={shownInterfaceEditor.value.kind}
          baseUrl={baseUrl.trim() || undefined}
          model={models[shownInterfaceEditor.value.index]?.id.trim() || undefined}
          onClose={() => setInterfaceEditor(null)}
          onSaved={(saved) => {
            const { index } = shownInterfaceEditor.value;
            setModels(current => current.map((m, i) => i === index
              ? { ...m, protocol: 'declarative', declarative_id: saved.id } : m));
            setInterfaceEditor(null);
            void reloadInterfaces().catch(() => undefined);
          }}
        />}
        <Collapse open={Boolean(error)}><IssueText issue={shownError} className="px-6 pb-3" /></Collapse>
        <footer className="flex shrink-0 items-center gap-2 border-t border-border px-6 py-4">
          {onDelete && <Button variant="bare" type="button" onClick={onDelete} disabled={saving} className="rounded-md px-3 py-2 text-sm text-destructive">删除</Button>}
          <span className="flex-1" />
          {blockedReason && <span className="text-xs text-muted-foreground">{blockedReason}</span>}
          <Button variant="ghost" size="sm" type="button" onClick={onCancel} disabled={saving}>取消</Button>
          <Button type="button" onClick={submit} disabled={!canSubmit} className="px-5"><SwapLabel active={saving} on="保存中…" off={submitLabel} /></Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/** 表单报错：一句原因；有上游原文时收进「查看技术详情」（规格 2.2）。 */
function IssueText({ issue, className }: { issue: FormIssue | null; className?: string }) {
  if (!issue) return null;
  return <div role="alert" className={cn('space-y-1 text-sm text-destructive', className)}>
    <p>{issue.message}</p>
    {issue.raw && <Disclosure summary="查看技术详情">
      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">{issue.raw}</pre>
    </Disclosure>}
  </div>;
}

const BUILTIN_INTERFACE = '__builtin';
const DEFAULT_CATALOG = '__models';
const NEW_INTERFACE = '__new';

/** 模型行的「接口」：默认走内置调用，或绑定一份同类型的自定义接口（ADR-0036）。 */
function InterfacePicker({ index, model, interfaces, onBind, onEdit }: {
  index: number;
  model: EditableModel;
  interfaces: HttpProtocolRow[];
  onBind: (identifier: string | null) => void;
  onEdit: (identifier: string | null) => void;
}) {
  const bound = model.protocol === 'declarative' ? model.declarative_id ?? null : null;
  const options = interfaces.filter(item => item.kind === model.modality && (item.available || item.id === bound));
  const missing = bound && !options.some(item => item.id === bound);
  return (
    <div className="flex items-center gap-2">
      <Select value={bound ?? BUILTIN_INTERFACE} onValueChange={value => {
        if (value === NEW_INTERFACE) onEdit(null);
        else onBind(value === BUILTIN_INTERFACE ? null : value);
      }}>
        <SelectTrigger size="sm" aria-label={`模型接口 ${index + 1}`} className="w-auto"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={BUILTIN_INTERFACE}>默认接口</SelectItem>
          {missing && <SelectItem value={bound}>{model.declared?.name ?? '自定义接口'}</SelectItem>}
          {options.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
          <SelectItem value={NEW_INTERFACE}>新建自定义接口…</SelectItem>
        </SelectContent>
      </Select>
      {bound && <Button variant="ghost" size="sm" type="button" onClick={() => onEdit(bound)}>编辑</Button>}
    </div>
  );
}
