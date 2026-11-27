import { Handle, NodeResizer, Position } from '@xyflow/react';
import { useState } from 'react';
import { planGroupRun, startGroupRun, updateGroupRun, type GroupPlan } from '@/api/canvasGroupRuns';
import { CanvasGroupRunDialog } from './CanvasGroupRunDialog';
import { AddIcon, PlayIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import type { CanvasGroupNode } from '@/schema/canvas';
import type { CanvasNodeContextValue } from './CanvasEditorViews';
import { EditableText } from '@/components/ui/editable-text';
import { Hint } from '@/components/ui/tooltip';

export function CanvasGroupFrame({ node, context, selected }: {
  node: CanvasGroupNode; context: CanvasNodeContextValue; selected: boolean;
}) {
  const [plan, setPlan] = useState<GroupPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const run = context.groupRuns?.get(node.id);
  const hasDraft = node.data.member_node_ids.some(id => {
    const member = context.findNode?.(id);
    return member && 'generation_draft' in member.data && member.data.generation_draft;
  });
  async function command(action: 'plan' | 'start' | 'resume' | 'cancel') {
    setBusy(true);
    try {
      await context.savePendingEdits?.();
      if (action === 'plan') {
        setPlan(await planGroupRun(context.projectId, node.id));
        return;
      }
      if (action === 'start' && plan) {
        await startGroupRun(context.projectId, node.id, plan);
        setPlan(null);
      } else if (run && (action === 'resume' || action === 'cancel')) {
        await updateGroupRun(context.projectId, run.run_id, action);
      }
      await context.refreshGroupRuns?.();
    } catch (error) {
      setPlan(null);
      context.reportError?.((error as Error).message);
    } finally { setBusy(false); }
  }
  const failed = run?.steps.findIndex(step => step.status === 'failed') ?? -1;
  const progress = run?.status === 'failed' ? `第 ${failed + 1} 个失败` : run?.status === 'interrupted' ? '已中断'
    : run && run.status !== 'cancelled' ? `${run.steps.filter(step => step.status === 'done').length}/${run.steps.length}` : '';
  return <div className={`canvas-group-shell pointer-events-none h-full w-full border bg-secondary/40 ${selected ? 'border-transparent' : 'rounded-xl border-border'}`}
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
      className="canvas-node-handle canvas-group-add-handle pointer-events-auto" aria-label="把这个分组作为素材包连出去">
      <span className="canvas-group-add" aria-hidden="true"><AddIcon /></span>
    </Handle>
    {/* 名字就是分组本身的把手：按住拖动整组，单击改名。它在框的左上角外侧，不占成员的位置。 */}
    <div className="pointer-events-auto absolute bottom-full left-0 flex max-w-full items-center gap-2 pb-2 text-sm"
      onClick={() => context.selectNode(node.id)}>
      <EditableText value={node.title} maxLength={120} triggerLabel={`重命名分组 ${node.title}`}
        className="text-muted-foreground hover:text-foreground"
        onSave={title => context.renameNode(node.id, title)} />
      {progress && <Hint key={progress} label={run?.steps[failed]?.error}>
        <span role="status" className={`content-swap-in whitespace-nowrap text-xs tabular-nums ${run?.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{progress}</span>
      </Hint>}
      {(run?.status === 'failed' || run?.status === 'interrupted') &&
        <Button variant="ghost" size="sm" className="nodrag h-7" disabled={busy} onClick={() => void command('resume')}>继续</Button>}
      {(run?.status === 'failed' || run?.status === 'running') &&
        <Button variant="ghost" size="sm" className="nodrag h-7" disabled={busy} onClick={() => void command('cancel')}>取消</Button>}
      {selected && !context.multiSelectionActive && <div role="toolbar" aria-label={`${node.title} 节点工具`} data-canvas-node-toolbar={node.id}
        className="nodrag nopan flex shrink-0 items-center">
        <Hint label={hasDraft ? '整体执行' : '组里没有可生成的节点'}><span>
          <Button size="sm" variant="ghost" className="h-7" disabled={busy || !hasDraft || run?.status === 'running'}
            onClick={() => void command('plan')}><PlayIcon />整体执行</Button>
        </span></Hint>
        <Hint label="解散分组，保留成员节点"><Button size="sm" variant="ghost" className="h-7" aria-label={`解散分组 ${node.title}`} onClick={() => context.deleteNode(node.id)}>解散</Button></Hint>
      </div>}
    </div>
    {plan && <CanvasGroupRunDialog plan={plan} busy={busy} onClose={() => setPlan(null)} onStart={() => void command('start')} />}
  </div>;
}
