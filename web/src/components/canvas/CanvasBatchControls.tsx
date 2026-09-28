import { useId, useRef, useState } from 'react';
import { Handle, NodeResizer, Position } from '@xyflow/react';
import { ArrowDown, ArrowUp, CircleHelp, Layers, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { canvasMediaUrl } from '@/api/canvas';
import type { CanvasBatchMaterialNode, CanvasGroupNode } from '@/schema/canvas';
import type { CanvasBatchRun } from '@/schema/canvasBatch';
import type { CanvasNodeContextValue } from './CanvasEditorViews';

export function CanvasBatchMaterialEditor({ node, context }: {
  node: CanvasBatchMaterialNode; context: CanvasNodeContextValue;
}) {
  const helpId = useId();
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
      <span className="tabular-nums">{node.data.items.length} 项</span>
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
    <div className="relative flex shrink-0 justify-end">
      <Button type="button" variant="ghost" size="icon"
        className="peer size-6 rounded-full text-muted-foreground hover:text-foreground"
        aria-label="批量素材使用说明" aria-describedby={helpId}
        onClick={event => event.stopPropagation()}>
        <CircleHelp aria-hidden="true" />
      </Button>
      <p id={helpId} role="tooltip"
        className="pointer-events-none invisible absolute bottom-full right-0 z-20 mb-2 w-64 max-w-full rounded-lg border border-border bg-popover px-3 py-2 text-pretty text-xs leading-relaxed text-foreground peer-hover:visible peer-focus-visible:visible">
        默认一张图一项；每项“+”追加同项参考图。拖动或用箭头排序。连接生成节点可逐项生成，分组后可连续执行链路。
      </p>
    </div>
  </div>;
}

export function CanvasExecutionGroup({ node, context, selected }: {
  node: CanvasGroupNode; context: CanvasNodeContextValue; selected: boolean;
}) {
  return <div className="pointer-events-none h-full w-full rounded-2xl border border-dashed border-border bg-secondary/10"
    data-selected={selected ? 'true' : 'false'}>
    {/* 分组的框由画师决定，不再跟着成员长。改框只改框：框外的成员会被摘掉，但把框拉大盖住
        的节点不会被吞进来（要吞得去碰那个节点），见 normalizeCanvasGroups。 */}
    <NodeResizer
      isVisible={selected && !context.multiSelectionActive}
      minWidth={160} minHeight={120}
      color="var(--primary)"
      handleClassName="canvas-node-resize-handle pointer-events-auto"
      lineClassName="canvas-node-resize-line pointer-events-auto"
      onResizeStart={() => context.recordHistory()}
      onResize={(_, params) => context.previewNodeResize?.(node.id, {
        position: { x: params.x, y: params.y },
        size: { width: params.width, height: params.height },
      })}
      onResizeEnd={(_, params) => context.completeNodeResize?.(node.id, {
        position: { x: params.x, y: params.y },
        size: { width: params.width, height: params.height },
      })}
    />
    {/* 分组作为素材包整包供参考：这是它唯一的连线端点（只出不进）。外层 flow 节点是
        pointer-events:none（好让下面的连线露出来），所以这个把手要自己开回可点。 */}
    <Handle type="source" position={Position.Right}
      className="canvas-node-handle pointer-events-auto" aria-label="把这个分组作为素材包连出去">
      <span className="canvas-node-handle-dot" aria-hidden="true" />
    </Handle>
    <div className="pointer-events-auto absolute bottom-full left-0 flex items-center gap-2 pb-3 text-xs">
      <button type="button" className="rounded-md px-2 py-1 font-medium text-foreground hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary"
        onClick={() => context.selectNode(node.id)}>{node.title} · {node.data.member_node_ids.length} 节点</button>
      {selected && !context.multiSelectionActive && <div role="toolbar" aria-label={`${node.title} 节点工具`} data-canvas-node-toolbar={node.id}
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
        {context.activeBatch?.scopeNodeId === node.id
          ? <Button size="sm" variant="outline" disabled={context.activeBatch.stopping}
            onClick={() => void context.stopActiveBatch?.()}>停止</Button>
          : <Button size="sm" disabled={context.batchBusy || context.submittingNodeIds.has(node.id)}
            onClick={() => void context.prepareBatch?.(node.id)}>执行分组</Button>}
        <Button size="sm" variant="ghost" aria-label={`删除 ${node.title}`} title="解散分组，保留成员节点" disabled={context.batchBusy} onClick={() => context.deleteNode(node.id)}>解散</Button>
      </div>}
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
