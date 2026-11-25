import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapse } from '@/components/ui/collapse';
import { Label } from '@/components/ui/label';
import { SwapLabel } from '@/components/ui/swap-label';
import { formatGenerationCost } from '@/lib/generationCost';
import { shakeOnError } from '@/lib/motion';
import type { CanvasAgentApproval, CanvasAgentBatchItems } from '@/schema/canvas';

const COLLAPSED_LINES = 12;
const BATCH_TOOL = 'run_generations';

/** 批量生成的逐项勾选；合计、未计价数、是否超过确认金额都按勾上的项重算。 */
function BatchItems({ data, selected, disabled, onToggle, unit }: {
  unit: string;
  data: CanvasAgentBatchItems;
  selected: ReadonlySet<number>;
  disabled?: boolean;
  onToggle: (index: number, checked: boolean) => void;
}) {
  const chosen = data.items.filter(item => selected.has(item.index));
  const priced = chosen.filter(item => item.estimate_cny !== null);
  const total = priced.reduce((sum, item) => sum + (item.estimate_cny ?? 0), 0);
  const unpriced = chosen.length - priced.length;
  const footer = priced.length === 0
    ? (chosen.length === 0 ? '没有勾选任何项' : '合计未计价')
    : `合计预计 ${formatGenerationCost(total)}${unpriced ? `（${unpriced} 项未计价）` : ''}`;
  return <>
    <p className="mt-0.5 text-muted-foreground">
      {`批量生成 ${data.items.length} 项，共 ${data.items.reduce((sum, item) => sum + item.count, 0)} ${unit}`}
    </p>
    <div className="mt-1 flex flex-col gap-1">
      {data.items.map(item => (
        <Label key={item.index} className="flex cursor-pointer items-start gap-2 text-xs font-normal leading-normal">
          <Checkbox
            aria-label={`执行第 ${item.index + 1} 项`}
            checked={selected.has(item.index)}
            disabled={disabled}
            onCheckedChange={checked => onToggle(item.index, checked === true)}
            className="mt-0.5"
          />
          <span className="min-w-0 flex-1 break-words text-muted-foreground">
            {[item.title, item.model ?? '读不到生成配置', `${item.count} ${unit}`,
              item.estimate_cny === null ? '未计价' : `预计 ${formatGenerationCost(item.estimate_cny)}`].join(' · ')}
          </span>
        </Label>
      ))}
    </div>
    {data.turn_estimate_cny != null && <p className="text-muted-foreground">本轮已提交预计 {formatGenerationCost(data.turn_estimate_cny)}</p>}
    <p className="mt-1 text-muted-foreground">{footer}</p>
    {priced.length > 0 && total + (data.turn_estimate_cny ?? 0) > data.confirm_above_cny && (
      <p className="text-muted-foreground">{`超过确认金额 ${formatGenerationCost(data.confirm_above_cny)}`}</p>
    )}
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

/** 确认卡收起后留在对话里的一行结论，与按钮成对：「执行」→ 已执行…，「取消」→ 已取消。
 *  total / chosen 按项数算（批量生成拿到明细后每项算一项）。 */
export function approvalConclusion(total: number, chosen: number, onlyLabel: string | null): string {
  if (chosen === 0) return '已取消';
  if (chosen < total) return `已执行 ${chosen}/${total} 项`;
  return total === 1 && onlyLabel ? `已执行 · ${onlyLabel}` : `已执行 ${total} 项`;
}

/**
 * 待确认的工具调用：多条时逐条勾选，「执行」只执行勾上的，其余按拒绝回给 Agent；
 * 「取消」全部不执行。摘要由服务端写好（生成会带模型与预计费用）。新一批待确认到来时由调用方换 key 重建，默认全选。
 * 批量生成：loadBatchItems 拿到逐项数据后按项勾选（一项都不勾等于拒绝这次调用）、按勾选重算合计；
 * 拿不到时整段显示服务端摘要，只能整条执行或拒绝。onDecide 的 items：批量生成里没全选时，勾上的项下标；conclusion：收起后显示的结论行。
 * onDecide 返回 Promise 时等它结束：结果为空（提交失败）就让按下的按钮微抖、恢复可再点。
 */
export function CanvasAgentApprovalCard({ approvals, labels, disabled, onDecide, loadBatchItems, unit = '张' }: {
  unit?: string;
  approvals: CanvasAgentApproval[];
  labels: Record<string, string>;
  disabled?: boolean;
  onDecide: (
    approved: ReadonlySet<string>,
    items: ReadonlyMap<string, readonly number[]>,
    conclusion: string,
  ) => void | Promise<unknown>;
  loadBatchItems?: (callId: string) => Promise<CanvasAgentBatchItems>;
}) {
  const [approved, setApproved] = useState<Set<string>>(() => new Set(approvals.map(item => item.call_id)));
  // 只有拿到逐项数据的批量调用才在这里：按项勾选；不在这里的批量调用按普通调用整条处理。
  const [details, setDetails] = useState<Map<string, CanvasAgentBatchItems>>(() => new Map());
  const [picked, setPicked] = useState<Map<string, Set<number>>>(() => new Map());
  const loader = useRef(loadBatchItems);
  // 按下的是哪个：执行键在提交期间原位换成「执行中…」，失败时按下的那个微抖。
  const [choice, setChoice] = useState<'run' | 'cancel' | null>(null);
  const runRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const batchIds = approvals.filter(item => item.tool === BATCH_TOOL).map(item => item.call_id).join(',');
  useEffect(() => {
    let alive = true;
    for (const callId of batchIds ? batchIds.split(',') : []) {
      loader.current?.(callId).then(data => {
        if (!alive) return;
        setDetails(current => new Map(current).set(callId, data));
      }).catch(() => undefined);  // 拿不到就保持整段摘要
    }
    return () => { alive = false; };
  }, [batchIds]);

  // 明细到达前用户可能已拒绝整条调用；逐项选择第一次编辑前沿用当前整条选择。
  function selectedItems(callId: string) {
    return picked.get(callId) ?? new Set(approved.has(callId) ? details.get(callId)?.items.map(item => item.index) : []);
  }
  const multiple = approvals.length > 1 || details.size > 0;
  const units = (item: CanvasAgentApproval) => details.has(item.call_id)
    ? [details.get(item.call_id)!.items.length, selectedItems(item.call_id).size]
    : [1, approved.has(item.call_id) ? 1 : 0];
  const total = approvals.reduce((sum, item) => sum + units(item)[0], 0);
  const chosen = approvals.reduce((sum, item) => sum + units(item)[1], 0);

  function togglePick(callId: string, index: number, checked: boolean) {
    setPicked(current => {
      const next = new Map(current);
      const items = new Set(next.get(callId) ?? selectedItems(callId));
      if (checked) items.add(index); else items.delete(index);
      next.set(callId, items);
      return next;
    });
  }

  function submit(which: 'run' | 'cancel', calls: ReadonlySet<string>, items: ReadonlyMap<string, readonly number[]>) {
    const onlyLabel = approvals.length === 1 && !details.size ? labels[approvals[0].tool] ?? approvals[0].tool : null;
    const conclusion = approvalConclusion(total, which === 'cancel' ? 0 : chosen, onlyLabel);
    setChoice(which);
    const result = onDecide(calls, items, conclusion);
    if (!(result instanceof Promise)) return;
    void result.then(value => {
      if (value !== undefined) return;
      setChoice(null);
      shakeOnError(which === 'run' ? runRef.current : cancelRef.current);
    });
  }

  function decide() {
    const calls = new Set([...approved].filter(id => !details.has(id)));
    const items = new Map<string, number[]>();
    for (const item of approvals) {
      const chosenItems = selectedItems(item.call_id);
      const data = details.get(item.call_id);
      if (!chosenItems || !data || chosenItems.size === 0) continue;
      calls.add(item.call_id);
      if (chosenItems.size < data.items.length) items.set(item.call_id, [...chosenItems].sort((a, b) => a - b));
    }
    submit('run', calls, items);
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
        const data = details.get(item.call_id);
        const title = <p className="font-medium text-foreground">{labels[item.tool] ?? item.tool}</p>;
        const plain = multiple ? (
          <Label className="flex cursor-pointer items-start gap-2 text-xs font-normal leading-normal">
            <Checkbox
              aria-label={`执行：${labels[item.tool] ?? item.tool}`}
              checked={approved.has(item.call_id)}
              disabled={disabled}
              onCheckedChange={checked => toggle(item.call_id, checked === true)}
              className="mt-0.5"
            />
            <span className="min-w-0 flex-1">{title}<ApprovalSummary text={item.summary} /></span>
          </Label>
        ) : <div className="text-xs">{title}<ApprovalSummary text={item.summary} /></div>;
        if (item.tool !== BATCH_TOOL) return <div key={item.call_id}>{plain}</div>;
        // 批量生成的逐项明细异步到达：整段摘要收起，逐项列表从同一位置展开，不整块替换。
        return <div key={item.call_id}>
          <Collapse open={!data}>{plain}</Collapse>
          <Collapse open={Boolean(data)}>
            {data && <div className="text-xs">
              {title}
              <BatchItems unit={unit} data={data} selected={selectedItems(item.call_id)} disabled={disabled}
                onToggle={(index, checked) => togglePick(item.call_id, index, checked)} />
            </div>}
          </Collapse>
        </div>;
      })}
      <div className="flex justify-end gap-2">
        <Button ref={cancelRef} size="sm" variant="secondary" disabled={disabled}
          onClick={() => submit('cancel', new Set(), new Map())}>取消</Button>
        {/* 「执行 N 项」随勾选变数、提交时换「执行中…」：最小宽 + 等宽数字，按钮不左右跳。 */}
        <Button ref={runRef} size="sm" disabled={disabled || chosen === 0} onClick={decide} className="min-w-18 tabular-nums">
          <SwapLabel active={choice === 'run' && Boolean(disabled)} on="执行中…"
            off={multiple && chosen < total ? `执行 ${chosen} 项` : '执行'} />
        </Button>
      </div>
    </div>
  );
}
