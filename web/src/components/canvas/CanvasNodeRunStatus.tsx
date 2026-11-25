import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';

import { LoadingIcon } from '@/components/ui/icons';
import { MOTION_DURATION, MOTION_EASE } from '@/lib/motion';

import { cn } from '@/lib/utils';
import type { CanvasNode } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';
import { Hint } from '@/components/ui/tooltip';

export type CanvasNodeRunStatus = 'idle' | 'loading' | 'success' | 'error';

export interface CanvasNodeRunState {
  status: CanvasNodeRunStatus;
  label: string;
  detail: string | null;
  job: Job | undefined;
  reversePrompt: boolean;
}

export function canvasNodeRunDisplayError(
  detail: string | null | undefined,
  fallback = '生成失败，请检查模型配置后重试',
): string {
  const friendly = detail?.split(/（原始报错[：:]/, 1)[0].replace(/\s+/g, ' ').trim();
  if (!friendly) return fallback;
  return friendly.length > 140 ? `${friendly.slice(0, 139)}…` : friendly;
}

export function canvasNodeRunState(
  node: CanvasNode,
  jobsByRunId: ReadonlyMap<string, Job>,
  jobsByResultNodeId?: ReadonlyMap<string, Job[]>,
): CanvasNodeRunState {
  // active_run_id 只在生成进行中非空（服务端 finalize / 失败 / 停止都会清）；
  // 「生成完成 / 失败原因」的角标改从 jobsByResultNodeId 反查该节点最近一次 job。
  const runId = activeRunId(node);
  const mappedJob = runId ? jobsByRunId.get(runId) : undefined;
  const belongsToNode = (candidate: Job) => node.type === 'image_edit'
    ? candidate.canvas_run?.snapshot.surface_node_id === node.id
    : candidate.canvas_run?.result_node_id === node.id;
  const activeJob = mappedJob && belongsToNode(mappedJob) ? mappedJob : undefined;
  const history = (node.type === 'image_edit' ? [...jobsByRunId.values()] : jobsByResultNodeId?.get(node.id) ?? [])
    .filter(belongsToNode).sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''));
  const job = activeJob ?? history[history.length - 1];
  if (!job) {
    return { status: 'idle', label: '待编辑', detail: null, job: undefined, reversePrompt: false };
  }
  return canvasNodeRunStateForJob(job);
}

/** job → 状态与文案的**唯一**一张表。
 *
 *  生成面板的状态行原来自己抄了一份，两份已经漂开了：`partial` 一个说「部分完成」一个说
 *  「部分结果完成」；失败时面板那份丢掉了反推与出图的区分，连给的建议都不一样
 *  （「请检查模型配置后重试」对「请检查设置后重新生成」）。所以拆出这个只吃 job 的入口，
 *  节点角标和面板状态行都从这里派生，面板专属的措辞在 runStatus 里叠加。 */
export function canvasNodeRunStateForJob(job: Job): CanvasNodeRunState {
  const reversePrompt = isReversePromptJob(job);
  if (job.status === 'pending' || job.status === 'pending_confirm') {
    return {
      status: 'loading',
      label: job.cancel_requested_at ? '正在停止…' : reversePrompt ? '正在分析提示词' : job.progress_phase === 'waiting_gateway' ? '等待网关' : job.progress_phase?.startsWith('queued:') ? `排队第 ${job.progress_phase.slice(7)} 位` : '正在生成',
      detail: job.cancel_requested_at ? '已请求停止，上游可能仍在执行' : null,
      job,
      reversePrompt,
    };
  }
  if (job.status === 'done') {
    return {
      status: 'success',
      label: reversePrompt ? '分析完成' : '生成完成',
      detail: null,
      job,
      reversePrompt,
    };
  }
  if (job.status === 'partial') {
    return {
      status: 'success',
      label: '部分完成',
      detail: job.error ? canvasNodeRunDisplayError(job.error, '部分结果生成失败') : null,
      job,
      reversePrompt,
    };
  }
  if (job.status === 'failed') {
    return {
      status: 'error',
      label: reversePrompt ? '分析失败' : '生成失败',
      detail: canvasNodeRunDisplayError(
        job.error,
        reversePrompt ? '反推提示词失败，请检查设置后重新生成' : '生成失败，请检查设置后重新生成',
      ),
      job,
      reversePrompt,
    };
  }
  return {
    status: 'idle',
    label: '已停止',
    detail: job.error ? canvasNodeRunDisplayError(job.error, '已停止') : null,
    job,
    reversePrompt,
  };
}

export function CanvasNodeRunBadge({ state }: { state: CanvasNodeRunState }) {
  if (!state.job) return null;
  return (
    <span
      data-canvas-node-status-label={state.status}
      className={cn(
        'ml-2 flex shrink-0 items-center gap-1 text-xs font-medium',
        state.status === 'loading' && 'text-[color:var(--status-running)]',
        state.status === 'success' && 'text-[color:var(--status-done)]',
        state.status === 'error' && 'text-[color:var(--status-failed)]',
        state.status === 'idle' && 'text-[color:var(--status-pending)]',
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {state.label}
    </span>
  );
}

export function CanvasNodeRunLiveRegion({ state }: { state: CanvasNodeRunState }) {
  if (!state.job) return null;
  return (
    <>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {state.status !== 'error' ? state.detail || state.label : ''}
      </span>
      {state.status === 'error' && (
        <span role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
          {state.detail || state.label}
        </span>
      )}
    </>
  );
}

/** 生成中 / 失败的遮罩。holdUntilReady：结果已经回来、新图还在解码——遮罩按最后一次生成中的样子
 *  继续盖着，新图盖上来以后再淡出（150ms）；整张卡片式的遮罩等新图淡入播完再撤，中途不露出画布。 */
export function CanvasNodeRunOverlay({
  state,
  hasContent,
  holdUntilReady = false,
}: {
  state: CanvasNodeRunState;
  hasContent: boolean;
  holdUntilReady?: boolean;
}) {
  const active = state.status === 'loading' || state.status === 'error';
  const lastLoading = useRef<OverlayFrame | null>(null);
  const current: OverlayFrame = { state, compact: hasContent };
  const shown = active ? current : holdUntilReady ? lastLoading.current : null;
  useEffect(() => {
    if (state.status === 'loading') lastLoading.current = { state, compact: hasContent };
    else if (!holdUntilReady) lastLoading.current = null;
  });
  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          key="run-overlay"
          initial={false}
          // 没有 matchMedia 的环境（jsdom）不播退场，与 lib/motion 的约定一致。
          exit={typeof window.matchMedia === 'function' ? {
            opacity: 0,
            transition: {
              duration: MOTION_DURATION.fast,
              ease: MOTION_EASE.subtle,
              delay: shown.compact ? 0 : MOTION_DURATION.base,
            },
          } : undefined}
          className={cn(
            'nodrag nowheel pointer-events-none absolute z-20 flex min-w-0 overflow-hidden text-xs backdrop-blur-glass',
            shown.compact
              ? 'bottom-2 left-2 max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md border bg-card/95 px-2 py-1.5'
              : 'inset-0 flex-col items-center justify-center gap-3 rounded-lg bg-card/95 px-5 text-center',
            shown.state.status === 'loading'
              ? 'border-[color:var(--status-running)]/30 text-[color:var(--status-running)]'
              : 'border-[color:var(--status-failed)]/30 text-[color:var(--status-failed)]',
          )}
        >
          {shown.state.status === 'loading' && (
            <span
              data-canvas-generation-indicator="true"
              className={cn('canvas-generation-indicator shrink-0', shown.compact ? 'size-5' : 'size-12')}
              aria-hidden="true"
            >
              <LoadingIcon size="lg" />
            </span>
          )}
          <Hint label={shown.state.detail || shown.state.label}><span
            className={cn(
              'min-w-0 max-w-full',
              shown.compact ? 'truncate' : 'line-clamp-3 break-words leading-relaxed',
            )}
          >
            {shown.state.detail || shown.state.label}
          </span></Hint>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface OverlayFrame {
  state: CanvasNodeRunState;
  compact: boolean;
}

export function isReversePromptJob(job: Job): boolean {
  return job.canvas_run?.snapshot.normalized_params.preset_id === 'canvas.reverse_prompt'
    && job.canvas_run.snapshot.normalized_params.preset_version === 1;
}

function activeRunId(node: CanvasNode): string | null {
  if (
    node.type === 'text'
    || node.type === 'image'
    || node.type === 'video'
    || node.type === 'audio'
    || node.type === 'layer_stack'
    || node.type === 'image_edit'
  ) {
    return node.data.active_run_id;
  }
  return null;
}
