import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Layers, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { canvasMediaUrl } from '@/api/canvas';
import type { CanvasBatchMaterialNode, CanvasGroupNode, CanvasContentVersion } from '@/schema/canvas';
import { CANVAS_BATCH_STATUS, isCanvasBatchActive, type CanvasBatchRun } from '@/schema/canvasBatch';
import type { CanvasNodeContextValue } from './CanvasEditorViews';

export function CanvasBatchMaterialEditor({ node, context }: {
  node: CanvasBatchMaterialNode; context: CanvasNodeContextValue;
}) {
  const input = useRef<HTMLInputElement>(null);
  const targetItem = useRef<string | undefined>(undefined);
  const [draggedItem, setDraggedItem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = uploading || context.batchBusy;
  function choose(itemId?: string) {
    targetItem.current = itemId;
    input.current?.click();
  }
  async function upload(files: File[], itemId?: string) {
    if (disabled || !files.length) return;
    setUploading(true);
    setError(null);
    try { await context.uploadBatchImages?.(node.id, files, itemId); }
    catch (failure) { setError((failure as Error).message); }
    finally { setUploading(false); }
  }
  function move(itemId: string, index: number) {
    context.updateNode(node.id, current => {
      if (current.type !== 'batch_material') return current;
      const items = [...current.data.items];
      const source = items.findIndex(item => item.id === itemId);
      if (source < 0 || index < 0 || index >= items.length) return current;
      items.splice(index, 0, ...items.splice(source, 1));
      return { ...current, data: { items } };
    });
  }
  return <div className="nodrag nopan nowheel flex h-full flex-col gap-3 p-3"
    onPointerDown={event => event.stopPropagation()}
    onDragOver={event => { event.preventDefault(); event.stopPropagation(); }}
    onDrop={event => {
      event.preventDefault(); event.stopPropagation();
      if (event.dataTransfer.files.length) void upload(Array.from(event.dataTransfer.files));
    }}>
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span className="tabular-nums">{node.data.items.length} 项 · 默认一张一项</span>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => choose()}>
        <Plus className="size-4" />添加图片
      </Button>
    </div>
    <input ref={input} type="file" accept="image/*" multiple className="hidden" aria-label="上传批量素材"
      onChange={event => {
        void upload(Array.from(event.target.files ?? []), targetItem.current);
        event.target.value = '';
      }} />
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
      {!node.data.items.length && <button type="button" disabled={disabled}
        className="grid h-full min-h-32 w-full place-content-center gap-2 rounded-xl border border-dashed border-border text-xs text-muted-foreground hover:border-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onClick={() => choose()}>
        <Layers className="mx-auto size-5" />拖入多张图片，或点击上传
      </button>}
      {node.data.items.map((item, index) => <div key={item.id} draggable={!disabled}
        onDragStart={event => {
          if (disabled) return;
          event.stopPropagation(); setDraggedItem(item.id); event.dataTransfer.setData('text/plain', item.id);
        }}
        onDragEnd={() => setDraggedItem(null)}
        onDrop={event => {
          event.preventDefault(); event.stopPropagation();
          if (disabled) return;
          if (event.dataTransfer.files.length) void upload(Array.from(event.dataTransfer.files), item.id);
          else if (draggedItem) { move(draggedItem, index); setDraggedItem(null); }
        }}
        className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 p-2">
        <span className="text-xs tabular-nums text-muted-foreground">{index + 1}</span>
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {item.image_version_ids.map((versionId, imageIndex) => <div key={`${versionId}-${imageIndex}`} className="group/material relative">
            <img src={canvasMediaUrl(context.projectId, versionId, 96)} alt={`第 ${index + 1} 项参考 ${imageIndex + 1}`}
              draggable={false} loading="lazy" className="size-12 rounded-md object-cover" />
            <button type="button" disabled={disabled} aria-label={`移除第 ${index + 1} 项参考 ${imageIndex + 1}`}
              className="absolute right-0 top-0 rounded-full bg-background text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/material:opacity-100 disabled:hidden"
              onClick={() => context.updateNode(node.id, current => current.type !== 'batch_material' ? current : {
                ...current, data: { items: current.data.items.flatMap(candidate => {
                  if (candidate.id !== item.id) return [candidate];
                  const images = candidate.image_version_ids.filter((_, i) => i !== imageIndex);
                  return images.length ? [{ ...candidate, image_version_ids: images }] : [];
                }) },
              })}><X className="size-4" /></button>
          </div>)}
          <Button size="icon" variant="outline" className="size-12" aria-label={`给第 ${index + 1} 项增加参考图`}
            disabled={disabled || item.image_version_ids.length >= 16} onClick={() => choose(item.id)}><Plus className="size-4" /></Button>
        </div>
        <div className="flex flex-col">
          <Button size="icon" variant="ghost" className="size-6" aria-label={`上移第 ${index + 1} 项`}
            disabled={disabled || index === 0} onClick={() => move(item.id, index - 1)}><ArrowUp className="size-3" /></Button>
          <Button size="icon" variant="ghost" className="size-6" aria-label={`下移第 ${index + 1} 项`}
            disabled={disabled || index === node.data.items.length - 1} onClick={() => move(item.id, index + 1)}><ArrowDown className="size-3" /></Button>
        </div>
      </div>)}
    </div>
    {uploading && <p role="status" className="text-xs text-muted-foreground">正在上传，已上传的素材会保留…</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <p className="text-xs text-muted-foreground">拖动调整顺序 · 每项右侧 + 增加同项参考</p>
  </div>;
}

export function CanvasExecutionGroup({ node, context, selected }: {
  node: CanvasGroupNode; context: CanvasNodeContextValue; selected: boolean;
}) {
  return <div className="pointer-events-none h-full w-full rounded-2xl border border-dashed border-border bg-secondary/10"
    data-selected={selected ? 'true' : 'false'}>
    <div className="pointer-events-auto absolute bottom-full left-0 flex items-center gap-2 pb-3 text-xs">
      <button type="button" className="rounded-md px-2 py-1 font-medium text-foreground hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary"
        onClick={() => context.selectNode(node.id)}>{node.title} · {node.data.member_node_ids.length} 节点</button>
      <div role={selected ? 'toolbar' : undefined} aria-label={`${node.title} 节点工具`} data-canvas-node-toolbar={node.id}
        className="nodrag nopan flex items-center gap-2 rounded-xl border border-border bg-glass p-1.5 backdrop-blur-glass">
        <label className="flex items-center gap-1 text-muted-foreground">重复
          <Input type="number" min={1} max={20} aria-label="分组重复轮数" value={node.data.repeat_count ?? 1}
            disabled={context.batchBusy} className="h-7 w-14 text-xs tabular-nums"
            onChange={event => {
              const repeat = Math.max(1, Math.min(20, Number(event.target.value) || 1));
              context.updateNode(node.id, current => current.type !== 'group' ? current
                : { ...current, data: { ...current.data, repeat_count: repeat } });
            }} />轮
        </label>
        <Button size="sm" disabled={context.batchBusy || context.submittingNodeIds.has(node.id)}
          onClick={() => void context.prepareBatch?.(node.id)}>执行分组</Button>
        <Button size="sm" variant="ghost" aria-label={`删除 ${node.title}`} title="解散分组，保留成员节点" disabled={context.batchBusy} onClick={() => context.deleteNode(node.id)}>解散</Button>
      </div>
    </div>
  </div>;
}

export function CanvasBatchConfirmation({ run, busy, error, onClose, onStart }: {
  run: CanvasBatchRun | null; busy: boolean; error: string | null; onClose: () => void; onStart: () => void;
}) {
  return <Dialog open={Boolean(run)} onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent role="alertdialog" className="max-w-md">
      <DialogHeader><DialogTitle className="text-balance">确认批量执行</DialogTitle>
        <DialogDescription className="text-pretty">按当前素材、提示词和模型设置执行；点击开始后才提交生成。</DialogDescription>
      </DialogHeader>
      {run && <>
        <p className="text-sm tabular-nums">{run.items.length} 项 × {run.steps.length} 步 × {run.repeat_count} 轮 = {run.executions.length} 次生成</p>
        <ol className="space-y-2 text-xs text-muted-foreground">{run.steps.map((step, index) => <li key={step.node_id}>{index + 1}. {step.title} · {step.model}</li>)}</ol>
        <p className="text-xs leading-relaxed text-muted-foreground">每项每步生成 1 个产物。同项结果接给下一步，失败即停止。执行期间暂时锁定画布编辑；停止不能撤回已提交的请求或保证退款。</p>
      </>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>返回修改</Button>
        <Button disabled={busy} onClick={onStart}>{busy ? '提交中…' : '开始执行'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function CanvasBatchResults({ projectId, runs, resolveVersion, onCancel, onPreview }: {
  projectId: string; runs: CanvasBatchRun[];
  resolveVersion: (id: string) => CanvasContentVersion | undefined;
  onCancel: (id: string) => Promise<void>;
  onPreview: (id: string, title: string, nodeId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const active = runs.find(isCanvasBatchActive);
  const selected = runs.find(run => run.batch_id === selectedId) ?? runs[0];
  if (!runs.length) return null;
  return <>
    <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
      {active ? `批量执行 ${active.executions.filter(entry => entry.status === 'succeeded').length}/${active.executions.length}` : '批量记录'}
    </Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85dvh] max-w-2xl overflow-y-auto">
      <DialogHeader><DialogTitle className="text-balance">批量记录</DialogTitle>
        <DialogDescription>保留最近 20 个执行计划的入口；每次生成的完整记录仍保存在对应节点。</DialogDescription></DialogHeader>
      <select className="h-9 rounded-lg border border-border bg-background px-3 text-sm" aria-label="选择批量记录"
        value={selected.batch_id} onChange={event => { setSelectedId(event.target.value); setPage(0); }}>
        {runs.map(run => <option key={run.batch_id} value={run.batch_id}>{run.title} · {CANVAS_BATCH_STATUS[run.status]} · {new Date(run.created_at).toLocaleString()}</option>)}
      </select>
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="tabular-nums">{CANVAS_BATCH_STATUS[selected.status]} · 已完成 {selected.executions.filter(entry => entry.status === 'succeeded').length}/{selected.executions.length}</span>
        {isCanvasBatchActive(selected) && <Button size="sm" variant="outline" disabled={stopping || selected.status === 'stopping'} onClick={async () => {
          setStopping(true); setError(null);
          try { await onCancel(selected.batch_id); } catch (failure) { setError((failure as Error).message); }
          finally { setStopping(false); }
        }}>停止后续执行</Button>}
      </div>
      {(error || selected.error) && <p role="alert" className="text-xs text-destructive">{error || selected.error}</p>}
      <div className="space-y-2">{selected.executions.slice(page * 30, (page + 1) * 30).map(entry => {
        const version = entry.version_id ? resolveVersion(entry.version_id) : undefined;
        const step = selected.steps[entry.step_index];
        const title = `第 ${entry.round_index + 1} 轮 · 第 ${entry.item_index + 1} 项 · ${step.title}`;
        return <div key={entry.run_id} className="flex items-center gap-3 rounded-lg border border-border p-3">
          {version && <button type="button" aria-label={`查看 ${title}`} className="shrink-0 rounded-lg focus-visible:ring-2 focus-visible:ring-primary"
            onClick={() => { setOpen(false); onPreview(version.version_id, title, step.node_id); }}>
            {version.kind === 'image' ? <img src={canvasMediaUrl(projectId, version.version_id, 128)} alt={title} loading="lazy" className="size-16 rounded-lg object-cover" />
              : <span className="grid size-16 place-items-center rounded-lg bg-secondary text-xs">{version.kind === 'text' ? '文本' : version.kind === 'video' ? '视频' : '音频'}</span>}
          </button>}
          <div className="min-w-0 flex-1 text-xs"><p className="truncate text-foreground">{title}</p>
            <p className="mt-1 line-clamp-2 text-muted-foreground">{entry.error ?? (entry.status === 'succeeded' ? '已完成' : entry.status === 'running' ? '生成中' : entry.status === 'queued' ? '等待执行' : entry.status === 'failed' ? '失败' : '未继续执行')}</p>
          </div>
        </div>;
      })}</div>
      {selected.executions.length > 30 && <div className="flex items-center justify-end gap-2 text-xs tabular-nums">
        <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一页</Button>
        {page + 1}/{Math.ceil(selected.executions.length / 30)}
        <Button size="sm" variant="ghost" disabled={(page + 1) * 30 >= selected.executions.length} onClick={() => setPage(value => value + 1)}>下一页</Button>
      </div>}
    </DialogContent></Dialog>
  </>;
}
