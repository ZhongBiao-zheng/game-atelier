import { useEffect, useState } from 'react';

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { formatGenerationCost } from '@/lib/generationCost';

import type { StoryboardHost } from './StoryboardNodeBody';
import type { ShotGenerationKind, ShotGenerationPlan } from './storyboardGeneration';

const KIND_LABEL: Record<ShotGenerationKind, string> = { image: '图片', video: '视频' };
const COUNTS = [1, 2, 3, 4];

/** 花费一行：全部有价格才给金额；有任何一镜没有价格就写未计价，不拿 0 充数。 */
export function planCostText(plan: ShotGenerationPlan): string {
  if (plan.items.length === 0) return '—';
  if (plan.totalCost !== null) return formatGenerationCost(plan.totalCost);
  return plan.unpricedCount === plan.items.length ? '未计价' : `未计价（${plan.unpricedCount} 镜没有价格）`;
}

export interface GenerateRequest {
  kind: ShotGenerationKind;
  shotIds: readonly string[];
}

/**
 * 批量生成的确认弹窗：这是分镜里唯一的大额计费入口。
 * 弹窗里的镜头数、模型、花费都来自同一份计划；点确认时提交的就是屏幕上这份，不再重新读镜头表。
 */
export function StoryboardGenerate({ request, nodeId, host, onClose }: {
  request: GenerateRequest | null;
  nodeId: string;
  host: StoryboardHost;
  onClose: () => void;
}) {
  const [count, setCount] = useState(1);
  const [plan, setPlan] = useState<ShotGenerationPlan | null>(null);
  const { planShots } = host;

  useEffect(() => {
    if (!request) { setPlan(null); setCount(1); return; }
    setPlan(planShots?.(nodeId, request.shotIds, request.kind, count) ?? null);
  }, [request, count, nodeId, planShots]);

  if (!request || !plan) return null;
  const label = KIND_LABEL[request.kind];
  return <AlertDialog open onOpenChange={open => { if (!open) onClose(); }}>
    <AlertDialogContent onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      <AlertDialogHeader>
        <AlertDialogTitle>生成{label}</AlertDialogTitle>
        <AlertDialogDescription>每个镜头是一次独立的生成任务。</AlertDialogDescription>
      </AlertDialogHeader>
      <dl className="grid grid-cols-[5rem_1fr] items-center gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">镜头</dt>
        <dd className="tabular-nums">{plan.items.length} 个{plan.items.length > 0 && `（${plan.items.map(item => item.label).join('、')}）`}</dd>
        <dt className="text-muted-foreground">模型</dt>
        <dd className="truncate">{plan.models.join('、') || '—'}</dd>
        {request.kind === 'image' && <>
          <dt className="text-muted-foreground">每镜</dt>
          <dd>
            <Segmented aria-label="每镜张数" className="w-48 grid-cols-4">
              {COUNTS.map(value => <SegmentedItem key={value} value={String(value)} selected={count === value}
                onSelect={() => setCount(value)}>{value} 张</SegmentedItem>)}
            </Segmented>
          </dd>
        </>}
        <dt className="text-muted-foreground">预计</dt>
        <dd className="tabular-nums" data-testid="storyboard-plan-cost">{planCostText(plan)}</dd>
      </dl>
      {plan.skipped.length > 0 && <ul aria-label="不会生成的镜头" className="space-y-0.5 text-xs text-muted-foreground">
        {plan.skipped.map(item => <li key={item.shotId}>{item.label}：{item.reason}</li>)}
      </ul>}
      <AlertDialogFooter>
        <AlertDialogCancel>取消</AlertDialogCancel>
        <AlertDialogAction disabled={plan.items.length === 0} onClick={() => {
          void host.runShots?.(plan);
          onClose();
        }}>生成 {plan.items.length} 个</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
