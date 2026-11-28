import { Button } from '@/components/ui/button';
import { SwapLabel } from '@/components/ui/swap-label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { GroupPlan } from '@/api/canvasGroupRuns';
import { formatGenerationCost } from '@/lib/generationCost';

/** 受控 open：调用方关闭时传 false、plan 沿用最后一份，退场动画带着原内容播完。 */
export function CanvasGroupRunDialog({ open = true, plan, busy, onClose, onStart, onLocate }: {
  open?: boolean; plan: GroupPlan; busy: boolean; onClose: () => void; onStart: () => void; onLocate?: (nodeId: string) => void;
}) {
  const total = formatGenerationCost(plan.total_cny);
  return <Dialog open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>整体执行 {plan.steps.length} 个节点</DialogTitle></DialogHeader>
      {plan.cycle && <p role="alert" className="text-sm text-destructive">组里的连线有循环</p>}
      <div className="max-h-[55vh] overflow-auto rounded-lg border border-border px-4 text-sm">
        <div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto] gap-x-3">
          {plan.steps.map((step, index) => <div key={step.node_id}
            className="col-span-full grid grid-cols-subgrid items-baseline py-2">
            <span className="tabular-nums text-muted-foreground">{index + 1}</span>
            <span className="break-words">{step.name}</span>
            <span className="break-all text-xs text-muted-foreground">{step.model}</span>
            <span className={`text-right tabular-nums ${step.estimate_cny === null ? 'text-muted-foreground' : ''}`}>{step.estimate_cny === null ? '未计价' : formatGenerationCost(step.estimate_cny)}</span>
          </div>)}
        </div>
        {plan.blocked.map(row => <Button key={row.node_id} variant="ghost" size="sm"
          className="flex h-auto justify-start px-0 py-2 text-destructive"
          onClick={() => onLocate?.(row.node_id)}>{row.name} · {row.reason}</Button>)}
        <div className="flex items-baseline justify-between border-t border-border py-3 font-medium">
          <span>合计</span><span className="tabular-nums">{total}{plan.unpriced > 0 && <span className="font-normal text-muted-foreground"> · {plan.unpriced} 个未计价</span>}</span>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        <Button className="tabular-nums" disabled={busy || plan.cycle || !!plan.blocked.length || !plan.order.length} onClick={onStart}>
          <SwapLabel active={busy} on="执行中…" off={plan.needs_confirmation ? `确认花费 ${total} 并执行` : '开始执行'} />
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
