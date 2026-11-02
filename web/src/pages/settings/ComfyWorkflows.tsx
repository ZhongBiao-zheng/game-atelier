import { useEffect, useRef, useState } from 'react';
import { deleteWorkflow, inspectWorkflow, listWorkflows, saveWorkflow, type ComfyWorkflow, type WorkflowInspection } from '@/api/comfyui';
import type { WorkflowInput } from '@/api/keys';
import { KEYS_CHANGED_EVENT } from '@/lib/announcements';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FileInput } from '@/components/ui/file-input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Hint } from '@/components/ui/tooltip';

const TYPES: WorkflowInput['type'][] = ['prompt', 'text', 'int', 'float', 'boolean', 'select', 'seed', 'image', 'mask'];
const LABELS = ['提示词', '文本', '整数', '小数', '开关', '下拉', '种子', '图片', '遮罩'];

export function ComfyWorkflows({ alias }: { alias: string }) {
  const [items, setItems] = useState<ComfyWorkflow[]>([]);
  const [draft, setDraft] = useState<ComfyWorkflow | null>(null);
  const [inspection, setInspection] = useState<WorkflowInspection | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ComfyWorkflow | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const replacing = useRef<ComfyWorkflow | null>(null);
  const reload = async () => setItems((await listWorkflows(alias)).workflows);
  useEffect(() => { void reload().catch(e => setError(String(e))); }, [alias]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (task: () => Promise<void>) => {
    setError(''); setBusy(true);
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const patch = (index: number, update: Partial<WorkflowInput>) => setDraft(current => current && ({
    ...current, inputs: current.inputs.map((item, i) => i === index ? { ...item, ...update } : item),
  }));
  const uploadFile = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) throw new Error('工作流文件不能超过 5 MB');
    const graph = JSON.parse(await file.text());
    const previous = replacing.current;
    const result = await inspectWorkflow(alias, graph, previous?.id);
    setInspection(result); setAccepted(false);
    setDraft({ id: previous?.id ?? '', name: previous?.name ?? file.name.replace(/\.json$/i, ''),
      api_workflow: graph, inputs: result.tagged || previous ? result.inputs : [],
      source_filename: file.name, imported_at: '', timeout_seconds: previous?.timeout_seconds ?? 1800 });
  };
  return <div className="space-y-3">
    <FileInput ref={upload} accept=".json,application/json" onChange={e => {
      const file = e.target.files?.[0]; e.target.value = '';
      if (file) void act(() => uploadFile(file));
    }} />
    <Button variant="outline" disabled={busy} onClick={() => { replacing.current = null; upload.current?.click(); }}>导入工作流</Button>
    {!items.length && <p className="text-xs text-muted-foreground">导入 ComfyUI 的 API 格式 JSON</p>}
    <ul className="divide-y divide-border">{items.map(item => <li key={item.id} className="flex flex-wrap items-center gap-2 py-2">
      <div className="min-w-0 flex-1"><p className="truncate text-sm">{item.name}</p><p className="text-xs text-muted-foreground">{item.inputs.length} 个输入 · {new Date(item.imported_at).toLocaleDateString('zh-CN')}</p></div>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(async () => {
        setInspection(await inspectWorkflow(alias, item.api_workflow)); setDraft(item); setAccepted(true);
      })}>编辑</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => { replacing.current = item; upload.current?.click(); }}>重新导入</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPendingDelete(item)}>删除</Button>
    </li>)}</ul>
    {error && !draft && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Dialog open={Boolean(pendingDelete)} onOpenChange={open => { if (!open) setPendingDelete(null); }}>
      <DialogContent><DialogTitle>删除工作流「{pendingDelete?.name}」？</DialogTitle>
        <Button variant="destructive" disabled={busy} onClick={() => void act(async () => {
          await deleteWorkflow(alias, pendingDelete!.id); setPendingDelete(null); await reload();
          window.dispatchEvent(new Event(KEYS_CHANGED_EVENT));
        })}>删除</Button>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(draft)} onOpenChange={open => { if (!open && !busy) setDraft(null); }}>
      <DialogContent className="flex max-h-[85vh] max-w-5xl flex-col">
        <DialogTitle>{draft?.id ? '编辑工作流' : '导入工作流'}</DialogTitle>
        {draft && <>
          <div className="min-h-0 space-y-4 overflow-y-auto p-2">
            <div className="grid grid-cols-2 gap-4"><Label className="space-y-2">名称<Input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Label>
              <Label className="space-y-2">超时（秒）<Input type="number" min={1} max={86400} value={draft.timeout_seconds} onChange={e => setDraft({ ...draft, timeout_seconds: Number(e.target.value) })} /></Label></div>
            {inspection?.warnings.map(warning => <p key={warning} role="status" className="text-xs text-muted-foreground">{warning}</p>)}
            {!!inspection?.unmapped.length && <Label className="flex items-center gap-2 text-sm">
              <Checkbox checked={accepted} onCheckedChange={value => setAccepted(value === true)} />移除无法匹配的输入：{inspection.unmapped.join('、')}
            </Label>}
            <div className="space-y-3">{draft.inputs.map((item, index) => <div key={item.id} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center gap-3">
                <div className="mr-auto flex min-w-0 items-center gap-2 text-xs"><span className="truncate">{item.label}</span><span className="shrink-0 text-muted-foreground">{LABELS[TYPES.indexOf(item.type)]}</span></div>
                <Label className="flex items-center gap-2 text-xs"><Checkbox checked={item.required} onCheckedChange={value => patch(index, { required: value === true })} />必填</Label>
                <Button variant="ghost" size="sm" onClick={() => setDraft({ ...draft, inputs: draft.inputs.filter((_, i) => i !== index) })}>删除输入</Button>
              </div>
              <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-4">
                <Label className="space-y-1 text-xs">类型<Select value={item.type} onValueChange={type => patch(index, { type: type as WorkflowInput['type'], default: null })}>
                  <SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{TYPES.map((type, i) => <SelectItem key={type} value={type}>{LABELS[i]}</SelectItem>)}</SelectContent>
                </Select></Label>
                <Label className="space-y-1 text-xs">显示名<Input value={item.label} onChange={e => patch(index, { label: e.target.value })} /></Label>
                <Label className="space-y-1 text-xs"><span className="flex min-w-0 items-center gap-2">节点 ID<Hint label={item.class_type}><span className="truncate font-mono text-muted-foreground">{item.class_type}</span></Hint></span><Input value={item.node_id} onChange={e => {
                  const node = draft.api_workflow[e.target.value]; patch(index, { node_id: e.target.value, class_type: node?.class_type ?? '' });
                }} /></Label>
                <Label className="space-y-1 text-xs">字段<Input value={item.field} onChange={e => patch(index, { field: e.target.value })} /></Label>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                {!['prompt', 'image', 'mask', 'seed'].includes(item.type) && <Label className="min-w-32 flex-1 space-y-1 text-xs">默认值
                  {item.type === 'boolean' ? <Checkbox checked={item.default === true} onCheckedChange={value => patch(index, { default: value === true })} />
                    : <Input value={String(item.default ?? '')} type={['int', 'float'].includes(item.type) ? 'number' : 'text'} step="any" onChange={e => patch(index, { default: ['int', 'float'].includes(item.type) ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value })} />}
                </Label>}
                {['int', 'float', 'seed'].includes(item.type) && (['min', 'max', 'step'] as const).map((name, i) => <Label key={name} className="w-24 space-y-1 text-xs">{['最小值', '最大值', '步长'][i]}<Input type="number" step="any" value={item[name] ?? ''} onChange={e => patch(index, { [name]: e.target.value === '' ? null : Number(e.target.value) })} /></Label>)}
              </div>
              {item.type === 'select' && <Label className="block space-y-1 text-xs">选项（每行：值 | 显示名）<Textarea value={item.options.map(option => `${option.value} | ${option.label}`).join('\n')} onChange={e => patch(index, { options: e.target.value.split('\n').map(line => {
                const [value, label] = line.split('|').map(part => part.trim()); return { value, label: label || value };
              }) })} /></Label>}
            </div>)}</div>
            <Select value="" onValueChange={id => {
              const item = inspection?.candidates.find(candidate => candidate.id === id);
              if (item) setDraft({ ...draft, inputs: [...draft.inputs, item] });
            }}><SelectTrigger aria-label="添加工作流输入"><SelectValue placeholder="添加输入…" /></SelectTrigger>
              <SelectContent>{inspection?.candidates.filter(candidate => !draft.inputs.some(item => item.node_id === candidate.node_id && item.field === candidate.field)).map(item => <SelectItem key={item.id} value={item.id}>#{item.node_id} {item.class_type} · {item.field}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>取消</Button>
            <Button disabled={busy || !draft.name.trim() || Boolean(inspection?.unmapped.length && !accepted)} onClick={() => void act(async () => {
              await saveWorkflow(alias, draft); setDraft(null); await reload(); window.dispatchEvent(new Event(KEYS_CHANGED_EVENT));
            })}>{busy ? '保存中…' : '保存工作流'}</Button>
          </div>
        </>}
      </DialogContent>
    </Dialog>
  </div>;
}
