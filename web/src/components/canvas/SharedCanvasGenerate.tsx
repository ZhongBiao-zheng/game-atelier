import { useEffect, useRef, useState } from 'react';
import { listKeys, modelModality } from '@/api/keys';
import { remoteProjectPath } from '@/api/collab';
import { requestJson } from '@/api/http';
import { ProviderBrandIcon } from '@/components/ProviderBrandIcon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CanvasFrozenGeneration, CanvasNode } from '@/schema/canvas';
import { supportsLayerDecomposition } from './canvasLayerDecomposition';
import { isEditModel } from './imageEditGeometry';
import { formatGenerationCost } from '@/lib/generationCost';
import { errorText } from '@/lib/errorText';

interface Choice {
  channel_id: string; model: string; name: string; mode: string; provider: string;
  icon?: string | null; cost_cny?: number | null; provider_label?: string;
  cost_unit?: string; unit_cost_cny?: number | null;
  supported_operations?: ('inpaint' | 'outpaint' | 'layer_decomposition')[];
  input_cny_per_m?: number | null; output_cny_per_m?: number | null;
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

export function SharedCanvasGenerate({ peerKey, projectId, node, frozen, revision, owner, allowBorrow }: {
  peerKey: string; projectId: string; node: CanvasNode; frozen?: CanvasFrozenGeneration | null; revision: number; owner: string; allowBorrow: boolean;
}) {
  const [open, setOpen] = useState(false);
  const draft = 'generation_draft' in node.data ? node.data.generation_draft : null;
  const mode = draft?.mode ?? (node.type === 'layer_stack' || node.type === 'image_edit' ? 'image' : node.type);
  const operation = node.type === 'image_edit' ? node.data.options.mode
    : node.type === 'layer_stack' ? 'layer_decomposition' : null;
  const [mine, setMine] = useState<Choice[]>([]);
  const [host, setHost] = useState<Choice[]>([]);
  const [source, setSource] = useState<'local' | 'borrowed'>('local');
  const [chosen, setChosen] = useState('');
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(1);
  const base = remoteProjectPath(peerKey, projectId);
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
      setSource(!local.length && remote.length ? 'borrowed' : 'local');
      setChosen('');
    }).catch(reason => { if (active) setError(errorText(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, base, mode, allowBorrow, operation]);
  if (!['image','video','text','audio','image_edit','layer_stack'].includes(node.type)) return null;
  const choices = source === 'borrowed' && allowBorrow ? host : mine;
  const value = (model: Choice) => JSON.stringify([model.channel_id, model.model]);
  const original = draft?.model || frozen?.model_id || (node.type === 'layer_stack' ? node.data.model : null);
  const choice = choices.find(item => value(item) === chosen) ?? choices.find(item => item.model === original)
    ?? (!original ? choices[0] : undefined);
  async function submit() {
    if (!choice || submitting.current) return;
    submitting.current = true;
    setPending(true); setError('');
    try {
      const params = {...(frozen?.params ?? {}), ...(draft?.params ?? {})};
      const body = {
        expected_revision: revision, surface_node_id: node.id, model: choice.model,
        requested_count: count, prompt, params,
        ...(source === 'borrowed' ? {channel_id: choice.channel_id} : {alias: choice.channel_id}),
      };
      await requestJson(base + '/runs/' + source, '提交共享生成', {
        method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body),
      });
      setOpen(false);
    } catch (reason) { setError(errorText(reason)); }
    finally { setPending(false); submitting.current = false; }
  }
  return <>
    <Button size="sm" onClick={() => {
      setPrompt(draft?.prompt || frozen?.prompt || (node.type === 'layer_stack' ? node.data.prompt : ''));
      setCount(Math.max(1, Math.min(4, Number(draft?.params.n ?? frozen?.params.n) || 1)));
      setOpen(true);
    }}>生成…</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{node.type === 'layer_stack' ? '拆分图层' : node.type === 'image_edit' ? '图片编辑' : '生成'}</DialogTitle></DialogHeader>
      {allowBorrow && <Tabs value={source} onValueChange={next => { setSource(next === 'borrowed' ? 'borrowed' : 'local'); setChosen(''); }}>
        <TabsList><TabsTrigger value="local">我的供应商</TabsTrigger><TabsTrigger value="borrowed">房主供应商</TabsTrigger></TabsList>
      </Tabs>}
      <Select value={choice ? value(choice) : ''} onValueChange={setChosen} disabled={loading || pending}>
        <SelectTrigger aria-label="生成模型"><SelectValue placeholder={loading ? '读取模型中…' : '选择可用模型'} /></SelectTrigger>
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
      <Textarea aria-label="提示词" value={prompt} onChange={event => setPrompt(event.target.value)} />
      {['image', 'text'].includes(node.type) && <Label className="flex items-center justify-between gap-3">候选数量
        <Input aria-label="候选数量" className="w-20" type="number" min={1} max={4} value={count}
          onChange={event => setCount(Math.max(1, Math.min(4, Math.floor(Number(event.target.value) || 1))))} />
      </Label>}
      {source === 'borrowed' && <p className="text-sm">本次生成使用房主（{owner}）的供应商</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button disabled={loading || pending || !choice} onClick={() => void submit()}>{pending ? '提交中…' : '生成'}</Button>
    </DialogContent></Dialog>
  </>;
}
