import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import type { CanvasAgentApproval } from '@/schema/canvas';

const COLLAPSED_LINES = 12;

/** 摘要原文；很长时（如 PS 联动的脚本全文，ADR-0043）先显示前几行，能展开看全。 */
function ApprovalSummary({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > COLLAPSED_LINES;
  const shown = long && !expanded ? lines.slice(0, COLLAPSED_LINES).join('\n') : text;
  return <>
    <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">{shown}</p>
    {long && <Button variant="ghost" size="sm" className="-ml-2 mt-0.5"
      onClick={event => { event.preventDefault(); event.stopPropagation(); setExpanded(value => !value); }}>
      {expanded ? '收起' : `展开全文（共 ${lines.length} 行）`}
    </Button>}
  </>;
}

/**
 * 待确认的工具调用：多条时逐条勾选，「执行」只执行勾上的，其余按拒绝回给 Agent；
 * 「拒绝」全部拒绝。摘要由服务端写好（生成会带模型与预计费用）。
 * 新一批待确认到来时由调用方换 key 重建，默认全选。
 */
export function CanvasAgentApprovalCard({ approvals, labels, disabled, onDecide }: {
  approvals: CanvasAgentApproval[];
  labels: Record<string, string>;
  disabled?: boolean;
  onDecide: (approved: ReadonlySet<string>) => void;
}) {
  const [approved, setApproved] = useState<Set<string>>(() => new Set(approvals.map(item => item.call_id)));
  const multiple = approvals.length > 1;

  function toggle(callId: string, checked: boolean) {
    setApproved(current => {
      const next = new Set(current);
      if (checked) next.add(callId); else next.delete(callId);
      return next;
    });
  }

  return (
    <div role="group" aria-label="待确认的操作" className="flex flex-col gap-2 rounded-lg border border-primary/40 p-3">
      {approvals.map(item => {
        const body = (
          <>
            <p className="font-medium text-foreground">{labels[item.tool] ?? item.tool}</p>
            <ApprovalSummary text={item.summary} />
          </>
        );
        return multiple ? (
          <Label key={item.call_id} className="flex cursor-pointer items-start gap-2 text-xs font-normal leading-normal">
            <Checkbox
              aria-label={`执行：${labels[item.tool] ?? item.tool}`}
              checked={approved.has(item.call_id)}
              disabled={disabled}
              onCheckedChange={checked => toggle(item.call_id, checked === true)}
              className="mt-0.5"
            />
            <span className="min-w-0 flex-1">{body}</span>
          </Label>
        ) : <div key={item.call_id} className="text-xs">{body}</div>;
      })}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onDecide(new Set())}>拒绝</Button>
        <Button size="sm" disabled={disabled || approved.size === 0} onClick={() => onDecide(approved)}>
          {multiple && approved.size < approvals.length ? `执行 ${approved.size} 项` : '执行'}
        </Button>
      </div>
    </div>
  );
}
