import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, LoadingIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import type { CanvasAgentPlan, CanvasAgentPlanStatus } from '@/schema/canvas';

const STATUS_LABEL: Record<CanvasAgentPlanStatus, string> = {
  pending: '未开始', in_progress: '进行中', completed: '已完成',
};

function StatusMark({ status, running }: { status: CanvasAgentPlanStatus; running: boolean }) {
  if (status === 'completed') return <CheckIcon size="sm" className="shrink-0 text-muted-foreground" />;
  if (status === 'in_progress') {
    return running
      ? <LoadingIcon size="sm" className="shrink-0 animate-spin text-primary" />
      : <span className="mx-1 size-2 shrink-0 rounded-full bg-primary" />;
  }
  return <span className="mx-1 size-2 shrink-0 rounded-full border border-muted-foreground" />;
}

/** Agent 写的待办（update_plan）：固定在面板顶部，可收起；进行中的那条在这一轮运行时转圈。 */
export function CanvasAgentPlanList({ plan, running }: { plan: CanvasAgentPlan | null; running: boolean }) {
  const [open, setOpen] = useState(true);
  if (!plan || plan.items.length === 0) return null;
  const done = plan.items.filter(item => item.status === 'completed').length;
  return (
    <section aria-label="Agent 待办" className="border-b border-border px-3 py-1.5 text-xs">
      <Button variant="ghost" size="sm" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="-ml-2 gap-1 px-2 font-normal text-muted-foreground">
        {open ? <ChevronDownIcon size="sm" /> : <ChevronRightIcon size="sm" />}
        <span>待办</span>
        <span className="tabular-nums">{`${done}/${plan.items.length}`}</span>
      </Button>
      {open && (
        <ol className="mt-1.5 flex flex-col gap-1">
          {plan.items.map((item, index) => (
            <li key={index} className="flex items-center gap-2" aria-label={`${item.title}：${STATUS_LABEL[item.status]}`}>
              <StatusMark status={item.status} running={running} />
              <span className={cn('min-w-0 flex-1 break-words',
                item.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground')}>
                {item.title}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
