import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import type { CanvasAgentApproval } from '@/schema/canvas';

const COLLAPSED_LINES = 12;
const BATCH_TOOL = 'run_generations';
const ITEM_LINE = /^(\d+)\. /;

/** 批量生成的摘要：服务端每项写一行「序号. 节点 · 模型 · 张数 · 估价」（canvas_agent_runtime.generations_summary），
 *  前面是总数，后面是合计。 */
function batchLines(summary: string) {
  const lines = summary.split('\n');
  const first = lines.findIndex(line => ITEM_LINE.test(line));
  if (first < 0) return { head: lines, items: [] as string[], foot: [] as string[] };
  let last = first;
  while (last + 1 < lines.length && ITEM_LINE.test(lines[last + 1])) last += 1;
  return { head: lines.slice(0, first), items: lines.slice(first, last + 1), foot: lines.slice(last + 1) };
}

function batchSize(item: CanvasAgentApproval): number {
  try {
    const items = (JSON.parse(item.arguments) as { items?: unknown }).items;
    if (Array.isArray(items)) return items.length;
  } catch { /* 参数读不出来就按摘要里的行数 */ }
  return batchLines(item.summary).items.length;
}

/** 批量生成的每一项一个勾选框；去掉勾的项按拒绝回给 Agent。 */
function BatchItems({ item, selected, disabled, onToggle }: {
  item: CanvasAgentApproval;
  selected: ReadonlySet<number>;
  disabled?: boolean;
  onToggle: (index: number, checked: boolean) => void;
}) {
  const { head, items, foot } = batchLines(item.summary);
  const size = batchSize(item);
  return <>
    {head.length > 0 && <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">{head.join('\n')}</p>}
    <div className="mt-1 flex flex-col gap-1">
      {Array.from({ length: size }, (_, index) => (
        <Label key={index} className="flex cursor-pointer items-start gap-2 text-xs font-normal leading-normal">
          <Checkbox
            aria-label={`执行第 ${index + 1} 项`}
            checked={selected.has(index)}
            disabled={disabled}
            onCheckedChange={checked => onToggle(index, checked === true)}
            className="mt-0.5"
          />
          <span className="min-w-0 flex-1 break-words text-muted-foreground">
            {(items[index] ?? `${index + 1}.`).replace(ITEM_LINE, '')}
          </span>
        </Label>
      ))}
    </div>
    {foot.length > 0 && <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{foot.join('\n')}</p>}
  </>;
}

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
 * 「拒绝」全部拒绝。批量生成按项勾选，一项都不勾等于拒绝这次调用。
 * 摘要由服务端写好（生成会带模型与预计费用）。新一批待确认到来时由调用方换 key 重建，默认全选。
 * onDecide 的 items：批量生成里没全选时，勾上的项下标。
 */
export function CanvasAgentApprovalCard({ approvals, labels, disabled, onDecide }: {
  approvals: CanvasAgentApproval[];
  labels: Record<string, string>;
  disabled?: boolean;
  onDecide: (approved: ReadonlySet<string>, items: ReadonlyMap<string, readonly number[]>) => void;
}) {
  const [approved, setApproved] = useState<Set<string>>(() => new Set(approvals.map(item => item.call_id)));
  const [picked, setPicked] = useState<Map<string, Set<number>>>(() => new Map(
    approvals.filter(item => item.tool === BATCH_TOOL)
      .map(item => [item.call_id, new Set(Array.from({ length: batchSize(item) }, (_, index) => index))]),
  ));
  const multiple = approvals.length > 1 || picked.size > 0;
  const units = (item: CanvasAgentApproval) => item.tool === BATCH_TOOL
    ? [batchSize(item), picked.get(item.call_id)?.size ?? 0]
    : [1, approved.has(item.call_id) ? 1 : 0];
  const total = approvals.reduce((sum, item) => sum + units(item)[0], 0);
  const chosen = approvals.reduce((sum, item) => sum + units(item)[1], 0);

  function togglePick(callId: string, index: number, checked: boolean) {
    setPicked(current => {
      const next = new Map(current);
      const items = new Set(next.get(callId));
      if (checked) items.add(index); else items.delete(index);
      next.set(callId, items);
      return next;
    });
  }

  function decide() {
    const calls = new Set([...approved].filter(id => !picked.has(id)));
    const items = new Map<string, number[]>();
    for (const item of approvals) {
      const chosenItems = picked.get(item.call_id);
      if (!chosenItems || chosenItems.size === 0) continue;
      calls.add(item.call_id);
      if (chosenItems.size < batchSize(item)) items.set(item.call_id, [...chosenItems].sort((a, b) => a - b));
    }
    onDecide(calls, items);
  }

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
        if (item.tool === BATCH_TOOL) {
          return <div key={item.call_id} className="text-xs">
            <p className="font-medium text-foreground">{labels[item.tool] ?? item.tool}</p>
            <BatchItems item={item} selected={picked.get(item.call_id) ?? new Set()} disabled={disabled}
              onToggle={(index, checked) => togglePick(item.call_id, index, checked)} />
          </div>;
        }
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
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onDecide(new Set(), new Map())}>拒绝</Button>
        <Button size="sm" disabled={disabled || chosen === 0} onClick={decide}>
          {multiple && chosen < total ? `执行 ${chosen} 项` : '执行'}
        </Button>
      </div>
    </div>
  );
}
