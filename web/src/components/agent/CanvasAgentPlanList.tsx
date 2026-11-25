import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { CheckIcon, ChevronRightIcon, LoadingIcon } from '@/components/ui/icons';
import { SwapIcon } from '@/components/ui/swap-icon';
import { cn } from '@/lib/utils';
import type { CanvasAgentPlan, CanvasAgentPlanItem, CanvasAgentPlanStatus } from '@/schema/canvas';

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

/** 待办没有 id：按标题认（同名的按出现次序），状态从未开始走到完成都是同一行，图标原位换态。 */
function itemKeys(items: CanvasAgentPlanItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map(item => {
    const count = seen.get(item.title) ?? 0;
    seen.set(item.title, count + 1);
    return `${item.title}#${count}`;
  });
}

/** Agent 写的待办（update_plan）：固定在面板顶部，可收起；进行中的那条在这一轮运行时转圈。
 *  待办区出现时从 0 高度展开，清空时收回（收回途中仍显示最后一份）。 */
export function CanvasAgentPlanList({ plan, running }: { plan: CanvasAgentPlan | null; running: boolean }) {
  const [open, setOpen] = useState(true);
  const visible = Boolean(plan && plan.items.length > 0);
  const last = useRef<CanvasAgentPlan | null>(null);
  if (plan && visible) last.current = plan;
  const shown = last.current;
  const done = shown?.items.filter(item => item.status === 'completed').length ?? 0;
  const keys = shown ? itemKeys(shown.items) : [];
  return (
    <Collapse open={visible} appear>
      {shown && (
        <section aria-label="Agent 待办" className="border-b border-border px-3 py-1.5 text-xs">
          <Button variant="ghost" size="sm" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
            className="-ml-2 gap-1 px-2 font-normal text-muted-foreground">
            <ChevronRightIcon size="sm" className={cn('transition-transform duration-200', open && 'rotate-90')} />
            <span>待办</span>
            <span className="tabular-nums">{`${done}/${shown.items.length}`}</span>
          </Button>
          <Collapse open={open}>
            <ol className="flex flex-col gap-1 pt-1.5">
              {shown.items.map((item, index) => (
                <li key={keys[index]} className="flex items-center gap-2" aria-label={`${item.title}：${STATUS_LABEL[item.status]}`}>
                  <SwapIcon swapKey={item.status === 'in_progress' && running ? 'running' : item.status} variant={item.status === 'completed' ? 'pop' : 'subtle'}>
                    <StatusMark status={item.status} running={running} />
                  </SwapIcon>
                  <span className={cn('min-w-0 flex-1 break-words transition-colors',
                    item.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground')}>
                    {item.title}
                  </span>
                </li>
              ))}
            </ol>
          </Collapse>
        </section>
      )}
    </Collapse>
  );
}
