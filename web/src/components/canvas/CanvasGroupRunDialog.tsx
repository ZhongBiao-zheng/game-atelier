import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { GroupPlan } from '@/api/canvasGroupRuns';

export function CanvasGroupRunDialog({ plan, busy, onClose, onStart }: {
  plan: GroupPlan; busy: boolean; onClose: () => void; onStart: () => void;
}) {
  const total = '¥' + plan.total_cny.toFixed(2);
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>整体执行 {plan.steps.length} 个节点</DialogTitle></DialogHeader>
      {plan.cycle && <p role="alert" className="text-sm text-destructive">组里的连线有循环</p>}
      <div className="max-h-[55vh] overflow-auto rounded-lg border border-border px-4 text-sm">
        {plan.steps.map((step, index) => <div key={step.node_id}
          className="grid grid-cols-[auto_1fr_1fr_auto] items-baseline gap-3 py-2">
          <span className="tabular-nums text-muted-foreground">{index + 1}</span>
          <span className="break-words">{step.name}</span>
          <span className="break-all text-xs text-muted-foreground">{step.model}</span>
          <span className="tabular-nums">{step.estimate_cny === null ? '未计价' : '¥' + step.estimate_cny.toFixed(2)}</span>
        </div>)}
        {plan.blocked.map(row => <p key={row.node_id} className="py-2 text-destructive">{row.name} · {row.reason}</p>)}
        <div className="flex items-baseline justify-between border-t border-border py-3 font-medium">
          <span>合计</span><span className="tabular-nums">{total}{plan.unpriced > 0 && <span className="font-normal text-muted-foreground"> · {plan.unpriced} 个未计价</span>}</span>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        <Button className="tabular-nums" disabled={busy || plan.cycle || !!plan.blocked.length || !plan.order.length} onClick={onStart}>
          {plan.needs_confirmation ? `确认花费 ${total} 并执行` : '开始执行'}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
