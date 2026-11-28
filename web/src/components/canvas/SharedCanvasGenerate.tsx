import { useEffect, useRef, useState } from 'react';
import { listKeys, modelModality } from '@/api/keys';
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
import { formatGenerationCost } from '@/lib/generationCost';
import { errorText } from '@/lib/errorText';
import { shakeOnError } from '@/lib/motion';

interface Choice {
  channel_id: string; model: string; name: string; mode: string; provider: string;
  icon?: string | null; cost_cny?: number | null; provider_label?: string;
  cost_unit?: string; unit_cost_cny?: number | null;
  supported_operations?: ('inpaint' | 'outpaint' | 'layer_decomposition')[];
  input_cny_per_m?: number | null; output_cny_per_m?: number | null;
}

type Source = 'local' | 'borrowed';

interface SubmissionAttempt {
  source: Source;
  body: {
    request_id: string; expected_revision: number; surface_node_id: string;
    model: string; prompt: string; requested_count: number; params: Record<string, unknown>;
    channel_id?: string; alias?: string;
  };
  refreshRevision?: boolean;
}

function pendingAttempt(key: string): SubmissionAttempt | null {
  const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
  return saved?.body ? saved : null;
}

function priceLabel(model: Choice) {
  if (model.cost_cny != null) return formatGenerationCost(model.cost_cny) + (model.cost_unit === 'song' ? '/首' : '/次');
  if (model.cost_unit === '1000_chars' && model.unit_cost_cny != null) return formatGenerationCost(model.unit_cost_cny) + '/千字';
  if (model.cost_unit === 'million_tokens') {
    const rates = [];
    if (model.input_cny_per_m != null) rates.push('输入 ' + formatGenerationCost(model.input_cny_per_m));
    if (model.output_cny_per_m != null) rates.push('输出 ' + formatGenerationCost(model.output_cny_per_m));
    return rates.length ? rates.join('、') + '/百万 token' : '';
  }
  return '';
}

export function SharedCanvasGenerate({ peerKey, projectId, node, frozen, revision, owner, allowBorrow, disabled = false }: {
  peerKey: string; projectId: string; node: CanvasNode; frozen?: CanvasFrozenGeneration | null; revision: number; owner: string; allowBorrow: boolean;
  disabled?: boolean;
}) {
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
  const storageKey = 'shared-generation:' + JSON.stringify([peerKey, projectId, node.id]);
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
          channel_id: key.alias, model: model.id, name: model.name, provider: key.provider, provider_label: key.alias, mode, icon: key.icon,
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
      const saved = pendingAttempt(storageKey);
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
  async function submit() {
    if (!choice || submitting.current) return;
    submitting.current = true;
    setPending(true); setError('');
    let attempt: SubmissionAttempt | null = null;
    try {
      const previous = pendingAttempt(storageKey);
      const originalBody = previous?.body;
      // Only the form controls express a new intent. Live results can change every other default.
      const retry = previous?.source === source && originalBody?.model === choice.model
        && (originalBody.channel_id ?? originalBody.alias) === choice.channel_id
        && originalBody.prompt === prompt && originalBody.requested_count === count;
      const body = retry ? {...originalBody, expected_revision: previous.refreshRevision ? revision : originalBody.expected_revision} : {
        request_id: crypto.randomUUID().replaceAll('-', ''), expected_revision: revision,
        surface_node_id: node.id, model: choice.model, requested_count: count, prompt,
        params: {...(frozen?.params ?? {}), ...(draft?.params ?? {})},
        ...(source === 'borrowed' ? {channel_id: choice.channel_id} : {alias: choice.channel_id}),
      };
      attempt = {source, body};
      sessionStorage.setItem(storageKey, JSON.stringify(attempt));
      setChosen(value(choice));
      await requestJson(base + '/runs/' + source, '提交共享生成', {
        method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body),
      });
      sessionStorage.removeItem(storageKey);
      setOpen(false);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409 && attempt) {
        // The next click can accept a newer revision while keeping the same billing intent.
        sessionStorage.setItem(storageKey, JSON.stringify({...attempt, refreshRevision: true}));
      }
      setError(errorText(reason));
      shakeOnError(submitButton.current);
    }
    finally { setPending(false); submitting.current = false; }
  }
  return <>
    <Button size="sm" disabled={disabled} onClick={() => {
      const saved = pendingAttempt(storageKey)?.body;
      const initialPrompt = saved?.prompt ?? (draft?.prompt || frozen?.prompt || (node.type === 'layer_stack' ? node.data.prompt : ''));
      setPrompt(initialPrompt); setPrefill(initialPrompt);
      setCount(saved?.requested_count ?? Math.max(1, Math.min(4, Number(draft?.params.n ?? frozen?.params.n) || 1)));
      setOpen(true);
    }}>生成…</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent aria-describedby={undefined} dirty={prompt !== prefill}>
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
        if (!loading && !pending && choice) void submit();
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
        {choice?.cost_cny != null && <span className="text-xs tabular-nums text-muted-foreground">约 {formatGenerationCost(choice.cost_cny * count)}</span>}
        <Button ref={submitButton} disabled={loading || pending || !choice} onClick={() => void submit()}>
          <SwapLabel active={pending} on="提交中…" off="生成" />
        </Button>
      </div>
    </DialogContent></Dialog>
  </>;
}
