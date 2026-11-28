import { useEffect, useRef, useState } from 'react';
import { listKeys, modelModality, type KeyView } from '@/api/keys';
import { remoteProjectPath } from '@/api/collab';
import { ApiError, requestJson } from '@/api/http';
import { ProviderBrandIcon } from '@/components/ProviderBrandIcon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { SwapLabel } from '@/components/ui/swap-label';
import { Collapse } from '@/components/ui/collapse';
import { useRetained } from '@/components/ui/retained';
import type { CanvasFrozenGeneration, CanvasNode } from '@/schema/canvas';
import { supportsLayerDecomposition } from './canvasLayerDecomposition';
import { isEditModel } from './imageEditGeometry';
import { estimateGenerationCostForSubmission, formatGenerationCost } from '@/lib/generationCost';
import type { JobParams } from '@/schema/jobs';
import { errorText } from '@/lib/errorText';
import { shakeOnError } from '@/lib/motion';

interface Choice {
  channel_id: string; model: string; name: string; mode: string; provider: string;
  icon?: string | null; cost_cny?: number | null; provider_label?: string;
  cost_unit?: string; unit_cost_cny?: number | null;
  supported_operations?: ('inpaint' | 'outpaint' | 'layer_decomposition')[];
  input_cny_per_m?: number | null; output_cny_per_m?: number | null;
  /** 自己的供应商：留着密钥配置，按最终提交参数本地估价。 */
  key?: KeyView;
}

type Source = 'local' | 'borrowed';

interface SubmissionAttempt {
  source: Source;
  body: {
    request_id: string; expected_revision: number; surface_node_id: string;
    model: string; prompt: string; requested_count: number; params: Record<string, unknown>;
    channel_id?: string; alias?: string;
  };
  /** 这次提交的表单内容（供应商、渠道、模型、提示词、张数）：同样内容重试沿用同一个 request_id。 */
  intent: string;
  at: number;
  refreshRevision?: boolean;
}

/** 提交记录按 request_id 存（命名空间：房主 + 项目 + 节点）。只有确定的终态（成功、或服务端明确拒绝不会受理）才删；
 *  502、超时、断网都不算终态，同样内容再提交沿用原 request_id，房主按它去重，不会重复计费。
 *  每个回执只改自己 request_id 那条，不碰别的。 */
const MAX_ATTEMPTS = 20;

function readAttempts(key: string): Record<string, SubmissionAttempt> {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch { return {}; }
}

function writeAttempt(key: string, attempt: SubmissionAttempt) {
  const rows = Object.values({...readAttempts(key), [attempt.body.request_id]: attempt})
    .sort((a, b) => b.at - a.at).slice(0, MAX_ATTEMPTS);
  sessionStorage.setItem(key, JSON.stringify(Object.fromEntries(rows.map(row => [row.body.request_id, row]))));
}

function removeAttempt(key: string, requestId: string) {
  const rows = readAttempts(key);
  if (!(requestId in rows)) return;
  delete rows[requestId];
  if (Object.keys(rows).length) sessionStorage.setItem(key, JSON.stringify(rows));
  else sessionStorage.removeItem(key);
}

function latestAttempt(key: string): SubmissionAttempt | null {
  return Object.values(readAttempts(key)).sort((a, b) => b.at - a.at)[0] ?? null;
}

function intentOf(source: Source, channel: string, model: string, prompt: string, count: number) {
  return JSON.stringify([source, channel, model, prompt, count]);
}

/** 服务端明确拒绝、同一个 request_id 再发也不会受理：版本冲突（409）、超时与限流不算，留着记录重试。 */
function isFinalRejection(reason: unknown) {
  return reason instanceof ApiError && reason.status >= 400 && reason.status < 500
    && ![408, 409, 425, 429].includes(reason.status);
}

/** 打开过、还没提交的提示词草稿（键含房主、项目、节点）：房主重启要重新鉴权时操作条会卸载，重新打开时恢复文字。
 *  每次打开一个会话号，关闭或提交成功只清自己那一份，旧回执不会清掉新稿。
 *  渠道与模型不进草稿：一律等目录加载完，按上次提交记录或默认值选，不静默换渠道。 */
interface OpenDraft { session: number; prompt: string; prefill: string; count: number }
const openDrafts = new Map<string, OpenDraft>();
let draftSessions = 0;

function priceLabel(model: Choice) {
  // 房主目录的视频价按固定示例规格算，不是这次的价格。
  if (model.cost_cny != null) return formatGenerationCost(model.cost_cny)
    + (model.cost_unit === 'song' ? '/首' : model.mode === 'video' ? '（5 秒 720p 示例）' : '/次');
  if (model.cost_unit === '1000_chars' && model.unit_cost_cny != null) return formatGenerationCost(model.unit_cost_cny) + '/千字';
  if (model.cost_unit === 'million_tokens') {
    const rates = [];
    if (model.input_cny_per_m != null) rates.push('输入 ' + formatGenerationCost(model.input_cny_per_m));
    if (model.output_cny_per_m != null) rates.push('输出 ' + formatGenerationCost(model.output_cny_per_m));
    return rates.length ? rates.join('、') + '/百万 token' : '';
  }
  return '';
}

export function SharedCanvasGenerate({ peerKey, projectId, node, frozen, revision, owner, allowBorrow, disabled = false, hasInputs = false }: {
  peerKey: string; projectId: string; node: CanvasNode; frozen?: CanvasFrozenGeneration | null; revision: number; owner: string; allowBorrow: boolean;
  disabled?: boolean;
  /** 节点有连线输入（含分组）：提交时房主会展开带上，估价算不准，不显示总价。 */
  hasInputs?: boolean;
}) {
  const storageKey = 'shared-generation:' + JSON.stringify([peerKey, projectId, node.id]);
  const session = useRef(0);
  const alive = useRef(true);
  /** 回执回来时表单的最新内容：只收起仍停在提交那份内容上的弹窗。 */
  const latestForm = useRef<{intent: string | null; prompt: string; count: number}>({intent: null, prompt: '', count: 1});
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [open, setOpen] = useState(false);
  const draft = 'generation_draft' in node.data ? node.data.generation_draft : null;
  const mode = draft?.mode ?? (node.type === 'layer_stack' || node.type === 'image_edit' ? 'image' : node.type);
  const operation = node.type === 'image_edit' ? node.data.options.mode
    : node.type === 'layer_stack' ? 'layer_decomposition' : null;
  const [mine, setMine] = useState<Choice[]>([]);
  const [host, setHost] = useState<Choice[]>([]);
  const [source, setSource] = useState<Source>('local');
  const [chosen, setChosen] = useState('');
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const submitButton = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState('');
  const shownError = useRetained(error || null);
  const [prompt, setPrompt] = useState('');
  const [prefill, setPrefill] = useState('');
  const [count, setCount] = useState(1);
  const base = remoteProjectPath(peerKey, projectId);
  // 打开期间随改随记；卸载（重新鉴权）不清。
  useEffect(() => {
    if (open) openDrafts.set(storageKey, {session: session.current, prompt, prefill, count});
  }, [open, prompt, prefill, count, storageKey]);
  function changeOpen(next: boolean) {
    if (!next && openDrafts.get(storageKey)?.session === session.current) openDrafts.delete(storageKey);
    setOpen(next);
  }
  useEffect(() => {
    if (!open) return;
    let active = true;
    setError('');
    setLoading(true);
    setMine([]); setHost([]);
    Promise.allSettled([
      listKeys().then(({keys}) => keys.filter(key => key.enabled !== false).flatMap(key =>
        key.models.filter(model => {
          if (modelModality(model, key) !== mode) return false;
          if (operation === 'layer_decomposition') return supportsLayerDecomposition(key, model);
          return !operation || isEditModel(model, key, operation);
        }).map(model => ({
          channel_id: key.alias, model: model.id, name: model.name, provider: key.provider, provider_label: key.alias, mode, icon: key.icon, key,
        })))),
      allowBorrow ? requestJson<{models: Choice[]}>(base + '/borrowable-models', '读取房主供应商').then(
        result => result.models.filter(model => model.mode === mode && (!operation || model.supported_operations?.includes(operation)))) : Promise.resolve([]),
    ]).then(([mineResult, hostResult]) => {
      if (!active) return;
      const local = mineResult.status === 'fulfilled' ? mineResult.value : [];
      const remote = hostResult.status === 'fulfilled' ? hostResult.value : [];
      const failure = [mineResult, hostResult].find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') setError(errorText(failure.reason));
      setMine(local); setHost(remote);
      const saved = latestAttempt(storageKey);
      setSource(saved?.source ?? (!local.length && remote.length ? 'borrowed' : 'local'));
      setChosen(saved ? JSON.stringify([saved.body.channel_id ?? saved.body.alias, saved.body.model]) : '');
    }).catch(reason => { if (active) setError(errorText(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, base, mode, allowBorrow, operation, storageKey]);
  if (!['image','video','text','audio','image_edit','layer_stack'].includes(node.type)) return null;
  const choices = source === 'borrowed' ? host : mine;
  const value = (model: Choice) => JSON.stringify([model.channel_id, model.model]);
  const original = draft?.model || frozen?.model_id || (node.type === 'layer_stack' ? node.data.model : null);
  const choice = chosen ? choices.find(item => value(item) === chosen)
    : choices.find(item => item.model === original) ?? (!original ? choices[0] : undefined);
  // 总价只在没有任何连线输入、且是自己的供应商时按最终提交参数估；视频缺时长就不估。
  // 房主目录价是示例规格，不当总价显示，单价留在模型菜单里。
  const params = {...(frozen?.params ?? {}), ...(draft?.params ?? {}), n: count} as JobParams;
  const estimate = choice?.key && !hasInputs && (mode === 'image' || (mode === 'video' && params.duration != null))
    ? estimateGenerationCostForSubmission(choice.key, choice.model, mode, params)
    : null;
  const currentIntent = choice ? intentOf(source, choice.channel_id, choice.model, prompt, count) : null;
  latestForm.current = {intent: currentIntent, prompt, count};
  async function submit() {
    if (!choice || !currentIntent || submitting.current) return;
    submitting.current = true;
    setPending(true); setError('');
    const intent = currentIntent;
    const submitSession = session.current;
    // Only the form controls express a new intent. Live results can change every other default.
    const previous = Object.values(readAttempts(storageKey)).filter(row => row.intent === intent).sort((a, b) => b.at - a.at)[0];
    const body = previous ? {...previous.body, expected_revision: previous.refreshRevision ? revision : previous.body.expected_revision} : {
      request_id: crypto.randomUUID().replaceAll('-', ''), expected_revision: revision,
      surface_node_id: node.id, model: choice.model, requested_count: count, prompt,
      params: {...(frozen?.params ?? {}), ...(draft?.params ?? {})},
      ...(source === 'borrowed' ? {channel_id: choice.channel_id} : {alias: choice.channel_id}),
    };
    const attempt: SubmissionAttempt = {source, body, intent, at: Date.now()};
    writeAttempt(storageKey, attempt);
    setChosen(value(choice));
    try {
      await requestJson(base + '/runs/' + source, '提交共享生成', {
        method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body),
      });
      // 成功：只清自己这条记录，只收起仍停在这份内容上的弹窗与草稿。
      removeAttempt(storageKey, body.request_id);
      const kept = openDrafts.get(storageKey);
      if (kept && kept.prompt === body.prompt && kept.count === body.requested_count) openDrafts.delete(storageKey);
      if (alive.current && session.current === submitSession && latestForm.current.intent === intent) changeOpen(false);
    } catch (reason) {
      if (isFinalRejection(reason)) removeAttempt(storageKey, body.request_id);
      // The next click can accept a newer revision while keeping the same billing intent.
      else if (reason instanceof ApiError && reason.status === 409 && readAttempts(storageKey)[body.request_id]) {
        writeAttempt(storageKey, {...attempt, refreshRevision: true});
      }
      if (alive.current && session.current === submitSession) {
        setError(errorText(reason));
        shakeOnError(submitButton.current);
      }
    }
    finally { if (alive.current) setPending(false); submitting.current = false; }
  }
  return <>
    <Button size="sm" disabled={disabled} onClick={() => {
      session.current = ++draftSessions;
      // 目录没回来之前提交一直禁用。
      setLoading(true);
      const kept = openDrafts.get(storageKey);
      if (kept) { setPrompt(kept.prompt); setPrefill(kept.prefill); setCount(kept.count); setOpen(true); return; }
      const saved = latestAttempt(storageKey)?.body;
      const initialPrompt = saved?.prompt ?? (draft?.prompt || frozen?.prompt || (node.type === 'layer_stack' ? node.data.prompt : ''));
      setPrompt(initialPrompt); setPrefill(initialPrompt);
      setCount(saved?.requested_count ?? Math.max(1, Math.min(4, Number(draft?.params.n ?? frozen?.params.n) || 1)));
      setOpen(true);
    }}>生成…</Button>
    <Dialog open={open} onOpenChange={changeOpen}><DialogContent aria-describedby={undefined} dirty={prompt !== prefill}>
      <DialogHeader><DialogTitle>{node.type === 'layer_stack' ? '拆分图层' : node.type === 'image_edit' ? '图片编辑' : '生成'}</DialogTitle></DialogHeader>
      {(allowBorrow || source === 'borrowed') && <Tabs value={source} onValueChange={next => { setSource(next === 'borrowed' ? 'borrowed' : 'local'); setChosen(''); }}>
        <TabsList><TabsTrigger value="local">我的供应商</TabsTrigger><TabsTrigger value="borrowed" disabled={!allowBorrow}>房主供应商</TabsTrigger></TabsList>
      </Tabs>}
      <Select value={choice ? value(choice) : ''} onValueChange={setChosen} disabled={loading || pending}>
        <SelectTrigger aria-label="生成模型"><SelectValue placeholder={loading ? '加载中…' : '选择可用模型'} /></SelectTrigger>
        <SelectContent>{choices.map(item => <SelectItem key={value(item)} value={value(item)}>
          <span className="inline-flex items-center gap-2"><ProviderBrandIcon size="sm" provider={{provider:item.provider, icon:item.icon}} />
            {item.name} · {item.provider_label || item.provider}{priceLabel(item) && ' · ' + priceLabel(item)}</span>
        </SelectItem>)}</SelectContent>
      </Select>
      {!loading && !error && !choices.length && <p className="text-xs text-muted-foreground">
        {operation === 'inpaint' ? '当前供应商没有支持局部修改的模型' : operation === 'outpaint'
          ? '当前供应商没有支持扩图的模型' : operation === 'layer_decomposition' ? '当前供应商没有支持图层拆分的模型' : '当前供应商没有可用模型'}
      </p>}
      {!loading && choices.length > 0 && original && !choice && <p className="text-xs text-muted-foreground">原模型为 {original}，请选择可用模型</p>}
      <Textarea aria-label="提示词" value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={event => {
        // 与画布提示词框一致：⌘↵ / Ctrl+↵ 生成，Enter 换行，输入法组合期间不处理。
        if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
        event.preventDefault();
        if (!loading && !pending && !disabled && choice) void submit();
      }} />
      {['image', 'text'].includes(node.type) && <div className="flex items-center justify-between gap-3">
        <span className="text-sm">生成数量</span>
        <Segmented aria-label="生成数量" className="w-40 grid-cols-4">{[1, 2, 3, 4].map(value =>
          <SegmentedItem key={value} value={String(value)} selected={count === value} onSelect={() => setCount(value)}>{value}</SegmentedItem>)}
        </Segmented>
      </div>}
      {source === 'borrowed' && <p className="text-sm">本次生成使用房主（{owner}）的供应商</p>}
      <Collapse open={Boolean(error)}><p role="alert" className="text-sm text-destructive">{shownError}</p></Collapse>
      <div className="flex items-center justify-end gap-3">
        {estimate != null && <span className="text-xs tabular-nums text-muted-foreground">约 {formatGenerationCost(estimate)}</span>}
        <Button ref={submitButton} disabled={loading || pending || disabled || !choice} onClick={() => void submit()}>
          <SwapLabel active={pending} on="提交中…" off="生成" />
        </Button>
      </div>
    </DialogContent></Dialog>
  </>;
}
